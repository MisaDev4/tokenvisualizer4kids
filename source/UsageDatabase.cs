using Microsoft.Data.Sqlite;

namespace TokenTracker;

public sealed class UsageDatabase
{
    private const int MaxBuckets = 500;

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
        BucketUnit? unitOverride = null,
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
                COALESCE(MAX(updated_ms), 0),
                COALESCE(MIN(timestamp_ms), 0),
                COALESCE(MAX(timestamp_ms), 0)
            FROM usage_events
            {where};
            """;
        AddRangeParameters(totalsCommand, startMs, endMs);

        UsageTotals totals;
        long lastUpdated;
        long firstEventMs;
        long lastEventMs;
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
            firstEventMs = reader.GetInt64(9);
            lastEventMs = reader.GetInt64(10);
        }

        var unit = ResolveEffectiveUnit(rangeKey, unitOverride, startMs ?? firstEventMs, endMs, lastEventMs);

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

        var bucketRows = new Dictionary<string, UsageBucket>(StringComparer.Ordinal);
        var bucketCommand = connection.CreateCommand();
        bucketCommand.CommandText = $"""
            SELECT {BucketExpression(unit)} AS period,
                   SUM(message_count), SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens)
            FROM usage_events
            {where}
            GROUP BY period;
            """;
        AddRangeParameters(bucketCommand, startMs, endMs);
        await using (var reader = await bucketCommand.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                bucketRows[reader.GetString(0)] = new UsageBucket(
                    0,
                    reader.GetInt64(1),
                    reader.GetInt64(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4),
                    reader.GetInt64(5),
                    reader.GetInt64(6));
            }
        }

        double? previousCost = null;
        if (pricing is not null)
        {
            (totals, models, bucketRows) = await ApplyCostsAsync(
                connection,
                where,
                startMs,
                endMs,
                totals,
                models,
                bucketRows,
                pricing,
                unit,
                cancellationToken);

            if (ResolvePreviousRange(rangeKey) is { } previousRange)
            {
                previousCost = await ComputeCostAsync(
                    connection, previousRange.StartMs, previousRange.EndMs, pricing, cancellationToken);
            }
        }

        var buckets = FillBuckets(bucketRows, unit, startMs ?? firstEventMs, endMs);
        return new DashboardData(totals, models, buckets, unit, lastUpdated)
        {
            PreviousCost = previousCost
        };
    }

    private static async Task<(UsageTotals Totals, List<ModelUsageRow> Models, Dictionary<string, UsageBucket> Buckets)>
        ApplyCostsAsync(
            SqliteConnection connection,
            string where,
            long? startMs,
            long? endMs,
            UsageTotals totals,
            List<ModelUsageRow> models,
            Dictionary<string, UsageBucket> buckets,
            PricingService pricing,
            BucketUnit unit,
            CancellationToken cancellationToken)
    {
        var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT client, provider, model, timestamp_ms,
                   input_tokens, output_tokens, cache_read_tokens,
                   cache_write_tokens, reasoning_tokens, message_count
            FROM usage_events
            {where};
            """;
        AddRangeParameters(command, startMs, endMs);

        var totalCost = 0d;
        var totalUnpriced = 0L;
        var modelCosts = new Dictionary<(string Client, string Provider, string Model), (double Cost, long Unpriced)>();
        var bucketCosts = new Dictionary<string, (double Cost, long Unpriced)>(StringComparer.Ordinal);
        var bucketSlices = new Dictionary<string, Dictionary<string, (double Cost, long Tokens, long Messages)>>(StringComparer.Ordinal);

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
            var messages = reader.GetInt64(9);
            var estimate = pricing.Calculate(provider, model, tokens);
            var unpriced = estimate.IsPriced ? 0L : 1L;
            totalCost += estimate.Cost;
            totalUnpriced += unpriced;

            var modelKey = (client, provider, model);
            modelCosts.TryGetValue(modelKey, out var modelCost);
            modelCosts[modelKey] = (modelCost.Cost + estimate.Cost, modelCost.Unpriced + unpriced);

            var bucketKey = BucketKey(timestamp, unit);
            bucketCosts.TryGetValue(bucketKey, out var bucketCost);
            bucketCosts[bucketKey] = (bucketCost.Cost + estimate.Cost, bucketCost.Unpriced + unpriced);

            if (!bucketSlices.TryGetValue(bucketKey, out var slices))
            {
                bucketSlices[bucketKey] = slices = new Dictionary<string, (double, long, long)>(StringComparer.OrdinalIgnoreCase);
            }

            slices.TryGetValue(model, out var slice);
            slices[model] = (slice.Cost + estimate.Cost, slice.Tokens + tokens.Total, slice.Messages + messages);
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
        buckets = buckets.ToDictionary(
            pair => pair.Key,
            pair =>
            {
                bucketCosts.TryGetValue(pair.Key, out var cost);
                var slices = bucketSlices.TryGetValue(pair.Key, out var byModel)
                    ? byModel
                        .Select(item => new BucketModelSlice(item.Key, item.Value.Cost, item.Value.Tokens, item.Value.Messages))
                        .OrderByDescending(slice => slice.Cost)
                        .ToList()
                    : [];
                return pair.Value with
                {
                    EstimatedCost = cost.Cost,
                    UnpricedEvents = cost.Unpriced,
                    Slices = slices
                };
            },
            StringComparer.Ordinal);

        return (totals, models, buckets);
    }

    /// <summary>
    /// Newest events indexed after <paramref name="sinceUpdatedMs"/>, ascending.
    /// The limit keeps a full rescan (which re-stamps every row) from flooding
    /// the live view with ancient history.
    /// </summary>
    public async Task<List<LiveEventRow>> GetEventsUpdatedSinceAsync(
        long sinceUpdatedMs,
        int limit = 400,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            SELECT event_key, client, provider, model, session_id, timestamp_ms, updated_ms,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, message_count
            FROM usage_events
            WHERE updated_ms > $since
            ORDER BY updated_ms DESC
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$since", sinceUpdatedMs);
        command.Parameters.AddWithValue("$limit", limit);

        var rows = new List<LiveEventRow>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new LiveEventRow(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                new TokenBreakdown(
                    reader.GetInt64(7),
                    reader.GetInt64(8),
                    reader.GetInt64(9),
                    reader.GetInt64(10),
                    reader.GetInt64(11)),
                reader.GetInt64(12)));
        }

        rows.Reverse();
        return rows;
    }

    /// <summary>Events by when they happened (not when they were indexed):
    /// this is what lets the live views backfill real history.</summary>
    public async Task<List<LiveEventRow>> GetEventsInRangeAsync(
        long startTimestampMs,
        long endTimestampMs,
        int limit = 2000,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var command = connection.CreateCommand();
        command.CommandText = """
            SELECT event_key, client, provider, model, session_id, timestamp_ms, updated_ms,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, message_count
            FROM usage_events
            WHERE timestamp_ms >= $start AND timestamp_ms < $end
            ORDER BY timestamp_ms DESC
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$start", startTimestampMs);
        command.Parameters.AddWithValue("$end", endTimestampMs);
        command.Parameters.AddWithValue("$limit", limit);

        var rows = new List<LiveEventRow>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new LiveEventRow(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetInt64(5),
                reader.GetInt64(6),
                new TokenBreakdown(
                    reader.GetInt64(7),
                    reader.GetInt64(8),
                    reader.GetInt64(9),
                    reader.GetInt64(10),
                    reader.GetInt64(11)),
                reader.GetInt64(12)));
        }

        rows.Reverse();
        return rows;
    }

    private static async Task<double> ComputeCostAsync(
        SqliteConnection connection,
        long startMs,
        long endMs,
        PricingService pricing,
        CancellationToken cancellationToken)
    {
        var command = connection.CreateCommand();
        command.CommandText = """
            SELECT provider, model, input_tokens, output_tokens,
                   cache_read_tokens, cache_write_tokens, reasoning_tokens
            FROM usage_events
            WHERE timestamp_ms >= $start AND timestamp_ms < $end;
            """;
        command.Parameters.AddWithValue("$start", startMs);
        command.Parameters.AddWithValue("$end", endMs);

        var cost = 0d;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var tokens = new TokenBreakdown(
                reader.GetInt64(2),
                reader.GetInt64(3),
                reader.GetInt64(4),
                reader.GetInt64(5),
                reader.GetInt64(6));
            cost += pricing.Calculate(reader.GetString(0), reader.GetString(1), tokens).Cost;
        }

        return cost;
    }

    /// <summary>
    /// Expands sparse bucket rows into an unbroken ascending series covering the whole
    /// range, so quiet hours/days render as true zeros instead of disappearing.
    /// </summary>
    private static List<UsageBucket> FillBuckets(
        Dictionary<string, UsageBucket> rows,
        BucketUnit unit,
        long startMs,
        long? endMs)
    {
        var result = new List<UsageBucket>();
        if (startMs <= 0 && rows.Count == 0)
        {
            return result;
        }

        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        var effectiveEnd = Math.Min(endMs ?? nowMs, nowMs);
        if (startMs <= 0 || startMs > effectiveEnd)
        {
            return result;
        }

        var duration = UnitDurationMs(unit);
        if (duration > 0)
        {
            var cursorMs = startMs / duration * duration;
            while (result.Count < MaxBuckets && cursorMs <= effectiveEnd)
            {
                var key = cursorMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
                result.Add(rows.TryGetValue(key, out var minuteRow)
                    ? minuteRow with { StartMs = cursorMs }
                    : new UsageBucket(cursorMs, 0, 0, 0, 0, 0, 0));
                cursorMs += duration;
            }

            return result;
        }

        var keyFormat = BucketKeyFormat(unit);
        var cursor = FloorToUnit(DateTimeOffset.FromUnixTimeMilliseconds(startMs).ToLocalTime().DateTime, unit);
        while (result.Count < MaxBuckets)
        {
            var bucketStartMs = ToUnixMs(cursor);
            if (bucketStartMs > effectiveEnd)
            {
                break;
            }

            var key = cursor.ToString(keyFormat, System.Globalization.CultureInfo.InvariantCulture);
            result.Add(rows.TryGetValue(key, out var row)
                ? row with { StartMs = bucketStartMs }
                : new UsageBucket(bucketStartMs, 0, 0, 0, 0, 0, 0));
            cursor = Advance(cursor, unit);
        }

        return result;
    }

    private static string BucketKey(long timestampMs, BucketUnit unit)
    {
        var duration = UnitDurationMs(unit);
        return duration > 0
            ? (timestampMs / duration * duration).ToString(System.Globalization.CultureInfo.InvariantCulture)
            : DateTimeOffset.FromUnixTimeMilliseconds(timestampMs).ToLocalTime()
                .ToString(BucketKeyFormat(unit), System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Honors an explicit bar-size choice but coarsens it until the series fits
    /// under <see cref="MaxBuckets"/>; a too-fine unit would otherwise silently
    /// truncate the newest bars when the fill loop hits the cap.
    /// </summary>
    private static BucketUnit ResolveEffectiveUnit(
        string rangeKey,
        BucketUnit? requested,
        long startMs,
        long? endMs,
        long lastEventMs)
    {
        if (requested is not { } unit)
        {
            return ResolveBucketUnit(rangeKey, startMs, endMs, lastEventMs);
        }

        var end = Math.Min(
            endMs ?? long.MaxValue,
            DateTimeOffset.Now.ToUnixTimeMilliseconds());
        var spanMs = startMs > 0 && end > startMs ? end - startMs : 0;
        while (unit < BucketUnit.Month && spanMs / ApproximateUnitMs(unit) > MaxBuckets)
        {
            unit++;
        }

        return unit;
    }

    /// <summary>Typical bucket width, used only to estimate series length.</summary>
    private static double ApproximateUnitMs(BucketUnit unit) => unit switch
    {
        BucketUnit.Second15 => 15_000,
        BucketUnit.Second30 => 30_000,
        BucketUnit.Minute1 => 60_000,
        BucketUnit.Minute5 => 300_000,
        BucketUnit.Minute15 => 900_000,
        BucketUnit.Minute30 => 1_800_000,
        BucketUnit.Hour => 3_600_000,
        BucketUnit.Day => 86_400_000,
        _ => 2_592_000_000
    };

    private static BucketUnit ResolveBucketUnit(string rangeKey, long startMs, long? endMs, long lastEventMs)
    {
        if (rangeKey is "last1")
        {
            return BucketUnit.Minute1;
        }

        if (rangeKey is "last4")
        {
            return BucketUnit.Minute15;
        }

        if (rangeKey is "last8" or "last12" or "last24" or "today")
        {
            return BucketUnit.Hour;
        }

        if (rangeKey is not "all")
        {
            return BucketUnit.Day;
        }

        var end = endMs ?? Math.Max(lastEventMs, DateTimeOffset.Now.ToUnixTimeMilliseconds());
        var spanDays = startMs > 0 ? (end - startMs) / 86_400_000d : 0;
        return spanDays > 180 ? BucketUnit.Month : BucketUnit.Day;
    }

    /// <summary>Fixed bucket duration for epoch-aligned units; 0 for calendar units.</summary>
    private static long UnitDurationMs(BucketUnit unit) => unit switch
    {
        BucketUnit.Second15 => 15_000,
        BucketUnit.Second30 => 30_000,
        BucketUnit.Minute1 => 60_000,
        BucketUnit.Minute5 => 300_000,
        BucketUnit.Minute15 => 900_000,
        BucketUnit.Minute30 => 1_800_000,
        _ => 0
    };

    private static string BucketExpression(BucketUnit unit)
    {
        // Sub-hour buckets are aligned on epoch ms; every UTC offset is a multiple of 15 minutes,
        // so the boundaries land on local clock marks too.
        var duration = UnitDurationMs(unit);
        if (duration > 0)
        {
            return $"CAST(timestamp_ms / {duration} * {duration} AS TEXT)";
        }

        return unit switch
        {
            BucketUnit.Hour => "strftime('%Y-%m-%d %H:00', timestamp_ms / 1000, 'unixepoch', 'localtime')",
            BucketUnit.Month => "strftime('%Y-%m', timestamp_ms / 1000, 'unixepoch', 'localtime')",
            _ => "strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch', 'localtime')"
        };
    }

    private static string BucketKeyFormat(BucketUnit unit) => unit switch
    {
        BucketUnit.Hour => "yyyy-MM-dd HH:00",
        BucketUnit.Month => "yyyy-MM",
        _ => "yyyy-MM-dd"
    };

    private static DateTime FloorToUnit(DateTime value, BucketUnit unit) => unit switch
    {
        BucketUnit.Hour => new DateTime(value.Year, value.Month, value.Day, value.Hour, 0, 0),
        BucketUnit.Month => new DateTime(value.Year, value.Month, 1),
        _ => value.Date
    };

    private static DateTime Advance(DateTime value, BucketUnit unit) => unit switch
    {
        BucketUnit.Hour => value.AddHours(1),
        BucketUnit.Month => value.AddMonths(1),
        _ => value.AddDays(1)
    };

    private static long ToUnixMs(DateTime local) =>
        new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local)).ToUnixTimeMilliseconds();

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
            "last1" => (now.AddHours(-1).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last4" => (now.AddHours(-4).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last8" => (now.AddHours(-8).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last12" => (now.AddHours(-12).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "today" => (today.ToUnixTimeMilliseconds(), today.AddDays(1).ToUnixTimeMilliseconds()),
            "last24" => (now.AddHours(-24).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last7" => (now.AddDays(-7).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "last30" => (now.AddDays(-30).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()),
            "previousMonth" => (month.AddMonths(-1).ToUnixTimeMilliseconds(), month.ToUnixTimeMilliseconds()),
            "all" => (null, null),
            _ => (month.ToUnixTimeMilliseconds(), month.AddMonths(1).ToUnixTimeMilliseconds())
        };
    }

    /// <summary>The equivalent preceding window (same length, ending where the current one starts).</summary>
    private static (long StartMs, long EndMs)? ResolvePreviousRange(string key)
    {
        var now = DateTimeOffset.Now;
        var today = new DateTimeOffset(now.Year, now.Month, now.Day, 0, 0, 0, now.Offset);
        var month = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, now.Offset);

        return key switch
        {
            "last1" => (now.AddHours(-2).ToUnixTimeMilliseconds(), now.AddHours(-1).ToUnixTimeMilliseconds()),
            "last4" => (now.AddHours(-8).ToUnixTimeMilliseconds(), now.AddHours(-4).ToUnixTimeMilliseconds()),
            "last8" => (now.AddHours(-16).ToUnixTimeMilliseconds(), now.AddHours(-8).ToUnixTimeMilliseconds()),
            "last12" => (now.AddHours(-24).ToUnixTimeMilliseconds(), now.AddHours(-12).ToUnixTimeMilliseconds()),
            "today" => (today.AddDays(-1).ToUnixTimeMilliseconds(), now.AddDays(-1).ToUnixTimeMilliseconds()),
            "last24" => (now.AddHours(-48).ToUnixTimeMilliseconds(), now.AddHours(-24).ToUnixTimeMilliseconds()),
            "last7" => (now.AddDays(-14).ToUnixTimeMilliseconds(), now.AddDays(-7).ToUnixTimeMilliseconds()),
            "last30" => (now.AddDays(-60).ToUnixTimeMilliseconds(), now.AddDays(-30).ToUnixTimeMilliseconds()),
            "currentMonth" => (month.AddMonths(-1).ToUnixTimeMilliseconds(), now.AddMonths(-1).ToUnixTimeMilliseconds()),
            "previousMonth" => (month.AddMonths(-2).ToUnixTimeMilliseconds(), month.AddMonths(-1).ToUnixTimeMilliseconds()),
            _ => null
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
