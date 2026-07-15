using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TokenTracker;

/// <summary>The signed-in Claude Code account as read from the official Claude
/// desktop app's token store.</summary>
public sealed record DesktopCredential(
    string AccessToken,
    string? RefreshToken,
    long? ExpiresAtMs,
    string? SubscriptionType,
    string? RateLimitTier,
    long SourceWriteMs);

/// <summary>
/// Reads the Claude Code account the official Claude desktop app is signed into.
///
/// The desktop app runs Claude Code under its own OAuth store, not
/// ~/.claude/.credentials.json — that file is only ever written by the CLI. So
/// on a machine driven from the desktop app the credentials file names whatever
/// account last used the CLI, and the account the user is actually on shows up
/// as background/stale on the Limits page. The desktop store is the Chromium
/// os_crypt cache under %APPDATA%\Claude: an AES-256-GCM blob whose key is a
/// DPAPI-wrapped value in the app's "Local State", the same scheme every
/// Electron app uses. Everything stays on this machine and decrypts only under
/// the current Windows user, exactly like the plaintext credentials file.
/// </summary>
public static class DesktopAppCredentials
{
    // Claude Code's public OAuth client id. The desktop app caches tokens for
    // several surfaces keyed "clientId:orgId:audience:scopes"; the entry under
    // this client is the Claude Code session, which is what the Limits page and
    // the usage endpoint care about.
    private const string ClaudeCodeClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

    private static string DefaultDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Claude");

    public static string DefaultConfigPath => Path.Combine(DefaultDir, "config.json");

    public static string DefaultLocalStatePath => Path.Combine(DefaultDir, "Local State");

    /// <summary>The desktop app's current Claude Code credential, or null when
    /// the app isn't installed, isn't signed in, or its store can't be read.</summary>
    public static DesktopCredential? TryRead(string configPath, string localStatePath)
    {
        try
        {
            if (!File.Exists(configPath) || !File.Exists(localStatePath))
            {
                return null;
            }

            var key = ReadOsCryptKey(localStatePath);
            if (key is null)
            {
                return null;
            }

            using var config = JsonDocument.Parse(File.ReadAllText(configPath));
            // The V2 cache supersedes the original; fall back for older builds.
            var entry = FindClaudeCodeEntry(config.RootElement, key, "oauth:tokenCacheV2")
                        ?? FindClaudeCodeEntry(config.RootElement, key, "oauth:tokenCache");
            if (entry is not { } element)
            {
                return null;
            }

            var token = StringOf(element, "token");
            if (string.IsNullOrEmpty(token))
            {
                return null;
            }

            return new DesktopCredential(
                token,
                StringOf(element, "refreshToken"),
                element.TryGetProperty("expiresAt", out var expires) && expires.ValueKind == JsonValueKind.Number
                    ? expires.GetInt64()
                    : null,
                StringOf(element, "subscriptionType"),
                StringOf(element, "rateLimitTier"),
                new DateTimeOffset(File.GetLastWriteTimeUtc(configPath), TimeSpan.Zero).ToUnixTimeMilliseconds());
        }
        catch (Exception exception) when (exception is IOException or JsonException or
                                          UnauthorizedAccessException or FormatException or CryptographicException)
        {
            return null;
        }
    }

    /// <summary>Decrypts one os_crypt cache value and returns the Claude Code
    /// client's entry object, or null if it isn't present / can't be read.</summary>
    private static JsonElement? FindClaudeCodeEntry(JsonElement config, byte[] key, string property)
    {
        if (!config.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var plaintext = DecryptOsCrypt(value.GetString()!, key);
        if (plaintext is null)
        {
            return null;
        }

        using var cache = JsonDocument.Parse(plaintext);
        foreach (var item in cache.RootElement.EnumerateObject())
        {
            if (item.Name.StartsWith(ClaudeCodeClientId + ":", StringComparison.Ordinal) &&
                item.Value.ValueKind == JsonValueKind.Object)
            {
                // Clone: the JsonDocument is disposed when this method returns.
                return item.Value.Clone();
            }
        }

        return null;
    }

    /// <summary>The 32-byte AES key Chromium/Electron uses for "v10" values,
    /// stored DPAPI-wrapped (with a "DPAPI" prefix) in the app's Local State.</summary>
    private static byte[]? ReadOsCryptKey(string localStatePath)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(localStatePath));
        if (!document.RootElement.TryGetProperty("os_crypt", out var osCrypt) ||
            !osCrypt.TryGetProperty("encrypted_key", out var encryptedKey) ||
            encryptedKey.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var blob = Convert.FromBase64String(encryptedKey.GetString()!);
        const string prefix = "DPAPI";
        if (blob.Length <= prefix.Length ||
            Encoding.ASCII.GetString(blob, 0, prefix.Length) != prefix)
        {
            return null;
        }

        return DpapiUnprotect(blob[prefix.Length..]);
    }

    /// <summary>AES-256-GCM decrypts a Chromium os_crypt "v10" value:
    /// "v10" + 12-byte nonce + ciphertext + 16-byte tag.</summary>
    private static string? DecryptOsCrypt(string base64, byte[] key)
    {
        var raw = Convert.FromBase64String(base64);
        const int prefixLength = 3;   // "v10"
        const int nonceLength = 12;
        const int tagLength = 16;
        if (raw.Length < prefixLength + nonceLength + tagLength ||
            Encoding.ASCII.GetString(raw, 0, prefixLength) != "v10")
        {
            return null;
        }

        var nonce = raw[prefixLength..(prefixLength + nonceLength)];
        var cipher = raw[(prefixLength + nonceLength)..^tagLength];
        var tag = raw[^tagLength..];
        var plaintext = new byte[cipher.Length];
        using var aes = new AesGcm(key, tagLength);
        aes.Decrypt(nonce, cipher, tag, plaintext);
        return Encoding.UTF8.GetString(plaintext);
    }

    private static string? StringOf(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    // ----- DPAPI (CurrentUser scope) ---------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Length;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob input,
        IntPtr description,
        IntPtr entropy,
        IntPtr reserved,
        IntPtr prompt,
        int flags,
        ref DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr handle);

    private static byte[]? DpapiUnprotect(byte[] encrypted)
    {
        var inputHandle = GCHandle.Alloc(encrypted, GCHandleType.Pinned);
        var input = new DataBlob { Length = encrypted.Length, Data = inputHandle.AddrOfPinnedObject() };
        var output = default(DataBlob);
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output))
            {
                return null;
            }

            var result = new byte[output.Length];
            Marshal.Copy(output.Data, result, 0, output.Length);
            return result;
        }
        finally
        {
            inputHandle.Free();
            if (output.Data != IntPtr.Zero)
            {
                LocalFree(output.Data);
            }
        }
    }
}
