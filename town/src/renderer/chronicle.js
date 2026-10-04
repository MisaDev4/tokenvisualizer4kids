/* ═══════════════════════════════════════════════════════════════════════════
   Token Town v4 — chronicle.js · THE MEMORY  (task F6)
   ---------------------------------------------------------------------------
   The renderer's model of past days, DERIVED. Nothing load-bearing is stored:
   `usage.db` holds every token event, and the feed's seed algebra
   (`identityOf('today', ms)` = `today:${dayIndex(ms)}`, seed = FNV-1a) is
   invertible — so a calendar date alone reconstructs that day's plan seed,
   street plan, archetype, name, palette and size. Delete the keepsake file and
   the only things that change are the `kept` count and three prefs.

   This module imports NOTHING — no THREE, no DOM. Pure arithmetic plus one
   Canvas2D painter that takes a context the caller owns, exactly like
   `layout.js`'s `paintGround`. It is therefore driven and tested under plain
   Node, and it is the reason memorial.js and almanac.js need not import each
   other: town.js hands `paintSkyline` down to both.

   TONE (binding, v4-history.md §1). Quiet days are green meadows, never gaps or
   damage. Records are engraved facts; a progress bar exists only inside the
   last 20 % of one (`pressure()`). Spells may be gained, never lost — nothing
   here reports an ending. Comparison fires upward only: `overtaking()` has no
   symmetric event and none may ever be added.

   ── PUBLIC SURFACE ─────────────────────────────────────────────────────────
   CHRONICLE_V
   dayIndexOf(ms) · dateOfDayIndex(idx) · msOfDayIndex(idx) · ordinalOf(idx)
   shiftDayIndex(idx, delta) · daySeedOfIndex(idx) · planSeedOfIndex(idx)
   fmtTok(n)                              // town.js's formatter, shared to stop drift
   paintSkyline(g, spec, o) → boolean     // the shared painter (§3.4)
   synthChronicle(nowMs, opts) → {days, firstMs, builtMs}      // ?chronicle=demo
   initChronicle(opts) → Chronicle
     opts: { identify(idx)→{name,kind,kindLabel?}, sizeOf(tok)→n, ladder?,
             store?:{load,save}, now?:()=>ms, readOnly?:boolean|()=>boolean }

   Chronicle:
     get ready · get rev · get todayIdx · get count · get firstMs
     get days · get today · get yesterday · get todayDetail · get spell
     get records · get prefs
     ingest(msg) · setLive(tok) · dayAt(idx) · daysBack(n)
     rankOf(tok) · pressure() · recordsBrokenBy(tok) · overtaking() · onThisDay()
     setPref(k,v) · note(idx, patch) · summaryFor(idx) · view() · toJSON()
     paintSkyline(g, spec, o) · flush() · reset() · dispose()

   ── COST (measured, Node, this machine) ────────────────────────────────────
   Zero draw calls, zero GPU resources, zero DOM, one debounced timer. Nothing
   here runs per frame. `ingest` of 400 days: 2.1 ms (labels and names are lazy
   per day). A FULL 500 ms tick — setLive + records + spell + yesterday +
   daysBack(14) + pressure + recordsBrokenBy + view — is 0.013 ms. `paintSkyline`
   cheap mode 0.0037 ms at 1024×128 and 0.010 ms for a whole 14-day header strip;
   plan mode ~7.6 ms at 1200 plots (plus a one-off ~110 ms if the plan has not
   been grown to n yet) and is called ONCE PER EPOCH — schedule it off the
   critical path, after the founding cascade, exactly as v4-history.md §5.2 says.
   Both modes cap the number of buildings they DRAW at what the frame can hold
   (~300 shapes at 1024 px), so the paint half stops growing with the town.

   ── WHAT THE INTEGRATION WAVE MUST WIRE ────────────────────────────────────
   1. `layout.js` must export `archetypeOf(seed)` (F8) and `news.js` already
      exports `townNameFor(seed)`; town.js composes them into `opts.identify`.
   2. town.js: `ctx.chronicle = initChronicle({...})` after `initNews`, pass
      `ladder: LADDER` and `sizeOf: townSize`, `store: window.townAPI?.chronicle`.
   3. `chronicle.ingest(msg)` in `applyInit` after `spliceBestRung(...)`; then
      `memorial.setView(chronicle.view()); almanac.setView(chronicle.view())`.
   4. 500 ms tick: `if (ctx.rangeIsDay) chronicle.setLive(T)`, drain
      `recordsBrokenBy(...)` and `overtaking()` (call the latter ONLY when
      `ctx.rangeIsDay && SEED_OVERRIDE === null`).
   5. `hardReset`: `chronicle.reset()` — it clears caches only. The chronicle
      outlives epochs by definition and must NOT be rebuilt.
   6. `dispose()` on shutdown flushes the pending keepsake patch.
   The module is a harmless no-op until an `init` carrying a `chronicle` block
   arrives: `ready` stays false, every getter returns null/empty, every painter
   call returns false. A v3 feed therefore renders exactly v3.
   ═══════════════════════════════════════════════════════════════════════════ */

export const CHRONICLE_V = 1;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const DAY_MS = 864e5;
const SAVE_MS = 700;                      // renderer-side coalesce; main debounces 4 s again
const NOTE_KEYS = ['seen', 'kept', 'overtookMs'];
const PREF_KEYS = ['showStreaks', 'ghost', 'strip'];
const EMPTY = Object.freeze([]);

/* ═══ 1 · the calendar, both ways ═══════════════════════════════════════════
   dayIndexOf is datafeed.js's `dayIndex`, verbatim — y*400 + day-of-year, so it
   ticks at LOCAL midnight and is DST-exact. Day-of-year < 400 makes it
   invertible, which is the whole trick the derived chronicle rests on. */
export const dayIndexOf = ms => {
  const d = new Date(ms);
  return d.getFullYear() * 400 +
    Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / DAY_MS);
};
/** Inverse. Local constructor, so it lands on that day even where midnight is
 *  skipped by a DST jump (Santiago, Havana): the round-trip still holds. */
export function dateOfDayIndex(idx) {
  const y = Math.floor(idx / 400), doy = idx - y * 400;
  const d = new Date(2000, 0, 1);
  d.setFullYear(y, 0, 1 + doy);
  d.setHours(0, 0, 0, 0);
  return d;
}
export const msOfDayIndex = idx => dateOfDayIndex(idx).getTime();
/** Days since 1970 for a day index — a true consecutive integer ACROSS year
 *  ends, where the index itself jumps 365→400. Every adjacency test uses it. */
export const ordinalOf = idx => {
  const y = Math.floor(idx / 400);
  return Math.round(Date.UTC(y, 0, 1 + (idx - y * 400)) / DAY_MS);
};
export function shiftDayIndex(idx, delta) {
  const d = dateOfDayIndex(idx);
  d.setDate(d.getDate() + (delta | 0));
  return dayIndexOf(d.getTime());
}
/** town.js's daySeedOf, by date: palette, wash, biome, wardrobe. yyyymmdd. */
export const daySeedOfIndex = idx => {
  const d = dateOfDayIndex(idx);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
const fnv1a = s => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
/** The plan seed of a past day: FNV-1a of the feed's `today` identity. A day
 *  the user actually watched on a `last7` window had a different seed; the
 *  chronicle's canonical town for a date is deliberately its `today` town. */
export const planSeedOfIndex = idx => fnv1a('today:' + idx);
/** yyyymmdd (protocol v4 `today.date`) → day index. */
const idxOfDateNum = n => {
  n = n | 0; if (n < 10000101) return 0;
  const d = new Date(2000, 0, 1);
  d.setFullYear((n / 10000) | 0, ((n / 100) | 0) % 100 - 1, n % 100);
  d.setHours(0, 0, 0, 0);
  return dayIndexOf(d.getTime());
};

/* ═══ 2 · shared formatting ═════════════════════════════════════════════════
   Identical to town.js's `fmtTok` (and news.js's rungs) on purpose: three
   surfaces in this layer print the same number and must not disagree. */
const grouped = n => String(Math.round(Math.max(n, 0))).replace(/\B(?=(\d{3})+$)/g, ' ');
export const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : grouped(n);

// Four Intl formatters built once and reused: 400 days × 4 fresh formatters is
// milliseconds of nothing, and labels are lazy anyway.
const FMT = { done: false };
function initFormats() {
  if (FMT.done) return;
  FMT.done = true;
  const mk = o => { try { return new Intl.DateTimeFormat(undefined, o); } catch { return null; } };
  FMT.wd = mk({ weekday: 'short' }); FMT.wdL = mk({ weekday: 'long' });
  FMT.mo = mk({ month: 'short' }); FMT.moL = mk({ month: 'long' });
}
const part = (key, d, fallback) => { const f = FMT[key]; try { return f ? f.format(d) : fallback; } catch { return fallback; } };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Tue 4 Aug" · "4 August" · "Tuesday 4 August 2026". Composed by hand rather
 *  than by one locale pattern so the order is stable everywhere (en-US would
 *  otherwise render "Tue, Aug 4" into a card laid out for the other order). */
function labelsFor(idx) {
  initFormats();
  const d = dateOfDayIndex(idx), day = d.getDate();
  const wd = part('wd', d, WD[d.getDay()]), wdL = part('wdL', d, WD[d.getDay()]);
  const mo = part('mo', d, MO[d.getMonth()]), moL = part('moL', d, MO[d.getMonth()]);
  return { label: `${wd} ${day} ${mo}`, dateLabel: `${day} ${moL}`, longLabel: `${wdL} ${day} ${moL} ${d.getFullYear()}` };
}

const lazy = (o, k, get) => Object.defineProperty(o, k, {
  configurable: true, enumerable: true,
  get() { const v = get(); Object.defineProperty(o, k, { value: v, enumerable: true, writable: true }); return v; }
});

/* ═══ 3 · seeded noise for the painter ══════════════════════════════════════ */
const rngOf = seed => {
  let a = (seed >>> 0) || 1;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
};
// town.js's rarity roll, mirrored so a reconstructed elevation keeps the same
// odd tall house in the same place. Drift here is cosmetic, never structural.
const seededR = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const rarityOf = (i, L) => { const r = seededR(i * 3.13 + 7.7), hi = .012 + .004 * L; return r > 1 - hi * .34 ? 3 : r > 1 - hi ? 2 : r > .80 ? 1 : r < .10 ? -1 : 0; };

/* ── THE VILLAGE THE PORTRAIT IS OF ─────────────────────────────────────────
   Every number below is the town's own, so the picture and the place cannot
   drift apart again:
     TIER_H  buildHouse's apex height per tier — the RIDGE, not the eave. Index
             === tier, same eight rungs TIER_NAMES names.
     TIER_W  how wide that dwelling stands. A cottage is taller than it is wide
             and a merchant house is not; the old painter drew every house on a
             6.4-unit plot, which is what made a row of them read as blocks.
     MARKS   buildings.js's LANDMARK_DEFS, in town.js's LM_ORDER (= the order
             the LADDER unlocks them), carrying the REAL hTop. The tallest thing
             in the village is the chapel tower at 12.6 units and the charter's
             ceiling is ~14, so nothing here has to argue with it. There is no
             altar, no dome and no spire on the centre: the plaza's centrepiece
             is a fountain under 7 units and it is far too small to be a
             silhouette.
   `spec.marks` is how many of MARKS are standing that day. */
const TIER_H = [1.5, 1.6, 3.0, 3.5, 4.3, 5.4, 5.9, 7.1];
const TIER_W = [2.2, 2.4, 2.8, 3.0, 3.4, 3.8, 4.2, 4.6];
const COT_W = 3.4;                        // the reference cottage, for the fits below

const K_COT = 0, K_LONG = 1, K_TOWER = 2, K_CHAPEL = 3,
  K_MILL = 4, K_TREE = 5, K_CROSS = 6, K_WELL = 7;

const MARKS = [
  { site: 'well', w: 2.6, h: 2.9, k: K_WELL },
  { site: 'smithy', w: 5.0, h: 5.6, k: K_COT },
  { site: 'mill', w: 5.3, h: 10.4, k: K_MILL },
  { site: 'market_cross', w: 2.2, h: 4.9, k: K_CROSS },
  { site: 'tithe_barn', w: 9.6, h: 8.4, k: K_LONG },
  { site: 'market_hall', w: 8.4, h: 8.4, k: K_LONG },
  { site: 'chapel', w: 8.6, h: 12.6, k: K_CHAPEL },
  { site: 'bell_tower', w: 3.4, h: 11.0, k: K_TOWER },
  { site: 'village_green', w: 9.0, h: 4.8, k: K_TREE },
  { site: 'inn', w: 8.6, h: 8.3, k: K_LONG }
];
const MARK_N = MARKS.length;

/** Pixels per world unit. TWO rules, and between them they are the whole reason
 *  this now reads as a village rather than a city:
 *    · the tallest thing standing reaches ~76 % of the sky the canvas gives it;
 *    · a cottage is never wider than about a quarter of the frame.
 *  There is NO vertical exaggeration left. Every building is drawn at its true
 *  proportions and only the SPACING between them is compressed — which is what
 *  a long lens does to a village street, and why the roofs overlap instead of
 *  standing apart like towers. A hamlet therefore reads as a few big roofs seen
 *  close, a market town as a crowd of small ones seen from further back. */
const scaleFor = (groundY, W, tallest) =>
  Math.max(.02, Math.min(groundY * .76 / Math.max(tallest, 1), W * .26 / COT_W));

/* ═══ 4 · paintSkyline — one painter, three consumers ══════════════════════
   The horizon ghost, the header strip and the Almanac card all draw a day's
   village through this. Two fidelities: cheap (a seeded street, 0.004 ms — the
   14 header thumbnails and every card) and plan (real `plotAt()` positions in
   orthographic elevation — the ghost, at most once per epoch).

   IT IS A PORTRAIT OF A VILLAGE, and everything it can draw is something
   buildings.js actually builds: pitched roofs with chimneys, barns, a mill with
   its sails, a bell tower, a parish chapel with a west tower and a nave, trees
   on the green, the market cross, the wellhead. There is no altar, no orb, no
   dome and no spire, and there is no vertical exaggeration — those five things
   between them were what made this the picture of a modern city.

   @param {CanvasRenderingContext2D} g  caller owns the canvas and its size
   @param {Object} spec  {seed, n, tier(0..10), marks(0..10), tok?, quiet?, plan?}
                         a Day from this module is already a valid spec. `tier`
                         is the fountain's rung and draws NOTHING — a village
                         centrepiece under 7 units has no silhouette; `marks` is
                         how many of MARKS are standing and is what makes a big
                         day look like a bigger place.
   @param {Object} [o]   {ink, lit?, baseline=.92, jitter=1, bearing=0, w?, h?}
                         `ink` is the silhouette fill, already haze-mixed by the
                         caller; when `lit` is set ONLY the night layer is drawn
                         (transparent but for warm window dots).
   @returns {boolean} true when a town was drawn (false = meadow / no context) */
const SK = { x: [], w: [], h: [], k: [], s: [], n: 0 };   // hoisted: no per-call allocation
const push = (x, w, h, kind, seed) => { const i = SK.n++; SK.x[i] = x; SK.w[i] = w; SK.h[i] = h; SK.k[i] = kind; SK.s[i] = seed; };

export function paintSkyline(g, spec, o) {
  if (!g || !spec || typeof g.beginPath !== 'function') return false;
  o = o || {};
  const cv = g.canvas || null;
  const W = Math.max(4, o.w || (cv && cv.width) || 0), H = Math.max(4, o.h || (cv && cv.height) || 0);
  if (!(W > 4 && H > 4)) return false;
  const baseline = clamp(o.baseline === undefined ? .92 : o.baseline, .2, 1);
  const groundY = Math.round(H * baseline);
  const ink = o.ink || '#6A6E62', lit = o.lit || null;
  const n = clamp(spec.n | 0, 0, 4000), tier = clamp(spec.tier | 0, 0, 10), marks = clamp(spec.marks | 0, 0, MARK_N);
  const quiet = !!spec.quiet || (n <= 0 && tier <= 0 && !(spec.tok > 0));

  // R1: a day with no tokens is a meadow, never a gap and never a ruin. The
  // ground line is the whole drawing, and at night a meadow simply sleeps.
  if (quiet) {
    if (lit) return false;
    g.fillStyle = ink; g.beginPath(); g.rect(0, groundY, W, H - groundY);
    if (H >= 24) {                                        // three tufts and a sapling
      const r = rngOf((spec.seed >>> 0) ^ 0x9e2f1);
      for (let i = 0; i < 3; i++) {
        const tx = W * (.18 + .3 * i + .12 * r()), th = Math.max(2, H * .035 * (.7 + .6 * r()));
        g.rect(tx, groundY - th, Math.max(1, W * .006), th);
      }
      const bx = W * (.62 + .2 * r()), bh = Math.max(3, H * .06);
      g.rect(bx, groundY - bh, Math.max(1, W * .006), bh);
      g.moveTo(bx - bh * .32, groundY - bh); g.lineTo(bx + bh * .38, groundY - bh); g.lineTo(bx + bh * .03, groundY - bh * 1.7); g.closePath();
    }
    g.fill();
    return false;
  }

  SK.n = 0;
  if (spec.plan && spec.plan.plotAt) planShapes(spec, W, groundY, o, n, tier, marks);
  else cheapShapes(spec, W, groundY, o, n, tier, marks);
  if (!SK.n) return false;

  // Never clip. `scaleFor` already guarantees this — the tallest roof is 76 % of
  // the sky and a chimney adds at most a tenth of its own house — so on any spec
  // this module builds the guard is dead code. It stays for a hand-made one.
  let tallest = 0;
  for (let i = 0; i < SK.n; i++) if (SK.h[i] > tallest) tallest = SK.h[i];
  const cap = groundY * .94;
  if (tallest > cap) { const k = cap / tallest; for (let i = 0; i < SK.n; i++) SK.h[i] *= k; }

  if (lit) paintLit(g, W, H, groundY, lit); else paintInk(g, W, H, groundY, ink);
  return true;
}

/** Prosperity, town.js's own: how grand the dwellings are allowed to get. With
 *  no token count the growth law is inverted from the building count, so a
 *  reconstructed day still matches what the user actually saw. */
const prosperityOf = (tok, n) => Math.max(0, 1.15 * Math.log10(
  Math.max(tok > 0 ? tok : 1e6 * Math.pow(Math.max(n, 1) / 32, 8 / 3), 1) / 2e5));

function cheapShapes(spec, W, groundY, o, n, tier, marks) {
  const rnd = rngOf((spec.seed >>> 0) ^ 0x5b17e5);
  const jitter = clamp(o.jitter === undefined ? 1 : o.jitter, 0, 1);
  const L = prosperityOf(spec.tok, n);
  const mk = Math.min(marks, MARK_N);

  // 1 · WHAT IS STANDING decides the scale, because the tallest roof in the
  //     frame is what the fit is measured against.
  let tallest = TIER_H[clamp(Math.round(L * .70 + 2.0), 0, 7)];
  for (let m = 0; m < mk; m++) if (MARKS[m].h > tallest) tallest = MARKS[m].h;
  const s = scaleFor(groundY, W, tallest);

  // 2 · HOW MANY ROOFS the frame can hold before they stop being roofs. Beyond
  //     that a bigger day shows as a denser huddle, not as a wider one — the
  //     charter's first rule, in a hundred pixels.
  //     Roofs stand at 62 % of a cottage width, so they overlap by about a
  //     third: a village street through a long lens. The 3.2 px floor is what
  //     keeps a 26 px header thumbnail a row of gables instead of one mound —
  //     below roughly three pixels of pitch, roofs merge into a blob.
  const cot = Math.max(1.6, COT_W * s);
  const slot = Math.max(cot * .62, 3.2);
  const room = Math.max(4, Math.floor(W * .96 / slot));
  const count = Math.min(clamp(Math.round(Math.sqrt(Math.max(n, 1)) * 3.0), 4, 120), room);
  // A hamlet is a huddle in the middle of the horizon with the meadow either
  // side of it; only a full day's town reaches the ends of the frame.
  const spanPx = Math.min(W * .96, count * slot);
  const x0 = (W - spanPx) / 2;

  for (let i = 0; i < count; i++) {
    const r = rnd(), r2 = rnd(), r3 = rnd();
    // centrality stands in for depth-from-plaza: the grand houses are in the
    // middle of a village and the smallholdings are on the way out of it.
    const c = count > 1 ? 1 - Math.abs(i - (count - 1) / 2) / ((count - 1) / 2) : 1;
    const t = clamp(Math.round(L * .70 + 2.0 * c * c - .8 * (1 - c)
      + rarityOf(i, L) + (r - .5) * 1.2 * jitter), 0, 7);
    push(x0 + i * slot + (r3 - .5) * slot * .5 * jitter,
      Math.max(1.6, TIER_W[t] * s * (.92 + .16 * r2)), TIER_H[t] * s,
      t >= 6 && r2 > .6 ? K_LONG : K_COT, (i * 2654435761) ^ spec.seed);
  }
  // The landmarks go on an EVEN ladder across the village with a seeded rotation,
  // not at ten independent random x's: independent draws clump, and a mill
  // standing inside the chapel is the one arrangement a village never has.
  const rot = rnd();
  for (let m = 0; m < mk; m++) {
    const d = MARKS[m], bw = Math.max(1.6, d.w * s);
    const f = (((m + .5 + (rnd() - .5) * .5) / mk) + rot) % 1;
    push(x0 + f * spanPx - bw * .5, bw, d.h * s, d.k, (m * 40503) ^ spec.seed);
  }
}

function planShapes(spec, W, groundY, o, n, tier, marks) {
  const plan = spec.plan;
  // A fresh plan carries only its first tranche of plots; growing it is how
  // town.js gets its own frontier and is append-only, so a reconstructed day
  // that outgrew the tranche still shows all of its buildings.
  if (plan.ensureCapacity && (plan.capacity | 0) < n) { try { plan.ensureCapacity(n); } catch { /* keep what we have */ } }
  const cap = Math.min(n, plan.capacity | 0);
  const bearing = o.bearing || 0, ca = Math.cos(bearing), sa = Math.sin(bearing);
  const L = prosperityOf(spec.tok, n);
  const fk = plan.frontierOf ? plan.frontierOf(cap).k : 0;
  const ents = [];
  let uMin = 1e9, uMax = -1e9, dMin = 1e9, dMax = -1e9, tallest = 1;
  for (let i = 0; i < cap; i++) {
    const p = plan.plotAt(i); if (!p) continue;
    const u = p.x * ca - p.z * sa, d = p.x * sa + p.z * ca;
    // town.js's tierOfPlot, mirrored: depth normalised against the CURRENT
    // frontier, so a past day's fringe reads as fringe and its centre as centre.
    const dp = clamp((plan.depthOf ? plan.depthOf(i) : 0) / (fk + 20), 0, 1.2);
    const t = clamp(Math.round(L + (2.4 * (1 - dp) * (1 - dp) - .9 * dp) + rarityOf(i, L)), 0, 7);
    ents.push({ u, d, w: TIER_W[t], h: TIER_H[t], k: t >= 6 ? K_LONG : K_COT, s: i, lm: false });
    if (TIER_H[t] > tallest) tallest = TIER_H[t];
    if (u < uMin) uMin = u; if (u > uMax) uMax = u; if (d < dMin) dMin = d; if (d > dMax) dMax = d;
  }
  const sites = plan.sites || {};
  for (let m = 0, mk = Math.min(marks, MARK_N); m < mk; m++) {
    const def = MARKS[m], st = sites[def.site]; if (!st) continue;
    const u = st.x * ca - st.z * sa, d = st.x * sa + st.z * ca;
    ents.push({ u, d, w: def.w, h: def.h, k: def.k, s: 9001 + m, lm: true });
    if (def.h > tallest) tallest = def.h;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u; if (d < dMin) dMin = d; if (d > dMax) dMax = d;
  }
  if (!ents.length) { cheapShapes(spec, W, groundY, o, n, tier, marks); return; }

  // Buildings keep their true proportions; only the ground between them is
  // compressed, so a 400-unit town fits the frame by huddling rather than by
  // being stretched into towers.
  const s = scaleFor(groundY, W, tallest);
  const xk = (W * .92) / Math.max(uMax - uMin, 1);
  const ox = W * .04 - uMin * xk;
  // Too many plots for the frame? THIN, never squash. A village seen from the
  // road hides half of itself behind the other half; dropping every k-th
  // dwelling from a depth-sorted list is the honest version of that, and a
  // landmark is never one of the dropped.
  let houses = 0; for (const e of ents) if (!e.lm) houses++;
  const room = Math.max(6, Math.floor(W * .96 / Math.max(COT_W * s * .62, 3.2)));
  const keep = houses > room ? Math.ceil(houses / room) : 1;
  const span = Math.max(dMax - dMin, 1);
  ents.sort((a, b) => b.d - a.d);                          // far first; near overdraws
  let hi = 0;
  for (const e of ents) {
    if (!e.lm && (hi++ % keep)) continue;
    const bw = Math.max(1.2, e.w * s);                     // a tenth off the far edge reads as distance
    push(ox + e.u * xk - bw * .5, bw, e.h * s * (1 - .10 * (e.d - dMin) / span), e.k, e.s);
  }
}

/* ── the eight silhouettes ──────────────────────────────────────────────────
   EVERY polygon below is wound CLOCKWISE, like Canvas2D's own `rect`. The whole
   village is one path filled once with the non-zero rule and the buildings
   deliberately OVERLAP; a triangle wound the other way would punch a hole
   through the roof standing behind it. */
const tri = (g, x0, y0, x1, y1, x2, y2) => { g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); };
/** A gabled roof over [x, x+w], ridge `rise` above the eave, eaves overhanging
 *  by `over` of the span. Pitched roofs are the single biggest reason this
 *  reads as a village: a flat top is a tower block, whatever colour it is. */
const gable = (g, x, w, eaveY, rise, over) => {
  const e = w * over;
  tri(g, x - e, eaveY, x + w * .5, eaveY - rise, x + w + e, eaveY);
};
/** A bar of half-thickness `th` through (cx,cy) along (dx,dy), both ways — the
 *  mill's sails, and the only moving part a village skyline has. */
function bar(g, cx, cy, dx, dy, len, th) {
  const nx = dy * th, ny = -dx * th;
  const ax = cx - dx * len, ay = cy - dy * len, bx = cx + dx * len, by = cy + dy * len;
  g.moveTo(ax + nx, ay + ny); g.lineTo(bx + nx, by + ny);
  g.lineTo(bx - nx, by - ny); g.lineTo(ax - nx, ay - ny); g.closePath();
}
/** The eave line of a dwelling — where the wall stops and the roof starts. */
const riseOf = (k, w, h) => k === K_LONG ? Math.min(w * .22, h * .40) : Math.min(w * .42, h * .46);

/** One building, in world-true proportions, its top at `groundY - h`. */
function drawShape(g, x, w, h, k, groundY, fine) {
  const y = groundY - h;
  if (k === K_TREE) {                                      // the green: canopies, no walls
    const n = w > 14 ? 3 : 2, r = Math.min(h * .42, w / (n * 1.7));
    for (let i = 0; i < n; i++) {
      const cx = x + w * (i + .5) / n, cy = y + r * (i === 1 ? .82 : 1.10);
      g.rect(cx - Math.max(.5, w * .012), cy, Math.max(1, w * .024), groundY - cy);
      g.moveTo(cx + r, cy); g.arc(cx, cy, r, 0, Math.PI * 2);
    }
    return;
  }
  if (k === K_CROSS) {                                     // steps, shaft, head
    g.rect(x + w * .41, y, Math.max(1, w * .18), h * .92);
    g.rect(x + w * .30, y, w * .40, h * .11);
    g.rect(x + w * .14, groundY - h * .19, w * .72, h * .10);
    g.rect(x, groundY - h * .09, w, h * .09);
    return;
  }
  if (k === K_WELL) {                                      // a roofed wellhead
    const pw = Math.max(.8, w * .12);
    g.rect(x + w * .16, y + h * .30, pw, h * .52);
    g.rect(x + w * .72, y + h * .30, pw, h * .52);
    gable(g, x + w * .06, w * .88, y + h * .30, h * .30, .06);
    g.rect(x + w * .06, groundY - h * .22, w * .88, h * .22);
    return;
  }
  if (k === K_MILL) {
    // buildLandmark's own mill, in profile: a tapering tower to 0.53 of its
    // height, a boat cap on top of that, and four sails on a hub at 0.57 whose
    // whips are 0.42 of the whole thing. The sails are most of what a mill IS —
    // drawn short they read as antlers.
    const bodyTop = groundY - h * .53, tw = w * .47;
    g.moveTo(x, groundY); g.lineTo(x + (w - tw) / 2, bodyTop);
    g.lineTo(x + (w + tw) / 2, bodyTop); g.lineTo(x + w, groundY); g.closePath();
    const cx = x + w / 2, r = w * .275;
    g.moveTo(cx - r, bodyTop); g.arc(cx, bodyTop, r, Math.PI, 0, false); g.closePath();
    if (w >= 6) {                                          // below that they are noise
      const th = Math.max(.5, w * .045), len = h * .42, hy = groundY - h * .57;
      bar(g, cx, hy, .707, -.707, len, th);
      bar(g, cx, hy, .707, .707, len, th);
    }
    return;
  }
  if (k === K_TOWER) {                                     // the bell tower, capped
    const capH = h * .18;
    g.rect(x, y + capH, w, h - capH);
    gable(g, x, w, y + capH, capH, .16);
    return;
  }
  if (k === K_CHAPEL) {
    // A WEST TOWER AND A NAVE, which is what a parish church is and what a
    // cathedral is not. The masonry stops at 0.83 and the parapet and pyramid
    // cap sit on it, exactly as buildLandmark builds it; the last tenth is the
    // weathercock, and it is drawn as the hairline it is — never as a spire, and
    // never at a size where it would read as one.
    const tw = Math.max(1.2, w * .36), mason = h * .83, capTop = h * .92;
    const nx = x + tw * .86, nw = Math.max(1.2, w - tw * .86);
    const nh = h * .46, nRise = Math.min(nw * .30, nh * .42);
    g.rect(nx, groundY - nh + nRise, nw, nh - nRise);
    gable(g, nx, nw, groundY - nh + nRise, nRise, .05);
    g.rect(x, groundY - mason, tw, mason);
    g.rect(x - tw * .09, groundY - mason, tw * 1.18, h * .035);   // the parapet
    gable(g, x, tw, groundY - mason, capTop - mason, .10);
    if (fine && w >= 10) {
      const t = Math.max(.4, w * .012);
      g.rect(x + tw * .5 - t, y, t * 2, h - capTop);
    }
    return;
  }
  const rise = riseOf(k, w, h), eave = groundY - (h - rise);
  g.rect(x, eave, w, h - rise);
  gable(g, x, w, eave, rise, k === K_LONG ? .04 : .07);
  if (fine && k === K_COT) {                               // somebody lives here
    const cw = Math.max(1, w * .13), top = eave - rise * .6 - h * .12;
    g.rect(x + w * .70, top, cw, eave - top);
  }
}

function paintInk(g, W, H, groundY, ink) {
  g.fillStyle = ink;
  g.beginPath();
  g.rect(0, groundY, W, H - groundY);
  const fine = H >= 40;
  for (let i = 0; i < SK.n; i++) drawShape(g, SK.x[i], SK.w[i], SK.h[i], SK.k[i], groundY, fine);
  g.fill();
}

// The night layer: yesterday's village keeps its lamps on. Same seeded geometry,
// nothing drawn but warm window dots, so the two passes register exactly. The
// dots go on the WALL, never on a roof or a ridge — a light on a rooftop reads
// as a beacon, and a village does not have one.
function paintLit(g, W, H, groundY, lit) {
  g.fillStyle = lit;
  g.beginPath();
  const pitch = Math.max(2, Math.round(H * .055)), dw = Math.max(1, Math.round(pitch * .40));
  let budget = 1200;
  for (let i = SK.n - 1; i >= 0 && budget > 0; i--) {
    const k = SK.k[i];
    if (k === K_TREE || k === K_CROSS || k === K_WELL) continue;
    const x = SK.x[i], w = SK.w[i], h = SK.h[i];
    let bx = x, bw = w, by, bh;
    if (k === K_TOWER) { bh = h * .82; bx = x + w * .18; bw = w * .64; }
    else if (k === K_CHAPEL) { bh = h * .44; bx = x + w * .30; bw = w * .70; }
    else if (k === K_MILL) { bh = h * .60; bx = x + w * .16; bw = w * .68; }
    else bh = h - riseOf(k, w, h);
    by = groundY - bh;
    // TWO ROWS AND A HANDFUL OF LIGHTS. A full grid of lit squares up a wall is
    // an apartment block; a village has a candle downstairs, one upstairs, and a
    // barn that is simply dark.
    const p = k === K_LONG ? .18 : k === K_COT ? .34 : .26;
    const cap = k === K_LONG ? 6 : 5;
    const rows = Math.min(2, Math.max(1, Math.floor(bh / pitch)));
    const r = rngOf((SK.s[i] >>> 0) ^ 0x1f7d3);
    let lit2 = 0;
    for (let ry = 0; ry < rows && budget > 0 && lit2 < cap; ry++) {
      const cy = groundY - pitch * (ry + .85);
      if (cy < by) break;
      for (let cx = bx + pitch * .6; cx < bx + bw - dw && budget > 0 && lit2 < cap; cx += pitch)
        if (r() < p) { g.rect(Math.round(cx), Math.round(cy), dw, dw); budget--; lit2++; }
    }
  }
  g.fill();
}

/* ═══ 5 · the demo chronicle ════════════════════════════════════════════════
   46 days so the shop window, every screenshot and a plain-browser run all show
   the layer with real shape: a log-normal walk around 180M, one 2.4B spike
   twelve days back (so the records are worth engraving), two restful weekends,
   and a five-day spell running into today. Deterministic for a given seed. */
export function synthChronicle(nowMs, opts) {
  opts = opts || {};
  const span = clamp(opts.days | 0 || 46, 2, 400);
  const today = dayIndexOf(nowMs || Date.now()), rnd = rngOf(opts.seed >>> 0 || 0xc4a071c1);
  const quiet = new Set([5]);
  let pairs = 0;
  for (let k = 14; k < span - 1 && pairs < 2; k++) {         // clear of the spike at 12
    const wd = dateOfDayIndex(shiftDayIndex(today, -k)).getDay();
    if (wd === 6 && !quiet.has(k)) { quiet.add(k); quiet.add(k - 1); pairs++; k += 3; }
  }
  const days = [];
  let firstMs = 0;
  for (let k = span - 1; k >= 0; k--) {
    const idx = shiftDayIndex(today, -k);
    if (quiet.has(k)) continue;
    const u = Math.max(1e-6, rnd()), v = rnd();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    let tok = k === 12 ? 2.4e9 : Math.round(180e6 * Math.exp(clamp(gauss, -2.2, 2.2) * .62));
    if (k === 0) tok = Math.round(tok * .55);              // today is still in progress
    days.push(idx, tok);
    if (!firstMs) firstMs = msOfDayIndex(idx) + 9 * 36e5;
  }
  return { days, firstMs, builtMs: nowMs || Date.now() };
}

/* ═══ 6 · the model ═════════════════════════════════════════════════════════ */
/**
 * @typedef {Object} Day
 * @property {number} idx  @property {number} tok  @property {number} n
 * @property {number} ms   local midnight   @property {number} ord  days since 1970
 * @property {number} seed planSeedOfIndex  @property {number} daySeed yyyymmdd
 * @property {number} tier 0..10  @property {number} marks 0..9  @property {number} miles
 * @property {string} label "Tue 4 Aug"  @property {string} dateLabel "4 August"
 * @property {string} longLabel "Tuesday 4 August 2026"
 * @property {string} name  @property {string} kind  @property {string} kindLabel
 * @property {boolean} live  @property {boolean} quiet
 */
/** @typedef {{len:number, startIdx:number, endIdx:number}} Spell */

export function initChronicle(opts) {
  opts = opts || {};
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const sizeOf = typeof opts.sizeOf === 'function' ? opts.sizeOf
    : tok => Math.min(1200, Math.floor(32 * Math.pow(Math.max(tok, 0) / 1e6, 3 / 8)));
  const identify = typeof opts.identify === 'function' ? opts.identify : null;
  const store = opts.store && typeof opts.store.save === 'function' ? opts.store : null;
  const isReadOnly = () => typeof opts.readOnly === 'function' ? !!opts.readOnly() : !!opts.readOnly;

  // The ladder is snapshotted once: town.js splices a `best` rung into LADDER at
  // runtime and a past day's milestone count must stay the canonical one.
  const rawLad = typeof opts.ladder === 'function' ? opts.ladder() : opts.ladder;
  const LAD = (Array.isArray(rawLad) ? rawLad : []).filter(m => m && m.tok > 0 && !m.best && !m.tick)
    .map(m => ({ tok: +m.tok, mon: m.mon | 0, lm: !!m.lm })).sort((a, b) => a.tok - b.tok);

  let disposed = false, ready = false, rev = 1;
  let list = [], byIdx = new Map(), ords = [];             // ascending, quiet days absent
  let firstMs = 0, builtMs = 0, srcLen = -1;
  let liveTok = 0, todayDetail = null;
  let curIdx = dayIndexOf(nowFn()), todayDay = null;
  const notes = new Map();                                 // idx -> {seen,kept,overtookMs}
  const prefs = { showStreaks: true, ghost: true, strip: true };
  const stats = { kept: 0, firstSeenMs: 0 };
  const announced = new Set();                             // record keys already celebrated
  let overtakeDone = false, overtakeArmed = false;
  let histRec = null, liveRec = null, spellCache = null, viewCache = null, backCache = null;
  let pending = null, saveTimer = null;
  let prefsFrozen = null;

  /* ── derivation ─────────────────────────────────────────────────────────── */
  const tierOf = tok => { let t = 0; for (const m of LAD) if (tok >= m.tok && m.mon > t) t = m.mon; return t; };
  const marksOf = tok => { let c = 0; for (const m of LAD) if (m.lm && tok >= m.tok) c++; return c; };
  const milesOf = tok => { let c = 0; for (const m of LAD) if (tok >= m.tok) c++; return c; };

  function makeDay(idx, tok, live) {
    const d = { idx, ord: ordinalOf(idx), tok: 0, n: 0, tier: 0, marks: 0, miles: 0, live: !!live, quiet: false };
    lazy(d, 'ms', () => msOfDayIndex(idx));
    lazy(d, 'seed', () => planSeedOfIndex(idx));
    lazy(d, 'daySeed', () => daySeedOfIndex(idx));
    const lab = () => labelsFor(idx);
    lazy(d, 'label', () => lab().label);
    lazy(d, 'dateLabel', () => lab().dateLabel);
    lazy(d, 'longLabel', () => lab().longLabel);
    const id = () => (identify ? identify(idx) : null) || {};
    lazy(d, 'name', () => id().name || '');
    lazy(d, 'kind', () => id().kind || '');
    lazy(d, 'kindLabel', () => id().kindLabel || '');
    setTok(d, tok);
    return d;
  }
  function setTok(d, tok) {
    d.tok = Math.max(0, +tok || 0);
    d.n = Math.max(0, sizeOf(d.tok) | 0);
    d.tier = tierOf(d.tok); d.marks = marksOf(d.tok); d.miles = milesOf(d.tok);
    d.quiet = !(d.tok > 0);
    return d;
  }
  function reindex() {
    byIdx = new Map(); ords = new Array(list.length);
    for (let i = 0; i < list.length; i++) { byIdx.set(list[i].idx, list[i]); ords[i] = list[i].ord; }
    histRec = null; liveRec = null; spellCache = null; viewCache = null; backCache = null;
  }
  // histRec included: at a midnight roll the day just watched joins history and
  // its total becomes a record the Stone must know about.
  const bump = () => { rev++; histRec = null; liveRec = null; spellCache = null; viewCache = null; backCache = null; };

  /** Today's live total is monotonic within a session and never lowers a day. */
  function applyLive() {
    if (!ready) return;
    const t = Math.max(liveTok, todayDay ? todayDay.tok : 0);
    if (!todayDay) return;
    if (t === todayDay.tok && !todayDay.quiet) return;
    setTok(todayDay, t);
    if (t > 0 && !byIdx.has(todayDay.idx)) { list.push(todayDay); reindex(); rev++; }
    liveRec = null; spellCache = null; backCache = null;
  }
  /** A day boundary crossed mid-session: yesterday's town settles into history
   *  and the upward-only race re-arms for the new day. Nothing is taken away. */
  function rollTo(idx) {
    curIdx = idx; liveTok = 0; todayDetail = null;
    // A day that begins at nothing while the user watches is, by definition,
    // behind — so the race is armed here and the next crossing is a real one.
    overtakeDone = false; overtakeArmed = true;
    if (todayDay) { todayDay.live = false; if (todayDay.quiet) { list = list.filter(d => d !== todayDay); reindex(); } }
    todayDay = byIdx.get(idx) || makeDay(idx, 0, true);
    todayDay.live = true;
    bump();
  }
  function sync() {
    if (disposed) return;
    const idx = dayIndexOf(nowFn());
    if (idx !== curIdx) rollTo(idx);
  }

  function historicalRecords() {
    if (histRec) return histRec;
    let best = null, largest = null, bs = null, run = 0, runStart = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.live) continue;
      if (!best || d.tok > best.tok) best = d;
      if (!largest || d.n > largest.n) largest = d;
    }
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (i > 0 && ords[i] === ords[i - 1] + 1) run++; else { run = 1; runStart = i; }
      if (!bs || run > bs.len) bs = { len: run, startIdx: list[runStart].idx, endIdx: d.idx };
    }
    histRec = {
      bestDay: best ? { idx: best.idx, tok: best.tok, label: best.dateLabel } : null,
      largest: largest && largest.n > 0 ? { idx: largest.idx, n: largest.n, label: largest.dateLabel } : null,
      bestSpell: bs && bs.len >= 2 ? bs : null
    };
    return histRec;
  }
  function earliestOvertake() {
    let bestMs = -1, bestIdx = 0;
    for (const [idx, nt] of notes) {
      if (!(nt.overtookMs > 0)) continue;
      const into = nt.overtookMs - msOfDayIndex(idx);
      if (into < 0) continue;
      if (bestMs < 0 || into < bestMs) { bestMs = into; bestIdx = idx; }
    }
    if (bestMs < 0) return null;
    const h = Math.floor(bestMs / 36e5), m = Math.floor((bestMs % 36e5) / 6e4);
    return { idx: bestIdx, into: bestMs, hhmm: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') };
  }
  /** Records INCLUDING today's live total — the Stone shows today the moment it
   *  leads. Consumers repaint on the `recordsBrokenBy` event, not on this. */
  function records() {
    sync();
    if (liveRec) return liveRec;
    const h = historicalRecords(), t = todayDay;
    let best = h.bestDay, largest = h.largest, spell = h.bestSpell;
    if (t && t.tok > 0 && (!best || t.tok > best.tok)) best = { idx: t.idx, tok: t.tok, label: t.dateLabel };
    if (t && t.n > 0 && (!largest || t.n > largest.n)) largest = { idx: t.idx, n: t.n, label: t.dateLabel };
    const cur = currentSpell();
    if (cur && (!spell || cur.len > spell.len)) spell = { len: cur.len, startIdx: cur.startIdx, endIdx: cur.endIdx };
    let kept = stats.kept | 0, seen = 0;
    for (const nt of notes.values()) if (nt.seen) seen++;
    if (seen > kept) kept = seen;
    liveRec = Object.freeze({
      bestDay: best ? Object.freeze(best) : null,
      bestSpell: spell ? Object.freeze(spell) : null,
      largest: largest ? Object.freeze(largest) : null,
      firstMs, kept, earliestOvertake: earliestOvertake()
    });
    return liveRec;
  }
  /** The run ending today, or ending yesterday when today is still quiet. R3:
   *  this only ever describes a run that exists — an ended one is silent. */
  function currentSpell() {
    if (spellCache !== null) return spellCache || null;
    spellCache = false;
    if (!ready || !list.length) return null;
    const last = list[list.length - 1];
    const todayOrd = todayDay ? todayDay.ord : ordinalOf(curIdx);
    if (last.ord !== todayOrd && last.ord !== todayOrd - 1) return null;
    let i = list.length - 1, len = 1;
    while (i > 0 && ords[i - 1] === ords[i] - 1) { i--; len++; }
    if (len < 2) return null;
    spellCache = { len, startIdx: list[i].idx, endIdx: last.idx };
    return spellCache;
  }

  /* ── the keepsake (never load-bearing) ──────────────────────────────────── */
  function queueSave(patch) {
    if (disposed || !store || isReadOnly()) return;
    pending = pending || {};
    for (const k in patch) {
      if (k === 'days') { pending.days = pending.days || {}; for (const d in patch.days) pending.days[d] = Object.assign(pending.days[d] || {}, patch.days[d]); }
      else pending[k] = Object.assign(pending[k] || {}, patch[k]);
    }
    if (saveTimer === null) saveTimer = setTimeout(flush, SAVE_MS);
  }
  function flush() {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    const p = pending; pending = null;
    if (!p || !store || isReadOnly()) return;
    try { store.save(p); } catch { /* a keepsake is not worth an error */ }
  }
  function adoptDoc(doc) {
    if (disposed || !doc || typeof doc !== 'object') return;
    if (doc.prefs) for (const k of PREF_KEYS) if (typeof doc.prefs[k] === 'boolean') prefs[k] = doc.prefs[k];
    if (doc.stats) {
      if (doc.stats.kept > stats.kept) stats.kept = doc.stats.kept | 0;
      if (doc.stats.firstSeenMs > 0 && !stats.firstSeenMs) stats.firstSeenMs = +doc.stats.firstSeenMs;
    }
    if (doc.days && typeof doc.days === 'object') for (const k in doc.days) {
      const src = doc.days[k]; if (!src || typeof src !== 'object') continue;
      const idx = +k; if (!Number.isFinite(idx)) continue;
      const nt = notes.get(idx) || {};
      for (const key of NOTE_KEYS) if (src[key] !== undefined && nt[key] === undefined) nt[key] = src[key];
      notes.set(idx, nt);
    }
    prefsFrozen = null; histRec = null; bump();
  }
  if (store && typeof store.load === 'function') {
    try { Promise.resolve(store.load()).then(adoptDoc, () => { }); } catch { /* no bridge */ }
  }

  /* ── the public object ──────────────────────────────────────────────────── */
  const api = {
    get ready() { return ready; },
    /** STRUCTURAL revision: days, notes, prefs, a day boundary. Live token
     *  changes do NOT bump it, so a consumer may rebuild art on `rev` alone. */
    get rev() { return rev; },
    get todayIdx() { sync(); return curIdx; },
    get count() { return list.length; },
    get firstMs() { return firstMs || stats.firstSeenMs || 0; },
    get builtMs() { return builtMs; },
    get days() { sync(); return list; },
    get today() { sync(); return ready ? todayDay : null; },
    get todayDetail() { sync(); return todayDetail; },
    /** The most recent day BEFORE today that has tokens — the ghost on the
     *  horizon is the last town that existed, never an empty field (R1). */
    get yesterday() {
      sync();
      if (!ready) return null;
      const ord = todayDay ? todayDay.ord : ordinalOf(curIdx);
      for (let i = list.length - 1; i >= 0; i--) if (list[i].ord < ord && !list[i].live) return list[i];
      return null;
    },
    get spell() { sync(); return currentSpell(); },
    get records() { return records(); },
    get prefs() { if (!prefsFrozen) prefsFrozen = Object.freeze({ ...prefs }); return prefsFrozen; },

    /** Adopt an `init` (protocol v4). Idempotent; a v3 message leaves the layer
     *  dormant. A malformed block is ignored rather than thrown — history must
     *  never be able to break the town. */
    ingest(msg) {
      if (disposed || !msg || typeof msg !== 'object') return false;
      let changed = false;
      const c = msg.chronicle;
      if (c && Array.isArray(c.days)) {
        const src = c.days, sig = src.length;
        if (!ready || sig !== srcLen || (c.builtMs | 0) !== builtMs) {
          const acc = new Map();
          for (let i = 0; i + 1 < src.length; i += 2) {
            const idx = src[i] | 0, tok = +src[i + 1];
            if (!Number.isFinite(idx) || idx <= 0 || !(tok > 0)) continue;
            acc.set(idx, (acc.get(idx) || 0) + tok);
          }
          const keys = [...acc.keys()].sort((a, b) => a - b);
          const prevNames = byIdx;
          list = keys.map(k => { const old = prevNames.get(k); return old && !old.live ? setTok(old, acc.get(k)) : makeDay(k, acc.get(k), false); });
          firstMs = +c.firstMs > 0 ? +c.firstMs : (list.length ? msOfDayIndex(list[0].idx) : 0);
          builtMs = c.builtMs | 0; srcLen = sig;
          ready = true; changed = true;
          reindex();
          curIdx = dayIndexOf(nowFn());
          todayDay = byIdx.get(curIdx) || makeDay(curIdx, 0, true);
          todayDay.live = true;
        }
      }
      if (msg.today && typeof msg.today === 'object') {
        const t = msg.today;
        const idx = t.date > 0 ? idxOfDateNum(t.date) : curIdx;
        if (idx === curIdx) { todayDetail = Object.freeze({ ...t, idx }); if (t.tok > 0) liveTok = Math.max(liveTok, +t.tok); }
      }
      if (msg.todayTok > 0) liveTok = Math.max(liveTok, +msg.todayTok);
      if (changed) { rev++; }
      applyLive();
      if (changed) { viewCache = null; backCache = null; }
      return changed;
    },
    /** town.js's live day total. Monotonic — a range change never lowers it. */
    setLive(tok) {
      if (disposed || !(tok > 0)) return;
      sync();
      if (tok <= liveTok) return;
      liveTok = +tok;
      applyLive();
    },
    dayAt(idx) { sync(); const d = byIdx.get(idx | 0); return d || null; },
    /** The last `n` calendar days ending today, ascending, quiet days INCLUDED
     *  as meadow entries (`quiet:true`). The header strip draws exactly this. */
    daysBack(n) {
      sync();
      n = clamp(n | 0, 1, 400);
      if (!ready) return EMPTY;
      if (backCache && backCache.n === n && backCache.rev === rev && backCache.idx === curIdx) return backCache.out;
      const out = new Array(n);
      for (let k = n - 1, i = 0; k >= 0; k--, i++) {
        const idx = k === 0 ? curIdx : shiftDayIndex(curIdx, -k);
        out[i] = byIdx.get(idx) || (idx === curIdx && todayDay ? todayDay : makeDay(idx, 0, idx === curIdx));
      }
      backCache = { n, rev, idx: curIdx, out };
      return out;
    },
    /** rank 1 = best ever. Ties resolve to the older day, so matching a record
     *  never displaces the day that set it. */
    rankOf(tok) {
      sync();
      tok = Math.max(0, +tok || 0);
      let rank = 1, of = 0;
      for (const d of list) { if (d.live) continue; of++; if (d.tok >= tok) rank++; }
      if (todayDay && todayDay.tok > 0) of++;
      return { rank: Math.min(rank, Math.max(of, 1)), of: Math.max(of, 1) };
    },
    /** R2 — the ONLY gate a progress bar in this layer may pass through: a
     *  record is "within reach" solely inside its last 20 %. A meter pinned at
     *  4 % all day is a reproach, so below 0.80 this returns null. */
    pressure() {
      sync();
      const h = historicalRecords();
      if (!ready || !h.bestDay || !todayDay) return null;
      const live = todayDay.tok, record = h.bestDay.tok;
      if (!(record > 0) || !(live > 0)) return null;
      const frac = live / record;
      if (frac < .80 || frac >= 1) return null;
      return { key: 'best', label: 'greatest day', record, live, frac };
    },
    /** Records the live total has just beaten and that have not been announced.
     *  Self-latching, safe at 2 Hz, and empty on day one — the first day is not
     *  a record broken, it is the mason waiting. */
    recordsBrokenBy(tok) {
      sync();
      if (!ready) return EMPTY;
      tok = Math.max(0, +tok || (todayDay ? todayDay.tok : 0));
      const h = historicalRecords();
      let out = null;
      if (h.bestDay && tok > h.bestDay.tok && !announced.has('best')) {
        announced.add('best');
        (out = out || []).push({ key: 'best', label: 'greatest day', unit: 'tok', now: tok, was: h.bestDay.tok, wasLabel: h.bestDay.label });
      }
      const n = Math.max(0, sizeOf(tok) | 0);
      if (h.largest && n > h.largest.n && !announced.has('largest')) {
        announced.add('largest');
        (out = out || []).push({ key: 'largest', label: 'largest township', unit: 'buildings', now: n, was: h.largest.n, wasLabel: h.largest.label });
      }
      return out || EMPTY;
    },
    /** THE OVERTAKING (§7.6). Consuming: fires at most once per calendar day,
     *  only upward, only when today's live total crosses yesterday's final one
     *  WHILE THE USER IS WATCHING — a session that opens already ahead latches
     *  silently rather than claiming a moment that happened off-screen. There
     *  is no symmetric event and none may ever be added (R4).
     *  Call only when `ctx.rangeIsDay` and no seed override is in play. */
    overtaking() {
      sync();
      if (disposed || !ready || overtakeDone) return null;
      const y = api.yesterday, t = todayDay;
      if (!y || !t || !(y.tok > 0)) return null;
      const ahead = t.tok > y.tok;
      if (!overtakeArmed) { overtakeArmed = true; if (ahead) { overtakeDone = true; return null; } }
      const nt = notes.get(t.idx);
      if (nt && nt.overtookMs > 0) { overtakeDone = true; return null; }
      if (!ahead) return null;
      overtakeDone = true;
      const ms = nowFn(), into = ms - msOfDayIndex(t.idx);
      const prev = earliestOvertake();
      const hhmm = String(Math.floor(into / 36e5)).padStart(2, '0') + ':' + String(Math.floor((into % 36e5) / 6e4)).padStart(2, '0');
      const earliest = !prev || into < prev.into;
      api.note(t.idx, { overtookMs: ms });
      return { key: 'overtake', ms, hhmm, tok: t.tok, was: y.tok, ghost: y.name, earliest };
    },
    /** The same calendar date in a previous year, if it had tokens. Charm only. */
    onThisDay() {
      sync();
      if (!ready) return null;
      const d = dateOfDayIndex(curIdx), m = d.getMonth(), dd = d.getDate(), y = d.getFullYear();
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i]; if (c.idx >= curIdx - 200) continue;
        const cd = dateOfDayIndex(c.idx);
        if (cd.getFullYear() < y && cd.getMonth() === m && cd.getDate() === dd && c.tok > 0) return c;
      }
      return null;
    },
    setPref(k, v) {
      if (disposed || PREF_KEYS.indexOf(k) < 0 || typeof v !== 'boolean' || prefs[k] === v) return;
      prefs[k] = v; prefsFrozen = null; bump();
      queueSave({ prefs: { [k]: v } });
    },
    /** Record a non-derivable fact. `overtookMs` is first-write-wins, matching
     *  the store's merge, so a re-run can never rewrite a moment. */
    note(idx, patch) {
      if (disposed || !patch) return;
      idx = idx | 0;
      const nt = notes.get(idx) || {};
      const out = {};
      let changed = false, newSeen = false;
      for (const k of NOTE_KEYS) {
        const v = patch[k];
        if (v === undefined) continue;
        if (k === 'overtookMs' && nt[k] > 0) continue;
        if (nt[k] === v) continue;
        if (k === 'seen' && !nt.seen) newSeen = true;
        nt[k] = v; out[k] = v; changed = true;
      }
      if (!changed) return;
      notes.set(idx, nt);
      if (newSeen) { stats.kept = (stats.kept | 0) + 1; out.seen = nt.seen; }
      if (!stats.firstSeenMs) stats.firstSeenMs = nowFn();
      bump();
      queueSave({ days: { [idx]: out }, stats: { kept: stats.kept, firstSeenMs: stats.firstSeenMs } });
    },
    /** The Almanac card's payload. A quiet day is `restful`, never a gap. */
    summaryFor(idx) {
      sync();
      if (!ready) return null;
      idx = idx | 0;
      const d = byIdx.get(idx) || (idx === curIdx ? todayDay : null) || makeDay(idx, 0, false);
      const sp = currentSpell();
      return {
        idx, name: d.name, kind: d.kind, kindLabel: d.kindLabel,
        label: d.label, dateLabel: d.dateLabel, longLabel: d.longLabel,
        tok: d.tok, tokLabel: fmtTok(d.tok), n: d.n, miles: d.miles, tier: d.tier, marks: d.marks,
        seed: d.seed, seedHex: d.seed.toString(16).toUpperCase().slice(-4),
        quiet: d.quiet, quietLabel: 'restful', live: !!d.live,
        spell: sp && sp.endIdx === idx ? sp.len : 0,
        kept: !!(notes.get(idx) || {}).seen,
        detail: d.live ? todayDetail : null
      };
    },
    /** A frozen snapshot for memorial/almanac. Rebuilt on STRUCTURAL change
     *  only; read `today.tok` for the live number. */
    view() {
      sync();
      if (viewCache && viewCache.rev === rev) return viewCache;
      const t = todayDay, y = api.yesterday, sp = currentSpell();
      viewCache = Object.freeze({
        rev, ready, todayIdx: curIdx, count: list.length, firstMs: api.firstMs,
        today: t, yesterday: y, days: list, spell: sp,
        records: records(), prefs: api.prefs
      });
      return viewCache;
    },
    paintSkyline(g, spec, o) { return paintSkyline(g, spec, o); },
    /** The save patch — exactly the three subtrees this module owns. */
    toJSON() {
      const days = {};
      for (const [idx, nt] of notes) days[idx] = { ...nt };
      return { prefs: { ...prefs }, days, stats: { ...stats } };
    },
    flush,
    /** Epoch switch. The chronicle outlives epochs by definition, so this
     *  drops caches only: the announce latches are all-time facts and must not
     *  re-fire, and nothing the user can see is taken away (§9.5). */
    reset() { if (disposed) return; viewCache = null; backCache = null; sync(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      flush();
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      list = []; ords = []; byIdx = new Map(); notes.clear(); announced.clear();
      todayDay = null; todayDetail = null; histRec = liveRec = viewCache = backCache = null;
      spellCache = null; ready = false;
    }
  };
  return api;
}
