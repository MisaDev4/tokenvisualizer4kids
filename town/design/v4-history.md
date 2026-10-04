# Token Town v4 — HISTORY & CONTINUITY

*Design for the layer that makes days add up. Written against the v3 code as it stands on
2026-08-06 (town.js 2158 lines, datafeed.js 501, layout/environs/buildings/monument/npcs/news).
Read `REDESIGN-V3.md` §0–2, §11, §13–14 first; §14.5 explicitly deferred "yesterday's ghost
ring" to a later wave — this is that wave, done differently and better.*

---

## 0. THE ONE IDEA

**The chronicle is *derived*; the file on disk is a keepsake, not a source of truth.**

Everything the history layer wants to show is already a pure function of two things the app
already has:

1. `usage.db` — read-only, holds every token event ever indexed, back further than the town
   has existed.
2. The seed algebra in `datafeed.js` — `identityOf('today', ms)` = `` `today:${dayIndex(ms)}` ``
   and `seed = FNV-1a(identity)`. `dayIndex` is invertible. Therefore **every past day's town —
   its seed, its street plan, its archetype, its name, its palette, its size — is
   reconstructible from a calendar date alone.** No storage required.

Consequences that shape the whole design:

* There is **no migration risk on the load-bearing data**. Delete the file and the chronicle
  rebuilds itself on the next launch, complete.
* The persisted file holds only what the DB cannot know: preferences, "you were here", the
  clock-time of an overtaking, and any towns the user chooses to keep. ~90 bytes per day.
* **Day one is already rich.** A user whose tracker has three months of history opens v4 to a
  populated kingdom map and a Chronicle Stone with real records on it. There is no empty state
  to design around, only a first-ever-launch one (§8.7).

---

## 1. TONE CONTRACT — the anti-guilt rules (non-negotiable)

Usage guilt is the failure mode that would kill this feature. Six rules; every item below is
built to satisfy them, and a reviewer should reject anything that breaks one.

**R1 — Quiet days are green, never grey.** A day with no tokens is not a gap, a ruin, a
greyed-out cell or a broken chain. In the kingdom map it is a *meadow glyph*. In copy it is
"restful". The town already does this beautifully with groves ("idle time plants woodland");
history inherits that metaphor wholesale. Never render an absence as damage.

**R2 — Records are engraved, not chased.** The Chronicle Stone shows a personal best as an
inert engraved fact. It gets a *progress bar only when the live total is already within 80 % of
the record* (`live >= 0.80 * record`). Below that, no bar, no percentage, no "to go". A meter
pinned at 4 % all day is a reproach.

**R3 — Streaks may be gained, never lost.** The bunting only ever goes up. When a spell ends,
nothing is taken down, nothing flashes, no line is filed. The old spell silently becomes a
record ("longest spell: 14 days"). There is no "you broke your streak" state in this design and
there must never be one. Streaks are also the one element with an off switch (§4.4 prefs).

**R4 — Comparison is a pace partner, never a verdict.** v3 already got this right with
`prev.atTok`. History extends it only in the *upward* direction: the Overtaking (§7.6) is a
one-time celebration that can only fire on success. There is no symmetric "you fell behind"
event, ever. Deficits are stated as distance ("**412.7M** to go"), never as failure ("behind").
*Recommended v4 copy fix in the existing footer:* `▼ 60.2M behind yesterday` → `60.2M to go to
match yesterday` — same fact, no verdict. (town.js:2099. Flagged, not required.)

**R5 — The app never asks for more.** No targets, no goals, no notifications, no "keep it up",
no daily reminder. The town exists only while the user is already working. Nothing in the
history layer initiates.

**R6 — The only rival is past-you, and only in the past tense.** No aggregate stats framed as
performance, no "average day", no trendline pointing down. "Average" is a judgement device; the
chronicle uses *median* only inside the pace weather that already exists, and never displays it.

---

## 2. ARCHITECTURE

Three new files. Zero lateral imports (the v3 house rule survives intact): `town.js` remains the
sole mediator and hands each module what it needs through `cfg`.

```
src/renderer/chronicle.js   PURE DATA + one canvas painter. Imports NOTHING.
                            Node-testable exactly like layout.js.
src/renderer/memorial.js    3D: the Chronicle Stone, the horizon ghost, the bunting.
                            Imports THREE only.
src/renderer/almanac.js     DOM: the header strip, the Almanac card, the Kingdom Map.
                            Imports nothing (DOM + Canvas2D).
```

`paintSkyline` lives in **chronicle.js** (pure painter taking a `CanvasRenderingContext2D`, the
same pattern as `plan.paintGround`) and town.js passes it down to memorial and almanac in their
cfg. That is what keeps memorial and almanac from importing each other.

Existing files touched, all additively:

| file | what | collision risk |
|---|---|---|
| `src/datafeed.js` | one new `chronicle` block on `init`, one `todayTok` field | **medium** — task #8 is in this file |
| `src/main.js` | 2 IPC handlers + atomic writer + 4 forwarded query flags | low |
| `src/preload.js` | `townAPI.history.{load,save}` | none |
| `src/renderer/town.js` | wiring, `ctx.chronicle`, `tipFor` delegation, demo synth | **high** — everyone edits town.js |
| `src/renderer/news.js` | 4 corpus categories, 3 `CAT_OF` entries, 5 slots | **medium** — task #7 |
| `src/renderer/index.html` | 1 header `<span>`, ~40 lines CSS | low |
| `src/renderer/layout.js` | 1 new export `archetypeOf(seed)` (3 lines) | low |
| `src/renderer/environs.js` | *optional* `farLandColor` getter (C5) | high — skip it in wave 1 |

---

## 3. THE DATA PATH

### 3.1 datafeed.js — the `chronicle` block

The feed already owns "where data comes from". It gains exactly two responsibilities: per-local-day
totals, and today's live total.

**DST-safe daily fold.** There is no timezone function in SQLite, and a fixed-offset
`GROUP BY (ts/86400000)` is wrong across DST and in half-hour zones. Aggregate at 15 minutes in
SQL — which is exact for every real zone including `Asia/Kathmandu` (+5:45) and
`Pacific/Chatham` (+12:45) — and fold to local days in JS with the *same* `dayIndex()` the epoch
algebra already uses.

```js
const CHRON_DAYS   = 400;                    // 13 months — enough for a year-in-review
const CHRON_BIN    = 15 * MIN_MS;
const CHRON_MAX_MS = 10 * MIN_MS;            // recompute at most this often

const chronStmt = db.prepare(`
  SELECT (timestamp_ms / ${CHRON_BIN}) * ${CHRON_BIN} AS b, SUM(${TOK_SUM}) AS tok
  FROM usage_events WHERE timestamp_ms >= ?
  GROUP BY b ORDER BY b`);

let chronCache = null, chronAt = -1e9, chronDayIdx = -1;

/** @returns {{days:number[], firstMs:number, builtMs:number}}
 *  `days` is FLAT and ascending: [dayIdx0, tok0, dayIdx1, tok1, …]. Days with zero
 *  tokens are OMITTED (R1: absence is not data; the renderer fills meadows). */
function buildChronicle(now) {
  const from = startOfDay(now) - (CHRON_DAYS - 1) * DAY_MS;   // ~13 months back, DST-slack ok
  const rows = chronStmt.all(from);
  const acc = new Map();                                       // dayIdx -> tok
  let firstMs = 0;
  for (const r of rows) {
    const b = Number(r.b), tok = Number(r.tok);
    if (!(tok > 0)) continue;
    if (!firstMs) firstMs = b;
    const k = dayIndex(b);                                     // LOCAL, DST-exact
    acc.set(k, (acc.get(k) || 0) + tok);
  }
  const keys = [...acc.keys()].sort((a, b) => a - b);
  const days = new Array(keys.length * 2);
  for (let i = 0; i < keys.length; i++) { days[i*2] = keys[i]; days[i*2+1] = acc.get(keys[i]); }
  return { days, firstMs, builtMs: now };
}

function chronicleFor(now) {
  const di = dayIndex(now);
  if (chronCache && di === chronDayIdx && now - chronAt < CHRON_MAX_MS) return chronCache;
  try { chronCache = buildChronicle(now); chronAt = now; chronDayIdx = di; }
  catch (e) { log('chronicle failed: ' + e.message); }          // NEVER fail an init over history
  return chronCache;
}
```

Cost: on a heavy user the 15-min bins are sparse (~60 active bins/day × 400 days ≈ 24 000 rows,
`ix_usage_events_timestamp` covers the scan). **Measure it in the implementation harness. If the
first build exceeds 150 ms, drop `CHRON_DAYS` to 120 and note it in the header comment** — the
kingdom map degrades gracefully to a quarter-year.

`todayTok` is a separate, near-free indexed sum, and it is what keeps the streak and the ghost
race live regardless of which range the user has selected:

```js
const todayTokFor = now => readSpan(startOfDay(now), now + 1);   // < 5 ms, existing spanStmt
```

**Protocol additions (v4).** `init` gains two fields; nothing else changes, and every one of them
is optional so an older renderer against a newer feed (and vice versa) still runs:

```jsonc
{ "type":"init", "v":4, …,
  "todayTok": 412719834,
  "chronicle": { "days":[810512,1922485447, 810513,412719834, …],
                 "firstMs":1751328000000, "builtMs":1786060000000 } }

{ "type":"buckets", "now":…, "buckets":[…], "todayTok": 412899102 }   // at most once / 30 s
```

Bump `v` to 4 and keep accepting v3 (`msg.chronicle` absent ⇒ the history layer is simply
dormant — every visual element below no-ops on an empty chronicle). Message size at 400 days ≈
8 KB, sent once per epoch.

### 3.2 `chronicle.js` — the model

Pure. No THREE, no DOM (the painter takes a context that the caller owns). Testable head-lessly
in the scratchpad exactly the way `layoutcheck.mjs` tests layout.

```js
export const CHRONICLE_V = 1;

/* ── the calendar, both ways. dayIndex is the feed's, verbatim. ── */
export const dayIndexOf = ms => { const d = new Date(ms);
  return d.getFullYear() * 400 + Math.round(
    (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 864e5); };
/** Inverse of dayIndexOf. Local-constructor, so DST-exact. */
export const dateOfDayIndex = idx => new Date(Math.floor(idx / 400), 0, 1 + (idx % 400));
/** The palette seed for a past day — town.js's own daySeedOf, by date. */
export const daySeedOfIndex = idx => { const d = dateOfDayIndex(idx);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
/** The plan seed for a past day: FNV-1a of the feed's identity string. */
export const planSeedOfIndex = idx => fnv1a('today:' + idx);

/**
 * @typedef {Object} Day
 * @property {number} idx     dayIndex
 * @property {number} tok
 * @property {number} n       townSize(tok) — DERIVED, never stored
 * @property {number} ms      local midnight of that day
 * @property {string} label   "Tue 4 Aug"        @property {string} longLabel "Tuesday 4 August 2026"
 * @property {number} seed    planSeedOfIndex    @property {string} name  injected namer
 * @property {string} kind    injected archetype @property {boolean} live true only for today
 */
/**
 * @typedef {Object} Spell   an unbroken run of days with tokens
 * @property {number} len @property {number} startIdx @property {number} endIdx
 */

/**
 * @param {Object} opts
 * @param {(idx:number)=>{name:string,kind:string}} opts.identify  town.js injects
 *        (townNameFor(seed) from news.js, archetypeOf(seed) from layout.js)
 * @param {(tok:number)=>number} opts.sizeOf   town.js injects townSize
 * @param {{load:()=>Promise<object>, save:(patch:object)=>void}} [opts.store]
 * @param {()=>number} [opts.now]
 */
export function initChronicle(opts) → Chronicle
```

`Chronicle` surface — every getter is O(1) off a rebuilt-on-ingest index, so town.js's 500 ms
tick can read it freely:

| member | contract |
|---|---|
| `ingest(msg)` | takes an `init` message. Adopts `msg.chronicle`, `msg.todayTok`. Idempotent. |
| `setLive(tok)` | today's live total (town.js calls it when `ctx.rangeKey==='today'\|'session'`, else the feed's `todayTok` stands). Monotonic — never lowers today. |
| `get ready` | false until the first `ingest` with a `chronicle` block. **Every consumer must render *nothing* while false** — no placeholder stone, no empty strip. |
| `get days()` | `Day[]` ascending, quiet days omitted. |
| `get today()` | `?Day` (`live:true`) |
| `get yesterday()` | `?Day` — the most recent day *before* today **that has tokens**; `null` if none in 400 days. Skipping quiet days is R1: the ghost on the horizon is the last town that existed, not an empty field. |
| `dayAt(idx)` | `?Day` |
| `get spell()` | `?Spell` — the run ending today or yesterday. `null` if len < 2. |
| `get records()` | `Records` (§3.3) |
| `rankOf(tok)` | `{rank, of}`; rank 1 = best ever. Ties resolve to the older day. |
| `pressure()` | `?{key,label,record,live,frac}` — a record within reach *only* if `frac >= 0.80` (R2). Returns `null` otherwise. This is the single gate every progress bar in the layer must go through. |
| `recordsBrokenBy(tok)` | `Break[]` — records the live total has just beaten *and that have not been announced this epoch*. Self-latching; safe to call at 2 Hz. |
| `onThisDay()` | `?Day` — the same calendar date in a previous year, if it has tokens (C4). |
| `prefs` / `setPref(k,v)` | `{showStreaks:true, ghost:true, strip:true}` |
| `note(idx, patch)` | records a non-derivable fact (`seen`, `overtookMs`, `kept`). Debounced save. |
| `summaryFor(idx)` | the Almanac card's payload (§7.4) |
| `paintSkyline(g, spec, o)` | the shared painter (§3.4) |
| `toJSON()` | the save patch |

`Records`:

```js
{ bestDay:   {idx, tok, label},          // greatest single day
  bestSpell: {len, startIdx, endIdx},    // longest unbroken spell
  largest:   {idx, n, label},            // largest township = sizeOf(bestDay.tok)
  firstMs,                               // first token ever indexed
  kept:      42,                         // days the user has opened the town (persisted)
  earliestOvertake: {idx, hhmm} | null } // persisted
```

`largest` is deliberately derived from `bestDay` rather than stored — `N = min(1200,
floor(32·(T/1e6)^(3/8)))` is the town's own growth law, so the record can never disagree with
what the user saw.

### 3.3 Derivation rules (write these as asserts in the harness)

* `n = min(1200, floor(32 * (tok/1e6) ** 0.375))` — identical to `townSize` in town.js.
* Milestones reached on a past day = `LADDER.filter(m => m.tok <= day.tok).length`. Derived,
  never stored, so a change to the ladder retro-fits the whole chronicle consistently.
* A day is **quiet** iff it has no row in `chronicle.days`. There is no threshold to tune and
  no "barely counts" band — a single token is a day.
* Today is always `live` and always monotonic within a session.

### 3.4 `paintSkyline(g, spec, o)` — one painter, four consumers

The single highest-leverage function in this design. It draws a town's *silhouette* into a 2D
context and is used by the horizon ghost, the header strip, the Almanac card and the Kingdom
Map. Two fidelities:

```js
/**
 * @param {CanvasRenderingContext2D} g   caller owns the canvas and its size
 * @param {Object} spec
 * @param {number} spec.seed    planSeedOfIndex(idx)
 * @param {number} spec.n       buildings
 * @param {number} spec.tier    monument tier 0..10 (derived from tok via LADDER)
 * @param {number} spec.marks   landmarks unlocked (0..9) — one spire each
 * @param {?Plan}  spec.plan    HIGH FIDELITY: real plotAt() positions, orthographic elevation
 * @param {Object} o
 * @param {string} o.ink        silhouette fill (already haze-mixed by the caller)
 * @param {string} [o.lit]      window colour; when set, paints the NIGHT layer only
 * @param {number} [o.baseline] 0..1 fraction of height that is ground (default .92)
 * @param {number} [o.jitter]   0..1 skyline roughness (default 1)
 */
export function paintSkyline(g, spec, o) { … }
```

*Cheap mode* (`spec.plan` absent): a seeded run of rectangles across the width — count
`clamp(round(sqrt(n) * 2.2), 6, 90)`, heights `h = base * (0.55 + 1.15 * r^1.8)` with `base`
scaled by `log10(n)`, plus `marks` spires at seeded positions with pitched or domed caps, plus
one taller altar silhouette at the horizontal centroid whose shape steps with `tier`. Runs in
under 1 ms; this is what 400 kingdom-map villages and 14 header thumbnails use.

*High fidelity* (`spec.plan` given): project `plan.plotAt(i)` for `i < n` onto a fixed bearing,
sort by depth, draw each as a rectangle of width `PLOT_D*scale` and height from the tier curve
`TIER_H`. Costs one `buildPlan` (≈60 ms) — used for **the horizon ghost only**, generated once
per epoch off the critical path via town.js's `schedule()`.

`o.lit` produces the night layer: the same silhouette but transparent except for warm window
dots, so the ghost can be lit after dark (§5.2).

---

## 4. STORAGE

### 4.1 Location and shape

`app.getPath('userData')` → `%APPDATA%\token-town\chronicle.json`. **Never** `%LOCALAPPDATA%\
TokenTracker\` — the tracker's directory is read-only to this app and must stay that way; a file
written next to `usage.db` would also be a support-report hazard.

```jsonc
{
  "v": 1,
  "app": "token-town",
  "writtenMs": 1786060213441,
  "prefs": { "showStreaks": true, "ghost": true, "strip": true },
  "days": {                                  // ONLY non-derivable facts, keyed by dayIndex
    "810512": { "seen": 1, "overtookMs": 1785997920000 },
    "810513": { "seen": 1, "kept": 1 }
  },
  "stats": { "kept": 42, "firstSeenMs": 1783400000000 }
}
```

Everything else — totals, names, archetypes, sizes, records, streaks — is **absent by design**
and recomputed from `usage.db` on every launch. Size at 800 days ≈ 40 KB. Prune on write: keep
the newest 800 keys, always keep any key with `kept:1`.

### 4.2 IPC contract

`preload.js` (sandbox-safe — `ipcRenderer` is available in a sandboxed preload):

```js
contextBridge.exposeInMainWorld('townAPI', {
  onData: cb => ipcRenderer.on('town:data', (_e, msg) => cb(msg)),
  ready:  () => ipcRenderer.send('town:ready'),
  history: {
    load: () => ipcRenderer.invoke('town:history:load'),   // → Promise<doc>  never rejects
    save: patch => ipcRenderer.send('town:history:save', patch)   // fire-and-forget
  }
});
```

`main.js`:

```js
const HIST_V = 1, HIST_MAX_DAYS = 800, HIST_DEBOUNCE = 4000;
let histDoc = null, histTimer = null;

function histPath() { return path.join(app.getPath('userData'), 'chronicle.json'); }

function histDefault() { return { v: HIST_V, app: 'token-town', writtenMs: 0,
  prefs: { showStreaks: true, ghost: true, strip: true }, days: {}, stats: { kept: 0 } }; }

function histLoad() {
  if (histDoc) return histDoc;
  const p = histPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || !doc.days) throw new Error('shape');
    if ((doc.v | 0) > HIST_V) { histDoc = doc; histReadOnly = true; return histDoc; }  // a NEWER
      // build owns this file: read what we understand, never write it back.
    histDoc = migrate(doc);
  } catch (e) {
    quarantine(p);                       // rename to chronicle.corrupt-<ts>.json, keep 2
    histDoc = histDefault();
  }
  return histDoc;
}

// Atomic: tmp + fsync + rename. A half-written keepsake must never replace a good one.
function histFlush() {
  if (histReadOnly || !histDoc) return;
  const p = histPath(), tmp = p + '.tmp';
  histDoc.writtenMs = Date.now();
  prune(histDoc);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(histDoc)); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(tmp, p);
  } catch { /* a keepsake is not worth an error banner */ }
}

ipcMain.handle('town:history:load', () => histLoad());
ipcMain.on('town:history:save', (_e, patch) => {
  const doc = histLoad();
  if (patch && patch.prefs) Object.assign(doc.prefs, patch.prefs);
  if (patch && patch.stats) Object.assign(doc.stats, patch.stats);
  if (patch && patch.days) for (const k in patch.days) doc.days[k] = Object.assign(doc.days[k] || {}, patch.days[k]);
  clearTimeout(histTimer); histTimer = setTimeout(histFlush, HIST_DEBOUNCE);
});
app.on('before-quit', () => { clearTimeout(histTimer); histFlush(); });
```

`MIGRATIONS = { }` is empty at v1; the machinery exists so v2 has somewhere to land. The rule for
future versions: **a migration may only add or drop keys, never recompute a value** — anything
that needs recomputing is derived anyway.

### 4.3 Degradation matrix (all four must be tested)

| condition | behaviour |
|---|---|
| no bridge (plain browser / `--feed=demo`) | in-memory store; `?chronicle=demo` synthesises 46 days (§8.6) |
| file missing | defaults, zero user-visible difference except `records.kept` |
| file corrupt | quarantined, defaults; **no banner, no console error the user sees** |
| file from a newer `v` | read-only mode: chronicle works, nothing is written back |
| `usage.db` chronicle query fails | `msg.chronicle` omitted; the whole layer stays dormant (`ready === false`) and the town renders exactly as v3 |
| disk full / EACCES on write | swallowed; the session keeps working, the keepsake is just not updated |

### 4.4 Preferences

Three toggles, all in the file, all reachable from the Kingdom Map's footer (the only settings
surface this app will ever have — it never writes the tracker's `settings.json`):

* **`showStreaks`** — bunting + spell copy. Default **on**, but this is the R3 escape hatch and
  it must be one click away and remembered.
* **`ghost`** — the town on the horizon. Default on.
* **`strip`** — the header's 14-day strip. Default on.

---

## 5. WHAT THE RENDERER SHOWS — the 3D layer (`memorial.js`)

```js
export function initMemorial(scene, cfg) → Memorial
/* cfg: { maxAnisotropy, paintSkyline, plazaR:()=>number, innerR:()=>number,
          gate:()=>({x,z,yaw}), sampleHeight:(x,z)=>number, accent:()=>number,
          fogColor:THREE.Color, seed:number } */
```

`Memorial` = `{ group, setView(v), setPlan(plan, seed), setGhostArt(canvas, nightCanvas),
setApparentScale(k), update(dt, now, ctx), reset(), dispose(), get ents() }`.

`ents` is `[{group, ent}]` where each `ent` carries `kind` and **`tip: () => [a,b,c]`**. town.js
gains exactly one line in `tipFor`: `if (typeof e.tip === 'function') return e.tip();` — memorial
owns its own tooltip copy and town.js keeps owning the tooltip mechanism.

### 5.1 The Chronicle Stone (plaza)

A four-sided tapered obelisk, ~5.6 units tall on a two-step plinth, standing on the plaza rim on
the bearing **opposite the gate** — so the signpost points down the road to yesterday at one end
of the square and the Stone anchors the other.

```
angle  = atan2(gate.z, gate.x) + Math.PI
radius = min(plazaR() + 2.2, innerR() - 2.0)     // same guard as setPlazaR
```

Faces carry a `CanvasTexture` (512×1024, `anisotropy = MAXA`) drawn as chiselled serif engraving
in the palette's stone tone, repainted **only** when a record changes:

```
        THE CHRONICLE
     ────────────────────
   greatest day    2.41 B
                  12 June
   longest spell   14 days
   largest town   612 houses
   kept since     4 Aug 2026
     ────────────────────
```

* **Blank on day one** — `records.bestDay == null` paints `THE CHRONICLE / — / unmarked / the
  mason waits`. A promise, not a nag (R2/§8.7).
* **R2 in the mesh:** a thin gold inlay creeps up the obelisk's leading edge *only* while
  `chronicle.pressure()` is non-null, i.e. inside the last 20 % of a record. Below that the stone
  is stone.
* **A record falling** is a first-class celebration and reuses `fireMilestone`'s choreography at
  reduced scale: `burst3d(stoneTop, GOLD_HI, 44, 8)`, `floatText(stoneTop+1.4, '✦ new record',
  accentCss, true)`, `npcs.celebrate(stonePos, {runners: 5, cheerRadius: 40})`, `news.post('record',
  {key, tok, was})`, and the texture repaints 900 ms later so the user *sees* the number change.
* Tooltip: `['The Chronicle Stone', 'best day 2.41B · 12 June', 'day 41 of the chronicle']`.
* Cost: 6 meshes (plinth ×2, shaft, cap, 2 face planes sharing one material), 1 texture. Casts
  shadow; `freezeStatic`-friendly (nothing animates but the inlay's emissive).

### 5.2 The town on the horizon (yesterday)

A **billboard impostor**, not a second township — 2 draw calls, no geometry, no terrain
collisions, and it is generated by the same painter the map uses.

* **Where.** World position on the gate bearing at `GHOST_R = 640`, `y = sampleHeight(x,z)`, so
  it stands on the far country and the hill domes (r 430–830, h 14–52) can partially occlude it.
  This is inside the veil (940) so environs' haze does the atmospheric work for free, and well
  inside the sky dome (820) so it can never be clipped by it.
* **How big.** Constant apparent size, recomputed in `refreshFraming` (a few times an hour, never
  per frame) so a 50-unit orbit and a 500-unit orbit read the same:
  ```js
  const D = Math.max(180, GHOST_R - dist);
  const H = 2 * Math.tan(camera.fov * Math.PI / 360) * D * GHOST_P;   // GHOST_P = .055
  memorial.setApparentScale(H);                                       // plane is H tall, 8·H wide
  ```
  Canvas is 1024×128 (8:1). Starting values put the skyline at ≈ 30 % of stage width and its
  tallest spire at ≈ 45 px on an 880-px stage. **These two numbers are the acceptance target;
  tune `GHOST_R`/`GHOST_P` against a screenshot, not against the formula.**
* **What colour.** `ink = fogColor.clone().multiplyScalar(0.74).lerp(COOL_LAND, 0.30)` where
  `COOL_LAND = #6A6E62` — the same value environs uses for `uLandFar`. (C5 replaces this with an
  exact getter; the approximation is within a few percent and does not justify touching
  environs.js in wave 1.) `fog: true` on the material, `depthWrite: false`, `renderOrder: -2`
  (between environs' veil at -3 and the road plate at 0).
* **At night it is awake.** A second, additive plane at the same transform carries the `o.lit`
  canvas — warm window dots only — with `opacity = 0.85 * ctx.night`. Yesterday's town keeps its
  lamps on. This is the single most charming beat in the feature and it costs one plane.
* **Fidelity.** High-fidelity (real `buildPlan(planSeedOfIndex(yesterday.idx))`) generated once
  per epoch, scheduled off the critical path: `schedule(1800, () => memorial.setGhostArt(…))` —
  after the founding cascade, never during it. Until then the cheap-mode silhouette stands in, so
  a 6-second headless shot always has a ghost.
* **Hover** (raycast against the plane): `[yesterday.name, '412.7M tokens · yesterday',
  'the road east — riverside market town']`.
* **Dormant** when `chronicle.yesterday == null`, when `prefs.ghost === false`, or when
  `SEED_OVERRIDE !== null` (a forced seed makes "yesterday" the same town as today).

### 5.3 The bunting (streaks)

Pennant lines strung between the six plaza lamps: one pennant per day of the current spell, up
to 12, coloured from `palette.dots`. One merged `BufferGeometry`, one double-sided material, one
draw call. Sway is `dt`-driven (cosmetic only, per the house rule); *existence* is set once when
the view is adopted.

* Nothing appears below `spell.len >= 3` (R3: a 1-day "streak" is a trap).
* Nothing is ever removed mid-session. `setView` may only ever raise the pennant count.
* Suppressed entirely by `prefs.showStreaks === false`.
* Tooltip on the lamp posts: `['the bunting', 'day 9 of an unbroken spell', 'longest: 14 days']`.

### 5.4 Budget

| element | draws | tris | textures |
|---|---|---|---|
| Chronicle Stone | 3 (shaft+plinth batched by material, 2 face planes share one) | ~180 | 1 × 512×1024 |
| horizon ghost | 2 | 4 | 2 × 1024×128 |
| bunting | 1 | ~240 | 0 |
| **total** | **≤ 6** | **< 500** | **< 1.4 MB** |

At 1200 buildings + 160 NPCs this is noise. Per-frame work in `memorial.update` is one
`quaternion.copy(camera.quaternion)` for the ghost planes plus the bunting sway — nothing else.

---

## 6. WHAT THE RENDERER SHOWS — the DOM layer (`almanac.js`)

```js
export function initAlmanac(cfg) → Almanac
/* cfg: { header, overlay, stage, paintSkyline, chronicle, onPref, accent:()=>string } */
```
`Almanac` = `{ setView(v), showCard(idx, opts), showMap(), hide(), update(now), dispose() }`.

### 6.1 The header strip — the always-on 14 days

A `<span class="chron" id="chronStrip">` inserted in `index.html` after `#palDots`. **It must go
in the header, not the footer:** town.js rewrites `<footer id="stats">`'s entire `innerHTML`
every 500 ms, which would destroy anything else parked there.

14 canvases, 26×14 px each, one per day back from today (quiet days included, drawn as a flat
meadow line — R1), painted in cheap mode with `ink` at 55 % opacity and today's at 100 % in the
accent. Repainted only when the chronicle changes. Total ≈ 5 KB of canvas.

* Hover a day → the tooltip line `Tue 4 Aug · Cachewick · 412.7M`.
* Hover the strip → the Almanac card for that day (§6.2).
* Click the strip → the Kingdom Map.
* CSS (index.html): `.chron{display:inline-flex; gap:2px; height:14px; opacity:.9; cursor:pointer}`
  plus a `@media (max-width:820px){.chron{display:none}}` alongside the existing `.dots` rule.

### 6.2 The Almanac card

A parchment card, ~340×220, centred over the stage. It is the bookend to the founding plate and
it deliberately borrows the plate's typography (Georgia, letter-spaced small caps, hairline
rules) so the two read as pages from the same book.

```
              ─────────────────────
                   CACHEWICK
              tuesday 4 august 2026
              ─────────────────────
                 [ skyline art ]

                  412.7M tokens
             233 buildings · 6 milestones
             riverside market town · seed 8A1F
              4 breaks · quietest hour 14:00

              ─────────────────────
                 kept in the chronicle
```

* **When.** (a) at an epoch turnover that crosses a day boundary — town.js already knows this as
  `fullEpoch && rg.dayIndex !== curRange.dayIndex` — shown for 7 s *before* the teardown fade
  starts, so the day gets a proper full stop; (b) on hovering the header strip; (c) on `A`.
* **Never a report card.** No comparison to any other day appears on it. No "up"/"down", no
  rank, no percentage. It is an antiquarian record of a place, and R4/R6 forbid anything else.
* Base CSS is the final state; the entrance animation only travels toward it (the v3 rule that
  keeps a throttled compositor from screenshotting a blank card).
* `?almanac=<dayIdx|1>` forces it open for headless verification.

### 6.3 The Kingdom Map

Full-stage overlay, one 2D canvas, drawn once on open and on resize. Opened by clicking the
header strip or pressing `K`; closed by `Esc`, a click outside, or `K`.

* A wandering road (a seeded polyline, gentle, left→right, wrapping into 4–6 rows) with one mark
  per day for the visible span (default the last 120 days; a "year" toggle extends to 400).
* Each active day is a **village glyph** drawn by `paintSkyline` in cheap mode at 22×14 px,
  scaled by `sqrt(tok)` between 0.55× and 1.6×.
* Each quiet day is a **meadow glyph** — three tufts and a tree, in the biome green (R1). It is
  the same visual weight as a village. Not a gap, not grey, not a dashed line.
* Today is marked `you are here` with the accent and a small pennant.
* The best day carries a tiny crown; the longest spell is drawn as a ribbon *under* the road.
* Hover → `Tue 4 Aug · Cachewick · 412.7M · 233 buildings`. Click → nothing. There is no time
  travel and no drill-down; the map is a keepsake, not an analytics view.
* Footer of the overlay: `41 towns kept · first light 4 August 2026` and the three preference
  toggles (§4.4), which are the only settings UI in the app.
* `?map=1` forces it open for headless verification.

Performance: 400 cheap-mode skylines ≈ 0.4 ms each ⇒ under 200 ms for a full year, once, on
open, off the render path. Cache the painted canvases by `idx` (they never change).

---

## 7. THE MOMENTS

Ranked by how much delight they buy per unit of risk.

### 7.1 A record falls
Gold burst at the Stone, the engraving visibly re-cuts 900 ms later, one urgent Crier line, five
villagers run to the plaza. Fires at most once per record per epoch (`recordsBrokenBy` self-latches).

### 7.2 The bunting goes up
On the first frame after the founding ritual settles (`ctx.intro >= 1`), if `spell.len >= 3` the
pennants rise with the same `easeOutBack` pop the buildings use, one every 90 ms, and the Crier
files a `spell` line. Only on arrival — never mid-session, never twice.

### 7.3 Yesterday appears
The ghost fades in over 1.6 s at `t = 1800 ms` of the founding ritual, right as the camera eases
out from the plat survey — so the first thing the settled framing shows is *there is a town over
there, and it is yours*. Paired with the signpost, which points at it.

### 7.4 The Almanac page turns
At a day-boundary epoch change (§6.2a).

### 7.5 On this day
If `onThisDay()` finds the same calendar date a year back, one ambient Crier line at ~90 s in.
Pure charm, zero pressure (C4).

### 7.6 **The Overtaking** — the best moment in the feature
When the live day total crosses **yesterday's final total**, once:

* the existing spliced `best` rung already handles the fireworks — this adds the *stamp*:
  `floatText(monumentTop, 'overtook yesterday at 14:32', GOLD_HI, true)`;
* `chronicle.note(todayIdx, {overtookMs: Date.now()})` — and if it is earlier in the day than any
  previous overtaking, that is its own record line on the Stone (`earliest overtaking 11:04`);
* the ghost tips its hat: a one-time flock of ~9 birds lifts off the horizon town and drifts
  right, drawn as 9 points in the existing particle pool at the ghost's world position with
  `vy` small and `vx` biased — 6 lines of code, and it is the beat people will screenshot.

Guard: only when `ctx.rangeIsDay` (§9 invariant). Never fires downward, never announces the
opposite (R4).

---

## 8. WIRING (`town.js`)

Concrete, in the order the implementer will write them.

**8.1 imports** — `import { initChronicle, planSeedOfIndex, dateOfDayIndex } from './chronicle.js';`
`import { initMemorial } from './memorial.js';` `import { initAlmanac } from './almanac.js';`
plus `townNameFor` from news.js and a new `archetypeOf` from layout.js.

**8.2 `archetypeOf(seed)` (layout.js, 3 lines)** — the archetype is the *first* draw off
`sub(seed, 0x5f356495)` inside `buildPlan`, so it can be handed out without building a plan:
```js
export const archetypeOf = seed => pickArchetype(sub(seed >>> 0, 0x5f356495));
export const KIND_LABEL_OF = kind => KIND_LABEL[kind] || '';
```
Assert in the harness: `archetypeOf(s) === buildPlan(s).kind` across ≥ 200 seeds. This is the
single most breakable assumption in the design — if `pickArchetype` ever stops being the first
consumer of that sub-stream, the past-town names and archetypes silently drift.

**8.3 construction** (after `news`, before `refreshFraming`):
```js
const chronicle = initChronicle({
  identify: idx => { const s = planSeedOfIndex(idx); return { seed: s, name: townNameFor(s), kind: archetypeOf(s) }; },
  sizeOf: townSize,
  store: (window.townAPI && window.townAPI.history) || null
});
ctx.chronicle = chronicle;          // read-only for every module
```

**8.4 `applyInit`** — after `spliceBestRung(...)`:
```js
chronicle.ingest(msg);
memorial.setView(chronicle.view()); almanac.setView(chronicle.view());
if (founding) chronicle.note(chronicle.todayIdx, { seen: 1 });
```
and in the day-boundary branch of the fade, before `hardReset()`, `almanac.showCard(prevDayIdx,
{ hold: 7000 })`.

**8.5 the 500 ms stats tick** — two calls, both cheap:
```js
if (ctx.rangeIsDay) chronicle.setLive(T);
for (const b of chronicle.recordsBrokenBy(chronicle.today ? chronicle.today.tok : 0)) {
  memorial.celebrateRecord(b); news.post('record', { key: b.key, tok: b.now, was: b.was });
}
facts.best = chronicle.records.bestDay ? fmtTok(chronicle.records.bestDay.tok) : '';
facts.spell = chronicle.spell ? chronicle.spell.len : 0;
facts.ghost = chronicle.yesterday ? chronicle.yesterday.name : '';
facts.days  = chronicle.days.length;
```

**8.6 `hardReset`** — `memorial.reset(); almanac.hide();` and **do not** reset the chronicle: it
outlives epochs by definition. Register memorial's ents through the existing `addHit`/`tagEnt`
path after `setPlan`.

**8.7 demo mode** — synthesise 46 days so the shop window and every screenshot show the feature:
a log-normal walk around 180M with two quiet weekends, one 2.4B spike 12 days back (so the
records are real and the strip has shape), current spell 5. Gate on `FORCE_DEMO ||
Q.get('chronicle') === 'demo'`.

**8.8 first-ever launch** — `chronicle.days.length <= 1`: no ghost, no bunting, blank Stone with
the mason line, strip shows one mark, map shows one village and the line `the chronicle begins
today`. Nothing about this state may read as deficiency.

**8.9 new query flags** — `main.js` must add `chronicle`, `map`, `almanac`, `ghost` to the
forwarded list at `main.js:87` (the same array task #8 may touch — coordinate).

---

## 9. INVARIANTS (put these in the file headers)

1. **The chronicle is day-scoped; the range is not.** The Stone, the strip, the map and the ghost
   are always about calendar days, whatever range the tracker has selected. Only the *race*
   elements (Overtaking, live rank, `pressure()`) engage when `ctx.rangeIsDay`.
2. **Nothing in this layer ever writes to `usage.db` or `settings.json`.** The feed's chronicle
   query is a `SELECT`; the only file this app writes is its own `chronicle.json`.
3. **Never gate a visual on the persisted file.** Every element must render correctly from the
   derived chronicle alone. If deleting `chronicle.json` changes what the user sees by more than
   the "kept" count and the three prefs, the implementation is wrong.
4. **Existence is wall-clock.** The Stone's engraving, the bunting count, the ghost's presence,
   the card's content — all set on `performance.now()`-driven paths. Only sway, fades and bird
   drift may use `dt`.
5. **Additive only, within a session.** A record, a pennant, a ghost may appear; nothing may
   disappear while the user watches.
6. **No new npm dependencies.** Everything here is Canvas2D, `THREE` r160 primitives, and `fs`
   in the main process.

---

## 10. THE COPY (news.js)

Three new `CAT_OF` entries — `record: 'RECORD'`, `spell: 'SPELL'`, `chronicle: 'CHRON'` — with
`URGENT.record = 1`, plus five new slots in `slotVal`: `{best}`, `{spell}`, `{ghost}`, `{days}`,
`{was}`, all registered in `NEEDS` so a line is skipped when its fact is missing. `{ghost}`
resolves to `facts.ghost` (yesterday's town name).

**RECORD** (urgent; can only fire on success):
* `RECORD. **{tok}** in one day — the Stone is re-cut. The mason charges extra for long numbers.`
* `Best day ever recorded. The previous best, **{was}**, is escorted quietly out of the ledger.`
* `The Chronicle Stone gains a line. {name} claims to have felt it happen.`
* `A new high-water mark is chiselled. The old one is sanded off and sold as gravel.`
* `History revised. The Recorder needs a bigger chisel and a smaller ego.`
* `Largest township on record: **{b}** buildings. The map is redrawn on a second sheet.`

**SPELL** (never mentions ending — R3):
* `Day **{spell}** of an unbroken spell. The bunting has been let out twice.`
* `{town} has not had a quiet day in **{spell}**. The orchards are starting to talk.`
* `The bunting reaches the far lamp. Council votes to buy more lamp.`
* `Longest spell on record equalled. Nobody can remember what a record is for.`

**CHRON** (ambient, antiquarian, low-stakes):
* `The Recorder is updating the almanac. It is mostly weather and one good number.`
* `Back-numbers of this paper are kept in the Stone. They are heavy and largely correct.`
* `{ghost} is visible on the eastern road today. It waves. We are fairly sure it waves.`
* `A rider from {ghost} brings news of **{prev}**. The rider is given soup.`
* `The archive holds **{days}** towns before this one. All of them insist they were the best.`
* `Cartographers add {town} to the kingdom map. They spell it wrong. It stays.`
* `The Recorder notes that yesterday happened. Motion carried.`
* `**A quiet week is entered in the almanac as "restful". The orchards concur.**`  ← the R1 line
* `The Stone reads **{best}** at the top. Nobody has asked it to explain itself.`
* `Someone asks what the Stone is for. The Recorder says "later". Nobody presses.`
* `Smoke on the eastern horizon: {ghost} is still standing, and still smug.`
* `The road east is walkable in a day, they say. Nobody has tried since the Stone went up.`
* `{name} proposes a museum. It would contain the Stone, which cannot be moved.`

**The Overtaking** (fired as `record` with `key:'overtake'`):
* `OVERTAKEN. {ghost}'s final tally passed at **{was}**. Bells, briefly.`

Register-check: no line names a model, no line says "you", no line says "should", no line
mentions a decline. That is the whole review.

---

## 11. RANKING

| # | item | rank | size | files |
|---|---|---|---|---|
| 1 | **Feed `chronicle` + `todayTok`** (§3.1) | **must** | M | `src/datafeed.js` |
| 2 | **`chronicle.js`** model + `paintSkyline` (§3.2, §3.4) | **must** | M | *new* `src/renderer/chronicle.js` |
| 3 | **Storage bridge** — IPC, atomic write, quarantine (§4) | **must** | S | `src/main.js`, `src/preload.js` |
| 4 | **town.js wiring** — ctx.chronicle, tip delegation, records tick, demo synth (§8) | **must** | M | `src/renderer/town.js`, `src/renderer/layout.js` (+`archetypeOf`) |
| 5 | **The Chronicle Stone** (§5.1) | should | M | *new* `src/renderer/memorial.js` |
| 6 | **The horizon ghost** (§5.2) | should | M | `memorial.js` |
| 7 | **News copy** — 4 categories, 3 events, 5 slots (§10) | should | S | `src/renderer/news.js` |
| 8 | **Header 14-day strip** (§6.1) | should | S | *new* `src/renderer/almanac.js`, `index.html` |
| 9 | **The Overtaking** (§7.6) | should | S | `town.js`, `news.js`, `memorial.js` |
| 10 | **The Almanac card** (§6.2) | should | M | `almanac.js`, `index.html` |
| 11 | **Streak bunting + prefs** (§5.3, §4.4) | should | S | `memorial.js` |
| 12 | **Kingdom Map** (§6.3) | could | L | `almanac.js`, `index.html` |
| 13 | High-fidelity 3D ghost (real instanced plots, not a billboard) | could | M | `memorial.js`, `town.js` |
| 14 | Click the ghost → camera looks down the east road for 6 s | could | S | `town.js` |
| 15 | "On this day" anniversary copy (§7.5) | could | S | `chronicle.js`, `news.js` |
| 16 | `env.farLandColor` getter for an exact ghost haze match | could | S | `environs.js` ⚠ high collision |
| 17 | Heirloom stones for first-ever landmarks | could | M | `memorial.js` |
| 18 | "Copy the almanac as text" from the card | could | S | `almanac.js` |
| 19 | Footer copy fix: `▼ … behind` → `… to go to match` (R4) | could | XS | `town.js:2099` |

**Build order.** 1 and 3 are independent and can start together; 2 depends only on the agreed
message shape, so it can start immediately against a hand-written fixture. 4 gates everything
visual. 5–11 are then four genuinely parallel lanes: memorial (5, 6, 11), almanac (8, 10), news
(7), town-side moments (9). 12 lands last because it wants the strip's interaction and the card's
typography to exist first.

**Do not start 5–11 before 4 lands.** Every one of them reads `ctx.chronicle`.

---

## 12. VERIFICATION (offscreen only, per the house rule)

* **Node harness** (`scratchpad/chron-harness.mjs`): `chronicle.js` has zero imports, so drive it
  directly. Assert — inverse of `dayIndexOf`/`dateOfDayIndex` over 3 000 random days including
  every DST transition in 2024–2027; `archetypeOf(s) === buildPlan(s).kind` over 200 seeds;
  `rankOf` ties; `spell` across a quiet Sunday; `pressure()` returns `null` below 0.80;
  `recordsBrokenBy` fires exactly once per record; a corrupt/newer/missing file in all three
  degradation paths.
* **Feed harness**: point the existing `feedcheck.mjs` pattern at a synthetic DB spanning 400 days
  and assert the folded totals match a JS ground truth computed with local `Date`, and that the
  first `buildChronicle` is under 150 ms.
* **Screenshots** (`npx electron . --shot=… --shot-delay=9000`): `?chronicle=demo` for the strip
  and the Stone; `--hour=23 ?chronicle=demo` for the lit ghost; `?map=1` and `?almanac=1` for the
  overlays; `?chronicle=demo&tokens=2.6e9` for a record falling. Every one of these must show a
  *finished* state at 9 s — nothing in this layer may depend on accumulated `dt`.
