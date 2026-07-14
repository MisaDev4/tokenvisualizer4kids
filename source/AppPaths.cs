namespace TokenTracker;

public static class AppPaths
{
    public static string DataDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker");

    public static string DatabasePath => Path.Combine(DataDirectory, "usage.db");

    public static string SettingsPath => Path.Combine(DataDirectory, "settings.json");

    public static string PricingCachePath => Path.Combine(DataDirectory, "pricing-litellm.json");

    public static string CodexSessionsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".codex",
        "sessions");

    public static string ClaudeProjectsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "projects");

    public static string ClaudeTranscriptsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".claude",
        "transcripts");

    // Docker bench trials run Claude Code against Bedrock inside containers;
    // the host runner streams each trial's stream-json events here.
    public static string BenchResultsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        "master",
        "production",
        "bench-results");

    public static void EnsureDataDirectory() => Directory.CreateDirectory(DataDirectory);
}
