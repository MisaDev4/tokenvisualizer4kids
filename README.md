# Token Tracker

Double-click **`TokenTracker.exe`**. There is nothing to install.

The initial full scan has already been completed. The app will use its saved local index, watch Codex and Claude logs for live changes, and periodically reconcile anything the watcher may have missed. Use **Full rescan / repair** inside the app whenever you want to rebuild and verify all currently available history.

The dashboard also calculates estimated API list-price costs by model and day. Pricing is cached in `%LOCALAPPDATA%\TokenTracker` and refreshed from LiteLLM's public model-pricing catalog when it is more than 24 hours old. Existing token history does not need to be rescanned when prices change. Estimates use current catalog prices for the selected historical range and may differ from an actual provider invoice, subscription, discount, or historical rate.

The dashboard is a single page. Range presets (Today, 24 h, 7 days, 30 days, This month, All time) sit in the header and scope everything below them: the estimated-cost figure with a comparison against the prior period, the token totals, the timeline chart, and the per-model breakdown. Short ranges chart by local hour, longer ranges by day, and all-time by month; quiet periods render as true zero-height columns rather than disappearing. The chart can show cost, a stacked input/output/cache token composition, or messages, and every column has a hover tooltip with the full breakdown; a Table toggle shows the same data as numbers. Background-scan interval, Windows startup, and full rescan/repair live behind the Settings button.

Closing the window leaves Token Tracker running in the Windows notification area. Use the tray icon's **Exit** command to stop it completely. **Start with Windows** is optional inside the app.

## Data

The app reads local logs from `%USERPROFILE%\.codex` and `%USERPROFILE%\.claude`, plus the AI-bench trial streams in `Desktop\master\production\bench-results` (Claude Code running against AWS Bedrock inside Docker sandboxes; those events show up under the `bedrock` provider). It saves token metadata—but not prompt or response text—in `%LOCALAPPDATA%\TokenTracker`:

- `usage.db`
- `settings.json`
- `pricing-litellm.json`

The saved index is separate from this folder, so moving or cleaning the program files does not erase token history.

## Source code

The current MVP source is retained in `source` for future fixes. It is not needed to run `TokenTracker.exe`.

To rebuild with the .NET 10 SDK:

```powershell
dotnet publish source\TokenTracker.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o source\publish
```
