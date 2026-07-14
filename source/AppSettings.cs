using System.Text.Json;
using Microsoft.Win32;

namespace TokenTracker;

public sealed class AppSettings
{
    public int ReconcileSeconds { get; set; } = 60;

    public bool StartWithWindows { get; set; }

    public string SelectedRange { get; set; } = "currentMonth";

    public string SelectedBars { get; set; } = "auto";

    public string SelectedTab { get; set; } = "dashboard";

    public string SelectedDashPanel { get; set; } = "models";

    public string SelectedLiveWindow { get; set; } = "w5";

    public string SelectedLiveMetric { get; set; } = "cost";

    public string HeatmapView { get; set; } = "year";

    public string HeatmapMetric { get; set; } = "tokens";

    public string InsightsRange { get; set; } = "last30";

    public bool HidePersonalData { get; set; }

    public static AppSettings Load()
    {
        AppPaths.EnsureDataDirectory();
        try
        {
            if (File.Exists(AppPaths.SettingsPath))
            {
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.SettingsPath))
                    ?? new AppSettings();
            }
        }
        catch
        {
            // Invalid settings fall back to safe defaults.
        }

        return new AppSettings();
    }

    public void Save()
    {
        AppPaths.EnsureDataDirectory();
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(AppPaths.SettingsPath, json);
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
