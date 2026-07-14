using System.Globalization;

namespace TokenTracker;

/// <summary>Flavor of one insight card: a saving to capture, a pattern worth knowing, or good news.</summary>
public enum InsightKind
{
    Saving,
    Note,
    Good
}

/// <summary>One rule-based finding, fully worded and ready to render.</summary>
public sealed record InsightTip(InsightKind Kind, string Title, string Body, string Figure);

/// <summary>Cost carried by replies whose context fell inside one size band.</summary>
public sealed record ContextBand(string Label, long Events, double Cost, double ShareOfCost);

public sealed record InsightsReport(
    int Events,
    int Sessions,
    double TotalCost,
    double InputCost,
    double OutputCost,
    double CacheReadCost,
    double CacheWriteCost,
    long InputTokens,
    long OutputTokens,
    long ReasoningTokens,
    long CacheReadTokens,
    long CacheWriteTokens,
    IReadOnlyList<ContextBand> ContextBands,
    IReadOnlyList<InsightTip> Tips);

/// <summary>
/// Turns raw usage events into the insights page: a decomposition of where the
/// money went, and a set of rules that only speak up when this machine's usage
/// actually shows the pattern. Costs are estimated API list prices throughout —
/// for subscription plans they measure limit pressure and plan value, not a bill.
/// </summary>
public static class InsightsEngine
{
    private static readonly CultureInfo Usd = CultureInfo.GetCultureInfo("en-US");

    /// <summary>Anthropic bills premium rates above 200k context; OpenAI above 272k.</summary>
    private const long PremiumContext = 200_000;
    private const long GapRewarmMs = 5 * 60_000;

    private static readonly (string Label, long UpTo)[] BandEdges =
    [
        ("under 20k", 20_000),
        ("20–50k", 50_000),
        ("50–100k", 100_000),
        ("100–150k", 150_000),
        ("150–200k", 200_000),
        ("over 200k", long.MaxValue)
    ];

    public static InsightsReport Compute(
        IReadOnlyList<InsightEventRow> events,
        PricingService pricing,
        int rangeDays,
        double? planMonthlyUsd)
    {
        double inputCost = 0, outputCost = 0, cacheReadCost = 0, cacheWriteCost = 0;
        long inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
        var bandCost = new double[BandEdges.Length];
        var bandEvents = new long[BandEdges.Length];
        double premiumCost = 0;
        long premiumEvents = 0, premiumMaxContext = 0;
        double rewarmCost = 0;
        long rewarmEvents = 0, rewarmTokens = 0;
        double cacheSavings = 0;
        double reasoningCost = 0;
        double subscriptionClaudeCost = 0;
        var sessions = new Dictionary<string, (double Cost, long MaxContext, long LastMs)>(StringComparer.Ordinal);
        var models = new Dictionary<string, (double Cost, long Tokens)>(StringComparer.OrdinalIgnoreCase);
        var dayCosts = new Dictionary<DateTime, double>();

        foreach (var ev in events)
        {
            var t = ev.Tokens;
            var cost = pricing.Calculate(ev.Provider, ev.Model, t).Cost;

            // Component decomposition: price each component alone, then scale so
            // the parts sum exactly to the real (tier-aware) total.
            var cIn = ComponentCost(pricing, ev, t.Input, 0, 0, 0);
            var cOut = ComponentCost(pricing, ev, 0, t.Output, 0, 0);
            var cRead = ComponentCost(pricing, ev, 0, 0, t.CacheRead, 0);
            var cWrite = ComponentCost(pricing, ev, 0, 0, 0, t.CacheWrite);
            var sum = cIn + cOut + cRead + cWrite;
            if (sum > 0)
            {
                var scale = cost / sum;
                cIn *= scale;
                cOut *= scale;
                cRead *= scale;
                cWrite *= scale;
            }

            inputCost += cIn;
            outputCost += cOut;
            cacheReadCost += cRead;
            cacheWriteCost += cWrite;
            inputTokens += t.Input;
            outputTokens += t.Output;
            reasoningTokens += t.Reasoning;
            cacheReadTokens += t.CacheRead;
            cacheWriteTokens += t.CacheWrite;

            var context = t.Input + t.CacheRead + t.CacheWrite;
            var band = BandIndex(context);
            bandCost[band] += cost;
            bandEvents[band]++;

            // The surcharge actually paid for crossing a long-context price line:
            // the same tokens re-priced in chunks small enough to stay at base rates.
            if (context > 128_000)
            {
                premiumCost += Math.Max(0, cost - BaseRateCost(pricing, ev, t));
                if (context > PremiumContext)
                {
                    premiumEvents++;
                    premiumMaxContext = Math.Max(premiumMaxContext, context);
                }
            }

            if (t.Output > 0 && t.Reasoning > 0)
            {
                reasoningCost += cOut * (t.Reasoning / (double)t.Output);
            }

            // What the cached prompt tokens would have cost as plain input, minus
            // what reading (and writing) the cache cost instead.
            if (t.CacheRead > 0)
            {
                cacheSavings += ComponentCost(pricing, ev, t.CacheRead, 0, 0, 0) - cRead;
            }

            if (t.CacheWrite > 0)
            {
                cacheSavings -= Math.Max(0, cWrite - ComponentCost(pricing, ev, t.CacheWrite, 0, 0, 0));
            }

            if (ev is { Client: "claude", Provider: "anthropic" })
            {
                subscriptionClaudeCost += cost;
            }

            var session = sessions.GetValueOrDefault(ev.SessionId);
            if (session.LastMs > 0 && ev.TimestampMs - session.LastMs > GapRewarmMs && t.CacheWrite > 0)
            {
                rewarmCost += cWrite;
                rewarmTokens += t.CacheWrite;
                rewarmEvents++;
            }

            sessions[ev.SessionId] = (
                session.Cost + cost,
                Math.Max(session.MaxContext, context),
                ev.TimestampMs);

            var modelTotal = models.GetValueOrDefault(ev.Model);
            models[ev.Model] = (modelTotal.Cost + cost, modelTotal.Tokens + t.Total);

            var day = DateTimeOffset.FromUnixTimeMilliseconds(ev.TimestampMs).ToLocalTime().Date;
            dayCosts[day] = dayCosts.GetValueOrDefault(day) + cost;
        }

        var totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
        var bands = BandEdges
            .Select((edge, index) => new ContextBand(
                edge.Label,
                bandEvents[index],
                bandCost[index],
                totalCost > 0 ? bandCost[index] / totalCost : 0))
            .ToList();

        var tips = BuildTips(
            totalCost, inputCost, outputCost, cacheReadCost, cacheWriteCost,
            inputTokens, outputTokens, reasoningTokens, cacheReadTokens,
            premiumCost, premiumEvents, premiumMaxContext,
            rewarmCost, rewarmEvents, rewarmTokens,
            cacheSavings, reasoningCost, subscriptionClaudeCost,
            sessions, models, dayCosts, rangeDays, planMonthlyUsd);

        return new InsightsReport(
            events.Count,
            sessions.Count,
            totalCost,
            inputCost, outputCost, cacheReadCost, cacheWriteCost,
            inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
            bands,
            tips);
    }

    private static List<InsightTip> BuildTips(
        double totalCost, double inputCost, double outputCost, double cacheReadCost, double cacheWriteCost,
        long inputTokens, long outputTokens, long reasoningTokens, long cacheReadTokens,
        double premiumCost, long premiumEvents, long premiumMaxContext,
        double rewarmCost, long rewarmEvents, long rewarmTokens,
        double cacheSavings, double reasoningCost, double subscriptionClaudeCost,
        Dictionary<string, (double Cost, long MaxContext, long LastMs)> sessions,
        Dictionary<string, (double Cost, long Tokens)> models,
        Dictionary<DateTime, double> dayCosts,
        int rangeDays,
        double? planMonthlyUsd)
    {
        var tips = new List<(InsightTip Tip, double Weight)>();
        if (totalCost <= 0)
        {
            return [];
        }

        // Context re-reads dominating the bill — the structural insight.
        var contextCost = inputCost + cacheReadCost;
        var contextShare = contextCost / totalCost;
        if (contextShare >= 0.5 && totalCost >= 1)
        {
            var readShare = cacheReadCost / totalCost;
            tips.Add((new InsightTip(
                InsightKind.Saving,
                $"Re-reading context is {contextShare:P0} of your spend",
                $"Every reply re-reads the whole conversation — history, files, tool output — so the same tokens " +
                $"bill again and again: {Money(cacheReadCost)} in cache reads ({readShare:P0}) plus {Money(inputCost)} " +
                $"in uncached input. Output, the text actually produced, is only {outputCost / totalCost:P0}. " +
                "The lever is context, not verbosity: finish a task and start the next in a fresh session, " +
                "/clear between unrelated tasks, and /compact a long session instead of pushing it further.",
                Money(contextCost)), contextCost));
        }

        // Surcharge for crossing a long-context price line (200k Anthropic, 272k OpenAI).
        if (premiumCost >= Math.Max(1, totalCost * 0.01))
        {
            tips.Add((new InsightTip(
                InsightKind.Saving,
                "Long-context surcharges are on your bill",
                $"{Plural(premiumEvents, "reply", "replies")} ran with more than 200k tokens of context " +
                $"(the biggest at {Tokens(premiumMaxContext)}), and providers price tokens beyond their long-context " +
                $"line — 200k on Claude, 272k on OpenAI — at up to double rate. That surcharge came to {Money(premiumCost)} " +
                "in this range. Splitting work or compacting before a session crosses the line avoids it entirely; " +
                "on subscription plans oversized context also drains rate limits faster.",
                Money(premiumCost)), premiumCost));
        }

        // A handful of marathon sessions carrying the bill.
        if (sessions.Count >= 10)
        {
            var ordered = sessions.Values.OrderByDescending(session => session.Cost).ToList();
            var topCount = Math.Max(1, sessions.Count / 10);
            var topCost = ordered.Take(topCount).Sum(session => session.Cost);
            var topShare = topCost / totalCost;
            if (topShare >= 0.35)
            {
                var biggest = ordered[0];
                tips.Add((new InsightTip(
                    InsightKind.Note,
                    $"{Plural(topCount, "session")} — the top 10% — carry {topShare:P0} of the bill",
                    $"Your biggest session alone cost {Money(biggest.Cost)} and peaked at {Tokens(biggest.MaxContext)} " +
                    $"of context; the median session cost {Money(ordered[ordered.Count / 2].Cost)}. Cost per reply grows " +
                    "with everything that came before it, so marathon sessions get more expensive as they run. " +
                    "The savings live in splitting those, not in trimming the small ones.",
                    Money(topCost)), topCost * 0.1));
            }
        }

        // Cache re-warms after breaks longer than the cache's ~5 minute lifetime.
        if (rewarmCost >= 1)
        {
            tips.Add((new InsightTip(
                InsightKind.Saving,
                "Pauses over 5 minutes re-warm the prompt cache",
                $"Prompt caches expire after about five idle minutes. {Plural(rewarmEvents, "reply", "replies")} came " +
                $"back to a session after a longer pause and re-wrote {Tokens(rewarmTokens)} of cache for {Money(rewarmCost)}. " +
                "Keeping quick follow-ups together — or letting an idle session go instead of reviving it — avoids the re-warm.",
                Money(rewarmCost)), rewarmCost));
        }

        // Cache health, whichever way it leans.
        var promptTokens = inputTokens + cacheReadTokens;
        var hitRate = promptTokens > 0 ? cacheReadTokens / (double)promptTokens : 0;
        if (hitRate < 0.6 && inputTokens >= 5_000_000)
        {
            tips.Add((new InsightTip(
                InsightKind.Saving,
                $"Only {hitRate:P0} of prompt tokens came from cache",
                $"{Tokens(inputTokens)} of prompt went through at the full input rate ({Money(inputCost)}). Cached " +
                "reads cost about a tenth of that, so misses usually mean something keeps invalidating the prefix — " +
                "a system prompt that changes per request, or many short one-off sessions. Anything stable belongs " +
                "at the front of the prompt, and related questions belong in one session.",
                Money(inputCost)), inputCost));
        }
        else if (hitRate >= 0.9 && cacheSavings >= 10)
        {
            tips.Add((new InsightTip(
                InsightKind.Good,
                $"Prompt caching saved you {Money(cacheSavings)}",
                $"{hitRate:P0} of prompt tokens were cache hits, billed at roughly a tenth of the input rate. " +
                $"Without caching, this range would have cost about {Money(totalCost + cacheSavings)} instead of " +
                $"{Money(totalCost)} — the cache is doing its job; the tips above are about carrying less context, " +
                "which shrinks even the cached re-reads.",
                Money(cacheSavings)), 0.2));
        }

        // Invisible reasoning tokens inside output.
        if (outputTokens > 0 && reasoningTokens >= outputTokens / 5 && reasoningCost >= 1)
        {
            tips.Add((new InsightTip(
                InsightKind.Note,
                $"{reasoningTokens / (double)outputTokens:P0} of output tokens are hidden reasoning",
                $"Models that think before answering billed about {Money(reasoningCost)} of reasoning you never see " +
                $"({Tokens(reasoningTokens)}, priced at the full output rate). For routine work, a lower reasoning-effort " +
                "setting trims this without touching the visible answer.",
                Money(reasoningCost)), reasoningCost * 0.3));
        }

        // Model mix: the priciest model versus a much cheaper one already in use.
        var priced = models
            .Where(pair => pair.Value.Cost >= 0.5 && pair.Value.Tokens >= 1_000_000)
            .Select(pair => (
                Model: pair.Key,
                pair.Value.Cost,
                Rate: pair.Value.Cost / pair.Value.Tokens * 1_000_000))
            .OrderByDescending(entry => entry.Cost)
            .ToList();
        if (priced.Count >= 2 && priced[0].Cost / totalCost >= 0.5)
        {
            var top = priced[0];
            var cheapest = priced.Skip(1).MinBy(entry => entry.Rate);
            var ratio = cheapest.Rate > 0 ? top.Rate / cheapest.Rate : 0;
            if (ratio >= 3)
            {
                tips.Add((new InsightTip(
                    InsightKind.Note,
                    $"{top.Cost / totalCost:P0} of spend rides on {top.Model}",
                    $"Blended across everything it re-read and wrote, {top.Model} cost " +
                    $"{top.Rate.ToString("$0.00", Usd)} per million tokens this range, while {cheapest.Model} — already " +
                    $"in your mix — averaged {cheapest.Rate.ToString("$0.00", Usd)}, about {ratio:0.#}× less. Routing " +
                    "routine work to the cheaper tier is the easiest structural saving there is.",
                    Money(top.Cost)), top.Cost * 0.05));
            }
        }

        // One runaway day.
        if (dayCosts.Count >= 7)
        {
            var (spikeDay, spikeCost) = dayCosts.MaxBy(pair => pair.Value);
            var spikeShare = spikeCost / totalCost;
            if (spikeShare >= 0.25)
            {
                var median = dayCosts.Values.Order().ElementAt(dayCosts.Count / 2);
                tips.Add((new InsightTip(
                    InsightKind.Note,
                    $"{spikeDay:MMM d} alone was {spikeShare:P0} of the range",
                    $"That day cost {Money(spikeCost)} against a median day of {Money(median)}. Spikes usually mean one " +
                    "runaway task — the Dashboard's 30 d view shows what ran; the Daily activity grid on the Limits " +
                    "page shows how unusual the day was.",
                    Money(spikeCost)), spikeCost * 0.05));
            }
        }

        // What the subscription would have billed through the API.
        if (planMonthlyUsd is > 0)
        {
            var planForRange = planMonthlyUsd.Value * rangeDays / 30.4;
            if (subscriptionClaudeCost >= planForRange * 1.25)
            {
                tips.Add((new InsightTip(
                    InsightKind.Good,
                    $"Your Claude plan beat API pricing {subscriptionClaudeCost / planForRange:0.#}×",
                    $"Claude Code usage on your subscription would have billed {Money(subscriptionClaudeCost)} at API " +
                    $"list prices, against roughly {Money(planForRange)} of plan cost for the same {rangeDays} days. " +
                    "Every dollar figure on this page is that hypothetical API bill — on a flat plan the practical " +
                    "currency is rate limits, and smaller context stretches those exactly the same way.",
                    Money(subscriptionClaudeCost)), 0.1));
            }
        }

        if (tips.Count == 0)
        {
            tips.Add((new InsightTip(
                InsightKind.Note,
                "Nothing stands out in this range",
                "Usage is small or evenly spread — no dominant cost pattern, no premium-context surcharges, no runaway " +
                "sessions. Check back after a heavier stretch of work.",
                Money(totalCost)), 0));
        }

        return tips
            .OrderBy(entry => entry.Tip.Kind)
            .ThenByDescending(entry => entry.Weight)
            .Select(entry => entry.Tip)
            .ToList();
    }

    private static double ComponentCost(
        PricingService pricing,
        InsightEventRow ev,
        long input,
        long output,
        long cacheRead,
        long cacheWrite) =>
        pricing.Calculate(ev.Provider, ev.Model, new TokenBreakdown(input, output, cacheRead, cacheWrite, 0)).Cost;

    /// <summary>
    /// The event's cost with every token at base rates: each component priced in
    /// chunks small enough that no long-context tier can trigger.
    /// </summary>
    private static double BaseRateCost(PricingService pricing, InsightEventRow ev, TokenBreakdown t)
    {
        return Chunked(t.Input, n => new TokenBreakdown(n, 0, 0, 0, 0))
             + Chunked(t.Output, n => new TokenBreakdown(0, n, 0, 0, 0))
             + Chunked(t.CacheRead, n => new TokenBreakdown(0, 0, n, 0, 0))
             + Chunked(t.CacheWrite, n => new TokenBreakdown(0, 0, 0, n, 0));

        double Chunked(long tokens, Func<long, TokenBreakdown> make)
        {
            var cost = 0d;
            for (var left = tokens; left > 0; left -= 100_000)
            {
                cost += pricing.Calculate(ev.Provider, ev.Model, make(Math.Min(left, 100_000))).Cost;
            }

            return cost;
        }
    }

    private static int BandIndex(long context)
    {
        for (var index = 0; index < BandEdges.Length; index++)
        {
            if (context < BandEdges[index].UpTo)
            {
                return index;
            }
        }

        return BandEdges.Length - 1;
    }

    private static string Money(double value) => value switch
    {
        >= 1000 => value.ToString("$#,##0", Usd),
        >= 20 => value.ToString("$0", Usd),
        _ => value.ToString("$0.00", Usd)
    };

    private static string Tokens(long value) => value switch
    {
        >= 1_000_000_000 => $"{value / 1_000_000_000.0:0.#}B tokens",
        >= 1_000_000 => $"{value / 1_000_000.0:0.#}M tokens",
        >= 1_000 => $"{value / 1_000.0:0}k tokens",
        _ => $"{value} tokens"
    };

    private static string Plural(long count, string unit, string? units = null) =>
        count == 1 ? $"{count:N0} {unit}" : $"{count:N0} {units ?? unit + "s"}";
}
