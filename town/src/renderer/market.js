// MARKET DAY — idea T-10. The plaza around the fountain is a market square with
// no market in it. This is the market: it arrives on one day of the week, sets
// up, does business, packs down, and leaves the square swept.
//
// It is the town's only WEEKLY rhythm. Everything else in Token Town runs on the
// day (the palette, the plan, the name) or on the minute (the crowd, the
// weather). One morning in seven the square fills with trestles and the town has
// somewhere to be; the other six it is bare cobbles, which is what makes the one
// day worth looking at.
//
// Five rules govern this file.
//
//  1. THE CLOCK IS THE ONLY STATE MACHINE. Which phase the market is in, how far
//     up any given stall is, where a cart has got to along the lane — every one
//     of them is a PURE FUNCTION of the hour of the day (and, under `--market=demo`,
//     of `performance.now()`). Nothing is integrated, nothing accumulates, `dt`
//     is read for exactly nothing. A headless run paints at ~1 fps; a screenshot
//     taken at 07:40 must show carts genuinely part-way down the lane and the
//     first awning half up, not a market that never started because a frame
//     counter never advanced. This project has been bitten by dt-paced arrivals
//     repeatedly and this file does not add to the tally.
//
//  2. THE TRIANGLE BUDGET IS FULL. The plaza is exactly where the zoomed bench
//     scene looks, and that scene sits ~2 k triangles under its ceiling. So there
//     are FIVE meshes here, all instanced, all built from hand-emitted triangle
//     soup with the faces nobody can see left out, and per-part colour baked into
//     a vertex-colour attribute so nine stalls, three carts, their wheels and
//     their crates share ONE material. Measured at the top village tier: ~1.2 k
//     triangles and 4 draw calls with the market up, 0 and 0 with it down.
//     `stats()` reports both, live, so the number in the commit message is not a
//     guess.
//
//  3. NOTHING HERE ASKS FOR ANYTHING. The copy gate is absolute and it is why
//     this module carries its own corpus instead of borrowing the Crier's: no
//     line may nag, guilt, chase, set a target, or notice what was or was not
//     spent — and NO LINE USES THE SECOND PERSON AT ALL, not in the Gazette copy,
//     not in a stall-holder's patter, not in an idiom. Villagers elsewhere say
//     "you" to each other; this module does not, so that no line of it can ever
//     be read as addressed to the person watching. The market is a place. It is
//     having a good day whether or not anybody is looking at it.
//
//  4. EVERY INPUT IS OPTIONAL. `initMarket(null, undefined)` builds, updates,
//     resets and disposes without throwing. With no plan it has no lanes to keep
//     clear and lays the stalls round the whole ring; with no `say` the
//     stall-holders think their remarks instead of saying them.
//
//  5. IT IS A VILLAGE MARKET (AESTHETIC.md, binding). Canvas awnings on timber
//     posts, trestle counters, crates, sacks and produce trays, hand carts with
//     their shafts down. Weathered oak, undyed canvas, faded madder and old
//     indigo — no saturated primaries, nothing plastic, nothing that glows. A
//     stall stands a little over a bench and well under a cottage eave, because
//     that is what a stall does. Would a photograph of a real village look like
//     this?
//
// Imports: three, surface.js for the town's shared material pass, and
// `villageFabric` from buildings.js for the ONE number this module must not
// become the second owner of — how many stalls the town's tier carries (0/2/5/9
// for hamlet/village/market village/market town). It never learns that news.js,
// npcs.js or town.js exist: the caller hands it a `say`, an `announce` and a few
// getters and mediates everything else.
import * as THREE from './vendor/three.module.js';
import { applyTownSurface } from './surface.js';
import { villageFabric } from './buildings.js';

/* ═══ the day, and the hours in it ══════════════════════════════
   Market hours as decimal hours on the local clock. A real market sets up in the
   dark, opens when the bell goes, and is gone by supper. */
const H_ARRIVE = 6.2;    // first cart off the lane
const H_SETUP = 7.6;     // carts parked; trestles and canvas go up
const H_OPEN = 8.6;      // trade
const H_PACK = 16.6;     // crates back onto the carts
const H_SHUT = 17.6;     // swept, empty, gone

/** Phase names. The handle reports one of these and nothing else. */
export const MARKET_PHASES = Object.freeze(['shut', 'arriving', 'setting up', 'open', 'packing up']);
const P_SHUT = 0, P_ARRIVE = 1, P_SETUP = 2, P_OPEN = 3, P_PACK = 4;

/** Weekday names, index === Date#getDay(). */
export const MARKET_WEEKDAYS = Object.freeze(
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/** localStorage key for the charter weekday. See `resolveWeekday`. */
const LS_KEY = 'tt.market.weekday.v1';
/** `--market=demo` sweeps a whole market day into this much wall clock. */
const DEMO_LOOP_MS = 96000;
/* wall-clock cadences for the one thing that is not derived from the hour */
const CHAT_EVERY = 10500;     // a stall-holder tries for a bubble this often
const CHAT_RETRY = 2600;      // …and again this soon after news.js refuses one

/* ═══ the wardrobe ══════════════════════════════════════════════
   buildings.js's village vocabulary, carried by value rather than imported so
   this file has one fewer thing that can break under it: oak fresh / tarred /
   silvered, undyed canvas, and four dyes a village could actually afford. */
const OAK = 0x6C5437, OAK_D = 0x4C3C27, OAK_S = 0x8A7A62;
const TIMBER = 0x7A6446, CRATE = 0x8A7550, SACK = 0xBFB395;
const IRON = 0x3E3B36, SKIN = 0xD8B48F, COAT = 0x5F5442, FELT = 0x4A4234;
const CANVAS_BASE = 0xEFE3C8, CANVAS_STRIPE = 0xB4A588;
// Awning tints, multiplied INTO the striped canvas — so every one of them comes
// out dusty. There is no way to get a bright awning out of this list, which is
// exactly why it is a list of tints and not a list of colours: undyed, weak
// madder, old indigo, weak ochre, faded green, and canvas that has simply been
// rained on. The first pass of these was two shades stronger and the square
// photographed as a row of beach umbrellas.
const AWNING_TINTS = [0xE7DFCB, 0xCCAA9C, 0xADB6B6, 0xCEBE9C, 0xBCBEAB, 0xC2B4A2];
// Produce. Root, leaf, apple, grain — muted, because a real tray of turnips is.
const PRODUCE = [0x8C6A3A, 0x6B7A4E, 0x9E5A44, 0xC2A24E, 0x7E6A46, 0x8E8F60];
/** The stall-holders' trades — the gold nameplate over a remark. */
const TRADES = ['Cheesemonger', 'Potter', 'Fishwife', 'Baker', 'Cooper',
  'Weaver', 'Herbalist', 'Egg-woman', 'Fruiterer', 'Basketmaker', 'Tanner', 'Chandler'];

/* ═══ small helpers ═════════════════════════════════════════════ */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = t => (t = clamp(t, 0, 1)) * t * (3 - 2 * t);
/** three's convention: local +z is front, so facing (dx,dz) is atan2(dx,dz). */
const faceOf = (dx, dz) => Math.atan2(dx, dz);
/** Seeded and non-allocating: Math.random() is banned outside particles and gait. */
function hash1(s) {
  let x = Math.imul((s | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const stream = s => { let r = (s >>> 0) || 1; return () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; }; };
/** Local calendar day ordinal — the unit the charter weekday is minted from. */
const dayIndexOf = ms => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 864e5);
const hourOf = ms => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };
/** Shared scratch for the awning tints — one Color for the life of the module. */
const _tmpC = new THREE.Color();

/* ═══ the test hook ═════════════════════════════════════════════
   `--market=<what>`, parsed here rather than in town.js for the reason events.js
   parses `--event=` itself: a flag belongs to the module it drives.

     off                     there is never a market day
     on | open               the market is open right now, whatever day it is
     arrive | setup | pack   force that phase
     today                   today IS market day; the phase follows the real hour
     demo                    today is market day, and a whole market day —
                             arrivals, set-up, trade, pack-down — sweeps past in
                             96 s of wall clock. The only way to watch the entire
                             rhythm in one run.
     mon…sun | 0…6           move the charter weekday to that day

   `--hour=N` is honoured on top of any of these, so `--market=today --hour=7.4`
   photographs the carts coming in.

   FOR THE WIRING WAVE: main.js keeps a whitelist of flags forwarded to the page
   and `market` has to be added to it. Until it is, this reads '' in a packaged
   run and the flag silently does nothing. */
const QS = (() => {
  try { return new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''); }
  catch (e) { return new URLSearchParams(''); }
})();
const FORCE = String(QS.get('market') || '').trim().toLowerCase();
const HOUR_Q = (() => { const h = QS.get('hour'); return h !== null && h !== '' && isFinite(+h) ? clamp(+h, 0, 24) : null; })();
const FORCE_PHASE =
  FORCE === 'on' || FORCE === 'open' ? P_OPEN :
    FORCE === 'arrive' || FORCE === 'arriving' ? P_ARRIVE :
      FORCE === 'setup' ? P_SETUP :
        FORCE === 'pack' || FORCE === 'packing' ? P_PACK : -1;
const FORCE_OFF = FORCE === 'off';
const FORCE_DEMO = FORCE === 'demo';
const FORCE_DAY = FORCE === 'today' || FORCE_DEMO || FORCE_PHASE >= 0;
const FORCE_WEEKDAY = (() => {
  if (!FORCE) return -1;
  if (/^[0-6]$/.test(FORCE)) return +FORCE;
  for (let i = 0; i < 7; i++) {
    const n = MARKET_WEEKDAYS[i].toLowerCase();
    if (FORCE === n || FORCE === n.slice(0, 3)) return i;
  }
  return -1;
})();

/* ═══ THE CORPUS ════════════════════════════════════════════════
   Two voices under one gate.

   The ticker pools (ARRIVING · SETUP · OPEN · PACKING · EVE) are the Gazette's:
   third person, present tense, dry and fond, about the square and the people on
   it. `{town}` is the only slot and news.js resolves it, so a line is never
   printed with a hole in it.

   CHATTER is a stall-holder's own voice, spoken over their trestle — six or
   seven words of market patter, never an instruction to anybody.

   THE COPY GATE, checked line by line and binding on anything added here:
     · Nothing may nag, guilt, chase or pressure. NO SECOND PERSON AT ALL.
     · No targets, no goals, no streak, no "come back", no observation that
       anything has slowed, run short, or failed to arrive.
     · Nothing counts the ledger. This market sells turnips. Where a price is
       named it is the price of a turnip, in the town's own currency, exactly as
       news.js's existing market corpus already prices cheese.
     · The market is a PLACE, and it is having a good day regardless. */
const RAW = {
  /* ── the carts are on the lane and the square is still empty ── */
  ARRIVING: [
    'Carts on the lane before light. Market day in {town}.',
    'The first cart is in and the square is being paced out by lamplight.',
    'Market morning. Two carts, a great deal of rope, and nobody hurrying.',
    'The lanes into {town} have carts on them and the square has frost on it.',
    'A cart has come forty miles for one morning of trade. It does this weekly.'
  ],
  /* ── trestles going up ── */
  SETUP: [
    'Trestles first, canvas second, opinions third. The square is setting up.',
    'The awnings are going up in {town}, and one of them is going up twice.',
    'Market day. The stalls are half raised and the arguing has started early.',
    'Poles, rope, canvas, done. The square has been doing this for centuries.',
    'The good corner was claimed at six. The good corner is claimed at six every week.'
  ],
  /* ── trade. The largest pool: this is where the market spends its day. ── */
  OPEN: [
    'Market day in {town}. The square is full of trestles and opinion.',
    'The stalls are up. {town} has somewhere to be.',
    'The square smells of onions, wet canvas and somebody else\'s good luck.',
    'Prices are set by shouting. The charter is quite clear about this.',
    'A goat has been reported among the stalls. A goat is always reported.',
    'The potter has brought forty bowls and a great deal of confidence.',
    'Trade is brisk in the aisle and glacial at the herb stall, which suits the herbalist.',
    'The fishwife and the baker have swapped pitches. Nobody knows why. It is working.',
    'Somebody has weighed the same sack three times. It weighs the same.',
    'An argument about the price of eggs has become a friendship.',
    'The awnings are the same canvas as last year, and the year before, and so on.',
    'Two stalls have merged into one long conversation. Trade continues around it.',
    'Market day: the one morning a week the fountain queues for its own square.',
    'The cheesemonger has the corner by the water. This was agreed a long time ago.',
    'A child was sent for change and has not been seen since. This is normal.',
    'Half of {town} is on the square and half of that came only to look.'
  ],
  /* ── packing down. Warm and finished, never wistful about a thing ending. ── */
  PACKING: [
    'The market packs down. Crates onto carts, canvas onto crates, and home.',
    'The last awning comes down and the square gets its cobbles back.',
    'Folded, roped, loaded. {town} is quiet again by supper.',
    'Market day ends. The square is swept. The goat is not found.',
    'The stalls come down faster than they went up. They always do.'
  ],
  /* ── the evening before. One quiet line, because a town that sweeps its square
        the night before is a town with a rhythm. ── */
  EVE: [
    'The square has been swept and chalked. Market day tomorrow in {town}.',
    'Trestles stacked by the cross tonight. They are wanted in the morning.'
  ],
  /* ── Stall-holder patter, spoken over the counter.
        NO SECOND PERSON AND NO IMPERATIVES. A bare imperative ("weigh it
        again", "mind the awning") is grammatically second person even without
        the pronoun, and a remark that can be read as an instruction can be read
        as an instruction to the person watching. Every line here is therefore
        something a trader says ABOUT their own goods.
        These also deliberately avoid restating news.js's own `market` bubble
        pool, which the villagers already draw on. ── */
  CHATTER: [
    'Two for a token, and I am being robbed.',
    'It is a cheese. It is simply a very large one.',
    'Weighed twice already. The same both times.',
    'Grown in my own garden. Mostly.',
    'Fresh this morning. Broadly speaking.',
    'Nobody on this square sells it cheaper. Nobody.',
    'Nine left. Eight. Seven.',
    'The awning lets the rain in. It always has.',
    'Same pitch my mother had.',
    'Sold out by noon, I shouldn\'t wonder.',
    'The good ones are under the cloth.',
    'No. Not that one. That one is spoken for.',
    'I have said my price and I am at peace with it.',
    'It rained on the eggs. The eggs are fine.',
    'Here till dusk, same as ever.',
    'That is a very fine turnip and I stand by it.',
    'The cart came forty miles for this.',
    'Forty bowls, and not one of them chipped.',
    'It will all be gone by Thursday anyway.',
    'The rope is holding. The rope always holds.'
  ]
};

/** The frozen corpus — for tests, and so the copy gate reads in one place. */
export const MARKET_CORPUS = (() => {
  const o = {};
  for (const k in RAW) o[k] = Object.freeze(RAW[k].slice());
  return Object.freeze(o);
})();

/* ═══ the charter weekday ═══════════════════════════════════════
   A village's market day does not move. Token Town is re-founded every morning
   under a new name and a new plan seed, so neither of those can own it: a market
   day minted from the day seed would land on a different day every day, which is
   not a rhythm, it is noise.

   So it is minted ONCE, from the first calendar day this installation ever ran,
   and then persisted. From then on it is simply what this town's market day is,
   the way a real charter day is simply Thursday. If storage is unavailable the
   mint still runs (stable for the session) and nothing throws. */
/**
 * Pure: which weekday a given seed's market falls on.
 * @param {number} seed @returns {number} 0..6, Sunday-based
 */
export function marketWeekdayFor(seed) {
  return Math.floor(hash1((seed >>> 0) * 2654435761 + 7919) * 7) % 7;
}
function resolveWeekday(cfgDay, nowMs) {
  if (FORCE_WEEKDAY >= 0) return FORCE_WEEKDAY;
  if (typeof cfgDay === 'number' && cfgDay >= 0 && cfgDay <= 6) return Math.round(cfgDay);
  let stored = null;
  try { stored = window.localStorage.getItem(LS_KEY); } catch (e) { stored = null; }
  if (stored !== null && /^[0-6]$/.test(stored)) return +stored;
  const d = marketWeekdayFor(dayIndexOf(nowMs || Date.now()));
  try { window.localStorage.setItem(LS_KEY, String(d)); } catch (e) { /* session-stable is enough */ }
  return d;
}

/* ═══ the mesher ════════════════════════════════════════════════
   Hand-emitted, non-indexed triangle soup: a flat face normal per triangle and a
   baked vertex colour. Two reasons it is not a pile of BoxGeometries:

     · a box is twelve triangles whether or not anybody can see its underside,
       and a market stall is mostly posts standing in the ground. `skip` leaves
       the buried and hidden faces out, which is about a fifth of the module's
       whole triangle budget;
     · the colour rides on the vertices, so nine stalls, three carts, their
       wheels, their crates, their sacks and their produce trays are ONE material
       and every mesh stays instanced.

   Build-time only. It allocates freely, once, and then never runs again. */
function mesher() {
  const p = [], n = [], c = [], u = [];
  const st = [new THREE.Matrix4()];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _n = new THREE.Vector3();
  const _t = new THREE.Vector3(), _col = new THREE.Color();
  const top = () => st[st.length - 1];

  function vert(x, y, z, nx, ny, nz, r, g, b, uu, vv) {
    _t.set(x, y, z).applyMatrix4(top());
    p.push(_t.x, _t.y, _t.z);
    _t.set(nx, ny, nz).transformDirection(top());   // rigid transforms only
    n.push(_t.x, _t.y, _t.z);
    c.push(r, g, b);
    u.push(uu || 0, vv || 0);
  }
  /** One triangle, face normal derived from its winding. */
  function tri(ax, ay, az, bx, by, bz, cx, cy, cz, hex, uv) {
    _a.set(ax, ay, az); _b.set(bx, by, bz); _c.set(cx, cy, cz);
    _ab.copy(_b).sub(_a); _ac.copy(_c).sub(_a);
    _n.copy(_ab).cross(_ac);
    if (_n.lengthSq() < 1e-14) return;
    _n.normalize();
    _col.setHex(hex);
    const U = uv || ZERO_UV;
    vert(ax, ay, az, _n.x, _n.y, _n.z, _col.r, _col.g, _col.b, U[0], U[1]);
    vert(bx, by, bz, _n.x, _n.y, _n.z, _col.r, _col.g, _col.b, U[2], U[3]);
    vert(cx, cy, cz, _n.x, _n.y, _n.z, _col.r, _col.g, _col.b, U[4], U[5]);
  }
  /** A planar quad wound a→b→c→d. `uv` is eight numbers or undefined. */
  function quad(a, b, cc, d, hex, uv) {
    tri(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], hex,
      uv && [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]]);
    tri(a[0], a[1], a[2], cc[0], cc[1], cc[2], d[0], d[1], d[2], hex,
      uv && [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]]);
  }
  /**
   * An axis-aligned box whose BASE sits at y and whose centre is (x, z).
   * @param {string} [skip] any of 't b n s e w' — top, bottom, -z, +z, +x, -x.
   *        What is buried in the cobbles, hidden under a counter or pressed
   *        against a cart bed is simply not emitted.
   */
  function box(x, y, z, w, h, d, hex, skip) {
    const s = skip || '';
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y, y1 = y + h, z0 = z - d / 2, z1 = z + d / 2;
    if (s.indexOf('t') < 0) quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], hex);
    if (s.indexOf('b') < 0) quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], hex);
    if (s.indexOf('s') < 0) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], hex);
    if (s.indexOf('n') < 0) quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], hex);
    if (s.indexOf('e') < 0) quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], hex);
    if (s.indexOf('w') < 0) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], hex);
  }
  /** A drum about the local Y axis — a barrel, or a cart wheel once it is turned. */
  function drum(x, y, z, r, h, seg, hex) {
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      quad([x + c0 * r, y, z + s0 * r], [x + c1 * r, y, z + s1 * r],
        [x + c1 * r, y + h, z + s1 * r], [x + c0 * r, y + h, z + s0 * r], hex);
      // caps as fans from vertex 0: a hexagon is four triangles, not six
      if (i > 0 && i < seg - 1) {
        tri(x + r, y + h, z, x + c0 * r, y + h, z + s0 * r, x + c1 * r, y + h, z + s1 * r, hex);
        tri(x + r, y, z, x + c1 * r, y, z + s1 * r, x + c0 * r, y, z + s0 * r, hex);
      }
    }
  }
  return {
    tri, quad, box, drum,
    push(m) { st.push(new THREE.Matrix4().multiplyMatrices(top(), m)); return this; },
    pop() { if (st.length > 1) st.pop(); return this; },
    get tris() { return p.length / 9; },
    build(withUV) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(c), 3));
      if (withUV) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(u), 2));
      g.computeBoundingSphere();
      return g;
    }
  };
}
const ZERO_UV = [0, 0, 0, 0, 0, 0];
const trans = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const rotX = a => new THREE.Matrix4().makeRotationX(a);

/* ═══ the four things a market is made of ═══════════════════════
   SCALE, which is the thing that decides whether this reads as a market or as a
   row of bus shelters. A villager stands ~0.93 units; a cottage wall is 2.2 and
   its door 1.35; a plaza bench is 2.2 long and ~1.05 tall. A market stall has to
   be plainly bigger than the bench and plainly smaller than the eave: 1.95 wide,
   1.62 to the ridge of its canvas. */
const ST_W = 1.95, ST_D = 0.90;
const POST_B = 1.62, POST_F = 1.42, CTR_Y = 0.72;
/** Top of the awning, local — the tether for a stall-holder's bubble. */
const ST_TOP = POST_B + 0.08;
const WHEEL_R = 0.26;
/** Carts are drawn half again over their authored size: at 1.0 a market cart
 *  beside a 0.93-unit villager photographs as a wheelbarrow, and at the framing
 *  the plaza is actually seen from it disappears entirely. Scale is free;
 *  triangles are not. */
const CART_S = 1.45;

/** ONE STALL: four posts, a trestle counter, a produce tray, a crate and a sack.
 *  The canvas is a separate mesh because it is a separate material. */
function stallGeo(m) {
  const hx = ST_W / 2 - .08, hz = ST_D / 2;
  // 1 · posts, sunk .05 into the cobbles (no underside) and capped by the canvas
  //     (no top face). Back pair taller than the front: this is a lean-to.
  for (const sx of [-1, 1]) {
    m.box(sx * hx, -.05, -hz, .085, POST_B + .05, .085, OAK_D, 'tb');
    m.box(sx * hx, -.05, hz, .080, POST_F + .05, .080, OAK_D, 'tb');
  }
  // 2 · the trestle: a board on two splayed leg-boards. The underside of the top
  //     and the ends of the legs are never seen from anywhere.
  m.box(0, CTR_Y, .02, ST_W, .065, ST_D * .84, OAK, 'b');
  for (const sx of [-1, 1]) m.box(sx * (hx - .24), .01, .02, .075, CTR_Y - .01, ST_D * .60, OAK_S, 'tb');
  // 3 · the goods: one tray of produce on the counter, one crate below, pushed to
  //     opposite ends so no stall is symmetrical.
  m.box(-.36, CTR_Y + .065, .04, .68, .10, .44, CRATE, 'b');
  m.box(-.36, CTR_Y + .165, .04, .58, .055, .34, PRODUCE[0], 'b');
  m.box(.50, .00, -.08, .44, .34, .36, CRATE, 'b');
  // 4 · a sack against the near post, because a market has things on its floor
  m.box(hx - .04, .00, hz - .26, .26, .34, .26, SACK, 'b');
  // 5 · the back board the goods hang from: two faces, no ends
  m.box(0, POST_B - .50, -hz + .035, ST_W - .16, .30, .04, OAK_S, 'tbew');
}

/** THE AWNING: a lean-to sheet from the back posts out over the counter, plus the
 *  short valance hanging off its front edge. Four triangles of striped canvas,
 *  double sided, tinted per stall — and the whole silhouette of a market from
 *  fifty units up. Its vertex colour is WHITE on purpose: the map and the
 *  instance tint are the only two things allowed to darken it. */
function awningGeo(m) {
  const hx = ST_W / 2 + .10, zb = -ST_D / 2 - .02, zf = ST_D / 2 + .34;
  const yb = POST_B + .08, yf = POST_F - .02;
  // u runs 0..2.4 across the width, which is the stripe pitch, with no
  // per-material repeat to get out of step with anything.
  m.quad([-hx, yb, zb], [hx, yb, zb], [hx, yf, zf], [-hx, yf, zf], 0xFFFFFF,
    [0, 0, 2.4, 0, 2.4, 1, 0, 1]);
  m.quad([-hx, yf, zf], [hx, yf, zf], [hx, yf - .20, zf], [-hx, yf - .20, zf], 0xFFFFFF,
    [0, 1, 2.4, 1, 2.4, 1.22, 0, 1.22]);
}

/** A HAND CART, authored with its AXLE at the origin and its shafts pointing +z.
 *  That is what lets one instance matrix tell the whole story: rolled level it is
 *  being drawn down the lane, pitched forward it is standing on the square with
 *  its shafts down. No horse — a village market runs on hand carts, and a horse
 *  is four hundred triangles this module does not have. */
function cartGeo(m) {
  m.box(0, .05, -.06, 1.06, .20, .56, TIMBER, 'b');       // the bed
  m.box(0, .25, -.10, .80, .26, .42, CRATE, 'b');         // its load
  for (const sx of [-1, 1]) m.box(sx * .24, .02, .50, .06, .06, .92, OAK, 'ns');
  for (const sx of [-1, 1]) {                              // wheels, turned onto the axle
    m.push(trans(sx * .34, 0, 0)).push(rotX(Math.PI / 2));
    m.drum(0, -.045, 0, WHEEL_R, .09, 6, OAK_D);
    m.pop().pop();
  }
}

/** A LOOSE CRATE, for the stack at the plaza rim while the carts unload. */
function crateGeo(m) { m.box(0, 0, 0, .48, .36, .40, CRATE, 'b'); }

/** A TRADER, and deliberately the crudest thing in the file: a body under a
 *  blocky head and a felt brim, at a size that reads as somebody walking beside a
 *  cart from forty units — and it never gets closer, because traders only exist
 *  while the carts are on the move. The crowd proper is npcs.js's and this module
 *  does not compete with it. */
function traderGeo(m) {
  m.drum(0, 0, 0, .155, .60, 6, COAT);
  m.box(0, .60, 0, .19, .18, .18, SKIN, 'b');
  m.box(0, .755, 0, .30, .045, .28, FELT, 'b');
}

/* ═══ the striped canvas ════════════════════════════════════════ */
function makeStripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const hx = n => '#' + (n >>> 0).toString(16).padStart(6, '0');
  g.fillStyle = hx(CANVAS_BASE); g.fillRect(0, 0, 64, 64);
  g.fillStyle = hx(CANVAS_STRIPE);
  for (let i = 0; i < 4; i++) g.fillRect(i * 16 + 4, 0, 7, 64);
  // weathering along the weave, so a flat sheet does not read as a flat sheet
  g.fillStyle = 'rgba(92,80,60,.13)';
  for (let i = 0; i < 64; i += 3) g.fillRect(0, i, 64, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ═══ types ═════════════════════════════════════════════════════ */
/**
 * @typedef {Object} MarketCfg   every field optional; every absent field a no-op
 * @property {()=>number} [stalls]     how many stalls the town carries. Default
 *           `villageFabric().stalls` — 0 / 2 / 5 / 9 by village tier.
 * @property {()=>({x:number,z:number})} [getCoinPos]  the plaza centre; origin when absent
 * @property {()=>number} [fountainR]  fountain.radius — the keep-out in the middle
 * @property {()=>number} [plazaR]     the live plaza radius
 * @property {()=>Object} [getPlan]    the street plan — read for the lane mouths ONLY
 * @property {(x:number,z:number)=>number} [sampleHeight]  env.sampleHeight; 0 when absent
 * @property {(v:THREE.Vector3, kind:string, opts?:Object)=>boolean} [say]  news.say
 * @property {(text:string)=>boolean} [announce]  npcs.announce — the Crier's mouth
 * @property {()=>boolean} [crierSpeaking]  the market waits rather than talking over him
 * @property {(p:{x:number,y:number,z:number}, opts?:Object)=>void} [celebrate]  npcs.celebrate
 * @property {(info:MarketInfo)=>void} [onOpen]   ONCE per market day, as it opens
 * @property {(info:MarketInfo)=>void} [onClose]  ONCE, as the last stall comes down
 * @property {number} [seed]      ctx.planSeed — pitch jitter, trades, awning tints
 * @property {number} [weekday]   0..6, to pin the charter day explicitly
 * @property {number} [maxAnisotropy]
 */
/**
 * @typedef {Object} MarketInfo
 * @property {number} stalls @property {number} weekday @property {string} weekdayName
 * @property {string} phase @property {number} x @property {number} y @property {number} z
 */
/**
 * @typedef {Object} Market
 * @property {THREE.Group} group
 * @property {boolean} today   is today market day at all
 * @property {boolean} up      anything standing on the square
 * @property {boolean} open    trading
 * @property {string} phase    one of MARKET_PHASES
 * @property {number} weekday @property {string} weekdayName
 * @property {number} stalls   stalls actually standing right now
 * @property {number} draws    draw calls it is costing RIGHT NOW
 * @property {()=>Array<{w:number,text:string}>} news   for news.js's `country` pool
 * @property {()=>Object} stats
 * @property {(dt:number, now:number, ctx:Object)=>void} update
 * @property {()=>void} reset @property {()=>void} dispose
 */

/**
 * Build the market and add it to the scene. Null-safe: `initMarket(null)` returns
 * a working handle that simply has no square to stand on.
 * @param {?THREE.Scene} scene
 * @param {MarketCfg} [cfg]
 * @returns {Market}
 */
export function initMarket(scene, cfg) {
  const o = cfg || {};
  const fn = (f, d) => typeof f === 'function' ? f : d;

  const stallsFn = fn(o.stalls, () => {
    try { const f = villageFabric(); return f ? f.stalls : 0; } catch (e) { return 0; }
  });
  const coinPos = fn(o.getCoinPos, null);
  const fountainRFn = fn(o.fountainR, () => 4.4);
  const plazaRFn = fn(o.plazaR, () => 12);
  const planFn = fn(o.getPlan, null);
  const heightAt = fn(o.sampleHeight, null);
  const sayFn = fn(o.say, null);
  const announceFn = fn(o.announce, null);
  const crierBusy = fn(o.crierSpeaking, () => false);
  const celebrateFn = fn(o.celebrate, null);
  const onOpen = fn(o.onOpen, null);
  const onClose = fn(o.onClose, null);

  let seed = (o.seed >>> 0) || 1;
  let rnd = stream(seed ^ 0x2f6a1b93);
  const weekday = resolveWeekday(o.weekday, Date.now());

  /* Caps. The arrays are sized ONCE at the top village tier and an epoch never
     mints geometry — only the `count` on each InstancedMesh moves. */
  const MAX_STALLS = 9, MAX_CARTS = 3, MAX_CRATES = 6;

  const geos = [], mats = [], texs = [];
  const group = new THREE.Group();
  group.name = 'market';
  group.visible = false;
  let disposed = false;

  /* ── materials. Two, and the second exists only because canvas needs a stripe.
        Everything wooden shares the vertex-coloured one. ── */
  const matWood = applyTownSurface(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: .93, metalness: 0
  }), 'prop');
  mats.push(matWood);
  const stripeTex = makeStripeTexture();
  stripeTex.anisotropy = (o.maxAnisotropy | 0) || 1;
  texs.push(stripeTex);
  const matCanvas = applyTownSurface(new THREE.MeshStandardMaterial({
    map: stripeTex, vertexColors: true, roughness: .96, metalness: 0,
    side: THREE.DoubleSide
  }), 'prop');
  mats.push(matCanvas);

  /* ── geometry, built once ─────────────────────────────────────── */
  const mk = (fill, withUV) => {
    const m = mesher(); fill(m);
    const g = m.build(withUV); geos.push(g);
    return { g, tris: m.tris };
  };
  const G_STALL = mk(stallGeo, false);
  const G_AWN = mk(awningGeo, true);
  const G_CART = mk(cartGeo, false);
  const G_CRATE = mk(crateGeo, false);
  const G_TRADER = mk(traderGeo, false);

  const PARK = new THREE.Matrix4().makeTranslation(0, -999, 0);
  function inst(part, mat, n, shadow) {
    const im = new THREE.InstancedMesh(part.g, mat, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = !!shadow; im.receiveShadow = false;
    // One object each, always within a few units of the plaza: culling five
    // bounding spheres costs more than drawing them, and mayor.js makes the same
    // call for the same reason.
    im.frustumCulled = false;
    im.count = 0; im.visible = false;
    for (let i = 0; i < n; i++) im.setMatrixAt(i, PARK);
    group.add(im);
    return im;
  }
  const mStall = inst(G_STALL, matWood, MAX_STALLS, true);
  const mAwn = inst(G_AWN, matCanvas, MAX_STALLS, true);
  const mCart = inst(G_CART, matWood, MAX_CARTS, true);
  const mCrate = inst(G_CRATE, matWood, MAX_CRATES, false);
  const mTrader = inst(G_TRADER, matWood, MAX_CARTS, false);
  const MESHES = [mStall, mAwn, mCart, mCrate, mTrader];
  const TRI_OF = [G_STALL.tris, G_AWN.tris, G_CART.tris, G_CRATE.tris, G_TRADER.tris];

  /** The awning tint belongs to the STALL, not to the instance slot it happens to
   *  occupy while the square is filling up. `setColorAt` needs USE_COLOR in the
   *  fragment, which is why both materials carry `vertexColors` AND every
   *  geometry carries a colour attribute — the instance colour multiplies it. */
  const tintOf = i => AWNING_TINTS[Math.floor(hash1(seed + i * 733 + 17) * AWNING_TINTS.length) % AWNING_TINTS.length];
  for (let i = 0; i < MAX_STALLS; i++) mAwn.setColorAt(i, _tmpC.setHex(tintOf(i)));
  if (mAwn.instanceColor) mAwn.instanceColor.needsUpdate = true;

  if (scene && scene.add) scene.add(group);

  /* ── state. All of it is either derived per frame or a once-a-day latch. ── */
  let lastNow = 0, simNow = Date.now();
  let phase = P_SHUT, wasPhase = P_SHUT, isToday = false, evening = false;
  let nStalls = 0, standing = 0;
  let openedOn = -1, closedOn = -1, shoutedOn = -1;   // day ordinals: each fires once
  let sawPre = false;              // …an honest frame BEFORE the market opened
  let layoutSig = '', poseSig = '', lastR = 8;
  let chatAt = 0, chatIdx = 0;
  let camX = 0, camZ = 62;

  /* placement, filled by relayout() and read by poseAll() */
  const sX = new Float32Array(MAX_STALLS), sZ = new Float32Array(MAX_STALLS);
  const sY = new Float32Array(MAX_STALLS), sYaw = new Float32Array(MAX_STALLS);
  const sTrade = new Array(MAX_STALLS).fill('');
  const cA = new Float32Array(MAX_CARTS);
  const crX = new Float32Array(MAX_CRATES), crZ = new Float32Array(MAX_CRATES);
  const crY = new Float32Array(MAX_CRATES), crYaw = new Float32Array(MAX_CRATES);
  const crS = new Float32Array(MAX_CRATES);
  const laneBuf = [], freeBuf = [], blockBuf = [];

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v3 = new THREE.Vector3(),
    _sc = new THREE.Vector3(), _e = new THREE.Euler();
  const _say = new THREE.Vector3();
  const INFO = { stalls: 0, weekday, weekdayName: MARKET_WEEKDAYS[weekday], phase: 'shut', x: 0, y: 0, z: 0 };

  const clock = () => lastNow || (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const centre = () => { const c = coinPos && coinPos(); return c && typeof c.x === 'number' ? c : null; };
  const cx = () => { const c = centre(); return c ? c.x : 0; };
  const cz = () => { const c = centre(); return c ? c.z : 0; };
  const plazaR = () => Math.max(8, plazaRFn() || 12);
  const fountR = () => Math.max(3.4, fountainRFn() || 4.4);
  const ground = (x, z) => { if (!heightAt) return 0; try { return heightAt(x, z) || 0; } catch (e) { return 0; } };
  const cartCount = n => n <= 0 ? 0 : clamp(1 + Math.floor((n - 1) / 4), 1, MAX_CARTS);

  /* ═══ the hour, and what the market is doing in it ═══════════════
     A pure function of the clock. There is no phase timer, no elapsed counter
     and no `dt` anywhere below this line. */
  function hourNow(now) {
    if (FORCE_DEMO) {
      const s = (H_SHUT + .6) - (H_ARRIVE - .4);
      return H_ARRIVE - .4 + ((now % DEMO_LOOP_MS) / DEMO_LOOP_MS) * s;
    }
    return HOUR_Q !== null ? HOUR_Q : hourOf(simNow);
  }
  function phaseAt(h) {
    if (h < H_ARRIVE || h >= H_SHUT) return P_SHUT;
    if (h < H_SETUP) return P_ARRIVE;
    if (h < H_OPEN) return P_SETUP;
    if (h < H_PACK) return P_OPEN;
    return P_PACK;
  }
  /** 0..1 across a window, honestly clamped at both ends. */
  const span = (h, a, b) => clamp((h - a) / Math.max(1e-4, b - a), 0, 1);

  /** How far stall `i` of `n` is up, 0..1 — staggered so the square fills in a
   *  ripple rather than all at once, and reversed for the pack-down. */
  function raiseOf(i, n, h, ph) {
    if (ph === P_OPEN) return 1;
    if (ph === P_SHUT || ph === P_ARRIVE) return 0;
    const STAG = .55, off = n > 1 ? (i / (n - 1)) * STAG : 0;
    if (ph === P_SETUP) return smooth(clamp(span(h, H_SETUP, H_OPEN) * (1 + STAG) - off, 0, 1));
    return smooth(1 - clamp(span(h, H_PACK, H_SHUT) * (1 + STAG) - (STAG - off), 0, 1));
  }
  /** How far cart `i` has come in: 0 out on the lane, 1 standing on the square. */
  function cartAt(i, nc, h, ph) {
    if (ph === P_SETUP || ph === P_OPEN) return 1;
    if (ph === P_ARRIVE) {
      const STAG = .40, off = nc > 1 ? (i / (nc - 1)) * STAG : 0;
      return smooth(clamp(span(h, H_ARRIVE, H_SETUP) * (1 + STAG) - off, 0, 1));
    }
    if (ph === P_PACK) {
      // loaded first, and away down the lane over the last of the window
      const STAG = .35, off = nc > 1 ? (i / (nc - 1)) * STAG : 0;
      return smooth(1 - clamp(span(h, H_PACK + (H_SHUT - H_PACK) * .55, H_SHUT) * (1 + STAG) - off, 0, 1));
    }
    return 0;
  }

  /* ═══ where the market stands ═══════════════════════════════════
     The stalls go in a ring around the fountain, FACING IN, so the aisle is the
     open ground between the kerb and the counters — which is how a market square
     actually works, and what makes it walkable at eye level.

     THEY MAY NOT STAND IN A LANE MOUTH. `plan.graph` carries the plaza's hub
     ring; the hub nodes with a street hanging off them are the ways in, and a
     stall parked across one blocks the square. Those bearings are blocked out,
     the free arcs are what is left, and the stalls are laid evenly along the
     CONCATENATED free ground — so the only gaps in the finished ring are the
     lanes themselves. If the lanes leave too little room the keep-out narrows
     toward a hard floor of half a road: a crowded market is right, a stall
     standing in the road is not. */
  function laneBearings(out) {
    out.length = 0;
    if (!planFn) return out;
    let plan = null;
    try { plan = planFn(); } catch (e) { return out; }
    if (!plan) return out;
    const g = plan.graph;
    if (g && g.nodes && g.edges) {
      for (const n of g.nodes) {
        if (!n || !n.hub || !n.adj) continue;
        for (const ei of n.adj) {
          const e = g.edges[ei];
          if (!e) continue;
          const other = g.nodes[e.a === n.i ? e.b : e.a];
          if (other && !other.hub) { out.push(Math.atan2(n.z, n.x)); break; }
        }
      }
    }
    // the main road out is a lane whether or not the graph agrees
    if (plan.gate && typeof plan.gate.x === 'number') out.push(Math.atan2(plan.gate.z, plan.gate.x));
    return out;
  }

  /**
   * The complement of the blocked sectors, as flat [start, length, …] radians.
   * Walks the circle once from the end of the first block and collects the gaps;
   * an interval that runs past TAU simply keeps running, which is what makes the
   * wrap-around free of special cases.
   */
  function freeArcs(bearings, hw, out) {
    out.length = 0;
    if (!bearings.length) { out.push(0, TAU); return out; }
    blockBuf.length = 0;
    for (const b of bearings) blockBuf.push(((b - hw) % TAU + TAU) % TAU);
    blockBuf.sort((a, b) => a - b);
    const L = 2 * hw, n = blockBuf.length;
    let cursor = blockBuf[0] + L;
    for (let i = 1; i <= n; i++) {
      const s = i < n ? blockBuf[i] : blockBuf[0] + TAU;
      if (s - cursor > 1e-3) out.push(cursor % TAU, s - cursor);
      const e = s + L;
      if (e > cursor) cursor = e;
      if (cursor >= blockBuf[0] + TAU) break;
    }
    return out;
  }

  /** Rebuild the placement. Runs on a structural change, never per frame. */
  function relayout(n) {
    const ox = cx(), oz = cz(), pR = plazaR(), fR = fountR();
    // The ring: outside the fountain's paved apron and the mayor's mark, and
    // growing with the market — nine stalls need more circumference than two.
    // The 9.9 ceiling is not arbitrary: town.js stands four plaza benches at
    // R = 10.6, and this module cannot see them, so the market keeps just inside.
    const R = clamp(fR + 3.2 + n * .28, 7.4, Math.max(7.6, Math.min(pR - 1.6, 9.9)));
    lastR = R;

    laneBearings(laneBuf);
    const PITCH = ST_W + .95;                       // a stall plus the gap beside it
    // THE KEEP-OUT, and the two numbers that make the ring look right.
    // It starts honest — half the widest road, half a stall and a margin, i.e.
    // enough for a cart to get past — and narrows under pressure down to a hard
    // floor of half a road, which a stall may never cross.
    const hwMin = Math.atan2(2.2, R);
    let hw = Math.max(hwMin, Math.atan2(4.5, R));
    let arcs = freeArcs(laneBuf, hw, freeBuf);
    for (let t = 0; t < 8 && hw > hwMin; t++) {
      let room = 0;
      for (let i = 1; i < arcs.length; i += 2) if (arcs[i] * R >= PITCH) room += arcs[i] * R;
      // 2.2×, not 1×: stopping the moment the TOTAL was sufficient let one wide
      // arc satisfy the whole market on its own, and the square photographed as
      // five stalls huddled on the east side with 250° of empty cobbles. Room has
      // to be COMFORTABLE before the keep-out stops narrowing, which is what
      // opens up the arcs either side of a cluster of lanes and spreads the ring
      // out between them instead of pouring it into the first gap that fits.
      if (room >= n * PITCH * 2.2) break;
      hw = Math.max(hwMin, hw * .82);
      arcs = freeArcs(laneBuf, hw, freeBuf);
    }
    // Only arcs wide enough to hold a stall count as ground; if the lanes have
    // eaten everything, the widest arc takes the lot.
    const cand = [];
    for (let i = 0; i < arcs.length; i += 2) if (arcs[i + 1] * R >= PITCH) cand.push(arcs[i], arcs[i + 1]);
    if (!cand.length) {
      let best = -1, bi = -1;
      for (let i = 1; i < arcs.length; i += 2) if (arcs[i] > best) { best = arcs[i]; bi = i - 1; }
      if (bi >= 0) cand.push(arcs[bi], arcs[bi + 1]); else cand.push(0, TAU);
    }
    // LAY THEM OUT ALONG THE FREE GROUND, not arc by arc. Concatenating the free
    // arcs into one line and spacing the stalls evenly along THAT is what makes
    // the market read as a ring with the ways in left open, instead of a huddle
    // in whichever arc a proportional share happened to favour. The only gaps in
    // the finished ring are the lanes, which is the whole idea.
    let total = 0;
    for (let i = 1; i < cand.length; i += 2) total += cand[i];
    for (let w = 0; w < n; w++) {
      let t = ((w + .5) / n) * total, k = 0;
      while (k < cand.length - 2 && t > cand[k + 1]) { t -= cand[k + 1]; k += 2; }
      const a = cand[k] + Math.min(t, cand[k + 1]);
      const x = ox + Math.cos(a) * R, z = oz + Math.sin(a) * R;
      sX[w] = x; sZ[w] = z; sY[w] = ground(x, z);
      // facing the fountain, with a little jitter so the ring is not a dial
      sYaw[w] = faceOf(ox - x, oz - z) + (hash1(seed + w * 37) - .5) * .16;
      sTrade[w] = TRADES[Math.floor(hash1(seed + w * 151 + 5) * TRADES.length) % TRADES.length];
    }
    standing = n;

    // carts park on the lanes they came in on, just outside the square
    const nc = cartCount(n);
    for (let i = 0; i < nc; i++)
      cA[i] = laneBuf.length ? laneBuf[(i * 3 + 1) % laneBuf.length] : (i / Math.max(1, nc)) * TAU + .7;
    // loose crates, stacked where the carts unload
    for (let i = 0; i < MAX_CRATES; i++) {
      const a = (nc ? cA[i % nc] : .7) + (hash1(seed + i * 91) - .5) * .40;
      const r = Math.max(R + 1.5, pR - 1.9) - hash1(seed + i * 61) * 1.6;
      const x = ox + Math.cos(a) * r, z = oz + Math.sin(a) * r;
      crX[i] = x; crZ[i] = z; crY[i] = ground(x, z);
      crYaw[i] = hash1(seed + i * 13) * TAU;
      crS[i] = .82 + hash1(seed + i * 29) * .40;
    }
  }

  /* ═══ posing ════════════════════════════════════════════════════
     Everything below is derived from the hour and the placement arrays; nothing
     is remembered between frames except the signature that says whether the
     matrices are worth rewriting. In the eight hours the market is simply OPEN
     the signature never moves, so this runs once and then not again. */
  function place(mesh, i, x, y, z, yaw, sx, sy, sz, pitch) {
    _v3.set(x, y, z);
    _e.set(pitch || 0, yaw, 0, 'YXZ');              // yaw first, then tip on the axle
    _q.setFromEuler(_e);
    _sc.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    _m.compose(_v3, _q, _sc);
    mesh.setMatrixAt(i, _m);
  }
  function setCount(mesh, k) {
    mesh.count = k;
    mesh.visible = k > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  function poseAll(h, ph, n) {
    const nc = cartCount(n), pR = plazaR(), ox = cx(), oz = cz();
    let sUp = 0, aUp = 0, cUp = 0, tUp = 0, krUp = 0;

    for (let i = 0; i < standing; i++) {
      const k = raiseOf(i, standing, h, ph);
      if (k <= .01) continue;
      // the frame goes up first; the canvas is thrown over it afterwards and
      // unrolls along the counter rather than growing out of the ground
      const kf = smooth(clamp(k * 1.45, 0, 1));
      const kc = smooth(clamp((k - .34) * 1.6, 0, 1));
      place(mStall, sUp, sX[i], sY[i], sZ[i], sYaw[i], 1, kf, 1);
      sUp++;
      if (kc > .02) {
        place(mAwn, aUp, sX[i], sY[i], sZ[i], sYaw[i], kc, kf, 1);
        mAwn.setColorAt(aUp, _tmpC.setHex(tintOf(i)));
        aUp++;
      }
    }
    for (let i = 0; i < nc; i++) {
      const p = cartAt(i, nc, h, ph);
      if (p <= .005) continue;
      // Parked just INSIDE the square at its lane mouth: a cart left out on the
      // verge is invisible from the framing the plaza is actually photographed
      // at, and a market's carts belong on the square they unloaded onto.
      //
      // The approach is DELIBERATELY SHORT. This module has no street graph —
      // the cart travels a straight radial line down the lane's bearing, which
      // is true near the mouth and a guess further out, where it would sooner or
      // later drive through somebody's kitchen. Eleven units past the plaza edge
      // is the last of the open approach and also the last of what the plaza
      // framing can actually see, so the whole arrival happens on screen.
      const a = cA[i], rFar = pR + 11, rPark = Math.max(lastR + 1.7, pR - 1.6);
      const r = rFar + (rPark - rFar) * p;
      // a hand's width off the lane's centreline: a cart shares the road, it does
      // not stand in the middle of it
      const x = ox + Math.cos(a) * r - Math.sin(a) * 1.05;
      const z = oz + Math.sin(a) * r + Math.cos(a) * 1.05;
      const y = ground(x, z);
      const yaw = faceOf(-Math.cos(a), -Math.sin(a));     // nose toward the square
      // shafts level while it is being drawn, down once it is standing
      const tip = .26 * smooth(clamp((p - .92) / .08, 0, 1));
      place(mCart, cUp, x, y + WHEEL_R * CART_S, z, yaw, CART_S, CART_S, CART_S, tip);
      cUp++;
      if (p > .015 && p < .985) {                          // …and somebody pulling it
        const bob = Math.abs(Math.sin(clock() / 300 + i * 2)) * .035;
        const tx = x - Math.sin(a) * 1.15, tz = z + Math.cos(a) * 1.15;
        place(mTrader, tUp, tx, ground(tx, tz) + bob, tz, yaw, 1.12);
        tUp++;
      }
    }
    // crates come off the carts during set-up and go back on during pack-down
    const kCr = ph === P_SETUP ? span(h, H_SETUP, H_SETUP + .35)
      : ph === P_OPEN ? 1
        : ph === P_PACK ? 1 - span(h, H_PACK, H_PACK + (H_SHUT - H_PACK) * .5) : 0;
    if (kCr > .02 && nc > 0) {
      const want = Math.round(kCr * MAX_CRATES * clamp(n / MAX_STALLS, .34, 1));
      for (let i = 0; i < Math.min(MAX_CRATES, want); i++) {
        place(mCrate, krUp, crX[i], crY[i], crZ[i], crYaw[i], crS[i]);
        krUp++;
      }
    }

    setCount(mStall, sUp); setCount(mAwn, aUp); setCount(mCart, cUp);
    setCount(mCrate, krUp); setCount(mTrader, tUp);
    if (mAwn.instanceColor) mAwn.instanceColor.needsUpdate = true;
    group.visible = (sUp + aUp + cUp + krUp + tUp) > 0;
  }

  function hideAll() {
    for (const m of MESHES) { m.count = 0; m.visible = false; }
    group.visible = false;
    standing = 0;
    layoutSig = ''; poseSig = '';
  }

  /* ═══ what it says ══════════════════════════════════════════════ */
  const cursors = Object.create(null);
  function pickLine(cat) {
    const pool = RAW[cat];
    if (!pool || !pool.length) return '';
    let s = cursors[cat];
    if (!s || s.order.length !== pool.length) {
      s = cursors[cat] = { order: new Int32Array(pool.length), i: pool.length };
      for (let i = 0; i < pool.length; i++) s.order[i] = i;
    }
    if (s.i >= pool.length) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1)), t = s.order[i];
        s.order[i] = s.order[j]; s.order[j] = t;
      }
      s.i = 0;
    }
    return pool[s.order[s.i++]];
  }

  /** news.js's `country` contract: weighted lines mixed into the ambient pool.
   *  Empty every day but market day — which is the whole point of a weekly
   *  rhythm. The Gazette must not be able to talk about a market that is not
   *  happening. */
  const NEWS_OUT = [];
  function newsLines() {
    NEWS_OUT.length = 0;
    if (nStalls <= 0) return NEWS_OUT;
    if (!isToday) {
      if (evening) NEWS_OUT.push({ w: 2, text: pickLine('EVE') });
      return NEWS_OUT;
    }
    const cat = phase === P_ARRIVE ? 'ARRIVING' : phase === P_SETUP ? 'SETUP'
      : phase === P_OPEN ? 'OPEN' : phase === P_PACK ? 'PACKING' : '';
    if (!cat) return NEWS_OUT;
    // weighted to own the ticker while trade is on, the way a rare event does,
    // and to step back to a murmur while the square is only setting up
    NEWS_OUT.push({ w: phase === P_OPEN ? 7 : 4, text: pickLine(cat) });
    return NEWS_OUT;
  }

  /** A stall-holder speaks over their own counter. Refusals are normal — news.js
   *  runs two bubbles at a time — and are retried on a wall-clock cadence. */
  function chatter(now) {
    if (!sayFn || phase !== P_OPEN || standing <= 0) return;
    if (now - chatAt < CHAT_EVERY) return;
    let busy = false;
    try { busy = !!crierBusy(); } catch (e) { busy = false; }
    if (busy) { chatAt = now - CHAT_EVERY + CHAT_RETRY; return; }
    // start from the stall nearest the camera: it has the best chance of being
    // both on screen and legible, and the cursor walks on from there
    let best = 0, bd = Infinity;
    for (let i = 0; i < standing; i++) {
      const d = (sX[i] - camX) * (sX[i] - camX) + (sZ[i] - camZ) * (sZ[i] - camZ);
      if (d < bd) { bd = d; best = i; }
    }
    const i = (best + chatIdx) % standing;
    chatIdx = (chatIdx + 1) % standing;
    let ok = false;
    try {
      ok = !!sayFn(_say.set(sX[i], sY[i] + ST_TOP + .25, sZ[i]), 'market', {
        text: pickLine('CHATTER'), who: sTrade[i], ttl: 5200
      });
    } catch (e) { ok = false; }
    chatAt = ok ? now : now - CHAT_EVERY + CHAT_RETRY;
  }

  function fillInfo() {
    INFO.stalls = standing; INFO.phase = MARKET_PHASES[phase];
    INFO.x = cx(); INFO.z = cz(); INFO.y = ground(INFO.x, INFO.z);
    return INFO;
  }

  /* ═══ update ════════════════════════════════════════════════════ */
  /**
   * @param {number} dt   seconds — deliberately unread; see rule 1
   * @param {number} now  performance.now()
   * @param {Object} ctx  the per-frame town context
   */
  function update(dt, now, ctx) {
    if (disposed) return;
    lastNow = now = (typeof now === 'number' && now > 0) ? now
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (ctx) {
      if (typeof ctx.simNow === 'number' && ctx.simNow > 0) simNow = ctx.simNow;
      const cam = ctx.camera;
      if (cam && cam.position) { camX = cam.position.x; camZ = cam.position.z; }
      // A new epoch is a new town: new tints, new trades, new pitch jitter. The
      // charter weekday is NOT re-minted — that is the one thing about this
      // market that outlives the town it stands in.
      const ps = (ctx.planSeed >>> 0) || 0;
      if (ps && ps !== seed) {
        seed = ps; rnd = stream(seed ^ 0x2f6a1b93);
        for (const k in cursors) delete cursors[k];
        for (let i = 0; i < MAX_STALLS; i++) mAwn.setColorAt(i, _tmpC.setHex(tintOf(i)));
        layoutSig = ''; poseSig = '';
      }
    }

    const h = hourNow(now);
    const dayIdx = dayIndexOf(simNow);
    const dow = new Date(simNow).getDay();
    let want = 0;
    try { want = clamp(Math.round(stallsFn() || 0), 0, MAX_STALLS); } catch (e) { want = 0; }
    nStalls = want;
    isToday = !FORCE_OFF && want > 0 && (FORCE_DAY || dow === weekday);
    // the eve line exists only on the night before a market the town can hold
    evening = !FORCE_OFF && want > 0 && h >= 18 && ((dow + 1) % 7) === weekday;

    phase = !isToday ? P_SHUT : FORCE_PHASE >= 0 ? FORCE_PHASE : phaseAt(h);
    if (phase !== P_OPEN && phase !== P_PACK) sawPre = true;

    if (phase === P_SHUT) {
      if (wasPhase !== P_SHUT) {
        hideAll();
        if (onClose && closedOn !== dayIdx) {
          closedOn = dayIdx;
          try { onClose(fillInfo()); } catch (e) { /* a listener must never stall the town */ }
        }
      }
      wasPhase = phase;
      return;
    }

    // Relayout only when the SHAPE of the square changed. The plaza breathes with
    // the fountain's tier, so this is a handful of rebuilds a session and exactly
    // zero per frame in steady state.
    const sig = want + '|' + Math.round(plazaR() * 4) + '|' + Math.round(fountR() * 8) +
      '|' + Math.round(cx()) + ',' + Math.round(cz());
    if (sig !== layoutSig) { layoutSig = sig; poseSig = ''; relayout(want); }

    // …and repose only when something is actually moving. Trade is eight hours of
    // a completely static square.
    const pSig = phase === P_OPEN ? 'open|' + standing + '|' + layoutSig
      : phase + '|' + standing + '|' + Math.round(h * 7200) + '|' + layoutSig;
    if (pSig !== poseSig) { poseSig = pSig; poseAll(h, phase, want); }

    // ── the day's announcements, each at most once per calendar day ──
    if (phase === P_OPEN && openedOn !== dayIdx) {
      openedOn = dayIdx;
      const info = fillInfo();
      // CEREMONY IS EARNED BY BEING WATCHED, exactly as the mayor's is: the crowd
      // only turns out and the Crier only shouts when the market opened while
      // somebody was looking. A window opened at noon just has a market in it.
      if (sawPre && celebrateFn) {
        try { celebrateFn({ x: info.x, y: 0, z: info.z }, { cheerRadius: Math.max(10, lastR + 2), runners: 4 }); }
        catch (e) { /* ignore */ }
      }
      if (!sawPre) shoutedOn = dayIdx;
      if (onOpen) { try { onOpen(info); } catch (e) { /* ignore */ } }
    }
    if (phase === P_OPEN && announceFn && shoutedOn !== dayIdx) {
      let busy = false;
      try { busy = !!crierBusy(); } catch (e) { busy = false; }
      if (!busy) {
        let said = false;
        // No imperative, for the reason the CHATTER pool carries: the Crier is
        // shouting at the town, and a bare imperative can be read as shouted at
        // the person watching it.
        try { said = !!announceFn('Market day! Stalls up on the square, and a goat loose among them!'); }
        catch (e) { said = false; }
        if (said) shoutedOn = dayIdx;
      }
    }
    chatter(now);
    wasPhase = phase;
  }

  /* ═══ epoch reset ═══════════════════════════════════════════════ */
  function reset() {
    hideAll();
    phase = wasPhase = P_SHUT;
    isToday = evening = false;
    openedOn = closedOn = shoutedOn = -1;
    sawPre = false;
    chatAt = 0; chatIdx = 0;
    for (const k in cursors) delete cursors[k];
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    hideAll();
    if (group.parent) group.parent.remove(group);
    for (const m of MESHES) m.dispose();
    group.clear();
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    geos.length = 0; mats.length = 0; texs.length = 0;
    if (typeof window !== 'undefined' && window.__marketStats === api.stats) delete window.__marketStats;
  }

  const api = {
    group,
    get today() { return isToday; },
    get up() { return group.visible; },
    get open() { return isToday && phase === P_OPEN; },
    get phase() { return MARKET_PHASES[phase]; },
    get weekday() { return weekday; },
    get weekdayName() { return MARKET_WEEKDAYS[weekday]; },
    get stalls() { return standing; },
    /** Draw calls it is costing this frame — 0 when the square is empty. */
    get draws() { let d = 0; for (const m of MESHES) if (m.visible && m.count > 0) d++; return d; },
    news: newsLines,
    /** Live cost and state, for --bench and the verification harnesses. */
    stats() {
      let tri = 0, draws = 0;
      for (let i = 0; i < MESHES.length; i++) {
        if (!MESHES[i].visible || MESHES[i].count <= 0) continue;
        draws++; tri += MESHES[i].count * TRI_OF[i];
      }
      return {
        phase: MARKET_PHASES[phase], today: isToday, weekday: MARKET_WEEKDAYS[weekday],
        stalls: standing, wanted: nStalls, triangles: tri, draws,
        per: { stall: TRI_OF[0], awning: TRI_OF[1], cart: TRI_OF[2], crate: TRI_OF[3], trader: TRI_OF[4] }
      };
    },
    update, reset, dispose
  };
  // the same hook npcs.js hangs its census on, for the acceptance harnesses
  if (typeof window !== 'undefined') window.__marketStats = api.stats;
  return api;
}
