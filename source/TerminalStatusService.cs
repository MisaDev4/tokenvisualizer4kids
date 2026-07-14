using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

public enum TerminalState
{
    /// <summary>Mid-turn: the model is generating, running tools, or has background agents out.</summary>
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
    DateTimeOffset LastActivity,
    TerminalApp App);

public enum TerminalApp
{
    ClaudeCode,
    Codex
}

/// <summary>
/// Reports which Claude Code terminals are busy and which are sitting at the
/// prompt. The primary source is Claude Code's own session registry
/// (~/.claude/sessions/&lt;pid&gt;.json), which each running terminal keeps
/// updated with its current session id and a live busy/idle status — this is
/// authoritative even when the transcript is silent, e.g. while background
/// agents run after the main turn ended. Registry entries are only trusted
/// when their pid is a live claude process started at the recorded time.
/// Older Claude Code versions without the registry fall back to classifying
/// transcript tails.
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

    public string SessionsRoot { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "sessions");

    public string CodexSessionsRoot { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".codex",
        "sessions");

    public Task<IReadOnlyList<TerminalStatus>> ScanAsync(TimeSpan lookback, CancellationToken cancellationToken = default) =>
        Task.Run(() => Scan(lookback), cancellationToken);

    private IReadOnlyList<TerminalStatus> Scan(TimeSpan lookback)
    {
        var results = ScanSessionRegistry();
        if (results.Count == 0)
        {
            results = ScanTranscripts(lookback);
        }

        results.AddRange(ScanCodexSessions(lookback));

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

    // ----- Session registry ------------------------------------------------

    private List<TerminalStatus> ScanSessionRegistry()
    {
        var results = new List<TerminalStatus>();
        if (!Directory.Exists(SessionsRoot))
        {
            return results;
        }

        foreach (var path in Directory.EnumerateFiles(SessionsRoot, "*.json"))
        {
            try
            {
                var status = ReadRegistryEntry(path);
                if (status is not null)
                {
                    results.Add(status);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                // A registry file mid-write or malformed; next scan is 3 s away.
            }
        }

        return results;
    }

    private TerminalStatus? ReadRegistryEntry(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        // Only interactive terminals; daemons and one-shot runs are not tiles.
        var kind = StringOf(root, "kind");
        if (kind is not null && kind != "interactive")
        {
            return null;
        }

        var sessionId = StringOf(root, "sessionId");
        var cwd = StringOf(root, "cwd");
        if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(cwd) ||
            !root.TryGetProperty("pid", out var pidValue) || !pidValue.TryGetInt32(out var pid))
        {
            return null;
        }

        // Exited terminals can leave their registry file behind, and pids get
        // reused; only a live claude process born when the entry says counts.
        var startedAt = root.TryGetProperty("startedAt", out var startedValue) && startedValue.TryGetInt64(out var started)
            ? DateTimeOffset.FromUnixTimeMilliseconds(started)
            : (DateTimeOffset?)null;
        if (!IsLiveClaudeProcess(pid, startedAt))
        {
            return null;
        }

        var statusUpdatedAt = root.TryGetProperty("statusUpdatedAt", out var updatedValue) && updatedValue.TryGetInt64(out var updated)
            ? DateTimeOffset.FromUnixTimeMilliseconds(updated)
            : DateTimeOffset.MinValue;
        var liveStatus = StringOf(root, "status");

        var projectDir = Path.Combine(ProjectsRoot, FlattenProjectPath(cwd));
        var lastActivity = LatestActivity(projectDir, sessionId, statusUpdatedAt);

        TerminalState state;
        if (liveStatus == "idle")
        {
            state = TerminalState.Ready;
            // For an idle terminal "since" means "sitting at the prompt since".
            lastActivity = statusUpdatedAt > DateTimeOffset.MinValue ? statusUpdatedAt : lastActivity;
        }
        else if (liveStatus == "waiting")
        {
            // Claude Code says the turn is blocked on the user: a permission
            // prompt, a plan approval, background work it is paused on.
            state = TerminalState.Waiting;
        }
        else
        {
            // busy (or an unknown future status): subagent transcripts count
            // as activity, so a terminal whose main turn is silent while
            // agents run stays working, while one that has gone completely
            // quiet mid-turn drifts to waiting.
            state = DateTimeOffset.UtcNow - lastActivity > WaitingAfter
                ? TerminalState.Waiting
                : TerminalState.Working;
        }

        var name = StringOf(root, "name");
        if (string.IsNullOrEmpty(name))
        {
            name = Path.GetFileName(cwd.TrimEnd('\\', '/'));
        }

        return new TerminalStatus(
            sessionId,
            string.IsNullOrEmpty(name) ? "unknown" : name,
            cwd,
            state,
            lastActivity,
            TerminalApp.ClaudeCode);
    }

    private static bool IsLiveClaudeProcess(int pid, DateTimeOffset? startedAt)
    {
        try
        {
            using var process = Process.GetProcessById(pid);

            // A self-update renames the image of running terminals to
            // claude.exe.old.<timestamp>, so match on the prefix.
            if (!process.ProcessName.StartsWith("claude", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            // The registry records when the session started, which is after
            // its process launched (startup lag, /clear, /resume). A pid that
            // was reused later belongs to a process born after that moment.
            return startedAt is null ||
                new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero)
                    <= startedAt.Value + TimeSpan.FromSeconds(60);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    /// <summary>The newest write among the session transcript and its
    /// subagent transcripts, so live background agents count as activity.</summary>
    private static DateTimeOffset LatestActivity(string projectDir, string sessionId, DateTimeOffset floor)
    {
        var latest = floor;
        try
        {
            var transcript = new FileInfo(Path.Combine(projectDir, sessionId + ".jsonl"));
            if (transcript.Exists && transcript.LastWriteTimeUtc > latest.UtcDateTime)
            {
                latest = new DateTimeOffset(transcript.LastWriteTimeUtc, TimeSpan.Zero);
            }

            var subagents = Path.Combine(projectDir, sessionId, "subagents");
            if (Directory.Exists(subagents))
            {
                foreach (var file in Directory.EnumerateFiles(subagents, "*.jsonl"))
                {
                    var writeTime = File.GetLastWriteTimeUtc(file);
                    if (writeTime > latest.UtcDateTime)
                    {
                        latest = new DateTimeOffset(writeTime, TimeSpan.Zero);
                    }
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }

        return latest;
    }

    /// <summary>Claude Code stores each project's transcripts in a folder named
    /// after the working directory with every non-alphanumeric character
    /// dashed: C:\Users\kir → C--Users-kir.</summary>
    private static string FlattenProjectPath(string cwd)
    {
        var trimmed = cwd.TrimEnd('\\', '/');
        var builder = new StringBuilder(trimmed.Length);
        foreach (var character in trimmed)
        {
            builder.Append(char.IsLetterOrDigit(character) ? character : '-');
        }

        return builder.ToString();
    }

    // ----- Transcript fallback (Claude Code without the session registry) --

    private List<TerminalStatus> ScanTranscripts(TimeSpan lookback)
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

        // A closed terminal leaves a transcript that looks exactly like an
        // idle one, so match against running claude processes (a self-update
        // renames running ones to claude.exe.old.<timestamp>).
        return ApplyProcessCap(results, OpenTerminalCwds(name =>
            name.Equals("claude", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("claude.exe.old", StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>Per working directory, keep at most as many sessions (newest
    /// first) as there are open terminal processes there. A null count map
    /// means enumeration failed; skip filtering rather than blank the page.</summary>
    private static List<TerminalStatus> ApplyProcessCap(List<TerminalStatus> results, Dictionary<string, int>? openCounts)
    {
        if (openCounts is null)
        {
            return results;
        }

        var kept = new List<TerminalStatus>();
        var used = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var status in results.OrderByDescending(item => item.LastActivity))
        {
            var key = NormalizePath(status.ProjectPath);
            if (used.GetValueOrDefault(key) < openCounts.GetValueOrDefault(key))
            {
                used[key] = used.GetValueOrDefault(key) + 1;
                kept.Add(status);
            }
        }

        return kept;
    }

    private static string NormalizePath(string path) => path.TrimEnd('\\', '/');

    /// <summary>Working directories of running terminal processes, with counts.
    /// Null when enumeration itself fails.</summary>
    private static Dictionary<string, int>? OpenTerminalCwds(Func<string, bool> processNameMatches)
    {
        try
        {
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    if (!processNameMatches(process.ProcessName))
                    {
                        continue;
                    }

                    var cwd = TryGetProcessCwd(process);
                    if (!string.IsNullOrEmpty(cwd))
                    {
                        var key = NormalizePath(cwd);
                        counts[key] = counts.GetValueOrDefault(key) + 1;
                    }
                }
            }

            return counts;
        }
        catch
        {
            return null;
        }
    }

    // ----- Codex ------------------------------------------------------------

    /// <summary>Codex has no session registry, so its rollouts get the same
    /// treatment as the Claude fallback: classify the tail of every recent
    /// session, then cap per working directory by running codex processes
    /// (the TUI is a single codex.exe per terminal; helper processes have
    /// longer names and are excluded by the exact match).</summary>
    private List<TerminalStatus> ScanCodexSessions(TimeSpan lookback)
    {
        var results = new List<TerminalStatus>();
        if (!Directory.Exists(CodexSessionsRoot))
        {
            return results;
        }

        // Rollouts are partitioned into sessions\yyyy\MM\dd folders.
        var cutoff = DateTime.UtcNow - lookback;
        for (var day = DateTime.Now.Date; day >= cutoff.ToLocalTime().Date; day = day.AddDays(-1))
        {
            var folder = Path.Combine(CodexSessionsRoot, $"{day:yyyy}", $"{day:MM}", $"{day:dd}");
            if (!Directory.Exists(folder))
            {
                continue;
            }

            foreach (var path in Directory.EnumerateFiles(folder, "*.jsonl"))
            {
                try
                {
                    var info = new FileInfo(path);
                    if (info.LastWriteTimeUtc < cutoff)
                    {
                        continue;
                    }

                    var status = ClassifyCodex(info);
                    if (status is not null)
                    {
                        results.Add(status);
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                }
            }
        }

        return ApplyProcessCap(results, OpenTerminalCwds(name =>
            name.Equals("codex", StringComparison.OrdinalIgnoreCase)));
    }

    private static TerminalStatus? ClassifyCodex(FileInfo file)
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
                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("payload", out var payload))
                {
                    continue;
                }

                if (projectPath is null && payload.ValueKind == JsonValueKind.Object &&
                    payload.TryGetProperty("cwd", out var cwd) && cwd.ValueKind == JsonValueKind.String)
                {
                    projectPath = cwd.GetString();
                }

                if (state is not null)
                {
                    if (projectPath is not null)
                    {
                        break;
                    }

                    continue;
                }

                switch (StringOf(root, "type"))
                {
                    case "event_msg":
                        switch (StringOf(payload, "type"))
                        {
                            case "task_complete":
                            case "turn_aborted":
                                state = TerminalState.Ready;
                                break;

                            case "task_started":
                            case "user_message":
                                state = TerminalState.Working;
                                break;
                        }

                        break;

                    case "response_item":
                        // Model output or a tool call: the turn is in flight.
                        state = TerminalState.Working;
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

        // The session_meta first line holds the cwd when no turn_context fell
        // inside the tail window.
        projectPath ??= CodexHeadCwd(file.FullName);

        var lastActivity = new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero);
        if (state == TerminalState.Working && DateTimeOffset.UtcNow - lastActivity > WaitingAfter)
        {
            state = TerminalState.Waiting;
        }

        // rollout-yyyy-MM-ddTHH-mm-ss-<session uuid>.jsonl
        var baseName = Path.GetFileNameWithoutExtension(file.Name);
        var sessionId = baseName.Length > 28 ? baseName[28..] : baseName;

        var name = string.IsNullOrEmpty(projectPath) ? "unknown" : Path.GetFileName(projectPath.TrimEnd('\\', '/'));
        return new TerminalStatus(
            sessionId,
            string.IsNullOrEmpty(name) ? "unknown" : name,
            projectPath ?? "",
            state.Value,
            lastActivity,
            TerminalApp.Codex);
    }

    /// <summary>Extracts payload.cwd from the session_meta line without
    /// parsing it: that line embeds the entire base prompt and can run past
    /// any sensible read budget, but the cwd sits near its start.</summary>
    private static string? CodexHeadCwd(string path)
    {
        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            var buffer = new byte[16 * 1024];
            var read = stream.Read(buffer, 0, buffer.Length);
            var text = Encoding.UTF8.GetString(buffer, 0, read);

            var match = System.Text.RegularExpressions.Regex.Match(text, "\"cwd\":\"((?:[^\"\\\\]|\\\\.)*)\"");
            return match.Success
                ? match.Groups[1].Value.Replace("\\\\", "\\").Replace("\\/", "/")
                : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int informationClass,
        ref ProcessBasicInformation information,
        int informationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr processHandle,
        IntPtr baseAddress,
        byte[] buffer,
        IntPtr size,
        out IntPtr bytesRead);

    /// <summary>Reads another process's current directory from its PEB
    /// (x64 layout: PEB+0x20 → RTL_USER_PROCESS_PARAMETERS, +0x38 → CurrentDirectory.DosPath).</summary>
    private static string? TryGetProcessCwd(Process process)
    {
        try
        {
            var information = new ProcessBasicInformation();
            if (NtQueryInformationProcess(
                    process.Handle, 0, ref information, Marshal.SizeOf<ProcessBasicInformation>(), out _) != 0 ||
                information.PebBaseAddress == IntPtr.Zero)
            {
                return null;
            }

            var parameters = ReadPointer(process.Handle, information.PebBaseAddress + 0x20);
            if (parameters == IntPtr.Zero)
            {
                return null;
            }

            var unicodeString = new byte[16];
            if (!ReadProcessMemory(process.Handle, parameters + 0x38, unicodeString, (IntPtr)16, out _))
            {
                return null;
            }

            var length = BitConverter.ToUInt16(unicodeString, 0);
            var buffer = (IntPtr)BitConverter.ToInt64(unicodeString, 8);
            if (length == 0 || length > 8192 || buffer == IntPtr.Zero)
            {
                return null;
            }

            var pathBytes = new byte[length];
            return ReadProcessMemory(process.Handle, buffer, pathBytes, (IntPtr)length, out _)
                ? Encoding.Unicode.GetString(pathBytes)
                : null;
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // The process exited mid-read or denies access.
            return null;
        }
    }

    private static IntPtr ReadPointer(IntPtr processHandle, IntPtr address)
    {
        var buffer = new byte[8];
        return ReadProcessMemory(processHandle, address, buffer, (IntPtr)8, out _)
            ? (IntPtr)BitConverter.ToInt64(buffer, 0)
            : IntPtr.Zero;
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
                        var text = UserEntryText(root);

                        // Slash-command records (/context, /effort …) are logged
                        // as user entries but are not prompts; skip them.
                        if (text.StartsWith("<command-name>", StringComparison.Ordinal) ||
                            text.StartsWith("<local-command", StringComparison.Ordinal))
                        {
                            continue;
                        }

                        // An interrupted turn leaves the terminal at the prompt.
                        state = text.StartsWith("[Request interrupted", StringComparison.Ordinal)
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
            lastActivity,
            TerminalApp.ClaudeCode);
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
