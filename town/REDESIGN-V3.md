# Token Town v3 — Implementation Spec (definitive, binding)

v2 made the town a pure function of one number. v3 makes it a **place**: an organic seeded
street plan instead of a bullseye, a countryside that flatters the town instead of dwarfing
it, a monument whose extravagance is the whole point, free colour instead of model
attribution, a municipal news ticker, speech bubbles, and a range that mirrors whatever
window Token Tracker has selected.

**Eight implementers build from this document in parallel, each owning disjoint files.**
This document is the only input. Where it disagrees with a scratchpad design doc, **this
document wins** — the design docs are research, this is the contract. Where it is silent on
*how* you build the inside of your own file, you decide.

`REDESIGN.md` (v1) still governs everything v3 does not change: read its §0.1 module rules
and §7 invariants, both restated and extended in §10 here.

---

## 0. FILE OWNERSHIP — HARD RULE

| owner | files | may edit |
|---|---|---|
| **core** | `src/renderer/town.js`, `src/renderer/index.html`, `README.md` | core only |
| **layout** | `src/renderer/layout.js` *(new)* | layout only |
| **environs** | `src/renderer/environs.js` *(new)* | environs only |
| **news** | `src/renderer/news.js` *(new)* | news only |
| **npcs** | `src/renderer/npcs.js` *(rewrite in place)* | npcs only |
| **monument** | `src/renderer/monument.js` *(rewrite in place)* | monument only |
| **buildings** | `src/renderer/buildings.js` *(edit in place)* | buildings only |
| **feed** | `src/datafeed.js`, `src/main.js`, `src/preload.js` | feed only |

**Nobody writes a file they do not own. Nobody creates any further file under `town/`.**
Scratch harnesses, patches and screenshots go in the scratchpad, never in the repo.
`REDESIGN.md` and `REDESIGN-V3.md` are read-only for everyone.

> **NOBODY touches `<repo>/source/**` (the C# WPF app — read-only
> reference), and nobody rebuilds `TokenTracker.exe`.** The tracker's `settings.json` is read,
> never written.

### 0.1 Files that were proposed and are CUT

* **`palette.js`** — folded into `buildings.js`. Colour policy is construction policy, and a
  ninth file means a ninth owner. `buildings.js` exports the palette API (§4.7).
* **`seed.js`** — folded into `town.js`. Seeds are core's; they arrive on `ctx` (§2).
* **`milestones.js`** — still cut (v1 §0). `LADDER` lives in `town.js`.

There are exactly **eight** source files under `src/` plus `vendor/`.

### 0.2 Module rules (unchanged from v1 §0.1, restated because v3 doubles the module count)

* Every renderer module does `import * as THREE from './vendor/three.module.js';` itself.
  Module caching makes it one shared instance. `layout.js` imports **nothing at all**.
* **No circular imports and no lateral imports.** `layout.js`, `environs.js`, `news.js`,
  `npcs.js`, `monument.js`, `buildings.js` never import each other and never import
  `town.js`. `town.js` imports all six and is the **sole mediator**: all data reaches a
  module through its `cfg` (at init) and `ctx` (per frame), and all events between modules
  are relayed by `town.js`.
  *(One exception, deliberate and one-way: `town.js` passes the `Plan` object produced by
  `layout.js` into `environs.js`, `npcs.js` and `news.js` as plain data. They read it; they
  never import the module.)*
* No new npm dependencies. ES modules, relative paths.
* Every module must be safe at `T = 0`, `N = 0`, no buildings, no plan, and at `N = 1200`.

---

## 1. THE VIBE BIBLE (quoted; it is binding on tone)

> **A pocket-sized medieval boomtown that takes itself completely seriously, administered by
> a municipal government that files paperwork about your token spend.**

The town is earnest. The *framing* is deadpan. Nothing in the world winks at the camera; the
Gazette does the winking.

| adjective | means | fails when |
|---|---|---|
| **Storybook** | hand-placed feel, chunky readable silhouettes, warm materials | it looks procedural / like a heightmap demo |
| **Handmade** | jitter, wobble, nothing perfectly aligned, no two days alike | grids, bullseyes, perfect symmetry (← v2's bug) |
| **Deadpan-municipal** | civic voice, ledgers, plaques, quarterly filings | jokes told by the *world* instead of the *paperwork* |
| **Cozy-monumental** | small houses, absurd centrepiece; scale contrast is the gag | everything big, or everything twee |
| **Seeded, not designed** | today is a *place you found*, not a *layout someone chose* | a recognisable "the algorithm again" fingerprint |
| **Legible over lush** | you can read the town at 300 units in a 1 fps screenshot | fog/bloom/grass that costs you the silhouette |

**Whimsy zone — go as far as you like:** ticker copy · speech bubbles · town names ·
archetype names · landmark silhouettes · the top half of the monument · NPC rituals.

**Legibility zone — whimsy is banned:** the hero number · the range label · both progress
bars · the 3-line tooltip · the monument's counter face · the road network (it must read as
*navigable*) · building silhouettes at framing distance 62–300 · the error banner.

**Quiet zone — the countryside.** It is a matte, not a subject (§6.4).

**One signature gag each.** More than one per specialist and the app stops being a place and
becomes a bit. layout → the **archetype names**. environs → **weather encodes pace**.
news → the **Gazette voice**. range/feed → the **signpost's lower board reads the range**.
monument → **the top of the ladder is absurdly overbuilt**. npcs → **bridge-watchers**.
buildings → **the painted lady**. core → **the founding ritual**.

**Reference points:** Skylines' Chirper (voice) · Cookie Clicker (escalation curve) · Animal
Crossing (palette: saturated but never neon, every hue has grey in it) · Ghibli countryside
(layered, hazy, subordinate) · an old plat map (plates, tooltips, the ledger face).
**Explicitly NOT Wes Anderson** — he is centred and symmetrical, which is precisely the
perfect-circle failure the user asked us to kill. Borrow his *labelling*, none of his
*composition*.

---

## 2. THE SHARED PER-FRAME CONTEXT

`town.js` owns **one** `ctx`, allocated once and mutated in place each frame (never
reallocated). Passed to `monument.update`, `npcs.update`, `environs.update`, `news.update`.
**Read-only inside every module.** Copy this JSDoc verbatim into your module.

```js
/**
 * Per-frame read-only town context. Owned and mutated in place by town.js.
 * Units: world units for distance (a Cottage is ~3 wide, ~3.5 tall), milliseconds for
 * now/simNow/durations, seconds for dt, radians for angles, raw tokens for tokens.
 * @typedef {Object} TownCtx
 *
 * ── clock / sky ────────────────────────────────────────────────────────────────
 * @property {number} day            daylight 0..1 (0 = full night)
 * @property {number} night          1 - day
 * @property {number} simNow         Date.now() sampled at frame start, ms
 * @property {THREE.PerspectiveCamera} camera
 *
 * ── the numbers ────────────────────────────────────────────────────────────────
 * @property {number} totalTok       T — tokens in the selected range (monotonic within an
 *                                   epoch; only an epoch reset may lower it)
 * @property {number} buildingCount  N — houses standing right now (landmarks excluded)
 * @property {number} perMin         tokens/min over the last ~30 min of buckets
 * @property {number} paceRatio      perMin ÷ this epoch's median perMin; 1 = on trend,
 *                                   >1.6 = boom, <0.5 = slow. 1 when unknown.
 *
 * ── the plan (see §3) ──────────────────────────────────────────────────────────
 * @property {Plan} plan             the current epoch's street plan; never null
 * @property {number} frontierK      growth-order key of the outermost BUILT plot (world
 *                                   units). Everything with k <= frontierK is "in town".
 * @property {number} band           plan.bandOf(built-1) — the integer that replaces v2's
 *                                   "ring"; -1 before the first building
 * @property {{cx:number,cz:number,r:number}} bounds  plan.boundsFor(built), mutated in place
 * @property {number} outerR         === bounds.r, kept as a scalar for convenience
 * @property {number} plazaR         LIVE plaza radius, 12..15.5 (§5.6)
 * @property {THREE.Vector3} monumentPos   always (0,0,0)
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings
 *           standing buildings; pos is the plot centre (y=0), yaw is group.rotation.y
 *           (local +z is the façade). Cheap once per errand, NOT per frame per NPC.
 *
 * ── colour (§4.7) ──────────────────────────────────────────────────────────────
 * @property {Palette} palette       today's palette object, allocated once per epoch
 * @property {number} accent         palette.accent — the day's signature hue, 0xRRGGBB
 * @property {string} accentCss      palette.accentCss
 * @property {number} dominantColor  DEPRECATED ALIAS of accent (kept so monument.js and
 * @property {string} dominantCss    npcs.js JSDoc/consumers need no edit). Never model-derived.
 *
 * ── identity / range (§7) ──────────────────────────────────────────────────────
 * @property {number} daySeed        local calendar date as YYYYMMDD (palette, biome, names)
 * @property {number} planSeed       epoch seed (layout, archetype, river) — 32-bit uint
 * @property {string} seedHex        4-char uppercase tag of planSeed, shown to the user
 * @property {string} townName       e.g. 'Millbrook-on-Ledger'
 * @property {string} rangeKey       'session'|'last1'|…|'today'|'last7'|…|'currentMonth'|'all'
 * @property {string} rangeLabel     'Last 24 hours'      — header badge form
 * @property {string} rangeShort     'the last 24 h'      — sentence form ("tokens {short}")
 * @property {number} rangeStartMs   epoch anchor, ms
 * @property {boolean} rangeIsDay    true for 'today'/'session' — gates day-scoped copy
 *
 * ── ritual ─────────────────────────────────────────────────────────────────────
 * @property {number} intro          0..1 founding-ritual progress; 1 = settled (§8)
 */
```

**Deleted from v2's ctx:** `ringCount`, `roadR`. Their consumers key off `band` / `plan`.

---

## 3. `layout.js` — THE STREET PLAN (owner: **layout**)

Replaces v2's `plotPos(i)` bullseye with a seeded street plan: a road graph grown by agents
through an archetype's terrain fields, plots laid along the frontages, ordered by
distance-from-plaza. `layout.js` imports nothing, deals in plain `{x, z}`, and is therefore
runnable and testable under plain Node.

### 3.1 The invariant (structural, not disciplinary)

> `plan.plotAt(i)` is deterministic and **immutable** for a fixed seed as the town grows.

The whole plan is generated **once, up front** (13–49 ms), then sorted once into growth
order. `plotAt(i)` is an array index into a frozen array. There is no incremental state that
could drift. The only later growth is `ensureCapacity()`, which **appends only**, strictly
beyond the current outer radius, and never touches an index already handed out.

### 3.2 Sizing reality

`townSize(T) = min(1200, floor(32·(T/1e6)^(3/8)))` inverts to **427 buildings at 1 B tokens**
— the user's real day. `N_CAP = 1200` needs 15.7 B and is a safety rail, not a target. Tune
for ~430 (measured frontier radius 138–238 by archetype); capacity past ~900 may be lazy.
Base capacity across 8 seeds is 456–1139 plots; `ensureCapacity(1280)` reaches 1068–1489.
`MAX_R = 250`: **nothing may ever be placed beyond it** (environs' flat plate depends on it).

### 3.3 The five archetypes

One generator, five parameter packs. A pack supplies at most: `radiusAt(a)`, `blocked(x,z)`,
`guide(x,z)->{a,k}`, `seeds[]`, `bridgeSites[]`.

| `plan.kind` | `plan.kindLabel` | reads as |
|---|---|---|
| `crossroads` (w 2.6) | `crossroads market town` | two oblique spines meeting at the market square |
| `riverside` (w 3.0) | `riverside market town` | plaza on the bank, 3 constructed bridges, both banks settled |
| `ribbon` (w 2.0) | `valley ribbon village` | a long winding valley strip |
| `lakeside` (w 2.0) | `lakeside town` | the town wraps the shore in a C |
| `hillring` (w 1.4) | `hill terraces` | wobbly loop roads and radiating lanes — never circular |

The archetype ids are a **closed enum shared with environs and news**. Do not rename them,
do not add a sixth without amending this table.

### 3.4 Generator rules that are binding (they are what makes it read as a plan)

1. **Every edge is a straight segment `SEG = 13` long.** Curvature is the chain, not the
   edge. NPC walking, ground painting and plot layout are all linear because of this.
2. **"Foreign" is a 2-hop graph set, not a radius.** Radius exclusion starved the graph at
   47 edges.
3. **A rejected step swerves twice (`heading ± 0.45…0.85`) before the street dies.** Killing
   the street on one unlucky heading gave 160 edges instead of 520.
4. **Junction snapping (`SNAP = 15` to a foreign node → link + end the street)** is what
   turns a tree into a plan: loops, triangles, irregular blocks.
5. `clearAt(r) = 22 → 34` over `r = 0 → 190` — a tight old core, straggly outskirts.
6. **Space-filling infill** (coverage grid, cell 28, sprout lanes into uncovered buildable
   cells) takes a plan from ~350 to ~900 plots. Without it the outskirts are empty wedges.
7. **Bridges are constructed, not stumbled into** — bridgeheads are nodes with the span
   linked *before* growth. The "bridge when an agent hits water" rule produced zero bridges
   in six seeds.
8. **Stitch every island to the mainland, then Dijkstra from the plaza to recompute `d`.**
   An island means stranded NPCs. Measured: 3 components before, 1 after, on all 8 seeds.
9. **Frontages are laid in the street's ARC LENGTH** (`s = node.d + t·len`, pitch 7.4, sides
   staggered), street rows in pass 1, burgage back rows in pass 2. Per-edge slotting killed
   every second plot. Measured min separation 6.40 — existing house geometry needs no rescale.
10. **Growth order `k = r + 0.30·(d − r) + dither(±3)`.** Pure `d` scatters to r=250 by plot
    430; pure `r` is a bullseye again. Sort by `k`; the sorted array **is** `plotAt`.
11. **No reserved landmark indices.** Each landmark declares `(unlockOrdinal, clearance)`,
    is scored on road-end/junction worth minus a squared band penalty in the same key space,
    then its footprint's plots are **deleted and the array renumbered**. `plotIndexOf` dies.
    Unlock ordinals / clearances:
    `well 32/5 · windmill 60/8 · market_hall 78/10 · bell_tower 111/8 · wizard_tower 144/8 ·
    cathedral 187/11 · golden_statue 264/8 · observatory 342/11 · skygate 443/12`.

### 3.5 Public API — copy verbatim

```js
// layout.js — imports NOTHING.
export const LAYOUT = Object.freeze({
  MAX_R: 250, PLAZA_R: 15, SEG: 13, SPACING: 7.4, PLOT_D: 6.4, N_CAP: 1200, FLAT_PAD: 30
});

/**
 * @typedef {Object} Plot
 * @property {number} x @property {number} z   world units, y is always 0
 * @property {number} yaw    radians; local +z is the façade, facing its own street
 * @property {number} d      graph distance from the plaza, world units
 * @property {number} depth  0 spine · 1 street · 2 lane · 3 track
 * @property {number} k      growth-order key, world units; non-decreasing in i
 * @property {number} n      === i
 */

/**
 * @typedef {Object} RoadNode
 * @property {number} i @property {number} x @property {number} z
 * @property {number} d      graph distance from plaza @property {number} depth
 * @property {boolean} hub   plaza ring node (never a landmark site)
 * @property {number[]} adj  edge indices
 */
/**
 * @typedef {Object} RoadEdge
 * @property {number} i @property {number} a @property {number} b  node indices
 * @property {number} w      road width, world units  @property {number} len  === SEG
 * @property {number} depth  @property {number} d   min(a.d, b.d)
 * @property {boolean} bridge
 */

/**
 * The immutable plan for one epoch.
 * @typedef {Object} Plan
 * @property {number} seed       the 32-bit uint it was built from
 * @property {'crossroads'|'riverside'|'ribbon'|'lakeside'|'hillring'} kind
 * @property {string} kindLabel  human phrase, §3.3 — used by the signpost and the Gazette
 * @property {{x:0,z:0}} plazaPos      the plaza is ALWAYS the origin; the town is
 *                                     off-centre around it
 * @property {number} plazaR     15 — the square the monument stands in
 * @property {number} innerR     distance from the origin to the NEAREST plot; >= 17.5
 *                               guaranteed (monument's footprint invariant, §5.6)
 * @property {number} maxR       LAYOUT.MAX_R
 * @property {number} flatR      maxR + FLAT_PAD (280) — environs keeps terrain dead flat
 *                               inside this radius. Nothing in the plan exceeds maxR.
 * @property {number} capacity   plots currently available
 * @property {Array<{a:number,w:number}>} spine  outbound spine headings (rad) + road width;
 *                               environs aligns field grain and lanes to these
 * @property {{x:number,z:number,yaw:number,node:number}} gate
 *                               where the main road leaves town — the signpost site (§8.3)
 * @property {Object<string,{x:number,z:number,yaw:number,clr:number,node:number}>} sites
 *           landmark plots, keyed by LADDER lm id: well, windmill, market_hall, bell_tower,
 *           wizard_tower, cathedral, golden_statue, observatory, skygate. All 9 always present.
 * @property {Array<{x:number,z:number,a:number,span:number,w:number,main:boolean,d:number}>} bridges
 * @property {?{kind:'river'|'lake', path:Array<{x:number,z:number}>, width:number}} water
 *           river = open polyline, lake = closed polygon. null on dry archetypes.
 * @property {{nodes:RoadNode[], edges:RoadEdge[]}} graph
 *
 * @property {(i:number)=>Plot} plotAt          frozen; i < capacity
 * @property {(n:number)=>number} ensureCapacity  APPENDS ONLY; returns the new capacity
 * @property {(i:number)=>number} depthOf       -> plot.k (continuous growth key)
 * @property {(i:number)=>number} bandOf        -> (plot.k / 26)|0 — replaces v2's "ring"
 * @property {(b:number)=>{k:number,r:number}} frontierOf   prefix-scanned, O(1)
 * @property {(b:number)=>{cx:number,cz:number,r:number}} boundsFor
 *           prefix AABB ∪ plaza for the b-th building. MUST return a fresh object or a
 *           per-plan scratch — town.js copies the fields out, never retains the object.
 *
 * ── road graph helpers: O(1)–O(small), allocation-free except pathTo ──
 * @property {(x:number,z:number)=>number} nearestNode
 * @property {(i:number)=>{x:number,z:number}} nodePos
 * @property {(prev:number,cur:number,rnd:number)=>number} randomNextNode
 *           weighted neighbour pick, strongly favours continuing straight; never backtracks
 *           unless `cur` is a dead end
 * @property {(a:number,b:number)=>number[]} pathTo    A* over <=500 nodes, 32-entry LRU
 * @property {(rnd:number,maxK:number)=>{x:number,z:number,edge:number}} randomRoadPoint
 *           length-weighted point on an edge with e.d <= maxK — "somewhere in town"
 * @property {(a:number,b:number)=>?RoadEdge} edgeBetween
 * @property {(edge:number,t:number,lat:number)=>{x:number,z:number}} offsetOn
 *           walk on your own side of the road
 * @property {(x:number,z:number)=>number} distFromPlaza
 * @property {(x:number,z:number)=>boolean} isWet   inside water + 1.2 of bank; false if dry
 *
 * @property {(g:CanvasRenderingContext2D, X:(x:number,z:number)=>number[],
 *             opt:{frontierK:number, px:number, wear:number, plazaR:number})=>void} paintGround
 */

/** Build the plan. 13–49 ms; called once per epoch, never per frame.
 *  @param {number} seed 32-bit uint (ctx.planSeed) @returns {Plan} */
export function buildPlan(seed);
```

`buildPlan` must be **pure**: two builds of the same seed are bit-identical. Assert it in
your own harness.

### 3.6 `paintGround` — the road plate

`town.js` owns the road-decal mesh, its 2048² canvas and its texture lifetime. `layout.js`
owns what is drawn on it. `X(x, z) -> [px, py]` is the world→pixel transform; `px` is pixels
per world unit; `opt.frontierK` means **paint nothing whose `e.d` exceeds `frontierK + 18`**
— the town *paves as it grows*. Save/restore around everything; leak no `ctx` state.

Layer order: 1 water bed + banks · 2 valley/hill shading · 3 verges (`w·1.7`,
`rgba(96,88,68,.45)`) · 4 road surface (`w`, `#6d6450`) · 5 plaza disc at `opt.plazaR` + 3
cobble arcs · 6 bridge approaches (darkened; the road stroke skips the span, the deck is a
mesh) · 7 plot aprons (1.7-unit trodden disc) + footpaths (0.95-unit) to the plot's own
street, for every plot with `k <= frontierK` · 8 wear (26 000 2.4 px specks under
`source-atop`).

### 3.7 What layout does NOT own

* The **water surface mesh** — environs (§6.2). Layout owns only `plan.water` data.
* The **bridge mesh** — `buildings.buildBridge()`; mounted by `town.js` (§4.6).
* The **ground terrain disc** — environs. Layout may assume terrain is flat inside `flatR`.
* Fields, hedgerows, trees beyond the verge — environs.

---

## 4. `buildings.js` — CONSTRUCTION + THE PALETTE (owner: **buildings**)

Model→colour attribution dies completely. `buildings.js` becomes the single owner of all
colour policy, and every builder takes a `Paint` object instead of a family hex.

### 4.1 Deleted from buildings.js

`PLASTER`, `TIMBER`, `roofOf`, `wallOf`, `timberOf`. Kept and still exported: `shade`, `mix`,
`matFor`, `std`, `box`, `pyramid`, `TIER_NAMES`, `MAT`, `GEO`, `FLAVORS`, `pickFlavor`,
`LANDMARK_DEFS`, `buildTree`, `buildScaffold`, `disposeGroup`.

### 4.2 Signature changes

```js
export function buildHouse(tier, paint, seed);      // was (tier, colorHex, seed)
export function buildFlavor(kind, paint, seed);
export function buildLandmark(kind, paint, seed);   // uses paint.civic + gold
export function buildBridge(spec, paint, seed);     // NEW — spec = {span, w, main}
```

The derivation preamble collapses from six lines to
`const { roof, wall, wall2, trim, stone, accent } = paint;`. Every remaining
`shade(colorHex, ±k)` (market crates, tavern sign, scarecrow hat, flags, pennants, the
market-hall banner) becomes `accent` or `shade(accent, ±k)`. `lmRoof(colorHex,k)` →
`lmRoof(paint.civic,k)`. The tent's `mix(0xB9AE93, colorHex, .22)` → `mix(0xB9AE93, roof, .22)`.
`buildScaffold().setTint(hex)` stays and is always called with `GOLD_HI` — gold is the only
colour that means tokens.

`buildBridge` → a group with deck + parapets + 2 piers + (when `main`) a lantern post at each
end, styled with the existing timber/stone kit, `userData.hTop ≈ 2.2`, `userData.label`
`'Stone Bridge'` / `'Timber Bridge'`. Local +x runs along the span, origin at deck centre,
y = 0 at the road surface.

### 4.3 `Paint`

```js
/**
 * @typedef {Object} Paint
 * @property {number} roof   tile colour, shade-varied and QUANTISED (see §4.8)
 * @property {number} wall   plaster
 * @property {number} wall2  plaster, -15 %
 * @property {number} trim   timber
 * @property {number} stone  wall, -34 %
 * @property {number} door
 * @property {number} accent crates / awnings / flags / pennants
 * @property {number} civic  the day's civic accent — landmarks only
 * @property {boolean} rare  painted lady
 */
```

### 4.4 The palette model

**Ten roof families**, each a base hex plus a name (the name is a UI asset — tooltips and the
Gazette both use it): Terracotta `#B4553C` · Ochre `#8E4A38` · Saffron `#C9932F` · Slate
`#4E545E` · Charcoal `#3A3A38` · Moss `#5B6B47` · Seafoam `#4F8A7A` · Azure `#3E6E8E` ·
Plum `#6B4A6B` · Ashblue `#6E7C86`.

**A day's palette** = seeded pick of **3 primaries + 1 accent**, under two harmony rules:
(1) no two primaries within 25° of hue unless one is a neutral (Slate/Charcoal/Ashblue), and
every palette gets at least one neutral — that is what makes a street read as a town rather
than a paint chart; (2) the accent is the highest-chroma family not already picked and must
contrast the dominant primary by ≥ 60° hue or ≥ .25 lightness.

**Roof mix** 46 / 28 / 18 % primaries, 8 % accent, chosen by `seededR(idx*3.13 + daySeed)`.

**Walls**: the existing plaster array, tinted 8 % toward its own roof plus **12 % toward the
day's wash** — a per-day plaster tone from {chalk `#E9E2CE`, sand `#D9C69C`, lime `#DCE2CE`,
rose `#E4CFC4`, quarry `#C9C6BC`}. The wash is the strongest "different town today" signal
there is and costs one lerp.

**Band drift**: the mix tilts by `band` so the town reads as older-in-the-middle — bands 0–2
favour the neutral primary and painted trim (civic core), bands ≥ 5 favour Moss/Ochre and
timber trim (thatch outskirts). `w[i] * (1 + TILT[i] * u)`, `u = clamp(band/maxBand, 0, 1)`.

**Rare houses (~1.5 %, weighted to the core)** — the *painted lady*: a saturated **wall**
(the one place saturation is allowed on a wall), a contrasting trim, a bright door.
`rareOf(idx)` returns the tag so the tooltip can say `✦ Painted Lady`.

**Landmarks** keep limestone + slate + gold but take `paint.civic` (the deepest primary)
instead of a family colour. **The monument stays gold at every tier, always.**

Director's guardrails, binding: every roof hue carries ≥ 12 % grey; the darkest roof must
separate from `palette.ground` by ≥ 0.18 luminance.

### 4.5 Palette API — copy verbatim

```js
/**
 * @typedef {Object} Palette
 * @property {number[]} roofs     the 4 chosen family hexes, [p0, p1, p2, accentFamily]
 * @property {string[]} roofNames the 4 family names
 * @property {number[]} walls     the 3 plaster bases after the wash
 * @property {number} trim @property {number} civic
 * @property {number} accent      the day's signature hue
 * @property {string} accentCss
 * @property {number} ground      grass base tint (environs multiplies its canvas by this)
 * @property {number} water       river / lake tint
 * @property {string} wash        'chalk'|'sand'|'lime'|'rose'|'quarry'
 * @property {string[]} dots      3 css swatches for the header "weather vane"
 */

/** Seeded per day. Idempotent, rebuild-safe, pure integer maths.
 *  @param {number} daySeed YYYYMMDD @returns {Palette} */
export function initPalette(daySeed);
/** The live palette (after initPalette). @returns {Palette} */
export function palette();
/** @param {number} idx plot index @param {number} band @returns {Paint} */
export function paintHouse(idx, band);
/** @param {string} kind @param {number} idx @param {number} band @returns {Paint} */
export function paintFlavor(kind, idx, band);
/** @param {string} kind @returns {Paint} */
export function paintLandmark(kind);
/** @param {boolean} main @returns {Paint} */
export function paintBridge(main);
/** @returns {number} 0xRRGGBB — hero number, floaters, fireworks, beacon */
export function dayAccent();
/** @param {number} idx @returns {string} 'Terracotta' — tooltips + Gazette */
export function roofNameOf(idx);
/** @param {number} idx @returns {?('painted-lady'|'thatch'|'blue-door')} */
export function rareOf(idx);
```

`townName` is **NOT** here — `news.js` owns naming (§7.2).

### 4.6 Who mounts a bridge

`layout` produces `plan.bridges[]`. `buildings` produces the mesh. **`town.js` mounts it**,
like a landmark, when `bridge.d <= ctx.frontierK`, with the same scaffold-and-rise ceremony;
it is hover-testable (`kind:'bridge'`). Nobody else adds a bridge to the scene.

### 4.7 Perf

Shade variation stays **quantised to 7 steps** — `matFor`'s 8-step channel quantisation is
what keeps the material cache at ~60–100 materials. *Do not let hue vary continuously per
house; that detonates the cache.* Everything colour-related is decided at spawn, so a 1 fps
headless shot is unaffected. Zero new draw calls, zero per-frame cost.

---

## 5. `monument.js` — THE TOKEN ALTAR (owner: **monument**)

### 5.1 The diagnosis and the hard constraint

Today's ten tiers move ~4 units of height across a 1000× token range; `growFor(outerR)` does
more visual work than the whole ladder. Fix the **amounts**, keep the machinery (one
`setTier` swap, idempotent/jumpable rows, zero allocation after init, wall-clock scheduling,
emissive-first lighting).

> **Invariant:** `footprintR(tier) × growS + 4.4 ≤ plan.innerR − 0.6`, and `plan.innerR ≥
> 17.5` is guaranteed by layout, so `footprintR × growS ≤ 12.5`.

Escalation is therefore **vertical and aerial**, never wide. `growS` retunes to `1.0…1.18`
(was 1.55) so tier and town size stop compounding:
`growFor = outerR => clamp(1 + (outerR - 39)/63 * .18, 1, 1.18)`.

### 5.2 Eleven silhouettes

`LADDER`'s `mon:` column in `town.js` stays the single owner of tier↔tokens and is extended
to 0..10 (§9.1). `clamp(n, 0, 10)`.

| T | name | crown h | footR | plazaWant | what arrives |
|---|---|---|---|---|---|
| 0 | **Survey Stone** | 3.2 | 2.6 | 12 | a cairn, two stakes, a plank ledger board — "ground has been broken" |
| 1 | **Waystone** | 8 | 4.2 | 12 | one drum, short stele, coin r1.6, 2 braziers. First fire. |
| 2 | **Shrine** | 13 | 5.2 | 12 | 2nd drum, 4 braziers, coin 2.2, halo ×1 |
| 3 | **Gilded Altar** | 17 | 5.8 | 13 | moat fills, gold banding, coin 2.6 |
| 4 | **Coin Fountain** | 22 | 6.6 | 13.5 | terraced basin, 4 spouts pouring coin motes into the moat; halo ×2; **aura begins** |
| 5 | **Colonnade Sanctum** | 29 | 7.6 | 14 | 12 fluted pillars + architrave lift the coin into an open temple; beacon .25; **first point light (60 cd)** |
| 6 | **Ziggurat of Ledgers** | 37 | 8.6 | 14.5 | 5 stepped terraces + stairs; 4 obelisks; braziers → 8; light 160 |
| 7 | **Orbital Reliquary** | 46 | 9.4 | 15 | the coin **lifts free** and floats; 3 counter-rotating rings; 8 orbiting coins; light 380 |
| 8 | **Solar Vault** | 54 | 10.0 | 15.5 | base gold-plated; a second larger disc above the first; lit spires; light 700 |
| 9 | **Radiant Colossus** | 62 | 10.6 | 15.5 | a gilded spire pierces both coins into the sky; 2 light-towers; sky glyph full; light 1200 |
| 10 | **The Skyward Mint** | 78 (sky ring 92) | 11.0 | 15.5 | slow sky ring, permanent **coin-rain**, beacon 1.0, light 1800 — the town's night sun |

Every row visibly dwarfs the previous one (×1.35–1.6 at the low end, +8–16 units at the high
end). Tier tables (11 rows each, index === tier) as designed:
`T_H, T_FOOT, T_PLAZA, T_DRUMS, T_SPIRE, T_COIN_Y, T_COIN_R, T_HALOS, T_PILLAR, T_OBEL,
T_BRAZ, T_BEACON, T_LIGHT, T_AURA, T_TAB_Y, T_TAB_S` — values in
`scratchpad/v3-design-monument-color.md` §1.2, which is normative for the numbers.
Material thresholds inside `applyTier`: `frameGold ≥3`, `steleGold ≥5`, `pillarGold ≥7`,
`baseGold ≥8`, `allRadiant ≥9`.

### 5.3 Construction

Everything built once at init, toggled per tier. Repeated furniture becomes `InstancedMesh`
with unused instances parked at `y = -999` (the `revealScatter` idiom): terraces(5),
colonnade(16), obelisks(8), braziers(8), flames(16), orbit(8), halos(5, matrices rewritten
per frame). **Draw-call budget at T10: 21**, of which 3 are ceremony-only and 5 are hidden
below T5.

### 5.4 Light — the one sanctioned exception

The monument may own **exactly one** `PointLight`: created at init, `castShadow = false`
(six shadow faces would halve fps), intensity 0 until T5, gated by night:

```js
sun2.intensity = T_LIGHT[tier] * clamp(night * 1.3 - .12, 0, 1) * (1 + .06 * Math.sin(now/1300));
```

`decay: 2`, candela — at T10, `1800/60² = 0.5 lux` at mid-town: a warm gold wash on roofs at
midnight, nothing in daylight. The beacon keeps its night gate (a gold shaft in daylight
reads as a rendering artefact).

**The beacon column, the milestone shockwave and the sky glyph take `ctx.accent`** (director
delight #10) so the night skyline is a different colour every day. The coin, the ledger frame
and the plating stay gold.

### 5.5 Aura, ledger, ceremony

* Pool 140 → 240, second mode. **Wall-clock spawn cadence** (`now - lastAura > 1000/rate`,
  `rate = T_AURA[n]/2.2`), zero gravity, life 2.2 s, so a 1 fps shot always shows a full
  column. Fountain mode (4 spouts, T≥4), coin-rain from above (T10).
* Ledger: `y = T_TAB_Y[n]`, never above `0.62 × crown` (auto-framing must contain it); the
  constant-apparent-size trick (`screenK / growS`) is unchanged; the frame material escalates
  but **the canvas layout never changes** — the number must not become a design element.
  T≥7 adds a thin additive backing halo so a black plate isn't a hole in a wall of gold.
  The engraved header reads **`TOKENS ${ctx.rangeShort.toUpperCase()}`**, not `TOKENS TODAY`
  (§7.4) — set through `setRangeLabel(short)`.
* Ceremony 3.2 s, four phases on the fed clock (`clockNow()`, never `performance.now()`
  directly — `__tick` stepping must stay coherent): **charge** 0–600 (aura reverses inward,
  gold wireframe of the incoming silhouette snaps up, `npcs.celebrate` fires at t=0 via
  town.js) → **flash** 600–800 (emissive spike, bloom sphere, parts pop) → **wave** 800–2000
  (ground shockwave + a ring climbing the new spire + 120 motes + title plate) → **settle**
  2000–3200.

### 5.6 The plaza grows — who owns what

`PLAZA_R` stops being a constant, and **`town.js` owns the final number**:

```js
// town.js, once per frame (cheap; the setter early-outs)
const want = clamp(monument.plazaWant, 12, 15.5);
setPlazaR(Math.min(want, plan.innerR - 2.5));   // repaints the road plate on |Δ| > .4
```

monument exports `get plazaWant()` (= `T_PLAZA[tier]`) and reads the authoritative value back
from `ctx.plazaR`. `npcs` takes `cfg.plazaR` as a **function**. The plaza may never eat the
inner plots.

### 5.7 Public surface (additive — no existing signature changes)

```js
export function initMonument(scene, opts);
/** @typedef {{plazaR:number, maxAnisotropy:number, accent:number, rangeShort:string}} MonOpts */
/**
 * @typedef {Object} Monument
 * @property {THREE.Group} group  @property {number} radius
 * @property {number} tier                                   getter
 * @property {(dt:number,now:number,ctx:TownCtx)=>void} update
 * @property {(T:number)=>void} setTotal
 * @property {(n:number,opts?:{animate:boolean})=>void} setTier
 * @property {(tok:number,p:number,txt:string)=>void} setNext
 * @property {(title:string,colorHex:number)=>void} celebrate
 * @property {()=>void} pulse
 * @property {()=>{center:THREE.Vector3,r0:number,r1:number,focus?:THREE.Vector3}} getAttractor
 * @property {()=>THREE.Vector3} getCoinPos
 * @property {()=>void} reset  @property {()=>void} dispose
 * ── NEW in v3 ──
 * @property {?{phase:'charge'|'flash'|'wave'|'settle', k:number}} ceremony   getter
 * @property {number} nightSun     getter, 0..1 — how much gold the altar throws tonight
 * @property {string} tierName     getter, 'Orbital Reliquary'
 * @property {number} crownHeight  getter, T_H[tier] * growS — camera framing (§9.4)
 * @property {number} plazaWant    getter, T_PLAZA[tier]
 * @property {(short:string)=>void} setRangeLabel   engraves 'TOKENS THIS SESSION'
 */
```

`getAttractor()` already returns live `{center, r0, r1}` and `r0 = footprintR × growS`, so
the worship circle hugs the growing base with no npcs change.

---

## 6. `environs.js` — THE COUNTRYSIDE (owner: **environs**)

**The thesis.** "Empty" is not solved by more grass or a bigger fog number. It is solved by
(1) a **fade** that tracks the town's size so the eye is pulled inward and the horizon never
reads as an edge, and (2) **content, not terrain** — the ring just past the last house must
be *farmed*.

### 6.1 The fade — four cooperating layers (any one alone fails)

1. **Ground albedo + detail falloff, baked per-vertex, keyed to RADIUS not camera.** The
   terrain is literally painted the live fog colour by the rim, no matter where the camera
   is. The same pass carries 2 octaves of macro value noise (λ ≈ 90 and 340) which kills
   grass tiling with distance — detail *removed* with distance is what "fades out" means.
2. **Scene fog halved.** One exported authority:
   `fogFor(dist, biome) = clamp(0.0016 * (62/dist)^0.30 * biome.fogMul, 0.0009, 0.0032)`.
   Layer 1 buries the horizon, so fog only owes aerial perspective on buildings and the town
   stays crisp at a nine-band framing.
3. **Content falloff.** The last flora band scales 0.55 → 0.15 and tints 70 % to fog; copses
   dissolve rather than stop.
4. **The veil.** A back-faced cylinder at r 940, *inside* the r1200 disc rim, alpha ramp
   bottom→top, `material.color.copy(scene.fog.color)` **every frame**. Zero-contrast
   ground/sky seam at every hour including golden hour; the rim is mathematically unseeable.
   Depth checked: the sun ball (opaque, r 720, y ≥ 213) writes depth first and is never
   veiled; the sky dome (r 820) is behind it, which is correct.

Plus a **vignette** as a CSS `#stage::after` radial-gradient driven by a `--vig` var written
at ≤ 4 Hz (0.16 by day → 0.34 at night). Zero draw calls.

### 6.2 The eight draw calls (7 dry, 8 with water)

`ground` (radial grid disc, 72×108, `r_i = 1200·(i/72)^2.4`, baked `aTint/aHill/aHillN/aCarve`)
· `fields` (16-cell canvas atlas of ground decals with torn alpha edges, grid **rotated to
the nearest spine** so farmland reads as surveyed) · `blades` (3-quad crop cards, gusting
sway) · `flora` (**one** merged trunk+2cones+skirt geometry, scaled into tree / orchard /
hedgerow / drystone wall / reed / willow / sheep) · `sky` (clouds **and** birds in one
instanced mesh, orbit + billboard in the vertex shader) · `motes` (pollen by day, blinking
fireflies by night, one additive pool) · `veil` · `water`.

**`ground` flatness is contractual:** `aHill` must be exactly 0 for `r < plan.flatR` (280),
undulation `flatR → flatR*1.6`, distant hills `420 → 900` (4–6 seeded Gaussian domes, h
12–50, σ 90–260, + fbm ±6). A 430-building ribbon town reaches r 238 — a 150-unit flat plate
would put houses on a hillside.

**`water` is environs'**, both river ribbon and lake: Catmull-Rom resampled every 6 units
from `plan.water.path`, `MeshStandardMaterial` + `onBeforeCompile` (crossed sine ripples on
`uTime`, a specular glint lobe at `uSunDir`, a baked `aShore` shallows term). It must catch
the sun ball, or a river reads as a blue road. Night: opacity .8, a narrow moon streak.

### 6.3 Scaling — every band keyed to `E = ctx.bounds.r`

verge `E..1.25E` (hedgerows, gates, haystacks, lanes petering out) · farmland `1.25E..2.2E`
(blades only inside 1.6E) · orchards & copses `2.2E..4E` · wildland `4E..4.5E+220` · distant
hills `380..900` (independent of E). A 20-house village gets its first hedgerow at 35 units;
a 430-house town gets the same composition at 4×. **The countryside is never bigger than the
town deserves, so it can never dwarf it.**

### 6.4 The subordination rule — quantified and binding

* Nothing beyond `E + 30` may exceed **0.55 relative luminance** or **0.35 saturation**.
* The fade band starts at `E × 1.15` and is complete by `E × 2.4`, **driven by E** so it
  grows with the town.
* **≥ 60 % of azimuths must have a silhouette element** (hill ridge, treeline mass, haze
  bank) above the flat ground line. The single flat arc in the v2 shot is the app's largest
  visual defect.
* Three depth planes, never one: near verge · mid country · far ridge (silhouette + haze
  only, no detail, no shadows).
* **Fast motion is banned out there.** Cloud laps are 6–14 minutes, bird laps 40–90 s, blade
  sway is sub-unit. Nothing in the periphery may catch the eye — motion inside the town means
  "your number went up".
* `castShadow = false` on every environs object; `receiveShadow = true` on the ground only.
* **environs creates zero lights.** Night is a uniform, not a lamp.
* Cost ceiling: ≤ 8 draw calls, ≤ 5 materials, ≤ 4 textures for the entire countryside.

### 6.5 Biomes and archetype dressing

`lush .30 · goldrush .25 · misty .15 · heather .15 · spring .15`, picked from `daySeed`;
nothing lerps more than 0.22 from the base art direction. `biome.wind` is an independent
seeded roll (0.6–1.4). `misty` alone sets `fogMul = 1.35`.

Archetype profiles key off **`plan.kind`** (the §3.3 enum, not a private one):
`crossroads` double roadside tree rows + block fields · `riverside` water meadows, willows,
reed beds, fields parallel to the river, a mill leat · `ribbon` valley terraces along the
corridor axis · `lakeside` reed beds, orchards on the dry side, the shore term widened so
the lake merges into the veil · `hillring` terraces, drystone walls, sheep, more stubble.
Unknown/absent plan → a seeded `ring` fallback (demo mode must work with no plan).

**Weather encodes pace (the environs signature gag).** Read `ctx.paceRatio`: `>1.6` → a
golden haze (`biome.fogTint` warmed, cloud opacity down 25 %); `<0.5` for 20 min → overcast
(cloud count +40 %, `uWind` ×0.6). Transitions on the wall clock over 8 s so a `--shot` run
lands in a settled state, never 20 % through a crossfade.

### 6.6 Night

One `uNight` uniform into five materials. Ground/fields desaturate into indigo **before** the
buildings do; wind drops 60 %; clouds 0.85 → 0.18 moonlit; birds → bats; pollen → fireflies
(each blinking on `(0.5+0.5·sin(uTime·0.0011 + seed·17))^4`, so the field twinkles instead of
glowing); water gets a narrow moon streak; the veil follows the sky for free; `--vig` 0.34.

### 6.7 `dt` IS IGNORED

`update(dt, now, ctx)` takes `dt` for signature symmetry and **never reads it**. All motion is
vertex-shader parametric from one `uTime` fed by `performance.now()`. A 1 fps headless shot
therefore shows clouds, birds and fireflies at *correct* positions, not bunched at spawn.
Per-frame CPU: 6 uniform writes + a CSS var at ≤ 4 Hz. No matrix composes, no allocations.

### 6.8 Public API — copy verbatim

```js
/** @typedef {Object} Biome
 *  @property {string} id 'lush'|'goldrush'|'misty'|'heather'|'spring'
 *  @property {string} label 'verdant'|'late summer'|'morning mist'|'heath'|'new green'
 *  @property {number} grass @property {number[]} fields @property {number} tree
 *  @property {number} fogTint @property {number} fogMul @property {number} clouds
 *  @property {number} wind @property {number} mote */
export const BIOMES;                        // frozen Record<string, Biome>
/** @param {number} daySeed @returns {Biome} */
export function biomeFor(daySeed);
/** THE fog authority. town.js's refreshFraming calls this instead of its own literal.
 *  @param {number} dist camera distance @param {Biome} biome @returns {number} density */
export function fogFor(dist, biome);

/**
 * @param {THREE.Scene} scene
 * @param {?Plan} plan   §3.5. EVERY field optional: a null/partial plan is synthesised
 *                       from the seed as a `ring` archetype. NEVER throw on a bad plan.
 * @param {{maxAnisotropy:number, daySeed:number, palette:Palette, quality?:'high'|'low'}} opts
 *        quality 'low' halves blades/motes; headless shots MUST run 'high'.
 * @returns {Environs}
 */
export function initEnvirons(scene, plan, opts);

/**
 * @typedef {Object} Environs
 * @property {THREE.Group} group   added to the scene by initEnvirons
 * @property {Biome} biome         resolved, read-only — town.js passes it to fogFor
 * @property {string} archetype    resolved plan.kind (or 'ring')
 * @property {({inner:number,outer:number})=>void} setExtent
 *   The town grew. Idempotent, safe every frame: early-outs unless |Δouter| > 2. On a real
 *   change it re-parks instances by band and writes uFade/uFlat. No rebuild, no alloc, ~.15 ms.
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update   dt IS IGNORED (§6.7)
 * @property {(x:number,z:number)=>number} sampleHeight  matches the vertex shader exactly;
 *   0 anywhere the town can build
 * @property {(x:number,z:number)=>boolean} isWater      river/lake + 1.2 of bank
 * @property {()=>Array<{w:number,text:string}>} news    weighted countryside lines that match
 *   what is ACTUALLY on screen; town.js hands this to news.js as `opts.country` (§7.3)
 * @property {(daySeed:number, plan:?Plan, palette:Palette)=>void} setSeed
 *   epoch reset: re-picks biome + archetype, rewrites attributes in place (~4 ms)
 * @property {()=>void} dispose
 */
```

`getCrossings()` is **CUT** — layout owns bridge siting from its own river polyline.

---

## 7. `news.js` — THE CRIER, BUBBLES, THE NAME (owner: **news**)

`news.js` imports only `./vendor/three.module.js`. It never imports another module. `town.js`
`post()`s typed events and is the only thing that calls `news.say()`.

### 7.1 Placement — a real row, not an overlay (resolved against the director doc)

`#news` is a **flex row between `<header>` and `.stage`**, Cookie-Clicker style:
`📰 THE TOKENHOLM CRIER │ <headline>`. It cannot cover the 3D at any framing, cannot
intercept a raycast/drag/wheel, and `refreshFraming()` reads `stage.clientHeight` so framing
self-corrects with zero code change. The header centre is **not** available: at 1380 px it
already carries seal + name + archetype chip + palette dots + range chip + sun/clock, and a
`flex:1` ticker there truncates the copy the ticker exists for.

Hovering `#news` reveals the **last five headlines** in a `#tip`-styled stack — that is where
a milestone missed twenty minutes ago is recovered (§11.3).

> **Base CSS is the FINAL state; animations only travel toward it.** `#news .line{opacity:1}`
> with a `@keyframes` that *starts* at `opacity:0`. A throttled headless compositor must never
> capture a blank bar. Same rule for `.bub`. **This is the single most important
> implementation note in this file.**

Swap = set `textContent`, remove `.swap`, force reflow (`void el.offsetWidth`), add `.swap`
— 420 ms fade + 6 px slide. **Fade-swap, never scrolling**: a marquee screenshots mid-slide.
`.hot` glows the masthead gold for 4 s on urgent items; nothing moves, nothing shouts.
Milestone lines hold 12 s.

### 7.2 The town name

```js
/**
 * Deterministic, stable for a whole epoch.
 * @param {number} seed  ctx.planSeed
 * @returns {string} 'Tokenholm' | 'Little Cachewick' | 'Ledgerford upon Spend'
 */
export function townNameFor(seed);
```

62 % `Tokenholm` · 18 % `Little Cachewick` · 14 % `Ledgerford upon Spend` · 6 %
`Mint-on-Tally`, from the HEAD/TAIL/HON/UPON word lists in the news design doc. Copy a
3-line `seededR` helper; do not import one.

The name appears: the header `<h1>` (core) · the crier masthead (news, `📰 THE X CRIER`,
truncated to `📰 THE CRIER` below 620 px) · the corpus `{town}` slot (~1 line in 5) · the
cascade floater `✦ Tokenholm — township of 426` (core) · the monument tooltip line 1 (core) ·
the signpost (core) · `document.title` (core).

### 7.3 API — copy verbatim

```js
/**
 * @typedef {Object} NewsOpts
 * @property {HTMLElement} bar     #news   @property {HTMLElement} mast  #newsMast
 * @property {HTMLElement} line    #newsLine
 * @property {HTMLElement} overlay #overlay — the 4 pooled bubble divs are appended here
 * @property {HTMLCanvasElement} canvas   projection rect source
 * @property {number} seed         ctx.planSeed → town name + line shuffle
 * @property {string} archetype    plan.kind — gates archetype-specific copy
 * @property {boolean} [demo]
 * @property {()=>Array<{w:number,text:string}>} [country]   environs.news, mixed into ambient
 */
/** @param {NewsOpts} opts @returns {News} */
export function initNews(opts);

/**
 * @typedef {Object} News
 * @property {string} townName        read-only, regenerated by reset()
 * @property {NewsFacts} facts        MUTABLE — mutate in place, NEVER reassign
 * @property {(type:string, data?:object)=>void} post   never throws on an unknown type
 * @property {(v:THREE.Vector3, kind:string, opts?:{text?:string, ttl?:number})=>boolean} say
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 * @property {(seed:number, archetype:string)=>void} reset   epoch: new name, flush all
 * @property {()=>void} dispose
 */
/**
 * @typedef {Object} NewsFacts   allocated once, mutated in town.js's 500 ms stats timer
 * @property {number} tok @property {string} tokStr @property {number} buildings
 * @property {number} villagers @property {number} breaks @property {string} grandest
 * @property {string} landmark @property {string} rangeLabel @property {number} perMin
 * @property {number} paceRatio @property {number} tier @property {number} night
 * @property {boolean} cascading @property {number} milestones @property {string} tierName
 */
export const NEWS_CORPUS;   // frozen, for tests
```

### 7.4 Events

**urgent** (clears the queue, displays immediately, `.hot` 4 s, two urgents ≥ 900 ms apart to
stay in step with the milestone queue): `boot` · `dayStart` · `rangeChanged` · `milestone` ·
`landmark` · `best`.
**normal** (queue capped at 4, overflow drops the *oldest* — stale news is worse than missed
news): `tierUp` · `buildingsAdded` · `promotion` · `grove` · `pace` · `idle` · `nightfall` ·
`daybreak` · `bridge`.
**ambient** — never posted. When the queue is empty and the dwell expires, the crier picks a
category itself, weighted by `facts`: night > .55 → 30 % NIGHT; idle > 10 min → 40 % SLOW;
paceRatio > 1.6 → 35 % BOOM; < .5 → 25 % BUST; tier ≥ 6 → 20 % CULT; else ECON/CIVIC/CULT
evenly, with `opts.country()` lines mixed in at weight 1.

**Cascade guard:** while `facts.cascading`, `buildingsAdded`/`tierUp`/`promotion`/`landmark`
are swallowed; the single `boot` post tells the whole story.

Dwell `clamp(2600 + 62·len, 6200, 9000)`. The **first line is written synchronously in
`initNews`** so frame 1 already has copy. 26-slot anti-repeat ring + per-category shuffled
cursor. Slots: `{town} {tok} {b} {n} {villagers} {breaks} {grandest} {landmark} {range}
{pace} {tier} {name} {pct}`. `**bold**` → `<b>`, `_italic_` → `<i>`; `innerHTML` is built
**only** from the frozen corpus plus numbers — no user data ever reaches it.

**The corpus must be true.** The difference between furniture and a living ticker is entirely
whether *"Fourteen houses raised on Mill Row this hour"* actually happened. 193 lines across
ECON/BOOM/BUST/SLOW/BUILD/MILESTONE/LANDMARK/CULT/NIGHT/DAWN/RANGE/CIVIC/BEST/DAYSTART/BOOT/
GROVE/PROMO, plus per-archetype pools gated on `opts.archetype` (riverside → bridge/ferry/
flood/mill; hillring → terrace/quarry/switchback; crossroads → toll/traffic/inn). **No model
name may appear anywhere** — grep for `fable|opus|sonnet|haiku|claude|gpt` before shipping.

### 7.5 Bubbles

**Pooled HTML divs projected onto `#overlay`** — decided, not open. 5–9 word lines are 8–14 px
tall at real camera distance, so DPR-crisp DOM text is the only readable option; it reuses the
floater projection path already proven at 1 fps; zero texture churn. Sprites are rejected.

4 pooled divs, max 2 per kind, `ttl = clamp(2600 + 46·len, 3200, 5200)`, the **anchor is a
snapshot** (the villager walks on, the remark hangs in the air), skipped if behind the camera
(`_v.z > 1`) or beyond 170 world units. Fade-out is opacity-only in the last 500 ms, computed
from `now`. Kinds: `stroll` · `worship` · `cheer` · `night` · `build` · `bridge`.

`npcs.js` gains **exactly one** method for this (§8.2), and `town.js` pulls a speaker on a
**2200 ms** wall-clock cadence with the **first pull at 900 ms** so a short shot has one.
Cheers and builds are pushed on the beat from `fireMilestone` / `drainSpawnQueue`.

---

## 8. `npcs.js` — VILLAGERS (owner: **npcs**)

### 8.1 The road graph replaces ring+spoke

The leg system collapses. **Delete:** `roadR`, `spokes`, `rings`, `RSTEP`, `ringMax`,
`spokeA`, `ringOfR`, `nearestSpoke`, `onRing`, `onSpoke`, `polarR`'s ring use, and the
`ring`/`spoke` branches of `beginLeg`/`advance`. Every leg becomes a straight segment:

```js
routeTo(n, x, z) =
  [{t:'walk', to: plan.nodePos(plan.nearestNode(n.x, n.z))}]
  ++ plan.pathTo(nearestNode(n), nearestNode(x,z)).map(e => ({t:'edge', a, b}))
  ++ [{t:'walk', x, z}]                                  // doorstep
```

`advance()` loses two of its three branches; `n.lat` becomes a constant offset along the edge
normal (`plan.offsetOn(edge, t, lat)`). Villagers walk curved streets because the *streets*
are chains of straight edges. Villagers stay inside the built town by rejecting road points
with `e.d > cfg.frontierK()`.

### 8.2 New cfg + the two v3 additions

```js
/**
 * @typedef {Object} NPCConfig
 * @property {Plan} plan                     §3.5 — replaces roadR + spokes + rings
 * @property {()=>number} frontierK          paved growth key; villagers stay inside it
 * @property {()=>number} plazaR             LIVE plaza radius (a function, not a number)
 * @property {THREE.Vector3} monument @property {number} monumentR
 * @property {()=>{center,r0,r1}} attractor
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings
 * @property {number} cap @property {number} seed   daySeed — wardrobe distribution
 */
export function initNPCs(scene, cfg);

/**
 * Sample a villager to speak. Wall-clock safe, allocation-free. ~12 lines: reservoir-sample
 * one match in a single pass, prefer a villager not sampled in the last 3 s (`n.spokeAt`),
 * write out.set(n.x, HEAD_Y * n.scale + .32, n.z).
 * @param {?string} want 'stroll'|'worship'|'cheer'|'home'|'bridge'|null (any)
 * @param {THREE.Vector3} out  filled IN PLACE with the head-top world position
 * @returns {?string} the villager's actual state, or null if nobody matched
 */
pickSpeaker(want, out)
```

**Bridge-watchers (the npcs signature gag).** An NPC crossing an edge with `bridge === true`
has a 25 % chance to stop mid-span for 2–4 s, turn to face downstream, and enter state
`'bridge'` (which `pickSpeaker('bridge')` can then find). Reuses the existing pause/role
scheduling. This is the screenshot the user will send to someone.

Everything else in `npcs.js` — the instanced pool, the worship circle, celebrations, the
night exodus with lanterns, `NPC_CAP`, `popForBuildings`, `setPopulation`, `setBuildingCount`,
`update`, `pulse`, `celebrate`, `count`, `worshippers`, `dispose` — survives unchanged in
behaviour and signature.

---

## 9. `town.js` + `index.html` — THE CONDUCTOR (owner: **core**)

### 9.1 Deleted outright

**Geometry:** `R0`, `RGAP`, `SPACING`, `PLAZA_R` (const), `SPOKE_N`, `SPOKE_A0`, `ringCap`,
`roadR`, `plotSlot`, `plotPos`, `plotFacing`, `LM_PLOTS`, `RESERVED`, `_free`,
`plotIndexOf`, `landmarkPos`, `ringW`, `curMaxRing`, the ring loops inside
`makeRoadTexture` (the whole function — `plan.paintGround` replaces it), `revealScatter`'s
ring math, the road-lamp ring placement loop, `newGrove`/`addTree`'s ring math.

**Countryside:** `grassMat`, `grassGeo`, `grass`, `makeGrassTexture`, and the 42-clump
countryside tree block (`trunks/leafA/leafB` + its three `scatter` calls). **Keep** the
bush/rock verge scatter — that is town dressing, not countryside — but re-key it onto
`bandOf` and place it *along edges* (offset 9–14 from the centreline) rather than on circles.

**Family attribution — every remnant (§12 has the full audit):** `FAMILY_TOKENS`,
`FAMILY_SEEDS`, `colorsCfg`, `families`, `famKeyOf`, `famOf`, `rebuildLegend`,
`familyForBuilding`, `spent`, `F`, `dom`, `updateDominant`, `famShare`, `e.famKey`.

**Rollover:** `dayKey` and the synthesised midnight rollover in `applyBuckets` — the feed
owns rollover now, and both firing would double-reset.

### 9.2 Rewritten against the plan

| v2 | v3 |
|---|---|
| `plotPos(idx)` | `plan.plotAt(i)` → `{x, z, yaw}` — yaw is *given*; a house faces its own street, not the plaza |
| `plotSlot(idx).r` | `plan.bandOf(i)` (integer) / `plan.depthOf(i)` (continuous) |
| `tierOfPlot`'s `u = (slot.r+.35)/(maxRing+.9)` | `u = plan.depthOf(i) / (plan.frontierOf(built).k + 20)` — same anti-stall engine, continuous |
| `updateRoads(rings)` | `updateRoads(band)` via `plan.paintGround`; regenerate only when `band` **or** `plazaR` changes |
| `refreshFraming()`'s `outer` | `plan.boundsFor(built)` (§9.4) |
| `LM_PLOTS[kind]` → `landmarkPos()` | `plan.sites[kind]` → `{x, z, yaw}` |
| road lamps on ring circles | lamps at a seeded subset of graph nodes with `degree ≥ 3`, revealed by band |
| groves anchored to `(ring, angle)` | groves anchored to a plot's own `{x,z}` pushed 5 units off its street |
| `ctx.ringCount` / `ctx.outerR` / `ctx.roadR` | `ctx.band` / `ctx.bounds` / `ctx.plan` |
| `LADDER` `mon:` column `1,2,3,4,5,6,7,8,8,9` | `1,2,3,4,5,6,7,8,9,10` (§5.2) |
| `spliceBestRung(tok)` | `spliceBestRung(tok, label)` — `msg.prev` (§10.3) |
| burst colour `famOf(e.famKey).color` | `e.paint.roof` — a burst the colour of the house that just arrived |
| `dom.css` in floaters / `ctx.dominantColor` in fireworks | `ctx.accentCss` / `ctx.accent` |

### 9.3 New in town.js

* `import { buildPlan, LAYOUT } from './layout.js'` and `let plan = buildPlan(planSeed)`,
  rebuilt inside `applyInit` on every epoch change. `plan.ensureCapacity(want + 60)` in
  `syncTown` when `want > plan.capacity - 60`.
* Bridge mounting (§4.6) and the **signpost** (§9.6).
* `env = initEnvirons(scene, plan, {...})`, `news = initNews({...})`.
* `setPlazaR()` (§5.6), `setDaySeed()`, `initPalette(daySeed)`.
* The founding ritual (§11) and `?intro=0` / `?seed=N` URL knobs.
* Bookkeeping goes model-blind. **`cell` STAYS keyed by model** — the DB emits one upsertable
  row per (bucket, model) and the delta logic depends on it — only the fold collapses:

```js
for (const r of msg.buckets) {
  const key = r.b + '|' + (r.model || ''), prev = cell.get(key) || 0;
  if (r.tok <= prev) continue;
  cell.set(key, r.tok);
  Tsum += r.tok - prev;
  grew = true;
}
T = Math.max(Tfloor, Tsum); Tfloor = T;
```
  `applyOverride()` collapses to `T = Tfloor = Tsum = TOK_OVERRIDE`.
* `mountEnt`: `e.paint = e.flavor ? paintFlavor(e.flavor, e.idx, e.band) : paintHouse(e.idx, e.band)`
  — **stored on the entity** so a remount/promotion repaints identically and the burst matches.
* `ctx.perMin` / `ctx.paceRatio` computed in the existing 500 ms stat tick from `cell`
  (sum of buckets with `b >= now - 30 min`, ×2, honouring `r.w`).

### 9.4 Framing

```js
const b = plan.boundsFor(built);                       // {cx, cz, r}
const monTop = monument.crownHeight;
target.set(b.cx, 3 + Math.max(b.r * .05, monTop * .16), b.cz);
if (!userDist) dist = clamp(Math.max(b.r * (1.35 + .5 * clamp(b.r/112, 0, 1)) + 20,
                                     monTop * 2.1), 50, 300);
scene.fog.density = fogFor(dist, env.biome);           // environs is the fog authority
env.setExtent({ inner: ctx.plazaR, outer: b.r });
// shadow frustum centred on b, extent min(b.r, 62) + 12 — "nothing past bandOf > 4 casts"
```

The orbit target moves with the town's centre of mass; the monument stays at the origin and
simply is not always the centre of frame, which is correct for a river town whose plaza sits
on one bank. Call `refreshFraming()` from `fireMilestone` too — a tier-up is exactly the
moment the altar should be the subject.

### 9.5 Chrome

**Header** (`index.html`): seeded seal · `<h1>` = the **town name** ("Token Town" is the
product; the header carries the *place*) · archetype chip (`plan.kindLabel`, muted) ·
3 palette dots (the "weather vane") · `#rangeBadge` (`🕒 Last 24 hours · since 09:12`, muted,
always visible, flashes once on a range change) · sun/clock unchanged. `#legend` is
**deleted**; so is the `.legend` CSS rule. `document.title = 'Token Town — ' + townName`.

**`#news`** row (§7.1) between header and stage.

**Footer**, three zones, one row where it fits:

```
  500.0M  tokens this session       🏘 329 buildings · 🧍 157 villagers · Prosperity IV     next building ▓▓▓░░░ 5%
  ▲ 89.2M ahead of yesterday        grandest Keep · 🌳 2 breaks · 🏆 4 milestones · ⚡1.4M/h  ✦ Sky-Gate Arch at 1.00B ░ 0% · 500.0M to go
 └───────── ZONE A: the hero ──────┘└────────────── ZONE B: the town, muted ──────────────┘└──── ZONE C: the two reward bars ────┘
```

* Zone A keeps its 22 px tabular-nums hero and its flash, tinted `ctx.accentCss`. The label
  carries the range (`tokens ${ctx.rangeShort}`). Underneath, the only comparison that
  matters: `▲ 89.2M ahead of yesterday` (green) / `▼ 60.2M behind` (amber), from `msg.prev`.
  Hidden when `!ctx.rangeIsDay` (§10.4).
* Zone B is one plain uncoloured sentence. `⚡ pace` and `🏆 N milestones` are new; the
  milestone counter is the §11.3 evidence trail.
* Zone C: **both bars ≥ 120 px wide.** At 74 px, 5 % is three pixels and the meter reads as
  static — these are the channels that pay out continuously.
* **Deleted:** the four family chips, the `break` legend chip, `since 08:00` (now the header
  range badge). The `— demo data` suffix survives as a small muted tag at the far right.

**Tooltips** lose every family line:

```
House      →  Villa                       #142 of 431 · settled 14:07   Terracotta roof · band 3
Painted    →  Villa ✦ Painted Lady        #214 of 431 · settled 15:22   Plum walls · the talk of the street
Flavour    →  Tavern                      #88 of 431 · settled 11:40    Saffron roof · band 2
Landmark   →  Cathedral 🏛                unlocked at 100M · 13:02      landmark 6 of 9
Bridge     →  Stone Bridge                built at 88 buildings         the river crossing
Monument   →  The Orbital Reliquary       431M tokens this session      next: Observatory at 500M — 71%
Grove      →  break 🌳                    14:20 → 15:00 · 40 min        no tokens burned
Signpost   →  Millbrook-on-Ledger         riverside market town · seed 8F3A   showing: this session — since 08:12
```

The monument's first line **names its tier** — the cheapest possible way to make the
escalation legible.

### 9.6 The signpost

A wooden fingerpost at `plan.gate`, two boards: the town name burnt into the upper one, the
range on the lower. Built by `town.js` from `MAT`/`GEO` primitives (it is chrome, not a
building), hover-testable, and it is the town's ID card — it converts a transient overlay
into a place. It is mounted with the plat (t = 0), before any building.

---

## 10. `datafeed.js` / `main.js` / `preload.js` — THE RANGE (owner: **feed**)

### 10.1 The epoch model

Every sub-problem — creeping windows, midnight, session breaks, the per-day seed, when to
tear down — is one problem: **when does the current town stop being the right town?**

```
epoch = (rangeKey, epochId)      epochId: deterministic, wall-clock derived string
```

The feed emits **exactly one `init` per epoch**. Within an epoch `range.startMs` is frozen, so
`T` stays monotonic — the invariant the whole renderer is built on. At a boundary the anchor
is recomputed exactly (`now − len`), so drift never accumulates. `epochId` derives from the
wall clock, not from launch time, so reopening the town in the same epoch gives back the
*same* town.

Per-key quantum `Q` / worst-case trailing surplus / history bin / labels: the table in
`scratchpad/v3-design-range.md` §1.1 is **normative** and reproduced in condensed form:

| key | start | Q | bin | label | short |
|---|---|---|---|---|---|
| `session` | data-driven (§10.2) | on session change | 5 m (15 m if span > 6 h) | `Session · since 10:02` / `· pinned 10:00` | `this session` |
| `last1/4` | `now−N h` | 15 / 30 min | 5 m | `Last hour` / `Last 4 hours` | `the last hour` / `the last 4 h` |
| `last8/12` | `now−N h` | 1 h | 15 m | `Last N hours` | `the last N h` |
| `last18/24` | `now−N h` | 2 h | 15 m | `Last N hours` | `the last N h` |
| `today` | local midnight | local day | 5 m | `Today` | `today` |
| `last7/10/15/30` | `now−N d` | local day | 1 h | `Last N days` | `the last N days` |
| `currentMonth` | local 1st 00:00 | local day | 1 h | `August` (+year if not this year) | `this month` |
| `all` | `0` | local day | 6 h | `All time` | `all time` |

**Every key's quantum is ≤ one local day.** That is contractual: it is what guarantees the
town is rebuilt at least daily, which is what lets the palette/biome `daySeed` only ever
change across a `hardReset` (§11.5). It also delivers the user's "different seed each day"
free — the month town and the all-time town are redrawn every dawn, same numbers.

Why not a tighter quantum on `last1`: a teardown + 138-house cascade is a *big* visual event.
Once per 15 min is a rhythm; once per 5 min is a nervous tic.

```js
const dayIndex = ms => { const d=new Date(ms); return Math.floor((d - new Date(d.getFullYear(),0,1))/864e5) + d.getFullYear()*400; };
function epochIdOf(key, now, st) {
  if (key === 'session') return st.manual ? `session:pin:${st.startMs}` : `session:${st.startMs}`;
  const q = QUANTUM[key];
  if (q === DAY) return `${key}:${dayIndex(now)}`;
  return `${key}:${dayIndex(now)}.${Math.floor((now - startOfDay(now)) / q)}`;   // aligned to LOCAL midnight
}
// 32-bit FNV-1a → range.seed → ctx.planSeed
const seedOf = s => { let h=0x811c9dc5>>>0; for (const c of s){ h^=c.charCodeAt(0); h=Math.imul(h,0x01000193)>>>0; } return h>>>0; };
```

Range resolution must mirror the C# exactly (`normalizeRangeKey` per
`MainWindow.xaml.cs:4285`: `previousMonth→currentMonth`, unknown→`last7`; `lastN` = plain
arithmetic so 7 days is 168 h across DST, matching `DateTimeOffset.AddDays`; `today` /
`currentMonth` on the local calendar). No `endMs` is ever applied.

### 10.2 Session

`ManualSessionStartMs` wins unconditionally. Otherwise the full `LAG`-window gap query
(30-day lookback, `MIN(timestamp_ms)` fallback) runs **only at init and on a gap-hours
change** — measured at **67 ms**. Thereafter a new session is detected O(1):

```js
const m = Number(maxStmt.get().m || 0);                        // SELECT MAX(timestamp_ms) — 0.09 ms
if (!manual && lastEventMs && m > lastEventMs && m - lastEventMs >= gapMs) sessionStart = m;
lastEventMs = Math.max(lastEventMs, m);
```

Identical semantics, 700× cheaper. Backfilled rows don't move `MAX`, so they cannot fake a
session break; in-flight upserts don't move it either.

### 10.3 Protocol v3

```jsonc
{ "type":"init", "v":3, "now":1786055837539,
  "range": { "key":"last24", "epochId":"last24:810512.4", "seed":2748193443,
             "startMs":1785969437539, "lenMs":86400000, "rolling":true, "manual":false,
             "dayIndex":810512, "binMs":900000, "tailStartMs":1786048800000,
             "label":"Last 24 hours", "short":"the last 24 h", "sinceLabel":"09:12",
             "isDay":false },
  "prev": { "tok":1922485447, "label":"beat the previous 24 h" },     // nullable
  "lat": 52.2,
  "sessionStartMs": 1785969437539,          // legacy alias of range.startMs — ONE release
  "buckets": [ {"b":1785969600000,"w":900000,"tok":41235}, …,
               {"b":1786048800000,"w":300000,"model":"claude-opus-5","tok":80421} ] }

{ "type":"buckets", "now":…, "buckets":[{"b":…,"w":300000,"model":…,"tok":…}] }
{ "type":"config",  "lat":52.2 }                       // cosmetic only, never resets
{ "type":"error",   "message":"…" }
```

* Rows gain `w` (bin width ms; absent ⇒ 5 min). `backfillGroves` must read gaps as
  `next.b − (r.b + (r.w || INT_MS))`.
* **`colors` / `ModelColors` are removed from the protocol** — model attribution is dead.
  `settings.json` is still polled, but a `ModelColors` change is a no-op.
* **Two resolutions, never overlapping:** a live tail `[tailStart, now]` at native 5 min
  (`TAIL_MS = 2 h`), and folded history `[rangeStart, tailStart)` at `binMs` chosen by span
  (`≤6 h → 5 m; ≤36 h → 15 m; ≤45 d → 1 h; else 6 h`). `tailStart` is floored to `binMs`, so
  no `b` is ever produced by both queries and the renderer's `cell` map cannot collide.
  History folds the model dimension away. Result: `all` = 394 + 24 rows ≈ 22 KB instead of
  13 639 rows ≈ 550 KB; 55–126 ms of SQLite at most once per 15 min.
* The 2 s poll is range-independent (< 1 ms/tick) and gains **catch-up** (today it silently
  loses buckets across a sleep), capped at 12 h — beyond that force a fresh `init`.

### 10.4 `prev` — the range-aware personal best

| range | previous window | rung label |
|---|---|---|
| `today` | `[midnight−24 h, midnight)` | `beat yesterday` |
| `currentMonth` | previous calendar month | `beat last month` |
| `lastN` | `[start−len, start)` | `beat the previous N h/d` |
| `session` | the session before this one | `beat your last session` |
| `all` | — | `prev: null`, no rung |

`range.isDay` is true only for `today`/`session`; core hides the footer's "ahead of
yesterday" line and suppresses day-scoped ticker copy when it is false.

### 10.5 settings.json follow

Stat-gate first (the file is 45 KB and the tracker rewrites all of it on tab switches), then
**content-compare only four fields** (`SelectedRange`, `SessionGapHours`,
`ManualSessionStartMs`, `TownLatitude`). `File.WriteAllText` is non-atomic, so **torn reads
are expected, not exceptional**: on a parse failure return *without* latching the new stat and
retry in 2 s. A range/gap/pin change → `reinit()`. A latitude change → `{type:'config'}`, no
teardown. `main.js` caches the last `config` alongside `lastInit` for reload replay.

Tick order on the existing 2 s interval: `pollSettings()` → session `MAX` check →
`epochIdOf()` compare → `reinit()` or `send(buckets)`.

### 10.6 main.js / preload.js

`main.js` must **both** forward the new flags as query params **and** pass them to the feed
spawn (`--range=`, `--gap=`, `--session-start=`, `--epoch-quantum=`) — the renderer has no
channel back to the feed, so a `?range=` that only reached the page would be cosmetic. Add
`range`, `seed`, `intro` to the forwarded query list alongside `hour, tokens, still, demo,
feed`. The feed logs the resolved range to stderr (`[datafeed] range=last24 start=… bins=250+24
epoch=last24:810512.4`). `preload.js` needs no change.

**`--range=` never writes the user's settings.json.** Nothing in this app ever writes it.

---

## 11. THE EPOCH LIFECYCLE (owner: **core**, everyone must obey it)

### 11.1 Seed derivation — one place, two integers

```js
// town.js — the ONLY place seeds are derived.
const SEED_OVERRIDE = Q.get('seed') === null ? null : (Number(Q.get('seed')) >>> 0);
const daySeedOf = ms => { const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); };

// on every init:
planSeed = SEED_OVERRIDE ?? (msg.range?.seed >>> 0) ?? fnv1a('demo');   // layout, archetype, river, town name
daySeed  = SEED_OVERRIDE ?? daySeedOf(Date.now());                      // palette, wash, biome, wardrobe
seedHex  = planSeed.toString(16).toUpperCase().slice(-4);
```

* **`planSeed`** is the feed's `range.seed` = `FNV-1a(epochId)`. It changes when the epoch
  changes, so switching `today → last30` gives a **visibly different township** and a
  different name. Layout, archetype and the town name derive from it and nothing else.
* **`daySeed`** is the local calendar date. It is what makes the town *repaint each morning*
  even on a 30-day range. Palette, wash, biome and NPC wardrobe derive from it and nothing
  else. **Range changes what is counted; it never changes `daySeed`.**
* `?seed=N` overrides both — that is how three consecutive days are screenshotted for §13.
* **Nobody calls `Math.random()` for anything persistent.** Layout, palette, names,
  archetype, weather, landmark flavour, wardrobe all derive from a seed. `Math.random()`
  remains legal only for ephemeral particles and gait noise. A mid-day reload must rebuild the
  identical town.

### 11.2 `init` → epoch compare → teardown → rebuild

```js
function applyInit(msg) {
  const rg = msg.range || legacyRange(msg);              // demo / older feeds
  if (gotData && rg.epochId !== curRange.epochId) { pendingInit = msg; fadeT = performance.now(); return; }
  ...
}
```

The existing `fadeT → hardReset() → applyInit()` path (2 s fade-out) **is** the epoch reset
and stays exactly as it is. `pendingInit` is simply overwritten if a second change lands
mid-fade — last one wins, no queue, which is what makes hammering the range buttons harmless.

**Teardown order inside `hardReset()` — exact, because eight modules now hold state:**

```
1.  fxQ.length = 0                      (kill scheduled callbacks first, or they fire into a dead scene)
2.  drop every animEnts group, every liveScaf, every bridge, the signpost
3.  spawnQ / promoQ / mileQ / rawList / risers / groves / houses / landmarks / cell  cleared
4.  T = Tfloor = Tsum = built = mileIdx = minorAt = 0; the `best` rung is spliced OUT of LADDER
5.  monument.reset()                    (tier 0, ceremony cancelled, aura flushed)
6.  npcs.setPopulation(0)               (NOT dispose — the instanced pool is reused)
7.  news.reset(planSeed, plan.kind)     (new name, queue + bubbles flushed)
8.  plan = buildPlan(planSeed)          (the new epoch's plan; ~13–49 ms)
9.  initPalette(daySeed)                (new Palette; ctx.palette re-pointed)
10. env.setSeed(daySeed, plan, palette) (biome + archetype rebuilt in place; ~4 ms)
11. updateRoads(-1)                     (invalidate the road plate; it repaints on the next band)
12. refreshFraming(); retagMonument()
```

Nothing is `dispose()`d across an epoch — `dispose()` is for page teardown only. `npcs` and
`environs` reuse their pools; `monument` reuses its geometry.

### 11.3 Event flow: who tells whom

**conductor → news** (`news.post(kind, data)`, fired from sites that already exist in
`town.js`):

| kind | fire site | data |
|---|---|---|
| `boot` | end of the launch cascade | `{buildings}` |
| `dayStart` | `applyInit` after a `hardReset` | `{name}` |
| `rangeChanged` | `applyInit` when `range.key` changed | `{label, wider}` |
| `milestone` | `fireMilestone` | `{title, tok, id}` |
| `landmark` | `placeLandmark(animate)` | `{label, kind, order}` |
| `bridge` | bridge mounted | `{main}` |
| `best` | the `best` rung fires | `{tok}` |
| `tierUp` | `monument.setTier` with animate | `{tier, tierName}` |
| `buildingsAdded` | `drainSpawnQueue`, once per drained batch | `{n, total, label, tier, flavor}` |
| `promotion` | `drainPromotionQueue`, once per wave ≥ 4 | `{n}` |
| `grove` | `updateGroves` plants a grove | `{count}` |
| `pace` | 500 ms timer, only on a band change | `{perMin, trend, ratio}` |
| `idle` | 10 min with no growth, then every 15 min | `{minutes}` |
| `nightfall` / `daybreak` | `ctx.night` crosses .5 | `{}` |

**npcs → news is via town.js only.** `npcs` never knows `news` exists. `town.js` pulls
`npcs.pickSpeaker(want, _bv)` on the 2200 ms cadence and calls `news.say(_bv, kind)`.
Celebration cheers are pushed on the beat from `fireMilestone` / `drainSpawnQueue`.

**environs → news** is one function reference handed over at init (`opts.country =
() => env.news()`); environs never calls news.

Nothing else subscribes to `town.js`, and no module imports another.

### 11.4 The founding ritual — the first 20 seconds (wall clock from the first `init`)

The user opens the town roughly once a day, to a place that has never existed before. That
arrival is the highest-frequency emotional beat in the product and today it does not exist.
**The town must be *found*, then *founded*, then *inhabited* — in that order.**

```
t=0.00  THE PLAT. Terrain, water, roads, bridges, plaza, signpost — drawn. NO buildings, NO
        monument, NO villagers. Camera 1.35x final dist, pol +0.10. roadMat.opacity = 0.15.
        The only moment the day's SHAPE is visible without houses on top of it.
t=0.15  THE MASTHEAD. Centre-screen HTML plate in #overlay, fades up over 0.4 s:
                        MILLBROOK-ON-LEDGER
          founded Thursday 6 August · riverside market town · seed 8F3A
        Serif, letter-spaced, accent rule above and below. Holds to 3.4 s, GONE by 4.2 s.
        Not raycastable; must not survive hardReset() as a stray node.
t=0.90  THE CASCADE. The existing 1.4 s flat cascade, unchanged in mechanism.
        roadMat.opacity ramps 0.15 -> 1 across the same window, so the ground looks
        trodden in by the arrival.
t=2.30  THE MONUMENT LANDS LAST. scale 0 -> the tier the day deserves, animated, at the END
        of the sweep. Today it sits there on frame 0, which spends the punchline first.
t=2.40  THE CHARTER. Existing choreography, unchanged: shockwave to the town edge, gold
        burst at the coin, the big floater, npcs.celebrate(milestone).
t=2.60  THE SETTLE. Camera eases from the survey angle to the default framing over 2.2 s,
        easeOutCubic, via the existing dollyBias() hook.
t=3.00  THE DATELINE. news' first line: the Gazette masthead + population + a world fact.
t=6.50  THE COMPARISON. Second headline, from msg.prev: "Yesterday burned 412.7M. Today's
        pace: ahead by 89.2M." The most motivating single fact the app owns; it must appear
        inside the first ten seconds, every day it exists.
t~5-8   First speech bubbles. Steady state by 8 s.
```

**Everything must be finished and stable by t = 6 s** — a `--shot-delay=9000` run has to
catch a settled town, not a name plate. `?intro=0` skips the whole ritual (use it while
screenshotting your own layer; the acceptance shots must not).

The ritual runs on a **cold open and on an epoch reset with a new `range.key` or a new
`dayIndex`**. A same-key re-quantum (e.g. `last24` sliding forward 2 h) gets the **short
form**: 0.6 s crossfade, no masthead, one ticker line. That is a re-survey, not a founding.

`ctx.intro` is 0 during the ritual and 1 once settled; modules that want to hold their fire
(environs' extent chatter, news' ambient rotation) may read it.

### 11.5 Day rollover

There is **no separate rollover path**. Every range key's quantum is ≤ one local day (§10.1),
so midnight is an ordinary epoch boundary and the feed owns it. Core's `dayKey` synthesis is
deleted. `daySeed` therefore only ever changes across a `hardReset`, so a palette change never
has to repaint 400 standing houses.

---

## 12. FAMILY / MODEL ATTRIBUTION — THE COMPLETE DELETION AUDIT

> *"Houses shouldn't be related to the models used — free colour usage."*

Nothing may survive that means "this pixel is Opus". Every item below must be gone:

**`town.js`** — `FAMILY_TOKENS`, `FAMILY_SEEDS`, `colorsCfg`, `families` Map, `famKeyOf`,
`famOf`, `rebuildLegend()`, `familyForBuilding(n)`, `spent` Map, `F` Map, `dom{key,color,css}`,
`updateDominant()`, `famShare(key)`, `e.famKey` on every entity, the family line in `tipFor`,
the `counts` histogram in the 500 ms stats timer, the per-family footer chips, the family
rescale inside `applyOverride()`, and the `F.clear(); spent.clear(); families.clear();
rebuildLegend()` block in `hardReset()`.
`ctx.dominantColor` / `ctx.dominantCss` **survive as fields** but are re-pointed at
`palette.accent` / `palette.accentCss` — this is a deliberate zero-cost migration so
`monument.js` and `npcs.js` need no edit.

**`index.html`** — the `#legend` element, the `.legend` CSS rule, and the `break` legend chip.
The `#hint` copy `No tokens yet today.` becomes `No tokens ${ctx.rangeShort} yet.`

**`buildings.js`** — `roofOf`, `wallOf`, `timberOf`, `PLASTER`, `TIMBER`, and every
`colorHex` parameter (§4.2).

**`monument.js`** — the engraved `TOKENS TODAY` becomes `TOKENS ${short}`; nothing else in
the altar was ever model-aware.

**`datafeed.js`** — `ModelColors` / `colors` leave the protocol (§10.3). `settings.json`'s
`ModelColors` becomes a no-op.

**`README.md`** — delete *"Roofs carry your model families' colours"*; replace with the
seeded day palette, the archetypes, the range, the Crier and the eleven-tier altar. Update
the architecture section for eight files, the protocol for v3, and the screenshot knobs for
`--range=`, `--seed=`, `--intro=0`.

**Copy** — no ticker line, bubble, tooltip or plate may name a model. Grep the corpus.

---

## 13. INVARIANTS (all eight implementers — violating one is failure)

1. **NEVER open a visible window.** The user works on this machine. No `npm start`, no bare
   `npx electron .`, no clicking the tracker's "Town ↗" button. Verification is the built-in
   headless shot mode only, which renders in a hidden window and exits by itself:

   ```powershell
   cd <repo>\town
   $S = "%TEMP%\claude\<project>\<session-id>\scratchpad"
   npx electron . --shot=$S\v3-day.png --shot-delay=9000 --hour=13
   npx electron . --shot=$S\v3-night.png --shot-delay=9000 --hour=23
   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
   ```
   PowerShell 5.1: use `;`, never `&&`. Absolute paths, screenshots to the scratchpad only.
2. **The wall-clock existence rule.** Headless shots paint at ~1 fps. Everything about
   *existence* — spawned buildings, villagers present, worship in progress, the counter's
   value, headline text, bubble presence, aura column, footer numbers — is driven by
   `performance.now()`, **never** by accumulated `dt`. Only continuous motion (gait, travel,
   particle integration, decorative spin, coin flicker) may use `dt`. This rule is
   load-bearing all over the codebase and it is the most common way a v3 change breaks.
   Corollary for CSS: **base CSS is the final state; animations only travel toward it.**
3. **Demo mode.** Opening `index.html` in a plain browser (no preload bridge) must render a
   full, growing town with a countryside, a plan, a palette, a name and a ticker — with a
   synthesised `range` (`{key:'demo', epochId:'demo:0', seed:…, label:'Demo day',
   short:'today', isDay:true, binMs:INT_MS}`). `?feed=demo` takes the same path inside the
   shell, which is how it is verified without opening a browser.
4. **Perf budget: 60 fps on a mid GPU at 1200 buildings + 160 villagers.** Instancing and
   shared materials; beware per-frame allocations. Countryside ≤ 8 draw calls / ≤ 5 materials.
   Monument ≤ 21 draw calls at T10. Zero per-frame allocation in `update()` anywhere.
5. **r160 physical lights.** Directional/hemisphere intensities carry the `×π` factor
   (`LI = Math.PI`); point lights are candela. The **only** new light in v3 is the monument's
   single non-shadowing `PointLight` (§5.4). environs, layout, news and buildings create none.
6. **No new npm dependencies. No new files under `town/`.** three.js is vendored; renderer
   modules import from `./vendor/three.module.js`.
7. **Systems that must survive unchanged in behaviour:** camera orbit + drag + wheel zoom +
   dbl-click reframe + idle auto-spin · the day/night solar clock and gradient sky dome ·
   hover tooltips · the particle pool + floaters · the error banner
   (`window.addEventListener('error', …)` — the only way a headless run reports a crash) ·
   `window.__tick` manual stepping · the single-instance shell behaviour.
8. **Test hooks** (main.js forwards as query params **and** passes `--range/--gap/
   --session-start/--epoch-quantum` to the feed spawn):

   | hook | owner | effect |
   |---|---|---|
   | `--hour=13\|23` | core | forces the solar clock |
   | `--tokens=5e6` | core | forces T |
   | `--still=1` | core | freezes the feed |
   | `--feed=demo` | core | synthetic path inside the shell |
   | `--demo=slow\|fast` | core | synthetic cadence |
   | `--seed=N` | core | overrides planSeed **and** daySeed (§11.1) |
   | `--intro=0` | core | skips the founding ritual |
   | `--range=<key>` | feed | overrides `SelectedRange`, never writes settings.json |
   | `--gap=<hours>`, `--session-start=<ms>` | feed | session testing without pinning the tracker |
   | `--epoch-quantum=<ms>` | feed | forces a live epoch reset inside one screenshot |
9. **Nothing writes to `settings.json`, `usage.db` or `source/**`.** The DB is opened
   read-only (with the documented WAL fallback), and the tracker's exe is never rebuilt.

---

## 14. THE CUT LIST (things designed, deliberately not built in v3.0)

Cut because they make single-pass parallel assembly risky, not because they are bad:

1. **`palette.js` and `seed.js` as files** → folded into `buildings.js` / `town.js` (§0.1).
2. **`layout.seedOf(dayKey, rangeKey)`** → core supplies one integer (`ctx.planSeed`, §11.1).
   Layout must not derive its own seed.
3. **environs' `getCrossings()`** → layout sites its own bridges from its own polyline.
4. **The gate-ordered cascade** (`gateOrder(plotIdx)`) → the cascade drains in plot order,
   which already grows outward from the plaza. Only `roadMat.opacity` ramps. `plan.gate`
   still exists, for the signpost.
5. **Yesterday's ghost ring** — needs a stable token→radius map that the organic plan does
   not have for free. Defer; the `best` rung and the footer's `▲ ahead of yesterday` carry
   the same motivation.
6. **The Mayor**, **bubbles echoing the headline**, **the bell answering a milestone**, **the
   chimney census**, **lantern-moths**, **the Cemetery of the Perfect Circle** — all
   cross-module, all deferred to v3.1. Do not build them now.
7. **The river running at your pace** — cut in favour of environs' single `paceRatio` weather
   read (§6.5), which is the same idea with one owner.
8. **A sixth archetype.** The enum in §3.3 is closed for v3.0.
9. **`{type:'config'}` carrying colours** — colours are gone; `config` carries `lat` only.
10. **`quality:'low'`** may ship as a stub; headless shots must run `high` and there is no UI
    to switch it.
11. **Header-centre ticker** (director's chrome sketch) → `#news` is its own row (§7.1).
12. **`model` in the renderer's bookkeeping beyond the `cell` key.** `cell` stays keyed by
    model for upsert-delta correctness only; nothing else may read it.

---

## 15. PER-IMPLEMENTER BRIEFS

Each brief is *read spec §X,Y; deliver Z*. Read §0, §1, §2, §13 and §14 **first, always** —
they are the contract every brief assumes.

### 15.1 layout — `src/renderer/layout.js`
Read **§3** in full, plus §2 (`ctx.plan/band/frontierK/bounds`), §9.2 (what core will call),
§6.3 (environs reads `plan.spine`, `plan.water`, `plan.flatR`, `plan.kind`), §8.1 (npcs lives
entirely on `plan.graph`).
**Deliver:** `layout.js` exporting `LAYOUT`, `buildPlan(seed) -> Plan` exactly as §3.5 spells
it, with all five archetypes, bridges, stitching, Dijkstra `d`, two-pass plots, growth-order
`k`, clearance-scored landmark sites for all nine kinds, `plan.gate`, `plan.innerR ≥ 17.5`,
`plan.flatR`, `plan.spine`, the road-graph helpers, and `paintGround`. Zero imports.
Assert bit-identical rebuilds and 9/9 landmark placement across ≥ 8 seeds in a Node harness in
the scratchpad. Budget: build ≤ 60 ms, per-frame cost lower than v2's `plotSlot` loop.

### 15.2 environs — `src/renderer/environs.js`
Read **§6** in full, plus §2, §3.5 (the Plan fields you consume — treat **every one as
optional**), §1 (the quiet zone), §9.1 (core deletes its grass and tree scatters, so you own
that budget), §11.2 step 10 (`setSeed` is called inside `hardReset`).
**Deliver:** `environs.js` exporting `BIOMES`, `biomeFor`, `fogFor`, `initEnvirons` → the
`Environs` object of §6.8. Build order: (1) ground + veil + fogFor + the vignette CSS — this
alone fixes the user's complaint and depends on nothing; (2) flora + fields; (3) blades + sky;
(4) motes + biomes + archetype profiles + the pace weather; (5) water, cloud shadows, `news()`.
Ship 1–2 even if 3–5 slip. `dt` is never read; zero lights; `castShadow=false` everywhere.

### 15.3 news — `src/renderer/news.js`
Read **§7** in full, plus §1 (the voice — the Gazette does all the winking), §2, §11.3 (the
event table you must handle), §12 (no model names, ever), §13.2 (base CSS = final state).
**Deliver:** `news.js` exporting `townNameFor`, `initNews`, `NEWS_CORPUS`; the ticker with its
priority queue, ambient self-selection, anti-repeat ring and template slots; the 4-div bubble
pool with projection, snapshot anchors and TTLs; the hover history of the last five headlines;
≥ 190 ticker lines and ≥ 68 bubble lines including archetype-gated pools. `initNews` writes
the first headline **synchronously**. Verify with `--shot-delay=3000` (before any swap has
run) that text is present.

### 15.4 npcs — `src/renderer/npcs.js`
Read **§8** in full, plus §3.5 (`plan.graph` and its helpers are now your whole world), §2,
§5.6 (`cfg.plazaR` is a **function**), §7.5 (what `pickSpeaker` is for).
**Deliver:** the rewritten `initNPCs(scene, cfg)` on the new cfg, every leg a straight
segment, the ring/spoke machinery deleted, villagers bounded by `cfg.frontierK()`,
`pickSpeaker(want, out)`, `n.spokeAt`, and bridge-watchers. Everything else — pool, worship
circle, celebrations, night exodus, lanterns, public surface — survives unchanged.

### 15.5 monument — `src/renderer/monument.js`
Read **§5** in full, plus §2, §9.2 (core moves `LADDER`'s `mon` column to 0..10), §11.2
step 5 (`reset()` across an epoch), §4.5 (`ctx.accent` is the day's hue), §12 (`TOKENS TODAY`).
**Deliver:** the eleven-silhouette ladder with the full tier tables, the instanced furniture,
the single gated `PointLight`, the aura/fountain/coin-rain modes on a wall-clock cadence, the
escalating ledger frame with an unchanged canvas layout, the four-phase ceremony, and the new
getters `ceremony / nightSun / tierName / crownHeight / plazaWant` + `setRangeLabel(short)`.
The footprint invariant of §5.1 is a hard constraint: **verify `footprintR × growS ≤ 12.5`
at tier 10** before shipping.

### 15.6 buildings — `src/renderer/buildings.js`
Read **§4** in full, plus §2 (`ctx.palette`), §12 (the deletion audit), §5 (the monument is
gold and is not yours), §3.5 (`plan.bridges` gives you the bridge spec).
**Deliver:** the palette system (`initPalette`, `palette`, `paintHouse`, `paintFlavor`,
`paintLandmark`, `paintBridge`, `dayAccent`, `roofNameOf`, `rareOf`) with the ten roof
families, the two harmony rules, the daily wash, band drift and the painted lady; the four
changed builder signatures; `buildBridge`; and the removal of `roofOf`/`wallOf`/`timberOf`/
`PLASTER`/`TIMBER`. Keep shade variation quantised to 7 steps — the material cache depends
on it. Target ~80 quantised materials, the same order as today.

### 15.7 feed — `src/datafeed.js`, `src/main.js`, `src/preload.js`
Read **§10** in full, plus §11.1 (`range.seed` becomes `ctx.planSeed`), §11.2 (an `init` is an
epoch reset), §13.8 (the test hooks you own), §12 (colours leave the protocol).
**Deliver:** `normalizeRangeKey` / `resolveRange` / `resolveSession` / `epochIdOf` / `seedOf`
/ `labelOf`; `gapStmt`, `firstStmt`, `maxStmt`, parameterised coarse + fine statements; the
folded-history + live-tail split with `w` on every row; `pollSettings` with the stat gate,
four-field content compare and torn-read retry; `reinit()`; the 2 s tick order with catch-up;
`prev` for all five range shapes; the argv hooks; the stderr range log. `main.js`: forward
**and** spawn-pass the flags, cache the last `config`. Ship order: protocol + resolution +
init (screenshot each key with `--range=`) → live follow → folding → labels. **No C# is
touched; nothing is ever written to disk.**

### 15.8 core — `src/renderer/town.js`, `src/renderer/index.html`, `README.md`
Read **everything**, and own the seams: §2 (you allocate and mutate `ctx`), §9 (your file's
whole diff), §11 (seeds, the epoch lifecycle, the teardown order, the ritual, the event bus),
§12 (the deletion audit is mostly yours), §5.6 and §9.4 (plaza + framing).
**Deliver:** the plan-keyed rewrite of `town.js`; the six module wirings in the right order
(`initPalette` → `buildPlan` → `initEnvirons` → `initMonument` → `initNPCs` → `initNews`);
`updateRoads(band)` via `plan.paintGround`; bridge + signpost mounting; the founding ritual
and `?intro=0` / `?seed=N`; the epoch compare and the §11.2 teardown; the 14 `news.post` fire
sites and the 2200 ms bubble sampler; the new header, `#news` row, three-zone footer and
tooltips; the full family deletion; and the README rewrite. You also run the assembly
screenshots — no other implementer launches Electron.

---

## 16. ACCEPTANCE

REDESIGN.md §8's checklist still applies in full. On top of it:

- [ ] **Three seeds, three towns.** `?seed=` for three values at `?tokens=5e8&still=1`:
      visibly different plans, palettes and horizons. **Someone who has not read the code must
      be able to name each in one phrase.**
- [ ] **No circle.** No shot contains a full unbroken concentric arc. The word "bullseye"
      does not occur to a fresh viewer.
- [ ] **The horizon is broken** in ≥ 60 % of azimuths, and nothing outside the town outranks
      the town in brightness or saturation.
- [ ] **No model attribution survives** anywhere: no legend, no family chips, no `famShare`
      line, no colour that means "Opus". Grep passes.
- [ ] **The range label is visible in every shot** and matches `settings.json`; changing
      `SelectedRange` in the tracker re-inits the town within ~2 s, with the short-form
      transition, not the full ritual.
- [ ] **Ticker legible in a 9 s headless shot**, mid-line, never mid-scroll; ≥ 1 speech bubble
      alive at t = 6 s; the crier has copy at `--shot-delay=3000`.
- [ ] **The monument escalates.** `--tokens=3e5` (Waystone, must not look like a bug),
      `5e6`, `5e8`, `1e9 --hour=23` (night sun, beacon, sky ring, legible ledger) are four
      obviously different silhouettes.
- [ ] **A promotion-only tick is visible.** With `T` up 2 M on a 500 M town and zero new
      plots, a viewer can still tell something happened (§11.3 `promotion` + `npcs.celebrate`).
      `townSize` is a power law — the next building at 500 M costs ~4 M, so the core reward
      silently stops paying exactly when the user is working hardest. **The town must get
      richer instead of wider.** This is the single most important behavioural note in v3.
- [ ] **A milestone leaves evidence** discoverable twenty minutes later without having
      watched it: the landmark stands, the beacon is taller, `🏆 N milestones` is in the
      footer, and the headline is recoverable by hovering `#news`.
- [ ] Day and night shots at `5e6 / 5e8 / 1e9` with **no error banner**, ≥ 60 fps at 1200
      buildings and 160 villagers, and `renderer.info.render.calls` up ≤ 4 versus v2 for the
      countryside.
- [ ] Plain-browser demo load: full town, countryside, palette, name, ticker, no console error.
