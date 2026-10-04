# Token Town v4 — DATA DEPTH

**Area owner brief.** The town currently consumes **one number** (`T`, tokens in the selected
range) and one seed. Everything else the tracker knows — which repo paid for it, what it cost,
how much was cached grain vs fresh, how much of the plan's quota is left, how many agents are
running right now, what hour of the night you were working — is sitting unused in a 160 MB
SQLite file and two JSON files eight inches away.

This document specifies what the town can honestly express with that, ranked by
signal-to-charm, with exact queries, exact numbers, exact copy, and a file-ownership table so
a parallel fleet can build it without colliding.

Everything here was **measured against the user's real database on 2026-08-06**, not guessed.
The measurements changed three of my designs; §2 is worth reading before §4.

---

## 0. THE ONE-PARAGRAPH VERSION

Build **one new feed contract** (`depth`, protocol v4) and **one new pure-data module**
(`estate.js`) first. Then six visual features hang off it, each independently schedulable:
**districts** (each repo a quarter of town), **the reservoir** (plan limits as a draining
water tower), **the treasury** (cost as coin), **the mill/forge/granary** (cache-read vs
cache-write vs output as three working buildings), **couriers** (live agent sessions as carts
on the roads), and **the shift** (night work as a lit-late town). Houses stay
model-agnostic and free-coloured throughout — nothing in this document paints a house.

---

## 1. WHAT THE TOWN CONSUMES TODAY

`datafeed.js` runs exactly five aggregate shapes, all of which collapse to `SUM(tokens)`:

| statement | dimension kept | cost |
|---|---|---|
| `tailStmt` | `(bucket, model)` over the last 2 h | ~1–3 ms |
| `histStmtFor(binMs)` | `(bucket)` over `[rangeStart, tailStart)` | 55–126 ms, once per epoch |
| `spanStmt` | scalar | ~1–300 ms |
| `maxStmt` / `gapStmt` | session boundary | 0.09 ms / 67 ms |

The `model` dimension survives **only** as an upsert key (`cell` is keyed `bucket|model` so a
streaming row can raise a cell but never double-count it). REDESIGN-V3 §12 and §14.12 forbid
the renderer reading it for anything else. Nothing in this document changes that.

**Available and unused, in the same table, at zero schema cost:**
`source_path` · `client` · `provider` · `session_id` · `message_count` ·
`input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` /
`cache_write_1h_tokens` / `reasoning_tokens` (separately, not just summed) · `updated_ms`.

**Available in two sibling files the feed already has permission to read:**
`%LOCALAPPDATA%\TokenTracker\accounts.json` (plan-limit percentages + reset times) and
`%LOCALAPPDATA%\TokenTracker\pricing-litellm.json` (1.6 MB LiteLLM catalog, refreshed daily by
the tracker). Plus `settings.json`, which the feed **already polls**, and which carries
`HidePersonalData`.

---

## 2. DATA REALITY — MEASURED, NOT ASSUMED

All figures from the user's live `usage.db` (257 110 rows, 31.9 B tokens all-time) and
`accounts.json`, read-only, 2026-08-06.

### 2.1 Projects are extremely Pareto — this is what makes districts work

Project key = the directory segment **after** `projects/` in `source_path`
(see §3.3 — the naive "parent directory" rule is wrong and I nearly shipped it).

| window | distinct projects | top-3 share | top-6 share | projects > 1 % | query time |
|---|---|---|---|---|---|
| last 8 h (≈ session) | 10 | **96.5 %** | 99.5 % | 4 | 112 ms |
| today | 10 | **96.5 %** | 99.6 % | 4 | 111 ms |
| last 7 d | 26 | 82.0 % | 96.9 % | 7 | 157 ms |
| all time | 438 | 56.8 % | 80.1 % | 9 | 316 ms |

**Design consequences.** (a) `K = 6` named quarters + one `rest` bucket covers 96–99 % of a
day and 80 % of all-time — a legible town, not a pie chart with 438 slices. (b) Shares are
brutally skewed (40 % / 33 % / 24 % / 2 % on a normal day), so any linear mapping gives one
quarter 40 % of the plat and another 0.4 % of one building. Sector widths need a floor
(§4.2). (c) A per-project group-by over the whole window costs 110–320 ms — **fine once per
epoch, fatal on a 2 s poll.** The live per-project delta must ride the 2-hour tail instead
(1–3 ms). This is the single most important perf fact in this document.

### 2.2 The token mix is 97.6 % cache reads — a two-resource split would look broken

Last 24 h, all clients:

| component | tokens | share |
|---|---|---|
| `cache_read_tokens` | 2 295 272 779 | **97.60 %** |
| `cache_write_tokens` | 45 740 610 | 1.94 % |
| ↳ of which 1-hour TTL | 7 621 261 | 0.32 % |
| `output_tokens` | 10 702 469 | 0.46 % |
| `input_tokens` (fresh, uncached) | 74 221 | **0.003 %** |
| `reasoning_tokens` | 0 | 0 % |

**Kill the obvious design.** "A windmill grinding cached grain vs a new harvest" as two
comparably-sized visuals is dishonest: the harvest is four thousandths of one percent. Fresh
input is not a resource in this data; it is a rounding error. What *is* real:

* **cache read** — the firehose. Effectively equals `T`. Best used as a **rate** (mill speed),
  never as a share of a two-part bar.
* **cache write** — bursty and meaningful: a cache write is the moment new context is *stored*.
  1.94 % of volume but it spikes at the start of every session. A **granary filling with
  sacks** is honest and it actually moves.
* **output** — 0.46 % of volume but it is *what the town made*. Precious, slow, countable.
  The **forge**. One ingot per 100 k output tokens = 107 ingots/day. Perfect scale.
* **grind ratio** = `cacheRead / output` = **214 : 1** today. A single, honest, movable stat
  and a very good Crier line.

### 2.3 Plan limits are live, three-rowed, and already on disk

`accounts.json` → 3 accounts (all `Plan: "max"`, tier `default_claude_max_20x`), each with
exactly three limit rows, refreshed every ~3 min by the tracker:

```jsonc
{"Label":"5h",    "Percent":96, "Severity":"critical", "ResetsAt":"2026-08-07T02:10:00Z"}
{"Label":"Week",  "Percent":56, "Severity":"normal",   "ResetsAt":"2026-08-08T17:00:00Z"}
{"Label":"Fable", "Percent":65, "Severity":"normal",   "ResetsAt":"2026-08-08T16:59:59Z"}
```

Also present per account: `LastSeenActiveMs`, `LastFetchedMs`, `CooldownUntilMs`, and —
**critically — `AccessToken`, `RefreshToken`, `Email`, `Id`, `OrgUuid`.** The feed must
project out exactly four fields per limit row and nothing else. See §6.

The 5-hour row resets ~5×/day and was at 96 % when I sampled it. That is a reservoir that
visibly drains and visibly refills several times a day: the highest-frequency delightful
event available anywhere in this data.

### 2.4 Sessions are plentiful and concurrent

90 distinct `session_id` in 24 h across 12 927 events. Per project per day: 18–49. Subagent
transcripts (`…/projects/<slug>/<uuid>/subagents/*.jsonl`) carry their **own** session ids, so
"sessions active in the last 10 minutes" is a genuine live count of the user's running agent
fleet — typically 2–8. That is a cart per agent.

### 2.5 The user works a real night shift

Tokens by local hour, last 7 days (bar = share of peak):

```
00 ###############      08 #####       16 ################################
01 #########            09 #           17 ########################################
02 #####                10 ######       18 ###################
03 ########             11 ############ 19 ################
04 ###                  12 ################# 20 ###################
05 ##                   13 ######################## 21 ##############
06 ##                   14 ############################ 22 #########################
07                      15 ########################### 23 ############
```

Peak 17:00; substantial work 22:00–03:00; dead 05:00–09:00. `nightShare` (tokens in local
hours 22–06 ÷ total) is ≈ 0.22 for this user. A "shift" flavour is not a hypothetical — this
town genuinely works late, and it can be computed **client-side from buckets already in the
`init` message**, for zero extra query cost.

---

## 3. THE FOUNDATION — build this before anything else

### 3.1 `estate.js` — a new, pure-data renderer module (MUST · M)

**Files:** new `town/src/renderer/estate.js`. Imports nothing (not even three.js).
**Rationale for a new file:** REDESIGN-V3 §13.6 says "no new files under `town/`". That rule
existed to keep a single-pass parallel assembly from colliding. For v4 it does the opposite:
six features all need the same derived model, and folding it into `town.js` would put six
implementers in one 2 158-line file. **Recommend the showrunner relax §13.6 to admit exactly
two new modules**, `estate.js` (data) and `civics.js` (meshes, §4.3), with the ownership
table in §7. If the showrunner refuses, the fallback is `estate.js` → the bottom of
`town.js` and `civics.js` → the bottom of `buildings.js`, at the cost of serialising the
work; everything else in this document is unchanged.

```js
// estate.js — the town's model of everything the feed knows beyond ONE number.
// Pure data: no THREE, no DOM, no queries. town.js feeds it; everyone reads it.

/**
 * @typedef {Object} District
 * @property {string} id      stable key (the project slug, or 'codex', or '~rest')
 * @property {string} label   display name — ALREADY privacy-filtered by the feed
 * @property {number} tok     absolute tokens in the range (monotonic within an epoch)
 * @property {number} share   tok / total, 0..1
 * @property {number} msg @property {number} sess
 * @property {number} a0 @property {number} a1   sector arc, radians, FROZEN at epoch start
 * @property {number} accent  0xRRGGBB from the day palette's own dots — never model-derived
 * @property {number} firstMs @property {number} lastMs
 * @property {boolean} rest   true for the "outskirts" aggregate
 * @property {boolean} fresh  appeared after the epoch was cut (goes to the outskirts)
 */

/**
 * @typedef {Object} Estate
 * @property {District[]} districts   length 0..7, share-descending, `rest` last
 * @property {(x:number,z:number)=>?District} districtAt
 * @property {{cacheRead:number, cacheWrite:number, cacheWrite1h:number,
 *            output:number, input:number, reasoning:number, msg:number,
 *            grind:number}} mix        absolute tokens for the range
 * @property {{perMinRead:number, perMinWrite:number, perMinOut:number,
 *            millK:number, forgeK:number, granaryK:number}} rates
 *            millK/forgeK/granaryK are 0.25..3.0 multipliers vs this epoch's median
 * @property {{cost:number, coins:number, unpricedShare:number, approx:boolean}} purse
 * @property {?{plan:?string, rows:LimitRow[], fetchedMs:number, stale:boolean,
 *             accounts:number}} limits    null when the tracker has never seen a sign-in
 * @property {{live:number, idle:number, total:number}} sessions
 * @property {{nightShare:number, firstMs:number, lastMs:number, shift:'day'|'evening'|'night'}} rhythm
 * @property {boolean} hidePersonal
 */

/** @typedef {Object} LimitRow
 *  @property {'burst'|'week'|'scoped'} key
 *  @property {number} pct 0..100   @property {'normal'|'warning'|'critical'} sev
 *  @property {number} resetsAtMs   0 when unknown
 *  @property {number} level        1 - pct/100, the WATER LEVEL, 0..1 */

/** Build the model. Called once per epoch with the init payload. */
export function initEstate(cfg) → Estate & {applyInit, applyDepth, update, reset}
```

Three methods:

* `applyInit(msg, plan, palette)` — cuts the sectors (once), seeds absolute totals, derives
  `rhythm` from `msg.buckets` client-side.
* `applyDepth(msg)` — folds the 2 s delta. **Same upsert-proof discipline as `foldRow`:** a
  `pjCell` map keyed `bucket|districtId`, values are absolute, a row that does not exceed the
  stored value is dropped. Never subtract, never trust a delta.
* `update(dt, now, ctx)` — recomputes `rates` on a 5 s wall-clock cadence only (same shape as
  `computePace`), so nothing here allocates per frame.

`Estate` is exposed to the other modules as **`ctx.estate`** — one new field on the shared
per-frame context (REDESIGN-V3 §2). Never reassigned; mutated in place, exactly like
`news.facts`.

### 3.2 Protocol v4 — `datafeed.js` (MUST · M)

**Files:** `town/src/datafeed.js`, `town/src/main.js` (replay + flags).

`init` gains **one** field, `depth`, and bumps `v` to 4. A v3 renderer ignores it; a v4
renderer treats its absence as "depth unavailable" and hides every feature in §4.

```jsonc
{ "type":"init", "v":4, "now":…, "range":{…}, "prev":{…}, "lat":52.2, "buckets":[…],
  "depth": {
    "projects": [ {"id":"C--Users-alex-Desktop-tokentracker", "label":"tokentracker",
                   "tok":941234567, "msg":3245, "sess":24,
                   "first":1786010000000, "last":1786066000000, "client":"claude"}, … ],
    "rest":     {"tok":12345678, "msg":41, "sess":9, "n":4},
    "mix":      {"i":74221,"o":10702469,"cr":2295272779,"cw":45740610,
                 "cw1":7621261,"rs":0,"msg":12927,"sess":90},
    "purse":    {"cost":1731.4, "unpriced":0, "approx":true},
    "limits":   {"plan":"max","fetchedMs":1786067347578,"accounts":3,
                 "rows":[{"key":"burst","pct":96,"sev":"critical","resetsAtMs":1786068600000},
                         {"key":"week","pct":56,"sev":"normal","resetsAtMs":1786215600000},
                         {"key":"scoped","pct":65,"sev":"normal","resetsAtMs":1786215599000}]},
    "hidePersonal": false
  } }
```

New message type, emitted on the existing 2 s tick, **fields omitted when unchanged**:

```jsonc
{ "type":"depth", "now":…,
  "pj":     [ {"b":1786048800000, "id":"…", "tok":80421, "msg":12, "sess":2}, … ],
  "mix":    {"i":…, "o":…, "cr":…, "cw":…, "cw1":…, "rs":…, "msg":…, "sess":…},
  "purse":  {"cost":1737.9, "unpriced":0},
  "limits": {…}          // only when accounts.json's mtime/size changed
}
```

`pj` rows are **absolute totals for buckets inside the live tail only**, exactly parallel to
`buckets`. History's per-district totals arrive once in `init.depth.projects` and are never
re-sent — same two-resolution split that already keeps `all` at 22 KB.

New statements (all measured):

```js
// live per-district tail — the ONLY per-project query on the 2 s path.  1–3 ms.
const tailPjStmt = db.prepare(`
  SELECT (timestamp_ms / ${INT_MS}) * ${INT_MS} AS b, source_path AS p, client AS c,
         SUM(${TOK_SUM}) AS tok, SUM(message_count) AS msg,
         COUNT(DISTINCT session_id) AS sess
  FROM usage_events WHERE timestamp_ms >= ?
  GROUP BY b, p, c ORDER BY b`);

// whole-window per-district roll-up — ONCE PER EPOCH. 110 ms (today) … 320 ms (all).
const spanPjStmt = db.prepare(`
  SELECT source_path AS p, client AS c, SUM(${TOK_SUM}) AS tok,
         SUM(message_count) AS msg, COUNT(DISTINCT session_id) AS sess,
         MIN(timestamp_ms) AS f, MAX(timestamp_ms) AS l
  FROM usage_events WHERE timestamp_ms >= ? GROUP BY p, c`);

// the mix + the cost inputs. Same shape at both resolutions; the tail form is 5 ms.
const mixStmt = db.prepare(`
  SELECT provider, model,
         SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr,
         SUM(cache_write_tokens) cw, SUM(cache_write_1h_tokens) cw1,
         SUM(reasoning_tokens) rs, SUM(message_count) msg, COUNT(*) n,
         COUNT(DISTINCT session_id) sess
  FROM usage_events WHERE timestamp_ms >= ? ${'AND timestamp_ms < ? '} GROUP BY provider, model`);
```

**Tick budget.** The 2 s poll gains `tailPjStmt` (1–3 ms) + `mixStmt` over the tail (5 ms) +
a stat-gated `accounts.json` read (0 ms when unchanged). Total ≈ 8 ms per 2 s = **0.4 % of
one core.** The epoch path gains `spanPjStmt` + a full-window `mixStmt`: +430 ms worst case
(`all`), on the path that already spends 126 ms and is followed by a 1.4 s cascade. Acceptable;
log it to stderr alongside the existing range line.

**Back-off.** Wrap the depth queries in their own try/catch with the existing `failUntil`
idiom. **A depth failure must never suppress the `init`** — the town's core loop is one
number and it has to keep working. On failure emit `init` with `depth` absent and log once.

**`main.js`:** add `depth` to the replay cache next to `lastInit`/`lastConfig` (a renderer
reload otherwise loses every §4 feature until the next epoch), and forward the new test
flags (§8).

### 3.3 The project key — the rule that is not obvious

`source_path` shapes actually present in this database:

```
 …/.claude/projects/C--Users-alex-Desktop-<project>/<uuid>.jsonl
 …/.claude/projects/C--Users-alex-Desktop-<project>/<uuid>/subagents/<file>.jsonl   ← nested!
 …/<scratch-uuid>/scratchpad/worktrees/wf_<hash>/…/<file>.jsonl                    ← discovered root
 …/.codex/sessions/2026/08/06/rollout-<id>.jsonl                                   ← date-partitioned
```

**Grouping by the parent directory is wrong.** It splits every project into `<project>` plus
one bucket per subagent run — my first probe reported 17 "projects" for a day where there are
really 10, with `subagents` as the top three entries. The correct rule:

```js
const GENERIC = new Set(['subagents','projects','sessions','logs','history','transcripts','.claude','.codex']);
function projectIdOf(sourcePath, client) {
  const parts = String(sourcePath).replace(/\\/g,'/').split('/').filter(Boolean);
  parts.pop();                                            // drop the file name
  if (client === 'codex') return 'codex';                 // date-partitioned: no project exists
  const i = parts.lastIndexOf('projects');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];        // ← merges subagents into their parent
  for (let k = parts.length - 1; k >= 0; k--)
    if (!GENERIC.has(parts[k]) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(parts[k])) return parts[k];
  return 'unknown';
}
// "C--Users-alex-Desktop-tokentracker" → "tokentracker"; "wf_fb1c…-f7b" → "wf_fb1c…"
function projectLabelOf(id) {
  if (id === 'codex') return 'Codex';
  const s = /^[A-Za-z]--(.*)$/.exec(id)?.[1] ?? id;
  const seg = s.split('-').filter(Boolean);
  return (seg.length > 1 ? seg[seg.length - 1] : s).slice(0, 22);
}
```

**Codex has no project attribution and never will** — the parser stores no cwd, and the path
is a date tree. 26.2 % of all-time tokens land there. It gets **one** district, `Codex`, and
that is honest. Do not fabricate one.

---

## 4. THE PROPOSALS

Ranked by signal-to-charm. Each: the query · the visual · the failure mode · the
model-agnostic check · size · files.

### 4.1 Summary table

| # | feature | rank | size | primary files |
|---|---|---|---|---|
| D0 | `estate.js` + protocol v4 (§3) | **MUST** | M | `estate.js`(new), `datafeed.js`, `main.js`, `town.js` |
| D1 | **Districts** — a quarter per repo | **MUST** | L | `estate.js`, `civics.js`(new), `layout.js`, `town.js`, `news.js` |
| D2 | **The Reservoir** — plan limits as water | **MUST** | M | `datafeed.js`, `civics.js`, `town.js`, `news.js` |
| D3 | **The Treasury** — cost as coin | SHOULD | M | `datafeed.js`, `civics.js`, `town.js`, `news.js` |
| D4 | **Mill · Forge · Granary** — the mix | SHOULD | S | `estate.js`, `town.js`, `buildings.js` |
| D5 | **Couriers** — live agent sessions | SHOULD | M | `npcs.js`, `town.js`, `news.js` |
| D6 | **The Shift** — night work | SHOULD | S | `estate.js`, `town.js`, `environs.js`, `news.js` |
| D7 | **Cranes** — burst rate | COULD | S | `buildings.js`, `town.js` |
| D8 | **The Quarter Register** — the legible board | COULD | S | `civics.js`, `town.js` |
| D9 | **The Working Day** — signpost lower board | COULD | S | `town.js` |

---

### 4.2 D1 — DISTRICTS (MUST · L)

> *Each repo is a quarter of town, sized by what it burned. The signpost at its mouth names
> it. Nothing about a house changes.*

**Query.** `spanPjStmt` at init + `tailPjStmt` on the poll (§3.2). Nothing else.

**The model.** `estate.districts` = the top **6** by `tok`, plus a `rest` aggregate when more
exist. Measured: this covers 99.6 % of a day, 96.9 % of a week, 80.1 % of all-time.

**Sector cutting — the invariant that keeps it stable.**

```js
// Cut ONCE, at the epoch's first init. Angles are FROZEN for the epoch; only the
// numbers move afterwards. This is the same discipline as the frozen window anchor:
// a boundary marker that walks around the plaza every 2 s is a nervous tic.
const MIN_ARC = 0.34;                       // ≈ 19.5°, the narrowest legible quarter
function cutSectors(list, gateYaw) {
  const w = list.map(d => Math.max(MIN_ARC, 2 * Math.PI * d.share));
  const k = 2 * Math.PI / w.reduce((a, b) => a + b, 0);          // renormalise
  let a = gateYaw;                                              // the main road is a boundary
  for (let i = 0; i < list.length; i++) {
    list[i].a0 = a; a += w[i] * k; list[i].a1 = a;
  }
}
const districtAt = (x, z) => {              // O(7), allocation-free
  let a = Math.atan2(z, x); if (a < d0.a0) a += 2 * Math.PI;
  for (const d of districts) if (a >= d.a0 && a < d.a1) return d;
  return districts[districts.length - 1];
};
```

Plots are roughly uniform in angle around the plaza, so a 40 % sector holds ~40 % of the
buildings without anything ever moving a plot. **`plotAt(i)` is untouched.** That is the
whole trick: district membership is a property of *where you stand*, derived, never stored on
an entity, never a reason to remount a house.

**The visual — four cooperating marks, none of them a house:**

1. **Boundary posts.** At each sector's `a0`, on the ring `r = plazaR + 9`, a carved post with
   a small painted board carrying the quarter's name — built from the same `makeBoardTex()`
   machinery the signpost already uses (`town.js:796`). 7 posts max, ~4 draws each after
   `freezeStatic`. Hover receipt: name · share · sessions · first→last seen.
2. **Pennants.** Every road lamp inside a sector gets a 0.5 × 0.32 cloth quad on its pole,
   tinted with the district's `accent`. The lamps are already a pool of 26 re-posed per epoch
   (`placeRoadLamps`); the pennant is one extra child and one shared material per district.
   **The accent comes from `palette().dots`** — the day's own palette — indexed by rank, so a
   quarter is coloured by *how big it is today*, never by what ran in it.
3. **Verge tint on the road plate.** `plan.paintGround(g, X, opt)` gains
   `opt.districts = [{a0, a1, accent}]` and washes the verge stroke 6 % toward the accent
   inside each sector, before the road surface layer. This is a **layout.js** change: one new
   optional field, ignored when absent.
4. **The Quarter Register** (D8) — the board that makes it legible in a screenshot.

**Growth cascade.** When a building spawns, `estate.districtAt(p.x, p.z)` names its quarter;
the existing `+N houses!` floater becomes `+5 houses in Kilnfield` when the district is named
and `+5 houses` otherwise. One string change in `drainSpawnQueue`.

**Failure modes.**
* *No `depth`* (v3 feed, query failed, hidden by flag) → `estate.districts = []`, no posts, no
  pennants, no register, `districtAt` returns null, every call site falls back to today's copy.
  The town is exactly v3.
* *One project* → one district covering the town. **Suppress all four marks.** A town of one
  quarter is just a town; naming it is noise.
* *A new project appears mid-epoch* → its rows fold into `rest`. Do not re-cut. The Crier gets
  a line: `Surveyors out past the {name} road — a new quarter is being platted.` It becomes a
  real quarter at the next epoch, which for `today` is tomorrow and for `last4` is 30 minutes.
* *Project with 0.05 % share* → below `MIN_ARC` it is folded into `rest` before cutting; the
  threshold is `share < 0.008` **or** rank > 6.
* *Codex* → one district, label `Codex`, no special geometry (§3.3).

**Model-agnostic check.** ✅ Passes. Houses keep `paintHouse(idx, band)` untouched; the
district accent only ever touches civic furniture (posts, pennants, verge wash) and comes from
the day palette, not from any model or provider.

**Privacy.** District labels are produced **in the feed**, already filtered (§6). The renderer
never sees a path.

---

### 4.3 D2 — THE RESERVOIR (MUST · M)

> *A stone water tower on the plaza's edge. The week's allowance is the tank; the five-hour
> burst is the cistern beside it. You watch the level drop while you work, and when it resets
> the town gets its water back and cheers.*

**Source.** `%LOCALAPPDATA%\TokenTracker\accounts.json`, stat-gated (mtime + size) exactly
like `settings.json`, with the same torn-read discipline: **on a parse failure, return without
latching the stat.** The tracker rewrites this file every ~3 min.

**Selection.** Active account = max `LastSeenActiveMs`, ties broken by max `LastFetchedMs`.
`accounts` = the count, for the tooltip. Never emit `Id`, `Email`, `OrgUuid`, `AccessToken`,
`RefreshToken`, `ExpiresAtMs`.

**Row keying.** Map Anthropic's labels to town-stable keys so copy never depends on them:

```js
const LIMIT_KEY = lbl => /^\d+\s*h$/i.test(lbl) ? 'burst'
                       : /week/i.test(lbl)      ? 'week'
                       : 'scoped';                 // anything else, incl. a model-named row
```

**The third row is currently labelled `"Fable"` — a model name.** REDESIGN-V3 §12 forbids any
copy naming a model. The town therefore keys it `scoped` and calls it **"the deep well (the
scoped allowance)"**, never printing the API's label. *Flag for the showrunner: this is a
judgement call; the tracker's own hero row went the other way and prints Anthropic's label.
I recommend the town stay generic — it is a toy, and "Fable's reservoir" would be the one
place a model name leaks back into a design that spent §12 removing them.*

**The visual.** Three vessels on a stone plinth at `angle = plan.gate.yaw + π`,
`r = plazaR + 6.5` (opposite the signpost, so the two civic objects book-end the plaza):

| key | vessel | height | reads |
|---|---|---|---|
| `week` | **the high tower** — timber legs + banded tank, visible from the whole plat | 9.4 | the long game |
| `burst` | **the cistern** — squat round stone tank at its foot | 2.6 | right now |
| `scoped` | **the deep well** — a capped shaft with a glass level tube | 2.0 | the third allowance |

Water is a cylinder using `palette().water` (the same material the `well` flavour already
uses — free continuity). Level is **state**, so it is written directly from the feed:

```js
setLevel(v, lvl) {                      // lvl = 1 - pct/100
  v.water.scale.y = Math.max(0.001, lvl);
  v.water.position.y = v.base + v.h * lvl * 0.5;
  v.stainMat.opacity = 0.55 * (1 - lvl);          // a tide-mark above the waterline
}
```

**The refill ceremony** — the highest-frequency reward in the whole app (~5×/day for `burst`):
when `resetsAtMs` moves forward **and** `pct` drops by ≥ 25 points, run a 2.4 s wall-clock
fill (`easeOutCubic` on `performance.now()`), a `burst3d` of `palette().water` at the spout,
`npcs.celebrate(towerPos, {runners: 4, cheerRadius: 30})`, and `news.post('refill', {key})`.

**Severity.** At `sev === 'warning'` an amber pennant runs up the tower; at `'critical'` a red
one, and a small queue of villagers forms at the pump. **No klaxon, no scolding copy.** The
vibe bible is binding: this is a toy.

**Failure modes.**
* *No `accounts.json`, or no `Limits` on any account* → `limits: null` → **no tower is built
  at all.** An empty vessel reads as "you are out of water", which is a lie. Absence is the
  honest state.
* *Stale* (`now - fetchedMs > 20 min`) → tower present, water surface stops moving, the
  material desaturates 30 %, tooltip line 3 becomes `gauge last read 41 min ago`.
* *`CooldownUntilMs` in the future* → same as stale, tooltip `the gauge-keeper is resting`.
* *Multiple accounts* → active one only; tooltip `account 1 of 3` (no names, either mode).
* *A row with `Percent: 0` and a future reset* (the C# synthesises these) → full tank, no
  ceremony (guarded by the ≥ 25-point drop test).
* *`pct` > 100* → clamp to 100.

**Model-agnostic check.** ✅ once the `scoped` row is de-labelled. No house is touched.

**Privacy.** `plan` (`"max"`) is shown only when `!hidePersonal`; the tooltip degrades to
`the town's allowance` otherwise. Percentages and reset times are shown in both modes —
they are about the work, not the person.

---

### 4.4 D3 — THE TREASURY / THE MINT (SHOULD · M)

> *"The crown would have charged ≈ $1,730 for today's work." A vault of coin beside the altar,
> and a mint that strikes one more every time you earn it.*

**Query.** `mixStmt` grouped by `(provider, model)` (§3.2) — already needed for D4 — priced in
the feed against `pricing-litellm.json`.

**Pricing in the feed.** Read the tracker's own cache once at feed start (1.6 MB parse,
~60 ms, in the process that already spends 126 ms on a range query). Implement a **reduced**
`Calculate`: flat `input / output / cache_read / cache_creation` rates plus the 1-hour
surcharge, with `PricingService`'s family fallback (`opus → 5/25/0.5/6.25`,
`sonnet → 3/15/0.3/3.75`, `haiku → 1/5/0.1/1.25`, `fable|mythos → 10/50/1/12.5`) and its
`(fast)` ×2 rule. **Do not port the >128k/200k/256k/272k tiering** — it is per-request and
cannot be recovered from an aggregate; `UsageDatabase.GetDailyUsageAsync` prices row by row
precisely because of that.

**Therefore the town's figure is an estimate and must say so.** This codebase has already been
burned twice by two owners of one number (the hero vs the altar ledger). The rule:

> **The town never prints a cost to the cent and always prefixes `≈`.** Three significant
> figures, `≈$1.73k` / `≈$47.20`. The tracker owns the exact number; the town owns the story.

Measured for last 24 h: cache read 2 295 M × $0.50/M = $1 148 · output 10.7 M × $25/M = $268 ·
cache write 45.7 M × $6.25/M = $286 · 1 h surcharge 7.6 M × $3.75/M = $29 → **≈ $1 730/day.**

**The visual.**
* **The Vault** — a low stone strongroom at the plaza's third corner with an
  `InstancedMesh` coin hoard inside a glassless arch: `coins = clamp(floor(cost / 25), 0, 220)`
  → 2 coins at $50, 69 today, capped at a hoard. One draw call.
* **The Mint** — struck coins arrive: every time `floor(cost/25)` increments, `burst3d` two
  gold particles at the mint door and slide one coin instance into the vault. At a 40-coin
  day that is 40 small rewards spread across the day, which is exactly the cadence the
  minor-milestone ladder was tuned to (`minorStep`, `town.js:1173`).
* Hover receipt: `The Vault · ≈$1.73k at list price · 214 sacks per ingot`.

**Why this is worth building even though cost ≈ 0.73 × tokens.** Cost is *almost* collinear
with `T` — and that is precisely the point of the framing. It is the one number that moves
with **model choice** independent of volume (an Opus day costs 10× a Haiku day at equal
tokens), and it is the number a subscriber can be proud of: a fixed monthly plan delivering
$1 730 of list-price work in a day. The charm is entirely in the framing; without the
"the crown would have charged" line it is a redundant second counter and should not ship.

**Failure modes.** No `pricing-litellm.json` → use the built-in family table only, still
emit, still `≈`. An unpriced model (`unpriced > 0`) → the vault gets a
`+{n} unpriced` note in the tooltip and the coins under-count honestly. Cost 0 → no vault.

**Model-agnostic check.** ✅ The vault is one object; it does not decompose cost by model
anywhere in the renderer. The feed groups by model **only to price correctly** and sends a
single scalar — the same discipline as `cell`'s model key.

---

### 4.5 D4 — THE MILL, THE FORGE AND THE GRANARY (SHOULD · S)

> *Three buildings that already exist start working at the rate the data says they work at.*

`buildings.js` already ships `windmill` (with a spinning sail `hub`), `forge` (with an
emissive `coal` material) and `bakery`/`farm` (with `smoke` emitters). This is the cheapest
charm-per-line item in the document: **no new mesh at all.**

| resource | building | driven by | measured today |
|---|---|---|---|
| `cache_read` | the **Mill** — sail speed | `rates.millK` | 1.59 M/min |
| `output` | the **Forge** — coal glow + ingot count | `rates.forgeK` | 7.4 k/min |
| `cache_write` | the **Granary** — fill level + sack drops | `rates.granaryK` | 31.7 k/min, bursty |

```js
// estate.js — a 5 s wall-clock recompute, exactly like computePace()
const kOf = (perMin, median) => median > 0 ? clamp(perMin / median, .25, 3) : 1;
rates.millK    = kOf(rates.perMinRead,  medRead);
rates.forgeK   = kOf(rates.perMinOut,   medOut);
rates.granaryK = kOf(rates.perMinWrite, medWrite);
```

**The one code change that matters.** `town.js:1997` drives spin as
`a.obj.rotation[a.axis] = a.phase + now * a.rate` — an absolute function of the clock, so
multiplying `a.rate` makes the sails *jump*. Switch to accumulation:

```js
if (u.spin) for (const a of u.spin) {
  a.ang = (a.ang === undefined ? a.phase : a.ang) + a.rate * 1000 * dt * (a.k ? ctx.estate.rates[a.k] : 1);
  a.obj.rotation[a.axis] = a.ang;
}
```
`buildings.js` tags the windmill's spin entry `k: 'millK'`. Spin is **cosmetic motion**, so
`dt` is legal here (REDESIGN-V3 §13.2). But the *legible* state must be wall-clock: the
forge's `glow` intensity is written directly from `forgeK` (`day: .6 * forgeK`), the granary's
fill is a scale, and the numbers go in the footer and the tooltips — all of which a 1 fps
headless shot reads correctly.

**The stat that earns its place in the footer.** `grind = cacheRead / max(output, 1)` =
**214 : 1**. One line: `<b>214</b> sacks milled per ingot`. It moves (a long-output day drops
it toward 80), it is honest, and it is the only view anyone has ever given this user of what
prompt caching is actually doing for them.

**Failure modes.** `output === 0` (a pure cache-read window, possible on a very short range)
→ suppress the grind stat and idle the forge, do not divide by zero. No windmill/forge in the
current plan (flavour is a 1-in-6 seeded sprinkle) → the rates still drive the footer stat and
the Crier; the buildings are a bonus, not the channel.

**Model-agnostic check.** ✅ Nothing here reads `model`.

---

### 4.6 D5 — COURIERS (SHOULD · M)

> *One cart on the road for every agent you have running right now.*

**Signal.** `COUNT(DISTINCT session_id)` over the last 10 minutes of the tail, per district.
Cheap: it is already in `tailPjStmt`'s `sess` column; the renderer sums the last two buckets.
Measured: 90 sessions/day, 2–8 concurrent, subagents counted separately — which is a *feature*
for a user who runs fleets.

**The visual.** `npcs.js` gains a `courier` state on the existing pool (no new entity type,
no new draw call class): a villager who walks `plan.pathTo(districtNode, plazaNode)` towing a
small `InstancedMesh` crate, unloads at the market, and walks back. `live` couriers exist,
`idle` ones are parked at the market hall with their crates stacked. When a session's district
is known the cart starts from that quarter's boundary post — which visibly ties D1 and D5
together, and is the moment the whole data-depth idea becomes obvious to a first-time viewer.

```js
// npcs.js cfg gains:
//   couriers: () => ({live: 6, idle: 3, from: [{a: 1.2, n: 3}, …]})   // sector angle + count
```

**Failure modes.** No depth → `couriers` returns `{live:0}` and the state never activates.
A session id that spans districts (subagent under a parent) → attributed to its own
`source_path`, which is the parent project's tree: correct by construction.
More than 12 live → cap at 12 carts and let the footer carry the number.

**Model-agnostic check.** ✅

---

### 4.7 D6 — THE SHIFT (SHOULD · S)

> *The town knows you work nights, and dresses for it.*

**Query: none.** Computed in `estate.applyInit` from `msg.buckets`, which are already there:

```js
let night = 0, all = 0;
for (const r of buckets) { const h = new Date(r.b).getHours();
  all += r.tok; if (h >= 22 || h < 6) night += r.tok; }
rhythm.nightShare = all > 0 ? night / all : 0;
rhythm.shift = rhythm.nightShare > .30 ? 'night'
             : rhythm.nightShare > .12 ? 'evening' : 'day';
```
Measured for this user over 7 days: **0.22 → `evening`**, and on a late day it crosses 0.30.

**The visual.** `shift === 'night'` (or `'evening'` after 21:00 local):
* lamps light 40 min earlier and the `POOL_MAT` night ramp starts at `night > .18` instead of
  `.25` — the town is lit while you are still working;
* one villager becomes a **lamplighter** with a pole, walking the spine (npcs, tiny);
* `environs` gets `ctx.estate.rhythm.shift` and biases its evening haze warm;
* the Crier gets a `SHIFT` category (§9).

**Failure modes.** Coarse bins (`all` folds to 6 h) → an hour attribution of ±3 h. Guard:
only compute `nightShare` when `range.binMs <= 3600e3`; otherwise `shift = 'day'` and say
nothing. Empty window → `'day'`.

**Model-agnostic check.** ✅

---

### 4.8 D7 — CRANES (COULD · S)

`ctx.paceRatio` already exists and `buildScaffold()` already exists. Add a jib to the meter
scaffold whose swing period is `1400 / clamp(paceRatio, .4, 2.5)` ms and whose hook carries a
block during a `surge` or `cascade` drain. Pure cosmetic; `dt`-driven is fine. ~40 lines in
`buildings.js` + 6 in `town.js`. It is the smallest thing here that makes a token burst *look*
like a burst at the frontier, where the eye already is.

**Failure mode:** none — `paceRatio` defaults to 1.

### 4.9 D8 — THE QUARTER REGISTER (COULD · S, but do it with D1)

A waist-high stone lectern beside the altar carrying a `CanvasTexture` board (same technique
as `monument.js`'s ledger). Six rows: `▌ Kilnfield ······ 39.9 %  ·  24 sessions`. This is
**the thing that makes districts legible in a headless screenshot**, where pennants are 3 px
and posts are unreadable. If D1 ships without D8, half its signal is invisible in every
screenshot in `docs/`. Treat as part of D1's definition of done.

Repaint on the 500 ms stats tick only when a share moves by ≥ 0.5 pt. Redraw cost ~1.5 ms.

### 4.10 D9 — THE WORKING DAY (COULD · S)

The signpost's lower board already carries the range (`dressSignpost`). Add a third line from
`estate.rhythm`: `09:12 → 01:44 · 15 h 32`. Free — `firstMs`/`lastMs` come from
`spanPjStmt`. One `makeBoardTex` call per epoch.

---

## 5. RANKED BY SIGNAL-TO-CHARM (the honest ordering)

| rank | feature | signal | charm | why |
|---|---|---|---|---|
| 1 | **D2 Reservoir** | ★★★★★ | ★★★★★ | The only number in the whole app that answers "can I keep going?", it moves every few minutes, it visibly refills five times a day, and it is already on disk. |
| 2 | **D1 Districts** | ★★★★★ | ★★★★☆ | Turns one number into a *map of your week*. The 96.5 %-in-3 skew means it reads instantly. Largest build. |
| 3 | **D4 Mill/Forge/Granary** | ★★★☆☆ | ★★★★★ | Best charm-per-line in the document: three existing buildings start working. The 214:1 grind stat is genuinely new information. |
| 4 | **D3 Treasury** | ★★★☆☆ | ★★★★★ | Nearly collinear with `T`, but "the crown would have charged ≈$1.73k" is the single most brag-worthy sentence this data can produce. |
| 5 | **D5 Couriers** | ★★★★☆ | ★★★★☆ | A cart per running agent is the truest picture of how this user actually works. Costs an npcs state machine. |
| 6 | **D6 The Shift** | ★★★☆☆ | ★★★☆☆ | Zero query cost, real signal (0.22 night share), small dressing payoff. |
| 7 | **D7 Cranes** | ★★☆☆☆ | ★★★☆☆ | Duplicates `paceRatio`, which environs already reads as weather. Cheap, safe, optional. |
| 8 | **D9 Working day** | ★★★☆☆ | ★★☆☆☆ | True and quiet. One line on a board nobody hovers. |

**Deliberately rejected.**
* *Fresh-input vs cached as two comparable resources* — 0.003 % vs 97.6 % (§2.2). The visual
  would be a full silo and an empty one, forever.
* *Per-model districts / any model-derived colour* — REDESIGN-V3 §12, and the user's rule.
* *Cost broken out per model in the renderer* — same reason; the feed prices by model and
  sends a scalar.
* *A per-project group-by on the 2 s poll* — 110–320 ms every 2 s (§2.1). The tail split
  exists precisely to avoid this.
* *Naming the third limit row from the API* — it is currently a model name (§4.3).

---

## 6. PRIVACY

The tracker has `HidePersonalData` in `settings.json`, which the feed **already polls**.
Add it to the four content-compared fields (a change re-emits `depth`, it does **not** reset
the epoch — it is cosmetic, exactly like `lat`).

**Rules, binding on every implementer:**

1. **The renderer never receives a filesystem path.** Labels are produced in
   `datafeed.js` by `projectLabelOf()` and are at most 22 characters. `id` is opaque to the
   renderer (a grouping key only) — and when `hidePersonal` is on, even the `id` is replaced
   by `q1`…`q6`, so a devtools inspection leaks nothing.
2. **`hidePersonal === true` → generic quarter names**, assigned by rank from a seeded rotation
   of the day's `planSeed`:
   `['Kilnfield','Quayside','The Shambles','Highgate','Old Town','The Warrens','Netherbridge','Saltgate','Coldharbour','Marrowlane']`.
   These must be *charming*, not placeholders: every screenshot in `docs/` is taken with the
   toggle on (per CLAUDE.md), so these are the names the world will see.
3. **Never emitted, in either mode:** `AccessToken`, `RefreshToken`, `Email`, account `Id`,
   `OrgUuid`, `ExpiresAtMs`, any `source_path`, any `session_id`.
4. **Suppressed when `hidePersonal`:** the plan name (`"max"` → `the town's allowance`), the
   account count (`account 1 of 3` → omitted), and the project label everywhere including
   floaters, tooltips, the Register, boundary posts and Crier copy.
5. **Shown in both modes:** limit percentages, reset times, cost, token mix, session counts,
   `nightShare`. None of these identifies anything.
6. The feed must apply the filter **at emit time**, not at render time. A renderer that had
   the real name and chose not to draw it is one `console.log` from a leak.

---

## 7. FILE OWNERSHIP — for non-colliding parallel scheduling

| file | D0 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 |
|---|---|---|---|---|---|---|---|---|---|---|
| `src/datafeed.js` | **own** | r | **own** | **own** | r | · | · | · | · | r |
| `src/main.js` | **own** | · | · | · | · | · | · | · | · | · |
| `src/renderer/estate.js` *(new)* | **own** | edit | edit | edit | edit | edit | edit | · | r | edit |
| `src/renderer/civics.js` *(new)* | · | **own** | edit | edit | · | · | · | · | edit | · |
| `src/renderer/town.js` | edit | edit | edit | edit | edit | edit | edit | edit | edit | edit |
| `src/renderer/layout.js` | · | **own** (`paintGround` opt) | · | · | · | · | · | · | · | · |
| `src/renderer/buildings.js` | · | · | · | · | **own** (`spin.k`) | · | · | **own** | · | · |
| `src/renderer/npcs.js` | · | · | · | · | · | **own** | edit | · | · | · |
| `src/renderer/environs.js` | · | · | · | · | · | · | **own** | · | · | · |
| `src/renderer/news.js` | · | edit | edit | edit | edit | edit | edit | · | · | · |
| `src/renderer/index.html` | · | edit | · | · | edit | · | · | · | · | · |

**`town.js` is the collision hazard: every item edits it.** Mitigation — cut its v4 surface
into six *named, disjoint* regions up front, in one preparatory commit before the fleet
starts:

```
/* ═══ v4: estate wiring ═══ */          ← D0 only
/* ═══ v4: districts ═══ */              ← D1, D8
/* ═══ v4: civics mount ═══ */           ← D2, D3
/* ═══ v4: rates → animation ═══ */      ← D4, D7
/* ═══ v4: couriers ═══ */               ← D5
/* ═══ v4: rhythm ═══ */                 ← D6, D9
```

Plus one shared, pre-agreed edit landing in the D0 commit: `ctx.estate` added to the `TownCtx`
typedef and initialised to a null-object estate, so every later item can assume it exists.

**Build order.** D0 → (D1 ‖ D2 ‖ D4) → (D3 ‖ D6 ‖ D8 ‖ D9) → (D5 ‖ D7).
D2 and D4 have no dependency on D1; D8 must land with D1; D5 wants D1's sectors but degrades
to "carts from the town edge" without them.

---

## 8. TEST HOOKS (extend REDESIGN-V3 §13.8)

| hook | owner | effect |
|---|---|---|
| `--depth=0` | feed | suppress the `depth` block and `depth` messages — proves every v4 feature degrades to v3 |
| `--projects=N` | feed | synthesise N districts with a geometric share decay (0.4, 0.24, 0.14, …) — the only way to screenshot a 7-quarter town on a 3-project day |
| `--limits=<pct,pct,pct>` | feed | force the three limit rows; `--limits=none` forces the no-tower path |
| `--limit-reset=<ms>` | feed | fire a refill ceremony `ms` from now, inside one screenshot |
| `--cost=<usd>` | feed | force the purse |
| `--mix=<cr,cw,o>` | feed | force the mix, for mill/forge/granary extremes |
| `--shift=day\|evening\|night` | core | force `rhythm.shift` |
| `--hide=1` | feed | force `hidePersonal` regardless of settings.json — **required**, because every `docs/` screenshot uses it |

Demo mode (no preload bridge) must synthesise a full `depth`: 4 districts at
`[.42,.31,.19,.08]`, limits at `[62, 44, 51]` with the burst row resetting 40 s out, cost
`$412`, mix `[cr 97.4 %, cw 2.1 %, o 0.5 %]`. REDESIGN-V3 §13.3 makes this contractual.

**Verification, unchanged and binding:** headless only, from the scratchpad —
`npx electron . --shot=<abs>.png --shot-delay=9000 --hour=13`. Never open a window.

---

## 9. COPY

New `news.js` corpus categories (`CORPUS` + `CAT_OF` + `URGENT` entries):

**`QUARTER`** (district events)
```
"{label} is the busiest quarter today — {pct}% of everything that moved."
"Surveyors out past the {label} road. A new quarter is being platted."
"{label} and {label2} between them account for {pct}% of the town's trade."
"Quiet week in {label}. The shutters are up, the street is swept."
"Three quarters, one town, and everybody claims theirs is the oldest."
```

**`WATER`** (D2)
```
"The cistern's at {pct}%. The well-keeper starts counting buckets."
"Water's back! The tower filled at {clock} and the whole street came out to see."
"The high tower stands at {pct}% for the week. Comfortable, says the keeper."
"Low water in the deep well. Nobody's worried. Nobody's washing, either."
"The gauge hasn't been read since {clock}. The keeper is asleep in the shade."
```

**`PURSE`** (D3)
```
"The vault took another {coins} coins today — ≈{cost} at the crown's own prices."
"≈{cost} of work, on a purse that never opens. The treasurer is delighted."
"The mint struck {coins} today. Nobody outside town would believe the rate."
```

**`MILL`** (D4)
```
"{grind} sacks milled for every ingot the forge turned out. The miller is smug."
"The granary took {sacks} sacks this hour — new stores, fresh from the cart."
"Sails turning hard. You can hear the mill from the bridge."
"The forge is cold. Plenty of grain, nothing to hammer."
```

**`SHIFT`** (D6)
```
"Lamps lit early. {name} keeps late hours and everybody knows it."
"The night shift is the real shift here."
"Third night this week the mill was still turning at two."
```

**Copy rules.** No model name, ever (§12 audit). No scolding — a full reservoir and an empty
one both get an affectionate line. No filesystem paths. `{label}` is always the
privacy-filtered name. Every `{pct}` is an integer; every `{cost}` carries `≈`.

**Bubbles** (`say`) gain two kinds: `courier` (`"Two more crates for the market."`,
`"Mind the cart!"`) and `keeper` (`"She'll fill again at ten past."`, `"Down to a quarter.
Been lower."`).

---

## 10. PERFORMANCE BUDGET

| item | draws | materials | per-frame cost |
|---|---|---|---|
| D1 boundary posts (≤ 7) | ≤ 28 | 2 shared + 7 board maps | 0 (frozen) |
| D1 pennants (≤ 26 lamps) | 26 | ≤ 7 shared | 0 (frozen) |
| D1 verge tint | 0 | 0 | 0 (baked into the existing plate) |
| D2 reservoir (3 vessels) | 14 | 4 shared + `palette().water` | ~0 (level = a scale write on state change) |
| D3 vault + mint | 5 + 1 instanced | 3 | 0 |
| D4 | 0 new | 0 new | 3 float writes in the existing `animEnts` loop |
| D5 couriers (≤ 12) | 1 instanced crate mesh | 1 | inside the existing npc walk |
| D8 register | 2 | 1 canvas | 1.5 ms, ≤ 2×/s, only on a ≥ 0.5 pt change |

**Total: ≤ 76 draws, ≤ 19 materials, zero per-frame allocation.** That fits inside the v3
headroom at the 1 200-building cap; the constraint that actually binds is *material count*,
so every district accent must be a **shared** material indexed by rank, never a per-object
clone.

Feed: +8 ms per 2 s tick, +430 ms worst case once per epoch (§3.2).

---

## 11. THE INVARIANTS THIS DOCUMENT ADDS

1. **The town's headline number is still `T`.** Nothing in §4 may change `T`, `townSize(T)`,
   the milestone ladder, or when a house spawns. Depth decorates; it never drives growth.
2. **Depth is optional at every level.** Missing `depth`, a failed query, a v3 feed, a
   `--depth=0` run: the town must be *exactly v3*, silently. No banner, no empty vessel, no
   `undefined` in a tooltip.
3. **Absolute, never delta.** Every depth quantity that accumulates (`pj`, `mix`, `purse`)
   arrives as an absolute total and folds through an upsert-proof cell map, for the same
   reason `foldRow` exists: rows are upserted while a response streams.
4. **Sectors freeze at the epoch.** Shares move; boundaries do not.
5. **Levels and counts are wall-clock state.** Reservoir level, coin count, quarter shares and
   the register board are written directly from feed values; only their *transitions*
   (the fill, the coin slide, the sail spin) may be eased, and only the sail spin may use `dt`.
6. **Nothing here paints a house.** `paintHouse`, `paintFlavor`, `TIER_NAMES`, `rareOf` and
   the day palette are untouched. If a proposal ever needs a house to carry a colour, it is
   the wrong proposal.
7. **The feed still writes nothing** — not `usage.db`, not `settings.json`, not
   `accounts.json`, not `pricing-litellm.json`. All four are opened read-only.
