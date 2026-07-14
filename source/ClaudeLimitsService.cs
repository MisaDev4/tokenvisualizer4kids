using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace TokenTracker;

/// <summary>One plan rate limit as reported by the Claude usage endpoint.</summary>
public sealed record ClaudeLimit(string Label, double Percent, string Severity, DateTimeOffset? ResetsAt);

/// <summary>All current limits plus the subscription they belong to.</summary>
public sealed record ClaudeLimitsSnapshot(IReadOnlyList<ClaudeLimit> Limits, string? Plan);

/// <summary>
/// Reads the subscription rate limits (5-hour session, weekly, per-model weekly)
/// from the same endpoint Claude Code's /usage screen uses, authenticated with
/// the OAuth token Claude Code keeps in ~/.claude/.credentials.json. The file is
/// re-read on every fetch so token refreshes by Claude Code are picked up; the
/// token itself never leaves this process except to the Anthropic API.
/// </summary>
public sealed class ClaudeLimitsService : IDisposable
{
    private static readonly Uri UsageEndpoint = new("https://api.anthropic.com/api/oauth/usage");

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private bool _disposed;

    public string CredentialsPath { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        ".credentials.json");

    /// <summary>Returns the current limits, or null when unavailable (no Claude Code
    /// sign-in, expired token, offline). Callers should keep showing the last snapshot.</summary>
    public async Task<ClaudeLimitsSnapshot?> FetchAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var (token, plan) = ReadCredentials();
            if (token is null)
            {
                return null;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, UsageEndpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Add("anthropic-beta", "oauth-2025-04-20");

            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, default, cancellationToken).ConfigureAwait(false);
            var limits = ParseLimits(document.RootElement);
            return limits is null ? null : new ClaudeLimitsSnapshot(limits, plan);
        }
        catch (Exception exception) when (exception is IOException or HttpRequestException or JsonException
                                              or TaskCanceledException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private (string? Token, string? Plan) ReadCredentials()
    {
        if (!File.Exists(CredentialsPath))
        {
            return (null, null);
        }

        using var document = JsonDocument.Parse(File.ReadAllText(CredentialsPath));
        if (!document.RootElement.TryGetProperty("claudeAiOauth", out var oauth) ||
            !oauth.TryGetProperty("accessToken", out var token) ||
            token.ValueKind != JsonValueKind.String)
        {
            return (null, null);
        }

        return (token.GetString(), StringOf(oauth, "subscriptionType"));
    }

    private static List<ClaudeLimit>? ParseLimits(JsonElement root)
    {
        if (!root.TryGetProperty("limits", out var limits) || limits.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var results = new List<ClaudeLimit>();
        foreach (var entry in limits.EnumerateArray())
        {
            var kind = StringOf(entry, "kind") ?? "";
            var label = kind switch
            {
                "session" => "5h",
                "weekly_all" => "Week",
                // Model- or surface-scoped weekly limits carry their own display name.
                "weekly_scoped" => ScopeName(entry) ?? "Scoped",
                _ => kind
            };

            var percent = entry.TryGetProperty("percent", out var pct) && pct.ValueKind == JsonValueKind.Number
                ? pct.GetDouble()
                : 0;
            DateTimeOffset? resetsAt = entry.TryGetProperty("resets_at", out var resets) &&
                                       resets.ValueKind == JsonValueKind.String &&
                                       DateTimeOffset.TryParse(resets.GetString(), out var parsed)
                ? parsed
                : null;

            results.Add(new ClaudeLimit(label, percent, StringOf(entry, "severity") ?? "normal", resetsAt));
        }

        return results.Count > 0 ? results : null;
    }

    private static string? ScopeName(JsonElement entry) =>
        entry.TryGetProperty("scope", out var scope) && scope.ValueKind == JsonValueKind.Object &&
        scope.TryGetProperty("model", out var model) && model.ValueKind == JsonValueKind.Object
            ? StringOf(model, "display_name")
            : null;

    private static string? StringOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _http.Dispose();
    }
}
