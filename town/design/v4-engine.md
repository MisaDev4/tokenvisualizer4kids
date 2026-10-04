# Token Town v4 — ENGINE & PERFORMANCE ARCHITECTURE

*The headroom every other v4 feature will spend.*

Written from a full read of `town.js` (2158 lines), `buildings.js` (1464), `environs.js` (1663),
`npcs.js` (802), `layout.js` (1303), `monument.js` (1472), `main.js`, `index.html`, and
`REDESIGN-V3.md` §4.7 / §6.2 / §6.4 / §11.6. **No file was written, no process was run** — every
number below is derived by static analysis and is explicitly labelled as an estimate until the
bench harness (E5) measures it. Building E5 first is the single most load-bearing scheduling
decision in this document.

---

## 0 · TL;DR — the ranked plan

| # | Item | Rank | Size | Files touched | Wins |
|---|---|---|---|---|---|
| **E5** | `--bench` headless perf harness | **MUST** | M | `main.js`, **new `bench.js`**, `town.js`(6 lines), `package.json`, `README.md` | nothing is verifiable without it |
| **E2** | Road plate stops being a 30 ms stall | **MUST** | S | `layout.js`, `town.js` | ~250 ms off the founding cascade |
| **E-CORE** | town.js micro-pass (E3/E4/E7/E8) | **MUST** | M | `town.js`, `npcs.js`(1 fn) | ~2–4 ms/frame at 1200 |
| **E-FURN** | Lamps / trees / benches → instanced | **MUST** | S | `town.js` | −360 draw calls |
| **E1** | Impostor LOD — "the far town" | **MUST** | M–L | **new `lod.js`**, `buildings.js`, `town.js` | −4 500 draw calls, −450 k tris at the cap |
| **E6** | Shadow budget | SHOULD | S | `town.js` | ~1.6 depth passes/s reclaimed |
| **E-TPL** | Merge-template cache | SHOULD | M | `buildings.js` only | 6–10× faster cascade mount |
| **E11** | NPC LOD (freeze + drop parts) | SHOULD | S | `npcs.js` only | unlocks a 400-villager lifesim |
| **E9** | Road plate annulus clipping | SHOULD | M | `layout.js`, `town.js` | removes the last cascade stall |
| **E12** | Dispose / memory audit + leak bench | SHOULD | S | `town.js`, `buildings.js`, `bench.js` | multi-day tray-app safety |
| **E10** | Chunk batching (zoomed-in case) | COULD | L | **new `batch.js`**, `town.js` | −400 draws when zoomed |
| **E13** | GPU-native town (per-instance palettes) | COULD | L | `buildings.js`, `lod.js` | the endgame: ~40 draws at FULL detail |
| **E14** | Canvas texture atlas | COULD | M | **new `atlas.js`** + consumers | only if `info.memory.textures > 24` |

**Build order:** `E5` → (`E2` ‖ `E-FURN` ‖ `E-TPL` ‖ `E11`) → `E-CORE` → `E1` → (`E6` ‖ `E9` ‖ `E12`).
`E-CORE` and `E1` both own `town.js`; they must go to the **same agent, in that order**.

**Prerequisites for the other fleets:** weather needs `E1` + `E7`(in E-CORE) and must obey §2.3;
lifesim needs `E11` + `E8`(in E-CORE); lookdev needs `E6` and must obey §2.2.

---

## 1 · Where the frames go today

### 1.1 The draw-call census (static analysis — E5 replaces this table)

`mergeStatic()` buckets a building's meshes by
`` `s|${roughness}|${metalness}|${side}|${flatShading}` + castShadow + receiveShadow ``, with
emissive materials bucketed by material *identity*. For a house that resolves to:

| bucket | contents | draws |
|---|---|---|
| `s\|0.85\|0\|0\|0` | body, roof, chimney, door, trim, stone, window frames — **everything matte** | 1 |
| `e<id>` (shared `winCache` material) | lit panes | 1 |
| `s\|0.25\|0.1\|0\|0` | unlit `GLASS_OFF` panes | 1 (or singletons if < 2) |
| `keep()`ed | pennant (tier 7), windmill hub, tavern sign, farm crops, well bucket | 0–2 |

**≈ 3.3 draws per house, ≈ 4 for a tier-7 keep.** At the 1200 cap (where §4.2 of the v3 spec says
*every* house is tier 7) that is ~4 800.

Everything else, counted from the code:

| source | mechanism | draws @ 1200 |
|---|---|---|
| houses | 1200 × ~4 | **4 800** |
| grove trees | `buildTree` is `finish(…, noMerge=true)`; ≤ 14 groves × 6 trees × **3 meshes each, all sharing `GEO.trunk/leafA/leafB` + `MAT.trunk/leafA/leafB`** | **252** |
| street lamps | 26 road + 6 plaza, each pole + bulb(cloned mat) + additive pool | **102** |
| scaffolds | `meterScaf` + 2 ghosts, `noMerge=true`, ~22 meshes each | **66** |
| landmarks | 9 × ~5 | 45 |
| benches | 4 × 4 | 16 |
| bridges | ≤ 4 × ~4 | 16 |
| monument | v3 spec ceiling | ≤ 21 |
| environs | v3 spec ceiling (§6.2) | 8 |
| sky (dome, 2 star `Points`, sun ball, halo) | | 5 |
| npcs | 6 InstancedMeshes | 6 |
| road plate, verge ×2, particles ×2, signpost | | 10 |
| | | **≈ 5 350** |

At the user's **real 454-building day**: ≈ **2 000 draw calls**. On an integrated GPU three's
`WebGLRenderer` state machine costs roughly 4–8 µs per draw when program and material are shared
and only the VAO + `modelViewMatrix` change — so **~10–20 ms of pure CPU at 454, ~25–45 ms at 1200**,
before any of the JS below.

The three lines that cost the most for the least value are `buildTree`, the street lamps and the
grove: **352 draw calls that could be 6.**

### 1.2 The scene-graph tax

At 1200 buildings the graph holds ~1200 `Group`s + ~3 600 merged `Mesh`es + ~250 tree meshes +
~100 lamp meshes ≈ **5 200 `Object3D`s**. Every `renderer.render()`:

* `scene.updateMatrixWorld()` recurses **every** node — `matrixAutoUpdate = false` (set by
  `freezeStatic`) skips the *compose*, not the *visit*. ~5 200 visits.
* `projectObject()` recurses again, frustum-testing every mesh and pushing to the render list.
* On shadow-armed frames (currently ~2/s), `WebGLShadowMap.render` walks it a **third** time.

Estimated **0.6–1.4 ms/frame of pure traversal at the cap**, paid even on a frame where nothing
moved. This is why the fix is *detach*, not *hide* (§3.5).

### 1.3 The per-frame loops in `tick()`

```js
for (const e of animEnts) {           // town.js:1991 — 1200+ entities at the cap
  if (u.winMats) for (const m of u.winMats) m.emissiveIntensity = winI;   // ← same shared
  if (u.glow)  …                                                          //   material, 1200×
  if (u.pointLights) …
  if (u.spin) … if (u.sway) … if (u.smoke) …
  … popT / bumpT / matrixAutoUpdate bookkeeping …
}
```
`winMats` holds **one shared material town-wide** (`winCache`), so 1200 iterations write the same
float 1200 times. `spin`/`sway`/`smoke` are non-empty on maybe 1 entity in 6. `popT`/`bumpT` are
`1` on ~1199 of 1200. Estimated **0.5–1.2 ms of pure waste per frame**.

Two more per-frame or near-per-frame offenders:

* `ray.intersectObjects(hitTargets, true)` at 20 Hz over **1200 groups / ~4 800 meshes** whenever
  the pointer is over the canvas (`town.js:2044`). Recursive raycast, world-space sphere test per
  mesh. **~1–2 ms every 50 ms.**
* `updateProsperity()` (`town.js:1036`) walks all 1200 houses whenever `pband` changes or the
  frontier moves ≥ 4 — which is **every drain frame during a founding cascade** — calling
  `tierOfPlot` → `seededR` (a `Math.sin`) per house. ~0.5 ms × ~40 cascade frames.

### 1.4 The founding cascade — the worst second in the product

`drainSpawnQueue` mounts up to **420 buildings in one frame** (`town.js:946`). Each mount runs:

`buildHouse()` → ~25 `new THREE.Mesh` + `finish()` traversal → `mergeStatic()` → `concatMeshes()`,
which for each bucket allocates **4 typed arrays** and runs a per-vertex
`Vector3.applyMatrix4` + `applyMatrix3` + `normalize`.

At the cap that is ~3 600 `BufferGeometry` allocations and ~800 k vertex transforms, plus
`freezeStatic` traversals, plus `tagEnt` traversals (`g.traverse` over every node, twice).

Layered on top, in the *same* frames:

* `refreshFraming()` → `updateRoads(band)` → **`plan.paintGround()` on a 2048² canvas**. The band
  goes 0 → 9 across a 1200-house cascade, so this fires ~10 times. Each call strokes ~1 000 edges
  twice, draws ~1 200 plot aprons (a stroke *and* an arc fill each), and then — the killer —
  **26 000 `fillRect` calls** for the wear speckle (`layout.js:1181`). Estimated **25–60 ms per
  repaint**, i.e. **250–600 ms of blocked main thread inside the cascade.**
* `env.setExtent()` → `repark()` → 1500 flora + 320 field + 900 blade matrix composes. Already
  hysteresis-guarded to ~10 calls (`environs.js:1527`), good.

The long comment at `town.js:938-945` ("*An 11 s capture of `range=all` was empty grass under a
footer reading 1200 buildings*") is this exact stall. The 420-per-frame cap treats the symptom;
**E2 + E-TPL treat the cause.**

### 1.5 What is already excellent (do not "optimise" it)

* **`environs.js`** — the entire countryside is 8 draw calls, 5 materials, 4 textures, with all
  motion in vertex shaders off one `uTime` (§6.2 of the v3 spec, honoured). The fade, the reach
  profile and the weather are uniform writes. **Leave it alone.** It is the model for how weather
  should be built.
* **`npcs.js`** — 160 villagers in 6 draw calls with hand-composed matrices, colours uploaded only
  on index change, `frustumCulled = false` (correct: instance spread ≫ geometry bounds).
* **`matFor()` / `mergedMat()` / `winCache`** — the material caches. A whole town lives on ~60–80
  materials. This is the invariant everything else in this document is built on.
* **`monument.js`** — ≤ 21 draws at tier 10, instance-parked furniture, wall-clock particles.
* **`renderer.shadowMap.autoUpdate = false`** with explicit re-arming. Right idea; E6 only tightens
  the re-arm rule.

---

## 2 · The engine contract

Three invariants. Every v4 fleet must be handed these, and `E5` should fail a build that breaks
them.

### 2.1 One material family, or one draw call per building

Any new *matte* surface on a building must use `matFor(hex, kind)` with a `KIND` whose
`{roughness, metalness, side, flatShading}` tuple **already exists**. A new tuple creates a new
merge bucket, which costs **one extra draw call per building** — +1 200 at the cap. If a new
lighting response is genuinely needed, add it to `KIND` *and* accept that it is a global +1 200,
or `keep()` it and hand it to an InstancedMesh.

### 2.2 Colour goes in vertex colours, never in materials

`mergeStatic` folds `material.color` into a vertex-colour attribute. Anything that wants
per-building colour variety gets it for free. Anything that wants a per-building *texture* or a
per-building *emissive* breaks the merge. (`winCache` is the sanctioned exception — one shared
emissive material town-wide, driven by one float.)

### 2.3 Motion is either GPU-parametric or wall-clock CPU — never per-object dt

* Anything with **more than ~200 instances** must animate in the vertex shader off `uTime`
  (`environs.js`'s `dressInstanced` is the reference implementation). **Weather rain/snow must be
  built this way** — the CPU particle pools in `town.js` (`MAXP = 600`, `MAXPUFF = 96`) are for
  ceremony, not weather, and must not be extended.
* Anything a headless screenshot must show stays on `performance.now()` (already the house rule).

---

## 3 · The work items

### E5 · The headless perf harness — `--bench` — MUST, M

**Files:** `src/main.js`, **new `src/renderer/bench.js`**, `src/renderer/town.js` (≈ 6 lines),
`package.json`, `README.md`.
**Prerequisite for:** everything. Build it first.

#### 3.0.1 Invocation

```powershell
# one scene
npx electron . --bench --bench-scene=s1200

# the whole suite, JSON + reference PNGs, non-zero exit on budget failure
npx electron . --bench --bench-scene=all --bench-json=bench.json --bench-shot=.\bench-shots

# tune
npx electron . --bench --bench-scene=s600 --bench-frames=900 --bench-warmup=180 --bench-size=1920x1080
```

The window is created exactly the way `--shot` already creates it — `show:false`,
`skipTaskbar:true`, `paintWhenInitiallyHidden:true`, `backgroundThrottling:false` — which is
already proven not to appear on the user's screen. **Never add a visible-window bench path.**

#### 3.0.2 `main.js` changes

```js
const isBench = process.argv.includes('--bench');
// vsync pins every frame to 16.7 ms and hides all throughput signal. Off, for bench only.
if (isBench) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
const isShotRun = process.argv.some(a => a.startsWith('--shot=')) || isBench;   // ← no single-instance lock
const headless  = !!shotPath || isBench;
```
Forward to the page query: `bench`, `bench-scene`, `bench-frames`, `bench-warmup`, `bench-shot`
(as a boolean; the file write stays in main), plus the existing `hour/tokens/still/demo/feed/range/seed/intro`.

`main.js` already listens on `webContents.on('console-message', …)` for shot runs. Widen it:

```js
win.webContents.on('console-message', (_e, level, message) => {
  if (message.startsWith('TOWNBENCH ')) { results.push(JSON.parse(message.slice(10))); return; }
  if (message === 'TOWNBENCH_DONE') return finishBench();      // writes JSON, sets exitCode, quits
  if (level >= 2) console.error('[page]', message);
});
```
`finishBench()`: pretty-prints a table to stdout, writes `--bench-json` if given, calls
`app.exit(results.every(r => r.pass) ? 0 : 1)`. A **hard 180 s watchdog** quits with code 2 so a
hung run can never leave a stray process.

For `--bench-shot`, after the last scene's samples land the page emits `TOWNBENCH_SHOT <scene>`;
main calls `capturePage()` and writes `<dir>/<scene>.png`. That makes the bench a **visual
regression tool as well**, which is what makes the E1 LOD switch safe to land.

#### 3.0.3 `bench.js` — the whole module

```js
/**
 * Offscreen frame-time / draw-call sampler. Zero cost when ?bench is absent —
 * town.js must not import anything from here on the normal path.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {URLSearchParams} q
 * @returns {{sample:(now:number, t0:number, town:TownSample)=>void, scene:BenchScene}}
 */
export function initBench(renderer, q) { … }

/** @typedef {{tokens:number, hour:number, cam:?[number,number,number],
 *             intro:0|1, measure:'steady'|'founding'|'epochs'}} BenchScene */

/** @typedef {{buildings:number, villagers:number, lod:'A'|'B',
 *             hot:number, impostors:number, spawnQ:number}} TownSample */
```

Scene table (token totals inverted from `townSize(T) = floor(32·(T/1e6)^(3/8))`, i.e.
`T = 1e6·(N/32)^(8/3)`):

```js
export const BENCH_SCENES = {
  s200:   { tokens: 1.33e8,   hour: 13, cam: null,             intro: 0, measure: 'steady'   },
  s600:   { tokens: 2.48e9,   hour: 13, cam: null,             intro: 0, measure: 'steady'   },
  s1200:  { tokens: 1.576e10, hour: 13, cam: null,             intro: 0, measure: 'steady'   },
  n1200:  { tokens: 1.576e10, hour: 23, cam: null,             intro: 0, measure: 'steady'   },
  z1200:  { tokens: 1.576e10, hour: 13, cam: [0.62, 0.40, 40], intro: 0, measure: 'steady'   },
  found:  { tokens: 1.576e10, hour: 13, cam: null,             intro: 1, measure: 'founding' },
  epochs: { tokens: 2.48e9,   hour: 13, cam: null,             intro: 0, measure: 'epochs'   }
};
```

`--bench` forces `feed=demo&still=1&seed=0x5EED` and pins the orbit (`idleT` frozen, `userDist`
true, `az/pol/dist` from `cam` or from `refreshFraming` once). Determinism matters more than
realism: two runs of the same commit must agree to within the noise floor.

#### 3.0.4 `town.js` hook — the entire diff

```js
const BENCH_ON = Q.get('bench') !== null;
let bench = null;
if (BENCH_ON) { const m = await import('./bench.js'); bench = m.initBench(renderer, Q); }
// …
function tick(now) {
  const t0 = BENCH_ON ? performance.now() : 0;
  /* …existing body, unchanged, ending in renderer.render(scene, camera)… */
  if (bench) bench.sample(now, t0, {
    buildings: houses.length, villagers: npcs.count,
    lod: lod ? lod.mode : 'B', hot: lod ? lod.hotCount : houses.length,
    impostors: lod ? lod.activeCount : 0, spawnQ: spawnQ.length
  });
}
```

`renderer.info.autoReset` is `true`, so `info.render.*` must be read **immediately after
`render()`** — which is where `sample()` sits. Three counts the shadow depth pass inside
`render()`, so report the **mode** of `calls` (the ~58 frames in 60 with no shadow re-arm) as
`draw.calls` and the **max** as `draw.callsShadow`; conflating them makes the number jump by
hundreds and unusable as a budget.

#### 3.0.5 Output

One line per scene, `console.log`ed so the existing main-process listener picks it up:

```
TOWNBENCH {"v":1,"scene":"s1200","size":"1380x880","frames":600,"warmup":120,
  "cpuMs":  {"p50":5.8,"p90":7.2,"p99":11.4,"max":34.1,"mean":6.1},
  "frameMs":{"p50":6.9,"p90":8.4,"p99":13.0,"max":36.2},
  "draw":{"calls":287,"callsShadow":394,"triangles":248113,"points":1840},
  "mem":{"geometries":412,"textures":19,"programs":24,"jsHeapMB":86.4},
  "town":{"buildings":1200,"villagers":160,"lod":"A","hot":0,"impostors":1200},
  "budget":{"calls":300,"trianglesK":300,"cpuP50":6.0,"cpuP99":12.0},
  "pass":true,"fail":[]}
```

* `cpuMs` = `performance.now()` at the end of `tick` minus `t0`. **This is the number that
  matters** — three.js draw-call overhead is CPU-side, and it is the only figure independent of
  the GPU in the machine.
* `frameMs` = the rAF interval, meaningful only because vsync is off.
* percentile: `sorted[Math.floor(p/100 * (n-1))]` over the post-warmup ring buffer.
* `pass` = every budget met; `fail` names the metrics that missed, e.g. `["draw.calls 512>300"]`.

`measure:'founding'` reports instead:
```json
"founding":{"settleMs":3410,"maxFrameMs":78,"framesOver50":3,"framesOver100":0,
            "buildingsAt3s":1200,"paintGroundCalls":10,"paintGroundMs":214}
```
(`paintGround*` come from a counter town.js already has the hooks for; add two `+=` in
`updateRoads`, guarded by `BENCH_ON`.)

`measure:'epochs'` (the leak bench) synthesises 20 `init` messages with fresh `epochId`s, letting
each settle for 40 frames, and reports `memory.geometries/textures` + `jsHeapMB` after each cycle.
**Pass = post-settle `geometries` grows by ≤ 5 across 20 cycles.** See §5.

#### Acceptance
`npx electron . --bench --bench-scene=all` completes in < 90 s, prints 7 lines, leaves no
`electron.exe` behind, and never puts a window on screen. Run it once on the current tree and
**paste the output into this document as the pre-v4 baseline** — every target below is then a
ratio, not a guess.

---

### E2 · The road plate stops being a stall — MUST, S

**Files:** `layout.js` (`paintGround`), `town.js` (`roadMat`, `updateRoads`).

Three changes, in order of value:

**(a) The wear pass becomes a static tiling texture.** `layout.js:1179-1187` does
`Math.round(26000 * wear)` `fillRect`s under `source-atop` on a 2048² canvas, on **every**
repaint. The pattern is seeded and identical every time. Move it out:

```js
// town.js — built once, never rebuilt, never disposed
const wearTex = makeWearTexture(512);            // seeded speckle, RepeatWrapping, 8×8 repeat
roadMat.customProgramCacheKey = () => 'town-road';
roadMat.onBeforeCompile = s => {
  s.uniforms.uWear = { value: wearTex };
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\n uniform sampler2D uWear;')
    // multiply AFTER the map so the speckle only lands on painted road, exactly
    // like the old source-atop composite
    .replace('#include <map_fragment>', `#include <map_fragment>
      float rw = texture2D(uWear, vMapUv * 8.0).r;
      diffuseColor.rgb *= 0.86 + 0.28 * rw;`);
};
```
`layout.js`: `paintGround` honours `opt.wear === 0` by skipping §8 entirely (the option already
exists and is already threaded through; town.js just starts passing `0`). **Saves 26 000 canvas
ops per repaint** — the single biggest item in the cascade.

**(b) Coalesce repaints.** `updateRoads` is called from `refreshFraming`, which is called from
`drainSpawnQueue` every drain frame. Add:

```js
let roadPending = -1, roadPaintAt = -1e9;
function updateRoads(band) {
  if (band === roadBand && Math.abs(ctx.plazaR - roadPlaza) < .4) return;
  roadPending = band;
  // ≥ 220 ms apart, newest request wins. A plate that is one band stale for a
  // fifth of a second is invisible; a 40 ms stall inside the cascade is not.
  if (performance.now() - roadPaintAt < 220) return;
  flushRoads();
}
function flushRoads() { /* the current body, then */ roadPaintAt = performance.now(); roadPending = -1; }
// drained in tick(): if (roadPending >= 0 && now - roadPaintAt > 220) flushRoads();
```

**(c) Tighten the plot-apron loop.** `layout.js:1152-1163` does a `beginPath/moveTo/lineTo/stroke`
**and** a `beginPath/arc/fill` per plot — 2 400 path submissions at the cap, with `strokeStyle` and
`lineWidth` re-set inside the loop. Hoist both style writes above the loop and batch the footpaths
into **one** path (one `beginPath`, 1 200 `moveTo/lineTo` pairs, one `stroke`). The aprons must
stay individual fills (arcs can't batch under one `fill()` without overlap artefacts) but hoisting
`fillStyle` alone is worth ~15 %.

#### Acceptance
`--bench-scene=found` reports `paintGroundMs` < 60 total (from an estimated 250–600) and
`maxFrameMs` < 90. Visual: `--bench-shot` diff of `s1200` shows the same road wear.

---

### E-CORE · The `town.js` micro-pass — MUST, M

Four independent fixes that all live in `town.js`. **Ship them as one item to one agent** — they
collide with each other and with E1.

#### E3 · Split `animEnts` (S)

`animEnts` is currently "everything with a group", iterated whole every frame. Replace with four
lists maintained at mount/settle time:

```js
const animEnts = [];   // KEEP: teardown + fade only. NEVER iterated per frame.
const entsPop  = [];   // popT < 1 || bumpT < 1 — self-evicting, normally length 0
const entsMove = [];   // has userData.spin || sway  — windmills, flags, signs, well buckets
const entsSmoke= [];   // has userData.smoke        — chimneys
const litMats  = new Set();   // distinct winMat materials — in practice ONE town-wide
const glowSpecs= [];   // {mat, day, night} — taverns and forges
const ptLights = [];   // userData.pointLights
```

`mountEnt` pushes into whichever apply; the `popT`/`bumpT` branch splices itself out of `entsPop`
when it settles (that branch already exists at `town.js:2010`). Per frame:

```js
for (const m of litMats) m.emissiveIntensity = winI;              // 1 write, not 1200
for (const a of glowSpecs) a.mat.emissiveIntensity = a.day + (a.night - a.day) * night;
for (const l of ptLights) l.intensity = 16 * (.12 + night);
for (const e of entsMove) { /* spin + sway */ }
for (const e of entsPop)  { /* pop / bump, splice out on settle */ }
```

**Smoke gets a rotating cursor.** `smokeK = clamp(houses.length/24, 1, 26)` already thins emission
to ~1 puff per chimney per 67 s at the cap, but the *check* still runs on every chimney every
frame. Instead walk 24 chimneys per frame:

```js
let smokeCur = 0;
for (let k = 0; k < 24 && entsSmoke.length; k++) {
  const e = entsSmoke[smokeCur = (smokeCur + 1) % entsSmoke.length];
  for (const a of e.group.userData.smoke)
    if (a.world && now - a.last > a.every) { a.last = now; puff3d(a.world, a.size); }
}
```
…and `smokeK` disappears (the cursor *is* the throttle, and it is frame-rate independent because
`a.every` is wall-clock). **Estimated saving: 0.5–1.2 ms/frame at the cap.**

#### E4 · Analytic hover pick (S)

Delete house groups from `hitTargets`. Replace the 4 800-mesh recursive raycast with a plot hash:

```js
// Rebuilt only on epoch change and on plan.ensureCapacity growth.
// Flat arrays — no Object3D access in the hot path.
let plotX = new Float32Array(0), plotZ = new Float32Array(0), plotTop = new Float32Array(0);
const CELL = 16, cellMap = new Map();          // (gx<<16|gz) → number[] of ordinals

/** Ray → the building under the cursor, or null. ~20 AABB tests, not 4800 spheres. */
function pickBuilding(ray) {
  // 1. where the ray meets y = 0 …
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y >= -1e-4) return null;
  const t0 = -o.y / d.y;
  // 2. …then march the ray's ground track through the hash from t0 back toward the
  //    camera, so a tall Keep in front of a Cottage wins (march near → far instead:
  //    step from t = 6 to t = t0 in 12 steps and take the FIRST AABB hit).
  for (let s = 0; s <= 12; s++) {
    const t = 6 + (t0 - 6) * (s / 12);
    const x = o.x + d.x * t, z = o.z + d.z * t;
    for (const n of candidates(x, z)) {             // the 4 cells around (x,z)
      const e = houses[n - 1]; if (!e || !e.group) continue;
      if (rayHitsBox(ray.ray, plotX[n-1], plotZ[n-1], 2.2, plotTop[n-1])) return e;
    }
  }
  return null;
}
```
`hitTargets` keeps only the ~30 non-house groups (monument, signpost, scaffolds, bridges,
landmarks, grove trees) and the normal raycaster still handles them; `pickBuilding` runs first and
wins on a tie by distance. **This is also a correctness win** — LOD-impostored buildings still
hover, and hovering the *sky* beside a roof no longer reports a hit.

#### E7 · Pool cursors + a floater DOM pool (S)

* `burst3d` (`town.js:537`) and `puff3d` (`town.js:582`) scan the pool from index 0 on every call.
  A milestone fires 5 bursts of 55–70 in one frame → 5 × 600 scans. Add a module-level
  `let pCur = 0` / `let uCur = 0` and scan from there, wrapping once.
* `floatText` creates and destroys a `<div>` per floater. Pool 16 divs, `display:none` when free.
  During a `surge` this is the only DOM churn in the frame.
* `burst3d(e.group.position.clone().setY(.6), …)` allocates a `Vector3` per spawned building in
  `trickle` mode. `_v` scratch already exists at `town.js:1865` — use it (`burst3d` copies out of
  the vector immediately, so a scratch is safe).

#### E8 · Kill the two big allocations (S) — *also touches `npcs.js`*

* `buildingsForNPCs()` rebuilds a **1200-element array of fresh `{pos, yaw}` objects** whenever
  `buildingsDirty` — which is every frame during a cascade. Replace with a flat
  `Float32Array(cap * 3)` of `(x, z, yaw)` plus a count, and change `npcs.js`'s two consumers
  (`randomBuilding`, `goHome`) to index it. `NPCConfig.getBuildings` becomes
  `getBuildings: () => ({ a: Float32Array, n: number })`. One-line change on each side.
* `updateProsperity()` must **early-out during a cascade**:
  ```js
  if (spawnQ.length > 12) return;   // `spawnBuilding` already computes tierOfPlot per house;
                                    // the redevelopment sweep is correct to run once, after.
  ```
  Correctness holds because `syncTown` calls `updateProsperity` again on the next bucket poll,
  and every house's `settled` was computed at spawn from the same `tierOfPlot`.

#### Acceptance
`--bench-scene=s1200` `cpuMs.p50` drops by ≥ 2.0 ms vs baseline with `draw.calls` unchanged;
hover tooltips still name the right building at three zoom levels (`--bench-shot` + manual).

---

### E-FURN · Street furniture goes instanced — MUST, S

**Files:** `town.js` only.

**352 draw calls for 6 draws' worth of content.**

**(a) Grove trees → 3 InstancedMeshes.** `buildTree` already uses *only* shared geometry and
shared materials (`GEO.trunk/leafA/leafB`, `MAT.trunk/leafA/leafB`) with `noMerge = true`, so 84
trees are 252 draws of the same three (geo, mat) pairs. Replace with a trio at capacity
`MAX_GROVES * 6 = 84`:

```js
const treeIM = ['trunk','leafA','leafB'].map(k => {
  const im = new THREE.InstancedMesh(GEO[k], MAT[k], 84);
  im.castShadow = true; im.receiveShadow = true; im.count = 0; im.frustumCulled = false;
  scene.add(im); return im;
});
/** addTree writes one matrix per part; the pop-in animates the matrix, not a Group. */
function setTreeInstance(i, x, z, s, yaw, popScale) { … }
```
`addTree`'s pop-in becomes a matrix rewrite for that index — 3 `setMatrixAt` calls per frame while
`popT < 1`, then never again. Hover: grove trees leave `hitTargets` and join `pickBuilding`'s hash
with `kind:'grove'` (a `groveAt` parallel array), or — simpler and adequate — hover the **grove**
rather than the tree, via one invisible 6-unit `Sphere` proxy per grove (14 proxies, 14 draws
avoided by `visible=false`… `Raycaster` ignores `visible=false`, so use a `Mesh` with a
`MeshBasicMaterial({visible:false})` — three still raycasts it, still doesn't draw it). **252 → 3.**

**(b) Street lamps → 3 InstancedMeshes.** 32 lamps × (pole + bulb + additive pool). The pole and
pool already share geometry and material; the bulb material is `MAT.bulb.clone()` per lamp but
every clone is driven to the *same* value (`town.js:1924`). Share one material, drive it once.
The 6 plaza `PointLight`s stay as loose `Object3D`s. **102 → 3.** `placeRoadLamps` /
`revealLamps` become matrix writes with the existing "park at y = -999" idiom already used by
`revealVerge`.

**(c) Benches → one merged group.** 4 benches × 4 boxes, all `MAT.wood` / `MAT.stoneDark`. Build
them into one `THREE.Group` and run `mergeStatic`-equivalent on it — or simply an InstancedMesh
per part. **16 → 2.**

**(d) Ghost scaffolds → 1 InstancedMesh (optional).** The 2 ghosts are ~22 meshes each and only
communicate "two more plots are coming". Reduce to a single translucent post cage as one instanced
box (8 instances). **44 → 1.** Low priority; skip if it costs charm.

**Total: 370 draws → ~9.**

---

### E1 · Impostor LOD — "the far town" — MUST, M–L

**Files:** **new `src/renderer/lod.js`**, `buildings.js` (~40 lines), `town.js` (~60 lines).
**Depends on:** E-CORE (same file), E5 (to prove it).

#### 3.5.1 Why this works here specifically

The camera **auto-frames the whole town** (`town.js:347`,
`dist = clamp(max(r*(1.32 + .13·clamp(r/112)) + 20, monTop*2.1), 50, 500)`), so building screen
size *shrinks as the town grows*. With a 46° fov at 880 px, a house of height `hTop` subtends
`hTop / dist × 1035` pixels:

| N | `bounds.r` | `dist` | tier-4 `hTop`=4.3 | reads as |
|---|---|---|---|---|
| 200 | ~95 | 145 | **31 px** | roof shape, dormers, chimney |
| 454 (the user's real day) | ~150 | 238 | **19 px** | roof colour, wall colour, a hint of pitch |
| 1200 | ~250 | 382 | **11.6 px** | a coloured block with a darker cap |

`base-day.png` in the scratchpad confirms it: at 454 buildings the houses are coloured blocks with
legible roofs and nothing more. **A box + a roof prism in the right two colours at the right
height is visually indistinguishable below ~20 px** — and it costs 20 triangles instead of ~600,
and *zero* draw calls instead of ~4.

#### 3.5.2 `buildings.js` — declaring the impostor (auto-derived, ~40 lines)

Do **not** hand-write an impostor per tier (that is 1 200 lines of churn and it will rot). Derive
it from the meshes the builders already make, by tagging two helpers:

```js
// mb() gains a role when its kind is a wall kind; mgab/mp/cone4 tag themselves as roofs.
const mb = (w,h,d,hex,kind) => { const m = new THREE.Mesh(GEO.unit, matFor(hex, kind||'wall'));
  m.scale.set(w,h,d); if ((kind||'wall')==='wall') m.userData.role = 1; return m; };   // 1 = body
const mgab = (w,h,d,hex,alongX) => { … m.userData.role = 2; m.userData.rk = 1; … };    // 2 = roof, gable
const mp   = (w,d,h,hex) => { … m.userData.role = 2; m.userData.rk = 2; … };           // pyramid
const cone4= (r,h,hex,kind) => { … m.userData.role = 2; m.userData.rk = 2; … };
const stack= … // the chimney helper in buildHouse already records `chim`; reuse it
```

Then, inside `finish(g, ud)` **before** `mergeStatic` consumes the children:

```js
/** Largest role-1 box → the body; largest role-2 → the roof; `ud.smoke[0].p` → the chimney. */
function deriveImpostor(g, ud) {
  let body = null, bv = 0, roof = null, rv = 0;
  g.traverse(o => {
    if (!o.isMesh || !o.userData.role) return;
    const s = o.scale, v = s.x * s.y * s.z;
    if (o.userData.role === 1 && v > bv) { bv = v; body = o; }
    if (o.userData.role === 2 && v > rv) { rv = v; roof = o; }
  });
  if (!body) return null;
  const c = body.material.color, rc = roof ? roof.material.color : c;
  return {
    w: body.scale.x, d: body.scale.z, h: body.scale.y, y0: body.position.y - body.scale.y / 2,
    rh: roof ? roof.scale.y : 0, rk: roof ? (roof.userData.rk | 0) : 0,
    rw: roof ? roof.scale.x : body.scale.x, rd: roof ? roof.scale.z : body.scale.z,
    ry: roof ? roof.rotation.y : 0, rY: roof ? roof.position.y : body.position.y + body.scale.y / 2,
    wall: c.getHex(), roof: rc.getHex(),
    ch: (ud.smoke && ud.smoke[0]) ? ud.smoke[0].p : null,
    extra: ud.impExtra || null
  };
}
```
`ud.impExtra` is an explicit opt-in for the three silhouettes that *are* the building:

| kind | `impExtra` | why |
|---|---|---|
| `windmill` (flavour **and** landmark) | `{geo:'sails', x:0, y:3.5, z:1.32, s:3.2, color:0xE8DFC8}` | a 4-px cross is the whole joke |
| `market` | `{geo:'awning', x:0, y:2.3, z:0, s:4.3, color:paint.accent}` | the day's accent, on the square |
| `farm` | `{geo:'field', x:0, y:.02, z:.3, s:4.6, color:0x57432C}` | a ploughed rectangle reads at any size |

Nothing else needs one. **Landmarks, bridges and the monument are never impostored.**

#### 3.5.3 `lod.js` — the module

```js
/**
 * The far town. Seven InstancedMeshes hold every settled building's silhouette;
 * instance index === building ordinal - 1, forever, so an LOD flip is a matrix
 * write and never a re-pack.
 *
 * @param {THREE.Scene} scene
 * @param {{cap:number, geo:typeof GEO, matOf:(hex:number,kind:string)=>THREE.Material}} cfg
 * @returns {LodSystem}
 */
export function initLod(scene, cfg)

/**
 * @typedef {Object} LodSystem
 * @property {(i:number, x:number, z:number, yaw:number, s:number, imp:Impostor)=>void} set
 *           Write instance i. Idempotent; call once when a building settles.
 * @property {(i:number, on:boolean)=>void} park   park (true) / show (false) instance i
 * @property {(n:number)=>void} setCount           == built
 * @property {(now:number, ctx:TownCtx, houses:Array)=>('A'|'B')} update
 * @property {'A'|'B'} mode      A = far (coldRoot detached), B = near (per-building)
 * @property {number} hotCount   buildings currently drawn as full groups
 * @property {number} activeCount buildings currently drawn as impostors
 * @property {()=>void} reset    epoch teardown — park everything, count = 0
 * @property {()=>void} dispose
 */
```

Seven InstancedMeshes, each at capacity `LAYOUT.N_CAP = 1200` (except the extras):

| IM | geometry | material | capacity | draws |
|---|---|---|---|---|
| `body` | `BoxGeometry(1,1,1).translate(0,.5,0)` — 12 tris | shared `MeshStandardMaterial({roughness:.85, vertexColors:false})` + `instanceColor` | 1200 | 1 |
| `roofG` | `GEO.gable` — 8 tris | ditto | 1200 | 1 |
| `roofP` | `GEO.pyr` — 6 tris | ditto | 1200 | 1 |
| `chim` | `BoxGeometry(1,1,1)` — 12 tris | ditto | 1200 | 1 |
| `win` | `PlaneGeometry(1,1)` — 2 tris, shared `winCache` emissive | night only | 1200 | 1 |
| `sails` | a 2-quad cross — 4 tris | shared | 64 | 1 |
| `awning` | `PlaneGeometry` — 2 tris | `stripeMat(accent)` | 96 | 1 |

**7 draw calls for the entire distant town, ~24 000 triangles at 1200 buildings.**

Memory: `1200 × 16 floats × 5` matrices + `1200 × 3 × 5` colours ≈ **440 KB**. Nothing.

`castShadow = false` on every impostor IM — see E6. `frustumCulled = false` (the instance spread
covers the whole plat, so a bounding sphere always passes and the test is wasted).

#### 3.5.4 The mode decision

```js
// px of a representative house, from the SAME numbers the camera uses
const K = stage.clientHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
const medPx = 4.3 / Math.max(dist, 1) * K;          // 4.3 = tier-4 hTop, the modal house
// hysteresis: A below 18 px, B above 24 px. Nothing between flips.
if (mode === 'B' && medPx < 18) mode = 'A';
else if (mode === 'A' && medPx > 24) mode = 'B';
```

**Mode A (far)** — `medPx < 18`, i.e. ≥ ~500 buildings at auto-framing, or any wide manual zoom:
```js
scene.remove(coldRoot);              // DETACH, do not hide — see below
lod.setCount(built); lod.unparkAll();
```

**Mode B (near)** — small towns and zoom-ins: `coldRoot` is attached and a **10 Hz** pass decides
per building from a flat array (no `Object3D` reads):

```js
// 1200 iterations at 10 Hz. Six frustum planes + one distance, on Float32Arrays.
for (let i = 0; i < built; i++) {
  const dx = plotX[i] - cam.x, dz = plotZ[i] - cam.z, dy = plotTop[i] * .5 - cam.y;
  const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
  const px = plotTop[i] / d * K;
  const near = px >= 26 && inFrustum(i);      // ← 26 px, hysteresis ±4 handled by lastNear[i]
  if (near !== lastNear[i]) { houses[i].group.visible = near; lod.park(i, near); lastNear[i] = near; }
}
```
Because this pass owns visibility, set `frustumCulled = false` on every house group as well —
three's own per-mesh sphere test then disappears from `projectObject` for ~4 800 meshes.

#### 3.5.5 DETACH, do not hide — the subtlety that makes this worth doing

`group.visible = false` removes a subtree from `projectObject`, but **not** from
`scene.updateMatrixWorld()`, which recurses unconditionally through `children`. Hiding 1 200
buildings still pays ~5 200 node visits a frame.

So: house groups are parented to a dedicated

```js
const coldRoot = new THREE.Group();
coldRoot.matrixAutoUpdate = false;                 // identity, forever
coldRoot.matrixWorldNeedsUpdate = false;
```

…and mode A does `scene.remove(coldRoot)`. The whole subtree leaves **both** walks. World matrices
survive detachment untouched (every child is already `matrixAutoUpdate = false` via
`freezeStatic`), so re-attaching on zoom-in is O(1) and correct.

`mountEnt` therefore adds new buildings to **`hotRoot`** (always attached — the pop-in animates a
matrix), and the existing "settled for good" branch at `town.js:2010` becomes the hand-off:

```js
} else if (g.matrixAutoUpdate && !e.rising) {
  g.updateMatrix(); g.matrixAutoUpdate = false;
  hotRoot.remove(g); coldRoot.add(g);              // ← now cold
  lod.set(e.n - 1, p.x, p.z, p.yaw, e.group.scale.x, e.imp);
  entsPop.splice(entsPop.indexOf(e), 1);
}
```

`dropGroup` must become `g.parent && g.parent.remove(g)` (it currently hard-codes `scene.remove`).

#### 3.5.6 Draw-call arithmetic after E1 + E-FURN

| | today | v4 |
|---|---|---|
| houses (1200, mode A) | 4 800 | **7** |
| grove trees | 252 | 3 |
| street lamps | 102 | 3 |
| benches | 16 | 2 |
| scaffolds | 66 | 66 (or 23 with E-FURN(d)) |
| landmarks + bridges + signpost | 67 | 67 |
| monument | ≤ 21 | ≤ 21 |
| environs / npcs / sky / plate / particles | 29 | 29 |
| **total** | **≈ 5 350** | **≈ 200** |

#### 3.5.7 Risks and their mitigations

| risk | mitigation |
|---|---|
| The A↔B switch pops visibly | 18/24 px hysteresis; the impostor carries the exact footprint, height, roof pitch, wall and roof colour. Verify with `--bench-shot` diffs at `medPx` 17, 20, 25. |
| A windmill loses its sails | `impExtra` (§3.5.2) — the three silhouettes that matter keep theirs. |
| Chimney smoke emits from an impostored house | Fine and *desirable*: `entsSmoke` is independent of LOD and the puff pool is world-space. A 1200-house town at `smokeK`-equivalent throttling shows ~24 puffs. |
| Lit windows vanish at night | The `win` IM: one emissive quad per building, facing the building's own `+z`, driven by the same `winI` float. Only unparked when `night > .15`. |
| Rare houses (painted ladies) lose their tell | They keep it — the impostor takes `paint.wall`, which for a painted lady is a `LADY_WALLS` entry. Loud walls read *better* as a flat box. |

#### Acceptance
`--bench-scene=s1200` → `draw.calls ≤ 300`, `triangles ≤ 300 000`, `cpuMs.p50 ≤ 6.0`.
`--bench-shot` PNGs for `s200/s600/s1200/n1200/z1200` reviewed side-by-side with the pre-v4 set;
no reviewer can name which is which at 100 % zoom for `s600`/`s1200`.

---

### E6 · Shadow budget — SHOULD, S

**Files:** `town.js`.

Current state is already sane: `autoUpdate = false`, one 2048² map, frustum sized to
`ext = min(bounds.r, 62) + 12 ≤ 74` and centred on the town's centre of mass. Texel density is
`2048 / 148 = 13.8 texels/unit` — plenty. **No cascades needed.** Four tightenings:

1. **Stop re-arming on a timer.** `town.js:2060` sets `needsUpdate = true` unconditionally every
   500 ms. Replace with a sun-motion threshold:
   ```js
   const sunEl = Math.asin(clamp(_sd.y, -1, 1));
   if (Math.abs(sunEl - lastShadowEl) > 0.0015) { renderer.shadowMap.needsUpdate = true; lastShadowEl = sunEl; }
   ```
   0.0015 rad ≈ one texel of movement at the frustum's far edge. At midday that fires roughly
   every 12 s instead of twice a second; near sunrise/sunset it self-accelerates, which is exactly
   right. **Reclaims ~1.6 full depth passes per second.**
2. **Tighten near/far.** `Object.assign(sun.shadow.camera, {near: 5, far: 400})` with the light at
   `|pos| ≈ 165` from its target wastes most of the depth range. Set `near: 60, far: 280`.
3. **Halve the map when the town is impostored.** At `mode === 'A'` a house shadow is a 3-px
   smudge:
   ```js
   const want = lod.mode === 'A' ? 1024 : 2048;
   if (sun.shadow.mapSize.x !== want) {
     sun.shadow.mapSize.set(want, want);
     if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }   // three re-allocates
     renderer.shadowMap.needsUpdate = true;
   }
   ```
   Quarter the depth fill on exactly the frames that need it most.
4. **Publish the caster set.** After E1, casters are: L0 house groups (mode B only), landmarks,
   bridges, the monument, the signpost, tree instances, lamp poles, the ground (receiver only).
   Impostor IMs and everything in `environs` never cast. The existing
   `if (e.band > 4) g.traverse(o => o.castShadow = false)` in `mountEnt` becomes redundant once
   mode A detaches `coldRoot` — keep it for mode B, where it is still correct.

---

### E-TPL · Merge-template cache — SHOULD, M

**Files:** `buildings.js` **only** (fully parallel-safe — hand it to whoever owns buildings).

`concatMeshes` transforms every vertex through a `Matrix4` and every normal through a `Matrix3`
with a `normalize()`, then allocates four typed arrays — **per building, at mount**. But a house's
merged geometry depends only on `(tier, variant, windowPattern, rare)`; the per-house uniform scale
lives on the *group* (`g.scale`, `town.js:862`) and colour is already a vertex attribute.

So cache the CPU-side result and recolour:

```js
/** @typedef {{P:Float32Array, N:Float32Array, I:Uint16Array|Uint32Array,
 *             R:Uint8Array, key:string}} Template   R = per-vertex role id */
const tplCache = new Map();      // LRU, cap 320

const ROLE = { roof:0, wall:1, wall2:2, trim:3, stone:4, door:5, accent:6, civic:7 };

/** Build once per key; thereafter slice + recolour. ~8× faster than concatMeshes. */
function geoFromTemplate(t, paint) {
  const C = new Float32Array(t.R.length * 3), c = new THREE.Color();
  for (let i = 0; i < t.R.length; i++) {
    c.setHex(paint[ROLE_NAME[t.R[i]]] ?? paint.wall);
    C[i*3] = c.r; C[i*3+1] = c.g; C[i*3+2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(t.P.slice(), 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(t.N.slice(), 3));
  g.setAttribute('color',    new THREE.BufferAttribute(C, 3));
  g.setIndex(new THREE.BufferAttribute(t.I.slice(), 1));
  g.boundingSphere = t.sphere.clone();
  return g;
}
```

`R` is filled during the *first* build by recording which `paint` field each source mesh's colour
came from — `mb()`/`mgab()`/etc. already know (they are called with `roof`, `wall`, `trim`, `stone`,
`door`, `accent`). Tag `m.userData.pk = 'roof'|'wall'|…` in those helpers (same one-liners E1 needs
for `role`), and `concatMeshes` writes `R` alongside `C`.

**Key quantisation.** Window layout is drawn from `seededR(seed + i)` per pane, which would make
every seed its own template. Quantise it: `addWindows(g, count, …, seed & 7, …)` — 8 window
patterns per (tier, variant) instead of unbounded. Template count = `8 tiers × 5 variants ×
8 patterns × 2 rare = 640` worst case, `~200` in a real 1200-house town, `~17 KB` each ⇒ **≈ 3.4 MB**
with an LRU cap of 320.

**Visual cost:** at 12–31 px a repeated window rhythm within one tier/variant is invisible. At a
manual zoom of 8 units it is faintly noticeable if you look for it. Judgement call; the sizes
(`8` vs `16` patterns) are a one-character knob.

**Disposal safety:** every attribute is a fresh `slice()`, so `disposeGroup` is unchanged and no
GPU buffer is ever shared. (Sharing `BufferAttribute` objects across geometries *would* halve the
memory but `geometry.dispose()` deletes the shared GPU buffer out from under the survivors — do
**not** do it.)

**Estimated saving:** ~6–10× on `mergeStatic`, i.e. the 1200-building cascade's mount cost drops
from an estimated ~1.2 s of CPU to ~0.15–0.2 s.

---

### E11 · NPC LOD — SHOULD, S

**Files:** `npcs.js` only.

160 villagers cost ~0.20 ms and 6 draw calls today — not a problem *now*, but v4 lifesim will want
carts, animals and 300+ villagers, and this is the change that pays for them.

Two tiers, decided from the same `K = H / (2·tan(fov/2))` the building LOD uses:

```js
const px = 0.62 * poseK / camD * K;      // a villager is ~0.62 units tall before poseK
const far = px < 3.5;
```

**`far === true`** (the auto-framed 600+ town, and every headless screenshot of a big day):

* `IM.hat.count = IM.arm.count = 0` — **2 draw calls and 480 matrix composes gone**. At 3 px a hat
  is a colour smear and an arm is one pixel.
* The contact disc stays (it is what grounds them at distance — `npcs.js:706`).
* **Third-rate stepping:** each frame update only `i % 3 === frame % 3` villagers, with `dt * 3`.
  Position, gait phase and yaw stay continuous; the two-thirds skipped keep last frame's matrix.
  At 3 px nobody can see a 33 ms stagger.
  * Correctness: every *transition* in `npcs.js` is already scheduled on `now`
    (`n.until`, `n.idleUntil`, `spikeUntil`, `pulseAt`, `bornAt`) — the file's own house rule — so
    thirding the *travel* integration cannot desynchronise worship slots, bridge pauses,
    pilgrimages or despawns.
  * `advance()`'s guard loop (`guard = 8`) must rise to `12` for the 3× budget, or a villager on a
    chain of short edges stalls.
* Lantern point lights: keep 2 (they are the night, and 2 is already the floor).

**`far === false`:** today's behaviour, unchanged.

**Also worth doing while in the file:** `pickSpeaker` allocates nothing and is fine; `update`'s
`shrink/keep/pilg` scratch arrays are already reused. The one remaining per-frame allocation is
`carriers` in the 2 Hz lantern block (`npcs.js:713`) — hoist it to module scope.

**Headroom delivered:** 160 → ~400 villagers at the same cost, with the hat/arm parts droppable.

---

### E9 · Road plate annulus clipping — SHOULD, M

**Files:** `layout.js` (`paintGround` signature), `town.js` (`updateRoads`).
**Do after E2** — E2 removes 80 % of the cost, and this removes the rest.

`paintGround` redraws the whole plate for a change that only ever *adds* an annulus. Add a clip:

```js
/** @param {{clipR0?:number, clipR1?:number}} opt — when both present, everything is drawn
 *  inside a circular-annulus clip and the canvas is NOT cleared. Callers own the invariant
 *  that nothing outside [clipR0, clipR1] changed. */
plan.paintGround(g, X, { …, clipR0: prevOuterR - 6, clipR1: newOuterR + 6 });
```
Implementation is three lines at the top of `paintGround`: `g.save(); g.beginPath();
g.arc(o[0],o[1], clipR1*px, 0, TAU); g.arc(o[0],o[1], clipR0*px, 0, TAU, true); g.clip();` — the
even-odd/reverse-arc trick gives a true annulus. Every existing draw call then costs only its
clipped fragments; the edge and plot loops still *iterate* but the rasteriser does nothing.

To also cut the iteration, gate the two big loops on radius (`edges` already have
`nodes[e.a/b].x/z`; `plots` are sorted by `k`, so the apron loop can binary-search *both* ends
instead of just the top).

`town.js` keeps `roadOuter` alongside `roadBand` and passes the annulus; a full repaint
(`clipR0 = 0`) happens only on `adoptEpoch` and on a `plazaR` move.

---

### E12 · Dispose / memory audit — SHOULD, S

**Files:** `town.js`, `buildings.js`, `bench.js`.

Read of every teardown path (`hardReset`, `dropGroup`, `disposeGroup`, `env.setSeed`,
`monument.reset`, `npcs.setPopulation(0)`). **The discipline is genuinely good** — `OWNED_GEO` /
`OWNED_MAT` correctly spare the shared caches, `mergedMat` and `winCache` results are registered
as owned, `environs` rewrites in place and mints nothing. Findings, in order of severity:

1. **`makeGlowTexture()` is called twice** (`town.js:217` for `sunHalo`, `town.js:409` for
   `POOL_MAT`), minting two identical 128² canvases and two GPU textures. Memoise. *(trivial)*
2. **Signpost board textures are re-minted on every `dressSignpost()`** — 2 × 512×128 canvases +
   2 uploads, and `dressSignpost` runs from both `adoptRange` **and** `adoptEpoch`, i.e. twice per
   epoch change and once per range change. Memoise by `(text|sub)`; keep an LRU of 8. *(trivial)*
3. **`matCache` is unbounded across days.** Keyed `kind|quantHex`; 8-step channel quantisation
   allows 32 768 colours per kind. A day's palette produces ~60–80, but the tray app runs for days
   and nothing ever clears it. Add: on `initPalette(daySeed)` with a *changed* seed, dispose and
   drop every `matCache` entry not currently referenced by `OWNED_MAT`'s live set — or simply cap
   at 512 entries with an LRU and dispose the evicted. *(S)*
4. **`famAt`** (`buildings.js:133`) is cleared only on a palette-seed change. Bounded at 1200. Fine.
5. **`cell` / `bins`** (`town.js:628`) grow one entry per `(bucket, model)` for the epoch. On
   `range=all` with coarsened history this is a few thousand; `computePace` walks all of `bins`
   but only at 2 Hz. Acceptable — **do not "fix"**, but note it in the bench (`epochs` scene
   reports `bins.size`).
6. **`LADDER`** is module-level and mutated by `spliceBestRung`; `hardReset` removes the `best`
   rung. Correct. Add an assertion in the `epochs` bench that `LADDER.length` returns to 17.
7. **`liveScaf`, `hitTargets`, `floaters`, `fxQ`** — all cleared in `hardReset` in the right order
   (`fxQ` first, so scheduled callbacks can't resurrect a torn-down group). Correct.
8. **`texCache` / `stripeMats` / `mergeMats` / `winCache`** are module-owned and never disposed, by
   design (§"cached; module-owned, never disposed"). Bounded by palette count. Correct.

The **leak bench** (`--bench-scene=epochs`) is the enforcement: 20 epoch switches, pass iff
`info.memory.geometries` after settle grows by ≤ 5 and `jsHeapMB` by ≤ 8 across the run.

---

### E10 · Chunk batching — COULD, L

**Files:** **new `src/renderer/batch.js`**, `town.js`.

E1 makes mode A cost 7 draws. Mode B — a small town, or a deliberate zoom-in on a big one — still
costs ~3.3 draws per visible building (≈ 500 at 200 buildings, ≈ 700 zoomed into 1200). If that
turns out to matter after E5 measures it, batch mode B by spatial cell:

* 48×48 world-unit grid over the ±290 plat ⇒ ~169 cells, ~70 occupied at the cap.
* Per occupied cell, per merge bucket, one super-mesh concatenating every **cold** building in it.
  3 buckets ⇒ **~210 draws for the whole town at full detail**.
* Rebuild queue, ≤ 2 cells/frame, ~0.3 ms each. A promotion or a spawn dirties one cell.
* Hover is already analytic after E4, so losing per-building meshes costs nothing.

Only worth building if `--bench-scene=z1200` misses its budget. **Do not speculate; measure.**

---

### E13 · The GPU-native town — COULD, L

**Files:** `buildings.js`, `lod.js`.

The endgame, sketched for whoever wants it. E-TPL establishes that a house's merged geometry is a
pure function of `(tier, variant, windowPattern, rare)` — ~200 distinct templates in a real town.
If the per-vertex colour becomes a **per-vertex 3-bit role index** plus a **per-instance palette**
(6 × `vec3` = 18 floats in an `InstancedBufferAttribute`, unpacked in `onBeforeCompile`), then the
whole town at **full detail** is one `InstancedMesh` per template:

```glsl
attribute float aRole;              // 0..7, baked into the template
attribute vec3  aPal0, aPal1, …;    // per-instance: roof, wall, wall2, trim, stone, door
// vertexShader, in <color_vertex>:
vColor = aRole < 0.5 ? aPal0 : aRole < 1.5 ? aPal1 : … ;
```

**~200 draw calls at 1200 buildings with every dormer and every window** — and LOD becomes a
nicety rather than a necessity. Cost: an `onBeforeCompile` per template material, a custom
instance-attribute allocator, and the loss of `mergeStatic`'s simplicity. Park it until E1 has
shipped and the bench says where the remaining time goes.

---

### E14 · Canvas texture atlas — COULD, M (verdict: **not yet**)

The brief asks for an atlas strategy. Here is the honest audit:

| owner | textures | size |
|---|---|---|
| `buildings.js` `texCache` | stripe (per quantised accent, ~1/day), plough, spiral, glass, nebula | 64²–128×256 |
| `environs.js` | grass 256², field 512², crop 128², mote 32² | 4 |
| `town.js` | glow ×2 *(→1 after E12)*, road plate **2048²**, signpost ×2 | 5 |
| `monument.js` | tablet, title plate 768×160 | 2 |
| **total** | **≈ 15–18** | ≈ 20 MB |

**An atlas buys nothing at 18 textures.** Texture *count* is not a bottleneck; texture *rebuild
cost* is, and that is the road plate (E2/E9) and the signpost (E12 #2). Both are fixed without an
atlas.

**The trigger to revisit:** `--bench` reports `mem.textures > 24`, or any per-frame canvas redraw
exceeds 2 ms. If it fires, the design is a shelf-packed `atlas.js`:

```js
/** @returns {{tex:THREE.Texture, uv:[number,number,number,number], repeat:boolean}} */
export function claim(key, w, h, draw)     // one 2048² canvas, shelf packing, uv returned
```
…with consumers multiplying `vMapUv` by the returned rect. Only the small decorative maps
(stripe/plough/spiral/glass/mote/glow) qualify; the road plate and the field atlas must stay
standalone (one is huge and repaints, the other already *is* a 4×4 atlas).

---

## 4 · Targets

Estimates from static analysis, at 1380×880 with the app's own auto-framing.
**E5's first run replaces the "today" column; the "v4" column is the contract.**

| scene | N | dist | med px | mode | draws today | **draws v4** | tris v4 | **cpu p50 v4** | cpu p99 v4 |
|---|---|---|---|---|---|---|---|---|---|
| `s200` | 200 | 145 | 31 | B | ~1 060 | **≤ 520** | ≤ 280 k | **≤ 3.5 ms** | ≤ 7 ms |
| `s600` | 600 | 270 | 17 | A | ~2 600 | **≤ 300** | ≤ 260 k | **≤ 4.5 ms** | ≤ 9 ms |
| `s1200` | 1200 | 382 | 12 | A | ~5 350 | **≤ 300** | ≤ 300 k | **≤ 6.0 ms** | ≤ 12 ms |
| `n1200` | 1200 | 382 | 12 | A | ~5 350 | **≤ 320** | ≤ 310 k | **≤ 6.5 ms** | ≤ 13 ms |
| `z1200` | 1200 | 40 | 110 | B | ~5 350 | **≤ 700** | ≤ 420 k | **≤ 8.0 ms** | ≤ 16 ms |

`found` (a 1200-building founding cascade):
`maxFrameMs ≤ 90`, `framesOver50 ≤ 4`, `framesOver100 = 0`, `settleMs ≤ 4 000`,
`paintGroundMs ≤ 60` total, `buildingsAt3s = 1200`.

`epochs`: `geometries` drift ≤ 5, `jsHeapMB` drift ≤ 8 over 20 switches.

### Reading the triangle column

Note that `s200` has **more** triangles than `s1200`. That is correct and it is the point: the
triangle budget is dominated by the *constant* world — ground grid 15.5 k, flora 1500 × ~50 = 75 k,
npcs 160 × ~270 = 43 k, monument ~20 k, landmarks ~40 k — and impostor LOD makes the building
count nearly free (1200 × 20 = 24 k). **After E1 the town's size stops being a triangle problem
and becomes purely a draw-call problem, which E1 also solves.**

### Where the CPU goes after E1 (projected, `s1200`)

| | ms |
|---|---|
| `renderer.render` — ~200 draws + state | 1.6 |
| scene traversal (coldRoot detached: ~250 nodes) | 0.1 |
| `npcs.update` (far tier) | 0.15 |
| `monument.update` | 0.3 |
| `env.update` (uniform writes only) | 0.05 |
| `news.update` | 0.2 |
| E-CORE loops (`entsMove`, `entsPop`, smoke cursor) | 0.2 |
| LOD 10 Hz pass, amortised | 0.05 |
| chrome / footer innerHTML at 2 Hz, amortised | 0.4 |
| slack | 3.0 |
| **budget** | **6.0** |

---

## 5 · Scheduling — the file-collision matrix

| item | `town.js` | `buildings.js` | `layout.js` | `npcs.js` | `environs.js` | `main.js` | new |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| E5 bench | ▲ 6 lines | | | | | ● | `bench.js` |
| E2 road plate | ● | | ● | | | | |
| E-CORE (E3/4/7/8) | ●●● | | | ▲ 1 fn | | | |
| E-FURN | ●● | | | | | | |
| E1 LOD | ●● | ● | | | | | `lod.js` |
| E6 shadows | ● | | | | | | |
| E-TPL | | ●● | | | | | |
| E11 npc LOD | | | | ●● | | | |
| E9 annulus | ▲ | | ●● | | | | |
| E12 memory | ▲ | ▲ | | | | | ▲ `bench.js` |
| E10 chunks | ● | | | | | | `batch.js` |
| E13 gpu town | | ●● | | | | | ● `lod.js` |

● = substantive edit ▲ = a handful of lines

**Parallel-safe waves:**

* **Wave 0 (alone):** `E5`. Everything downstream reports against it.
* **Wave 1 (four agents, no collisions):**
  `E-TPL` (`buildings.js`) ‖ `E11` (`npcs.js`) ‖ `E2` (`layout.js` + a small `town.js` hunk) ‖
  whatever the lookdev/weather fleets are doing in `environs.js` / `monument.js` / `news.js`.
* **Wave 2 (one agent, `town.js` owner, in order):** `E-CORE` → `E-FURN` → `E1` → `E6`.
  `E1`'s `buildings.js` hunk (the `role`/`pk` tags in `mb`/`mgab`/`mp`/`cone4` and
  `deriveImpostor` inside `finish`) is the **same** set of one-liners `E-TPL` needs — hand that
  hunk to the `E-TPL` agent in wave 1 and have `E1` consume it. That is the one cross-wave
  dependency and it is a 15-line contract:
  ```js
  // buildings.js, wave 1 deliverable, consumed by both E-TPL and E1:
  //   mb(w,h,d,hex,kind)    → m.userData.role = (kind==='wall'?1:0); m.userData.pk = kind||'wall'
  //   mgab(...)             → m.userData.role = 2; m.userData.rk = 1; m.userData.pk = 'roof'
  //   mp(...) / cone4(...)  → m.userData.role = 2; m.userData.rk = 2; m.userData.pk = 'roof'
  //   plus a `pk` for stone/trim/door/accent in their helpers
  // mergeStatic/concatMeshes: write a per-vertex Uint8Array R from `pk`.
  ```
* **Wave 3:** `E9` ‖ `E12`; then `E10`/`E13`/`E14` only if wave-2 bench output says so.

---

## 6 · What the other fleets need from this document

### Weather (rain, snow, gusts, storm light)
* **Blocked on:** `E1` (draw-call headroom) and `E7`/E-CORE (the CPU pools are for ceremony).
* **Contract:** rain and snow are a **single `InstancedBufferGeometry` with vertex-shader motion off
  `uTime`**, exactly like `environs.js`'s cloud/bird mesh (`environs.js:951`). One draw call, no CPU
  step, no dt. Budget: **≤ 3 draw calls, ≤ 2 materials, ≤ 1 texture** for all weather.
* Puddles / wet ground go in `groundMat.onBeforeCompile` as one more uniform, not as geometry.
* Storm darkening rides `U.uCloudShadow` / `U.uCloudA`, which already exist and are already
  wall-clock-eased over 8 s (`stepWeather`, `environs.js:1433`).

### Lifesim (carts, animals, schedules, 300+ villagers)
* **Blocked on:** `E11` (the part-dropping + third-rate stepping) and `E8`/E-CORE (the flat
  building array — a 300-NPC sim would otherwise rebuild a 1200-object array per frame).
* **Contract:** every new actor kind is one `InstancedMesh` per body part, matrices composed on the
  CPU into a `DynamicDrawUsage` buffer, `frustumCulled = false`, colours uploaded only on index
  change. `npcs.js` is the reference; copy its shape exactly. Budget: **≤ 4 draw calls per new
  actor kind**, and the kind must be droppable at `far` LOD.

### Lookdev (AO, richer light, seasonal palettes)
* **Blocked on:** `E6` (the shadow re-arm rule; a lookdev pass that dirties the shadow map every
  frame throws away the whole budget).
* **Contract:** §2.1 and §2.2. Per-building variety is **vertex colour**, never a material and
  never a texture. A new `KIND` tuple is a global +1 draw per building in mode B — allowed, but it
  must be declared in the PR and re-benched.
* Screen-space effects (SSAO, bloom) would need an `EffectComposer`, which is **not** in the
  vendored `three` build and would need new files copied by `scripts/copy-vendor.js`. Prefer the
  cheap wins that already work here: the CSS vignette (`environs.js:1615`, 0 draws), the
  hemisphere/ground-colour trick (`town.js:1920`), `uLandFar` (`environs.js:1499`).

---

## 7 · Risks

| risk | severity | mitigation |
|---|---|---|
| The bench measures a machine, not a commit | high | Report **ratios** against a baseline stored in `bench.json`; gate on `Δ`, not on absolutes. Pin `disable-gpu-vsync` so the number is throughput, not vsync. |
| E1's A↔B switch is visible | medium | 18/24 px hysteresis + `--bench-shot` diffs at the boundary; impostors carry exact height/footprint/colour. |
| E-TPL's window-pattern quantisation reads as repetition when zoomed | low | 8 patterns per (tier, variant); the knob is one character. Ship at 8, review a `z1200` shot, raise to 16 if it reads. |
| `coldRoot` detach breaks something that walks `scene.children` | medium | Two known walkers: `environs.js:1478` (`for (const o of scene.children) if (o.isDirectionalLight …)` — unaffected, the sun is a direct child) and nothing else. Grep for `scene.children` before landing. |
| Wave-2 serialisation stalls the fleet | medium | `town.js` is 2158 lines and is the conductor by design — that is not fixable in v4. Mitigate by giving wave 2 a single agent and everything else genuinely non-colliding work. |
| Impostors ship before the bench and nobody can prove the win | high | **Build E5 first.** This is the one hard ordering constraint in the document. |

---

## 8 · The one-paragraph version

The town is a *draw-call* problem, not a triangle problem: at the 1200-building cap it submits an
estimated **5 350 draws** — 4 800 of them houses at ~4 each, plus 370 for grove trees, street lamps
and benches that are all literally the same shared geometry drawn over and over. The camera
auto-frames the whole town, so building screen size *shrinks* as the town grows, and at 1200 a
house is **12 pixels tall**. Therefore: derive a box-and-roof impostor automatically from the
meshes each builder already makes, hold every settled building in seven InstancedMeshes,
**detach** (not hide) the real geometry when the median house drops below 18 px, and instance the
furniture. That is **~200 draw calls and ~24 k building triangles at the cap**. Alongside it, take
the 26 000 `fillRect`s out of the road plate's wear pass (they are the founding cascade's real
stall), split the 1200-entry per-frame `animEnts` loop into the ~50 entities that actually animate,
replace a 4 800-mesh recursive raycast with a plot hash, and cache the merge templates so a
cascade mounts 6–10× faster. And build the `--bench` harness first, because none of the numbers in
this document are measurements yet — they are a careful reading of the code, and the whole point of
E5 is to replace them with the truth before anyone spends a day on the wrong one.
