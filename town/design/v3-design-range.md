# Token Town v3 — RANGE SYNC (data layer design)

The town mirrors whatever time range Token Tracker has selected, live. Everything below is
confined to `town/src/datafeed.js`, `town/src/main.js`, `town/src/preload.js` and the feed-facing
part of `town/src/renderer/town.js`. **No C# is touched** (read-only reference).

---

## 0. Verified tracker semantics (re-read, with citations)

| fact | source |
|---|---|
| `SelectedRange` default `"currentMonth"`; `SessionGapHours` default 4; `ManualSessionStartMs` nullable | `source/AppSettings.cs:21,51,56` |
| Range change writes settings.json **immediately** (`_settings.Save()` before the refresh await) | `source/MainWindow.xaml.cs:1481-1483` |
| `Save()` = `File.WriteAllText` of the whole 45 KB doc — **not atomic**, torn reads are possible | `source/AppSettings.cs:123-130` |
| Key normalisation: `previousMonth→currentMonth`, unknown→`last7` | `source/MainWindow.xaml.cs:4285-4291` |
| `lastN` = `now.AddDays/AddHours(-N)` on a `DateTimeOffset` → exact 24 h multiples, **DST-agnostic** | `source/UsageDatabase.cs:1049-1061` |
| `today` = local midnight; `currentMonth` (and the `_` fallback) = local 1st-of-month 00:00 | `source/UsageDatabase.cs:1046,1056,1067` |
| `session`/`all` resolve to `(null,null)` and are overridden by the caller | `source/UsageDatabase.cs:1065-1066` |
| session start = `ManualSessionStartMs ?? ResolveSessionStartAsync(gap)`, `endMs = null` | `source/UsageDatabase.cs:299-307` |
| session gap SQL = newest `timestamp_ms` whose `LAG` gap ≥ gapMs, scanned over a **30-day lookback**; fallback `MIN(timestamp_ms)` in that lookback; else null | `source/UsageDatabase.cs:1009-1041` |
| the tracker itself coarsens buckets by range (15 min / hour / day) — precedent for §4 | `source/UsageDatabase.cs:905-921` |
| the Town button passes **no arguments** (`Arguments = "<townDir>"`) — the feed must discover the range itself | `source/MainWindow.xaml.cs:3396-3404` |

### Measured on the user's real DB (253 209 rows, 145 active days, 31.2 B tokens)

```
(bucket,model) rows, all time:  5 m 13 639 | 15 m 5 957 | 1 h 2 131 | 6 h 650 | 1 d 284
bucket rows w/o model dim:      5 m 10 981 | 15 m 4 407 | 1 h 1 430 | 6 h 394 | 1 d 150
rows today @5 m: 294        rows last-30-d @5 m: 7 138
full all-time GROUP BY @1 h incl. materialisation: 126 ms      @5 m: 55 ms
session gap (LAG) SQL over 30 d: 67 ms        SELECT MAX(timestamp_ms): 0.09 ms
span SUM over a day: 3 ms
```

Two consequences that shape the whole design: **the gap SQL is too expensive for a 2 s poll
(67 ms) while `MAX(timestamp_ms)` is free (0.09 ms)** → §3.3; and **5-minute resolution over a
month is 7 k rows while 1-hour resolution is ~450** → §4.

### Consequence for the rest of v3 (hand-off note)

Range becomes the town-size knob, and `townSize(T)=min(1200,32·(T/1e6)^(3/8))` already spans it
beautifully on this user's data: `last1` ≈ 138 buildings, `session` ≈ 300–500, `today` ≈ 500,
`currentMonth` ≈ 860, `all` → capped 1200. The milestone ladder tops out at 1 B, so for
`currentMonth`/`all` every named rung is passed during the opening cascade — the `m.tick`
(`+100M`) rung concept in `rungName()` is what carries those ranges; the monument agent should
scale its extravagance off `T` (which is now range-scaled) rather than off absolute rungs.

---

## 1. The epoch model (the core idea)

Every problem in this feature — rolling windows creeping forward, midnight, session breaks,
the per-day layout seed, when to tear the town down — is one problem: **when does the current
town stop being the right town?** Answer: at an *epoch* boundary.

```
epoch = (rangeKey, epochId)      epochId: string, deterministic, wall-clock derived
```

* The renderer already treats an `init` as an epoch reset (fade → `hardReset()` → `applyInit()`,
  `town.js:1476-1480`). The feed's whole job is to emit exactly one `init` per epoch.
* Within an epoch the anchor `range.startMs` is **frozen**, so `T` stays monotonic and the
  town never shrinks — the invariant the whole renderer is built on survives untouched.
* At an epoch boundary the anchor is recomputed *exactly* (`now − windowLen`), so drift never
  accumulates: staleness is bounded by one quantum, always at the trailing edge.
* `epochId` is deterministic from the wall clock (not from when the app happened to launch), so
  the layout seed derived from it is stable across restarts — reopening the town in the same
  epoch gives you back the *same* town.

### 1.1 Per-key table

`Q` = epoch quantum (how often the town is redrawn), `stale` = worst-case trailing surplus.

| key | window start | Q | stale | history bin (§4) | label | hero short |
|---|---|---|---|---|---|---|
| `session` | data-driven (§3) | on session change | 0 | 5 m (15 m if span > 6 h) | `Session · since 10:02` / `· pinned 10:00` | `this session` |
| `last1` | `now−1 h` | 15 min | 25 % | 5 m | `Last hour` | `the last hour` |
| `last4` | `now−4 h` | 30 min | 12 % | 5 m | `Last 4 hours` | `the last 4 h` |
| `last8` | `now−8 h` | 1 h | 12 % | 15 m | `Last 8 hours` | `the last 8 h` |
| `last12` | `now−12 h` | 1 h | 8 % | 15 m | `Last 12 hours` | `the last 12 h` |
| `last18` | `now−18 h` | 2 h | 11 % | 15 m | `Last 18 hours` | `the last 18 h` |
| `last24` | `now−24 h` | 2 h | 8 % | 15 m | `Last 24 hours` | `the last 24 h` |
| `today` | local midnight | local day | 0 | 5 m | `Today` | `today` |
| `last7` | `now−7 d` | local day | 14 % | 1 h | `Last 7 days` | `the last 7 days` |
| `last10` | `now−10 d` | local day | 10 % | 1 h | `Last 10 days` | `the last 10 days` |
| `last15` | `now−15 d` | local day | 7 % | 1 h | `Last 15 days` | `the last 15 days` |
| `last30` | `now−30 d` | local day | 3 % | 1 h | `Last 30 days` | `the last 30 days` |
| `currentMonth` | local 1st 00:00 | local day | 0 | 1 h | `August` (+` 2025` if not this year) | `this month` |
| `all` | `0` | local day | 0 | 6 h | `All time` | `all time` |

Why a *daily* quantum for `today`/`currentMonth`/`all` (which don't creep): it costs nothing and
it delivers the user's "different seed for each day" for free — the month town and the all-time
town are **redrawn every dawn** with a new layout, same numbers. Charm, at zero complexity.

Why not a tighter quantum on `last1`: a teardown + 138-house cascade is a *big* visual event.
Once per 15 min is a rhythm; once per 5 min is a nervous tic.

### 1.2 epochId + seed

```js
const dayIndex = ms => { const d=new Date(ms); return Math.floor((d - new Date(d.getFullYear(),0,1))/864e5) + d.getFullYear()*400; };
function epochIdOf(key, now, st) {                       // st = resolved session state
  if (key === 'session') return st.manual ? `session:pin:${st.startMs}` : `session:${st.startMs}`;
  const q = QUANTUM[key];                                 // ms, or DAY sentinel
  if (q === DAY) return `${key}:${dayIndex(now)}`;
  const slot = Math.floor((now - startOfDay(now)) / q);   // aligned to LOCAL midnight
  return `${key}:${dayIndex(now)}.${slot}`;
}
// 32-bit FNV-1a — the layout/river agent's town seed
const seedOf = s => { let h=0x811c9dc5>>>0; for (const c of s) { h^=c.charCodeAt(0); h=Math.imul(h,0x01000193)>>>0; } return h>>>0; };
```

`range.seed = seedOf(epochId)`, `range.seedStr = epochId`. Switching `today`→`session` changes
the key → a different seed → a visibly **different town**, which is exactly the user's ask.
`range.dayIndex` also ships, for anything that wants "today-ness" independent of the range.

---

## 2. Range resolution (exact, mirrors the C#)

```js
const HOURS = { last1:1, last4:4, last8:8, last12:12, last18:18, last24:24 };
const DAYS  = { last7:7, last10:10, last15:15, last30:30 };
const startOfDay   = ms => { const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
const startOfMonth = ms => { const d=new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

// MainWindow.xaml.cs:4285 verbatim
const normalizeRangeKey = k =>
  k === 'previousMonth' ? 'currentMonth'
  : (k === 'session' || k === 'today' || k === 'currentMonth' || k === 'all'
     || HOURS[k] !== undefined || DAYS[k] !== undefined) ? k : 'last7';

function resolveRange(key, now, cfg) {                 // → {startMs, lenMs|null, rolling}
  if (key === 'session')      return resolveSession(now, cfg);            // §3
  if (HOURS[key] !== undefined) return { startMs: now - HOURS[key]*3600e3, lenMs: HOURS[key]*3600e3, rolling:true };
  if (DAYS[key]  !== undefined) return { startMs: now - DAYS[key]*864e5,  lenMs: DAYS[key]*864e5,  rolling:true };
  if (key === 'today')        return { startMs: startOfDay(now),   lenMs:null, rolling:false };
  if (key === 'currentMonth') return { startMs: startOfMonth(now), lenMs:null, rolling:false };
  return { startMs: 0, lenMs: null, rolling: false };                     // 'all'
}
```

`lastN` uses plain arithmetic on purpose: `DateTimeOffset.AddDays` adds an exact TimeSpan, so the
tracker's "7 days" is 168 h across a DST boundary and so is ours. `today`/`currentMonth` use the
local calendar (`setHours`, `new Date(y,m,1)`) exactly like `DateTimeOffset(now.Year,…,now.Offset)`.
No `endMs` is ever applied — every supported range ends at `now` or in the future, and the town is
by definition live.

---

## 3. Session (the only data-driven range)

### 3.1 Resolution — mirrors `ResolveSessionStartAsync`

```sql
-- gapStmt (30-day bounded, exactly the C# window function)
SELECT timestamp_ms FROM (
  SELECT timestamp_ms, timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY timestamp_ms) AS gap
  FROM usage_events WHERE timestamp_ms >= ?)
WHERE gap >= ? ORDER BY timestamp_ms DESC LIMIT 1;
-- firstStmt fallback
SELECT MIN(timestamp_ms) AS m FROM usage_events WHERE timestamp_ms >= ?;
```

```js
function resolveSession(now, cfg) {
  if (cfg.manualStartMs != null)
    return { startMs: cfg.manualStartMs, lenMs:null, rolling:false, manual:true };
  const lookback = now - 30*864e5, gapMs = Math.max(1, cfg.gapHours) * 3600e3;
  const r = gapStmt.get(lookback, gapMs);
  const s = r ? Number(r.timestamp_ms) : Number(firstStmt.get(lookback)?.m ?? NaN);
  // no events in 30 days → an honest empty town, floored to the current bucket
  return { startMs: Number.isFinite(s) ? s : Math.floor(now/INT_MS)*INT_MS, lenMs:null, rolling:false, manual:false };
}
```

### 3.2 Manual pin

`ManualSessionStartMs` wins unconditionally (`?? `, `UsageDatabase.cs:304`). Pin set / cleared /
moved arrives via the settings poll (§5) and is an epoch change (`session:pin:<ms>`). Un-pinning
falls back to the gap query. The label switches to `Session · pinned 10:00`.

### 3.3 Live follow without the 67 ms query

A new session can begin **with no settings change at all** — the user goes quiet for 4 h and then
types. Re-running the LAG query every 2 s would burn 3 % of a core forever. But its semantics are
exactly "the newest event that follows a ≥ gap silence", and the feed is already polling:

```js
// once at init / on gap-hours change: full gapStmt.  Thereafter, O(1):
const m = Number(maxStmt.get().m || 0);                        // SELECT MAX(timestamp_ms) — 0.09 ms
if (!manual && lastEventMs && m > lastEventMs && m - lastEventMs >= gapMs) sessionStart = m;  // new session!
lastEventMs = Math.max(lastEventMs, m);
```

Identical outcome, 700× cheaper. Backfilled/imported old rows don't move `MAX`, so they can't
fake a session break; upserts of in-flight responses don't move it either.

---

## 4. Bucket streaming and aggregation

### 4.1 Two resolutions, never overlapping

* **Live tail** — `[tailStart, now]` at the native 5 min. `TAIL_MS = 2 h`, clamped to the range.
  This is the region the growth animation, the groves and the 2 s poll care about.
* **Folded history** — `[rangeStart, tailStart)` at `binMs`, chosen by *span*, not by key
  (self-tuning; the per-key column in §1.1 is what this rule produces):

```js
const binFor = span => span <= 6*3600e3 ? 5*60e3 : span <= 36*3600e3 ? 15*60e3 : span <= 45*864e5 ? 3600e3 : 6*3600e3;
const tailStart = Math.max(rangeStart, floorTo(now - TAIL_MS, binMs));   // binMs is a multiple of 5 min
```

`tailStart` is floored to `binMs`, so the last folded bin is whole and **no `b` value is ever
produced by both queries** — the renderer's `cell` map (`b|model`) cannot collide.

History rows **fold the model dimension away** (`model` omitted): v3 drops family attribution
entirely (user feedback #3), and it halves the payload. The live tail keeps `model` — the news
ticker can still say something cute about which model was busy this afternoon.

Row/byte budget with the measured numbers (worst cases):

| range | folded rows | tail rows | init JSON |
|---|---|---|---|
| `today` | ~180 @5 m | ~24 | ~14 KB |
| `last24` | ~250 @15 m | ~24 | ~15 KB |
| `last30` | ~450 @1 h | ~24 | ~25 KB |
| `currentMonth` | ~450 @1 h | ~24 | ~25 KB |
| `all` | **394** @6 h | ~24 | ~22 KB |

(vs. 13 639 rows / ~550 KB if `all` were streamed at 5 min.) One `init` costs 55–126 ms of SQLite,
once per epoch — i.e. at most once per 15 min, usually once a day.

### 4.2 Rows gain a width

```
{ b, w, tok, model? }      // w = bin width in ms; absent ⇒ 5 min (back-compat with demo mode)
```

`backfillGroves()` must read gaps as `next.b − (r.b + (r.w||INT_MS))`, otherwise a 6 h bin looks
like a 5 h 55 m "break". For `binMs ≥ 1 h` a grove means "a night / a day off", which is a nice
reading for long ranges — the layout agent may want to cap grove count on those.

### 4.3 The 2 s poll is unchanged in shape, plus catch-up

```js
send({ type:'buckets', now, buckets: readFine(Math.min(curBucket - INT_MS, lastSentBucket)) });
lastSentBucket = curBucket;
```

Today the poll re-reads only the last two 5-min intervals; if the machine sleeps or the process is
throttled for 20 minutes, those buckets are **never sent and their tokens are lost** (pre-existing
bug, trivially fixed here). Catch-up is capped at 12 h — beyond that, force a fresh `init` instead.

Cost is independent of range: the poll always reads the fine tail only.

---

## 5. Live follow of settings.json

```js
let stat = null, cfg = { key:'currentMonth', gapHours:4, manualStartMs:null, colors:{}, lat:null };
function pollSettings() {
  let st; try { st = fs.statSync(settingsPath); } catch { return; }         // missing file → keep defaults
  if (stat && st.mtimeMs === stat.mtimeMs && st.size === stat.size) return; // 45 KB read avoided
  let next; try { next = JSON.parse(fs.readFileSync(settingsPath,'utf8')); }
  catch { return; }            // torn WriteAllText — do NOT latch `stat`; next tick retries
  stat = st;
  const n = { key: normalizeRangeKey(String(next.SelectedRange ?? 'currentMonth')),
              gapHours: Number(next.SessionGapHours) || 4,
              manualStartMs: next.ManualSessionStartMs ?? null,
              colors: next.ModelColors || {}, lat: typeof next.TownLatitude==='number' ? next.TownLatitude : null };
  const epochish = n.key !== cfg.key || n.gapHours !== cfg.gapHours || n.manualStartMs !== cfg.manualStartMs;
  const cosmetic = !epochish && (JSON.stringify(n.colors) !== JSON.stringify(cfg.colors) || n.lat !== cfg.lat);
  cfg = n;
  if (epochish) { if (n.key === 'session') sessionDirty = true; reinit('settings'); }
  else if (cosmetic) send({ type:'config', colors: cfg.colors, lat: cfg.lat });   // no teardown
}
```

Three details that matter:

1. **Content compare, not mtime.** settings.json is 45 KB and the tracker rewrites *all of it* when
   the user switches tabs, resizes, recolours a model… Only the four range fields may rebuild the
   town.
2. **Torn reads are expected**, not exceptional — `File.WriteAllText` truncates then writes. On a
   parse failure we return *without* latching the new stat, so the next tick re-reads.
3. **Cosmetic changes get their own message.** Recolouring a model must not detonate the town.
   (New `{type:'config'}`; `main.js` caches the last one alongside `lastInit` for reload replay.)

### 5.1 The tick

Everything runs off the existing 2 s interval, in order: `pollSettings()` → session `MAX` check
(§3.3) → `epochIdOf(...)` compare → `reinit()` or `send(buckets)`. `reinit()` re-resolves the
range from scratch, rebuilds the folded history + tail, recomputes labels/seed/prev, and emits
`init`. Total per idle tick: one `stat`, one `MAX`, one fine bucket read ≈ **< 1 ms**.

---

## 6. Protocol v3

```jsonc
{ "type":"init", "v":3, "now":1786055837539,
  "range": {
    "key":"last24", "epochId":"last24:810512.4", "seed":2748193443, "seedStr":"last24:810512.4",
    "startMs":1785969437539, "lenMs":86400000, "rolling":true, "manual":false,
    "dayIndex":810512, "binMs":900000, "tailStartMs":1786048800000,
    "label":"Last 24 hours", "short":"the last 24 h", "sinceLabel":"09:12"
  },
  "prev": { "tok":1922485447, "label":"beat the previous 24 h" },   // nullable
  "colors":{}, "lat":52.2,
  "sessionStartMs":1785969437539,        // legacy alias of range.startMs — keep one release
  "buckets":[ {"b":1785969600000,"w":900000,"tok":41235}, … ,
              {"b":1786048800000,"w":300000,"model":"claude-opus-5","tok":80421} ] }

{ "type":"buckets", "now":…, "buckets":[{"b":…,"w":300000,"model":…,"tok":…}] }
{ "type":"config",  "colors":{…}, "lat":52.2 }        // cosmetic only, never resets
{ "type":"error",   "message":"…" }
```

* `prevDayTok` is generalised to `prev` (§7).
* Every `init` is an **epoch reset** iff `range.epochId` differs from the one in force; a repeat of
  the same `epochId` (e.g. `main.js` replaying `lastInit` after a renderer reload, `main.js:105`)
  must be merged idempotently — the existing `cell`-max merge already does exactly that.
* `w` and the missing `model` on folded rows are the only breaking shape changes; both degrade
  safely (`w ??= 5 min`, `model ??= ''`).

### 6.1 Labels

`label` is the header badge, `short` fills the footer hero label (`tokens ${short}`) and the empty
hint (`No tokens ${short} yet.`). `sinceLabel` is the honest trailing-edge disclosure for rolling
windows — the footer reads `Last 24 hours · since 09:12`, so the ≤ 8 % surplus is never a lie.
Month label = `toLocaleString(undefined,{month:'long'})`, plus the year when it isn't this year.

---

## 7. "Beat your last …" — the range-aware personal best

`spliceBestRung(tok)` (`town.js:88`) becomes `spliceBestRung(tok, label)`:

| range | previous window | rung label |
|---|---|---|
| `today` | `[midnight−24 h, midnight)` | `beat yesterday` |
| `currentMonth` | previous calendar month | `beat last month` |
| `lastN` | `[start−len, start)` | `beat the previous N h/d` |
| `session` | the session before this one (`gapStmt` bounded above by `sessionStart`) — span `[prevStart, sessionStart)` | `beat your last session` |
| `all` | — | no rung |

One extra `SUM` (3 ms) per epoch, plus one extra bounded LAG query (67 ms) for `session` only.

---

## 8. Renderer contract (`town.js`) — precise diff

1. `applyInit(msg)` — replace the `ss > sessionStart || sum < .25*Tfloor` heuristic
   (`1259-1268`) with the epoch compare:
   ```js
   const rg = msg.range || legacyRange(msg);      // demo/older feeds
   if (gotData && rg.epochId !== curRange.epochId) { pendingInit = msg; fadeT = performance.now(); return; }
   curRange = rg; sessionStart = rg.startMs;
   setTownSeed(rg.seed);        // BEFORE syncTown() — the layout/river module reads it at build time
   spliceBestRung(msg.prev?.tok, msg.prev?.label);
   ```
2. `applyBuckets()` — **delete** the synthesised midnight rollover (`1290-1301`) and `dayKey`.
   The feed owns rollover now, and leaving both in place double-fires the reset.
3. `hardReset()` — unchanged except `rebuildLegend()` → `renderRangeBadge()`. The
   `fadeT → hardReset() → applyInit()` path at `1476-1480` stays exactly as is: it is the epoch
   reset, and it already re-runs the cascade.
4. Header: `#legend` (dead — families are gone) → `#rangeBadge`, reusing `.chip`:
   `🕒 Last 24 hours · since 09:12`. Same DOM slot, same CSS, no layout work.
5. Footer: drop the per-family chips (`1605-1606`); hero label `tokens today` → `tokens ${short}`;
   the trailing `since <b>HH:MM</b>` chip becomes `${label} · since ${sinceLabel}` (kept
   wall-clock-paced inside the existing 500 ms `statAt` block — headless shots must show it).
6. News ticker hook: `onEpoch(range, prevRange)` fires from `applyInit` on a *changed* key
   (`"Word from the capital — the chronicle now covers the last 24 hours."`) and on a same-key
   redraw (`"Dawn. The surveyors have re-laid the streets."`). Copy belongs to the ticker agent.
7. `backfillGroves()` — honour `r.w` (§4.2).
8. Demo mode (`1336-1370`) — synthesise `range: {key:'demo', epochId:'demo:0', seed:seedOf('demo'),
   startMs:…, label:'Demo day', short:'today', binMs:INT_MS}`, honouring `?range=` for label
   testing. The no-bridge path must keep working unchanged otherwise.

`main.js`: forward `range` (and `gap`, `session-start`) in the query list (`77`), **and** pass them
to the feed spawn (`48`) as `--range=…` — the renderer has no channel back to the feed, so a
`?range=` that only reached the page would be cosmetic. Also cache the last `config` next to
`lastInit` for reload replay. `preload.js` needs no change.

---

## 9. Test hooks

```powershell
cd <repo>\town
$S="%TEMP%\claude\<project>\<session-id>\scratchpad"
npx electron . --shot=$S\r-session.png --shot-delay=9000 --range=session
npx electron . --shot=$S\r-1h.png      --shot-delay=9000 --range=last1
npx electron . --shot=$S\r-all.png     --shot-delay=9000 --range=all --hour=23
npx electron . --shot=$S\r-epoch.png   --shot-delay=25000 --range=last1 --epoch-quantum=8000   # forces a live epoch reset mid-shot
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

* `--range=<key>` — overrides `SelectedRange` **without touching the user's settings.json**
  (settings are still polled for gap/pin/colors). Invalid keys go through `normalizeRangeKey`.
* `--gap=<hours>`, `--session-start=<ms>` — session testing without pinning the real tracker.
* `--epoch-quantum=<ms>` — shrinks the quantum so a screenshot run can prove the teardown/rebuild.
* The feed logs the resolved range to stderr (`main.js:51` already prints `[datafeed]`), so a shot
  run shows `range=last24 start=… bins=250+24 epoch=last24:810512.4` in the console.
* Non-visual: a `node scripts/range-check.js` harness asserting each of the 14 keys' `startMs`
  against the C# formula, `epochId` stability across two calls in the same quantum, folded+tail
  sums equalling the ungrouped `SUM` for that window, and row counts within budget.

---

## 10. Edge cases

| case | behaviour |
|---|---|
| settings.json missing / unreadable | defaults (`currentMonth`, gap 4, no pin) — matches `AppSettings.Load()` |
| torn settings read | skip, don't latch stat, retry in 2 s (§5) |
| no events at all / empty window | `startMs` floored to the current bucket, empty town, hint `No tokens today yet.` |
| `all` on an empty DB | `startMs = 0`, zero buckets, no `prev` rung |
| machine sleeps 3 h | `now` jumps → epoch changes → clean rebuild; catch-up read covers the tail |
| DST shift | epochId recomputed from the local calendar each tick → at most one extra rebuild |
| user hammers the range buttons | each write is an epoch change, but the renderer's 2 s fade absorbs it: `pendingInit` is simply overwritten before the fade completes (`1480`) — last one wins, no queue |
| range switch to a range with *less* data (`all`→`last1`) | epoch reset ⇒ `Tfloor` cleared in `hardReset()`, so the town legitimately gets smaller. This is the only way the town shrinks, and it is user-initiated |
| clock set backwards | epochId changes → rebuild; `lastSentBucket` guard clamps the catch-up read |

---

## 11. Implementation checklist

**`datafeed.js`** (the bulk): `normalizeRangeKey` / `resolveRange` / `resolveSession` / `epochIdOf`
/ `seedOf` / `labelOf`; `gapStmt`, `firstStmt`, `maxStmt`, parameterised `coarseStmt`, `fineStmt`;
`pollSettings` with stat+content compare and torn-read retry; `reinit()`; the 2 s tick order;
`--range/--gap/--session-start/--epoch-quantum` argv; stderr range log. ~200 lines net.
**`main.js`**: forward + spawn-pass the new flags; cache last `config`. ~10 lines.
**`town.js`**: §8 items 1-8. ~60 lines net, mostly deletions (family legend, dayKey rollover).
**`preload.js`**: none.

Ship order: protocol + resolution + init (screenshot each key) → live follow → folding → labels /
badge / ticker hook. Steps 1 and 2 are independently verifiable with `--range=`.
