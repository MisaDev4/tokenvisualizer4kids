# Token Town — Redesign Implementation Spec (v1, definitive)

The town stops being a timeline of 5-minute intervals. It becomes a **pure function of one
number**: `T`, today's total tokens. More tokens → more buildings, more villagers, a grander
monument. A huge burst adds *many* buildings, never one big house.

This document is the **only** input to implementation. Four implementers build in parallel
from it. If something here disagrees with a design doc in the scratchpad, **this document
wins**.

---

## 0. FILE OWNERSHIP — HARD RULE

| file | owner | may edit |
|---|---|---|
| `src/renderer/town.js` | **core** | core only |
| `src/renderer/index.html` | **core** | core only |
| `src/datafeed.js`, `src/main.js` | **core** | core only (neither is expected to change) |
| `src/renderer/npcs.js` *(new)* | **npcs** | npcs only |
| `src/renderer/monument.js` *(new)* | **monument** | monument only |
| `src/renderer/buildings.js` *(new)* | **buildings** | buildings only |

**Nobody writes a file they do not own. Nobody creates additional files under `town/`.**
Scratch harnesses, throwaway patches and screenshots go in the scratchpad directory, never
in the repo. `REDESIGN.md` itself is read-only for everyone.

`milestones.js` from the monument design is **cut** — the ladder lives in `town.js`. There
are exactly four source files.

### 0.1 Module rules

* Every module does `import * as THREE from './vendor/three.module.js';` itself. Module
  caching makes it one shared instance.
* **No circular imports.** `npcs.js`, `monument.js` and `buildings.js` never import each
  other and never import `town.js`. All data reaches them through `cfg` (at init) and
  `ctx` (per frame). `town.js` imports all three.
* No new npm dependencies. ES modules only. Relative paths only.
* Keep the existing code style: compact, dense three.js, sparse comments that state intent
  (why, not what).
* Every module must be safe when the town is empty (`T = 0`, `N = 0`, no buildings) and
  when the town is huge (`N = 600`).

---

## 1. THE SHARED CONTEXT OBJECT

`town.js` owns **one** `ctx` object, allocated once and mutated in place each frame (never
reallocated — no per-frame garbage). It is passed to `monument.update(dt, now, ctx)` and
`npcs.update(dt, now, ctx)`. Treat it as **read-only** inside the modules.

Copy this JSDoc verbatim into your module.

```js
/**
 * Per-frame read-only town context. Owned and mutated in place by town.js.
 * @typedef {Object} TownCtx
 * @property {number} day            daylight 0..1 (0 = full night)
 * @property {number} night          1 - day
 * @property {number} simNow         Date.now() sampled at frame start, ms
 * @property {THREE.PerspectiveCamera} camera
 * @property {number} totalTok       T — today's total tokens (monotonic, never decreases
 *                                   except on an explicit day rollover)
 * @property {number} buildingCount  N — houses standing right now (landmarks excluded)
 * @property {number} ringCount      outermost PAINTED ring index, inclusive, 0-based
 * @property {number} outerR         world radius of the outermost occupied plot ring
 * @property {number} plazaR         12 — PLAZA_R, constant
 * @property {(r:number)=>number} roadR   ring-road radius for ring index r, world units
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings
 *           live-ish array of standing buildings; pos is the plot centre (y=0), yaw is the
 *           group's rotation.y (local +z is the façade). Cheap to call once per errand,
 *           NOT per frame per NPC.
 * @property {THREE.Vector3} monumentPos  always (0,0,0) in v1
 * @property {number} dominantColor  0xRRGGBB of the model family with the most tokens
 * @property {string} dominantCss    '#rrggbb' of the same
 */
```

Units everywhere: **world units** (a Cottage is ~3 wide, ~3.5 tall), **milliseconds** for
`now`/`simNow`/durations, **seconds** for `dt`, **radians** for angles, **tokens** (raw
integers, cache reads included) for `tok`.

`now` in every `update(dt, now, ctx)` is `performance.now()` — the wall clock. `dt` is
`clamp((now-last)/1000, 0, .05)`.

---

## 2. `buildings.js` — CONSTRUCTION (owner: **buildings**)

`town.js` imports **all** construction from here and never calls `new THREE.BoxGeometry`
for a building again. `buildHouse`, `buildTree`, `buildScaffold`, `std`, `shade`, `box`,
`pyramid`, `MAT`, `GEO`, `disposeGroup` all **move here from town.js verbatim** and then
grow.

### 2.1 The uniform group contract

Every builder returns a `THREE.Group` positioned at the origin, with `userData`:

```js
/**
 * @typedef {Object} BuildingUserData
 * @property {number}   hTop      world height of the top AFTER g.scale — floaters anchor here
 * @property {number}   baseScale scalar applied to g.scale; town.js's pop-in eases toward it
 * @property {string}   kind      'house' | 'bakery' | 'tavern' | 'market' | 'windmill' |
 *                                'farm' | 'forge' | 'well' | landmark kind | 'tree'
 * @property {string}   label     tooltip title, e.g. 'Cottage', 'Bakery', 'Cathedral'
 * @property {number}   span      plots consumed; 1 for everything except landmarks
 * @property {THREE.Material[]} winMats  emissive window materials; town.js sets
 *                                .emissiveIntensity on all of them each frame
 * @property {Array<{obj:THREE.Object3D, axis:'x'|'y'|'z', rate:number, phase:number}>} spin
 *           town.js does `obj.rotation[axis] = phase + now * rate` — WALL CLOCK, so a 3 fps
 *           headless shot shows blades at a plausible angle, never frozen at 0
 * @property {Array<{p:THREE.Vector3, every:number, size:number, last:number}>} smoke
 *           chimney anchors in LOCAL space; town.js converts to world once at mount and
 *           fires a puff when `now - last > every`. Initialise last:0.
 * @property {Array<{mat:THREE.Material, day:number, night:number}>} glow
 *           emissiveIntensity is lerped between day and night values by town.js
 * @property {Array<{obj:THREE.Object3D, axis:'x'|'y'|'z', amp:number, period:number}>} sway
 *           `obj.rotation[axis] = amp * Math.sin(now / period)` — wall clock
 */
```

All arrays must exist (empty is fine) so `town.js` can loop without null checks. All
builders must call `g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow
= true; } })` before returning, except for additive/transparent FX meshes which set
`castShadow = false`.

### 2.2 Exports — exact signatures

```js
/** Tier vocabulary. Index === tier. Frozen. */
export const TIER_NAMES; // ['Tent','Shack','Cabin','Cottage','House','Villa','Manor','Keep']

/** Shared material cache. Keys from today's town.js are preserved verbatim, plus the new
 *  gold family. Consumers may read; never mutate. */
export const MAT;  // trunk leafA leafB stone stoneDark water wood rock bush lampPole door
                   // bulb gold goldHi goldDark canvasStripe

/** Shared geometry cache; today's keys preserved. */
export const GEO;  // trunk leafA leafB bush rock bulb pole  (+ whatever you add)

/** @param {number} color 0xRRGGBB @param {object} [extra] @returns {THREE.MeshStandardMaterial} */
export function std(color, extra);

/** Lighten (k>0) / darken (k<0) a hex colour. @param {number} hex @param {number} k -1..1
 *  @returns {number} 0xRRGGBB */
export function shade(hex, k);

/**
 * Cached MeshStandardMaterial. THE perf lever: buildHouse used to mint 4–6 materials per
 * building (~1600 for 300 houses). Quantise `hex` to the cache key and reuse.
 * @param {number} hex 0xRRGGBB
 * @param {'roof'|'wall'|'trim'|'stone'|'wood'|'glass'|'metal'} kind
 * @returns {THREE.MeshStandardMaterial}  SHARED — never mutate the returned material
 */
export function matFor(hex, kind);

/** @param {number} w @param {number} h @param {number} d @param {number} color
 *  @param {object} [extra] @returns {THREE.Mesh} */
export function box(w, h, d, color, extra);

/** 4-sided pyramid roof. @returns {THREE.Mesh} */
export function pyramid(w, d, h, color);

/** Dispose a group's owned geometry/materials. MUST skip anything owned by GEO, MAT or the
 *  matFor cache. @param {THREE.Group} g */
export function disposeGroup(g);

/**
 * A dwelling. Silhouette variant is derived from `seed` internally (3 variants per tier —
 * 24 archetypes total) so a 60-building ring never photocopies.
 * @param {number} tier 0..7
 * @param {number} colorHex family colour, 0xRRGGBB
 * @param {number} seed stable per plot (town.js passes a per-plot-index seed)
 * @returns {THREE.Group} with BuildingUserData, kind:'house', label:TIER_NAMES[tier]
 */
export function buildHouse(tier, colorHex, seed);

/** Flavour vocabulary. */
export const FLAVORS; // ['bakery','tavern','market','windmill','farm','forge','well']

/**
 * Deterministic sprinkle — roughly 1 plot in 6. Must never return the same kind for
 * plotIdx and plotIdx-1, and must never return 'farm' for ring < 2.
 * @param {number} plotIdx @param {number} ring
 * @returns {string|null} a FLAVORS entry, or null for a normal house
 */
export function pickFlavor(plotIdx, ring);

/** @param {string} kind a FLAVORS entry @param {number} colorHex @param {number} seed
 *  @returns {THREE.Group} BuildingUserData, kind===kind, span 1 */
export function buildFlavor(kind, colorHex, seed);

/**
 * Landmark metadata, keyed by kind. Frozen. town.js reads `span` and `label`.
 * @type {Record<string, {span:number, hTop:number, label:string}>}
 */
export const LANDMARK_DEFS;
// well:{span:1,hTop:2.4,label:'Well'}            windmill:{span:2,hTop:11,label:'Windmill'}
// market_hall:{span:3,hTop:8,label:'Market Hall'} bell_tower:{span:2,hTop:15,label:'Bell Tower'}
// wizard_tower:{span:2,hTop:18,label:'Wizard Tower'} cathedral:{span:3,hTop:20,label:'Cathedral'}
// golden_statue:{span:2,hTop:12,label:'Golden Statue'} observatory:{span:3,hTop:14,label:'Observatory'}
// skygate:{span:3,hTop:26,label:'Sky-Gate Arch'}

/** @param {string} kind a LANDMARK_DEFS key @param {number} colorHex dominant family colour
 *  @param {number} seed @returns {THREE.Group} BuildingUserData with the def's span/hTop/label */
export function buildLandmark(kind, colorHex, seed);

/** @param {number} seed @returns {THREE.Group} kind:'tree', label:'break' */
export function buildTree(seed);

/**
 * The next-building progress meter. Stands alone on the plot being paid for.
 * @returns {THREE.Group} whose userData carries:
 *   setHeight(h:number):void     — frame height in world units
 *   setProgress(p:number):void   — 0..1, fills a vertical bar inside the frame
 *   setGhost(on:boolean):void    — 25% opacity "planned lot" mode
 */
export function buildScaffold();
```

### 2.3 Performance requirement (buildings owner)

The town must hold **300+ buildings at 60 fps**. Two mandatory measures, both entirely
inside `buildings.js`:

1. **`matFor` caching.** Quantise the per-building `shade()` jitter to 8 steps and key a
   `Map` on `(hex, kind, jitterBucket)`. Target: ≤ ~80 live materials for the whole town
   regardless of building count. `disposeGroup` must skip cached materials.
2. **Static merge.** After a builder finishes assembling its parts, merge every **static**
   mesh that shares a lighting model into one `BufferGeometry` with a baked `color`
   attribute, drawn with one shared `MeshStandardMaterial({vertexColors:true})`. Anything
   referenced by `spin`/`sway`/`smoke`/`glow`/`winMats`, and anything transparent or
   additive, is exempt and stays a separate child. Write the ~40-line merge helper by hand
   (position/normal/color/index concatenation with `geo.clone().applyMatrix4(localMatrix)`
   — `BufferGeometryUtils` is not in the vendored build).
   Target: **≤ 3 draw calls per house** (body, windows, optional FX) instead of today's 8.

   This is an internal optimisation: the public contract is identical with or without it,
   so correctness never depends on the merge. Ship it, but ship it last.

Also: no builder may create a `PointLight` except `wizard_tower`, which gets exactly one
(`new THREE.PointLight(0x9085E9, 16, 20)`; town.js scales its intensity by `ctx.night`
via a `glow`-style entry — expose it as `userData.pointLights = [light]`).

### 2.4 Flavour & landmark content

Build these from the design brief in `scratchpad/design-monument.md` §3 (it is the
authority on their geometry; every dimension there is compatible with this spec). Summary
of what must exist and be recognisable at the default camera distance of 62:

* **bakery** fat brick chimney + striped awning, one `smoke` anchor every 1400 ms.
* **tavern** first-floor jetty, hanging sign on `sway`, windows warm even at noon
  (`glow:{day:.35,night:1.5}`).
* **market** no walls: 4 posts + a shared striped canvas roof + crates.
* **windmill** tapered tower + 4 blades on `spin` (axis 'z', rate 4.2e-4).
* **farm** ploughed quad + one `InstancedMesh` of ~21 crops + a scarecrow on `sway`.
* **forge** glowing coals (`glow:{day:.6,night:1.4}`) + a `smoke` anchor.
* **well** stone kerb, posts, gable roof, bucket on `sway`.

Landmarks must all be **taller than a Keep (7.1)** so they read as skyline events, and use
the `hTop` values in `LANDMARK_DEFS`. The `skygate` portal plane, the `cathedral` rose
window and the `wizard_tower` rune ring are the money shots — do not cut them.

---

## 3. `monument.js` — THE TOKEN ALTAR (owner: **monument**)

Replaces the plaza fountain entirely (core deletes the fountain). Fits inside
`PLAZA_R = 12`. It is the thing NPCs gather around and the place the live total is
displayed.

### 3.1 Hard requirements

* **The live token counter is 3D geometry, never an HTML overlay.** A `CanvasTexture` on a
  real plane in a real frame, yaw-billboarded to the camera (`rotation.y` only — it must
  never tip).
* The displayed value eases toward the target on the **wall clock**
  (`disp += (target-disp) * (1 - Math.exp(-dtMs/260))`), so a `--shot-delay=8000` headless
  run at 3 fps lands on the true number. Redraw at most every 90 ms and skip entirely when
  the formatted string is unchanged.
* Tabular digits **without font-feature dependence**: measure `ctx.measureText('0').width`
  once per size and draw each character centred in its own fixed cell.
* r155 light scaling: the monument creates **zero lights**. All its glow is emissive
  material + additive geometry.
* Everything animated is wall-clock (`now`), except purely decorative spin which may use
  `dt`. The coin's *existence* and the counter's *value* must be correct in a low-FPS shot.

### 3.2 Exports — exact signatures

```js
/**
 * Build the plaza centrepiece and add it to the scene at the origin.
 * @param {THREE.Scene} scene
 * @param {{plazaR:number, maxAnisotropy:number}} opts
 *        plazaR = 12; maxAnisotropy = renderer.capabilities.getMaxAnisotropy()
 * @returns {Monument}
 */
export function initMonument(scene, opts);

/**
 * @typedef {Object} Monument
 * @property {THREE.Group} group      added to the scene by initMonument
 * @property {number} radius          5.6 — NPC keep-out radius, constant
 * @property {number} tier            read-only current tier 0..9
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 * @property {(tok:number)=>void} setTotal
 *           store the target for the eased counter. Call every frame; it is cheap.
 * @property {(n:number, opts?:{animate?:boolean})=>void} setTier
 *           n 0..9. animate defaults true (0.65 s easeOutBack pop of the new parts);
 *           animate:false is the init/backfill path — final scale, no FX.
 * @property {(nextTok:number, progress01:number, label:string)=>void} setNext
 *           feeds the tablet's bottom progress bar. label e.g. 'NEXT 250M'.
 *           progress01 is already log-scaled by town.js; just draw it.
 * @property {(title:string, colorHex:number)=>void} celebrate
 *           the 2.2 s show: gold burst at the coin, a pooled additive shockwave ring
 *           scaling to ~0.9*ctx.outerR over 1.1 s, a title plate, tier pop.
 *           Particles/floaters for the wider town are town.js's job, not yours.
 * @property {()=>void} pulse
 *           tokens just increased: a light ring travels up the stele over 0.6 s and the
 *           coin's emissive throbs. Fired ~every 2 s while the user works. Must be free.
 * @property {()=>{center:THREE.Vector3, r0:number, r1:number, focus:THREE.Vector3}} getAttractor
 *           the NPC worship contract. center = origin, r0 = 5.6, r1 = 10.5, focus = the
 *           coin's world position (y rises with tier). Allocate once, return the same
 *           object mutated in place.
 * @property {()=>THREE.Vector3} getCoinPos
 *           world position of the coin, for town.js's own particle bursts. Same instance
 *           each call.
 * @property {()=>void} reset       day rollover: fade extras out, return to tier 0
 * @property {()=>void} dispose
 */
```

### 3.3 Content

Follow `scratchpad/design-monument.md` §1 — "The Great Ledger" — as written. Anatomy
(stepped octagonal base, water ring, stele, 4 braziers, the vertical spinning gold coin,
the billboarded tablet, counter-rotating halo rings, coin orbit, additive beacon, sky
glyph), the gold palette, the canvas layout, and the tier ladder:

| tier | at | what appears |
|---|---|---|
| 0 | 0 | base + stele, counter engraved small on the stele |
| 1 | 250k | tablet lifts and floats; coin appears (r 1.6); braziers lit |
| 2 | 1M | coin r 2.2; first halo ring; tablet frame gilds |
| 3 | 5M | water ring fills; second base step; coin r 2.6 |
| 4 | 10M | second counter-rotating halo; brazier flame flicker |
| 5 | 25M | everything above the base lifts +1.6; faint beacon (opacity .06) |
| 6 | 50M | stele plated gold; full beacon (opacity .18, scrolling) |
| 7 | 100M | third halo; 8-coin orbit |
| 8 | 250M | 4-step gold ziggurat base; tablet grows to 13×3.9 |
| 9 | 1B | 5-ring orrery, sky glyph at y 44, beacon .28, all gold |

`setTier` must be **idempotent and jumpable** — `setTier(7)` from tier 0 must produce the
same scene as stepping 1→7.

Counter formatting (monument-internal): `< 1e6` → grouped integer as the big line, no
second line; `1e6 ≤ n < 1e9` → `128.4M`; `≥ 1e9` → `1.284B`. Big line never exceeds 7
glyphs so the font size never has to shrink. Small line = exact integer, grouped with thin
spaces.

Tablet material: `map` and `emissiveMap` are the same texture, `emissive: 0xffffff`,
`emissiveIntensity = .22 + ctx.night * 1.15`, `tex.colorSpace = THREE.SRGBColorSpace`,
`tex.anisotropy = opts.maxAnisotropy`.

---

## 4. `npcs.js` — VILLAGERS (owner: **npcs**)

A working, screenshot-verified 471-line module already exists at
`<scratchpad>/npcproto/renderer/npcs.js`. **Start from it.** Copy it to
`town/src/renderer/npcs.js` and bring it up to the contract below. Do not redesign it.

### 4.1 Hard requirements (all already satisfied by the prototype — keep them)

* **6 InstancedMeshes** (body, head, hat, arms, contact disc, lantern), CPU-composed
  matrices. 160 villagers = 6 draw calls, ~0.20 ms/frame.
* `im.frustumCulled = false` on every instanced mesh (the geometry-derived bounding sphere
  culls the whole crowd otherwise).
* `setColorAt` for every instance **while `count` is still capacity**, then set `count = 0`
  (otherwise `instanceColor` is a zero-length buffer and everyone renders black).
* No real shadows — a translucent contact disc at `y = .045`, `renderOrder = 1`, opacity
  .28 by day → .10 at night.
* **Everything about existence is wall-clock**: `setPopulation` spawns the whole delta
  immediately, villagers spawn already spread over the road network, ~22 % spawn directly
  into a worship slot, role changes are scheduled against `now` timestamps. Only gait phase
  and travel distance consume `dt`. An 8 s headless run at 3 fps must show a fully
  populated, worshipping town.
* Exactly **two shared PointLights** for lantern carriers, retargeted every 500 ms.

### 4.2 Exports — exact signatures

```js
/** Performance cap. 160 measured at 0.15–0.20 ms/frame. */
export const NPC_CAP; // 160

/**
 * THE population curve — the NPC layer owns it (resolved conflict, see §5.7).
 * b <= 0 ? 3 : max(4, round(160 * (1 - Math.exp(-b / 80))))
 * @param {number} b buildings @returns {number} villagers
 */
export const popForBuildings;

/**
 * @param {THREE.Scene} scene
 * @param {NPCConfig} cfg
 * @returns {NPCSystem}
 */
export function initNPCs(scene, cfg);

/**
 * @typedef {Object} NPCConfig
 * @property {(r:number)=>number} roadR      ring-road radius for ring index r
 * @property {number} plazaR                 12
 * @property {THREE.Vector3} monument        altar centre — (0,0,0)
 * @property {number} monumentR              5.6 fallback keep-out radius
 * @property {{n:number, a0:number}} spokes  { n: 6, a0: -Math.PI/2 + .3 } — MUST match the
 *                                           road texture exactly or villagers walk on grass
 * @property {()=>number} rings              outermost PAINTED ring index, inclusive
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings
 * @property {()=>{center:THREE.Vector3,r0:number,r1:number,focus:THREE.Vector3}} [attractor]
 *           monument.getAttractor; when present it overrides monumentR. Worship arcs sit at
 *           r0 + {0.8, 2.3, 3.7}, clamped to [r0+0.5, min(r1, plazaR-0.8)]. Worshippers
 *           tilt their heads toward focus.y.
 * @property {number} [cap]                  defaults to NPC_CAP
 */

/**
 * @typedef {Object} NPCSystem
 * @property {number} count            getter — live villagers
 * @property {number} worshippers      getter — villagers currently at the altar
 * @property {(n:number)=>void} setPopulation      idempotent; safe every frame
 * @property {(b:number)=>void} setBuildingCount   = setPopulation(popForBuildings(b))
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 *           reads ctx.night and ctx.camera only
 * @property {(pos:THREE.Vector3, opts?:{runners?:number, cheerRadius?:number,
 *            milestone?:boolean})=>void} celebrate
 *           cheer ripples outward at distance×18 ms; up to `runners` strollers sprint in at
 *           2.6× speed; worship target jumps to 42 % for 9 s (20 s if milestone)
 * @property {()=>void} pulse          700 ms unison dip of the whole congregation
 * @property {()=>void} dispose
 */
```

Night behaviour, worship slots (42 in three arcs, filled inner-first), the three rites on a
shared chant clock, and the lantern system are all as in the prototype — unchanged.

---

## 5. THE GROWTH MODEL (owner: **core**, all of §5 lives in `town.js`)

### 5.1 The curve

```js
const TOK_UNIT = 1e6, K = 32, P = 3 / 8, N_CAP = 1200;
const townSize  = T => Math.min(N_CAP, Math.floor(K * Math.pow(Math.max(T, 0) / TOK_UNIT, P)));
const tokensFor = n => TOK_UNIT * Math.pow(Math.max(n, 0) / K, 1 / P);   // 1/P = 8/3
const costOf    = n => tokensFor(n) - tokensFor(n - 1);
```

| T | 10k | 200k | **1M** | **5M** | **20M** | **50M** | **100M** | **300M** | **1B** | 3B |
|---|---|---|---|---|---|---|---|---|---|---|
| buildings | 5 | 17 | **32** | **58** | **98** | **138** | **179** | **271** | **426** | 644 |
| rings | 1 | 2 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 11 |
| next costs | 4k | 30k | 86k | 228k | 543k | 958k | 1.5M | 2.9M | 6.2M | 12.4M |

The steep left end is the point: the first response of a session (1–5k tokens) detonates
**3–5 buildings**, and an early 3M burst takes the town from ~10 to ~45. `N_CAP` is a
safety valve against a corrupt DB read, never reached in practice. Nine rings at radius 102
fit inside the existing `refreshFraming` clamp — **no layout constant changes.**

### 5.2 Plot allocation and reserved landmark plots

`plotSlot` / `ringCap` / `roadR` / `plotPos` / `plotFacing` are **unchanged**. Ring caps are
15/24/33/42/51/60/69/78/87 (cumulative 459 through ring 8).

Landmark plots are **reserved statically at startup** — houses never occupy them, so a
landmark unlocking at 4 pm never has to evict anything and the town is fully deterministic:

```js
const LM_PLOTS = {                     // plotIdx runs, chosen to never straddle a ring seam
  well:[5], windmill:[16,17], market_hall:[24,25,26], bell_tower:[42,43],
  wizard_tower:[56,57], cathedral:[80,81,82], golden_statue:[100,101],
  observatory:[124,125,126], skygate:[150,151,152]
};                                     // 21 reserved indices total
```

`plotIndexOf(k)` returns the k-th (0-based) **non-reserved** plot index — memoise a growing
array. House ordinal `n` (1-based) lives at `plotIndexOf(n - 1)`.

A landmark's world position is the mean of `plotPos` over its reserved indices, then
**renormalised to that ring's radius** `R0 + r*RGAP` so a span-3 building does not sit
inward of its neighbours; `rotation.y = plotFacing(pos)`.

`refreshFraming()` sizes the town from `plotIndexOf(N - 1)` (so reserved plots count toward
the outer radius) and paints rings up to `plotSlot(thatIndex).r`.

### 5.3 Tier, variety and prosperity

`TIERS[].tok` is deleted. `MIN_HOUSE_TOK`, `finalizeInterval`, `addTokens`, `liveSlots`,
`cur`, `curOrder` and `INT_MS`-driven house building are all **deleted**.

```js
const prosperity = T => Math.max(0, 1.15 * Math.log10(Math.max(T, 1) / 2e5));   // "L"
function tierOfPlot(plotIdx, maxRing, L) {
  const u = (plotSlot(plotIdx).r + .35) / (maxRing + .9);
  const grandeur = 2.4 * (1 - u) * (1 - u) - .9 * u;
  return clamp(Math.round(L + grandeur + rarityOf(plotIdx, L)), 0, 7);
}
function rarityOf(plotIdx, L) {
  const r = seededR(plotIdx * 3.13 + 7.7), hi = .012 + .004 * L;
  return r > 1 - hi * .34 ? 3 : r > 1 - hi ? 2 : r > .80 ? 1 : r < .10 ? -1 : 0;
}
```

`u` is normalised against the **current** outer ring, so the town gets wider fast and
grander slowly, and yesterday's fringe becomes downtown as you grow — this redevelopment is
the anti-stall engine (100M→1B moves Cottages 77→62 while Houses go 53→200).

**Frontier construction**: the newest `min(8, ceil(N*0.04))` houses render **one tier below**
their settled tier wearing a scaffold; ~2.5 s after spawn they promote with a dust puff.

**Promotion waves**: recompute tiers only when `Math.floor(L / .25)` changes or `maxRing`
changes. Changed buildings go into a promotion queue drained at **10/s on the wall clock**,
inner-ring-first, each with a 6-particle dust puff and a 0.9→1.0 scale bounce.

### 5.4 Family attribution — debt settlement

Buildings keep their model-family colour, assigned by largest remaining debt, so the colour
histogram converges to each family's token share within one building:

```js
function familyForBuilding(n) {                    // n = 1-based house ordinal
  let best = null, bestOwed = -Infinity;
  for (const [k, tok] of F) { const owed = tok - (spent.get(k) || 0);
    if (owed > bestOwed) { bestOwed = owed; best = k; } }
  spent.set(best, (spent.get(best) || 0) + costOf(n));
  return best;
}
```

Deterministic and replayable (a restart rebuilds the same town), immune to upserted
absolute totals, and a family first used at 4 pm has huge debt and visibly claims the next
several buildings.

### 5.5 Ingest — the live algorithm

```js
const cell = new Map();   // "<bucket>|<model>" → absolute tokens (upsert-proof)
const F    = new Map();   // familyKey → tokens
const spent = new Map();
let T = 0, Tfloor = 0, built = 0;

function applyBuckets(msg) {
  for (const r of msg.buckets) {
    const key = r.b + '|' + r.model, prev = cell.get(key) || 0;
    if (r.tok <= prev) continue;                   // upsert re-read, nothing new
    cell.set(key, r.tok);
    const k = famKeyOf(r.model);
    F.set(k, (F.get(k) || 0) + (r.tok - prev));    // deltas only
    famOf(r.model);                                // registers the family/legend colour
  }
  T = Math.max(Tfloor, [...F.values()].reduce((a, b) => a + b, 0));
  Tfloor = T;                                      // totals only ever go UP
  if (TOK_OVERRIDE !== null) T = TOK_OVERRIDE;     // ?tokens= calibration knob
  syncTown();
}
```

`syncTown()` is the single idempotent reconciliation function — call it as often as you
like:

```js
function syncTown() {
  const want = townSize(T);
  for (let n = built + 1; n <= want; n++) spawnQ.push(n);   // queue, never build inline
  built = Math.max(built, want);
  updateProsperity(T);      // may queue promotion waves
  updateMilestones(T);      // §5.6 — fires celebrations, unlocks landmarks
  updateGroves(T);          // §5.8
}
```

**Spawn queue drain — wall clock, never dt-paced:**

```js
const drainRate = q => q > 120 ? q / 1.4 : q > 12 ? 26 : 7;   // buildings per second
```

* **Trickle (1–12 queued)** ~7/s: `easeOutBack` pop from scale 0.01, an 18-particle burst in
  the family colour, `npcs.celebrate(pos, {runners: 2})`. Floaters aggregate — a burst of 5
  reads `+5 houses!` at the centroid, not five overlapping `+1`s. Every 10th building and
  every tier ≥ 5 gets its own named floater (`⭐ Villa!`).
* **Surge (13–120)** 26/s, ordered by plot index so it sweeps outward as a wave; particles
  on every 3rd building only (the pool is 600).
* **Cascade (>120, i.e. init/backfill)** the whole town in **1.4 s flat** regardless of
  count — this is the launch delight moment. Particles suppressed, one centred floater at
  the monument: `✦ Township of 426`. Landmarks unlock silently during the cascade and light
  up together at the end.
* Per frame: at most `ceil(rate * dt)` spawns, hard-capped at 40.

### 5.6 The milestone ladder (core-owned)

```js
const LADDER = [
  { tok:250e3, id:'first_light', title:'🔥 First light',        mon:1, lm:null },
  { tok:1e6,   id:'millionaire', title:'🪙 1M tokens!',         mon:2, lm:'well' },
  { tok:5e6,   id:'windfall',    title:'🌾 5M tokens!',         mon:3, lm:'windmill' },
  { tok:10e6,  id:'market_day',  title:'🎪 10M tokens!',        mon:4, lm:'market_hall' },
  { tok:25e6,  id:'bell',        title:'🔔 25M tokens!',        mon:5, lm:'bell_tower' },
  { tok:50e6,  id:'arcane',      title:'🔮 50M tokens!',        mon:6, lm:'wizard_tower' },
  { tok:100e6, id:'cathedral',   title:'🏆 100M tokens!',       mon:7, lm:'cathedral' },
  { tok:250e6, id:'gilded',      title:'🗿 250M tokens!',       mon:8, lm:'golden_statue' },
  { tok:500e6, id:'scholar',     title:'🔭 500M tokens!',       mon:8, lm:'observatory' },
  { tok:1e9,   id:'skygate',     title:'🌌 1 BILLION tokens',   mon:9, lm:'skygate' }
];
```

Plus, past 1B: a **tick** event every 100M (a 20-particle gold burst at the coin + a
`+100M` floater, no geometry) so a 2B day stays alive.

**Firing rules.** Crossings fire in ascending order **900 ms apart** off a wall-clock queue.
If more than 3 are pending, apply every monument tier and every landmark instantly and play
**one** show for the highest, titled `🏆 100M tokens! (+3 milestones)`. On `init`, seed
everything already passed with **zero FX** (no fireworks spam when you open the app at 4 pm
on a 400M day).

**A celebration** (2.2 s, orchestrated by `town.js`):

```
t=0.00  monument.setTier(m.mon);  monument.celebrate(m.title, GOLD_HI)
        burst3d(monument.getCoinPos(), 0xF3D07A, 70, 11)
        floatText(coinPos + y2.4, m.title, '#F3D07A')
        npcs.celebrate(monumentPos, {milestone:true, runners:8, cheerRadius:999})
t=0.15  if (!userDist) dist *= .965, springs back over 1.2 s
t=0.20→1.60  four fireworks 350 ms apart at random points, radius rand(.45,.95)*outerR,
        y = rand(14,22): burst3d(p, i%2 ? 0xF3D07A : ctx.dominantColor, 55, 9)
t=0.60  the landmark rises from y = -hTop to 0 over 0.9 s with easeOutBack, wrapped in a
        scaffold for 2.5 s, then a 24-particle dust burst at its base
t=2.20  done
```

**Progress to the next rung** is **logarithmic between neighbouring rungs**
(`log(T/prev) / log(next/prev)`) so the bar is never stuck at 4 % for an hour:
`monument.setNext(next.tok, p01, 'NEXT ' + fmtTok(next.tok))`.

### 5.7 Resolved conflicts (architect's decisions — final)

1. **Population curve** — the **NPC layer owns it**. `town.js` calls
   `npcs.setBuildingCount(N)` and publishes nothing about population. The growth doc's
   `0.8·N^0.85` curve is dropped.
2. **Instanced building archetypes** — **CUT**. Buildings stay `THREE.Group`s under the
   uniform contract (hover raycasting, per-building pop animation and tier promotion all
   stay trivial). The perf budget is met instead by `matFor` caching + per-building static
   merge (§2.3), `matrixAutoUpdate = false` after placement, and `castShadow = false`
   beyond ring 4. This is the single biggest de-risking decision in the spec: it removes a
   tight geometry/pool coupling between two different owners.
3. **`milestones.js`** — **CUT**. The ladder and its scheduling live in `town.js`; there
   are exactly four files and four owners.
4. **Landmark placement** — reserved plots (§5.2), **not** a separate civic ring at
   R = 15.6 (which collides with ring-0 houses). Landmarks are **not** counted in `N`.
5. **Mediation** — `town.js` is the only mediator. `monument.onCelebrate` / `onPulse`
   callbacks are dropped; `town.js` calls `npcs.celebrate` / `npcs.pulse` itself. The one
   direct wire is `cfg.attractor = () => monument.getAttractor()`.
6. **Benches** move from `R = PLAZA_R - 3.4` (8.6) to **`R = 10.6`** so they clear the
   worship arcs at 6.4 / 7.9 / 9.3. Core change, one line.
7. **Cut for scope**: instanced archetypes, the 1B aurora, the Colossus landmarks, the
   observatory dome tracking the real sun, and the obelisk-gnomon shadow. Everything else
   in the three design docs ships.

### 5.8 Fate of the existing metaphors

* **Clock face → growth rings.** `plotPos` is unchanged; rings still fill clockwise from
  noon in creation order. Inner rings are the morning, the edge is right now. The tooltip
  carries `settled 14:22`.
* **Idle trees → verge groves.** Trees no longer consume building plots (plots are *earned*).
  ≥ 10 min with no token growth plants a tree on the verge band
  (`R = R0 + ring*RGAP + 4.6`) at the angle of the last settled plot; each further idle
  interval thickens the *same* grove up to 6 trees rather than starting a new one. The grove
  keeps `start`/`end` for its tooltip. The `break 🌳` legend chip stays.
* **Scaffolding → the next-building progress meter.** It stands alone on plot `N+1` — the
  plot you are currently paying for — with a vertical bar filling
  `(T - tokensFor(N)) / costOf(N+1)`. Always visible, always moving; the one reward channel
  that can never stall. On completion it flashes, the building pops in, and the scaffold
  teleports to the new `N+1`. Two ghost scaffolds sit on `N+2`/`N+3` at 25 % opacity
  (`setGhost(true)`).

### 5.9 Tooltips (3 lines — `#tip` gains a `.t3`)

| target | line 1 | line 2 | line 3 |
|---|---|---|---|
| house | `Villa · Opus` | `#214 of 426 · settled 14:22` | `Opus: 402.1M today (38%)` |
| flavour | `Bakery · Sonnet` | `#88 of 426 · settled 11:03` | `Sonnet: 91.2M today (9%)` |
| landmark | `Cathedral 🏛` | `unlocked at 100M · 14:22` | `landmark 6 of 9` |
| grove | `break 🌳` | `10:15 → 10:45 · 30 min` | `no tokens burned` |
| scaffold | `next building` | `#427 · 62%` | `2.4M tokens to go` |
| monument | `The Token Altar` | `842.7M tokens today` | `next: Sky-Gate at 1B — 84%` |

### 5.10 Stats footer (500 ms wall-clock timer, as today)

```
[ 842.7M tokens today ]   🏘 271 buildings  ▮Fable 118 ▮Opus 96 ▮Sonnet 44 ▮Haiku 13
🧍 78 villagers   ⛏ next building 62%   ✦ next: Sky-Gate Arch at 1B — 84%
Prosperity IV · grandest: Keep   🌳 3 breaks   since 08:12
```

The **total is the hero**: ~22 px, `tabular-nums`, tinted `ctx.dominantCss`, with a brief
flash on every increase. Family chips count buildings *owned* (which by §5.4 equals the
family's token share). `Prosperity I–VII` is `floor(L)+1` in roman numerals. `— demo data`
suffix retained in demo mode.

`fmtTok` gains a billions branch:

```js
const fmtTok = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M'
                  : n >= 1e3 ? Math.round(n/1e3)+'k' : ''+Math.round(n);
```

### 5.11 Init, restart, day rollover

* `init`: fold `msg.buckets` into `cell`/`F`, compute `T`, seed milestones with zero FX,
  then run the **cascade**. Because attribution is deterministic, a mid-day restart rebuilds
  the identical town.
* Day rollover — **the only sanctioned reset**: an `init` whose `sessionStartMs` is newer
  than the current one, or a fresh `cell` whose `T` is < 25 % of `Tfloor`. Play a 2 s
  fade-out, clear everything (`monument.reset()`, dispose all groups, clear `cell`/`F`/
  `spent`/`built`), and cascade the new (tiny) town.

---

## 6. `town.js` INTEGRATION POINTS (owner: **core**)

### 6.1 Constants that must be hoisted

```js
const SPOKE_N = 6, SPOKE_A0 = -Math.PI / 2 + .3;
```

Today the spoke angle `+.3` is an inline literal inside `makeRoadTexture`. **Hoist it and
use it in both `makeRoadTexture` and the NPC cfg** — if they disagree, every villager walks
on grass.

### 6.2 Bug fix required before anything else

Demo mode is **currently broken**: module evaluation reaches the demo
`onData({type:'init'})` call, which runs `applyInit → refreshFraming`, which reads
`userDist` before its `let` at line ~738 →
`Uncaught ReferenceError: Cannot access 'userDist' before initialization`. The packaged app
is unaffected (`applyInit` runs later via IPC), so this only breaks the standalone/browser
path the project must keep working.

**Fix:** hoist `const target = new THREE.Vector3(0,3,0);` and
`let az, pol, dist, idleT, userDist` (and `refreshFraming`/`applyCam` if needed) above the
session-state and data-feed sections.

### 6.3 Init order

```js
import { /* everything in §2.2 */ } from './buildings.js';
import { initMonument } from './monument.js';
import { initNPCs, popForBuildings, NPC_CAP } from './npcs.js';

// after the scene / ground / lamps / benches exist, before the data feed:
const monument = initMonument(scene, { plazaR: PLAZA_R,
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
const npcs = initNPCs(scene, {
  roadR, plazaR: PLAZA_R, monument: monument.group.position, monumentR: monument.radius,
  spokes: { n: SPOKE_N, a0: SPOKE_A0 },
  rings: () => Math.max(0, groundRings),
  getBuildings: () => buildingsForNPCs(),        // cached array, rebuilt on spawn/remove
  attractor: () => monument.getAttractor(),
  cap: NPC_CAP
});
```

The old `fountain` group is **deleted** — `monument.js` owns the plaza centre.

### 6.4 `tick(now)` order

```
1.  dt, simNow, day/night, sun/moon/sky/fog/stars/lamps          (unchanged)
2.  drainSpawnQueue(now)        wall clock — may call npcs.celebrate + burst3d + floatText
3.  drainPromotionQueue(now)    wall clock, 10/s
4.  drainMilestoneQueue(now)    wall clock, 900 ms apart — the §5.6 choreography
5.  updateCtx()                 fill the single shared ctx object in place
6.  monument.setTotal(T); monument.setNext(...); monument.update(dt, now, ctx)
7.  npcs.setBuildingCount(N); npcs.update(dt, now, ctx)
8.  building loops (type-agnostic, never branch on kind):
      winMats  → m.emissiveIntensity = night * 1.4 + .04
      glow     → m.emissiveIntensity = lerp(day, night, ctx.night)
      spin     → obj.rotation[axis] = phase + now * rate
      sway     → obj.rotation[axis] = amp * Math.sin(now / period)
      smoke    → if (now - a.last > a.every) { a.last = now; puff3d(a.world, a.size); }
      popT / bumpT easing                                          (unchanged)
9.  scaffold: position on plot N+1, setHeight, setProgress; ghosts on N+2/N+3
10. stepParts(dt); stepPuffs(dt); floaters                         (unchanged + puff pool)
11. camera idle-spin, celebration dolly, applyCam()                (unchanged)
12. hover raycast → 3-line tooltip                                 (§5.9)
13. 500 ms stats footer                                            (§5.10)
14. renderer.render(scene, camera)
```

### 6.5 Events — who fires what

| event | fired by | calls |
|---|---|---|
| a building materialises | `drainSpawnQueue` | `burst3d`, `floatText`, `npcs.celebrate(pos,{runners:2})` (trickle only) |
| a batch of buildings lands | `drainSpawnQueue` | one aggregated floater at the centroid |
| tokens increased this poll | `applyBuckets` | `monument.pulse()`, `npcs.pulse()` |
| a milestone crosses | `drainMilestoneQueue` | `monument.setTier`, `monument.celebrate`, `npcs.celebrate({milestone:true})`, landmark placement, fireworks |
| tier promotion wave | `drainPromotionQueue` | rebuild the group, dust `burst3d` |
| day rollover | `applyInit` | `monument.reset()`, dispose all, cascade |

`onBuildingsAdded(n, positions)` and `onMilestone(m)` are **internal core functions**, not
module callbacks — no module subscribes to `town.js`.

### 6.6 New particle pool (core)

Alongside `parts`, add a second `Points` pool for chimney smoke, because `PointsMaterial.size`
is global and smoke wants to be big, slow and gravity-free:

```js
const MAXPUFF = 96;   // size .9, color 0xB9B4A8, opacity .42, transparent, depthWrite:false
puff3d(worldV, size)  // life 2.2–3.4 s, vy +0.55, slight outward drift + wind (0.25, 0, 0.1)
```

Convert each `userData.smoke` anchor to world space **once at mount** (buildings never move).

### 6.7 `index.html` changes (core)

* `#tip` gains a third line: `<div class="t3"></div>` with a muted colour.
* `footer#stats` gains a hero-number span: ~22 px, `font-variant-numeric: tabular-nums`,
  bold, with a `.flash` class the core toggles briefly on every increase.
* Everything else stays: `#legend`, `#sunTxt`, `#clock`, `#overlay`, `.floater`, `#hint`,
  `#banner`.
* **No new HTML element for the monument counter** — it is 3D geometry (§3.1).

### 6.8 URL knobs (core)

| param | effect |
|---|---|
| `?hour=N` | existing day/night override |
| `?tokens=1e9` | force `T` to an exact value, in **all** modes — the calibration knob |
| `?still=1` | freeze the total (no live demo feed) → deterministic screenshots |
| `?demo=slow\|fast` | demo feed cadence |

### 6.9 Demo mode (core)

Must exercise the whole range and look impressive in a screenshot:

* **Backfill**: a ~140M-token day across ~90 buckets, four families with realistic shares
  (Fable 45 %, Opus 30 %, Sonnet 18 %, Haiku 7 %) and two idle gaps → ~200 buildings, 6
  rings, landmarks up to Cathedral, all arriving in the 1.4 s cascade.
* **Live**: every 2.2 s add a heavy-tailed burst `1e5 + Math.pow(Math.random(),3) * 4e7` to
  a random family. Most ticks give 1–3 buildings; roughly one in fifteen erupts with 15+ and
  crosses a milestone.

---

## 7. INVARIANTS (all four implementers)

1. **Demo mode works with no preload bridge.** Opening `index.html` in a plain browser must
   render a full, growing town. This is the standalone development path — do not break it,
   and fix the `userDist` TDZ bug that currently breaks it (§6.2).
2. **A headless screenshot after 8 s at ~3 fps shows a fully populated town.** Everything
   about *existence* — buildings spawned, villagers present, worship in progress, the
   counter's value, blade angles, smoke — is driven by `performance.now()`, never by
   accumulated `dt`. Only continuous motion (gait, travel, particle physics, decorative
   spin) may use `dt`.
3. **The monument counter is 3D**, never an HTML overlay.
4. **r155 light scaling.** Directional/hemisphere intensities are ~×π vs old demo values
   (`const LI = Math.PI`); point lights are physical candela. Do not add lights beyond the
   existing plaza lamps + the one wizard-tower light.
5. **No new dependencies. No new files under `town/`.**
6. **Perf budget: 300+ buildings and the full 160 villagers at 60 fps on a mid GPU.**
7. **Systems that must survive unchanged in behaviour**: camera orbit + drag + wheel zoom +
   dbl-click reframe + idle auto-spin, `refreshFraming` auto-framing and shadow-camera
   sizing, the day/night solar clock and gradient sky dome, hover tooltips, road texture
   regeneration on ring growth, the particle pool + floaters, the error banner
   (`window.addEventListener('error', …)` — it is the only way a headless run reports a
   crash), the legend, and `window.__tick` manual stepping.
8. **Never open a visible window.** Verification is offscreen only:

   ```powershell
   cd <repo>/town
   npx electron . --shot=<ABS scratchpad path>.png --shot-delay=8000 --hour=13
   npx electron . --shot=<ABS scratchpad path>.png --shot-delay=8000 --hour=23
   Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
   ```

   PowerShell 5.1: use `;`, never `&&`.

---

## 8. ASSEMBLY & ACCEPTANCE

The three module owners cannot screenshot the real app until all four land — build to the
contract, keep your module import-safe and no-throw at `N = 0`, and verify in an isolated
scratchpad harness if you want visual confirmation. The orchestrator runs the assembly shot.

Acceptance checklist for the assembled town:

- [ ] Day shot (`--hour=13`): ≥ 150 buildings, 4+ tiers visible, at least one flavour
      building and one landmark, ≥ 40 villagers, a congregation at the altar, the counter
      legible and showing the true total, at least one chimney smoking, the scaffold meter
      standing on the frontier.
- [ ] Night shot (`--hour=23`): windows and braziers lit, beacon visible without washing out
      the sky, lantern carriers casting warm pools, fewer villagers outdoors.
- [ ] `?tokens=1e9&still=1`: ~426 buildings, 9 rings, monument at tier 9, sky glyph present,
      framing fits, no error banner.
- [ ] `?tokens=5e6&still=1`: ~58 buildings, 3 rings, monument at tier 3, Windmill standing.
- [ ] Plain-browser load: no console error, town grows.
- [ ] No error banner in any shot.
