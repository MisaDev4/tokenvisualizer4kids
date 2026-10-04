# Token Town v3 — THE ENVIRONS

**Owner:** environs. **File:** `town/src/renderer/environs.js` (new, one file, no deps).
**Mandate:** everything outside the town's built extent. Today that is a 900-radius lawn with
42 random conifer clumps and nothing else — the user's words: *"the outside area not relating
to the town looks kinda bad — empty; maybe it fades out."*

**The thesis.** "Empty" is not solved by more grass or by a bigger fog number. It is solved by
two things working together:

1. **The fade** — the world must *stop being interesting* on a schedule that tracks the town's
   size, so the eye is pulled inward and the horizon never reads as an edge or a wall.
2. **Content, not terrain** — the ring just past the last house must be *farmed*: fields,
   hedgerows, lanes petering out, orchards, haystacks. A 20-house village surrounded by four
   fields and a hedgerow reads as a *place*; the same village on a lawn reads as a bug.

Everything below serves those two, in **≤ 8 draw calls**, with **~6 uniform writes per frame**
and **zero per-frame allocations**.

---

## 0. Non-negotiables inherited from the project

* **`dt` is ignored.** `update(dt, now, ctx)` accepts `dt` for signature symmetry and never
  reads it. All motion (cloud drift, bird loops, blade sway, firefly loops) is computed in
  **vertex shaders from one `uTime` uniform fed by `performance.now()`**. A 1-fps headless
  shot therefore shows clouds, birds and fireflies at *correct* positions, not bunched at
  their spawn point. This is stronger than the project rule and it also happens to be the
  fastest implementation.
* **Existence is instant.** Fields/trees/blades are generated once at `init` for the maximum
  extent and *revealed* by parking unwanted instances at `y = -999` (town.js's existing
  `revealScatter` idiom). `setExtent` never animates anything in.
* No new npm deps; every texture is canvas-generated like the rest of the codebase.
* r160 physical lights: **environs creates zero lights.** Night is a uniform, not a lamp.
* `castShadow = false` on every environs object. `receiveShadow = true` on the ground only.
* Terse, intent-commented style. No file outside `environs.js` is written by this owner
  except the six one-line core touchpoints in §9.

---

## 1. THE FADE — four cooperating layers

Any one of these alone fails. Stated in the order the eye meets them.

### 1.1 Ground albedo + detail falloff (baked, camera-independent)

The ground is **one radial-grid disc** (§3.1). Every vertex carries a static `aTint`
(biome mottling + macro patch noise) and a static `aHill`. The fragment shader mixes the lit
albedo toward the **live fog colour** by a radius term:

```glsl
// injected into MeshStandardMaterial via onBeforeCompile
float fadeK = smoothstep(uFade.x, uFade.y, vRad);          // uFade = (E*2.4, E*6.0 + 260.0)
diffuseColor.rgb  = mix(diffuseColor.rgb * vTint, uFogCol, fadeK * 0.92);
```

Because this is a *radius* term, not a camera-distance term, the terrain is **literally
painted fog colour** at the rim no matter where the camera is. This is the layer that does the
heavy lifting, and it is why scene fog can stay light enough to keep the town crisp.

The same pass kills tiling: `vTint` carries 2 octaves of seeded value noise at ~90 and ~340
world-unit wavelengths, so the 13-unit grass tile stops being readable as a grid long before
it stops being visible. Detail is *removed with distance*, which is what "fades out" means.

### 1.2 Scene fog, retuned against camera distance

`FogExp2` is uniform in space, so it cannot make the countryside hazier than the town. Its
only job now is aerial perspective on the *buildings*. New law, exported so there is one
authority:

```js
export const fogFor = (dist, biome) =>
  clamp(0.0016 * Math.pow(62 / dist, 0.30) * biome.fogMul, 0.0009, 0.0032);
```

At the launch framing (dist 62) that is .0016 — half of today's, because §1.1 now buries the
horizon. At a nine-ring framing (dist ~205) it is .0011, and the town stays readable instead
of drowning. `biome.fogMul` is 1.0 for most biomes, **1.35 for `misty`**.

### 1.3 Content falloff

Instances thin out on a schedule keyed to `E = bounds.outer` (§4.1). The last populated band
gets **scaled-down and fog-tinted** instances rather than a hard stop: flora in
`[E*3.2, E*4.5+220]` is scaled `0.55..0.15` and its `instanceColor` is lerped 70 % toward the
biome's fog tint, so copses dissolve rather than disappear. Nothing exists beyond
`E*4.5 + 220`, which is always well inside where §1.1 has reached 1.0.

### 1.4 The veil (the hard-edge guarantee)

An open-ended, back-faced cylinder standing *inside* the disc rim:

```
CylinderGeometry(940, 940, 150, 96, 1, true), side: BackSide, y from -10 to +140
alpha ramp: 1.0 at the bottom → 0.0 at the top (vertical gradient texture, 8×128)
fog:false, depthWrite:false, transparent, renderOrder 3
material.color.copy(scene.fog.color) every frame   ← the one thing that must be per-frame
```

The disc is 1200 in radius, so the rim is always *behind* the veil and can never be seen. The
veil's colour is the sky's own bottom colour (town.js already drives `scene.fog.color` from
`skyMat.uniforms.bot`), so ground and sky meet in a seam that is exactly zero contrast at
every hour, including the golden hour where a fixed colour would be catastrophic.

Depth interaction checked: the sun ball (opaque, r 720, y ≥ 213) is *in front of* the veil and
writes depth first, so it is never veiled. The sky dome (r 820) is behind it, which is what we
want — the veil is the horizon haze band.

### 1.5 Vignette — zero draw calls

Not a fullscreen quad. A CSS pseudo-element on `#stage`:

```css
#stage::after{ content:''; position:absolute; inset:0; pointer-events:none;
  background: radial-gradient(ellipse 78% 68% at 50% 46%,
     transparent 55%, rgba(4,7,14,calc(var(--vig,.22) * .55)) 84%, rgba(4,7,14,var(--vig,.22)) 100%); }
```

`update()` writes `--vig` (0.16 by day → 0.34 at night) at most 4× per second. Free, correct
under every resolution, and it never touches the depth buffer.

---

## 2. PUBLIC API — `environs.js`

```js
import * as THREE from './vendor/three.module.js';

/* ── biomes ─────────────────────────────────────────────────── */

/**
 * The day's palette. Subtle by design: nothing here lerps more than 0.22 away from the
 * base art direction, so a different day feels different without feeling like a mod.
 * @typedef {Object} Biome
 * @property {string} id            'lush'|'goldrush'|'misty'|'heather'|'spring'
 * @property {string} label         'verdant'|'late summer'|'morning mist'|'heath'|'new green'
 * @property {number} grass         0xRRGGBB base tint multiplied into the grass canvas
 * @property {number[]} fields      atlas cell ids this biome may plant, weighted by order
 * @property {number} tree          0xRRGGBB foliage tint
 * @property {number} fogTint       0xRRGGBB nudged into the fade colour (0.12 max)
 * @property {number} fogMul        FogExp2 density multiplier (misty = 1.35)
 * @property {number} clouds        cloud instance count, 8..17
 * @property {number} wind          0.6..1.4 blade sway + cloud speed multiplier
 * @property {number} mote          0xRRGGBB day pollen colour (night fireflies are fixed)
 */
export const BIOMES;                    // frozen Record<string, Biome>

/** Deterministic pick from the day seed. Weights: lush .30 goldrush .25 misty .15
 *  heather .15 spring .15. @param {number} seed @returns {Biome} */
export function biomeFor(seed);

/** THE fog authority — town.js's refreshFraming calls this instead of its own literal.
 *  @param {number} dist camera distance @param {Biome} biome @returns {number} density */
export function fogFor(dist, biome);

/* ── the plan the layout owner hands us ─────────────────────── */

/**
 * Everything optional. A missing plan (or a missing field) is synthesised from the seed as a
 * `ring` archetype, so environs ships and screenshots correctly BEFORE the layout module
 * lands. Never throw on a malformed plan.
 * @typedef {Object} TownPlan
 * @property {number} [seed]         day-stable integer; defaults to today's yyyymmdd
 * @property {string} [archetype]    'ring'|'river'|'crossroads'|'hillfort'|'lakeside'
 * @property {Array<{a:number, curve?:number, width?:number}>} [spine]
 *           outbound road directions in radians; lanes and field grain align to these
 * @property {?{kind:'river'|'lake', path:Array<{x:number,z:number}>, width:number}} [water]
 *           river = an open polyline through the world; lake = a closed polygon.
 *           Coordinates are world units; the path may pass through the town.
 * @property {(n:number)=>{inner:number,outer:number,hull?:Array<{x:number,z:number}>}} [boundsFor]
 */

/* ── init ───────────────────────────────────────────────────── */

/**
 * Build the world outside the town and add it to the scene. This is the `init` of the brief;
 * the name follows initMonument/initNPCs house style.
 * @param {THREE.Scene} scene
 * @param {TownPlan} plan
 * @param {{maxAnisotropy:number, quality?:'high'|'low', groundR?:number}} opts
 *        quality 'low' halves blades/motes and drops cloud shadows. Default 'high' —
 *        headless shots MUST run high so the screenshot shows everything.
 * @returns {Environs}
 */
export function initEnvirons(scene, plan, opts);

/**
 * @typedef {Object} Environs
 * @property {THREE.Group} group    added to the scene by initEnvirons
 * @property {Biome} biome          resolved, read-only — town.js passes it to fogFor
 * @property {string} archetype     resolved archetype id, read-only
 *
 * @property {(bounds:{inner:number,outer:number,hull?:Array})=>void} setExtent
 *   The town grew. Idempotent and safe to call every frame: it early-outs unless
 *   |outer - lastOuter| > 2. On a real change it re-parks instances by band and writes
 *   uFade/uFlat — no geometry is rebuilt, no allocation occurs. ~0.15 ms.
 *
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 *   Reads ctx.night, ctx.day and ctx.camera. Writes uniforms only. `dt` IS IGNORED (§0).
 *
 * @property {(x:number, z:number)=>number} sampleHeight
 *   Terrain height, matching the vertex shader exactly. 0 inside r < 150 (the flat plate),
 *   and 0 anywhere the town can build. For anyone placing props outside.
 * @property {(x:number, z:number)=>boolean} isWater
 *   True inside the river/lake footprint + 1.2 units of bank. Layout and NPC owners use this
 *   to keep roads and villagers dry.
 * @property {()=>Array<{x:number,z:number,a:number}>} getCrossings
 *   Points where a spine crosses the water, with the crossing angle. Bridges are ROAD
 *   infrastructure — the layout owner builds them, we just say where.
 *
 * @property {()=>Array<{w:number,text:string}>} news
 *   Weighted countryside headlines that MATCH WHAT IS ON SCREEN (§8) — the ticker owner's
 *   hook into the world. Cheap; call it when the ticker wants a line.
 *
 * @property {(seed:number)=>void} setSeed
 *   Day rollover. Re-picks the biome and archetype and rebuilds attributes in place
 *   (geometry buffers are reused; ~4 ms, once a day, during the existing 2 s fade-out).
 * @property {()=>void} dispose
 */
```

---

## 3. THE EIGHT DRAW CALLS

| # | object | type | always? | instances / tris |
|---|---|---|---|---|
| 1 | `ground` | Mesh, MeshStandardMaterial + `onBeforeCompile` | yes | 15.5k tris |
| 2 | `fields` | InstancedMesh, ShaderMaterial (ground decals) | yes | ≤ 126 |
| 3 | `blades` | InstancedMesh, ShaderMaterial (swaying crop cards) | yes | ≤ 900 |
| 4 | `flora` | InstancedMesh, MeshStandardMaterial `vertexColors` | yes | ≤ 1600 |
| 5 | `sky` | InstancedMesh, ShaderMaterial (clouds **+** birds) | yes | ≤ 34 |
| 6 | `motes` | Points, ShaderMaterial (pollen / fireflies) | yes | 160 |
| 7 | `veil` | Mesh, ShaderMaterial | yes | 192 tris |
| 8 | `water` | Mesh, MeshStandardMaterial + `onBeforeCompile` | only if `plan.water` | ≤ 900 tris |

**7 draw calls on a dry plan, 8 with water.** Every one of them is also removed from
town.js's budget or is new: town.js loses its `grass` mesh (1) and its three countryside tree
scatters (3), so the *net* change to the frame is **+3 / +4 draw calls** for an entire world.

### 3.1 `ground` — the disc

Replaces town.js's `grass`. Radial grid, **72 rings × 108 spokes**, radii
`r_i = 1200 * (i/72)^2.4` — 30 of the 72 rings sit inside r < 200, so the town's plate is
finely tessellated and the far country is cheap. UVs are planar with the same 13-unit world
period the current grass texture uses, so the road decal keeps sitting on the same-looking
lawn.

Static per-vertex attributes, all computed once and rewritten only by `setSeed`:

* `aTint` (vec3) — biome grass tint × macro value-noise mottling (2 octaves, λ ≈ 90 and 340)
  × archetype patches (water meadows near a river read wetter and darker).
* `aHill` (float) — terrain height. **Zero for r < 150.** Then:
  * `150 → 300`: meadow undulation, amplitude ≤ 1.2, λ ≈ 120. (Invisible under the road
    decal because the decal is transparent out there, and the decal is now a disc — §9.)
  * `380 → 900`: **distant hills** — 4–6 seeded Gaussian domes, height 12–50, σ 90–260, plus
    fbm at ±6. This is the layer that breaks the flat horizon. They are big, soft and
    *always* partly eaten by the veil, which is exactly the silhouette we want.
* `aHillN` (vec3) — the analytic normal of `aHill`, so lighting matches the displacement
  without a normal rebuild.
* `aCarve` (float) — a negative bowl along the water path, **not** multiplied by the flatten
  factor, so a river cuts a real channel even where it crosses the flat town plate.

Vertex injection:

```glsl
float flat_ = smoothstep(uFlat.x, uFlat.y, vRad);     // uFlat = (150, 300) — see §1.3 note
transformed.y += aHill * flat_ + aCarve;
objectNormal   = normalize(mix(vec3(0.,1.,0.), aHillN, flat_));
```

`sampleHeight(x,z)` reimplements this on the CPU from the same seeded noise, so props placed
by other owners land on the ground and not in it.

### 3.2 `fields` — the farmland decals

`PlaneGeometry(1,1)` laid flat at `y = 0.035`, `transparent`, `depthWrite:false`,
`polygonOffset:true`, `renderOrder 1`. One **1024² canvas atlas, 4×4 = 16 cells**, all
procedurally drawn with the same primitive vocabulary as `makeGrassTexture`:

```
0 wheat-a   1 wheat-b   2 lavender   3 plough
4 stubble   5 fallow    6 root-rows  7 meadow-flowers
8 orchard-grid  9 bare-dirt  10 lane-strip  11 farmyard
12 pond      13 hedge-shadow 14 haystack-cluster 15 cloud-shadow (soft dark blob)
```

Every cell has a **torn alpha edge** (radial noise mask) so no field ever reads as a
rectangle. Instances are placed on a seeded jittered grid whose axes are **rotated to the
nearest spine direction**, so the countryside looks *surveyed* — the single cheapest trick
that makes farmland look like farmland. Size 14–46 units, count
`min(120, round(18 + 0.55 * E))`, plus 6 `cloud-shadow` instances.

Those 6 carry a live `aOrbit` (§3.5) matched to 6 of the clouds, so **cloud shadows drift
across the fields** for zero extra draw calls. This is the flourish that sells the whole
landscape; ship it, but ship it last.

### 3.3 `blades` — the thing that moves

Per instance: a tiny merged geometry of **3 crossed quads** (6 tris) with an alpha wheat/grass
card. Placed only inside field patches whose centre is within `1.6 E` — LOD by
*distance-from-town*, not from camera, so it is deterministic and screenshot-safe.
Count `min(900, round(90 + 3.2 * E))`, height 0.9–1.6.

```glsl
float k = pow(uv.y, 2.0);                             // roots don't move
float g = 0.6 + 0.4 * sin(uTime * 0.00027);           // gusts
p.xz += aSway * uWind * g * k * vec2(sin(uTime*0.0016 + w.x*0.06 + w.z*0.04),
                                     cos(uTime*0.0013 + w.z*0.05));
```

`uWind = biome.wind * (1 - 0.6 * uNight)` — the fields settle down after dark.

### 3.4 `flora` — trees, hedgerows, orchards, reeds, sheep

**One merged geometry** = trunk cylinder + two cones + a low sphere skirt, vertex-coloured
(bark / leafA / leafB) so a single `MeshStandardMaterial({vertexColors:true})` covers
everything; `instanceColor` multiplies for variety. The whole countryside vocabulary comes
from scaling that one object:

| use | scale | y | instanceColor |
|---|---|---|---|
| copse tree | (.9–1.5, .9–1.6, .9–1.5) | 0 | biome.tree ±8 % |
| orchard tree | (.7, .8, .7) on a grid inside cell-8 patches | 0 | biome.tree +6 % |
| **hedgerow** | (1.15, **.42**, 1.15), overlapping chain every 2.1 units | **−.35** (trunk buried) | `#3c4a2c` |
| drystone wall (`hillfort`) | (1.0, .30, 1.0) | −.4 | `#8d8878` |
| reed (near water) | (.5, .9, .5) | −.15 | straw `#9a8f5a` |
| willow (river bank) | (1.3, 1.1, 1.3) | 0 | `#5b6b45` |
| sheep (`hillfort`) | (.24, .22, .24) | .1 | `#e6e2d6` |

Count `min(1600, round(240 + 4 * E))`. `castShadow = false` (matches today's forest).
Hedgerows are laid along field borders and along the lanes, which is what makes the
transition from town to country read as *managed land* instead of "the buildings ran out".

### 3.5 `sky` — clouds and birds in one mesh

`PlaneGeometry(1,1)` instanced, raw `ShaderMaterial`, `fog:false`, `depthWrite:false`,
`transparent`, atlas of 8 cells (4 cloud puffs, 2 bird 'v' glyphs, 2 bat glyphs).
Per-instance static attributes only:

```
aOrbit (cx, cz, radius, angularSpeed)      aMisc (altitude, scale, cell, phase)
```

Position, orbit and billboarding are all done in the vertex shader from `uTime`, so the CPU
cost is **one uniform write**:

```glsl
float a = aOrbit.w * uTime * 0.001 + aMisc.w;
vec3 c  = vec3(aOrbit.x + cos(a)*aOrbit.z, aMisc.x, aOrbit.y + sin(a)*aOrbit.z);
// clouds: yaw-only billboard (they must never tip). birds: full billboard + a bob.
```

* **Clouds**: `biome.clouds` instances (8–17), altitude 90–180, scale 60–200, orbit radius
  ≤ 620 so they never punch through the r-820 sky dome. Slow (a full lap is 6–14 minutes).
* **Birds**: 3 flocks × 4 glyphs, altitude 30–60, orbit radius 60–220 centred on random
  points, scale 1.6–2.6, one lap every 40–90 s. The per-glyph `phase` offsets give the V.

### 3.6 `motes` — pollen by day, fireflies by night

160 `Points`, `AdditiveBlending`, `depthWrite:false`, `sizeAttenuation:true`. Static `aSeed`
(vec3) only; positions are parametric in the vertex shader from `uTime`, so a headless shot
catches them mid-drift.

* **Day**: warm-white/`biome.mote` pollen, wide slow upward drift over the field belt,
  `size .5`, colour scaled 0.25. Backlit pollen is what additive blending is *for*.
* **Night**: they migrate to hedgerows and — if the plan has water — the banks; `y 0.4–1.8`,
  tight lissajous loops, warm yellow-green `#B8E06A`, `size .95`, and each blinks on
  `0.5 + 0.5*sin(uTime*0.0011 + seed*17.0)` raised to the 4th power, so most are dark most of
  the time and the field twinkles instead of glowing.

Crossfade on `uNight` over the dusk band; both behaviours are always computed and mixed, which
costs nothing and removes a branch.

### 3.7 `water` — only when the plan has one

* **River**: a ribbon mesh from `plan.water.path`, Catmull-Rom resampled every 6 units, width
  `plan.water.width * (1 ± 0.2)` on a slow noise, `y = -0.18` inside the channel carved by
  `aCarve`.
* **Lake**: a triangle fan over the polygon, same material.

`MeshStandardMaterial({roughness:.12, metalness:0, transparent:true, opacity:.88})` with an
`onBeforeCompile` that (a) perturbs the fragment normal with two cheap crossed sine ripple
fields scrolling on `uTime`, (b) adds a specular glint lobe aimed at `uSunDir`, (c) lightens
toward the bank using a per-vertex `aShore` (distance-to-bank, baked), so shallows read
correctly and the water never has a hard outline. Colour `#2f6f86` lush → `#3a5f74` misty.

At night: opacity .8, glint retargeted to the moon direction and narrowed (a hard moon streak
is worth more than any amount of ambient shimmer), plus the firefly migration in §3.6.

---

## 4. HOW IT SCALES AND HOW IT FOLLOWS THE ARCHETYPE

### 4.1 Bands, all keyed to `E = bounds.outer`

| band | radius | contents |
|---|---|---|
| verge | `E .. 1.25 E` | hedgerows, gates, haystacks, lanes leaving on the spine directions and petering out (cell-10 strips shrinking and fading) |
| farmland | `1.25 E .. 2.2 E` | the field patches; **blades only inside 1.6 E** |
| orchards & copses | `2.2 E .. 4 E` | orchard grids, tree clumps thinning on a radial probability, hedgerows ending |
| wildland | `4 E .. E*4.5+220` | sparse copses, scaled 0.55 → 0.15 and fog-tinted (§1.3) |
| distant | `380 .. 900` | hills only (§3.1), independent of `E` |

This is the whole answer to "empty". A 20-house village (`E ≈ 28`) gets its first hedgerow at
35 units and a full field belt by 62 — dense, close, charming. A nine-ring town (`E ≈ 102`)
gets the same composition at 4× the scale. The countryside is never bigger than the town
*deserves*, so it can never dwarf it.

### 4.2 Archetype profiles

| archetype | dressing |
|---|---|
| `ring` *(fallback)* | lanes on the 6 spokes; concentric hedgerow bands; even wedge-shaped fields |
| `river` | water meadows (darker, wetter `aTint`) in the flood plain; willows + reed beds on the banks; fields aligned **parallel to the river**, not to the spines; a mill leat as a lane strip; fireflies at night |
| `crossroads` | 4 long lanes running to the horizon with a **double row of roadside trees**; big rectangular field blocks aligned to the lanes; milestone stones (sheep-scale flora, stone tint) |
| `hillfort` | flat plate shrinks to r 110; three concentric terrace ridges just outside it; drystone walls instead of hedgerows; sheep; fewer trees, more stubble |
| `lakeside` | the lake on one side; reed beds; orchards concentrated on the dry side; the water shader's shore term widened so the lake glows with fog colour at its far edge and merges into the veil |

Unknown archetype string → `ring`. Missing `spine` → 6 spokes at town.js's `SPOKE_A0`.

### 4.3 Biomes

| id | label | grass | fields (weighted) | fogMul | clouds | motes |
|---|---|---|---|---|---|---|
| `lush` | verdant | `#4f6034` | wheat-a, meadow, root, plough | 1.00 | 12 | white |
| `goldrush` | late summer | `#6a6b38` | wheat-a/b, stubble, plough | 1.00 | 8 | amber |
| `misty` | morning mist | `#47563f` desat | fallow, meadow, plough | **1.35** | 16 low | pale blue |
| `heather` | heath | `#55503a` | lavender ×2, fallow, stubble | 1.05 | 11 | violet |
| `spring` | new green | `#506a34` | root, meadow, orchard | 0.95 | 14 puffy | blossom |

Weights `.30/.25/.15/.15/.15`. `biome.wind` is an independent seeded roll (0.6–1.4) so two
`lush` days still differ, and the ticker gets something to talk about.

---

## 5. NIGHT

Everything is one uniform, `uNight = ctx.night`, written to five materials.

* **Ground** — the fragment injection desaturates toward luma and pushes the result into
  indigo: `mix(c, vec3(dot(c, LUMA)) * vec3(.55,.62,1.0), uNight * 0.75)`. Fields go blue
  before the buildings do, which is exactly how dusk reads in life. Hills get a slightly
  higher sky-bleed factor and flatten into indigo cutouts.
* **Fields / blades** — the same indigo mix at 0.6; `uWind` drops 60 %; the fields settle.
* **Flora** — the standard material darkens on its own from the scene lights. Nothing to do.
* **Clouds** — opacity `0.85 → 0.18`, colour lerped to `#6f7d99`; the high cirrus cells stay
  and pick up the moon. Birds fade out entirely below `day 0.15` and 3 **bat** glyphs fade in
  on tighter, jerkier loops.
* **Motes** — the pollen → firefly crossfade of §3.6.
* **Water** — narrowed moon glint; fireflies on the banks.
* **Veil** — follows `scene.fog.color` automatically, so the night horizon is the night sky.
* **Vignette** — `--vig` 0.16 → 0.34.

---

## 6. PERFORMANCE

* **Draw calls**: 7 (dry) / 8 (water). Net change to the frame after town.js's deletions:
  **+3 / +4**.
* **Per-frame CPU**: 6 uniform writes (`uTime`, `uNight`, `uWind`, `uFogCol`, `uSunDir`,
  veil colour) + a CSS var at ≤ 4 Hz. **No matrix composes, no allocations, no attribute
  uploads.** Measured budget: < 0.05 ms.
* **`setExtent`**: early-outs on `|Δouter| ≤ 2`. On a real change it rewrites instance
  matrices in two prealloc'd `Matrix4` scratches and uploads three `instanceMatrix` buffers —
  ~0.15 ms, and it happens once per ring, ≤ 9 times a day.
* **Triangles**: ground 15.5k + blades 5.4k + flora 1600 × ~180 = 288k + fields 252 +
  sky 68 ≈ **310k**. Instanced, one material each, no shadow pass. Comfortable.
* **Memory**: 3 canvas textures (grass 512², field atlas 1024², sky atlas 512²) + an 8×128
  veil ramp ≈ 7 MB.
* `quality:'low'` halves `blades` and `motes` and drops the 6 cloud shadows.

---

## 7. BUILD ORDER (so the thing is useful early)

1. `ground` + `veil` + `fogFor` + the vignette. **This alone fixes the user's complaint** —
   the horizon stops being an edge and the lawn stops being a lawn.
2. `flora` (with hedgerows) + `fields`. Now it is farmland.
3. `blades` + `sky`. Now it is alive.
4. `motes`, biomes, archetype profiles.
5. `water`, cloud shadows, `news()`.

Steps 1–2 are shippable on their own and do not depend on the layout module landing.

---

## 8. `news()` — the ticker's hook into the world

Returns weighted lines that describe **what is actually on screen**, so the economy ticker
never says "a fine harvest" on a day with no fields. Seeded per call from `uTime`, ~14
templates, all filled from live state:

```
{w:3, "the {biome.label} fields are in good heart"}          {w:2, "a stiff breeze off the {dir} fields"}
{w:2, "the {crop} is ready in the {dir} quarter"}             {w:1, "hedgerows trimmed along the {dir} lane"}
{w:2, "cloud over the hills — rain by evening?"}              {w:1, "the mill leat is running fast"}   (river only)
{w:2, "geese over the {dir} road"}                            {w:1, "someone's sheep are out again"}   (hillfort only)
{w:1, "fireflies down by the water tonight"}  (night + water)  {w:1, "first mist on the {dir} meadow"} (misty only)
{w:2, "a new field was broken beyond the {dir} lane"}   ← fired when setExtent adds a band
```

`dir` is a compass word derived from the camera's current azimuth, so the line points at
something the user can see.

---

## 9. THE SIX CORE TOUCHPOINTS (town.js / index.html — for the core owner)

Everything else in this design lives in `environs.js`.

1. **Delete** `grassMat` / `grassGeo` / `grass` (town.js ~387–396) and the countryside tree
   block (~578–594, the `trunks/leafA/leafB` loop and its three `scatter` calls). Keep the
   bush/rock verge scatter — that is town dressing, not countryside.
2. **The road decal must become a disc.** Today it is `PlaneGeometry(700,700)`, whose corners
   reach r 495 and would poke through the meadow undulation. Change to
   `new THREE.CircleGeometry(GROUND/2, 96)` with the same UV rescale already written six lines
   above for the grass disc, and raise it to `y = .03`. This also deletes a large square of
   pure transparent overdraw.
3. `import { initEnvirons, fogFor, biomeFor } from './environs.js';` and, after the lights and
   before the data feed:
   `const env = initEnvirons(scene, plan, { maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });`
4. In `refreshFraming()`: `env.setExtent({ inner: PLAZA_R, outer });` and replace the fog
   literal with `scene.fog.density = fogFor(dist, env.biome);`
5. In `tick()`: `env.update(dt, now, ctx);` **immediately after** the sky/light block — it
   reads the final `scene.fog.color` of this frame.
6. On day rollover (inside `hardReset`): `env.setSeed(newDayKey)`; and in `index.html`, add
   the `#stage::after` vignette rule of §1.5.

---

## 10. ACCEPTANCE

* `--hour=13 --tokens=5e6` (58 buildings, `E ≈ 40`): hedgerows within ~50 units of the last
  house, a visible field belt, no bare lawn anywhere between the town and the trees.
* `--hour=13 --tokens=1e9` (426 buildings, `E ≈ 102`): the same composition at scale; the
  town still dominates the frame; hills visible on the horizon; **no visible disc rim, no
  straight horizon line, no colour seam where ground meets sky.**
* `--hour=23`: fields indigo, clouds faint and moonlit, fireflies present (if water),
  windows and braziers still the brightest thing in frame.
* Two consecutive `setSeed` values produce visibly different countryside without either
  reading as a different game.
* Draw-call count from `renderer.info.render.calls` rises by ≤ 4 versus v2.
* Demo mode in a plain browser: full countryside, no console error, no plan required.
