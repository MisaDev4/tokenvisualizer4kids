using System.ComponentModel;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;

namespace TokenTracker;

public partial class MainWindow : Window
{
    private readonly AppSettings _settings;
    private readonly PricingService _pricing;
    private readonly UsageDatabase _database;
    private readonly UsageCollector _collector;
    private readonly SemaphoreSlim _dashboardLock = new(1, 1);
    private bool _loaded;
    private bool _disposed;

    private static readonly DateRangeChoice[] DateRanges =
    [
        new("today", "Today"),
        new("last24", "Last 24 hours"),
        new("last7", "Last 7 days"),
        new("last30", "Last 30 days"),
        new("currentMonth", "Current month"),
        new("previousMonth", "Previous month"),
        new("all", "All time")
    ];

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
        _settings = AppSettings.Load();
        _pricing = new PricingService();
        _database = new UsageDatabase();
        _collector = new UsageCollector(_database, _settings);
        _collector.ProgressChanged += Collector_ProgressChanged;
        _collector.DataChanged += Collector_DataChanged;
        _collector.Error += Collector_Error;

        RangeComboBox.ItemsSource = DateRanges;
        RangeComboBox.SelectedItem = DateRanges.FirstOrDefault(range => range.Key == _settings.SelectedRange)
                                     ?? DateRanges[4];
        IntervalComboBox.ItemsSource = Intervals;
        IntervalComboBox.SelectedItem = Intervals.OrderBy(interval => Math.Abs(interval.Seconds - _settings.ReconcileSeconds)).First();
        try
        {
            StartupCheckBox.IsChecked = StartupRegistration.IsEnabled();
        }
        catch
        {
            StartupCheckBox.IsChecked = false;
        }

        DatabasePathText.Text = $"Local index: {_database.DatabasePath}";
    }

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
        await _collector.FullRescanAsync();
        await RefreshDashboardAsync();
    }

    private async void RangeComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || RangeComboBox.SelectedItem is not DateRangeChoice selected)
        {
            return;
        }

        _settings.SelectedRange = selected.Key;
        _settings.Save();
        await RefreshDashboardAsync();
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
            var range = (RangeComboBox.SelectedItem as DateRangeChoice)?.Key ?? _settings.SelectedRange;
            var data = await _database.GetDashboardAsync(range, _pricing);
            var totals = data.Totals;
            EstimatedCostText.Text = FormatMoney(totals.EstimatedCost);
            EstimatedCostText.ToolTip = totals.UnpricedEvents == 0
                ? "Estimated API list-price cost for this range."
                : $"Estimate excludes {totals.UnpricedEvents:N0} records whose model has no pricing match.";
            TotalTokensText.Text = FormatCompact(totals.Total);
            TotalTokensText.ToolTip = totals.Total.ToString("N0");
            InputTokensText.Text = FormatCompact(totals.Input);
            InputTokensText.ToolTip = totals.Input.ToString("N0");
            OutputTokensText.Text = FormatCompact(totals.Output);
            OutputTokensText.ToolTip = totals.Output.ToString("N0");
            ReasoningTokensText.Text = FormatCompact(totals.Reasoning);
            ReasoningTokensText.ToolTip = totals.Reasoning.ToString("N0");
            CacheReadTokensText.Text = FormatCompact(totals.CacheRead);
            CacheReadTokensText.ToolTip = totals.CacheRead.ToString("N0");
            CacheWriteTokensText.Text = FormatCompact(totals.CacheWrite);
            CacheWriteTokensText.ToolTip = totals.CacheWrite.ToString("N0");
            ModelsGrid.ItemsSource = data.Models;
            DailyGrid.ItemsSource = data.Daily;
            var coverage = totals.UnpricedEvents > 0
                ? $" - {totals.UnpricedEvents:N0} unpriced records"
                : string.Empty;
            SummaryText.Text = $"{totals.Messages:N0} messages - {totals.EventCount:N0} usage records - {totals.SourceCount:N0} indexed files{coverage}";
            LastUpdatedText.Text = data.LastUpdatedMs > 0
                ? $"Index updated {DateTimeOffset.FromUnixTimeMilliseconds(data.LastUpdatedMs).ToLocalTime():g}"
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

    private void Collector_ProgressChanged(CollectorProgress progress)
    {
        Dispatcher.BeginInvoke(() =>
        {
            StatusText.Foreground = (System.Windows.Media.Brush)FindResource("MutedBrush");
            RefreshButton.IsEnabled = !progress.IsBusy;
            FullRescanButton.IsEnabled = !progress.IsBusy;
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
        Dispatcher.BeginInvoke(async () => await RefreshDashboardAsync());

    private void Collector_Error(string message) => Dispatcher.BeginInvoke(() => ShowError(message));

    private void ShowError(string message)
    {
        StatusText.Text = message;
        StatusText.Foreground = System.Windows.Media.Brushes.IndianRed;
    }

    private static string FormatCompact(long value)
    {
        return value switch
        {
            >= 1_000_000_000_000 => $"{value / 1_000_000_000_000d:0.##}T",
            >= 1_000_000_000 => $"{value / 1_000_000_000d:0.##}B",
            >= 1_000_000 => $"{value / 1_000_000d:0.##}M",
            >= 1_000 => $"{value / 1_000d:0.##}K",
            _ => value.ToString("N0")
        };
    }

    private static string FormatMoney(double value) =>
        value.ToString("C2", CultureInfo.GetCultureInfo("en-US"));

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
}
