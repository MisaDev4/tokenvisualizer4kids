using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TokenTracker;

/// <summary>
/// Read-only JSON API for other local apps, served over HttpListener on
/// http://localhost:&lt;port&gt;/. The localhost prefix binds loopback only (and
/// needs no admin URL ACL), so nothing is reachable from the network. Usage
/// queries go straight to <see cref="UsageDatabase"/> (a fresh pooled
/// connection per call, safe off the UI thread); limits and terminal states
/// have no store of their own, so the UI's refresh loops push their latest
/// snapshots here.
/// </summary>
public sealed class LocalApiServer : IDisposable
{
    public const int DefaultPort = 5299;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    /// <summary>Mirrors UsageDatabase.ResolveRange's keys; unknown keys would
    /// silently fall back to currentMonth there, so reject them here instead.</summary>
    private static readonly string[] RangeKeys =
    [
        "last1", "last4", "last8", "last12", "last18", "today", "last24",
        "last7", "last30", "currentMonth", "previousMonth", "all"
    ];

    private static readonly string[] Endpoints =
    [
        "/api/status",
        "/api/dashboard?range=currentMonth",
        "/api/events?since=0&limit=400",
        "/api/events/range?start=<unixMs>&end=<unixMs>&limit=2000",
        "/api/daily?days=365",
        "/api/limits",
        "/api/terminals"
    ];

    private readonly UsageDatabase _database;
    private readonly PricingService _pricing;

    private HttpListener? _listener;
    private volatile IReadOnlyList<ClaudeAccountLimits>? _limits;
    private volatile IReadOnlyList<TerminalStatus>? _terminals;
    private long _limitsUpdatedMs;
    private long _terminalsUpdatedMs;

    public LocalApiServer(UsageDatabase database, PricingService pricing)
    {
        _database = database;
        _pricing = pricing;
    }

    public int Port { get; private set; }

    /// <summary>Why the last <see cref="Start"/> failed; null while running or off.</summary>
    public string? Error { get; private set; }

    public bool IsRunning => _listener?.IsListening == true;

    public void UpdateLimits(IReadOnlyList<ClaudeAccountLimits> limits)
    {
        _limits = limits;
        Volatile.Write(ref _limitsUpdatedMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public void UpdateTerminals(IReadOnlyList<TerminalStatus> terminals)
    {
        _terminals = terminals;
        Volatile.Write(ref _terminalsUpdatedMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

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
            // Almost always the port already being in use.
            Error = exception.Message;
            return false;
        }

        Port = port;
        Error = null;
        _listener = listener;
        _ = Task.Run(() => ListenLoopAsync(listener));
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

    public void Dispose() => Stop();

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
                // Stop() was called (or the listener died); end the loop.
                return;
            }

            _ = Task.Run(() => HandleAsync(context));
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var response = context.Response;
        try
        {
            object? payload;
            if (!string.Equals(context.Request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase))
            {
                response.StatusCode = 405;
                payload = new { error = "This API is read-only; only GET is supported." };
            }
            else
            {
                try
                {
                    payload = await RouteAsync(context.Request).ConfigureAwait(false);
                    if (payload is null)
                    {
                        response.StatusCode = 404;
                        payload = new { error = "Unknown endpoint.", endpoints = Endpoints };
                    }
                }
                catch (BadRequestException bad)
                {
                    response.StatusCode = 400;
                    payload = new { error = bad.Message };
                }
                catch (Exception exception)
                {
                    response.StatusCode = 500;
                    payload = new { error = exception.Message };
                }
            }

            var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
            response.ContentType = "application/json; charset=utf-8";
            response.Headers["Cache-Control"] = "no-store";
            response.ContentLength64 = bytes.Length;
            await response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
            response.Close();
        }
        catch (Exception exception) when (
            exception is HttpListenerException or ObjectDisposedException or IOException or InvalidOperationException)
        {
            // The client hung up or the listener stopped mid-response.
            try
            {
                response.Abort();
            }
            catch
            {
            }
        }
    }

    private async Task<object?> RouteAsync(HttpListenerRequest request)
    {
        var path = (request.Url?.AbsolutePath ?? "/").TrimEnd('/');
        return path.ToLowerInvariant() switch
        {
            "" or "/api" => new { app = "TokenTracker", api = "v1", endpoints = Endpoints },
            "/api/status" => await StatusAsync().ConfigureAwait(false),
            "/api/dashboard" => await DashboardAsync(request).ConfigureAwait(false),
            "/api/events" => await EventsAsync(request).ConfigureAwait(false),
            "/api/events/range" => await EventsRangeAsync(request).ConfigureAwait(false),
            "/api/daily" => await DailyAsync(request).ConfigureAwait(false),
            "/api/limits" => new
            {
                updatedMs = Volatile.Read(ref _limitsUpdatedMs),
                accounts = _limits ?? []
            },
            "/api/terminals" => new
            {
                updatedMs = Volatile.Read(ref _terminalsUpdatedMs),
                terminals = _terminals ?? []
            },
            _ => null
        };
    }

    private async Task<object> StatusAsync() => new
    {
        app = "TokenTracker",
        serverTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        databasePath = _database.DatabasePath,
        eventCount = await _database.GetEventCountAsync().ConfigureAwait(false),
        pricing = _pricing.Status,
        limitsUpdatedMs = Volatile.Read(ref _limitsUpdatedMs),
        terminalsUpdatedMs = Volatile.Read(ref _terminalsUpdatedMs)
    };

    private async Task<object> DashboardAsync(HttpListenerRequest request)
    {
        var range = request.QueryString["range"] ?? "currentMonth";
        if (!RangeKeys.Contains(range, StringComparer.Ordinal))
        {
            throw new BadRequestException(
                $"Unknown range '{range}'. Valid ranges: {string.Join(", ", RangeKeys)}.");
        }

        return await _database.GetDashboardAsync(range, _pricing).ConfigureAwait(false);
    }

    private async Task<object> EventsAsync(HttpListenerRequest request)
    {
        var since = LongParam(request, "since", 0);
        var limit = (int)Math.Clamp(LongParam(request, "limit", 400), 1, 5000);
        var rows = await _database.GetEventsUpdatedSinceAsync(since, limit).ConfigureAwait(false);
        return new
        {
            serverTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            // Pass back as ?since= on the next poll to receive only newer rows.
            cursor = rows.Count > 0 ? rows.Max(row => row.UpdatedMs) : since,
            count = rows.Count,
            events = rows.Select(EventJson).ToList()
        };
    }

    private async Task<object> EventsRangeAsync(HttpListenerRequest request)
    {
        var start = LongParam(request, "start", -1);
        if (start < 0)
        {
            throw new BadRequestException("'start' is required (unix milliseconds).");
        }

        var end = LongParam(request, "end", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var limit = (int)Math.Clamp(LongParam(request, "limit", 2000), 1, 10000);
        var rows = await _database.GetEventsInRangeAsync(start, end, limit).ConfigureAwait(false);
        return new
        {
            startMs = start,
            endMs = end,
            count = rows.Count,
            events = rows.Select(EventJson).ToList()
        };
    }

    private async Task<object> DailyAsync(HttpListenerRequest request)
    {
        var days = Math.Clamp(LongParam(request, "days", 365), 1, 3650);
        var sinceMs = LongParam(
            request,
            "since",
            DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds());
        var rows = await _database.GetDailyUsageAsync(sinceMs, _pricing).ConfigureAwait(false);
        return new
        {
            sinceMs,
            days = rows.OrderBy(row => row.Day, StringComparer.Ordinal).ToList()
        };
    }

    private object EventJson(LiveEventRow row)
    {
        var estimate = _pricing.Calculate(row.Provider, row.Model, row.Tokens);
        return new
        {
            row.EventKey,
            row.Client,
            row.Provider,
            row.Model,
            row.SessionId,
            row.TimestampMs,
            row.UpdatedMs,
            row.Tokens,
            row.Messages,
            EstimatedCost = estimate.Cost,
            estimate.IsPriced
        };
    }

    private static long LongParam(HttpListenerRequest request, string name, long fallback)
    {
        var raw = request.QueryString[name];
        if (string.IsNullOrEmpty(raw))
        {
            return fallback;
        }

        if (!long.TryParse(raw, out var value))
        {
            throw new BadRequestException($"'{name}' must be an integer.");
        }

        return value;
    }

    private sealed class BadRequestException(string message) : Exception(message);
}
