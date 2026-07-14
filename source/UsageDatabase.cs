using Microsoft.Data.Sqlite;

namespace TokenTracker;

public sealed class UsageDatabase
{
    private readonly string _databasePath;
    private readonly string _connectionString;

    public UsageDatabase(string? databasePath = null)
    {
        _databasePath = databasePath ?? AppPaths.DatabasePath;
        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = true
        }.ToString();
    }

    public string DatabasePath => _databasePath;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS source_files (
                path TEXT PRIMARY KEY,
                client TEXT NOT NULL,
                length INTEGER NOT NULL,
                modified_ticks INTEGER NOT NULL,
                processed_offset INTEGER NOT NULL,
                parser_state_json TEXT NOT NULL,
                last_scanned_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                event_key TEXT PRIMARY KEY,
                source_path TEXT NOT NULL,
                client TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                session_id TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                message_count INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS ix_usage_events_timestamp
                ON usage_events(timestamp_ms);
            CREATE INDEX IF NOT EXISTS ix_usage_events_model
                ON usage_events(client, provider, model, timestamp_ms);
            CREATE INDEX IF NOT EXISTS ix_usage_events_source
                ON usage_events(source_path);
            """;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<long> GetEventCountAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM usage_events;";
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
    }

    public async Task<SourceFileState?> GetSourceStateAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            SELECT path, client, length, modified_ticks, processed_offset,
                   parser_state_json, last_scanned_ms
            FROM source_files
            WHERE path = $path;
            """;
        command.Parameters.AddWithValue("$path", path);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new SourceFileState(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt64(2),
            reader.GetInt64(3),
            reader.GetInt64(4),
            reader.GetString(5),
            reader.GetInt64(6));
    }

    public async Task<IReadOnlyDictionary<string, SourceFileState>> GetSourceStatesAsync(
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            SELECT path, client, length, modified_ticks, processed_offset,
                   parser_state_json, last_scanned_ms
            FROM source_files;
            """;

        var states = new Dictionary<string, SourceFileState>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var state = new SourceFileState(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetInt64(2),
                reader.GetInt64(3),
                reader.GetInt64(4),
                reader.GetString(5),
                reader.GetInt64(6));
            states[state.Path] = state;
        }

        return states;
    }

    public Task ReplaceFileEventsAsync(
        SourceFileState source,
        IReadOnlyList<UsageEvent> events,
        CancellationToken cancellationToken = default) =>
        SaveEventsAsync(source, events, replaceSourceEvents: true, cancellationToken);

    public Task AppendFileEventsAsync(
        SourceFileState source,
        IReadOnlyList<UsageEvent> events,
        CancellationToken cancellationToken = default) =>
        SaveEventsAsync(source, events, replaceSourceEvents: false, cancellationToken);

    private async Task SaveEventsAsync(
        SourceFileState source,
        IReadOnlyList<UsageEvent> events,
        bool replaceSourceEvents,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);

        if (replaceSourceEvents)
        {
            var delete = connection.CreateCommand();
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM usage_events WHERE source_path = $path;";
            delete.Parameters.AddWithValue("$path", source.Path);
            await delete.ExecuteNonQueryAsync(cancellationToken);
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var usageEvent in events)
        {
            var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO usage_events (
                    event_key, source_path, client, provider, model, session_id,
                    timestamp_ms, input_tokens, output_tokens, cache_read_tokens,
                    cache_write_tokens, reasoning_tokens, message_count, updated_ms)
                VALUES (
                    $event_key, $source_path, $client, $provider, $model, $session_id,
                    $timestamp_ms, $input, $output, $cache_read,
                    $cache_write, $reasoning, $messages, $updated_ms)
                ON CONFLICT(event_key) DO UPDATE SET
                    source_path = excluded.source_path,
                    client = excluded.client,
                    provider = excluded.provider,
                    model = excluded.model,
                    session_id = excluded.session_id,
                    timestamp_ms = excluded.timestamp_ms,
                    input_tokens = MAX(usage_events.input_tokens, excluded.input_tokens),
                    output_tokens = MAX(usage_events.output_tokens, excluded.output_tokens),
                    cache_read_tokens = MAX(usage_events.cache_read_tokens, excluded.cache_read_tokens),
                    cache_write_tokens = MAX(usage_events.cache_write_tokens, excluded.cache_write_tokens),
                    reasoning_tokens = MAX(usage_events.reasoning_tokens, excluded.reasoning_tokens),
                    message_count = MAX(usage_events.message_count, excluded.message_count),
                    updated_ms = excluded.updated_ms;
                """;
            insert.Parameters.AddWithValue("$event_key", usageEvent.EventKey);
            insert.Parameters.AddWithValue("$source_path", usageEvent.SourcePath);
            insert.Parameters.AddWithValue("$client", usageEvent.Client);
            insert.Parameters.AddWithValue("$provider", usageEvent.Provider);
            insert.Parameters.AddWithValue("$model", usageEvent.Model);
            insert.Parameters.AddWithValue("$session_id", usageEvent.SessionId);
            insert.Parameters.AddWithValue("$timestamp_ms", usageEvent.TimestampMs);
            insert.Parameters.AddWithValue("$input", usageEvent.Tokens.Input);
            insert.Parameters.AddWithValue("$output", usageEvent.Tokens.Output);
            insert.Parameters.AddWithValue("$cache_read", usageEvent.Tokens.CacheRead);
            insert.Parameters.AddWithValue("$cache_write", usageEvent.Tokens.CacheWrite);
            insert.Parameters.AddWithValue("$reasoning", usageEvent.Tokens.Reasoning);
            insert.Parameters.AddWithValue("$messages", usageEvent.MessageCount);
            insert.Parameters.AddWithValue("$updated_ms", now);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        var upsertSource = connection.CreateCommand();
        upsertSource.Transaction = transaction;
        upsertSource.CommandText = """
            INSERT INTO source_files (
                path, client, length, modified_ticks, processed_offset,
                parser_state_json, last_scanned_ms)
            VALUES (
                $path, $client, $length, $modified_ticks, $processed_offset,
                $parser_state_json, $last_scanned_ms)
            ON CONFLICT(path) DO UPDATE SET
                client = excluded.client,
                length = excluded.length,
                modified_ticks = excluded.modified_ticks,
                processed_offset = excluded.processed_offset,
                parser_state_json = excluded.parser_state_json,
                last_scanned_ms = excluded.last_scanned_ms;
            """;
        upsertSource.Parameters.AddWithValue("$path", source.Path);
        upsertSource.Parameters.AddWithValue("$client", source.Client);
        upsertSource.Parameters.AddWithValue("$length", source.Length);
        upsertSource.Parameters.AddWithValue("$modified_ticks", source.ModifiedTicks);
        upsertSource.Parameters.AddWithValue("$processed_offset", source.ProcessedOffset);
        upsertSource.Parameters.AddWithValue("$parser_state_json", source.ParserStateJson);
        upsertSource.Parameters.AddWithValue("$last_scanned_ms", source.LastScannedMs);
        await upsertSource.ExecuteNonQueryAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<DashboardData> GetDashboardAsync(
        string rangeKey,
        PricingService? pricing = null,
        CancellationToken cancellationToken = default)
    {
        var (startMs, endMs) = ResolveRange(rangeKey);
        await using var connection = await OpenConnectionAsync(cancellationToken);

        var where = BuildWhere(startMs, endMs);
        var totalsCommand = connection.CreateCommand();
        totalsCommand.CommandText = $"""
            SELECT
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(message_count), 0),
                COUNT(*),
                (SELECT COUNT(*) FROM source_files),
                COALESCE(MAX(updated_ms), 0)
            FROM usage_events
            {where};
            """;
        AddRangeParameters(totalsCommand, startMs, endMs);

        UsageTotals totals;
        long lastUpdated;
        await using (var reader = await totalsCommand.ExecuteReaderAsync(cancellationToken))
        {
            await reader.ReadAsync(cancellationToken);
            totals = new UsageTotals(
                reader.GetInt64(0),
                reader.GetInt64(1),
                reader.GetInt64(2),
                reader.GetInt64(3),
                reader.GetInt64(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                reader.GetInt64(7));
            lastUpdated = reader.GetInt64(8);
        }

        var models = new List<ModelUsageRow>();
        var modelCommand = connection.CreateCommand();
        modelCommand.CommandText = $"""
            SELECT client, provider, model,
                   SUM(message_count), SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens)
            FROM usage_events
            {where}
            GROUP BY client, provider, model
            ORDER BY SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) DESC;
            """;
        AddRangeParameters(modelCommand, startMs, endMs);
        await using (var reader = await modelCommand.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                models.Add(new ModelUsageRow(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4),
                    reader.GetInt64(5),
                    reader.GetInt64(6),
                    reader.GetInt64(7),
                    reader.GetInt64(8)));
            }
        }

        var daily = new List<DailyUsageRow>();
        var dailyCommand = connection.CreateCommand();
        dailyCommand.CommandText = $"""
            SELECT strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch', 'localtime') AS day,
                   SUM(message_count), SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens)
            FROM usage_events
            {where}
            GROUP BY day
            ORDER BY day DESC
            LIMIT 120;
            """;
        AddRangeParameters(dailyCommand, startMs, endMs);
        await using (var reader = await dailyCommand.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                daily.Add(new DailyUsageRow(
                    reader.GetString(0),
                    reader.GetInt64(1),
                    reader.GetInt64(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4),
                    reader.GetInt64(5),
                    reader.GetInt64(6)));
            }
        }

        if (pricing is not null)
        {
            (totals, models, daily) = await ApplyCostsAsync(
                connection,
                where,
                startMs,
                endMs,
                totals,
                models,
                daily,
                pricing,
                cancellationToken);
        }

        return new DashboardData(totals, models, daily, lastUpdated);
    }

    private static async Task<(UsageTotals Totals, List<ModelUsageRow> Models, List<DailyUsageRow> Daily)>
        ApplyCostsAsync(
            SqliteConnection connection,
            string where,
            long? startMs,
            long? endMs,
            UsageTotals totals,
            List<ModelUsageRow> models,
            List<DailyUsageRow> daily,
            PricingService pricing,
            CancellationToken cancellationToken)
    {
        var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT client, provider, model, timestamp_ms,
                   input_tokens, output_tokens, cache_read_tokens,
                   cache_write_tokens, reasoning_tokens
            FROM usage_events
            {where};
            """;
        AddRangeParameters(command, startMs, endMs);

        var totalCost = 0d;
        var totalUnpriced = 0L;
        var modelCosts = new Dictionary<(string Client, string Provider, string Model), (double Cost, long Unpriced)>();
        var dailyCosts = new Dictionary<string, (double Cost, long Unpriced)>(StringComparer.Ordinal);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var client = reader.GetString(0);
            var provider = reader.GetString(1);
            var model = reader.GetString(2);
            var timestamp = reader.GetInt64(3);
            var tokens = new TokenBreakdown(
                reader.GetInt64(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                reader.GetInt64(7),
                reader.GetInt64(8));
            var estimate = pricing.Calculate(provider, model, tokens);
            var unpriced = estimate.IsPriced ? 0L : 1L;
            totalCost += estimate.Cost;
            totalUnpriced += unpriced;

            var modelKey = (client, provider, model);
            modelCosts.TryGetValue(modelKey, out var modelCost);
            modelCosts[modelKey] = (modelCost.Cost + estimate.Cost, modelCost.Unpriced + unpriced);

            var day = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime().ToString("yyyy-MM-dd");
            dailyCosts.TryGetValue(day, out var dailyCost);
            dailyCosts[day] = (dailyCost.Cost + estimate.Cost, dailyCost.Unpriced + unpriced);
        }

        totals = totals with { EstimatedCost = totalCost, UnpricedEvents = totalUnpriced };
        models = models
            .Select(row =>
            {
                modelCosts.TryGetValue((row.Client, row.Provider, row.Model), out var cost);
                return row with { EstimatedCost = cost.Cost, UnpricedEvents = cost.Unpriced };
            })
            .OrderByDescending(row => row.EstimatedCost)
            .ThenByDescending(row => row.Total)
            .ToList();
        daily = daily
            .Select(row =>
            {
                dailyCosts.TryGetValue(row.Date, out var cost);
                return row with { EstimatedCost = cost.Cost, UnpricedEvents = cost.Unpriced };
            })
            .ToList();

        return (totals, models, daily);
    }

    private async Task<SqliteConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA busy_timeout = 5000;";
        await pragma.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }

    private static (long? StartMs, long? EndMs) ResolveRange(string key)
    {
        var now = DateTimeOffset.Now;
        var today = new DateTimeOffset(now.Year, now.Month, now.Day, 0, 0, 0, now.Offset);
        var month = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, now.Offset);

        return key switch
        {
            "today" => (today.ToUnixTimeMilliseconds(), today.AddDays(1).ToUnixTimeMilliseconds()),
            "last24" => (now.AddHours(-24).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last7" => (now.AddDays(-7).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last30" => (now.AddDays(-30).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "previousMonth" => (month.AddMonths(-1).ToUnixTimeMilliseconds(), month.ToUnixTimeMilliseconds()),
            "all" => (null, null),
            _ => (month.ToUnixTimeMilliseconds(), month.AddMonths(1).ToUnixTimeMilliseconds())
        };
    }

    private static string BuildWhere(long? startMs, long? endMs)
    {
        if (startMs is null && endMs is null)
        {
            return string.Empty;
        }

        if (endMs is null)
        {
            return "WHERE timestamp_ms >= $start";
        }

        return "WHERE timestamp_ms >= $start AND timestamp_ms < $end";
    }

    private static void AddRangeParameters(SqliteCommand command, long? startMs, long? endMs)
    {
        if (startMs is not null)
        {
            command.Parameters.AddWithValue("$start", startMs.Value);
        }

        if (endMs is not null)
        {
            command.Parameters.AddWithValue("$end", endMs.Value);
        }
    }
}
