using System.Collections.Concurrent;
using System.Net.Http;
using System.Text.Json;

namespace TokenTracker;

public sealed record PricingEstimate(double Cost, bool IsPriced);

public sealed class PricingService
{
    private const long OpenAiLongContextThreshold = 272_000;
    private const string PricingUrl =
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
    private static readonly TimeSpan RefreshAge = TimeSpan.FromHours(24);
    private static readonly HttpClient HttpClient = CreateHttpClient();

    private readonly IReadOnlyDictionary<string, ModelPricing> _fallback = CreateFallbackPricing();
    private readonly ConcurrentDictionary<string, PricingResolution> _resolutionCache =
        new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyDictionary<string, ModelPricing> _catalog;

    public PricingService()
    {
        _catalog = _fallback;
        Status = "Built-in pricing fallback";
    }

    public string Status { get; private set; }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        AppPaths.EnsureDataDirectory();
        var cacheIsFresh = false;
        if (File.Exists(AppPaths.PricingCachePath))
        {
            try
            {
                var cachedJson = await File.ReadAllTextAsync(AppPaths.PricingCachePath, cancellationToken)
                    .ConfigureAwait(false);
                if (TryLoadCatalog(cachedJson, out var cachedCatalog))
                {
                    SetCatalog(cachedCatalog);
                    var updated = File.GetLastWriteTimeUtc(AppPaths.PricingCachePath);
                    Status = $"LiteLLM pricing cached {updated.ToLocalTime():g}";
                    cacheIsFresh = DateTime.UtcNow - updated < RefreshAge;
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        if (cacheIsFresh)
        {
            return;
        }

        try
        {
            var json = await HttpClient.GetStringAsync(PricingUrl, cancellationToken).ConfigureAwait(false);
            if (!TryLoadCatalog(json, out var downloadedCatalog))
            {
                return;
            }

            SetCatalog(downloadedCatalog);
            var temporaryPath = AppPaths.PricingCachePath + ".tmp";
            await File.WriteAllTextAsync(temporaryPath, json, cancellationToken).ConfigureAwait(false);
            File.Move(temporaryPath, AppPaths.PricingCachePath, overwrite: true);
            Status = $"LiteLLM pricing updated {DateTime.Now:g}";
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
        }
        catch (HttpRequestException)
        {
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    public PricingEstimate Calculate(string provider, string model, TokenBreakdown tokens)
    {
        var cacheKey = $"{provider}|{model}";
        var resolution = _resolutionCache.GetOrAdd(cacheKey, _ => Resolve(provider, model));
        if (resolution.Pricing is null)
        {
            return new PricingEstimate(0, false);
        }

        var pricing = resolution.Pricing;
        var cost = UsesOpenAiLongContextPricing(provider, pricing, tokens)
            ? FlatCost(tokens.Input, LongContextRate(pricing.InputAbove272K, pricing.Input)) +
              FlatCost(tokens.Output, LongContextRate(pricing.OutputAbove272K, pricing.Output)) +
              FlatCost(tokens.CacheRead, LongContextRate(pricing.CacheReadAbove272K, pricing.CacheRead)) +
              FlatCost(tokens.CacheWrite, LongContextRate(pricing.CacheWriteAbove272K, pricing.CacheWrite))
            : TieredCost(
                  tokens.Input,
                  pricing.Input,
                  (128_000, pricing.InputAbove128K),
                  (200_000, pricing.InputAbove200K),
                  (256_000, pricing.InputAbove256K),
                  (272_000, pricing.InputAbove272K)) +
              TieredCost(
                  tokens.Output,
                  pricing.Output,
                  (128_000, pricing.OutputAbove128K),
                  (200_000, pricing.OutputAbove200K),
                  (256_000, pricing.OutputAbove256K),
                  (272_000, pricing.OutputAbove272K)) +
              TieredCost(
                  tokens.CacheRead,
                  pricing.CacheRead,
                  (200_000, pricing.CacheReadAbove200K),
                  (272_000, pricing.CacheReadAbove272K)) +
              TieredCost(
                  tokens.CacheWrite,
                  pricing.CacheWrite,
                  (200_000, pricing.CacheWriteAbove200K));

        return new PricingEstimate(double.IsFinite(cost) && cost >= 0 ? cost : 0, true);
    }

    private PricingResolution Resolve(string provider, string rawModel)
    {
        var model = NormalizeModel(rawModel);
        if (TryFind(_catalog, model, provider, out var pricing) ||
            TryFind(_fallback, model, provider, out pricing))
        {
            return new PricingResolution(pricing);
        }

        return new PricingResolution(null);
    }

    private static bool TryFind(
        IReadOnlyDictionary<string, ModelPricing> catalog,
        string model,
        string provider,
        out ModelPricing? pricing)
    {
        if (catalog.TryGetValue(model, out pricing))
        {
            return true;
        }

        var modelPart = model.Split('/').Last();
        if (catalog.TryGetValue(modelPart, out pricing))
        {
            return true;
        }

        var providerPrefix = NormalizeProvider(provider);
        if (catalog.TryGetValue($"{providerPrefix}/{modelPart}", out pricing))
        {
            return true;
        }

        pricing = catalog
            .Where(item => item.Key.EndsWith($"/{modelPart}", StringComparison.OrdinalIgnoreCase) &&
                           NormalizeProvider(item.Value.Provider).Equals(
                               providerPrefix,
                               StringComparison.OrdinalIgnoreCase))
            .Select(item => item.Value)
            .FirstOrDefault();
        return pricing is not null;
    }

    private void SetCatalog(IReadOnlyDictionary<string, ModelPricing> catalog)
    {
        _catalog = catalog;
        _resolutionCache.Clear();
    }

    private static bool TryLoadCatalog(string json, out IReadOnlyDictionary<string, ModelPricing> catalog)
    {
        var parsed = new Dictionary<string, ModelPricing>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var document = JsonDocument.Parse(json);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Value.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var value = property.Value;
                var input = GetDouble(value, "input_cost_per_token");
                var output = GetDouble(value, "output_cost_per_token");
                if (input is null && output is null)
                {
                    continue;
                }

                parsed[property.Name] = new ModelPricing(
                    GetString(value, "litellm_provider") ?? string.Empty,
                    input,
                    output,
                    GetDouble(value, "cache_read_input_token_cost"),
                    GetDouble(value, "cache_creation_input_token_cost"),
                    GetDouble(value, "input_cost_per_token_above_128k_tokens"),
                    GetDouble(value, "input_cost_per_token_above_200k_tokens"),
                    GetDouble(value, "input_cost_per_token_above_256k_tokens"),
                    GetDouble(value, "input_cost_per_token_above_272k_tokens"),
                    GetDouble(value, "output_cost_per_token_above_128k_tokens"),
                    GetDouble(value, "output_cost_per_token_above_200k_tokens"),
                    GetDouble(value, "output_cost_per_token_above_256k_tokens"),
                    GetDouble(value, "output_cost_per_token_above_272k_tokens"),
                    GetDouble(value, "cache_read_input_token_cost_above_200k_tokens"),
                    GetDouble(value, "cache_read_input_token_cost_above_272k_tokens"),
                    GetDouble(value, "cache_creation_input_token_cost_above_200k_tokens"),
                    GetDouble(value, "cache_creation_input_token_cost_above_272k_tokens"));
            }
        }
        catch (JsonException)
        {
            catalog = new Dictionary<string, ModelPricing>();
            return false;
        }

        catalog = parsed;
        return parsed.Count >= 100;
    }

    private static double TieredCost(
        long tokenCount,
        double? basePrice,
        params (long Threshold, double? Price)[] tiers)
    {
        var tokens = Math.Max(0, tokenCount);
        var activePrice = SafePrice(basePrice);
        var lowerBound = 0L;
        var cost = 0d;

        foreach (var (threshold, price) in tiers)
        {
            if (!IsValidPrice(price) || threshold <= lowerBound)
            {
                continue;
            }

            if (tokens <= threshold)
            {
                return cost + Math.Max(0, tokens - lowerBound) * activePrice;
            }

            cost += (threshold - lowerBound) * activePrice;
            lowerBound = threshold;
            activePrice = price!.Value;
        }

        return cost + Math.Max(0, tokens - lowerBound) * activePrice;
    }

    private static bool UsesOpenAiLongContextPricing(
        string provider,
        ModelPricing pricing,
        TokenBreakdown tokens)
    {
        if (!NormalizeProvider(provider).Equals("openai", StringComparison.OrdinalIgnoreCase) ||
            !IsValidPrice(pricing.InputAbove272K) ||
            !IsValidPrice(pricing.OutputAbove272K))
        {
            return false;
        }

        var requestInput = SaturatingAdd(
            SaturatingAdd(tokens.Input, tokens.CacheRead),
            tokens.CacheWrite);
        return requestInput > OpenAiLongContextThreshold;
    }

    private static double FlatCost(long tokenCount, double? price) =>
        Math.Max(0, tokenCount) * SafePrice(price);

    private static double? LongContextRate(double? longContextPrice, double? standardPrice) =>
        IsValidPrice(longContextPrice) ? longContextPrice : standardPrice;

    private static IReadOnlyDictionary<string, ModelPricing> CreateFallbackPricing()
    {
        var pricing = new Dictionary<string, ModelPricing>(StringComparer.OrdinalIgnoreCase);

        Add(pricing, "openai", 5, 30, 0.5, 0, "gpt-5.5");
        Add(pricing, "openai", 2.5, 15, 0.25, 0, "gpt-5.4");
        Add(pricing, "openai", 1.75, 14, 0.175, 0, "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2");
        Add(pricing, "openai", 1.25, 10, 0.125, 0, "gpt-5.1-codex", "gpt-5-codex", "gpt-5");
        Add(pricing, "anthropic", 5, 25, 0.5, 6.25, "claude-opus-4-8", "claude-opus-4-6");
        Add(pricing, "anthropic", 10, 50, 1, 12.5, "claude-fable-5");
        Add(pricing, "anthropic", 3, 15, 0.3, 3.75,
            "claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4-6");
        Add(pricing, "anthropic", 15, 75, 1.5, 18.75,
            "claude-opus-4", "claude-opus-4-1");
        Add(pricing, "anthropic", 0.8, 4, 0.08, 1,
            "claude-3-5-haiku", "claude-haiku-3-5");

        return pricing;
    }

    private static void Add(
        IDictionary<string, ModelPricing> target,
        string provider,
        double inputPerMillion,
        double outputPerMillion,
        double cacheReadPerMillion,
        double cacheWritePerMillion,
        params string[] models)
    {
        var pricing = new ModelPricing(
            provider,
            inputPerMillion / 1_000_000d,
            outputPerMillion / 1_000_000d,
            cacheReadPerMillion / 1_000_000d,
            cacheWritePerMillion / 1_000_000d);
        foreach (var model in models)
        {
            target[model] = pricing;
        }
    }

    private static string NormalizeModel(string model)
    {
        var normalized = model.Trim().ToLowerInvariant();
        var tierStart = normalized.LastIndexOf('(');
        return tierStart > 0 && normalized.EndsWith(')')
            ? normalized[..tierStart].TrimEnd()
            : normalized;
    }

    private static string NormalizeProvider(string provider) => provider.ToLowerInvariant() switch
    {
        "openai-codex" => "openai",
        "claude" => "anthropic",
        _ => provider.Trim().ToLowerInvariant()
    };

    private static double? GetDouble(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number))
        {
            return IsValidPrice(number) ? number : null;
        }

        return value.ValueKind == JsonValueKind.String && double.TryParse(
            value.GetString(),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out number) && IsValidPrice(number)
            ? number
            : null;
    }

    private static string? GetString(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static double SafePrice(double? price) => IsValidPrice(price) ? price!.Value : 0;

    private static bool IsValidPrice(double? price) =>
        price is >= 0 && double.IsFinite(price.Value);

    private static long SaturatingAdd(long left, long right) =>
        left > long.MaxValue - right ? long.MaxValue : left + right;

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TokenTracker/1.1");
        return client;
    }

    private sealed record PricingResolution(ModelPricing? Pricing);

    private sealed record ModelPricing(
        string Provider,
        double? Input,
        double? Output,
        double? CacheRead = null,
        double? CacheWrite = null,
        double? InputAbove128K = null,
        double? InputAbove200K = null,
        double? InputAbove256K = null,
        double? InputAbove272K = null,
        double? OutputAbove128K = null,
        double? OutputAbove200K = null,
        double? OutputAbove256K = null,
        double? OutputAbove272K = null,
        double? CacheReadAbove200K = null,
        double? CacheReadAbove272K = null,
        double? CacheWriteAbove200K = null,
        double? CacheWriteAbove272K = null);
}
