// The Fountain — the village's centrepiece, and the one object in the town that
// says the number out loud. It replaces the Token Altar, which climbed to a
// 78-unit gilded mint and broke the first rule of AESTHETIC.md: growth shows as
// MORE, not TALLER. A village square has a fountain in it. That is the whole
// idea.
//
// Three rules govern every number in here:
//
//  1. IT STAYS SMALL. The tallest rung is under 7 units — shorter than a
//     two-storey cottage with its chimney. The ladder buys *detail*: water,
//     carving, lanterns, flowers, paving, a second bowl. It never buys height,
//     and there is no post-1B multiplier. When the user's number grows the
//     reward is more houses and more people; the fountain just keeps count.
//  2. EXISTENCE IS WALL-CLOCK. Which parts are present, what the board says,
//     which ceremony phase we are in — all driven by the clock town.js feeds
//     `update()`, so a 1 fps headless screenshot is truthful. Only continuous
//     motion (water scroll, jet scroll, droplet integration) is paced by `dt`.
//  3. NOTHING MAGICAL. Stone, water, iron, timber, bronze, and one gilded rim at
//     the very top of the ladder. No floating mass, no beacon into the sky.
//
// The public contract is unchanged from monument.js so town.js keeps its call
// sites: group, radius, tier, tierName, crownHeight, plazaWant, nightSun,
// displayed, ceremony, update, setTotal, setTier, setNext, setRangeLabel,
// celebrate, pulse, getAttractor, getCoinPos, reset, dispose.
//
// Draw calls: ~19 at tier 10, ~10 at the tiers a normal day reaches. Repeated
// furniture (spouts, jets, lantern posts and boxes, planters) is instanced with
// unused instances parked at y = -999.
import * as THREE from './vendor/three.module.js';
// F4's surface pass. Stone and timber take the 'prop' variant; bronze and the
// one gilded band take 'metal' (no plaster, tighter rim, a travelling specular
// lobe) — which with bloom on is the difference between brass-coloured and brass.
import { applyTownSurface } from './surface.js';

const STONE = 0x9a9184, STONE_D = 0x6f6a5e, STONE_L = 0xb0a795;
const TIMBER = 0x6b4f35, IRON = 0x2f2c28, BRONZE = 0x8c6a3a, GILD = 0xC9A15A;
const WATER = 0x4c7f86, LAMP = 0xFFC98A, GOLD_HI = 0xF3D07A;
const FONT = '"Segoe UI", system-ui, sans-serif';
const THIN = ' ';                              // digit-group separator

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const easeOutBack = k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const rand = (a, b) => a + Math.random() * (b - a);
// A reveal scalar eased 0→1 reads as a smooth swell; this bends it into a pop
// with a single sin. Pure function of the eased value, so it stays idempotent
// and jumpable — there is no timer to get out of step.
const pop = a => a >= .999 ? 1 : a * (1 + .38 * Math.sin(clamp(a, 0, 1) * Math.PI));

/* ── the ladder: eleven rungs of a village fountain ───────────────
   index === tier, 0..10. The tier↔tokens mapping has exactly ONE owner, the
   `mon:` column of town.js's LADDER — there is no duplicate table here.

   Everything is expressed in BASIN RADII. The body group is scaled by the
   basin radius of the current tier, so one number moves the whole object and a
   tier-up is a scale ease plus a handful of reveals — never a rebuild. */
const T_NAME = ['Stone Basin', 'Village Pump', 'Market Basin', 'Village Fountain',
  'Carved Fountain', 'Lantern Fountain', 'Flowered Fountain', 'Market Fountain',
  'Guild Fountain', 'Tiered Fountain', 'The Great Fountain'];
// basin radius, world units. 1.15 → 3.20: it roughly triples across the whole
// ladder, and 3.20 is still comfortably inside the plaza at its narrowest.
const T_FOOT = [1.15, 1.55, 1.85, 2.15, 2.35, 2.52, 2.66, 2.80, 2.94, 3.08, 3.20];
// crown height in basin radii — what actually stands above the kerb. Multiplied
// out: 0.71, 1.63, 1.94, 3.23, 3.53, 3.91, 4.12, 4.42, 4.76, 6.10, 6.72 units.
// Monotone, and the top rung is shorter than a cottage with a chimney.
const T_CROWN = [.62, 1.05, 1.05, 1.50, 1.50, 1.55, 1.55, 1.58, 1.62, 1.98, 2.10];
// The low rungs pull the plaza IN: a lone trough marooned in a 12-unit disc of
// bare dirt has no presence, and a tight square makes it read as the middle of
// somewhere. Well under the altar's old 15.5 at every rung.
const T_PLAZA = [8.4, 8.8, 9.4, 10.0, 10.6, 11.0, 11.4, 11.9, 12.3, 12.7, 13.0];
// Lantern candela (r160 physical). A village fountain does not light the town —
// the top rung is roughly four lanterns' worth, not a night sun.
const T_LIGHT = [0, 0, 0, 0, 0, 7, 10, 15, 21, 30, 42];
const TMAX = 10;

/* ── the profile, in basin radii ──────────────────────────────────
   The lathe profiles and every attachment point derive from these, so the whole
   fountain rescales from one number. */
const KERB_Y = .30, KERB_IN = .84, FLOOR_Y = .07;   // basin lip, inner wall, floor
const WATER_Y = .235;                               // water surface, below the lip
const PLINTH_R = .30, PLINTH_Y = .46;
const COL_R = .17, COL_Y = 1.02;                    // octagonal shaft top
const BOWL_R = .52, BOWL_Y = 1.12;
const UP_R = .30, UP_Y = 1.62, UP_BOWL_Y = 1.72;    // the second, smaller bowl
const SPOUT_R = .21, SPOUT_Y = .86;                 // bronze heads on the shaft
const JET_LAND = .60;                               // where the arcs hit the water
const LANT_R = 1.24, PLANT_R = 1.30, APRON_R = 1.62;

// The escalation must never widen the plaza past the innermost plot:
//   foot * growS + 4.4 <= innerR - .6, and layout guarantees innerR >= 17.5.
// With foot capped at 3.20 this has an enormous amount of slack — it is kept as
// a guard rail, not because the fountain is ever near it.
const FOOT_ROOM = innerR => Math.max(4, innerR - 5.06);
// A fixed-size object inside a growing plaza gets relatively smaller the more
// the user spends, so the fountain takes a gentle nudge with the town. It is a
// nudge and nothing more: 10 % across the entire range, and the ladder owns the
// rest. There is deliberately NO equivalent of the altar's megaFor().
const growFor = outerR => clamp(1 + (outerR - 39) / 63 * .10, 1, 1.10);

/* ── the sign ─────────────────────────────────────────────────────
   The number hangs from a wrought-iron standard planted beside the basin: a
   painted board, gilt signwriting, two links and a bracket. It replaced a black
   LED slate with a yellow progress bar that floated unsupported over the square
   and read as an advertising hoarding in a pre-industrial village.

   Three things the shape has to do at once, and the numbers below are where
   they meet:
    a) BE READ. The panel is 4.0 x 1.375 world units at scale 1 (was 5.2 x 1.46)
       and the numerals now fill it edge to edge instead of two thirds of it, so
       the board shrank by a third while the digits grew. Past a certain
       distance the small print goes and the numeral shortens (200.0M → 200M),
       which is the only reason the far framings read at all.
    b) NOT SHOUT. `signS` still holds the apparent size roughly constant as the
       camera pulls out, but it tops out at 1.95 rather than 2.3 — 7.8 units at
       the cap instead of 12, which is one and a half cottages instead of three.
    c) HANG OFF SOMETHING. The standard stands SIGN_DX to one side, on the
       ground, so the board is over the fountain and the post is beside it. */
// The panel is as SHORT as the lettering allows. A numeral fitted across the
// board is limited by the board's width, never its height, so every spare
// millimetre of height is a bigger sign for no more legibility — which is
// exactly the trade the old 3.55:1 slate got wrong by filling barely half of
// its own face.
const TAB_W = 4.0, CANVAS_W = 1024, CANVAS_H = 288;
const TAB_H = TAB_W * CANVAS_H / CANVAS_W;   // 1.125 — the panel, world units
const SIGN_DX = TAB_W * .5 + .34;            // the standard, off to one side
const SIGN_LIFT = .40;                       // panel's lower edge above the crown
const SIGN_FLOOR = 1.95;                     // ... and never below head height
const SIGN_RISE = .82;                       // the links, board top to bracket
const SIGN_N = 8;                            // ironwork instances
// Apparent-size law. The input is HALF THE VIEW'S WORLD HEIGHT at the
// fountain's distance, not the distance itself: on foot camera.js runs a wider
// field of view, and a raw distance would size the board for a lens it is not
// being seen through. The affine intercept is what keeps the board from
// shrinking to nothing up close and doubling again at the cap.
const SIGN_A = .23, SIGN_K = 52.2, SIGN_LO = .64, SIGN_HI = 1.95;

/* ── counter formatting ──────────────────────────────────────────── */
const grouped = n => {
  const s = Math.round(Math.max(n, 0)).toString();
  let o = '';
  for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) o += THIN; o += s[i]; }
  return o;
};
// The big line is never more than 7 cells, which is what the panel is sized for.
const bigOf = n => n >= 1e9
  ? (n / 1e9).toFixed(n >= 1e11 ? 1 : n >= 1e10 ? 2 : 3) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : grouped(n);
// There is deliberately no short form for far framings. Dropping 20.00B to 20B
// frees the numeral from the panel's WIDTH, but on a 3.56:1 board it is the
// panel's HEIGHT that binds — measured, the trade bought 3 % more cap height
// for two significant figures, so the full number stays at every distance.

/* ── particle modes ──────────────────────────────────────────────── */
const M_BURST = 0, M_SPLASH = 1, M_MIST = 2;
const PN = 150;

/**
 * Build the village fountain and add it to the scene at the origin.
 * @typedef {{plazaR:number, maxAnisotropy:number, accent:number, rangeShort:string}} FountainOpts
 * @param {THREE.Scene} scene
 * @param {FountainOpts} opts
 * @returns {Object} the monument contract (see the header)
 */
export function initFountain(scene, opts = {}) {
  const aniso = opts.maxAnisotropy || 1;
  const geos = [], mats = [], texs = [];
  const g_ = g => (geos.push(g), g), m_ = m => (mats.push(m), m), t_ = t => (texs.push(t), t);

  const group = new THREE.Group();
  group.name = 'fountain';
  // `body` carries everything built in basin-radius space and is scaled by the
  // live basin radius. `group` carries only growS and the notice board, which
  // must not shrink with the stonework.
  const body = new THREE.Group();
  group.add(body);
  scene.add(group);

  /* ── materials ───────────────────────────────────────────────── */
  const surf = (m, role) => (applyTownSurface(m, role || 'prop'), m_(m));
  const std = (color, o) => surf(new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .92, metalness: 0 }, o)));

  // Faceted stone for the lathed and octagonal masonry; smooth stone for the
  // turned bowls, which a mason would actually have turned.
  const matStone = std(STONE, { flatShading: true, roughness: .94 });
  const matStoneCut = std(STONE_L, { flatShading: true, roughness: .86 });   // dressed, from tier 4
  const matStoneSm = std(STONE, { roughness: .9 });
  const matStoneD = std(STONE_D, { roughness: .95 });
  const matTimber = std(TIMBER, { roughness: .9 });
  const matIron = std(IRON, { roughness: .55, metalness: .45 });
  const matBronze = surf(new THREE.MeshStandardMaterial({ color: BRONZE, roughness: .38, metalness: .78 }), 'metal');
  const matGild = surf(new THREE.MeshStandardMaterial({
    color: GILD, roughness: .3, metalness: .85, emissive: 0x2a1c06, emissiveIntensity: .3
  }), 'metal');
  const matLeaf = std(0x51703c, { roughness: .95 });
  const matBloomF = std(0xC2564E, { roughness: .9 });

  const waterTex = t_(makeWaterTexture());
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.repeat.set(2.4, 2.4);
  waterTex.anisotropy = aniso;
  const matWater = surf(new THREE.MeshStandardMaterial({
    color: WATER, map: waterTex, roughness: .07, metalness: .04,
    transparent: true, opacity: .88
  }), 'metal');

  // Falling water: an alphaMap stripe scrolled along the tube. Basic, unlit and
  // depth-write-off, so a jet never carves a hole in the bowl behind it.
  const jetTex = t_(makeJetTexture());
  jetTex.wrapS = jetTex.wrapT = THREE.RepeatWrapping;
  const matJet = m_(new THREE.MeshBasicMaterial({
    color: 0xdff0f2, alphaMap: jetTex, transparent: true, opacity: .55,
    depthWrite: false, side: THREE.DoubleSide
  }));
  const matVeil = m_(new THREE.MeshBasicMaterial({
    color: 0xe6f4f5, alphaMap: jetTex, transparent: true, opacity: .34,
    depthWrite: false, side: THREE.DoubleSide
  }));

  const matGlass = m_(new THREE.MeshStandardMaterial({
    color: 0xFFE6BE, emissive: LAMP, emissiveIntensity: .2, roughness: .35,
    transparent: true, opacity: .92
  }));

  /* ── the basin ───────────────────────────────────────────────── */
  // One lathe: outer face, lip, inner face, floor. Eight segments, flat-shaded —
  // an octagonal basin reads as cut stone where a cylinder reads as a bucket.
  const basinProf = [
    [1.00, 0], [1.00, KERB_Y], [KERB_IN, KERB_Y], [KERB_IN, FLOOR_Y], [0, FLOOR_Y]
  ].map(p => new THREE.Vector2(p[0], p[1]));
  const basin = new THREE.Mesh(g_(new THREE.LatheGeometry(basinProf, 8)), matStone);
  basin.castShadow = basin.receiveShadow = true;
  body.add(basin);

  // The gilded lip, tier 10 only: a thin band sitting on the kerb, not a plating
  // of the whole basin. Gold leaf on a weather vane is fine; a gold fountain is
  // a different town.
  const lip = new THREE.Mesh(g_(new THREE.CylinderGeometry(1.008, 1.008, .052, 8, 1, true)), matGild);
  lip.position.y = KERB_Y - .028;
  lip.visible = false;
  body.add(lip);

  const water = new THREE.Mesh(g_(new THREE.CircleGeometry(KERB_IN - .012, 24)), matWater);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.receiveShadow = true;
  body.add(water);

  /* ── the centre: plinth, shaft, bowls ────────────────────────── */
  const plinth = new THREE.Mesh(g_(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R * 1.16, PLINTH_Y, 8)), matStone);
  plinth.position.y = PLINTH_Y / 2 + FLOOR_Y;
  plinth.castShadow = true;
  body.add(plinth);

  const shaft = new THREE.Mesh(g_(new THREE.CylinderGeometry(COL_R * .86, COL_R, COL_Y - PLINTH_Y, 8)), matStone);
  shaft.position.y = PLINTH_Y + (COL_Y - PLINTH_Y) / 2 + FLOOR_Y;
  shaft.castShadow = true;
  body.add(shaft);

  const bowlProf = [
    [0, 0], [BOWL_R * .42, .012], [BOWL_R * .8, .075], [BOWL_R, .15],
    [BOWL_R * 1.02, .175], [BOWL_R * .93, .175], [BOWL_R * .9, .10], [0, .045]
  ].map(p => new THREE.Vector2(p[0], p[1]));
  const bowl = new THREE.Mesh(g_(new THREE.LatheGeometry(bowlProf, 20)), matStoneSm);
  bowl.position.y = BOWL_Y;
  bowl.castShadow = true;
  body.add(bowl);

  // Tier 3 has no spouts yet: the bowl simply overflows, as a sheet off its rim.
  const veil = new THREE.Mesh(g_(new THREE.CylinderGeometry(BOWL_R * .99, BOWL_R * .93, BOWL_Y - WATER_Y, 18, 1, true)), matVeil);
  veil.position.y = WATER_Y + (BOWL_Y - WATER_Y) / 2;
  body.add(veil);

  const upShaft = new THREE.Mesh(g_(new THREE.CylinderGeometry(UP_R * .7, UP_R, UP_Y - BOWL_Y, 8)), matStone);
  upShaft.position.y = BOWL_Y + (UP_Y - BOWL_Y) / 2;
  upShaft.castShadow = true;
  body.add(upShaft);

  const upBowlProf = bowlProf.map(p => new THREE.Vector2(p.x * .56, p.y * .8));
  const upBowl = new THREE.Mesh(g_(new THREE.LatheGeometry(upBowlProf, 18)), matStoneSm);
  upBowl.position.y = UP_BOWL_Y;
  upBowl.castShadow = true;
  body.add(upBowl);

  /* ── the pump, at the kerb ───────────────────────────────────── */
  // Superseded by the fountain proper but never removed — a village keeps its
  // pump. It stands on the lip so it reads against the water behind it.
  const pump = new THREE.Group();
  const pBody = new THREE.Mesh(g_(new THREE.CylinderGeometry(.055, .07, .42, 8)), matIron);
  pBody.position.y = .21; pBody.castShadow = true;
  const pSpout = new THREE.Mesh(g_(new THREE.BoxGeometry(.16, .045, .05)), matIron);
  pSpout.position.set(-.10, .34, 0);
  const pHandle = new THREE.Mesh(g_(new THREE.BoxGeometry(.24, .035, .035)), matIron);
  pHandle.position.set(.12, .40, 0); pHandle.rotation.z = -.35;
  pump.add(pBody, pSpout, pHandle);
  pump.position.set(-.78, KERB_Y, .30);
  pump.rotation.y = .5;
  body.add(pump);

  /* ── instanced furniture ─────────────────────────────────────── */
  const PARK = new THREE.Matrix4().makeTranslation(0, -999, 0);
  const inst = (geo, mat, n, shadow) => {
    const m = new THREE.InstancedMesh(g_(geo), mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = !!shadow; m.receiveShadow = false;
    m.frustumCulled = false;
    for (let i = 0; i < n; i++) m.setMatrixAt(i, PARK);
    body.add(m);
    return m;
  };

  // four bronze spout heads, four water arcs
  const spouts = inst(new THREE.CylinderGeometry(.032, .05, .16, 6), matBronze, 4, true);
  const jetGeo = g_(makeJetGeometry());
  const jets = new THREE.InstancedMesh(jetGeo, matJet, 4);
  jets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jets.frustumCulled = false;
  for (let i = 0; i < 4; i++) jets.setMatrixAt(i, PARK);
  body.add(jets);

  const lantPost = inst(new THREE.CylinderGeometry(.026, .034, .78, 6), matIron, 4, true);
  const lantBox = inst(new THREE.BoxGeometry(.15, .19, .15), matGlass, 4, false);
  const planters = inst(new THREE.CylinderGeometry(.15, .12, .17, 7), matTimber, 6, true);
  const blooms = inst(new THREE.IcosahedronGeometry(.115, 0), matLeaf, 6, false);
  // The flower colour rides on a second, tiny instanced mesh so the foliage can
  // stay green: six dots of colour is all a planter needs at this camera range.
  const petals = inst(new THREE.IcosahedronGeometry(.062, 0), matBloomF, 6, false);

  // the cobbled apron, a ring of paving that appears when the square is made
  const apron = new THREE.Mesh(g_(new THREE.RingGeometry(1.0, APRON_R, 28, 1)), matStoneD);
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = .012;
  apron.receiveShadow = true;
  body.add(apron);

  /* ── light ───────────────────────────────────────────────────── */
  // ONE gated light for the lanterns. Zero in daylight, and even at the top rung
  // it is a pool of light on the square, not a beacon.
  const lamp = new THREE.PointLight(LAMP, 0, 26, 2);
  lamp.position.set(0, BOWL_Y, 0);
  group.add(lamp);

  /* ── the sign ────────────────────────────────────────────────── */
  const tabCvs = document.createElement('canvas');
  tabCvs.width = CANVAS_W; tabCvs.height = CANVAS_H;
  const c2d = tabCvs.getContext('2d');
  const boardBg = makeBoardBg();          // planks, paint and bead, painted once
  const tabTex = t_(new THREE.CanvasTexture(tabCvs));
  tabTex.colorSpace = THREE.SRGBColorSpace;
  tabTex.anisotropy = aniso;
  // Opaque, and LIT — a painted board, not a lamp. The emissiveMap is the same
  // canvas, whose ground is dark green and whose lettering is gilt, so a modest
  // emissive floor picks out the gold leaf without lighting the panel: the
  // number stays readable after dark and the board never glows. Being opaque
  // also retires the old reason for the stand-off — the upper bowl cannot show
  // through digits painted on wood.
  const tabMat = m_(new THREE.MeshStandardMaterial({
    map: tabTex, emissiveMap: tabTex, emissive: 0xffffff, emissiveIntensity: .42,
    roughness: .78, metalness: 0
  }));
  // The pivot sits ON THE GROUND at the stand-off point and yaws to the camera;
  // everything hung off it is in world units above the square, which is what
  // lets the standard reach the ground instead of stopping in mid-air.
  const tabPivot = new THREE.Group();
  const tab = new THREE.Mesh(g_(new THREE.PlaneGeometry(TAB_W, TAB_H)), tabMat);
  tabPivot.add(tab);
  group.add(tabPivot);

  // The ironwork — frame, standard, foot, bracket arm, brace, two links — as
  // ONE instanced mesh on the material the pump already uses. A signpost is
  // seven boxes; it must not cost a bucket. +1 draw call, 84 triangles.
  const iron = new THREE.InstancedMesh(g_(new THREE.BoxGeometry(1, 1, 1)), matIron, SIGN_N);
  iron.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  iron.castShadow = true; iron.receiveShadow = false;
  iron.frustumCulled = false;
  tabPivot.add(iron);

  // the celebration title plate, above the board
  const plateCvs = document.createElement('canvas');
  plateCvs.width = 512; plateCvs.height = 128;
  const plateTex = t_(new THREE.CanvasTexture(plateCvs));
  plateTex.colorSpace = THREE.SRGBColorSpace;
  const plateMat = m_(new THREE.MeshBasicMaterial({ map: plateTex, transparent: true, depthWrite: false }));
  const plate = new THREE.Mesh(g_(new THREE.PlaneGeometry(3.1, .78)), plateMat);
  plate.visible = false;
  tabPivot.add(plate);

  /* ── ceremony furniture ──────────────────────────────────────── */
  const swMat = m_(new THREE.MeshBasicMaterial({
    color: GOLD_HI, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide
  }));
  const shock = new THREE.Mesh(g_(new THREE.RingGeometry(.88, 1, 48, 1)), swMat);
  shock.rotation.x = -Math.PI / 2;
  shock.position.y = .05;
  shock.visible = false;
  group.add(shock);

  const bloomMat = m_(new THREE.MeshBasicMaterial({
    color: 0xFFF3D2, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending
  }));
  const flash = new THREE.Mesh(g_(new THREE.SphereGeometry(1, 12, 10)), bloomMat);
  flash.visible = false;
  group.add(flash);

  /* ── particles ───────────────────────────────────────────────── */
  // Droplets, mist and celebration confetti share one pool. `death` is an
  // ABSOLUTE wall-clock stamp, not a dt countdown: at the ~1 fps a headless shot
  // paints at, a dt-decremented lifetime never expires, the pool saturates and
  // every mote freezes at its birth position. That bug ate the altar's fountain
  // once already; it is not repeated here.
  const parts = [];
  for (let i = 0; i < PN; i++) parts.push({ mode: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, death: 0, born: 0, r: 1, g: 1, b: 1, sz: 1 });
  let pCursor = 0;
  const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3);
  const pGeo = g_(new THREE.BufferGeometry());
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = m_(new THREE.PointsMaterial({
    size: .18, vertexColors: true, transparent: true, opacity: .9,
    depthWrite: false, sizeAttenuation: true
  }));
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  group.add(points);
  const tmpC = new THREE.Color();

  const freePart = () => {
    for (let k = 0; k < PN; k++) {
      const p = parts[pCursor]; pCursor = (pCursor + 1) % PN;
      if (p.life <= 0) return p;
    }
    return null;
  };

  /* ── state ───────────────────────────────────────────────────── */
  let tier = 0, pendingRow = null;
  let target = 0, disp = 0, lastDraw = -1e9, lastKey = '';
  let nextTok = 0, prog = 0;
  let last = 0, lastOuterR = 39, innerR = 17.5, plazaNow = opts.plazaR || 12;
  let growS = 1, screenK = 1, camD = 62, halfV = 26;
  // How much of the panel's small print is worth painting, and whether the
  // numeral has to shorten to be read at all. Both are functions of the board's
  // APPARENT height, so they are steady under a zoom and correct on foot.
  let det = 1, boardTopY = TAB_H;
  let accentHex = (opts.accent >>> 0) || GOLD_HI, wantAccent = accentHex;
  let rangeHdr = 'TOKENS ' + String(opts.rangeShort || 'today').toUpperCase();
  let rangeSet = !!opts.rangeShort;
  let cer = null, celT = 0, shockT = 0, pulseT = 0, resetT = 0;
  let lastSplash = 0, lastMist = 0, lastSig = 1e9;
  let scroll = 0;

  // eased scalars — every rung is reached by exponential ease, so a jump from
  // tier 0 to tier 9 runs the same code as one rung. `tabS` is NOT in here: it
  // tracks the camera, not the ladder, and a rung target would fight it.
  const S = { foot: T_FOOT[0], crown: T_CROWN[0], light: 0 };
  const Sg = Object.assign({}, S);
  let tabS = .8;
  // per-part reveal, eased the same way; pop() bends it into an arrival
  const RV = ['water', 'pump', 'plinth', 'col', 'bowl', 'veil', 'spout', 'jet',
    'lant', 'plant', 'apron', 'up', 'lip'];
  const rev = {}, revT = {};
  for (const k of RV) { rev[k] = 0; revT[k] = 0; }

  const coinWorld = new THREE.Vector3(0, 1, 0);
  const attractor = { center: new THREE.Vector3(0, 0, 0), r0: 4.2, r1: 11, focus: coinWorld };
  const _cer = { phase: 'charge', k: 0 };
  // scratch — layoutInstances runs ~40 times after a tier-up and zero times in
  // steady state, but it must still not allocate
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(),
    _s = new THREE.Vector3(), _e = new THREE.Euler(), YAXIS = new THREE.Vector3(0, 1, 0);

  /* ── tier application ────────────────────────────────────────── */
  // Everything schedules against the clock town.js feeds update(), never
  // performance.now() directly, so manual __tick stepping stays coherent.
  const clockNow = () => last || performance.now();

  function setRow(n) {
    Sg.foot = T_FOOT[n];
    Sg.crown = T_CROWN[n];
    Sg.light = T_LIGHT[n];

    revT.water = n >= 1 ? 1 : 0;
    revT.pump = n >= 1 ? 1 : 0;
    revT.plinth = n >= 2 ? 1 : 0;
    revT.col = n >= 3 ? 1 : 0;
    revT.bowl = n >= 3 ? 1 : 0;
    revT.veil = n >= 3 && n < 4 ? 1 : 0;       // superseded by the spouts
    revT.spout = n >= 4 ? 1 : 0;
    revT.jet = n >= 4 ? 1 : 0;
    revT.lant = n >= 5 ? 1 : 0;
    revT.plant = n >= 6 ? 1 : 0;
    revT.apron = n >= 7 ? 1 : 0;
    revT.up = n >= 9 ? 1 : 0;
    revT.lip = n >= 10 ? 1 : 0;

    // Dressed stone from tier 4: the mason came back. This is the whole of the
    // "better stonework" upgrade — a material swap, not more geometry.
    const cut = n >= 4;
    basin.material = cut ? matStoneCut : matStone;
    plinth.material = shaft.material = upShaft.material = cut ? matStoneCut : matStone;
  }

  function applyTier(n, animate) {
    n = clamp(Math.round(n || 0), 0, TMAX);
    const changed = n !== tier;
    tier = n;
    // The getters (tierName, plazaWant, crownHeight) must be truthful the
    // instant town.js asks — it posts the ticker line and reframes the camera
    // off this call. Only the VISIBLE arrival is deferred, to the flash.
    if (animate && changed) {
      cer = { t0: clockNow(), climbed: false };
      pendingRow = n;
      return;
    }
    pendingRow = null;
    setRow(n);
    if (!animate) {
      Object.assign(S, Sg);
      for (const k of RV) rev[k] = revT[k];
      layoutInstances();
      applyState(clockNow(), 0);
    }
  }

  /* ── instanced layout, rebuilt only when the eased shape moves ── */
  // One scalar summarises the shape; when it stops moving, compose() stops being
  // called. ~40 rebuilds for a second after a tier-up, exactly zero in steady
  // state.
  const instSig = () => rev.spout * 3.1 + rev.jet * 5.3 + rev.lant * 7.7 +
    rev.plant * 11.3 + rev.up * 13.9;

  function place(mesh, i, x, y, z, s, ry) {
    _v.set(x, y, z);
    _q.setFromAxisAngle(YAXIS, ry || 0);
    _s.setScalar(s);
    _m.compose(_v, _q, _s);
    mesh.setMatrixAt(i, _m);
  }

  function layoutInstances() {
    const sp = pop(rev.spout), jt = pop(rev.jet), ln = pop(rev.lant), pl = pop(rev.plant);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
      if (sp > .01) {
        // heads lean out and slightly down, which is what makes the arc read
        _v.set(Math.cos(a) * SPOUT_R, SPOUT_Y, Math.sin(a) * SPOUT_R);
        _e.set(0, -a, Math.PI / 2 - .5);
        _q.setFromEuler(_e);
        _s.setScalar(sp);
        _m.compose(_v, _q, _s);
        spouts.setMatrixAt(i, _m);
      } else spouts.setMatrixAt(i, PARK);

      if (jt > .01) {
        // The arc geometry is authored along +x from the spout; yaw it into place.
        _v.set(Math.cos(a) * SPOUT_R, SPOUT_Y, Math.sin(a) * SPOUT_R);
        _q.setFromAxisAngle(YAXIS, -a);
        _s.setScalar(jt);
        _m.compose(_v, _q, _s);
        jets.setMatrixAt(i, _m);
      } else jets.setMatrixAt(i, PARK);

      if (ln > .01) {
        const la = Math.PI / 4 + i * Math.PI / 2 + Math.PI / 4;
        place(lantPost, i, Math.cos(la) * LANT_R, .39 * ln, Math.sin(la) * LANT_R, ln, la);
        place(lantBox, i, Math.cos(la) * LANT_R, (.78 + .10) * ln, Math.sin(la) * LANT_R, ln, la);
      } else { lantPost.setMatrixAt(i, PARK); lantBox.setMatrixAt(i, PARK); }
    }
    for (let i = 0; i < 6; i++) {
      if (pl > .01) {
        const pa = i / 6 * Math.PI * 2 + .35;
        const x = Math.cos(pa) * PLANT_R, z = Math.sin(pa) * PLANT_R;
        place(planters, i, x, .085 * pl, z, pl, pa);
        place(blooms, i, x, .215 * pl, z, pl, pa * 1.7);
        place(petals, i, x + Math.cos(pa * 2.3) * .05, .275 * pl, z + Math.sin(pa * 2.3) * .05, pl, pa);
      } else { planters.setMatrixAt(i, PARK); blooms.setMatrixAt(i, PARK); petals.setMatrixAt(i, PARK); }
    }
    spouts.instanceMatrix.needsUpdate = true;
    jets.instanceMatrix.needsUpdate = true;
    lantPost.instanceMatrix.needsUpdate = true;
    lantBox.instanceMatrix.needsUpdate = true;
    planters.instanceMatrix.needsUpdate = true;
    blooms.instanceMatrix.needsUpdate = true;
    petals.instanceMatrix.needsUpdate = true;
    lastSig = instSig();
  }

  /* ── per-frame visual state ──────────────────────────────────── */
  function applyState(now, night) {
    body.scale.setScalar(S.foot);

    const w = pop(rev.water), pu = pop(rev.pump), pi = pop(rev.plinth),
      co = pop(rev.col), bo = pop(rev.bowl), ve = pop(rev.veil),
      ap = pop(rev.apron), up = pop(rev.up);

    water.visible = w > .02;
    water.scale.setScalar(Math.max(.01, w));
    // The surface rides a shallow standing swell so a still frame still reads as
    // liquid, and the map scrolls under it.
    water.position.y = WATER_Y + Math.sin(now / 1400) * .004;

    pump.visible = pu > .02;
    pump.scale.setScalar(Math.max(.01, pu));
    plinth.visible = pi > .02;
    plinth.scale.set(1, Math.max(.01, pi), 1);
    shaft.visible = co > .02;
    shaft.scale.set(1, Math.max(.01, co), 1);
    bowl.visible = bo > .02;
    bowl.scale.setScalar(Math.max(.01, bo));
    veil.visible = ve > .02;
    veil.scale.set(1, Math.max(.01, ve), 1);
    upShaft.visible = upBowl.visible = up > .02;
    upShaft.scale.set(1, Math.max(.01, up), 1);
    upBowl.scale.setScalar(Math.max(.01, up));
    apron.visible = ap > .02;
    apron.scale.setScalar(Math.max(.01, .55 + ap * .45));
    lip.visible = rev.lip > .04;

    // Lantern glass and the one light. Warm, low, and gone by day.
    const nightK = clamp(night * 1.35 - .18, 0, 1);
    const flick = 1 + .05 * Math.sin(now / 260) + .03 * Math.sin(now / 91);
    matGlass.emissiveIntensity = (.12 + nightK * 1.5) * flick;
    lamp.intensity = S.light * nightK * flick;
    lamp.position.y = (BOWL_Y * .9) * S.foot;

    // getCoinPos() is a WORLD position — town.js throws its own confetti at it —
    // while the pool's own bursts are emitted in group-local space.
    coinWorld.set(0, (rev.col > .5 ? BOWL_Y : KERB_Y + .2) * S.foot * growS, 0);

    placeSign();
  }

  /* ── the sign's geometry ─────────────────────────────────────── */
  // Where the board hangs, and the ironwork that holds it there. Called from
  // applyState so `crownHeight` is truthful from the constructor onward —
  // town.js frames the camera on it before the first update() lands.
  function box(i, x, y, z, sx, sy, sz, rz) {
    _v.set(x, y, z);
    _e.set(0, 0, rz || 0);
    _q.setFromEuler(_e);
    _s.set(sx, sy, sz);
    _m.compose(_v, _q, _s);
    iron.setMatrixAt(i, _m);
  }
  // How far toward the viewer the whole sign stands. Inherited from the board
  // this replaces; ONE owner, because placeSign has to know it to keep the
  // standard's foot out of the water.
  const standOff = () => clamp(S.foot * .55, .6, 2.4);
  const _sig = { s: -1, y: -1, f: -1 };
  function placeSign() {
    const s = tabS, w = TAB_W * s, h = TAB_H * s;
    // Above the fountain's own crown, and never below the height a board has to
    // be to clear the heads of the people standing under it.
    const botY = Math.max(S.crown * S.foot + SIGN_LIFT, SIGN_FLOOR);
    const cy = botY + h * .5;
    boardTopY = botY + h;
    tab.scale.setScalar(s);
    tab.position.y = cy;
    plate.scale.setScalar(s);
    if (Math.abs(s - _sig.s) < 2e-3 && Math.abs(cy - _sig.y) < 2e-3
      && Math.abs(S.foot - _sig.f) < 2e-3) return;
    _sig.s = s; _sig.y = cy; _sig.f = S.foot;

    // The standard stands to one side — far enough that its foot lands on the
    // paving and never inside the basin. At the middle rungs SIGN_DX alone would
    // plant it in the water: the sign is sized to the camera and the fountain is
    // sized to the ladder, and around tier 8 the two cross. The bracket simply
    // reaches further instead.
    const dOff = standOff();
    const clear = Math.sqrt(Math.max(0, (S.foot * 1.14) * (S.foot * 1.14) - dOff * dOff));
    const postX = -Math.max(SIGN_DX * s, clear);
    const postTop = boardTopY + SIGN_RISE * s;
    // A hairline post is invisible past a hundred units and the board is back to
    // floating, so the standard thickens with its own height.
    const th = Math.max(.10, postTop * .034);
    const armEnd = w * .44, bl = Math.min(1.05 * s, postTop * .30);
    const linkLen = Math.max(.04, postTop - th * .81 - boardTopY);
    let i = 0;
    // the board's own iron frame, a shade proud of the panel on every side
    box(i++, 0, cy, -.045 * s, w + .11 * s, h + .11 * s, .07 * s, 0);
    box(i++, postX, postTop * .5, 0, th, postTop, th, 0);                 // the standard
    box(i++, postX, th * .55, 0, th * 1.8, th * 1.1, th * 1.8, 0);        // its foot block
    box(i++, (postX + armEnd) * .5, postTop - th * .55, 0, armEnd - postX, th * .52, th * .52, 0);
    box(i++, postX + bl * .5, postTop - th * .55 - bl * .5, 0, bl * 1.414, th * .34, th * .34, Math.PI / 4);
    box(i++, -w * .38, boardTopY + linkLen * .5, 0, th * .3, linkLen, th * .3, 0);
    box(i++, w * .38, boardTopY + linkLen * .5, 0, th * .3, linkLen, th * .3, 0);
    while (i < SIGN_N) iron.setMatrixAt(i++, PARK);
    iron.instanceMatrix.needsUpdate = true;
  }

  /* ── the sign's face ─────────────────────────────────────────── */
  // Everything here is SIGNWRITING: gilt on a dark painted board, with the
  // small print fading out as the board gets further away rather than sitting
  // there as unreadable grit. The old face was a black slate, a 176 px number
  // occupying two thirds of the width, and a saturated yellow progress bar.
  function drawTablet(big, p, d) {
    const g = c2d, W = CANVAS_W, H = CANVAS_H;
    g.globalAlpha = 1;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.drawImage(boardBg, 0, 0);

    const L = 58, R = W - 58;
    let top = 38, bot = H - 38;

    // The header carries the RANGE, so the board never lies about which window
    // it is counting ('TOKENS THIS SESSION', 'TOKENS ALL TIME'). It is the
    // first thing to go as the square gets further away.
    if (d > .02) {
      g.globalAlpha = d;
      let fs = 46;
      g.fillStyle = '#BCA57A';
      do { g.font = '600 ' + fs + 'px ' + FONT; fs -= 2; }
      while (fs > 24 && spacedW(g, rangeHdr, 8) > (R - L) * .88);
      spacedC(g, rangeHdr, W * .5, top + fs * .80, 8);
      top += fs + 12;
      bot -= 40;                                   // room for the tally below
      g.globalAlpha = 1;
    }

    // The number, fitted to the whole painted field. Measured once at a
    // reference size and scaled — canvas metrics are linear in font size, so
    // this lands exactly and never iterates.
    g.font = '700 100px ' + FONT;
    const w100 = cellsW(g, big);
    const fs = Math.max(24, Math.min((R - L) * 100 / Math.max(w100, 1), (bot - top) / .74));
    g.font = '700 ' + fs + 'px ' + FONT;
    const capH = fs * .715, baseY = top + (bot - top + capH) * .5;
    const x0 = (W - cellsW(g, big)) * .5;
    // gold leaf: a warm vertical ramp, a dark keyline and the shadow it throws
    // on the paint. Three passes, and it is the difference between painted gold
    // and yellow text.
    const grd = g.createLinearGradient(0, baseY - capH, 0, baseY + capH * .12);
    grd.addColorStop(0, '#F6DFA6'); grd.addColorStop(.44, '#E9C476');
    grd.addColorStop(.56, '#CE9C45'); grd.addColorStop(1, '#A97A33');
    g.fillStyle = 'rgba(0,0,0,.40)';
    cells(g, big, x0 + fs * .020, baseY + fs * .030);
    g.fillStyle = grd;
    cells(g, big, x0, baseY);
    g.strokeStyle = 'rgba(58,40,14,.55)'; g.lineWidth = Math.max(1, fs * .012);
    cellsStroke(g, big, x0, baseY);

    // Progress to the next rung, as notches cut in the bottom rail and filled
    // in gilt. A tally on a board is what a village would actually have; a
    // saturated bar is a loading screen.
    if (d > .02 && nextTok > 0) {
      g.globalAlpha = d;
      const n = 20, y = H - 60, pw = 8, gap = ((R - L) - n * pw) / (n - 1);
      const on = Math.round(clamp(p, 0, 1) * n);
      for (let i = 0; i < n; i++) {
        const x = L + i * (pw + gap);
        g.fillStyle = 'rgba(0,0,0,.42)'; g.fillRect(x, y, pw, 17);
        if (i < on) { g.fillStyle = '#D2A455'; g.fillRect(x, y + 1, pw - 1, 15); }
      }
      g.globalAlpha = 1;
    }
    tabTex.needsUpdate = true;
  }
  function refreshTablet() {
    const big = bigOf(Math.max(0, disp));
    const p = nextTok > 0 ? clamp(prog, 0, 1) : 0;
    // `det` is quantised into the key so the fade costs a repaint per step, not
    // one per frame while the camera eases.
    const dq = Math.round(clamp(det, 0, 1) * 8) / 8;
    const key = big + '|' + Math.round(p * 40) + '|' + rangeHdr + '|' + dq;
    if (key === lastKey) return;
    lastKey = key;
    drawTablet(big, p, dq);
  }

  /* ── particles ───────────────────────────────────────────────── */
  function paint(p, colorHex, sz) {
    tmpC.set(colorHex); p.r = tmpC.r; p.g = tmpC.g; p.b = tmpC.b;
    p.born = 1; p.sz = sz || 1;
    p.death = clockNow() + Math.max(0, p.life) * 1000;
  }
  function burst(x, y, z, colorHex, n, spd) {
    for (let i = 0; i < n; i++) {
      const p = freePart(); if (!p) return;
      p.mode = M_BURST; p.life = rand(.55, 1.25);
      p.x = x; p.y = y; p.z = z;
      const a = rand(0, Math.PI * 2), e = rand(-.2, 1.4), s = rand(spd * .35, spd);
      p.vx = Math.cos(a) * Math.cos(e) * s; p.vy = Math.sin(e) * s; p.vz = Math.sin(a) * Math.cos(e) * s;
      paint(p, colorHex, 1);
    }
  }
  // Every non-burst mote is born with the age it WOULD have had if the frame it
  // belongs to had actually been drawn, and is fast-forwarded to it — which is
  // what makes a 1 fps headless shot show real spray instead of a clump sitting
  // on the spawn point.
  function age(p, t, g) {
    p.x += p.vx * t; p.z += p.vz * t;
    p.y += p.vy * t - .5 * g * t * t;
    p.vy -= g * t;
  }
  function emitSplash(t0) {
    const p = freePart(); if (!p) return;
    const F = S.foot, i = (Math.random() * 4) | 0;
    const a = Math.PI / 4 + i * Math.PI / 2;
    p.mode = M_SPLASH;
    p.x = Math.cos(a) * JET_LAND * F + rand(-.06, .06);
    p.z = Math.sin(a) * JET_LAND * F + rand(-.06, .06);
    p.y = WATER_Y * F;
    p.vx = Math.cos(a) * rand(.1, .5); p.vz = Math.sin(a) * rand(.1, .5);
    p.vy = rand(.7, 1.6);
    age(p, t0, 6.2);
    p.life = Math.max(.05, .55 - t0);
    paint(p, 0xDDEFF2, .55);
  }
  function emitMist(t0) {
    const p = freePart(); if (!p) return;
    const F = S.foot, a = rand(0, Math.PI * 2), r = rand(.2, .68) * F;
    p.mode = M_MIST;
    p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.y = WATER_Y * F + .05;
    p.vx = Math.cos(a) * .1; p.vz = Math.sin(a) * .1; p.vy = rand(.18, .40);
    age(p, t0, 0);
    p.life = Math.max(.05, 1.5 - t0);
    paint(p, 0xE9F4F5, .42);
  }
  // Wall-clock emission with backlog fast-forward, capped so a long stall cannot
  // dump the whole pool in one frame.
  function pace(now, lastT, rate, emit, cap) {
    if (!lastT) return now;
    const dtS = Math.min((now - lastT) / 1000, 1.2);
    let n = Math.floor(dtS * rate);
    if (n <= 0) return lastT;
    if (n > cap) n = cap;
    for (let i = 0; i < n; i++) emit((n - i) / rate);
    return now;
  }
  function stepParts(dt, now) {
    const t = clamp(dt || 0, 0, .1);
    let k = 0;
    const nowMs = now || clockNow();
    for (let i = 0; i < PN; i++) {
      const p = parts[i];
      if (p.life <= 0) continue;
      if (p.born) p.born = 0;
      else {
        const g = p.mode === M_MIST ? 0 : p.mode === M_SPLASH ? 6.2 : 7.4;
        age(p, t, g);
        if (p.mode === M_MIST) p.vy *= .985;
      }
      if (nowMs >= p.death || p.y < -.5) { p.life = 0; continue; }
      pPos[k * 3] = p.x; pPos[k * 3 + 1] = p.y; pPos[k * 3 + 2] = p.z;
      pCol[k * 3] = p.r; pCol[k * 3 + 1] = p.g; pCol[k * 3 + 2] = p.b;
      k++;
    }
    pGeo.setDrawRange(0, k);
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
    points.visible = k > 0;
  }

  /* ── update ──────────────────────────────────────────────────── */
  function update(dt, now, ctx) {
    const night = ctx ? clamp(ctx.night, 0, 1) : 0;
    const dtMs = last ? clamp(now - last, 0, 500) : 16;
    last = now;
    if (ctx) {
      if (ctx.outerR > 0) lastOuterR = ctx.outerR;
      if (ctx.plan && ctx.plan.innerR > 0) innerR = ctx.plan.innerR;
      if (ctx.plazaR > 0) plazaNow = ctx.plazaR;
      // The board must never lie about which window it is counting. town.js is
      // meant to engrave it with setRangeLabel; ctx is the safety net.
      if (!rangeSet && ctx.rangeShort) engrave(ctx.rangeShort);
      const a = (ctx.accent !== undefined ? ctx.accent : ctx.dominantColor) >>> 0;
      if (a && a !== wantAccent) wantAccent = a;
    }
    // The day's hue owns the celebration ring only. Stone, water and bronze are
    // materials, not mood lighting.
    if (wantAccent !== accentHex) { accentHex = wantAccent; swMat.color.set(accentHex); }

    const cap = FOOT_ROOM(innerR) / Math.max(.5, T_FOOT[tier]);
    const gWant = Math.max(1, Math.min(growFor(lastOuterR), cap));
    growS += (gWant - growS) * (1 - Math.exp(-dtMs / 420));
    if (!resetT) group.scale.setScalar(growS);

    // The gathering ring hugs the basin. r1 is generous on purpose: the crowd is
    // the point, and a wide ring around the fountain is where the town looks
    // busiest.
    attractor.r0 = Math.max(4.2, S.foot * growS + 1.1);
    attractor.r1 = Math.max(11, attractor.r0 + 7);
    camD = ctx && ctx.camera ? ctx.camera.position.distanceTo(group.position) : 62;
    // Half the view's world height where the fountain stands. This is the whole
    // basis of the sign's size and of how much it bothers to say: it is the
    // exact conversion between a world unit and a share of the screen, and
    // unlike a raw distance it stays right when the stroll widens the lens.
    halfV = camD * Math.tan((ctx && ctx.camera ? ctx.camera.fov : 46) * Math.PI / 360);
    screenK = clamp(SIGN_A + halfV / SIGN_K, SIGN_LO, SIGN_HI);
    pMat.size = .16 * clamp(camD / 62, 1, 3.4);

    // How tall the panel actually lands on the screen, as a share of the frame.
    // The small print only appears once the panel is tall enough for it to be
    // WORDS. Under about a fiftieth of the frame a header line is three pixels
    // of grit on the paint — the old board carried exactly that smudge at every
    // wide framing — and the number is better off with the whole board.
    const hf = TAB_H * tabS / Math.max(halfV * 2, 1e-3);
    det = clamp((hf - .0450) / .0250, 0, 1);

    // the counter eases on the wall clock, so a 1 fps shot still lands on truth
    disp += (target - disp) * (1 - Math.exp(-dtMs / 260));
    if (Math.abs(target - disp) < Math.max(.5, target * 2e-6)) disp = target;
    if (now - lastDraw > 90) { lastDraw = now; refreshTablet(); }

    // ── the tier-up ceremony (3.2 s, four phases, all on the fed clock) ──
    // Scaled to a fountain: no ring climbing a spire that is only four units
    // tall. The water surges, one soft flash leaves the bowl, and a ring runs
    // out across the square — which is the part that reads from the camera.
    if (cer) {
      const e = now - cer.t0;
      if (pendingRow != null && e >= 600) { setRow(pendingRow); pendingRow = null; }
      if (e >= 600 && e < 900) {
        const k = (e - 600) / 300;
        flash.visible = true;
        flash.position.y = BOWL_Y * S.foot;
        flash.scale.setScalar(Math.max(.01, S.foot * 1.5 * k));
        bloomMat.opacity = .42 * (1 - k);
      } else if (flash.visible) flash.visible = false;
      if (e >= 800 && !cer.climbed) {
        cer.climbed = true; shockT = now;
        burst(0, BOWL_Y * S.foot, 0, 0xEAF6F7, 46, 6.5);
      }
      if (e > 3200) cer = null;
    } else if (pendingRow != null) { setRow(pendingRow); pendingRow = null; }

    // tier scalars converge frame-rate-independently; a jump from 0 to 9 runs
    // the same code as one rung, which is what makes setTier idempotent
    const k = 1 - Math.exp(-dtMs / 170);
    for (const key in Sg) S[key] += (Sg[key] - S[key]) * k;
    for (const kk of RV) rev[kk] += (revT[kk] - rev[kk]) * k;
    // The sign's size eases here, BEFORE applyState — which is what places the
    // board and rebuilds the ironwork under it, and what crownHeight reads.
    tabS += (screenK - tabS) * k;

    if (Math.abs(instSig() - lastSig) > 4e-3) layoutInstances();
    applyState(now, night);

    // ── water motion ──
    // Cosmetic, so dt is correct here: a headless shot is allowed to catch the
    // surface mid-drift. What a shot must not miss is the spray, and that is
    // wall-clock paced below.
    scroll += (dt || 0) * .06;
    waterTex.offset.set(Math.sin(scroll * 1.7) * .04, scroll);
    jetTex.offset.y = -(scroll * 9 % 1);

    const active = rev.jet > .5 && !(cer && now - cer.t0 < 600);
    lastSplash = active ? pace(now, lastSplash, 20, emitSplash, 26) : now;
    lastMist = (active && tier >= 6) ? pace(now, lastMist, 7, emitMist, 12) : now;

    // The panel's ground is dark green in the emissiveMap and its lettering is
    // gilt, so this floor picks out the gold leaf and leaves the paint alone.
    // It is a board catching the lantern light, not a lit sign — which is why
    // the daylight figure is .42 and not the old slate's .92.
    let tabEm = .42 + night * .46;
    if (prog >= .9 && nextTok > 0) tabEm += .08 + .08 * Math.sin(now / 400);
    if (pulseT) {
      const e = (now - pulseT) / 600;
      if (e >= 1) pulseT = 0; else tabEm += .34 * (1 - e);
    }

    // the ground ring, shared by celebrate() and the ceremony
    if (shockT) {
      const kw = clamp((now - shockT) / 1100, 0, 1);
      shock.visible = kw < 1;
      shock.scale.setScalar((2 + kw * (Math.max(lastOuterR * .5, plazaNow * 1.6) - 2)) / growS);
      swMat.opacity = .42 * (1 - kw) * (1 - kw);
      if (kw >= 1) { shockT = 0; shock.visible = false; }
    }
    // the celebration title plate
    if (celT) {
      const e = now - celT;
      const a = e < 260 ? e / 260 : e > 1700 ? clamp(1 - (e - 1700) / 500, 0, 1) : 1;
      plate.visible = a > .01;
      plateMat.opacity = a;
      // clear of the bracket arm, which now occupies the space directly above
      // the board — the old plate sat where the ironwork is
      plate.position.y = boardTopY + (1.35 + (1 - a) * .4 + Math.sin(now / 700) * .05) * tabS;
      tabEm += .34 * a;
      if (e > 2200) { celT = 0; plate.visible = false; }
    }
    tabMat.emissiveIntensity = Math.min(tabEm, 1.5);

    // ── the sign: beside the fountain, yaw-billboarded, never tipping ──
    // The pivot stands on the SQUARE, a little toward the viewer, and yaws so
    // the board always faces the camera. The stand-off is inherited from the
    // floating board it replaces — it is why the fountain's upper bowl never
    // ends up behind the digits — but it now also puts the standard's foot on
    // clear paving instead of in the water.
    if (ctx && ctx.camera) {
      const yaw = Math.atan2(ctx.camera.position.x, ctx.camera.position.z);
      tabPivot.rotation.y = yaw;
      const d = standOff();
      tabPivot.position.x = Math.sin(yaw) * d;
      tabPivot.position.z = Math.cos(yaw) * d;
    }

    // Epoch reset: collapse and pop back. reset() applies tier 0 IMMEDIATELY, so
    // this branch only ever drives scale — a setTier issued right after reset()
    // (which is exactly what an epoch change does) always wins.
    if (resetT) {
      const e = now - resetT;
      if (e < 420) group.scale.setScalar(Math.max(.001, growS * (1 - e / 420)));
      else if (e < 940) group.scale.setScalar(clamp(easeOutBack((e - 420) / 520), .001, 1.35) * growS);
      else { group.scale.setScalar(growS); resetT = 0; }
    }

    stepParts(dt, now);
  }

  /* ── public API ──────────────────────────────────────────────── */
  function setTotal(tok) {
    const v = Math.max(0, +tok || 0);
    if (v !== target) target = v;
    // Deliberately nothing else. The altar grew a second time past 1B; the
    // fountain does not. Past the last rung the town keeps growing and the
    // fountain keeps counting, which is the arrangement AESTHETIC.md asks for.
  }

  function setNext(tokNext, progress01) {
    nextTok = Math.max(0, +tokNext || 0);
    prog = clamp(+progress01 || 0, 0, 1);
  }

  function setTier(n, o) { applyTier(n, !o || o.animate !== false); }

  function engrave(short) {
    const h = 'TOKENS ' + String(short || 'today').toUpperCase();
    if (h === rangeHdr) return;
    rangeHdr = h; lastKey = ''; refreshTablet();
  }
  function setRangeLabel(short) { rangeSet = true; engrave(short); }

  function celebrate(title, colorHex) {
    const now = clockNow();
    celT = now; shockT = now; pulseT = now;
    drawPlate(plateCvs, plateTex, title || '', colorHex || accentHex);
    burst(0, BOWL_Y * S.foot, 0, colorHex || GOLD_HI, 60, 8);
    plate.visible = true;
  }

  function pulse() { pulseT = clockNow(); }

  function getAttractor() { attractor.focus = coinWorld; return attractor; }
  function getCoinPos() { return coinWorld; }

  function reset() {
    resetT = clockNow();
    // Applied NOW, not deferred into the scale timeline: the caller's very next
    // statement re-applies the epoch's earned tier, and a deferred applyTier(0)
    // would land half a second later and wipe it.
    tier = -1;
    applyTier(0, false);
    target = 0; disp = 0; nextTok = 0; prog = 0; lastKey = '';
    cer = null; pendingRow = null;
    celT = 0; shockT = 0; pulseT = 0;
    plate.visible = shock.visible = flash.visible = false;
    lastSplash = 0; lastMist = 0;
    for (const p of parts) { p.life = 0; p.death = 0; p.born = 0; }
    stepParts(0);
  }

  function dispose() {
    scene.remove(group);
    group.remove(lamp);
    if (lamp.dispose) lamp.dispose();
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    geos.length = mats.length = texs.length = 0;
  }

  applyTier(0, false);
  refreshTablet();

  return {
    group,
    /** live footprint; never reports smaller than the villagers' keep-out */
    get radius() { return Math.max(4.0, S.foot * growS); },
    get tier() { return tier; },
    get tierName() { return T_NAME[clamp(tier, 0, TMAX)]; },
    /** The top of the sign's painted panel — what the camera has to keep in
     *  frame, and what news.js hangs its keep-out box from. The standard's
     *  finial rises SIGN_RISE * signS above this; that is deliberately NOT
     *  included, because framing on a thin iron spike would push the whole town
     *  away for the sake of six pixels. */
    get crownHeight() { return Math.max(6, boardTopY * growS); },
    get plazaWant() { return T_PLAZA[clamp(tier, 0, TMAX)]; },
    get nightSun() { return clamp(S.light / T_LIGHT[TMAX], 0, 1); },
    /** The number ACTUALLY SHOWN right now — the footer hero reads this so the
     *  two can never print different headline numbers side by side. */
    get displayed() { return disp; },
    get ceremony() {
      if (!cer) return null;
      const e = clockNow() - cer.t0;
      if (e < 600) { _cer.phase = 'charge'; _cer.k = e / 600; }
      else if (e < 800) { _cer.phase = 'flash'; _cer.k = (e - 600) / 200; }
      else if (e < 2000) { _cer.phase = 'wave'; _cer.k = (e - 800) / 1200; }
      else if (e < 3200) { _cer.phase = 'settle'; _cer.k = (e - 2000) / 1200; }
      else return null;
      return _cer;
    },
    update, setTotal, setTier, setNext, setRangeLabel, celebrate, pulse,
    getAttractor, getCoinPos, reset, dispose
  };
}

/* ═══ geometry and canvas assets ═════════════════════════════════ */

// One water arc, authored in basin-radius space along +x from a spout at
// (SPOUT_R, SPOUT_Y) down to the surface at (JET_LAND, WATER_Y). A quadratic
// bezier is exactly the shape a low-pressure spout makes, and TubeGeometry
// gives it enough thickness to catch the light.
function makeJetGeometry() {
  const from = new THREE.Vector3(0, 0, 0);
  const ctrl = new THREE.Vector3((JET_LAND - SPOUT_R) * .55, .06, 0);
  const to = new THREE.Vector3(JET_LAND - SPOUT_R, WATER_Y - SPOUT_Y, 0);
  const curve = new THREE.QuadraticBezierCurve3(from, ctrl, to);
  return new THREE.TubeGeometry(curve, 14, .022, 5, false);
}

// Soft concentric rings plus a little noise. Used as the water's map: it is what
// stops a still frame from reading as a disc of flat paint, and it tiles.
function makeWaterTexture() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#8fb9bd'; g.fillRect(0, 0, S, S);
  g.globalAlpha = .5;
  for (let i = 0; i < 26; i++) {
    const y = i / 26 * S;
    const v = 150 + Math.round(70 * Math.sin(i * .8));
    g.strokeStyle = `rgb(${v},${v + 22},${v + 26})`;
    g.lineWidth = 2 + (i % 3);
    g.beginPath();
    for (let x = 0; x <= S; x += 8) g.lineTo(x, y + Math.sin(x / S * Math.PI * 4 + i) * 3.5);
    g.stroke();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A vertical stripe ramp scrolled along the jets. Periodic over the full canvas
// height, so wrapping and scrolling it never produces a seam.
function makeJetTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d');
  for (let y = 0; y < 128; y++) {
    const s = .5 + .5 * Math.sin(y / 128 * Math.PI * 4);
    const v = Math.round(120 + 135 * s * s);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(0, y, 4, 1);
  }
  return new THREE.CanvasTexture(c);
}

function drawPlate(cvs, tex, title, colorHex) {
  const g = cvs.getContext('2d'), W = cvs.width, H = cvs.height;
  const css = '#' + ('000000' + ((colorHex >>> 0) & 0xffffff).toString(16)).slice(-6);
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(20,18,14,.86)';
  g.beginPath();
  const r = 26, x = 8, y = 8, w = W - 16, h = H - 16;
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
  g.strokeStyle = css; g.lineWidth = 4; g.stroke();
  g.fillStyle = css; g.font = '700 62px ' + FONT;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const chars = Array.from(title || '');            // code-point safe: titles carry emoji
  while (chars.length > 4 && g.measureText(chars.join('')).width > W - 60) chars.pop();
  g.fillText(chars.join(''), W / 2, H / 2 + 3);
  tex.needsUpdate = true;
}

/* ── the painted board, under the lettering ──────────────────────
   Three planks of dark green paint on an oiled timber back, a gilt bead round
   the field, and enough weathering that it does not read as a flat swatch.
   Painted ONCE into its own canvas and blitted on every repaint: the counter
   redraws up to ten times a second while it eases and the noise loops below
   have no business running that often. Deterministic — a screenshot taken
   twice must not differ in the grain. */
function makeBoardBg() {
  const W = CANVAS_W, H = CANVAS_H;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let sd = 0x2f6b21;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);

  g.fillStyle = '#4b3826'; g.fillRect(0, 0, W, H);          // the timber back
  const fx = 15, fy = 15, fw = W - 30, fh = H - 30;
  g.fillStyle = '#2e3b2c'; g.fillRect(fx, fy, fw, fh);      // the painted field
  // three planks, each taking the weather slightly differently
  const tone = ['rgba(255,246,224,.055)', 'rgba(0,0,0,.05)', 'rgba(255,246,224,.022)'];
  for (let i = 0; i < 3; i++) {
    const y0 = fy + fh * i / 3;
    g.fillStyle = tone[i]; g.fillRect(fx, y0, fw, fh / 3);
    if (i) {
      g.fillStyle = 'rgba(0,0,0,.34)'; g.fillRect(fx, y0 - 2, fw, 3);
      g.fillStyle = 'rgba(255,240,214,.05)'; g.fillRect(fx, y0 + 1, fw, 1);
    }
  }
  // blotching where the paint has thinned, and a few scratches down to the wood
  for (let i = 0; i < 44; i++) {
    const x = fx + rnd() * fw, y = fy + rnd() * fh, r = 18 + rnd() * 70;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const up = rnd() > .45;
    gr.addColorStop(0, up ? 'rgba(168,178,148,.075)' : 'rgba(0,0,0,.06)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
  }
  g.strokeStyle = 'rgba(140,120,86,.32)'; g.lineWidth = 1;
  for (let i = 0; i < 16; i++) {
    const x = fx + rnd() * fw, y = fy + rnd() * fh, l = 12 + rnd() * 54;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (rnd() - .5) * 7); g.stroke();
  }
  // the bead: a shadow line, the gilt itself, and a highlight along its top
  g.strokeStyle = 'rgba(0,0,0,.40)'; g.lineWidth = 8;
  g.strokeRect(fx + 7, fy + 7, fw - 14, fh - 14);
  g.strokeStyle = '#B58F49'; g.lineWidth = 4.5;
  g.strokeRect(fx + 13, fy + 13, fw - 26, fh - 26);
  g.strokeStyle = 'rgba(244,222,170,.5)'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(fx + 13, fy + 11); g.lineTo(fx + fw - 13, fy + 11); g.stroke();
  // grime settling into the bottom corners, and the light falling from above
  const vg = g.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(255,244,220,.05)');
  vg.addColorStop(.55, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.20)');
  g.fillStyle = vg; g.fillRect(fx, fy, fw, fh);
  return c;
}

/* ── letter-spaced and cell-spaced text ──────────────────────────
   The header is letter-spaced by hand (canvas has no letterSpacing in the
   Electron build this ships against), and the big number is drawn in fixed
   cells so digits do not jitter horizontally as the counter eases. The cell
   ADVANCE lives in one place — cellAdv — so the width the layout fits to and
   the width the three drawing passes lay down can never disagree. */
function spacedW(g, s, sp) {
  let w = 0;
  for (const ch of s) w += g.measureText(ch).width + sp;
  return w - sp;
}
function spaced(g, s, x, y, sp) {
  let cx = x;
  for (const ch of s) { g.fillText(ch, cx, y); cx += g.measureText(ch).width + sp; }
}
function spacedC(g, s, cx, y, sp) { spaced(g, s, cx - spacedW(g, s, sp) * .5, y, sp); }

const isDigit = ch => ch >= '0' && ch <= '9';
const cellAdv = (g, ch, dw) => (isDigit(ch) ? dw + dw * .05 : g.measureText(ch).width + dw * .09);
function cellsW(g, s) {
  const dw = g.measureText('0').width;
  let w = 0;
  for (const ch of s) w += cellAdv(g, ch, dw);
  return w;
}
function cellsRun(g, s, x, y, draw) {
  const dw = g.measureText('0').width;
  let cx = x;
  for (const ch of s) {
    draw(ch, cx + (isDigit(ch) ? (dw - g.measureText(ch).width) * .5 : 0), y);
    cx += cellAdv(g, ch, dw);
  }
}
function cells(g, s, x, y) { cellsRun(g, s, x, y, (ch, cx, cy) => g.fillText(ch, cx, cy)); }
function cellsStroke(g, s, x, y) { cellsRun(g, s, x, y, (ch, cx, cy) => g.strokeText(ch, cx, cy)); }
