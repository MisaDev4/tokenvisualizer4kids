# Local API

Token Tracker serves its data as read-only JSON over HTTP so other programs on the same
PC can use it. While the app is running (including minimized to the tray), the API is at:

```
http://localhost:5299/api
```

- **Local only.** The server binds the loopback interface — nothing is reachable from the
  network or other machines.
- **Read only.** Every endpoint is a GET; nothing can be changed through the API.
- **On by default.** Toggle it under **Settings → Local API for other apps**. The status
  line under the checkbox shows whether it's serving (or why it failed, e.g. port in use).
- **Port.** Default `5299`. To change it, exit the app, edit `ApiServerPort` in
  `%LOCALAPPDATA%\TokenTracker\settings.json`, and start it again.
- The **Hide personal data** setting only affects the app's own display — the API always
  returns real emails, project names, and paths.

Quick check that it's up:

```powershell
Invoke-RestMethod http://localhost:5299/api/status
```

```bash
curl http://localhost:5299/api/status
```

## Conventions

- All timestamps are **unix milliseconds** (UTC) unless the field says otherwise.
  `daily` day keys are local calendar dates (`YYYY-MM-DD`).
- Token counts are split into `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`;
  `total` = input + output + cacheRead + cacheWrite (reasoning is already inside output).
- `estimatedCost` values are USD at API list prices (LiteLLM catalog). `isPriced: false` /
  `unpricedEvents` mark events whose model had no price entry.
- Errors come back as JSON: `400` bad parameter, `404` unknown path (includes the endpoint
  list), `405` non-GET, `500` with an `error` message.

## Endpoints

### `GET /api` — index

Lists the available endpoints.

### `GET /api/status` — liveness / overview

```json
{
  "app": "TokenTracker",
  "serverTimeMs": 1752682000000,
  "databasePath": "C:\\Users\\me\\AppData\\Local\\TokenTracker\\usage.db",
  "eventCount": 48210,
  "pricing": "LiteLLM pricing cached 7/16/2026 9:02 AM",
  "limitsUpdatedMs": 1752681990000,
  "terminalsUpdatedMs": 1752681999000
}
```

`limitsUpdatedMs` / `terminalsUpdatedMs` are when those snapshots were last refreshed
(0 until the first refresh completes, a few seconds after app start).

### `GET /api/dashboard?range=<key>` — aggregated usage

The same data as the app's Dashboard tab: totals, per-model rows, and a gap-filled
time-bucketed series with per-model cost slices.

`range` (default `currentMonth`) is one of:
`last1`, `last4`, `last8`, `last12`, `last18`, `today`, `last24`, `last7`, `last30`,
`currentMonth`, `previousMonth`, `all`.

```json
{
  "totals": { "input": 178000, "output": 3200000, "cacheRead": 910000000,
              "cacheWrite": 41000000, "reasoning": 1200000, "messages": 5120,
              "eventCount": 4310, "sourceCount": 210, "total": 954378000,
              "estimatedCost": 412.55, "unpricedEvents": 0 },
  "models": [ { "client": "claude", "provider": "anthropic", "model": "claude-fable-5",
                "messages": 4100, "input": 120000, "...": "...", "estimatedCost": 390.12 } ],
  "buckets": [ { "startMs": 1752624000000, "messages": 310, "input": 9000, "...": "...",
                 "estimatedCost": 22.14,
                 "slices": [ { "model": "claude-fable-5", "cost": 21.0,
                               "tokens": 61000000, "messages": 290 } ],
                 "localStart": "2026-07-16T00:00:00" } ],
  "unit": "hour",
  "lastUpdatedMs": 1752681995000,
  "previousCost": 388.90
}
```

`unit` is the bucket size the server chose for the range (`minute1` … `hour`, `day`,
`month`). `previousCost` is the equivalent preceding window's cost (null for `all`).

### `GET /api/events?since=<ms>&limit=<n>` — live event feed (poll with a cursor)

Individual usage events **by when they were indexed** (`updatedMs`), oldest first.
This is the endpoint for "tell me what's new since I last asked":

1. First call: `/api/events?since=0` (or start from `serverTimeMs` to skip history).
2. Remember the returned `cursor`.
3. Next poll: `/api/events?since=<cursor>` — only rows indexed after that come back.

`limit` defaults to 400 (max 5000). While a response is streaming into a transcript, the
same `eventKey` can reappear across polls with growing token counts — treat `eventKey`
as the identity and take the latest values.

```json
{
  "serverTimeMs": 1752682000500,
  "cursor": 1752682000123,
  "count": 2,
  "events": [
    {
      "eventKey": "claude|abc123|42",
      "client": "claude",
      "provider": "anthropic",
      "model": "claude-fable-5",
      "sessionId": "8005908b-…",
      "timestampMs": 1752681998000,
      "updatedMs": 1752682000123,
      "tokens": { "input": 12, "output": 640, "cacheRead": 210000,
                  "cacheWrite": 4100, "reasoning": 512, "total": 214752, "isEmpty": false },
      "messages": 1,
      "estimatedCost": 0.0691,
      "isPriced": true
    }
  ]
}
```

### `GET /api/events/range?start=<ms>&end=<ms>&limit=<n>` — historical events

Same event shape, but selected **by when the usage happened** (`timestampMs`), ascending.
`start` is required; `end` defaults to now; `limit` defaults to 2000 (max 10000, newest
kept when the range holds more).

```powershell
$dayAgo = [DateTimeOffset]::UtcNow.AddDays(-1).ToUnixTimeMilliseconds()
Invoke-RestMethod "http://localhost:5299/api/events/range?start=$dayAgo"
```

### `GET /api/daily?days=<n>` — per-day totals

Local-calendar-day totals (tokens + estimated cost), ascending. `days` defaults to 365
(max 3650); alternatively pass `since=<ms>` directly.

```json
{ "sinceMs": 1721146000000,
  "days": [ { "day": "2026-07-15", "tokens": 812000000, "cost": 391.20 },
            { "day": "2026-07-16", "tokens": 96000000, "cost": 44.03 } ] }
```

### `GET /api/limits` — subscription rate limits

The latest snapshot of every account the app tracks (refreshed every ~60 s):
Claude accounts seen signing into Claude Code (`provider: "anthropic"`; the active one
is signed in right now) plus the ChatGPT account Codex uses (`provider: "openai"`,
read locally from Codex's own files — its `active` means Codex answered within the
last 30 minutes). Access tokens are never exposed.

```json
{
  "updatedMs": 1752681990000,
  "accounts": [
    {
      "id": "9f0c…",
      "email": "someone@example.com",
      "plan": "max",
      "rateLimitTier": "default_claude_max_20x",
      "isActive": true,
      "stale": false,
      "fetchedAt": "2026-07-16T16:46:30+00:00",
      "cooldownUntil": null,
      "provider": "anthropic",
      "limits": [
        { "label": "5h",   "percent": 34, "severity": "normal",
          "resetsAt": "2026-07-16T19:00:00+00:00" },
        { "label": "Week", "percent": 61, "severity": "warning",
          "resetsAt": "2026-07-21T07:00:00+00:00" }
      ]
    }
  ]
}
```

`stale: true` means the account has had no successful fetch recently, so its numbers are
the last known ones rolled forward. `cooldownUntil` is set when the Anthropic usage
endpoint rate-limited the account (HTTP 429): TokenTracker honors the server's
`Retry-After` and won't ask again before that time.

### `GET /api/terminals` — live Claude Code / Codex terminals

The latest terminal scan (refreshed every ~3 s). `state` is `ready`, `working`, or
`waiting` (mid-turn but quiet — likely a permission prompt); `app` is `claudeCode` or
`codex`.

```json
{
  "updatedMs": 1752681999000,
  "terminals": [
    { "sessionId": "8005908b-…", "projectName": "tokentracker",
      "projectPath": "C:\\Users\\me\\Desktop\\tokentracker", "state": "working",
      "lastActivity": "2026-07-16T16:46:38+00:00", "app": "claudeCode" }
  ]
}
```

## Client examples

**PowerShell — today's cost:**

```powershell
$d = Invoke-RestMethod "http://localhost:5299/api/dashboard?range=today"
"{0:C2} · {1:N0} tokens" -f $d.totals.estimatedCost, $d.totals.total
```

**Python — follow the live feed:**

```python
import requests, time

cursor = requests.get("http://localhost:5299/api/status").json()["serverTimeMs"]
while True:
    page = requests.get(f"http://localhost:5299/api/events?since={cursor}").json()
    cursor = page["cursor"]
    for e in page["events"]:
        print(e["model"], e["tokens"]["total"], f"${e['estimatedCost']:.4f}")
    time.sleep(3)
```

**Node.js — current 5-hour limit:**

```js
const { accounts } = await (await fetch("http://localhost:5299/api/limits")).json();
const active = accounts.find(a => a.isActive) ?? accounts[0];
const session = active?.limits.find(l => l.label === "5h");
console.log(`5h window: ${session?.percent ?? 0}% used`);
```

## Notes for integrators

- **Polling is the model.** There is no push/websocket channel. `/api/events` with the
  cursor is cheap (indexed on `updatedMs`); every 2–5 s is fine. Limits change on a ~60 s
  cadence and terminals on a ~3 s cadence, so polling those faster returns the same snapshot.
- **No CORS headers are sent** — deliberately, so web pages in a browser can't read the
  data. Browser-based consumers should proxy through their own local backend.
- **No authentication.** Anything running as you on this PC can read the API — the same
  trust level as the SQLite database and credential files it summarizes.
- As a last resort, the raw SQLite database at `%LOCALAPPDATA%\TokenTracker\usage.db`
  can be opened read-only by other tools, but it has no cost/limits/terminal data and its
  schema may change without notice; prefer the API.
