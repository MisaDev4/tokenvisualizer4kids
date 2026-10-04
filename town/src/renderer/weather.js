// Token Town — the weather. weather.js owns the sky's STATE: eleven scalar
// channels, the calendar season, the day's climate roll, the real moon phase,
// and the shared uniform bus every other module reads weather through.
//
// THERE IS NO WEATHER ENUM AT RUNTIME. There are eleven channels, each eased
// independently on the wall clock; regimes are named target vectors. That is
// what makes "the sky never cuts" structurally true rather than a promise —
// nothing can cut, because nothing is discrete.
//
// THE DAY OWNS THE WEATHER. `daySeed` (the local calendar date) rolls the
// climate; the selected RANGE never does. Switching today→last 30 days keeps
// the same sky, snapped in — same rule that keeps the palette from repainting.
//
// NOTHING IN THIS FILE READS IDLE TIME. There is no drought, no scorched earth,
// no weather that gets worse because the user stopped working. Quiet is green.
// The only ledger reactions are upward ones: a burst gathers cloud, a very hard
// burst brings thunder, a milestone rains gold.
//
// WALL-CLOCK RULE. `update(dt, now, ctx)` IGNORES dt entirely. Channels ease on
// wall-clock time, sub-stepped at ≤500 ms so a 1 fps headless frame advances the
// exact same amount as sixty 16 ms frames. For SNAP_MS = 900 ms after init and
// after every setSeed the ease coefficient is 1, so `--shot-delay=7000` always
// lands on a settled sky, never 20 % through a crossfade.
//
// GRADE LAYERING, BINDING (backlog §4.2). Weather multiplies SCENE quantities —
// sun/hemi/moon intensity, fog density, ONE fog-colour lerp, the sky dome's
// stops, star opacity, the road plate. It never touches the image grade; postfx
// owns that and the two never read each other. `scene.fog.color` has exactly one
// writer: town.js sets the base, weather applies one lerp, environs only reads.
// ON A CLEAR DAY EVERY GRADE MULTIPLIER IS EXACTLY 1 AND EVERY TINT EXACTLY 0
// (moonMul and windMul excepted — the moon carries its phase and the wind is a
// roll), so a clear day is byte-for-byte v3's look.
//
// PUBLIC SURFACE (backlog §4.6, verbatim):
//   export const WX            frozen 8-entry uniform bus, shared by reference
//   export const REGIMES       frozen Record<regimeId, Partial<WxChannels>>
//   export const WX_LABEL      frozen Record<id, {glyph, chip, crier}>
//   export function seasonOf(dateMs, lat) → Season
//   export function climateFor(daySeed, dateMs, lat, biome) → Climate    PURE
//   export function moonPhase(dateMs) → {phase, illum, waxing, name}     PURE
//   export function initWeather(scene, cfg) →
//     { group, ch, grade, id, label, glyph, climate, settled,
//       update(dt, now, ctx), event(kind, data), setSeed(daySeed, dateMs, lat, biome),
//       setQuality(q), news(), wetnessAt(x, z), reset(), dispose() }
//   `reset()` is the one addition to §4.6: risk-register §5.3 requires every new
//   module to export reset() (epoch) and dispose() (shutdown) so F1 can register
//   them in hardReset as one list. It re-arms the current seed without re-rolling.
//
// THE MESHES. This module owns three, and all three are lazy: the geometry is not
// built until the channel that needs it first moves off zero, and the layer
// registry's want() hides it again the moment the channel decays. A CLEAR DAY
// ALLOCATES NOTHING AND DRAWS NOTHING.
//   bow    ONE draw call, 864 triangles, only while a bow is up. See THE BOW.
//   rain   ONE draw call, ZERO triangles — 2600 GL_LINES segments. See THE FALL.
//   snow   ONE draw call, ZERO triangles — 2200 GL_POINTS. See THE FALL.
// So the ceiling is three draws and 864 triangles, and the common case is zero of
// both. Rain and snow are SCENE objects standing in front of the town, not an
// overlay over the frame: they are depth-tested, so a roof hides the drops behind
// it, and they obey the layering law above exactly like the bow — they write no
// fog and postfx never hears about them.
//   IT NEEDS NOTHING NEW WIRED. It reads `ctx.camera`, which town.js has passed in
// its ctx since v4, and it is armed from the `wx.event()` calls fireMilestone
// already makes. `?bow=0..1` does need one word adding to main.js's forwarded-flag
// whitelist beside 'wx' and 'season', or the flag is silently swallowed.
//
// THE FALL NEEDED NOTHING NEW WIRED EITHER. Like the bow it reads `ctx.camera`,
// which town.js has passed since v4, and it mounts itself into the layer registry
// the first frame `ch.rain`/`ch.snow` moves off zero. No new ctx field, no new
// call site, no new flag: `--wx=rain|drizzle|storm|snow|blizzard` already reaches
// this file through the forwarded-flag whitelist.
//
// COST. At most three draw calls, and only while there is something in the sky:
// this module ships the channel engine, the grade, the layer registry + budget()
// enforcer, the bow and the fall.
// MEASURED, node, 120 k frames on a storm-gathering day: 1.7 us/frame and 0.5
// bytes/frame of heap — the whole per-frame path allocates nothing, and the half
// byte is the moon object recomputed once a minute. `ch`, `grade`, the target
// vector and the solar record are hoisted and mutated in place; the state machine
// runs at 2 Hz and the budget pass is a walk over a ≤7-entry array.
// wetnessAt() is 40 ns — 160 villagers asking every frame costs 6 us.
//
// WHAT THE INTEGRATION WAVE MUST WIRE (nothing else — no new ctx fields):
//   1. import { WX, initWeather } from './weather.js'  BEFORE initEnvirons, and
//      pass the bus in:  initEnvirons(scene, plan, { …, wx: WX }).
//      Then: const wx = initWeather(scene, { daySeed, lat, quality:'high',
//              maxAnisotropy: MAXA, biome: env.biome, plazaPos: MON_POS });
//   2. In tick(), AFTER the sun/sky block and BEFORE env.update():
//        wx.update(dt, now, ctx); const G = wx.grade;
//      then apply G to sun/hemi/moon intensity, sunBall+halo opacity, the sky
//      dome's two stops, ONE fog.color lerp toward G.fogTint by G.fogTintK,
//      fog.density = fogFor(dist, env.biome) * G.fogMul, star opacity × G.starMul,
//      roadMat colour/roughness from G.wetK, and --flash from G.flash.
//      fogFor(...) * G.fogMul must ALSO be applied in refreshFraming(), or a
//      re-frame stamps the mist away.
//   3. The wind clock: `windClock += (now - windLast) * G.windMul` and drive the
//      spin/sway entities off windClock instead of `now` — multiplying `now`
//      teleports the sails whenever the wind changes. Not monument.js's spins.
//   4. hardReset → wx.setSeed(daySeed, Date.now(), lat, env.biome); wx.reset().
//      fireMilestone → wx.event('milestone'|'best'|'tierUp', data).
//      placeLandmark → wx.event('landmark').  startRitual → wx.event('boot').
//   5. initNews({ country: () => env.news().concat(wx.news()) }).
//   6. #wxChip in the header: wxChip.textContent = wx.glyph + ' ' + wx.label,
//      written on the existing 500 ms stats tick.
//   Environs reads uGust/uCloud/uWet/uCover/uDust off the bus. The bus is FROZEN
//   at eight entries, so environs' rain-pocked water must ride `uWet` (which is
//   high for the whole shower and decays slowly after it) rather than a uRain
//   that does not exist.
import * as THREE from './vendor/three.module.js';

/* ═══ helpers (this file is the sky, whole — no sibling imports) ═══ */
const TAU2 = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
const isNum = v => typeof v === 'number' && isFinite(v);
/** mulberry32 — same generator environs and layout use, so "seeded" means one thing. */
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
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}
const wallNow = n => isNum(n) ? n : (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ═══ test hooks — parsed here, not in town.js (§6.1) ═══════════ */
const QS = (() => {
  try { return new URLSearchParams((typeof location !== 'undefined' && location.search) || ''); }
  catch (e) { return new URLSearchParams(''); }
})();
const qNum = k => { const v = QS.get(k); return v === null || v === '' || !isFinite(+v) ? null : +v; };
const HOUR_PIN = qNum('hour');
const MOON_PIN = qNum('moon');
const COVER_PIN = qNum('wxcover');
const WXI_PIN = qNum('wxi');
const SEASON_PIN = QS.get('season');
/** `?bow=0..1` pins the rainbow channel outright, so a bow can be photographed on
 *  demand instead of waited for. It pins the CHANNEL and nothing else: the sun is
 *  still where the sun is, so `?bow=1&hour=12` correctly shows no bow at all (the
 *  whole circle is under the horizon) and `?bow=1&hour=18` shows a tall one. That
 *  is the point — the flag proves the physics rather than bypassing it. */
const BOW_PIN = (() => { const v = qNum('bow'); return v === null ? null : clamp(v, 0, 1); })();

/* ═══ the uniform bus ═══════════════════════════════════════════
   Plain {value} objects at module scope, shared BY REFERENCE with environs' U
   dict, buildings' material patch and (from S3) weather's own materials. One
   write reaches everything. Frozen at eight entries by backlog §4.6: adding a
   ninth is a contract change, not a convenience. */
export const WX = Object.freeze({
  uWet: { value: 0 },                            // 0..1  settled water: darker albedo, grazing sheen
  uCover: { value: 0 },                          // 0..1  settled snow on upward faces
  uGust: { value: 1 },                           // .35..2.6  multiplies environs' uWind
  uDust: { value: 0 },                           // 0..1  late-summer haze: warm, bleached ground
  uCloud: { value: 0.1 },                        // 0..1  overcast fraction → environs' cloud count
  uWxT: { value: 0 },                            // performance.now(): the ONE clock for weather motion
  uWindV: { value: new THREE.Vector2(1, 0) },    // unit heading the weather travels
  uFlash: { value: 0 }                           // 0..1  lightning, a 90 ms impulse
});

/* ═══ the eleven channels ═══════════════════════════════════════
   @typedef {Object} WxChannels  0..1 unless noted
   rain snow gold — falling; gold is the reward channel
   cover wet      — SETTLED state: history, not a function of the current regime
   cloud mist dust bow aurora — sky state
   gust           — WIND, .35 … 2.60, resting 1.0 (NOT 0..1) */
const CH_KEYS = Object.freeze(['rain', 'snow', 'gold', 'cover', 'wet', 'cloud', 'mist', 'dust', 'bow', 'aurora', 'gust']);
const HOLD = Object.freeze({ cover: 1, wet: 1 });   // absent from a regime ⇒ hold, don't zero

const TAU_IN = Object.freeze({
  rain: 6000, snow: 9000, gold: 1400,            // gold arrives fast — it is a reward
  cover: 240000, wet: 12000,                     // settled state is slow…
  cloud: 8000, mist: 20000, dust: 45000,         // …and haze creeps in, it does not slam
  bow: 4000, aurora: 15000, gust: 4500
});
const TAU_OUT = Object.freeze({                  // asymmetric where it reads better
  gold: 5000,                                    // money stops falling reluctantly
  wet: 150000,                                   // roads stay dark long after the rain
  cover: 900000, bow: 9000, mist: 40000, dust: 90000
});

/**
 * Named target vectors. Unlisted channels resolve to 0, except `gust` (1.0) and
 * `cover`/`wet`, which HOLD — the difference between snow that vanishes the
 * instant it stops falling and a town that stays white all afternoon.
 * `thunder` is a flag, not a channel: it arms the strike scheduler.
 * REGIMES.drought and REGIMES.scorched are deliberately absent (backlog §1:
 * negative feedback for not spending tokens is cut, and it is not coming back).
 */
export const REGIMES = Object.freeze({
  clear: Object.freeze({ cloud: .10, gust: 1.00 }),
  fair: Object.freeze({ cloud: .32, gust: 1.00 }),
  overcast: Object.freeze({ cloud: .82, gust: 0.80 }),
  drizzle: Object.freeze({ rain: .28, cloud: .70, gust: 0.85, wet: .55 }),
  rain: Object.freeze({ rain: .68, cloud: .88, gust: 1.15, wet: .90 }),
  downpour: Object.freeze({ rain: 1.00, cloud: .96, gust: 1.50, wet: 1.00 }),
  storm: Object.freeze({ rain: .85, cloud: 1.00, gust: 2.10, wet: 1.00, thunder: 1 }),
  flurry: Object.freeze({ snow: .30, cloud: .72, gust: 0.75, cover: .35 }),
  snow: Object.freeze({ snow: .72, cloud: .90, gust: 0.90, cover: .85 }),
  blizzard: Object.freeze({ snow: 1.00, cloud: 1.00, gust: 2.40, cover: 1.00 }),
  mist: Object.freeze({ mist: .85, cloud: .35, gust: 0.45 }),
  // The one warm-and-dry regime, and it is a CALENDAR roll (high summer, and
  // twice as likely on environs' own late-summer biome) — never a reaction to
  // the user. It is the sky agreeing with the stubble, not a punishment.
  goldhaze: Object.freeze({ dust: .38, cloud: .12, gust: 1.10 }),
  goldrain: Object.freeze({ gold: 1.00, cloud: .30, gust: 0.90 }),   // impulse / pinned only
  mintdrip: Object.freeze({ gold: 0.14 })                            // reserved for W15's plaza cloud
});
const PIN = (() => { const v = QS.get('wx'); return v && REGIMES[v] ? v : null; })();

/** Chip glyph, header word and the phrase the Crier would use. */
export const WX_LABEL = Object.freeze({
  clear: Object.freeze({ glyph: '☀', chip: 'clear', crier: 'a clear sky' }),
  fair: Object.freeze({ glyph: '⛅', chip: 'fair', crier: 'a fair sky' }),
  overcast: Object.freeze({ glyph: '☁', chip: 'overcast', crier: 'an overcast sky' }),
  gather: Object.freeze({ glyph: '🌥', chip: 'gathering', crier: 'a gathering sky' }),
  drizzle: Object.freeze({ glyph: '🌦', chip: 'drizzle', crier: 'drizzle' }),
  rain: Object.freeze({ glyph: '🌧', chip: 'rain', crier: 'steady rain' }),
  downpour: Object.freeze({ glyph: '🌧', chip: 'downpour', crier: 'a downpour' }),
  storm: Object.freeze({ glyph: '⛈', chip: 'storm', crier: 'a storm' }),
  thunder: Object.freeze({ glyph: '⛈', chip: 'thunder', crier: 'thunder over the plaza' }),
  flurry: Object.freeze({ glyph: '🌨', chip: 'flurries', crier: 'flurries' }),
  snow: Object.freeze({ glyph: '🌨', chip: 'snow', crier: 'snow' }),
  blizzard: Object.freeze({ glyph: '❄', chip: 'blizzard', crier: 'a blizzard' }),
  mist: Object.freeze({ glyph: '🌫', chip: 'mist', crier: 'mist on the low ground' }),
  goldhaze: Object.freeze({ glyph: '🌾', chip: 'haze', crier: 'a golden haze' }),
  goldrain: Object.freeze({ glyph: '🪙', chip: 'coin rain', crier: 'coins falling out of the sky' }),
  mintdrip: Object.freeze({ glyph: '🪙', chip: 'coins', crier: 'coins over the plaza' })
});

/* ═══ the calendar ══════════════════════════════════════════════ */
const SEASON_TAB = Object.freeze([
  Object.freeze({ id: 'spring', label: 'spring', rainP: .34, snowP: .04, mistP: .22, stormP: .10, hazeP: .04, auroraP: .06 }),
  Object.freeze({ id: 'summer', label: 'high summer', rainP: .20, snowP: .00, mistP: .10, stormP: .22, hazeP: .18, auroraP: .00 }),
  Object.freeze({ id: 'autumn', label: 'autumn', rainP: .36, snowP: .03, mistP: .34, stormP: .08, hazeP: .05, auroraP: .12 }),
  Object.freeze({ id: 'winter', label: 'deep winter', rainP: .20, snowP: .32, mistP: .20, stormP: .03, hazeP: .02, auroraP: .24 })
]);
const SEASON_IDX = Object.freeze({ spring: 0, summer: 1, autumn: 2, winter: 3 });

/**
 * @typedef {Object} Season
 * @property {number} t 0..1 around the year; 0 = the vernal equinox
 * @property {0|1|2|3} idx  @property {string} id  @property {string} label
 * @property {number} rainP @property {number} snowP @property {number} mistP
 * @property {number} stormP @property {number} hazeP @property {number} auroraP
 * @property {number} coldness 0 (August) … 1 (January) — drives snow-vs-rain and the aurora
 *
 * `?season=winter` pins the quarter and its probabilities but leaves `t` and
 * `coldness` on the real calendar, so a pinned season still has a real sun.
 * @param {number} dateMs @param {?number} lat @returns {Season}
 */
export function seasonOf(dateMs, lat) {
  const ms = isNum(dateMs) ? dateMs : Date.now();
  const d = new Date(ms);
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);   // 1..366, local
  let t = ((doy - 79) / 365.2422) % 1;                                     // 79 ≈ 20 March
  if (t < 0) t += 1;
  if ((isNum(lat) ? lat : 50) < 0) t = (t + 0.5) % 1;                      // the feed knows where you are
  let idx = Math.floor(t * 4 + 0.5) % 4;                                   // equinox-centred quarters
  if (SEASON_PIN && SEASON_IDX[SEASON_PIN] !== undefined) idx = SEASON_IDX[SEASON_PIN];
  // 1 at the winter solstice, 0 at the summer one. (The design doc's sign is
  // inverted: with t = 0 at the VERNAL equinox, +cos is the cold end of the year.)
  const coldness = 0.5 + 0.5 * Math.cos((t + 0.25) * TAU2);
  return Object.freeze(Object.assign({ t, idx, coldness }, SEASON_TAB[idx]));
}

/** The calendar day the SEED names, so `daySeed` owns the season outright and a
 *  clock that has crossed midnight (or a `dateMs` from a different epoch) cannot
 *  put July's sky over a February day. A `?seed=` override that is not a real
 *  YYYYMMDD falls back to the wall date. */
function seasonDate(daySeed, dateMs) {
  const s = daySeed >>> 0, y = Math.floor(s / 10000), m = Math.floor(s / 100) % 100, d = s % 100;
  if (y >= 1970 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(y, m - 1, d, 12).getTime();
  return isNum(dateMs) ? dateMs : Date.now();
}

/**
 * Conway-style synodic approximation, ±0.5 day over a century. Good enough for a
 * toy, and it is RIGHT tonight, which is the whole point.
 * @param {number} dateMs @returns {{phase:number, illum:number, waxing:boolean, name:string}}
 */
const MOON_NAMES = Object.freeze(['new', 'waxing crescent', 'first quarter', 'waxing gibbous',
  'full', 'waning gibbous', 'last quarter', 'waning crescent']);
export function moonPhase(dateMs) {
  const SYN = 29.530588853, EPOCH = Date.UTC(2000, 0, 6, 18, 14);          // a known new moon
  const ms = isNum(dateMs) ? dateMs : Date.now();
  let p = MOON_PIN !== null ? MOON_PIN % 1 : (((ms - EPOCH) / 864e5) / SYN) % 1;
  if (p < 0) p += 1;
  return {
    phase: p, illum: 0.5 - 0.5 * Math.cos(p * TAU2), waxing: p < 0.5,
    name: MOON_NAMES[Math.round(p * 8) % 8]
  };
}

/**
 * @typedef {Object} Climate
 * @property {Season} season
 * @property {string} base       resting regime id for the whole day
 * @property {number} intensity  0.55..1.15 multiplier on the base regime's channels
 * @property {number} windRoll   0.65..1.45 today's prevailing wind, before gusts
 * @property {number} windDir    radians; the direction the weather travels
 * @property {boolean} morningMist @property {boolean} auroraTonight
 * @property {number} startCover 0..1 snow ALREADY on the roofs when the app opens
 * @property {string} label      'an overcast sky, and cold' — the header chip and the Crier
 *
 * PURE. Today's baseline sky, from the calendar date, the day seed and the biome
 * environs already rolled off the SAME seed — so the sky and the fields agree
 * about what kind of day it is. Reloading at 3 pm gives the sky you had at 9 am.
 * `startCover` is the one field that moves with the clock: it is a resume
 * position, not a roll (a snow day must open with snow already lying, exactly as
 * backfillGroves opens with groves already planted).
 * @param {number} daySeed YYYYMMDD @param {number} dateMs @param {?number} lat @param {?Biome} biome
 * @returns {Climate}
 */
export function climateFor(daySeed, dateMs, lat, biome) {
  const season = seasonOf(seasonDate(daySeed, dateMs), lat);
  const bid = (biome && biome.id) || 'lush';
  const r = rngOf(Math.imul((daySeed >>> 0) || 20260101, 2246822519) ^ 0x5f356495);

  // biome coupling: environs rolled the ground off the same seed, and the two
  // may not contradict each other — a misty biome under a cloudless sky reads
  // as a bug in the art direction rather than as weather.
  const rainP = season.rainP * (bid === 'spring' ? 1.3 : bid === 'goldrush' ? .6 : 1);
  const snowP = season.coldness > .45 ? season.snowP * (bid === 'heather' ? 1.2 : 1) : 0;
  const mistP = season.mistP * (bid === 'misty' ? 2.2 : 1);
  const hazeP = season.hazeP * (bid === 'goldrush' ? 1.7 : 1);
  const stormP = season.stormP;

  const w = {
    drizzle: rainP * .34, rain: rainP * .46, downpour: rainP * .20, storm: stormP,
    flurry: snowP * .42, snow: snowP * .40, blizzard: snowP * .18,
    mist: mistP, goldhaze: hazeP
  };
  let used = 0;
  for (const k in w) used += w[k];
  // clear + fair absorb the remainder and hold at least 30 % of days between
  // them — most days are just days, and that floor is what stops a wet season
  // from becoming a wet month. The weather weights are scaled DOWN to make room
  // rather than merely diluted, or the floor is not a floor after normalising.
  const REST_MIN = 0.30;
  if (used > 1 - REST_MIN) { const k = (1 - REST_MIN) / used; for (const key in w) w[key] *= k; used = 1 - REST_MIN; }
  const restW = 1 - used;
  w.clear = restW * .55; w.fair = restW * .45;

  let x = r(), base = 'fair';
  for (const k in w) { if (x < w[k]) { base = k; break; } x -= w[k]; }

  const intensity = WXI_PIN !== null ? clamp(WXI_PIN, 0, 2) : 0.55 + r() * 0.60;
  const windRoll = clamp(((biome && isNum(biome.wind)) ? biome.wind : 1) * (0.85 + r() * 0.50), 0.65, 1.45);
  const windDir = r() * TAU2;
  const morningMist = base === 'mist' || r() < clamp(mistP * 1.15, 0, .7);
  const auroraTonight = r() < season.auroraP;

  // A user opening the app on a snow day must not watch the roofs whiten from
  // zero — the snow has been falling since the small hours. The ramp reaches
  // full by 09:00: a dusting at seven, properly white by lunchtime.
  //   IT IS THE REGIME THAT IS ACTUALLY IN FORCE, not the one that rolled. `?wx=`
  // replaces the day's regime outright (resolveTarget takes the PIN branch and
  // never looks at `base`), so testing `base` here meant a FORCED snow day opened
  // with bare roofs and then needed four real minutes to lay any — which on a
  // 1 fps headless capture is never. A pinned regime also runs at k = 1 rather
  // than at the day's rolled intensity, so the ramp is read off the same number.
  const eff = PIN || base;
  const snowy = eff === 'flurry' || eff === 'snow' || eff === 'blizzard';
  const ik = PIN ? (WXI_PIN !== null ? clamp(WXI_PIN, 0, 2) : 1) : intensity;
  const startCover = COVER_PIN !== null ? clamp(COVER_PIN, 0, 1)
    : snowy ? clamp(0.35 + 0.55 * ik, 0, 1) * clamp(localHour(dateMs) / 9, 0, 1) : 0;

  const lab = WX_LABEL[base] || WX_LABEL.fair;
  const label = lab.crier + (season.coldness > .62 ? ', and cold' : season.coldness < .22 ? ', and warm' : '');
  return Object.freeze({
    season, base, intensity, windRoll, windDir, morningMist, auroraTonight, startCover, label
  });
}

/** Local hour 0..24, honouring `?hour=` so a pinned shot and the sky agree. */
function localHour(dateMs) {
  if (HOUR_PIN !== null) return clamp(HOUR_PIN, 0, 24);
  const d = new Date(isNum(dateMs) ? dateMs : Date.now());
  return d.getHours() + d.getMinutes() / 60;
}

/** Sunrise / sunset / sin(altitude), the same declination model town.js uses for
 *  its solar clock — recomputed at 2 Hz, never per frame.
 *
 *  IT ALSO RETURNS THE SUN THAT IS ACTUALLY ON SCREEN, which is a different sun.
 *  `el` above is the astronomical altitude; town.js places its key light and its
 *  sun ball on a simpler arc (`sunA`/`sunE` in tick(), off the same sr/ss), and
 *  the two disagree by several degrees. Everything in this file that only wants
 *  "how far through the day is it" can use either — but a rainbow is centred on
 *  the ANTISOLAR POINT, and a bow that is not exactly opposite the sun the user
 *  can see is a decal. So the drawn sun's unit direction is reproduced here,
 *  verbatim, and the bow is hung off `vx/vy/vz`. `vel` is its sin(altitude);
 *  `glow` is town.js's own golden-hour term, which tints the bow warm at dusk. */
function solarAt(dateMs, lat, out) {
  const ms = isNum(dateMs) ? dateMs : Date.now();
  const d = new Date(ms), la = (isNum(lat) ? lat : 50) * Math.PI / 180;
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const decl = -23.44 * Math.cos(TAU2 * (doy + 10) / 365) * Math.PI / 180;
  const cosH = clamp(-Math.tan(la) * Math.tan(decl), -1, 1);
  const half = Math.acos(cosH) / TAU2 * 24;
  const hour = localHour(ms);
  const H = (hour - 12) * 15 * Math.PI / 180;
  out.sr = 12 - half; out.ss = 12 + half; out.hour = hour;
  out.el = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H);
  // town.js, tick(): `_sd.set(cos(sunA) * 120, sin(sunE) * 110, -30)`, normalised.
  const stq = clamp((hour - out.sr) / Math.max(out.ss - out.sr, 0.1), 0, 1);
  const sunA = Math.PI * (1 - stq), sunE = Math.sin(Math.PI * stq) * 1.05 + 0.06;
  const x = Math.cos(sunA) * 120, y = Math.sin(sunE) * 110, z = -30;
  const L = Math.sqrt(x * x + y * y + z * z) || 1;
  out.vx = x / L; out.vy = y / L; out.vz = z / L; out.vel = out.vy;
  out.glow = clamp(Math.max(0, 1 - Math.abs(hour - out.sr) / 1.4, 1 - Math.abs(hour - out.ss) / 1.4), 0, 1);
  return out;
}

/* ═══ the engine ════════════════════════════════════════════════ */
const SNAP_MS = 900;      // k = 1 for this long after init / setSeed — the screenshot rule
const MAX_STEP = 500;     // ms per easing sub-step: 1 fps and 120 fps must agree
const STALL_MS = 3000;    // a longer gap is a laptop waking up: re-arm the snap instead of catching up
const PICK_MS = 500;      // the state machine runs at 2 Hz, against `now`
const MAX_DRAWS = 6;      // hard ceiling on simultaneously visible weather meshes
const AUTO_FRAMES = 240;  // never auto-downgrade before this many frames: a headless
                          // --shot run sees ~9 frames of 300 ms and would otherwise
                          // downgrade itself, silently invalidating the image.

const LEDGER = Object.freeze([
  // Priority order. Hysteresis is explicit and generous: weather that flickers is
  // worse than no weather. `dwell` = how long the entry predicate must hold
  // CONTINUOUSLY; `exit` sits far away from `enter` so nothing can oscillate.
  Object.freeze({ id: 'thunder', enter: pr => pr > 3.0, dwell: 45e3, exit: pr => pr < 2.0, r: 'storm', mixK: 1 }),
  Object.freeze({ id: 'gather', enter: pr => pr > 1.6, dwell: 90e3, exit: pr => pr < 1.1, r: 'overcast', mixK: .75 })
]);
const BOLT_ENV = Object.freeze([0.9, 0.35, 1.0, 0.2, 0.55]);   // 5 × 44 ms = a 220 ms flicker

/**
 * @typedef {Object} WeatherCfg
 * @property {number} daySeed @property {?number} lat @property {'high'|'low'} [quality]
 * @property {number} [maxAnisotropy] @property {?Biome} biome @property {THREE.Vector3} [plazaPos]
 */
/**
 * @typedef {Object} WxGrade   how town.js must grade the SCENE this frame
 * @property {number} sunMul 0.18…1.10 @property {number} hemiMul 0.75…1.35
 * @property {number} moonMul 0.15…1.25 (the phase is in here)
 * @property {number} fogMul 0.85…4.20 @property {number} fogTint 0xRRGGBB
 * @property {number} fogTintK 0…0.55 @property {number} skyTintK 0…0.70
 * @property {number} starMul 0.05…1.00 @property {number} sunBallA 0…1
 * @property {number} shadowMul 0.30…1.00 @property {number} wetK 0…1
 * @property {number} windMul 0.35…2.60 @property {number} flash 0…1
 */
/** @param {THREE.Scene} scene @param {WeatherCfg} cfg @returns {Weather} */
export function initWeather(scene, cfg) {
  const opts = cfg || {};
  const group = new THREE.Group();
  group.name = 'weather';
  if (scene && scene.add) scene.add(group);

  /** @type {WxChannels} LIVE, mutated in place, never reassigned. */
  const ch = { rain: 0, snow: 0, gold: 0, cover: 0, wet: 0, cloud: .10, mist: 0, dust: 0, bow: 0, aurora: 0, gust: 1 };
  const T = { rain: 0, snow: 0, gold: 0, cover: 0, wet: 0, cloud: .10, mist: 0, dust: 0, bow: 0, aurora: 0, gust: 1, thunder: 0 };
  /** @type {WxGrade} LIVE, mutated in place, never reassigned. */
  const grade = {
    sunMul: 1, hemiMul: 1, moonMul: 1, fogMul: 1, fogTint: 0x9AA3AC, fogTintK: 0,
    skyTintK: 0, starMul: 1, sunBallA: 1, shadowMul: 1, wetK: 0, windMul: 1, flash: 0
  };

  const st = {
    disposed: false, daySeed: (opts.daySeed >>> 0) || 20260101,
    lat: isNum(opts.lat) ? opts.lat : 50, biome: opts.biome || null,
    quality: opts.quality === 'low' ? 'low' : 'high',
    // held for the meshes S3 mounts: the splash/mist textures want the anisotropy
    // and W15's plaza cloud wants the altar's position. Nothing reads them yet.
    maxAnisotropy: isNum(opts.maxAnisotropy) ? opts.maxAnisotropy : 1,
    plazaPos: (opts.plazaPos && opts.plazaPos.isVector3) ? opts.plazaPos : new THREE.Vector3(),
    climate: null, moon: null, moonAt: -1e9,
    last: -1, snapUntil: 0, pickAt: -1e9, settled: false,
    /** the engaged ledger rule and the wall clock it engaged at (the chip's receipt) */
    led: null, ledSince: 0, arm: { thunder: 0, gather: 0 },
    id: 'clear', label: WX_LABEL.clear.crier, glyph: WX_LABEL.clear.glyph, idAt: -1e9, idWant: 'clear',
    goldA: 0, goldUntil: 0, gustUntil: 0, bowFrom: 0, bowUntil: 0,
    rainPeak: 0, rainPeakAt: -1e9, auroraFlareUntil: 0,
    boltAt: 0, boltT0: -1e9, boltAz: 0,
    frames: 0, ewma: 16, autoDropped: false, draws: 0, cloud0: 0.10,
    pOff: 0, night: 0, tokenGlow: 0
  };
  const sun = { sr: 6, ss: 20, hour: 12, el: .5, vx: 0, vy: 1, vz: 0, vel: 1, glow: 0 };
  /** ONE clock for the whole system: whatever `now` update() was last handed,
   *  falling back to performance.now() before the first frame. event() and
   *  setSeed() must schedule against the same clock the channels ease on, or an
   *  impulse fired from a call site holding a different time source lands in the
   *  past and never plays. */
  const clock = () => st.last >= 0 ? st.last : wallNow();

  /* ── the layer registry. Tenants mount here in PRI order (highest first) and
       budget() is what stops the sky quietly doubling the countryside's own
       eight-draw ceiling. Three tenants so far — bow, rain, snow — and every one
       of them mounts itself the first frame its channel is non-zero, so on a
       clear day with no milestone this list stays EMPTY and weather still costs
       zero draw calls, zero triangles and zero bytes of GPU memory. ── */
  const layers = [];
  /** @param {THREE.Object3D} mesh @param {string} key @param {()=>boolean} want
   *  @param {(q:string)=>void} [quality] */
  function mount(mesh, key, want, quality) {
    if (st.disposed || !mesh) return null;
    const L = { key, mesh, want, quality: quality || null };
    mesh.visible = false;
    mesh.frustumCulled = false;
    layers.push(L); group.add(mesh);
    return L;
  }
  /** Priority pass: the first MAX_DRAWS layers that WANT to be visible are, the
   *  tail is hidden. A hard invariant, not a hope. @returns {number} draw calls */
  function budget() {
    let n = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      let w = false;
      try { w = !!L.want(); } catch (e) { w = false; }
      L.mesh.visible = w && ++n <= MAX_DRAWS;
    }
    st.draws = Math.min(n, MAX_DRAWS);
    return st.draws;
  }

  /* ── seeding ── */
  function roll(daySeed, dateMs, keepState) {
    const seed = (daySeed >>> 0) || st.daySeed;
    const same = keepState && seed === st.daySeed;
    st.daySeed = seed;
    const c = climateFor(seed, dateMs, st.lat, st.biome);
    // startCover is decided ONCE, at the start of the day: a range change re-runs
    // this at a later hour and must not hand the roofs more snow than the morning
    // laid. Everything else in Climate is already pure in the seed.
    st.climate = (same && st.climate) ? Object.freeze(Object.assign({}, c, { startCover: st.climate.startCover })) : c;
    // The clear-sky resting cloud for THIS day, under the same scaling layer 0
    // applies — so `over` (and therefore the whole grade) is exactly 0 at rest
    // whatever the intensity rolled, and whatever `?wx=`/`?wxi=` pinned.
    st.cloud0 = clamp(REGIMES.clear.cloud * (PIN ? (WXI_PIN !== null ? clamp(WXI_PIN, 0, 2) : 1) : st.climate.intensity), 0.06, 0.14);
    st.moon = moonPhase(dateMs); st.moonAt = -1e9;
    st.pOff = ((seed % 977) * 0.37) + 11.3;
    WX.uWindV.value.set(Math.cos(st.climate.windDir), Math.sin(st.climate.windDir));
    if (!same) {
      // A NEW DAY: settled state resets to what the morning would have left.
      // A range change (same daySeed) keeps every channel exactly where it was —
      // the range decides what is COUNTED, never what the sky is doing.
      for (const c of CH_KEYS) ch[c] = c === 'gust' ? 1 : 0;
      ch.cover = st.climate.startCover;
      ch.cloud = .10;
      st.led = null; st.arm.thunder = 0; st.arm.gather = 0;
      st.goldUntil = 0; st.gustUntil = 0; st.bowUntil = 0; st.bowFrom = 0;
      st.rainPeak = 0; st.rainPeakAt = -1e9; st.auroraFlareUntil = 0;
      st.autoDropped = false;
    } else if (COVER_PIN !== null) ch.cover = clamp(COVER_PIN, 0, 1);
  }

  /* ── layer 1: the diurnal shape of a day ── */
  function applyDiurnal(t, ctx) {
    const c = st.climate, warm = 1 - c.season.coldness;
    // A mist DAY is a mist morning: the layer burns off as the sun climbs and
    // leaves a haze behind, rather than fogging the town from dawn to dusk. It
    // fades, it does not switch off (TAU_OUT.mist, 40 s).
    if (c.base === 'mist') T.mist *= 1 - 0.82 * smoothstep(0.20, 0.44, sun.el);
    // …and a mist morning is the prettiest frame the app can make, so any day
    // that rolled one gets the full layer for the two hours after sunrise.
    if (c.morningMist && sun.hour > sun.sr - 0.7 && sun.hour < sun.sr + 2.4 && sun.el < 0.30) {
      T.mist = Math.max(T.mist, 0.85);
      T.gust = Math.min(T.gust, 0.45);
    }
    // Fair-weather cumulus build through the afternoon: mornings and afternoons
    // of the same clear day should not be the same picture.
    if ((c.base === 'clear' || c.base === 'fair') && sun.hour >= 13 && sun.hour <= 18)
      T.cloud = clamp(T.cloud + 0.18 * warm, 0, 1);
    // The aurora is a cold clear night, and it is brighter the bigger the day was.
    if (st.night > 0.85 && T.cloud < 0.25 && c.auroraTonight)
      T.aurora = Math.max(T.aurora, 0.35 + 0.65 * st.tokenGlow);
  }

  /* ── layer 2: the ledger. Escalation only; nothing here reads idle time. ── */
  function pick(t, ctx) {
    const pr = clamp((ctx && isNum(ctx.paceRatio)) ? ctx.paceRatio : 1, 0, 99);
    for (let i = 0; i < LEDGER.length; i++) {
      const L = LEDGER[i];
      if (L.enter(pr)) { if (!st.arm[L.id]) st.arm[L.id] = t; }
      else st.arm[L.id] = 0;
    }
    if (st.led && st.led.exit(pr)) { st.led = null; st.ledSince = 0; }
    // Only ever climb: a gathering sky may become thunder, thunder never
    // demotes itself to a gathering sky without first failing its exit test.
    const cur = st.led ? LEDGER.indexOf(st.led) : LEDGER.length;
    for (let i = 0; i < cur; i++) {
      const L = LEDGER[i];
      if (st.arm[L.id] && t - st.arm[L.id] >= L.dwell) { st.led = L; st.ledSince = t; st.arm[L.id] = 0; return; }
    }
  }

  /* ── impulses: additive overlays with their own wall clocks, capped so the
       sky can never become a slot machine (one gold hold, one bow at a time) ── */
  function applyImpulses(t) {
    // The amplitude dies with the hold, or a later 0.35 landmark drip would
    // inherit a milestone's 1.0 and every landmark would be a jackpot.
    if (t >= st.goldUntil) st.goldA = 0;
    else T.gold = Math.max(T.gold, st.goldA);
    if (t < st.gustUntil) T.gust = Math.max(T.gust, 1.6);
    if (t >= st.bowFrom && t < st.bowUntil) T.bow = Math.max(T.bow, 0.80);
    if (BOW_PIN !== null) T.bow = BOW_PIN;
    if (t < st.auroraFlareUntil && st.night > 0.5) T.aurora = 1;
  }

  /** A rainbow IS a reward: it is armed by a shower ending in low daylight, and
   *  unconditionally six seconds after a milestone fired in daylight. */
  function armBow(t, delay) {
    // The antisolar point sits below the horizon by exactly the sun's own altitude,
    // and a bow is a 42° circle drawn around it — so once the sun is more than ~42°
    // up there is no bow above the horizon AT ALL. That is the window, and it is
    // physics rather than taste: it is why a noon milestone gets nothing and a
    // five-o'clock one gets a tall arc. `vel` is the sine of the altitude of the sun
    // town.js DRAWS, not the astronomical one — see solarAt.
    if (sun.vel < 0.04 || sun.vel > 0.66 || st.night > 0.4) return;
    if (t < st.bowUntil) return;                     // one bow at a time
    st.bowFrom = t + (delay || 0);
    // 80 s, not 45. A real bow stands for minutes, and — the practical half of the
    // same argument — the working orbit camera pitches DOWN at the town and shows
    // about six degrees of sky, so a bow is only in frame for part of the orbit's
    // 140-second drift. Forty-five seconds could be spent entirely facing the sun.
    st.bowUntil = st.bowFrom + 80000;
  }
  function trackBow(t) {
    if (ch.rain > st.rainPeak) { st.rainPeak = ch.rain; st.rainPeakAt = t; }
    if (t - st.rainPeakAt > 180000) st.rainPeak = 0;
    if (st.rainPeak > 0.40 && ch.rain < 0.15 && ch.cloud < 0.80) { armBow(t, 0); st.rainPeak = 0; }
  }

  /* ═══ THE BOW ═══════════════════════════════════════════════════
     A rainbow is a reward the sky already knows how to give, so T-5 asks for one
     six seconds after a milestone lands in daylight. The reason to get the optics
     right is that it is nearly free and it is the entire difference between a
     rainbow and a sticker of a rainbow.

     WHERE IT IS. A bow is not "in the west". It is a circle of fixed angular
     radius centred on the ANTISOLAR POINT — the direction straight away from the
     sun — which sits below the horizon by exactly the sun's altitude. Everything
     the eye finds convincing follows from that one fact and from nothing else:

       · The bow is always opposite the sun, so it swings across the sky through
         the afternoon and it is never, ever on the same side as the light.
       · Its height is 42° minus the sun's altitude. A high sun means a low, wide,
         flat arc; a sun over ~42° means NO BOW AT ALL, because the whole circle
         has gone under the ground. A late-afternoon sun at 18° gives a bow 24°
         tall, which is the dramatic one everybody pictures.
       · It does not parallax. The mesh rides on the camera, so walking the town
         at eye height cannot slide the bow past the rooftops.

     WHAT IS IN IT. Primary at 40.2–42.4° (violet inside, red outside), secondary
     at 50.4–53.4° (REVERSED — red inside — wider, and much fainter, because it
     costs one more internal reflection), and between them Alexander's dark band,
     where no single-drop ray emerges at all and the sky is measurably darker than
     it is either side. That band is doing most of the work: it is what makes the
     gap between the two bows read as a real optical structure rather than as two
     stripes that happen to be near each other.

     HOW IT IS ONE DRAW CALL. Premultiplied alpha. `rgb` is added to the sky (the
     bows are scattered light arriving) and `alpha` multiplies it down (Alexander's
     band is scattered light missing). An additive pass could not darken and a
     normal-alpha pass could not glow, so either alone would be two meshes.

     COST. 864 triangles on a 145 × 4 spherical annulus, one draw call, and both
     only while a bow is up: the geometry is not built until `ch.bow` first moves
     off zero, and the layer registry hides the mesh again the moment it decays.
     The colour is analytic — no texture, no gradient ramp, nothing to load. */
  const BOW_R = 700;                    // inside town.js's 820-unit sky dome
  const BOW_A0 = 30.0, BOW_A1 = 55.6;   // degrees from the antisolar point
  const BOW_SEG = 144, BOW_RING = 3;    // → 864 triangles
  const D2R = Math.PI / 180;
  const _bz = new THREE.Vector3(0, 0, 1), _banti = new THREE.Vector3();
  let bow = null;

  const BOW_VERT = `
    varying vec3 vBL; varying vec3 vBW;
    void main(){
      vBL = position;                                     // local: +Z is antisolar
      vBW = (modelMatrix * vec4(position, 0.0)).xyz;      // world direction (no scale)
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  // The angular radius is taken PER FRAGMENT off the normalised local position, so
  // the tessellation only has to cover the band — it cannot distort the bow. Three
  // rings is therefore plenty, and the bands stay analytically sharp at any zoom.
  const BOW_FRAG = `
    uniform float uK; uniform float uT; uniform vec3 uWarm;
    varying vec3 vBL; varying vec3 vBW;
    // Three overlapping lobes plus a violet tail: red at t=1 (the outer edge of the
    // primary), green in the middle, blue-violet at t=0. Cheaper and steadier than a
    // ramp texture, and it never bands.
    vec3 bowSpec(float t){
      vec3 d = vec3(t) - vec3(0.93, 0.55, 0.18);
      vec3 c = exp(-d * d * vec3(13.0, 17.0, 15.0));
      float v = exp(-(t - 0.02) * (t - 0.02) * 55.0);
      c.b += 0.50 * v; c.r += 0.26 * v;
      // A real bow is PASTEL. Every band of it is a wide overlapping smear of
      // wavelengths, not a filter wheel, and the charter's "avoid saturated
      // primaries" is describing exactly the failure mode here: authored at full
      // chroma this came out as a sticker of a rainbow laid over the village.
      return mix(c, vec3(dot(c, vec3(0.33, 0.50, 0.17))), 0.30);
    }
    void main(){
      float a = degrees(acos(clamp(normalize(vBL).z, -1.0, 1.0)));
      // The feet of a bow stop at the ground. They do not carry on into it — but
      // they DO reach it, so this is a one-degree contact softener and not a fade:
      // the horizon band is the only sky the working camera ever shows.
      float hz = smoothstep(-0.004, 0.018, normalize(vBW).y);
      if (hz <= 0.0 || uK <= 0.0) discard;
      // PRIMARY — one internal reflection. The OUTER edge is the hard one: no ray
      // leaves a drop deviated past the rainbow angle at all, and that cliff is
      // exactly why Alexander's band exists.
      float pri = smoothstep(38.6, 40.8, a) * (1.0 - smoothstep(42.3, 43.0, a));
      float tp  = clamp((a - 40.2) / 2.3, 0.0, 1.0);
      // SECONDARY — two internal reflections, so the spectrum is REVERSED: red on
      // the inside at 50.4°, violet out at 53.4°. Wider and far fainter.
      float sec = smoothstep(50.0, 51.3, a) * (1.0 - smoothstep(52.8, 54.6, a));
      float ts  = clamp((53.9 - a) / 3.3, 0.0, 1.0);
      float dark = smoothstep(42.4, 45.0, a) * (1.0 - smoothstep(47.8, 50.4, a));
      // …and inside the primary the sky is BRIGHTER, for the same reason inverted.
      float lift = 1.0 - smoothstep(33.0, 40.3, a);
      // A rain curtain is not a uniform sheet: a real bow is strong in places and
      // thin in others, and one end usually beats the other. Paced on uWxT — the
      // wall clock — because a headless frame is 300 ms and dt would freeze it.
      float ph = atan(vBL.y, vBL.x);
      float cur = 0.60 + 0.40 * (0.5 + 0.5 * sin(ph * 2.7 + uT * 0.00009))
                              * (0.62 + 0.38 * sin(ph * 1.3 - 1.9));
      float amt = uK * hz;
      vec3 col = (bowSpec(tp) * pri + bowSpec(ts) * sec * 0.40) * cur + vec3(lift * 0.014);
      col *= uWarm * amt;
      // 0.17, not 0.52. A rainbow is a MODULATION of the sky behind it — you can
      // see cloud through one — and at half a stop of added light it stopped being
      // a decal and started being weather. The number that had to come down is the
      // one that reads as "how opaque is this", and it is this one.
      float al = dark * amt * 0.15 + (pri + sec * 0.5) * amt * 0.03;
      gl_FragColor = vec4(col * 0.17, al);
    }`;

  /** Built on the first frame a bow exists and never before it: a day with no
   *  milestone and no clearing shower allocates nothing at all. */
  function makeBow() {
    const cols = BOW_SEG + 1;
    const pos = new Float32Array(cols * (BOW_RING + 1) * 3);
    const idx = new Uint16Array(BOW_SEG * BOW_RING * 6);
    for (let r = 0; r <= BOW_RING; r++) {
      const th = (BOW_A0 + (BOW_A1 - BOW_A0) * (r / BOW_RING)) * D2R;
      const sr = Math.sin(th) * BOW_R, cr = Math.cos(th) * BOW_R;
      for (let s = 0; s < cols; s++) {
        const ph = s / BOW_SEG * TAU2, o = (r * cols + s) * 3;
        pos[o] = Math.cos(ph) * sr; pos[o + 1] = Math.sin(ph) * sr; pos[o + 2] = cr;
      }
    }
    let k = 0;
    for (let r = 0; r < BOW_RING; r++) for (let s = 0; s < BOW_SEG; s++) {
      const a = r * cols + s, c = a + cols;
      idx[k++] = a; idx[k++] = c; idx[k++] = a + 1;
      idx[k++] = a + 1; idx[k++] = c; idx[k++] = c + 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      // uWxT is shared BY REFERENCE off the bus, exactly as environs shares it:
      // one write in publish() reaches the bow with no bookkeeping.
      uniforms: { uK: { value: 0 }, uT: WX.uWxT, uWarm: { value: new THREE.Color(1, 0.97, 0.94) } },
      vertexShader: BOW_VERT, fragmentShader: BOW_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false,
      side: THREE.DoubleSide, fog: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'wx.bow';
    // BETWEEN environs' veil (-3) and its field decals (-2), and this number was
    // the whole difference between a working feature and a dead one. Behind the
    // veil, the bow was invisible from the camera the app actually uses: the orbit
    // rig pitches down at the town and leaves about eight degrees of sky above the
    // horizon, and every one of those degrees is inside the veil's haze bank. In
    // front of it, the legs read. It is also the more honest placement — the rain
    // curtain that makes a bow is a kilometre or two out, well in FRONT of the far
    // hills, which is exactly why a real rainbow looks like it ends in a field.
    mesh.renderOrder = -2.5;
    mount(mesh, 'bow', () => ch.bow > 0.004 && st.night < 0.75);
    return { mesh, u: mat.uniforms };
  }

  /** Per frame: hang the bow off the antisolar point, ride the camera, and grade it.
   *  Everything here is wall-clock or state — nothing integrates dt. */
  function stepBow(t, ctx) {
    if (!bow) {
      if (ch.bow <= 0.004) return;                   // NOTHING exists until there is a bow
      bow = makeBow();
    }
    const m = bow.mesh;
    // A bow is at infinity. Riding the camera is what stops it parallaxing past the
    // rooftops when the user strolls — the single tell that would give it away.
    const cam = ctx && ctx.camera;
    if (cam && cam.position) m.position.copy(cam.position);
    _banti.set(-sun.vx, -sun.vy, -sun.vz);
    m.quaternion.setFromUnitVectors(_bz, _banti);
    // A bow IS sunlight, so an overcast lid has none to spare — but the sky that
    // makes a rainbow is a BROKEN one by definition, so this is a lean on sunMul
    // rather than a multiply by it, or the bow would switch itself off at exactly
    // the moment it is supposed to appear.
    const lum = clamp((0.55 + 0.45 * grade.sunMul) * (1 - st.night * 1.6), 0, 1);
    bow.u.uK.value = clamp(ch.bow, 0, 1) * lum;
    // Low sun, warm bow: the same golden-hour term town.js grades its own key on.
    const g = sun.glow;
    bow.u.uWarm.value.setRGB(1, 0.97 - 0.20 * g, 0.94 - 0.36 * g);
  }

  /* ═══ THE FALL ══════════════════════════════════════════════════
     Rain and snow, as objects in the scene. Before this the app said "steady
     rain" in the header over a picture of a fair afternoon, which is worse than
     having no weather at all: the caption was the only thing that knew.

     WHY LINES AND POINTS AND NOT QUADS. A raindrop photographs as a STREAK — the
     shutter is open long enough that a 9 m/s drop draws a line — and a hairline
     is what a streak is. GL_LINES gives that for two vertices and zero triangles;
     a billboarded quad would cost four vertices, two triangles and a texture to
     make it look like the line we could simply have drawn. A snowflake is the
     opposite: slow enough to be a shape rather than a smear, and always the same
     shape whichever way you look at it, which is the definition of a point
     sprite. Between them the whole feature costs TWO draw calls and NO triangles
     at all, against a budget that was quoted in triangles.

     THE FIELD IS WORLD-ANCHORED, NOT CAMERA-LOCKED, and this is the one thing
     that separates weather from a screen effect. Each drop's position is
     `mod(seed * period + velocity * t, period)`, so the whole field is exactly
     periodic in P; the mesh is then parked on the LATTICE — the nearest multiple
     of P to the camera — and a shift by one period is the identity. The volume
     therefore follows the camera without the drops sliding with it: pan, orbit or
     walk and the rain stays where it is. Everything is `mod`, so nothing drifts
     and nothing needs re-seeding.

     WALL CLOCK, ALWAYS. Position is a closed-form function of `uWxT`, the one
     clock this module publishes. Nothing here integrates dt, nothing accumulates,
     and a 1 fps headless frame lands the drops exactly where a 60 fps one does —
     which is the whole reason a screenshot can show rain at all.

     WHAT THE INTENSITY BUYS. `ch.rain`/`ch.snow` drive the DRAW RANGE (how many
     drops exist), the fall speed, the streak length and the opacity — so drizzle
     is a few slow short faint lines and a downpour is a curtain, off the same
     mesh, with no second material and no branch. At zero they are hidden by the
     layer registry and cost nothing.

     COST. Rain: 2600 segments = 5200 vertices, 1 draw, 0 triangles. Snow: 2200
     points = 2200 vertices, 1 draw, 0 triangles. Both allocate on first use only;
     a clear day never builds either. Per frame each costs six uniform writes and
     one setDrawRange — no allocation. */
  const N_RAIN = 5200, N_SNOW = 3800;
  // Half-width and height of the volume, in metres — one world unit is one metre.
  // Big enough that the shell between the near fade and the far one is most of
  // what the lens can see, which is what makes the fall read as a CURTAIN rather
  // than as a handful of streaks: the near fade has to throw away everything
  // inside seven metres (a drop on the lens is a smear across a quarter of the
  // frame, not weather) and there has to be plenty left after it.
  const RAIN_SPAN = 46, RAIN_H = 42;
  const SNOW_SPAN = 50, SNOW_H = 46;       // snow hangs about, so it wants more room
  let rain = null, snow = null;

  /** Shared by both: seed → wrapped offset from the camera, and the per-drop
   *  speed spread. `position` carries the SEED, not a position — three needs the
   *  attribute to know the vertex count anyway.
   *
   *  THE WRAP IS TAKEN AROUND THE CAMERA (uOrg), not around the mesh's own
   *  origin, and that one subtraction is the whole difference between rain you
   *  can see and rain you cannot. The field is an infinite periodic lattice; this
   *  picks the representative of each drop NEAREST THE VIEWER, so the viewer is
   *  always at the centre of the volume and every fade below is a real distance
   *  from the lens. Parking the mesh on the lattice instead — the obvious version
   *  — leaves the camera anywhere inside the box, and at street level it landed
   *  on the far edge: `--wx=rain --cam=stroll` drew a fully working rainstorm
   *  entirely behind the viewer's head.
   *
   *  It is still world-anchored, because the lattice is: walking a hundred metres
   *  changes which representative is chosen and nothing else, so the drops do not
   *  slide along with the camera. */
  const FALL_HEAD = `
    uniform float uT; uniform float uK; uniform vec3 uVel; uniform vec2 uSpan;
    uniform vec3 uOrg;
    varying float vA;
    vec3 fallAt(float t, out float sp, vec2 jitter){
      sp = 0.76 + 0.48 * position.z;
      vec3 v = uVel * sp;
      float P = uSpan.x * 2.0, H = uSpan.y;
      return vec3(mod(position.x * P + v.x * t + jitter.x - uOrg.x + uSpan.x, P) - uSpan.x,
                  mod(position.y * H + v.y * t          - uOrg.y + uSpan.y * 0.5, H) - uSpan.y * 0.5,
                  mod(position.z * P + v.z * t + jitter.y - uOrg.z + uSpan.x, P) - uSpan.x);
    }`;
  /** Premultiplied, so `rgb` is already alpha-weighted: one blend that lightens
   *  the sky behind it without ever adding a stop of light to the whole frame. */
  const RAIN_FRAG = `
    uniform vec3 uCol; varying float vA;
    void main(){
      if (vA <= 0.003) discard;
      gl_FragColor = vec4(uCol * vA, vA);
    }`;
  const SNOW_FRAG = `
    uniform vec3 uCol; varying float vA;
    void main(){
      // A flake is a soft disc, not a square: gl_PointCoord is the only texture
      // this needs and it is free.
      float a = vA * smoothstep(0.50, 0.14, length(gl_PointCoord - 0.5));
      if (a <= 0.004) discard;
      gl_FragColor = vec4(uCol * a, a);
    }`;

  const RAIN_VERT = FALL_HEAD + `
    attribute float aEnd; uniform float uLen;
    void main(){
      float sp; vec3 p = fallAt(uT * 0.001, sp, vec2(0.0));
      // The head's depth, taken BEFORE the tail is laid out, so both vertices of
      // a segment agree about how long the segment is.
      vec4 mvh = modelViewMatrix * vec4(p, 1.0);
      float d = -mvh.z;
      // THE EXPOSURE SHORTENS AS THE DROP COMES CLOSE. A streak of fixed world
      // length is a fixed ANGLE only at one distance; at three metres the same
      // half-metre draws a sixth of the frame. Tapering it is what lets the near
      // fade come in to two metres instead of thirteen — which is the whole
      // difference between rain you can see from the street and rain that only
      // exists at the wide framing.
      float ls = clamp(d * 0.085, 0.26, 1.0);
      // THE STREAK IS THE VELOCITY. aEnd = 1 is where this drop was uLen seconds
      // ago, so the line lies along the drop's own path and leans with the wind
      // for nothing — no rotation, no billboard, no second attribute.
      p -= uVel * sp * (uLen * ls * aEnd);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      // A drop ON the lens is still not weather, so the last two metres go — and
      // the far edge of the box dissolves rather than ending, which is why the
      // volume can be a box and read as an open sky.
      vA = uK * smoothstep(1.6, 5.0, d)
         * (1.0 - smoothstep(uSpan.x * 0.72, uSpan.x * 1.10, length(p)));
      gl_Position = projectionMatrix * mv;
    }`;

  const SNOW_VERT = FALL_HEAD + `
    uniform float uPx; uniform float uSize;
    void main(){
      float t = uT * 0.001;
      // Snow does not fall, it WANDERS down. Two out-of-phase drifts per flake,
      // seeded off its own cell, so no two take the same path and the whole field
      // never breathes in unison.
      float ph = position.x * 41.7 + position.z * 13.3;
      float sp; vec3 p = fallAt(t, sp, vec2(1.35 * sin(t * 0.52 + ph),
                                            1.35 * cos(t * 0.41 + ph * 1.7)));
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float d = -mv.z;
      vA = uK * smoothstep(0.9, 3.2, d)
         * (1.0 - smoothstep(uSpan.x * 0.70, uSpan.x * 1.08, length(p)));
      // World-sized, so a flake near the lens is a blob and one across the square
      // is a speck — the perspective is what makes it snow rather than static.
      gl_PointSize = clamp(uSize * uPx / max(d, 0.5), 1.2, 14.0);
      gl_Position = projectionMatrix * mv;
    }`;

  /** Seeds are shared by both vertices of a segment; `aEnd` picks head or tail. */
  function makeRain() {
    const pos = new Float32Array(N_RAIN * 6), end = new Float32Array(N_RAIN * 2);
    const r = rngOf((st.daySeed ^ 0x1F123BB5) >>> 0);
    for (let i = 0; i < N_RAIN; i++) {
      const x = r(), y = r(), z = r();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        end[i * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: WX.uWxT, uK: { value: 0 }, uLen: { value: 0.09 },
        uVel: { value: new THREE.Vector3(0, -8, 0) }, uOrg: { value: new THREE.Vector3() },
        uSpan: { value: new THREE.Vector2(RAIN_SPAN, RAIN_H) },
        uCol: { value: new THREE.Color(0.60, 0.66, 0.74) }
      },
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false, fog: false
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.name = 'wx.rain';
    // After the countryside's own transparents (motes are 3) so a drop is never
    // sorted behind a firefly, and depth-tested so the town occludes it properly.
    mesh.renderOrder = 4;
    mount(mesh, 'rain', () => ch.rain > 0.012);
    return { mesh, u: mat.uniforms, geo };
  }

  function makeSnow() {
    const pos = new Float32Array(N_SNOW * 3);
    const r = rngOf((st.daySeed ^ 0x2C1B3A77) >>> 0);
    for (let i = 0; i < N_SNOW * 3; i++) pos[i] = r();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: WX.uWxT, uK: { value: 0 }, uPx: { value: 700 }, uSize: { value: 0.075 },
        uVel: { value: new THREE.Vector3(0, -1.1, 0) }, uOrg: { value: new THREE.Vector3() },
        uSpan: { value: new THREE.Vector2(SNOW_SPAN, SNOW_H) },
        uCol: { value: new THREE.Color(0.90, 0.92, 0.95) }
      },
      vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false, fog: false
    });
    const mesh = new THREE.Points(geo, mat);
    mesh.name = 'wx.snow';
    mesh.renderOrder = 4;
    mount(mesh, 'snow', () => ch.snow > 0.012);
    return { mesh, u: mat.uniforms, geo };
  }

  /** Put the volume ON the camera and tell the shader where that is, so the wrap
   *  above can pick the nearest representative of every drop. Two writes, no
   *  allocation, no rounding and nothing to drift. */
  function park(mesh, u, cam) {
    if (!cam || !cam.position) return;
    mesh.position.copy(cam.position);
    u.uOrg.value.copy(cam.position);
  }
  /** Pixels per world unit at one unit of depth — what turns a flake's real size
   *  into a point size. Recomputed at 2 Hz off the live camera, and every use of
   *  it is clamped, so a stale value during a resize costs a slightly small flake
   *  for half a second and never a crash. */
  function pxPerUnit(cam) {
    let h = 900;
    try {
      if (typeof window !== 'undefined' && window.innerHeight) h = window.innerHeight * (window.devicePixelRatio || 1);
    } catch (e) { /* not a browser: the default is a sane 900 */ }
    const fov = (cam && isNum(cam.fov)) ? cam.fov : 46;
    return h / (2 * Math.tan(fov * Math.PI / 360));
  }

  /** `setQuality('low')` halves the drop count. It is applied through the draw
   *  range, per frame, beside the intensity — one writer, no rebuild. */
  const qK = () => st.quality === 'low' ? 0.5 : 1;

  /** Per frame. Wall clock and channel state only — nothing integrates. The
   *  gates are the SAME predicates the layer registry's want() uses, so a hidden
   *  layer is also an unwritten one and a clear sky costs literally nothing. */
  function stepPrecip(t, ctx) {
    const cam = ctx && ctx.camera;
    const wv = WX.uWindV.value, gust = grade.windMul;
    const day = 1 - st.night;
    if (ch.rain > 0.012) {
      if (!rain) rain = makeRain();
      const u = rain.u, k = clamp(ch.rain, 0, 1);
      // 5.6 m/s in a drizzle, 10 m/s in a downpour, laid over by the wind.
      const fall = 5.6 + 4.4 * k;
      u.uVel.value.set(wv.x * 2.0 * gust, -fall, wv.y * 2.0 * gust);
      // Heavier rain is a longer streak: more drops through the same shutter.
      // 35–65 cm — a photographic exposure of a falling drop, and NOT the metre
      // and a half the first pass drew, which came out as a meteor shower.
      u.uLen.value = 0.030 + 0.030 * k;
      // RAIN IS FAINT. It is a modulation of what is behind it — you can read a
      // roof through a shower — and authored at four fifths of a stop it stopped
      // being weather and became white lines ruled over the village.
      u.uK.value = clamp(0.10 + 0.32 * k, 0, 0.44) * (0.34 + 0.66 * day) * smoothstep(0.012, 0.09, ch.rain);
      // Rain is the sky, seen end-on. It reads light against a roof and dark
      // against the sky, and one blend cannot do both — so it is the pale one,
      // knocked back after dark where the only light on it is the lamps'.
      u.uCol.value.setRGB(0.58 + 0.10 * day, 0.64 + 0.10 * day, 0.74 + 0.08 * day);
      rain.geo.setDrawRange(0, 2 * Math.max(1, Math.round(N_RAIN * qK() * clamp(0.25 + 0.75 * k, 0, 1))));
      park(rain.mesh, u, cam);
    }
    if (ch.snow > 0.012) {
      if (!snow) snow = makeSnow();
      const u = snow.u, k = clamp(ch.snow, 0, 1);
      // A flake falls at about a metre a second and a blizzard drives it sideways
      // far harder than it drives it down.
      u.uVel.value.set(wv.x * 1.4 * gust, -(0.85 + 0.55 * k), wv.y * 1.4 * gust);
      u.uK.value = clamp(0.32 + 0.50 * k, 0, 0.82) * (0.45 + 0.55 * day) * smoothstep(0.012, 0.09, ch.snow);
      // 2.0–3.6 cm. A flake is SMALL — at the first pass's 10 cm the field came
      // out as a scatter of hailstones, four of them in frame — but not so small
      // that a 1 px dot is all that survives the walk down to street level.
      u.uSize.value = 0.020 + 0.016 * k;
      u.uPx.value = pxPerUnit(cam);
      snow.geo.setDrawRange(0, Math.max(1, Math.round(N_SNOW * qK() * clamp(0.25 + 0.75 * k, 0, 1))));
      park(snow.mesh, u, cam);
    }
  }

  /** Lightning is the CLOUD lighting up from inside, never a polyline and never a
   *  light spike (a DirectionalLight flash costs a full shadow re-render on the
   *  one frame that must not stall). S3/W7's deck reads st.boltAz. */
  function stepBolts(t) {
    if (T.thunder < 0.5) { st.boltT0 = -1e9; st.boltAt = 0; return 0; }
    if (!st.boltAt) st.boltAt = t + 4000;
    if (t >= st.boltAt) {
      st.boltT0 = t;
      st.boltAz = (h2(t * 0.001, st.daySeed) * TAU2);
      st.boltAt = t + 6000 + h2(st.daySeed, t * 0.0007) * 8000;
    }
    const e = t - st.boltT0;
    if (e < 0 || e >= BOLT_ENV.length * 44) return 0;
    return BOLT_ENV[Math.min(BOLT_ENV.length - 1, Math.floor(e / 44))];
  }

  /* ── the resolved target ── */
  function resolveTarget(t, ctx) {
    for (let i = 0; i < CH_KEYS.length; i++) {
      const c = CH_KEYS[i];
      T[c] = c === 'gust' ? 1 : HOLD[c] ? ch[c] : 0;
    }
    T.thunder = 0;
    const c = st.climate;

    if (PIN) {
      // `?wx=` pins the regime and disables the diurnal and ledger layers, so a
      // verification shot is a pure test of one target vector.
      const R = REGIMES[PIN], k = WXI_PIN !== null ? clamp(WXI_PIN, 0, 2) : 1;
      applyRegime(R, k);
      T.thunder = R.thunder || 0;
    } else {
      applyRegime(REGIMES[c.base], c.intensity);
      T.thunder = REGIMES[c.base].thunder || 0;
      applyDiurnal(t, ctx);
      if (st.led) {
        const rain0 = T.rain, snow0 = T.snow;
        blendRegime(REGIMES[st.led.r], st.led.mixK);
        T.thunder = Math.max(T.thunder, REGIMES[st.led.r].thunder || 0);
        // PRECIPITATION FOLLOWS THE STORM. A gathering sky raises cloud; whether
        // anything falls out of it is the season's call. Boom weather in January
        // is a squall, not a substitution — which is what keeps the season legible
        // underneath the gag.
        const cold = c.season.coldness >= 0.55;
        const add = st.led.id === 'thunder' ? 0 : 0.26 * st.led.mixK * c.intensity;
        if (cold) {
          if (T.rain > rain0) { T.snow = Math.max(T.snow, snow0 + (T.rain - rain0) * 0.95); T.rain = rain0; }
          T.snow = Math.max(T.snow, snow0 + add);
        } else T.rain = Math.max(T.rain, rain0 + add);
      }
    }
    applyImpulses(t);

    // Settled state is INTEGRATED, never targeted: `wet` chases the rain that is
    // actually falling, `cover` is stepped in stepCover() and simply reported here.
    T.wet = Math.max(T.wet, clamp(ch.rain * 1.2, 0, 1));
    T.cover = ch.cover;
    // One owner for the night wind: environs' own `(1 - .6*night)` term moves here.
    T.gust = clamp(T.gust * c.windRoll * (1 - 0.45 * st.night), 0.35, 2.60);
  }
  /** Layer 0: the day's baseline, its channels scaled by `intensity`. */
  function applyRegime(R, k) {
    for (let i = 0; i < CH_KEYS.length; i++) {
      const c = CH_KEYS[i];
      if (c in R) T[c] = c === 'gust' ? R[c] : clamp(R[c] * k, 0, 1);
      else if (c === 'gust') T[c] = 1;
      else if (!HOLD[c]) T[c] = 0;
    }
  }
  /** Layer 2: move `k` of the way toward R — blending, not replacing. */
  function blendRegime(R, k) {
    for (let i = 0; i < CH_KEYS.length; i++) {
      const c = CH_KEYS[i];
      const v = (c in R) ? R[c] : (c === 'gust' ? 1 : HOLD[c] ? null : 0);
      if (v === null) continue;
      T[c] += (v - T[c]) * k;
    }
  }

  /** SNOW HAS TO LAND, AND IT HAS TO LAND ON ARRIVAL.
   *
   *  The old rule accumulated at dtw/240e3 — four real minutes from bare to
   *  white, from zero, every time. A user who opens the app into a snow shower
   *  watches an empty roof for four minutes; a headless capture runs for twelve
   *  seconds and photographs 5 % of a dusting, which is indistinguishable from
   *  none. So snow was falling in the header and nowhere else.
   *
   *  Three changes, in order of how much they matter:
   *    1. THE SNAP WINDOW OWNS IT. Every other channel snaps to target for
   *       SNAP_MS after init and after every setSeed — that is the rule that
   *       makes `--shot-delay` land on a settled sky rather than 20 % through a
   *       crossfade. `cover` was the one channel exempt from it, for no reason
   *       except that it is integrated rather than eased. It is not exempt now:
   *       a snow day OPENS with snow already lying, exactly as backfillGroves
   *       opens with groves already planted.
   *    2. Forty seconds, not four minutes, for the rest of the ramp. A shower
   *       that is worth calling snow whitens a roof while you watch it; the
   *       fifteen-minute MELT is untouched, because that half was right — snow
   *       goes slowly and that is what makes it read as settled state.
   *    3. It approaches an EQUILIBRIUM rather than climbing to 1. A flurry
   *       leaves a dusting and a blizzard buries the place, and the difference
   *       between them was previously only how fast they got to the same white.
   *  Melt still scales UP with rain — a warm front clears a roof far faster than
   *  time alone — and accumulation scales down with it, which is sleet.
   *  @param {number} dtw wall-clock ms @param {number} t the wall clock */
  function stepCover(dtw, t) {
    if (COVER_PIN !== null) { ch.cover = clamp(COVER_PIN, 0, 1); return; }
    const eq = clamp(ch.snow * 1.25, 0, 1) * (1 - 0.90 * ch.rain);
    if (ch.snow > 0.04 && eq > ch.cover) {
      const k = t < st.snapUntil ? 1 : 1 - Math.exp(-dtw / 40000);
      ch.cover += (eq - ch.cover) * k;
    } else {
      ch.cover -= (dtw / 900e3) * (1 + 2.4 * ch.rain);
    }
    ch.cover = clamp(ch.cover, 0, 1);
  }

  /** One critically-simple exponential approach per channel, on the WALL clock.
   *  Exponential approach composes exactly over any Δt, so sub-stepping is exact
   *  and overshoot is impossible; the ≤500 ms sub-step exists only so a target
   *  that moves during a slow frame is sampled more than once. */
  function stepChannels(t, dtw, ctx) {
    resolveTarget(t, ctx);
    const snapping = t < st.snapUntil;
    let settled = !snapping;
    for (let i = 0; i < CH_KEYS.length; i++) {
      const c = CH_KEYS[i];
      if (c === 'cover') continue;                       // integrated, not eased
      const tau = (T[c] < ch[c] && TAU_OUT[c]) ? TAU_OUT[c] : TAU_IN[c];
      const k = snapping ? 1 : 1 - Math.exp(-dtw / tau);
      ch[c] += (T[c] - ch[c]) * k;
      if (Math.abs(T[c] - ch[c]) > 0.02) settled = false;
    }
    // `?bow=` is a PIN, not a nudge: a verification shot must not spend its first
    // four seconds easing in, and a 1 fps capture only gets a handful of frames.
    if (BOW_PIN !== null) ch.bow = BOW_PIN;
    // AFTER the easing, not before it. `cover` is a function of `ch.snow`, so
    // stepping it on last frame's snow cost the whole snap window: the first
    // update() of a snow day had ch.snow still at zero and laid nothing, and by
    // the time snow existed the window had shut. One line of ordering is the
    // difference between a snow day that photographs and one that does not.
    stepCover(dtw, t);
    st.settled = settled;
  }

  /* ── the chip: hysteresis, or the header flickers between two words ── */
  function dominantId() {
    if (PIN) return PIN;
    if (ch.gold > 0.35) return 'goldrain';
    if (st.led) return st.led.id;
    if (ch.snow > 0.55) return ch.gust > 1.9 ? 'blizzard' : 'snow';
    if (ch.snow > 0.10) return 'flurry';
    if (ch.rain > 0.80) return 'downpour';
    if (ch.rain > 0.40) return 'rain';
    if (ch.rain > 0.08) return 'drizzle';
    if (ch.mist > 0.35) return 'mist';
    if (ch.dust > 0.25) return 'goldhaze';
    if (ch.cloud > 0.62) return 'overcast';
    if (ch.cloud > 0.24) return 'fair';
    return 'clear';
  }
  function stepLabel(t) {
    const want = dominantId();
    if (want !== st.idWant) { st.idWant = want; st.idAt = t; }
    if (want !== st.id && (t - st.idAt >= 2500 || t < st.snapUntil)) {
      st.id = want;
      const L = WX_LABEL[want] || WX_LABEL.fair;
      st.label = L.crier; st.glyph = L.glyph;
    }
  }

  /* ── the grade. Scene quantities only; the image grade is postfx's, and the
       two never read each other. On a clear day every multiplier below is
       exactly 1 and every tint exactly 0 — a clear day is v3, unchanged. ── */
  function stepGrade(t) {
    // `over` is cloud ABOVE THIS DAY'S clear-sky resting value, floored at 0: a
    // clear day whose intensity rolled 1.15 rests at cloud 0.115 and must grade
    // identically to one that rolled 0.8. Everything below is therefore exactly
    // 1 (or 0) on a clear day, whatever the roll — the sky costs nothing until
    // there is actually weather in it.
    const over = Math.max(0, ch.cloud - st.cloud0), precip = clamp(ch.rain + ch.snow, 0, 1);
    grade.sunMul = clamp(1 - 0.86 * over - 0.16 * precip - 0.08 * ch.mist, 0.18, 1.10);
    grade.hemiMul = clamp(1 + 0.34 * over + 0.15 * ch.mist - 0.08 * ch.dust, 0.75, 1.35);
    grade.moonMul = clamp((0.28 + 0.95 * st.moon.illum) * clamp(1 - 0.75 * over, 0.20, 1), 0.15, 1.25);
    // THE HAZE HAS A CEILING NOW. At 4.20 the mid-distance stopped existing: the
    // ghost town, the countryside and the far land came back as one flat grey-blue
    // wash across the top third of the frame, and "is that a treeline or is that
    // the fog" is not an atmosphere, it is a wall. The acceptance test is that the
    // horizon ghost and the far treeline are still TELLABLE APART at --wx=storm.
    grade.fogMul = clamp(1 + 1.85 * ch.mist + 0.45 * ch.rain + 0.34 * ch.snow - 0.15 * ch.dust, 0.85, 3.00);
    grade.fogTint = ch.mist > 0.25 ? 0xD8DEE4 : ch.dust > Math.max(0.20, over) ? 0xE8C08A : 0x9AA3AC;
    grade.fogTintK = clamp(0.35 * ch.mist + 0.34 * Math.max(over, 0) + 0.28 * ch.dust, 0, 0.55);
    grade.skyTintK = clamp(0.78 * Math.max(over, 0) / 0.88, 0, 0.70);
    grade.starMul = clamp(1 - 1.05 * over - 0.45 * ch.mist, 0.05, 1);
    grade.sunBallA = clamp(1 - 1.15 * over - 0.60 * ch.mist, 0, 1);
    grade.shadowMul = clamp(1 - 0.80 * over - 0.25 * precip, 0.30, 1);
    // Capped at 0.72 rather than 1: `roadWet` is a linear multiplier and it stacks
    // with the storm's own dimmed key, so a fully wet road under full overcast was
    // two cuts deep — darker than any cast shadow in the frame, and reading as
    // scorched earth rather than as a wet street. A wet road is a DARKER ROAD, not
    // a different material.
    grade.wetK = clamp(ch.wet, 0, 1) * 0.72;
    grade.windMul = clamp(ch.gust, 0.35, 2.60);
    const bolt = stepBolts(t);
    grade.flash = clamp(bolt * 0.75 * (0.4 + 0.6 * st.night), 0, 1);
  }

  /* ── the bus: one write reaches environs, buildings and (from S3) us ── */
  function publish(t) {
    WX.uWet.value = ch.wet;
    WX.uCover.value = ch.cover;
    WX.uGust.value = grade.windMul;
    WX.uDust.value = ch.dust;
    WX.uCloud.value = ch.cloud;
    WX.uWxT.value = t;
    WX.uFlash.value = grade.flash;
  }

  /** Frame-count-gated, never wall-clock-gated: a --shot run sees 300 ms frames
   *  and would otherwise downgrade itself, silently invalidating the image. */
  function autoQuality(dtw) {
    st.frames++;
    st.ewma += (clamp(dtw, 1, 200) - st.ewma) * 0.06;
    if (!st.autoDropped && st.quality === 'high' && st.frames > AUTO_FRAMES && st.ewma > 26) {
      st.autoDropped = true;
      setQuality('low');                                 // and post nothing: see §10
    }
  }

  /* ═══ public surface ════════════════════════════════════════ */
  /** @param {number} dt IGNORED @param {number} now performance.now() @param {?TownCtx} ctx */
  function update(dt, now, ctx) {
    if (st.disposed) return;
    const t = wallNow(now);
    let elapsed = st.last < 0 ? 0 : t - st.last;
    st.last = t;
    if (!(elapsed >= 0)) elapsed = 0;                    // a clock that went backwards
    if (elapsed > STALL_MS) { st.snapUntil = t + SNAP_MS; elapsed = MAX_STEP; }

    st.night = clamp((ctx && isNum(ctx.night)) ? ctx.night : 0, 0, 1);
    const tok = (ctx && isNum(ctx.totalTok)) ? ctx.totalTok : 0;
    st.tokenGlow = clamp(Math.log10(Math.max(tok, 1e6) / 1e6) / 3.2, 0, 1);

    if (t - st.pickAt >= PICK_MS) {
      st.pickAt = t;
      const nowMs = (ctx && isNum(ctx.simNow)) ? ctx.simNow : Date.now();
      solarAt(nowMs, st.lat, sun);
      // the phase moves 1.2 % a day: once a minute is forty times more often
      // than it can possibly matter, and it costs one cosine
      if (t - st.moonAt > 60000) { st.moon = moonPhase(nowMs); st.moonAt = t; }
      if (!PIN) pick(t, ctx);
      trackBow(t);
    }
    // Sub-stepped so a 1 fps headless frame advances exactly what sixty 16 ms
    // frames advance. Zero-length first step still resolves a target and snaps.
    let rem = elapsed;
    do {
      const step = Math.min(rem, MAX_STEP);
      stepChannels(t, step, ctx);
      rem -= step;
    } while (rem > 0);

    stepLabel(t);
    stepGrade(t);
    publish(t);
    stepBow(t, ctx);
    stepPrecip(t, ctx);
    budget();
    autoQuality(elapsed || 16);
  }

  /**
   * @param {'milestone'|'best'|'tierUp'|'landmark'|'boot'} kind @param {object} [data]
   * Unknown kinds are ignored: the null-object rule runs both ways, and a call
   * site landed a wave early must never throw.
   */
  function event(kind, data) {
    if (st.disposed) return;
    const t = clock();
    switch (kind) {
      case 'milestone':
      case 'best':
        // The reward channel. Gold arrives in 1.4 s and leaves over 5 — money
        // stops falling reluctantly.
        st.goldA = 1; st.goldUntil = Math.max(st.goldUntil, t + 14000);
        if (kind === 'best') st.gustUntil = Math.max(st.gustUntil, t + 6000);   // the flags snap
        armBow(t, 6000);
        if (st.night > 0.5) st.auroraFlareUntil = Math.max(st.auroraFlareUntil, t + 8000);
        break;
      case 'tierUp':
        if (data && isNum(data.tier) && data.tier >= 8) {
          st.goldA = Math.max(st.goldA, 0.55);
          st.goldUntil = Math.max(st.goldUntil, t + 20000);
        }
        // A TIER-UP IS A MILESTONE. town.js's fireMilestone dispatches every rung
        // that moves the fountain — which is every rung from 250 k to ONE BILLION —
        // as 'tierUp' and only the handful above that as 'milestone', so arming the
        // bow on 'milestone' alone meant a normal day never saw one. The row (T-5)
        // says "after a daylight milestone", and "🔨 5M tokens!" is a milestone.
        // armBow itself is the gate: one bow at a time, daylight only, sun under 42°.
        armBow(t, 6000);
        break;
      case 'landmark':
        st.goldA = Math.max(st.goldA, 0.35);
        st.goldUntil = Math.max(st.goldUntil, t + 4000);
        break;
      case 'boot':
        st.snapUntil = t + SNAP_MS;                      // the founding opens on a settled sky
        break;
      default: break;
    }
  }

  /** Epoch / day change. The snap window re-arms either way; the CLIMATE is only
   *  re-rolled when the calendar day actually changed. A range switch must never
   *  re-roll the weather — that would make the sky a function of the range, which
   *  is exactly the mistake daySeed exists to prevent. */
  function setSeed(daySeed, dateMs, latNew, biome) {
    if (st.disposed) return;
    if (isNum(latNew)) st.lat = latNew;
    if (biome) st.biome = biome;
    roll(daySeed, isNum(dateMs) ? dateMs : Date.now(), true);
    st.snapUntil = clock() + SNAP_MS;
    st.last = -1;
  }
  /** Epoch reset (risk §5.3): re-arm this day's sky without re-rolling it. */
  function reset() {
    if (st.disposed) return;
    st.snapUntil = clock() + SNAP_MS;
    st.last = -1; st.pickAt = -1e9;
    st.led = null; st.arm.thunder = 0; st.arm.gather = 0;
  }
  /** @param {'high'|'low'} q */
  function setQuality(q) {
    if (st.disposed) return;
    st.quality = q === 'low' ? 'low' : 'high';
    for (let i = 0; i < layers.length; i++) if (layers[i].quality) layers[i].quality(st.quality);
  }

  /** Is there standing water at (x, z)? A seeded low-ground field × the settled
   *  `wet` channel, so puddles appear in the same hollows every time it rains and
   *  dry from the same hollows last. Allocation-free; four hashes per call. */
  function wetnessAt(x, z) {
    if (st.disposed || ch.wet <= 0.001 || !isNum(x) || !isNum(z)) return 0;
    const pool = smoothstep(0.40, 0.78, vnoise(x * 0.085 + st.pOff, z * 0.085 - st.pOff));
    return clamp(ch.wet * (0.35 + 0.95 * pool), 0, 1);
  }

  /** Weighted country lines for the Gazette, mixed in beside environs'. They must
   *  be TRUE of what is on screen, so every one of them is gated on a channel.
   *  Copy gate §6: no imperatives, no nagging, no model names, nothing that could
   *  read as a complaint about the user. */
  function news() {
    const out = [];
    const add = (w, text) => out.push({ w, text });
    const c = st.climate, s = c.season;

    if (st.led && st.led.id === 'gather') {
      add(3, 'Cloud building from the west at the same rate as the ledger. Coincidence unproven.');
      add(3, 'The sky over the plaza is thickening. The Bureau of Weather is taking notes.');
    }
    if (st.led && st.led.id === 'thunder') {
      add(3, 'Thunder over the mill. Not one villager has looked up from their work.');
      add(2, 'The Bureau of Weather has stopped forecasting and started simply watching.');
    }
    if (grade.flash > 0.01) add(3, 'That one was close. The Bureau of Weather has revised its advice to: stand further back.');
    if (ch.gold > 0.30) {
      add(3, 'It is raining money. Officially, meteorologically, this is weather.');
      add(2, 'Coins in the gutters. The street sweepers have requested a larger broom.');
    }
    if (ch.rain > 0.75) add(3, 'Downpour on the high road. The streets have emptied and the taverns have not.');
    else if (ch.rain > 0.35) {
      add(2, 'Rain, steady and unremarkable. The masons are pleased; the washing is not.');
      add(1, 'Rain on the high road. The gutters are managing, just.');
    } else if (ch.rain > 0.06) add(1, 'Drizzle over the common land. Officially weather, barely.');
    if (ch.snow > 0.75) add(3, 'Blizzard. Visibility: poor. Morale: unaccountably excellent.');
    else if (ch.snow > 0.25) add(2, 'Snow settling on every roof. The masons have declared a holiday and gone to the tavern.');
    else if (ch.snow > 0.05) add(1, 'Flurries over the north field. Nothing sticking yet, to general disappointment.');
    if (ch.cover > 0.55) add(2, 'Snow lying deep on the roofs, measured by the masons and pronounced excellent.');
    if (ch.mist > 0.35) {
      add(2, 'Mist on the low ground. The far fields have gone missing and are expected back by eleven.');
      add(1, 'The Bureau of Weather reports visibility as "poetic".');
    }
    if (ch.dust > 0.20) add(2, 'Late-summer haze over the stubble. The whole district smells of dust and money.');
    if (ch.bow > 0.10) {
      add(3, 'A rainbow over the plaza. The Bureau of Weather has no explanation and does not want one.');
      add(2, 'Double rainbow above the rooftops. The Crier is having a moment.');
    }
    if (ch.aurora > 0.10) {
      add(3, 'Lights over the north field tonight, and they are the exact colour of money.');
      add(2, 'The sky is showing off. So, frankly, is the ledger.');
    }
    if (ch.wet > 0.45 && ch.rain < 0.10) add(1, 'Puddles the length of the high road. Two of them have been given names.');
    if (grade.windMul > 1.8) add(2, 'Wind off the high ground. Three hats reported, two recovered.');
    else if (grade.windMul < 0.6) add(1, 'Not a breath of wind. The weather vane has been declared decorative.');
    if (st.night > 0.55) {
      if (st.moon.illum > 0.92) add(2, 'Full moon over the rooftops. Everything is silver and nobody is asleep.');
      else if (st.moon.illum < 0.08) add(2, 'New moon. The lamps are making the entire argument against the dark tonight.');
      else add(1, `A ${st.moon.name} moon over the common land, doing its quiet arithmetic.`);
    }
    if (ch.cloud < 0.25 && st.night < 0.4) {
      if (s.coldness > 0.62) add(2, 'Clear and cold. The kind of morning that makes a number look bigger.');
      else add(1, 'Clear over the whole district. The Bureau of Weather has filed a single word: fine.');
    }
    add(1, `The Bureau of Weather confirms ${s.label} over the common land, as scheduled.`);
    return out;
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    for (let i = 0; i < layers.length; i++) {
      const m = layers[i].mesh;
      if (m.geometry) m.geometry.dispose();
      const mm = m.material;
      if (Array.isArray(mm)) { for (const x of mm) x.dispose(); } else if (mm) mm.dispose();
      if (m.userData && m.userData.wxTextures) for (const tx of m.userData.wxTextures) tx.dispose();
    }
    layers.length = 0;
    // their geometry and material went with the layers above
    bow = null; rain = null; snow = null;
    group.clear();
    if (group.parent) group.parent.remove(group);
    // The bus is module-scope and outlives us: leave it at its RESTING values so a
    // disposed weather system cannot leave environs' fields permanently soaked.
    WX.uWet.value = 0; WX.uCover.value = 0; WX.uGust.value = 1; WX.uDust.value = 0;
    WX.uCloud.value = 0.1; WX.uFlash.value = 0; WX.uWindV.value.set(1, 0);
    if (dbg && dbg.__wx === api) delete dbg.__wx;
  }

  /* ── boot: roll the day, snap the sky, publish once so consumers that read the
       bus before the first update() see a real value rather than a resting one ── */
  roll(st.daySeed, Date.now(), false);
  solarAt(Date.now(), st.lat, sun);
  st.snapUntil = wallNow() + SNAP_MS;
  st.id = st.idWant = dominantId();
  st.label = (WX_LABEL[st.id] || WX_LABEL.fair).crier;
  st.glyph = (WX_LABEL[st.id] || WX_LABEL.fair).glyph;
  stepGrade(wallNow());
  publish(wallNow());

  /**
   * @typedef {Object} Weather
   * @property {THREE.Group} group
   * @property {WxChannels} ch      LIVE, mutated in place. Read only.
   * @property {WxGrade} grade      LIVE, mutated in place. Read only.
   * @property {string} id          dominant regime id, for the chip and the Crier
   * @property {string} label @property {string} glyph @property {Climate} climate
   * @property {boolean} settled    snap window closed and every channel within 0.02
   * @property {(dt:number, now:number, ctx:Object)=>void} update   dt IS IGNORED
   * @property {(kind:string, data?:object)=>void} event
   * @property {(daySeed:number, dateMs:number, lat:?number, biome:?Object)=>void} setSeed
   * @property {(q:'high'|'low')=>void} setQuality
   * @property {()=>Array<{w:number,text:string}>} news
   * @property {(x:number,z:number)=>number} wetnessAt
   * @property {()=>void} reset @property {()=>void} dispose
   */
  const api = {
    group, ch, grade,
    get id() { return st.id; },
    get label() { return st.label; },
    get glyph() { return st.glyph; },
    get climate() { return st.climate; },
    get settled() { return st.settled; },
    update, event, setSeed, setQuality, news, wetnessAt, reset, dispose
  };

  /* ── the harness hook (§6.1). `globalThis` IS `window` in the renderer, so this
       is exactly `window.__wx` there — and it is also reachable from a plain node
       harness, which is how the budget pass and the easing law get tested without
       a GL context. `layers` is the live PRI array S3 mounts into. ── */
  const dbg = typeof globalThis !== 'undefined' ? globalThis : null;
  if (dbg) {
    dbg.__wx = api;
    Object.defineProperties(api, {
      __layers: { value: layers }, __mount: { value: mount }, __budget: { value: budget },
      __draws: { get: () => st.draws }, __sun: { value: sun }, __st: { value: st }
    });
  }
  return api;
}
