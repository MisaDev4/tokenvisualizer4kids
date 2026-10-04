using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TokenTracker;

/// <summary>One distinct request context seen for a session: the system prompt
/// and tool schemas exactly as they went to the API. A session usually has one;
/// subagents add their own, so a session keeps a short list of distinct ones.</summary>
public sealed record RequestCapture(
    string Hash,
    string? Model,
    long CapturedMs,
    string SystemPrompt,
    IReadOnlyList<string> ToolNames,
    string ToolsJson);

/// <summary>
/// A local pass-through relay for the Anthropic API. Claude Code is pointed at
/// it via ANTHROPIC_BASE_URL; every request is forwarded to api.anthropic.com
/// byte-for-byte (responses stream straight through, so SSE works), and the
/// parts Claude Code never writes to its transcripts — the system prompt and
/// the tool schemas — are captured per session for the transcript viewer.
/// Auth headers pass through untouched and are never written to disk.
/// </summary>
public sealed class RequestCaptureProxy : IDisposable
{
    public const int DefaultPort = 5298;
    private const string DefaultUpstream = "https://api.anthropic.com";
    private const string EnvName = "ANTHROPIC_BASE_URL";

    private readonly string _upstream;

    public RequestCaptureProxy(string? upstream = null) =>
        _upstream = (upstream ?? DefaultUpstream).TrimEnd('/');

    private static readonly Regex SessionIdPattern = new(
        "session_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
        RegexOptions.Compiled);

    private static readonly string[] HopByHopRequestHeaders =
    [
        "Host", "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length",
        "Expect", "Proxy-Connection", "Upgrade"
    ];

    private static readonly string[] HopByHopResponseHeaders =
    [
        "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length"
    ];

    private readonly HttpClient _client = new(new SocketsHttpHandler
    {
        // Compressed bodies are relayed verbatim with their Content-Encoding
        // header, so the client decodes exactly what the API sent.
        AutomaticDecompression = DecompressionMethods.None,
        AllowAutoRedirect = false
    })
    {
        // Streaming responses stay open as long as a turn runs.
        Timeout = Timeout.InfiniteTimeSpan
    };

    /// <summary>Capture hashes already persisted this run, so a session's file
    /// is written once per distinct request shape rather than once per turn.</summary>
    private readonly Dictionary<string, HashSet<string>> _seen = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _storeLock = new();

    private HttpListener? _listener;

    public int Port { get; private set; }

    public string? Error { get; private set; }

    public bool IsRunning => _listener?.IsListening == true;

    public bool Start(int port)
    {
        Stop();
        if (port is < 1 or > 65535)
        {
            port = DefaultPort;
        }

        var listener = new HttpListener();
        listener.Prefixes.Add($"http://localhost:{port}/");
        try
        {
            listener.Start();
        }
        catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
        {
            Error = exception.Message;
            return false;
        }

        Port = port;
        Error = null;
        _listener = listener;
        _ = Task.Run(() => ListenLoopAsync(listener));
        _ = Task.Run(PruneOldCaptures);
        return true;
    }

    public void Stop()
    {
        var listener = _listener;
        _listener = null;
        if (listener is null)
        {
            return;
        }

        try
        {
            listener.Stop();
            listener.Close();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    public void Dispose()
    {
        Stop();
        _client.Dispose();
    }

    // ----- environment ------------------------------------------------------

    /// <summary>Points new processes at the relay. Returns null on success, or
    /// the existing ANTHROPIC_BASE_URL when one is already set somewhere else —
    /// a custom routing this app must not clobber.</summary>
    public static string? SetEnvironment(int port)
    {
        var current = Environment.GetEnvironmentVariable(EnvName, EnvironmentVariableTarget.User);
        if (current is not null && !PointsAtLocalProxy(current))
        {
            return current;
        }

        Environment.SetEnvironmentVariable(EnvName, $"http://localhost:{port}", EnvironmentVariableTarget.User);
        return null;
    }

    /// <summary>Removes the variable, but only when it is ours — so turning the
    /// toggle off can never delete a value the user set for other reasons.</summary>
    public static void ClearEnvironment()
    {
        var current = Environment.GetEnvironmentVariable(EnvName, EnvironmentVariableTarget.User);
        if (PointsAtLocalProxy(current))
        {
            Environment.SetEnvironmentVariable(EnvName, null, EnvironmentVariableTarget.User);
        }
    }

    private static bool PointsAtLocalProxy(string? value) =>
        value is not null &&
        Regex.IsMatch(value.Trim(), @"^http://(localhost|127\.0\.0\.1):\d+/?$", RegexOptions.IgnoreCase);

    // ----- relay ------------------------------------------------------------

    private async Task ListenLoopAsync(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception exception) when (
                exception is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }

            _ = Task.Run(() => RelayAsync(context));
        }
    }

    private async Task RelayAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        try
        {
            var body = Array.Empty<byte>();
            if (request.HasEntityBody)
            {
                using var buffer = new MemoryStream();
                await request.InputStream.CopyToAsync(buffer).ConfigureAwait(false);
                body = buffer.ToArray();
            }

            Capture(request, body);

            using var upstreamRequest = new HttpRequestMessage(
                new HttpMethod(request.HttpMethod),
                _upstream + request.RawUrl);
            if (body.Length > 0 ||
                (request.HttpMethod != "GET" && request.HttpMethod != "HEAD"))
            {
                upstreamRequest.Content = new ByteArrayContent(body);
            }

            foreach (string? name in request.Headers.AllKeys)
            {
                if (name is null || HopByHopRequestHeaders.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    continue;
                }

                var value = request.Headers[name];
                if (value is not null && !upstreamRequest.Headers.TryAddWithoutValidation(name, value))
                {
                    upstreamRequest.Content?.Headers.TryAddWithoutValidation(name, value);
                }
            }

            using var upstreamResponse = await _client
                .SendAsync(upstreamRequest, HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(false);

            response.StatusCode = (int)upstreamResponse.StatusCode;
            foreach (var header in upstreamResponse.Headers.Concat(upstreamResponse.Content.Headers))
            {
                if (HopByHopResponseHeaders.Contains(header.Key, StringComparer.OrdinalIgnoreCase))
                {
                    continue;
                }

                foreach (var value in header.Value)
                {
                    try
                    {
                        response.AppendHeader(header.Key, value);
                    }
                    catch (ArgumentException)
                    {
                        // A header HttpListener insists on managing itself.
                    }
                }
            }

            if (upstreamResponse.Content.Headers.ContentLength is { } length)
            {
                response.ContentLength64 = length;
            }
            else
            {
                response.SendChunked = true;
            }

            // Flush per chunk: the whole point is that SSE events reach the
            // client the moment the API emits them, not when the turn ends.
            await using var stream = await upstreamResponse.Content.ReadAsStreamAsync().ConfigureAwait(false);
            var chunk = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(chunk).ConfigureAwait(false)) > 0)
            {
                await response.OutputStream.WriteAsync(chunk.AsMemory(0, read)).ConfigureAwait(false);
                await response.OutputStream.FlushAsync().ConfigureAwait(false);
            }

            response.Close();
        }
        catch (HttpRequestException exception)
        {
            TryAnswerUpstreamFailure(response, _upstream, exception.Message);
        }
        catch (TaskCanceledException exception)
        {
            TryAnswerUpstreamFailure(response, _upstream, exception.Message);
        }
        catch (Exception exception) when (
            exception is HttpListenerException or ObjectDisposedException or IOException
                or InvalidOperationException)
        {
            // The client hung up or the listener stopped mid-stream.
            try
            {
                response.Abort();
            }
            catch
            {
            }
        }
    }

    private static void TryAnswerUpstreamFailure(HttpListenerResponse response, string upstream, string message)
    {
        try
        {
            response.StatusCode = 502;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new
            {
                type = "error",
                error = new { type = "api_error", message = $"TokenTracker relay could not reach {upstream}: {message}" }
            });
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes);
            response.Close();
        }
        catch
        {
        }
    }

    // ----- capture ----------------------------------------------------------

    private void Capture(HttpListenerRequest request, byte[] body)
    {
        if (body.Length == 0 ||
            !string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) ||
            request.RawUrl is not { } path ||
            !path.Contains("/v1/messages", StringComparison.OrdinalIgnoreCase) ||
            path.Contains("count_tokens", StringComparison.OrdinalIgnoreCase) ||
            request.Headers["Content-Encoding"] is not null)
        {
            return;
        }

        // Off the relay's hot path; a capture failure must never cost a request.
        _ = Task.Run(() =>
        {
            try
            {
                CaptureBody(body);
            }
            catch (Exception exception) when (exception is JsonException or IOException
                                                  or UnauthorizedAccessException or InvalidOperationException
                                                  or ArgumentException)
            {
            }
        });
    }

    private void CaptureBody(byte[] body)
    {
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var systemPrompt = SystemText(root);
        var toolNames = new List<string>();
        var toolsJson = "";
        if (root.TryGetProperty("tools", out var tools) && tools.ValueKind == JsonValueKind.Array)
        {
            foreach (var tool in tools.EnumerateArray())
            {
                if (tool.ValueKind == JsonValueKind.Object &&
                    tool.TryGetProperty("name", out var name) &&
                    name.ValueKind == JsonValueKind.String)
                {
                    toolNames.Add(name.GetString() ?? "");
                }
            }

            toolsJson = JsonSerializer.Serialize(tools, new JsonSerializerOptions { WriteIndented = true });
        }

        if (systemPrompt.Length == 0 && toolNames.Count == 0)
        {
            return;
        }

        var sessionId = "unmatched";
        if (root.TryGetProperty("metadata", out var metadata) &&
            metadata.ValueKind == JsonValueKind.Object &&
            metadata.TryGetProperty("user_id", out var userId) &&
            userId.ValueKind == JsonValueKind.String &&
            SessionIdFrom(userId.GetString() ?? "") is { } found)
        {
            sessionId = found;
        }

        var model = root.TryGetProperty("model", out var modelValue) &&
                    modelValue.ValueKind == JsonValueKind.String
            ? modelValue.GetString()
            : null;

        var hash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(systemPrompt + ' ' + toolsJson)))[..16];

        lock (_storeLock)
        {
            var seen = _seen.TryGetValue(sessionId, out var hashes)
                ? hashes
                : _seen[sessionId] = [];
            if (!seen.Add(hash))
            {
                return;
            }

            RequestCaptureStore.Append(sessionId, new RequestCapture(
                hash, model, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                systemPrompt, toolNames, toolsJson));
        }
    }

    /// <summary>The session a request belongs to, from metadata.user_id. Claude
    /// Code 2.1.2xx sends a JSON string ({"device_id":…,"session_id":"…"});
    /// older builds sent user_…_account_…_session_&lt;uuid&gt;.</summary>
    private static string? SessionIdFrom(string userId)
    {
        if (userId.StartsWith('{'))
        {
            try
            {
                using var document = JsonDocument.Parse(userId);
                if (document.RootElement.ValueKind == JsonValueKind.Object &&
                    document.RootElement.TryGetProperty("session_id", out var session) &&
                    session.ValueKind == JsonValueKind.String &&
                    Guid.TryParse(session.GetString(), out var guid))
                {
                    return guid.ToString("D");
                }
            }
            catch (JsonException)
            {
            }

            return null;
        }

        return SessionIdPattern.Match(userId) is { Success: true } match
            ? match.Groups[1].Value.ToLowerInvariant()
            : null;
    }

    /// <summary>The system prompt: a plain string in simple requests, an array
    /// of text blocks (with cache markers) in Claude Code's.</summary>
    private static string SystemText(JsonElement root)
    {
        if (!root.TryGetProperty("system", out var system))
        {
            return "";
        }

        if (system.ValueKind == JsonValueKind.String)
        {
            return system.GetString() ?? "";
        }

        if (system.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        var builder = new StringBuilder();
        foreach (var block in system.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object &&
                block.TryGetProperty("text", out var text) &&
                text.ValueKind == JsonValueKind.String)
            {
                builder.AppendLine(text.GetString());
            }
        }

        return builder.ToString().TrimEnd();
    }

    private static void PruneOldCaptures()
    {
        try
        {
            if (!Directory.Exists(AppPaths.RequestCapturesPath))
            {
                return;
            }

            var cutoff = DateTime.UtcNow.AddDays(-90);
            foreach (var file in Directory.EnumerateFiles(AppPaths.RequestCapturesPath, "*.json"))
            {
                if (File.GetLastWriteTimeUtc(file) < cutoff)
                {
                    File.Delete(file);
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>
/// One JSON file per session under the data directory's request-captures
/// folder, holding that session's distinct request contexts. Written by the
/// relay, read by the transcript viewer.
/// </summary>
public static class RequestCaptureStore
{
    private static readonly object FileLock = new();

    public static void Append(string sessionId, RequestCapture capture)
    {
        lock (FileLock)
        {
            Directory.CreateDirectory(AppPaths.RequestCapturesPath);
            var path = PathFor(sessionId);
            // A session keeps its main loop plus a few subagent flavors; a
            // runaway variety of shapes stops accumulating at eight.
            var captures = ReadFile(path);
            if (captures.Any(existing => existing.Hash == capture.Hash) || captures.Count >= 8)
            {
                return;
            }

            captures.Add(capture);
            File.WriteAllText(path, JsonSerializer.Serialize(captures));
        }
    }

    /// <summary>Captures for the session a transcript file records, empty when
    /// the relay never saw it (relay off, or the session predates it).</summary>
    public static List<RequestCapture> ReadForTranscript(string transcriptPath)
    {
        var sessionId = Path.GetFileNameWithoutExtension(transcriptPath);
        if (sessionId.Length != 36)
        {
            return [];
        }

        lock (FileLock)
        {
            return ReadFile(PathFor(sessionId));
        }
    }

    private static List<RequestCapture> ReadFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                return JsonSerializer.Deserialize<List<RequestCapture>>(File.ReadAllText(path)) ?? [];
            }
        }
        catch (Exception exception) when (exception is JsonException or IOException
                                              or UnauthorizedAccessException)
        {
        }

        return [];
    }

    private static string PathFor(string sessionId) => Path.Combine(
        AppPaths.RequestCapturesPath,
        string.Concat(sessionId.ToLowerInvariant().Where(c => char.IsAsciiLetterOrDigit(c) || c == '-')) + ".json");
}
