# Token Town v4 — INTERACTION & CAMERA

**Area owner:** interaction · **Status:** design, ready to implement after v3 polish lands
**Read first:** `REDESIGN-V3.md` §0 (file ownership), §2 (ctx), §9.4 (framing), §13 (invariants).
Everything below obeys §13 unless it says otherwise *and says why*.

---

## 0. THE DIAGNOSIS (why this wave exists)

Look at `base-day.png`. It is a beautiful picture and it is **untouchable**:

| what the app renders | what the user can see of it |
|---|---|
| 130 villagers, gaits, lanterns, contact discs | 4–6 px smudges; you cannot tell they are people |
| 8 house tiers, seeded roofs, 3 rarity variants | ~18 px each; tier reads only as "big/small" |
| speech bubbles, worship rite, bridge-watchers | rejected by `bubRange2Of` half the time at dist 210 |
| a hover tooltip with a real receipt on every object | requires knowing tooltips exist, and hits a 20-px target |
| a monument that escalates through 11 silhouettes | the one thing that *is* legible |

The camera is a **single fixed relationship** — orbit the centre of mass at
`r·1.32…1.45 + 20`, drag to spin, wheel to zoom, dblclick to reset. There is exactly one
interaction verb (*look*) and one feedback channel (*hover text in an 11 px box*). The town is
a screensaver you are allowed to rotate.

v4's job in this area is one sentence:

> **Make the town a place you can go into, point at, and take a picture of.**

Three things do 80 % of that: (1) a camera rig that can *move somewhere* smoothly instead of
snapping, (2) **click → a deed card** that turns every rooftop into a receipt with a story,
and (3) a **cinematic tour** so the thing is worth leaving open on the second monitor. Follow-
a-villager and street-level stroll are the delight multipliers on top.

---

## 1. THE ONE ARCHITECTURAL DECISION — two new files

v3 §13.6 says *"No new npm dependencies. No new files under `town/`."* The npm half is
permanent. **The file half was a v3.0 single-pass scoping rule and it must be lifted for v4.**

`town.js` is already 2158 lines and is the file every other v4 area also has to touch. If
interaction lands inside it, the interaction implementer serialises against monument, news,
growth and layout work — the showrunner's parallel fleet collapses to a queue on one file.

**Proposal: two new renderer modules.**

```
town/src/renderer/camera.js      ~520 lines   the rig: state, easing, modes, input
town/src/renderer/interact.js    ~760 lines   picking, deed card, chrome, hotkeys, minimap, photo
```

Their contract with `town.js` is small and mechanical (§4, §6). Neither imports the other's
DOM; `interact.js` drives `camera.js` through the public rig only.

If new files are *refused*, the fallback is: `camera.js` content becomes one marked section in
`town.js` (lines 307–397 grow to ~430) and `interact.js` content becomes another (replacing
1760–1797 + 2041–2052). It works, and it costs the whole schedule. **Recommend: allow the two
files.** Everything below is written against the two-file version; every API is identical in
the fallback.

**Contention map for the showrunner:**

| file | what interaction touches | collision risk with other v4 areas |
|---|---|---|
| `camera.js` | **new — sole owner** | none |
| `interact.js` | **new — sole owner** | none |
| `town.js` | 9 surgical edits, all enumerated in §4 | HIGH — schedule these as one commit, early |
| `index.html` | 8 new elements + ~120 lines CSS, all additive | low (append-only) |
| `npcs.js` | +3 exported methods (§7.2) | medium — coordinate with npcs owner |
| `news.js` | +2 exported pure functions (§7.3) | low (pure, additive) |
| `main.js` / `preload.js` | +1 IPC handler for photo save (§9.3) | low |
| `layout.js` | **read-only** — minimap reuses `paintGround` as-is | none |
| `environs.js`, `monument.js`, `buildings.js` | **untouched** | none |

---

## 2. THE RIG — state model and the one piece of maths

### 2.1 State

Today's camera is six loose module-level `let`s in `town.js` plus three multiplier functions
whose product is applied in `applyCam()`. v4 keeps the same spherical rig and the same
`applyCam` shape, and adds exactly one idea: **every channel is a goal with a follower.**

```js
// camera.js — the whole state, one object, zero per-frame allocation
const g = { az: .62, pol: .40, dist: 62, tx: 0, ty: 3, tz: 0, fov: 46 };  // GOAL
const c = { az: .62, pol: .40, dist: 62, tx: 0, ty: 3, tz: 0, fov: 46 };  // CURRENT
const tau = { az: .10, pol: .10, dist: .18, t: .30, fov: .45 };            // per-channel, per-mode
```

`refreshFraming()` writes the **orbit goal** and nothing else. Modes write `g` and swap `tau`.
`c` is what `applyCam()` reads. That is the entire mechanism.

### 2.2 Easing — frame-rate independent, and headless-correct

```js
const approach = (cur, goal, tau, dt) => cur + (goal - cur) * (1 - Math.exp(-dt / tau));
const wrapPi = a => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };
// azimuth eases along the SHORT arc, or a 350° goal spins the town the wrong way round
c.az += (1 - Math.exp(-dt / tau.az)) * wrapPi(g.az - c.az);
```

**`dt` here is `wdt` (the clamped wall clock, ≤ .5 s), never the physics `dt`.** Where the
camera *is* is existence-visible in a screenshot, so v3 §13.2 applies: at 1 fps with `tau=.55`,
`k = 1-exp(-.5/.55) = .60` per frame, so a mode transition is 94 % complete after 3 frames
(3 s) and visually done inside a 7–9 s `--shot-delay`. Verified against the harness cadence in
§13.

**Never** use accumulated `dt` for *which* mode/shot is active — the tour's shot index, the
photo letterbox, the deed card's presence and the minimap all latch on `performance.now()`.

Two escape hatches, both required:

* `rig.snap()` — copies `g` into `c` in one call. Used by `?cam=` test hooks, the epoch
  teardown, and `orbit({snap:true})`.
* If `wdt > .34` **and** the transition is younger than 400 ms, snap instead of ease. A single
  hitching frame during a 420-building cascade must not leave the camera stranded halfway.

### 2.3 Composition with the existing multipliers

`applyCam()` keeps its exact current shape; the three biases survive and are **orbit-only**:

```js
function applyCam() {
  const bias = mode === 'orbit' || mode === 'tour'
    ? dollyBias() * introDist() * fitBias(c.az) : 1;
  const d = c.dist * bias;
  const p = clamp(c.pol + (mode === 'orbit' ? introPol() : 0), .06, 1.40);
  const y = Math.sin(p) * d, r = Math.cos(p) * d;
  camera.position.set(c.tx + Math.sin(c.az) * r, c.ty + y, c.tz + Math.cos(c.az) * r);
  camera.lookAt(c.tx, c.ty, c.tz);
  if (camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
}
```

`stroll` is the one mode that does **not** use the spherical rig: it writes
`camera.position` directly and calls `camera.lookAt(eye + forward)`. It is a branch inside
`applyCam()`, not a second camera object (§8.1). The upper polar clamp rises from 1.25 → 1.40
so the tour can do a genuine top-down plate shot.

`fitBias` becomes a pure function of the azimuth it is given (it already is, in effect) so the
tour can pre-evaluate it when choosing an approach angle.

### 2.4 Zoom, pan, inertia

| gesture | today | v4 |
|---|---|---|
| left-drag | 1:1 az/pol, no inertia | 1:1 into `g`, `tau.az=.10` (imperceptibly smoothed), **flick inertia**: on pointerup carry `vAz, vPol` (units/s, from the last 90 ms) and decay `v *= exp(-dt/.42)` into `g` until `|v| < .02` |
| wheel | `dist *= 1 + dy*.001`, clamp 14…340, sets `userDist` | goal-space, `tau.dist=.18`, clamp **6**…340 (6 lets you nose into a rooftop), plus **zoom-to-cursor**: shift `g.tx/g.tz` by 22 % of the ground-point delta under the pointer, so zooming in on the mill actually approaches the mill |
| right- or middle-drag | — | **pan**: move `g.tx/g.tz` in the camera's ground basis at `dist * .0016` per px; clamped to `bounds.r * 1.6` of the centre of mass so you cannot lose the town |
| dblclick empty ground | reset framing | unchanged (`orbit()`) |
| dblclick an entity | reset framing | **focus it** (§6.4) |
| `Space` / `Home` | — | `orbit()` — "give me the whole town back" |

**`userDist` decay.** Today one wheel click disables auto-framing until the user dbl-clicks,
so a session that starts at 40 buildings and ends at 450 spends four hours cropped. New rule:
`userDist` releases itself when the town has outgrown the user's framing —

```js
// on wheel: userDistAtR = ctx.bounds.r
// in update(): if (userDist && bounds.r > userDistAtR * 1.12 && now - lastWheel > 20000)
//                { userDist = false; toast('framing the whole town again'); }
```

Growth is the only thing allowed to take the wheel back, and only after 20 s of hands-off.

---

## 3. `camera.js` — the public surface (copy verbatim)

```js
/** @typedef {'orbit'|'focus'|'follow'|'stroll'|'tour'|'photo'} CamMode */

/** @typedef {Object} Anchor  world point a mode can lock onto
 * @property {number} x @property {number} y @property {number} z
 * @property {number} [hTop]   object height, drives the auto distance
 * @property {string} [id]     stable key; re-focusing the same id is a no-op */

/** @typedef {Object} Shot  one beat of the cinematic tour
 * @property {string} id
 * @property {()=>?Anchor} at        resolved at shot start; returning null SKIPS the shot
 * @property {number} [dist]         absolute; omit to derive from hTop
 * @property {number} [pol]          default .42
 * @property {number} [azRel]        approach angle relative to the CURRENT az; default +.9
 * @property {number} [fov]          default 40 (compression reads as cinema)
 * @property {number} hold           ms on this shot, INCLUDING the 1.6 s move in
 * @property {number} [spin]         rad/s drift during the hold; default .020
 * @property {(f:TourFacts)=>string} [caption]   one line, shown in #modePill */

/** @typedef {Object} CamConfig
 * @property {HTMLCanvasElement} canvas
 * @property {HTMLElement} stage
 * @property {(x:number,z:number)=>number} sampleHeight   env.sampleHeight
 * @property {()=>Plan} getPlan                            live plan (epochs swap it)
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings   ctx.getBuildings
 * @property {(h:*)=>?{x:number,y:number,z:number,yaw:number,alive:boolean}} resolveFollow
 * @property {(mode:CamMode, prev:CamMode, meta:*)=>void} onMode
 * @property {(s:Shot, f:TourFacts)=>void} [onShot] */

/** @param {THREE.PerspectiveCamera} camera @param {CamConfig} cfg @returns {CameraRig} */
export function initCamera(camera, cfg) { /* … */ }

/** @typedef {Object} CameraRig
 * ── read-only state ─────────────────────────────────────────────────────────
 * @property {CamMode} mode
 * @property {number}  dist        effective distance (post-bias) — replaces town.js `dist`
 * @property {number}  fogDist     what to hand fogFor(); ≥ 55 in stroll/follow (§8.4)
 * @property {THREE.Vector3} focusPoint    where the camera is looking (read-only)
 * @property {THREE.Vector3} shadowCenter  where the sun's shadow frustum belongs (§8.5)
 * @property {number}  shadowExtent
 * @property {boolean} moving      true while easing, dragging or touring
 * @property {boolean} dragging    @property {number} dragPx  px travelled this drag
 * @property {boolean} userDist
 * ── framing (town.js calls these) ────────────────────────────────────────────
 * @property {(b:{cx,cz,r,hx,hz}, monTop:number)=>void} setFrame
 * @property {(distMul:number, polAdd:number)=>void} setIntroBias
 * @property {(strength?:number, ms?:number)=>void} punch      the milestone dolly
 * @property {()=>void} snap
 * ── modes (interact.js calls these) ──────────────────────────────────────────
 * @property {(opts?:{snap?:boolean})=>void} orbit
 * @property {(a:Anchor, opts?:{dist?:number,pol?:number})=>void} focus
 * @property {(handle:*)=>boolean} follow      false if the handle is already gone
 * @property {(at?:{x:number,z:number})=>void} stroll
 * @property {(x:number,z:number)=>void} walkTo        stroll only; A* on plan.graph
 * @property {(on:boolean, shots?:Shot[])=>void} tour
 * @property {(on:boolean)=>void} photo
 * @property {(i:number)=>void} bookmark  @property {(i:number)=>boolean} jumpTo
 * ── utility ─────────────────────────────────────────────────────────────────
 * @property {(px:number,py:number,out:THREE.Vector3)=>boolean} screenToGround
 * @property {(wdt:number, now:number, ctx:TownCtx)=>void} update   ONE call per frame
 * @property {()=>void} dispose */
```

### 3.1 Mode table — the binding behaviour spec

| mode | `g.dist` | `g.pol` | `g.az` | target | idle drift | auto-frame writes | exits via |
|---|---|---|---|---|---|---|---|
| **orbit** | `setFrame` (or user wheel) | user, def .40 | user + drift | bounds centre of mass | **yes**, `.045 rad/s` after 3 s idle | applied live | — |
| **focus** | `clamp(hTop*3.4+8, 14, 46)` | `.52` | current + `.55` | anchor + `hTop*.55` on y | **yes**, `.018 rad/s` | buffered, not applied | Esc · Space · dblclick empty · 45 s no input |
| **follow** | `11` (`8` if `hTop`<2) | `.30` | `npc.yaw + π`, `tau.az = 1.4` | head, `y = 1.15`, `tau.t = .16` | no | buffered | Esc · Space · villager gone |
| **stroll** | n/a (free) | pitch ±.9 | mouse-look | eye at `sampleHeight+1.72` | no | buffered | Esc · Space · `G` |
| **tour** | per shot | per shot | per shot | per shot | shot `spin` | buffered | Esc · `T` · any drag/wheel |
| **photo** | `prev.dist * .86` | prev | prev + slow drift | prev | `.012 rad/s` | buffered | Esc · `P` |

**"Buffered"** means: `setFrame()` keeps updating the *orbit* goal in the background the whole
time, so `orbit()` from any mode returns to a framing that is correct for the town as it is
**now**, not as it was when you left. This is what makes leaving a mode feel free.

`punch()` and the intro biases are **ignored outside orbit/tour** — a milestone must not jerk
the camera while the user is reading a deed card or walking a street.

### 3.2 What camera.js owns in the DOM

Only the canvas pointer/wheel listeners and `keydown` for WASD **while `mode === 'stroll'`**.
Every other key belongs to `interact.js`. To keep click and drag from fighting:

```js
// interact.js treats a pointerup as a CLICK only when:
rig.dragPx < 5 && (performance.now() - downAt) < 400
```

`camera.js` exposes `dragPx` for exactly this. No `preventDefault` on left-click; `wheel` keeps
`{passive:false}` + `preventDefault` as today; right-drag adds
`canvas.addEventListener('contextmenu', e => e.preventDefault())`.

---

## 4. `town.js` SURGERY — the complete, enumerated diff

Nine edits. Schedule as **one early commit**; everything else in this area is additive.

| # | today (line) | v4 |
|---|---|---|
| 1 | 310–397 — the whole camera block (`target`, `az/pol/dist/idleT/userDist/dollyT`, `dollyBias`, `fitBias`, `applyCam`, `drag`, `wheel`, `dblclick`) | **deleted**, minus `dollyBias/introDist/introPol/fitBias`, which move **into camera.js** verbatim; `sunCtr` stays (it is the sun's target, not the camera's) |
| 2 | after the `monument`/`env` wiring | `const rig = initCamera(camera, {...})` — must be created **after** `env` (needs `sampleHeight`) and **before** the first `refreshFraming()` |
| 3 | 347 `if (!userDist) dist = clamp(...)` | `rig.setFrame(b, monTop);` — the clamp formula moves into `camera.js` unchanged |
| 4 | 349 `scene.fog.density = fogFor(dist, env.biome)` | **moves into `tick()`**: `scene.fog.density = fogFor(rig.fogDist, env.biome)` — the distance is now continuous, so a once-per-structural-change write leaves the fog wrong for 8 s of a tour |
| 5 | 355–359 shadow frustum from `b` | `const ext = rig.shadowExtent; …; sunCtr.copy(rig.shadowCenter)` (§8.5) |
| 6 | 1022, 1213 `if (!userDist) dollyT = performance.now()` | `rig.punch()` |
| 7 | 1426–1429 `introDist()/introPol()` | keep the functions where they are, and add in `tick()`: `rig.setIntroBias(introDist(), introPol())` |
| 8 | 1965 `fx = clamp(dist / 62, 1, 3.4)` | `fx = clamp(rig.dist / 62, 1, 3.4)` |
| 9 | 2038–2039 `idleT += dt; if (idleT>3) az += …; applyCam()` | `rig.update(wdt, now, ctx)` — **wdt, not dt** |
| 10 | 1761–1797 hover block + 2041–2052 in `tick()` | deleted; `tipFor` is **renamed `describeEnt` and exported through the interact config** (§6.2); `interact.update(now, ctx)` replaces the tick block |
| 11 | 1589 `hardReset()` | add `rig.orbit({snap:true}); ui.clearSelection();` — an epoch teardown must not leave you following a villager who is about to be deleted |
| 12 | 2148 `renderer.render(scene, camera)` | append `ui.afterRender()` — the photo grab must read the drawing buffer **in the same task as the render** (§9.2) |

Three small **additions** to `town.js`, all pure and ≤ 25 lines each:

```js
// (a) which slice of the day paid for building n  — the deed card's best line
let _payKs = null, _payCum = null, _payAt = -1e9;
function payIndex() {                                  // rebuilt at most 1 Hz, ≤ 500 bins
  if (performance.now() - _payAt < 1000 && _payKs) return;
  _payAt = performance.now();
  _payKs = [...bins.keys()].sort((a, b) => a - b);
  _payCum = new Float64Array(_payKs.length + 1);
  for (let i = 0; i < _payKs.length; i++) _payCum[i + 1] = _payCum[i] + bins.get(_payKs[i]).tok;
}
/** @returns {?{ms:number,wMs:number,tok:number}} the bucket whose tokens crossed
 *  the price of building n — i.e. the stretch of your day that bought this house. */
function paidFor(n) {
  payIndex();
  const need = tokensFor(n), L = _payKs.length;
  if (!L || _payCum[L] < need) return null;            // folded history doesn't reach: card omits the row
  let lo = 0, hi = L;
  while (lo < hi) { const m = (lo + hi) >> 1; if (_payCum[m + 1] < need) lo = m + 1; else hi = m; }
  const b = bins.get(_payKs[lo]);
  return { ms: _payKs[lo], wMs: b.w, tok: b.tok };
}

// (b) the newest / grandest / a random standing landmark — the tour's shot sources
function shotSources() { /* {newest, grandest, landmarks:[], bridges:[], gate, altar} */ }

// (c) exposed for interact.js
export? no — passed in the initInteract config object. town.js stays a script module.
```

---

## 5. `interact.js` — the public surface

```js
/** @param {InteractConfig} cfg @returns {InteractUI} */
export function initInteract(cfg) { /* … */ }

/** @typedef {Object} InteractConfig
 * @property {HTMLElement} stage @property {HTMLCanvasElement} canvas
 * @property {THREE.Scene} scene @property {THREE.PerspectiveCamera} camera
 * @property {CameraRig} rig
 * @property {Array<THREE.Object3D>} hitTargets     town.js's live array — shared, not copied
 * @property {NPCSystem} npcs
 * @property {(e:Entity)=>Deed} describe            town.js's ex-`tipFor`, widened (§6.2)
 * @property {()=>ShotSources} sources              for the tour + [ ] browse
 * @property {()=>Plan} getPlan
 * @property {(seed:number)=>{name:string,trade:string}} villager   news.villagerFor
 * @property {(msg:string, ms?:number)=>void} [toast]
 * @property {(name:string,dataURL:string)=>Promise<string>} [saveShot]   preload bridge */

/** @typedef {Object} InteractUI
 * @property {(now:number, ctx:TownCtx)=>void} update      called from tick(), after rig.update
 * @property {()=>void} afterRender                        photo grab; after renderer.render
 * @property {(e:?Entity)=>void} select                    programmatic (test hooks, tour)
 * @property {()=>void} clearSelection
 * @property {(msg:string, ms?:number)=>void} toast
 * @property {()=>void} dispose */
```

`interact.js` owns: the raycast + NPC pick, `#tip`, `#deed`, `#mini`, `#modePill`, `#toast`,
`#keys`, `#sheet`, `#bars`, the selection ring mesh, every `keydown` except stroll's WASD, and
the photo grab. It creates **one** `THREE.Mesh` (the selection ring) and nothing else in 3D.

---

## 6. TOUCHING THINGS — picking, hover, the deed card

### 6.1 Picking

```
pointermove → cache NDC (as today)
every 50 ms in update():
  1. ray.setFromCamera(ndc, camera)
  2. entHit = ray.intersectObjects(hitTargets, true) → nearest with userData.ent
  3. npcHit = npcs.raycast(ray)                       → {handle, dist} or null   (§7.2)
  4. hover = whichever distance is smaller
```

`npcs.raycast` must **not** use `InstancedMesh.raycast` (it tests 160 instances against full
geometry through a matrix inverse each). It is a closed-form ray/sphere test over the live
`npcs[]` array — 160 iterations of ~12 flops, zero allocation, ~4 µs. Spec in §7.2.

**Cursor + hover lift.** `#gl` gets `cursor:pointer` when `hover` is non-null (today it is
always `grab`/`grabbing`). The hovered entity's group gets `scale = baseScale * 1.03` eased
over 140 ms and — for houses only — a `+0.35` bump on its `winMats` emissive so it visibly
"wakes up". Both restore on hover-out. This is the single cheapest signal that the town is
touchable, and it costs one lerp on one group per frame. It must be applied **after** the
`popT`/`bumpT` block in `tick()` or the scale fight is visible; `interact.update()` runs after
that block, so ordering is already correct.

The existing `#tip` stays exactly as it is for hover (it is good), with two additions: a
villager line (§7.4) and a fourth muted row `— click for the deed` on the first three hovers of
a session only.

### 6.2 `describe(entity) → Deed` — town.js widens `tipFor`

```js
/** @typedef {Object} Deed
 * @property {string} title              'Villa'
 * @property {string} [badge]            '✦ Painted Lady'   gold pill beside the title
 * @property {string} sub                '#142 of 431 · band 3'
 * @property {Array<[string,string]>} rows   ≤ 5 label/value pairs
 * @property {string} [flavor]           ONE italic line, Crier voice
 * @property {string[]} [acts]           action ids: 'focus'|'follow'|'walk'|'tour'
 * @property {{x,y,z,hTop}} at           anchor for focus + the selection ring
 * @property {boolean} [live]            re-render rows once a second (monument only) */
```

The card is **docked**, not floating: `left:16px; bottom:16px` inside `.stage`, 306 px wide,
slide-up-and-fade in 220 ms. A floating card near the cursor gets clipped by the footer and
jitters against the idle orbit; a docked card plus a **gold ring on the ground under the
subject** binds card to object far better and never occludes the town's centre.

**Selection ring:** one `THREE.Mesh(new THREE.RingGeometry(r*.92, r*1.0, 40).rotateX(-π/2))`,
`MeshBasicMaterial({color:0xF3D07A, transparent:true, opacity:.55, depthWrite:false,
blending:AdditiveBlending})`, `renderOrder = 2`, `raycast = () => {}` (or it becomes its own
hover target). `r = max(2.2, hTop*.55)`; opacity breathes `.42 + .13*sin(now/620)` — wall-clock,
so a headless shot always catches it lit.

### 6.3 The card content — this is where the charm lives

**House** (the 95 % case):

```
  Villa                                   ✦ Painted Lady
  #142 of 431 · band 3 · Millbrook

  broke ground     14:07  (3 h 12 m ago)
  cost             4.24M tokens
  paid for by      your 14:05–14:10 burst
  household        the Ashcotes · 4
  built of         plum walls, terracotta roof

  "The talk of the street, and they know it."
  [ Focus ]  [ Follow a resident ]
```

* **broke ground** — `fmtClock(paidFor(n).ms)`; falls back to `e.settledAt` when the bucket
  index doesn't reach (folded 6 h history on `range=all`).
* **cost** — `costOf(n) = tokensFor(n) - tokensFor(n-1)`. Already in `town.js` line 67, unused.
  This is the number that makes the whole town legible: *"that cottage cost me 4 million
  tokens."*
* **paid for by** — the killer line. `paidFor(n)` gives the bucket; word it by bin width:
  `w ≤ 5 min → "burst"`, `≤ 1 h → "push"`, else `"stretch"`. Copy:
  `your ${fmtClock(ms)}–${fmtClock(ms+wMs)} ${word}`. For a cascade-founded town this is real
  history the app has never shown before, and it is free — the data is already in `bins`.
* **household** — `news.villagerFor(e.seed)` gives a family name; size = `2 + (tier % 4)`.
  Flavor buildings say `keeper` instead (`the tavern · Wend Tarrow, keeper`).
* **built of** — `roofNameOf(e.idx)` + the wall name from the same palette (buildings.js
  already names roofs; if a wall name isn't exported, drop to roof only — do **not** widen
  buildings.js for this).
* **flavor** — `RARE_LINE` today; extend to one seeded line per tier from a 10-entry corpus in
  `news.js` (§7.3). Never repeat the row above it.

**Monument** (`live:true`, rows re-render at 1 Hz):

```
  The Orbital Reliquary                   tier 8 of 11
  consecrated 09:14 · Millbrook

  engraved         1.181B tokens this session
  next             Sky-Gate Arch at 1.58B · 36 %
  milestones       10 rung, 4 landmarks standing
  congregation     41 at the altar right now
  [ Focus ]  [ Tour the town ]
```

**Landmark** · **Bridge** · **Grove** · **Signpost** · **Scaffold** keep today's three lines and
gain one each: landmark → `the Nth of 9 · 214 buildings ago`; bridge → `crossed by 38 villagers
an hour` (from `npcs` bridge-state count, or drop it if npcs won't expose it); grove → `the town
planted 6 trees while you were away`; scaffold → `~14 min at your current pace`
(`(nx.tok-T)/perMin`); signpost → `founded 09:12 · seed 8F3A · 5th town this week` (`daySeed`
history is not persisted — use `plan.kindLabel` instead; do not invent persistence).

**Villager** (new kind, §7.4):

```
  Bramble Ashcote                         thatcher
  on their way to the altar

  walking since    16:02
  carrying         a lantern
  [ Follow ]  [ Where they live ]      ← the second only when state === 'home'
```

### 6.4 Verbs

| gesture | result |
|---|---|
| hover | `#tip`, cursor pointer, 1.03 lift |
| click | select → deed card + ring; the camera **does not move** (a card that also yanks the view is disorienting on a first click) |
| dblclick entity | select **and** `rig.focus(deed.at)` |
| click empty ground | deselect; ring fades in 180 ms |
| `Esc` | deselect, else exit the current mode, else nothing |
| card `[Focus]` | `rig.focus(deed.at)` |
| card `[Follow a resident]` | `npcs.nearest(deed.at, 26)` → `rig.follow(h)`; if nobody is near, toast *"nobody's home just now"* |

---

## 7. FOLLOW A VILLAGER — the delight bomb

### 7.1 Why it earns its place first among the "should"s

A villager is 4 px in the wide shot. Riding one puts you at `dist 11` where you can see their
gait, their hat, their lantern, the speech bubbles that `news.js` has always been able to
produce and that the wide framing rejects half the time, the worship rite, the bridge-watcher
who refuses to care about the new house. **The app already renders all of it.** Follow mode
costs ~90 lines and unlocks content that has been paid for and never seen.

### 7.2 `npcs.js` additions (3 methods, ~55 lines, no behaviour change)

```js
/** Closed-form ray/sphere pick over the live crowd. No allocation, no InstancedMesh.raycast.
 *  @param {THREE.Raycaster} ray @returns {?{handle:number, dist:number}} */
raycast(ray) {
  const o = ray.ray.origin, d = ray.ray.direction;
  let best = null, bt = Infinity;
  for (const n of npcs) {
    if (n.dying > 0) continue;
    const s = n.sEff || n.scale, r = .30 * s + .16;          // body+head capsule, generous
    const cx = n.x - o.x, cy = (.30 * s) - o.y + 0, cz = n.z - o.z;   // torso centre
    const t = cx * d.x + cy * d.y + cz * d.z;                 // projection along the ray
    if (t < .5 || t > bt) continue;
    const px = cx - d.x * t, py = cy - d.y * t, pz = cz - d.z * t;
    if (px * px + py * py + pz * pz > r * r) continue;
    best = n; bt = t;
  }
  return best ? { handle: best.seed, dist: bt } : null;
}

/** Resolve a handle to a live pose. Returns null once they despawn or the epoch resets.
 *  @param {number} handle @returns {?{x,y,z,yaw,state,seed,lantern,bornAt,alive}} */
track(handle) { for (const n of npcs) if (n.seed === handle) return _trk(n); return null; }

/** The villager nearest a world point, within r. @returns {?number} handle */
nearest(p, r) { /* one pass, squared distance */ }
```

Plus a **one-line protection** inside `despawn()` and the `desired` shrink path:

```js
let pinned = 0;                       // set by track()'s caller via npcs.pin(handle)
// in the shrink loop: if (npcs[i].seed === pinned) continue;   // never cull the star
```

`n.seed` is already unique per villager for its lifetime (`seedN++`, line 378) and is never
reused within an epoch — it is the natural stable handle. Nothing else in `npcs.js` changes.

### 7.3 `news.js` additions (2 pure exported functions, ~40 lines)

```js
/** Deterministic villager identity. 26 given × 22 family = 572 combos, 18 trades.
 *  @param {number} seed  n.seed or e.seed @returns {{name:string, family:string, trade:string}} */
export function villagerFor(seed) { /* srand-indexed table lookup */ }

/** One italic line for a deed card. @param {string} kind @param {number} seed */
export function deedFlavor(kind, seed) { /* 10 lines per kind, seeded, no repeats in a row */ }
```

Names must be Token-Town-shaped, not fantasy-shaped — the vibe bible (§1) says *earnest world,
deadpan framing*. Given: **Bramble, Wend, Hollis, Marrow, Tace, Pell, Oriel, Corbin, Ivy, Rook,
Sela, Fen, Ambrose, Nell, Quill, Tam, Vesper, Osric, Dove, Harrow, Linnet, Gable, Perrin, Mira,
Cass, Alder**. Family: **Ashcote, Millbank, Trueweather, Quenby, Larkfield, Cobbett, Standish,
Wray, Fenwick, Halloway, Beckwith, Applewhite, Thornbury, Pennell, Rushworth, Vance, Ockley,
Grimshaw, Maddox, Selby, Ferrers, Wickham**. Trade: **thatcher, cooper, chandler, wheelwright,
miller, scribe, ostler, brewer, mason, glazier, drover, fletcher, tanner, baker, sawyer,
carter, weaver, ledger-clerk**.

Deed flavor examples (kind `house`): *"Pays its tokens on time, mostly."* · *"Every window
faces the altar. This was not an accident."* · *"Built in an afternoon. Talked about for
weeks."* · *"The roof was a decision."*

### 7.4 The follow camera

```js
// per frame, mode === 'follow'
const t = cfg.resolveFollow(handle);      // → npcs.track()
if (!t || !t.alive) { toast(`${name} has gone in for the night.`); rig.orbit(); return; }
g.tx = t.x; g.ty = 1.15; g.tz = t.z;      tau.t   = .16;   // stay glued
g.az  = t.yaw + Math.PI;                  tau.az  = 1.40;  // the camera swings LATE round corners
g.dist = 11; g.pol = .30; g.fov = 52;     tau.dist = .5;
```

`tau.az = 1.4` is the whole trick: the camera lags behind their turns, which reads as a
handheld operator jogging after them rather than a rigid boom. On `state === 'worship'` the
rig eases out to `dist 16, pol .52, az` orbiting the altar at `.06 rad/s` — you watch the rite
rather than the back of a kneeling head.

`#modePill` shows `Following Bramble Ashcote, thatcher · Esc to let them go`, and updates its
second line from `t.state` through the same sentence table as the villager deed card
(*"on their way to the altar"*, *"stopped on the bridge, watching the water"*). The pill's text
is set on state change only, not per frame.

While following, `news.say()` should preferentially pick **this** villager: pass
`npcs.pickSpeaker` a new optional `prefer` handle, or (cheaper, no npcs change) have `town.js`
call `news.say(headPos, kind, {text})` directly for the followed villager every 5 s. Prefer the
latter — zero coupling, and it makes your companion chatty, which is the entire joke.

---

## 8. STROLL — street level

### 8.1 The camera

Free camera, not the spherical rig. `applyCam()` branches:

```js
if (mode === 'stroll') {
  const gy = cfg.sampleHeight(w.x, w.z);          // 0 inside plan.flatR by contract (§3.7)
  w.y += (gy + EYE - w.y) * (1 - Math.exp(-dt / .10));
  camera.position.copy(w);
  _look.set(w.x + Math.cos(pitch) * Math.sin(head), w.y + Math.sin(pitch),
            w.z + Math.cos(pitch) * Math.cos(head));
  camera.lookAt(_look);
  camera.fov = 60;                                 // eased from 46; the wide lens IS the scale cue
}
const EYE = 1.72;    // a Cottage is 3.5 — you are shoulder-height to a cottage. Correct and lovely.
```

**Motion:** `W/A/S/D` + arrows, `Shift` = jog. `walk = 5.4 u/s`, `jog = 10.5 u/s`. Head bob:
`y += .035 * sin(travelled * 2.1)` — dt-driven, cosmetic, exempt from §13.2. Mouse-look on
left-drag (`head -= dx*.0042; pitch = clamp(pitch - dy*.0036, -.85, .78)`); **no pointer lock**
(it hijacks the cursor on a machine the user is working on — banned).

**Click-to-walk** is the discoverable half: click the ground → `rig.walkTo(x,z)`. Route with
`plan.pathTo(nearestNode(from), nearestNode(to))` and walk the node chain at jog speed with a
1.1-unit corner radius, exactly like an NPC leg chain. Any WASD key cancels the auto-walk.
Minimap click does the same (§10).

**Collision** — soft, cheap, and *forgiving*, because this is a toy:

```js
// rebuilt whenever ctx.getBuildings() length changes: a 6-unit uniform grid of {x,z,r}
// per building, r = 1.9 (house) / 3.4 (landmark, from hTop>6)
// per frame: probe the 3×3 cells around the eye; for each hit with d < r + .55,
//   push the eye out along the normal. No sliding solver — one pass is enough at 5 u/s.
```
Water: `plan.isWet(x,z)` → refuse the step and toast *"you'd get your boots wet"* (once per
10 s). Outer bound: `hypot(x,z) < plan.flatR` — beyond that the terrain is environs' business
and the fields have no collision at all. On hitting the bound, toast *"the road out of town
is a v5 problem."*

### 8.2 Entering and leaving

`G` enters at the ground point under the cursor (or the screen centre), facing the altar.
The transition is a **2.2 s dive**: the orbit camera eases to `dist 18, pol .12` at that point,
and at `k > .82` the rig hands over to the walker with the same position and heading, so it
never cuts. Leaving (`Esc`/`Space`/`G`) is the same move reversed into the buffered orbit goal.

### 8.3 What stroll must not break

* **Bubbles.** `bubRange2Of(camDist)` gives `max(170, dist*.95+60)²`; at street level `camDist`
  is `cam.position.length()` ≈ the distance from the world origin, not from the town — a
  stroller at the far edge still reads ~200. Fine as-is. The screen-space rejection against
  `monPx` may drop more bubbles when the altar fills the frame; acceptable.
* **NPC scale.** Villagers are `.6 × 1.55 ≈ 0.93 units` tall against a 1.72 eye. They will read
  as **short**. This is the one visual risk of stroll mode. Options, in order of preference:
  (a) drop `EYE` to `1.35` — the user is simply a smaller person, nobody notices; (b) leave it —
  a slightly-too-tall camera is a normal videogame feeling. **Take (a).** Do not rescale NPCs;
  that would change every other shot in the app.
* **`fx` particle scaling** uses `rig.dist`; in stroll, report `fogDist`-style clamped
  `dist = 26` so bursts don't collapse to invisible specks.

### 8.4 Fog

`fogFor(10, biome)` = `.0016 * (6.2)^.30` = `.0027` — near the cap; you would stand in soup.
**`rig.fogDist` clamps to ≥ 55 in stroll/follow/focus-under-30.** One line, and it is the
difference between "a street" and "a fog bank".

### 8.5 Shadows

`renderer.shadowMap.autoUpdate === false`; the frustum is centred on the town's centre of mass
with `ext = min(b.r, 62) + 12`. At street level that means your immediate surroundings share a
2048² map with a 250-unit town → ~8 cm texels, mush.

```js
// camera.js
get shadowCenter() { return (mode === 'stroll' || mode === 'follow' || mode === 'focus')
                     ? _focusPt : _boundsCtr; }
get shadowExtent() { return (mode === 'stroll' || mode === 'follow') ? 34
                     : mode === 'focus' ? 48 : Math.min(bounds.r, 62) + 12; }
```

and in `tick()`, when `rig.moving` and the mode is one of those three:
`renderer.shadowMap.needsUpdate = true` at ≤ 12 Hz (throttle on `performance.now()`). A moving
frustum with a stale map is worse than no shadows. Budget: one extra depth pass per 83 ms only
while a close mode is active, which is exactly when the scene's caster count is smallest.

---

## 9. PHOTO MODE

### 9.1 The look

`P` → `body.classList.add('photo')`.

* `header`, `#news`, `footer`, `#tip`, `#deed`, `#mini`, `#keys` → `display:none` (CSS only, one
  rule block). The canvas fills the window because `.stage` is `flex:1`.
* `--vig` overridden to `.30` on `body.photo` (the `:root` value environs writes still applies
  everywhere else — a `body`-level custom property wins for `.stage::after` because `body` is
  the nearer ancestor).
* `fov` eases 46 → 34 (compression), `dist ×= .86`, idle drift drops to `.012 rad/s`.
* Optional `#bars` letterbox: two 100%-width bars easing to `(1 - 1/2.39)/2` of stage height
  over 500 ms. Toggle with `L`. Default **on** — the black bars are 70 % of why a screenshot
  looks like a postcard.
* A single 11 px caption bottom-right, `opacity .5`: `Costridge · 1.18B tokens this session`.
  It stays in the saved PNG (§9.2) and vanishes if `L` is off.

### 9.2 Saving — `Ctrl+S` anywhere, `Enter` or `S` in photo mode

`preserveDrawingBuffer` is **false** and must stay false (it costs a full-screen copy every
frame at 1200 buildings). The buffer is readable if and only if you read it in the **same task**
as the draw — hence `ui.afterRender()` appended to `tick()` after `renderer.render`:

```js
afterRender() {
  if (!grabWanted) return;
  grabWanted = false;
  const gl = cfg.canvas, W = gl.width, H = gl.height;
  const c = _grabCanvas || (_grabCanvas = document.createElement('canvas'));
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(gl, 0, 0);                                    // valid: same task as the render
  drawPostcardCaption(g, W, H);                             // §9.3
  const url = c.toDataURL('image/png');
  const name = `${slug(ctx.townName)}-${stamp()}.png`;       // costridge-20260806-1847.png
  (cfg.saveShot ? cfg.saveShot(name, url) : downloadFallback(name, url))
    .then(p => toast(`saved · ${p || name}`, 3200))
    .catch(() => toast('could not save the picture', 3200));
}
```

The **postcard caption** is what makes the file worth having. Drawn on the 2D copy, never on
the live canvas:

```
  ── a 1 px hairline of ctx.accentCss at 7 % height from the bottom ──
  COSTRIDGE                                   1.18B tokens · this session
  valley ribbon village · seed 8F3A           6 August 2026 · 18:34
```
Georgia 30 px / Segoe UI 13 px, `#F4EFE2` over a `rgba(0,0,0,.42)` scrim, scaled by `H/880` so
it is proportional at any window size.

### 9.3 The 12-line shell change

`preload.js`:
```js
saveShot: (name, dataURL) => ipcRenderer.invoke('town:saveShot', name, dataURL)
```
`main.js` (guard: `if (isShotRun) return null;` — a headless verification run must never write
into Pictures):
```js
ipcMain.handle('town:saveShot', (_e, name, dataURL) => {
  const dir = path.join(app.getPath('pictures'), 'Token Town');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(name).replace(/[^\w.\-]+/g, '-'));
  fs.writeFileSync(file, Buffer.from(String(dataURL).split(',')[1] || '', 'base64'));
  return file;
});
```
No save dialog, no `will-download`, no new window. Browser/demo mode falls back to an
`<a download>` click. This is the **only** shell change in the whole area.

---

## 10. THE MINIMAP (which is also the compass)

`layout.js` already knows how to draw the town from above — `plan.paintGround(g, X, opt)` takes
an arbitrary affine world→pixel transform. **Reuse it, change nothing in layout.js.**

```js
// #miniBase — 176×176 CSS, backing = 176 * min(dpr,2). Repainted ONLY when
//   plan changed || bandOf(built) changed || |built - lastBuilt| >= 8   → ≈ 0.3 Hz
const S = mini.width, span = plan.maxR + 26, s = S / (2 * span);
const X = (x, z) => [S / 2 + x * s, S / 2 + z * s];
plan.paintGround(g, X, { px: s, frontierK: ctx.frontierK, builtN: built,
                         plazaR: ctx.plazaR, wear: 0 });      // wear:0 skips the 26 000-speck pass
```

`#miniFx` is a second, stacked canvas cleared and redrawn at **8 Hz** (`performance.now()`
gated, never per frame):

* the view wedge — a filled triangle from the camera's XZ position spanning `fov*aspect`,
  `rgba(243,208,122,.13)` with a `.34` outline;
* the altar: 3 px gold dot at the origin (always, so it doubles as "where is home");
* standing landmarks: 2 px amber ticks from `sources().landmarks`;
* the focus/selection point: 3 px white ring;
* the followed villager: 3 px cyan dot with a 1 Hz pulse;
* an `N` in the top margin — **the plan never rotates**, so `-Z` is always up and the minimap
  *is* the compass. No separate compass widget. Deleted from scope.

**Placement & visibility:** `right:14px; bottom:14px` inside `.stage`, `opacity .55`, → `1` on
hover; hidden in `photo` and `tour`. Always visible otherwise — it is the thing that tells a
first-time user the town has an extent, and it stops stroll mode from being disorienting.

**Click the minimap:** orbit/focus → pan the orbit target there and `orbit()`; stroll →
`rig.walkTo(x,z)`. Both are 6 lines and both feel great.

Cost: 2 canvases, one 0.3 Hz paint of ≤ 1200 tiny strokes, one 8 Hz paint of ~12 primitives.
Measured budget ≤ 0.5 ms/s.

---

## 11. THE CINEMATIC TOUR + ATTRACT MODE

This is the feature that changes what the app *is*: a tray toy you leave open. `T` starts it;
any drag, wheel or `Esc` stops it instantly (and toasts nothing — silence is the courtesy).

### 11.1 The shot list (`camera.js` default, overridable)

| # | id | subject | dist | pol | hold | caption |
|---|---|---|---|---|---|---|
| 1 | `gate` | `plan.gate` signpost | 24 | .20 | 6.5 s | `The road into {town}` |
| 2 | `plaza` | altar, `spin .05` | `max(30, crown*2.3)` | .34 | 9.0 s | `{tierName} · {tok} tokens {rangeShort}` |
| 3 | `newest` | last-built house | 20 | .38 | 6.5 s | `Newest on the plat — {label} #{n}` |
| 4 | `landmark` | a standing landmark, rotating pick | `hTop*3.2+10` | .40 | 7.5 s | `{label}, unlocked at {tok}` |
| 5 | `crossing` | a bridge (skip → grandest house) | 22 | .30 | 6.5 s | `{label}` |
| 6 | `grove` | oldest grove (skip if none) | 18 | .44 | 5.5 s | `{dur} of quiet, {clock}` |
| 7 | `wide` | bounds centre, `spin .03` | `orbitDist * 1.12` | .58 | 9.5 s | `{town} · {buildings} buildings · {villagers} souls` |

`at()` returning `null` **skips** the shot with no gap — a lakeside town with no bridge and no
groves runs a 5-shot 39 s loop; a mature riverside town runs all 7 for ~51 s. Shot 4 advances
its landmark each lap, so a nine-landmark town takes nine laps to repeat itself. `fov` 40
throughout except shot 7 (46).

Each shot's move-in is the standard eased transition (`tau` bumped to `.62`), which consumes
the first ~1.6 s of its hold. Captions live in `#modePill`, centred, `opacity .78`, with a
`◂ ▪▪▪▫▫▫▫ ▸` progress row of shot dots.

Chrome during the tour: header + footer stay (the numbers are the point), `#news` stays,
`#deed`/`#mini`/`#tip` hide, hover picking is suspended.

### 11.2 Attract mode

If **no pointer or key input for 4 minutes** and the mode is `orbit`, start the tour with a
2.5 s fade of `#modePill` reading `{town}, hour {n}`. Any input exits immediately and restores
the exact previous orbit state (stash `g`/`c` on entry). Off when `prefers-reduced-motion` is
set. Toggleable with `Shift+T` (persisted in `localStorage['tt.attract']`, default **on**).

This is the single highest-value idea in the document per line of code: it turns four idle
minutes into the app selling itself.

### 11.3 Events may *suggest* shots, never seize the camera

When a landmark is placed or a milestone fires **and the tour is running**, splice a one-off
shot for that subject after the current one (`hold 6 s`, caption `{label} — just now`). Outside
the tour, events do nothing to the camera except the existing `punch()`. Never move a user's
camera without a gesture.

---

## 12. KEYS, CHROME AND DISCOVERABILITY

### 12.1 The complete keymap

| key | action |
|---|---|
| drag / wheel / right-drag | orbit · zoom-to-cursor · pan |
| click / dblclick | select · select + focus |
| `Esc` | deselect → else leave the mode → else nothing |
| `Space` / `Home` | frame the whole town (`orbit()`), from anywhere |
| `F` | follow the villager under the cursor, else the nearest to screen centre |
| `G` | go to ground level under the cursor · again to come back up |
| `T` · `Shift+T` | tour · toggle attract mode |
| `P` · `L` | photo mode · letterbox |
| `Ctrl+S` / `S` / `Enter` (photo) | save the postcard PNG |
| `[` `]` | previous / next landmark (focus each in turn) |
| `1`…`5` | jump to bookmark · `Shift+1`…`5` to set one |
| `Tab` (hold) | boost the minimap to full opacity + show landmark labels |
| `?` / `F1` | the key sheet |
| WASD / arrows / `Shift` | walk · jog (stroll only) |

Ignore every key when `e.ctrlKey||e.metaKey||e.altKey` except `Ctrl+S`, and when
`document.activeElement` is an input (there are none today; guard anyway).

### 12.2 Discoverability — four layers, none of them clutter

1. **The hint strip** `#keys`: one line, bottom-centre, `opacity .62`, shown **6 s after the
   first data lands**, fading out after 14 s:
   `drag to look · click a building · F follow someone · G walk the streets · T tour · P photo · ? keys`
   Shown on the first **3 launches only** (`localStorage['tt.hints']` counter), then never — a
   returning user should not be taught the same thing forever.
2. **Cursor + hover lift** (§6.1) — the ambient "this is touchable" signal, always on.
3. **Toasts** on every mode entry, always naming the exit: `Following Bramble Ashcote · Esc to
   let them go` · `Photo mode · Ctrl+S to save · Esc to leave`. `#toast`, bottom-centre,
   `2.6 s`, wall-clock-timed, one at a time (a second replaces the first).
4. **`?` sheet** `#sheet`: a centred 2-column card over a `rgba(13,13,13,.72)` scrim, the table
   above verbatim, dismissed on any key or click.

### 12.3 `#modePill`

Top-centre of `.stage`, `top:12px`, only when `mode !== 'orbit'`: `⟲ Following · Bramble
Ashcote, thatcher — on their way to the altar`, `Esc` styled as a `kbd`. In tour mode it also
carries the shot caption and the dot progress row.

---

## 13. NEW DOM + CSS (all additive to `index.html`)

```html
<div class="stage" id="stage">
  <canvas id="gl"></canvas>
  <div id="overlay"></div>
  <div id="tip"><div class="t1"></div><div class="t2"></div><div class="t3"></div><div class="t4"></div></div>
  <aside id="deed" hidden>
    <button id="deedX" aria-label="close">✕</button>
    <div class="dTitle"><span class="dName"></span><span class="dBadge"></span></div>
    <div class="dSub"></div>
    <dl class="dRows"></dl>
    <div class="dFlavor"></div>
    <div class="dActs"></div>
  </aside>
  <div id="mini" hidden><canvas id="miniBase"></canvas><canvas id="miniFx"></canvas><b>N</b></div>
  <div id="modePill" hidden></div>
  <div id="toast" hidden></div>
  <div id="keys" hidden></div>
  <div id="sheet" hidden></div>
  <div id="bars" hidden><i></i><i></i></div>
  <div id="hint">…</div>
  <div id="banner"></div>
</div>
```

CSS rules (~120 lines, appended to the existing sheet, same tokens — `--card`, `--hairline`,
`--ink`, `--accent`). **Base CSS is the final state** (§13.2 corollary): every new element's
resting style is its *visible* style, and the entry animations only travel toward it, so a
throttled compositor can never catch a blank card. `[hidden]` does the hiding, never an
`opacity:0` base.

```css
#deed{position:absolute; left:16px; bottom:16px; width:306px; z-index:4;
  background:rgba(20,20,19,.94); border:1px solid var(--hairline); border-radius:10px;
  padding:13px 15px 12px; box-shadow:0 10px 34px rgba(0,0,0,.55); opacity:1; transform:none}
#deed.in{animation:deedIn .22s cubic-bezier(.2,.9,.3,1)}
@keyframes deedIn{from{opacity:0; transform:translateY(10px)} to{opacity:1; transform:none}}
#deed .dName{color:var(--ink); font:600 16px "Segoe UI",system-ui}
#deed .dBadge{margin-left:8px; font-size:10.5px; color:#14120C; background:var(--accent);
  border-radius:9px; padding:1px 7px}
#deed .dSub{color:var(--muted); font-size:11.5px; margin-top:2px}
#deed dl{display:grid; grid-template-columns:96px 1fr; gap:3px 10px; margin:11px 0 0; font-size:12px}
#deed dt{color:var(--muted)} #deed dd{margin:0; color:var(--ink2); font-variant-numeric:tabular-nums}
#deed .dFlavor{margin-top:10px; color:#CBB07A; font-style:italic; font-size:12px}
#deed .dActs{margin-top:11px; display:flex; gap:7px}
#deed button.act{background:rgba(255,255,255,.06); border:1px solid var(--hairline); color:var(--ink2);
  border-radius:7px; padding:4px 10px; font-size:11.5px; cursor:pointer}
#deed button.act:hover{background:rgba(217,164,65,.18); border-color:rgba(217,164,65,.5); color:var(--ink)}
#mini{position:absolute; right:14px; bottom:14px; width:176px; height:176px; z-index:4;
  border:1px solid var(--hairline); border-radius:9px; overflow:hidden; opacity:.55;
  background:rgba(13,13,13,.66); transition:opacity .18s}
#mini:hover,#mini.hot{opacity:1}
#mini canvas{position:absolute; inset:0; width:100%; height:100%}
#mini b{position:absolute; top:2px; left:50%; transform:translateX(-50%); font:600 9px "Segoe UI";
  color:var(--muted); pointer-events:none}
#modePill{position:absolute; top:12px; left:50%; transform:translateX(-50%); z-index:5;
  background:rgba(16,16,15,.88); border:1px solid var(--hairline); border-radius:14px;
  padding:5px 13px; font-size:12px; color:var(--ink2); white-space:nowrap; text-align:center}
#modePill kbd{font:600 10.5px "Segoe UI"; color:var(--muted); border:1px solid var(--hairline);
  border-radius:4px; padding:0 4px; margin:0 2px}
#toast{position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:6;
  background:rgba(16,16,15,.92); border:1px solid var(--hairline); border-radius:8px;
  padding:7px 14px; font-size:12.5px; color:var(--ink2)}
#keys{position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:5;
  font-size:12px; color:var(--muted); background:rgba(13,13,13,.5); padding:6px 14px; border-radius:9px}
#bars i{position:absolute; left:0; width:100%; height:0; background:#000; z-index:5;
  transition:height .5s cubic-bezier(.2,.8,.3,1)}
#bars i:first-child{top:0} #bars i:last-child{bottom:0}
body.photo #bars i{height:20.9%}                     /* (1 - 1/2.39)/2 */
body.photo header, body.photo #news, body.photo footer,
body.photo #deed, body.photo #mini, body.photo #tip, body.photo #keys{display:none}
body.photo{--vig:.30}
#gl.pick{cursor:pointer}
@media (prefers-reduced-motion:reduce){#deed.in{animation:none}}
@media (max-width:820px){#mini{width:132px; height:132px} #deed{width:264px}}
```

---

## 14. INTERACTION WITH EXISTING SYSTEMS (the checklist that keeps this from breaking things)

| system | rule |
|---|---|
| **auto-framing** (`refreshFraming`) | keeps running in every mode; writes only the orbit goal; `rig.orbit()` is therefore always correct-for-now |
| **idle orbit** | orbit + tour + photo only, at 3 different rates (§3.1); any pointer/key input resets `idleT` in every mode |
| **founding ritual** (§11.4) | `setIntroBias` per frame; **all** interaction is inert until `ctx.intro >= 1` except `Esc`/any key = `rig.skipIntro()`; the ritual's `dollyT` punch still fires |
| **epoch reset** (`hardReset`) | `rig.orbit({snap:true})`, `ui.clearSelection()`, drop any follow handle, stop the tour, **keep** photo mode (the user asked for it) |
| **`fx` particle scale** | reads `rig.dist`, floored at 26 in close modes |
| **bubbles** (`news.say`) | unchanged; close modes simply pass its range test more often — which is the point |
| **`hitTargets`** | shared array reference; `dropGroup()` already splices it. `interact.js` must hold the array, never a copy |
| **`window.__tick`** | unchanged; `rig.update` and `ui.update` are inside `tick()`, so manual stepping still drives them |
| **error banner** | untouched; `interact.js` must not swallow errors — no try/catch around the raycast |
| **demo mode** (no preload) | everything works; `saveShot` falls back to `<a download>`; attract mode on |
| **single instance / tray** | untouched |
| **`#hint`** | unchanged; `#keys` appears *after* the first data, i.e. never at the same time as `#hint` |

---

## 15. PERF BUDGET

| addition | cost | when |
|---|---|---|
| `rig.update` | ~40 flops, 1 `lookAt`, 0 alloc | every frame |
| picking raycast (existing) + `npcs.raycast` | existing + ~160×12 flops | 20 Hz, and only when the pointer is over the canvas |
| hover lift | 1 lerp on 1 group | every frame while hovering |
| selection ring | **1 draw call**, additive, no shadow | while selected |
| deed card | DOM rebuild on selection change; 1 Hz row refresh for the monument only | rare |
| `#miniBase` | ≤ 1200 canvas strokes, `wear:0` | ≈ 0.3 Hz |
| `#miniFx` | ~12 primitives | 8 Hz |
| shadow re-arm in close modes | 1 extra depth pass / 83 ms, over the *smallest* caster set the app ever has | stroll/follow/focus only |
| photo grab | 1 `drawImage` + `toDataURL` at window size (~40 ms) | on keypress only |
| stroll collision grid | rebuilt on building-count change; 9-cell probe per frame | stroll only |

Net: **< 0.9 ms/frame** in orbit (the default), which is where the 60 fps @ 1200+160 budget is
measured. Zero per-frame allocation anywhere — module-level scratch `Vector3`s, a reused
`_grabCanvas`, and `dl`/`dt`/`dd` nodes pooled in the deed card.

---

## 16. TEST HOOKS + HEADLESS VERIFICATION

Add to `main.js`'s forwarded query list (line 87): `'cam'`, `'cam-at'`, `'select'`, `'shot-ui'`.

| hook | effect |
|---|---|
| `--cam=orbit\|tour\|photo\|stroll\|follow` | enter the mode at t=0 and **snap** (no ease) |
| `--cam=tour:3` | enter the tour parked on shot 3 |
| `--cam-at=x,z` | stroll/focus start point |
| `--select=house:120` \| `altar` \| `landmark:cathedral` \| `villager:0` | open the deed card for a specific subject — **the only way to screenshot-verify the card**, since a headless run has no mouse |
| `--shot-ui=0` | force all v4 chrome hidden (regression-diff against a v3 shot) |

Recipes (PowerShell 5.1, `;` never `&&`, scratchpad paths only, **never** a visible window):

```powershell
cd <repo>\town
$S = "%TEMP%\claude\<project>\<session-id>\scratchpad"
npx electron . --shot=$S\v4-deed.png   --shot-delay=9000 --select=house:120 --hour=13
npx electron . --shot=$S\v4-tour.png   --shot-delay=11000 --cam=tour:2 --hour=17
npx electron . --shot=$S\v4-stroll.png --shot-delay=10000 --cam=stroll --hour=19
npx electron . --shot=$S\v4-follow.png --shot-delay=10000 --cam=follow --hour=22
npx electron . --shot=$S\v4-photo.png  --shot-delay=9000  --cam=photo --hour=18
npx electron . --shot=$S\v4-mini.png   --shot-delay=9000  --hour=13
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

**Acceptance for each:** the mode's chrome is present and legible; the camera has *arrived*
(not mid-ease); the town is drawn; `#banner` is absent. The `--cam` hooks snap precisely so a
9 s capture can never be ambiguous about whether the ease is broken or merely slow.

---

## 17. RANKED BACKLOG

### MUST

| # | item | size | files |
|---|---|---|---|
| M1 | **`camera.js`: the rig** — goal/current state, per-channel easing, short-arc az, `orbit` mode with today's exact framing formula, drag/wheel/pan/inertia, zoom-to-cursor, `setFrame`/`setIntroBias`/`punch`/`snap`, `userDist` decay | **L** | `camera.js`(new) |
| M2 | **`town.js` surgery** — the 12 edits in §4 + `paidFor()` + `shotSources()` | **M** | `town.js` |
| M3 | **`interact.js`: picking, `#tip` port, cursor + hover lift, select/deselect, the selection ring, dblclick-to-focus, `focus` mode in the rig** | **M** | `interact.js`(new), `camera.js`, `town.js`(describe), `index.html` |
| M4 | **The deed card** — `Deed` shape, `describeEnt` widening, `paidFor` copy, all 8 entity kinds, actions | **M** | `town.js`, `interact.js`, `index.html` |
| M5 | **Keymap + `#toast` + `#modePill` + `#keys` hint strip + `?` sheet** | **S–M** | `interact.js`, `index.html` |
| M6 | **The cinematic tour + attract mode** (7 shots, captions, splice-on-event, reduced-motion) | **M** | `camera.js`, `interact.js`, `town.js`(sources) |

### SHOULD

| # | item | size | files |
|---|---|---|---|
| S1 | **Follow a villager** — `npcs.raycast/track/nearest/pin`, `news.villagerFor`, follow mode, the trailing-az rig, the chatty companion | **M** | `npcs.js`, `news.js`, `camera.js`, `interact.js` |
| S2 | **Photo mode + postcard save** — chrome hide, letterbox, fov/dist, caption bake, `afterRender` grab, the 12-line shell IPC | **M** | `interact.js`, `town.js`(1 line), `preload.js`, `main.js`, `index.html` |
| S3 | **Minimap / compass** — two canvases, `paintGround` reuse, wedge + dots, click-to-go | **M** | `interact.js`, `index.html` |
| S4 | **Stroll (street level)** — free camera, WASD + click-to-walk, collision grid, water/bound guards, the dive transition, fog clamp, shadow follow | **L** | `camera.js`, `interact.js`, `town.js`(fog/shadow hooks) |
| S5 | **Villager hover + villager deed card** (needs S1's `raycast`; ships with it) | **S** | `interact.js`, `news.js` |
| S6 | **`deedFlavor` corpus** — 10 lines × 6 kinds in the Crier's voice | **S** | `news.js` |

### COULD

| # | item | size | files |
|---|---|---|---|
| C1 | Bookmarks `1`–`5` + `Shift`-set, persisted per plan seed | **S** | `camera.js`, `interact.js` |
| C2 | `[` / `]` landmark browse | **S** | `interact.js` |
| C3 | Click a ticker headline → fly to its subject (`news` attaches `subject` to the live line) | **S** | `news.js`, `interact.js` |
| C4 | Deed `[Follow a resident]` / `[Where they live]` | **S** | `interact.js`, `npcs.js` |
| C5 | Photo aspect presets (`1:1`, `16:9`, `2.39`) cycled on `L` | **S** | `interact.js` |
| C6 | Minimap landmark **labels** while `Tab` is held | **S** | `interact.js` |
| C7 | A second follow flavour: **ride the newest scaffold** — camera parked on the build site until it finishes | **S** | `camera.js`, `interact.js` |

### CUT (designed, deliberately not built)

* **Street names** (`layout.js` naming its spine + ring roads, deed cards reading *"14 Mill
  Lane"*). Lovely, and it belongs to the layout owner, not this area. Propose for v4.1.
* **Pointer lock** for stroll mouse-look — banned outright (§8.1).
* **A separate compass widget** — the minimap is the compass (§10).
* **Free-floating deed cards anchored in screen space** — clipping and jitter (§6.2).
* **Camera paths saved to disk / GIF export** — no dependency budget for an encoder.
* **Right-click context menus** — a toy should not grow a menu system.

---

## 18. BUILD ORDER (what the showrunner needs)

```
        ┌─ M1 camera.js ──┐
  M2 town.js surgery ─────┼──► M3 picking ──► M4 deed card ──► S5 villager card
        └─────────────────┤                        ▲
                          ├──► M6 tour ────────────┤
                          ├──► S1 follow ──────────┘
                          ├──► S4 stroll
                          └──► M5 keys/chrome ──► S2 photo ──► S3 minimap
```

* **M1 + M2 must land together, first, as one commit.** They are the only edits to `town.js`
  in this area; everything after them is new-file work plus append-only CSS/HTML.
* After that gate, **M3+M4**, **M5+S2+S3**, **M6**, **S1**, **S4** are four fully parallel
  tracks with no shared files except `index.html` (append-only, sectioned by comment banner per
  track to make merges trivial).
* `npcs.js` (S1) and `news.js` (S1/S6) additions are purely additive and should be handed to
  those files' owners as a one-paragraph request rather than edited from this area, if those
  owners are also working this wave.

---

## 19. RISKS

1. **`town.js` merge contention.** Mitigated only by scheduling M1+M2 first and alone.
2. **The new-files decision** (§1). If refused, everything still works but the schedule
   serialises. Decide before the wave starts, not during.
3. **Stroll's scale check.** Villagers at 0.93 units vs a 1.72 eye read short; the `EYE = 1.35`
   fix must be verified in an actual headless shot before S4 is called done.
4. **Easing vs. the headless rule.** Every mode transition must be verified with a
   `--shot-delay=9000` capture; if any of them is still mid-flight at 9 s, the `tau` is wrong,
   not the harness.
5. **Photo grab correctness.** `drawImage(glCanvas)` after `renderer.render` works only in the
   same task. If a future change moves `renderer.render` off `tick()`, the grab breaks
   silently (black PNG). Put a one-line comment at both sites saying so.
6. **Scope creep into `npcs.js`.** `raycast/track/nearest/pin` and nothing else. Follow mode
   must never reach into `npcs[]` directly.
```
