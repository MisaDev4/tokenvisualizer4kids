// Token Town — the Shift. This module answers one question: at what hours does
// THIS person actually work? It then hands the town a set of plain numbers that
// let it dress for that answer — a night town keeps more windows lit and its
// lamps burn later; a dawn town has mist on the fields, bakers up first and
// lamps going out at sunrise.
//
// ZERO QUERIES, ZERO SCENE ACCESS. Everything here is folded out of the feed's
// `init` message, which already carries the day's buckets and the local-hour
// histogram for today. Nothing is fetched, nothing is stored, nothing outside
// this file is touched: the module owns no THREE object, no DOM node, no timer
// and no listener. It publishes numbers; the conductor applies them.
//
// IT IS A NUDGE, NOT A COSTUME. Every dressing is `neutral + conf × target`, so
// a weak read is a whisper and an absent read is EXACTLY the town as it stands
// today — `unknown` is neutral to the bit (bias 0, multiplier 1, shift 0 h).
//
// NO JUDGEMENT, EVER. There is no "late again", no streak to protect, no hour
// that is better than another hour. Working at 03:00 gets you a lamplighter who
// took the night shift out of solidarity; working at 06:00 gets you the bakers.
// The classifier is a costume department, not a clock-in.
//
// WALL-CLOCK RULE. This module has no clock of its own and no dt path at all:
// `livelinessAt(hour)` and `lampK(hour, …)` are pure functions of the hour the
// conductor is already computing, so a 1 fps headless frame is identical to a
// 60 fps one.
//
// PUBLIC SURFACE
//   export const SHIFTS                       frozen Record<id, {id,label,blurb,dress}>
//   export const NEUTRAL_DRESS                frozen Dress — what `unknown` yields
//   export function classifyShift(msg, nowMs) → ShiftRead                    PURE
//   export function initShift(cfg) →
//     { id, label, blurb, conf, peakHour, peakFrom, peakTo, activeDays, read,
//       dress, ingest(msg), livelinessAt(h), liveliness(nowMs),
//       lampK(h, sunriseH, sunsetH), news(), reset(), dispose() }
//
// COST. Zero draw calls, zero allocations per frame. `ingest` is O(rows) with a
// tiny constant — MEASURED in node over a 30-day `currentMonth` init (720 hourly
// rows): 0.175 ms, once per epoch. `livelinessAt` + `lampK` together are 39 ns
// and allocate nothing, so calling both once per frame — or once per villager —
// is free. Steady-state footprint is four Float64Array(24) kernels plus two
// Float64Array(24) histograms: 1.5 KB, allocated at load and never regrown.
'use strict';

const HOUR_MS = 3600e3, DAY_MS = 864e5;
const INT_MS = 5 * 60e3;              // the feed's native bucket, and our `w` default
const HALF_LIFE_D = 14;               // habits drift; a fortnight ago counts half
const COARSE_MS = 90 * 60e3;          // a bin wider than this cannot resolve a shift
const RETAIN_MS = 12 * HOUR_MS;       // a retained strong read goes stale after this
const MIN_CONF = 0.15;                // below this the read is not worth dressing for
const MIN_HOURS = 2.5;                // fewer effective hours than this is a burst, not a shift
const SCATTER_LIFT = 1.35;            // top band below this ⇒ the day has no shape
const SPLIT_LIFT = 1.35;              // two opposite bands above this ⇒ two working days

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
// Circular distance on a 24 h dial.
const circ = (a, b) => { const d = Math.abs(a - b) % 24; return d > 12 ? 24 - d : d; };
const wrap24 = x => ((x % 24) + 24) % 24;
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ═══ the four bands ════════════════════════════════════════════
   Raised-cosine kernels on the hour dial, each centred on the middle of a way
   of working and wide enough to overlap its neighbours — which is the point:
   nobody's day starts on a boundary, so the bands must not have any. Scored as
   LIFT OVER UNIFORM (captured mass ÷ what a flat day would put under the same
   kernel), because a wide band would otherwise win on width alone. */
const BANDS = [['dawn', 6.5, 3.2], ['day', 13, 4.5], ['evening', 20, 3.2], ['night', 2, 3.6]];
const BAND_IDS = BANDS.map(b => b[0]);
const KERNEL = {}, KUNIF = {};
for (const [id, c, hw] of BANDS) {
  const k = new Float64Array(24);
  let s = 0;
  for (let h = 0; h < 24; h++) {
    const d = circ(h + .5, c);                          // h + .5 = the hour's midpoint
    const v = d >= hw ? 0 : .5 * (1 + Math.cos(Math.PI * d / hw));
    k[h] = v; s += v;
  }
  KERNEL[id] = k; KUNIF[id] = s / 24;
}
// Bands that touch. Two NON-adjacent peaks (dawn+evening, day+night) are not one
// shift with a long tail — they are two working days, and that is `scattered`.
const ADJACENT = { dawn: 'day night', day: 'dawn evening', evening: 'day night', night: 'evening dawn' };

/* ═══ the dressings ═════════════════════════════════════════════
   Ten plain numbers. NEUTRAL is the town exactly as it is drawn today, and the
   published `dress` is always `neutral + conf × (target − neutral)` — so the
   integrator never needs to know whether a read exists, and a confidence of 0
   is bit-identical to not wiring this module at all.

   @typedef {Object} Dress
   @property {number} windowLitBias   added to `night` (0..1) for WINDOW emissive
                                      only, before the ×2.2 in town.js. −.06…+.18
   @property {number} lanternMul      multiplier on how many of the EXISTING road
                                      lamp pool are revealed after dark. 1…1.30
   @property {number} lampsOnShiftH   hours added to sunset for lamp-up. −.5…+.25
   @property {number} lampsOffShiftH  hours added to sunrise for lamp-out. −.45…+1.35
   @property {number} morningShiftH   hours added to when the town wakes: NPC
                                      rise, market open, the morning line. −1.6…+2.4
   @property {number} nightShiftH     hours added to when the town turns in. −1.2…+2.5
   @property {number} mistK           0..1 ground mist over the fields at first light
   @property {number} bakersK         0..1 how early the first trades are abroad
   @property {number} nightLifeK      0..1 villagers still out after midnight
   @property {number} peakGlowK       0..1 extra warmth in windows during the
                                      user's OWN peak hours (× livelinessAt) */
const DRESS_KEYS = ['windowLitBias', 'lanternMul', 'lampsOnShiftH', 'lampsOffShiftH',
  'morningShiftH', 'nightShiftH', 'mistK', 'bakersK', 'nightLifeK', 'peakGlowK'];

export const NEUTRAL_DRESS = Object.freeze({
  windowLitBias: 0, lanternMul: 1, lampsOnShiftH: 0, lampsOffShiftH: 0,
  morningShiftH: 0, nightShiftH: 0, mistK: 0, bakersK: 0, nightLifeK: 0, peakGlowK: 0
});

// The copy. Weight 2 is the line that says what the shift IS; the rest is colour.
// Nothing here may name a total, a limit, or a thing the user ought to do.
const LINES = {
  dawn: [
    [2, 'Mist on the low fields and the lamps going out one by one. The town’s best hour, and it knows it.'],
    [1, 'The bakers were up first. The bakers are always up first.'],
    [1, 'Sunrise arrived to find the town already at work, and has stopped being surprised.'],
    [1, 'Dawn bell rung exactly on time by a bellringer who was, unusually, already awake.']
  ],
  day: [
    [2, 'The market opens at nine and the clocktower is insufferable about it.'],
    [1, 'Town hours confirmed as entirely sensible. The committee has nothing further to add.'],
    [1, 'Shutters up, awnings out, the whole business conducted in daylight like civilised people.'],
    [1, 'The sundial has been declared fit for purpose and given the afternoon off.']
  ],
  evening: [
    [2, 'Lamps lit early tonight. The evening shift knows exactly what it is doing.'],
    [1, 'The tavern moved its opening hour to suit the town. Very obliging of them.'],
    [1, 'Long shadows, warm windows, and a plaza in no hurry whatsoever.'],
    [1, 'Supper cleared away at speed. The good part of the day starts after it.']
  ],
  night: [
    [2, 'The lamplighter has taken the night shift as well, out of solidarity.'],
    [1, 'The bakery now opens at four. The motion passed unopposed.'],
    [1, 'Three in the morning is a perfectly respectable hour in this town.'],
    [1, 'New sign hung at the gate: OPEN LATE, AS EVER.'],
    [1, 'The clocktower’s small hand has been thanked for its service and relieved of duty.']
  ],
  scattered: [
    [2, 'The town has abandoned the timetable entirely and is much happier for it.'],
    [1, 'The clocktower was consulted about opening hours and declined to comment.'],
    [1, 'Every hour has now been declared the correct hour. Filed under: solved.'],
    [1, 'The bellringer rings when the mood takes him. Attendance is unaffected.']
  ]
};

/**
 * @typedef {Object} Shape
 * @property {string} id @property {string} label @property {string} blurb
 * @property {Dress} dress   the FULL-STRENGTH target; the published dress is
 *                           this lerped from NEUTRAL_DRESS by `conf`
 */
export const SHIFTS = Object.freeze({
  dawn: Object.freeze({
    id: 'dawn', label: 'Dawn shift', blurb: 'This town is up before the sun is.',
    dress: Object.freeze({
      windowLitBias: -.05, lanternMul: 1.00, lampsOnShiftH: .25, lampsOffShiftH: -.45,
      morningShiftH: -1.6, nightShiftH: -1.2, mistK: .85, bakersK: 1, nightLifeK: 0, peakGlowK: .50
    })
  }),
  day: Object.freeze({
    id: 'day', label: 'Daylight hours', blurb: 'This town keeps daylight hours.',
    dress: Object.freeze({
      windowLitBias: 0, lanternMul: 1.00, lampsOnShiftH: 0, lampsOffShiftH: 0,
      morningShiftH: 0, nightShiftH: 0, mistK: .15, bakersK: .35, nightLifeK: 0, peakGlowK: .35
    })
  }),
  evening: Object.freeze({
    id: 'evening', label: 'Evening shift', blurb: 'This town gets going after supper.',
    dress: Object.freeze({
      windowLitBias: .08, lanternMul: 1.15, lampsOnShiftH: -.35, lampsOffShiftH: .35,
      morningShiftH: .8, nightShiftH: 1.1, mistK: 0, bakersK: 0, nightLifeK: .55, peakGlowK: .60
    })
  }),
  night: Object.freeze({
    id: 'night', label: 'Night shift', blurb: 'This town keeps late hours, and keeps them well.',
    dress: Object.freeze({
      windowLitBias: .18, lanternMul: 1.30, lampsOnShiftH: -.50, lampsOffShiftH: 1.35,
      morningShiftH: 2.4, nightShiftH: 2.5, mistK: .25, bakersK: 0, nightLifeK: 1, peakGlowK: .75
    })
  }),
  scattered: Object.freeze({
    id: 'scattered', label: 'All hours', blurb: 'This town has no timetable and no regrets.',
    dress: Object.freeze({
      windowLitBias: .05, lanternMul: 1.10, lampsOnShiftH: -.20, lampsOffShiftH: .35,
      morningShiftH: .3, nightShiftH: .5, mistK: .10, bakersK: .20, nightLifeK: .35, peakGlowK: .30
    })
  }),
  // The null shape. Its dress IS the neutral dress, so `unknown` dresses nothing.
  unknown: Object.freeze({
    id: 'unknown', label: 'Any hour', blurb: '', dress: NEUTRAL_DRESS
  })
});

/* ═══ folding the feed into a 24-hour histogram ═════════════════ */

/** One bucket, spread across the LOCAL hours it actually covers, proportionally.
 *  A 5-minute bucket lands in one hour; a 6-hour bin from the `all` range lands
 *  in seven; a UTC-aligned hour bin in a :30 zone (Kolkata) lands in two, split
 *  exactly. `skipFrom` drops any slice at or after today's local midnight, which
 *  is how the finer `today.hours` block replaces a coarse bin without ever being
 *  counted twice. Returns the mass actually added. */
function addSpan(hist, from, to, tok, wt, skipFrom) {
  const span = to - from;
  if (!(span > 0) || !(tok > 0)) return 0;
  let t = from, added = 0, guard = 0;
  while (t < to && guard++ < 64) {
    const d = new Date(t);
    const hs = t - (d.getMinutes() * 60e3 + d.getSeconds() * 1e3 + d.getMilliseconds());
    const next = Math.min(to, hs + HOUR_MS);
    if (next <= t) break;                               // paranoia: never spin
    if (!(skipFrom > 0 && t >= skipFrom)) {
      const share = tok * wt * (next - t) / span;
      hist[d.getHours()] += share; added += share;
    }
    t = next;
  }
  return added;
}

// Circular 3-tap. The hour grid is arbitrary — somebody who starts at 08:50 puts
// most of a "nine o'clock" day into hour 8 — so a light smooth before scoring is
// what stops a half-hour of drift from moving the answer.
function smoothCirc(src, dst) {
  for (let h = 0; h < 24; h++) dst[h] = .25 * src[(h + 23) % 24] + .5 * src[h] + .25 * src[(h + 1) % 24];
  return dst;
}

/** The tightest circular run of hours holding `want` of the mass. */
function peakWindow(frac, want) {
  for (let len = 1; len <= 24; len++) {
    let best = -1, at = 0;
    for (let s = 0; s < 24; s++) {
      let m = 0;
      for (let i = 0; i < len; i++) m += frac[(s + i) % 24];
      if (m > best) { best = m; at = s; }
    }
    if (best >= want) return [at, (at + len) % 24];
  }
  return [0, 0];
}

/**
 * @typedef {Object} ShiftRead   the pure result of one classification
 * @property {string} id         'dawn'|'day'|'evening'|'night'|'scattered'|'unknown'
 * @property {number} conf       0..1 — how much of the dressing to apply
 * @property {Float64Array} frac 24 local hours, summing to 1 (all zero when unknown)
 * @property {Float64Array} shape 24 hours normalised so the busiest hour is 1
 * @property {number} peakHour   the busiest local hour
 * @property {number} peakFrom @property {number} peakTo   tightest 60 %-of-mass window
 * @property {number} activeDays  distinct local days that carried any tokens
 * @property {number} activeHours EFFECTIVE width of the working day, in hours —
 *                                the perplexity of the hour distribution, so it
 *                                is immune to bin alignment. Fractional; 6 for a
 *                                six-hour habit, 24 for a day with no shape.
 * @property {number} tok        total weighted mass folded
 * @property {number} coarse     0..1 share of that mass from bins wider than 90 min
 * @property {number} ev         0..1 evidence strength (the retention arbiter)
 * @property {Object} lifts      per-band lift over uniform
 */
const emptyRead = () => ({
  id: 'unknown', conf: 0, frac: new Float64Array(24), shape: new Float64Array(24),
  peakHour: -1, peakFrom: 0, peakTo: 0, activeDays: 0, activeHours: 0,
  tok: 0, coarse: 0, ev: 0, lifts: { dawn: 0, day: 0, evening: 0, night: 0 }
});

/**
 * Classify how this user works, from data the feed already sent. PURE — no
 * clock, no DOM, no state, no allocation beyond the result.
 * @param {{buckets?:Array<{b:number,w?:number,tok:number}>, today?:{hours?:number[]}, now?:number}} msg
 *        the feed's `init` (a bare `{buckets}` is fine; anything absent is simply
 *        not evidence)
 * @param {number} [nowMs]  defaults to msg.now, then Date.now()
 * @returns {ShiftRead}
 */
export function classifyShift(msg, nowMs) {
  const out = emptyRead();
  if (!msg) return out;
  const now = nowMs || msg.now || Date.now();
  const sodNow = startOfDay(now);
  const raw = new Float64Array(24);
  const days = new Set();
  let tok = 0, coarse = 0;

  // TODAY AT FULL RESOLUTION. The `today` block is already a local-hour
  // histogram, so when the range is wide (and its bins are 6 h) this is the one
  // day we can still read exactly. It is only preferred over the buckets when it
  // would actually be an upgrade — otherwise the buckets say the same thing at
  // the same resolution and we let them.
  const th = msg.today && Array.isArray(msg.today.hours) && msg.today.hours.length === 24
    ? msg.today.hours : null;
  const rows = Array.isArray(msg.buckets) ? msg.buckets : null;
  let widest = 0;
  if (rows) for (const r of rows) if (r && r.b >= sodNow) widest = Math.max(widest, r.w || INT_MS);
  const useToday = !!th && (widest > HOUR_MS || !rows || !rows.length);
  const skipFrom = useToday ? sodNow : 0;

  if (rows) {
    for (const r of rows) {
      if (!r || !(r.tok > 0)) continue;
      const b = +r.b, w = r.w > 0 ? r.w : INT_MS;
      if (!(b > 0)) continue;
      const sod = startOfDay(b);
      const age = Math.max(0, Math.round((sodNow - sod) / DAY_MS));
      const wt = Math.pow(.5, age / HALF_LIFE_D);        // habits drift; last week weighs most
      const added = addSpan(raw, b, b + w, r.tok, wt, skipFrom);
      if (added > 0) { tok += added; days.add(sod); if (w > COARSE_MS) coarse += added; }
    }
  }
  if (useToday) {
    let t = 0;
    for (let h = 0; h < 24; h++) { const v = +th[h] || 0; if (v > 0) { raw[h] += v; t += v; } }
    if (t > 0) { tok += t; days.add(sodNow); }
  }
  if (!(tok > 0)) return out;

  const frac = out.frac;
  for (let h = 0; h < 24; h++) frac[h] = raw[h] / tok;
  const sm = smoothCirc(frac, new Float64Array(24));
  out.tok = tok;
  out.coarse = clamp(coarse / tok, 0, 1);
  out.activeDays = days.size;

  // HOW MANY HOURS DOES THIS PERSON ACTUALLY WORK? Counting bins over a
  // threshold is not it: smoothing bleeds a three-hour sitting across five bins,
  // and the feed's UTC-aligned hour bins straddle two LOCAL hours in a :30 zone
  // (Kolkata), so the same three hours counted as four. Both inflations went
  // straight into the evidence budget and read one afternoon as a confident
  // nine-to-five. The perplexity of the distribution (1 / Σ frac²) is the same
  // number for three whole hours and for three hours split across four bins.
  let sq = 0, peakV = 0, peakHour = 0;
  for (let h = 0; h < 24; h++) {
    sq += frac[h] * frac[h];
    if (sm[h] > peakV) { peakV = sm[h]; peakHour = h; }
  }
  const activeHours = sq > 0 ? Math.min(24, 1 / sq) : 0;
  out.activeHours = activeHours;
  out.peakHour = peakHour;
  for (let h = 0; h < 24; h++) out.shape[h] = peakV > 0 ? clamp(sm[h] / peakV, 0, 1) : 0;
  const [pf, pt] = peakWindow(frac, .6);
  out.peakFrom = pf; out.peakTo = pt;

  // THE EVIDENCE, before any opinion about shape. One day is a day, not a habit;
  // three hours is a sitting, not a shift; a 6-hour bin cannot tell dawn from
  // lunchtime. Each of those caps the confidence independently.
  const daysK = .25 + .75 * clamp((out.activeDays - 1) / 5, 0, 1);
  const hoursK = clamp((activeHours - 2.5) / 2.5, 0, 1);
  const fineK = 1 - .45 * out.coarse;
  out.ev = daysK * hoursK * fineK;
  if (activeHours < MIN_HOURS) return out;               // a burst has no shape to read

  let top = null, topV = 0, second = null, secondV = 0;
  for (const id of BAND_IDS) {
    const k = KERNEL[id];
    let m = 0;
    for (let h = 0; h < 24; h++) m += sm[h] * k[h];
    const lift = m / KUNIF[id];
    out.lifts[id] = lift;
    if (lift > topV) { second = top; secondV = topV; top = id; topV = lift; }
    else if (lift > secondV) { second = id; secondV = lift; }
  }

  // Two strong peaks on OPPOSITE sides of the dial are two working days, not one
  // long one — and a dial with no peak at all is the same answer from the other
  // direction. Both are `scattered`, whose confidence is how BALANCED the day is.
  const split = second && secondV >= SPLIT_LIFT && topV >= SPLIT_LIFT
    && ADJACENT[top].indexOf(second) < 0;
  if (topV < SCATTER_LIFT || split) {
    out.id = 'scattered';
    out.conf = clamp(out.ev * clamp(1 - (topV - secondV) / topV, .2, 1), 0, 1);
  } else {
    // A shift that only just beats its neighbour gets dressed only just as much.
    const sep = clamp(.45 + .55 * (topV - secondV) / topV, 0, 1);
    out.id = top;
    out.conf = clamp(out.ev * clamp((topV - 1.2) / .9, 0, 1) * sep, 0, 1);
  }
  if (out.conf < MIN_CONF) { out.id = 'unknown'; out.conf = 0; }
  return out;
}

/**
 * @typedef {Object} ShiftCfg
 * @property {number} [minConf]   suppress ticker copy below this confidence (default .3)
 * @property {boolean} [enabled]  false ⇒ a permanent, exact no-op
 */
/**
 * Build the shift reader. It holds no resources of any kind, so it is safe to
 * construct before the feed exists and safe to leave running forever.
 * @param {ShiftCfg} [cfg]
 */
export function initShift(cfg) {
  const o = cfg || {};
  const enabled = o.enabled !== false;
  const newsMin = typeof o.minConf === 'number' ? o.minConf : .3;

  // ONE dress object for the life of the app, mutated in place and shared BY
  // REFERENCE — exactly like weather's grade. The conductor may latch it once.
  const dress = Object.assign({}, NEUTRAL_DRESS);
  let read = emptyRead(), readAt = 0, newsCache = null;

  const api = {
    id: 'unknown', label: SHIFTS.unknown.label, blurb: '', conf: 0,
    peakHour: -1, peakFrom: 0, peakTo: 0, activeDays: 0,
    read, dress,
    ingest, livelinessAt, liveliness, lampK, news, reset, dispose
  };

  function publish(r) {
    read = api.read = r;
    const shape = SHIFTS[r.id] || SHIFTS.unknown;
    const t = shape.dress, c = clamp(r.conf, 0, 1);
    // neutral + conf × (target − neutral): conf 0 restores the town exactly.
    for (const k of DRESS_KEYS) dress[k] = NEUTRAL_DRESS[k] + (t[k] - NEUTRAL_DRESS[k]) * c;
    api.id = shape.id; api.label = shape.label; api.blurb = c > 0 ? shape.blurb : '';
    api.conf = c;
    api.peakHour = r.peakHour; api.peakFrom = r.peakFrom; api.peakTo = r.peakTo;
    api.activeDays = r.activeDays;
    newsCache = null;
  }
  publish(read);

  /**
   * Fold one feed `init` (or anything shaped like one) into the read.
   * THE STRONGEST EVIDENCE WINS AND IS KEPT. Switching the tracker to "last
   * hour" must not throw away what a month of buckets already established — a
   * shift describes the person, not the window they happen to be looking at —
   * so a weaker init leaves the standing read alone until it goes stale.
   * @param {object} msg  the feed's init; null/empty is a harmless no-op
   * @returns {boolean}   true when the published read changed
   */
  function ingest(msg) {
    if (!enabled || !msg) return false;
    const now = msg.now || Date.now();
    const r = classifyShift(msg, now);
    const fresh = !readAt || now - readAt > RETAIN_MS || now < readAt;
    if (!fresh && r.ev < read.ev) return false;          // keep the better witness
    readAt = now;
    const changed = r.id !== read.id || Math.abs(r.conf - read.conf) > .02;
    publish(r);
    return changed;
  }

  /** 0..1 — how much of this user's work lands at local hour `h` (fractional,
   *  wrapping), normalised so their busiest hour is 1. 0 when there is no read,
   *  which makes every term the conductor multiplies by it vanish. */
  function livelinessAt(h) {
    if (!(read.tok > 0)) return 0;
    const x = wrap24((typeof h === 'number' && isFinite(h) ? h : 0) - .5);
    const i = Math.floor(x), f = x - i;
    const a = read.shape[i % 24], b = read.shape[(i + 1) % 24];
    return a + (b - a) * f;
  }
  /** livelinessAt for a wall-clock instant. Use livelinessAt(ctx.hour) when the
   *  hour is pinned by `?hour=N`, or this when it is not. */
  function liveliness(nowMs) {
    const d = new Date(nowMs || Date.now());
    return livelinessAt(d.getHours() + d.getMinutes() / 60);
  }

  /** 0..1 street-lamp curve with this shift's lamp hours applied: lamps up at
   *  sunset + lampsOnShiftH, out at sunrise + lampsOffShiftH, with a 42-minute
   *  ramp at each end. With no read the shifts are 0 and this is exactly the
   *  plain sunset→sunrise curve. `sunriseH`/`sunsetH` are local decimal hours —
   *  town.js already has them as sunSr/sunSs. */
  function lampK(h, sunriseH, sunsetH) {
    const sr = typeof sunriseH === 'number' ? sunriseH : 6;
    const ss = typeof sunsetH === 'number' ? sunsetH : 18;
    const on = ss + dress.lampsOnShiftH, off = sr + dress.lampsOffShiftH;
    const len = wrap24(off - on);
    if (!(len > 0)) return 0;                             // no night to light
    if (len >= 23.99) return 1;                           // polar winter: always lit
    const t = wrap24((typeof h === 'number' ? h : 0) - on);
    if (t > len) return 0;
    const RAMP = .7;
    return Math.min(smooth01(t / RAMP), smooth01((len - t) / RAMP));
  }

  /** Ticker copy for news.js's weight-1 `country` channel. Empty until the read
   *  is worth announcing — a 20 %-confidence guess must not be stated as a fact.
   *  Cached: the pool only changes when the read does. */
  function news() {
    if (!enabled || api.conf < newsMin) return [];
    if (newsCache) return newsCache;
    const pool = LINES[api.id];
    if (!pool) return (newsCache = []);
    newsCache = pool.map(p => ({ w: p[0], text: p[1] }));
    return newsCache;
  }

  /** Epoch switch. There is nothing here to tear down — no geometry, no DOM, no
   *  timer — and the read is a fact about the PERSON, not about this epoch's
   *  town, so it deliberately survives (the chronicle's rule). The next init
   *  re-evaluates it anyway. Only the derived caches are dropped. */
  function reset() { newsCache = null; }

  /** Shutdown. Everything returns to exactly neutral so anything still holding
   *  the shared `dress` reference reads the undressed town. */
  function dispose() {
    newsCache = null; readAt = 0;
    publish(emptyRead());
  }

  return api;
}
