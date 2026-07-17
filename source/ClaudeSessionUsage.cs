using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using Microsoft.Data.Sqlite;

namespace TokenTracker;

/// <summary>The outcome of a cookie-session usage fetch: the raw usage JSON on
/// success, otherwise a human-readable reason the Limits page can show.</summary>
public sealed record SessionUsageResult(string? Json, string? OrgUuid, string Status, bool Success);

/// <summary>
/// Reads plan limits the way the official Claude desktop app does — through
/// claude.ai's cookie-authenticated usage API rather than the OAuth usage
/// endpoint. That endpoint's rate-limit bucket is separate, so it keeps working
/// (and uniquely still reports the per-model "weekly scoped" rows) even while the
/// OAuth endpoint is throttled.
///
/// This borrows the desktop app's claude.ai web session, which is broader-scoped
/// than the Claude Code OAuth token, so it is a deliberate, user-invoked action —
/// never a background loop. The session cookie is decrypted, used for a single
/// request, and discarded; nothing is persisted. The desktop app holds its cookie
/// database under an exclusive lock while running, so the app must be closed at
/// fetch time; that lock is how we detect the "app still open" case.
/// </summary>
public sealed class ClaudeSessionUsage
{
    // GET {base}/api/organizations/{orgUuid}/usage?skip_spend=1, captured from the
    // desktop app's own bundle. skip_spend omits dollar figures we don't display.
    private static readonly string UsagePathTemplate = "https://claude.ai/api/organizations/{0}/usage?skip_spend=1";

    /// <summary>The desktop app (MSIX Store build) keeps its Chromium profile here;
    /// a plain %APPDATA%\Claude install is accepted as a fallback.</summary>
    private static readonly string MsixProfileDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");

    private static readonly string PlainProfileDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Claude");

    public string? CookiesPathOverride { get; init; }
    public string? LocalStatePathOverride { get; init; }

    private static string CookiesPath(string profileDir) => Path.Combine(profileDir, "Network", "Cookies");

    private static string LocalStatePath(string profileDir) => Path.Combine(profileDir, "Local State");

    /// <summary>Reads the current plan limits via the desktop app's claude.ai
    /// session. Best-effort: any failure comes back as a Status message rather
    /// than an exception.</summary>
    public async Task<SessionUsageResult> FetchAsync(CancellationToken cancellationToken = default)
    {
        var (cookiesPath, localStatePath) = ResolveStore();
        if (cookiesPath is null || localStatePath is null)
        {
            return new SessionUsageResult(null, null, "Claude desktop app not found on this machine.", false);
        }

        var key = DesktopAppCredentials.ReadOsCryptKey(localStatePath);
        if (key is null)
        {
            return new SessionUsageResult(null, null, "Couldn't read the Claude app's encryption key.", false);
        }

        // Copying the DB doubles as the lock probe: Chromium keeps Cookies open
        // with no read sharing while the app runs, so this throws until it quits.
        var temp = Path.Combine(Path.GetTempPath(), $"tt-cookies-{Guid.NewGuid():N}.db");
        try
        {
            File.Copy(cookiesPath, temp, overwrite: true);
        }
        catch (IOException)
        {
            return new SessionUsageResult(
                null, null, "Quit the Claude desktop app first (right-click its tray icon → Exit), then retry.", false);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException)
        {
            return new SessionUsageResult(null, null, "Couldn't read the Claude app's cookie store.", false);
        }

        try
        {
            var (cookieHeader, orgUuid) = ReadCookies(temp, key);
            if (cookieHeader is null)
            {
                return new SessionUsageResult(
                    null, null, "No claude.ai session found — sign into the Claude desktop app.", false);
            }

            if (orgUuid is null)
            {
                return new SessionUsageResult(
                    null, null, "Signed in, but no active organization on the claude.ai session.", false);
            }

            return await RequestUsageAsync(cookieHeader, orgUuid, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is SqliteException or IOException)
        {
            return new SessionUsageResult(null, null, "Couldn't read the Claude app's cookie database.", false);
        }
        finally
        {
            try
            {
                File.Delete(temp);
            }
            catch (IOException)
            {
                // A leftover temp copy is harmless; it's overwritten next time.
            }
        }
    }

    private (string? CookiesPath, string? LocalStatePath) ResolveStore()
    {
        if (CookiesPathOverride is not null && LocalStatePathOverride is not null)
        {
            return (CookiesPathOverride, LocalStatePathOverride);
        }

        foreach (var dir in new[] { MsixProfileDir, PlainProfileDir })
        {
            if (File.Exists(CookiesPath(dir)) && File.Exists(LocalStatePath(dir)))
            {
                return (CookiesPath(dir), LocalStatePath(dir));
            }
        }

        return (null, null);
    }

    /// <summary>Pulls every decryptable .claude.ai cookie into a single header and
    /// picks the active org out of the lastActiveOrg cookie. Non-ASCII cookies
    /// (analytics blobs) are dropped — they can't ride an HTTP header and aren't
    /// needed for auth.</summary>
    private static (string? CookieHeader, string? OrgUuid) ReadCookies(string dbPath, byte[] key)
    {
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly
        }.ToString();

        using var connection = new SqliteConnection(connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai'";
        using var reader = command.ExecuteReader();

        var pairs = new List<string>();
        var haveSession = false;
        string? orgUuid = null;
        while (reader.Read())
        {
            var name = reader.GetString(0);
            var value = DesktopAppCredentials.DecryptCookieValue((byte[])reader[1], key);
            if (value is null || !IsAscii(name) || !IsAscii(value))
            {
                continue;
            }

            if (name == "sessionKey")
            {
                haveSession = true;
            }

            if (name == "lastActiveOrg")
            {
                orgUuid = value;
            }

            pairs.Add($"{name}={value}");
        }

        return haveSession ? (string.Join("; ", pairs), orgUuid) : (null, orgUuid);
    }

    private static async Task<SessionUsageResult> RequestUsageAsync(
        string cookieHeader,
        string orgUuid,
        CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var url = string.Format(UsagePathTemplate, orgUuid);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
        // Must match the desktop app's own Electron user-agent: the cf_clearance
        // cookie we forward is bound to the UA that minted it, so a generic
        // browser UA gets the request rejected at Cloudflare with a 403.
        request.Headers.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.22209.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36");
        request.Headers.TryAddWithoutValidation("Origin", "https://claude.ai");
        request.Headers.TryAddWithoutValidation("Referer", "https://claude.ai/");
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Headers.TryAddWithoutValidation("anthropic-client-platform", "web_claude_ai");

        try
        {
            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                return new SessionUsageResult(
                    null, orgUuid, "The Claude app's session was rejected — open the app once to refresh it.", false);
            }

            if (!response.IsSuccessStatusCode)
            {
                return new SessionUsageResult(
                    null, orgUuid, $"claude.ai returned {(int)response.StatusCode}.", false);
            }

            var json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return new SessionUsageResult(json, orgUuid, "Updated from the Claude app session.", true);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            return new SessionUsageResult(null, orgUuid, "Couldn't reach claude.ai.", false);
        }
    }

    private static bool IsAscii(string value)
    {
        foreach (var ch in value)
        {
            if (ch is < (char)0x20 or > (char)0x7e)
            {
                return false;
            }
        }

        return true;
    }
}
