using System.Collections.Concurrent;
using System.IO;

namespace TokenTracker;

public sealed record SourceRoot(string Path, string Client);

public sealed class UsageCollector : IDisposable
{
    private readonly UsageDatabase _database;
    private readonly UsageParser _parser;
    private readonly AppSettings _settings;
    private readonly IReadOnlyList<SourceRoot> _roots;
    private readonly ConcurrentDictionary<string, string> _pending = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<FileSystemWatcher> _watchers = [];
    private readonly HashSet<string> _watchedRoots = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _operationLock = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _watchLoop;
    private Task? _reconcileLoop;
    private bool _started;
    private bool _disposed;

    public UsageCollector(
        UsageDatabase database,
        AppSettings settings,
        UsageParser? parser = null,
        IEnumerable<SourceRoot>? roots = null)
    {
        _database = database;
        _settings = settings;
        _parser = parser ?? new UsageParser();
        _roots = (roots ?? DefaultRoots()).ToList();
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
        _watchLoop = WatchLoopAsync(_shutdown.Token);
        _reconcileLoop = ReconcileLoopAsync(_shutdown.Token);

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
    }

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
        yield return new SourceRoot(AppPaths.BenchResultsPath, "claude");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }

        // The process is exiting, and in-flight tasks may still unwind through their
        // finally blocks. Leaving these tiny synchronization objects for process cleanup
        // avoids a release-after-dispose race during shutdown.
    }
}
