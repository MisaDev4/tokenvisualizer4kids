namespace TokenTracker;

public sealed record TokenBreakdown(
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    long Reasoning,
    long CacheWrite1h = 0)
{
    // Reasoning is included in the provider-reported output token count.
    public long Total => checked(Input + Output + CacheRead + CacheWrite);

    /// <summary>The slice of <see cref="CacheWrite"/> written with a 5-minute TTL.
    /// Anthropic charges the two TTLs at different rates (1.25x base input for 5m,
    /// 2x for 1h), so they can't be billed as one number.</summary>
    public long CacheWrite5m => Math.Max(0, CacheWrite - CacheWrite1h);

    public bool IsEmpty => Input == 0 && Output == 0 && CacheRead == 0 && CacheWrite == 0 && Reasoning == 0;
}

public sealed record UsageEvent(
    string EventKey,
    string SourcePath,
    string Client,
    string Provider,
    string Model,
    string SessionId,
    long TimestampMs,
    TokenBreakdown Tokens,
    int MessageCount = 1);

public sealed record SourceFileState(
    string Path,
    string Client,
    long Length,
    long ModifiedTicks,
    long ProcessedOffset,
    string ParserStateJson,
    long LastScannedMs);

public sealed record ParseResult(
    IReadOnlyList<UsageEvent> Events,
    long ProcessedOffset,
    string ParserStateJson);

public sealed record UsageTotals(
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    long Reasoning,
    long Messages,
    long EventCount,
    long SourceCount)
{
    public long Total => checked(Input + Output + CacheRead + CacheWrite);

    public double EstimatedCost { get; init; }

    public long UnpricedEvents { get; init; }
}

public sealed record ModelUsageRow(
    string Client,
    string Provider,
    string Model,
    long Messages,
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    long Reasoning)
{
    public long Total => checked(Input + Output + CacheRead + CacheWrite);

    public double EstimatedCost { get; init; }

    public long UnpricedEvents { get; init; }
}

/// <summary>Granularity of one timeline bucket.</summary>
public enum BucketUnit
{
    Second7_5,
    Second15,
    Second30,
    Minute1,
    Minute5,
    Minute15,
    Minute30,
    Hour,
    Hour4,
    Hour12,
    Day,
    Month
}

/// <summary>Per-model share of a single timeline bucket.</summary>
public sealed record BucketModelSlice(string Model, double Cost, long Tokens, long Messages);

/// <summary>One local calendar day's total, for the daily activity grid.</summary>
public sealed record DailyUsageRow(string Day, long Tokens, double Cost);

/// <summary>One usage event as fed to the insights engine.</summary>
public sealed record InsightEventRow(
    string Client,
    string Provider,
    string Model,
    string SessionId,
    long TimestampMs,
    TokenBreakdown Tokens);

/// <summary>
/// One indexed usage event as surfaced to the live view. UpdatedMs is when the
/// collector last wrote the row, which for live tailing is within ~a second of
/// the response itself and keeps growing while output streams into the message.
/// </summary>
public sealed record LiveEventRow(
    string EventKey,
    string Client,
    string Provider,
    string Model,
    string SessionId,
    long TimestampMs,
    long UpdatedMs,
    TokenBreakdown Tokens,
    long Messages);

/// <summary>
/// One contiguous slice of the timeline. Buckets are gap-filled, so a range
/// always yields an unbroken ascending series even for silent hours/days.
/// </summary>
public sealed record UsageBucket(
    long StartMs,
    long Messages,
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    long Reasoning)
{
    public long Total => checked(Input + Output + CacheRead + CacheWrite);

    public double EstimatedCost { get; init; }

    public long UnpricedEvents { get; init; }

    public IReadOnlyList<BucketModelSlice> Slices { get; init; } = [];

    public DateTime LocalStart => DateTimeOffset.FromUnixTimeMilliseconds(StartMs).ToLocalTime().DateTime;
}

public sealed record DashboardData(
    UsageTotals Totals,
    IReadOnlyList<ModelUsageRow> Models,
    IReadOnlyList<UsageBucket> Buckets,
    BucketUnit Unit,
    long LastUpdatedMs)
{
    /// <summary>Where the range actually began, unrounded — for the Session
    /// range this is the session's first event, which no other field carries
    /// (bucket starts are floored to the bar size). Null for open-ended ranges
    /// like All, and when a session range found no data at all.</summary>
    public long? RangeStartMs { get; init; }
}

public sealed record CollectorProgress(
    string Activity,
    int Current,
    int Total,
    string? CurrentFile = null,
    bool IsBusy = true);

public sealed record IntervalChoice(int Seconds, string Label)
{
    public override string ToString() => Label;
}
