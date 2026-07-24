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

    public static void EnsureDataDirectory() => Directory.CreateDirectory(DataDirectory);

    /// <summary>Expands the leading <c>~</c>, <c>%VAR%</c> and environment
    /// variables in a user-supplied extra scan root so settings.json can stay
    /// portable between machines.</summary>
    public static string ExpandUserPath(string path)
    {
        var expanded = Environment.ExpandEnvironmentVariables(path.Trim());
        if (expanded.StartsWith('~'))
        {
            expanded = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) +
                       expanded[1..];
        }

        return expanded;
    }
}
