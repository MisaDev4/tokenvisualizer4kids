using System.ComponentModel;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Brush = System.Windows.Media.Brush;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;
using Path = System.IO.Path;
using RadioButton = System.Windows.Controls.RadioButton;
using Rectangle = System.Windows.Shapes.Rectangle;
using Size = System.Windows.Size;

namespace TokenTracker;

public partial class MainWindow : Window
{
    private static readonly CultureInfo Usd = CultureInfo.GetCultureInfo("en-US");

    private readonly AppSettings _settings;
    private readonly PricingService _pricing;
    private readonly UsageDatabase _database;
    private readonly UsageCollector _collector;
    private readonly ClaudeLimitsService _limitsService = new();
    private readonly TerminalStatusService _terminalsService = new();
    private readonly SessionTitleService _sessionTitles = new();
    private readonly LocalApiServer _apiServer;
    private readonly SemaphoreSlim _dashboardLock = new(1, 1);
    private bool _terminalsScanning;
    private bool _loaded;
    private bool _disposed;
    private string _rangeKey = "last7";
    private string _metricKey = "cost";
    private string _barsKey = "auto";
    private DashboardData? _latestData;
    private bool _haveLimits;
    private bool _limitsRefreshing;
    private bool _sessionRefreshing;

    /// <summary>Id of the account shown in the compact bar. The manual session
    /// refresh routes by org id, so this only detects when its numbers landed
    /// on a different account than the one on screen.</summary>
    private string? _currentAccountId;
    private bool _heatmapRefreshing;
    private string _heatmapViewKey = "year";
    private string _heatmapMetricKey = "tokens";
    private bool _insightsRefreshing;
    private string _insightsRangeKey = "last30";
    private double? _planMonthlyUsd;

    // ── Live view state ────────────────────────────────────────────────────
    private string _tabKey = "dashboard";
    private string _liveWindowKey = "w5";
    private string _liveMetricKey = "cost";
    private string _dashPanelKey = "models";

    /// <summary>The cup is on screen: the Live tab, or the dashboard with its live panel.</summary>
    private bool LiveViewVisible =>
        _tabKey == "live" || (_tabKey == "dashboard" && _dashPanelKey == "live");

    /// <summary>Endless mode: rounds never settle, the pile only grows.</summary>
    private bool IsEndless => _liveWindowKey == "inf";
    private long _liveWindowMs = 300_000;
    private bool _livePulling;
    private bool _cupLayoutDirty;
    private bool _liveFramesActive;
    private long _lastFrameTicks;

    // Cup rounds: fill for the round length, then the pile settles into a
    // frozen layer, the floor rises, and the next round stacks on top —
    // scroll down through the sediment to see past runs. Live state runs in
    // the background regardless of the visible tab.
    private bool _liveStarted;
    private long _roundStartMs;
    private double? _lastRoundCost;
    private double _bestRoundCost;
    private long? _lastRoundTokens;
    private long _bestRoundTokens;
    private double _activeCupScale = 1;
    private System.Windows.Shapes.Path? _cupWalls;
    private readonly List<CupLayer> _cupLayers = [];
    private readonly List<(DateTime EndedAt, double Cost, long Tokens)> _roundHistory = [];

    // Arrival cursor for the live pull: a longer round must not re-ingest
    // events that already settled into layers.
    private long _cupLastSeenMs;

    // Recent-context chips: a session's context is the prompt side of its
    // newest response (input + cache read + cache write). Thresholds are on the
    // way to the typical 200k window — amber at half, red at three quarters.
    private const long ContextLookbackMs = 30 * 60_000;
    private const long ContextWarnTokens = 100_000;
    private const long ContextHighTokens = 150_000;
    private const int MaxContextChips = 8;

    // Over-limit tier: from here single replies can run into dollars. Shown
    // loudly wherever the session appears — no popups or toasts, the dashboard
    // itself is the alert surface.
    private const long ContextCriticalTokens = 300_000;

    // Chip garbage collection: a session whose terminal has closed no longer
    // holds that context in memory, so its chip drops after this short grace
    // instead of lingering for the whole lookback. Sessions that never map to
    // an open terminal (bench trials, the desktop app) get the same leash —
    // while they keep producing responses they stay fresh and keep their chip.
    private const long ContextClosedGraceMs = 3 * 60_000;
    private Dictionary<string, TerminalStatus> _terminalsBySession = new(StringComparer.OrdinalIgnoreCase);

    // The chip list only re-renders when a session's context actually moves;
    // rebuilding every 250 ms tick would close any open chip tooltip.
    private string _contextChipsSignature = "";

    /// <summary>One settled round: its blocks stay packed below the active floor.</summary>
    private sealed class CupLayer
    {
        public required List<LiveBubble> Blocks { get; init; }
        public required DateTime EndedAt { get; init; }
        public required double Cost { get; init; }
        public required long Tokens { get; init; }
        public required double Scale { get; init; }
        public required Line Divider { get; init; }
        public required TextBlock Caption { get; init; }
        public double Height { get; set; }
    }
    private readonly Dictionary<string, LiveBubble> _cupBubbles = new(StringComparer.Ordinal);
    private readonly System.Windows.Threading.DispatcherTimer _liveTimer;

    private sealed class LiveBubble
    {
        public required LiveEventRow Event { get; set; }
        public required FrameworkElement Visual { get; set; }
        public required long FirstSeenMs { get; init; }
        public required long SpawnedAtMs { get; init; }
        public double Cost { get; set; }
        public TextBlock? Label { get; set; }

        // Cup mode: shelf-packing target and the animated current position.
        public double TargetX { get; set; }
        public double TargetY { get; set; }
        public double Side { get; set; }
        public double CurrentX { get; set; } = double.NaN;
        public double CurrentY { get; set; } = double.NaN;

        // Part of a settled layer: packed below the active round's floor.
        public bool Frozen { get; set; }
    }

    // Chart colors follow the model, not its current rank: slots are assigned on first
    // sight and kept for the session, so switching ranges never repaints a model.
    private const int MaxModelSlots = 5;

    // Mirrors UsageDatabase.MaxBuckets: bar sizes that would exceed it are disabled.
    private const int MaxChartBars = 1500;
    private readonly Dictionary<string, int> _modelSlots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Brush[] _seriesBrushes;
    private readonly Brush _otherBrush;

    private static readonly IntervalChoice[] Intervals =
    [
        new(10, "Every 10 seconds"),
        new(30, "Every 30 seconds"),
        new(60, "Every minute"),
        new(300, "Every 5 minutes"),
        new(900, "Every 15 minutes")
    ];

    private sealed record SessionGapChoice(double Hours, string Label)
    {
        public override string ToString() => Label;
    }

    private static readonly SessionGapChoice[] SessionGaps =
    [
        new(1, "1 hour of quiet"),
        new(2, "2 hours of quiet"),
        new(3, "3 hours of quiet"),
        new(4, "4 hours of quiet"),
        new(6, "6 hours of quiet"),
        new(8, "8 hours of quiet"),
        new(12, "12 hours of quiet")
    ];

    /// <summary>Span of the current session per the latest dashboard fetch;
    /// null before the first Session-range fetch (or when there is no data).</summary>
    private long? _sessionSpanMs;

    public MainWindow()
    {
        InitializeComponent();
        _seriesBrushes =
        [
            (Brush)FindResource("Series1Brush"),
            (Brush)FindResource("Series2Brush"),
            (Brush)FindResource("Series3Brush"),
            (Brush)FindResource("Series4Brush"),
            (Brush)FindResource("Series5Brush")
        ];
        _otherBrush = (Brush)FindResource("OtherSeriesBrush");
        _settings = AppSettings.Load();
        _pricing = new PricingService();
        _database = new UsageDatabase();
        _collector = new UsageCollector(_database, _settings);
        _collector.ProgressChanged += Collector_ProgressChanged;
        _collector.DataChanged += Collector_DataChanged;
        _collector.Error += Collector_Error;
        _apiServer = new LocalApiServer(_database, _pricing);

        _rangeKey = NormalizeRangeKey(_settings.SelectedRange);
        RangeRadioFor(_rangeKey).IsChecked = true;
        _barsKey = NormalizeBarsKey(_settings.SelectedBars);
        UpdateBarsAvailability();
        BarsRadioFor(_barsKey).IsChecked = true;

        // Bookkeeping only (expiry, counters, legend); positions are animated
        // per rendered frame via CompositionTarget.Rendering at display rate.
        _liveTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(250)
        };
        _liveTimer.Tick += AdvanceLive;
        _liveWindowKey = NormalizeLiveWindowKey(_settings.SelectedLiveWindow);
        LiveWindowRadioFor(_liveWindowKey).IsChecked = true;
        _liveMetricKey = _settings.SelectedLiveMetric == "tokens" ? "tokens" : "cost";
        (_liveMetricKey == "tokens" ? LiveMetricTokens : LiveMetricCost).IsChecked = true;
        UpdateLiveWindowLabels();
        _heatmapViewKey = _settings.HeatmapView == "detail" ? "detail" : "year";
        (_heatmapViewKey == "detail" ? HeatmapDetail : HeatmapYear).IsChecked = true;
        _heatmapMetricKey = _settings.HeatmapMetric == "cost" ? "cost" : "tokens";
        (_heatmapMetricKey == "cost" ? HeatmapCost : HeatmapTokens).IsChecked = true;
        _insightsRangeKey = NormalizeInsightsRangeKey(_settings.InsightsRange);
        InsightsRangeRadioFor(_insightsRangeKey).IsChecked = true;
        // The old Multi tab became the dashboard's live panel toggle.
        if (_settings.SelectedTab == "multi")
        {
            _settings.SelectedTab = "dashboard";
            _settings.SelectedDashPanel = "live";
        }

        _dashPanelKey = _settings.SelectedDashPanel == "live" ? "live" : "models";
        (_dashPanelKey == "live" ? PanelLive : PanelModels).IsChecked = true;
        _tabKey = NormalizeTabKey(_settings.SelectedTab);
        TabRadioFor(_tabKey).IsChecked = true;

        IntervalComboBox.ItemsSource = Intervals;
        IntervalComboBox.SelectedItem = Intervals
            .OrderBy(interval => Math.Abs(interval.Seconds - _settings.ReconcileSeconds))
            .First();
        SessionGapComboBox.ItemsSource = SessionGaps;
        SessionGapComboBox.SelectedItem = SessionGaps
            .OrderBy(choice => Math.Abs(choice.Hours - _settings.SessionGapHours))
            .First();
        try
        {
            StartupCheckBox.IsChecked = StartupRegistration.IsEnabled();
        }
        catch
        {
            StartupCheckBox.IsChecked = false;
        }

        PrivacyCheckBox.IsChecked = _settings.HidePersonalData;
        HeroSessionCheckBox.IsChecked = _settings.ShowHeroSessionLimit;
        HeroWeeklyCheckBox.IsChecked = _settings.ShowHeroWeeklyLimit;
        HeroScopedCheckBox.IsChecked = _settings.ShowHeroScopedLimit;
        ApplyHeroLimitVisibility();
        ApiCheckBox.IsChecked = _settings.ApiServerEnabled;
        if (_settings.ApiServerEnabled)
        {
            _apiServer.Start(_settings.ApiServerPort);
        }

        UpdateApiStatusText();
        DatabasePathText.Text = $"Local index: {DisplayLocalPath(_database.DatabasePath)}";

        // Keeps short ranges live: the window slides and the newest bucket fills in
        // even when no file event happens to trigger a collector refresh.
        var liveRefresh = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(30)
        };
        liveRefresh.Tick += async (_, _) =>
        {
            if (_loaded && IsVisible)
            {
                await RefreshDashboardAsync();
                if (_tabKey == "insights")
                {
                    await RefreshInsightsAsync();
                }
            }
        };
        liveRefresh.Start();

        // The tick only redraws (roll-forward, reset progress) at this rate;
        // ClaudeLimitsService paces the actual network fetches per account
        // and backs off when the usage endpoint answers 429.
        var limitsRefresh = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(60)
        };
        limitsRefresh.Tick += async (_, _) => await RefreshLimitsAsync();
        limitsRefresh.Start();

        // Terminal states flip in seconds (a turn ends, a prompt is answered),
        // so this polls faster than the other feeds; the scan only tails a
        // handful of recently touched transcript files.
        var terminalsRefresh = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(3)
        };
        terminalsRefresh.Tick += async (_, _) => await RefreshTerminalsAsync();
        terminalsRefresh.Start();
    }

    private async Task RefreshTerminalsAsync()
    {
        if (_terminalsScanning)
        {
            return;
        }

        _terminalsScanning = true;
        try
        {
            var terminals = await _terminalsService.ScanAsync(TimeSpan.FromHours(6));
            _apiServer.UpdateTerminals(terminals);
            await Task.Run(() => _sessionTitles.Refresh(terminals));

            // Session → terminal, so the live context chips can say which
            // project a session belongs to instead of a bare session id.
            var bySession = new Dictionary<string, TerminalStatus>(StringComparer.OrdinalIgnoreCase);
            foreach (var terminal in terminals)
            {
                bySession[terminal.SessionId] = terminal;
            }

            _terminalsBySession = bySession;
            if (_disposed)
            {
                return;
            }

            // A terminal is named by what its chat is about (the session's
            // first prompt); the folder name is the fallback. Two identical
            // names still get a session stub so the tiles stay tellable apart.
            var nameBySession = terminals.ToDictionary(
                status => status.SessionId,
                status => SessionTopic(status.SessionId) ?? DisplayProject(status.ProjectName),
                StringComparer.OrdinalIgnoreCase);
            var duplicateNames = nameBySession.Values
                .GroupBy(name => name, StringComparer.OrdinalIgnoreCase)
                .Where(group => group.Count() > 1)
                .Select(group => group.Key)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            TerminalsPanel.ItemsSource = terminals.Take(24).Select(status =>
            {
                var age = DateTimeOffset.UtcNow - status.LastActivity;
                var (state, text, meaning) = status.State switch
                {
                    TerminalState.Ready => (
                        (Brush)FindResource("Series2Brush"),
                        age.TotalSeconds < 60 ? "ready" : $"ready · {AgeText(age)}",
                        "Turn finished — waiting for your prompt."),
                    TerminalState.Waiting => (
                        LimitWarningBrush,
                        $"waiting · {AgeText(age)}",
                        "Mid-turn but quiet — possibly a permission prompt or a long tool."),
                    _ => (
                        (Brush)FindResource("AccentBrush"),
                        "working…",
                        "Mid-turn: the model is generating or running tools.")
                };
                var displayName = DisplayProject(status.ProjectName);
                var baseName = nameBySession[status.SessionId];
                var name = duplicateNames.Contains(baseName)
                    ? $"{baseName} · {status.SessionId[..Math.Min(4, status.SessionId.Length)]}"
                    : baseName;
                var displayPath = HidePersonal
                    ? $@"~\…\{displayName}"
                    : status.ProjectPath;
                var (iconGeometry, iconBrush, appName) = status.App == TerminalApp.Codex
                    ? (OpenAiIconGeometry, OpenAiIconBrush, "Codex")
                    : (AnthropicIconGeometry, AnthropicIconBrush, "Claude Code");
                return new TerminalTileVm(
                    name,
                    text,
                    state,
                    state,
                    EdgeBrushFor(state),
                    iconGeometry,
                    iconBrush,
                    displayPath,
                    $"{appName} · {displayPath}\n{meaning}{SessionPromptLines(status.SessionId)}\nlast activity {status.LastActivity.ToLocalTime():h:mm:ss tt} · session {status.SessionId[..Math.Min(8, status.SessionId.Length)]}" +
                        (status.Pid > 0 ? "\n\nClick to bring this terminal to the front." : ""),
                    status.Pid,
                    status.Pid > 0 ? System.Windows.Input.Cursors.Hand : System.Windows.Input.Cursors.Arrow);
            }).ToList();

            var ready = terminals.Count(status => status.State == TerminalState.Ready);
            var working = terminals.Count(status => status.State == TerminalState.Working);
            var waiting = terminals.Count(status => status.State == TerminalState.Waiting);
            TerminalsSubtitle.Text =
                $"{ready} ready · {working} working · {waiting} waiting · " +
                $"open terminals, matched to running Claude Code and Codex processes";
            TerminalsEmpty.Visibility = terminals.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _terminalsScanning = false;
        }
    }

    /// <summary>The tile outline: the state color at a whisper.</summary>
    private static Brush EdgeBrushFor(Brush state)
    {
        if (state is not SolidColorBrush solid)
        {
            return state;
        }

        var color = solid.Color;
        var edge = new SolidColorBrush(Color.FromArgb(70, color.R, color.G, color.B));
        edge.Freeze();
        return edge;
    }

    private static string AgeText(TimeSpan age) => age.TotalHours >= 1
        ? $"{(int)age.TotalHours}h {age.Minutes}m"
        : $"{Math.Max(1, (int)age.TotalMinutes)}m";

    private sealed record TerminalTileVm(
        string Name,
        string StatusText,
        Brush StatusBrush,
        Brush DotBrush,
        Brush EdgeBrush,
        Geometry IconGeometry,
        Brush IconBrush,
        string PathText,
        string Tooltip,
        int Pid,
        System.Windows.Input.Cursor Cursor);

    /// <summary>One line of truth about how live an account's numbers are —
    /// being signed in no longer hides a feed that can't actually update.</summary>
    private static string AccountStatusText(ClaudeAccountLimits account)
    {
        var status = account.IsActive
            ? account.Stale
                ? account.FetchedAt is { } fetched
                    ? $"signed in to Claude Code now · limits last updated {fetched.LocalDateTime:h:mm tt}"
                    : "signed in to Claude Code now · limits not fetched yet"
                : "signed in to Claude Code now"
            : account.Stale
                ? account.FetchedAt is { } reached
                    ? $"stale — last reached {reached.LocalDateTime:h:mm tt}, updates on its next sign-in"
                    : "stale — waiting for its next sign-in"
                : "tracked in the background";

        // An open 429 cooldown always shows — it is the reason the numbers
        // are paused, and hiding it made the feed look silently broken.
        return account.CooldownUntil is { } cooldown
            ? $"{status} · rate limited by Anthropic — retries {cooldown.LocalDateTime:h:mm tt}"
            : status;
    }

    private async Task RefreshLimitsAsync()
    {
        if (_limitsRefreshing)
        {
            return;
        }

        _limitsRefreshing = true;
        try
        {
            try
            {
                await RefreshUsageHeatmapAsync();
            }
            catch
            {
                // Keep the last drawn grid; the next tick retries.
            }

            var accounts = await _limitsService.FetchAllAsync();
            _apiServer.UpdateLimits(accounts);
            if (_disposed)
            {
                return;
            }

            if (accounts.Count == 0)
            {
                // Keep whatever was last shown; only the never-signed-in case
                // gets the explainer on the limits page.
                LimitsPageEmpty.Visibility = _haveLimits ? Visibility.Collapsed : Visibility.Visible;
                return;
            }

            _haveLimits = true;
            LimitsPageEmpty.Visibility = Visibility.Collapsed;

            // Known subscription spend on this machine, for the insights page's
            // plan-value comparison. Accounts with unknown plans contribute nothing.
            var planTotal = accounts.Sum(account => PlanMonthlyUsd(account.Plan, account.RateLimitTier) ?? 0);
            _planMonthlyUsd = planTotal > 0 ? planTotal : null;

            // The compact top bar mirrors whichever account Claude Code is
            // signed into right now; the limits page lists every account.
            var current = accounts.FirstOrDefault(account => account.IsActive) ?? accounts[0];
            _currentAccountId = current.Id;
            var currentEmail = DisplayEmail(current.Email);
            LimitsBarAccount.Text = ShortAccountName(currentEmail);
            var dataAgeNote = current.Stale || current.CooldownUntil is not null
                ? current.FetchedAt is { } fetchedAt
                    ? $" · data from {fetchedAt.LocalDateTime:h:mm tt}"
                    : " · awaiting first fetch"
                : "";

            LimitsPanel.ItemsSource = current.Limits.Select(limit =>
            {
                var elevated = limit.Severity is "critical" or "warning" || limit.Percent >= 70;
                var barBrush = LimitBarBrush(limit);
                var resets = limit.ResetsAt is { } at
                    ? $"resets {FormatResetTime(at.ToLocalTime())}"
                    : "";
                return new LimitVm(
                    limit.Label,
                    Math.Clamp(limit.Percent / 100.0, 0, 1),
                    barBrush,
                    $"{limit.Percent:0}%",
                    elevated ? barBrush : (Brush)FindResource("InkBrush"),
                    resets,
                    $"{currentEmail} · {LimitTitle(limit.Label)} — {limit.Percent:0}% used" +
                    (resets.Length > 0 ? $" · {resets}" : "") + dataAgeNote);
            }).ToList();
            LimitsStrip.Visibility = Visibility.Visible;
            UpdateHeroLimits(current);

            // Local usage attributed per account: events that landed while the
            // account was the signed-in one (the transcripts themselves carry
            // no account identity, so the observed sign-in timeline is the map).
            var attributionSinceMs = DateTimeOffset.UtcNow.AddDays(-7).ToUnixTimeMilliseconds();
            var usageTexts = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var account in accounts)
            {
                var spans = _limitsService.SignedInSpans(account.Id, attributionSinceMs);
                if (spans.Count == 0)
                {
                    usageTexts[account.Id] = "no local usage attributed yet — starts counting while its sign-ins are observed";
                    continue;
                }

                var (cost, tokens) = await _database.GetClaudeUsageInSpansAsync(spans, _pricing);
                usageTexts[account.Id] =
                    $"≈ {FormatMoney(cost)} · {FormatCompact(tokens)} tok of local usage attributed · last 7 days";
            }

            if (_disposed)
            {
                return;
            }

            LimitsDetailList.ItemsSource = accounts.Select(account => new AccountVm(
                DisplayEmail(account.Email),
                PlanLabel(account.Plan, account.RateLimitTier),
                AccountStatusText(account),
                account.IsActive ? (Brush)FindResource("AccentBrush") : (Brush)FindResource("MutedBrush"),
                usageTexts.GetValueOrDefault(account.Id, ""),
                account.Limits.Select(limit =>
                {
                    // The thin bar under the usage bar: how far through the
                    // limit window we are, i.e. how close the reset is.
                    double resetShare = 0;
                    var resetTooltip = "";
                    if (limit.ResetsAt is { } resetsAt)
                    {
                        var period = limit.Label == "5h" ? TimeSpan.FromHours(5) : TimeSpan.FromDays(7);
                        resetShare = Math.Clamp(
                            1 - (resetsAt - DateTimeOffset.Now).TotalMilliseconds / period.TotalMilliseconds,
                            0,
                            1);
                        resetTooltip = $"{resetShare * 100:0}% of the way through this " +
                                       $"{(limit.Label == "5h" ? "5-hour window" : "week")}";
                    }

                    return new LimitDetailVm(
                        LimitTitle(limit.Label),
                        limit.ResetsAt is { } at ? FormatResetDetail(at)
                            : limit is { Label: "5h", Percent: 0 }
                                ? "idle — a new 5-hour window starts with the next message"
                                : "reset time unknown",
                        $"{limit.Percent:0}%",
                        LimitBarBrush(limit),
                        Math.Clamp(limit.Percent / 100.0, 0, 1),
                        LimitBarBrush(limit),
                        resetShare,
                        limit.ResetsAt is null ? Visibility.Collapsed : Visibility.Visible,
                        resetTooltip);
                }).ToList())).ToList();

            // The stamp reflects the data's age, not this render's, so a feed
            // that can't fetch (rate limited, offline) doesn't claim freshness.
            var lastFetch = accounts.Max(account => account.FetchedAt);
            LimitsPageSubtitle.Text =
                $"{accounts.Count} {(accounts.Count == 1 ? "account" : "accounts")} · " +
                $"the same numbers Claude Code shows under /usage · " +
                (lastFetch is { } at ? $"updated {at.LocalDateTime:h:mm tt}" : "no successful update yet");
        }
        finally
        {
            _limitsRefreshing = false;
        }
    }

    // ── Daily activity heatmap ─────────────────────────────────────────────

    // Heat ramp for the activity grid: a full-spectrum turbo-style scale,
    // blue → cyan → green → yellow → orange → red (weather-radar convention:
    // cold blue lows, red-hot peaks). Trades monotone lightness for the
    // maximum number of hue bands the eye can separate. Days are colored
    // continuously on a log scale anchored to the year's biggest day, so only
    // that day reaches deep red — a 200M day and a 1B day never share a color.
    private static readonly Color[] HeatStops =
    [
        Color.FromRgb(0x45, 0x5B, 0xE3),
        Color.FromRgb(0x1B, 0x95, 0xFE),
        Color.FromRgb(0x17, 0xCC, 0xD6),
        Color.FromRgb(0x3F, 0xF0, 0x96),
        Color.FromRgb(0x8C, 0xFC, 0x4E),
        Color.FromRgb(0xCF, 0xE5, 0x2A),
        Color.FromRgb(0xF9, 0xB9, 0x1E),
        Color.FromRgb(0xFA, 0x7A, 0x19),
        Color.FromRgb(0xDA, 0x39, 0x0A),
        Color.FromRgb(0xB9, 0x1E, 0x05)
    ];
    private static readonly Brush HeatEmpty = new SolidColorBrush(Color.FromRgb(0x24, 0x24, 0x23));
    private static readonly Brush HeatCellInk = new SolidColorBrush(Color.FromRgb(0x10, 0x14, 0x1A));

    /// <summary>Samples the heat ramp at t in [0, 1].</summary>
    private static Color HeatColor(double t)
    {
        var scaled = Math.Clamp(t, 0, 1) * (HeatStops.Length - 1);
        var index = Math.Min((int)scaled, HeatStops.Length - 2);
        var fraction = scaled - index;
        Color from = HeatStops[index], to = HeatStops[index + 1];
        return Color.FromRgb(
            (byte)(from.R + (to.R - from.R) * fraction),
            (byte)(from.G + (to.G - from.G) * fraction),
            (byte)(from.B + (to.B - from.B) * fraction));
    }

    /// <summary>WCAG relative luminance, for picking readable on-cell ink.</summary>
    private static double Luminance(Color color)
    {
        static double Lin(byte channel)
        {
            var s = channel / 255.0;
            return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }

        return 0.2126 * Lin(color.R) + 0.7152 * Lin(color.G) + 0.0722 * Lin(color.B);
    }

    /// <summary>Fits a day's token total inside a detail cell: "999", "45K", "1.5M", "923M", "1.2B".</summary>
    private static string CellLabel(long value) => value switch
    {
        >= 1_000_000_000 => $"{value / 1e9:0.#}B",
        >= 10_000_000 => $"{value / 1e6:0}M",
        >= 1_000_000 => $"{value / 1e6:0.#}M",
        >= 10_000 => $"{value / 1e3:0}K",
        >= 1_000 => $"{value / 1e3:0.#}K",
        _ => value.ToString()
    };

    /// <summary>Fits a day's cost inside a detail cell: "$0.42", "$5.4", "$29", "$1.2K".</summary>
    private static string CellCostLabel(double value) => value switch
    {
        >= 1000 => $"${value / 1000:0.#}K",
        >= 10 => $"${value:0}",
        >= 1 => $"${value:0.0}",
        _ => $"${value:0.00}"
    };

    private void HeatmapViewButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _heatmapViewKey && _loaded)
        {
            return;
        }

        _heatmapViewKey = key;
        if (HeatmapCanvas is null || !_loaded)
        {
            // Fired during XAML parse or from the ctor restoring the saved view.
            return;
        }

        _settings.HeatmapView = key;
        _settings.Save();
        _ = RefreshUsageHeatmapAsync();
    }

    private void HeatmapMetricButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _heatmapMetricKey && _loaded)
        {
            return;
        }

        _heatmapMetricKey = key;
        if (HeatmapCanvas is null || !_loaded)
        {
            return;
        }

        _settings.HeatmapMetric = key;
        _settings.Save();
        _ = RefreshUsageHeatmapAsync();
    }

    /// <summary>Redraws the GitHub-style grid of daily usage on the limits page.</summary>
    private async Task RefreshUsageHeatmapAsync()
    {
        if (_heatmapRefreshing)
        {
            return;
        }

        _heatmapRefreshing = true;
        try
        {
            // Detail trades the year of tiny cells for ~5 recent months of big
            // cells, each printing its day's token total.
            var detail = _heatmapViewKey == "detail";
            var cell = detail ? 34.0 : 12.0;
            var stepPx = cell + (detail ? 4 : 3);
            var weeks = detail ? 20 : 52;
            const double gutter = 30;   // Mon/Wed/Fri labels
            const double header = 16;   // month labels

            // Columns are Sunday-start weeks, the last one containing today.
            // Data always covers the full year so the summary line and the
            // intensity quartiles hold still when the view toggles.
            var today = DateTime.Today;
            var thisWeekStart = today.AddDays(-(int)today.DayOfWeek);
            var gridStart = thisWeekStart.AddDays(-7 * (weeks - 1));
            var since = new DateTimeOffset(thisWeekStart.AddDays(-7 * 51)).ToUnixTimeMilliseconds();

            var days = await _database.GetDailyUsageAsync(since, _pricing);
            if (_disposed)
            {
                return;
            }

            var byDay = days.ToDictionary(day => day.Day, StringComparer.Ordinal);

            // Intensity follows the chosen metric. Cost can be 0 for unpriced
            // models even when tokens landed; such days read as empty in cost mode.
            var costMode = _heatmapMetricKey == "cost";
            double ValueOf(DailyUsageRow day) => costMode ? day.Cost : day.Tokens;

            // Continuous log scale from the year's smallest active day to its
            // biggest: usage spans orders of magnitude, so a linear scale would
            // pin everything to the bottom, and binning would hand the top
            // bucket to dozens of days. Here only the maximum reaches t = 1.
            var active = days.Select(ValueOf).Where(value => value > 0).Order().ToList();
            var logMin = active.Count > 0 ? Math.Log(active[0]) : 0;
            var logSpan = active.Count > 0 ? Math.Max(Math.Log(active[^1]) - logMin, 1e-9) : 1;
            double HeatT(double value) => Math.Clamp((Math.Log(value) - logMin) / logSpan, 0, 1);

            var muted = (Brush)FindResource("MutedBrush");
            HeatmapCanvas.Children.Clear();
            HeatmapCanvas.Width = gutter + weeks * stepPx - (stepPx - cell);
            HeatmapCanvas.Height = header + 7 * stepPx - (stepPx - cell);

            foreach (var (row, name) in new[] { (1, "Mon"), (3, "Wed"), (5, "Fri") })
            {
                var dayLabel = new TextBlock { Text = name, FontSize = 10, Foreground = muted };
                Canvas.SetLeft(dayLabel, 0);
                Canvas.SetTop(dayLabel, header + row * stepPx + (cell - 13) / 2);
                HeatmapCanvas.Children.Add(dayLabel);
            }

            var lastMonthLabelX = double.MinValue;
            for (var week = 0; week < weeks; week++)
            {
                var weekStart = gridStart.AddDays(week * 7);
                var x = gutter + week * stepPx;

                // Label the first column of each month, skipping collisions.
                if (weekStart.Month != weekStart.AddDays(-7).Month && x - lastMonthLabelX >= 34)
                {
                    var monthLabel = new TextBlock
                    {
                        Text = weekStart.ToString("MMM"),
                        FontSize = 10,
                        Foreground = muted
                    };
                    Canvas.SetLeft(monthLabel, x);
                    Canvas.SetTop(monthLabel, 0);
                    HeatmapCanvas.Children.Add(monthLabel);
                    lastMonthLabelX = x;
                }

                for (var dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++)
                {
                    var date = weekStart.AddDays(dayOfWeek);
                    if (date > today)
                    {
                        break;
                    }

                    var usage = byDay.GetValueOrDefault(date.ToString("yyyy-MM-dd"));
                    var tokens = usage?.Tokens ?? 0;
                    var value = usage is null ? 0 : ValueOf(usage);
                    var heat = value > 0 ? HeatColor(HeatT(value)) : default;
                    var rect = new Rectangle
                    {
                        Width = cell,
                        Height = cell,
                        RadiusX = detail ? 4 : 3,
                        RadiusY = detail ? 4 : 3,
                        Fill = value == 0 ? HeatEmpty : new SolidColorBrush(heat),
                        StrokeThickness = 1,
                        ToolTip = tokens == 0
                            ? $"{date:ddd, MMM d yyyy} — no usage"
                            : $"{date:ddd, MMM d yyyy}\n{FormatCompact(tokens)} tokens · ≈ {FormatMoney(usage!.Cost)}"
                    };
                    ToolTipService.SetInitialShowDelay(rect, 150);
                    rect.MouseEnter += (_, _) => rect.Stroke = (Brush)FindResource("InkBrush");
                    rect.MouseLeave += (_, _) => rect.Stroke = null;
                    Canvas.SetLeft(rect, x);
                    Canvas.SetTop(rect, header + dayOfWeek * stepPx);
                    HeatmapCanvas.Children.Add(rect);

                    if (detail && value > 0)
                    {
                        // Dark ink once the fill outshines it; white below.
                        var valueLabel = new TextBlock
                        {
                            Text = costMode ? CellCostLabel(usage!.Cost) : CellLabel(tokens),
                            FontSize = 9,
                            FontWeight = FontWeights.SemiBold,
                            Width = cell,
                            TextAlignment = TextAlignment.Center,
                            IsHitTestVisible = false,
                            Foreground = Luminance(heat) > 0.2 ? HeatCellInk : Brushes.White
                        };
                        Canvas.SetLeft(valueLabel, x);
                        Canvas.SetTop(valueLabel, header + dayOfWeek * stepPx + (cell - 12) / 2);
                        HeatmapCanvas.Children.Add(valueLabel);
                    }
                }
            }

            if (HeatmapLegend.Children.Count == 0)
            {
                HeatmapLegend.Children.Add(new TextBlock
                {
                    Text = "Less",
                    FontSize = 10,
                    Foreground = muted,
                    Margin = new Thickness(0, 0, 6, 0),
                    VerticalAlignment = VerticalAlignment.Center
                });
                HeatmapLegend.Children.Add(new Rectangle
                {
                    Width = 10,
                    Height = 10,
                    RadiusX = 3,
                    RadiusY = 3,
                    Fill = HeatEmpty,
                    Margin = new Thickness(0, 0, 3, 0),
                    VerticalAlignment = VerticalAlignment.Center
                });
                var gradient = new LinearGradientBrush
                {
                    StartPoint = new System.Windows.Point(0, 0),
                    EndPoint = new System.Windows.Point(1, 0)
                };
                for (var stop = 0; stop < HeatStops.Length; stop++)
                {
                    gradient.GradientStops.Add(
                        new GradientStop(HeatStops[stop], stop / (double)(HeatStops.Length - 1)));
                }

                HeatmapLegend.Children.Add(new Rectangle
                {
                    Width = 72,
                    Height = 10,
                    RadiusX = 3,
                    RadiusY = 3,
                    Fill = gradient,
                    VerticalAlignment = VerticalAlignment.Center
                });
                HeatmapLegend.Children.Add(new TextBlock
                {
                    Text = "More",
                    FontSize = 10,
                    Foreground = muted,
                    Margin = new Thickness(6, 0, 0, 0),
                    VerticalAlignment = VerticalAlignment.Center
                });
            }

            var totalTokens = days.Sum(day => day.Tokens);
            var totalCost = days.Sum(day => day.Cost);
            var activeDays = $"{active.Count} active {(active.Count == 1 ? "day" : "days")}";
            HeatmapSubtitle.Text = active.Count == 0
                ? costMode && totalTokens > 0
                    ? "No cost estimated for the last year yet — the pricing feed may still be loading."
                    : "Tokens per day over the last year, all clients combined — nothing recorded yet."
                : costMode
                    ? $"≈ {FormatMoney(totalCost)} over {activeDays} in the last year · " +
                      $"busiest day {FormatMoney(active[^1])}"
                    : $"{FormatCompact(totalTokens)} tokens over {activeDays} in the last year · " +
                      $"busiest day {FormatCompact((long)active[^1])}";
        }
        finally
        {
            _heatmapRefreshing = false;
        }
    }

    /// <summary>The dashboard hero mirrors the signed-in account's three
    /// work-stopping limits, exactly as Anthropic reports them: the 5-hour
    /// session window, the all-model weekly allowance, and the per-model weekly
    /// window (Fable today). The per-model row can sit at 100% while the overall
    /// week still has room, so both weeklies are shown.</summary>
    private void UpdateHeroLimits(ClaudeAccountLimits account)
    {
        var session = account.Limits.FirstOrDefault(limit => limit.Label == "5h");
        var weekly = account.Limits.FirstOrDefault(limit => limit.Label == "Week");

        // The third meter is whatever per-model weekly window Anthropic reports
        // for this account — "Fable" today — taken in the order the API lists
        // them. Deliberately not "the fullest scoped row": which window this is
        // must not change under you just because usage shifted.
        var scoped = account.Limits.FirstOrDefault(limit => limit.Label is not ("5h" or "Week"));

        UpdateHeroLimit(session, HeroSessionLimitText, HeroSessionLimitReset, HeroSessionLimitBar, HeroSessionResetBar);
        UpdateHeroLimit(weekly, HeroWeeklyLimitText, HeroWeeklyLimitReset, HeroWeeklyLimitBar, HeroWeeklyResetBar);
        HeroScopedLimitLabel.Text = scoped is null ? "Per-model limit" : $"{scoped.Label} limit";
        UpdateHeroLimit(scoped, HeroScopedLimitText, HeroScopedLimitReset, HeroScopedLimitBar, HeroScopedResetBar);
        // The checkbox names the same window, so Settings reads "Weekly · Fable"
        // rather than describing a rule the user has to decode.
        HeroScopedCheckBox.Content = scoped is null ? "Weekly · per-model" : $"Weekly · {scoped.Label}";
        ApplyHeroLimitVisibility();
    }

    /// <summary>Shows only the meters picked in Settings. The gap between blocks
    /// rides on the block itself so whichever one lands on top sits flush, and
    /// the column plus its divider disappear when nothing is selected.</summary>
    private void ApplyHeroLimitVisibility()
    {
        var blocks = new (StackPanel Block, bool Show)[]
        {
            (HeroSessionBlock, _settings.ShowHeroSessionLimit),
            (HeroWeeklyBlock, _settings.ShowHeroWeeklyLimit),
            (HeroScopedBlock, _settings.ShowHeroScopedLimit)
        };

        var isFirstVisible = true;
        foreach (var (block, show) in blocks)
        {
            block.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
            if (!show)
            {
                continue;
            }

            block.Margin = new Thickness(0, isFirstVisible ? 0 : 9, 0, 0);
            isFirstVisible = false;
        }

        var anyVisible = blocks.Any(entry => entry.Show);
        HeroLimits.Visibility = anyVisible ? Visibility.Visible : Visibility.Collapsed;
        HeroLimitsDivider.Visibility = anyVisible ? Visibility.Visible : Visibility.Collapsed;
    }

    private void UpdateHeroLimit(
        ClaudeLimit? limit,
        TextBlock value,
        TextBlock reset,
        System.Windows.Controls.ProgressBar bar,
        System.Windows.Controls.ProgressBar resetBar)
    {
        if (limit is null)
        {
            value.Text = "—";
            value.Foreground = (Brush)FindResource("InkBrush");
            reset.Text = "";
            bar.Value = 0;
            resetBar.Visibility = Visibility.Collapsed;
            return;
        }

        var brush = LimitBarBrush(limit);
        var elevated = limit.Severity is "critical" or "warning" || limit.Percent >= 70;
        value.Text = $"{limit.Percent:0}%";
        value.Foreground = elevated ? brush : (Brush)FindResource("InkBrush");
        value.ToolTip = $"{LimitTitle(limit.Label)} — {limit.Percent:0}% used";
        reset.Text = limit.ResetsAt is { } at ? $"resets {FormatResetTime(at.ToLocalTime())}"
            : limit is { Label: "5h", Percent: 0 } ? "idle"
            : "";
        bar.Foreground = brush;
        bar.Value = Math.Clamp(limit.Percent / 100.0, 0, 1);

        // The thin bar under the usage bar: how far through the limit window
        // we are, i.e. how close the reset is — same as the limits page.
        if (limit.ResetsAt is { } resetsAtDue)
        {
            var period = limit.Label == "5h" ? TimeSpan.FromHours(5) : TimeSpan.FromDays(7);
            var resetShare = Math.Clamp(
                1 - (resetsAtDue - DateTimeOffset.Now).TotalMilliseconds / period.TotalMilliseconds,
                0,
                1);
            resetBar.Value = resetShare;
            resetBar.ToolTip = $"{resetShare * 100:0}% of the way through this " +
                               $"{(limit.Label == "5h" ? "5-hour window" : "week")}";
            resetBar.Visibility = Visibility.Visible;
        }
        else
        {
            resetBar.Visibility = Visibility.Collapsed;
        }
    }

    private Brush LimitBarBrush(ClaudeLimit limit) => limit.Severity switch
    {
        "critical" => LimitCriticalBrush,
        "warning" => LimitWarningBrush,
        _ => limit.Percent >= 90 ? LimitCriticalBrush
            : limit.Percent >= 70 ? LimitWarningBrush
            : (Brush)FindResource("AccentBrush")
    };

    private static string LimitTitle(string label) => label switch
    {
        "5h" => "5-hour session",
        "Week" => "Weekly · all models",
        _ => $"Weekly · {label}"
    };

    private static string PlanLabel(string? plan, string? tier)
    {
        var name = plan switch
        {
            "max" => "Max",
            "pro" => "Pro",
            "team" => "Team",
            "enterprise" => "Enterprise",
            null or "" => "",
            _ => $"{char.ToUpperInvariant(plan[0])}{plan[1..]}"
        };

        // Both Max plans report plan "max"; the rate-limit tier's multiplier
        // (default_claude_max_5x / _20x) is what separates $100 from $200.
        var multiplier = tier is null ? null : System.Text.RegularExpressions.Regex.Match(tier, @"_(\d+)x$");
        if (multiplier is not { Success: true } || name.Length == 0)
        {
            return name;
        }

        var price = multiplier.Groups[1].Value switch
        {
            "5" => " · $100/mo",
            "20" => " · $200/mo",
            _ => ""
        };
        return $"{name} {multiplier.Groups[1].Value}x{price}";
    }

    /// <summary>What the account's plan bills per month, when the tier makes it knowable.</summary>
    private static double? PlanMonthlyUsd(string? plan, string? tier) => plan switch
    {
        "pro" => 20,
        "max" when tier?.EndsWith("_5x", StringComparison.Ordinal) == true => 100,
        "max" when tier?.EndsWith("_20x", StringComparison.Ordinal) == true => 200,
        _ => null
    };

    // ── Hide personal data ─────────────────────────────────────────────────
    // Display-only masking for screenshots and screen shares. Each real value
    // maps to the same placeholder for the whole run, so cards and the status
    // strip stay consistent with each other.

    private readonly Dictionary<string, string> _maskedEmails = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _maskedProjects = new(StringComparer.OrdinalIgnoreCase);

    private bool HidePersonal => _settings.HidePersonalData;

    /// <summary>"acc1", "acc2", … — nothing of the real address survives, and
    /// each account keeps its number for the run so several cards still read as
    /// distinct accounts.</summary>
    private string DisplayEmail(string email)
    {
        if (!HidePersonal || string.IsNullOrEmpty(email))
        {
            return email;
        }

        if (!_maskedEmails.TryGetValue(email, out var masked))
        {
            masked = $"acc{_maskedEmails.Count + 1}";
            _maskedEmails[email] = masked;
        }

        return masked;
    }

    private string DisplayProject(string projectName)
    {
        if (!HidePersonal || string.IsNullOrEmpty(projectName))
        {
            return projectName;
        }

        if (!_maskedProjects.TryGetValue(projectName, out var masked))
        {
            masked = $"project-{_maskedProjects.Count + 1}";
            _maskedProjects[projectName] = masked;
        }

        return masked;
    }

    /// <summary>Hides the username by folding the profile directory into "~".</summary>
    private string DisplayLocalPath(string path)
    {
        if (!HidePersonal)
        {
            return path;
        }

        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return path.StartsWith(profile, StringComparison.OrdinalIgnoreCase)
            ? $"~{path[profile.Length..]}"
            : path;
    }

    private void HeroLimitCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        _settings.ShowHeroSessionLimit = HeroSessionCheckBox.IsChecked == true;
        _settings.ShowHeroWeeklyLimit = HeroWeeklyCheckBox.IsChecked == true;
        _settings.ShowHeroScopedLimit = HeroScopedCheckBox.IsChecked == true;
        _settings.Save();
        ApplyHeroLimitVisibility();
    }

    private void PrivacyCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        _settings.HidePersonalData = PrivacyCheckBox.IsChecked == true;
        _settings.Save();
        DatabasePathText.Text = $"Local index: {DisplayLocalPath(_database.DatabasePath)}";
        _ = RefreshLimitsAsync();
        _ = RefreshTerminalsAsync();
    }

    private async void SessionRefreshButton_Click(object sender, RoutedEventArgs e)
    {
        if (_sessionRefreshing)
        {
            return;
        }

        _sessionRefreshing = true;
        SessionRefreshButton.IsEnabled = false;
        SessionRefreshStatus.Visibility = Visibility.Visible;
        SessionRefreshStatus.Foreground = (Brush)FindResource("MutedBrush");
        SessionRefreshStatus.Text = "Reading the Claude app session…";
        try
        {
            var result = await _limitsService.RefreshFromSessionAsync();
            if (_disposed)
            {
                return;
            }

            // Repaint straight from the store — the session refresh already wrote
            // the fresh limits, and FetchAllAsync returns them without touching
            // the throttled usage endpoint.
            await RefreshLimitsAsync();
            SessionRefreshStatus.Foreground = result.UpdatedAccountId is not null
                ? (Brush)FindResource("InkBrush")
                : (Brush)FindResource("MutedBrush");
            SessionRefreshStatus.Text =
                result is { UpdatedAccountId: { } updatedId, UpdatedEmail: { } updatedEmail } &&
                updatedId != _currentAccountId
                    ? $"Updated {DisplayEmail(updatedEmail)} — the account the Claude app is signed into."
                    : result.Status;
        }
        catch
        {
            SessionRefreshStatus.Text = "Couldn't refresh from the Claude app session.";
        }
        finally
        {
            _sessionRefreshing = false;
            SessionRefreshButton.IsEnabled = true;
        }
    }

    private void ApiCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        _settings.ApiServerEnabled = ApiCheckBox.IsChecked == true;
        _settings.Save();
        if (_settings.ApiServerEnabled)
        {
            _apiServer.Start(_settings.ApiServerPort);
        }
        else
        {
            _apiServer.Stop();
        }

        UpdateApiStatusText();
    }

    private void UpdateApiStatusText()
    {
        ApiStatusText.Text = _apiServer.IsRunning
            ? $"Serving http://localhost:{_apiServer.Port}/api — see docs/local-api.md"
            : _apiServer.Error is { } error
                ? $"API not running: {error}"
                : "API off — other apps can't read this data.";
    }

    /// <summary>The part before the @, so the top bar stays compact.</summary>
    private static string ShortAccountName(string email)
    {
        var at = email.IndexOf('@');
        return at > 0 ? email[..at] : email;
    }

    /// <summary>"resets in 2 h 41 m · 11:39 PM" — countdown plus wall-clock time.</summary>
    private static string FormatResetDetail(DateTimeOffset at)
    {
        var local = at.ToLocalTime();
        var span = at - DateTimeOffset.Now;
        if (span <= TimeSpan.Zero)
        {
            return "resetting now";
        }

        var countdown = span.TotalHours >= 24
            ? $"{(int)span.TotalDays} d {span.Hours} h"
            : span.TotalHours >= 1
                ? $"{(int)span.TotalHours} h {span.Minutes} m"
                : $"{Math.Max(1, span.Minutes)} m";
        return $"resets in {countdown} · {FormatResetTime(local)}";
    }

    private static string FormatResetTime(DateTimeOffset local)
    {
        var now = DateTimeOffset.Now;
        return local.Date == now.Date
            ? local.ToString("h:mm tt", Usd)
            : local.ToString("ddd h:mm tt", Usd);
    }

    private static readonly Brush LimitWarningBrush = new SolidColorBrush(Color.FromRgb(0xE0, 0xA4, 0x58));
    private static readonly Brush LimitCriticalBrush = new SolidColorBrush(Color.FromRgb(0xE5, 0x53, 0x4B));

    /// <summary>Terminal tile logomarks (Simple Icons path data, 24×24):
    /// the Anthropic wordmark A in Claude clay, the OpenAI blossom in soft white.</summary>
    private static readonly Geometry AnthropicIconGeometry = Geometry.Parse(
        "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z");
    private static readonly Geometry OpenAiIconGeometry = Geometry.Parse(
        "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z");
    private static readonly Brush AnthropicIconBrush = new SolidColorBrush(Color.FromRgb(0xD9, 0x77, 0x57));
    private static readonly Brush OpenAiIconBrush = new SolidColorBrush(Color.FromRgb(0xE8, 0xE8, 0xE3));

    private sealed record LimitVm(
        string Label,
        double Share,
        Brush BarBrush,
        string PercentText,
        Brush PercentBrush,
        string ResetText,
        string Tooltip);

    private sealed record LimitDetailVm(
        string Title,
        string ResetText,
        string PercentText,
        Brush PercentBrush,
        double Share,
        Brush BarBrush,
        double ResetShare,
        Visibility ResetVisibility,
        string ResetTooltip);

    private sealed record AccountVm(
        string Email,
        string PlanText,
        string StatusText,
        Brush StatusBrush,
        string UsageText,
        List<LimitDetailVm> Limits);

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        // Dark window chrome (Windows 10 19041+).
        var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        var enabled = 1;
        _ = DwmSetWindowAttribute(handle, 20, ref enabled, sizeof(int));

        System.Windows.Interop.HwndSource.FromHwnd(handle)?.AddHook(WndProc);
    }

    private IntPtr WndProc(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == App.ShowWindowMessage &&
            System.Windows.Application.Current is App app)
        {
            app.ShowWindow();
            handled = true;
        }

        return IntPtr.Zero;
    }

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        if (_loaded)
        {
            return;
        }

        _loaded = true;
        try
        {
            await Task.WhenAll(_collector.StartAsync(), _pricing.InitializeAsync());
            await RefreshDashboardAsync();

            // Both live views start with the app, whatever tab or mode is
            // showing, so nothing ever resets on a view switch.
            StartCupRound();
            await RebuildCupLayersAsync();
            _liveStarted = true;
            _liveTimer.Start();
            _ = RefreshLimitsAsync();
            _ = RefreshTerminalsAsync();
            if (_tabKey == "insights")
            {
                _ = RefreshInsightsAsync();
            }
        }
        catch (Exception exception)
        {
            ShowError($"Could not start: {exception.Message}");
        }
    }

    public async Task RefreshNowAsync()
    {
        await _collector.RefreshNowAsync();
        await RefreshDashboardAsync();
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await RefreshNowAsync();

    private async void FullRescanButton_Click(object sender, RoutedEventArgs e)
    {
        SettingsToggle.IsChecked = false;
        await _collector.FullRescanAsync();
        await RefreshDashboardAsync();
    }

    private async void RangeButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _rangeKey && _loaded)
        {
            return;
        }

        _rangeKey = key;
        UpdateBarsAvailability();
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedRange = key;
        _settings.Save();
        await RefreshDashboardAsync();
    }

    private async void BarsButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _barsKey && _loaded)
        {
            return;
        }

        _barsKey = key;
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedBars = key;
        _settings.Save();
        await RefreshDashboardAsync();
    }

    /// <summary>
    /// Offers only the bar sizes that make sense for the selected range: fine
    /// enough to stay under the series cap, coarse enough to produce at least
    /// a few bars (1d bars on a 1h view is one bar — noise). A selection that
    /// just became invalid falls back to Auto.
    /// </summary>
    private void UpdateBarsAvailability()
    {
        var spanMs = _rangeKey == "session" ? _sessionSpanMs : RangeSpanMs(_rangeKey);
        foreach (var (radio, key) in new[]
                 {
                     (BarsS75, "s75"), (BarsS15, "s15"), (BarsS30, "s30"), (BarsM1, "m1"), (BarsM5, "m5"),
                     (BarsM15, "m15"), (BarsM30, "m30"), (BarsH1, "h1"), (BarsH4, "h4"), (BarsH12, "h12"),
                     (BarsD1, "d1")
                 })
        {
            var unitMs = BarsUnitMs(key);
            var bars = spanMs is { } span && unitMs > 0 ? span / (double)unitMs : 0;
            radio.Visibility = bars >= 3 && bars <= MaxChartBars
                ? Visibility.Visible
                : Visibility.Collapsed;
        }

        if (BarsRadioFor(_barsKey) is { Visibility: not Visibility.Visible })
        {
            _barsKey = "auto";
            BarsAuto.IsChecked = true;
            if (_loaded)
            {
                _settings.SelectedBars = _barsKey;
                _settings.Save();
            }
        }
    }

    /// <summary>Extent of the selected range in ms; null when unbounded (all time).</summary>
    private static long? RangeSpanMs(string rangeKey)
    {
        var now = DateTimeOffset.Now;
        return rangeKey switch
        {
            "last1" => 3_600_000L,
            "last4" => 4 * 3_600_000L,
            "last8" => 8 * 3_600_000L,
            "last12" => 12 * 3_600_000L,
            "last18" => 18 * 3_600_000L,
            "last24" => 24 * 3_600_000L,
            "last7" => 7 * 86_400_000L,
            "last10" => 10 * 86_400_000L,
            "last15" => 15 * 86_400_000L,
            "last30" => 30 * 86_400_000L,
            "today" => Math.Max(3_600_000L, now.ToUnixTimeMilliseconds() -
                new DateTimeOffset(now.Year, now.Month, now.Day, 0, 0, 0, now.Offset).ToUnixTimeMilliseconds()),
            "currentMonth" => Math.Max(3_600_000L, now.ToUnixTimeMilliseconds() -
                new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, now.Offset).ToUnixTimeMilliseconds()),
            _ => null
        };
    }

    private static long BarsUnitMs(string key) => key switch
    {
        "s75" => 7_500,
        "s15" => 15_000,
        "s30" => 30_000,
        "m1" => 60_000,
        "m5" => 300_000,
        "m15" => 900_000,
        "m30" => 1_800_000,
        "h1" => 3_600_000,
        "h4" => 14_400_000,
        "h12" => 43_200_000,
        "d1" => 86_400_000,
        _ => 0
    };

    private static BucketUnit? BarsUnitFor(string key) => key switch
    {
        "s75" => BucketUnit.Second7_5,
        "s15" => BucketUnit.Second15,
        "s30" => BucketUnit.Second30,
        "m1" => BucketUnit.Minute1,
        "m5" => BucketUnit.Minute5,
        "m15" => BucketUnit.Minute15,
        "m30" => BucketUnit.Minute30,
        "h1" => BucketUnit.Hour,
        "h4" => BucketUnit.Hour4,
        "h12" => BucketUnit.Hour12,
        "d1" => BucketUnit.Day,
        _ => null
    };

    // ── Live view ──────────────────────────────────────────────────────────

    private void TabButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _tabKey && _loaded)
        {
            return;
        }

        _tabKey = key;
        if (LiveRoot is null)
        {
            // Fired while the XAML is still being parsed; the ctor applies the
            // restored tab once every element exists.
            return;
        }

        ApplyTab();
        if (_loaded)
        {
            _settings.SelectedTab = key;
            _settings.Save();
        }
    }

    private void ApplyTab()
    {
        var live = _tabKey == "live";
        var limits = _tabKey == "limits";
        var terminals = _tabKey == "terminals";
        var insights = _tabKey == "insights";
        var dashboard = !live && !limits && !terminals && !insights;
        var livePanel = dashboard && _dashPanelKey == "live";
        DashboardHero.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        DashboardContent.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        RangeGroupBorder.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        LiveRoot.Visibility = live ? Visibility.Visible : Visibility.Collapsed;
        LimitsRoot.Visibility = limits ? Visibility.Visible : Visibility.Collapsed;
        TerminalsRoot.Visibility = terminals ? Visibility.Visible : Visibility.Collapsed;
        InsightsRoot.Visibility = insights ? Visibility.Visible : Visibility.Collapsed;
        ModelsCard.Visibility = livePanel ? Visibility.Collapsed : Visibility.Visible;
        PlaceLiveFeedCard(livePanel);
        PlacePanelGroup(livePanel);
        // Live state keeps running in the background; the tab switch only
        // pauses the per-frame rendering.
        if (live || livePanel)
        {
            StartLiveFrames();
        }
        else
        {
            StopLiveFrames();
        }

        if (limits && _loaded)
        {
            // Fresh numbers the moment the page opens, not up to a minute stale.
            _ = RefreshLimitsAsync();
        }

        if (terminals && _loaded)
        {
            _ = RefreshTerminalsAsync();
        }

        if (insights && _loaded)
        {
            _ = RefreshInsightsAsync();
        }
    }

    private void PanelButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _dashPanelKey && _loaded)
        {
            return;
        }

        _dashPanelKey = key;
        if (LiveRoot is null)
        {
            return;
        }

        ApplyTab();
        if (_loaded)
        {
            _settings.SelectedDashPanel = key;
            _settings.Save();
        }
    }

    private void LimitsBar_Clicked(object sender, System.Windows.Input.MouseButtonEventArgs e) =>
        TabLimits.IsChecked = true;

    /// <summary>Moves the one live feed card between the Live tab and the Multi
    /// tab's right column — same element, same state, wherever it is needed.</summary>
    private void PlaceLiveFeedCard(bool multi)
    {
        var inDashboard = ReferenceEquals(LiveFeedCard.Parent, DashboardContent);
        if (multi == inDashboard)
        {
            return;
        }

        if (multi)
        {
            LiveRoot.Children.Remove(LiveFeedCard);
            Grid.SetRow(LiveFeedCard, 0);
            Grid.SetColumn(LiveFeedCard, 2);
            DashboardContent.Children.Add(LiveFeedCard);
        }
        else
        {
            DashboardContent.Children.Remove(LiveFeedCard);
            Grid.SetRow(LiveFeedCard, 1);
            Grid.SetColumn(LiveFeedCard, 0);
            LiveRoot.Children.Add(LiveFeedCard);
        }

        // The dashboard column is too narrow for the score bars alongside the
        // toggles; the round countdown text keeps that space instead.
        RoundHistoryBars.Visibility = multi ? Visibility.Collapsed : Visibility.Visible;
        _cupLayoutDirty = true;
    }

    /// <summary>The panel toggle lives on the panel it switches: in the By model
    /// header normally, appended to the live feed card's controls while the
    /// dashboard shows the cup. On other tabs it parks (hidden) with ModelsCard,
    /// so the Live tab never shows a dashboard-only control.</summary>
    private void PlacePanelGroup(bool intoLiveHeader)
    {
        var parent = PanelGroup.Parent as System.Windows.Controls.Panel;
        if (intoLiveHeader)
        {
            if (ReferenceEquals(parent, LiveHeaderControls))
            {
                return;
            }

            parent?.Children.Remove(PanelGroup);
            PanelGroup.Margin = new Thickness(8, 0, 0, 0);
            LiveHeaderControls.Children.Add(PanelGroup);
        }
        else
        {
            if (ReferenceEquals(parent, ModelsHeaderGrid))
            {
                return;
            }

            parent?.Children.Remove(PanelGroup);
            PanelGroup.Margin = new Thickness(12, 0, 0, 0);
            Grid.SetRow(PanelGroup, 0);
            Grid.SetColumn(PanelGroup, 1);
            Grid.SetColumnSpan(PanelGroup, 1);
            ModelsHeaderGrid.Children.Add(PanelGroup);
        }

        UpdateResponsiveHeaders();
    }

    // ── Responsive headers ─────────────────────────────────────────────────

    private void ResponsiveHeader_SizeChanged(object sender, SizeChangedEventArgs e) =>
        UpdateResponsiveHeaders();

    /// <summary>
    /// Headers put controls in an Auto column beside their title, and a Grid
    /// paints overflow rather than clipping it — at narrow widths the controls
    /// would draw over the title. Each header drops its controls onto a second
    /// row while the two would collide, and lifts them back when they fit.
    /// </summary>
    private void UpdateResponsiveHeaders()
    {
        if (HeaderGrid is null || ChartHeaderGrid is null ||
            LiveFeedHeaderGrid is null || ModelsHeaderGrid is null)
        {
            return;
        }

        StackHeaderWhenNarrow(HeaderGrid, HeaderBrandPanel, HeaderActionsPanel, new Thickness(0, 12, 0, 0));
        StackHeaderWhenNarrow(ChartHeaderGrid, ChartTitle, ChartHeaderControls, new Thickness(0, 8, 0, 0));
        StackHeaderWhenNarrow(LiveFeedHeaderGrid, LiveFeedTitlePanel, LiveHeaderControls, new Thickness(0, 8, 0, 0));
        StackHeaderWhenNarrow(ModelsHeaderGrid, ModelsTitle, PanelGroup, new Thickness(0, 8, 0, 0),
            new Thickness(12, 0, 0, 0));
    }

    private static void StackHeaderWhenNarrow(
        Grid header,
        FrameworkElement title,
        FrameworkElement controls,
        Thickness stackedMargin,
        Thickness baseMargin = default)
    {
        // The panel-group toggle migrates between headers; only its current
        // header may lay it out.
        if (!ReferenceEquals(controls.Parent, header) || header.ActualWidth <= 0)
        {
            return;
        }

        // Compare natural single-line widths, not current ones — a stacked,
        // wrapped panel reports a narrower size and would never unstack.
        controls.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var stacked = title.DesiredSize.Width + controls.DesiredSize.Width + 16 > header.ActualWidth;
        controls.InvalidateMeasure();

        Grid.SetRow(controls, stacked ? 1 : 0);
        Grid.SetColumn(controls, stacked ? 0 : 1);
        Grid.SetColumnSpan(controls, stacked ? 2 : 1);
        controls.Margin = stacked ? stackedMargin : baseMargin;
    }

    private void StartLiveFrames()
    {
        if (_liveFramesActive)
        {
            return;
        }

        _liveFramesActive = true;
        _lastFrameTicks = System.Diagnostics.Stopwatch.GetTimestamp();
        CompositionTarget.Rendering += LiveFrame;
    }

    private void StopLiveFrames()
    {
        if (!_liveFramesActive)
        {
            return;
        }

        _liveFramesActive = false;
        CompositionTarget.Rendering -= LiveFrame;
    }

    /// <summary>Runs once per rendered frame (display refresh rate) while the live tab is open.</summary>
    private void LiveFrame(object? sender, EventArgs e)
    {
        if (!IsVisible)
        {
            return;
        }

        var ticks = System.Diagnostics.Stopwatch.GetTimestamp();
        var dt = Math.Clamp(
            (ticks - _lastFrameTicks) / (double)System.Diagnostics.Stopwatch.Frequency, 0, 0.1);
        _lastFrameTicks = ticks;

        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        if (_cupBubbles.Count == 0 && !_cupLayoutDirty)
        {
            return;
        }

        var width = LiveScroll.ViewportWidth;
        var viewportHeight = LiveScroll.ViewportHeight;
        if (width < 40 || viewportHeight < 40)
        {
            return;
        }

        AdvanceCup(nowMs, width, viewportHeight, dt);
    }

    private async void LiveWindowButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _liveWindowKey && _loaded)
        {
            return;
        }

        _liveWindowKey = key;
        _liveWindowMs = key switch
        {
            "w1" => 60_000L,
            "w15" => 900_000L,
            "w30" => 1_800_000L,
            "w45" => 2_700_000L,
            "w60" => 3_600_000L,
            // Endless: sentinel far beyond any real elapsed time; guarded
            // wherever the window length enters arithmetic.
            "inf" => long.MaxValue / 8,
            _ => 300_000L
        };
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedLiveWindow = key;
        _settings.Save();
        // The running round simply adopts the new length (a longer round keeps
        // its blocks and countdown; a shorter one settles on the next tick)
        // while the sediment below is re-partitioned at the new size. Endless
        // keeps whatever sediment already exists and just stops settling.
        UpdateLiveWindowLabels();
        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        UpdateRoundText(nowMs);
        UpdateRoundProgress(nowMs);
        _cupLayoutDirty = true;
        await RebuildCupLayersAsync();
    }

    private void UpdateLiveWindowLabels()
    {
        var name = IsEndless ? "stacked" : "this round";
        LiveSpendLabel.Text = $"Spend · {name}";
        LiveTokensLabel.Text = $"Tokens · {name}";
        LiveMessagesLabel.Text = $"Responses · {name}";
    }

    private async void LiveMetricButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _liveMetricKey && _loaded)
        {
            return;
        }

        _liveMetricKey = key;
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedLiveMetric = key;
        _settings.Save();
        _cupLayoutDirty = true;
        UpdateRoundHistoryBars();
        await PullLiveEventsAsync();
    }

    /// <summary>Resets cup tracking: fresh round, empty canvas. App start only —
    /// RebuildCupLayersAsync then backfills the sediment from the index.</summary>
    private void StartCupRound()
    {
        foreach (var bubble in _cupBubbles.Values)
        {
            LiveCanvas.Children.Remove(bubble.Visual);
        }

        _cupBubbles.Clear();
        _cupLayers.Clear();
        _cupWalls = null;
        LiveCanvas.Children.Clear();
        _roundStartMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        _cupLastSeenMs = _roundStartMs;
        _cupLayoutDirty = true;
        UpdateRoundHistoryBars();
        UpdateRoundText(_roundStartMs);
    }

    private async Task PullLiveEventsAsync()
    {
        if (_livePulling || !_loaded)
        {
            return;
        }

        _livePulling = true;
        try
        {
            var rows = await _database.GetEventsUpdatedSinceAsync(_cupLastSeenMs, 1200);
            var maxUpdated = 0L;
            foreach (var row in rows)
            {
                maxUpdated = Math.Max(maxUpdated, row.UpdatedMs);

                // A reconcile can index hours of history in one gulp. Rows
                // whose event time predates the round belong to the graph and
                // the sediment rebuild, not to the round in progress.
                if (!_cupBubbles.ContainsKey(row.EventKey) &&
                    row.TimestampMs < _roundStartMs - 60_000)
                {
                    continue;
                }

                UpsertCupBubble(row);
            }

            if (rows.Count > 0)
            {
                _cupLastSeenMs = Math.Max(_cupLastSeenMs, maxUpdated);
                LivePulseDot.Opacity = 1.0;
                LivePulseText.Text = $"last update {DateTime.Now:h:mm:ss tt}";
                UpdateLiveLegend();
            }
        }
        catch
        {
            // Best effort: the next collector event retries.
        }
        finally
        {
            _livePulling = false;
        }
    }

    private void UpsertCupBubble(LiveEventRow row)
    {
        var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
        if (_cupBubbles.TryGetValue(row.EventKey, out var existing))
        {
            existing.Event = row;
            existing.Cost = estimate.Cost;
            if (!existing.Frozen)
            {
                _cupLayoutDirty = true;
            }

            return;
        }

        AssignLiveModelSlot(row.Model);
        var bubble = new LiveBubble
        {
            Event = row,
            Visual = null!,
            FirstSeenMs = row.TimestampMs,
            SpawnedAtMs = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            Cost = estimate.Cost
        };
        bubble.Visual = CreateCupVisual(bubble);
        bubble.Visual.Width = 0;
        bubble.Visual.Height = 0;
        _cupBubbles[row.EventKey] = bubble;
        LiveCanvas.Children.Add(bubble.Visual);
        _cupLayoutDirty = true;
    }

    private void AssignLiveModelSlot(string model)
    {
        if (!_modelSlots.ContainsKey(model) && _modelSlots.Count < MaxModelSlots)
        {
            _modelSlots[model] = _modelSlots.Count;
        }
    }

    private Color LiveModelColor(string model) => BrushForModel(model) is SolidColorBrush solid
        ? solid.Color
        : ((SolidColorBrush)FindResource("AccentBrush")).Color;

    private static SolidColorBrush LiveStrokeBrush()
    {
        var stroke = new SolidColorBrush(Color.FromArgb(70, 255, 255, 255));
        stroke.Freeze();
        return stroke;
    }

    private FrameworkElement CreateCupVisual(LiveBubble bubble)
    {
        var row = bubble.Event;
        var fill = new SolidColorBrush(LiveModelColor(row.Model)) { Opacity = 0.85 };
        fill.Freeze();
        var label = new TextBlock
        {
            FontWeight = FontWeights.SemiBold,
            Foreground = Brushes.White,
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            VerticalAlignment = System.Windows.VerticalAlignment.Center,
            IsHitTestVisible = false,
            TextTrimming = TextTrimming.CharacterEllipsis
        };
        bubble.Label = label;
        var visual = new Border
        {
            Background = fill,
            BorderBrush = LiveStrokeBrush(),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(5),
            Child = label,
            ToolTip = BuildLiveTooltip(row)
        };
        ToolTipService.SetInitialShowDelay(visual, 150);
        ToolTipService.SetShowDuration(visual, 60000);

        // The session's name, its terminal and its prompts all land after the
        // block does — and the block keeps growing while output streams — so
        // rebuild the text on every hover instead of freezing it at spawn.
        visual.ToolTipOpening += (_, _) => visual.ToolTip = BuildLiveTooltip(bubble.Event);
        return visual;
    }

    /// <summary>Round bookkeeping and counters, every 250 ms; the cup keeps
    /// ticking in the background whatever tab is showing.</summary>
    private void AdvanceLive(object? sender, EventArgs e)
    {
        if (!_liveStarted)
        {
            return;
        }

        if (LivePulseDot.Opacity > 0.35)
        {
            LivePulseDot.Opacity = Math.Max(0.35, LivePulseDot.Opacity - 0.08);
        }

        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        TickCupRound(nowMs);

        double costWindow = 0, cost60 = 0, cost5m = 0;
        long tokensWindow = 0, tokens60 = 0, tokens5m = 0, messagesWindow = 0;
        var latestBySession = new Dictionary<string, LiveEventRow>(StringComparer.Ordinal);
        foreach (var bubble in _cupBubbles.Values)
        {
            // Sessions active in the lookback, each represented by its newest
            // response — the one whose prompt side is the session's context now.
            var row = bubble.Event;
            if (nowMs - row.TimestampMs <= ContextLookbackMs &&
                (!latestBySession.TryGetValue(row.SessionId, out var newest) ||
                 row.TimestampMs > newest.TimestampMs))
            {
                latestBySession[row.SessionId] = row;
            }

            // Frozen (settled) blocks are out of the current round but still
            // count toward the rolling 5-minute pace.
            if (nowMs - bubble.FirstSeenMs <= 300_000)
            {
                cost5m += bubble.Cost;
                tokens5m += bubble.Event.Tokens.Total;
            }

            if (bubble.Frozen)
            {
                continue;
            }

            costWindow += bubble.Cost;
            tokensWindow += bubble.Event.Tokens.Total;
            messagesWindow += bubble.Event.Messages;
            if (nowMs - bubble.FirstSeenMs <= 60_000)
            {
                cost60 += bubble.Cost;
                tokens60 += bubble.Event.Tokens.Total;
            }
        }

        LiveEmptyText.Visibility = _cupBubbles.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        LiveSpendText.Text = FormatMoney(costWindow);
        LiveTokensText.Text = FormatCompact(tokensWindow);
        LiveMessagesText.Text = messagesWindow.ToString("N0");
        LiveRateText.Text = $"{FormatMoney(cost60)}/min";
        LiveTokenRateText.Text = $"{FormatCompact((long)(tokens60 / 60.0))}/s";
        LiveFeedRateText.Text = cost5m > 0 || tokens5m > 0
            ? $"{FormatMoney(cost5m / 5)}/min · {FormatCompact((long)(tokens5m / 300.0))} tok/s · 5 m avg"
            : "";

        UpdateContextChips(latestBySession);
    }

    /// <summary>Recent session contexts, largest first: one chip per session in
    /// the live feed card, amber then red as a session grows — with a red card
    /// border and a dashboard badge once the biggest one runs high.</summary>
    private void UpdateContextChips(Dictionary<string, LiveEventRow> latestBySession)
    {
        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        var eligible = latestBySession.Values
            .Where(row => _terminalsBySession.ContainsKey(row.SessionId) ||
                          nowMs - row.TimestampMs <= ContextClosedGraceMs)
            .Select(row => (Row: row, Context: row.Tokens.Input + row.Tokens.CacheRead + row.Tokens.CacheWrite))
            .OrderByDescending(item => item.Context)
            .ToList();
        var sessions = eligible.Take(MaxContextChips).ToList();

        var topContext = sessions.Count > 0 ? sessions[0].Context : 0;
        if (topContext >= ContextHighTokens)
        {
            LiveFeedCard.BorderBrush = LimitCriticalBrush;
            LiveFeedCard.BorderThickness = new Thickness(1.5);
        }
        else
        {
            // Back to the Card style's hairline once no session is running high.
            LiveFeedCard.ClearValue(Border.BorderBrushProperty);
            LiveFeedCard.ClearValue(Border.BorderThicknessProperty);
        }

        var signature = string.Join("|", sessions.Select(item => $"{item.Row.SessionId}:{item.Context}"));
        if (signature == _contextChipsSignature)
        {
            return;
        }

        _contextChipsSignature = signature;

        // Two terminals in the same project would otherwise be identical chips.
        var duplicateNames = sessions
            .GroupBy(item => ContextSessionName(item.Row), StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        ContextChipsList.ItemsSource = sessions.Select(item =>
        {
            var name = ContextSessionName(item.Row);
            if (duplicateNames.Contains(name))
            {
                name = $"{name} · {item.Row.SessionId[..Math.Min(4, item.Row.SessionId.Length)]}";
            }

            if (item.Context >= ContextCriticalTokens)
            {
                name = $"⚠ {name}";
            }

            var accent = item.Context >= ContextHighTokens ? LimitCriticalBrush
                : item.Context >= ContextWarnTokens ? LimitWarningBrush
                : (Brush)FindResource("InkBrush");
            var outline = item.Context >= ContextCriticalTokens ? ContextCriticalOutline
                : item.Context >= ContextHighTokens ? ContextHighOutline
                : item.Context >= ContextWarnTokens ? ContextWarnOutline
                : (Brush)FindResource("HairlineBrush");
            var fill = item.Context >= ContextCriticalTokens ? ContextCriticalFill
                : item.Context >= ContextHighTokens ? ContextHighFill
                : item.Context >= ContextWarnTokens ? ContextWarnFill
                : ContextChipFill;
            var pid = SessionPid(item.Row.SessionId);
            return new ContextChipVm(
                name,
                FormatCompact(item.Context),
                accent,
                fill,
                outline,
                ContextTooltip(item.Row, item.Context) +
                    (pid > 0 ? "\n\nClick to bring this terminal to the front." : ""),
                pid,
                pid > 0 ? System.Windows.Input.Cursors.Hand : System.Windows.Input.Cursors.Arrow);
        }).ToList();

        // The dashboard hero mirrors the top few: name, size, and a bar
        // filling toward the alarm line so "how close to trouble" reads at
        // a glance without opening the live feed.
        var heroSessions = sessions.Take(3).ToList();
        HeroContextEmpty.Visibility = heroSessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        HeroContextList.ItemsSource = heroSessions.Select(item =>
        {
            var overLimit = item.Context >= ContextCriticalTokens;
            var tier = item.Context >= ContextHighTokens ? LimitCriticalBrush
                : item.Context >= ContextWarnTokens ? LimitWarningBrush
                : null;
            var fill = overLimit ? ContextCriticalFill
                : item.Context >= ContextHighTokens ? ContextHighFill
                : item.Context >= ContextWarnTokens ? ContextWarnFill
                : ContextChipFill;
            var outline = overLimit ? ContextCriticalOutline
                : item.Context >= ContextHighTokens ? ContextHighOutline
                : item.Context >= ContextWarnTokens ? ContextWarnOutline
                : (Brush)FindResource("HairlineBrush");
            var pid = SessionPid(item.Row.SessionId);
            return new HeroContextVm(
                (overLimit ? "⚠ " : "") + ContextSessionName(item.Row),
                overLimit ? $"{FormatCompact(item.Context)} · over limit" : FormatCompact(item.Context),
                tier ?? (Brush)FindResource("InkBrush"),
                tier ?? (Brush)FindResource("AccentBrush"),
                fill,
                outline,
                Math.Clamp(item.Context / (double)ContextCriticalTokens, 0, 1),
                ContextTooltip(item.Row, item.Context) +
                    (pid > 0 ? "\n\nClick to bring this terminal to the front." : ""),
                pid,
                pid > 0 ? System.Windows.Input.Cursors.Hand : System.Windows.Input.Cursors.Arrow);
        }).ToList();
    }

    private sealed record HeroContextVm(
        string Name,
        string Tokens,
        Brush Accent,
        Brush BarBrush,
        Brush Fill,
        Brush Outline,
        double Share,
        string Tooltip,
        int Pid,
        System.Windows.Input.Cursor Cursor);

    private void HeroContext_Clicked(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: HeroContextVm { Pid: > 0 } vm })
        {
            TerminalFocusService.TryFocus(vm.Pid);
        }
    }

    private void ContextChip_Clicked(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: ContextChipVm { Pid: > 0 } vm })
        {
            TerminalFocusService.TryFocus(vm.Pid);
        }
    }

    private void TerminalTile_Clicked(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: TerminalTileVm { Pid: > 0 } vm })
        {
            TerminalFocusService.TryFocus(vm.Pid);
        }
    }

    private int SessionPid(string sessionId) =>
        _terminalsBySession.TryGetValue(sessionId, out var terminal) ? terminal.Pid : 0;

    /// <summary>Which chat a session is: its first prompt when one is known
    /// (works even after the terminal closed — history remembers), then the
    /// project name while the terminal is open, then the client plus a stub.</summary>
    private string ContextSessionName(LiveEventRow row)
    {
        if (SessionTopic(row.SessionId) is { } topic)
        {
            return $"“{topic}”";
        }

        if (_terminalsBySession.TryGetValue(row.SessionId, out var terminal))
        {
            return DisplayProject(terminal.ProjectName);
        }

        var stub = row.SessionId.Length > 6 ? row.SessionId[..6] : row.SessionId;
        return $"{row.Client} · {stub}";
    }

    /// <summary>What the session's chat is about, fit for a title: the first
    /// prompt, trimmed. Null when unknown — or when personal data is hidden,
    /// since prompts are exactly the kind of text that setting exists for.</summary>
    private string? SessionTopic(string sessionId)
    {
        if (HidePersonal)
        {
            return null;
        }

        return _sessionTitles.TitleFor(sessionId) is { } title
            ? TrimTopic(title.First, 48)
            : null;
    }

    /// <summary>Tooltip lines with the full story: the opening prompt plus the
    /// latest one when they differ. Empty when unknown or personal data is hidden.</summary>
    private string SessionPromptLines(string sessionId)
    {
        if (HidePersonal || _sessionTitles.TitleFor(sessionId) is not { } title)
        {
            return "";
        }

        var lines = $"\nfirst prompt: “{TrimTopic(title.First, 160)}”";
        if (!string.Equals(title.Latest, title.First, StringComparison.Ordinal))
        {
            lines += $"\nlatest prompt: “{TrimTopic(title.Latest, 160)}”";
        }

        return lines;
    }

    private static string TrimTopic(string text, int max) =>
        text.Length <= max ? text : text[..(max - 1)].TrimEnd() + "…";

    /// <summary>Where a session lives: its terminal's working directory (the
    /// project name when personal data is hidden), or an honest "no match".</summary>
    private string ContextPlace(string sessionId) =>
        _terminalsBySession.TryGetValue(sessionId, out var terminal)
            ? (HidePersonal ? DisplayProject(terminal.ProjectName) : terminal.ProjectPath)
            : "no open terminal matched";

    private string ContextTooltip(LiveEventRow row, long context)
    {
        var tokens = row.Tokens;
        var time = DateTimeOffset.FromUnixTimeMilliseconds(row.TimestampMs).ToLocalTime();
        var place = ContextPlace(row.SessionId);
        return $"{ContextSessionName(row)}\n{row.Model} · last response {time:h:mm:ss tt}\n{place}" +
               $"{SessionPromptLines(row.SessionId)}\n\n" +
               $"Context now: {context:N0} tokens\n" +
               $"(input {tokens.Input:N0} + cache read {tokens.CacheRead:N0} + cache write {tokens.CacheWrite:N0})\n" +
               $"Session {row.SessionId}\n\n" +
               $"Amber from {FormatCompact(ContextWarnTokens)}, red from {FormatCompact(ContextHighTokens)}, " +
               $"over limit from {FormatCompact(ContextCriticalTokens)}: " +
               "a big context makes every following response cost more.";
    }

    private sealed record ContextChipVm(
        string Name,
        string Tokens,
        Brush Accent,
        Brush Fill,
        Brush Outline,
        string Tooltip,
        int Pid,
        System.Windows.Input.Cursor Cursor);

    private static readonly Brush ContextChipFill = Frozen(Color.FromRgb(0x14, 0x14, 0x13));
    private static readonly Brush ContextWarnFill = Frozen(Color.FromArgb(0x22, 0xE0, 0xA4, 0x58));
    private static readonly Brush ContextHighFill = Frozen(Color.FromArgb(0x26, 0xE5, 0x53, 0x4B));
    private static readonly Brush ContextWarnOutline = Frozen(Color.FromArgb(0x66, 0xE0, 0xA4, 0x58));
    private static readonly Brush ContextHighOutline = Frozen(Color.FromArgb(0x8C, 0xE5, 0x53, 0x4B));
    private static readonly Brush ContextCriticalFill = Frozen(Color.FromArgb(0x40, 0xE5, 0x53, 0x4B));
    private static readonly Brush ContextCriticalOutline = Frozen(Color.FromArgb(0xE0, 0xE5, 0x53, 0x4B));

    private static SolidColorBrush Frozen(Color color)
    {
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        return brush;
    }

    /// <summary>Cup round lifecycle: countdown → the pile settles into a layer → fresh round on top.</summary>
    private void TickCupRound(long nowMs)
    {
        if (!IsEndless && nowMs - _roundStartMs >= _liveWindowMs)
        {
            SettleRound(nowMs);
        }

        UpdateRoundText(nowMs);
        UpdateRoundProgress(nowMs);
    }

    /// <summary>The rim above the cup fills over the round and warms near the end.</summary>
    private void UpdateRoundProgress(long nowMs)
    {
        if (IsEndless)
        {
            RoundProgress.Visibility = Visibility.Collapsed;
            return;
        }

        RoundProgress.Visibility = Visibility.Visible;
        var fraction = Math.Clamp((nowMs - _roundStartMs) / (double)_liveWindowMs, 0, 1);
        RoundProgress.Value = fraction;
        RoundProgress.Foreground = fraction >= 0.95 ? LimitCriticalBrush
            : fraction >= 0.8 ? LimitWarningBrush
            : (Brush)FindResource("AccentBrush");
    }

    /// <summary>Freezes the active round into a sediment layer and raises the floor.</summary>
    private void SettleRound(long nowMs)
    {
        var active = _cupBubbles.Values.Where(bubble => !bubble.Frozen).ToList();
        var cost = active.Sum(bubble => bubble.Cost);
        var tokens = active.Sum(bubble => bubble.Event.Tokens.Total);
        _lastRoundCost = cost;
        _lastRoundTokens = tokens;
        _bestRoundCost = Math.Max(_bestRoundCost, cost);
        _bestRoundTokens = Math.Max(_bestRoundTokens, tokens);
        _roundHistory.Add((DateTime.Now, cost, tokens));
        if (_roundHistory.Count > 12)
        {
            _roundHistory.RemoveAt(0);
        }

        UpdateRoundHistoryBars();

        if (active.Count > 0)
        {
            foreach (var bubble in active)
            {
                bubble.Frozen = true;
            }

            var (caption, divider) = CreateLayerChrome(DateTime.Now, cost, tokens);
            _cupLayers.Insert(0, new CupLayer
            {
                Blocks = active.OrderBy(bubble => bubble.FirstSeenMs).ToList(),
                EndedAt = DateTime.Now,
                Cost = cost,
                Tokens = tokens,
                Scale = _activeCupScale,
                Divider = divider,
                Caption = caption
            });

            // Keep the sediment bounded.
            while (_cupLayers.Count > 20)
            {
                var oldest = _cupLayers[^1];
                _cupLayers.RemoveAt(_cupLayers.Count - 1);
                LiveCanvas.Children.Remove(oldest.Divider);
                LiveCanvas.Children.Remove(oldest.Caption);
                foreach (var bubble in oldest.Blocks)
                {
                    LiveCanvas.Children.Remove(bubble.Visual);
                    _cupBubbles.Remove(bubble.Event.EventKey);
                }
            }

            UpdateLiveLegend();
        }

        _roundStartMs = nowMs;
        _cupLayoutDirty = true;
        if (LiveViewVisible)
        {
            LiveScroll.ScrollToVerticalOffset(0);
        }
    }

    /// <summary>Divider line + score caption that separate one sediment layer from the next.</summary>
    private (TextBlock Caption, Line Divider) CreateLayerChrome(DateTime endedAt, double cost, long tokens)
    {
        var caption = new TextBlock
        {
            Text = $"{endedAt:h:mm tt}  ·  {FormatMoney(cost)}  ·  {FormatCompact(tokens)} tok",
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)FindResource("MutedBrush")
        };
        var divider = new Line
        {
            Stroke = (Brush)FindResource("HairlineBrush"),
            StrokeThickness = 1,
            StrokeDashArray = new DoubleCollection { 3, 3 }
        };
        Canvas.SetTop(caption, -1000);
        LiveCanvas.Children.Add(divider);
        LiveCanvas.Children.Add(caption);
        return (caption, divider);
    }

    /// <summary>
    /// Rebuilds the sediment from the index: the time before the active round is
    /// re-partitioned into rounds of the current length, so changing the round
    /// size (or starting the app) shows real history instead of an empty cup.
    /// The active round is untouched; existing layers are replaced wholesale,
    /// which is also what prevents any event from being counted twice.
    /// </summary>
    private async Task RebuildCupLayersAsync()
    {
        const int maxLayers = 12;
        if (IsEndless)
        {
            // No round length to partition history by; the existing sediment
            // stays as it was and the pile grows from here.
            return;
        }

        List<LiveEventRow> rows;
        try
        {
            rows = await _database.GetEventsInRangeAsync(
                _roundStartMs - maxLayers * _liveWindowMs, _roundStartMs, 2500);
        }
        catch
        {
            return;
        }

        foreach (var layer in _cupLayers)
        {
            LiveCanvas.Children.Remove(layer.Divider);
            LiveCanvas.Children.Remove(layer.Caption);
            foreach (var bubble in layer.Blocks)
            {
                LiveCanvas.Children.Remove(bubble.Visual);
                _cupBubbles.Remove(bubble.Event.EventKey);
            }
        }

        _cupLayers.Clear();
        _roundHistory.Clear();

        // Pack budget per history layer: roughly what a settled round gets on
        // screen. Falls back to sane defaults before the live tab has a size.
        var width = LiveScroll.ActualWidth > 60 ? LiveScroll.ActualWidth : 900;
        var budget = LiveScroll.ViewportHeight > 120 ? LiveScroll.ViewportHeight * 0.8 : 320;

        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        for (var i = 0; i < maxLayers; i++)
        {
            var windowEnd = _roundStartMs - i * _liveWindowMs;
            var windowStart = windowEnd - _liveWindowMs;
            var blocks = new List<LiveBubble>();
            double cost = 0;
            long tokens = 0;
            foreach (var row in rows)
            {
                // Skip events outside this window and events already on the
                // canvas (a straggler indexed after round start stays active).
                if (row.TimestampMs < windowStart || row.TimestampMs >= windowEnd ||
                    _cupBubbles.ContainsKey(row.EventKey))
                {
                    continue;
                }

                var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
                AssignLiveModelSlot(row.Model);
                var bubble = new LiveBubble
                {
                    Event = row,
                    Visual = null!,
                    FirstSeenMs = row.TimestampMs,
                    SpawnedAtMs = nowMs,
                    Cost = estimate.Cost,
                    Frozen = true
                };
                bubble.Visual = CreateCupVisual(bubble);
                bubble.Visual.Width = 0;
                bubble.Visual.Height = 0;
                _cupBubbles[row.EventKey] = bubble;
                LiveCanvas.Children.Add(bubble.Visual);
                blocks.Add(bubble);
                cost += estimate.Cost;
                tokens += row.Tokens.Total;
            }

            var endedAt = DateTimeOffset.FromUnixTimeMilliseconds(windowEnd).LocalDateTime;
            _roundHistory.Insert(0, (endedAt, cost, tokens));
            if (blocks.Count == 0)
            {
                continue;
            }

            var scale = 1.0;
            for (var attempt = 0; attempt < 8; attempt++)
            {
                var needed = PackHeight(blocks, width, 16, scale);
                if (needed <= budget || scale <= 0.08)
                {
                    break;
                }

                scale *= Math.Max(0.4, Math.Sqrt(budget / needed) * 0.96);
            }

            var (caption, divider) = CreateLayerChrome(endedAt, cost, tokens);
            _cupLayers.Add(new CupLayer
            {
                Blocks = blocks,
                EndedAt = endedAt,
                Cost = cost,
                Tokens = tokens,
                Scale = scale,
                Divider = divider,
                Caption = caption
            });
        }

        // A quiet stretch before the first real activity is not a score of
        // zero, it is no round at all: trim leading empties from the bars.
        while (_roundHistory.Count > 0 && _roundHistory[0].Cost == 0 && _roundHistory[0].Tokens == 0)
        {
            _roundHistory.RemoveAt(0);
        }

        if (_roundHistory.Count > 0)
        {
            var last = _roundHistory[^1];
            _lastRoundCost = last.Cost;
            _lastRoundTokens = last.Tokens;
            _bestRoundCost = Math.Max(_bestRoundCost, _roundHistory.Max(round => round.Cost));
            _bestRoundTokens = Math.Max(_bestRoundTokens, _roundHistory.Max(round => round.Tokens));
        }

        UpdateRoundHistoryBars();
        UpdateRoundText(nowMs);
        UpdateLiveLegend();
        _cupLayoutDirty = true;
    }

    private void UpdateRoundText(long nowMs)
    {
        if (IsEndless)
        {
            var stacked = _cupBubbles.Values.Count(bubble => !bubble.Frozen);
            LiveRoundText.Text = stacked == 1
                ? "endless · 1 block stacked"
                : $"endless · {stacked} blocks stacked";
            return;
        }

        var score = _liveMetricKey == "tokens"
            ? (_lastRoundTokens is { } lastTokens ? $"   ·   last round {FormatCompact(lastTokens)}" : string.Empty) +
              (_bestRoundTokens > 0 ? $"   ·   best {FormatCompact(_bestRoundTokens)}" : string.Empty)
            : (_lastRoundCost is { } lastCost ? $"   ·   last round {FormatMoney(lastCost)}" : string.Empty) +
              (_bestRoundCost > 0 ? $"   ·   best {FormatMoney(_bestRoundCost)}" : string.Empty);
        var remaining = TimeSpan.FromMilliseconds(Math.Max(0, _liveWindowMs - (nowMs - _roundStartMs)));
        var countdown = remaining.TotalHours >= 1
            ? remaining.ToString(@"h\:mm\:ss")
            : remaining.ToString(@"m\:ss");
        LiveRoundText.Text = $"next layer in {countdown}{score}";
    }

    private void UpdateRoundHistoryBars()
    {
        if (_roundHistory.Count == 0)
        {
            RoundHistoryBars.ItemsSource = null;
            return;
        }

        var values = _roundHistory
            .Select(round => _liveMetricKey == "tokens" ? round.Tokens : round.Cost)
            .ToList();
        var max = Math.Max(values.Max(), 1e-9);
        var bestIndex = values.IndexOf(values.Max());
        var accent = (Brush)FindResource("AccentBrush");
        var muted = (Brush)FindResource("MutedBrush");
        RoundHistoryBars.ItemsSource = _roundHistory
            .Select((round, index) => new RoundBarVm(
                Math.Max(3, 26 * values[index] / max),
                index == bestIndex ? accent : muted,
                $"{round.EndedAt:h:mm tt} · {FormatMoney(round.Cost)} · {FormatCompact(round.Tokens)} tokens"))
            .ToList();
    }

    private sealed record RoundBarVm(double Height, Brush Brush, string Tooltip);

    private void AdvanceCup(long nowMs, double width, double viewportHeight, double dt)
    {
        if (_cupLayoutDirty)
        {
            LayoutCup(width, viewportHeight);
            _cupLayoutDirty = false;
        }

        // Frame-rate independent easing: the same settle speed at 30 or 120 fps.
        var ease = 1 - Math.Exp(-9 * dt);
        foreach (var bubble in _cupBubbles.Values)
        {
            if (bubble.Side <= 0)
            {
                // Waits for its first layout pass.
                continue;
            }

            if (double.IsNaN(bubble.CurrentX))
            {
                // New block: drop in from above the rim.
                bubble.CurrentX = bubble.TargetX;
                bubble.CurrentY = -bubble.Side - 8;
            }

            bubble.CurrentX += (bubble.TargetX - bubble.CurrentX) * ease;
            bubble.CurrentY += (bubble.TargetY - bubble.CurrentY) * ease;
            bubble.Visual.Width = bubble.Side;
            bubble.Visual.Height = bubble.Side;
            Canvas.SetLeft(bubble.Visual, bubble.CurrentX);
            Canvas.SetTop(bubble.Visual, bubble.CurrentY);
        }
    }

    /// <summary>
    /// Lays out the whole cup: the active round packs into the visible region
    /// at the top (scale-to-fit), and each settled layer stacks below it with
    /// a divider and score caption. The canvas grows downward; scroll for history.
    /// </summary>
    private void LayoutCup(double width, double viewportHeight)
    {
        const double wallInset = 16;
        const double floorInset = 10;
        const double topPad = 10;
        const double captionBand = 22;

        var active = _cupBubbles.Values
            .Where(item => !item.Frozen)
            .OrderBy(item => item.FirstSeenMs)
            .ToList();

        // Scale-to-fit: when the active stack would overflow the rim, shrink
        // every block by one shared factor so relative areas stay honest.
        // Endless mode never shrinks — the canvas grows and you scroll instead.
        var available = Math.Max(40, viewportHeight - floorInset - topPad);
        var scale = 1.0;
        if (!IsEndless)
        {
            for (var attempt = 0; attempt < 8; attempt++)
            {
                var needed = PackHeight(active, width, wallInset, scale);
                if (needed <= available || scale <= 0.08)
                {
                    break;
                }

                scale *= Math.Max(0.4, Math.Sqrt(available / needed) * 0.96);
            }
        }

        _activeCupScale = scale;

        foreach (var layer in _cupLayers)
        {
            layer.Height = PackHeight(layer.Blocks, width, wallInset, layer.Scale) + captionBand + 6;
        }

        var activeHeight = IsEndless
            ? Math.Max(viewportHeight, PackHeight(active, width, wallInset, 1) + topPad + floorInset)
            : viewportHeight;
        var canvasHeight = activeHeight + _cupLayers.Sum(layer => layer.Height);
        LiveCanvas.Width = width;
        LiveCanvas.Height = canvasHeight;

        PackInto(active, width, wallInset, scale, activeHeight - floorInset);

        var bandTop = activeHeight;
        foreach (var layer in _cupLayers)
        {
            layer.Divider.X1 = 8;
            layer.Divider.X2 = width - 8;
            layer.Divider.Y1 = bandTop + 1;
            layer.Divider.Y2 = bandTop + 1;
            Canvas.SetLeft(layer.Caption, wallInset);
            Canvas.SetTop(layer.Caption, bandTop + 4);
            PackInto(layer.Blocks, width, wallInset, layer.Scale, bandTop + layer.Height - 4);
            bandTop += layer.Height;
        }

        RedrawCupWalls(width, canvasHeight);
    }

    /// <summary>Shelf-packs blocks upward from the given floor, assigning targets and labels.</summary>
    private void PackInto(List<LiveBubble> blocks, double width, double wallInset, double scale, double floorY)
    {
        var gap = GapFor(scale);
        var x = wallInset;
        var rowBase = 0d;
        var rowHeight = 0d;
        foreach (var bubble in blocks)
        {
            var side = Math.Max(6, CupSide(bubble) * scale);
            bubble.Side = side;
            if (x + side > width - wallInset && x > wallInset)
            {
                rowBase += rowHeight + gap;
                x = wallInset;
                rowHeight = 0;
            }

            bubble.TargetX = x;
            bubble.TargetY = floorY - rowBase - side;
            x += side + gap;
            rowHeight = Math.Max(rowHeight, side);

            if (bubble.Label is not null)
            {
                if (side >= 30)
                {
                    bubble.Label.Text = LiveLabelText(bubble);
                    bubble.Label.FontSize = Math.Clamp(side / 4.5, 9, 14);
                    bubble.Label.Visibility = Visibility.Visible;
                }
                else
                {
                    bubble.Label.Visibility = Visibility.Collapsed;
                }
            }
        }
    }

    /// <summary>One tall cup around everything: walls run the full sediment depth.</summary>
    private void RedrawCupWalls(double width, double canvasHeight)
    {
        if (_cupWalls is not null)
        {
            LiveCanvas.Children.Remove(_cupWalls);
        }

        _cupWalls = new System.Windows.Shapes.Path
        {
            Stroke = (Brush)FindResource("HairlineBrush"),
            StrokeThickness = 1.5,
            Data = Geometry.Parse(FormattableString.Invariant(
                $"M 8,2 L 8,{canvasHeight - 20} Q 8,{canvasHeight - 4} 24,{canvasHeight - 4} L {width - 24},{canvasHeight - 4} Q {width - 8},{canvasHeight - 4} {width - 8},{canvasHeight - 20} L {width - 8},2"))
        };
        LiveCanvas.Children.Insert(0, _cupWalls);
    }

    /// <summary>Height the shelf-packed stack needs at the given block scale.</summary>
    private double PackHeight(List<LiveBubble> ordered, double width, double wallInset, double scale)
    {
        var gap = GapFor(scale);
        var x = wallInset;
        var rowBase = 0d;
        var rowHeight = 0d;
        foreach (var bubble in ordered)
        {
            var side = Math.Max(6, CupSide(bubble) * scale);
            if (x + side > width - wallInset && x > wallInset)
            {
                rowBase += rowHeight + gap;
                x = wallInset;
                rowHeight = 0;
            }

            x += side + gap;
            rowHeight = Math.Max(rowHeight, side);
        }

        return rowBase + rowHeight;
    }

    private static double GapFor(double scale) => scale < 0.6 ? 2 : 4;

    private string LiveLabelText(LiveBubble bubble) => _liveMetricKey == "tokens"
        ? FormatCompact(bubble.Event.Tokens.Total)
        : bubble.Cost >= 0.01
            ? bubble.Cost.ToString("$0.00", Usd)
            : bubble.Cost.ToString("$0.000", Usd);

    /// <summary>Block area tracks the selected metric; unpriced costs fall back to tokens.</summary>
    private double CupSide(LiveBubble bubble)
    {
        var sqrt = LiveMetricSqrt(bubble);
        return Math.Clamp(14 + 92 * sqrt, 14, 118);
    }

    /// <summary>√(metric) on a scale where 1.0 ≈ $1 or 1M tokens.</summary>
    private double LiveMetricSqrt(LiveBubble bubble)
    {
        if (_liveMetricKey != "tokens" && bubble.Cost > 0)
        {
            return Math.Sqrt(bubble.Cost);
        }

        return Math.Sqrt(bubble.Event.Tokens.Total / 1_000_000d);
    }

    private void LiveCanvas_SizeChanged(object sender, SizeChangedEventArgs e) =>
        _cupLayoutDirty = true;

    private void UpdateLiveLegend()
    {
        LiveLegend.ItemsSource = _cupBubbles.Values
            .Where(bubble => !bubble.Frozen)
            .GroupBy(bubble => bubble.Event.Model, StringComparer.OrdinalIgnoreCase)
            .Select(group => (Model: group.Key, Cost: group.Sum(bubble => bubble.Cost)))
            .OrderByDescending(item => item.Cost)
            .Take(8)
            .Select(item => new LegendItemVm(item.Model, BrushForModel(item.Model)))
            .ToList();
    }

    /// <summary>What a block in the cup is. Leads with which chat it came from —
    /// the same name, folder and prompts the context chips show — because
    /// "where did that $2 reply come from?" is the question a pricey block
    /// raises; the token split follows underneath.</summary>
    private string BuildLiveTooltip(LiveEventRow row)
    {
        var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
        var tokens = row.Tokens;
        var time = DateTimeOffset.FromUnixTimeMilliseconds(row.TimestampMs).ToLocalTime();
        return $"{ContextSessionName(row)}\n" +
               $"{row.Model} · {row.Client} · {time:h:mm:ss tt}\n" +
               $"{ContextPlace(row.SessionId)}" +
               $"{SessionPromptLines(row.SessionId)}\n\n" +
               $"Cost: {(estimate.IsPriced ? estimate.Cost.ToString("C4", Usd) : "no pricing match")}\n" +
               $"Input: {tokens.Input:N0} · Output: {tokens.Output:N0}\n" +
               $"Cache read: {tokens.CacheRead:N0} · write: {tokens.CacheWrite:N0}\n" +
               $"Reasoning: {tokens.Reasoning:N0}\n" +
               $"Session {row.SessionId}";
    }

    private RadioButton TabRadioFor(string key) => key switch
    {
        "live" => TabLive,
        "limits" => TabLimits,
        "terminals" => TabTerminals,
        "insights" => TabInsights,
        _ => TabDashboard
    };

    private static string NormalizeTabKey(string key) =>
        key is "live" or "limits" or "terminals" or "insights" ? key : "dashboard";

    private RadioButton LiveWindowRadioFor(string key) => key switch
    {
        "w1" => LiveW1,
        "w15" => LiveW15,
        "w30" => LiveW30,
        "w45" => LiveW45,
        "w60" => LiveW60,
        "inf" => LiveWInf,
        _ => LiveW5
    };

    private static string NormalizeLiveWindowKey(string key) => key switch
    {
        "w1" or "w15" or "w30" or "w45" or "w60" or "inf" => key,
        _ => "w5"
    };

    private void MetricButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key })
        {
            return;
        }

        _metricKey = key;
        if (IsLoaded)
        {
            UpdateChart();
        }
    }

    private void TableToggle_Changed(object sender, RoutedEventArgs e)
    {
        if (IsLoaded)
        {
            UpdateChart();
        }
    }

    private void ChartCanvas_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_latestData is not null)
        {
            DrawChart();
        }
    }

    private void IntervalComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || IntervalComboBox.SelectedItem is not IntervalChoice selected)
        {
            return;
        }

        _settings.ReconcileSeconds = selected.Seconds;
        _settings.Save();
        StatusText.Text = $"Safety check set to {selected.Label.ToLowerInvariant()}";
    }

    private async void SessionGapComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || SessionGapComboBox.SelectedItem is not SessionGapChoice selected)
        {
            return;
        }

        _settings.SessionGapHours = selected.Hours;
        _settings.Save();
        StatusText.Text = $"A session now ends after {selected.Label.ToLowerInvariant()}";
        if (_rangeKey == "session")
        {
            await RefreshDashboardAsync();
        }
    }

    private void StartupCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        try
        {
            var enabled = StartupCheckBox.IsChecked == true;
            StartupRegistration.SetEnabled(enabled);
            _settings.StartWithWindows = enabled;
            _settings.Save();
        }
        catch (Exception exception)
        {
            ShowError($"Could not change Windows startup: {exception.Message}");
        }
    }

    private async Task RefreshDashboardAsync()
    {
        if (!await _dashboardLock.WaitAsync(0))
        {
            return;
        }

        try
        {
            var data = await _database.GetDashboardAsync(
                _rangeKey,
                _pricing,
                BarsUnitFor(_barsKey),
                (long)(_settings.SessionGapHours * 3_600_000));
            _latestData = data;

            // A session's length only becomes known once the data is in; the
            // offered bar sizes follow it (a 9-hour session outgrows 15 s bars).
            if (_rangeKey == "session")
            {
                var span = data.Buckets.Count > 0
                    ? DateTimeOffset.Now.ToUnixTimeMilliseconds() - data.Buckets[0].StartMs
                    : (long?)null;
                if (span != _sessionSpanMs)
                {
                    _sessionSpanMs = span;
                    UpdateBarsAvailability();
                }
            }
            AssignModelSlots(data);
            var totals = data.Totals;

            CostText.Text = FormatMoney(totals.EstimatedCost);
            CostText.ToolTip = totals.UnpricedEvents == 0
                ? $"{totals.EstimatedCost.ToString("C2", Usd)} at current API list prices."
                : $"{totals.EstimatedCost.ToString("C2", Usd)} at current API list prices. " +
                  $"Excludes {totals.UnpricedEvents:N0} records with no pricing match.";

            TotalTokensText.Text = totals.Total.ToString("N0");
            TotalTokensText.ToolTip = $"{FormatCompact(totals.Total)} tokens in this range.";
            TokenSplitText.Text = $"in {FormatCompact(totals.Input)} · out {FormatCompact(totals.Output)}";
            TokenSplitText.ToolTip =
                $"Input {totals.Input:N0} · output {totals.Output:N0} " +
                $"(reasoning {totals.Reasoning:N0} included)";

            // The single most expensive reply of the last half hour: the
            // clearest early sign that some session's context has gotten big
            // enough for every response to cost real money.
            var nowUtcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            LiveEventRow? priciest = null;
            var priciestCost = 0d;
            foreach (var row in await _database.GetEventsInRangeAsync(nowUtcMs - 1_800_000, nowUtcMs + 60_000))
            {
                var rowCost = _pricing.Calculate(row.Provider, row.Model, row.Tokens).Cost;
                if (rowCost > priciestCost)
                {
                    priciestCost = rowCost;
                    priciest = row;
                }
            }

            if (priciest is null)
            {
                TopReplyCostText.Text = "—";
                TopReplyCostText.ToolTip = "No replies in the last 30 minutes.";
                TopReplyDetailText.Text = "";
            }
            else
            {
                var at = DateTimeOffset.FromUnixTimeMilliseconds(priciest.TimestampMs).ToLocalTime();
                TopReplyCostText.Text = FormatMoney(priciestCost);
                TopReplyCostText.ToolTip =
                    $"{ContextSessionName(priciest)}\n{priciest.Model} · {at:h:mm:ss tt}\n" +
                    $"{priciest.Tokens.Total:N0} tokens — an expensive single reply usually " +
                    "means a huge context went in with it.";
                TopReplyDetailText.Text = $"{priciest.Model} · {at:h:mm tt}";
            }

            UpdateModels(data);
            UpdateChart();

            LastUpdatedText.Text = data.LastUpdatedMs > 0
                ? $"Index updated {DateTimeOffset.FromUnixTimeMilliseconds(data.LastUpdatedMs).ToLocalTime():g} · {Plural(totals.SourceCount, "file")}"
                : "No usage indexed yet";
            PricingStatusText.Text = _pricing.Status;

            if (System.Windows.Application.Current is App app)
            {
                app.UpdateTrayText($"Token Tracker - {FormatMoney(totals.EstimatedCost)} - {FormatCompact(totals.Total)} tokens");
            }
        }
        catch (Exception exception)
        {
            ShowError($"Could not load dashboard: {exception.Message}");
        }
        finally
        {
            _dashboardLock.Release();
        }
    }

    // ── Model breakdown ────────────────────────────────────────────────────

    private void AssignModelSlots(DashboardData data)
    {
        // Models arrive sorted by cost, so the biggest spenders claim free slots first.
        foreach (var model in data.Models.Select(row => row.Model))
        {
            if (_modelSlots.ContainsKey(model) || _modelSlots.Count >= MaxModelSlots)
            {
                continue;
            }

            _modelSlots[model] = _modelSlots.Count;
        }
    }

    private Brush BrushForModel(string model) =>
        _modelSlots.TryGetValue(model, out var slot) ? _seriesBrushes[slot] : _otherBrush;

    private void UpdateModels(DashboardData data)
    {
        var maxCost = data.Models.Count == 0 ? 0 : data.Models.Max(row => row.EstimatedCost);
        var maxTokens = data.Models.Count == 0 ? 0 : data.Models.Max(row => row.Total);
        var rows = data.Models.Select(row => new ModelRowVm(
            row.Model,
            BrushForModel(row.Model),
            FormatMoney(row.EstimatedCost),
            maxCost > 0 ? row.EstimatedCost / maxCost
                : maxTokens > 0 ? (double)row.Total / maxTokens : 0,
            $"{row.Client} · {FormatCompact(row.Total)} tokens · {Plural(row.Messages, "message")}",
            $"{row.Model}\n{row.Client} · {row.Provider}\n\n" +
            $"Cost: {FormatMoney(row.EstimatedCost)}\n" +
            $"Input: {row.Input:N0}\nOutput: {row.Output:N0} (reasoning {row.Reasoning:N0})\n" +
            $"Cache read: {row.CacheRead:N0}\nCache write: {row.CacheWrite:N0}\n" +
            $"Messages: {row.Messages:N0}" +
            (row.UnpricedEvents > 0 ? $"\n{row.UnpricedEvents:N0} records had no pricing match" : string.Empty))).ToList();

        ModelsList.ItemsSource = rows;
        var unpriced = data.Totals.UnpricedEvents > 0
            ? $" · {data.Totals.UnpricedEvents:N0} unpriced"
            : string.Empty;
        ModelsSubtitle.Text = $"{Plural(rows.Count, "model")} · {Plural(data.Totals.Messages, "message")}{unpriced}";
    }

    // ── Chart ──────────────────────────────────────────────────────────────

    private void UpdateChart()
    {
        if (_latestData is not { } data)
        {
            return;
        }

        var unitWord = data.Unit switch
        {
            BucketUnit.Second7_5 => "7.5 s",
            BucketUnit.Second15 => "15 s",
            BucketUnit.Second30 => "30 s",
            BucketUnit.Minute1 => "minute",
            BucketUnit.Minute5 => "5 min",
            BucketUnit.Minute15 => "15 min",
            BucketUnit.Minute30 => "30 min",
            BucketUnit.Hour => "hour",
            BucketUnit.Hour4 => "4 h",
            BucketUnit.Hour12 => "12 h",
            BucketUnit.Month => "month",
            _ => "day"
        };
        ChartTitle.Text = _metricKey switch
        {
            "tokens" => $"Tokens by {unitWord}",
            "messages" => $"Messages by {unitWord}",
            _ => $"Spend by {unitWord}"
        };
        ChartSubtitle.Text = BuildChartSubtitle(data);

        var showTable = TableToggle.IsChecked == true;
        ChartTable.Visibility = showTable ? Visibility.Visible : Visibility.Collapsed;
        ChartCanvas.Visibility = showTable ? Visibility.Collapsed : Visibility.Visible;

        var legendItems = data.Models
            .Select(row => row.Model)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(_modelSlots.ContainsKey)
            .Select(model => new LegendItemVm(model, BrushForModel(model)))
            .ToList();
        if (data.Models.Any(row => !_modelSlots.ContainsKey(row.Model)))
        {
            legendItems.Add(new LegendItemVm("Other", _otherBrush));
        }

        ChartLegend.ItemsSource = legendItems;
        ChartLegend.Visibility = legendItems.Count >= 2 && !showTable
            ? Visibility.Visible
            : Visibility.Collapsed;

        if (showTable)
        {
            ChartEmptyText.Visibility = data.Buckets.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            ChartTable.ItemsSource = data.Buckets
                .Where(bucket => bucket.Total > 0 || bucket.Messages > 0)
                .Reverse()
                .Select(bucket => new TimelineTableRow(
                    FormatPeriod(bucket.LocalStart, data.Unit),
                    FormatMoney(bucket.EstimatedCost),
                    bucket.Total.ToString("N0"),
                    bucket.Input.ToString("N0"),
                    bucket.Output.ToString("N0"),
                    (bucket.CacheRead + bucket.CacheWrite).ToString("N0"),
                    bucket.Messages.ToString("N0")))
                .ToList();
            return;
        }

        DrawChart();
    }

    private string BuildChartSubtitle(DashboardData data)
    {
        if (data.Buckets.Count == 0)
        {
            return "Local time";
        }

        var first = data.Buckets[0].LocalStart;
        var last = data.Buckets[^1].LocalStart;
        return first.Date == last.Date
            ? $"{first:dddd, MMMM d} · local time"
            : $"{first:MMM d} – {last:MMM d} · local time";
    }

    private void DrawChart()
    {
        var canvas = ChartCanvas;
        canvas.Children.Clear();
        if (_latestData is not { } data || canvas.ActualWidth < 60 || canvas.ActualHeight < 60)
        {
            return;
        }

        var buckets = data.Buckets;
        var max = buckets.Count == 0 ? 0 : buckets.Max(MetricValue);
        if (buckets.Count == 0 || max <= 0)
        {
            ChartEmptyText.Text = buckets.Count > 0 && _metricKey == "cost" && data.Totals.Total > 0
                ? "No priced usage in this range — see pricing status in Settings."
                : "No usage recorded in this range.";
            ChartEmptyText.Visibility = Visibility.Visible;
            return;
        }

        ChartEmptyText.Visibility = Visibility.Collapsed;

        var inkMuted = (Brush)FindResource("MutedBrush");
        var ink2 = (Brush)FindResource("Ink2Brush");
        var gridline = (Brush)FindResource("GridlineBrush");
        var baseline = (Brush)FindResource("BaselineBrush");

        // Clean axis scale: ~4 ticks at a 1/2/2.5/5 step.
        var step = NiceStep(max / 4d);
        var top = Math.Ceiling(max / step) * step;
        var tickCount = (int)Math.Round(top / step);

        var typeface = new Typeface(FontFamily, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
        double LabelWidth(string text) => new FormattedText(
            text, Usd, System.Windows.FlowDirection.LeftToRight, typeface, 11, inkMuted,
            VisualTreeHelper.GetDpi(this).PixelsPerDip).Width;

        var gutter = 0d;
        for (var i = 0; i <= tickCount; i++)
        {
            gutter = Math.Max(gutter, LabelWidth(FormatTick(step * i)));
        }

        var showBarLabels = _metricKey == "cost";
        var plotLeft = gutter + 10;
        var plotRight = canvas.ActualWidth - 4;
        var plotTop = showBarLabels ? 22d : 8d;
        var plotBottom = canvas.ActualHeight - 24;
        var plotWidth = plotRight - plotLeft;
        var plotHeight = plotBottom - plotTop;
        if (plotWidth < 40 || plotHeight < 40)
        {
            return;
        }

        // Gridlines + y tick labels (baseline drawn darker).
        for (var i = 0; i <= tickCount; i++)
        {
            var y = plotBottom - plotHeight * (step * i / top);
            var line = new Line
            {
                X1 = plotLeft,
                X2 = plotRight,
                Y1 = y,
                Y2 = y,
                Stroke = i == 0 ? baseline : gridline,
                StrokeThickness = 1,
                SnapsToDevicePixels = true
            };
            canvas.Children.Add(line);

            var label = new TextBlock
            {
                Text = FormatTick(step * i),
                FontSize = 11,
                Foreground = inkMuted
            };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(label, gutter - label.DesiredSize.Width);
            Canvas.SetTop(label, y - label.DesiredSize.Height / 2);
            canvas.Children.Add(label);
        }

        var count = buckets.Count;
        var slotWidth = plotWidth / count;
        // Very dense series (sub-minute bars over hours) drop the inter-bar
        // gap and fill the whole slot, reading as a continuous area.
        var barWidth = slotWidth < 4
            ? Math.Max(1, slotWidth)
            : Math.Min(24, Math.Max(2, slotWidth - 2));

        // X labels at a stride wide enough that they never collide.
        var sampleLabel = FormatAxisLabel(buckets[count / 2].LocalStart, data.Unit, false);
        var stride = Math.Max(1, (int)Math.Ceiling((LabelWidth(sampleLabel) + 18) / slotWidth));
        for (var i = 0; i < count; i += stride)
        {
            var bucket = buckets[i];
            var text = FormatAxisLabel(bucket.LocalStart, data.Unit, bucket.LocalStart.Hour == 0);
            var label = new TextBlock { Text = text, FontSize = 11, Foreground = inkMuted };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var center = plotLeft + slotWidth * i + slotWidth / 2;
            var left = Math.Min(Math.Max(center - label.DesiredSize.Width / 2, 0), canvas.ActualWidth - label.DesiredSize.Width);
            Canvas.SetLeft(label, left);
            Canvas.SetTop(label, plotBottom + 6);
            canvas.Children.Add(label);
        }

        var washBrush = new SolidColorBrush(Color.FromArgb(0x0E, 0xFF, 0xFF, 0xFF));
        washBrush.Freeze();

        var values = new double[count];
        for (var i = 0; i < count; i++)
        {
            values[i] = MetricValue(buckets[i]);
        }

        var labelCandidates = new List<(int Index, string Text, double Width)>();

        for (var i = 0; i < count; i++)
        {
            var bucket = buckets[i];
            var slotLeft = plotLeft + slotWidth * i;
            var barLeft = slotLeft + (slotWidth - barWidth) / 2;

            // Hover wash spanning the full slot, behind the bar.
            var wash = new Rectangle
            {
                Width = Math.Max(1, slotWidth),
                Height = plotHeight,
                Fill = washBrush,
                RadiusX = 4,
                RadiusY = 4,
                Visibility = Visibility.Hidden,
                IsHitTestVisible = false
            };
            Canvas.SetLeft(wash, slotLeft);
            Canvas.SetTop(wash, plotTop);
            canvas.Children.Add(wash);

            // Stacked by model: slot order keeps each model's color and position stable.
            var segments = BuildSegments(bucket);
            var yCursor = plotBottom;
            var topmost = segments.Count - 1;
            for (var s = 0; s < segments.Count; s++)
            {
                var (value, brush) = segments[s];
                var height = Math.Max(1, value / top * plotHeight);
                // 2px surface gap between stacked segments (shaved off this segment's top).
                var gap = s == topmost ? 0 : Math.Min(2, height - 1);
                var segment = new Border
                {
                    Width = barWidth,
                    Height = Math.Max(1, height - gap),
                    Background = brush,
                    CornerRadius = s == topmost && height >= 4
                        ? new CornerRadius(4, 4, 0, 0)
                        : new CornerRadius(0)
                };
                Canvas.SetLeft(segment, barLeft);
                Canvas.SetTop(segment, yCursor - height + gap);
                canvas.Children.Add(segment);
                yCursor -= height;
            }

            // A label is drawn when it fits its slot; on dense charts (minute view) local
            // peaks may still borrow their neighbours' air, since a peak's neighbours are
            // never taller than the label's anchor bar.
            if (showBarLabels && values[i] > 0)
            {
                var text = FormatMoneyShort(values[i]);
                var width = LabelWidth(text) + 2;
                var isPeak = values[i] >= (i > 0 ? values[i - 1] : 0) &&
                             values[i] >= (i < count - 1 ? values[i + 1] : 0);
                if (width <= slotWidth - 2 || (isPeak && width <= slotWidth * 3))
                {
                    labelCandidates.Add((i, text, width));
                }
            }

            // Full-slot hit target carrying the tooltip, built lazily on first
            // hover: at 1000+ buckets, eager tooltips dominate the redraw.
            var hit = new Rectangle
            {
                Width = Math.Max(1, slotWidth),
                Height = plotHeight,
                Fill = Brushes.Transparent
            };
            ToolTipService.SetInitialShowDelay(hit, 120);
            ToolTipService.SetShowDuration(hit, 60000);
            hit.MouseEnter += (_, _) =>
            {
                wash.Visibility = Visibility.Visible;
                hit.ToolTip ??= BuildBucketTooltip(bucket, data.Unit);
            };
            hit.MouseLeave += (_, _) => wash.Visibility = Visibility.Hidden;
            Canvas.SetLeft(hit, slotLeft);
            Canvas.SetTop(hit, plotTop);
            canvas.Children.Add(hit);
        }

        // Place labels last (on top of the marks), greedily left-to-right so none collide.
        var lastLabelRight = double.NegativeInfinity;
        foreach (var (index, text, width) in labelCandidates)
        {
            var center = plotLeft + slotWidth * index + slotWidth / 2;
            var left = Math.Min(Math.Max(center - width / 2, 0), canvas.ActualWidth - width);
            if (left < lastLabelRight + 6)
            {
                continue;
            }

            var label = new TextBlock
            {
                Text = text,
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                Foreground = ink2,
                IsHitTestVisible = false
            };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var stackHeight = values[index] / top * plotHeight;
            Canvas.SetLeft(label, left);
            Canvas.SetTop(label, Math.Max(0, plotBottom - stackHeight - label.DesiredSize.Height - 3));
            canvas.Children.Add(label);
            lastLabelRight = left + width;
        }
    }

    private double MetricValue(UsageBucket bucket) => _metricKey switch
    {
        "tokens" => bucket.Total,
        "messages" => bucket.Messages,
        _ => bucket.EstimatedCost
    };

    private double SliceValue(BucketModelSlice slice) => _metricKey switch
    {
        "tokens" => slice.Tokens,
        "messages" => slice.Messages,
        _ => slice.Cost
    };

    /// <summary>Bottom-to-top stack for one bucket: slot-assigned models in fixed order, then "Other".</summary>
    private List<(double Value, Brush Brush)> BuildSegments(UsageBucket bucket)
    {
        var result = new List<(double, Brush)>();
        if (bucket.Slices.Count == 0)
        {
            var value = MetricValue(bucket);
            if (value > 0)
            {
                result.Add((value, _seriesBrushes[0]));
            }

            return result;
        }

        var bySlot = new double[MaxModelSlots];
        var other = 0d;
        foreach (var slice in bucket.Slices)
        {
            var value = SliceValue(slice);
            if (value <= 0)
            {
                continue;
            }

            if (_modelSlots.TryGetValue(slice.Model, out var slot))
            {
                bySlot[slot] += value;
            }
            else
            {
                other += value;
            }
        }

        for (var slot = 0; slot < MaxModelSlots; slot++)
        {
            if (bySlot[slot] > 0)
            {
                result.Add((bySlot[slot], _seriesBrushes[slot]));
            }
        }

        if (other > 0)
        {
            result.Add((other, _otherBrush));
        }

        return result;
    }

    private object BuildBucketTooltip(UsageBucket bucket, BucketUnit unit)
    {
        var panel = new StackPanel();
        panel.Children.Add(new TextBlock
        {
            Text = FormatPeriod(bucket.LocalStart, unit),
            FontSize = 11,
            Foreground = (Brush)FindResource("MutedBrush")
        });
        panel.Children.Add(new TextBlock
        {
            Text = _metricKey switch
            {
                "tokens" => $"{FormatCompact(bucket.Total)} tokens",
                "messages" => $"{bucket.Messages:N0} messages",
                _ => FormatMoney(bucket.EstimatedCost)
            },
            FontSize = 15,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)FindResource("InkBrush"),
            Margin = new Thickness(0, 2, 0, 6)
        });

        if (bucket.Slices.Count > 0)
        {
            var ranked = bucket.Slices
                .Select(slice => (slice.Model, Value: SliceValue(slice)))
                .Where(item => item.Value > 0)
                .OrderByDescending(item => item.Value)
                .ToList();
            var lines = ranked.Take(5)
                .Select(item => $"{item.Model} · {FormatMetricValue(item.Value)}")
                .ToList();
            if (ranked.Count > 5)
            {
                lines.Add($"+ {ranked.Count - 5} more");
            }

            panel.Children.Add(new TextBlock
            {
                Text = string.Join("\n", lines),
                FontSize = 11,
                Foreground = (Brush)FindResource("Ink2Brush"),
                Margin = new Thickness(0, 0, 0, 6)
            });
        }

        var detail = new TextBlock
        {
            FontSize = 11,
            Foreground = (Brush)FindResource("MutedBrush"),
            Text = $"Cost: {FormatMoney(bucket.EstimatedCost)}\n" +
                   $"Input: {FormatCompact(bucket.Input)} · Output: {FormatCompact(bucket.Output)}\n" +
                   $"Cache read: {FormatCompact(bucket.CacheRead)} · write: {FormatCompact(bucket.CacheWrite)}\n" +
                   $"Reasoning: {FormatCompact(bucket.Reasoning)} · Messages: {bucket.Messages:N0}"
        };
        panel.Children.Add(detail);
        return panel;
    }

    private string FormatMetricValue(double value) => _metricKey switch
    {
        "tokens" => $"{FormatCompact((long)Math.Round(value))} tokens",
        "messages" => $"{value:N0} messages",
        _ => FormatMoney(value)
    };

    private string FormatTick(double value) => _metricKey switch
    {
        "cost" => value switch
        {
            0 => "$0",
            < 1 => value.ToString("$0.00", Usd),
            < 1000 => value.ToString("$0.##", Usd),
            _ => value.ToString("$#,##0", Usd)
        },
        _ => FormatCompact((long)Math.Round(value))
    };

    private static string FormatAxisLabel(DateTime start, BucketUnit unit, bool markMidnight) => unit switch
    {
        BucketUnit.Second7_5 or BucketUnit.Second15 or BucketUnit.Second30 => start.ToString("h:mm:ss"),
        BucketUnit.Minute1 or BucketUnit.Minute5 or BucketUnit.Minute15 or BucketUnit.Minute30 =>
            start.ToString("h:mm tt"),
        BucketUnit.Hour or BucketUnit.Hour4 or BucketUnit.Hour12 =>
            markMidnight ? start.ToString("ddd") : start.ToString("h tt"),
        BucketUnit.Month => start.ToString("MMM yyyy"),
        _ => start.ToString("MMM d")
    };

    private static string FormatPeriod(DateTime start, BucketUnit unit) => unit switch
    {
        BucketUnit.Second7_5 => $"{start:ddd, MMM d} · {start:h:mm:ss.f}–{start.AddSeconds(7.5):h:mm:ss.f tt}",
        BucketUnit.Second15 => $"{start:ddd, MMM d} · {start:h:mm:ss}–{start.AddSeconds(15):h:mm:ss tt}",
        BucketUnit.Second30 => $"{start:ddd, MMM d} · {start:h:mm:ss}–{start.AddSeconds(30):h:mm:ss tt}",
        BucketUnit.Minute1 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(1):h:mm tt}",
        BucketUnit.Minute5 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(5):h:mm tt}",
        BucketUnit.Minute15 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(15):h:mm tt}",
        BucketUnit.Minute30 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(30):h:mm tt}",
        BucketUnit.Hour => $"{start:ddd, MMM d} · {start:h tt}–{start.AddHours(1):h tt}",
        BucketUnit.Hour4 => $"{start:ddd, MMM d} · {start:h tt}–{start.AddHours(4):h tt}",
        BucketUnit.Hour12 => $"{start:ddd, MMM d} · {start:h tt}–{start.AddHours(12):h tt}",
        BucketUnit.Month => start.ToString("MMMM yyyy"),
        _ => start.ToString("ddd, MMM d")
    };

    private static double NiceStep(double rough)
    {
        if (rough <= 0)
        {
            return 1;
        }

        var magnitude = Math.Pow(10, Math.Floor(Math.Log10(rough)));
        var normalized = rough / magnitude;
        var step = normalized switch
        {
            <= 1 => 1,
            <= 2 => 2,
            <= 2.5 => 2.5,
            <= 5 => 5,
            _ => 10
        };
        return step * magnitude;
    }

    // ── Collector plumbing ─────────────────────────────────────────────────

    // ── Insights ───────────────────────────────────────────────────────────

    private async void InsightsRangeButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _insightsRangeKey && _loaded)
        {
            return;
        }

        _insightsRangeKey = key;
        if (!_loaded)
        {
            return;
        }

        _settings.InsightsRange = key;
        _settings.Save();
        await RefreshInsightsAsync();
    }

    private async Task RefreshInsightsAsync()
    {
        if (_insightsRefreshing)
        {
            return;
        }

        _insightsRefreshing = true;
        try
        {
            var rangeDays = _insightsRangeKey switch { "last7" => 7, "last90" => 90, _ => 30 };
            var sinceMs = DateTimeOffset.UtcNow.AddDays(-rangeDays).ToUnixTimeMilliseconds();
            var events = await _database.GetInsightEventsAsync(sinceMs);
            var plan = _planMonthlyUsd;
            var report = await Task.Run(() => InsightsEngine.Compute(events, _pricing, rangeDays, plan));
            if (!_disposed)
            {
                UpdateInsights(report, rangeDays);
            }
        }
        catch (Exception exception)
        {
            ShowError($"Could not build insights: {exception.Message}");
        }
        finally
        {
            _insightsRefreshing = false;
        }
    }

    private void UpdateInsights(InsightsReport report, int rangeDays)
    {
        var hasData = report.Events > 0 && report.TotalCost > 0;
        AnatomyCard.Visibility = hasData ? Visibility.Visible : Visibility.Collapsed;
        ContextCard.Visibility = hasData ? Visibility.Visible : Visibility.Collapsed;
        InsightTipsList.Visibility = hasData ? Visibility.Visible : Visibility.Collapsed;
        InsightsEmpty.Visibility = hasData ? Visibility.Collapsed : Visibility.Visible;
        InsightsSubtitle.Text = hasData
            ? $"Last {rangeDays} days · {Plural(report.Events, "response")} across {Plural(report.Sessions, "session")} · estimated API list prices."
            : "What your usage costs at API list prices, and where the same work could cost less.";
        if (!hasData)
        {
            return;
        }

        AnatomyTotalText.Text = FormatMoney(report.TotalCost);
        AnatomyTotalText.ToolTip = $"Estimated cost of the last {rangeDays} days at API list prices.";

        var slices = new (string Name, double Cost, long Tokens, Brush Brush)[]
        {
            ("Input", report.InputCost, report.InputTokens, _seriesBrushes[0]),
            ("Output", report.OutputCost, report.OutputTokens, _seriesBrushes[1]),
            ("Cache read", report.CacheReadCost, report.CacheReadTokens, _seriesBrushes[2]),
            ("Cache write", report.CacheWriteCost, report.CacheWriteTokens, _seriesBrushes[4])
        };

        AnatomyBar.Children.Clear();
        AnatomyBar.ColumnDefinitions.Clear();
        var visible = slices.Where(slice => slice.Cost > 0).ToList();
        foreach (var (index, slice) in visible.Index())
        {
            // Star widths proportional to cost, floored so slivers stay hoverable.
            AnatomyBar.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = new GridLength(Math.Max(slice.Cost, report.TotalCost * 0.006), GridUnitType.Star)
            });
            var segment = new Border
            {
                Background = slice.Brush,
                CornerRadius = new CornerRadius(3),
                Margin = new Thickness(0, 0, index == visible.Count - 1 ? 0 : 2, 0),
                ToolTip = $"{slice.Name}: {FormatMoney(slice.Cost)} ({ShareOfTotal(slice.Cost)}) · {FormatCompact(slice.Tokens)} tokens"
            };
            Grid.SetColumn(segment, index);
            AnatomyBar.Children.Add(segment);
        }

        AnatomyLegend.ItemsSource = slices.Select(slice => new AnatomySliceVm(
            slice.Brush,
            slice.Name,
            $"{FormatMoney(slice.Cost)} · {ShareOfTotal(slice.Cost)}",
            $"{slice.Tokens:N0} tokens")).ToList();

        var contextShare = (report.InputCost + report.CacheReadCost) / report.TotalCost;
        var outputShare = report.OutputCost / report.TotalCost;
        AnatomyTakeaway.Text =
            $"{contextShare:P0} of the money paid for context flowing into the model — prompts, history and " +
            $"cached re-reads — while the text it actually wrote is {outputShare:P0}. Shrinking what each reply " +
            "re-reads moves the bill; shortening answers barely does.";

        var maxBandCost = report.ContextBands.Max(band => band.Cost);
        ContextBandsList.ItemsSource = report.ContextBands.Select((band, index) =>
        {
            var brush = new SolidColorBrush(HeatColor(index / (double)(report.ContextBands.Count - 1)));
            brush.Freeze();
            return new ContextBandVm(
                band.Label,
                maxBandCost > 0 ? band.Cost / maxBandCost : 0,
                brush,
                FormatMoney(band.Cost),
                band.ShareOfCost.ToString("P0"),
                $"{band.Events:N0} responses re-read {band.Label} tokens of context — " +
                $"{FormatMoney(band.Cost)} ({band.ShareOfCost:P0} of the range).");
        }).ToList();

        InsightTipsList.ItemsSource = report.Tips.Select(tip =>
        {
            var brush = tip.Kind switch
            {
                InsightKind.Saving => LimitWarningBrush,
                InsightKind.Good => _seriesBrushes[1],
                _ => _seriesBrushes[0]
            };
            var label = tip.Kind switch
            {
                InsightKind.Saving => "POTENTIAL SAVING",
                InsightKind.Good => "WORKING FOR YOU",
                _ => "PATTERN"
            };
            return new InsightTipVm(brush, label, tip.Title, tip.Body, tip.Figure, brush);
        }).ToList();

        string ShareOfTotal(double cost) => (cost / report.TotalCost).ToString("P0");
    }

    private RadioButton InsightsRangeRadioFor(string key) => key switch
    {
        "last7" => InsightsR7,
        "last90" => InsightsR90,
        _ => InsightsR30
    };

    private static string NormalizeInsightsRangeKey(string key) =>
        key is "last7" or "last90" ? key : "last30";

    private sealed record AnatomySliceVm(Brush Brush, string Name, string Detail, string Tooltip);

    private sealed record ContextBandVm(
        string Label,
        double BarValue,
        Brush BarBrush,
        string CostText,
        string ShareText,
        string Tooltip);

    private sealed record InsightTipVm(
        Brush DotBrush,
        string KindLabel,
        string Title,
        string Body,
        string Figure,
        Brush FigureBrush);

    private void Collector_ProgressChanged(CollectorProgress progress)
    {
        Dispatcher.BeginInvoke(() =>
        {
            StatusText.Foreground = (Brush)FindResource("MutedBrush");
            RefreshButton.IsEnabled = !progress.IsBusy;
            FullRescanButton.IsEnabled = !progress.IsBusy;
            ScanProgress.Visibility = progress.IsBusy ? Visibility.Visible : Visibility.Collapsed;
            ScanProgress.IsIndeterminate = progress.IsBusy && progress.Total == 0;
            ScanProgress.Maximum = Math.Max(1, progress.Total);
            ScanProgress.Value = Math.Min(progress.Current, Math.Max(1, progress.Total));
            var file = string.IsNullOrWhiteSpace(progress.CurrentFile)
                ? string.Empty
                : $" · {Path.GetFileName(progress.CurrentFile)}";
            var count = progress.Total > 0 ? $" {progress.Current:N0}/{progress.Total:N0}" : string.Empty;
            StatusText.Text = $"{progress.Activity}{count}{file}";
        });
    }

    private void Collector_DataChanged() =>
        Dispatcher.BeginInvoke(async () =>
        {
            await RefreshDashboardAsync();
            if (_liveStarted)
            {
                await PullLiveEventsAsync();
            }
        });

    private void Collector_Error(string message) => Dispatcher.BeginInvoke(() => ShowError(message));

    private void ShowError(string message)
    {
        StatusText.Text = message;
        StatusText.Foreground = Brushes.IndianRed;
    }

    // ── Formatting ─────────────────────────────────────────────────────────

    private RadioButton RangeRadioFor(string key) => key switch
    {
        "session" => RangeSession,
        "last1" => RangeLast1,
        "last4" => RangeLast4,
        "last8" => RangeLast8,
        "last12" => RangeLast12,
        "last18" => RangeLast18,
        "last24" => RangeLast24,
        "today" => RangeToday,
        "last10" => RangeLast10,
        "last15" => RangeLast15,
        "last30" => RangeLast30,
        "currentMonth" => RangeMonth,
        "all" => RangeAll,
        _ => RangeLast7
    };

    private static string NormalizeRangeKey(string key) => key switch
    {
        "previousMonth" => "currentMonth",
        "session" or "last1" or "last4" or "last8" or "last12" or "last18" or "last24" or "today"
            or "last7" or "last10" or "last15" or "last30" or "currentMonth" or "all" => key,
        _ => "last7"
    };

    private RadioButton BarsRadioFor(string key) => key switch
    {
        "s75" => BarsS75,
        "s15" => BarsS15,
        "s30" => BarsS30,
        "m1" => BarsM1,
        "m5" => BarsM5,
        "m15" => BarsM15,
        "m30" => BarsM30,
        "h1" => BarsH1,
        "h4" => BarsH4,
        "h12" => BarsH12,
        "d1" => BarsD1,
        _ => BarsAuto
    };

    private static string NormalizeBarsKey(string key) => key switch
    {
        "s75" or "s15" or "s30" or "m1" or "m5" or "m15" or "m30" or "h1" or "h4" or "h12" or "d1" => key,
        _ => "auto"
    };

    private static string Plural(long count, string unit) =>
        $"{count:N0} {unit}{(count == 1 ? string.Empty : "s")}";

    private static string FormatCompact(long value)
    {
        return value switch
        {
            >= 1_000_000_000_000 => $"{value / 1_000_000_000_000d:0.##}T",
            >= 1_000_000_000 => $"{value / 1_000_000_000d:0.##}B",
            >= 1_000_000 => $"{value / 1_000_000d:0.##}M",
            >= 1_000 => $"{value / 1_000d:0.#}K",
            _ => value.ToString("N0")
        };
    }

    /// <summary>Tight money format for on-bar labels: "$0.42", "$5.4", "$29", "$1,234".</summary>
    private static string FormatMoneyShort(double value)
    {
        return value switch
        {
            <= 0 => "$0",
            < 0.01 => "<1¢",
            < 1 => value.ToString("$0.00", Usd),
            < 10 => value.ToString("$0.0", Usd),
            _ => value.ToString("$#,##0", Usd)
        };
    }

    /// <summary>Money at honest precision: cents up to $100, whole dollars beyond, never fractional cents.</summary>
    private static string FormatMoney(double value)
    {
        return value switch
        {
            <= 0 => "$0",
            < 0.01 => "<$0.01",
            < 100 => value.ToString("C2", Usd),
            _ => value.ToString("C0", Usd)
        };
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App { IsExiting: false } app)
        {
            e.Cancel = true;
            app.HideWindow();
            return;
        }

        if (!_disposed)
        {
            _disposed = true;
            _collector.Dispose();
            _limitsService.Dispose();
            _apiServer.Dispose();
        }
    }

    private sealed record TimelineTableRow(
        string Period,
        string Cost,
        string Total,
        string Input,
        string Output,
        string Cache,
        string Messages);

    private sealed record ModelRowVm(
        string Name,
        Brush BarBrush,
        string CostLabel,
        double Share,
        string Detail,
        string Tooltip);

    private sealed record LegendItemVm(string Name, Brush Brush);
}
