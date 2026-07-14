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

public sealed record DailyUsageRow(
    string Date,
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

public sealed record DashboardData(
    UsageTotals Totals,
    IReadOnlyList<ModelUsageRow> Models,
    IReadOnlyList<DailyUsageRow> Daily,
    long LastUpdatedMs);

public sealed record CollectorProgress(
    string Activity,
    int Current,
    int Total,
    string? CurrentFile = null,
    bool IsBusy = true);

public sealed record DateRangeChoice(string Key, string Label)
{
    public override string ToString() => Label;
}

public sealed record IntervalChoice(int Seconds, string Label)
{
    public override string ToString() => Label;
}
