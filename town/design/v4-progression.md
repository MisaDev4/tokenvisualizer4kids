# Token Town v4 — PROGRESSION & ACHIEVEMENTS

*Design input for the v4 spec. Area owner: progression. Written against the shipped v3 code
(`town/src/**` @ 2026-08-06 18:48). Read-only wave — nothing here has been implemented.*

---

## 0. The three rules this whole area is built on

**R1 — Nothing is ever lost.** Every persistent number is monotonic. No streak that resets,
no rank that drops, no "you lost your Lighthouse". A user who takes three weeks off comes
back to a town that is *exactly as grand as they left it*, plus a Crier line that says so
warmly. This single rule is what makes the meta-game charming instead of coercive, and it is
also what makes the storage layer trivial (merge = per-leaf `max`/first-write-wins; no
conflict resolution, no repair path).

**R2 — Observe, never demand.** Progression copy reports the past and describes the present.
It may state a projection *about the world* ("the Ledger passes 500M around 16:20 at this
rate"). It may never address the user's behaviour, never use an imperative, never print a
remaining amount as a goal ("only 40M to go!"), never show a countdown to an unearned badge.
§9 gives the binding banned-substring list. The existing footer meters are grandfathered —
they are v3's contract, not ours.

**R3 — The reward for spending nothing is a building too.** At least one charter unlock
(§4, `almshouse`) and two badges celebrate *breaks*. If the meta-game only ever rewards
tokens burned, it is a slot machine with a steeple on it.

Corollary to R1+R2: rank thresholds and charter conditions are **never** shown as progress
bars in the world chrome. They live in one place — the Ledger panel (§6) — where the user
went looking for them on purpose.

---

## 1. FOUNDATION — the Chronicle (must be built first; everything below imports it)

There is currently **zero persistence anywhere in `town/`**: no `localStorage`, no
`indexedDB`, no file writes outside `--shot=`. This is the one hard blocker.

### 1.1 Where the file lives

```
%LOCALAPPDATA%\TokenTracker\town-chronicle.json
```

Not `app.getPath('userData')`. Co-locating with `usage.db` and `settings.json`
(`src/datafeed.js:53`, `dataDir`) means the record survives an Electron reinstall, a
`node_modules` wipe, and a repo re-clone — the three things most likely to happen to this
app. It is a *new* file in that directory; the v3 rule "the tracker's `settings.json` is read,
never written" is untouched.

`localStorage` was rejected: `loadFile()` gives a `file://` origin, whose storage
availability under `sandbox:true` is Chromium-version-dependent, and it is invisible to the
user, un-backupable, and unshareable with any future feature. A JSON file the user can open,
read, copy to another machine and laugh at is worth the ~90 lines of plumbing.

### 1.2 Schema v1 (shared with the history designer)

Two disjoint sub-trees so two renderer modules can never clobber each other.
**History designer owns** `days`, `bests`, `firstSeenMs`. **Progression owns** `totals`,
`charter`, `badges`, `rank`, `events`, `seen`. Nobody writes the other's keys.

```jsonc
{
  "v": 1,
  "firstSeenMs": 1754400000000,          // history
  "days": {                              // history — one entry per local calendar date
    "20260806": { "tok": 1181000000, "b": 454, "breaks": 3,
                  "firstMs": 1754..., "lastMs": 1754..., "peakPerMin": 3210,
                  "hours": [0,0,0,12000, /* …24 ints, tokens per local hour… */] }
  },
  "bests": { "day":     { "tok": 2.04e9, "date": 20260731 },      // history
             "hour":    { "tok": 4.1e8,  "date": 20260731, "h": 14 },
             "session": { "tok": 1.9e9,  "date": 20260731 } },

  "totals": { "tok": 3.168e10, "days": 41, "buildings": 12044,    // progression
              "milestones": 118, "breaks": 96, "landmarks": 214 },
  "rank":   { "i": 3, "at": 1754..., "date": 20260714 },          // highest rank ever held
  "charter":{ "records_hall": { "date": 20260702, "at": 1751..., "n": 1 },
              "lighthouse":   { "date": 20260714, "at": 1752..., "n": 1 } },
  "badges": { "small_hours": { "date": 20260703, "at": 1751..., "n": 7 } },
  "events": { "20260722": "circus", "20260731": "comet" },        // ones you were PRESENT for
  "seen":   { "arch": ["riverside","ribbon"], "roof": ["Terracotta","Slate"], "biome": ["downs"] }
}
```

`n` on a charter/badge entry is "how many times the condition has been met since" — it is
the number the Ledger prints as "×7", and it is what makes `small_hours` feel like a habit
rather than a one-off. `date` is always the *first* time.

Size at 5 years of daily use: ~365×5 day records × ~180 bytes ≈ 330 KB. Fine. If `days`
ever exceeds 4000 entries the loader folds everything older than 730 days into
`daysArchived: {count, tok}` and drops it (history designer's call, mentioned here so the
schema has a stated ceiling).

### 1.3 Plumbing — `src/chronicle.js` (NEW, main process; owner: **feed/shell**)

```js
// src/chronicle.js — the ONLY writer of town-chronicle.json.
/** Load (or mint) the record. Sync, once, before the window opens. @returns {Object} */
function load();
/** Deep-merge a patch into the live doc and schedule a write. Returns the merged doc. */
function merge(patch);
/** Force the debounced write now (called on app 'before-quit'). */
function flush();
module.exports = { load, merge, flush, path: CHRONICLE_PATH };
```

Merge semantics — **exactly these, no others**:

| pattern | rule |
|---|---|
| plain object | recurse |
| number under `totals.*`, `*.n` | `Math.max(old, new)` — R1, monotonic |
| number under `bests.*.tok`, `rank.i` | `Math.max`; the sibling `date`/`at`/`h` fields ride along only when the max changed (merge the whole `bests.day` object atomically, not leaf-by-leaf) |
| any other scalar | first write wins if the key already exists **and** the patch key ends in `At`/`date`; otherwise last write wins |
| array under `seen.*` | set-union, sorted, capped at 64 |
| `undefined` / `null` leaf | ignored (there is no delete API — R1) |

Write policy: debounce 4000 ms, coalescing; atomic via `write tmp → fs.renameSync`. On
parse failure, rename the corrupt file to `town-chronicle.corrupt-<ts>.json` and start
fresh — never silently drop the user's history. Writes are wrapped in try/catch and never
throw into the app; a read-only disk degrades to an in-memory-only session with one Crier
line ("The Registry is closed for repairs. Today will not be recorded.").

### 1.4 IPC — `src/preload.js` + `src/main.js` (owner: **feed/shell**)

```js
// preload.js additions
contextBridge.exposeInMainWorld('townAPI', {
  onData: …, ready: …,                          // unchanged
  /** Deep-merges a patch; fire-and-forget, never awaited on a frame. */
  record: patch => ipcRenderer.send('town:record', patch)
});
```

The **snapshot is delivered as a data message**, not as a second async channel, so it rides
the existing `pending`/`lastInit` replay machinery in `main.js` and is guaranteed to arrive
before the first `init`:

```js
// main.js — in ipcMain.on('town:ready'), unshifted ahead of lastConfig/lastInit
queued.unshift({ type: 'chronicle', v: 1, doc: chronicle.load() });
```

`town.js`'s existing `onData(msg)` switch gains one case (`'chronicle'` → `charter.adopt(msg.doc)`).
Zero new event plumbing, zero races: the renderer has the full record before it has its
first token.

### 1.5 The safety interlock (do not skip — this is how the record survives verification)

Test hooks corrupt records. `?tokens=`, `?feed=demo`, `?seed=`, `--shot=` and `?range=`
all fabricate reality, and a screenshot run must not award "TEN BILLION" for eternity.

```js
// town.js, next to the existing Q/TOK_OVERRIDE block (town.js:133-146)
const SYNTHETIC = FORCE_DEMO || TOK_OVERRIDE !== null || SEED_OVERRIDE !== null
                || HOUR_OVERRIDE !== null || Q.get('chronicle') === 'off';
```

`SYNTHETIC` ⇒ `charter.init({ readOnly: true })`: the module still *reads* the doc (so
screenshots show a realistic Ledger) and still runs every detector, but `record()` is a
no-op and awards fire their FX without persisting. Additionally `?chronicle=fake` loads a
canned doc from a const in `charter.js` — a fully-decorated town for art passes, ranks and
charter buildings included. **This const is the single most useful thing in the whole area
for the verification fleet; build it in step one.**

---

## 2. `src/renderer/charter.js` (NEW; owner: **charter** — a new ninth owner)

One module owns rank, charter unlocks, badges, rare events and auguries. It holds no THREE
objects and mounts no meshes — it is a state machine that emits **awards**, and `town.js`
turns awards into buildings, particles and Crier posts, exactly as it already does for
`LADDER` milestones (`town.js:1174 updateMilestones` / `1198 fireMilestone`). That symmetry
is deliberate: the mounting code already exists and is proven.

`charter.js` imports **nothing** (like `layout.js`). It is therefore unit-testable under
plain Node, which matters because it contains ~60 boolean predicates.

```js
/**
 * @typedef {Object} DayFacts   Everything a detector may read. Assembled by town.js
 *   ONCE PER MINUTE (wall clock) and on every milestone/landmark/grove event.
 *   All fields describe the LOCAL CALENDAR DAY, never the selected range (§2.2).
 * @property {number} date        YYYYMMDD local
 * @property {number} tok         today's tokens
 * @property {number} b           buildings standing
 * @property {number} breaks      groves today
 * @property {number} longestBreakMs
 * @property {number} firstMs @property {number} lastMs
 * @property {number[]} hours     24 ints, tokens per local hour today
 * @property {number} peakBucket  biggest single 5-min bucket today
 * @property {number} landmarks   ladder landmarks standing (0..9)
 * @property {number} perMin @property {number} paceRatio
 * @property {string} arch        plan.kind        @property {string} biome
 * @property {string[]} roofs     roof family names on screen today
 * @property {number} hourNow     0..23 local     @property {number} nowMs
 * @property {boolean} rangeIsDay ctx.rangeIsDay
 * @property {?string} eventToday rare event id if one is live
 */

/**
 * @typedef {Object} Award
 * @property {'rank'|'charter'|'badge'|'event'} kind
 * @property {string} id
 * @property {string} title    'The Lighthouse'          — floater + plaque
 * @property {string} blurb    'For the night you kept…' — Ledger + Crier {label}
 * @property {string} icon     one emoji
 * @property {boolean} secret  hidden in the Ledger until earned
 * @property {number} n        times met, post-increment
 */

export function initCharter(opts);
/** opts = { doc, readOnly, record(patch), now() } */
```

Returned API — every method is allocation-free on the hot path:

```js
{
  adopt(doc),                   // swap the whole record (the 'chronicle' message)
  /** Run every detector. Call at <=1 Hz. Returns awards to fire, or EMPTY. */
  check(facts) -> Award[],      // reuses one array + pooled Award objects
  /** Roll today's rare event. Deterministic in daySeed. Call once per epoch. */
  eventFor(daySeed) -> ?{id, atHour, ttlH, ...},
  /** Mark the live event as witnessed (persists it). Idempotent. */
  witness(id),
  /** Charter ids the town should ALREADY be standing with, oldest first. */
  standing() -> string[],
  get rank(),                   // 0..6
  get rankName(),               // 'Town'
  get rankData(),               // {i, name, wallStyle, npcBonus, …} — §3
  /** An observation, or null. Called at <=1 Hz by town.js; self-rate-limits. */
  augury(facts) -> ?{cat:'AUGURY', text:string, tok?:string, clock?:string},
  /** Everything the Ledger panel renders. Fresh object; call on open only. */
  ledger() -> {rank, ranks[], charter[], badges[], records[], almanac[]},
  facts,                        // the DayFacts scratch object town.js mutates in place
  dispose()
}
```

### 2.1 The award pipeline in `town.js`

```js
// once per minute, wall-clock (performance.now), NOT per frame
if (now - charterAt > 60000) {
  charterAt = now;
  fillDayFacts(charter.facts);                 // ~30 field writes, no allocation
  const awards = charter.check(charter.facts);
  for (const a of awards) fireAward(a);
}
```

`fireAward(a)` is `fireMilestone`'s cousin (`town.js:1198`) and reuses its parts verbatim:

| award kind | what fires |
|---|---|
| `badge` | `floatText(coinPos+2.4, a.icon + ' ' + a.title, '#F3D07A', true)`, `burst3d` at the altar, `news.post('badge', {label:a.title, title:a.blurb})`, `npcs.pulse()`, seal in the header flashes |
| `charter` | full landmark ceremony: `placeCharter(a.id, true)` → scaffold + riser + 900 ms burst + `news.post('charterBuilt', …)`, camera `dollyT` nudge, 12 s Crier hold |
| `rank` | `showPlate()` reused with the rank name (`'{Town} is now a **Burg**'`), the signpost's boards redress (`dressSignpost`), bells (`landmarks.get('bell_tower')`), and `rankChanged()` re-dresses walls/gates |
| `event` | §7 |

Awards are queued and drained one per 2.5 s (reuse `milestoneQ` / `drainMilestoneQueue`,
`town.js:1223`) so a first-run cold open that earns nine badges at once is a *parade*, not a
single frame of chaos. Cap the cold-open parade at 6 awards then post one summary line:
"The Registry has been brought up to date. **{n}** further honours were filed quietly."

### 2.2 The day-facts problem (real, must be solved before badges are trustworthy)

The town mirrors the tracker's selected range. If the user is on `all`, `ctx.totalTok` is
31.68 B — awarding "a day over 1B" from that is a lie. Progression must therefore key off
**today**, not off the range.

*Preferred (needs a small feed change, coordinate with feed owner):* `datafeed.js` adds to
every `init` and `buckets` message

```js
today: { date: 20260806, tok, firstMs, lastMs, hours: [24], peakBucket, breaks }
```

computed with the existing `spanStmt`/`histStmtFor(3600e3)` against the local-midnight
anchor — ~4 extra queries per 2 s poll on an indexed column, negligible. `readHistory` is
already written; this is ~25 lines.

*Fallback (zero feed change, ship this first):* when `ctx.rangeIsDay` is true, today's facts
= the range facts (correct by construction). When it is false, `charter.check()` runs **only
the range-independent detectors** (`hourNow`, `arch`, `biome`, `roofs`, breaks-in-view,
landmarks standing, lifetime totals) and skips every token-threshold badge. The Ledger panel
shows a single grey line in that mode: *"The Registry counts by the day. Today's honours
resume when the dashboard shows a day."* — deadpan, honest, and it makes the feed extension
feel like a fix rather than a feature.

`totals.tok` must **not** be accumulated from the range either. It is `sum(days[*].tok)`,
recomputed by the history designer's writer. Progression reads it, never writes it.

---

## 3. TOWN TITLES — rank, and what it visibly does

Rank is a pure function of lifetime tokens. It is the slowest-moving number in the app and
it is the one that makes the town feel like *yours* rather than *today's*.

| i | title | lifetime `totals.tok` | ~when (at the user's ~1 B/day) | visible consequence |
|---|---|---|---|---|
| 0 | **Hamlet** | 0 | day 1 | — (baseline; the town as v3 ships) |
| 1 | **Village** | 2.5 B | ~day 3 | the **green**: a mown disc + maypole beside the plaza; signpost gains a rank board |
| 2 | **Burg** | 10 B | ~day 10 | **palisade**: staked fence along the last 2 road segments of each spine + a timber **gate arch** at `plan.gate` |
| 3 | **Town** | 30 B | ~1 month *(user is here)* | gate arch → **stone gatehouse**, two towers, civic-colour banner, a gatekeeper NPC who paces it |
| 4 | **City** | 100 B | ~3 months | **curtain wall** — an arc chain at `frontierR + 8` with 3 gates on the spine headings; `npcs` cap ×1.18 |
| 5 | **Metropolis** | 365 B | ~1 year | wall towers every 45°, pennants on each, night **watchmen with lanterns** patrolling the wall-walk |
| 6 | **Legend** | 1 T | ~3 years | a permanent night **aurora**, gold ridge-caps on every landmark roof, the founding plate gains a laurel |

Chosen so something new lands every few weeks for the first quarter and then the horizon is
honest rather than grindable. `1 T` is deliberately out of reach; it is a horizon, not a
target, and it is never displayed as a progress bar (R2). Never print "X to the next rank"
outside the Ledger's Almanac tab.

`ctx` gains `rank` (int) and `rankName` (string) — both read-only, both set in `adoptEpoch`.

### 3.1 Implementation of each consequence, cheapest first

* **Green + maypole (S)** — `buildings.js: buildGreen(paint, seed)`; a 9-unit grass disc
  decal is already available (the plaza disc path in `paintGround`); the maypole is a
  cylinder + 6 ribbon planes reusing the pennant material from `market_hall`. Placed by
  `town.js` at `plan.sites.green` (§4.3). NPCs already treat the plaza as an attractor; give
  the green a weak second attractor only at rank ≥ 5.
* **Palisade (S)** — pure instancing in `town.js`, exactly the `buildVerge()` pattern
  (`town.js:480`): 0.22×1.6×0.22 boxes at 0.7 pitch with ±0.14 rad wobble, along
  `plan.spine` outbound edges. Two `InstancedMesh`es (posts + rail). ~90 instances. No new
  geometry files.
* **Gate arch → gatehouse (M)** — `buildings.js: buildGate(tier, paint, seed)` where
  `tier ∈ {timber, stone}`. Reuses `buildBridge`'s parapet kit and `buildLandmark`'s
  `lmRoof`. Mounted by `town.js` at `plan.gate` (which already exists and already carries
  `yaw` — the signpost stands there). The signpost moves 6 units outboard so the two do not
  intersect.
* **Curtain wall (L)** — one `InstancedMesh` of a 6-unit merlonated wall segment, laid on a
  convex hull of the built plots inflated by 8 units and resampled to 6-unit chords.
  Rebuild is gated: only when `frontierR` grows by > 12 since the last build (≈ 4–6 rebuilds
  across a 1 B day, each ~3 ms). Gates are 12-unit gaps centred on the `plan.spine`
  headings. **Hard requirement:** the wall must be *outside* every plot including
  `ensureCapacity` appends, so build it from `boundsFor(built)` + 8 and re-check on each
  frontier bump. Wall segments are added to `hitTargets` with one shared `ent`
  (`tipFor` → `['The Curtain Wall', 'raised at {rank date}', '{n} paces around']`).
* **Wall towers + watchmen (M)** — towers are the same instanced segment scaled ×1.6 with a
  cone roof; watchmen are 4 NPCs given a fixed patrol route. `npcs.js` needs one new state,
  `'watch'`, that walks a supplied closed polyline instead of the road graph — ~40 lines,
  and it also lights the existing lantern attachment used by `'home'`.
* **Aurora (S)** — an additive ribbon plane in `environs.js`'s sky group, 3 sine-warped
  bands, opacity `night * 0.5`, hue drifting on `performance.now()` (house rule: it must
  show in a screenshot).

---

## 4. THE CHARTER — persistent civic buildings

*Once earned, it stands in every future town, forever.* This is the single strongest idea in
the area: it converts "today's town" into "your town's history", and it costs one boolean
per building.

### 4.1 The set

| id | earned by | mesh sketch | copy (Ledger blurb) |
|---|---|---|---|
| `records_hall` **★** | your **2nd** recorded day | `market_hall` body + a lantern cupola + a brass door; the only clickable interior in the game (§6) | "Somebody had to write all this down." |
| `mint` **★** | first day over **1 B** | `forge` body, chimney, a yard of stacked coin cylinders — the stack height is `min(30, days over 1B)` | "Where the number is made physical, at enormous inconvenience." |
| `almshouse` **★** | a day with **≥ 5 groves** | low L-plan cottage, big chimney, a bench and two sleeping NPCs outside | "Raised in honour of the hours you did not spend." |
| `lighthouse` **★** | a session ≥ **6 h** with no 45-min gap | tapered drum + lantern room; on `riverside`/`lakeside` it takes the bank, elsewhere it is a landlocked beacon and the Gazette never lets that go | "For the long watch. It faces inland. Nobody has raised this." |
| `owl_post` | tokens in the **03:00** hour | slim tower, one round lit window, an owl weathervane; at night an owl sprite flies a 40-unit loop | "Correspondence received at an hour the council considers rude." |
| `vane` | **7** recorded days | 3-unit post + gilded vane that spins at `paceRatio` rate | "It points at whatever is happening. It is never wrong." |
| `long_bridge` | seen **all 5** archetypes | a 5-arch viaduct that crosses *nothing* on dry archetypes | "Commissioned during a wet year. Retained out of stubbornness." |
| `reading_room` | a day where cache reads > **90 %** of tokens *(needs feed column split)* | small library, tall windows, a reading NPC | "The town spent the day re-reading what it already knew, and enjoyed it." |
| `fair_stage` | open on a **solstice or equinox** | a timber stage with bunting; hosts the `market_fair` event when it rolls | "Erected for one specific afternoon. Never taken down." |
| `century_column` | **100** recorded days | fluted column, 100 rings, `min(totals.days,100)` of them lit gold from the base | "One hundred days. The column does not consider this remarkable. The column is lying." |
| `cartwrights` | **3+ distinct source roots** in one day *(needs feed extension)* | guildhall with three doors, three different signs | "Three separate harnesses, one set of roads." |

★ = the four I would ship first. They cover: the panel host, the big number, the *anti*-grind
reward, and one pure luck-of-the-schedule unlock.

### 4.2 Detection & storage

Every condition above is a one-line predicate over `DayFacts` + `doc.totals` + `doc.seen`.
Full detector table, verbatim-implementable:

```js
const CHARTER = [
  { id:'records_hall', icon:'📜', ord:26, clr:7,  test:(f,d)=> (d.totals.days|0) >= 2 },
  { id:'mint',         icon:'🪙', ord:52, clr:8,  test:(f)  => f.tok >= 1e9 },
  { id:'almshouse',    icon:'🕯', ord:40, clr:6,  test:(f)  => f.breaks >= 5 },
  { id:'lighthouse',   icon:'🗼', ord:64, clr:9,  test:(f)  => f.lastMs - f.firstMs >= 6*36e5
                                                            && f.longestBreakMs < 45*6e4 },
  { id:'owl_post',     icon:'🦉', ord:34, clr:6,  test:(f)  => f.hours[3] > 0, secretish:true },
  { id:'vane',         icon:'🧭', ord:18, clr:4,  test:(f,d)=> (d.totals.days|0) >= 7 },
  { id:'long_bridge',  icon:'🌉', ord:96, clr:12, test:(f,d)=> d.seen.arch.length >= 5 },
  { id:'reading_room', icon:'📖', ord:46, clr:7,  test:(f)  => f.cacheFrac >= 0.90 },
  { id:'fair_stage',   icon:'🎪', ord:58, clr:9,  test:(f)  => isSolarFeast(f.date) },
  { id:'century_column',icon:'🏛',ord:88, clr:10, test:(f,d)=> (d.totals.days|0) >= 100 },
  { id:'cartwrights',  icon:'🛞', ord:70, clr:9,  test:(f)  => f.sourceRoots >= 3 }
];
```

`isSolarFeast(date)` = within ±1 day of Jun 20/21, Dec 21/22, Mar 20, Sep 22 — a 12-line
lookup, no astronomy.

Stored as `charter[id] = {date, at, n}`; `n++` on every later day the condition is met
(that is what the Ledger's "×14" is). Awarding is idempotent because `n` is `max`-merged.

### 4.3 Placement — the one change `layout.js` needs

`buildPlan` already reserves the 9 ladder landmarks by `(unlockOrdinal, clearance)` and
scores sites against the plot-key space (`layout.js:760-825`). Charter buildings want
**exactly that machinery** with lower ordinals (they are heritage, so they sit in the old
core).

```js
/** @param {number} seed
 *  @param {{extraSites?:Array<{id:string,ord:number,clr:number}>}} [opts] */
export function buildPlan(seed, opts);
```

Binding constraints on the change, so it cannot regress today's look:

1. Extra sites are reserved **after** all 9 `LM` entries, in the same loop, sharing `taken`.
   With `opts.extraSites` empty the function must be **bit-identical** to today for the same
   seed — assert it in the layout harness across the 8 canonical seeds.
2. `rndL` is consumed by the LM loop first, so ladder placement is untouched; extra sites
   draw from the tail of the same stream.
3. `plan.sites` gains the extra ids alongside the 9. `clearOfLandmarks` filters plots against
   the merged `taken`, so charter buildings still delete-and-renumber their footprint.
4. Rank furniture also arrives this way: `{id:'green', ord:12, clr:6}` and
   `{id:'gatehouse', …}` — the gatehouse is anchored to `plan.gate.node` rather than scored
   (add a `pin:{node}` field to skip scoring).
5. Budget: 11 charter + 2 rank sites = 13 more scored placements ≈ +6–11 ms on a 13–49 ms
   build. Acceptable once per epoch; measure and state it in the v4 spec.

`town.js` calls `buildPlan(planSeed, { extraSites: charter.siteRequests() })` in
`adoptEpoch()` (`town.js:1547`). One line.

### 4.4 Rendering

`buildings.js` gains `CHARTER_DEFS` (same shape as `LANDMARK_DEFS`: `{span, hTop, label}`)
and `buildCharter(kind, paint, seed)`. Several meshes are compositions of what already
exists (`records_hall` = `buildLandmark('market_hall')` body + cupola; `mint` =
`buildFlavor('forge')` + coin stack; `almshouse` = tier-3 house with a longer plan), so the
marginal cost per building is genuinely small.

`town.js` gets `placeCharter(kind, animate)` — a near-copy of `placeLandmark`
(`town.js:1094`) with `ent.kind = 'charter'`, its own `tipFor` branch, and one crucial
difference:

> **Charter buildings are standing at t = 0.** They are part of the plat, not today's
> reward. They must be mounted *before* the founding ritual reveals the town and must be in
> `platHidden` so the plat sequence raises them with the roads. The one exception is the day
> a building is earned — then it rises with full scaffold ceremony wherever the day has got
> to.

`tipFor` (`town.js:1774`) branch:
```js
if (e.kind === 'charter') return [`${e.label} ${e.icon}`,
  `chartered ${fmtDate(e.date)}${e.n > 1 ? ` · ${e.n}×` : ''}`, e.blurb];
```

### 4.5 The Gazette knows

`news.js` gains one corpus key, `CHARTER`, and a `charterBuilt` post type. Ten lines, in the
existing deadpan register:

```
'The **{landmark}** is entered into the Charter. It will outlive every one of us and most of the roads.'
'{town} charters the **{landmark}**. The document is sealed with wax and, briefly, a thumb.'
'A **{landmark}** now stands here permanently, whatever "here" turns out to mean tomorrow.'
'The Charter is amended. Somewhere, a clerk feels this happen and does not know why.'
'The **{landmark}** was here before this town and will be here after it. It was chartered nine minutes ago.'
'Charter entry **{order}**. The Registry files it under "inevitable".'
'{name} objects to the **{landmark}**. {name} is outvoted by every subsequent morning.'
'The masons did not build the **{landmark}**. It simply had the right to be here.'
'Permanent. The word is used twice, and then a third time, for luck.'
'The **{landmark}** is added to the town seal, which now requires two hands to lift.'
```

Plus a `DAYSTART` variant that only fires when `charter.standing().length > 0`:
`'{town} wakes with **{b}** buildings, no memory of yesterday, and **{n}** things it refuses to forget.'`

---

## 5. BADGES — the trophy shelf

Zero geometry, ~2 lines of code each, and they are the highest delight-per-line item in the
whole document. Ship a lot of them.

```js
const BADGES = [
  // ── the clock ───────────────────────────────────────────────────────────────
  { id:'first_light',   icon:'🌅', name:'First Light',      test:(f,d)=>d.totals.days>=1,
    blurb:'The first day anyone wrote down.' },
  { id:'after_midnight',icon:'🌃', name:'After Midnight',   test:f=>f.hours[0]>0,
    blurb:'Tokens logged between midnight and one. The Ledger was awake too.' },
  { id:'small_hours',   icon:'🦉', name:'The Small Hours',  test:f=>f.hours[3]>0, secret:true,
    blurb:'Three in the morning. The Owl Post remembers.' },
  { id:'dawn_patrol',   icon:'🐓', name:'Dawn Patrol',      test:f=>f.hours[5]>0||f.hours[4]>0,
    blurb:'Working before the sun cleared the hedgerow.' },
  { id:'all_day',       icon:'🕰', name:'The Long Day',     test:f=>f.lastMs-f.firstMs>=14*36e5,
    blurb:'Fourteen hours between the first token and the last.' },
  { id:'twelve_hours',  icon:'⏳', name:'Twelve Struck',    test:f=>runLen(f.hours)>=12,
    blurb:'Twelve consecutive hours, each with something in it.' },
  // ── the number ──────────────────────────────────────────────────────────────
  { id:'nine_figures',  icon:'💯', name:'Nine Figures',     test:f=>f.tok>=1e8, blurb:'A hundred million in a day.' },
  { id:'billionaire',   icon:'🌌', name:'Billion-Day',      test:f=>f.tok>=1e9, blurb:'A billion tokens between one midnight and the next.' },
  { id:'double',        icon:'☄️', name:'Twice Over',       test:f=>f.tok>=2e9, blurb:'Two billion. The tablet was replaced mid-afternoon.' },
  { id:'flash_flood',   icon:'⚡', name:'Flash Flood',      test:f=>f.peakBucket>=5e7,
    blurb:'Fifty million inside five minutes. The mill is still smoking.' },
  { id:'personal_best', icon:'🥇', name:'Best Day Yet',     test:(f,d)=>f.tok>0&&f.tok>=(d.bests.day.tok||0),
    blurb:'Your largest recorded day. The previous holder took it well.' },
  // ── the town ────────────────────────────────────────────────────────────────
  { id:'bricklayer',    icon:'🧱', name:'Bricklayer',       test:f=>f.b>=100,  blurb:'A hundred houses standing at once.' },
  { id:'four_hundred',  icon:'🏙', name:'Four Hundred',     test:f=>f.b>=400,  blurb:'Four hundred roofs. The surveyor has stopped counting aloud.' },
  { id:'complete_set',  icon:'🏛', name:'The Full Nine',    test:f=>f.landmarks>=9,
    blurb:'Every landmark on the ladder, in a single day.' },
  { id:'cartographer',  icon:'🗺', name:'Cartographer',     test:(f,d)=>d.seen.arch.length>=5,
    blurb:'All five kinds of town, surveyed and filed.' },
  { id:'colourist',     icon:'🎨', name:'Colourist',        test:(f,d)=>d.seen.roof.length>=10,
    blurb:'All ten roof families. The Guild of Tilers is watching you.' },
  { id:'rain_or_shine', icon:'🌦', name:'Rain or Shine',    test:(f,d)=>d.seen.biome.length>=5,
    blurb:'Five different countrysides around the same plaza.' },
  // ── the rest ────────────────────────────────────────────────────────────────
  { id:'arborist',      icon:'🌳', name:'Arborist',         test:f=>f.breaks>=10,
    blurb:'Ten groves in one day. The town is mostly trees and is fine with that.' },
  { id:'well_rested',   icon:'🛌', name:'Well Rested',      test:f=>f.longestBreakMs>=3*36e5,
    blurb:'A three-hour grove. Nothing was spent and the trees came anyway.' },
  { id:'lucky',         icon:'🎲', name:'Lucky',            test:(f,d)=>Object.keys(d.events).length>=1,
    blurb:'You were here on a day something happened.' },
  { id:'ringmaster',    icon:'🎪', name:'Ringmaster',       test:(f,d)=>uniq(d.events)>=3, secret:true,
    blurb:'Three different rare days, witnessed in person.' },
  { id:'midwinter',     icon:'❄️', name:'Midwinter',        test:f=>isSolarFeast(f.date), secret:true,
    blurb:'The town was open on the shortest day.' },
  { id:'stargazer',     icon:'🔭', name:'Stargazer',        test:f=>f.hourNow===0&&f.tok>0, secret:true,
    blurb:'Present at the turn of the day.' },
  { id:'hundred_days',  icon:'👑', name:'Hundred Days',     test:(f,d)=>d.totals.days>=100, blurb:'One hundred recorded days.' },
  { id:'year_one',      icon:'🗓', name:'Year One',         test:(f,d)=>d.totals.days>=365, blurb:'Three hundred and sixty-five.' }
];
```

25 badges, 6 of them secret. `check()` is a single `for` over the array; each `test` is O(1)
except `runLen` (24 iterations). Running it at 1 Hz costs nothing.

**Secret badges never appear before they are earned** — not greyed, not as `???` with a
count. The Ledger shows only `"🔒 6 further honours exist. They are not advertised."` The
non-secret ones show greyed with name and blurb visible: a horizon, never a task list.

`news.js` gains a `BADGE` corpus (`post('badge', {label, title})`):
```
'**{label}** is entered in the Register of Honours. The Register is mostly empty and very proud.'
'The council awards **{label}**. There is no ceremony budget, so everyone claps twice.'
'{name} pins **{label}** to the noticeboard. It falls off. It is pinned again, harder.'
'Honour recorded: **{label}**. {title}'
'A small brass plate now reads **{label}**. It will be polished by nobody, forever.'
'**{label}**. The Registry notes this and, unusually, smiles.'
```

---

## 6. THE RECORDS HALL & THE LEDGER PANEL

Click the Records Hall (or press `L`) → a 400 px panel slides in from the right over the
stage. Pure DOM + CSS, no 3D risk, no perf risk, and it is where every unearned thing lives.

```
┌──────────────────────────────────────┐
│ THE REGISTRY OF COSTRIDGE      ✕     │
│ ─────────────────────────────────    │
│  a Town  ·  41 days  ·  31.7 B all-time
│  Charter  Honours  Records  Almanac  │   ← 4 tabs
│ ─────────────────────────────────    │
│ 📜 Records Hall     2 Jul   ×41      │
│ 🪙 The Mint         6 Jul   ×12      │
│ 🕯 Almshouse        —  not chartered │
│ …                                    │
└──────────────────────────────────────┘
```

Tabs:
* **Charter** — the 11, earned ones with date + `×n`, unearned ones greyed with their blurb
  as the only hint. This is the one screen in the app where a horizon is allowed.
* **Honours** — a 5-column emoji grid; hover for name + blurb + date. Secrets collapsed into
  the one locked line.
* **Records** — best day / best hour / best session / longest day / most buildings / most
  groves, each with its date. Read straight from `doc.bests` (history designer's data).
* **Almanac** — the rank ladder with the current rung marked, lifetime totals, days recorded,
  first-seen date, and the rare-event log ("22 Jul — a travelling circus"). Footer line:
  the chronicle file path, so the user can go and look at it.

Files: `index.html` (panel markup + ~70 lines CSS in the existing register — dark card,
hairline borders, `Georgia` for the headings like `#plate`), `town.js` (open/close, `Esc`,
click-outside, hit-test branch for `kind === 'charter' && id === 'records_hall'`), and the
content builder in `charter.js` (`ledger()` returns plain data; the panel renders it — no
DOM in `charter.js` beyond a single `innerHTML` template, kept there so the copy lives with
the copy).

Guardrails: opening the panel must not pause the render loop, must not steal the pointer
from the orbit drag (`pointer-events` only on the panel), and the panel must be `display:none`
during `--shot=` runs unless `?ledger=1` (so it never eats an art screenshot).

---

## 7. RARE EVENTS — luck

One roll per local day, deterministic in `daySeed`, so a reload does not reroll and a
screenshot can force any of them.

```js
export function eventFor(daySeed) {           // pure; no state
  const r = mulberry32(fnv1a('event:' + daySeed));
  let x = r();                                 // 0..1
  for (const e of EVENTS) { if (x < e.p) return { ...e, atHour: 6 + Math.floor(r()*11) }; x -= e.p; }
  return null;                                 // ~78 % of days: nothing. That is the point.
}
```

| id | p | what you see | size | files |
|---|---|---|---|---|
| `geese` | .050 | a 14-bird V crosses the sky every ~4 min, honking in the ticker | **S** | environs (reuses the bird flock), news |
| `comet` | .045 | a comet with a drawn tail hangs in the night sky; visible only at `night > .35` | **S** | environs (sky sprite), news |
| `balloon` | .040 | a hot-air balloon drifts over at y≈55 all day, with a small ground shadow | **S/M** | buildings (mesh), town (drift), news |
| `market_fair` | .030 | 12 extra stalls + bunting ring the plaza; NPC cap +30; `fair_stage` hosts it if chartered | **M** | buildings, town, npcs, news |
| `circus` | .025 | a striped big top + 3 wagons pitch on the green outside the gate; glows at night; NPCs drift toward it | **M** | buildings, town, npcs, news |
| `fog` | .022 | low ground fog until 10:00, then it burns off over 20 min | **S** | environs, news |
| `royal_visit` | .018 | a gilded coach + 4 outriders drive the spine gate→plaza over ~6 min, then park; bunting | **M** | buildings, town(npcs route), news |
| `aurora` | .015 | northern lights all night (also the rank-6 permanent effect, same code) | **S** | environs, news |
| `the_goat` | .012 | one enormous goat stands in the plaza. All day. It is named. It does nothing. | **S** | buildings, news |
| `dragon` | .008 | a dragon perches on the tallest standing landmark, wings folding, occasional breath; NPCs point | **L** | buildings, town, npcs, news |
| `eclipse` | .004 | at `atHour`, two minutes of dusk: sun dims, birds stop, every NPC halts and looks up, then it passes | **M** | town, environs, npcs, news |

Σp = 0.259 → **roughly one day in four has something.** Rare enough to feel like luck,
common enough that a new user meets one in the first week.

`the_goat` and `dragon` are the two that will get screenshotted and sent to friends. Build
`the_goat` early — it is a scaled cylinder-and-box goat with a 1.2 s idle chew, it costs
almost nothing, and it is very funny.

**Witnessing.** `charter.witness(id)` is called by `town.js` the first frame the event is
actually rendered (not when rolled). Only witnessed events enter `doc.events` and count for
`lucky` / `ringmaster`. A day you did not open is a day the circus came and you missed it —
which is exactly the right feeling.

**Test hook:** `?event=dragon` forces one, `?event=none` suppresses. Required for art passes.

**Ticker:** one corpus key per event (6–8 lines each) plus a `RARE` arrival post. Sample —
`DRAGON`:
```
'There is a dragon on the {landmark}. The council has decided this is a matter for the {landmark}.'
'The dragon has not moved since dawn. Neither has the crowd.'
'A brave delegation approaches the dragon. A braver delegation watches from here.'
'{name} has begun selling views of the dragon from an upstairs window.'
'The dragon is described in the minutes as "large, and present".'
'No dragon-related permits were filed. This is now the third-largest scandal in town.'
'The dragon appears to be reading the Ledger. The clerks are thrilled and terrified.'
```

---

## 8. AUGURIES — daily observations that are not chores

A new news category, `AUGURY`, spoken by **the Almanac** rather than the Crier (the masthead
swaps to `☾ THE ALMANAC` for the duration of the line — a tiny, free bit of theatre that
also visually separates "prediction" from "news"). At most **4 per day**, minimum 20 min
apart, never during a cascade or a milestone hold.

### 8.1 Projection maths

```js
// minutes of "day" left uses the USER's typical stopping hour, not midnight:
//   endHour = median over the last 14 recorded days of hourOf(day.lastMs), default 22
const left   = Math.max(0, (endHour + 1) * 60 - minutesSinceLocalMidnight());
const proj   = f.tok + f.perMin * left;
const ok     = f.perMin > 0 && supportMinutes >= 20 && f.paceRatio > 0.4 && f.paceRatio < 2.5
               && proj < f.tok * 3.2;          // never make an absurd claim
```

`whenHits(target) = nowMs + (target - f.tok) / f.perMin * 6e4`, emitted only when it lands
before `endHour + 1`. Rounded to the nearest 10 minutes and printed as a clock time, because
"around 16:20" is charming and "in 3 h 41 m" is a task.

### 8.2 The corpus (~22 lines; all observational)

```
'At this rate the Ledger reaches **{tok}** around {clock}. The clerks have been notified and are unbothered.'
'The Almanac projects **{n}** buildings by dusk. The masons dispute the figure on principle.'
'Today is the **{ord}** largest morning on record. The Almanac notes this without comment.'
'You are **{tok}** ahead of this hour on your best day. That day is not available for comment.'
'~The pace suggests the {landmark} breaks ground about {clock}. Suggests. The Almanac is not a promise.'
'Half of today arrived in **{minutes}** minutes. The other half is taking its time.'
'**{pct}%** of your best day, with the light holding.'
'The Almanac has consulted the sky, the Ledger and a chicken. All three say **{tok}** by nightfall.'
'~A quiet stretch of **{minutes}** minutes. The Almanac files this under "weather".'
'At this pace {town} would be a **{title}** by {date}. The Almanac has been wrong about worse.'
'The busiest hour so far was {clock}. Nothing has topped it, though the afternoon is young.'
'Three of your last five days looked exactly like this one at exactly this hour.'
'The Almanac observes that the town is **{pct}%** built and entirely unaware of it.'
'~Today has been quiet. The Almanac approves of quiet and has said so in writing.'
'The trees planted today outnumber the houses. The Almanac declines to call this a problem.'
'By the reckoning, **{tok}** stands between here and the {landmark}. The reckoning is often optimistic.'
'{town} passed its own average about {clock}. Nobody rang anything.'
'The Almanac predicts nothing further today and considers this restraint admirable.'
```

(`~` prefix = the existing "low-key, no bold" marker used throughout `news.js`'s corpus.)

### 8.3 The quiet-day rule

If `f.tok === 0` after 11:00, the Almanac fires **once** and then goes silent for the day:
`'~Nothing yet today. The Almanac has a chair, a window, and all the time in the world.'`
No follow-up, no counter, no nudge. A day with nothing in it must be a *pleasant* day to
have the app open on, or the whole thing is a guilt machine.

---

## 9. COPY GUARDRAILS (binding; put this in the v4 spec verbatim)

Any string added by this area is rejected in review if it contains, case-insensitively:

> `you need` · `only … to go` · `keep going` · `don't stop` · `almost there` · `so close` ·
> `just` + number · `hurry` · `streak` · `you should` · `try to` · `unlock it by` ·
> `come back` · `daily goal` · `challenge` · `earn more` · any second-person imperative verb
> in the first clause.

Permitted second person: past tense and description only — *"You were here on a day something
happened."*, *"You are 40M ahead of this hour on your best day."*

The Crier and the Almanac talk **about the town**. The Ledger panel is the only surface that
may address the user directly, and even there only in the past tense.

---

## 10. RANKED BACKLOG

Delight-per-line first within each band. Sizes: **S** ≤ 120 lines, **M** ≤ 400, **L** > 400.

### MUST

| # | item | size | files touched |
|---|---|---|---|
| 1 | **Chronicle plumbing** — file, merge semantics, atomic write, IPC, `chronicle` message, `SYNTHETIC` interlock, `?chronicle=fake` canned doc | **M** | `src/chronicle.js` *(new)*, `src/main.js`, `src/preload.js`, `src/renderer/town.js` |
| 2 | **`charter.js` engine** — `initCharter`, `check`, `Award` pool, rank table, badge table, `standing()`, `siteRequests()`, `ledger()` | **M** | `src/renderer/charter.js` *(new)* |
| 3 | **`DayFacts` assembly + award pipeline** — `fillDayFacts`, 1 Hz `check`, `fireAward`, award queue reusing `drainMilestoneQueue` | **M** | `town.js` |
| 4 | **Badges (25) + `BADGE` corpus** — no geometry; the cheapest real joy in the doc | **S** | `charter.js`, `news.js` |
| 5 | **`buildPlan(seed, opts.extraSites)`** — unblocks every charter building and both rank structures; must be bit-identical with empty opts | **S** | `layout.js` |
| 6 | **`placeCharter` + `CHARTER_DEFS` + first four buildings** (`records_hall`, `mint`, `almshouse`, `lighthouse`) + `CHARTER` corpus | **L** | `buildings.js`, `town.js`, `news.js` |
| 7 | **The Ledger panel** — 4 tabs, hit-test on the Records Hall, `L` key, `?ledger=1` shot gate | **M** | `index.html`, `town.js`, `charter.js` |
| 8 | **Feed: `today` block** on `init`/`buckets` (date, tok, hours[24], firstMs, lastMs, peakBucket, breaks) — without it half the badges are range-dependent guesses | **S** | `datafeed.js` |

### SHOULD

| # | item | size | files |
|---|---|---|---|
| 9 | **Auguries** — projection maths, `AUGURY` corpus, Almanac masthead swap, quiet-day rule | **M** | `charter.js`, `news.js`, `town.js`, `index.html` (masthead class) |
| 10 | **Ranks 1–3 furniture** — green + maypole, palisade instancing, timber gate → stone gatehouse, signpost rank board, rank plate | **M** | `buildings.js`, `town.js`, `layout.js` (pinned `gatehouse` site) |
| 11 | **Rare events, tier 1** — `geese`, `comet`, `the_goat`, `fog`, `aurora` + `witness()` + `?event=` hook + per-event corpora | **M** | `charter.js`, `environs.js`, `buildings.js`, `town.js`, `news.js` |
| 12 | **Charter buildings 5–8** — `owl_post`, `vane`, `long_bridge`, `fair_stage` | **M** | `buildings.js`, `charter.js` |
| 13 | **Cold-open parade** — queue cap, summary line, seal flash in the header | **S** | `town.js`, `index.html` |
| 14 | **Rare events, tier 2** — `balloon`, `market_fair`, `circus` (incl. NPC drift toward the tent) | **L** | `buildings.js`, `town.js`, `npcs.js`, `news.js` |

### COULD

| # | item | size | files |
|---|---|---|---|
| 15 | **Rank 4 curtain wall** — hull + inflate + resample + instanced merlonated segments, frontier-gated rebuild, 3 gates | **L** | `town.js`, `buildings.js` |
| 16 | **Rank 5 towers + night watchmen** — new `'watch'` NPC state walking a supplied polyline with lanterns | **M** | `npcs.js`, `town.js`, `buildings.js` |
| 17 | **`dragon`** — the mesh, the perch selection, the NPC pointing state, the corpus | **L** | `buildings.js`, `town.js`, `npcs.js`, `news.js` |
| 18 | **`eclipse`** — 2 minutes of dusk, birds silent, every NPC halts and looks up | **M** | `town.js`, `environs.js`, `npcs.js` |
| 19 | **`century_column`** with 100 lit rings; **`reading_room`** + cache-fraction feed column; **`cartwrights`** + source-root count | **M** | `buildings.js`, `datafeed.js`, `charter.js` |
| 20 | **Rank 6 Legend** — permanent aurora, gold ridge-caps, laurel on the founding plate | **S** | `environs.js`, `buildings.js`, `town.js` |
| 21 | **`royal_visit`** — the coach route down the spine | **M** | `buildings.js`, `town.js` |

---

## 11. BUILD ORDER (for scheduling non-colliding parallel work)

```
              ┌── #4 badges ─────────────┐
#1 chronicle ─┼── #2 charter.js ── #3 pipeline ─┬── #7 ledger panel
              │                                 ├── #9 auguries
              │                                 ├── #11/#14 rare events
              └── #8 feed today ────────────────┘
#5 layout extraSites ──┬── #6 charter buildings ── #12 more buildings
                       └── #10 rank furniture ── #15 wall ── #16 watchmen
```

* **#1, #5 and #8 are the only true blockers** and they touch three disjoint owners
  (shell/feed, layout, feed) — all three can start on day one in parallel.
* **#2 + #4 need nothing but #1's schema**; `charter.js` imports nothing and is testable
  under plain Node, so a harness in the scratchpad can drive all 25 badge predicates against
  synthetic `DayFacts` before a single mesh exists.
* File collision hot spots the showrunner must serialise: `town.js` (#1, #3, #6, #7, #10,
  #13, #14) and `news.js` (#4, #6, #9, #11). Everything else is comfortably disjoint.
* `buildings.js` work (#6, #10, #12, #14, #17) is append-only — new `build*` exports and a
  new `CHARTER_DEFS` const — so several implementers can share it if each owns distinct
  functions and nobody touches the palette block.

---

## 12. VERIFICATION (headless, per the house rules)

* `?chronicle=fake` — a canned 180-day doc: rank 4 (City), 8 charter buildings, 19 badges,
  6 logged events. One flag gives every art pass a fully decorated town. **Build it first.**
* `?event=<id>` / `?event=none` — force or suppress the day's rare event.
* `?rank=<0..6>` — force a rank, bypassing the doc.
* `?ledger=1` — open the Ledger panel for the shot (it is `display:none` in shot runs otherwise).
* All progression state that a screenshot must show is wall-clock (`performance.now()`)
  driven — the 1 Hz `check`, the award queue, the augury spacing, the vane spin, the comet,
  the goat's chew, the aurora. Nothing in this area is paced by `dt`.
* Node harness in the scratchpad: import `charter.js` directly, feed it 400 synthetic days,
  assert (a) every badge fires exactly once and `n` climbs, (b) `merge()` is monotonic under
  shuffled replay, (c) `eventFor(seed)` is stable across 10 000 seeds and Σ observed
  frequency matches Σp ± 1 %, (d) `buildPlan(s)` and `buildPlan(s, {extraSites: []})` are
  bit-identical on the 8 canonical seeds.
* The one thing that cannot be caught headlessly: that the Ledger panel feels good to open.
  Ask the user.

---

## 13. What I deliberately did NOT propose

* **Any losable state** — no streaks that break, no decay, no "your town has shrunk", no
  rank demotion. R1.
* **Any goal surface outside the Ledger panel** — no "next badge" chip in the header, no
  progress ring on the seal, no notification when something is *nearly* earned.
* **Prestige / reset loops** — "raze your town for a permanent multiplier" is the exact
  mechanic that would turn this from a toy into a job.
* **Cross-day building persistence beyond the Charter** — the daily re-founding is the best
  thing about the app. The Charter works precisely *because* everything else is swept away.
* **Cosmetic unlocks the user picks** (palette choosers, hat shops). The seeded daily palette
  is a load-bearing pleasure; letting the user pin one would kill the morning surprise.
* **Anything keyed to money** — cost estimates exist in the DB and are the one number that
  could make growing the town feel bad.
