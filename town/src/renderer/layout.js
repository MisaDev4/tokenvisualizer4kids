/* ═══════════════════════════════════════════════════════════════════════════
   Token Town v3 — layout.js · THE STREET PLAN
   ---------------------------------------------------------------------------
   Replaces v2's bullseye (`plotPos(i)` = ring r, slot i) with a seeded street
   plan: a road graph grown by agents through an archetype's terrain fields,
   plots laid along the frontages, everything sorted once into growth order.

   This module imports NOTHING — no THREE, no DOM. It is pure {x, z} geometry
   plus one canvas painter, so it runs (and is tested) under plain Node.

   THE INVARIANT, and why it is structural rather than disciplinary:
     plan.plotAt(i) is deterministic and immutable for a fixed seed as the town
     grows. The whole plan is generated once, up front, then sorted once;
     plotAt(i) is an array index into a frozen array. There is no incremental
     state that could drift. ensureCapacity() APPENDS ONLY, strictly beyond the
     current outer radius, and never touches an index already handed out.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══ seeded rng — no Math.random() lives anywhere in this file ═══ */
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/** A decorrelated sub-stream of one 32-bit seed: phases that must not shift
 *  when an unrelated phase changes its number of rolls get their own. */
const sub = (seed, salt) => mulberry32((Math.imul(seed ^ salt, 0x9E3779B1) ^ seed >>> 13) >>> 0);

const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrapPi = d => { d = (d + Math.PI) % TAU; return (d < 0 ? d + TAU : d) - Math.PI; };

/* ═══ public constants ═══ */
export const LAYOUT = Object.freeze({
  MAX_R: 250, PLAZA_R: 15, SEG: 13, SPACING: 7.4, PLOT_D: 6.4, N_CAP: 1200, FLAT_PAD: 30
});

/* ═══ tunables (all measured against 430 buildings — the user's real day) ═══ */
const P = {
  // Street separation IS the shape control: a tight old core, straggly outskirts.
  CLEAR0: 22, CLEAR1: 34, CLEAR_R: 190,
  SNAP: 15,                       // a candidate this near a foreign node fuses into a junction
  SETBACK: [6.6, 5.6, 4.9, 4.3],  // by street depth: spine / street / lane / track
  WIDTH: [7.2, 5.0, 3.7, 2.7],
  CURL: [.11, .20, .30, .38],
  BUDGET: [34, 16, 8, 5],
  BRANCH_GAP: [3, 4, 5, 99],
  BACKROW: 9.4, BACKROW_R: 122,
  EDGE_TARGET: 2200, HOPS: 2, ROAD_M: 1.6, COVER: 28,
  KD: .30,                        // growth key = KD·graph-distance + (1-KD)·radius + dither
  BAND: 26                        // world units per band — the integer that replaces "ring"
};

/** id → the human phrase. Exported (frozen) because chronicle/almanac/memorial all
 *  need to NAME a day's town from a seed alone; they were each carrying a private
 *  copy of this table, which is exactly how the five phrases drift apart. */
// THE SHAPE ONLY. These used to carry a settlement SIZE as well -- "crossroads
// market town", "valley ribbon village" -- which is a different fact and one
// this table cannot know: the archetype comes from the seed, the size comes from
// the tokens. A twenty-building hamlet wore a chip reading "crossroads market
// town". buildings.js's village tier is the authority on size (hamlet, village,
// market village, market town); `settlementLabel` joins the two.
export const KIND_LABEL = Object.freeze({
  crossroads: 'crossroads',
  riverside: 'riverside',
  ribbon: 'valley ribbon',
  lakeside: 'lakeside',
  hillring: 'hill terrace'
});
/**
 * The phrase a reader sees: shape then size, e.g. "riverside hamlet" or
 * "crossroads market town". Pure string work, so layout.js still imports
 * nothing — the caller passes the tier name it already has.
 * @param {string} kind @param {string} [tierName] @returns {string}
 */
export const settlementLabel = (kind, tierName) =>
  (KIND_LABEL[kind] || kind || '') + (tierName ? ' ' + tierName : '');
const ARCHETYPES = ['crossroads', 'riverside', 'ribbon', 'lakeside', 'hillring'];
const ARCH_W = [2.6, 3, 2, 2, 1.4];

/** unlock ordinal (buildings) + clearance (world units) per LADDER landmark.
 *  The fantasy set is retired — see AESTHETIC.md and buildings.js's LANDMARK_DEFS,
 *  which this table's KEYS must mirror exactly or the site is simply never
 *  reserved (town.js's placeLandmark skips a kind with no site). Clearances track
 *  the new, smaller footprints: the green and the tithe barn are the wide ones now,
 *  and nothing needs the 12 units the sky-gate did for being tall. */
const LM = [
  ['well', 32, 5], ['smithy', 60, 8], ['mill', 78, 9], ['market_cross', 104, 6],
  ['tithe_barn', 138, 12], ['market_hall', 178, 11], ['chapel', 232, 12],
  ['bell_tower', 296, 8], ['village_green', 368, 13], ['inn', 452, 11]
];

/** id -> unlock ordinal, for the ground painter's forecourt gate */
const LM_ORD = Object.freeze(Object.fromEntries(LM.map(([id, n]) => [id, n])));

/* ═══ typedefs — the contract eight implementers code against ═══ */
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
 * The immutable plan for one epoch. See REDESIGN-V3.md §3.5.
 * @typedef {Object} Plan
 * @property {number} seed       the 32-bit uint it was built from
 * @property {'crossroads'|'riverside'|'ribbon'|'lakeside'|'hillring'} kind
 * @property {string} kindLabel  human phrase — the signpost and the Gazette use it
 * @property {{x:0,z:0}} plazaPos      the plaza is ALWAYS the origin; the town is
 *                                     off-centre around it
 * @property {number} plazaR     15 — the square the monument stands in
 * @property {number} innerR     distance from the origin to the NEAREST plot; >= 17.5
 * @property {number} maxR       LAYOUT.MAX_R — nothing in the plan is ever beyond it
 * @property {number} flatR      maxR + FLAT_PAD (280) — environs keeps terrain flat inside
 * @property {number} capacity   plots currently available (live getter)
 * @property {Array<{a:number,w:number}>} spine  outbound spine headings + road width
 * @property {{x:number,z:number,yaw:number,node:number}} gate   the signpost site
 * @property {Object<string,{x:number,z:number,yaw:number,clr:number,node:number}>} sites
 *           all 9 LADDER landmark plots, always present
 * @property {Array<{x:number,z:number,a:number,span:number,w:number,main:boolean,d:number}>} bridges
 *           `a` is the heading ALONG the span; (x,z) is the deck centre
 * @property {?{kind:'river'|'lake', path:Array<{x:number,z:number}>, width:number}} water
 *           river = open polyline (centreline), lake = closed polygon (shoreline, first
 *           point not repeated). `width` is the FULL water width in world units.
 * @property {{nodes:RoadNode[], edges:RoadEdge[]}} graph
 * @property {(i:number)=>Plot} plotAt
 * @property {(n:number)=>number} ensureCapacity
 * @property {(i:number)=>number} depthOf
 * @property {(i:number)=>number} bandOf
 * @property {(b:number)=>{k:number,r:number}} frontierOf
 * @property {(b:number)=>{cx:number,cz:number,r:number}} boundsFor
 * @property {(x:number,z:number)=>number} nearestNode
 * @property {(i:number)=>{x:number,z:number}} nodePos
 * @property {(prev:number,cur:number,rnd:number)=>number} randomNextNode
 * @property {(a:number,b:number)=>number[]} pathTo
 * @property {(rnd:number,maxK:number)=>{x:number,z:number,edge:number}} randomRoadPoint
 * @property {(a:number,b:number)=>?RoadEdge} edgeBetween
 * @property {(edge:number,t:number,lat:number)=>{x:number,z:number}} offsetOn
 * @property {(x:number,z:number)=>number} distFromPlaza
 * @property {(x:number,z:number)=>boolean} isWet
 * @property {(g:CanvasRenderingContext2D, X:(x:number,z:number)=>number[],
 *             opt:{frontierK:number, px:number, wear:number, plazaR:number})=>void} paintGround
 */

/* ═══ curves + geometry helpers ═══ */
function catmull(pts, t) {
  const i = clamp(Math.floor(t), 0, pts.length - 2), f = t - i;
  const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
  const f2 = f * f, f3 = f2 * f;
  return {
    x: .5 * (2 * p1.x + (-p0.x + p2.x) * f + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3),
    z: .5 * (2 * p1.z + (-p0.z + p2.z) * f + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * f2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * f3)
  };
}
const polyline = (ctrl, steps) => {
  const out = [];
  for (let i = 0; i <= steps; i++) out.push(catmull(ctrl, i / steps * (ctrl.length - 1)));
  return out;
};
/** nearest approach of (x,z) to an open polyline → {d, i, t} */
function distToPoly(poly, x, z) {
  let best = 1e9, bi = 0, bt = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1);
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) { best = d; bi = i; bt = t; }
  }
  return { d: best, i: bi, t: bt };
}
/** spatial hash; `each` visits candidates in a square of radius r, no allocation */
function grid(cell) {
  const m = new Map(), key = (i, j) => i * 73856093 ^ j * 19349663;
  return {
    add(x, z, v) { const k = key(Math.floor(x / cell), Math.floor(z / cell)); let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); },
    each(x, z, r, fn) {
      const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell);
      const j0 = Math.floor((z - r) / cell), j1 = Math.floor((z + r) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const a = m.get(key(i, j)); if (!a) continue;
        for (let n = 0; n < a.length; n++) if (fn(a[n]) === false) return false;
      }
      return true;
    }
  };
}

/* ═══ archetypes: ONE generator, five parameter packs ═══════════
   A pack supplies at most radiusAt(a), blocked(x,z), guide(x,z), seeds[],
   bridgeSites[], expand(). The ids are a closed enum shared with environs
   and news — do not rename, do not add a sixth. */
function makeTerrain(kind, rnd) {
  const a0 = rnd() * TAU;
  const T = { kind, a0, river: null, lake: null, valley: null, bridgeSites: [], seeds: [] };
  T.radiusAt = () => LAYOUT.MAX_R;
  T.blocked = () => 0;             // >0 = unbuildable; the magnitude is depth into the obstacle
  T.guide = null;                  // director field: preferred heading + how hard to obey
  T.expand = () => { };            // widen the world one notch (lazy outland growth only)

  if (kind === 'riverside') {
    const dir = a0, nx = -Math.sin(dir), nz = Math.cos(dir);
    const side = rnd() < .5 ? -1 : 1, off = side * (26 + rnd() * 16);
    const ctrl = [];
    for (let i = 0; i <= 5; i++) {
      const s = -LAYOUT.MAX_R * 1.5 + i * (LAYOUT.MAX_R * 3 / 5);
      const w = Math.sin(i * 1.3 + rnd()) * 46 + (rnd() * 2 - 1) * 22;
      ctrl.push({ x: Math.cos(dir) * s + nx * (off + w), z: Math.sin(dir) * s + nz * (off + w) });
    }
    T.river = polyline(ctrl, 128);
    T.riverW = 12 + rnd() * 6;     // half-width: distance from the centreline to the bank
    // The meander can swing the channel straight through the market square. Slide the
    // whole river along its own normal until the plaza is a proper quay's walk from
    // the water: "plaza ON the bank", never "plaza IN the river".
    {
      const nearP = distToPoly(T.river, 0, 0), keep = LAYOUT.PLAZA_R + T.riverW + 8;
      if (nearP.d < keep) {
        const p = T.river[nearP.i], q = T.river[nearP.i + 1];
        const cx = p.x + (q.x - p.x) * nearP.t, cz = p.z + (q.z - p.z) * nearP.t;
        const L = Math.hypot(cx, cz) || 1, push2 = keep - nearP.d;
        for (const pt of T.river) { pt.x += cx / L * push2; pt.z += cz / L * push2; }
      }
    }
    T.blocked = (x, z) => { const r = distToPoly(T.river, x, z); return r.d < T.riverW ? T.riverW - r.d + .01 : 0; };
    T.guide = (x, z) => {
      const r = distToPoly(T.river, x, z);
      if (r.d > T.riverW + 40) return null;
      const p = T.river[r.i], q = T.river[r.i + 1];
      return { a: Math.atan2(q.z - p.z, q.x - p.x), k: .5 };      // quay streets run with the bank
    };
    // Bridges are CONSTRUCTED, not stumbled into: the town bridge sits at the river's
    // closest approach to the plaza, the others a fair walk up/downstream. "Bridge when
    // an agent happens to hit water" produced ZERO bridges in six seeds.
    // The secondary crossings are sited by ARC LENGTH ALONG THE CHANNEL, not by a
    // polyline index. +-22 indices on a 128-segment, 750-unit river is +-130 world
    // units, which put both of them at r 124-158 — outside a town that only
    // reaches r 121-136 at the 233 buildings a normal day builds. The result was a
    // full timber bridge crossing to an empty dirt pad in open countryside, on
    // every riverside seed. 60 and 96 units are the frontier radii at roughly 230
    // and 430 buildings, and `d` (below) is their radius, so the mounting gate in
    // town.js now unlocks them exactly when there is something on the far bank.
    const near = distToPoly(T.river, 0, 0);
    const walk = (from, dir, want) => {
      let i = from, run = 0;
      while (run < want) {
        const j = i + dir;
        if (j < 2 || j > T.river.length - 3) break;
        run += Math.hypot(T.river[j].x - T.river[i].x, T.river[j].z - T.river[i].z);
        i = j;
      }
      return i;
    };
    const sites = [[near.i, true], [walk(near.i, -1, 60), false], [walk(near.i, 1, 96), false]];
    for (const [i0, main] of sites) {
      const i = clamp(i0, 2, T.river.length - 3);
      const p = T.river[i], q = T.river[i + 1];
      T.bridgeSites.push({ x: p.x, z: p.z, a: Math.atan2(q.z - p.z, q.x - p.x) + Math.PI / 2, main });
    }
    T.seeds = [{ a: dir }, { a: dir + Math.PI }];
  } else if (kind === 'lakeside') {
    const da = a0, R = 76 + rnd() * 40;
    const cx = Math.cos(da) * (R + LAYOUT.PLAZA_R + 14), cz = Math.sin(da) * (R + LAYOUT.PLAZA_R + 14);
    const lobes = []; for (let i = 0; i < 7; i++) lobes.push(.76 + rnd() * .5);
    const lakeR = ang => {
      const f = (ang / TAU * 7 + 7) % 7, i = Math.floor(f), t = f - i;
      const a = lobes[i], b = lobes[(i + 1) % 7];
      return R * (a + (b - a) * (3 - 2 * t) * t * t);
    };
    T.lake = { cx, cz, R }; T.lakeR = lakeR;
    T.blocked = (x, z) => {
      const d = Math.hypot(x - cx, z - cz), rr = lakeR(Math.atan2(z - cz, x - cx));
      return d < rr ? rr - d + .01 : 0;
    };
    T.guide = (x, z) => {                                          // a promenade, not a grid
      const d = Math.hypot(x - cx, z - cz), ang = Math.atan2(z - cz, x - cx);
      if (d > lakeR(ang) + 46) return null;
      return { a: ang + Math.PI / 2, k: .6 };
    };
    let shrink = 0;
    T.radiusAt = a => LAYOUT.MAX_R * (1 - (.18 - shrink) * Math.max(0, Math.cos(a - da)));
    T.expand = () => { shrink = Math.min(.18, shrink + .06); };
    T.seeds = [{ a: da + Math.PI / 2 }, { a: da - Math.PI / 2 }, { a: da + Math.PI }];
  } else if (kind === 'ribbon') {
    const dir = a0, amp = 44 + rnd() * 36, per = 190 + rnd() * 90;
    // The valley floor must seat a 430-building day without a mid-cascade regrow: at
    // half=46 the strip is barely three streets wide and caps out around 380 plots.
    // NARROW. At half = 58-80 the valley floor was wider than the whole town, so
    // "valley ribbon village" measured as round as a crossroads seed (roundness CV
    // 0.14, all 36 sectors occupied). 40-50 puts the shoulders inside the first
    // 233 buildings, which is where the archetype has to bite to be worth naming;
    // expand() still opens it up for the days that need 1200 plots.
    let half = 40 + rnd() * 10;
    const axis = s => ({
      x: Math.cos(dir) * s - Math.sin(dir) * Math.sin(s / per * TAU) * amp,
      z: Math.sin(dir) * s + Math.cos(dir) * Math.sin(s / per * TAU) * amp
    });
    // 9-unit sampling: the meander period is 190–280, so this is smooth, and every
    // blocked() miss walks this polyline — halving it halves the archetype's build
    const poly = []; for (let i = -40; i <= 40; i++) poly.push(axis(i * 9));
    T.valley = poly;
    Object.defineProperty(T, 'valleyHalf', { get: () => half });
    T.blocked = (x, z) => { const r = distToPoly(poly, x, z); return r.d > half ? r.d - half : 0; };
    T.guide = (x, z) => {
      const r = distToPoly(poly, x, z);
      const p = poly[r.i], q = poly[r.i + 1];
      return { a: Math.atan2(q.z - p.z, q.x - p.x), k: .22 + .55 * clamp(r.d / half, 0, 1) };
    };
    T.expand = () => { half += 24; };                              // the valley shoulders get farmed
    T.seeds = [{ a: dir }, { a: dir + Math.PI }];
  } else if (kind === 'hillring') {
    // Deeper lobes. At (.70 + .32*lobe) the boundary only varied +-8 %, i.e. a
    // circle, and it lived out at r 175-250 where a real day never reaches — so
    // "hill terraces" measured as a disc (36/36 sectors filled, CV 0.136).
    const lob = []; for (let i = 0; i < 6; i++) lob.push(.60 + rnd() * .80);
    T.radiusAt = a => {
      const f = ((a - a0) / TAU * 6 + 12) % 6, i = Math.floor(f), t = f - i;
      const p = lob[i], q = lob[(i + 1) % 6];
      return LAYOUT.MAX_R * (.38 + .44 * (p + (q - p) * (3 - 2 * t) * t * t));
    };
    // Tangential in two loose bands: wobbly terrace loops with lanes radiating between
    // them. The nod to v2's rings — and the bands follow the LOBED boundary, not a
    // radius, so a terrace can never close into a circle. That was v2's whole bug.
    T.terrace = a => { const R = T.radiusAt(a); return [R * .30, R * .62]; };
    // THE RISERS BITE. A guide field alone (k <= .5) is a suggestion; plots just
    // filled the disc anyway. These are three narrow unbuildable steps between the
    // terraces at r ~ 34/74/126 on a typical seed — squarely inside where the town
    // actually lives — so the built footprint breaks into wobbly loops. They are
    // only 9 units thick, which one SEG (13) can step straight over, so lanes
    // still radiate across them and the graph never fragments.
    const RISER = [.21, .46, .79], RISER_H = 4.5;
    // A smooth lobed contour still reads as a circle from above, and three of them
    // read as a bullseye — which is the one silhouette this whole redesign exists
    // to kill. Two high harmonics per riser (different phase per band, so they
    // never nest) turn the shelves into wandering scarps.
    const rWob = (f, a) => 1 + .12 * Math.sin(a * 5 + f * 19 + a0)
      + .08 * Math.sin(a * 8 - f * 27 + 1.3) + .05 * Math.sin(a * 3 + f * 41);
    T.risers = RISER;
    T.riserR = (f, a) => T.radiusAt(a) * f * rWob(f, a);
    T.blocked = (x, z) => {
      const r = Math.hypot(x, z);
      if (r < LAYOUT.PLAZA_R + 4) return 0;
      const a = Math.atan2(z, x);
      let worst = 0;
      for (const f of RISER) {
        const d = Math.abs(r - T.riserR(f, a));
        if (d < RISER_H) worst = Math.max(worst, RISER_H - d + .01);
      }
      return worst;
    };
    T.guide = (x, z) => {
      const r = Math.hypot(x, z), a = Math.atan2(z, x), b = T.terrace(a);
      const k = .5 * Math.max(clamp(1 - Math.abs(r - b[0]) / 40, 0, 1), clamp(1 - Math.abs(r - b[1]) / 46, 0, 1));
      return k < .02 ? null : { a: a + Math.PI / 2, k };
    };
    T.seeds = [{ a: a0 }, { a: a0 + 1.9 }, { a: a0 + 3.4 }, { a: a0 + 4.9 }];
  } else {
    const b = a0 + Math.PI / 2 + (rnd() - .5) * .8;                // two OBLIQUE spines, never a cross
    T.seeds = [{ a: a0 }, { a: a0 + Math.PI }, { a: b }, { a: b + Math.PI }];
    // THE COMMON. A crossroads town with nothing but a boundary at r 190-250
    // filled every one of 36 sectors and measured as round as v2's bullseye — the
    // shape has to bite where the town lives, r 55-150. So one of the four wedges
    // between the spines is grazing land the town grew around: a bite out of the
    // plat you can see from any angle, and the reason the market is where it is.
    {
      const gaps = [(a0 + b) / 2, (a0 + b) / 2 + Math.PI / 2, (a0 + b) / 2 + Math.PI, (a0 + b) / 2 + Math.PI * 1.5];
      const ca = gaps[Math.floor(rnd() * 4) % 4], half = .38 + rnd() * .20;
      const r0 = 46 + rnd() * 16, r1 = r0 + 70 + rnd() * 50;
      T.common = { a: ca, half, r0, r1 };
      T.blocked = (x, z) => {
        const r = Math.hypot(x, z);
        if (r < r0 || r > r1) return 0;
        let da = Math.abs(((Math.atan2(z, x) - ca + Math.PI) % TAU + TAU) % TAU - Math.PI);
        if (da > half) return 0;
        // soft at the rim so streets skirt it instead of stopping dead at a wall
        return Math.min(r - r0, r1 - r, (half - da) * r) + .01;
      };
    }
    // Two harmonics, not one: a pure cos(2a) boundary is an ellipse and an ellipse
    // full of plots still reads as "the algorithm again". The odd harmonic makes
    // one quarter of the plat noticeably shorter than the other three.
    T.radiusAt = a => LAYOUT.MAX_R * (.76 + .14 * Math.cos((a - a0) * 2) + .09 * Math.cos((a - a0) * 3 + 1.1));
  }
  return T;
}

// NOTE (round 2): an anti-repeat bias here — halving the weight of yesterday's
// archetype, to take the 20.9 % consecutive-repeat rate down to ~11 % — was
// tried and backed out. It needs a "yesterday" that is a pure function of the
// CURRENT epoch, and no such value is available in the renderer: the honest
// sources (localStorage, the previous run's kind) make buildPlan depend on
// history, and buildPlan is re-entered for the same seed on hardReset, so the
// same epoch could rebuild as a different town mid-session. Fixing the repeat
// rate properly means giving the feed a "yesterday's epochId" field.
function pickArchetype(rnd) {
  let s = 0; for (const w of ARCH_W) s += w;
  let r = rnd() * s;
  for (let i = 0; i < ARCH_W.length; i++) { r -= ARCH_W[i]; if (r <= 0) return ARCHETYPES[i]; }
  return 'crossroads';
}

/** THE PLAN STREAM. buildPlan draws its whole terrain pack off this one sub-stream,
 *  and pickArchetype is its FIRST roll — which is the entire reason archetypeOf can
 *  name a town without building one. Never insert a roll ahead of the pick. */
const archetypeStream = seed => sub(seed >>> 0, 0x5f356495);

/**
 * The archetype a seed WILL produce, for ~1 µs instead of buildPlan's 13–49 ms.
 * News, weather, the chronicle and the almanac all want to name a day's town shape
 * — most of them for days that will never be built at all.
 * Guaranteed by construction: `archetypeOf(s) === buildPlan(s).kind` for every seed.
 * @param {number} seed 32-bit uint (a plan seed)
 * @returns {'crossroads'|'riverside'|'ribbon'|'lakeside'|'hillring'} — pair with
 *          KIND_LABEL[kind] for the phrase a reader sees
 */
export function archetypeOf(seed) {
  return pickArchetype(archetypeStream(seed));
}

/* ═══════════════════════════════════════════════════════════════
   buildPlan — pure: two builds of the same seed are bit-identical.
   13–49 ms; called once per epoch, never per frame.
   ═══════════════════════════════════════════════════════════════ */
/** @param {number} seed 32-bit uint (ctx.planSeed) @returns {Plan} */
export function buildPlan(seed) {
  seed = seed >>> 0;
  const rnd = archetypeStream(seed);
  const kind = pickArchetype(rnd);              // MUST stay the stream's first roll — archetypeOf() replays it
  const T = makeTerrain(kind, rnd);

  // blocked() is called ~40k times and the river/lake tests walk a 128-segment
  // polyline; a 3-unit lazy mask turns riverside from 80 ms into ~12.
  {
    const raw = T.blocked, MG = 3, W = Math.ceil(LAYOUT.MAX_R * 2.4 / MG) | 1, half = W >> 1;
    let mask = new Float32Array(W * W).fill(-1);
    T.invalidate = () => { mask = new Float32Array(W * W).fill(-1); };   // after expand()
    T.blocked = (x, z) => {
      const i = Math.round(x / MG) + half, j = Math.round(z / MG) + half;
      if (i < 0 || j < 0 || i >= W || j >= W) return raw(x, z);
      const k = j * W + i;
      let v = mask[k];
      if (v < 0) v = mask[k] = raw((i - half) * MG, (j - half) * MG);
      return v;
    };
  }

  let RMUL = 1;
  const radiusAt = a => Math.min(LAYOUT.MAX_R, T.radiusAt(a) * RMUL);   // MAX_R is absolute
  const clearAt = r => P.CLEAR0 + (P.CLEAR1 - P.CLEAR0) * clamp(r / P.CLEAR_R, 0, 1);

  /* ── the road graph ─────────────────────────────────────────── */
  const nodes = [], edges = [], ng = grid(24);
  const addNode = (x, z, d, depth, hub) => {
    const n = { i: nodes.length, x, z, d, depth, hub: !!hub, adj: [] };
    nodes.push(n); ng.add(x, z, n); return n;
  };
  const link = (a, b, depth, bridge) => {
    if (a === b) return null;
    const e = {
      i: edges.length, a: a.i, b: b.i, depth, bridge: !!bridge,
      len: Math.hypot(b.x - a.x, b.z - a.z),
      w: P.WIDTH[depth] + (bridge ? 1.4 : 0), d: Math.min(a.d, b.d)
    };
    edges.push(e); a.adj.push(e.i); b.adj.push(e.i); return e;
  };

  // "Foreign" is a GRAPH question, not a distance one: the nodes within 2 hops of the
  // growing tip are its own street and the junction it just left, and they are always
  // close. Excluding by radius instead throttled every perpendicular branch to death
  // (measured: 47 edges instead of ~520).
  const near2 = new Set();
  let frontierBuf = [], nextBuf = [];
  function markNear(parent, hops) {
    near2.clear(); if (!parent) return;
    frontierBuf.length = 0; nextBuf.length = 0;
    frontierBuf.push(parent); near2.add(parent.i);
    for (let h = 0; h < hops; h++) {
      for (const n of frontierBuf) for (const ei of n.adj) {
        const e = edges[ei], o = nodes[e.a === n.i ? e.b : e.a];
        if (!near2.has(o.i)) { near2.add(o.i); nextBuf.push(o); }
      }
      const t = frontierBuf; frontierBuf = nextBuf; nextBuf = t; nextBuf.length = 0;
    }
  }
  function foreignNear(x, z, r) {
    let best = null, bd = r;
    ng.each(x, z, r, n => {
      if (near2.has(n.i)) return;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  }

  /* plaza — an irregular hub ring; every street hangs off it */
  const PN = 7, plazaNodes = [];
  for (let i = 0; i < PN; i++) {
    const a = i / PN * TAU + T.a0 * .37, R = LAYOUT.PLAZA_R * (.95 + rnd() * .18);
    plazaNodes.push(addNode(Math.cos(a) * R, Math.sin(a) * R, LAYOUT.PLAZA_R, 1, true));
  }
  for (let i = 0; i < PN; i++) link(plazaNodes[i], plazaNodes[(i + 1) % PN], 1, false);
  const plazaNear = a => {
    let best = plazaNodes[0], bd = 9e9;
    for (const n of plazaNodes) { const d = Math.abs(wrapPi(Math.atan2(n.z, n.x) - a)); if (d < bd) { bd = d; best = n; } }
    return best;
  };

  /* agents, expanded cheapest-first: the graph itself grows outward from the square */
  const Q = [];
  const push = ag => Q.push(ag);
  const pop = () => { let b = 0; for (let i = 1; i < Q.length; i++) if (Q[i].cost < Q[b].cost) b = i; return Q.splice(b, 1)[0]; };
  const agent = (from, a, depth, cost) => ({
    from, a, depth, cost, ph: rnd() * TAU, tries: 0, since: 0,
    budget: Math.round(P.BUDGET[depth] * (depth ? .6 + rnd() * .8 : 1))
  });
  for (const s of T.seeds) push(agent(plazaNear(s.a), s.a, 0, LAYOUT.PLAZA_R));

  /* constructed bridges: both bridgeheads and the span exist BEFORE growth, then
     streets grow away from each head — a bridge town always has its bridges. */
  const bridges = [];
  for (const bs of T.bridgeSites) {
    const w = T.riverW + 9;
    const ax = bs.x - Math.cos(bs.a) * w, az = bs.z - Math.sin(bs.a) * w;
    const bx = bs.x + Math.cos(bs.a) * w, bz = bs.z + Math.sin(bs.a) * w;
    if (Math.hypot(ax, az) > LAYOUT.MAX_R - 6 || Math.hypot(bx, bz) > LAYOUT.MAX_R - 6) continue;
    if (T.blocked(ax, az) > 0 || T.blocked(bx, bz) > 0) continue;
    const d = Math.hypot(bs.x, bs.z);
    const A = addNode(ax, az, d, 0), B = addNode(bx, bz, d, 0);
    const e = link(A, B, 0, true);
    // The bridgeHEADS stand `w` back from the channel so the streets have somewhere
    // to start; the DECK must not. Handing the head-to-head distance over as the
    // span built a causeway that carried on floating 9 units over dry grass at both
    // ends — the approaches are painted road, and that is what they should be.
    bridges.push({
      x: bs.x, z: bs.z, a: bs.a,
      span: Math.min(Math.hypot(bx - ax, bz - az), 2 * (T.riverW + 3.2)),
      w: P.WIDTH[0] + 1.4, main: bs.main, d, _e: e.i
    });
    push(agent(A, bs.a + Math.PI, bs.main ? 0 : 1, d));
    push(agent(B, bs.a, bs.main ? 0 : 1, d));
    const pa = Math.atan2(az, ax);                       // and a road from the plaza to the near head
    push(agent(plazaNear(pa), pa, bs.main ? 0 : 1, LAYOUT.PLAZA_R));
  }

  let guard = 0;
  function runQueue() {
    while (Q.length && edges.length < P.EDGE_TARGET && guard++ < 90000) {
      const ag = pop();
      if (ag.budget <= 0) continue;
      const dep = ag.depth;
      ag.ph += .8 + rnd() * .7;
      // correlated noise, not a drunkard's walk: curvature is the CHAIN, never the edge
      let a = ag.a + Math.sin(ag.ph) * P.CURL[dep] + (rnd() - .5) * P.CURL[dep];
      const g = T.guide && T.guide(ag.from.x, ag.from.z);
      if (g) { const t = Math.abs(wrapPi(g.a - a)) < Math.PI / 2 ? g.a : g.a + Math.PI; a += wrapPi(t - a) * g.k; }
      const nx = ag.from.x + Math.cos(a) * LAYOUT.SEG, nz = ag.from.z + Math.sin(a) * LAYOUT.SEG;
      const rr = Math.hypot(nx, nz);
      // A rejected STEP must not kill the STREET — one unlucky heading used to end it for
      // good and the graph starved at ~160 edges. Streets swerve twice before they give
      // up, which is also how real lanes behave.
      const retry = () => {
        if (ag.tries >= 2) return;
        ag.tries++;
        ag.a += (rnd() < .5 ? -1 : 1) * (.45 + rnd() * .4);
        push(ag);
      };
      if (rr > radiusAt(Math.atan2(nz, nx))) continue;              // the edge of the world
      if (T.blocked(nx, nz) > 0) { retry(); continue; }             // only built bridges cross water
      markNear(ag.from, P.HOPS);
      const hit = foreignNear(nx, nz, P.SNAP);
      if (hit) { link(ag.from, hit, dep, false); continue; }        // fuse into a junction, stop
      const clr = clearAt(rr);
      if (clr > P.SNAP && foreignNear(nx, nz, clr)) { retry(); continue; }
      ag.tries = 0;

      const cost = ag.cost + LAYOUT.SEG;
      const n = addNode(nx, nz, cost, dep);
      link(ag.from, n, dep, false);
      ag.since++;
      const next = agent(n, a, dep, cost);
      next.ph = ag.ph; next.budget = ag.budget - 1; next.since = ag.since;
      push(next);
      if (dep + 1 < 4 && ag.since >= P.BRANCH_GAP[dep] + Math.floor(rnd() * 3)) {
        next.since = 0;
        const side = rnd() < .5 ? 1 : -1;
        push(agent(n, a + side * (Math.PI / 2 + (rnd() - .5) * .7), dep + 1, cost));
        if (rnd() < .6) push(agent(n, a - side * (Math.PI / 2 + (rnd() - .5) * .7), dep + 1, cost));
      }
    }
  }
  runQueue();

  /* ── space-filling infill ──
     The agent tree radiates; it does not COVER. Past r≈120 it leaves huge empty
     wedges. Each round finds buildable cells no street has reached but whose
     neighbour is covered, and sprouts a lane toward the nearest — enclosure of the
     commons, and what takes a plan from ~350 to ~900 plots. */
  const rndI = sub(seed, 0x1b873593);
  const cellKey = (i, j) => i * 4093 + j;
  function spaceFill(CG, rounds) {
    const covered = new Set(), want = [];
    for (let round = 0; round < rounds && edges.length < P.EDGE_TARGET; round++) {
      covered.clear(); want.length = 0;
      for (const n of nodes) covered.add(cellKey(Math.round(n.x / CG), Math.round(n.z / CG)));
      const R = Math.ceil(LAYOUT.MAX_R / CG);
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
        if (covered.has(cellKey(i, j))) continue;
        const x = i * CG, z = j * CG, r = Math.hypot(x, z);
        if (r < LAYOUT.PLAZA_R || r > radiusAt(Math.atan2(z, x)) - CG * .4) continue;
        if (T.blocked(x, z) > 0) continue;
        if (!covered.has(cellKey(i + 1, j)) && !covered.has(cellKey(i - 1, j)) &&
          !covered.has(cellKey(i, j + 1)) && !covered.has(cellKey(i, j - 1))) continue;
        want.push(x, z, r);
      }
      if (!want.length) break;
      const order = [];
      for (let i = 0; i < want.length; i += 3) order.push(i);
      order.sort((a, b) => want[a + 2] - want[b + 2] || a - b);
      for (const oi of order) {
        const cx = want[oi], cz = want[oi + 1];
        let best = null, bd = 1e9;
        ng.each(cx, cz, CG * 2.2, n => { const d = Math.hypot(n.x - cx, n.z - cz); if (d < bd) { bd = d; best = n; } });
        if (!best) continue;
        push(agent(best, Math.atan2(cz - best.z, cx - best.x) + (rndI() - .5) * .5, clamp(best.depth + 1, 1, 3), best.d));
      }
      runQueue();
    }
  }
  // corridor archetypes have far less buildable area, so they get a finer sweep — a
  // 430-building day must never trigger ensureCapacity mid-cascade
  spaceFill(kind === 'ribbon' ? 22 : P.COVER, 60);

  /* ── stitch: the graph MUST be one component ──
     Villagers path over it; an island means stranded NPCs and unreachable errands.
     Bridge archetypes reliably produce 2–3 islands (a far bank whose link starved).
     Measured: 3 components before, 1 after, on all 8 test seeds. */
  function stitch() {
    for (let pass = 0; pass < 8; pass++) {
      const comp = new Int32Array(nodes.length).fill(-1);
      let c = 0;
      for (const n of nodes) {
        if (comp[n.i] >= 0) continue;
        const q = [n]; comp[n.i] = c;
        while (q.length) {
          const u = q.pop();
          for (const ei of u.adj) { const e = edges[ei], v = nodes[e.a === u.i ? e.b : e.a]; if (comp[v.i] < 0) { comp[v.i] = c; q.push(v); } }
        }
        c++;
      }
      if (c <= 1) return;
      const main = comp[plazaNodes[0].i];
      let bestA = null, bestB = null, bd = 1e9;
      for (const a of nodes) {
        if (comp[a.i] === main) continue;
        for (const b of nodes) {
          if (comp[b.i] !== main) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < bd) { bd = d; bestA = a; bestB = b; }
        }
      }
      if (!bestA) return;
      const mx = (bestA.x + bestB.x) / 2, mz = (bestA.z + bestB.z) / 2;
      const wet = T.blocked(mx, mz) > 0;
      const e = link(bestA, bestB, 1, wet);
      if (wet) bridges.push({
        x: mx, z: mz, a: Math.atan2(bestB.z - bestA.z, bestB.x - bestA.x),
        span: bd, w: P.WIDTH[1] + 1.4, main: false, d: Math.hypot(mx, mz), _e: e.i
      });
    }
  }
  stitch();

  /* ── true distance-from-plaza, by Dijkstra over the finished graph ──
     A node's `d` was its agent's running cost — the length of whichever street
     HAPPENED to reach it first, which after junction fusion and stitching can be far
     longer than the real walk. Growth order, landmark bands, ground painting and
     every NPC decision key off `d`, so it is computed once, for real. */
  function relaxDistances() {
    for (const n of nodes) n.d = 1e9;
    const heap = [];
    for (const n of plazaNodes) { n.d = LAYOUT.PLAZA_R; heap.push(n); }
    while (heap.length) {
      let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i].d < heap[bi].d) bi = i;
      const u = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      for (const ei of u.adj) {
        const e = edges[ei], v = nodes[e.a === u.i ? e.b : e.a];
        const nd = u.d + e.len;
        if (nd < v.d - 1e-6) { v.d = nd; heap.push(v); }
      }
    }
    for (const n of nodes) if (n.d > 1e8) n.d = Math.hypot(n.x, n.z);
    for (const e of edges) e.d = Math.min(nodes[e.a].d, nodes[e.b].d);
    for (const b of bridges) b.d = edges[b._e].d;
  }
  relaxDistances();

  /* ── plots: frontages down both sides of every street ──────── */
  const pg = grid(10);
  let plots = [];                       // the LIVE public array (post landmark deletion)
  let outerR = LAYOUT.PLAZA_R;
  const freeSpot = (x, z) => pg.each(x, z, LAYOUT.PLOT_D, p => Math.hypot(p.x - x, p.z - z) >= LAYOUT.PLOT_D);
  const offRoad = (x, z) => ng.each(x, z, 26, n => {
    for (const ei of n.adj) {
      const e = edges[ei], A = nodes[e.a], B = nodes[e.b];
      const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - A.x) * dx + (z - A.z) * dz) / L2, 0, 1);
      if (Math.hypot(x - (A.x + dx * t), z - (A.z + dz * t)) < e.w / 2 + P.ROAD_M) return false;
    }
  });
  const dry = (x, z) => {
    if (T.blocked(x, z) > 0) return false;
    if (T.blocked(x + 4.5, z) > 0 || T.blocked(x - 4.5, z) > 0) return false;
    if (T.blocked(x, z + 4.5) > 0 || T.blocked(x, z - 4.5) > 0) return false;
    return true;
  };

  // Burgage back rows: a core habit everywhere, but a corridor town has no outskirts
  // to spread into, so its whole length is burgage plots — which is what a real
  // valley village looks like anyway.
  const backDepth = kind === 'ribbon' ? 2 : 1, backR = kind === 'ribbon' ? 210 : P.BACKROW_R;
  const back2 = kind === 'ribbon';

  /** Lay every frontage the world can currently hold; returns only the NEW plots.
   *  minR (>0) restricts the pass to the outlands, which is what makes
   *  ensureCapacity append-only. */
  function placePlots(minR, wide) {
    const fresh = [];
    const tryPlot = (x, z, yaw, d, depth, ax, az, ei) => {
      const r = Math.hypot(x, z);
      if (r < LAYOUT.PLAZA_R + 4.5 || r > LAYOUT.MAX_R || r < minR) return;
      if (!dry(x, z) || !freeSpot(x, z) || !offRoad(x, z)) return;
      const p = { x, z, yaw, d, depth, k: 0, n: 0, _ax: ax, _az: az, _e: ei };
      fresh.push(p); pg.add(x, z, p);
      if (r > outerR) outerR = r;
    };
    // Two passes: EVERY street frontage first, burgage back rows only with what is
    // left. One pass let an early edge's back row steal the spot of a later edge's
    // own frontage — the thing that must never lose.
    for (const pass of [0, 1]) for (const e of edges) {
      if (e.bridge) continue;
      let A = nodes[e.a], B = nodes[e.b];
      if (B.d < A.d) { const t = A; A = B; B = t; }                 // lay outward from the plaza
      const len = e.len || 1;
      const nxv = -(B.z - A.z) / len, nzv = (B.x - A.x) / len;
      // Frontages are laid in the street's OWN arc length (s = node.d + t·len), not per
      // edge, so the pitch stays 7.4 across a junction. Per-edge slotting gave
      // round(13/7.4)=2 slots → a 6.5 pitch → every second plot rejected by PLOT_D.
      const s0 = A.d, s1 = A.d + len;
      for (const side of [1, -1]) {
        const ph = side > 0 ? 0 : LAYOUT.SPACING * .5;              // stagger the two sides
        for (let s = Math.ceil((s0 - ph) / LAYOUT.SPACING) * LAYOUT.SPACING + ph; s < s1; s += LAYOUT.SPACING) {
          const t = (s - s0) / len, px = A.x + (B.x - A.x) * t, pz = A.z + (B.z - A.z) * t;
          const off = P.SETBACK[e.depth] + ((Math.round(s / LAYOUT.SPACING) % 2) ? .6 : -.4);
          const yaw = Math.atan2(-nxv * side, -nzv * side);         // local +z is the façade
          if (pass === 0) {
            tryPlot(px + nxv * side * off, pz + nzv * side * off, yaw, s, e.depth, px, pz, e.i);
          } else if (e.depth <= (wide ? 2 : backDepth) && Math.hypot(px, pz) < (wide ? LAYOUT.MAX_R : backR)) {
            tryPlot(px + nxv * side * (off + P.BACKROW), pz + nzv * side * (off + P.BACKROW), yaw, s + 7, e.depth, px, pz, e.i);
            if (wide || back2) tryPlot(px + nxv * side * (off + P.BACKROW * 2), pz + nzv * side * (off + P.BACKROW * 2), yaw, s + 14, e.depth, px, pz, e.i);
          }
        }
      }
    }
    return fresh;
  }

  /* growth order — the one number that makes it READ right.
       k = r + KD·(d − r) + dither(±3)
     Pure d scatters the first 430 buildings out to r=250 (a straight spine tip is
     graph-nearer than a winding inner lane, so the town grows in spidery fingers);
     pure r is a bullseye again. KD=0.30 grows a compact core that creeps outward
     ALONG the streets. The dither is what makes the two sides of a street fill
     together instead of one whole side and then the other. */
  const rndK = sub(seed, 0x27d4eb2f);
  function orderAndAppend(fresh) {
    for (const p of fresh) p.k = P.KD * p.d + (1 - P.KD) * Math.hypot(p.x, p.z) + (rndK() - .5) * 6;
    for (let i = 0; i < fresh.length; i++) fresh[i].n = i;          // stable tiebreak
    fresh.sort((a, b) => a.k - b.k || a.n - b.n);
    const floor = plots.length ? plots[plots.length - 1].k : -1e9;  // k stays non-decreasing in i
    for (const p of fresh) {
      if (p.k < floor) p.k = floor;
      p.n = plots.length;
      plots.push(Object.freeze(p));
    }
  }
  const firstPass = placePlots(0, false);

  /* ── landmark sites: reserved by CLEARANCE, not by plot index ──
     v2's LM_PLOTS/RESERVED/plotIndexOf mechanism dies here. Each landmark declares
     (unlockOrdinal, clearance); the target band is the key the town will have grown
     to when it unlocks, in the SAME key space as the plot order. */
  const rndL = sub(seed, 0x85ebca6b);
  const keyOf = (x, z, d) => P.KD * d + (1 - P.KD) * Math.hypot(x, z);
  const sites = {}, taken = [];
  {
    // order the first pass by key so `want` can be read off it (plots aren't ordered yet)
    const byKey = firstPass.slice();
    for (const p of byKey) p.k = P.KD * p.d + (1 - P.KD) * Math.hypot(p.x, p.z);
    byKey.sort((a, b) => a.k - b.k);
    /** the open side of a junction: a landmark sits BESIDE its road, never in it */
    const siteOffset = (n, clr) => {
      let ax = 0, az = 0;
      for (const ei of n.adj) {
        const e = edges[ei], o = nodes[e.a === n.i ? e.b : e.a];
        const L = Math.hypot(o.x - n.x, o.z - n.z) || 1;
        ax += (o.x - n.x) / L; az += (o.z - n.z) / L;
      }
      let L = Math.hypot(ax, az), dx, dz;
      if (L > .2) { dx = -ax / L; dz = -az / L; }                 // away from where its roads go
      else if (n.adj.length) {                                    // mid-street: step off the kerb
        const e = edges[n.adj[0]], A = nodes[e.a], B = nodes[e.b];
        L = e.len || 1; dx = -(B.z - A.z) / L; dz = (B.x - A.x) / L;
      } else { L = Math.hypot(n.x, n.z) || 1; dx = n.x / L; dz = n.z / L; }
      const push2 = clr * .5 + 2.6;
      return { x: n.x + dx * push2, z: n.z + dz * push2 };
    };
    for (const [name, ord, clr] of LM) {
      const target = byKey[clamp(Math.round(ord * .72), 0, byKey.length - 1)];
      const want = target ? target.k : ord * .6;
      let best = null, bs = -1e9, bp = null;
      for (let relax = 0; relax < 3 && !best; relax++) {
        for (const n of nodes) {
          if (n.hub) continue;
          const r = Math.hypot(n.x, n.z);
          // the monument owns the plaza: nothing civic may crowd its footprint
          if (r - clr < 17.5 || r < LAYOUT.PLAZA_R + 5 || r > LAYOUT.MAX_R - clr) continue;
          const pos = siteOffset(n, clr);
          if (relax < 2 && !dry(pos.x, pos.z)) continue;
          if (relax < 1 && taken.some(t => Math.hypot(t.x - pos.x, t.z - pos.z) < t.clr + clr + 8)) continue;
          if (taken.some(t => Math.hypot(t.x - pos.x, t.z - pos.z) < t.clr + clr)) continue;
          const deg = n.adj.length;
          // a landmark wants a road END, a big junction or a bridgehead — but the BAND
          // dominates, or every monument ends up on the far fringe (it did, first pass)
          const worth = deg === 1 ? .9 : deg >= 4 ? 1.1 : deg === 3 ? .75 : .3;
          const near = (keyOf(n.x, n.z, n.d) - want) / 34;
          const s = worth - near * near * 1.6 + rndL() * .35 - relax * 1e-3;
          if (s > bs) { bs = s; best = n; bp = pos; }
        }
      }
      if (!best) {                                                  // all 9 are ALWAYS present
        const a = rndL() * TAU, r = clamp(24 + ord * .22, 24, LAYOUT.MAX_R - clr - 2);
        bp = { x: Math.cos(a) * r, z: Math.sin(a) * r };
        best = nodes[nearestNodeRaw(bp.x, bp.z)];
      }
      sites[name] = {
        x: bp.x, z: bp.z, clr, node: best.i,
        yaw: Math.atan2(best.x - bp.x, best.z - bp.z)               // face its own road
      };
      taken.push({ x: bp.x, z: bp.z, clr });
    }
  }
  /** plots inside a landmark footprint are deleted and the array renumbered, so
   *  plotAt(i) can never collide with a landmark and plotIndexOf() is not needed */
  const clearOfLandmarks = p => !taken.some(t => Math.hypot(t.x - p.x, t.z - p.z) < t.clr + 3.4);
  orderAndAppend(firstPass.filter(clearOfLandmarks));

  /* ── the gate: where the main road leaves town ──
     Anchored at r≈64 rather than at the spine tip: the signpost is mounted with the
     plat at t=0 and never moves, so it has to be in frame for a 20-house village AND
     still make sense once 430 houses have grown past it (an old gate, now a junction
     inside town — which is the nicer story anyway). */
  let gate;
  {
    let best = null, bs = 1e9;
    for (const n of nodes) {
      if (n.hub) continue;
      if (taken.some(t => Math.hypot(t.x - n.x, t.z - n.z) < t.clr + 5)) continue;
      const r = Math.hypot(n.x, n.z);
      const s = Math.abs(r - 64) + n.depth * 9 + (n.adj.length === 1 ? -6 : 0);
      if (s < bs) { bs = s; best = n; }
    }
    if (!best) best = plazaNodes[0];
    const e = best.adj.length ? edges[best.adj[0]] : null;
    let ox = 0, oz = 0;
    if (e) {
      const A = nodes[e.a], B = nodes[e.b], L = e.len || 1;
      ox = -(B.z - A.z) / L; oz = (B.x - A.x) / L;                  // stand it beside the road
    }
    const off = (e ? e.w / 2 : 3) + 2.6;
    gate = {
      x: best.x + ox * off, z: best.z + oz * off, node: best.i,
      yaw: Math.atan2(-(best.x + ox * off), -(best.z + oz * off))   // its boards face the town
    };
  }

  /* ── the spine: outbound headings environs aligns its field grain to ── */
  const spine = [];
  for (const n of plazaNodes) for (const ei of n.adj) {
    const e = edges[ei];
    if (e.depth > 1) continue;
    const o = nodes[e.a === n.i ? e.b : e.a];
    if (o.hub) continue;
    const a = Math.atan2(o.z, o.x);
    if (spine.some(s => Math.abs(wrapPi(s.a - a)) < .3)) continue;
    spine.push({ a, w: e.w });
  }
  if (!spine.length) for (const s of T.seeds) spine.push({ a: s.a, w: P.WIDTH[0] });

  /* ── water, as data (the surface mesh is environs') ── */
  let water = null;
  if (T.river) {
    // the river runs out past the town but not into the distant hills (r 420+),
    // where environs' veil takes over. Sliced, not filtered: the path must stay one
    // contiguous polyline.
    // Clipped at flatR (280), NOT 380: environs' terrain starts lifting into
    // relief past flatR and the water mesh is a flat plane pinned at y = .06, so
    // the last 100 units of channel spread into a wide triangular sheet lying over
    // rising ground and ended on a crisp diagonal cut in mid-field — the single
    // most conspicuous artefact in a wide riverside framing.
    const clipR = LAYOUT.MAX_R + LAYOUT.FLAT_PAD - 2;
    let a = 0, b = T.river.length - 1;
    while (a < b && Math.hypot(T.river[a].x, T.river[a].z) > clipR) a++;
    while (b > a && Math.hypot(T.river[b].x, T.river[b].z) > clipR) b--;
    const path = T.river.slice(a, b + 1).map(p => ({ x: p.x, z: p.z }));
    if (path.length > 3) water = { kind: 'river', path, width: T.riverW * 2 };
  } else if (T.lake) {
    const path = [];
    for (let i = 0; i < 96; i++) {
      const a = i / 96 * TAU, r = T.lakeR(a);
      path.push({ x: T.lake.cx + Math.cos(a) * r, z: T.lake.cz + Math.sin(a) * r });
    }
    water = { kind: 'lake', path, width: 14 };
  }

  /* ═══ prefix indexes: framing and frontier are O(1), never a scan ═══ */
  let px0, px1, pz0, pz1, prMax;
  function rebuildPrefix() {
    const n = plots.length + 1;
    px0 = new Float64Array(n); px1 = new Float64Array(n);
    pz0 = new Float64Array(n); pz1 = new Float64Array(n); prMax = new Float64Array(n);
    let x0 = -LAYOUT.PLAZA_R, x1 = LAYOUT.PLAZA_R, z0 = -LAYOUT.PLAZA_R, z1 = LAYOUT.PLAZA_R, rm = LAYOUT.PLAZA_R;
    px0[0] = x0; px1[0] = x1; pz0[0] = z0; pz1[0] = z1; prMax[0] = rm;
    for (let i = 0; i < plots.length; i++) {
      const p = plots[i];
      if (p.x - 5 < x0) x0 = p.x - 5; if (p.x + 5 > x1) x1 = p.x + 5;
      if (p.z - 5 < z0) z0 = p.z - 5; if (p.z + 5 > z1) z1 = p.z + 5;
      const r = Math.hypot(p.x, p.z); if (r > rm) rm = r;
      px0[i + 1] = x0; px1[i + 1] = x1; pz0[i + 1] = z0; pz1[i + 1] = z1; prMax[i + 1] = rm;
    }
  }

  /* ═══ road-graph indexes for the NPCs ═══ */
  let dOrder, dCum, dSorted;
  function rebuildRoadIndex() {
    dOrder = new Int32Array(edges.length);
    for (let i = 0; i < edges.length; i++) dOrder[i] = i;
    const o = Array.from(dOrder).sort((a, b) => edges[a].d - edges[b].d || a - b);
    dOrder = Int32Array.from(o);
    dCum = new Float64Array(edges.length + 1);
    dSorted = new Float64Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[dOrder[i]];
      dSorted[i] = e.d; dCum[i + 1] = dCum[i] + e.len;
    }
    pathCache.clear();
  }
  function nearestNodeRaw(x, z) {
    for (const r of [26, 60, 130, 300, 620]) {
      let best = -1, bd = 1e18;
      ng.each(x, z, r, n => {
        const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
        if (d < bd) { bd = d; best = n.i; }
      });
      if (best >= 0) return best;
    }
    let best = 0, bd = 1e18;
    for (const n of nodes) { const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z); if (d < bd) { bd = d; best = n.i; } }
    return best;
  }

  /* A*: ≤~500 nodes, euclidean heuristic, reused scratch, 32-entry LRU. */
  const pathCache = new Map();
  let gScore, cameFrom, stamp, gen = 0, open = [];
  function pathTo(a, b) {
    if (!(a >= 0 && a < nodes.length) || !(b >= 0 && b < nodes.length)) return [];
    if (a === b) return [a];
    const key = a * 100003 + b;
    const hit = pathCache.get(key);
    if (hit) return hit;
    if (!gScore || gScore.length < nodes.length) {
      gScore = new Float64Array(nodes.length); cameFrom = new Int32Array(nodes.length); stamp = new Int32Array(nodes.length);
    }
    gen++;
    const B = nodes[b];
    const h = n => Math.hypot(n.x - B.x, n.z - B.z);
    open.length = 0;
    gScore[a] = 0; cameFrom[a] = -1; stamp[a] = gen;
    open.push(a);
    let found = false, guard2 = 0;
    while (open.length && guard2++ < 20000) {
      let bi = 0, bf = 1e18;
      for (let i = 0; i < open.length; i++) {
        const f = gScore[open[i]] + h(nodes[open[i]]);
        if (f < bf) { bf = f; bi = i; }
      }
      const u = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (u === b) { found = true; break; }
      const un = nodes[u];
      for (const ei of un.adj) {
        const e = edges[ei], v = e.a === u ? e.b : e.a;
        const ng2 = gScore[u] + e.len;
        if (stamp[v] === gen && ng2 >= gScore[v] - 1e-9) continue;
        stamp[v] = gen; gScore[v] = ng2; cameFrom[v] = u;
        open.push(v);
      }
    }
    let out;
    if (!found) out = [a];                                   // stitched graph ⇒ should not happen
    else {
      out = [];
      for (let c = b; c >= 0; c = cameFrom[c]) out.push(c);
      out.reverse();
    }
    if (pathCache.size >= 32) pathCache.delete(pathCache.keys().next().value);
    pathCache.set(key, out);
    return out;
  }

  /* ═══ the returned plan ═══ */
  const _bounds = { cx: 0, cz: 0, r: LAYOUT.PLAZA_R, hx: LAYOUT.PLAZA_R, hz: LAYOUT.PLAZA_R };       // scratch: town.js copies the fields out
  const _off = { x: 0, z: 0 };
  const plazaPos = Object.freeze({ x: 0, z: 0 });

  // clamped, never undefined: a degenerate plan must not throw its way into a frame
  const VOID_PLOT = Object.freeze({ x: 0, z: LAYOUT.PLAZA_R + 6, yaw: Math.PI, d: LAYOUT.PLAZA_R, depth: 1, k: 0, n: 0, _ax: 0, _az: 0, _e: 0 });
  const plotAt = i => plots.length ? plots[i < 0 ? 0 : i >= plots.length ? plots.length - 1 : i] : VOID_PLOT;

  /** Lazy outlands. Capacity past ~900 costs 50–280 ms and is only reachable past
   *  10¹⁰ tokens/day, so it is paid for on demand — and only ever by APPENDING, so
   *  every index already handed out keeps its position.
   *  Two gears: the first steps push the boundary out and settle true outlands; once
   *  the disc is saturated against the absolute MAX_R the later steps thicken the
   *  outer half instead (finer lanes, deeper burgage rows). A town that cannot get
   *  wider gets denser — which is the same thing the monument does. */
  function ensureCapacity(want) {
    let step = 0;
    while (plots.length < want && step++ < 7) {
      guard = 0;                              // the growth guard is per invocation
      RMUL = Math.min(1.9, RMUL + .14);
      T.expand(); T.invalidate();
      const late = step > 2;
      spaceFill(late ? 15 : Math.max(18, P.COVER - 6), late ? 24 : 12);
      stitch(); relaxDistances();
      const fresh = placePlots(late ? outerR * .45 : outerR - 2, true).filter(clearOfLandmarks);
      if (!fresh.length && late) break;
      orderAndAppend(fresh);
    }
    rebuildPrefix(); rebuildRoadIndex();
    return plots.length;
  }

  function isWet(x, z) {
    if (T.river) return distToPoly(T.river, x, z).d < T.riverW + 1.2;
    if (T.lake) {
      const d = Math.hypot(x - T.lake.cx, z - T.lake.cz);
      return d < T.lakeR(Math.atan2(z - T.lake.cz, x - T.lake.cx)) + 1.2;
    }
    return false;
  }

  /* ── the road plate (§3.6). town.js owns the canvas and the texture; layout owns
        what is drawn on it. Nothing here leaks ctx state. ── */
  function paintGround(g, X, opt) {
    opt = opt || {};
    const px = opt.px || 2.926;
    const fk = (opt.frontierK == null ? 1e9 : opt.frontierK) + 18;
    const plazaR = opt.plazaR || LAYOUT.PLAZA_R;
    const wear = opt.wear == null ? 1 : opt.wear;
    // X is affine; sampling it three times gives a transform we can apply without
    // allocating an array per point (there are 26 000 of them in the wear pass).
    const o = X(0, 0), ux = X(1, 0), uz = X(0, 1);
    const ax = ux[0] - o[0], ay = ux[1] - o[1], bx = uz[0] - o[0], by = uz[1] - o[1];
    const PXx = (x, z) => o[0] + x * ax + z * bx;
    const PXy = (x, z) => o[1] + x * ay + z * by;

    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';

    /* 1 · water bed + banks (the surface itself is environs' mesh, floating above) */
    if (water) {
      const strokePath = (w, style, close) => {
        g.strokeStyle = style; g.fillStyle = style; g.lineWidth = w * px;
        g.beginPath();
        g.moveTo(PXx(water.path[0].x, water.path[0].z), PXy(water.path[0].x, water.path[0].z));
        for (let i = 1; i < water.path.length; i++) g.lineTo(PXx(water.path[i].x, water.path[i].z), PXy(water.path[i].x, water.path[i].z));
        if (close) { g.closePath(); g.fill(); }
        g.stroke();
      };
      const closed = water.kind === 'lake';
      strokePath(water.width * 1.7, 'rgba(150,132,96,.34)', closed);   // damp sand shoulder
      strokePath(water.width * 1.18, 'rgba(86,72,50,.55)', closed);    // bed
      strokePath(water.width, '#2d4348', closed);                      // the wet channel
    }

    /* 2 · landform shading — the countryside reads as terrain, not as an accident */
    if (T.valley) {
      // .075 alpha cost a canvas pass and bought literally nothing — the valley
      // was invisible in every shot, which is why 'valley ribbon village' read as
      // the same oval splat as a crossroads seed.
      g.strokeStyle = 'rgba(238,228,186,.22)'; g.lineWidth = T.valleyHalf * 1.7 * px;
      g.beginPath();
      for (let i = 0; i < T.valley.length; i++) {
        const p = T.valley[i];
        i ? g.lineTo(PXx(p.x, p.z), PXy(p.x, p.z)) : g.moveTo(PXx(p.x, p.z), PXy(p.x, p.z));
      }
      g.stroke();
    } else if (T.terrace) {
      // the terrace risers sit under the loop roads and share their lobed contour
      g.strokeStyle = 'rgba(238,228,186,.15)'; g.lineWidth = 13 * px;
      for (const band of [0, 1]) {
        g.beginPath();
        for (let i = 0; i <= 96; i++) {
          const a = i / 96 * TAU, rr = T.terrace(a)[band] * (.94 + .11 * Math.sin(a * 5 + T.a0));
          const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
          i ? g.lineTo(PXx(x, z), PXy(x, z)) : g.moveTo(PXx(x, z), PXy(x, z));
        }
        g.stroke();
      }
      // and the risers themselves — the steps nothing may be built on. Drawn dark
      // and narrow so the eye reads a scarp between two shelves of houses.
      if (T.risers && T.riserR) {
        g.strokeStyle = 'rgba(74,62,44,.30)'; g.lineWidth = 9 * px;
        for (const f of T.risers) {
          g.beginPath();
          for (let i = 0; i <= 128; i++) {
            const a = i / 128 * TAU, rr = T.riserR(f, a);
            const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
            i ? g.lineTo(PXx(x, z), PXy(x, z)) : g.moveTo(PXx(x, z), PXy(x, z));
          }
          g.closePath(); g.stroke();
        }
      }
    }

    /* 3–4 · verges, then the packed-dirt surface. Edges are straight, so this is one
             moveTo/lineTo per edge — ~500 strokes, ~4 ms. */
    // A street is only paved if it SERVES somewhere. Gating on graph depth alone
    // laid bare dirt lobes out past the last house — the town looked ringed by an
    // abandoned subdivision — because k (the growth key) is well under d for a
    // plot reached by a long way round. The radius gate is what stops that.
    const roadR = (opt.outerR == null ? 1e9 : opt.outerR) + 20;
    for (const [col, mul] of [['rgba(96,88,68,.45)', 1.7], ['#6d6450', 1]]) {
      g.strokeStyle = col;
      for (const e of edges) {
        if (e.d > fk) continue;
        if (Math.hypot(nodes[e.a].x, nodes[e.a].z) > roadR
          && Math.hypot(nodes[e.b].x, nodes[e.b].z) > roadR) continue;
        const A = nodes[e.a], B = nodes[e.b];
        g.lineWidth = e.w * mul * px;
        if (e.bridge) {                        // the deck is a mesh: pave only the approaches
          g.strokeStyle = mul > 1 ? col : 'rgba(72,64,48,.75)';
          for (const [F, S] of [[A, B], [B, A]]) {
            const t = Math.min(.28, 7 / (e.len || 1));
            g.beginPath();
            g.moveTo(PXx(F.x, F.z), PXy(F.x, F.z));
            g.lineTo(PXx(F.x + (S.x - F.x) * t, F.z + (S.z - F.z) * t), PXy(F.x + (S.x - F.x) * t, F.z + (S.z - F.z) * t));
            g.stroke();
          }
          g.strokeStyle = col;
          continue;
        }
        g.beginPath();
        g.moveTo(PXx(A.x, A.z), PXy(A.x, A.z));
        g.lineTo(PXx(B.x, B.z), PXy(B.x, B.z));
        g.stroke();
      }
      /* 5 · the plaza disc, verge first so it has a soft edge like every other road */
      g.fillStyle = col;
      g.beginPath(); g.arc(o[0], o[1], (plazaR + (mul - 1) * 2) * px, 0, TAU); g.fill();
    }
    // Three concentric arcs used to be painted here to SUGGEST cobbles on the
    // plaza. surface.js's ground role draws real setts now, and over them the
    // arcs read as three stray scratches across the square.

    /* 7 · plot aprons + footpaths: what makes a house look SETTLED rather than
           dropped on a lawn. Painted only as far as the town has actually grown. */
    let hi = plots.length;
    if (opt.frontierK != null) {              // plots are sorted by k — binary search the frontier
      let lo = 0; hi = plots.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (plots[m].k <= opt.frontierK) lo = m + 1; else hi = m; }
    }
    for (let i = 0; i < hi; i++) {
      const p = plots[i];
      g.strokeStyle = 'rgba(104,95,74,.42)'; g.lineWidth = .95 * px;
      g.beginPath();
      g.moveTo(PXx(p.x, p.z), PXy(p.x, p.z));
      g.lineTo(PXx(p._ax, p._az), PXy(p._ax, p._az));
      g.stroke();
      g.fillStyle = 'rgba(96,88,68,.32)';
      g.beginPath(); g.arc(PXx(p.x, p.z), PXy(p.x, p.z), 1.7 * px, 0, TAU); g.fill();
    }
    // A civic forecourt under each landmark THAT IS ACTUALLY STANDING. Painted on
    // frontier alone it put two or three 9-unit mud pans in the grass at the
    // town's edge — bald patches with no road into them and no building on them —
    // for landmarks 30 to 200 buildings away from unlocking.
    const builtN = opt.builtN == null ? 1e9 : opt.builtN;
    for (const kName in sites) {
      const s = sites[kName];
      if ((LM_ORD[kName] || 0) > builtN) continue;
      if (keyOf(s.x, s.z, nodes[s.node].d) > fk) continue;
      g.fillStyle = 'rgba(96,88,68,.30)';
      g.beginPath(); g.arc(PXx(s.x, s.z), PXy(s.x, s.z), (s.clr * .62 + 1.4) * px, 0, TAU); g.fill();
    }

    /* 8 · wear. Seeded, not Math.random(): the plate is repainted on every band
           change and a re-rolled speckle pattern would shimmer. */
    if (wear > 0) {
      const S = (g.canvas && g.canvas.width) || Math.abs(o[0]) * 2, rw = sub(seed, 0x2545f491);
      g.globalCompositeOperation = 'source-atop';
      const n = Math.round(26000 * clamp(wear, 0, 1));
      for (let i = 0; i < n; i++) {
        g.fillStyle = rw() < .5 ? 'rgba(255,245,220,.10)' : 'rgba(30,26,18,.16)';
        g.fillRect(rw() * S, rw() * S, 2.4, 2.4);
      }
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
  }

  rebuildPrefix(); rebuildRoadIndex();

  let innerR = 1e9;
  for (const p of plots) { const r = Math.hypot(p.x, p.z); if (r < innerR) innerR = r; }
  if (!plots.length) innerR = LAYOUT.PLAZA_R + 4.5;
  innerR = Math.max(17.5, innerR);            // the monument's footprint invariant (§5.1)

  const plan = {
    seed, kind, kindLabel: KIND_LABEL[kind], plazaPos, plazaR: LAYOUT.PLAZA_R,
    innerR, maxR: LAYOUT.MAX_R, flatR: LAYOUT.MAX_R + LAYOUT.FLAT_PAD,
    spine, gate, sites, bridges, water,
    graph: { nodes, edges },

    get capacity() { return plots.length; },

    plotAt, ensureCapacity,
    depthOf: i => plotAt(i).k,
    bandOf: i => (plotAt(i).k / P.BAND) | 0,

    /** growth frontier after b buildings — prefix-scanned, O(1) */
    frontierOf(b) {
      b = clamp(b | 0, 0, plots.length);
      return { k: b > 0 ? plots[b - 1].k : 0, r: prMax[b] };
    },
    /** prefix AABB ∪ plaza. Returns a per-plan SCRATCH — copy the fields out. */
    boundsFor(b) {
      b = clamp(b | 0, 0, plots.length);
      _bounds.cx = (px0[b] + px1[b]) / 2;
      _bounds.cz = (pz0[b] + pz1[b]) / 2;
      // hx/hz are the real half-extents. `r` is their max — the bounding CIRCLE —
      // which is the only thing the camera used to see, and on a valley ribbon or
      // a lakeside C that circle is far larger than the occupied ground. Handing
      // both out lets the framing fit the town's actual shape.
      _bounds.hx = (px1[b] - px0[b]) / 2;
      _bounds.hz = (pz1[b] - pz0[b]) / 2;
      _bounds.r = Math.max(_bounds.hx, _bounds.hz);
      return _bounds;
    },

    nearestNode: nearestNodeRaw,
    /** a fresh {x,z} — safe to retain (called once per errand, not per frame) */
    nodePos(i) { const n = nodes[clamp(i | 0, 0, nodes.length - 1)]; return { x: n.x, z: n.z }; },
    /** weighted neighbour pick: strongly favours continuing straight, never backtracks
     *  unless `cur` is a dead end. `rnd` is one number in [0,1). */
    randomNextNode(prev, cur, rnd) {
      const n = nodes[clamp(cur | 0, 0, nodes.length - 1)];
      if (!n.adj.length) return n.i;
      let hx = 0, hz = 0;
      if (prev >= 0 && prev < nodes.length) {
        const p = nodes[prev], L = Math.hypot(n.x - p.x, n.z - p.z) || 1;
        hx = (n.x - p.x) / L; hz = (n.z - p.z) / L;
      }
      let sum = 0;
      for (const ei of n.adj) {
        const e = edges[ei], o = nodes[e.a === n.i ? e.b : e.a];
        if (o.i === prev && n.adj.length > 1) continue;
        const L = Math.hypot(o.x - n.x, o.z - n.z) || 1;
        const dot = hx || hz ? (o.x - n.x) / L * hx + (o.z - n.z) / L * hz : 0;
        const w = Math.pow(.55 + .45 * dot, 3) + .04;
        sum += w;
      }
      if (sum <= 0) return nodes[edges[n.adj[0]].a === n.i ? edges[n.adj[0]].b : edges[n.adj[0]].a].i;
      let r = rnd * sum;
      for (const ei of n.adj) {
        const e = edges[ei], o = nodes[e.a === n.i ? e.b : e.a];
        if (o.i === prev && n.adj.length > 1) continue;
        const L = Math.hypot(o.x - n.x, o.z - n.z) || 1;
        const dot = hx || hz ? (o.x - n.x) / L * hx + (o.z - n.z) / L * hz : 0;
        r -= Math.pow(.55 + .45 * dot, 3) + .04;
        if (r <= 0) return o.i;
      }
      const e = edges[n.adj[n.adj.length - 1]];
      return e.a === n.i ? e.b : e.a;
    },
    /** A* → the node-index chain [a, …, b] inclusive; consecutive pairs are edges
     *  (use edgeBetween). Cached and READ-ONLY: do not mutate the returned array. */
    pathTo,
    /** length-weighted point on an edge with e.d <= maxK — "somewhere in town" */
    randomRoadPoint(rnd, maxK) {
      if (!dSorted.length) return { x: 0, z: LAYOUT.PLAZA_R, edge: -1 };
      let lo = 0, hi = dSorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (dSorted[m] <= maxK) lo = m + 1; else hi = m; }
      const m = lo || Math.min(dSorted.length, 8);              // never strand a caller
      const total = dCum[m];
      let u = clamp(rnd, 0, .999999) * total;
      let a = 0, b = m;
      while (a < b) { const mid = (a + b) >> 1; if (dCum[mid + 1] <= u) a = mid + 1; else b = mid; }
      const ei = dOrder[Math.min(a, m - 1)], e = edges[ei];
      const t = clamp((u - dCum[Math.min(a, m - 1)]) / (e.len || 1), 0, 1);
      const A = nodes[e.a], B = nodes[e.b];
      return { x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t, edge: ei };
    },
    edgeBetween(a, b) {
      const n = nodes[a];
      if (!n) return null;
      for (const ei of n.adj) { const e = edges[ei]; if (e.a === b || e.b === b) return e; }
      return null;
    },
    /** walk on your own side of the road. Returns a per-plan SCRATCH (this is called
     *  per villager per frame) — read x/z immediately, never retain it. */
    offsetOn(edge, t, lat) {
      const e = edges[clamp(edge | 0, 0, edges.length - 1)];
      const A = nodes[e.a], B = nodes[e.b], L = e.len || 1;
      _off.x = A.x + (B.x - A.x) * t - (B.z - A.z) / L * lat;
      _off.z = A.z + (B.z - A.z) * t + (B.x - A.x) / L * lat;
      return _off;
    },
    distFromPlaza: (x, z) => Math.hypot(x, z),
    isWet,
    paintGround
  };
  return plan;
}
