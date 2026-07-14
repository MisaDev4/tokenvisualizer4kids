# Token Tracker

Double-click **`TokenTracker.exe`**. There is nothing to install.

The initial full scan has already been completed. The app will use its saved local index, watch Codex and Claude logs for live changes, and periodically reconcile anything the watcher may have missed. Use **Full rescan / repair** inside the app whenever you want to rebuild and verify all currently available history.

The dashboard also calculates estimated API list-price costs by model and day. Pricing is cached in `%LOCALAPPDATA%\TokenTracker` and refreshed from LiteLLM's public model-pricing catalog when it is more than 24 hours old. Existing token history does not need to be rescanned when prices change. Estimates use current catalog prices for the selected historical range and may differ from an actual provider invoice, subscription, discount, or historical rate.

Closing the window leaves Token Tracker running in the Windows notification area. Use the tray icon's **Exit** command to stop it completely. **Start with Windows** is optional inside the app.

## Data

The app reads local logs from `%USERPROFILE%\.codex` and `%USERPROFILE%\.claude`. It saves token metadata—but not prompt or response text—in `%LOCALAPPDATA%\TokenTracker`:

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
