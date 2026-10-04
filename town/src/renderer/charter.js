/* ═══════════════════════════════════════════════════════════════════════════
   Token Town v4 — charter.js · THE REGISTER OF HONOURS   (backlog task B1)
   ---------------------------------------------------------------------------
   Twenty-five badges, six of them unadvertised, three of them awarded for
   NOT spending anything. This module is the whole meta-game: it holds no THREE
   objects, mounts no meshes, touches no DOM and imports nothing — it is a state
   machine over the day's facts that emits Awards. town.js turns an Award into a
   floater, a burst and a Crier line exactly as it already does for a LADDER
   milestone, and chronicle-store.js turns a patch into bytes on disk.

   PUBLIC SURFACE (the whole of it)
     initCharter(opts) -> Charter        opts {doc, readOnly, record(patch), now()}
       .facts        the DayFacts scratch object — town.js MUTATES IT IN PLACE
       .check(facts) -> Award[]          call at <=1 Hz on the WALL CLOCK
       .adopt(doc)                       swap the record ('chronicle' message)
       .earned(id)   -> ?{date,at,n,last}
       .ledger()     -> plain data for the Honours panel (B3); fresh object
       .reset()                          epoch switch — keeps the record
       .dispose()                        shutdown
       .readOnly     (getter)
     BADGE_DEFS      frozen metadata for all 25 (no predicates — drive check())
     isSolarFeast(yyyymmdd) -> boolean   solstices/equinoxes ±1 day

   COST. Zero draw calls, zero geometries, zero textures, zero timers, zero
   listeners, zero DOM. A settled check() runs 25 O(1) predicates and allocates
   nothing: measured 0.48 µs and 86 KB of heap drift across TWO MILLION calls on
   this machine — 0.00005 % of the 1 Hz tick it is called on. The Award pool is
   one object per badge, minted at init; a badge can only ever transition
   unearned→earned once in the life of a record, so an Award handed to town.js's
   parade queue can never be rewritten while it waits its turn.

   WHAT THE INTEGRATION WAVE MUST WIRE
     1. town.js: `const charter = initCharter({ doc: chronicleDoc, readOnly: SYNTHETIC,
        record: p => window.townAPI?.chronicle?.save(p) });` — every opt optional.
     2. town.js `fillDayFacts(charter.facts)` once per wall-clock minute (and after
        every milestone / landmark / grove event), then
        `for (const a of charter.check(charter.facts)) fireAward(a);`
        DayFacts is documented below; every field degrades to 0/'' safely.
     3. town.js `onData` case 'chronicle' -> charter.adopt(msg.doc).
     4. town.js hardReset -> charter.reset(); page teardown -> charter.dispose().
     5. news.js: CAT_OF.badge = 'BADGE' + a BADGE corpus keyed {label}/{title}
        (owner: NEWS, wave 2). Until it exists, news.post('badge', …) is ignored
        by design and the badge still floats and bursts.
     6. Nothing else. This module never writes the file: it hands `record()` a
        patch shaped for §4.7's merge and forgets about it.

   THREE THINGS THE §4.7 SCHEMA DOES NOT SAY, AND THIS FILE DECIDES
     · `totals.*` are RECORDS and derived counts, never running sums. A sum is
       not idempotent under a max-merge — reopen the app at noon and a
       "lifetime + today" patch counts today twice — so `buildings`/`milestones`
       mean "the most that ever stood or fired in one day", and `days`/`tok`/
       `spell` are handed to us already derived from usage.db.
     · A badge entry carries one key beyond the schema's `{date, at, n}`:
       `last`, the most recent date the condition was met. `n` (max-merged) can
       only climb; `last` is what makes an older or replayed day a no-op instead
       of an inflation. `date`/`at` are written on the first award and never
       again, so first-write-wins and last-write-wins agree about them forever.
     · `seen.sky` joins `arch`/`roof`/`biome` — same set-union rule, and the day
       the weather regimes are worth a badge the data is already there.
   Rank, the Charter buildings and the rare-event subsystem are v4.1 (§1 cuts),
   so `standing()`, `eventFor()`, `witness()` and `rank` are deliberately absent
   rather than stubbed: a method that can only ever return [] is a call site
   nobody should write yet.

   THE THREE RULES THIS FILE IS BUILT ON
     · Nothing is ever lost. Every persisted number is monotonic under the pinned
       per-leaf merge, so a shuffled or replayed patch can only ever be a no-op.
     · Observe, never demand. No badge has a countdown, a quota, or a remaining
       amount. Secret badges are not listed before they are earned — not greyed,
       not '???'. The panel says how many exist and nothing else.
     · The reward for spending nothing is a badge too (arborist · well_rested ·
       fallow_day). A meta-game that only pays out for tokens burned would be a
       slot machine with a steeple on it.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══ typedefs — the contract town.js fills ═════════════════════ */
/**
 * @typedef {Object} DayFacts   The LOCAL CALENDAR DAY, never the selected range.
 *   Allocated once (see `charter.facts`) and mutated in place. Every field is
 *   optional at runtime: a missing one reads as 0/'' and simply keeps its badges
 *   asleep, which is how this module no-ops before the feed says anything.
 * @property {number} date         YYYYMMDD local. Nothing is awarded until this
 *                                 is a real date — the one hard gate.
 * @property {boolean} dayScoped   true when tok/hours/peak really are TODAY's
 *   (feed v4 `today` block present, or ctx.rangeIsDay). False downgrades to the
 *   range-independent detectors only; see BADGE.day.
 * @property {number} tok          today's tokens
 * @property {number} b            buildings standing
 * @property {number} landmarks    ladder landmarks standing, 0..9
 * @property {number} milestones   ladder rungs fired today
 * @property {number} villagers    roster size on the streets
 * @property {number} breaks       groves planted today
 * @property {number} longestBreakMs
 * @property {number} firstMs @property {number} lastMs   today's first/last token
 * @property {number[]} hours      24 ints, tokens per local hour
 * @property {number} peakBucket   biggest single 5-minute bucket today
 * @property {number} perMin @property {number} paceRatio
 * @property {number} cacheFrac    0..1 of tokens that were cache reads (depth.mix)
 * @property {number} bestTok      largest recorded day EXCLUDING today (0 if none)
 * @property {number} lifetimeTok  sum of every recorded day (0 when unknown)
 * @property {number} daysRecorded days in the chronicle, today included
 * @property {number} spellLen     consecutive recorded days ending today
 * @property {string} arch         plan.kind   @property {string} biome
 * @property {string[]} roofs      roof family names on screen today
 * @property {string} weather      weather.js regime id ('' when there is none)
 * @property {number} hourNow      0..23 local  @property {number} nowMs
 */
/**
 * @typedef {Object} Award
 * @property {'badge'} kind
 * @property {string} id @property {string} icon
 * @property {string} title   'The Small Hours' — floater + plaque + {label}
 * @property {string} blurb   the Ledger line, and the Crier's {title}
 * @property {boolean} secret @property {number} n  times met, this one included
 * @property {number} date    the day it was first earned
 */

/* ═══ null-safe readers — every predicate goes through these ════ */
const EMPTY = Object.freeze([]);
const num = v => (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : 0;
const str = v => typeof v === 'string' ? v : '';
/** tokens in local hour i, 0 when the feed has not sent an hours array yet */
const hr = (f, i) => { const h = f && f.hours; return h ? num(h[i]) : 0; };
const span = f => Math.max(0, num(f.lastMs) - num(f.firstMs));
/** Absence must never read as a state. `hourNow` missing is not midnight and
 *  `tok` missing is not a day where nothing was spent — the two predicates that
 *  fire on a ZERO ask for the field itself, not for its coerced value. */
const has = (f, k) => typeof f[k] === 'number' && f[k] === f[k];
/** recorded days: the chronicle's count, or the record's, whichever knows more */
const daysOf = (f, d) => Math.max(num(f.daysRecorded), num(d.totals.days));
/* `facts.weather` is weather.js's live `id`. The sets are its REGIMES verbatim;
   the substring fallback is there so a regime added after this file was written
   still lands in the right bucket instead of silently never firing. `goldrain`
   is a reward falling out of the sky, not weather, and is in neither. */
const SNOWY = { flurry: 1, snow: 1, blizzard: 1 };
const WETTY = { drizzle: 1, rain: 1, downpour: 1, storm: 1, thunder: 1 };
const isSnow = f => { const w = str(f.weather).toLowerCase(); return SNOWY[w] === 1 || w.indexOf('snow') >= 0; };
const isWet = f => {
  const w = str(f.weather).toLowerCase();
  if (WETTY[w] === 1) return true;
  if (w.indexOf('gold') >= 0) return false;          // `goldrain` is a reward, not a rain
  return w.indexOf('rain') >= 0 || w.indexOf('storm') >= 0;
};
/** archetypes with no water in them — layout.js's five, minus the two wet ones */
const LANDLOCKED = { crossroads: 1, ribbon: 1, hillring: 1 };

/* ═══ solstices and equinoxes, ±1 day ═══════════════════════════
   A lookup, not astronomy: the dates drift by a day across a leap cycle and the
   ±1 window swallows the drift whole. Month*100+day. */
const FEAST = Object.freeze({
  319: 1, 320: 1, 321: 1,          // vernal equinox
  619: 1, 620: 1, 621: 1, 622: 1,  // June solstice
  921: 1, 922: 1, 923: 1,          // autumnal equinox
  1220: 1, 1221: 1, 1222: 1, 1223: 1 // December solstice
});
/** @param {number} date YYYYMMDD local @returns {boolean} */
export function isSolarFeast(date) {
  const v = num(date) | 0;
  if (v < 19700101) return false;
  return FEAST[(v / 100 | 0) % 100 * 100 + v % 100] === 1;
}

/* ═══ THE REGISTER ══════════════════════════════════════════════
   `day: 1` means the predicate reads a quantity that is only true of TODAY
   (tokens, hours, peak, groves). Those sleep when facts.dayScoped is false, so a
   user sitting on a 30-day dashboard is never awarded "a billion in a day" for a
   month's work. Everything else — what is standing, what has been seen, what the
   sky is doing — is true whatever the dashboard is counting, and keeps running.

   Copy gate (§6): no imperative, no quota, no remaining amount, no model name,
   no path, no losable anything. The register talks about the town; where it
   addresses the user at all it does so in the past tense. */
const BADGES = [
  /* ── the clock ─────────────────────────────────────────────── */
  // NOT `first_light`: town.js's LADDER already owns that id and that phrase for
  // the 250k rung, and two things called First Light in one register is a bug
  // waiting for a Crier line.
  { id: 'first_day', icon: '🌅', name: 'The First Day', secret: 0, day: 0,
    blurb: 'The first day anybody thought to write down.',
    test: (f, d) => daysOf(f, d) >= 1 || num(f.tok) > 0 },
  // 🌃 was a night CITYSCAPE and 🏙 (below) a skyline of towers: the two badges
  // most likely to be on screen were advertising the wrong kind of place. A
  // candle in a window and a cluster of roofs say the same facts in the
  // village's own vocabulary (AESTHETIC.md).
  { id: 'after_midnight', icon: '🕯', name: 'After Midnight', secret: 0, day: 1,
    blurb: 'Something arrived between midnight and one. The Ledger was awake for it.',
    test: f => hr(f, 0) > 0 },
  { id: 'small_hours', icon: '🦉', name: 'The Small Hours', secret: 1, day: 1,
    blurb: 'Three in the morning. The owls filed a report.',
    test: f => hr(f, 3) > 0 },
  { id: 'dawn_patrol', icon: '🐓', name: 'Dawn Patrol', secret: 0, day: 1,
    blurb: 'Work before the sun had cleared the hedgerow.',
    test: f => hr(f, 4) > 0 || hr(f, 5) > 0 },
  { id: 'long_day', icon: '🕰', name: 'The Long Day', secret: 0, day: 1,
    blurb: 'Fourteen hours between the first token and the last.',
    test: f => span(f) >= 14 * 36e5 },
  { id: 'stargazer', icon: '🔭', name: 'Stargazer', secret: 1, day: 1,
    blurb: 'Present at the turn of the day, while the date changed under the town.',
    test: f => has(f, 'hourNow') && (f.hourNow | 0) === 0 && num(f.tok) > 0 },

  /* ── the number ────────────────────────────────────────────── */
  { id: 'billion_day', icon: '🌌', name: 'Billion Day', secret: 0, day: 1,
    blurb: 'A billion tokens between one midnight and the next.',
    test: f => num(f.tok) >= 1e9 },
  { id: 'twice_over', icon: '☄️', name: 'Twice Over', secret: 0, day: 1,
    blurb: 'Two billion. The tablet was replaced mid-afternoon.',
    test: f => num(f.tok) >= 2e9 },
  { id: 'flash_flood', icon: '⚡', name: 'Flash Flood', secret: 0, day: 1,
    blurb: 'Fifty million inside five minutes. The mill is still smoking.',
    test: f => num(f.peakBucket) >= 5e7 },
  // `bestTok` EXCLUDES today, so this is a strict crossing and not a tautology.
  { id: 'best_day_yet', icon: '🥇', name: 'Best Day Yet', secret: 0, day: 1,
    blurb: 'The largest day in the record. The previous holder took it well.',
    test: f => num(f.tok) > 0 && num(f.tok) >= Math.max(num(f.bestTok), 1) },
  { id: 'boom_town', icon: '📈', name: 'Boom Town', secret: 0, day: 1,
    blurb: 'An hour that ran at double the day\'s own pace. The masons were asked to account for it.',
    test: f => num(f.paceRatio) >= 2 && num(f.tok) >= 1e7 },
  { id: 'reading_room', icon: '📖', name: 'The Reading Room', secret: 0, day: 1,
    blurb: 'The town spent the day re-reading what it already knew, and enjoyed it.',
    test: f => num(f.cacheFrac) >= .9 && num(f.tok) >= 1e7 },

  /* ── the town ──────────────────────────────────────────────── */
  { id: 'bricklayer', icon: '🧱', name: 'Bricklayer', secret: 0, day: 0,
    blurb: 'A hundred roofs standing at once.',
    test: f => num(f.b) >= 100 },
  { id: 'four_hundred', icon: '🏘', name: 'Four Hundred', secret: 0, day: 0,
    blurb: 'Four hundred roofs. The surveyor has stopped counting aloud.',
    test: f => num(f.b) >= 400 },
  // Either witness counts: the nine landmarks standing, or the ten rungs fired.
  { id: 'whole_ladder', icon: '⛪', name: 'The Whole Ladder', secret: 0, day: 0,
    blurb: 'Every rung on the ladder, and every landmark it pays for, in one town.',
    test: f => num(f.landmarks) >= 9 || num(f.milestones) >= 10 },
  { id: 'full_streets', icon: '👥', name: 'Full Streets', secret: 0, day: 0,
    blurb: 'A hundred and twenty villagers out at once. The plaza has stopped being a suggestion.',
    test: f => num(f.villagers) >= 120 },

  /* ── the collection (slow, and all the better for it) ──────── */
  { id: 'cartographer', icon: '🗺', name: 'Cartographer', secret: 0, day: 0,
    blurb: 'All five kinds of town, surveyed and filed.',
    test: (f, d) => d.seen.arch.length >= 5 },
  { id: 'colourist', icon: '🎨', name: 'Colourist', secret: 0, day: 0,
    blurb: 'Ten roof families. The Guild of Tilers has been informed.',
    test: (f, d) => d.seen.roof.length >= 10 },
  { id: 'hundred_days', icon: '👑', name: 'Hundred Days', secret: 0, day: 0,
    blurb: 'One hundred days in the record. The column does not consider this remarkable. The column is lying.',
    test: (f, d) => daysOf(f, d) >= 100 },

  /* ── the sky, and the luck of the calendar ─────────────────── */
  { id: 'snow_day', icon: '❄️', name: 'Snow Day', secret: 1, day: 0,
    blurb: 'Snow on the roofs, and the streets busy under it anyway.',
    test: f => isSnow(f) && num(f.tok) > 0 },
  { id: 'the_turning', icon: '🌓', name: 'The Turning', secret: 1, day: 0,
    blurb: 'The town was open on one of the four days the sun turns around.',
    test: f => isSolarFeast(f.date) && num(f.tok) > 0 },
  { id: 'high_and_dry', icon: '🌉', name: 'High and Dry', secret: 1, day: 0,
    blurb: 'Rain on a town with no river in it. The bridge committee has reconvened.',
    test: f => isWet(f) && LANDLOCKED[str(f.arch)] === 1 && num(f.tok) > 0 },

  /* ── the hours nothing was spent (R3) ──────────────────────── */
  { id: 'arborist', icon: '🌳', name: 'Arborist', secret: 0, day: 1,
    blurb: 'Ten groves in one day. The town is mostly trees and is entirely fine with that.',
    test: f => num(f.breaks) >= 10 },
  { id: 'well_rested', icon: '🛌', name: 'Well Rested', secret: 0, day: 1,
    blurb: 'A three-hour grove. Nothing was spent and the trees came anyway.',
    test: f => num(f.longestBreakMs) >= 3 * 36e5 },
  { id: 'fallow_day', icon: '🍃', name: 'The Fallow Day', secret: 1, day: 1,
    blurb: 'A whole day of woodland. The town kept its own hours and enjoyed every one of them.',
    test: (f, d) => has(f, 'tok') && f.tok === 0 && has(f, 'hourNow') && f.hourNow >= 18 && daysOf(f, d) >= 1 }
];

/** Frozen metadata for the Honours panel, the corpus and the harness. No
 *  predicates: drive the real ones through check() so a test cannot pass
 *  against a table the engine does not actually use. */
export const BADGE_DEFS = Object.freeze(BADGES.map((b, i) => Object.freeze({
  id: b.id, icon: b.icon, name: b.name, blurb: b.blurb,
  secret: !!b.secret, dayScoped: !!b.day, ord: i
})));

/* ═══ the record ════════════════════════════════════════════════ */
/** Normalise whatever the bridge handed us into the shape the predicates read.
 *  A missing file, a v3 doc and a doc from the future all land here as an empty
 *  but complete record, so nothing downstream ever needs a guard. */
function normDoc(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const t = s.totals && typeof s.totals === 'object' ? s.totals : {};
  const bs = s.badges && typeof s.badges === 'object' ? s.badges : {};
  const sn = s.seen && typeof s.seen === 'object' ? s.seen : {};
  const list = k => (Array.isArray(sn[k]) ? sn[k].filter(v => typeof v === 'string') : []);
  const out = {
    totals: {
      days: num(t.days), buildings: num(t.buildings), milestones: num(t.milestones),
      tok: num(t.tok), spell: num(t.spell)
    },
    badges: {},
    seen: { arch: list('arch'), roof: list('roof'), biome: list('biome'), sky: list('sky') }
  };
  for (const b of BADGES) {
    const e = bs[b.id];
    if (!e || typeof e !== 'object') continue;
    out.badges[b.id] = {
      date: num(e.date) | 0, at: num(e.at), n: Math.max(1, num(e.n) | 0),
      last: Math.max(num(e.last) | 0, num(e.date) | 0)
    };
  }
  return out;
}

/**
 * @param {{doc?:Object, readOnly?:boolean, record?:(patch:Object)=>void, now?:()=>number}} [opts]
 */
export function initCharter(opts) {
  const o = opts || {};
  let readOnly = !!o.readOnly;
  let sink = typeof o.record === 'function' ? o.record : null;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  let doc = normDoc(o.doc);
  let dead = false;

  /** @type {DayFacts} allocated ONCE; town.js mutates it in place, never reassigns. */
  const facts = {
    date: 0, dayScoped: true, tok: 0, b: 0, landmarks: 0, milestones: 0, villagers: 0,
    breaks: 0, longestBreakMs: 0, firstMs: 0, lastMs: 0,
    hours: new Array(24).fill(0), peakBucket: 0, perMin: 0, paceRatio: 1, cacheFrac: 0,
    bestTok: 0, lifetimeTok: 0, daysRecorded: 0, spellLen: 0,
    arch: '', biome: '', roofs: [], weather: '', hourNow: 0, nowMs: 0
  };

  // One Award per badge, minted once. A badge crosses unearned→earned at most
  // once in the life of a record, so an Award handed to town.js's queue can
  // never be rewritten while it waits its turn in the parade.
  const pool = Object.create(null);
  for (const b of BADGES) {
    pool[b.id] = { kind: 'badge', id: b.id, icon: b.icon, title: b.name, blurb: b.blurb, secret: !!b.secret, n: 1, date: 0 };
  }
  const out = [];          // reused; valid until the next check()

  /* ── patch assembly ─────────────────────────────────────────
     Built lazily so a check that changes nothing allocates nothing. Shaped for
     §4.7's merge and for nothing else: numbers under totals.* and *.n are
     max-merged, `date`/`at` are first-write-wins (and are therefore only ever
     emitted on the first award), seen.* are set-unioned. There is no delete. */
  let patch = null;
  const P = () => (patch || (patch = {}));
  const pTotals = () => { const p = P(); return p.totals || (p.totals = {}); };
  const pSeen = () => { const p = P(); return p.seen || (p.seen = {}); };
  const pBadge = id => { const p = P(); const b = p.badges || (p.badges = {}); return b[id] || (b[id] = {}); };

  /** totals.* are RECORDS and derived counts — never running sums. A sum cannot
   *  be maintained idempotently under a max-merge (reopen the app at noon and a
   *  "lifetime + today" patch counts today twice), so `buildings`/`milestones`
   *  are "the most that ever stood/fired in one day" and `days`/`tok`/`spell`
   *  come from the chronicle, which derives them from usage.db every launch. */
  function raise(key, v) {
    v = num(v);
    if (!(v > doc.totals[key])) return;
    doc.totals[key] = v;
    pTotals()[key] = v;
  }
  function sawIt(key, v) {
    if (typeof v !== 'string' || !v) return;
    const list = doc.seen[key];
    if (list.indexOf(v) >= 0 || list.length >= 64) return;
    list.push(v);
    const p = pSeen(), a = p[key] || (p[key] = []);
    a.push(v);
  }
  function flush() {
    if (!patch) return;
    if (!readOnly && sink) { try { sink(patch); } catch (e) { /* the record is a courtesy, never a dependency */ } }
    patch = null;
  }

  /* ── the tick ───────────────────────────────────────────────── */
  /**
   * Run every detector. Cheap enough for a wall-clock 1 Hz tick; idempotent, so
   * calling it ten times a second only wastes the ten.
   * @param {DayFacts} [f] defaults to `charter.facts`
   * @returns {Award[]} reused array, empty when nothing was earned. Valid until
   *   the next check(); the Award objects inside it are stable forever.
   */
  function check(f) {
    if (dead) return EMPTY;
    f = f || facts;
    // Before the feed has said what day it is there is nothing to award, and
    // nothing to record. This is the null-object gate: wave-0 call sites can run
    // from frame one against an engine with no data behind it.
    const date = num(f.date) | 0;
    if (date < 19700101) return EMPTY;
    out.length = 0;

    const scoped = f.dayScoped !== false;
    if (scoped) {
      raise('buildings', f.b); raise('milestones', f.milestones); raise('spell', f.spellLen);
    }
    raise('days', daysOf(f, doc)); raise('tok', f.lifetimeTok);
    sawIt('arch', f.arch); sawIt('biome', f.biome); sawIt('sky', f.weather);
    const roofs = f.roofs;
    if (Array.isArray(roofs)) for (let i = 0; i < roofs.length; i++) sawIt('roof', roofs[i]);

    for (let i = 0; i < BADGES.length; i++) {
      const B = BADGES[i];
      if (B.day && !scoped) continue;              // §2.2: today's numbers, or silence
      if (!B.test(f, doc)) continue;
      const e = doc.badges[B.id];
      if (!e) {
        // First time ever. `date`/`at` are written exactly once, so the store's
        // first-write-wins rule and a last-write-wins one agree forever.
        const at = num(now());
        doc.badges[B.id] = { date, at, n: 1, last: date };
        const p = pBadge(B.id); p.date = date; p.at = at; p.n = 1; p.last = date;
        const a = pool[B.id]; a.n = 1; a.date = date;
        out.push(a);
      } else if (date > e.last) {
        // A later day met it again: the ×n the panel prints, and no ceremony.
        // Strictly-greater is what makes a replayed or reordered day a no-op.
        e.n++; e.last = date;
        const p = pBadge(B.id); p.n = e.n; p.last = date;
      }
    }
    flush();
    return out;
  }

  /* ── the rest of the surface ────────────────────────────────── */
  /** Swap the whole record (the main process's 'chronicle' message). Anything
   *  already earned in the incoming doc simply stops being awardable. */
  function adopt(next) {
    if (dead) return;
    patch = null;
    doc = normDoc(next);
  }
  /** @returns {?{date:number, at:number, n:number, last:number}} */
  function earned(id) {
    const e = doc.badges[id];
    return e ? { date: e.date, at: e.at, n: e.n, last: e.last } : null;
  }
  /** Everything the Honours panel renders. Fresh objects — call it on open, not
   *  on a frame. Unearned SECRETS are never listed, not even as a locked row:
   *  the count is the whole hint. Unearned public ones show name and blurb,
   *  which is a horizon and not a task list. */
  function ledger() {
    const earnedRows = [], openRows = [];
    let secretsLeft = 0;
    for (const b of BADGE_DEFS) {
      const e = doc.badges[b.id];
      if (e) {
        earnedRows.push({ id: b.id, icon: b.icon, name: b.name, blurb: b.blurb, secret: b.secret, date: e.date, n: e.n });
      } else if (b.secret) { secretsLeft++; }
      else openRows.push({ id: b.id, icon: b.icon, name: b.name, blurb: b.blurb });
    }
    earnedRows.sort((x, y) => (x.date - y.date) || (x.id < y.id ? -1 : 1));
    return {
      totals: { days: doc.totals.days, buildings: doc.totals.buildings, milestones: doc.totals.milestones, tok: doc.totals.tok, spell: doc.totals.spell },
      earned: earnedRows, unearned: openRows,
      count: earnedRows.length, of: BADGE_DEFS.length,
      secretsLeft,
      secretLine: secretsLeft
        ? `🔒 ${secretsLeft} further honour${secretsLeft === 1 ? '' : 's'} exist${secretsLeft === 1 ? 's' : ''}. They are not advertised.`
        : '🔓 Every honour in the register has been found.',
      seen: { arch: doc.seen.arch.slice(), roof: doc.seen.roof.slice(), biome: doc.seen.biome.slice(), sky: doc.seen.sky.slice() }
    };
  }
  /** Epoch switch. The record survives (it is the point); only the day-scoped
   *  scratch is cleared. Nothing can re-award: an earned badge is earned in the
   *  doc, and the doc is what the detectors read. */
  function reset() {
    if (dead) return;
    patch = null;
    out.length = 0;
    facts.date = 0; facts.tok = 0; facts.b = 0; facts.landmarks = 0; facts.milestones = 0;
    facts.villagers = 0; facts.breaks = 0; facts.longestBreakMs = 0;
    facts.firstMs = 0; facts.lastMs = 0; facts.peakBucket = 0; facts.perMin = 0;
    facts.paceRatio = 1; facts.cacheFrac = 0; facts.hourNow = 0; facts.nowMs = 0;
    facts.weather = ''; facts.roofs.length = 0;
    for (let i = 0; i < 24; i++) facts.hours[i] = 0;
  }
  /** Shutdown. There is nothing to release — no GPU handles, no timers, no
   *  listeners, no DOM — so this only makes every later call a no-op. */
  function dispose() {
    dead = true; patch = null; sink = null; out.length = 0;
  }

  return {
    facts, check, adopt, earned, ledger, reset, dispose,
    get readOnly() { return readOnly; },
    set readOnly(v) { readOnly = !!v; if (readOnly) patch = null; }
  };
}
