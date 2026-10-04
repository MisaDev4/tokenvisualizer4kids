# Token Tracker — working notes

WPF app (.NET 10) in `source/TokenTracker.App.csproj`. The app the user actually runs is the
self-contained single-file publish at the repo root: `TokenTracker.exe`.

Sources are auto-discovered (`SourceDiscovery.cs`): a profile-wide `*.jsonl` watcher plus a
periodic pruned sweep sniff files for Claude/Codex transcript shape and add their folder to
`DiscoveredSourceRoots` in settings.json — new projects and harnesses need no settings edit.
Discovered roots don't get their own FileSystemWatcher; the profile watcher tails them.

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

## The idea list is `IDEAS.md`

Feature ideas live in **`ideas.json`** at the repo root — the source of truth, shared by the
user's Ideas board app (`Ideas.cmd`, source in `ideas/`) and by you. `IDEAS.md` beside it is
GENERATED from it on every save: never hand-edit that file, your changes will be overwritten.

Propose into **Proposed**; only the user moves things to **Approved**, and only Approved work
gets built. Read the **Declined** entries before proposing anything — those are settled
decisions carrying their reasons, and re-pitching them wastes the user's attention. Declining
something requires a reason. Design waves and workflow fleets should be pointed at this file
so their output lands somewhere durable rather than in a transcript.

## Commit every completed change

Work is not finished until it is committed — don't leave a finished change sitting in the
working tree for the user to find and commit themselves. When a change is done and
verified (built and restarted for the tracker, screenshot-verified for the town), commit
it.

- One concern per commit. The tracker (`source/`) and Token Town (`town/`) are separate
  concerns: never bundle them into one commit.
- After a long agent/workflow session, commit before starting the next round of work, so
  a rewrite always has a clean point to fall back to.
- Commit on a branch, never straight to `main`.
- Don't push, open PRs, or amend earlier commits unless the user asks.
- `TokenTracker.exe`, `source/bin|obj|publish/`, `town/node_modules/` and
  `town/src/renderer/vendor/` are gitignored on purpose — the vendored three.js is
  restored by `npm install` in `town/`, so a fresh clone still runs.

## Quick debug builds

`& "$env:USERPROFILE\.dotnet\dotnet.exe" build source\TokenTracker.App.csproj` is the fast
compile check. The Debug exe only launches with `$env:DOTNET_ROOT = "$env:USERPROFILE\.dotnet"`
set — no machine-wide .NET Desktop Runtime is installed. Stop the root exe first (single instance).

## Never open a window on the user's screen to verify something

The user works on this machine while you do. Any verification that pops a window onto
their main monitor, steals focus, or leaves a stray process behind is unacceptable —
render offscreen instead, then read the PNG. Concretely:

- **Token Town (`town/`)** — the standalone Electron + three.js app. Do **not** run
  `npm start`, plain `npx electron .`, or click the tracker's "Town ↗" button to check a
  change. Use the built-in headless screenshot mode, which renders in a hidden window
  (no taskbar entry, no focus steal, no single-instance collision) and exits by itself:

  ```powershell
  npx electron . --shot=C:\abs\path\shot.png --shot-delay=7000   # add --hour=23 to test night
  ```

  Page errors are printed to stdout and also drawn into the app's own error banner, so a
  broken run is visible in the screenshot. Clean up strays with
  `Get-Process electron | Stop-Process -Force`.
- **Headless runs paint at a low frame rate.** Anything paced by per-frame `dt` will lag
  far behind in a screenshot, so keep verification-visible state (stats, labels, counters)
  on wall-clock timers — this is why `town.js` gates its footer on `performance.now()`.
- Restarting `TokenTracker.exe` itself is the documented exception: the tray app is what
  the user asked to have running, and it restores its previous window state.

## Verifying UI changes

Drive the running app with UI Automation: tabs are radio buttons findable by their Name
("Limits", "Insights", …) and selected via SelectionItemPattern. Screenshot with
`PrintWindow(hwnd, hdc, 2)` (PW_RENDERFULLCONTENT — a plain screen copy comes back blank for
this window). Beware DPI: `GetWindowRect` may return virtualized coordinates while PrintWindow
renders physical pixels, so size the bitmap by `GetDpiForWindow(hwnd) / 96.0`.

Screenshots in `docs/` are taken with the Settings → Hide personal data toggle on.
