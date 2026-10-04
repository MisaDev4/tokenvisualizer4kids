// THE FAR TOWN — building level of detail (v4 E1).
//
// The camera auto-frames the whole plat, so a house SHRINKS as the town grows: 31 px
// at 200 buildings, 12 px at the 1200 cap. Below ~16 px a house is a shaded block
// under a roof, which is exactly what seven InstancedMeshes can draw for seven
// draw calls instead of ~4 800. This module owns that swap, the hysteresis that keeps
// it from flickering, the analytic hover pick that keeps every building touchable in
// whatever tier it is in, and the one place the NPC far-tier threshold is decided.
//
// THREE BUILDING TIERS, per building, decided from its own screen height:
//   FULL   (≥16 px in)  the real merged group, drawn by town.js — impostor parked
//   DETAIL (≥ 4 px in)  instanced body + roof + panes + chimney + silhouette extra
//   PLAIN  (< 4 px)     …minus the chimney and the extra, which are sub-pixel there
// …under ONE global mode, decided from the modal house's screen height:
//   'B' near — `coldRoot` attached, FULL allowed, per-building frustum test
//   'A' far  — `coldRoot` DETACHED (not hidden: hiding still pays ~5 200 node visits
//              in updateMatrixWorld), every settled building is an impostor
// Hysteresis everywhere: 13/17 px on the mode, 16/13 and 4/3 px on the tiers, a 2-unit
// frustum margin, 3.5/4.4 px on the NPC tier. Nothing between the pairs ever flips.
//
// WHAT AN IMPOSTOR IS ALLOWED TO COST, AND WHY THAT IS THE WHOLE DESIGN. At the
// framing the user's own all-time total produces — 1 200 buildings, modal house
// 10.4 px, mode A — EVERY building on screen is an impostor and 264 of them are
// 16 px or taller. Promoting those back to real groups is not available: a settled
// house costs ~1.95 draw calls and ~315 triangles, `s1200` sits at 259 of its 300
// draw calls, and the 41 that are left buy twenty-two houses out of twelve hundred.
// So the budget went into the impostor instead, under one rule: NOTHING NEW MAY BE
// INSTANCED. Every stream is sized by its pool's high-water mark, so a chimney is
// charged the moment its building registers whether it is drawn or not, and the
// zoomed scene (`z1200`, 420 k triangles) leaves room for about four triangles per
// building. Everything the impostor gained is therefore free by construction:
// geometry that was already allocated and simply was not being drawn (the chimney
// below 9 px, the window panes in daylight), a lid grown to cover a box it was
// already sitting on, and shade baked into the vertex colours of shapes that were
// already there. Measured: +120 triangles and +0 draw calls at s1200/n1200/w1200.
//
// PUBLIC SURFACE — initLod(scene, cfg) → LodSystem
//   cfg {cap=1200, camera, stage|height, coldRoot?, houses?, geo?, winMat?,
//        quality?, onMode?, onNpcTier?}      every field optional; absent camera ⇒ no-op
//   set(i, x, z, yaw, s, imp)   register ordinal i (0-based, === instance index, forever)
//   clear(i)                    release i (demolition / remount) — pick() forgets it too
//   park(i, on)                 park (true) / show (false) the impostor for i
//   setCount(n)                 n === built (reported in stats(); the sweep bounds
//                               itself by the highest REGISTERED ordinal, which stays
//                               correct even when this call lags a cascade frame)
//   update(now, ctx, houses)    → 'A'|'B'; wall-clock 10 Hz sweep, cheap every frame
//   setSize(w, h) · setQuality('high'|'med'|'low')
//   pick(rayOrRaycaster)        → ordinal or -1   (exact ray/OBB, ~20 tests, not 4 800)
//   pickDist                    ray t of that hit — read it in the same breath as pick()
//   entAt(i) · maxOrd           the registry read back out: `houses[i]` for a live
//                               ordinal, and the highest ordinal ever registered
//   tierOf(i)                   → 0 FULL · 1 DETAIL · 2 PLAIN · -1 not registered
//   boxAt(i, out)               → out {x,y,z,w,d,h,yaw,top} | null   (rings, deed cards)
//   inView(x, y, z, r)          → boolean, against the last sweep's frustum
//   npcTier()                   → LIVE {far, px, stride, camD} — advisory, see below
//   mode · hotCount · activeCount · builtCount · stats()   (getters)
//   reset()                     epoch teardown — park all, free all slots, keep buffers
//   dispose()                   shutdown — remove + dispose everything this file minted
//
// COST (measured in a node harness against the vendored three, 1 200 buildings):
//   7 draw calls · 34 k triangles · 3 materials · 0 textures · 0 shadow casters
//   …plus 3 geometries: the body box and the two roof shapes are CLONED from the
//   town's own (bit-identical positions, so the A↔B swap still lines up) and carry
//   one baked greyscale `color` attribute each. See `shaded()` for what it buys.
//   NO SHADOW CASTERS is a decision, not an omission, and it is the biggest thing
//   still missing beside a real house: camera.js caps the sun's frustum at
//   ±74 units (`Math.min(bnd.r, 62) + 12`), and the 1 200-building plat is far
//   wider than that, so switching these streams on would draw a disc of shadowed
//   houses in the middle of an unshadowed town. It is worth having the day the
//   shadow rig can cover the plat, and not before.
//   448 KB of instance buffers + 122 KB of state, ALL allocated once at init
//   full sweep 0.023 ms → 0.23 ms/s at 10 Hz · gated frame 0.35 µs · pick() 3.0 µs
//   set() 3.5 µs, so even a 420-building cascade frame pays 1.5 ms of lod
// The triangle figure is flat across modes: instance counts are a high-water mark, so
// a parked impostor still costs a degenerate primitive. 34 k against a 300 k budget is
// the right trade for never re-packing an index — instance index === ordinal, forever.
// Nothing in set/clear/park/update/reset allocates, so a founding cascade and 20 epoch
// switches cost the GC nothing (verified: no buffer, geometry or material is re-minted
// across 20 reset+refill cycles).
//
// WHAT THE INTEGRATION WAVE MUST WIRE (town.js):
//  1. `const coldRoot = new THREE.Group(); coldRoot.matrixAutoUpdate = false;` — settled
//     house groups are parented here, NOT to the scene. Pass it as `cfg.coldRoot`; lod
//     attaches/detaches it on the mode flip. `dropGroup` must become
//     `g.parent && g.parent.remove(g)`.
//  2. New buildings mount into `hotRoot` (always attached — the pop-in animates a
//     matrix). At the settle branch (`else if (g.matrixAutoUpdate && !e.rising)`) hand
//     over: `hotRoot.remove(g); coldRoot.add(g); lod.set(e.n-1, p.x, p.z, p.yaw,
//     g.scale.x, e.imp)`. `remountEnt`/demolition must call `lod.clear(e.n-1)` first.
//  3. `e.imp` is buildings.js's `deriveImpostor()` result (F7):
//     {w,d,h,y0,rh,rk,rw,rd,ry,rY,wall,roof,ch?,extra?}. A null `imp` is legal and
//     pins that building to FULL — it stays a real group and stays hoverable. Register
//     one only if its group lives OUTSIDE `coldRoot` (landmarks, bridges and the
//     monument already do), or mode A would detach the only copy of it there is.
//  4. House groups get `frustumCulled = false` (lod owns their visibility) and leave
//     `hitTargets`; from then on a settled house can ONLY be found through this file.
//     Buildings still popping in are not yet in lod, so keep those in `hitTargets`
//     until the hand-off. `interact.js` is the one consumer and it needs no wiring of
//     its own beyond `lod` in its config (§8.1): it calls `pick(ray)` + `pickDist` in
//     the same nearest-wins contest as the raycaster, `entAt(ord)` to get back the
//     entity, `boxAt` for the ring under a hidden group, and `tierOf` to know whether
//     a hover lift would be visible at all. Nothing here strands a selection: a tier
//     change moves instances, never the registry, and `clear()` hands a group back
//     VISIBLE so a building that leaves lod's care is never left invisible.
//  5. `lod.update(now, ctx, houses)` once per frame before `renderer.render`, and
//     `lod.setSize(w, h)` from `resize()`. `hardReset` calls `lod.reset()`.
//  6. Pass `cfg.winMat` = buildings.js's shared `winCache` material so town.js's one
//     `emissiveIntensity = winI` write lights the impostor panes too. Without it lod
//     mints its own and drives it from `ctx.night` with the same curve.
//  7. `npcTier()` is ADVISORY: npcs.js (F9/E11) owns part-dropping and third-rate
//     stepping, but both sides must read one threshold and one hysteresis, so town.js
//     should forward `lod.npcTier()` rather than recomputing px.
// Everything above is node-verified except what a GPU has to answer: whether the A↔B
// swap is invisible at medPx 17/20/25, and whether the derived silhouette reads as the
// same building. Both are `--bench-shot` A/B jobs for the integration pass.
import * as THREE from './vendor/three.module.js';
import { applyTownSurface } from './surface.js';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/** The modal house (tier 4, hTop 4.3) decides the global mode: one flip, whole town. */
const MED_H = 4.3;
// CALIBRATED ON A GPU, v4 stage E — this file shipped with 18/24 and 26/22, which is
// the one thing its author could not answer in a node harness ("whether the A↔B swap
// is invisible at medPx 17/20/25"). It is not. The A/B pairs are in the scratchpad
// (`ab200-off/high`, `ab400-*`, `cap-*`, downsampled to CSS resolution so they show
// what the eye actually receives): at 22–26 px the impostor loses the eaves, the
// windows, the door and — the loudest cue by far — the CAST SHADOW, and a settled
// village turns into a field of pale blocks. It reads honestly at ~12 px, which is
// where the module was always aimed; the old numbers simply engaged it three times
// too early. So the swap now happens where its own premise holds:
//   medPx 13/17  — a town under ~350 houses stays real, which is every town whose
//                  houses the user can still tell apart
//   16/13 px     — per building, inside mode B
// The cap is untouched by this (medPx there is 9.5, far below 13) and so is the win:
// s1200 stays 242 draw calls. What it costs is the small-town scenes, where 200 real
// houses were never the problem. See the report for the two defects this leaves open.
//   RE-EXAMINED against the framing the user's own total produces, and these three
// pairs are still the right ones — but for a reason the note above could not have
// known. The cap is NOT "untouched": medPx 10.4 there means mode A, which means the
// question is not where the per-building line sits but whether the town may leave
// mode A at all, and at 1 200 buildings it may not (see the cost note in the header).
// Two of the four cues listed above have since been paid for — the eaves are the
// body's shaded top face and the windows are drawn in daylight, both for nothing —
// and the third, the door, is not worth a stream. The CAST SHADOW is still the
// loudest one missing and still cannot be had at this framing; that is the shadow
// rig's cap, not this file's threshold, and the COST note above says where it lives.
const MODE_A_PX = 13, MODE_B_PX = 17;      // A below 13, B above 17 — nothing between
const FULL_IN = 16, FULL_OUT = 13;
// THE PLAIN TIER USED TO BE A FREE SAVING AND IS NOT ONE. Every stream is sized
// by its pool's HIGH-WATER MARK, so a chimney's twelve triangles are charged the
// moment its building registers — parked or drawn, DETAIL or PLAIN. Dropping the
// chimney at 9 px therefore bought nothing at all and cost the skyline: at the
// framing the user's own total produces, 163 of 1 200 houses were sitting under
// the line, and a village's roofline IS its chimneys. So PLAIN now means what its
// name says — too small for the detail to be a detail rather than an aliasing
// source — and 4 px is where a 0.34-wide chimney stops covering a pixel.
const DET_IN = 4, DET_OUT = 3;
const NPC_FAR_IN = 3.5, NPC_FAR_OUT = 4.4;  // mirrors npcs.js's own 0.62 · poseK math
const SWEEP_MS = 100;                       // 10 Hz, wall clock — never accumulated dt
const SWEEP_MOVE2 = 9;                      // …or sooner, if the camera jumped 3 units
const CELL = 16;                            // pick hash cell, world units
const PLOT_R = 3.2;                         // a building's own reach, for hash insertion
const FRUSTUM_PAD = 2;                      // hysteresis on the edge-of-screen test

const T_FULL = 0, T_DETAIL = 1, T_PLAIN = 2, T_NONE = 255;
/** `imp.extra.geo` → stream. Anything else is ignored (predictable degradation). */
const EX_NONE = 0, EX_SAILS = 1, EX_AWNING = 2, EX_FIELD = 3;

/* ═══ geometry this module may have to mint ═════════════════════ */
// Shapes match buildings.js exactly where they can be shared (cfg.geo.unit / .gable /
// .pyr); these fallbacks exist so lod works standalone in a harness.
function gablePrism() {
  const s = new THREE.Shape();
  s.moveTo(-.5, 0); s.lineTo(.5, 0); s.lineTo(0, 1); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -.5);
  return g;
}
/** Two outward quads at z = ±.5 of a unit box: BOTH façades glow, one instance, 4 tris. */
function winCross() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -.5, -.5, .5, .5, -.5, .5, .5, .5, .5, -.5, .5, .5,
    .5, -.5, -.5, -.5, -.5, -.5, -.5, .5, -.5, .5, .5, -.5
  ]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}
/** A windmill's cross, in the XY plane: at four pixels it is the whole joke. */
function sailCross() {
  const g = new THREE.BufferGeometry(), P = [], N = [], I = [];
  for (let k = 0; k < 2; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2, c = Math.cos(a), s = Math.sin(a), t = .09;
    const o = k * 4;                                  // a 1 × 2t bar rotated by `a`
    for (const [x, y] of [[-.5, -t], [.5, -t], [.5, t], [-.5, t]]) {
      P.push(x * c - y * s, x * s + y * c, 0); N.push(0, 0, 1);
    }
    I.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
  g.setIndex(I);
  return g;
}

/* ── THE SHADE THAT IS BAKED INTO THE SHAPE ─────────────────────
   A far-town building used to be one flat hex over its whole silhouette, and the
   loudest thing wrong with the picture at the framing the user actually plays at
   was not the missing eaves or the missing door: it was that the BODY BOX'S TOP
   FACE is a +Y plane in full sun. `impostorOf` clamps the mass to a fifth of the
   way up the roof, and where the derived roof is narrower than the mass — which
   is every L-plan, every cross-wing, every range with a lean-to — that leaves a
   pale rim of lit wall-colour standing all round a small coloured lid. A town of
   those reads as a field of OPEN CRATES, and a photograph of a real village has
   nothing in it that looks like that.

   The fix costs no triangle and no draw call: clone the shape and bake one
   greyscale `color` attribute into it. three multiplies vColor by instanceColor,
   so the per-building tint is untouched and the shape carries its own shading:
     · the body's top face goes to a deep shade — it is a loft floor under a roof,
       and at 12 px a dark line between wall and roof IS the eaves shadow;
     · both roof kinds get a wash from eave to ridge, which is where rain sits and
       moss grows, and which is the charter's "weathering, not hue" for two ALU;
     · the chimney shares the body box, so its flue reads open rather than capped.
   Cloning keeps the shapes BIT-IDENTICAL to the roofs they replace (a clone copies
   the position buffer), which is what the A↔B swap depends on. */
// CALIBRATED AGAINST THE REAL TOWN, not by eye: `--lod=off` renders the same seed
// at the same framing with every house real, and the two frames' luminance
// histograms are the yardstick. The town used to sit ~5 levels BRIGHTER than the
// houses it stands in for, with 5.2 % of the plat in the top eighth against the
// real town's 3.1 % — that excess IS the lit top faces. These five numbers put it
// back on tone: mean luminance 160.5 real against 159.1 here, top eighth 3.1 %
// against 2.5 %, where before it was 165.2 and 5.2 %. What they do NOT close is a
// ~10-point redistribution out of the 192-224 band into 160-192, and no value of
// these constants closes it — it is the trim, sills, reveals and plinths a real
// elevation catches the light on, and closing it would take a stream this file
// cannot afford. Do not chase it here.
const BODY_TOP = .34, BODY_BOT = .55, SOFFIT = .52;
const EAVE_K = .91, RIDGE_K = 1.0;
/** @param {THREE.BufferGeometry} src @param {(v:THREE.Vector3,n:THREE.Vector3)=>number} paint */
function shaded(src, paint) {
  const g = src.clone();
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (nrm) n.fromBufferAttribute(nrm, i); else n.set(0, 1, 0);
    const k = paint(v, n);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * @typedef {Object} Impostor  buildings.js `deriveImpostor()` — local to the group
 * @property {number} w @property {number} d @property {number} h @property {number} y0
 * @property {number} rh @property {number} rk  0 none · 1 gable · 2 pyramid
 * @property {number} rw @property {number} rd @property {number} ry @property {number} rY
 * @property {number} wall @property {number} roof
 * @property {?{x:number,y:number,z:number}} ch  chimney top, local
 * @property {?{geo:string,x:number,y:number,z:number,s:number,color:number}} extra
 */

/**
 * @param {THREE.Scene} scene
 * @param {Object} cfg see the header
 * @returns {Object} LodSystem
 */
export function initLod(scene, cfg) {
  cfg = cfg || {};
  const cap = Math.max(1, cfg.cap | 0 || 1200);
  const camera = cfg.camera || null;
  const coldRoot = cfg.coldRoot || null;
  const G = cfg.geo || {};
  let ents = cfg.houses || null;          // town.js's `houses`; re-latched by update()
  let vh = cfg.height || 880, vhAt = -1e9, sized = !!cfg.height;
  let quality = cfg.quality || 'high';
  let dead = false;

  /* ── per-building state. Every array is allocated once, here, forever. ── */
  const bx = new Float32Array(cap), bz = new Float32Array(cap);      // plot centre, world
  const byaw = new Float32Array(cap), bscl = new Float32Array(cap);
  const bY0 = new Float32Array(cap), bTop = new Float32Array(cap);   // world base / top y
  const bHW = new Float32Array(cap), bHD = new Float32Array(cap);    // world half extents
  const bRad = new Float32Array(cap);                                // bounding radius
  const iw = new Float32Array(cap), ih = new Float32Array(cap), id = new Float32Array(cap);
  const rw = new Float32Array(cap), rh = new Float32Array(cap), rd = new Float32Array(cap);
  const ry = new Float32Array(cap), rY = new Float32Array(cap);
  const rk = new Uint8Array(cap);
  const chx = new Float32Array(cap), chy = new Float32Array(cap), chz = new Float32Array(cap);
  const exx = new Float32Array(cap), exy = new Float32Array(cap), exz = new Float32Array(cap);
  const exs = new Float32Array(cap), exk = new Uint8Array(cap);
  const live = new Uint8Array(cap);       // 0 empty · 1 registered · 2 registered, no impostor
  const tier = new Uint8Array(cap).fill(T_NONE);
  const winOn = new Uint8Array(cap);
  const stamp = new Uint32Array(cap);     // pick() dedupe, rolling
  let stampN = 0;

  let built = 0, hiOrd = -1, nSet = 0, hot = 0, active = 0;
  let mode = 'B', K = 900, medPx = 999, sweepAt = -1e9, lastCx = 1e9, lastCy = 0, lastCz = 0;
  let swept = false, visDirty = false;
  const npc = { far: false, px: 99, stride: 1, camD: 62 };

  /* ── the instanced streams ──────────────────────────────────────
     body/roofG/roofP/chim share ONE material (§2.1: one lighting family), so the
     whole far town is 3 materials. Nothing here casts a shadow: at 12 px a house
     shadow is a 3 px smudge and the depth pass is the frame's other big cost. */
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const own = new Set();                  // only what WE minted is ours to dispose
  const mk = k => k === 'unit' ? new THREE.BoxGeometry(1, 1, 1)
    : k === 'gable' ? gablePrism() : new THREE.ConeGeometry(.72, 1, 4, 1, true);
  // The shared shape decides the silhouette; `shaded` mints OUR copy of it, so
  // nothing here ever writes to a geometry buildings.js also draws.
  const src = k => G[k] || mk(k);
  const gUnit = shaded(src('unit'), (v, n) => n.y > .9 ? BODY_TOP : n.y < -.9 ? BODY_BOT : 1);
  // The prism spans y 0..1 (`rY` IS its eave line); the cone is centred, y ±.5.
  const gGable = shaded(src('gable'), (v, n) => n.y < -.5 ? SOFFIT : EAVE_K + (RIDGE_K - EAVE_K) * clamp(v.y, 0, 1));
  const gPyr = shaded(src('pyr'), (v, n) => n.y < -.5 ? SOFFIT : EAVE_K + (RIDGE_K - EAVE_K) * clamp(v.y + .5, 0, 1));
  const gWin = winCross(), gSail = sailCross(), gQuad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  own.add(gUnit); own.add(gGable); own.add(gPyr);
  own.add(gWin); own.add(gSail); own.add(gQuad);

  // THE FAR TOWN LIVES INSIDE THE SAME FRAGMENT PASS AS THE NEAR TOWN. These two
  // used to be plain MeshStandardMaterials, so the moment a building swapped to an
  // impostor it lost its rim light, its base AO and — the one that matters — its
  // uLandFar convergence. The far town is BY DEFINITION the part of the town the
  // far-land match exists for, so skipping it there reintroduced the exact colour
  // discontinuity the surface pass was written to close, on the far side of the
  // swap. applyTownSurface is idempotent and chains, so this is the whole fix.
  // `vertexColors` is what lets the baked shade above reach the shader; three
  // multiplies vColor by instanceColor, so the per-building tint still decides the
  // hue and this only decides where the shape is dark. All four streams that wear
  // this material carry the attribute — matThin's two do NOT, which is why the
  // thin family stays a separate, plain material.
  const matSolid = applyTownSurface(new THREE.MeshStandardMaterial({ roughness: .85, vertexColors: true }), 'building');
  const matThin = applyTownSurface(new THREE.MeshStandardMaterial({ roughness: .9, side: THREE.DoubleSide }), 'building');
  const matWin = cfg.winMat || new THREE.MeshStandardMaterial(
    { color: 0x11141c, emissive: 0xffd68c, emissiveIntensity: 0, roughness: .45 });
  const ownWin = !cfg.winMat;

  function stream(g, m, n, tinted) {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;   // the instance spread IS the plat; a bounding sphere
    im.castShadow = false;      // test over it always passes and always costs
    im.receiveShadow = true;
    if (tinted) {
      const c = new THREE.Color(0xffffff);
      for (let i = 0; i < n; i++) im.setColorAt(i, c);
      im.instanceColor.needsUpdate = true;
    }
    // Untouched slots must collapse, not draw a unit cube at the origin.
    for (let i = 0; i < n; i++) im.setMatrixAt(i, ZERO);
    im.instanceMatrix.needsUpdate = true;
    im.count = 0;
    scene.add(im);
    return im;
  }
  const EX_CAP = Math.min(cap, 128), SAIL_CAP = Math.min(cap, 96);
  const IM = {
    body: stream(gUnit, matSolid, cap, 1),
    roofG: stream(gGable, matSolid, cap, 1),
    roofP: stream(gPyr, matSolid, cap, 1),
    chim: stream(gUnit, matSolid, cap, 1),
    win: stream(gWin, matWin, cap, 0),
    sail: stream(gSail, matThin, SAIL_CAP, 1),
    quad: stream(gQuad, matThin, EX_CAP, 1)
  };

  /* ── slot pools. `body` is direct (index === ordinal, forever); every other
     stream is pooled so a mixed town does not pay 1 200 collapsed instances per
     roof kind. Allocation is a stack pop — no churn, no compaction, no garbage. */
  function pool(n) {
    const p = { free: new Int32Array(n), nf: n, hi: -1, of: new Int16Array(cap), n };
    for (let i = 0; i < n; i++) p.free[i] = n - 1 - i;   // hand out 0,1,2… first
    p.of.fill(-1);
    return p;
  }
  const P = {
    roofG: pool(cap), roofP: pool(cap), chim: pool(cap),
    win: pool(cap), sail: pool(SAIL_CAP), quad: pool(EX_CAP)
  };
  function take(p, i) {
    if (p.of[i] >= 0) return p.of[i];
    if (p.nf <= 0) return -1;                             // pool full: that detail is
    const s = p.free[--p.nf];                             // simply absent, nothing breaks
    p.of[i] = s; if (s > p.hi) { p.hi = s; }
    return s;
  }
  function give(p, i) {
    const s = p.of[i]; if (s < 0) return;
    p.of[i] = -1; p.free[p.nf++] = s;
  }

  /* ── the pick hash: (gx,gz) → ordinals. Buckets are REUSED (length = 0), never
     deleted, so 20 epoch switches allocate nothing after the first town. ── */
  const cells = new Map();
  const key = (gx, gz) => gx * 100003 + gz;
  function bucket(gx, gz, make) {
    const k = key(gx, gz);
    let a = cells.get(k);
    if (!a && make) cells.set(k, a = []);
    return a;
  }
  // Scratch, not a returned tuple: a cascade calls this 1 200 times in a second.
  const hr = new Int32Array(4);
  function hashRange(i) {
    const r = PLOT_R + bRad[i] * .35;
    hr[0] = Math.floor((bx[i] - r) / CELL); hr[1] = Math.floor((bx[i] + r) / CELL);
    hr[2] = Math.floor((bz[i] - r) / CELL); hr[3] = Math.floor((bz[i] + r) / CELL);
  }
  function hashAdd(i) {
    hashRange(i);
    for (let gx = hr[0]; gx <= hr[1]; gx++) for (let gz = hr[2]; gz <= hr[3]; gz++) bucket(gx, gz, 1).push(i);
  }
  function hashDel(i) {
    hashRange(i);
    for (let gx = hr[0]; gx <= hr[1]; gx++) for (let gz = hr[2]; gz <= hr[3]; gz++) {
      const a = bucket(gx, gz, 0); if (!a) continue;
      const k = a.indexOf(i); if (k >= 0) a.splice(k, 1);
    }
  }

  /* ── matrix writing. Everything is T·Ry·S, so one compose per instance. ── */
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _c = new THREE.Color();
  const _sph = new THREE.Sphere(), _pm = new THREE.Matrix4(), _mvi = new THREE.Matrix4();
  const _fr = new THREE.Frustum();

  function put(im, slot, x, y, z, yaw, sx, sy, sz) {
    if (slot < 0) return;
    _e.set(0, yaw, 0); _q.setFromEuler(_e);
    _p.set(x, y, z); _s.set(sx, sy, sz);
    im.setMatrixAt(slot, _m.compose(_p, _q, _s));
    im.instanceMatrix.needsUpdate = true;
  }
  function drop(im, slot) {
    if (slot < 0) return;
    im.setMatrixAt(slot, ZERO);
    im.instanceMatrix.needsUpdate = true;
  }
  function tint(im, slot, hex, k) {
    if (slot < 0) return;
    _c.setHex(hex); if (k !== undefined) _c.multiplyScalar(k);
    im.setColorAt(slot, _c);
    im.instanceColor.needsUpdate = true;
  }

  /* ── writing one building's instances ─────────────────────────── */
  function writeSolid(i) {
    const s = bscl[i], yaw = byaw[i], x = bx[i], z = bz[i];
    IM.body.count = Math.max(IM.body.count, i + 1);
    put(IM.body, i, x, bY0[i] + s * ih[i] * .5, z, yaw, s * iw[i], s * ih[i], s * id[i]);
    if (rk[i]) {
      const im = rk[i] === 1 ? IM.roofG : IM.roofP, p = rk[i] === 1 ? P.roofG : P.roofP;
      put(im, p.of[i], x, s * rY[i], z, yaw + ry[i], s * rw[i], s * rh[i], s * rd[i]);
    }
  }
  function parkSolid(i) {
    drop(IM.body, i);
    if (rk[i] === 1) drop(IM.roofG, P.roofG.of[i]); else if (rk[i] === 2) drop(IM.roofP, P.roofP.of[i]);
  }
  /** Local (x,z) → world, through the group's yaw and uniform scale. */
  const wX = (i, lx, lz) => bx[i] + bscl[i] * (Math.cos(byaw[i]) * lx + Math.sin(byaw[i]) * lz);
  const wZ = (i, lx, lz) => bz[i] + bscl[i] * (-Math.sin(byaw[i]) * lx + Math.cos(byaw[i]) * lz);

  function writeDetail(i, on) {
    const cs = P.chim.of[i];
    if (cs >= 0) {
      if (on) {
        const s = bscl[i], h = .8;
        put(IM.chim, cs, wX(i, chx[i], chz[i]), s * (chy[i] - h * .5), wZ(i, chx[i], chz[i]),
          byaw[i], s * .34, s * h, s * .34);
      } else drop(IM.chim, cs);
    }
    const k = exk[i];
    if (!k) return;
    const im = k === EX_SAILS ? IM.sail : IM.quad, p = k === EX_SAILS ? P.sail : P.quad;
    const slot = p.of[i];
    if (slot < 0) return;
    if (!on) { drop(im, slot); return; }
    const s = bscl[i] * exs[i];
    put(im, slot, wX(i, exx[i], exz[i]), bscl[i] * exy[i], wZ(i, exx[i], exz[i]), byaw[i], s, s, s);
  }
  function writeWin(i, on) {
    const slot = P.win.of[i];
    if (slot < 0 || winOn[i] === (on ? 1 : 0)) return;
    winOn[i] = on ? 1 : 0;
    if (!on) { drop(IM.win, slot); return; }
    // A QUARTER OF THE FAÇADE IS NOT A WINDOW, IT IS A LETTERBOX. The pane used to
    // be half the wall wide and a quarter of it tall, which was defensible while it
    // only ever appeared at night as a glow — a glow has no edges. Now that it also
    // stands in for the openings by day it has edges, and at this size a dark
    // rectangle that big reads as a slot cut in the wall rather than as windows. A
    // real elevation's openings integrate to a small dark mark near the middle of
    // it; this is that mark, and at night it is a brighter, tighter light than the
    // band it replaces.
    const s = bscl[i];
    put(IM.win, slot, bx[i], bY0[i] + s * ih[i] * .48, bz[i], byaw[i],
      s * Math.min(iw[i] * .34, 1.05), s * ih[i] * .15, s * id[i] + .06);
  }

  /** The one mutation point for a building's tier — it also keeps the counters. */
  function applyTier(i, t) {
    const prev = tier[i];
    if (prev === t) return;
    tier[i] = t;
    if (prev === T_FULL) hot--; else if (prev !== T_NONE) active--;
    if (t === T_FULL) hot++; else active++;
    const imp = t !== T_FULL;                 // is the impostor the one being drawn?
    if (imp) writeSolid(i); else parkSolid(i);
    writeDetail(i, t === T_DETAIL);
    // GLASS IS DARK IN DAYLIGHT, and daylight is most of the picture. The panes
    // used to be drawn only past night > .15, so for sixteen hours a day every
    // impostor was one uninterrupted plane of wall colour — which is most of what
    // "no material read at all" meant. buildings.js's shared pane is 0x28323C
    // before its emissive comes up, i.e. exactly the value a real façade's
    // openings integrate to at this size, and the stream is allocated for every
    // building whether it draws or not (instance counts are a high-water mark), so
    // showing it by day costs zero triangles and zero draw calls.
    writeWin(i, imp);
    showGroup(i, !imp);
  }
  /** lod owns house-group visibility in mode B; in mode A the whole root is detached. */
  function showGroup(i, on) {
    const e = ents && ents[i];
    if (e && e.group) e.group.visible = on;
  }

  /* ── sizing & thresholds ───────────────────────────────────────── */
  function viewH(now) {
    // A layout read is not free and town.js rewrites #stats at 2 Hz — prefer the
    // size resize() hands us, and only sniff the DOM about once a second.
    if (!sized && cfg.stage && now - vhAt > 1000) {
      vhAt = now;
      const h = cfg.stage.clientHeight | 0;
      if (h > 2) vh = h;
    }
    return vh;
  }
  const fullIn = () => quality === 'med' ? FULL_IN * 1.7 : FULL_IN;
  const fullOut = () => quality === 'med' ? FULL_OUT * 1.7 : FULL_OUT;

  /** Screen height in px of building i, and its tier under the current mode. */
  function tierFor(i, px, forceImp) {
    if (live[i] === 2) return T_FULL;                    // no impostor: it stays real
    const prev = tier[i];
    if (!forceImp) {
      const want = prev === T_FULL ? px >= fullOut() : px >= fullIn();
      if (want && inFrustum(i, prev === T_FULL)) return T_FULL;
    }
    return (prev === T_DETAIL ? px >= DET_OUT : px >= DET_IN) ? T_DETAIL : T_PLAIN;
  }
  function inFrustum(i, pad) {
    if (!swept) return true;                 // no camera pass yet: never cull blind
    _sph.center.set(bx[i], (bY0[i] + bTop[i]) * .5, bz[i]);
    _sph.radius = bRad[i] + (bTop[i] - bY0[i]) * .5 + (pad ? FRUSTUM_PAD : 0);
    return _fr.intersectsSphere(_sph);
  }

  /* ── the 10 Hz sweep ───────────────────────────────────────────── */
  function sweep(now) {
    sweepAt = now;
    camera.updateMatrixWorld();
    _mvi.copy(camera.matrixWorld).invert();
    _fr.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, _mvi));
    swept = true;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    lastCx = cx; lastCy = cy; lastCz = cz;
    const forceImp = mode === 'A', vd = visDirty;
    visDirty = false;
    for (let i = 0; i <= hiOrd; i++) {
      if (!live[i]) continue;
      const dx = bx[i] - cx, dz = bz[i] - cz, dy = (bY0[i] + bTop[i]) * .5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      applyTier(i, tierFor(i, (bTop[i] - bY0[i]) / d * K, forceImp));
      if (tier[i] !== T_FULL) writeWin(i, true);
      // The entity list can arrive after the first buildings do (and a mode flip
      // re-attaches groups that were never told), so re-assert on a dirty pass only.
      if (vd) showGroup(i, tier[i] === T_FULL);
    }
  }

  /* ── public ────────────────────────────────────────────────────── */
  function set(i, x, z, yaw, s, imp) {
    if (dead || !(i >= 0) || i >= cap) return;
    if (live[i]) clear(i);
    s = s > 1e-3 ? s : 1;
    bx[i] = x; bz[i] = z; byaw[i] = yaw || 0; bscl[i] = s;
    const ok = !!imp && imp.w > 0 && imp.h > 0 && imp.d > 0;
    if (ok) {
      iw[i] = imp.w; ih[i] = imp.h; id[i] = imp.d;
      bY0[i] = s * (imp.y0 || 0);
      rk[i] = imp.rk === 1 || imp.rk === 2 ? imp.rk : 0;
      rw[i] = imp.rw || imp.w; rh[i] = imp.rh || 0; rd[i] = imp.rd || imp.d;
      ry[i] = imp.ry || 0; rY[i] = imp.rY || (imp.y0 || 0) + imp.h;
      if (!(rh[i] > 0)) rk[i] = 0;
      // EVERY IMPOSTOR GETS A LID. About one building in sixty derives no roof
      // primitive at all — a flat-roofed market, a slab that IS the building — and
      // since the body's top face is now shaded as a loft floor, leaving one bare
      // would swap one wrong read (a lit crate) for another (a black hole in the
      // roofline). A cap 3 % of the wall's height, in the roof's own colour, is
      // what those buildings have in the near town too. The .982 / +45° pair is
      // buildings.js's own hip convention: a 4-segment cone turned an eighth puts
      // its four base vertices on the corners of an axis-aligned rectangle 1.018·r
      // across, so this cap's footprint IS the mass box's.
      // …unless the builder already handed us one. A market's authored impostor is
      // a counter and a CANVAS — `extra.geo === 'awning'` IS its roof — so capping
      // the counter would put a lid inside the stall.
      const exG = imp.extra && imp.extra.geo;
      if (!rk[i] && imp.h > .2 && exG !== 'awning') {
        rk[i] = 2; rh[i] = Math.max(.05, imp.h * .03);
        rw[i] = imp.w * .982; rd[i] = imp.d * .982;
        ry[i] = Math.PI / 4; rY[i] = (imp.y0 || 0) + imp.h + rh[i] * .5;
      }
      // …AND THE LID HAS TO COVER THE BOX. `impostorOf` grows the mass from every
      // wall in the group — cross-wings, lean-tos, porches — but replays only the
      // ONE largest roof primitive, so an L-plan came back as a wide box with a
      // narrow roof laid down the middle of it, i.e. a crate with the lid resting
      // in the opening. That is the single loudest defect at the framing the user's
      // own total produces, and it is a drawing decision, not a spec one: the mass
      // is a box, so the roof over it should be one roof. Grown per axis, through
      // `ry` (a roof turned a quarter has its span on the body's z), to a 3 % eave
      // overhang, and only for a roof that is already MOSTLY the building — a
      // spire, a well's canopy or a dome-cap covers a third of its tower and blowing
      // that up to the full footprint would be a different building. The span axis
      // takes its pitch back by sqrt, so a widened roof does not flatten into a
      // sheet and does not inflate the skyline either.
      if (rk[i]) {
        const swap = Math.abs(Math.cos(ry[i])) < .7071;      // ridge across, not along
        const sX = swap ? rd[i] : rw[i], sZ = swap ? rw[i] : rd[i];
        const kX = clamp(imp.w * 1.03 / Math.max(1e-4, sX), 1, 1.35);
        const kZ = clamp(imp.d * 1.03 / Math.max(1e-4, sZ), 1, 1.35);
        if (sX >= imp.w * .45 && sZ >= imp.d * .45 && (kX > 1.001 || kZ > 1.001)) {
          const kW = swap ? kZ : kX, kD = swap ? kX : kZ;    // …back into roof axes
          rw[i] *= kW; rd[i] *= kD;
          rh[i] *= Math.sqrt(kW);
          // The gable's origin is its eave, so its ridge rises on its own; the
          // centred cone's does not, and half the new height has to be given back.
          if (rk[i] === 2) rY[i] += rh[i] * (1 - 1 / Math.sqrt(kW)) * .5;
        }
      }
      // gable: rY is the eave line, base-origin. pyramid: GEO.pyr is a CENTRED cone,
      // so its ridge is half a height above rY. Getting this wrong tilts every
      // screen-height estimate and every hover box by up to 0.6 units.
      bTop[i] = Math.max(bY0[i] + s * imp.h, s * (rY[i] + (rk[i] === 1 ? rh[i] : rk[i] === 2 ? rh[i] * .5 : 0)));
      // AND THE EXTRA IS PART OF THE BUILDING'S HEIGHT. `bTop` decides three things —
      // the screen height every tier is chosen from, the hover box, and the ring a
      // deed card draws — and it used to be measured off the MASS alone. A market's
      // mass is its 1.05-unit counter and its canvas floats at 2.3, so a stall
      // reported a fifth of the screen height it occupies: it could never reach FULL
      // however close the camera came, it dropped its own canopy the moment the
      // DETAIL line was crossed, and hovering the canvas hit nothing at all. A
      // windmill's sails are the same story from the top of the mill.
      const ex0 = imp.extra;
      if (ex0 && ex0.geo) {
        const eTop = (ex0.y || 0) + (ex0.geo === 'sails' ? (ex0.s > 0 ? ex0.s : 1) * .5 : .06);
        if (s * eTop > bTop[i]) bTop[i] = s * eTop;
      }
      bHW[i] = s * Math.max(imp.w, rk[i] ? rw[i] : 0) * .5;
      bHD[i] = s * Math.max(imp.d, rk[i] ? rd[i] : 0) * .5;
    } else {
      // No impostor (a landmark, or a builder that grew a silhouette we can't derive):
      // register the box so hover and rings still work, and pin it to FULL.
      iw[i] = ih[i] = id[i] = 0; rk[i] = 0;
      bY0[i] = 0; bTop[i] = s * ((imp && imp.hTop) || 3.5);
      bHW[i] = bHD[i] = s * 1.9;
    }
    bRad[i] = Math.sqrt(bHW[i] * bHW[i] + bHD[i] * bHD[i]);
    live[i] = ok ? 1 : 2;
    tier[i] = T_NONE; winOn[i] = 0; exk[i] = EX_NONE;
    nSet++; if (i > hiOrd) hiOrd = i;
    hashAdd(i);

    if (ok) {
      if (rk[i] === 1) tint(IM.roofG, take(P.roofG, i), imp.roof);
      else if (rk[i] === 2) tint(IM.roofP, take(P.roofP, i), imp.roof);
      tint(IM.body, i, imp.wall);
      if (imp.ch) {
        chx[i] = imp.ch.x || 0; chy[i] = imp.ch.y || 0; chz[i] = imp.ch.z || 0;
        tint(IM.chim, take(P.chim, i), imp.roof, .82);
      }
      take(P.win, i);
      const ex = imp.extra;
      if (ex && ex.geo) {
        const k = ex.geo === 'sails' ? EX_SAILS : ex.geo === 'awning' ? EX_AWNING
          : ex.geo === 'field' ? EX_FIELD : EX_NONE;
        if (k) {
          const p = k === EX_SAILS ? P.sail : P.quad, slot = take(p, i);
          if (slot >= 0) {
            exk[i] = k; exx[i] = ex.x || 0; exy[i] = ex.y || 0; exz[i] = ex.z || 0;
            exs[i] = ex.s > 0 ? ex.s : 1;
            tint(k === EX_SAILS ? IM.sail : IM.quad, slot, ex.color === undefined ? imp.wall : ex.color);
          }
        }
      }
      syncCounts();
    }
    // Assign a tier NOW, in the same frame the hand-off happens: a settled building
    // that waited for the next sweep would blink out of the town for up to 100 ms.
    if (camera) {
      const c = camera.position;
      const dx = x - c.x, dz = z - c.z, dy = (bY0[i] + bTop[i]) * .5 - c.y;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      applyTier(i, tierFor(i, (bTop[i] - bY0[i]) / d * K, mode === 'A'));
      if (tier[i] !== T_FULL) writeWin(i, true);
    } else applyTier(i, live[i] === 2 ? T_FULL : T_DETAIL);
  }

  function clear(i) {
    if (!(i >= 0) || i >= cap || !live[i]) return;
    if (tier[i] === T_FULL) hot--; else if (tier[i] !== T_NONE) active--;
    // Hand the group back the way we took it. A building that leaves lod's care
    // while it was an impostor would otherwise stay hidden for good — and if it
    // is the one the deed card is open on, the card would describe nothing.
    showGroup(i, true);
    parkSolid(i);
    if (P.chim.of[i] >= 0) drop(IM.chim, P.chim.of[i]);
    if (P.win.of[i] >= 0) drop(IM.win, P.win.of[i]);
    if (exk[i] === EX_SAILS) drop(IM.sail, P.sail.of[i]);
    else if (exk[i]) drop(IM.quad, P.quad.of[i]);
    for (const k in P) give(P[k], i);
    hashDel(i);
    live[i] = 0; tier[i] = T_NONE; winOn[i] = 0; exk[i] = EX_NONE; rk[i] = 0;
    nSet--;
  }

  function syncCounts() {
    IM.body.count = Math.max(IM.body.count, hiOrd + 1);
    IM.roofG.count = P.roofG.hi + 1; IM.roofP.count = P.roofP.hi + 1;
    IM.chim.count = P.chim.hi + 1; IM.win.count = P.win.hi + 1;
    IM.sail.count = P.sail.hi + 1; IM.quad.count = P.quad.hi + 1;
  }

  function setCold(on) {
    if (!coldRoot) return;
    if (on) { if (coldRoot.parent !== scene) scene.add(coldRoot); }
    else if (coldRoot.parent) coldRoot.parent.remove(coldRoot);
  }

  function update(now, ctx, houses) {
    if (dead) return mode;
    if (houses && houses !== ents) { ents = houses; visDirty = true; sweepAt = -1e9; }
    if (!camera) return mode;
    const t = typeof now === 'number' ? now : performance.now();
    const c = camera.position;
    const b = ctx && ctx.bounds;
    const cxT = b ? b.cx : 0, czT = b ? b.cz : 0;
    const camDist = Math.max(1, Math.hypot(c.x - cxT, c.y - 3, c.z - czT));
    K = viewH(t) / (2 * Math.tan(camera.fov * Math.PI / 360));
    medPx = MED_H / camDist * K;

    let m = mode;
    if (quality === 'low') m = 'A';
    else if (mode === 'B' && medPx < MODE_A_PX) m = 'A';
    else if (mode === 'A' && medPx > MODE_B_PX) m = 'B';
    const flipped = m !== mode;
    if (flipped) { mode = m; setCold(m === 'B'); visDirty = true; if (cfg.onMode) cfg.onMode(m); }

    // The NPC tier, decided once for the whole app (npcs.js consumes, never recomputes).
    // FROM THE TOWN, not from the world origin. The mode decision six lines up
    // already measures against the centre of mass, and "ONE threshold for the
    // whole app" only means anything if both consumers measure from the same
    // point. layout.js's riverside and lakeside plans put the square well off
    // the origin, so on those archetypes the NPC tier flipped at the wrong
    // distance — parts dropped and third-rate stepping engaged while the camera
    // was still close to the people it was stepping.
    npc.camD = Math.max(1, Math.hypot(c.x - cxT, c.y, c.z - czT));
    npc.px = .62 * (1 + .5 * clamp((npc.camD - 80) / 170, 0, 1)) / npc.camD * K;
    const far = npc.far ? npc.px < NPC_FAR_OUT : npc.px < NPC_FAR_IN;
    if (far !== npc.far) { npc.far = far; npc.stride = far ? 3 : 1; if (cfg.onNpcTier) cfg.onNpcTier(npc); }

    // The panes are MOUNTED at every impostor tier now, day and night, so there is
    // no `winWant` gate left to keep: what the hour decides is only how hard they
    // glow, and town.js's one `emissiveIntensity` write does that on the shared
    // material. This branch is the fallback for a harness that passed no `winMat`.
    if (ownWin) {
      const night = ctx && typeof ctx.night === 'number' ? ctx.night : 0;
      matWin.emissiveIntensity = night * 2.2 + .04;
    }

    const dx = c.x - lastCx, dy = c.y - lastCy, dz = c.z - lastCz;
    if (flipped || t - sweepAt >= SWEEP_MS || dx * dx + dy * dy + dz * dz > SWEEP_MOVE2) sweep(t);
    return mode;
  }

  /* ── the analytic hover pick ────────────────────────────────────
     A ray/OBB march over the plot hash: ~20 box tests instead of a recursive
     raycast over 4 800 meshes, correct in EVERY tier (an impostored building is
     as hoverable as a full one), and it never reports a hit on the sky beside a
     roof the way a bounding-sphere test does. */
  const _pk = { i: -1, t: 0 };
  function pick(rayLike) {
    if (dead || !nSet || !rayLike) return -1;
    const ray = rayLike.ray || rayLike;
    const o = ray.origin, d = ray.direction;
    if (!o || !d) return -1;
    let span = d.y < -1e-4 ? -o.y / d.y : 400;
    span = clamp(span, 12, 900);
    const steps = clamp(Math.ceil(span / 6), 8, 96);
    if (++stampN > 4294967000) { stamp.fill(0); stampN = 1; }   // a tray toy runs for days
    const s0 = stampN;
    let best = -1, bestT = Infinity;
    for (let s = 0; s <= steps; s++) {
      const t = 1 + (span - 1) * (s / steps);
      const a = bucket(Math.floor((o.x + d.x * t) / CELL), Math.floor((o.z + d.z * t) / CELL), 0);
      if (!a) continue;
      for (let k = 0; k < a.length; k++) {
        const i = a[k];
        if (stamp[i] === s0) continue;
        stamp[i] = s0;
        const ht = hitBox(o, d, i);
        if (ht >= 0 && ht < bestT) { bestT = ht; best = i; }
      }
    }
    _pk.i = best; _pk.t = best < 0 ? 0 : bestT;
    return best;
  }
  /** Slab test in the building's own yaw frame. @returns {number} t, or -1 */
  function hitBox(o, d, i) {
    const c = Math.cos(byaw[i]), sn = Math.sin(byaw[i]);
    const ox = o.x - bx[i], oz = o.z - bz[i];
    const lx = c * ox - sn * oz, lz = sn * ox + c * oz;
    const dx = c * d.x - sn * d.z, dz = sn * d.x + c * d.z;
    let t0 = 0, t1 = Infinity;
    // x, then y, then z — any empty overlap kills the test
    let a = dx === 0 ? 1e30 : 1 / dx;
    let n = (-bHW[i] - lx) * a, f = (bHW[i] - lx) * a;
    if (n > f) { const q = n; n = f; f = q; }
    t0 = n > t0 ? n : t0; t1 = f < t1 ? f : t1; if (t0 > t1) return -1;
    a = d.y === 0 ? 1e30 : 1 / d.y;
    n = (bY0[i] - o.y) * a; f = (bTop[i] - o.y) * a;
    if (n > f) { const q = n; n = f; f = q; }
    t0 = n > t0 ? n : t0; t1 = f < t1 ? f : t1; if (t0 > t1) return -1;
    a = dz === 0 ? 1e30 : 1 / dz;
    n = (-bHD[i] - lz) * a; f = (bHD[i] - lz) * a;
    if (n > f) { const q = n; n = f; f = q; }
    t0 = n > t0 ? n : t0; t1 = f < t1 ? f : t1;
    return t0 > t1 || t1 < 0 ? -1 : t0;
  }

  function reset() {
    for (let i = 0; i <= hiOrd; i++) if (live[i]) clear(i);
    for (const a of cells.values()) a.length = 0;       // buckets are reused, not re-minted
    for (const k in IM) IM[k].count = 0;
    for (const k in P) { const p = P[k]; p.nf = p.n; p.hi = -1; for (let i = 0; i < p.n; i++) p.free[i] = p.n - 1 - i; p.of.fill(-1); }
    built = 0; hiOrd = -1; nSet = 0; hot = 0; active = 0;
    tier.fill(T_NONE); live.fill(0); winOn.fill(0); exk.fill(EX_NONE);
    mode = 'B'; sweepAt = -1e9; lastCx = 1e9; swept = false; visDirty = true;
    setCold(true);
    ents = cfg.houses || null;
  }

  return {
    set, clear, pick, reset,
    /** park (true) / show (false) the impostor for ordinal i. */
    park(i, on) {
      if (dead || !(i >= 0) || i >= cap || !live[i]) return;
      if (on) applyTier(i, T_FULL);
      else if (tier[i] === T_FULL || tier[i] === T_NONE) applyTier(i, T_DETAIL);
    },
    setCount(n) { built = clamp(n | 0, 0, cap); },
    update,
    /** From town.js's resize(). Only the height matters — px are vertical. */
    setSize(w, h) { if (h > 2) { vh = h; sized = true; } sweepAt = -1e9; },
    setQuality(q) { if (q === quality) return; quality = q === 'med' || q === 'low' ? q : 'high'; sweepAt = -1e9; },
    /** @returns {?Object} out, filled in place: the building's world box. */
    boxAt(i, out) {
      if (!(i >= 0) || i >= cap || !live[i]) return null;
      const o = out || {};
      o.x = bx[i]; o.z = bz[i]; o.yaw = byaw[i];
      o.y = bY0[i]; o.top = bTop[i]; o.h = bTop[i] - bY0[i];
      o.w = bHW[i] * 2; o.d = bHD[i] * 2;
      return o;
    },
    /** Against the last sweep's frustum — for anyone who wants to skip offscreen work. */
    inView(x, y, z, r) {
      if (!swept) return true;
      _sph.center.set(x, y || 0, z); _sph.radius = r > 0 ? r : 1;
      return _fr.intersectsSphere(_sph);
    },
    /** Ray distance of the last pick() hit — interact.js compares it against the
     *  raycaster's nearest non-house hit and takes the closer one. Valid until
     *  the next pick(); Infinity when that one missed. */
    get pickDist() { return _pk.i < 0 ? Infinity : _pk.t; },
    /** The tier ordinal i is being drawn at: 0 full · 1 impostor+detail · 2 impostor. */
    tierOf(i) { return i >= 0 && i < cap && live[i] ? tier[i] : -1; },
    /** The entity registered at ordinal i — the same object town.js holds in
     *  `houses[i]`, so identity is stable across every tier change. Null once the
     *  ordinal is cleared, which is what keeps a demolished house un-selectable. */
    entAt(i) { return i >= 0 && i < cap && live[i] && ents ? (ents[i] || null) : null; },
    /** Highest ordinal ever registered this epoch — the bound for a registry scan. */
    get maxOrd() { return hiOrd; },
    /** LIVE object — read it, never write it. */
    npcTier() { return npc; },
    get mode() { return mode; },
    get medPx() { return medPx; },
    get hotCount() { return hot; },
    get activeCount() { return active; },
    get builtCount() { return nSet; },
    get quality() { return quality; },
    stats() {
      return {
        mode, medPx: Math.round(medPx * 10) / 10, built, set: nSet, hot, impostors: active,
        draws: (IM.body.count > 0 ? 1 : 0) + (IM.roofG.count > 0 ? 1 : 0) + (IM.roofP.count > 0 ? 1 : 0)
          + (IM.chim.count > 0 ? 1 : 0) + (IM.win.count > 0 ? 1 : 0)
          + (IM.sail.count > 0 ? 1 : 0) + (IM.quad.count > 0 ? 1 : 0),
        npcFar: npc.far, npcPx: Math.round(npc.px * 100) / 100
      };
    },
    dispose() {
      if (dead) return;
      dead = true;
      setCold(true);
      for (let i = 0; i <= hiOrd; i++) if (live[i]) showGroup(i, true);   // as clear() does
      for (const k in IM) { const im = IM[k]; if (im.parent) im.parent.remove(im); im.dispose(); }
      for (const g of own) g.dispose();
      matSolid.dispose(); matThin.dispose();
      if (ownWin) matWin.dispose();
      cells.clear(); ents = null;
    }
  };
}
