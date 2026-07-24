using System.IO;
using System.Text.Json;

namespace TokenTracker;

/// <summary>One account's last successful usage measurement as recorded by
/// claude-swap, plus when claude-swap fetched it.</summary>
internal sealed record ClaudeSwapUsage(
    string Email, string? OrgUuid, long FetchedAtMs, List<StoredLimit> Limits);

/// <summary>
/// Reads the usage cache maintained by claude-swap (the multi-account Claude
/// credential swapper), when it is installed. While claude-swap runs it polls
/// the same OAuth usage endpoint this app does — every few minutes, for every
/// stored account — and persists each account's last good measurement, so its
/// cache is a free full snapshot (model-scoped weekly rows included) that also
/// spares the endpoint's small per-account quota from being spent twice.
/// </summary>
internal static class ClaudeSwapStore
{
    public static string DefaultPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude-swap-backup",
        "cache",
        "usage.json");

    public static List<ClaudeSwapUsage> TryRead(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return [];
            }

            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;

            // Older schemas were all-or-nothing snapshots without per-account
            // fetch times; claude-swap itself treats them as empty, so do we.
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("schemaVersion", out var version) ||
                version.ValueKind != JsonValueKind.Number || version.GetInt32() != 2 ||
                !root.TryGetProperty("accounts", out var accounts) ||
                accounts.ValueKind != JsonValueKind.Object)
            {
                return [];
            }

            var results = new List<ClaudeSwapUsage>();
            foreach (var slot in accounts.EnumerateObject())
            {
                if (Parse(slot.Value) is { } row)
                {
                    results.Add(row);
                }
            }

            return results;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            // claude-swap writes atomically under a lock, but a missing or
            // torn file just means no borrowed data this poll.
            return [];
        }
    }

    private static ClaudeSwapUsage? Parse(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Object ||
            !row.TryGetProperty("lastGood", out var lastGood) ||
            lastGood.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        // fetchedAt is epoch seconds and stamps lastGood specifically —
        // failed attempts move lastAttemptAt, not this.
        var fetchedAtMs = row.TryGetProperty("fetchedAt", out var fetchedAt) &&
                          fetchedAt.ValueKind == JsonValueKind.Number
            ? (long)(fetchedAt.GetDouble() * 1000)
            : 0;
        var email = StringOf(row, "email");
        if (fetchedAtMs <= 0 || string.IsNullOrEmpty(email))
        {
            return null;
        }

        var limits = new List<StoredLimit>();
        AddWindow(limits, lastGood, "five_hour", "5h");
        AddWindow(limits, lastGood, "seven_day", "Week");
        if (lastGood.TryGetProperty("scoped", out var scoped) && scoped.ValueKind == JsonValueKind.Array)
        {
            foreach (var window in scoped.EnumerateArray())
            {
                // Scoped names are the API's model display names ("Fable",
                // "Opus"), the same labels our own snapshots use — so these
                // rows slot straight into the scoped-weekly estimator.
                if (window.ValueKind == JsonValueKind.Object && StringOf(window, "name") is { Length: > 0 } name)
                {
                    Add(limits, window, name);
                }
            }
        }

        return limits.Count > 0
            ? new ClaudeSwapUsage(email, StringOf(row, "organizationUuid"), fetchedAtMs, limits)
            : null;
    }

    private static void AddWindow(List<StoredLimit> limits, JsonElement lastGood, string property, string label)
    {
        if (lastGood.TryGetProperty(property, out var window) && window.ValueKind == JsonValueKind.Object)
        {
            Add(limits, window, label);
        }
    }

    private static void Add(List<StoredLimit> limits, JsonElement window, string label)
    {
        if (!window.TryGetProperty("pct", out var pct) || pct.ValueKind != JsonValueKind.Number)
        {
            return;
        }

        var percent = pct.GetDouble();
        limits.Add(new StoredLimit
        {
            Label = label,
            Percent = percent,
            // claude-swap keeps only the percentage, so severity is synthesized
            // with the same thresholds the scoped-weekly estimator uses.
            Severity = percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal",
            ResetsAt = StringOf(window, "resets_at")
        });
    }

    private static string? StringOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
