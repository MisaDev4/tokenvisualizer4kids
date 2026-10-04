using System.Text;
using System.Text.Json;

namespace TokenTracker;

/// <summary>What a transcript row was — decides its color and label.</summary>
public enum TranscriptRole
{
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
    System
}

/// <summary>
/// One readable row of a transcript. <paramref name="Group"/> is the source
/// line ordinal: every block of one assistant response shares it, so the viewer
/// can highlight a whole response rather than a single paragraph.
/// </summary>
public sealed record TranscriptEntry(
    TranscriptRole Role,
    string Title,
    string? Detail,
    string Body,
    long TimestampMs,
    int Group,
    bool IsError = false);

public sealed record TranscriptDocument(
    string Path,
    string Client,
    IReadOnlyList<TranscriptEntry> Entries,
    int AnchorIndex,
    int DroppedEntries,
    string? Error);

/// <summary>
/// Turns a Claude Code or Codex transcript back into the conversation it
/// recorded: prompts, replies, thinking, tool calls and their results. The
/// usage index only keeps token counts, so this reads the .jsonl the event was
/// parsed out of — no schema of ours, theirs.
/// </summary>
public static class TranscriptReader
{
    /// <summary>Rows held in memory. A months-long transcript is trimmed from
    /// the front: the block that opened the viewer sits near the end.</summary>
    private const int MaxEntries = 4000;

    public static Task<TranscriptDocument> ReadAsync(
        string path,
        string client,
        long anchorTimestampMs,
        CancellationToken cancellationToken = default) =>
        Task.Run(() => Read(path, client, anchorTimestampMs, cancellationToken), cancellationToken);

    private static TranscriptDocument Read(
        string path,
        string client,
        long anchorTimestampMs,
        CancellationToken cancellationToken)
    {
        var isCodex = client.Equals("codex", StringComparison.OrdinalIgnoreCase);
        var drafts = new List<Draft>();
        var dropped = 0;
        string? error = null;

        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var toolNames = new Dictionary<string, string>(StringComparer.Ordinal);
            var group = 0;
            while (reader.ReadLine() is { } line)
            {
                cancellationToken.ThrowIfCancellationRequested();
                group++;
                if (line.Length == 0)
                {
                    continue;
                }

                try
                {
                    using var document = JsonDocument.Parse(line);
                    if (document.RootElement.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    if (isCodex)
                    {
                        ReadCodexLine(document.RootElement, group, drafts);
                    }
                    else
                    {
                        ReadClaudeLine(document.RootElement, group, toolNames, drafts);
                    }
                }
                catch (JsonException)
                {
                    // A line mid-write, or a record we have no business reading.
                }
                catch (InvalidOperationException)
                {
                    // Text truncated mid-emoji leaves an unpaired surrogate escape
                    // that parses but will not decode. Drop the one row rather than
                    // fail the whole transcript.
                }

                if (drafts.Count > MaxEntries + 512)
                {
                    drafts.RemoveRange(0, 512);
                    dropped += 512;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                              or ArgumentException or NotSupportedException)
        {
            error = exception.Message;
        }

        var entries = Deduplicate(drafts);
        if (!isCodex)
        {
            entries.InsertRange(0, CapturedRequestRows(path));
        }

        return new TranscriptDocument(path, client, entries, Anchor(entries, anchorTimestampMs), dropped, error);
    }

    /// <summary>
    /// The request side the transcript never records — the system prompt and
    /// tool schemas — when the local relay captured it for this session. Group 0
    /// keeps these ahead of every real line (file lines start at group 1).
    /// </summary>
    private static List<TranscriptEntry> CapturedRequestRows(string path)
    {
        var rows = new List<TranscriptEntry>();
        foreach (var capture in RequestCaptureStore.ReadForTranscript(path))
        {
            var detail = (capture.Model ?? "unknown model") + " · captured from the live request";
            if (capture.SystemPrompt.Length > 0)
            {
                rows.Add(new TranscriptEntry(TranscriptRole.System, "system prompt", detail,
                    capture.SystemPrompt, capture.CapturedMs, 0));
            }

            if (capture.ToolNames.Count > 0)
            {
                rows.Add(new TranscriptEntry(TranscriptRole.System, "tools",
                    $"{capture.ToolNames.Count} schemas · captured from the live request",
                    string.Join(", ", capture.ToolNames) + "\n\n" + capture.ToolsJson.TrimEnd(),
                    capture.CapturedMs, 0));
            }
        }

        return rows;
    }

    /// <summary>
    /// Codex writes the same turn more than once: newer rollouts carry both raw
    /// <c>response_item</c> tool calls and richer <c>item_completed</c> items,
    /// and older ones repeat messages as <c>event_msg</c>. Keep the best copy of
    /// each, in file order.
    /// </summary>
    private static List<TranscriptEntry> Deduplicate(List<Draft> drafts)
    {
        var hasItems = drafts.Any(draft => draft.Family == Family.CompletedItem);
        var hasMessages = drafts.Any(draft => draft.Family == Family.Message);
        return drafts
            .Where(draft => draft.Family switch
            {
                Family.RawCall => !hasItems,
                Family.Echo => !hasMessages,
                _ => true
            })
            .Select(draft => draft.Entry)
            .ToList();
    }

    /// <summary>The row the double-clicked block belongs to: the last one at or
    /// before the event's timestamp, rewound to the start of its response.</summary>
    private static int Anchor(List<TranscriptEntry> entries, long anchorTimestampMs)
    {
        if (entries.Count == 0)
        {
            return -1;
        }

        var index = -1;
        for (var i = 0; i < entries.Count; i++)
        {
            if (entries[i].TimestampMs > 0 && entries[i].TimestampMs <= anchorTimestampMs)
            {
                index = i;
            }
        }

        if (index < 0)
        {
            return 0;
        }

        var group = entries[index].Group;
        while (index > 0 && entries[index - 1].Group == group)
        {
            index--;
        }

        return index;
    }

    // ----- Claude Code ------------------------------------------------------

    private static void ReadClaudeLine(
        JsonElement root,
        int group,
        Dictionary<string, string> toolNames,
        List<Draft> drafts)
    {
        var type = GetString(root, "type");
        var timestamp = ParseTimestamp(root);
        if (type == "system")
        {
            var text = GetString(root, "content") ?? GetString(root, "text");
            if (text is not null)
            {
                Add(drafts, Family.Message, TranscriptRole.System, "system",
                    GetString(root, "subtype"), text, timestamp, group);
            }

            return;
        }

        if (type == "attachment")
        {
            if (TryGetObject(root, "attachment", out var attachment))
            {
                ReadClaudeAttachment(attachment, timestamp, group, drafts);
            }

            return;
        }

        if ((type != "user" && type != "assistant") || !TryGetObject(root, "message", out var message))
        {
            return;
        }

        // Injected context and subagent work are part of what happened; they are
        // labelled rather than dropped, so the transcript stays honest.
        var detail = IsTrue(root, "isMeta") ? "injected context"
            : IsTrue(root, "isSidechain") ? "subagent"
            : null;
        var content = message.TryGetProperty("content", out var value) ? value : default;

        if (type == "user")
        {
            if (content.ValueKind == JsonValueKind.String)
            {
                AddText(drafts, Family.Message, TranscriptRole.User, "You", detail,
                    content.GetString(), timestamp, group);
                return;
            }

            foreach (var block in EnumerateArray(content))
            {
                switch (GetString(block, "type"))
                {
                    case "text":
                        AddText(drafts, Family.Message, TranscriptRole.User, "You", detail,
                            GetString(block, "text"), timestamp, group);
                        break;
                    case "tool_result":
                        var id = GetString(block, "tool_use_id");
                        var name = id is not null && toolNames.TryGetValue(id, out var known) ? known : "tool";
                        var failed = block.TryGetProperty("is_error", out var isError) &&
                                     isError.ValueKind == JsonValueKind.True;
                        Add(drafts, Family.Message, TranscriptRole.ToolResult, $"↳ {name}",
                            failed ? "error" : detail, BlockText(block, "content"), timestamp, group, failed);
                        break;
                    case "image":
                        Add(drafts, Family.Message, TranscriptRole.User, "You", "image", "[image]",
                            timestamp, group);
                        break;
                }
            }

            return;
        }

        var model = GetString(message, "model") ?? GetString(root, "model");
        foreach (var block in EnumerateArray(content))
        {
            switch (GetString(block, "type"))
            {
                case "text":
                    AddText(drafts, Family.Message, TranscriptRole.Assistant, "Claude",
                        detail ?? model, GetString(block, "text"), timestamp, group);
                    break;
                case "thinking":
                    AddText(drafts, Family.Message, TranscriptRole.Thinking, "thinking", detail,
                        GetString(block, "thinking"), timestamp, group);
                    break;
                case "redacted_thinking":
                    Add(drafts, Family.Message, TranscriptRole.Thinking, "thinking", "redacted",
                        "[encrypted]", timestamp, group);
                    break;
                case "tool_use":
                    var name = GetString(block, "name") ?? "tool";
                    if (GetString(block, "id") is { } id)
                    {
                        toolNames[id] = name;
                    }

                    var input = block.TryGetProperty("input", out var value2) ? value2 : default;
                    Add(drafts, Family.Message, TranscriptRole.ToolCall, name,
                        SummarizeInput(input), DescribeInput(input), timestamp, group);
                    break;
            }
        }
    }

    /// <summary>
    /// Claude Code logs the context it injects between prompts as attachment
    /// records: tool, agent and skill listings, MCP instructions, hook output,
    /// attached files, queued prompts, token reminders. The harness system
    /// prompt and tool schemas are never written to the transcript at all, so
    /// these listings are everything the log holds about that side of a request.
    /// </summary>
    private static void ReadClaudeAttachment(
        JsonElement attachment,
        long timestamp,
        int group,
        List<Draft> drafts)
    {
        var kind = GetString(attachment, "type");
        switch (kind)
        {
            case "deferred_tools_delta":
                var tools = new StringBuilder();
                AppendNames(tools, attachment, "addedNames", "tools made available:");
                AppendNames(tools, attachment, "readdedNames", "tools made available again:");
                AppendNames(tools, attachment, "removedNames", "tools withdrawn:");
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "deferred tools",
                    tools.ToString(), timestamp, group);
                break;
            case "agent_listing_delta":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "agent types",
                    JoinArray(attachment, "addedLines", "\n"), timestamp, group);
                break;
            case "mcp_instructions_delta":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "MCP instructions",
                    JoinArray(attachment, "addedBlocks", "\n\n"), timestamp, group);
                break;
            case "skill_listing":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "skills",
                    GetString(attachment, "content"), timestamp, group);
                break;
            case "total_tokens_reminder":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "token budget",
                    GetString(attachment, "text"), timestamp, group);
                break;
            case "queued_command":
                AddText(drafts, Family.Message, TranscriptRole.User, "You", "queued",
                    GetString(attachment, "prompt"), timestamp, group);
                break;
            case "file":
                AddText(drafts, Family.Message, TranscriptRole.System, "context",
                    GetString(attachment, "displayPath") ?? GetString(attachment, "filename") ?? "attached file",
                    BlockText(attachment, "content"), timestamp, group);
                break;
            case "compact_file_reference":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "compacted conversation",
                    GetString(attachment, "displayPath") ?? GetString(attachment, "filename"), timestamp, group);
                break;
            case "date_change":
                AddText(drafts, Family.Message, TranscriptRole.System, "context", "date change",
                    GetString(attachment, "newDate"), timestamp, group);
                break;
            case "hook_success":
            case "hook_additional_context":
                var hook = new StringBuilder();
                Append(hook, GetString(attachment, "content"));
                Append(hook, GetString(attachment, "stdout"));
                Append(hook, GetString(attachment, "stderr"));
                var exitCode = GetInt(attachment, "exitCode");
                AddText(drafts, Family.Message, TranscriptRole.System, "context",
                    "hook: " + (GetString(attachment, "hookName") ?? GetString(attachment, "hookEvent") ?? "?"),
                    hook.ToString(), timestamp, group, exitCode is { } code && code != 0);
                break;
            case null:
                break;
            default:
                // A record shape this reader hasn't met: keep the row visible
                // rather than silently thinning the log.
                AddText(drafts, Family.Message, TranscriptRole.System, "context", kind,
                    GetString(attachment, "content") ?? GetString(attachment, "text") ?? $"[{kind}]",
                    timestamp, group);
                break;
        }
    }

    private static void AppendNames(StringBuilder builder, JsonElement parent, string name, string heading)
    {
        var joined = JoinArray(parent, name, "\n");
        if (joined.Length > 0)
        {
            builder.AppendLine(heading).AppendLine(joined);
        }
    }

    private static void Append(StringBuilder builder, string? text)
    {
        if (!string.IsNullOrWhiteSpace(text))
        {
            builder.AppendLine(text.TrimEnd());
        }
    }

    private static string JoinArray(JsonElement parent, string name, string separator)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        return string.Join(separator, value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString()));
    }

    // ----- Codex ------------------------------------------------------------

    private static void ReadCodexLine(JsonElement root, int group, List<Draft> drafts)
    {
        var timestamp = ParseTimestamp(root);
        var type = GetString(root, "type");
        if (!TryGetObject(root, "payload", out var payload))
        {
            return;
        }

        var payloadType = GetString(payload, "type");
        if (type == "response_item")
        {
            switch (payloadType)
            {
                case "message":
                    // developer/system roles are the harness talking to itself.
                    var role = GetString(payload, "role");
                    if (role == "user" || role == "assistant")
                    {
                        AddText(drafts, Family.Message,
                            role == "user" ? TranscriptRole.User : TranscriptRole.Assistant,
                            role == "user" ? "You" : "Codex", null,
                            BlockText(payload, "content"), timestamp, group);
                    }

                    break;
                case "reasoning":
                    AddText(drafts, Family.RawCall, TranscriptRole.Thinking, "reasoning", null,
                        SummaryText(payload), timestamp, group);
                    break;
                case "function_call":
                case "custom_tool_call":
                    var input = Unwrap(GetString(payload, "input") ?? GetString(payload, "arguments") ?? "", out _);
                    Add(drafts, Family.RawCall, TranscriptRole.ToolCall,
                        GetString(payload, "name") ?? "tool", null, input, timestamp, group);
                    break;
                case "function_call_output":
                case "custom_tool_call_output":
                    var output = Unwrap(BlockText(payload, "output"), out var status);
                    Add(drafts, Family.RawCall, TranscriptRole.ToolResult, "↳ output", status, output,
                        timestamp, group, status is not null && status != "exit 0");
                    break;
            }

            return;
        }

        if (type != "event_msg")
        {
            return;
        }

        switch (payloadType)
        {
            case "user_message":
                AddText(drafts, Family.Echo, TranscriptRole.User, "You", null,
                    GetString(payload, "message"), timestamp, group);
                break;
            case "agent_message":
                AddText(drafts, Family.Echo, TranscriptRole.Assistant, "Codex", null,
                    GetString(payload, "message"), timestamp, group);
                break;
            case "agent_reasoning":
                AddText(drafts, Family.Echo, TranscriptRole.Thinking, "reasoning", null,
                    GetString(payload, "text"), timestamp, group);
                break;
            case "item_completed":
                ReadCodexItem(payload, timestamp, group, drafts);
                break;
        }
    }

    private static void ReadCodexItem(JsonElement payload, long timestamp, int group, List<Draft> drafts)
    {
        if (!TryGetObject(payload, "item", out var item))
        {
            return;
        }

        switch (GetString(item, "type"))
        {
            case "UserMessage":
                AddText(drafts, Family.Echo, TranscriptRole.User, "You", null,
                    BlockText(item, "content"), timestamp, group);
                break;
            case "AgentMessage":
                AddText(drafts, Family.Echo, TranscriptRole.Assistant, "Codex", null,
                    BlockText(item, "content"), timestamp, group);
                break;
            case "Reasoning":
                AddText(drafts, Family.CompletedItem, TranscriptRole.Thinking, "reasoning", null,
                    GetString(item, "summary_text") ?? SummaryText(item), timestamp, group);
                break;
            case "CommandExecution":
                var command = TextOf(item, "command");
                Add(drafts, Family.CompletedItem, TranscriptRole.ToolCall, "exec",
                    LocalPath(GetString(item, "cwd")), command, timestamp, group);
                var code = GetInt(item, "exit_code");
                Add(drafts, Family.CompletedItem, TranscriptRole.ToolResult,
                    code is { } exit ? $"↳ exit {exit}" : "↳ output",
                    GetString(item, "status"),
                    GetString(item, "aggregated_output") ?? GetString(item, "stdout") ?? "",
                    timestamp, group, code is { } failure && failure != 0);
                break;
            case "FileChange":
                ReadCodexFileChange(item, timestamp, group, drafts);
                break;
            case "WebSearch":
                Add(drafts, Family.CompletedItem, TranscriptRole.ToolCall, "web search",
                    GetString(item, "query"), GetString(item, "query") ?? "", timestamp, group);
                break;
        }
    }

    private static void ReadCodexFileChange(JsonElement item, long timestamp, int group, List<Draft> drafts)
    {
        if (!TryGetObject(item, "changes", out var changes))
        {
            return;
        }

        var files = new List<string>();
        var body = new StringBuilder();
        foreach (var change in changes.EnumerateObject())
        {
            files.Add(Path.GetFileName(change.Name.TrimEnd('\\', '/')));
            body.Append(GetString(change.Value, "type") ?? "change").Append(' ').AppendLine(change.Name);
            if (GetString(change.Value, "unified_diff") is { } diff)
            {
                body.AppendLine(diff.TrimEnd()).AppendLine();
            }
        }

        Add(drafts, Family.CompletedItem, TranscriptRole.ToolCall, "edit",
            files.Count == 1 ? files[0] : $"{files.Count} files: {string.Join(", ", files.Take(4))}",
            body.ToString(), timestamp, group,
            string.Equals(GetString(item, "status"), "failed", StringComparison.OrdinalIgnoreCase));
    }

    // ----- row building -----------------------------------------------------

    private static void AddText(
        List<Draft> drafts,
        Family family,
        TranscriptRole role,
        string title,
        string? detail,
        string? text,
        long timestampMs,
        int group,
        bool isError = false)
    {
        if (!string.IsNullOrWhiteSpace(text))
        {
            Add(drafts, family, role, title, detail, text, timestampMs, group, isError);
        }
    }

    private static void Add(
        List<Draft> drafts,
        Family family,
        TranscriptRole role,
        string title,
        string? detail,
        string body,
        long timestampMs,
        int group,
        bool isError = false)
    {
        // Bodies are kept whole — the viewer clips gigantic ones for display and
        // expands them on click, so nothing in the log is unreachable.
        body = body.Replace("\r\n", "\n").TrimEnd();
        drafts.Add(new Draft(family, new TranscriptEntry(
            role, title, detail, body, timestampMs, group, isError)));
    }

    /// <summary>
    /// Codex hands tool arguments and results over as JSON text. Unwrap the
    /// shapes it uses — <c>{"output": …, "metadata": {"exit_code": …}}</c> and
    /// argument objects — and leave anything else exactly as written.
    /// </summary>
    private static string Unwrap(string text, out string? status)
    {
        status = null;
        if (!text.TrimStart().StartsWith('{'))
        {
            return text;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return text;
            }

            if (GetString(root, "output") is { } output)
            {
                if (TryGetObject(root, "metadata", out var metadata) && GetInt(metadata, "exit_code") is { } code)
                {
                    status = $"exit {code}";
                }

                return output;
            }

            return DescribeInput(root);
        }
        catch (JsonException)
        {
            return text;
        }
    }

    /// <summary>Tool arguments as readable lines rather than escaped JSON: long
    /// or multi-line values (an edit's replacement text) get their own block.</summary>
    private static string DescribeInput(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return input.ValueKind == JsonValueKind.Undefined ? "" : input.ToString();
        }

        var builder = new StringBuilder();
        foreach (var property in input.EnumerateObject())
        {
            var value = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString() ?? "",
                JsonValueKind.Array => JoinStrings(property.Value),
                _ => property.Value.ToString()
            };
            if (value.Contains('\n') || value.Length > 80)
            {
                builder.Append(property.Name).Append(":\n").Append(value.TrimEnd()).Append("\n\n");
            }
            else
            {
                builder.Append(property.Name).Append(": ").Append(value).Append('\n');
            }
        }

        return builder.ToString();
    }

    /// <summary>The one line that says what a tool call was aimed at.</summary>
    private static string? SummarizeInput(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var name in InputHeadlines)
        {
            if (GetString(input, name) is { } value)
            {
                return OneLine(value, 160);
            }
        }

        foreach (var property in input.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                return OneLine($"{property.Name}: {property.Value.GetString()}", 160);
            }
        }

        return null;
    }

    private static readonly string[] InputHeadlines =
    [
        "command", "file_path", "path", "notebook_path", "pattern", "query", "url", "prompt", "description"
    ];

    /// <summary>Text out of a property that may be a string, an array of content
    /// blocks, or an object — all three shapes appear in these logs.</summary>
    private static string BlockText(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value))
        {
            return "";
        }

        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                return value.GetString() ?? "";
            case JsonValueKind.Array:
                var builder = new StringBuilder();
                foreach (var block in value.EnumerateArray())
                {
                    if (block.ValueKind == JsonValueKind.String)
                    {
                        builder.AppendLine(block.GetString());
                    }
                    else if (GetString(block, "text") is { } text)
                    {
                        builder.AppendLine(text);
                    }
                    else if (GetString(block, "type") is { } type)
                    {
                        builder.AppendLine($"[{type}]");
                    }
                }

                return builder.ToString();
            case JsonValueKind.Object:
                return GetString(value, "text") ?? GetString(value, "output") ?? value.ToString();
            default:
                return "";
        }
    }

    /// <summary>A field that is a string in one version of these logs and a
    /// list of argv strings in the next (Codex's exec command).</summary>
    private static string TextOf(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value))
        {
            return "";
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Array => JoinStrings(value),
            _ => ""
        };
    }

    private static string JoinStrings(JsonElement array) => string.Join(
        ' ',
        array.EnumerateArray().Select(item =>
            item.ValueKind == JsonValueKind.String ? item.GetString() : item.ToString()));

    /// <summary>Codex reasoning: a list of summary parts, or plain strings.</summary>
    private static string SummaryText(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("summary", out var summary) ||
            summary.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        var builder = new StringBuilder();
        foreach (var part in summary.EnumerateArray())
        {
            if (part.ValueKind == JsonValueKind.String)
            {
                builder.AppendLine(part.GetString());
            }
            else if (GetString(part, "text") is { } text)
            {
                builder.AppendLine(text);
            }
        }

        return builder.ToString();
    }

    /// <summary>Codex records a working directory as a file:// URI; nobody
    /// reads one of those on purpose.</summary>
    private static string? LocalPath(string? path) =>
        path is not null && Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.IsFile
            ? uri.LocalPath.Replace('/', '\\')
            : path;

    private static string OneLine(string text, int max)
    {
        var flat = text.ReplaceLineEndings(" ").Trim();
        while (flat.Contains("  ", StringComparison.Ordinal))
        {
            flat = flat.Replace("  ", " ", StringComparison.Ordinal);
        }

        return flat.Length <= max ? flat : flat[..(max - 1)].TrimEnd() + "…";
    }

    private static long ParseTimestamp(JsonElement root) =>
        GetString(root, "timestamp") is { } text && DateTimeOffset.TryParse(text, out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : 0;

    private static IEnumerable<JsonElement> EnumerateArray(JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];

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

    private static bool IsTrue(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.True;

    private static string? GetString(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value) ||
            value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var text = value.GetString();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static int? GetInt(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
            ? number
            : null;

    private enum Family
    {
        /// <summary>Prompts and replies — always kept.</summary>
        Message,

        /// <summary>Codex's normalized turn items; win over the raw calls.</summary>
        CompletedItem,

        /// <summary>Raw response_item tool calls; dropped when items exist.</summary>
        RawCall,

        /// <summary>event_msg copies of messages; dropped when real ones exist.</summary>
        Echo
    }

    private sealed record Draft(Family Family, TranscriptEntry Entry);
}
