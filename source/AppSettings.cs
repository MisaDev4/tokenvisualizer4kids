using System.Text.Json;
using Microsoft.Win32;

namespace TokenTracker;

/// <summary>One user-configured scan folder. <c>Client</c> is the label rows get
/// filed under ("claude" or "codex").</summary>
public sealed class ExtraSourceRoot
{
    public string Path { get; set; } = string.Empty;

    public string Client { get; set; } = "claude";
}

public sealed class AppSettings
{
    public int ReconcileSeconds { get; set; } = 60;

    public bool StartWithWindows { get; set; }

    public string SelectedRange { get; set; } = "currentMonth";

    public string SelectedBars { get; set; } = "auto";

    public string SelectedTab { get; set; } = "dashboard";

    public string SelectedDashPanel { get; set; } = "models";

    /// <summary>How the Agents page draws the orchestrator → subagent trees:
    /// "list", "map", "lanes", or "tiles".</summary>
    public string SelectedAgentsView { get; set; } = "tiles";

    /// <summary>Tile flavor for the Agents page's tiles view:
    /// "cozy", "meter", "mini", or "rich".</summary>
    public string SelectedTilesStyle { get; set; } = "cozy";

    public string SelectedLiveWindow { get; set; } = "w5";

    public string SelectedLiveMetric { get; set; } = "cost";

    public string HeatmapView { get; set; } = "year";

    public string HeatmapMetric { get; set; } = "tokens";

    public string InsightsRange { get; set; } = "last30";

    public bool HidePersonalData { get; set; }

    /// <summary>Which limit meters the dashboard hero shows. The Limits page
    /// always lists every row regardless of these.</summary>
    public bool ShowHeroSessionLimit { get; set; } = true;

    public bool ShowHeroWeeklyLimit { get; set; } = true;

    public bool ShowHeroScopedLimit { get; set; } = true;

    /// <summary>A quiet stretch at least this long separates two work sessions
    /// for the dashboard's Session range.</summary>
    public double SessionGapHours { get; set; } = 4;

    /// <summary>When set, the Session range starts at this moment (Unix ms)
    /// instead of the automatic break detection — "count my session from 10 AM".
    /// Null means automatic. Set and cleared from the dashboard's session line.</summary>
    public long? ManualSessionStartMs { get; set; }

    /// <summary>AWS credits on the GPU tab. AWS has no API for a promotional
    /// credit's remaining balance, so the user enters the console's number once:
    /// the balance, the day they read it, and the grant's expiry. Remaining is
    /// then baseline minus what Cost Explorer says was applied since that day.</summary>
    public double AwsCreditBaselineUsd { get; set; }

    public string AwsCreditBaselineDate { get; set; } = "";

    public string AwsCreditExpiry { get; set; } = "";

    /// <summary>Cached Cost Explorer answer — each query costs $0.01, so the
    /// tab asks at most once every six hours and keeps the last answer here.</summary>
    public double AwsCreditsSinceBaselineUsd { get; set; }

    public double AwsCreditsMonthUsd { get; set; }

    /// <summary>Per-service slices of the credit burn: Bedrock token spend vs
    /// EC2 compute. Whatever the totals hold beyond these two is "other".</summary>
    public double AwsCreditsSinceTokensUsd { get; set; }

    public double AwsCreditsSinceGpuUsd { get; set; }

    public double AwsCreditsMonthTokensUsd { get; set; }

    public double AwsCreditsMonthGpuUsd { get; set; }

    public long AwsCreditsCheckedMs { get; set; }

    /// <summary>Extra folders to scan for Claude/Codex-shaped JSONL beyond the
    /// standard <c>~/.claude</c> and <c>~/.codex</c> locations. Edit
    /// settings.json by hand; <c>~</c> and <c>%VAR%</c> are expanded, missing
    /// folders are skipped, and <c>Client</c> defaults to "claude".</summary>
    public List<ExtraSourceRoot> ExtraSourceRoots { get; set; } = [];

    /// <summary>Scan the user profile for usage-shaped JSONL in new places so a
    /// fresh project or harness is tracked without editing settings.</summary>
    public bool AutoDiscoverSources { get; set; } = true;

    /// <summary>Folders auto-discovery found and now tracks. Managed by the app;
    /// deleting an entry makes the tracker forget it, though it returns as long
    /// as usage-shaped JSONL still lives there.</summary>
    public List<ExtraSourceRoot> DiscoveredSourceRoots { get; set; } = [];

    public bool ApiServerEnabled { get; set; } = true;

    public int ApiServerPort { get; set; } = LocalApiServer.DefaultPort;

    /// <summary>Relay Claude Code's API traffic through a local proxy so the
    /// system prompt and tool schemas — which are never written to transcripts —
    /// are captured for the transcript viewer. Sets the user-level
    /// ANTHROPIC_BASE_URL while on; sessions must start (or restart) after the
    /// relay is up to route through it.</summary>
    public bool CaptureRequestsEnabled { get; set; }

    public int CaptureProxyPort { get; set; } = RequestCaptureProxy.DefaultPort;

    /// <summary>Point Codex's rollout tracer at the data folder so runs that
    /// save no session log (`codex exec --ephemeral`) are still counted. Sets
    /// the user-level CODEX_ROLLOUT_TRACE_ROOT while on (cleared on exit);
    /// Codex processes pick it up when they start.</summary>
    public bool CodexTraceEnabled { get; set; } = true;

    /// <summary>Keep a copy of each young transcript as it is indexed, so a
    /// Live block still opens after a harness deletes its log (bot session
    /// forks and rewinds vanish seconds after they are written). Copies whose
    /// source survives a day are dropped; copies of vanished logs are gzipped
    /// and kept under the caps below.</summary>
    public bool TranscriptVaultEnabled { get; set; } = true;

    /// <summary>How long a copy of a vanished transcript is kept.</summary>
    public int TranscriptVaultKeepDays { get; set; } = 30;

    /// <summary>Total size cap for copies of vanished transcripts; the oldest
    /// losses are evicted first.</summary>
    public int TranscriptVaultMaxMb { get; set; } = 1024;

    /// <summary>Model → "#RRGGBB". A model gets a color the first time it is
    /// ever seen (family defaults first, then the least-used palette color) and
    /// keeps it forever, so charts and the live feed never repaint a model
    /// between runs. Editable in Settings → Model colors.</summary>
    public Dictionary<string, string> ModelColors { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Limits-page account cards the user clicked shut — collapsed to
    /// their one-line header, for accounts no longer in use. A card expands
    /// again when clicked, or on its own when its account becomes the
    /// signed-in one again.</summary>
    public List<string> CollapsedClaudeAccounts { get; set; } = [];

    /// <summary>The signed-in account the limits page last saw, persisted so a
    /// sign-in that happens while the app is closed still auto-expands that
    /// account's collapsed card on the next launch.</summary>
    public string? LimitsLastActiveAccountId { get; set; }

    private readonly object _saveLock = new();

    public static AppSettings Load()
    {
        AppPaths.EnsureDataDirectory();
        try
        {
            if (File.Exists(AppPaths.SettingsPath))
            {
                var settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.SettingsPath))
                    ?? new AppSettings();

                // The serializer rebuilds the dictionary with the default
                // comparer; model names must keep matching case-insensitively.
                settings.ModelColors = new Dictionary<string, string>(
                    settings.ModelColors, StringComparer.OrdinalIgnoreCase);
                return settings;
            }
        }
        catch
        {
            // Invalid settings fall back to safe defaults.
        }

        return new AppSettings();
    }

    /// <summary>The collector appends discovered roots from its worker thread
    /// while the UI thread saves on every toggle; both go through _saveLock so a
    /// save never serializes a list mid-mutation.</summary>
    public void AddDiscoveredRoot(string path, string client)
    {
        lock (_saveLock)
        {
            DiscoveredSourceRoots.Add(new ExtraSourceRoot { Path = path, Client = client });
        }

        Save();
    }

    public void Save()
    {
        AppPaths.EnsureDataDirectory();
        lock (_saveLock)
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(AppPaths.SettingsPath, json);
        }
    }
}

public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "TokenTracker";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(ValueName) is string;
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled)
        {
            var executable = Environment.ProcessPath
                ?? throw new InvalidOperationException("Could not determine the application path.");
            key.SetValue(ValueName, $"\"{executable}\"");
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
