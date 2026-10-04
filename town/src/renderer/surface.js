// Token Town — THE SURFACE PASS (v4 · F4 / lookdev L5+L14).
//
// One `onBeforeCompile` patch, applied to every lit material the town mints, that
// adds the four things the picture is missing at the fragment level:
//
//   rim      a sky-coloured wrap around every silhouette — the thing that keeps the
//            shadow side of a house alive now that the post pass takes key:fill to
//            5.7:1, and what separates a roof from the roof behind it at 10 px;
//   base AO  a wall is darker where it meets the ground, so buildings sit IN the
//            town instead of on top of it;
//   grain    world-space plaster hash + roof courses, with a derivative fade so
//            1200 buildings never shimmer at the wide framing;
//   far      the outskirts converge to uLandFar — the value the countryside fades
//            to — instead of to fog.color, which is the SKY's bottom stop. The town
//            used to dissolve paler and bluer than the field it stands in;
//   lane     ('ground' role only) the surface the town is STOOD ON: setts, grit,
//            ruts, mud at the gateways, puddles after rain, dust in August and a
//            January that finally reaches the road. See THE LANE below.
//   metal    ('metal' role only) a fake environment and a travelling highlight, so
//            the fountain's gilded lip, the vanes, the market cross's finial, the
//            well's coin and the mayor's chain are METAL and not a brown-yellow
//            paint. See THE METAL below.
//   wx       ('building' and 'prop') the weather ON the town: a wet roof is darker
//            and glossier, a snowy one is white where it faces up and bare where
//            it is steep, and a January one takes a little rime. Until this landed
//            the road was the only thing in the app that could tell it was raining.
//            See THE WEATHER ON THE TOWN below.
//
// THE LANE, and why it lives here of all places. The road plate is town.js's mesh
// and layout.js's canvas — neither is the countryside's to edit — but the plate is
// minted with `applyTownSurface(m, 'ground')`, so this file is the one place that
// can say what a lane is MADE of. From 200 units up the plate reads as a worn dirt
// lane and that was enough; the street-level camera (`--cam=stroll`, eye height
// 1.35 units) put the lens on it, and one flat tan with no ruts, no stone, no wet
// and no verge was the biggest hole in the picture. Everything below is derived
// from the plate's own ALPHA — layout paints the metalled core opaque and the
// verge, the plot aprons and the landmark forecourts at 0.30-0.50 — plus world
// position. No new texture, no new attribute, no new draw call, and no knowledge
// of where a road actually runs.
//
// WHY A SHADER PATCH AND NOT TEXTURES: `concatMeshes` (buildings.js) copies
// position/normal/colour and throws UVs away, so a merged building has no texture
// coordinates at all. Everything here is derived from world position and world
// normal, which merged geometry still carries. Zero attributes, zero textures,
// zero extra draw calls, identical on merged and unmerged meshes.
//
// PUBLIC SURFACE (import * as surface from './surface.js')
//   SURF                          the shared uniform block — §4.2 names, exactly
//   applyTownSurface(m, role)     idempotent in-place patch; returns m
//   reset()                       epoch switch: restores SURF to its defaults
//   dispose()                     shutdown: reset() + drops the patch counter
//   surfaceStats()                {patched, roles} — bench/harness only
//
// COST: 0 draw calls, 0 new materials, 0 new textures, 2 varyings, ~16 ALU ops per
// fragment (metal adds a fake env lookup and two short light loops — one over the
// scene's two directionals, one over its six plaza lamps — and metal is a few
// hundred pixels: a vane, a finial, a fountain lip, a coin and a chain of office).
// CPU is one string surgery per PROGRAM VARIANT (≤ 8 in a whole town),
// paid once at first compile — `customProgramCacheKey` is what keeps it that way.
// Nothing here allocates or accumulates per frame; town.js writes SURF, that is all.
//
// INTEGRATION (what the wiring wave must land — this module calls nothing):
//   buildings.js  std() → `return applyTownSurface(new THREE.MeshStandardMaterial(…))`
//                 matFor()   → `applyTownSurface(m)` before `matCache.set`
//                 mergedMat()→ `applyTownSurface(m)` before `mergeMats.set`
//                 furniture/props (trees, lamps, benches) → `applyTownSurface(m,'prop')`
//   fountain/mayor/buildings  the brass and gilding → `applyTownSurface(m,'metal')`
//                 (already wired: the fountain's gilded lip and bronze spouts, the
//                  weather vanes, the market cross's finial, the well's coin, the
//                  bell, the anvil, and the mayor's chain of office)
//   environs.js   writes the four uLane* uniforms AND uTownWx in its own update()
//                 — the tier's lane surface, the plaza radius, WX's wet/dust/cover
//                 and the year's bleak/frost/litter. Nothing else needs to know,
//                 and no other module gained a call site for any of it.
//   town.js       one block in tick(), beside the sky-and-light block:
//                   SURF.uRimCol.value.copy(skyMat.uniforms.top.value).lerp(WHITE, .35);
//                   SURF.uRimK.value   = .20 + .26 * day + .30 * night;
//                   SURF.uBaseAO.value = .34 - .10 * night;
//                   SURF.uLandFar.value.copy(env.landFar());      // 2-line env getter
//                   SURF.uFarD.value.set(dist * .55, dist * 3.1); // scales with framing
//                 hardReset → surface.reset();  shutdown → surface.dispose().
//   ORDER: anything that assigns `m.onBeforeCompile` AFTER this call clobbers the
//   patch. applyTownSurface CHAINS onto an existing one, so patch last (or chain).
//
// ASSUMES THE POST PASS (F3) EXISTS. Rim is additive in linear HDR and is sized to
// land under the day bright-pass knee (1.30) — a lit silhouette glows, it does not
// become a bloom firefly. No tonemapping/colourspace chunk is added anywhere here:
// the scene renders into a linear RT and postfx encodes once, at the end.
import * as THREE from './vendor/three.module.js';

/* ═══ the shared uniform block ══════════════════════════════════
   ONE object, written once per frame by town.js, read by every patched program —
   the `U` idiom from environs.js. The objects are shared BY REFERENCE into each
   shader's uniform map, so a write here reaches every variant with no bookkeeping.
   The defaults are a sane noon town, so a call site that never writes them (wave 0)
   still renders correctly: the null-object rule applies to uniforms too. */
export const SURF = Object.freeze({
  uRimCol: { value: new THREE.Color(0xBFD8F2) },
  uRimK: { value: 0.34 },
  uBaseAO: { value: 0.30 },
  uGrainK: { value: 0.11 },
  uLandFar: { value: new THREE.Color(0x6A6E62) },   // environs' own default, exactly (F4)
  uFarK: { value: 0.55 },
  uFarD: { value: new THREE.Vector2(120, 620) },    // start, end distance
  /* ── THE LANE (read by the 'ground' role only; environs.js writes all four) ──
     Defaults are a tier-0 hamlet on a fair day in June, so a call site that never
     writes them still renders a believable dirt lane — the null-object rule. */
  uLaneCol: { value: new THREE.Color(0x6B5F49) },   // buildings.js FABRICS[t].laneColor
  uLaneMix: { value: new THREE.Vector4(0, 0, 12, 0) },  // gravel · cobble · plazaR · square paving
  uLaneWx: { value: new THREE.Vector3(0, 0, 0) },   // WX: wet · dust · settled snow
  uLaneSeas: { value: new THREE.Vector3(0, 0, 0) }, // season: bleak · frost · litter
  /* ── THE WEATHER ON THE TOWN (read by the 'building' and 'prop' roles;
       environs.js writes it in the same breath as the four above) ──
     wet · settled snow · rime. The lane has had all three for a while and the
     BUILDINGS had none of them: it could be raining on the road and dry on the
     roof six inches above it, and a snow day whitened the lanes and left every
     roof in the parish in August. See THE WEATHER ON THE TOWN, below. */
  uTownWx: { value: new THREE.Vector3(0, 0, 0) }
});

const DEFAULTS = Object.freeze({
  uRimCol: 0xBFD8F2, uRimK: 0.34, uBaseAO: 0.30, uGrainK: 0.11,
  uLandFar: 0x6A6E62, uFarK: 0.55, uFarD: [120, 620],
  uLaneCol: 0x6B5F49, uLaneMix: [0, 0, 12, 0], uLaneWx: [0, 0, 0], uLaneSeas: [0, 0, 0],
  uTownWx: [0, 0, 0]
});

/* ═══ roles ═════════════════════════════════════════════════════
   A role is a SHADER VARIANT, not a uniform: its numbers are baked in as literals
   so a term that is off costs nothing at all, and so the whole town lives on ~6-8
   programs. Roles differ where the physical story differs:
     building  the default — full AO ramp over a cottage's lower third, courses on
               up-facing surfaces, plaster hash everywhere else
     prop      benches, lamps, trees: a 0.55-unit AO ramp (a 1.30 ramp would darken
               a whole bench), gentler hash, slightly hotter rim — small silhouettes
               need the most help
     metal     the town's brass and gilding: no plaster, no ground contact (a
               weather vane is not plastered and does not touch a wall), a
               tighter rim, a FAKE ENVIRONMENT and a travelling specular lobe —
               which with bloom on is the difference between gold-coloured and
               gold. See THE METAL, below.
     ground    plates and decals: far-value match only. NO RIM — a ground plane is
               all grazing angles, so a fresnel term would set the whole horizon
               alight — and no AO, because its world y is already zero. It is the
               one role that carries THE LANE (`lane: 1`): the surface material,
               the weather on it and the year in it. */
// `wx` is how much of THE WEATHER ON THE TOWN this role takes: 1 for a roof and a
// wall, a little less for a bench or a tree (they are smaller and they are under
// things), 0 for brass — a weather vane does not hold snow and a wet one is a
// job for the metal lobe, not for a flat darkening — and 0 for `ground`, which
// has carried its own wet, snow and frost since the lane landed.
const ROLES = Object.freeze({
  building: { ao: 1.30, aoK: 1.00, grain: 1.00, course: 1.30, rim: 1.00, rimPow: 3.2, spec: 0, env: 0, lane: 0, wx: 1.00 },
  prop: { ao: 0.55, aoK: 0.90, grain: 0.55, course: 0, rim: 1.10, rimPow: 3.0, spec: 0, env: 0, lane: 0, wx: 0.80 },
  // rim drops 0.75 → 0.42 because `env` now does that job properly: a sky-coloured
  // fresnel wrap and a sky-coloured mirror reflection are the same observation, and
  // stacked they made brass read as backlit plastic.
  metal: { ao: 0, aoK: 0, grain: 0, course: 0, rim: 0.42, rimPow: 4.2, spec: 0.30, env: 1.45, lane: 0, wx: 0 },
  ground: { ao: 0, aoK: 0, grain: 0.40, course: 0, rim: 0, rimPow: 3.2, spec: 0, env: 0, lane: 1, wx: 0 }
});

/** GLSL float literal — `1` is an int in GLSL and `1.0 * int` will not compile. */
const f = n => Number.isInteger(n) ? n.toFixed(1) : String(n);
/** ` * k`, elided at k === 1 so the shipped source has no `* 1.0` noise in it. */
const mul = k => k === 1 ? '' : ' * ' + f(k);

/** Replace `token` with `token + code` (or `code + token`) — but only if the token
 *  is actually in this shader. A material whose chunk list we did not expect
 *  degrades to "unpatched" instead of to a compile error. */
function inject(src, token, code, before) {
  if (src.indexOf(token) < 0) return src;
  return src.replace(token, before ? code + '\n' + token : token + '\n' + code);
}

const VERT_PARS = `
  varying vec3 vSWPos; varying vec3 vSWNrm;`;

// Instancing/batching are applied by hand exactly as <project_vertex> does it, and
// this sits immediately in front of that chunk so `transformed` is already final:
// modelMatrix alone is wrong for an InstancedMesh, and E1 makes the trees, lamps
// and benches instanced.
const VERT_POS = `
  vec4 sWP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    sWP = batchingMatrix * sWP;
  #endif
  #ifdef USE_INSTANCING
    sWP = instanceMatrix * sWP;
  #endif
  vSWPos = (modelMatrix * sWP).xyz;`;

// The world normal comes from `transformedNormal` (view space, already through the
// normal matrix and the instance/batch fixups) rotated back by the view matrix's
// transpose. Deriving it from objectNormal with mat3(modelMatrix) would skew it on
// every non-uniformly scaled box in the town — which is most of them.
const VERT_NRM = `
  vSWNrm = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);`;

const FRAG_PARS = `
  uniform vec3 uRimCol; uniform vec3 uLandFar; uniform vec2 uFarD;
  uniform float uRimK; uniform float uBaseAO; uniform float uGrainK; uniform float uFarK;
  uniform vec3 uLaneCol; uniform vec4 uLaneMix; uniform vec3 uLaneWx; uniform vec3 uLaneSeas;
  uniform vec3 uTownWx;
  varying vec3 vSWPos; varying vec3 vSWNrm;`;

/** Added for the `lane` and `wx` roles — two functions the `metal` variant would
 *  compile and never call. `sVN` is four hashes; the lane uses two octaves of it,
 *  the weather uses one to break up a roof, and nothing else needs a noise. */
const NOISE_PARS = `
  float sHash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float sVN(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash2(i), sHash2(i + vec2(1.0, 0.0)), f.x),
               mix(sHash2(i + vec2(0.0, 1.0)), sHash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }`;

/* ═══ THE LANE ══════════════════════════════════════════════════
   ONE WORLD UNIT IS ONE METRE (camera.js walks at 1.35 u/s and stands 1.35 u
   tall), so every frequency below is quoted in real sizes: setts at 14 cm, grit
   at 4 cm, ruts a cart's gauge apart, churn at 2.4 m.

   THE PLATE'S ALPHA IS THE SURVEY, and it is the only thing here that knows
   where a road is. layout.js paints the metalled core opaque, the 1.7x shoulder
   stroke at 0.45, plot aprons at 0.32-0.42 and landmark forecourts at 0.30 — so
   `a` is already "how made is this square metre", from open country to crown.
   Two facts fall straight out of it and cost four instructions between them:

     sRut   = sLane * (1 - sLane) * 4   peaks exactly ON the alpha ramp, which is
              the band either side of the crown where the wheels run, and is zero
              both on the crown and out on the verge. A worn lane, with no idea
              which way the lane points and no second texture to hold a direction.
     sEdge  = the mid-alpha band, which IS the gateways — aprons, forecourts and
              the shoulder where cart and boot leave the made surface. That is
              where a village has mud, and nowhere else, so the mud draws itself.

   THE GROUND ROLE IS SHARED, so everything that is about a ROAD sits inside
   `#ifdef USE_MAP`: the plate is the only ground-role material with a map, and
   buildings.js's plain-colour discs (the green, the pond, the worn aprons) get
   only the weather-and-year half, which is what they want anyway. USE_MAP is
   part of three's own program cache key, so this is two variants, not a branch. */
function fragLane(r) {
  if (!r.lane) return '';
  return `
  // shared by both halves; the #else path leaves the road terms at zero
  float sPud = 0.0, sRut = 0.0, sCrown = 0.0, sLDet = 0.0;
  vec3  sSurf = diffuseColor.rgb;
  float sMud  = sVN(vSWPos.xz * 0.42);          // 2.4 m churn
  float sFine = sVN(vSWPos.xz * 2.30 + 7.3);    // 45 cm mottle
  #ifdef USE_MAP
    // The plate is a 740 m plane that is empty almost everywhere. Nothing below
    // is visible at a = 0 and the material never writes depth, so this is pure
    // fill saved — around four fifths of the plate's pixels at any framing.
    if (diffuseColor.a < 0.004) discard;
    float sA    = diffuseColor.a;
    float sLane = smoothstep(0.58, 0.94, sA);
    float sEdge = smoothstep(0.05, 0.50, sA) * (1.0 - sLane);
    sRut   = sLane * (1.0 - sLane) * 4.0;
    sCrown = sLane * sLane;
    // The square. layout draws the plaza disc opaque and centred on the world
    // origin, so it is alpha-identical to a lane and radius is the only thing
    // that tells them apart — which is exactly what the market square needs to
    // stop reading as a very wide road.
    float sSq = (1.0 - smoothstep(uLaneMix.z * 0.76, uLaneMix.z * 1.04, length(vSWPos.xz))) * uLaneMix.w;
    float sGravK = uLaneMix.x * (1.0 - sSq * 0.7);
    // "DIRT LANES WORN INTO COBBLES", not a paved floor. The charter's phrase is
    // the specification: the stone is what shows THROUGH, so the setts are
    // strongest where the traffic is (the crown and the ruts) and silt up toward
    // the verge, and a slow noise buries whole stretches of them under earth.
    // Authored the other way round — a clean uniform pavement — the square read
    // as a municipal plaza and the lane as a bathroom floor.
    float sCobK  = clamp(uLaneMix.y + sSq, 0.0, 1.0)
                 * mix(0.36, 1.0, sLane) * clamp(0.42 + 0.78 * smoothstep(0.24, 0.70, sMud), 0.0, 1.0);
    // Three LOD bands off the world FOOTPRINT (metres of ground per pixel), so
    // the 14 cm setts stop being drawn before they are 14 cm per pixel and the
    // 200-unit framing gets the macro wear and nothing else. Without this the
    // lane is a shimmer generator at exactly the distance the app spends most of
    // its life at.
    float sLodG = 1.0 - smoothstep(0.012, 0.060, sFoot);   // grit,  ~4 cm
    float sLodC = 1.0 - smoothstep(0.030, 0.170, sFoot);   // setts, ~14 cm
    float sLodM = 1.0 - smoothstep(0.450, 1.700, sFoot);   // ruts and churn, ~1 m
    // Setts: a running bond, jittered, dark grout between them — the tier upgrade
    // the charter asks to SEE ("lanes becoming cobbled"), so it has to survive
    // being stood on and a plain hash would not.
    // NOTHING IN A VILLAGE IS ON A GRID, though. A straight running bond at one
    // frequency is a paving contractor's floor; the warp — free, it is the two
    // noises we already have — bends the courses the way a lane laid by eye over
    // three hundred years actually bends, and it is the single change that took
    // this from "tiled" to "cobbled".
    vec2 sCp = vSWPos.xz * 9.2 + vec2(sMud - 0.5, sFine - 0.5) * 1.9;
    sCp.x += 0.5 * floor(sCp.y);
    vec2 sCi = floor(sCp);
    float sCh = sHash2(sCi);
    vec2 sCf = fract(sCp) - 0.5 + (vec2(sCh, sHash2(sCi + 3.7)) - 0.5) * 0.30;
    float sStone = 1.0 - smoothstep(0.26, 0.46, max(abs(sCf.x) * 0.94, abs(sCf.y)));
    float sCob = mix(-0.30, (sCh - 0.45) * 0.58, sStone);
    // grit: two frequencies, so gravel has grains AND patches of grains
    float sGrit = (sHash2(floor(vSWPos.xz * 26.0)) - 0.5) * 0.60
                + (sHash2(floor(vSWPos.xz * 8.0) + 11.0) - 0.5) * 0.40;
    sLDet = (sMud - 0.5) * 0.50 * sLodM
          + (sFine - 0.5) * 0.38 * sLodC
          + sGrit * sGravK * 1.20 * sLodG
          + sCob * sCobK * sLodC
          - sRut * 0.18 * sLodM;      // a rut is worn INTO the surface, courses and all
    // The tier tint dominates but does not erase what layout painted — the river
    // bed, the damp sand shoulder, the terrace risers and the valley floor are
    // all strokes on this canvas and they must still read.
    // 0.52, not 1.0: past the LOD bands the setts are gone and all that is left
    // is this mix, so leaning it too far onto the tier's stone colour turned the
    // 200-unit framing's lane network cool and pale — a grey web laid over an
    // olive country. Keeping half of layout's own warm earth is what stops a
    // cobbled market village reading as tarmac from the air.
    sSurf = mix(diffuseColor.rgb, uLaneCol, 0.52);
    sSurf = mix(sSurf, sSurf * 1.06, sGravK * 0.5);
    // STONE IS NOT EARTH. Without this the whole lane is one tint modulated up and
    // down, which is a relief map of cobbles rather than cobbles: the setts have
    // to be greyer and cooler than the mud packed into the joints around them.
    sSurf = mix(sSurf, mix(uLaneCol, vec3(dot(uLaneCol, vec3(0.33, 0.50, 0.17))), 0.38) * 1.05,
                sStone * sCobK * sLodC * 0.52);
    sSurf *= 1.0 + 0.09 * sCrown * (1.0 - sCobK * 0.6) - 0.11 * sRut * sLodM;
    sSurf *= 1.0 + sLDet * 0.80;
    // MUD AT GATEWAYS (AESTHETIC.md, "materials and light"). Wet mud is darker,
    // browner and flatter than the lane it spills out of.
    float sMuddy = sEdge * smoothstep(0.40, 0.84, sMud * 0.70 + sFine * 0.30);
    sSurf = mix(sSurf, uLaneCol * vec3(0.54, 0.47, 0.38), sMuddy * (0.42 + 0.48 * uLaneWx.x));
    // THE VERGE IS NOT THE ROAD, and this one multiply is the whole of the
    // road / verge / country separation: thinning the plate on the shoulder lets
    // environs' own grass through it, so a lane edge is trodden grass shading
    // into dirt instead of a wider patch of the same tan.
    diffuseColor.a *= mix(0.70, 1.0, max(sLane, sSq));
  #endif
  // ── the weather and the year, on ANY ground plate ──────────────
  // A puddle does not care which mesh it is on, so this half runs for the green
  // and the worn aprons too. Standing water collects in the ruts and in the
  // churn and never on the crown — that is what a camber is for.
  float sWet = uLaneWx.x;
  // A TIGHT threshold, not a broad one: a wide soft mask reads as "the ground is
  // damp" (which the flat -0.24 below already says) and never as water lying in
  // it. Water wants edges.
  sPud = sWet * smoothstep(0.56, 0.72, sMud * 0.48 + sFine * 0.40 + sRut * 0.55);
  sSurf *= 1.0 - 0.24 * sWet - 0.52 * sPud;
  float sL = dot(sSurf, vec3(0.33, 0.50, 0.17));
  // DUST BLEACHES, IT DOES NOT TINT (the charter: variation from weathering and
  // material, never from hue). A dry August lane loses chroma and gains value.
  sSurf = mix(sSurf, mix(sSurf, vec3(sL), 0.42) * 1.26, uLaneWx.y * 0.55);
  // BLEAK. The road plate was the last large surface in the town that did not
  // move with the year: in January it was the warmest, brightest thing in frame
  // and it fought the cold land around it. Winter earth is dark, wet and dull.
  sSurf = mix(sSurf, mix(sSurf, vec3(sL), 0.40) * vec3(0.72, 0.75, 0.79), uLaneSeas.x * 0.85);
  // Rime catches on what stands PROUD — the sett tops, the grit — and never in
  // standing water: the same operation as the countryside's one ground term.
  // HALF A STOP OF IT, not a whitewash. Authored at 0.50 over a mask that was
  // true for most of the surface, a January lane came out PALER than an August
  // one, which is the exact fault this term exists to fix. Traffic clears the
  // crown, so the frost keeps to the sides.
  sSurf = mix(sSurf, vec3(0.62, 0.65, 0.64),
              uLaneSeas.y * smoothstep(0.02, 0.20, sLDet) * 0.36 * (1.0 - 0.45 * sCrown) * (1.0 - sPud));
  // Leaves blow to the edges of a lane and are swept off the middle of it.
  sSurf = mix(sSurf, vec3(0.30, 0.20, 0.10),
              uLaneSeas.z * smoothstep(0.60, 0.92, sFine) * (1.0 - sCrown) * 0.55);
  // Settled snow: traffic clears the crown, the verges keep it.
  sSurf = mix(sSurf, vec3(0.76, 0.79, 0.82), uLaneWx.z * (1.0 - 0.55 * sCrown) * 0.85);
  diffuseColor.rgb = sSurf;`;
}

/* ═══ THE WEATHER ON THE TOWN ═══════════════════════════════════
   `uWet` and `uCover` have been on the weather bus since weather.js shipped, and
   until now the only thing in the app that read either of them was the road. The
   result was a town it could visibly rain on and visibly snow on — as long as you
   only looked at the ground. Six inches above the lane every roof in the parish
   was having a dry August.

   THE ROOF IS THE PICTURE. AESTHETIC.md: "roofs are the biggest surface the camera
   sees — they carry the most detail budget", and at this framing they are most of
   what is not sky or field. Snow on a roof is what says snow; a wet roof is what
   says rain. Drops in the air are the smaller half of both, which is exactly why
   this block matters more than the two meshes weather.js gained beside it.

   THREE TERMS, all of them albedo except one roughness mix, all of them keyed off
   the WORLD NORMAL — which merged geometry still carries (see the header) — so
   this needs no new attribute, no new texture, no UV and no knowledge of which
   triangle is a roof.

     wet    darker, and darkest on what faces up, because that is what the rain
            actually lands on. Plus ONE roughness mix: wet stone is glossy, and
            that single change does more for "it is raining" than any drop does.
            A wall gets a third of it — rain runs down a wall, it does not sit.
     cover  settled snow, on what points up, broken by a world-space noise so a
            roof is never a clean white triangle and two neighbouring roofs are
            never the same. A steep pitch SHEDS — the up-facing ramp is what says
            so, and it is free — and the noise means a dusting arrives in patches
            the way a real one does, rather than as the whole roof at 8 % white.
     rime   deep-winter frost, a sixth of the same operation on the flattest
            faces only. Tiny on purpose: a January village is grey-brown, not
            white-and-sparkling.

   COST: zero triangles, zero draw calls, zero new materials, ONE new uniform,
   about ten ALU and one noise on the two roles that take it. */
const FRAG_TOWN_WX = k => `
  float sUp = clamp(vSWNrm.y, 0.0, 1.0);
  float sWetT = uTownWx.x * ${f(k)} * (0.30 + 0.70 * sUp);
  diffuseColor.rgb *= 1.0 - 0.36 * sWetT;
  // 1.4 m of noise: roof-sized, so the break-up is per roof and per slope rather
  // than a speckle nobody can see from two hundred units up.
  float sLie = smoothstep(0.30, 0.76, sUp) * uTownWx.y * ${f(k)};
  sLie = clamp(sLie * (0.45 + 1.05 * sVN(vSWPos.xz * 0.70 + vSWPos.y * 0.30)), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.83, 0.87), sLie * 0.94);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.73, 0.74),
                         uTownWx.z * ${f(k)} * smoothstep(0.55, 0.95, sUp) * 0.15 * (1.0 - sLie));`;

/** Wet stone is glossy and snow is not: one mix each, in that order, at
 *  <roughnessmap_fragment> — after `roughnessFactor` exists and before the
 *  lighting reads it. A Lambert material has no such chunk and `inject` leaves it
 *  exactly as it was. */
const FRAG_TOWN_ROUGH = `
  roughnessFactor = mix(roughnessFactor, 0.20, sWetT * 0.85);
  roughnessFactor = mix(roughnessFactor, 0.92, sLie);`;

/** Standing water is the ONE thing on a ground plate that may be shiny, so the
 *  roughness drop is masked hard by the puddle and nothing else changes. This
 *  runs at <roughnessmap_fragment> — after `roughnessFactor` exists, before the
 *  lighting reads it — and gives the sun, the moon and the lamps a real streak
 *  off wet stone for one mix. A Lambert ground material has no such chunk and is
 *  simply left alone (see `inject`). */
const FRAG_WET_ROUGH = `
  roughnessFactor = mix(roughnessFactor, 0.10, sPud);`;

/** A COBBLE HAS A TOP AND TWO SIDES. Painted purely into albedo the setts read as
 *  a printed pattern — right from 40 units, flat from 2 — because at eye height
 *  the thing that says "stone" is that each one catches the sun on one side and
 *  shades on the other. `sLDet` is already a height field, so its SCREEN-SPACE
 *  gradient is a normal perturbation for two derivative ops, and it is
 *  scale-invariant by construction: when the setts go sub-pixel the derivative
 *  goes to zero on its own and the bump retires with the LOD bands that fed it.
 *  `normal` is view space here and view x/y are screen x/y, which is what makes
 *  the shortcut legitimate rather than merely cheap. */
const FRAG_LANE_BUMP = `
  normal = normalize(normal + vec3(dFdx(sLDet), -dFdy(sLDet), 0.0) * 1.9);`;

/** Albedo-domain: contact darkening + world-space detail. Runs at <color_fragment>,
 *  before any lighting, so it reads as paint rather than as light. */
function fragAlbedo(r) {
  const out = [];
  if (r.ao > 0) {
    // 1.30 world units is about a third of a tier-1 cottage: high enough to read at
    // the working framing, low enough to leave the roof alone. World y is height
    // above the town plat, which is flat — a prop out on a hillside loses its ramp,
    // and that is a fair trade for not needing a terrain height lookup.
    out.push(`  float sAO = 1.0 - uBaseAO${mul(r.aoK)} * (1.0 - smoothstep(0.0, ${f(r.ao)}, vSWPos.y));`);
  }
  // A PLATE IS FLAT: `fwidth(vSWPos.y)` — the fade every other role grades its
  // grain on — is identically zero on it, so the ground role's grain has been
  // running at full strength from 200 units up since it was written. The world
  // FOOTPRINT (metres of ground under one pixel) is the honest measure here, and
  // it is the same number the lane's three LOD bands are graded on, so it is
  // hoisted out of the grain block and lives for the whole of main().
  if (r.lane) out.push(`  float sFoot = max(fwidth(vSWPos.x), fwidth(vSWPos.z));`);
  if (r.grain > 0) {
    // THE DERIVATIVE FADE IS THE WHOLE TRICK. At the wide framing the lattice period
    // is sub-pixel, so the term goes to zero and 1200 buildings sit still instead of
    // boiling. Without it this is a shimmer generator.
    out.push(r.lane
      ? `  float sFade = 1.0 - smoothstep(0.30, 1.20, sFoot);`
      : `  float sFade = 1.0 - smoothstep(0.45, 1.30, fwidth(vSWPos.y) * 3.33);`);
    out.push(`  vec2  sCell = floor(vSWPos.xz * 2.7 + vSWPos.y * 0.9);`);
    out.push(`  float sDet = fract(sin(dot(sCell, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;`);
    if (r.course > 0) {
      // Rows of tile every 0.30 world units on anything facing up. A gable is sloped,
      // so this reads as courses; a flat roof gets one constant offset, which is a
      // free per-roof value break and costs nothing.
      out.push(`  float sCourse = smoothstep(0.40, 0.60, fract(vSWPos.y * 3.33)) - 0.5;`);
      out.push(`  sDet = mix(sDet, sCourse * ${f(r.course)}, step(0.30, abs(vSWNrm.y)));`);
    }
    out.push(`  diffuseColor.rgb *= ${r.ao > 0 ? 'sAO * ' : ''}(1.0 + sDet * uGrainK${mul(r.grain)} * sFade);`);
  } else if (r.ao > 0) {
    out.push(`  diffuseColor.rgb *= sAO;`);
  }
  return out.length ? out.join('\n') : '';
}

/** Light-domain: rim, and the metal lobe. Runs just before <opaque_fragment>, so it
 *  is inside the material's own alpha handling and ahead of fog. */
function fragLight(r) {
  if (r.lane) {
    // PUDDLES ARE THE ONLY PART OF A ROAD THAT REFLECTS. This role has no rim at
    // all, and the reason is in ROLES above: a ground plane is all grazing angles,
    // so an unmasked fresnel sets the whole horizon alight. Standing water is
    // precisely the thing that SHOULD take the sky at a grazing angle, and gating
    // the term on `sPud` is what keeps it a puddle instead of a lake. uRimCol is
    // already the sky's own top stop, so this goes dark at night for free and the
    // lamps' streak is left to the roughness drop above.
    return `  vec3 sV = normalize(vViewPosition);
  float sPFr = pow(1.0 - clamp(dot(sN, sV), 0.0, 1.0), 4.0);
  outgoingLight = mix(outgoingLight, uRimCol * (0.26 + 0.50 * uRimK), sPud * (0.22 + 0.68 * sPFr));`;
  }
  if (r.rim <= 0 && r.spec <= 0 && r.env <= 0) return '';
  const out = ['  vec3 sV = normalize(vViewPosition);'];
  if (r.rim > 0) {
    // Sky-coloured, and strongest on up-facing surfaces because that is where the
    // sky is. `sN` is captured at <normal_fragment_begin> so this is correct under
    // flatShading, where vNormal is not even declared.
    out.push(`  float sRim = pow(1.0 - clamp(dot(sN, sV), 0.0, 1.0), ${f(r.rimPow)});`);
    out.push(`  outgoingLight += uRimCol * (sRim * uRimK${mul(r.rim)} * (0.30 + 0.70 * clamp(vSWNrm.y * 0.5 + 0.5, 0.0, 1.0)));`);
  }
  if (r.spec > 0 || r.env > 0) out.push(FRAG_METAL(r));
  return out.join('\n');
}

/* ═══ THE METAL ═════════════════════════════════════════════════
   The idea row (T-8) was written when the plaza held a gilded altar and the note
   was "a fake specular travelling highlight on the monument". The altar is gone
   (AESTHETIC.md), and what is left is small and deliberate: the fountain's gilded
   lip and its bronze spouts, three weather vanes, the market cross's finial, the
   coin on the well's coping, the bell, the smith's anvil, and the mayor's brass
   chain of office. So the job is not to make a colossus shine, it is to make a
   THUMBNAIL of brass survive being brass at forty units and at eye height.

   WHY GOLD CAME OUT AS MUSTARD. There is no environment map in this scene — not a
   cube, not a probe — so `metalness: 0.78` buys nothing at all: three's metallic
   BRDF sends a metal's whole diffuse term to zero and pays it back out of the
   specular IBL, and with no IBL there is nothing to pay it back WITH. A metal is
   a mirror with an opinion about colour; a mirror in an empty room is black, and
   black × a warm albedo is exactly the flat brown-yellow that was there.

   THREE TERMS, in the order they matter:

     env    THE FAKE ENVIRONMENT, and the one that actually does the work. The
            world-space mirror direction is looked up in a two-stop sky/ground
            gradient built from uniforms that ALREADY EXIST and are ALREADY written
            every frame: uRimCol is the sky dome's own top stop and uLandFar is the
            value the countryside fades to. So a vane reflects sky above the horizon
            and field below it, the split sweeps across the metal as the camera
            orbits, and the whole thing goes dark at night and warm at dusk for free
            — no new uniform, no new call site, nothing for town.js to remember. It
            is SCALED BY THE KEY, summed off the directional lights three already
            premultiplied by intensity: a mirror that reflects as much sky at
            midnight as at midday is not a mirror, it is a self-lit plastic.
     spec   the travelling highlight itself, two lobes per directional light: a
            tight core (exponent 170 — the glint, which bloom turns into a star) and
            a BROAD sheen (exponent 9, which is the roughness-0.3 lobe these
            materials actually declare). The broad one matters more than it looks:
            a vertical gilded band under a 38° sun can never mirror the sun exactly,
            so with a tight lobe alone the fountain's lip stayed dead brown at every
            hour of the day. Weighted by each light's own colour, so the sun owns it
            by day and the moon owns it after dark with no wiring and no assumption
            about which light was added first.
     lamps  the same core against the six plaza point lights. The fountain stands in
            the middle of them and the mayor walks past them; without this every
            piece of brass in the town switches off at dusk, which is precisely
            backwards — lamplight on brass is the best it ever looks.

   ALL THREE ARE TINTED BY THE MATERIAL'S OWN ALBEDO, because that is the one thing
   that separates a metal from a shiny dielectric: brass reflects brass-coloured,
   plaster reflects white. Only the very core of the highlight is lifted toward
   white, and only a little, because a real specular peak on gold is still gold.

   COST: zero triangles, zero draw calls, zero new uniforms, zero new materials. */
const FRAG_METAL = r => {
  const o = [];
  // `diffuseColor` is still the albedo here — three's metallic BRDF took a COPY
  // into the material struct. Brass reflects brass-coloured; only the very core of
  // a highlight lifts toward the light's own white, and only by a fifth.
  o.push(`  vec3 sTint = diffuseColor.rgb;`);
  o.push(`  vec3 sHot = mix(sTint, vec3(1.0), 0.20);`);
  o.push(`  float sVN = clamp(dot(sN, sV), 0.0, 1.0);`);
  o.push(`  vec3 sRfl = reflect(-sV, sN);`);
  // ONE loop over the directional lights, read twice: it carries the travelling
  // highlight AND the answer to "how bright is the world this mirror is in".
  // three premultiplies intensity into `.color`, so the sum IS the key's strength
  // — 6-ish at noon, under one after dark — which is what the fake environment
  // has to be scaled by. Without it a vane reflects the same amount of sky at
  // midnight as at midday, and the whole thing reads as self-lit plastic.
  o.push(`  vec3 sSpec = vec3(0.0); vec3 sLit = vec3(0.0);`);
  o.push(`  #if NUM_DIR_LIGHTS > 0`);
  o.push(`    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {`);
  o.push(`      sLit += directionalLights[i].color;`);
  if (r.spec > 0) {
    // Two lobes. The tight one is the glint — small, bright, over the bloom knee,
    // and it TRAVELS as the camera orbits. The broad one is the roughness-0.3 lobe
    // these materials actually declare: a mirror at that roughness gathers light
    // from twenty degrees around the sun, and it is why a bit of brass that is not
    // pointing straight at the sun still looks like brass rather than like paint.
    o.push(`      float sD = max(dot(sRfl, directionalLights[i].direction), 0.0);`);
    o.push(`      sSpec += directionalLights[i].color * (pow(sD, 170.0) * 1.50 + pow(sD, 9.0) * 0.55);`);
  }
  o.push(`    }`);
  o.push(`  #endif`);
  if (r.env > 0) {
    // Back to world space by the view matrix's transpose — the same idiom the
    // vertex normal uses, and correct because a view matrix's rotation is
    // orthonormal. `sRW.y` is then simply "is this bit of metal looking up".
    o.push(`  vec3 sRW = normalize((vec4(sRfl, 0.0) * viewMatrix).xyz);`);
    // The horizon in a mirror is a SOFT edge on anything but a polished sphere,
    // and every piece of metal in this town is small, curved and a bit tarnished.
    o.push(`  float sWorld = 0.24 + 0.17 * dot(sLit, vec3(0.30, 0.59, 0.11));`);
    o.push(`  vec3 sEnv = mix(uLandFar, uRimCol, smoothstep(-0.34, 0.30, sRW.y)) * sWorld;`);
    // Schlick with a HIGH floor: a metal is a mirror at every angle, not just at
    // grazing ones, so this is a lean toward the rim rather than the dielectric's
    // near-zero-to-one ramp. With a low floor the faces pointing at the camera go
    // dead and the object reads as a bright outline around a hole.
    o.push(`  float sFr = 0.55 + 0.45 * pow(1.0 - sVN, 4.0);`);
    o.push(`  outgoingLight += sEnv * sTint * (sFr * ${f(r.env)});`);
  }
  if (r.spec > 0) {
    o.push(`  outgoingLight += sSpec * sHot * ${f(r.spec)};`);
    // The lamps. Six of them, all round the plaza, and metal is a few hundred
    // pixels — three's own lighting loop already runs this list for every lit
    // fragment in the town, so one more pass over it here is not measurable.
    o.push(`  #if NUM_POINT_LIGHTS > 0`);
    o.push(`    vec3 sPS = vec3(0.0);`);
    o.push(`    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {`);
    o.push(`      vec3 sPv = pointLights[i].position + vViewPosition;`);
    o.push(`      float sPd = length(sPv);`);
    o.push(`      sPS += pointLights[i].color`);
    o.push(`           * getDistanceAttenuation(sPd, pointLights[i].distance, pointLights[i].decay)`);
    o.push(`           * pow(max(dot(sRfl, sPv / max(sPd, 1e-4)), 0.0), 84.0);`);
    o.push(`    }`);
    o.push(`    outgoingLight += sPS * sHot * ${f(r.spec)};`);
    o.push(`  #endif`);
  }
  return o.join('\n');
};

// F4's far-value match. `length(vViewPosition)` IS the camera distance (vViewPosition
// is -mvPosition), so this needs no varying of its own.
const FRAG_FAR = `
  float sFar = smoothstep(uFarD.x, uFarD.y, length(vViewPosition));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uLandFar, sFar * uFarK);`;

/** Materials whose shader carries `vViewPosition`, a shading `normal` and a lit
 *  `outgoingLight`. Anything else (Basic, Sprite, raw ShaderMaterial) is left
 *  exactly as it was — patching it would be a compile error, not an effect. */
const patchable = m => !!(m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial));

// Both of these exist on Material.prototype as defaults (the cache key falls back to
// onBeforeCompile.toString(), the hook is a no-op), so "has one already" means "has
// an OWN one" — otherwise every material looks pre-patched.
const BASE_KEY = THREE.Material.prototype.customProgramCacheKey;
const BASE_HOOK = THREE.Material.prototype.onBeforeCompile;

let patched = 0;
const roleCount = { building: 0, prop: 0, metal: 0, ground: 0 };

/**
 * Patch a lit material in place. IDEMPOTENT — the first call wins and every later
 * call is a no-op. The gate is the INSTALLED HOOK, not a userData flag: `clone()`
 * copies userData but not `onBeforeCompile`, so a flag alone would leave every
 * cloned material silently unpatched. A clone is a different program and gets its
 * own patch; a material somebody else's patch has since overwritten gets re-chained.
 * @param {THREE.Material} m
 * @param {'building'|'prop'|'metal'|'ground'} [role]
 * @returns {THREE.Material} m, always — including when nothing was patched
 */
export function applyTownSurface(m, role = 'building') {
  if (!patchable(m)) return m;
  if (m.__townSurface === m.onBeforeCompile) return m;   // already ours, patch intact
  const key = ROLES[role] ? role : 'building';
  const r = ROLES[key];
  (m.userData || (m.userData = {})).townSurface = key;   // human-readable record

  // THE LANE RIDES ON THE ALBEDO BLOCK, not on a chunk of its own: it needs
  // `sFoot` from the grain term above it and it must land inside the same
  // <color_fragment> injection so `sPud` is in scope for the roughness drop and
  // for the light block below.
  const albedo = fragAlbedo(r) + fragLane(r) + (r.wx ? FRAG_TOWN_WX(r.wx) : ''),
    light = fragLight(r);
  const prevCompile = m.onBeforeCompile !== BASE_HOOK ? m.onBeforeCompile : null;
  // Three keys a patched program on onBeforeCompile.toString() unless you say
  // otherwise — which works, but re-parses a 4 KB function per material and cannot
  // tell two roles apart. Compose rather than overwrite, so a later patch (snow,
  // say) that sets its own key still gets its own variants.
  const prevKey = m.customProgramCacheKey;
  const mine = 'town-surface-' + key;
  m.customProgramCacheKey = prevKey && prevKey !== BASE_KEY
    ? () => prevKey.call(m) + '|' + mine
    : () => mine;

  m.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile.call(m, s, renderer);
    Object.assign(s.uniforms, SURF);                  // ALL of them, always: three
                                                      // throws if a program's active
                                                      // uniform is missing from the map
    let v = s.vertexShader;
    v = inject(v, '#include <common>', VERT_PARS);
    v = inject(v, '#include <defaultnormal_vertex>', VERT_NRM);
    v = inject(v, '#include <project_vertex>', VERT_POS, true);   // `transformed` is final here
    s.vertexShader = v;

    let g = s.fragmentShader;
    g = inject(g, '#include <common>', FRAG_PARS + ((r.lane || r.wx) ? NOISE_PARS : ''));
    if (albedo) g = inject(g, '#include <color_fragment>', albedo);
    // Standard/Physical only — a Lambert ground plate has no roughness and
    // `inject` leaves it exactly as it was.
    if (r.lane) g = inject(g, '#include <roughnessmap_fragment>', FRAG_WET_ROUGH);
    if (r.wx) g = inject(g, '#include <roughnessmap_fragment>', FRAG_TOWN_ROUGH);
    // ONE injection at <normal_fragment_begin>, in this order on purpose: `inject`
    // puts each new block immediately after the token, so two calls would land
    // the SECOND one first and capture `sN` off the un-bumped normal. The
    // puddle's fresnel has to be taken against the stone it is lying on.
    const nrm = (r.lane ? FRAG_LANE_BUMP : '') + (light ? '\n  vec3 sN = normal;' : '');
    if (nrm) g = inject(g, '#include <normal_fragment_begin>', nrm);
    if (light) g = inject(g, '#include <opaque_fragment>', light, true);
    g = inject(g, '#include <fog_fragment>', FRAG_FAR);
    s.fragmentShader = g;
  };
  m.__townSurface = m.onBeforeCompile;                // the idempotence gate

  // fwidth needs the derivatives extension on WebGL1. On WebGL2 (which is what
  // Electron gives us) three emits GLSL 3.00 where it is core and this is ignored.
  if (r.grain > 0 || r.lane) m.extensions = Object.assign({}, m.extensions, { derivatives: true });
  // A material minted before the first weather frame must not compile a variant
  // that is missing uTownWx: Object.assign(s.uniforms, SURF) in the hook covers
  // every entry, which is why SURF is spread wholesale rather than picked over.
  m.needsUpdate = true;                               // recompile if it already ran

  patched++; roleCount[key]++;
  return m;
}

/** Epoch switch. The uniforms are the only state this module has; a new town must
 *  not inherit the last one's rim strength or far distances mid-fade. */
export function reset() {
  SURF.uRimCol.value.setHex(DEFAULTS.uRimCol);
  SURF.uRimK.value = DEFAULTS.uRimK;
  SURF.uBaseAO.value = DEFAULTS.uBaseAO;
  SURF.uGrainK.value = DEFAULTS.uGrainK;
  SURF.uLandFar.value.setHex(DEFAULTS.uLandFar);
  SURF.uFarK.value = DEFAULTS.uFarK;
  SURF.uFarD.value.set(DEFAULTS.uFarD[0], DEFAULTS.uFarD[1]);
  SURF.uLaneCol.value.setHex(DEFAULTS.uLaneCol);
  SURF.uLaneMix.value.fromArray(DEFAULTS.uLaneMix);
  SURF.uLaneWx.value.fromArray(DEFAULTS.uLaneWx);
  SURF.uLaneSeas.value.fromArray(DEFAULTS.uLaneSeas);
  SURF.uTownWx.value.fromArray(DEFAULTS.uTownWx);
}

/** Shutdown. Owns no geometry, material, texture, render target, DOM node, timer or
 *  listener — the patch lives on the materials, which their own owners dispose — so
 *  there is nothing here to free and nothing that can leak across an epoch. */
export function dispose() {
  reset();
  patched = 0;
  for (const k in roleCount) roleCount[k] = 0;
}

/** Bench/harness only. @returns {{patched:number, roles:Object}} */
export function surfaceStats() { return { patched, roles: Object.assign({}, roleCount) }; }
