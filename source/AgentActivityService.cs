using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TokenTracker;

public enum SubagentState
{
    /// <summary>The agent's transcript is being written right now (or was seconds ago).</summary>
    Running,

    /// <summary>No completion recorded, but the transcript has gone silent — likely a long tool.</summary>
    Quiet,

    /// <summary>The orchestrator was told the agent stopped, or the transcript has been dead for long enough.</summary>
    Done
}

/// <summary>One subagent as reconstructed from its transcript. ParentAgentId is
/// the agent whose transcript issued the launching tool call — empty when the
/// main session launched it directly.</summary>
public sealed record SubagentActivity(
    string AgentId,
    string AgentType,
    string Description,
    string Model,
    int Depth,
    string ParentAgentId,
    SubagentState State,
    string DoneLabel,
    DateTimeOffset StartedAt,
    DateTimeOffset LastActivity,
    DateTimeOffset? CompletedAt,
    TokenBreakdown Tokens,
    int ToolCalls,
    string LastTool,
    IReadOnlyList<long> RateSamples);

/// <summary>Head is the session's own transcript read as an agent — the
/// orchestrator itself, with its own state, tokens and burn samples.</summary>
public sealed record OrchestratorActivity(
    string SessionId,
    string ProjectPath,
    string ProjectName,
    bool IsDesktopApp,
    SubagentActivity Head,
    DateTimeOffset LastActivity,
    IReadOnlyList<SubagentActivity> Agents);

/// <summary>
/// Reconstructs live orchestrator → subagent trees from Claude transcripts.
/// Each session folder under ~/.claude/projects/&lt;project&gt;/&lt;sessionId&gt;/subagents
/// holds one agent-&lt;id&gt;.jsonl per subagent plus an agent-&lt;id&gt;.meta.json naming
/// its type, task and spawn depth. The launching transcript (the session's own
/// file for depth-1 agents, the parent agent's file for nested ones) carries the
/// tool_use that started it and — because agents run async — a queue-operation
/// task-notification when it stops; that notification, not the tool_result, is
/// the completion marker. Files are re-read incrementally from saved offsets, so
/// the steady-state cost of a scan is only the bytes appended since the last one.
/// </summary>
public sealed class AgentActivityService
{
    private static readonly TimeSpan QuietAfter = TimeSpan.FromSeconds(150);
    private static readonly TimeSpan EndedAfter = TimeSpan.FromMinutes(10);

    private static readonly Regex TaskIdPattern = new("<task-id>([^<]+)</task-id>", RegexOptions.Compiled);
    private static readonly Regex TaskStatusPattern = new("<status>([^<]+)</status>", RegexOptions.Compiled);

    public string ProjectsRoot { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "projects");

    private readonly Dictionary<string, SessionScan> _sessions = new(StringComparer.OrdinalIgnoreCase);

    public Task<IReadOnlyList<OrchestratorActivity>> ScanAsync(TimeSpan lookback, CancellationToken cancellationToken = default) =>
        Task.Run(() => ScanCoreAsync(lookback, cancellationToken), cancellationToken);

    private async Task<IReadOnlyList<OrchestratorActivity>> ScanCoreAsync(TimeSpan lookback, CancellationToken cancellationToken)
    {
        var results = new List<OrchestratorActivity>();
        if (!Directory.Exists(ProjectsRoot))
        {
            return results;
        }

        var cutoff = DateTime.UtcNow - lookback;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var projectDir in Directory.EnumerateDirectories(ProjectsRoot))
        {
            FileInfo[] mains;
            try
            {
                mains = new DirectoryInfo(projectDir).GetFiles("*.jsonl");
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var mainFile in mains)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var sessionDir = Path.Combine(projectDir, Path.GetFileNameWithoutExtension(mainFile.Name));
                var subagentsDir = Path.Combine(sessionDir, "subagents");
                try
                {
                    // AllDirectories reaches Workflow-run agents too, which sit
                    // one level deeper in subagents\workflows\wf_*\.
                    var hasRecentAgents = Directory.Exists(subagentsDir) &&
                        Directory.EnumerateFiles(subagentsDir, "agent-*.jsonl", SearchOption.AllDirectories)
                            .Any(file => File.GetLastWriteTimeUtc(file) >= cutoff);

                    // A session whose own transcript is still moving is a live
                    // orchestrator — even after every subagent settled, and
                    // before it has spawned any.
                    var mainAlive = mainFile.LastWriteTimeUtc >= DateTime.UtcNow - EndedAfter;
                    if (!hasRecentAgents && !mainAlive)
                    {
                        continue;
                    }

                    seen.Add(sessionDir);
                    var orchestrator = await ScanSessionAsync(projectDir, sessionDir, subagentsDir, cancellationToken);
                    if (orchestrator is not null)
                    {
                        results.Add(orchestrator);
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // A transcript mid-rotation or locked down; the next scan retries.
                }
            }
        }

        // Sessions that aged out of the window release their parse state.
        foreach (var stale in _sessions.Keys.Where(key => !seen.Contains(key)).ToList())
        {
            _sessions.Remove(stale);
        }

        return results
            .OrderByDescending(session => session.Agents.Any(agent => agent.State == SubagentState.Running))
            .ThenByDescending(session => session.Head.State == SubagentState.Running)
            .ThenByDescending(session => session.LastActivity)
            .ToList();
    }

    private async Task<OrchestratorActivity?> ScanSessionAsync(
        string projectDir,
        string sessionDir,
        string subagentsDir,
        CancellationToken cancellationToken)
    {
        if (!_sessions.TryGetValue(sessionDir, out var scan))
        {
            scan = new SessionScan();
            _sessions[sessionDir] = scan;
        }

        var sessionId = Path.GetFileName(sessionDir);
        var mainPath = Path.Combine(projectDir, sessionId + ".jsonl");
        if (File.Exists(mainPath))
        {
            var mainWrite = new DateTimeOffset(File.GetLastWriteTimeUtc(mainPath), TimeSpan.Zero);
            if (mainWrite > scan.Main.LastWrite)
            {
                scan.Main.LastWrite = mainWrite;
            }

            scan.MainOffset = await JsonlReader.ReadCompleteLinesAsync(
                mainPath,
                scan.MainOffset,
                line =>
                {
                    ParseTranscriptLine(line, "", scan);
                    return ValueTask.CompletedTask;
                },
                cancellationToken);
        }

        // Workflow runs write a journal instead of task-notifications: a
        // "result" row per agent is their completion record.
        var hasSubagents = Directory.Exists(subagentsDir);
        foreach (var journal in hasSubagents
                     ? Directory.EnumerateFiles(subagentsDir, "journal.jsonl", SearchOption.AllDirectories)
                     : Enumerable.Empty<string>())
        {
            scan.JournalOffsets.TryGetValue(journal, out var journalOffset);
            scan.JournalOffsets[journal] = await JsonlReader.ReadCompleteLinesAsync(
                journal,
                journalOffset,
                line =>
                {
                    ParseJournalLine(line, scan);
                    return ValueTask.CompletedTask;
                },
                cancellationToken);
        }

        foreach (var path in hasSubagents
                     ? Directory.EnumerateFiles(subagentsDir, "agent-*.jsonl", SearchOption.AllDirectories)
                     : Enumerable.Empty<string>())
        {
            var agentId = Path.GetFileNameWithoutExtension(path)["agent-".Length..];
            if (!scan.Agents.TryGetValue(agentId, out var agent))
            {
                agent = new AgentScan();
                scan.Agents[agentId] = agent;
            }

            agent.LastWrite = new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero);
            if (!agent.MetaLoaded)
            {
                LoadMeta(Path.ChangeExtension(path, ".meta.json"), agent);
            }

            agent.Offset = await JsonlReader.ReadCompleteLinesAsync(
                path,
                agent.Offset,
                line =>
                {
                    ParseTranscriptLine(line, agentId, scan);
                    return ValueTask.CompletedTask;
                },
                cancellationToken);
        }

        var agents = BuildTree(scan);
        var head = BuildHead(scan);
        var lastActivity = head.LastActivity;
        foreach (var agent in agents)
        {
            if (agent.LastActivity > lastActivity)
            {
                lastActivity = agent.LastActivity;
            }
        }

        var projectPath = scan.Cwd ?? "";
        var projectName = Path.GetFileName(projectPath.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(projectName))
        {
            projectName = Path.GetFileName(projectDir);
        }

        return new OrchestratorActivity(
            sessionId,
            projectPath,
            projectName,
            string.Equals(scan.Entrypoint, "claude-desktop", StringComparison.OrdinalIgnoreCase),
            head,
            lastActivity,
            agents);
    }

    // ----- Line parsing -----------------------------------------------------

    /// <summary>Digests one transcript line. Owner is the agent whose file the
    /// line came from, or "" for the session's own transcript.</summary>
    private static void ParseTranscriptLine(ReadOnlyMemory<byte> line, string owner, SessionScan scan)
    {
        if (line.IsEmpty)
        {
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            var type = GetString(root, "type");
            if (type == "queue-operation")
            {
                RecordNotification(root, scan);
                return;
            }

            if (owner.Length == 0)
            {
                scan.Cwd ??= GetString(root, "cwd");
                scan.Entrypoint ??= GetString(root, "entrypoint");
            }

            // The session's own transcript feeds the head scan — the
            // orchestrator's activity is tracked exactly like a subagent's.
            var agent = owner.Length == 0
                ? scan.Main
                : scan.Agents.TryGetValue(owner, out var found) ? found : null;
            switch (type)
            {
                case "assistant":
                    ParseAssistant(root, owner, agent, scan);
                    break;

                case "user":
                    if (agent is not null)
                    {
                        if (ParseTimestamp(root) is { } timestamp)
                        {
                            agent.StartedAt ??= timestamp;
                            if (timestamp > agent.LastTimestamp)
                            {
                                agent.LastTimestamp = timestamp;
                            }
                        }

                        // Workflow agents have no description anywhere else;
                        // the opening line of their prompt is the label.
                        if (agent.FallbackDescription.Length == 0 &&
                            TryGetObject(root, "message", out var userMessage) &&
                            userMessage.TryGetProperty("content", out var userContent) &&
                            userContent.ValueKind == JsonValueKind.String)
                        {
                            agent.FallbackDescription = FirstLine(userContent.GetString() ?? "");
                        }
                    }

                    ParseToolResults(root, scan);
                    break;
            }
        }
        catch (JsonException)
        {
            // One malformed row should not hide the rest of the session.
        }
    }

    private static void ParseAssistant(JsonElement root, string owner, AgentScan? agent, SessionScan scan)
    {
        if (!TryGetObject(root, "message", out var message))
        {
            return;
        }

        var timestamp = ParseTimestamp(root);
        if (agent is not null && timestamp is not null)
        {
            agent.StartedAt ??= timestamp;
            if (timestamp > agent.LastTimestamp)
            {
                agent.LastTimestamp = timestamp.Value;
            }
        }

        if (agent is not null && GetString(message, "model") is { } model)
        {
            agent.Model = model;
        }

        // The same message id reappears as a response streams; per-field max is
        // the same dedupe UsageParser applies, so counts match the dashboard.
        if (agent is not null && TryGetObject(message, "usage", out var usage))
        {
            var messageId = GetString(message, "id") ?? $"{owner}:{timestamp?.ToUnixTimeMilliseconds()}";
            var next = new TokenBreakdown(
                GetLong(usage, "input_tokens"),
                GetLong(usage, "output_tokens"),
                GetLong(usage, "cache_read_input_tokens"),
                GetLong(usage, "cache_creation_input_tokens"),
                0);
            if (agent.UsageByMessage.TryGetValue(messageId, out var previous))
            {
                next = new TokenBreakdown(
                    Math.Max(previous.Input, next.Input),
                    Math.Max(previous.Output, next.Output),
                    Math.Max(previous.CacheRead, next.CacheRead),
                    Math.Max(previous.CacheWrite, next.CacheWrite),
                    0);
            }

            agent.UsageByMessage[messageId] = next;
        }

        if (!message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var block in content.EnumerateArray())
        {
            if (GetString(block, "type") != "tool_use")
            {
                continue;
            }

            var name = GetString(block, "name") ?? "";
            if (agent is not null)
            {
                agent.ToolCalls++;
                agent.LastTool = name;
            }

            // The Agent/Task tool call is what ties a subagent to its launcher:
            // its id shows up as toolUseId in the spawned agent's meta.json.
            if ((name is "Agent" or "Task") && GetString(block, "id") is { } toolUseId)
            {
                var description = "";
                var agentType = "";
                if (TryGetObject(block, "input", out var input))
                {
                    description = GetString(input, "description") ?? "";
                    agentType = GetString(input, "subagent_type") ?? "";
                }

                scan.Launches[toolUseId] = new TaskLaunch(owner, description, agentType);
            }
        }
    }

    /// <summary>A tool_result for a launch means the subagent ran in the
    /// foreground and just returned — async launches answer instantly with an
    /// "Async agent launched" stub and complete via task-notification instead.</summary>
    private static void ParseToolResults(JsonElement root, SessionScan scan)
    {
        if (!TryGetObject(root, "message", out var message) ||
            !message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var block in content.EnumerateArray())
        {
            if (GetString(block, "type") != "tool_result" ||
                GetString(block, "tool_use_id") is not { } toolUseId ||
                !scan.Launches.ContainsKey(toolUseId))
            {
                continue;
            }

            var text = ToolResultText(block);
            if (!text.StartsWith("Async agent launched", StringComparison.Ordinal) &&
                ParseTimestamp(root) is { } timestamp)
            {
                scan.SyncCompletions[toolUseId] = timestamp;
            }
        }
    }

    private static string ToolResultText(JsonElement block)
    {
        if (!block.TryGetProperty("content", out var content))
        {
            return "";
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString() ?? "";
        }

        if (content.ValueKind == JsonValueKind.Array)
        {
            foreach (var piece in content.EnumerateArray())
            {
                if (GetString(piece, "type") == "text")
                {
                    return GetString(piece, "text") ?? "";
                }
            }
        }

        return "";
    }

    /// <summary>Task-notifications repeat (enqueue, remove, later stops after a
    /// resume); the latest one wins so a resumed agent flips back to running
    /// only while its transcript actually moves again.</summary>
    private static void RecordNotification(JsonElement root, SessionScan scan)
    {
        var content = GetString(root, "content") ?? "";
        var idMatch = TaskIdPattern.Match(content);
        if (!idMatch.Success)
        {
            return;
        }

        var status = TaskStatusPattern.Match(content) is { Success: true } statusMatch
            ? statusMatch.Groups[1].Value
            : "completed";
        var timestamp = ParseTimestamp(root) ?? DateTimeOffset.UtcNow;
        var agentId = idMatch.Groups[1].Value;
        if (!scan.Notifications.TryGetValue(agentId, out var existing) || timestamp > existing.At)
        {
            scan.Notifications[agentId] = new AgentStop(status, timestamp);
        }
    }

    /// <summary>A workflow journal row: {"type":"started"|"result","agentId":...}.
    /// The result row is the agent's completion record (journals carry no
    /// timestamps; the agent's own last activity stands in for the finish time).</summary>
    private static void ParseJournalLine(ReadOnlyMemory<byte> line, SessionScan scan)
    {
        if (line.IsEmpty)
        {
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (GetString(root, "type") == "result" && GetString(root, "agentId") is { } agentId)
            {
                scan.WorkflowResults.Add(agentId);
            }
        }
        catch (JsonException)
        {
        }
    }

    private static string FirstLine(string text)
    {
        var line = text.AsSpan().TrimStart();
        var newline = line.IndexOfAny('\r', '\n');
        if (newline >= 0)
        {
            line = line[..newline];
        }

        return line.Length > 90 ? $"{line[..89]}…" : line.ToString();
    }

    private static void LoadMeta(string metaPath, AgentScan agent)
    {
        try
        {
            if (!File.Exists(metaPath))
            {
                return;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(metaPath));
            var root = document.RootElement;
            agent.AgentType = GetString(root, "agentType") ?? agent.AgentType;
            agent.Description = GetString(root, "description") ?? agent.Description;
            agent.ToolUseId = GetString(root, "toolUseId") ?? agent.ToolUseId;
            agent.MetaModel = GetString(root, "model") ?? agent.MetaModel;
            if (root.TryGetProperty("spawnDepth", out var depth) && depth.TryGetInt32(out var value))
            {
                agent.SpawnDepth = value;
            }

            agent.MetaLoaded = true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Meta mid-write; retried next scan.
        }
    }

    // ----- Tree assembly ----------------------------------------------------

    private static List<SubagentActivity> BuildTree(SessionScan scan)
    {
        var now = DateTimeOffset.UtcNow;
        var byId = new Dictionary<string, SubagentActivity>(StringComparer.Ordinal);
        foreach (var (agentId, agent) in scan.Agents)
        {
            var launch = agent.ToolUseId is not null && scan.Launches.TryGetValue(agent.ToolUseId, out var found)
                ? found
                : null;
            var lastActivity = agent.LastTimestamp > agent.LastWrite ? agent.LastTimestamp : agent.LastWrite;

            DateTimeOffset? completedAt = null;
            var doneLabel = "finished";
            if (scan.Notifications.TryGetValue(agentId, out var stop))
            {
                completedAt = stop.At;
                doneLabel = stop.Status == "completed" ? "finished" : stop.Status;
            }
            else if (agent.ToolUseId is not null && scan.SyncCompletions.TryGetValue(agent.ToolUseId, out var syncAt))
            {
                completedAt = syncAt;
            }
            else if (scan.WorkflowResults.Contains(agentId))
            {
                completedAt = lastActivity;
            }

            // A resumed agent writes past its last stop notification.
            var resumed = completedAt is not null && lastActivity > completedAt.Value + TimeSpan.FromSeconds(10);
            var age = now - lastActivity;
            SubagentState state;
            if (completedAt is not null && !resumed)
            {
                state = SubagentState.Done;
            }
            else if (age <= QuietAfter)
            {
                state = SubagentState.Running;
            }
            else if (age <= EndedAfter)
            {
                state = SubagentState.Quiet;
            }
            else
            {
                // Dead long enough that no completion record will ever come
                // (killed terminal, crashed agent): call it ended.
                state = SubagentState.Done;
                doneLabel = completedAt is null ? "ended" : doneLabel;
                completedAt ??= lastActivity;
            }

            var tokens = SumUsage(agent);
            var rates = BurnRates(agent, tokens.Total, now);

            var agentType = FirstNonEmpty(agent.AgentType, launch?.AgentType, "agent");
            if (agentType == "workflow-subagent")
            {
                agentType = "workflow";
            }

            byId[agentId] = new SubagentActivity(
                agentId,
                agentType,
                FirstNonEmpty(agent.Description, launch?.Description, agent.FallbackDescription, "task"),
                FirstNonEmpty(agent.Model, agent.MetaModel),
                Math.Max(1, agent.SpawnDepth),
                launch?.Owner ?? "",
                state,
                doneLabel,
                agent.StartedAt ?? lastActivity,
                lastActivity,
                state == SubagentState.Done ? completedAt : null,
                tokens,
                agent.ToolCalls,
                agent.LastTool,
                rates);
        }

        // Children sit directly under their parent, running before finished,
        // then newest first — the same order at every level of the tree.
        var byParent = byId.Values
            .GroupBy(agent => byId.ContainsKey(agent.ParentAgentId) ? agent.ParentAgentId : "")
            .ToDictionary(
                group => group.Key,
                group => group
                    .OrderBy(agent => agent.State == SubagentState.Done)
                    .ThenByDescending(agent => agent.StartedAt)
                    .ToList(),
                StringComparer.Ordinal);

        var ordered = new List<SubagentActivity>(byId.Count);
        void Append(string parentId)
        {
            if (!byParent.TryGetValue(parentId, out var children))
            {
                return;
            }

            foreach (var child in children)
            {
                ordered.Add(child);
                Append(child.AgentId);
            }
        }

        Append("");
        return ordered;
    }

    /// <summary>The session's own transcript read as an agent: the orchestrator.
    /// It has no completion record — going silent long enough IS its idle.</summary>
    private static SubagentActivity BuildHead(SessionScan scan)
    {
        var now = DateTimeOffset.UtcNow;
        var main = scan.Main;
        var lastActivity = main.LastTimestamp > main.LastWrite ? main.LastTimestamp : main.LastWrite;
        var age = now - lastActivity;
        var state = age <= QuietAfter ? SubagentState.Running
            : age <= EndedAfter ? SubagentState.Quiet
            : SubagentState.Done;
        var tokens = SumUsage(main);
        var rates = BurnRates(main, tokens.Total, now);
        return new SubagentActivity(
            "",
            "orchestrator",
            main.FallbackDescription,
            main.Model,
            0,
            "",
            state,
            "idle",
            main.StartedAt ?? lastActivity,
            lastActivity,
            state == SubagentState.Done ? lastActivity : null,
            tokens,
            main.ToolCalls,
            main.LastTool,
            rates);
    }

    private static TokenBreakdown SumUsage(AgentScan agent) =>
        agent.UsageByMessage.Values.Aggregate(
            new TokenBreakdown(0, 0, 0, 0, 0),
            (sum, item) => new TokenBreakdown(
                sum.Input + item.Input,
                sum.Output + item.Output,
                sum.CacheRead + item.CacheRead,
                sum.CacheWrite + item.CacheWrite,
                0));

    /// <summary>One burn sample per scan feeds the tiles' sparkline: the deltas
    /// between consecutive totals say whether the agent is producing right now
    /// or coasting, which a lifetime total can't.</summary>
    private static long[] BurnRates(AgentScan agent, long total, DateTimeOffset now)
    {
        if (agent.Samples.Count == 0 || now - agent.Samples[^1].At >= TimeSpan.FromSeconds(2.5))
        {
            agent.Samples.Add((now, total));
            if (agent.Samples.Count > 48)
            {
                agent.Samples.RemoveAt(0);
            }
        }

        var rates = new long[Math.Max(0, agent.Samples.Count - 1)];
        for (var index = 1; index < agent.Samples.Count; index++)
        {
            rates[index - 1] = Math.Max(0, agent.Samples[index].Total - agent.Samples[index - 1].Total);
        }

        return rates;
    }

    // ----- Helpers ----------------------------------------------------------

    private static string FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static DateTimeOffset? ParseTimestamp(JsonElement root) =>
        GetString(root, "timestamp") is { } text && DateTimeOffset.TryParse(text, out var parsed)
            ? parsed
            : null;

    private static bool TryGetObject(JsonElement parent, string name, out JsonElement value)
    {
        if (parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out value) &&
            value.ValueKind == JsonValueKind.Object)
        {
            return true;
        }

        value = default;
        return false;
    }

    private static string? GetString(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value))
        {
            return null;
        }

        var result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return string.IsNullOrWhiteSpace(result) ? null : result;
    }

    private static long GetLong(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? Math.Max(0, number)
            : 0;

    private sealed record TaskLaunch(string Owner, string Description, string AgentType);

    private sealed record AgentStop(string Status, DateTimeOffset At);

    private sealed class SessionScan
    {
        public long MainOffset;
        public string? Cwd;
        public string? Entrypoint;

        /// <summary>The session's own transcript, scanned like any agent's.</summary>
        public readonly AgentScan Main = new();
        public readonly Dictionary<string, AgentScan> Agents = new(StringComparer.Ordinal);

        /// <summary>Agent/Task tool_use id → who issued it and what it asked for.</summary>
        public readonly Dictionary<string, TaskLaunch> Launches = new(StringComparer.Ordinal);

        /// <summary>Latest task-notification per agent id.</summary>
        public readonly Dictionary<string, AgentStop> Notifications = new(StringComparer.Ordinal);

        /// <summary>Foreground launches whose tool_result carried the final report.</summary>
        public readonly Dictionary<string, DateTimeOffset> SyncCompletions = new(StringComparer.Ordinal);

        /// <summary>Parse offset per workflow journal file.</summary>
        public readonly Dictionary<string, long> JournalOffsets = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Agent ids whose workflow journal recorded a result.</summary>
        public readonly HashSet<string> WorkflowResults = new(StringComparer.Ordinal);
    }

    private sealed class AgentScan
    {
        public long Offset;
        public bool MetaLoaded;
        public string AgentType = "";
        public string Description = "";
        public string FallbackDescription = "";
        public string MetaModel = "";
        public string? ToolUseId;
        public int SpawnDepth = 1;
        public string Model = "";
        public string LastTool = "";
        public int ToolCalls;
        public DateTimeOffset? StartedAt;
        public DateTimeOffset LastTimestamp = DateTimeOffset.MinValue;
        public DateTimeOffset LastWrite = DateTimeOffset.MinValue;
        public readonly Dictionary<string, TokenBreakdown> UsageByMessage = new(StringComparer.Ordinal);

        /// <summary>(time, lifetime total) pairs, one per scan, for burn rates.</summary>
        public readonly List<(DateTimeOffset At, long Total)> Samples = [];
    }
}
