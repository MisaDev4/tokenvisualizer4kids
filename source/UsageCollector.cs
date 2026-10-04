using System.Collections.Concurrent;
using System.IO;

namespace TokenTracker;

/// <summary>A folder whose *.jsonl files are indexed. Roots flagged
/// <c>CoveredByDiscovery</c> sit under the user profile, where the single
/// profile-wide discovery watcher already sees every write — they are tailed
/// through it instead of each holding a FileSystemWatcher, since discovery can
/// accumulate hundreds of roots (one per agent-log run).</summary>
public sealed record SourceRoot(string Path, string Client, bool CoveredByDiscovery = false);

public sealed class UsageCollector : IDisposable
{
    private readonly UsageDatabase _database;
    private readonly UsageParser _parser;
    private readonly AppSettings _settings;
    private readonly TranscriptVault? _vault;
    private readonly List<SourceRoot> _roots;
    private readonly ConcurrentDictionary<string, string> _pending = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> _discoveryPending = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, long> _sniffRejected = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly HashSet<string> _watchedRoots = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _operationLock = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    // Snapshots the discovery watcher's thread can read while the worker mutates
    // the live collections under _operationLock.
    private volatile string[] _rootSnapshot = [];
    private volatile string[] _watchedRootSnapshot = [];
    private FileSystemWatcher? _discoveryWatcher;
    private Task? _watchLoop;
    private Task? _reconcileLoop;
    private Task? _discoveryLoop;
    private int _sweepScheduled;
    private bool _started;
    private bool _disposed;

    public UsageCollector(
        UsageDatabase database,
        AppSettings settings,
        UsageParser? parser = null,
        IEnumerable<SourceRoot>? roots = null,
        TranscriptVault? vault = null)
    {
        _database = database;
        _settings = settings;
        _vault = vault;
        _parser = parser ?? new UsageParser();
        // Roots adopted before the exclusion existed are dropped here; the next
        // settings save makes it stick.
        settings.DiscoveredSourceRoots.RemoveAll(root =>
            !string.IsNullOrWhiteSpace(root.Path) &&
            SourceDiscovery.IsExcludedLocation(AppPaths.ExpandUserPath(root.Path)));
        _roots = (roots ?? DefaultRoots()
                .Concat(ConfiguredRoots(settings.ExtraSourceRoots))
                .Concat(ConfiguredRoots(settings.DiscoveredSourceRoots).Select(MarkIfCoveredByDiscovery)))
            .Select(root => root with { Path = NormalizeDirectory(root.Path) })
            .ToList();
        PublishRootSnapshot();
    }

    public event Action<CollectorProgress>? ProgressChanged;
    public event Action? DataChanged;
    public event Action<string>? Error;

    public bool IsBusy { get; private set; }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_started)
        {
            return;
        }

        _started = true;
        await _database.InitializeAsync(cancellationToken).ConfigureAwait(false);
        EnsureWatchers();
        EnsureDiscoveryWatcher();
        _watchLoop = WatchLoopAsync(_shutdown.Token);
        _reconcileLoop = ReconcileLoopAsync(_shutdown.Token);
        _discoveryLoop = DiscoverySweepLoopAsync(_shutdown.Token);

        if (await _database.GetEventCountAsync(cancellationToken).ConfigureAwait(false) == 0)
        {
            await FullRescanAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await ReconcileAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public Task RefreshNowAsync(CancellationToken cancellationToken = default) =>
        ReconcileAsync(cancellationToken);

    public async Task FullRescanAsync(CancellationToken cancellationToken = default)
    {
        await _operationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        IsBusy = true;
        try
        {
            EnsureWatchers();
            var files = EnumerateFiles();
            Report(new CollectorProgress("Full rescan", 0, files.Count));

            for (var index = 0; index < files.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var (path, client) = files[index];
                Report(new CollectorProgress("Full rescan", index + 1, files.Count, path));
                await ScanFileAsync(path, client, forceFull: true, null, cancellationToken)
                    .ConfigureAwait(false);
            }

            Report(new CollectorProgress(
                files.Count == 0 ? "No Codex or Claude logs found" : "Full rescan complete",
                files.Count,
                files.Count,
                IsBusy: false));
            DataChanged?.Invoke();
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            Error?.Invoke($"Full rescan failed: {exception.Message}");
        }
        finally
        {
            IsBusy = false;
            _operationLock.Release();
        }
    }

    public async Task ReconcileAsync(CancellationToken cancellationToken = default)
    {
        await _operationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        IsBusy = true;
        try
        {
            EnsureWatchers();
            var states = await _database.GetSourceStatesAsync(cancellationToken).ConfigureAwait(false);
            var candidates = new List<(string Path, string Client, SourceFileState? State)>();

            foreach (var (path, client) in EnumerateFiles())
            {
                states.TryGetValue(path, out var state);
                var info = new FileInfo(path);
                if (state is null || info.Length != state.Length || info.LastWriteTimeUtc.Ticks != state.ModifiedTicks)
                {
                    candidates.Add((path, client, state));
                }
            }

            Report(new CollectorProgress("Checking for updates", 0, candidates.Count));
            for (var index = 0; index < candidates.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var candidate = candidates[index];
                Report(new CollectorProgress("Updating", index + 1, candidates.Count, candidate.Path));
                var forceFull = candidate.State is null ||
                                new FileInfo(candidate.Path).Length < candidate.State.ProcessedOffset ||
                                (new FileInfo(candidate.Path).Length == candidate.State.Length &&
                                 new FileInfo(candidate.Path).LastWriteTimeUtc.Ticks != candidate.State.ModifiedTicks);
                await ScanFileAsync(
                        candidate.Path,
                        candidate.Client,
                        forceFull,
                        candidate.State,
                        cancellationToken)
                    .ConfigureAwait(false);
            }

            if (_vault is not null)
            {
                await _vault.PruneAsync(cancellationToken).ConfigureAwait(false);
            }

            // Under the operation lock, so a bundle is never deleted mid-scan.
            await CodexTraces.PruneAsync(_database, cancellationToken).ConfigureAwait(false);

            Report(new CollectorProgress(
                candidates.Count == 0 ? "Up to date" : "Update complete",
                candidates.Count,
                candidates.Count,
                IsBusy: false));
            if (candidates.Count > 0)
            {
                DataChanged?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            Error?.Invoke($"Update failed: {exception.Message}");
        }
        finally
        {
            IsBusy = false;
            _operationLock.Release();
        }
    }

    private async Task ScanPendingAsync(CancellationToken cancellationToken)
    {
        if (_pending.IsEmpty || !await _operationLock.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        IsBusy = true;
        try
        {
            var work = new List<(string Path, string Client)>();
            foreach (var item in _pending)
            {
                if (_pending.TryRemove(item.Key, out var client))
                {
                    work.Add((item.Key, client));
                }
            }

            var changed = false;
            for (var index = 0; index < work.Count; index++)
            {
                var (path, client) = work[index];
                if (!File.Exists(path))
                {
                    continue;
                }

                Report(new CollectorProgress("Live update", index + 1, work.Count, path));
                var state = await _database.GetSourceStateAsync(path, cancellationToken).ConfigureAwait(false);
                var info = new FileInfo(path);
                var forceFull = state is null || info.Length < state.ProcessedOffset ||
                                (info.Length == state.Length && info.LastWriteTimeUtc.Ticks != state.ModifiedTicks);
                await ScanFileAsync(path, client, forceFull, state, cancellationToken).ConfigureAwait(false);
                changed = true;
            }

            Report(new CollectorProgress("Live", work.Count, work.Count, IsBusy: false));
            if (changed)
            {
                DataChanged?.Invoke();
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            Error?.Invoke($"Live update failed: {exception.Message}");
        }
        finally
        {
            IsBusy = false;
            _operationLock.Release();
        }
    }

    private async Task ScanFileAsync(
        string path,
        string client,
        bool forceFull,
        SourceFileState? existing,
        CancellationToken cancellationToken)
    {
        try
        {
            var startOffset = forceFull ? 0 : existing?.ProcessedOffset ?? 0;
            var parserState = forceFull ? null : existing?.ParserStateJson;
            var result = await _parser.ParseFileAsync(path, client, startOffset, parserState, cancellationToken)
                .ConfigureAwait(false);
            var info = new FileInfo(path);
            var state = new SourceFileState(
                path,
                client,
                info.Length,
                info.LastWriteTimeUtc.Ticks,
                result.ProcessedOffset,
                result.ParserStateJson,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            if (forceFull)
            {
                await _database.ReplaceFileEventsAsync(state, result.Events, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await _database.AppendFileEventsAsync(state, result.Events, cancellationToken).ConfigureAwait(false);
            }

            // Same bytes the parser just consumed, copied while the file still
            // exists — some harnesses delete a session log seconds after writing it.
            // A Codex trace is no transcript, and its bundle is pruned on purpose.
            if (_vault is not null && client != CodexTraces.Client)
            {
                await _vault.CaptureAsync(path, client, startOffset, result.ProcessedOffset, forceFull, cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        catch (IOException)
        {
            _pending[path] = client;
        }
        catch (UnauthorizedAccessException)
        {
            _pending[path] = client;
        }
    }

    private async Task WatchLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(750, cancellationToken).ConfigureAwait(false);
                await ProcessDiscoveryAsync(cancellationToken).ConfigureAwait(false);
                await ScanPendingAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task ReconcileLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var seconds = Math.Clamp(_settings.ReconcileSeconds, 10, 3600);
                await Task.Delay(TimeSpan.FromSeconds(seconds), cancellationToken).ConfigureAwait(false);
                await ReconcileAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private List<(string Path, string Client)> EnumerateFiles()
    {
        var results = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in _roots)
        {
            if (!Directory.Exists(root.Path))
            {
                continue;
            }

            try
            {
                foreach (var path in Directory.EnumerateFiles(root.Path, "*.jsonl", SearchOption.AllDirectories))
                {
                    results[Path.GetFullPath(path)] = root.Client;
                }
            }
            catch (UnauthorizedAccessException)
            {
                // Other configured roots can still be indexed.
            }
            catch (DirectoryNotFoundException)
            {
                // A root may disappear while the filesystem is being enumerated.
            }
        }

        return results.Select(item => (item.Key, item.Value)).OrderBy(item => item.Key).ToList();
    }

    private void EnsureWatchers()
    {
        foreach (var root in _roots)
        {
            if (root.CoveredByDiscovery)
            {
                continue;
            }

            var fullPath = Path.GetFullPath(root.Path);
            if (!Directory.Exists(fullPath) || !_watchedRoots.Add(fullPath))
            {
                continue;
            }

            try
            {
                var watcher = new FileSystemWatcher(fullPath, "*.jsonl")
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size |
                                   NotifyFilters.CreationTime,
                    InternalBufferSize = 64 * 1024,
                    EnableRaisingEvents = true
                };
                watcher.Created += (_, args) => Queue(args.FullPath, root.Client);
                watcher.Changed += (_, args) => Queue(args.FullPath, root.Client);
                watcher.Renamed += (_, args) => Queue(args.FullPath, root.Client);
                watcher.Error += (_, _) => _ = Task.Run(() => ReconcileAsync(_shutdown.Token));
                _watchers.Add(watcher);
            }
            catch (IOException)
            {
                _watchedRoots.Remove(fullPath);
            }
        }

        _watchedRootSnapshot = _watchedRoots.ToArray();
    }

    /// <summary>One profile-wide *.jsonl watcher so a usage log appearing in a
    /// brand-new place is noticed the moment it is written, not on the next
    /// sweep. Files under already-watched roots are dropped here — the per-root
    /// watchers own those events.</summary>
    private void EnsureDiscoveryWatcher()
    {
        if (_discoveryWatcher is not null || !_settings.AutoDiscoverSources ||
            !Directory.Exists(SourceDiscovery.DiscoveryBase))
        {
            return;
        }

        try
        {
            var watcher = new FileSystemWatcher(SourceDiscovery.DiscoveryBase, "*.jsonl")
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size |
                               NotifyFilters.CreationTime,
                InternalBufferSize = 256 * 1024,
                EnableRaisingEvents = true
            };
            watcher.Created += (_, args) => QueueDiscovery(args.FullPath);
            watcher.Changed += (_, args) => QueueDiscovery(args.FullPath);
            watcher.Renamed += (_, args) => QueueDiscovery(args.FullPath);
            // The whole-profile buffer overflows during file churn storms; the
            // debounced sweep re-finds anything the watcher dropped.
            watcher.Error += (_, _) => ScheduleSweep();
            _discoveryWatcher = watcher;
        }
        catch (IOException)
        {
        }
    }

    private void QueueDiscovery(string path)
    {
        if (!path.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var fullPath = Path.GetFullPath(path);
        if (!IsUnderAny(fullPath, _watchedRootSnapshot) && !SourceDiscovery.IsExcludedLocation(fullPath))
        {
            _discoveryPending[fullPath] = 1;
        }
    }

    private async Task ProcessDiscoveryAsync(CancellationToken cancellationToken)
    {
        if (_discoveryPending.IsEmpty ||
            !await _operationLock.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        try
        {
            foreach (var item in _discoveryPending)
            {
                if (!_discoveryPending.TryRemove(item.Key, out _))
                {
                    continue;
                }

                var path = item.Key;
                if (!File.Exists(path))
                {
                    continue;
                }

                var owner = FindOwningRoot(path);
                if (owner is not null)
                {
                    // A configured root that was missing at startup just came to
                    // life; attach its watcher now instead of waiting a minute.
                    // Discovery-covered roots stay on this path permanently.
                    if (!owner.CoveredByDiscovery)
                    {
                        EnsureWatchers();
                    }

                    _pending[path] = owner.Client;
                    continue;
                }

                if (!_settings.AutoDiscoverSources)
                {
                    continue;
                }

                long length;
                try
                {
                    length = new FileInfo(path).Length;
                }
                catch (IOException)
                {
                    continue;
                }

                // A transcript with no billable line yet is re-sniffed on growth;
                // one already rejected at this exact size is settled.
                if (_sniffRejected.TryGetValue(path, out var rejectedAt) && rejectedAt == length)
                {
                    continue;
                }

                var client = SourceDiscovery.SniffClient(path);
                if (client is null)
                {
                    _sniffRejected[path] = length;
                    continue;
                }

                _sniffRejected.TryRemove(path, out _);
                var rootPath = NormalizeDirectory(Path.GetDirectoryName(path)!);
                _roots.Add(new SourceRoot(rootPath, client, CoveredByDiscovery: true));
                PublishRootSnapshot();
                _settings.AddDiscoveredRoot(rootPath, client);

                foreach (var sibling in Directory.EnumerateFiles(rootPath, "*.jsonl", SearchOption.AllDirectories))
                {
                    _pending[Path.GetFullPath(sibling)] = client;
                }

                Report(new CollectorProgress($"Now tracking {rootPath}", 0, 0, path, IsBusy: false));
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Error?.Invoke($"Source discovery failed: {exception.Message}");
        }
        finally
        {
            _operationLock.Release();
        }
    }

    private async Task DiscoverySweepLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            // The first sweep runs shortly after startup so the initial scan can
            // settle; later ones are a backstop for watcher overflows.
            var delay = TimeSpan.FromSeconds(30);
            while (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                delay = TimeSpan.FromMinutes(15);
                await Task.Run(() => SweepForNewSources(cancellationToken), cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private void ScheduleSweep()
    {
        if (Interlocked.Exchange(ref _sweepScheduled, 1) == 1)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(30), _shutdown.Token).ConfigureAwait(false);
                SweepForNewSources(_shutdown.Token);
            }
            catch (OperationCanceledException)
            {
            }
            finally
            {
                Interlocked.Exchange(ref _sweepScheduled, 0);
            }
        });
    }

    private void SweepForNewSources(CancellationToken cancellationToken)
    {
        if (!_settings.AutoDiscoverSources)
        {
            return;
        }

        foreach (var path in SourceDiscovery.EnumerateCandidates(
                     directory => IsUnderAny(directory, _rootSnapshot)))
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return;
            }

            if (IsUnderAny(path, _rootSnapshot))
            {
                continue;
            }

            _discoveryPending[path] = 1;
        }
    }

    private SourceRoot? FindOwningRoot(string fullPath)
    {
        foreach (var root in _roots)
        {
            if (fullPath.StartsWith(root.Path + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                return root;
            }
        }

        return null;
    }

    private void PublishRootSnapshot() => _rootSnapshot = _roots.Select(root => root.Path).ToArray();

    private static SourceRoot MarkIfCoveredByDiscovery(SourceRoot root)
    {
        var fullPath = Path.GetFullPath(root.Path);
        var coveredByProfileWatcher = fullPath.StartsWith(
            SourceDiscovery.DiscoveryBase + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
        return root with { CoveredByDiscovery = coveredByProfileWatcher };
    }

    private static bool IsUnderAny(string fullPath, string[] roots)
    {
        foreach (var root in roots)
        {
            if (fullPath.Length >= root.Length &&
                fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) &&
                (fullPath.Length == root.Length || fullPath[root.Length] == Path.DirectorySeparatorChar))
            {
                return true;
            }
        }

        return false;
    }

    private static string NormalizeDirectory(string path) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));

    private void Queue(string path, string client)
    {
        if (path.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase))
        {
            _pending[Path.GetFullPath(path)] = client;
        }
    }

    private void Report(CollectorProgress progress) => ProgressChanged?.Invoke(progress);

    private static IEnumerable<SourceRoot> DefaultRoots()
    {
        yield return new SourceRoot(AppPaths.CodexSessionsPath, "codex");
        yield return new SourceRoot(AppPaths.ClaudeProjectsPath, "claude");
        yield return new SourceRoot(AppPaths.ClaudeTranscriptsPath, "claude");
        yield return new SourceRoot(AppPaths.CodexTracesPath, CodexTraces.Client);
    }

    /// <summary>Extra folders from settings.json, for harnesses that write
    /// Claude- or Codex-shaped JSONL somewhere other than the standard
    /// locations — a container runner streaming stream-json to a results
    /// folder, an agent pinned to its own CLAUDE_CONFIG_DIR, a bridge that
    /// runs with session persistence off and keeps its own usage log.
    /// Roots that don't exist are skipped, so a stale entry is harmless.</summary>
    private static IEnumerable<SourceRoot> ConfiguredRoots(IEnumerable<ExtraSourceRoot>? roots) =>
        (roots ?? [])
            .Where(root => !string.IsNullOrWhiteSpace(root.Path))
            .Select(root => new SourceRoot(
                AppPaths.ExpandUserPath(root.Path),
                string.IsNullOrWhiteSpace(root.Client) ? "claude" : root.Client.Trim()));

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
        _discoveryWatcher?.Dispose();
        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }

        // The process is exiting, and in-flight tasks may still unwind through their
        // finally blocks. Leaving these tiny synchronization objects for process cleanup
        // avoids a release-after-dispose race during shutdown.
    }
}
