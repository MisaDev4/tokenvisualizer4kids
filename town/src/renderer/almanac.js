// The Almanac — the history layer's paper half (v4 tasks H4 + H5).
//
// Two surfaces, both DOM/Canvas2D, zero draw calls, zero THREE:
//   • the header strip — the last 14 days as little towns, quiet days drawn as
//     green meadow lines (never gaps, never grey — the R1 rule). It lives in the
//     HEADER because town.js rewrites <footer id="stats"> wholesale every 500 ms.
//   • the Almanac card — a parchment page that gives a day a proper full stop:
//     its name, its date, its skyline, and the story of what got built. It
//     borrows the founding plate's typography (Georgia, letter-spaced small caps,
//     hairline rules) so the plate and the card read as pages from one book.
//
// It is a keepsake, not a dashboard: no rank, no comparison to any other day, no
// percentage, no "to go". The card is antiquarian and past-tense by construction.
//
// PUBLIC SURFACE
//   initAlmanac(cfg) → {
//     setView(v)            adopt a chronicle snapshot (or the live Chronicle —
//                           both satisfy {ready, days[], today, prefs}). Idempotent
//                           and signature-guarded, so calling it on town.js's
//                           500 ms tick is free.
//     showCard(idx, opts)   opts {hold=7000, pin=false}; idx null ⇒ today (or the
//                           most recent day with tokens). → boolean (was shown)
//     hide()                takes the card down; the strip stays (it is chrome).
//     update(now)           WALL CLOCK. Coalesced repaint + auto-hide + photo
//                           mode. Safe at 1 fps; nothing here is dt-paced.
//     reset()               epoch switch: card down, strip repainted (new accent).
//     dispose()             shutdown: DOM, listeners, timers, canvases released.
//     get visible           card is on screen — for the §5 chrome-budget arbiter.
//     get ready             a chronicle with at least one day has been adopted.
//   }
// There is deliberately NO showMap(): the Kingdom Map (H8) is out of v4, so no
// call site should be wired for it. Clicking a strip day pins that day's card.
//
// COST  0 draw calls, 0 GPU resources, no THREE. Steady state is one wall-clock
//   early-out per frame — measured at 0.0001 ms/frame over 20 000 calls. A full
//   strip repaint is 14 cheap-mode skylines (0.5 ms in Node against a stub
//   painter; ≈ 6 ms if a real cheap-mode skyline costs the design's 0.4 ms),
//   coalesced to at most once per 400 ms
//   and only when the day set, today's township size, the strip pref or the accent
//   changed (identical setView calls repaint nothing, so the 500 ms stats tick is
//   free). The card repaints only when it is shown. Backing store: 15 canvases,
//   ~7 KB at dpr 1, ~28 KB at dpr 2.
//
// WHAT THE INTEGRATION WAVE MUST WIRE (town.js)
//   1. const almanac = initAlmanac({ paintSkyline, chronicle, accent: () => ctx.accentCss,
//        canShow: () => !deedOpen && !mapOpen, dayIndexOf, dateOfDayIndex });
//      Every field is optional — with none of them the module is a silent no-op.
//   2. applyInit(): almanac.setView(chronicle.view());
//   3. the 500 ms stats tick: almanac.setView(chronicle.view());   (cheap, guarded)
//   4. the frame loop: almanac.update(now);                        (performance.now)
//   5. hardReset(): almanac.reset();
//   6. the day-boundary branch of the fade, BEFORE hardReset():
//        almanac.showCard(prevDayIdx, { hold: 7000 });
//   7. interact.js's keymap: 'A' → almanac.showCard(null, { pin: true }) / hide();
//      Esc → almanac.hide(). The chrome arbiter calls hide() when the deed opens.
//   8. main.js must forward the `almanac` query flag (F2's list): ?almanac=1 opens
//      today's card and pins it open for a headless shot (any value ≤ 1000 means
//      "today"); ?almanac=<dayIdx> opens that day; ?almanac=0 makes the whole
//      module dormant. ?shot-ui=0 (or ?ui=0) and body.photo hide both surfaces.
//
// DEGRADATION  No cfg, no chronicle, no painter, no header, a v3 feed, prefs.strip
//   off, an unready chronicle — every one of those renders exactly nothing and
//   every method stays callable. A painter that throws is latched off and the
//   strip falls back to all-meadow, which is green and honest rather than empty.
//
// NOTES FROM WIRING IT AGAINST THE STAGED chronicle.js (verified in Node)
//   • `paintSkyline` sizes itself from `o.w`/`o.h` or else from the CANVAS BACKING
//     STORE. These canvases carry a DPR transform, so w/h are always passed
//     explicitly — without them every silhouette draws at 2× inside a 26 px cell.
//   • Quiet days go through the same painter with `{quiet:true}`, so a meadow here
//     is the same drawing as a meadow on the ghost and the map. The local meadow
//     below is only the fallback for when there is no painter at all.
//   • `summaryFor(idx)` calls the milestone count `miles`, hands the seed over as
//     `seedHex`, and carries the feed's `today` block as `detail` — which exists
//     for TODAY ONLY, so the clock and breaks rows appear on today's page and are
//     silently absent from a past one. `grandest` is printed if it is ever added.
//   • `view()` is frozen and rebuilt only on a structural change, so its `rev` is
//     the first term of the repaint signature.

/* ═══ local mirrors ═════════════════════════════════════════════
   The house rule forbids lateral imports (town.js is the sole mediator), so the
   handful of pure formulas this file needs are mirrored here rather than
   imported. Every one of them is a published constant of the design and is
   OVERRIDDEN by the real value whenever the chronicle supplies it — these only
   run when a Day arrives carrying nothing but {idx, tok}. */
const DAY_MS = 864e5, N_CAP = 1200;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const grouped = n => String(Math.round(Math.max(n, 0))).replace(/\B(?=(\d{3})+$)/g, ' ');
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : grouped(n);
const pad2 = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fnv1a = s => { let h = 0x811c9dc5 >>> 0; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
/** town.js's growth law, verbatim: the strip may never disagree with the town. */
const townSize = t => Math.min(N_CAP, Math.floor(32 * Math.pow(Math.max(t, 0) / 1e6, 3 / 8)));
/** chronicle.js's calendar, verbatim (year*400 + day-of-year; local, DST-exact). */
const idxOfDate = d => d.getFullYear() * 400 + Math.round(
  (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / DAY_MS);
const dateOfIdx = i => new Date(Math.floor(i / 400), 0, 1 + (i % 400));
/** town.js's LADDER, reduced to what a silhouette needs:
 *  [tokens, fountain tier, is-a-landmark]. The 2.5B rung raises THE INN — the
 *  tenth and last landmark — so it carries a 1 here; reading it as an ordinary
 *  milestone left the biggest days in the chronicle one building short of what
 *  the town actually built. */
const RUNGS = [
  [250e3, 1, 0], [1e6, 2, 1], [5e6, 3, 1], [10e6, 4, 1], [25e6, 5, 1], [50e6, 6, 1],
  [100e6, 7, 1], [250e6, 8, 1], [500e6, 9, 1], [1e9, 10, 1],
  [2.5e9, 0, 1], [5e9, 0, 0], [10e9, 0, 0], [25e9, 0, 0], [50e9, 0, 0], [100e9, 0, 0]
];
/** layout.js's KIND_LABEL, for a Day that arrives with an archetype but no phrase.
 *  SHAPE ONLY — the size word came out of these when it turned out a hamlet was
 *  being labelled a market town. A past day's shape is knowable from its seed;
 *  its size is not, without its tokens, so a card that has only the archetype
 *  says only the archetype. */
const KIND_PHRASE = {
  crossroads: 'crossroads', riverside: 'riverside',
  ribbon: 'valley ribbon', lakeside: 'lakeside', hillring: 'hill terrace'
};
function rungsFor(tok) {
  let tier = 0, marks = 0, miles = 0;
  for (const r of RUNGS) { if (tok < r[0]) break; miles++; if (r[1]) tier = r[1]; if (r[2]) marks++; }
  return { tier, marks, miles };
}

/* ═══ ink ═══════════════════════════════════════════════════════ */
const STRIP_INK = 'rgba(214,210,192,.55)';      // a past town in the header
const STRIP_GRASS = 'rgba(126,150,96,.60)';     // a quiet day: green, never grey
const CARD_INK = 'rgba(58,49,33,.78)';          // a town on parchment
const CARD_GRASS = 'rgba(104,124,78,.80)';
const SEP = ' · ';

/* ═══ stylesheet ════════════════════════════════════════════════
   PREPENDED to <head> exactly like news.js's sheet, so anything index.html
   defines later in the document always wins. Base state is the FINAL state: a
   throttled compositor sampling one frame in a second must never catch a blank
   page, so the entrance animation only ever travels toward what is written here. */
const CSS = `
.alm-strip{display:inline-flex; align-items:flex-end; gap:2px; height:15px; flex:none;
  opacity:.92; line-height:0}
.alm-strip canvas{display:block; width:26px; height:14px; border-radius:2px;
  background:rgba(255,255,255,.035); cursor:pointer}
.alm-strip canvas.alm-today{box-shadow:0 1px 0 0 var(--accent,#D9A441)}
.alm-scope{margin:-2px 0 5px; font-size:10.5px; letter-spacing:.05em;
  text-transform:uppercase; color:#8A7551}
/* OFF THE PLAZA AXIS. Centred, the card landed squarely over the altar and hid
   the ledger — i.e. the number the whole app is about — every time it opened. */
.alm-card{position:absolute; left:27%; top:45%; transform:translate(-50%,-50%); z-index:4;
  pointer-events:none; width:min(344px,86vw); padding:15px 22px 13px; text-align:center;
  color:#3B3222; border-radius:3px; background:linear-gradient(#F2EAD7,#E2D7BC);
  box-shadow:0 12px 36px rgba(0,0,0,.55), 0 0 0 1px rgba(92,74,38,.40),
             inset 0 0 40px rgba(158,132,82,.20);
  font:13px/1.5 Georgia,"Times New Roman",serif; opacity:1}
.alm-card .alm-nm{font:400 21px/1.18 Georgia,"Times New Roman",serif; letter-spacing:.15em;
  color:#2C2417}
.alm-card .alm-sub{margin-top:5px; font-size:11px; letter-spacing:.10em; color:#6B5C40;
  text-transform:lowercase}
.alm-card .alm-rule{height:1px; margin:10px auto; width:78%; background:#8A7444; opacity:.5}
.alm-card .alm-art{display:block; margin:0 auto 9px; width:100%; max-width:300px; height:72px}
.alm-card .alm-tok{font:600 20px/1.2 Georgia,"Times New Roman",serif; color:#2C2417;
  font-variant-numeric:tabular-nums}
.alm-card .alm-tok i{font-style:normal; font-size:11.5px; letter-spacing:.08em; color:#6B5C40}
.alm-card .alm-row{font-size:12px; color:#5A4B33; margin-top:2px}
.alm-card .alm-row b{color:#2C2417; font-weight:600; font-variant-numeric:tabular-nums}
.alm-card .alm-foot{margin-top:1px; font-size:10.5px; letter-spacing:.12em; color:#7A6845;
  text-transform:lowercase}
.alm-card.alm-in{animation:almIn .30s cubic-bezier(.2,.8,.3,1)}
@keyframes almIn{from{opacity:.55; transform:translate(-50%,-46%) scale(.985)}
                 to{opacity:1; transform:translate(-50%,-50%) scale(1)}}
.alm-card.alm-out{animation:almOut .22s ease-out both}
@keyframes almOut{to{opacity:0}}
body.photo .alm-card, body.photo .alm-strip{display:none !important}
@media (max-width:820px){.alm-strip{display:none}}
`;

/** Every method present, every method inert — wave-0 call sites exist first. */
const DORMANT = Object.freeze({
  setView() { }, showCard() { return false; }, hide() { }, update() { }, setScope() { },
  reset() { }, dispose() { }, get visible() { return false; }, get ready() { return false; },
  get pinned() { return false; }
});

/**
 * @typedef {Object} AlmanacCfg
 * @property {(g:CanvasRenderingContext2D, spec:object, o:object)=>void} [paintSkyline]
 *           chronicle.js's shared painter. Absent ⇒ every day draws as meadow.
 * @property {{summaryFor?:Function, dayAt?:Function}} [chronicle]  the live model
 * @property {HTMLElement} [header]  strip mount (default <header>)
 * @property {HTMLElement} [anchor]  strip goes after this node (default #palDots)
 * @property {HTMLElement} [overlay] card mount (default #overlay, then #stage)
 * @property {()=>string} [accent]   today's accent css; default reads --accent
 * @property {()=>boolean} [canShow] chrome-budget arbiter; false ⇒ no card
 * @property {(ms:number)=>number} [dayIndexOf]     chronicle's, if handed down
 * @property {(idx:number)=>Date} [dateOfDayIndex]  chronicle's, if handed down
 * @property {number} [days=14]      strip length
 * @property {string|URLSearchParams} [query]  test seam for the flags
 * @property {Document} [document]   test seam
 */
/**
 * @param {AlmanacCfg} [cfg]
 * @returns {{setView:Function, showCard:Function, hide:Function, update:Function,
 *            reset:Function, dispose:Function, visible:boolean, ready:boolean}}
 */
export function initAlmanac(cfg = {}) {
  const doc = cfg.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return DORMANT;

  const Q = cfg.query instanceof URLSearchParams ? cfg.query
    : new URLSearchParams(cfg.query !== undefined ? cfg.query
      : (typeof location !== 'undefined' ? location.search : ''));
  const flag = Q.get('almanac');
  // ?shot-ui=0 (and its aliases) is the headless "no chrome" switch; ?almanac=0
  // is the A/B switch that takes this module out of a comparison shot entirely.
  const uiOff = Q.get('shot-ui') === '0' || Q.get('shotui') === '0' || Q.get('ui') === '0';
  if (flag === '0' || uiOff) return DORMANT;
  // ?almanac=1 → today; ?almanac=<dayIdx> → that day. Pinned open either way, so
  // a 9 s capture always lands on a finished card.
  const forceIdx = flag === null ? null
    : (Number.isFinite(+flag) && +flag > 1000 ? (+flag | 0) : -1);

  const N = clamp(cfg.days | 0 || 14, 3, 28);
  const paint = typeof cfg.paintSkyline === 'function' ? cfg.paintSkyline
    : (cfg.chronicle && typeof cfg.chronicle.paintSkyline === 'function'
      ? cfg.chronicle.paintSkyline.bind(cfg.chronicle) : null);
  const chron = cfg.chronicle || null;
  const canShow = typeof cfg.canShow === 'function' ? cfg.canShow : () => true;
  const toIdx = typeof cfg.dayIndexOf === 'function' ? cfg.dayIndexOf : ms => idxOfDate(new Date(ms));
  const toDate = typeof cfg.dateOfDayIndex === 'function' ? cfg.dateOfDayIndex : dateOfIdx;
  const accentOf = () => {
    if (typeof cfg.accent === 'function') { const a = cfg.accent(); if (a) return a; }
    const r = doc.documentElement;
    const v = r && r.style && typeof r.style.getPropertyValue === 'function'
      ? r.style.getPropertyValue('--accent').trim() : '';
    return v || '#D9A441';
  };
  const dpr = () => clamp(Math.round(((typeof window !== 'undefined' && window.devicePixelRatio) || 1) * 2) / 2, 1, 3);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now());
  // ONE clock. town.js hands update() its own performance.now(); a card opened
  // between two polls (a keypress, a turnover) must time out against the same
  // reading, or its hold is measured against a different epoch of the wall clock.
  let lastNow = 0;
  const wall = () => (lastNow > 0 ? Math.max(lastNow, nowMs()) : nowMs());
  const hm = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };

  /* ── the sheet ── */
  if (!doc.getElementById('almanacBaseCss')) {
    const st = doc.createElement('style');
    st.id = 'almanacBaseCss'; st.textContent = CSS;
    const h = doc.head || doc.documentElement;
    h.insertBefore(st, h.firstChild);
  }

  /* ── the strip ── */
  const header = cfg.header || doc.querySelector('header');
  const strip = doc.createElement('span');
  strip.className = 'alm-strip'; strip.id = 'chronStrip';
  const cells = [];
  if (header) {
    for (let i = 0; i < N; i++) {
      const c = doc.createElement('canvas');
      c.width = 26; c.height = 14; c.__almIdx = 0;
      strip.appendChild(c); cells.push(c);
    }
    const anchor = cfg.anchor || doc.getElementById('palDots');
    if (anchor && anchor.parentNode === header) header.insertBefore(strip, anchor.nextSibling);
    else header.appendChild(strip);
  }

  /* ── the card ── */
  const stage = cfg.overlay || doc.getElementById('overlay') || cfg.stage
    || doc.getElementById('stage') || doc.body;
  const card = doc.createElement('div');
  card.className = 'alm-card';
  card.style.display = 'none';
  const art = doc.createElement('canvas');
  art.width = 300; art.height = 72; art.className = 'alm-art';
  if (stage) stage.appendChild(card);

  /* ── state ── */
  let view = null, byIdx = new Map(), order = [];
  let ready = false, dirty = true, sig = '', lastDpr = 0;
  let cardIdx = null, cardOn = false, pinned = false, holdUntil = 0, byHover = false;
  // What the live chrome is counting, when that is not a calendar day. Empty when
  // the two agree, because a scope line nobody needs is noise.
  let scopeNote = '';
  let hoverIdx = null, hoverAt = 0, pollAt = -1e9, repaintAt = -1e9;
  let painterOk = !!paint, forcedDone = false, dead = false;
  let outTimer = 0;

  /* ═══ the model ═════════════════════════════════════════════ */

  /** A Day, filled out from whatever the chronicle chose to send. */
  function norm(d) {
    if (!d || typeof d.idx !== 'number') return null;
    const tok = Math.max(0, +d.tok || 0);
    const seed = (d.seed || fnv1a('today:' + d.idx)) >>> 0;   // the feed's identity string
    const n = typeof d.n === 'number' ? d.n : townSize(tok);
    const kind = d.kind || '';
    return {
      idx: d.idx, tok, seed, n, kind, live: !!d.live,
      kindLabel: d.kindLabel || KIND_PHRASE[kind] || '',
      name: d.name || '', date: d.ms ? new Date(d.ms) : toDate(d.idx),
      label: d.label || '', longLabel: d.longLabel || ''
    };
  }
  const dayOf = idx => byIdx.get(idx) || null;
  const shortLabel = d => d.label || d.date.toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
  const longLabel = d => d.longLabel || d.date.toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  /** The 14 calendar days ending at today — walked as DATES, because day indexes
   *  are year*400-based and are NOT contiguous across a new year. */
  function rebuildOrder() {
    order.length = 0;
    const base = (view && view.todayDate) || new Date();
    const y = base.getFullYear(), m = base.getMonth(), dd = base.getDate();
    for (let k = N - 1; k >= 0; k--) {
      const d = new Date(y, m, dd - k);
      order.push({ idx: toIdx(d.getTime()), date: d, first: d.getDate() === 1 });
    }
  }

  /** Accepts a chronicle snapshot OR the live Chronicle — both expose
   *  {ready, days, today, prefs}. Cheap and idempotent: a signature guard means
   *  the 500 ms stats tick can call this every time it fires. */
  function setView(v) {
    if (dead) return;
    view = null; byIdx.clear();
    const days = v && Array.isArray(v.days) ? v.days : null;
    const on = !!(v && days && days.length && v.ready !== false);
    if (!on) { ready = false; dirty = true; return; }
    let today = norm(v.today) || null, newest = null;
    for (const raw of days) {
      const d = norm(raw);
      if (!d) continue;
      byIdx.set(d.idx, d);
      if (!newest || d.idx > newest.idx) newest = d;
    }
    if (today) byIdx.set(today.idx, today);
    // A chronicle that omits today because today is still quiet must NOT slide the
    // strip's right edge back to yesterday: a quiet today is a meadow at the end of
    // the band, never an absence. The stand-in stays OUT of byIdx, so "quiet days
    // are omitted" and the day-one test both keep meaning what they say.
    if (!today) {
      const real = new Date();
      const d = newest && newest.date > real ? newest.date : real;
      today = norm({ idx: toIdx(d.getTime()), tok: 0, ms: d.getTime(), live: true });
    }
    const prefs = v.prefs || {};
    view = { today, newest, prefs, todayDate: today.date, stripOn: prefs.strip !== false };
    ready = byIdx.size > 0;
    // Repaint only when something visible actually moved: the day set, today's
    // township size (not every token — a 14 px silhouette cannot show 0.3 %),
    // or the accent.
    const s = (v.rev | 0) + '|' + byIdx.size + '|' + (newest ? newest.idx : 0)
      + '|' + today.idx + '|' + today.n + '|' + (view.stripOn ? 1 : 0) + '|' + accentOf();
    if (s !== sig) { sig = s; dirty = true; }
  }

  /* ═══ painting ══════════════════════════════════════════════ */

  function ctxOf(cv, w, h) {
    const k = dpr();
    if (cv.width !== Math.round(w * k) || cv.height !== Math.round(h * k)) {
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    }
    const g = cv.getContext && cv.getContext('2d');
    if (!g) return null;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, w, h);
    return g;
  }
  /** A quiet day. Three tufts and a tree on a grass line — the same visual weight
   *  as a town, because absence is not damage. */
  function meadow(g, w, h, seed, ink) {
    const base = h * .92;
    g.fillStyle = ink;
    g.fillRect(0, base, w, Math.max(1, h * .045));
    const tufts = Math.max(3, Math.round(w / 9));
    for (let i = 0; i < tufts; i++) {
      const r = (Math.sin((seed + i * 37.7) * 12.9898) * 43758.5453) % 1;
      const x = ((r < 0 ? -r : r) * .94 + .03) * w, t = h * (.10 + .07 * ((i % 3) / 2));
      g.fillRect(x, base - t, Math.max(1, w * .006), t);
    }
    const tx = w * .74, tr = h * .13;
    g.fillRect(tx - Math.max(.5, w * .004), base - tr * 1.6, Math.max(1, w * .008), tr * 1.6);
    g.beginPath(); g.arc(tx, base - tr * 1.9, tr, 0, Math.PI * 2); g.fill();
  }
  /** One day, one rectangle of canvas. Cheap mode always — high fidelity costs a
   *  buildPlan and belongs to the horizon ghost, not to a 26 px thumbnail.
   *  Quiet days go through the SAME painter, so a meadow here and a meadow on the
   *  ghost are the same drawing. `w`/`h` are passed explicitly because the context
   *  carries a DPR transform: the painter would otherwise size itself from the
   *  backing store and draw at 2× into a 26 px cell. */
  function paintDay(g, w, h, d, ink, grass) {
    const quiet = !d || d.tok <= 0 || d.n <= 0;
    if (!painterOk) { meadow(g, w, h, d ? d.idx : 0, quiet ? grass : ink); return; }
    const r = quiet ? null : rungsFor(d.tok);
    try {
      const drew = paint(g, quiet
        ? { seed: d ? d.seed : 0, n: 0, tier: 0, marks: 0, tok: 0, quiet: true, plan: null }
        : { seed: d.seed, n: d.n, tier: r.tier, marks: r.marks, tok: d.tok, quiet: false, plan: null },
        { ink: quiet ? grass : ink, baseline: .92, jitter: 1, w, h });
      // A town that drew nothing (an unusable spec) still gets a horizon line.
      if (!drew && !quiet) meadow(g, w, h, d.idx, grass);
    } catch (e) {
      // One painter for four consumers; if it cannot draw, the strip stays green
      // rather than empty, and it never tries again this session.
      painterOk = false; meadow(g, w, h, d ? d.idx : 0, quiet ? grass : ink);
    }
  }

  function repaintStrip() {
    lastDpr = dpr();
    if (!cells.length) return;
    const show = !!(view && view.stripOn) && ready;
    strip.style.display = show ? '' : 'none';
    if (!show) return;
    rebuildOrder();
    const acc = accentOf(), todayIdx = view.today ? view.today.idx : -1;
    for (let i = 0; i < cells.length; i++) {
      const cv = cells[i], o = order[i], d = dayOf(o.idx);
      cv.__almIdx = o.idx;
      const isToday = o.idx === todayIdx;
      cv.className = isToday ? 'alm-today' : '';
      const g = ctxOf(cv, 26, 14);
      if (g) {
        paintDay(g, 26, 14, d, isToday ? acc : STRIP_INK, isToday ? acc : STRIP_GRASS);
        // a hairline where a month begins — fourteen days is long enough to cross one
        if (o.first && i > 0) { g.fillStyle = 'rgba(255,255,255,.20)'; g.fillRect(0, 1, 1, 12); }
      }
      cv.title = tipLine(d, o.date, isToday);
    }
  }
  function tipLine(d, date, isToday) {
    const when = isToday ? 'today' : (d ? shortLabel(d)
      : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
    if (!d || d.tok <= 0) return when + SEP + 'a restful day';
    return when + (d.name ? SEP + d.name : '') + SEP + fmtTok(d.tok) + ' tokens';
  }

  /* ═══ the card ══════════════════════════════════════════════ */

  /** A day the chronicle omitted is a QUIET day, not a missing one — as long as it
   *  is a day this almanac covers (inside the last 400, never the future). It gets
   *  a page of its own, at the same weight as a town. */
  function quietOf(idx) {
    const t = view && (view.today || view.newest);
    if (!t) return null;
    const d = toDate(idx);
    if (!d || isNaN(d.getTime())) return null;
    const back = Math.round((new Date(t.date.getFullYear(), t.date.getMonth(), t.date.getDate())
      - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY_MS);
    if (back < 0 || back > 400) return null;
    return norm({ idx, tok: 0, ms: d.getTime() });
  }
  /** The day's story, from the chronicle's own summary where it has one and from
   *  the Day itself where it does not. Every field is optional and a row that has
   *  no fact is simply not printed — the card never guesses. */
  function storyOf(idx) {
    const d = dayOf(idx);
    let s = null;
    if (chron && typeof chron.summaryFor === 'function') {
      try { s = chron.summaryFor(idx) || null; } catch (e) { s = null; }
    }
    const base = d || norm(s) || quietOf(idx);
    if (!base) return null;
    const g = (k, alt) => (s && s[k] !== undefined && s[k] !== null && s[k] !== '' ? s[k] : alt);
    // `detail` is the feed's own `today` block, forwarded verbatim by the
    // chronicle — and it exists for TODAY only. Every row it feeds is optional.
    const det = (s && s.detail) || null;
    const gd = (k, alt) => (det && det[k] !== undefined && det[k] !== null ? det[k] : alt);
    const tok = Math.max(base.tok, +g('tok', 0) || 0);
    const r = rungsFor(tok);
    let peak = g('peakHour', gd('peakHour', null));
    if (peak === null) {
      const hrs = det && Array.isArray(det.hours) ? det.hours : (s && Array.isArray(s.hours) ? s.hours : null);
      // ONLY the 24 hourly buckets. `peakBucket` was read here as a fallback and
      // it is not an hour at all — it is the biggest single five-minute bucket's
      // TOKEN COUNT, so any day without `hours` printed "busiest hour 23:00" (or
      // 00:00 on a day that had not started yet) with complete confidence.
      if (hrs && hrs.length === 24) { let b = 0; for (let i = 1; i < 24; i++) if (hrs[i] > hrs[b]) b = i; if (hrs[b] > 0) peak = b; }
    }
    // A CLOCK ROW MUST BE ON ITS OWN DAY. `detail` is only ever today's, but a
    // stale or foreign stamp printed as "first light 00:00" — a broken clock,
    // not a fact — so anything outside this page's calendar day is dropped, and
    // a first token that really did land on the stroke of midnight says so in
    // words instead of leaving the reader to decide whether the app is lying.
    const day0 = new Date(base.date.getFullYear(), base.date.getMonth(), base.date.getDate()).getTime();
    const onDay = ms => (ms >= day0 && ms < day0 + DAY_MS ? ms : 0);
    const firstMs = onDay(+gd('firstMs', g('firstMs', 0)) || 0);
    return {
      idx: base.idx, tok, live: base.live || !!g('live', false),
      quiet: s && s.quiet !== undefined ? !!s.quiet : !(tok > 0),
      name: g('name', base.name), kindLabel: g('kindLabel', base.kindLabel),
      seed: base.seed, seedHex: String(g('seedHex', base.seed.toString(16).toUpperCase().slice(-4))),
      n: Math.max(0, +g('n', base.n) || 0), midnight: firstMs > 0 && firstMs - day0 < 3e5,
      // the chronicle calls the milestone count `miles`
      milestones: Math.max(0, +g('miles', g('milestones', r.miles)) || 0),
      tier: r.tier, marks: r.marks, spell: Math.max(0, +g('spell', 0) || 0),
      breaks: Math.max(0, +gd('breaks', g('breaks', 0)) || 0),
      grandest: String(g('grandest', gd('grandest', '')) || ''),
      firstMs,
      lastMs: onDay(+gd('lastMs', g('lastMs', 0)) || 0),
      peak: peak === null ? -1 : clamp(peak | 0, 0, 23),
      date: base.date, label: shortLabel(base), longLabel: longLabel(base)
    };
  }

  function paintCard(s) {
    const quiet = s.quiet;
    // A day always has a date; it has a NAME only once the chronicle can name the
    // town that stood on it. Never print the same fact twice on one page.
    let title, sub;
    if (quiet) { title = 'a restful day'; sub = s.longLabel; }
    else if (s.name) { title = s.name; sub = s.longLabel; }
    else { title = s.longLabel; sub = s.kindLabel || ''; }
    const rows = [];
    if (!quiet) {
      if (s.n > 0) rows.push(`<b>${s.n}</b> building${s.n === 1 ? '' : 's'}`
        + (s.milestones > 0 ? SEP + `<b>${s.milestones}</b> milestone${s.milestones === 1 ? '' : 's'}` : ''));
      const idline = [];
      if (s.kindLabel) idline.push(esc(s.kindLabel));
      idline.push('seed ' + esc(s.seedHex));
      rows.push(idline.join(SEP));
      const clock = [];
      if (s.midnight) clock.push('first light <b>at midnight</b>');
      else if (s.firstMs > 0) clock.push('first light <b>' + hm(s.firstMs) + '</b>');
      if (!s.live && s.lastMs > 0) clock.push('last light <b>' + hm(s.lastMs) + '</b>');
      if (s.peak >= 0) clock.push('busiest hour <b>' + pad2(s.peak) + ':00</b>');
      if (clock.length) rows.push(clock.join(SEP));
      const tail = [];
      if (s.breaks > 0) tail.push(`<b>${s.breaks}</b> break${s.breaks === 1 ? '' : 's'} in the orchard`);
      if (s.grandest) tail.push('grandest <b>' + esc(s.grandest) + '</b>');
      if (tail.length) rows.push(tail.join(SEP));
      // R3: a spell is a thing gained. Three days before it is worth a line, and
      // there is no copy anywhere in this file for one ending.
      if (s.spell >= 3 && view.prefs.showStreaks !== false)
        rows.push(`day <b>${s.spell}</b> of an unbroken spell`);
    }
    // day one is a promise, not a deficiency (§8.8) — and it outranks every other
    // footer line, including today's.
    const foot = byIdx.size <= 1 ? 'the chronicle begins today'
      : quiet ? 'entered in the almanac as restful'
        : s.live ? 'the page is still being written' : 'kept in the chronicle';

    card.innerHTML =
      `<div class="alm-rule"></div>` +
      `<div class="alm-nm">${esc(String(title).toUpperCase())}</div>` +
      (sub ? `<div class="alm-sub">${esc(sub)}</div>` : '') +
      `<div class="alm-rule"></div>`;
    card.appendChild(art);
    const tokLine = doc.createElement('div');
    tokLine.className = 'alm-tok';
    tokLine.innerHTML = quiet ? `<i>a quiet field, and the orchards kept the ledger</i>`
      : `${esc(fmtTok(s.tok))}<i> tokens</i>`;
    card.appendChild(tokLine);
    // SAY WHAT IS BEING COUNTED. This card is always a whole calendar DAY, and the
    // footer beside it is usually a session or a rolling window — so the two
    // disagreed about the token count AND the building count for the same date,
    // with nothing on the page to explain why. The card's only temporal cue was
    // the date, which reads as 'this is today'. One line closes it.
    if (!quiet && scopeNote) {
      const sc = doc.createElement('div');
      sc.className = 'alm-scope'; sc.textContent = scopeNote;
      card.appendChild(sc);
    }
    for (const r of rows) {
      const el = doc.createElement('div');
      el.className = 'alm-row'; el.innerHTML = r;
      card.appendChild(el);
    }
    const r2 = doc.createElement('div'); r2.className = 'alm-rule'; card.appendChild(r2);
    const ft = doc.createElement('div'); ft.className = 'alm-foot'; ft.textContent = foot;
    card.appendChild(ft);

    const g = ctxOf(art, 300, 72);
    if (g) paintDay(g, 300, 72, { idx: s.idx, tok: s.tok, n: s.n, seed: s.seed },
      CARD_INK, CARD_GRASS);
  }

  const photoOn = () => !!(doc.body && doc.body.classList && doc.body.classList.contains('photo'));

  function showCard(idx, opts) {
    if (dead || !ready || !stage) return false;
    if (photoOn() || !canShow()) return false;
    let want = idx;
    if (want === null || want === undefined || want === -1) {
      const t = view.today || view.newest;
      if (!t) return false;
      want = t.idx;
    }
    const s = storyOf(want);
    if (!s) return false;
    paintCard(s);
    cardIdx = want; cardOn = true;
    pinned = !!(opts && opts.pin);
    byHover = !!(opts && opts.hover);
    const hold = opts && typeof opts.hold === 'number' ? opts.hold : 7000;
    holdUntil = pinned ? Infinity : wall() + Math.max(1200, hold);
    if (outTimer) { clearTimeout(outTimer); outTimer = 0; }
    card.classList.remove('alm-out', 'alm-in');
    card.style.display = '';
    void card.offsetWidth;                 // restart the entrance from its first frame
    card.classList.add('alm-in');
    return true;
  }
  /** The visual exit is the stylesheet's; this timer is only the DOM cleanup
   *  behind it, because at ~1 fps a JS-driven fade would never run. */
  function hide() {
    if (!cardOn) return;
    cardOn = false; pinned = false; byHover = false; holdUntil = 0; hoverIdx = null;
    card.classList.remove('alm-in');
    card.classList.add('alm-out');
    if (outTimer) clearTimeout(outTimer);
    outTimer = setTimeout(() => { card.style.display = 'none'; outTimer = 0; }, 240);
  }

  /* ═══ hover / click on the strip ════════════════════════════ */
  const HOVER_MS = 320;                    // intent, not a twitch
  function onOver(e) {
    const t = e && e.target;
    if (!t || t.__almIdx === undefined) return;
    hoverIdx = t.__almIdx; hoverAt = wall();
  }
  function onOut(e) {
    const to = e && e.relatedTarget;
    if (to && to.__almIdx !== undefined) return;
    hoverIdx = null;
    // only take back what the pointer put up: a turnover card or a pinned one
    // outlives a cursor crossing the strip on its way somewhere else.
    if (cardOn && byHover && !pinned) hide();
  }
  function onClick(e) {
    const t = e && e.target;
    if (!t || t.__almIdx === undefined) return;
    if (cardOn && pinned && cardIdx === t.__almIdx) { hide(); return; }
    showCard(t.__almIdx, { pin: true });
  }
  if (cells.length) {
    strip.addEventListener('mouseover', onOver);
    strip.addEventListener('mouseout', onOut);
    strip.addEventListener('click', onClick);
  }

  /* ═══ the wall clock ════════════════════════════════════════ */
  /** Existence is wall-clock: at 1 fps a headless capture must still find the
   *  strip painted and a forced card finished. Nothing here is dt-paced. */
  function update(now) {
    if (dead) return;
    const t = typeof now === 'number' ? now : nowMs();
    if (t - pollAt < 180) return;
    pollAt = t; lastNow = t;
    if (photoOn()) { if (cardOn) hide(); return; }
    if ((dirty || dpr() !== lastDpr) && t - repaintAt > 400) {
      dirty = false; repaintAt = t; repaintStrip();
    }
    // the verification flag latches ONCE: a re-show loop against the chrome
    // arbiter would flicker the card at 5 Hz for the whole run.
    if (forceIdx !== null && !forcedDone && ready) {
      forcedDone = showCard(forceIdx === -1 ? null : forceIdx, { pin: true });
    }
    if (hoverIdx !== null && !cardOn && t - hoverAt > HOVER_MS)
      showCard(hoverIdx, { hold: 9000, hover: true });
    if (cardOn && !pinned && t > holdUntil) hide();
    if (cardOn && !canShow()) hide();
  }

  function reset() {
    if (dead) return;
    hide();
    sig = ''; dirty = true;               // a new epoch can mean a new accent
  }

  function dispose() {
    if (dead) return;
    dead = true;
    if (outTimer) { clearTimeout(outTimer); outTimer = 0; }
    if (cells.length) {
      strip.removeEventListener('mouseover', onOver);
      strip.removeEventListener('mouseout', onOut);
      strip.removeEventListener('click', onClick);
    }
    for (const c of cells) { c.width = c.height = 0; }
    cells.length = 0;
    art.width = art.height = 0;
    if (strip.parentNode) strip.parentNode.removeChild(strip);
    if (card.parentNode) card.parentNode.removeChild(card);
    card.innerHTML = '';
    byIdx.clear(); order.length = 0; view = null; ready = false;
  }

  return {
    setView, showCard, hide, update, reset, dispose,
    /** town.js: the live range's short label, or '' when the range IS the day. */
    setScope(note) {
      const v = String(note || '');
      if (v === scopeNote) return;
      scopeNote = v;
      if (cardOn && cardIdx != null) { const st = storyOf(cardIdx); if (st) paintCard(st); }
    },
    get visible() { return cardOn; },
    // interact.js's 'A' key toggles, and Esc closes a pinned card before it
    // touches the selection — both need to know which state we are in.
    get pinned() { return pinned; },
    get ready() { return ready; }
  };
}
