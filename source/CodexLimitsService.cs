using System.IO;
using System.Text.Json;

namespace TokenTracker;

/// <summary>
/// Surfaces the ChatGPT account Codex is signed into on this machine, with the
/// official rate-limit percentages OpenAI's backend reports. Everything is read
/// locally: identity comes from ~/.codex/auth.json (the id_token's claims carry
/// the email and plan), and the limit numbers ride Codex's own session rollouts —
/// every turn's token_count event includes the server's rate_limits snapshot.
/// No network calls, no token refreshes; nothing here can log Codex out.
/// </summary>
public sealed class CodexLimitsService
{
    /// <summary>A snapshot this fresh means Codex is in use right now.</summary>
    private const long ActiveWindowMs = 1_800_000;

    /// <summary>The first scan walks newest-first until it finds a snapshot;
    /// this caps how deep it digs through snapshot-less rollouts (subagent
    /// sessions can go many files without a token_count).</summary>
    private const int InitialScanMaxFiles = 60;

    /// <summary>Once the first snapshot is found, files written within this
    /// window before it are still scanned — a concurrent session's rollout can
    /// hold a fresher snapshot than the most recently touched file.</summary>
    private const long ConcurrentSessionSlackMs = 600_000;

    public string CodexHome { get; init; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".codex");

    private sealed record Window(string Label, double UsedPercent, double WindowMinutes, long? ResetsAtMs);

    private sealed record Snapshot(long AtMs, IReadOnlyList<Window> Windows);

    private Snapshot? _snapshot;
    private long _scanWatermarkMs;
    private bool _scannedOnce;

    /// <summary>The Codex sign-in as an account row, or empty when Codex has
    /// never signed in here (API-key-only auth included — a key has no
    /// subscription limits to show).</summary>
    public Task<IReadOnlyList<ClaudeAccountLimits>> FetchAllAsync(CancellationToken cancellationToken = default) =>
        Task.Run<IReadOnlyList<ClaudeAccountLimits>>(() =>
        {
            var identity = ReadIdentity();
            if (identity is not { } account)
            {
                return [];
            }

            try
            {
                ScanSessions(cancellationToken);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Keep the last snapshot; the next tick rescans.
            }

            var now = DateTimeOffset.UtcNow;
            var nowMs = now.ToUnixTimeMilliseconds();
            var limits = (_snapshot?.Windows ?? [])
                .Select(window => RollForward(window, now))
                .ToList();
            return
            [
                new ClaudeAccountLimits(
                    account.Id,
                    account.Email,
                    account.Plan,
                    RateLimitTier: null,
                    IsActive: _snapshot is { } fresh && nowMs - fresh.AtMs < ActiveWindowMs,
                    Stale: false,
                    FetchedAt: _snapshot is { } seen
                        ? DateTimeOffset.FromUnixTimeMilliseconds(seen.AtMs)
                        : null,
                    CooldownUntil: null,
                    limits,
                    Provider: "openai")
            ];
        }, cancellationToken);

    // ── Identity ───────────────────────────────────────────────────────────

    private readonly record struct CodexIdentity(string Id, string Email, string? Plan);

    /// <summary>Reads ~/.codex/auth.json and decodes the id_token's claims —
    /// the same fields Codex itself trusts for "who am I / what plan".</summary>
    private CodexIdentity? ReadIdentity()
    {
        try
        {
            var path = Path.Combine(CodexHome, "auth.json");
            if (!File.Exists(path))
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (!document.RootElement.TryGetProperty("tokens", out var tokens) ||
                tokens.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var idToken = StringOf(tokens, "id_token");
            if (string.IsNullOrEmpty(idToken))
            {
                return null;
            }

            var claims = DecodeJwtPayload(idToken);
            if (claims is null)
            {
                return null;
            }

            using var payload = claims;
            var email = StringOf(payload.RootElement, "email") ?? "ChatGPT account";
            string? plan = null;
            if (payload.RootElement.TryGetProperty("https://api.openai.com/auth", out var auth) &&
                auth.ValueKind == JsonValueKind.Object)
            {
                plan = StringOf(auth, "chatgpt_plan_type");
            }

            var id = StringOf(tokens, "account_id") ?? $"openai:{email}";
            return new CodexIdentity(id, email, plan);
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The JWT's middle segment as parsed JSON, or null if it doesn't
    /// decode. Signature deliberately unverified — this is the user's own local
    /// credential, read for display only.</summary>
    private static JsonDocument? DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2)
        {
            return null;
        }

        try
        {
            var base64 = parts[1].Replace('-', '+').Replace('_', '/');
            var padded = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
            return JsonDocument.Parse(Convert.FromBase64String(padded));
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            return null;
        }
    }

    // ── Rate-limit snapshots from session rollouts ─────────────────────────

    /// <summary>Scans rollout files for the newest rate_limits event. After the
    /// first pass only files written since the previous scan are read, so the
    /// steady-state cost is one directory walk plus whatever Codex just wrote.</summary>
    private void ScanSessions(CancellationToken cancellationToken)
    {
        var sessionsDir = Path.Combine(CodexHome, "sessions");
        if (!Directory.Exists(sessionsDir))
        {
            return;
        }

        var candidates = new DirectoryInfo(sessionsDir)
            .EnumerateFiles("rollout-*.jsonl", SearchOption.AllDirectories)
            .Select(file => (file.FullName,
                Ms: new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero).ToUnixTimeMilliseconds()))
            .Where(file => file.Ms > _scanWatermarkMs)
            .OrderByDescending(file => file.Ms)
            .ToList();

        var scanned = 0;
        long? foundAtFileMs = null;
        foreach (var (path, fileMs) in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!_scannedOnce)
            {
                // First pass: dig until the first hit, then only sweep the
                // window a concurrent session could still be writing into.
                if (foundAtFileMs is { } found)
                {
                    if (fileMs < found - ConcurrentSessionSlackMs)
                    {
                        break;
                    }
                }
                else if (++scanned > InitialScanMaxFiles)
                {
                    break;
                }
            }

            var snapshot = LastSnapshotIn(path, fileMs);
            if (snapshot is null)
            {
                continue;
            }

            foundAtFileMs ??= fileMs;
            if (_snapshot is null || snapshot.AtMs > _snapshot.AtMs)
            {
                _snapshot = snapshot;
            }
        }

        if (candidates.Count > 0)
        {
            _scanWatermarkMs = Math.Max(_scanWatermarkMs, candidates[0].Ms);
        }

        _scannedOnce = true;
    }

    /// <summary>The last rate_limits event in one rollout file, or null.</summary>
    private static Snapshot? LastSnapshotIn(string path, long fileMs)
    {
        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            string? bestLine = null;
            while (reader.ReadLine() is { } line)
            {
                if (line.Contains("\"rate_limits\"", StringComparison.Ordinal))
                {
                    bestLine = line;
                }
            }

            return bestLine is null ? null : ParseSnapshot(bestLine, fileMs);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static Snapshot? ParseSnapshot(string line, long fileMs)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("payload", out var payload) ||
                payload.ValueKind != JsonValueKind.Object ||
                !payload.TryGetProperty("rate_limits", out var rateLimits) ||
                rateLimits.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var atMs = root.TryGetProperty("timestamp", out var timestamp) &&
                       timestamp.ValueKind == JsonValueKind.String &&
                       DateTimeOffset.TryParse(timestamp.GetString(), out var parsed)
                ? parsed.ToUnixTimeMilliseconds()
                : fileMs;

            var windows = new List<Window>();
            AddWindow(windows, rateLimits, "primary", atMs);
            AddWindow(windows, rateLimits, "secondary", atMs);
            return windows.Count > 0 ? new Snapshot(atMs, windows) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void AddWindow(List<Window> windows, JsonElement rateLimits, string name, long atMs)
    {
        if (!rateLimits.TryGetProperty(name, out var window) || window.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var usedPercent = NumberOf(window, "used_percent") ?? 0;
        var windowMinutes = NumberOf(window, "window_minutes") ?? 10_080;

        // Newer Codex reports an absolute resets_at (unix seconds); older
        // builds reported resets_in_seconds relative to the event.
        long? resetsAtMs = NumberOf(window, "resets_at") is { } absolute
            ? (long)absolute * 1000
            : NumberOf(window, "resets_in_seconds") is { } relative
                ? atMs + (long)relative * 1000
                : null;

        windows.Add(new Window(LabelFor(windowMinutes), usedPercent, windowMinutes, resetsAtMs));
    }

    /// <summary>Labels a window by its length using the same vocabulary as the
    /// Claude rows ("5h", "Week"), so the shared UI titles both providers.</summary>
    private static string LabelFor(double minutes) => minutes switch
    {
        <= 0 => "Week",
        < 1440 => $"{Math.Max(1, Math.Round(minutes / 60))}h",
        < 10_080 => $"{Math.Round(minutes / 1440)}d",
        _ => "Week"
    };

    /// <summary>Snapshots only update while Codex runs, so an idle machine's
    /// numbers can outlive their window. Once a reset time passes that window's
    /// usage is 0 — short windows go idle, weekly ones advance on schedule.</summary>
    private static ClaudeLimit RollForward(Window window, DateTimeOffset now)
    {
        DateTimeOffset? resetsAt = window.ResetsAtMs is { } ms
            ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
            : null;
        if (resetsAt is not { } due || due > now)
        {
            return new ClaudeLimit(window.Label, window.UsedPercent, "normal", resetsAt);
        }

        if (window.WindowMinutes < 1440)
        {
            // Short windows start with the first request, so an idle account
            // has no scheduled next reset.
            return new ClaudeLimit(window.Label, 0, "normal", null);
        }

        var period = TimeSpan.FromMinutes(window.WindowMinutes);
        var missed = (now - due).Ticks / period.Ticks + 1;
        return new ClaudeLimit(window.Label, 0, "normal", due + TimeSpan.FromTicks(period.Ticks * missed));
    }

    private static double? NumberOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetDouble()
            : null;

    private static string? StringOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
