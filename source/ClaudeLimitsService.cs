using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

/// <summary>One plan rate limit as reported by the Claude usage endpoint.</summary>
public sealed record ClaudeLimit(string Label, double Percent, string Severity, DateTimeOffset? ResetsAt);

/// <summary>The outcome of a manual cookie-session refresh: which account (if
/// any) received the numbers, plus a status line for the Limits page. The
/// email rides along raw so the UI can apply its own privacy masking.</summary>
public sealed record SessionRefreshResult(string Status, string? UpdatedAccountId, string? UpdatedEmail);

/// <summary>The limits of one Claude account the app has seen sign into Claude Code.</summary>
public sealed record ClaudeAccountLimits(
    string Id,
    string Email,
    string? Plan,
    string? RateLimitTier,
    bool IsActive,
    bool Stale,
    DateTimeOffset? FetchedAt,
    DateTimeOffset? CooldownUntil,
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

    /// <summary>How often the signed-in account's limits refresh. The usage
    /// endpoint is a cheap read that returns every limit row as official
    /// percentages; community trackers (usage-monitor-for-claude, the
    /// statusline scripts) poll it at this cadence without tripping its quota,
    /// so nothing needs to be estimated between fetches.</summary>
    private const long UsageFetchIntervalMs = 180_000;

    /// <summary>Signed-out background accounts — and every account while the
    /// user is away from the machine — refresh gently instead; nobody is
    /// watching, and the numbers catch up within a tick of their return.</summary>
    private const long BackgroundFetchIntervalMs = 1_800_000;

    /// <summary>No keyboard or mouse input for this long counts as away.</summary>
    private const long IdlePauseMs = 300_000;

    /// <summary>A 429's Retry-After is trusted between these bounds — wait at
    /// least one poll interval, at most 15 minutes — then simply resume the
    /// normal cadence.</summary>
    private const long MinCooldownMs = 180_000;
    private const long MaxCooldownMs = 900_000;

    /// <summary>An account with no successful fetch in this long is shown
    /// stale — measured against its own cadence so a gently-polled background
    /// account doesn't read as broken. (The signed-in account can also sit at
    /// the gentle cadence while the user is away; the brief stale flag on
    /// return is honest and clears on the next fetch.)</summary>
    private const long ActiveStaleMs = 600_000;
    private const long BackgroundStaleMs = 4_200_000;

    /// <summary>A failed token refresh is not retried for this long.</summary>
    private const long RefreshRetryMs = 900_000;

    /// <summary>A snapshot that failed without a Retry-After (401, 5xx, network)
    /// waits this long before retrying. Without this, snapshotDue stays true and
    /// the 60 s tick hammers the endpoint — which is exactly how the edge rate
    /// limit that froze the feed gets re-tripped.</summary>
    private const long SnapshotRetryMs = 300_000;

    /// <summary>Polls run every ~60 s; a quiet stretch under this still counts
    /// as the same continuous sign-in when building the attribution timeline.</summary>
    private const long SpanMergeGapMs = 300_000;

    /// <summary>Sign-in history older than this is dropped.</summary>
    private const long TimelineKeepMs = 30L * 86_400_000;

    private readonly HttpClient _http = CreateHttp();

    /// <summary>Requests without a User-Agent are the first thing an edge WAF
    /// throttles; identify honestly instead of arriving anonymous.</summary>
    private static HttpClient CreateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("TokenTracker/1.0");
        return http;
    }
    private readonly List<ActiveSpan> _timeline = [];
    private readonly Dictionary<string, StoredAccount> _accounts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _tokenOwner = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _refreshFailedAtMs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _snapshotFailedAtMs = new(StringComparer.Ordinal);

    /// <summary>Accounts whose tokens a live client (the CLI credentials file or
    /// the desktop app) is managing right now. We re-read their tokens from that
    /// source each poll and never refresh them ourselves — a second refresh
    /// would rotate the refresh token out from under the client and log it out.</summary>
    private readonly HashSet<string> _externallyManaged = new(StringComparer.Ordinal);
    private bool _storeLoaded;
    private bool _disposed;

    public string CredentialsPath { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        ".credentials.json");

    /// <summary>The official Claude desktop app's config + os_crypt key. The app
    /// runs Claude Code under this store rather than the CLI credentials file.</summary>
    public string DesktopConfigPath { get; init; } = DesktopAppCredentials.DefaultConfigPath;

    public string DesktopLocalStatePath { get; init; } = DesktopAppCredentials.DefaultLocalStatePath;

    public string AccountStorePath { get; init; } = Path.Combine(AppPaths.DataDirectory, "accounts.json");

    /// <summary>claude-swap's usage cache — a second, borrowed source of full
    /// limit snapshots for the same accounts, fresher than our own cadence
    /// whenever claude-swap is running.</summary>
    public string SwapStorePath { get; init; } = ClaudeSwapStore.DefaultPath;

    /// <summary>Current limits for every known account, the signed-in one first.
    /// Empty when no account has ever been seen (no Claude Code sign-in).</summary>
    public async Task<IReadOnlyList<ClaudeAccountLimits>> FetchAllAsync(
        CancellationToken cancellationToken = default)
    {
        LoadStore();
        _externallyManaged.Clear();

        // Claude Code signs in from two places: the CLI writes ~/.claude/
        // .credentials.json, the desktop app keeps its own encrypted store.
        // Adopt whichever exist; the account "signed in now" is the one whose
        // source was touched most recently, so the compact strip follows the
        // surface the user is actually on instead of always the CLI's.
        var cli = await AdoptCliCredentialsAsync(cancellationToken).ConfigureAwait(false);
        var desktop = await AdoptDesktopCredentialsAsync(cancellationToken).ConfigureAwait(false);
        if (cli is { } c)
        {
            _externallyManaged.Add(c.Id);
        }

        if (desktop is { } d)
        {
            _externallyManaged.Add(d.Id);
        }

        var activeId = PickActive(cli, desktop);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (activeId is not null)
        {
            RecordActiveSpan(activeId, nowMs);
        }

        var swapRows = ClaudeSwapStore.TryRead(SwapStorePath);
        var userAway = UserIdle.MillisecondsSinceInput() >= IdlePauseMs;
        foreach (var account in _accounts.Values)
        {
            try
            {
                await UpdateAccountAsync(
                        account,
                        account.Id == activeId,
                        userAway,
                        swapRows,
                        nowMs,
                        cancellationToken)
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

    /// <summary>
    /// Refreshes one account's limits from the Claude desktop app's claude.ai
    /// session instead of the OAuth usage endpoint — the manual fallback for when
    /// that endpoint is throttled. It returns the full limit set, model-scoped
    /// weekly rows included, so on success it counts as a full snapshot and
    /// clears any cooldown. User-invoked only. The numbers land on the account
    /// whose org id matches the session — the desktop app may be signed into a
    /// different account than the one on screen, and writing its usage onto the
    /// shown card once poisoned that card until the next full snapshot.
    /// </summary>
    public async Task<SessionRefreshResult> RefreshFromSessionAsync(CancellationToken cancellationToken = default)
    {
        LoadStore();
        var result = await new ClaudeSessionUsage().FetchAsync(cancellationToken).ConfigureAwait(false);
        if (!result.Success || result.Json is null)
        {
            return new SessionRefreshResult(result.Status, null, null);
        }

        List<StoredLimit>? limits;
        try
        {
            using var document = JsonDocument.Parse(result.Json);
            limits = ParseLimits(document.RootElement);
        }
        catch (JsonException)
        {
            return new SessionRefreshResult("claude.ai sent an unexpected response.", null, null);
        }

        if (limits is null)
        {
            return new SessionRefreshResult("claude.ai returned no limits for this account.", null, null);
        }

        var target = await AccountForOrgAsync(result.OrgUuid, cancellationToken).ConfigureAwait(false);
        if (target is null)
        {
            return new SessionRefreshResult(
                "The Claude app is signed into an account this tracker doesn't know — " +
                "nothing was updated. Open the Claude app once with a tracked account, then retry.",
                null,
                null);
        }

        ApplySnapshot(target, limits, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        SaveStore();
        return new SessionRefreshResult(result.Status, target.Id, target.Email);
    }

    /// <summary>The stored account belonging to one claude.ai org — the only
    /// safe way to route cookie-session usage. Accounts adopted before org ids
    /// were tracked resolve theirs here on demand (their scheduled backfill may
    /// be half an hour away, and this path is rare and user-invoked).</summary>
    private async Task<StoredAccount?> AccountForOrgAsync(string? orgUuid, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(orgUuid))
        {
            return null;
        }

        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var account in _accounts.Values)
        {
            if (account.OrgUuid is not null || string.IsNullOrEmpty(account.AccessToken) ||
                nowMs >= account.ExpiresAtMs - 120_000)
            {
                continue;
            }

            var identity = await FetchIdentityAsync(account.AccessToken, cancellationToken).ConfigureAwait(false);
            if (identity is { } known)
            {
                account.Plan = known.Plan ?? account.Plan;
                account.RateLimitTier ??= known.Tier ?? "";
                // Empty (not null) when the profile carries no org, so the
                // lookup runs once per account.
                account.OrgUuid = known.OrgUuid ?? "";
            }
        }

        return _accounts.Values.FirstOrDefault(account => account.OrgUuid == orgUuid);
    }

    /// <summary>Extends the sign-in timeline used to attribute local usage to
    /// accounts. Transcripts carry no account identity, so which account was
    /// signed in at the time an event landed is the only attribution there is.</summary>
    private void RecordActiveSpan(string accountId, long nowMs)
    {
        var last = _timeline.Count > 0 ? _timeline[^1] : null;
        if (last is not null && last.AccountId == accountId && nowMs - last.EndMs < SpanMergeGapMs)
        {
            last.EndMs = nowMs;
        }
        else
        {
            _timeline.Add(new ActiveSpan { AccountId = accountId, StartMs = nowMs, EndMs = nowMs });
        }

        _timeline.RemoveAll(span => span.EndMs < nowMs - TimelineKeepMs);
    }

    /// <summary>Windows during which the account was the signed-in one, newest
    /// last, clipped to sinceMs. The end of each span is padded by the merge
    /// gap so usage between two polls of the same account still counts.</summary>
    public IReadOnlyList<(long StartMs, long EndMs)> SignedInSpans(string accountId, long sinceMs)
    {
        var results = new List<(long, long)>();
        foreach (var span in _timeline)
        {
            if (span.AccountId != accountId || span.EndMs + SpanMergeGapMs <= sinceMs)
            {
                continue;
            }

            results.Add((Math.Max(span.StartMs, sinceMs), span.EndMs + SpanMergeGapMs));
        }

        return results;
    }

    /// <summary>An adopted sign-in: the account and how recently its source was
    /// written, used to decide which of two live sources is "signed in now".</summary>
    private readonly record struct AdoptedCredential(string Id, long SourceWriteMs);

    /// <summary>Of the CLI and desktop sign-ins, the one whose source was
    /// touched most recently — both files move on token refresh and on activity,
    /// so the fresher one tracks the surface in use. A tie favors the desktop
    /// app (config.json also moves on ordinary UI activity, so a genuine tie
    /// means the desktop app is at least as live).</summary>
    private static string? PickActive(AdoptedCredential? cli, AdoptedCredential? desktop)
    {
        if (cli is not { } c)
        {
            return desktop?.Id;
        }

        if (desktop is not { } d)
        {
            return c.Id;
        }

        return d.SourceWriteMs >= c.SourceWriteMs ? d.Id : c.Id;
    }

    /// <summary>Reads the CLI credentials file and folds the signed-in account
    /// into the store, learning its identity on first sight.</summary>
    private async Task<AdoptedCredential?> AdoptCliCredentialsAsync(CancellationToken cancellationToken)
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

            var expiresAt = oauth.TryGetProperty("expiresAt", out var expires) &&
                            expires.ValueKind == JsonValueKind.Number
                ? expires.GetInt64()
                : (long?)null;
            var id = await AdoptTokenAsync(
                token,
                StringOf(oauth, "refreshToken"),
                expiresAt,
                StringOf(oauth, "subscriptionType"),
                StringOf(oauth, "rateLimitTier"),
                cancellationToken).ConfigureAwait(false);
            if (id is null)
            {
                return null;
            }

            var sourceMs = new DateTimeOffset(File.GetLastWriteTimeUtc(CredentialsPath), TimeSpan.Zero)
                .ToUnixTimeMilliseconds();
            return new AdoptedCredential(id, sourceMs);
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Reads the official Claude desktop app's Claude Code sign-in and
    /// folds it into the store the same way, so a desktop-driven machine tracks
    /// the account it is actually on rather than the CLI's last account.</summary>
    private async Task<AdoptedCredential?> AdoptDesktopCredentialsAsync(CancellationToken cancellationToken)
    {
        var credential = DesktopAppCredentials.TryRead(DesktopConfigPath, DesktopLocalStatePath);
        if (credential is null)
        {
            return null;
        }

        var id = await AdoptTokenAsync(
            credential.AccessToken,
            credential.RefreshToken,
            credential.ExpiresAtMs,
            credential.SubscriptionType,
            credential.RateLimitTier,
            cancellationToken).ConfigureAwait(false);
        return id is null ? null : new AdoptedCredential(id, credential.SourceWriteMs);
    }

    /// <summary>Folds one live token into the store, resolving its account on
    /// first sight and refreshing the stored token/expiry each time.</summary>
    private async Task<string?> AdoptTokenAsync(
        string token,
        string? refreshToken,
        long? expiresAtMs,
        string? subscriptionType,
        string? rateLimitTier,
        CancellationToken cancellationToken)
    {
        if (!_tokenOwner.TryGetValue(token, out var id))
        {
            var identity = await FetchIdentityAsync(token, cancellationToken).ConfigureAwait(false);
            if (identity is null)
            {
                // Probably an expired token; the owning client will refresh it.
                return null;
            }

            (id, var email, var plan, var tier, var orgUuid) = identity.Value;
            _tokenOwner[token] = id;
            if (!_accounts.TryGetValue(id, out var known))
            {
                _accounts[id] = known = new StoredAccount { Id = id };
            }

            known.Email = email;
            // The profile is authoritative: the stored subscriptionType has been
            // seen reporting pro for Max accounts.
            known.Plan = plan ?? known.Plan;
            known.RateLimitTier = tier ?? known.RateLimitTier;
            known.OrgUuid = orgUuid ?? known.OrgUuid;
        }

        var account = _accounts[id];
        account.AccessToken = token;
        if (!string.IsNullOrEmpty(refreshToken))
        {
            account.RefreshToken = refreshToken;
        }

        if (expiresAtMs is { } expiry)
        {
            account.ExpiresAtMs = expiry;
        }

        account.Plan ??= subscriptionType;
        account.RateLimitTier ??= rateLimitTier;
        account.LastSeenActiveMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _refreshFailedAtMs.Remove(id);
        return id;
    }

    /// <summary>Keeps one account's token alive and pulls its current limits.</summary>
    private async Task UpdateAccountAsync(
        StoredAccount account,
        bool isActive,
        bool userAway,
        IReadOnlyList<ClaudeSwapUsage> swapRows,
        long nowMs,
        CancellationToken cancellationToken)
    {
        // While claude-swap runs it already polls this account's usage every
        // few minutes; its last good measurement is a full snapshot we get
        // without spending a request of our own. Adopt it under its own fetch
        // time: while claude-swap stays fresher than our cadence the fetch
        // below falls silent, and when it goes dormant its timestamps age
        // past our thresholds and polling resumes here.
        if (FindSwapRow(swapRows, account) is { } swap && swap.FetchedAtMs > account.LastFetchedMs)
        {
            var cooldownUntilMs = account.CooldownUntilMs;
            ApplySnapshot(account, swap.Limits, swap.FetchedAtMs);
            if (cooldownUntilMs > nowMs)
            {
                // The cooldown throttles our own requests; borrowed data
                // spent none of that quota, so it can't license retrying
                // sooner.
                account.CooldownUntilMs = cooldownUntilMs;
            }
        }

        // The signed-in account refreshes every few minutes while the user is
        // around; background accounts — and every account while the user is
        // away — poll gently. A 429 cooldown is sat out, then the normal
        // cadence simply resumes.
        var intervalMs = isActive && !userAway ? UsageFetchIntervalMs : BackgroundFetchIntervalMs;
        var snapshotDue = nowMs >= account.CooldownUntilMs &&
                          account.LastFetchedMs <= nowMs - intervalMs &&
                          !(_snapshotFailedAtMs.TryGetValue(account.Id, out var failedAtMs) &&
                            nowMs - failedAtMs < SnapshotRetryMs);
        if (!snapshotDue)
        {
            return;
        }

        // Accounts adopted before tiers/org ids were tracked backfill theirs once.
        if ((account.RateLimitTier is null || account.OrgUuid is null) &&
            !string.IsNullOrEmpty(account.AccessToken) &&
            nowMs < account.ExpiresAtMs - 120_000)
        {
            var identity = await FetchIdentityAsync(account.AccessToken, cancellationToken).ConfigureAwait(false);
            if (identity is { } known)
            {
                account.Plan = known.Plan ?? account.Plan;
                // Empty (not null) when the profile carries no tier/org, so this
                // lookup runs once per account, not once per poll.
                account.RateLimitTier = known.Tier ?? "";
                account.OrgUuid = known.OrgUuid ?? "";
            }
        }

        if (nowMs >= account.ExpiresAtMs - 120_000)
        {
            if (_externallyManaged.Contains(account.Id))
            {
                // A live client (the CLI file or the desktop app) owns this
                // account's tokens; refreshing here would rotate its refresh
                // token and log it out. The next poll re-reads from the source.
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

        var (limits, retryAfter) = await FetchLimitsAsync(account.AccessToken, cancellationToken).ConfigureAwait(false);
        if (retryAfter is { } wait)
        {
            // Sit out the server's stated window (bounded) plus jitter, then
            // resume the normal cadence — the pattern the community trackers
            // run at this cadence without escalation.
            var stated = Math.Clamp((long)wait.TotalMilliseconds, MinCooldownMs, MaxCooldownMs);
            account.CooldownUntilMs = nowMs + stated + Random.Shared.Next(5_000, 30_000);
            return;
        }

        if (limits is not null)
        {
            ApplySnapshot(account, limits, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _snapshotFailedAtMs.Remove(account.Id);
        }
        else
        {
            _snapshotFailedAtMs[account.Id] = nowMs;
        }
    }

    /// <summary>The claude-swap measurement belonging to one stored account.
    /// The org id is the durable identity (claude-swap itself guards its rows
    /// with it); email is the fallback for accounts adopted before org ids
    /// were tracked, whose scheduled backfill may not have run yet.</summary>
    private static ClaudeSwapUsage? FindSwapRow(IReadOnlyList<ClaudeSwapUsage> rows, StoredAccount account)
    {
        foreach (var row in rows)
        {
            if (!string.IsNullOrEmpty(account.OrgUuid) && row.OrgUuid == account.OrgUuid)
            {
                return row;
            }
        }

        foreach (var row in rows)
        {
            if (string.Equals(row.Email, account.Email, StringComparison.OrdinalIgnoreCase))
            {
                return row;
            }
        }

        return null;
    }

    /// <summary>Lands a full limit snapshot (OAuth, claude-swap, or cookie
    /// session) on the account and clears the throttle state. Every source
    /// carries the complete row set, so the numbers shown are always the
    /// server's own — nothing is estimated locally.</summary>
    private static void ApplySnapshot(StoredAccount account, List<StoredLimit> limits, long nowMs)
    {
        account.Limits = limits;
        account.LastFetchedMs = nowMs;
        account.CooldownUntilMs = 0;
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
                // A throttled token endpoint gets the same hands-off treatment
                // as a throttled usage endpoint.
                if (response.StatusCode == HttpStatusCode.TooManyRequests &&
                    response.Headers.RetryAfter is { Delta: { } delta })
                {
                    account.CooldownUntilMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() +
                        Math.Clamp((long)delta.TotalMilliseconds, MinCooldownMs, MaxCooldownMs);
                }

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

            // The refresh grant just rotated this account's refresh token
            // server-side; persist it now. Losing it to a mid-poll shutdown
            // (the rebuild script kills the process) invalidates the account
            // until its next sign-in.
            SaveStore();
            return true;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return false;
        }
    }

    private async Task<(string Id, string Email, string? Plan, string? Tier, string? OrgUuid)?> FetchIdentityAsync(
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

            // The $100 and $200 Max plans both read "max"; the organization's
            // rate_limit_tier (default_claude_max_5x / _20x) tells them apart.
            // Its uuid is the same org id claude.ai's cookie session carries, so
            // it also matches a desktop-app session to the account it belongs to.
            string? tier = null, orgUuid = null;
            if (document.RootElement.TryGetProperty("organization", out var organization) &&
                organization.ValueKind == JsonValueKind.Object)
            {
                tier = StringOf(organization, "rate_limit_tier");
                orgUuid = StringOf(organization, "uuid");
            }

            return string.IsNullOrEmpty(id) ? null : (id, email ?? "unknown account", plan, tier, orgUuid);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return null;
        }
    }

    private static bool BoolOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private async Task<(List<StoredLimit>? Limits, TimeSpan? RetryAfter)> FetchLimitsAsync(
        string token,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = AuthorizedGet(UsageEndpoint, token);
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                var retryAfter = response.Headers.RetryAfter switch
                {
                    { Delta: { } delta } => delta,
                    { Date: { } date } => date - DateTimeOffset.UtcNow,
                    _ => TimeSpan.FromMilliseconds(UsageFetchIntervalMs)
                };
                return (null, retryAfter);
            }

            if (!response.IsSuccessStatusCode)
            {
                return (null, null);
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, default, cancellationToken).ConfigureAwait(false);
            return (ParseLimits(document.RootElement), null);
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or TaskCanceledException)
        {
            return (null, null);
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
        account.RateLimitTier,
        isActive,
        account.LastFetchedMs < nowMs - (isActive ? ActiveStaleMs : BackgroundStaleMs),
        account.LastFetchedMs > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(account.LastFetchedMs) : null,
        account.CooldownUntilMs > nowMs ? DateTimeOffset.FromUnixTimeMilliseconds(account.CooldownUntilMs) : null,
        account.Limits
            .Select(limit => RollForward(limit, DateTimeOffset.FromUnixTimeMilliseconds(nowMs)))
            .ToList());

    /// <summary>
    /// A snapshot ages while an account can't be fetched (signed out, refresh
    /// token dead). Once a limit's reset time passes, that window ended and its
    /// usage is 0 no matter what the snapshot says — so expired limits roll
    /// forward instead of showing a long-gone percentage.
    /// </summary>
    private static ClaudeLimit RollForward(StoredLimit limit, DateTimeOffset now)
    {
        DateTimeOffset? resetsAt = DateTimeOffset.TryParse(limit.ResetsAt, out var parsed) ? parsed : null;
        if (resetsAt is not { } due || due > now)
        {
            return new ClaudeLimit(limit.Label, limit.Percent, limit.Severity, resetsAt);
        }

        if (limit.Label == "5h")
        {
            // Session windows start with the first message, so an idle account
            // has no scheduled next reset.
            return new ClaudeLimit(limit.Label, 0, "normal", null);
        }

        // Weekly windows stay anchored to their schedule: advance whole periods.
        var period = TimeSpan.FromDays(7);
        var missed = (now - due).Ticks / period.Ticks + 1;
        return new ClaudeLimit(limit.Label, 0, "normal", due + TimeSpan.FromTicks(period.Ticks * missed));
    }

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
            var cooldownCeilingMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + MaxCooldownMs;
            foreach (var account in store?.Accounts ?? [])
            {
                if (!string.IsNullOrEmpty(account.Id))
                {
                    _accounts[account.Id] = account;
                    if (!string.IsNullOrEmpty(account.AccessToken))
                    {
                        _tokenOwner[account.AccessToken] = account.Id;
                    }

                    // Stores written by the old escalating backoff can carry
                    // cooldowns hours long; bound them to the new ceiling so a
                    // legacy store doesn't keep an account frozen all evening.
                    if (account.CooldownUntilMs > cooldownCeilingMs)
                    {
                        account.CooldownUntilMs = cooldownCeilingMs;
                    }
                }
            }

            _timeline.AddRange((store?.Timeline ?? []).Where(span => !string.IsNullOrEmpty(span.AccountId)));
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
                    new AccountStore { Accounts = _accounts.Values.ToList(), Timeline = _timeline },
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

    public List<ActiveSpan> Timeline { get; set; } = [];
}

/// <summary>One stretch of wall-clock time during which an account was the
/// one signed into Claude Code.</summary>
internal sealed class ActiveSpan
{
    public string AccountId { get; set; } = "";
    public long StartMs { get; set; }
    public long EndMs { get; set; }
}

internal sealed class StoredAccount
{
    public string Id { get; set; } = "";
    public string Email { get; set; } = "";
    public string? Plan { get; set; }
    public string? RateLimitTier { get; set; }

    /// <summary>The account's claude.ai organization id — routes cookie-session
    /// usage (which is org-scoped) to the account it actually belongs to.</summary>
    public string? OrgUuid { get; set; }
    public string AccessToken { get; set; } = "";
    public string? RefreshToken { get; set; }
    public long ExpiresAtMs { get; set; }
    public long LastSeenActiveMs { get; set; }

    /// <summary>Last successful full limit fetch, from any source.</summary>
    public long LastFetchedMs { get; set; }

    /// <summary>Until when the usage endpoint told us to stop asking (429).</summary>
    public long CooldownUntilMs { get; set; }
    public List<StoredLimit> Limits { get; set; } = [];
}

internal sealed class StoredLimit
{
    public string Label { get; set; } = "";
    public double Percent { get; set; }
    public string Severity { get; set; } = "normal";
    public string? ResetsAt { get; set; }
}

/// <summary>Milliseconds since the last local keyboard/mouse input — the away
/// signal that lets polling slow down while nobody is watching the numbers
/// (the same trick usage-monitor-for-claude uses).</summary>
internal static class UserIdle
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    public static long MillisecondsSinceInput()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info))
        {
            // Unknown counts as present, so a failure can only poll more.
            return 0;
        }

        // Environment.TickCount wraps every ~49 days; unsigned subtraction
        // stays correct across the wrap.
        return (uint)Environment.TickCount - info.dwTime;
    }
}
