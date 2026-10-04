// The memory in the world — the three objects that let a day add up to a life.
// Tasks H2 (the horizon ghost), H3 (the Chronicle Stone), H7 (the bunting),
// plus the record celebration and the Overtaking's anchor.
//
//   THE CHRONICLE STONE   a waist-high parish stone on the verge at the edge of
//                         the square, its two faces engraved with personal
//                         bests. Blank on day one ("the mason waits"). A gold
//                         inlay creeps up the leading edge ONLY inside the last
//                         20 % of a record — below that the stone is stone
//                         (v4-history R2).
//                         IT USED TO BE AN OBELISK: 5.4 units on a stepped
//                         plinth, standing on the plaza's main approach — seven
//                         times the height of the fountain it shared the square
//                         with, and the tallest thing in a first-day village. It
//                         read as a war memorial, and AESTHETIC.md's first rule
//                         is that growth shows as MORE, not TALLER. It is now
//                         1.53 units, roughly chest height, and it stands off
//                         the gate axis where a village would actually put one.
//   THE HORIZON GHOST     yesterday's town, a billboard silhouette on the gate
//                         bearing at 640 units, lamps lit after dark. It is a
//                         neighbour on the eastern road, never a scoreboard:
//                         nothing here states a deficit, ranks a day, or fires
//                         downward.
//   THE BUNTING           pennants strung between the six plaza lamps, one per
//                         day of the current spell. Gained, never lost: setView
//                         may only ever RAISE the count, and no code path in
//                         this file removes a pennant inside an epoch.
//
// PUBLIC SURFACE (exactly this, nothing else is exported)
//   initMemorial(scene, cfg) → Memorial
//   Memorial = { group, ents,
//                setView(v), setPlan(plan, seed), setGhostArt(dayCv, nightCv),
//                setApparentScale(h), celebrateRecord(b), overtook(),
//                ghostAnchor(out), update(dt, now, ctx), reset(), dispose() }
//
// COST (measured, not estimated — memorial-harness.mjs prints both). Draw calls:
// stone body 1 · engraved faces 1 (both faces, one geometry) · gold inlay 1 (only
// while a record is within reach) · ghost ink 1 · ghost lamps 1 (only after dark
// or during an Overtaking) · bunting 1 (only at spell ≥ 3) — SIX worst case,
// FOUR on a normal daylight frame with a ghost and bunting up. Under 170
// triangles in total, of which 96 are the bunting (the stone lost a step when it
// stopped being a monument). Textures: one 512×1024 engraving + two
// 1024×128 skylines ≈ 1.3 MB, and that count never changes for the life of the
// process. update() costs ~1 µs/frame: one distance test at 4 Hz, one colour
// lerp, a yaw assignment and at most twelve vertex writes, with zero allocations.
//
// INTEGRATION — what the wave must wire (nothing here reaches into town.js):
//   1. construct after `news`/`monument`, before refreshFraming:
//        const memorial = initMemorial(scene, { maxAnisotropy: MAXA, paintSkyline,
//          plazaR: () => ctx.plazaR, innerR: () => plan.innerR,
//          gate: () => plan.gate, sampleHeight: env.sampleHeight,
//          accent: () => ctx.accent, seed: daySeed,
//          pressure: () => chronicle.pressure() });   // a METHOD, not a view field
//        for (const {group, ent} of memorial.ents) { tagEnt(group, ent); addHit(group); }
//      ents and their groups OUTLIVE every epoch: register them exactly once.
//   2. tipFor gains one line:  if (typeof e.tip === 'function') return e.tip();
//   3. applyInit, after spliceBestRung:  memorial.setPlan(plan, planSeed);
//                                        memorial.setView(chronicle.view());
//      and the same setView on the 500 ms stats tick (it is idempotent and cheap).
//   4. the records tick:  const at = memorial.celebrateRecord(b);
//                         if (at) burst3d(at, GOLD_HI, 44, 8);
//   5. H6:  const g = memorial.overtook(); if (g) <lift nine birds at g>;
//   6. refreshFraming (optional — the module auto-fits at 4 Hz without it):
//        memorial.setApparentScale(2 * Math.tan(camera.fov * Math.PI / 360) *
//                                  Math.max(180, 640 - dist) * 0.055);
//   7. schedule(1800, () => memorial.setGhostArt(dayCv, nightCv)) for the
//      high-fidelity plan art, off the founding cascade's critical path.
//   8. hardReset:  memorial.reset();   ·   shutdown:  memorial.dispose();
//   9. ctx fields read per frame: night, camera, palette. Nothing else, and all
//      three are optional.
//
// WALL-CLOCK EXISTENCE. Which pennants are up, whether the ghost is in, what the
// engraving says, whether the inlay is showing — all driven by the `now` town.js
// feeds update(), never by accumulated dt, so a 1 fps headless shot is truthful.
// The only clock-paced motion is the pennant sway, and it is a stateless sin of
// the same clock so a throttled compositor cannot fall behind it.
//
// EPOCH DISCIPLINE. Every buffer, material, texture and canvas is minted once in
// initMemorial and reused for the life of the process. reset() re-poses; it never
// allocates and never frees. dispose() releases everything exactly once.
//
// NULL-OBJECT. With no cfg, no view, no painter or no chronicle this module adds
// an empty group to the scene and does nothing — every entry point is a guarded
// no-op, so the wave-0 call sites are safe long before the data exists.
import * as THREE from './vendor/three.module.js';

/**
 * @typedef {Object} MemDay        one day of the derived chronicle, as chronicle.js
 *                                 hands it over. Every field is optional here.
 * @property {number} idx  @property {number} tok  @property {number} [n]
 * @property {number} [tier] @property {number} [marks]
 * @property {string} [name] @property {string} [label] @property {string} [kindLabel]
 * @property {string} [kind] @property {number} [seed]
 *
 * @typedef {Object} MemView       chronicle.view() — read exactly as it ships it,
 *   and every field is treated as optional so a partial or absent view is legal.
 * @property {boolean} [ready]     false ⇒ render NOTHING (no placeholder stone)
 * @property {?MemDay} yesterday   the most recent day before today that has tokens
 * @property {?MemDay} today
 * @property {?{len:number}} spell  the run ending today or yesterday
 * @property {?Object} records     {bestDay:{idx,tok,label}, bestSpell:{len},
 *                                  largest:{idx,n}, firstMs, kept,
 *                                  earliestOvertake:{hhmm}}
 * @property {number} [count]      towns in the chronicle so far
 * @property {MemDay[]} [days] @property {number} [firstMs]
 * @property {{ghost:boolean, showStreaks:boolean}} [prefs]
 * @property {boolean} [ghostAllowed]  false when a forced seed makes "yesterday"
 *                                  the same town as today
 * @property {?{frac:number}} [pressure]  chronicle.pressure() is a METHOD, not a
 *   view field, so town.js normally hands it in as cfg.pressure; this is read as
 *   a fallback when it rides the view instead. Non-null only inside the last
 *   20 % of a record — chronicle.js owns that gate, and nothing here may widen it.
 */

/* ═══ tunables ═════════════════════════════════════════════════ */
// GHOST_R / GHOST_P are ACCEPTANCE-TUNED, not derived: the target is a skyline
// ~30 % of stage width with its tallest spire ~45 px on an 880-px stage. Tune
// them against a screenshot, never against the formula.
const GHOST_R = 640;              // inside environs' veil (940) and the sky dome (820)
const GHOST_P = .055;             // apparent height as a fraction of the viewport
const GHOST_ASPECT = 8;           // the canvas is 1024×128 and the plane matches
const GHOST_FADE_MS = 1600, GHOST_HOLD_MS = 1200;   // in at t≈1.2 s of the ritual
const GHOST_W = 1024, GHOST_H = 128;
const HAZE_CAP = .62;             // see the fog note in initGhost
const COOL_LAND = new THREE.Color(0x6A6E62);        // environs' own uLandFar value
const LAMP_COL = new THREE.Color(0xFFC98A);
const ENG_W = 512, ENG_H = 1024;
const PENNANTS = 12, SPELL_MIN = 3, PENNANT_MS = 90;
const LAMP_N = 6, LAMP_OFF = 1.4, LAMP_A0 = .52, LAMP_TOP = 3.0;   // town.js's plaza lamps
const RECUT_MS = 900;             // a record falls, then the mason re-cuts
// A PARISH STONE, NOT A MONUMENT. Total 1.53 units (≈2.7 m): a single low kerb,
// a short tapered post, a weathered cap. The fountain — the square's actual
// centrepiece — stands about 2 units at its first rung and under 7 at its last,
// so the stone is under it at every tier and always shorter than a cottage.
const STONE_H = 1.15, PLINTH_H = .22, CAP_H = .16, SHAFT_RT = .40, SHAFT_RB = .46;
const STONE_TOP = PLINTH_H + STONE_H + CAP_H;
// how far round from the gate axis the stone sits. Opposite the gate put it
// square in the middle of the view from the road in; 112° puts it on the verge
// at the side of the square, which is where a village keeps its stones.
const STONE_A = Math.PI * .62;
const GOLD = 0xD9A441, GOLD_EM = 0xFFB43C;
const SERIF = 'Georgia, "Times New Roman", serif';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const easeOutCubic = k => 1 - Math.pow(1 - k, 3);
const easeOutBack = k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const seededR = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// The town's own number vocabulary, verbatim from town.js — a stone that said
// "2.4B" beside a footer saying "2.41B" would be reporting a different day.
const grouped = n => String(Math.round(Math.max(n, 0))).replace(/\B(?=(\d{3})+$)/g, ' ');
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : grouped(n);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = ms => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
// +x is east and +z is south in this scene's convention (the sun rises on +x).
const compassOf = a => COMPASS[(Math.round(a / (Math.PI / 4)) + 8) % 8];

// DISPLAY-ONLY MIRRORS of town.js's growth law and ladder, used only when the
// view omits `n` / `tier` / `marks`. They decide nothing: they pick how many
// rectangles and how many spires a 4-pixel-tall silhouette gets. chronicle.js
// supplying the real values always wins.
const sizeOf = tok => Math.min(1200, Math.floor(32 * Math.pow(Math.max(tok, 0) / 1e6, .375)));
// the fountain's eleven rungs, and — separately — the ten rungs that each raise
// a LANDMARK. The last of those is the Inn at 2.5B, which the old single list
// could not express: it counted `rungs - 1` and so lost the tenth landmark on
// the biggest days there are.
const RUNGS = [250e3, 1e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6, 1e9];
const LM_RUNGS = [1e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6, 1e9, 2.5e9];
const countUpTo = tok => { let k = 0; for (const t of RUNGS) if (tok >= t) k++; return k; };
const marksUpTo = tok => { let k = 0; for (const t of LM_RUNGS) if (tok >= t) k++; return k; };

/** Concatenate transformed geometries into one non-indexed buffer. The town is
 *  drawn with a merge-per-object budget (see buildings.js); a five-mesh obelisk
 *  would otherwise cost five draws for ~90 triangles. */
function mergeGeos(parts) {
  const src = [];
  let n = 0;
  for (const p of parts) {
    const c = p.geo.clone().applyMatrix4(p.m);
    const g = c.index ? c.toNonIndexed() : c;
    if (g !== c) c.dispose();
    src.push(g); n += g.attributes.position.count;
  }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0, ou = 0;
  for (const g of src) {
    pos.set(g.attributes.position.array, o);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, ou);
    o += g.attributes.position.count * 3; ou += g.attributes.position.count * 2;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * @param {THREE.Scene} scene
 * @param {Object} [cfg]
 * @param {number} [cfg.maxAnisotropy]
 * @param {(g:CanvasRenderingContext2D, spec:Object, o:Object)=>void} [cfg.paintSkyline]
 *        chronicle.js's shared painter. Absent ⇒ no ghost, and nothing else changes.
 * @param {()=>number} [cfg.plazaR] @param {()=>number} [cfg.innerR]
 * @param {()=>{x:number,z:number,yaw:number}} [cfg.gate]
 * @param {(x:number,z:number)=>number} [cfg.sampleHeight]
 * @param {()=>number} [cfg.accent]
 * @param {()=>Array<{x:number,z:number}>} [cfg.lamps]  plaza lamp positions; absent
 *        ⇒ town.js's own ring formula (plazaR + 1.4, six posts, first at 0.52 rad)
 * @param {number} [cfg.seed]
 * @returns {Memorial}
 */
export function initMemorial(scene, cfg) {
  const C = cfg || {};
  const group = new THREE.Group();
  group.name = 'memorial';
  const MAXA = C.maxAnisotropy || 1;
  const paintSkyline = typeof C.paintSkyline === 'function' ? C.paintSkyline : null;
  const plazaR = () => (typeof C.plazaR === 'function' ? C.plazaR() : 12) || 12;
  const innerR = () => (typeof C.innerR === 'function' ? C.innerR() : 24) || 24;
  const gateOf = () => (typeof C.gate === 'function' ? C.gate() : null)
    || (plan && plan.gate) || { x: 0, z: -24, yaw: 0 };
  const heightAt = (x, z) => (typeof C.sampleHeight === 'function' ? C.sampleHeight(x, z) : 0) || 0;
  const accentOf = () => (typeof C.accent === 'function' ? C.accent() : 0xF3D07A) >>> 0;
  // chronicle.pressure() is a live method, not part of the frozen view()
  const pressureOf = () => (typeof C.pressure === 'function' ? C.pressure() : null)
    || (view && view.pressure) || null;
  let seed = (C.seed >>> 0) || 20260101;

  /* ── state ─────────────────────────────────────────────────── */
  let view = null;                       // last adopted MemView, or null
  let plan = null, lastPalette = null;
  let live = false;                      // anything at all adopted this epoch?
  let stoneShown = false, ghostShown = false;
  let pennants = 0, buntT = 0, buntR = -1;
  let ghostT = 0, ghostIdx = -1;
  let engKey = '', recutAt = 0, flareT = -1e9, overT = -1e9;
  let apparent = 0, autoAt = -1e9, autoH = 0;
  let inlayK = 0, inlayAt = 0, stoneR = -1;
  const stoneP = new THREE.Vector3();     // world position of the stone
  const stoneTop = new THREE.Vector3();
  const ghostP = new THREE.Vector3();
  const _v = new THREE.Vector3();

  /* ═══ the Chronicle Stone ════════════════════════════════════ */
  // Four primitives melted into one buffer (1 draw), two engraved faces sharing
  // one texture in a second (1 draw), and the inlay (1 draw, only while a record
  // is within reach). Nothing here animates but the inlay, so the whole group is
  // matrix-frozen after every placement.
  // The shaft is a 4-sided taper, so the faces and the inlay are cut to the
  // taper rather than stuck on as rectangles — a flat plaque on a tapered stone
  // is buried at one end and floating at the other.
  const K45 = Math.SQRT1_2;
  const shaftR = y => {                                    // radius at world height y
    const u = clamp((y - PLINTH_H) / STONE_H, 0, 1);
    return SHAFT_RB + (SHAFT_RT - SHAFT_RB) * u;
  };
  /** A quad strip laid on the shaft, following the taper. `dir` is the outward
   *  xz unit the strip faces; `side` is the xz unit it is measured across. */
  function shaftStrip(y0, y1, halfW, out, uv0, uv1, dir, side, eps) {
    const r0 = shaftR(y0) * K45 + eps, r1 = shaftR(y1) * K45 + eps;
    const w0 = halfW < 0 ? shaftR(y0) * K45 * -halfW : halfW;
    const w1 = halfW < 0 ? shaftR(y1) * K45 * -halfW : halfW;
    const a = [dir.x * r0 - side.x * w0, y0, dir.z * r0 - side.z * w0];
    const b = [dir.x * r0 + side.x * w0, y0, dir.z * r0 + side.z * w0];
    const c = [dir.x * r1 + side.x * w1, y1, dir.z * r1 + side.z * w1];
    const d = [dir.x * r1 - side.x * w1, y1, dir.z * r1 - side.z * w1];
    const dr = (shaftR(y0) - shaftR(y1)) * K45;            // the lean, for the normal
    const nl = Math.hypot(y1 - y0, dr) || 1;
    const ny = dr / nl, nk = (y1 - y0) / nl;
    for (const [v, u, t] of [[a, 0, uv0], [b, 1, uv0], [c, 1, uv1], [a, 0, uv0], [c, 1, uv1], [d, 0, uv1]]) {
      out.pos.push(v[0], v[1], v[2]);
      out.nor.push(dir.x * nk, ny, dir.z * nk);
      out.uv.push(u, t);
    }
  }
  function stripGeo(runs) {
    const out = { pos: [], nor: [], uv: [] };
    for (const r of runs) shaftStrip(r.y0, r.y1, r.w, out, r.t0, r.t1, r.dir, r.side, r.eps);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(out.nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.uv), 2));
    g.computeBoundingSphere();
    return g;
  }
  const stoneGroup = new THREE.Group();
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xA79C86, roughness: .94 });
  const stoneGeo = (() => {
    const M = THREE.Matrix4, parts = [];
    const box = (w, h, d, y) => ({ geo: new THREE.BoxGeometry(w, h, d), m: new M().makeTranslation(0, y, 0) });
    // ONE kerb, not a flight of steps: steps are what made this a monument.
    parts.push(box(1.34, PLINTH_H, 1.34, PLINTH_H / 2));
    const shaft = new THREE.CylinderGeometry(SHAFT_RT, SHAFT_RB, STONE_H, 4);
    parts.push({ geo: shaft, m: new M().makeRotationY(Math.PI / 4).setPosition(0, PLINTH_H + STONE_H / 2, 0) });
    // a shallow weathered cap. The old one was a 0.62 spike, which is the
    // difference between a boundary stone and an obelisk.
    const cap = new THREE.ConeGeometry(SHAFT_RT * 1.22, CAP_H, 4);
    parts.push({ geo: cap, m: new M().makeRotationY(Math.PI / 4).setPosition(0, PLINTH_H + STONE_H + CAP_H / 2, 0) });
    const g = mergeGeos(parts);
    for (const p of parts) p.geo.dispose();
    return g;
  })();
  const stoneMesh = new THREE.Mesh(stoneGeo, stoneMat);
  stoneMesh.castShadow = true; stoneMesh.receiveShadow = true;
  stoneGroup.add(stoneMesh);

  // The engraving. Painted at a 1:2 aspect and mounted on the two faces the
  // taper leaves widest, so a rectangle never overhangs the stone.
  const engCv = document.createElement('canvas');
  engCv.width = ENG_W; engCv.height = ENG_H;
  const engTex = new THREE.CanvasTexture(engCv);
  engTex.colorSpace = THREE.SRGBColorSpace; engTex.anisotropy = MAXA;
  const faceMat = new THREE.MeshStandardMaterial({ map: engTex, roughness: .92 });
  // The engraving is now nearly the whole face — a slate let into a small stone,
  // rather than a plaque in the middle of a shaft. The texture is 1:2 and the
  // panel is cut to the same proportion: at w = -.86 the face is ~0.52 wide and
  // 0.91 of the shaft is ~1.05 tall, so the lettering is not stretched.
  const FACE_Y0 = PLINTH_H + STONE_H * .05, FACE_Y1 = PLINTH_H + STONE_H * .96;
  const IN = { x: 1, z: 0 }, INS = { x: 0, z: 1 }, OUT = { x: -1, z: 0 }, OUTS = { x: 0, z: -1 };
  const faceGeo = stripGeo([
    { y0: FACE_Y0, y1: FACE_Y1, w: -.86, t0: 0, t1: 1, dir: IN, side: INS, eps: .008 },
    { y0: FACE_Y0, y1: FACE_Y1, w: -.86, t0: 0, t1: 1, dir: OUT, side: OUTS, eps: .008 }
  ]);
  const faceMesh = new THREE.Mesh(faceGeo, faceMat);
  stoneGroup.add(faceMesh);

  // R2 IN THE MESH. The inlay is the only progress bar this feature owns and it
  // cannot exist below 80 % of a record, because chronicle.pressure() returns
  // null there. A meter pinned at 4 % all day is a reproach.
  // It is cut as ten stacked segments up the shaft's leading corner and revealed
  // with a draw range, so it hugs the taper instead of scaling through it — and
  // the reveal is therefore integer state a screenshot can catch mid-climb.
  const INLAY_SEG = 10, INLAY_TOP = STONE_H * .92;
  const inlayGeo = (() => {
    const dir = { x: K45, z: -K45 }, side = { x: K45, z: K45 }, runs = [];
    for (let i = 0; i < INLAY_SEG; i++) {
      runs.push({
        y0: PLINTH_H + INLAY_TOP * (i / INLAY_SEG), y1: PLINTH_H + INLAY_TOP * ((i + 1) / INLAY_SEG),
        w: .034, t0: i / INLAY_SEG, t1: (i + 1) / INLAY_SEG, dir, side, eps: .007
      });
    }
    return stripGeo(runs);
  })();
  inlayGeo.setDrawRange(0, 0);
  const inlayMat = new THREE.MeshStandardMaterial({
    color: GOLD, metalness: .30, roughness: .34, emissive: GOLD_EM, emissiveIntensity: 0
  });
  const inlayMesh = new THREE.Mesh(inlayGeo, inlayMat);
  inlayMesh.visible = false;
  stoneGroup.add(inlayMesh);
  stoneGroup.visible = false;
  group.add(stoneGroup);

  /** Chiselled serif, dark cut with a light bevel above it — the same trick the
   *  signpost's burnt boards use, at twice the resolution. */
  function paintEngraving() {
    const g = engCv.getContext('2d');
    if (!g) return;
    const r = view && view.records ? view.records : null;
    const best = r && r.bestDay && r.bestDay.tok > 0 ? r.bestDay : null;
    g.fillStyle = '#B4AA93'; g.fillRect(0, 0, ENG_W, ENG_H);
    for (let i = 0; i < 260; i++) {                       // quarried grain
      const l = 150 + seededR(i * 3.7) * 40 | 0;
      g.fillStyle = `rgba(${l},${l - 6},${l - 20},.10)`;
      g.fillRect(seededR(i * 1.9) * ENG_W, seededR(i * 5.3) * ENG_H,
        4 + seededR(i * 7.1) * 60, 1 + seededR(i * 2.3) * 3);
    }
    const cut = (text, x, y, px, align, weight) => {
      g.textAlign = align || 'left'; g.textBaseline = 'alphabetic';
      g.font = `${weight || 400} ${px}px ${SERIF}`;
      g.fillStyle = 'rgba(255,252,244,.34)'; g.fillText(text, x, y - 2);
      g.fillStyle = '#544E42'; g.fillText(text, x, y);
    };
    const rule = y => {
      g.fillStyle = 'rgba(255,252,244,.30)'; g.fillRect(70, y, ENG_W - 140, 2);
      g.fillStyle = 'rgba(74,68,58,.55)'; g.fillRect(70, y + 2, ENG_W - 140, 2);
    };
    let t = 'THE CHRONICLE', cx = 0;                      // letter-spaced small caps
    g.font = `600 44px ${SERIF}`;
    let w = 0; for (const ch of t) w += g.measureText(ch).width + 9;
    cx = (ENG_W - (w - 9)) / 2;
    for (const ch of t) { cut(ch, cx, 118, 44, 'left', 600); cx += g.measureText(ch).width + 9; }
    rule(150);
    const rows = [];
    if (best) {
      rows.push(['greatest day', fmtTok(best.tok)]);
      if (best.label) rows.push(['', best.label]);
      const sp = r.bestSpell && r.bestSpell.len >= 2 ? r.bestSpell.len : 0;
      if (sp) rows.push(['longest spell', sp + ' days']);
      const lg = r.largest && r.largest.n > 0 ? r.largest.n : 0;
      if (lg) rows.push(['largest town', lg + (lg === 1 ? ' house' : ' houses')]);
      if (r.earliestOvertake && r.earliestOvertake.hhmm)
        rows.push(['earliest overtaking', String(r.earliestOvertake.hhmm)]);
      const ms = r.firstMs > 0 ? r.firstMs : (view && view.firstMs > 0 ? view.firstMs : 0);
      if (ms) rows.push(['kept since', fmtDate(ms)]);
    } else {
      // DAY ONE IS A PROMISE, NOT A DEFICIT. No zeroes, no dashes in a column of
      // records the user has not had time to set.
      rows.push(['', '—']);
      rows.push(['', 'unmarked']);
      rows.push(['', 'the mason waits']);
    }
    let y = 250;
    for (const [label, val] of rows) {
      if (label) cut(label, 62, y, 30);
      cut(val, ENG_W - 62, y, label ? 34 : 38, 'right', label ? 500 : 400);
      y += label ? 86 : 74;
    }
    rule(ENG_H - 150);
    cut('✦', ENG_W / 2, ENG_H - 92, 34, 'center');
    engTex.needsUpdate = true;
  }

  /** The engraving is repainted ONLY when a record changes — the digest is the
   *  whole gate, and it is what makes a re-cut visible as an event. */
  function refreshEngraving(force) {
    const r = view && view.records ? view.records : null;
    const b = r && r.bestDay ? r.bestDay : null;
    const key = [b ? b.tok : 0, b ? b.label || '' : '', r && r.bestSpell ? r.bestSpell.len : 0,
      r && r.largest ? r.largest.n : 0, r && r.earliestOvertake ? r.earliestOvertake.hhmm : '',
      r ? r.firstMs || 0 : 0].join('|');
    if (!force) {
      if (key === engKey) return;
      // A celebration owns the next cut: the 900 ms delay IS the moment — the
      // user watches the number change — so a 2 Hz setView must not quietly
      // repaint the stone out from under it.
      if (recutAt !== 0) return;
    }
    engKey = key;
    paintEngraving();
  }

  function placeStone() {
    const gt = gateOf();
    // OFF THE MAIN APPROACH. This used to sit at gate + π — dead centre of the
    // view from the road in, directly behind the fountain. It now stands round
    // on the verge at the side of the square, out of the way of the traffic
    // between the gate and the market.
    const a = Math.atan2(gt.z, gt.x) + STONE_A;
    const rad = clamp(plazaR() + 2.6, plazaR() + 1.5, Math.max(plazaR() + 1.5, innerR() - 1.6));
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    stoneP.set(x, heightAt(x, z), z);
    stoneGroup.position.copy(stoneP);
    // the engraved face looks INWARD, so the square reads it
    stoneGroup.rotation.y = Math.PI - a;
    stoneTop.set(x, stoneP.y + STONE_TOP, z);
    stoneR = plazaR();
    stoneGroup.updateMatrixWorld(true);
    stoneMesh.updateMatrix(); stoneMesh.matrixAutoUpdate = false;
    faceMesh.updateMatrix(); faceMesh.matrixAutoUpdate = false;
  }

  /* ═══ the town on the horizon ════════════════════════════════ */
  // Two planes, four triangles, no terrain, no collisions, no second township.
  // The silhouette is painted WHITE and tinted through material.color, so the
  // ghost tracks the fog every frame without re-uploading a 1024×128 texture at
  // dawn — the same trick environs plays with its luminance-plate grass.
  const ghostGroup = new THREE.Group();
  const ghostGeo = new THREE.PlaneGeometry(1, 1);
  const inkCv = document.createElement('canvas'); inkCv.width = GHOST_W; inkCv.height = GHOST_H;
  const litCv = document.createElement('canvas'); litCv.width = GHOST_W; litCv.height = GHOST_H;
  const inkTex = new THREE.CanvasTexture(inkCv), litTex = new THREE.CanvasTexture(litCv);
  for (const t of [inkTex, litTex]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAXA; }
  // fog:false is deliberate. At GHOST_R the scene's own FogExp2 (0.0016 at the
  // working orbit) eats ~65 % of the silhouette, and any weather that raises the
  // density would erase yesterday's town outright. The haze is applied here
  // instead, from the same fog colour, with a cap — so the ghost recedes on a
  // thick day but never disappears.
  const inkMat = new THREE.MeshBasicMaterial({
    map: inkTex, transparent: true, opacity: 0, depthWrite: false, fog: false
  });
  const litMat = new THREE.MeshBasicMaterial({
    map: litTex, transparent: true, opacity: 0, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, color: LAMP_COL.clone()
  });
  const inkMesh = new THREE.Mesh(ghostGeo, inkMat);
  const litMesh = new THREE.Mesh(ghostGeo, litMat);
  inkMesh.renderOrder = -2; litMesh.renderOrder = -1;     // veil (-3) → ghost → plate (0)
  inkMesh.frustumCulled = false; litMesh.frustumCulled = false;
  litMesh.visible = false;
  ghostGroup.add(inkMesh, litMesh);
  ghostGroup.visible = false;
  group.add(ghostGroup);

  /** Cheap-mode art for whatever day the view calls yesterday. One paint per
   *  epoch; town.js may replace it with the high-fidelity plan later. */
  function paintGhost() {
    const y = view && view.yesterday;
    if (!paintSkyline || !y) return;
    const tok = Math.max(y.tok || 0, 0);
    // a Day from chronicle.js is already a valid spec; the fallbacks only fire
    // for a hand-made view
    const spec = {
      seed: (y.seed >>> 0) || (((y.idx || 0) * 2654435761) >>> 0),
      n: y.n > 0 ? y.n : sizeOf(tok),
      tier: y.tier >= 0 ? y.tier : countUpTo(tok),
      marks: y.marks >= 0 ? y.marks : marksUpTo(tok),
      tok, quiet: false, plan: null
    };
    const gi = inkCv.getContext('2d'), gl = litCv.getContext('2d');
    if (gi) {
      gi.clearRect(0, 0, GHOST_W, GHOST_H);
      // white ink + material tint; the caller-side haze mix happens per frame
      try { paintSkyline(gi, spec, { ink: '#ffffff', baseline: .92, jitter: 1 }); }
      catch (e) { gi.clearRect(0, 0, GHOST_W, GHOST_H); }
      inkTex.needsUpdate = true;
    }
    if (gl) {
      gl.clearRect(0, 0, GHOST_W, GHOST_H);
      try { paintSkyline(gl, spec, { ink: 'rgba(0,0,0,0)', lit: '#ffffff', baseline: .92, jitter: 1 }); }
      catch (e) { gl.clearRect(0, 0, GHOST_W, GHOST_H); }
      litTex.needsUpdate = true;
    }
  }

  function placeGhost() {
    const gt = gateOf();
    const a = Math.atan2(gt.z, gt.x);                     // the road out of town
    const x = Math.cos(a) * GHOST_R, z = Math.sin(a) * GHOST_R;
    ghostP.set(x, heightAt(x, z), z);
  }

  /** Constant apparent size. town.js's refreshFraming may pin it with
   *  setApparentScale; otherwise it is recomputed here at 4 Hz off the wall
   *  clock, so the module is correct even before that call site lands. */
  function ghostHeight(now, camera) {
    if (apparent > 0) return apparent;
    if (now - autoAt < 250 && autoH > 0) return autoH;
    autoAt = now;
    const d = Math.max(180, camera ? camera.position.distanceTo(ghostP) : GHOST_R);
    const fov = (camera && camera.fov) || 38;
    autoH = 2 * Math.tan(fov * Math.PI / 360) * d * GHOST_P;
    return autoH;
  }

  /* ═══ the bunting ════════════════════════════════════════════ */
  // One geometry, one draw. The rope is the first chunk and the twelve pennant
  // slots follow it in REVEAL ORDER, so a pennant is raised by widening the draw
  // range — which is why the count can only ever go up and why a 1 fps shot
  // catches the right number of them.
  const ROPE_SEG = 7, ROPE_V = LAMP_N * ROPE_SEG * 6, TOTAL_V = ROPE_V + PENNANTS * 3;
  const buntPos = new Float32Array(TOTAL_V * 3);
  const buntNor = new Float32Array(TOTAL_V * 3);
  const buntCol = new Float32Array(TOTAL_V * 3);
  const buntGeo = new THREE.BufferGeometry();
  buntGeo.setAttribute('position', new THREE.BufferAttribute(buntPos, 3));
  buntGeo.setAttribute('normal', new THREE.BufferAttribute(buntNor, 3));
  buntGeo.setAttribute('color', new THREE.BufferAttribute(buntCol, 3));
  buntGeo.setDrawRange(0, 0);
  const buntMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: .82, side: THREE.DoubleSide
  });
  const buntMesh = new THREE.Mesh(buntGeo, buntMat);
  buntMesh.frustumCulled = false;
  buntMesh.visible = false;
  group.add(buntMesh);
  // Slot k's position never moves when slot k+1 appears — that is R3 expressed as
  // geometry. The spread order keeps three pennants from clustering on one rope.
  const SLOT_SEG = [0, 3, 1, 4, 2, 5];
  const tipBase = new Float32Array(PENNANTS * 3);
  const tipTopY = new Float32Array(PENNANTS);
  const tipPhase = new Float32Array(PENNANTS);

  const lampAt = (i, out) => {
    if (typeof C.lamps === 'function') {
      const L = C.lamps();
      if (L && L[i]) { out.set(L[i].x, LAMP_TOP, L[i].z); return out; }
    }
    const R = plazaR() + LAMP_OFF, a = i / LAMP_N * Math.PI * 2 + LAMP_A0;
    return out.set(Math.cos(a) * R, LAMP_TOP, Math.sin(a) * R);
  };
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();
  const SAG = .62;
  const ropeAt = (A, B, t, out) => out.set(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t - SAG * Math.sin(Math.PI * t), A.z + (B.z - A.z) * t);

  /** Rebuilds the strung geometry in place. Called when the plaza breathes, and
   *  never per frame — the plaza radius moves only when the altar climbs. */
  function buildBunting() {
    const dots = [];
    const pal = lastPalette;
    if (pal && pal.dots) for (const css of pal.dots) { try { dots.push(new THREE.Color(css)); } catch (e) { /* a bad swatch is not worth a bunting */ } }
    if (!dots.length) dots.push(new THREE.Color(accentOf()));
    dots.push(new THREE.Color(accentOf()));
    const hemp = new THREE.Color(0x7A6444);
    let o = 0;
    const put = (v, col, nx, ny, nz) => {
      buntPos[o] = v.x; buntPos[o + 1] = v.y; buntPos[o + 2] = v.z;
      buntNor[o] = nx; buntNor[o + 1] = ny; buntNor[o + 2] = nz;
      buntCol[o] = col.r; buntCol[o + 1] = col.g; buntCol[o + 2] = col.b;
      o += 3;
    };
    const TH = .055;
    for (let s = 0; s < LAMP_N; s++) {
      lampAt(s, _a); lampAt((s + 1) % LAMP_N, _b);
      for (let k = 0; k < ROPE_SEG; k++) {
        ropeAt(_a, _b, k / ROPE_SEG, _p);
        const x0 = _p.x, y0 = _p.y, z0 = _p.z;
        ropeAt(_a, _b, (k + 1) / ROPE_SEG, _p);
        const x1 = _p.x, y1 = _p.y, z1 = _p.z;
        // a flat ribbon, doubled-sided: two triangles per rope span
        _v.set(x0, y0 + TH, z0); put(_v, hemp, 0, 1, 0);
        _v.set(x1, y1 + TH, z1); put(_v, hemp, 0, 1, 0);
        _v.set(x1, y1 - TH, z1); put(_v, hemp, 0, 1, 0);
        _v.set(x0, y0 + TH, z0); put(_v, hemp, 0, 1, 0);
        _v.set(x1, y1 - TH, z1); put(_v, hemp, 0, 1, 0);
        _v.set(x0, y0 - TH, z0); put(_v, hemp, 0, 1, 0);
      }
    }
    const PW = .27, PH = .85;
    for (let k = 0; k < PENNANTS; k++) {
      const s = SLOT_SEG[k % LAMP_N], t = k < LAMP_N ? .34 : .66;
      lampAt(s, _a); lampAt((s + 1) % LAMP_N, _b);
      ropeAt(_a, _b, t, _p);
      const dx = _b.x - _a.x, dz = _b.z - _a.z, dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl, uz = dz / dl;
      // the pennant faces outward from the plaza; a fixed normal is right for a
      // flag and survives the sway without a recompute
      const nx = -uz, nz = ux;
      const col = dots[k % dots.length];
      _v.set(_p.x - ux * PW, _p.y, _p.z - uz * PW); put(_v, col, nx, .25, nz);
      _v.set(_p.x + ux * PW, _p.y, _p.z + uz * PW); put(_v, col, nx, .25, nz);
      _v.set(_p.x, _p.y - PH, _p.z); put(_v, col, nx, .25, nz);
      tipBase[k * 3] = _p.x; tipBase[k * 3 + 1] = _p.y - PH; tipBase[k * 3 + 2] = _p.z;
      tipTopY[k] = _p.y;
      tipPhase[k] = seededR(seed * .0013 + k * 2.7) * Math.PI * 2;
    }
    buntGeo.attributes.position.needsUpdate = true;
    buntGeo.attributes.normal.needsUpdate = true;
    buntGeo.attributes.color.needsUpdate = true;
    buntGeo.computeBoundingSphere();
    buntR = plazaR();
  }

  /* ═══ tooltips — memorial owns its own copy ══════════════════ */
  // town.js keeps owning the tooltip MECHANISM; one line in tipFor delegates:
  //   if (typeof e.tip === 'function') return e.tip();
  const stoneEnt = {
    kind: 'chronicle_stone',
    tip: () => {
      const r = view && view.records ? view.records : null;
      const b = r && r.bestDay && r.bestDay.tok > 0 ? r.bestDay : null;
      const n = (view && view.count) || (r && r.kept) || 0;
      // A DEED, not the three-string form, because this stone has a FRONT. Its
      // engraved face looks inward so the square can read it; a focus that
      // approached on the rig's default relative swing framed its blank back and
      // put the altar in the top of frame instead. The camera sits at
      // target + (sin az, ·, cos az)·dist, so approaching from the plaza side —
      // the direction from the stone toward the centre — is one atan2, and a short
      // dist keeps the monument out of the picture.
      const a = Math.atan2(stoneP.z, stoneP.x);
      // A SMALL STONE NEEDS A CLOSE CAMERA. At 13 units a 1.5-unit stone is a
      // pebble in the corner of a market square; 6 is close enough to read the
      // engraving, which is the only reason to focus it at all.
      const at = {
        x: stoneP.x, y: stoneP.y, z: stoneP.z, hTop: STONE_TOP,
        az: Math.atan2(-Math.cos(a), -Math.sin(a)), dist: 6, pol: .22
      };
      const rows = [];
      if (b) {
        rows.push(['best day', fmtTok(b.tok) + (b.label ? ' · ' + b.label : '')]);
        if (n > 1) rows.push(['kept', 'day ' + n + ' of the chronicle']);
      }
      return {
        title: 'The Chronicle Stone',
        sub: b ? (n > 1 ? `day ${n} of the chronicle` : 'the chronicle begins today')
          : 'unmarked · the mason waits',
        rows, flavor: b ? '' : 'the chronicle begins today',
        acts: ['focus'], live: true, at
      };
    }
  };
  const ghostEnt = {
    kind: 'ghost',
    tip: () => {
      const y = (view && view.yesterday) || null;
      const gt = gateOf();
      const road = `the road ${compassOf(Math.atan2(gt.z, gt.x))}`;
      if (!y) return ['the horizon', road, 'a town was here'];
      return [y.name || 'the town on the horizon',
        `${fmtTok(y.tok || 0)} tokens · yesterday`,
        y.kindLabel ? `${road} — ${y.kindLabel}` : road];
    }
  };
  const buntEnt = {
    kind: 'bunting',
    tip: () => {
      const r = view && view.records ? view.records : null;
      const bestLen = r && r.bestSpell ? r.bestSpell.len : 0;
      return ['the bunting', `day ${pennants} of an unbroken spell`,
        bestLen >= pennants && bestLen > 0 ? `longest: ${bestLen} days` : 'the longest yet'];
    }
  };
  const ents = [
    { group: stoneGroup, ent: stoneEnt },
    { group: ghostGroup, ent: ghostEnt },
    { group: buntMesh, ent: buntEnt }
  ];
  // three r160 raycasts hidden objects (Raycaster does not test `visible`), so a
  // dormant ghost would still answer the hover ray with a 5000-unit plane. Each
  // hittable mesh gates on its own group instead.
  const meshRaycast = THREE.Mesh.prototype.raycast;
  const gateRay = (mesh, on) => {
    mesh.raycast = function (raycaster, intersects) {
      if (on()) meshRaycast.call(this, raycaster, intersects);
    };
  };
  gateRay(stoneMesh, () => stoneGroup.visible);
  gateRay(faceMesh, () => stoneGroup.visible);
  gateRay(inkMesh, () => ghostGroup.visible && inkMat.opacity > .05);
  gateRay(litMesh, () => false);                          // the lamps are decoration
  gateRay(buntMesh, () => buntMesh.visible);

  if (scene && typeof scene.add === 'function') scene.add(group);

  /* ═══ public surface ═════════════════════════════════════════ */

  /** Adopt a chronicle snapshot. Null, undefined or an empty view is legal and
   *  leaves the town exactly as v3. Additive within an epoch: the pennant count
   *  may rise, never fall, and nothing already standing is taken away. */
  function setView(v) {
    if (!v || typeof v !== 'object') return;
    // A chronicle that is not ready yet renders NOTHING — no placeholder stone,
    // no empty plinth. `{}` is the shape town.js passes before the feed's first
    // chronicle block lands, and it must leave the town exactly as v3.
    if (v.ready === false || !(v.today || v.yesterday || v.spell || v.records || v.count > 0)) return;
    view = v;
    live = true;
    const prefs = v.prefs || {};
    // THE STONE — always, even blank: a town that has kept one day still has a
    // mason. Only the engraving changes.
    refreshEngraving(false);
    if (!stoneShown) { placeStone(); stoneShown = true; }
    stoneGroup.visible = true;

    // THE GHOST — the last town that actually existed, quiet days skipped.
    const y = v.yesterday;
    const wantGhost = !!(y && y.tok > 0) && prefs.ghost !== false && v.ghostAllowed !== false && !!paintSkyline;
    if (wantGhost && (!ghostShown || y.idx !== ghostIdx)) {
      ghostIdx = y.idx;
      placeGhost();
      paintGhost();
      ghostShown = true;
      if (!ghostT) ghostT = -1;                          // armed; update() stamps it
    } else if (!wantGhost && !ghostShown) {
      ghostGroup.visible = false;
    }

    // THE BUNTING — nothing below three days (a one-day "spell" is a trap), and
    // the count is monotonic for the life of the epoch.
    const len = v.spell && v.spell.len > 0 ? v.spell.len | 0 : 0;
    if (prefs.showStreaks !== false && len >= SPELL_MIN) {
      const want = Math.min(PENNANTS, len);
      if (want > pennants) { pennants = want; if (!buntT) buntT = -1; }
    }
  }

  /** The epoch's plan and seed. Used for the pennant rng and to re-place the
   *  stone when a new plan moves the gate. */
  function setPlan(p, s) {
    plan = p || null;
    if (Number.isFinite(s)) seed = s >>> 0;
    if (stoneShown) placeStone();
    if (ghostShown) placeGhost();
    buntR = -1;                                          // re-string on the new plaza
  }

  /** High-fidelity ghost art, scheduled off the critical path by town.js. Either
   *  canvas may be null. The bitmaps are BLITTED into the module's own canvases,
   *  so the texture count never grows however often this is called. */
  function setGhostArt(dayCv, nightCv) {
    if (!ghostShown) return;
    if (dayCv) {
      const g = inkCv.getContext('2d');
      if (g) { g.clearRect(0, 0, GHOST_W, GHOST_H); g.drawImage(dayCv, 0, 0, GHOST_W, GHOST_H); inkTex.needsUpdate = true; }
    }
    if (nightCv) {
      const g = litCv.getContext('2d');
      if (g) { g.clearRect(0, 0, GHOST_W, GHOST_H); g.drawImage(nightCv, 0, 0, GHOST_W, GHOST_H); litTex.needsUpdate = true; }
    }
  }

  /** World height of the ghost billboard. h ≤ 0 (or omitted) hands sizing back
   *  to the module's own 4 Hz auto-fit. */
  function setApparentScale(h) { apparent = Number.isFinite(h) && h > 0 ? h : 0; }

  /** A record has fallen. The inlay flares, the mason re-cuts 900 ms later — the
   *  delay is the point: the user watches the number change. Returns the stone's
   *  top so town.js can burst its own particles there, or null when dormant. */
  function celebrateRecord(b) {
    if (!stoneShown) return null;
    flareT = -1;                                          // stamped on the next frame
    recutAt = -1;
    return stoneTop;
  }

  /** The Overtaking (H6). Lifts the ghost's lamps for a moment and hands back its
   *  world anchor for the nine birds. Null when there is no ghost to tip its hat. */
  function overtook() {
    if (!ghostShown) return null;
    overT = -1;
    return ghostP;
  }

  /** @param {THREE.Vector3} [out] @returns {?THREE.Vector3} */
  function ghostAnchor(out) {
    if (!ghostShown) return null;
    return out ? out.copy(ghostP) : ghostP;
  }

  function update(dt, now, ctx) {
    if (!live) return;
    const night = ctx && Number.isFinite(ctx.night) ? ctx.night : 0;
    if (ctx && ctx.palette && ctx.palette !== lastPalette) { lastPalette = ctx.palette; buntR = -1; }

    /* ── the stone ── */
    if (stoneShown) {
      // the plaza breathes as the altar climbs; the stone stands on its rim
      if (Math.abs(plazaR() - stoneR) > .4) placeStone();
      if (recutAt === -1) recutAt = now + RECUT_MS;
      if (recutAt > 0 && now >= recutAt) { recutAt = 0; refreshEngraving(true); }
      if (flareT === -1) flareT = now;
      // the inlay: existence is pressure(), which chronicle.js only returns
      // inside the last 20 % of a record. Nothing here can invent a bar.
      const pr = pressureOf();
      const want = pr && Number.isFinite(pr.frac) ? clamp((pr.frac - .80) / .20, 0, 1) : 0;
      // WALL CLOCK, like everything else in this file. `k += (want-k)*.06` is a
      // PER-FRAME easing: at 60 fps it settles in about a second, and in a 9 s
      // headless capture — which paints at ~1 fps — it reaches barely a third of
      // its target, so the one screenshot that has to show the inlay shows a
      // stub of one. The exponential form is the same curve sampled at whatever
      // rate the compositor is actually running, with a 0.45 s time constant.
      const idt = inlayAt > 0 ? clamp((now - inlayAt) * .001, 0, 1.2) : .016;
      inlayAt = now;
      inlayK += (want - inlayK) * (1 - Math.exp(-idt / .45));
      const flare = flareT > 0 ? Math.max(0, 1 - (now - flareT) / 1400) : 0;
      const seg = inlayK > .004 ? Math.max(1, Math.round(inlayK * INLAY_SEG)) : 0;
      if (seg) {
        inlayMesh.visible = true;
        inlayGeo.setDrawRange(0, seg * 6);
        inlayMat.emissiveIntensity = .18 + .55 * night + 1.4 * flare * flare;
      } else if (flare > 0) {
        // a record falling from a stone with no inlay still gets its glint
        inlayMesh.visible = true;
        inlayGeo.setDrawRange(0, 6);
        inlayMat.emissiveIntensity = 1.6 * flare;
      } else {
        inlayMesh.visible = false;
        inlayGeo.setDrawRange(0, 0);
      }
    }

    /* ── the ghost ── */
    if (ghostShown) {
      if (ghostT === -1) ghostT = now + GHOST_HOLD_MS;
      const k = ghostT > 0 ? clamp((now - ghostT) / GHOST_FADE_MS, 0, 1) : 0;
      if (k > 0) {
        const cam = (ctx && ctx.camera) || null;
        const H = ghostHeight(now, cam);
        inkMesh.scale.set(H * GHOST_ASPECT, H, 1);
        litMesh.scale.copy(inkMesh.scale);
        // the painter's ground line sits at 92 % of the canvas, so the plane
        // rides 42 % of its own height above the terrain it stands on
        ghostGroup.position.set(ghostP.x, ghostP.y + H * .42, ghostP.z);
        // yaw-only billboard: a full quaternion copy tips a 640-unit-away plane
        // into the ground the moment the camera looks down at the town
        if (cam) ghostGroup.rotation.y = Math.atan2(cam.position.x - ghostP.x, cam.position.z - ghostP.z);
        ghostGroup.visible = true;
        // haze, from the one fog authority, capped so the ghost never vanishes
        const fog = scene.fog, fc = fog && fog.color ? fog.color : null;
        const d = fog && Number.isFinite(fog.density) ? fog.density : .0016;
        const hz = Math.min(HAZE_CAP, 1 - Math.exp(-Math.pow(d * GHOST_R, 2)));
        if (fc) {
          inkMat.color.copy(fc).multiplyScalar(.74).lerp(COOL_LAND, .30).lerp(fc, hz);
        }
        const ease = easeOutCubic(k);
        inkMat.opacity = .94 * ease;
        // AND ITS LAMPS ARE ON. One plane, and the whole feature is worth it.
        if (overT === -1) overT = now;
        const over = overT > 0 ? Math.max(0, 1 - (now - overT) / 2600) : 0;
        const lit = ease * (.85 * night + .55 * over) * (1 - hz * .8);
        litMesh.visible = lit > .01;
        litMat.opacity = clamp(lit, 0, 1);
      }
    }

    /* ── the bunting ── */
    if (pennants >= SPELL_MIN) {
      if (buntT === -1) buntT = now;
      if (Math.abs(plazaR() - buntR) > .4) buildBunting();
      // one pennant every 90 ms, in slot order — a wall-clock reveal, so a shot
      // taken at 1 fps still shows the right number of them
      const up = buntT > 0 ? clamp(Math.floor((now - buntT) / PENNANT_MS) + 1, 0, pennants) : 0;
      buntMesh.visible = up > 0;
      buntGeo.setDrawRange(0, up > 0 ? ROPE_V + up * 3 : 0);
      if (up > 0) {
        // Sway: at most twelve vertex writes, from a stateless sin of the wall
        // clock, so a throttled compositor cannot accumulate a lag against it.
        // The newest pennant also DROPS with easeOutBack — the same pop the
        // buildings land with — and it is bounded by the reveal cadence, so a
        // slow frame can never leave one half-grown in a screenshot.
        const t = now * .0016;
        for (let k = 0; k < up; k++) {
          const o = (ROPE_V + k * 3 + 2) * 3, ph = tipPhase[k];
          const age = (now - buntT) - k * PENNANT_MS;
          const grow = age >= 260 ? 1 : clamp(easeOutBack(clamp(age / 260, 0, 1)), 0, 1.12);
          const yb = tipTopY[k] + (tipBase[k * 3 + 1] - tipTopY[k]) * grow;
          buntPos[o] = tipBase[k * 3] + Math.sin(t + ph) * .085 * grow;
          buntPos[o + 1] = yb + Math.abs(Math.sin(t * .7 + ph)) * .035;
          buntPos[o + 2] = tipBase[k * 3 + 2] + Math.cos(t * .9 + ph) * .075 * grow;
        }
        buntGeo.attributes.position.needsUpdate = true;
      }
    }
  }

  /** Epoch switch. Re-poses; allocates nothing, frees nothing. The chronicle
   *  outlives epochs, so the next setView re-adopts within one frame. */
  function reset() {
    view = null; live = false;
    stoneShown = false; ghostShown = false; ghostIdx = -1;
    pennants = 0; buntT = 0; buntR = -1; ghostT = 0;
    recutAt = 0; flareT = -1e9; overT = -1e9;
    inlayK = 0; stoneR = -1; apparent = 0; autoAt = -1e9; autoH = 0;
    engKey = '';
    stoneGroup.visible = false;
    ghostGroup.visible = false; litMesh.visible = false;
    inkMat.opacity = 0; litMat.opacity = 0;
    inlayMesh.visible = false; inlayMat.emissiveIntensity = 0; inlayGeo.setDrawRange(0, 0);
    buntMesh.visible = false; buntGeo.setDrawRange(0, 0);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    if (group.parent) group.parent.remove(group);
    group.clear(); stoneGroup.clear(); ghostGroup.clear();
    for (const g of [stoneGeo, faceGeo, inlayGeo, ghostGeo, buntGeo]) g.dispose();
    for (const m of [stoneMat, faceMat, inlayMat, inkMat, litMat, buntMat]) m.dispose();
    for (const t of [engTex, inkTex, litTex]) t.dispose();
    engCv.width = engCv.height = 0;
    inkCv.width = inkCv.height = 0;
    litCv.width = litCv.height = 0;
    ents.length = 0;
  }

  /**
   * @typedef {Object} Memorial
   * @property {THREE.Group} group
   * @property {Array<{group:THREE.Object3D, ent:Object}>} ents  stable; register
   *           once with town.js's tagEnt/addHit — the groups outlive every epoch
   * @property {(v:?MemView)=>void} setView
   * @property {(plan:?Object, seed:number)=>void} setPlan
   * @property {(dayCv:?HTMLCanvasElement, nightCv:?HTMLCanvasElement)=>void} setGhostArt
   * @property {(h:number)=>void} setApparentScale
   * @property {(b:Object)=>?THREE.Vector3} celebrateRecord
   * @property {()=>?THREE.Vector3} overtook
   * @property {(out:?THREE.Vector3)=>?THREE.Vector3} ghostAnchor
   * @property {(dt:number, now:number, ctx:Object)=>void} update  dt IS IGNORED
   * @property {()=>void} reset @property {()=>void} dispose
   */
  return {
    group,
    get ents() { return ents; },
    setView, setPlan, setGhostArt, setApparentScale,
    celebrateRecord, overtook, ghostAnchor,
    update, reset, dispose
  };
}
