using System.IO;
using System.Text.Json;

namespace TokenTracker;

/// <summary>Finds Claude/Codex-shaped usage JSONL outside the tracked roots so a
/// new project or harness starts counting without a settings.json edit. Anything
/// it flags is confirmed by content, not location: a file only becomes a source
/// after one of its lines matches the transcript shapes UsageParser bills from.</summary>
public static class SourceDiscovery
{
    private const int MaxDepth = 12;
    private const int SniffLineLimit = 80;
    private const int SniffBudgetBytes = 512 * 1024;

    /// <summary>Directory names that are all churn and never hold usage logs.</summary>
    private static readonly HashSet<string> PrunedDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", ".svn", ".hg", "bin", "obj", "dist", "build", "out",
        ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", "packages",
        "vendor", "target", ".gradle", ".idea", ".vs", ".vscode"
    };

    public static string DiscoveryBase { get; } =
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>Walks the user profile for candidate *.jsonl files. AppData is
    /// skipped except subtrees whose folder name mentions claude/codex (temp
    /// harness homes live there); junctions are never followed, and
    /// <paramref name="skipDirectory"/> prunes the already-tracked roots.</summary>
    public static IEnumerable<string> EnumerateCandidates(Func<string, bool> skipDirectory)
    {
        var appData = Path.GetFullPath(Path.Combine(DiscoveryBase, "AppData"));
        var appDataStructural = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            appData,
            Path.Combine(appData, "Local"),
            Path.Combine(appData, "LocalLow"),
            Path.Combine(appData, "Roaming"),
            Path.Combine(appData, "Local", "Temp"),
        };

        var stack = new Stack<(string Path, int Depth, bool HarnessBranch)>();
        stack.Push((DiscoveryBase, 0, false));

        while (stack.Count > 0)
        {
            var (current, depth, harnessBranch) = stack.Pop();
            FileSystemInfo[] entries;
            try
            {
                entries = new DirectoryInfo(current).GetFileSystemInfos();
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var entry in entries)
            {
                if (entry is FileInfo file)
                {
                    if (file.Name.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase) && file.Length > 0)
                    {
                        yield return file.FullName;
                    }

                    continue;
                }

                if (entry is not DirectoryInfo directory || depth >= MaxDepth)
                {
                    continue;
                }

                if ((directory.Attributes & FileAttributes.ReparsePoint) != 0 ||
                    PrunedDirectories.Contains(directory.Name) ||
                    IsExcludedLocation(directory.FullName) ||
                    skipDirectory(directory.FullName))
                {
                    continue;
                }

                var branch = harnessBranch || MentionsHarness(directory.Name);
                if (!branch && !appDataStructural.Contains(directory.FullName) &&
                    directory.FullName.StartsWith(appData + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                stack.Push((directory.FullName, depth + 1, branch));
            }
        }
    }

    /// <summary>Returns "claude" or "codex" when the file's first lines look like
    /// a usage transcript, else null. A brand-new transcript may not have its
    /// first billable line yet; callers re-sniff when the file grows.</summary>
    public static string? SniffClient(string path)
    {
        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                64 * 1024,
                FileOptions.SequentialScan);
            using var reader = new StreamReader(stream);

            var budget = SniffBudgetBytes;
            for (var index = 0; index < SniffLineLimit && budget > 0; index++)
            {
                var line = reader.ReadLine();
                if (line is null)
                {
                    break;
                }

                budget -= line.Length + 1;
                var client = ClassifyLine(line);
                if (client is not null)
                {
                    return client;
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        return null;
    }

    private static string? ClassifyLine(string line)
    {
        if (line.Length < 2)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("type", out var typeElement) ||
                typeElement.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var type = typeElement.GetString();
            if (type == "assistant" &&
                TryGetObject(root, "message", out var message) &&
                TryGetObject(message, "usage", out _))
            {
                // A stub's fixture line must not vouch for the file.
                var model = message.TryGetProperty("model", out var modelElement) &&
                            modelElement.ValueKind == JsonValueKind.String
                    ? modelElement.GetString()
                    : null;
                return IsJunkModel(model) ? null : "claude";
            }

            if (!TryGetObject(root, "payload", out var payload))
            {
                return null;
            }

            var isCodex = type switch
            {
                "session_meta" => payload.TryGetProperty("id", out _),
                "turn_context" => payload.TryGetProperty("model", out _),
                "event_msg" => payload.TryGetProperty("type", out var payloadType) &&
                               payloadType.ValueKind == JsonValueKind.String &&
                               payloadType.GetString() == "token_count",
                _ => false
            };
            return isCodex ? "codex" : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryGetObject(JsonElement parent, string name, out JsonElement value) =>
        parent.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object;

    /// <summary>Places whose *.jsonl is scaffolding shaped like a transcript, never
    /// billable work: a Claude Code session's scratchpad under Temp (agents write
    /// fixture transcripts there while testing), and the SimchatPlus API test's
    /// throwaway harness homes. Files there sniff as Claude transcripts and would
    /// be adopted as roots, then deleted seconds later — leaving fake rows behind.
    /// Other Temp homes (agent-log-*, ttproof) stay eligible: real harnesses do
    /// live there.</summary>
    public static bool IsExcludedLocation(string fullPath)
    {
        // The app keeps its own copies of transcripts (the vault) and its
        // request captures under the data folder; those look exactly like the
        // logs they were copied from, and adopting them would index every
        // session twice and vault the vault.
        if (fullPath.StartsWith(AppPaths.DataDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            fullPath.Equals(AppPaths.DataDirectory, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var segments = fullPath.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        var underTemp = false;
        foreach (var segment in segments)
        {
            if (segment.StartsWith("simchat-api-test-live-", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (underTemp && segment.Equals("scratchpad", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            underTemp |= segment.Equals("Temp", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    /// <summary>Model names only a stub emits. A line billed to one of these is test
    /// output, not usage, whatever folder it turned up in.</summary>
    public static bool IsJunkModel(string? model) =>
        model is not null &&
        (model.Equals("claude-unknown", StringComparison.OrdinalIgnoreCase) ||
         model.StartsWith("fake-", StringComparison.OrdinalIgnoreCase));

    private static bool MentionsHarness(string name) =>
        name.Contains("claude", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("codex", StringComparison.OrdinalIgnoreCase);
}
