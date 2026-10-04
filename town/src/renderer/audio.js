// audio.js — the town, out loud. A procedural ambient soundscape: filtered noise
// beds, a slow oscillator pad, granular one-shots and a two-line feedback-delay
// room. Web Audio only — no files, no dependencies, no imports (not even THREE),
// which is also what makes it testable in plain Node against a stubbed context.
//
// THE TOWN IS AUDIBLE BY DEFAULT, and quiet the moment it is asked to be.
// The first cut of this module was silent by default AND refused to build a
// graph until a user gesture, which is a fine policy for a web page embedded in
// somebody else's tab and the wrong one for an app the user opened on purpose:
// a town you only watch never produces a gesture, so the sound never arrived
// and the toggle looked broken. What gates a sample now:
//   1. the run is not INERT (a --shot, a --bench, or any synthetic verification
//      flag — see INERT below). An inert run never constructs an AudioContext,
//      never mounts the chip, and its setEnabled(true) is a no-op that returns
//      false. A screenshot fleet is still silent by default;
//   2. the toggle is on — persisted in localStorage `tt.audio`, default ON. A
//      user who hushed the town STAYS hushed across runs; only the absence of
//      the key means "on";
//   3. the window is visible (a hidden/minimised window fades to zero);
//   4. the AudioContext reaches `running`. main.js lifts Chromium's autoplay
//      policy so `new AudioContext()` starts running at load with no gesture at
//      all. If that ever fails to take, resumeNow() keeps a pointerdown/keydown
//      listener armed and the first input brings the town up — belt and braces,
//      because a silent town with no explanation is the bug this replaced.
//
// LOCATION BASED, in two layers.
//   MASTER — one trim and one lowpass follow `rig.dist`. Close (26 u, a street)
//   is 1.00 gain and a 15 kHz cutoff; far (260 u, the whole valley) is 0.45 and
//   825 Hz. The cutoff is interpolated in LOG space, so descending into the town
//   opens the sound the way a lens opens, not in a jump. This is what pairs with
//   stroll mode: walking down there is audibly *inside* the town.
//   EMITTERS — the water, the market and the building site attenuate on their own
//   distance from the CAMERA FOCUS (what you are looking at, not where the camera
//   is parked), inverse-square-ish: att = r²/(r² + d²). One StereoPannerNode each,
//   panned by the dot of the emitter direction with the camera's right column.
//   That is three panners, not a PannerNode graph with an AudioListener — the
//   listener would have to be driven per frame and buys nothing over a scalar.
//
// NOTHING CLICKS. No AudioParam is ever assigned while sounding: every steady
// value moves by setTargetAtTime and every one-shot envelope is scheduled from 0
// to 0. The shared noise buffer is equal-power crossfaded across its own loop
// seam. NOTHING DRONES: the pad rotates its root through a pentatonic every ~52 s
// with a 6 s glide, two sub-0.1 Hz LFOs breathe the wind, and the market walks a
// random murmur multiplier. All of it is cross-faded on the audio clock, which is
// a wall clock — a 1 fps frame rate changes when a decision is MADE, never how
// long a fade takes.
//
// COST. Zero draw calls, zero THREE objects, zero per-frame allocation on the
// main thread. Steady state is 56 native nodes (6 looping buffer sources, 6
// oscillators, 14 biquads, 2 delay lines, 7 panners, 1 compressor, the rest
// gains) plus ≤ 12 transient voices, and ONE 4 s stereo pink-noise buffer, ~1.5 MB,
// shared by every noise source. MEASURED in node against a recording stub,
// 60 000 frames on a riverside plan in a storm: update() costs 0.39 us/frame with
// everything audible and 0.011 us/frame with the toggle off — the 128-segment
// nearest-water walk is the expensive part and runs at 5 Hz for that reason.
// I have NOT profiled the audio thread and will not invent a number for it; the
// graph is 56 nodes, which is small, and the only nonlinear node is the limiter.
// EPOCH LEAK: audio.js allocates NOTHING per epoch — no node, listener, timer or
// DOM element is created outside init — so 20 epoch switches are provably flat
// (verified: 20 × reset() + 500 frames + events created 324 one-shot nodes, every
// one of them disconnected by the sweep, and left the 12 steady sources running).
// reset() only re-latches the plan, drops the water cache and stops live voices.
//
// PUBLIC SURFACE
//   initAudio(cfg) → handle       — always returns a full handle, inert or not
//     cfg {mount, ui, toast, rig, wx, volume, key, storage}  every field optional
//       mount   Element the toggle chip is inserted into  (default: <header>,
//               before .meta; falls back to document.body)
//       ui      false suppresses the chip entirely (the API still works)
//       toast   fn(html) — used exactly once, the first time sound is turned on
//       rig     the camera rig; `dist` and `focusPoint` are read, both optional
//       wx      weather's handle OR its WX uniform bus; `ch.rain/gust/mist` or
//               `uGust/uWet/uFlash` are read if present, neutral if not
//       volume  0..1 initial master volume (default .70, persisted after)
//       key     the toggle key, default 'm'; null binds no key at all
//       storage a Storage-like object (default localStorage; absent → no persist)
//   handle:
//     get enabled   → boolean   the toggle, as the user set it
//     get audible   → boolean   enabled AND a running context exists
//     get inert     → boolean   this run may never make a sound
//     get volume    → 0..1
//     setEnabled(on) → boolean  the state actually reached; false in an inert run
//     toggle()      → boolean
//     setVolume(v)             clamped, persisted, ramped
//     update(dt, now, ctx)     dt IGNORED — `now` is performance.now()
//     event(kind, data)        'build' 'milestone' 'best' 'tierUp' 'landmark'
//                              'boot' 'cascade' 'rare' — unknown kinds no-op
//     reset()                  epoch switch          dispose()  shutdown
//
// WHAT THE CONDUCTOR MUST WIRE (town.js — six call sites, nothing else):
//   1. `import { initAudio } from './audio.js';`
//   2. after `ui = initInteract({...})` (so the toast sink exists):
//        const audio = initAudio({ rig, wx, toast: m => ui.toast(m) });
//   3. tick(), next to the other module updates:  `audio.update(dt, now, ctx);`
//   4. drainSpawnQueue(), where a house settles:  `audio.event('build', {pos: e.group.position})`
//      and at the cascade branch:                 `audio.event('cascade', {n: i})`
//   5. beside each existing `wx.event(...)` — same kind, same data:
//        placeLandmark → audio.event('landmark', {kind, label: e.label})
//        fireMilestone → audio.event(m.best ? 'best' : m.mon != null ? 'tierUp' : 'milestone', {tok, id, tier})
//        startRitual   → audio.event('boot', {full: !!full})
//   6. hardReset() teardown registry → `audio.reset();`   shutdown() → `audio.dispose();`
//   ('rare' is left free for T-17's rare events; nothing here fires it.)
//
// THE COPY GATE. Two strings ship: the chip reads `♪ sound` or `♪ silent`, and the
// first time it is switched on the toast says "The town, out loud." Nothing here
// asks the user for anything, and a quiet town is simply a quiet town — the beds
// thin out toward birdsong and wind, which is the nicest thing in the module.

/* ═══ test hooks — parsed here, not in town.js ══════════════════ */
const QS = (() => {
  try { return new URLSearchParams((typeof location !== 'undefined' && location.search) || ''); }
  catch (e) { return new URLSearchParams(''); }
})();

/** Is this run allowed to make a sound at all? Evaluated per init(), not at
 *  module scope, so a harness can flip the environment between cases.
 *  `?audio=on` forces the engine on a run that would otherwise be inert (a human
 *  in a plain browser); `?audio=chip` mounts the toggle but keeps the engine
 *  inert, which is how the chip gets into a docs screenshot without noise. */
function inertRun() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
  const a = QS.get('audio');
  if (a === 'on') return false;
  if (a === 'off') return true;
  if (QS.get('bench') !== null) return true;
  // main.js stamps `headless=1` on every --shot / --bench load. This USED to be
  // inferred from `document.visibilityState === 'hidden'`, on the theory that
  // show:false hides the document — it does not. paintWhenInitiallyHidden keeps
  // the page 'visible' precisely so it keeps painting, so that test silently
  // never fired. It stays below as a second net (a minimised window), but the
  // marker is the one that is actually load-bearing.
  if (QS.get('headless') !== null) return true;
  if (document.visibilityState === 'hidden') return true;
  // Any run that fabricates the number, the seed or the clock is verification,
  // not play. town.js calls this exact set SYNTHETIC.
  for (const k of ['hour', 'tokens', 'seed', 'still', 'feed', 'chronicle']) {
    if (QS.get(k) !== null) return true;
  }
  return !(typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined');
}

/* ═══ tuning ════════════════════════════════════════════════════ */
const D_NEAR = 26, D_FAR = 260;          // camera distance → master trim + cutoff
const CUT_NEAR = 15000, CUT_FAR = 825;   // Hz, interpolated in log space
const TRIM_FAR = 0.45;                   // master gain at D_FAR
// MAKEUP — the bed levels below were written conservatively and then never
// re-measured against the limiter sitting after them. Summed, the steady beds
// land around 0.10 peak of a buffer whose rms is 0.13, i.e. roughly -37 dBFS
// before the master trim; at the old default volume the whole town played at
// about -42 dBFS, which on normal desktop output is "is it even on?". The
// limiter's threshold is -14 dB, so there is ~20 dB of unused headroom in front
// of it. This spends half of that. It multiplies the MASTER only, so the
// balance between beds, one-shots and the room is exactly as tuned, and the
// limiter still catches the loud one-shots (a thunk peaks near 0.29 after it).
const MAKEUP = 2.4;
const VOL_DEFAULT = 0.70;                // gentle: MAKEUP × this ≈ +9.7 dB vs v1
const MAX_VOICES = 12;                   // hard cap on simultaneous one-shots
const ONSET_MS = 90;                     // and a floor between any two onsets
const NOISE_SEC = 4;                     // shared noise bed, seconds
const XFADE = 0.30;                      // its loop-seam crossfade, seconds
const FADE_ON = 1.6, FADE_OFF = 0.35;    // master fade time constants, seconds
const PENTA = [55.00, 61.74, 65.41, 73.42, 82.41];   // the pad's roots, Hz
const K_AUDIO = 'tt.audio', K_VOL = 'tt.audioVol';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const isNum = v => typeof v === 'number' && isFinite(v);
/** inverse-square-ish rolloff, smooth everywhere, 1 at the source, .5 at r */
const att = (d, r) => (r * r) / (r * r + d * d);
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ═══ the chip's sheet ══════════════════════════════════════════
   Inserted at the TOP of <head> so index.html's core sheet wins every tie —
   the same courtesy interact.js and news.js pay. `.chip` is index.html's; all
   this adds is the button reset and the two states. */
const CSS = `
#audioChip{appearance:none; font:inherit; cursor:pointer; opacity:1;
  color:var(--ink2,#C9C6BE); background:rgba(255,255,255,.055);
  border:1px solid rgba(255,255,255,.18);
  border-radius:11px; padding:1px 9px; font-size:11.5px; line-height:1.5;
  display:inline-flex; align-items:center; gap:5px; white-space:nowrap;
  transition:color .25s, border-color .25s, background .25s}
#audioChip:hover{border-color:rgba(255,255,255,.34); background:rgba(255,255,255,.10)}
/* SOUNDING: the accent, a tinted body and a lit rim — findable at a glance in a
   header of grey chips, which the .62-opacity original was not. */
#audioChip[aria-pressed="true"]{color:var(--accent,#D9A441);
  border-color:rgba(217,164,65,.55); background:rgba(217,164,65,.11)}
#audioChip[aria-pressed="true"]:hover{border-color:rgba(217,164,65,.8);
  background:rgba(217,164,65,.18)}
/* HUSHED: struck through, so the state reads without reading the word. */
#audioChip[aria-pressed="false"] .g{text-decoration:line-through;
  text-decoration-thickness:1px}
#audioChip .g{font-size:12px; line-height:1}
#audioChip:focus-visible{outline:1px solid var(--accent,#D9A441); outline-offset:2px}
`;
function ensureCss(doc) {
  if (doc.getElementById('audioBaseCss')) return;
  const st = doc.createElement('style');
  st.id = 'audioBaseCss'; st.textContent = CSS;
  const h = doc.head || doc.documentElement;
  h.insertBefore(st, h.firstChild);
}

/**
 * @param {Object} [cfg]
 * @returns {AudioHandle}
 */
export function initAudio(cfg = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const INERT = inertRun();
  const SHOW_CHIP = cfg.ui !== false && !!doc && (!INERT || QS.get('audio') === 'chip');

  const store = cfg.storage !== undefined ? cfg.storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const readPref = (k, d) => { try { const v = store && store.getItem(k); return v === null || v === undefined ? d : v; } catch (e) { return d; } };
  const writePref = (k, v) => { try { store && store.setItem(k, String(v)); } catch (e) { /* private mode: the toggle simply forgets */ } };

  // DEFAULT ON. Only a stored '0' — a mute the user actually chose — hushes the
  // town, and it survives every later launch. An absent key is a first run.
  let on = readPref(K_AUDIO, '1') !== '0';
  let vol = clamp01(isNum(cfg.volume) ? cfg.volume : parseFloat(readPref(K_VOL, String(VOL_DEFAULT))));
  if (!isFinite(vol)) vol = VOL_DEFAULT;
  let dead = false, told = readPref('tt.audioTold', '0') === '1';

  /* ── the graph, built once, lazily, inside a user gesture ────── */
  let ac = null, noiseBuf = null, rnd = mulberry32(0x7A11 ^ ((Date.now() / 86400000) | 0));
  let master = null, tone = null, limiter = null, sendIn = null, revOut = null;
  const beds = {};              // name → {g, node records}
  const owned = [];             // every node ever created, for dispose()
  const srcs = [];              // looping sources, for dispose()
  const voices = [];            // {ns:[], until:number(ac time)}
  let susTimer = 0, tellTimer = 0, gestureArmed = false;

  /* ── live state, all wall-clock stamped ─────────────────────── */
  let lastPlan = null, waterAt = -1e9, hasWater = false;
  const wpt = { x: 0, z: 0, d: 1e9 };
  let birdAt = 0, cricketAt = 0, tapAt = 0, murmurAt = 0, padAt = 0, bellHour = -1;
  let workUntil = -1e9, onsetAt = -1e9, buildAt = -1e9, flashArmed = true;
  const workPos = { x: 0, z: 0 };
  const lis = { x: 0, y: 0, z: 0 };            // the listener: the camera's focus
  const right = { x: 1, y: 0, z: 0 };          // camera right column, for pan
  let padRoot = 0;

  /* ── param records: a value only moves when it MOVED ───────────
     `last` starts at -Infinity so the FIRST write always lands; every write is
     a setTargetAtTime from wherever the param currently is, which is why a
     value can be re-targeted every frame and still never click. */
  const recs = [];
  function rec(p, eps, tau) { const r = { p, eps, tau, last: -Infinity }; recs.push(r); return r; }
  function ramp(r, target) {
    if (!(Math.abs(target - r.last) >= r.eps)) return;
    r.last = target;
    r.p.setTargetAtTime(target, ac.currentTime, r.tau);
  }

  /* ═══ graph construction ══════════════════════════════════════ */
  const N = {
    gain: v => { const n = ac.createGain(); n.gain.value = v; owned.push(n); return n; },
    biq: (type, f, q) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; owned.push(n); return n; },
    osc: (type, f) => { const n = ac.createOscillator(); n.type = type; n.frequency.value = f; owned.push(n); return n; },
    pan: v => {
      if (!ac.createStereoPanner) return null;
      const n = ac.createStereoPanner(); n.pan.value = v; owned.push(n); return n;
    },
    src: (rate, offset, loop) => {
      const n = ac.createBufferSource();
      n.buffer = noiseBuf; n.loop = !!loop; n.playbackRate.value = rate;
      if (loop) { n.loopStart = 0; n.loopEnd = NOISE_SEC - XFADE; }
      owned.push(n); if (loop) srcs.push(n);
      n.start(ac.currentTime + 0.02, offset || 0);
      return n;
    }
  };

  /** Pink-ish noise (Paul Kellet's economy filter over seeded white), two
   *  decorrelated channels for width, equal-power crossfaded across the loop
   *  seam so the bed has no audible period and no seam click. */
  function makeNoise() {
    const sr = ac.sampleRate || 48000, len = Math.floor(sr * NOISE_SEC);
    const buf = ac.createBuffer(2, len, sr), xf = Math.floor(sr * XFADE);
    const body = len - xf;                       // the loop's actual length
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c), r = mulberry32(0xA17C0DE ^ (c * 0x9E3779B1));
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = r() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        // 0.10 is the scale that puts Kellet's sum inside unity; the clamp only
        // catches the rare excursion, and a clipped sample of pink noise is
        // still pink noise. MEASURED peak after this: 0.72, rms 0.13.
        const v = (b0 + b1 + b2 + w * 0.1848) * 0.10;
        d[i] = v > 0.95 ? 0.95 : v < -0.95 ? -0.95 : v;
      }
      // fold the tail over the head: at the loop point the signal is the same
      // sample it was xf ago, so loopEnd = body is seamless.
      for (let i = 0; i < xf; i++) {
        const k = i / xf, a = Math.cos(k * Math.PI * 0.5), b = Math.sin(k * Math.PI * 0.5);
        d[i] = d[i] * b + d[body + i] * a;
      }
    }
    return buf;
  }

  /** Two cross-coupled delay lines with damped feedback — a room, for ~10 nodes
   *  and no impulse response to synthesise or store. Stereo comes free from the
   *  two taps being panned hard apart. */
  function buildRoom() {
    sendIn = N.gain(1);
    revOut = N.gain(0.42);
    const d1 = ac.createDelay(0.5), d2 = ac.createDelay(0.5);
    d1.delayTime.value = 0.0371; d2.delayTime.value = 0.0533;
    owned.push(d1, d2);
    const p1 = N.biq('lowpass', 2200, 0.5), p2 = N.biq('lowpass', 1900, 0.5);
    const f1 = N.gain(0.55), f2 = N.gain(0.55);
    sendIn.connect(d1); sendIn.connect(d2);
    d1.connect(p1); d2.connect(p2);
    p1.connect(f1); f1.connect(d2);              // cross-coupled: the tail spreads
    p2.connect(f2); f2.connect(d1);
    const l = N.pan(-0.8), r = N.pan(0.8);
    if (l && r) { p1.connect(l); l.connect(revOut); p2.connect(r); r.connect(revOut); }
    else { p1.connect(revOut); p2.connect(revOut); }
    revOut.connect(master);
  }

  /** A positional bed: source → filter → gain → panner → master (+ send). */
  function posBed(name, rate, type, freq, q, sendAmt) {
    const s = N.src(rate, rnd() * NOISE_SEC, true);
    const f = N.biq(type, freq, q);
    const g = N.gain(0);
    const p = N.pan(0);
    s.connect(f); f.connect(g);
    if (p) { g.connect(p); p.connect(master); } else g.connect(master);
    if (sendAmt > 0) { const sg = N.gain(sendAmt); g.connect(sg); sg.connect(sendIn); }
    const b = beds[name] = {
      g, f, p, gr: rec(g.gain, 0.0015, 0.45), fr: rec(f.frequency, 12, 0.5),
      pr: p ? rec(p.pan, 0.02, 0.35) : null
    };
    return b;
  }

  function buildGraph() {
    const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    ac = new AC({ latencyHint: 'playback' });
    noiseBuf = makeNoise();

    master = N.gain(0);                          // starts silent, always
    tone = N.biq('lowpass', CUT_NEAR, 0.7);
    limiter = ac.createDynamicsCompressor(); owned.push(limiter);
    limiter.threshold.value = -14; limiter.knee.value = 8; limiter.ratio.value = 6;
    limiter.attack.value = 0.004; limiter.release.value = 0.25;
    master.connect(tone); tone.connect(limiter); limiter.connect(ac.destination);
    buildRoom();

    // 1 · the town itself: distant life, thickening with the building count.
    posBed('town', 0.87, 'bandpass', 420, 0.6, 0.10);
    // 2 · wind — the one bed with modulators of its own, so it never sits still.
    const wind = posBed('wind', 1.00, 'lowpass', 520, 0.4, 0.06);
    const l1 = N.osc('sine', 0.071), l1g = N.gain(0.010);
    const l2 = N.osc('sine', 0.031), l2g = N.gain(0.006);
    // The LFOs are SUMMED into the gain param, alongside its own automation —
    // that is what makes the wind breathe without any per-frame scheduling.
    l1.connect(l1g); l1g.connect(wind.g.gain);
    l2.connect(l2g); l2g.connect(wind.g.gain);
    l1.start(); l2.start(); srcs.push(l1, l2);
    // rain gets a source and a hiss band of its own, on the same room send
    const rf = N.biq('highpass', 1500, 0.5), rg = N.gain(0);
    const rs = N.src(1.21, rnd() * NOISE_SEC, true);
    rs.connect(rf); rf.connect(rg); rg.connect(master);
    const rsend = N.gain(0.08); rg.connect(rsend); rsend.connect(sendIn);
    beds.rain = { g: rg, gr: rec(rg.gain, 0.002, 0.9) };
    // 3 · the pad: three voices, a moving root, a breathing filter.
    const pf = N.biq('lowpass', 620, 0.9), pg = N.gain(0);
    const o1 = N.osc('sine', PENTA[0]), o2 = N.osc('sine', PENTA[0] * 1.5), o3 = N.osc('triangle', PENTA[0] * 2);
    const o2g = N.gain(0.55), o3g = N.gain(0.22);
    o1.connect(pf); o2.connect(o2g); o2g.connect(pf); o3.connect(o3g); o3g.connect(pf);
    pf.connect(pg); pg.connect(master);
    const psend = N.gain(0.35); pg.connect(psend); psend.connect(sendIn);
    const pl = N.osc('sine', 0.043), plg = N.gain(170);
    pl.connect(plg); plg.connect(pf.frequency);
    o1.start(); o2.start(); o3.start(); pl.start(); srcs.push(o1, o2, o3, pl);
    beds.pad = { g: pg, oscs: [o1, o2, o3], gr: rec(pg.gain, 0.0015, 2.2) };
    // 4-6 · the positional three.
    posBed('water', 1.31, 'bandpass', 900, 1.1, 0.14);
    posBed('market', 0.61, 'bandpass', 700, 2.2, 0.12);
    posBed('work', 1.07, 'bandpass', 1800, 1.5, 0.16);
    padRoot = 0; padAt = -1e9;
  }

  /* ═══ voices — capped, swept, allocation-light ════════════════ */
  function canVoice(now) {
    return ac && voices.length < MAX_VOICES && now - onsetAt >= ONSET_MS;
  }
  function keep(ns, until) { onsetAt = wallNow(); voices.push({ ns, until }); }
  const wallNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function sweep(t) {
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].until > t) continue;
      const ns = voices[i].ns;
      for (const n of ns) { try { n.disconnect(); } catch (e) { /* already gone */ } }
      voices.splice(i, 1);
    }
  }
  /** Attack to `peak`, then a time-constant decay, and the time the voice may be
   *  stopped at. tau = dec/4 puts the tail at -35 dB by the returned time, which
   *  is quiet enough that stopping the source there is inaudible. Every envelope
   *  in this file starts at 0 and ends at 0; nothing is ever assigned in flight. */
  function envAt(p, t0, peak, atk, dec) {
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + atk);
    p.setTargetAtTime(0, t0 + atk, dec / 4);
    return t0 + atk + dec;
  }
  /** The out-stage every one-shot shares: gain → [pan] → master (+ room).
   *  `master` is deliberately NOT recorded in `ns`: sweep() disconnects every
   *  node it is handed, and disconnecting the master bus would take the whole
   *  town off the air the first time a bird finished singing. */
  function tail(g, pos, sendAmt, ns) {
    let out = g;
    if (pos) {
      emit(pos, 120);
      const pn = ac.createStereoPanner ? ac.createStereoPanner() : null;
      const vg = ac.createGain(); vg.gain.value = _em.g; ns.push(vg);
      g.connect(vg); out = vg;
      if (pn) { pn.pan.value = _em.p; ns.push(pn); vg.connect(pn); out = pn; }
    }
    out.connect(master);
    if (sendAmt > 0) { const s = ac.createGain(); s.gain.value = sendAmt; ns.push(s); out.connect(s); s.connect(sendIn); }
  }
  /** Scalar gain + pan for a world point, from the focus and the camera's right
   *  column. Writes the hoisted `_em` — nothing on the per-frame path allocates. */
  const _em = { g: 0, p: 0 };
  function emit(pos, r) {
    const dx = pos.x - lis.x, dz = (pos.z !== undefined ? pos.z : 0) - lis.z;
    const d = Math.hypot(dx, dz) || 0.0001;
    _em.g = att(d, r);
    _em.p = clamp((dx / d) * right.x + (dz / d) * right.z, -1, 1) * 0.7;
    return _em;
  }
  function noiseVoice(type, f, q, peak, atk, dec, pos, sendAmt) {
    const ns = [], t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain();
    ns.push(s, fl, g);
    s.connect(fl); fl.connect(g);
    tail(g, pos, sendAmt, ns);
    const end = envAt(g.gain, t, peak, atk, dec);
    s.start(t, rnd() * (NOISE_SEC - 0.5)); s.stop(end + 0.05);
    return { ns, end };
  }

  /* ═══ the one-shots ═══════════════════════════════════════════ */
  function bird(pos) {
    const ns = [], t0 = ac.currentTime, g0 = ac.createGain(); g0.gain.value = 1; ns.push(g0);
    tail(g0, pos, 0.18, ns);
    const n = 2 + (rnd() * 3 | 0);
    let end = t0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * (0.07 + rnd() * 0.07);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      const f0 = 2100 + rnd() * 1900;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (0.6 + rnd() * 0.85), t + 0.055);
      o.connect(g); g.connect(g0); ns.push(o, g);
      end = Math.max(end, envAt(g.gain, t, 0.085, 0.008, 0.075));
      o.start(t); o.stop(end + 0.05);
    }
    keep(ns, end + 0.1);
  }
  function cricket(pos) {
    const ns = [], t0 = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 1;
    const fl = ac.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 3900 + rnd() * 900; fl.Q.value = 22;
    const g = ac.createGain(); g.gain.value = 0;
    ns.push(s, fl, g); s.connect(fl); fl.connect(g);
    tail(g, pos, 0.05, ns);
    let end = t0;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.041;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.004);
      g.gain.linearRampToValueAtTime(0, t + 0.013);
      end = t + 0.013;
    }
    s.start(t0, rnd() * 2); s.stop(end + 0.05);
    keep(ns, end + 0.1);
  }
  function tap(pos) {                                   // a hammer on a rafter
    const v = noiseVoice('bandpass', 780 + rnd() * 520, 3.2, 0.11, 0.002, 0.10, pos, 0.30);
    keep(v.ns, v.end + 0.1);
  }
  function thunk(pos) {                                 // a building settling onto its plot
    const ns = [], t0 = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 240; fl.Q.value = 0.8;
    const g = ac.createGain(); ns.push(s, fl, g); s.connect(fl); fl.connect(g);
    const o = ac.createOscillator(), og = ac.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(96, t0); o.frequency.exponentialRampToValueAtTime(52, t0 + 0.18);
    o.connect(og); og.connect(g); ns.push(o, og);
    og.gain.value = 1;
    tail(g, pos, 0.22, ns);
    const end = envAt(g.gain, t0, 0.16, 0.006, 0.24);
    s.start(t0, rnd() * 2); s.stop(end + 0.05); o.start(t0); o.stop(end + 0.05);
    keep(ns, end + 0.1);
  }
  const BELL_R = [1, 2.00, 2.97, 4.09, 5.43, 6.80];
  const BELL_A = [1, 0.60, 0.42, 0.30, 0.20, 0.14];
  function bell(f, dur, peak, pos) {
    const ns = [], t0 = ac.currentTime, bus = ac.createGain(); bus.gain.value = 1; ns.push(bus);
    tail(bus, pos, 0.55, ns);
    let end = t0;
    for (let i = 0; i < BELL_R.length; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f * BELL_R[i];
      o.connect(g); g.connect(bus); ns.push(o, g);
      end = Math.max(end, envAt(g.gain, t0, peak * BELL_A[i], 0.004, dur * (1 - i * 0.12)));
      o.start(t0); o.stop(end + 0.05);
    }
    // the strike itself: a hair of noise, or the bell is a synth pad with a name
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f * 4; fl.Q.value = 1.4;
    const sg = ac.createGain(); ns.push(s, fl, sg);
    s.connect(fl); fl.connect(sg); sg.connect(bus);
    envAt(sg.gain, t0, peak * 0.5, 0.001, 0.05);
    s.start(t0, rnd() * 2); s.stop(t0 + 0.12);
    keep(ns, end + 0.15);
  }
  function chime(steps, peak, gap) {
    const ns = [], t0 = ac.currentTime, bus = ac.createGain(); bus.gain.value = 1; ns.push(bus);
    tail(bus, null, 0.45, ns);
    let end = t0;
    for (let i = 0; i < steps.length; i++) {
      const t = t0 + i * gap;
      const o = ac.createOscillator(), g = ac.createGain(), o2 = ac.createOscillator(), g2 = ac.createGain();
      o.type = 'triangle'; o.frequency.value = steps[i];
      o2.type = 'sine'; o2.frequency.value = steps[i] * 2.01;      // a touch of shimmer
      o.connect(g); g.connect(bus); o2.connect(g2); g2.connect(bus);
      ns.push(o, g, o2, g2);
      const e = envAt(g.gain, t, peak, 0.010, 0.85);
      envAt(g2.gain, t, peak * 0.22, 0.008, 0.55);
      end = Math.max(end, e);
      o.start(t); o.stop(end + 0.05); o2.start(t); o2.stop(end + 0.05);
    }
    keep(ns, end + 0.15);
  }
  function shimmer() {                                  // the rare thing, when it happens
    const ns = [], t0 = ac.currentTime, bus = ac.createGain(); bus.gain.value = 1; ns.push(bus);
    tail(bus, null, 0.7, ns);
    let end = t0;
    for (let i = 0; i < 6; i++) {
      const t = t0 + i * 0.085;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      const f = 660 * Math.pow(1.2599, i);
      o.frequency.setValueAtTime(f * 0.985, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.6);
      o.connect(g); g.connect(bus); ns.push(o, g);
      end = Math.max(end, envAt(g.gain, t, 0.055, 0.18, 1.1));
      o.start(t); o.stop(end + 0.05);
    }
    keep(ns, end + 0.15);
  }
  function swell(f, dur, peak) {                        // the founding, and nothing else
    const ns = [], t0 = ac.currentTime;
    const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f;
    o2.type = 'sine'; o2.frequency.value = f * 1.5;
    const g2 = ac.createGain(); g2.gain.value = 0.4;
    o.connect(g); o2.connect(g2); g2.connect(g);
    ns.push(o, o2, g, g2);
    tail(g, null, 0.5, ns);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.05); o2.start(t0); o2.stop(t0 + dur + 0.05);
    keep(ns, t0 + dur + 0.1);
  }
  function thunder() {
    const ns = [], t0 = ac.currentTime + 0.9 + rnd() * 1.6;      // sound lags the flash
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.72;
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 170; fl.Q.value = 1.2;
    const g = ac.createGain(); ns.push(s, fl, g); s.connect(fl); fl.connect(g);
    tail(g, null, 0.6, ns);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.30, t0 + 0.5);
    g.gain.setTargetAtTime(0, t0 + 0.5, 0.9);
    const end = t0 + 3.6;
    s.start(t0, rnd() * 2); s.stop(end + 0.05);
    keep(ns, end + 0.1);
  }

  /* ═══ events the conductor fires ══════════════════════════════ */
  function event(kind, data) {
    if (dead || !ac || !on || ac.state !== 'running') return;
    const now = wallNow();
    switch (kind) {
      case 'build': {
        const p = data && data.pos;
        buildAt = now; workUntil = now + 14000;
        if (p && isNum(p.x)) { workPos.x = p.x; workPos.z = p.z; }
        // A cascade lands two hundred houses in eight seconds; one thunk per
        // house is a hailstorm. One every 260 ms is a building site.
        if (now - tapAt > 260 && canVoice(now)) { tapAt = now; thunk(p || workPos); }
        break;
      }
      case 'cascade':
        workUntil = now + 20000;
        if (canVoice(now)) chime([440, 587.33, 659.25], 0.05, 0.11);
        break;
      case 'landmark':
        if (canVoice(now)) chime([523.25, 783.99], 0.075, 0.16);
        break;
      case 'milestone':
        if (canVoice(now)) chime([523.25, 659.25, 783.99], 0.085, 0.14);
        break;
      case 'tierUp':
        if (canVoice(now)) bell(196 * (data && isNum(data.tier) && data.tier >= 8 ? 0.75 : 1), 2.6, 0.10, null);
        break;
      case 'best':
        // A personal best is the one moment allowed two voices at once. The
        // ONSET_MS floor exists to stop a cascade machine-gunning, and both of
        // these are scheduled in the same millisecond by design — so this pair
        // checks the CAP and skips the spacing, or the shimmer never played.
        if (canVoice(now)) chime([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.09, 0.13);
        if (voices.length < MAX_VOICES) shimmer();
        break;
      case 'boot':
        if (data && data.full && canVoice(now)) swell(PENTA[0], 3.4, 0.09);
        break;
      case 'rare':                                   // T-17's hook; nothing here fires it
        if (canVoice(now)) shimmer();
        break;
      default: break;
    }
  }

  /* ═══ the per-frame pass ══════════════════════════════════════ */
  const _z = { x: 0, z: 0 };                        // the plaza / emitter scratch
  const _sp = { x: 0, z: 0 };                       // where a bird or a cricket is
  /** weather.js's channels if it was handed the handle, its uniform bus if it was
   *  handed that, and a still, clear, dry day if it was handed neither. */
  const _wx = { gust: 1, rain: 0, wet: 0, flash: 0 };
  function readWeather() {
    const w = cfg.wx;
    _wx.gust = 1; _wx.rain = 0; _wx.wet = 0; _wx.flash = 0;
    if (!w) return _wx;
    if (w.ch) {                                      // weather.js's handle
      if (isNum(w.ch.gust)) _wx.gust = w.ch.gust;
      if (isNum(w.ch.rain)) _wx.rain = w.ch.rain;
      if (isNum(w.ch.wet)) _wx.wet = w.ch.wet;
    }
    const bus = w.uGust ? w : null;                  // or the raw uniform bus
    if (bus) {
      if (bus.uGust && isNum(bus.uGust.value)) _wx.gust = bus.uGust.value;
      if (bus.uWet && isNum(bus.uWet.value)) _wx.wet = Math.max(_wx.wet, bus.uWet.value);
      if (bus.uFlash && isNum(bus.uFlash.value)) _wx.flash = bus.uFlash.value;
    }
    if (w.grade && isNum(w.grade.flash)) _wx.flash = Math.max(_wx.flash, w.grade.flash);
    return _wx;
  }
  /** A random point out in the town, for a bird or a cricket to be at. */
  function spot(c, rr) {
    const a = rnd() * Math.PI * 2, d = (0.35 + rnd() * 0.75) * rr;
    _sp.x = (c.bounds ? c.bounds.cx : 0) + Math.cos(a) * d;
    _sp.z = (c.bounds ? c.bounds.cz : 0) + Math.sin(a) * d;
    return _sp;
  }
  /** Nearest point on the plan's water to the listener, at 5 Hz. */
  function nearestWater(plan, now) {
    if (now - waterAt < 200) return hasWater;
    waterAt = now;
    const w = plan && plan.water;
    if (!w || !w.path || w.path.length < 2) return (hasWater = false);
    const p = w.path, closed = w.kind === 'lake';
    const n = closed ? p.length : p.length - 1;
    let bd = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
      let t = L > 0 ? ((lis.x - a.x) * dx + (lis.z - a.z) * dz) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a.x + dx * t, qz = a.z + dz * t;
      const d = (lis.x - qx) * (lis.x - qx) + (lis.z - qz) * (lis.z - qz);
      if (d < bd) { bd = d; bx = qx; bz = qz; }
    }
    wpt.x = bx; wpt.z = bz;
    wpt.d = Math.max(0, Math.sqrt(bd) - (w.width || 0) * 0.5);
    return (hasWater = true);
  }
  function setPos(bed, pos, r, base) {
    if (!bed) return;
    emit(pos, r);
    ramp(bed.gr, base * _em.g);
    if (bed.pr) ramp(bed.pr, _em.p);
  }

  function update(dt, now, c) {
    if (dead || !ac) return;
    if (!on || ac.state !== 'running') return;
    sweep(ac.currentTime);
    if (!c) return;

    /* ── the listener: focus point, or the camera if there is no rig ── */
    const cam = c.camera;
    const fp = cfg.rig && cfg.rig.focusPoint;
    if (fp && isNum(fp.x)) { lis.x = fp.x; lis.y = fp.y; lis.z = fp.z; }
    else if (cam && cam.position) { lis.x = cam.position.x; lis.y = cam.position.y; lis.z = cam.position.z; }
    if (cam && cam.matrixWorld && cam.matrixWorld.elements) {
      const e = cam.matrixWorld.elements;
      right.x = e[0]; right.y = e[1]; right.z = e[2];
    }
    let dist = cfg.rig && isNum(cfg.rig.dist) ? cfg.rig.dist : 0;
    if (!dist && cam && cam.position && c.bounds) {
      dist = Math.hypot(cam.position.x - c.bounds.cx, cam.position.y, cam.position.z - c.bounds.cz);
    }
    if (!dist) dist = 62;

    /* ── location: one trim, one cutoff, both on the same k ──────
       Further out is quieter AND duller. The cutoff is interpolated in log
       space, so a descent opens the sound continuously instead of in a step. */
    const k = clamp01((dist - D_NEAR) / (D_FAR - D_NEAR));
    trim = 1 - (1 - TRIM_FAR) * Math.pow(k, 0.85);
    if (Math.abs(target() - masterLast) > 0.0008) writeMaster(0.25);
    ramp(mCut, CUT_NEAR * Math.pow(CUT_FAR / CUT_NEAR, k));

    /* ── the world, read once ──────────────────────────────────── */
    const day = clamp01(isNum(c.day) ? c.day : 1), night = 1 - day;
    const nB = isNum(c.buildingCount) ? c.buildingCount : 0;
    const life = Math.sqrt(clamp01(nB / 1200));
    const wx = readWeather();
    const gustN = clamp01((wx.gust - 0.35) / 2.25);
    const intro = isNum(c.intro) ? c.intro : 1;

    /* ── the beds ──────────────────────────────────────────────── */
    ramp(beds.town.gr, (0.012 + 0.070 * life) * (0.32 + 0.68 * day) * intro);
    ramp(beds.town.fr, 380 + 260 * life);
    ramp(beds.wind.gr, 0.020 + 0.052 * gustN);
    ramp(beds.wind.fr, 300 + 1100 * gustN);
    ramp(beds.rain.gr, 0.115 * clamp01(wx.rain));
    // The pad is a twilight instrument: strongest as the light turns, a floor at
    // night, and it fades out of the way at noon rather than humming under it.
    const tw = Math.pow(1 - Math.abs(day * 2 - 1), 1.6);
    ramp(beds.pad.gr, (0.006 + 0.026 * tw + 0.010 * night) * (0.35 + 0.65 * life) * intro);
    if (now - padAt > 52000) {                     // a new root, glided over 6 s
      padAt = now;
      padRoot = (padRoot + 1 + (rnd() * 3 | 0)) % PENTA.length;
      const f = PENTA[padRoot], t = ac.currentTime;
      const M = [1, 1.5, 2];
      for (let i = 0; i < 3; i++) {
        const o = beds.pad.oscs[i];
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(o.frequency.value, t);
        o.frequency.linearRampToValueAtTime(f * M[i], t + 6);
      }
    }

    /* ── the positional three ──────────────────────────────────── */
    if (c.plan !== lastPlan) { lastPlan = c.plan; waterAt = -1e9; }
    if (nearestWater(c.plan, now)) {
      const e = emit(wpt, 78);
      ramp(beds.water.gr, 0.085 * att(wpt.d, 78) * (0.7 + 0.3 * day));
      if (beds.water.pr) ramp(beds.water.pr, e.p);
      ramp(beds.water.fr, 820 + 240 * gustN);
    } else ramp(beds.water.gr, 0);

    if (c.monumentPos) { _z.x = c.monumentPos.x; _z.z = c.monumentPos.z; }
    else { _z.x = 0; _z.z = 0; }
    // The market is a daytime thing and it needs a town to be a market in. The
    // murmur multiplier is a slow random walk — a crowd, not a tone.
    if (now - murmurAt > 2400) { murmurAt = now; beds.market.mul = 0.55 + rnd() * 0.8; }
    const marketK = 0.042 * clamp01(nB / 60) * Math.pow(day, 1.3) * (beds.market.mul || 1) * intro;
    setPos(beds.market, _z, 96, marketK);

    const workK = clamp01((workUntil - now) / 14000);
    setPos(beds.work, workPos, 52, 0.055 * workK);

    /* ── the granular layer, all wall-clock scheduled ──────────── */
    const r = c.bounds ? Math.max(18, c.bounds.r) : 40;
    if (day > 0.35 && now > birdAt && canVoice(now)) {
      birdAt = now + 3800 + rnd() * 6500;
      bird(spot(c, r));
    }
    if (night > 0.5 && now > cricketAt && canVoice(now)) {
      cricketAt = now + 1300 + rnd() * 2200;
      cricket(spot(c, r * 1.25));
    }
    if (workK > 0.05 && now > tapAt + 420 + rnd() * 900 && canVoice(now)) {
      tapAt = now;
      tap(workPos);
    }
    // The night watch, on the hour. `simNow` is the feed's clock, so a demo day
    // rings exactly as often as a real one.
    if (night > 0.6 && isNum(c.simNow)) {
      const h = Math.floor(c.simNow / 3600000);
      if (bellHour === -1) bellHour = h;
      else if (h !== bellHour) {
        bellHour = h;
        if (canVoice(now)) bell(146.83, 4.2, 0.075, null);
      }
    }
    // Thunder answers weather's own flash channel — it invents no trigger.
    if (wx.flash > 0.5 && flashArmed && wx.rain > 0.2 && canVoice(now)) { flashArmed = false; thunder(); }
    else if (wx.flash < 0.1) flashArmed = true;
  }

  /* ═══ enable / suspend / volume ═══════════════════════════════
     THE MASTER GAIN HAS EXACTLY ONE WRITER, writeMaster(), and one target
     expression. Two writers is how a bus ends up fighting itself: a fade-out on
     `visibilitychange` and a distance trim in update() would have taken turns,
     and the hidden window would have faded straight back up on the next frame
     Electron painted (backgroundThrottling is off, so it paints plenty). */
  let mCut = null, trim = 1, hidden = false, masterLast = 0;
  const target = () => (on && !hidden) ? vol * trim * MAKEUP : 0;
  function writeMaster(tau) {
    if (!ac || !master) return;
    masterLast = target();
    master.gain.setTargetAtTime(masterLast, ac.currentTime, tau);
  }
  function startEngine() {
    if (ac || INERT || dead) return false;
    try {
      buildGraph();
    } catch (e) {
      // A half-built graph is worse than none: drop the wreckage so a second
      // toggle starts clean rather than leaking a dead context's nodes.
      try { if (ac && ac.close) ac.close(); } catch (e2) { /* nothing to close */ }
      ac = null; owned.length = 0; srcs.length = 0; recs.length = 0;
      for (const k in beds) delete beds[k];
      return false;
    }
    mCut = rec(tone.frequency, 20, 0.55);
    masterLast = 0;
    return true;
  }
  function suspend() { if (ac && ac.suspend) { try { ac.suspend(); } catch (e) { /* already gone */ } } }
  function armGesture() {
    if (gestureArmed || INERT || !doc) return;
    gestureArmed = true;
    doc.addEventListener('pointerdown', onGesture, true);
    doc.addEventListener('keydown', onGesture, true);
  }
  function disarmGesture() {
    if (!gestureArmed || !doc) return;
    gestureArmed = false;
    doc.removeEventListener('pointerdown', onGesture, true);
    doc.removeEventListener('keydown', onGesture, true);
  }
  function onGesture() { disarmGesture(); if (on) resumeNow(); }
  /** THE OLD SILENCE LIVED HERE. `ac.resume()` is ASYNCHRONOUS — it returns a
   *  promise and `ac.state` is still 'suspended' on the line after the call —
   *  so the original `if (ac.state === 'suspended') { armGesture(); return; }`
   *  fired on essentially every resume, took the early return, and never wrote
   *  the master gain. It only ever recovered because update() re-derives the
   *  master from the camera distance a frame later; if the state check at the
   *  top of update() had been reached one tick too early, or the town was
   *  paused, the bus stayed at 0 with a perfectly healthy graph behind it.
   *  Now: write the master unconditionally (a setTargetAtTime on a suspended
   *  context is scheduled against a frozen clock and lands the instant it
   *  runs), and hang the retry off the promise instead of off a stale read. */
  function resumeNow() {
    if (!ac && !startEngine()) return;
    if (ac.state === 'suspended' && ac.resume) {
      try {
        const p = ac.resume();
        if (p && p.then) p.then(
          () => { if (!dead && on) { writeMaster(FADE_ON / 3); tell(); } },
          () => armGesture()                     // policy said no: wait for input
        );
      } catch (e) { armGesture(); }
    }
    // Belt and braces: if the context is still not running by the end of this
    // turn, keep an input listener armed. onGesture() is idempotent.
    if (ac.state !== 'running') armGesture();
    writeMaster(FADE_ON / 3);
    if (ac.state === 'running') tell();
  }
  /** The one-time "you can hear the town, and here is how to stop" notice. Fires
   *  the first time sound is actually live, whether that was the default or the
   *  user reaching for the chip — with sound on by default the old
   *  toast-on-enable site would never have fired at all. */
  function tell() {
    if (told || !cfg.toast || INERT) return;
    told = true; writePref('tt.audioTold', '1');
    // Held back past the founding ritual, which owns the screen for the first
    // few seconds and has toasts of its own to say. `told` is set NOW so a
    // second call cannot queue a second notice.
    tellTimer = setTimeout(() => {
      tellTimer = 0;
      if (dead) return;
      try { cfg.toast('The town, out loud. ' + KEYNAME + ' to hush it.'); } catch (e) { /* no sink */ }
    }, 6500);
  }
  function setEnabled(next) {
    if (dead) return false;
    const want = !!next;
    if (INERT) { on = false; paintChip(); return false; }
    if (want === on && (ac || !want)) { paintChip(); return on; }
    on = want;
    writePref(K_AUDIO, on ? '1' : '0');
    if (on) {
      disarmGesture();
      resumeNow();                               // resumeNow() calls tell()
    } else {
      writeMaster(FADE_OFF / 3);
      // Suspend only AFTER the fade has actually finished; a suspend inside the
      // ramp is a cut, and a cut is exactly the click this module forbids.
      if (susTimer) clearTimeout(susTimer);
      susTimer = setTimeout(() => { susTimer = 0; if (!on) suspend(); }, 700);
    }
    paintChip();
    return on;
  }
  function setVolume(v) {
    vol = clamp01(isNum(v) ? v : vol);
    writePref(K_VOL, vol.toFixed(3));
    if (on && ac && ac.state === 'running') writeMaster(0.12);
    paintChip();
  }

  /* ═══ the toggle ══════════════════════════════════════════════ */
  // -1e9, not 0: paintChip shows the volume for 1.4 s after a scroll, and a
  // zeroed stamp meant the chip opened reading "55%" instead of "silent".
  let chip = null, chipLbl = null, volAt = -1e9;
  function paintChip() {
    if (!chip) return;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    const showVol = wallNow() - volAt < 1400;
    chipLbl.textContent = showVol ? Math.round(vol * 100) + '%' : (on ? 'sound' : 'silent');
    chip.title = on
      ? 'The town, out loud. ' + KEYNAME + ' to hush it · scroll here for volume'
      : 'The town is keeping quiet. ' + KEYNAME + ' to listen in';
  }
  const KEYNAME = cfg.key === null ? 'The chip' : String(cfg.key || 'm').toUpperCase();
  function mountChip() {
    if (!SHOW_CHIP) return;
    ensureCss(doc);
    chip = doc.createElement('button');
    chip.id = 'audioChip'; chip.type = 'button';
    const g = doc.createElement('span'); g.className = 'g'; g.textContent = '♪';
    chipLbl = doc.createElement('span');
    chip.appendChild(g); chip.appendChild(chipLbl);
    chip.addEventListener('click', onChipClick);
    chip.addEventListener('wheel', onChipWheel, { passive: false });
    const host = cfg.mount || doc.querySelector('header') || doc.body;
    const before = cfg.mount ? null : host.querySelector('.meta');
    if (before) host.insertBefore(chip, before); else host.appendChild(chip);
    paintChip();
  }
  function onChipClick(e) { e.preventDefault(); setEnabled(!on); }
  function onChipWheel(e) {
    e.preventDefault();
    volAt = wallNow();
    setVolume(vol + (e.deltaY < 0 ? 0.1 : -0.1));
  }
  function onKey(e) {
    if (dead || cfg.key === null) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() !== String(cfg.key || 'm').toLowerCase()) return;
    const ae = doc.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    // interact.js swallows the first key while its `?` sheet is open; do not
    // toggle the sound on the keypress that was aimed at closing a dialog.
    const sheet = doc.getElementById('sheet');
    if (sheet && !sheet.hidden) return;
    setEnabled(!on);
  }
  function onVis() {
    hidden = doc.visibilityState === 'hidden';
    if (!ac || !on) return;
    if (hidden) {
      writeMaster(0.09);
      if (susTimer) clearTimeout(susTimer);
      susTimer = setTimeout(() => { susTimer = 0; if (hidden) suspend(); }, 400);
    } else {
      if (susTimer) { clearTimeout(susTimer); susTimer = 0; }
      resumeNow();
    }
  }

  /* ═══ lifecycle ═══════════════════════════════════════════════ */
  /** Epoch switch. Nothing per-epoch was allocated, so nothing is freed: the
   *  live one-shots of the town being torn down are stopped, the water cache is
   *  dropped, and the beds are pulled to silence so the new town fades UP into
   *  its own soundscape instead of inheriting the last one's market. */
  function reset() {
    if (dead || !ac) return;
    const t = ac.currentTime;
    for (const v of voices) for (const n of v.ns) { try { n.disconnect(); } catch (e) { /* gone */ } }
    voices.length = 0;
    for (const key of ['town', 'wind', 'rain', 'pad', 'water', 'market', 'work']) {
      const b = beds[key];
      if (!b) continue;
      b.g.gain.cancelScheduledValues(t);
      b.g.gain.setValueAtTime(b.g.gain.value, t);
      b.g.gain.setTargetAtTime(0, t, 0.25);
      if (b.gr) b.gr.last = 0;
    }
    lastPlan = null; hasWater = false; waterAt = -1e9;
    workUntil = -1e9; buildAt = -1e9; bellHour = -1; flashArmed = true;
    birdAt = cricketAt = tapAt = murmurAt = 0;
  }

  function dispose() {
    if (dead) return;
    dead = true;
    disarmGesture();
    if (susTimer) { clearTimeout(susTimer); susTimer = 0; }
    if (tellTimer) { clearTimeout(tellTimer); tellTimer = 0; }
    if (doc) {
      doc.removeEventListener('visibilitychange', onVis);
      if (cfg.key !== null) doc.removeEventListener('keydown', onKey);
    }
    if (chip) {
      chip.removeEventListener('click', onChipClick);
      chip.removeEventListener('wheel', onChipWheel);
      chip.remove(); chip = null; chipLbl = null;
    }
    const st = doc && doc.getElementById('audioBaseCss');
    if (st) st.remove();
    if (ac) {
      for (const v of voices) for (const n of v.ns) { try { n.disconnect(); } catch (e) { /* gone */ } }
      voices.length = 0;
      for (const s of srcs) { try { s.stop(); } catch (e) { /* not started */ } }
      for (const n of owned) { try { n.disconnect(); } catch (e) { /* gone */ } }
      srcs.length = 0; owned.length = 0; recs.length = 0;
      try { ac.close(); } catch (e) { /* already closed */ }
      ac = null; noiseBuf = null; master = tone = limiter = sendIn = revOut = null;
      for (const k in beds) delete beds[k];
    }
  }

  /* ═══ boot ════════════════════════════════════════════════════ */
  // `?audio=chip` stages the chip for a docs shot and wants it as the USER sees
  // it — which is now SOUNDING. Every path that could make a sample still
  // refuses under INERT (startEngine bails, setEnabled bails, the boot block
  // below is skipped, update/event bail on a null context), so this paints the
  // real state without being able to play it. Every other inert run is off.
  if (INERT && QS.get('audio') !== 'chip') on = false;
  mountChip();
  if (doc && !INERT) {
    hidden = doc.visibilityState === 'hidden';
    doc.addEventListener('visibilitychange', onVis);
    if (cfg.key !== null) doc.addEventListener('keydown', onKey);
    // Sound is on: build the graph and come up NOW. main.js lifts the autoplay
    // policy, so the context starts running with no gesture; the noise buffer
    // costs ~2 ms of main thread at load (2 × 4 s at 48 kHz) and the master
    // fades in over FADE_ON, so the founding ritual is not stepped on. If the
    // policy switch ever fails to take, resumeNow() arms the input fallback.
    if (on) resumeNow();
  }

  return {
    get enabled() { return on; },
    get audible() { return !!(on && ac && ac.state === 'running'); },
    get inert() { return INERT; },
    get volume() { return vol; },
    /** live voice count — the bench and the tests read it */
    get voices() { return voices.length; },
    setEnabled,
    toggle: () => setEnabled(!on),
    setVolume,
    update, event, reset, dispose
  };
}
