using System.IO;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

/// <summary>What a session is about, in the user's own words. First is the
/// prompt that opened the conversation (a stable name), Latest the most recent
/// one (what it is doing right now).</summary>
public sealed record SessionTitle(string First, string Latest);

/// <summary>
/// Maps session ids to human-meaningful titles. Claude Code derives terminal
/// names from the folder plus hex noise ("production-8b"), which says nothing
/// about which chat is which — but ~/.claude/history.jsonl logs every typed
/// prompt with its session id, and a transcript's first user message works for
/// sessions that never touch history (initial-prompt launches, Codex). Refresh
/// runs on the terminal-scan background thread; readers get an immutable
/// snapshot, so TitleFor is safe and cheap on the UI thread.
/// </summary>
public sealed class SessionTitleService
{
    /// <summary>History entries older than this on first load are skipped:
    /// they belong to long-dead sessions that no surface will ever name.</summary>
    private static readonly TimeSpan HistoryLookback = TimeSpan.FromDays(14);

    /// <summary>Head-scan budget per transcript; the first real user message
    /// sits near the top (Codex first, after its long session_meta line).</summary>
    private const int HeadBytes = 2 * 1024 * 1024;

    public string HistoryPath { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "history.jsonl");

    private readonly Dictionary<string, SessionTitle> _titles = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _seenInHistory = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, long> _headScanLength = new(StringComparer.OrdinalIgnoreCase);
    private long _historyPosition;
    private volatile IReadOnlyDictionary<string, SessionTitle>? _snapshot;

    public SessionTitle? TitleFor(string sessionId) =>
        _snapshot is { } snapshot && snapshot.TryGetValue(sessionId, out var title) ? title : null;

    /// <summary>Ingests new history lines, then head-scans transcripts of any
    /// terminal whose session history has not named yet. Call off the UI thread.</summary>
    public void Refresh(IReadOnlyList<TerminalStatus> terminals)
    {
        ReadHistoryTail();

        foreach (var terminal in terminals)
        {
            if (_seenInHistory.Contains(terminal.SessionId) ||
                string.IsNullOrEmpty(terminal.TranscriptPath))
            {
                continue;
            }

            try
            {
                // The first prompt is immutable once present, so a transcript
                // only deserves another look when it has grown.
                var length = new FileInfo(terminal.TranscriptPath).Length;
                if (_headScanLength.TryGetValue(terminal.SessionId, out var scanned) && scanned == length)
                {
                    continue;
                }

                _headScanLength[terminal.SessionId] = length;
                var first = terminal.App == TerminalApp.Codex
                    ? ScanCodexHead(terminal.TranscriptPath)
                    : ScanClaudeHead(terminal.TranscriptPath);
                if (first is not null && !_titles.ContainsKey(terminal.SessionId))
                {
                    _titles[terminal.SessionId] = new SessionTitle(first, first);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Transcript mid-write or gone; the next scan is seconds away.
            }
        }

        _snapshot = new Dictionary<string, SessionTitle>(_titles, StringComparer.OrdinalIgnoreCase);
    }

    // ----- history.jsonl ----------------------------------------------------

    /// <summary>Reads only what was appended since the last call. The file is
    /// append-only; a shrink means it was rewritten, so start over.</summary>
    private void ReadHistoryTail()
    {
        try
        {
            using var stream = new FileStream(
                HistoryPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length < _historyPosition)
            {
                _historyPosition = 0;
            }

            if (stream.Length == _historyPosition)
            {
                return;
            }

            stream.Seek(_historyPosition, SeekOrigin.Begin);
            var buffer = new byte[stream.Length - _historyPosition];
            var read = 0;
            while (read < buffer.Length)
            {
                var chunk = stream.Read(buffer, read, buffer.Length - read);
                if (chunk <= 0)
                {
                    break;
                }

                read += chunk;
            }

            // Only complete lines advance the cursor; a line mid-write waits
            // for the next refresh. A missing final newline still parses when
            // the trailing fragment happens to be complete JSON.
            var consumed = 0;
            var start = 0;
            var cutoff = _historyPosition == 0
                ? DateTimeOffset.UtcNow.Subtract(HistoryLookback).ToUnixTimeMilliseconds()
                : 0;
            for (var index = 0; index < read; index++)
            {
                if (buffer[index] != (byte)'\n')
                {
                    continue;
                }

                IngestHistoryLine(Encoding.UTF8.GetString(buffer, start, index - start), cutoff);
                start = index + 1;
                consumed = start;
            }

            if (start < read && IngestHistoryLine(Encoding.UTF8.GetString(buffer, start, read - start), cutoff))
            {
                consumed = read;
            }

            _historyPosition += consumed;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    private bool IngestHistoryLine(string line, long cutoffMs)
    {
        line = line.Trim();
        if (line.Length == 0)
        {
            return true;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return true;
            }

            var sessionId = StringOf(root, "sessionId");
            var prompt = CleanPrompt(StringOf(root, "display"));
            if (string.IsNullOrEmpty(sessionId) || prompt is null)
            {
                return true;
            }

            if (cutoffMs > 0 &&
                root.TryGetProperty("timestamp", out var timestamp) &&
                timestamp.TryGetInt64(out var timestampMs) && timestampMs < cutoffMs)
            {
                return true;
            }

            // History is the better source: its first entry replaces any
            // head-scan guess, and later entries keep Latest current.
            if (_seenInHistory.Add(sessionId))
            {
                _titles[sessionId] = new SessionTitle(prompt, prompt);
            }
            else if (_titles.TryGetValue(sessionId, out var title))
            {
                _titles[sessionId] = title with { Latest = prompt };
            }

            return true;
        }
        catch (JsonException)
        {
            // A fragment mid-write; do not consume it.
            return false;
        }
    }

    // ----- transcript head scans -------------------------------------------

    /// <summary>First real user message of a Claude Code transcript.</summary>
    private static string? ScanClaudeHead(string path)
    {
        foreach (var line in HeadLines(path))
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    StringOf(root, "type") != "user" ||
                    IsTrue(root, "isMeta") ||
                    IsTrue(root, "isSidechain") ||
                    !root.TryGetProperty("message", out var message) ||
                    !message.TryGetProperty("content", out var content))
                {
                    continue;
                }

                if (content.ValueKind == JsonValueKind.String)
                {
                    var prompt = CleanPrompt(content.GetString());
                    if (prompt is not null)
                    {
                        return prompt;
                    }
                }
                else if (content.ValueKind == JsonValueKind.Array)
                {
                    // System reminders ride along as extra text blocks; the
                    // prompt is the first block that is not markup.
                    foreach (var block in content.EnumerateArray())
                    {
                        if (StringOf(block, "type") != "text")
                        {
                            continue;
                        }

                        var prompt = CleanPrompt(StringOf(block, "text"));
                        if (prompt is not null)
                        {
                            return prompt;
                        }
                    }
                }
            }
            catch (JsonException)
            {
            }
        }

        return null;
    }

    /// <summary>First user_message event of a Codex rollout.</summary>
    private static string? ScanCodexHead(string path)
    {
        foreach (var line in HeadLines(path))
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    StringOf(root, "type") != "event_msg" ||
                    !root.TryGetProperty("payload", out var payload) ||
                    StringOf(payload, "type") != "user_message")
                {
                    continue;
                }

                var prompt = CleanPrompt(StringOf(payload, "message"));
                if (prompt is not null)
                {
                    return prompt;
                }
            }
            catch (JsonException)
            {
            }
        }

        return null;
    }

    private static IEnumerable<string> HeadLines(string path)
    {
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        var take = (int)Math.Min(HeadBytes, stream.Length);
        var buffer = new byte[take];
        var read = 0;
        while (read < take)
        {
            var chunk = stream.Read(buffer, read, take - read);
            if (chunk <= 0)
            {
                break;
            }

            read += chunk;
        }

        var lines = Encoding.UTF8.GetString(buffer, 0, read).Split('\n');
        // The last line is likely cut mid-record when the file exceeds the
        // budget; JSON parsing rejects it naturally.
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.Length > 0)
            {
                yield return trimmed;
            }
        }
    }

    // ----- prompt cleanup ---------------------------------------------------

    /// <summary>A prompt worth using as a name: not a slash command, shell
    /// escape, interruption record, or injected markup — whitespace collapsed
    /// so it reads as one line.</summary>
    private static string? CleanPrompt(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.TrimStart();
        if (trimmed.StartsWith('/') || trimmed.StartsWith('<') || trimmed.StartsWith('!') ||
            trimmed.StartsWith('#') ||
            trimmed.StartsWith("[Request interrupted", StringComparison.Ordinal) ||
            trimmed.StartsWith("Caveat:", StringComparison.Ordinal))
        {
            return null;
        }

        var builder = new StringBuilder(Math.Min(trimmed.Length, 256));
        var lastWasSpace = false;
        foreach (var character in trimmed)
        {
            if (char.IsWhiteSpace(character))
            {
                if (!lastWasSpace)
                {
                    builder.Append(' ');
                    lastWasSpace = true;
                }
            }
            else
            {
                builder.Append(character);
                lastWasSpace = false;
            }

            if (builder.Length >= 256)
            {
                break;
            }
        }

        var cleaned = builder.ToString().Trim();
        return cleaned.Length == 0 ? null : cleaned;
    }

    private static bool IsTrue(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static string? StringOf(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
