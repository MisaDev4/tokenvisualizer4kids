using System.ComponentModel;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Brush = System.Windows.Media.Brush;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;
using ColorConverter = System.Windows.Media.ColorConverter;
using Cursors = System.Windows.Input.Cursors;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using Orientation = System.Windows.Controls.Orientation;
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
    private readonly TranscriptVault _vault;
    private readonly UsageCollector _collector;
    private readonly ClaudeLimitsService _limitsService = new();
    private readonly CodexLimitsService _codexLimitsService = new();
    private readonly TerminalStatusService _terminalsService = new();
    private readonly AgentActivityService _agentsService = new();
    private readonly GpuUsageService _gpuService = new();
    private readonly SessionTitleService _sessionTitles = new();
    private readonly OpenCodeUsageService _openCodeService;
    private readonly LocalApiServer _apiServer;
    private readonly RequestCaptureProxy _captureProxy = new();
    private readonly SemaphoreSlim _dashboardLock = new(1, 1);

    // The heatmap's days before today, cached between RefreshUsageHeatmapAsync
    // passes (see the comment there); keyed on the window they were read for.
    private static readonly TimeSpan HeatmapEarlierRefresh = TimeSpan.FromMinutes(15);
    private List<DailyUsageRow>? _heatmapEarlier;
    private long _heatmapEarlierSince;
    private long _heatmapEarlierUntil;
    private long _heatmapEarlierAtMs;

    /// <summary>An ANTHROPIC_BASE_URL someone else set, found when enabling the
    /// request-capture relay — shown instead of silently overwriting it.</summary>
    private string? _captureEnvConflict;

    /// <summary>A CODEX_ROLLOUT_TRACE_ROOT someone else set — left alone, so
    /// ephemeral Codex runs go uncounted rather than breaking their trace.</summary>
    private string? _codexTraceConflict;
    private bool _terminalsScanning;
    private bool _agentsScanning;
    private bool _gpuScanning;
    private bool _gpuCreditsFetching;

    /// <summary>What the terminals page currently shows, flattened. The scan
    /// behind it runs every 3s for the other pages, but re-templating 24 tiles
    /// and their tooltips that often is pure waste when nothing moved. Cleared
    /// while the page is off screen so the first tick back rebuilds.</summary>
    private string _terminalsSignature = "";

    /// <summary>What the agents page currently shows, flattened. A refresh that
    /// changes nothing skips the ItemsSource swap so the pulse animations keep
    /// their phase instead of restarting every tick.</summary>
    private string _agentsSignature = "";

    private string _agentsViewKey = "list";
    private string _tilesStyleKey = "cozy";
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

    /// <summary>Last fetched accounts and their attributed-usage lines, kept so
    /// a collapse/expand click re-renders the account cards without another
    /// fetch or heatmap redraw.</summary>
    private IReadOnlyList<ClaudeAccountLimits> _limitsAccounts = [];
    private Dictionary<string, string> _limitsUsageTexts = new(StringComparer.Ordinal);
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
    private bool _cupLayoutDirtyFlag;

    /// <summary>A pending layout pass. It is a property, not a field, because
    /// raising it is also the wake-up signal for the frame loop: LiveFrame
    /// detaches itself once nothing can move, so every caller that dirties the
    /// layout (new block, resize, settled round, sediment rebuild, view swap)
    /// has to be able to start it again.</summary>
    private bool _cupLayoutDirty
    {
        get => _cupLayoutDirtyFlag;
        set
        {
            _cupLayoutDirtyFlag = value;
            if (value && LiveViewVisible)
            {
                StartLiveFrames();
            }
        }
    }
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

    // Block budget for the whole cup. Every block is a live element that each
    // new response re-lays-out (and, when the floor moves, re-animates), so a
    // night of agents in endless mode used to leave tens of thousands of them
    // on the canvas and the dashboard crawling.
    private const int MaxCupBlocks = 800;

    // Endless trims its oldest blocks in batches, so the pile reflows once per
    // batch rather than shifting every block on every arrival.
    private const int EndlessTrimBatch = 200;

    // What endless mode trimmed off the bottom: the stacked totals keep
    // counting it, and a late update to a trimmed event is not re-spawned.
    private double _endlessTrimmedCost;
    private long _endlessTrimmedTokens;
    private long _endlessTrimmedMessages;
    private int _endlessTrimmedCount;
    private long _endlessTrimmedThroughMs = long.MinValue;

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

        // Sitting exactly on its target: AdvanceCup skips it entirely, so a deep
        // pile costs nothing per frame. Cleared by PackInto whenever the target,
        // the side or the floor beneath it moves.
        public bool Settled { get; set; }

        // Part of a settled layer: packed below the active round's floor.
        public bool Frozen { get; set; }
    }

    // Slots only fix the chart's stacking order (biggest spenders claim low
    // slots first, so they sit at the bottom of the stack). Every model gets
    // one — nothing pools into a gray "Other" band. Colors are not tied to
    // slots: each model's color persists in settings, so nothing repaints
    // between runs or ranges.
    // Mirrors UsageDatabase.MaxBuckets: bar sizes that would exceed it are disabled.
    private const int MaxChartBars = 1500;
    private readonly Dictionary<string, int> _modelSlots = new(StringComparer.OrdinalIgnoreCase);
    private readonly Brush[] _seriesBrushes;
    private readonly Brush _otherBrush;
    private readonly Dictionary<string, SolidColorBrush> _brushByHex = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Saturation/lightness for generated model colors. Hues are not preset:
    /// each new model gets the hue farthest on the wheel from every color in use, so
    /// colors stay as distinguishable as the model count allows. Keep in sync with the
    /// HueSlider gradient stops in MainWindow.xaml.</summary>
    private const double ModelColorSaturation = 0.70;
    private const double ModelColorLightness = 0.58;

    /// <summary>Known families claim these first, so on a fresh install Fable is
    /// blue and Opus is coral no matter which one happens to show up first.</summary>
    private static readonly (string Token, string Hex)[] FamilySeeds =
    [
        ("fable", "#3987E5"),
        ("mythos", "#3987E5"),
        ("opus", "#E5484D"),
        ("sonnet", "#9085E9"),
        ("haiku", "#199E70"),
        ("gpt", "#12A594")
    ];

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
        _vault = new TranscriptVault(_database, _settings);
        _collector = new UsageCollector(_database, _settings, vault: _vault);
        _collector.ProgressChanged += Collector_ProgressChanged;
        _collector.DataChanged += Collector_DataChanged;
        _collector.Error += Collector_Error;
        // OpenCode (and T3 Code, which embeds it) records usage in its own
        // SQLite store rather than tailable JSONL, so it gets a poller instead
        // of a collector root. Same refresh path as the collector: the live
        // feed and dashboard update the moment new rows land.
        _openCodeService = new OpenCodeUsageService(_database);
        _openCodeService.DataChanged += Collector_DataChanged;
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
        _agentsViewKey = _settings.SelectedAgentsView is "map" or "lanes" or "tiles"
            ? _settings.SelectedAgentsView
            : "list";
        AgentsViewRadioFor(_agentsViewKey).IsChecked = true;
        _tilesStyleKey = _settings.SelectedTilesStyle is "meter" or "mini" or "rich"
            ? _settings.SelectedTilesStyle
            : "cozy";
        TilesStyleRadioFor(_tilesStyleKey).IsChecked = true;

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
        CaptureCheckBox.IsChecked = _settings.CaptureRequestsEnabled;
        if (_settings.CaptureRequestsEnabled)
        {
            StartRequestCapture();
        }

        UpdateCaptureStatusText();
        // Before Window_Loaded starts the collector, so the trace folder exists
        // when its watcher is attached.
        CodexTraceCheckBox.IsChecked = _settings.CodexTraceEnabled;
        if (_settings.CodexTraceEnabled)
        {
            _codexTraceConflict = CodexTraces.SetEnvironment();
        }

        UpdateCodexTraceStatusText();
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
        // handful of recently touched transcript files. It runs whatever tab is
        // up — the live chips and the local API read it — and RefreshTerminalsAsync
        // gates the tile rebuild on the page being on screen and actually changed.
        var terminalsRefresh = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(3)
        };
        terminalsRefresh.Tick += async (_, _) => await RefreshTerminalsAsync();
        terminalsRefresh.Start();

        // Subagent trees only matter while their page is on screen; the scan
        // itself is incremental (saved file offsets), so this stays cheap.
        var agentsRefresh = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(3)
        };
        agentsRefresh.Tick += async (_, _) =>
        {
            if (_tabKey == "agents" && IsVisible)
            {
                await RefreshAgentsAsync();
            }
        };
        agentsRefresh.Start();
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

            // Everything above feeds other pages and the local API, so it runs
            // on every tick; the tiles below only exist while this page is up.
            if (_tabKey != "terminals")
            {
                _terminalsSignature = "";
                return;
            }

            // A terminal is named by what its chat is about (the session's
            // first prompt); the folder name is the fallback. Two identical
            // names still get a session stub so the tiles stay tellable apart.
            // Two terminals can carry the same session id — a resumed session
            // whose old process is still winding down — so this is built the
            // same last-one-wins way as bySession above rather than with
            // ToDictionary, which throws on the repeat.
            var nameBySession = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var status in terminals)
            {
                nameBySession[status.SessionId] =
                    SessionTopic(status.SessionId) ?? DisplayProject(status.ProjectName);
            }
            var duplicateNames = nameBySession.Values
                .GroupBy(name => name, StringComparer.OrdinalIgnoreCase)
                .Where(group => group.Count() > 1)
                .Select(group => group.Key)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            // One clock for the whole pass, so the age a tile shows and the age
            // the signature was taken from can never straddle a minute boundary.
            var now = DateTimeOffset.UtcNow;
            var shown = terminals.Take(24).Select(status =>
            {
                var baseName = nameBySession[status.SessionId];
                var displayName = DisplayProject(status.ProjectName);
                return (
                    Status: status,
                    Text: StatusTextFor(status.State, now - status.LastActivity),
                    Name: duplicateNames.Contains(baseName)
                        ? $"{baseName} · {status.SessionId[..Math.Min(4, status.SessionId.Length)]}"
                        : baseName,
                    DisplayPath: HidePersonal ? $@"~\…\{displayName}" : status.ProjectPath);
            }).ToList();

            var ready = terminals.Count(status => status.State == TerminalState.Ready);
            var working = terminals.Count(status => status.State == TerminalState.Working);
            var waiting = terminals.Count(status => status.State == TerminalState.Waiting);

            // Re-templating 24 tiles and their tooltips costs far more than the
            // scan does, and at 3s it would land on a page that mostly hasn't
            // moved. The signature carries every string a tile shows — the age
            // text included, so it turns over exactly when the page would.
            var signature = $"{ready}|{working}|{waiting}|{terminals.Count}|" + string.Join("", shown.Select(entry =>
                $"{entry.Status.SessionId}|{entry.Status.State}|{entry.Text}|" +
                $"{entry.Name}|{entry.DisplayPath}|{entry.Status.Pid}|"));
            if (signature == _terminalsSignature)
            {
                return;
            }

            _terminalsSignature = signature;
            TerminalsPanel.ItemsSource = shown.Select(entry =>
            {
                var status = entry.Status;
                var (state, meaning) = status.State switch
                {
                    TerminalState.Ready => (
                        (Brush)FindResource("Series2Brush"),
                        "Turn finished — waiting for your prompt."),
                    TerminalState.Waiting => (
                        LimitWarningBrush,
                        "Mid-turn but quiet — possibly a permission prompt or a long tool."),
                    _ => (
                        (Brush)FindResource("AccentBrush"),
                        "Mid-turn: the model is generating or running tools.")
                };
                var (iconGeometry, iconBrush, appName) = status.App == TerminalApp.Codex
                    ? (OpenAiIconGeometry, OpenAiIconBrush, "Codex")
                    : (AnthropicIconGeometry, AnthropicIconBrush, "Claude Code");
                return new TerminalTileVm(
                    entry.Name,
                    entry.Text,
                    state,
                    state,
                    EdgeBrushFor(state),
                    iconGeometry,
                    iconBrush,
                    entry.DisplayPath,
                    $"{appName} · {entry.DisplayPath}\n{meaning}{SessionPromptLines(status.SessionId)}\nlast activity {status.LastActivity.ToLocalTime():h:mm:ss tt} · session {status.SessionId[..Math.Min(8, status.SessionId.Length)]}" +
                        (status.Pid > 0 ? "\n\nClick to bring this terminal to the front." : ""),
                    status.Pid,
                    status.Pid > 0 ? System.Windows.Input.Cursors.Hand : System.Windows.Input.Cursors.Arrow);
            }).ToList();

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

    /// <summary>The line a tile shows under its name. The signature gate reads
    /// it too, so the two can't disagree about when the page has changed.</summary>
    private static string StatusTextFor(TerminalState state, TimeSpan age) => state switch
    {
        TerminalState.Ready => age.TotalSeconds < 60 ? "ready" : $"ready · {AgeText(age)}",
        TerminalState.Waiting => $"waiting · {AgeText(age)}",
        _ => "working…"
    };

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

    // ── Agents page ────────────────────────────────────────────────────────

    private async Task RefreshAgentsAsync()
    {
        if (_agentsScanning)
        {
            return;
        }

        _agentsScanning = true;
        try
        {
            var scanTimer = System.Diagnostics.Stopwatch.StartNew();
            var scanned = await _agentsService.ScanAsync(TimeSpan.FromHours(6));
            scanTimer.Stop();

            // A live board, not a history: a session shows while its
            // orchestrator or any of its agents is still moving — an
            // orchestrator crunching results after every subagent settled
            // is work in progress, not history.
            var sessions = scanned
                .Where(session => session.Head.State != SubagentState.Done ||
                                  session.Agents.Any(agent => agent.State != SubagentState.Done))
                .ToList();
            TraceAgentsScan(scanTimer.ElapsedMilliseconds, scanned, sessions);
            if (_disposed)
            {
                return;
            }

            var working = sessions.Sum(session => session.Agents.Count(agent => agent.State == SubagentState.Running));
            var quiet = sessions.Sum(session => session.Agents.Count(agent => agent.State == SubagentState.Quiet));
            AgentsSubtitle.Text = sessions.Count == 0
                ? "The moment any Claude session is working — itself or through agents — it appears here."
                : $"{working} working · {quiet} quiet · " +
                  $"{sessions.Count} live session{(sessions.Count == 1 ? "" : "s")}";
            AgentsEmpty.Visibility = sessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            var cards = sessions.Take(16).Select(BuildOrchestratorCard).ToList();

            // Redrawing identical content would restart every pulse animation,
            // so the signature gate only swaps the list when something changed.
            TilesStyleGroup.Visibility = _agentsViewKey == "tiles" ? Visibility.Visible : Visibility.Collapsed;

            // Tiles carry a live burn sparkline, so raw totals join the
            // signature there — the other views only redraw on text changes.
            var tilesExtra = _agentsViewKey == "tiles"
                ? $"{_tilesStyleKey}|{sessions.Sum(session => session.Head.Tokens.Total + session.Agents.Sum(agent => agent.Tokens.Total))}|"
                : "";
            var signature = _agentsViewKey + "|" + tilesExtra + string.Join("", cards.Select(card =>
                $"{card.Name}|{card.StateText}|{card.HeadStatusText}|{card.HeadMetricsText}|" +
                $"{card.SummaryText}|{card.PathText}|" +
                string.Join("", card.Agents.Select(row =>
                    $"{row.TypeBadge}|{row.Description}|{row.StatusText}|{row.MetricsText}"))));
            if (signature != _agentsSignature)
            {
                _agentsSignature = signature;
                var list = _agentsViewKey == "list";
                AgentsPanel.Visibility = list ? Visibility.Visible : Visibility.Collapsed;
                AgentsAltPanel.Visibility = list ? Visibility.Collapsed : Visibility.Visible;
                AgentsAltPanel.Children.Clear();
                if (list)
                {
                    AgentsPanel.ItemsSource = cards;
                }
                else
                {
                    AgentsPanel.ItemsSource = null;
                    foreach (var session in sessions.Take(16))
                    {
                        AgentsAltPanel.Children.Add(_agentsViewKey switch
                        {
                            "map" => BuildSessionMap(session),
                            "lanes" => BuildSessionLanes(session),
                            _ => BuildSessionTiles(session)
                        });
                    }
                }
            }
        }
        catch (Exception exception)
        {
            // A refresh failure must be visible on the page and in the log —
            // silently dying here reads as "the tab detects nothing".
            TraceAgentsError(exception);
            AgentsSubtitle.Text = $"agents scan failed: {exception.Message} — details in agents-scan.log";
        }
        finally
        {
            _agentsScanning = false;
        }
    }

    /// <summary>One line per refresh, plus the per-session picture whenever it
    /// changes — the flight recorder for "the tab showed nothing" reports.</summary>
    private void TraceAgentsScan(
        long scanMs, IReadOnlyList<OrchestratorActivity> scanned, List<OrchestratorActivity> shown)
    {
        try
        {
            var running = scanned.Sum(session => session.Agents.Count(agent => agent.State == SubagentState.Running));
            var picture = string.Join("; ", scanned.Select(session =>
                $"{session.ProjectName}/{session.SessionId[..Math.Min(8, session.SessionId.Length)]} " +
                $"head={session.Head.State} " +
                $"run={session.Agents.Count(agent => agent.State == SubagentState.Running)} " +
                $"quiet={session.Agents.Count(agent => agent.State == SubagentState.Quiet)} " +
                $"done={session.Agents.Count(agent => agent.State == SubagentState.Done)}"));
            var line =
                $"{DateTime.Now:MM-dd HH:mm:ss} scan={scanMs}ms sessions={scanned.Count} shown={shown.Count} " +
                $"agents={scanned.Sum(session => session.Agents.Count)} running={running} view={_agentsViewKey}";
            if (picture != _agentsTraceSignature)
            {
                _agentsTraceSignature = picture;
                line += picture.Length == 0 ? "\n  (no sessions)" : $"\n  {picture.Replace("; ", "\n  ")}";
            }

            File.AppendAllText(AppPaths.AgentsScanLogPath, line + "\n");
            if (++_agentsTraceCount % 500 == 0 &&
                new FileInfo(AppPaths.AgentsScanLogPath) is { Exists: true, Length: > 1_000_000 } info)
            {
                var tail = File.ReadAllLines(info.FullName);
                File.WriteAllLines(info.FullName, tail.Skip(tail.Length - 2000));
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The log is diagnostics, never worth failing a refresh over.
        }
    }

    private void TraceAgentsError(Exception exception)
    {
        try
        {
            File.AppendAllText(
                AppPaths.AgentsScanLogPath,
                $"{DateTime.Now:MM-dd HH:mm:ss} ERROR {exception}\n");
        }
        catch (Exception secondary) when (secondary is IOException or UnauthorizedAccessException)
        {
        }
    }

    private string _agentsTraceSignature = "";
    private int _agentsTraceCount;

    private OrchestratorCardVm BuildOrchestratorCard(OrchestratorActivity session)
    {
        var now = DateTimeOffset.UtcNow;
        var muted = (Brush)FindResource("MutedBrush");

        // Only agents still out working get rows; whatever already finished
        // folds into one summary line so the totals keep adding up.
        var visible = session.Agents.Where(agent => agent.State != SubagentState.Done).ToList();
        var collapsed = session.Agents.Where(agent => agent.State == SubagentState.Done).ToList();

        var rows = visible.Select(agent =>
        {
            var glance = GlanceFor(agent, now);
            return new AgentRowVm(
                new Thickness(17 + (agent.Depth - 1) * 22, 2, 0, 2),
                glance.DotBrush,
                glance.IsRunning,
                glance.Badge,
                glance.Description,
                glance.StatusText,
                glance.StatusBrush,
                glance.MetricsText,
                glance.Tooltip);
        }).ToList();

        if (collapsed.Count > 0)
        {
            var foldedTokens = collapsed.Sum(agent => agent.Tokens.Total);
            var foldedCost = collapsed.Sum(agent => _pricing.Calculate("anthropic", agent.Model, agent.Tokens).Cost);
            rows.Add(new AgentRowVm(
                new Thickness(17, 2, 0, 2),
                Brushes.Transparent,
                false,
                $"+{collapsed.Count}",
                collapsed.Count == 1 ? "agent already finished" : "agents already finished",
                "",
                muted,
                $"{FormatCompact(foldedTokens)} tok · {FormatMoney(foldedCost)}",
                $"{collapsed.Count} agent{(collapsed.Count == 1 ? "" : "s")} from this session already finished; " +
                "only agents still working get their own row."));
        }

        var glanceS = SessionGlanceFor(session);
        return new OrchestratorCardVm(
            glanceS.Name,
            glanceS.StateText,
            glanceS.StateBrush,
            glanceS.HeadBrush,
            glanceS.IsRunning,
            glanceS.EdgeBrush,
            AnthropicIconGeometry,
            AnthropicIconBrush,
            glanceS.PathText,
            glanceS.SummaryText,
            glanceS.Head.StatusText,
            glanceS.Head.StatusBrush,
            glanceS.Head.MetricsText,
            glanceS.Tooltip,
            glanceS.Pid,
            glanceS.Pid > 0 ? Cursors.Hand : Cursors.Arrow,
            rows);
    }

    /// <summary>Everything any of the four views needs to say about one agent.</summary>
    private sealed record AgentGlance(
        Brush DotBrush,
        bool IsRunning,
        string Badge,
        string Description,
        string StatusText,
        Brush StatusBrush,
        string MetricsText,
        string Tooltip);

    private AgentGlance GlanceFor(SubagentActivity agent, DateTimeOffset now)
    {
        var accent = (Brush)FindResource("AccentBrush");
        var settled = (Brush)FindResource("Series2Brush");
        var muted = (Brush)FindResource("MutedBrush");
        var (dotBrush, statusText, statusBrush, isRunning) = agent.State switch
        {
            SubagentState.Running => (
                accent,
                agent.LastTool.Length > 0 ? $"working · {ToolLabel(agent.LastTool)}" : "working…",
                accent,
                true),
            SubagentState.Quiet => (
                LimitWarningBrush,
                $"quiet · {AgeText(now - agent.LastActivity)}",
                LimitWarningBrush,
                false),
            _ => (
                settled,
                $"{agent.DoneLabel} · {AgeText(now - (agent.CompletedAt ?? agent.LastActivity))} ago",
                muted,
                false)
        };

        var elapsed = (agent.CompletedAt ?? now) - agent.StartedAt;
        var estimate = _pricing.Calculate("anthropic", agent.Model, agent.Tokens);
        var metrics = agent.Tokens.Total == 0
            ? "starting…"
            : $"{FormatCompact(agent.Tokens.Total)} tok" +
              (estimate.IsPriced ? $" · {FormatMoney(estimate.Cost)}" : "") +
              $" · {AgeText(elapsed)}";
        var description = HidePersonal ? "task hidden" : agent.Description;
        var tooltip =
            $"{agent.AgentType} agent{(agent.Model.Length > 0 ? $" · {agent.Model}" : "")}\n{description}\n" +
            $"started {agent.StartedAt.ToLocalTime():h:mm:ss tt} · {statusText}\n" +
            $"{FormatCompact(agent.Tokens.Input)} in · {FormatCompact(agent.Tokens.Output)} out · " +
            $"{FormatCompact(agent.Tokens.CacheRead + agent.Tokens.CacheWrite)} cache · {agent.ToolCalls} tool calls";
        return new AgentGlance(
            dotBrush, isRunning, agent.AgentType, description, statusText, statusBrush, metrics, tooltip);
    }

    private sealed record SessionGlance(
        string Name,
        string StateText,
        Brush StateBrush,
        Brush HeadBrush,
        bool IsRunning,
        Brush EdgeBrush,
        string PathText,
        string SummaryText,
        string Tooltip,
        int Pid,
        AgentGlance Head);

    private SessionGlance SessionGlanceFor(OrchestratorActivity session)
    {
        var accent = (Brush)FindResource("AccentBrush");
        var settled = (Brush)FindResource("Series2Brush");
        var muted = (Brush)FindResource("MutedBrush");
        var head = GlanceFor(session.Head, DateTimeOffset.UtcNow);
        var headRunning = session.Head.State == SubagentState.Running;
        var headQuiet = session.Head.State == SubagentState.Quiet;
        var live = session.Agents.Count(agent => agent.State == SubagentState.Running);
        var quietCount = session.Agents.Count(agent => agent.State == SubagentState.Quiet);
        var name = SessionTopic(session.SessionId) ?? DisplayProject(session.ProjectName);
        var stateText = live > 0
            ? $"{live} agent{(live == 1 ? "" : "s")} working"
            : quietCount > 0
                ? $"{quietCount} agent{(quietCount == 1 ? "" : "s")} quiet"
                : session.Agents.Count > 0
                    ? "agents settled"
                    : "no agents out";
        var totalTokens = session.Agents.Sum(agent => agent.Tokens.Total);
        var totalCost = session.Agents.Sum(agent => _pricing.Calculate("anthropic", agent.Model, agent.Tokens).Cost);
        var summary =
            $"{session.Agents.Count} agent{(session.Agents.Count == 1 ? "" : "s")} · " +
            $"{FormatCompact(totalTokens)} tok · {FormatMoney(totalCost)}";
        var appName = session.IsDesktopApp ? "Claude app" : "Claude Code";
        var displayPath = HidePersonal ? $@"~\…\{DisplayProject(session.ProjectName)}" : session.ProjectPath;
        var pid = SessionPid(session.SessionId);
        var headBrush = headRunning || live > 0
            ? accent
            : headQuiet || quietCount > 0 ? LimitWarningBrush : settled;
        return new SessionGlance(
            name,
            stateText,
            headRunning || live > 0 ? accent : headQuiet || quietCount > 0 ? LimitWarningBrush : muted,
            headBrush,
            headRunning || live > 0,
            EdgeBrushFor(headBrush),
            $"{appName} · {displayPath}",
            summary,
            $"{appName} · {displayPath}\nsession {session.SessionId[..Math.Min(8, session.SessionId.Length)]} · " +
                $"last activity {session.LastActivity.ToLocalTime():h:mm:ss tt}\n" +
                $"orchestrator {head.StatusText} · {head.MetricsText}" +
                (pid > 0 ? "\n\nClick to bring this terminal to the front." : ""),
            pid,
            head);
    }

    /// <summary>MCP tool names carry their server as a prefix; the tail is the
    /// part a human recognizes.</summary>
    private static string ToolLabel(string name)
    {
        var split = name.LastIndexOf("__", StringComparison.Ordinal);
        return split >= 0 && split + 2 < name.Length ? name[(split + 2)..] : name;
    }

    private void OrchestratorCard_Clicked(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: OrchestratorCardVm { Pid: > 0 } vm })
        {
            TerminalFocusService.TryFocus(vm.Pid);
        }
    }

    private void AgentsViewButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _agentsViewKey && _loaded)
        {
            return;
        }

        _agentsViewKey = key;
        if (AgentsAltPanel is null)
        {
            return;
        }

        _agentsSignature = "";
        if (_loaded)
        {
            _settings.SelectedAgentsView = key;
            _settings.Save();
            _ = RefreshAgentsAsync();
        }
    }

    private RadioButton AgentsViewRadioFor(string key) => key switch
    {
        "map" => AgentsViewMap,
        "lanes" => AgentsViewLanes,
        "tiles" => AgentsViewTiles,
        _ => AgentsViewList
    };

    private void TilesStyleButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _tilesStyleKey && _loaded)
        {
            return;
        }

        _tilesStyleKey = key;
        if (AgentsAltPanel is null)
        {
            return;
        }

        _agentsSignature = "";
        if (_loaded)
        {
            _settings.SelectedTilesStyle = key;
            _settings.Save();
            _ = RefreshAgentsAsync();
        }
    }

    private RadioButton TilesStyleRadioFor(string key) => key switch
    {
        "meter" => TilesStyleMeter,
        "mini" => TilesStyleMini,
        "rich" => TilesStyleRich,
        _ => TilesStyleCozy
    };

    /// <summary>Tokens burned per scan, drawn as a strip of tiny bars — flat
    /// means coasting, tall means producing. The newest bar is rightmost.</summary>
    private FrameworkElement BurnSparkline(IReadOnlyList<long> samples, Brush active)
    {
        var baseline = (Brush)FindResource("RaisedBrush");
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Height = 15 };
        var recent = samples.Count > 22 ? samples.Skip(samples.Count - 22).ToList() : samples.ToList();
        var peak = Math.Max(1, recent.Count == 0 ? 1 : recent.Max());
        for (var index = 0; index < 22; index++)
        {
            var value = index < 22 - recent.Count ? 0 : recent[index - (22 - recent.Count)];
            panel.Children.Add(new Rectangle
            {
                Width = 4,
                Height = value > 0 ? 3 + 12.0 * value / peak : 2,
                RadiusX = 1,
                RadiusY = 1,
                Fill = value > 0 ? active : baseline,
                Opacity = value > 0 ? 0.85 : 1,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, 1, 0)
            });
        }

        return panel;
    }

    /// <summary>"claude-fable-5 (fast)" → "fable-5 (fast)": the family is the
    /// part that matters on a 200px tile.</summary>
    private static string ShortModel(string model) =>
        model.StartsWith("claude-", StringComparison.OrdinalIgnoreCase) ? model["claude-".Length..] : model;

    private static TextBlock GlanceText(
        string text, double size, Brush brush, FontWeight? weight = null, Thickness? margin = null) => new()
    {
        Text = text,
        FontSize = size,
        Foreground = brush,
        FontWeight = weight ?? FontWeights.Normal,
        Margin = margin ?? new Thickness(0),
        VerticalAlignment = VerticalAlignment.Center,
        TextTrimming = TextTrimming.CharacterEllipsis
    };

    private Border AgentsCardShell(SessionGlance glance, UIElement content) => new()
    {
        Style = (Style)FindResource("Card"),
        Padding = new Thickness(20, 16, 20, 16),
        Margin = new Thickness(0, 0, 0, 14),
        BorderBrush = glance.EdgeBrush,
        BorderThickness = new Thickness(1),
        ToolTip = glance.Tooltip,
        Child = content
    };

    /// <summary>Map view: the orchestrator as a node on top, agents fanned out
    /// beneath it on a connector bus — the fleet's shape at a glance.</summary>
    private FrameworkElement BuildSessionMap(OrchestratorActivity session)
    {
        var now = DateTimeOffset.UtcNow;
        var glance = SessionGlanceFor(session);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");
        var line = (Brush)FindResource("RaisedBrush");

        var stack = new StackPanel();
        var pillContent = new StackPanel { Orientation = Orientation.Horizontal };
        pillContent.Children.Add(new Ellipse
        {
            Width = 9, Height = 9, Fill = glance.HeadBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 8, 0)
        });
        var pillName = GlanceText(glance.Name, 13.5, ink, FontWeights.SemiBold);
        pillName.MaxWidth = 420;
        pillContent.Children.Add(pillName);
        pillContent.Children.Add(GlanceText(
            glance.Head.StatusText, 11, glance.Head.StatusBrush, FontWeights.SemiBold, new Thickness(10, 1, 0, 0)));
        pillContent.Children.Add(GlanceText(
            glance.StateText, 11.5, glance.StateBrush, FontWeights.SemiBold, new Thickness(10, 1, 0, 0)));
        stack.Children.Add(new Border
        {
            Background = line,
            CornerRadius = new CornerRadius(9),
            Padding = new Thickness(14, 8, 14, 8),
            HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
            BorderBrush = glance.EdgeBrush,
            BorderThickness = new Thickness(1),
            Child = pillContent
        });
        var subtitle = GlanceText(
            $"{glance.SummaryText}  ·  {glance.PathText}", 10.5, muted, null, new Thickness(0, 6, 0, 0));
        subtitle.HorizontalAlignment = System.Windows.HorizontalAlignment.Center;
        stack.Children.Add(subtitle);
        stack.Children.Add(new Border
        {
            Width = 1, Height = 14, Background = line, HorizontalAlignment = System.Windows.HorizontalAlignment.Center
        });
        stack.Children.Add(new Border { Height = 1, Background = line, Margin = new Thickness(70, 0, 70, 0) });

        // Nested agents hang inside their root's column, prefixed ↳.
        var liveAgents = session.Agents.Where(agent => agent.State != SubagentState.Done).ToList();
        var groups = new List<(SubagentActivity Root, List<SubagentActivity> Children)>();
        foreach (var agent in liveAgents)
        {
            if (agent.Depth <= 1 || groups.Count == 0)
            {
                groups.Add((agent, []));
            }
            else
            {
                groups[^1].Children.Add(agent);
            }
        }

        var wrap = new WrapPanel { HorizontalAlignment = System.Windows.HorizontalAlignment.Center };
        foreach (var (root, children) in groups)
        {
            var column = new StackPanel { Margin = new Thickness(7, 0, 7, 0) };
            column.Children.Add(new Border
            {
                Width = 1, Height = 12, Background = line, HorizontalAlignment = System.Windows.HorizontalAlignment.Center
            });
            column.Children.Add(AgentNodeBox(root, now));
            foreach (var child in children)
            {
                var childRow = new StackPanel
                {
                    Orientation = Orientation.Horizontal, Margin = new Thickness(16, 6, 0, 0)
                };
                childRow.Children.Add(GlanceText("↳", 12, muted, null, new Thickness(0, 0, 6, 0)));
                childRow.Children.Add(AgentNodeBox(child, now, width: 170));
                column.Children.Add(childRow);
            }

            wrap.Children.Add(column);
        }

        var finished = session.Agents.Where(agent => agent.State == SubagentState.Done).ToList();
        if (finished.Count > 0)
        {
            var foldStack = new StackPanel();
            foldStack.Children.Add(GlanceText($"+{finished.Count} finished", 11.5, muted, FontWeights.SemiBold));
            foldStack.Children.Add(GlanceText(
                $"{FormatCompact(finished.Sum(agent => agent.Tokens.Total))} tok · " +
                FormatMoney(finished.Sum(agent => _pricing.Calculate("anthropic", agent.Model, agent.Tokens).Cost)),
                10, muted, null, new Thickness(0, 3, 0, 0)));
            var foldColumn = new StackPanel { Margin = new Thickness(7, 0, 7, 0) };
            foldColumn.Children.Add(new Border
            {
                Width = 1, Height = 12, Background = line, HorizontalAlignment = System.Windows.HorizontalAlignment.Center
            });
            foldColumn.Children.Add(new Border
            {
                Width = 130,
                BorderBrush = line,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(10, 8, 10, 8),
                Child = foldStack
            });
            wrap.Children.Add(foldColumn);
        }

        stack.Children.Add(wrap);
        return AgentsCardShell(glance, stack);
    }

    private FrameworkElement AgentNodeBox(SubagentActivity agent, DateTimeOffset now, double width = 190)
    {
        var glance = GlanceFor(agent, now);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");
        var stack = new StackPanel();
        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new Ellipse
        {
            Width = 7, Height = 7, Fill = glance.DotBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 6, 0)
        });
        head.Children.Add(GlanceText(glance.Badge, 10, muted));
        stack.Children.Add(head);
        stack.Children.Add(GlanceText(glance.Description, 11.5, ink, null, new Thickness(0, 5, 0, 0)));
        stack.Children.Add(GlanceText(
            glance.StatusText, 10.5, glance.StatusBrush, FontWeights.SemiBold, new Thickness(0, 4, 0, 0)));
        stack.Children.Add(GlanceText(glance.MetricsText, 10, muted, null, new Thickness(0, 2, 0, 0)));
        return new Border
        {
            Width = width,
            Background = (Brush)FindResource("RaisedBrush"),
            BorderBrush = EdgeBrushFor(glance.DotBrush),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10, 8, 10, 8),
            Margin = new Thickness(0, 0, 0, 0),
            ToolTip = glance.Tooltip,
            Child = stack
        };
    }

    /// <summary>Lanes view: one horizontal bar per agent from launch to now, so
    /// waves of parallel work and stragglers are visible as shapes.</summary>
    private FrameworkElement BuildSessionLanes(OrchestratorActivity session)
    {
        var now = DateTimeOffset.UtcNow;
        var glance = SessionGlanceFor(session);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");

        var stack = new StackPanel();
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = new StackPanel { Orientation = Orientation.Horizontal };
        title.Children.Add(new Ellipse
        {
            Width = 9, Height = 9, Fill = glance.HeadBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 8, 0)
        });
        var laneName = GlanceText(glance.Name, 13.5, ink, FontWeights.SemiBold);
        laneName.MaxWidth = 430;
        title.Children.Add(laneName);
        title.Children.Add(GlanceText(
            glance.Head.StatusText, 11, glance.Head.StatusBrush, FontWeights.SemiBold, new Thickness(10, 1, 0, 0)));
        title.Children.Add(GlanceText(
            glance.StateText, 11.5, glance.StateBrush, FontWeights.SemiBold, new Thickness(10, 1, 0, 0)));
        header.Children.Add(title);
        var headerSummary = GlanceText(glance.SummaryText, 11, muted);
        Grid.SetColumn(headerSummary, 1);
        header.Children.Add(headerSummary);
        stack.Children.Add(header);
        stack.Children.Add(GlanceText(glance.PathText, 10.5, muted, null, new Thickness(17, 3, 0, 8)));

        var liveAgents = session.Agents.Where(agent => agent.State != SubagentState.Done).ToList();
        var minStart = liveAgents.Count > 0 ? liveAgents.Min(agent => agent.StartedAt) : now;
        var span = now - minStart;
        if (span < TimeSpan.FromMinutes(5))
        {
            span = TimeSpan.FromMinutes(5);
        }

        foreach (var agent in liveAgents)
        {
            var agentGlance = GlanceFor(agent, now);
            var row = new Grid { Margin = new Thickness(0, 2, 0, 2) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(250) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(160) });

            var label = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin = new Thickness(agent.Depth > 1 ? 16 : 0, 0, 8, 0)
            };
            label.Children.Add(new Ellipse
            {
                Width = 7, Height = 7, Fill = agentGlance.DotBrush,
                VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 6, 0)
            });
            label.Children.Add(GlanceText(agentGlance.Description, 11.5, ink));
            label.ToolTip = agentGlance.Tooltip;
            row.Children.Add(label);

            // Star-sized spacer/bar/spacer columns place the bar without any
            // pixel math surviving a resize.
            var startFraction = Math.Clamp((agent.StartedAt - minStart) / span, 0, 0.97);
            var barFraction = Math.Max(0.03, 1 - startFraction);
            var lane = new Grid { VerticalAlignment = VerticalAlignment.Center };
            lane.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = new GridLength(Math.Max(0.0001, startFraction), GridUnitType.Star)
            });
            lane.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = new GridLength(barFraction, GridUnitType.Star)
            });
            var bar = new Border
            {
                Height = 12,
                CornerRadius = new CornerRadius(6),
                Background = agentGlance.DotBrush,
                Opacity = 0.9,
                ToolTip = agentGlance.Tooltip
            };
            Grid.SetColumn(bar, 1);
            lane.Children.Add(bar);
            Grid.SetColumn(lane, 1);
            row.Children.Add(lane);

            var metrics = GlanceText(agentGlance.MetricsText, 10.5, muted, null, new Thickness(10, 0, 0, 0));
            metrics.TextAlignment = TextAlignment.Right;
            Grid.SetColumn(metrics, 2);
            row.Children.Add(metrics);
            stack.Children.Add(row);
        }

        var axis = new Grid { Margin = new Thickness(258, 4, 160, 0) };
        axis.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        axis.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        axis.Children.Add(GlanceText($"{AgeText(span)} ago", 10, muted));
        var nowLabel = GlanceText("now", 10, muted);
        Grid.SetColumn(nowLabel, 1);
        axis.Children.Add(nowLabel);
        stack.Children.Add(axis);

        var finished = session.Agents.Count(agent => agent.State == SubagentState.Done);
        if (finished > 0)
        {
            stack.Children.Add(GlanceText(
                $"+{finished} agent{(finished == 1 ? "" : "s")} already finished",
                10.5, muted, null, new Thickness(13, 6, 0, 0)));
        }

        return AgentsCardShell(glance, stack);
    }

    /// <summary>Tiles view: mission control — one compact tile per agent, the
    /// same grammar as the Terminals page.</summary>
    private FrameworkElement BuildSessionTiles(OrchestratorActivity session)
    {
        var now = DateTimeOffset.UtcNow;
        var glance = SessionGlanceFor(session);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");

        var stack = new StackPanel { Margin = new Thickness(0, 0, 0, 6) };

        // The orchestrator gets its own bar — the main agent the tiles below
        // report to, with its own live status, not just a session label.
        var bar = new Grid();
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.Children.Add(new Ellipse
        {
            Width = 9, Height = 9, Fill = glance.HeadBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 8, 0)
        });
        var chip = new Border
        {
            Background = (Brush)FindResource("RaisedBrush"),
            CornerRadius = new CornerRadius(4),
            Padding = new Thickness(6, 1.5, 6, 1.5),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
            Child = GlanceText("orchestrator", 10, muted)
        };
        Grid.SetColumn(chip, 1);
        bar.Children.Add(chip);
        var tilesName = GlanceText(glance.Name, 13, ink, FontWeights.SemiBold);
        tilesName.MaxWidth = 380;
        Grid.SetColumn(tilesName, 2);
        bar.Children.Add(tilesName);
        var headStatus = GlanceText(
            glance.Head.StatusText, 11, glance.Head.StatusBrush, FontWeights.SemiBold, new Thickness(10, 1, 0, 0));
        Grid.SetColumn(headStatus, 3);
        bar.Children.Add(headStatus);
        if (_tilesStyleKey is "meter" or "rich")
        {
            var headSpark = BurnSparkline(session.Head.RateSamples, glance.Head.DotBrush);
            headSpark.Margin = new Thickness(12, 0, 0, 0);
            headSpark.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(headSpark, 5);
            bar.Children.Add(headSpark);
        }

        var headMetrics = GlanceText(glance.Head.MetricsText, 10.5, muted, null, new Thickness(12, 1, 0, 0));
        Grid.SetColumn(headMetrics, 6);
        bar.Children.Add(headMetrics);
        var fleetState = GlanceText(
            glance.StateText, 11, glance.StateBrush, FontWeights.SemiBold, new Thickness(14, 1, 0, 0));
        Grid.SetColumn(fleetState, 7);
        bar.Children.Add(fleetState);
        stack.Children.Add(new Border
        {
            Style = (Style)FindResource("Card"),
            Padding = new Thickness(13, 8, 13, 8),
            Margin = new Thickness(0, 0, 0, 8),
            BorderBrush = glance.EdgeBrush,
            BorderThickness = new Thickness(1),
            ToolTip = glance.Tooltip,
            Child = bar
        });

        var wrap = new WrapPanel();
        foreach (var agent in session.Agents.Where(item => item.State != SubagentState.Done))
        {
            wrap.Children.Add(_tilesStyleKey switch
            {
                "meter" => MeterTile(agent, now),
                "mini" => MiniTile(agent, now),
                "rich" => RichTile(agent, now),
                _ => CozyTile(agent, now)
            });
        }

        var finished = session.Agents.Where(agent => agent.State == SubagentState.Done).ToList();
        if (finished.Count > 0)
        {
            var fold = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            fold.Children.Add(GlanceText($"+{finished.Count} finished", 11.5, muted, FontWeights.SemiBold));
            fold.Children.Add(GlanceText(
                $"{FormatCompact(finished.Sum(agent => agent.Tokens.Total))} tok · " +
                FormatMoney(finished.Sum(agent => _pricing.Calculate("anthropic", agent.Model, agent.Tokens).Cost)),
                10, muted, null, new Thickness(0, 3, 0, 0)));
            wrap.Children.Add(new Border
            {
                Width = 130,
                BorderBrush = (Brush)FindResource("RaisedBrush"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(12, 11, 12, 11),
                Margin = new Thickness(0, 0, 10, 10),
                Child = fold
            });
        }

        // The tile wall hangs off the orchestrator bar behind a thin trunk
        // line — the same parent → children shape the list view draws.
        var body = new Grid();
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        if (wrap.Children.Count > 0)
        {
            body.Children.Add(new Border
            {
                Width = 1,
                Background = (Brush)FindResource("RaisedBrush"),
                Margin = new Thickness(10, 0, 13, 10)
            });
        }

        Grid.SetColumn(wrap, 1);
        body.Children.Add(wrap);
        stack.Children.Add(body);
        return stack;
    }

    private Border TileShell(AgentGlance glance, UIElement content, double width, Thickness padding) => new()
    {
        Style = (Style)FindResource("Card"),
        Width = width,
        Padding = padding,
        Margin = new Thickness(0, 0, 10, 10),
        BorderBrush = EdgeBrushFor(glance.DotBrush),
        BorderThickness = new Thickness(1),
        ToolTip = glance.Tooltip,
        Child = content
    };

    private StackPanel TileHead(SubagentActivity agent, AgentGlance glance, double dotSize = 8)
    {
        var muted = (Brush)FindResource("MutedBrush");
        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new Ellipse
        {
            Width = dotSize, Height = dotSize, Fill = glance.DotBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 7, 0)
        });
        head.Children.Add(GlanceText(agent.Depth > 1 ? $"↳ {glance.Badge}" : glance.Badge, 10, muted));
        return head;
    }

    /// <summary>The baseline tile: state, task, tool, cost.</summary>
    private FrameworkElement CozyTile(SubagentActivity agent, DateTimeOffset now)
    {
        var glance = GlanceFor(agent, now);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");
        var tile = new StackPanel();
        tile.Children.Add(TileHead(agent, glance));
        tile.Children.Add(GlanceText(glance.Description, 12, ink, FontWeights.SemiBold, new Thickness(0, 6, 0, 0)));
        tile.Children.Add(GlanceText(
            glance.StatusText, 11, glance.StatusBrush, FontWeights.SemiBold, new Thickness(0, 5, 0, 0)));
        tile.Children.Add(GlanceText(glance.MetricsText, 10.5, muted, null, new Thickness(0, 3, 0, 0)));
        return TileShell(glance, tile, 224, new Thickness(14, 11, 14, 11));
    }

    /// <summary>Cozy plus a burn sparkline and the model — "is it producing?"
    /// answered without reading a number.</summary>
    private FrameworkElement MeterTile(SubagentActivity agent, DateTimeOffset now)
    {
        var glance = GlanceFor(agent, now);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");
        var tile = new StackPanel();

        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(TileHead(agent, glance));
        var model = GlanceText(ShortModel(agent.Model), 9.5, muted);
        Grid.SetColumn(model, 1);
        head.Children.Add(model);
        tile.Children.Add(head);

        tile.Children.Add(GlanceText(glance.Description, 12, ink, FontWeights.SemiBold, new Thickness(0, 6, 0, 0)));
        tile.Children.Add(GlanceText(
            glance.StatusText, 11, glance.StatusBrush, FontWeights.SemiBold, new Thickness(0, 5, 0, 0)));
        var spark = BurnSparkline(agent.RateSamples, glance.DotBrush);
        spark.Margin = new Thickness(0, 7, 0, 0);
        tile.Children.Add(spark);
        tile.Children.Add(GlanceText(glance.MetricsText, 10.5, muted, null, new Thickness(0, 5, 0, 0)));
        return TileShell(glance, tile, 224, new Thickness(14, 11, 14, 11));
    }

    /// <summary>Half-size: task and verb only — the biggest wall of agents that
    /// still reads. Everything else lives in the tooltip.</summary>
    private FrameworkElement MiniTile(SubagentActivity agent, DateTimeOffset now)
    {
        var glance = GlanceFor(agent, now);
        var ink = (Brush)FindResource("InkBrush");
        var tile = new StackPanel();
        var head = new StackPanel { Orientation = Orientation.Horizontal };
        head.Children.Add(new Ellipse
        {
            Width = 7, Height = 7, Fill = glance.DotBrush,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 6, 0)
        });
        head.Children.Add(GlanceText(glance.Description, 11, ink, FontWeights.SemiBold));
        tile.Children.Add(head);
        tile.Children.Add(GlanceText(
            glance.StatusText, 10, glance.StatusBrush, FontWeights.SemiBold, new Thickness(13, 3, 0, 0)));
        return TileShell(glance, tile, 158, new Thickness(11, 8, 11, 8));
    }

    /// <summary>The full briefing: two-line task, model, burn meter, and the
    /// token split — for when the wall is small and attention is high.</summary>
    private FrameworkElement RichTile(SubagentActivity agent, DateTimeOffset now)
    {
        var glance = GlanceFor(agent, now);
        var ink = (Brush)FindResource("InkBrush");
        var muted = (Brush)FindResource("MutedBrush");
        var tile = new StackPanel();

        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(TileHead(agent, glance));
        var model = GlanceText(ShortModel(agent.Model), 9.5, muted);
        Grid.SetColumn(model, 1);
        head.Children.Add(model);
        tile.Children.Add(head);

        var description = GlanceText(glance.Description, 12.5, ink, FontWeights.SemiBold, new Thickness(0, 7, 0, 0));
        description.TextWrapping = TextWrapping.Wrap;
        description.MaxHeight = 38;
        tile.Children.Add(description);

        var statusRow = new Grid { Margin = new Thickness(0, 6, 0, 0) };
        statusRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        statusRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        statusRow.Children.Add(GlanceText(glance.StatusText, 11, glance.StatusBrush, FontWeights.SemiBold));
        var age = GlanceText(
            $"{AgeText((agent.CompletedAt ?? now) - agent.StartedAt)} in", 10, muted);
        Grid.SetColumn(age, 1);
        statusRow.Children.Add(age);
        tile.Children.Add(statusRow);

        var spark = BurnSparkline(agent.RateSamples, glance.DotBrush);
        spark.Margin = new Thickness(0, 7, 0, 0);
        tile.Children.Add(spark);

        var estimate = _pricing.Calculate("anthropic", agent.Model, agent.Tokens);
        tile.Children.Add(GlanceText(
            $"{FormatCompact(agent.Tokens.Total)} tok" +
            (estimate.IsPriced ? $" · {FormatMoney(estimate.Cost)}" : "") +
            $" · {FormatCompact(agent.Tokens.Output)} out · {agent.ToolCalls} tools",
            10.5, muted, null, new Thickness(0, 5, 0, 0)));
        return TileShell(glance, tile, 264, new Thickness(15, 12, 15, 12));
    }

    private sealed record AgentRowVm(
        Thickness Indent,
        Brush DotBrush,
        bool IsRunning,
        string TypeBadge,
        string Description,
        string StatusText,
        Brush StatusBrush,
        string MetricsText,
        string Tooltip);

    private sealed record OrchestratorCardVm(
        string Name,
        string StateText,
        Brush StateBrush,
        Brush DotBrush,
        bool IsRunning,
        Brush EdgeBrush,
        Geometry IconGeometry,
        Brush IconBrush,
        string PathText,
        string SummaryText,
        string HeadStatusText,
        Brush HeadStatusBrush,
        string HeadMetricsText,
        string Tooltip,
        int Pid,
        System.Windows.Input.Cursor Cursor,
        IReadOnlyList<AgentRowVm> Agents);

    /// <summary>One line of truth about how live an account's numbers are —
    /// being signed in no longer hides a feed that can't actually update.</summary>
    private static string AccountStatusText(ClaudeAccountLimits account)
    {
        if (account.Provider == "openai")
        {
            // Codex limits ride its own session logs, so their freshness is
            // simply "when did Codex last answer" — no fetching, no cooldowns.
            return account.IsActive
                ? "Codex is running now"
                : account.FetchedAt is { } snapshot
                    ? $"updates while Codex runs · limits from {FormatResetTime(snapshot.ToLocalTime())}"
                    : "waiting for a Codex session — limits arrive with its first response";
        }

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

            var claudeAccounts = await _limitsService.FetchAllAsync();

            // The ChatGPT account Codex uses, read from its local files — it
            // renders as one more card, after the Claude accounts.
            IReadOnlyList<ClaudeAccountLimits> codexAccounts;
            try
            {
                codexAccounts = await _codexLimitsService.FetchAllAsync();
            }
            catch
            {
                codexAccounts = [];
            }

            var accounts = claudeAccounts.Concat(codexAccounts).ToList();
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
            var planTotal = accounts.Sum(account => PlanMonthlyUsd(account) ?? 0);
            _planMonthlyUsd = planTotal > 0 ? planTotal : null;

            // The compact top bar mirrors whichever account Claude Code is
            // signed into right now; the limits page lists every account.
            var current = claudeAccounts.FirstOrDefault(account => account.IsActive)
                ?? claudeAccounts.FirstOrDefault()
                ?? accounts[0];
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
                if (account.Provider == "openai")
                {
                    // Codex transcripts carry no account identity either, but
                    // only one ChatGPT account signs in at a time — all local
                    // Codex usage is its.
                    var (codexCost, codexTokens) = await _database.GetUsageInSpansAsync(
                        "codex",
                        "openai",
                        [(attributionSinceMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())],
                        _pricing);
                    usageTexts[account.Id] =
                        $"≈ {FormatMoney(codexCost)} · {FormatCompact(codexTokens)} tok of local Codex usage · last 7 days";
                    continue;
                }

                var spans = _limitsService.SignedInSpans(account.Id, attributionSinceMs);
                if (spans.Count == 0)
                {
                    usageTexts[account.Id] = "no local usage attributed yet — starts counting while its sign-ins are observed";
                    continue;
                }

                var (cost, tokens) = await _database.GetUsageInSpansAsync("claude", "anthropic", spans, _pricing);
                usageTexts[account.Id] =
                    $"≈ {FormatMoney(cost)} · {FormatCompact(tokens)} tok of local usage attributed · last 7 days";
            }

            if (_disposed)
            {
                return;
            }

            // A collapsed account that signs in again is back in use — reopen
            // its card on its own. The comparison runs against a persisted id
            // so a switch that happened while the app was closed still counts.
            var activeAccount = accounts.FirstOrDefault(account => account.IsActive);
            if (activeAccount is not null && activeAccount.Id != _settings.LimitsLastActiveAccountId)
            {
                _settings.LimitsLastActiveAccountId = activeAccount.Id;
                _settings.CollapsedClaudeAccounts.Remove(activeAccount.Id);
                _settings.Save();
            }

            _limitsAccounts = accounts;
            _limitsUsageTexts = usageTexts;
            RenderLimitsAccounts();

            // The stamp reflects the data's age, not this render's, so a feed
            // that can't fetch (rate limited, offline) doesn't claim freshness.
            var lastFetch = accounts.Max(account => account.FetchedAt);
            LimitsPageSubtitle.Text =
                $"{accounts.Count} {(accounts.Count == 1 ? "account" : "accounts")} · " +
                (codexAccounts.Count > 0
                    ? "the same numbers Claude Code and Codex show under /usage · "
                    : "the same numbers Claude Code shows under /usage · ") +
                (lastFetch is { } at ? $"updated {at.LocalDateTime:h:mm tt}" : "no successful update yet");
        }
        finally
        {
            _limitsRefreshing = false;
        }
    }

    /// <summary>Draws the per-account cards from the last fetch. A collapsed
    /// card shrinks to its one-line header and sinks below the expanded ones.</summary>
    private void RenderLimitsAccounts()
    {
        var collapsedIds = _settings.CollapsedClaudeAccounts;
        LimitsDetailList.ItemsSource = _limitsAccounts
            .OrderBy(account => collapsedIds.Contains(account.Id) ? 1 : 0)
            .Select(account =>
            {
                var collapsed = collapsedIds.Contains(account.Id);
                return new AccountVm(
                    account.Id,
                    DisplayEmail(account.Email),
                    account.Provider == "openai"
                        ? OpenAiPlanLabel(account.Plan)
                        : PlanLabel(account.Plan, account.RateLimitTier),
                    AccountStatusText(account),
                    account.IsActive ? (Brush)FindResource("AccentBrush") : (Brush)FindResource("MutedBrush"),
                    _limitsUsageTexts.GetValueOrDefault(account.Id, ""),
                    account.Provider == "openai"
                        ? "Estimated at API prices from local Codex logs. Codex transcripts carry no " +
                          "account identity, but only one ChatGPT account signs in at a time — all local " +
                          "Codex usage is attributed here."
                        : "Estimated from local logs: usage that landed while this account was the one " +
                          "signed into Claude Code. Attribution is only as complete as the time the " +
                          "tracker has been running.",
                    collapsed ? "▸" : "▾",
                    collapsed ? Visibility.Collapsed : Visibility.Visible,
                    collapsed ? 0.55 : 1.0,
                    collapsed
                        ? "Click to expand this account again. It also reopens on its own the next time it signs in to Claude Code."
                        : "Click to collapse this account to one line — for accounts you no longer use.",
                    account.Limits.Select(limit =>
                    {
                        // The thin bar under the usage bar: how far through the
                        // limit window we are, i.e. how close the reset is.
                        double resetShare = 0;
                        var resetTooltip = "";
                        if (limit.ResetsAt is { } resetsAt)
                        {
                            var period = LimitPeriod(limit.Label);
                            resetShare = Math.Clamp(
                                1 - (resetsAt - DateTimeOffset.Now).TotalMilliseconds / period.TotalMilliseconds,
                                0,
                                1);
                            resetTooltip = $"{resetShare * 100:0}% of the way through this " +
                                           (period >= TimeSpan.FromDays(7)
                                               ? "week"
                                               : period >= TimeSpan.FromDays(1)
                                                   ? $"{period.TotalDays:0}-day window"
                                                   : $"{period.TotalHours:0}-hour window");
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
                    }).ToList());
            }).ToList();
    }

    /// <summary>Header click on a limits-page account card: collapse it to its
    /// one-line header, or expand it again.</summary>
    private void AccountCardHeader_Click(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not string id || id.Length == 0)
        {
            return;
        }

        if (!_settings.CollapsedClaudeAccounts.Remove(id))
        {
            _settings.CollapsedClaudeAccounts.Add(id);
        }

        _settings.Save();
        RenderLimitsAccounts();
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

            // Only today is read on every pass. This runs on the 60 s limits
            // timer and used to re-read every event of the year each time —
            // measured 2026-09-01: 453k rows, ~300 MB of page reads a minute —
            // for cells that only move when an old transcript is re-parsed.
            // The earlier days are re-read every HeatmapEarlierRefresh, or at
            // once when the window shifts (a new day, a different view).
            var todayStart = new DateTimeOffset(today).ToUnixTimeMilliseconds();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_heatmapEarlier is null || _heatmapEarlierSince != since || _heatmapEarlierUntil != todayStart ||
                nowMs - _heatmapEarlierAtMs >= HeatmapEarlierRefresh.TotalMilliseconds)
            {
                _heatmapEarlier = await _database.GetDailyUsageAsync(since, _pricing, untilMs: todayStart);
                _heatmapEarlierSince = since;
                _heatmapEarlierUntil = todayStart;
                _heatmapEarlierAtMs = nowMs;
            }

            var days = _heatmapEarlier.Concat(await _database.GetDailyUsageAsync(todayStart, _pricing)).ToList();
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

    /// <summary>Vertical gap between two stacked hero meters.</summary>
    private const double HeroLimitGap = 9;

    /// <summary>The column's laid-out width, read once from XAML — the scale
    /// below divides by it, so it must be the pre-scale value.</summary>
    private double? _heroLimitsWidth;

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

            block.Margin = new Thickness(0, isFirstVisible ? 0 : HeroLimitGap, 0, 0);
            isFirstVisible = false;
        }

        var anyVisible = blocks.Any(entry => entry.Show);
        HeroLimits.Visibility = anyVisible ? Visibility.Visible : Visibility.Collapsed;
        HeroLimitsDivider.Visibility = anyVisible ? Visibility.Visible : Visibility.Collapsed;
        FitHeroLimits(blocks.Count(entry => entry.Show));
    }

    /// <summary>
    /// Keeps the hero row the height two meters made it. This column is the
    /// tallest thing in the row, so a third meter would push the chart, the
    /// live feed and everything below it down the page. Instead the column
    /// scales to the two-meter budget: same layout, smaller type. The blocks
    /// are identical, so the natural measurement of three yields the height of
    /// one, and from that the height two would have taken.
    /// </summary>
    private void FitHeroLimits(int visible)
    {
        _heroLimitsWidth ??= HeroLimits.Width;
        var width = _heroLimitsWidth.Value;
        HeroLimits.LayoutTransform = Transform.Identity;
        HeroLimits.Width = width;
        if (visible < 3)
        {
            return;
        }

        HeroLimits.Measure(new Size(width, double.PositiveInfinity));
        var natural = HeroLimits.DesiredSize.Height;
        var block = (natural - (visible - 1) * HeroLimitGap) / visible;
        var budget = 2 * block + HeroLimitGap;
        if (natural <= budget || budget <= 0)
        {
            return;
        }

        // Scaling shrinks the column sideways too, so widen the unscaled
        // content by the same factor to land back on the original width.
        var scale = budget / natural;
        HeroLimits.Width = width / scale;
        HeroLimits.LayoutTransform = new ScaleTransform(scale, scale);
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
        // Codex windows are labeled by length ("3h", "3d"); anything else is a
        // Claude model-scoped weekly row carrying its display name.
        _ when System.Text.RegularExpressions.Regex.IsMatch(label, @"^\d+h$") => $"{label[..^1]}-hour session",
        _ when System.Text.RegularExpressions.Regex.IsMatch(label, @"^\d+d$") => $"{label[..^1]}-day window",
        _ => $"Weekly · {label}"
    };

    /// <summary>How long the window behind a limit row runs — drives the thin
    /// "how close is the reset" bar.</summary>
    private static TimeSpan LimitPeriod(string label) =>
        label.Length > 1 && label[^1] == 'h' && int.TryParse(label[..^1], out var hours) ? TimeSpan.FromHours(hours)
        : label.Length > 1 && label[^1] == 'd' && int.TryParse(label[..^1], out var days) ? TimeSpan.FromDays(days)
        : TimeSpan.FromDays(7);

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

    /// <summary>"ChatGPT Plus · $20/mo" — the Codex account's plan line. The
    /// same plan words mean different prices at OpenAI ("pro" is $200 there),
    /// so ChatGPT plans get their own table.</summary>
    private static string OpenAiPlanLabel(string? plan) => plan switch
    {
        "plus" => "ChatGPT Plus · $20/mo",
        "pro" => "ChatGPT Pro · $200/mo",
        "team" => "ChatGPT Team",
        "enterprise" => "ChatGPT Enterprise",
        "free" or null or "" => "ChatGPT",
        _ => $"ChatGPT {char.ToUpperInvariant(plan[0])}{plan[1..]}"
    };

    /// <summary>What the account's plan bills per month, when the tier makes it knowable.</summary>
    private static double? PlanMonthlyUsd(ClaudeAccountLimits account) => account.Provider == "openai"
        ? account.Plan switch
        {
            "plus" => 20,
            "pro" => 200,
            _ => null
        }
        : account.Plan switch
        {
            "pro" => 20,
            "max" when account.RateLimitTier?.EndsWith("_5x", StringComparison.Ordinal) == true => 100,
            "max" when account.RateLimitTier?.EndsWith("_20x", StringComparison.Ordinal) == true => 200,
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

    private void CaptureCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        _settings.CaptureRequestsEnabled = CaptureCheckBox.IsChecked == true;
        _settings.Save();
        if (_settings.CaptureRequestsEnabled)
        {
            StartRequestCapture();
        }
        else
        {
            _captureProxy.Stop();
            RequestCaptureProxy.ClearEnvironment();
            _captureEnvConflict = null;
        }

        UpdateCaptureStatusText();
    }

    /// <summary>Starts the relay, then routes new sessions through it — but only
    /// when the env var isn't already claimed by something else, and never while
    /// the relay failed to bind (a dead base URL would break Claude Code).</summary>
    private void StartRequestCapture()
    {
        if (_captureProxy.Start(_settings.CaptureProxyPort))
        {
            _captureEnvConflict = RequestCaptureProxy.SetEnvironment(_captureProxy.Port);
            return;
        }

        // A previous run that was killed can leave the variable behind; with no
        // relay to answer it, clear it rather than leave Claude Code pointed at
        // nothing.
        _captureEnvConflict = null;
        RequestCaptureProxy.ClearEnvironment();
    }

    private void UpdateCaptureStatusText()
    {
        CaptureStatusText.Text = !_captureProxy.IsRunning
            ? _captureProxy.Error is { } error && _settings.CaptureRequestsEnabled
                ? $"Capture off: {error}"
                : "Off — transcripts show only what Claude Code writes to disk (no system prompt)."
            : _captureEnvConflict is { } existing
                ? $"Relay running, but ANTHROPIC_BASE_URL is already \"{existing}\" — left untouched, so nothing routes through it."
                : $"Relaying api.anthropic.com via localhost:{_captureProxy.Port}. Sessions started from now on get " +
                  "their system prompt and tool schemas shown in the transcript viewer; restart open ones to include them.";
    }

    private void CodexTraceCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        if (!_loaded)
        {
            return;
        }

        _settings.CodexTraceEnabled = CodexTraceCheckBox.IsChecked == true;
        _settings.Save();
        if (_settings.CodexTraceEnabled)
        {
            _codexTraceConflict = CodexTraces.SetEnvironment();
        }
        else
        {
            CodexTraces.ClearEnvironment();
            _codexTraceConflict = null;
        }

        UpdateCodexTraceStatusText();
    }

    private void UpdateCodexTraceStatusText()
    {
        CodexTraceStatusText.Text = !_settings.CodexTraceEnabled
            ? "Off — Codex runs that save no session log (codex exec --ephemeral) aren't counted."
            : _codexTraceConflict is { } existing
                ? $"{CodexTraces.EnvName} is already \"{existing}\" — left untouched, so runs that save no session log aren't counted."
                : "Codex processes started from now on write a usage trace, so runs that save no session log are " +
                  "counted too. Restart open terminals and apps to include theirs.";
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
        string Id,
        string Email,
        string PlanText,
        string StatusText,
        Brush StatusBrush,
        string UsageText,
        string UsageTip,
        string Chevron,
        Visibility DetailsVisibility,
        double CardOpacity,
        string ToggleTip,
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
            _openCodeService.Start();
            await RefreshDashboardAsync();

            // Both live views start with the app, whatever tab or mode is
            // showing, so nothing ever resets on a view switch.
            StartCupRound();
            await RebuildCupLayersAsync();
            _liveStarted = true;
            _liveTimer.Start();
            _ = RefreshLimitsAsync();
            _ = RefreshTerminalsAsync();
            if (_tabKey == "agents")
            {
                _ = RefreshAgentsAsync();
            }

            if (_tabKey == "insights")
            {
                _ = RefreshInsightsAsync();
            }

            GpuCreditExpiryBox.Text = _settings.AwsCreditExpiry;
            if (_tabKey == "gpu")
            {
                _ = RefreshGpuAsync();
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

    // ── GPU view ───────────────────────────────────────────────────────────

    private sealed record GpuRowVm(
        string Title,
        string StateText,
        Brush StateBrush,
        Brush StateTextBrush,
        string DetailText,
        string Tooltip,
        string RateText,
        Brush RateBrush,
        string RunCostText);

    private void GpuRefreshButton_Click(object sender, RoutedEventArgs e) => _ = RefreshGpuAsync();

    private async Task RefreshGpuAsync()
    {
        if (_gpuScanning)
        {
            return;
        }

        _gpuScanning = true;
        GpuRefreshButton.IsEnabled = false;
        GpuStatusText.Visibility = Visibility.Visible;
        GpuStatusText.Text = "Asking AWS…";
        try
        {
            var creditsTask = RefreshGpuCreditsAsync(force: false);
            var result = await _gpuService.ScanAsync();
            await creditsTask;
            if (_disposed)
            {
                return;
            }

            if (result.Error is not null)
            {
                GpuError.Text = result.Error;
                GpuError.Visibility = Visibility.Visible;
                GpuEmpty.Visibility = Visibility.Collapsed;
                GpuPanel.ItemsSource = null;
                GpuStatusText.Text = $"checked {result.ScannedAt.ToLocalTime():h:mm:ss tt}";
                return;
            }

            GpuError.Visibility = Visibility.Collapsed;
            GpuEmpty.Visibility = result.Instances.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            GpuPanel.ItemsSource = result.Instances.Select(BuildGpuRow).ToList();

            var running = result.Instances.Where(i => i.State == "running").ToList();
            var knownRate = running.Where(i => i.HourlyUsd is not null).Sum(i => i.HourlyUsd!.Value);
            var rateText = running.Count == 0 ? ""
                : running.Any(i => i.HourlyUsd is null) ? $" · ≥ ${knownRate:0.00}/hr"
                : $" · ${knownRate:0.00}/hr";
            var account = result.AccountId is null ? ""
                : HidePersonal ? " · account ••••"
                : $" · account {result.AccountId}";
            var region = result.Region is null ? "" : $" · {result.Region}";
            GpuStatusText.Text =
                $"{running.Count} running · {result.Instances.Count} total{rateText}{account}{region}" +
                $" · checked {result.ScannedAt.ToLocalTime():h:mm:ss tt}";
        }
        finally
        {
            _gpuScanning = false;
            GpuRefreshButton.IsEnabled = true;
        }
    }

    /// <summary>Renders the credits card, asking Cost Explorer only when the
    /// cached answer is stale (each question costs $0.01) or a new baseline
    /// was just saved.</summary>
    private async Task RefreshGpuCreditsAsync(bool force)
    {
        if (_gpuCreditsFetching)
        {
            return;
        }

        var checkedAt = DateTimeOffset.FromUnixTimeMilliseconds(_settings.AwsCreditsCheckedMs);
        var stale = DateTimeOffset.UtcNow - checkedAt > TimeSpan.FromHours(6);
        if (stale || force)
        {
            _gpuCreditsFetching = true;
            try
            {
                DateOnly? baselineDay = DateOnly.TryParse(_settings.AwsCreditBaselineDate, out var day)
                    ? day
                    : null;
                var credits = await _gpuService.GetCreditsAppliedAsync(baselineDay);
                if (_disposed)
                {
                    return;
                }

                if (credits.Error is not null)
                {
                    GpuCreditsMain.Text = "—";
                    GpuCreditsSub.Text = credits.Error;
                    return;
                }

                _settings.AwsCreditsSinceBaselineUsd = credits.AppliedSinceStart;
                _settings.AwsCreditsMonthUsd = credits.AppliedThisMonth;
                _settings.AwsCreditsSinceTokensUsd = credits.SinceTokensUsd;
                _settings.AwsCreditsSinceGpuUsd = credits.SinceGpuUsd;
                _settings.AwsCreditsMonthTokensUsd = credits.MonthTokensUsd;
                _settings.AwsCreditsMonthGpuUsd = credits.MonthGpuUsd;
                _settings.AwsCreditsCheckedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                _settings.Save();
            }
            finally
            {
                _gpuCreditsFetching = false;
            }
        }

        RenderGpuCredits();
    }

    private void RenderGpuCredits()
    {
        if (_settings.AwsCreditsCheckedMs == 0)
        {
            GpuCreditsMain.Text = "—";
            GpuCreditsSub.Text = "Waiting for the first Cost Explorer answer.";
            return;
        }

        var parts = new List<string>();
        if (_settings.AwsCreditBaselineDate.Length > 0)
        {
            var remaining = Math.Max(0, _settings.AwsCreditBaselineUsd - _settings.AwsCreditsSinceBaselineUsd);
            GpuCreditsMain.Text = $"≈ ${remaining:#,##0.00} remaining";
            if (DateOnly.TryParse(_settings.AwsCreditExpiry, out var expiry))
            {
                var daysLeft = expiry.DayNumber - DateOnly.FromDateTime(DateTime.Today).DayNumber;
                parts.Add(daysLeft < 0
                    ? $"expired {expiry:MMM d, yyyy}"
                    : $"expires {expiry:MMM d, yyyy} · {daysLeft} d left");
            }
        }
        else
        {
            GpuCreditsMain.Text = $"${_settings.AwsCreditsMonthUsd:#,##0.00} applied this month";
            parts.Add("AWS keeps a promo credit's remaining balance console-only — copy it from Billing → Credits once and this card counts down from there");
        }

        if (_settings.AwsCreditBaselineDate.Length > 0)
        {
            parts.Add($"${_settings.AwsCreditsMonthUsd:#,##0.00} applied this month");
        }

        // Both tokens (Bedrock) and GPUs (EC2) drain the same credit pot, so
        // say which one is doing the draining. Baseline set → split the
        // countdown's burn; otherwise split this month's figure.
        var split = _settings.AwsCreditBaselineDate.Length > 0
            ? CreditSplit(_settings.AwsCreditsSinceBaselineUsd,
                _settings.AwsCreditsSinceTokensUsd, _settings.AwsCreditsSinceGpuUsd)
            : CreditSplit(_settings.AwsCreditsMonthUsd,
                _settings.AwsCreditsMonthTokensUsd, _settings.AwsCreditsMonthGpuUsd);
        if (split is not null)
        {
            parts.Add(split);
        }

        var checkedAt = DateTimeOffset.FromUnixTimeMilliseconds(_settings.AwsCreditsCheckedMs).ToLocalTime();
        parts.Add($"checked {checkedAt:MMM d, h:mm tt}");
        GpuCreditsSub.Text = string.Join(" · ", parts);
    }

    /// <summary>"$12.34 tokens + $5.67 GPUs + $0.10 other", or null while the
    /// burn is still zero. "Other" is whatever credit application the two
    /// tracked services don't explain (S3, data transfer, …).</summary>
    private static string? CreditSplit(double total, double tokens, double gpu)
    {
        if (tokens < 0.005 && gpu < 0.005)
        {
            return null;
        }

        var bits = new List<string>();
        if (tokens >= 0.005)
        {
            bits.Add($"${tokens:#,##0.00} tokens");
        }

        if (gpu >= 0.005)
        {
            bits.Add($"${gpu:#,##0.00} GPUs");
        }

        var other = total - tokens - gpu;
        if (other >= 0.005)
        {
            bits.Add($"${other:#,##0.00} other");
        }

        return string.Join(" + ", bits);
    }

    private void GpuCreditSave_Click(object sender, RoutedEventArgs e)
    {
        var balanceText = GpuCreditBalanceBox.Text.Trim().TrimStart('$').Replace(",", "");
        if (!double.TryParse(balanceText, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var balance) || balance < 0)
        {
            GpuCreditsSub.Text = "The balance needs to be a plain number, e.g. 1234.56";
            return;
        }

        var expiryText = GpuCreditExpiryBox.Text.Trim();
        if (expiryText.Length > 0 && !DateOnly.TryParse(expiryText, out _))
        {
            GpuCreditsSub.Text = "The expiry date needs to look like 2027-01-31 (or be left empty).";
            return;
        }

        _settings.AwsCreditBaselineUsd = balance;
        _settings.AwsCreditBaselineDate = DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd");
        _settings.AwsCreditExpiry = expiryText;
        _settings.AwsCreditsSinceBaselineUsd = 0;
        _settings.AwsCreditsSinceTokensUsd = 0;
        _settings.AwsCreditsSinceGpuUsd = 0;
        _settings.AwsCreditsCheckedMs = 0;
        _settings.Save();
        GpuCreditBalanceBox.Text = "";
        _ = RefreshGpuCreditsAsync(force: true);
    }

    private GpuRowVm BuildGpuRow(GpuInstanceInfo info)
    {
        var running = info.State == "running";
        var transitional = info.State is "pending" or "stopping" or "shutting-down";
        var stateBrush = running ? (Brush)FindResource("Series2Brush")
            : transitional ? (Brush)FindResource("Series3Brush")
            : (Brush)FindResource("MutedBrush");
        var uptime = running && info.LaunchTime is not null
            ? DateTimeOffset.UtcNow - info.LaunchTime.Value
            : (TimeSpan?)null;
        var detailParts = new List<string> { info.InstanceType, info.GpuModel };
        if (info.AvailabilityZone.Length > 0)
        {
            detailParts.Add(info.AvailabilityZone);
        }

        if (uptime is not null)
        {
            detailParts.Add("up " + UptimeText(uptime.Value));
        }

        if (info.Name.Length > 0 && info.InstanceId.Length > 0)
        {
            detailParts.Add(info.InstanceId);
        }

        var runCost = running && uptime is not null && info.HourlyUsd is not null
            ? $"≈ ${info.HourlyUsd.Value * uptime.Value.TotalHours:0.00} this run"
            : running && info.HourlyUsd is null ? "rate unknown"
            : "";
        return new GpuRowVm(
            info.Name.Length > 0 ? info.Name : info.InstanceId,
            info.State,
            stateBrush,
            running ? (Brush)FindResource("Series2Brush") : (Brush)FindResource("MutedBrush"),
            string.Join(" · ", detailParts),
            $"{info.InstanceId} · {info.InstanceType} · {info.GpuModel}" +
                (info.LaunchTime is null ? "" : $"\nlaunched {info.LaunchTime.Value.ToLocalTime():MMM d, h:mm tt}") +
                "\n'This run' counts from the instance's last start — AWS resets the launch time on stop/start.",
            running && info.HourlyUsd is not null ? $"${info.HourlyUsd.Value:0.00}/hr" : "",
            (Brush)FindResource("InkBrush"),
            runCost);
    }

    private static string UptimeText(TimeSpan span) =>
        span.TotalDays >= 1 ? $"{(int)span.TotalDays}d {span.Hours}h"
        : span.TotalHours >= 1 ? $"{(int)span.TotalHours}h {span.Minutes}m"
        : $"{Math.Max(1, (int)span.TotalMinutes)}m";

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
        var agents = _tabKey == "agents";
        var insights = _tabKey == "insights";
        var gpu = _tabKey == "gpu";
        var dashboard = !live && !limits && !terminals && !agents && !insights && !gpu;
        var livePanel = dashboard && _dashPanelKey == "live";
        DashboardHero.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        DashboardContent.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        RangeGroupBorder.Visibility = dashboard ? Visibility.Visible : Visibility.Collapsed;
        LiveRoot.Visibility = live ? Visibility.Visible : Visibility.Collapsed;
        LimitsRoot.Visibility = limits ? Visibility.Visible : Visibility.Collapsed;
        TerminalsRoot.Visibility = terminals ? Visibility.Visible : Visibility.Collapsed;
        AgentsRoot.Visibility = agents ? Visibility.Visible : Visibility.Collapsed;
        InsightsRoot.Visibility = insights ? Visibility.Visible : Visibility.Collapsed;
        GpuRoot.Visibility = gpu ? Visibility.Visible : Visibility.Collapsed;
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

        if (agents && _loaded)
        {
            _ = RefreshAgentsAsync();
        }

        if (insights && _loaded)
        {
            _ = RefreshInsightsAsync();
        }

        if (gpu && _loaded)
        {
            // The call is free (describe-instances), so opening the page is
            // itself the button press; the Refresh button covers re-checks.
            _ = RefreshGpuAsync();
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
            StopLiveFrames();
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
        ResetEndlessTrim();
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
                    (row.TimestampMs < _roundStartMs - 60_000 ||
                     IsEndless && row.TimestampMs <= _endlessTrimmedThroughMs))
                {
                    continue;
                }

                UpsertCupBubble(row);
            }

            if (rows.Count > 0)
            {
                TrimEndlessPile();
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

    /// <summary>Keeps an endless pile within the block budget: the oldest
    /// blocks leave the canvas, their totals stay in the stacked counters.</summary>
    private void TrimEndlessPile()
    {
        if (!IsEndless)
        {
            return;
        }

        var active = _cupBubbles.Values.Where(bubble => !bubble.Frozen).ToList();
        if (active.Count <= MaxCupBlocks)
        {
            return;
        }

        foreach (var bubble in active
                     .OrderBy(bubble => bubble.FirstSeenMs)
                     .Take(active.Count - (MaxCupBlocks - EndlessTrimBatch)))
        {
            _endlessTrimmedCost += bubble.Cost;
            _endlessTrimmedTokens += bubble.Event.Tokens.Total;
            _endlessTrimmedMessages += bubble.Event.Messages;
            _endlessTrimmedCount++;
            _endlessTrimmedThroughMs = Math.Max(_endlessTrimmedThroughMs, bubble.FirstSeenMs);
            LiveCanvas.Children.Remove(bubble.Visual);
            _cupBubbles.Remove(bubble.Event.EventKey);
        }

        _cupLayoutDirty = true;
    }

    private void AssignLiveModelSlot(string model)
    {
        if (!_modelSlots.ContainsKey(model))
        {
            _modelSlots[model] = _modelSlots.Count;
        }
    }

    private static SolidColorBrush LiveStrokeBrush()
    {
        var stroke = new SolidColorBrush(Color.FromArgb(70, 255, 255, 255));
        stroke.Freeze();
        return stroke;
    }

    private FrameworkElement CreateCupVisual(LiveBubble bubble)
    {
        var row = bubble.Event;
        // The exact brush the chart uses — no opacity, so the two always match.
        var fill = BrushForModel(row.Model);
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
            ToolTip = BuildLiveTooltip(row),
            Cursor = Cursors.Hand
        };
        ToolTipService.SetInitialShowDelay(visual, 150);
        ToolTipService.SetShowDuration(visual, 60000);

        // The session's name, its terminal and its prompts all land after the
        // block does — and the block keeps growing while output streams — so
        // rebuild the text on every hover instead of freezing it at spawn.
        visual.ToolTipOpening += (_, _) => visual.ToolTip = BuildLiveTooltip(bubble.Event);

        // Double-click opens the log this block was parsed out of, at this
        // response: the block says how much it cost, the transcript says why.
        visual.MouseLeftButtonDown += async (_, args) =>
        {
            if (args.ClickCount == 2)
            {
                args.Handled = true;
                await OpenTranscriptAsync(bubble.Event);
            }
        };
        return visual;
    }

    /// <summary>Opens the transcript window for one live block. Everything the
    /// index keeps is a token count; the conversation is re-read from the log
    /// file the event came from.</summary>
    private async Task OpenTranscriptAsync(LiveEventRow row)
    {
        try
        {
            Mouse.OverrideCursor = Cursors.Wait;
            var source = await _database.GetEventSourceAsync(row.EventKey);
            if (source is not { } found)
            {
                System.Windows.MessageBox.Show(this,
                    "That block is no longer in the index, so its log can't be located.",
                    "Transcript", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            var readPath = found.SourcePath;
            var recovered = false;
            if (!File.Exists(found.SourcePath))
            {
                // Bot session forks and rewinds are deleted seconds after they
                // are written; the vault kept a copy of anything indexed young.
                var copy = await _vault.MaterializeAsync(found.SourcePath);
                if (copy is null)
                {
                    System.Windows.MessageBox.Show(this,
                        $"The log this block came from is gone, and no copy was kept:\n{DisplayLocalPath(found.SourcePath)}",
                        "Transcript", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }

                readPath = copy;
                recovered = true;
            }

            var document = await TranscriptReader.ReadAsync(
                readPath, found.Client, row.TimestampMs);
            var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
            var time = DateTimeOffset.FromUnixTimeMilliseconds(row.TimestampMs).ToLocalTime();
            var context = new TranscriptContext(
                ContextSessionName(row),
                $"{row.Model} · {row.Client} · {time:h:mm:ss tt} · " +
                $"{FormatCompact(row.Tokens.Total)} tokens · " +
                (estimate.IsPriced ? estimate.Cost.ToString("C4", Usd) : "no pricing match"),
                recovered
                    ? $"{DisplayLocalPath(found.SourcePath)} · the original was deleted; this is the tracker's copy"
                    : DisplayLocalPath(found.SourcePath));

            new TranscriptWindow(document, context, HidePersonal) { Owner = this }.Show();
        }
        catch (Exception exception)
        {
            System.Windows.MessageBox.Show(this, "That log could not be opened: " + exception.Message,
                "Transcript", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            Mouse.OverrideCursor = null;
        }
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

        // The round's totals start from whatever an endless pile trimmed away.
        double costWindow = _endlessTrimmedCost, cost60 = 0, cost5m = 0;
        long tokensWindow = _endlessTrimmedTokens, tokens60 = 0, tokens5m = 0;
        var messagesWindow = _endlessTrimmedMessages;
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

    /// <summary>Which project a live session belongs to. While a terminal is
    /// open, lead with the working-directory name so usage from a newly opened
    /// project is recognizable on the dashboard. Once it closes, the remembered
    /// first prompt is the best available label; the tooltip still carries both.</summary>
    private string ContextSessionName(LiveEventRow row)
    {
        if (_terminalsBySession.TryGetValue(row.SessionId, out var terminal))
        {
            var folderName = Path.GetFileName(terminal.ProjectPath.TrimEnd('\\', '/'));
            return DisplayProject(string.IsNullOrWhiteSpace(folderName) ? terminal.ProjectName : folderName);
        }

        if (SessionTopic(row.SessionId) is { } topic)
        {
            return $"“{topic}”";
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
        var cost = active.Sum(bubble => bubble.Cost) + _endlessTrimmedCost;
        var tokens = active.Sum(bubble => bubble.Event.Tokens.Total) + _endlessTrimmedTokens;
        ResetEndlessTrim();
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

            // Keep the sediment bounded, in layers and in blocks.
            while (_cupLayers.Count > 20 || _cupLayers.Count > 1 && _cupBubbles.Count > MaxCupBlocks)
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

    private void ResetEndlessTrim()
    {
        _endlessTrimmedCost = 0;
        _endlessTrimmedTokens = 0;
        _endlessTrimmedMessages = 0;
        _endlessTrimmedCount = 0;
        _endlessTrimmedThroughMs = long.MinValue;
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

            // Past the block budget, older rounds still score in the history
            // bars but get no blocks on the canvas.
            var drawBlocks = _cupBubbles.Count < MaxCupBlocks;
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
                cost += estimate.Cost;
                tokens += row.Tokens.Total;
                if (!drawBlocks)
                {
                    continue;
                }

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
            var stacked = _cupBubbles.Values.Count(bubble => !bubble.Frozen) + _endlessTrimmedCount;
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

    /// <summary>Distance at which the easing is done as far as the eye is
    /// concerned; the block snaps to target and stops being animated.</summary>
    private const double CupSettleEpsilon = 0.5;

    private void AdvanceCup(long nowMs, double width, double viewportHeight, double dt)
    {
        if (_cupLayoutDirty)
        {
            LayoutCup(width, viewportHeight);
            _cupLayoutDirty = false;
        }

        // Frame-rate independent easing: the same settle speed at 30 or 120 fps.
        var ease = 1 - Math.Exp(-9 * dt);
        var moving = 0;
        foreach (var bubble in _cupBubbles.Values)
        {
            if (bubble.Settled || bubble.Side <= 0)
            {
                // Settled blocks are already on target — most of a deep pile is
                // frozen sediment far below the rim — and a block without a
                // layout pass has no target to move toward yet.
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
            if (Math.Abs(bubble.TargetX - bubble.CurrentX) < CupSettleEpsilon &&
                Math.Abs(bubble.TargetY - bubble.CurrentY) < CupSettleEpsilon)
            {
                // Within half a pixel: snap exactly once, then leave it alone.
                bubble.CurrentX = bubble.TargetX;
                bubble.CurrentY = bubble.TargetY;
                bubble.Settled = true;
            }
            else
            {
                moving++;
            }

            bubble.Visual.Width = bubble.Side;
            bubble.Visual.Height = bubble.Side;
            Canvas.SetLeft(bubble.Visual, bubble.CurrentX);
            Canvas.SetTop(bubble.Visual, bubble.CurrentY);
        }

        if (moving == 0)
        {
            // A still cup costs nothing: drop off the render loop until
            // _cupLayoutDirty (or a tab switch) wakes it again.
            StopLiveFrames();
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
        var maxSide = Math.Max(24, width - 2 * wallInset);
        foreach (var bubble in blocks)
        {
            var side = Math.Clamp(CupSide(bubble) * scale, 6, maxSide);
            if (x + side > width - wallInset && x > wallInset)
            {
                rowBase += rowHeight + gap;
                x = wallInset;
                rowHeight = 0;
            }

            var targetY = floorY - rowBase - side;
            if (bubble.Side != side || bubble.TargetX != x || bubble.TargetY != targetY)
            {
                // Moved, resized or re-floored: it has to animate again.
                bubble.Settled = false;
            }

            bubble.Side = side;
            bubble.TargetX = x;
            bubble.TargetY = targetY;
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
        var maxSide = Math.Max(24, width - 2 * wallInset);
        foreach (var bubble in ordered)
        {
            var side = Math.Clamp(CupSide(bubble) * scale, 6, maxSide);
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

    /// <summary>Block area tracks the selected metric; unpriced costs fall back
    /// to tokens. The cap sits near $14 / 14M tokens — high enough that a $9
    /// reply reads clearly bigger than a $2 one (the old 118 cap was hit at
    /// ~$1.30). Scale-to-fit and the packers' width clamp keep big blocks in
    /// the cup.</summary>
    private double CupSide(LiveBubble bubble)
    {
        var sqrt = LiveMetricSqrt(bubble);
        return Math.Clamp(14 + 92 * sqrt, 14, 360);
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
               $"Session {row.SessionId}\n\n" +
               "Double-click to read this response in its transcript.";
    }

    private RadioButton TabRadioFor(string key) => key switch
    {
        "live" => TabLive,
        "limits" => TabLimits,
        "terminals" => TabTerminals,
        "agents" => TabAgents,
        "insights" => TabInsights,
        "gpu" => TabGpu,
        _ => TabDashboard
    };

    private static string NormalizeTabKey(string key) =>
        key is "live" or "limits" or "terminals" or "agents" or "insights" or "gpu" ? key : "dashboard";

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

    /// <summary>Dragging a window edge raises this per mouse move, and a redraw
    /// is every element on the canvas rebuilt — so a resize draws once it
    /// settles. An empty canvas (first layout, or a size too small to plot)
    /// still draws straight away, so the chart never waits to appear.</summary>
    private void ChartCanvas_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_latestData is null)
        {
            return;
        }

        if (_chartDrawnSignature is null)
        {
            DrawChart();
            return;
        }

        if (_chartResizeTimer is null)
        {
            _chartResizeTimer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromMilliseconds(180)
            };
            _chartResizeTimer.Tick += (_, _) =>
            {
                _chartResizeTimer!.Stop();
                DrawChart();
            };
        }

        _chartResizeTimer.Stop();
        _chartResizeTimer.Start();
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
        StatusText.Text = _settings.ManualSessionStartMs is null
            ? $"A session now ends after {selected.Label.ToLowerInvariant()}"
            : $"A session now ends after {selected.Label.ToLowerInvariant()} — but the current start is pinned by you";
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
                (long)(_settings.SessionGapHours * 3_600_000),
                _settings.ManualSessionStartMs);
            _latestData = data;

            // A session's length only becomes known once the data is in; the
            // offered bar sizes follow it (a 9-hour session outgrows 15 s bars),
            // and it is worth saying out loud under the cost — a $9 session
            // reads very differently at twenty minutes than at nine hours.
            if (_rangeKey == "session")
            {
                var span = data.RangeStartMs is { } sessionStart
                    ? Math.Max(0, DateTimeOffset.Now.ToUnixTimeMilliseconds() - sessionStart)
                    : (long?)null;
                if (span != _sessionSpanMs)
                {
                    _sessionSpanMs = span;
                    UpdateBarsAvailability();
                }
            }

            UpdateSessionLength(data);
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
                TopReplyDetailText.Text = $"{ContextSessionName(priciest)} · {at:h:mm tt}";
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

    /// <summary>The line under the hero cost saying how long the current work
    /// session has run — shown only on the Session range, where the range has
    /// a length of its own. It runs from the session's start (pinned, or the
    /// first event after the last break) to now, so a quiet stretch shorter
    /// than the session break still counts. The "since …" half is the button
    /// that opens the pin popup.</summary>
    private void UpdateSessionLength(DashboardData data)
    {
        if (_rangeKey != "session" || data.RangeStartMs is not { } startMs)
        {
            SessionLengthPanel.Visibility = Visibility.Collapsed;
            return;
        }

        var pinned = _settings.ManualSessionStartMs is not null;
        var start = DateTimeOffset.FromUnixTimeMilliseconds(startMs).ToLocalTime();
        var elapsed = TimeSpan.FromMilliseconds(
            Math.Max(0, DateTimeOffset.Now.ToUnixTimeMilliseconds() - startMs));

        // Name the day once the start slips out of today, so a forgotten pin
        // from yesterday cannot masquerade as this morning's.
        var day = start.Date == DateTimeOffset.Now.Date ? "" : $"{start:ddd} ";
        SessionLengthText.Text = FormatSessionLength(elapsed);
        SessionLengthText.ToolTip =
            $"This work session started at {start:h:mm tt} on {start:ddd d MMM} and " +
            $"has run {FormatSessionLength(elapsed)} so far. " +
            (pinned
                ? "The start is pinned by you; click the 'since' button to move it or go back to automatic."
                : $"It ends after {_settings.SessionGapHours:0.##} h of quiet (Settings → Session break).");
        SessionStartToggle.Content = pinned
            ? $"since {day}{start:h:mm tt} · pinned"
            : $"since {day}{start:h:mm tt}";
        SessionLengthPanel.Visibility = Visibility.Visible;
    }

    /// <summary>Prefill the pin popup with the session's current start so
    /// "pin it right here" is a two-keystroke edit, not a blank form.</summary>
    private void SessionStartToggle_Checked(object sender, RoutedEventArgs e)
    {
        var startMs = _settings.ManualSessionStartMs ?? _latestData?.RangeStartMs;
        SessionStartTimeBox.Text = startMs is { } ms
            ? DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("h:mm tt")
            : "";
        SessionStartHint.Visibility = Visibility.Collapsed;
        SessionStartAutoButton.IsEnabled = _settings.ManualSessionStartMs is not null;
        SessionStartTimeBox.Focus();
        SessionStartTimeBox.SelectAll();
    }

    private void SessionStartTimeBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            SessionStartPin_Click(sender, e);
        }
    }

    /// <summary>Time-of-day formats the pin box accepts: "10", "10:00",
    /// "10:00 am", "6 pm", "22:15". Exact formats rather than a permissive
    /// DateTime.Parse so "10" can never be read as the 10th of the month.</summary>
    private static readonly string[] SessionStartFormats =
    [
        "h:mm tt", "h:mmtt", "h tt", "htt", "H:mm", "HH:mm", "%H"
    ];

    private void SessionStartPin_Click(object sender, RoutedEventArgs e)
    {
        var text = SessionStartTimeBox.Text.Trim();
        if (!DateTime.TryParseExact(text, SessionStartFormats, CultureInfo.CurrentCulture,
                DateTimeStyles.None, out var parsed) &&
            !DateTime.TryParseExact(text, SessionStartFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out parsed))
        {
            SessionStartHint.Text = "Could not read that as a time — try 10:00, 6:30 pm, or 22:15.";
            SessionStartHint.Visibility = Visibility.Visible;
            return;
        }

        // The chosen clock time means "the most recent time it was that time":
        // today, or yesterday when it has not come around yet today.
        var now = DateTimeOffset.Now;
        var start = new DateTimeOffset(now.Date + parsed.TimeOfDay, now.Offset);
        if (start > now)
        {
            start = start.AddDays(-1);
        }

        _settings.ManualSessionStartMs = start.ToUnixTimeMilliseconds();
        _settings.Save();
        SessionStartToggle.IsChecked = false;
        StatusText.Text = $"Session pinned to start at {start:h:mm tt}";
        _ = RefreshDashboardAsync();
    }

    private void SessionStartAuto_Click(object sender, RoutedEventArgs e)
    {
        _settings.ManualSessionStartMs = null;
        _settings.Save();
        SessionStartToggle.IsChecked = false;
        StatusText.Text = "Session start is automatic again (last long quiet stretch)";
        _ = RefreshDashboardAsync();
    }

    /// <summary>"5:25 (5h 25m)" — the clock reading first, then the same span
    /// spelled out so nobody reads 5:25 as five minutes.</summary>
    private static string FormatSessionLength(TimeSpan elapsed)
    {
        var hours = (int)elapsed.TotalHours;
        var minutes = elapsed.Minutes;
        var spelled = hours > 0 ? $"{hours}h {minutes}m" : $"{minutes}m";
        return $"{hours}:{minutes:00} ({spelled})";
    }

    // ── Model breakdown ────────────────────────────────────────────────────

    private void AssignModelSlots(DashboardData data)
    {
        // Models arrive sorted by cost, so the biggest spenders claim low slots first.
        foreach (var model in data.Models.Select(row => row.Model))
        {
            if (!_modelSlots.ContainsKey(model))
            {
                _modelSlots[model] = _modelSlots.Count;
            }
        }
    }

    private Brush BrushForModel(string model) =>
        string.IsNullOrEmpty(model) ? _otherBrush : BrushForHex(ColorHexForModel(model));

    private Brush BrushForHex(string hex)
    {
        if (!_brushByHex.TryGetValue(hex, out var brush))
        {
            brush = new SolidColorBrush(TryParseHex(hex, out var color) ? color : Colors.Gray);
            brush.Freeze();
            _brushByHex[hex] = brush;
        }

        return brush;
    }

    /// <summary>The model's persisted color, assigning and saving one on first sight.</summary>
    private string ColorHexForModel(string model)
    {
        if (_settings.ModelColors.TryGetValue(model, out var hex) && TryParseHex(hex, out _))
        {
            return hex;
        }

        hex = DefaultHexForModel(model);
        _settings.ModelColors[model] = hex;
        _settings.Save();
        return hex;
    }

    private string DefaultHexForModel(string model)
    {
        var used = _settings.ModelColors.Values.ToList();
        foreach (var (token, hex) in FamilySeeds)
        {
            if (model.Contains(token, StringComparison.OrdinalIgnoreCase) &&
                !used.Contains(hex, StringComparer.OrdinalIgnoreCase))
            {
                return hex;
            }
        }

        return HexFromHue(FarthestHue([.. used.Select(HueOf).OfType<double>()]));
    }

    /// <summary>The hue (0-360) of a stored color, or null for grays, whose hue is
    /// meaningless and would only distort the spread.</summary>
    private static double? HueOf(string hex)
    {
        if (!TryParseHex(hex, out var color))
        {
            return null;
        }

        double r = color.R / 255.0, g = color.G / 255.0, b = color.B / 255.0;
        var max = Math.Max(r, Math.Max(g, b));
        var delta = max - Math.Min(r, Math.Min(g, b));
        if (delta < 0.08)
        {
            return null;
        }

        var hue = max == r ? (g - b) / delta
            : max == g ? (b - r) / delta + 2
            : (r - g) / delta + 4;
        return (hue * 60 + 360) % 360;
    }

    /// <summary>The hue with the greatest minimum wheel distance to every hue in use.</summary>
    private static double FarthestHue(IReadOnlyList<double> used)
    {
        if (used.Count == 0)
        {
            return 212; // the app's blue
        }

        double best = 0, bestScore = -1;
        for (var candidate = 0; candidate < 360; candidate += 2)
        {
            var score = used.Min(hue =>
            {
                var d = Math.Abs(candidate - hue) % 360;
                return Math.Min(d, 360 - d);
            });
            if (score > bestScore)
            {
                bestScore = score;
                best = candidate;
            }
        }

        return best;
    }

    private static string HexFromHue(double hue)
    {
        hue = (hue % 360 + 360) % 360;
        var c = (1 - Math.Abs(2 * ModelColorLightness - 1)) * ModelColorSaturation;
        var x = c * (1 - Math.Abs(hue / 60 % 2 - 1));
        var m = ModelColorLightness - c / 2;
        var (r, g, b) = ((int)(hue / 60)) switch
        {
            0 => (c, x, 0d),
            1 => (x, c, 0d),
            2 => (0d, c, x),
            3 => (0d, x, c),
            4 => (x, 0d, c),
            _ => (c, 0d, x)
        };
        byte To(double v) => (byte)Math.Round((v + m) * 255);
        return $"#{To(r):X2}{To(g):X2}{To(b):X2}";
    }

    private static bool TryParseHex(string hex, out Color color)
    {
        try
        {
            color = (Color)ColorConverter.ConvertFromString(hex);
            return true;
        }
        catch
        {
            color = default;
            return false;
        }
    }

    /// <summary>Header → "Town ↗": launches Token Town, the standalone Electron app in
    /// the repo's town/ folder. It reads usage.db read-only over its own data feed, so
    /// starting the process is the only integration the tracker needs.</summary>
    private void TownButton_Click(object sender, RoutedEventArgs e)
    {
        string? townDir = null;
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 6 && !string.IsNullOrEmpty(dir); i++)
        {
            var candidate = Path.Combine(dir, "town");
            if (File.Exists(Path.Combine(candidate, "src", "main.js")))
            {
                townDir = candidate;
                break;
            }

            dir = Path.GetDirectoryName(dir);
        }

        if (townDir is null)
        {
            System.Windows.MessageBox.Show(this,
                "Couldn't find the town folder next to TokenTracker.exe.",
                "Token Town", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var electron = Path.Combine(townDir, "node_modules", "electron", "dist", "electron.exe");
        if (!File.Exists(electron))
        {
            System.Windows.MessageBox.Show(this,
                $"Token Town isn't installed yet — run \"npm install\" in:\n{townDir}",
                "Token Town", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = electron,
                Arguments = $"\"{townDir}\"",
                WorkingDirectory = townDir,
                UseShellExecute = false
            });
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(this, "Token Town failed to start: " + ex.Message,
                "Token Town", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SettingsToggle_Checked(object sender, RoutedEventArgs e) => RebuildModelColorEditor();

    /// <summary>Settings → Model colors: one row per known model — a chip with the
    /// current color and a hue slider. Assignments live in settings.json.</summary>
    private void RebuildModelColorEditor()
    {
        ModelColorsPanel.Children.Clear();
        var models = _settings.ModelColors.Keys
            .OrderBy(model => _modelSlots.TryGetValue(model, out var slot) ? slot : int.MaxValue)
            .ThenBy(model => model, StringComparer.OrdinalIgnoreCase)
            .ToList();
        SpreadColorsButton.Visibility = models.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        if (models.Count == 0)
        {
            ModelColorsPanel.Children.Add(new TextBlock
            {
                Text = "Models appear here once usage arrives.",
                FontSize = 11,
                Foreground = (Brush)FindResource("MutedBrush"),
                Margin = new Thickness(0, 4, 0, 0)
            });
            return;
        }

        foreach (var model in models)
        {
            var current = ColorHexForModel(model);
            ModelColorsPanel.Children.Add(new TextBlock
            {
                Text = model,
                FontSize = 11,
                Foreground = (Brush)FindResource("Ink2Brush"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 8, 0, 4)
            });

            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition());
            var chip = new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(5),
                Margin = new Thickness(0, 0, 8, 0),
                Background = BrushForHex(current),
                BorderThickness = new Thickness(1),
                BorderBrush = (Brush)FindResource("HairlineBrush"),
                VerticalAlignment = VerticalAlignment.Center
            };
            row.Children.Add(chip);

            var slider = new Slider
            {
                Style = (Style)FindResource("HueSlider"),
                Value = HueOf(current) ?? 0,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(slider, 1);
            var captured = model;
            slider.ValueChanged += (_, args) =>
            {
                var hex = HexFromHue(args.NewValue);
                _settings.ModelColors[captured] = hex;
                chip.Background = BrushForHex(hex);
                QueueModelColorRepaint();
            };
            row.Children.Add(slider);
            ModelColorsPanel.Children.Add(row);
        }
    }

    private System.Windows.Threading.DispatcherTimer? _modelColorRepaintTimer;

    /// <summary>Coalesces a slider drag's stream of changes into one save + repaint.</summary>
    private void QueueModelColorRepaint()
    {
        if (_modelColorRepaintTimer is null)
        {
            _modelColorRepaintTimer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromMilliseconds(150)
            };
            _modelColorRepaintTimer.Tick += (_, _) =>
            {
                _modelColorRepaintTimer!.Stop();
                _settings.Save();
                ApplyModelColors();
            };
        }

        _modelColorRepaintTimer.Stop();
        _modelColorRepaintTimer.Start();
    }

    /// <summary>Settings → "Spread colors apart": reassigns every model so colors sit as
    /// far apart on the wheel as possible. Family seeds keep their signature hue.</summary>
    private void SpreadColorsButton_Click(object sender, RoutedEventArgs e)
    {
        var models = _settings.ModelColors.Keys
            .OrderBy(model => _modelSlots.TryGetValue(model, out var slot) ? slot : int.MaxValue)
            .ThenBy(model => model, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var seedsTaken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hues = new List<double>();
        var pending = new List<string>();
        foreach (var model in models)
        {
            string? assigned = null;
            foreach (var (token, hex) in FamilySeeds)
            {
                if (model.Contains(token, StringComparison.OrdinalIgnoreCase) && seedsTaken.Add(hex))
                {
                    assigned = hex;
                    break;
                }
            }

            if (assigned is null)
            {
                pending.Add(model);
                continue;
            }

            _settings.ModelColors[model] = assigned;
            if (HueOf(assigned) is { } hue)
            {
                hues.Add(hue);
            }
        }

        foreach (var model in pending)
        {
            var hue = FarthestHue(hues);
            hues.Add(hue);
            _settings.ModelColors[model] = HexFromHue(hue);
        }

        _settings.Save();
        ApplyModelColors();
        RebuildModelColorEditor();
    }

    /// <summary>Repaints everything colored by model after an assignment changes.</summary>
    private void ApplyModelColors()
    {
        foreach (var bubble in _cupBubbles.Values)
        {
            if (bubble.Visual is Border border)
            {
                border.Background = BrushForModel(bubble.Event.Model);
            }
        }

        UpdateLiveLegend();
        if (_latestData is { } data)
        {
            UpdateModels(data);
            UpdateChart();
        }
    }

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

    /// <summary>What the chart on screen was drawn from, flattened — null while
    /// the canvas holds nothing. A redraw is thousands of elements, so the 30 s
    /// dashboard refresh must reach it only when something it draws changed.</summary>
    private string? _chartDrawnSignature;

    private System.Windows.Threading.DispatcherTimer? _chartResizeTimer;

    /// <summary>Everything <see cref="DrawChart"/> reads, cheaply. The totals
    /// stand in for the buckets' contents: an event that lands in any bucket
    /// moves them too. Model slots carry their colors, since a recolor repaints
    /// the same numbers.</summary>
    private string ChartSignature(DashboardData data)
    {
        var totals = data.Totals;
        var slots = string.Join(",", _modelSlots
            .OrderBy(pair => pair.Value)
            .Select(pair => $"{pair.Value}:{ColorHexForModel(pair.Key)}"));
        return string.Join("|",
            _metricKey,
            TableToggle.IsChecked == true ? "table" : "chart",
            (int)Math.Round(ChartCanvas.ActualWidth),
            (int)Math.Round(ChartCanvas.ActualHeight),
            data.Unit,
            data.Buckets.Count,
            data.Buckets.Count == 0 ? 0 : data.Buckets[0].StartMs,
            data.Buckets.Count == 0 ? 0 : data.Buckets[^1].StartMs,
            totals.Total,
            totals.Messages,
            totals.EstimatedCost.ToString("R", Usd),
            totals.UnpricedEvents,
            data.Models.Count,
            slots);
    }

    private void DrawChart()
    {
        if (_latestData is not { } data)
        {
            return;
        }

        var signature = ChartSignature(data);
        if (signature == _chartDrawnSignature)
        {
            return;
        }

        var canvas = ChartCanvas;
        canvas.Children.Clear();
        if (canvas.ActualWidth < 60 || canvas.ActualHeight < 60)
        {
            // Nothing drawn: leave the signature null so the size that can hold
            // a chart draws immediately rather than waiting out the debounce.
            _chartDrawnSignature = null;
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
            _chartDrawnSignature = signature;
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
            _chartDrawnSignature = null;
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

        // One wash for the whole chart, moved to the hovered slot, added here so
        // it stays behind the bars — a lit column, not a veil over the marks.
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
        Canvas.SetLeft(wash, plotLeft);
        Canvas.SetTop(wash, plotTop);
        canvas.Children.Add(wash);

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

            // A label is drawn when its anchor is the tallest bar under the label's
            // horizontal footprint, however many slots that spans — so even 1px bars
            // get labelled at their local peaks, and a label never covers a taller bar.
            if (showBarLabels && values[i] > 0)
            {
                var text = FormatMoneyShort(values[i]);
                var width = LabelWidth(text) + 2;
                var reach = Math.Max(0, (int)Math.Ceiling((width - slotWidth) / (2 * slotWidth)));
                var tallest = true;
                for (var j = Math.Max(0, i - reach); tallest && j <= Math.Min(count - 1, i + reach); j++)
                {
                    tallest = values[j] <= values[i];
                }

                if (tallest)
                {
                    labelCandidates.Add((i, text, width));
                }
            }
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

        // One hover surface over the plot rather than a hit target per bucket:
        // the slot under the pointer is arithmetic on its X, and a fine-grained
        // range would otherwise carry a thousand elements with handlers each.
        // The tooltip is still built on demand — at 1000+ buckets, eager
        // tooltips dominate the redraw.
        var surface = new Rectangle
        {
            Width = plotWidth,
            Height = plotHeight,
            Fill = Brushes.Transparent
        };
        var tip = new System.Windows.Controls.ToolTip
        {
            Placement = System.Windows.Controls.Primitives.PlacementMode.Mouse,
            PlacementTarget = surface
        };
        surface.ToolTip = tip;
        ToolTipService.SetInitialShowDelay(surface, 120);
        ToolTipService.SetShowDuration(surface, 60000);

        var hovered = -1;
        var shown = false;
        tip.Opened += (_, _) => shown = true;
        surface.MouseMove += (_, e) =>
        {
            var slot = Math.Clamp((int)((e.GetPosition(canvas).X - plotLeft) / slotWidth), 0, count - 1);
            if (slot == hovered)
            {
                return;
            }

            hovered = slot;
            Canvas.SetLeft(wash, plotLeft + slotWidth * slot);
            wash.Visibility = Visibility.Visible;
            tip.Content = BuildBucketTooltip(buckets[slot], data.Unit);
            if (shown)
            {
                // Once a tip has shown, the next slot re-opens it so it lands
                // beside the cursor instead of hanging where the pointer first
                // stopped. The first one still waits out its show delay.
                tip.IsOpen = false;
                tip.IsOpen = true;
            }
        };
        surface.MouseLeave += (_, _) =>
        {
            hovered = -1;
            shown = false;
            wash.Visibility = Visibility.Hidden;
            tip.IsOpen = false;
        };
        Canvas.SetLeft(surface, plotLeft);
        Canvas.SetTop(surface, plotTop);
        canvas.Children.Add(surface);

        _chartDrawnSignature = signature;
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

    /// <summary>Bottom-to-top stack for one bucket: every model in slot order, each
    /// in its own color. "Other" only catches a slice whose model has no slot yet
    /// (a refresh race) — it is never a pool.</summary>
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

        var slotCount = _modelSlots.Count;
        var bySlot = new double[slotCount];
        var modelBySlot = new string?[slotCount];
        foreach (var pair in _modelSlots)
        {
            modelBySlot[pair.Value] = pair.Key;
        }

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

        for (var slot = 0; slot < slotCount; slot++)
        {
            if (bySlot[slot] > 0)
            {
                result.Add((bySlot[slot], modelBySlot[slot] is { } model
                    ? BrushForModel(model)
                    : _otherBrush));
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
            _openCodeService.Dispose();
            _limitsService.Dispose();
            _apiServer.Dispose();
            _captureProxy.Dispose();
            ReleaseEnvironment();
        }
    }

    /// <summary>New sessions launched while the app is closed must reach the API
    /// directly rather than a relay that isn't there; re-set on relaunch. Called
    /// from every way the app can end — window close, logoff/shutdown, a crash —
    /// because a leftover ANTHROPIC_BASE_URL takes every Claude Code session on
    /// the machine down with "Connection refused".</summary>
    public void ReleaseEnvironment()
    {
        if (_settings.CaptureRequestsEnabled)
        {
            RequestCaptureProxy.ClearEnvironment();
        }

        // CODEX_ROLLOUT_TRACE_ROOT stays: with it cleared at every sign-out, whatever
        // starts before the tracker at the next login (the Claude app, a terminal)
        // runs Codex untraced all session. Bundles written meanwhile wait for the next
        // start. Only unticking the setting removes it.
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
