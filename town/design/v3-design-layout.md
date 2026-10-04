# Token Town v3 — `layout.js`, the organic layout engine

**Status:** design + working prototype. Prototype: `scratchpad/proto/{layout.js,run.js,png.js}`
(plain Node, no deps). Renders: `scratchpad/plans.png` (6 seeds, full capacity),
`scratchpad/plans-430.png` (one seed per archetype, drawn at 430 buildings — the real-world
ceiling, see §1.1). Every number in this document is measured from that prototype.

---

## 0. What this replaces, in one sentence

v2's town is `plotPos(i)` = "ring `r`, slot `i`, radius `R0 + r*RGAP`" — a bullseye with a
hardcoded table of reserved landmark indices. v3 replaces it with a **seeded street plan**:
a road graph grown by agents through an archetype's terrain fields, with plots laid along
the frontages and ordered by distance-from-plaza. Everything downstream (tiers, framing,
roads texture, NPC routing, landmarks, scaffolds) keys off the plan instead of off `r`.

`layout.js` imports **nothing** — no THREE, no DOM. It is pure `{x, z}` geometry, so it
runs in Node (which is how it was tuned) and the renderer converts to `Vector3` at the
boundary. That also makes it the one v3 module with real unit tests available for free.

### 0.1 The invariant, and why it is free

> `plan.plotAt(i)` must be deterministic and immutable for a fixed seed as the town grows.

The design does not grow plots incrementally at all. **The whole plan is generated once, up
front, for the full capacity** (~13–49 ms, §6), then sorted once into growth order.
`plotAt(i)` is `plots[i]` — an array index into a frozen array. There is no incremental
state that could drift, no re-layout on spawn, and "existing buildings can never move" is
true by construction rather than by discipline. Measured: two builds of the same seed are
bit-identical (`run.js` asserts it).

The only growth that happens later is `ensureCapacity()` (§3.4), which appends plots
**strictly beyond the current outer radius** and never touches indices already handed out.

---

## 1. Sizing reality check (do this before tuning anything)

`townSize(T) = min(1200, floor(32·(T/1e6)^(3/8)))`. Inverting it:

| tokens/day | buildings |
|---|---|
| 100 M | 187 |
| 500 M | 342 |
| **1 B (the user's real day)** | **427** |
| 5 B | 740 |
| 15.7 B | 1200 (the cap) |

So `N_CAP = 1200` is a safety rail, not a target: the everyday maximum town is **~430
buildings**. The plan is therefore tuned so that 430 buildings read as a *town* (measured
frontier radius 138–238 depending on archetype, vs v2's ~102 at ring 8), and capacity beyond
~900 is handled lazily instead of being paid for on every launch.

Base plan capacity, measured across 8 seeds: **456–1139 plots** (thin ribbon valleys at the
low end, hillring at the high end). `ensureCapacity(1280)` reaches 1068–1489 in a further
50–280 ms, and is only ever called past ~900 buildings, i.e. at >10¹⁰ tokens/day.

---

## 2. The archetypes

Five, chosen by seed with weights `crossroads 2.6 / riverside 3 / ribbon 2 / lakeside 2 /
hillring 1.4`. They are **not five generators**. They are five parameter packs for one
generator, and each pack supplies at most four things:

```
radiusAt(angle) -> number     the town boundary (elongation / lobes)
blocked(x, z)   -> number     >0 = unbuildable; the magnitude is depth into the obstacle
guide(x, z)     -> {a, k}|null  a director field: preferred heading, and how hard to obey
seeds[]         -> {a}        the initial spine headings out of the plaza
bridgeSites[]   -> {x, z, a}  pre-chosen crossings (riverside only)
```

| archetype | terrain | reads as |
|---|---|---|
| **crossroads** | none; `radiusAt` is a gentle 2-lobe oval | two oblique spines meeting at the market square; the classic |
| **riverside** | Catmull-Rom river polyline (width 12–18) offset 26–42 from the plaza; `guide` runs quay streets parallel to the bank | a bridge town — plaza on the bank, 3 bridges, both banks settled |
| **ribbon** | a sinuous valley axis (amplitude 44–80, period 190–280); `blocked` = outside the corridor half-width 46–64 | a long winding valley village; the town is a *strip*, which is what makes `boundsFor` earn its keep |
| **lakeside** | a 7-lobed irregular lake tangent to the plaza; `guide` is tangential (a promenade) | the town wraps the shore in a C |
| **hillring** | 6-lobed `radiusAt`, `guide` is tangential in two bands (r≈60, r≈140) | a hilltop settlement with wobbly loop roads and radiating lanes — the nod to v2, deliberately never circular |

The prototype render `plans-430.png` shows one of each; they are unmistakably different
towns at a glance, which was the point.

**Seeding.** `seed = hash("v3|" + localDayKey + "|" + rangeKey)`, where `localDayKey` is
`YYYY-MM-DD` in local time and `rangeKey` is the tracker's `SelectedRange`. Rationale: a
range change is already a full epoch reset in the renderer (a fresh `init` rebuilds
everything), so letting it re-roll the town costs nothing and gives "switch to Last 7 days →
a whole different township" for free. If that proves annoying in play, drop `rangeKey` from
the hash — one line, and the plan is otherwise unaffected.

---

## 3. The generator core

Six phases. Phases 1–5 are the plan; phase 6 is lazy.

### 3.1 Plaza hub
An irregular ring of **7 nodes** at `PLAZA_R·(0.95…1.13)`, linked into a loop. Every spine
hangs off the nearest hub node to its heading. This gives the monument a generous square on
the main road (`plan.plazaPos`, `plan.plazaR = 15`) and gives villagers a circulation ring
to arrive on. Hub nodes are flagged `hub:true` and are excluded as landmark sites.

### 3.2 Agent growth (the actual "organic" part)
A priority queue of street agents, **expanded cheapest-first by distance-from-plaza**, so
the graph itself grows outward from the square. One agent step:

1. `heading += sin(correlated phase)·CURL[depth] + jitter` — correlated noise gives smooth
   curves rather than a drunkard's walk. `CURL = [.11, .20, .30, .38]` by depth
   (spine / street / lane / track).
2. If a `guide` field applies, bend toward it by `k` (with a ±π fold so a street may run
   either way along a river).
3. Step `SEG = 13` units. **Every edge is a straight segment 13 long**; curvature is the
   chain, not the edge. This is the single most load-bearing decision in the design: it
   makes NPC walking, ground painting and plot layout all trivially linear (§4, §5).
4. Reject/terminate:
   - past `radiusAt(angle)` → the street ends, for good;
   - into water/cliff → **swerve** (see below);
   - within `SNAP = 15` of a *foreign* node → **link and end the street** (a T-junction).
     This is what turns a tree into a plan: loops, triangles, irregular blocks;
   - within `clearAt(r)` of a foreign node → **swerve**.
5. `clearAt(r) = 22 → 34` lerped over `r = 0 → 190`. Street separation *is* the shape
   control: a tight old core, straggly outskirts.
6. Branch every `BRANCH_GAP[depth] = [3,4,5,–]` steps (±2), perpendicular ±0.35 rad, with a
   45 % chance of a second branch on the other side.

Two lessons the prototype forced, both worth keeping in comments:

- **"Foreign" is a graph question, not a distance one.** Excluding neighbours by radius
  throttled every perpendicular branch to death — the graph starved at 47 edges. The fix is
  a 2-hop BFS set around the growing tip: its own street and the junction it just left are
  exempt, everything else must respect `clearAt`.
- **A rejected step must not kill the street.** One unlucky heading used to end it forever
  (160 edges instead of 520). Agents now swerve twice (`heading ± 0.45…0.85`) before giving
  up — which is also how real lanes behave.

### 3.3 Space-filling infill
The agent tree radiates; it does not *cover*. Past r≈120 it leaves huge empty wedges. So:
maintain a coarse coverage grid (cell `COVER = 28`), and each round find buildable cells
with no node in them but a covered neighbour, sorted by radius, and sprout a lane from the
nearest node toward each. Up to 60 rounds, ends when the frontier stops advancing. This is
enclosure of the commons, and it is what takes a plan from ~350 to ~900 plots.

### 3.4 Bridges, stitching, and true distances
- **Riverside bridges are constructed, not stumbled into.** The town bridge sits at the
  river's closest approach to the plaza; two more sit ~22 polyline steps up/downstream. Both
  bridgeheads are created as nodes with the span linked between them *before* growth, and
  agents are seeded outward from each head plus one from the plaza toward the near head. An
  earlier "bridge when an agent happens to hit water" rule produced **zero** bridges in six
  seeds. Now: 3, every time.
- **Stitching.** The graph must be one component — villagers path over it, and an island
  means stranded NPCs and unreachable errands. Bridge archetypes reliably produced 2–3
  islands (a far bank whose link starved). Every island is joined to the mainland by the
  shortest node-to-node link; if the midpoint is over water the link becomes another bridge.
  Measured: 3 components before, **1 after, on all 8 test seeds**.
- **`relaxDistances()`** — a Dijkstra from the plaza ring over the finished graph replaces
  each node's `d`. Before this, `d` was "the cost of whichever agent happened to arrive
  first", which after junction fusion and stitching can be wildly longer than the real walk.
  Growth order, landmark bands, ground painting and NPC decisions all key off `d`, so it is
  computed once, for real. `e.d = min(a.d, b.d)`.

### 3.5 Plots
Frontages down both sides of every non-bridge edge:

- **Laid out in the street's own arc length**, `s = node.d + t·len`, stepping `SPACING = 7.4`
  with the two sides staggered by half a pitch. Slotting per edge instead gave
  `round(13/7.4) = 2` slots → a 6.5 pitch → every second plot rejected. Arc-length phasing
  keeps the pitch exact across a node junction.
- Setback `[6.6, 5.6, 4.9, 4.3]` by street depth, ±0.5 alternating so the row is not a
  ruler line. `yaw = atan2(-n̂ₓ, -n̂_z)` — local +z is the façade, facing the street.
- Rejected if: inside `PLAZA_R + 4.5`; past `MAX_R`; within 4.5 of water/cliff; within
  `PLOT_D = 6.4` of an accepted plot (spatial hash); within `edge.w/2 + 1.6` of *any* road.
- **Two passes.** All street frontages first; burgage back rows (`+9.4`, core only, r<115)
  second, with whatever is left. One pass let an early edge's back row steal the spot of a
  later edge's own frontage — the thing that must never lose.
- Measured min separation across a full plan: **6.40–6.44** (v2's effective min was ~6.5),
  so existing house geometry needs no rescale.

### 3.6 Growth order — the one number that makes it read right
```
k = r + KD·(d − r) + dither(±3),   KD = 0.30
```
`r` = world radius, `d` = graph distance, so `d − r` is the *detour*: how far off the road
system a plot is. Pure `d` (KD=1) scatters the first 430 buildings out to r=250 — a straight
spine tip has a shorter graph distance than a winding inner lane, so the town grows in
spidery fingers. Pure `r` (KD=0) is a bullseye again. KD=0.30 grows a compact core that
creeps outward *along* the streets. The ±3 dither is what makes the two sides of a street
fill together instead of one whole side and then the other.

Sort by `k`, assign `n = index`. **That array is `plotAt`.**

### 3.7 Landmark sites — clearance, not reserved indices
v2 hardcodes `LM_PLOTS = {well:[5], windmill:[16,17], …}` plus a `RESERVED` guard set. That
whole mechanism dies. Instead each landmark declares `(unlockOrdinal, clearance)`:

```
well 32/5   windmill 60/8   market_hall 78/10   bell_tower 111/8   wizard_tower 144/8
cathedral 187/11   golden_statue 264/8   observatory 342/11   skygate 443/12
```

The target band is `plots[round(ordinal·0.72)].k` — i.e. *the place the town will have grown
to when this unlocks*, in the same key space as the plot order. Every non-hub node is scored:

```
score = worth(degree) − 1.6·((keyOf(node) − want)/34)² + jitter·0.35
worth: degree 1 (road end) 0.9 | degree ≥4 (big junction) 1.1 | degree 3 0.75 | else 0.3
```
plus hard rejects: too near the plaza, too near the map edge, wet, or within
`clr_a + clr_b + 8` of an already-placed landmark. So landmarks want road ends, crossroads
and bridgeheads — but the band dominates, or every monument ends up on the fringe (it did,
in the first pass). All 9 sites placed on all 8 test seeds.

Then **plots inside a landmark footprint are deleted and the array renumbered**. After that
`plotAt(i)` cannot collide with a landmark, and `plotIndexOf(k)` — v2's memoised
skip-the-reserved-indices function — is deleted outright.

---

## 4. API

### 4.1 Module
```js
// layout.js  (no imports)
export const LAYOUT = { MAX_R:250, PLAZA_R:15, SEG:13, SPACING:7.4, PLOT_D:6.4, N_CAP:1200 };
export function seedOf(dayKey, rangeKey) -> string
export function buildPlan(seed) -> Plan          // 13–49 ms
```

### 4.2 `Plan`
```js
plan.seed            // string
plan.kind            // 'crossroads' | 'riverside' | 'ribbon' | 'lakeside' | 'hillring'
plan.plazaPos        // {x:0, z:0} — kept at the origin; the town is off-centre around it
plan.plazaR          // 15
plan.capacity        // plots currently available
plan.plotAt(i)       // {x, z, yaw, d, depth, k, n} — frozen, immutable, i < capacity
plan.ensureCapacity(n)   // lazy outland growth; APPENDS ONLY (§3.4). returns new capacity
plan.depthOf(i)      // plot.k, the growth-order key in world units
plan.frontierOf(b)   // {k, r, cx, cz} for the b-th building — prefix-scanned, O(1)
plan.bandOf(i)       // (plot.k / 26)|0 — the integer that replaces v2's "ring"
plan.boundsFor(b)    // {cx, cz, r} — prefix AABB ∪ plaza, for the camera (§4.5)
plan.sites           // { well:{x,z,yaw,clr,node}, windmill:{…}, … } — landmark plots
plan.bridges         // [{x, z, a, span, w, main, d}]
plan.water           // {kind:'river'|'lake'|null, poly:[{x,z}], width} | valley corridor
plan.graph           // §4.3
plan.paintGround(ctx, X, opt)   // §4.4
```

`frontierOf` / `boundsFor` are backed by a prefix array built at plan time (one entry per 16
plots, interpolated) — no scanning at 1200 plots per frame.

### 4.3 Road graph — the replacement for `npcs.js`'s ring/spoke cfg
```js
plan.graph = {
  nodes: [{ i, x, z, d, depth, hub, adj:[edgeIdx…] }],   // ~230–500 per plan
  edges: [{ i, a, b, w, len, depth, d, bridge }]         // ~270–560; ALWAYS straight
}
```
and these helpers (all O(1)–O(small), all allocation-free except `pathTo`):
```js
plan.nearestNode(x, z)                  // spatial hash; the node you'd step onto
plan.nodePos(i)                         // {x, z}
plan.randomNextNode(prev, cur, rnd)     // weighted neighbour pick: strongly favours
                                        // continuing straight (heading dot), never
                                        // backtracks unless `cur` is a dead end
plan.pathTo(a, b)                       // A* over ≤500 nodes; 32-entry LRU cache
plan.randomRoadPoint(rnd, maxK)         // {x, z, edge} on a random edge with e.d ≤ maxK,
                                        // length-weighted — "somewhere in town"
plan.edgeBetween(a, b)                  // edge | null
plan.offsetOn(edge, t, lat)             // {x, z} — walk on your own side of the road
plan.distFromPlaza(x, z)                // hypot to plazaPos (replaces npcs' polarR)
```

**Migration of `npcs.js` internals.** The leg system collapses. Today there are three leg
types (`ring`, `spoke`, `walk`) plus `ringOfR / polarR / polarA / nearestSpoke / onRing /
onSpoke / beginLeg / routeTo`'s six-branch plaza-in/plaza-out case analysis. In v3:

```js
routeTo(n, x, z) =
  [{t:'walk', to nearestNode(n)}]                     // step onto the road
  ++ pathTo(nearestNode(n), nearestNode(x,z)).map(edge → {t:'edge', a, b})
  ++ [{t:'walk', x, z}]                               // doorstep
```
Every leg is now a straight segment, so `advance()` loses two of its three branches; `n.lat`
becomes a constant offset along the edge normal (`plan.offsetOn`). Villagers walk curved
streets because the *streets* are chains of straight edges. Delete: `roadR`, `spokes`,
`rings`, `RSTEP`, `ringMax`, `spokeA`, `ringOfR`, `nearestSpoke`, `onRing`, `onSpoke`, and
the `ring`/`spoke` branches of `beginLeg`/`advance`.

New `initNPCs` cfg (everything else unchanged):
```js
initNPCs(scene, {
  plan,                       // ← replaces roadR + spokes + rings
  frontierK: () => number,    // paved distance; villagers stay inside the built town
  plazaR, monument, monumentR, attractor, getBuildings, cap
})
```

### 4.4 Ground painting
The plan paints itself. `GROUND = 700` world units on a 2048² canvas → `k = S/GROUND ≈ 2.93
px/unit`; a 250-radius plan uses 73 % of the plate, which is the same headroom v2 had.

```js
plan.paintGround(ctx, X, {
  frontierK,        // paint nothing whose e.d exceeds this + 18 — the town PAVES as it grows
  px,               // pixels per world unit, for line widths
  wear              // 0..1, how much dirt-noise to stipple on top
});
// X is the world→pixel transform: X(x, z) -> [px, py]
```
Layers, in order (all inside one `ctx` — no state leaks out; the painter saves/restores):

1. **water bed** — river polyline stroked at `2·width` in bed brown, then the water body in
   dark blue-green; lake as a filled lobed path. Banks: a 5-unit sandy stroke at 40 % alpha.
2. **valley/hill shading** (ribbon, hillring) — a soft lighter band along the corridor axis
   so the countryside reads as landform rather than as an accident.
3. **verges** — every visible edge stroked at `w·1.7` in `rgba(96,88,68,.45)`, round caps.
4. **road surface** — every visible edge stroked at `w` in `#6d6450`. Because edges are
   straight, this is `moveTo/lineTo` per edge; ~500 strokes, ~4 ms.
5. **plaza** — filled disc at `plazaR`, plus 3 concentric cobble arcs.
6. **bridge approaches** — the deck itself is a mesh (§4.6); the painter only darkens the
   two approaches and skips the road stroke across the span.
7. **plot aprons + footpaths** — for every plot with `k ≤ frontierK`: a 1.7-unit trodden
   disc and a 0.95-unit path to the nearest point on its own street. This is what makes
   houses look settled rather than dropped on a lawn, and it costs nothing.
8. **wear** — 26 000 2.4 px specks under `source-atop`, exactly as v2 does it.

`updateRoads(rings)` becomes `updateRoads(band)` where `band = plan.bandOf(built-1)`; the
texture is regenerated only when the band changes (26 world units of frontier), which is
*less* often than v2's per-ring regeneration.

### 4.5 Framing
```js
const b = plan.boundsFor(built);       // {cx, cz, r}
target.set(b.cx, 3 + b.r * .05, b.cz);
if (!userDist) dist = clamp(b.r * (1.35 + .5*clamp(b.r/112,0,1)) + 20, 50, 300);
```
Measured centre offsets: 0–37 units at 60 buildings, 1–30 at 430 — small but real, and a
ribbon town at 430 has `r = 209–238` against a crossroads' `128`. v2's
`outer = R0 + r*RGAP` cannot express either. The orbit target moves with the town's centre
of mass; the monument stays at the origin and simply is not always the centre of frame,
which is correct for a river town whose plaza sits on one bank.

Shadow frustum: centre it on `b` too, extent `min(b.r, 62) + 12` (v2's "nothing outside ring
4 casts" rule becomes "nothing past `bandOf > 4` casts").

### 4.6 Bridges — who builds what
- `layout.js` owns `plan.bridges` (position, heading, span, width, `main`).
- `buildings.js` gains `buildBridge({span, w, main}, seed)` → deck + parapets + 2 piers +
  (for `main`) a lantern post at each end. One new geometry family, styled like the existing
  timber/stone kit; `hTop ≈ 2.2`.
- `town.js` mounts a bridge like a landmark when `bridge.d ≤ frontierK`, so bridges appear
  as the town reaches them, with the same scaffold-and-rise ceremony landmarks get. They are
  hover-testable (`kind:'bridge'`, tip: "Stone Bridge · built at N buildings").
- The **water surface** is a mesh, not just canvas: a ribbon of quads along the river
  polyline (or a lobed disc for the lake) at `y = 0.06`, `MeshStandardMaterial` with low
  roughness and a scrolling canvas-normal shimmer — it must catch the sun ball, or a river
  reads as a blue road. Painting the bed into the ground canvas underneath gives it depth for
  one extra fill.

---

## 5. What in `town.js` dies, changes, or is born

**Deleted outright**
`R0`, `RGAP`, `SPACING`, `SPOKE_N`, `SPOKE_A0`, `ringCap()`, `roadR()`, `plotSlot()`,
`plotPos()`, `plotFacing()`, `LM_PLOTS`, `RESERVED`, `_free`, `plotIndexOf()`,
`landmarkPos()`, `ringW()`, `curMaxRing()`, and the ring loops inside `makeRoadTexture()`,
`revealScatter()`, the road-lamp placement loop and `newGrove()`/`addTree()`'s ring math.

**Rewritten against the plan**

| v2 | v3 |
|---|---|
| `plotPos(idx)` | `plan.plotAt(i)` → `{x, z, yaw}` (yaw is *given*, not derived — a house faces its own street, not the plaza) |
| `plotSlot(idx).r` | `plan.bandOf(i)` for integer bands; `plan.depthOf(i)` for the continuous key |
| `tierOfPlot`'s `u = (slot.r+.35)/(maxRing+.9)` | `u = plan.depthOf(i) / (plan.frontierOf(built).k + 20)` — same anti-stall engine, continuous instead of stepped |
| `updateRoads(rings)` | `updateRoads(band)`, texture via `plan.paintGround` |
| `refreshFraming()`'s `outer` | `plan.boundsFor(built)` (§4.5) |
| `LM_PLOTS[kind]` → `landmarkPos()` | `plan.sites[kind]` → `{x, z, yaw}` |
| road lamps on `roadR(r)` rings | lamps at a seeded subset of graph nodes with `degree ≥ 3` (junctions), revealed by band |
| `revealScatter(rings)` | reveal by `bandOf`, and place hedgerow/rocks **along edges** (offset 9–14 from the centreline) rather than on ring circles |
| groves anchored to `(ring, angle)` | groves anchored to a plot's own `{x,z}` pushed 5 units off its street — a break plants a copse *behind the houses*, which is better anyway |
| `ctx.ringCount` / `ctx.outerR` / `ctx.roadR` | `ctx.band` / `ctx.bounds` / `ctx.plan` |

**New in `town.js`**
`let plan = buildPlan(seedOf(dayKey, rangeKey))`, rebuilt inside `applyInit` whenever the
day or range key changes (the existing `hardReset()` path already tears down every mesh;
add `plan = …` and one `updateRoads(-1)` invalidation). Plus bridge mounting (§4.6) and a
`plan.ensureCapacity()` call in `syncTown` when `want > plan.capacity − 60`.

---

## 6. Performance

Measured in Node (the browser will be within 2×; this runs once per epoch, not per frame):

| archetype | build ms | nodes | edges | plots |
|---|---|---|---|---|
| crossroads | 13–16 | 341–345 | 367–376 | 824–888 |
| hillring | 22–38 | 493 | 557 | 1132–1139 |
| lakeside | 24–26 | 329 | 368 | 793–795 |
| ribbon | 18–22 | 225–268 | 271–317 | 456–536 |
| riverside | 32–49 | 430–475 | 495–584 | 898–957 |

Hot spots and their fixes, already in the prototype: `blocked()` is memoised into a 3-unit
lazy mask (riverside 80 ms → 32); the agent queue is a linear-scan "heap" (fine at ≤400
live agents); spatial hashes at cell 24 (nodes) and 10 (plots).

Per-frame cost is *lower* than v2: `plotAt` is an array read instead of `plotSlot`'s loop
over rings, `bandOf` is a multiply, `boundsFor` is a prefix lookup. The NPC graph is 500
nodes / 560 edges — an A* is ~0.05 ms and is cached; villagers re-path only on a new errand.

---

## 7. Open choices for whoever implements it

1. **`rangeKey` in the seed** (§2) — keep or drop; one line.
2. **Ribbon capacity.** A narrow valley seats only ~460 plots. Either accept the cap
   (`townSize` clamps to `plan.capacity`, and a 5 B-token day maxes out a valley town — which
   is arguably a *lovely* thing to discover) or widen `valleyHalf` to 60–80. I'd accept it
   and put "the valley is full" in the news ticker.
3. **A sixth archetype** is cheap now — a coastal town is `blocked = half-plane + noise`, a
   walled town is `radiusAt` = a hard lobe with 4 gate nodes. The core does not change.
