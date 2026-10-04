using System.IO;
using System.Text.Json;

namespace TokenTracker;

/// <summary>
/// Counts Codex runs that save no session log. `codex exec --ephemeral` writes
/// no rollout under ~/.codex/sessions, and `--ignore-user-config` drops any
/// endpoint override, so neither the rollout parser nor a relay can see those
/// calls. Codex's rollout tracer still runs for them: with the user-level
/// CODEX_ROLLOUT_TRACE_ROOT pointing here, every Codex process started
/// afterwards writes one bundle per session (trace.jsonl plus a payloads/
/// folder), and each model call's token_usage lands in a response payload.
/// UsageParser bills those for sessions that have no rollout; sessions that do
/// have one are left to the rollout parser. Bundles repeat the full request on
/// every call, so <see cref="PruneAsync"/> drops what nothing reads.
/// </summary>
public static class CodexTraces
{
    public const string Client = "codex-trace";
    public const string EnvName = "CODEX_ROLLOUT_TRACE_ROOT";

    /// <summary>Codex writes each payload once, just before the trace line that
    /// references it; anything older than this has already been appended.</summary>
    private static readonly TimeSpan PayloadGrace = TimeSpan.FromMinutes(2);

    /// <summary>A process killed mid-run (a timed-out `codex exec`) never logs
    /// rollout_ended; its bundle is let go after this long without a write.</summary>
    private static readonly TimeSpan AbandonedAfter = TimeSpan.FromDays(1);

    /// <summary>Bundles that only mirror logged sessions hold nothing to bill,
    /// but a Codex Desktop thread can sit idle for days and still write again.</summary>
    private static readonly TimeSpan LoggedAbandonedAfter = TimeSpan.FromDays(7);

    // ----- environment ------------------------------------------------------

    /// <summary>Points new Codex processes at the trace folder. Returns null on
    /// success, or the existing value when the variable already points
    /// somewhere else — a trace the user set up must not be clobbered.</summary>
    public static string? SetEnvironment()
    {
        var current = Environment.GetEnvironmentVariable(EnvName, EnvironmentVariableTarget.User);
        if (current is not null && !IsOurs(current))
        {
            return current;
        }

        Directory.CreateDirectory(AppPaths.CodexTracesPath);
        if (current is null)
        {
            Environment.SetEnvironmentVariable(EnvName, AppPaths.CodexTracesPath, EnvironmentVariableTarget.User);
        }

        return null;
    }

    /// <summary>Removes the variable, but only when it is ours. Called only when
    /// the setting is turned off: an exit leaves it set, since a process only
    /// sees the variable if it started after it was set, and the tracker is
    /// often not the first thing up at login. Bundles written while the app is
    /// closed are indexed and pruned at the next start.</summary>
    public static void ClearEnvironment()
    {
        if (IsOurs(Environment.GetEnvironmentVariable(EnvName, EnvironmentVariableTarget.User)))
        {
            Environment.SetEnvironmentVariable(EnvName, null, EnvironmentVariableTarget.User);
        }
    }

    private static bool IsOurs(string? value) =>
        value is not null &&
        Path.TrimEndingDirectorySeparator(value.Trim()).Equals(
            AppPaths.CodexTracesPath, StringComparison.OrdinalIgnoreCase);

    // ----- pruning ----------------------------------------------------------

    /// <summary>Deletes finished bundles once their trace is fully indexed (the
    /// events stay in the database), and from live ones every payload nothing
    /// will read: requests, protocol events, and responses of logged sessions.
    /// Kept until the bundle goes: session metadata, which says whether a
    /// session is logged, and the responses of unlogged ones.</summary>
    public static async Task PruneAsync(UsageDatabase database, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(AppPaths.CodexTracesPath))
        {
            return;
        }

        foreach (var bundle in Directory.EnumerateDirectories(AppPaths.CodexTracesPath, "trace-*"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await PruneBundleAsync(database, bundle, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Codex still has a file open; the next pass retries.
            }
        }
    }

    private static async Task PruneBundleAsync(UsageDatabase database, string bundle, CancellationToken cancellationToken)
    {
        var tracePath = Path.Combine(bundle, "trace.jsonl");
        var now = DateTime.UtcNow;
        if (!File.Exists(tracePath))
        {
            if (now - Directory.GetLastWriteTimeUtc(bundle) > AbandonedAfter)
            {
                Directory.Delete(bundle, recursive: true);
            }

            return;
        }

        var scan = ScanBundle(bundle, tracePath);
        var idle = now - File.GetLastWriteTimeUtc(tracePath);
        var state = await database.GetSourceStateAsync(tracePath, cancellationToken).ConfigureAwait(false);
        var indexed = state is not null && state.ProcessedOffset >= new FileInfo(tracePath).Length;
        var billable = scan.Threads.Values.Any(logged => !logged);
        if (indexed && (scan.Ended || idle > (billable ? AbandonedAfter : LoggedAbandonedAfter)))
        {
            Directory.Delete(bundle, recursive: true);
            return;
        }

        foreach (var (relativePath, kind, threadId) in scan.Payloads)
        {
            if (kind == "session_metadata" ||
                (kind == "inference_response" &&
                 (threadId is null || !scan.Threads.TryGetValue(threadId, out var logged) || !logged)))
            {
                continue;
            }

            var payloadPath = Path.GetFullPath(Path.Combine(bundle, relativePath));
            if (payloadPath.StartsWith(bundle + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
                File.Exists(payloadPath) &&
                now - File.GetLastWriteTimeUtc(payloadPath) > PayloadGrace)
            {
                File.Delete(payloadPath);
            }
        }
    }

    private sealed record BundleScan(
        Dictionary<string, bool> Threads,
        List<(string Path, string Kind, string? ThreadId)> Payloads,
        bool Ended);

    /// <summary>Which sessions in a bundle are logged, and every payload the
    /// trace references with the session it belongs to.</summary>
    private static BundleScan ScanBundle(string bundle, string tracePath)
    {
        var threads = new Dictionary<string, bool>(StringComparer.Ordinal);
        var payloads = new List<(string, string, string?)>();
        var ended = false;
        using var stream = new FileStream(tracePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var type = String(payload, "type");
                var threadId = String(root, "thread_id") ?? String(payload, "thread_id");
                if (type == "rollout_ended")
                {
                    ended = true;
                }
                else if (type == "thread_started" && threadId is not null)
                {
                    threads[threadId] = IsLogged(bundle, payload);
                }

                foreach (var property in payload.EnumerateObject())
                {
                    if (property.Value.ValueKind == JsonValueKind.Object &&
                        String(property.Value, "path") is { } path &&
                        property.Value.TryGetProperty("kind", out var kind) &&
                        String(kind, "type") is { } kindType)
                    {
                        payloads.Add((path, kindType, threadId));
                    }
                }
            }
            catch (JsonException)
            {
                // A line cut off mid-write; the next pass sees it whole.
            }
        }

        return new BundleScan(threads, payloads, ended);
    }

    /// <summary>Whether Codex also wrote a session log for the thread a
    /// thread_started line announces — its metadata payload names the rollout
    /// path, null for an ephemeral run. Unreadable metadata counts as logged:
    /// a missed call is better than one billed twice.</summary>
    internal static bool IsLogged(string bundle, JsonElement threadStarted)
    {
        if (!threadStarted.TryGetProperty("metadata_payload", out var reference) ||
            String(reference, "path") is not { } relativePath)
        {
            return true;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(bundle, relativePath)));
            return document.RootElement.TryGetProperty("rollout_path", out var rolloutPath) &&
                   rolloutPath.ValueKind == JsonValueKind.String;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return true;
        }
    }

    private static string? String(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object &&
        parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
