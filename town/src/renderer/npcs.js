// Villagers. The population is a pure function of how many buildings exist;
// the people themselves are a handful of InstancedMeshes (body, head, hat, arms,
// contact disc, lantern) whose matrices are composed on the CPU each frame — a
// THOUSAND villagers cost 7 draw calls, versus ~7000 for a Group per NPC.
// Animation is procedural (bob, waddle, arm swing, bow); nothing is parented and
// there are no skeletons, so a matrix compose IS the pose.
//
// v3: the ring+spoke road math is GONE. The town is an organic seeded street
// plan (layout.js) and villagers live entirely on `plan.graph` — every leg is
// either a straight graph edge or a short free walk to a doorstep. Curved
// streets come for free because a street IS a chain of straight edges.
//
// v4 adds the ROSTER: `folk` is a persistent, seeded cast of `cap` residents —
// name, trade, a home on a real building, a workplace, kin, a friend and a
// rival. A walking villager is a person WEARING a roster seat, not an anonymous
// matrix: `n.seed` is that seat's index and is the stable handle every other
// module holds (camera follow, deed cards, grounding slots, `--select=villager:N`).
// The roster is minted once per epoch from the plan seed, so `--seed=N` twice
// names the same people, and it outlives the villager — someone who walks home
// at dusk and comes back at dawn is the same person, in the same house.
// Also here: the Crier's npcs half (announce → walk → ring → speak), the
// protagonist's fortune band, `startle()`, and the far-tier part drop.
//
// Everything that decides EXISTENCE (spawn, role, worship slot, who is standing
// on a bridge, whether the Crier has reached the plaza) runs off the wall clock,
// so a headless screenshot at 1 fps still shows a populated, worshipping,
// announcing town. Only gait and travel are paced by dt.
//
// v5 is THE CROWD. The cap goes 160 → 1400 and the curve stops saturating, so a
// maxed plat is ~1120 people instead of a saturated 160 spread over 987 houses.
// Three things had to change to pay for that, and none of them is a draw call:
//
//   1. GEOMETRY, not draw calls, was the wall. A villager was 379 triangles (a
//      140-tri head, two 90-tri arm capsules), so 1123 of them cost 617 k
//      triangles against a 300 k budget. There are now TWO wardrobes sharing the
//      same crowd: a NEAR set (body·head·hat·limbs·disc, 287 tris in v6) capped at
//      NEAR_CAP instances, and a FAR set (a 20-tri body and a 20-tri head, 40
//      tris) at full capacity. `nearR` is re-derived ~4×/s from a distance
//      histogram so the near set always holds the people CLOSEST to the camera
//      and can never overflow. A villager owns exactly one instance slot in
//      exactly one set (`n.at` or `n.atF`), and crossing between them is an O(1)
//      swap-remove that carries the neighbour's matrices, exactly the way
//      despawn always did.
//   2. THE SIMULATION IS TIME-SLICED ON THE WALL CLOCK, never on a frame index:
//      each villager carries `nextAt`, and a frame only does the full transition
//      + steering + pose for those whose turn has come (0 / 45 / 130 / 260 ms by
//      camera distance). Travel is exact anyway — `n.acc` banks the dt they were
//      owed and `advance()` is linear in it — so a 4 Hz villager walks the same
//      distance as a 60 Hz one. At the ~1 fps of a headless shot every interval
//      has expired, so EVERYONE gets a full update and the screenshot is honest.
//   3. NOTHING ALLOCATES. The roster, the walking record behind each roster seat
//      and every path leg come from pools, so a dusk exodus of 600 people and an
//      epoch switch both cost zero garbage.
//
// v6 is THE VILLAGER AT TWO METRES. `--cam=stroll` put the camera in the lane at
// 1.35 units, and at that range v5's villager was a painted cone with a ball on
// it that other people walked through. Two things, and neither costs a draw call:
//
//   1. NOTHING WALKS THROUGH THE VIEWER. `setViewer(x, z, r)` marks a spot as
//      occupied and the crowd bears off around it — a soft, rate-limited,
//      mostly-SIDEWAYS push held outside the route in `n.px/n.pz`, so nobody
//      stops, nobody re-plans, and the lane closes up again behind you. They
//      look at you on the way past, too, which is the half of it that makes the
//      other half read as manners rather than as physics.
//   2. THE NEAR WARDROBE IS A PERSON. 239 → 287 triangles bought a lathed body
//      with a hem, a waist and shoulders; LEGS, four limbs out of the one
//      instanced mesh that used to hold two arms; a head and a body on their own
//      local matrices, so heads turn and bodies vary; hair for the bareheaded,
//      out of the hat cone that used to be scaled to zero; per-vertex shading
//      that gives every robe a dirty hem, a belt and light on the shoulders; and
//      a wardrobe of nine silhouettes over a dyed-wool palette instead of the
//      sweet-shop one. The FAR wardrobe is untouched at 40 triangles and is
//      re-proportioned to match, so crossing between them is still invisible.
//
// v7 IS THE WALK, AND IT IS ARITHMETIC. camera.js re-derived the world's scale
// off the one object in it whose size is not a matter of opinion — a person —
// and settled on 1 unit ≈ 1.78 m. Measured against that, this file had the whole
// village jogging: `p.speed` was .95–1.45 u/s, i.e. 1.7–2.6 m/s, past a camera
// walking correctly at 1.28. Everything with a physical unit is re-derived from
// the metre and says so in its own comment (see the block above VIEW_PUSH_MAX):
//
//   · speeds are 1.00–1.50 m/s with a hurried tail to 1.80, the run is a 3.2 m/s
//     jog rather than a 6.7 m/s sprint, and a pilgrim HURRIES instead of running;
//   · nobody is instantly at speed — `n.v` ramps at a walker's 1.3 m/s² and
//     brakes at 2.5, per villager, so the banked-dt slice is untouched;
//   · the feet turn at 2.4 rad/s instead of the ~9 a bare lerp was doing;
//   · THE FEET DO NOT SKATE. Cadence is π·v/step where `step` is the distance
//     that person's foot actually travels — so a faster walker takes quicker
//     steps and a longer-legged one fewer — the leg angle is a triangle wave
//     rather than a sine (a sine drags the planted foot at ⅔ of walking pace),
//     the hips fall as the legs scissor and the STANCE LEG EXTENDS by whatever
//     they did not, so the sole is within 5 mm of the road all cycle while the
//     head still only rises 6 cm, and the SWING leg shortens to clear the road,
//     which at 62 cm of leg is a knee;
//   · a cheering villager jumps 0.25 m rather than 0.98, and the crowd at the
//     fountain stands 1.5 m apart in three knots rather than 5.6 m apart in
//     three complete rings.
// And there is a FIFTH limb slot: two in five of the town now has its hands
// full — a basket, a sack, a staff — which is the leftover v6 wrote down and
// could not pay for. It is the same tube, the same material and the same draw
// call, and it costs 20 triangles on 160 people.
//
// v8 IS THE CROWD MAKING ROOM FOR ITSELF, and it is the leftover v7 wrote down:
// "villagers still walk through each OTHER, since only the viewer has personal
// space". It costs no geometry and no draw calls at all — it is simulation.
//
//   1. NOBODY WALKS THROUGH ANYBODY. `stepSeparation` is a uniform grid over
//      the ~180 people the camera can actually resolve — the near wardrobe plus
//      a shell one body deep — rebuilt by a counting sort at 30 Hz on the wall
//      clock. The push it aims is the SAME `n.px/n.pz` offset the viewer's
//      step-aside already used, held outside the route, so a route is still
//      never re-planned and the two are added and capped as ONE personal space.
//      The radius is the body as DRAWN (.158 · bw · scale) plus what the pair is
//      walking at: two people crossing a lane hold 1.87 m, two people standing
//      at the fountain hold only their own two bodies, so a knot stays a knot.
//      Measured over 500 frames at 1326 villagers: interpenetrating pairs among
//      the near set 8.2 → 1.7, pairs more than half sunk into each other
//      2.1 → 0.1, and the crowd's mean walking speed unchanged to 0.3 % —
//      nobody is braked, nobody deadlocks, they slide past. +0.01 ms.
//   2. THE CRIER WALKS TO THE PLAZA instead of appearing there. `toCrier` is
//      advanced on the wall clock, like every other existence deadline in this
//      file, so at the 1 fps of a headless capture he covers real ground; when
//      his six seconds are up he cries from where he stands rather than being
//      moved. Biggest single-frame jump: 44.9 u → 0.06 u.
//   3. THE LANTERN IS IN A FIST. It hung at a fixed .30 u — 0.53 m, unscaled by
//      its owner — on a figure whose hand is at 0.38 m. Who is carrying one is
//      decided BEFORE the pose now, so the carrying hand stops swinging, the
//      free hand is chosen around whatever they are already carrying, and the
//      lamp is placed off the same shoulder anchor and arm angles the pose
//      draws. Lamp-to-fist: 0.45 m → 0.07 m.
//
// v9 IS THE DECK, and it is one number and one term. The crowd has always known
// which edges are crossings — a quarter of the unhurried ones stop mid-span to
// watch the water — but not that a crossing is ABOVE the river, so the whole
// town walked the river bed while it did. At the old deck height of .30 that was
// 30 cm; the rebuilt bridge in buildings.js is authored for a deck at 1.05, and
// at 1.05 a village walking through its own bridges is the loudest wrong thing
// in the frame. A villager now carries `n.y`, the surface under their feet,
// lifted by a smoothstepped ramp over the painted approach (see THE DECK,
// below) and added by EVERYTHING that reads where they are: the root matrix,
// the contact disc, the lantern, the ray test, the speech tether and track().
// It is pure geometry — a function of distance walked, never of time — so the
// banked-dt slice is untouched and a 4 Hz villager climbs exactly the same ramp
// as a 60 Hz one.
import * as THREE from './vendor/three.module.js';

/**
 * Per-frame read-only town context. Owned and mutated in place by town.js.
 * Units: world units for distance (a Cottage is ~3 wide, ~3.5 tall), milliseconds for
 * now/simNow/durations, seconds for dt, radians for angles, raw tokens for tokens.
 * @typedef {Object} TownCtx
 *
 * ── clock / sky ────────────────────────────────────────────────────────────────
 * @property {number} day            daylight 0..1 (0 = full night)
 * @property {number} night          1 - day
 * @property {number} simNow         Date.now() sampled at frame start, ms
 * @property {number} [hour]         local hour 0..24, honouring ?hour=N (v4; optional)
 * @property {THREE.PerspectiveCamera} camera
 *
 * ── the numbers ────────────────────────────────────────────────────────────────
 * @property {number} totalTok       T — tokens in the selected range
 * @property {number} buildingCount  N — houses standing right now (landmarks excluded)
 * @property {number} perMin         tokens/min over the last ~30 min of buckets
 * @property {number} paceRatio      perMin ÷ this epoch's median perMin; 1 when unknown
 *
 * ── the plan ───────────────────────────────────────────────────────────────────
 * @property {Plan} plan             the current epoch's street plan; never null
 * @property {number} frontierK      growth-order key of the outermost BUILT plot
 * @property {number} band           plan.bandOf(built-1); -1 before the first building
 * @property {{cx:number,cz:number,r:number}} bounds  plan.boundsFor(built)
 * @property {number} outerR         === bounds.r
 * @property {number} plazaR         LIVE plaza radius, 12..15.5
 * @property {THREE.Vector3} monumentPos   always (0,0,0)
 * @property {()=>Array<Bldg>} getBuildings
 *
 * ── colour ─────────────────────────────────────────────────────────────────────
 * @property {Palette} palette       today's palette object
 * @property {number} accent @property {string} accentCss
 * @property {number} dominantColor  DEPRECATED ALIAS of accent
 * @property {string} dominantCss
 *
 * ── identity / range ───────────────────────────────────────────────────────────
 * @property {number} daySeed @property {number} planSeed @property {string} seedHex
 * @property {string} townName
 * @property {string} rangeKey @property {string} rangeLabel @property {string} rangeShort
 * @property {number} rangeStartMs @property {boolean} rangeIsDay
 *
 * ── ritual ─────────────────────────────────────────────────────────────────────
 * @property {number} intro          0..1 founding-ritual progress; 1 = settled
 */

/**
 * A building as `getBuildings()` hands it over. Everything past `pos`/`yaw` is v4
 * (F1) and OPTIONAL — the roster degrades to generic premises without it.
 * @typedef {Object} Bldg
 * @property {THREE.Vector3} pos  LIVE reference — copy the components, never retain
 * @property {number} yaw @property {number} [idx] @property {string} [kind]
 * @property {string} [label] @property {string} [flavor] @property {number} [tier]
 */

/**
 * Performance cap, and the roster size. 1400 measured on the reference machine at
 * s1200 (987 houses ⇒ 1123 people): cpu p50 1.2 ms and 241 draw calls, against
 * 1.0 ms / 242 for the 160 this replaced. It is a CEILING with headroom, not a
 * target — the curve below tops out around 1300, so the number is still moving
 * when the plat runs out of room for houses.
 */
export const NPC_CAP = 1400;
/**
 * Instances in the NEAR wardrobe — hats, arms and contact discs. The whole crowd
 * is drawn either way; this bounds only how many of them are drawn in FULL, and
 * they are always the ones nearest the camera (see `nearR`). 160 × 307 triangles
 * is 49 k — the cost of about 32 cottages, for the one thing the charter says is
 * the point, and the only set the stroll camera is ever standing in.
 */
export const NPC_NEAR_CAP = 160;

/**
 * THE population curve — the NPC layer owns it. A power law, NOT the saturating
 * exponential it replaced: `1 - e^(-b/80)` was already at 92 % of its ceiling by
 * 200 houses, so the last thousand buildings of a big day bought the user four
 * villagers. This is ~2.2 people per building in a hamlet easing to ~1.1 at the
 * full plat, and it never stops climbing:
 *
 *   b:   1    5   10   25   50  100  200  400  600  987 1200
 *   pop: 3   12   23   49   88  160  289  521  734 1123 1322
 *
 * @param {number} b buildings @returns {number} villagers
 */
export const popForBuildings = b =>
  b <= 0 ? 3 : Math.min(NPC_CAP, Math.max(4, Math.round(3.2 * Math.pow(b, .85))));

/* ═══ palette & shapes ══════════════════════════════════════════ */
/* Dyed wool, not paint. The v5 palette ran to chartreuse, peach and a pillar-box
   orange, which at sixty units was a bag of sweets scattered on a dun road and at
   two metres was plainly wrong for a village (AESTHETIC: "avoid saturated
   primaries … variation comes from weathering and material, not from hue"). What
   a pre-industrial village could actually dye is madder, weld, woad, walnut and
   whatever the sheep was already: warm reds that are never scarlet, blues that
   are always grey, yellows that are always ochre.
   The one thing that must survive the desaturation is VALUE SPREAD — the grass is
   olive and the roads are dun, so the crowd reads at distance by being lighter
   and darker than the ground, not by being more colourful than it. Hence oat and
   linen at the top of the range and walnut at the bottom, with the middle carrying
   what little chroma there is. */
const ROBE = [0xD9C7A4, 0xC9B48E, 0xA8906E, 0xB07A5C, 0xA85A45, 0x9C5548,
  0x7E8FA0, 0x63788C, 0x8B9A70, 0xA3AC86, 0xC9A557, 0xBE8377, 0xE3DCC7, 0x7D708A];
const SKIN = [0xF2CBA6, 0xE0B187, 0xC98F63, 0xA5714A, 0x7B5334, 0xF6DEC2];
/** Felt, straw and boiled wool — what a hat is made of, not what it is dyed. */
const HATC = [0x6B4A34, 0x46505A, 0x7A6A48, 0x84584A, 0x3E4A40, 0xBAA47C, 0x4A3A28, 0x92866A];
/** …and for the bareheaded, hair. The same cone, a quarter the height, sat down
 *  over the skull: a dark crop reads as a person from two metres, where a bare
 *  sphere reads as a bead on a stick. */
const HAIRC = [0x3A2A1E, 0x241B14, 0x6B4A2E, 0x8A6A3C, 0x9A9186, 0x5A4030, 0xB8AFA0, 0x2E2620];
/** Hose, breeches, a work skirt's underskirt. Never the robe colour — the leg
 *  reading as a separate garment is most of what makes the silhouette a person. */
const LEGC = [0x6B5A44, 0x5E5040, 0x7E7162, 0x554F46, 0x8A7B62, 0x968C7C, 0x6A6154, 0x7B6349];
/**
 * WHAT THEY ARE CARRYING. A village street is people with their hands full —
 * the previous pass said so in its own leftovers ("nobody carries a load") and
 * could not fix it, because all four limb slots were spent on limbs.
 *
 * There is now a fifth, and it is THE SAME twenty-triangle tapered tube: the
 * limb mesh is one geometry, one material and one draw call, so a load is a
 * matrix and a colour and nothing else. The tube is wider at the top than the
 * bottom, which is exactly the section of a basket, and squashed on its own
 * axis it is a sack; stretched thin and long it is a staff.
 *
 *   sx/sy   scale across and along the tube (it is .048 wide, .20 long)
 *   x/y/z   where it hangs, in the body's frame (x is signed: + is their right)
 *   rx/rz   tilt fore-and-aft, and over toward the shoulder
 *   hs      WHICH hand is busy — 0 left, 1 right, 2 both — and stops swinging
 *   hold    …and the angle it is held at
 *   c       what the thing is made of
 *
 * WHAT AN ARM WITHOUT AN ELBOW CAN AND CANNOT HOLD is the whole design
 * constraint here, and the first cut of this table got it wrong. A sack over
 * the shoulder needs a hand ABOVE the shoulder, and putting one there on a
 * straight limb photographs as a villager hailing a cab — which is exactly what
 * came back from the first stroll shot. So every load below is carried
 * somewhere a straight arm can honestly reach: hanging at the hip, held in
 * front in both hands, or gripped partway up a staff standing on the road.
 */
const LOADS = [
  null,                                                                       // 0 · empty-handed
  // an osier basket, hanging at the hip. The tube is already wider at the top
  // than the bottom, which is the section of a basket with no help at all.
  { sx: 1.55, sy: .62, x: -.185, y: .185, z: .015, rx: .06, rz: 0, hs: 0, hold: -.20, c: 0xD2AE72 },
  // a bundle across the front, in both hands — firewood, reeds, a bolt of cloth
  { sx: 1.30, sy: 1.15, x: -.105, y: .300, z: .150, rx: .10, rz: 1.45, hs: 2, hold: -1.02, c: 0xC2B79A },
  // a staff, or the handle of a rake: gripped at the hand, standing on the road
  { sx: .26, sy: 2.15, x: .150, y: .430, z: .050, rx: .10, rz: 0, hs: 1, hold: -.30, c: 0x8A6E48 }
];
/** Draw weights: two in five of the town has its hands full, and a basket is the
 *  commonest thing to be carrying because a village runs on them. */
const LOAD_ROLL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3];
/**
 * ONE cone, ten silhouettes. `s`/`h` scale it in the head's own frame and `y` is
 * where its base sits relative to the head's centre, so headwear rides the head
 * and turns when the head turns. `hair` picks the colour table.
 *
 * EVERY ROW MUST CONTAIN THE SKULL, and the way to do that is NOT to make the
 * cone tall. Two wrong passes are worth writing down because both are tempting:
 *
 *   · reaching ABOVE the crown is not enough — a cone's flank is a straight line
 *     and a skull's is not, so the head bulges out of the hat's side. That gave
 *     the whole town tonsures: a dark ring of "hair" round a bare orange dome.
 *   · containing the skull from a base BELOW its equator forces a cone so tall
 *     and so pointed that every villager is a wizard, which the charter forbids
 *     in as many words.
 *
 * The base disc has to sit ABOVE the head's equator. Then it is a lid: the disc
 * covers the widest part of the skull it cuts, and the flank only has to clear a
 * dome that is already narrowing. A hat can then be as flat as a broad straw or
 * as tall as a sugarloaf, and the head's lower half — the face — stays out in the
 * open where it belongs. Every row below is checked against a .098 sphere
 * fattened by 1/cos(π/7), because the cone has SEVEN sides and its facets sit
 * inside its nominal radius; that factor is precisely what the pass before this
 * one was missing when slivers of skull came through the flats.
 */
const HEADWEAR = [
  { s: 1.00, h: .78, y: .040, hair: 0 },    // felt hat, the everyday one
  { s: 1.00, h: .80, y: .014, hair: 0 },    // coif, down over the ears
  { s: .86, h: 1.55, y: .046, hair: 0 },    // sugarloaf — the tall one
  { s: 1.10, h: .55, y: .032, hair: 0 },    // bonnet
  { s: 1.24, h: .42, y: .052, hair: 0 },    // broad straw, for the fields
  { s: 1.10, h: .90, y: .000, hair: 0 },    // hood
  { s: 1.14, h: .60, y: .018, hair: 1 },    // kerchief over the hair
  { s: 1.10, h: .98, y: -.012, hair: 1 },   // hair, worn long
  { s: 1.06, h: .52, y: .028, hair: 1 },    // hair, cropped
  { s: 0, h: 0, y: 0, hair: 1 }             // shaven
];
/** Draw weights for HEADWEAR: about half the town in a hat, a little under half
 *  bareheaded-with-hair, and one in twenty shaven. */
const HW_ROLL = [0, 0, 1, 1, 2, 3, 4, 5, 6, 6, 6, 7, 7, 8, 8, 8, 8, 9, 6, 1];
/* Where the crowd at the fountain stands. Radii are OFFSETS from the altar's own
   keep-out radius — the fountain is someone else's module and grows with its
   tier — and `span`/`base` are the arc each group occupies, in radians.
   THEY USED TO BE WHOLE RINGS, and that is what made a gathering read as a
   scattering: fountain.js's r0 is 4.2, so ring one was 5.0 u round, 31.4 u of
   circumference shared by ten people — 3.1 u apart, which is 5.6 m. Nobody
   stands 5.6 m from the person they came to the well to talk to. But 42 people
   at a conversational 1.5 m cannot close a 31 u circle either, so the fix is not
   more people or a tighter radius: it is that a crowd at a fountain is NOT a
   ring. It is two or three knots of people, at different distances from the
   water, with room to walk between them. Each group below is spaced 1.5 m along
   its own arc, and the arcs sit on different sides at different radii. */
const WRINGS = [                          // offset, slots, arc span, arc centre → 42 places
  [.55, 12, 1.95, 0.35],
  [1.45, 14, 1.93, 2.55],
  [2.45, 16, 1.89, 4.75]
];
/* ── the two wardrobes ──────────────────────────────────────────
   NEAR_R_MAX just stops a hamlet from calling someone across the valley "near";
   the real limiter is NPC_NEAR_CAP, enforced by re-deriving `nearR` from a
   distance histogram, so the detailed set always holds the closest people. The
   hysteresis band is generous because a wardrobe change costs a swap-remove and
   a colour upload, and a villager pacing the threshold must not pay it twice a
   second. */
const NEAR_R_MAX = 150, NEAR_HYST = 9;
const DBUCKETS = 40, DSTEP = 6;              // 40 × 6 units = the histogram's reach
/** Wall-clock update intervals, ms, by camera distance band. Index 0 is "every
 *  frame". A frame longer than an interval simply banks more dt, so at the ~1 fps
 *  of a headless shot every band collapses to band 0 and nobody is stepped. */
const LOD_MS = [0, 45, 130, 260];
const LOD_D2 = [46 * 46, 95 * 95, 185 * 185];   // < → band 0, 1, 2; else band 3
// top of the skull in local units — where a speech bubble is tethered
const HEAD_Y = .60;
/* ── the figure, in local units (feet at 0, crown at .595) ──────────
   Written down because six different poses read them and a figure whose hips and
   shoulders disagree by two centimetres is a figure whose legs come out of its
   chest. `HEAD_C` is the head's centre; the body lathe closes at .424, safely
   inside the skull, so there is never a gap at the neck however the head turns. */
const LIMBS = 5;                 // instances of `IM.arm` per villager: 2 arms, 2 legs, 1 load
const HEAD_C = .490;             // head centre, in the body's frame
// The shoulder sits OUTSIDE the chest (the lathe's widest ring is .142) or the
// arms are inside the smock and the villager has none — which is exactly what the
// first render of this looked like from above.
const SHO_X = .134, SHO_Y = .342;   // shoulder anchor — the flat top of the limb
                                    // has to be UNDER the shoulder, not on it
const HIP_X = .072, HIP_Y = .215;   // hip anchor
/** Limb scale. The geometry is .20 long and .048 at the shoulder, which as an ARM
 *  is a paddle — two lengths to a width, where a real arm is nearer eight. Thin
 *  it hard and lengthen it slightly and the same twenty triangles read as a limb;
 *  the leg keeps its thickness, because it is carrying someone. */
const ARM_L = 1.05, ARM_W = .58, LEG_L = 1.075, LEG_W = 1.02;
/* ═══ WHAT ONE WORLD UNIT IS, AND WHAT THAT MAKES A WALK ════════
   camera.js derived the scale off the only object in this town whose size is
   not a matter of opinion — a person. A villager stands .595 × scale, which at
   the reference figure is .964 units, and an adult is 1.72 m. So

       1 world unit ≈ 1.78 m

   and the architecture agrees rather than deciding: a cottage ridge comes out
   at 6.2 m, a manor's at 10.5, a lane at 6.6 m across.

   EVERY SPEED, STRIDE AND PERSONAL SPACE IN THIS FILE IS WORTH 1.78× WHAT IT
   READS, and until this pass they were all authored as if a unit were a metre.
   `p.speed` ran .95–1.45 u/s — 1.7–2.6 m/s — so the entire village was
   power-walking or jogging past a camera that walks correctly at .72 u/s. The
   step-aside displaced people 2.2 m at 4.3 m/s, a cheering villager jumped
   0.98 m off the ground, and the gait phase was a bare constant times speed, so
   a fast walker's feet skated rather than stepping faster.

   Everything below is re-derived from 1 u = 1.78 m and says what it is worth in
   metres, so the next person to touch one can check the arithmetic. The
   reference for all of it is camera.js's own walker: STROLL_SPEED .72 u/s
   (1.28 m/s), STROLL_STRIDE .42 u (0.75 m), 103 steps a minute. */
const U_M = 1.78;                   // metres per world unit. Documentation, and the
                                    // divisor every comment below is checked against.
/** THE WALK. A comfortable adult walk is 1.3 m/s; a village amble is slower and
 *  an errand faster, so the band is 1.00–1.50 m/s with the camera's own 1.28 m/s
 *  sitting in the middle of it. Variety is the point — but the variety is
 *  between 1.0 and 1.5, not between a march and a jog. */
const WALK_MIN = .56, WALK_VAR = .28;      // .56–.84 u/s = 1.00–1.50 m/s
/** …and one in six is late. Not a run: a hurried walk, the pace of somebody who
 *  has left the bread in. Tops out at 1.80 m/s, which is brisk and still a walk. */
const WALK_HURRY = .17, HURRY_P = .17;     // +.17 u/s = +0.30 m/s
/** Gears. `run` is a villager hurrying across a square to see what happened —
 *  3.2 m/s, a jog. On the old base 2.6× was 3.8 u/s = 6.7 m/s, which is a
 *  sprinter, and the pilgrim's 1.9× was 4.9 m/s, which is nobody. A pilgrim is
 *  HURRYING, so they get the hurry gear and not the running one. */
const GEAR_RUN = 2.55, GEAR_HURRY = 1.55;  // ×.70 ⇒ 3.18 m/s and 1.93 m/s
/** Nobody starts at full speed and nobody stops dead. 1.3 m/s² to get going and
 *  2.5 m/s² to stop, because people brake harder than they accelerate; a walk
 *  reaches its own pace in about a second, which is what a person does. */
const ACCEL = .73, BRAKE = 1.40;           // u/s²
/** Radians per second the FEET may turn through, walking or pivoting. The lerp
 *  alone was ~9 rad/s on a big error, i.e. a villager snapping 90° round a
 *  corner inside a tenth of a second. camera.js caps its walker at 1.7; a
 *  villager not carrying a lens may pivot faster than that, but not by much. */
const TURN_RATE = 2.4, TURN_K = 7;
/** THE STEP, and it is not a free parameter. `stepU` below is the distance the
 *  foot actually travels in one step — 2 · (hip→sole) · sin(swing) — so
 *  ω = π·v/step is the ONE phase rate at which the planted foot does not skate,
 *  and cadence follows speed by construction: a faster walker takes quicker
 *  steps, and a longer-legged one takes fewer of them. The old `spd * 5.8` was a
 *  fixed .96 m step at any speed, which is a stride nobody has and a foot that
 *  slides at every pace but one.
 *  LEG_SWING is set so the reference figure's step is .39 u = 0.70 m — .72 u/s
 *  over a 0.70 m step is 107 steps a minute, against camera.js's 103. */
const LEG_SWING = .60;                     // rad at stride 1 ⇒ 0.70 m step
const PH_MAX = 16;                         // rad/s ceiling — the pop-in scale can't churn legs
/** The leg angle is a TRIANGLE wave, not a sine: θ = A·(.6s + .4s³) is the first
 *  two terms of one and costs a multiply-add. It matters because a sine's angular
 *  velocity peaks 1.67× its mean mid-step, so a sinusoidal leg drags its planted
 *  foot backwards through the road at two thirds of walking pace. At .6/.4 the
 *  mid-step foot speed is 1.00× walking pace: the foot is STILL. */
const TRI_A = .6, TRI_B = .4;
/** THE HIPS AND THE FEET DISAGREE, and both of them are right. Straight rigid
 *  legs scissored to ±34° put their soles 11 cm off the road unless the hips
 *  fall the same 11 cm — and a real walk moves the head about 5, because a real
 *  walk has knees. Splitting the difference means picking which of the two
 *  errors to ship, and the measured pair at .65 was a 7.3 cm bounce AND a 3.6 cm
 *  float, i.e. both of them.
 *  So neither. `BOB_K` is how far the hips fall — .55 is a 6.1 cm head rise,
 *  which is a walk — and the STANCE LEG EXTENDS by whatever the hips did not,
 *  which is 1/cos θ to second order, 8 % at full stride, and one multiply in a
 *  scale that was already being written. Measured: the sole is within 5 mm of
 *  the road through the whole cycle, at any stride, at any speed. */
const BOB_K = .55;
/** …and the SWING leg shortens as it passes: 7 cm of clearance at mid-swing,
 *  which at 62 cm of leg is the whole of what a knee looks like from two
 *  metres, and is what stops the forward foot ploughing the road. */
const KNEE_K = .12;
/** How far a villager will step out of their own lane to let the viewer through,
 *  and how fast they are willing to do it. A push, never a collision: people in
 *  a village step aside, they do not stop dead and they do not teleport.
 *  1.25 u was a 2.2 m sidestep at 4.3 m/s — a dive, not a courtesy. .62 u is
 *  1.10 m, which is the room you give someone on a lane, and 1.5 u/s is 2.7 m/s,
 *  matching camera.js's own OFF_RATE: a sidestep is faster than a walk. */
const VIEW_PUSH_MAX = .62, VIEW_PUSH_RATE = 1.5, VIEW_PUSH_TAU = .17;
/** How much of the push is SIDEWAYS rather than backwards. Above 1 the step is
 *  mostly a slide along the lane, which is what a person does; at 0 it is a shove
 *  in the chest, which is what a physics engine does. */
const VIEW_PUSH_SIDE = 1.25;
/* The viewer's personal space. 1.45 u is 2.58 m centre-to-centre, which is not
   the room one person leaves another on a lane — it is most of a 6.6 m lane, and
   the crowd parts like a bow wave. 1.05 u is 1.87 m between centres, so two
   people pass with about a metre of air between their shoulders, which is what
   passing a stranger in a village actually measures.
   NOTE FOR town.js: it calls setViewer(x, z, 1.9) — 3.4 m — and that override,
   not this default, is what the stroll camera uses. 1.15 would match. */
const VIEW_R_DEF = 1.05;
/** …and how far away they notice you at all. 4.6 u is 8.2 m, which is about
   right for catching someone's eye down a lane, and the weight falls off as the
   square, so the actual head-turn happens much nearer than that. Correct as it
   stands. */
const VIEW_LOOK_R = 4.6;
/* ═══ THE CROWD'S OWN PERSONAL SPACE ════════════════════════════
   Until this pass only the VIEWER had any, and 1326 villagers walked straight
   through each other. At 200 units up nobody could tell; at eye height, in a
   lane or round the fountain, it is the most obviously wrong thing left.

   It is the SAME machinery as the viewer's step-aside — a soft target
   displacement held in `n.px/n.pz` outside the route, eased on the wall clock
   and rate-limited — so people slide past each other rather than stopping dead,
   and not one path is ever re-planned. All that is new is who is asking for
   room, and how the asking is found cheaply (see `stepSeparation`).

   THE RADIUS IS THE BODY, not a tuned constant. The lathe's widest ring is .158,
   so a villager's own footprint is .158 · bw · scale — .26 u, 0.46 m, for the
   reference figure — and a pair stops interpenetrating exactly when their
   centres clear the SUM of the two. Measured that way, a stout villager and a
   slight one each get the room they actually take up. SEP_R_MAX caps the pair
   radius: `poseK` inflates the whole crowd by up to 1.5× for a distant camera,
   and widening the lanes to keep 4-pixel people apart would be a visible price
   for an invisible defect. It doubles as the grid's cell size. */
const SEP_R_MAX = .70;      // pair-radius ceiling, u — 1.25 m
/** …AND ROOM TO SEE IT COMING, which is the difference between avoidance and
 *  collision response, and was worth more than every other number here put
 *  together. Two villagers close at about 1.6 u/s, so the ~0.6 u of overlap they
 *  have to resolve lasts 0.4 s — the same order as the .17 s easing and the
 *  1.5 u/s rate limit that make the push a step-aside rather than a snap. Bear
 *  off only once the bodies touch and the correction is always arriving late: it
 *  measured 2.5 interpenetrating pairs against 5.9 with nothing at all.
 *  So personal space is the body PLUS what you are walking at, per villager,
 *  0 at a standstill and .45 u at a walk. Two people crossing a lane hold
 *  1.05 u — 1.87 m, which is precisely the passing distance VIEW_R_DEF is
 *  authored to, "about a metre of air between their shoulders" — while two
 *  people STANDING at the fountain hold only their own two bodies, so a knot
 *  round the water stays a knot instead of being combed out into a ring. */
const SEP_LOOK = .45;       // 0.80 m of extra room, at a walk
const SEP_CELL = SEP_R_MAX + SEP_LOOK;     // …so the grid cell holds the widest pair
/** How far a NEIGHBOUR may move you. The neighbour and viewer pushes are added
 *  and capped TOGETHER at VIEW_PUSH_MAX, so a villager caught between the two
 *  bears off once rather than twice and nobody is shoved a metre off their lane. */
const SEP_MAX = .40;        // 0.71 m
/** How much of the push is SIDEWAYS. Two people walking at each other head-on
 *  have an away-vector pointing straight back down the lane, so a purely radial
 *  push is two villagers backing off and then walking through each other
 *  anyway. The tangent — chosen, as with the viewer, to agree with the way they
 *  were already going — is what makes it a PASS instead of a stand-off. */
const SEP_SIDE = 1.15;
/** The grid pass's own wall-clock interval and its ceilings. 30 Hz is well under
 *  the .17 s easing tau, so the push stays smooth however coarsely it is
 *  re-aimed; at the ~1 fps of a headless capture the interval has always
 *  expired, exactly like every other wall-clock deadline in this file. */
const SEP_MS = 33, SEP_CAP = 320, SEP_GN = 40;
/** …AND A FRAME BUDGET, which is not optional. Separation is a luxury: it makes
 *  a crowd nobody is looking at look better. town.js's spawn drain sizes its own
 *  budget as a fraction of what the REST of the frame cost, so anything that
 *  makes the rest of the frame dearer takes houses out of the founding cascade
 *  — and one overrun frame drops that budget to its floor, which is a latch, not
 *  a dip. Landing this pass cost the `found` bench scene 60 % of its town at
 *  three seconds and a 1601 ms drain frame against a 190 ms budget.
 *  So the pass stands down whenever a frame is already in trouble. At 60 fps it
 *  always runs; during a founding cascade, or at the ~1 fps of a headless
 *  capture, it does not — and in both of those nobody can see a villager
 *  overlap anyway. Every target it wrote expires on its own tau, so standing
 *  down is smooth rather than a snap. */
const SEP_MAX_FRAME = 90;
/* ═══ THE DECK ══════════════════════════════════════════════════
   A bridge is the one piece of this town that is NOT at ground level, and until
   this pass the crowd did not know it: `plan.graph` carries a `bridge` flag on
   the crossing edge and the villagers read it — one unhurried crossing in four
   stops mid-span to watch the water — but every one of them walked the river
   bed while they did it. At the old deck height of .30 that was 30 cm and you
   had to look for it; buildings.js has since rebuilt the crossing with an arch
   barrel per opening, cutwaters carried up into refuges and abutments where the
   road meets the bank, ALL of which are authored for a deck at 1.05. The moment
   town.js lifts it, a town that does not know about decks walks through the
   river underneath its own bridges.

   THE HEIGHT IS DUPLICATED IN THREE FILES AND THEY MUST AGREE:
     town.js   `g.position.set(b.x, 1.05, b.z)` in updateBridges — the mesh
     camera.js `DECK_Y` — where the stroll walker's feet meet a crossing
     here      the crowd's own feet.
   There is no import that could carry it: npcs and camera are siblings and
   neither may depend on core. If you change one, change all three.

   IT IS GEOMETRY, NOT A TIMER. The lift is a pure function of how far along the
   crossing you have walked, so it costs nothing to be right at 4 Hz — a
   villager stepped twice a second lands on exactly the same ramp as one stepped
   sixty times, and the banked-dt rule is untouched because no state is
   integrated. Snapping was never an option: 1.05 u is 1.87 m, and a villager
   who teleports up a storey at the bridgehead is worse than one in the water. */
const DECK_Y = 1.05;
/** How far past the deck's own end the road is still carried at deck height.
 *  buildings.js lands the deck on an abutment 1.25 long centred .28 beyond the
 *  span, under a cope whose top is the road surface — so the masonry holds the
 *  road up for about .9 u after the planks stop. Ramping before that would sink
 *  the walker into the abutment they are standing on. */
const DECK_ABUT = .80;
/** …and the embankment that gets you up there. layout.js stands the bridgehead
 *  NODES `riverW + 9` back from the channel while the deck is only `riverW +
 *  3.2` long, so a constructed crossing always leaves ~5 u of painted approach
 *  at each end — which is exactly the run this ramp wants, and is why the grade
 *  comes out at a steepish-but-honest 21 % rather than a staircase. The floor
 *  is for the stitched crossings (layout.js:671), whose deck spans the WHOLE
 *  edge and would otherwise have nowhere to climb; the ceiling stops a long
 *  approach turning into a mile-long hill. */
const DECK_RAMP_MIN = 1.4, DECK_RAMP_MAX = 6;
/** The grade the ramp averages, for the one case that has no ramp to read: a
 *  villager who left the deck on a free walk rather than along the crossing. */
const DECK_GRADE = DECK_Y / 4.4;
/* ── the lantern, and the hand that holds it ────────────────────
   It hung at a fixed .30 u — 0.53 m, and NOT scaled by its owner, so a big
   villager and a small one carried it at the same height — while this figure's
   hand is at 0.38 m. A lantern floating clear of the fist is the kind of thing
   nobody notices until they are standing next to it in a lane at night.
   The hand offset below is DERIVED from the arm the pose actually draws: the
   limb is .20 long scaled by ARM_L, pivoted at the shoulder and rotated by the
   same two angles the carrying arm is pinned to, so the two cannot drift. */
const LAMP_PITCH = -.42, LAMP_OUT = .14;   // the arm hangs forward, a little clear of the hip
const LAMP_DROP = .02;                     // …and the lantern hangs off the fist
const LAMP_ARM = .20 * ARM_L;
const HAND_X = LAMP_ARM * Math.sin(LAMP_OUT);
const HAND_Y = -LAMP_ARM * Math.cos(LAMP_OUT) * Math.cos(LAMP_PITCH) - LAMP_DROP;
const HAND_Z = -LAMP_ARM * Math.cos(LAMP_OUT) * Math.sin(LAMP_PITCH);

const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const srand = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const pick = (a, s) => a[Math.floor(srand(s) * a.length) % a.length];
const wrapPi = d => { d = (d + Math.PI) % TAU; return (d < 0 ? d + TAU : d) - Math.PI; };
const angLerp = (a, b, t) => a + wrapPi(b - a) * t;
// three convention used by the town: local +z is "front", so facing a direction
// vector (dx,dz) means rotation.y = atan2(dx,dz).
const faceOf = (dx, dz) => Math.atan2(dx, dz);
/** Two seeds in, one well-mixed seed out. NOT xor: `?seed=N` sets planSeed AND
 *  daySeed to the same value, and `a ^ a` would hand every township seed 0. */
const hash2 = (a, b) => {
  let h = (a >>> 0) ^ 0x9E3779B9;
  h = Math.imul(h ^ (b >>> 0), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
/** A seeded LCG stream. §11.1 bans Math.random() outside particles and gait noise. */
const stream = s => { let r = (s >>> 0) || 1; return () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; }; };
const one = (a, r) => a[Math.floor(r() * a.length) % a.length];

/* ═══ the naming register ═══════════════════════════════════════
   The town has a voice (see news.js's FOLK): dry, rural, slightly bureaucratic.
   Given names and surnames are drawn separately and de-duplicated at mint, so a
   roster of 1400 holds 1400 distinct people. Titles are earned by trade, never
   sprinkled — "Constable Mott" is the warden, and only the warden.
   96 × 96 = 9216 pairs for a 1400-seat roster: at 160 seats the old 50 × 48 was
   generous, at 1400 it would have run some given names clean out of surnames. */
const GIVEN = ['Mara', 'Bram', 'Odile', 'Tam', 'Wren', 'Nib', 'Perpetua', 'Otto', 'Sil', 'Fen',
  'Hollis', 'Ivy', 'Peg', 'Gil', 'Rue', 'Mott', 'Cass', 'Dorran', 'Elsie', 'Grum',
  'Hesper', 'Jory', 'Linnet', 'Merrick', 'Nance', 'Orrin', 'Pell', 'Quill', 'Rook', 'Sable',
  'Thistle', 'Ulla', 'Vetch', 'Wick', 'Yarrow', 'Zeb', 'Alby', 'Brill', 'Coll', 'Dess',
  'Emmot', 'Fira', 'Godric', 'Hattie', 'Isk', 'Jessamy', 'Kit', 'Lown', 'Morrow', 'Nix',
  'Baldric', 'Cobb', 'Dill', 'Edda', 'Fenna', 'Halden', 'Inga', 'Jem', 'Kestrel', 'Loris',
  'Maud', 'Nesbit', 'Orla', 'Pip', 'Rilla', 'Sorrel', 'Tibb', 'Ursel', 'Verity', 'Wilbe',
  'Yolande', 'Ansel', 'Bryn', 'Clemmie', 'Dunstan', 'Ester', 'Fitch', 'Gerd', 'Hob', 'Isolde',
  'Jarl', 'Kemp', 'Lettice', 'Milo', 'Nell', 'Osgood', 'Pruett', 'Quenna', 'Rand', 'Signy',
  'Tobit', 'Una', 'Vale', 'Weft', 'Ysolt', 'Garrow'];
const SUR = ['Quire', 'Cachewright', 'Tallis', 'Ledgerly', 'Ness', 'Pemb', 'Snub', 'Marrow',
  'Haskett', 'Dunnage', 'Cottrell', 'Ossick', 'Flit', 'Trundle', 'Rooksbury', 'Ashwood',
  'Vellum', 'Bellwether', 'Chalk', 'Danby', 'Emberly', 'Fettle', 'Garner', 'Hollowell',
  'Inkstead', 'Jarrow', 'Kettlewell', 'Lomax', 'Mowbray', 'Netherby', 'Oakstave', 'Pinfold',
  'Quilty', 'Ransome', 'Shrike', 'Thackery', 'Underhill', 'Vance', 'Whistledown', 'Yeardley',
  'Barrowmill', 'Crake', 'Dimity', 'Ferrers', 'Gorse', 'Hadwick', 'Larkspur', 'Meade',
  'Applegarth', 'Bracken', 'Cobbold', 'Drewitt', 'Everleigh', 'Fallowfield', 'Grindley',
  'Hazelrigg', 'Ilkeston', 'Jessop', 'Kilburn', 'Lidgate', 'Micklewhite', 'Norbury',
  'Ockham', 'Prendergast', 'Quarrington', 'Rushbrook', 'Stapleford', 'Thurlow', 'Upcott',
  'Verinder', 'Wollaston', 'Yarborough', 'Ashbourne', 'Bexhill', 'Crowmarsh', 'Deadnettle',
  'Eastleigh', 'Fernsby', 'Glaisher', 'Hartlip', 'Inglewood', 'Jerrold', 'Kingsnorth',
  'Lambourne', 'Middlehurst', 'Nunnery', 'Overbury', 'Pyecombe', 'Ravensworth', 'Sedgemoor',
  'Tarrant', 'Ufton', 'Vexley', 'Winterbourne', 'Yalding', 'Zouche', 'Braithwaite', 'Cobley'];
/**
 * Trades. `job` is a BARE singular noun that pluralises with -s (news.js writes
 * "the other {job}s"); `place` is the bare premises noun ("opened a second {place}").
 * `title` is the honorific that trade carries, or ''.
 */
const TRADES = [
  { job: 'baker', place: 'bakehouse', title: '' },
  { job: 'smith', place: 'forge', title: '' },
  { job: 'miller', place: 'mill', title: '' },
  { job: 'tanner', place: 'tannery', title: '' },
  { job: 'weaver', place: 'loom house', title: '' },
  { job: 'potter', place: 'kiln', title: '' },
  { job: 'cooper', place: 'cooperage', title: '' },
  { job: 'brewer', place: 'brewhouse', title: '' },
  { job: 'carter', place: 'cart yard', title: '' },
  { job: 'thatcher', place: 'thatch loft', title: '' },
  { job: 'mason', place: 'stone yard', title: '' },
  { job: 'fisher', place: 'quay', title: '' },
  { job: 'herbalist', place: 'physic garden', title: '' },
  { job: 'chandler', place: 'chandlery', title: '' },
  { job: 'reckoner', place: 'counting house', title: 'Tallyman' },
  { job: 'scribe', place: 'scriptorium', title: '' },
  { job: 'shepherd', place: 'fold', title: '' },
  { job: 'gardener', place: 'orchard', title: '' },
  { job: 'glazier', place: 'glass shed', title: '' },
  { job: 'roper', place: 'rope walk', title: '' },
  { job: 'ostler', place: 'stables', title: '' },
  { job: 'warden', place: 'watch post', title: 'Constable' },
  { job: 'reeve', place: 'moot hall', title: 'Councillor' },
  { job: 'physician', place: 'infirmary', title: 'Doctor' },
  { job: 'carpenter', place: 'saw pit', title: '' },
  { job: 'dyer', place: 'dye house', title: '' },
  { job: 'fletcher', place: 'bow shed', title: '' },
  { job: 'saddler', place: 'harness room', title: '' },
  { job: 'drover', place: 'beast pen', title: '' },
  { job: 'tiler', place: 'tile yard', title: '' }
];
/** House TYPES (news writes "a {home} on {quarter}"), weighted toward the humble. */
const HOME_KIND = ['cottage', 'cottage', 'cottage', 'croft', 'croft', 'row house',
  'gable house', 'long house', 'lodge', 'garret'];
/** …and the NAME the town knows that house by (the deed card's `home` row). */
const HOUSE_A = ['Hollyhock', 'Blue Door', 'Crooked', 'Low', 'Long', 'Chalk', 'Elder', 'Fox',
  'Hare', 'Kettle', 'Lark', 'Mallow', 'Nettle', 'Owl', 'Plum', 'Quince', 'Rushlight',
  'Sparrow', 'Thorn', 'Willow', 'Yew', 'Amber', 'Bell', 'Cinder', 'Damson', 'Ember'];
const HOUSE_B = ['Cottage', 'House', 'Row', 'Croft', 'Lodge', 'Gate', 'Yard', 'Steps',
  'Corner', 'Well', 'End', 'Rest'];
/** Compass quarters; index = floor((atan2 + π) / (π/4)) with north at the top. */
const QUARTER = ['the south lanes', 'the southwest rows', 'the west gate', 'the northwest rows',
  'the north lanes', 'the northeast rows', 'the east gate', 'the southeast rows'];
const PLAZA_Q = 'the plaza rim', WATER_Q = 'the waterside';
/** "{who2} is {rel} to {who}." — reads as written, in both directions. */
const RELS = ['cousin', 'neighbour', 'no relation at all', 'apprenticed', 'married',
  'landlord', 'sister-in-law', 'a rival', 'godparent', 'next door'];
/**
 * The five fortune bands, low to high. Single capitalised words: news.js sets them
 * in bold as "the word for {who} this week". Descriptive of the TOWN's opinion of a
 * villager — never a verdict on the user, never a target, never a loss.
 */
const FORTUNE = ['Quiet', 'Steady', 'Comfortable', 'Prosperous', 'Golden'];
const FORTUNE_CUT = [.55, .9, 1.25, 1.9];   // paceRatio EMA cut points, 5 bands
const HERO_TAU = 45000;                     // fortune integrates on a 45 s exponential
const HERO_HOLD = 90000;                    // …and a band change fires at most this often

/* the Crier's contract with the wall clock */
const CRY_WALK_MS = 6000;    // reach the rim by then or be counted as arrived
const CRY_SPEAK_MS = 8200;   // …and hold the plaza for this long
const CRY_COOL_MS = 2500;    // silence between announcements

/* ── how close is close enough to be overheard ──────────────────
   A speech bubble is a piece of TYPOGRAPHY hung on a person. If the person is
   four pixels tall it is a caption floating over an anthill: unreadable as
   speech, and — at the wide framings this app spends most of its life in —
   half a dozen of them at once, all attached to specks. So the crowd is mute
   until the villagers are big enough on screen to be seen talking.

   The measure is lod.js's `npc.px`, the villager's own height in CSS pixels,
   which is the ONE screen-size number the whole app agrees on (lod.js: "decided
   once for the whole app; npcs.js consumes, never recomputes"). Its far-tier cut
   is 3.5 px — the point where parts start being dropped — and that is far too
   permissive to read a sentence at; these are the second, much closer pair of
   cuts on the SAME number. 13 px in / 10.2 px out is roughly a 46-unit orbit in
   and a 62-unit orbit out at a 900 px stage: nose into the streets and the town
   talks, pull back to look at the whole thing and it goes about its business
   quietly. Hysteresis, like every other threshold here, so a drifting orbit
   cannot strobe the whole crowd on and off. */
const SPEAK_PX_IN = 13, SPEAK_PX_OUT = 10.2;
/** …and the second way in: the eye is this close to an actual villager, in world
 *  units (22 u is 39 m — across a square, not across a town). Stroll and follow
 *  put the camera in among them out at the frontier, where the town-centre
 *  measure above says "small" about somebody standing an arm's length away. */
const SPEAK_R_IN = 22, SPEAK_R_OUT = 30;
/* …and how OFTEN, once they can be heard. town.js offers the sampler a turn
   every 2.2 s, and taking every one of them is what made the street feel like a
   ticker tape with legs. One remark every 6–13 s is a town where somebody
   happens to be saying something, which is the whole effect being aimed at.
   Event lines — a building finished, a milestone — are exempt: those are the
   moments the bubble exists for and they do not wait their turn. */
const SAY_GAP_MIN = 6000, SAY_GAP_VAR = 7000;
/** How long the same mouth stays shut afterwards. Three seconds made one
 *  villager a monologue on a quiet street; a minute spreads it over the crowd. */
const SAY_MUTE_MS = 60000;
/** A building is "new" — nameable, cheerable — for this long after it lands. */
const NEW_TTL = 48000;
/** …and at most this many are remembered, newest first. */
const NEW_KEEP = 4;
/** How long a milestone keeps the festival pool in the mix. */
const FEST_MS = 26000;

/* ═══ village voices ════════════════════════════════════════════
   WHAT A VILLAGER IS ALLOWED TO SAY, and it is exactly two things: something
   TRUE about the town this second, or something kind about living in it. The
   pool this replaces was neither — it was two dozen wry asides drawn at random
   ("Rent's gone up. Obviously.", "That's my view gone."), which is why it read
   as noise: the same shrug arrived whether a chapel had just been raised, the
   market was humming, or nothing at all had happened. Grumbling is also the one
   register a companion app cannot afford, because the thing being grumbled at
   is the user's own day.

   EVERY LINE IS DROPPED RATHER THAN FAKED. A line carrying a slot the town
   cannot fill right now is skipped by `render()` and the next candidate is
   tried, so "The Bakery went up this morning" is only ever said when a bakery
   actually went up this morning, and the corpus degrades to its slotless lines
   on a town too young to have facts.

   The slots, all resolved in `slotVal()` against live state:
     {town}     the town's name            {who}      the speaker's given name
     {friend}   their friend's given name  {job}      their trade
     {place}    'the ' + their trade's premises        {quarter}  their quarter
     {home}     the kind of house they keep ('cottage')  {homeN}  its ordinal
     {n}        buildings standing
     {folkN}    people out on the street   {sky}      weather.js's own phrase
     {new}      the newest notable building, bare      ('Bakery', 'Inn')
     {New}      …the same with its article ('The Bakery') — for sentence heads
     {newN}     its ordinal in the town     {newCount} roofs raised in the last minute
     {notable}  a named building the town is proud of  {tokens} the day's total */
const VOX = {
  /* Something went up in the last ~45 s. Highest weight there is: this is the
     one moment where a villager can name a thing the user just watched arrive. */
  NEWB: [
    '{New} went up this morning. Just like that.',
    'Have you seen {new} yet? Handsome, isn\'t it.',
    'That\'s {new} finished. They were quick about it.',
    'Fresh thatch on {new}. Smells like a beginning.',
    'They ran the last beam up on {new} before noon.',
    '{New}! I watched the roof go on from right here.',
    'New neighbours at {new}. Good ones, I hear.',
    'Whoever raised {new} knew their trade.',
    'They\'ve hung a good door on {new}. I approve.',
    '{New}\'s chimney is drawing already.',
    'I carried stone for {new}. A little of it.',
    'Number {newN} in {town}, and up in a day.',
    'That makes {n} roofs, counting {new}.',
    'That\'s {newCount} new roofs this morning, and it isn\'t noon.',
    'That\'s {newCount} up while I was at the well!',
    '{friend} has taken a room at {new}. Lucky thing.',
    'They finished {new} before the mortar dried.',
    'I\'ll walk past {new} tonight, just to look at it.'
  ],
  /* The town is bigger than it was. Counts, crowds, lanes. */
  GROW: [
    '{n} buildings in {town} now. It was all field once.',
    '{town} keeps finding room for one more.',
    'Another lane to learn the name of every week.',
    'They say we\'re {n} roofs strong. Feels like more.',
    '{folkN} of us out today. That\'s a proper crowd.',
    'New faces every day, and every one of them welcome.',
    'The lanes reach further out every season.',
    'We\'ll be needing a bigger map soon.',
    'This size, and still everyone says good morning.',
    'I knew {town} when you could count it on one hand.',
    'Room for everyone, and always has been.',
    'Look at the chimneys. Just look at them all.'
  ],
  /* Trade. Warm and never a target: a good day is a good day, not a quota. */
  MARKET: [
    'Trade\'s brisk. My cart was empty by noon.',
    'Good day at the market. The best sort of tired.',
    'Coin\'s moving. That\'s all a town wants.',
    'The stalls sold out before the bell. Again!',
    'Prices fair and purses full. Long may it hold.',
    'Everything I brought in, sold. Everything.',
    'Busy morning. I do like it busy.',
    'The ledger\'s been kind this week.',
    'Steady trade beats a lucky day, my mother said.',
    'They\'re counting well up at the tower.',
    'Two carts in from the east road, both full.',
    'Sold out, and stayed anyway. Good company.',
    '{tokens} has passed through {town}. Imagine that.'
  ],
  /* The sky, whatever weather.js chose, taken as a gift. */
  WX: [
    'Look at that — {sky}. Nothing to complain of.',
    'That\'s {sky} over the square. I\'ll take it.',
    'Good drying weather.',
    'Grand day for it, whatever it turns out to be.',
    'The light on the roofs at this hour. Honestly.',
    'Mild enough to sit out, so sit out I shall.',
    'A day like this and the whole town\'s outdoors.'
  ],
  WX_WET: [
    'Rain\'s good for the barley. And the ducks.',
    'Wet lane, warm hearth. It balances.',
    'Let it come down. The wells like it.',
    'Everything\'ll be green by Thursday, you watch.'
  ],
  WX_SNOW: [
    'Snow on the thatch. Prettiest town in the county.',
    'Cold — but look at it. Just look.',
    'The children have the green already.'
  ],
  WX_SOFT: [
    'Mist\'ll burn off by ten. It always does.',
    'The whole town looks like a story this morning.',
    'Quiet air. You can hear the fountain from here.'
  ],
  /* A milestone, a festival, thunder: the rare hours. */
  FEST: [
    'They\'re ringing the bell! Come on!',
    'There\'s dancing on the green tonight, I\'m told.',
    'I have never seen the square this full.',
    'Somebody\'s broken out the good bread!',
    'A day they\'ll cut into the stone, this one.',
    'Everyone out, everyone smiling. That\'s a festival.',
    'The Crier\'s hoarse and it isn\'t even dark.',
    'Garlands on the fountain! Who did that?',
    'I\'m telling my grandchildren I stood here.'
  ],
  /* The speaker's own life: trade, premises, kin, doorstep. */
  PERSON: [
    'Off to {place}. The good part of the day.',
    'I\'m to meet {friend} by the well.',
    '{friend} says {notable} is worth the walk.',
    'Home to the {home} and my own chair.',
    'They keep {quarter} tidy. I\'ll say that for us.',
    'Years a {job}, and I still like the smell of it.',
    'Third batch today, and the day\'s not done.',
    'Best {job} in {town}, if you ask me. And you did.',
    'Come by {place} sometime. Mind the step.',
    'Look at {quarter} in this light. Lovely.',
    'I wouldn\'t swap our {home} in {quarter} for coin.',
    'Number {homeN} in {town}. Every board of it ours.',
    'Half of {quarter} was at ours last night. Half!'
  ],
  /* Loitering at the fountain — people by the water, not a congregation. */
  WORSHIP: [
    'Best water in the county, this.',
    'I come here to think. Good thoughts, mostly.',
    'Somebody\'s put flowers on the rim again.',
    'My father sat on this step. Same view.',
    'Everyone ends up here. That\'s the nice part.',
    'Cold hands, warm afternoon.',
    '"Meet at the fountain." Nobody needs directions.',
    'It\'s running well today.',
    'Coolest stone in {town} and it\'s free to sit on.',
    'I\'ll wait. It\'s no hardship, waiting here.'
  ],
  /* Dusk and after: lit windows, full houses. */
  NIGHT: [
    'Lamps lit all down the row. Lovely.',
    'Long day. Good day.',
    'Someone\'s still working up in the tower. Bless them.',
    'Bread\'s set for the morning.',
    'Quiet streets, full houses. Best kind of night.',
    'Look at all those windows.',
    'Warm bed and a finished day. That\'ll do nicely.',
    'Stars out over {town}.',
    'Shutters closed, {quarter} asleep. All\'s well.',
    'I like the walk home best, if I\'m honest.'
  ],
  /* On a crossing, which is the one place in town with a view. */
  BRIDGE: [
    'Best view in {town} from right here.',
    'River\'s high and clear today.',
    'I stop here every time. Every single time.',
    'They built this well. It doesn\'t even creak.',
    'You can see the whole square from the middle.',
    'Ducks. Every morning, the same ducks.'
  ],
  /* Something just happened and the street is cheering it. */
  CHEER: [
    'Did you see it go up?!',
    'That is a fine sight. A fine sight!',
    'Hooray! I don\'t know the half of it, but hooray!',
    'Best day this month. Possibly this year.',
    'I\'m telling everyone I was standing here.',
    'The whole lane came out for this!',
    'Ring it again!',
    'Well done us! Whoever did it!',
    'That\'s going on the stone, that is.'
  ],
  /* The ordinary street, when nothing in particular is happening — which is
     most of the time, and should still sound like somewhere worth living. */
  STREET: [
    'Morning! A lovely one.',
    'Bread\'s good today. Really good.',
    'Somebody\'s baking. I\'d know that smell anywhere.',
    'Best road in {town}, this one.',
    'The cat on the wall approves of all this.',
    'New paint on the shutters. Cheerful.',
    'The goat\'s back. Everyone\'s pleased.',
    'Cart through! Mind your toes — and good day.',
    'Somebody\'s swept the whole lane. Bless them.',
    'Washing out on every line. Good sign, that.',
    'Fiddle from an open window. I never mind it.',
    'Apples on the wall, free to whoever wants them.',
    'Nothing to report and I\'m delighted about it.',
    'Two swallows under the eaves. They\'ve chosen well.'
  ]
};
/* Compiled once: each entry becomes {t, s} — the text and the slot names it
   needs — so the usable-line test is an array walk, never a regex, at pick time. */
const VOX_SLOT = /\{(\w+)\}/g;
const VOX_C = {};
for (const k in VOX) {
  VOX_C[k] = VOX[k].map(t => {
    const s = []; VOX_SLOT.lastIndex = 0;
    for (let m; (m = VOX_SLOT.exec(t));) if (s.indexOf(m[1]) < 0) s.push(m[1]);
    return { t, s };
  });
}

/**
 * @typedef {Object} NPCConfig
 * @property {Plan} plan                     §3.5 — replaces roadR + spokes + rings. The
 *           epoch's plan; `update()` re-latches from `ctx.plan` if core swaps it.
 * @property {()=>number} frontierK          paved growth key; villagers stay inside it
 * @property {()=>number} plazaR             LIVE plaza radius (a function, not a number)
 * @property {THREE.Vector3} monument        altar centre — (0,0,0)
 * @property {number} monumentR              5.6 fallback keep-out radius
 * @property {()=>{center:THREE.Vector3,r0:number,r1:number,focus:THREE.Vector3}} [attractor]
 *           monument.getAttractor; when present it overrides monumentR
 * @property {()=>Array<Bldg>} getBuildings
 * @property {number} [cap]                  defaults to NPC_CAP; ALSO the roster size
 * @property {number} [nearCap]              defaults to NPC_NEAR_CAP — how many of the
 *           crowd wear the DETAILED wardrobe at once (see the v5 note up top)
 * @property {number} [seed]                 daySeed — clothing distribution
 */

/**
 * A person, as every other module sees them. Freshly built per call and safe to
 * retain; nothing in it is a live reference into the crowd.
 * @typedef {Object} VillagerView
 * @property {number} id        stable handle === `n.seed` === roster index
 * @property {string} name      display name — 'Mara Quire', 'Constable Mott'
 * @property {string} first @property {string} sur @property {string} title
 * @property {string} job       bare noun, pluralises with -s: 'baker'
 * @property {string} trade     display phrase: 'Baker at the Long Mill'
 * @property {string} place     bare premises noun: 'bakehouse'
 * @property {string} home      NAMES the building — 'Hollyhock Cottage'
 *           (cast() hands news the bare noun 'cottage' instead; different grammar)
 * @property {string} quarter   'the north lanes' · 'the plaza rim' · 'the waterside'
 * @property {string} fortune   this week's word for them
 * @property {number} band      0..4 fortune band
 * @property {string} rel       how they stand to their friend
 * @property {number} friend @property {number} rival   handles
 * @property {boolean} hero     the protagonist @property {boolean} crier
 * @property {boolean} alive    out on the streets right now
 * @property {string} state     '' when not out
 * @property {number} x @property {number} y @property {number} z  0,0,0 when not out
 */

/**
 * @typedef {Object} NPCSystem
 * @property {number} count            getter — live villagers
 * @property {number} worshippers      getter — villagers currently at the altar
 * @property {(n:number)=>void} setPopulation      idempotent; safe every frame
 * @property {(b:number)=>void} setBuildingCount   = setPopulation(popForBuildings(b))
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 * @property {(pos:THREE.Vector3, opts?:{runners?:number, cheerRadius?:number,
 *            milestone?:boolean})=>void} celebrate
 * @property {()=>void} pulse          700 ms unison dip of the whole congregation
 * @property {(want:?string, out:THREE.Vector3)=>?string} pickSpeaker
 * @property {()=>string} speechLine   what that speaker says; '' ⇒ caller's own pool
 * @property {()=>number} rosterSize
 * @property {(id:number)=>?VillagerView} personAt
 * @property {()=>string} randomName
 * @property {()=>?VillagerView} protagonist
 * @property {(kind:?string, out:Object)=>boolean} cast
 * @property {()=>?{x:number,y:number,z:number,name:string,text:string,ready:boolean}} crier
 * @property {(text:string)=>boolean} announce
 * @property {()=>boolean} crierSpeaking
 * @property {()=>THREE.Object3D[]} hitMeshes
 * @property {(obj:THREE.Object3D, instanceId:number)=>?VillagerView} villagerAt
 * @property {(ray:THREE.Ray)=>?{handle:number,dist:number}} raycast
 * @property {(handle:number)=>?Object} track
 * @property {(p:{x:number,z:number}, r?:number)=>?number} nearest
 * @property {(handle:?number)=>boolean} pin
 * @property {(x:number, z:number, r?:number)=>void} setViewer
 * @property {()=>void} clearViewer
 * @property {()=>void} startle
 * @property {()=>?Object} heroEvent   consuming
 * @property {()=>?Object} marketEvent consuming
 * @property {(t:?{far:boolean,stride:number})=>void} setTier
 * @property {()=>Object} stats
 * @property {()=>void} reset
 * @property {()=>void} dispose
 */

/* ═══ system ════════════════════════════════════════════════════ */
/**
 * @param {THREE.Scene} scene
 * @param {NPCConfig} cfg
 * @returns {NPCSystem}
 */
export function initNPCs(scene, cfg) {
  const MAX = cfg.cap || NPC_CAP;
  // The detailed wardrobe never needs more slots than the whole crowd has people.
  const NEAR = Math.min(MAX, cfg.nearCap || NPC_NEAR_CAP);
  const MON = (cfg.monument || new THREE.Vector3()).clone();
  const plazaR = typeof cfg.plazaR === 'function' ? cfg.plazaR : (() => cfg.plazaR || 12);
  const frontierK = typeof cfg.frontierK === 'function' ? cfg.frontierK : (() => 1e9);
  // The altar is another module. Prefer its live getAttractor() {center,r0,r1,focus};
  // fall back to a static radius so the NPCs work before it exists.
  const MONR0 = cfg.monumentR == null ? 5.6 : cfg.monumentR;
  const attract = () => (cfg.attractor && cfg.attractor()) || null;
  const monR = () => { const a = attract(); return a ? a.r0 : MONR0; };
  const monOuter = () => { const a = attract(); return a ? a.r1 : MONR0 + 4.4; };
  const monC = () => { const a = attract(); return a && a.center ? a.center : MON; };
  const polarR = n => Math.hypot(n.x - MON.x, n.z - MON.z);

  // One seeded stream for every behavioural coin-flip. Nothing here is persistent
  // town identity, but a seeded stream still makes a reload reproduce the same
  // crowd — and §11.1 bans Math.random() outside particles and gait noise.
  let rs = (((cfg.seed | 0) ^ 0x9E3779B9) >>> 0) || 1;
  const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };

  /* ── the street plan ────────────────────────────────────────────
     Everything the villagers know about the world is `graph`: nodes with
     {x,z,d,adj} and edges with {a,b,w,d,bridge}. `plan` is swapped wholesale on
     an epoch reset, so update() watches ctx.plan and re-latches. */
  let plan = cfg.plan || null;
  let graph = null, pathMode = 0;             // 0 unknown · 1 pathTo→nodes · 2 pathTo→edges
  const hasGraph = () => !!graph;
  /* ── the crossings ──────────────────────────────────────────────
     ONE record per bridge, solved when the plan is latched and then read two
     ways, so the crowd cannot possibly hold two opinions about how high a deck
     is. `deckOf` is by EDGE index, for the leg a villager is walking; `deckList`
     is the same records in a flat array, for the two places that have no leg to
     read — where a villager comes into the world, and a free walk that crosses
     one. A plan has a handful of bridges; this is never per villager. */
  const deckOf = new Map();
  const deckList = [];
  function latchGraph() {
    const g = plan && plan.graph;
    graph = g && g.nodes && g.nodes.length && g.edges && g.edges.length ? g : null;
    pathMode = 0;
    deckOf.clear(); deckList.length = 0;
    const list = (plan && plan.bridges) || [];
    for (const b of list) {
      if (!b || !isFinite(b.x) || !isFinite(b.z) || !(b.span > 0)) continue;
      // WHICH EDGE CARRIES IT. `_e` is stamped on every crossing the layout
      // builds; a plan that has stopped doing that is matched on the deck's own
      // centre instead, so this degrades to a shorter ramp, never to a wrong one.
      let ei = b._e;
      if (!(graph && isFinite(ei) && graph.edges[ei] && graph.edges[ei].bridge)) {
        ei = -1;
        if (graph) {
          let bd = 36;                                   // 6 u of slop, squared
          for (const e of graph.edges) {
            if (!e.bridge) continue;
            const A = graph.nodes[e.a], B = graph.nodes[e.b];
            if (!A || !B) continue;
            const mx = (A.x + B.x) / 2 - b.x, mz = (A.z + B.z) / 2 - b.z;
            const d = mx * mx + mz * mz;
            if (d < bd) { bd = d; ei = e.i != null ? e.i : -1; }
          }
        }
      }
      /* THE PROFILE: level over the deck and its two abutments, then an
         embankment down to the road. The run available for that embankment is
         whatever the edge has left over the deck — layout stands the bridgehead
         NODES `riverW + 9` back while the deck is only `riverW + 3.2` long, so a
         constructed crossing hands over ~5 u at each end, and eating into the
         level part is what keeps a stitched crossing (whose deck IS its whole
         edge) from having a step at the junction. */
      let flat = b.span * .5 + DECK_ABUT, ramp = DECK_RAMP_MIN;
      const e = ei >= 0 ? graph.edges[ei] : null;
      const A = e && graph.nodes[e.a], B = e && graph.nodes[e.b];
      if (A && B) {
        const len = Math.hypot(B.x - A.x, B.z - A.z) || 1e-3;
        const c = clamp(((b.x - A.x) * (B.x - A.x) + (b.z - A.z) * (B.z - A.z)) / len, 0, len);
        const run = Math.min(c, len - c);              // the shorter half owns the ramp
        ramp = clamp(run - flat, DECK_RAMP_MIN, DECK_RAMP_MAX);
        flat = Math.max(0, Math.min(flat, run - ramp));
      }
      const w = b.w > 0 ? b.w : 4;
      const rec = {
        x: b.x, z: b.z, ca: Math.cos(b.a), sa: Math.sin(b.a), hw: w * .5, flat, ramp,
        r2: (flat + ramp) * (flat + ramp) + w * w * .25      // the early-out circle
      };
      if (ei >= 0) deckOf.set(ei, rec);
      deckList.push(rec);
    }
  }
  latchGraph();
  /** How high the deck is under a bare (x,z) — 0 anywhere but on a crossing.
   *  Early-outs on a circle, so for the town's handful of bridges this is a
   *  couple of multiplies for everybody who is nowhere near one. */
  function deckAt(x, z) {
    for (let i = 0; i < deckList.length; i++) {
      const b = deckList[i], dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.r2) continue;
      if (Math.abs(dz * b.ca - dx * b.sa) > b.hw) continue;         // off the side: that is the river
      const along = Math.abs(dx * b.ca + dz * b.sa);
      const u = clamp((b.flat + b.ramp - along) / b.ramp, 0, 1);
      if (u > 0) return DECK_Y * u * u * (3 - 2 * u);
    }
    return 0;
  }

  /* ── geometry ───────────────────────────────────────────────────
     Triangle counts are the whole ballgame at four figures of villager, so they
     are written down, and the NEAR budget is 301 (v5 spent 239).

       v5 near, 239: body 28 · head 80 · hat 21 · arms 2×50 · disc 10
       v6 near, 287: body 96 · head 80 · hat 21 · limbs 4×20 · disc 10
       v7 near, 307: body 96 · head 80 · hat 21 · limbs 5×20 · disc 10
         — the fifth limb is what they are CARRYING, and it is why the arms
           still have no elbow: an elbow is two more instances of this tube
           (+40 a head, 6.4 k at z1200) and the budget for this pass was 4 k.

     Where the 48 went, and why, because a stroll camera stands at 1.35 units and
     v5's villager was authored to be four pixels across:

     · THE BODY IS A LATHE, not a cone (28 → 96). One truncated cone is a chess
       pawn: no hem, no waist, no shoulders, and at two metres that is the single
       loudest wrong note in the frame. A seven-point profile — flared hem, waist,
       chest, shoulder slope — is the same object with a person's outline, and a
       body of revolution is still ONE geometry and ONE draw call.
     · THERE ARE LEGS (arms 100 → limbs 80, and there are twice as many of them).
       The arm capsule was 50 triangles of rounded end nobody could resolve; a
       five-sided tapered tube is 20, so the same budget buys four limbs instead
       of two. A walk cycle without legs is a cone sliding along the ground, which
       is exactly what v5 looked like at street level. THE LIMB MESH IS THE SAME
       DRAW CALL: `IM.arm` simply holds four instances per villager instead of
       two, and the per-instance colour is what makes slots 0-1 arms (sleeve or
       bare skin) and slots 2-3 legs (hose).
     · THE HEAD AND THE BODY GET THEIR OWN LOCAL MATRICES (0 triangles). The head
       can now turn, tilt and vary in size independently of the shoulders, which
       is what lets a villager glance at you as they step round you, and the body
       can be stout or slight. Costs two matrix multiplies per NEAR villager —
       160 of them — and no geometry at all.
     · SHADING IS BAKED INTO THE VERTICES (0 triangles). `shade()` writes a grey
       multiplier per vertex that the instance colour is modulated by, so every
       robe gets a dirty hem, a belt at the waist and light on the shoulders, and
       every hat gets a dark underside to its brim, without a texture, a second
       material or a single extra triangle.

     The far wardrobe stays at 40 and is re-proportioned to match, so crossing
     between the two is still invisible. */
  /** Bake a per-vertex grey multiplier. Combines with `instanceColor` in three's
   *  own colour chunk (`vColor *= color; vColor.xyz *= instanceColor.xyz`), so a
   *  value of 1 is the robe as picked and .7 is the same robe in shadow. */
  function shade(g, fn) {
    const p = g.attributes.position, n = p.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const k = fn(p.getY(i), p.getX(i), p.getZ(i));
      a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  }
  const ramp = (v, a, b, ka, kb) => v <= a ? ka : v >= b ? kb : ka + (kb - ka) * (v - a) / (b - a);
  /** A smock seen from two metres: mud at the hem, a belt at the waist, daylight
   *  on the shoulders. Purely a function of height, so it survives any yaw. */
  const bodyShade = y => y < .175 ? ramp(y, .140, .175, .70, .80)
    : y < .275 ? ramp(y, .175, .275, .80, .93)
      : y < .305 ? .56                                   // the belt
        : ramp(y, .305, .420, .97, 1.05);
  /** Under the chin is in shadow and the crown is not; it is what separates a
   *  head from the shoulders it sits on when both are the same value. */
  const headShade = y => ramp(y, -.098, .098, .78, 1.05);
  /** The underside of a brim is the darkest thing a villager wears. */
  const hatShade = y => ramp(y, 0, .075, .55, 1.02);
  /** A limb is one flat colour and the body beside it is a gradient, which is
   *  what made the first arms read as planks bolted to a smock. The shoulder end
   *  goes into shadow and the rest comes up to full, so the arm belongs to the
   *  person wearing it. Geometry runs 0 (pivot) → -.20 (hand or sole). */
  const limbShade = y => ramp(y, -.075, 0, 1, .70);
  const BODY_PROFILE = [
    [0, .140], [.158, .150], [.150, .238], [.114, .300], [.142, .362], [.104, .404], [0, .424]
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const G = {
    // 8 segments × 6 rings × 2 = 96
    body: shade(new THREE.LatheGeometry(BODY_PROFILE, 8), bodyShade),
    // centred on its own origin: the head carries a local matrix now
    head: shade(new THREE.SphereGeometry(.098, 8, 6), headShade),
    hat: shade(new THREE.ConeGeometry(.155, .18, 7).translate(0, .09, 0), hatShade),  // base at origin
    // ONE limb, worn four times. Pivot at the top = a shoulder or a hip; the flat
    // foot is a sole on the ground and the flat hand is a fist, and at 4 cm across
    // neither is a shape anyone can resolve at the range this set is drawn for.
    arm: shade(new THREE.CylinderGeometry(.048, .034, .20, 5, 1).translate(0, -.10, 0), limbShade),
    disc: new THREE.CircleGeometry(.20, 10).rotateX(-Math.PI / 2),
    // the far wardrobe: the same silhouette at a fifth of the cost. It shares the
    // near set's local origin and overall proportions exactly, so a villager
    // crossing between wardrobes does not move or change height.
    bodyF: shade(new THREE.CylinderGeometry(.104, .152, .424, 5, 1).translate(0, .212, 0), bodyShade),
    headF: shade(new THREE.SphereGeometry(.098, 5, 3).translate(0, .49, 0), y => headShade(y - .49)),
    lamp: new THREE.SphereGeometry(.075, 8, 6),
    // the Crier's bell: mouth down, so one T·R·S puts it in a raised hand
    bell: new THREE.ConeGeometry(.075, .13, 7).rotateX(Math.PI).translate(0, -.065, 0)
  };
  const M = {
    body: new THREE.MeshStandardMaterial({ roughness: .95, vertexColors: true }),
    head: new THREE.MeshStandardMaterial({ roughness: .9, vertexColors: true }),
    hat: new THREE.MeshStandardMaterial({ roughness: .95, vertexColors: true }),
    arm: new THREE.MeshStandardMaterial({ roughness: .95, vertexColors: true }),
    disc: new THREE.MeshBasicMaterial({ color: 0x0a0c07, transparent: true, opacity: .26, depthWrite: false }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xFFC46B }),
    bell: new THREE.MeshStandardMaterial({ color: 0xC9A227, roughness: .38, metalness: .7 })
  };
  // NPCs cast no real shadow: at 0.6 units they are sub-texel in a shadow map
  // that must cover a 300-unit town, so it produces shimmer, not shadow. The
  // fake contact disc reads better and costs one draw call.
  function mk(g, m, n, tinted) {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;   // instance spread ≫ geometry bounds: three's auto
    im.castShadow = false;      // bounding sphere would cull the whole crowd
    im.receiveShadow = false;
    if (tinted) {               // allocate instanceColor at full capacity NOW,
      const c = new THREE.Color(0xffffff);   // while count is still the capacity
      for (let i = 0; i < n; i++) im.setColorAt(i, c);
      im.instanceColor.needsUpdate = true;
    }
    im.count = 0;
    scene.add(im);
    return im;
  }
  const IM = {
    body: mk(G.body, M.body, NEAR, 1), head: mk(G.head, M.head, NEAR, 1),
    // FIVE limb instances per villager — two arms, two legs and a carried load —
    // in ONE mesh, one material, one draw call. `LIMBS` is the only place that
    // number is written.
    hat: mk(G.hat, M.hat, NEAR, 1), arm: mk(G.arm, M.arm, NEAR * LIMBS, 1),
    disc: mk(G.disc, M.disc, NEAR),
    bodyF: mk(G.bodyF, M.body, MAX, 1), headF: mk(G.headF, M.head, MAX, 1),
    lamp: mk(G.lamp, M.lamp, 26), bell: mk(G.bell, M.bell, 1)
  };
  IM.disc.renderOrder = 1;                    // after the transparent road overlay
  IM.bell.visible = false;                    // a 7th draw call only while the Crier rings
  /** The near wardrobe, as a list — everything that iterates "the detailed parts". */
  const NEARMESH = [IM.body, IM.head, IM.hat, IM.disc];
  // at most two real lights for the whole night shift
  const lampLights = [0, 1].map(() => {
    const p = new THREE.PointLight(0xFFC46B, 0, 11, 2); scene.add(p); return p;
  });

  const npcs = [];                            // dense array, swap-removed
  const slotUsed = new Array(42).fill(false);
  let desired = 0, spikeUntil = 0, pulseAt = -1e9, dead = false, lastNow = 0;
  // celebrate()/pulse()/pickSpeaker() arrive between frames: schedule them on the
  // same clock update() is fed, not our own, or every deadline in here drifts
  const clock = () => lastNow || performance.now();

  /* ═══ THE TWO WARDROBES ════════════════════════════════════════
     `npcs` is the crowd and its order means nothing. What the GPU sees is two
     dense instance lists: `nearL` (hats, arms, contact discs) and `farL` (a body
     and a head). A villager is in exactly one, and `n.at` / `n.atF` is their
     index in it — the handle every colour upload and every hover test resolves
     through. Leaving a list is a swap-remove that CARRIES THE SURVIVOR'S
     MATRICES down with it, because with the simulation time-sliced the survivor
     may not be posed again for a quarter of a second and a stale matrix at their
     new index would show as a villager standing in someone else's shoes. */
  const nearL = [], farL = [];
  let nearR = NEAR_R_MAX, nearRAt = -1e9;
  const dHist = new Int32Array(DBUCKETS + 1);
  const wcM = new THREE.Matrix4();            // the swap-remove carry, alone

  /** Re-derive the radius that fits exactly NEAR instances. ~4 Hz, wall clock,
   *  one pass and one preallocated histogram: no sort, no allocation. */
  function recomputeNearR() {
    dHist.fill(0);
    for (let i = 0; i < npcs.length; i++) {
      let b = (Math.sqrt(npcs[i].d2) / DSTEP) | 0;
      if (b > DBUCKETS) b = DBUCKETS;
      dHist[b]++;
    }
    let c = 0, r = NEAR_R_MAX;
    // one slot of slack, so the band the cut falls in cannot overfill the list
    for (let b = 0; b <= DBUCKETS; b++) {
      c += dHist[b];
      if (c >= NEAR - 1) { r = Math.min(NEAR_R_MAX, (b + 1) * DSTEP); break; }
    }
    nearR = r;
  }
  function joinNear(n) {
    if (nearL.length >= NEAR) return false;
    n.at = nearL.length; nearL.push(n); paintNear(n); return true;
  }
  function leaveNear(n) {
    const i = n.at; if (i < 0) return;
    n.at = -1;
    const last = nearL.pop();
    if (last !== n) {
      nearL[i] = last;
      const j = nearL.length;
      for (const im of NEARMESH) { im.getMatrixAt(j, wcM); im.setMatrixAt(i, wcM); }
      for (let a = 0; a < LIMBS; a++) { IM.arm.getMatrixAt(j * LIMBS + a, wcM); IM.arm.setMatrixAt(i * LIMBS + a, wcM); }
      last.at = i; paintNear(last);
    }
  }
  function joinFar(n) {
    if (farL.length >= MAX) return false;
    n.atF = farL.length; farL.push(n); paintFar(n); return true;
  }
  function leaveFar(n) {
    const i = n.atF; if (i < 0) return;
    n.atF = -1;
    const last = farL.pop();
    if (last !== n) {
      farL[i] = last;
      const j = farL.length;
      IM.bodyF.getMatrixAt(j, wcM); IM.bodyF.setMatrixAt(i, wcM);
      IM.headF.getMatrixAt(j, wcM); IM.headF.setMatrixAt(i, wcM);
      last.atF = i; paintFar(last);
    }
  }
  /** Put a villager in a wardrobe, or move them between the two. Returns true if
   *  anything changed, which is the caller's cue that this frame MUST pose them:
   *  their new slot is still wearing the last tenant's matrix. */
  function wardrobe(n, wantNear) {
    if (wantNear && nearL.length >= NEAR && n.at < 0) wantNear = false;
    if (wantNear) {
      if (n.at >= 0) return false;
      leaveFar(n);
      if (joinNear(n)) return true;
      wantNear = false;                        // lost the race for the last slot
    }
    if (n.atF >= 0) return false;
    leaveNear(n);
    return joinFar(n);
  }
  const unWardrobe = n => { leaveNear(n); leaveFar(n); };

  /* ═══ THE ROSTER ═══════════════════════════════════════════════
     `folk[i]` is a person and `i` is their handle, for the life of the epoch. A
     villager on the street holds exactly one seat (`n.seed === i`, `p.live === n`),
     so identity survives walking home at dusk and coming back at dawn. Minting is
     ~1400 × a dozen hashes, once per epoch — never per frame.

     v5: the person OBJECTS are pooled. 1400 seats each carrying a walking record
     is real memory, and re-minting it 20 times (which is what the leak bench
     does) would hand the heap 20 copies of it to collect. `folkPool` keeps the
     shells; a mint refills them in place and the fields below are the complete
     list of what a mint must set — anything left stale is a bug that would show
     as one epoch's villager wearing the previous epoch's trade. */
  const folk = [], folkPool = [];
  let rosterSeed = -1, heroId = -1, homeCursor = 0, unhomed = 0;
  const HH = new Map();          // building key → {n, cap, x, z, yaw}  households
  /** A building's identity across a growing array. `idx` is F1's stable ordinal
   *  (landmarks negative); before F1 lands, the array position is stable enough —
   *  houses only ever append within an epoch. */
  const keyOf = (b, i) => b && b.idx != null ? 'i' + b.idx : 'p' + i;
  const bldgs = () => (cfg.getBuildings && cfg.getBuildings()) || null;

  function quarterOf(x, z) {
    const r = Math.hypot(x - MON.x, z - MON.z);
    if (r < plazaR() + 7) return PLAZA_Q;
    if (plan && plan.isWet && (plan.isWet(x + 5, z) || plan.isWet(x - 5, z)
      || plan.isWet(x, z + 5) || plan.isWet(x, z - 5))) return WATER_Q;
    const a = Math.atan2(z - MON.z, x - MON.x) + Math.PI;
    return QUARTER[Math.floor(a / (Math.PI / 4)) % 8];
  }

  const taken = new Set();
  function mintRoster() {
    const s = hash2((plan && plan.seed) || 0, cfg.seed | 0);
    if (folk.length === MAX && rosterSeed === s) return;
    rosterSeed = s;
    while (folk.length) folkPool.push(folk.pop());
    HH.clear(); homeCursor = 0; unhomed = MAX;
    const R = stream(s);
    taken.clear();
    for (let i = 0; i < MAX; i++) {
      // de-duplicate on the PAIR, re-drawing both halves: 1400 distinct people
      // out of 96 × 98, and the retry is bounded so a starved pool still returns
      let first = one(GIVEN, R), sur = one(SUR, R), guard = 0;
      while (taken.has(first + ' ' + sur) && guard++ < 48) {
        sur = one(SUR, R); if (guard > 16) first = one(GIVEN, R);
      }
      taken.add(first + ' ' + sur);
      const t = TRADES[Math.floor(R() * TRADES.length) % TRADES.length];
      const ps = i * 7.7 + 3 + ((s % 977) * .618);   // this person's noise stream
      const p = folkPool.length ? folkPool.pop() : {};
      p.id = i; p.first = first; p.sur = sur; p.title = ''; p.job = t.job; p.premises = t.place;
      p.name = ''; p.homeKind = one(HOME_KIND, R); p.homeName = ''; p.homeN = 0; p.quarter = '';
      p.homeX = 0; p.homeZ = 0; p.homeYaw = 0; p.homed = false;
      p.workX = 0; p.workZ = 0; p.workFx = 0; p.workFz = 0;
      p.place = t.place; p.workLabel = ''; p.jobbed = false;
      p.friend = i ^ 1; p.rival = MAX - 1 - i; p.rel = one(RELS, R);
      p.band = 2; p.fortune = FORTUNE[2];
      p.rs = ps; p.robe = pick(ROBE, ps * 11); p.skin = pick(SKIN, ps * 13);
      /* ── the wardrobe, and the body under it ────────────────────
         Everything here is drawn once, at mint, from this person's own noise
         stream, and every one of it is free: a scale in a local matrix or a
         colour in an instance buffer. It is the whole answer to "do a hundred
         of them look like a hundred people": headwear silhouette, hair or hat,
         sleeved or bare arms, the colour of the hose, how stout the body is,
         how big the head is, how long the stride, how far the arms swing, and a
         permanent half-degree of lean and shoulder tilt that is theirs alone. */
      p.hw = HW_ROLL[Math.floor(srand(ps * 17) * HW_ROLL.length) % HW_ROLL.length];
      p.hatc = HEADWEAR[p.hw].hair ? pick(HAIRC, ps * 19) : pick(HATC, ps * 19);
      p.legc = pick(LEGC, ps * 43);
      p.sleeve = srand(ps * 47) < .55;
      p.bw = .90 + srand(ps * 53) * .22;         // body width — stout or slight
      p.bh = .95 + srand(ps * 59) * .11;         // …and torso height
      p.hs = .92 + srand(ps * 61) * .15;         // head size
      p.stride = .82 + srand(ps * 67) * .40;     // how far the legs travel
      p.swing = .70 + srand(ps * 71) * .62;      // …and how much the arms answer
      p.tilt = (srand(ps * 73) - .5) * .075;     // a shoulder that always sits low
      p.lean = (srand(ps * 79) - .5) * .07;      // …and a back that never straightens
      p.rite = Math.floor(srand(ps * 23) * 3);
      p.load = LOAD_ROLL[Math.floor(srand(ps * 83) * LOAD_ROLL.length) % LOAD_ROLL.length];
      p.scale = (.88 + srand(ps * 3) * .26) * 1.62;
      /* THE WALK, in metres per second, because that is the only unit it has a
         right answer in. .56–.84 u/s is 1.00–1.50 m/s: an amble at one end, an
         errand at the other, the camera's own 1.28 m/s in the middle. One in six
         is additionally late for something, which tops out at 1.80 m/s and is
         still a walk. The .95–1.45 this replaces was 1.7–2.6 m/s — the whole
         town jogging, which is the defect this pass exists to fix. */
      p.speed = WALK_MIN + srand(ps * 5) * WALK_VAR
        + (srand(ps * 89) < HURRY_P ? WALK_HURRY : 0);
      /* …and the step that speed is spent in. NOT a tuned constant: it is twice
         the hip→sole reach times the sine of this person's own leg swing, i.e.
         the distance their foot actually travels, in the FIGURE's local units.
         `advance` divides speed by it (scaled up to the world) to get cadence,
         which is why a long-legged villager takes fewer, longer steps than a
         short one at the same pace and neither of them skates. */
      p.stepU = 2 * HIP_Y * p.bh * Math.sin(LEG_SWING * p.stride);
      // Signed by TRAVEL DIRECTION further down, so two-way traffic passes on
      // opposite sides of the lane; the spread is what stops a thousand people
      // walking single file down the middle of it.
      p.lat = .18 + srand(ps * 7) * .70;
      p.live = null; p.hero = false; p.crier = false;
      if (p.rec) p.rec.seed = i;
      // A title is a trade, not a sprinkle: only the town's four offices carry one,
      // and "Old" goes to the handful who have simply been here longest.
      p.title = t.title || (R() < .06 ? 'Old' : '');
      folk.push(p);
    }
    // folk[0] IS the Crier — pinned by charter, so news.js never has to be told who.
    const c = folk[0];
    c.crier = true; c.job = 'crier'; c.premises = 'bell tower'; c.place = 'bell tower';
    c.title = 'the Town Crier';
    c.load = 0;                  // that hand has a bell in it
    heroId = 1 + Math.floor(stream(s ^ 0x51ED27)() * (MAX - 1));
    folk[heroId].hero = true;
    for (const p of folk) p.name = displayName(p);
  }
  const displayName = p =>
    p.title === 'Old' ? 'Old ' + p.first
      : p.title === 'the Town Crier' ? p.first + ' ' + p.sur
        : p.title ? p.title + ' ' + p.sur : p.first + ' ' + p.sur;

  /** Give `p` a doorstep on a real building. Households hold 1–3 kin, so nobody
   *  shares a doorstep with a stranger until the town runs out of houses. */
  function assignHome(p, force) {
    if (p.homed) return true;
    const bs = bldgs();
    if (!bs || !bs.length) return false;
    let slot = -1;
    for (let pass = 0; pass < 2 && slot < 0; pass++) {
      for (let k = 0; k < bs.length; k++) {
        const i = (homeCursor + k) % bs.length, b = bs[i];
        if (!b || !b.pos) continue;
        if (b.kind === 'landmark' || (b.idx != null && b.idx < 0)) continue;   // civic, not lodgings
        const key = keyOf(b, i);
        let h = HH.get(key);
        if (!h) {
          h = { n: 0, cap: 1 + Math.floor(srand(i * 1.7 + 5.5) * 3), x: b.pos.x, z: b.pos.z, yaw: b.yaw || 0 };
          HH.set(key, h);
        }
        // pass 2 only runs for a villager already walking the streets: they need a
        // door tonight more than the town needs a tidy census.
        if (h.n >= h.cap + (pass && force ? 1 : 0)) continue;
        h.n++; slot = i; homeCursor = i;
        p.homeX = h.x + Math.sin(h.yaw) * 2.4; p.homeZ = h.z + Math.cos(h.yaw) * 2.4;
        p.homeYaw = h.yaw;
        p.homeName = b.label || (HOUSE_A[i % HOUSE_A.length] + ' ' + HOUSE_B[(i * 7 + p.id) % HOUSE_B.length]);
        p.homeN = b.n > 0 ? b.n : 0;          // the building ordinal, for a real address
        p.quarter = quarterOf(h.x, h.z);
        p.homed = true; if (unhomed > 0) unhomed--;
        break;
      }
      if (!force) break;
    }
    if (p.homed) assignWork(p);
    return p.homed;
  }
  /** A workplace is any OTHER building; a labelled one (a landmark, once F1 widens
   *  getBuildings) wins, because then the premises has a name the user can read. */
  function assignWork(p) {
    const bs = bldgs();
    if (!bs || !bs.length) return false;
    // 24 candidates from a seeded start: the first labelled one wins (a named
    // premises is a fact the user can read on the card), else the first that is
    // not their own front door.
    let best = -1;
    const start = Math.floor(srand(p.rs * 2.3) * bs.length) % bs.length;
    for (let k = 0; k < Math.min(24, bs.length); k++) {
      const i = (start + k) % bs.length, b = bs[i];
      if (!b || !b.pos) continue;
      if (Math.hypot(b.pos.x - p.homeX, b.pos.z - p.homeZ) < 3) continue;   // not their own door
      if (b.label) { best = i; break; }
      if (best < 0) best = i;
    }
    if (best < 0) return false;
    const b = bs[best];
    p.workFx = b.pos.x; p.workFz = b.pos.z;
    p.workX = b.pos.x + Math.sin(b.yaw || 0) * 2.6; p.workZ = b.pos.z + Math.cos(b.yaw || 0) * 2.6;
    p.workLabel = b.label || '';
    p.jobbed = true;
    // An arrival is a true fact the moment it happens: a named resident, a trade,
    // a premises. news.js decides whether the town hears about it.
    if (folk.length && evM.length < 4 && p.id !== 0 && HH.size > 10)
      evM.push({ kind: 'arrival', who: p.name, job: p.job, place: p.place, home: p.homeKind, quarter: p.quarter });
    return true;
  }
  /** Amortised census. Bounded per frame, converges, then costs one comparison. */
  let homeScan = 0;
  function topUpHomes() {
    // `unhomed` is what makes this free once it has converged: without it, a
    // settled 1400-seat roster still walked its whole length every frame to
    // discover there was nothing to do.
    if (!folk.length || unhomed <= 0) return;
    let budget = 10;
    for (let i = 0; i < folk.length && budget > 0; i++) {
      const p = folk[homeScan++ % folk.length];
      if (p.homed) continue;
      budget--;
      if (!assignHome(p, false)) break;        // no free slot: the town is too small yet
    }
  }

  const view = p => p ? {
    id: p.id, name: p.name, first: p.first, sur: p.sur, title: p.title,
    job: p.job, trade: tradeLine(p), place: p.place,
    home: p.homeName || '', homeN: p.homeN || 0, quarter: p.quarter || '',
    fortune: p.fortune, band: p.band, rel: p.rel, friend: p.friend, rival: p.rival,
    hero: !!p.hero, crier: !!p.crier,
    alive: !!p.live, state: p.live ? p.live.state : '',
    x: p.live ? p.live.x : 0, y: 0, z: p.live ? p.live.z : 0
  } : null;
  const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const tradeLine = p => p.crier ? 'Town Crier of the plaza'
    : cap1(p.job) + (p.jobbed ? ' at ' + (p.workLabel || 'the ' + p.premises) : '');
  /** handle → Person. The handle IS the roster index, so this is a bounds check. */
  const pAt = id => {
    const i = typeof id === 'number' ? id : NaN;
    return Number.isInteger(i) && i >= 0 && i < folk.length ? folk[i] : null;
  };

  /* ── the road graph ─────────────────────────────────────────────
     A leg is either {t:'walk', x, z} — a short free walk to a doorstep, a
     worship seat or back onto the network — or {t:'edge'}, one straight
     SEG-long street segment carrying its own geometry so advance() is pure
     arithmetic. Curvature lives in the CHAIN of edges, never inside one.
     `n.tail*` is where the QUEUE ends (not where the villager stands), which is
     what lets a stroll append another block while still walking the last one. */
  const RP = { x: 0, z: 0 };
  function roadPoint() {
    const maxK = Math.max(frontierK() + 4, 14);
    if (graph && plan.randomRoadPoint) {
      /* THREE TRIES, AND THE ONLY THING THEY REJECT IS A BRIDGE DECK. The point
         is drawn in proportion to EDGE LENGTH, and a crossing's edge is the
         longest thing in the plan — 54 units against a 13-unit street — so a
         road point lands on one far more often than a village has bridges. That
         is where a villager is spawned and where an errand ends, and neither
         should be the middle of a river: a spawn there walks off the side of the
         deck to reach the bank, and an errand there is somebody standing in the
         middle of a bridge for a minute for no reason. They still CROSS it, on
         the edge, which is the way a bridge is used. */
      let got = false;
      for (let a = 0; a < 3; a++) {
        const p = plan.randomRoadPoint(rnd(), maxK);
        if (!p || !isFinite(p.x) || !isFinite(p.z)) break;
        RP.x = p.x; RP.z = p.z; got = true;
        if (!deckList.length || deckAt(p.x, p.z) <= 0) return RP;
      }
      if (got) return RP;                       // three decks in a row: take the last
    }
    // no plan yet (or a starved frontier): a ring just outside the plaza
    const a = rnd() * TAU, r = plazaR() + 3 + rnd() * 9;
    RP.x = MON.x + Math.cos(a) * r; RP.z = MON.z + Math.sin(a) * r;
    return RP;
  }
  const nearNode = (x, z) => graph ? plan.nearestNode(x, z) : -1;
  const edgeKey = (e, from, to) => e.i != null ? e.i : from * 131 + to;

  /* ── the leg pool ───────────────────────────────────────────────
     A thousand villagers re-plan a ten-leg route every twenty seconds or so;
     that is ~600 short-lived objects a second, which is the module's whole
     remaining allocation. A leg is owned by exactly one place at a time —
     `n.legs` or `n.leg` — and `clearLegs()` is the ONLY way to drop a queue, so
     the ownership rule has one enforcement point. */
  const legPool = [];
  const takeLeg = () => legPool.length ? legPool.pop()
    : {
      t: '', e: null, from: -1, to: -1, s: 0, len: 0, lat: 0, ax: 0, az: 0, ux: 0, uz: 1, pause: -1, x: 0, z: 0,
      // the deck this leg climbs, resolved when it begins: where the crossing's
      // centre falls along it, how much of it is level, and the ramp at each end.
      dc: 0, dh: 0, dr: -1
    };
  const freeLeg = L => { if (L && legPool.length < 8192) { L.e = null; legPool.push(L); } };
  function clearLegs(n) {
    if (n.leg) { freeLeg(n.leg); n.leg = null; }
    for (let i = 0; i < n.legs.length; i++) freeLeg(n.legs[i]);
    n.legs.length = 0;
  }
  function pushWalk(n, x, z) {
    const L = takeLeg();
    L.t = 'walk'; L.x = x; L.z = z; L.e = null; L.pause = -1; L.dr = -1;
    n.legs.push(L);
  }
  function pushEdge(n, e, from, to) {
    const L = takeLeg();
    L.t = 'edge'; L.e = e; L.from = from; L.to = to;
    L.s = 0; L.len = 0; L.lat = 0; L.ax = 0; L.az = 0; L.ux = 0; L.uz = 1; L.pause = -1; L.dr = -1;
    n.legs.push(L);
    n.tailPrev = from; n.tailNode = to;
  }
  /** Walk to the nearest graph node and make it the queue's tail — the one way
   *  back onto the network from a doorstep, a plaza seat or a loiter. */
  function resync(n) {
    const a = nearNode(n.x, n.z);
    if (a < 0) { n.tailNode = -1; n.tailPrev = -1; return false; }
    const nd = graph.nodes[a];
    pushWalk(n, nd.x, nd.z);
    n.tailNode = a; n.tailPrev = -1;
    return true;
  }
  /** Append the A* route a→b. Returns false if the graph can't connect them. */
  function appendPath(n, a, b) {
    if (a === b) { n.tailNode = b; return true; }
    const p = plan.pathTo ? plan.pathTo(a, b) : null;
    if (!p || !p.length) return false;
    if (!pathMode) {
      // pathTo's element type is not pinned by the spec (nodes on a <=500-node A*,
      // or the edges between them). Sniff it once, and if the walk falls apart
      // mid-route, flip and retry — misreading it would strand the whole town.
      const e0 = graph.edges[p[0]];
      pathMode = p[0] === a ? 1 : (e0 && (e0.a === a || e0.b === a)) ? 2 : 1;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const mark = n.legs.length;
      if (layPath(n, a, b, p)) return true;
      for (let i = mark; i < n.legs.length; i++) freeLeg(n.legs[i]);
      n.legs.length = mark;                   // undo the half-built route
      pathMode = pathMode === 1 ? 2 : 1;
    }
    return false;
  }
  function layPath(n, a, b, p) {
    let cur = a;
    for (let i = 0; i < p.length; i++) {
      let nx, e;
      if (pathMode === 1) {
        nx = p[i]; if (nx === cur) continue;
        e = plan.edgeBetween(cur, nx);
      } else {
        e = graph.edges[p[i]];
        if (!e) return false;
        nx = e.a === cur ? e.b : e.b === cur ? e.a : -1;
        if (nx < 0) return false;
      }
      if (!e) return false;
      pushEdge(n, e, cur, nx);
      cur = nx;
    }
    return cur === b;
  }
  /** Route to a world point: onto the network, along it, then the last few steps
   *  off it. `tail === false` stops at the road. */
  function routeTo(n, x, z, tail) {
    clearLegs(n);
    if (!graph) { pushWalk(n, x, z); n.tailNode = -1; return; }
    const a = nearNode(n.x, n.z), b = nearNode(x, z);
    if (a >= 0) { const nd = graph.nodes[a]; pushWalk(n, nd.x, nd.z); }
    n.tailNode = a; n.tailPrev = -1;
    if (a < 0 || b < 0 || !appendPath(n, a, b)) { clearLegs(n); pushWalk(n, x, z); n.tailNode = -1; return; }
    if (tail !== false) pushWalk(n, x, z);
  }
  /** One more block, chosen at the queue's tail. Strolling IS wandering the
   *  graph: no A*, always on painted road, and never past the paved frontier. */
  function wanderStep(n) {
    if (!graph || n.tailNode < 0 || !plan.randomNextNode) return false;
    const maxK = Math.max(frontierK() + 6, 14);
    for (let a = 0; a < 4; a++) {
      const nx = plan.randomNextNode(n.tailPrev, n.tailNode, rnd());
      if (nx == null || nx < 0 || nx === n.tailNode) continue;
      const e = plan.edgeBetween(n.tailNode, nx);
      if (!e || (e.d != null && e.d > maxK)) continue;
      pushEdge(n, e, n.tailNode, nx);
      return true;
    }
    return false;
  }
  function randomBuilding(seed) {
    const bs = bldgs();
    return bs && bs.length ? bs[Math.floor(srand(seed) * bs.length) % bs.length] : null;
  }

  /* ── behaviour ────────────────────────────────────────────────── */
  /** The Crier mid-announcement cannot be reassigned by anything — not a
   *  milestone, not dusk, not the pilgrimage. A PINNED villager (the camera is on
   *  them) still lives their life; they are only spared the cull, in `held`. */
  const locked = n => n.seed === 0 && crierState > 0;
  const held = n => locked(n) || n.seed === pinned;
  function newErrand(n, now) {
    if (locked(n)) return;
    freeSlot(n);            // the one exit every state funnels through: never leak a slot
    clearLegs(n);
    n.idleUntil = 0;
    // Working hours are a DESTINATION POLICY, not new navigation: about half the
    // town, half the time, walks to its own premises and stands there a while.
    const p = folk[n.seed];
    if (p && p.jobbed && hourNow >= 8.5 && hourNow < 17.5 && srand(n.rs + (now / 6e4 | 0)) < .5) {
      n.state = 'toWork';
      n.until = now + 22000 + srand(n.rs * 1.3 + (now | 0)) * 34000;
      routeTo(n, p.workX, p.workZ);
      return;
    }
    n.state = 'stroll';
    if (!resync(n)) { const q = roadPoint(); pushWalk(n, q.x, q.z); }
    n.until = now + 14000 + srand(n.rs + (now | 0)) * 22000;
  }
  const worshipSpot = (i, seed) => {
    let k = i;
    const PL = plazaR();
    for (const [off, cnt, span, base] of WRINGS) {
      if (k < cnt) {
        const R = clamp(monR() + off + (srand(seed * 3) - .5) * .5, monR() + .5, Math.max(monR() + .6, Math.min(monOuter(), PL - .8)));
        // along the arc, not round the circle; ±.05 rad of scatter so the row
        // is a group of people and not a row of fence posts
        const t = cnt > 1 ? k / (cnt - 1) - .5 : 0;
        return { R, a: base + t * span + (srand(seed) - .5) * .10 };
      }
      k -= cnt;
    }
    return { R: PL - 1.4, a: srand(seed) * TAU };
  };
  function enterWorship(n, now, instant) {
    if (locked(n)) return false;
    // FIRST, always: a villager can reach here still holding a slot (celebrate()
    // converts a `toShrine` pilgrim to `cheer`, and the cheer exit re-enters
    // worship). Without this the seat is leaked, and after enough celebrations
    // all 42 are gone and the altar stands empty for the rest of the run.
    freeSlot(n);
    let s = -1;
    for (let i = 0; i < slotUsed.length; i++) if (!slotUsed[i]) { s = i; break; }
    if (s < 0) { newErrand(n, now); return false; }
    slotUsed[s] = true; n.slot = s;
    const w = worshipSpot(s, n.rs), c = monC();
    n.wx = c.x + Math.cos(w.a) * w.R; n.wz = c.z + Math.sin(w.a) * w.R;
    n.until = now + 24000 + srand(n.rs * 1.7) * 46000;
    // …and a seat is on the plaza, which is on the ground: every one of these
    // three is a TELEPORT, and a lift left behind by one would strand a
    // worshipper or the Crier hanging in the air over the square.
    if (instant) { n.x = n.wx; n.z = n.wz; n.y = 0; n.state = 'worship'; clearLegs(n); n.tailNode = -1; }
    else { n.state = 'toShrine'; routeTo(n, n.wx, n.wz); }
    return true;
  }
  function freeSlot(n) { if (n.slot >= 0) { slotUsed[n.slot] = false; n.slot = -1; } }
  /** v4: home is THEIR home. Dusk is a town going to its own doors, and the deed
   *  card names the building they walk to. */
  function goHome(n, now) {
    if (held(n)) return;
    freeSlot(n); n.state = 'home'; clearLegs(n);
    const p = folk[n.seed];
    if (p && (p.homed || assignHome(p, true))) { routeTo(n, p.homeX, p.homeZ); return; }
    const b = randomBuilding(n.rs + now);
    if (!b) { n.dying = .01; return; }              // nowhere to go: fade where you stand
    const d = 2.4;   // stop on the doorstep, not inside the walls
    routeTo(n, b.pos.x + Math.sin(b.yaw) * d, b.pos.z + Math.cos(b.yaw) * d);
  }
  /** Take the lowest free roster seat — so a hamlet is always the same faces, and
   *  the person you followed yesterday is out on the street again today.
   *  `seatScan` makes the sweep amortised: without it, filling 1100 seats one per
   *  call is 1100 restarts of a 1400-long scan. It only ever moves forward, and
   *  a full lap proves the roster is out. */
  let seatScan = 0;
  function freeSeat() {
    const nf = folk.length;
    if (!nf) return -1;
    for (let k = 0; k < nf; k++) {
      const i = (seatScan + k) % nf;
      if (!folk[i].live) { seatScan = i; return i; }
    }
    return -1;
  }
  /** The walking record. One per roster seat, allocated once and reused for the
   *  life of the shell — spawning is a field reset, never an allocation. */
  function recFor(p) {
    let n = p.rec;
    if (!n) {
      n = p.rec = {
        seed: p.id, rs: 0, x: 0, y: 0, z: 0, yaw: 0, face: 0, ph: 0,   // y: the deck under them, 0 on the ground
        scale: 1, speed: 1, lat: .3, robe: 0, skin: 0, hw: 0, hatc: 0, rite: 0,
        legc: 0, sleeve: 0, bw: 1, bh: 1, hs: 1, stride: 1, swing: 1, tilt: 0, lean: 0,
        load: 0, stepU: .2, v: 0,                    // v7 · what they carry, and how they walk
        hy: 0, hp: 0,                                // where the head is looking
        px: 0, pz: 0,                                // …and the step-aside they are holding
        sepx: 0, sepz: 0, sepF: -1,                  // v8 · the room the NEIGHBOURS want
        lampS: 1,                                    // …and which hand the lantern is in
        state: 'stroll', legs: [], leg: null,
        until: 0, idleUntil: 0, slot: -1, bornAt: 0, dying: 0,
        at: -1, atF: -1, pilgrim: false,
        cheerFrom: 0, wx: 0, wz: 0, lx: 0, ly: 0, lz: 0, d2: 0,
        tailNode: -1, tailPrev: -1,                  // where the leg QUEUE ends
        resume: '', resumeUntil: 0, pauseFrom: 0,    // bridge-watching
        spokeAt: -1e9, sEff: 1, pr2: 0,
        acc: 0, nextAt: 0, lod: 0, lampF: -1         // v5 · the time slice
      };
    }
    return n;
  }
  function spawn(now, seat) {
    if (npcs.length >= MAX || !folk.length) return null;
    const id = seat != null && seat >= 0 && folk[seat] && !folk[seat].live ? seat : freeSeat();
    if (id < 0) return null;
    const p = folk[id];
    const q = roadPoint();
    const n = recFor(p);
    clearLegs(n);
    // …and they stand ON whatever is under them. roadPoint keeps spawns off the
    // decks, but a plan with nothing else left to offer can still return one,
    // and appearing under your own bridge is not a way to arrive.
    n.seed = id; n.rs = p.rs; n.x = q.x; n.z = q.z; n.y = deckAt(q.x, q.z);
    n.yaw = srand(p.rs) * TAU; n.face = n.yaw; n.ph = srand(p.rs * 2) * TAU;
    // ×1.62: at 0.6 units a villager was 1/6 the height of a Cottage — wrong
    // against real proportions and sub-pixel once the camera pulls back to
    // frame a 400-house town. A cottage's front door is 1.05–1.4 units, so a
    // villager standing 0.96 tall is 85 % of a doorway, which is what a person
    // is. Only the pose scale changes; routing is untouched.
    n.scale = p.scale; n.speed = p.speed; n.lat = p.lat;
    n.robe = p.robe; n.skin = p.skin; n.hw = p.hw; n.hatc = p.hatc; n.rite = p.rite;
    n.legc = p.legc; n.sleeve = p.sleeve; n.bw = p.bw; n.bh = p.bh; n.hs = p.hs;
    n.stride = p.stride; n.swing = p.swing; n.tilt = p.tilt; n.lean = p.lean;
    // …and they arrive standing still, with whatever they are carrying
    n.load = p.load; n.stepU = p.stepU > 1e-3 ? p.stepU : .2; n.v = 0;
    n.hy = 0; n.hp = 0; n.px = 0; n.pz = 0;
    n.sepx = 0; n.sepz = 0; n.sepF = -1; n.lampS = 1;
    n.state = 'stroll';
    n.until = 0; n.idleUntil = 0; n.slot = -1; n.bornAt = now; n.dying = 0;
    n.lampF = -1; n.pilgrim = false;
    n.cheerFrom = 0; n.wx = 0; n.wz = 0; n.lx = 0; n.ly = 0; n.lz = 0;
    n.d2 = (q.x - camX) * (q.x - camX) + (q.z - camZ) * (q.z - camZ);
    n.tailNode = -1; n.tailPrev = -1;
    n.resume = ''; n.resumeUntil = 0; n.pauseFrom = 0;
    n.spokeAt = -1e9; n.sEff = p.scale;
    // Stagger the first slice by the person's own noise, or a batch of 400
    // arrivals would come due on the same frame for the rest of the epoch.
    n.acc = 0; n.lod = 0; n.nextAt = now + srand(p.rs * 41) * 120;
    npcs.push(n); p.live = n;
    n.at = -1; n.atF = -1;
    wardrobe(n, !tierFar && n.d2 < nearR * nearR);
    if (!p.homed) assignHome(p, false);
    // a fifth of the town starts already at the altar, so t=0 shows the rite
    if (id !== 0 && srand(p.rs * 31) < .22 && enterWorship(n, now, true)) return n;
    newErrand(n, now);
    return n;
  }
  /** Swap-remove from the crowd. The crowd's ORDER carries no meaning any more —
   *  the instance index lives in `n.at`/`n.atF` — so nothing has to be carried
   *  here; `unWardrobe` does the matrix carry inside whichever list they were in. */
  function despawn(i) {
    const n = npcs[i];
    freeSlot(n); clearLegs(n); unWardrobe(n);
    // the amortised seat sweep only ever moves forward, so a vacancy BEHIND it
    // has to pull it back — otherwise "a hamlet is always the same faces" turns
    // into a hamlet cycling through 1400 strangers
    if (n.seed < seatScan) seatScan = n.seed;
    const p = folk[n.seed]; if (p && p.live === n) p.live = null;
    const last = npcs.pop();
    if (i < npcs.length) npcs[i] = last;
  }
  /** The plan was swapped under us (epoch reset). Everyone with a route rejoins
   *  the new streets from wherever they happen to be standing; the congregation
   *  is left kneeling, because the plaza is the origin in every plan. */
  function adoptPlan(p) {
    plan = p; latchGraph();
    const now = clock();
    const reseed = hash2((plan && plan.seed) || 0, cfg.seed | 0) !== rosterSeed;
    if (reseed) {
      // A different township is a different people. Clear the streets first, then
      // mint: the old roster's seats are about to stop existing.
      for (let i = npcs.length - 1; i >= 0; i--) despawn(i);
      crierState = 0; crierText = ''; evH.length = 0; evM.length = 0;
      mintRoster();
      return;
    }
    for (const n of npcs) {
      if (n.dying > 0) continue;                       // let the fade finish where it stands
      if (n.state === 'worship') { clearLegs(n); n.tailNode = -1; continue; }
      if (n.state === 'home') { goHome(n, now); continue; }   // re-target: the houses moved too
      newErrand(n, now);
    }
  }

  /* ── travel ─────────────────────────────────────────────────────
     Two leg kinds, both linear. Legs resolve their geometry when they BEGIN,
     not when they are planned, so a queued route stays valid while the town
     paves itself underneath it. */
  function beginLeg(n, L) {
    if (L.t === 'edge') {
      const A = graph && graph.nodes[L.from], B = graph && graph.nodes[L.to];
      if (!A || !B) return null;
      L.ax = A.x; L.az = A.z;
      let ux = B.x - A.x, uz = B.z - A.z;
      const len = Math.hypot(ux, uz) || 1e-3;
      L.len = len; L.ux = ux / len; L.uz = uz / len; L.s = 0;
      L.lat = Math.min(n.lat, (L.e.w || 4) * .30);
      /* …and if this street is a crossing, where its DECK is along it. The
         profile was solved with the plan; all this leg has to know is where the
         deck's centre falls along IT, which depends on the direction of travel.
         `dr < 0` is "this leg is on the ground" — every other street in town. */
      L.dr = -1;
      const BR = L.e.bridge && L.e.i != null ? deckOf.get(L.e.i) : null;
      if (BR) {
        L.dc = clamp((BR.x - L.ax) * L.ux + (BR.z - L.az) * L.uz, 0, len);
        L.dh = BR.flat; L.dr = BR.ramp;
      }
      // Bridge-watchers: one unhurried crossing in four stops mid-span to look at
      // the water. Pilgrims, sprinters and the Crier have somewhere to be.
      const idle = n.state === 'stroll' || n.state === 'home';
      L.pause = L.e.bridge && idle && srand(n.rs * 3.7 + edgeKey(L.e, L.from, L.to)) < .25
        ? len * (.40 + .20 * srand(n.rs * 1.9 + L.from)) : -1;
    }
    return L;
  }
  /** Stop on the span, turn to the water. The perpendicular that is WET is
   *  downstream — works for a river bank and a lake shore alike. */
  function bridgePause(n, L, now) {
    const nx = -L.uz, nz = L.ux;
    let side = 1;
    if (plan && plan.isWet) {
      const a = plan.isWet(n.x + nx * 3.2, n.z + nz * 3.2);
      const b = plan.isWet(n.x - nx * 3.2, n.z - nz * 3.2);
      if (b && !a) side = -1;
    }
    n.face = faceOf(nx * side, nz * side);
    n.resume = n.state; n.resumeUntil = n.until;
    n.state = 'bridge'; n.pauseFrom = now;
    n.until = now + 2000 + srand(n.rs * 5.3 + (now | 0) * 1e-3) * 2000;
  }
  /** How high off the ground this leg is `s` units in. Level across the deck,
   *  smoothstepped down the embankment at either end, and exactly 0 at both
   *  nodes — so the ramp has no kink where it meets the road and no step where
   *  it meets the deck, and a villager stepped four times a second lands on the
   *  same slope as one stepped sixty. */
  function deckLift(L, s) {
    if (L.dr <= 0) return 0;
    const u = clamp((L.dr - (Math.abs(s - L.dc) - L.dh)) / L.dr, 0, 1);
    return DECK_Y * u * u * (3 - 2 * u);
  }
  function advance(n, dt, now) {
    // pilgrims and the Crier press on; a startled town stops dead for half a second
    const gear = (n.state === 'run' || n.state === 'toCrier') ? GEAR_RUN
      : n.state === 'toShrine' && now < spikeUntil ? GEAR_HURRY : 1;
    const stun = startleK(now);
    /* NOBODY IS INSTANTLY AT SPEED. `n.v` is what this villager is actually
       doing, eased toward what their state asks for at a walker's own
       1.3 m/s² — and braked at 2.5, because stopping is quicker than starting.
       It is a per-villager state, so the banked-dt slice is untouched: a 4 Hz
       villager resolves the same ramp in fewer, larger steps and ends up in the
       same gear. It is also what makes `startle()` a stop rather than a pause
       button, and what stops a celebration's runners leaving at a snap. */
    const want = n.speed * gear * (1 - .85 * stun);
    n.v += clamp(want - n.v, -BRAKE * dt, ACCEL * dt);
    let budget = n.v * dt, moved = 0, guard = 8;
    while (budget > 1e-5 && guard-- > 0) {
      if (!n.leg) {
        const L = n.legs.shift(); if (!L) break;
        n.leg = beginLeg(n, L);
        if (!n.leg) { freeLeg(L); continue; }  // stale edge (plan swap): drop it
      }
      const L = n.leg;
      if (L.t === 'edge') {
        let step = Math.min(L.len - L.s, budget), pausing = false;
        if (L.pause >= 0 && L.s + step >= L.pause) { step = Math.max(0, L.pause - L.s); pausing = true; }
        L.s += step; budget -= step; moved += step;
        // taper the side-offset to 0 at both ends: junctions read as traffic
        // converging, and consecutive legs join without a sideways pop
        const lat = L.lat * clamp(Math.min(L.s, L.len - L.s) / 1.6, 0, 1);
        n.x = L.ax + L.ux * L.s - L.uz * lat;
        n.z = L.az + L.uz * L.s + L.ux * lat;
        n.y = deckLift(L, L.s);            // 0 on every street that is not a crossing
        n.face = faceOf(L.ux, L.uz);
        if (pausing) { L.pause = -1; bridgePause(n, L, now); break; }
        if (L.len - L.s <= 1e-4) { freeLeg(L); n.leg = null; }
      } else {
        const dx = L.x - n.x, dz = L.z - n.z, dist = Math.hypot(dx, dz);
        if (dist < .06) { freeLeg(L); n.leg = null; continue; }
        const d = Math.min(dist, budget);
        n.x += dx / dist * d; n.z += dz / dist * d; budget -= d; moved += d;
        // A free walk has no edge to read the deck off, so it asks the world
        // directly — and if it has just stepped OFF the side of one, it walks
        // down at the ramp's own grade rather than falling. Per unit walked,
        // not per second, so it survives the time slice like everything else.
        if (n.y > 0 || deckList.length) n.y = Math.max(deckAt(n.x, n.z), n.y - d * DECK_GRADE);
        n.face = faceOf(dx, dz);
        if (dist - d < .06) { freeLeg(L); n.leg = null; }
      }
    }
    return moved;
  }

  /* ── the Crier ──────────────────────────────────────────────────
     folk[0] walks to the plaza rim on the camera's side and reads the headline.
     ARRIVAL IS WALL-CLOCK: a headless run paints at ~1 fps, so the walk cannot
     be what decides whether the announcement happens. It has CRY_WALK_MS to get
     there on its own feet; when that expires it is standing on its mark and
     ringing, which is exactly what the screenshot needs to show. */
  let crierState = 0;            // 0 idle · 1 walking · 2 speaking
  let crierText = '', crierFrom = 0, crierUntil = 0, crierEnd = 0;
  let camX = 0, camZ = 62;

  /* ── the neighbours ─────────────────────────────────────────────
     A UNIFORM GRID OVER THE PEOPLE ANYONE CAN SEE, and nobody else. 1400² is
     980 000 pairs a frame and was never on the table; what IS on the table is
     that only the near wardrobe — the ~160 villagers closest to the camera, the
     only ones drawn with a body — can be caught standing inside someone. So the
     set is everyone within `nearR` plus a shell one body deep (the far
     villagers just outside the wardrobe boundary, who would otherwise be the
     single visible seam), bounded by SEP_CAP, and it is GATHERED FOR FREE inside
     the census pass that already walks the whole crowd for `d2`.

     Everything here is preallocated and reused: a counting sort into cells, a
     3×3 neighbourhood per member, one square root per overlapping PAIR rather
     than per candidate, and the facing taken once per villager and only for
     those who turned out to have a neighbour at all. No allocation, no sort.

     POSITIONS ARE ROUTE POSITIONS (`n.x - n.px`), and that is the load-bearing
     detail. The target answers "how far off my path must I stand", so while two
     paths overlap the answer is a STEADY offset and it decays on its own the
     moment they part. Aiming at the displaced positions instead would read its
     own correction as the problem being solved, collapse the pair back together
     and buzz at the easing frequency. */
  const sepL = [];                                  // this pass's members
  const sepX = new Float64Array(SEP_CAP), sepZ = new Float64Array(SEP_CAP);
  const sepRad = new Float64Array(SEP_CAP), sepLook = new Float64Array(SEP_CAP);
  const sepOx = new Float64Array(SEP_CAP), sepOz = new Float64Array(SEP_CAP);
  const sepFx = new Float64Array(SEP_CAP), sepFz = new Float64Array(SEP_CAP);
  const sepFace = new Int32Array(SEP_CAP);          // …stamped, so it is taken once
  const sepCx = new Int32Array(SEP_CAP), sepCz = new Int32Array(SEP_CAP);
  const sepItem = new Int32Array(SEP_CAP);
  const sepCell = new Int32Array(SEP_GN * SEP_GN + 1);
  let sepF = 0, sepAt = -1e9, sepRun = false, sepR2 = 0, sepPairs = 0;
  /** Body radius AS DRAWN: the lathe's widest ring, this person's own girth, and
   *  the pose scale they are being rendered at this frame. */
  const bodyR = n => .158 * n.bw * (n.sEff || n.scale);
  /** One villager's half of one pair: away from the other, plus a tangent that
   *  agrees with the way they were already walking. */
  function pushOff(i, ax, az, m) {
    if (sepFace[i] !== sepF) {
      const f = sepL[i].face;
      sepFx[i] = Math.sin(f); sepFz[i] = Math.cos(f); sepFace[i] = sepF;
    }
    let sx = -az, sz = ax;
    if (sx * sepFx[i] + sz * sepFz[i] < 0) { sx = -sx; sz = -sz; }
    sepOx[i] += ax * m + sx * m * SEP_SIDE;
    sepOz[i] += az * m + sz * m * SEP_SIDE;
  }
  /** Re-aim every member's neighbour push. ~30 Hz on the wall clock; the members
   *  were gathered by the census, and `sepF` has already been advanced, so a
   *  frame that gathers nobody expires the last pass's targets rather than
   *  freezing them. */
  function stepSeparation() {
    const M = sepL.length;
    if (M < 2) { sepL.length = 0; sepPairs = 0; return; }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < M; i++) {
      const n = sepL[i];
      const x = n.x - n.px, z = n.z - n.pz;
      sepX[i] = x; sepZ[i] = z; sepOx[i] = 0; sepOz[i] = 0;
      sepRad[i] = bodyR(n);
      // …and how much room they are asking for on top of it: none stood still,
      // all of it at a walking pace. `n.v` is what they are ACTUALLY doing, so
      // somebody braking asks for less as they slow.
      sepLook[i] = n.v >= WALK_MIN ? SEP_LOOK : (n.v > 0 ? n.v / WALK_MIN * SEP_LOOK : 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    /* Cells are never smaller than the widest pair, so a 3×3 neighbourhood is
       the whole of what can reach you, and never more than SEP_GN across, so
       clearing the grid is a fixed 6 KB memset however far the crowd is spread
       — a dense array indexed by cell beats a hash table at this size, and it
       cannot degrade into a bucket collision. */
    const ext = Math.max(x1 - x0, z1 - z0);
    const cs = Math.max(SEP_CELL, ext / SEP_GN);
    const gn = Math.max(1, Math.min(SEP_GN, Math.floor(ext / cs) + 1)), cells = gn * gn;
    sepCell.fill(0, 0, cells);
    for (let i = 0; i < M; i++) {
      const cx = clamp((sepX[i] - x0) / cs | 0, 0, gn - 1);
      const cz = clamp((sepZ[i] - z0) / cs | 0, 0, gn - 1);
      sepCx[i] = cx; sepCz[i] = cz; sepCell[cz * gn + cx]++;
    }
    // exclusive scan → cell starts; the scatter then leaves sepCell[c] holding
    // the cell's END, which is the next cell's start. One array, no cursor copy.
    for (let c = 0, run = 0; c < cells; c++) { const t = sepCell[c]; sepCell[c] = run; run += t; }
    for (let i = 0; i < M; i++) sepItem[sepCell[sepCz[i] * gn + sepCx[i]]++] = i;

    let pairs = 0;
    for (let i = 0; i < M; i++) {
      const x = sepX[i], z = sepZ[i], ri = sepRad[i], li = sepLook[i];
      const cx = sepCx[i], cz = sepCz[i];
      const gzE = cz + 1 < gn ? cz + 1 : gn - 1, gxE = cx + 1 < gn ? cx + 1 : gn - 1;
      for (let gz = cz > 0 ? cz - 1 : 0; gz <= gzE; gz++) {
        const row = gz * gn;
        for (let gx = cx > 0 ? cx - 1 : 0; gx <= gxE; gx++) {
          const c = row + gx, e = sepCell[c];
          for (let k = c ? sepCell[c - 1] : 0; k < e; k++) {
            const j = sepItem[k];
            if (j <= i) continue;                    // each pair exactly once
            let dx = x - sepX[j], dz = z - sepZ[j];
            let R = ri + sepRad[j]; if (R > SEP_R_MAX) R = SEP_R_MAX;
            R += (li + sepLook[j]) * .5;                 // …plus the room they want
            const d2 = dx * dx + dz * dz;
            if (d2 >= R * R) continue;
            let d = Math.sqrt(d2);
            if (d > 1e-4) { dx /= d; dz /= d; }
            else {
              // standing in each other's shoes. Break the tie on the PAIR and
              // order it by seat: which of the two happens to be `i` is a fact
              // about this frame's grid order, not about them, and letting it
              // decide would swap who goes which way from frame to frame.
              const t = (sepL[i].rs + sepL[j].rs) * 13.1;
              dx = Math.sin(t); dz = Math.cos(t); d = 0;
              if (sepL[i].seed > sepL[j].seed) { dx = -dx; dz = -dz; }
            }
            const m = (R - d) * .5;                  // both of them give way, half each
            pushOff(i, dx, dz, m); pushOff(j, -dx, -dz, m);
            pairs++;
          }
        }
      }
    }
    sepPairs = pairs;
    for (let i = 0; i < M; i++) {
      let ox = sepOx[i], oz = sepOz[i];
      const L2 = ox * ox + oz * oz;
      if (L2 > SEP_MAX * SEP_MAX) { const L = Math.sqrt(L2); ox = ox / L * SEP_MAX; oz = oz / L * SEP_MAX; }
      const n = sepL[i];
      n.sepx = ox; n.sepz = oz; n.sepF = sepF;
    }
    sepL.length = 0;
  }

  /* ── the viewer, standing in the street ─────────────────────────
     `--cam=stroll` puts the user's own eye at 1.35 units, in a lane, among a
     crowd that until now had no idea anyone was there and walked straight
     through them — one shot had a villager's head filling the bottom of frame.
     A viewer is a PLACE the crowd does not want to be, not an obstacle:
     `setViewer(x, z, r)` marks it, `clearViewer()` takes it away, and the crowd
     is never told which mode the camera is in or that a camera exists at all.

     The push is soft and it is mostly SIDEWAYS. A radial shove alone backs people
     up the lane and they either freeze in front of you or moonwalk; what a person
     actually does is bear off a foot or two, keep walking, and close the gap
     again behind you. So the target displacement is the away-vector plus a
     tangent chosen to agree with the direction they were already travelling, held
     in `n.px/n.pz` OUTSIDE the route so the route never changes: the villager's
     path is untouched and only where they put their feet along it bows. It is
     rate-limited (`VIEW_PUSH_RATE`) so nobody can teleport, and it decays on its
     own tau the moment the viewer moves on. */
  let viewOn = false, viewX = 0, viewZ = 0, viewR = VIEW_R_DEF, viewR2 = 0;
  /** ONE personal space, two things that can occupy it — the neighbours, aimed
   *  by the grid pass above, and the viewer. The whole per-villager cost is a
   *  stamp compare for the first and two multiplies and a compare for the
   *  second, plus one square root for the handful who are actually crowded. */
  function personalSpace(n, wdt) {
    let tx = 0, tz = 0;
    if (n.sepF === sepF) { tx = n.sepx; tz = n.sepz; }
    if (viewOn) {
      const dx = n.x - viewX, dz = n.z - viewZ, d2 = dx * dx + dz * dz;
      if (d2 < viewR2) {
        const d = Math.sqrt(d2);
        // Dead centre — you have walked into them, or they into you. Break the
        // tie on their own noise so a queue of people does not all go left.
        const ax = d > 1e-3 ? dx / d : Math.sin(n.rs), az = d > 1e-3 ? dz / d : Math.cos(n.rs);
        let sx = -az, sz = ax;                     // the tangent…
        const fx = Math.sin(n.face), fz = Math.cos(n.face);
        if (sx * fx + sz * fz < 0) { sx = -sx; sz = -sz; }   // …the way they were going
        const m = viewR - d;
        tx += ax * m + sx * m * VIEW_PUSH_SIDE; tz += az * m + sz * m * VIEW_PUSH_SIDE;
      }
    }
    if (tx === 0 && tz === 0 && n.px === 0 && n.pz === 0) return;
    // The two are ONE personal space: somebody caught between a neighbour and
    // the viewer bears off once, not twice, and the cap is the same 1.10 m
    // sidestep it has always been.
    const T = Math.hypot(tx, tz);
    if (T > VIEW_PUSH_MAX) { tx = tx / T * VIEW_PUSH_MAX; tz = tz / T * VIEW_PUSH_MAX; }
    // WALL CLOCK, not the banked simulation dt. The walker in camera.js is
    // integrated from `performance.now()` and town.js clamps `dt` to 50 ms, so at
    // the 1–3 fps of a headless capture the viewer crosses the square in real
    // time while the crowd's own seconds run twenty times slower. A step-aside
    // paced by `dt` would therefore be photographed half-finished, with someone's
    // head still filling the bottom of the frame — which is the exact defect this
    // exists to fix.
    const k = 1 - Math.exp(-wdt / VIEW_PUSH_TAU), cap = VIEW_PUSH_RATE * wdt;
    let ux = (tx - n.px) * k, uz = (tz - n.pz) * k;
    const s = Math.hypot(ux, uz);
    if (s > cap) { ux = ux / s * cap; uz = uz / s * cap; }
    n.px += ux; n.pz += uz;
    if (Math.abs(n.px) < 1e-4 && Math.abs(n.pz) < 1e-4) { n.px = 0; n.pz = 0; }
  }

  function crierSpot() {
    const c = monC(), R = Math.max(plazaR() - 2.4, monOuter() + 1.2);
    let dx = camX - c.x, dz = camZ - c.z;
    const L = Math.hypot(dx, dz) || 1;
    return { x: c.x + dx / L * R, z: c.z + dz / L * R };
  }
  function announce(text) {
    if (dead || !folk.length) return false;
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return false;
    const now = clock();
    if (crierState > 0 || now < crierEnd + CRY_COOL_MS) return false;
    const p = folk[0];
    // If the Crier went in for the night, he comes back out for this: a forced
    // spawn is the only version of "the town hears the news" that survives 1 fps.
    let n = p.live;
    const fresh = !n;
    if (!n) { n = spawn(now, 0); if (!n) return false; }
    freeSlot(n);
    const s = crierSpot();
    /* …AND HE COMES OUT NEAR HIS MARK. A forced spawn drops him on a random road
       point, which used to be harmless because the deadline teleported him to
       the plaza anyway; now that he has to walk there on his own feet, being
       spawned across town means the news gets read in a lane instead of at the
       fountain. He keeps his own bell tower, so: out of the door, four strides
       short of the rim, and he walks the rest in view. Only ever on a spawn —
       a Crier already out on the street walks from wherever he happens to be,
       and cries from wherever he gets to. */
    if (fresh) {
      const a = srand(now * 1e-3) * TAU;
      n.x = s.x + Math.cos(a) * 3.4; n.z = s.z + Math.sin(a) * 3.4; n.y = 0;
      n.px = 0; n.pz = 0; n.sepF = -1;
    }
    crierText = t; crierState = 1; crierFrom = now; crierUntil = now + CRY_WALK_MS;
    n.state = 'toCrier'; n.idleUntil = 0; n.pilgrim = false;
    routeTo(n, s.x, s.z);
    return true;
  }
  /** Wall-clock arbitration, run before the pose so this frame is already right. */
  function stepCrier(now) {
    if (!crierState) return;
    const n = folk.length ? folk[0].live : null;
    if (!n || n.dying > 0) { crierState = 0; crierText = ''; crierEnd = now; return; }
    if (crierState === 1 && now >= crierUntil) {          // the deadline: speak
      /* HE IS NOT TELEPORTED ONTO HIS MARK ANY MORE. The mark is where he was
         AIMING, not a place he is entitled to appear at, and a man vanishing
         from a lane to reappear at the fountain is the most magical thing this
         town has ever done (AESTHETIC rule 3). Since `toCrier` is walked on the
         wall clock he now covers the ground for real — about 11 u in the six
         seconds he is given, at the running gear — and on the rare occasion
         that is not far enough he simply cries the news from where he stands,
         which is a thing a crier does. */
      clearLegs(n); n.tailNode = -1;
      beginSpeech(n, now);
    } else if (crierState === 2 && now >= crierUntil) {
      crierState = 0; crierText = ''; crierEnd = now;
      n.state = 'stroll'; newErrand(n, now);
    }
  }
  function beginSpeech(n, now) {
    crierState = 2; crierFrom = now; crierUntil = now + CRY_SPEAK_MS;
    n.state = 'crier'; n.pauseFrom = now;
    n.face = faceOf(camX - n.x, camZ - n.z);
  }

  /* ── the protagonist's fortune ──────────────────────────────────
     One named villager whose standing integrates the town's pace on a 45 s
     exponential and settles into five bands. Debounced: the word for someone's
     week does not change twice in a minute. Celebratory or wry, never a verdict. */
  const evH = [], evM = [];
  let heroEma = 1, heroAt = 0, heroBandAt = -1e9;
  function stepHero(now, ctx) {
    if (!folk.length || heroId < 0) return;
    const p = folk[heroId];
    if (!heroAt) { heroAt = now; heroEma = ctx && ctx.paceRatio > 0 ? ctx.paceRatio : 1; return; }
    if (now - heroAt < 1000) return;
    const k = 1 - Math.exp(-(now - heroAt) / HERO_TAU);
    heroAt = now;
    heroEma += ((ctx && ctx.paceRatio > 0 ? ctx.paceRatio : 1) - heroEma) * k;
    let band = 0;
    while (band < FORTUNE_CUT.length && heroEma >= FORTUNE_CUT[band]) band++;
    if (band === p.band || now - heroBandAt < HERO_HOLD) return;
    const was = p.fortune;
    p.band = band; p.fortune = FORTUNE[band]; heroBandAt = now;
    if (evH.length > 2) evH.shift();
    evH.push({ kind: 'fortune', up: band > 0 && FORTUNE.indexOf(was) < band, who: p.name,
      job: p.job, quarter: p.quarter, fortune: p.fortune, was });
    if (p.live) repaintHero(p);
  }
  /** A rising fortune shows on their back before it shows in the paper. */
  function repaintHero(p) {
    p.robe = ROBE[(p.band * 3 + 1) % ROBE.length];
    if (p.live) { p.live.robe = p.robe; repaint(p.live); }
  }

  /* ── startle ────────────────────────────────────────────────────
     Lightning, thunder, a very large number. Half a second of the whole town
     stopping and looking up, on the wall clock so a screenshot can catch it. */
  let startleAt = -1e9;
  const startleK = now => clamp(1 - (now - startleAt) / 700, 0, 1);

  /* ── per-frame ────────────────────────────────────────────────── */
  const rootM = new THREE.Matrix4(), tmpM = new THREE.Matrix4(), locM = new THREE.Matrix4();
  const bellM = new THREE.Matrix4(), headM = new THREE.Matrix4();
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion(), eu = new THREE.Euler();
  const vp = new THREE.Vector3(), vs = new THREE.Vector3(), C = new THREE.Color();
  const shrink = [], keep = [], pilg = [], carriers = [];  // scratch, reused, never nested
  let lampAt = -1e9, hourNow = 12, pinned = -1, shrinkAt = -1e9, wallAt = 0;
  let tierFar = false, tierStride = 1;
  let frameId = 0, worshipN = 0;
  const byFarthest = (a, b) => b.pr2 - a.pr2;      // from the plaza
  const byNearestPlaza = (a, b) => a.pr2 - b.pr2;
  const byNearest = (a, b) => a.d2 - b.d2;         // to the camera

  // colours are uploaded only when a villager's instance slot changes — which,
  // now that there are two wardrobes, includes crossing between them
  function paintNear(n) {
    const i = n.at; if (i < 0) return;
    IM.body.setColorAt(i, C.setHex(n.robe));
    IM.head.setColorAt(i, C.setHex(n.skin));
    IM.hat.setColorAt(i, C.setHex(n.hatc));
    // The four limb slots are what make one instanced mesh read as two garments:
    // 0-1 are arms — a sleeve in the robe's own cloth, or a bare forearm — and
    // 2-3 are legs, always hose and never the robe, because a leg that matches
    // the smock is a smock with feet.
    const ac = n.sleeve ? n.robe : n.skin;
    IM.arm.setColorAt(i * LIMBS, C.setHex(ac)); IM.arm.setColorAt(i * LIMBS + 1, C.setHex(ac));
    IM.arm.setColorAt(i * LIMBS + 2, C.setHex(n.legc)); IM.arm.setColorAt(i * LIMBS + 3, C.setHex(n.legc));
    // …and slot 4 is osier, sackcloth or timber — never cloth
    IM.arm.setColorAt(i * LIMBS + 4, C.setHex(LOADS[n.load] ? LOADS[n.load].c : 0x808080));
    IM.body.instanceColor.needsUpdate = IM.head.instanceColor.needsUpdate =
      IM.hat.instanceColor.needsUpdate = IM.arm.instanceColor.needsUpdate = true;
  }
  function paintFar(n) {
    const i = n.atF; if (i < 0) return;
    IM.bodyF.setColorAt(i, C.setHex(n.robe));
    IM.headF.setColorAt(i, C.setHex(n.skin));
    IM.bodyF.instanceColor.needsUpdate = IM.headF.instanceColor.needsUpdate = true;
  }
  const repaint = n => { if (n.at >= 0) paintNear(n); else paintFar(n); };
  const headY = n => HEAD_Y * (n.sEff || n.scale) + .32;

  function update(dt, now, ctx) {
    if (dead) return;
    // How long the LAST frame took, measured before lastNow is overwritten.
    // `dt` cannot answer this — town.js clamps it to 50 ms before handing it
    // over, so a 1600 ms frame and a 50 ms one arrive identical.
    const frameMs = lastNow ? now - lastNow : 16;
    lastNow = now;
    if (ctx && ctx.plan && ctx.plan !== plan) adoptPlan(ctx.plan);
    if (!folk.length) mintRoster();
    if (ctx && ctx.camera) { camX = ctx.camera.position.x; camZ = ctx.camera.position.z; }
    // The routine wants the hour ?hour=N pinned, which lives on ctx if town.js
    // publishes it; the wall clock is the honest fallback.
    hourNow = ctx && typeof ctx.hour === 'number' ? ctx.hour
      : (d => d.getHours() + d.getMinutes() / 60)(new Date((ctx && ctx.simNow) || Date.now()));
    topUpHomes();
    stepHero(now, ctx);
    stepCrier(now);
    // Who can be heard, and what the town has just built for them to talk about.
    // Both are on the WALL CLOCK (`now` is what town.js pulls from
    // performance.now()), so a 1 fps headless capture reaches the same state a
    // 60 fps session does — nothing here is paced by `dt`.
    stepVoice(now, ctx);
    scanBuildings(now);
    const night = clamp((ctx && ctx.night) || 0, 0, 1);
    // Dusk thins the streets, it does not empty them: this is a companion app for
    // someone still working at 23:00, and cutting the population to 22 % handed
    // them a dead town as the reward for the day's biggest total. 45 % stay out,
    // and a bigger share of those carry a lantern — moving lights ARE the night.
    const live = desired <= 0 ? 0 : clamp(Math.round(desired * (1 - .55 * night)), 2, MAX);
    // Villagers are 0.6 units tall and the camera pulls back ~3× from a hamlet to
    // a nine-band city, so the headline feature went sub-pixel exactly as the
    // population grew. A mild distance term holds them at 4-5 px.
    const camD = ctx && ctx.camera ? Math.hypot(ctx.camera.position.x, ctx.camera.position.z, ctx.camera.position.y) : 62;
    const poseK = 1 + .5 * clamp((camD - 80) / 170, 0, 1);
    // How much WALL CLOCK this frame took. Not `dt` — town.js clamps that to
    // 50 ms, which is the right call for gait and exactly the wrong one for
    // deciding how many people are allowed to arrive or leave in a slow frame.
    const wall = wallAt ? clamp(now - wallAt, 0, 2000) : 16;
    wallAt = now;
    // …in seconds, for the two things a SCREENSHOT has to show finished: the
    // step-aside around the viewer and the head that turns to look at them.
    const wdt = Math.max(wall, 8) / 1000;

    /* …and whether the crowd re-aims its personal space this frame. `nearR` is
       the wardrobe radius from the last histogram, so the set gathered below is
       by construction the ~160 people wearing a body plus a shell one body deep
       — the only people anyone can catch standing inside someone else. Advancing
       `sepF` HERE rather than inside the pass is what makes a skipped pass (the
       far tier, an empty street) expire the last one's targets instead of
       freezing them: everybody's push then decays on its own tau. */
    // Gated on the LAST FRAME, not on `now - sepAt`: sepAt only advances when
    // the pass runs, so gating on it would stand the pass down permanently the
    // first time a frame ran long — the same latch this exists to avoid.
    sepRun = now - sepAt >= SEP_MS && frameMs <= SEP_MAX_FRAME;
    if (sepRun) {
      sepAt = now; sepF++; sepL.length = 0;
      sepR2 = tierFar ? -1 : (nearR + SEP_R_MAX) * (nearR + SEP_R_MAX);
    }

    /* ONE census pass. At 160 villagers three separate walks of the crowd cost
       nothing; at 1400 they are the cheapest thing that is still worth not doing
       three times. This is also where the camera distance every LOD decision
       below reads is sampled, and where each villager banks the dt they are owed
       — `acc` is what makes a 4 Hz villager walk exactly as far as a 60 Hz one. */
    let leaving = 0, worshippers = 0, seated = 0;
    nearestD2 = 1e18;
    for (let i = 0; i < npcs.length; i++) {
      const n = npcs[i];
      n.acc += dt;
      const ddx = n.x - camX, ddz = n.z - camZ;
      n.d2 = ddx * ddx + ddz * ddz;
      if (n.d2 < nearestD2) nearestD2 = n.d2;      // …the speech gate's second clause
      if (sepRun && n.d2 < sepR2 && sepL.length < SEP_CAP) sepL.push(n);
      const s = n.state;
      if (s === 'home') leaving++;
      else if (s === 'worship') { worshippers++; seated++; }
      else if (s === 'toShrine') worshippers++;
    }
    worshipN = seated;
    // …and the neighbours are re-aimed before anybody takes a step, off the
    // positions the frame started at. One frame of lag on a push that eases in
    // over .17 s is not a thing that can be photographed.
    if (sepRun) stepSeparation();

    // Existence is wall-clock, never dt-accumulated: a screenshot 8 s in shows
    // the full population even at 1 fps. Villagers on their way home are already
    // spoken for — count them out, or dusk marches the whole town to its doors
    // while the arithmetic waits for the first one to arrive.
    let active = npcs.length - leaving;
    if (active < live) {
      for (let i = 0; i < npcs.length && active < live; i++) {   // turn the leavers around
        const n = npcs[i];
        if (n.state !== 'home' || n.dying > 0) continue;
        newErrand(n, now); active++;
      }
      // A thousand villagers arriving in ONE frame is a thousand route plans in
      // one frame. The budget is ~900 arrivals a SECOND OF WALL CLOCK, so a
      // 60 fps client fills its streets over about a second while the ~1 fps of a
      // headless shot fills them in one frame. It is deliberately NOT scaled by
      // `dt`: town.js clamps that to 50 ms, so a dt budget silently capped a
      // headless run at ~45 arrivals a frame and photographed a third of a town.
      let budget = clamp(Math.round(wall * .9), 6, 900);
      while (active < live && npcs.length < MAX && budget-- > 0 && spawn(now)) active++;
    } else if (active > live && now - shrinkAt > 70) {
      // surplus walks home, outermost first (the plaza stays busy longest); sent
      // off in batches so a dusk drop of 600 resolves in a second, not ten
      shrinkAt = now;
      shrink.length = keep.length = 0;
      for (const n of npcs) {
        if (n.state === 'home' || held(n)) continue;
        (n.state === 'worship' ? keep : shrink).push(n);
      }
      const pool = shrink.length ? shrink : keep;
      // sort on the squared radius already banked by the census; `polarR` inside
      // a comparator is a Math.hypot per comparison, ~13 000 of them at this size
      for (const n of pool) n.pr2 = (n.x - MON.x) * (n.x - MON.x) + (n.z - MON.z) * (n.z - MON.z);
      pool.sort(byFarthest);
      const sends = Math.min(pool.length,
        clamp(Math.ceil((active - live) / 6), 1, clamp(Math.round(wall * 1.4), 12, 900)));
      for (let i = 0; i < sends; i++) goHome(pool[i], now);
    }

    // shares are of the ACTIVE crowd: leavers are committed elsewhere, and counting
    // them would send every last stroller to the altar at dusk. The 42 seats are a
    // CEILING and stay one: the centrepiece is a village fountain, and a thousand
    // people knelt around it would be the blob the plaza is meant not to become.
    const celebrating = now < spikeUntil;
    const wantWorship = clamp(Math.round(active * (celebrating ? .42 : .18)),
      Math.min(2, active), 42);

    const chant = now / 2400 * TAU;
    const lampMax = night > .3 ? Math.min(24, Math.max(2, Math.round(active * .5))) : 0;
    const A = attract(), ac = A && A.center ? A.center : MON;
    const acx = ac.x, acz = ac.z, afy = A && A.focus ? A.focus.y : 1.5;
    const stun = startleK(now);
    frameId++;

    /* WHO IS CARRYING A LANTERN is decided HERE, before the pose, and it used to
       be decided after it. That ordering is the whole of why the lamp hung in
       mid-air: the pose could not know to stop the carrying hand swinging, so
       the lantern was pinned to a fixed height instead of to a fist.
       The lamp goes in whichever hand is free — a villager with a basket at the
       left hip carries it on the right — and anyone with a bundle in BOTH hands
       is passed over rather than made to sprout a third. */
    let nLamp = 0;
    const lampN = Math.min(lampMax, 26);
    for (let i = 0; i < npcs.length && nLamp < lampN; i++) {
      const n = npcs[i];
      if (n.state === 'worship' || n.dying > 0) continue;
      const LD = LOADS[n.load];
      if (LD && LD.hs === 2) continue;
      n.lampF = frameId; n.lampS = LD && LD.hs === 1 ? -1 : 1;
      nLamp++;
    }

    // The near wardrobe holds the NEAREST NPC_NEAR_CAP people, so the radius that
    // fits them has to follow the crowd and the camera. Re-derived at 4 Hz off the
    // wall clock; between recomputes the hard capacity check in wardrobe() is the
    // backstop, and the hysteresis band keeps a villager on the line from paying
    // for a wardrobe change twice a second.
    if (now - nearRAt > 240) { nearRAt = now; recomputeNearR(); }
    const nearIn = tierFar ? -1 : nearR * nearR;
    const nearOut = tierFar ? -1 : (nearR + NEAR_HYST) * (nearR + NEAR_HYST);
    // The far tier stretches every slice: at 3.5 px nobody can see 60 Hz steering.
    const lodK = tierFar ? Math.max(1, Math.min(4, tierStride)) : 1;

    for (let i = npcs.length - 1; i >= 0; i--) {
      const n = npcs[i];

      /* ── THE TIME SLICE ────────────────────────────────────────────
         Whether this villager is simulated at all this frame. Four things
         make it unconditional: they are mid-fade, newborn, followed by the
         camera, or holding the plaza with a bell. Everyone else waits for
         their wall-clock turn — 0 ms in the near band, 260 ms out at the
         edge of town — and then does a FULL step with the dt they banked,
         so the only thing a slice costs is update RATE, never distance,
         never a state that quietly stops advancing. At the ~1 fps of a
         headless shot every interval has already expired and the whole
         town steps, which is the only reason a screenshot is honest. */
      const vital = n.dying > 0 || now - n.bornAt < 500
        || n.seed === pinned || n.state === 'crier' || n.state === 'toCrier';
      if (!vital && now < n.nextAt) continue;

      // Hysteresis: `nearOut` for someone already dressed for it, `nearIn` for
      // someone who is not. tierFar sets both to -1, which is how "the whole
      // town is 3.5 px across" collapses to a single far wardrobe.
      wardrobe(n, n.d2 < (n.at >= 0 ? nearOut : nearIn));
      // band by distance: 0 every frame, 3 four times a second
      let band = 0;
      while (band < 3 && n.d2 >= LOD_D2[band]) band++;
      n.lod = band;
      n.nextAt = now + LOD_MS[band] * lodK;

      // DELIBERATE SHADOW: for the rest of this iteration `dt` means "the
      // seconds THIS villager was owed", not "the seconds the frame took".
      // Every use below — the fade, advance(), the gait phase, the yaw lerp —
      // wants the former, and shadowing is what makes it impossible to reach
      // for the wrong one by accident.
      const dt = n.acc > 1e-4 ? n.acc : 1e-4;
      n.acc = 0;
      // Step off the personal-space offset for the duration of the simulation:
      // every transition, every leg and every route below reasons about where
      // this villager is ON THEIR PATH, and it is folded straight back in at the
      // pose. Symmetric, so a villager who is never stepped keeps a stable
      // position and one who is stepped never drifts.
      n.x -= n.px; n.z -= n.pz;
      const done = !n.leg && !n.legs.length;

      /* transitions — scheduled on `now`, never on accumulated dt */
      if (n.state === 'bridge') {
        // the one villager in the town who is not going anywhere
        if (now > n.until) { n.state = n.resume || 'stroll'; n.until = Math.max(n.resumeUntil, now + 2000); }
      } else if (n.state === 'stroll') {
        if (n.pilgrim) { n.pilgrim = false; if (enterWorship(n, now, false)) worshippers++; }
        else if (now > n.until) {                        // the errand's time is up: loiter, then decide
          if (!n.idleUntil) { n.idleUntil = now + 1200 + srand(n.rs + i) * 4200; clearLegs(n); }
          else if (now > n.idleUntil) {
            n.idleUntil = 0;
            if (worshippers < wantWorship) { if (enterWorship(n, now, false)) worshippers++; }
            else newErrand(n, now);
          }
        } else if (n.legs.length < 2 && !wanderStep(n) && done) newErrand(n, now);
      } else if (n.state === 'toShrine') {
        if (done) { n.state = 'worship'; n.x = n.wx; n.z = n.wz; n.y = 0; seated++; }
        // A pilgrim who is somehow still walking half a minute past their own
        // deadline has lost their route; give up and free the seat, or one broken
        // path holds a worship slot for the rest of the epoch.
        else if (now > n.until + 30000) { newErrand(n, now); worshippers--; }
      } else if (n.state === 'worship' && now > n.until && seated > wantWorship) {
        newErrand(n, now); worshippers--; seated--;
      } else if (n.state === 'toWork') {
        // Arrival re-arms the clock, so they STAND at the premises for a full
        // window instead of a leftover slice of the walk. Missing the window
        // entirely (a long walk, a slow frame rate) just means an ordinary day.
        if (done) { n.state = 'work'; n.until = now + 18000 + srand(n.rs * 2.9 + (now | 0)) * 30000; }
        else if (now > n.until) newErrand(n, now);
      } else if (n.state === 'work' && now > n.until) {
        newErrand(n, now);
      } else if (n.state === 'toCrier' && done) {
        beginSpeech(n, now);
      } else if (n.state === 'run' && done) {
        n.state = 'cheer'; n.cheerFrom = now; n.until = now + 2600;
      } else if (n.state === 'cheer' && now > n.until) {
        if (n.pilgrim) { n.pilgrim = false; if (enterWorship(n, now, false)) worshippers++; }
        else newErrand(n, now);
      } else if (n.state === 'home' && done) {
        n.dying = Math.min(1, n.dying + dt * 3.2);
        if (n.dying >= 1) { despawn(i); continue; }
      }

      /* travel + gait */
      const still = n.state === 'worship' || n.state === 'cheer' || n.state === 'bridge'
        || n.state === 'work' || n.state === 'crier';
      if (still) n.v = 0;                     // …and they start again from a standstill
      /* THE CRIER WALKS ON THE WALL CLOCK, and he is the only one who does.
         His arrival is not a gait question, it is an EXISTENCE question — the
         announcement is contracted to happen CRY_WALK_MS after it was ordered —
         and every existence decision in this file is taken on the wall clock for
         the same reason: town.js clamps `dt` to 50 ms, so at the ~1 fps of a
         headless capture a dt-paced walk covers a twentieth of the ground it
         should and the deadline used to arrive with him still down a lane. It
         did, and he was TELEPORTED onto his mark. Now he actually gets there,
         and if he does not he cries from where he stands. At 60 fps `wdt` and
         `dt` are the same number, so this changes nothing anyone is watching. */
      const mdt = n.state === 'toCrier' && wdt > dt ? wdt : dt;
      const moved = still ? 0 : advance(n, mdt, now);
      const spd = moved / mdt;
      const walking = spd > .05;
      /* CADENCE FOLLOWS SPEED, and it is not a tuned multiplier. `stepU` is how
         far this person's foot travels in one step, in the figure's own units;
         times the pose scale it is their step in world units, and π per step is
         the phase rate at which the planted foot stays planted. So a faster
         walker takes QUICKER steps rather than indefinitely longer ones, and a
         long-legged one takes fewer of them at the same pace — which is the
         half of "walking" that `spd * 5.8` could not express: it was a fixed
         0.96 m stride at every speed, a stride nobody has, and a foot that
         slides at every pace but the one it was tuned at. Off their feet, the
         phase is just breathing. */
      /* …but past a WALK a person opens their stride as well as quickening it,
         and cadence alone cannot express a run. At a fixed 70 cm step, 3.2 m/s
         comes out at 272 steps a minute, which is a scurry with the film sped
         up; +30 % of swing makes it a 95 cm stride at 200, which is somebody
         running. `over` is how far above their OWN walk they are, so it is 0
         for everybody not in a gear — and only those few pay the two sines. */
      const over = walking && n.speed > 1e-3 ? spd / n.speed - 1 : 0;
      const amp = over > .02 ? 1 + Math.min(over, 1.6) * .30 : 1;
      const thMax = LEG_SWING * n.stride * amp;
      const stepW = (amp === 1 ? n.stepU
        : n.stepU * Math.sin(thMax) / Math.sin(LEG_SWING * n.stride)) * (n.sEff || n.scale);
      n.ph += (walking ? Math.min(PH_MAX, Math.PI * spd / stepW) : 1.1) * mdt;

      let want = n.face;
      if (still && n.state !== 'bridge') {
        if (n.state === 'work') { const p = folk[n.seed]; if (p) want = faceOf(p.workFx - n.x, p.workFz - n.z); }
        else if (n.state === 'crier') want = faceOf(camX - n.x, camZ - n.z);
        else want = faceOf(acx - n.x, acz - n.z);
      }
      // The feet turn at a PERSON's rate. The lerp alone answered a junction's
      // worth of error at ~9 rad/s, i.e. a villager snapping square round a
      // corner inside a tenth of a second; the cap is what makes a corner a
      // corner. camera.js holds its own walker to 1.7 rad/s.
      const turn = wrapPi(want - n.yaw) * clamp(mdt * TURN_K, 0, 1);
      n.yaw = wrapPi(n.yaw + clamp(turn, -TURN_RATE * mdt, TURN_RATE * mdt));
      // …and only NOW, with the route resolved, does anyone notice who they are
      // walking into — a neighbour, or you. The offset lives outside the path,
      // so stepping round either never re-plans a route or drops a leg.
      personalSpace(n, wdt);
      // …and fold it straight back in, so `n.x` is where this villager IS for
      // every other reader in the module — picking, tracking, lanterns, the
      // speech-bubble tether — and the subtraction at the top of the next step
      // is exactly this addition undone.
      const wx = n.x + n.px, wz = n.z + n.pz;
      n.x = wx; n.z = wz;

      /* ── pose ───────────────────────────────────────────────────
         A walk is legs. The gait is one phase, `n.ph`, and everything reads off
         it: legs scissor, arms answer them in antiphase, the body rises when the
         feet are together and drops at full stride, and the SWINGING leg
         shortens a little, which at this scale is the only knee anyone needs.
         Every amplitude is multiplied by this person's own `stride`/`swing`, and
         `tilt`/`lean` are a permanent shoulder drop and stoop that are theirs, so
         a hundred villagers walking down one lane are a hundred gaits. */
      const gph = Math.sin(n.ph), cph = Math.cos(n.ph);
      /* THE LEG ANGLE IS A TRIANGLE WAVE, not a sine, and the difference is the
         whole of whether the feet skate. A sinusoidal leg's angular velocity
         peaks at 1.67× its own mean in mid-step, so however the cadence is
         tuned the planted foot drags backwards through the road at two thirds
         of walking pace exactly when it is most visible. `.6s + .4s³` is the
         first two terms of a triangle wave — one multiply-add, no new
         transcendental — and at that shape the mid-step foot travels at 1.00×
         walking pace, which is to say it is STILL, which is what standing on
         it means. */
      const tri = gph * (TRI_A + TRI_B * gph * gph);
      const th = walking ? thMax * tri : 0;
      // …and the hips fall as the legs scissor, or the feet leave the ground.
      // cos θ to second order: at 34° that is within 1.5 %, for a multiply
      // instead of a cosine.
      let bob = walking ? -HIP_Y * n.bh * th * th * .5 * BOB_K : Math.sin(n.ph) * .005;
      let roll = (walking ? gph * .055 : 0) + n.tilt;
      let pitch = (walking ? .045 : 0) + n.lean, lift = 0, armOut = .11, legOut = .045;
      let armA = walking ? gph * .42 * n.swing : Math.sin(n.ph * .5) * .05 * n.swing;
      let armB = walking ? -armA : -armA * .72;                 // never quite symmetrical
      let legA = -th, legB = th, legS = 1;
      // The swing leg is the one whose foot is travelling forward — `cph` says
      // which — and it is the one that has to clear the road. Shortening it as
      // it passes is a knee, at this scale and at this triangle count.
      const kneeA = walking ? Math.max(0, cph) : 0, kneeB = walking ? Math.max(0, -cph) : 0;
      // …and the leg makes up whatever the hips did not fall, so the sole stays
      // on the road. 1/cos θ to second order; 8 % of a leg at full stride.
      const legR = walking ? 1 + (1 - BOB_K) * th * th * .5 : 1;
      // A hand with a basket in it does not swing with the other one.
      if (n.load) {
        const LD = LOADS[n.load];
        if (LD.hs !== 1) armA = LD.hold + armA * .18;
        if (LD.hs !== 0) armB = LD.hold + armB * .18;
      }

      if (n.state === 'worship') {
        const ph = chant + srand(n.rs * 29) * .6;
        // every token increase makes the congregation dip as one — the literal
        // heartbeat of the town, driven by town.js's pulse()
        const pk = Math.sin(Math.PI * clamp((now - pulseAt) / 700, 0, 1));
        // look UP at the coin, which floats well above head height
        const gaze = -clamp(Math.atan2(afy - .5, Math.max(Math.hypot(n.x - acx, n.z - acz), 1)), 0, .5);
        legA = legB = 0; bob = 0;
        if (n.rite === 0) {                              // bow
          pitch = .62 * Math.pow(Math.max(0, Math.sin(ph)), 1.6) + .5 * pk + gaze;
          armA = armB = -.25 - pitch * .35;
        } else if (n.rite === 1) {                       // arms raised to the altar
          const k = .5 + .5 * Math.sin(ph) + pk * .6;
          armA = armB = -2.35 - k * .35; armOut = .5 + k * .12; pitch = gaze;
          roll = Math.sin(ph * .5) * .07; bob = k * .02;
        } else {                                         // kneel
          // Straight legs cannot kneel, but a SHORT leg swung back can: the shin
          // folds under the thigh, which is the whole of what a knee looks like
          // at this range, and the hips come down to meet the ground.
          lift = -.115; pitch = .34 + .07 * Math.sin(ph) + .3 * pk + gaze * .5;
          armA = armB = -.95 - .15 * Math.sin(ph);
          legA = legB = .95; legS = .58; legOut = .12;
        }
      } else if (n.state === 'cheer') {
        const t = Math.max(0, (now - n.cheerFrom) / 1000);
        // 1.5 hops a second, 0.25 m off the ground. `.34` at 1.62 scale was a
        // 0.98 m standing jump, held 2.4 times a second, by everyone in town.
        const hop = Math.abs(Math.sin(t * 4.6));
        bob += hop * .085;
        armA = armB = -2.5 + Math.sin(t * 15) * .25; armOut = .55;
        roll = Math.sin(t * 9) * .1;
        legA = legB = -hop * .30; legS = 1 - hop * .13;   // knees tuck on the way up
      } else if (n.state === 'bridge') {
        // leaning on the parapet, elbows down, watching the water go by
        const t = (now - n.pauseFrom) / 1000;
        pitch = .21 + .035 * Math.sin(t * 1.1);
        armA = armB = -.62 - .05 * Math.sin(t * 1.1); armOut = .34;
        roll = Math.sin(t * .7) * .03; bob = Math.sin(t * 1.3) * .008;
      } else if (n.state === 'work') {
        // stood outside their own premises, hands busy with nothing in particular
        const t = (now - n.bornAt) / 1000 + n.rs;
        pitch = .06 + .03 * Math.sin(t * .9);
        armA = -.34 + .12 * Math.sin(t * 1.7); armB = -.30 - .10 * Math.sin(t * 1.3);
        armOut = .30; bob = Math.sin(t * 1.1) * .01;
      } else if (n.state === 'crier') {
        // one arm up with the bell, the other cupped, calling it out
        const t = (now - n.pauseFrom) / 1000;
        bob += Math.abs(Math.sin(t * 3.1)) * .028;        // 8 cm of rise, calling it out
        armA = -2.62 + Math.sin(t * 9) * .30;            // the bell hand
        armB = -1.15 + Math.sin(t * 2.2) * .08; armOut = .46;
        pitch = -.10 + .04 * Math.sin(t * 3.1);
      }
      if (stun > 0 && n.state !== 'worship') {           // heads up, everyone stops
        pitch -= .42 * stun; armA -= .5 * stun; armB -= .5 * stun; roll *= 1 - stun;
        legA *= 1 - stun; legB *= 1 - stun;
      }
      if (n.dying > 0) lift -= n.dying * .12;
      /* A HAND WITH A LANTERN IN IT DOES NOT SWING, and it is the last word on
         that arm — after the rites, the cheer and the startle, because a lantern
         held out at arm's length while its owner throws both arms up is exactly
         the sort of thing a night shot is full of. The angles are the same two
         the lamp pass places the lantern by, so the light is IN the fist. */
      let outA = armOut, outB = armOut;
      if (n.lampF === frameId) {
        if (n.lampS > 0) { armB = LAMP_PITCH; outB = LAMP_OUT; }
        else { armA = LAMP_PITCH; outA = LAMP_OUT; }
      }

      /* ── where the head is looking ──────────────────────────────
         The head has its own matrix, so this costs a lerp and nothing else. The
         idle glance runs on the WALL CLOCK — a headless capture paints at ~1 fps
         and a gait-driven glance would freeze the whole crowd staring dead ahead
         in every screenshot ever taken of this town. And when the viewer is in
         the lane, the people you are walking past look at you: it is the other
         half of stepping aside, and it is what makes the avoidance read as
         courtesy rather than as physics. */
      // …and ONLY for the near wardrobe. The far set has no head matrix to put
      // the answer in, and four sines and a lerp for a thousand people whose
      // heads are two pixels wide is the one part of this that showed up on the
      // frame budget.
      if (n.at >= 0) {
        let hyW = Math.sin(now / 2600 + n.rs * 3.1) * .30 * (walking ? .45 : 1);
        let hpW = Math.sin(now / 3700 + n.rs) * .05;
        if (viewOn && n.state !== 'worship' && n.state !== 'crier') {
          const vdx = viewX - wx, vdz = viewZ - wz, vd2 = vdx * vdx + vdz * vdz;
          if (vd2 < VIEW_LOOK_R * VIEW_LOOK_R) {
            const off = wrapPi(faceOf(vdx, vdz) - n.yaw);
            if (Math.abs(off) < 1.3) {                   // nobody turns their head round
              const w = 1 - vd2 / (VIEW_LOOK_R * VIEW_LOOK_R);
              hyW += (clamp(off, -1.05, 1.05) - hyW) * w;
              hpW += (-.17 - hpW) * w;                   // your eye is above their crown
            }
          }
        }
        const hk = clamp(wdt * 5, 0, 1);   // wall clock: see personalSpace
        n.hy = angLerp(n.hy, hyW, hk); n.hp += (hpW - n.hp) * hk;
      }

      const grow = clamp((now - n.bornAt) / 380, 0, 1);   // wall-clock pop-in
      const s = n.scale * poseK * (.55 + .45 * grow) * (1 - n.dying * .9);
      n.sEff = s;

      /* ── matrices ───────────────────────────────────────────────
         The ROOT is the figure: position, facing, lean, and the one uniform
         scale everything else inherits. It is identical in both wardrobes, so a
         villager crossing between them does not so much as twitch. What the FAR
         set drops is the six local matrices and 247 of the 287 triangles, for
         people who are by construction the ones the camera is furthest from. */
      eu.set(pitch, n.yaw, roll, 'YXZ'); q.setFromEuler(eu);
      // `n.y` is the ONE term that says which surface they are standing on: the
      // road (0) or a bridge deck. Everything that reads a villager's position
      // adds it — this matrix, the contact disc, the lantern, the ray test and
      // track() — so a villager lifted for rendering is lifted for picking too.
      vp.set(wx, n.y + lift + bob, wz); vs.setScalar(s);
      rootM.compose(vp, q, vs);
      const k = n.at;
      if (k < 0) {                                       // ── the far wardrobe
        const kf = n.atF;
        if (kf >= 0) { IM.bodyF.setMatrixAt(kf, rootM); IM.headF.setMatrixAt(kf, rootM); }
        continue;
      }
      // the body: a pure scale about the feet — stout or slight, tall or short
      // in the torso. No rotation and no translation, so it is three writes and
      // one multiply rather than a compose.
      locM.identity();
      locM.elements[0] = n.bw; locM.elements[5] = n.bh; locM.elements[10] = n.bw;
      IM.body.setMatrixAt(k, tmpM.multiplyMatrices(rootM, locM));
      // the head: its own place, its own size and its own aim
      eu.set(n.hp, n.hy, 0, 'YXZ'); qi.setFromEuler(eu);
      vp.set(0, HEAD_C * n.bh, 0); vs.setScalar(n.hs);
      locM.compose(vp, qi, vs);
      headM.multiplyMatrices(rootM, locM);
      IM.head.setMatrixAt(k, headM);
      // headwear rides the HEAD, so a hat turns when its owner looks at you. Hair
      // is the same cone in a hair colour — which is why "bareheaded" is a
      // silhouette here rather than a bald sphere.
      const hw = HEADWEAR[n.hw];
      if (hw.s > 0) {
        locM.identity();
        locM.elements[0] = hw.s; locM.elements[5] = hw.h; locM.elements[10] = hw.s;
        locM.elements[13] = hw.y;                        // T·S about the brim's own base
        IM.hat.setMatrixAt(k, tmpM.multiplyMatrices(headM, locM));
      } else IM.hat.setMatrixAt(k, tmpM.makeScale(0, 0, 0));
      /* Four limbs out of ONE instanced mesh: 0-1 arms off the shoulders, 2-3
         legs off the hips. The anchors ride `bh` so the hips of a short-waisted
         villager are where their smock's hem is, and the LEG's length rides it
         too — otherwise a tall torso walks on stilts and a short one on stumps. */
      for (let a = 0; a < LIMBS; a++) {
        /* SLOT 4 IS THE LOAD. The same twenty-triangle tube: squat and flared,
           it is an osier basket; fatter and tilted off the shoulder, a sack;
           drawn thin and long, a staff. It hangs off the BODY, not off the arm,
           so a rite that throws the arms up does not throw the basket with
           them — and the arm that would be holding it has already been told to
           stop swinging, up where the gait is written. */
        if (a === 4) {
          const LD = LOADS[n.load];
          if (!LD) { IM.arm.setMatrixAt(k * LIMBS + 4, tmpM.makeScale(0, 0, 0)); continue; }
          eu.set(LD.rx, 0, LD.rz, 'YXZ'); qi.setFromEuler(eu);
          vp.set(LD.x * n.bw, LD.y * n.bh, LD.z);
          vs.set(LD.sx, LD.sy, LD.sx);
          locM.compose(vp, qi, vs);
          IM.arm.setMatrixAt(k * LIMBS + 4, tmpM.multiplyMatrices(rootM, locM));
          continue;
        }
        const leg = a > 1, side = (a & 1) ? 1 : -1;
        eu.set(leg ? (a === 2 ? legA : legB) : (a ? armB : armA), 0,
          side * (leg ? legOut : (a ? outB : outA)), 'YXZ');
        qi.setFromEuler(eu);
        vp.set(side * (leg ? HIP_X : SHO_X) * n.bw, (leg ? HIP_Y : SHO_Y) * n.bh, 0);
        if (leg) {
          // the swinging leg shortens: at 6 cm of limb that IS a knee, and it
          // is what buys the forward foot its 4.7 cm of clearance over the road
          const sw = 1 - KNEE_K * (a === 2 ? kneeA : kneeB);
          vs.set(LEG_W, LEG_L * n.bh * legS * sw * legR, LEG_W);
        } else vs.set(ARM_W, ARM_L, ARM_W);
        locM.compose(vp, qi, vs);
        IM.arm.setMatrixAt(k * LIMBS + a, tmpM.multiplyMatrices(rootM, locM));
        // The bell hangs off the raised hand: tmpM is that arm's world matrix, so
        // the bell is one translation further down it and inherits pose + scale.
        if (a === 0 && n.state === 'crier' && crierState === 2) {
          bellM.makeTranslation(0, -.225, 0);
          IM.bell.setMatrixAt(0, bellM.multiplyMatrices(tmpM, bellM));
        }
      }
      eu.set(0, n.yaw, 0); qi.setFromEuler(eu);
      vp.set(wx, n.y + .045, wz); vs.set(s, 1, s);
      IM.disc.setMatrixAt(k, tmpM.compose(vp, qi, vs));
    }

    /* Lanterns: emissive spheres; only two of them get a real light. Villagers
       walking home at dusk carry one too — that exodus IS the night street life,
       and a lantern stalled on a bridge is the shot worth sending to someone.
       Their own pass, so a villager's POSE can be skipped by the time slice
       without ever renumbering a lamp instance. The bob is wall clock here
       rather than the gait phase, for the same reason.
       `lampF` stamps the frame instead of a boolean, so the loop can stop the
       moment the last lamp is placed and still never mistake a stale flag from
       three frames ago for a lit lantern — and the STAMP IS SET UP THE TOP now,
       before the pose, which is what lets the carrying hand know to hold still.

       IT HANGS FROM THAT HAND. `.30` was a fixed 0.53 m, in world units that did
       not scale with the villager, on a figure whose fist is at 0.38 m: the
       lantern floated at everyone's hip, at the same height for a big villager
       and a small one, and swung to a different place than the arm did. The
       offset below is the shoulder anchor plus the arm the POSE draws — same
       length, same two angles — so a tall villager holds it higher, a stout one
       holds it wider, and it turns with them because it is written in their own
       frame. It is placed here rather than in the pose because a lamp carrier
       may be in the far wardrobe with no arm matrices at all, and because a
       villager whose slice has not come due still has to keep their light. */
    let placed = 0;
    for (let i = 0; i < npcs.length && placed < nLamp; i++) {
      const n = npcs[i];
      if (n.lampF !== frameId) continue;
      const s = n.sEff, c = Math.cos(n.yaw), si = Math.sin(n.yaw);
      const hx = (SHO_X * n.bw + HAND_X) * n.lampS, hz = HAND_Z;
      vp.set(n.x + (hx * c + hz * si) * s,
        n.y + (SHO_Y * n.bh + HAND_Y) * s + .012 * Math.sin(now / 240 + n.rs),
        n.z + (hz * c - hx * si) * s);
      vs.setScalar(s * (1 + .12 * Math.sin(now / 300 + n.rs)));
      IM.lamp.setMatrixAt(placed, tmpM.compose(vp, qi.identity(), vs));
      n.lx = vp.x; n.ly = vp.y; n.lz = vp.z;
      placed++;
    }

    const nn = nearL.length, nf = farL.length;
    for (const im of NEARMESH) { im.count = nn; im.visible = nn > 0; }
    IM.arm.count = nn * LIMBS; IM.arm.visible = nn > 0;  // count 0 still costs a draw call
    IM.bodyF.count = IM.headF.count = nf;
    IM.bodyF.visible = IM.headF.visible = nf > 0;
    IM.lamp.count = placed; IM.lamp.visible = placed > 0;
    IM.bell.count = 1;
    IM.bell.visible = crierState === 2;
    for (const key in IM) IM[key].instanceMatrix.needsUpdate = true;
    M.disc.opacity = .14 + .22 * (1 - night);       // the disc is what grounds them at distance

    // two real lights, re-targeted twice a second so they don't strobe
    if (now - lampAt > 500) {
      lampAt = now;
      // `d2` is already this frame's camera distance, banked by the census — and
      // `lampF` is what tells a lit lantern from a flag left over three frames ago
      carriers.length = 0;
      for (const n of npcs) if (n.lampF === frameId) carriers.push(n);
      carriers.sort(byNearest);
      lampLights.forEach((L, i) => {
        const c = carriers[i];
        L.intensity = c ? 7 * night : 0;
        if (c) L.position.set(c.lx, c.ly, c.lz);
      });
    }
  }

  /* ═══ village voices — the runtime ═════════════════════════════
     Three pieces: what the town has just DONE (facts), whether anyone is close
     enough to be HEARD (the gate), and which line the last speaker gets (the
     renderer). Everything here answers safely on an empty town: no roster, no
     buildings and no ctx yields '' and town.js falls straight back to news.js's
     own pool, so this file is never load-bearing for the bubble to appear. */

  /* ── the gate ──────────────────────────────────────────────────
     `tierObj` is lod.js's OWN live tier record, held by reference: it rewrites
     `px` every frame, so reading the field is reading lod's decision rather than
     a second opinion about it. lod only CALLS onNpcTier on a far/near flip
     though, and a camera that never leaves the near tier never flips — so until
     one arrives (or town.js hands us `lod.npcTier()` at wiring time) the same
     arithmetic is done here off ctx.camera. It is the same formula in both
     places for one reason: `0.62 · poseK` is npcs.js's own villager height and
     its own distance ramp — lod.js's copy is the mirror, not the original (see
     its NPC_FAR_IN comment). K is the projection's pixels-per-unit-at-1-unit. */
  // town.js calls speechLine() BETWEEN frames, so the last ctx update() saw is
  // kept: it is the same object town.js mutates in place, never a copy.
  let ctxRef = null;
  let tierObj = null, speakNear = false, vhPx = 0, vhAt = -1e9;
  // last frame's census minimum: the nearest villager's HORIZONTAL camera
  // distance, squared. 1e18 until the first census, which reads as "nobody near".
  let nearestD2 = 1e18;
  function stageH(now) {
    if (now - vhAt > 1000) {
      vhAt = now;
      let h = 0;
      if (typeof document !== 'undefined') {
        const el = document.getElementById('stage');
        if (el) h = el.clientHeight | 0;
      }
      if (h <= 2 && typeof window !== 'undefined') h = window.innerHeight | 0;
      if (h > 2) vhPx = h;
    }
    return vhPx || 800;
  }
  /** The speaking villager's height on screen, in CSS px, or -1 if unknowable. */
  function speakPx(now, ctx) {
    if (tierObj && tierObj.px > 0) return tierObj.px;
    const cam = ctx && ctx.camera;
    if (!cam || !cam.isPerspectiveCamera) return -1;
    const b = ctx.bounds, cx = b ? b.cx : 0, cz = b ? b.cz : 0;
    const d = Math.max(1, Math.hypot(cam.position.x - cx, cam.position.y, cam.position.z - cz));
    const K = stageH(now) / (2 * Math.tan(cam.fov * Math.PI / 360));
    return .62 * (1 + .5 * clamp((d - 80) / 170, 0, 1)) / d * K;
  }
  /** Once a frame. `tierFar` is the hard floor: at the far wardrobe there are no
   *  arms and no hats on the speaker, and a remark over that is a label.
   *
   *  TWO WAYS IN, because `px` is a TOWN-scale answer: lod measures it from the
   *  centre of mass, which is right for a crowd tier and slightly wrong at the
   *  edges — walk to the far end of the lanes in stroll mode and the centre is
   *  eighty units behind you, so the villager you are standing beside is called
   *  small. The second clause asks the literal question instead: is anybody
   *  within arm's reach of the eye. `nearestD2` is last frame's census minimum
   *  (free — that loop already measures every villager against the camera) and
   *  the height term is what keeps a top-down shot honest, since the minimum is
   *  horizontal only and a camera 200 units UP is not standing next to anyone. */
  function stepVoice(now, ctx) {
    ctxRef = ctx || ctxRef;
    // px < 0 ⇒ no camera yet (the bench harness, the first frame). Stay silent
    // rather than guessing; the very next frame with a camera decides properly.
    const px = speakPx(now, ctx);
    const cy = ctx && ctx.camera ? ctx.camera.position.y : 1e9;
    const d3 = nearestD2 + cy * cy, r = speakNear ? SPEAK_R_OUT : SPEAK_R_IN;
    speakNear = !tierFar
      && ((px > 0 && (speakNear ? px > SPEAK_PX_OUT : px > SPEAK_PX_IN)) || d3 < r * r);
  }

  /* ── the facts ─────────────────────────────────────────────────
     What the town has just done, sampled from the SAME building rows the roster
     already homes people on — no new channel, no new coupling. A row carries
     `label` ('Bakery', 'Bell Tower', 'Merchant House'), `kind` and `n`, the
     deed-card ordinal, which is everything a villager needs to name the thing
     they are pointing at. */
  const recentB = [], notableB = [];
  const lmSeen = new Set();
  let bScanAt = -1e9, bSeenN = -1, bSeenLen = -1, newCount = 0, newCountAt = 0;
  let festAt = -1e9;
  /** 'The Inn' → 'Inn', so every template can write its own article. */
  const bareLabel = s => (s || '').replace(/^the\s+/i, '').trim();
  /** A house is a roof; a chapel is an event. Both are nameable — this only
   *  decides which one a villager reaches for first. */
  const grandRow = b => b.kind === 'landmark' || (b.idx != null && b.idx < 0)
    || (b.kind && b.kind !== 'house' && b.kind !== 'scaffold' && b.kind !== 'tree')
    || (b.tier != null && b.tier >= 5);
  function pushNew(b, now) {
    const label = bareLabel(b.label);
    if (!label || label === 'next building' || label === 'break') return;
    const row = { label, n: b.n > 0 ? b.n : 0, grand: grandRow(b), at: now,
      x: b.pos ? b.pos.x : 0, z: b.pos ? b.pos.z : 0 };
    // A grand arrival displaces a plain one; two cottages in a row do not push
    // the chapel somebody is still talking about off the end of the list.
    recentB.unshift(row);
    while (recentB.length > NEW_KEEP) {
      let drop = recentB.length - 1;
      for (let i = recentB.length - 1; i > 0; i--) if (!recentB[i].grand) { drop = i; break; }
      recentB.splice(drop, 1);
    }
    if (now - newCountAt > NEW_TTL) { newCount = 0; newCountAt = now; }
    newCount++;
  }
  function scanBuildings(now) {
    if (now - bScanAt < 1500) return;
    bScanAt = now;
    const bs = bldgs();
    if (!bs) return;
    // The FIRST scan that finds a town seeds the watermark silently. Otherwise
    // the founding cascade — two hundred roofs in five seconds — would arrive as
    // two hundred "that went up this morning", which is true and useless.
    const seed = bSeenLen < 0;
    let maxN = bSeenN;
    notableB.length = 0;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b || !b.label) continue;
      const lmk = b.kind === 'landmark' || (b.idx != null && b.idx < 0);
      if (lmk && notableB.length < 12) notableB.push(bareLabel(b.label));
      if (b.n > maxN) maxN = b.n;
      if (b.n > bSeenN && bSeenN >= 0) pushNew(b, now);
      else if (lmk) {
        const k = keyOf(b, i);
        if (!lmSeen.has(k)) { lmSeen.add(k); if (!seed) pushNew(b, now); }
      }
    }
    bSeenN = maxN; bSeenLen = bs.length;
    // Expire. One pass, newest first, so the tail is always the stale end.
    while (recentB.length && now - recentB[recentB.length - 1].at > NEW_TTL) recentB.pop();
    if (now - newCountAt > NEW_TTL) newCount = 0;
  }
  /** The building a villager would point at, or null. */
  const freshB = now => (recentB.length && now - recentB[0].at < NEW_TTL) ? recentB[0] : null;

  /* ── the renderer ──────────────────────────────────────────────
     `lastSaid` is the villager pickSpeaker just handed out; every slot below is
     read off THEM, so the line and the mouth agree. A 24-deep ring stops a
     repeat inside about four minutes of ordinary chatter. */
  let lastSaid = null, lastState = '';
  // the cadence: when the last ambient remark was granted, how long until the
  // next may be, and the short window an event opens for its own fallback pick
  let sayAt = -1e9, sayGap = SAY_GAP_MIN, sayOpen = -1e9;
  const ring = new Int32Array(24); let ringAt = 0;
  const POOL_ID = {}; { let i = 1; for (const k in VOX_C) POOL_ID[k] = i++; }
  const seen = k => { for (let i = 0; i < ring.length; i++) if (ring[i] === k) return true; return false; };
  const remember = k => { ring[ringAt++ % ring.length] = k; };
  const fmtN = v => !isFinite(v) || v <= 0 ? ''
    : v < 1000 ? String(Math.round(v))
      : v < 1e6 ? (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k' : (v / 1e6).toFixed(1) + 'M';
  function slotVal(k, now, ctx) {
    const p = lastSaid, nb = freshB(now);
    switch (k) {
      case 'town': return (ctx && ctx.townName) || '';
      case 'who': return p ? p.first : '';
      case 'friend': { const f = p && folk[p.friend]; return f && f !== p ? f.first : ''; }
      case 'job': return p ? p.job : '';
      // THE TRADE PREMISES, NOT `workLabel`. A workplace is picked off a real
      // building and its label is a BUILDING TYPE ('Cottage', 'House') — "Off to
      // Cottage" is not a sentence. `premises` is the trade's own word for where
      // the trade happens ('forge', 'bakehouse', 'quay') and always reads.
      case 'place': return p && p.premises ? 'the ' + p.premises : '';
      case 'quarter': return (p && p.homed && p.quarter) || '';
      // …and likewise the roster's own lowercase house kind rather than the
      // building's capitalised label, for the same reason.
      case 'home': return (p && p.homeKind) || '';
      case 'homeN': return p && p.homed && p.homeN > 0 ? String(p.homeN) : '';
      case 'n': { const v = (ctx && ctx.buildingCount) | 0; return v > 3 ? String(v) : ''; }
      case 'folkN': return npcs.length > 5 ? String(npcs.length) : '';
      case 'sky': return (ctx && ctx.wx && ctx.wx.label) || '';
      case 'tokens': return fmtN(ctx && ctx.totalTok);
      case 'new': return nb ? 'the ' + nb.label : '';
      case 'New': return nb ? 'The ' + nb.label : '';
      case 'newN': return nb && nb.n > 0 ? String(nb.n) : '';
      case 'newCount': return newCount > 1 ? String(newCount) : '';
      case 'notable': return notableB.length ? 'the ' + notableB[Math.floor(rnd() * notableB.length)] : '';
      default: return '';
    }
  }
  /** One pool, one line: the first candidate whose slots are ALL fillable and
   *  which is not in the ring. Bounded — a pool whose facts have all gone dark
   *  simply returns '' and the weighting tries the next one. */
  function render(cat, now, ctx) {
    const c = VOX_C[cat]; if (!c || !c.length) return '';
    const id = POOL_ID[cat] * 1024, start = Math.floor(rnd() * c.length);
    let spare = '';
    for (let k = 0; k < c.length; k++) {
      const i = (start + k) % c.length, L = c[i];
      let ok = true;
      for (let j = 0; j < L.s.length; j++) if (!slotVal(L.s[j], now, ctx)) { ok = false; break; }
      if (!ok) continue;
      const out = L.t.replace(VOX_SLOT, (_, s) => slotVal(s, now, ctx));
      if (seen(id + i)) { if (!spare) spare = out; continue; }
      remember(id + i); return out;
    }
    return spare;                      // every usable line is recent: repeat rather than fall silent
  }
  /* The mix. A weight of 0 means the facts for that pool do not exist right now,
     which is how a five-building hamlet with no landmarks and no weather still
     gets a coherent street voice instead of a hole. */
  const MIX = [];
  function speechLine(now, ctx) {
    if (dead) return '';
    const st = lastState, night = clamp((ctx && ctx.night) || 0, 0, 1);
    const nb = freshB(now), pace = (ctx && ctx.paceRatio) || 1;
    MIX.length = 0;
    const add = (cat, w) => { if (w > 0) MIX.push(cat, w); };
    add('NEWB', nb ? (nb.grand ? 34 : 22) : 0);
    add('FEST', now - festAt < FEST_MS ? 20 : 0);
    add('CHEER', st === 'cheer' ? 40 : 0);
    add('WORSHIP', st === 'worship' ? 44 : 0);
    add('BRIDGE', st === 'bridge' ? 46 : 0);
    add('NIGHT', st === 'home' ? 44 : night > .55 ? 14 : 0);
    if (st !== 'cheer' && st !== 'worship' && st !== 'bridge' && st !== 'home') {
      const id = (ctx && ctx.wx && ctx.wx.id) || '';
      const wet = /rain|drizzle|downpour|storm|thunder/.test(id);
      const snow = /snow|flurry|blizzard/.test(id);
      const soft = /mist|haze|overcast|gather/.test(id);
      // The daylight pools thin out after dark — the market is shut and nobody
      // is remarking on the drying weather at eleven at night — but they do not
      // close, because someone walking home still has a day to be pleased about.
      const dayK = night > .55 ? .3 : 1;
      add('WX', wet || snow || soft ? 0 : 9 * dayK);
      add('WX_WET', wet ? 11 * dayK : 0);
      add('WX_SNOW', snow ? 11 * dayK : 0);
      add('WX_SOFT', soft ? 10 * dayK : 0);
      add('MARKET', (pace > 1.15 ? 14 : 9) * dayK);
      add('GROW', (ctx && ctx.buildingCount > 8) ? 10 : 0);
      add('PERSON', lastSaid ? 12 : 0);
      add('STREET', 14);
    }
    let tot = 0;
    for (let i = 1; i < MIX.length; i += 2) tot += MIX[i];
    if (tot <= 0) return render('STREET', now, ctx);
    // Two draws: a pool whose every line is unusable right now yields to the
    // street, which is the one pool that can always answer.
    for (let a = 0; a < 2; a++) {
      let r = rnd() * tot;
      for (let i = 0; i < MIX.length; i += 2) {
        r -= MIX[i + 1];
        if (r <= 0) { const s = render(MIX[i], now, ctx); if (s) return s; break; }
      }
    }
    return render('STREET', now, ctx);
  }

  /* ═══ the cast ═════════════════════════════════════════════════
     news.js hands us a scratch item and asks for people. Every slot it can print
     is filled from ONE coherent pick — the same person's job, premises, house and
     quarter — because a line that mixes two villagers' facts is a line that lies.
     Blank in, blank out: with no roster nothing is written and news.js's
     unusable() gate drops the line, so the ticker degrades byte-for-byte to v3. */
  const CAST_KEYS = ['who', 'who2', 'job', 'place', 'home', 'quarter', 'fortune', 'rel'];
  function castSubject(kind) {
    if (kind === 'fortune') return folk[heroId] || null;
    // prefer someone actually out on the street: the point of naming them is that
    // the user can go and find them
    let outN = 0, outP = null;
    for (const p of folk) if (p.live && p.id !== 0 && p.homed && rnd() * ++outN < 1) outP = p;
    if (outP) return outP;
    return folk.length > 1 ? folk[1 + Math.floor(rnd() * (folk.length - 1))] : null;
  }
  function cast(kind, out) {
    if (dead || !out || !folk.length) return false;
    for (const k of CAST_KEYS) out[k] = '';
    const p = castSubject(kind === 'fortune' ? 'fortune' : 'gossip');
    if (!p) return false;
    let o = folk[p.friend] || folk[p.rival] || null;
    if (!o || o === p) o = folk[(p.id + 1) % folk.length];
    out.who = p.name;
    out.who2 = o && o !== p ? o.name : '';
    out.job = p.job;
    out.place = p.place;
    out.home = p.homeKind;
    out.quarter = p.quarter || '';
    out.fortune = p.fortune;
    out.rel = p.rel;
    // A quarter is only true once they have a door in it.
    if (!p.homed) out.quarter = '';
    return !!out.who;
  }

  /* ── public surface ───────────────────────────────────────────── */
  const api = {
    get count() { return npcs.length; },
    // last frame's census, not a fresh walk of the crowd: town.js reads this on
    // its own tick and at four figures of villager that was a pass nobody needed
    get worshippers() { return worshipN; },
    setPopulation(target) { desired = clamp(Math.round(target) || 0, 0, MAX); },
    setBuildingCount(b) { desired = clamp(popForBuildings(b), 0, MAX); },
    update,
    // The token counter ticked up: the congregation bows as one.
    pulse() { pulseAt = clock(); },
    /**
     * Sample a villager to speak — and decide whether anyone should speak at all.
     * TWO GATES, both new, both here rather than at the call site because this is
     * the one funnel every bubble in the app passes through:
     *   · PROXIMITY. Silence unless the crowd is big enough on screen to read a
     *     remark off (SPEAK_PX_IN/OUT, on lod.js's own `px`). Pulled back over
     *     the whole town, the streets are quiet — which is what a town looks
     *     like from a hill.
     *   · CADENCE. One remark every 6–13 s, not one every turn town.js offers.
     *     `want === 'cheer'` is exempt and opens a 150 ms window for the caller's
     *     immediate `pickSpeaker(null)` fallback, because those two calls are one
     *     event — a building finishing, a milestone — and an event does not queue.
     * The Crier is untouched by either: he is a separate channel (`crier()`), he
     * is the news, and he is walked into frame on purpose.
     * Then: a reservoir over those who have not spoken lately, falling back to a
     * reservoir over everyone, so a quiet town still finds a mouth.
     * @param {?string} want 'stroll'|'worship'|'cheer'|'home'|'bridge'|'work'|null (any)
     * @param {THREE.Vector3} out filled IN PLACE with the head-top world position
     * @returns {?string} the villager's state, or null if nobody matched
     */
    pickSpeaker(want, out) {
      if (dead || !speakNear) return null;
      const now = clock();
      const evt = want === 'cheer' || now < sayOpen;
      if (want === 'cheer') sayOpen = now + 150;
      if (!evt && now - sayAt < sayGap) return null;
      let fresh = null, nf = 0, any = null, na = 0;
      for (const n of npcs) {
        if (n.dying > 0 || now - n.bornAt < 400) continue;
        if (n.state === 'crier' || n.state === 'toCrier') continue;   // he has a line already
        if (want && n.state !== want) continue;
        if (now - n.spokeAt > SAY_MUTE_MS) { if (rnd() * ++nf < 1) fresh = n; }
        else if (rnd() * ++na < 1) any = n;
      }
      const n = fresh || any;
      if (!n) return null;
      n.spokeAt = now;
      // Only a GRANTED pick spends the turn — three refused tries in one turn
      // must not push the next remark thirteen seconds out.
      if (!evt) { sayAt = now; sayGap = SAY_GAP_MIN + rnd() * SAY_GAP_VAR; }
      // …and remember who it was, so speechLine() writes for this mouth.
      lastSaid = folk[n.seed] || null; lastState = n.state;
      if (out) out.set(n.x, n.y + headY(n), n.z);
      return n.state;
    },
    /**
     * The line the villager pickSpeaker() just handed out should say, or '' when
     * the town has nothing true to offer — in which case the caller passes no
     * `text` and news.js falls back to its own pool exactly as before. Call it
     * immediately after pickSpeaker(); it reads that speaker's own name, trade,
     * house and quarter, so the two calls are a pair.
     * @returns {string}
     */
    speechLine() { return dead ? '' : speechLine(clock(), ctxRef); },
    // A new building or a milestone: everyone nearby cheers, a few sprint over,
    // and the shrine fills up for the next few seconds.
    celebrate(p, opts) {
      if (dead || !p) return;
      opts = opts || {};
      const now = clock();
      // WHAT THEY ARE CHEERING, in words. The scan already knows every building
      // that landed in the last minute and where it stands; a celebration at the
      // same spot names it, so the remark the cheer produces is "The Bell Tower!
      // I watched the roof go on from right here" rather than a generic hooray.
      // A milestone (no site of its own) instead opens the festival pool.
      if (opts.milestone) festAt = now;
      else for (let i = 0; i < recentB.length; i++) {
        const b = recentB[i];
        if (Math.hypot(b.x - p.x, b.z - p.z) > 10) continue;
        b.at = now;                                   // freshen: this is the moment
        if (i > 0) { recentB.splice(i, 1); recentB.unshift(b); }
        break;
      }
      const R = opts.cheerRadius || 18, want = opts.runners == null ? 3 : opts.runners;
      let ran = 0;
      for (const n of npcs) {
        // `toShrine` is spared too: a pilgrim already walking to their seat should
        // not be yanked out of it because a house popped in nearby. So is `bridge`
        // — the one villager unmoved by the news is the whole joke. And the Crier
        // mid-announcement is the one villager who cannot be interrupted.
        if (n.state === 'home' || n.state === 'worship' || n.state === 'toShrine'
          || n.state === 'bridge' || locked(n)) continue;
        const d = Math.hypot(n.x - p.x, n.z - p.z);
        if (d < R) {                                     // ripple outward from the site
          n.state = 'cheer'; n.cheerFrom = now + d * 18;
          n.until = n.cheerFrom + 2000 + srand(n.rs + d) * 1400;
        } else if (ran < want && d < 60 && n.state === 'stroll') {
          n.state = 'run'; routeTo(n, p.x, p.z); ran++;
        }
      }
      spikeUntil = now + (opts.milestone ? 20000 : 9000);
      // The pilgrimage. Picking converts at random means they are still walking in
      // from the fringe when the spike ends, so nothing visible happens: draft the
      // onlookers CLOSEST to the altar instead and they arrive while it still counts.
      let have = 0;
      for (const n of npcs) if (n.state === 'worship' || n.state === 'toShrine') have++;
      let seats = Math.min(42, Math.round(npcs.length * .42)) - have;
      if (seats <= 0) return;
      pilg.length = 0;
      for (const n of npcs) if ((n.state === 'cheer' || n.state === 'stroll') && !n.pilgrim && !locked(n)) pilg.push(n);
      for (const n of pilg) n.pr2 = (n.x - MON.x) * (n.x - MON.x) + (n.z - MON.z) * (n.z - MON.z);
      pilg.sort(byNearestPlaza);
      for (let i = 0; i < pilg.length && seats > 0; i++) { pilg[i].pilgrim = true; seats--; }
    },

    /* ── v4 · the roster ─────────────────────────────────────────
       Every one of these answers safely before the roster exists: an empty town
       returns 0, null, '' or false, and no caller has to know why. */
    rosterSize() { return folk.length; },
    /** @param {number} id @returns {?VillagerView} */
    personAt(id) { return view(pAt(id)); },
    /** A resident's name for news.js's {name}. '' ⇒ it falls back to its own FOLK. */
    randomName() {
      if (!folk.length) return '';
      // reservoir over the people actually out on the street — one pass, and no
      // 1400-entry throwaway array every time the ticker wants a name
      let pick = -1, k = 0;
      for (const n of npcs) if (n.seed !== 0 && rnd() * ++k < 1) pick = n.seed;
      if (pick < 0) pick = 1 + Math.floor(rnd() * Math.max(1, folk.length - 1));
      const p = folk[pick];
      return p ? p.name : '';
    },
    /** @returns {?VillagerView} the one villager whose fortune tracks the town's pace */
    protagonist() { return heroId >= 0 ? view(folk[heroId]) : null; },
    cast,

    /* ── v4 · the Crier ──────────────────────────────────────────
       town.js: `if (!npcs.crierSpeaking()) npcs.announce(news.headline().plain)`,
       then each frame `const c = npcs.crier(); if (c && c.ready) news.say(v.set(c.x,c.y,c.z),
       'crier', { text: c.text, who: c.name })`. `y` is the head top — the bubble's tether. */
    crier() {
      if (dead || !crierState || !folk.length) return null;
      const p = folk[0], n = p.live;
      if (!n) return null;
      return { x: n.x, y: n.y + headY(n), z: n.z, name: p.name, text: crierText, ready: crierState === 2 };
    },
    announce,
    crierSpeaking() { return crierState > 0; },

    /* ── v4 · picking and following ──────────────────────────────── */
    /** Ray targets for a caller that would rather use three's own raycaster. The
     *  closed-form `raycast()` below is cheaper and is what interact.js calls. */
    hitMeshes() { return [IM.body, IM.head, IM.disc, IM.bodyF, IM.headF]; },
    /** An instance id is an index into ONE of the two wardrobes now, never into
     *  the crowd: which mesh reported the hit is what says which list to read.
     *  @param {THREE.Object3D} obj @param {number} instanceId @returns {?VillagerView} */
    villagerAt(obj, instanceId) {
      if (dead || !obj || instanceId == null) return null;
      let i = instanceId | 0, n = null;
      if (obj === IM.bodyF || obj === IM.headF) n = farL[i];
      else {
        if (obj === IM.arm) i = (i / LIMBS) | 0;
        else if (obj !== IM.body && obj !== IM.head && obj !== IM.disc && obj !== IM.hat) return null;
        n = nearL[i];
      }
      return n ? view(folk[n.seed]) : null;
    },
    /**
     * Ray/sphere tests, closed form — no matrix inverse, no InstancedMesh
     * raycast, no allocation. The sphere is fattened by a little under half a
     * degree so a 4 px villager is still catchable, but never enough to steal a
     * hover from the building they are standing in front of (nearer wins).
     * Linear in the crowd, which at four figures is ~1400 dot products and still
     * an order under what three's own instanced raycast would cost.
     * @param {THREE.Ray} ray @returns {?{handle:number, dist:number}}
     */
    raycast(ray) {
      if (dead || !ray || !ray.origin || !ray.direction || !npcs.length) return null;
      const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
      const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
      let bestT = Infinity, best = null;
      for (const n of npcs) {
        if (n.dying > .35) continue;
        const s = n.sEff || n.scale;
        const ex = n.x - ox, ey = n.y + .33 * s - oy, ez = n.z - oz;
        const tca = ex * dx + ey * dy + ez * dz;
        if (tca <= 0) continue;
        const r = .42 * s + Math.min(.5, tca * .006);
        const d2 = ex * ex + ey * ey + ez * ez - tca * tca;
        const r2 = r * r;
        if (d2 > r2) continue;
        const t = tca - Math.sqrt(r2 - d2);
        if (t < bestT) { bestT = t; best = n; }
      }
      return best ? { handle: best.seed, dist: Math.max(0, bestT) } : null;
    },
    /**
     * Where a handle is right now. `alive:false` (or null) is camera.js's cue to
     * hand the camera back — they have gone in for the night.
     * @param {number} handle
     * @returns {?{x,y,z,yaw,state,hTop,alive,name}}  y is the SURFACE under their
     *   feet (0 in the street, ~1.05 on a bridge deck); hTop is above that
     */
    track(handle) {
      const p = pAt(handle);
      if (!p) return null;
      const n = p.live;
      if (!n || n.dying > .6) return { x: 0, y: 0, z: 0, yaw: 0, state: '', hTop: 0, alive: false, name: p.name };
      // `y` is the surface under their feet — 0 in the street, the deck on a
      // bridge — and `hTop` stays a height ABOVE it, which is the contract
      // camera.js's follow (`t.y + 1.15`) and its dist-by-hTop test both read.
      return { x: n.x, y: n.y, z: n.z, yaw: n.yaw, state: n.state, hTop: headY(n), alive: true, name: p.name };
    },
    /** @param {{x:number,z:number}} p @param {number} [r] @returns {?number} handle */
    nearest(p, r) {
      if (dead || !p || !npcs.length) return null;
      const R = r == null ? 1e9 : r;
      let bd = R * R, best = null;
      for (const n of npcs) {
        if (n.dying > .35) continue;
        const d = (n.x - p.x) ** 2 + (n.z - (p.z == null ? 0 : p.z)) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
      return best ? best.seed : null;
    },
    /** Hold a villager in the world while the camera is on them: they are never
     *  sent home by a dusk cull and never reassigned. `pin(null)` releases. */
    pin(handle) {
      if (dead) return false;
      if (handle == null) { pinned = -1; return true; }
      const p = pAt(handle);
      if (!p) return false;
      pinned = p.id;
      if (!p.live) return !!spawn(clock(), p.id);
      return true;
    },
    /**
     * THERE IS SOMEONE STANDING THERE. Mark a world spot as occupied by the
     * viewer and the crowd will bear off around it and glance at it on the way
     * past; villagers within `r` are pushed out to `r`, softly, over about a
     * fifth of a second, and the push decays the moment it is cleared.
     *
     * It is a personal space, NOT a collision: nobody stops, nobody re-plans a
     * route, and a villager cornered against a wall will still pass through the
     * spot rather than stand in the road looking stupid. Idempotent and safe to
     * call every frame; call `clearViewer()` when the camera leaves the street.
     *
     * town.js, immediately before `npcs.update(dt, now, ctx)`:
     *   if (rig.mode === 'stroll') npcs.setViewer(camera.position.x, camera.position.z);
     *   else npcs.clearViewer();
     *
     * @param {number} x @param {number} z
     * @param {number} [r] personal-space radius in world units; default 1.2
     */
    setViewer(x, z, r) {
      if (dead || !isFinite(x) || !isFinite(z)) return;
      viewOn = true; viewX = x; viewZ = z;
      viewR = clamp(isFinite(r) && r > 0 ? r : VIEW_R_DEF, .35, 4);
      viewR2 = viewR * viewR;
    },
    /** Nobody is standing in the lane any more. The offsets everyone is holding
     *  relax on their own tau — this does not snap anybody back. */
    clearViewer() { viewOn = false; },
    /** Lightning, thunder, a very large number: the whole town looks up. */
    startle() { startleAt = clock(); },
    /** Consuming: the protagonist's band changed. @returns {?Object} */
    heroEvent() { return evH.length ? evH.shift() : null; },
    /** Consuming: a named resident took premises in the town. @returns {?Object} */
    marketEvent() { return evM.length ? evM.shift() : null; },
    /** lod.js decides the threshold; we decide what to drop. Far ⇒ the whole
     *  crowd wears the far wardrobe (no hats, no arms, no contact discs, a fifth
     *  of the triangles) and every time-slice interval is multiplied by `stride`,
     *  because at 3.5 px nobody can see 60 Hz steering. */
    setTier(t) {
      tierFar = !!(t && t.far);
      tierStride = Math.max(1, Math.min(4, (t && t.stride) | 0 || 1));
      // HELD BY REFERENCE, not copied. lod.js rewrites this record's `px` every
      // frame and only CALLS us on a far/near flip, so keeping the object is how
      // the speech gate reads lod's live screen-size decision instead of taking a
      // second opinion off the camera. Safe to hand over at wiring time too:
      // `npcs.setTier(lod.npcTier())` once after init is all it takes to retire
      // the fallback arithmetic in speakPx() entirely.
      if (t && typeof t.px === 'number') tierObj = t;
    },
    stats() {
      let homed = 0, jobbed = 0;
      for (const p of folk) { if (p.homed) homed++; if (p.jobbed) jobbed++; }
      return {
        roster: folk.length, live: npcs.length, desired, homed, jobbed,
        households: HH.size, hero: heroId, band: heroId >= 0 ? folk[heroId].band : -1,
        crier: crierState, far: tierFar, stride: tierStride,
        // v9 · the speech gate, for the acceptance harness: whether the crowd is
        // close enough to be heard, and what it has left to talk about
        speakNear, speakPx: Math.round(speakPx(clock(), ctxRef) * 10) / 10,
        newB: recentB.length, notable: notableB.length,
        near: nearL.length, farN: farL.length, nearR: Math.round(nearR),
        // v8 · how many pairs the last neighbour pass had to hold apart — the
        // one number that says whether the crowd is walking through itself
        sep: sepPairs,
        // v7 · the scale and what the crowd is doing in it, so the speed audit
        // can be checked from outside this file instead of taken on trust
        mPerUnit: U_M, walkMs: Math.round((WALK_MIN + WALK_VAR * .5) * U_M * 100) / 100,
        runMs: Math.round((WALK_MIN + WALK_VAR * .5) * GEAR_RUN * U_M * 100) / 100,
        draws: (nearL.length ? 5 : 0) + (farL.length ? 2 : 0) + (crierState === 2 ? 1 : 0)
      };
    },
    /** Epoch teardown. Keeps every GPU resource; forgets every person — but keeps
     *  their SHELLS, because the leak bench does this twenty times in thirty
     *  seconds and 1400 fresh person objects a cycle is a heap graph with a slope
     *  on it. `folkPool` is invisible to every caller: rosterSize() is 0 here. */
    reset() {
      for (let i = npcs.length - 1; i >= 0; i--) despawn(i);
      npcs.length = 0; nearL.length = 0; farL.length = 0;
      slotUsed.fill(false); desired = 0;
      while (folk.length) { const p = folk.pop(); p.live = null; folkPool.push(p); }
      HH.clear(); taken.clear();
      rosterSeed = -1; heroId = -1; homeCursor = 0; homeScan = 0; seatScan = 0; unhomed = 0;
      crierState = 0; crierText = ''; crierEnd = 0; pinned = -1;
      evH.length = 0; evM.length = 0; carriers.length = 0;
      nearR = NEAR_R_MAX; nearRAt = -1e9; worshipN = 0; shrinkAt = -1e9; wallAt = 0;
      viewOn = false; viewX = 0; viewZ = 0; viewR = VIEW_R_DEF; viewR2 = 0;
      // …and nobody is holding room for anybody: `sepF` moves on, which expires
      // every target the last pass wrote without walking the crowd to do it
      sepL.length = 0; sepF++; sepAt = -1e9; sepRun = false; sepR2 = 0; sepPairs = 0;
      heroEma = 1; heroAt = 0; heroBandAt = -1e9; startleAt = -1e9; spikeUntil = 0;
      // The voices forget the previous epoch's town completely — its buildings
      // are gone, so a villager naming one would be naming a memory. `bSeenLen`
      // back to -1 re-arms the silent seed, so the new founding cascade is not
      // announced roof by roof either.
      recentB.length = 0; notableB.length = 0; lmSeen.clear();
      bScanAt = -1e9; bSeenN = -1; bSeenLen = -1; newCount = 0; newCountAt = 0;
      festAt = -1e9; lastSaid = null; lastState = '';
      sayAt = -1e9; sayGap = SAY_GAP_MIN; sayOpen = -1e9; ring.fill(0); ringAt = 0;
      speakNear = false; nearestD2 = 1e18;
      for (const k in IM) { IM[k].count = 0; IM[k].visible = k !== 'bell'; }
      IM.bell.visible = false;
      for (const L of lampLights) L.intensity = 0;
    },
    dispose() {
      dead = true; viewOn = false;
      for (const k in IM) { scene.remove(IM[k]); IM[k].dispose(); }
      for (const k in G) G[k].dispose();
      for (const k in M) M[k].dispose();
      for (const L of lampLights) { L.intensity = 0; scene.remove(L); }
      npcs.length = 0; nearL.length = 0; farL.length = 0;
      folk.length = 0; folkPool.length = 0; legPool.length = 0;
      HH.clear(); taken.clear(); deckOf.clear(); deckList.length = 0;
      slotUsed.fill(false); desired = 0;
    }
  };
  mintRoster();
  // the roster census, for --bench and the acceptance harnesses
  if (typeof window !== 'undefined') window.__npcStats = api.stats;
  return api;
}
