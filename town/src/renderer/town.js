// Token Town renderer — the conductor. It knows nothing about SQLite or Token
// Tracker; it consumes the datafeed protocol (init / buckets / config / error).
//
// The town is a pure function of ONE number and ONE seed:
//   N = townSize(T) = 32 * (T / 1M)^(3/8)     buildings standing right now
//   plan = buildPlan(planSeed)                where every one of them stands
// More tokens → more buildings, a grander altar, more villagers. A burst of
// tokens therefore detonates MANY buildings at once instead of inflating a
// single house, and nothing the user does can shrink the town (T is monotonic
// inside an epoch). The street plan is organic and seeded per epoch, so today is
// a place you found rather than a layout someone chose.
//
// town.js is the SOLE MEDIATOR: layout / environs / news / npcs / monument /
// buildings never import each other. Everything they need arrives through their
// cfg (at init) and through the one shared `ctx` (per frame), and every event
// between them is relayed here.
//
// Everything about *existence* — spawned buildings, milestones, headlines,
// counters — runs off performance.now(), never accumulated dt, so a
// low-frame-rate headless screenshot still shows a finished town.
//
// Opened in a plain browser (no preload bridge) it feeds itself synthetic demo
// data so the scene can be developed and screenshot-tested standalone.
import * as THREE from './vendor/three.module.js';
import {
  TIER_NAMES, MAT, GEO, LANDMARK_DEFS, matFor,
  buildHouse, pickFlavor, buildFlavor, buildLandmark, buildBridge, buildTree,
  buildScaffold, disposeGroup, deriveImpostor, winMatFor,
  initPalette, palette, paintHouse, paintFlavor, paintLandmark, paintBridge,
  dayAccent, roofNameOf, rareOf,
  // T-21 — the village fabric: hamlet → village → market village → market town.
  // It is a module-level switch that styles buildings built AFTER it, so town.js
  // owns both when it moves and who gets restyled when it does.
  setVillageTier, villageTier, villageTierFor, villageFabric, VILLAGE_TIER_NAMES
} from './buildings.js';
import { buildPlan, LAYOUT, archetypeOf, KIND_LABEL, settlementLabel } from './layout.js';
import { initEnvirons, fogFor } from './environs.js';
import { WX, initWeather } from './weather.js';
import { initNews, townNameFor } from './news.js';
// The plaza centrepiece. `monument` is still the name every call site uses —
// it IS the town's monument — but the object is now a village fountain, not the
// 78-unit Token Altar. See AESTHETIC.md: growth shows as MORE, not TALLER.
import { initFountain } from './fountain.js';
import { initNPCs, NPC_CAP } from './npcs.js';
import { initCamera } from './camera.js';
import { initPost, gradeFor, makeGrade, heatOf } from './postfx.js';
import * as surface from './surface.js';
import { SURF } from './surface.js';
import { initGrounding } from './grounding.js';
import { initLod } from './lod.js';
import { initInteract } from './interact.js';
// The three approved-idea modules. All three are null objects when their inputs
// are missing, and all three are in the teardown registry below.
import { initAudio } from './audio.js';       // T-16 — ambient sound, on by default
import { initEvents } from './events.js';     // T-17 — rare events, properly spaced
import { initShift } from './shift.js';       // T-12 — the town dresses for your hours
import { initMayor, MAYOR_UNLOCK_TOK } from './mayor.js';   // T-22 — he takes office and says so
import { initMarket } from './market.js';     // T-10 — market day on the square
import {
  initChronicle, paintSkyline, synthChronicle,
  dayIndexOf, dateOfDayIndex, shiftDayIndex, planSeedOfIndex
} from './chronicle.js';
import { initMemorial } from './memorial.js';
import { initAlmanac } from './almanac.js';
import { initCharter } from './charter.js';

/* ═══ helpers ═══════════════════════════════════════════════════ */
const INT_MS = 5 * 60 * 1000, IDLE_MS = 10 * 60 * 1000;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const easeOutBack = k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const easeOutCubic = k => 1 - Math.pow(1 - k, 3);
const rand = (a, b) => a + Math.random() * (b - a);
// Grouped integers below 1M, same as the altar's own ledger: the footer used to
// say "300k" while the tablet beside it said "300 000" for the same number.
const grouped = n => String(Math.round(Math.max(n, 0))).replace(/\B(?=(\d{3})+$)/g, ' ');
// The K rung exists because news.js has one: without it the Crier said "250.0K"
// in the same breath as the footer said "250 000" for the identical number.
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : grouped(n);
const seededR = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const fnv1a = s => { let h = 0x811c9dc5 >>> 0; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const fmtClock = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtDur = ms => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim() : `${m} min`;
};
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const roman = n => ROMAN[clamp(n, 0, 10)];
const GOLD_HI = 0xF3D07A;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Sentence case for a label that was written to sit mid-sentence ('your last
// session') and now has to open one.
const cap1 = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };

/* ═══ the growth curve: one number in, a township out ═══════════ */
const TOK_UNIT = 1e6, K = 32, P = 3 / 8, N_CAP = LAYOUT.N_CAP;
const townSize = T => Math.min(N_CAP, Math.floor(K * Math.pow(Math.max(T, 0) / TOK_UNIT, P)));
const tokensFor = n => TOK_UNIT * Math.pow(Math.max(n, 0) / K, 1 / P);
const costOf = n => tokensFor(n) - tokensFor(n - 1);
// Prosperity is logarithmic where the count is a power law: the town gets wider
// fast and grander slowly, so 400 buildings read as a city, not 400 castles.
const prosperity = T => Math.max(0, 1.15 * Math.log10(Math.max(T, 1) / 2e5));
const TIER_H = [1.5, 1.6, 3, 3.5, 4.3, 5.4, 5.9, 7.1];
function rarityOf(plotIdx, L) {
  const r = seededR(plotIdx * 3.13 + 7.7), hi = .012 + .004 * L;
  return r > 1 - hi * .34 ? 3 : r > 1 - hi ? 2 : r > .80 ? 1 : r < .10 ? -1 : 0;
}
function tierOfPlot(idx, fk, L) {
  // u is normalised against the CURRENT frontier key, so yesterday's fringe
  // becomes downtown as the town grows — this is the anti-stall engine. It is
  // continuous now (the plan has no rings), which kills the old step artefacts.
  const u = clamp(plan.depthOf(idx) / (fk + 20), 0, 1.2);
  const grandeur = 2.4 * (1 - u) * (1 - u) - .9 * u;
  return clamp(Math.round(L + grandeur + rarityOf(idx, L)), 0, 7);
}

/* ═══ the milestone ladder ══════════════════════════════════════ */
// `mon` is the tier↔tokens contract with fountain.js, which has eleven rungs
// (0 = Stone Basin, the pre-milestone state). The rungs buy DETAIL — water,
// carving, lanterns, flowers, paving, a second bowl — never height: the whole
// fountain tops out under seven units. See AESTHETIC.md.
// THE LANDMARK ORDER IS NOT FREE. layout.js's `LM` table reserves each site at a
// BUILDING ORDINAL, and placeLandmark silently skips a kind whose site has not
// been reserved yet — so a rung may only name a landmark whose ordinal the town
// has already reached at that token count. The two tables were tuned together:
// well 32 ≈ 1M, smithy 60 ≈ 5.4M, mill 78 ≈ 10.8M, market_cross 104 ≈ 23M,
// tithe_barn 138 ≈ 49M, market_hall 178 ≈ 97M, chapel 232 ≈ 197M,
// bell_tower 296 ≈ 377M, village_green 368 ≈ 674M, inn 452 ≈ 1.17B.
// Reorder one and you must re-derive the other.
const LADDER = [
  { tok: 250e3, id: 'first_light', title: '🔥 First light', mon: 1, lm: null },
  { tok: 1e6, id: 'well', title: '🪣 1M tokens!', mon: 2, lm: 'well' },
  { tok: 5e6, id: 'smithy', title: '🔨 5M tokens!', mon: 3, lm: 'smithy' },
  { tok: 10e6, id: 'market_day', title: '🌾 10M tokens!', mon: 4, lm: 'mill' },
  { tok: 25e6, id: 'market_cross', title: '🪧 25M tokens!', mon: 5, lm: 'market_cross' },
  { tok: 50e6, id: 'tithe_barn', title: '🧺 50M tokens!', mon: 6, lm: 'tithe_barn' },
  { tok: 100e6, id: 'market_hall', title: '🎪 100M tokens!', mon: 7, lm: 'market_hall' },
  { tok: 250e6, id: 'chapel', title: '⛪ 250M tokens!', mon: 8, lm: 'chapel' },
  { tok: 500e6, id: 'bell', title: '🔔 500M tokens!', mon: 9, lm: 'bell_tower' },
  { tok: 1e9, id: 'green', title: '🌳 1 BILLION tokens', mon: 10, lm: 'village_green' },
  { tok: 2.5e9, id: 'inn', title: '🍺 The Inn opens — 2.5B', mon: null, lm: 'inn' },
  // Past the inn the ladder used to fall through to anonymous "+5.00B at 35.00B"
  // ticks: no title, no celebration, no Crier line (MILESTONE and LANDMARK both
  // need a {title}). The user's real all-time is 31.68B, so the best day the app
  // would ever show was also the first one that stopped rewarding them. The
  // fountain is capped at tier 10 and the landmark set is complete by 2.5B —
  // these rungs are pure horizon, and that is all they need to be.
  { tok: 5e9, id: 'reckoning', title: '🧭 The Long Reckoning — 5B', mon: null, lm: null },
  { tok: 10e9, id: 'ten_billion', title: '🏔 TEN BILLION tokens', mon: null, lm: null },
  { tok: 25e9, id: 'uncountable', title: '♾ The Uncountable — 25B', mon: null, lm: null },
  { tok: 50e9, id: 'half_hundred', title: '🌋 Fifty Billion', mon: null, lm: null },
  { tok: 100e9, id: 'centenary', title: '👑 ONE HUNDRED BILLION', mon: null, lm: null }
];
const LM_ORDER = LADDER.filter(m => m.lm).map(m => m.lm);
// Named rungs past the landmark set carry their own title (stripped of its emoji
// and its trailing "— 2.5B", which the meter prints beside it anyway).
const titleWord = m => String(m.title || '').replace(/^[^\w]+\s*/, '').replace(/\s+—.*$/, '');
// The chrome dropped emoji for `◷ ❖ ★` because they were the only raster-styled
// glyphs in a flat vector UI, but the same characters were still being minted
// into the 3D overlay — every ladder title, on the altar's title plate and as a
// 26 px floater over the rooftops, where a monochrome fallback house glyph next
// to "450 buildings!" is exactly the mismatch the purge existed to remove. One
// helper, used at every call site that puts a ladder title on screen.
const plainTitle = s => String(s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
const rungName = m => m.best ? (m.label || "the last window's mark") : m.tick ? '+' + fmtTok(m.amount || 100e6)
  : m.lm ? (LANDMARK_DEFS[m.lm] || { label: m.lm }).label
    : m.id === 'first_light' ? 'First light' : (titleWord(m) || 'the next reckoning');
// A "beat the previous window" rung, spliced in at its place the moment the feed
// tells us what the previous window was. Every other rung is an absolute round
// number; this is the only finish line the user set themselves, and it is the
// one that makes the number feel worth growing.
function spliceBestRung(tok, label) {
  if (!(tok > 0) || LADDER.some(m => m.best)) return;
  // THIRD PERSON, like the Crier and the Almanac. The title was 'Beat your last
  // window!' — a second-person imperative on the one rung that fires with a gold
  // burst, which is precisely what the copy gate forbids. The town has passed a
  // mark; it is not issuing an instruction.
  const nm = String(label || '').replace(/^beat /, '') || 'the last window';
  const rung = { tok, id: 'best', title: '🏅 Past ' + nm + '!', mon: null, lm: null, best: true, label: nm };
  let i = 0;
  while (i < LADDER.length && LADDER[i].tok < tok) i++;
  LADDER.splice(i, 0, rung);
  // `mileIdx` is an index INTO this array. On a fresh epoch hardReset has just
  // zeroed it, but a same-epoch re-init whose previous window only became
  // comparable on the second read splices below a cursor that is already at the
  // end — every rung at or after `i` shifts up one, the cursor lands on a rung it
  // has already consumed, and that rung re-fires: mileCount inflates and a full
  // celebration plays for a milestone passed hours ago.
  if (i <= mileIdx) mileIdx++;
}

/* ═══ test hooks ════════════════════════════════════════════════ */
const Q = new URLSearchParams(location.search);
const HOUR_OVERRIDE = Q.get('hour') === null ? null : +Q.get('hour');
const TOK_OVERRIDE = Q.get('tokens') === null ? null : Number(Q.get('tokens'));
const STILL = Q.get('still') === '1';
const DEMO_MS = Q.get('demo') === 'slow' ? 4400 : Q.get('demo') === 'fast' ? 900 : 2200;
// ?feed=demo takes the no-bridge path even inside the shell. The standalone
// browser path is an invariant, and this is the only way to screenshot it
// without opening a real browser window on the user's screen.
const FORCE_DEMO = Q.get('feed') === 'demo';
// ?seed=N overrides planSeed AND daySeed — that is how three consecutive days
// (or three different townships) are screenshotted side by side.
const SEED_OVERRIDE = Q.get('seed') === null ? null : (Number(Q.get('seed')) >>> 0);
const INTRO_OFF = Q.get('intro') === '0';
const RANGE_HINT = Q.get('range');       // demo mode only; the feed owns the real one
// The headless perf harness. `bench.js` is imported ONLY behind this flag (a
// dynamic import at the bottom of the file), so the normal path pays nothing.
const BENCH_ON = Q.get('bench') !== null;
// "Nobody is watching this in real time." A --shot or --bench run opens the
// window with show:false, so the document is hidden from the first frame — and
// main.js forwards no flag that says so. It is the only signal the page has, and
// it is the right one: it pins postfx's quality tier, so a verification image is
// never graded differently from an interactive frame just because a headless
// window paints at 1 fps. (A window the user starts minimised reads the same
// way; the cost is that it never auto-downgrades, which is not a cost.)
const HEADLESS = BENCH_ON
  || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
let bench = null, benchPinned = false;
// ?chronicle=demo|fake fabricates a 46-day record so the ghost town, the records
// stone and the almanac can be photographed on a machine whose real history is
// one afternoon long; ?chronicle=off pretends the feed sent none, which is the
// "a v3 feed renders exactly v3" half of the acceptance. The synthetic days are
// minted ONCE, here, so every epoch inside a run reads the same fake past.
const CHRON_FLAG = Q.get('chronicle');
const CHRON_OFF = CHRON_FLAG === 'off';
const CHRON_SYNTH = (CHRON_FLAG === 'demo' || CHRON_FLAG === 'fake')
  ? synthChronicle(Date.now()) : null;
// Every run that fabricates the number, the seed or the clock is SYNTHETIC: it
// may never write to the chronicle, or a verification screenshot awards TEN
// BILLION forever. main.js decides the same thing for the store's own writes.
const SYNTHETIC = FORCE_DEMO || TOK_OVERRIDE !== null || SEED_OVERRIDE !== null
  || HOUR_OVERRIDE !== null || STILL || BENCH_ON || CHRON_SYNTH !== null;

/* ═══ seeds — the ONLY place they are derived (§11.1) ═══════════ */
// planSeed = FNV-1a(epochId) from the feed: layout, archetype, river, town name.
//   It changes when the epoch changes, so today→last30 is a different township.
// daySeed  = the local calendar date: palette, wash, biome, NPC wardrobe.
//   Range changes what is COUNTED; it never changes daySeed, which is what makes
//   the town repaint each morning even on a 30-day window.
const daySeedOf = ms => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
let planSeed = SEED_OVERRIDE === null ? fnv1a('token-town') : SEED_OVERRIDE;
let daySeed = SEED_OVERRIDE === null ? daySeedOf(Date.now()) : SEED_OVERRIDE;
let seedHex = planSeed.toString(16).toUpperCase().slice(-4);

/* ═══ solar clock ═══════════════════════════════════════════════ */
let lat = 50, sunSr = 6, sunSs = 20;
function computeSun() {
  const d = new Date(), start = new Date(d.getFullYear(), 0, 0);
  const doy = Math.floor((d - start) / 864e5);
  const decl = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365) * Math.PI / 180;
  const cosH = clamp(-Math.tan(lat * Math.PI / 180) * Math.tan(decl), -1, 1);
  const half = Math.acos(cosH) / (2 * Math.PI) * 24;
  sunSr = 12 - half; sunSs = 12 + half;
  const f = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(h % 1 * 60)).padStart(2, '0')}`;
  document.getElementById('sunTxt').textContent = `${f(sunSr)} → ${f(sunSs)}`;
}
computeSun();
const dayAmount = h => {
  if (h < sunSr - 1.2 || h > sunSs + 1.2) return 0;
  if (h > sunSr + .9 && h < sunSs - .9) return 1;
  return h < 12 ? (h - (sunSr - 1.2)) / 2.1 : ((sunSs + 1.2) - h) / 2.1;
};

/* ═══ renderer / scene ══════════════════════════════════════════ */
const stage = document.getElementById('stage');
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// The sun moves a few thousandths of a radian per frame and the casters never
// move once placed, so ~59 of every 60 depth passes were redundant. The pass is
// re-armed from the half-second stats timer and after every structural change.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
const MAXA = renderer.capabilities.getMaxAnisotropy();
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b0e14, .0026);
// far must clear the sky dome from the FAR side of the orbit: the camera sits up
// to 340 units off-centre on a big town, so a 900 far plane sliced a black hole
// out of the dome exactly where the camera looks.
const camera = new THREE.PerspectiveCamera(46, 2, .5, 2600);

// r155+ removed legacy lights: directional/hemisphere need roughly ×π vs the
// old demo values, point lights are physical (candela) and need real numbers.
const LI = Math.PI;
const hemi = new THREE.HemisphereLight(0xbdd3ea, 0x3b4028, .5 * LI); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe0b0, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 5, far: 400 });
sun.shadow.bias = -0.0014;
scene.add(sun); scene.add(sun.target);
const moon = new THREE.DirectionalLight(0x8ea4c8, .16 * LI); scene.add(moon);
// The sun ball lives on its own dome at a FIXED radius with an elevation floor.
// Placed at 2.2 × the light's position it sat at y≈35 on a 270-unit ray — below
// the camera, hence behind the ground plane, hence never once visible.
const SUN_R = 720, SUN_EL_MIN = .30;
const sunBall = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffeec4, fog: false }));
sunBall.scale.setScalar(17); sunBall.renderOrder = 0;
scene.add(sunBall);
const sunHalo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
  map: makeGlowTexture(), transparent: true, opacity: .5, blending: THREE.AdditiveBlending,
  depthWrite: false, depthTest: false, fog: false, color: 0xffd9a0
}));
sunHalo.scale.setScalar(150); sunHalo.renderOrder = 1;
scene.add(sunHalo);
function makeGlowTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(.16, 'rgba(255,232,190,.72)');
  gr.addColorStop(.42, 'rgba(255,196,120,.20)');
  gr.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Gradient sky dome: a flat background color makes the horizon read as a wall,
// and it gives us a warm band at sunrise/sunset for free.
const skyMat = new THREE.ShaderMaterial({
  uniforms: { top: { value: new THREE.Color() }, bot: { value: new THREE.Color() } },
  vertexShader: `varying float vh;
    void main(){ vh = normalize(position).y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform vec3 top; uniform vec3 bot; varying float vh;
    void main(){ gl_FragColor = vec4(mix(bot, top, clamp(vh * 1.7 + 0.12, 0.0, 1.0)), 1.0); }`,
  side: THREE.BackSide, depthWrite: false, fog: false
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(820, 24, 16), skyMat);
skyDome.renderOrder = -1; scene.add(skyDome);

// Two layers, not one: a single 520-point field at one size read as a dozen
// specks over a huge empty black rectangle. Faint many + bright few gives depth.
const starMats = [];
for (const [n, size, op, col] of [[1200, .95, .62, 0xb9c4d8], [340, 2.1, 1, 0xf2f5ff]]) {
  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), e = rand(.03, 1.45), r = 420;
    p[i * 3] = Math.cos(a) * Math.cos(e) * r; p[i * 3 + 1] = Math.sin(e) * r; p[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ color: col, size, transparent: true, opacity: 0, fog: false, depthWrite: false });
  m.userData.peak = op; starMats.push(m);
  const pts = new THREE.Points(geo, m); pts.frustumCulled = false; scene.add(pts);
}

/* ═══ the road plate ════════════════════════════════════════════ */
// town.js owns the decal mesh, its canvas and the texture's lifetime; layout.js
// owns everything drawn on it (plan.paintGround). The plate is one 2048² canvas
// repainted only when the frontier band or the plaza radius changes — a few
// times an hour, never per frame.
const ROAD_S = 2048, ROAD_SPAN = 2 * (LAYOUT.MAX_R + 40), ROAD_PX = ROAD_S / ROAD_SPAN;
const roadCanvas = document.createElement('canvas');
roadCanvas.width = roadCanvas.height = ROAD_S;
const roadCtx = roadCanvas.getContext('2d');
const roadTex = new THREE.CanvasTexture(roadCanvas);
roadTex.colorSpace = THREE.SRGBColorSpace; roadTex.anisotropy = MAXA;
// 'ground': the far-land colour match only. No rim — a ground plane is all
// grazing angles, so a fresnel term would set the whole horizon alight — and no
// base AO, because its world y is already zero.
const roadMat = surface.applyTownSurface(new THREE.MeshStandardMaterial({
  map: roadTex, transparent: true, roughness: .95, depthWrite: false, opacity: 1
}), 'ground');
const roads = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_SPAN, ROAD_SPAN), roadMat);
roads.rotation.x = -Math.PI / 2; roads.position.y = .02; roads.receiveShadow = true; scene.add(roads);
const roadX = (x, z) => [ROAD_S / 2 + x * ROAD_PX, ROAD_S / 2 + z * ROAD_PX];
let roadBand = -2, roadPlaza = -1, scafDirty = true;
// The town PAVES AS IT GROWS, but it is platted first: the frontier used for the
// plate is the town the current total has already paid for, so the founding
// ritual can draw the day's whole shape before a single house exists.
const plannedN = () => clamp(Math.max(built, townSize(T)), 0, plan.capacity);
function updateRoads(band) {
  if (band === roadBand && Math.abs(ctx.plazaR - roadPlaza) < .4) return;
  roadBand = band; roadPlaza = ctx.plazaR;
  const fr = plan.frontierOf(plannedN());
  const fk = fr.k;
  roadCtx.save();
  roadCtx.clearRect(0, 0, ROAD_S, ROAD_S);
  // outerR trims lanes that loop out past the plat; builtN keeps a forecourt from
  // being painted under a landmark that is still 200 buildings from unlocking.
  const _pg = BENCH_ON ? performance.now() : 0;
  plan.paintGround(roadCtx, roadX, {
    frontierK: fk, px: ROAD_PX, wear: 1, plazaR: ctx.plazaR,
    outerR: fr.r, builtN: Math.max(built, houses.length)
  });
  if (bench) { bench.add('paintGroundCalls'); bench.add('paintGroundMs', performance.now() - _pg); }
  roadCtx.restore();
  roadTex.needsUpdate = true;
  revealVerge(fk); revealLamps(fk);
  scafDirty = true;
  renderer.shadowMap.needsUpdate = true;
}

/* ═══ camera ════════════════════════════════════════════════════ */
// THE RIG OWNS THE CAMERA (camera.js). Everything that used to live here —
// az/pol/dist, the drag and wheel listeners, the dolly bias, the fit bias and
// applyCam — moved there behind one goal-and-follower law. town.js keeps only
// what is not the camera's: the sun's shadow centre, and the framing REQUEST.
const sunCtr = new THREE.Vector3();          // the shadow frustum's centre
let shadowArmedAt = -1e9;                    // ≤ 12 Hz re-arm while the rig is moving
function refreshFraming() {
  // FRAME WHAT EXISTS. `built` is the count the total has already PAID for, so
  // during a founding cascade it is the final number from the first frame — the
  // camera snapped straight out to the finished plat and the user's first fifteen
  // seconds were 140 houses adrift in a vast empty plain crossed by bare road
  // loops. Framing the spawned bounds lets the camera ease outward as the town
  // lands under it, which is the whole point of the ritual.
  const shown = spawnQ.length ? Math.max(1, Math.min(built, houses.length)) : Math.max(built, 1);
  const b = plan.boundsFor(shown);
  ctx.bounds.cx = b.cx; ctx.bounds.cz = b.cz; ctx.bounds.r = b.r;
  ctx.bounds.hx = b.hx; ctx.bounds.hz = b.hz;
  ctx.outerR = b.r;
  updateRoads(plan.bandOf(Math.max(plannedN() - 1, 0)));
  // THE FRAMING REQUEST, and nothing else. The rig owns the curve (it is v3's,
  // moved verbatim), the target height, the fit bias and whether the wheel has
  // taken the distance away from it. It writes only the ORBIT goal, in every
  // mode, which is what makes leaving focus/follow/tour free.
  rig.setFrame(b, monument.crownHeight || 8);
  // The fog density is now written per frame from rig.fogDist — the distance is
  // continuous, and a once-per-structural-change write left the fog eight
  // seconds stale through a tour. The weather multiplier is applied at both
  // sites so a re-frame can never stamp the mist away.
  scene.fog.density = fogFor(rig.fogDist, env.biome) * wx.grade.fogMul;
  env.setExtent({ inner: ctx.plazaR, outer: b.r });
  armShadow(true);
  renderer.shadowMap.needsUpdate = true;
}
// Nothing past band 4 casts (see mountEnt), so sizing the shadow frustum to the
// whole town threw away three quarters of a 2048 map. The frustum follows the
// subject — the town's centre of mass in the wide modes, the followed villager
// in the close ones — via the sun's TARGET, and it is re-armed at ≤ 12 Hz while
// the rig is moving rather than only on a structural change.
function armShadow(force) {
  const ext = rig.shadowExtent;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext });
  sun.shadow.camera.updateProjectionMatrix();
  sunCtr.copy(rig.shadowCenter);
  sun.target.position.copy(sunCtr); sun.target.updateMatrixWorld();
  if (force) renderer.shadowMap.needsUpdate = true;
}

/* ═══ street furniture: lamps, benches, verge scatter ═══════════ */
// All three are keyed to the PLAN now: lamps stand at real junctions, the verge
// is strewn along real streets, and everything is revealed as its street is
// paved. Pools are allocated once and re-posed per epoch — an epoch change must
// never mint geometry.
const lampGlow = [];
const roadLamps = [];               // {g, d} — hidden until their street is paved
const plazaLamps = [];
const POOL_GEO = new THREE.CircleGeometry(4.6, 20).rotateX(-Math.PI / 2);
const POOL_MAT = new THREE.MeshBasicMaterial({
  map: makeGlowTexture(), color: 0xffbf72, transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});
function addLamp(withLight) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(GEO.pole, MAT.lampPole);
  pole.position.y = 1.45; pole.castShadow = true; g.add(pole);
  const bulbM = MAT.bulb.clone();
  const bulb = new THREE.Mesh(GEO.bulb, bulbM); bulb.position.y = 3; g.add(bulb);
  let pt = null;
  if (withLight) { pt = new THREE.PointLight(0xffd68c, 0, 20, 2); pt.position.y = 3.05; g.add(pt); }
  // Beyond the plaza the road lamps were emissive bulbs with no light at all, so
  // the streets were simply dark. A warm additive disc on the ground costs a
  // shared geometry and ONE material (whose opacity is driven by night) for the
  // whole town — thirty PointLights would not survive the frame budget.
  const pool = new THREE.Mesh(POOL_GEO, POOL_MAT);
  pool.position.y = .04; pool.renderOrder = 2; g.add(pool);
  scene.add(g); lampGlow.push({ bulbM, pt });
  return g;
}
for (let i = 0; i < 6; i++) plazaLamps.push(addLamp(true));      // these carry real light
for (let i = 0; i < 26; i++) roadLamps.push({ g: addLamp(false), d: 1e9 });
function placePlazaLamps() {
  const R = ctx.plazaR + 1.4;
  plazaLamps.forEach((g, i) => {
    const a = i / 6 * Math.PI * 2 + .52;
    g.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
  });
}
// Junctions, not circles: a lamp belongs where streets meet, which is also the
// only placement that survives an organic plan.
function placeRoadLamps() {
  const nodes = plan.graph.nodes.filter(n => !n.hub && n.adj.length >= 3);
  // T-12: a town whose people are out after dark lights more of its junctions.
  // This only ever reveals more of the EXISTING 26-lamp pool — it never mints a
  // lamp — and `lanternMul` is exactly 1 at confidence 0.
  const gate = clamp(.34 * (shift.dress.lanternMul || 1), .34, .62);
  let k = 0;
  for (let i = 0; i < nodes.length && k < roadLamps.length; i++) {
    if (seededR(planSeed * .0007 + i * 1.7) > gate) continue;
    const n = nodes[i], L = roadLamps[k++];
    L.g.position.set(n.x + (seededR(i * 3.3) - .5) * 1.6, 0, n.z + (seededR(i * 5.1) - .5) * 1.6);
    L.d = n.d;
  }
  for (; k < roadLamps.length; k++) { roadLamps[k].d = 1e9; roadLamps[k].g.visible = false; }
}
const revealLamps = fk => { for (const L of roadLamps) L.g.visible = L.d <= fk; };
for (let i = 0; i < 4; i++) {                       // benches, clear of the worship arcs
  const a = i / 4 * Math.PI * 2 + .26, R = 10.6;
  const b = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, .16, .62), MAT.wood);
  seat.position.y = .52; b.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, .5, .12), MAT.wood);
  back.position.set(0, .8, -.26); b.add(back);
  for (const dx of [-.9, .9]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(.14, .5, .5), MAT.stoneDark);
    leg.position.set(dx, .26, 0); b.add(leg);
  }
  b.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
  b.rotation.y = -a + Math.PI / 2;
  b.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(b);
}
// Verge dressing — bushes and rocks 9-14 units off a street's centreline. This
// is TOWN dressing, not countryside (environs owns everything past the verge),
// and it is earned street by street: strewing it to the horizon around a
// twenty-house village reads as litter.
const VERGE_N = 240;
const vergeBush = new THREE.InstancedMesh(GEO.bush, MAT.bush, VERGE_N);
const vergeRock = new THREE.InstancedMesh(GEO.rock, MAT.rock, VERGE_N);
for (const im of [vergeBush, vergeRock]) {
  im.castShadow = true; im.receiveShadow = true; im.count = 0;
  im.frustumCulled = false; scene.add(im);
}
const vergeSpots = [[], []];       // [bushes, rocks] — {m:Matrix4, y, d}
function buildVerge() {
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  vergeSpots[0].length = 0; vergeSpots[1].length = 0;
  const edges = plan.graph.edges, nodes = plan.graph.nodes;
  for (let i = 0; i < edges.length && vergeSpots[0].length + vergeSpots[1].length < VERGE_N * 2; i++) {
    const r0 = seededR(i * 2.9 + planSeed * .0011);
    if (r0 > .40) continue;                                   // ~2 streets in 5
    const e = edges[i];
    if (e.bridge) continue;
    const a = nodes[e.a], b = nodes[e.b];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const t = .22 + seededR(i * 7.7) * .56, side = seededR(i * 4.4) < .5 ? 1 : -1;
    const off = 9 + seededR(i * 6.1) * 5;
    const x = a.x + dx * t - dz / len * off * side;
    const z = a.z + dz * t + dx / len * off * side;
    if (Math.hypot(x, z) > LAYOUT.MAX_R || plan.isWet(x, z)) continue;
    const rock = seededR(i * 8.3) < .35, arr = vergeSpots[rock ? 1 : 0];
    if (arr.length >= VERGE_N) continue;
    const s = rock ? .5 + seededR(i * 9.1) * .7 : .7 + seededR(i * 9.1) * .8;
    const y = (rock ? .26 : .44) * s;
    _e.set(rock ? seededR(i * 1.3) * 3 : 0, seededR(i * 2.1) * 6, 0);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(s, s, s));
    arr.push({ m: _m.clone(), y, d: e.d });
  }
  vergeBush.count = vergeSpots[0].length;
  vergeRock.count = vergeSpots[1].length;
}
// Out-of-range instances are parked below the world (the revealScatter idiom).
function revealVerge(fk) {
  const _m = new THREE.Matrix4();
  const pass = (im, spots) => {
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      _m.copy(s.m); _m.elements[13] = s.d <= fk ? s.y : -999;
      im.setMatrixAt(i, _m);
    }
    im.instanceMatrix.needsUpdate = true;
  };
  pass(vergeBush, vergeSpots[0]); pass(vergeRock, vergeSpots[1]);
}

/* ═══ particles, chimney smoke, floaters ════════════════════════ */
const MAXP = 600;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const parts = Array.from({ length: MAXP }, () => ({ life: 0 }));
// Rescaled per frame: the pool was calibrated for the launch camera, so at a
// wide framing every celebration was a sprinkle of 3-pixel dust — the moments
// meant to reward success scaled worst with it. `fx` also multiplies burst
// speeds at the call sites so a burst still spreads to a readable radius.
const pMat = new THREE.PointsMaterial({ size: .34, vertexColors: true, transparent: true, opacity: .95, depthWrite: false });
let fx = 1;
scene.add(new THREE.Points(pGeo, pMat));
function burst3d(v, colorHex, n, spd = 6) {
  const c = new THREE.Color(colorHex);
  for (let i = 0; i < MAXP && n > 0; i++) {
    const p = parts[i]; if (p.life > 0) continue;
    n--;
    p.life = p.max = rand(.5, 1.1);
    // Absolute death stamp. Ageing on the step the pool is handed means a 1.1 s
    // particle needs a minimum NUMBER OF FRAMES to expire, and a heavy town paints
    // at ~1 fps: confetti and chimney smoke sat frozen on the rooftops for the
    // length of a headless run. The integration still uses dt; only the lifetime
    // is on the clock.
    p.death = performance.now() + p.life * 1000;
    p.x = v.x; p.y = v.y; p.z = v.z;
    const a = rand(0, Math.PI * 2), e = rand(.3, 1.4), s = rand(spd * .4, spd) * fx;
    p.vx = Math.cos(a) * Math.cos(e) * s; p.vy = Math.sin(e) * s; p.vz = Math.sin(a) * Math.cos(e) * s;
    pCol[i * 3] = c.r; pCol[i * 3 + 1] = c.g; pCol[i * 3 + 2] = c.b;
  }
}
function stepParts(dt, now) {
  for (let i = 0; i < MAXP; i++) {
    const p = parts[i];
    if (p.life > 0) {
      if (now >= p.death) { p.life = 0; pPos[i * 3 + 1] = -999; continue; }
      p.life -= dt; p.vy -= 14 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0) { p.y = 0; p.vy *= -.3; }
      pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
    } else pPos[i * 3 + 1] = -999;
  }
  pGeo.attributes.position.needsUpdate = true;
}
// Smoke needs its own pool: PointsMaterial.size is global, and smoke wants to
// be big, slow and gravity-free.
const MAXPUFF = 96;
const uGeo = new THREE.BufferGeometry();
const uPos = new Float32Array(MAXPUFF * 3).fill(-999);
uGeo.setAttribute('position', new THREE.BufferAttribute(uPos, 3));
const puffs = Array.from({ length: MAXPUFF }, () => ({ life: 0 }));
// Pure white at .42 was the loudest value in the scene — a field of blue roofs
// wearing white confetti. Smoke is grey, and it is a mood, not a subject.
const puffMat = new THREE.PointsMaterial({ size: .9, color: 0xA8A49A, transparent: true, opacity: .24, depthWrite: false });
// Chimneys thin out as the town grows: at 780 keeps every roof emitted on its own
// cadence into a 96-slot pool, so the pool was permanently saturated with stale
// puffs and none of them ever got to disperse.
let smokeK = 1;
scene.add(new THREE.Points(uGeo, puffMat));
function puff3d(v, size = 1) {
  for (let i = 0; i < MAXPUFF; i++) {
    const p = puffs[i]; if (p.life > 0) continue;
    p.life = rand(2.2, 3.4);
    p.death = performance.now() + p.life * 1000;
    p.x = v.x + rand(-.12, .12) * size; p.y = v.y; p.z = v.z + rand(-.12, .12) * size;
    p.vx = rand(-.18, .18) * size; p.vy = .55; p.vz = rand(-.18, .18) * size;
    return;
  }
}
function stepPuffs(dt, now) {
  for (let i = 0; i < MAXPUFF; i++) {
    const p = puffs[i];
    if (p.life > 0) {
      if (now >= p.death) { p.life = 0; uPos[i * 3 + 1] = -999; continue; }
      p.life -= dt;
      p.x += (p.vx + .25) * dt; p.y += p.vy * dt; p.z += (p.vz + .1) * dt;
      uPos[i * 3] = p.x; uPos[i * 3 + 1] = p.y; uPos[i * 3 + 2] = p.z;
    } else uPos[i * 3 + 1] = -999;
  }
  uGeo.attributes.position.needsUpdate = true;
}
const overlay = document.getElementById('overlay'), hintEl = document.getElementById('hint');
let floaters = [];
function floatText(v, txt, color, big) {
  if (floaters.length > 14) return;
  const el = document.createElement('div');
  el.className = big ? 'floater big' : 'floater'; el.textContent = txt;
  if (color) el.style.color = color;
  overlay.appendChild(el);
  floaters.push({ el, v: v.clone(), born: performance.now() });
}
// wall-clock scheduler for celebration choreography
const fxQ = [];
const schedule = (delay, fn) => fxQ.push({ at: performance.now() + delay, fn });
function drainFx(now) {
  for (let i = 0; i < fxQ.length;) {
    if (now >= fxQ[i].at) { const f = fxQ.splice(i, 1)[0]; f.fn(); } else i++;
  }
}

/* ═══ town state ════════════════════════════════════════════════ */
// Declared before the module inits below: initNPCs may call getBuildings()
// while wiring itself up.
// `cell` STAYS keyed by model — the DB emits one upsertable row per (bucket,
// model) and the delta logic depends on it. Nothing else in the renderer may
// read the model dimension: attribution is dead (§12).
const cell = new Map();     // "<bucket>|<model>" → absolute tokens (upsert-proof)
const bins = new Map();     // bucket ms → {tok, w} — the pace/median sample
// Bumped on every mutation of `bins`, above the deed card's prefix sum (paidFor):
// declared here, beside the map it guards, because foldRow runs long before that
// section in source order.
let binsVer = 0;
let T = 0, Tfloor = 0, Tsum = 0, built = 0;
// The smallest house count this plan could not be relaxed to hold; Infinity until
// ensureCapacity actually falls short. See syncTown.
let capFail = Infinity;
let gotData = false, demoMode = false;
const houses = [];                  // ordinal-1 → entity
const landmarks = new Map();        // kind → entity
const bridgeEnts = new Map();       // bridge index → entity
const groves = [];                  // idle-time woodland on the verge
const animEnts = [];                // everything with a group we animate
const hitTargets = [];              // hover-testable groups only
const spawnQ = [], promoQ = [], mileQ = [], rawList = [], risers = [];
let mileIdx = 0, minorAt = 0, mileAt = 0, mileCount = 0;
let lastBand = -1e9, lastFrontier = -1;
let idleSince = 0, idleToldAt = 0, grove = null;
let lastLandmark = '';

const tagEnt = (g, e) => g.traverse(o => { o.userData.ent = e; });
function addHit(g) { hitTargets.push(g); }
// The contact shadow, for EVERY entity whatever band it is in — the sun's
// frustum stops at ±74 units and nothing past band 4 casts, so four buildings in
// five are stickers on a green tablecloth without one. The radius is the group's
// own footprint span plus a tenth of its height, which is what makes a cathedral
// sit heavier on the ground than a cottage.
function groundEnt(e, g) {
  if (!e || e.idx == null) return;
  grounding.place(e.idx, g.position.x, g.position.z,
    1.55 * (g.userData.span || 1) + .10 * (e.hTop || 0), e.hTop || 0);
}
function dropGroup(g) {
  const e = g.userData && g.userData.ent;
  if (e && e.idx != null) grounding.clear(e.idx);
  // Release the LOD slot BEFORE the group goes: lod.clear() hands the group back
  // visible, and a demolished ordinal must stop answering pick() in the same
  // breath. Covers remountEnt (promotion, frontier finish) and hardReset alike.
  if (e && e.kind === 'house' && e.n > 0) { lod.clear(e.n - 1); e.cold = false; }
  // Not `scene.remove` — a settled house lives under coldRoot, and in mode A
  // coldRoot is not even in the scene. Ask the group where it actually is.
  if (g.parent) g.parent.remove(g);
  const i = hitTargets.indexOf(g); if (i >= 0) hitTargets.splice(i, 1);
  disposeGroup(g);
}
/**
 * The hand-off, run once per house the frame its pop-in finishes: out of the
 * animating root, into the cold one, and into lod's registry with the silhouette
 * buildings.js derived at build time. From here on this group is invisible to
 * `hitTargets` and findable only through `lod.pick()` (§8.1) — which is exact in
 * every tier, so an impostored building is as clickable as a real one.
 * A NULL IMPOSTOR IS NOT LEGAL HERE, and this comment used to say the opposite.
 * lod.js's contract is explicit: register a building only if its group lives
 * OUTSIDE `coldRoot`, because in mode A coldRoot is detached and a FULL-pinned
 * building whose group is in it has no copy left to draw. Landmarks, bridges and
 * the monument satisfy that by never being registered at all; a HOUSE cannot,
 * because settling is what puts it in coldRoot. So the honest handling is to leave
 * an underivable house exactly where it is — hot, hit-testable and real. Nothing
 * shipped hits this path (all seven flavours have wall-tagged mass or an explicit
 * override), and the cost of being wrong is a contact shadow with no building over
 * it in every large town, so it is worth the four lines.
 */
function settleToLod(e, g) {
  if (LOD_OFF || e.cold || e.kind !== 'house' || !(e.n > 0)) return;
  const imp = deriveImpostor(g);
  if (!imp || !(imp.w > 0 && imp.h > 0 && imp.d > 0)) return;   // stays hot, stays clickable
  e.cold = true;
  if (g.parent !== coldRoot) { if (g.parent) g.parent.remove(g); coldRoot.add(g); }
  const i = hitTargets.indexOf(g); if (i >= 0) hitTargets.splice(i, 1);
  // lod owns this group's visibility now; a second frustum test would only ever
  // agree with the one lod already ran, over ~4 meshes per house.
  g.traverse(o => { o.frustumCulled = false; });
  lod.set(e.n - 1, g.position.x, g.position.z, g.rotation.y, g.scale.x, imp);
}

/* ═══ module wiring — palette → plan → environs → altar → folk ══ */
initPalette(daySeed);
let plan = buildPlan(planSeed);

const MON_POS = new THREE.Vector3(0, 0, 0);
const _bnd = { cx: 0, cz: 0, r: 40, hx: 40, hz: 40 };

/**
 * Per-frame read-only town context. Owned and mutated in place by town.js.
 * Units: world units for distance (a Cottage is ~3 wide, ~3.5 tall), milliseconds
 * for now/simNow/durations, seconds for dt, radians for angles, raw tokens.
 * @typedef {Object} TownCtx
 * @property {number} day            daylight 0..1 (0 = full night)
 * @property {number} night          1 - day
 * @property {number} simNow         Date.now() sampled at frame start, ms
 * @property {THREE.PerspectiveCamera} camera
 * @property {number} totalTok       T — tokens in the selected range (monotonic
 *                                   within an epoch)
 * @property {number} buildingCount  N — houses standing right now
 * @property {number} perMin         tokens/min over the last ~30 min of buckets
 * @property {number} paceRatio      perMin ÷ this epoch's median perMin; 1 = on trend
 * @property {Plan} plan             the current epoch's street plan; never null
 * @property {number} frontierK      growth-order key of the outermost BUILT plot
 * @property {number} band           plan.bandOf(built-1); -1 before the first building
 * @property {{cx:number,cz:number,r:number}} bounds   mutated in place
 * @property {number} outerR         === bounds.r
 * @property {number} plazaR         LIVE plaza radius, 12..15.5
 * @property {THREE.Vector3} monumentPos
 * @property {()=>Array<{pos:THREE.Vector3,yaw:number}>} getBuildings
 * @property {Palette} palette       today's palette; re-pointed once per epoch
 * @property {number} accent @property {string} accentCss
 * @property {number} dominantColor  DEPRECATED ALIAS of accent
 * @property {string} dominantCss    DEPRECATED ALIAS of accentCss
 * @property {number} daySeed @property {number} planSeed @property {string} seedHex
 * @property {string} townName
 * @property {string} rangeKey @property {string} rangeLabel @property {string} rangeShort
 * @property {number} rangeStartMs @property {boolean} rangeIsDay
 * @property {number} intro          0..1 founding-ritual progress; 1 = settled
 */
const ctx = {
  day: 1, night: 0, simNow: Date.now(), camera,
  totalTok: 0, buildingCount: 0, perMin: 0, paceRatio: 1,
  plan, frontierK: 0, band: -1, bounds: _bnd, outerR: 40, plazaR: 12,
  monumentPos: MON_POS, getBuildings: buildingsForNPCs,
  palette: palette(), accent: dayAccent(), accentCss: '#' + dayAccent().toString(16).padStart(6, '0'),
  dominantColor: dayAccent(), dominantCss: '#' + dayAccent().toString(16).padStart(6, '0'),
  daySeed, planSeed, seedHex, townName: 'Token Town',
  rangeKey: 'today', rangeLabel: 'Today', rangeShort: 'today',
  // 0, not 1, until the first real init lands. The placeholder epoch has a
  // placeholder seed, and with intro at 1 the Crier immediately started filing
  // ambient copy about a town that was never the user's — "Founding of Old
  // Promptholm, again. Fourth time this week." — which was then demolished two
  // seconds later when the feed arrived. The empty plaza is the cold open.
  rangeStartMs: 0, rangeIsDay: true, intro: 0,
  // v4 — set to the real modules as their stages land. `store` is the chronicle
  // store's renderer-side handle (main.js owns the file; this is the only way in).
  chronicle: null, wx: null, store: (window.townAPI && window.townAPI.chronicle) || null
};

/* ═══ v4 null objects (§3) ══════════════════════════════════════ */
// Stages E–H swap the real modules in at these names. Until then each is a
// frozen no-op with the EXACT shape its call sites read, so every call site in
// this file is written once and never touched again — and so a half-landed wave
// is a runnable app rather than a pile of `x && x.y()` guards. Every neutral
// value here is exactly neutral: the weather grade is 1.0/0.0 to the bit, so
// wiring it changes nothing until weather.js arrives.
const NOOP = () => { };
// stage H — weather.js needs `env.biome`, so like memorial and almanac it is
// built where env is and stands as an exactly-neutral grade until then.
let wx = {                                      // stage H — weather.js
  id: 'clear', glyph: '', label: '', __draws: 0,
  grade: Object.freeze({
    sunMul: 1, hemiMul: 1, moonMul: 1, sunBallA: 1, skyTintK: 0,
    fogTint: 0x000000, fogTintK: 0, fogMul: 1, starMul: 1, wetK: 0, flash: 0, windMul: 1
  }),
  update: NOOP, event: NOOP, setSeed: NOOP, news: () => [], reset: NOOP, dispose: NOOP
};
// stage G — memorial.js and almanac.js need `env`, `plan` and `ui`, so they are
// built two hundred lines down and stand as null objects until then, exactly
// like `ui` did through stages B–E.
let memorial = {                                // stage G — memorial.js
  ents: [], setPlan: NOOP, setView: NOOP, celebrateRecord: () => null,
  overtook: () => null, setGhostArt: NOOP, update: NOOP, reset: NOOP, dispose: NOOP
};
let almanac = {                                 // stage G — almanac.js
  setView: NOOP, showCard: NOOP, hide: NOOP, update: NOOP, setScope: NOOP,
  reset: NOOP, dispose: NOOP, visible: false, pinned: false
};

/* ═══ the memory: the chronicle and the charter ═════════════════ */
// THE CHRONICLE IS DERIVED, and that is the whole design: `usage.db` holds every
// token event, and the feed's seed algebra is invertible, so a calendar date
// alone reconstructs that day's plan seed, street plan, archetype, name and
// size. Nothing load-bearing is stored — delete the keepsake file and all you
// lose is a `kept` count and three prefs. This module therefore OUTLIVES epochs:
// hardReset calls its reset(), which drops caches and nothing else.
const chronicle = initChronicle({
  // The one thing chronicle.js cannot derive on its own: a day index does not
  // know what a town is called. `archetypeOf` and `townNameFor` are the two pure
  // functions that answer it, and both are seeded off the same invertible index.
  identify: idx => {
    const s = planSeedOfIndex(idx), k = archetypeOf(s);
    return { name: townNameFor(s), kind: k, kindLabel: KIND_LABEL[k] };
  },
  sizeOf: townSize,             // ONE growth law, shared with the live town
  ladder: LADDER,               // snapshotted: the spliced `best` rung is filtered out
  store: (window.townAPI && window.townAPI.chronicle) || null,
  // A run that fabricates the number, the seed or the clock must never write a
  // day into the record — the keepsake is the one thing here that is not derived.
  readOnly: SYNTHETIC
});
ctx.chronicle = chronicle;
// THE CHARTER. Twenty-five badges over a DayFacts scratch object town.js mutates
// in place. No THREE, no DOM, no timers — it just answers "what is newly true?".
// It holds no record until the store's document arrives on the `chronicle`
// message, which main.js deliberately unshifts AHEAD of the first init so a cold
// open cannot re-award what was earned yesterday.
const charter = initCharter({
  readOnly: SYNTHETIC,
  record: p => window.townAPI && window.townAPI.chronicle && window.townAPI.chronicle.save(p)
});
// T-12 — THE SHIFT. Classifies the user's working pattern out of the buckets the
// feed already sends (no new query, no new privacy surface) and hands back a
// `dress` of ten numbers. CONFIDENCE IS THE DIAL: at conf 0 every value equals
// the neutral one and the town is drawn exactly as it is today, so every call
// site below is bit-identical until the data actually says something.
const shift = initShift();
ctx.shift = shift;

// T-17 — RARE EVENTS. Declared here so news.js's `country` closure can reach it;
// built after `ui`, because it needs a toast sink. Until then its news() is [].
let events = null;
// T-10 — MARKET DAY. Same reason: the Gazette's countryside pool is built before
// either module exists, and both answer [] until they do.
let market = null;

// stage F — interact.js. `ui.toast` is the rig's onMode sink from stage B, so
// this one has real call sites from the start; `selected` is almanac's arbiter.
let ui = {
  selected: null, toast: NOOP, update: NOOP, afterRender: NOOP, reset: NOOP, dispose: NOOP
};

/* ═══ the far town: LOD (stage E) ═══════════════════════════════ */
// Two roots, and which one a house group sits under IS its state. `hotRoot` holds
// everything still animating a matrix — every building for the ~0.5 s of its
// pop-in, plus the frontier's scaffolded ones. `coldRoot` holds the settled town,
// and lod DETACHES that whole root in mode A: at 12 px a house is a coloured block
// with a darker cap, so seven InstancedMeshes stand in for ~4 800 meshes, and
// leaving 5 200 nodes attached-but-hidden would still pay updateMatrixWorld.
// coldRoot's own matrix is identity and frozen, so a group's local transform is
// still its world transform — every position read in this file stays correct.
// `?lod=off` keeps every house a real group in `hotRoot` forever — the pre-v4
// picture, for the A/B shots that decide where the impostor may take over. It is
// not a shipping mode: at the 1200 cap it is ~5 300 draw calls.
const LOD_OFF = Q.get('lod') === 'off';
const LOD_Q = Q.get('lod') === 'med' || Q.get('lod') === 'low' ? Q.get('lod') : 'high';
const hotRoot = new THREE.Group(); hotRoot.name = 'hot'; scene.add(hotRoot);
const coldRoot = new THREE.Group(); coldRoot.name = 'cold';
coldRoot.matrixAutoUpdate = false; coldRoot.updateMatrix();
// ATTACHED HERE, once. lod only ever calls its setCold() on a mode FLIP (and in
// reset()), and mode starts at 'B' — which means attached — so if town.js leaves
// the first attach to lod, a town that never leaves mode B never gets one, and
// every settled house is invisible over its own contact shadow. From here on the
// root is lod's to detach and re-attach.
scene.add(coldRoot);
const lod = initLod(scene, {
  cap: N_CAP, camera, stage, coldRoot, houses,
  geo: GEO,                    // share the town's own unit/gable/pyr — the impostor
  winMat: winMatFor(),         // prism is then bit-identical to the roof it replaces
  quality: LOD_Q,
  // ONE threshold and ONE hysteresis for the whole app: npcs.js consumes this
  // rather than recomputing pixels from a camera distance it would have to guess.
  onNpcTier: t => npcs.setTier(t)
});

// THE BUS GOES IN FIRST. `WX` is a frozen eight-entry uniform set shared BY
// REFERENCE: environs' grass, water, dust and cloud read gust/cover/wet off it
// every frame, and weather.js is the only writer. Handing it over at construction
// is what stops the two modules needing to know about each other at all.
// `lat` is what tells the countryside which hemisphere it is in — without it a
// southern user gets an October that turns in April. environs derives its own
// season from the SAME `seasonOf()` weather.js uses, so the sky and the fields
// can never disagree about the month.
const env = initEnvirons(scene, plan, {
  maxAnisotropy: MAXA, daySeed, palette: palette(), quality: 'high', wx: WX, lat,
  // What the lanes are surfaced with is a village-tier property that lives in
  // buildings.js; the countryside is what draws it. town.js mediates so the two
  // modules never import each other.
  fabric: () => villageFabric()
});
// THE DAY OWNS THE WEATHER. `daySeed` is the local calendar date, so the climate
// is rolled once a morning and a range change — today → last 30 days — snaps the
// same sky back in rather than re-rolling it. Zero meshes this wave, therefore
// zero draw calls on every day; what it ships is the channel engine and the
// grade, and on a clear day every multiplier is exactly 1 and every tint 0.
wx = initWeather(scene, {
  daySeed, lat, quality: 'high', maxAnisotropy: MAXA,
  biome: env.biome, plazaPos: MON_POS
});
ctx.wx = wx;

const monument = initFountain(scene, {
  plazaR: ctx.plazaR, maxAnisotropy: MAXA, accent: ctx.accent, rangeShort: ctx.rangeShort
});
const MON_ENT = { kind: 'monument' };
// setTier mints new visible parts, so this is re-run after every tier change.
// The additive furniture (water arcs, shockwave, spray, confetti) is excluded
// from the raycast, or hovering anywhere near the plaza reports the fountain.
const retagMonument = () => monument.group.traverse(o => {
  o.userData.ent = MON_ENT;
  const m = o.material;
  if (m && !Array.isArray(m) && m.blending === THREE.AdditiveBlending) o.raycast = () => { };
});
retagMonument();

let buildingsCache = [], buildingsDirty = true;
// {pos, yaw} was enough for the villagers, who only ever needed a doorstep. The
// camera's tour reel filters on `kind === 'landmark'` and prints `label`, and
// the chronicle keys households by `idx`, so the row carries the whole entity's
// public identity now. Landmarks and bridges hold NEGATIVE synthetic `idx`
// (assigned at mount) so the one namespace covers everything that stands.
function buildingsForNPCs() {
  if (buildingsDirty) {
    buildingsCache = [];
    const row = e => ({
      pos: e.group.position, yaw: e.group.rotation.y, idx: e.idx,
      // `n` is the ordinal the deed card prints ('#120 of 233'). npcs carries it
      // through to whoever lives there, so a villager's card can give an ADDRESS
      // instead of a house type.
      n: e.n || 0,
      kind: e.kind, label: e.label || '', flavor: e.flavor || null,
      tier: e.tier != null ? e.tier : -1, hTop: e.hTop || 0
    });
    for (const e of houses) if (e && e.group) buildingsCache.push(row(e));
    for (const e of landmarks.values()) if (e.group) buildingsCache.push(row(e));
    buildingsDirty = false;
  }
  return buildingsCache;
}
addHit(monument.group);      // the fountain's own receipt
// An epoch swaps the whole plan object, and `plan` is a plain-data contract
// handed over once at init. npcs re-latches from ctx.plan on its own, but a
// stable forwarding handle costs nothing and means a villager can never be left
// walking a torn-down street plan in the window before the first update().
const planRef = new Proxy({}, { get: (_t, k) => plan[k] });
const npcs = initNPCs(scene, {
  plan: planRef,
  frontierK: () => ctx.frontierK,
  plazaR: () => ctx.plazaR,
  monument: monument.group.position, monumentR: monument.radius,
  attractor: () => monument.getAttractor(),
  getBuildings: () => buildingsForNPCs(),
  cap: NPC_CAP, seed: daySeed
});
// Hand over lod's LIVE tier record at wiring time (lod.js only calls onNpcTier on
// a far/near flip, so a camera that never flips would otherwise leave npcs.js
// recomputing the speak-gate px from scratch). lod initialized above (~l.923).
npcs.setTier(lod.npcTier());

const news = initNews({
  bar: document.getElementById('news'),
  mast: document.getElementById('newsMast'),
  line: document.getElementById('newsLine'),
  overlay, canvas,
  seed: planSeed, archetype: plan.kind, demo: FORCE_DEMO || !window.townAPI,
  // The countryside pool, in weight order. An event's lines carry w:14/w:9
  // against environs' 1–3, so a live event owns the pool while it runs and
  // returns [] the rest of the time; the shift's line is gated on confidence.
  country: () => env.news().concat(wx.news()).concat(shift.news())
    .concat(events ? events.news() : [])
    .concat(market ? market.news() : [])
});
ctx.townName = news.townName;

/** @type {NewsFacts} The Crier's world model: allocated once by news.js, mutated
 *  in place here on the 500 ms stats tick. NEVER reassigned. */
const facts = news.facts;
Object.assign(facts, {
  tok: 0, tokStr: '0', buildings: 0, villagers: 0, breaks: 0, grandest: '', landmark: '',
  rangeLabel: 'Today', perMin: 0, paceRatio: 1, tier: 0, night: 0, cascading: false,
  milestones: 0, tierName: '',
  // the chronicle's four, rewritten on the 500 ms tick from chronicle.view()
  ghost: '', bestStr: '', days: 0, spell: 0
});
const _bv = new THREE.Vector3();      // scratch for pickSpeaker → say
let lastPaceBand = -2;

/* ═══ the mayor (T-22) ══════════════════════════════════════════ */
// He takes office at the market-day rung and thereafter walks out to the
// fountain every eight minutes to tell the square how the town is doing. He
// knows nothing about news.js or npcs.js — everything below is a shim, so he
// stays a module you could drop into a different town.
//
// His residence is cached per epoch: a real doorstep, because his walk is a
// straight line and a fallback bearing can send him through a wall.
let mayorHome = null;
const mayorHomePos = () => {
  if (mayorHome && mayorHome.group) return mayorHome.group.position;
  mayorHome = null;
  const lo = ctx.plazaR + 5, hi = ctx.plazaR + 18;
  for (const e of houses) {
    if (!e || !e.group) continue;
    const d = Math.hypot(e.group.position.x - MON_POS.x, e.group.position.z - MON_POS.z);
    if (d > lo && d < hi) { mayorHome = e; return e.group.position; }
  }
  return null;                          // mayor.js falls back to a seeded bearing
};
// An EXPLICIT number, not a lookup by rung id: the ladder's ids follow whatever
// landmark a rung happens to raise, and those move. When the town is a proper
// village with a mill in it, it is big enough to want somebody in charge.
const MAYOR_AT = 10e6;
const mayor = initMayor(scene, {
  unlockTok: MAYOR_AT || MAYOR_UNLOCK_TOK,
  facts, seed: planSeed,
  say: (v, kind, o) => news.say(v, kind, o),
  crierSpeaking: () => npcs.crierSpeaking(),
  getCoinPos: () => monument.getCoinPos(),
  fountainR: () => monument.radius,
  plazaR: () => ctx.plazaR,
  sampleHeight: env.sampleHeight,
  homePos: mayorHomePos,
  // A small parade, not a milestone's: taking office is his moment, and the
  // rung that unlocks him already fires the town's own celebration.
  onUnlock: () => {
    const p = monument.getCoinPos().clone();
    burst3d(p, 0xC9A15A, 40, 7);
    floatText(p.clone().setY(p.y + 2.2), '🎩 A mayor!', ctx.accentCss);
    ui.toast('The town has a mayor.');
  }
});

// T-10 — MARKET DAY. One weekday a week, minted once for this town and kept, so
// the market is always on the same day. Costs literally zero draw calls on the
// other six and every night: the square is empty and swept.
market = initMarket(scene, {
  seed: planSeed,
  getCoinPos: () => monument.getCoinPos(),
  fountainR: () => monument.radius,
  plazaR: () => ctx.plazaR,
  getPlan: () => plan,
  sampleHeight: env.sampleHeight,
  maxAnisotropy: MAXA,
  say: (v, kind, o) => news.say(v, kind, o),
  // The same Crier bookkeeping the events module needs, and for the same
  // reason: without it stepCrier talks straight over the announcement.
  announce: text => {
    if (npcs.announce(text)) { crierSaid = text; crierAt = performance.now(); return true; }
    return false;
  },
  crierSpeaking: () => npcs.crierSpeaking(),
  celebrate: (p, o) => npcs.celebrate(p, o),
  onOpen: info => {
    news.post('marketOpen');
    ui.toast('Market day — ' + info.stalls + ' stalls on the square.');
  },
  onClose: () => news.post('marketClose')
});

/* ═══ the camera rig ════════════════════════════════════════════ */
// After env (it needs sampleHeight) and after npcs (resolveFollow), and before
// the first refreshFraming(). `ui` is the null object until stage F, so the mode
// toast is wired from the first day and simply goes nowhere until there is
// somewhere for it to go.
const rig = initCamera(camera, {
  canvas, stage,
  sampleHeight: env.sampleHeight,
  getPlan: () => plan,
  getBuildings: buildingsForNPCs,
  resolveFollow: h => npcs.track && npcs.track(h),
  plazaR: () => ctx.plazaR,
  onMode: (next, prev, meta) => { if (meta && meta.toast) ui.toast(meta.toast); },
  onShot: null
});

/* ═══ the interaction layer ═════════════════════════════════════ */
// After rig (it drives the camera verbs) and after npcs (it picks the crowd).
// town.js keeps exactly one thing here: `describe`, which is what an entity
// MEANS. Everything else — the ray, the tooltip, the deed card, the ring, the
// keymap and `?select=` — belongs to interact.js and is no longer this file's.
// `lod` + `houses` are §8.1's whole handshake: after stage E a settled house is
// not in `hitTargets` and is not a child of the scene, so lod's analytic pick is
// the ONLY way to find one, in whatever tier it is drawn at.
ui = initInteract({
  stage, canvas, scene, camera, rig, hitTargets, npcs,
  lod, houses,
  describe: describeEnt,
  getPlan: () => plan,
  villager: h => (npcs.personAt ? npcs.personAt(h) : null),
  // a GETTER: almanac is built after this call, and the 'A' key needs the live one
  almanac: () => almanac,
  // charter's trophy case, read on demand by the 'H' sheet
  ledger: () => (charter && charter.ledger ? charter.ledger() : null),
  saveShot: window.townAPI && window.townAPI.saveShot
});

/* ═══ sound and rare events ═════════════════════════════════════ */
// T-16 — AMBIENT AUDIO. ON by default and audible at load — main.js lifts
// Chromium's autoplay policy, so no user gesture is needed. A mute the user
// chooses persists across runs. A shot or bench run carries main.js's
// `headless=1` marker, mounts no chip and constructs no context, so
// verification screenshots are unchanged and a headless render is guaranteed
// mute. audio.js owns its own button and the M key.
const audio = initAudio({ rig, wx, toast: m => ui.toast(m) });

// T-17 — RARE EVENTS. The user overruled the old decline on the condition that
// they be "properly spaced out, making them actually special": the scheduler
// banks real active minutes in localStorage and enforces a quiet floor, which
// measures out to ~2 events on a two-hour day with a 28-minute hard minimum.
events = initEvents(scene, {
  daySeed, seed: planSeed,
  getPlan: () => plan,
  sampleHeight: env.sampleHeight,
  plazaR: () => ctx.plazaR, outerR: () => ctx.outerR,
  monument: MON_POS, monumentTop: () => monument.crownHeight || null,
  accent: () => ctx.accent, townName: () => ctx.townName,
  wx: WX,
  celebrate: (p, o) => npcs.celebrate(p, o),
  // The Crier has one mouth. Without this shim stepCrier() would talk straight
  // over the event on its next 500 ms tick, because it would not know the line
  // it is about to replace was ever spoken.
  announce: t => {
    if (npcs.announce(t)) { crierSaid = t; crierAt = performance.now(); return true; }
    return false;
  },
  speak: (p, t) => news.say(p, 'cheer', { text: t }),
  toast: m => ui.toast(m)
});

/* ═══ the memory in the world: memorial + almanac ═══════════════ */
// Three objects that let a day add up to a life. The CHRONICLE STONE on the
// plaza rim carries the personal bests, and grows a gold inlay only inside the
// last 20 % of one — chronicle.pressure() owns that gate and nothing here may
// widen it. The HORIZON GHOST is yesterday's town on the eastern road at 640
// units, lamps lit after dark: a neighbour, never a scoreboard. The BUNTING is
// one pennant per day of the current spell, and may only ever be RAISED.
memorial = initMemorial(scene, {
  maxAnisotropy: MAXA, paintSkyline,
  plazaR: () => ctx.plazaR, innerR: () => plan.innerR, gate: () => plan.gate,
  sampleHeight: env.sampleHeight, accent: () => ctx.accent, seed: daySeed,
  // a METHOD, not a view field: omit it and there is simply never an inlay
  pressure: () => chronicle.pressure()
});
// ONCE, at init, and never again: these groups and entities outlive every epoch,
// so re-registering them per epoch would grow hitTargets without bound. The
// group goes ON the entity as well: memorial's `tip()` is the v3 three-string
// form, which carries no anchor, and describeEnt needs somewhere to read the
// subject's position from before it can hand interact a ring and a Focus.
// `memTop` is the subject's height, used only for framing.
for (const { group, ent } of memorial.ents) {
  ent.group = group;
  // 1.6, not 5.6: the chronicle stone was a 9.6-metre obelisk standing on the
  // plaza's main approach and out-ranking the fountain it stood next to. It is a
  // parish stone at villager height now, and framing that still reserved the old
  // silhouette left four units of empty sky over it.
  ent.memTop = ent.kind === 'chronicle_stone' ? 1.6 : ent.kind === 'bunting' ? 6.5 : 0;
  tagEnt(group, ent); addHit(group);
}

// The paper half. Zero draw calls: a header strip of the last fourteen days and
// a parchment card that gives a day a proper full stop. `canShow` is the §5
// chrome arbiter — at most two v4 overlays on screen at once, and an open deed
// card outranks the almanac because the deed is something you ASKED for.
almanac = initAlmanac({
  paintSkyline, chronicle,
  accent: () => ctx.accentCss,
  canShow: () => !ui.selected,
  dayIndexOf, dateOfDayIndex
});

/* ═══ the picture: postfx + surface ═════════════════════════════ */
// postfx owns THE IMAGE (exposure, curve, bloom, vignette, tilt); surface owns
// the FRAGMENT (rim, base AO, grain, the far-land match). Neither reads the
// other and neither knows what a building is. They ship together: the surface
// pass is authored against the post curve, and the post curve is authored
// against a key that exceeds 1.0 linear on lit plaster.
const post = initPost(renderer, scene, camera, {
  quality: Q.get('post') || 'high', headless: HEADLESS
});
const _grade = makeGrade();           // ONE scratch Grade object, forever
const WHITE = new THREE.Color(0xffffff);

/* ═══ grounding: the contact shadow the shadow map cannot afford ══ */
const grounding = initGrounding(scene, { capacity: 1400, maxAnisotropy: MAXA });

/* ═══ the plaza breathes with the altar (§5.6) ══════════════════ */
// monument asks; town.js decides — the plaza may never eat the inner plots.
function setPlazaR(r) {
  // The floor is 10.5, not 12: a tier-1 waystone marooned in a 12-unit disc of
  // bare dirt had no presence at all, and the worship ring's own floor is 10.5.
  const v = clamp(r, 10.5, 15.5);
  if (Math.abs(v - ctx.plazaR) < .01) return;
  ctx.plazaR = v;
  placePlazaLamps();
  updateRoads(roadBand);       // the plate carries the plaza disc; it repaints on |Δ| > .4
}

/* ═══ the signpost — the town's ID card ═════════════════════════ */
// A fingerpost at the gate, where the main road leaves town: the name burnt into
// the upper board, the range on the lower one. It is chrome, not a building, so
// it is built here out of MAT/GEO primitives — and it is mounted with the plat,
// before any house, so the empty plan already reads as a place.
const signGroup = new THREE.Group();
const signEnt = { kind: 'signpost' };
const signBoards = [];
function makeBoardTex(text, sub) {
  const w = 512, h = 128, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#8A6E4A'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {                         // grain
    g.fillStyle = `rgba(${60 + seededR(i) * 40 | 0},${40 + seededR(i + 9) * 30 | 0},20,.16)`;
    g.fillRect(0, seededR(i * 3.1) * h, w, 1 + seededR(i * 7) * 2);
  }
  g.fillStyle = '#3A2A16';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${sub ? 40 : 52}px Georgia, serif`;
  g.fillText(String(text).slice(0, 26), w / 2, sub ? h / 2 - 4 : h / 2);
  if (sub) { g.font = '300 26px Georgia, serif'; g.fillStyle = '#4E3A20'; g.fillText(String(sub).slice(0, 34), w / 2, h / 2 + 34); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAXA;
  return t;
}
function buildSignpost() {
  const post = new THREE.Mesh(GEO.unit, matFor(0x6b533a, 'wood'));
  post.scale.set(.22, 3.4, .22); post.position.y = 1.7; post.castShadow = true;
  signGroup.add(post);
  const cap = new THREE.Mesh(GEO.pyr, matFor(0x5A452F, 'wood'));
  cap.scale.set(.36, .34, .36); cap.position.y = 3.5; signGroup.add(cap);
  for (let i = 0; i < 2; i++) {
    const board = new THREE.Mesh(GEO.unit, surface.applyTownSurface(new THREE.MeshStandardMaterial({ roughness: .9 }), 'prop'));
    board.scale.set(3.1, .62, .13); board.position.set(.9, 2.95 - i * .82, 0);
    board.castShadow = true;
    signGroup.add(board);
    // the two faces SHARE one material (a clone would double the texture churn
    // on every re-dressing, and dispose the map out from under itself)
    const faceMat = surface.applyTownSurface(new THREE.MeshStandardMaterial({ roughness: .9 }), 'prop');
    for (const s of [1, -1]) {
      const face = new THREE.Mesh(GEO.plane, faceMat);
      face.scale.set(3.06, .60, 1); face.position.set(.9, 2.95 - i * .82, .075 * s);
      if (s < 0) face.rotation.y = Math.PI;
      signGroup.add(face);
    }
    signBoards.push({ board, faceMat });
  }
  signGroup.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
  tagEnt(signGroup, signEnt);
  scene.add(signGroup); addHit(signGroup);
}
function dressSignpost() {
  const g = plan.gate || { x: 0, z: -plan.innerR, yaw: 0 };
  signGroup.position.set(g.x, 0, g.z);
  signGroup.rotation.y = g.yaw || 0;
  const texts = [makeBoardTex(ctx.townName), makeBoardTex(ctx.rangeLabel, townPhrase())];
  signBoards.forEach((b, i) => {
    if (b.faceMat.map) b.faceMat.map.dispose();
    b.faceMat.map = texts[i]; b.faceMat.needsUpdate = true;
    b.board.material.color.setHex(i ? 0x6A5335 : 0x7A6142);
  });
}
buildSignpost();

/* ═══ mounting buildings ════════════════════════════════════════ */
// A finished building never moves again, but every one of its ~4 nodes was
// recomposing its matrix every frame — ~2000 compose/multiply pairs per frame for
// a 430-house town, in the one thing the redesign multiplies by ten. Only the
// nodes an animation actually drives keep their auto-update.
function freezeStatic(g) {
  const live = new Set();
  for (const a of (g.userData.spin || [])) live.add(a.obj);
  for (const a of (g.userData.sway || [])) live.add(a.obj);
  g.traverse(o => {
    if (o === g || live.has(o)) return;
    o.updateMatrix(); o.matrixAutoUpdate = false;
  });
}
function mountEnt(e) {
  // Paint is stored ON the entity: a promotion remounts the same house, and it
  // must come back the same colour — and the celebration burst must match it.
  if (!e.paint) e.paint = e.flavor ? paintFlavor(e.flavor, e.idx, e.band) : paintHouse(e.idx, e.band);
  const g = e.flavor ? buildFlavor(e.flavor, e.paint, e.seed) : buildHouse(e.tier, e.paint, e.seed);
  const p = plan.plotAt(e.idx);
  g.position.set(p.x, 0, p.z); g.rotation.y = p.yaw;
  if (e.band > 4) g.traverse(o => { if (o.isMesh) o.castShadow = false; });
  g.updateMatrixWorld(true);
  for (const a of (g.userData.smoke || [])) { a.world = g.localToWorld(a.p.clone()); a.last = 0; }
  tagEnt(g, e); freezeStatic(g);
  // Into the ANIMATING root — the pop-in drives this group's matrix for the next
  // half second. settleToLod() moves it to coldRoot when that finishes.
  hotRoot.add(g); addHit(g);
  renderer.shadowMap.needsUpdate = true;
  e.cold = false;
  e.group = g;
  e.hTop = g.userData.hTop || TIER_H[e.tier] || 3.5;
  // buildings.js names its own top-tier variants (Guildhall, Counting-House), so
  // take the label it wrote rather than assuming the tier name.
  e.label = g.userData.label || (e.flavor ? e.flavor : TIER_NAMES[e.tier]);
  groundEnt(e, g);                    // after hTop is known — the blob is sized by it
  buildingsDirty = true;
}
function remountEnt(e) {
  if (e.group) dropGroup(e.group);
  const keep = animEnts.indexOf(e);
  mountEnt(e);
  if (keep < 0) animEnts.push(e);
}

/* ═══ spawn queue — drained on the wall clock, never dt ═════════ */
let spawnLast = performance.now(), spawnAcc = 0, drainMode = null, drainSpeed = 0, drainT0 = 0;
// What the LAST drain cost, and when it started: the per-frame budget is a
// fraction of what the rest of the frame costs, and the rest of the frame is the
// interval minus this.
let drainMs = 0, drainAt = performance.now();
const drainRate = q => q > 120 ? q / 1.4 : q > 12 ? 26 : 7;
function spawnBuilding(n, mode, now) {
  const idx = n - 1;
  const band = plan.bandOf(idx), L = prosperity(T), fk = plan.frontierOf(built).k;
  const settled = tierOfPlot(idx, fk, L);
  const e = {
    kind: 'house', n, idx, band, seed: idx * 7919 + 13,
    flavor: pickFlavor(idx, band), settled, tier: settled, settledAt: Date.now(),
    popT: 0, bumpT: 1, raw: false, group: null, paint: null
  };
  // Frontier construction: the newest few arrive one tier low, wearing a
  // scaffold, and finish 2.5 s later — "look how fast this is growing".
  const rawCap = Math.min(8, Math.ceil(built * .04));
  if (mode !== 'cascade' && !e.flavor && settled > 0 && rawList.length < rawCap) {
    e.raw = true; e.tier = settled - 1; e.promoteAt = now + 2500;
    rawList.push(e);
  }
  mountEnt(e);
  e.group.scale.setScalar(.01);
  houses[n - 1] = e; animEnts.push(e);
  return e;
}
function drainSpawnQueue(now) {
  const el = Math.min((now - spawnLast) / 1000, .5); spawnLast = now;
  if (!spawnQ.length) { spawnAcc = 0; drainMode = null; drainMs = 0; drainAt = now; return; }
  // The plat holds until t = 0.9 s: the shape of the day is the one thing you
  // never otherwise get to see, and it is gone the moment houses land on it.
  if (introFull && introT0 > 0 && now - introT0 < 900) return;
  const q = spawnQ.length;
  // The mode is latched: a cascade must take 1.4 s flat, so its rate can't
  // decay as the queue empties. A fresh burst may still escalate the mode.
  const want = q > 120 ? 'cascade' : q > 12 ? 'surge' : 'trickle';
  if (!drainMode || (want === 'cascade' && drainMode !== 'cascade')
    || (want === 'surge' && drainMode === 'trickle')) {
    drainMode = want; drainSpeed = drainRate(q); drainT0 = now;
  }
  const mode = drainMode;
  facts.cascading = mode === 'cascade';
  spawnAcc += drainSpeed * el;
  // The per-frame cap is a smoothness device, not a schedule. A headless window
  // paints at ~1 fps, so a 40/frame ceiling stranded a 418-house cascade at 280
  // after nine seconds — the launch shot has to show a FINISHED town, so the
  // cascade gets a fat batch and hands over what is left once it overruns.
  //   But "whatever is left" is not a budget. At the 1200-house cap the overrun
  // frame mounted ~780 groups AND paid the first full shadow+colour pass in one
  // tick: several seconds of blocked main thread during which the compositor
  // kept presenting the bare pre-cascade plat. An 11 s capture of `range=all`
  // was empty grass under a footer reading "1200 buildings — the plat is full".
  // Bounding the overrun by COUNT keeps the escape hatch (the town still lands
  // well inside the 9 s harness delay) without ever handing one frame the queue.
  const cap = mode === 'cascade' ? (now - drainT0 > 2000 ? 420 : 260) : 40;
  let k = Math.min(cap, spawnQ.length, Math.floor(spawnAcc));
  if (k <= 0) return;
  // A CEILING IS NOT A BUDGET. The count bound above is what stops one frame
  // being handed the whole queue, and it works — but 420 mountEnt calls plus the
  // first full shadow+colour pass plus ~45 shader program compiles still landed in
  // a single tick, and the bench measured that tick at 1255 ms against a 90 ms
  // budget. That is a frozen window every time the town is opened on a large
  // range, not a bench artefact.
  //   So: never spend more than about half of what the REST of the frame costs.
  // Measuring against the whole frame interval does not converge — the interval
  // includes our own overrun, so one slow frame buys the next one a bigger budget
  // and the cascade walks itself back up to a 660 ms tick. Subtracting what we
  // spent last time leaves the honest cost of everything else, which is what we
  // are allowed to be a fraction of. At 60 fps that is an ~18 ms floor and the
  // stall is gone; in a headless capture, where the rest of the frame is 300 ms
  // on its own, it hands the drain up to 180 ms and `range=all` still settles inside
  // the harness delay. A fixed millisecond budget would have traded the freeze
  // back for the empty-grass screenshot this escape hatch was built to fix.
  const rest = Math.max(0, (now - drainAt) - drainMs);
  const budget = clamp(rest * 0.45, 18, 180);
  const frameT0 = now;
  drainAt = now;
  spawnAcc -= k;
  // Floaters aggregate: a burst of 5 reads "+5 houses!" at the centroid rather
  // than five overlapping "+1"s.
  const centroid = new THREE.Vector3();
  let plain = 0, i = 0, lastE = null, grandest = -1;
  while (k-- > 0) {
    // Checked AFTER at least one mount, so the drain can never stall completely
    // on a machine where a single building costs more than the whole budget.
    if (i > 0 && performance.now() - frameT0 > budget) { spawnAcc += k + 1; break; }
    const n = spawnQ.shift();
    const e = spawnBuilding(n, mode, now);
    lastE = e; i++;
    if (!e.flavor && e.settled > grandest) grandest = e.settled;
    if (mode === 'trickle') {
      burst3d(e.group.position.clone().setY(.6), e.paint.roof, 18, 5);
      npcs.celebrate(e.group.position, { runners: 2 });
      // Only on a trickle. A surge or a cascade would fire this hundreds of
      // times in one frame; audio.js caps its voices, but the right answer is
      // not to ask, and the cascade has its own single event below.
      audio.event('build', { pos: e.group.position });
      // A mature town settles its frontier low by design, so the every-tenth
      // "⭐ …!" callout was literally bragging "⭐ Cottage!" for building #430.
      // Keep the star for a genuinely rare house; brag about the COUNT otherwise.
      if (e.settled >= 5 || e.flavor) {
        floatText(e.group.position.clone().setY(e.hTop + 1.1),
          (e.flavor ? e.label : TIER_NAMES[e.settled]) + '!', ctx.accentCss);
      } else if (n % 25 === 0) {
        floatText(e.group.position.clone().setY(e.hTop + 1.1), `${n} buildings!`, '#F3D07A');
      } else { centroid.add(e.group.position); plain++; }
    } else if (mode === 'surge') {
      if (i % 3 === 0) burst3d(e.group.position.clone().setY(.5), e.paint.roof, 10, 4.4);
      centroid.add(e.group.position); plain++;
    }
  }
  // Belt and braces on the founding: the landmarks are scheduled to appear at
  // t = 900 ms, but fxQ can only fire on a FRAME, and the frame that mounts the
  // first cascade batch is the expensive one. If houses have landed, the plat
  // they stand on has too — a stalled cascade must never screenshot as bare grass
  // with the market hall and the cathedral still held back.
  if (platHidden.length) revealPlat();
  drainMs = performance.now() - frameT0;      // what the next frame's budget is measured against
  if (bench) bench.peak('drainMaxMs', drainMs);
  if (plain > 0) {
    centroid.divideScalar(plain).setY(4.2);
    floatText(centroid, plain === 1 ? '+1 house' : `+${plain} houses!`, ctx.accentCss);
    // A surge is the biggest ordinary growth event there is — a genuine token
    // eruption — and it used to produce visibly LESS life than one house
    // arriving alone. One call ripples a cheer outward across the whole new arc.
    if (mode === 'surge') {
      npcs.celebrate(centroid, { runners: 6, cheerRadius: 34 });
      monument.pulse();
    }
  }
  if (mode !== 'cascade' && lastE) {
    facts.buildings = houses.length;              // see the cascade branch below
    news.post('buildingsAdded', {
      n: i, total: houses.length, label: lastE.label,
      tier: grandest >= 0 ? TIER_NAMES[grandest] : lastE.label, flavor: lastE.flavor || ''
    });
    // A mason gets the last word on his own house — and npcs.js writes it, so he
    // names the building he just finished. '' ⇒ news.js's own pool.
    if (npcs.pickSpeaker('cheer', _bv) || npcs.pickSpeaker(null, _bv)) {
      const t = npcs.speechLine ? npcs.speechLine() : '';
      news.say(_bv, 'build', t ? { text: t } : undefined);
    }
  }
  if (mode === 'cascade' && !spawnQ.length) {
    // Launch delight — the single highest-frequency moment in the product. It
    // reuses the milestone choreography wholesale: shockwave to the town edge,
    // title plate over the fountain, the whole population converging on it.
    facts.cascading = false;
    // The Crier reads the world model, and the model is only rewritten on the
    // 500 ms stats tick — which last ran BEFORE this cascade drained. Without
    // this, the founding headline announces the count the town had one frame ago
    // ("166 buildings") beside a footer that already says 233.
    facts.buildings = houses.length; facts.villagers = npcs.count;
    audio.event('cascade', { n: i });
    const title = `✦ ${ctx.townName} — township of ${houses.length}`;
    // During a founding, the altar is still landing (t = 2.3 s) and the charter
    // 100 ms later owns this beat — firing both is two celebrations in one frame.
    if (!(introFull && introT0 > 0)) {
      monument.celebrate(title, GOLD_HI);
      npcs.celebrate(MON_POS, { milestone: true, runners: 8, cheerRadius: 999 });
      burst3d(monument.getCoinPos().clone(), GOLD_HI, 70, 11);
    }
    floatText(new THREE.Vector3(ctx.bounds.cx, 16, ctx.bounds.cz), title, '#F3D07A', true);
    for (const e of landmarks.values()) burst3d(e.group.position.clone().setY(e.hTop * .6), GOLD_HI, 22, 6);
    rig.punch();
    drainMode = null;
    news.post('boot', { buildings: houses.length });
  }
  renderer.shadowMap.needsUpdate = true;
  refreshFraming();
  hintEl.style.display = houses.length ? 'none' : 'block';
}

/* ═══ promotion waves — the redevelopment engine ════════════════ */
// The town must get RICHER when it can no longer get wider: at 500M the next
// plot costs ~4M, so without redevelopment the reward channel silently stops
// paying exactly when the user is working hardest.
let promoLast = performance.now(), promoAcc = 0;

/* ═══ the village fabric (T-21) ═════════════════════════════════ */
// hamlet → village → market village → market town. buildings.js owns what each
// tier LOOKS like (thatch giving way to clay tile, paling → hedge → fieldstone
// wall, yard clutter, door lanterns, market stalls); town.js owns WHEN it moves
// and who gets restyled when it does.
//
// The switch only styles buildings built after it, so there are two paths:
//   • settling a town (a cold open, an epoch change) sets the tier from the
//     PLANNED size before a single house is mounted, so the whole town is built
//     in the right fabric rather than banded by the order the cascade happened
//     to drain in;
//   • crossing a tier while the user watches marks every standing house for a
//     re-skin and lets the EXISTING promotion queue drain them at ~10/s. That is
//     already the rate-limited, celebrated, crier-announced path for "the town
//     rebuilds itself", and it cost nothing to reuse. A market town re-roofing
//     1200 houses takes about two minutes, which is the right speed for
//     something the user is supposed to notice.
let vTier = -1;
/** The phrase the chip, the signpost, the founding plate and the town's own deed
 *  all print: the plan's SHAPE from the seed, then the settlement's SIZE from
 *  the tokens. Reads the live tier rather than `vTier`, so it is right before
 *  the first sync as well as after it. */
// Reads `vTier`, not `houses.length`. The tier is chosen from the PLANNED size
// before the spawn queue drains — that is the whole point of it, so a town
// settling in one cascade is built in the right fabric — so at the moment the
// chip is first written there are no houses standing yet, and counting them
// labelled a 233-building market village a hamlet for the rest of the epoch.
const townPhrase = () => settlementLabel(plan.kind,
  VILLAGE_TIER_NAMES[vTier >= 0 ? vTier : villageTierFor(houses.length)]);
function syncVillageTier(nHouses, animate) {
  const want = villageTierFor(Math.max(0, nHouses | 0));
  if (want === vTier) return;
  const rose = vTier >= 0 && want > vTier;
  vTier = want;
  setVillageTier(want);
  refreshTownPhrase();          // the chip carries the tier
  if (!rose || !animate) return;
  let marked = 0;
  for (const e of houses) {
    if (!e || !e.group || e.inQ || e.raw) continue;
    e.reskin = true; e.inQ = true; promoQ.push(e); marked++;
  }
  promoQ.sort((a, b) => a.band - b.band);          // the old core rebuilds first
  if (marked > 0) {
    floatText(MON_POS.clone().setY(6.5), VILLAGE_TIER_NAMES[want] + '!', ctx.accentCss, true);
    ui.toast(ctx.townName + ' is a ' + VILLAGE_TIER_NAMES[want] + ' now.');
  }
}
/** The chip is painted once at founding, when the town has no houses in it yet —
 *  so composing the phrase there alone left a 233-building market village
 *  labelled a hamlet for the rest of the epoch. The tier is the only half that
 *  moves, so this is the one place that has to say so. */
function refreshTownPhrase() {
  const el = document.getElementById('archChip');
  if (!el) return;
  const s = gotData ? townPhrase() : '';        // `surveying` is paintChrome's local
  if (el.textContent !== s) el.textContent = s;
}

function updateProsperity() {
  const L = prosperity(T), pband = Math.floor(L / .25), fk = plan.frontierOf(built).k;
  if (pband === lastBand && Math.abs(fk - lastFrontier) < 4) return;
  lastBand = pband; lastFrontier = fk;
  for (const e of houses) {
    if (!e || e.flavor || !e.group) continue;
    const t = tierOfPlot(e.idx, fk, L);
    if (t === e.settled) continue;
    e.settled = t;
    if (!e.raw && e.tier !== t && !e.inQ) { e.inQ = true; promoQ.push(e); }
  }
  promoQ.sort((a, b) => a.band - b.band);        // the old core redevelops first
}
function drainPromotionQueue(now) {
  promoAcc = Math.min(promoAcc + (now - promoLast) / 100, 30); promoLast = now;
  if (!promoQ.length) { promoAcc = 0; return; }
  let k = Math.min(promoQ.length, Math.floor(promoAcc)), n = 0;
  promoAcc -= k;
  const at = new THREE.Vector3();
  while (k-- > 0) {
    const e = promoQ.shift();
    e.inQ = false;
    // `reskin` is the village-tier path: the house has not changed grandeur, it
    // is being rebuilt in the town's new fabric. Without it this line would drop
    // every re-skin on the floor, because tier === settled for all of them.
    if (!e.group || (e.tier === e.settled && !e.reskin)) { e.reskin = false; continue; }
    e.tier = e.settled; e.reskin = false;
    remountEnt(e);
    e.popT = .7; e.bumpT = 1;
    burst3d(e.group.position.clone().setY(.5), 0xB9B4A8, 6, 2.6);
    at.copy(e.group.position); n++;
  }
  if (n >= 4) {
    // A promotion-only tick must still be legible: a wave of four is a visible
    // civic event, and the crier says so.
    news.post('promotion', { n });
    npcs.celebrate(at, { runners: 3, cheerRadius: 26 });
  }
}
function drainFrontier(now) {
  for (let i = rawList.length - 1; i >= 0; i--) {
    const e = rawList[i];
    if (now < e.promoteAt) continue;
    rawList.splice(i, 1);
    e.raw = false;
    if (!e.group) continue;
    e.tier = e.settled;
    remountEnt(e);
    e.popT = .7;
    burst3d(e.group.position.clone().setY(.4), 0xB9B4A8, 8, 3);
  }
}

/* ═══ landmarks, bridges, the milestone ladder ══════════════════ */
// Construction scaffolds outlive their scheduler entry, so they are tracked:
// an epoch reset clears fxQ and would otherwise strand them in the scene.
const liveScaf = [];
function dropScaf(s) {
  const i = liveScaf.indexOf(s); if (i >= 0) liveScaf.splice(i, 1);
  scene.remove(s); disposeGroup(s);
}
function placeLandmark(kind, m, animate) {
  if (landmarks.has(kind)) return;
  const def = LANDMARK_DEFS[kind] || { span: 1, hTop: 9, label: kind };
  const site = (plan.sites || {})[kind];
  if (!site) return;                          // a plan without the site skips it
  const g = buildLandmark(kind, paintLandmark(kind), (planSeed ^ fnv1a(kind)) >>> 0);
  g.position.set(site.x, 0, site.z); g.rotation.y = site.yaw;
  g.updateMatrixWorld(true);
  for (const a of (g.userData.smoke || [])) { a.world = g.localToWorld(a.p.clone()); a.last = 0; }
  const order = LM_ORDER.indexOf(kind) + 1;
  const e = {
    kind: 'landmark', lm: kind, label: g.userData.label || def.label, tok: m ? m.tok : 0,
    at: Date.now(), order, hTop: g.userData.hTop || def.hTop,
    // The synthetic ordinal. Negative so it can never collide with a house's,
    // which is what lets grounding, the tour and the chronicle share one keyspace.
    idx: -order,
    group: g, popT: 1, bumpT: 1, band: plan.bandOf(0)
  };
  tagEnt(g, e); freezeStatic(g); scene.add(g); addHit(g);
  groundEnt(e, g);
  // t = 0 is the PLAT: terrain, water, roads, bridges, plaza and signpost only.
  // A silently-seeded landmark would otherwise be standing there before the town.
  if (ritualTier >= 0) { g.visible = false; platHidden.push(g); }
  landmarks.set(kind, e); animEnts.push(e);
  lastLandmark = e.label; facts.landmark = e.label;
  wx.event('landmark', { kind, label: e.label });
  audio.event('landmark', { kind, label: e.label });
  buildingsDirty = true;
  renderer.shadowMap.needsUpdate = true;
  if (animate) {
    g.position.y = -e.hTop;
    e.rising = true;
    risers.push({ g, from: -e.hTop, t0: performance.now(), e });
    const scaf = buildScaffold();
    scaf.position.set(site.x, 0, site.z); scaf.userData.setHeight(e.hTop * .9);
    scaf.userData.setProgress(1); scaf.userData.setTint(GOLD_HI);
    scene.add(scaf); liveScaf.push(scaf);
    schedule(900, () => burst3d(new THREE.Vector3(site.x, .6, site.z), 0xB9B4A8, 24, 4.2));
    schedule(3400, () => dropScaf(scaf));
    news.post('landmark', { label: e.label, kind, order: e.order });
  }
}
// Bridges are the layout's, the mesh is buildings', and mounting is core's —
// exactly like a landmark, and hover-testable for the same reason.
function updateBridges(animate) {
  const list = plan.bridges || [], fk = plan.frontierOf(plannedN()).k;
  for (let i = 0; i < list.length; i++) {
    if (bridgeEnts.has(i)) continue;
    const b = list[i];
    if (b.d > fk) continue;
    const g = buildBridge({ span: b.span, w: b.w, main: b.main }, paintBridge(b.main), (planSeed + i * 977) >>> 0);
    // local +x runs along the span; three's rotation.y maps +x to (cos, 0, -sin).
    // The deck's own origin is the road surface (y = 0) but environs floats the
    // water at y = .06 to clear the road plate, so an unlifted deck is READ
    // THROUGH the river and the crossing washes out into two pale rails. Ride it
    // clear of the surface; the approach ramps are painted, so no step shows.
    // 1.05, not .30. At .30 the waterline sat 6 cm ABOVE the deck's own
    // underside, so the abutments, the piers, the cutwaters and a whole arch
    // barrel per opening were drawn under the river and had never once been
    // rendered — the crossing was a deck and two rails. 1.05 is the highest
    // lift at which the abutment is still buried in its own bank (at 1.30 its
    // underside goes flush, and by 1.59 the coping stands 4.5 m over the water,
    // which is a viaduct). npcs.js and camera.js carry the matching ramp so the
    // crowd and the walker are on the deck rather than under it.
    g.position.set(b.x, 1.05, b.z); g.rotation.y = -b.a;
    g.updateMatrixWorld(true);
    const e = {
      kind: 'bridge', label: g.userData.label || (b.main ? 'Stone Bridge' : 'Timber Bridge'),
      hTop: g.userData.hTop || 2.2, at: Date.now(), n: houses.length, span: b.span,
      idx: -100 - i,                     // its own negative band of the ordinal space
      group: g, popT: animate ? 0 : 1, bumpT: 1, band: 0
    };
    if (animate) g.scale.setScalar(.01);
    tagEnt(g, e); freezeStatic(g); scene.add(g); addHit(g);
    groundEnt(e, g);
    bridgeEnts.set(i, e); animEnts.push(e);
    renderer.shadowMap.needsUpdate = true;
    if (animate) {
      burst3d(new THREE.Vector3(b.x, 1.2, b.z), 0xB9B4A8, 20, 4);
      news.post('bridge', { main: b.main });
    }
  }
}
function applySilent(m) {
  // During the founding ritual the altar arrives LAST (t = 2.3 s), so its tier
  // is withheld and replayed there; the landmarks come in under the cascade.
  if (m.mon != null && ritualTier < 0) monument.setTier(m.mon, { animate: false });
  if (m.mon != null && ritualTier >= 0) ritualTier = Math.max(ritualTier, m.mon);
  if (m.lm) placeLandmark(m.lm, m, false);
  retagMonument();
}
// Half-decade minor rungs. Ten fixed absolute rungs left multi-hour silences at
// BOTH ends of the calibration range — a 3M day had nothing after 1M, and a 500M
// day fired six rungs in fifty minutes and then went quiet for four hours. A
// magnitude-relative step is constant in log space, so the cadence is the same
// (~5 events per decade, one every 20-45 min) at 3M and at 1B.
const minorStep = t => Math.pow(10, Math.floor(Math.log10(Math.max(t, 5e5)))) / 2;
function updateMilestones(silent) {
  while (mileIdx < LADDER.length && T >= LADDER[mileIdx].tok) {
    const m = LADDER[mileIdx++];
    if (silent) { applySilent(m); mileCount++; } else mileQ.push(m);
  }
  // Tracked in TOKENS, not in steps: the step size grows as T crosses a decade,
  // so a step count would be meaningless the moment it changed.
  const step = minorStep(T);
  let next = (Math.floor(minorAt / step) + 1) * step;
  while (next <= T) {
    minorAt = next;
    // a minor that lands on top of a major is the major's moment, not its own
    const near = LADDER.some(m => Math.abs(m.tok - next) < next * .01);
    if (!silent && !near) mileQ.push({ tick: true, amount: step });
    next += step;
  }
}
function fireTick(m) {
  const amount = (m && m.amount) || 100e6;
  const coin = monument.getCoinPos().clone();
  burst3d(coin, GOLD_HI, 26, 8);
  floatText(coin.clone().setY(coin.y + 2), '+' + fmtTok(amount), '#F3D07A');
  monument.pulse(); npcs.pulse();
}
function fireMilestone(m, extra) {
  const t0 = plainTitle(m.title);
  const title = extra > 0 ? `${t0} (+${extra} milestones)` : t0;
  mileCount++;
  if (m.mon != null) {
    monument.setTier(m.mon, { animate: true });
    news.post('tierUp', { tier: m.mon, tierName: monument.tierName });
  }
  monument.celebrate(title, GOLD_HI);
  retagMonument();
  const coin = monument.getCoinPos().clone();
  burst3d(coin, GOLD_HI, 70, 11);
  floatText(coin.clone().setY(coin.y + 2.4), title, '#F3D07A', true);
  npcs.celebrate(MON_POS, { milestone: true, runners: 8, cheerRadius: 999 });
  news.post(m.best ? 'best' : 'milestone', { title: m.title, tok: m.tok, id: m.id });
  if (npcs.pickSpeaker('cheer', _bv) || npcs.pickSpeaker('worship', _bv)) {
    const t = npcs.speechLine ? npcs.speechLine() : '';
    news.say(_bv, 'cheer', t ? { text: t } : undefined);
  }
  schedule(150, () => rig.punch());
  // a tier-up is exactly the moment the altar should be the subject of the frame
  schedule(220, refreshFraming);
  for (let i = 0; i < 4; i++) schedule(200 + i * 350, () => {
    const a = rand(0, Math.PI * 2), R = rand(.45, .95) * ctx.bounds.r;
    burst3d(new THREE.Vector3(ctx.bounds.cx + Math.cos(a) * R, rand(14, 22), ctx.bounds.cz + Math.sin(a) * R),
      i % 2 ? GOLD_HI : ctx.accent, 55, 9);
  });
  if (m.lm) schedule(600, () => placeLandmark(m.lm, m, true));
  // The only ledger reactions the sky has are UPWARD ones: a milestone rains
  // gold. There is no weather that gets worse because the user stopped working.
  wx.event(m.best ? 'best' : m.mon != null ? 'tierUp' : 'milestone', { tok: m.tok, id: m.id });
  audio.event(m.best ? 'best' : m.mon != null ? 'tierUp' : 'milestone', { tok: m.tok, id: m.id });
  // THE SKY BEAT. weather.js hangs a physically-placed rainbow off the drawn
  // sun, and the orbit rig leaves 2-4 degrees of sky above the ridge — so
  // without this the bow is correct and invisible. `beat` carries its own delay
  // (the idea always said "~6 s after the celebration"), refuses outside orbit
  // and on a pinned bench camera, and hands control straight back to a user who
  // touches anything. Safe to call unconditionally.
  rig.beat('rainbow', { delay: 6000 });
  // A rung is exactly the kind of thing that makes a badge newly true, and the
  // minute tick is too slow to put the two parades in the same breath. The delay
  // lets the milestone's own fireworks land first.
  schedule(1400, runCharter);
}
function drainMilestoneQueue(now) {
  if (!mileQ.length || now - mileAt < 900) return;
  mileAt = now;
  if (mileQ.length > 3) {
    // A backlog is not a fireworks marathon: apply everything, show the top one.
    const rungs = mileQ.filter(x => !x.tick);
    const top = rungs.length ? rungs[rungs.length - 1] : null;
    for (const x of mileQ) if (!x.tick && x !== top) { applySilent(x); mileCount++; }
    const lastTick = mileQ[mileQ.length - 1];
    mileQ.length = 0;
    if (top) fireMilestone(top, rungs.length - 1); else fireTick(lastTick);
  } else {
    const m = mileQ.shift();
    if (m.tick) fireTick(m); else fireMilestone(m, 0);
  }
}

/* ═══ the charter: what is newly true about today ═══════════════ */
// charter.js is a state machine over ONE scratch object, and this is the half
// that fills it. Everything here degrades to 0/'' safely: a v3 feed with no
// `today` block simply leaves every day-scoped badge asleep rather than awarding
// a month's work as a day's.
let charterAt = -1e9;
const _roofSet = new Set();
function fillDayFacts(f) {
  const nowMs = Date.now(), d = new Date(nowMs);
  f.date = daySeedOf(nowMs);                 // YYYYMMDD local — the one hard gate
  f.nowMs = nowMs; f.hourNow = d.getHours();
  // THE DAY, NOT THE RANGE. The feed's `today` block is the calendar day whatever
  // the dashboard is counting; without it we may only claim `T` when the selected
  // window IS the day. `dayScoped` false doesn't silence the charter, it just
  // narrows it to the badges that are true of the town rather than of the count.
  const td = feedToday;
  f.dayScoped = !!(td || ctx.rangeIsDay);
  f.tok = td ? td.tok : (ctx.rangeIsDay ? T : 0);
  // IN PLACE, always. `facts` is charter.js's own scratch object and it owns
  // both arrays: reset() zeroes `hours[0..23]` and truncates `roofs`, so
  // reassigning either — even to null on a v3 feed — made the next epoch switch
  // throw inside charter.reset() and took the whole hardReset down with it.
  const th = td && td.hours;
  for (let i = 0; i < 24; i++) f.hours[i] = th ? (th[i] || 0) : 0;
  f.peakBucket = td ? td.peakBucket || 0 : 0;
  f.firstMs = td ? td.firstMs || 0 : 0;
  f.lastMs = td ? td.lastMs || 0 : 0;
  f.b = built; f.landmarks = landmarks.size; f.milestones = mileCount;
  f.villagers = npcs.count; f.breaks = groves.length;
  let longest = 0;
  for (const g of groves) longest = Math.max(longest, (g.end - g.start) || 0);
  f.longestBreakMs = longest;
  f.perMin = ctx.perMin; f.paceRatio = ctx.paceRatio;
  f.cacheFrac = depthState.cacheFrac;        // from the feed's depth lane
  // The chronicle's own arithmetic — best day EXCLUDING today, or a badge for
  // "your greatest day" fires every day by comparing today with itself.
  const v = chronicle.view();
  let best = 0, life = 0;
  if (v && v.days) for (const day of v.days) {
    if (day.idx !== v.todayIdx) best = Math.max(best, day.tok);
    life += day.tok;
  }
  f.bestTok = best; f.lifetimeTok = life;
  f.daysRecorded = v ? v.count : 0;
  f.spellLen = v && v.spell ? v.spell.len : 0;
  f.arch = plan.kind || ''; f.biome = env.biome || '';
  _roofSet.clear();
  for (const e of houses) if (e && !e.flavor) _roofSet.add(roofNameOf(e.idx));
  f.roofs.length = 0;
  for (const r of _roofSet) f.roofs.push(r);
  f.weather = wx.id || '';
  return f;
}
/** One award: the same parade a LADDER rung gets, at a third of the volume. */
function fireAward(a) {
  const p = monument.getCoinPos().clone();
  burst3d(p, GOLD_HI, 40, 8);
  floatText(new THREE.Vector3(p.x, p.y + 2.4, p.z), `${a.icon} ${a.title}`, '#F3D07A', true);
  news.post('badge', { label: a.title, title: a.blurb });
}
/** Fill, check, parade. Called on the minute and after anything that could have
 *  changed what is true — a milestone, a landmark, a grove. */
function runCharter() {
  if (!gotData) return;
  for (const a of charter.check(fillDayFacts(charter.facts))) fireAward(a);
}

/** THE OVERTAKING's flourish in the world. memorial.overtook() lights the ghost
 *  town's own lamps and hands back where it is standing — 640 units out on the
 *  eastern road, where a burst tuned for the plaza is literally sub-pixel. The
 *  speed and the caption's lift both scale with the distance to the camera. */
function liftNineBirds(p) {
  const d = Math.max(60, camera.position.distanceTo(p));
  burst3d(p, 0xFFF4DC, 9, d * .07);
  floatText(new THREE.Vector3(p.x, p.y + d * .05, p.z), 'ahead of yesterday', '#F3D07A', false);
}

// Reused in place: nextRung is called twice per frame and used to allocate.
const _next = { tok: 0, tick: true, amount: 0 };
function nextRung() {
  if (mileIdx < LADDER.length) return LADDER[mileIdx];
  const step = minorStep(T);
  _next.tok = (Math.floor(T / step) + 1) * step; _next.amount = step;
  return _next;
}
function nextProgress(nx) {
  const prev = mileIdx > 0
    ? (mileIdx < LADDER.length ? LADDER[mileIdx - 1].tok : Math.max(minorAt, nx.tok - nx.amount))
    : nx.tok / 40;
  const lo = Math.max(prev, 1);
  const hi = Math.max(nx.tok, lo * 1.0001);
  const t = Math.max(T, lo);
  // Logarithmic between neighbouring rungs, so the bar is never stuck at 4 % on
  // a rung that is ten times the last one. But on the PERSONAL BEST rung — the
  // one finish line the user set themselves — the gap is small and the log curve
  // openly contradicts the text beside it: "26 % · 452.5M to go" out of 580M,
  // when they are 71 % of the way there in tokens. Blending toward linear as the
  // rung narrows keeps the early ladder readable and makes the bar and the "to
  // go" figure tell the same story where the user can check it.
  const lg = Math.log(t / lo) / Math.log(hi / lo);
  const lin = (t - lo) / (hi - lo);
  const k = clamp((Math.log(hi / lo) - .35) / 1.25, 0, 1);   // 0 for a near rung, 1 for a decade
  return clamp(lin + (lg - lin) * k, 0, 1);
}

/* ═══ groves: idle time plants woodland behind the frontage ═════ */
// Trees no longer take building plots — plots are earned. A break instead
// thickens a grove behind whatever house was the frontier at the time, so the
// town reads as "we rested here".
function updateGroves(simNow) {
  if (!gotData || !built) return;
  if (!idleSince) { idleSince = simNow; return; }
  while (simNow - idleSince >= IDLE_MS) {
    // The NEXT grove starts when its own idle window opened. Inheriting the full
    // grove's start made two adjacent groves report overlapping time ranges.
    const start = idleSince;
    idleSince += IDLE_MS;
    if (!grove || grove.trees.length >= 6) { grove = newGrove(start, idleSince, built); news.post('grove', { count: groves.length }); }
    grove.end = idleSince;
    addTree(grove, true);
  }
}
function newGrove(start, end, ord) {
  const idx = clamp(ord, 1, Math.max(built, 1)) - 1;
  const p = plan.plotAt(Math.min(idx, plan.capacity - 1));
  // pushed off the plot AWAY from its own street: local +z is the façade
  const g = {
    kind: 'grove', start, end, trees: [],
    x: p.x - Math.sin(p.yaw) * 5.2, z: p.z - Math.cos(p.yaw) * 5.2, d: p.k
  };
  groves.push(g);
  return g;
}
function addTree(gr, animate) {
  const i = gr.trees.length;
  if (i >= 6) return;
  const s = groves.length * 5.1 + i;
  const g = buildTree(groves.length * 97 + i * 13);
  g.position.set(gr.x + (seededR(s) - .5) * 5.4, 0, gr.z + (seededR(s + 31) - .5) * 5.4);
  const e = { kind: 'grove', grove: gr, group: g, popT: animate ? 0 : 1, bumpT: 1, hTop: 3, band: 9 };
  tagEnt(g, e); scene.add(g); addHit(g);
  if (animate) g.scale.setScalar(.01);
  gr.trees.push(e); animEnts.push(e);
}
// Replay the range's idle gaps: a gap is anchored to the frontier the town had
// reached by then, which is what the token total says it was.
function backfillGroves(buckets, nowMs) {
  if (!built) return;                        // nothing was built, nothing rested
  const byB = new Map();
  for (const r of buckets) byB.set(r.b, { tok: (byB.get(r.b) || { tok: 0 }).tok + r.tok, w: r.w || INT_MS });
  const bs = [...byB.keys()].sort((a, b) => a - b);
  if (!bs.length) return;
  // A grove means "you took a break INSIDE this window", which only reads at day
  // scale. Walking a coarse history at a flat 10-minute threshold called every
  // night a break: `range=all` minted 122 groves and 732 tree Groups — 732 extra
  // draws, 732 extra animEnts and 732 extra recursive raycast targets on top of a
  // 1200-building town — for the meaningless reward "you rested 122 times in all
  // of history". Scale the threshold to the bin, and keep only the longest rests.
  const binW = byB.get(bs[0]).w || INT_MS;
  const gapMs = Math.max(IDLE_MS, binW * 2);
  const MAX_GROVES = 14;
  const found = [];
  let cum = 0;
  for (let i = 0; i < bs.length; i++) {
    const cur = byB.get(bs[i]);
    cum += cur.tok;
    const end = i + 1 < bs.length ? bs[i + 1] : nowMs;
    const start = bs[i] + cur.w;             // rows carry their own bin width now
    if (end - start < gapMs) continue;
    found.push({ start, end, at: townSize(cum), len: end - start });
  }
  if (found.length > MAX_GROVES) {
    found.sort((a, b) => b.len - a.len);
    found.length = MAX_GROVES;
    found.sort((a, b) => a.start - b.start);
  }
  for (const f of found) {
    const gr = newGrove(f.start, f.end, f.at);
    for (let t = 0; t < Math.min(6, Math.floor(f.len / gapMs)); t++) addTree(gr, false);
  }
  grove = null;
}

/* ═══ the next-building progress meter ══════════════════════════ */
const scafEnt = { kind: 'scaffold', n: 1, p: 0, left: 0 };
const meterScaf = buildScaffold();
scene.add(meterScaf); addHit(meterScaf); tagEnt(meterScaf, scafEnt);
const ghostScaf = [buildScaffold(), buildScaffold()];
for (const g of ghostScaf) { g.userData.setGhost(true); scene.add(g); }
// Placement only changes when a building spawns or a poll lands — a few times a
// minute. It used to re-derive three plot positions, rewrite 42 mesh transforms
// and traverse the whole meter group EVERY FRAME. Only the progress bar wants
// to be smooth, and even that moves on the 2 s feed.
function placeScaffolds() {
  scafDirty = false;
  const n = built + 1;
  const show = gotData && n <= N_CAP && n <= plan.capacity;
  meterScaf.visible = show;
  if (!show) { for (const g of ghostScaf) g.visible = false; return; }
  const L = prosperity(T), fk = plan.frontierOf(built).k, paved = plan.frontierOf(plannedN()).k;
  const place = (g, ord) => {
    const idx = ord - 1;
    if (idx >= plan.capacity) { g.visible = false; return; }
    const p = plan.plotAt(idx);
    // Same guard the road lamps get: a marker standing on unpainted grass beyond
    // the frontier reads as litter, not as a promise.
    g.visible = p.k <= paved + 8;
    g.position.set(p.x, 0, p.z); g.rotation.y = p.yaw;
    g.userData.setHeight(TIER_H[tierOfPlot(idx, fk, L)] || 3.5);
  };
  place(meterScaf, n);
  meterScaf.visible = meterScaf.visible && show;
  meterScaf.userData.setTint(GOLD_HI);         // gold is the only colour that means tokens
  scafEnt.n = n;
  place(ghostScaf[0], n + 1);
  place(ghostScaf[1], n + 2);
}
function updateScaffold() {
  if (scafDirty) placeScaffolds();
  if (!meterScaf.visible) return;
  const n = scafEnt.n, need = costOf(n), have = T - tokensFor(n - 1);
  const p = clamp(need > 0 ? have / need : 0, 0, 1);
  if (p !== scafEnt.p) {
    scafEnt.p = p; scafEnt.left = Math.max(0, need - have);
    meterScaf.userData.setProgress(p);
  }
}

/* ═══ the one reconciliation function — idempotent, call freely ══ */
function syncTown(silent) {
  let want = townSize(T);
  // capFail remembers the smallest `want` ensureCapacity could NOT satisfy. Some
  // plans genuinely top out below N_CAP — every ribbon does, around 890-1108 —
  // and without this the (want > capacity - 60) test stays true forever, so a
  // 1200-house town re-entered ensureCapacity on every 2 s bucket poll: ~12 ms,
  // ending in rebuildRoadIndex(), which sorts every edge and clears the NPCs'
  // A* pathCache. Twice a minute, for the life of the epoch.
  if (want > plan.capacity - 60 && want < capFail) {
    // ensureCapacity appends nodes and edges AND rewrites `node.d` on the existing
    // ones. The verge scatter and the street lamps were only ever placed at boot
    // and on an epoch change, so the outlands past the original capacity had no
    // lamps and no hedges at all — the outer third of a 1200-building town was
    // unlit at night — and every cached lamp depth was stale against a relaxed
    // graph. Both placers are idempotent pool re-poses, so re-running them is
    // cheap and correct.
    const before = plan.capacity;
    plan.ensureCapacity(want + 60);
    if (plan.capacity > before) { buildVerge(); placeRoadLamps(); roadBand = -2; }
    if (plan.capacity < want) capFail = want;
  }
  // CLAMP TO WHAT THE PLAN CAN ACTUALLY HOLD. plotAt deliberately clamps an
  // out-of-range ordinal rather than throwing, so every house past capacity was
  // mounted on the SAME last plot at the same yaw — 310 of them stacked inside
  // one cottage on the worst ribbon. plannedN() already clamps; this was the one
  // place that queued ordinals the plan had never agreed to.
  want = Math.min(want, plan.capacity);
  // BEFORE the queue is filled, never after: buildings.js styles what is built
  // after the switch, so a town settling in one cascade must know its fabric
  // first or it comes out banded by drain order. `silent` is exactly the
  // "settling, nobody is watching" flag, so it doubles as the animate gate.
  syncVillageTier(want, !silent);
  for (let n = built + 1; n <= want; n++) spawnQ.push(n);
  built = Math.max(built, want);
  ctx.frontierK = plan.frontierOf(built).k;
  ctx.band = built > 0 ? plan.bandOf(built - 1) : -1;
  updateProsperity();
  updateMilestones(!!silent);
  updateBridges(!silent);
  scafDirty = true;
  updateScaffold();
}

/* ═══ the founding ritual (§11.4) ═══════════════════════════════ */
// The user opens the town roughly once a day, to a place that has never existed
// before. The town must be FOUND (the plat), then FOUNDED (the charter), then
// INHABITED — in that order, and all of it finished by t = 6 s so a headless
// shot catches a settled town rather than a name plate.
let introT0 = -1, introFull = false, ritualTier = -1, plateEl = null;
const platHidden = [];                // landmarks held back until the cascade
const revealPlat = () => { for (const g of platHidden) g.visible = true; platHidden.length = 0; };
const introDist = () => introT0 < 0 || !introFull ? 1
  : 1 + .35 * (1 - easeOutCubic(clamp((performance.now() - introT0 - 2600) / 2200, 0, 1)));
const introPol = () => introT0 < 0 || !introFull ? 0
  : .10 * (1 - easeOutCubic(clamp((performance.now() - introT0 - 2600) / 2200, 0, 1)));
function showPlate() {
  if (plateEl) plateEl.remove();
  const d = new Date();
  const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  plateEl = document.createElement('div');
  plateEl.id = 'plate';
  plateEl.innerHTML =
    `<div class="rule"></div><div class="nm">${esc(ctx.townName.toUpperCase())}</div>` +
    `<div class="sub">founded ${esc(day)} · ${esc(townPhrase())} · seed ${esc(ctx.seedHex)}</div>` +
    `<div class="rule"></div>`;
  overlay.appendChild(plateEl);
  void plateEl.offsetWidth; plateEl.classList.add('go');
  // The fade-OUT is in the stylesheet, not here: fxQ can only fire on a frame,
  // and a heavy town paints at ~1 fps, so the masthead outlived its own removal
  // by seconds and ghosted across the rooftops. CSS runs on the compositor's
  // clock; this timer is now only the DOM cleanup behind it.
  schedule(4200, dropPlate);
}
function dropPlate() { if (plateEl) { plateEl.remove(); plateEl = null; } }
function startRitual(full) {
  introT0 = performance.now(); introFull = full; ctx.intro = 0; fullEpoch = false;
  // A founding opens on a settled sky: the channels snap for SNAP_MS after this
  // rather than crossfading, so a `--shot-delay=7000` never lands 20 % through
  // a change of weather nobody watched begin.
  wx.event('boot', { full: !!full });
  audio.event('boot', { full: !!full });
  dropPlate();
  if (INTRO_OFF) {
    introT0 = -1; introFull = false; ctx.intro = 1;
    roadMat.opacity = 1; revealPlat();
    monument.group.visible = true;
    if (ritualTier >= 0) { monument.setTier(ritualTier, { animate: false }); ritualTier = -1; retagMonument(); }
    return;
  }
  roadMat.opacity = full ? .15 : .6;
  if (full) {
    monument.group.visible = false;
    schedule(150, showPlate);
    schedule(900, revealPlat);            // the landmarks arrive under the cascade
    // THE MONUMENT LANDS LAST. Today it sits there on frame 0, which spends the
    // punchline first.
    schedule(2300, () => {
      monument.group.visible = true;
      if (ritualTier > 0) monument.setTier(ritualTier, { animate: true });
      ritualTier = -1; retagMonument();
    });
    // THE CHARTER — shockwave, gold burst, the whole population at the shrine.
    schedule(2400, () => {
      const title = `✦ ${ctx.townName} — founded`;
      monument.celebrate(title, GOLD_HI);
      npcs.celebrate(MON_POS, { milestone: true, runners: 8, cheerRadius: 999 });
      burst3d(monument.getCoinPos().clone(), GOLD_HI, 60, 10);
    });
    // THE COMPARISON — the most motivating single fact the app owns, inside the
    // first ten seconds, every day it exists. The footer's ▲/▼ row carries it in
    // ink; here a villager says it out loud, which is what makes it land.
    schedule(6500, () => {
      if (prevTok <= 0) return;
      const rival = prevAt > 0 ? prevAt : prevTok;
      const d = T - rival;
      // "…to go" turned a comparison into a quota. The villager may celebrate a
      // lead and may observe a quieter day; what she may not do is tell the user
      // how much they still owe.
      const text = d >= 0
        ? `${fmtTok(rival)} by now last time — we're ${fmtTok(d)} ahead.`
        : `${fmtTok(rival)} by now last time. A quieter one today.`;
      if (npcs.pickSpeaker('stroll', _bv) || npcs.pickSpeaker(null, _bv))
        news.say(_bv, 'stroll', { text, ttl: 5200 });
    });
  } else {
    monument.group.visible = true; revealPlat();
    if (ritualTier >= 0) { monument.setTier(ritualTier, { animate: false }); ritualTier = -1; retagMonument(); }
  }
}
function stepRitual(now) {
  if (introT0 < 0) return;
  const e = now - introT0;
  // the ground looks trodden in by the arrival: 0.15 → 1 across the cascade
  if (introFull) roadMat.opacity = clamp(.15 + (e - 900) / 1400 * .85, .15, 1);
  ctx.intro = clamp(e / (introFull ? 5600 : 1200), 0, 1);
  if (ctx.intro >= 1) { introT0 = -1; roadMat.opacity = 1; }
}

/* ═══ range + epoch ═════════════════════════════════════════════ */
const RANGE_LABELS = {
  session: ['Session', 'this session'], today: ['Today', 'today'], all: ['All time', 'all time'],
  currentMonth: ['This month', 'this month'], demo: ['Demo day', 'today']
};
function legacyRange(msg) {
  // demo mode and any older feed: one synthesised epoch, day-scoped.
  const k = RANGE_HINT && RANGE_LABELS[RANGE_HINT] ? RANGE_HINT : 'demo';
  const [label, short] = RANGE_LABELS[k] || RANGE_LABELS.demo;
  const start = msg.sessionStartMs || (msg.now - 8 * 3600e3);
  return {
    key: k, epochId: k + ':0', seed: SEED_OVERRIDE === null ? fnv1a('demo') : SEED_OVERRIDE,
    startMs: start, lenMs: msg.now - start, rolling: false, manual: false,
    dayIndex: 0, binMs: INT_MS, tailStartMs: start,
    label, short, sinceLabel: fmtClock(start), isDay: true
  };
}
/** Strip the feed's second person. It sends labels like "your last session";
 *  nothing the town prints addresses the user as "you". */
const deSecond = s => String(s || '').replace(/\byour\b/gi, 'the').replace(/\byou\b/gi, 'the town');
let curRange = null, prevTok = 0, prevAt = 0, prevLabel = '';
/** The feed v4 `today` block: the LOCAL CALENDAR DAY, whatever the selected
 *  range is counting. The charter's day-scoped badges live or die on it — a
 *  30-day dashboard must never award "a billion in a day" for a month's work. */
let feedToday = null;
// The session label already ENDS in its own start time ("Session · pinned 11:00"),
// so appending the feed's sinceLabel produced "· pinned 11:00 · since 11:00".
const sinceOf = rg => (rg && rg.sinceLabel && !String(rg.label).includes(rg.sinceLabel))
  ? ' · since ' + rg.sinceLabel : '';
function adoptRange(rg) {
  const changed = !curRange || curRange.key !== rg.key || curRange.epochId !== rg.epochId;
  curRange = rg;
  ctx.rangeKey = rg.key; ctx.rangeLabel = rg.label; ctx.rangeShort = rg.short;
  ctx.rangeStartMs = rg.startMs; ctx.rangeIsDay = !!rg.isDay;
  planSeed = SEED_OVERRIDE === null ? (rg.seed >>> 0) : SEED_OVERRIDE;
  ctx.planSeed = planSeed;
  seedHex = planSeed.toString(16).toUpperCase().slice(-4); ctx.seedHex = seedHex;
  monument.setRangeLabel(rg.short);
  const badge = document.getElementById('rangeBadge');
  badge.textContent = `◷ ${rg.label}${sinceOf(rg)}`;
  if (changed) { badge.classList.remove('flash'); void badge.offsetWidth; badge.classList.add('flash'); }
  facts.rangeLabel = rg.label;
  dressSignpost();          // the fingerpost's lower board IS the range readout
  return changed;
}
// Everything that must be re-derived when the epoch's seed changes. Order is the
// spec's: plan first, because the archetype it picks is an input to news and
// environs, and the palette is a function of the DAY, never of the range.
function adoptEpoch() {
  plan = buildPlan(planSeed); ctx.plan = plan;
  ctx.daySeed = daySeed;
  initPalette(daySeed);
  const pal = palette();
  ctx.palette = pal;
  ctx.accent = pal.accent; ctx.accentCss = pal.accentCss;
  ctx.dominantColor = pal.accent; ctx.dominantCss = pal.accentCss;
  news.reset(planSeed, plan.kind, dayRolled);
  dayRolled = false;                               // consumed; the next epoch re-earns it
  ctx.townName = news.townName;
  env.setSeed(daySeed, plan, pal, lat);
  buildVerge(); placeRoadLamps(); placePlazaLamps();
  dressSignpost();
  paintChrome();
  roadBand = -2;                                   // force a repaint of the plate
}
function paintChrome() {
  const pal = ctx.palette;
  // Nothing is named until the feed says what window we are in. The placeholder
  // epoch used to put a full masthead — name, archetype, seal — on screen for the
  // two seconds before real data landed, and then tear that town down.
  const surveying = !gotData;
  document.title = surveying ? 'Token Town' : 'Token Town — ' + ctx.townName;
  document.getElementById('townName').textContent = surveying ? 'surveying…' : ctx.townName;
  // SHAPE PLUS SIZE. The archetype comes from the seed and the size from the
  // tokens, so the chip composes them: a twenty-building town used to wear
  // `crossroads market town`.
  document.getElementById('archChip').textContent = surveying ? '' : townPhrase();
  document.documentElement.style.setProperty('--accent', ctx.accentCss);
  const seal = document.getElementById('seal');
  const GLYPHS = ['✦', '⚒', '⚓', '☘', '⚜', '☗', '✤', '❂', '⌘', '☖'];
  seal.textContent = GLYPHS[planSeed % GLYPHS.length];
  seal.style.background = ctx.accentCss;
  seal.title = 'seed ' + seedHex;
  const dots = document.getElementById('palDots');
  dots.innerHTML = (pal.dots || []).slice(0, 3).map(c => `<i style="background:${esc(c)}"></i>`).join('');
  dots.title = 'today’s palette';
}

/* ═══ data feed ═════════════════════════════════════════════════ */
let pendingInit = null, fadeT = -1, fadeMs = 2000, lastInit = null, fullEpoch = false;
// Was the epoch change an actual calendar-day rollover? The Crier's DAYSTART
// copy ("Midnight passed. The town was rebuilt from scratch.") is only true when
// this is set, and it used to be printed at any hour of the day.
let dayRolled = false;
function applyOverride() {
  if (TOK_OVERRIDE === null) return;
  T = Tfloor = Tsum = TOK_OVERRIDE;
}
// Teardown order matters — eight modules hold state now (§11.2).
function hardReset() {
  fxQ.length = 0;                                   // kill scheduled callbacks FIRST
  for (const e of animEnts) if (e.group) dropGroup(e.group);
  while (liveScaf.length) dropScaf(liveScaf[0]);
  dropPlate();
  animEnts.length = 0; houses.length = 0; groves.length = 0;
  landmarks.clear(); bridgeEnts.clear(); cell.clear(); bins.clear(); binsVer++;
  spawnQ.length = 0; promoQ.length = 0; mileQ.length = 0; rawList.length = 0;
  risers.length = 0; platHidden.length = 0;
  T = 0; Tfloor = 0; Tsum = 0; built = 0; mileIdx = 0; minorAt = 0; mileCount = 0;
  capFail = Infinity;                               // a new plan, a new ceiling
  lastBand = -1e9; lastFrontier = -1; grove = null; idleSince = 0; idleToldAt = 0;
  lastLandmark = ''; drainMode = null;
  vTier = -1;                       // the new town re-derives its own fabric
  gotData = false; buildingsDirty = true; scafDirty = true;
  heroDisp = -1; nextTxtTok = -1; statTok = -1;
  // Cross-epoch carry-over that would otherwise lie about the NEW town: floating
  // "+5 houses!" labels from the town being torn down, a pace band that makes the
  // first read of the new one look like a change, and the previous epoch's median
  // rate (the divisor of paceRatio, i.e. of the weather).
  for (const f of floaters) f.el.remove();
  floaters.length = 0;
  lastPaceBand = -2; medianAt = -1e9; medianPerMin = 0; bubbleAt = 0;
  // The new town has its own news; the last headline the old Crier read must not
  // be what stops the new one from opening his mouth.
  crierAt = 0; crierSaid = ''; crierBubbled = false;
  const i = LADDER.findIndex(m => m.best); if (i >= 0) LADDER.splice(i, 1);
  monument.reset();
  npcs.setPopulation(0);
  npcs.reset();                 // setPopulation(0) alone leaves the old roster
  // THE TEARDOWN REGISTRY (§7). One list, every v4 module, or --bench-scene=epochs
  // fails the build. The null objects answer these too, so the list is complete
  // from the day it is written rather than growing a line per stage.
  post.reset(); surface.reset(); grounding.reset(); lod.reset(); rig.reset();
  ui.reset();
  // events.reset() keeps its luck ledger on purpose — a range change is a new
  // town, not a new day, and "once a fortnight" has to mean a real fortnight.
  // shift.reset() keeps its read for the same reason: a shift describes the
  // person, not the epoch.
  events.reset(); audio.reset(); shift.reset();
  mayorHome = null;               // a new epoch is a new town: he needs a new address
  mayor.reset(); market.reset();
  // A RANGE CHANGE MUST NEVER RE-ROLL THE CLIMATE. `daySeed` is the calendar
  // date, so re-arming with the same seed is a no-op on every epoch that is not
  // a new day — today → last 30 days snaps the same sky back in rather than
  // handing the user a different afternoon for pressing a button.
  wx.setSeed(daySeed, Date.now(), lat, env.biome); wx.reset();
  memorial.reset(); almanac.reset();
  chronicle.reset(); charter.reset();
  adoptEpoch();                 // plan + palette + news + environs; invalidates the plate
  refreshFraming();             // ... which repaints it exactly once, here
  retagMonument();
  // LAST — the leak gate reads a reset() as "the teardown happened", so every
  // module above must already have let go of its epoch state.
  if (bench) bench.reset();
}
// The shutdown path. Order matters in one place: post.dispose() restores
// renderer.toneMapping and info.autoReset, so anything that reads renderer.info
// must already be gone.
function shutdown() {
  ui.dispose(); almanac.dispose(); memorial.dispose(); lod.dispose();
  grounding.dispose(); wx.dispose(); rig.dispose();
  chronicle.dispose(); charter.dispose();
  // EVERY module, not just the thirteen new ones. The v3 four expose dispose()
  // too, and environs' is what releases the --vig property and removes the
  // vignette stylesheet it injected; leaving them out made this list unreliable
  // as documentation of what the page actually owns.
  env.dispose(); news.dispose(); npcs.dispose(); monument.dispose();
  events.dispose(); audio.dispose(); shift.dispose(); mayor.dispose(); market.dispose();
  bench && bench.dispose();
  post.dispose(); surface.dispose();
}
window.addEventListener('pagehide', shutdown);
function applyInit(msg) {
  lastInit = msg;
  const rg = msg.range || legacyRange(msg);
  if (typeof msg.lat === 'number') { lat = msg.lat; computeSun(); }
  // An epoch change is a different town: fade out, tear down, rebuild. A same-key
  // re-quantum (last24 sliding forward) gets the short form — a re-survey, not a
  // founding. `pendingInit` is simply overwritten if a second change lands
  // mid-fade, which is what makes hammering the range buttons harmless.
  if (gotData && rg.epochId !== curRange.epochId) {
    fullEpoch = rg.key !== curRange.key || rg.dayIndex !== curRange.dayIndex;
    dayRolled = rg.key === curRange.key && rg.dayIndex !== curRange.dayIndex;
    pendingInit = msg; fadeT = performance.now(); fadeMs = fullEpoch ? 2000 : 600;
    return;
  }
  const first = !curRange;
  const keyChanged = !first && curRange.key !== rg.key;
  const wider = !first && (rg.lenMs || 0) > (curRange.lenMs || 0);
  const rolled = dayRolled;               // adoptEpoch consumes the flag below
  adoptRange(rg);
  if (first || planSeed !== plan.seed) adoptEpoch();
  ctx.plan = plan;
  gotData = true;
  paintChrome();                          // now the town has a name it has earned
  prevTok = msg.prev && msg.prev.tok > 0 ? msg.prev.tok : 0;
  prevAt = msg.prev && msg.prev.atTok > 0 ? msg.prev.atTok : 0;
  // THE FEED SAYS "your last session"; THE TOWN NEVER SAYS "your". The copy gate
  // holds for the chrome as strictly as it does for the Crier, and this label is
  // printed under the hero number in every frame — so it is normalised once,
  // here, rather than at each of the two places that render it.
  prevLabel = deSecond((msg.prev && msg.prev.label) || '');
  spliceBestRung(prevTok, prevLabel);
  // THE MEMORY. `ingest` reads the feed's `chronicle` and `today` blocks and
  // ignores an init that carries neither, so a v3 feed renders exactly v3.
  feedToday = msg.today || null;
  // T-12 reads the SAME buckets, so it costs no extra query and can see nothing
  // the town could not already see. It keeps the stronger witness across inits.
  shift.ingest(msg);
  chronicle.ingest(CHRON_OFF ? {}
    : CHRON_SYNTH ? { chronicle: CHRON_SYNTH, today: msg.today } : msg);
  memorial.setPlan(plan, planSeed);
  memorial.setView(chronicle.view());
  almanac.setView(chronicle.view());
  for (const r of msg.buckets) foldRow(r);
  T = Math.max(Tfloor, Tsum); Tfloor = T;
  applyOverride();
  idleSince = Date.now();
  // A FOUNDING withholds the altar's tier until t = 2.3 s and plants the epoch's
  // woodland. A same-epoch re-init is neither: the feed re-sends a full `init` on
  // catch-up (a laptop lid closed for an hour) with an UNCHANGED epochId — always,
  // for a pinned session — and there is no teardown on that path.
  //   Arming the ritual there set ritualTier = 0 while `mileIdx` was already past
  // the end of the ladder, so nothing raised it back up and startRitual demoted a
  // tier-10 Skyward Mint to the Survey Stone, in a plaza still ringed by its
  // Cathedral and Sky-Gate, under a footer reading "10 milestones". Backfilling
  // the groves again minted a second copy of every tree at the same coordinates.
  const founding = first || keyChanged || fullEpoch;
  ritualTier = (INTRO_OFF || !founding) ? -1 : 0;
  syncTown(true);                         // seed passed milestones with zero FX
  if (founding) backfillGroves(msg.buckets, msg.now || Date.now());
  refreshFraming();
  hintEl.innerHTML = `<b>No tokens ${esc(ctx.rangeShort)} yet.</b><br>The first houses go up when the ledger does.`;
  hintEl.style.display = T > 0 ? 'none' : 'block';
  // A cold open, a new range or a new day is a FOUNDING; a same-key re-quantum
  // (last24 sliding forward two hours) is a re-survey and gets the short form.
  startRitual(founding);
  // `short` is the SENTENCE form ("this session"); without it the Crier fell back
  // to the header badge and printed "…now remembers exactly Session · pinned
  // 11:00 and not a moment more." `wider` was computed, passed and then ignored,
  // so narrowing the window told widening jokes.
  // The DAYSTART pool is written in the past tense about a midnight that has just
  // happened ("Midnight passed. The town was rebuilt from scratch."), so posting
  // it on EVERY init made a cold open at 19:12 lead with a rollover that never
  // occurred. It is only true when the calendar day actually turned; a cold open
  // already has its BOOT line from firstLine().
  if (keyChanged) news.post('rangeChanged', { label: rg.label, short: rg.short, wider });
  else if (rolled) news.post('dayStart', { name: ctx.townName });
}
function foldRow(r) {
  const key = r.b + '|' + (r.model || ''), prev = cell.get(key) || 0;
  if (r.tok <= prev) return false;                  // upsert re-read, nothing new
  cell.set(key, r.tok);
  const d = r.tok - prev;
  Tsum += d;
  const bin = bins.get(r.b);
  if (bin) bin.tok += d; else bins.set(r.b, { tok: d, w: r.w || INT_MS });
  binsVer++;                    // invalidates paidFor's prefix sum
  return true;
}
function applyBuckets(msg) {
  let grew = false;
  // The feed refreshes the pace partner about once a minute on this path (see
  // refreshPrev) so the "ahead of this point last time" row keeps walking
  // instead of being frozen at the moment the town was opened.
  if (msg.prev) {
    prevTok = msg.prev.tok > 0 ? msg.prev.tok : prevTok;
    prevAt = msg.prev.atTok > 0 ? msg.prev.atTok : prevAt;
    prevLabel = deSecond(msg.prev.label) || prevLabel;
    spliceBestRung(prevTok, prevLabel);
  }
  for (const r of msg.buckets) grew = foldRow(r) || grew;
  T = Math.max(Tfloor, Tsum); Tfloor = T;           // totals only ever go UP
  applyOverride();
  if (grew) {
    idleSince = Date.now(); idleToldAt = 0; grove = null;
    monument.pulse(); npcs.pulse();
  }
  syncTown(false);
}
function showError(message) {
  const el = document.getElementById('banner');
  el.textContent = message; el.style.display = 'block';
}
// Nothing ever hid the banner again, so one recoverable feed error — a transient
// lock while the tracker wrote — left an error stripe across the town for the
// rest of the run, including after the very next successful read.
function clearError() {
  const el = document.getElementById('banner');
  if (el && el.style.display !== 'none') el.style.display = 'none';
}
function onData(msg) {
  if (msg.type === 'init' || msg.type === 'buckets') clearError();
  if (msg.type === 'init') { if (msg.depth) applyDepth(msg.depth); applyInit(msg); }
  else if (msg.type === 'buckets') { if (gotData && !STILL && fadeT < 0) applyBuckets(msg); }
  else if (msg.type === 'config') { if (typeof msg.lat === 'number') { lat = msg.lat; computeSun(); } }
  // The record arrives AHEAD of the first init (main.js unshifts it), so the
  // charter holds what was already earned before a cold open can re-award it.
  else if (msg.type === 'chronicle') charter.adopt(msg.doc);
  // A WHOLE FEED LANE WITH NO CONSUMER. datafeed has been emitting `depth` on a
  // 2 s tick and attaching a `depth` block to every `init` since the protocol
  // landed; nothing here handled either, so `facts.cacheFrac` was pinned at 0 and
  // the charter's cache badges could never fire.
  else if (msg.type === 'depth') applyDepth(msg);
  else if (msg.type === 'error') showError(msg.message);
}

/* ── the depth block: cache read/write mix and plan limits ────────
   Partial by design — sendDepth only includes the fields that MOVED, so a tick
   carrying only `limits` must not wipe the mix. Everything here is a straight
   copy into the Crier's world model; no module reads `depth` directly. */
const depthState = { cacheFrac: 0, limits: null, hide: false };
function applyDepth(msg) {
  if (!msg) return;
  if (msg.mix) {
    const m = msg.mix;
    // Cache reads and the two write lanes against everything the window billed
    // for. This is the one number the badge charter asks for: "how much of today
    // came back out of the cache".
    const cached = (+m.cr || 0) + (+m.cw || 0) + (+m.cw1 || 0);
    const total = cached + (+m.i || 0) + (+m.o || 0);
    depthState.cacheFrac = total > 0 ? clamp(cached / total, 0, 1) : 0;
  }
  if (msg.limits !== undefined) depthState.limits = msg.limits || null;
  if (msg.hidePersonal !== undefined) depthState.hide = !!msg.hidePersonal;
}

if (window.townAPI && !FORCE_DEMO) {
  window.townAPI.onData(onData);
  window.townAPI.ready();
} else {
  // No preload bridge → plain-browser demo mode with synthetic data. Backfills
  // a ~140M-token day (≈200 buildings, landmarks up to Cathedral) so the very
  // first frame after the cascade is a real township, then keeps growing.
  demoMode = true;
  // The demo is also the shop window, so it goes looking for a river town: the
  // archetype that shows off bridges, both banks and the water surface at once.
  if (SEED_OVERRIDE === null) {
    let s = fnv1a('demo');
    for (let i = 0; i < 8 && plan.kind !== 'riverside'; i++) {
      s = (Math.imul(s ^ 0x9E3779B9, 0x85EBCA6B) >>> 0);
      planSeed = s; plan = buildPlan(s);
    }
    ctx.plan = plan;
  }
  const now = Date.now(), nowBucket = Math.floor(now / INT_MS) * INT_MS;
  const models = ['a', 'b', 'c', 'd'];       // the renderer is model-blind; these are upsert keys
  const share = [.45, .30, .18, .07], NB = 90, TOTAL = 140e6;
  const w = []; let ws = 0;
  for (let i = 0; i < NB; i++) {
    const idle = (i > 28 && i < 36) || (i > 61 && i < 68);   // two coffee breaks
    const v = idle ? 0 : .2 + Math.pow(seededR(i * 2.7), 2) * 3;
    w.push(v); ws += v;
  }
  const buckets = [];
  for (let i = 0; i < NB; i++) {
    if (w[i] <= 0) continue;
    const b = nowBucket - (NB - i) * INT_MS;
    for (let m = 0; m < 4; m++) {
      const tok = Math.round(TOTAL * share[m] * (w[i] / ws) * (.6 + seededR(i * 3.1 + m) * .8));
      if (tok < 2000) continue;
      buckets.push({ b, w: INT_MS, model: models[m], tok });
    }
  }
  const dRange = legacyRange({ now, sessionStartMs: nowBucket - NB * INT_MS });
  dRange.seed = planSeed;
  onData({
    type: 'init', v: 3, now, range: dRange, prev: { tok: TOTAL * .82, label: 'beat yesterday' },
    lat: null, buckets
  });
  if (!STILL && TOK_OVERRIDE === null) {
    const lt = new Map();
    setInterval(() => {
      const m = models[(Math.random() * models.length) | 0];
      const b = Math.floor(Date.now() / INT_MS) * INT_MS, key = b + '|' + m;
      // heavy tail: most ticks are a house or three, one in fifteen erupts
      lt.set(key, (lt.get(key) || 0) + Math.round(1e5 + Math.pow(Math.random(), 3) * 4e7));
      onData({ type: 'buckets', now: Date.now(), buckets: [{ b, w: INT_MS, model: m, tok: lt.get(key) }] });
    }, DEMO_MS);
  }
}

/* ═══ deeds: what a thing is, and what paid for it ══════════════ */
// The hover raycast, the #tip writes and the two mouse listeners that used to
// live here are interact.js's now. town.js keeps the only half a renderer cannot
// know: what each entity MEANS. `describeEnt` is the old three-string `tipFor`
// widened into a Deed, and `paidFor` is the line the whole card exists for.
const RARE_TAG = { 'painted-lady': '✦ Painted Lady', thatch: '✦ Thatched', 'blue-door': '✦ Blue Door' };
const RARE_LINE = {
  'painted-lady': 'the talk of the street', thatch: 'old thatch, older family',
  'blue-door': 'a blue door, for luck'
};
/**
 * WHICH STRETCH OF THE RANGE PAID FOR BUILDING n.
 * The town is a pure function of one running total, so every building has an
 * exact moment it was earned: the bucket in which the cumulative total first
 * crossed `tokensFor(n)`. That is a prefix sum over `bins` and a binary search
 * — the bins are already sorted by construction, and the prefix is rebuilt only
 * when a bucket actually moves, so a card open for a minute costs one pass.
 * `bins` mixes widths (folded history at 15 min / 1 h / 6 h, the live tail at 5)
 * so the ANSWER CARRIES ITS OWN WIDTH; never assume INT_MS at the call site.
 * @returns {?{ms:number, wMs:number, tok:number}} null when nothing paid for it
 *          yet, or when the range carries a history floor the buckets never saw.
 */
let paidVer = -1, paidAt = null, paidCum = null, paidW = null;
function paidFor(n) {
  const want = tokensFor(n);
  if (!(want > 0) || !bins.size) return null;
  if (paidVer !== binsVer) {
    paidVer = binsVer;
    const keys = Array.from(bins.keys()).sort((a, b) => a - b);
    paidAt = keys; paidCum = new Float64Array(keys.length); paidW = new Float64Array(keys.length);
    let s = 0;
    for (let i = 0; i < keys.length; i++) {
      const b = bins.get(keys[i]);
      s += b.tok; paidCum[i] = s; paidW[i] = b.w || INT_MS;
    }
  }
  const last = paidCum.length - 1;
  if (paidCum[last] < want) return null;      // the buckets never reached it
  let lo = 0, hi = last;                      // first index whose prefix ≥ want
  while (lo < hi) { const m = (lo + hi) >> 1; if (paidCum[m] >= want) hi = m; else lo = m + 1; }
  return { ms: paidAt[lo], wMs: paidW[lo], tok: paidCum[lo] - (lo ? paidCum[lo - 1] : 0) };
}
/** "14:05–14:10" — the burst itself, in the width the bucket actually has. */
const paidSpan = p => `${fmtClock(p.ms)}–${fmtClock(p.ms + p.wMs)}`;
/** scratch for reading a memorial group's world position — describeEnt only */
const _wp = new THREE.Vector3();

/**
 * @param {Object} e a tagged entity @returns {Deed} interact.js's card contract
 */
function describeEnt(e) {
  const at = (x, y, z, hTop) => ({ x, y: y || 0, z, hTop: hTop || 3.5 });
  // memorial.js's own entities (the Chronicle Stone, the horizon ghost, the
  // bunting) carry their own copy — they know things town.js has no business
  // knowing. What they DON'T carry is an anchor: `tip()` is the v3 three-string
  // form, so without this wrapper the deed opened with no ring, no Focus and a
  // camera that never moved. `live` matters as much: the stone is engraved from
  // the chronicle, and a card opened in the second before the feed lands would
  // otherwise read "the mason waits" for as long as it stayed open.
  if (e && typeof e.tip === 'function') {
    const t = e.tip();
    if (!Array.isArray(t)) return t;                 // already a Deed — pass it through
    const g = e.group;
    if (g) g.updateMatrixWorld();
    const p = g ? g.getWorldPosition(_wp) : null;
    return {
      title: t[0] || '', sub: t[1] || '', rows: [], flavor: t[2] || '',
      // The ghost is a billboard 640 units out on the eastern road: flying to it
      // would land the camera nose-first against a flat plane, so it is a thing
      // you read from the town, not a place you go.
      acts: p && e.memTop > 0 ? ['focus'] : [], live: true,
      at: at(p ? p.x : 0, 0, p ? p.z : 0, e.memTop || 5)
    };
  }
  if (e.kind === 'monument') {
    const nx = nextRung();
    return {
      // The SAME prosperity the footer prints. `monument.tier` is the fountain's
      // own rung (0–10) and saying "Prosperity 0" under a Tiered Fountain while
      // the footer said "Prosperity IV" was two numbers for one idea.
      title: monument.tierName || 'The Village Fountain',
      badge: 'Prosperity ' + roman(Math.floor(prosperity(T)) + 1),
      sub: `${ctx.rangeLabel} · ${built} buildings`,
      rows: [
        ['tokens', `${fmtTok(T)} ${ctx.rangeShort}`],
        ['next', `${rungName(nx)} at ${fmtTok(nx.tok)}`],
        ['progress', `${Math.round(nextProgress(nx) * 100)}%`],
        ['milestones', String(mileCount)],
        ['villagers', String(npcs.count)]
      ],
      flavor: 'Everything here was paid for in tokens.',
      acts: ['focus', 'tour'], live: true,
      // y is the BASE, not the middle: camera.js's aimAt already lifts its target
      // by hTop·0.55, and handing it a mid-height put the camera inside the
      // centrepiece. Framing off the bounding radius is continuous, so the
      // first-day basin still gets the close look. The fountain no longer
      // outgrows aimAt's clamp the way the altar did — it tops out under 7
      // units — but the rule costs nothing and survives the next redesign.
      at: Object.assign(at(MON_POS.x, 0, MON_POS.z, monument.crownHeight || 8),
        { dist: Math.max(monument.radius, (monument.crownHeight || 8) * .5) * 3.2 + 12 })
    };
  }
  if (e.kind === 'signpost') return {
    title: ctx.townName, sub: `${townPhrase()} · seed ${seedHex}`,
    rows: [
      ['showing', ctx.rangeLabel],
      ['since', sinceOf(curRange).replace(/^ · since /, '') || '—'],
      ['buildings', String(built)],
      ['villagers', String(npcs.count)]
    ],
    flavor: 'Every day draws a different town.',
    acts: ['focus', 'tour'], at: at(signGroup.position.x, 2, signGroup.position.z, 3.6)
  };
  if (e.kind === 'scaffold') return {
    title: 'next building', sub: `#${e.n} · ${Math.round(e.p * 100)}%`,
    rows: [['still to go', `${fmtTok(e.left)} tokens`], ['this one costs', fmtTok(costOf(e.n))]],
    acts: ['focus'], live: true,
    at: at(meterScaf.position.x, 1.5, meterScaf.position.z, 4)
  };
  if (e.kind === 'grove') return {
    title: 'a break 🌳',
    sub: `${fmtClock(e.grove.start)} → ${fmtClock(e.grove.end)}`,
    rows: [['lasted', fmtDur(e.grove.end - e.grove.start)], ['tokens', 'none — the town was quiet']],
    flavor: 'The wood grew back while nobody was working.',
    acts: ['focus'], at: at(e.group.position.x, 1.5, e.group.position.z, e.hTop || 3)
  };
  if (e.kind === 'landmark') {
    const p = paidFor(townSize(e.tok));
    return {
      title: e.label, badge: '🏛 landmark',
      sub: `landmark ${e.order} of ${LM_ORDER.length}`,
      // The HOUSE branch's rule, applied here too. `e.at` is Date.now() at the
      // moment the renderer placed the group, which for everything the founding
      // cascade backfills is app-launch time — so the card printed 'raised 22:12'
      // beside 'paid for by your 11:00-11:15 run' with the header clock reading
      // 22:12. When the buckets can answer, they ARE the answer.
      rows: [
        ['unlocked at', fmtTok(e.tok) + ' tokens'],
        p ? ['paid for by', `the ${paidSpan(p)} run`] : ['raised', fmtClock(e.at)]
      ],
      acts: ['focus', 'walk', 'tour'],
      at: at(e.group.position.x, 0, e.group.position.z, e.hTop || 9)
    };
  }
  // A VILLAGER. interact.js has a fallback card for a caller with no describe(),
  // but it can only read name/trade/home/quarter — and `home` is a house TYPE
  // ('cottage'), not an address. town.js is the only module that knows which
  // BUILDING a villager lives in, and it was never asked. The roster knows a dozen
  // things; five of them are worth a card.
  if (e.kind === 'villager') {
    const v = e.view || (npcs.personAt ? npcs.personAt(e.handle) : null);
    if (!v) return { title: 'One of the villagers', sub: 'out on the road', rows: [], acts: ['follow'] };
    const rows = [];
    if (v.homeN > 0) rows.push(['lives at', '#' + v.homeN + (v.quarter ? ' on the ' + v.quarter : '')]);
    else if (v.quarter) rows.push(['lives on the', String(v.quarter)]);
    if (v.place) rows.push(['works at', String(v.place)]);
    // `friend` and `rival` are roster HANDLES, not names — printing them raw put
    // 'rival of 158' on a card whose whole job is to make a villager a person.
    const who = id => { const q = (id != null && npcs.personAt) ? npcs.personAt(id) : null; return q && q.name ? q.name : ''; };
    const fr = who(v.friend), rv = who(v.rival);
    if (fr) rows.push(['friend of', fr]);
    else if (rv) rows.push(['rival of', rv]);
    const alive = v.alive !== false;
    return {
      title: v.name || 'One of the villagers',
      badge: v.crier ? '📣 the Crier' : v.hero ? '★' : '',
      sub: v.trade || v.job || 'out on the road',
      rows, live: true,
      acts: alive ? ['follow'] : [],
      at: alive ? at(v.x, 0, v.z, 1.4) : undefined
    };
  }
  if (e.kind === 'bridge') return {
    title: e.label, badge: '🌉',
    sub: plan.water && plan.water.kind === 'lake' ? 'the lake causeway' : 'the river crossing',
    rows: [['built at', `${e.n} buildings`], ['spans', `${Math.round(e.span || 0)} paces`]],
    acts: ['focus', 'walk'],
    // The deck, not the riverbed: `y: 0` framed the water under the bridge.
    at: at(e.group.position.x, e.group.position.y || 0, e.group.position.z, e.hTop || 4)
  };
  // …and a house, which is the case that matters: THIS one cost THAT much, and
  // here is the stretch of your own day that paid for it.
  const rare = rareOf(e.idx), p = paidFor(e.n);
  const rows = [
    ['cost', fmtTok(costOf(e.n)) + ' tokens'],
    // `settledAt` is when the RENDERER raised it, which for everything the
    // founding cascade backfills is "a moment ago" — printing that beside a real
    // 12:00–12:15 burst read as a contradiction. When the buckets can answer,
    // they are the answer; the clock is only the fallback.
    p ? ['paid for by', `the ${paidSpan(p)} burst`] : ['settled', fmtClock(e.settledAt)],
    ['roof', `${roofNameOf(e.idx)} · band ${e.band}`]
  ];
  return {
    title: e.label || TIER_NAMES[e.tier], badge: rare ? RARE_TAG[rare] : '',
    sub: `#${e.n} of ${built}`,
    rows, flavor: rare ? RARE_LINE[rare] : '',
    acts: ['focus', 'walk'],
    at: at(e.group ? e.group.position.x : 0, 0, e.group ? e.group.position.z : 0, e.hTop || 3.5)
  };
}

/* ═══ the Crier, out loud ═══════════════════════════════════════
   Both halves of this shipped built and neither was ever called, so the town's
   named Crier existed only as a masthead over the ticker. npcs owns the walk
   (folk[0] crosses to the plaza rim on the camera's side, wall-clock arrival
   deadline, then turns to face the camera); news owns the bubble pool, the
   crier-only styling and the wider max-width, and never evicts a crier bubble.
   town.js is the only module that can introduce them, which is all this is.

   Paced on the WALL CLOCK and gated on the headline actually changing: a Crier
   who re-reads the same line every 6 s is noise, and one paced by frame count
   would never open his mouth in a headless capture. */
let crierAt = 0, crierSaid = '', crierBubbled = false;
const _cv = new THREE.Vector3();
function stepCrier(now) {
  if (npcs.crierSpeaking()) {
    // ONE BUBBLE PER ANNOUNCEMENT. news.say() gives a crier line VIP treatment —
    // it evicts a bubble to make room rather than losing the marquee moment — so
    // offering it every frame would have him retiring one of his neighbours' lines
    // sixty times a second. Retry only while the offer is still being refused
    // (he can be off screen when he reaches his mark).
    const c = npcs.crier();
    if (c && c.ready && !crierBubbled
      && news.say(_cv.set(c.x, c.y, c.z), 'crier', { text: c.text, who: c.name })) crierBubbled = true;
    return;
  }
  crierBubbled = false;
  if (now - crierAt < 9000) return;
  const h = news.headline();
  const line = h && h.plain ? h.plain : '';
  // Nothing new to cry. The ticker keeps scrolling; he just does not repeat it.
  if (!line || line === crierSaid) { crierAt = now - 6500; return; }
  if (npcs.announce(line)) { crierSaid = line; crierAt = now; }
  else crierAt = now - 6500;     // he could not get there; try again shortly
}

/* ═══ the bubble sampler ════════════════════════════════════════ */
// npcs never knows news exists: town.js pulls a speaker and relays the line.
let bubbleAt = 0, bubbleTurn = 0;
const BUB_WANT = ['bridge', 'worship', null, 'stroll', null, 'bridge'];
function pullBubble(now) {
  // 2200 ms wall-clock cadence, first pull at 900 ms: a short shot must still
  // catch somebody mid-sentence.
  if (!bubbleAt) { bubbleAt = now + 900 - 2200; }
  if (now - bubbleAt < 2200) return;
  bubbleAt = now;
  // Three attempts, not one. news.say() rejects a speaker that is off screen, out
  // of range, or whose bubble would land on top of another one or on the altar's
  // ledger — and a single silent drop per 2.2 s turn is how the town went quiet
  // exactly when it got big. Retrying costs one more random villager pick.
  for (let tryN = 0; tryN < 3; tryN++) {
    const want = ctx.night > .55 && (bubbleTurn % 2) ? 'home' : BUB_WANT[bubbleTurn % BUB_WANT.length];
    bubbleTurn++;
    const st = npcs.pickSpeaker(want, _bv) || npcs.pickSpeaker(null, _bv);
    if (!st) continue;
    const kind = st === 'home' ? 'night' : st === 'worship' ? 'worship' : st === 'cheer' ? 'cheer'
      : st === 'bridge' ? 'bridge' : 'stroll';
    // npcs.js writes the line for the villager it just picked — their own trade,
    // house and quarter, and whatever the town has just built. '' ⇒ news.js's pool.
    const text = npcs.speechLine ? npcs.speechLine() : '';
    if (news.say(_bv, kind, text ? { text } : undefined)) return;
  }
}

/* ═══ pace: tokens/min and how that compares to this epoch ══════ */
let medianAt = -1e9, medianPerMin = 0;
const _rates = [];
function computePace(simNow) {
  let s = 0;
  const from = simNow - 30 * 60000;
  for (const [b, v] of bins) if (b >= from) s += v.tok;
  ctx.perMin = s / 30;
  if (performance.now() - medianAt > 5000) {
    medianAt = performance.now();
    // MIX NO BIN WIDTHS. `bins` holds two populations: folded history rows whose
    // width is 15 min / 1 h / 6 h, and the live tail at the native 5 min. A 6-hour
    // bin's rate is an average over six hours; ctx.perMin is instantaneous, so
    // dividing one by a median of the other made `range=all` sit pinned at the
    // clamp (ratio 23) forever — permanent "boom" weather, permanent BOOM ticker,
    // and the one signal meant to say "you are working harder than usual" saying
    // it unconditionally on 8 of the 13 range keys. Sample the native tail only;
    // fall back to the mixed set just when the tail is too short to have a median.
    _rates.length = 0;
    for (const v of bins.values()) if (v.tok > 0 && v.w === INT_MS) _rates.push(v.tok / (INT_MS / 60000));
    if (_rates.length < 6) {
      _rates.length = 0;
      for (const v of bins.values()) if (v.tok > 0) _rates.push(v.tok / (v.w / 60000));
    }
    _rates.sort((a, b) => a - b);
    medianPerMin = _rates.length ? _rates[_rates.length >> 1] : 0;
  }
  ctx.paceRatio = medianPerMin > 0 ? clamp(ctx.perMin / medianPerMin, 0, 20) : 1;
}

/* ═══ main loop ═════════════════════════════════════════════════ */
const statsEl = document.getElementById('stats'), clockEl = document.getElementById('clock');
const wxChip = document.getElementById('wxChip');
// THE SKY STOPS, RE-TUNED FOR THE POST PASS. The dome is a raw ShaderMaterial:
// it writes gl_FragColor with no <colorspace_fragment>, so in v3 its linear
// value went STRAIGHT to an sRGB framebuffer and was silently darkened once —
// which is the deep blue everyone tuned these hexes to, and also why the sky
// never matched the fog on the buildings in front of it (a lit material's fog
// IS encoded). postfx renders into a linear buffer and encodes exactly once at
// the composite, so that accident is gone and #5f95d6 would now be literally
// #5f95d6: a milky, low-contrast noon. `stop()` pre-applies the EOTF the old
// path applied by mistake, so the sky keeps the colour it has always had — and
// the fog, the veil and the far land now agree with it instead of fighting it.
// (Display equivalents, for anyone eyedropping a screenshot: topDay #1D4DAC,
// botDay #80ACD2, topNight #000001, botNight #010306, warm #CC541B.)
// It is a LIVE property, not a constant: postfx's auto-downgrade ladder can
// reach 'off' on a slow machine, and a sky baked for the wrong pipeline is a
// black hole where the sky was. Re-derived only when the tier actually flips.
const SKY_HEX = {
  topDay: 0x5f95d6, botDay: 0xbcd6ea, topNight: 0x04060f, botNight: 0x101a2c,
  warm: 0xe79b5c,
  // weather's targets — reached only when its grade asks for them
  overcastTop: 0x6E7A88, overcastBot: 0xA8B2BC
};
// A TINT, NOT A COLOUR. `roadMat` carries no base colour of its own — the plate
// IS `roadTex`, multiplied by a white `color` — so this value is a MULTIPLIER on
// the painted road, not the shade a wet road should end up. The first value here
// was 0x6E6A63, which is what a wet road looks like; as a multiplier it took the
// texture down 6.5× in linear light, and under a storm's dimmed key every street
// in the town rendered as a black chasm between brightly lit fields. A real wet
// surface is about half as bright as a dry one, and half is what this is.
const SKY = { roadWet: new THREE.Color(0xCFCAC2), roadDry: new THREE.Color(0xFFFFFF) };
// The colour the key light takes under heavy cloud: a cold, slightly blue white,
// not the 0xffe0b0 of an afternoon. Held as a Color so the per-frame lerp costs
// nothing.
const OVERCAST_KEY = new THREE.Color(0xC6CFD8);
for (const k in SKY_HEX) SKY[k] = new THREE.Color();
let skyLin = null;
function setSkyEncoding(lin) {
  if (lin === skyLin) return;
  skyLin = lin;
  for (const k in SKY_HEX) {
    SKY[k].setHex(SKY_HEX[k]);
    if (lin) SKY[k].convertSRGBToLinear();
  }
}
setSkyEncoding(post.enabled);
// The wind clock: sails and washing are paced by it, so a gust speeds them up
// without teleporting them (multiplying `now` by a factor does exactly that).
let windClock = 0, windLast = performance.now(), flashCss = -1;
const docStyle = document.documentElement.style;
let last = performance.now(), statAt = -1e9, statTok = -1, heroDisp = -1;
let nextTxt = '', nextTxtTok = -1, wasNight = null;
// Per-frame scratch. tick() used to mint a Date, a Vector3 and a rung object
// every frame and force a synchronous layout with getBoundingClientRect().
const _date = new Date(), _v = new THREE.Vector3(), _sd = new THREE.Vector3();
const _c = new THREE.Color();
let canvasRect = null;
// Any error would otherwise be invisible in a headless screenshot run.
// The banner carries the message; the console carries the STACK. main.js only
// forwards console output at warn level or above, and without the stack an
// uncaught throw inside hardReset reads as "Renderer error: Cannot set
// properties of null" with no way to tell which of fourteen modules said it.
window.addEventListener('error', e => {
  console.warn('Renderer error:', (e.error && e.error.stack) || e.message);
  showError('Renderer error: ' + e.message);
});
function resize() {
  const w = Math.max(2, stage.clientWidth), h = Math.max(2, stage.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  post.setSize(w, h);                    // CSS px — the same w/h renderer.setSize got
  lod.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  canvasRect = null;
}
function tick(now) {
  const t0 = BENCH_ON ? performance.now() : 0;   // FIRST statement — bench.sample's window
  // dt is clamped hard for particle physics; wdt tracks the real wall clock so
  // pop-ins and floaters still finish on time in a 3 fps headless run.
  const raw = (now - last) / 1000;
  const dt = clamp(raw, 0, .05), wdt = clamp(raw, 0, .5); last = now;
  const simNow = Date.now();

  // day/night from the real local clock (?hour=N overrides, for visual tests)
  _date.setTime(simNow);
  const hcur = HOUR_OVERRIDE !== null ? HOUR_OVERRIDE
    : _date.getHours() + _date.getMinutes() / 60 + _date.getSeconds() / 3600;
  const day = dayAmount(hcur), night = 1 - day;
  const st = clamp((hcur - sunSr) / Math.max(sunSs - sunSr, .1), 0, 1);
  const sunA = Math.PI * (1 - st), sunE = Math.sin(Math.PI * st) * 1.05 + .06;
  // direction first, then offset by the shadow centre: the sun BALL is placed
  // from the direction alone, or a river town's offset would tilt the sky.
  _sd.set(Math.cos(sunA) * 120, Math.sin(sunE) * 110, -30);
  sun.position.set(sunCtr.x + _sd.x, _sd.y, sunCtr.z + _sd.z);
  // L1b's rebalance, and it SHIPS WITH postfx: the tone curve is authored
  // against a key that exceeds 1.0 linear on lit plaster. On the old 1.45 key
  // noon comes out flat and dim and the post pass takes the blame.
  sun.intensity = day * 2.35 * LI;
  const glowK = clamp(Math.max(0, 1 - Math.abs(hcur - sunSr) / 1.4, 1 - Math.abs(hcur - sunSs) / 1.4), 0, 1);
  sun.color.setHex(glowK > .3 ? 0xffb877 : 0xffe0b0);
  skyMat.uniforms.top.value.copy(SKY.topNight).lerp(SKY.topDay, day);
  const bot = skyMat.uniforms.bot.value;
  // The warm band is NOT multiplied by `day`. Multiplying it by the very
  // quantity that collapses at dusk left a 10 % tint at the exact hour the sky is
  // supposed to be on fire — the golden hour simply never happened.
  bot.copy(SKY.botNight).lerp(SKY.botDay, day).lerp(SKY.warm, glowK * .82);
  scene.fog.color.copy(bot);
  // Sun ball on its own dome, with an elevation floor, so it clears the ground
  // disc and is actually IN FRAME around sunrise and sunset.
  _sd.normalize();
  const el = Math.max(Math.asin(clamp(_sd.y, -1, 1)), SUN_EL_MIN);
  const hl = Math.hypot(_sd.x, _sd.z) || 1, ch = Math.cos(el);
  sunBall.position.set(_sd.x / hl * ch * SUN_R, Math.sin(el) * SUN_R, _sd.z / hl * ch * SUN_R);
  sunBall.visible = day > .02;
  sunHalo.visible = day > .02;
  sunHalo.position.copy(sunBall.position);
  sunHalo.quaternion.copy(camera.quaternion);
  sunHalo.material.opacity = .30 + glowK * .55;
  sunHalo.scale.setScalar(110 + glowK * 130);
  // NIGHT IS NOT DAY WITH THE KEY TURNED OFF. L1b's rebalance cuts the fill
  // because the sun now carries the picture — but after dark there is no sun to
  // carry it, and the curve's night anchor sits high enough that a town at 3 %
  // linear lands under the black point and disappears entirely. The DAY term
  // takes the cut (0.30 against a 2.35 key is the ratio the tone curve wants);
  // the NIGHT terms go UP, because the only lights left are the moon, the
  // lamps and the windows.
  moon.position.set(-60, 80, 40); moon.intensity = (.05 + night * .24) * LI;
  hemi.intensity = (.17 + .30 * day) * LI;
  // Night is a little blue, not just dark: pulling the hemisphere's ground term
  // toward the moon keeps saturated red roofs from screaming at midnight.
  hemi.color.setHex(0xbdd3ea); hemi.groundColor.setHex(night > .5 ? 0x2a3446 : 0x3b4028);
  for (const m of starMats) m.opacity = m.userData.peak * Math.pow(night, 1.4);
  // T-12: the lamplighter keeps the hours the USER keeps. `lampK` only ever
  // EXTENDS lamp time — it is maxed against `night`, never subtracted from it —
  // and at confidence 0 it returns 0, so this is bit-identical until the data
  // says something. A night worker gets a town still lit when they arrive.
  const lampN = Math.max(night, shift.conf * shift.lampK(hcur, sunSr, sunSs));
  for (const l of lampGlow) {
    if (l.pt) l.pt.intensity = lampN * 20;
    l.bulbM.color.setHex(0xffd68c).multiplyScalar(.3 + lampN * .8);
  }
  POOL_MAT.opacity = .52 * clamp(lampN * 1.5 - .25, 0, 1);

  // ── the weather grades the SCENE (§4.2's layering law) ──────────
  // Every one of these is exactly neutral until weather.js lands: `wx` is the
  // null object whose grade is 1.0/0.0 to the bit, so this block is a no-op on a
  // clear day and on today's tree. It sits AFTER the sun/sky writes and BEFORE
  // env.update(), which samples the fog once per frame.
  wx.update(dt, now, ctx);
  const G = wx.grade;
  sun.intensity *= G.sunMul;
  hemi.intensity *= G.hemiMul;
  moon.intensity *= G.moonMul;
  sunBall.material.opacity *= G.sunBallA; sunHalo.material.opacity *= G.sunBallA;
  // WEATHER HAS NO LIGHT OF ITS OWN. Both of weather's tints are authored as the
  // colour the sky and the haze TURN — 0x6E7A88 overcast, 0xD8DEE4 mist — and
  // those are daylight values. Applied flat they lit a midnight mist to a pale
  // grey and put a lavender ceiling over the town at 22:00, which is a fog bank
  // being brighter than the moon that is supposed to be lighting it. Both are
  // scaled by the daylight there is to scatter; the small floor is real (cloud
  // and mist do bounce the town's own lamps back down) and keeps the regime
  // legible after dark instead of switching it off.
  const skyK = G.skyTintK * (.25 + .75 * day);
  const fogK = G.fogTintK * (.20 + .80 * day);
  if (skyK > 0) {
    skyMat.uniforms.top.value.lerp(SKY.overcastTop, skyK);
    bot.lerp(SKY.overcastBot, skyK);
    scene.fog.color.copy(bot);
    // AND THE LIGHT THE SKY IS MAKING. weather.js already dims the key and greys
    // the dome, but it deliberately does not reach into the sun's COLOUR or the
    // hemisphere's — those are scene quantities town.js owns, and the layering
    // law is what keeps this project's rendering honest. The consequence, until
    // now, was a town lit by a warm afternoon sun under a slate-grey overcast:
    // the single thing that still made rain read as a caption rather than as
    // weather. Under cloud the sun is diffuse and cold, so the key cools toward
    // the overcast the dome is wearing and the sky term follows its own ceiling.
    // Bounded at .72 so a storm still has a direction to its light.
    sun.color.lerp(OVERCAST_KEY, skyK * .72);
    hemi.color.lerp(skyMat.uniforms.top.value, skyK * .6);
  }
  // THE ONE LERP. environs handed fog.color back in the S4 handover, so after
  // town.js's base copy this is the only other writer there is.
  if (fogK > 0) scene.fog.color.lerp(_c.setHex(G.fogTint), fogK);
  scene.fog.density = fogFor(rig.fogDist, env.biome) * G.fogMul;
  for (const m of starMats) m.opacity *= G.starMul;
  // .95/.47 rather than the guide's .92/.47: a clear day must be bit-identical
  // to v3, and the road's shipped roughness is .95.
  // FROM DRY, every frame. `color.lerp(wet, k)` accumulates: it walks the tint
  // toward wet and, guarded on `k > 0`, has no way back — a shower that passed at
  // noon left the streets wet for the rest of the day and the rest of the epoch.
  roadMat.color.copy(SKY.roadDry).lerp(SKY.roadWet, G.wetK);
  roadMat.roughness = .95 - .48 * G.wetK;
  if (G.flash !== flashCss) { flashCss = G.flash; docStyle.setProperty('--flash', G.flash.toFixed(3)); }
  // The sails and the washing ride a WIND clock, not the wall clock: multiplying
  // `now` by a gust factor teleports them. windLast is rebased on the first tick.
  windClock += Math.min(now - windLast, 500) * G.windMul; windLast = now;

  // ── growth, all wall-clock paced ──
  stepRitual(now);
  if (fadeT > 0) {
    const k = clamp((now - fadeT) / fadeMs, 0, 1);
    for (const e of animEnts) if (e.group)
      e.group.scale.setScalar(Math.max(.01, (e.group.userData.baseScale || 1) * (1 - k)));
    if (k >= 1) {
      fadeT = -1;
      const m = pendingInit; pendingInit = null;
      // The seeds are derived BEFORE the teardown: hardReset rebuilds the plan,
      // and rebuilding it twice (once stale, once real) costs 60 ms of the fade.
      const rg = m.range || legacyRange(m);
      planSeed = SEED_OVERRIDE === null ? (rg.seed >>> 0) : SEED_OVERRIDE;
      daySeed = SEED_OVERRIDE === null ? daySeedOf(Date.now()) : SEED_OVERRIDE;
      // A DAY THAT ENDED DESERVES A FULL STOP. Midnight is the only teardown the
      // user did not ask for, so the day being torn down gets its Almanac page —
      // its name, its date, its skyline — before the new one is founded over it.
      // BEFORE hardReset: after it, `chronicle.todayIdx` has already rolled.
      if (dayRolled) almanac.showCard(shiftDayIndex(dayIndexOf(Date.now()), -1), { hold: 7000 });
      hardReset(); applyInit(m);
    }
  } else {
    drainSpawnQueue(now);
    drainFrontier(now);
    drainPromotionQueue(now);
    drainMilestoneQueue(now);
    updateGroves(simNow);
    updateScaffold();
  }
  drainFx(now);
  for (let i = risers.length - 1; i >= 0; i--) {
    const r = risers[i], k = clamp((now - r.t0) / 900, 0, 1);
    r.g.position.y = r.from * (1 - easeOutBack(k));
    if (k >= 1) { r.g.position.y = 0; if (r.e) r.e.rising = false; risers.splice(i, 1); }
  }

  // ── shared context, then the five modules ──
  ctx.day = day; ctx.night = night; ctx.simNow = simNow;
  ctx.totalTok = T; ctx.buildingCount = houses.length;
  // The top of the fountain's counter board. news.js keeps a screen-space
  // keep-out around it so a speech bubble can never sit on the number the whole
  // app exists to show — and without this it was guarding a generous world band
  // instead of the board's real extent, which silenced more plaza remarks than
  // it needed to.
  ctx.monumentTop = monument.crownHeight;
  const nx = nextRung();
  // Every 3D effect in the town was sized for the launch camera. One factor,
  // applied to the two particle pools and (at the call sites) to burst speeds.
  // The 26 floor stops a burst collapsing to specks while following a villager.
  fx = clamp(Math.max(rig.dist, 26) / 62, 1, 3.4);
  pMat.size = .34 * fx;
  puffMat.size = .9 * Math.min(fx, 2.2);
  // The altar asks for its plaza; town.js decides, and the plate follows.
  setPlazaR(Math.min(monument.plazaWant || 12, plan.innerR - 2.5));
  monument.setTotal(T);
  if (nx.tok !== nextTxtTok) { nextTxtTok = nx.tok; nextTxt = 'NEXT ' + fmtTok(nx.tok); }
  monument.setNext(nx.tok, nextProgress(nx), nextTxt);
  monument.update(dt, now, ctx);
  // No villagers before the cascade — the plat is empty ground by design.
  if (introT0 > 0 && introFull && now - introT0 < 900) npcs.setPopulation(0);
  else npcs.setBuildingCount(houses.length);
  // Somebody is standing in the street. In stroll mode `camera.position` in x/z
  // IS the walker's feet — the rig hangs its goal a look-length down the gaze,
  // so the eye lands back on the walker — and the crowd steps round it. Villagers
  // used to walk straight through wherever the user was standing.
  // 1.5 units is 2.7 m, and it is a judgement between two agents who disagreed
  // for good reasons. The camera side wanted 1.9 (3.4 m) so a villager does not
  // fill the frame from an eye at 1.60 m; the crowd side wanted 1.15 (2.05 m),
  // which is what a real passing distance on a lane actually is. At 1.15 a
  // passer-by covers 86 % of the frame height, at 1.9 barely half; 1.5 puts them
  // at two thirds, which reads as somebody stepping past rather than looming.
  if (rig.mode === 'stroll') npcs.setViewer(camera.position.x, camera.position.z, 1.5);
  else npcs.clearViewer();
  npcs.update(dt, now, ctx);
  mayor.update(dt, now, ctx);
  market.update(dt, now, ctx);
  events.update(dt, now, ctx);
  audio.update(dt, now, ctx);
  env.update(dt, now, ctx);

  // ── the surface pass: the sky's own colour, at the fragment ─────
  // AFTER env.update, not before it. env is what recomputes uLandFar from the
  // current fog colour, sun elevation and haze; reading it above meant the far end
  // of the town was always matched to the PREVIOUS frame's far land. At 60 fps
  // that is 16 ms and invisible, but a headless capture paints at 1-3 fps, so the
  // one place in the picture pipeline that broke the wall-clock rule was the one
  // whose whole job is that the far town and the far land agree.
  SURF.uRimCol.value.copy(skyMat.uniforms.top.value).lerp(WHITE, .35);
  SURF.uRimK.value = .20 + .26 * day + .30 * night;
  SURF.uBaseAO.value = .34 - .10 * night;
  SURF.uLandFar.value.copy(env.landFar());
  // `viewDist` is HOW FAR THE WORLD SHOULD READ; `dist` is how far the camera
  // stands off its subject. They are the same number in every mode except on
  // foot, where the camera sits ON its target and dist collapses to ~9 — which
  // would set the far fade to (4.9, 27.9) and blend everything past two houses
  // into the flat far-land colour. audio.js reads `dist` on purpose (walking
  // down there is audibly inside the town), so the two genuinely differ.
  SURF.uFarD.value.set(rig.viewDist * .55, rig.viewDist * 3.1);

  news.update(dt, now, ctx);
  // _sd points TOWARD the sun (normalised above); the blobs stretch away from it.
  grounding.update(now, ctx, _sd);
  memorial.update(dt, now, ctx);
  almanac.update(now);
  if (gotData && ctx.intro >= 1) { stepCrier(now); pullBubble(now); }

  // ── buildings: type-agnostic, never branch on kind ──
  // A pane is 0.4 × 0.5 units and the camera frames a 200-unit town: at 1.4 the
  // windows were sub-pixel and the night town read as unlit. Overdriven emissive
  // is what makes "somebody is home" legible from the framing distance.
  // T-12 biases who is home: an evening person's town has more lit windows at
  // 21:00 and fewer at 07:00. `windowLitBias` is ±0 at confidence 0.
  const winI = clamp(night + shift.dress.windowLitBias * shift.livelinessAt(hcur), 0, 1) * 2.2 + .04;
  // Written unconditionally. A "only when it changed" guard latched on frame 1 —
  // before a single building existed — and because buildings.js shares ONE
  // emissive material town-wide, every window in the town then stayed at 0 for
  // the rest of the run. Whether it is dirty is not knowable from here.
  for (const e of animEnts) {
    const g = e.group; if (!g) continue;
    const u = g.userData;
    if (u.winMats) for (const m of u.winMats) m.emissiveIntensity = winI;
    if (u.glow) for (const a of u.glow) a.mat.emissiveIntensity = a.day + (a.night - a.day) * night;
    if (u.pointLights) for (const l of u.pointLights) l.intensity = 16 * (.12 + night);
    if (u.spin) for (const a of u.spin) a.obj.rotation[a.axis] = a.phase + windClock * a.rate;
    if (u.sway) for (const a of u.sway) a.obj.rotation[a.axis] = a.amp * Math.sin(windClock / a.period);
    if (u.smoke) for (const a of u.smoke)
      if (a.world && now - a.last > a.every * smokeK) { a.last = now; puff3d(a.world, a.size); }
    const bs = u.baseScale || 1;
    if (e.popT < 1) {
      e.popT = Math.min(1, e.popT + wdt * 2.4);
      g.scale.setScalar(Math.max(easeOutBack(e.popT) * bs, .01));
      g.matrixAutoUpdate = true;
    } else if (e.bumpT < 1) {
      e.bumpT = Math.min(1, e.bumpT + wdt * 3);
      g.scale.y = bs * (1 + .08 * Math.sin(e.bumpT * Math.PI));
      g.matrixAutoUpdate = true;
    } else if (g.matrixAutoUpdate && !e.rising) {
      // settled for good: stop recomposing a matrix that will never change again
      g.updateMatrix(); g.matrixAutoUpdate = false;
      settleToLod(e, g);          // …and hand it to the far town
    }
  }

  // Wall clock, not the physics dt. Both pools decay their life by the step they
  // are given, so at ~1 fps a 3 s chimney puff took a full minute to expire AND
  // rose 3 cm a frame — every roof in a 1200-building town wore a frozen white
  // cotton ball. wdt === dt at any real frame rate; this only bites headless.
  stepParts(wdt, now); stepPuffs(wdt, now);
  if (floaters.length) {
    if (!canvasRect) canvasRect = canvas.getBoundingClientRect();
    const r = canvasRect;
    for (let i = floaters.length - 1; i >= 0; i--) {
      // age from an absolute birth stamp, exactly the way news.js ages a bubble:
      // accumulating wdt let a 1.6 s floater survive four frames (~5-8 s of wall
      // clock) at 1 fps, and "+1 house" ghosts hung over empty countryside.
      const f = floaters[i];
      const age = (now - f.born) / 1000;
      f.v.y += wdt * 1.4;
      _v.copy(f.v).project(camera);
      f.el.style.left = ((_v.x + 1) / 2 * r.width) + 'px';
      f.el.style.top = ((-_v.y + 1) / 2 * r.height) + 'px';
      f.el.style.opacity = Math.max(0, 1 - age / 1.6);
      if (age > 1.6) { f.el.remove(); floaters.splice(i, 1); }
    }
  }
  // THE RIG. `wdt`, never `dt`: where the camera is standing is existence-visible
  // in a headless screenshot, so a mode transition has to finish at 1 fps too.
  rig.setIntroBias(introDist(), introPol());
  rig.update(wdt, now, ctx);
  // The shadow frustum follows the rig's subject, re-armed at ≤ 12 Hz while it
  // is actually moving. A tour that never re-armed dragged the town's shadow map
  // along behind it for eight seconds a shot.
  if (rig.moving && now - shadowArmedAt > 84) { shadowArmedAt = now; armShadow(true); }
  ui.update(now, ctx);
  // The memory, per frame. Both take the WALL CLOCK — which pennants are up, how
  // far the inlay has crept, whether the ghost is in and whether the card has
  // outstayed its hold are all things a 1 fps screenshot has to show truthfully.
  // memorial's `dt` argument exists for a physics term it does not yet have.
  memorial.update(dt, now, ctx);
  almanac.update(now);
  clockEl.textContent = fmtClock(simNow);

  // wall-clock paced, not dt-paced: a low-frame-rate (e.g. headless) run must
  // still show current numbers rather than the pre-data zeros
  if (now - statAt > 500) {
    const statDt = Math.min(now - statAt, 4000);
    statAt = now;
    setSkyEncoding(post.enabled);               // the tier can drop under load
    // The almanac page is always a whole calendar DAY; the chrome under it is
    // usually a session or a rolling window. Tell the card which is which, or the
    // same date carries two different token counts with no explanation.
    almanac.setScope(curRange && curRange.key === 'today' ? ''
      : 'a whole day · the footer counts ' + (ctx.rangeShort || 'the live range'));
    // --vig HAS ONE WRITER AT A TIME, and this is where the baton changes hands:
    // an auto-downgrade to 'off' frees the shader vignette and environs takes the
    // CSS one back at the value the hour actually wants.
    env.setVignetteOwner(!post.ownsVignette);
    renderer.shadowMap.needsUpdate = true;      // the sun has moved a little
    // The top tier has five silhouettes now, so name the one that is actually
    // standing rather than always printing "Keep".
    // "Grandest" used to mean "the first house I found at the highest tier",
    // and the top tier has five silhouettes — so which one the footer named was
    // plot order, and a 33.9B town could report a Farmhouse where a 200M town
    // reported a Town House, which reads as a downgrade for spending more.
    // Rank by the tier first and then by the building's own ridge height, so it
    // means what the word means: the biggest thing standing.
    let grand = -1, grandTop = -1, grandName = '';
    for (const e of houses) {
      if (!e || e.flavor) continue;
      const h = e.hTop || 0;
      if (e.tier > grand || (e.tier === grand && h > grandTop)) {
        grand = e.tier; grandTop = h; grandName = e.label || TIER_NAMES[e.tier] || '';
      }
    }
    const flash = statTok >= 0 && T > statTok; statTok = T;
    smokeK = clamp(houses.length / 24, 1, 26);
    const L = prosperity(T);
    computePace(simNow);
    // The hero rolls up alongside the 3D counter instead of snapping in 500 ms
    // steps; the two used to visibly disagree while sitting next to each other.
    // The altar's counter eases on the WALL CLOCK (260 ms constant); a per-tick
    // easing here made the footer take nine seconds to catch up in a 1 fps run,
    // so the hero and the ledger sat side by side disagreeing by 1 %.
    // ONE OWNER for the headline number. Two independent easings against two
    // different clocks agreed only in the limit, and the ledger sits 200 px above
    // the hero — "818.2M" over "818.3M" reads as a rounding bug in the product's
    // most important figure. The altar's engraved value IS the number; the footer
    // prints what the altar says.
    const mon = monument.displayed;
    heroDisp = (typeof mon === 'number' && mon >= 0) ? mon
      : (heroDisp < 0 ? T : heroDisp + (T - heroDisp) * (1 - Math.exp(-statDt / 260)));
    if (Math.abs(T - heroDisp) < Math.max(1, T * 2e-5)) heroDisp = T;
    const np = Math.round(nextProgress(nx) * 100), sp = Math.round(scafEnt.p * 100);
    const bar = p => `<span class="bar"><i style="width:${clamp(p, 0, 100)}%"></i></span>`;
    // PACE PARTNER, not a finished-vs-unfinished race. Comparing a live window
    // against the previous window's FINAL total meant the footer opened on
    // "▼ 597.8M behind" and stayed there all day: true, and joyless. The feed now
    // also sends what the last window had scored at this same elapsed offset.
    const rival = prevAt > 0 ? prevAt : prevTok;
    const ahead = T - rival;
    statsEl.innerHTML =
      `<div class="zA">` +
      `<div class="row"><span class="hero${flash ? ' flash' : ''}" style="color:${ctx.accentCss}">${fmtTok(heroDisp)}</span>` +
      `<span class="heroLbl">tokens ${esc(ctx.rangeShort)}</span></div>` +
      // THE COMPARISON FIRES ONLY UPWARD. The pace partner fixed WHAT is compared
      // but not that a shortfall was rendered as a running deficit: a red
      // "▼ 288.2M behind this point in your last session", down-triangle and all,
      // sat pinned under the hero number for the whole of every quiet day. Being
      // behind on tokens is not a failure and this town has no other place where
      // it grades the user, so the down branch is gone. What is left when the
      // number is lower is a plain, warm statement of where the last window had
      // got to — the same fact, with no arrow, no colour and nothing to close.
      (prevTok > 0
        ? (ahead >= 0
          ? `<div class="row cmp up">▲ ${fmtTok(ahead)} ahead of ${prevAt > 0 ? 'this point in ' : ''}${esc(prevLabel.replace(/^beat /, '') || 'the last window')}</div>`
          : `<div class="row cmp">${esc(cap1(prevLabel.replace(/^beat /, '') || 'the last window'))} had reached ${fmtTok(rival)} by now</div>`)
        : '') +
      `</div>` +
      `<div class="zB">` +
      // No colour emoji down here. They were the only raster-styled elements in a
      // flat vector chrome and they cheapened it; the type carries the meaning.
      `<div class="row"><b>${houses.length}</b> buildings · <b>${npcs.count}</b> villagers · Prosperity <b>${roman(Math.floor(L) + 1)}</b></div>` +
      `<div class="row">${grand >= 0 ? `grandest <b>${esc(grandName)}</b> · ` : ''}<b>${groves.length}</b> breaks · ★ <b>${mileCount}</b> milestones · <b>${fmtTok(ctx.perMin * 60)}</b>/h` +
      (demoMode ? ` <span class="tag">— demo data</span>` : '') + `</div>` +
      `</div>` +
      `<div class="zC">` +
      // At the cap there is no next building, and a meter frozen at 0 % reads as a
      // stalled reward rather than as a finished one.
      (built >= N_CAP
        ? `<div class="row"><b>${N_CAP}</b> buildings — the plat is full</div>`
        : `<div class="row">next building ${bar(sp)} <b>${sp}%</b></div>`) +
      // THE PRESSURE RULE (§5): a meter only inside the last fifth. A bar sitting
      // at 12 % all afternoon is a chore chart; the same bar at 83 % is a thing
      // about to happen. Below the threshold the row just names what is coming.
      // "to go" became "away" for the same reason the deficit row went: a distance
      // is a fact, a shortfall is a debt.
      `<div class="row">✦ <b>${esc(rungName(nx))}</b> at ${fmtTok(nx.tok)}` +
      (np >= 80 ? ` ${bar(np)} <b>${np}%</b>` : '') +
      ` · ${fmtTok(Math.max(0, nx.tok - T))} away</div>` +
      `</div>`;
    // the Crier's world model — mutated in place, never reassigned
    facts.tok = T; facts.tokStr = fmtTok(T); facts.buildings = houses.length;
    facts.villagers = npcs.count; facts.breaks = groves.length;
    facts.grandest = grandName || (grand >= 0 ? TIER_NAMES[grand] : '');
    facts.landmark = lastLandmark; facts.rangeLabel = ctx.rangeLabel;
    // the Gazette can now read the same comparison the footer does
    facts.prevStr = prevTok > 0 ? fmtTok(prevAt > 0 ? prevAt : prevTok) : '';
    facts.perMin = ctx.perMin; facts.paceRatio = ctx.paceRatio;
    facts.tier = monument.tier; facts.tierName = monument.tierName || '';
    facts.night = night; facts.milestones = mileCount;
    // pace is posted only when the town's shape changed — a per-tick pace line
    // would drown every other category in the queue
    if (gotData && ctx.intro >= 1 && ctx.band !== lastPaceBand) {
      const firstRead = lastPaceBand === -2;
      lastPaceBand = ctx.band;
      if (ctx.band >= 0 && !firstRead) news.post('pace', {
        perMin: ctx.perMin, ratio: ctx.paceRatio,
        trend: ctx.paceRatio > 1.6 ? 'boom' : ctx.paceRatio < .5 ? 'slow' : 'steady'
      });
    }
    if (gotData && idleSince && simNow - idleSince > IDLE_MS && simNow - idleToldAt > 15 * 60000) {
      idleToldAt = simNow;
      news.post('idle', { minutes: Math.round((simNow - idleSince) / 60000) });
    }
    // The sky, named. `.chip:empty` collapses the badge, so a clear day says
    // nothing at all rather than announcing that nothing is happening.
    if (wxChip) {
      const wtxt = wx.label ? ((wx.glyph ? wx.glyph + ' ' : '') + wx.label) : '';
      if (wxChip.textContent !== wtxt) wxChip.textContent = wtxt;
    }
    // the FIRST read only latches: opening the town after dark is not nightfall
    if (wasNight === null) wasNight = night > .5;
    else if (gotData && (night > .5) !== wasNight) {
      wasNight = night > .5;
      news.post(wasNight ? 'nightfall' : 'daybreak', {});
    }
    // ── the memory, on the same tick ───────────────────────────────
    // The chronicle only counts a LIVE total when the window it is looking at is
    // the calendar day. On a 30-day dashboard `T` is a month and feeding it in
    // would engrave a month on a stone that says "greatest day".
    if (ctx.rangeIsDay) chronicle.setLive(T);
    // Both are signature-guarded and idempotent: 200 identical calls repaint
    // nothing. This is the cheapest place to keep them honest as the day moves.
    const cv = chronicle.view();
    memorial.setView(cv);
    almanac.setView(cv);
    // …and the Crier's four chronicle facts. news.js gates its CHRON and SPELL
    // pools on these, so without them the corpus that talks about the archive is
    // simply never in the bag — the lines exist and can never be drawn.
    facts.ghost = cv && cv.yesterday ? (cv.yesterday.name || '') : '';
    facts.bestStr = cv && cv.records && cv.records.bestDay && cv.records.bestDay.tok > 0
      ? fmtTok(cv.records.bestDay.tok) : '';
    // "towns in the archive BEFORE this one" — count includes today.
    facts.days = cv && cv.count > 0 ? cv.count - 1 : 0;
    facts.spell = cv && cv.spell ? cv.spell.len : 0;
    // A RECORD IS AN ENGRAVED FACT, not a progress bar. `recordsBrokenBy` is
    // self-latching and empty on day one — the first day is not a record broken,
    // it is the mason waiting.
    for (const b of chronicle.recordsBrokenBy(T)) {
      const at = memorial.celebrateRecord(b);
      if (at) burst3d(at, GOLD_HI, 44, 8);
      news.post('record', b);
    }
    // THE OVERTAKING fires upward only, at most once a day, and only while the
    // user is watching. There is no symmetric "you are behind" event and none
    // may ever be added. A forced seed makes "yesterday" the same town as today,
    // which would let a screenshot overtake itself.
    if (ctx.rangeIsDay && SEED_OVERRIDE === null) {
      const ov = chronicle.overtaking();
      if (ov) {
        const g = memorial.overtook();
        if (g) liftNineBirds(g);
        news.post('overtake', ov);
      }
    }
    // The charter reads the DAY, not the frame: once per wall-clock minute is
    // plenty, and a badge that arrives a minute after the hour it describes is
    // indistinguishable from one that arrives instantly.
    // `gotData` is part of the gate, not just of runCharter: stamping the clock
    // on a tick that could not check anything would have pushed the FIRST check
    // a full minute past the moment the feed arrived.
    if (gotData && now - charterAt > 60000) { charterAt = now; runCharter(); }
  }
  // ── the far town ───────────────────────────────────────────────
  // LAST thing before the image: it decides, for this frame, which buildings are
  // real groups and which are instances. It must run after the camera has moved
  // (rig.update) and after the settle hand-offs above, or a house registered this
  // frame would draw twice — once as a group, once as an impostor.
  lod.setCount(built);
  lod.update(now, ctx, houses);

  // ── the image ──────────────────────────────────────────────────
  // postfx grades the IMAGE; the weather graded the SCENE thirty lines up and
  // neither reads the other. gradeFor is pure, writes into one scratch object
  // and never accumulates, which is why a 1 fps headless frame is graded exactly
  // like a 60 fps one. Where the sharp band sits is a FRAMING decision, so
  // gradeFor deliberately refuses to write it.
  gradeFor(day, night, glowK, heatOf(ctx), _grade);
  // Where the sharp band sits is a FRAMING decision, which is why gradeFor
  // refuses to write it. It rides the altar: the one thing in the frame that is
  // always the subject, and the one thing that must never go soft.
  _v.set(MON_POS.x, monument.crownHeight * .45, MON_POS.z).project(camera);
  _grade.tiltCenter = clamp((1 - _v.y) * .5, .18, .82);
  post.setGrade(_grade);
  post.render(now);
  ui.afterRender();                       // the line AFTER the render, always
  // LAST statement of tick, after the render: renderer.info is only readable here.
  if (bench) bench.sample(now, t0, {
    buildings: houses.length, villagers: npcs.count, spawnQ: spawnQ.length,
    lod: lod.mode, hot: lod.hotCount, impostors: lod.activeCount
  });
}
function frame(now) { tick(now); requestAnimationFrame(frame); }
window.__tick = tick;   // manual stepping for automated tests

resize();
window.addEventListener('resize', resize);
buildVerge(); placeRoadLamps(); placePlazaLamps(); dressSignpost(); paintChrome();
refreshFraming();
rig.snap();


/* ═══ ?cam= — the camera's own test hook ════════════════════════ */
// camera.js deliberately parses no flags and interact.js parses only `select`,
// so this is the only place a verification run can ask for a mode. The delay
// lets the founding ritual place the town first: touring an empty plat is a
// six-shot reel of grass.
// --ledger=1 opens the Honours sheet once the record has arrived, which is the
// only way to photograph a trophy case that is built from a chronicle.
if (Q.get('ledger') !== null) schedule(3000, () => ui.honours && ui.honours());

const CAM = Q.get('cam');
if (CAM) {
  // 2600 ms, not 600. At 600 ms the founding cascade has not placed the landmarks
  // or the bridges yet, and nextShot SKIPS a shot whose at() cannot resolve — so
  // `--cam=tour:4` fell through 'landmark' and 'crossing' and parked on 'wide',
  // i.e. the flag did not land on the shot it names. Photo mode had the same
  // problem from the other end: it froze on the intro framing and called it a
  // beauty shot. The reel and the composition both want a town to exist first.
  const camAt = performance.now();
  const armCam = () => {
    // `ctx.intro >= 1` is interact.js's own test for 'the plat is a place now'.
    // The 9 s wall-clock backstop is for a run that never gets data at all.
    if (ctx.intro < 1 && performance.now() - camAt < 9000) { schedule(200, armCam); return; }
    if (CAM === 'photo') rig.photo(true);
    else if (CAM === 'follow') rig.follow(npcs.nearest({ x: 0, y: 0, z: 0 }, 500));
    else if (CAM.startsWith('tour')) {
      // `tour:0` is not shot zero — the reel is 1-based and 0 is falsy, so it used
      // to fold silently into 'start wherever'. Say so instead of guessing.
      const arg = CAM.split(':')[1];
      const n = arg === undefined || arg === '' ? NaN : Number(arg);
      if (arg !== undefined && arg !== '' && !(n >= 1)) {
        showError('--cam=tour:N counts from 1; there is no shot ' + arg + '.');
        return;
      }
      rig.tour(n >= 1 ? n : true);
    } else if (CAM === 'stroll') { rig.stroll(); rig.snap(); }
    else rig.orbit({ snap: true });
  };
  schedule(2600, armCam);
}

/* ═══ the bench, behind its flag ════════════════════════════════ */
// Imported dynamically so the normal path never loads the module at all. The
// hooks are the only way bench.js can reach into the town: it drives the feed
// (the leak gate synthesises epochs through it), pins the shot, and probes the
// arrays that would grow if an epoch leaked.
if (BENCH_ON) bench = (await import('./bench.js')).initBench(renderer, Q, {
  feed: onData,
  // cam = [az, pol, dist] or null. `pin(null)` freezes only the idle drift —
  // auto-framing has to keep working, or every scene measures a different town.
  pinCamera: cam => {
    benchPinned = true;
    rig.pin(cam);
    // pin() changes nothing about the pixel ratio, but --bench-dpr does, and
    // postfx samples getPixelRatio() only inside setSize(). Re-size it here or
    // the render targets keep the pre-pin resolution for the whole run and the
    // bench measures the wrong fill cost (§8.8).
    post.setSize(Math.max(2, stage.clientWidth), Math.max(2, stage.clientHeight));
  },
  probe: () => ({
    ladder: LADDER.length, bins: bins.size, cells: cell.size,
    animEnts: animEnts.length, hitTargets: hitTargets.length,
    floaters: floaters.length, liveScaf: liveScaf.length, fxQ: fxQ.length,
    grounding: grounding.count, surface: surface.surfaceStats().patched
  })
});

requestAnimationFrame(frame);
