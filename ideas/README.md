# Ideas

A drag-and-drop board for what to build next in Token Tracker and Token Town. Columns —
**Inbox · Proposed · Approved · Building · Shipped · Declined** — and cards you drag between
them. Add your own, triage what Claude proposes, approve or decline with a reason.

It is not a chat command and not a text file you hand-edit: it's a window you open.

## Open it

| how | what to do |
|---|---|
| **Desktop shortcut** (nicest) | double-click **Ideas** on the Desktop — make it once with the one-liner below |
| **`Ideas.cmd`** | double-click it in the repo root; works from any folder, leaves no console behind |
| **`npm start`** | from `ideas/`, if you're already at a prompt |

Make the shortcut once:

```powershell
powershell -ExecutionPolicy Bypass -File .\ideas\make-shortcut.ps1
```

It draws `ideas\Ideas.ico` (a lightbulb on the dark tile the other apps use), puts **Ideas**
on your Desktop pointing at `Ideas.cmd`, and is idempotent — run it again any time, and run
it again if you ever move the repo.

There is **no install and no packaging step**. Ideas borrows the Electron that Token Town
already downloaded (`town\node_modules\electron`). On a fresh clone, run `npm install` in
`town\` once; the launcher says so plainly if it's missing.

One trap worth knowing if you ever launch it by hand: pass Electron the **file**,
`ideas\src\main.js`, never the folder. Electron resolves a folder argument the way `require()`
does — extensions before directories — so `electron ideas` finds `ideas.json` sitting next to
the folder and tries to run the board's own data as the app.

## Where the data lives

| file | what it is |
|---|---|
| `ideas.json` (repo root) | **the source of truth.** Read and written by this app *and* by agent fleets. |
| `IDEAS.md` (repo root) | **generated** from `ideas.json` on every save. Human-readable, so git diffs of decisions stay meaningful. Output only — never parsed back (the single exception: the one-time migration when `ideas.json` doesn't exist yet). |
| `.ideas-backups/` (repo root) | `ideas.prev.json` — the copy each save replaced — plus anything quarantined and the pre-migration `IDEAS.md`. Read only when `ideas.json` itself won't parse. Not in git. |

Each card carries a stable id — `T-n` for Token Town, `K-n` for the tracker — so you can say
"approve T-3, decline T-5" in conversation and mean something exact. Ids are never reused and
never renumbered. Sizes: S ≈ an hour, M ≈ a session, L ≈ a whole agent wave.

## How agents share the file

`ideas.json` is the shared memory between you and the fleets that build these projects.

- Agents **propose** into Proposed with the next free id. They never write an Approved row.
- **Only you promote to Approved**, and agents may build only from Approved.
- **Declining requires a reason.** That reason is the whole point of the Declined column: it
  is what stops the next design wave re-pitching a settled decision.
- Work moves to Building when it starts and Shipped when it verifies and commits.

An agent can rewrite `ideas.json` while your window is open. The app watches the file and
reloads within about 200 ms, so an agent's proposals appear on the board without a restart.
There is no merge — this is a one-person board — but a save that does land on top of an
outside write says so, and the copy it replaced is in `.ideas-backups\ideas.prev.json`.
Writes are atomic (temp file + fsync + rename), so a crash mid-write leaves the old file
untouched, and a file that won't parse is renamed aside rather than overwritten.

## Back up, restore, reset

```powershell
Copy-Item .\ideas.json .\ideas-backup.json                        # keep a copy
Copy-Item .\.ideas-backups\ideas.prev.json .\ideas.json -Force    # roll back one save (close the app first)
Remove-Item .\ideas.json                                          # start over: re-seeds from IDEAS.md
```

`ideas.json` is small, sorted and plain — reading or fixing it in an editor is fine.

## Verify a change without a window

```powershell
.\Ideas.cmd --shot=C:\abs\path\out.png --shot-delay=2500
```

Given arguments, the launcher stays attached and passes them through, so you get the app's
stdout and its exit code. The shot renders offscreen — hidden window, no taskbar entry, no
focus steal — and the app exits by itself. Given no arguments it detaches instead, which is
what a double-click wants. Kill strays with
`Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`.
