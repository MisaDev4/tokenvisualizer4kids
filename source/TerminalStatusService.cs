using System.IO;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

public enum TerminalState
{
    /// <summary>Mid-turn: the model is generating or running tools.</summary>
    Working,

    /// <summary>Mid-turn but quiet for a while: likely a permission prompt or a long tool.</summary>
    Waiting,

    /// <summary>Turn finished: the terminal is sitting at the prompt.</summary>
    Ready
}

public sealed record TerminalStatus(
    string SessionId,
    string ProjectName,
    string ProjectPath,
    TerminalState State,
    DateTimeOffset LastActivity);

/// <summary>
/// Watches the tails of Claude Code session transcripts to tell which
/// terminals are busy and which have finished their turn and are waiting for
/// a prompt. A finished turn is unmistakable in the transcript: an assistant
/// entry with stop_reason end_turn followed by a system/turn_duration record.
/// Anything else conversational means the turn is still in flight — and if a
/// turn has been silent for a while, that usually means a permission prompt
/// or a long-running tool wants attention.
/// </summary>
public sealed class TerminalStatusService
{
    /// <summary>Mid-turn silence longer than this is flagged as waiting.</summary>
    private static readonly TimeSpan WaitingAfter = TimeSpan.FromSeconds(150);

    /// <summary>Only the transcript tail is read; turns end well within this.</summary>
    private const int TailBytes = 96 * 1024;

    public string ProjectsRoot { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "projects");

    public Task<IReadOnlyList<TerminalStatus>> ScanAsync(TimeSpan lookback, CancellationToken cancellationToken = default) =>
        Task.Run(() => Scan(lookback), cancellationToken);

    private IReadOnlyList<TerminalStatus> Scan(TimeSpan lookback)
    {
        var results = new List<TerminalStatus>();
        if (!Directory.Exists(ProjectsRoot))
        {
            return results;
        }

        var cutoff = DateTime.UtcNow - lookback;
        foreach (var path in Directory.EnumerateFiles(ProjectsRoot, "*.jsonl", SearchOption.AllDirectories))
        {
            try
            {
                var info = new FileInfo(path);
                if (info.LastWriteTimeUtc < cutoff)
                {
                    continue;
                }

                var status = Classify(info);
                if (status is not null)
                {
                    results.Add(status);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // A session file mid-write or gone; it gets another look next scan.
            }
        }

        return results
            .OrderBy(status => status.State switch
            {
                TerminalState.Ready => 0,
                TerminalState.Waiting => 1,
                _ => 2
            })
            .ThenByDescending(status => status.LastActivity)
            .ToList();
    }

    private static TerminalStatus? Classify(FileInfo file)
    {
        string? projectPath = null;
        var state = null as TerminalState?;

        foreach (var line in TailLinesNewestFirst(file.FullName))
        {
            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(line);
            }
            catch (JsonException)
            {
                continue;
            }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                if (projectPath is null &&
                    root.TryGetProperty("cwd", out var cwd) && cwd.ValueKind == JsonValueKind.String)
                {
                    projectPath = cwd.GetString();
                }

                if (state is not null)
                {
                    // Only still reading to pick up a cwd.
                    if (projectPath is not null)
                    {
                        break;
                    }

                    continue;
                }

                // Subagent transcripts live in the same folder; they are not terminals.
                if (root.TryGetProperty("isSidechain", out var sidechain) &&
                    sidechain.ValueKind == JsonValueKind.True)
                {
                    return null;
                }

                // Meta records (attachments, titles, drafts, hooks) say nothing about the turn.
                if (root.TryGetProperty("isMeta", out var meta) && meta.ValueKind == JsonValueKind.True)
                {
                    continue;
                }

                var type = root.TryGetProperty("type", out var typeValue) && typeValue.ValueKind == JsonValueKind.String
                    ? typeValue.GetString()
                    : null;
                switch (type)
                {
                    case "system":
                        if (StringOf(root, "subtype") == "turn_duration")
                        {
                            state = TerminalState.Ready;
                        }

                        break;

                    case "assistant":
                        state = root.TryGetProperty("message", out var message) &&
                                StringOf(message, "stop_reason") == "end_turn"
                            ? TerminalState.Ready
                            : TerminalState.Working;
                        break;

                    case "user":
                        // An interrupted turn leaves the terminal at the prompt.
                        state = UserEntryText(root).StartsWith("[Request interrupted", StringComparison.Ordinal)
                            ? TerminalState.Ready
                            : TerminalState.Working;
                        break;
                }

                if (state is not null && projectPath is not null)
                {
                    break;
                }
            }
        }

        if (state is null)
        {
            return null;
        }

        var lastActivity = new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero);
        if (state == TerminalState.Working && DateTimeOffset.UtcNow - lastActivity > WaitingAfter)
        {
            state = TerminalState.Waiting;
        }

        var name = string.IsNullOrEmpty(projectPath) ? "unknown" : Path.GetFileName(projectPath.TrimEnd('\\', '/'));
        return new TerminalStatus(
            Path.GetFileNameWithoutExtension(file.Name),
            string.IsNullOrEmpty(name) ? "unknown" : name,
            projectPath ?? "",
            state.Value,
            lastActivity);
    }

    private static string UserEntryText(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var message) ||
            !message.TryGetProperty("content", out var content))
        {
            return "";
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString() ?? "";
        }

        if (content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (StringOf(block, "type") == "text")
                {
                    return StringOf(block, "text") ?? "";
                }
            }
        }

        return "";
    }

    private static string? StringOf(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static IEnumerable<string> TailLinesNewestFirst(string path)
    {
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        var take = (int)Math.Min(TailBytes, stream.Length);
        stream.Seek(-take, SeekOrigin.End);
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

        var text = Encoding.UTF8.GetString(buffer, 0, read);
        var lines = text.Split('\n');
        // The first line is likely a fragment when the file exceeds the tail
        // window; JSON parsing rejects it naturally.
        for (var index = lines.Length - 1; index >= 0; index--)
        {
            var line = lines[index].Trim();
            if (line.Length > 0)
            {
                yield return line;
            }
        }
    }
}
