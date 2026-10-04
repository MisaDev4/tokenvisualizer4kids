using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace TokenTracker;

/// <summary>
/// Indexes OpenCode usage straight out of its SQLite store
/// (~/.local/share/opencode/opencode.db). T3 Code embeds OpenCode, and the
/// desktop's provider event-log mirror proved unreliable — it went quiet after
/// one thread while the database kept recording every session — so the store
/// is read directly: each assistant message row carries its own token usage,
/// model id and provider. OpenCode keeps the database in WAL mode, so a
/// read-only connection rides alongside its writer; polling stays cheap
/// because the message table holds one row per message, not per event.
/// Events are upserted by message id, making every re-read a no-op.
/// </summary>
public sealed class OpenCodeUsageService : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(4);

    private static readonly JsonSerializerOptions StateJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly UsageDatabase _database;
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _pollLoop;
    private bool _disposed;

    public OpenCodeUsageService(UsageDatabase database) => _database = database;

    public event Action? DataChanged;

    public string DatabasePath { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".local",
        "share",
        "opencode",
        "opencode.db");

    public void Start() => _pollLoop ??= PollLoopAsync(_shutdown.Token);

    private async Task PollLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            // The events.*.log source this service replaces briefly indexed the
            // same sessions under client "t3"; those rows would double-count
            // once the database backfills them, so they are retired here.
            await _database.DeleteClientEventsAsync("t3", cancellationToken).ConfigureAwait(false);

            while (!cancellationToken.IsCancellationRequested)
            {
                await PollOnceAsync(cancellationToken).ConfigureAwait(false);
                await Task.Delay(PollInterval, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task PollOnceAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(DatabasePath))
        {
            return;
        }

        try
        {
            var existing = await _database.GetSourceStateAsync(DatabasePath, cancellationToken)
                .ConfigureAwait(false);
            var cursor = ReadCursor(existing?.ParserStateJson);
            var (events, maxUpdated) = ReadNewMessages(cursor, cancellationToken);
            if (maxUpdated <= cursor)
            {
                return;
            }

            var info = new FileInfo(DatabasePath);
            var state = new SourceFileState(
                DatabasePath,
                "opencode",
                info.Length,
                info.LastWriteTimeUtc.Ticks,
                ProcessedOffset: 0,
                JsonSerializer.Serialize(new PollCursor(maxUpdated), StateJsonOptions),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await _database.AppendFileEventsAsync(state, events, cancellationToken).ConfigureAwait(false);
            if (events.Count > 0)
            {
                DataChanged?.Invoke();
            }
        }
        catch (Exception exception) when (exception is SqliteException or IOException or InvalidOperationException)
        {
            // The store is another app's database: a lock, a mid-write hiccup,
            // or a checkpoint can fail one poll. The next one is seconds away.
        }
    }

    private (List<UsageEvent> Events, long MaxUpdated) ReadNewMessages(
        long cursor,
        CancellationToken cancellationToken)
    {
        var events = new List<UsageEvent>();
        var maxUpdated = cursor;
        using var connection = new SqliteConnection($"Data Source={DatabasePath};Mode=ReadOnly");
        connection.Open();
        using (var timeout = connection.CreateCommand())
        {
            timeout.CommandText = "PRAGMA busy_timeout=2000;";
            timeout.ExecuteNonQuery();
        }

        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, session_id, time_created, time_updated, data
            FROM message
            WHERE time_updated > $cursor
            ORDER BY time_updated;
            """;
        command.Parameters.AddWithValue("$cursor", cursor);

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            maxUpdated = Math.Max(maxUpdated, reader.GetInt64(3));
            var parsed = ParseMessage(
                reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(4));
            if (parsed is not null)
            {
                events.Add(parsed);
            }
        }

        return (events, maxUpdated);
    }

    /// <summary>One message row's data JSON, as recorded by OpenCode:
    /// role/modelID/providerID at the top, tokens as
    /// <c>{input, output, reasoning, cache: {read, write}}</c> where input
    /// excludes cached tokens, and time.completed stamped once the response
    /// finished. A message still streaming reports zero tokens and is skipped;
    /// its completion bumps time_updated and it is re-read then.</summary>
    private UsageEvent? ParseMessage(string messageId, string sessionId, long createdMs, string data)
    {
        try
        {
            using var document = JsonDocument.Parse(data);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                GetString(root, "role") != "assistant" ||
                !root.TryGetProperty("tokens", out var tokensElement) ||
                tokensElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var cacheRead = 0L;
            var cacheWrite = 0L;
            if (tokensElement.TryGetProperty("cache", out var cache) && cache.ValueKind == JsonValueKind.Object)
            {
                cacheRead = GetLong(cache, "read");
                cacheWrite = GetLong(cache, "write");
            }

            var tokens = new TokenBreakdown(
                GetLong(tokensElement, "input"),
                GetLong(tokensElement, "output"),
                cacheRead,
                cacheWrite,
                GetLong(tokensElement, "reasoning"));
            if (tokens.IsEmpty)
            {
                return null;
            }

            var timestamp = createdMs;
            if (root.TryGetProperty("time", out var time) && time.ValueKind == JsonValueKind.Object)
            {
                var completed = GetLong(time, "completed");
                var created = GetLong(time, "created");
                timestamp = completed > 0 ? completed : created > 0 ? created : createdMs;
            }

            return new UsageEvent(
                Hash($"opencode:message:{messageId}"),
                DatabasePath,
                "opencode",
                GetString(root, "providerID") ?? "opencode",
                GetString(root, "modelID") ?? "unknown",
                sessionId,
                timestamp,
                tokens);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static long ReadCursor(string? stateJson)
    {
        if (string.IsNullOrWhiteSpace(stateJson))
        {
            return 0;
        }

        try
        {
            return JsonSerializer.Deserialize<PollCursor>(stateJson, StateJsonOptions)?.LastTimeUpdated ?? 0;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static string? GetString(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var text = value.GetString();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static long GetLong(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? Math.Max(0, number)
            : 0;

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed record PollCursor(long LastTimeUpdated);

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
    }
}
