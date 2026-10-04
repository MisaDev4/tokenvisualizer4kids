using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

public sealed class UsageParser
{
    private static readonly JsonSerializerOptions StateJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public async Task<ParseResult> ParseFileAsync(
        string path,
        string client,
        long startOffset,
        string? parserStateJson,
        CancellationToken cancellationToken = default)
    {
        var fallbackTimestamp = new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
        if (client.Equals(CodexTraces.Client, StringComparison.OrdinalIgnoreCase))
        {
            return await ParseCodexTraceAsync(path, startOffset, parserStateJson, fallbackTimestamp, cancellationToken);
        }

        return client.Equals("codex", StringComparison.OrdinalIgnoreCase)
            ? await ParseCodexAsync(path, startOffset, parserStateJson, fallbackTimestamp, cancellationToken)
            : await ParseClaudeAsync(path, startOffset, fallbackTimestamp, cancellationToken);
    }

    /// <summary>A Codex rollout trace's trace.jsonl (see <see cref="CodexTraces"/>).
    /// Each inference_completed line points at a response payload holding that
    /// call's token_usage; calls are billed only for threads Codex wrote no
    /// session log for, since the rollout parser already counts the rest.</summary>
    private static async Task<ParseResult> ParseCodexTraceAsync(
        string path,
        long startOffset,
        string? parserStateJson,
        long fallbackTimestamp,
        CancellationToken cancellationToken)
    {
        var state = DeserializeState<CodexTraceState>(parserStateJson) ?? new CodexTraceState();
        var bundle = Path.GetDirectoryName(path)!;
        var events = new List<UsageEvent>();

        var offset = await JsonlReader.ReadCompleteLinesAsync(
            path,
            startOffset,
            line =>
            {
                ParseCodexTraceLine(line, path, bundle, fallbackTimestamp, state, events);
                return ValueTask.CompletedTask;
            },
            cancellationToken);

        return new ParseResult(events, offset, JsonSerializer.Serialize(state, StateJsonOptions));
    }

    private static void ParseCodexTraceLine(
        ReadOnlyMemory<byte> line,
        string path,
        string bundle,
        long fallbackTimestamp,
        CodexTraceState state,
        List<UsageEvent> events)
    {
        if (line.IsEmpty)
        {
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!TryGetObject(root, "payload", out var payload))
            {
                return;
            }

            var threadId = FirstNonEmpty(GetString(root, "thread_id"), GetString(payload, "thread_id"));
            switch (GetString(payload, "type"))
            {
                case "thread_started" when threadId is not null:
                    state.Unlogged[threadId] = !CodexTraces.IsLogged(bundle, payload);
                    return;

                case "inference_started" when GetString(payload, "inference_call_id") is { } callId:
                    state.Models[callId] = FirstNonEmpty(GetString(payload, "model"), "unknown")!;
                    state.Provider = FirstNonEmpty(GetString(payload, "provider_name")?.ToLowerInvariant(), state.Provider);
                    return;

                case "inference_completed":
                    break;

                default:
                    return;
            }

            var inferenceCallId = GetString(payload, "inference_call_id");
            var model = "unknown";
            if (inferenceCallId is not null && state.Models.Remove(inferenceCallId, out var startedModel))
            {
                model = startedModel;
            }

            if (threadId is null || !state.Unlogged.TryGetValue(threadId, out var unlogged) || !unlogged ||
                !TryGetObject(payload, "response_payload", out var reference) ||
                GetString(reference, "path") is not { } relativePath)
            {
                return;
            }

            using var response = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(bundle, relativePath)));
            if (!TryGetObject(response.RootElement, "token_usage", out var usage))
            {
                return;
            }

            // Same split as a rollout's token_count, so both paths bill alike.
            var tokens = CodexTotals.FromJson(usage).ToBreakdown();
            if (tokens.IsEmpty)
            {
                return;
            }

            var timestamp = root.TryGetProperty("wall_time_unix_ms", out var wallTime) &&
                            wallTime.TryGetInt64(out var wallTimeMs)
                ? wallTimeMs
                : fallbackTimestamp;
            var responseId = FirstNonEmpty(GetString(payload, "response_id"), GetString(response.RootElement, "response_id"));
            var identity = responseId is not null
                ? $"codex:response:{responseId}"
                : $"codex:trace:{threadId}:{inferenceCallId}:{timestamp}";

            events.Add(new UsageEvent(
                Hash(identity), path, "codex", FirstNonEmpty(state.Provider, "openai")!, model, threadId, timestamp, tokens));
        }
        catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException)
        {
            // A payload pruned or still being written costs that one call, not the file.
        }
    }

    private static async Task<ParseResult> ParseCodexAsync(
        string path,
        long startOffset,
        string? parserStateJson,
        long fallbackTimestamp,
        CancellationToken cancellationToken)
    {
        var state = DeserializeState<CodexParserState>(parserStateJson) ?? new CodexParserState();
        var events = new List<UsageEvent>();
        var fallbackSessionId = Path.GetFileNameWithoutExtension(path);

        var offset = await JsonlReader.ReadCompleteLinesAsync(
            path,
            startOffset,
            line =>
            {
                ParseCodexLine(line, path, fallbackSessionId, fallbackTimestamp, state, events);
                return ValueTask.CompletedTask;
            },
            cancellationToken);

        return new ParseResult(events, offset, JsonSerializer.Serialize(state, StateJsonOptions));
    }

    private static void ParseCodexLine(
        ReadOnlyMemory<byte> line,
        string path,
        string fallbackSessionId,
        long fallbackTimestamp,
        CodexParserState state,
        List<UsageEvent> events)
    {
        if (line.IsEmpty)
        {
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var entryType = GetString(root, "type");
            if (!TryGetObject(root, "payload", out var payload))
            {
                return;
            }

            if (entryType == "session_meta")
            {
                state.SessionId = FirstNonEmpty(GetString(payload, "id"), state.SessionId);
                state.ForkedFromId = FirstNonEmpty(
                    GetString(payload, "forked_from_id"),
                    GetNestedString(payload, "source", "subagent", "thread_spawn", "parent_thread_id"),
                    state.ForkedFromId);
                state.Provider = FirstNonEmpty(GetString(payload, "model_provider"), state.Provider, "openai");
                state.CurrentModel = FirstNonEmpty(
                    GetString(payload, "model"),
                    GetString(payload, "model_name"),
                    GetNestedString(payload, "model_info", "slug"),
                    state.CurrentModel);
                return;
            }

            if (entryType == "turn_context")
            {
                state.CurrentModel = FirstNonEmpty(
                    GetString(payload, "model"),
                    GetString(payload, "model_name"),
                    GetNestedString(payload, "model_info", "slug"),
                    state.CurrentModel);
                state.Provider = FirstNonEmpty(GetString(payload, "model_provider"), state.Provider, "openai");
                return;
            }

            if (entryType != "event_msg" || GetString(payload, "type") != "token_count" ||
                !TryGetObject(payload, "info", out var info))
            {
                return;
            }

            var model = FirstNonEmpty(
                GetString(payload, "model"),
                GetString(payload, "model_name"),
                GetString(info, "model"),
                GetString(info, "model_name"),
                state.CurrentModel,
                "unknown")!;
            state.CurrentModel = model;

            var total = TryGetObject(info, "total_token_usage", out var totalElement)
                ? CodexTotals.FromJson(totalElement)
                : null;
            var last = TryGetObject(info, "last_token_usage", out var lastElement)
                ? CodexTotals.FromJson(lastElement)
                : null;

            CodexTotals? increment;
            CodexTotals? nextTotals;
            if (total is not null && last is not null && state.PreviousTotals is not null)
            {
                if (total == state.PreviousTotals)
                {
                    return;
                }

                if (total.DeltaFrom(state.PreviousTotals) is null &&
                    total.LooksLikeStaleRegression(state.PreviousTotals, last))
                {
                    return;
                }

                increment = last;
                nextTotals = total;
            }
            else if (total is not null && last is not null)
            {
                increment = last;
                nextTotals = total;
            }
            else if (total is not null && state.PreviousTotals is not null)
            {
                if (total == state.PreviousTotals)
                {
                    return;
                }

                increment = total.DeltaFrom(state.PreviousTotals);
                if (increment is null)
                {
                    state.PreviousTotals = total;
                    return;
                }

                nextTotals = total;
            }
            else if (total is not null)
            {
                increment = total;
                nextTotals = total;
            }
            else if (last is not null && state.PreviousTotals is not null)
            {
                increment = last;
                nextTotals = state.PreviousTotals.SaturatingAdd(last);
            }
            else if (last is not null)
            {
                increment = last;
                nextTotals = null;
            }
            else
            {
                return;
            }

            var tokens = increment.ToBreakdown();
            if (tokens.IsEmpty)
            {
                return;
            }

            state.PreviousTotals = nextTotals;
            var sessionId = FirstNonEmpty(state.SessionId, fallbackSessionId)!;
            var scopeId = FirstNonEmpty(state.ForkedFromId, state.SessionId, fallbackSessionId)!;
            var provider = FirstNonEmpty(state.Provider, "openai")!;
            var timestamp = ParseTimestamp(root, fallbackTimestamp);
            var identity = total is not null
                ? $"codex:token_count-total:{scopeId}:{provider}:{model}:{total.Input}:{total.Output}:{total.Cached}:{total.Reasoning}"
                : $"codex:token_count:{timestamp}:{provider}:{model}:{tokens.Input}:{tokens.Output}:{tokens.CacheRead}:{tokens.CacheWrite}:{tokens.Reasoning}";

            events.Add(new UsageEvent(
                Hash(identity), path, "codex", provider, model, sessionId, timestamp, tokens));
        }
        catch (JsonException)
        {
            // A malformed row should not make an otherwise useful session unreadable.
        }
    }

    private static async Task<ParseResult> ParseClaudeAsync(
        string path,
        long startOffset,
        long fallbackTimestamp,
        CancellationToken cancellationToken)
    {
        var byKey = new Dictionary<string, UsageEvent>(StringComparer.Ordinal);
        var fallbackSessionId = Path.GetFileNameWithoutExtension(path);

        var offset = await JsonlReader.ReadCompleteLinesAsync(
            path,
            startOffset,
            line =>
            {
                var parsed = ParseClaudeLine(line, path, fallbackSessionId, fallbackTimestamp);
                if (parsed is not null)
                {
                    if (byKey.TryGetValue(parsed.EventKey, out var existing))
                    {
                        byKey[parsed.EventKey] = MergeByMaximum(existing, parsed);
                    }
                    else
                    {
                        byKey.Add(parsed.EventKey, parsed);
                    }
                }

                return ValueTask.CompletedTask;
            },
            cancellationToken);

        return new ParseResult(byKey.Values.ToList(), offset, "{}");
    }

    private static UsageEvent? ParseClaudeLine(
        ReadOnlyMemory<byte> line,
        string path,
        string fallbackSessionId,
        long fallbackTimestamp)
    {
        if (line.IsEmpty)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (GetString(root, "type") != "assistant" || !TryGetObject(root, "message", out var message) ||
                !TryGetObject(message, "usage", out var usage))
            {
                return null;
            }

            var model = FirstNonEmpty(GetString(message, "model"), GetString(root, "model"));
            if (model is null || SourceDiscovery.IsJunkModel(model))
            {
                return null;
            }

            var messageId = GetString(message, "id");
            var provider = FirstNonEmpty(
                GetString(message, "provider"),
                GetString(message, "provider_id"),
                GetString(root, "provider"),
                GetString(root, "provider_id"),
                messageId?.StartsWith("msg_bdrk_", StringComparison.Ordinal) == true ? "bedrock" : null,
                InferProvider(model))!;
            var sessionId = FirstNonEmpty(GetString(root, "sessionId"), GetString(root, "session_id"), fallbackSessionId)!;
            var timestamp = ParseTimestamp(root, fallbackTimestamp);
            // Fast mode bills every rate at 2x standard, and the transcript records which speed
            // actually served the request. Marking it on the model name is what keeps the two
            // apart: every aggregate in the database groups by model.
            if (string.Equals(
                    FirstNonEmpty(GetString(usage, "speed"), GetString(message, "speed"), GetString(root, "speed")),
                    "fast",
                    StringComparison.OrdinalIgnoreCase))
            {
                model = $"{model} (fast)";
            }

            // cache_creation_input_tokens is the flat total; the cache_creation sub-object
            // splits it by TTL. Anthropic bills a 1-hour write at 2x base input against
            // 1.25x for a 5-minute one, so the split has to survive into the database.
            var ephemeral1h = 0L;
            var ephemeral5m = 0L;
            if (TryGetObject(usage, "cache_creation", out var cacheCreation))
            {
                ephemeral1h = GetLong(cacheCreation, "ephemeral_1h_input_tokens");
                ephemeral5m = GetLong(cacheCreation, "ephemeral_5m_input_tokens");
            }

            var cacheWrite = Math.Max(
                GetLong(usage, "cache_creation_input_tokens"),
                ephemeral1h + ephemeral5m);
            var tokens = new TokenBreakdown(
                GetLong(usage, "input_tokens"),
                GetLong(usage, "output_tokens"),
                GetLong(usage, "cache_read_input_tokens"),
                cacheWrite,
                GetLong(usage, "reasoning_output_tokens"),
                Math.Min(ephemeral1h, cacheWrite));
            if (tokens.IsEmpty)
            {
                return null;
            }

            var requestId = FirstNonEmpty(GetString(root, "requestId"), GetString(root, "request_id"));
            var identity = messageId is not null && requestId is not null
                ? $"claude:{messageId}:{requestId}"
                : messageId is not null
                    ? $"claude:message:{messageId}"
                    : $"claude:{sessionId}:{timestamp}:{provider}:{model}:{tokens.Input}:{tokens.Output}:{tokens.CacheRead}:{tokens.CacheWrite}:{tokens.Reasoning}";

            return new UsageEvent(Hash(identity), path, "claude", provider, model, sessionId, timestamp, tokens);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static UsageEvent MergeByMaximum(UsageEvent left, UsageEvent right) =>
        right with
        {
            TimestampMs = Math.Max(left.TimestampMs, right.TimestampMs),
            Tokens = new TokenBreakdown(
                Math.Max(left.Tokens.Input, right.Tokens.Input),
                Math.Max(left.Tokens.Output, right.Tokens.Output),
                Math.Max(left.Tokens.CacheRead, right.Tokens.CacheRead),
                Math.Max(left.Tokens.CacheWrite, right.Tokens.CacheWrite),
                Math.Max(left.Tokens.Reasoning, right.Tokens.Reasoning),
                Math.Max(left.Tokens.CacheWrite1h, right.Tokens.CacheWrite1h))
        };

    private static T? DeserializeState<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<T>(json, StateJsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static long ParseTimestamp(JsonElement root, long fallback)
    {
        var timestamp = GetString(root, "timestamp");
        return timestamp is not null && DateTimeOffset.TryParse(timestamp, out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : fallback;
    }

    private static string InferProvider(string model)
    {
        if (model.StartsWith("gpt", StringComparison.OrdinalIgnoreCase) ||
            model.Contains("codex", StringComparison.OrdinalIgnoreCase))
        {
            return "openai";
        }

        return model.StartsWith("gemini", StringComparison.OrdinalIgnoreCase) ? "google" : "anthropic";
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

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

    private static string? GetNestedString(JsonElement parent, params string[] names)
    {
        var current = parent;
        for (var index = 0; index < names.Length - 1; index++)
        {
            if (!TryGetObject(current, names[index], out current))
            {
                return null;
            }
        }

        return GetString(current, names[^1]);
    }

    private static long GetLong(JsonElement parent, string name)
    {
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var value))
        {
            return 0;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return Math.Max(0, number);
        }

        return value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out number)
            ? Math.Max(0, number)
            : 0;
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

    private sealed class CodexParserState
    {
        public string? CurrentModel { get; set; }
        public CodexTotals? PreviousTotals { get; set; }
        public string? SessionId { get; set; }
        public string? ForkedFromId { get; set; }
        public string? Provider { get; set; }
    }

    private sealed class CodexTraceState
    {
        /// <summary>Thread id → true when Codex wrote no session log for it.</summary>
        public Dictionary<string, bool> Unlogged { get; set; } = new(StringComparer.Ordinal);

        /// <summary>Model per inference still in flight, keyed by inference_call_id.</summary>
        public Dictionary<string, string> Models { get; set; } = new(StringComparer.Ordinal);

        public string? Provider { get; set; }
    }

    private sealed record CodexTotals(long Input, long Output, long Cached, long Reasoning)
    {
        public static CodexTotals FromJson(JsonElement usage) => new(
            GetLong(usage, "input_tokens"),
            GetLong(usage, "output_tokens"),
            Math.Max(GetLong(usage, "cached_input_tokens"), GetLong(usage, "cache_read_input_tokens")),
            GetLong(usage, "reasoning_output_tokens"));

        public CodexTotals? DeltaFrom(CodexTotals previous)
        {
            if (Input < previous.Input || Output < previous.Output || Cached < previous.Cached ||
                Reasoning < previous.Reasoning)
            {
                return null;
            }

            return new CodexTotals(
                Input - previous.Input,
                Output - previous.Output,
                Cached - previous.Cached,
                Reasoning - previous.Reasoning);
        }

        public CodexTotals SaturatingAdd(CodexTotals other) => new(
            SaturatingAdd(Input, other.Input),
            SaturatingAdd(Output, other.Output),
            SaturatingAdd(Cached, other.Cached),
            SaturatingAdd(Reasoning, other.Reasoning));

        public bool LooksLikeStaleRegression(CodexTotals previous, CodexTotals last)
        {
            var previousTotal = previous.Sum;
            var currentTotal = Sum;
            var lastTotal = last.Sum;
            if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0)
            {
                return false;
            }

            return SaturatingMultiply(currentTotal, 100) >= SaturatingMultiply(previousTotal, 98) ||
                   SaturatingAdd(currentTotal, SaturatingMultiply(lastTotal, 2)) >= previousTotal;
        }

        public TokenBreakdown ToBreakdown()
        {
            var cached = Math.Clamp(Cached, 0, Input);
            return new TokenBreakdown(Input - cached, Output, cached, 0, Reasoning);
        }

        private long Sum => SaturatingAdd(SaturatingAdd(Input, Output), SaturatingAdd(Cached, Reasoning));

        private static long SaturatingAdd(long left, long right) =>
            left > long.MaxValue - right ? long.MaxValue : left + right;

        private static long SaturatingMultiply(long value, long multiplier) =>
            value > long.MaxValue / multiplier ? long.MaxValue : value * multiplier;
    }
}
