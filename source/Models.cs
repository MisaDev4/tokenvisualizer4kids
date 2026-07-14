namespace TokenTracker;

public sealed record TokenBreakdown(
    long Input,
    long Output,
    long CacheRead,
    long CacheWrite,
    long Reasoning)
{
    // Reasoning is included in the provider-reported output token count.
    public long Total => checked(Input + Output + CacheRead + CacheWrite);

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
    Second15,
    Second30,
    Minute1,
    Minute5,
    Minute15,
    Minute30,
    Hour,
    Day,
    Month
}

/// <summary>Per-model share of a single timeline bucket.</summary>
public sealed record BucketModelSlice(string Model, double Cost, long Tokens, long Messages);

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
    /// <summary>Estimated cost of the equivalent preceding window; null when not comparable (e.g. all time).</summary>
    public double? PreviousCost { get; init; }
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
