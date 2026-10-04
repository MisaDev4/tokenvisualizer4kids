# Token Town v4 — LOOK DEV

**Area:** render / art direction only. No gameplay, no layout, no data.
**Goal:** every screenshot should look like a poster of a place, not a diagram of one.
**Author's brief from the user:** *"This is for fun, so have fun with it."*

---

## 0. The one-sentence diagnosis

**The town has no highlights and no darks — the entire image lives in the middle
20 % of the value range, so nothing reads as lit, nothing reads as grounded, and
the eye has nowhere to land.**

Everything below is downstream of that. I measured it rather than guessing;
the tool is checked in at
`scratchpad/lookdev-hist.mjs` (no deps, decodes PNG with `node:zlib`, samples the
3D viewport region only — skips the header/ticker/footer chrome):

```
node lookdev-hist.mjs <png>...
```

| shot | p5..p95 L span | % of px in L 90..190 | % above L 220 | p99 |
|---|---|---|---|---|
| `e1-noon.png`  (current, noon) | **61 / 255** | **95.5 %** | **0.0 %** | 164 |
| `e1-day.png`   (current, dusk) | 49 | 7.5 % | 0.0 % | 136 |
| `art-day.png`  (17:20, day)    | 93 | 76.0 % | 0.0 % | 208 |
| `art-river.png`                | 108 | 75.4 % | 0.2 % | 208 |
| `art-golden.png`               | 117 | 43.4 % | 0.0 % | 174 |
| `art-night.png`                | 46 | 1.4 % | 0.1 % | **124** |

Read `e1-noon` again: **95.5 % of the frame sits inside a 100-level band, and
not one pixel in the picture is brighter than L=164.** A sunlit white-plaster
cottage at local noon is rendering darker than middle grey.

And `art-night`: the brightest pixel in a frame whose subject is *a radiant
golden colossus* is L=124. The thing that is supposed to be glowing is dimmer
than the daytime grass.

That is the whole problem. Fixing it is one pipeline change plus a light
rebalance, and it makes everything else in this document cheap.

---

## 1. What I actually see in the PNGs (flaw register)

Each flaw is referenced by tag below.

**F1 — No highlight, anywhere.** Proven above. Cause: `renderer.toneMapping` is
never set (default `NoToneMapping`), so the pipeline is a hard `saturate()` at
1.0 and the lighting was tuned to never approach it. `town.js:181` mints the
renderer with only `antialias:true`. There is no exposure control in the app.

**F2 — Key:fill is 2.7:1, which is overcast-flat.**
`town.js:1894` `sun.intensity = day * 1.45 * LI`, `town.js:1917`
`hemi.intensity = (.16 + day*.38) * LI`. At noon that is 4.55 vs 1.70. Every
box in the town gets its shadow side filled to within 40 % of its lit side, so
a cube reads as three near-identical rectangles. This is *why* the histogram
is a spike. In `e1-noon.png` you can put a ruler across any cottage and the
sunlit gable and the shaded gable differ by ~18 sRGB levels.

**F3 — Buildings do not touch the ground.** Look at `art-river.png` around the
market rows, or `e1-noon.png` anywhere outside the ±74-unit shadow frustum:
there is **no** contact shadow. Houses read as stickers laid on a green
tablecloth. Two causes, both deliberate and both correct for perf:
`town.js:355` `const ext = Math.min(b.r, 62) + 12` caps the shadow camera at
±74 units, and `town.js:874` `if (e.band > 4) … castShadow = false`. On a
446-house town that is roughly a fifth of the buildings casting anything.

**F4 — Far buildings are fogged toward a *brighter* colour than the far
ground.** `environs.js:677` mixes the ground toward `uLandFar` (a darkened,
cooled land value, deliberately *not* the sky). Buildings get plain
`FogExp2` toward `scene.fog.color`, which **is** the sky's bottom stop
(`town.js:1903`). So at the same depth the countryside converges to land and
the town converges to sky. In `art-river.png` the right-hand outskirts sit
visibly paler and bluer than the field they stand in — the town dissolves
before the land does, which is backwards.

**F5 — The sky gradient is inverted.** Vertical strip through `e1-noon.png`
at x=260:

```
y=150  rgb( 85,125,175)  L=119     <- top of frame
y=310  rgb(111,149,185)  L=142     <- horizon band: BRIGHTEST
y=630  rgb(114,140,141)  L=132
y=790  rgb( 96,105, 74)  L= 99     <- land
```

The brightest region of the whole picture is the empty haze band. A poster
wants the top of the sky darkest and the subject brightest.

**F6 — (already fixed, do not re-fix)** `art-river.png` / `art-day.png` show the
old milky veil wall: L jumps 146→190 in 40 px at y≈310 and then plateaus at
L≈193 for 350 px. `e1-*` (18:43+) shows this gone — the veil/collar work in the
current wave landed. **v4 must not touch `environs.js`'s veil ramp.**

**F7 — Zero surface texture.** `z-day-mon.png` (a 1:1 crop) shows every roof,
wall, plaza flag and gold drum as a single flat fill. `matFor()`
(`buildings.js:428`) mints untextured `MeshStandardMaterial`s, and — critically
— `concatMeshes()` (`buildings.js:490`) copies **position, normal and colour
only**. *The static merge throws UVs away.* Any texture plan that needs UVs on a
house is dead on arrival; see §5.

**F8 — Nothing metallic reads as metal.** `KIND.metal` is
`{roughness:.35, metalness:.25}` and there is no environment map, so gold has no
specular event at all. The 1B colossus in `art-night.png` is a flat mustard
silhouette with an emissive lift; the ledger drum in `z-day-mon.png` shows
visible Mach banding across its cylinder because a smooth low-contrast ramp in
8 bits is exactly the case that bands.

**F9 — Water reads as a road.** `MAT.water` / `environs.js:726`
`roughness .17, metalness .12`, no reflection term. In `art-river.png` the river
is a matte pale-blue ribbon; if you crop the boat-less middle of it you cannot
tell it from a paved street.

**F10 — Windows are dots, not lights.** `art-night.png` / `c-night-plat.png`:
`winI = night*2.2 + .04` (`town.js:1986`) drives real emissive, but with no
bloom and no tone-map shoulder each pane is a 2 px hard-edged rectangle. Light
that does not bleed does not read as light.

**F11 — Night has no moon.** `moon` is a `DirectionalLight` at
`town.js:207/1916`, but there is no disc, no halo. The night sky is stars on
flat navy, and the sun gets a ball *and* a 150-unit additive halo
(`town.js:212-221`). Asymmetric, and a wasted focal point.

**F12 — The lens is a compromise.** `PerspectiveCamera(46, …)` with a default
`pol = .40` (22.9° above horizon). 46° is a 35 mm-equivalent wide: the bottom
corners of `art-river.png` show real keystone shear on houses that should read as
neat boxes, and the wide angle is what makes the town small in frame even after
the framing tightening. 23° of pitch is too low to read the plan and too high to
be a hero silhouette.

**F13 — Sub-pixel confetti at the working framing.** At `b.r ≈ 200` a cottage is
~10 px wide. Roof/wall/trim are three colours inside 10 px with roughly equal
value, so the town reads as noise. The palette's own guardrail
(`buildings.js:167-168`: darkest roof must stand off the grass by 0.18 luminance)
is doing the only silhouette work in the app.

**F14 — 8-bit banding in the sky and the gold.** No dithering anywhere. A
2734-px-wide smooth gradient over 40 sRGB levels is ~68 px per step. Visible in
every day shot's upper third.

---

## 2. The pipeline decision

### 2.1 What is available

Vendored `three.module.js` is **r160** (`vendor/three.module.js:6`). It is core
only — no `EffectComposer`, no `ShaderPass`, no `UnrealBloomPass`, no SSAO.
Everything must be hand-rolled. Verified present and usable:

- `WebGLRenderTarget` with `samples` (`three.module.js:2965`, `:3034`) → **MSAA
  on the render target**, so a post pass does *not* cost us antialiasing.
- `HalfFloatType` (`:95`) → a real HDR buffer.
- `ACESFilmicToneMapping` / `AgXToneMapping` (`:63`, `:65`).
- `colorspace_fragment` / `colorspace_pars_fragment` (`:13892`, `:13894`),
  `dithering_fragment` / `dithering_pars_fragment` (`:14002`, `:14004`).
- `toneMappingExposure` is uploaded to **every** program unconditionally
  (`:30425`), so a hand-written `ShaderMaterial` gets it for free.

**The load-bearing fact that makes this clean:** r160 disables tone mapping and
forces `LinearSRGBColorSpace` output when rendering into a render target
(`three.module.js:20716-20726` and `:30139-30150`):

```js
let toneMapping = NoToneMapping;
if ( material.toneMapped ) {
  if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {
    toneMapping = renderer.toneMapping;
  }
}
```

So the scene pass into an RT is *automatically* raw linear, and the composite
quad (which renders to the default framebuffer) is *automatically* the one place
tone mapping and sRGB encoding happen. No double-encoding, no fighting the
engine. This is why the post route is the right one and not a hack.

### 2.2 Rejected alternatives, with reasons

- **Material tricks only, no render target.** Gets us F2, F3, F4, F7, F13 but
  cannot deliver bloom, exposure, vignette-in-frame or dithering — i.e. cannot
  fix F1 and F10, which are the top two. Kept as the *fallback tier* (§9), not
  as the plan.
- **`renderer.toneMapping = ACESFilmic` alone (no post).** One line, real
  improvement, no bloom. This is exactly the `quality:'off'` tier.
- **SSAO. Rejected.** Needs a depth+normal prepass (a second full scene render at
  1200 groups) plus 12-16 taps plus a bilateral blur. The look it buys —
  darkening in the crevices between buildings — is 90 % delivered by
  **L4 blob shadows + L5 base darkening** at ~2 % of the cost. Do not build it.
- **A real LUT texture.** A 32³ 3D LUT (or a 512×512 2D-tiled LUT) is more
  colourist-friendly, but it is an asset to author with no tooling on this
  machine, and it cannot be interpolated across the day cheaply. **Use analytic
  lift/gamma/gain + saturation instead** — it interpolates continuously from noon
  to golden hour to midnight, which is what this app needs.

### 2.3 Architecture

**New file: `town/src/renderer/postfx.js`.** Self-contained, no imports from any
existing town module except `three`. This is deliberate: it is the single
biggest item and it must be buildable in parallel with everything else.

```js
/**
 * @typedef {Object} Grade
 * @property {number} exposure     linear multiply before the curve        0.6 .. 1.8
 * @property {number} contrast     about a 0.5 pivot, after the curve      0.85 .. 1.30
 * @property {number} saturation   after the curve                         0.80 .. 1.35
 * @property {THREE.Color} lift    added in linear (shadow tint)           components 0 .. 0.02
 * @property {THREE.Color} gain    multiplied in linear (highlight tint)   components 0.85 .. 1.15
 * @property {number} bloom        composite strength                      0 .. 1.4
 * @property {number} bloomThresh  linear bright-pass knee centre          0.5 .. 1.6
 * @property {number} vignette     corner darkening, display space         0 .. 0.55
 * @property {number} tilt         tilt-shift blur amount                  0 .. 1
 * @property {number} tiltCenter   screen-y of the sharp band, 0=top       0 .. 1
 * @property {number} tiltWidth    half-height of the sharp band           0.1 .. 0.6
 */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{quality?:'high'|'med'|'off', headless?:boolean}} [opts]
 * @returns {{
 *   render(now:number):void,
 *   setSize(w:number,h:number):void,
 *   setGrade(g:Grade):void,
 *   setQuality(q:'high'|'med'|'off'):void,
 *   readonly quality:'high'|'med'|'off',
 *   readonly enabled:boolean,
 *   dispose():void
 * }}
 */
export function initPost(renderer, scene, camera, opts = {}) { … }

/** Fills `out` (a Grade) from the day-part. Pure: same inputs → same Grade.
 *  @param {number} day 0..1  @param {number} night 0..1
 *  @param {number} glowK 0..1  golden-hour weight, town.js:1895
 *  @param {number} heat 0..1   prosperity/pace richness, see §6.4
 *  @param {Grade} out
 *  @returns {Grade} out */
export function gradeFor(day, night, glowK, heat, out) { … }
```

### 2.4 Order of operations (this is the spec — do not reorder)

```
 0. renderer.toneMapping = NoToneMapping           (postfx owns the curve)
 1. setRenderTarget(rtScene)      render(scene, camera)      HalfFloat, samples:4
 2. setRenderTarget(rtBright4)    brightPass(rtScene)        1/4 res, soft-knee threshold
 3. setRenderTarget(rtTmp4)       blur(rtBright4, (1/w4,0))  5-tap linear-sampled gaussian
 4. setRenderTarget(rtBright4)    blur(rtTmp4,   (0,1/h4))
 5. setRenderTarget(rtBright8)    blur(rtBright4,(1/w8,0))   HIGH ONLY — second octave
 6. setRenderTarget(rtTmp8)       blur(rtBright8,(0,1/h8))   HIGH ONLY
 7. setRenderTarget(rtHalf)       copy(rtScene)              HIGH ONLY, tilt>0 — 1/2 res
 8. setRenderTarget(rtHalfB)      blur(rtHalf, both axes)    HIGH ONLY, tilt>0
 9. setRenderTarget(null)         composite(...)             → the canvas
```

**Inside `composite`, in this order** (getting this wrong is the classic bloom
mistake — bloom added *after* the curve is a flat white smear):

```
 a. c = texture(tScene, uv).rgb
 b. c = mix(c, texture(tHalfBlur, uv).rgb, tiltMask(uv))     tilt-shift, still HDR
 c. c += (0.62*texture(tBloom4,uv).rgb + 0.38*texture(tBloom8,uv).rgb) * uBloom
 d. c *= uExposure
 e. c = c * uGain + uLift                                     lift/gain, linear
 f. c = townFilmic(c)                                         the curve  → [0,1]
 g. c = mix(vec3(dot(c, LUMA)), c, uSaturation)
 h. c = (c - 0.5) * uContrast + 0.5
 i. c *= vignette(uv)
 j. gl_FragColor = vec4(c, 1.0);
    #include <dithering_fragment>
    #include <colorspace_fragment>
```

Steps (b) and (c) are HDR-domain. (g)(h)(i) are display-linear (post-curve,
pre-OETF) — that is the correct place for contrast/sat, and the vignette must be
there or the shoulder eats it.

### 2.5 The curve (`townFilmic`)

Do **not** call `renderer.toneMapping`'s chunk; own it, so the numbers below mean
something. The ACES RRT+ODT fit gives the shoulder we want but skews saturated
oranges toward yellow — fatal for a palette whose primaries are Terracotta,
Ochre and Saffron (`buildings.js:57-59`). So: run the fit, then restore chroma.

```glsl
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 townFilmic(vec3 x) {
  x = max(x, vec3(0.0));
  float pre = dot(x, vec3(0.2126, 0.7152, 0.0722));   // pre-curve luma
  vec3 c = ACES_IN * x;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  c = ACES_OUT * (a / b);
  c = clamp(c, 0.0, 1.0);
  // hue-preserving chroma restore: the fit desaturates ~14% at the shoulder,
  // which turns a terracotta roof in sunlight into a beige roof in sunlight.
  float post = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = 1.0 + 0.34 * smoothstep(0.35, 1.0, post);   // only the bright end
  return clamp(mix(vec3(post), c, k), 0.0, 1.0);
}
```

Sanity anchors (verify these three during bring-up; they are cheap to check by
sampling a flat test quad):
`townFilmic(0.18) ≈ 0.20`, `townFilmic(1.0) ≈ 0.80`, `townFilmic(4.0) ≈ 0.97`.
Middle grey stays put, a fully-lit white plaster wall lands at 0.80 and *has
somewhere to go*, and the monument at 4× overdrive gets a soft roll rather than a
clip.

### 2.6 Bright pass and blur (exact)

```glsl
// bright pass — soft-knee, Karis-style, run at 1/4 res
uniform sampler2D tScene; uniform float uThresh; uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c  = texture2D(tScene, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float s  = clamp(br - uThresh + uKnee, 0.0, 2.0 * uKnee);
  s = s * s / (4.0 * uKnee + 1e-4);
  float k = max(s, br - uThresh) / max(br, 1e-4);
  // firefly clamp: one 40.0 emissive texel becomes a 40-px star otherwise
  gl_FragColor = vec4(min(c * k, vec3(6.0)), 1.0);
}
```
`uKnee = 0.45` always. `uThresh` from the grade table (§3, L2).

```glsl
// 5-tap linear-sampled gaussian (σ ≈ 2.0 texels), one axis per pass
uniform sampler2D tSrc; uniform vec2 uDir;   // uDir = (1/width, 0) or (0, 1/height)
varying vec2 vUv;
const float O1 = 1.3846153846, O2 = 3.2307692308;
const float W0 = 0.2270270270, W1 = 0.3162162162, W2 = 0.0702702703;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * W0;
  c += (texture2D(tSrc, vUv + uDir*O1).rgb + texture2D(tSrc, vUv - uDir*O1).rgb) * W1;
  c += (texture2D(tSrc, vUv + uDir*O2).rgb + texture2D(tSrc, vUv - uDir*O2).rgb) * W2;
  gl_FragColor = vec4(c, 1.0);
}
```

At 1/4 res that is a ~16 px full-res radius; the 1/8 octave gives ~64 px. Two
octaves at 0.62/0.38 is the difference between "the windows glow" and "the town
has a haze over it". Build both; drop the second at `quality:'med'`.

### 2.7 Fullscreen triangle, not quad

```js
const triGeo = new THREE.BufferGeometry();
triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1,-1,0,  3,-1,0,  -1,3,0]), 3));
triGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array([0,0,  2,0,  0,2]), 2));
triGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);   // never cull
// vertex shader for every pass:
//   varying vec2 vUv;
//   void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
```
One triangle, no clip-space matrices, no diagonal seam in the blur. The quad
camera is `new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)` and every pass mesh
is `frustumCulled = false`, `depthTest = false`, `depthWrite = false`.

### 2.8 Render-target sizing (mandatory — this is where memory goes wrong)

```js
function targetSize(w, h) {
  const s = Math.min(renderer.getPixelRatio(), 1.75);
  let W = Math.max(2, Math.round(w * s)), H = Math.max(2, Math.round(h * s));
  const CAP = 4.6e6;                                  // ≈ 2560×1800
  if (W * H > CAP) { const k = Math.sqrt(CAP / (W * H)); W = Math.round(W*k); H = Math.round(H*k); }
  return [W, H];
}
```
`rtScene`: `{ type: THREE.HalfFloatType, samples: 4, depthBuffer: true, stencilBuffer: false,
minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false }`.
Bloom/tilt targets: same type, `samples: 0`, `depthBuffer: false`.
At 2560×1800 half-float that is ~35 MB for `rtScene` and ~4 MB for the chain.
**Guard `samples` with `renderer.capabilities.isWebGL2`;** if it is false, set
`samples: 0` and enable the FXAA branch in the composite (§9.3), because losing
`antialias:true` silently would be a visible regression on a town made entirely
of straight roof edges.

---

## 3. The items

Ranking legend: **MUST** = the picture is broken without it · **SHOULD** = the
difference between good and poster · **COULD** = charm we take if there is room.
Size: S ≤ ~80 lines / half a day · M ≈ 150-350 lines · L ≈ 400+ lines or research.

---

### L1 — Exposure, the curve, and the light rebalance · **MUST · M**
**Files:** `postfx.js` (new) · `town.js` (lines 181-207, 1894-1926, 1869-1875, 2148)

Fixes **F1, F2, F14**. Nothing else in this document works until this lands.

**1a. Pipeline.** As §2. `renderer.toneMapping = THREE.NoToneMapping` explicitly
(document *why*: postfx owns the curve). `renderer.toneMappingExposure = 1`.

**1b. Light rebalance.** The current values were tuned against a clipping
pipeline. New values (replace at the cited lines):

| line | now | v4 | why |
|---|---|---|---|
| `town.js:1894` | `sun.intensity = day * 1.45 * LI` | `day * 2.35 * LI` | the key must exceed 1.0 linear on lit plaster so the shoulder has work to do |
| `town.js:1917` | `hemi.intensity = (.16 + day*.38) * LI` | `(.11 + day*.30) * LI` | key:fill 2.7:1 → **5.7:1**. This single number is F2. |
| `town.js:1916` | `moon.intensity = (.05 + night*.14) * LI` | `(.03 + night*.19) * LI` | night keeps its shape when the fill drops |
| `town.js:200` | `hemi = HemisphereLight(0xbdd3ea, 0x3b4028, …)` | sky `0xA8C6E8`, ground `0x3E4630` | fill goes cooler; the warm/cool split is now doing the modelling |
| `town.js:1896` | `sun.color = glowK>.3 ? 0xffb877 : 0xffe0b0` | `glowK>.3 ? 0xFFA860 : 0xFFEFD6` | noon sun goes near-white (the *grade* supplies warmth now, not the light); golden hour goes hotter |

**Risk and its mitigation:** at 5.7:1 the shadow sides of buildings will drop
hard. That is intended — but it must not go to mud. **L5's rim term and the
grade's `lift` are what keep the shadow side alive, so L1 and L5 ship together
or the intermediate state looks worse than today.** Schedule them as one unit.

**1c. Grade table.** `gradeFor(day, night, glowK, heat, out)` interpolates
between three anchors. `t_golden = clamp(glowK,0,1)`, `t_night = clamp(night,0,1)`;
blend noon→golden by `t_golden`, then →night by `t_night`.

| | **noon** (day 1, glow 0) | **golden** (glow 1) | **night** (day 0) |
|---|---|---|---|
| `exposure` | 1.00 | 1.06 | 1.34 |
| `contrast` | 1.10 | 1.05 | 1.16 |
| `saturation` | 1.12 | 1.20 | 0.92 |
| `lift` (linear add) | `(0.000,0.000,0.000)` | `(0.005,0.002,0.000)` | `(0.000,0.003,0.010)` |
| `gain` (linear mul) | `(1.000,0.995,0.975)` | `(1.075,0.980,0.885)` | `(0.880,0.940,1.120)` |
| `bloom` | 0.20 | 0.55 | 0.95 |
| `bloomThresh` | 1.30 | 1.05 | 0.72 |
| `vignette` | 0.22 | 0.30 | 0.42 |
| `tilt` | 0.30 | 0.30 | 0.18 |

The story those numbers tell: **noon is neutral and crisp, golden hour is warm
in the highlights and warm in the shadows, night is cool in the shadows and
cold in the highlights except where the town's own light overrides it.** That
is a coherent day/golden/night palette strategy in three rows, and it
interpolates continuously — no popping at 17:59.

**1d. Dithering.** Set `dithering: true` on the composite `ShaderMaterial` and
`#include <dithering_pars_fragment>` / `#include <dithering_fragment>` (the pars
chunk needs `rand()`, so also `#include <common>` in the pars block). Kills F14
for one define.

**1e. `postfx` holds no dt-integrated state.** Contract, stated in the file
header: *every uniform in postfx is a pure function of the `Grade` it is handed;
postfx never accumulates.* This is what makes a 3 fps headless screenshot show
the same grade as a 60 fps live run. (House rule, `CLAUDE.md`.)

**Integration diff in `town.js`:**
```js
// after the renderer/scene/camera exist (~town.js:196)
const post = initPost(renderer, scene, camera, { quality: Q.get('post') || 'high' });
// resize() ~town.js:1872
post.setSize(w, h);
// tick(), just before the render (~town.js:2147)
post.setGrade(gradeFor(day, night, glowK, heatOf(ctx), _grade));
// town.js:2148
- renderer.render(scene, camera);
+ post.render(now);
```
Add `?post=off|med|high` to the existing `Q` query-param vocabulary
(`town.js:141-146`) so the whole feature is one URL flag away from being ruled
out during any future debugging session.

---

### L2 — Bloom · **MUST · M**
**Files:** `postfx.js` (new) only.

Fixes **F10** and half of **F8**. This is the night payoff and it is why
`art-night.png`'s p99 is 124 instead of 255.

Spec is §2.6 plus the composite's step (c). Two octaves, 0.62/0.38.
`bloomThresh` from the grade table: 1.30 by day (only the sun ball, the gold and
sun-struck white plaster bloom) down to 0.72 at night (every lit window
qualifies). Firefly clamp at 6.0 in the bright pass is not optional — the
monument's tier-10 emissive and the `AdditiveBlending` particle pools
(`town.js:410`, `town.js:532`) will otherwise produce a single-texel 40.0 that
smears a 64 px star across the frame.

**Acceptance:** on a night shot, `lookdev-hist.mjs` must report **≥ 0.8 % of
pixels above L 200** (today: 0.1 %) while `p50 ≤ 22` (today: 22 — night must
stay *dark*; the win is contrast, not brightness).

---

### L3 — Grade, vignette, saturation · **MUST · S**
**Files:** `postfx.js` (new) · `index.html` (line 68-69) · `environs.js` (lines 1503-1511, 1612-1630)

The composite steps (e)(g)(h)(i) plus the CSS handshake.

**The handshake matters.** `environs.js:1503-1511` already writes a `--vig` CSS
custom property at ≤4 Hz and `index.html:68` paints a DOM radial gradient over
the canvas. **If postfx also vignettes, they double.** Rule:

- `initPost` with `quality !== 'off'` sets `--vig` to `0` once and takes over.
- `postfx.dispose()` and any auto-downgrade to `'off'` must **restore** the
  property so environs' own value takes effect again on the next 250 ms tick.
- environs keeps its writer untouched — no coordination needed between the two
  implementers beyond this paragraph.

The in-shader vignette (better than the CSS one: it is inside the tone curve's
output, so it darkens without greying):

```glsl
vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
float v = 1.0 - uVignette * pow(clamp(length(q) * 1.32 - 0.34, 0.0, 1.0), 1.6);
```
Note the ellipse is aspect-corrected — the CSS one is not, so on a 2734×1690
window it currently pinches the top and bottom before the sides.

---

### L4 — Blob contact shadows ("the town touches the ground") · **MUST · M**
**Files:** `grounding.js` (new) · `town.js` (mountEnt ~line 860-880, hardReset, tick)

Fixes **F3**, the single most-noticed flaw after F1. A new file precisely so it
can be built in parallel with `buildings.js` work.

```js
/**
 * A pooled field of soft elliptical ground blobs — the cheap contact shadow the
 * real shadow map cannot afford past band 4. ONE draw call for the whole town.
 * @param {THREE.Scene} scene
 * @param {{capacity?:number}} [opts]  capacity defaults to 1400 (plan.capacity + slack)
 * @returns {{
 *   place(slot:number, x:number, z:number, radius:number, height:number):void,
 *   clear(slot:number):void,
 *   clearAll():void,
 *   update(now:number, ctx:object, sunDir:THREE.Vector3):void,
 *   dispose():void
 * }}
 */
export function initGrounding(scene, opts = {}) { … }
```

**Geometry / material**
```js
const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const mat = new THREE.MeshBasicMaterial({
  map: blobTex(),            // 64² canvas, see below
  color: 0x121A0E,           // green-black; a neutral grey blob reads as soot on grass
  transparent: true, depthWrite: false, opacity: 0.42,
  fog: true, blending: THREE.NormalBlending
});
const im = new THREE.InstancedMesh(geo, mat, capacity);
im.frustumCulled = false; im.count = 0; im.renderOrder = 1;
```
Y ordering against the existing decals: road plate `y=.02` (`town.js:280`), lamp
pools `y=.04 renderOrder 2` (`town.js:425`). **Blobs go at `y = 0.030`,
`renderOrder = 1`** — over the roads, under the lamp pools.

`blobTex()` — 64×64 canvas, radial gradient, alpha only:
```
stop 0.00  rgba(0,0,0,0.95)
stop 0.42  rgba(0,0,0,0.62)
stop 0.74  rgba(0,0,0,0.20)
stop 1.00  rgba(0,0,0,0.00)
```
`t.colorSpace = SRGBColorSpace; t.minFilter = LinearMipmapLinearFilter; t.anisotropy = 4;`

**Placement.** `mountEnt` already knows the entity's footprint. Call
`grounding.place(e.slot, x, z, r, h)` with
```js
const r = Math.max(hx, hz) * 0.62 + h * 0.10;
```
`clear(slot)` parks the instance at `y = -999` (the `revealScatter` idiom already
used at `town.js:508-518`) rather than compacting the array, so slots stay stable
across a growth cascade.

**Direction — this is the part that makes it look like a shadow and not a
smudge.** Per update, from the sun's ground-projected direction:
```js
const el   = clamp(sunDir.y, 0, 1);                        // 0 at horizon, 1 overhead
const az   = Math.atan2(sunDir.z, sunDir.x);
const strc = 1 + 1.45 * (1 - el);                          // stretch away from the sun
const push = 0.55 * (1 - el);                              // and slide the blob off-centre
// per instance: scale (r*2*strc, 1, r*2), rotate -az about Y,
//               translate (x - cos(az)*r*push, 0.030, z - sin(az)*r*push)
```
At golden hour every house grows a long shadow pointing away from the sun, for
free, in one draw call. That alone will change the character of the dusk shots.

**Cost control (mandatory).** Re-composing 1200 matrices is ~0.35 ms.
- Recompute **only** when `|az - lastAz| > 0.012` **or** `|el - lastEl| > 0.010`,
  checked at most every 500 ms — piggyback the existing stats timer
  (`town.js:2057`), which is also where `shadowMap.needsUpdate` is re-armed.
- `im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)`.
- Newly placed buildings write their own matrix immediately on `place()`;
  the sweep is only for re-orienting.

**Opacity by day-part**, per update: `mat.opacity = 0.10 + 0.34 * ctx.day * smoothstep(0.05, 0.45, el)`.
Sun on the horizon → faint long shadows; overhead → crisp short ones; night →
0.10, which is just enough to keep a building from floating.

---

### L5 — Surface: rim light, base darkening, world-space grain, far-value match · **MUST · M**
**Files:** `surface.js` (new) · `buildings.js` (3 one-line hunks: `std()` line 24, `matFor()` line 431, `mergedMat()` line 481)

Fixes **F4, F7, F13**, and is what keeps L1's higher contrast from turning the
shadow side to mud.

**Why a shader patch and not textures.** `concatMeshes()` (`buildings.js:490-517`)
builds `position / normal / color / index` and **no UVs**. Every merged building —
which is nearly every building — has no texture coordinates at all. A UV pass
would mean touching the merge, the vertex budget and the cache key. Instead:
**derive all detail from world position and world normal**, which the merged
geometry already implies. Zero new attributes, zero new textures, zero extra
draw calls, and it works identically on merged and unmerged meshes.

```js
/** Shared uniforms — ONE object, written once per frame by town.js, read by
 *  every patched program. Mirrors the `U` idiom in environs.js. */
export const SURF = {
  uRimCol:  { value: new THREE.Color(0xBFD8F2) },
  uRimK:    { value: 0.34 },
  uBaseAO:  { value: 0.30 },
  uGrainK:  { value: 0.11 },
  uLandFar: { value: new THREE.Color(0x8A9470) },   // fed from environs' own value
  uFarK:    { value: 0.55 },
  uFarD:    { value: new THREE.Vector2(120, 620) }  // start, end distance
};

/** Patch a MeshStandardMaterial in place. Idempotent; safe to call twice.
 *  @param {THREE.MeshStandardMaterial} m
 *  @param {'building'|'prop'|'ground'} [role]
 *  @returns {THREE.MeshStandardMaterial} m */
export function applyTownSurface(m, role = 'building') { … }
```

Call sites — three lines total in `buildings.js`:
```js
// line 24  export function std(...)      → return applyTownSurface(new THREE.MeshStandardMaterial(...));
// line 431 matCache.set(key, m)          → applyTownSurface(m); matCache.set(key, m);
// line 481 mergeMats.set(k, m)           → applyTownSurface(m); mergeMats.set(k, m);
```

**`customProgramCacheKey` is required**, or three keys the program on
`onBeforeCompile.toString()` (works, but re-parses a 4 KB function per material):
```js
m.customProgramCacheKey = () => 'town-surface-' + role;
```
Distinct program count after the patch: ~6-8 (the merge buckets by
roughness/metalness/side/flatShading; `KIND` has only 4 distinct configs).

**Vertex injections**
```glsl
// into '#include <common>' (vertex)
varying vec3 vSWPos; varying vec3 vSWNrm; varying float vSDist;

// into '#include <beginnormal_vertex>'
vSWNrm = normalize(mat3(modelMatrix) * objectNormal);

// into '#include <begin_vertex>'
vec4 sW = modelMatrix * vec4(transformed, 1.0);
vSWPos = sW.xyz;
vSDist = length(cameraPosition - sW.xyz);
```

**Fragment injections**

*(1) after `#include <normal_fragment_begin>` — capture a shading normal that is
correct under `flatShading` too (`vNormal` is not declared when `FLAT_SHADED`):*
```glsl
vec3 sN = normal;
```

*(2) into `#include <color_fragment>` — albedo-domain: contact darkening + grain.*
```glsl
// stylised AO: a wall is darker where it meets the ground. 1.30 world units is
// about a third of a tier-1 cottage — high enough to read at the working
// framing, low enough to leave the roof alone.
float sAO = 1.0 - uBaseAO * (1.0 - smoothstep(0.0, 1.30, vSWPos.y));

// world-space detail, with a DERIVATIVE FADE so it never aliases at distance.
// This is the whole trick: at the wide framing the period is sub-pixel and the
// term goes to zero, so 1200 buildings do not shimmer.
float sUp   = abs(vSWNrm.y);
float sFade = 1.0 - smoothstep(0.45, 1.30, fwidth(vSWPos.y) * 3.33);

// roof courses: rows of tile every 0.30 world units on any up-facing surface
float sCourse = smoothstep(0.40, 0.60, fract(vSWPos.y * 3.33)) - 0.5;

// plaster grain: a cheap 2-D value hash on a 0.37-unit lattice
vec2  sCell = floor(vSWPos.xz * 2.7 + vSWPos.y * 0.9);
float sGrain = fract(sin(dot(sCell, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;

float sDet = mix(sGrain, sCourse * 1.30, step(0.30, sUp));
diffuseColor.rgb *= sAO * (1.0 + sDet * uGrainK * sFade);
```

*(3) into `#include <opaque_fragment>` (before it) — rim light on `outgoingLight`.*
```glsl
// A sky-coloured wrap around every silhouette edge. This is what separates a
// roof from the roof behind it at 10 px, and what keeps the shadow side of a
// building from going to mud now that the fill is 5.7:1 down from the key.
float sRim = pow(1.0 - clamp(dot(sN, normalize(vViewPosition)), 0.0, 1.0), 3.2);
outgoingLight += uRimCol * (sRim * uRimK * (0.30 + 0.70 * clamp(vSWNrm.y * 0.5 + 0.5, 0.0, 1.0)));
```

*(4) into `#include <fog_fragment>` (after it) — **F4**, the far-value match.*
```glsl
// The countryside converges to uLandFar (environs.js:677) while the town was
// converging to scene.fog.color — the SKY's bottom stop. At the same depth the
// outskirts therefore came out paler and bluer than the field they stand in.
// One shared target, one horizon.
float sFar = smoothstep(uFarD.x, uFarD.y, vSDist);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uLandFar, sFar * uFarK);
```

**Driving the uniforms** (town.js, in `tick`, one block, ~8 lines):
```js
SURF.uRimCol.value.copy(skyMat.uniforms.top.value).lerp(WHITE, 0.35);
SURF.uRimK.value   = 0.20 + 0.26 * day + 0.30 * night;   // rim carries the night silhouette
SURF.uBaseAO.value = 0.34 - 0.10 * night;
SURF.uGrainK.value = 0.11;
SURF.uLandFar.value.copy(env.landFar());                 // NEW tiny getter on environs
SURF.uFarD.value.set(dist * 0.55, dist * 3.1);           // scales with the framing
```
`env.landFar()` is a **2-line addition to `environs.js`'s public surface**
returning `U.uLandFar.value` — the only change L5 needs in that file, and it
collides with nothing.

---

### L6 — The sky: real gradient, sun-side lobe, horizon band · **SHOULD · M**
**Files:** `town.js` (lines 235-247, 1856-1860, 1897-1915)

Fixes **F5**. The current dome is a two-stop `mix(bot, top, vh*1.7 + 0.12)`
(`town.js:242-243`) and the bottom stop is also `scene.fog.color`, which is why
the brightest thing in the frame is empty haze.

**Three stops, plus a sun-azimuth lobe.**
```glsl
// vertex: varying vec3 vDir;  vDir = position;   (dome is centred on the camera-ish origin)
uniform vec3 uZen, uMid, uHor, uGlow;
uniform vec3 uSunAz;      // sun direction with y zeroed and normalised
uniform float uGlowK;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = mix(uHor, uMid, smoothstep(-0.03, 0.17, h));
  c = mix(c, uZen, smoothstep(0.11, 0.64, h));
  // the warm lobe lives on the SUN'S SIDE of the sky and dies with altitude —
  // this is what makes a sunset read as directional rather than as a filter
  float lobe = pow(max(dot(d, uSunAz), 0.0), 3.0) * (1.0 - smoothstep(0.0, 0.44, h));
  c = mix(c, uGlow, lobe * uGlowK);
  gl_FragColor = vec4(c, 1.0);
}
```

**Stops** — replace the `SKY` table at `town.js:1856-1860`:
```js
const SKY = {
  zenDay:   new THREE.Color(0x2E64B4), midDay:  new THREE.Color(0x6FA3DC), horDay:  new THREE.Color(0xB4D2E8),
  zenNight: new THREE.Color(0x05070F), midNight:new THREE.Color(0x0B1222), horNight:new THREE.Color(0x18233A),
  glowWarm: new THREE.Color(0xFFC078), glowDusk: new THREE.Color(0xE0693A)
};
```
`uGlow = glowWarm.lerp(glowDusk, glowK)`, `uGlowK = clamp(glowK * 0.95, 0, 0.95)`.

**Acceptance (this is objective and headless-checkable):** with
`node px.mjs <shot> 260 150 800 40`, the noon strip must be **monotonically
non-increasing in L from y=150 to the land**, with zenith L in **95..115** and the
horizon band L in **150..180**. Today it *increases* by 23 levels from top to
horizon. This is the whole item.

**⚠ Colour-space gotcha, read before touching any `ShaderMaterial`.** The sky
dome (`town.js:237`), the veil (`environs.js:687`), the environs cloud/mote
shaders (`environs.js:965`, `:1051`) and the monument's additive materials all
write `gl_FragColor` directly and include **neither** `<tonemapping_fragment>`
**nor** `<colorspace_fragment>`. Today that means they bypass output encoding
entirely and land on screen by accident. **Under the post pass they render into a
linear RT and get encoded once at the end, so their on-screen appearance will
change.** That is correct — but it means:

1. **Do not** add `<colorspace_fragment>` to any of them. They must stay linear.
2. **Do** re-author their stops after L1 lands, against the acceptance numbers
   above. The values in this section are *targets in final screen sRGB*; feed
   them as `new THREE.Color(hex)` (which converts sRGB→linear under
   `ColorManagement.enabled`, the r160 default) and verify with `px.mjs`.
3. Budget one bring-up session for exactly this. It is the only part of v4 where
   the first render will look wrong and the fix is a number, not a bug.

---

### L7 — The lens · **SHOULD · S**
**Files:** `town.js` (lines 195, 312, 347, 380-384, 397)

Fixes **F12**.

| what | now | v4 | why |
|---|---|---|---|
| fov | `46` | **`38`** | 35 mm-equiv → 43 mm-equiv. Kills the corner keystone in `art-river.png`'s bottom rows, and a longer lens is what makes a model town read as a *model* rather than as a landscape. |
| near | `0.5` | **`1.2`** | with far=2600, near=0.5 spends most of the depth buffer on the first metre. Nothing in the scene is ever within 1.2 units of the camera (min orbit distance is 14). |
| dist formula (`:347`) | `b.r*(1.32 + .13*k) + 20`, clamp 50..500 | **`b.r*(1.63 + .16*k) + 24`, clamp 60..610** | `tan(23°)/tan(19°) = 1.233` — the same town fills the same frame under the narrower lens |
| `pol` default (`:312`) | `0.40` (22.9°) | **`0.46`** (26.4°) | |
| `pol` auto | fixed | **`polWant = 0.38 + 0.20 * clamp(b.r/140, 0, 1)`**, eased at `0.6/s`, suspended once the user drags (new `userPol` flag mirroring `userDist`; `dblclick` at `:397` clears both) | a hamlet gets a low hero angle; a 1200-building city gets a plan-reading 33°. The camera *learns the town's size*, which is a growth reward in itself. |

**Do not** change `fitBias()` or `refreshFraming()`'s bounds logic — the framing
task in the current wave owns those and the only edit here is the one scalar in
the `dist` expression.

---

### L8 — Tilt-shift · **SHOULD · M**
**Files:** `postfx.js` (new) only

The single strongest "this is a toy town" signal in photography, and we already
have the blur machinery.

Pass 7/8 in §2.4: copy `rtScene` to a half-res target, blur it in both axes
(one extra pair of the same 5-tap kernel), then in the composite:

```glsl
// a sharp horizontal band through the subject; blur above and below it
float d = abs(vUv.y - uTiltCenter);
float m = smoothstep(uTiltWidth, uTiltWidth + 0.26, d) * uTilt;
c = mix(c, texture2D(tHalfBlur, vUv).rgb, m);
```

`uTiltCenter` must **track the monument**, not sit at 0.5 — project
`ctx.monumentPos` to NDC once per frame in `town.js` and pass
`tiltCenter = clamp(0.5 - ndc.y * 0.5, 0.28, 0.72)`. `uTiltWidth = 0.20`.
`uTilt` from the grade table (0.30 day / 0.18 night — at night the blur competes
with bloom and both together read as smeared).

**Guardrail:** the blur is applied *before* the bloom add so a blurred lit window
still contributes a crisp bloom kernel — otherwise the out-of-focus parts of the
town lose their lights, which looks broken rather than shallow.

Drop entirely at `quality:'med'`.

---

### L9 — Cobbles and the plaza plate · **SHOULD · S**
**Files:** `layout.js` (`paintGround`, the plaza/road fill only)

The road plate is a 2048² canvas repainted a few times an hour
(`town.js:270-305`) — a 2-D canvas change is free at runtime, and it is the only
place in the app where a *real* texture is cheap.

Add, after the existing lane/plaza fills, before the restore:
- **plaza cobbles:** ~1400 seeded ellipses, `rx 4..9 px`, alpha `0.05..0.11`,
  alternating ±6 % lightness, clipped to the plaza disc. At `ROAD_PX ≈ 3.6 px/unit`
  that is a ~2 unit stone — correct for a town square at the working framing.
- **lane wear:** two 1.5-unit-wide darker ruts down each paved edge, alpha 0.06,
  drawn as a stroked path offset ±0.55 units from the lane centreline.
- **verge scuff:** a 2-unit `rgba(0,0,0,0.05)` feathered stroke just outside every
  lane edge, so the road does not meet the grass on a hard line.

All seeded from `planSeed` so it is stable across repaints. Zero per-frame cost.
This is `art-river.png`'s biggest remaining flat area after the sky.

---

### L10 — Water that reads as water · **SHOULD · S**
**Files:** `environs.js` (`waterMat.onBeforeCompile`, ~line 730) · `buildings.js` (`MAT.water`, line 361)

Fixes **F9**. One fresnel term against the sky colour we already have:

```glsl
// into '#include <opaque_fragment>' (before it), in waterMat's patch
float wF = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
outgoingLight = mix(outgoingLight, uSkyMid, wF * 0.62);
// and a tight specular lobe for the sun/moon streak (uSun is already a uniform here)
float wS = pow(max(dot(reflect(-normalize(vViewPosition), normalize(vNormal)), uSun), 0.0), 90.0);
outgoingLight += uSunCol * wS * 1.8;
```
`uSkyMid` is a new uniform fed from L6's `uMid`. With bloom on, the specular
streak blooms — a river that catches the sunset is worth more than any other
single environs change.

Also raise `MAT.water` / `waterMat` `metalness` to `0.35` and drop `roughness`
to `0.12`: with a fresnel-mixed sky standing in for the missing env map, higher
metalness is now legitimate rather than "renders black".

---

### L11 — Shadow map tuning · **SHOULD · S**
**Files:** `town.js` (lines 202-205, 355-357)

The map is fine; the settings are conservative for a *hard* light and we now have
a much harder light.

- `sun.shadow.mapSize.set(2048, 2048)` → keep. At `ext=74` that is 0.072 units
  per texel (7 cm) — better than most shipped games.
- `sun.shadow.bias = -0.0014` → **`-0.0006`**, and add
  **`sun.shadow.normalBias = 0.045`**. The current bias is large enough to peel
  the contact point off the ground (which is a *second* cause of F3, on the
  buildings that *do* cast). `normalBias` is the correct tool and r160 supports it.
- `sun.shadow.radius = 2.5` (PCFSoft honours it) — softer edges match the toy
  look and hide the frustum's outer boundary where the cast shadows hand over to
  L4's blobs.
- Keep `ext = Math.min(b.r, 62) + 12` and the band-4 cutoff. **Do not** widen
  them; L4 exists so that we never have to.
- Add a one-line hand-over: `if (e.band > 4) …castShadow = false` already runs at
  `town.js:874`; make sure `grounding.place()` is called for **every** entity
  regardless of band, so the blob is there when the map is not.

---

### L12 — Night: a moon, and the town's own glow · **SHOULD · S**
**Files:** `town.js` (lines 207-233, 1916-1926) · `environs.js` (ground shader, ~line 665)

Fixes **F11** and the dead ground in `c-night-plat.png`.

**12a. Moon disc + halo**, mirroring `sunBall`/`sunHalo` exactly
(`town.js:212-221`) so there is one idiom, not two:
```js
const MOON_R = 700;
const moonBall = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ map: makeMoonTexture(), fog: false }));
moonBall.scale.setScalar(13);
const moonHalo = /* makeGlowTexture(), color 0xBBD2F0, opacity .22, scale 90 */;
```
`makeMoonTexture()`: a 128² canvas, `#E8ECF4` disc, three or four soft grey maria
at seeded positions, plus a terminator drawn as a `globalCompositeOperation:
'destination-out'` offset circle whose offset is
`phase = ((doy + 11) % 29.53) / 29.53`. The moon is **full on the 15th of each
month** and the user will notice, which is the entire point.
Position it opposite the sun: `moonBall.position` from `-_sd` with the same
`SUN_EL_MIN`-style elevation floor, `visible = night > .05`.

**12b. Town glow on the ground.** Add to the environs ground fragment, at the end
of the `<map_fragment>` block:
```glsl
// after dark the town lights its own field. Without this the grass 40 units
// from a blazing plaza is the same value as the grass 400 units away, and the
// town reads as a lit sticker on black paper.
float gGlow = uNight * 0.55 * (1.0 - smoothstep(uGlowR.x, uGlowR.y, length(vWPos.xz - uCenter)));
diffuseColor.rgb += uGlowCol * gGlow;
```
`uGlowCol = vec3(0.055, 0.038, 0.018)` (a warm lamp colour, deliberately tiny),
`uGlowR = vec2(ctx.outerR * 0.35, ctx.outerR * 1.55)`. With bloom on, this reads
as a real sodium haze around the settlement.

---

### L13 — "Prosperity heat": the grade responds to the number · **SHOULD · S**
**Files:** `postfx.js` (new) · `town.js` (one line in `tick`)

The only item here that is about *fun* rather than about *correct*, and it is
the cheapest one in the document.

```js
/** 0..1. Rich days literally look richer. */
function heatOf(ctx) {
  const p = clamp((prosperity(ctx.totalTok) - 1) / 6, 0, 1);      // Prosperity I..VII
  const pace = clamp((ctx.paceRatio - 0.8) / 1.6, 0, 1);          // vs. the previous session
  return clamp(p * 0.65 + pace * 0.35, 0, 1);
}
```
Applied inside `gradeFor` after the day-part blend:
```js
out.saturation += 0.085 * heat;
out.bloom      += 0.18  * heat;
out.contrast   += 0.045 * heat;
out.gain.r     += 0.030 * heat;   // and gain.b -= 0.020 * heat
```
Ceiling on everything so a 1B day cannot go neon: clamp `saturation ≤ 1.32`,
`bloom ≤ 1.30`. The effect is small per-step and enormous end-to-end: a quiet
Tuesday morning is cool, flat and grey-green; a 1.2B night is a warm, glowing,
high-contrast poster. **The picture is a progress bar.**

Ship it behind the same `?post=` flag, and make sure `heat` is derived from
`ctx` only (no accumulation) so a headless shot at a given total always grades
identically.

---

### L14 — Gold that actually reads as metal · **COULD · S**
**Files:** `buildings.js` (`KIND.metal` line 413, `MAT.gold*` lines 366-368) · `monument.js`

Fixes the rest of **F8**. With no env map, metalness is a dead end — but a
**matcap-ish fake specular** in the surface patch is not:

```glsl
// only on materials flagged role==='metal'
float mF = pow(1.0 - clamp(dot(sN, normalize(vViewPosition)), 0.0, 1.0), 2.0);
float mA = pow(max(dot(reflect(-normalize(vViewPosition), sN), uKeyDirView), 0.0), 42.0);
outgoingLight += uMetalTint * (mA * 2.4 + mF * 0.30);
```
With bloom on, `mA * 2.4` gives the gold drum a travelling highlight as the
camera orbits — which is the difference between "gold-coloured" and "gold". Also
raise `KIND.metal.metalness` 0.25 → 0.55 and drop `roughness` 0.35 → 0.22 once
the fake specular exists. Fixes the Mach banding on the ledger drum in
`z-day-mon.png` too, because the ramp is no longer the only thing on the surface.

---

### L15 — Sun shafts at golden hour · **COULD · M**
**Files:** `postfx.js`

A radial-blur god-ray pass from the sun's screen position, sampled from the
bloom's 1/4-res bright buffer (which already contains the sun ball and nothing
else bright near the horizon). 12 taps, ~0.3 ms, gated to `glowK > 0.25 && sunNdc
is on screen`. High risk of looking cheap; build it last, behind
`?post=high&rays=1`, and cut it if it reads as a filter.

---

### L16 — Weather in the grade · **COULD · S**
**Files:** `postfx.js` · `environs.js` (`st.haze` / `st.cast` are already tracked, lines 1462-1473)

environs already computes `haze` and `cast` (overcast) weights and already warms
the fog with them. Feed them into `gradeFor` as a fourth axis: overcast →
`saturation -= 0.18, contrast -= 0.10, bloom -= 0.10`; haze →
`lift += (0.008, 0.006, 0.004), contrast -= 0.06`. Three lines, and the weather
system finally shows up in the *photograph* rather than only in the fog.

---

## 4. Ranked summary

| # | item | rank | size | files touched |
|---|---|---|---|---|
| L1 | Exposure, tone curve, light rebalance | **MUST** | M | **`postfx.js`*** · `town.js` |
| L2 | Bloom (2 octaves, soft knee, firefly clamp) | **MUST** | M | **`postfx.js`*** |
| L3 | Grade + in-shader vignette + CSS handshake | **MUST** | S | **`postfx.js`*** · `index.html` · `environs.js` |
| L4 | Blob contact shadows | **MUST** | M | **`grounding.js`*** · `town.js` |
| L5 | Rim / base AO / world grain / far-value match | **MUST** | M | **`surface.js`*** · `buildings.js` (3 lines) · `environs.js` (1 getter) |
| L6 | Sky: 3 stops + sun lobe + horizon band | SHOULD | M | `town.js` |
| L7 | Lens: 38° fov, near 1.2, size-aware pitch | SHOULD | S | `town.js` |
| L8 | Tilt-shift | SHOULD | M | **`postfx.js`*** |
| L9 | Cobbles, lane wear, verge scuff | SHOULD | S | `layout.js` |
| L10 | Water fresnel + specular streak | SHOULD | S | `environs.js` · `buildings.js` (1 line) |
| L11 | Shadow bias / normalBias / radius | SHOULD | S | `town.js` |
| L12 | Moon disc + phase; night town-glow | SHOULD | S | `town.js` · `environs.js` |
| L13 | Prosperity heat in the grade | SHOULD | S | **`postfx.js`*** · `town.js` |
| L14 | Fake specular for gold | COULD | S | **`surface.js`*** · `buildings.js` · `monument.js` |
| L15 | Sun shafts | COULD | M | **`postfx.js`*** |
| L16 | Weather in the grade | COULD | S | **`postfx.js`*** · `environs.js` |

`*` = new file, no collision risk.

---

## 5. Build order and parallelism

**Must be built first, in this order** (everything else depends on it):

```
    L1 ── L2 ── L3 ── L8 ── L13 ── L15/L16      (all inside postfx.js, one owner)
     │
     └─ L5 ── L14                               (surface.js, one owner)
```

**L1 and L5 must land in the same commit.** L1 alone takes key:fill from 2.7:1 to
5.7:1 with no rim light to catch the shadow side; the intermediate state is
*worse* than today. Treat them as one deliverable with two files.

**Fully parallel from day one** (no shared file with the above):

| owner | items | files |
|---|---|---|
| A | L1 L2 L3 L8 L13 (L15 L16) | `postfx.js` (new) + ~6 lines of `town.js` |
| B | L5 L14 | `surface.js` (new) + 3 lines of `buildings.js` |
| C | L4 | `grounding.js` (new) + `mountEnt`/`hardReset` in `town.js` |
| D | L6 L7 L11 L12a | `town.js` (sky/camera/lights/moon blocks) |
| E | L9 | `layout.js` (`paintGround` only) |
| F | L10 L12b | `environs.js` (water patch, ground patch, `landFar()` getter) |

**`town.js` contention.** Owners A, C and D all touch it. Their hunks are
disjoint and far apart:
- **A**: `:181` (renderer flags), `:1872` (resize), `:2147-2148` (render call),
  plus one `import`.
- **C**: `mountEnt` ~`:860-880`, `hardReset`, one line in the 500 ms stats block
  ~`:2057`.
- **D**: `:195` `:200-233` (camera + lights + sky dome), `:312` `:347` `:380-397`
  (orbit), `:1856-1926` (the day/night block).

Land **A first** (it is the smallest `town.js` footprint and everyone else's work
is invisible without it), then **D**, then **C**. B, E and F never conflict.

---

## 6. Performance

**Budget:** 60 fps at 1200 buildings + 160 NPCs, measured on this machine's iGPU.

| pass | resolution | cost estimate @ 2560×1690 |
|---|---|---|
| scene → `rtScene` | full, 4× MSAA | +0.35 ms vs. direct (resolve + bandwidth) |
| bright | 1/4 | 0.10 ms |
| blur ×2 | 1/4 | 0.18 ms |
| blur ×2 (octave 2) | 1/8 | 0.06 ms |
| tilt copy + blur ×2 | 1/2 | 0.42 ms |
| composite | full | 0.30 ms |
| **total, `high`** | | **≈ 1.4 ms** |
| **total, `med`** (no octave 2, no tilt) | | **≈ 0.9 ms** |
| L4 blobs | — | 1 draw call; 0.35 ms **only** on a sun-move sweep, ≤ 2 Hz |
| L5 surface patch | — | **0 draw calls, 0 new materials**; ~14 extra ALU ops/fragment |

**Auto-downgrade ladder** (in `postfx.js`, private):

```js
// rolling mean of the last 60 frame times
if (quality === 'high' && frames > 200 && mean > 20 && sustained(90)) setQuality('med');
if (quality === 'med'  && frames > 400 && mean > 24 && sustained(120)) setQuality('off');
// never auto-upgrade within a session — oscillation is worse than the slower tier
```

**⚠ The headless rule.** A `--shot` run paints at ~3 fps by design
(`CLAUDE.md`), so *every* frame-time heuristic sees 300 ms frames. The
`frames > 200` gate is what stops the downgrade from firing in a 7-second
screenshot run (which sees ~21 frames) and silently invalidating every
verification shot the team takes. **Do not replace the frame counter with a
wall-clock timer.** State this in a comment at the call site; it is exactly the
class of bug this codebase's comments exist to prevent.

---

## 7. Verification (offscreen only — never open a window)

```powershell
cd <repo>\town
$S = "%TEMP%\claude\<project>\<session-id>\scratchpad"
npx electron . --shot=$S\v4-noon.png   --shot-delay=8000 --hour=12
npx electron . --shot=$S\v4-golden.png --shot-delay=8000 --hour=19
npx electron . --shot=$S\v4-night.png  --shot-delay=8000 --hour=23
npx electron . --shot=$S\v4-off.png    --shot-delay=8000 --hour=12   # + ?post=off
node $S\lookdev-hist.mjs $S\v4-noon.png $S\v4-golden.png $S\v4-night.png
node $S\px.mjs $S\v4-noon.png 260 150 800 40
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

**Acceptance gates.** v4 is not done until `lookdev-hist.mjs` reports:

| shot | metric | today | **gate** |
|---|---|---|---|
| noon | `p5..p95` L span | 61 | **≥ 130** |
| noon | % in L 90..190 | 95.5 % | **≤ 62 %** |
| noon | % above L 220 | 0.0 % | **≥ 1.5 %** |
| noon | `p1` | 22 | **≤ 26** |
| golden | `p5..p95` span | 49 | **≥ 115** |
| golden | % above L 220 | 0.0 % | **≥ 2.0 %** |
| night | % above L 200 | 0.1 % | **≥ 0.8 %** |
| night | % below L 40 | 92.0 % | **82 %..90 %** (stay dark) |
| noon | `px.mjs` strip y=150→land | +23 L (inverted) | **monotonically non-increasing** |

Plus the eyeball gates, which no script can check: a house must visibly sit *in*
the grass; a lit window at night must have a halo; the river must not be a road;
the sky must be darkest at the top of the frame.

---

## 8. Risk register

1. **Colour space of the raw `ShaderMaterial`s** (§L6's warning). The first
   post-enabled render *will* show a different sky, veil and mote brightness.
   This is expected, is a one-session re-tune, and is the reason L6's acceptance
   criterion is a pixel measurement rather than a hex value.
2. **`AdditiveBlending` in an HDR buffer.** Every additive effect in the app
   (`town.js:218`, `:410`, `:532`, the monument's beacon/shockwave, environs'
   motes) currently sums into a clamped 8-bit target and is implicitly limited.
   In a half-float target they sum without limit and then get tone-mapped. Net
   effect: **additives will get softer, not brighter** (the shoulder eats them).
   Expect to raise the particle and beacon opacities ~20-35 % after L1. Budget it.
3. **MSAA on the RT.** If `isWebGL2` is ever false, `samples` is ignored and we
   lose antialiasing on a scene made of straight edges. The FXAA branch in the
   composite is not optional insurance — implement it, gate it on
   `samples === 0`, and verify it once by forcing the flag.
4. **`mergeStatic` has no UVs.** Anyone who proposes a texture map on a building
   in a later wave must first add a UV channel to `concatMeshes`
   (`buildings.js:490`). L5's world-space approach exists so v4 never has to.
5. **`shadowMap.autoUpdate = false`.** L11's `normalBias` change takes effect
   only on the next `needsUpdate` (the 500 ms stats timer, `town.js:2060`). Do
   not "fix" a stale-looking shadow by re-enabling `autoUpdate` — that costs a
   full depth pass every frame at 1200 casters.
6. **Two vignettes.** §L3's handshake. If both are live the corners crush to
   black and nobody will be able to tell which owner to blame.
7. **Grade continuity across an epoch change.** `gradeFor` is pure and reads
   `ctx`, and epoch changes already run through a fade
   (`town.js:1930-1943`). No extra work — but do not cache the `Grade` object per
   epoch, or a range switch will keep the old town's heat.

---

## 9. Fallback ladder (if the render target proves too expensive)

**9.1 `quality:'med'`** — drop the second bloom octave and tilt-shift. Keeps L1,
L2 (one octave), L3, L13. ~0.9 ms. This is very likely sufficient on any machine
that can already draw the town.

**9.2 `quality:'off'`** — **no render target at all.** `postfx.render()` becomes
`renderer.render(scene, camera)` and:
```js
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
```
Restore environs' CSS vignette (§L3). We lose bloom, tilt-shift and dithering;
we keep **L1's light rebalance, the whole of L4, the whole of L5, L6, L7, L9,
L10, L11, L12** — i.e. eight of the thirteen items and a large majority of the
improvement, because most of this design is material and lighting work, not post
work. That is deliberate: the post pass is the biggest single win but nothing
else is hostage to it.

**9.3 FXAA branch.** A 5-tap luma FXAA in the composite, compiled in under
`#ifdef FXAA` and enabled only when `rtScene.samples === 0`. ~0.15 ms.

---

## 10. Copy (the two strings this touches)

The look-dev work is silent, with two exceptions worth writing well:

- **Crier line on the first golden hour of a session**, fired when
  `glowK` crosses 0.5 upward with `gotData`:
  > *"The light went long and gold across the rooftops. Nobody got anything done for a minute."*

- **Crier line on the first full moon** (L12a, when `phase` is within 1 day of
  full and `night > .5` for the first time that evening):
  > *"Full moon over {name}. Half the town is out looking at it instead of building anything."*

Both belong in `news.js`'s ambient corpus, owned by that area's implementer —
listed here only so the look-dev work is not invisible in the ticker.
