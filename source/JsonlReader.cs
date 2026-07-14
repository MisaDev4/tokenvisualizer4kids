using System.Buffers;

namespace TokenTracker;

internal static class JsonlReader
{
    private const int BufferSize = 64 * 1024;

    public static async Task<long> ReadCompleteLinesAsync(
        string path,
        long startOffset,
        Func<ReadOnlyMemory<byte>, ValueTask> onLine,
        CancellationToken cancellationToken = default)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            BufferSize,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        startOffset = Math.Clamp(startOffset, 0, stream.Length);
        stream.Seek(startOffset, SeekOrigin.Begin);

        var buffer = ArrayPool<byte>.Shared.Rent(BufferSize);
        var partialLine = new ArrayBufferWriter<byte>();
        var committedOffset = startOffset;

        try
        {
            while (true)
            {
                var chunkStart = stream.Position;
                var bytesRead = await stream.ReadAsync(buffer.AsMemory(0, BufferSize), cancellationToken);
                if (bytesRead == 0)
                {
                    break;
                }

                var segmentStart = 0;
                for (var index = 0; index < bytesRead; index++)
                {
                    if (buffer[index] != (byte)'\n')
                    {
                        continue;
                    }

                    var segmentLength = index - segmentStart;
                    if (partialLine.WrittenCount == 0)
                    {
                        await onLine(buffer.AsMemory(segmentStart, segmentLength));
                    }
                    else
                    {
                        partialLine.Write(buffer.AsSpan(segmentStart, segmentLength));
                        await onLine(partialLine.WrittenMemory);
                        partialLine.Clear();
                    }

                    committedOffset = chunkStart + index + 1;
                    segmentStart = index + 1;
                }

                if (segmentStart < bytesRead)
                {
                    partialLine.Write(buffer.AsSpan(segmentStart, bytesRead - segmentStart));
                }
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }

        // A final non-newline-terminated record may still be in the process of being
        // written. It is intentionally left uncommitted for the next incremental pass.
        return committedOffset;
    }
}
