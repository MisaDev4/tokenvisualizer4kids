# Token Town v4 — THE INTEGRATION WIRING GUIDE

*Audit + recipe for the wave that copies `scratchpad/v4-staging/*` into the shipped tree and
turns thirteen isolated modules into a running app. Written for someone competent who has
**not** read the eight design docs. Everything here was verified against the real shipped
`town/src/renderer/*` and the real vendored three r160 in a Node harness
(`scratchpad/v4-smoke/smoke.mjs`, 195 assertions, 0 failures).*

Line numbers refer to the tree as of this audit (`town.js` 2 208 lines). They will shift as
you edit; every anchor is also named by function or by the exact source line quoted.

---

## 0. BEFORE YOU START — the three facts that govern everything

1. **`town.js` is the sole mediator.** None of the thirteen new modules imports another. Every
   cross-module value goes through `town.js`, either as a `cfg` callback or through `ctx`.
2. **Every new module exports `reset()` (epoch switch) and `dispose()` (shutdown).** `hardReset()`
   (town.js:1620) must call all of them, in one list, or `--bench-scene=epochs` fails the build.
3. **Wall clock, not `dt`.** Every module that owns visible state takes `now` (`performance.now()`).
   Only `camera.js` takes a delta, and it takes **`wdt`** (town.js's clamped wall clock), never `dt`.
   `weather.update(dt, now, ctx)` and `memorial.update(dt, now, ctx)` take `dt` **and ignore it** —
   the signature exists so a future physics term has somewhere to go.

---

## 1. FILE PLACEMENT

| staged file | destination | module system |
|---|---|---|
| `postfx.js` `surface.js` `grounding.js` `camera.js` `interact.js` `lod.js` `bench.js` `chronicle.js` `memorial.js` `almanac.js` `charter.js` `weather.js` | `town/src/renderer/` | ESM, `import * as THREE from './vendor/three.module.js'` |
| **`chronicle-store.js`** | **`town/src/`** (beside `main.js`) — **not** `renderer/` | **CommonJS**, `require`d by `main.js` |
| `BENCH-README.md` | `town/` (documentation only) | — |

`chronicle-store.js` has zero relative imports, so it runs from either directory, but it is a
main-process module and belongs beside `main.js`. `package.json` needs **no** change — no new
dependency, and the renderer stays ESM-by-`<script type="module">`.

---

## 2. RECOMMENDED ORDER OF OPERATIONS

Do it in this order. Each stage leaves a runnable app.

| # | stage | files | why here |
|---|---|---|---|
| **A** | **Shell + bench + store** — main.js flags/IPC, preload, `bench.js`, `chronicle-store.js` | `main.js`, `preload.js`, `src/chronicle-store.js`, `renderer/bench.js` | Nothing downstream is measurable or persistable without it, and the pre-v4 **baseline** must be taken here (`--bench --bench-budget=off`) before any perf claim. |
| **B** | **Camera rig** — delete town.js's camera block, mount `camera.js` | `camera.js`, `town.js` | Every later module reads `rig.mode` / `rig.dist` / `rig.moving`. Land it before anything that consumes them. |
| **C** | **The picture** — `postfx.js` + `surface.js` **in the same commit**, plus L1b's light rebalance and `env.landFar()` | `postfx.js`, `surface.js`, `buildings.js`, `monument.js`, `environs.js`, `town.js` | F3 without F4 takes key:fill to 5.7:1 with no rim light — *the intermediate state is worse than today*. Never ship them apart. |
| **D** | **Grounding** — `grounding.js` | `grounding.js`, `town.js` | Cheap, self-contained, one `place()` call in `mountEnt`. |
| **E** | **LOD** — `lod.js` + the `hotRoot`/`coldRoot` split + `deriveImpostor()` | `lod.js`, `buildings.js`, `town.js` | Needs B (rig) and A (bench, to prove the win). **Read §8.1 first — it breaks `interact.js`'s hover if landed naively.** |
| **F** | **Interaction** — `interact.js` + `index.html §interact` | `interact.js`, `index.html`, `town.js` | Must land **after** E so the `lod.pick` handshake (§8.1) is written once. |
| **G** | **The memory** — `chronicle.js` → `memorial.js` → `almanac.js` → `charter.js` | those four, `layout.js`, `news.js`, `town.js` | `chronicle.js` is the producer; the other three are consumers of `chronicle.view()`. |
| **H** | **The sky** — `weather.js` + the grade block | `weather.js`, `environs.js`, `town.js` | Land the **S4 environs handover** in the same commit (§8.2) or there are three writers of `fog.color`. |

Re-run `--bench --bench-scene=all` at the end of every stage. A regression in `cpuMs.p50` or any
growth in `draw.calls` past budget blocks the merge (backlog §5 risk 2).

---

## 3. `main.js` — six edits

### 3.1 The forwarded query list (§4.9)

Replace town/src/main.js:87:

```js
for (const k of ['hour', 'tokens', 'still', 'demo', 'feed', 'range', 'seed', 'intro']) {
```

with

```js
for (const k of [
  // v3
  'hour', 'tokens', 'still', 'demo', 'feed', 'range', 'seed', 'intro',
  // v4 — picture
  'post',
  // v4 — place
  'cam', 'select', 'shot-ui', 'ui',
  // v4 — sky
  'wx', 'wxi', 'wxcover', 'season', 'moon',
  // v4 — memory / progression
  'chronicle', 'almanac', 'ledger',
  // v4 — data depth (D1/D2, later waves; harmless now)
  'limits', 'limit-reset', 'mix', 'hide',
  // v4 — bench
  'bench', 'bench-scene', 'bench-frames', 'bench-warmup', 'bench-shot',
  'bench-budget', 'bench-dpr', 'bench-pump', 'bench-settle'
]) {
```

`--map=1` from §4.9 is **not** forwarded: the Kingdom Map (H8) is cut from v4 and `almanac.js`
deliberately ships no `showMap()`.

### 3.2 Bench mode

```js
const isBench = process.argv.some(a => a === '--bench' || a.startsWith('--bench='));
if (isBench) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
```
`isBench` must also force `headless` true (`const headless = !!shotPath || isBench;`) so the
window never appears, and `--bench-size=WxH` (if given) sizes the `BrowserWindow`.

### 3.3 The bench message router

`bench.js` speaks four line protocols on stdout. Route them in the existing
`win.webContents.on('console-message', …)` handler (widen it — today it only logs level ≥ 2):

| prefix | action |
|---|---|
| `TOWNBENCH <json>` | `rows.push(JSON.parse(rest))` |
| `TOWNBENCH_SHOT <scene>` | `await win.webContents.capturePage()` → write PNG. **Serialise this before any navigation** — the page holds the wall clock open for `DEF.shotPauseMs` (700 ms), which is your window. |
| `TOWNBENCH_LOAD <json>` | `win.loadFile(indexPath, { query: JSON.parse(rest) })` — main stays scene-agnostic; the page decides. |
| `TOWNBENCH_DONE <json>` | `finishBench()` — print the table, write `--bench-json` if asked, `app.exit(rows.every(r => r.pass) ? 0 : 1)` |

Plus a **180 s watchdog** → `app.exit(2)`. `BENCH-README.md` §3 has the copy-paste version.

### 3.4 The chronicle store

```js
const chronicle = require('./chronicle-store.js');
// …
app.whenReady().then(() => {
  chronicle.configure({ synthetic: isShotRun || isBench });
  chronicle.load();                       // sync, before the window opens
  startFeed(); createWindow();
  chronicle.attach(ipcMain);
});
app.on('before-quit', () => chronicle.dispose());
```

### 3.5 The ready replay (ordering matters)

In `ipcMain.on('town:ready', …)` (main.js:108), **before** the `lastConfig` / `lastInit`
unshifts:

```js
queued.unshift(chronicle.message());       // must arrive AHEAD of the first init
```

The renderer's `charter.adopt()` must hold the record before the first token lands, or a
cold-open parade re-awards badges that were already earned.

### 3.6 `saveShot` IPC (C6, photo mode)

```js
ipcMain.handle('town:saveShot', async (_e, name, dataURL) => {
  if (isShotRun || isBench) return null;   // a verification run never writes to Pictures
  const dir = path.join(app.getPath('pictures'), 'Token Town');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(name).replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, Buffer.from(String(dataURL).split(',')[1] || '', 'base64'));
  return file;
});
```

---

## 4. `preload.js` — one edit

```js
contextBridge.exposeInMainWorld('townAPI', {
  onData: cb => ipcRenderer.on('town:data', (_e, msg) => cb(msg)),
  ready: () => ipcRenderer.send('town:ready'),
  chronicle: {
    load: () => ipcRenderer.invoke('town:chronicle:load'),   // === CHANNELS.load
    save: patch => ipcRenderer.send('town:chronicle:save', patch)   // === CHANNELS.save
  },
  saveShot: (name, dataURL) => ipcRenderer.invoke('town:saveShot', name, dataURL)
});
```

`chronicle-store.js` exports `CHANNELS = { load: 'town:chronicle:load', save: 'town:chronicle:save' }`
— import them if you prefer, so the two files cannot drift.

---

## 5. `index.html` — append-only sections

`index.html` is the documented exception to one-owner-per-file: append one banner-delimited
block per task. **Both `interact.js` and `almanac.js` inject their own base sheet at the TOP of
`<head>` at runtime**, so the page's own rules always win a tie and *the app is correct with no
`index.html` change at all*. Add sections only for polish.

```html
<!-- ═══ v4: interact ═══ -->
<!-- optional overrides for #deed / #modePill / #toast / #keys / #sheet -->
<!-- ═══ v4: almanac ═══ -->
<!-- optional overrides for .alm-strip / .alm-card -->
<!-- ═══ v4: ledger ═══ -->   <!-- B3, wave 3 -->
```

Two things to know:

* `interact.js` **adopts** `#tip` (index.html:167) if it exists, keeps its shipped styling, and
  only appends a fourth line (`.t4`). Do not delete `#tip`.
* `almanac.js` mounts its strip into `<header>` after `#palDots` (index.html:154) and its card
  into `#overlay` (index.html:166). Both already exist.
* `body.photo { --vig:.30 }` ships inside `interact.js`'s sheet. **See §8.4 — under postfx this
  double-vignettes photo mode.**

---

## 6. `town.js` — the call sites, anchor by anchor

### 6.1 Imports (top of file, beside the existing block at town.js:33)

```js
import { initCamera }                                   from './camera.js';
import { initPost, gradeFor, makeGrade, heatOf }        from './postfx.js';
import * as surface                                     from './surface.js';
import { initGrounding }                                from './grounding.js';
import { initLod }                                      from './lod.js';
import { initInteract }                                 from './interact.js';
import { WX, initWeather }                              from './weather.js';
import { initChronicle, paintSkyline, synthChronicle,
         dayIndexOf, dateOfDayIndex, planSeedOfIndex }  from './chronicle.js';
import { initMemorial }                                 from './memorial.js';
import { initAlmanac }                                  from './almanac.js';
import { initCharter }                                  from './charter.js';
// bench is imported LAST and BEHIND THE FLAG, at the bottom of the file:
//   let bench = null;
//   const BENCH_ON = Q.get('bench') !== null;
//   if (BENCH_ON) bench = (await import('./bench.js'))
//                   .initBench(renderer, Q, { feed: onData, pinCamera, probe });
```

### 6.2 `ctx` — what to add (town.js:708)

`ctx` already carries **every** field the staged modules read: `day night simNow camera totalTok
buildingCount perMin paceRatio plan frontierK band bounds outerR plazaR monumentPos getBuildings
palette accent accentCss daySeed planSeed seedHex townName rangeKey rangeLabel rangeShort
rangeStartMs rangeIsDay intro`. Verified module-by-module — **no renames, no unit changes**.

Add exactly three:

```js
ctx.chronicle = null;   // set to the Chronicle after initChronicle
ctx.store     = (window.townAPI && window.townAPI.chronicle) || null;
ctx.wx        = null;   // set to the Weather; news/npcs read it in wave 2
```

`ctx.bounds` **must keep being mutated in place** (town.js:342–344 already does). `camera.js` and
`lod.js` both re-read it every frame and would freeze on a stale copy.

### 6.3 The rig — replace town.js's camera block

**Delete**: `az/pol/dist/idleT/userDist/dollyT` (town.js:326), `dollyBias()` (330), `fitBias()`,
`applyCam()` (391), the `pointerdown`/`wheel`/`dblclick` listeners (≈403–411), `idleT += dt; …
applyCam();` (2094–2095). **Keep** `sunCtr` (325) — that is the *sun's* target, not the camera's,
and `refreshFraming()`, whose body shrinks to the calls below.

Create the rig **after `env`** (needs `env.sampleHeight`) and **before the first
`refreshFraming()`** (town.js:2210):

```js
const rig = initCamera(camera, {
  canvas, stage,
  sampleHeight: env.sampleHeight,
  getPlan: () => plan,
  getBuildings: buildingsForNPCs,          // see §8.5 — widen it or the tour loses 2 shots
  resolveFollow: h => npcs.track && npcs.track(h),
  onMode: (next, prev, meta) => { if (meta && meta.toast) ui.toast(meta.toast); },
  onShot: null
});
```

Then, one for one:

| old | new |
|---|---|
| `refreshFraming()` body's framing maths | `rig.setFrame(b, monument.crownHeight \|\| 8)` |
| `scene.fog.density = fogFor(dist, env.biome)` (town.js:363, once per structural change) | move into `tick()`: `scene.fog.density = fogFor(rig.fogDist, env.biome) * G.fogMul` — the distance is continuous now, and a once-per-change write leaves the fog wrong for eight seconds of a tour |
| `Object.assign(sun.shadow.camera, {left:-ext,…})` (370) + `sunCtr.set(b.cx,0,b.cz)` (372) | `const ext = rig.shadowExtent; … sunCtr.copy(rig.shadowCenter);` re-armed at **≤ 12 Hz wall clock while `rig.moving`** in a close mode |
| `if (!userDist) dollyT = performance.now()` (1036 and 1228) | `rig.punch()` |
| `dist * dollyBias() * introDist() * fitBias()` | `rig.setIntroBias(introDist(), introPol())` once per frame; `introDist`/`introPol` (1452/1454) stay |
| `fx = clamp(dist / 62, 1, 3.4)` (particle scale) | `fx = clamp(Math.max(rig.dist, 26) / 62, 1, 3.4)` — the floor stops a burst collapsing to specks while following a villager |
| `applyCam()` | `rig.update(wdt, now, ctx)` — **`wdt`, not `dt`** |

`hardReset()` → `rig.reset()`. Shutdown → `rig.dispose()`.

### 6.4 postfx + surface (stage C, one commit)

```js
// after renderer/scene/camera exist (~town.js:195)
const post   = initPost(renderer, scene, camera,
                 { quality: Q.get('post') || 'high', headless: IS_SHOT || BENCH_ON });
const _grade = makeGrade();               // ONE scratch object, forever
```

`resize()` (1924) — after `renderer.setSize(w, h, false)`:
```js
post.setSize(w, h);                       // CSS px, the same w/h renderer.setSize got
lod.setSize(w, h);
```

`tick()` — replace `renderer.render(scene, camera)` (2203) with:
```js
gradeFor(day, night, glowK, heatOf(ctx), _grade);
// where the sharp band sits is a FRAMING decision; gradeFor deliberately never writes it
_grade.tiltCenter = monumentNdcY();       // optional; default .5 is fine
post.setGrade(_grade);
post.render(now);
ui.afterRender();                         // must be the line AFTER the render
if (bench) bench.sample(now, t0, townSample());   // must be the LAST statement of tick
```

`hardReset()` → `post.reset()`. Shutdown → `post.dispose()`.

**Three things that will bite you:**
1. **`postfx` sets `renderer.info.autoReset = false` and calls `info.reset()` itself** at the top
   of `render()`. It has to — three resets `info` inside *every* `render()` call, and postfx makes
   ten of them. **Read `renderer.info` only after `post.render()`, and never call `info.reset()`
   anywhere else.** (`bench.js`'s comment at line 525 says "autoReset is true" — that comment is
   now stale; the behaviour is correct because `bench.sample` runs after `post.render`.)
2. **F3 needs L1b's light rebalance in the same commit**: `sun.intensity = day * 2.35 * LI`
   (town.js:1949, from 1.45) and `hemi.intensity = (.11 + .30 * day) * LI` (1975, from .16/.38).
   The curve is authored against a key that exceeds 1.0 linear on lit plaster; on the old key
   noon comes out flat and the post pass takes the blame.
3. **The `--vig` handshake is automatic** — postfx sets `--vig: 0` on `documentElement` and
   re-asserts it at 2 Hz, because `environs.js:1509` rewrites the property whenever its own value
   moves. `environs.js` needs no change. See §8.4 for the one place this is not enough.

**`surface.js` hooks** (owner: BLD/F7 for `buildings.js`, MON for `monument.js`):

```js
// buildings.js
export function std(color, extra) {
  return applyTownSurface(new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .85 }, extra)));
}
// matFor(): applyTownSurface(m) BEFORE matCache.set(key, m)         (buildings.js:443)
// mergedMat(): applyTownSurface(m) BEFORE mergeMats.set(k, m)       (buildings.js:494)
// trees / lamps / benches:  applyTownSurface(m, 'prop')
// monument.js: the gold + stone materials → applyTownSurface(m, 'metal')
// ground plates / decals:   applyTownSurface(m, 'ground')
```
**Ordering constraint, non-negotiable:** anything that assigns `m.onBeforeCompile` *after*
`applyTownSurface` clobbers the patch. `applyTownSurface` **chains onto** an existing hook, so
patch last. (S5's snow patch in wave 2 composes correctly either way — verified: both uniform
sets survive and the cache key becomes `snow|town-surface-building`.)

`tick()`, in the sky-and-light block beside the `skyMat.uniforms` writes (town.js:1952):
```js
SURF.uRimCol.value.copy(skyMat.uniforms.top.value).lerp(WHITE, .35);
SURF.uRimK.value   = .20 + .26 * day + .30 * night;
SURF.uBaseAO.value = .34 - .10 * night;
SURF.uLandFar.value.copy(env.landFar());       // NEW 2-line getter, see §8.3
SURF.uFarD.value.set(rig.dist * .55, rig.dist * 3.1);
```
`hardReset()` → `surface.reset()`. Shutdown → `surface.dispose()`.

### 6.5 grounding (stage D)

```js
const grounding = initGrounding(scene, { capacity: 1400, maxAnisotropy: MAXA });
```
`mountEnt(e)` (town.js:881), after `g.position.set(p.x, 0, p.z)` and after `e.hTop` is known —
**for every entity, whatever band it is in**:
```js
grounding.place(e.idx, p.x, p.z, 1.55 * (g.userData.span || 1) + .10 * e.hTop, e.hTop);
```
`dropGroup(g)` / demolition → `grounding.clear(slot)`.
`tick()`, after `_sd.normalize()` (town.js:1961) **and** after `ctx.day` is set (2015):
```js
grounding.update(now, ctx, _sd);        // _sd points TOWARD the sun
```
Slot namespacing so systems cannot collide: houses/landmarks `e.idx` (negative synthetics are
already unique), props `-1e5 - i`, villagers `1e6 + n.seed`. More slots than capacity is a
supported state — the field keeps the nearest, biased toward big/tall subjects, re-picked at 2 Hz.

`hardReset()` → `grounding.reset()`. Shutdown → `grounding.dispose()`.

### 6.6 LOD (stage E) — **read §8.1 first**

```js
const hotRoot  = new THREE.Group(); scene.add(hotRoot);
const coldRoot = new THREE.Group(); coldRoot.matrixAutoUpdate = false;   // lod attaches/detaches
const lod = initLod(scene, {
  cap: N_CAP, camera, stage, coldRoot, houses,
  geo: GEO,                       // shares GEO.unit/gable/pyr — the prism is then bit-identical
  winMat: winCacheMaterial,       // NEW export from buildings.js, §8.6
  quality: 'high'
});
```
1. New buildings mount into `hotRoot` (the pop-in animates a matrix).
2. At the settle branch (`else if (g.matrixAutoUpdate && !e.rising)`):
   `hotRoot.remove(g); coldRoot.add(g); lod.set(e.n - 1, p.x, p.z, p.yaw, g.scale.x, e.imp);`
3. `remountEnt` / demolition call `lod.clear(e.n - 1)` **first**.
4. `dropGroup(g)` becomes `g.parent && g.parent.remove(g)`.
5. House groups get `frustumCulled = false` (lod owns their visibility) and leave `hitTargets`.
   Buildings still popping in stay in `hitTargets` until the hand-off.
6. `tick()` before the render: `lod.update(now, ctx, houses)`; `resize()` → `lod.setSize(w, h)`.
7. Forward `lod.npcTier()` to `npcs.js` — one threshold, one hysteresis, decided in one place.

`e.imp` is `buildings.js`'s `deriveImpostor()` result (F7, §8.6). A **null `imp` is legal** and
pins that building to FULL — it stays a real group and stays hoverable. Register an impostor only
for groups that live **inside** `coldRoot`; landmarks, bridges and the monument must not be
registered, or mode A detaches the only copy of them there is.

`hardReset()` → `lod.reset()`. Shutdown → `lod.dispose()`.

### 6.7 interact (stage F)

**Delete** town.js's hover block: `const ray = new THREE.Raycaster(), tip = …` (1816), the
`mousemove`/`mouseleave` listeners, and the whole `if (mouseNDC && now - hoverAt > 50) {…}` block
(2097–2110). Widen `tipFor(e)` (1829) into `describeEnt(e) → Deed` and add `paidFor(n)`.

```js
const ui = initInteract({
  stage, canvas, scene, camera, rig, hitTargets, npcs,
  describe: describeEnt,               // three-string tipFor still works verbatim if you defer
  sources: shotSources,                // accepted, unused this wave
  getPlan: () => plan,
  villager: news.villagerFor,          // optional; absent ⇒ generic villager card
  saveShot: window.townAPI && window.townAPI.saveShot
});
```
`tick()`: `ui.update(now, ctx)` **after** the animEnts pop/bump block (it multiplies the scale
that block writes) and **after** `rig.update()`. `ui.afterRender()` on the line after the render.
`hardReset()` → `ui.reset()`. Shutdown → `ui.dispose()`.

The `Deed` shape (§4.3):
```js
/** @typedef {{title:string, badge?:string, sub:string,
 *   rows:Array<[string,string]>,           // ≤ 5 label/value pairs
 *   flavor?:string, acts?:string[],        // 'focus'|'follow'|'walk'|'tour'
 *   at:{x,y,z,hTop}, live?:boolean}} Deed */
```
`paidFor(n) → ?{ms, wMs, tok}` is a binary search of `bins`' (town.js:643) cumulative sum for
where the day's tokens crossed `tokensFor(n)`. It feeds the deed's `paid for by` row —
*"cost 4.24M tokens · paid for by your 14:05–14:10 burst"*, the best line in the fleet.

`interact.js` also gains one line in `tipFor`/`describeEnt` for memorial's own entities:
```js
if (typeof e.tip === 'function') return e.tip();
```

### 6.8 The memory (stage G)

```js
const chronicle = initChronicle({
  identify: idx => {
    const s = planSeedOfIndex(idx);
    return { name: townNameFor(s), kind: archetypeOf(s), kindLabel: KIND_LABEL[archetypeOf(s)] };
  },
  sizeOf: townSize,                       // town.js:65 — one growth law, shared
  ladder: LADDER,                         // town.js:89 — snapshotted, best-rung filtered out
  store: window.townAPI && window.townAPI.chronicle,
  readOnly: SYNTHETIC                     // FORCE_DEMO||TOK_OVERRIDE||SEED_OVERRIDE||HOUR_OVERRIDE||IS_SHOT
});
ctx.chronicle = chronicle;

const memorial = initMemorial(scene, {
  maxAnisotropy: MAXA, paintSkyline,
  plazaR: () => ctx.plazaR, innerR: () => plan.innerR, gate: () => plan.gate,
  sampleHeight: env.sampleHeight, accent: () => ctx.accent, seed: daySeed,
  pressure: () => chronicle.pressure()    // a METHOD, not a view field — omit it and there is
});                                       // simply never an inlay
for (const { group, ent } of memorial.ents) { tagEnt(group, ent); addHit(group); }  // ONCE, at init

const almanac = initAlmanac({
  paintSkyline, chronicle,
  accent: () => ctx.accentCss,
  canShow: () => !ui.selected,            // the chrome-budget arbiter
  dayIndexOf, dateOfDayIndex
});

const charter = initCharter({
  doc: chronicleDoc, readOnly: SYNTHETIC,
  record: p => window.townAPI && window.townAPI.chronicle && window.townAPI.chronicle.save(p)
});
```

`applyInit(msg)` (1649), after `spliceBestRung(...)`:
```js
chronicle.ingest(msg);
memorial.setPlan(plan, planSeed);
memorial.setView(chronicle.view());
almanac.setView(chronicle.view());
```

`onData(msg)` (1752), one new case:
```js
case 'chronicle': charter.adopt(msg.doc); break;
```

The 500 ms stats tick (town.js:2112):
```js
if (ctx.rangeIsDay) chronicle.setLive(T);
memorial.setView(chronicle.view());       // idempotent, cheap
almanac.setView(chronicle.view());        // signature-guarded: 200 identical calls repaint nothing
for (const b of chronicle.recordsBrokenBy(T)) {
  const at = memorial.celebrateRecord(b);
  if (at) burst3d(at, GOLD_HI, 44, 8);
  news.post('record', b);
}
if (ctx.rangeIsDay && SEED_OVERRIDE === null) {
  const ov = chronicle.overtaking();
  if (ov) { const g = memorial.overtook(); if (g) liftNineBirds(g); news.post('overtake', ov); }
}
```

The frame loop: `memorial.update(dt, now, ctx)` and `almanac.update(now)` — **`performance.now()`,
never `dt`**.

The **day-boundary branch of the fade, BEFORE `hardReset()`**:
`almanac.showCard(prevDayIdx, { hold: 7000 });`

Once per **wall-clock minute**, and after every milestone / landmark / grove:
```js
fillDayFacts(charter.facts);              // town.js writes the DayFacts scratch IN PLACE
for (const a of charter.check(charter.facts)) fireAward(a);
```
`fillDayFacts` must set `facts.dayScoped = !!(feedTodayBlock || ctx.rangeIsDay)`,
`facts.bestTok` = best recorded day **excluding today**, `facts.weather = wx.id`. Every field
degrades to 0/'' safely; the typedef is in `charter.js`'s header.

`hardReset()` → `chronicle.reset()` (**caches only — never rebuild it; the chronicle outlives
epochs by definition**), `memorial.reset()`, `almanac.reset()`, `charter.reset()`.
Shutdown → `.dispose()` on all four.

Optional, off the critical path:
`schedule(1800, () => memorial.setGhostArt(dayCv, nightCv))` — high-fidelity plan-mode ghost art.

Demo mode: `chronicle.ingest({ chronicle: synthChronicle(Date.now()) })` behind `?chronicle=demo`.

### 6.9 The sky (stage H)

```js
const env = initEnvirons(scene, plan, { maxAnisotropy: MAXA, daySeed, palette: palette(),
                                        quality: 'high', wx: WX });   // bus FIRST
const wx  = initWeather(scene, { daySeed, lat, quality: 'high', maxAnisotropy: MAXA,
                                 biome: env.biome, plazaPos: MON_POS });
ctx.wx = wx;
```

`tick()`, **after** the sun/sky block (town.js:1948–1978) and **before** `env.update()`:
```js
wx.update(dt, now, ctx);
const G = wx.grade;
sun.intensity    *= G.sunMul;
hemi.intensity   *= G.hemiMul;
moon.intensity   *= G.moonMul;
sunBall.material.opacity *= G.sunBallA;  sunHalo.material.opacity *= G.sunBallA;
skyMat.uniforms.top.value.lerp(SKY_OVERCAST_TOP, G.skyTintK);
skyMat.uniforms.bot.value.lerp(SKY_OVERCAST_BOT, G.skyTintK);
scene.fog.color.lerp(_c.setHex(G.fogTint), G.fogTintK);      // THE ONE LERP
scene.fog.density = fogFor(rig.fogDist, env.biome) * G.fogMul;
starMat.opacity *= G.starMul;
roadMat.color.lerp(ROAD_WET, G.wetK); roadMat.roughness = .92 - .45 * G.wetK;
document.documentElement.style.setProperty('--flash', G.flash.toFixed(3));
windClock += (now - windLast) * G.windMul; windLast = now;   // drive spins/sways off windClock,
                                                             // NOT off `now` (multiplying `now`
                                                             // teleports the sails)
```
`fogFor(...) * G.fogMul` must **also** be applied in `refreshFraming()`, or a re-frame stamps the
mist away.

`hardReset()` → `wx.setSeed(daySeed, Date.now(), lat, env.biome); wx.reset();`
`fireMilestone` → `wx.event('milestone' | 'best' | 'tierUp', data)`;
`placeLandmark` → `wx.event('landmark')`; `startRitual` → `wx.event('boot')`.
`initNews({ country: () => env.news().concat(wx.news()) })`.
`#wxChip` in the header, on the existing 500 ms tick: `wxChip.textContent = wx.glyph + ' ' + wx.label`.

Environs reads `uGust/uCloud/uWet/uCover/uDust` off the bus. The bus is **frozen at eight
entries** — environs' rain-pocked water must ride `uWet` (high for the whole shower, decaying
slowly after it), *not* a `uRain` that does not exist.

### 6.10 Bench hooks (stage A, but the town.js half)

```js
const BENCH_ON = Q.get('bench') !== null;
let bench = null, benchPinned = false;

function tick(now) {
  const t0 = performance.now();           // FIRST statement
  …
  if (!benchPinned) { idle orbit drift }  // the rig's drift must be freezable
  …
  if (bench) bench.sample(now, t0, {      // LAST statement, after post.render()
    buildings: houses.length, villagers: npcs.count, spawnQ: spawnQ.length,
    lod: lod.mode, hot: lod.hotCount, impostors: lod.activeCount
  });
}
function pinCamera(cam) { benchPinned = true; if (cam) { /* az,pol,dist */ rig.snap(); } }
function probe() { return { ...lod.stats(), grounding: grounding.count, wxDraws: wx.__draws }; }
// hardReset(): bench && bench.reset()   ← at the very END of hardReset
// two bench.add around plan.paintGround:
//   const p0 = performance.now(); plan.paintGround(g, X, opt);
//   bench && (bench.add('paintGroundCalls'), bench.add('paintGroundMs', performance.now() - p0));
// bottom of file:
//   if (BENCH_ON) bench = (await import('./bench.js')).initBench(renderer, Q, { feed: onData, pinCamera, probe });
```

---

## 7. THE TEARDOWN REGISTRY (backlog §5 risk 3 — mechanical, and it fails the build)

Add this **one list** to `hardReset()` (town.js:1620) and one to the shutdown path:

```js
// hardReset() — epoch switch
post.reset();  surface.reset();  grounding.reset();  lod.reset();  rig.reset();
ui.reset();    wx.reset();       memorial.reset();   almanac.reset();
chronicle.reset();  charter.reset();
bench && bench.reset();          // LAST — a reset IS the teardown the leak bench waits for

// shutdown (window unload / before-quit)
ui.dispose(); almanac.dispose(); memorial.dispose(); lod.dispose(); grounding.dispose();
wx.dispose(); rig.dispose(); post.dispose(); surface.dispose();
chronicle.dispose(); charter.dispose(); bench && bench.dispose();
```

Order matters in exactly two places: `bench.reset()` last (it interprets the reset as the
epoch teardown signal), and `post.dispose()` late (it restores `renderer.toneMapping` and
`info.autoReset`, so anything that reads `renderer.info` must be gone first).

**Verified in Node**: 20 `reset()` cycles across all eleven modules re-mint **zero** geometries,
materials or textures; `dispose()` returns the scene to empty and removes every window and canvas
listener.

---

## 8. CROSS-MODULE HAZARDS — read all eight before you write a line

### 8.1 **BLOCKING — `interact.js` hover breaks under `lod.js`'s re-parenting**

`interact.js:326` resolves the group a hit belongs to by walking up to the *direct child of the
scene*:
```js
function groupOf(o) { let g = o; while (g && g.parent && g.parent !== scene) g = g.parent; return g; }
```
E1's wiring parents every settled house under `coldRoot` and every popping one under `hotRoot`.
`groupOf()` then returns **`coldRoot`/`hotRoot`**, so `armLift()` scales the *entire town* by 1.03
and the deed's anchor lands at the world origin.

Worse: settled houses **leave `hitTargets`** (lod wiring point 5), and `interact.js` has no
`lod` in its config and never calls `lod.pick()`. **After stage E, clicking a settled building
does nothing at all.** `lod.js`'s author expected `town.js` to own the hover; `interact.js`'s
author took ownership of it. Neither is wrong; nobody joined them up.

**Fix, in stage F, in `interact.js`:**
```js
// 1. group resolution by ownership, not by scene depth
function groupOf(o) {
  let g = o;
  while (g && !(g.userData && g.userData.ent) && g.parent && g.parent !== scene) g = g.parent;
  return g;
}
// 2. cfg gains `lod` (optional, null-safe) and pickAt() merges the two picks:
if (can(lod, 'pick')) {
  const ord = lod.pick(ray);
  if (ord >= 0 && lod.pickDist < dist) {
    ent = houses[ord]; group = ent && ent.group; dist = lod.pickDist;
  }
}
```
`lod.pick()` is an exact ray/OBB test that is correct in **every** tier (2.8 µs, ~20 box tests),
which is the whole reason it exists. `cfg.lod` must be optional so `interact.js` still runs before
stage E.

### 8.2 **BLOCKING (stage H) — three writers of `scene.fog.color`**

Backlog §4.2 pins **one** writer. Today there are two:
* `town.js:1958` `scene.fog.color.copy(bot)` — the base. Correct, keep.
* `environs.js:1471–1474` `fog.color.lerp(...)` inside `stepWeather()` — **must be deleted by
  S4 (wave 2 ENV lane)**.

`weather.js` adds the third (`G.fogTintK` lerp). **Do not wire the weather lerp until S4's
handover lands in the same commit**, or a misty day gets haze-tinted twice and `environs`'
`U.uFog` (line 1474) reads a colour nobody agreed on.

### 8.3 **BLOCKING (stage C) — `env.landFar()` does not exist**

`surface.js` needs it (`SURF.uLandFar`) and `environs.js` does not export it. `environs.js` holds
the value internally as `U.uLandFar` (environs.js:385, default `0x6A6E62`, rewritten every frame
at environs.js:1499). Add the two-line getter to `environs.js`'s public surface (line 1656):
```js
landFar: () => U.uLandFar.value,
```
**Also note a real drift:** `surface.js`'s `DEFAULTS.uLandFar` is `0x8A9470`; environs' is
`0x6A6E62`; `memorial.js`'s `COOL_LAND` is `0x6A6E62`. Until the getter is wired, `surface.js`
fades the town to a *different* colour from the one the countryside fades to — which is precisely
the defect F4 exists to fix. Either wire the getter in the same commit or change `surface.js`'s
default to `0x6A6E62`.

### 8.4 Photo mode double-vignettes under postfx

`interact.js`'s sheet ships `body.photo { --vig: .30 }`. `postfx` holds `--vig: 0` as an **inline
style on `documentElement`**. `.stage::after` (index.html:74) is a descendant of `<body>`, so the
`body.photo` declaration **wins** — photo mode gets the shader vignette *and* a 0.30 CSS one.
Fix (one of): drop the `body.photo{--vig:.30}` rule from `interact.js`'s CSS once postfx ships, or
raise postfx's `uVignette` in photo mode instead. Cosmetic, not blocking.

### 8.5 `getBuildings()` is too narrow for the tour

`town.js:744` returns only `{pos, yaw}`. §4.4 requires `{pos, yaw, idx, kind, label, flavor, tier}`
(landmarks carry negative synthetic `idx`). `camera.js`'s default 6-shot reel filters on
`e.kind === 'landmark'` and prints `e.label`. Degradation is graceful — the landmark shot is
skipped and the "newest" shot picks the wrong entry — but **the tour is a 4-shot reel until F1
widens this**, and C4's acceptance (`--cam=tour:2` shows an arrived shot with its caption) will
not pass. Widen it in stage B.

### 8.6 Two `buildings.js` exports the modules need and do not have

* **`deriveImpostor(group, e) → {w,d,h,y0,rh,rk,rw,rd,ry,rY,wall,roof,ch?,extra?}`** — `lod.set()`'s
  sixth argument. Without it every building registers as `live[i] === 2` (no impostor) and is
  **pinned to FULL** — lod runs, leaks nothing, and saves nothing. E1's whole win depends on it.
* **`winCache`'s material** — `buildings.js:590` is a module-private `Map<hex, Material>`.
  `lod.js` takes `cfg.winMat` so town.js's one `emissiveIntensity = winI` write lights the
  impostor panes too. Export the shared material (or a `winMatFor(hex)` accessor). Without it lod
  mints its own and drives it from `ctx.night` with the same curve — correct, but one extra
  material and a possible two-frame mismatch at dusk.

Also needed, from the F8/LAY lane: **`layout.js` must export `archetypeOf(seed)`** — `chronicle.js`'s
`identify` callback cannot name a past day's town without it. Harness-verified against
`buildPlan(s).kind` over 200 real day seeds.

### 8.7 Nothing parses `--cam=`

`camera.js` deliberately exposes `tour(N)`/`follow(h)`/`photo(on)` and parses no flags;
`interact.js` parses only `select` and `shot-ui`. **`town.js` must parse `?cam=`** or the C4/C5/C6
acceptance shots are unreachable:
```js
const CAM = Q.get('cam');
if (CAM) schedule(600, () => {
  if (CAM === 'photo') rig.photo(true);
  else if (CAM === 'follow') rig.follow(npcs.nearest({ x: 0, y: 0, z: 0 }, 500));
  else if (CAM.startsWith('tour')) rig.tour(+(CAM.split(':')[1]) || true);
  else rig.orbit({ snap: true });
});
```

### 8.8 `bench.pin()` changes the pixel ratio behind postfx's back

`bench.js`'s `pin()` calls `renderer.setPixelRatio(1)` during the settle phase. `postfx` samples
`renderer.getPixelRatio()` only inside `setSize()`, so its render targets keep the pre-pin
resolution for the rest of the run and the bench measures the wrong fill cost. **Call
`post.setSize(stage.clientWidth, stage.clientHeight)` from `pinCamera` (or add a `post.setSize`
call to the pin hook).** Same applies to `--bench-dpr=native`.

---

## 9. QUERY-FLAG MAP (who reads what)

| flag | parsed by | effect |
|---|---|---|
| `post=off\|med\|high` | `town.js` → `initPost` | postfx tier |
| `cam=orbit\|tour:N\|follow\|photo` | **`town.js` (§8.7 — not yet written)** | camera mode |
| `select=house:120\|altar\|landmark:<id>\|villager:0` | `interact.js` (self, from `location.search`) | opens a deed + moves the camera |
| `shot-ui=0` | `interact.js`, `almanac.js` | `body.noui`; almanac goes dormant |
| `ui=0` | `almanac.js` | almanac dormant |
| `almanac=0\|1\|<dayIdx>` | `almanac.js` | dormant / today pinned / that day pinned |
| `wx wxi wxcover season moon hour` | `weather.js` (self) | pinned regime / intensity / snow cover / season / moon phase |
| `chronicle=demo\|fake\|off` | `town.js` → `synthChronicle` | synthetic 46-day chronicle |
| `ledger=1` | `charter.js`/`index.html` (B3, wave 3) | honours panel visible during a shot |
| `bench bench-*` | `bench.js` (self, via `Q`) | the harness |
| `limits limit-reset mix hide` | `datafeed.js` (D1/D2, wave 2) | depth test hooks |

Both `interact.js` and `almanac.js` read `location.search` **directly** — they are self-contained;
the only wiring is main.js's forward list (§3.1).

---

## 10. PER-MODULE VERDICT AND BLOCKING RISK

| module | verdict | blocking risk for the integrator |
|---|---|---|
| **postfx.js** | conformant (+`reset()`, `makeGrade()`, `heatOf()`) | **Medium.** Needs L1b's light rebalance in the same commit (§6.4.2) and `info.autoReset` discipline (§6.4.1). GLSL compilation of four programs is unproven headlessly. §5-risk-7 re-tune of the sky/veil/mote/monument `ShaderMaterial`s lands with it — they stop bypassing output encoding, and additives go softer (raise particle/beacon opacity 20–35 %). |
| **surface.js** | conformant, zero contract deviations | **Medium.** `env.landFar()` missing (§8.3) and the colour default drifts. `onBeforeCompile` ordering (§6.4). GLSL compilation unproven. Ships with postfx or not at all. |
| **grounding.js** | conformant (+`reset()`, read-only getters) | **Low.** Self-contained. One `place()` in `mountEnt`, one `update()` in `tick`. The `onBeforeCompile` patch degrades to flat-alpha if a chunk is renamed — never to a black screen. |
| **camera.js** | conformant, zero deviations; five additive extras | **Medium.** The biggest single `town.js` deletion in the wave. `getBuildings()` must be widened (§8.5). Nothing parses `--cam=` (§8.7). `rig.walkTo` and `rig.stroll` do not exist — **`interact.js` already guards both correctly** (`actAvailable`/`can(rig,…)`), so the camera author's warning about `interact.js:387` is stale; verified, no action needed. |
| **interact.js** | drifted — three documented deviations, all sound | **HIGH.** §8.1 is a genuine break: `groupOf()` plus the missing `lod.pick` handshake means no settled building is clickable after stage E. Fix in the same commit as LOD. Also §8.4. |
| **lod.js** | drifted (3 additive deviations: 3 tiers not 2, owns the pick, `cfg` shape) | **HIGH.** Needs `deriveImpostor()` and the `winCache` export (§8.6), plus the `hotRoot`/`coldRoot` split and the `dropGroup` change. Land with §8.1's interact fix. |
| **bench.js** | drifted (6 deliberate deviations incl. a frame pump and page-driven scene loads) | **Medium.** A whole main.js protocol (§3.3). It is also the *first* thing to land, because everything downstream is a ratio against its baseline. `pin()` vs postfx sizing (§8.8). |
| **chronicle-store.js** | drifted (CJS, lives in `main/`, min-as-first-write-wins, wider `SYNTHETIC`) | **Low.** Four files, ~6 lines. Only the `queued.unshift` ordering (§3.5) is easy to get wrong. Needs a real `ipcMain` pass (`removeHandler` availability). |
| **chronicle.js** | drifted (coded to §4.7's store shape, not v4-history's; several additive helpers) | **Medium.** Requires `layout.js`'s `archetypeOf(seed)` export. Zero imports, no GPU, no DOM — the safest large module in the fleet. Real Canvas2D pixels are unproven (mock ctx only). |
| **memorial.js** | conformant (4 documented deviations, all sound) | **Low–Medium.** `ents` must be registered with `tagEnt`/`addHit` **once, at init** — the groups outlive epochs. `cfg.pressure` is a method, not a view field. Two acceptance numbers (`GHOST_R`/`GHOST_P`) are screenshot-tuned. See §11 for the one wall-clock exception. |
| **almanac.js** | drifted (`hide()` not `hideCard()`, no `showMap()`, three mirrored formulas) | **Low.** Mounts itself; degrades to nothing without a header or a painter. `canShow` must be wired to the chrome arbiter or the card and the deed can co-exist. |
| **charter.js** | drifted (3 documented deviations: `totals` are records not sums, extra `last` key, cut methods absent) | **Low.** Pure state machine, zero geometry. The only real work is `fillDayFacts()` telling the truth. `news.js` needs `CAT_OF.badge = 'BADGE'` + a corpus (wave 2); until then `news.post('badge', …)` is ignored by design and the badge still floats and bursts. |
| **weather.js** | drifted (5 deviations, incl. an **inverted `coldness` sign fixed** and `goldhaze` replacing the cut drought) | **Medium.** §8.2 is the hazard. Zero meshes this wave, so zero draw calls on every day — verified. Clear-day identity is **exact**: every scene multiplier is 1.0 and every tint 0.0 to machine precision. |

---

## 11. DESIGN-LEVEL NOTES LEFT FOR THE INTEGRATOR (not fixed here)

1. **`memorial.js`'s inlay reveal is per-frame, not wall-clock.** `update()` runs
   `inlayK += (want - inlayK) * .06` with no `now` term. At 1 fps a 9 s capture reaches ~0.35 of
   the target instead of settling. The bar *exists* in the shot (which is what the acceptance
   criterion asks) but is not at its final height. Everything else in the file — pennants, the
   ghost, the re-cut — is correctly wall-clocked. Convert to
   `inlayK += (want - inlayK) * (1 - Math.exp(-wdt / .45))` if the H3 shot looks wrong.
2. **`postfx.heatOf({})` is 0.044, not 0** — `paceRatio` defaults to 1, which sits above the 0.8
   floor. The effect is +0.002 contrast; harmless, but do not assert `heatOf({}) === 0` in a test.
3. **`camera.js` and `interact.js` register `window` listeners even when handed no canvas.** A
   "null object" instance of either is not free (6 and 1 listeners respectively). Both `dispose()`
   correctly. Only matters if you instantiate them speculatively.
4. **`initLod(null, cfg)` throws** (`scene.add` on null) where every other module returns a frozen
   no-op. `lod.js` documents "absent camera ⇒ no-op" but not "absent scene". Wave-0 call sites
   always have a scene, so this is a robustness note, not a bug.
5. **`bench.js`'s comment at line 525** ("info.autoReset is true, so the counts are only readable
   there") is stale once postfx lands. The *behaviour* is right; the comment will mislead the next
   reader.
6. **`chronicle-store.js`'s `SYNTHETIC` set is wider than town.js's.** `--demo=fast` and `--range=`
   make the store read-only but do not set `FORCE_DEMO` in `town.js`. The error is in the safe
   direction (never persist a fabricated number), but the two definitions should converge.
7. **`weather.js` publishes `uCloud = 0.065` at rest**, not the bus default `0.1`. `environs.js`
   derives its cloud count from `uCloud`, so a clear day has slightly fewer clouds than v3. This is
   correct by design (`cloud0` is the per-day resting value) — just do not read it as a regression.

---

## 12. WHAT THE HARNESS ALREADY PROVED (so you need not re-prove it)

`scratchpad/v4-smoke/smoke.mjs` — 195 assertions, 0 failures, real vendored three r160:

* all 13 modules import cleanly side by side; every §4.1/§4.2/§4.3/§4.6 export name present, in order
* `SURF` is exactly the seven pinned names in the pinned order; `WX` is exactly eight entries
* every module instantiates against plausible stubs and survives **300 frames + 20 epoch resets**
  with **zero** geometry / material / texture drift
* `dispose()` on all eleven leaves the scene empty, zero window listeners and zero canvas listeners
* `surface.js`'s four role variants inject correctly into the **real** `ShaderLib.standard`, every
  referenced uniform is present **and shared by reference**, and the patch is idempotent
* `grounding.js`'s two chunk replacements bite on the real `ShaderLib.basic` and bind `uGFade`
* postfx pass structure is **10 / 7 (tilt 0) / 5 / 1**; `headless:true` never downgrades across
  3 000 × 300 ms frames; `renderer.toneMapping` and `info.autoReset` are restored exactly
* weather's clear-day grade identity is **exact** — every `*Mul` is 1.0 and every tint 0.0
* `chronicle.dayIndexOf ↔ msOfDayIndex` round-trips over 3 000 days; `almanac.js`'s mirrored
  calendar agrees with it across a year end
* the §6 copy gate passes over every string literal in all 13 files

**One defect was found and fixed** in staging: `interact.js`'s `MODE_TOAST.stroll` contained the
banned substring `come back` (§6). Reworded to `'Down at street level · <kbd>Esc</kbd> for the
whole town again'`. (The line is for the cut stroll mode and is unreachable this wave, but the
copy gate is mechanical.)

**Still needs an in-app pass** (no GL context in Node): GLSL compilation of postfx's four programs
and surface's/grounding's patched ones; that MSAA-on-RT resolves; real `renderer.info` values;
`capturePage()` catching the intended frame; real Canvas2D pixels for `paintSkyline`; and every
number in the lookdev histogram gates.
