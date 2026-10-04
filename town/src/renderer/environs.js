// Token Town — the countryside. environs owns everything outside the last house:
// the ground it stands on, the fields, the horizon, the water and the weather.
//
// "Empty" is not fixed with more grass or a bigger fog number. It is fixed with
//   (1) a FADE keyed to the TOWN'S OWN RADIUS — the ground is literally painted
//       the live fog colour by the rim, so the eye is pulled inward and the edge
//       of the world is mathematically unseeable, and
//   (2) CONTENT — the ring just past the last house has to be farmed. Bands are
//       multiples of the town's extent, so the countryside is never bigger than
//       the town deserves and can never dwarf it.
// Everything out here is a matte, not a subject: nothing beyond the verge may
// outrank the town in brightness, saturation or motion.
//
// Budget, contractual: EIGHT draw calls (seven when the plan is dry) — ground,
// veil, water, fields, blades, flora, sky (clouds AND birds), motes. ZERO lights,
// castShadow=false on everything, receiveShadow on the ground alone.
//
// THE LANE IS ALSO OURS, even though the mesh is not. The road plate is town.js's
// mesh and layout.js's canvas, but its material is minted through surface.js's
// 'ground' role, so what a lane is MADE of — dirt, gravel or the tier's cobbles,
// its ruts, the mud at its gateways, the puddles after rain, the dust in August
// and the January that finally reaches it — is written from here as four uniforms
// and drawn there. See stepLane() and surface.js's fragLane(). Zero draw calls,
// zero geometry, and the countryside and the road can no longer disagree about
// the weather or the month.
//
// AND SO IS THE WEATHER ON THE TOWN. The same function writes SURF.uTownWx —
// wet, settled snow, rime — which surface.js's 'building' and 'prop' roles read.
// Before that the road was the only surface in the app that could tell it was
// raining: it could be pouring on the lane and dry on the roof six inches above
// it, and a snow day whitened the tracks and left every roof in August. environs
// is the right owner because it is already holding the weather bus AND the
// season, and because it is the only module that can make the land, the lane and
// the roofs agree with each other in one place. Still zero draw calls, still zero
// geometry, still one uniform write per frame.
//
// environs does NOT own scene.fog. core sets its colour from the sky's bottom
// stop and weather applies the single tint; out here it is read-only input. What
// environs does own is the far-land colour it fades to — see landFar().
//
// `dt` is never read. Every moving thing is parametric on one wall-clock uTime,
// so a 1 fps headless shot shows clouds, birds and fireflies where they actually
// belong instead of bunched at spawn.
//
// THE SEASON IS A PROPERTY OF THE LAND, NOT A FILTER OVER THE PICTURE. Every
// seasonal effect out here is albedo — grass and stubble uniforms, per-instance
// canopy colour, a per-instance crown deform, one extra mix in the ground
// fragment for litter or rime. Nothing is graded on top of the frame (postfx
// owns that), nothing touches scene.fog (weather owns that), and the whole model
// is resolved on the CPU once per epoch: the PER-FRAME cost of seasons is zero
// and the draw-call budget is still eight. See seasonFor().
import * as THREE from './vendor/three.module.js';
// weather.js is THE calendar authority: it owns the hemisphere flip, the
// `--season=` pin and `coldness`. Importing its one pure function is what stops
// the countryside and the sky disagreeing about what month it is. (Pure, no
// side effects, no cycle — weather.js imports nothing but three.)
import { seasonOf } from './weather.js';
// THE LANE IS THE COUNTRYSIDE'S BUSINESS, and these two imports are what let it
// say so without owning a pixel of the road plate. The plate's mesh is town.js's
// and its canvas is layout.js's, but the MATERIAL is minted through surface.js's
// 'ground' role, so writing SURF's four uLane* uniforms from here is the whole of
// the wiring — no hook in a file this module does not own.
//   The village FABRIC (`lane`, `laneColor`) is buildings.js's, and this module
// used to import it directly. It is handed in through `opts.fabric` instead:
// the renderer's feature modules do not import each other laterally — town.js
// mediates — and a static import is a LINK-TIME dependency, unguardable, on a
// file that is routinely under rewrite. A getter costs nothing and cannot take
// the countryside down with it.
import { SURF } from './surface.js';

/* ═══ small helpers (no imports: this file is the countryside, whole) ═══ */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, k) => a + (b - a) * k;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
/** mulberry32 — deterministic, cheap, and the only randomness out here. */
function rngOf(seed) {
  let a = (seed >>> 0) || 0x9E3779B9;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const h2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {                       // bilinear value noise, smoothstepped
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h2(xi, yi), h2(xi + 1, yi), u), lerp(h2(xi, yi + 1), h2(xi + 1, yi + 1), u), v);
}
const fbm2 = (x, y) => vnoise(x, y) * .6 + vnoise(x * 2.07 + 11.7, y * 2.07 - 4.1) * .27 + vnoise(x * 4.13 - 3.3, y * 4.13 + 9.2) * .13;
const hex = h => new THREE.Color(h);

/* ═══ biomes ════════════════════════════════════════════════════
   A biome is a 22 %-at-most nudge off the base art direction: enough that two
   mornings are different weather, never enough that one of them is a new game. */
const BIO = (id, label, w, o) => Object.freeze(Object.assign({
  id, label, w, grass: 0x5C6B3C, fields: [0x8E9A57, 0xB6A45E, 0x7C8B4C, 0xC7B06A],
  tree: 0x4A5E36, fogTint: 0xC2CFD6, fogMul: 1, clouds: 1, wind: 1, mote: 0xE9EFC0
}, o));

/**
 * @typedef {Object} Biome
 * @property {string} id 'lush'|'goldrush'|'misty'|'heather'|'spring'
 * @property {string} label 'verdant'|'late summer'|'morning mist'|'heath'|'new green'
 * @property {number} grass @property {number[]} fields @property {number} tree
 * @property {number} fogTint @property {number} fogMul @property {number} clouds
 * @property {number} wind @property {number} mote
 */
/** @type {Object<string,Biome>} */
export const BIOMES = Object.freeze({
  lush: BIO('lush', 'verdant', .30, {
    grass: 0x55693A, fields: [0x7F9350, 0x9AA95C, 0x6E8547, 0xB3AE68], tree: 0x3F5B31,
    fogTint: 0xC2CFD6, clouds: 1, mote: 0xE9EFC0
  }),
  goldrush: BIO('goldrush', 'late summer', .25, {
    grass: 0x6C6C3E, fields: [0xC9AE5F, 0xB59A4E, 0xA9A257, 0xD8C177], tree: 0x5A6034,
    fogTint: 0xD8C79E, fogMul: 1.05, clouds: .82, mote: 0xF3E0A0
  }),
  misty: BIO('misty', 'morning mist', .15, {
    grass: 0x4E6146, fields: [0x778B62, 0x8C9A6A, 0x6B7F58, 0x9EA97A], tree: 0x3B5340,
    fogTint: 0xC8D2D8, fogMul: 1.35, clouds: 1.3, mote: 0xDCE8E4
  }),
  // Heather is a HEATH, not a mudflat. The old grey-olive base (0x5B5A50) had
  // almost no chroma, and paired with two mauve field entries it produced a
  // desaturated frame with lavender scribbles in it that read as dead pixels.
  // Deep purple-leaning green, fields warmed to dusty rose and ochre.
  heather: BIO('heather', 'heath', .15, {
    grass: 0x4E5A43, fields: [0x8C7A60, 0x9E8B66, 0x77704F, 0xA98A8A], tree: 0x445039,
    fogTint: 0xC8C2BA, clouds: 1.1, mote: 0xE8DCC8
  }),
  spring: BIO('spring', 'new green', .15, {
    grass: 0x62783E, fields: [0x8FA855, 0xA8BC63, 0x7C9748, 0xC2CE79], tree: 0x47693A,
    fogTint: 0xCBD8CE, clouds: .9, mote: 0xF0F6C8
  })
});

/* ═══ THE SEASON ═══════════════════════════════════════════════════
   A season is not four states with three crossfades. It is NINE independent
   scalars, each a smooth function of one phase angle around the year, and the
   land is the sum of them. That is what makes the turn arrive gradually rather
   than snapping over on the 1st: on 12 October `turn` is 0.71, `litter` is 0.04
   and `leaf` is still 1, which is exactly what the second week of October looks
   like — and there is no date on which any of them jumps.

   NOTHING HERE IS READ PER FRAME. Every scalar is resolved once, on setSeed,
   and spent immediately into uniforms and per-instance attributes; update() only
   reads `bleak` for the far-land tone. A season therefore costs zero draw calls,
   zero allocations and no measurable CPU — see the note on the flora deform.

   `q` is 0 at the vernal equinox, 0.25 at midsummer, 0.5 at the autumn equinox,
   0.75 at midwinter — weather.js's `season.t`, which is already flipped for the
   southern hemisphere. Every window below is quoted in real dates so the numbers
   can be argued with. */
const wrap1 = x => x - Math.floor(x);
/** A smooth periodic hump: 1 at `c`, 0 at ±`w`, C1 at both ends. */
function bump(q, c, w) {
  let d = wrap1(q - c); if (d > .5) d -= 1;
  d = Math.abs(d) / w; if (d >= 1) return 0;
  const k = 1 - d * d; return k * k;
}
// The canopy windows, shared by seasonFor and by repark (which re-evaluates them
// per tree with a phase offset, so no two oaks strip on the same afternoon).
const LEAF_ON0 = .010, LEAF_ON1 = .150;    // 24 Mar → 12 May   bud burst → full canopy
const LEAF_OFF0 = .575, LEAF_OFF1 = .678;  // 16 Oct → 20 Nov   first fall → bare
const TURN0 = .497, TURN1 = .600;          // 20 Sep → 26 Oct   green → full colour
const TURN2 = .700, TURN3 = .800;          // 30 Nov →  8 Jan   the last colour goes

/**
 * @typedef {Object} Season
 * @property {string} id 'spring'|'summer'|'autumn'|'winter'   @property {string} label
 * @property {number} q 0..1 phase; 0 = vernal equinox
 * @property {number} cold 0 (midsummer) … 1 (midwinter)
 * @property {number} leaf    canopy fullness — 1 May–Oct, 0 Dec–Mar
 * @property {number} turn    how far the canopy has gone over to autumn colour
 * @property {number} litter  leaves down on the ground
 * @property {number} blossom late April / early May
 * @property {number} fresh   the acid new green of April–May
 * @property {number} dry     high-summer parching, peak 11 Aug
 * @property {number} bleak   the broad Nov–Mar cold: dull grass, pale distance
 * @property {number} frost   the narrow Dec–Feb rime
 * @property {number} hay     how full of haystacks the fields are, Jul–Mar
 */

/* `--season=<name>`: the SAME flag weather.js reads, parsed the same way, and
   the only test hook out here. Each name maps to the day of the year on which
   that season is most itself — 30 April, 11 August, 26 October, 16 January. */
const SEASON_PIN = (() => {
  try { return new URLSearchParams((typeof location !== 'undefined' && location.search) || '').get('season'); }
  catch (e) { return null; }
})();
const PIN_Q = Object.freeze({ spring: .105, summer: .395, autumn: .600, winter: .820 });

/** The calendar day `daySeed` (YYYYMMDD) names, at noon — the same rule
 *  weather.js uses, so the sky and the fields never disagree about the month.
 *  A `--seed=` override that is not a real date falls back to the wall clock. */
function seedDate(daySeed) {
  const s = daySeed >>> 0, y = (s / 10000) | 0, m = ((s / 100) | 0) % 100, d = s % 100;
  if (y >= 1970 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(y, m - 1, d, 12).getTime();
  return Date.now();
}

/**
 * The year, as the land sees it. PURE.
 * @param {number} daySeed YYYYMMDD @param {?number} lat southern latitudes flip it
 * @returns {Season}
 */
export function seasonFor(daySeed, lat) {
  const s = seasonOf(seedDate(daySeed), lat);
  let q = s.t;
  // `--season=` pins the quarter inside weather.js but deliberately leaves `t`
  // on the real calendar, so a pinned sky still has a real sun. Foliage cannot
  // live with that — a pinned autumn in August would blend to full summer leaf —
  // so the SAME flag, read the same way, moves the land's phase outright. It
  // lands on the day that season is most itself and NOT on the quarter's centre:
  // weather's quarters are equinox-centred, so `autumn` would otherwise mean the
  // 22nd of September, on which not one leaf has turned.
  if (SEASON_PIN && PIN_Q[SEASON_PIN] !== undefined) q = PIN_Q[SEASON_PIN];
  const cold = .5 + .5 * Math.cos((q + .25) * TAU);
  return Object.freeze({
    id: s.id, label: s.label, q, cold,
    leaf: smooth(LEAF_ON0, LEAF_ON1, q) * (1 - smooth(LEAF_OFF0, LEAF_OFF1, q)),
    turn: smooth(TURN0, TURN1, q) * (1 - smooth(TURN2, TURN3, q)),
    litter: smooth(.552, .660, q) * (1 - smooth(.720, .880, q)),   // 11 Oct → 17 Nov, gone by late Feb
    blossom: bump(q, .100, .058),                                  // 10 Apr → 20 May, peak 30 Apr
    fresh: smooth(.005, .070, q) * (1 - smooth(.170, .310, q)),    // late Mar → early Jul
    dry: bump(q, .395, .118),                                      //  1 Jul → 20 Sep, peak 11 Aug
    bleak: bump(q, .820, .190),                                    //  3 Nov → 20 Mar, peak mid-Jan
    frost: bump(q, .815, .135),                                    //  1 Dec → 25 Feb
    // Hay is stacked after the harvest and EATEN through the winter, so the
    // stacks fill the fields across July and are down to a few by February. Used
    // as a per-instance probability, so they arrive and go a few at a time.
    hay: smooth(.300, .380, q) * (1 - smooth(.700, .935, q))
  });
}

/* Which kinds of day belong to which part of the year. Keyed to the DRIVERS,
   not to the quarter: "late summer" is a thing that happens when the land is
   parched, which is the second week of August and not the third week of June,
   and the equinox-centred quarters cannot say that. The biome is still only a
   22 % nudge off the art direction — this decides how OFTEN each one comes up,
   never what it looks like — and every weight keeps a floor, so no kind of day
   is ever impossible, only unlikely. The biome rolled here is the one weather.js
   grades its rain off, so the sky agrees about the month for free. */
const seasonWeight = (id, S) => {
  switch (id) {
    case 'lush': return 1.00 + .45 * S.leaf - .30 * S.bleak;
    case 'goldrush': return .25 + 2.00 * S.dry;
    // Mist is the winter and late-autumn weather. Heather is a HEATH and its
    // field list is dusty rose and ochre — warm — so it belongs to the autumn
    // moor and not to January, where it reads as dust rather than as cold.
    case 'misty': return .55 + 1.10 * S.turn + 1.40 * S.bleak;
    case 'heather': return .65 + .85 * S.turn + .35 * S.bleak;
    case 'spring': return .25 + 2.10 * S.fresh;
    default: return 1;
  }
};

/** Today's weather, from the calendar date alone. `wind` is an independent roll.
 *  With no `season` the distribution and the rng draw order are exactly what
 *  they were, so a one-argument call is byte-for-byte the old behaviour.
 *  @param {number} daySeed YYYYMMDD @param {?Season} season @returns {Biome} */
export function biomeFor(daySeed, season) {
  const r = rngOf((daySeed >>> 0) * 2654435761 + 7);
  const x0 = r();
  const list = Object.values(BIOMES), w = [];
  let tot = 0;
  for (const b of list) {
    const k = season ? Math.max(seasonWeight(b.id, season), .15) : 1;
    w.push(b.w * k); tot += b.w * k;
  }
  // Without a season the weights sum to 1 by construction, so the draw is left
  // literally untouched rather than multiplied by a 1.0000000000000002.
  let x = season ? x0 * tot : x0, pick = BIOMES.lush;
  for (let i = 0; i < list.length; i++) { if (x < w[i]) { pick = list[i]; break; } x -= w[i]; }
  return Object.freeze(Object.assign({}, pick, { wind: pick.wind * (0.6 + r() * 0.8) }));
}

/* ═══ the seasonal recolouring law ═════════════════════════════
   ONE law, five surfaces. Grass, the stubble the hills wear, the field decals,
   the crop tufts and the far land all move through the year on the same four
   targets, so they can never drift into disagreeing about the month. The targets
   are what a photograph of that surface in that month actually is — dull olive
   and straw and grey-buff, never a hue rotation. `k` is how far each surface is
   allowed to travel: farmland changes most, the far land least. */
// AUTUMN IS NOT A YELLOW GROUND. The turn happens in the CANOPY and in the
// stubble; the sward under it stays green until the frosts, and the first pass
// at these numbers walked the grass so far toward straw that November read as
// August. The autumn entries below are barely off the summer green — duller,
// half a stop darker — and the season is carried by the trees, the strips and
// the litter mottle instead.
// …AND WINTER IS NOT A GREEN GROUND. The bleak entries below used to be
// grey-GREENS of almost exactly the summer sward's own luminance, so `bleak` at
// full strength changed the hue of the countryside by a few degrees and its
// brightness not at all: `--season=winter` rendered a lusher, greener meadow than
// the August default, which is the exact opposite of the thing it is for. A
// January field in this country is dead khaki-buff over dark wet earth — the
// green is GONE, not cooled — and it is darker than anything the year does. So
// the targets below are browns, and `seasonize` takes a further stop of chroma
// and value out on top of them (see there); the two together are the difference
// between a winter you have to be told about and one you can see.
const SEAS_GRASS = { c: [0x6A883C, 0x7E7A4C, 0x47563A, 0x565841], k: [.48, .48, .40, .86] };
const SEAS_GRASS2 = { c: [0x7B9A46, 0x968C55, 0x556040, 0x64614A], k: [.48, .52, .40, .86] };
const SEAS_STUB = { c: [0x8C9256, 0xB2A271, 0x94764A, 0x7E7358], k: [.30, .62, .60, .82] };
const SEAS_FIELD = { c: [0x7E8B4C, 0xBCA96E, 0x8A7248, 0x6E664D], k: [.36, .58, .66, .84] };
const SEAS_TUFT = { c: [0x7A8C46, 0xB6A56C, 0x8B7048, 0x7A7057], k: [.40, .60, .60, .78] };
const SEAS_LAND = { c: [0x6C8046, 0x8B845A, 0x66603F, 0x6A6552], k: [.30, .38, .38, .62] };
const LITTER_COL = 0x7E6440, RIME_COL = 0xB8C2BE;

/* ═══ the lane ═════════════════════════════════════════════════
   What the village surfaces its roads with is a TIER property, published by
   buildings.js's `villageFabric()` and — until now — read by nobody: the ground
   was one untextured plane, which held up at 200 units and fell apart the moment
   the stroll camera stood on it. environs reads the fabric and spends it into
   surface.js's four uLane* uniforms; the drawing happens in the 'ground' role.
   A town mid-rewrite must not be able to take the countryside down with it, so
   the call is guarded and the fallback is what a hamlet has anyway. */
const LANE_FALLBACK = Object.freeze({ tier: 0, lane: 'dirt', laneColor: 0x6B5F49 });
/** Set from `opts.fabric` at init; absent ⇒ the lane is dirt, which is what a
 *  hamlet has anyway, and nothing throws. */
let fabricSrc = null;
function fabricNow() {
  if (!fabricSrc) return LANE_FALLBACK;
  try {
    const F = fabricSrc();
    if (F && typeof F.lane === 'string' && isFinite(F.laneColor)) return F;
  } catch (e) { /* the lane is still dirt, and the sky has not fallen */ }
  return LANE_FALLBACK;
}

/* ── the canopy, in instanceColor space ──────────────────────────
   instanceColor MULTIPLIES the flora kit, and the kit is a PALE GREEN — so a
   gold authored as gold comes out olive. Every canopy target below is written as
   the colour the crown should actually read as, then divided by the kit's own
   mean foliage albedo. Dividing beats hand-tuning: change the kit and these stay
   right. (Computed from THREE.Color so it is correct in whatever working colour
   space three is in — the kit literals are the ones mkFloraGeo bakes.) */
const KIT_FOL = (() => {
  const a = hex(0x93A276), b = hex(0xB0BC8C), c = hex(0xC6CFA4);
  return new THREE.Color((a.r + b.r + c.r) / 3, (a.g + b.g + c.g) / 3, (a.b + b.b + c.b) / 3);
})();
function canopy(h) {
  const c = hex(h);
  return c.setRGB(Math.min(c.r / KIT_FOL.r, 1.6), Math.min(c.g / KIT_FOL.g, 1.6), Math.min(c.b / KIT_FOL.b, 1.6));
}
// Five turners, not one hue shift. Ash and lime go gold, beech tan, oak russet,
// and there is always a tree that never quite gets there. No cartoon orange:
// these are the values off a photograph of an English lane in the third week of
// October, which is a duller and browner picture than anyone remembers.
const AUTUMN = [0x8E763C, 0x835C34, 0x71512D, 0x9E8C4C, 0x675C33].map(canopy);
// A bare tree is a TWIG MASS, not a dead cone: grey-brown, and the crown is
// narrowed rather than removed (see the flora vertex deform) so the trunk
// becomes proportionally visible, which is the whole winter read.
// DARK. A leafless tree is not a pale tree — it is a dense mass of thin twigs
// that reads DARKER than the field behind it at every hour of a winter day. The
// first pass authored it as a mid grey-brown and the January frame filled up
// with pale spikes that looked like something had gone wrong with the lighting.
const BARE_CANOPY = canopy(0x4E463C);
// Apple and blackthorn photograph as warm cream, not pink.
const BLOSSOM_CANOPY = canopy(0xCFC3B0);

/** THE fog authority — town.js's framing calls this instead of its own literal.
 *  Half of v2's density: the ground's radius fade buries the horizon now, so fog
 *  only owes aerial perspective on buildings and a nine-band town stays crisp.
 *  @param {number} dist camera distance @param {?Biome} biome @returns {number} */
export function fogFor(dist, biome) {
  // OPTICAL DEPTH, NOT DENSITY, is what the eye reads: fog dims by density x
  // distance, so a density that falls as d^-0.30 while the camera pulls back to
  // frame a 1200-house town means the town is ~2.3x more fogged than a 200-house
  // one. That is the 'milky low-contrast frame' at the cap — the whole plat washed
  // toward the sky's bottom stop, mean rgb (185,192,169), a third of the frame
  // above L 180 and no separation left between the outskirts, the countryside and
  // the horizon. d^-0.62 keeps roughly half the aerial perspective a growing town
  // used to accumulate, which is still visibly atmosphere and no longer a wall.
  // The floor comes down with it or the clamp cancels the fix at exactly the
  // distances it was written for.
  const d = Math.max(dist || 62, 8), mul = (biome && biome.fogMul) || 1;
  return clamp(0.0016 * Math.pow(62 / d, 0.62) * mul, 0.0005, 0.0032);
}

/* ═══ archetype dressing ═══════════════════════════════════════
   Keyed off plan.kind (the closed enum shared with layout and news). An absent
   or unknown plan falls back to `ring`, which is what demo mode gets. */
const PROFILES = Object.freeze({
  crossroads: { rows: 'spine', fieldStyle: 'block',
    mix: { tree: .30, hedge: .28, orchard: .16, haystack: .12, wall: .06, sheep: .08 } },
  riverside: { rows: 'water', fieldStyle: 'meadow',
    mix: { willow: .18, reed: .16, tree: .20, hedge: .20, haystack: .12, sheep: .14 } },
  ribbon: { rows: 'valley', fieldStyle: 'terrace',
    mix: { tree: .28, hedge: .24, terrace: .18, haystack: .14, sheep: .16 } },
  lakeside: { rows: 'water', fieldStyle: 'meadow',
    mix: { reed: .20, orchard: .22, tree: .22, hedge: .16, haystack: .08, sheep: .12 } },
  hillring: { rows: 'contour', fieldStyle: 'stubble',
    mix: { wall: .28, sheep: .22, tree: .16, hedge: .14, haystack: .10, terrace: .10 } },
  ring: { rows: 'spine', fieldStyle: 'block',
    mix: { tree: .32, hedge: .24, orchard: .16, haystack: .12, sheep: .16 } }
});
// The 16-cell field atlas runs 4 styles × 4 variants: cell % 4 is
// 0 furrows · 1 stubble · 2 orchard rows · 3 fallow. Each archetype farms its own way.
const FIELD_STYLE = Object.freeze({
  block: [0, 0, 2, 1], meadow: [3, 3, 1, 2], terrace: [0, 2, 3, 0], stubble: [1, 1, 3, 0]
});

// One merged geometry, nine roles. Scale is the whole disguise: a hedgerow is a
// squashed tree, a drystone wall is a squashed grey one, a sheep is a small pale
// one facing the wrong way. At 120 units nobody has ever noticed.
// (the kit is ~2.75 tall and ~1.7 across at scale 1, so a house at 3.5 keeps its
// silhouette against an oak and loses it against nothing)
// `dec` is how much of the year this role answers to: 1 = fully deciduous, 0 =
// a wall, a sheep or a haystack, which must not sprout or strip. It gates BOTH
// the seasonal recolour and the bare-crown deform, so the one merged geometry
// can go bare as a tree and stay put as a drystone wall.
const KINDS = Object.freeze({
  tree: { s: [1.90, 1.90, 1.90], jit: .32, col: 'tree', sway: .035, dec: 1 },
  orchard: { s: [1.28, 1.22, 1.28], jit: .10, col: 'tree', sway: .030, dec: 1 },
  willow: { s: [2.20, 1.70, 2.20], jit: .20, col: 'willow', sway: .075, dec: .85 },
  hedge: { s: [2.60, .62, 1.00], jit: .16, col: 'hedge', sway: .012, dec: .55 },
  wall: { s: [2.90, .42, .62], jit: .10, col: 'stone', sway: 0, dec: 0 },
  terrace: { s: [3.60, .32, .75], jit: .14, col: 'earth', sway: 0, dec: 0 },
  reed: { s: [.60, .85, .60], jit: .26, col: 'reed', sway: .130, dec: .45 },
  haystack: { s: [1.50, 1.10, 1.50], jit: .18, col: 'hay', sway: 0, dec: 0 },
  sheep: { s: [.42, .34, .62], jit: .10, col: 'wool', sway: 0, dec: 0 }
});
// Not every tree in a hedgerow is deciduous. A quarter of them are holly, yew,
// scots pine or plain conifer and stay green through January — which is what
// stops a winter frame reading as a clear-fell.
const CONIFER_FRAC = .26;

/* ═══ pools (fixed; parked instances live at y = -999) ═════════ */
// N_BLADE 900 -> 1600. The tufts were authored for the WIDE auto-framing, where
// one is a few pixels; v4's camera rig is the first thing that ever put the lens
// down at 20-28 units (the tour's 'newest' shot, focus, and street level), and at
// that height a 0.9-2.4 scale card stood as tall as a cottage's eaves in sparse
// clumps — reading as an artefact rather than as grass. They are instanced, so
// density is nearly free: smaller and more of them is the same silhouette from
// the air and actual verge from the ground.
const N_FLORA = 1500, N_FIELD = 320, N_BLADE = 1600, N_CLOUD = 54, N_BIRD = 42, N_MOTE = 240;
const G_RINGS = 72, G_SPOKES = 108, G_R = 1200;   // radial ground grid, r = 1200·(i/72)^2.4
const VEIL_R = 940;                               // inside the disc rim, outside the sky dome

/* ═══ procedural textures — four, and no more ═════════════════ */
function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(canvas, aniso, repeat) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso || 1;
  return t;
}
// Grass is a LUMINANCE plate, not a colour: the day's palette and the biome tint
// it in the shader, so a new morning repaints 1.4 M vertices for free.
function mkGrassTex(aniso) {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 16 + Math.random() * 62;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, Math.random() < .5 ? 'rgba(190,190,190,.22)' : 'rgba(48,48,48,.22)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  for (let i = 0; i < 1500; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const w = .8 + Math.random() * 1.5, h = 1.6 + Math.random() * 3.4;
    const l = 90 + Math.random() * 96;
    g.fillStyle = `rgb(${l},${l},${l})`;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) g.fillRect(x + ox, y + oy, w, h);
  }
  return tex(c, aniso, true);
}
// 16 ground decals with torn alpha edges. White + alpha only — every field takes
// its colour from the biome through instanceColor, so nothing is baked in.
function mkFieldTex(aniso) {
  const S = 512, K = S / 4, c = cv(S, S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  for (let cell = 0; cell < 16; cell++) {
    const ox = (cell % 4) * K, oy = ((cell / 4) | 0) * K, r = rngOf(cell * 7717 + 13);
    g.save(); g.translate(ox, oy);
    g.beginPath();                                 // torn boundary: a wobbled polygon
    // hard-capped at K/2 - 3: a cell that spills into its neighbour bleeds through
    // the atlas at every mip level.
    const n = 26, lim = K / 2 - 3;
    for (let i = 0; i <= n; i++) {
      const a = i / n * TAU;
      const rr = Math.min(((.40 + (r() - .5) * .10) * (1 + .15 * Math.sin(a * 2 + cell))
        * (1 - .09 * Math.cos(a * 3 - cell))) * K, lim);
      const x = K / 2 + Math.cos(a) * rr, y = K / 2 + Math.sin(a) * rr;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.clip();
    g.globalAlpha = .74; g.fillStyle = '#fff'; g.fillRect(0, 0, K, K);
    g.globalAlpha = 1;
    const style = cell % 4;                        // furrows · stubble · rows · fallow
    g.save(); g.translate(K / 2, K / 2); g.rotate((r() - .5) * .5); g.translate(-K / 2, -K / 2);
    if (style === 0) {
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2.2;
      for (let y = 4; y < K; y += 7) { g.beginPath(); g.moveTo(-8, y); g.lineTo(K + 8, y + (r() - .5) * 3); g.stroke(); }
      g.strokeStyle = 'rgba(90,90,90,.30)'; g.lineWidth = 1.4;
      for (let y = 7.5; y < K; y += 7) { g.beginPath(); g.moveTo(-8, y); g.lineTo(K + 8, y); g.stroke(); }
    } else if (style === 1) {
      g.fillStyle = 'rgba(255,255,255,.42)';
      for (let i = 0; i < 420; i++) g.fillRect(r() * K, r() * K, 2.4, 2.0);
      g.fillStyle = 'rgba(70,70,70,.22)';
      for (let i = 0; i < 160; i++) g.fillRect(r() * K, r() * K, 3.0, 1.6);
    } else if (style === 2) {
      g.fillStyle = 'rgba(255,255,255,.60)';
      for (let y = 8; y < K; y += 13) for (let x = 8; x < K; x += 13) {
        g.beginPath(); g.arc(x + (r() - .5) * 2, y + (r() - .5) * 2, 2.6, 0, TAU); g.fill();
      }
      g.strokeStyle = 'rgba(120,120,120,.24)'; g.lineWidth = 1;
      for (let y = 8; y < K; y += 13) { g.beginPath(); g.moveTo(0, y); g.lineTo(K, y); g.stroke(); }
    } else {
      for (let i = 0; i < 40; i++) {
        const x = r() * K, y = r() * K, rr = 4 + r() * 16;
        const gr = g.createRadialGradient(x, y, 0, x, y, rr);
        gr.addColorStop(0, r() < .5 ? 'rgba(255,255,255,.34)' : 'rgba(80,80,80,.26)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
      }
    }
    g.restore(); g.restore();
  }
  const t = tex(c, aniso, false);
  return t;
}
// One crop card: a tuft of stalks, alpha-tested. Tinted per instance.
// 128 -> 256, AND THINNER. A tuft is about a metre tall, so at 128 px a stalk
// drawn at 1.6-3.4 px was 1.3-2.7 CENTIMETRES wide — which is right — but the
// street-level camera stands a metre from one, and at that range the card is
// magnified past its own resolution and the stalks read as fat yellow noodles.
// Doubling the plate and halving the stroke keeps the same silhouette from the
// air and gives the verge actual stalks from the ground, for 144 KB and no
// draw call. More of them, too: a thinner stalk needs company.
function mkCropTex(aniso) {
  const S = 256, c = cv(S, S), g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 96; i++) {
    const x = 16 + Math.random() * (S - 32), h = 80 + Math.random() * 152;
    const bend = (Math.random() - .5) * 52, l = 150 + Math.random() * 105;
    g.strokeStyle = `rgba(${l},${l},${l},1)`;
    g.lineWidth = 1.5 + Math.random() * 1.7; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, S - 3);
    g.quadraticCurveTo(x + bend * .4, S - h * .6, x + bend, S - h);
    g.stroke();
    if (Math.random() < .45) {                     // an ear on the good ones
      g.fillStyle = `rgba(${l},${l},${l},1)`;
      g.beginPath(); g.ellipse(x + bend, S - h - 5, 2.4, 8.2, bend * .02, 0, TAU); g.fill();
    }
  }
  return tex(c, aniso, false);
}
function mkMoteTex() {
  const S = 32, c = cv(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(.35, 'rgba(255,255,255,.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c, 1, false);
}

/* ═══ the flora kit: trunk + skirt + two cones, merged once ═════ */
function mergeGeos(list) {
  let n = 0;
  for (const [g] of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const fol = new Float32Array(n);
  let o = 0;
  const c = new THREE.Color();
  for (const [g, hexCol, isFol] of list) {
    const p = g.attributes.position, q = g.attributes.normal, m = p.count;
    c.set(hexCol);
    for (let i = 0; i < m; i++) {
      pos[(o + i) * 3] = p.getX(i); pos[(o + i) * 3 + 1] = p.getY(i); pos[(o + i) * 3 + 2] = p.getZ(i);
      nor[(o + i) * 3] = q.getX(i); nor[(o + i) * 3 + 1] = q.getY(i); nor[(o + i) * 3 + 2] = q.getZ(i);
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
      fol[o + i] = isFol ? 1 : 0;
    }
    o += m; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // aFol marks the LEAVES. The trunk is not seasonal — it is the one part of the
  // kit that has to hold still while the crown comes and goes, and it is what
  // makes a bare tree read as a tree rather than as a shrunken one.
  out.setAttribute('aFol', new THREE.BufferAttribute(fol, 1));
  return out;
}
function mkFloraGeo() {
  // Base colours are pale on purpose: instanceColor MULTIPLIES, so a pale kit
  // takes any hue the biome asks for and the relative luminances survive.
  const trunk = new THREE.CylinderGeometry(.13, .20, .95, 5, 1, true).translate(0, .48, 0);
  const skirt = new THREE.ConeGeometry(.86, .60, 7).translate(0, .30, 0);
  const coneA = new THREE.ConeGeometry(.80, 1.40, 7).translate(0, 1.32, 0);
  const coneB = new THREE.ConeGeometry(.52, 1.10, 6).translate(0, 2.16, 0);
  return mergeGeos([
    [trunk.toNonIndexed(), 0xA08A70, 0], [skirt.toNonIndexed(), 0x93A276, 1],
    [coneA.toNonIndexed(), 0xB0BC8C, 1], [coneB.toNonIndexed(), 0xC6CFA4, 1]
  ]);
}
// Three quads at 60°, pivoted at the ground: a crop card that reads from any angle.
function mkBladeGeo() {
  const pos = [], uvs = [], nor = [], col = [], idx = [];
  for (let q = 0; q < 3; q++) {
    const a = q * Math.PI / 3, cx = Math.cos(a) * .5, cz = Math.sin(a) * .5, b = q * 4;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) { nor.push(0, 1, 0); col.push(1, 1, 1); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/* ═══ shader fragments shared by ground / fields / blades / flora ═══ */
const CHUNK_NIGHT = `
  vec3 envNight(vec3 c, vec3 ind, float k){
    float l = dot(c, vec3(0.3, 0.5, 0.2));
    return mix(c, ind * (0.30 + 0.85 * l), k);
  }`;

/* The countryside fade, keyed to the town's own silhouette ─────────
   A radial fade inscribes a perfect circle — the exact shape v3 exists to lose,
   drawn back on by the treatment meant to hide the town's edge. Two harmonics of
   wobble only turned that circle into a lobed circle, which on a ribbon or a
   lakeside plan bulged hundreds of units into empty grass and read as a mown
   lawn. uReach is the SAME 48-bin azimuthal profile the flora scatter already
   uses, so the collar now hugs whatever shape the day actually built. Linear
   interpolation between bins keeps the boundary smooth; a little wobble on top
   keeps it from looking surveyed. Vertex shaders may index a uniform array with
   any integer expression, so this is one lookup and no texture. */
const CHUNK_REACH = `
  uniform float uReach[48];
  float envReach(float a){
    float f = fract(a / 6.2831853 + 1.0) * 48.0;
    int i0 = int(f); float t = f - float(i0);
    int i1 = i0 + 1; if (i1 > 47) i1 = 0;
    float r = mix(uReach[i0], uReach[i1], t);
    return r * (1.0 + 0.06 * sin(a * 5.0 - 0.6) + 0.05 * sin(a * 9.0 + 1.7));
  }`;

/**
 * @param {THREE.Scene} scene
 * @param {?Plan} plan  every field optional; a null/partial plan is synthesised
 *                      from the seed as a `ring` archetype. NEVER throws.
 * @param {{maxAnisotropy?:number, daySeed?:number, palette?:Object, quality?:'high'|'low',
 *          lat?:number}} opts  `lat` flips the seasons below the equator; default 50
 * @returns {Environs}
 */
export function initEnvirons(scene, plan, opts = {}) {
  const aniso = opts.maxAnisotropy || 1;
  const low = opts.quality === 'low';
  // What the village surfaces its roads with, handed in rather than imported.
  fabricSrc = typeof opts.fabric === 'function' ? opts.fabric : null;
  const nBlade = low ? N_BLADE >> 1 : N_BLADE, nMote = low ? N_MOTE >> 1 : N_MOTE;
  const group = new THREE.Group();
  group.name = 'environs';
  scene.add(group);

  /* ── shared uniform objects: one write reaches every material ── */
  const U = {
    uTime: { value: 0 }, uNight: { value: 0 }, uDay: { value: 1 },
    uWind: { value: 1 }, uFade: { value: new THREE.Vector2(60, 130) },
    uCenter: { value: new THREE.Vector2(0, 0) }, uE: { value: 40 },
    uNightCol: { value: hex(0x2A3450) }, uCloudShadow: { value: 1 },
    uGrass: { value: hex(0x55693A) }, uGrass2: { value: hex(0x6C7B48) },
    uStubble: { value: hex(0x8E8558) }, uMud: { value: hex(0x584C38) },
    uFog: { value: hex(0x0B0E14) }, uCloudA: { value: .85 }, uCloudFrac: { value: .62 },
    uCloudCol: { value: hex(0xF3EFE4) }, uBirdCol: { value: hex(0x3A3A34) },
    uSun: { value: new THREE.Vector3(.5, .7, -.2) }, uSunCol: { value: hex(0xFFE9C0) },
    uMote1: { value: hex(0xE9EFC0) }, uMote2: { value: hex(0xFFD86A) },
    uWater: { value: hex(0x3E6E8E) }, uShore: { value: hex(0x7C9A88) },
    // THE FAR LAND IS NOT THE SKY. Painting the distance with `scene.fog.color`
    // — which is the sky's BOTTOM stop — made the countryside the brightest
    // object in the frame at every low sun: at dusk that stop is lerped 52 %
    // toward a warm 0xE79B5C, so the empty middle of the picture out-shone both
    // the sunset above it and the town below it. uLandFar is the same value
    // pulled DOWN and toward the biome's own cool land tone, hardest when the
    // sun is on the horizon, so the band always sits darker than the sky.
    uLandFar: { value: hex(0x6A6E62) },
    // THE SEASON'S ONE GROUND TERM. Autumn scatters leaf litter and winter
    // scatters rime, and they are the same operation — a warm or a cold value
    // caught on whatever the grass plate already says is a high spot — so they
    // share one colour and one strength and cost the ground exactly one mix.
    uSeasTop: { value: hex(0x8E6A3E) }, uSeasK: { value: 0 },
    // THE WEATHER, ON THE LAND. Two scalars off WX's bus, written once per frame
    // in stepLane and read by the ground plate and by the three instanced
    // families. Wet grass is darker; settled snow lies on the field exactly as it
    // lies on the lane and on the roofs, so the three can never disagree about
    // whether it has been snowing. Both are 0 on every day it has not.
    uWet: { value: 0 }, uSnow: { value: 0 },
    // Pollen in May is not fireflies in January. The mote sheet's daytime alpha
    // used to be the literal 0.30; the year owns it now.
    uMoteDay: { value: .30 },
    // The town's 48-bin azimuthal reach, uploaded so the ground fade can hug the
    // built shape instead of inscribing a circle around its bounding radius.
    uReach: { value: new Float32Array(48).fill(1) }
  };

  /* ── state ─────────────────────────────────────────────────── */
  // The season is resolved BEFORE the biome, because it weights the biome roll:
  // "new green" is not a December weather. `lat` is optional and defaults to the
  // same 50 town.js starts at, so a feed that never reports a location gets
  // northern seasons and nothing crashes.
  const lat0 = isFinite(opts.lat) ? opts.lat : 50;
  const seas0 = seasonFor(opts.daySeed || 20260101, lat0);
  const st = {
    plan: null, kind: 'ring', prof: PROFILES.ring,
    season: seas0, lat: lat0, biome: biomeFor(opts.daySeed || 20260101, seas0),
    palette: opts.palette || null, daySeed: opts.daySeed || 20260101, seed: 1,
    flatR: 280, maxR: 250, spine: [], water: null, wet: null,
    inner: 14, outer: -1, E: 0, cx: 0, cz: 0, tab: null,
    domes: [], ridge: [], night: 0, day: 1,
    haze: 0, cast: 0, wxFrom: null, wxTo: null, wxAt: -1e9, slowSince: 0, wx: 'calm',
    // DEFAULT FALSE. postfx claims --vig inside its own constructor, which runs
    // after ours, so starting owned would flash the CSS vignette on top of the
    // shader one for the first frames. town.js settles it on the 500 ms tick and
    // hands it back the moment the tier drops to 'off'.
    gBase: new THREE.Color(), g2Base: new THREE.Color(), stBase: new THREE.Color(),
    landTone: new THREE.Color(0x55693A),
    // THE WEATHER BUS. town.js has been passing `wx: WX` into initEnvirons since
    // weather landed and out here nothing read it. The lane is what needed it:
    // `uWet` is the difference between a road and a road it has just rained on.
    wxBus: (opts.wx && opts.wx.uWet) ? opts.wx : null,
    laneG: 0, laneC: 0, laneFab: null, laneAt: -1e9,
    laneFrom: { g: 0, c: 0 }, laneTo: { g: 0, c: 0 },
    vigAt: 0, vig: -1, vigOwned: false, statAt: 0, sunLight: null, moonLight: null, disposed: false
  };
  const _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color(), _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

  /* ── the plan, defensively ─────────────────────────────────── */
  function readPlan(p) {
    st.plan = p || null;
    st.kind = (p && typeof p.kind === 'string' && PROFILES[p.kind]) ? p.kind : 'ring';
    st.prof = PROFILES[st.kind];
    st.flatR = (p && isFinite(p.flatR) && p.flatR > 40) ? p.flatR : 280;
    st.maxR = (p && isFinite(p.maxR) && p.maxR > 40) ? p.maxR : 250;
    const r = rngOf(st.seed * 2246822519 + 5);
    st.spine = (p && Array.isArray(p.spine) && p.spine.length)
      ? p.spine.map(s => (s && isFinite(s.a)) ? s.a : 0)
      : [0, 1, 2, 3].map(i => (i / 4) * TAU + r() * .8);
    st.water = null;
    const w = p && p.water;
    if (w && Array.isArray(w.path) && w.path.length >= 2) {
      const path = w.path.filter(q => q && isFinite(q.x) && isFinite(q.z));
      if (path.length >= 2) st.water = { kind: w.kind === 'lake' ? 'lake' : 'river', path, width: clamp(w.width || 9, 3, 40) };
    }
    buildWet();
    buildReach(p);
    // The town's centre of mass and its origin-centred reach, prefix-scanned once
    // so setExtent can turn `bounds.r` into bands that hug a lopsided town.
    st.tab = null;
    if (p && typeof p.plotAt === 'function' && typeof p.boundsFor === 'function' && isFinite(p.capacity)) {
      const n = Math.min(p.capacity | 0, 1400);
      if (n > 4) {
        const bR = new Float32Array(n), oR = new Float32Array(n), cX = new Float32Array(n), cZ = new Float32Array(n);
        let mx = 0, sx = 0, sz = 0;
        try {
          for (let i = 0; i < n; i++) {
            const pl = p.plotAt(i);
            const px = (pl && pl.x) || 0, pz = (pl && pl.z) || 0;
            mx = Math.max(mx, Math.hypot(px, pz)); sx += px; sz += pz;
            oR[i] = mx; cX[i] = sx / (i + 1); cZ[i] = sz / (i + 1);
            const b = p.boundsFor(i + 1);
            bR[i] = Math.max((b && b.r) || 0, i ? bR[i - 1] : 0);
          }
          st.tab = { n, bR, oR, cX, cZ };
        } catch (e) { st.tab = null; }
      }
    }
  }

  /* ── terrain: flat where the town builds, then hills and a broken ridge ── */
  function seedTerrain() {
    const r = rngOf(st.seed * 374761393 + 31);
    st.domes.length = 0;
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i + r() * .8) / n * TAU, rad = 430 + r() * 400;
      st.domes.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, h: 14 + r() * 38, s: 90 + r() * 170 });
    }
    st.ridge.length = 0;                            // fbm over azimuth: never a rim, always a skyline
    for (const k of [2, 3, 5, 7, 11]) st.ridge.push({ k, a: r() * TAU, m: 1 / k });
  }
  function ridgeAt(a) {
    let s = 0, w = 0;
    for (const h of st.ridge) { s += Math.sin(a * h.k + h.a) * h.m; w += h.m; }
    return 10 + 26 * clamp(.5 + .5 * (s / w) * 2.1, 0, 1);
  }
  function hillsAt(x, z, r) {
    if (r <= st.flatR) return 0;                    // contractual: dead flat inside flatR
    let h = (fbm2(x * .0125, z * .0125) - .5) * 7 * smooth(st.flatR, st.flatR * 1.6, r);
    const w = smooth(400, 560, r);
    if (w > 0) {
      for (const d of st.domes) {
        const dx = x - d.x, dz = z - d.z, q = (dx * dx + dz * dz) / (2 * d.s * d.s);
        if (q < 9) h += w * d.h * Math.exp(-q);
      }
      const win = smooth(520, 800, r) * Math.exp(-Math.pow((r - 880) / 320, 2));
      if (win > .002) h += w * win * ridgeAt(Math.atan2(z, x));
    }
    return h;
  }
  /** The vertex shader's height, exactly. 0 anywhere the town can build. */
  function terrainAt(x, z) {
    const r = Math.hypot(x, z);
    return hillsAt(x, z, r) - carveAt(x, z);
  }

  /* ── water: one polyline, resampled, and everything derived from it ── */
  function buildWet() {
    st.wet = null;
    if (!st.water) return;
    const src = st.water.path, closed = st.water.kind === 'lake';
    const pts = [];                                 // Catmull-Rom, resampled every 6 units
    const at = i => src[closed ? ((i % src.length) + src.length) % src.length : clamp(i, 0, src.length - 1)];
    const segs = closed ? src.length : src.length - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const steps = Math.max(1, Math.round(len / 6));
      for (let s = 0; s < steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t;
        pts.push({
          x: .5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          z: .5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)
        });
      }
      if (pts.length > 420) break;
    }
    if (closed && pts.length > 2) pts.push({ x: pts[0].x, z: pts[0].z });
    if (pts.length < 2) return;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, cx = 0, cz = 0;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); cx += p.x; cz += p.z; }
    const pad = st.water.width + 12;
    st.wet = {
      pts, closed, half: st.water.width * .5, pad,
      bb: [x0 - pad, x1 + pad, z0 - pad, z1 + pad],
      cx: cx / pts.length, cz: cz / pts.length,
      depth: closed ? 1.9 : 1.25
    };
  }
  function segDist(x, z) {                          // distance to the resampled polyline
    const w = st.wet, p = w.pts;
    let best = 1e9;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i].x, az = p[i].z, bx = p[i + 1].x - ax, bz = p[i + 1].z - az;
      const l2 = bx * bx + bz * bz || 1e-6;
      let t = ((x - ax) * bx + (z - az) * bz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + bx * t), dz = z - (az + bz * t), d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  function inLake(x, z) {
    const p = st.wet.pts;
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length - 1; j = i++) {
      if ((p[i].z > z) !== (p[j].z > z) &&
        x < (p[j].x - p[i].x) * (z - p[i].z) / ((p[j].z - p[i].z) || 1e-6) + p[i].x) inside = !inside;
    }
    return inside;
  }
  /** Depth of the channel dug under (x, z). 0 on dry land. */
  function carveAt(x, z) {
    const w = st.wet;
    if (!w) return 0;
    const b = w.bb;
    if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) return 0;
    const d = segDist(x, z);
    if (w.closed) {
      const inside = inLake(x, z);
      if (inside) return w.depth * clamp(.35 + d / 9, 0, 1);
      return d < 2.4 ? w.depth * .35 * (1 - d / 2.4) : 0;
    }
    if (d <= w.half) return w.depth * (1 - .55 * Math.pow(d / w.half, 2));
    if (d <= w.half + 2.6) return w.depth * .45 * (1 - (d - w.half) / 2.6);
    return 0;
  }
  /** @param {number} x @param {number} z @returns {boolean} in the water, banks included */
  function isWater(x, z) {
    const w = st.wet;
    if (!w) return false;
    const b = w.bb;
    if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) return false;
    return w.closed ? (inLake(x, z) || segDist(x, z) < 1.2) : segDist(x, z) < w.half + 1.2;
  }

  /* ═══ 1. THE GROUND — the fade lives here ═══════════════════ */
  const groundGeo = (() => {
    const vn = (G_RINGS + 1) * (G_SPOKES + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vn * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vn * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vn * 2), 2));
    for (const a of ['aTint', 'aHill', 'aSlope', 'aCarve']) g.setAttribute(a, new THREE.BufferAttribute(new Float32Array(vn), 1));
    const idx = new Uint16Array(G_RINGS * G_SPOKES * 6);
    let o = 0;
    for (let i = 0; i < G_RINGS; i++) for (let j = 0; j < G_SPOKES; j++) {
      const a = i * (G_SPOKES + 1) + j, b = a + G_SPOKES + 1;
      // Winding is CCW seen from ABOVE (+y). The obvious (a,b,a+1) order puts the
      // geometric normal at -y — the whole countryside is then backface-culled and
      // only the disc's rim survives, edge-on, at the horizon.
      idx[o++] = a; idx[o++] = a + 1; idx[o++] = b;
      idx[o++] = a + 1; idx[o++] = b + 1; idx[o++] = b;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), G_R * 1.2);
    return g;
  })();
  function bakeGround() {
    const P = groundGeo.attributes.position.array, N = groundGeo.attributes.normal.array;
    const UVa = groundGeo.attributes.uv.array, T = groundGeo.attributes.aTint.array;
    const H = groundGeo.attributes.aHill.array, S = groundGeo.attributes.aSlope.array;
    const C = groundGeo.attributes.aCarve.array;
    let v = 0;
    for (let i = 0; i <= G_RINGS; i++) {
      const r = G_R * Math.pow(i / G_RINGS, 2.4);
      for (let j = 0; j <= G_SPOKES; j++) {
        const a = j / G_SPOKES * TAU;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const carve = carveAt(x, z), hill = hillsAt(x, z, r);
        const y = hill - carve;
        // finite-difference normal from the HILLS only: the river bed is under
        // water anyway, and carve is the expensive term.
        const e = 6;
        const hx = hillsAt(x + e, z, Math.hypot(x + e, z)) - hillsAt(x - e, z, Math.hypot(x - e, z));
        const hz = hillsAt(x, z + e, Math.hypot(x, z + e)) - hillsAt(x, z - e, Math.hypot(x, z - e));
        const nx = -hx / (2 * e), nz = -hz / (2 * e), nl = Math.hypot(nx, 1, nz) || 1;
        P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
        N[v * 3] = nx / nl; N[v * 3 + 1] = 1 / nl; N[v * 3 + 2] = nz / nl;
        UVa[v * 2] = x / 28; UVa[v * 2 + 1] = z / 28;
        // two octaves of macro noise (λ ≈ 90 and 340) — the thing that kills the
        // tiling when the camera pulls back
        T[v] = clamp(vnoise(x / 90, z / 90) * .62 + vnoise(x / 340 + 5.5, z / 340 - 2.5) * .38, 0, 1);
        H[v] = clamp(hill / 26, 0, 1);
        S[v] = clamp((1 - 1 / nl) * 3, 0, 1);
        C[v] = clamp(carve / 1.1, 0, 1);
        v++;
      }
    }
    for (const k of ['position', 'normal', 'uv', 'aTint', 'aHill', 'aSlope', 'aCarve']) groundGeo.attributes[k].needsUpdate = true;
  }
  const grassTex = mkGrassTex(aniso);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: grassTex });
  groundMat.customProgramCacheKey = () => 'env-ground';
  groundMat.onBeforeCompile = s => {
    Object.assign(s.uniforms, {
      uFade: U.uFade, uCenter: U.uCenter, uGrass: U.uGrass, uGrass2: U.uGrass2,
      uStubble: U.uStubble, uMud: U.uMud, uNight: U.uNight, uNightCol: U.uNightCol,
      uTime: U.uTime, uWind: U.uWind, uCloudShadow: U.uCloudShadow, uFog: U.uFog,
      uLandFar: U.uLandFar, uReach: U.uReach, uSeasTop: U.uSeasTop, uSeasK: U.uSeasK,
      uWet: U.uWet, uSnow: U.uSnow
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        ${CHUNK_REACH}
        attribute float aTint; attribute float aHill; attribute float aSlope; attribute float aCarve;
        uniform vec2 uFade; uniform vec2 uCenter;
        varying float vTint; varying float vHill; varying float vSlope; varying float vCarve;
        varying float vFade; varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTint = aTint; vHill = aHill; vSlope = aSlope; vCarve = aCarve;
        vec4 envW = modelMatrix * vec4(transformed, 1.0);
        vWPos = envW.xyz;
        vec2 envD = envW.xz - uCenter;
        float envWb = envReach(atan(envD.y, envD.x));
        vFade = smoothstep(uFade.x * envWb, uFade.y * envWb, length(envD));`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGrass; uniform vec3 uGrass2; uniform vec3 uStubble; uniform vec3 uMud;
        uniform vec3 uNightCol; uniform vec3 uLandFar; uniform float uNight; uniform float uTime;
        uniform float uWind; uniform float uCloudShadow;
        uniform vec3 uSeasTop; uniform float uSeasK; uniform float uWet; uniform float uSnow;
        varying float vTint; varying float vHill; varying float vSlope; varying float vCarve;
        varying float vFade; varying vec3 vWPos;
        ${CHUNK_NIGHT}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float envL = dot(diffuseColor.rgb, vec3(0.34, 0.5, 0.16));
        vec3 envG = mix(uGrass, uGrass2, vTint);
        envG = mix(envG, uStubble, clamp(vHill * 1.15 + vSlope * 0.55, 0.0, 0.86));
        envG = mix(envG, uMud, vCarve);
        // THE YEAR'S ONE GROUND TERM: leaf litter in autumn, rime in winter.
        // Both are the same thing — something caught on what is already proud of
        // the sward — so the grass plate's own luminance is the mask and the mix
        // is a single instruction. Scaled off the wet channel so a river bed
        // never comes up covered in leaves. NB the range: the grass plate is
        // decoded from sRGB, so envL lives in roughly 0.10–0.48 and NOT in
        // 0.0–1.0 — a mask authored on the display values silently never fires.
        envG = mix(envG, uSeasTop, uSeasK * smoothstep(0.26, 0.46, envL) * (1.0 - vCarve));
        // WET GRASS IS DARKER GRASS, and a field is the biggest surface in the
        // frame — so this one multiply says "it has been raining" over more
        // square metres than every drop in the air put together.
        envG *= 1.0 - 0.22 * uWet;
        // SETTLED SNOW. It arrives in PATCHES, catching first on whatever the
        // grass plate already says is proud of the sward (the same mask the
        // litter and the rime use, and the same reason: the range is 0.10–0.48,
        // not 0–1), and only takes the whole field once it is deep. It never
        // lies in the carved beds — a river does not go white — and it fills
        // the hollows before it dresses the banks, which is what vHill is for.
        // The value
        // is a REAL snow-in-daylight value and not paper: pure white here read
        // as a blown-out hole in the middle of a village.
        float envSn = uSnow * (1.0 - vCarve * 0.85) * (1.0 - 0.30 * vHill);
        float envLie = smoothstep(0.02, 0.78, clamp(envSn * (0.55 + 0.85 * smoothstep(0.20, 0.44, envL)), 0.0, 1.0));
        envG = mix(envG, vec3(0.78, 0.81, 0.85), envLie * 0.92);
        // THE DETAIL TERM ADDS TEXTURE, NOT BRIGHTNESS. It used to multiply in
        // (0.55 + envL) at full strength inside the fade start and collapse to a
        // 0.20 floor outside it, so the ground was ~22 % brighter within the
        // collar and dead flat beyond — a lobed bright patch wrapping the town
        // that read as a paint spill or a mown lawn, worst on the very archetypes
        // v3 added. Pivoting the texture's luminance about its own mean makes the
        // term mean-neutral: crossing the boundary now changes how BUSY the grass
        // is, never how light it is. The ramp also starts at vFade = 0 (where
        // vFade's own derivative is zero) so there is no value cliff at all.
        // SNOW BURIES TEXTURE. The term below is mean-neutral but it swings by
        // ±44 %, and laid over a white field that reads as a dirty one — the
        // whole point of settled snow is that it is the SMOOTHEST thing in the
        // frame. Retiring it under the cover is one multiply and it is also the
        // physically obvious answer.
        float envDet = max(0.10, 1.0 - smoothstep(0.0, 1.55, vFade)) * (1.0 - 0.88 * envLie);
        diffuseColor.rgb = envG * (1.0 + (envL - 0.52) * 1.05 * envDet);
        // AT EYE HEIGHT THE PLATE IS A FIELD OF NOTHING. One grass tile is 28
        // units across, so from 1.35 units up the nearest four metres of ground
        // carry a texel every 11 cm and no structure at all under a metre — which
        // is fine from 200 units and is a bare brown floor when you stand on it.
        // Two more taps of the SAME plate — 7.3x for blades, 1.9x for the
        // patchiness trodden ground has — ramp in inside 32 units and are
        // identically zero beyond, so the wide framing is untouched to the bit,
        // and there is no new texture, no new attribute and no new draw call.
        // …and the same is true of the eye-height detail: a snowed-over verge has
        // no thin grass and no trodden earth showing through it.
        float envNr = (1.0 - smoothstep(7.0, 32.0, length(cameraPosition - vWPos))) * (1.0 - 0.85 * envLie);
        if (envNr > 0.003) {
          float envFine = dot(texture2D(map, vMapUv * 7.3).rgb, vec3(0.34, 0.5, 0.16));
          float envPat = dot(texture2D(map, vMapUv * 1.9 + 0.37).rgb, vec3(0.34, 0.5, 0.16));
          diffuseColor.rgb *= 1.0 + (envFine - 0.26) * 1.15 * envNr;
          // WHERE THE GRASS IS THIN IT IS EARTH, not paler grass. That is the one
          // thing a village ground plane has to say from a metre up, and it is
          // what makes the verge beside a lane read as trodden rather than mown.
          diffuseColor.rgb = mix(diffuseColor.rgb, uMud,
            envNr * (1.0 - smoothstep(0.13, 0.30, envPat)) * 0.42);
        }
        vec2 envCp = vWPos.xz * 0.0021 + vec2(uTime * 0.0000090 * uWind, uTime * 0.0000052 * uWind);
        float envCs = sin(envCp.x * 3.1 + sin(envCp.y * 2.3) * 1.7) * sin(envCp.y * 2.7 - sin(envCp.x * 1.9) * 1.3);
        diffuseColor.rgb *= 1.0 - 0.16 * smoothstep(0.10, 0.80, envCs) * uCloudShadow;
        diffuseColor.rgb = envNight(diffuseColor.rgb, uNightCol, uNight * 0.78);`)
      // THE DISTANCE IS NOT THE SKY. Deriving the far ground from `fogColor` —
      // the sky's bottom stop — tied the emptiest part of the frame to the
      // brightest part of the gradient: at dusk that stop is lerped 52 % toward
      // a warm 0xE79B5C, so the far fields came out LIGHTER than the sunset above
      // them and lighter than the town below them. uLandFar is that value pulled
      // down and cooled by sun elevation (see update()), which is the one signal
      // that actually says "the sky is about to be brighter than the land".
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uLandFar, vFade * 0.70);`);
  };
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true; ground.castShadow = false;
  ground.frustumCulled = false;
  group.add(ground);

  /* ═══ 2. THE VEIL — a zero-contrast ground/sky seam at every hour ═══ */
  const veilGeo = new THREE.CylinderGeometry(VEIL_R, VEIL_R, 320, 48, 1, true);
  const veilMat = new THREE.ShaderMaterial({
    uniforms: { uCol: U.uFog, uLand: U.uLandFar },
    vertexShader: `varying float vY; varying float vAz;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y;
        vAz = atan(w.z, w.x);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    // The veil is a HAZE BANK, not a wall, and it is drawn in the TRANSPARENT
    // pass — after the sky dome, whatever its renderOrder — so whatever colour it
    // carries is laid over sky and ground alike. Two failures came out of that:
    // it painted the sky's own bottom stop (bright and warm at dusk) across the
    // horizon band, and its alpha ramp was a machined arc, so the band terminated
    // against the sky in a 6-pixel step instead of dissolving into it.
    //   Below the horizon it now settles onto uLandFar — the same value the far
    // ground converges to from the other side, which is what makes the seam
    // unfindable — and the ramp's bounds wobble with azimuth so the terminator is
    // a coastline rather than a compass arc.
    fragmentShader: `uniform vec3 uCol; uniform vec3 uLand; varying float vY; varying float vAz;
      void main(){
        float w = 9.0 * sin(vAz * 3.0 + 1.3) + 6.0 * sin(vAz * 7.0 - 0.7);
        float a = pow(1.0 - smoothstep(34.0 + w, 250.0 + w * 2.0, vY), 1.25);
        float g = 1.0 - smoothstep(-70.0, 110.0, vY);
        gl_FragColor = vec4(mix(uCol, uLand, g), a); }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false
  });
  // renderOrder is explicit for every transparent thing out here: distance
  // sorting puts a 940-unit cylinder centred on the origin in the wrong place.
  // veil (-3) → fields (-2) → core's road plate (0) → water (1) → sky (2) → motes (3).
  const veil = new THREE.Mesh(veilGeo, veilMat);
  veil.position.y = 100; veil.frustumCulled = false; veil.renderOrder = -3;
  group.add(veil);

  /* ═══ 3. WATER — it has to catch the sun or a river reads as a road ═══ */
  const W_TRI = 1000;
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(W_TRI * 9), 3));
  waterGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(W_TRI * 9), 3));
  waterGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(W_TRI * 6), 2));
  waterGeo.setAttribute('aShore', new THREE.BufferAttribute(new Float32Array(W_TRI * 3), 1));
  waterGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x3E6E8E, roughness: .17, metalness: .12, transparent: true, opacity: .93
  });
  waterMat.customProgramCacheKey = () => 'env-water';
  waterMat.onBeforeCompile = s => {
    Object.assign(s.uniforms, {
      uTime: U.uTime, uNight: U.uNight, uDay: U.uDay, uSun: U.uSun, uSunCol: U.uSunCol,
      uShore: U.uShore, uNightCol: U.uNightCol, uWind: U.uWind, uFade: U.uFade, uCenter: U.uCenter,
      uLandFar: U.uLandFar, uSky: U.uFog
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aShore; uniform vec2 uFade; uniform vec2 uCenter;
        varying float vShore; varying float vFade; varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vShore = aShore;
        vec4 envW = modelMatrix * vec4(transformed, 1.0);
        vWPos = envW.xyz;
        vFade = smoothstep(uFade.x, uFade.y, length(envW.xz - uCenter));`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uNight; uniform float uDay; uniform float uWind;
        uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uShore; uniform vec3 uNightCol;
        uniform vec3 uLandFar; uniform vec3 uSky;
        varying float vShore; varying float vFade; varying vec3 vWPos;
        vec3 envRipple(vec3 p, float t, float w){
          float n1 = sin(p.x * 0.55 + t * 0.90 * w);
          float n2 = sin(p.z * 0.47 - t * 0.72 * w);
          float n3 = sin((p.x + p.z) * 0.31 + t * 1.20 * w);
          return normalize(vec3((n1 + n3) * 0.11, 1.0, (n2 + n3) * 0.11));
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = mix(uShore, diffuseColor.rgb, smoothstep(0.0, 0.55, vShore));
        diffuseColor.a *= mix(0.62, 1.0, vShore) * mix(1.0, 0.86, uNight);
        diffuseColor.rgb = mix(diffuseColor.rgb, uNightCol * 0.7, uNight * 0.40);`)
      // `normal` is VIEW space here; the ripple is world space. Rotate it in for
      // the lighting, keep the world copy for the glint lobe.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        vec3 envRNw = envRipple(vWPos, uTime * 0.001, 0.4 + 0.6 * uWind);
        normal = normalize(mix(normal, normalize((viewMatrix * vec4(envRNw, 0.0)).xyz), 0.85));`)
      // A single specular lobe is all a river needs — it is narrow, so some part
      // of it always catches the sun. A LAKE is a big flat mirror, and at low sun
      // that lobe misses the camera entirely: what was left was the bare base
      // colour, a near-black navy slab reading as a hole cut in the ground under
      // a salmon sky. Fresnel is what makes still water look like water — at
      // grazing angles (which is most of a lake, from an orbiting camera) it
      // takes the sky instead of the depths, for the cost of one dot product.
      .replace('#include <opaque_fragment>', `
        vec3 envV = normalize(cameraPosition - vWPos);
        vec3 envR = reflect(-normalize(uSun), envRNw);
        float envG = pow(max(dot(envR, envV), 0.0), 46.0);
        outgoingLight += uSunCol * envG * (uDay * 1.5 + uNight * 0.45);
        float envF = pow(1.0 - clamp(dot(envV, envRNw), 0.0, 1.0), 3.4);
        outgoingLight = mix(outgoingLight, uSky * (0.72 + 0.42 * uDay), envF * 0.80);
        #include <opaque_fragment>`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uLandFar, vFade * 0.70);`);
  };
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.castShadow = water.receiveShadow = false;
  water.frustumCulled = false; water.renderOrder = 1;
  water.position.y = .06;                            // just proud of the road plate
  water.visible = false;
  group.add(water);

  function bakeWater() {
    const w = st.wet;
    water.visible = false;
    if (!w) { waterGeo.setDrawRange(0, 0); return; }
    const P = waterGeo.attributes.position.array, N = waterGeo.attributes.normal.array;
    const UVa = waterGeo.attributes.uv.array, SH = waterGeo.attributes.aShore.array;
    let v = 0;
    const put = (x, z, u, vv, sh) => {
      if (v >= W_TRI * 3) return;
      P[v * 3] = x; P[v * 3 + 1] = 0; P[v * 3 + 2] = z;
      N[v * 3] = 0; N[v * 3 + 1] = 1; N[v * 3 + 2] = 0;
      UVa[v * 2] = u; UVa[v * 2 + 1] = vv; SH[v] = sh; v++;
    };
    const tri = (a, b, c) => { put(a[0], a[1], a[2], a[3], a[4]); put(b[0], b[1], b[2], b[3], b[4]); put(c[0], c[1], c[2], c[3], c[4]); };
    if (w.closed) {
      // lake: a shallow rim skirt plus a fan, so the shallows band is a real ring
      const p = w.pts, n = p.length - 1;
      const inner = [];
      for (let i = 0; i < n; i++) {
        const dx = w.cx - p[i].x, dz = w.cz - p[i].z, l = Math.hypot(dx, dz) || 1;
        const k = Math.min(6, l * .45);
        inner.push({ x: p[i].x + dx / l * k, z: p[i].z + dz / l * k });
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, u0 = i / n, u1 = (i + 1) / n;
        tri([p[i].x, p[i].z, u0, 0, 0], [p[j].x, p[j].z, u1, 0, 0], [inner[j].x, inner[j].z, u1, 1, 1]);
        tri([p[i].x, p[i].z, u0, 0, 0], [inner[j].x, inner[j].z, u1, 1, 1], [inner[i].x, inner[i].z, u0, 1, 1]);
        tri([inner[i].x, inner[i].z, u0, 1, 1], [inner[j].x, inner[j].z, u1, 1, 1], [w.cx, w.cz, .5, 2, 1]);
      }
    } else {
      const p = w.pts, half = w.half;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        const ax = b.x - a.x, az = b.z - a.z, l = Math.hypot(ax, az) || 1;
        const nx = -az / l, nz = ax / l;
        const bp = p[Math.min(i + 2, p.length - 1)];
        const bx = bp.x - b.x, bz = bp.z - b.z, l2 = Math.hypot(bx, bz) || 1;
        const mx = -bz / l2, mz = bx / l2;
        // Taper the last few segments at BOTH ends to nothing. A ribbon that stops
        // at full width ends on a chord: a straight cut across a field, which is
        // the first thing the eye finds in a wide riverside framing. Narrowing it
        // into the haze reads as "the river carries on out there".
        const tp = k => Math.min(1, Math.min(k, p.length - 1 - k) / 4.5);
        const wa = half * tp(i) * (1 + .12 * Math.sin(i * .7));
        const wb = half * tp(i + 1) * (1 + .12 * Math.sin((i + 1) * .7));
        const u0 = i * .12, u1 = (i + 1) * .12;
        const L0 = [a.x + nx * wa, a.z + nz * wa, u0, 0, 0], C0 = [a.x, a.z, u0, .5, 1], R0 = [a.x - nx * wa, a.z - nz * wa, u0, 1, 0];
        const L1 = [b.x + mx * wb, b.z + mz * wb, u1, 0, 0], C1 = [b.x, b.z, u1, .5, 1], R1 = [b.x - mx * wb, b.z - mz * wb, u1, 1, 0];
        tri(L0, L1, C1); tri(L0, C1, C0); tri(C0, C1, R1); tri(C0, R1, R0);
      }
    }
    for (let k = v; k < W_TRI * 3; k++) { P[k * 3] = P[k * 3 + 1] = P[k * 3 + 2] = 0; }
    for (const k of ['position', 'normal', 'uv', 'aShore']) waterGeo.attributes[k].needsUpdate = true;
    waterGeo.setDrawRange(0, v - (v % 3));
    water.visible = v >= 3;
  }

  /* ═══ 4-6. FIELDS · BLADES · FLORA — one instanced mesh each ═══ */
  // Every instanced material shares this treatment: a wall-clock sway, the same
  // radial fade to fog, the same night uniform. Distinct cache keys keep the
  // program cache from confusing them with each other or with core's materials.
  // `decl` / `pre` let ONE material in the family add its own vertex work
  // without a second onBeforeCompile fighting this one over the same #include
  // markers — the flora's bare-crown deform has to run BEFORE the sway and the
  // world transform, and chaining two compilers cannot guarantee that.
  /** @param {number[]} [wx] [snowK, wetK] — how much of the settled weather this
   *  family takes. A field decal is flat ground and takes nearly all of it; a
   *  tuft of crop sticking up through it takes most; a tree canopy takes a
   *  little, because snow on a bare crown is a rime on twigs and not a white
   *  blanket. Omitted ⇒ the family is untouched and the shader is byte-identical
   *  to what it was. */
  function dressInstanced(mat, key, sway, fadeK, decl, pre, wx) {
    mat.customProgramCacheKey = () => key;
    mat.onBeforeCompile = s => {
      Object.assign(s.uniforms, {
        uFade: U.uFade, uCenter: U.uCenter, uTime: U.uTime, uWind: U.uWind,
        uNight: U.uNight, uNightCol: U.uNightCol, uFog: U.uFog,
        uLandFar: U.uLandFar, uReach: U.uReach, uWet: U.uWet, uSnow: U.uSnow
      });
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          ${CHUNK_REACH}
          attribute float aPhase; attribute float aSway;
          uniform vec2 uFade; uniform vec2 uCenter; uniform float uTime; uniform float uWind;
          varying float vFade;
          ${decl || ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          ${pre || ''}
          ${sway ? `transformed.x += aSway * max(transformed.y, 0.0) *
            (sin(uTime * 0.00042 * uWind + aPhase) + 0.32 * sin(uTime * 0.00117 * uWind + aPhase * 2.7));` : ''}
          #ifdef USE_INSTANCING
            vec4 envW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #else
            vec4 envW = modelMatrix * vec4(transformed, 1.0);
          #endif
          vec2 envD = envW.xz - uCenter;
          float envWb = envReach(atan(envD.y, envD.x));
          vFade = smoothstep(uFade.x * envWb, uFade.y * envWb, length(envD));`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; uniform vec3 uNightCol; uniform vec3 uLandFar;
          uniform float uWet; uniform float uSnow;
          varying float vFade;
          ${CHUNK_NIGHT}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          ${wx ? `diffuseColor.rgb *= 1.0 - ${wx[1].toFixed(2)} * uWet;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.81, 0.85),
                                 smoothstep(0.03, 0.80, uSnow) * ${wx[0].toFixed(2)});` : ''}
          diffuseColor.rgb = envNight(diffuseColor.rgb, uNightCol, uNight * 0.80);`)
        // Fading crops and hedgerows into the SKY's bottom stop bleached them
        // into pale amoeba blotches — puddles and fog patches rather than fields
        // — well before the horizon. They now converge on the same far-land value
        // as the ground under them, and the curve is squared so a decal holds its
        // own hue through the middle distance and only lets go at the very rim.
        .replace('#include <fog_fragment>', `#include <fog_fragment>
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uLandFar, vFade * vFade * ${fadeK.toFixed(2)});`);
    };
    return mat;
  }
  function instAttrs(geo, n) {                       // per-instance sway phase/amount
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aSway', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  }

  const fieldTex = mkFieldTex(aniso);
  const fieldGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  fieldGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  fieldGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(N_FIELD * 2), 2));
  instAttrs(fieldGeo, N_FIELD);
  const fieldMat = dressInstanced(new THREE.MeshLambertMaterial({
    map: fieldTex, transparent: true, depthWrite: false, vertexColors: true, side: THREE.DoubleSide
  }), 'env-field', false, .70, null, null, [0.86, 0.20]);
  const fieldBase = fieldMat.onBeforeCompile;
  fieldMat.onBeforeCompile = s => {                  // + the atlas cell offset
    fieldBase(s);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n attribute vec2 aCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n #ifdef USE_MAP\n vMapUv = vMapUv * 0.25 + aCell;\n #endif');
  };
  const fields = new THREE.InstancedMesh(fieldGeo, fieldMat, N_FIELD);
  fields.castShadow = fields.receiveShadow = false;
  fields.frustumCulled = false; fields.renderOrder = -2;
  group.add(fields);

  const cropTex = mkCropTex(aniso);
  const bladeGeo = mkBladeGeo();
  instAttrs(bladeGeo, nBlade);
  const bladeMat = dressInstanced(new THREE.MeshLambertMaterial({
    map: cropTex, alphaTest: .45, vertexColors: true, side: THREE.DoubleSide
  }), 'env-blade', true, .70, null, null, [0.86, 0.20]);
  // A tuft is three vertical crossed quads whose normals all point UP (that is
  // what makes crop read as soft foliage rather than as cardboard). DOUBLE_SIDED
  // flips the normal on back faces, so every quad facing away from the camera got
  // a DOWNWARD normal, took only the hemisphere's ground colour and rendered as a
  // black scribble on the grass. Undo the flip: for this kit both sides are the
  // same side.
  const bladeBase = bladeMat.onBeforeCompile;
  bladeMat.onBeforeCompile = s => {
    bladeBase(s);
    s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n normal = normalize( vNormal );');
  };
  const blades = new THREE.InstancedMesh(bladeGeo, bladeMat, nBlade);
  blades.castShadow = blades.receiveShadow = false;
  blades.frustumCulled = false;
  group.add(blades);

  const floraGeo = mkFloraGeo();
  instAttrs(floraGeo, N_FLORA);
  // aBare: how bare THIS instance's crown is, 0..1, resolved on the CPU at
  // repark (see seasonOfInstance). A wall, a sheep and a haystack are always 0.
  floraGeo.setAttribute('aBare', new THREE.InstancedBufferAttribute(new Float32Array(N_FLORA), 1));
  // WINTER IS A SILHOUETTE PROBLEM, NOT A COLOUR PROBLEM. Recolouring a full
  // cone grey-brown reads as a dead asset — everyone knows the shape of a bare
  // tree. Narrowing the crown to 58 % and letting it stand 10 % taller turns the
  // fat summer blob into a fine upright twig mass with the trunk showing through
  // at the bottom, which is what a leafless oak at 120 units actually is. Three
  // instructions on the vertex, no geometry, no draw call, and it costs the
  // other eight months exactly nothing because aBare is 0 for all of them.
  const floraMat = dressInstanced(new THREE.MeshLambertMaterial({ vertexColors: true }), 'env-flora', true, .70,
    'attribute float aFol; attribute float aBare;',
    `float envBk = aFol * aBare;
     transformed.xz *= 1.0 - 0.34 * envBk;
     transformed.y *= 1.0 + 0.06 * envBk;`,
    // A canopy takes the least of the settled weather of anything out here: snow
    // on a bare crown is rime caught on twigs, and a laden evergreen is the
    // exception rather than the rule. Wet foliage, on the other hand, darkens as
    // much as anything does.
    [0.34, 0.22]);
  const flora = new THREE.InstancedMesh(floraGeo, floraMat, N_FLORA);
  flora.castShadow = flora.receiveShadow = false;    // §6.4: the countryside never casts
  flora.frustumCulled = false;
  group.add(flora);

  /* ═══ 7. SKY — clouds AND birds, one mesh, orbits in the vertex shader ═══ */
  const skyGeo = new THREE.InstancedBufferGeometry();
  {
    const q = new THREE.PlaneGeometry(1, 1);
    skyGeo.setAttribute('position', q.attributes.position);
    skyGeo.setAttribute('uv', q.attributes.uv);
    skyGeo.setIndex(q.index);                       // q's attributes now live on skyGeo — do not dispose q
    const n = N_CLOUD + N_BIRD;
    skyGeo.setAttribute('aOrb', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    skyGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    skyGeo.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    skyGeo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    skyGeo.instanceCount = n;
    skyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1400);
  }
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uWind: U.uWind, uNight: U.uNight, uCenter: U.uCenter,
      uCloudA: U.uCloudA, uCloudFrac: U.uCloudFrac, uCloudCol: U.uCloudCol,
      uBirdCol: U.uBirdCol, uFog: U.uFog
    },
    vertexShader: `
      attribute vec4 aOrb; attribute float aKind; attribute float aSize; attribute float aRnd;
      uniform float uTime; uniform float uWind; uniform float uCloudFrac; uniform vec2 uCenter;
      varying vec2 vP; varying float vKind; varying float vRnd; varying float vHaze; varying float vNear;
      void main(){
        float bird = step(0.5, aKind);
        float sp = aOrb.z * mix(uWind, 1.0, bird);
        float a = aOrb.y + uTime * 0.001 * sp;
        vec3 c = vec3(uCenter.x + cos(a) * aOrb.x, aOrb.w, uCenter.y + sin(a) * aOrb.x);
        c.y += bird * sin(uTime * 0.0006 + aRnd * 9.0) * 5.0;
        // A cloud must never get BETWEEN the lens and the land. The deck sits at
        // 120-260 units, but at a wide framing the camera climbs past 190 — so a
        // cloud on the far side projects DOWN onto the countryside and pastes a
        // soft white continent over a whole district of fields and conifers.
        // Riding the deck up with the eye keeps clouds in the sky where they
        // belong; a close framing (a small town) is already below them and is
        // left exactly as it was.
        c.y += (1.0 - bird) * max(0.0, cameraPosition.y + 70.0 - aOrb.w);
        float on = mix(step(aRnd, uCloudFrac), 1.0, bird);
        float sz = aSize * on;
        // A bird is a world-sized billboard on a 150-450 unit orbit, so one that
        // swings between the camera and the town became a soft black blob the
        // size of a house: "dirt on the lens". Cap the ANGULAR size and fade the
        // last 90 units to nothing, so a bird can only ever be a bird-sized mark.
        // A cloud is 58-162 units across on a 140-760 orbit, so at a 500-unit
        // framing one can pass BETWEEN the camera and the town and become a soft
        // white continent pasted over the countryside. Both kinds fade out as they
        // approach the lens; the bird also has its angular size capped.
        float cd = distance(c, cameraPosition);
        sz = mix(sz, min(sz, cd * 0.022), bird);
        vNear = mix(smoothstep(90.0, 340.0, cd), smoothstep(40.0, 130.0, cd), bird);
        vHaze = smoothstep(120.0, 760.0, cd);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 w = c + (right * position.x + up * position.y) * sz;
        vP = uv * 2.0 - 1.0; vKind = aKind; vRnd = aRnd;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime; uniform float uNight; uniform float uCloudA;
      uniform vec3 uCloudCol; uniform vec3 uBirdCol; uniform vec3 uFog;
      varying vec2 vP; varying float vKind; varying float vRnd; varying float vHaze; varying float vNear;
      // NB: every smoothstep here runs edge0 < edge1 — the reversed form is
      // undefined behaviour in GLSL ES and some drivers take it literally.
      float blob(vec2 p, vec2 o, float r){ return 1.0 - smoothstep(r * 0.20, r, length((p - o) * vec2(1.0, 1.9))); }
      void main(){
        if (vKind > 0.5) {
          float f = sin(uTime * 0.0032 + vRnd * 31.0);
          float ax = abs(vP.x);
          float arc = 0.40 * sin(ax * 2.3) * (0.55 + 0.45 * f) - 0.05;
          float bat = 0.34 - 0.46 * ax;
          float y = mix(arc, bat, uNight);
          float m = (1.0 - smoothstep(0.05, 0.22, abs(vP.y - y))) * (1.0 - smoothstep(0.84, 1.0, ax));
          if (m < 0.03) discard;
          // Tinted toward the haze with distance so an isolated far speck
          // dissolves instead of holding full contrast against a flat sky.
          gl_FragColor = vec4(mix(uBirdCol, uFog, 0.38 + 0.46 * vHaze), m * 0.66 * vNear);
        } else {
          float a = blob(vP, vec2(0.0, -0.05), 0.98) * 0.85
                  + blob(vP, vec2(-0.44, -0.16), 0.60)
                  + blob(vP, vec2(0.42, -0.10), 0.56)
                  + blob(vP, vec2(0.08, 0.20), 0.48);
          a = smoothstep(0.30, 1.05, a);
          if (a < 0.01) discard;
          vec3 c = mix(uCloudCol, uFog, 0.42);
          gl_FragColor = vec4(c, a * uCloudA * vNear);
        }
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false; sky.renderOrder = 2;
  group.add(sky);

  /* ═══ 8. MOTES — pollen by day, fireflies by night ═══════════ */
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nMote * 3), 3));
  moteGeo.setAttribute('aRnd', new THREE.BufferAttribute(new Float32Array(nMote), 1));
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1200);
  const moteTex = mkMoteTex();
  const moteMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uNight: U.uNight, uE: U.uE, uCenter: U.uCenter,
      uMote1: U.uMote1, uMote2: U.uMote2, uMap: { value: moteTex },
      uMoteDay: U.uMoteDay,
      uPix: { value: (typeof window !== 'undefined' && window.devicePixelRatio) || 1 }
    },
    vertexShader: `
      attribute float aRnd;
      uniform float uTime; uniform float uNight; uniform float uE; uniform float uPix;
      uniform float uMoteDay; uniform vec2 uCenter;
      varying float vA;
      void main(){
        float t = uTime * 0.001;
        vec3 p = vec3(uCenter.x + position.x * uE, position.y, uCenter.y + position.z * uE);
        p.x += sin(t * 0.31 + aRnd * 13.0) * 2.6;
        p.z += cos(t * 0.27 + aRnd * 7.0) * 2.6;
        p.y += sin(t * 0.43 + aRnd * 23.0) * 1.2;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float blink = pow(0.5 + 0.5 * sin(uTime * 0.0011 + aRnd * 17.0), 4.0);
        vA = mix(uMoteDay, blink, uNight);
        // …AND A CEILING. The 1/z term is unbounded, so a mote drifting past the
        // near plane grew without limit — which is the other half of why they
        // read as smears on the glass rather than as specks in the air. A mote
        // is a speck; fireflies get more room because a glow is the point.
        gl_PointSize = min(mix(2.6, 3.6, uNight) * uPix * (260.0 / max(-mv.z, 1.0)),
                           mix(9.0, 26.0, uNight) * uPix);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform float uNight; uniform vec3 uMote1; uniform vec3 uMote2;
      varying float vA;
      void main(){
        float a = texture2D(uMap, gl_PointCoord).a * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(uMote1, uMote2, uNight), a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false; motes.renderOrder = 3;
  group.add(motes);

  /* ═══ layout: seeded band-normalised spots, re-parked on setExtent ═══ */
  // Every spot lives in BAND coordinates (band, u along the band, azimuth) plus a
  // world-unit offset from its group's origin. A hedgerow therefore keeps its real
  // length when the town doubles; only where it starts moves.
  const spots = [];                                  // flora
  const fieldSpots = [], bladeSpots = [];
  const BANDS = 4;
  /* ── how far the town actually reaches, per azimuth ──────────────
     A single scalar E is the AABB radius, so on a ribbon or a lakeside C the
     verge began 270 units out in EVERY direction — including straight across the
     empty flanks the town never occupied, which is why the near country went bald
     at big framings while the far country stayed pretty. 48 bins built once per
     epoch from the plan, normalised to their own max, pull the bands in where
     there is no town to flatter. */
  const REACH_N = 48;
  const reach = new Float32Array(REACH_N).fill(1);
  function buildReach(plan) {
    reach.fill(0);
    let maxR = 0;
    if (plan && typeof plan.plotAt === 'function' && plan.capacity > 0) {
      const n = Math.min(plan.capacity, 1400);
      for (let i = 0; i < n; i++) {
        const p = plan.plotAt(i);
        if (!p) continue;
        const rr = Math.hypot(p.x, p.z);
        const b = ((Math.atan2(p.z, p.x) / TAU + 1) * REACH_N | 0) % REACH_N;
        if (rr > reach[b]) reach[b] = rr;
        if (rr > maxR) maxR = rr;
      }
    }
    if (!(maxR > 0)) { reach.fill(1); return; }
    // one smoothing pass, then normalise: a hard step between neighbouring bins
    // would show up as a wedge cut out of the hedgerows
    const tmp = reach.slice();
    for (let i = 0; i < REACH_N; i++) {
      const a = tmp[(i + REACH_N - 1) % REACH_N], c = tmp[(i + 1) % REACH_N];
      reach[i] = Math.max(tmp[i], (a + c) * .5) / maxR;
    }
    for (let i = 0; i < REACH_N; i++) reach[i] = clamp(.42 + .58 * reach[i], .42, 1);
  }
  const reachAt = a => reach[((a / TAU + 1) * REACH_N | 0) % REACH_N];
  // The ground and field shaders read the SAME array object, so buildReach's
  // in-place rewrite is the upload — there is nothing to keep in sync.
  U.uReach.value = reach;

  function bandR(b, E) {                             // §6.3, all keyed to E
    if (b === 0) return [E * 1.00, E * 1.25];
    if (b === 1) return [E * 1.25, E * 2.20];
    if (b === 2) return [E * 2.20, E * 4.00];
    return [E * 4.00, Math.min(E * 4.5 + 220, 900)];
  }
  const BAND_W = [.22, .26, .30, .22];
  const BAND_S = [1.0, .95, .80, .55];               // the last band dissolves, §6.1(3)

  function seedSpots() {
    spots.length = 0; fieldSpots.length = 0; bladeSpots.length = 0;
    const r = rngOf(st.seed * 1103515245 + 12345);
    const prof = st.prof;
    const spineA = st.spine.length ? st.spine : [0, 1.6, 3.2, 4.8];
    const kKeys = Object.keys(prof.mix);
    let kSum = 0; for (const k of kKeys) kSum += prof.mix[k];
    const pickKind = () => {
      let x = r() * kSum;
      for (const k of kKeys) { x -= prof.mix[k]; if (x <= 0) return k; }
      return 'tree';
    };

    // — flora, in GROUPS so hedgerows are lines and copses are copses —
    let placed = 0, gi = 0;
    while (placed < N_FLORA && gi < 4000) {
      const band = (() => { let x = r(), s = 0; for (let b = 0; b < BANDS; b++) { s += BAND_W[b]; if (x < s) return b; } return BANDS - 1; })();
      const a = ((gi * 0.61803398875) % 1) * TAU + (r() - .5) * .34;   // stratified azimuth: ≥60 % of the horizon gets something
      const u = r();
      let kind = pickKind();
      if (band >= 2 && (kind === 'sheep' || kind === 'wall')) kind = 'tree';
      if (band === 0 && kind === 'tree' && prof.rows === 'spine' && r() < .5) kind = 'hedge';
      const line = kind === 'hedge' || kind === 'wall' || kind === 'terrace' || kind === 'orchard' || kind === 'reed';
      const n = line ? 3 + Math.floor(r() * 7) : (kind === 'sheep' ? 3 + Math.floor(r() * 5) : 1 + Math.floor(r() * 5));
      // direction: field boundaries follow the grain, terraces follow the contour
      let dir;
      if (kind === 'terrace' || prof.rows === 'contour') dir = a + Math.PI / 2 + (r() - .5) * .4;
      else if (prof.rows === 'spine' || prof.rows === 'valley') dir = nearestSpine(a, spineA) + (r() - .5) * .3;
      else dir = a + (r() - .5) * 1.4;
      const step = kind === 'orchard' ? 5.2 : line ? 3.4 : 4.6 + r() * 5;
      const K = KINDS[kind] || KINDS.tree;
      const rows = kind === 'orchard' ? 2 + Math.floor(r() * 2) : 1;
      for (let row = 0; row < rows && placed < N_FLORA; row++) {
        for (let i = 0; i < n && placed < N_FLORA; i++) {
          const t = (i - (n - 1) / 2) * step, s2 = (row - (rows - 1) / 2) * 5.6;
          spots.push({
            band, u, a, kind,
            ox: Math.cos(dir) * t - Math.sin(dir) * s2,
            oz: Math.sin(dir) * t + Math.cos(dir) * s2,
            yaw: line ? dir + Math.PI / 2 : r() * TAU,
            sc: 1 + (r() - .5) * 2 * K.jit,
            fixed: false, x: 0, z: 0
          });
          placed++;
        }
      }
      gi++;
    }
    // — water dressing: reeds and willows are pinned to the actual bank —
    if (st.wet && spots.length) {
      const pts = st.wet.pts, want = Math.min(190, Math.floor(pts.length * 1.5));
      for (let i = 0; i < want; i++) {
        const s = spots[Math.floor(r() * spots.length)];
        const pi = Math.floor(r() * (pts.length - 1)), p = pts[pi];
        const side = r() < .5 ? 1 : -1, off = st.wet.half + .6 + r() * 4.2;
        const j = Math.min(pts.length - 1, pi + 1);
        const dx = pts[j].x - p.x, dz = pts[j].z - p.z, l = Math.hypot(dx, dz) || 1;
        s.kind = r() < .68 ? 'reed' : 'willow';
        s.fixed = true;
        s.x = p.x + (-dz / l) * off * side;
        s.z = p.z + (dx / l) * off * side;
        s.ox = s.oz = 0; s.sc = .8 + r() * .5; s.yaw = r() * TAU;
      }
    }

    // — fields: rotated to the nearest spine, so farmland reads as surveyed —
    const fstyle = FIELD_STYLE[prof.fieldStyle] || FIELD_STYLE.block;
    // The strips do different WORK in different months, not just different
    // colours: furrows in spring, stubble and fallow after the harvest. Drawn
    // from a SEPARATE stream so the season cannot shift the scatter the main
    // stream lays down — same seed, same field positions, all year.
    const rs = rngOf((st.seed ^ 0x5EA50117) >>> 0);
    const S = st.season;
    const cut = S.turn * .62 + S.bleak * .80, plough = S.fresh * .55;
    for (let i = 0; i < N_FIELD; i++) {
      const a = ((i * 0.61803398875) % 1) * TAU + (r() - .5) * .3;
      let style = fstyle[(r() * 4) | 0];
      if (rs() < cut) style = rs() < .5 ? 1 : 3;              // stubble · fallow
      else if (rs() < plough) style = 0;                      // freshly furrowed
      fieldSpots.push({
        a, u: r(), band: r() < .72 ? 1 : 2,
        cell: style + 4 * ((r() * 4) | 0),
        size: 13 + r() * 22, yaw: nearestSpine(a, spineA) + (r() - .5) * .22,
        col: Math.floor(r() * 4), sq: .55 + r() * .8
      });
    }
    // — blades: crop cards, inside 1.6E only —
    for (let i = 0; i < nBlade; i++) {
      bladeSpots.push({ a: r() * TAU, u: r(), sc: .42 + r() * .62, yaw: r() * TAU, col: Math.floor(r() * 4) });
    }
    // — sky: clouds slow (6-14 min laps), birds slow (40-90 s) —
    const orb = skyGeo.attributes.aOrb.array, kd = skyGeo.attributes.aKind.array;
    const sz = skyGeo.attributes.aSize.array, rn = skyGeo.attributes.aRnd.array;
    // Birds fly in SKEINS, not as 42 independent specks. Scattered one by one
    // across the whole sky at wildly varying apparent sizes they read as sensor
    // dust; five flocks that share a radius, a height, a heading and a scale read
    // as wildlife, and a low horizon band keeps them out of the empty top of the
    // frame where a lone speck has nothing to belong to.
    const SKEINS = 5, perSkein = Math.ceil(N_BIRD / SKEINS);
    const sk = [];
    for (let s = 0; s < SKEINS; s++) {
      sk.push({
        rad: 190 + r() * 260, ang: r() * TAU, y: 40 + r() * 46,
        lap: 46 + r() * 44, dir: r() < .5 ? 1 : -1, size: 2.6 + r() * 1.5
      });
    }
    for (let i = 0; i < N_CLOUD + N_BIRD; i++) {
      const bird = i >= N_CLOUD;
      if (bird) {
        const f = sk[Math.floor((i - N_CLOUD) / perSkein)] || sk[0], j = (i - N_CLOUD) % perSkein;
        // a loose V: each bird trails the leader by a little arc and a little drop
        orb[i * 4] = f.rad + (j % 2 ? 1 : -1) * (4 + j * 2.4);
        orb[i * 4 + 1] = f.ang - f.dir * j * .011;
        orb[i * 4 + 2] = (TAU / f.lap) * f.dir;
        orb[i * 4 + 3] = f.y + j * .9;
        sz[i] = f.size * (1 - j * .015);
      } else {
        orb[i * 4] = 140 + r() * 620;
        orb[i * 4 + 1] = r() * TAU;
        orb[i * 4 + 2] = (TAU / (360 + r() * 480)) * (r() < .5 ? 1 : -1);
        orb[i * 4 + 3] = 120 + r() * 140;
        sz[i] = 58 + r() * 104;
      }
      kd[i] = bird ? 1 : 0;
      rn[i] = r();
    }
    for (const k of ['aOrb', 'aKind', 'aSize', 'aRnd']) skyGeo.attributes[k].needsUpdate = true;
    // — motes, in units of E so they follow the town without a rewrite —
    const mp = moteGeo.attributes.position.array, mr = moteGeo.attributes.aRnd.array;
    for (let i = 0; i < nMote; i++) {
      const a = r() * TAU, rr = .35 + r() * .95;
      mp[i * 3] = Math.cos(a) * rr; mp[i * 3 + 1] = .6 + r() * 5.4; mp[i * 3 + 2] = Math.sin(a) * rr;
      mr[i] = r();
    }
    moteGeo.attributes.position.needsUpdate = true;
    moteGeo.attributes.aRnd.needsUpdate = true;
  }
  function nearestSpine(a, list) {
    let best = list[0], bd = 9;
    for (const s of list) {
      let d = Math.abs(((a - s + Math.PI) % TAU + TAU) % TAU - Math.PI);
      d = Math.min(d, Math.PI - d);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /* ── colours resolved per biome + palette ── */
  function colorFor(name, out) {
    const b = st.biome, p = st.palette, S = st.season;
    switch (name) {
      case 'tree': out.set(b.tree); break;
      case 'willow': out.set(b.tree).lerp(_c2.set(0xB6C77E), .34); break;
      case 'hedge': out.set(b.tree).lerp(_c2.set(0x2E3D24), .30); break;
      case 'stone': out.set(0x9A968C); break;
      case 'earth': out.set(0x87765A); break;
      // A reed bed is straw from October to March and never grows a new leaf in
      // between — it is the one piece of flora whose whole year is colour.
      case 'reed': out.set(0xA9AE68)
        .lerp(_c2.set(0xB6A473), .62 * S.turn).lerp(_c2.set(0xA79C84), .58 * S.bleak); break;
      // A stack that has stood in a field since August is a duller, greyer straw
      // by January than the one that was just built, and it is the brightest
      // object in the countryside, so it is the one that has to weather.
      case 'hay': out.set(0xD5BC7A).lerp(_c2.set(0xA79769), .55 * S.bleak); break;
      case 'wool': out.set(0xE3DFD2); break;
      default: out.set(b.grass);
    }
    // In leaf, the canopy still knows what month it is: the new green of May is
    // a lighter, yellower thing than the tired dark green of late August.
    if (name === 'tree' || name === 'willow' || name === 'hedge') {
      if (S.fresh > .01) out.lerp(_c2.set(0x5C7A3A), .34 * S.fresh);
      if (S.dry > .01) out.lerp(_c2.set(0x555C33), .26 * S.dry);
    }
    if (p && isFinite(p.ground)) out.lerp(_c2.set(p.ground), .12);
    // the flora kit is pale so instanceColor multiplies: pre-brighten to compensate
    out.multiplyScalar(1.55);
    out.r = Math.min(out.r, 1.6); out.g = Math.min(out.g, 1.6); out.b = Math.min(out.b, 1.6);
    return out;
  }

  /* ── the turn, per tree ──────────────────────────────────────
     A GLOBAL HUE SHIFT IS THE TELL. Every tree turning on the same afternoon
     reads as a filter; a lane where one beech has gone over, its neighbour is
     half-and-half and the ash at the end is still green reads as October. So
     each instance evaluates the SAME canopy windows at its own phase offset —
     ±16 days, deterministic from the instance index, and the offset is shared
     between the turn and the fall so a late turner also holds its leaves late.
     `jit` also picks which of the five turners it is and whether it is one of
     the quarter that are evergreen and do none of this.
     Returns the bare amount and writes the canopy colour into `out`. */
  function canopyOf(out, i, kind) {
    const S = st.season, q = S.q;
    const K = KINDS[kind] || KINDS.tree;
    let dec = K.dec;
    const jit = h2(i * .7351 + 3.17, i * .1173 - 1.71);
    if (kind === 'tree' && jit < CONIFER_FRAC) dec = 0;      // holly, yew, scots pine
    colorFor(K.col, out);
    if (dec <= 0) return 0;
    const off = (jit - .5) * .090;                           // ±16 days
    const leaf = smooth(LEAF_ON0 + off * .6, LEAF_ON1 + off * .6, q)
      * (1 - smooth(LEAF_OFF0 + off, LEAF_OFF1 + off, q));
    const turn = smooth(TURN0 + off, TURN1 + off, q) * (1 - smooth(TURN2, TURN3, q));
    const bare = dec * (1 - leaf);
    // Colour first, then bareness on top of it: a half-stripped tree in November
    // is a brown tracery with the last rusty leaves still on it, which is a lerp
    // from the turned colour toward the twig colour, not from green.
    if (turn > .001) out.lerp(AUTUMN[Math.min((jit * 5) | 0, 4)], turn * dec * .92);
    if (bare > .001) out.lerp(BARE_CANOPY, bare * .88);
    // Blossom belongs to the orchard first, the hedgerow second (blackthorn and
    // hawthorn are the whitest thing in an English May) and only some of the
    // standing trees.
    if (S.blossom > .01) {
      const bl = S.blossom * (kind === 'orchard' ? .85 : kind === 'hedge' ? .40 : jit < .35 ? .42 : .06);
      if (bl > .01) out.lerp(BLOSSOM_CANOPY, bl);
    }
    return bare;
  }
  // §6.4, quantified: the further out, the less it is allowed to say. Desaturate
  // 10 → 40 % and darken, so nothing past the verge can outrank a roof.
  const KNOCK = [1, .93, .86, .78];
  function knock(out, band) {
    const l = out.r * .3 + out.g * .5 + out.b * .2;
    return out.lerp(_c3.setRGB(l, l, l), .10 + .10 * band).multiplyScalar(KNOCK[band] || .78);
  }

  /* ── re-park: the one function setExtent actually costs ── */
  function repark() {
    const E = st.E, cx = st.cx, cz = st.cz;
    // DETAIL SCALES WITH THE TOWN. The bands are keyed to E, but the instances in
    // them were absolute — so at E = 90 the country is crop strips and hedgerows
    // and at E = 320 the SAME 320 field patches and 1500 trees are spread over
    // 13x the area and the land goes bald exactly when the town is at its most
    // impressive. Area grows as E^2, so the compensating scale is sqrt.
    const detK = clamp(Math.sqrt(E / 92), 1, 2.5);
    const S = st.season;
    const fp = floraGeo.attributes.aPhase.array, fs = floraGeo.attributes.aSway.array;
    const fb = floraGeo.attributes.aBare.array;
    let i = 0;
    for (; i < spots.length && i < N_FLORA; i++) {
      const s = spots[i], K = KINDS[s.kind] || KINDS.tree;
      let x, z, scl = s.sc;
      if (s.fixed) { x = s.x; z = s.z; }
      else {
        const [r0, r1] = bandR(s.band, E * reachAt(s.a));
        const rr = r0 + s.u * (r1 - r0);
        x = cx + Math.cos(s.a) * rr + s.ox;
        z = cz + Math.sin(s.a) * rr + s.oz;
        scl *= BAND_S[s.band] * (s.band === BANDS - 1 ? lerp(1, .27, s.u) : 1) * lerp(1, detK, .62);
      }
      const dist = Math.hypot(x - cx, z - cz);
      const wet = s.kind === 'reed' ? false : isWater(x, z);
      // A HAYSTACK IN APRIL IS A LIE, and it is the loudest yellow object in the
      // countryside, so it is the one that gets caught telling it. `S.hay` is a
      // probability, not a switch: the stacks appear across July and are eaten
      // away through February a few at a time.
      const noHay = s.kind === 'haystack' && h2(i * .191 + 9.4, i * .833 - 2.6) > S.hay;
      const off = wet || noHay || Math.hypot(x, z) > 900 || (!s.fixed && dist < E * reachAt(s.a) * .96);
      const y = off ? -999 : terrainAt(x, z) - (s.kind === 'sheep' ? 0 : .06);
      _e.set(0, s.yaw, 0);
      _p.set(x, y, z);
      _s.set(K.s[0] * scl, K.s[1] * scl, K.s[2] * scl);
      _m.compose(_p, _q.setFromEuler(_e), _s);
      flora.setMatrixAt(i, _m);
      fb[i] = canopyOf(_c, i, s.kind);
      knock(_c, s.fixed ? 0 : s.band);
      flora.setColorAt(i, _c);
      // A bare hedgerow rattles; a full August canopy hardly moves. Sway is a
      // per-instance attribute already, so the year rides in for nothing.
      fp[i] = (i % 97) * .37; fs[i] = K.sway * (1 + .55 * fb[i]);
    }
    for (; i < N_FLORA; i++) { _m.makeTranslation(0, -999, 0); flora.setMatrixAt(i, _m); fb[i] = 0; }
    flora.instanceMatrix.needsUpdate = true;
    if (flora.instanceColor) flora.instanceColor.needsUpdate = true;
    floraGeo.attributes.aPhase.needsUpdate = true;
    floraGeo.attributes.aSway.needsUpdate = true;
    floraGeo.attributes.aBare.needsUpdate = true;

    const cell = fieldGeo.attributes.aCell.array;
    const fpp = fieldGeo.attributes.aPhase.array;
    for (let k = 0; k < N_FIELD; k++) {
      const s = fieldSpots[k];
      const Ea = E * reachAt(s.a);
      const [r0, r1] = bandR(s.band, Ea);
      const fw = s.size * detK;
      const rr = Math.max(r0 + s.u * (r1 - r0), Ea * 1.08 + fw * .5);
      const x = cx + Math.cos(s.a) * rr, z = cz + Math.sin(s.a) * rr;
      const off = Math.hypot(x, z) > 900 || isWater(x, z);
      _e.set(0, s.yaw, 0);
      _p.set(x, off ? -999 : terrainAt(x, z) + .05, z);
      _s.set(fw, 1, fw * s.sq);
      _m.compose(_p, _q.setFromEuler(_e), _s);
      fields.setMatrixAt(k, _m);
      // Pulled a third of the way back to the grass. Straight off the biome's
      // field list they were lighter than the land around them and read at
      // framing distance as pale bald patches — puddles, not crops.
      const fl = st.biome.fields;
      _c.set(fl[s.col % fl.length]).lerp(_c2.set(st.biome.grass), .34);
      if (st.palette && isFinite(st.palette.ground)) _c.lerp(_c2.set(st.palette.ground), .10);
      // Farmland is the surface with the loudest year — it is ploughed, sown,
      // stood in ear, cut and left — so it is allowed to travel furthest.
      seasonize(_c, SEAS_FIELD);
      fields.setColorAt(k, knock(_c, s.band));
      cell[k * 2] = (s.cell % 4) * .25; cell[k * 2 + 1] = ((s.cell / 4) | 0) * .25;
      fpp[k] = k * .41;
    }
    fields.instanceMatrix.needsUpdate = true;
    if (fields.instanceColor) fields.instanceColor.needsUpdate = true;
    fieldGeo.attributes.aCell.needsUpdate = true;
    fieldGeo.attributes.aPhase.needsUpdate = true;

    const bp = bladeGeo.attributes.aPhase.array, bs = bladeGeo.attributes.aSway.array;
    for (let k = 0; k < nBlade; k++) {
      const s = bladeSpots[k];
      const Eb = E * reachAt(s.a);
      const rr = Eb * 1.02 + s.u * (Eb * .58);
      const x = cx + Math.cos(s.a) * rr, z = cz + Math.sin(s.a) * rr;
      const off = isWater(x, z);
      _e.set(0, s.yaw, 0);
      _p.set(x, off ? -999 : terrainAt(x, z), z);
      // Tuft scatter is per-AREA, so the SMALLEST town — which the camera also
      // frames closest — got the densest-looking ground: 53 houses adrift in a
      // mat of tan clumps that read as dead straw, the least busy thing in frame
      // being the town itself. `tufK` shrinks them on small extents so the ground
      // stays quiet exactly when the camera is near enough to count blades.
      const tufK = detK * clamp(E / 120, .62, 1);
      // Grass is SHORTER in winter and taller in June. Nothing else out here
      // says "cropped and cold" as cheaply as taking a third off the verge.
      const tufS = 1 - .30 * S.bleak + .08 * S.fresh;
      _s.set(s.sc * 1.5 * tufK * (1 - .12 * S.bleak), s.sc * 1.35 * tufK * tufS, s.sc * 1.5 * tufK * (1 - .12 * S.bleak));
      _m.compose(_p, _q.setFromEuler(_e), _s);
      blades.setMatrixAt(k, _m);
      // Tufts are VEGETATION: pulled nearly all the way back to the grass, and no
      // longer lifted 14 % above it, so a clump can never read as straw litter.
      const fl = st.biome.fields;
      _c.set(fl[s.col % fl.length]).lerp(_c2.set(st.biome.grass), .68)
        .multiplyScalar(1.02 + (s.col % 3) * .05);
      seasonize(_c, SEAS_TUFT);
      blades.setColorAt(k, knock(_c, 1));
      bp[k] = k * .53; bs[k] = .16;
    }
    blades.instanceMatrix.needsUpdate = true;
    if (blades.instanceColor) blades.instanceColor.needsUpdate = true;
    bladeGeo.attributes.aPhase.needsUpdate = true;
    bladeGeo.attributes.aSway.needsUpdate = true;

    U.uFade.value.set(E * 1.15, E * 2.40);
    U.uCenter.value.set(cx, cz);
    U.uE.value = E;
  }

  /* ── the year's one recolouring law ──────────────────────────
     `out` is walked toward the four seasonal targets in turn, each by its own
     surface-specific reach × that season's live strength. Because the drivers
     overlap (mid-October is turn 0.85 and litter 0.11 and dry 0.02), the result
     is a blend, not a switch — and because every surface runs the SAME four
     lerps, the grass, the stubble, the tufts and the far land can never end up
     describing different months. */
  function seasonize(out, set) {
    const S = st.season;
    if (S.fresh > .01) out.lerp(_c2.set(set.c[0]), set.k[0] * S.fresh);
    if (S.dry > .01) out.lerp(_c2.set(set.c[1]), set.k[1] * S.dry);
    if (S.turn > .01) out.lerp(_c2.set(set.c[2]), set.k[2] * S.turn);
    if (S.bleak > .01) {
      out.lerp(_c2.set(set.c[3]), set.k[3] * S.bleak);
      // WINTER TAKES A STOP OUT OF EVERYTHING, and a colour target on its own
      // cannot do that: a lerp lands on a colour, and a colour has the luminance
      // it has. This is the second half of the same statement — chroma out,
      // value down, scaled by the SAME reach the surface is already allowed
      // (set.k[3]), so the far land still moves least and the farmland most.
      // Without it the bleak targets can only recolour January; with it they
      // can darken it, which is what the month actually does.
      const b = S.bleak * set.k[3];
      const l = out.r * .3 + out.g * .5 + out.b * .2;
      // 0.32 and 0.30, not 0.40 and 0.26: at the first setting January came out
      // as one flat dead tan across the whole plate — a desert, not a country —
      // because chroma was being taken out faster than value. Winter is DARK
      // before it is grey; leaving a little colour in is what lets the hollows
      // and the banks still tell each other apart.
      out.lerp(_c3.setRGB(l, l, l), .32 * b);
      out.multiplyScalar(1 - .30 * b);
    }
    return out;
  }

  /* ── palette / biome → the uniforms that make a day look like itself ── */
  function applyPalette() {
    const b = st.biome, p = st.palette, S = st.season;
    U.uGrass.value.set(b.grass);
    U.uGrass2.value.set(b.grass).lerp(hex(b.fields[0]), .38).multiplyScalar(1.12);
    U.uStubble.value.set(b.fields[1]).lerp(hex(0x8E8558), .35);
    U.uMud.value.set(0x584C38);
    if (p && isFinite(p.ground)) {
      U.uGrass.value.lerp(_c2.set(p.ground), .30);
      U.uGrass2.value.lerp(_c2.set(p.ground), .18);
    }
    // THE SEASON GOES ON AFTER THE BIOME AND AFTER THE PALETTE, because it is a
    // bigger statement than either: the biome is what kind of day it is, the
    // year is what kind of year it is. A goldrush January is still a January,
    // just a slightly warmer one.
    seasonize(U.uGrass.value, SEAS_GRASS);
    seasonize(U.uGrass2.value, SEAS_GRASS2);
    // uStubble is what the ground shader paints the RISES and the banks with, so
    // pushing it toward straw in August burns the tops off first and leaves the
    // hollows green — which is exactly the order a real August does it in.
    seasonize(U.uStubble.value, SEAS_STUB);
    U.uMud.value.lerp(_c2.set(0x453C31), .38 * S.bleak);   // winter earth is wet earth
    // ONE ground term for two seasons. Whichever of litter and rime is stronger
    // owns the colour; they never overlap enough to need both (leaves are down
    // in November, frost arrives in December).
    // 0.56, not 0.40. With the sward finally going brown underneath it the rime
    // has something to sit ON, and at 0.40 over a green field it had been doing
    // nothing but slightly desaturating January. It is still a rime and not a
    // whitewash: the mask only fires on what the grass plate says is proud.
    if (S.frost * 1.05 > S.litter) { U.uSeasTop.value.set(RIME_COL); U.uSeasK.value = .56 * S.frost; }
    else { U.uSeasTop.value.set(LITTER_COL); U.uSeasK.value = .55 * S.litter; }
    U.uWater.value.set((p && isFinite(p.water)) ? p.water : 0x3E6E8E);
    // Winter water is a colder, flatter, more reflective thing than August water.
    if (S.bleak > .01) U.uWater.value.lerp(_c2.set(0x40566A), .34 * S.bleak);
    waterMat.color.copy(U.uWater.value);
    U.uShore.value.copy(U.uWater.value).lerp(hex(0xB9C7A0), .42);
    seasonize(U.uShore.value, SEAS_TUFT);
    U.uMote1.value.set(b.mote);
    // Petals on the wind in May, backlit dust and leaf scraps in October, almost
    // nothing at all in January. The motes are already there; the year only says
    // what colour they are and how many the day is willing to show.
    if (S.blossom > .01) U.uMote1.value.lerp(_c2.set(0xF6E8E2), .55 * S.blossom);
    if (S.turn > .01) U.uMote1.value.lerp(_c2.set(0xE4BE86), .45 * S.turn);
    if (S.bleak > .01) U.uMote1.value.lerp(_c2.set(0xD6E0E8), .50 * S.bleak);
    // A FIFTH OF WHAT IT WAS. These numbers were authored against the old
    // pipeline, which drew straight into an 8-bit sRGB buffer where everything
    // under about alpha .1 fell below the display noise floor and a mote read as
    // a small hard speck. The picture is composited in linear HDR now and
    // encoded once at the end, and that gamma lifts the whole soft tail of the
    // sprite into view — so the same mote became a 30-90 px cream disc and a
    // sweep of 60 renders reported them, correctly, as a dirty lens. Night is
    // untouched: the blink term owns it, and fireflies over the water are meant
    // to be seen.
    U.uMoteDay.value = clamp(.062 * (1 - .60 * S.bleak) + .026 * S.blossom + .014 * S.dry, .014, .095);
    // The far land is the countryside seen through most of the atmosphere there
    // is, so it travels least — but it must travel, or a bare white-frost
    // foreground runs into a green summer horizon.
    st.landTone.set(b.grass);
    seasonize(st.landTone, SEAS_LAND);
    U.uCloudCol.value.set(0xF3EFE4).lerp(hex(b.fogTint), .30);
    // The FAIR-WEATHER ground, kept so overcast can be graded off it every frame
    // without the lerp accumulating (`color.lerp(grey, k)` has no way back, and a
    // shower that passed at noon left the fields grey for the rest of the day).
    st.gBase.copy(U.uGrass.value);
    st.g2Base.copy(U.uGrass2.value);
    st.stBase.copy(U.uStubble.value);
  }

  /* ═══ weather encodes pace — the one gag out here ═══════════ */
  function stepWeather(now, ctx) {
    const pr = (ctx && isFinite(ctx.paceRatio)) ? ctx.paceRatio : 1;
    if (pr < .5) { if (!st.slowSince) st.slowSince = now; } else st.slowSince = 0;
    const want = pr > 1.6 ? 'boom' : (st.slowSince && now - st.slowSince > 12e5) ? 'bust' : 'calm';
    if (want !== st.wx) {
      st.wxFrom = { haze: st.haze, cast: st.cast };
      st.wxTo = { haze: want === 'boom' ? 1 : 0, cast: want === 'bust' ? 1 : 0 };
      st.wxAt = now; st.wx = want;
    }
    // 8 s on the WALL CLOCK, so a --shot run lands in a settled state
    const k = st.wxTo ? smooth(0, 1, (now - st.wxAt) / 8000) : 1;
    if (st.wxTo) {
      st.haze = lerp(st.wxFrom.haze, st.wxTo.haze, k);
      st.cast = lerp(st.wxFrom.cast, st.wxTo.cast, k);
    }
  }

  /* ═══ THE LANE, once per frame ═════════════════════════════════
     Four uniform writes, no allocation, no draw call, and the only place in the
     app that turns the village TIER into something the eye can stand on.

     THE TIER EASES, ON THE WALL CLOCK. A milestone that cobbles the lanes is
     worth watching arrive, but not as a single-frame pop — so the dirt→gravel→
     cobble mix walks over six seconds of `now`, exactly as stepWeather does it
     and for the same reason: a --shot run has to land in a settled state, and
     the very first fabric of a session is a state, not a transition. */
  function stepLane(now) {
    const F = fabricNow(), S = st.season, W = st.wxBus;
    // IDENTITY, not a composed key: the fabrics are four frozen objects that live
    // for the life of the module, so `!==` is the whole comparison and this stays
    // a zero-allocation frame. (A `lane + '|' + laneColor` key was one string per
    // frame for nothing — small, but the per-frame contract out here is no
    // allocations at all and it should stay true.)
    if (F !== st.laneFab) {
      st.laneFrom.g = st.laneG; st.laneFrom.c = st.laneC;
      st.laneTo.g = F.lane === 'gravel' ? 1 : 0;
      st.laneTo.c = F.lane === 'cobble' ? 1 : 0;
      st.laneAt = st.laneFab ? now : -1e9;
      st.laneFab = F;
    }
    const k = smooth(0, 1, (now - st.laneAt) / 6000);
    st.laneG = lerp(st.laneFrom.g, st.laneTo.g, k);
    st.laneC = lerp(st.laneFrom.c, st.laneTo.c, k);

    SURF.uLaneCol.value.set(F.laneColor);
    // The day's palette owns a tenth of it, like every other surface out here —
    // enough that two mornings differ, never enough to make the lane a colour.
    if (st.palette && isFinite(st.palette.ground)) SURF.uLaneCol.value.lerp(_c2.set(st.palette.ground), .10);
    // A LANE IS EARTH AND STONE, so it does NOT take the vegetation law: nothing
    // seasonal is baked into this colour. The year reaches the road through the
    // shader's bleak / frost / litter terms instead, which is what stops January
    // arriving as a hue rotation on a road surface.
    SURF.uLaneMix.value.set(
      st.laneG, st.laneC,
      // st.inner IS ctx.plazaR — setExtent has been handing it in all along.
      Math.max(st.inner, 4),
      // The square is paved before the lanes are. A market village has a proper
      // one; a hamlet has a wide place in the road and should look like it.
      clamp((F.tier || 0) * .5, 0, 1)
    );
    const wet = (W && isFinite(W.uWet.value)) ? clamp(W.uWet.value, 0, 1) : 0;
    const dust = (W && W.uDust && isFinite(W.uDust.value)) ? clamp(W.uDust.value, 0, 1) : 0;
    const snow = (W && W.uCover && isFinite(W.uCover.value)) ? clamp(W.uCover.value, 0, 1) : 0;
    // A dry August parches a lane whether or not the sky has filed a dust regime:
    // the season is the baseline, the weather is the event on top of it.
    SURF.uLaneWx.value.set(wet, clamp(dust + .55 * S.dry, 0, 1), snow);
    SURF.uLaneSeas.value.set(S.bleak, S.frost, S.litter);
    // THE SAME WEATHER, ON THE TOWN. The lane has read the bus since it landed and
    // the buildings read nothing at all, so it could rain on a road and be dry on
    // the roof six inches above it. surface.js's 'building' and 'prop' roles take
    // these three; one write here reaches every material in the village, and no
    // module that owns a building needed a line changing. The rime is capped well
    // below the frost the LANE takes: a roof that whitens as hard as the road it
    // stands beside reads as snow, and this term is meant to read as cold.
    SURF.uTownWx.value.set(wet, snow, clamp(S.frost * .85, 0, 1));
    // …and the same two numbers reach the countryside's own materials.
    U.uWet.value = wet;
    U.uSnow.value = snow;
  }

  /* ═══ the per-frame contract: 6 uniforms, no allocations, no dt ═══ */
  function update(dt, now, ctx) {
    if (st.disposed) return;
    const t = (typeof now === 'number' && isFinite(now)) ? now : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    U.uTime.value = t;
    const night = (ctx && isFinite(ctx.night)) ? clamp(ctx.night, 0, 1) : st.night;
    st.night = night; st.day = 1 - night;
    U.uNight.value = night; U.uDay.value = 1 - night;
    stepWeather(t, ctx);
    // AFTER stepWeather and BEFORE anything that reads the sky: the lane's
    // uniforms are pure state (tier, WX, season, plaza radius) and town.js runs
    // wx.update() before env.update(), so the bus is already this frame's.
    stepLane(t);

    const b = st.biome;
    // OVERCAST IS A PROPERTY OF THE CLOUD SHEET, not only of the light. The sky
    // sprites out here are white fair-weather cumulus and they stayed white
    // fair-weather cumulus through a downpour: at street level the one thing the
    // eye could see of a rainstorm was three cheerful puffs over a blue sky. The
    // driver is weather's own skyTintK, normalised — the SAME number town.js
    // grades the dome's stops on — so the sheet and the dome can never disagree
    // about how thick the lid is.
    const wg0 = ctx && ctx.wx && ctx.wx.grade;
    const ov0 = wg0 ? clamp((+wg0.skyTintK || 0) / .70, 0, 1) : 0;
    U.uWind.value = b.wind * (1 - .6 * night) * (1 - .4 * st.cast);
    U.uCloudA.value = lerp(.85, .18, night) * (1 - .25 * st.haze) * (1 + .22 * ov0);
    U.uCloudFrac.value = clamp(.58 * b.clouds + .32 * st.cast + .42 * ov0, .2, 1);
    U.uCloudShadow.value = (1 - night) * (1 - .5 * st.haze) * (0.7 + .5 * st.cast);

    // S4 FOG HANDOVER — environs READS scene.fog and never writes it. town.js
    // sets the base (the sky's bottom stop) and weather applies the one tint
    // lerp; one writer, one value. uFog is the veil's ABOVE-horizon colour and
    // the haze the clouds and birds recede into, so it has to be the fog exactly
    // or the horizon band steps against the sky it is meant to dissolve into.
    // The pace gag that used to warm the fog here now lands on uLandFar below.
    const fog = scene && scene.fog;
    if (fog && fog.color) U.uFog.value.copy(fog.color);
    // sun direction for the water glint — read off core's own light, once
    if (!st.sunLight) {
      for (const o of scene.children) if (o.isDirectionalLight && o.castShadow) { st.sunLight = o; break; }
    }
    if (st.sunLight) {
      U.uSun.value.copy(st.sunLight.position).normalize();
      U.uSunCol.value.copy(st.sunLight.color);
      st.sunEl = U.uSun.value.y;                   // captured BEFORE the moon override
    }
    // after dusk the streak on the water is the moon's, and it is a cold one
    if (night > .5) {
      U.uSun.value.set(-.45, .72, .3).normalize();
      U.uSunCol.value.lerp(_c.set(0x9FB6D8), (night - .5) * 2);
    }

    // THE FAR LAND, one value, shared by the ground rim, the veil below the
    // horizon and — through landFar() — the town's own distance fade, so the
    // outskirts and the countryside converge on the same colour from both
    // sides. `low` is 1 with the sun on the horizon and releases both as it
    // climbs and as the sky darkens — those are the only hours where the sky's
    // bottom stop is brighter than anything on the ground, and they are exactly
    // the hours the horizon band used to blow out. The target is the biome's own
    // grass, darkened and cooled: the distance should read as land under haze.
    // st.landTone is the biome's grass with the YEAR applied (applyPalette), so
    // the distance goes straw in August and pale grey-green in January along
    // with everything in front of it. In June it is biome.grass to the bit.
    const low = (1 - smoothstep(.05, .38, clamp(st.sunEl || 1, 0, 1))) * st.day;
    // A COLD DISTANCE IS A PALE ONE. Air in January carries less water and more
    // of everything else, and the practical version of that is: the further away
    // a winter hillside is, the greyer and flatter it gets, and it gets there
    // sooner than a summer one does. The bleak coefficients here are the last
    // half of making winter read at the horizon, where the sward's own browns
    // cannot reach — and they are also what stops a brown foreground running
    // into a green far land.
    const bl = st.season.bleak;
    _c3.copy(st.landTone).multiplyScalar(.78 - .12 * bl)
      .lerp(_c2.set(0x8A94A2), .26 + .30 * bl);
    // …and when there is snow lying, the distance is where it reads first.
    if (U.uSnow.value > .01) _c3.lerp(_c2.set(0xC2C9CE), .58 * U.uSnow.value);
    U.uLandFar.value.copy(U.uFog.value)
      .lerp(_c3, .24 + .40 * low)
      .multiplyScalar(1 - .20 * low);
    // The pace gag, rehomed. It used to tint the fog, which is no longer ours;
    // washing the far LAND instead keeps it entirely below the horizon, so a
    // boom day still golds the distance (and, via landFar(), the far end of the
    // town with it) while the sky and the veil's upper band stay on core's one
    // agreed fog colour. Gold is a daylight effect and fades with the sun; the
    // overcast grey reads correctly at any hour and holds.
    // OVERCAST GRADES THE GROUND, NOT JUST THE SKY. weather dims the sun and
    // RAISES the hemisphere, so taking the warm key off a storm left the raw grass
    // albedo MORE saturated and brighter than it had been in sunshine: a vivid
    // green lawn under a dead grey sky, which reads as 'someone graded the sky and
    // forgot the ground'. Real overcast pulls the ground toward the light it is
    // lit by. Recomputed from the fair-weather base every frame, so it is a
    // function of the current sky and never a one-way walk.
    {
      const ovc = ov0;
      U.uGrass.value.copy(st.gBase).lerp(U.uFog.value, .30 * ovc);
      U.uGrass2.value.copy(st.g2Base).lerp(U.uFog.value, .30 * ovc);
      U.uStubble.value.copy(st.stBase).lerp(U.uFog.value, .24 * ovc);
      // A rain cloud is GREY. Recomputed from the biome base every frame, exactly
      // as the three above are, so a shower that passed at noon cannot leave the
      // sky grey for the rest of the day.
      U.uCloudCol.value.set(0xF3EFE4).lerp(_c2.set(b.fogTint), .30).lerp(_c2.set(0x9BA3A9), .62 * ovc);
    }
    if (st.haze > .01) U.uLandFar.value.lerp(_c.set(0xE8C08A), .20 * st.haze * st.day);
    else if (st.cast > .01) U.uLandFar.value.lerp(_c.set(0x9AA3AC), .16 * st.cast);

    // the vignette: ≤ 4 Hz, zero draw calls — and ONLY while we hold the pen.
    // postfx draws an aspect-correct vignette inside the shader and claims --vig
    // for itself; two live vignettes multiply and crush the corners with neither
    // owner looking guilty. `st.vig = -1` while someone else owns it is what makes
    // handing the property BACK work: the "moved more than .008" guard would
    // otherwise remember the last value we wrote and never re-issue it.
    if (st.vigOwned) {
      if (t - st.vigAt > 250) {
        st.vigAt = t;
        const v = 0.16 + 0.18 * night;
        if (Math.abs(v - st.vig) > .008 && typeof document !== 'undefined') {
          st.vig = v;
          document.documentElement.style.setProperty('--vig', v.toFixed(3));
        }
      }
    } else st.vig = -1;
  }

  /** postfx calls this (through town.js) when it takes or releases --vig. While
   *  `false`, environs never writes the property. */
  function setVignetteOwner(mine) {
    st.vigOwned = !!mine;
    if (!st.vigOwned) st.vig = -1;
  }

  /* ═══ public surface ═══════════════════════════════════════ */
  /** The town grew. Idempotent and safe every frame. */
  function setExtent(ext) {
    if (st.disposed || !ext) return;
    const inner = isFinite(ext.inner) ? clamp(ext.inner, 6, 40) : st.inner;
    const outer = isFinite(ext.outer) ? clamp(ext.outer, 18, 400) : st.outer;
    st.inner = inner;
    // PROPORTIONAL hysteresis. A flat 2-unit guard failed on nearly every frame
    // of a founding cascade (outer climbs 15 -> 250 monotonically), so all 1500
    // flora instances were re-parked ~70 times during the single most expensive
    // second in the app — while it was also mounting 140 building groups a frame
    // and repainting a 2048^2 road canvas. 6 % of the current reach is invisible
    // in the scatter and takes the repark count from ~70 to under 10.
    if (st.E > 0 && Math.abs(outer - st.outer) < Math.max(2, st.outer * .06)) return;
    st.outer = outer;
    // bounds.r is measured around the town's centre of mass; turn it back into an
    // origin-anchored reach + centre so a river town's fields hug the right side.
    let E = outer * 1.28, cx = 0, cz = 0;
    const tb = st.tab;
    if (tb) {
      let lo = 0, hi = tb.n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tb.bR[mid] < outer) lo = mid + 1; else hi = mid; }
      E = Math.max(tb.oR[lo] * 1.06 + 8, 32);
      cx = tb.cX[lo] * .55; cz = tb.cZ[lo] * .55;    // half-weighted: the fields lean, they don't move house
    }
    st.E = clamp(E, 32, st.maxR + 16);
    st.cx = cx; st.cz = cz;
    repark();
  }

  /** Epoch reset: new day, new plan, new palette. Rewrites in place.
   *  `lat` is optional — pass it and the southern hemisphere gets its seasons
   *  the right way round; omit it and the last known value (default 50) holds. */
  function setSeed(daySeed, newPlan, palette, lat) {
    if (st.disposed) return;
    st.daySeed = daySeed || st.daySeed;
    st.palette = palette || st.palette;
    if (isFinite(lat)) st.lat = lat;
    // Season BEFORE biome: the year weights which kind of day is likely.
    st.season = seasonFor(st.daySeed, st.lat);
    st.biome = biomeFor(st.daySeed, st.season);
    st.seed = ((newPlan && isFinite(newPlan.seed)) ? (newPlan.seed >>> 0) : 0) ^ (st.daySeed >>> 0) || 1;
    readPlan(newPlan || st.plan);
    seedTerrain();
    bakeGround();
    bakeWater();
    applyPalette();
    seedSpots();
    const prev = st.outer > 0 ? st.outer : 40;
    st.outer = -1;                                   // force the repark
    setExtent({ inner: st.inner, outer: prev });     // core re-sends the real bounds next frame
  }

  /** Countryside lines for the Gazette. They must be TRUE of what is on screen. */
  function news() {
    const out = [];
    const b = st.biome, kind = st.kind, S = st.season, add = (w, text) => out.push({ w, text });
    add(2, `The Bureau of Weather records ${b.label} conditions over the common land.`);
    // The year, and only what is actually on screen: every line below is gated on
    // the same driver that painted the thing it describes.
    if (S.blossom > .35) add(3, 'The orchard is in blossom. Work in the parish has slowed accordingly.');
    if (S.fresh > .55) add(2, 'New growth on every verge. The sheep have never been happier or less useful.');
    if (S.dry > .55) add(3, 'The upper fields have gone over to straw. Everyone agrees it looks worse and smells better.');
    if (S.turn > .30 && S.turn < .80) add(3, 'The turn has begun on the west side of the lane. The beeches went first, as always.');
    if (S.turn >= .80) add(3, 'Full colour in the hedgerows. The Bureau has stopped pretending to measure it.');
    if (S.litter > .45) add(2, 'Leaves down across the green. Sweeping has been scheduled, discussed, and postponed.');
    if (S.frost > .45) add(3, 'Hard frost on the common. The grass crunches; the Bureau finds this satisfactory.');
    if (S.bleak > .60 && S.frost < .45) add(2, 'Bare branches everywhere. The village looks larger, which nobody enjoys.');
    add(1, 'Hedgerow survey complete. Every hedge accounted for; none of them ours.');
    add(1, 'Field rotation approved for the outer strips, subject to the usual grumbling.');
    add(1, 'The haystack by the far lane has been measured, admired, and left alone.');
    if (st.night > .55) {
      add(2, 'Fireflies out over the low field. The night watch reports nothing else at all.');
      add(1, 'An owl has filed the only complaint received after dark.');
    } else {
      add(1, 'Larks counted over the west furlong: a great many, all of them moving.');
      add(1, 'Clouds pass at the pace the sky prefers. No appeal has been lodged.');
    }
    if (st.wet && kind === 'riverside') {
      add(2, 'The river runs clear past the willows; the reed beds are pronounced adequate.');
      add(1, 'Water meadows flooded to the correct depth, entirely by accident.');
    }
    if (st.wet && kind === 'lakeside') {
      add(2, 'The lake is flat, cold and full. The shore inspector has gone home satisfied.');
      add(1, 'Reeds on the near bank now tall enough to hide a small argument.');
    }
    if (kind === 'hillring') {
      add(2, 'Drystone walls repaired on the upper terraces. The sheep were unimpressed.');
      add(1, 'Sheep census: sufficient. Sheep opinion: withheld.');
    }
    if (kind === 'ribbon') add(2, 'Valley terraces holding. The wind funnels through as designed by nobody.');
    if (kind === 'crossroads') add(2, 'Roadside tree rows trimmed to the width of two carts and one apology.');
    if (b.id === 'misty') add(2, 'Mist off the low ground until noon. Distances are not to be trusted today.');
    if (b.id === 'goldrush') add(2, 'Late-summer stubble everywhere. The whole district smells of dust and money.');
    if (st.haze > .5) add(3, 'A golden haze has settled over the fields — the Bureau blames unusual activity at the kiln.');
    if (st.cast > .5) add(3, 'Overcast and still. The clouds have thickened in sympathy with the ledger.');
    return out;
  }

  /** The far-land colour: what the countryside converges to at the horizon, so
   *  anything else that fades into the distance (surface.js's uLandFar, any
   *  ledger ink) can fade to the SAME place instead of guessing a constant. It
   *  tracks the biome's grass, the live fog, sun elevation and the pace wash, and
   *  is rewritten every update() — call it per frame, never cache the value.
   *  @param {THREE.Color} [out] filled and returned if given (safe to keep)
   *  @returns {THREE.Color} `out`, or environs' OWN live instance: read it or
   *           copy it, never mutate it — every countryside material shares it. */
  function landFar(out) { return out ? out.copy(U.uLandFar.value) : U.uLandFar.value; }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    scene.remove(group);
    for (const g of [groundGeo, veilGeo, waterGeo, fieldGeo, bladeGeo, floraGeo, skyGeo, moteGeo]) g.dispose();
    for (const m of [groundMat, veilMat, waterMat, fieldMat, bladeMat, floraMat, skyMat, moteMat]) m.dispose();
    for (const t of [grassTex, fieldTex, cropTex, moteTex]) t.dispose();
    if (typeof document !== 'undefined') {
      document.documentElement.style.removeProperty('--vig');
      const s = document.getElementById('envVignette');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }
  }

  /* ── the vignette rule: base state is the FINAL state, so a throttled
       compositor can never catch it mid-animation. Skipped if the page
       already declares one. ── */
  (function vignetteCSS() {
    if (typeof document === 'undefined' || document.getElementById('envVignette')) return;
    try {
      for (const sh of document.styleSheets) {
        let rules = null;
        try { rules = sh.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rl of rules) if (rl.cssText && rl.cssText.indexOf('--vig') >= 0) return;
      }
    } catch (e) { /* a hostile stylesheet is not worth a countryside */ }
    const el = document.createElement('style');
    el.id = 'envVignette';
    el.textContent = `#stage::after{content:'';position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(ellipse at 50% 44%,rgba(0,0,0,0) 46%,rgba(0,0,0,var(--vig,0.16)) 100%)}`;
    document.head.appendChild(el);
    document.documentElement.style.setProperty('--vig', '0.16');
  })();

  /* ── boot ── */
  st.seed = ((plan && isFinite(plan.seed)) ? (plan.seed >>> 0) : 0) ^ ((opts.daySeed || 20260101) >>> 0) || 1;
  readPlan(plan);
  seedTerrain();
  bakeGround();
  bakeWater();
  applyPalette();
  seedSpots();
  setExtent({ inner: 14, outer: 40 });

  /**
   * @typedef {Object} Environs
   * @property {THREE.Group} group
   * @property {Biome} biome
   * @property {Season} season
   * @property {string} archetype
   * @property {({inner:number,outer:number})=>void} setExtent
   * @property {(dt:number,now:number,ctx:Object)=>void} update  dt IS IGNORED
   * @property {(x:number,z:number)=>number} sampleHeight
   * @property {(x:number,z:number)=>boolean} isWater
   * @property {(out?:THREE.Color)=>THREE.Color} landFar  live, do not mutate
   * @property {()=>Array<{w:number,text:string}>} news
   * @property {(daySeed:number,plan:?Object,palette:Object,lat?:number)=>void} setSeed
   * @property {()=>void} dispose
   */
  return {
    group,
    get biome() { return st.biome; },
    /** @returns {Season} live, frozen, rewritten on setSeed — safe to read. */
    get season() { return st.season; },
    get archetype() { return st.kind; },
    setExtent, update, setSeed, news, dispose, isWater, landFar, setVignetteOwner,
    sampleHeight: (x, z) => terrainAt(x, z)
  };
}
