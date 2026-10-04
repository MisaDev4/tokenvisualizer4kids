// Token Town — rare events. A scheduler, a ledger of the town's luck, and
// thirteen happenings that are worth looking up for.
//
// THE SPACING IS THE FEATURE. An event that fires often is not an event; it is
// scenery. Five independent gates stand between a frame and a happening, and a
// roll only reaches the catalogue when all five are open:
//
//   1. WARMUP      nothing at all in the first 6 min of a session. The town gets
//                  to be a town before it gets to be a spectacle.
//   2. QUIET FLOOR MIN_GAP_MS (25 min of ACTIVE use) after the last one ENDED.
//                  A hard floor, not a probability — two events can never crowd.
//                  Measured minimum gap over 20 000 simulated days: 28 min.
//   3. ONE AT A TIME  a single live slot. `live` is either null or the event.
//   4. DAY CAP     DAY_CAP (3) firings per calendar day, ever, for any reason.
//   5. THE ROLL    a rising-hazard coin at 30 s per tick: p starts at 1.0 % and
//                  climbs with the square of the wait to a 9 % ceiling. Rising,
//                  not memoryless, because a flat coin produces three-hour
//                  droughts and the point of this module is that the wait ENDS.
//
// A TIER IS ONLY AS LIKELY AS THE PART OF IT THAT CAN ACTUALLY HAPPEN — see
// pick(). Without that scaling, three quarters of anyone's active use is
// daylight, the rare tier at noon is vane alone, and vane becomes two
// thirds of every rare event the user ever sees while the comet never comes.
//
// ACTIVE USE, NOT WALL TIME. The clock only advances while update() is actually
// being called and the gap between calls is under STALL_MS. A minimised window,
// a sleeping laptop and a machine left on overnight bank nothing — otherwise
// "an event every 45 minutes" would mean "three waiting the moment you look".
//
// THE DAY OWNS THE LUCK, exactly as the day owns the weather. Every roll is
// hash2(daySeed, tickOrdinal): pure, so a reload that reaches the same active
// minute of the same day reproduces the same day. The ledger (active minutes,
// firings, per-event last-seen day) persists in localStorage, so the fortnight
// in "roughly once a fortnight" is a real fortnight and not a per-session lie.
// Range changes do NOT re-roll it — epoch reset tears the meshes down and keeps
// the ledger, same rule that keeps the sky from repainting.
//
// MEASURED FREQUENCY (monte carlo, 20 000 simulated days per row, against THIS
// file's exported makeScheduler — not a copy of it). A simulated day spends 70 %
// of its active use between 09:00 and 18:00 and 30 % in the evening, so 24 % of
// ticks are night; 60 % of towns have water.
//
//   active use/day   events/day   mean gap   median   min    p95    days with none
//     1 h              0.97        38 min     37      28     49        13.4 %
//     2 h              1.94        54 min     51      28     85         0
//     4 h              2.99        61 min     58      28     96         0   (capped)
//
//   At 2 h/day: a common every 0.9 days · an uncommon every 1.8 · a rare every
//   4.9 · the whale every 17.7. Per event: balloon/plazacat/bard 4.3 d,
//   caravan/pigeonpost 4.7, geese/circus 6.2, surveyor 6.7, vane 12.2,
//   fireflies 11.8, lanterns 16.3, comet 16.1, leviathan 17.7.
//   Longer days push the night events out (more of the extra time is daylight):
//   at 4 h/day the comet is every 27 days and the whale every 16.
//
// WALL-CLOCK RULE. Every deadline in this file — the scheduler tick, the fades,
// the flight paths, the crier retries, the bubble cadence — keys off the `now`
// update() is handed. `dt` is read for exactly nothing. A headless shot with
// `--event=comet` therefore lands on a fully-formed comet, not 3 % of one.
//
// COST. IDLE: zero draw calls, zero geometry, zero allocations per frame; the
// idle path is a subtraction and a compare until the 30 s tick, and the tick is
// two hashes. LIVE, measured in node against the vendored three:
//   draw calls  1 (pigeons · geese · fireflies · lanterns) … 6 (the bard), and
//               the repeats in every prop are instanced — a caravan is three
//               wagons in FOUR draws, not nineteen
//   triangles   144 (geese) … 1 232 (44 instanced lanterns)
//   build       0.20 ms (geese) … 2.0 ms (the balloon's striped envelope), once
//   per frame   0.3 us (comet, vane, surveyor) … 15 us (240 blinking
//               fireflies, the only event that rewrites a colour buffer)
// 39 build→step→dispose cycles of the full catalogue leak zero geometries, zero
// materials, zero scene children; 20 mid-event epoch resets leave the group
// empty. At the 60 fps budget the worst event is 0.09 % of a frame.
//
// COPY GATE. Nothing here notices what the user did or did not spend. Events are
// weather for the soul: they arrive because they arrive. Nothing nags, nothing
// counts down, nothing is missable in a way that costs anything.
//
// NULL-OBJECT RULE. Every cfg field is optional. With no plan, no ground sampler,
// no crier and no ticker this module still schedules, still builds its meshes at
// the origin, and still tears them down; it simply has nobody to tell.
import * as THREE from './vendor/three.module.js';

/* ═══ environment shims (this file must import cleanly in node) ══════════════
   The monte-carlo harness runs the REAL scheduler, so nothing above the mesh
   layer may touch a global that only exists in a renderer. */
const HAS_WIN = typeof window !== 'undefined';
const nowMs = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now();
const QS = (() => {
  try { return new URLSearchParams(HAS_WIN ? window.location.search : ''); }
  catch (e) { return new URLSearchParams(''); }
})();

/* ═══ tuning ════════════════════════════════════════════════════════════════ */
const TICK_MS = 30000;          // one scheduler roll per 30 s of active use
const WARMUP_MS = 6 * 60000;    // dead air at the start of every session
const MIN_GAP_MS = 25 * 60000;  // hard quiet floor after an event ENDS
const DAY_CAP = 3;              // firings per calendar day, absolute
const STALL_MS = 20000;         // a longer frame gap is a sleeping window: banks nothing
const P0 = 0.010;               // hazard at the instant the floor lifts
const RAMP_MS = 34 * 60000;     // the quadratic's knee
const PMAX = 0.09;              // ceiling, so nothing is ever certain
const RECENT_N = 5;             // no id may repeat inside the last N firings
const FADE_MS = 1700;           // ground props fade in/out over this
const SAY_MS = 5400;            // villager remark cadence while live
const SHOUT_EVERY = 6600;       // crier retry cadence
const SHOUT_TRIES = 6;

/** Rarity tiers. `w` is the share of FIRINGS, `cool` the calendar days an id
 *  must sit out afterwards — the tail that makes a legendary feel legendary. */
export const EVENT_TIERS = Object.freeze({
  common: Object.freeze({ w: 52, cool: 1 }),
  uncommon: Object.freeze({ w: 30, cool: 3 }),
  rare: Object.freeze({ w: 14, cool: 6 }),
  legendary: Object.freeze({ w: 4, cool: 14 })
});

/* ═══ seeded randomness ═════════════════════════════════════════════════════ */
/** Pure two-argument hash: the roll for tick `b` of day `a`, forever. */
const hash2 = (a, b) => {
  let x = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x ^ (b | 0), 0xC2B2AE35) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0x27D4EB2F) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
/** Mulberry32 — the mesh layer's jitter stream. Never touches scheduling. */
const stream = seed => { let a = (seed >>> 0) || 1; return () => {
  a = (a + 0x6D2B79F5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = t => (t = clamp(t, 0, 1)) * t * (3 - 2 * t);
/** Local calendar day ordinal — the unit every cooldown is counted in. */
const dayIndexOf = ms => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 864e5);

/* ═══ THE CATALOGUE ═════════════════════════════════════════════════════════
   Thirteen happenings. Each carries its own duration, its own ticker copy, its
   own crier shout, its own villager remarks, and its own builder. `when` gates
   it to a time of day; `needs:'water'` gates it to a town that has a river or a
   lake. `build` returns {obj, step, focus} and owns nothing it did not take
   from the bag — which is what makes dispose() a one-liner.

   The copy is the Gazette's, not the town's: the town is earnest and the
   Gazette does the winking. No line may notice the ledger. */
const CATALOGUE = [

  /* ── common ─────────────────────────────────────────────────────────────── */
  {
    id: 'balloon', tier: 'common', w: 1.00, dur: 240000, when: 'any', attract: 8,
    shout: 'A balloon! Over the rooftops, going wherever balloons go!',
    title: 'A hot-air balloon crosses {town} at the pace of a thought.',
    lines: [
      'A balloon is over the north lanes. It has filed no flight plan and nobody has asked for one.',
      'The balloon is crewed by two people waving. {town} is waving back, on principle.',
      'Municipal record: the balloon passed above the bell tower at a height described only as "up".'
    ],
    says: ['Somebody is looking up.', 'It goes where the wind goes.', 'I could do that.', 'That is a very large kettle.'],
    build: B => buildBalloon(B)
  },
  {
    id: 'caravan', tier: 'common', w: 1.15, dur: 480000, when: 'day', attract: 14,
    shout: 'The caravan is in! Three wagons and a great deal of opinion!',
    title: 'A market caravan halts at the gate of {town}. Unloading begins at once; explaining begins later.',
    lines: [
      'The caravan has brought salt, lamp oil and a rumour about a bigger town. Two of the three are for sale.',
      'The wagon master says the road was fine. The wagon says otherwise.',
      'Caravan day: the gate is briefly the most important place in {town}.'
    ],
    says: ['What have they got?', 'That has come a long way.', 'I am only looking.', 'Somebody should ask about the oil.'],
    build: B => buildCaravan(B)
  },
  {
    id: 'plazacat', tier: 'common', w: 1.00, dur: 420000, when: 'any', attract: 6,
    shout: 'A cat has taken the plaza! Nothing can be done and nothing will be!',
    title: 'A stray cat adopts the plaza of {town}. The council has been informed and has stood down.',
    lines: [
      'The cat is asleep on the warm stone of the fountain. The fountain is honoured.',
      'A motion to name the cat failed. A motion to feed the cat passed unanimously.',
      'The cat has been observed supervising the Ledger. No errors were found.'
    ],
    says: ['Nobody is waking it.', 'It lives here now.', 'That is the mayor, that is.', 'Who fed it?'],
    build: B => buildCat(B)
  },
  {
    id: 'bard', tier: 'common', w: 1.00, dur: 300000, when: 'any', attract: 12,
    shout: 'A bard at the fountain! Six verses in and no way out!',
    title: 'A wandering bard sets up at the fountain and begins a song about {town}. It rhymes, mostly.',
    lines: [
      'The song has reached the fourth verse. There are eleven. The crowd is committed now.',
      'A bard is singing the Ledger out loud. It scans far better than anyone expected.',
      'Verse six concerns the drainage. It is, surprisingly, the good one.'
    ],
    says: ['That is not how it happened.', 'He should play the one about the bridge.', 'He is not bad.', 'Eleven verses?'],
    build: B => buildBard(B)
  },
  {
    id: 'pigeonpost', tier: 'common', w: 1.15, dur: 190000, when: 'day', attract: 8,
    shout: 'The post is up! Every pigeon in the county, all at once!',
    title: 'The ledger-pigeons of {town} wheel over the plaza in one enormous circle, carrying nothing at all.',
    lines: [
      'The pigeons have gone up together. Nobody signalled them; they simply agreed.',
      'The Post reports that all pigeons are accounted for and that none of them are working.',
      'A pigeon has landed on the fountain and is being regarded, briefly, as an omen.'
    ],
    says: ['There they go.', 'Hats are at risk.', 'That is the whole loft.', 'They do that.'],
    build: B => buildPigeons(B)
  },

  /* ── uncommon ───────────────────────────────────────────────────────────── */
  {
    id: 'geese', tier: 'uncommon', w: 1.00, dur: 170000, when: 'any', attract: 6,
    shout: 'Geese overhead! Bound somewhere better and making a point of it!',
    title: 'A migrating flock crosses above {town} in a V, honking about the distance.',
    lines: [
      'The geese are going south. Sixteen of them, in formation, in a hurry.',
      'The flock passed over the mill without stopping. The mill has taken it personally.',
      'Two geese are out of position. The other fourteen are being loud about it.'
    ],
    says: ['Winter, then.', 'Sixteen, I make it.', 'Rude birds.', 'They know something.'],
    build: B => buildGeese(B)
  },
  {
    id: 'circus', tier: 'uncommon', w: 1.00, dur: 720000, when: 'any', attract: 16,
    shout: 'A circus! Outside the gate! Tents and everything!',
    title: 'A travelling circus pitches its big top outside {town}. Three tents, one bear, no timetable.',
    lines: [
      'The big top is up beyond the gate. The ropes were tied by professionals and are therefore terrifying.',
      'The circus has one bear and it is asleep. Admission is "whatever you have on you".',
      'The strongman has been challenged by a mason. The mason is regretting it in real time.',
      'Bunting appeared along the gate road overnight. Nobody saw it happen.'
    ],
    says: ['Are we going?', 'I am going.', 'There is a bear!', 'Same bear as last time.'],
    build: B => buildCircus(B)
  },
  {
    id: 'fireflies', tier: 'uncommon', w: 3.40, dur: 360000, when: 'night', needs: 'water', attract: 14,
    shout: 'Fireflies on the water! Thousands of them! The whole town is out!',
    title: 'A fog of fireflies rises off the water at {town}. The bridge is standing room only.',
    lines: [
      'The fireflies are out over the water. The town has quietly stopped what it was doing.',
      'One firefly has come inland and is being followed by a small child and, now, a crowd.',
      'The Bureau of Weather declines to classify the fireflies. The Bureau of Weather is having a lovely time.'
    ],
    says: ['Ohh.', 'Nobody is catching them.', 'It is as if the lamps got loose.', 'Every year, this.'],
    build: B => buildFireflies(B)
  },
  {
    id: 'surveyor', tier: 'uncommon', w: 1.15, dur: 360000, when: 'day', attract: 10,
    shout: 'A surveyor at the fountain! Measuring things that were already measured!',
    title: 'A surveyor arrives to measure the fountain of {town}, declares it "large", and writes that down.',
    lines: [
      'The surveyor has set up a tripod and is squinting at the fountain with tremendous authority.',
      'Official finding: the fountain is wider than it was. The town knew. The town is pleased anyway.',
      'The surveyor has asked who is responsible for all this. Several people pointed at the Ledger.'
    ],
    says: ['What is he measuring?', 'It is big. I could have told him.', 'Is that a telescope?', 'The man is working.'],
    build: B => buildSurveyor(B)
  },

  /* ── rare ───────────────────────────────────────────────────────────────── */
  {
    id: 'lanterns', tier: 'rare', w: 2.60, dur: 480000, when: 'night', attract: 18,
    shout: 'Lanterns going up! The whole town at once! The sky is full of them!',
    title: '{town} lets its lanterns go. Forty small lights climb over the rooftops and keep climbing.',
    lines: [
      'The lanterns are up over the rooftops. Nobody organised this and everybody came.',
      'Someone has written on their lantern. It is too high to read now, which was probably the idea.',
      'The last lantern went up crooked and is being cheered the loudest.'
    ],
    says: ['There goes mine.', 'It is climbing.', 'The thatch is at risk.', 'Mine is the crooked one.'],
    build: B => buildLanterns(B)
  },
  {
    id: 'comet', tier: 'rare', w: 2.60, dur: 420000, when: 'night', attract: 16,
    shout: 'A comet! Over the north road! It is enormous and it is free!',
    title: 'A comet stands over {town} with its tail across half the sky. The astronomers are speechless; everyone else is on a roof.',
    lines: [
      'The comet is holding steady above the north road. It will not be back for some considerable time.',
      'Wishes are being made on the comet at a rate no ledger could follow.',
      'The Bureau of Weather has confirmed the comet is real and has stopped taking questions.'
    ],
    says: ['I have never seen one.', 'Wishes are being made.', 'That is not a star.', 'It is not moving.'],
    build: B => buildComet(B)
  },
  {
    id: 'vane', tier: 'rare', w: 1.00, dur: 200000, when: 'any', attract: 14,
    shout: 'The weathercock is spinning! There is no wind! None!',
    title: 'The weathercock of {town} has been spinning for a full minute in still air and shows no sign of stopping.',
    lines: [
      'The weathercock is turning by itself. Three separate people have confirmed they did not touch it.',
      'Bets are being taken on which way it will settle. It has not settled.',
      'The Bureau of Weather records the wind as "nil" and the vane as "busy", and declines to elaborate.'
    ],
    says: ['Nobody touched it.', 'Which way?', 'It has been a minute.', 'Nobody is stopping it.'],
    build: B => buildVane(B)
  },

  /* ── legendary ──────────────────────────────────────────────────────────── */
  {
    id: 'leviathan', tier: 'legendary', w: 1.00, dur: 260000, when: 'any', attract: 20,
    shout: 'There is a WHALE above the north lanes! A WHALE!',
    title: 'A whale is seen swimming through the air above {town}. The Bureau of Weather has classified it as cloud and gone home.',
    lines: [
      'The whale is above the rooftops, moving slowly, minding its own business.',
      'Every window in the north lanes is open and every one of them has a head in it.',
      'The council has resolved never to speak of this, and to remember it forever.'
    ],
    says: ['That is a whale.', 'That is a WHALE.', 'I am not drinking again.', 'Is it friendly?'],
    build: B => buildLeviathan(B)
  }
];

/** Frozen public metadata — ids, tiers, durations. No builders, no copy state. */
export const EVENTS = Object.freeze(CATALOGUE.map(d => Object.freeze({
  id: d.id, tier: d.tier, dur: d.dur, when: d.when, needs: d.needs || null
})));
const BY_ID = new Map(CATALOGUE.map(d => [d.id, d]));

/* ═══ THE SCHEDULER ═════════════════════════════════════════════════════════
   Pure: no THREE, no DOM, no clock of its own. Everything it knows arrives as
   an argument, which is exactly why the monte-carlo harness can run the real
   thing rather than a copy of it. */

/**
 * @typedef {Object} Ledger
 * @property {number} day        calendar day ordinal this ledger describes
 * @property {number} activeMs   active use banked today
 * @property {number} firedToday
 * @property {number} lastEndMs  activeMs at which the last event ended (-1e9 = never)
 * @property {number} liveEnd    activeMs the CURRENT event is due to end; 0 = idle
 * @property {string[]} recent   the last RECENT_N ids fired, newest last
 * @property {Object<string,number>} lastDay  id → day ordinal it last fired on
 */

/** A fresh, empty luck ledger for `day`. */
function freshLedger(day) {
  return { day: day | 0, activeMs: 0, firedToday: 0, lastEndMs: -1e9, liveEnd: 0, recent: [], lastDay: {} };
}

/**
 * The scheduler. Owns the ledger and answers one question: does tick `t` of day
 * `daySeed` fire, and if so, what.
 * @param {{daySeed:number, ledger:Ledger, save?:(l:Ledger)=>void}} o
 */
export function makeScheduler(o) {
  let daySeed = o.daySeed | 0;
  let L = o.ledger || freshLedger(0);
  const save = typeof o.save === 'function' ? o.save : null;
  let tickIdx = Math.floor(L.activeMs / TICK_MS);   // resume mid-day at the right roll

  // A RELOAD MID-EVENT MUST NOT CHEAT THE FLOOR. The meshes do not survive a
  // reload, so the new session believes nothing is running — and without this
  // the quiet floor would be measured from the event BEFORE the interrupted one
  // and the very next tick could fire. Closing the books on it at load time is
  // what makes the 25-minute floor an invariant rather than an intention.
  // `liveEnd > 0` is the whole guard: an idle ledger carries 0, and treating
  // that as "an event ended at minute zero" moves the hazard's origin and makes
  // a reloaded day diverge from the same day run cold.
  if (L.liveEnd > 0 && L.liveEnd > L.lastEndMs) L.lastEndMs = L.liveEnd;
  L.liveEnd = 0;

  /** Roll the ledger over onto a new calendar day. `lastDay` survives — that is
   *  the whole cooldown mechanism — but the day's budget and floor do not. */
  function setDay(day, seed) {
    daySeed = seed | 0;
    if ((day | 0) === L.day) return;
    L.day = day | 0; L.activeMs = 0; L.firedToday = 0; L.lastEndMs = -1e9; L.liveEnd = 0;
    tickIdx = 0;
    if (save) save(L);
  }

  /** The rising hazard. Flat coins make droughts; this one gets impatient. */
  function hazard(sinceOpenMs) {
    const k = sinceOpenMs / RAMP_MS;
    return Math.min(PMAX, P0 * (1 + k * k));
  }

  /**
   * Is `d` allowed to fire right now?
   * @param {Object} d catalogue entry
   * @param {{night:number, water:boolean}} world
   */
  function eligible(d, world) {
    if (d.when === 'night' && !(world.night > 0.40)) return false;
    if (d.when === 'day' && !(world.night < 0.35)) return false;
    if (d.needs === 'water' && !world.water) return false;
    if (L.recent.indexOf(d.id) >= 0) return false;
    const last = L.lastDay[d.id];
    if (last != null && L.day - last < EVENT_TIERS[d.tier].cool) return false;
    return true;
  }

  /** Every tier's full weight, once: the denominator of the availability scale. */
  const TIER_FULL = (() => {
    const o = {};
    for (const t in EVENT_TIERS) o[t] = CATALOGUE.reduce((s, d) => s + (d.tier === t ? d.w : 0), 0);
    return o;
  })();

  /**
   * Pick a happening. Tier first — rarity is a property of the TIER, not of how
   * many events happen to sit in it — then weight inside the tier.
   *
   * A TIER IS ONLY AS LIKELY AS THE PART OF IT THAT CAN ACTUALLY HAPPEN. Each
   * tier's weight is scaled by the share of its catalogue that is eligible right
   * now, and the shortfall goes back to the other tiers rather than to whichever
   * sibling happens to be awake. Without this the rare tier is vane at noon
   * and vane is two thirds of every rare event the user ever sees, because
   * three quarters of anyone's active use is daylight. With it, the night tiers
   * become correspondingly likelier AT NIGHT and the long-run shares come out
   * where the catalogue says they should. Same mechanism covers `needs:'water'`.
   * @returns {?Object}
   */
  function pick(r1, r2, world) {
    const tiers = [];
    let tot = 0;
    for (const t in EVENT_TIERS) {
      const pool = [];
      let live = 0;
      for (const d of CATALOGUE) if (d.tier === t && eligible(d, world)) { pool.push(d); live += d.w; }
      if (!pool.length) continue;
      tot += EVENT_TIERS[t].w * (live / TIER_FULL[t]);
      tiers.push({ pool, acc: tot });
    }
    if (!tiers.length) return null;
    const q = r1 * tot;
    let hit = tiers[tiers.length - 1];
    for (const t of tiers) if (q < t.acc) { hit = t; break; }
    let wt = 0; for (const d of hit.pool) wt += d.w;
    let s = r2 * wt;
    for (const d of hit.pool) { s -= d.w; if (s <= 0) return d; }
    return hit.pool[hit.pool.length - 1];
  }

  /** How long until the floor lifts, in ms of active use. 0 = open now. */
  const floorLeft = () => Math.max(
    WARMUP_MS - L.activeMs,
    L.lastEndMs + MIN_GAP_MS - L.activeMs, 0);

  return {
    get ledger() { return L; },
    get tick() { return tickIdx; },
    setDay,
    floorLeft,
    /** Banked active use, guarded against sleeping windows. */
    bank(gapMs) {
      if (!(gapMs > 0) || gapMs > STALL_MS) return false;
      L.activeMs += gapMs;
      const t = Math.floor(L.activeMs / TICK_MS);
      if (t === tickIdx) return false;
      tickIdx = t;
      // Persist on the boundary, not per frame: one small write per 30 s of
      // active use is what makes "the same reload lands on the same day" true
      // for the ACTIVE CLOCK as well as for the rolls.
      if (save) save(L);
      return true;                                  // a tick boundary was crossed
    },
    /**
     * Evaluate the current tick. Call only on a boundary (`bank()` returned true).
     * @param {{night:number, water:boolean, busy:boolean}} world
     * @returns {?Object} the catalogue entry that fires, or null
     */
    roll(world) {
      if (world.busy) return null;                  // one at a time, always
      if (L.firedToday >= DAY_CAP) return null;     // the hard cap
      const left = floorLeft();
      if (left > 0) return null;                    // the quiet floor
      const open = L.activeMs - Math.max(WARMUP_MS, L.lastEndMs + MIN_GAP_MS);
      if (hash2(daySeed, tickIdx) >= hazard(open)) return null;
      const d = pick(hash2(daySeed, tickIdx * 7 + 1), hash2(daySeed, tickIdx * 13 + 5), world);
      if (!d) return null;
      book(d);
      return d;
    },
    /**
     * Close the books on a firing. The floor is measured from the event's
     * SCHEDULED end, not from the frame that noticed — so the wall clock
     * wandering during a 12-minute circus cannot move the next event, and a
     * cold run and a reloaded run agree to the tick.
     */
    ended() {
      L.lastEndMs = L.liveEnd || L.activeMs;
      L.liveEnd = 0;
      if (save) save(L);
    },
    /** A forced event still costs the day its budget — a debug hook must not lie. */
    forced(d) { book(d); }
  };

  /** The one place a firing is written down. */
  function book(d) {
    L.firedToday++;
    L.recent.push(d.id);
    while (L.recent.length > RECENT_N) L.recent.shift();
    L.lastDay[d.id] = L.day;
    L.liveEnd = L.activeMs + d.dur;
    if (save) save(L);
  }
}

/* ═══ mesh helpers ══════════════════════════════════════════════════════════
   ONE RULE: nothing is created outside a bag, so dispose() never has to know
   what an event built. */

function makeBag() {
  const geos = new Set(), mats = new Set();
  const bag = {
    geo(g) { geos.add(g); return g; },
    /** Every event material is transparent, ONCE, at construction: flipping
     *  `transparent` later would recompile the program mid-fade. `baseOpacity`
     *  is remembered so a translucent hide stays translucent at full alpha. */
    mat(m) {                                     // idempotent: a shared material
      if (!mats.has(m)) {                        // may be handed in more than once
        m.userData.baseOpacity = m.opacity == null ? 1 : m.opacity;
        m.transparent = true; mats.add(m);
      }
      return m;
    },
    /** A mesh whose geometry and material are both owned by this bag. */
    mesh(g, m) { return new THREE.Mesh(bag.geo(g), bag.mat(m)); },
    /** Alpha, written across every material the event owns. One call per frame. */
    alpha(a) { for (const m of mats) m.opacity = m.userData.baseOpacity * a; },
    /** Every material, for the events that need a per-material tweak. */
    mats,
    free() {
      for (const g of geos) g.dispose();
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      geos.clear(); mats.clear();
    }
  };
  return bag;
}

const std = (color, rough, extra) => Object.assign(
  { color, roughness: rough == null ? .9 : rough }, extra || {});
const basic = (color, extra) => Object.assign({ color }, extra || {});

/** Two-tone stripes baked into vertex colours: a tent, an envelope, a canopy. */
function stripe(geo, cA, cB, bands, radial) {
  const p = geo.attributes.position, n = p.count, col = new Float32Array(n * 3);
  const a = new THREE.Color(cA), b = new THREE.Color(cB);
  for (let i = 0; i < n; i++) {
    const t = radial
      ? (Math.atan2(p.getZ(i), p.getX(i)) + Math.PI) / (2 * Math.PI)
      : p.getY(i) * bands;
    const c = (Math.floor(radial ? t * bands : t) & 1) ? a : b;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/* ── instancing scratch ────────────────────────────────────────────────────
   One event is live at a time and every step() is synchronous, so a single set
   of scratch objects serves the whole catalogue and no builder allocates in a
   frame. `poseAt` is the only way an instance matrix is ever written here. */
const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _E = new THREE.Euler();
const _P = new THREE.Vector3(), _S = new THREE.Vector3(1, 1, 1);
function poseAt(im, i, px, py, pz, rx, ry, rz, s) {
  _P.set(px, py, pz); _E.set(rx, ry, rz); _Q.setFromEuler(_E);
  _S.setScalar(s == null ? 1 : s);
  im.setMatrixAt(i, _M.compose(_P, _Q, _S));
}
/** An InstancedMesh whose geometry and material the bag owns. Frustum culling
 *  is off: instance spread routinely exceeds the source geometry's bounds. */
function imesh(bag, geo, mat, n, dynamic) {
  const im = new THREE.InstancedMesh(bag.geo(geo), bag.mat(mat), n);
  if (dynamic) im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  return im;
}

/** Additive gradient along +Y: bright at the base, black (invisible) at the tip. */
function fadeY(geo, color, y0, y1) {
  const p = geo.attributes.position, n = p.count, col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    const k = 1 - clamp((p.getY(i) - y0) / (y1 - y0), 0, 1);
    col[i * 3] = c.r * k * k; col[i * 3 + 1] = c.g * k * k; col[i * 3 + 2] = c.b * k * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/* ═══ THE BUILDERS ══════════════════════════════════════════════════════════
   Each takes the build context `B` and returns {obj, step(u, now), focus}.
   `u` is 0..1 across the event's duration; `focus` is a live Vector3 the camera
   or a celebration can be pointed at. Sky events fly their own entrance, so
   their alpha is 1 throughout; ground props use B.fade. */

function buildBalloon(B) {
  const g = new THREE.Group();
  const env = B.bag.mesh(
    stripe(new THREE.SphereGeometry(3.3, 16, 12), B.accent, 0xF6EFE0, 9, true),
    new THREE.MeshStandardMaterial(std(0xffffff, .82, { vertexColors: true })));
  env.scale.set(1, 1.28, 1); env.position.y = 5.4;
  const skirt = B.bag.mesh(new THREE.ConeGeometry(3.1, 3.0, 14, 1, true),
    new THREE.MeshStandardMaterial(std(0xC9B48A, .95, { side: THREE.DoubleSide })));
  skirt.position.y = 2.7; skirt.rotation.x = Math.PI;
  const car = B.bag.mesh(new THREE.CylinderGeometry(.62, .52, .82, 9),
    new THREE.MeshStandardMaterial(std(0x8A6A3C, .95)));
  car.position.y = .4;
  const burn = B.bag.mesh(new THREE.SphereGeometry(.34, 8, 6),
    new THREE.MeshBasicMaterial(basic(0xFFB65A, { blending: THREE.AdditiveBlending, depthWrite: false })));
  burn.position.y = 1.5;
  g.add(env, skirt, car, burn);

  // A straight crossing on the weather's own heading, entering and leaving well
  // beyond the far land so the arrival is never a pop.
  const R = B.outerR + 95, wx = B.wind.x, wz = B.wind.z;
  const px = -wz, pz = wx;                        // perpendicular: the offset lane
  const lane = (B.rnd() - .5) * B.outerR * .8;
  const y = B.ground(0, 0) + 40 + B.rnd() * 10;
  const focus = new THREE.Vector3();
  return {
    obj: g, focus,
    step(u, now) {
      const t = -R + u * 2 * R;
      g.position.set(wx * t + px * lane, y + Math.sin(now / 3700) * 1.4, wz * t + pz * lane);
      g.rotation.y = Math.atan2(wx, wz) + Math.sin(now / 5200) * .09;
      burn.scale.setScalar(.8 + .5 * Math.abs(Math.sin(now / 900)));
      focus.copy(g.position);
    }
  };
}

function buildCaravan(B) {
  const g = new THREE.Group();
  // THREE WAGONS, FOUR DRAW CALLS. A caravan is one wagon three times, so the
  // bodies, the canopies and all twelve wheels are instanced. Building it as
  // nineteen little meshes cost nineteen draw calls for eight minutes — which is
  // exactly the sort of thing that shows up on the bench and nowhere else.
  const imBody = imesh(B.bag, new THREE.BoxGeometry(2.0, .72, 1.06),
    new THREE.MeshStandardMaterial(std(0x6E4F2E, .95)), 3, false);
  // stripe() reads the UNROTATED axis, so the bands are baked before the tube is
  // laid on its side; rotateZ then leaves a half-shell opening upward.
  const imCanopy = imesh(B.bag,
    stripe(new THREE.CylinderGeometry(.60, .60, 2.0, 12, 1, true, 0, Math.PI), 0xF2E4C6, 0xB6392F, 7, false)
      .rotateZ(Math.PI / 2),
    new THREE.MeshStandardMaterial(std(0xffffff, .95, { vertexColors: true, side: THREE.DoubleSide })),
    3, true);
  const imWheel = imesh(B.bag, new THREE.CylinderGeometry(.30, .30, .11, 10).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial(std(0x4A3520, .95)), 12, false);
  const crate = B.bag.mesh(new THREE.BoxGeometry(.5, .48, .5),
    new THREE.MeshStandardMaterial(std(0x9A7B4F, .96)));

  const gate = B.gate();
  const ax = Math.cos(gate.yaw), az = Math.sin(gate.yaw);      // along the road
  const nx = -az, nz = ax;                                     // across it
  const wag = [];
  for (let i = 0; i < 3; i++) {
    const d = 3.6 + i * 3.5, off = (i % 2 ? 1 : -1) * 1.15;
    const x = gate.x + ax * d + nx * off, z = gate.z + az * d + nz * off;
    const yaw = -gate.yaw + (B.rnd() - .5) * .22, y = B.ground(x, z);
    wag.push({ x, y, z, yaw });
    poseAt(imBody, i, x, y + .62, z, 0, yaw, 0);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let k = 0; k < 4; k++) {
      const lx = k < 2 ? .66 : -.66, lz = (k & 1) ? .58 : -.58;
      poseAt(imWheel, i * 4 + k, x + lx * cy + lz * sy, y + .30, z - lx * sy + lz * cy, 0, yaw, 0);
    }
    if (i === 1) crate.position.set(x + 1.5 * cy + .9 * sy, y + .24, z - 1.5 * sy + .9 * cy);
  }
  imBody.instanceMatrix.needsUpdate = true;
  imWheel.instanceMatrix.needsUpdate = true;
  g.add(imBody, imCanopy, imWheel, crate);
  const focus = new THREE.Vector3(gate.x + ax * 6.8, B.ground(gate.x, gate.z) + 1.4, gate.z + az * 6.8);
  return {
    obj: g, focus,
    step(u, now) {
      // the canvas breathing on its hoops — three matrices, once a frame
      for (let i = 0; i < 3; i++) {
        const w = wag[i];
        poseAt(imCanopy, i, w.x, w.y + 1.0, w.z, Math.sin(now / (2100 + i * 340)) * .022, w.yaw, 0);
      }
      imCanopy.instanceMatrix.needsUpdate = true;
    }
  };
}

function buildCat(B) {
  const g = new THREE.Group();
  const fur = B.bag.mat(new THREE.MeshStandardMaterial(std(0x30302E, .98)));
  const body = new THREE.Mesh(B.bag.geo(new THREE.CapsuleGeometry(.115, .26, 3, 7)), fur);
  body.rotation.z = Math.PI / 2; body.position.y = .18;
  const head = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(.115, 9, 7)), fur);
  head.position.set(.26, .25, 0);
  const tail = new THREE.Mesh(B.bag.geo(new THREE.CapsuleGeometry(.028, .30, 2, 5)), fur);
  tail.position.set(-.26, .26, 0);
  // ears and legs are repeats and never move independently: two instanced draws
  const ears = imesh(B.bag, new THREE.ConeGeometry(.05, .09, 4), fur, 2, false);
  const legs = imesh(B.bag, new THREE.CylinderGeometry(.035, .032, .17, 5), fur, 4, false);
  for (let k = 0; k < 2; k++) poseAt(ears, k, .26, .35, (k ? 1 : -1) * .06, 0, 0, 0);
  for (let k = 0; k < 4; k++) poseAt(legs, k, k < 2 ? .16 : -.14, .085, (k & 1 ? .075 : -.075), 0, 0, 0);
  ears.instanceMatrix.needsUpdate = true; legs.instanceMatrix.needsUpdate = true;
  g.add(body, head, tail, ears, legs);

  // A slow patrol of the warm stone at the plaza rim, with long stops: a cat
  // that never sits is a dog.
  const R = Math.max(B.plazaR() * .66, 4.2), a0 = B.rnd() * Math.PI * 2;
  const focus = new THREE.Vector3();
  return {
    obj: g, focus,
    step(u, now) {
      // stop-and-go: the angle advances only over 40 % of each 26 s cycle
      const c = (now / 26000) % 1, walk = smooth(clamp((c - .30) / .40, 0, 1));
      const a = a0 + (Math.floor(now / 26000) + walk) * .78;
      const x = B.mon.x + Math.cos(a) * R, z = B.mon.z + Math.sin(a) * R;
      g.position.set(x, B.ground(x, z), z);
      g.rotation.y = -a + Math.PI / 2;
      const moving = walk > .02 && walk < .98;
      body.position.y = .18 + (moving ? Math.abs(Math.sin(now / 190)) * .012 : 0);
      tail.rotation.z = .9 + Math.sin(now / (moving ? 520 : 1500)) * (moving ? .35 : .18);
      head.rotation.z = moving ? 0 : Math.sin(now / 2600) * .22;
      focus.set(x, g.position.y + .6, z);
    }
  };
}

function buildBard(B) {
  const g = new THREE.Group();
  const cloth = B.bag.mat(new THREE.MeshStandardMaterial(std(0x6B3F86, .95)));
  const skin = B.bag.mat(new THREE.MeshStandardMaterial(std(0xD8A87C, .92)));
  const wood = B.bag.mat(new THREE.MeshStandardMaterial(std(0xA5722C, .7)));
  const body = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.15, .22, .46, 8)), cloth);
  body.position.y = .23;
  const head = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(.135, 10, 8)), skin);
  head.position.y = .60;
  const hat = new THREE.Mesh(B.bag.geo(new THREE.ConeGeometry(.20, .26, 7)), cloth);
  hat.position.y = .78;
  const lute = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(.16, 10, 8)), wood);
  lute.scale.set(1, 1.08, .48); lute.position.set(.20, .34, .14);
  const neck = new THREE.Mesh(B.bag.geo(new THREE.BoxGeometry(.036, .40, .05)), wood);
  neck.position.set(.32, .56, .14); neck.rotation.z = -.42;
  g.add(body, head, hat, lute, neck);

  // The notes: 22 additive points that rise out of the lute and wink out.
  const N = B.quality === 'low' ? 12 : 22;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const ph = new Float32Array(N);
  for (let i = 0; i < N; i++) ph[i] = B.rnd();
  const pg = B.bag.geo(new THREE.BufferGeometry());
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pm = B.bag.mat(new THREE.PointsMaterial({
    size: .19, sizeAttenuation: true, vertexColors: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  }));
  const notes = new THREE.Points(pg, pm);
  g.add(notes);

  const R = Math.max(B.plazaR() * .72, 4.6), a = B.rnd() * Math.PI * 2;
  const x = B.mon.x + Math.cos(a) * R, z = B.mon.z + Math.sin(a) * R;
  g.position.set(x, B.ground(x, z), z);
  g.rotation.y = -a + Math.PI;
  const focus = new THREE.Vector3(x, g.position.y + 1.1, z);
  const acc = new THREE.Color(B.accent);
  return {
    obj: g, focus,
    step(u, now) {
      const sway = Math.sin(now / 700);
      body.rotation.z = sway * .05; head.rotation.z = sway * .07;
      neck.rotation.z = -.42 + Math.sin(now / 340) * .05;
      for (let i = 0; i < N; i++) {
        const t = ((now / 4200) + ph[i]) % 1;
        const k = Math.sin(Math.PI * t);                       // in and out, never a pop
        pos[i * 3] = .22 + Math.sin(t * 7 + ph[i] * 9) * .34;
        pos[i * 3 + 1] = .42 + t * 1.7;
        pos[i * 3 + 2] = .16 + Math.cos(t * 5 + ph[i] * 7) * .30;
        col[i * 3] = acc.r * k; col[i * 3 + 1] = acc.g * k; col[i * 3 + 2] = acc.b * k;
      }
      pg.attributes.position.needsUpdate = true;
      pg.attributes.color.needsUpdate = true;
    }
  };
}

function buildPigeons(B) {
  const N = B.quality === 'low' ? 18 : 34;
  const im = imesh(B.bag, new THREE.ConeGeometry(.13, .40, 4).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial(std(0x9AA0AA, .92)), N, true);
  const rr = new Float32Array(N), hh = new Float32Array(N), pp = new Float32Array(N), sp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rr[i] = 12 + B.rnd() * 11; hh[i] = 11 + B.rnd() * 8;
    pp[i] = B.rnd() * Math.PI * 2; sp[i] = .55 + B.rnd() * .30;
  }
  const y0 = B.ground(B.mon.x, B.mon.z);
  const focus = new THREE.Vector3(B.mon.x, y0 + 15, B.mon.z);
  return {
    obj: im, focus,
    step(u, now) {
      // The whole loft climbs on arrival and settles back at the end: one wheel,
      // read as a single organism, which is the point of a flock.
      const lift = smooth(u / .18) * (1 - smooth((u - .82) / .18));
      for (let i = 0; i < N; i++) {
        const a = pp[i] + now / 1000 * sp[i] * .55;
        const r = rr[i] * (.55 + .45 * lift);
        poseAt(im, i, B.mon.x + Math.cos(a) * r,
          y0 + 3 + hh[i] * lift + Math.sin(now / 800 + pp[i]) * .5,
          B.mon.z + Math.sin(a) * r,
          Math.sin(now / 260 + pp[i]) * .18, -a + Math.PI / 2, Math.sin(now / 200 + pp[i]) * .5);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  };
}

function buildGeese(B) {
  const N = 16;
  const im = imesh(B.bag, new THREE.ConeGeometry(.22, .86, 3).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial(std(0x4C4438, .92)), N, true);
  // The V, in flock-local coordinates: leader at the point, two trailing arms.
  const lx = new Float32Array(N), lz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const rank = Math.floor(i / 2) + (i ? 1 : 0), side = (i & 1) ? 1 : -1;
    lx[i] = i ? -rank * 1.5 : 0;
    lz[i] = i ? side * rank * 1.15 : 0;
  }
  // Two out of position — the joke, and the thing that stops it reading as a decal.
  lz[9] += 2.4; lx[9] -= 1.9; lz[12] -= 3.1;
  const head = B.rnd() * Math.PI * 2, hx = Math.cos(head), hz = Math.sin(head);
  const px = -hz, pz = hx;
  const R = B.outerR + 110, y = B.ground(0, 0) + 52 + B.rnd() * 12;
  const focus = new THREE.Vector3();
  return {
    obj: im, focus,
    step(u, now) {
      const t = -R + u * 2 * R;
      const cx = hx * t, cz = hz * t;
      for (let i = 0; i < N; i++) {
        const flap = Math.sin(now / 190 + i * .9);
        poseAt(im, i, cx + hx * lx[i] + px * lz[i],
          y + flap * .22 + Math.sin(now / 2600 + i) * .3,
          cz + hz * lx[i] + pz * lz[i], 0, -head + Math.PI / 2, flap * .42);
      }
      im.instanceMatrix.needsUpdate = true;
      focus.set(cx, y, cz);
    }
  };
}

function buildCircus(B) {
  const g = new THREE.Group();
  const canvasMat = B.bag.mat(new THREE.MeshStandardMaterial(std(0xffffff, .93,
    { vertexColors: true, side: THREE.DoubleSide })));
  const top = new THREE.Mesh(
    B.bag.geo(stripe(new THREE.ConeGeometry(6.6, 7.4, 14), 0xC33B2E, 0xF4E9D2, 14, true)), canvasMat);
  top.position.y = 5.5;
  const drum = new THREE.Mesh(
    B.bag.geo(stripe(new THREE.CylinderGeometry(6.6, 6.6, 1.9, 14, 1, true), 0xC33B2E, 0xF4E9D2, 14, true)),
    canvasMat);
  drum.position.y = .95;
  // side tents, guy poles and pennants: three instanced draws instead of ten
  const tents = imesh(B.bag, stripe(new THREE.ConeGeometry(2.3, 3.0, 9), 0x2F6E5B, 0xF4E9D2, 9, true),
    canvasMat, 2, false);
  const poles = imesh(B.bag, new THREE.CylinderGeometry(.06, .07, 2.4, 5),
    new THREE.MeshStandardMaterial(std(0x6A5133, .95)), 4, false);
  const flags = imesh(B.bag, new THREE.ConeGeometry(.30, .82, 3).rotateZ(Math.PI / 2),
    new THREE.MeshStandardMaterial(std(B.accent, .85, { side: THREE.DoubleSide })), 4, true);
  poseAt(tents, 0, -8.2, 1.5, 4.9, 0, .7, 0);
  poseAt(tents, 1, 8.6, 1.5, -5.4, 0, -1.1, 0);
  const fa = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + .4; fa[i] = a;
    poseAt(poles, i, Math.cos(a) * 9.4, 1.2, Math.sin(a) * 9.4, 0, 0, 0);
  }
  tents.instanceMatrix.needsUpdate = true; poles.instanceMatrix.needsUpdate = true;
  g.add(top, drum, tents, poles, flags);
  // Beyond the gate, off the road: a circus camps NEAR a town, not in it.
  const gate = B.gate();
  const ax = Math.cos(gate.yaw), az = Math.sin(gate.yaw);
  const d = Math.max(B.outerR * .55, 26) + 22;
  const cx = gate.x + ax * d - az * 13, cz = gate.z + az * d + ax * 13;
  g.position.set(cx, B.ground(cx, cz), cz);
  g.rotation.y = B.rnd() * Math.PI * 2;
  const focus = new THREE.Vector3(cx, g.position.y + 5, cz);
  return {
    obj: g, focus,
    step(u, now) {
      const w = B.gust();                        // the pennants read the real wind
      for (let i = 0; i < 4; i++) {
        const a = fa[i];
        poseAt(flags, i, Math.cos(a) * 9.4 + .32, 2.3, Math.sin(a) * 9.4,
          0, a + Math.sin(now / 900 + a * 3) * .5 * w, 0);
      }
      flags.instanceMatrix.needsUpdate = true;
      top.rotation.y = Math.sin(now / 6400) * .012;
    }
  };
}

function buildFireflies(B) {
  const N = B.quality === 'low' ? 110 : 240;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const bx = new Float32Array(N), bz = new Float32Array(N), by = new Float32Array(N);
  const ph = new Float32Array(N), sp = new Float32Array(N);
  const path = B.waterPath();
  for (let i = 0; i < N; i++) {
    let x, z;
    if (path && path.length > 1) {
      const t = B.rnd() * (path.length - 1), k = Math.floor(t), f = t - k;
      const a = path[k], b = path[Math.min(k + 1, path.length - 1)];
      const nx = -(b.z - a.z), nz = (b.x - a.x), L = Math.hypot(nx, nz) || 1;
      const off = (B.rnd() - .5) * (B.waterWidth() + 9);
      x = a.x + (b.x - a.x) * f + nx / L * off;
      z = a.z + (b.z - a.z) * f + nz / L * off;
    } else {                                   // no water: the meadow beyond the lanes
      const a = B.rnd() * Math.PI * 2, r = B.outerR * (.65 + B.rnd() * .5);
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    }
    bx[i] = x; bz[i] = z; by[i] = B.ground(x, z) + .3 + B.rnd() * 3.4;
    ph[i] = B.rnd() * Math.PI * 2; sp[i] = .5 + B.rnd() * 1.1;
  }
  const pg = B.bag.geo(new THREE.BufferGeometry());
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pm = B.bag.mat(new THREE.PointsMaterial({
    size: .30, sizeAttenuation: true, vertexColors: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  }));
  const pts = new THREE.Points(pg, pm);
  pts.frustumCulled = false;
  let cx = 0, cz = 0, cy = 0;
  for (let i = 0; i < N; i++) { cx += bx[i]; cz += bz[i]; cy += by[i]; }
  const focus = new THREE.Vector3(cx / N, cy / N + 1.5, cz / N);
  return {
    obj: pts, focus,
    step(u, now) {
      // Envelope: the swarm swells in over the first 3 % and dims out over the
      // last 4 %, so it never blinks on. The shell's own fade rides the material
      // opacity on top of this; both are needed, because a point that is dim and
      // a point that is absent look different at this size.
      const env = smooth(u * 30) * (1 - smooth((u - .96) / .04));
      for (let i = 0; i < N; i++) {
        const t = now / 1000 * sp[i] + ph[i];
        pos[i * 3] = bx[i] + Math.sin(t * .41) * 1.5;
        pos[i * 3 + 1] = by[i] + Math.sin(t * .27 + 1.1) * .8;
        pos[i * 3 + 2] = bz[i] + Math.cos(t * .33) * 1.5;
        // the blink: mostly off, briefly bright — a steady field reads as dust
        const b = Math.pow(Math.max(0, Math.sin(t * 1.7)), 6) * env;
        col[i * 3] = b * 1.0; col[i * 3 + 1] = b * .92; col[i * 3 + 2] = b * .34;
      }
      pg.attributes.position.needsUpdate = true;
      pg.attributes.color.needsUpdate = true;
    }
  };
}

function buildSurveyor(B) {
  const g = new THREE.Group();
  const wood = B.bag.mat(new THREE.MeshStandardMaterial(std(0x7B5B33, .9)));
  const brass = B.bag.mat(new THREE.MeshStandardMaterial(std(0xC9A227, .35, { metalness: .75 })));
  const coat = B.bag.mat(new THREE.MeshStandardMaterial(std(0x38506B, .95)));
  const skin = B.bag.mat(new THREE.MeshStandardMaterial(std(0xD8A87C, .92)));
  const rig = new THREE.Group();
  const legs = imesh(B.bag, new THREE.CylinderGeometry(.022, .022, 1.5, 5), wood, 3, false);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2;
    poseAt(legs, i, Math.cos(a) * .21, .72, Math.sin(a) * .21, Math.sin(a) * .27, 0, -Math.cos(a) * .27);
  }
  legs.instanceMatrix.needsUpdate = true;
  rig.add(legs);
  const scope = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.055, .055, .46, 8).rotateZ(Math.PI / 2)), brass);
  scope.position.y = 1.54;
  const yoke = new THREE.Mesh(B.bag.geo(new THREE.BoxGeometry(.15, .16, .15)), brass);
  yoke.position.y = 1.44;
  rig.add(scope, yoke);
  const body = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.15, .21, .48, 8)), coat);
  body.position.set(-.55, .24, 0);
  const head = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(.13, 10, 8)), skin);
  head.position.set(-.55, .61, 0);
  g.add(rig, body, head);

  const R = Math.max(B.plazaR() * .80, 5.4), a = B.rnd() * Math.PI * 2;
  const x = B.mon.x + Math.cos(a) * R, z = B.mon.z + Math.sin(a) * R;
  g.position.set(x, B.ground(x, z), z);
  g.rotation.y = Math.atan2(B.mon.x - x, B.mon.z - z);         // sighting the fountain
  const focus = new THREE.Vector3(x, g.position.y + 1.4, z);
  return {
    obj: g, focus,
    step(u, now) {
      // measure · write it down · measure again, on an 18 s cycle
      const c = (now / 18000) % 1;
      scope.rotation.y = Math.sin(now / 5200) * .22;
      rig.rotation.y = Math.sin(now / 9000) * .10;
      const writing = c > .55 && c < .8;
      head.position.y = .61 - (writing ? .07 : 0);
      body.rotation.x = writing ? .28 : Math.sin(now / 3400) * .04;
    }
  };
}

function buildLanterns(B) {
  const N = B.quality === 'low' ? 22 : 44;
  // Unlit on purpose: a paper lantern at 60 units is a warm dot, and a lit
  // material at that size just goes grey the moment the sun does.
  const im = imesh(B.bag, new THREE.CylinderGeometry(.20, .26, .34, 7),
    new THREE.MeshBasicMaterial(basic(0xFFC46B, { depthWrite: false })), N, true);
  const sx = new Float32Array(N), sz = new Float32Array(N), t0 = new Float32Array(N);
  const sy = new Float32Array(N), rate = new Float32Array(N), ph = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = B.rnd() * Math.PI * 2, r = B.outerR * (.15 + B.rnd() * .80);
    sx[i] = Math.cos(a) * r; sz[i] = Math.sin(a) * r;
    sy[i] = B.ground(sx[i], sz[i]) + 2.5 + B.rnd() * 3;
    t0[i] = B.rnd() * .34;                       // staggered: they do not launch as one
    rate[i] = 3.6 + B.rnd() * 2.4; ph[i] = B.rnd() * 6.283;
  }
  const focus = new THREE.Vector3(0, 0, 0);
  return {
    obj: im, focus,
    step(u, now) {
      const wx = B.wind.x, wz = B.wind.z;
      let hy = 0;
      for (let i = 0; i < N; i++) {
        const t = clamp((u - t0[i]) / (1 - t0[i]), 0, 1);
        const climb = t * t * (3 - 2 * t);         // slow off the ground, steady after
        const y = sy[i] + climb * (34 + rate[i] * 6);
        const drift = climb * climb * 26;
        // shrink over the last third of the climb: they do not vanish, they get
        // far away, and a scale of 0 is also how one that has not launched hides
        const k = (t > 0 ? 1 : 0) * (1 - smooth((climb - .68) / .32) * .82);
        poseAt(im, i, sx[i] + wx * drift + Math.sin(now / 2400 + ph[i]) * .8, y,
          sz[i] + wz * drift + Math.cos(now / 2700 + ph[i]) * .8,
          Math.sin(now / 1800 + ph[i]) * .10, ph[i], Math.cos(now / 2100 + ph[i]) * .10, k);
        hy += y;
      }
      im.instanceMatrix.needsUpdate = true;
      focus.set(0, hy / N * .55, 0);
    }
  };
}

function buildComet(B) {
  const g = new THREE.Group();
  const head = B.bag.mesh(new THREE.SphereGeometry(1.15, 14, 10),
    new THREE.MeshBasicMaterial(basic(0xEAF2FF, { blending: THREE.AdditiveBlending, depthWrite: false })));
  // The gradient runs bright at the cone's BASE — which `position.y = 27` puts
  // exactly on the head — to black at the tip. Under additive blending black is
  // invisible, so the tail dissolves into the sky with no alpha sorting at all.
  const tail = B.bag.mesh(
    fadeY(new THREE.ConeGeometry(3.0, 54, 12, 1, true), 0x9CC4FF, -27, 27),
    new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
  tail.position.y = 27;
  const halo = B.bag.mesh(new THREE.SphereGeometry(2.4, 12, 10),
    new THREE.MeshBasicMaterial(basic(0x3F5F9E, { blending: THREE.AdditiveBlending, depthWrite: false })));
  g.add(tail, halo, head);
  // High, north-ish, and effectively STILL: a comet that streaks past is a
  // meteor, and the joke in the copy is that this one is not going anywhere.
  const a = -0.6 + B.rnd() * 1.2;
  const D = B.outerR + 210, y = B.ground(0, 0) + 165;
  g.position.set(Math.sin(a) * D, y, -Math.cos(a) * D);
  g.rotation.set(0.42, -a, 0.30);
  const focus = g.position.clone();
  return {
    obj: g, focus,
    step(u, now) {
      const p = .9 + .12 * Math.sin(now / 2600) + .05 * Math.sin(now / 730);
      head.scale.setScalar(p);
      halo.scale.setScalar(.9 + .2 * Math.sin(now / 4100));
      g.rotation.z = .30 + Math.sin(now / 12000) * .03;
    }
  };
}

// The weathercock on the market post spins hard with no wind at all. This
// replaced a coin that lifted off the altar and span in mid-air: the altar is
// gone, and AESTHETIC.md's third rule rules out floating geometry anyway. A
// gilded vane is explicitly allowed, and "nobody touched it" is funnier when the
// thing is bolted down.
function buildVane(B) {
  const g = new THREE.Group();
  const oak = B.bag.mat(new THREE.MeshStandardMaterial(std(0x6B4F35, .92)));
  const iron = B.bag.mat(new THREE.MeshStandardMaterial(std(0x2F2C28, .55, { metalness: .45 })));
  const gilt = B.bag.mat(new THREE.MeshStandardMaterial(std(0xC9A15A, .32, { metalness: .82 })));

  const post = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.10, .14, 4.0, 8)), oak);
  post.position.y = 2.0;
  const collar = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.13, .13, .12, 8)), iron);
  collar.position.y = 4.02;

  // Everything above the collar turns. The cardinals turn WITH it, which is the
  // joke — a vane whose N points somewhere new every second.
  const spin = new THREE.Group();
  spin.position.y = 4.08;
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Mesh(B.bag.geo(new THREE.BoxGeometry(.62, .03, .03)), iron);
    arm.position.set(Math.cos(i * Math.PI / 2) * .31, .06, Math.sin(i * Math.PI / 2) * .31);
    arm.rotation.y = -i * Math.PI / 2;
    spin.add(arm);
  }
  // the cockerel: a flat plate read in silhouette, a tail fin and a comb
  const bird = new THREE.Group();
  bird.position.y = .46;
  const plate = new THREE.Mesh(B.bag.geo(new THREE.BoxGeometry(.66, .34, .022)), gilt);
  const tail = new THREE.Mesh(B.bag.geo(new THREE.ConeGeometry(.20, .34, 4)), gilt);
  tail.position.set(-.34, .10, 0); tail.rotation.z = -Math.PI / 2 - .5;
  const head = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(.09, 8, 6)), gilt);
  head.position.set(.31, .16, 0);
  const comb = new THREE.Mesh(B.bag.geo(new THREE.ConeGeometry(.05, .12, 4)), gilt);
  comb.position.set(.32, .27, 0);
  bird.add(plate, tail, head, comb);
  const spindle = new THREE.Mesh(B.bag.geo(new THREE.CylinderGeometry(.02, .02, .52, 6)), iron);
  spindle.position.y = .26;
  spin.add(spindle, bird);
  g.add(post, collar, spin);

  const R = Math.max(B.plazaR() * .78, 5.2), a = B.rnd() * Math.PI * 2;
  const x = B.mon.x + Math.cos(a) * R, z = B.mon.z + Math.sin(a) * R;
  g.position.set(x, B.ground(x, z), z);
  const focus = new THREE.Vector3(x, g.position.y + 3.4, z);
  return {
    obj: g, focus,
    step(u, now) {
      // Fast, and never quite steady: a constant rate reads as machinery, and
      // the whole point is that it looks like it cannot help itself.
      spin.rotation.y = now / 170 + Math.sin(now / 1900) * .55;
      bird.rotation.z = Math.sin(now / 640) * .045;      // the plate flutters
      post.rotation.z = Math.sin(now / 2100) * .006;     // the post takes the strain
    }
  };
}

function buildLeviathan(B) {
  const g = new THREE.Group();
  const hide = B.bag.mat(new THREE.MeshStandardMaterial(std(0x53607A, .85, { opacity: .72 })));
  const body = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(1, 20, 14)), hide);
  body.scale.set(9.5, 3.0, 3.4);
  const headBump = new THREE.Mesh(B.bag.geo(new THREE.SphereGeometry(1, 12, 10)), hide);
  headBump.scale.set(2.6, 2.2, 2.6); headBump.position.set(6.6, .3, 0);
  // flukes and fins are mirrored pairs: one instanced draw each. The flattening
  // is baked into the geometry, because an instance matrix carries a uniform
  // scale in poseAt and a whale needs its fins thin, not small.
  const tail = new THREE.Group();
  const flukes = imesh(B.bag, new THREE.ConeGeometry(2.2, 4.4, 4).rotateZ(Math.PI / 2).scale(1, 1, .22), hide, 2, false);
  for (let k = 0; k < 2; k++) poseAt(flukes, k, -2.0, 0, (k ? 1 : -1) * 1.9, 0, (k ? 1 : -1) * .5, 0);
  flukes.instanceMatrix.needsUpdate = true;
  tail.add(flukes);
  tail.position.set(-9.0, 0, 0);
  const fins = imesh(B.bag, new THREE.ConeGeometry(1.3, 3.6, 4).rotateZ(Math.PI / 2).scale(1, 1, .28), hide, 2, false);
  for (let k = 0; k < 2; k++) {
    const s = k ? 1 : -1;
    poseAt(fins, k, 1.6, -1.0, s * 2.4, s * .5, 0, -.25);
  }
  fins.instanceMatrix.needsUpdate = true;
  g.add(fins);
  const eye = B.bag.mesh(new THREE.SphereGeometry(.30, 8, 6),
    new THREE.MeshStandardMaterial(std(0x14161C, .5)));
  eye.position.set(7.4, .7, 1.9);
  g.add(body, headBump, tail, eye);

  const wx = B.wind.x, wz = B.wind.z, px = -wz, pz = wx;
  const R = B.outerR + 130, lane = (B.rnd() - .5) * B.outerR * .7;
  const y = B.ground(0, 0) + 58 + B.rnd() * 14;
  const focus = new THREE.Vector3();
  return {
    obj: g, focus,
    step(u, now) {
      const t = -R + u * 2 * R;
      const sw = Math.sin(now / 3400);
      g.position.set(wx * t + px * lane, y + sw * 2.4, wz * t + pz * lane);
      g.rotation.y = Math.atan2(wx, wz) - Math.PI / 2;
      g.rotation.z = sw * .10;
      tail.rotation.y = Math.sin(now / 3400 - 1.1) * .34;      // the tail lags the body
      tail.rotation.z = Math.sin(now / 3400 - .6) * .18;
      focus.copy(g.position);
    }
  };
}

/* ═══ the system ════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} EventsConfig
 * @property {number} [daySeed]     the calendar date seed — owns the day's luck
 * @property {number} [seed]        planSeed — mesh jitter only, never scheduling
 * @property {()=>Object} [getPlan] live plan (gate, water, outerR)
 * @property {(x:number,z:number)=>number} [sampleHeight]
 * @property {()=>number} [plazaR] @property {()=>number} [outerR]
 * @property {THREE.Vector3} [monument]   the fountain's foot
 * @property {()=>number} [monumentTop]   the fountain's crown height, world Y
 * @property {()=>number} [accent]        ctx.accent
 * @property {()=>string} [townName]      for the {town} slot
 * @property {Object} [wx]                weather's WX uniform bus (wind + gust)
 * @property {(pos:THREE.Vector3,opts:Object)=>void} [celebrate]  npcs.celebrate
 * @property {(text:string)=>boolean} [announce]  npcs.announce, via town.js's crier bookkeeping
 * @property {(pos:THREE.Vector3,text:string)=>boolean} [speak]   news.say relay
 * @property {(type:string,data:Object)=>void} [post]   news.post, if an EVENT category exists
 * @property {(msg:string,ms?:number)=>void} [toast]    ui.toast
 * @property {'low'|'high'} [quality]
 */

/**
 * @typedef {Object} EventSystem
 * @property {THREE.Group} group
 * @property {(dt:number, now:number, ctx:Object)=>void} update
 * @property {()=>?{id:string,tier:string,title:string,t01:number,focus:THREE.Vector3}} active
 * @property {()=>Array<{w:number,text:string}>} news
 * @property {(id:string)=>boolean} force
 * @property {(daySeed:number)=>void} setSeed
 * @property {(q:string)=>void} setQuality
 * @property {()=>Object} stats
 * @property {()=>void} reset @property {()=>void} dispose
 */

/**
 * Build the event system. Adds one empty Group to the scene and nothing else
 * until something actually happens.
 * @param {THREE.Scene} scene
 * @param {EventsConfig} cfg
 * @returns {EventSystem}
 */
export function initEvents(scene, cfg) {
  const c = cfg || {};
  const group = new THREE.Group();
  group.name = 'events';
  group.matrixAutoUpdate = true;
  if (scene && scene.add) scene.add(group);

  const fn = (v, d) => typeof v === 'function' ? v : () => d;
  const getPlan = fn(c.getPlan, null);
  const sampleH = typeof c.sampleHeight === 'function' ? c.sampleHeight : null;
  const plazaR = fn(c.plazaR, 12);
  const outerR = fn(c.outerR, 60);
  const accentOf = fn(c.accent, 0xE0B33A);
  const townOf = fn(c.townName, 'the town');
  const monTop = fn(c.monumentTop, null);
  const MON = (c.monument || new THREE.Vector3()).clone();
  const wxBus = c.wx || null;
  const call = (f, ...a) => { if (typeof f === 'function') { try { return f(...a); } catch (e) { return false; } } return false; };
  let quality = c.quality === 'low' ? 'low' : 'high';

  let daySeed = (c.daySeed | 0) || 1;
  let rnd = stream(((c.seed | 0) ^ 0x51E5A17) >>> 0);

  /* ── the persistent luck ledger ───────────────────────────────────────────
     localStorage, guarded end to end. Nothing here is load-bearing: lose it and
     the town simply gets a fresh fortnight, which is a mercy, not a bug. */
  const KEY = 'tokentown.events.v1';
  const today = () => dayIndexOf(Date.now());
  function loadLedger() {
    try {
      const raw = HAS_WIN && window.localStorage && window.localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o.day === 'number' && Array.isArray(o.recent) && o.lastDay) {
          const L = freshLedger(o.day);
          L.activeMs = +o.activeMs || 0; L.firedToday = o.firedToday | 0;
          L.lastEndMs = typeof o.lastEndMs === 'number' ? o.lastEndMs : -1e9;
          L.liveEnd = +o.liveEnd || 0;   // an event cut off by the reload; see makeScheduler
          L.recent = o.recent.filter(id => BY_ID.has(id)).slice(-RECENT_N);
          for (const k in o.lastDay) if (BY_ID.has(k) && typeof o.lastDay[k] === 'number') L.lastDay[k] = o.lastDay[k];
          return L;
        }
      }
    } catch (e) { /* private mode, node, a corrupt blob: all the same answer */ }
    return freshLedger(today());
  }
  let saveAt = -1e9;
  function saveLedger(L) {
    // Throttled: the ledger changes at most once per event, but `bank` could in
    // principle call through on a pathological clock. Never more than 1 write/5 s.
    const t = nowMs();
    if (t - saveAt < 5000) return;
    saveAt = t;
    try {
      if (HAS_WIN && window.localStorage) window.localStorage.setItem(KEY, JSON.stringify(L));
    } catch (e) { /* quota, private mode: the ledger stays in memory */ }
  }
  const sched = makeScheduler({ daySeed, ledger: loadLedger(), save: saveLedger });
  sched.setDay(today(), daySeed);

  /* ── live-event state ─────────────────────────────────────────────────── */
  let live = null;                 // {def, t0, dur, bag, node, step, focus, …}
  let lastNow = 0, warned = false;
  let ctxNight = 0;
  const _p = new THREE.Vector3();
  const wind = { x: 1, z: 0 };

  const groundAt = (x, z) => {
    if (!sampleH) return 0;
    const y = sampleH(x, z);
    return typeof y === 'number' && isFinite(y) ? y : 0;
  };
  const gateOf = () => {
    const p = getPlan();
    const g = p && p.gate;
    return g && typeof g.x === 'number'
      ? { x: g.x, z: g.z, yaw: typeof g.yaw === 'number' ? g.yaw : 0 }
      : { x: outerR() * .8, z: 0, yaw: 0 };
  };
  const waterPath = () => {
    const p = getPlan();
    const w = p && p.water;
    return w && Array.isArray(w.path) && w.path.length > 1 ? w.path : null;
  };
  const hasWater = () => !!waterPath();

  /* ── the build context handed to every builder ─────────────────────────── */
  const B = {
    bag: null,
    get quality() { return quality; },
    rnd: () => rnd(),
    ground: groundAt,
    gate: gateOf,
    waterPath,
    waterWidth: () => { const p = getPlan(); const w = p && p.water; return (w && +w.width) || 8; },
    mon: MON,
    plazaR, outerR: 0,
    get accent() { return accentOf(); },
    monumentTop: () => {
      const t = monTop();
      return typeof t === 'number' && isFinite(t) ? t : MON.y + 17;
    },
    wind,
    gust: () => (wxBus && wxBus.uGust ? wxBus.uGust.value : 1),
    alpha: () => (live ? live.alpha : 1)
  };

  /* ── copy ─────────────────────────────────────────────────────────────── */
  const fill = s => String(s).replace(/\{town\}/g, townOf() || 'the town');

  /* ── start / end ──────────────────────────────────────────────────────── */
  function start(def, now) {
    if (live) return false;
    const bag = makeBag();
    B.bag = bag;
    B.outerR = Math.max(28, outerR() || 60);
    let built = null;
    try { built = def.build(B); } catch (e) {
      // A builder that throws must not take the frame with it, and must not
      // leave half a circus in the scene.
      bag.free();
      if (!warned && HAS_WIN && window.console) { warned = true; console.warn('[events] build failed:', def.id, e); }
      return false;
    }
    group.add(built.obj);
    live = {
      def, bag, node: built.obj, step: built.step,
      focus: built.focus || _p, t0: now, dur: def.dur,
      alpha: 0, sayAt: now + 2600, sayI: Math.floor(rnd() * def.says.length),
      shoutAt: now + 700, shoutLeft: SHOUT_TRIES, shouted: false,
      lineI: Math.floor(rnd() * def.lines.length), forced: false
    };
    // First pose BEFORE the first render: a headless shot at t+0 must not catch
    // an untouched group sitting at the origin.
    try { live.step(0, now); } catch (e) { /* stepped again next frame */ }
    bag.alpha(0);
    call(c.toast, 'Something is happening in town.', 3200);
    call(c.post, 'event', { title: fill(def.title), label: def.id, tierName: def.tier });
    if (def.attract) call(c.celebrate, live.focus, {
      runners: Math.min(8, Math.round(def.attract / 2)), cheerRadius: def.attract
    });
    return true;
  }

  function end() {
    if (!live) return;
    // A FORCED EVENT MUST SURVIVE THE BOOT RESET. town.js hardResets the moment
    // the first real feed lands, which is normally a second or two after the
    // page arms `?event=…` — so an unconfirmed forced event re-arms rather than
    // being silently eaten, and a headless shot is not a coin flip.
    if (live.forced && forceId) forceAt = lastNow + 1200;
    group.remove(live.node);
    // InstancedMesh owns an instanceMatrix (and possibly instanceColor) buffer
    // that the bag never saw; its dispose() is the only thing that frees them.
    live.node.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    live.bag.free();
    live = null;
    sched.ended();
  }

  /* ── the frame ────────────────────────────────────────────────────────── */
  function update(dt, now, ctx) {
    const t = typeof now === 'number' ? now : nowMs();
    ctxNight = ctx && typeof ctx.night === 'number' ? ctx.night : 0;
    if (wxBus && wxBus.uWindV && wxBus.uWindV.value) {
      wind.x = wxBus.uWindV.value.x; wind.z = wxBus.uWindV.value.y;
    }

    if (live) {
      const u = (t - live.t0) / live.dur;
      if (u >= 1) { end(); }
      else {
        // Ground props fade; sky props fly their own entrance and stay at 1.
        const f = Math.min(smooth((u * live.dur) / FADE_MS), 1 - smooth((u - 1) * live.dur / FADE_MS + 1));
        live.alpha = clamp(f, 0, 1);
        live.bag.alpha(live.alpha);
        try { live.step(u, t, ctx); } catch (e) { end(); }
      }
    }

    if (live) {
      const d = live.def;
      // Six seconds on screen is "it ran": the force is spent and stops re-arming.
      if (live.forced && forceId && t - live.t0 > 6000) forceId = '';
      // The Crier. He may be busy, off duty, or halfway across town; retry on the
      // wall clock and then stop asking — the ticker carries the news regardless.
      if (!live.shouted && live.shoutLeft > 0 && t >= live.shoutAt) {
        live.shoutAt = t + SHOUT_EVERY; live.shoutLeft--;
        if (call(c.announce, fill(d.shout)) === true) live.shouted = true;
      }
      // The villagers. One remark at a time, relayed through news.say, which is
      // free to refuse it (off screen, crowded, on top of the fountain's board).
      if (t >= live.sayAt) {
        live.sayAt = t + SAY_MS;
        live.sayI = (live.sayI + 1) % d.says.length;
        call(c.speak, live.focus, d.says[live.sayI]);
      }
    }

    /* ── the scheduler ──
       THE FOUNDING RITUAL IS NOT ACTIVE USE. While ctx.intro < 1 the town is
       still growing itself out of the ground; banking that time would let the
       6-minute warmup expire on a plat that has no buildings on it yet. With no
       ctx at all (the null-object case) there is no intro and time banks. */
    const settled = !ctx || ctx.intro == null || ctx.intro >= 1;
    if (lastNow && settled) {
      const gap = t - lastNow;
      if (sched.bank(gap)) {
        if (today() !== sched.ledger.day) sched.setDay(today(), daySeed);
        const def = sched.roll({ night: ctxNight, water: hasWater(), busy: !!live });
        if (def) { if (!start(def, t)) sched.ended(); }
      }
    }
    lastNow = t;

    // The forced event (`?event=comet`), armed once, WALL-CLOCK delayed so the
    // town has a plan and a ground sampler before the builder asks for them.
    if (forceId && t >= forceAt && !live) {
      const def = BY_ID.get(forceId);
      forceAt = t + 1500;                          // retry until it sticks for 6 s
      if (def && start(def, t)) { live.forced = true; sched.forced(def); }
    }
  }

  /* ── the debug arm: `?event=<id>&eventAt=<ms>` ─────────────────────────── */
  let forceId = '', forceAt = 0;
  {
    const v = (QS.get('event') || '').trim();
    if (v && BY_ID.has(v)) {
      forceId = v;
      const at = parseInt(QS.get('eventAt') || '', 10);
      forceAt = nowMs() + (isFinite(at) ? Math.max(0, at) : 2200);
    }
  }

  /* ── public surface ───────────────────────────────────────────────────── */
  return {
    group,
    update,
    /** The live happening, or null. `focus` is LIVE — do not retain past reset(). */
    active() {
      if (!live) return null;
      return {
        id: live.def.id, tier: live.def.tier, title: fill(live.def.title),
        t01: clamp((lastNow - live.t0) / live.dur, 0, 1), focus: live.focus
      };
    },
    /**
     * Ticker copy, in news.js's `country()` shape. Heavily weighted so an event
     * owns the countryside pool while it runs, and EMPTY otherwise — an idle
     * town's gazette is byte-for-byte what it was before this module existed.
     */
    news() {
      if (!live) return [];
      const d = live.def, out = [{ w: 14, text: fill(d.title) }];
      for (let i = 0; i < d.lines.length; i++) out.push({ w: 9, text: fill(d.lines[i]) });
      return out;
    },
    /** Start an event NOW, ignoring the roll but not the ledger. Debug and bench. */
    force(id) {
      const def = BY_ID.get(String(id));
      if (!def || live) return false;
      if (!start(def, nowMs())) return false;
      sched.forced(def);
      return true;
    },
    /** For the bench and the report: everything the scheduler currently believes. */
    stats() {
      const L = sched.ledger;
      return {
        live: live ? live.def.id : '', tier: live ? live.def.tier : '',
        activeMin: +(L.activeMs / 60000).toFixed(1),
        firedToday: L.firedToday, cap: DAY_CAP,
        floorMin: +(sched.floorLeft() / 60000).toFixed(1),
        recent: L.recent.slice(), day: L.day,
        draws: live ? countDraws(live.node) : 0
      };
    },
    /** A new calendar day, or a new day seed. Never called by a range change. */
    setSeed(seed) {
      daySeed = (seed | 0) || 1;
      sched.setDay(today(), daySeed);
    },
    setQuality(q) { quality = q === 'low' ? 'low' : 'high'; },
    /**
     * EPOCH RESET. The meshes go; the ledger stays. A range change is a new town,
     * not a new day, and the day's luck belongs to the day.
     */
    reset() {
      end();
      rnd = stream(((daySeed * 2654435761) ^ 0x51E5A17) >>> 0);
      lastNow = 0;                                 // the next gap is not active use
      sched.setDay(today(), daySeed);
    },
    /** SHUTDOWN. Nothing of this module is left in the scene or on the heap. */
    dispose() {
      end();
      if (group.parent) group.parent.remove(group);
      forceId = '';
    }
  };
}

/** Draw-call count for a live event's root — what the bench actually charges us. */
function countDraws(root) {
  let n = 0;
  root.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) n++; });
  return n;
}
