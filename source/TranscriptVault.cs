using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace TokenTracker;

/// <summary>One transcript the vault holds a copy of. <c>VaultedOffset</c> is
/// how far into the source the copy reaches; <c>MissingSinceMs</c> is set the
/// first time a prune finds the source gone, which is also when the raw copy
/// is compressed.</summary>
public sealed record VaultEntry(
    string SourcePath,
    string Client,
    string VaultName,
    long VaultedOffset,
    long LastAppendMs,
    long? MissingSinceMs,
    long Bytes);

/// <summary>
/// Keeps a copy of young transcripts so a Live block still opens after its log
/// is deleted. Some harnesses write a whole session file and unlink it seconds
/// later (a Discord bot's <c>--fork-session</c> narrator probes and refusal
/// rewinds do this hundreds of times a day); the index keeps the blocks, and
/// without a copy every one of them opened to "the log is gone".
///
/// The collector tees the byte range it just parsed into
/// <c>transcript-vault\{sha1(path)}.jsonl</c>. A copy is only started for a
/// file created in the last day — an old session is not about to vanish, and
/// vaulting a full rescan would duplicate gigabytes. Each reconcile prunes:
/// a copy whose source has survived a day is dropped, a copy whose source is
/// gone is gzipped and kept, subject to an age and a total-size cap.
/// </summary>
public sealed class TranscriptVault
{
    private const long KeepAliveMs = 24 * 3_600_000L;
    private static readonly TimeSpan YoungEnough = TimeSpan.FromHours(24);

    private readonly UsageDatabase _database;
    private readonly AppSettings _settings;
    private readonly string _root;

    public TranscriptVault(UsageDatabase database, AppSettings settings, string? root = null)
    {
        _database = database;
        _settings = settings;
        _root = root ?? AppPaths.TranscriptVaultPath;
    }

    public string Root => _root;

    /// <summary>Copies <c>[startOffset, endOffset)</c> of the source into its
    /// vault file, right after the parser consumed the same bytes. Never
    /// throws: a source that vanished between parse and copy just leaves the
    /// copy where it was.</summary>
    public async Task CaptureAsync(
        string sourcePath,
        string client,
        long startOffset,
        long endOffset,
        bool fromScratch,
        CancellationToken cancellationToken = default)
    {
        if (!_settings.TranscriptVaultEnabled || endOffset <= 0 || IsInsideVault(sourcePath))
        {
            return;
        }

        try
        {
            var entry = await _database.GetVaultEntryAsync(sourcePath, cancellationToken).ConfigureAwait(false);
            if (entry is null)
            {
                var created = File.GetCreationTimeUtc(sourcePath);
                if (DateTime.UtcNow - created > YoungEnough)
                {
                    return;
                }
            }

            var name = entry?.VaultName ?? NameFor(sourcePath);
            var rawPath = RawPath(name);
            var copyFrom = entry is null || fromScratch || entry.MissingSinceMs is not null ||
                           entry.VaultedOffset != startOffset || !File.Exists(rawPath)
                ? 0
                : startOffset;
            if (copyFrom >= endOffset && entry is not null && entry.MissingSinceMs is null)
            {
                return;
            }

            Directory.CreateDirectory(_root);
            TryDelete(GzPath(name));

            await using (var source = new FileStream(
                             sourcePath, FileMode.Open, FileAccess.Read,
                             FileShare.ReadWrite | FileShare.Delete, 64 * 1024,
                             FileOptions.Asynchronous | FileOptions.SequentialScan))
            await using (var target = new FileStream(
                             rawPath, copyFrom == 0 ? FileMode.Create : FileMode.Append,
                             FileAccess.Write, FileShare.Read, 64 * 1024, FileOptions.Asynchronous))
            {
                var length = Math.Min(endOffset, source.Length);
                source.Seek(copyFrom, SeekOrigin.Begin);
                await CopyRangeAsync(source, target, length - copyFrom, cancellationToken).ConfigureAwait(false);
            }

            await _database.UpsertVaultEntryAsync(new VaultEntry(
                    sourcePath, client, name, endOffset,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null,
                    new FileInfo(rawPath).Length), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            // Vaulting is best-effort; the index itself is never held up by it.
        }
    }

    /// <summary>Drops copies whose source is stable, compresses and keeps
    /// copies whose source is gone, and enforces the age and size caps.</summary>
    public async Task PruneAsync(CancellationToken cancellationToken = default)
    {
        List<VaultEntry> entries;
        try
        {
            entries = await _database.GetVaultEntriesAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var missing = new List<VaultEntry>();
        foreach (var entry in entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (File.Exists(entry.SourcePath))
                {
                    if (entry.MissingSinceMs is not null)
                    {
                        // The source came back (restored, or a name reused): the
                        // next capture restarts the copy from byte zero.
                        await _database.UpsertVaultEntryAsync(
                            entry with { MissingSinceMs = null }, cancellationToken).ConfigureAwait(false);
                    }
                    else if (now - entry.LastAppendMs > KeepAliveMs || !_settings.TranscriptVaultEnabled)
                    {
                        await RemoveAsync(entry, cancellationToken).ConfigureAwait(false);
                    }

                    continue;
                }

                if (entry.MissingSinceMs is null)
                {
                    var compressed = await CompressAsync(entry, now, cancellationToken).ConfigureAwait(false);
                    if (compressed is null)
                    {
                        await RemoveAsync(entry, cancellationToken).ConfigureAwait(false);
                        continue;
                    }

                    missing.Add(compressed);
                }
                else
                {
                    missing.Add(entry);
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                // One bad entry must not stop the sweep.
            }
        }

        // Oldest loss first, so the caps always evict the stalest copies.
        missing.Sort((left, right) => (left.MissingSinceMs ?? 0).CompareTo(right.MissingSinceMs ?? 0));
        var keepDays = Math.Clamp(_settings.TranscriptVaultKeepDays, 1, 3650);
        var maxBytes = Math.Clamp(_settings.TranscriptVaultMaxMb, 16, 1_000_000) * 1024L * 1024L;
        var total = missing.Sum(entry => entry.Bytes);
        foreach (var entry in missing)
        {
            var expired = now - (entry.MissingSinceMs ?? now) > keepDays * 86_400_000L;
            if (!expired && total <= maxBytes)
            {
                break;
            }

            try
            {
                await RemoveAsync(entry, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
            }

            total -= entry.Bytes;
        }

        SweepStrays(entries);
    }

    /// <summary>Path of a readable copy of a vanished transcript, or null when
    /// the vault never had it. The copy is written under the vault's
    /// <c>open</c> folder with the source's file name, so lookups keyed by the
    /// session id in the name (request captures) still resolve.</summary>
    public async Task<string?> MaterializeAsync(string sourcePath, CancellationToken cancellationToken = default)
    {
        var entry = await _database.GetVaultEntryAsync(sourcePath, cancellationToken).ConfigureAwait(false);
        if (entry is null)
        {
            return null;
        }

        var rawPath = RawPath(entry.VaultName);
        var gzPath = GzPath(entry.VaultName);
        var openDirectory = Path.Combine(_root, "open", entry.VaultName[..12]);
        var openPath = Path.Combine(openDirectory, Path.GetFileName(sourcePath));
        Directory.CreateDirectory(openDirectory);

        if (File.Exists(rawPath))
        {
            File.Copy(rawPath, openPath, overwrite: true);
            return openPath;
        }

        if (!File.Exists(gzPath))
        {
            return null;
        }

        await using var input = new FileStream(gzPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        await using var gzip = new GZipStream(input, CompressionMode.Decompress);
        await using var output = new FileStream(openPath, FileMode.Create, FileAccess.Write, FileShare.Read);
        await gzip.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        return openPath;
    }

    private async Task<VaultEntry?> CompressAsync(VaultEntry entry, long now, CancellationToken cancellationToken)
    {
        var rawPath = RawPath(entry.VaultName);
        var gzPath = GzPath(entry.VaultName);
        if (!File.Exists(rawPath))
        {
            if (!File.Exists(gzPath))
            {
                return null;
            }

            var kept = entry with { MissingSinceMs = now, Bytes = new FileInfo(gzPath).Length };
            await _database.UpsertVaultEntryAsync(kept, cancellationToken).ConfigureAwait(false);
            return kept;
        }

        await using (var input = new FileStream(rawPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        await using (var output = new FileStream(gzPath, FileMode.Create, FileAccess.Write, FileShare.None))
        await using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
        {
            await input.CopyToAsync(gzip, cancellationToken).ConfigureAwait(false);
        }

        TryDelete(rawPath);
        var compressed = entry with { MissingSinceMs = now, Bytes = new FileInfo(gzPath).Length };
        await _database.UpsertVaultEntryAsync(compressed, cancellationToken).ConfigureAwait(false);
        return compressed;
    }

    private async Task RemoveAsync(VaultEntry entry, CancellationToken cancellationToken)
    {
        TryDelete(RawPath(entry.VaultName));
        TryDelete(GzPath(entry.VaultName));
        await _database.DeleteVaultEntryAsync(entry.SourcePath, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Files the table no longer knows about (a crash between the copy
    /// and the row) and stale materialized copies are removed once a day old.</summary>
    private void SweepStrays(List<VaultEntry> entries)
    {
        try
        {
            if (!Directory.Exists(_root))
            {
                return;
            }

            var known = new HashSet<string>(entries.Select(entry => entry.VaultName), StringComparer.OrdinalIgnoreCase);
            var cutoff = DateTime.UtcNow - TimeSpan.FromDays(1);
            foreach (var file in Directory.EnumerateFiles(_root, "*.jsonl*", SearchOption.TopDirectoryOnly))
            {
                var name = Path.GetFileName(file);
                var dot = name.IndexOf('.');
                var stem = dot > 0 ? name[..dot] : name;
                if (!known.Contains(stem) && File.GetLastWriteTimeUtc(file) < cutoff)
                {
                    TryDelete(file);
                }
            }

            var open = Path.Combine(_root, "open");
            if (Directory.Exists(open))
            {
                foreach (var directory in Directory.EnumerateDirectories(open))
                {
                    if (Directory.GetLastWriteTimeUtc(directory) < cutoff)
                    {
                        try
                        {
                            Directory.Delete(directory, recursive: true);
                        }
                        catch (Exception)
                        {
                        }
                    }
                }
            }
        }
        catch (Exception)
        {
        }
    }

    private static async Task CopyRangeAsync(Stream source, Stream target, long count, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];
        while (count > 0)
        {
            var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, count)), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            count -= read;
        }
    }

    /// <summary>Discovery must never adopt the vault as a source root, and if it
    /// somehow does, a copy is never copied again.</summary>
    private bool IsInsideVault(string path) =>
        Path.GetFullPath(path).StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private string RawPath(string name) => Path.Combine(_root, name + ".jsonl");

    private string GzPath(string name) => Path.Combine(_root, name + ".jsonl.gz");

    public static string NameFor(string sourcePath) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(
            Path.GetFullPath(sourcePath).ToLowerInvariant()))).ToLowerInvariant();

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception)
        {
        }
    }
}
