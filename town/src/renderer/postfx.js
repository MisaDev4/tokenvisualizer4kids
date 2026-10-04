// Token Town — the photographic pipeline. postfx owns THE IMAGE. The scene is
// rendered into an HDR buffer and everything after that is a decision about what
// a *photograph* of this town looks like: exposure, a tone curve with a real
// shoulder, two octaves of bloom, lift/gain, saturation, contrast, an
// aspect-correct vignette and a tilt-shift band. Nothing in here knows what a
// building is.
//
// WHY A RENDER TARGET AT ALL. r160 disables tone mapping and forces
// LinearSRGBColorSpace output whenever a render target is bound
// (vendor/three.module.js:20716-20726 and :20753). So the scene pass lands raw
// linear in the buffer for free, and the composite triangle — which draws to the
// default framebuffer — is the ONE place the curve and the sRGB OETF happen. No
// double encoding, no fighting the engine. The corollary: the app's raw
// ShaderMaterials (sky dome, veil, motes, the monument's additives) which write
// gl_FragColor with no <colorspace_fragment> stop bypassing output encoding by
// accident and get encoded exactly once. Their stops need a re-tune; that is a
// number, not a bug, and it belongs to the sky owner.
//
//   THAT DEBT IS NOW VISIBLE, AND IT IS THE MOTES. environs.js §8 draws 240
//   additive point sprites whose texture is a radial gradient running alpha 1 at
//   the centre to 0 at the rim (environs.js:554 mkMoteTex, :1469-1511), at
//   uMoteDay = 0.30 by day (:1995) and a size of 260/|z| screen units (:1496).
//   Written straight to an 8-bit sRGB framebuffer — which is what happened before
//   this file existed, and what still happens under --post=off — everything below
//   about alpha 0.1 sat under the display noise floor and each sprite read as a
//   small hard dot. Written LINEAR into the HDR buffer and then encoded once by
//   townOETF, the gamma lifts that whole soft tail into view: the same sprite
//   becomes a 30-90 px soft cream disc, and a dozen of them drifting across a
//   clear midday read as a dirty lens rather than as pollen. A/B it with
//   --post=off and the dots are in both frames — they are SCENE, not grade.
//   The fix is one number in environs (uMoteDay to roughly a fifth of its
//   present value, and/or a ceiling on gl_PointSize) and it is the sky owner's
//   to make. postfx must NOT special-case a scene object out of the grade: that
//   is the layering violation this file exists to avoid.
//
// THE LAYERING LAW (v4-BACKLOG §4.2, binding): weather grades the SCENE (light
// intensities, fog density and colour, sky uniforms, star opacity); postfx grades
// the IMAGE. Neither reads the other. town.js applies weather first, then hands
// us a Grade.
//
// PURITY. Every uniform here is a pure function of the Grade it was handed and
// of where the camera is standing (see THE LENS below); postfx NEVER
// accumulates. That is what makes a 3 fps headless screenshot show exactly the
// grade a 60 fps interactive frame shows. The one piece of retained state is the
// frame-time ring used by the auto-downgrade, and that is gated on a FRAME
// COUNT, never a wall-clock timer — a --shot run sees 300 ms frames and a timer
// would silently downgrade it, invalidating every verification image.
//
// PUBLIC SURFACE
//   initPost(renderer, scene, camera, {quality:'high'|'med'|'off', headless, auto})
//     → { render(now), setSize(w,h), setGrade(g), setQuality(q),
//         quality, enabled, reset(), dispose() }
//   gradeFor(day, night, glowK, heat, out) → Grade    PURE
//   makeGrade() → Grade                               a scratch Grade for town.js
//   heatOf(ctx) → 0..1                                prosperity heat, PURE
//
// COST (2560×1690, budget in v4-lookdev §6). CPU is uniform writes only — there
// are ZERO allocations in render/setGrade/gradeFor. Draw counts are TOTAL passes
// per frame, the scene included (i.e. one is what the app costs today):
//   high  10 passes ≈ 1.4 ms GPU   scene(MSAA HDR) · bright ¼ · blur ×2 ¼ ·
//                                  blur ×2 ⅛ · copy ½ · blur ×2 ½ · composite
//                                  7 whenever the band is off. This used to be
//                                  annotated "(night framing)" and was never
//                                  once true: ANCHOR.night.tilt is 0.18, not 0,
//                                  so the tilt chain ran in every frame at every
//                                  hour. It is reachable now — THE LENS zeroes
//                                  the band at street level, so the ground-level
//                                  framings are the seven-pass case.
//   med    5 passes ≈ 0.9 ms       one bloom octave, no tilt
//   off    1 pass                  renderer.render() under ACESFilmic; no targets
//                                  exist at all, so this tier costs no memory
//   VRAM at 'high', 2560×1800 half-float: ~35 MB scene, ~4 MB bloom, ~9 MB tilt.
//
// WHAT THE INTEGRATION WAVE MUST WIRE (town.js — one import and five hunks):
//   import { initPost, gradeFor, makeGrade, heatOf } from './postfx.js';
//   ~:195 (after renderer/scene/camera exist)
//        const post  = initPost(renderer, scene, camera,
//                        { quality: Q.get('post') || 'high', headless: IS_SHOT });
//        const _grade = makeGrade();          // one scratch object, forever
//   ~:1928 resize()      post.setSize(w, h);          // CSS px, same w/h renderer got
//   ~:2202 tick()        gradeFor(day, night, glowK, heatOf(ctx), _grade);
//                        post.setGrade(_grade);
//   ~:2203               renderer.render(scene, camera)  →  post.render(now);
//        hardReset()     post.reset();        (registered in F1's teardown list)
//        shutdown        post.dispose();
//   Add 'post' to the Q vocabulary (town.js:141) and --post= to main.js's
//   forwarded flags, so the whole feature is one URL flag from being ruled out.
//
//   TWO THINGS THAT WILL BITE THE INTEGRATOR IF THEY ARE MISSED:
//   1. postfx sets renderer.info.autoReset = false and resets the counters itself
//      at the top of render(). It has to: three resets info inside EVERY
//      render() call (three.module.js:29600), so with six passes a frame the
//      bench would only ever see the composite's one draw. Read renderer.info
//      AFTER post.render(); never call info.reset() elsewhere.
//   2. L1b's light rebalance ships with this (sun ×2.35, hemi .11+.30·day). The
//      curve is authored against a key that exceeds 1.0 linear on lit plaster; on
//      the old 1.45 key noon comes out flat and dim, which reads as "post is
//      broken" when it is the lighting that has not landed yet.
//
//   The vignette handshake is automatic: while a target tier is live postfx sets
//   the page's --vig custom property to 0 (and re-asserts it at 2 Hz, because
//   environs rewrites it whenever its own value moves — environs.js:1504), and
//   releases it on 'off'/dispose(). environs needs no change.
import * as THREE from './vendor/three.module.js';

/* ═══ helpers ═══════════════════════════════════════════════════ */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const num = (v, d) => (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : d;
/** noon → golden → night, the two-step blend from v4-lookdev §1c. */
const tri = (a, b, c, tg, tn) => { const m = a + (b - a) * tg; return m + (c - m) * tn; };
const QUALITIES = ['off', 'med', 'high'];
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

/* ═══ the grade ═════════════════════════════════════════════════
   Three anchors, blended continuously, so nothing pops at 17:59. The story the
   numbers tell: noon is neutral and crisp; golden hour is warm in the highlights
   AND warm in the shadows; night is cool in the shadows and cold in the
   highlights except where the town's own light overrides it. */

/**
 * @typedef {Object} Grade
 * @property {number} exposure     linear multiply before the curve        0.6 .. 1.8
 * @property {number} contrast     about a 0.5 pivot, after the curve      0.85 .. 1.30
 * @property {number} saturation   after the curve                         0.80 .. 1.35
 * @property {THREE.Color} lift    added in linear (shadow tint)           0 .. 0.02
 * @property {THREE.Color} gain    multiplied in linear (highlight tint)   0.85 .. 1.15
 * @property {number} bloom        composite strength                      0 .. 1.4
 * @property {number} bloomThresh  linear bright-pass knee centre          0.5 .. 1.6
 * @property {number} vignette     corner darkening, display space         0 .. 0.55
 * @property {number} tilt         tilt-shift blur amount                  0 .. 1
 * @property {number} tiltCenter   screen-y of the sharp band, 0 = top     0 .. 1
 * @property {number} tiltWidth    half-height of the sharp band           0.1 .. 0.6
 */

// THESE NUMBERS ARE AUTHORED AGAINST DISPLAY-SPACE OPERATORS. Saturation,
// contrast and the vignette now run after townOETF, which changes what every one
// of them means:
//   contrast   is the SLOPE AT MID-GREY of a power S that cannot clip. The old
//              1.05-1.10 was a timid setting for a clipping operator; the same
//              picture needs ~1.3 here to open the same amount of separation, and
//              pushing it costs shadow detail rather than destroying it.
//   vignette   bites proportionally harder on display values than it did on
//              linear ones, so every anchor comes down by about a fifth.
//   gain       no longer risks hue-locking the frame (a channel that reaches zero
//              stays a colour instead of clipping), but a 0.885 blue cut at golden
//              was drawn to fight a problem that no longer exists — softened.
const ANCHOR = {
  noon: {
    exposure: 1.10, contrast: 1.32, saturation: 1.06, bloom: 0.26, bloomThresh: 1.22,
    vignette: 0.18, tilt: 0.30, lift: [0.000, 0.000, 0.000], gain: [1.000, 0.998, 0.988]
  },
  golden: {
    exposure: 1.18, contrast: 1.26, saturation: 1.12, bloom: 0.58, bloomThresh: 1.00,
    vignette: 0.24, tilt: 0.30, lift: [0.005, 0.002, 0.000], gain: [1.048, 0.990, 0.932]
  },
  // Night wants MORE contrast than it used to, not less. Under the old linear
  // operator k = 1.16 clamped everything below display level 60 to bit zero and a
  // clear midnight came back 88.7% pure black — an altar and a field of windows
  // floating in a void with no town under them. The power S has no black point at
  // all: 0 stays 0 and the toe only steepens, so the silhouettes survive a setting
  // that would have erased them. Exposure carries the lit windows to a real
  // highlight instead of the curve's midtones.
  night: {
    exposure: 1.52, contrast: 1.14, saturation: 0.96, bloom: 1.00, bloomThresh: 0.70,
    vignette: 0.32, tilt: 0.18, lift: [0.000, 0.004, 0.012], gain: [0.900, 0.945, 1.105]
  }
};

/**
 * Mint a Grade. town.js keeps exactly ONE of these and passes it to `gradeFor`
 * every frame — a per-epoch cache would carry the old town's heat across a range
 * switch (v4-lookdev §8.7).
 * @returns {Grade}
 */
export function makeGrade() {
  return {
    exposure: 1, contrast: 1, saturation: 1,
    lift: new THREE.Color(0, 0, 0), gain: new THREE.Color(1, 1, 1),
    bloom: 0.2, bloomThresh: 1.3, vignette: 0.22,
    tilt: 0.3, tiltCenter: 0.5, tiltWidth: 0.2
  };
}

// town.js:70 — kept byte-identical on purpose: the heat curve and the footer's
// Prosperity numeral must agree about how rich the day is.
const prosperity = T => Math.max(0, 1.15 * Math.log10(Math.max(T, 1) / 2e5));

/**
 * The picture is a progress bar (v4-lookdev L13). Rich days literally look
 * richer — more saturation, more bloom, more contrast, a warmer gain. Pure, and
 * derived from `ctx` alone, so a headless shot at a given total always grades
 * identically. Null-safe: no ctx ⇒ 0 ⇒ the plain day-part grade.
 * @param {{totalTok?:number, paceRatio?:number}} [ctx]
 * @returns {number} 0..1
 */
export function heatOf(ctx) {
  if (!ctx) return 0;
  const p = clamp((prosperity(num(ctx.totalTok, 0)) - 1) / 6, 0, 1);
  const pace = clamp((num(ctx.paceRatio, 1) - 0.8) / 1.6, 0, 1);
  return clamp(p * 0.65 + pace * 0.35, 0, 1);
}

/**
 * Fill `out` from the day-part. PURE: same inputs → same Grade, no accumulation,
 * no allocation when `out` is a live Grade.
 *
 * Writes exactly the ten day-part fields and DELIBERATELY leaves `tiltCenter` /
 * `tiltWidth` alone: where the sharp band sits is a framing decision (it tracks
 * the monument's NDC y), not a function of the hour. town.js sets them on the
 * scratch after this call and before `setGrade`.
 *
 * @param {number} day 0..1 @param {number} night 0..1
 * @param {number} glowK 0..1 golden-hour weight (town.js:1950)
 * @param {number} heat 0..1 see heatOf
 * @param {Grade} [out]
 * @returns {Grade} out
 */
export function gradeFor(day, night, glowK, heat, out) {
  const g = out || makeGrade();
  if (!g.lift || g.lift.r === undefined) g.lift = new THREE.Color(0, 0, 0);
  if (!g.gain || g.gain.r === undefined) g.gain = new THREE.Color(1, 1, 1);
  const tg = clamp(num(glowK, 0), 0, 1);
  // `day` is the fallback axis: a caller that only has daylight still gets a
  // sane night blend instead of a permanent noon.
  const tn = clamp(num(night, 1 - num(day, 1)), 0, 1);
  const h = clamp(num(heat, 0), 0, 1);
  const A = ANCHOR.noon, B = ANCHOR.golden, C = ANCHOR.night;

  // HEAT IS ~2.5× WHAT IT WAS. The old term bought +0.085 saturation across the
  // whole 10M→50B range, which is an order of magnitude smaller than the change
  // the scene itself makes over that sweep (more distant town, more impostors,
  // more aerial haze, more grey roof area all pull the same statistic the other
  // way). Measured on a fixed seed/hour/weather it was invisible — the picture got
  // LESS saturated as the town got richer. At this strength the term is visible
  // side by side. It is NOT 2.5x, though, and the first attempt at that was worse
  // than the original: at a 15.76B day the warm gain and the extra saturation
  // together turned a green meadow into a dust bowl with green edges, which is a
  // colour-harmony break that reads as a bug rather than as prosperity. ~1.5x is
  // where it is visible in an A/B and still a seasoning on the frame. Being honest
  // about the ceiling: the thing that tells you the day went well is the monument,
  // the ledger and the badges — they are unambiguous, and this is atmosphere.
  g.exposure = tri(A.exposure, B.exposure, C.exposure, tg, tn) + 0.030 * h;
  g.contrast = tri(A.contrast, B.contrast, C.contrast, tg, tn) + 0.090 * h;
  g.saturation = Math.min(tri(A.saturation, B.saturation, C.saturation, tg, tn) + 0.130 * h, 1.28);
  g.bloom = Math.min(tri(A.bloom, B.bloom, C.bloom, tg, tn) + 0.26 * h, 1.30);
  g.bloomThresh = tri(A.bloomThresh, B.bloomThresh, C.bloomThresh, tg, tn);
  g.vignette = tri(A.vignette, B.vignette, C.vignette, tg, tn);
  g.tilt = tri(A.tilt, B.tilt, C.tilt, tg, tn);
  g.lift.setRGB(
    tri(A.lift[0], B.lift[0], C.lift[0], tg, tn),
    tri(A.lift[1], B.lift[1], C.lift[1], tg, tn),
    tri(A.lift[2], B.lift[2], C.lift[2], tg, tn));
  // heat warms the highlights: +red, -blue. Ceilinged with the two clamps above
  // so a 1B day cannot go neon.
  g.gain.setRGB(
    tri(A.gain[0], B.gain[0], C.gain[0], tg, tn) + 0.032 * h,
    tri(A.gain[1], B.gain[1], C.gain[1], tg, tn) + 0.006 * h,
    tri(A.gain[2], B.gain[2], C.gain[2], tg, tn) - 0.020 * h);
  return g;
}

/* ═══ shaders ═══════════════════════════════════════════════════ */

// One triangle, not a quad: no clip-space matrices and no diagonal seam through
// the middle of the blur.
const VERT = `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Karis soft-knee bright pass at 1/4 res. The 6.0 clamp is NOT optional: the
// monument's tier-10 emissive and the additive particle pools produce single
// texels in the tens, and one of those becomes a 64 px star across the frame.
const BRIGHT_FRAG = `uniform sampler2D tScene; uniform float uThresh; uniform float uKnee;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tScene, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float s = clamp(br - uThresh + uKnee, 0.0, 2.0 * uKnee);
  s = s * s / (4.0 * uKnee + 1e-4);
  float k = max(s, br - uThresh) / max(br, 1e-4);
  gl_FragColor = vec4(min(c * k, vec3(6.0)), 1.0);
}`;

// 5-tap linear-sampled gaussian, sigma ~2 texels, one axis per pass. uDir is in
// the DESTINATION's texel size, which is what widens the second octave.
const BLUR_FRAG = `uniform sampler2D tSrc; uniform vec2 uDir;
varying vec2 vUv;
const float O1 = 1.3846153846, O2 = 3.2307692308;
const float W0 = 0.2270270270, W1 = 0.3162162162, W2 = 0.0702702703;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * W0;
  c += (texture2D(tSrc, vUv + uDir * O1).rgb + texture2D(tSrc, vUv - uDir * O1).rgb) * W1;
  c += (texture2D(tSrc, vUv + uDir * O2).rgb + texture2D(tSrc, vUv - uDir * O2).rgb) * W2;
  gl_FragColor = vec4(c, 1.0);
}`;

// Full → half res. With LinearFilter and an exact 2× ratio the single tap lands
// on the corner of four texels, so bilinear gives a clean 2×2 box for free.
const COPY_FRAG = `uniform sampler2D tSrc; varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`;

const COMP_FRAG = `
#include <common>
#include <dithering_pars_fragment>
uniform sampler2D tScene;
uniform sampler2D tBloom4;
uniform vec2 uBloomW;
uniform float uBloom, uExposure, uSaturation, uContrast, uVignette, uAspect;
uniform vec3 uLift, uGain;
#ifdef BLOOM2
  uniform sampler2D tBloom8;
#endif
#ifdef TILT
  uniform sampler2D tTilt;
  uniform float uTilt, uTiltCenter, uTiltWidth;
#endif
#ifdef FXAA
  uniform vec2 uTexel;
#endif
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// THE OETF, done by hand. This pass used to end on an #include <colorspace_fragment>
// and run saturation, contrast and the vignette BEFORE it — i.e. three display
// operators applied to linear light. (c - 0.5) * k + 0.5 in linear pivots on
// linear 0.5, which is sRGB 188, so at k = 1.10 the black point landed at linear
// 0.0455 = display level 60 and everything below it clamped to bit zero. A clear
// midnight measured 88.7% pure-black pixels against 0.0% with the pass switched
// off: the ground, the roads and the river did not exist as pixels. The same
// arithmetic run per channel is also what hue-locked the warm hours — the weakest
// channel hit the black point first, so a 20:00 sky read rgb(42, 0.8, 0.6).
// Encoding here and grading after costs one pow and fixes both.
vec3 townOETF(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92,
             vec3(lessThanEqual(c, vec3(0.0031308))));
}

// A pivoted contrast that ROLLS instead of clipping. (x - 0.5) * k + 0.5 has to
// be clamped at both ends, which is a shadow crusher wearing a contrast control's
// name; this is the symmetric power S — 0 stays 0, 1 stays 1, the slope at mid-grey
// is k, and no value can leave [0,1] no matter how hard k is pushed.
vec3 townContrast(vec3 c, float k) {
  vec3 s = step(vec3(0.5), c);
  vec3 t = pow(clamp(mix(2.0 * c, 2.0 - 2.0 * c, s), 0.0, 1.0), vec3(k)) * 0.5;
  return mix(t, 1.0 - t, s);
}
// ACES works in its own middle grey. three's ACESFilmicToneMapping chunk carries
// a "color *= toneMappingExposure / 0.6" for exactly this reason, and dropping it
// costs almost two stops in the midtones: bare, the fit puts 0.18 at 0.106 and
// 1.0 at 0.62 — i.e. it would leave the picture darker than the flat pipeline
// this whole file exists to replace. It also keeps the 'off' fallback tier
// (three's own ACES) and the 'high' tier agreeing about what middle grey is, so
// switching quality is not a two-stop cut.
const float ACES_GREY = 1.6666667;
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

// Our own curve, not renderer.toneMapping's chunk, so the sanity anchors mean
// something: townFilmic(0.18) = 0.213, (1.0) = 0.763, (4.0) = 0.952. Middle grey
// stays put, a fully lit plaster wall lands near 0.8 and still has somewhere to
// go, and the monument at 4x overdrive rolls instead of clipping.
vec3 townFilmic(vec3 x) {
  x = max(x, vec3(0.0)) * ACES_GREY;
  vec3 c = ACES_IN * x;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  c = clamp(ACES_OUT * (a / b), 0.0, 1.0);
  // Hue-preserving chroma restore. The RRT fit desaturates ~14% at the shoulder,
  // which turns a terracotta roof in sunlight into a beige roof in sunlight —
  // fatal for a palette whose primaries are Terracotta, Ochre and Saffron.
  float post = dot(c, LUMA);
  float k = 1.0 + 0.34 * smoothstep(0.35, 1.0, post);
  return clamp(mix(vec3(post), c, k), 0.0, 1.0);
}

#ifdef FXAA
// Only compiled when the scene target could not get MSAA (WebGL1). Losing
// antialiasing silently on a town made entirely of straight roof edges would be
// a visible regression, so this is insurance, not decoration. Luma is measured
// on a Reinhard-compressed sample because the buffer is HDR and a fixed
// threshold against unbounded values is meaningless.
float fxLuma(vec3 c) { return dot(c / (c + vec3(1.0)), vec3(0.299, 0.587, 0.114)); }
vec3 fxaaScene(vec2 uv) {
  vec3 mC = texture2D(tScene, uv).rgb;
  float lNW = fxLuma(texture2D(tScene, uv + vec2(-1.0, -1.0) * uTexel).rgb);
  float lNE = fxLuma(texture2D(tScene, uv + vec2( 1.0, -1.0) * uTexel).rgb);
  float lSW = fxLuma(texture2D(tScene, uv + vec2(-1.0,  1.0) * uTexel).rgb);
  float lSE = fxLuma(texture2D(tScene, uv + vec2( 1.0,  1.0) * uTexel).rgb);
  float lM  = fxLuma(mC);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return mC;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture2D(tScene, uv + dir * -0.1666667).rgb +
                  texture2D(tScene, uv + dir *  0.1666667).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tScene, uv + dir * -0.5).rgb +
                             texture2D(tScene, uv + dir *  0.5).rgb);
  float lB = fxLuma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}
#endif

void main() {
  #ifdef FXAA
    vec3 c = fxaaScene(vUv);
  #else
    vec3 c = texture2D(tScene, vUv).rgb;
  #endif

  // (b) tilt-shift, still HDR. Applied BEFORE the bloom add on purpose: a
  // blurred lit window must still contribute a crisp bloom kernel, or the
  // out-of-focus parts of the town lose their lights and read as broken rather
  // than as shallow depth of field.
  #ifdef TILT
    float td = abs(vUv.y - uTiltCenter);
    c = mix(c, texture2D(tTilt, vUv).rgb, smoothstep(uTiltWidth, uTiltWidth + 0.26, td) * uTilt);
  #endif

  // (c) bloom, HDR. Two octaves at 0.62/0.38 is the difference between "the
  // windows glow" and "the town has a haze over it".
  vec3 bl = texture2D(tBloom4, vUv).rgb * uBloomW.x;
  #ifdef BLOOM2
    bl += texture2D(tBloom8, vUv).rgb * uBloomW.y;
  #endif
  c += bl * uBloom;

  c *= uExposure;                       // (d)
  c = c * uGain + uLift;                // (e) lift/gain, linear
  c = townFilmic(c);                    // (f) the curve -> [0,1], still LINEAR

  // ── the line between light and picture ──────────────────────────
  c = townOETF(c);                      // (g) linear -> display

  // (h) saturation, now on bounded display values: the extrapolation cannot drive
  // a channel negative, so a warm hour desaturates towards grey instead of
  // clipping its blue to zero and hue-locking the frame.
  c = clamp(mix(vec3(dot(c, LUMA)), c, uSaturation), 0.0, 1.0);
  c = townContrast(c, uContrast);       // (i) display-space, non-clipping

  // (j) vignette, aspect-corrected — the CSS one is not, so on a wide window it
  // pinches top and bottom before the sides. Display space, so it darkens
  // proportionally rather than eating two stops out of the corners.
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  c *= 1.0 - uVignette * pow(clamp(length(q) * 1.32 - 0.34, 0.0, 1.0), 1.6);

  // NO <colorspace_fragment>: townOETF already encoded. Dithering stays last,
  // where it belongs — it is display-space noise against 8-bit banding.
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  #include <dithering_fragment>
}`;

/* ═══ the null object (§3): no renderer ⇒ nothing to draw with ═══ */
const NOOP = () => { };
const NULL_POST = Object.freeze({
  render: NOOP, setSize: NOOP, setGrade: NOOP, setQuality: NOOP, reset: NOOP, dispose: NOOP,
  quality: 'off', enabled: false
});

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{quality?:'high'|'med'|'off', headless?:boolean, auto?:boolean}} [opts]
 *        headless — a --shot/--bench run: pins the tier, so a verification image
 *        is never graded differently from an interactive frame.
 *        auto — set false to pin the tier for any other reason.
 */
export function initPost(renderer, scene, camera, opts = {}) {
  if (!renderer || typeof renderer.setRenderTarget !== 'function') return NULL_POST;

  const isWebGL2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
  const info = renderer.info || null;
  // PINNED IN HEADLESS, AND SAID OUT LOUD. Pinning is right — a verification image
  // has to be deterministic — but it also guarantees every --shot run is graded at
  // the tier the flag asked for while a real session may have dropped to 'med' or
  // 'off', and the bottom rung flips setSkyEncoding() so 'off' is a different
  // colour space, not just fewer passes. A pin nobody can see is a mismatch; a pin
  // that announces itself is a control. --post=off|med|high shoots the others.
  const autoAllowed = !opts.headless && opts.auto !== false;
  let quality = QUALITIES.indexOf(opts.quality) >= 0 ? opts.quality : 'high';
  let disposed = false;

  // Restored verbatim on dispose(): postfx is a guest in this renderer.
  const savedToneMapping = renderer.toneMapping;
  const savedExposure = renderer.toneMappingExposure;
  const savedAutoReset = info ? info.autoReset : true;

  /* ── the fullscreen triangle, its camera and its private scene ── */
  const triGeo = new THREE.BufferGeometry();
  triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  triGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  triGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  quadScene.matrixWorldAutoUpdate = false;   // one static mesh; nothing ever moves
  const quad = new THREE.Mesh(triGeo, null);
  quad.frustumCulled = false; quad.matrixAutoUpdate = false;
  quadScene.add(quad);
  quadScene.updateMatrixWorld(true);

  const pass = (frag, uniforms, extra) => new THREE.ShaderMaterial(Object.assign({
    uniforms, vertexShader: VERT, fragmentShader: frag,
    depthTest: false, depthWrite: false, toneMapped: false, fog: false
  }, extra));

  const brightU = { tScene: { value: null }, uThresh: { value: 1.3 }, uKnee: { value: 0.45 } };
  const blurU = { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } };
  const copyU = { tSrc: { value: null } };
  const compU = {
    tScene: { value: null }, tBloom4: { value: null }, tBloom8: { value: null }, tTilt: { value: null },
    uBloomW: { value: new THREE.Vector2(0.62, 0.38) },
    uBloom: { value: 0.2 }, uExposure: { value: 1 }, uSaturation: { value: 1 }, uContrast: { value: 1 },
    uVignette: { value: 0.22 }, uAspect: { value: 1 },
    uLift: { value: new THREE.Color(0, 0, 0) }, uGain: { value: new THREE.Color(1, 1, 1) },
    uTilt: { value: 0.3 }, uTiltCenter: { value: 0.5 }, uTiltWidth: { value: 0.2 },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) }
  };
  const brightMat = pass(BRIGHT_FRAG, brightU);
  const blurMat = pass(BLUR_FRAG, blurU);
  const copyMat = pass(COPY_FRAG, copyU);
  // `dithering` is what emits #define DITHERING for <dithering_pars_fragment>;
  // <common> above it carries the rand() the chunk needs. One define kills the
  // 8-bit banding across a 2700 px sky gradient.
  const compMat = pass(COMP_FRAG, compU, { defines: {}, dithering: true });

  /* ── render targets ───────────────────────────────────────────
     Sizing is capped twice: the pixel ratio at 1.75 and the pixel count at
     ~2560×1800. This is where memory goes wrong on a 4K display. */
  let W = 2, H = 2, w2 = 2, h2 = 2, w4 = 2, h4 = 2, w8 = 2, h8 = 2;
  let rtScene = null, rtB4 = null, rtT4 = null, rtB8 = null, rtT8 = null, rtHalf = null, rtHalfB = null;
  const _sz = [2, 2];

  function targetSize(w, h, out) {
    const s = Math.min(renderer.getPixelRatio ? renderer.getPixelRatio() : 1, 1.75);
    let Wp = Math.max(2, Math.round(w * s)), Hp = Math.max(2, Math.round(h * s));
    const CAP = 4.6e6;
    if (Wp * Hp > CAP) {
      const k = Math.sqrt(CAP / (Wp * Hp));
      Wp = Math.max(2, Math.round(Wp * k)); Hp = Math.max(2, Math.round(Hp * k));
    }
    out[0] = Wp; out[1] = Hp;
  }
  const sub = (v, d) => Math.max(2, Math.round(v / d));

  function makeRT(w, h, depth, samples) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: depth, stencilBuffer: false, samples
    });
  }
  // A target that has never been bound has no GL texture behind it, and the
  // composite samples tTilt/tBloom8 unconditionally once their define is on.
  // One clear at allocation time makes every sampler legal from frame one.
  function prime(rt) {
    if (!rt || typeof renderer.clear !== 'function') return;
    renderer.setRenderTarget(rt); renderer.clear(); renderer.setRenderTarget(null);
  }
  function fit(rt, w, h, depth, samples) {
    if (!rt) { const n = makeRT(w, h, depth, samples); prime(n); return n; }
    if (rt.width !== w || rt.height !== h) { rt.setSize(w, h); prime(rt); }
    return rt;
  }
  const drop = rt => { if (rt) rt.dispose(); return null; };

  function rebuild() {
    if (disposed) return;
    if (quality === 'off') { freeAll(); return; }
    // MSAA on the render target is what buys back the antialias:true we lose by
    // not drawing the scene to the canvas. WebGL1 ignores `samples`, so the
    // composite compiles its FXAA branch instead (§9.3).
    rtScene = fit(rtScene, W, H, true, isWebGL2 ? 4 : 0);
    rtB4 = fit(rtB4, w4, h4, false, 0);
    rtT4 = fit(rtT4, w4, h4, false, 0);
    if (quality === 'high') {
      rtB8 = fit(rtB8, w8, h8, false, 0);
      rtT8 = fit(rtT8, w8, h8, false, 0);
      rtHalf = fit(rtHalf, w2, h2, false, 0);
      rtHalfB = fit(rtHalfB, w2, h2, false, 0);
    } else {
      rtB8 = drop(rtB8); rtT8 = drop(rtT8);
      rtHalf = drop(rtHalf); rtHalfB = drop(rtHalfB);
    }
    syncDefines();
  }
  function freeAll() {
    rtScene = drop(rtScene); rtB4 = drop(rtB4); rtT4 = drop(rtT4);
    rtB8 = drop(rtB8); rtT8 = drop(rtT8); rtHalf = drop(rtHalf); rtHalfB = drop(rtHalfB);
  }

  let defState = -1;
  function syncDefines() {
    const hi = quality === 'high';
    const want = (hi ? 3 : 0) | (isWebGL2 ? 0 : 4);
    if (want === defState) return;
    defState = want;
    const d = compMat.defines;
    if (hi) { d.BLOOM2 = ''; d.TILT = ''; } else { delete d.BLOOM2; delete d.TILT; }
    if (isWebGL2) delete d.FXAA; else d.FXAA = '';
    // one octave has to carry the whole bloom, or 'med' would read 38 % dimmer
    compU.uBloomW.value.set(hi ? 0.62 : 1.0, hi ? 0.38 : 0.0);
    compMat.needsUpdate = true;
  }

  /* ── the vignette handshake (v4-lookdev L3) ─────────────────── */
  // ONE WRITER, AND IT IS INSPECTABLE. The previous arrangement was a polling
  // truce: environs wrote --vig on its own ≤4 Hz timer and postfx re-asserted '0'
  // at 2 Hz on top, so while `night` was ramping at dawn or dusk both were live
  // and the CSS vignette multiplied with the in-shader one for up to half a second
  // at a time. Now postfx takes the property ONCE and publishes `ownsVignette`;
  // environs reads that flag and does not write while it is true (environs.js
  // vignette block). Nothing polls, and the next module to touch --vig can ask who
  // owns it instead of trusting a report.
  const root = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement : null;
  let vigHeld = false;
  function vigTake() {
    if (!root || vigHeld) return;
    vigHeld = true;
    root.style.setProperty('--vig', '0');
  }
  function vigRelease() {
    if (!root || !vigHeld) return;
    vigHeld = false;
    // HAND THE VALUE BACK, do not removeProperty(). Removing it falls through to
    // the stylesheet's :root default, and environs will not correct that — its own
    // `st.vig` still holds what it last wrote, so its "moved more than .008" guard
    // never fires and a downgrade to 'off' at a constant hour left the page on the
    // stylesheet's .18 regardless of the time of day. Zeroing `st.vig` through the
    // flag is environs' job; ours is to stop holding the pen.
    root.style.setProperty('--vig', '0.16');
  }

  /* ── THE LENS: a tilt-shift band is only honest from height ─── */
  // A tilt-shift band fakes a macro depth of field, and that reads as
  // "miniature" — the effect this file wanted — only while the lens is looking
  // DOWN at a plat from fifty-odd units up, which is the one framing the anchors
  // were authored against. At the stroll's eye height the SAME band is a lens
  // that cannot focus: measured at --cam=stroll --hour=13, tiltCenter rides the
  // fountain to ~0.42, so the sharp band covers screen y 0.22-0.62 and the ramp
  // softens everything outside it — i.e. the cottage you are standing beside and
  // the cobbles at your own feet go soft while the middle distance stays sharp.
  // That is backwards. A 52° lens at 1.6 m is sharp from two metres to the
  // horizon; nothing in a real photograph of a lane looks like this. It also
  // fights the weather: weather.js's rain is 2600 one-pixel GL_LINES, and a
  // half-res blur across the top third of a street view simply deletes them.
  //
  // So the AMOUNT is a property of the LENS, not of the hour. gradeFor still
  // owns the day-part curve and is untouched; this scales what it produced by
  // where the camera actually is. The town's ground plane is y = 0 (buildings
  // sit on it, and camera.js measures its EYE_H = 0.90 from it), so
  // camera.position.y is the entire input — a public three.js property, no
  // coupling to the rig's internals, and no mode names. That last part is the
  // point: it covers every framing including ones postfx has never heard of.
  // Whatever is down among the buildings gets none of it, whatever is up over
  // the plat gets all of it, and anything descending between the two gets a
  // partial band on the way down instead of a switch flipping under it.
  //
  // PURE and allocation-free: same camera, same frame, same number, so a --shot
  // is graded exactly like an interactive frame. Nothing here accumulates.
  //
  // It is also free, and then some. render() already skips the copy + two blurs
  // when the band is off, so a street-level frame drops from ten passes to seven
  // — the mode with the most geometry in front of the near plane is the one that
  // stops paying for a full-screen half-res blur chain.
  // MEASURED, at --tokens=2e8 --seed=7 --hour=13, camera.position.y per --cam:
  //   orbit 75.7 · photo 66.3 · tour 7.5 · stroll 0.89
  // so the two aerial framings sit three times TILT_AIR up and keep the band at
  // its full authored strength — the default orbit is exactly what it has always
  // been, uTilt 0.300 before and after — while the two that put you among the
  // buildings get none. The dead band between 8 and 22 came back EMPTY: no
  // framing the app reaches today lands in the ramp, so the ramp is not doing
  // day-to-day work, it is there so a focus pull or a tour shot descending
  // through it stays continuous instead of snapping.
  const TILT_DECK = 8;    // at or below: no band at all — you are standing in the town
  const TILT_AIR = 22;    // at or above: the full authored amount — you are over it
  function lensTilt() {
    const p = camera && camera.position;
    if (!p) return 1;     // nobody to ask: ship the grade exactly as authored
    const t = clamp((num(p.y, TILT_AIR) - TILT_DECK) / (TILT_AIR - TILT_DECK), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ── the tier, and the auto-downgrade ladder ────────────────── */
  const RING = 60;
  const ring = new Float32Array(RING);
  let ringN = 0, ringI = 0, ringSum = 0, frames = 0, over = 0, lastNow = -1;

  function resetWindow() {
    ring.fill(0); ringN = 0; ringI = 0; ringSum = 0; frames = 0; over = 0; lastNow = -1;
  }

  function applyTier() {
    if (quality === 'off') {
      freeAll();
      vigRelease();
      // The fallback tier is still a real improvement over no curve at all: one
      // line of ACES beats a hard saturate() at 1.0.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
    } else {
      // postfx owns the curve; the scene pass must land raw linear in the buffer.
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      vigTake();
      rebuild();
    }
  }

  function setQuality(q) {
    if (disposed || QUALITIES.indexOf(q) < 0 || q === quality) return;
    quality = q;
    resetWindow();          // the new tier gets a fresh sample window
    applyTier();
  }

  function stat(t) {
    if (lastNow >= 0) {
      const d = t - lastNow;
      if (d > 0 && d < 4000) {
        frames++;
        ringSum -= ring[ringI]; ring[ringI] = d; ringSum += d;
        ringI = (ringI + 1) % RING; if (ringN < RING) ringN++;
      }
    }
    lastNow = t;
    if (!autoAllowed || ringN < RING) return;
    // THE HEADLESS RULE. The gate is a FRAME COUNT, never a wall-clock timer: a
    // --shot run paints at ~3 fps by design and sees ~21 frames in seven
    // seconds, so it can never trip this and silently invalidate the
    // verification image it was taken for. Never auto-upgrade — oscillation is
    // worse than the slower tier.
    const mean = ringSum / ringN;
    if (quality === 'high' && frames > 200 && mean > 20) { if (++over >= 90) setQuality('med'); }
    else if (quality === 'med' && frames > 400 && mean > 24) { if (++over >= 120) setQuality('off'); }
    else over = 0;
  }

  /* ── public ─────────────────────────────────────────────────── */

  /** CSS pixels — pass the same w/h that renderer.setSize() got. */
  function setSize(w, h) {
    if (disposed) return;
    targetSize(Math.max(2, num(w, 2)), Math.max(2, num(h, 2)), _sz);
    if (_sz[0] === W && _sz[1] === H) return;
    W = _sz[0]; H = _sz[1];
    w2 = sub(W, 2); h2 = sub(H, 2);
    w4 = sub(W, 4); h4 = sub(H, 4);
    w8 = sub(W, 8); h8 = sub(H, 8);
    compU.uAspect.value = W / H;
    compU.uTexel.value.set(1 / W, 1 / H);
    rebuild();
  }

  /** Copies values out of the Grade; the object itself is never retained. */
  function setGrade(g) {
    if (disposed || !g) return;
    compU.uExposure.value = num(g.exposure, 1);
    compU.uContrast.value = num(g.contrast, 1);
    compU.uSaturation.value = Math.max(0, num(g.saturation, 1));
    compU.uBloom.value = Math.max(0, num(g.bloom, 0));
    compU.uVignette.value = clamp(num(g.vignette, 0), 0, 1);
    // The day-part supplies the amount; the lens decides how much of it is
    // honest from where it is standing. See THE LENS above.
    compU.uTilt.value = quality === 'high' ? clamp(num(g.tilt, 0), 0, 1) * lensTilt() : 0;
    compU.uTiltCenter.value = clamp(num(g.tiltCenter, 0.5), 0, 1);
    // NOTE for whoever tunes the band: town.js writes tiltCenter every frame
    // (town.js:3429, it rides the fountain) and has never written tiltWidth, so
    // the half-height is makeGrade()'s 0.2 in every frame the app has ever
    // drawn. That is a default doing duty as a setting; it is deliberate, but it
    // is not obvious from the call site.
    compU.uTiltWidth.value = clamp(num(g.tiltWidth, 0.2), 0.02, 0.9);
    brightU.uThresh.value = Math.max(0, num(g.bloomThresh, 1));
    if (g.lift && g.lift.r !== undefined)
      compU.uLift.value.setRGB(num(g.lift.r, 0), num(g.lift.g, 0), num(g.lift.b, 0));
    if (g.gain && g.gain.r !== undefined)
      compU.uGain.value.setRGB(num(g.gain.r, 1), num(g.gain.g, 1), num(g.gain.b, 1));
  }

  function draw(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  /** @param {number} now performance.now(), the same value tick() runs on. */
  function render(now) {
    if (disposed) return;
    // We own the frame's counters — see the header. Six render() calls a frame
    // and three.js resets info inside every one of them.
    if (info) info.reset();
    const t = num(now, nowMs());
    stat(t);

    if (quality === 'off' || !rtScene) { renderer.render(scene, camera); return; }

    // 1 — the scene, raw linear, into the HDR buffer
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);

    // 2 — bright pass at 1/4 res
    brightU.tScene.value = rtScene.texture;
    draw(brightMat, rtB4);

    // 3,4 — octave one: ~16 px of full-res radius
    blurU.tSrc.value = rtB4.texture; blurU.uDir.value.set(1 / w4, 0); draw(blurMat, rtT4);
    blurU.tSrc.value = rtT4.texture; blurU.uDir.value.set(0, 1 / h4); draw(blurMat, rtB4);

    if (quality === 'high') {
      // 5,6 — octave two: ~64 px. This is the haze the plaza sits inside.
      blurU.tSrc.value = rtB4.texture; blurU.uDir.value.set(1 / w8, 0); draw(blurMat, rtB8);
      blurU.tSrc.value = rtB8.texture; blurU.uDir.value.set(0, 1 / h8); draw(blurMat, rtT8);
      // 7,8 — tilt-shift source, half res, skipped when the band is off
      if (compU.uTilt.value > 0.002) {
        copyU.tSrc.value = rtScene.texture; draw(copyMat, rtHalf);
        blurU.tSrc.value = rtHalf.texture; blurU.uDir.value.set(1 / w2, 0); draw(blurMat, rtHalfB);
        blurU.tSrc.value = rtHalfB.texture; blurU.uDir.value.set(0, 1 / h2); draw(blurMat, rtHalf);
      }
    }

    // 9 — composite to the canvas: the one place the curve and the OETF happen
    compU.tScene.value = rtScene.texture;
    compU.tBloom4.value = rtB4.texture;
    compU.tBloom8.value = rtT8 ? rtT8.texture : null;
    compU.tTilt.value = rtHalf ? rtHalf.texture : null;
    draw(compMat, null);
  }

  /** Epoch switch. Nothing here survives a frame, so there is nothing to clear —
   *  but the tier's sample window should start again against the new town's draw
   *  load, and the vignette claim is re-taken in case the fade dropped it.
   *  Allocates nothing; holds nothing across the switch. */
  function reset() {
    if (disposed) return;
    resetWindow();
    if (quality !== 'off') vigTake();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    vigRelease();
    freeAll();
    triGeo.dispose();
    brightMat.dispose(); blurMat.dispose(); copyMat.dispose(); compMat.dispose();
    quadScene.remove(quad);
    quad.material = null;
    renderer.toneMapping = savedToneMapping;
    renderer.toneMappingExposure = savedExposure;
    if (info) info.autoReset = savedAutoReset;
    renderer.setRenderTarget(null);
  }

  /* ── boot. Size first, so the tier allocates once at the real resolution
       rather than minting a 2×2 chain and immediately resizing it. ── */
  if (info) info.autoReset = false;
  if (typeof renderer.getSize === 'function') {
    const s = renderer.getSize(new THREE.Vector2());
    W = -1; H = -1; setSize(s.x, s.y);
  } else setSize(1280, 720);
  applyTier();
  if (opts.headless && typeof console !== 'undefined' && console.warn)
    console.warn(`[post] tier=${quality} pinned=${!autoAllowed} webgl2=${isWebGL2}`);

  return {
    render, setSize, setGrade, setQuality, reset, dispose,
    get quality() { return quality; },
    get enabled() { return !disposed && quality !== 'off' && !!rtScene; },
    // The one readable answer to "who is writing --vig". environs asks every
    // frame; anything else that wants the property can ask too.
    get ownsVignette() { return vigHeld; }
  };
}
