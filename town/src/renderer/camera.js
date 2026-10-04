// camera.js — the rig. Every way the camera is allowed to move lives here, and
// nothing else in the app touches camera.position, camera.fov or the pointer.
//
// ONE IDEA: every channel is a GOAL with a follower. `g` is where the camera is
// going, `c` is where it is, and one exponential law closes the gap:
//     cur += (goal - cur) * (1 - exp(-wdt / tau))
// Modes write `g` and swap `tau`; applyCam() reads `c`. refreshFraming (town.js's
// setFrame) writes only the ORBIT goal, in every mode — which is what makes
// leaving a mode free: orbit() always returns to a framing correct for the town
// as it is NOW, not as it was when you left.
//
// WALL CLOCK, NOT dt. update() takes `wdt` (the clamped wall clock). Where the
// camera is standing is existence-visible in a headless screenshot, so at 1 fps a
// mode transition must still be finished inside a 9 s --shot-delay: tau .62 gives
// k = 1-exp(-.5/.62) = .55 per frame — 96 % arrived after 5 frames. Only the idle
// drift is cosmetic, and it is on the same clock so the two never disagree.
//
// PUBLIC SURFACE
//   initCamera(camera, cfg) -> rig
//     cfg {canvas, stage, sampleHeight, getPlan, getBuildings, resolveFollow,
//          onMode, onShot}   — every field optional; absent inputs no-op (§3 null
//          object rule), so wave-0 call sites may exist before the data does.
//   read-only  mode · dist · viewDist · fogDist · focusPoint · shadowCenter ·
//              shadowExtent · moving · dragging · dragPx · userDist · idleMs ·
//              shot · caption · beating
//   framing    setFrame(bounds, monTop) · setIntroBias(distMul, polAdd)
//              punch(strength?, ms?) · snap()
//   modes      orbit({snap}) · focus(anchor, opts) · follow(handle) ·
//              tour(on, shots?) · photo(on) · stroll(at?) · walkTo(x, z, opts?) ·
//              bookmark(i) · jumpTo(i) · beat(kind?, {delay,up})
//   utility    screenToGround(px, py, out) · update(wdt, now, ctx) · reset() ·
//              dispose()
//
// Everything in §4.1 of the backlog is here under its exact name. Five additions,
// all supersets: `reset()` (required of every v4 module by the epoch-leak rule);
// `tour(N)` where a number means "on, parked on shot N" (the --cam=tour:N hook);
// the read-only `shot`, `caption` and `idleMs` (the tour's pill line and dot row,
// and attract mode's only input); and `orbit({meta})`, which forwards a reason to
// onMode. `caption` is the string interact.js already reads for the mode pill.
// `screenToGround` takes CANVAS-RELATIVE css pixels, the same convention as
// town.js's `mousePx`.
//
// THE POINTER, IN ONE LINE EACH (the long version is above onDown):
//   LEFT drag  — PAN. The ground point you pressed on stays under the cursor.
//   RIGHT drag — ORBIT. Yaw and pitch about the target, clamped, with a flick.
//   wheel      — dolly, 22 % toward the cursor's ground point on the way in.
// On foot and while following someone there is nowhere to pan to, so there both
// buttons look around.
//
// COST: zero draw calls, zero per-frame allocation. ~40 flops, one lookAt and at
// most one updateProjectionMatrix per frame (~0.01 ms). The wheel does one
// unproject; so does each pointermove of a pan, and nothing else listens harder
// than a bookkeeping stamp.
// The stroll adds, per frame: one sampleHeight, one graph step (a hypot and a
// lerp; a junction costs one dot per adjacent edge, and nodes have 2-4), and a
// push test against a list of nearby walls that is rebuilt at 2.5 Hz by one O(n)
// pass over the building rows. It allocates nothing after the first walk — the
// wall list is a flat number array reused in place. What the MODE costs is not in
// this file: standing inside the town puts far more of it in the frustum and
// re-arms a 2048² shadow pass at 12 Hz. Both are measured in the report.
//
// WIRING THE INTEGRATION WAVE MUST DO (town.js, F1):
//   1. Delete town.js's camera block (target/az/pol/dist/idleT/userDist/dollyT,
//      dollyBias, fitBias, applyCam, the pointer/wheel/dblclick listeners) and
//      create the rig AFTER env (needs sampleHeight) and BEFORE the first
//      refreshFraming(). Keep sunCtr — it is the sun's target, not the camera's.
//   2. refreshFraming(): `rig.setFrame(b, monument.crownHeight || 8)`.
//   3. tick(): `scene.fog.density = fogFor(rig.fogDist, env.biome)` — the
//      distance is continuous now, so a once-per-structural-change write leaves
//      the fog wrong for eight seconds of a tour.
//   4. shadow frustum from `rig.shadowExtent` / `sunCtr.copy(rig.shadowCenter)`,
//      re-armed at <= 12 Hz (wall clock) while `rig.moving` in a close mode.
//   5. `rig.punch()` replaces both `if (!userDist) dollyT = performance.now()`.
//   6. tick(): `rig.setIntroBias(introDist(), introPol())` — the functions stay.
//   7. `fx = clamp(Math.max(rig.dist, 26) / 62, 1, 3.4)` — the floor keeps a
//      burst from collapsing to specks while following a villager.
//   8. `rig.update(wdt, now, ctx)` replaces `idleT += dt; … applyCam()`.
//   9. hardReset(): `rig.reset()`; shutdown: `rig.dispose()`.
//  10. interact.js: dblclick on an entity must call `e.preventDefault()` — the
//      rig's own dblclick handler re-frames the town only when the event was not
//      already consumed.
//
// WHAT THE STROLL (idea T-3) STILL NEEDS FROM town.js — two lines, both additive:
//   A. `SURF.uFarD.value.set(rig.viewDist * .55, rig.viewDist * 3.1)` — was
//      `rig.dist`. On foot `dist` is a 9-unit look-length, and (4.9, 27.9) flattens
//      everything past a couple of houses into the far-land colour. `viewDist` IS
//      `dist` in every other mode, so the swap changes no other frame.
//   B. the `--cam=` dispatch: `else if (CAM === 'stroll') { rig.stroll(); rig.snap(); }`
//      before the orbit fallback, so the mode is reachable from a headless shot.
// Nothing else. fog stays a one-writer affair — camera.js NEVER touches
// scene.fog; `fogDist` already reads >= 55 in stroll and town.js's existing
// per-frame `fogFor(rig.fogDist, …)` picks it up. The 12 Hz shadow re-arm is
// town.js's existing 84 ms gate on `rig.moving`, which stroll now holds true.
//
// WHAT THE SKY BEAT NEEDS FROM town.js — ONE LINE, at the end of fireMilestone,
// on the line after the `wx.event(...)` that arms the bow:
//     if (wx.bowUp && wx.bowUp()) rig.beat('rainbow', { delay: 6000 });
// or, with no cheap way to ask the sky, unconditionally —
//     rig.beat('rainbow', { delay: 6000 });
// It is safe to call from anywhere: it refuses outside orbit, refuses on a
// pinned bench camera, carries its own delay so the call site needs no timer,
// and hands the camera back the instant the user touches anything.
import * as THREE from './vendor/three.module.js';

const TAU2 = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const easeOutCubic = k => 1 - Math.pow(1 - k, 3);
const wrapPi = a => { a %= TAU2; return a > Math.PI ? a - TAU2 : a < -Math.PI ? a + TAU2 : a; };
const approach = (cur, goal, tau, dt) => cur + (goal - cur) * (1 - Math.exp(-dt / tau));
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(Math.max(n, 0)));

const POL_MIN = .06, POL_MAX = 1.40;          // 1.40 (was 1.25) buys the tour a real plate shot
const DIST_MIN = 6, DIST_MAX = 340;           // 6 lets you nose into a rooftop
const FOV = { orbit: 46, focus: 46, follow: 52, tour: 40, photo: 34, stroll: 52 };
/* ── WHAT ONE WORLD UNIT IS, AND WHY IT MATTERS HERE ─────────────
   Every mode but this one looks AT the town, and a view from 200 units up does
   not care what a unit is worth. On foot it is the only thing that matters: the
   eye height IS the scale, and the first pass shipped every number below as if
   one unit were one metre, which it is not.

   Measured off the geometry, not asserted:
     · a villager stands  0.595 × scale  (npcs.js: "feet at 0, crown at .595";
       scale = (.88 + r·.26) × 1.62), i.e. 0.85–1.10 units, and 0.96 at the
       reference figure;
     · a cottage door opening is 1.05–1.4 (buildings.js tiers 1-4), a villa's
       1.5, a manor's 1.6, a guildhall's 1.7;
     · a cottage's wall to the eaves is 1.4 (tier 1) to 2.1 (tier 3); a villa is
       two storeys of 1.90 + 1.80 with eaves at 3.7;
     · a ridge (`hTop`) is 2.45 for a hovel, 3.5 for a cottage, 4.3 for a
       farmhouse, 5.9 for a manor;
     · a lane is 3.7 wide (layout.js `e.w`) and plots are set back 4.3–6.6.

   Only ONE of those has a size that is not a matter of opinion — the person. A
   cottage may be any size a cottage likes; an adult is about 1.72 m. So:

       1 world unit ≈ 1.78 m      (0.964 units × 1.78 = 1.72 m)

   and the architecture corroborates it rather than setting it: a cottage ridge
   comes out at 6.2 m, a manor's at 10.5, a lane at 6.6 m across, a plot set back
   7.7–11.7 m from the centreline. All four are what a real village measures.
   npcs.js reached the same place independently — "1.45 units is about 2.5 m at
   this town's scale" is 1.72 m/unit. The doors run generous at this scale
   (1.9 m for a hovel's, 2.5 m for a farmhouse's) and the walls more so; that is
   the buildings being a shade grand for their people, not a second scale.

   THE EYE FOLLOWS FROM THE PERSON. An adult's eye sits at .936 of their standing
   height, so 0.964 × .936 = 0.90 units — 1.60 m. At the shipped 1.35 the user
   was 2.40 m to the eye, a 2.6 m giant, taller than any door in the town and
   looking DOWN on the villagers whose town it is. Everything below is re-derived
   from 1 u = 1.78 m; the comments now say what each number is worth in metres,
   so the next person to touch them can check the arithmetic. */
const EYE_H = .90;                  // 1.60 m — an adult's eye, level with a villager's
const STROLL_LOOK = 9;              // the boom length that turns the orbit into a first person
const STROLL_SPEED = .72;           // 1.28 m/s — an unhurried walk. 1.35 was 2.4 m/s, a jog.
const STROLL_STRIDE = .42;          // 0.75 m per STEP: the bob rises once per footfall, so
                                    // .72/.42 = 1.7 steps/s ≈ 103 a minute, a walking cadence
const BOB_Y = .016, BOB_X = .012;   // 2.8 cm of rise, 2.1 cm of sway. A real walk moves the head
                                    // ~2.5 cm; .038 was 6.8 cm at this scale, which is a limp.
// pol is the PITCH here, and it must go negative or you can never look at a roof
// — which is the one thing worth looking at from a street. HOME is level: from
// 1.35 a walker had to look down to see the road, and from 1.60 m they do not.
// Level also puts the eaves and ridges — where AESTHETIC.md says the detail is —
// in the top half of the frame instead of on its edge.
const S_POL_MIN = -.62, S_POL_MAX = 1.05, S_POL_HOME = 0;
const S_FOV_MIN = 34, S_FOV_MAX = 74;
const TURN_RATE = 1.7;              // rad/s ceiling on the FEET. The gaze is free; the walk is not.
const LOOK_TAU = 2.2;               // hands off, the gaze settles back down the lane
const PITCH_TAU = 7;                // …and very slowly back to level, so a look at the sky is not a trap
const UTURN = 2.35, UTURN_MS = 900; // look back down the street and you turn round
const STROLL_NEAR = .22;            // 39 cm — nearer than a person's own nose lets anything get.
                                    // .28 was tuned for an eye 50 % higher; the ground under a
                                    // 0.90 eye is 0.90 away and a doorway leaned into is nearer.
const STROLL_FOG = 55;              // idea T-3's number. See rig.fogDist — camera.js NEVER writes fog.
const STROLL_SHADOW = 30;           // half-extent, centred on the look point: 34 texels/unit of 2048
/* ── the deck, and the ramp up onto it ───────────────────────────
   town.js floats a bridge group at DECK_Y and the group's own origin is its road
   surface, so this is where a walker's feet are ON a crossing. It was .30 — the
   least lift that stopped the deck being read through the water plate at .06 —
   and buildings.js has since rebuilt the crossing with arch barrels, cutwaters
   and abutments all authored for 1.05, every one of which is under the river
   until the mount moves. THE NUMBER LIVES IN THREE FILES (town.js's bridge
   mount, npcs.js's DECK_Y, here) and they must agree: neither of the two
   siblings may import from core, so there is nothing to share it through.

   A SNAP AT .30 WAS INVISIBLE; AT 1.05 IT IS A STOREY. layout.js stands the
   bridgehead nodes `riverW + 9` back from the channel while the deck is only
   `riverW + 3.2` long, so a crossing always leaves ~5 u of painted approach at
   each end — the ramp runs over exactly that, smoothstepped, and is 0 at both
   nodes, so no junction can ever be stepped onto from a height. Identical
   arithmetic to npcs.js's `deckLift`, and it has to stay identical: the walker
   and the crowd share the same lane. */
const DECK_Y = 1.05;
const DECK_ABUT = .80;              // the abutment carries the road at deck height this far past the span
const DECK_RAMP_MIN = 1.4, DECK_RAMP_MAX = 6;   // …and the embankment, floored for stitched crossings
const CLEAR_R = 24, CLEAR_MS = 400; // the nearby-wall list, refreshed on the wall clock
const PUSH_MAX = 1.4;               // how much overlap one frame may answer for
const OFF_RATE = 1.6, DECAY = .8;   // the standing step-aside: 2.8 m/s out, 1.4 m/s back to the
                                    // middle — faster than the walk, as a sidestep is
const MAX_DEPTH = 2;                // spine / street / lane. A depth-3 track is a back alley
                                    // with eaves 1.3 units off its centreline: a real part of
                                    // a village, and not somewhere to put a 58-degree lens.
/* ── the sky beat (idea T-5's other half) ────────────────────────
   A rainbow is a 40–42° annulus round the antisolar point, and the orbit rig
   composes for the TOWN: at every token count the framing leaves 2–4° of sky
   above the ridge line, so weather.js's physically-correct bow is drawn entirely
   off the top of the frame and nobody has ever seen one. The approved idea said
   from the start that a rainbow "fires ~6 s after the celebration"; this is the
   beat that was never built.

   IT IS A TILT AND A WIDEN, NOT A MOVE. The camera does not dolly, swing,
   re-frame or change mode — applyCam raises the LOOK POINT and leaves
   camera.position exactly where it was, which is precisely what a person does
   when something happens in the sky. So it composes with the drift, the flick
   inertia, a punch, an intro bias and a growing town, and there is nothing to
   undo when it ends.

   WHY IT IS ALSO A WIDEN, which the first pass got wrong. Measure the framing:
   at r ≈ 110 the rig stands 179 out at pol .40, so the town occupies depression
   angles 14° (its far edge) to 52° (its near edge), and a bow with the sun 8° up
   occupies elevations 0–33°. That is 50° of subject with a 46° lens between
   them: at 46° you can have the town OR the bow and not both, and a tilt alone
   photographs as the town sliding off the bottom of the frame — a cutscene,
   which is the one thing this must not be. Widening to 66° for the length of the
   beat buys the 20° that makes it one picture: the town in the lower half, the
   sky and the arc above it. A lens pulling back to take everything in is also
   exactly the gesture a celebration wants.

   BEAT_AIM is where the gaze SETTLES, in radians BELOW horizontal, and it is
   absolute rather than relative so a user who has tipped the town right over
   still gets sky, and one already looking at the horizon is barely moved. */
const BEAT_IN = 1400, BEAT_HOLD = 4200, BEAT_OUT = 2600;   // ms, wall clock
const BEAT_AIM = .07;                          // 4° below horizontal at full lift
const BEAT_FOV = 66;                           // …and 66° of it, for the beat only
const easeInOut = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(2 - 2 * k, 3) / 2;
// per-mode follower constants: LIVE is how the mode feels under the hand, TRANSIT
// is the cinematic move-in, held for MOVE_S seconds after a mode or shot change.
const LIVE = {
  orbit: { az: .10, pol: .10, dist: .18, t: .30, fov: .45 },
  // ONE TAU FOR EVERY CHANNEL, and only in this mode. The stroll expresses first
  // person as `target = eye + gaze·9`, so the eye lands where az/pol/dist/t agree.
  // Let them ease at different rates and a fast look-around swings the EYE by the
  // difference — a 9-unit lever arm turns a 0.08 s tau mismatch into half a metre
  // of lurch. Equal taus make the eye stand still while the head turns.
  stroll: { az: .20, pol: .20, dist: .20, t: .20, fov: .45 },
  focus: { az: .28, pol: .28, dist: .30, t: .34, fov: .45 },
  follow: { az: 1.40, pol: .40, dist: .50, t: .16, fov: .45 },
  tour: { az: .62, pol: .62, dist: .62, t: .62, fov: .55 },
  photo: { az: .40, pol: .40, dist: .55, t: .45, fov: .60 }
};
const TRANSIT = { az: .62, pol: .62, dist: .62, t: .62, fov: .55 };
const MOVE_S = 1.6;                            // how long a move-in keeps the cinematic tau
// stroll is 0: the walk IS the motion, and a gaze that creeps sideways while the
// feet go straight is the one thing that makes a first person feel drunk.
const DRIFT = { orbit: .045, focus: .018, follow: 0, tour: 0, photo: .012, stroll: 0 };
const IDLE_S = 3;                              // seconds of hands-off before the drift starts
// `moving` must read false when the camera is at rest — but at rest it is still
// drifting, and a follower lagging a constant rate settles at rate×tau (.0045 in
// orbit, .005 in focus). The threshold sits just above that, so a resting drift
// is not movement and a live transition is.
const MOVE_EPS = .012;

/** @typedef {'orbit'|'focus'|'follow'|'tour'|'photo'|'stroll'} CamMode */
/** @typedef {{x:number,y:number,z:number,hTop?:number,id?:string,label?:string}} Anchor */

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {Object} [cfg] {canvas, stage, sampleHeight, getPlan, getBuildings,
 *                        resolveFollow, onMode, onShot} — all optional
 */
export function initCamera(camera, cfg = {}) {
  const canvas = cfg.canvas || null;
  const sampleHeight = typeof cfg.sampleHeight === 'function' ? cfg.sampleHeight : null;
  const getPlan = typeof cfg.getPlan === 'function' ? cfg.getPlan : null;
  const getBuildings = typeof cfg.getBuildings === 'function' ? cfg.getBuildings : null;
  const resolveFollow = typeof cfg.resolveFollow === 'function' ? cfg.resolveFollow : null;
  const onMode = typeof cfg.onMode === 'function' ? cfg.onMode : null;
  const onShot = typeof cfg.onShot === 'function' ? cfg.onShot : null;
  // The plaza's LIVE radius. focus() and follow() need it to keep the camera out
  // of the altar; without it a villager standing on the plaza — which is where
  // the worship and pilgrim states send them — is followed from inside a 54-unit
  // monument and the shot is 80 % black slab.
  const getPlazaR = typeof cfg.plazaR === 'function' ? cfg.plazaR : null;

  const g = { az: .62, pol: .40, dist: 62, tx: 0, ty: 3, tz: 0, fov: camera.fov || 46 };
  const c = { az: g.az, pol: g.pol, dist: g.dist, tx: 0, ty: 3, tz: 0, fov: g.fov };
  const tau = Object.assign({}, LIVE.orbit);
  // The orbit goal, kept alive in every mode. az/pol are the user's; dist is the
  // framing unless the wheel took it; tx/tz are the centre of mass plus any pan.
  const orb = { az: g.az, pol: g.pol, userD: 62 };
  const bnd = { cx: 0, cz: 0, r: 40, hx: 40, hz: 40 };
  let monTop = 8, frameD = 62, tgtY = 3, panX = 0, panZ = 0, photoD = 1;

  let mode = 'orbit', transitLeft = 0;
  let userDist = false, userDistAtR = 0, lastWheel = -1e9;
  let dollyT = -1e9, dollyK = .13, dollyMs = 1800;
  let introMul = 1, introPol = 0;
  let idleT = 0, lastInputAt = 0, effDist = 62, moveK = 0;
  // ONE CLOCK: everything is stamped in the caller's `now` domain. Input handlers
  // fire between frames and stamp with the last one seen (≤ 16 ms stale in the
  // app); the first update() rebases anything stamped before it, so a bench or a
  // harness may drive the rig from a clock that does not start where ours did.
  let lastNow = nowMs(), synced = false;
  // The last ctx update() saw. tour() is called from a keypress and from town.js's
  // --cam hook, neither of which has one, so its FIRST shot used to render its
  // caption from a literal null: every tour — and every press of T — opened on
  // 'the town · 0 buildings' and held it for the shot's whole dwell while the
  // footer 1000 px below read the real number.
  let lastCtx = null;

  let dragging = false, dragBtn = 0, dragPx = 0, dragId = -1, dragX = 0, dragY = 0;
  let vAz = 0, vPol = 0, dragAz = 0, dragPol = 0;   // flick inertia, rad/s
  // WHICH GESTURE THIS DRAG IS — decided once, at pointerdown, and never
  // revisited: a drag that changed its mind halfway because the mode changed
  // under it would be a gesture the hand cannot predict. `grab*` is the world
  // point the pan is holding on to and the height of the plane it sits on.
  let dragLook = false, grabOn = false, grabX = 0, grabY = 0, grabZ = 0;

  // The bench's camera pin (BENCH-README §3). A measured scene must be the same
  // shot on every run of every commit, so the slow idle drift is frozen — and a
  // scene that names an [az, pol, dist] gets exactly that, without pretending to
  // be a wheel gesture. Nothing else in the app ever sets this.
  let pinned = false;
  let followH = null, followAzOff = 0, followWheel = false, focusId = null;
  let shots = null, shotI = -1, shotAt = -1e9, lmPick = 0, tourOn = false, caption = '';
  const marks = new Array(6).fill(null);

  // THE WALKER. `ei/from/to/t` is a position ON THE STREET GRAPH — an edge and a
  // parameter along it — so "never walk through a wall" is a property of where
  // the walker is allowed to be, not a collision system bolted on afterwards.
  // x/z/y are that parameter resolved into the world (plus the wall push).
  const walk = {
    free: false,                    // no graph to follow (demo mode) — see freeStep
    x: 0, y: 0, z: 0, az: 0,        // where the feet are and which way they point
    bx: 0, bz: 0,                   // …the same point ON the graph, before the push
    ox: 0, oz: 0, off: 0,           // the STANDING step-aside: signed, along the lane normal
    ei: -1, from: -1, to: -1, t: 0,
    s: 0,                           // metres walked this stroll — the bob's only clock
    lastT: 0, pace: 0, turnT: -1e9
  };
  let strollLook = 0;               // the ABSOLUTE gaze azimuth. g.az is derived; this is the state.
  let strollFov = FOV.stroll;
  let strollViewD = 140;            // how far the WORLD reads — nothing to do with `dist` down here
  const nearWalls = [];             // x, z, r triples within CLEAR_R
  let nearWallsAt = -1e9;
  const baseNear = camera.near;     // town.js's own near plane, restored on the way out

  // THE SKY BEAT. `beatOn` is the whole of the "is anything happening" test —
  // every other field is only read while it is true, and applyCam's fast path is
  // one boolean when it is not.
  let beatOn = false, beatAim = BEAT_AIM, beatFrom = -1e9, beatCutAt = -1e9, beatCutK = 0;

  const focusPoint = new THREE.Vector3(0, 3, 0);
  const shadowCenter = new THREE.Vector3();
  const _look = new THREE.Vector3();           // the beat's aim point; focusPoint stays honest
  const _v = new THREE.Vector3(), _dir = new THREE.Vector3(), _gp = new THREE.Vector3();
  const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();   // the pan's own two, so it never aliases a wheel
  const facts = { town: '', buildings: 0, tok: 0, tokStr: '0', rangeShort: '', label: '', n: 0, i: 0, of: 0 };

  /* ═══ framing ═══════════════════════════════════════════════════ */
  // FIT THE TOWN, NOT ITS MARGIN — v3's curve, moved here unchanged.
  const frameDistFor = (r, top) =>
    clamp(Math.max(r * (1.32 + .13 * clamp(r / 112, 0, 1)) + 20, top * 2.1), 50, 500);
  // A bounding CIRCLE is the wrong shape for a ribbon or a lakeside C: from most
  // azimuths they are far narrower across the frame than 2r. Pure in az so the
  // tour can pre-evaluate it; it can only ever pull in.
  function fitBias(az) {
    const { hx, hz, r } = bnd;
    if (!(r > 0) || !(hx > 0) || !(hz > 0)) return 1;
    const ca = Math.abs(Math.cos(az)), sa = Math.abs(Math.sin(az));
    return clamp(Math.max(hx * ca + hz * sa, (hx * sa + hz * ca) * .62) / r, .60, 1);
  }
  const dollyBias = now => {
    const k = clamp((now - dollyT) / dollyMs, 0, 1);
    return k >= 1 ? 1 : 1 - dollyK * (1 - easeOutCubic(k));
  };
  function setFrame(b, top) {
    if (b) {
      bnd.cx = b.cx || 0; bnd.cz = b.cz || 0;
      bnd.r = b.r > 0 ? b.r : bnd.r;
      bnd.hx = b.hx > 0 ? b.hx : bnd.r; bnd.hz = b.hz > 0 ? b.hz : bnd.r;
    }
    if (isFinite(top)) monTop = top;
    // The target follows the centre of mass, NOT the plaza: a river town's square
    // sits on one bank and must not be forced into frame centre.
    tgtY = 3 + Math.max(bnd.r * .05, monTop * .16);
    frameD = frameDistFor(bnd.r, monTop);
    clampPan();
    // THE ORBIT GOAL, AND ONLY THE ORBIT GOAL — in every mode. This is the line
    // that makes leaving focus/follow/tour/photo free.
    if (mode === 'orbit') writeOrbitGoal();
  }
  function clampPan() {
    // THE LEASH, and it is longer than it was. 1.6 r was set when panning was a
    // right-button afterthought; it is the primary gesture now, and a 20-unit
    // floor is barely a lane's worth of roam in a young town. 2 r still keeps
    // the shadow frustum (centred on the town, min(r,62)+12 half-extent) under
    // the visible ground, and a double-click still brings everything home.
    const lim = Math.max(bnd.r * 2, 30), m = Math.hypot(panX, panZ);
    if (m > lim) { panX *= lim / m; panZ *= lim / m; }
  }
  const orbitDist = () => userDist ? orb.userD : frameD;
  // THE PITCH LIMITS ARE PER MODE, and exactly one mode differs. Everywhere the
  // camera orbits a subject, pol is a polar angle and .06 keeps the lens off the
  // ground; on foot pol is a head, and a head that cannot tilt back cannot look
  // at a roof — which in a village is where all the detail is (AESTHETIC.md).
  // These two return the shipped constants in every other mode, so no existing
  // behaviour moves by a single radian.
  const polLo = () => mode === 'stroll' ? S_POL_MIN : POL_MIN;
  const polHi = () => mode === 'stroll' ? S_POL_MAX : POL_MAX;

  /* ═══ modes ═════════════════════════════════════════════════════ */
  function setMode(next, meta) {
    const prev = mode;
    mode = next; transitLeft = MOVE_S;
    if (next !== 'tour') caption = '';
    Object.assign(tau, TRANSIT);
    if (prev !== next && onMode) onMode(next, prev, meta || null);
  }

  function orbit(opts) {
    followH = null; tourOn = false; shots = null; shotI = -1; focusId = null;
    g.az = orb.az; g.pol = orb.pol; g.fov = FOV.orbit;
    setMode('orbit', opts && opts.meta);
    if (opts && opts.snap) { writeOrbitGoal(); snap(); }
  }
  function writeOrbitGoal() {
    g.tx = bnd.cx + panX; g.ty = tgtY; g.tz = bnd.cz + panZ;
    g.dist = orbitDist(); g.fov = FOV.orbit;
    g.az = orb.az; g.pol = clamp(orb.pol, POL_MIN, POL_MAX);
  }
  /** How far the camera must stand off (x,z) to have the altar out of its way.
   *  The monument is 54 units of stone over a ~14-wide ring at the top rung, and
   *  the plaza is where the crowd goes, so the single most likely subject sits in
   *  the single worst place to put a 8-14 unit camera. The altar's own deed
   *  already solved this for itself (describeEnt hands its dist a bounding-radius
   *  formula); nothing did it for the people standing next to it. */
  function plazaStandoff(x, z) {
    const R = getPlazaR ? +getPlazaR() : 0;
    if (!(R > 0)) return 0;
    // Inside the ring: get out past its lip. Just outside: still clear the stone.
    const d = Math.hypot(x || 0, z || 0);
    return d < R + 4 ? R + 6 - d : 0;
  }
  /** Aim the goal at an anchor. `hTop` drives the distance when none is given. */
  function aimAt(a, opts) {
    const h = a.hTop > 0 ? a.hTop : 0;
    g.tx = a.x || 0; g.ty = (a.y || 0) + h * .55; g.tz = a.z || 0;
    g.dist = (opts && opts.dist > 0) ? opts.dist : clamp(h * 3.4 + 8, 14, 46);
    g.pol = clamp((opts && isFinite(opts.pol)) ? opts.pol : .52, POL_MIN, POL_MAX);
    // An ABSOLUTE bearing when the subject has a front. Camera sits at
    // target + (sin az, ·, cos az)·dist, so a deed that knows which way its
    // engraved face looks can ask to be approached from that side; everything
    // else keeps the relative swing, which is what makes a focus feel like a move
    // rather than a cut.
    g.az = (opts && isFinite(opts.az)) ? opts.az
      : c.az + ((opts && isFinite(opts.azRel)) ? opts.azRel : .55);
    // Never commit a goal that puts the lens inside the altar — but only where we
    // chose the distance ourselves. An explicit `dist` is a deliberate framing
    // decision (the plaza shot means to sit 30 units off the altar) and this must
    // not second-guess it.
    if (!(opts && opts.dist > 0) && !(opts && isFinite(opts.az))) {
      const push = plazaStandoff(g.tx, g.tz);
      if (push > 0) {
        g.dist = Math.max(g.dist, g.dist + push);
        g.pol = Math.max(g.pol, .42);
        // …and stand OUTSIDE the ring looking in. The relative swing could just as
        // easily put the camera on the altar's far side, with 54 units of stone
        // between the lens and the person it was asked to look at.
        const d = Math.hypot(g.tx, g.tz);
        if (d > 1) g.az = Math.atan2(g.tx, g.tz);
      }
    }
  }
  function focus(a, opts) {
    if (!a || !isFinite(a.x) || !isFinite(a.z)) return;
    // Re-focusing the same subject is a no-op: a second click on a deed card must
    // not re-run the swing.
    if (mode === 'focus' && a.id != null && a.id === focusId) return;
    focusId = a.id != null ? a.id : null;
    followH = null; tourOn = false; shots = null;
    aimAt(a, opts);
    g.fov = FOV.focus;
    setMode('focus', { anchor: a });
  }
  function follow(handle) {
    if (handle == null || !resolveFollow) return false;
    const t = resolveFollow(handle);
    if (!t || t.alive === false) return false;
    followH = handle; followAzOff = 0; followWheel = false;
    tourOn = false; shots = null; focusId = null;
    g.dist = (t.hTop > 0 && t.hTop < 2) ? 8 : 11;
    // …unless they are standing on the plaza, in which case 8 units puts the lens
    // inside 54 units of monument and the villager you asked to follow is behind
    // it. Pushing out and lifting the polar angle looks over the plaza rim.
    const push = plazaStandoff(t.x, t.z);
    g.dist += push;
    g.pol = push > 0 ? .40 : .30; g.fov = FOV.follow;
    g.tx = t.x; g.ty = (t.y || 0) + 1.15; g.tz = t.z;
    g.az = (t.yaw || 0) + Math.PI;
    setMode('follow', { handle });
    return true;
  }
  function tour(on, list) {
    if (!on) { if (mode === 'tour') orbit(); else { tourOn = false; shots = null; } return; }
    shots = (Array.isArray(list) && list.length) ? list : defaultShots();
    tourOn = true; followH = null; focusId = null;
    shotI = (typeof on === 'number' && on > 0) ? Math.floor(on) - 1 : -1;
    setMode('tour', null);
    nextShot(lastNow, lastCtx, shotI < 0 ? 0 : shotI);
  }
  /* ═══ the stroll — street level, on foot ════════════════════════
     'Walk there' was offered by every building deed and by the key sheet's G row,
     MODE_LINE.stroll and MODE_TOAST.stroll were written for it, and interact's
     `case 'g'` called it — but for a long time the rig's answer was a low-polar
     15-unit orbit, which is a crouch, not a walk. This is the walk.

     TWO IDEAS, and the rest follows from them.

     1. FIRST PERSON IS ALREADY IN THE ORBIT FORMULATION. applyCam puts the camera
        at `target + (sin az, ·, cos az)·(cos pol, sin pol)·dist`. Write the goal
        TARGET as `eye + gaze·9` and that same line lands the camera exactly on the
        eye, looking down the gaze. So the stroll adds no second code path: every
        follower, drag, flick, transition, snap and bookmark keeps working, the
        descent from 240 units up to 0.90 is one continuous ease in the SAME six
        channels, and applyCam is untouched but for the head bob.
     2. THE WALKER LIVES ON THE STREET GRAPH, not in free space. `plan.graph` is a
        graph of edges whose plots are set back 4.3–6.6 units from the centreline
        (layout.js P.SETBACK), so a walker at lateral offset 0 is provably clear of
        every wall in the plan. "Don't clip a building" stops being a collision
        problem and becomes a statement about where the walker is allowed to be.
        clearWalker() is a backstop for what the graph does not know about, not the
        mechanism.

     STEERING. There are no new keys — interact.js owns the keymap and this mode
     had to fit inside a drag. You drag to LOOK; the feet take whichever lane best
     matches where you are looking when they reach the next junction; and with the
     hand off, the gaze settles back down the lane over ~2 s. So a drag right is
     "take the next right", the corner turns itself, and looking back over your
     shoulder for a moment turns you round. Nothing to hold, nothing to time.

     WALL CLOCK. Everything that moves is integrated from `now`, not from `wdt`:
     wdt is clamped at .5 s and a headless frame is ~1 s, so a dt-paced walk would
     photograph at half speed — and the bob's phase comes from DISTANCE WALKED, so
     it cannot disagree with the feet however the frames fall. */
  const graphOf = () => {
    const p = getPlan && getPlan(), gr = p && p.graph;
    return (gr && gr.nodes && gr.nodes.length && gr.edges && gr.edges.length) ? gr : null;
  };
  /** How far out the pavement goes. Past the frontier the graph is planned but
   *  unbuilt, and walking it is walking an empty field down a road that is not
   *  there yet. npcs.js gates its wanderers on the same number. */
  function reachLimit() {
    const p = getPlan && getPlan();
    if (p && typeof p.frontierOf === 'function' && getBuildings) {
      const list = getBuildings();
      const f = p.frontierOf(list ? list.length : 0);
      if (f && f.k > 0) return f.k + 8;
    }
    return Math.max(bnd.r + 10, 40);
  }
  /** az such that the camera's ground forward, (-sin az, -cos az), runs from→to. */
  function headingOf(gr) {
    const a = gr.nodes[walk.from], b = gr.nodes[walk.to];
    if (!a || !b) return walk.az;
    const dx = b.x - a.x, dz = b.z - a.z;
    return (dx || dz) ? Math.atan2(-dx, -dz) : walk.az;
  }
  /** Which crossing an edge carries, by edge index — `plan.bridges` stamps `_e`
   *  on every one it builds. Rebuilt when the plan is swapped, which is once an
   *  epoch, and it is a handful of entries. */
  let deckPlan = null;
  const deckMap = new Map();
  function deckFor(ei) {
    const p = getPlan && getPlan();
    if (p !== deckPlan) {
      deckPlan = p; deckMap.clear();
      const list = (p && p.bridges) || [];
      for (const b of list) if (b && isFinite(b._e) && b.span > 0) deckMap.set(b._e, b);
    }
    return deckMap.get(ei) || null;
  }
  /** How high the deck is under the walker right now: DECK_Y across the span and
   *  its abutments, smoothstepped to 0 over the approach at either end, and 0 on
   *  every street that is not a crossing. A pure function of where on the edge
   *  the feet are, so it cannot disagree with the wall-clock walk. */
  function deckLift(gr) {
    if (!gr || walk.ei < 0) return 0;
    const e = gr.edges[walk.ei];
    if (!e || !e.bridge) return 0;
    const a = gr.nodes[walk.from], b = gr.nodes[walk.to];
    if (!a || !b) return 0;
    const vx = b.x - a.x, vz = b.z - a.z, len = Math.hypot(vx, vz);
    if (!(len > .01)) return 0;
    const B = deckFor(walk.ei);
    // No entry (a crossing the layout did not list) still gets a level middle and
    // two ramps — the width is guessed from the edge rather than from the deck.
    const span = B && B.span > 0 ? B.span : len * .55;
    const c = B ? clamp(((B.x - a.x) * vx + (B.z - a.z) * vz) / len, 0, len) : len * .5;
    const flat = span * .5 + DECK_ABUT, run = Math.min(c, len - c);
    const ramp = clamp(run - flat, DECK_RAMP_MIN, DECK_RAMP_MAX);
    const half = Math.max(0, Math.min(flat, run - ramp));
    const u = clamp((ramp - (Math.abs(walk.t * len - c) - half)) / ramp, 0, 1);
    return DECK_Y * u * u * (3 - 2 * u);
  }
  function stepPos(gr) {
    const a = gr.nodes[walk.from], b = gr.nodes[walk.to];
    if (!a || !b) return;
    walk.bx = a.x + (b.x - a.x) * walk.t;
    walk.bz = a.z + (b.z - a.z) * walk.t;
  }
  /** The one place the walker's feet meet the world. A bridge is a MESH, not
   *  terrain — sampleHeight over a river hands back the riverbed, so following it
   *  onto a crossing wades the camera through the water it is supposed to cross.
   *  The two are taken TOGETHER rather than either/or: the deck wins wherever it
   *  is above the ground, and at the far end of the ramp, where the lift has gone
   *  to nothing, the terrain is back without a step in between. */
  function groundWalker(gr) {
    const g = sampleHeight ? (+sampleHeight(walk.x, walk.z) || 0) : 0;
    const deck = deckLift(gr);
    walk.y = deck > g ? deck : g;
  }
  /** Is (x,z) standing ON a crossing's deck? `a` is the bearing along the span
   *  and the deck is `span` × `w`, so this is two dot products against the
   *  bridge's own axes — no graph walk, and there are never more than a handful
   *  of bridges in a plan. Returns the plan's bridge entry, or null. */
  function deckUnder(x, z) {
    const p = getPlan && getPlan(), list = (p && p.bridges) || [];
    for (const b of list) {
      if (!b || !isFinite(b._e) || !(b.span > 0)) continue;
      const dx = x - b.x, dz = z - b.z, ca = Math.cos(b.a), sa = Math.sin(b.a);
      if (Math.abs(dx * ca + dz * sa) > b.span * .5 + 1) continue;      // along the span
      if (Math.abs(dz * ca - dx * sa) > (b.w > 0 ? b.w : 4) * .5) continue;   // …and across it
      return b;
    }
    return null;
  }
  /** Put the walker on the nearest piece of street to (x,z), facing into town. */
  function placeWalker(x, z) {
    const p = getPlan && getPlan(), gr = graphOf();
    walk.s = 0; walk.pace = 1; walk.turnT = -1e9;
    walk.ox = walk.oz = walk.off = 0; nearWallsAt = -1e9;
    if (!gr) {
      walk.free = true; walk.ei = -1; walk.x = walk.bx = x; walk.z = walk.bz = z; walk.az = c.az;
      groundWalker(null); return;
    }
    walk.free = false;
    /* A DECK'S NEAREST NODE IS NOT A BRIDGEHEAD. layout.js refuses to put a node
       within a river's half-width of the channel and stands the bridgeheads a
       further 9 units back, so for a 33-unit crossing the closest node to the
       middle of the deck is a lane on the BANK — and the node search below,
       which only ever considers that node's own edges, could not reach the
       crossing from there. 'Walk there' on a bridge deed therefore stood you
       beside the river looking at it, every time, which is the one thing that
       deed's only verb must not do. If the point asked for is on a deck, take
       the deck: it is the road there. */
    const B = deckUnder(x, z);
    if (B) {
      const e = gr.edges[B._e];
      const a = e && gr.nodes[e.a], b = e && gr.nodes[e.b];
      if (e && e.bridge && a && b) {
        const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
        const t = clamp(((x - a.x) * vx + (z - a.z) * vz) / L2, .04, .96);
        // …facing the way OFF it, which is the end you are nearest to the far
        // side of: a stroll that starts mid-span should finish the crossing.
        if (t < .5) { walk.from = e.a; walk.to = e.b; walk.t = t; }
        else { walk.from = e.b; walk.to = e.a; walk.t = 1 - t; }
        walk.ei = e.i != null ? e.i : B._e;
        stepPos(gr);
        walk.x = walk.bx; walk.z = walk.bz;
        groundWalker(gr);
        walk.az = headingOf(gr);
        return;
      }
    }
    let ni = 0;
    if (typeof p.nearestNode === 'function') {
      const k = p.nearestNode(x, z);
      if (k >= 0 && k < gr.nodes.length) ni = k;
    } else {
      let best = Infinity;
      for (let i = 0; i < gr.nodes.length; i++) {
        const n = gr.nodes[i], d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
        if (d < best) { best = d; ni = i; }
      }
    }
    const n = gr.nodes[ni];
    // …and then onto the ADJACENT EDGE that passes closest, not onto the node.
    // 'Walk there' from a house deed hands us the house's own centre; snapping to
    // the junction would stand you thirteen units up the road from the door.
    // n.adj holds EDGE indices, not node indices (layout.js:459).
    let bi = -1, bt = .5, bd = Infinity;
    for (let k = 0; k < n.adj.length; k++) {
      const e = gr.edges[n.adj[k]];
      if (!e) continue;
      const a = gr.nodes[e.a], b = gr.nodes[e.b];
      if (!a || !b) continue;
      const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz || 1;
      const t = clamp(((x - a.x) * vx + (z - a.z) * vz) / L2, .08, .92);
      const px = a.x + vx * t - x, pz = a.z + vz * t - z;
      // A back alley is not where a stroll starts either — weight it out rather
      // than forbid it, so a track that really is the only road in still wins.
      const d = px * px + pz * pz + (e.depth > MAX_DEPTH ? 400 : 0);
      if (d < bd) { bd = d; bi = e.i; bt = t; }
    }
    if (bi < 0) {
      walk.free = true; walk.ei = -1; walk.x = walk.bx = n.x; walk.z = walk.bz = n.z; walk.az = c.az;
      groundWalker(null); return;
    }
    const e = gr.edges[bi], a = gr.nodes[e.a], b = gr.nodes[e.b];
    // Face INWARD: `d` is graph distance from the plaza, so the end with the
    // smaller d is the way into town. Arriving at the gate and setting off out of
    // it again would be a very short stroll.
    if (b.d > a.d) { walk.from = e.b; walk.to = e.a; walk.t = 1 - bt; }
    else { walk.from = e.a; walk.to = e.b; walk.t = bt; }
    walk.ei = bi;
    stepPos(gr);
    walk.x = walk.bx; walk.z = walk.bz;
    groundWalker(gr);
    walk.az = headingOf(gr);
  }
  /** Is the middle of this edge inside something? A road is planned before the
   *  landmarks are sited, so a tithe barn can be dropped astride a lane and the
   *  graph will still cheerfully route a walker through fourteen units of it. */
  function edgeBlocked(n, o) {
    for (let s = 1; s <= 3; s++) {
      const t = s / 4, sx = n.x + (o.x - n.x) * t, sz = n.z + (o.z - n.z) * t;
      for (let i = 0; i < nearWalls.length; i += 3) {
        const dx = sx - nearWalls[i], dz = sz - nearWalls[i + 1], r = nearWalls[i + 2];
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    return false;
  }
  /** At a junction, take the lane that best matches where the walker is LOOKING. */
  function turnAt(gr, maxD) {
    const n = gr.nodes[walk.to];
    if (!n || !n.adj || !n.adj.length) { reverse(); return; }
    const fx = -Math.sin(c.az), fz = -Math.cos(c.az);
    // Two passes with the same scoring: the second drops every rule but "is it a
    // road", so a walker boxed into a corner of the plat always has a way out.
    for (let pass = 0; pass < 2; pass++) {
      let bi = -1, bs = -Infinity;
      for (let k = 0; k < n.adj.length; k++) {
        const e = gr.edges[n.adj[k]];
        if (!e) continue;
        const oi = e.a === n.i ? e.b : e.a, o = gr.nodes[oi];
        if (!o || oi === walk.from) continue;    // never bounce straight back
        if (!pass) {
          if (e.d > maxD) continue;              // never past the paved frontier
          if (e.depth > MAX_DEPTH) continue;     // never down a back alley
          if (edgeBlocked(n, o)) continue;       // never straight through a landmark
        }
        const L = e.len > .01 ? e.len : Math.hypot(o.x - n.x, o.z - n.z) || 1;
        // …with a thumb on the scale for a spine: at a crossroads where two lanes
        // are equally 'ahead', a village walk takes the main street.
        const s = ((o.x - n.x) * fx + (o.z - n.z) * fz) / L + (e.depth <= 1 ? .12 : 0);
        if (s > bs) { bs = s; bi = e.i; }
      }
      if (bi >= 0) {
        const e = gr.edges[bi];
        walk.from = n.i; walk.to = e.a === n.i ? e.b : e.a; walk.ei = e.i; walk.t = 0;
        return;
      }
    }
    reverse();                                   // a dead end is a turning point
  }
  function reverse() {
    const f = walk.from; walk.from = walk.to; walk.to = f; walk.t = 1 - walk.t;
  }
  /** No plan yet, or a plan with no graph: a slow arc inside the plat. Demo mode
   *  and the first second of a cold open both land here, and neither may fall
   *  through the world or wander off the terrain. */
  function freeStep(adv) {
    walk.az += clamp(wrapPi(c.az - walk.az), -.03, .03);
    walk.bx -= Math.sin(walk.az) * adv;
    walk.bz -= Math.cos(walk.az) * adv;
    const R = Math.max(bnd.r * .62, 18);
    const dx = walk.bx - bnd.cx, dz = walk.bz - bnd.cz, d = Math.hypot(dx, dz);
    if (d > R) {
      walk.bx = bnd.cx + dx / d * R; walk.bz = bnd.cz + dz / d * R;
      walk.az = Math.atan2(dx / d, dz / d);      // face the middle again
    }
  }
  /** The walls within reach, re-listed on the WALL CLOCK. At .72 u/s the list is
   *  good for 30 units of walking, so 400 ms is eighty times more often than it
   *  needs to be — and it is O(n) over a 1200-building town, i.e. 3000 distance
   *  tests a second, which is under a hundredth of a millisecond. */
  function refreshWalls(now) {
    if (now - nearWallsAt < CLEAR_MS) return;
    nearWallsAt = now; nearWalls.length = 0;
    const list = getBuildings ? getBuildings() : null;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i], p = e && e.pos;
      if (!p || e.kind === 'bridge') continue;   // you walk ON a bridge, not around it
      const dx = p.x - walk.x, dz = p.z - walk.z;
      if (dx * dx + dz * dz > CLEAR_R * CLEAR_R) continue;
      nearWalls.push(p.x, p.z, wallR(e));
    }
  }
  /** A building's reach, from what getBuildings() actually carries. A landmark is
   *  a different ANIMAL, not a tall house: a keep or a tithe barn is a long
   *  rectangle whose curtain runs ten units from its own centre, and sizing it
   *  like a cottage is how a walk ends with its nose against a wall. */
  const wallR = e => e && e.kind === 'landmark'
    ? clamp(3.4 + (e.hTop > 0 ? e.hTop : 10) * .46, 6, 13)
    : clamp(1.5 + (e.hTop > 0 ? e.hTop : 4) * .26, 2, 4.2);
  /** THE BACKSTOP, not the mechanism — the graph is what keeps you out of houses.
   *  This catches what the graph does not model: a landmark dropped over a lane,
   *  the fountain in the middle of the square, a plan swapped under a live walk.
   *
   *  It carries a STANDING displacement rather than nudging the frame it is in.
   *  A per-frame push cannot get out of a keep: the graph rewrites the walker's
   *  position from its edge parameter every frame, so a shove is forgotten as
   *  fast as it is applied and the camera sits inside the curtain wall for the
   *  whole length of the street. The offset persists, moves at a walking pace,
   *  and decays back to the middle of the lane the moment nothing is in the way.
   *
   *  IT IS STRICTLY LATERAL, AND IT NEVER LEAVES THE ROAD. This is the bit that
   *  was wrong first time and photographed as the inside of somebody's cottage: a
   *  free push takes the shortest way out of the wall on YOUR side of the lane,
   *  which is a straight line into the wall on the other side. A village lane has
   *  a house within two units of its centreline on BOTH sides — there is nowhere
   *  to be pushed to. So the push may only slide along the lane's own normal, by
   *  no more than the road's half width plus a shoulder, and a landmark actually
   *  sitting across the road is refused at edge-choice time instead. */
  function clearWalker(gr, dtw) {
    // the lane's normal, and how far off its middle a walker may legally stand
    let nx = 1, nz = 0, lim = 1.2;
    if (gr && walk.ei >= 0) {
      const e = gr.edges[walk.ei], a = gr.nodes[walk.from], b = gr.nodes[walk.to];
      if (a && b) {
        const vx = b.x - a.x, vz = b.z - a.z, L = Math.hypot(vx, vz) || 1;
        nx = -vz / L; nz = vx / L;
        lim = Math.min(2.2, (e && e.w > 0 ? e.w : 3.7) * .5 + .6);
      }
    }
    let px = 0, pz = 0;
    for (let i = 0; i < nearWalls.length; i += 3) {
      const dx = walk.x - nearWalls[i], dz = walk.z - nearWalls[i + 1], r = nearWalls[i + 2] + .9;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1e-3;
      const k = (r - d) / d;
      px += dx * k; pz += dz * k;
    }
    // The fountain stands on the origin in every plan (layout.js plazaPos), and
    // standing in the basin is the one place a stroll must never end up.
    const fd = Math.hypot(walk.x, walk.z);
    if (fd < 4.6) { const k = (4.6 - fd) / (fd || 1e-3); px += walk.x * k; pz += walk.z * k; }
    // …flattened onto the lane's normal, and only then obeyed.
    const lat = px * nx + pz * nz;
    let want;
    if (Math.abs(lat) > 1e-4) want = walk.off + clamp(lat, -PUSH_MAX, PUSH_MAX);
    else want = walk.off - Math.sign(walk.off) * Math.min(Math.abs(walk.off), DECAY * dtw);
    want = clamp(want, -lim, lim);
    const step = clamp(want - walk.off, -OFF_RATE * dtw, OFF_RATE * dtw);
    walk.off += step;
    walk.ox = nx * walk.off; walk.oz = nz * walk.off;
    walk.x = walk.bx + walk.ox; walk.z = walk.bz + walk.oz;
  }
  /** One step of the walk, integrated from the WALL CLOCK. */
  function stepWalk(now) {
    // A stroll begun before the plan existed starts in free mode; the moment a
    // graph appears, step onto it. Without this, `walk.free` is a one-way door and
    // a mode entered a second too early never finds a street for the rest of the
    // epoch.
    let gr = graphOf();
    if (walk.free && gr) { placeWalker(walk.x, walk.z); gr = walk.free ? null : gr; }
    const dtw = clamp((now - walk.lastT) / 1000, 0, 1.5);
    walk.lastT = now;
    // Stopping to look is what people do at street level, and it costs no key:
    // a drag halts the feet over ~.45 s and letting go starts them again.
    walk.pace += ((dragging ? 0 : 1) - walk.pace) * (1 - Math.exp(-dtw / .45));
    const adv = Math.max(STROLL_SPEED * walk.pace * dtw, 0);
    walk.s += adv;
    refreshWalls(now);                           // BEFORE turnAt: it votes on the next lane
    if (!gr || walk.ei < 0) { walk.free = !gr; freeStep(adv); }
    else {
      // The only steering that acts mid-edge. Without it a dead-end lane is a
      // trap and a wrong turn costs you the length of the street.
      if (now - walk.turnT > UTURN_MS && Math.abs(wrapPi(c.az - walk.az)) > UTURN) {
        reverse(); walk.turnT = now;
      }
      // …and the same test on the road you are ALREADY on. `walkTo` and a plan
      // that grew a landmark under a live walk can both put you on an edge that
      // turnAt would have refused; turn back rather than walk into the barn.
      else if (now - walk.turnT > UTURN_MS && walk.t < .5) {
        const a = gr.nodes[walk.from], b = gr.nodes[walk.to];
        if (a && b && edgeBlocked(a, b)) { reverse(); walk.turnT = now; }
      }
      const maxD = reachLimit();
      let left = adv, guard = 0;
      while (left > 1e-6 && guard++ < 8) {
        const a = gr.nodes[walk.from], b = gr.nodes[walk.to];
        const L = (a && b) ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
        if (!(L > .01)) { turnAt(gr, maxD); continue; }
        const remain = (1 - walk.t) * L;
        if (left < remain) { walk.t += left / L; left = 0; }
        else { left -= remain; walk.t = 1; turnAt(gr, maxD); }
      }
      stepPos(gr);
      // The feet swing round a corner; they do not snap to it.
      const want = headingOf(gr), dz = clamp(wrapPi(want - walk.az), -TURN_RATE * dtw, TURN_RATE * dtw);
      walk.az += dz;
    }
    clearWalker(gr, dtw);
    groundWalker(gr);
  }
  /** Place the eye, then hang the goal target a look-length down the gaze. */
  function writeStrollGoal(wdt) {
    if (!dragging) {
      strollLook += wrapPi(walk.az - strollLook) * (1 - Math.exp(-wdt / LOOK_TAU));
      g.pol += (S_POL_HOME - g.pol) * (1 - Math.exp(-wdt / PITCH_TAU));
    }
    g.az = strollLook;
    g.pol = clamp(g.pol, S_POL_MIN, S_POL_MAX);
    g.dist = STROLL_LOOK;
    g.fov = clamp(strollFov, S_FOV_MIN, S_FOV_MAX);
    const cp = Math.cos(g.pol), sp = Math.sin(g.pol);
    g.tx = walk.x - Math.sin(g.az) * cp * STROLL_LOOK;
    g.ty = walk.y + EYE_H - sp * STROLL_LOOK;
    g.tz = walk.z - Math.cos(g.az) * cp * STROLL_LOOK;
    // How far the WORLD reads, which on foot has nothing to do with `dist`. The
    // surface shader's far-fade is sized off the framing distance, and a 9-unit
    // framing flattens everything past ~28 units into the far-land colour.
    strollViewD = clamp(bnd.r * 1.35, 110, 260);
  }
  /** Stand on the street at (x,z) — a deed's 'Walk there', or a click on a lane. */
  function walkTo(x, z, opts) {
    if (!isFinite(x) || !isFinite(z)) return false;
    followH = null; tourOn = false; shots = null; focusId = null;
    const arriving = mode !== 'stroll';
    placeWalker(x, z);
    walk.lastT = lastNow;
    // Arriving from above, face the way the street runs; already down here, keep
    // the heading you were walking with — a 'walk there' is a move, not a spin.
    strollLook = (opts && isFinite(opts.az)) ? opts.az : arriving ? walk.az : c.az;
    g.pol = clamp((opts && isFinite(opts.pol)) ? opts.pol : S_POL_HOME, S_POL_MIN, S_POL_MAX);
    strollFov = FOV.stroll;
    writeStrollGoal(0);                          // wdt 0: place the goal, ease nothing
    Object.assign(tau, TRANSIT); transitLeft = MOVE_S;
    setMode('stroll', { x, z });
    return true;
  }
  /** No argument, or an unreachable one, means "stand where the town is". */
  function stroll(at) {
    if (mode === 'stroll' && !at) { orbit(); return true; }
    if (at && isFinite(at.x) && isFinite(at.z)) return walkTo(at.x, at.z);
    // The gate is the one place in every plan that is unambiguously a street —
    // and arriving by the road into town is the right way to arrive.
    const p = getPlan && getPlan(), q = p && p.gate;
    if (q) return walkTo(q.x, q.z);
    return walkTo(bnd.cx + bnd.r * .55, bnd.cz);
  }

  function photo(on) {
    if (!on) { if (mode === 'photo') orbit(); return; }
    if (mode === 'photo') return;
    const from = mode;
    followH = null; tourOn = false; shots = null;
    g.dist = clamp(c.dist * .86, DIST_MIN, DIST_MAX);
    g.tx = c.tx; g.ty = c.ty; g.tz = c.tz; g.az = c.az; g.pol = c.pol;
    g.fov = FOV.photo;
    photoD = g.dist / Math.max(1, frameD);     // the framing this shot was composed at
    setMode('photo', { from });
  }

  /* ═══ the sky beat ══════════════════════════════════════════════ */
  /** Look up for a few seconds, then look back down.
   *
   *  ORBIT ONLY, on purpose. focus, follow, tour, photo and stroll are all places
   *  the user (or a reel) deliberately went; a celebration is not a reason to
   *  take a subject away from them. Orbit is the mode with nowhere in particular
   *  to be, and the one whose framing is what hides the sky in the first place.
   *
   *  @param {string} [kind]  what it is looking at; forwarded to onMode as meta
   *  @param {{delay?:number, aim?:number}} [opts]
   *         `delay` ms before the lift starts — the caller's "six seconds after
   *         the celebration" without a timer of its own; `aim` overrides the
   *         settled pitch BELOW horizontal (negative looks above it).
   *  @returns {boolean} did it arm */
  function beat(kind, opts) {
    if (mode !== 'orbit' || pinned) return false;
    const o = opts || {};
    beatAim = clamp(isFinite(o.aim) ? +o.aim : BEAT_AIM, -.6, POL_MAX);
    beatOn = true;
    beatFrom = lastNow + (isFinite(o.delay) && o.delay > 0 ? +o.delay : 0);
    beatCutAt = -1e9; beatCutK = 0;
    if (onMode) onMode(mode, mode, { beat: kind || 'sky' });
    return true;
  }
  /** The envelope, in the SAME shape whether it is running or being handed back:
   *  ease up, hold, ease down. -1 means "and it is over". */
  function beatEnv(t) {
    if (t < 0) return 0;
    if (t < BEAT_IN) return easeInOut(t / BEAT_IN);
    if (t < BEAT_IN + BEAT_HOLD) return 1;
    const k = (t - BEAT_IN - BEAT_HOLD) / BEAT_OUT;
    return k >= 1 ? -1 : 1 - easeInOut(k);
  }
  /** 0..1, read once per frame by applyCam. Everything is on the WALL CLOCK: at
   *  1 fps a dt-paced tilt photographs as having never happened. */
  function beatK(now) {
    if (!beatOn) return 0;
    if (beatCutAt > -1e8) {                    // handed back — let go on the same curve
      const k = beatCutK * (1 - easeInOut(clamp((now - beatCutAt) / BEAT_OUT, 0, 1)));
      if (k < .002) { beatOn = false; beatCutAt = -1e9; return 0; }
      return k;
    }
    const t = now - beatFrom;
    // THE USER ALWAYS WINS. A hand on the pointer (or on any key) after the lift
    // began takes the camera back — it yields, it does not wrestle — and leaving
    // orbit at all ends it outright. Input BEFORE `beatFrom` does not count: the
    // whole point of the delay is that the celebration is still going on.
    if (t >= 0 && (mode !== 'orbit' || dragging || lastInputAt > beatFrom)) {
      beatCutK = Math.max(beatEnv(t), 0); beatCutAt = now;
      if (beatCutK < .002) { beatOn = false; beatCutAt = -1e9; return 0; }
      return beatCutK;
    }
    const k = beatEnv(t);
    if (k < 0) { beatOn = false; return 0; }
    return k;
  }

  /* ═══ bookmarks ═════════════════════════════════════════════════ */
  const markKey = () => {
    const p = getPlan && getPlan();
    return 'tt.cam.' + ((p && p.seed >>> 0) || 0);
  };
  function loadMarks() {
    marks.fill(null);
    try {
      const raw = globalThis.localStorage && globalThis.localStorage.getItem(markKey());
      if (!raw) return;
      const a = JSON.parse(raw);
      if (Array.isArray(a)) for (let i = 1; i <= 5; i++) if (a[i] && isFinite(a[i].dist)) marks[i] = a[i];
    } catch { /* a private-mode storage throw must not cost the user their camera */ }
  }
  function saveMarks() {
    try {
      if (globalThis.localStorage) globalThis.localStorage.setItem(markKey(), JSON.stringify(marks));
    } catch { /* ignore */ }
  }
  function bookmark(i) {
    i = Math.floor(i);
    if (!(i >= 1 && i <= 5)) return;
    marks[i] = { az: c.az, pol: c.pol, dist: c.dist, tx: c.tx, ty: c.ty, tz: c.tz, fov: c.fov };
    saveMarks();
  }
  function jumpTo(i) {
    i = Math.floor(i);
    const m = (i >= 1 && i <= 5) ? marks[i] : null;
    if (!m) return false;
    orbit();
    orb.az = m.az; orb.pol = m.pol; orb.userD = m.dist; userDist = true;
    userDistAtR = bnd.r; lastWheel = lastNow;
    panX = m.tx - bnd.cx; panZ = m.tz - bnd.cz; clampPan();
    return true;
  }

  /* ═══ the tour ══════════════════════════════════════════════════ */
  // The default reel is derived from cfg alone, so the rig can tour a town nobody
  // has described to it. A richer list (groves, the grandest house, event splices)
  // is passed in by the caller; at() returning null SKIPS a shot with no gap, so a
  // lakeside town with no bridge simply runs a shorter loop.
  function defaultShots() {
    const plan = () => (getPlan ? getPlan() : null);
    const pick = (kind, n) => {
      const list = getBuildings ? getBuildings() : null;
      if (!list || !list.length) return null;
      let k = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i], ek = e.kind || 'house';
        if (kind && ek !== kind) continue;
        if (!kind && ek !== 'house') continue;
        if (k++ === n) return e;
      }
      return null;
    };
    const anchorOf = (e, hTop) => e && e.pos ? {
      x: e.pos.x, y: 0, z: e.pos.z, hTop: e.hTop > 0 ? e.hTop : hTop,
      id: e.idx != null ? 'b' + e.idx : null, label: e.label || ''
    } : null;
    return [
      {
        id: 'gate', hold: 6500, dist: 24, pol: .20, azRel: .9,
        at: () => { const p = plan(), q = p && p.gate; return q ? { x: q.x, y: 0, z: q.z, hTop: 5, id: 'gate' } : null; },
        caption: f => `The road into ${f.town}`
      },
      {
        id: 'plaza', hold: 9000, pol: .34, spin: .05, azRel: 1.1,
        at: () => ({ x: 0, y: 0, z: 0, hTop: monTop, id: 'plaza' }),
        dist: () => Math.max(30, monTop * 2.3),
        caption: f => `${f.town}'s fountain · ${f.tokStr} tokens ${f.rangeShort}`.trim()
      },
      {
        // 28, not 20. At 20 units the neighbouring roof clipped the bottom of
        // frame and environs' verge tufts — authored for the wide auto-framing,
        // where a tuft is a few pixels — stood as tall as the cottage's eaves.
        id: 'newest', hold: 6500, dist: 28, pol: .38, azRel: .8,
        at: () => anchorOf(pick(null, 0), 4),
        caption: f => f.label ? `Newest on the plat — ${f.label}` : 'Newest on the plat'
      },
      {
        id: 'landmark', hold: 7500, pol: .40, azRel: 1.0,
        at: () => anchorOf(pick('landmark', lmPick++), 12),
        caption: f => f.label ? `${f.label}, standing` : 'A landmark, standing'
      },
      {
        id: 'crossing', hold: 6500, dist: 22, pol: .30, azRel: .7,
        // …and the crossing's own base is its DECK, not the riverbed under it
        at: () => { const p = plan(), b = p && p.bridges && p.bridges[0]; return b ? { x: b.x, y: DECK_Y, z: b.z, hTop: 3, id: 'bridge' } : null; },
        caption: () => 'The crossing'
      },
      {
        id: 'wide', hold: 9500, pol: .58, spin: .03, azRel: 1.3, fov: 46,
        at: () => ({ x: bnd.cx, y: 0, z: bnd.cz, hTop: monTop, id: 'wide' }),
        dist: () => frameD * 1.12,
        caption: f => `${f.town} · ${f.buildings} buildings`
      }
    ];
  }
  function fillFacts(a, ctx, i) {
    facts.town = (ctx && ctx.townName) || 'the town';
    facts.buildings = (ctx && ctx.buildingCount) || 0;
    facts.tok = (ctx && ctx.totalTok) || 0;
    facts.tokStr = fmtTok(facts.tok);
    facts.rangeShort = (ctx && ctx.rangeShort) || '';
    facts.label = (a && a.label) || '';
    facts.n = (ctx && ctx.buildingCount) || 0;
    facts.i = i; facts.of = shots ? shots.length : 0;
    return facts;
  }
  /** Advance to the first shot at or after `from` whose at() resolves. */
  function nextShot(now, ctx, from) {
    if (!shots || !shots.length) { orbit(); return; }
    for (let k = 0; k < shots.length; k++) {
      const i = ((from + k) % shots.length + shots.length) % shots.length;
      const s = shots[i], a = s && typeof s.at === 'function' ? s.at() : null;
      if (!a || !isFinite(a.x) || !isFinite(a.z)) continue;
      shotI = i; shotAt = now; transitLeft = MOVE_S;
      Object.assign(tau, TRANSIT);
      aimAt(a, { dist: typeof s.dist === 'function' ? s.dist() : s.dist, pol: s.pol, azRel: s.azRel });
      g.fov = isFinite(s.fov) ? s.fov : FOV.tour;
      // the live caption, rendered once per shot: interact.js reads it straight
      // onto the mode pill, and onShot gives the same line to anyone else
      const f = fillFacts(a, ctx, i);
      caption = typeof s.caption === 'function' ? String(s.caption(f) || '')
        : typeof s.caption === 'string' ? s.caption : '';
      if (onShot) onShot(s, f);
      return;
    }
    orbit();                                   // nothing in this town is showable
  }

  /* ═══ input ═════════════════════════════════════════════════════ */
  let rect = null;
  const rectOf = () => (rect || (rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 }));
  const invalidate = () => { rect = null; };
  function noteInput() { idleT = 0; lastInputAt = lastNow; }
  // Which variable IS the heading under the hand. orbit keeps its own so a focus
  // can be left for free; stroll keeps its own so the walk can re-centre the gaze
  // without the drag and the lane fighting over one field.
  const liveAz = () => mode === 'orbit' ? orb.az : mode === 'stroll' ? strollLook : g.az;
  /** Everything the user does with the pointer relaxes the follower to LIVE — a
   *  cinematic tau under the hand feels like a broken mouse. */
  function handOver() { Object.assign(tau, LIVE[mode] || LIVE.orbit); transitLeft = 0; }

  /* ── THE TWO GESTURES ────────────────────────────────────────────
     LEFT DRAG MOVES THE TOWN; RIGHT DRAG LOOKS AT IT. They used to be the other
     way round, and both halves were wrong for the same reason. The button a
     hand is already resting on was bound to the thing you want least often —
     you spend a session going somewhere and only occasionally changing the
     angle you see it from — and what the right button was left holding was
     `panBy`, a screen-space nudge scaled by a GUESS at how much world a pixel
     is worth (`dist × .0016`). The guess is exactly right at one pitch, one
     distance and one fov and wrong everywhere else, so the ground slid out from
     under the cursor at a different rate every time you touched it. That is
     what "it works very badly, it's just not intuitive" describes; there is
     nothing to tune, because a constant cannot be the answer.

     THE PAN IS NOT A NUDGE — IT IS A CONSTRAINT. On pointerdown we raycast the
     ground point under the cursor and remember it (`grab`). Every move re-solves
     the cursor's ray against the HORIZONTAL PLANE THROUGH THAT POINT and
     translates the rig by whatever puts `grab` back under the pointer. The
     scale is never computed because there is no scale: it comes out exact at
     any pitch, distance and fov, for free. And because each event solves for an
     absolute position rather than integrating a delta, nothing drifts — a frame
     eaten by a 400-building cascade costs nothing, and the leash below can
     refuse a move without the gesture losing its place.

     THE PLANE IS FIXED AT THE GRAB HEIGHT, not re-sampled off the terrain
     (which is why this does not just call screenToGround): a plane that moved
     with the hills would make the mapping non-linear, and dragging across a
     valley would speed up and slow down under the hand.

     IT WRITES `c` AS WELL AS `g`, the only gesture in the file that does. Every
     other channel is a goal with a follower, and a follower lagging a moving
     goal settles at rate × tau — at the orbit's .30 s that is a third of a
     second of ground sliding away from the cursor, i.e. precisely the thing
     this exists to stop. A pan has no cinematography in it: the hand IS the
     animation.

     TRANSLATION INVARIANCE is why moving camera.position inside a pointer
     handler is honest and not a hack. Translating a camera and a horizontal
     plane by the same vector translates their intersection by that vector
     exactly, and the orientation is untouched — so the matrix we leave behind
     is bit-for-bit what applyCam will rebuild from `c` next frame, the next
     pointermove in this same frame solves against a camera that is ALREADY
     correct, and ten moves inside one frame land where ten frames of one move
     each would. */
  /** The ray through a canvas-relative pixel, met with the plane y = planeY.
   *  @returns {boolean} did it land somewhere sane */
  function rayToPlane(px, py, planeY, out) {
    const r = rectOf(), w = r.width || 1, h = r.height || 1;
    camera.updateMatrixWorld();
    _pa.set((px / w) * 2 - 1, -(py / h) * 2 + 1, .5).unproject(camera).sub(camera.position).normalize();
    // Within about a degree of the horizon the plane is met a mile away and the
    // solution is meaningless. Refuse it; the caller has a fallback.
    if (!(Math.abs(_pa.y) > .02)) return false;
    const t = (planeY - camera.position.y) / _pa.y;
    if (!(t > 0)) return false;
    out.set(camera.position.x + _pa.x * t, planeY, camera.position.z + _pa.z * t);
    return true;
  }
  /** Press: take hold of the ground under the cursor. A press on the sky leaves
   *  `grabOn` false and the drag falls back to the old screen-space nudge. */
  function grabAt(cx, cy) {
    grabOn = false;
    if (!canvas) return;
    const r = rectOf();
    if (!screenToGround(cx - r.left, cy - r.top, _gp)) return;
    grabX = _gp.x; grabY = _gp.y; grabZ = _gp.z; grabOn = true;
  }
  /** Move: put the grabbed point back under the pointer. */
  function panTo(cx, cy, dx, dy) {
    const r = rectOf();
    if (!grabOn || !rayToPlane(cx - r.left, cy - r.top, grabY, _pb)) { panBy(dx, dy); return; }
    let mx = grabX - _pb.x, mz = grabZ - _pb.z;
    // A near-grazing ray that squeaked past the .02 test still may not throw the
    // town across the plat in one event.
    const lim = Math.max(c.dist, 8) * .75, m = Math.hypot(mx, mz);
    if (m > lim) { mx *= lim / m; mz *= lim / m; }
    panRig(mx, mz);
  }
  /** Translate the whole rig by (mx, mz): goal, current state and camera. */
  function panRig(mx, mz) {
    // Two modes own their own target and would overwrite this on the next frame
    // — the walker is where the eye is, and driveFollow re-aims at the villager
    // every frame. A pan there is a one-frame jitter, so it is refused instead.
    if (mode === 'stroll' || mode === 'follow') return;
    if (mode === 'orbit' || mode === 'photo') {
      const bx = panX, bz = panZ;
      panX += mx; panZ += mz; clampPan();
      mx = panX - bx; mz = panZ - bz;                   // the leash gets its say first
    }
    if (!mx && !mz) return;
    // orbit rebuilds its goal from panX every frame; everyone else carries it
    if (mode === 'orbit') { g.tx = bnd.cx + panX; g.tz = bnd.cz + panZ; }
    else { g.tx += mx; g.tz += mz; }
    c.tx += mx; c.tz += mz;
    camera.position.x += mx; camera.position.z += mz;
    focusPoint.x += mx; focusPoint.z += mz;             // town.js's sun target, kept honest mid-frame
    camera.updateMatrixWorld();
  }

  // WHICH BUTTON IS WHICH. Right looks; left (and middle, which is a pan
  // everywhere else in the world) drags the town. On foot and while following
  // someone there is nowhere to pan TO, and a left button that did nothing at
  // all would be worse than the look it has always had there.
  const canPan = () => mode !== 'stroll' && mode !== 'follow';
  function onDown(e) {
    if (dragId >= 0) return;                   // one pointer; a second finger is not a gesture we own
    dragId = e.pointerId != null ? e.pointerId : 0;
    dragging = true; dragPx = 0; dragBtn = e.button || 0;
    dragLook = dragBtn === 2 || !canPan();
    dragX = e.clientX; dragY = e.clientY; vAz = vPol = 0;
    dragAz = liveAz(); dragPol = mode === 'orbit' ? orb.pol : g.pol;
    grabOn = false;
    if (!dragLook) grabAt(e.clientX, e.clientY);
    noteInput();
  }
  function onMove(e) {
    if (!dragging || (e.pointerId != null && e.pointerId !== dragId)) return;
    const dx = e.clientX - dragX, dy = e.clientY - dragY;
    dragX = e.clientX; dragY = e.clientY;
    dragPx += Math.abs(dx) + Math.abs(dy);
    if (!dx && !dy) return;
    noteInput();
    // Any drag stops the tour, silently — and a pan re-grabs, because the shot it
    // took hold of is about to ease away underneath it.
    if (mode === 'tour') { orbit(); handOver(); if (!dragLook) grabAt(e.clientX, e.clientY); }
    if (dragLook) {
      const dAz = -dx * .006, dPol = dy * .004;
      if (mode === 'follow') { followAzOff += dAz; g.pol = clamp(g.pol + dPol, POL_MIN, POL_MAX); }
      else if (mode === 'orbit') { orb.az += dAz; orb.pol = clamp(orb.pol + dPol, POL_MIN, POL_MAX); }
      // A drag down looks down, the same as it tips the orbit over the town — the
      // one gesture the whole app has, meaning the same thing on foot.
      else if (mode === 'stroll') { strollLook += dAz; g.pol = clamp(g.pol + dPol, S_POL_MIN, S_POL_MAX); }
      else { g.az += dAz; g.pol = clamp(g.pol + dPol, POL_MIN, POL_MAX); }
    } else panTo(e.clientX, e.clientY, dx, dy);
    handOver();
  }
  function onUp(e) {
    if (e && e.pointerId != null && e.pointerId !== dragId) return;
    dragging = false; dragId = -1; grabOn = false;
    // A flick may glide; it may not throw the town. 3 rad/s decaying over .42 s is
    // most of a half-turn, which is as far as any gesture should ever carry.
    // A PAN NEVER GLIDES: the ground was glued to the cursor for the whole drag,
    // and ground that keeps moving after the hand stopped is the "inertia
    // weirdness" this rework is here to remove. vAz/vPol are only ever sampled
    // for a look drag, so this is a clamp on nothing after a pan.
    vAz = clamp(vAz, -3, 3); vPol = clamp(vPol, -2, 2);
    if (Math.abs(vAz) < .02) vAz = 0;
    if (Math.abs(vPol) < .02) vPol = 0;
  }
  /** THE FALLBACK, not the mechanism — panTo above is the pan. This is what is
   *  left when there is no ground to hold on to (a press on the sky, a camera
   *  aimed at the horizon), and its constant is a guess, which is exactly why it
   *  no longer runs the gesture. */
  function panBy(dx, dy) {
    // On foot the walker owns where the camera is, so a pan would be overwritten
    // by the next writeStrollGoal anyway. Say no here rather than jitter for a
    // frame: you move by walking.
    if (mode === 'stroll' || mode === 'follow') return;
    const k = Math.max(c.dist, 8) * .0016;
    const s = Math.sin(c.az), co = Math.cos(c.az);
    // camera forward on the ground is (-sin, -cos); screen right is (cos, -sin)
    const mx = -(co * dx - s * dy) * k, mz = -(-s * dx - co * dy) * k;
    if (mode === 'orbit' || mode === 'photo') { panX += mx; panZ += mz; clampPan(); }
    if (mode !== 'orbit') { g.tx += mx; g.tz += mz; }
  }
  function onWheel(e) {
    e.preventDefault();
    noteInput();
    if (mode === 'tour') orbit();
    const f = 1 + (e.deltaY || 0) * .001;
    if (mode === 'orbit') {
      const was = orb.userD = userDist ? orb.userD : frameD;
      // The upper clamp respects a big town: a 480-unit framing must not be yanked
      // to 340 by one wheel click.
      orb.userD = clamp(was * f, DIST_MIN, Math.max(DIST_MAX, frameD));
      userDist = true; userDistAtR = bnd.r; lastWheel = lastNow;
      // ZOOM TO CURSOR: pull the target 22 % of the way toward the ground point
      // under the pointer as we close in, so zooming at the mill approaches the
      // mill. Pushing out re-centres on nothing — the framing already owns that.
      if (f < 1 && canvas && screenToGround(e.clientX - rectOf().left, e.clientY - rectOf().top, _gp)) {
        const k = .22 * (1 - f);
        panX += (_gp.x - (bnd.cx + panX)) * k; panZ += (_gp.z - (bnd.cz + panZ)) * k;
        clampPan();
      }
    } else if (mode === 'stroll') {
      // There is no dolly on foot — the eye is at the eye. The wheel leans in
      // instead: 74° is a doorway at arm's length, 34° is reading the weather vane
      // across the square. It is the only zoom a person standing in a street has.
      strollFov = clamp(strollFov * f, S_FOV_MIN, S_FOV_MAX);
    } else {
      g.dist = clamp(g.dist * f, DIST_MIN, DIST_MAX);
      if (mode === 'follow') followWheel = true;
    }
    handOver();
  }
  function onDbl(e) {
    // interact.js consumes a dblclick on an entity (focus it) by calling
    // preventDefault; an unconsumed one means empty ground: frame the town.
    if (e && e.defaultPrevented) return;
    noteInput();
    userDist = false; panX = panZ = 0;
    orbit();
  }
  const onCtx = e => e.preventDefault();       // right-drag looks around; it must not open a menu
  const onKey = () => { idleT = 0; lastInputAt = lastNow; };   // idle bookkeeping only — every key belongs to interact.js

  if (canvas) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('contextmenu', onCtx);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, true);
  }

  /* ═══ per-frame ═════════════════════════════════════════════════ */
  function driveFollow(now, wdt) {
    const t = resolveFollow ? resolveFollow(followH) : null;
    if (!t || t.alive === false) {
      // They went in for the night. Hand the camera back rather than staring at
      // the spot where somebody used to be.
      orbit({ meta: { lost: true, handle: followH } });
      return;
    }
    g.tx = t.x; g.ty = (t.y || 0) + 1.15; g.tz = t.z;
    // Re-measured every frame: they walk, and a plaza-bound pilgrim crosses into
    // the altar's shadow while you are watching them.
    const push = plazaStandoff(t.x, t.z);
    if (t.state === 'worship') {
      // Watch the rite, not the back of a kneeling head.
      if (!followWheel) g.dist = 16 + push;
      g.pol = Math.max(.52, push > 0 ? .56 : .52); g.az += .06 * wdt;
    } else {
      if (!followWheel) g.dist = ((t.hTop > 0 && t.hTop < 2) ? 8 : 11) + push;
      if (push > 0) {
        g.pol = Math.max(g.pol, .42);
        // On the plaza, follow from outside the ring: their own heading would put
        // the altar between us and them for half of every lap.
        const d = Math.hypot(t.x, t.z);
        if (d > 1) { g.az = Math.atan2(t.x, t.z) + followAzOff; return; }
      }
      g.az = (t.yaw || 0) + Math.PI + followAzOff;
    }
  }
  function driveTour(now, ctx, wdt) {
    if (!shots || !shots.length) { orbit(); return; }
    const s = shots[shotI] || null;
    if (!s || now - shotAt >= (s.hold > 0 ? s.hold : 7000)) { nextShot(now, ctx, shotI + 1); return; }
    g.az += (isFinite(s.spin) ? s.spin : .020) * wdt;
  }

  function update(wdt, now, ctx) {
    wdt = clamp(+wdt || 0, 0, .5);
    now = isFinite(now) ? now : lastNow;
    if (!synced) {
      synced = true;
      const d = now - lastNow;
      if (d) { shotAt += d; dollyT += d; lastWheel += d; lastInputAt += d; }
    }
    lastNow = now;
    if (ctx) lastCtx = ctx;
    if (ctx && ctx.bounds && ctx.bounds.r > 0) {
      // bounds are mutated in place by town.js; re-read them so fitBias and the
      // shadow frustum track a growing town between structural changes.
      bnd.cx = ctx.bounds.cx; bnd.cz = ctx.bounds.cz; bnd.r = ctx.bounds.r;
      if (ctx.bounds.hx > 0) bnd.hx = ctx.bounds.hx;
      if (ctx.bounds.hz > 0) bnd.hz = ctx.bounds.hz;
    }
    // GROWTH IS THE ONLY THING ALLOWED TO TAKE THE WHEEL BACK, and only after
    // twenty seconds of hands-off: a session that starts at 40 buildings and ends
    // at 450 must not spend four hours cropped to the first forty.
    if (userDist && bnd.r > userDistAtR * 1.12 && now - lastWheel > 20000) {
      userDist = false; panX = panZ = 0;
      if (onMode) onMode(mode, mode, { refit: true, toast: 'framing the whole town again' });
    }
    if (!dragging) idleT += wdt; else idleT = 0;
    if (dragging && dragLook) {
      // The hand's speed, sampled on the FRAME clock: a burst of pointermoves
      // inside one frame is one sample, which is what "the last 90 ms" means in
      // practice and what keeps a 1000 Hz mouse from launching the town.
      const az = liveAz(), pol = mode === 'orbit' ? orb.pol : g.pol;
      if (wdt > 1e-4) {
        const k = 1 - Math.exp(-wdt / .09);
        vAz += (wrapPi(az - dragAz) / wdt - vAz) * k;
        vPol += ((pol - dragPol) / wdt - vPol) * k;
      }
      dragAz = az; dragPol = pol;
    }
    // A focus outlives its usefulness: 45 s of hands-off hands the town back.
    // interact.js hears it through onMode and can drop its selection with it.
    if (mode === 'focus' && idleT > 45) orbit({ meta: { idle: true } });

    // ── mode drivers write the goal ──
    if (mode === 'follow') driveFollow(now, wdt);
    else if (mode === 'tour') driveTour(now, ctx, wdt);
    // The FEET move first, from the wall clock. The eye is placed at the bottom of
    // this function, after the inertia of a flick has had its say on the gaze.
    else if (mode === 'stroll') stepWalk(now);
    // PHOTO MODE KEEPS ITS COMPOSITION AND LOSES ITS FRAMING. It used to copy the
    // camera once and never look at the town again, so a screensaver left up while
    // the town grew from 40 buildings to 450 stayed nose-in on whatever was in
    // front of it when P was pressed. The az/pol/fov are the user's; the distance
    // and the centre track the orbit goal on a very slow tau, so an hour later it
    // is still a photograph of the whole town from the angle they chose.
    else if (mode === 'photo' && !userDist) {
      const k = 1 - Math.exp(-wdt / 6);
      g.dist += (frameD * photoD - g.dist) * k;
      g.tx += (bnd.cx + panX - g.tx) * k;
      g.tz += (bnd.cz + panZ - g.tz) * k;
      g.ty += (tgtY - g.ty) * k;
    }
    if (mode === 'orbit') writeOrbitGoal();

    // ── inertia, then the idle drift ──
    if (!dragging && (vAz || vPol)) {
      const d = Math.exp(-wdt / .42);
      if (mode === 'orbit') { orb.az += vAz * wdt; orb.pol = clamp(orb.pol + vPol * wdt, POL_MIN, POL_MAX); }
      else if (mode === 'stroll') { strollLook += vAz * wdt; g.pol = clamp(g.pol + vPol * wdt, S_POL_MIN, S_POL_MAX); }
      else { g.az += vAz * wdt; g.pol = clamp(g.pol + vPol * wdt, POL_MIN, POL_MAX); }
      vAz *= d; vPol *= d;
      if (Math.abs(vAz) < .02) vAz = 0;
      if (Math.abs(vPol) < .02) vPol = 0;
      if (mode === 'orbit') { g.az = orb.az; g.pol = orb.pol; }
    } else if (idleT > IDLE_S && !pinned) {
      const r = DRIFT[mode] || 0;
      if (r) { if (mode === 'orbit') { orb.az += r * wdt; g.az = orb.az; } else g.az += r * wdt; }
    }
    // …and NOW the eye, so a flick's residue and the lane's pull are both in the
    // gaze before the target is hung off it.
    if (mode === 'stroll') writeStrollGoal(wdt);
    // captured before the countdown: at 1 fps the frame that *starts* 0 ms into a
    // move is 500 ms long, and it is that frame which must snap
    const fresh = transitLeft > MOVE_S - .4;
    if (transitLeft > 0 && (transitLeft -= wdt) <= 0) Object.assign(tau, LIVE[mode] || LIVE.orbit);

    // ── the follower ──
    // A single hitching frame during a 420-building cascade must not leave the
    // camera stranded halfway through a transition, so a very long step inside the
    // first 400 ms of a move snaps instead.
    if (wdt > .34 && fresh) copyGoal();
    else {
      c.az += (1 - Math.exp(-wdt / tau.az)) * wrapPi(g.az - c.az);   // short arc, always
      c.pol = approach(c.pol, clamp(g.pol, polLo(), polHi()), tau.pol, wdt);
      c.dist = approach(c.dist, g.dist, tau.dist, wdt);
      c.tx = approach(c.tx, g.tx, tau.t, wdt);
      c.ty = approach(c.ty, g.ty, tau.t, wdt);
      c.tz = approach(c.tz, g.tz, tau.t, wdt);
      c.fov = approach(c.fov, g.fov, tau.fov, wdt);
    }
    // This is a tray toy that runs for days, and the idle drift only ever adds:
    // rewind every azimuth by the same whole turns so the trig stays exact.
    if (c.az > 1e4 || c.az < -1e4) {
      const k = Math.round(c.az / TAU2) * TAU2;
      c.az -= k; g.az -= k; orb.az -= k; dragAz -= k; strollLook -= k;
    }
    moveK = Math.abs(wrapPi(g.az - c.az)) + Math.abs(g.pol - c.pol)
      + Math.abs(g.dist - c.dist) / 40 + Math.abs(g.tx - c.tx) / 40
      + Math.abs(g.ty - c.ty) / 40 + Math.abs(g.tz - c.tz) / 40
      + Math.abs(g.fov - c.fov) / 20;
    applyCam(now);
  }

  function applyCam(now) {
    // The founding ritual surveys the plat from further out and a little higher,
    // then eases to the working framing. Punch and the intro biases are ORBIT/TOUR
    // only — a milestone must not jerk the camera while a deed card is being read.
    const open = mode === 'orbit' || mode === 'tour';
    const bias = open ? dollyBias(isFinite(now) ? now : lastNow) * introMul * fitBias(c.az) : 1;
    const d = c.dist * bias;
    const p = clamp(c.pol + (mode === 'orbit' ? introPol : 0), polLo(), polHi());
    const y = Math.sin(p) * d, r = Math.cos(p) * d;
    effDist = d;
    focusPoint.set(c.tx, c.ty, c.tz);
    camera.position.set(c.tx + Math.sin(c.az) * r, c.ty + y, c.tz + Math.cos(c.az) * r);
    // THE HEAD BOB, and the only line applyCam owes the stroll. Its phase comes
    // from the DISTANCE WALKED, never from a frame count or a clock the feet do
    // not share, so it cannot drift out of step with the walk at any frame rate.
    // Rise on the double frequency, sway on the single — one full sway per stride
    // pair, which is what a pair of legs does. lookAt runs after, so each step
    // dips the horizon by a tenth of a degree instead of sliding the whole view.
    if (mode === 'stroll') {
      const ph = walk.s * (Math.PI / STROLL_STRIDE), sw = Math.sin(ph) * BOB_X;
      camera.position.y += Math.sin(ph * 2) * BOB_Y;
      camera.position.x += Math.cos(c.az) * sw;      // screen right, as in panBy
      camera.position.z -= Math.sin(c.az) * sw;
    }
    // THE SKY BEAT, AND THE ONLY LINE IT COSTS. The boom's own pitch below
    // horizontal is exactly `p`, so raising the LOOK POINT by
    //     d·(sin p − cos p·tan aim)
    // aims the camera at pitch `aim` from where it already stands: at k=0 the
    // lift is identically zero and nothing has happened, at k=1 the gaze has
    // blended onto `beatAim`. camera.position is never touched and focusPoint
    // keeps meaning what it means to everyone who reads it (interact's 'nobody
    // is about', town.js's sun target).
    const bk = beatK(isFinite(now) ? now : lastNow);
    if (bk > 0) {
      const aim = p * (1 - bk) + beatAim * bk;
      _look.set(focusPoint.x, focusPoint.y + d * (Math.sin(p) - Math.cos(p) * Math.tan(aim)), focusPoint.z);
      camera.lookAt(_look);
    } else camera.lookAt(focusPoint);
    // .5 is a fine near plane for a lens 60 units up; standing in a lane it slices
    // the villager who walks past you and the doorway you lean into. The town's
    // own value is restored the moment the mode ends — this is the only line in
    // the app that touches it after town.js builds the camera.
    const nr = mode === 'stroll' ? STROLL_NEAR : baseNear;
    // …and the beat's other half. `fv` IS `c.fov` whenever no beat is running, so
    // every other frame the app has ever drawn is unchanged to the bit.
    const fv = bk > 0 ? c.fov + (BEAT_FOV - c.fov) * bk : c.fov;
    if (camera.fov !== fv || camera.near !== nr) {
      camera.fov = fv; camera.near = nr; camera.updateProjectionMatrix();
    }
  }
  function copyGoal() {
    c.az = g.az; c.pol = clamp(g.pol, polLo(), polHi()); c.dist = g.dist;
    c.tx = g.tx; c.ty = g.ty; c.tz = g.tz; c.fov = g.fov;
  }
  function snap() { if (mode === 'orbit') writeOrbitGoal(); copyGoal(); vAz = vPol = 0; moveK = 0; applyCam(lastNow); }

  /** Ground point under a canvas-relative pixel. @returns {boolean} did it land */
  function screenToGround(px, py, out) {
    const r = rectOf(), w = r.width || 1, h = r.height || 1;
    // called from pointer handlers, i.e. between renders: the world matrix may be
    // one frame stale, and a wheel that lands 30 units off is a visible bug
    camera.updateMatrixWorld();
    _v.set((px / w) * 2 - 1, -(py / h) * 2 + 1, .5).unproject(camera);
    _dir.copy(_v).sub(camera.position);
    if (!(Math.abs(_dir.y) > 1e-6)) return false;
    _dir.normalize();
    let t = -camera.position.y / _dir.y;
    if (!(t > 0)) return false;
    let x = camera.position.x + _dir.x * t, z = camera.position.z + _dir.z * t, y = 0;
    if (sampleHeight) {                        // one refinement; terrain is flat inside flatR
      y = sampleHeight(x, z) || 0;
      if (y) {
        t = (y - camera.position.y) / _dir.y;
        if (t > 0) {
          x = camera.position.x + _dir.x * t; z = camera.position.z + _dir.z * t;
          y = sampleHeight(x, z) || 0;
        }
      }
    }
    if (out) out.set(x, y, z);
    return true;
  }

  /* ═══ teardown ══════════════════════════════════════════════════ */
  function reset() {
    // An epoch teardown must not leave you following a villager who is about to be
    // deleted — but it must not cancel a photo the user asked for either.
    const wasPhoto = mode === 'photo';
    followH = null; tourOn = false; shots = null; shotI = -1;
    userDist = false; panX = panZ = 0; vAz = vPol = 0; idleT = 0;
    dollyT = -1e9; introMul = 1; introPol = 0;
    // The walker's edge index is an ordinal into the OLD plan's graph; a new epoch
    // renumbers it. Forget the walk rather than resume it somewhere else entirely.
    walk.ei = -1; walk.free = false; walk.s = 0; walk.ox = walk.oz = walk.off = 0;
    walk.y = 0;                                       // …and nobody is left standing on yesterday's bridge
    nearWalls.length = 0; nearWallsAt = -1e9;
    deckPlan = null; deckMap.clear();                 // edge ordinals are renumbered too
    strollFov = FOV.stroll;
    beatOn = false; beatCutAt = -1e9; beatCutK = 0;   // yesterday's milestone, not today's sky
    orbit({ snap: true });
    loadMarks();
    if (wasPhoto) { photo(true); snap(); }
  }
  function dispose() {
    if (canvas) {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('contextmenu', onCtx);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, true);
    }
    shots = null; followH = null; rect = null;
    marks.fill(null);
    nearWalls.length = 0; walk.ei = -1;
    deckPlan = null; deckMap.clear();
    // Hand the near plane back exactly as town.js built it: a shutdown that left
    // .28 behind would change the depth precision of whatever renders next.
    if (camera.near !== baseNear) { camera.near = baseNear; camera.updateProjectionMatrix(); }
  }

  loadMarks();
  lastInputAt = lastNow;
  setFrame(null, monTop);
  writeOrbitGoal(); snap();

  /** @type {CameraRig} */
  const rig = {
    get mode() { return mode; },
    get dist() { return effDist; },
    // Standing in a street with fogFor(11) is standing in soup: fogFor(10) is
    // already near the density cap. The clamp is the difference between "a street"
    // and "a fog bank", and it never touches the wide modes, whose fog is v3's.
    get fogDist() {
      return (mode === 'focus' || mode === 'follow' || mode === 'photo' || mode === 'stroll')
        ? Math.max(effDist, STROLL_FOG) : effDist;
    },
    /** How far the WORLD should read, as against how far the camera stands off
     *  its subject. They are the same number in every mode where the camera looks
     *  AT something — and nothing like each other on foot, where `dist` is a
     *  9-unit look-length and the town still runs to the edge of the plat. Read
     *  this for anything sized to the DRAW DISTANCE (surface.js's far fade);
     *  read `dist` for anything sized to the SUBJECT (audio's trim, particles).
     *  Identical to `dist` outside the stroll, so swapping a call site is free. */
    get viewDist() { return mode === 'stroll' ? strollViewD : effDist; },
    get focusPoint() { return focusPoint; },
    get shadowCenter() {
      // stroll rides the LOOK POINT, not the feet: half a frustum centred on your
      // own shoes is spent behind you, and the shadows worth having are the ones
      // falling across the street ahead.
      if (mode === 'follow' || mode === 'focus' || mode === 'stroll') shadowCenter.set(focusPoint.x, 0, focusPoint.z);
      else shadowCenter.set(bnd.cx, 0, bnd.cz);
      return shadowCenter;
    },
    get shadowExtent() {
      return mode === 'stroll' ? STROLL_SHADOW : mode === 'follow' ? 34
        : mode === 'focus' ? 48 : Math.min(bnd.r, 62) + 12;
    },
    // A stroll is ALWAYS moving — that is what walking is — and town.js's 84 ms
    // gate is what turns that into the 12 Hz shadow re-arm this mode needs. The
    // follower's moveK settles below MOVE_EPS at a constant 1.35 u/s, so without
    // this the shadow map would freeze while the walker kept going.
    get moving() { return mode === 'stroll' || dragging || tourOn || moveK > MOVE_EPS || vAz !== 0 || vPol !== 0; },
    get dragging() { return dragging; },
    get dragPx() { return dragPx; },
    get userDist() { return userDist; },
    get idleMs() { return Math.max(0, lastNow - lastInputAt); },
    get shot() { return (mode === 'tour' && shots) ? shots[shotI] || null : null; },
    get caption() { return caption; },
    setFrame,
    setIntroBias(distMul, polAdd) {
      introMul = isFinite(distMul) && distMul > 0 ? distMul : 1;
      introPol = isFinite(polAdd) ? polAdd : 0;
    },
    punch(strength, ms) {
      if (userDist) return;                    // the user framed this shot; leave it alone
      dollyK = isFinite(strength) && strength > 0 ? strength : .13;
      dollyMs = isFinite(ms) && ms > 0 ? ms : 1800;
      dollyT = lastNow;
    },
    snap,
    /** Bench only. `cam` = [az, pol, dist] pins the shot exactly; null/undefined
     *  freezes the idle drift and leaves auto-framing alone. Idempotent. */
    pin(cam) {
      pinned = true;
      if (cam && cam.length === 3) {
        orbit();
        orb.az = cam[0]; orb.pol = clamp(cam[1], POL_MIN, POL_MAX);
        orb.userD = cam[2]; userDist = true; userDistAtR = Infinity;
        lastWheel = lastNow;
      }
      snap();
    },
    /** Who follow() is watching, or null. interact.js's mode pill names them. */
    get followHandle() { return mode === 'follow' ? followH : null; },
    /** Is a sky beat armed or running? (The `--cam=beat` hook and the bench.) */
    get beating() { return beatOn; },
    orbit, focus, follow, tour, photo, stroll, walkTo, bookmark, jumpTo, beat,
    screenToGround, update, reset, dispose
  };
  return rig;
}
