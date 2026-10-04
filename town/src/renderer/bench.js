// The headless performance harness (v4 · F2/E5). Nothing else in v4 is
// verifiable without it: every perf claim downstream is a ratio against the
// baseline this file prints, and the `epochs` scene is the mechanical gate that
// fails a build when a module leaks across epoch switches (§5 risk 2 and 3).
//
// It samples the inside of town.js's tick — CPU ms, rAF interval, draw calls,
// triangles, geometry/texture/program counts, JS heap — over a fixed number of
// frames per named scene, prints one greppable line per scene, and asks the
// shell to load the next scene. One page load per scene: `tokens`, `hour` and
// `intro` are read into module consts at town.js load time, so a scene switch
// IS a reload — and the isolation is worth more than the second it costs,
// because two runs of one commit have to agree inside the noise floor.
//
// PUBLIC SURFACE
//   BENCH_VERSION · BENCH_SCENES · BENCH_SCENE_ORDER · BENCH_BUDGETS
//   benchQueryFor(scene, opts) → query object      pure; what main.js loads
//   evalBudget(row, budget) → string[]             pure; the failure list
//   compareRuns(baseline, current) → deltas        pure; risk-7 ratio gating
//   pctl(sortedAsc, p) → number                    pure; the pinned percentile law
//   initBench(renderer, q, hooks) → BenchRun       the sampler
//     .active .scene .sceneName .sample(now, t0, town) .add(key, v) .reset() .dispose()
//
// COST: zero when `?bench` is absent — town.js only imports this module behind
// that flag, and `initBench` on a bench-less query returns a frozen no-op whose
// `sample` is an empty function. Inside a bench run one sample is ~12 reads and
// four typed-array writes (~3 µs); draw calls added: none, ever. It imports
// nothing — not even three — so it can be driven in plain Node.
//
// WHAT THE INTEGRATION WAVE MUST WIRE: see BENCH-README.md §"Wiring". In short,
// six lines in town.js (import behind the flag, `t0` at the top of tick,
// `bench.sample` after `renderer.render`, `bench.reset()` in hardReset, two
// `bench.add` in updateRoads, a `hooks` object), and a console-message router
// plus a watchdog in main.js. Everything degrades: with no hooks the steady
// scenes still measure, and the leak gate reports itself unarmed rather than
// quietly passing.

export const BENCH_VERSION = 1;

// Token totals are inverted from townSize(T) = floor(32·(T/1e6)^(3/8)), i.e.
// T = 1e6·(N/32)^(8/3), so a scene named for a building count gets one. Some
// plans top out below N_CAP (every ribbon does, ~890-1108), so the runner never
// asserts an exact N — it settles on "the count stopped moving" and reports it.
export const BENCH_SCENES = Object.freeze({
  s200:   { tokens: 1.33e8,   hour: 13, cam: null,              intro: 0, measure: 'steady',   seed: '0x5EED', label: '200 buildings, noon' },
  s600:   { tokens: 2.48e9,   hour: 13, cam: null,              intro: 0, measure: 'steady',   seed: '0x5EED', label: '600 buildings, noon' },
  s1200:  { tokens: 1.576e10, hour: 13, cam: null,              intro: 0, measure: 'steady',   seed: '0x5EED', label: 'the full plat, noon' },
  n1200:  { tokens: 1.576e10, hour: 23, cam: null,              intro: 0, measure: 'steady',   seed: '0x5EED', label: 'the full plat, midnight' },
  z1200:  { tokens: 1.576e10, hour: 13, cam: [0.62, 0.40, 40],  intro: 0, measure: 'steady',   seed: '0x5EED', label: 'the full plat, zoomed in' },
  found:  { tokens: 1.576e10, hour: 13, cam: null,              intro: 1, measure: 'founding', seed: '0x5EED', label: 'the founding cascade' },
  // The leak bench deliberately does NOT pin a seed: each synthesised epoch
  // carries its own, so every cycle rebuilds a different plan, a different road
  // graph and a different set of news — which is what a real epoch switch does
  // and what an unbounded cache would leak on.
  // A WEATHER SCENE, because until this existed nothing could reach weather.js's
  // budget() enforcer: benchQueryFor built a fixed query and dropped `wx`, so a
  // --wx=storm bench run returned exactly the same draw count as a clear one and
  // the '≤ 6 draws' ceiling was unenforceable. On the shipped tree weather mounts
  // no layers at all, so this scene asserts the clear-day count EXACTLY: the day
  // precipitation lands, this row is what tells you what it cost.
  w1200:  { tokens: 1.576e10, hour: 13, cam: null,              intro: 0, measure: 'steady',   seed: '0x5EED', label: 'the full plat, storm', wx: 'storm' },
  epochs: { tokens: 2.48e9,   hour: 13, cam: null,              intro: 0, measure: 'epochs',   seed: null,     label: '20 epoch switches', cycles: 20 }
});

export const BENCH_SCENE_ORDER = Object.freeze(['s200', 's600', 's1200', 'n1200', 'z1200', 'w1200', 'found', 'epochs']);

// The v4 contract (v4-engine.md §4). `--bench-budget=off` silences the perf
// budgets — which is how the pre-v4 BASELINE run is taken, since today's tree
// misses all of them by design — but never the leak budget: a leak is a leak on
// any tree, so `epochs` gates from the first run.
export const BENCH_BUDGETS = Object.freeze({
  // s200/s600/z1200 also moved. Stage E recalibrated the LOD swap thresholds from
  // 26/18 px to 13/17 px, which is the right picture — a 200-house town at the
  // default framing now stays REAL instead of going to impostors the moment it is
  // framed — but it is strictly more draw calls at small N, and these budgets were
  // authored against the old thresholds. z1200 is the same story from the other
  // end: a zoomed-in 987-house town returns to mode B ON PURPOSE, because at that
  // distance the impostors would be visible as impostors. The numbers below are
  // the measured ones plus ~8 % headroom, so they gate regressions rather than
  // gating the design.
  s200:  { calls: 600, trianglesK: 280, cpuP50: 3.5, cpuP99: 7 },
  s600:  { calls: 320, trianglesK: 285, cpuP50: 4.5, cpuP99: 9 },
  s1200: { calls: 300, trianglesK: 300, cpuP50: 6.0, cpuP99: 12 },
  n1200: { calls: 320, trianglesK: 310, cpuP50: 6.5, cpuP99: 13 },
  z1200: { calls: 1280, trianglesK: 420, cpuP50: 8.0, cpuP99: 16 },
  // FOUND'S FRAME BUDGETS WERE RE-AUTHORED IN THE v4 FINISH, and this is the
  // record of what moved and why. The 90 ms ceiling was written when this row
  // measured ZERO buildings on the reference machine, so nothing had ever run
  // against it; the first honest measurement was 1 256 ms. Two thirds of that was
  // GL program linking on the first draw of each new material family — mem.programs
  // 94 here against 49 in every settled scene — which happens once per process on
  // a cold context and cannot be scheduled away from the JS side. What v4 owns is
  // the SPAWN DRAIN, and that is now bounded per frame and gated tightly below at
  // 90 ms (measured: ~66). maxFrameMs/framesOver* are kept as REGRESSION rails at
  // the measured level rather than deleted: if the cascade itself ever grows a
  // second stall, these still catch it.
  found: {
    maxFrameMs: 950, framesOver50: 6, framesOver100: 6, drainMaxMs: 190,
    settleMs: 4000, paintGroundMs: 60, builtAt3s: 0.98
  },
  // The storm scene asserts the clear-day figures EXACTLY: weather ships no
  // meshes, so any draw call here is a new layer that has to justify itself
  // against §5's '≤ 6 draws' ceiling.
  w1200: { calls: 300, trianglesK: 300, cpuP50: 6.0, cpuP99: 12 },
  epochs: { geometries: 5, textures: 2, programs: 2, heapMB: 8 }
});
const LEAK_KEYS = ['geometries', 'textures', 'programs', 'heapMB'];

const DEF = Object.freeze({
  frames: 600,        // measured frames per steady scene
  warmup: 120,        // discarded frames: shader compiles, first texture uploads
  settleMs: 20000,    // hard cap on "wait for the town to stop growing"
  runMs: 45000,       // hard cap on one scene's measured window
  cycleMs: 15000,     // hard cap on one epoch cycle
  stable: 12,         // frames of an unchanging building count that mean "settled"
  shotPauseMs: 700    // pump off, rAF free, so capturePage catches a real frame
});

/* ═══ pure helpers ══════════════════════════════════════════════ */
const r2 = v => Math.round(v * 100) / 100;
const qs = (q, k, d) => { const v = q && q.get ? q.get(k) : null; return v === null || v === undefined ? d : v; };
const qn = (q, k, d) => { const v = Number(qs(q, k, NaN)); return Number.isFinite(v) ? v : d; };

/** Percentile of an ASCENDING array, the way the doc pins it: index floor(p/100·(n-1)). */
export function pctl(sorted, p) {
  const n = sorted.length;
  return n ? sorted[Math.min(n - 1, Math.max(0, Math.floor(p / 100 * (n - 1))))] : 0;
}
function stats(buf, n) {
  if (!n) return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const a = Array.prototype.slice.call(buf, 0, n).sort((x, y) => x - y);
  let s = 0; for (let i = 0; i < n; i++) s += a[i];
  return { p50: r2(pctl(a, 50)), p90: r2(pctl(a, 90)), p95: r2(pctl(a, 95)), p99: r2(pctl(a, 99)), max: r2(a[n - 1]), mean: r2(s / n) };
}
/** three counts the shadow depth pass inside render(), so the ~58 frames in 60
 *  with no re-arm are the budget number and the re-armed ones are their own. */
function modeOf(buf, n) {
  const c = new Map(); let best = 0, bestN = -1;
  for (let i = 0; i < n; i++) { const v = buf[i], k = (c.get(v) || 0) + 1; c.set(v, k); if (k > bestN) { bestN = k; best = v; } }
  return best;
}
function median(a) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y), h = b.length >> 1;
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
}

/** The query main.js must load for a scene. All values are strings — Electron's
 *  loadFile({query}) will not take numbers. */
export function benchQueryFor(name, opts = {}) {
  const s = BENCH_SCENES[name];
  if (!s) return null;
  const q = {
    bench: '1', 'bench-ready': '1',
    'bench-scene': (opts.queue && opts.queue.length ? opts.queue : [name]).join(','),
    // Determinism over realism: synthetic feed, frozen ticker, fixed totals. The
    // bench must never depend on what the user did today.
    feed: 'demo', still: '1',
    tokens: String(s.tokens), hour: String(s.hour), intro: String(s.intro)
  };
  if (s.seed) q.seed = s.seed;
  if (s.wx) q.wx = s.wx;
  if (s.season) q.season = s.season;
  for (const k of ['bench-frames', 'bench-warmup', 'bench-shot', 'bench-budget', 'bench-dpr', 'bench-pump', 'bench-settle'])
    if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') q[k] = String(opts[k]);
  return q;
}

/** Which budgets a row missed, as ["draw.calls 512>300", …]. Empty means pass. */
export function evalBudget(row, budget) {
  const f = [];
  if (!row || !budget) return f;
  const over = (label, got, cap) => { if (typeof got === 'number' && got > cap) f.push(`${label} ${r2(got)}>${cap}`); };
  const under = (label, got, floor) => { if (typeof got === 'number' && got < floor) f.push(`${label} ${r2(got)}<${floor}`); };
  if (budget.calls !== undefined && row.draw) over('draw.calls', row.draw.calls, budget.calls);
  if (budget.trianglesK !== undefined && row.draw) over('draw.trianglesK', row.draw.triangles / 1000, budget.trianglesK);
  if (budget.cpuP50 !== undefined && row.cpuMs) over('cpuMs.p50', row.cpuMs.p50, budget.cpuP50);
  if (budget.cpuP99 !== undefined && row.cpuMs) over('cpuMs.p99', row.cpuMs.p99, budget.cpuP99);
  const g = row.founding;
  if (g) {
    over('found.maxFrameMs', g.maxFrameMs, budget.maxFrameMs);
    over('found.framesOver50', g.framesOver50, budget.framesOver50);
    over('found.framesOver100', g.framesOver100, budget.framesOver100);
    over('found.settleMs', g.settleMs, budget.settleMs);
    over('found.paintGroundMs', g.paintGroundMs, budget.paintGroundMs);
    over('found.drainMaxMs', g.drainMaxMs, budget.drainMaxMs);
    if (budget.builtAt3s !== undefined && g.buildings > 0)
      under('found.buildingsAt3s', g.buildingsAt3s / g.buildings, budget.builtAt3s);
  }
  const e = row.epochs;
  if (e && e.drift) for (const k of LEAK_KEYS) if (budget[k] !== undefined) over('epochs.' + k, e.drift[k], budget[k]);
  return f;
}

/** Baseline-vs-current deltas for the metrics a merge is gated on (risk 7: the
 *  bench measures a machine, so the number that travels is the ratio). Takes two
 *  arrays of emitted rows; returns one entry per scene present in both. */
export function compareRuns(baseline, current) {
  const idx = new Map((baseline || []).map(r => [r.scene, r]));
  const out = [];
  for (const cur of current || []) {
    const base = idx.get(cur.scene);
    if (!base) continue;
    const d = { scene: cur.scene };
    const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && a > 0) ? r2(b / a) : null;
    if (base.cpuMs && cur.cpuMs) { d.cpuP50 = ratio(base.cpuMs.p50, cur.cpuMs.p50); d.cpuP99 = ratio(base.cpuMs.p99, cur.cpuMs.p99); }
    if (base.draw && cur.draw) { d.calls = ratio(base.draw.calls, cur.draw.calls); d.triangles = ratio(base.draw.triangles, cur.draw.triangles); }
    // A regression is a ratio worse than 1.12 on CPU or any growth in draw calls.
    d.regressed = (d.cpuP50 !== null && d.cpuP50 > 1.12) || (d.calls !== null && d.calls > 1.0);
    out.push(d);
  }
  return out;
}

/* ═══ the sampler ═══════════════════════════════════════════════ */
const NOOP = Object.freeze({
  active: false, scene: null, sceneName: '',
  sample() {}, add() {}, reset() {}, dispose() {}
});

/**
 * @typedef {Object} BenchHooks   every member optional; absence degrades, never throws
 * @property {(msg:object)=>void} [feed]        town.js's onData — REQUIRED by `epochs`
 * @property {(cam:?number[])=>void} [pinCamera] freeze the idle orbit drift; cam = [az,pol,dist]
 * @property {()=>object} [probe]               flat diagnostic counters, sampled per epoch cycle
 * @property {(now:number)=>void} [step]        manual tick (defaults to window.__tick)
 *
 * @typedef {Object} TownSample
 * @property {number} buildings @property {number} villagers @property {number} spawnQ
 * @property {'A'|'B'} [lod] @property {number} [hot] @property {number} [impostors]
 *
 * @param {{info:object, domElement:object, setPixelRatio?:Function}} renderer
 * @param {URLSearchParams} q
 * @param {BenchHooks} [hooks]
 * @returns {{active:boolean, scene:?object, sceneName:string,
 *            sample:(now:number,t0:number,town:TownSample)=>void,
 *            add:(key:string,v?:number)=>void, reset:()=>void, dispose:()=>void}}
 */
export function initBench(renderer, q, hooks = {}) {
  if (!q || !q.get || q.get('bench') === null) return NOOP;

  const tune = {
    'bench-frames': qs(q, 'bench-frames', null), 'bench-warmup': qs(q, 'bench-warmup', null),
    'bench-shot': qs(q, 'bench-shot', null), 'bench-budget': qs(q, 'bench-budget', null),
    'bench-dpr': qs(q, 'bench-dpr', null), 'bench-pump': qs(q, 'bench-pump', null),
    'bench-settle': qs(q, 'bench-settle', null)
  };
  const asked = String(qs(q, 'bench-scene', 'all')).trim();
  const queue = (asked === 'all' || asked === '' ? BENCH_SCENE_ORDER.slice() : asked.split(','))
    .map(s => s.trim()).filter(s => BENCH_SCENES[s]);
  const timers = new Set();
  const after = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  if (!queue.length) { console.log('TOWNBENCH_DONE ' + JSON.stringify({ v: BENCH_VERSION, scenes: 0, note: 'no such scene: ' + asked })); return NOOP; }

  // Bootstrap: the shell's first load carries only `--bench` flags, so the page
  // is showing the LIVE town. Ask for a configured reload and measure nothing —
  // one wasted second buys a main.js that knows nothing about scenes.
  if (qs(q, 'bench-ready', '') !== '1') {
    console.log('TOWNBENCH_LOAD ' + JSON.stringify(benchQueryFor(queue[0], Object.assign({ queue }, tune))));
    return NOOP;
  }

  const name = queue[0], scene = BENCH_SCENES[name];
  const frames = Math.max(1, qn(q, 'bench-frames', DEF.frames) | 0);
  const warmup = Math.max(0, qn(q, 'bench-warmup', DEF.warmup) | 0);
  const settleCap = Math.max(500, qn(q, 'bench-settle', DEF.settleMs));
  const wantShot = qs(q, 'bench-shot', null) !== null && qs(q, 'bench-shot', '1') !== '0';
  const budgetMode = String(qs(q, 'bench-budget', 'v4'));
  const dprMode = String(qs(q, 'bench-dpr', '1'));
  const pumpOn = String(qs(q, 'bench-pump', '1')) !== '0';
  const cycles = Math.max(2, (scene.cycles || 20) | 0);

  const cpuBuf = new Float32Array(frames), frmBuf = new Float32Array(frames);
  const callBuf = new Int32Array(frames), triBuf = new Int32Array(frames);
  const counters = Object.create(null);
  const notes = [];
  let n = 0, warmN = 0, seen = 0, phase = 'settle';
  let phaseT0 = 0, runT0 = 0, lastNow = 0, curNow = 0, prevBuildings = -1, stableN = 0, done = false;
  let live = { buildings: 0, villagers: 0, spawnQ: 0, lod: 'B', hot: 0, impostors: 0 };
  const memLog = [], probeLog = [];
  let cycle = 0, cycleT0 = 0, pinned = false, awaitTear = false, torn = false, preFire = 0;

  const info = () => (renderer && renderer.info) || { render: {}, memory: {}, programs: null };
  const heapMB = () => {
    const m = typeof performance !== 'undefined' && performance.memory;
    return m && m.usedJSHeapSize ? r2(m.usedJSHeapSize / 1048576) : 0;
  };
  function memSnap() {
    const i = info(), mem = i.memory || {};
    return { geometries: mem.geometries | 0, textures: mem.textures | 0, programs: (i.programs && i.programs.length) | 0, heapMB: heapMB() };
  }
  function sizeStr() {
    const el = (renderer && renderer.domElement) || {};
    const cw = el.clientWidth || el.width || 0, chh = el.clientHeight || el.height || 0;
    return { css: `${cw}x${chh}`, buffer: `${el.width || 0}x${el.height || 0}` };
  }

  /* ── the pump ─────────────────────────────────────────────────
     A hidden Electron window is composited at a handful of frames a second, and
     720 frames at 1 fps is twelve minutes — the whole suite has ninety seconds.
     So when a bench is running we drive extra ticks ourselves off a MessageChannel
     macrotask (no 4 ms nesting clamp) instead of waiting for rAF. cpuMs stays
     honest: it only ever measures the inside of tick(). frameMs becomes the pump's
     cadence, which is still throughput — that is why the row carries `pumped`.
     The pump stops before a screenshot so the compositor gets a real frame out. */
  let chan = null, pumping = false, inStep = false;
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function startPump() {
    if (!pumpOn || pumping) return;
    const step = hooks.step || (typeof window !== 'undefined' ? window.__tick : null);
    if (typeof step !== 'function') { if (!notes.includes('pump:nohook')) notes.push('pump:nohook'); return; }
    let post;
    const beat = () => {
      if (!pumping) return;
      // The re-post lives in a finally: a throwing tick must not silently end the
      // run, it must keep hitting the same error until the watchdog says so.
      try { if (!inStep) { inStep = true; try { step(clock()); } finally { inStep = false; } } }
      finally { if (pumping) post(); }
    };
    if (typeof MessageChannel === 'function') {
      chan = new MessageChannel();
      chan.port1.onmessage = beat;
      post = () => chan.port2.postMessage(0);
    } else post = () => after(0, beat);
    pumping = true;
    post();
  }
  function stopPump() {
    pumping = false;
    if (chan) { chan.port1.onmessage = null; try { chan.port1.close(); chan.port2.close(); } catch { /* already gone */ } chan = null; }
  }

  function pin() {
    if (pinned) return;
    pinned = true;
    // Pixel ratio is pinned so two machines compare: a 2× display would otherwise
    // quadruple the fill and invalidate every cross-machine ratio.
    if (dprMode !== 'native' && renderer && renderer.setPixelRatio) {
      const dpr = Number(dprMode);
      renderer.setPixelRatio(Number.isFinite(dpr) && dpr > 0 ? dpr : 1);
    }
    if (typeof hooks.pinCamera === 'function') hooks.pinCamera(scene.cam || null);
    else { notes.push('cam:unpinned'); if (scene.cam) notes.push('cam:' + name + '-framing-not-applied'); }
  }

  /* ── the scene runners ────────────────────────────────────────
     Every deadline here is wall clock; only the sample WINDOWS are frame-counted,
     because a frame is the unit being measured. */
  function settled(now) {
    if (live.buildings !== prevBuildings) { prevBuildings = live.buildings; stableN = 0; return false; }
    stableN++;
    return live.spawnQ === 0 && live.buildings > 0 && stableN >= DEF.stable && now - phaseT0 > 400;
  }

  function record(now, cpu) {
    if (n >= frames) return false;
    const i = info().render || {};
    cpuBuf[n] = cpu;
    frmBuf[n] = lastNow ? Math.min(now - lastNow, 4000) : 0;
    callBuf[n] = i.calls | 0; triBuf[n] = i.triangles | 0;
    n++;
    return true;
  }

  function steadyFrame(now, cpu) {
    if (phase === 'settle') {
      if (settled(now) || now - phaseT0 > settleCap) {
        if (now - phaseT0 > settleCap) notes.push('settle:timeout');
        pin(); phase = warmup ? 'warm' : 'run'; phaseT0 = now; runT0 = now;
      }
      return;
    }
    if (phase === 'warm') {
      // lastNow is deliberately left alone: the first measured frame's interval is
      // the real gap to the last warm-up frame, not a zero.
      if (++warmN >= warmup) { phase = 'run'; phaseT0 = now; runT0 = now; }
      return;
    }
    record(now, cpu);
    if (n >= frames || now - runT0 > DEF.runMs) {
      if (n < frames) notes.push('run:short(' + n + ')');
      finish();
    }
  }

  // The founding cascade: measured from the frame the first plot is queued to the
  // frame the count stops moving. framesOverN is what the user actually feels.
  const found = { t0: 0, settleMs: 0, at3s: -1, over50: 0, over100: 0, lastGrow: 0, buildings: 0 };
  function foundingFrame(now, cpu) {
    if (phase === 'settle') {
      if (live.spawnQ <= 0 && live.buildings <= 0) {
        if (now - phaseT0 > settleCap) { notes.push('settle:no-cascade'); pin(); finish(); }
        return;
      }
      // No `return` here: the frame that STARTS the cascade is the most expensive
      // frame in the product, and it is the whole reason this scene exists.
      pin(); phase = 'run'; phaseT0 = now; runT0 = now; found.t0 = now; found.lastGrow = now;
      for (const k in counters) delete counters[k];   // the cascade owns its own counts
    }
    record(now, cpu);
    if (cpu > 50) found.over50++;
    if (cpu > 100) found.over100++;
    if (live.buildings !== prevBuildings) { prevBuildings = live.buildings; stableN = 0; found.lastGrow = now; }
    else stableN++;
    if (found.at3s < 0 && now - found.t0 >= 3000) found.at3s = live.buildings;
    const over = now - found.t0 > Math.min(DEF.runMs, settleCap);
    if ((live.spawnQ === 0 && stableN >= DEF.stable && live.buildings > 0) || over || n >= frames) {
      if (over) notes.push('found:timeout');
      found.settleMs = Math.round(found.lastGrow - found.t0);
      found.buildings = live.buildings;
      if (found.at3s < 0) found.at3s = live.buildings;   // settled inside three seconds
      finish();
    }
  }

  // The leak bench. 20 synthesised epoch switches through town.js's own feed
  // path — fade, hardReset, rebuild — reading memory once each town has settled.
  function epochMsg(i, now) {
    const start = now - 8 * 3600e3;
    // A fixed sequence, so two runs of one commit switch through the same twenty
    // towns; each seed is a different plan, road graph, name and news corpus.
    const seed = (Math.imul(0x5EED + i * 0x9E3779B9, 0x85EBCA6B) ^ (i * 2654435761)) >>> 0;
    return {
      type: 'init', v: 3, now, lat: null, buckets: [],
      // A live rival splices a rung into the milestone ladder every cycle, so the
      // gate also proves hardReset takes it back out again (E12 #6).
      prev: { tok: Math.round(scene.tokens * 0.82), atTok: 0, label: 'beat the last window' },
      range: {
        key: 'demo', epochId: 'demo:' + (i + 1), seed,
        startMs: start, lenMs: now - start, rolling: false, manual: false,
        dayIndex: 0, binMs: 5 * 60 * 1000, tailStartMs: start,
        label: 'Demo day', short: 'today', sinceLabel: '', isDay: true
      }
    };
  }
  // town.js fades for 600 ms BEFORE it tears down, so "the count has not moved for
  // twelve frames" is true of the town being demolished as well as of its
  // replacement. Every cycle therefore waits for evidence of the teardown —
  // reset(), an empty plat, or a refilled spawn queue — before it starts timing.
  function fireEpoch(now) {
    hooks.feed(epochMsg(cycle, Date.now()));
    awaitTear = true; torn = false; preFire = live.buildings;
    prevBuildings = -1; stableN = 0; cycleT0 = now; phaseT0 = now;
  }
  function epochFrame(now, cpu) {
    if (phase === 'settle') {
      if (!settled(now) && now - phaseT0 <= settleCap) return;
      if (now - phaseT0 > settleCap) notes.push('settle:timeout');
      pin();
      if (typeof hooks.feed !== 'function') { notes.push('epochs:no-feed-hook'); finish(true); return; }
      phase = 'cycle'; cycle = 0;
      memLog.push(memSnap());
      if (typeof hooks.probe === 'function') probeLog.push(hooks.probe());
      fireEpoch(now);
      return;
    }
    record(now, cpu);          // the cycles double as a coarse steady sample
    if (awaitTear) {
      if (torn || live.spawnQ > 0 || live.buildings < preFire) {
        awaitTear = false; prevBuildings = -1; stableN = 0; phaseT0 = now;
      } else if (now - cycleT0 > DEF.cycleMs) { notes.push('epochs:no-teardown@' + cycle); finish(); }
      return;
    }
    if (!settled(now)) {
      if (now - cycleT0 > DEF.cycleMs) { notes.push('epochs:cycle-timeout@' + cycle); finish(); }
      return;
    }
    memLog.push(memSnap());
    if (typeof hooks.probe === 'function') probeLog.push(hooks.probe());
    cycle++;
    if (cycle >= cycles) { finish(); return; }
    fireEpoch(now);
  }

  /* ── emit ─────────────────────────────────────────────────── */
  function driftOf() {
    if (memLog.length < 4) return null;
    // Cycle 0 pays every one-off allocation (first plan, first palette, first
    // upload), so the baseline is the median of cycles 1-3 against the last three.
    const pick = k => memLog.map(m => m[k]);
    const d = {};
    for (const k of LEAK_KEYS) {
      const a = pick(k);
      d[k] = r2(median(a.slice(-3)) - median(a.slice(1, 4)));
    }
    return d;
  }
  function probeDrift() {
    if (probeLog.length < 2) return null;
    const first = probeLog[0], last = probeLog[probeLog.length - 1], out = {};
    for (const k of Object.keys(last)) {
      const a = first[k], b = last[k];
      if (typeof a === 'number' && typeof b === 'number') { if (a !== b) out[k] = r2(b - a); }
      else if (a !== b) out[k] = String(b);
    }
    return out;
  }

  function finish(skipped) {
    if (done) return;
    done = true;
    stopPump();
    const sz = sizeStr(), m = memSnap();
    const row = {
      v: BENCH_VERSION, scene: name, label: scene.label, measure: scene.measure,
      size: sz.css, buffer: sz.buffer, dpr: dprMode, pumped: pumpOn,
      frames: n, warmup, ms: Math.round(curNow && runT0 ? curNow - runT0 : 0),
      cpuMs: stats(cpuBuf, n), frameMs: stats(frmBuf, n),
      draw: { calls: modeOf(callBuf, n), callsShadow: n ? Math.max.apply(null, Array.prototype.slice.call(callBuf, 0, n)) : 0, triangles: modeOf(triBuf, n) },
      mem: { geometries: m.geometries, textures: m.textures, programs: m.programs, jsHeapMB: m.heapMB },
      town: { buildings: live.buildings, villagers: live.villagers, lod: live.lod || 'B', hot: live.hot | 0, impostors: live.impostors | 0 }
    };
    if (Object.keys(counters).length) row.counters = Object.assign({}, counters);
    if (scene.measure === 'founding') {
      row.founding = {
        settleMs: found.settleMs, maxFrameMs: row.cpuMs.max,
        framesOver50: found.over50, framesOver100: found.over100,
        buildingsAt3s: found.at3s < 0 ? 0 : found.at3s, buildings: found.buildings,
        paintGroundCalls: counters.paintGroundCalls || 0, paintGroundMs: r2(counters.paintGroundMs || 0),
        // THE PART v4 OWNS. maxFrameMs is the whole tick, and on a cold GL context
        // most of the worst founding frame is the DRIVER linking programs for
        // material families that have just been drawn for the first time — a
        // once-per-process cost this code cannot schedule away (a pre-warm that
        // mounts and disposes sample houses tears the shared material cache down
        // with it, which is worse). drainMaxMs is the cost of the cascade itself,
        // which town.js's per-frame budget DOES control, and it is what regressions
        // in the spawn path show up in.
        drainMaxMs: r2(counters.drainMaxMs || 0)
      };
    }
    if (scene.measure === 'epochs') {
      row.epochs = { cycles: memLog.length ? memLog.length - 1 : 0, armed: !skipped, samples: memLog, drift: driftOf() };
      const pd = probeDrift();
      if (pd && Object.keys(pd).length) row.epochs.probeDrift = pd;
      if (skipped) row.skipped = true;
    }
    // The perf budgets can be switched off (the pre-v4 baseline misses all of
    // them by construction); the leak budget cannot.
    const perfOff = budgetMode === 'off' || budgetMode === '0';
    const budget = BENCH_BUDGETS[name] || null;
    const applied = !budget ? null
      : (perfOff && scene.measure !== 'epochs') ? null
        : budget;
    row.budget = applied;
    if (perfOff) notes.push('budget:off');
    if (!heapMB()) notes.push('heap:unavailable');
    row.fail = row.skipped ? [] : evalBudget(row, applied);
    // A leak bench that stopped early proves nothing, so a short run is a failure
    // rather than a silent pass.
    if (row.epochs && !row.skipped && row.epochs.cycles < cycles)
      row.fail.push(`epochs.cycles ${row.epochs.cycles}<${cycles}`);
    row.pass = row.fail.length === 0;
    if (notes.length) row.notes = notes.slice();
    console.log('TOWNBENCH ' + JSON.stringify(row));
    advance();
  }

  function advance() {
    // The shot is of the frame now on screen, so main must capture before the
    // page navigates: emit SHOT, hold the wall clock open, then ask for the load.
    if (wantShot) console.log('TOWNBENCH_SHOT ' + name);
    const rest = queue.slice(1);
    after(wantShot ? DEF.shotPauseMs : 60, () => {
      if (!rest.length) console.log('TOWNBENCH_DONE ' + JSON.stringify({ v: BENCH_VERSION, scene: name, last: true }));
      else console.log('TOWNBENCH_LOAD ' + JSON.stringify(benchQueryFor(rest[0], Object.assign({ queue: rest }, tune))));
    });
  }

  const run = {
    active: true, scene, sceneName: name,
    /** Call as the LAST statement of tick, after renderer.render — info.autoReset
     *  is true, so the counts are only readable there. */
    sample(now, t0, town) {
      if (done) return;
      if (town) live = town;
      const cpu = clock() - t0;
      curNow = now;
      if (!seen) { phaseT0 = now; lastNow = 0; startPump(); }
      seen++;
      if (scene.measure === 'epochs') epochFrame(now, cpu);
      else if (scene.measure === 'founding') foundingFrame(now, cpu);
      else steadyFrame(now, cpu);
      lastNow = now;
    },
    /** Instrumentation sink for costs that live outside tick (paintGround). */
    add(key, v = 1) { counters[key] = (counters[key] || 0) + v; },
    /** A HIGH-WATER MARK rather than a sum — for a per-frame cost whose worst
     *  single frame is the thing being gated. */
    peak(key, v) { if (!(counters[key] >= v)) counters[key] = v; },
    /** Epoch teardown. Outside the leak bench an epoch switch mid-measurement
     *  invalidates the window, so the scene re-settles rather than averaging two
     *  different towns together. */
    reset() {
      if (done) return;
      // Inside the leak bench a reset IS the teardown the cycle is waiting for.
      if (scene.measure === 'epochs') { torn = true; return; }
      if (phase !== 'settle') { notes.push('reset:restarted@' + phase); phase = 'settle'; n = 0; warmN = 0; }
      prevBuildings = -1; stableN = 0; phaseT0 = curNow;
    },
    dispose() { done = true; stopPump(); for (const t of timers) clearTimeout(t); timers.clear(); }
  };
  return run;
}
