using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

/// <summary>One plan rate limit as reported by the Claude usage endpoint.</summary>
public sealed record ClaudeLimit(string Label, double Percent, string Severity, DateTimeOffset? ResetsAt);

/// <summary>The limits of one Claude account the app has seen sign into Claude Code.</summary>
public sealed record ClaudeAccountLimits(
    string Id,
    string Email,
    string? Plan,
    bool IsActive,
    bool Stale,
    DateTimeOffset? FetchedAt,
    IReadOnlyList<ClaudeLimit> Limits);

/// <summary>
/// Tracks rate limits across every Claude account that signs into Claude Code on
/// this machine. The credentials file only ever holds the account signed in right
/// now, so each newly seen sign-in is snapshotted (tokens included) into the app's
/// local data folder — the same plaintext-on-this-machine model Claude Code itself
/// uses. Signed-out accounts keep updating via their refresh token; if a refresh
/// stops working the account is shown stale until its next sign-in. Tokens never
/// leave this process except to the Anthropic API.
/// </summary>
public sealed class ClaudeLimitsService : IDisposable
{
    private static readonly Uri UsageEndpoint = new("https://api.anthropic.com/api/oauth/usage");
    private static readonly Uri ProfileEndpoint = new("https://api.anthropic.com/api/oauth/profile");
    private static readonly Uri TokenEndpoint = new("https://console.anthropic.com/v1/oauth/token");

    // Claude Code's public OAuth client id (PKCE public client, no secret) —
    // required for the refresh grant that keeps signed-out accounts readable.
    private const string ClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

    /// <summary>An account with no successful fetch in this long is shown stale.</summary>
    private const long StaleAfterMs = 180_000;

    /// <summary>A failed token refresh is not retried for this long.</summary>
    private const long RefreshRetryMs = 900_000;

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly Dictionary<string, StoredAccount> _accounts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _tokenOwner = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _refreshFailedAtMs = new(StringComparer.Ordinal);
    private bool _storeLoaded;
    private bool _disposed;

    public string CredentialsPath { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        ".credentials.json");

    public string AccountStorePath { get; init; } = Path.Combine(AppPaths.DataDirectory, "accounts.json");

    /// <summary>Current limits for every known account, the signed-in one first.
    /// Empty when no account has ever been seen (no Claude Code sign-in).</summary>
    public async Task<IReadOnlyList<ClaudeAccountLimits>> FetchAllAsync(CancellationToken cancellationToken = default)
    {
        LoadStore();
        var activeId = await AdoptCurrentCredentialsAsync(cancellationToken).ConfigureAwait(false);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        foreach (var account in _accounts.Values)
        {
            try
            {
                await UpdateAccountAsync(account, account.Id == activeId, nowMs, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch
            {
                // Per-account best effort: one broken account must not hide the rest.
            }
        }

        SaveStore();
        return _accounts.Values
            .OrderByDescending(account => account.Id == activeId)
            .ThenBy(account => account.Email, StringComparer.OrdinalIgnoreCase)
            .Select(account => ToResult(account, account.Id == activeId, nowMs))
            .ToList();
    }

    /// <summary>Reads the Claude Code credentials file and folds the signed-in
    /// account into the store, learning its identity on first sight.</summary>
    private async Task<string?> AdoptCurrentCredentialsAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (!File.Exists(CredentialsPath))
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(CredentialsPath));
            if (!document.RootElement.TryGetProperty("claudeAiOauth", out var oauth))
            {
                return null;
            }

            var token = StringOf(oauth, "accessToken");
            if (string.IsNullOrEmpty(token))
            {
                return null;
            }

            if (!_tokenOwner.TryGetValue(token, out var id))
            {
                var identity = await FetchIdentityAsync(token, cancellationToken).ConfigureAwait(false);
                if (identity is null)
                {
                    // Probably an expired token; Claude Code will refresh the file.
                    return null;
                }

                (id, var email, var plan) = identity.Value;
                _tokenOwner[token] = id;
                if (!_accounts.TryGetValue(id, out var known))
                {
                    _accounts[id] = known = new StoredAccount { Id = id };
                }

                known.Email = email;
                // The profile is authoritative: the credentials file's
                // subscriptionType has been seen reporting pro for Max accounts.
                known.Plan = plan ?? known.Plan;
            }

            var account = _accounts[id];
            account.AccessToken = token;
            var refresh = StringOf(oauth, "refreshToken");
            if (!string.IsNullOrEmpty(refresh))
            {
                account.RefreshToken = refresh;
            }

            account.ExpiresAtMs = oauth.TryGetProperty("expiresAt", out var expires) &&
                                  expires.ValueKind == JsonValueKind.Number
                ? expires.GetInt64()
                : account.ExpiresAtMs;
            account.Plan ??= StringOf(oauth, "subscriptionType");
            account.LastSeenActiveMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _refreshFailedAtMs.Remove(id);
            return id;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Keeps one account's token alive and pulls its current limits.</summary>
    private async Task UpdateAccountAsync(
        StoredAccount account,
        bool isActive,
        long nowMs,
        CancellationToken cancellationToken)
    {
        if (nowMs >= account.ExpiresAtMs - 120_000)
        {
            if (isActive)
            {
                // Claude Code owns the active account's tokens; refreshing them
                // here would race it. The next poll re-reads the file.
                return;
            }

            if (string.IsNullOrEmpty(account.RefreshToken) ||
                (_refreshFailedAtMs.TryGetValue(account.Id, out var failedAt) && nowMs - failedAt < RefreshRetryMs))
            {
                return;
            }

            if (!await TryRefreshTokenAsync(account, cancellationToken).ConfigureAwait(false))
            {
                _refreshFailedAtMs[account.Id] = nowMs;
                return;
            }

            _refreshFailedAtMs.Remove(account.Id);
        }

        var limits = await FetchLimitsAsync(account.AccessToken, cancellationToken).ConfigureAwait(false);
        if (limits is not null)
        {
            account.Limits = limits;
            account.LastFetchedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }

    private async Task<bool> TryRefreshTokenAsync(StoredAccount account, CancellationToken cancellationToken)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                grant_type = "refresh_token",
                refresh_token = account.RefreshToken,
                client_id = ClientId
            });
            using var request = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json")
            };
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return false;
            }

            using var document = JsonDocument.Parse(
                await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
            var access = StringOf(document.RootElement, "access_token");
            if (string.IsNullOrEmpty(access))
            {
                return false;
            }

            account.AccessToken = access;
            _tokenOwner[access] = account.Id;
            var newRefresh = StringOf(document.RootElement, "refresh_token");
            if (!string.IsNullOrEmpty(newRefresh))
            {
                account.RefreshToken = newRefresh;
            }

            account.ExpiresAtMs = document.RootElement.TryGetProperty("expires_in", out var expiresIn) &&
                                  expiresIn.ValueKind == JsonValueKind.Number
                ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + expiresIn.GetInt64() * 1000
                : account.ExpiresAtMs;
            return true;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return false;
        }
    }

    private async Task<(string Id, string Email, string? Plan)?> FetchIdentityAsync(
        string token,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = AuthorizedGet(ProfileEndpoint, token);
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            using var document = JsonDocument.Parse(
                await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
            if (!document.RootElement.TryGetProperty("account", out var accountElement))
            {
                return null;
            }

            var id = StringOf(accountElement, "uuid");
            var email = StringOf(accountElement, "email");
            var plan = BoolOf(accountElement, "has_claude_max") ? "max"
                : BoolOf(accountElement, "has_claude_pro") ? "pro"
                : null;
            return string.IsNullOrEmpty(id) ? null : (id, email ?? "unknown account", plan);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return null;
        }
    }

    private static bool BoolOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private async Task<List<StoredLimit>?> FetchLimitsAsync(string token, CancellationToken cancellationToken)
    {
        try
        {
            using var request = AuthorizedGet(UsageEndpoint, token);
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, default, cancellationToken).ConfigureAwait(false);
            return ParseLimits(document.RootElement);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return null;
        }
    }

    private static HttpRequestMessage AuthorizedGet(Uri endpoint, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("anthropic-beta", "oauth-2025-04-20");
        return request;
    }

    private static List<StoredLimit>? ParseLimits(JsonElement root)
    {
        if (!root.TryGetProperty("limits", out var limits) || limits.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var results = new List<StoredLimit>();
        foreach (var entry in limits.EnumerateArray())
        {
            var kind = StringOf(entry, "kind") ?? "";
            results.Add(new StoredLimit
            {
                Label = kind switch
                {
                    "session" => "5h",
                    "weekly_all" => "Week",
                    // Model- or surface-scoped weekly limits carry their own display name.
                    "weekly_scoped" => ScopeName(entry) ?? "Scoped",
                    _ => kind
                },
                Percent = entry.TryGetProperty("percent", out var percent) &&
                          percent.ValueKind == JsonValueKind.Number
                    ? percent.GetDouble()
                    : 0,
                Severity = StringOf(entry, "severity") ?? "normal",
                ResetsAt = StringOf(entry, "resets_at")
            });
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

    private static ClaudeAccountLimits ToResult(StoredAccount account, bool isActive, long nowMs) => new(
        account.Id,
        account.Email,
        account.Plan,
        isActive,
        account.LastFetchedMs < nowMs - StaleAfterMs,
        account.LastFetchedMs > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(account.LastFetchedMs) : null,
        account.Limits.Select(limit => new ClaudeLimit(
            limit.Label,
            limit.Percent,
            limit.Severity,
            DateTimeOffset.TryParse(limit.ResetsAt, out var resetsAt) ? resetsAt : null)).ToList());

    private void LoadStore()
    {
        if (_storeLoaded)
        {
            return;
        }

        _storeLoaded = true;
        try
        {
            if (!File.Exists(AccountStorePath))
            {
                return;
            }

            var store = JsonSerializer.Deserialize<AccountStore>(File.ReadAllText(AccountStorePath));
            foreach (var account in store?.Accounts ?? [])
            {
                if (!string.IsNullOrEmpty(account.Id))
                {
                    _accounts[account.Id] = account;
                    if (!string.IsNullOrEmpty(account.AccessToken))
                    {
                        _tokenOwner[account.AccessToken] = account.Id;
                    }
                }
            }
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            // A corrupt store rebuilds itself as accounts sign in again.
        }
    }

    private void SaveStore()
    {
        try
        {
            AppPaths.EnsureDataDirectory();
            File.WriteAllText(
                AccountStorePath,
                JsonSerializer.Serialize(
                    new AccountStore { Accounts = _accounts.Values.ToList() },
                    new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Tracking still works for this run; persistence retries next poll.
        }
    }

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

/// <summary>On-disk snapshot of every account seen; lives in the app's data folder.</summary>
internal sealed class AccountStore
{
    public List<StoredAccount> Accounts { get; set; } = [];
}

internal sealed class StoredAccount
{
    public string Id { get; set; } = "";
    public string Email { get; set; } = "";
    public string? Plan { get; set; }
    public string AccessToken { get; set; } = "";
    public string? RefreshToken { get; set; }
    public long ExpiresAtMs { get; set; }
    public long LastSeenActiveMs { get; set; }
    public long LastFetchedMs { get; set; }
    public List<StoredLimit> Limits { get; set; } = [];
}

internal sealed class StoredLimit
{
    public string Label { get; set; } = "";
    public double Percent { get; set; }
    public string Severity { get; set; } = "normal";
    public string? ResetsAt { get; set; }
}
