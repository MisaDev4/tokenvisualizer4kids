# Token Tracker — working notes

WPF app (.NET 10) in `source/TokenTracker.App.csproj`. The app the user actually runs is the
self-contained single-file publish at the repo root: `TokenTracker.exe`.

## After every code change: rebuild and restart the user's exe

Always finish a change by republishing and restarting the root exe — the user should never
have to do this themselves:

```powershell
# 1. Publish. dotnet is NOT on PATH on this machine; use the user-local SDK.
& "$env:USERPROFILE\.dotnet\dotnet.exe" publish source\TokenTracker.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -o source\publish

# 2. Swap the exe (the running app locks its own file, so stop it first).
Get-Process TokenTracker -ErrorAction SilentlyContinue | Stop-Process -Confirm:$false
Start-Sleep -Milliseconds 800
Copy-Item source\publish\TokenTracker.exe . -Force

# 3. Restart it.
Start-Process .\TokenTracker.exe
```

The app is single-instance (a second launch just surfaces the first) and closing the window
leaves it in the tray; only Stop-Process / the tray icon's Exit actually stops it.

## Quick debug builds

`& "$env:USERPROFILE\.dotnet\dotnet.exe" build source\TokenTracker.App.csproj` is the fast
compile check. The Debug exe only launches with `$env:DOTNET_ROOT = "$env:USERPROFILE\.dotnet"`
set — no machine-wide .NET Desktop Runtime is installed. Stop the root exe first (single instance).

## Verifying UI changes

Drive the running app with UI Automation: tabs are radio buttons findable by their Name
("Limits", "Insights", …) and selected via SelectionItemPattern. Screenshot with
`PrintWindow(hwnd, hdc, 2)` (PW_RENDERFULLCONTENT — a plain screen copy comes back blank for
this window). Beware DPI: `GetWindowRect` may return virtualized coordinates while PrintWindow
renders physical pixels, so size the bitmap by `GetDpiForWindow(hwnd) / 96.0`.

Screenshots in `docs/` are taken with the Settings → Hide personal data toggle on.
