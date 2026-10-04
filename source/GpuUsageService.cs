using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

public sealed record GpuInstanceInfo(
    string InstanceId,
    string Name,
    string InstanceType,
    string State,
    string AvailabilityZone,
    DateTimeOffset? LaunchTime,
    string GpuModel,
    double? HourlyUsd);

public sealed record GpuScanResult(
    IReadOnlyList<GpuInstanceInfo> Instances,
    string? Error,
    string? AccountId,
    string? Region,
    DateTimeOffset ScannedAt);

public sealed record GpuCreditsResult(
    double AppliedSinceStart,
    double AppliedThisMonth,
    double SinceTokensUsd,
    double SinceGpuUsd,
    double MonthTokensUsd,
    double MonthGpuUsd,
    string? Error);

/// <summary>The GPU tab's data source: one free `aws ec2 describe-instances`
/// call per refresh, filtered to GPU instance families. Deliberately separate
/// from every token/usage path — this never touches the usage database.</summary>
public sealed class GpuUsageService
{
    // Accelerated-computing families that carry GPUs. Anything whose family
    // starts with g or p is accepted too, so brand-new families still show.
    private static readonly HashSet<string> GpuFamilies = new(StringComparer.OrdinalIgnoreCase)
    {
        "g2", "g3", "g3s", "g4ad", "g4dn", "g5", "g5g", "g6", "g6e", "g6f", "gr6",
        "p2", "p3", "p3dn", "p4d", "p4de", "p5", "p5e", "p5en", "p6-b200"
    };

    private static readonly Dictionary<string, string> GpuModelByFamily = new(StringComparer.OrdinalIgnoreCase)
    {
        ["g2"] = "NVIDIA GRID K520",
        ["g3"] = "NVIDIA M60",
        ["g3s"] = "NVIDIA M60",
        ["g4ad"] = "AMD Radeon Pro V520",
        ["g4dn"] = "NVIDIA T4",
        ["g5"] = "NVIDIA A10G",
        ["g5g"] = "NVIDIA T4G",
        ["g6"] = "NVIDIA L4",
        ["g6e"] = "NVIDIA L40S",
        ["gr6"] = "NVIDIA L4",
        ["p2"] = "NVIDIA K80",
        ["p3"] = "NVIDIA V100",
        ["p3dn"] = "NVIDIA V100",
        ["p4d"] = "NVIDIA A100",
        ["p4de"] = "NVIDIA A100 80GB",
        ["p5"] = "NVIDIA H100",
        ["p5e"] = "NVIDIA H200",
        ["p5en"] = "NVIDIA H200",
        ["p6-b200"] = "NVIDIA B200"
    };

    // On-demand Linux list prices, us-east-1. Estimates for the tab's cost
    // lines only — the authoritative bill is always AWS's own.
    private static readonly Dictionary<string, double> OnDemandUsd = new(StringComparer.OrdinalIgnoreCase)
    {
        ["g4dn.xlarge"] = 0.526, ["g4dn.2xlarge"] = 0.752, ["g4dn.4xlarge"] = 1.204,
        ["g4dn.8xlarge"] = 2.176, ["g4dn.12xlarge"] = 3.912, ["g4dn.16xlarge"] = 4.352,
        ["g4ad.xlarge"] = 0.379, ["g4ad.2xlarge"] = 0.541, ["g4ad.4xlarge"] = 0.867,
        ["g5.xlarge"] = 1.006, ["g5.2xlarge"] = 1.212, ["g5.4xlarge"] = 1.624,
        ["g5.8xlarge"] = 2.448, ["g5.12xlarge"] = 5.672, ["g5.16xlarge"] = 4.096,
        ["g5.24xlarge"] = 8.144, ["g5.48xlarge"] = 16.288,
        ["g6.xlarge"] = 0.805, ["g6.2xlarge"] = 0.978, ["g6.4xlarge"] = 1.323,
        ["g6.8xlarge"] = 2.014, ["g6.12xlarge"] = 4.602, ["g6.16xlarge"] = 3.397,
        ["g6.24xlarge"] = 6.675, ["g6.48xlarge"] = 13.350,
        ["g6e.xlarge"] = 1.861, ["g6e.2xlarge"] = 2.242, ["g6e.4xlarge"] = 3.004,
        ["g6e.8xlarge"] = 4.528, ["g6e.12xlarge"] = 10.493, ["g6e.16xlarge"] = 7.577,
        ["g6e.24xlarge"] = 15.066, ["g6e.48xlarge"] = 30.131,
        ["p3.2xlarge"] = 3.060, ["p3.8xlarge"] = 12.240, ["p3.16xlarge"] = 24.480,
        ["p4d.24xlarge"] = 32.773, ["p5.48xlarge"] = 98.320
    };

    public async Task<GpuScanResult> ScanAsync(CancellationToken cancellation = default)
    {
        var aws = FindAwsCli();
        if (aws is null)
        {
            return new GpuScanResult([], "AWS CLI not found. Install AWS CLI v2 and run `aws configure` once.",
                null, null, DateTimeOffset.Now);
        }

        var (exitCode, stdout, stderr) = await RunAsync(aws,
            ["ec2", "describe-instances", "--output", "json", "--no-cli-pager"], cancellation);
        if (exitCode != 0)
        {
            return new GpuScanResult([], FriendlyError(stderr), null, ReadConfiguredRegion(), DateTimeOffset.Now);
        }

        try
        {
            var (instances, account) = Parse(stdout);
            return new GpuScanResult(instances, null, account, ReadConfiguredRegion(), DateTimeOffset.Now);
        }
        catch (JsonException)
        {
            return new GpuScanResult([], "The AWS CLI returned something that is not JSON — try `aws ec2 describe-instances` in a terminal.",
                null, ReadConfiguredRegion(), DateTimeOffset.Now);
        }
    }

    /// <summary>Credits Cost Explorer says were applied to the bill (negative
    /// line items, returned here as positive dollars) since <paramref name="sinceDay"/>,
    /// plus this month's slice. One metered call — the caller owns the cache.</summary>
    public async Task<GpuCreditsResult> GetCreditsAppliedAsync(
        DateOnly? sinceDay, CancellationToken cancellation = default)
    {
        var aws = FindAwsCli();
        if (aws is null)
        {
            return new GpuCreditsResult(0, 0, 0, 0, 0, 0, "AWS CLI not found.");
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var firstOfMonth = new DateOnly(today.Year, today.Month, 1);
        // The window must reach back to whichever is older — the baseline day
        // (for the countdown) or the first of the month (for the month figure).
        var start = sinceDay is not null && sinceDay.Value < firstOfMonth ? sinceDay.Value : firstOfMonth;
        // Cost Explorer serves ~14 months; clamp so an old baseline still answers.
        var oldest = today.AddDays(-400);
        if (start < oldest)
        {
            start = oldest;
        }

        // DAILY, not MONTHLY: the baseline usually lands mid-month, and the
        // countdown must only subtract credits applied from that day on — the
        // console balance the user copied already contained everything before.
        var (exitCode, stdout, stderr) = await RunAsync(aws,
        [
            "ce", "get-cost-and-usage",
            "--time-period", $"Start={start:yyyy-MM-dd},End={today.AddDays(1):yyyy-MM-dd}",
            "--granularity", "DAILY",
            "--metrics", "UnblendedCost",
            "--filter", """{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit"]}}""",
            "--group-by", "Type=DIMENSION,Key=SERVICE",
            "--output", "json", "--no-cli-pager"
        ], cancellation);
        if (exitCode != 0)
        {
            var text = stderr.Trim();
            var friendly =
                text.Contains("DataUnavailable", StringComparison.OrdinalIgnoreCase)
                    ? "Cost Explorer has no data yet — AWS takes about a day after it is first opened."
                : text.Contains("AccessDenied", StringComparison.OrdinalIgnoreCase)
                    ? "This AWS key is not allowed to call Cost Explorer (ce:GetCostAndUsage)."
                : FriendlyError(stderr);
            return new GpuCreditsResult(0, 0, 0, 0, 0, 0, friendly);
        }

        try
        {
            double sinceBaseline = 0, month = 0;
            double sinceTokens = 0, sinceGpu = 0, monthTokens = 0, monthGpu = 0;
            using var doc = JsonDocument.Parse(stdout);
            if (doc.RootElement.TryGetProperty("ResultsByTime", out var buckets))
            {
                foreach (var bucket in buckets.EnumerateArray())
                {
                    if (!bucket.TryGetProperty("TimePeriod", out var period) ||
                        !period.TryGetProperty("Start", out var s) ||
                        !DateOnly.TryParse(s.GetString(), out var day) ||
                        !bucket.TryGetProperty("Groups", out var groups))
                    {
                        continue;
                    }

                    foreach (var group in groups.EnumerateArray())
                    {
                        if (!group.TryGetProperty("Metrics", out var metrics) ||
                            !metrics.TryGetProperty("UnblendedCost", out var cost) ||
                            !cost.TryGetProperty("Amount", out var amount) ||
                            !double.TryParse(amount.GetString(), System.Globalization.NumberStyles.Float,
                                System.Globalization.CultureInfo.InvariantCulture, out var value))
                        {
                            continue;
                        }

                        var service = group.TryGetProperty("Keys", out var keys) && keys.GetArrayLength() > 0
                            ? keys[0].GetString() ?? ""
                            : "";
                        // Bedrock model usage bills either as "Amazon Bedrock" or as a
                        // marketplace listing like "Claude ... (Amazon Bedrock Edition)".
                        var isTokens = service.Contains("Bedrock", StringComparison.OrdinalIgnoreCase);
                        var isGpu = service.Contains("Elastic Compute Cloud", StringComparison.OrdinalIgnoreCase) ||
                                    service.StartsWith("EC2", StringComparison.OrdinalIgnoreCase);
                        var applied = -value;
                        if (day >= firstOfMonth)
                        {
                            month += applied;
                            if (isTokens) { monthTokens += applied; } else if (isGpu) { monthGpu += applied; }
                        }

                        if (sinceDay is null || day >= sinceDay.Value)
                        {
                            sinceBaseline += applied;
                            if (isTokens) { sinceTokens += applied; } else if (isGpu) { sinceGpu += applied; }
                        }
                    }
                }
            }

            return new GpuCreditsResult(sinceBaseline, month, sinceTokens, sinceGpu, monthTokens, monthGpu, null);
        }
        catch (JsonException)
        {
            return new GpuCreditsResult(0, 0, 0, 0, 0, 0, "Cost Explorer returned something that is not JSON.");
        }
    }

    private static (List<GpuInstanceInfo> Instances, string? Account) Parse(string json)
    {
        var instances = new List<GpuInstanceInfo>();
        string? account = null;
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("Reservations", out var reservations))
        {
            return (instances, account);
        }

        foreach (var reservation in reservations.EnumerateArray())
        {
            account ??= reservation.TryGetProperty("OwnerId", out var owner) ? owner.GetString() : null;
            if (!reservation.TryGetProperty("Instances", out var list))
            {
                continue;
            }

            foreach (var element in list.EnumerateArray())
            {
                var type = element.TryGetProperty("InstanceType", out var t) ? t.GetString() ?? "" : "";
                var family = type.Split('.')[0];
                var isGpu = GpuFamilies.Contains(family) ||
                            (family.Length > 1 && (family[0] == 'g' || family[0] == 'p') && char.IsDigit(family[1]));
                if (!isGpu)
                {
                    continue;
                }

                var state = element.TryGetProperty("State", out var s) &&
                            s.TryGetProperty("Name", out var sn) ? sn.GetString() ?? "unknown" : "unknown";
                var zone = element.TryGetProperty("Placement", out var p) &&
                           p.TryGetProperty("AvailabilityZone", out var az) ? az.GetString() ?? "" : "";
                DateTimeOffset? launch = element.TryGetProperty("LaunchTime", out var lt) &&
                                         lt.TryGetDateTimeOffset(out var when) ? when : null;
                var name = "";
                if (element.TryGetProperty("Tags", out var tags))
                {
                    foreach (var tag in tags.EnumerateArray())
                    {
                        if (tag.TryGetProperty("Key", out var k) && k.GetString() == "Name")
                        {
                            name = tag.TryGetProperty("Value", out var v) ? v.GetString() ?? "" : "";
                            break;
                        }
                    }
                }

                instances.Add(new GpuInstanceInfo(
                    element.TryGetProperty("InstanceId", out var id) ? id.GetString() ?? "" : "",
                    name,
                    type,
                    state,
                    zone,
                    launch,
                    GpuModelByFamily.TryGetValue(family, out var gpu) ? gpu : "GPU",
                    OnDemandUsd.TryGetValue(type, out var usd) ? usd : null));
            }
        }

        // Running first, then by newest launch — the burning money on top.
        instances.Sort((a, b) =>
        {
            var aRun = a.State == "running" ? 0 : a.State == "terminated" ? 2 : 1;
            var bRun = b.State == "running" ? 0 : b.State == "terminated" ? 2 : 1;
            return aRun != bRun
                ? aRun.CompareTo(bRun)
                : Comparer<DateTimeOffset?>.Default.Compare(b.LaunchTime, a.LaunchTime);
        });
        return (instances, account);
    }

    private static string? FindAwsCli()
    {
        var standard = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Amazon", "AWSCLIV2", "aws.exe");
        if (File.Exists(standard))
        {
            return standard;
        }

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            var trimmed = dir.Trim();
            if (trimmed.Length > 0 && File.Exists(Path.Combine(trimmed, "aws.exe")))
            {
                return Path.Combine(trimmed, "aws.exe");
            }
        }

        return null;
    }

    private static string? ReadConfiguredRegion()
    {
        try
        {
            var config = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".aws", "config");
            if (!File.Exists(config))
            {
                return null;
            }

            foreach (var line in File.ReadAllLines(config))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith("region", StringComparison.OrdinalIgnoreCase))
                {
                    var eq = trimmed.IndexOf('=');
                    if (eq > 0)
                    {
                        return trimmed[(eq + 1)..].Trim();
                    }
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        return null;
    }

    private static string FriendlyError(string stderr)
    {
        var text = stderr.Trim();
        if (text.Contains("Unable to locate credentials", StringComparison.OrdinalIgnoreCase))
        {
            return "No AWS credentials configured. Run `aws configure` once and refresh.";
        }

        if (text.Contains("ExpiredToken", StringComparison.OrdinalIgnoreCase))
        {
            return "The AWS credentials have expired. Refresh them and try again.";
        }

        if (text.Contains("could not connect", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("Connect timeout", StringComparison.OrdinalIgnoreCase))
        {
            return "Could not reach AWS — check the connection and refresh.";
        }

        var firstLine = text.Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim();
        return string.IsNullOrEmpty(firstLine) ? "The AWS CLI failed without an error message." : firstLine;
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> RunAsync(
        string fileName, IReadOnlyList<string> arguments, CancellationToken cancellation)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        try
        {
            if (!process.Start())
            {
                return (-1, "", "The AWS CLI failed to start.");
            }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return (-1, "", "The AWS CLI failed to start: " + ex.Message);
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellation);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellation);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(45));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }

            return (-1, "", "The AWS CLI did not answer within 45 seconds.");
        }

        return (process.ExitCode, await stdoutTask, await stderrTask);
    }
}
