using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
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

        // A closed terminal leaves a transcript that looks exactly like an idle
        // one, so match against running claude processes: per working directory,
        // keep at most as many sessions (newest first) as there are processes.
        var openCounts = OpenTerminalCwds();
        if (openCounts is not null)
        {
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

            results = kept;
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

    private static string NormalizePath(string path) => path.TrimEnd('\\', '/');

    /// <summary>Working directories of running claude processes, with counts.
    /// Null when enumeration itself fails, so the caller can skip filtering
    /// rather than blank the page.</summary>
    private static Dictionary<string, int>? OpenTerminalCwds()
    {
        try
        {
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var process in Process.GetProcessesByName("claude"))
            {
                using (process)
                {
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
