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
    private readonly SemaphoreSlim _dashboardLock = new(1, 1);
    private bool _loaded;
    private bool _disposed;
    private string _rangeKey = "last7";
    private string _metricKey = "cost";
    private string _barsKey = "auto";
    private DashboardData? _latestData;

    // ── Live view state ────────────────────────────────────────────────────
    private string _tabKey = "dashboard";
    private string _liveWindowKey = "w5";
    private string _liveModeKey = "river";
    private string _liveMetricKey = "cost";
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

    // River and cup keep independent stores fed by one shared pull, each with
    // its own cursor: switching mode or round length never discards the other
    // view's state (and a longer round must not re-ingest events that already
    // settled into layers).
    private long _riverLastSeenMs;
    private long _cupLastSeenMs;

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
    private readonly Dictionary<string, LiveBubble> _riverBubbles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, LiveBubble> _cupBubbles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _liveLanes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _liveLaneSeq = new(StringComparer.Ordinal);
    private readonly System.Windows.Threading.DispatcherTimer _liveTimer;

    // Beeswarm slots: consecutive responses from one session fan out around the
    // lane center instead of stacking on top of each other.
    private static readonly double[] LaneSlotOffsets = [0, -1, 1, -2, 2];

    private sealed class LiveBubble
    {
        public required LiveEventRow Event { get; set; }
        public required FrameworkElement Visual { get; set; }
        public required long FirstSeenMs { get; init; }
        public required long SpawnedAtMs { get; init; }
        public required int Lane { get; init; }
        public required int LaneSlot { get; init; }
        public required double Jitter { get; init; }
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
    private const int MaxChartBars = 500;
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
        _liveModeKey = _settings.SelectedLiveMode == "cup" ? "cup" : "river";
        (_liveModeKey == "cup" ? LiveModeCup : LiveModeRiver).IsChecked = true;
        _liveMetricKey = _settings.SelectedLiveMetric == "tokens" ? "tokens" : "cost";
        (_liveMetricKey == "tokens" ? LiveMetricTokens : LiveMetricCost).IsChecked = true;
        ApplyLiveModeVisibility();
        UpdateLiveWindowLabels();
        _tabKey = NormalizeTabKey(_settings.SelectedTab);
        TabRadioFor(_tabKey).IsChecked = true;

        IntervalComboBox.ItemsSource = Intervals;
        IntervalComboBox.SelectedItem = Intervals
            .OrderBy(interval => Math.Abs(interval.Seconds - _settings.ReconcileSeconds))
            .First();
        try
        {
            StartupCheckBox.IsChecked = StartupRegistration.IsEnabled();
        }
        catch
        {
            StartupCheckBox.IsChecked = false;
        }

        DatabasePathText.Text = $"Local index: {_database.DatabasePath}";

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
            }
        };
        liveRefresh.Start();
    }

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
            await ReseedRiverAsync();
            _liveStarted = true;
            _liveTimer.Start();
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
    /// Disables bar sizes too fine for the selected range (more bars than the
    /// series cap allows). A selection that just became invalid falls back to Auto.
    /// </summary>
    private void UpdateBarsAvailability()
    {
        var spanMs = RangeSpanMs(_rangeKey);
        foreach (var (radio, key) in new[]
                 {
                     (BarsM1, "m1"), (BarsM5, "m5"), (BarsM15, "m15"),
                     (BarsM30, "m30"), (BarsH1, "h1"), (BarsD1, "d1")
                 })
        {
            var unitMs = BarsUnitMs(key);
            radio.IsEnabled = spanMs is { } span && unitMs > 0 && span / (double)unitMs <= MaxChartBars;
        }

        if (BarsRadioFor(_barsKey) is { IsEnabled: false })
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
            "last24" => 24 * 3_600_000L,
            "last7" => 7 * 86_400_000L,
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
        "m1" => 60_000,
        "m5" => 300_000,
        "m15" => 900_000,
        "m30" => 1_800_000,
        "h1" => 3_600_000,
        "d1" => 86_400_000,
        _ => 0
    };

    private static BucketUnit? BarsUnitFor(string key) => key switch
    {
        "m1" => BucketUnit.Minute1,
        "m5" => BucketUnit.Minute5,
        "m15" => BucketUnit.Minute15,
        "m30" => BucketUnit.Minute30,
        "h1" => BucketUnit.Hour,
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
        DashboardHero.Visibility = live ? Visibility.Collapsed : Visibility.Visible;
        DashboardContent.Visibility = live ? Visibility.Collapsed : Visibility.Visible;
        RangeGroupBorder.Visibility = live ? Visibility.Collapsed : Visibility.Visible;
        LiveRoot.Visibility = live ? Visibility.Visible : Visibility.Collapsed;
        // Live state keeps running in the background; the tab switch only
        // pauses the per-frame rendering.
        if (live)
        {
            StartLiveFrames();
            RebuildLiveAxis();
        }
        else
        {
            StopLiveFrames();
        }
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
        if (_liveModeKey == "cup")
        {
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
        else
        {
            var width = RiverCanvas.ActualWidth;
            var height = RiverCanvas.ActualHeight;
            if (_riverBubbles.Count == 0 || width < 40 || height < 40)
            {
                return;
            }

            AdvanceRiver(nowMs, width, height);
        }
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
            _ => 300_000L
        };
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedLiveWindow = key;
        _settings.Save();
        UpdateLiveWindowLabels();
        RebuildLiveAxis();
        if (_liveModeKey == "cup")
        {
            // The running round simply adopts the new length: a longer round
            // keeps its blocks and countdown; a shorter one settles on the
            // next tick. Nothing is discarded and nothing is re-ingested.
            UpdateRoundText(DateTimeOffset.Now.ToUnixTimeMilliseconds());
        }
        else
        {
            await ReseedRiverAsync();
        }
    }

    private void UpdateLiveWindowLabels()
    {
        var name = _liveModeKey == "cup"
            ? "this round"
            : _liveWindowKey switch
            {
                "w1" => "last 60 s",
                "w15" => "last 15 min",
                "w30" => "last 30 min",
                "w45" => "last 45 min",
                "w60" => "last hour",
                _ => "last 5 min"
            };
        LiveSpendLabel.Text = $"Spend · {name}";
        LiveTokensLabel.Text = $"Tokens · {name}";
        LiveMessagesLabel.Text = $"Responses · {name}";
    }

    private async void LiveModeButton_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string key } || key == _liveModeKey && _loaded)
        {
            return;
        }

        _liveModeKey = key;
        if (!_loaded)
        {
            return;
        }

        _settings.SelectedLiveMode = key;
        _settings.Save();
        // Both views keep running in the background; switching is only a
        // visibility change, so the cup's sediment survives a trip to the river.
        UpdateLiveWindowLabels();
        ApplyLiveModeVisibility();
        RebuildLiveAxis();
        UpdateLiveLegend();
        _cupLayoutDirty = true;
    }

    private void ApplyLiveModeVisibility()
    {
        var cup = _liveModeKey == "cup";
        LiveScroll.Visibility = cup ? Visibility.Visible : Visibility.Collapsed;
        RiverCanvas.Visibility = cup ? Visibility.Collapsed : Visibility.Visible;
        LiveRoundText.Visibility = cup ? Visibility.Visible : Visibility.Collapsed;
        RoundHistoryBars.Visibility = cup ? Visibility.Visible : Visibility.Collapsed;
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

    /// <summary>Starts cup tracking from scratch: fresh round, no sediment. App start only.</summary>
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

    /// <summary>Forgets the river and replays the current window from the index.</summary>
    private async Task ReseedRiverAsync()
    {
        foreach (var bubble in _riverBubbles.Values)
        {
            RiverCanvas.Children.Remove(bubble.Visual);
        }

        _riverBubbles.Clear();
        _liveLanes.Clear();
        _liveLaneSeq.Clear();
        _riverLastSeenMs = DateTimeOffset.Now.ToUnixTimeMilliseconds() - _liveWindowMs;
        await PullLiveEventsAsync();
        UpdateLiveLegend();
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
            // One shared fetch feeds both stores; each keeps its own cursor so
            // a river reseed can rewind without re-ingesting settled cup events.
            var since = Math.Min(_riverLastSeenMs, _cupLastSeenMs);
            var rows = await _database.GetEventsUpdatedSinceAsync(since, 1200);
            var maxUpdated = 0L;
            foreach (var row in rows)
            {
                if (row.UpdatedMs > _riverLastSeenMs)
                {
                    UpsertRiverBubble(row);
                }

                if (row.UpdatedMs > _cupLastSeenMs)
                {
                    UpsertCupBubble(row);
                }

                maxUpdated = Math.Max(maxUpdated, row.UpdatedMs);
            }

            if (rows.Count > 0)
            {
                _riverLastSeenMs = Math.Max(_riverLastSeenMs, maxUpdated);
                _cupLastSeenMs = Math.Max(_cupLastSeenMs, maxUpdated);
                LivePulseDot.Opacity = 1.0;
                LivePulseText.Text = $"last update {DateTime.Now:h:mm:ss tt}";
                UpdateLiveLegend();
            }
        }
        catch
        {
            // Best effort: the next collector event or reseed retries.
        }
        finally
        {
            _livePulling = false;
        }
    }

    private void UpsertRiverBubble(LiveEventRow row)
    {
        var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
        if (_riverBubbles.TryGetValue(row.EventKey, out var existing))
        {
            // Same message grew (output still streaming in): inflate in place.
            existing.Event = row;
            existing.Cost = estimate.Cost;
            existing.Visual.ToolTip = BuildLiveTooltip(row, estimate);
            return;
        }

        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        if (nowMs - row.UpdatedMs > _liveWindowMs)
        {
            return;
        }

        AssignLiveModelSlot(row.Model);
        if (!_liveLanes.TryGetValue(row.SessionId, out var lane))
        {
            _liveLanes[row.SessionId] = lane = _liveLanes.Count;
        }

        _liveLaneSeq.TryGetValue(row.SessionId, out var slot);
        _liveLaneSeq[row.SessionId] = slot + 1;

        var bubble = new LiveBubble
        {
            Event = row,
            Visual = null!,
            FirstSeenMs = row.UpdatedMs,
            SpawnedAtMs = nowMs,
            Lane = lane,
            LaneSlot = slot,
            Jitter = (Math.Abs(StableHash(row.EventKey)) % 1000) / 1000.0 - 0.5,
            Cost = estimate.Cost
        };
        bubble.Visual = CreateRiverVisual(bubble);
        // Invisible until the first frame positions and sizes it.
        bubble.Visual.Width = 0;
        bubble.Visual.Height = 0;
        _riverBubbles[row.EventKey] = bubble;
        RiverCanvas.Children.Add(bubble.Visual);
    }

    private void UpsertCupBubble(LiveEventRow row)
    {
        var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
        if (_cupBubbles.TryGetValue(row.EventKey, out var existing))
        {
            existing.Event = row;
            existing.Cost = estimate.Cost;
            existing.Visual.ToolTip = BuildLiveTooltip(row, estimate);
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
            FirstSeenMs = row.UpdatedMs,
            SpawnedAtMs = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            Lane = 0,
            LaneSlot = 0,
            Jitter = 0,
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
        var estimate = new PricingEstimate(bubble.Cost, bubble.Cost > 0);
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
        return new Border
        {
            Background = fill,
            BorderBrush = LiveStrokeBrush(),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(5),
            Child = label,
            ToolTip = BuildLiveTooltip(row, estimate)
        };
    }

    private FrameworkElement CreateRiverVisual(LiveBubble bubble)
    {
        var row = bubble.Event;
        var estimate = new PricingEstimate(bubble.Cost, bubble.Cost > 0);
        var bubbleFill = new SolidColorBrush(LiveModelColor(row.Model)) { Opacity = 0.8 };
        bubbleFill.Freeze();
        bubble.Label = null;
        return new Ellipse
        {
            Fill = bubbleFill,
            Stroke = LiveStrokeBrush(),
            StrokeThickness = 1,
            ToolTip = BuildLiveTooltip(row, estimate)
        };
    }

    /// <summary>Repositions the river every 100 ms and refreshes the counters.</summary>
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

        // Both views tick in the background regardless of which is showing.
        var nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        TickCupRound(nowMs);

        List<string>? expired = null;
        foreach (var (key, bubble) in _riverBubbles)
        {
            if (nowMs - bubble.FirstSeenMs > _liveWindowMs + 2_000)
            {
                (expired ??= []).Add(key);
            }
        }

        if (expired is not null)
        {
            foreach (var key in expired)
            {
                RiverCanvas.Children.Remove(_riverBubbles[key].Visual);
                _riverBubbles.Remove(key);
            }

            UpdateLiveLegend();
        }

        var store = _liveModeKey == "cup" ? _cupBubbles : _riverBubbles;
        double costWindow = 0, cost60 = 0;
        long tokensWindow = 0, tokens60 = 0, messagesWindow = 0;
        foreach (var bubble in store.Values)
        {
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

        LiveEmptyText.Visibility = store.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        LiveSpendText.Text = FormatMoney(costWindow);
        LiveTokensText.Text = FormatCompact(tokensWindow);
        LiveMessagesText.Text = messagesWindow.ToString("N0");
        LiveRateText.Text = $"{FormatMoney(cost60)}/min";
        LiveTokenRateText.Text = $"{FormatCompact((long)(tokens60 / 60.0))}/s";
    }

    /// <summary>Cup round lifecycle: countdown → the pile settles into a layer → fresh round on top.</summary>
    private void TickCupRound(long nowMs)
    {
        if (nowMs - _roundStartMs >= _liveWindowMs)
        {
            SettleRound(nowMs);
        }

        UpdateRoundText(nowMs);
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

            var caption = new TextBlock
            {
                Text = $"{DateTime.Now:h:mm tt}  ·  {FormatMoney(cost)}  ·  {FormatCompact(tokens)} tok",
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
        if (_tabKey == "live")
        {
            LiveScroll.ScrollToVerticalOffset(0);
        }
    }

    private void UpdateRoundText(long nowMs)
    {
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

    private void AdvanceRiver(long nowMs, double width, double height)
    {
        var laneCount = Math.Max(1, (int)((height - 36) / 52));
        var laneHeight = (height - 36) / laneCount;

        foreach (var bubble in _riverBubbles.Values)
        {
            var age = nowMs - bubble.FirstSeenMs;
            var spawnAge = nowMs - bubble.SpawnedAtMs;
            var popScale = spawnAge >= 250 ? 1 : 0.4 + 0.6 * (spawnAge / 250.0);
            var radius = Math.Min(BubbleRadius(bubble), laneHeight * 0.55) * popScale;
            var x = width * (1 - age / (double)_liveWindowMs);
            var slotOffset = LaneSlotOffsets[bubble.LaneSlot % LaneSlotOffsets.Length];
            var y = 18 + (bubble.Lane % laneCount) * laneHeight + laneHeight / 2 +
                    slotOffset * laneHeight * 0.22 +
                    bubble.Jitter * Math.Min(8, laneHeight * 0.12);
            bubble.Visual.Width = radius * 2;
            bubble.Visual.Height = radius * 2;
            Canvas.SetLeft(bubble.Visual, x - radius);
            Canvas.SetTop(bubble.Visual, y - radius);

            var remaining = (_liveWindowMs - age) / (double)_liveWindowMs;
            bubble.Visual.Opacity = 0.2 + 0.8 * Math.Clamp(remaining / 0.25, 0, 1);
        }
    }

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
        var available = Math.Max(40, viewportHeight - floorInset - topPad);
        var scale = 1.0;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var needed = PackHeight(active, width, wallInset, scale);
            if (needed <= available || scale <= 0.08)
            {
                break;
            }

            scale *= Math.Max(0.4, Math.Sqrt(available / needed) * 0.96);
        }

        _activeCupScale = scale;

        foreach (var layer in _cupLayers)
        {
            layer.Height = PackHeight(layer.Blocks, width, wallInset, layer.Scale) + captionBand + 6;
        }

        var canvasHeight = viewportHeight + _cupLayers.Sum(layer => layer.Height);
        LiveCanvas.Width = width;
        LiveCanvas.Height = canvasHeight;

        PackInto(active, width, wallInset, scale, viewportHeight - floorInset);

        var bandTop = viewportHeight;
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

    /// <summary>Bubble area tracks the selected metric; unpriced costs fall back to tokens.</summary>
    private double BubbleRadius(LiveBubble bubble)
    {
        var sqrt = LiveMetricSqrt(bubble);
        return Math.Clamp(5 + 42 * sqrt, 5, 52);
    }

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

    private void LiveCanvas_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        _cupLayoutDirty = true;
        RebuildLiveAxis();
    }

    private void RebuildLiveAxis()
    {
        LiveAxisCanvas.Children.Clear();
        var width = LiveAxisCanvas.ActualWidth;
        var height = LiveAxisCanvas.ActualHeight;
        if (width < 40 || height < 40)
        {
            return;
        }

        if (_liveModeKey == "cup")
        {
            // The cup (walls, dividers) is drawn inside the scrollable canvas.
            return;
        }

        var stepMs = _liveWindowMs switch
        {
            60_000L => 15_000L,
            900_000L => 180_000L,
            1_800_000L => 300_000L,
            2_700_000L => 300_000L,
            3_600_000L => 600_000L,
            _ => 60_000L
        };
        var gridBrush = (Brush)FindResource("GridlineBrush");
        var mutedBrush = (Brush)FindResource("MutedBrush");
        for (var t = 0L; t <= _liveWindowMs; t += stepMs)
        {
            var x = width * (1 - t / (double)_liveWindowMs);
            LiveAxisCanvas.Children.Add(new Line
            {
                X1 = x,
                X2 = x,
                Y1 = 0,
                Y2 = height - 18,
                Stroke = gridBrush,
                StrokeThickness = 1
            });
            var label = new TextBlock
            {
                Text = t == 0 ? "now" : $"-{(t >= 60_000 ? $"{t / 60_000}m" : $"{t / 1000}s")}",
                FontSize = 10,
                Foreground = mutedBrush
            };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(label, Math.Max(0, Math.Min(width - label.DesiredSize.Width, x - label.DesiredSize.Width / 2)));
            Canvas.SetTop(label, height - 16);
            LiveAxisCanvas.Children.Add(label);
        }
    }

    private void UpdateLiveLegend()
    {
        var store = _liveModeKey == "cup" ? _cupBubbles : _riverBubbles;
        LiveLegend.ItemsSource = store.Values
            .Where(bubble => !bubble.Frozen)
            .GroupBy(bubble => bubble.Event.Model, StringComparer.OrdinalIgnoreCase)
            .Select(group => (Model: group.Key, Cost: group.Sum(bubble => bubble.Cost)))
            .OrderByDescending(item => item.Cost)
            .Take(8)
            .Select(item => new LegendItemVm(item.Model, BrushForModel(item.Model)))
            .ToList();
    }

    private static string BuildLiveTooltip(LiveEventRow row, PricingEstimate estimate)
    {
        var tokens = row.Tokens;
        var time = DateTimeOffset.FromUnixTimeMilliseconds(row.TimestampMs).ToLocalTime();
        var session = row.SessionId.Length > 12 ? row.SessionId[..12] + "…" : row.SessionId;
        return $"{row.Model}\n{row.Client} · {row.Provider} · {time:h:mm:ss tt}\n\n" +
               $"Cost: {(estimate.IsPriced ? estimate.Cost.ToString("C4", Usd) : "no pricing match")}\n" +
               $"Input: {tokens.Input:N0} · Output: {tokens.Output:N0}\n" +
               $"Cache read: {tokens.CacheRead:N0} · write: {tokens.CacheWrite:N0}\n" +
               $"Reasoning: {tokens.Reasoning:N0} · Session: {session}";
    }

    /// <summary>Deterministic within a run; only feeds visual jitter.</summary>
    private static int StableHash(string value)
    {
        var hash = 17;
        foreach (var character in value)
        {
            hash = unchecked(hash * 31 + character);
        }

        return hash;
    }

    private RadioButton TabRadioFor(string key) => key == "live" ? TabLive : TabDashboard;

    private static string NormalizeTabKey(string key) => key == "live" ? "live" : "dashboard";

    private RadioButton LiveWindowRadioFor(string key) => key switch
    {
        "w1" => LiveW1,
        "w15" => LiveW15,
        "w30" => LiveW30,
        "w45" => LiveW45,
        "w60" => LiveW60,
        _ => LiveW5
    };

    private static string NormalizeLiveWindowKey(string key) => key switch
    {
        "w1" or "w15" or "w30" or "w45" or "w60" => key,
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
            var data = await _database.GetDashboardAsync(_rangeKey, _pricing, BarsUnitFor(_barsKey));
            _latestData = data;
            AssignModelSlots(data);
            var totals = data.Totals;

            CostText.Text = FormatMoney(totals.EstimatedCost);
            CostText.ToolTip = totals.UnpricedEvents == 0
                ? $"{totals.EstimatedCost.ToString("C2", Usd)} at current API list prices."
                : $"{totals.EstimatedCost.ToString("C2", Usd)} at current API list prices. " +
                  $"Excludes {totals.UnpricedEvents:N0} records with no pricing match.";
            CostDeltaText.Text = FormatCostDelta(totals.EstimatedCost, data.PreviousCost);

            TotalTokensText.Text = FormatCompact(totals.Total);
            TotalTokensText.ToolTip = totals.Total.ToString("N0");
            InputTokensText.Text = FormatCompact(totals.Input);
            InputTokensText.ToolTip = totals.Input.ToString("N0");
            OutputTokensText.Text = FormatCompact(totals.Output);
            OutputTokensText.ToolTip = totals.Output.ToString("N0");
            ReasoningTokensText.Text = FormatCompact(totals.Reasoning);
            ReasoningTokensText.ToolTip = $"{totals.Reasoning:N0} — included in output tokens";
            CacheReadTokensText.Text = FormatCompact(totals.CacheRead);
            CacheReadTokensText.ToolTip = totals.CacheRead.ToString("N0");
            CacheWriteTokensText.Text = FormatCompact(totals.CacheWrite);
            CacheWriteTokensText.ToolTip = totals.CacheWrite.ToString("N0");

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
            BucketUnit.Minute1 => "minute",
            BucketUnit.Minute5 => "5 min",
            BucketUnit.Minute15 => "15 min",
            BucketUnit.Minute30 => "30 min",
            BucketUnit.Hour => "hour",
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
        var barWidth = Math.Min(24, Math.Max(2, slotWidth - 2));

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

            // Full-slot hit target carrying the tooltip.
            var hit = new Rectangle
            {
                Width = Math.Max(1, slotWidth),
                Height = plotHeight,
                Fill = Brushes.Transparent,
                ToolTip = BuildBucketTooltip(bucket, data.Unit)
            };
            ToolTipService.SetInitialShowDelay(hit, 120);
            ToolTipService.SetShowDuration(hit, 60000);
            hit.MouseEnter += (_, _) => wash.Visibility = Visibility.Visible;
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
        BucketUnit.Minute1 or BucketUnit.Minute5 or BucketUnit.Minute15 or BucketUnit.Minute30 =>
            start.ToString("h:mm tt"),
        BucketUnit.Hour => markMidnight ? start.ToString("ddd") : start.ToString("h tt"),
        BucketUnit.Month => start.ToString("MMM yyyy"),
        _ => start.ToString("MMM d")
    };

    private static string FormatPeriod(DateTime start, BucketUnit unit) => unit switch
    {
        BucketUnit.Minute1 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(1):h:mm tt}",
        BucketUnit.Minute5 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(5):h:mm tt}",
        BucketUnit.Minute15 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(15):h:mm tt}",
        BucketUnit.Minute30 => $"{start:ddd, MMM d} · {start:h:mm}–{start.AddMinutes(30):h:mm tt}",
        BucketUnit.Hour => $"{start:ddd, MMM d} · {start:h tt}–{start.AddHours(1):h tt}",
        BucketUnit.Month => start.ToString("MMMM yyyy"),
        _ => start.ToString("ddd, MMM d")
    };

    private string FormatCostDelta(double current, double? previous)
    {
        var periodName = _rangeKey switch
        {
            "today" => "yesterday",
            "last1" => "the prior hour",
            "last4" => "the prior 4 h",
            "last8" => "the prior 8 h",
            "last12" => "the prior 12 h",
            "last24" => "the prior 24 h",
            "last7" => "the prior 7 days",
            "last30" => "the prior 30 days",
            "currentMonth" => "last month to date",
            _ => null
        };
        if (periodName is null || previous is not { } prior)
        {
            return string.Empty;
        }

        if (prior <= 0)
        {
            return current > 0 ? $"nothing spent {periodName}" : string.Empty;
        }

        var change = (current - prior) / prior;
        var arrow = change >= 0 ? "▲" : "▼";
        return $"{arrow} {Math.Abs(change):P0} vs {periodName} ({FormatMoney(prior)})";
    }

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
        "last1" => RangeLast1,
        "last4" => RangeLast4,
        "last8" => RangeLast8,
        "last12" => RangeLast12,
        "last24" => RangeLast24,
        "today" => RangeToday,
        "last30" => RangeLast30,
        "currentMonth" => RangeMonth,
        "all" => RangeAll,
        _ => RangeLast7
    };

    private static string NormalizeRangeKey(string key) => key switch
    {
        "previousMonth" => "currentMonth",
        "last1" or "last4" or "last8" or "last12" or "last24" or "today"
            or "last7" or "last30" or "currentMonth" or "all" => key,
        _ => "last7"
    };

    private RadioButton BarsRadioFor(string key) => key switch
    {
        "m1" => BarsM1,
        "m5" => BarsM5,
        "m15" => BarsM15,
        "m30" => BarsM30,
        "h1" => BarsH1,
        "d1" => BarsD1,
        _ => BarsAuto
    };

    private static string NormalizeBarsKey(string key) => key switch
    {
        "m1" or "m5" or "m15" or "m30" or "h1" or "d1" => key,
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
