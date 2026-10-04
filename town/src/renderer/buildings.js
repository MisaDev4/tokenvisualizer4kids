// Token Town — construction library. Everything the town is made of is built
// here; town.js owns placement, growth and animation but never geometry.
//
// Two rules hold the 300-building / 60 fps budget, both invisible from outside:
//   1. materials come from a quantised cache (matFor) — a whole town lives on
//      ~60-80 materials instead of ~1600;
//   2. every finished group melts its static meshes into one vertex-coloured
//      buffer, so a house is ~2 draw calls (body + lit windows) instead of 8.
// Neither is load-bearing for correctness: the public contract is identical
// with or without them.
//
// ── WHERE A DWELLING'S DETAIL BUDGET GOES ──────────────────────────────────
// There is no triangle budget: the `z1200` bench sits against a hard 420 k, so
// every detail added here is PAID FOR by detail removed. The trade, measured:
//   SPENT   6 000 window boxes and 1 000 door boxes became BOARDS (`board`),
//           two triangles apiece instead of twelve, of which twenty faces per
//           window were buried in a wall — worth about 120 k triangles;
//           the top house tiers lost their battlements (see buildHouse), the
//           counting-house lost its 216-triangle dome, and `ball` picks a
//           7×5 sphere for anything under 0.7 units.
//   BOUGHT  roofs, which AESTHETIC.md says carry the most detail budget and
//           were carrying none: plastered gable ends (`GEO.gend`), a real
//           hipped roof with a ridge instead of a 45°-turned cone (`GEO.hip`),
//           ridge tiles, a deep eave course on thatch, and a pitch that varies
//           per house. Plus a stone plinth, chimney caps and pots, and oak
//           framing on the older streets — all measured off the mass that was
//           just built (`mainMass`) rather than repeated at twenty call sites.
//   FREE    weathering. Per-house lichen and soot lerps in `paintHouse`, and
//           ONE shared greyscale map (`fabricTex`) that every merged building
//           wears, projected triplanar by UVs baked in `concatMeshes`.
// Net at z1200: 1226 → 889 draw calls, 418 k → 371 k triangles.
//
// THE SECOND PASS spent 25 k of the 49 k that left (371 k → 396 k at z1200, gate
// 420 k, draws 889 → 897) on the two things the first one wrote down and banked:
//   MASSING Tiers 5 and 6 are 625 of 977 dwellings and both were the same object
//           — ground storey, identical upper storey, string course. Each now has
//           FIVE plans (`v5`/`v6`) built from a shared kit: `storeys` (which
//           jetties the upper floor, free), `crossWing`, `catslide`, `porch`,
//           `dormer`, `breast`, `bay`. Every plan redistributes the footprint
//           instead of inflating it — the envelopes are within 4 % of the boxes
//           they replace, so `impostorOf` measures the same silhouette and the
//           far town is unchanged.
//   WINDOWS `addPane` — a limewashed reveal, glass, a mullion (and on the
//           wealthier houses a transom), a stone sill, and sometimes shutters.
//           Four triangles became ten. The façade GRID was rebuilt too: it now
//           fits the wall rather than marching a fixed stride, and the door moves
//           off centre, which is what a real cottage does and what stops the
//           door-clearance rule deleting every opening on a narrow front. And
//           the two GABLE ENDS are glazed, because at 1.35 units a lane is two
//           rows of flanks and every flank in the town was blank plaster.
//   PAID BY the ridge, which was a 12-triangle box with its underside and both
//           ends bedded in the slopes it caps and is now the 8-triangle prism
//           this file already owned (`ridge`) — about 1.4 per house.
//
// THE THIRD PASS took the two items the second one wrote down and left, on a
// budget of 10 k at z1200 (406 k against a 420 k gate). It spent 6 k:
//   TIERS 3 & 4 had never had plans built from the massing kit — they were still
//           one prism, one roof and one chimney, and they are what the town is
//           made of below the wealthy core (at 133 M tokens they are three
//           dwellings in four). Five plans each now, from the SAME kit, kept
//           humbler than the tiers above it: a catslide back kitchen, a lean-to
//           against the flank with the stack behind it, an enclosed porch that
//           takes the front door out with it, a dormer, a cross-wing that is
//           glazed instead of being a barn. Same 3.0 × 2.6 and 3.2 × 2.8 ranges,
//           same wall-plates: the mass box is where it was and the far town has
//           not been told anything.
//   ROOF FURNITURE at eye level (`gableTrim`/`hipTrim`/`ridgeCrest`, and the note
//           above them): barge boards on the gable verges, a fascia along every
//           eave, and a course of clay crest tiles on the main ridge of a tiled
//           house grand enough to have bought them. A verge was a sawn prism edge
//           and an eave was the same edge; from the stroll camera those are the
//           two lines you spend the most time looking at. ~19 triangles a house.
//   LEADED LIGHTS on the poor and old houses — `winBars(2)`, three lights by four
//           courses in cames half a mullion's width. It wants to be a texture and
//           it cannot be one: see the note on `winBars`. Charged only where a
//           cross window is not, which is tiers 2-3, which is nothing at all at
//           z1200 and 2 k on a scene with 59 k of headroom.
//   PAID BY the façade grid drawing TWO PANES IN ONE HOLE — `i % cols` comes round
//           two and three times on the seven- and eight-bay plans and the storey
//           and side rolls repeat with it, so 1.1 openings on a villa and 1.5 on a
//           manor were ten triangles drawn inside another ten and z-fighting
//           against them. `addWindows` keys the slot now. ~11 triangles a house.
//
// THE FOURTH PASS was asked for four measured items and for the total to go DOWN,
// from 412 k at z1200 against a 420 k gate. It finished at 404 k, and all of the
// margin came from ONE observation the four passes above had all walked past:
//   BURIED  a box on the ground never shows its floor, and a box with a string
//   FACES   course, a coping or a chimney cap on it never shows its lid. That is
//           2 or 4 triangles of every twelve, on about a dozen boxes a dwelling.
//           `GEO.ubox`/`GEO.utube` and `mb`'s `open` flag; `GEO.ridgeP` is the
//           same cut on the gable prism a ridge is made of, and `GEO.pyr` and
//           `GEO.crop` lost the base caps of cones that are always planted in
//           something. The argument that this does not cost a shadow — which it
//           very nearly did — is written out over `openBox`, and it is the whole
//           reason the saving is real at z1200, where every triangle is charged
//           twice because the shadow map is a second pass over the same geometry.
//   SPENT   the façade grid RELOCATES an opening that cannot have the slot it drew
//           instead of dropping it (the third pass keyed the slot and left the
//           elevation blank); a thatched GABLE finally gets the deep eave course
//           `hipRoofAt` has always given a thatched hip, so reed stops being tile
//           in a different colour on the 7 % of roofs that are gabled thatch; and
//           the guildhall's front door stopped being a 12-triangle slab.
//   FIXED   the tier-3 lean-to was 27 % of its own range's footprint, over
//           IMP_A_REL, so the far town drew that one plan as a 4.1-wide flat-
//           topped box under a 3.3 roof, centred on the plot rather than on the
//           outshut. A shallower wash-house puts it back under the threshold.
//           And the town house's attic floated 5 cm above the jetty it stands on.
//   MEASURED, because the brief predicted a wash and it was not one: relocating
//           every displaced opening puts ~1.9 more panes on a villa and ~2.1 on a
//           manor than the third pass drew, which is 13 triangles a house, not
//           zero. The counts that used to over-subscribe the grid are one lower
//           now (7→6, 8→7) — every bay the grid lays out is still glazed, and
//           there are still more openings than before the relocation.
//
// THE FIFTH PASS was a quality sweep's defect list rather than a look-dev brief,
// and four of its five items turned out to be THE SAME BUG: geometry authored
// where nothing could see it. Written down because it is clearly this file's
// characteristic failure, and none of the four looked like each other:
//   SEALED  `cyl` and `mb` make CLOSED solids. The village well's water sat at
//   INSIDE  y .55 inside a drum running 0–.74 and its bucket hung 75 cm below a
//           beam 1.55 up, so both were entombed in the masonry — a well with no
//           water and no bucket. Its trough's water was 6 cm PROUD of the rim and
//           visible; "correcting" it to sit inside put it under the trough's own
//           lid, which is how the same trap catches you twice in one object. The
//           mouth is a `ground` plate laid OVER the coping now (free: `apron`
//           already opened that bucket), the flavour well's shaft is one short
//           cylinder standing proud of the kerb (no new bucket at all), and both
//           troughs are brim-full on purpose.
//   UNDER   Every part of a bridge except its parapet was drawn below the
//   WATER   waterline, and that is two numbers in two other files rather than
//           anything wrong here — see the note over `buildBridge`, which names
//           the one-line hook. The half of a crossing that was never in the water
//           is what carries it meanwhile: abutments with splayed wing walls,
//           corner piers, a kerb course, and cutwaters carried up into refuges.
//   INSIDE  A woodpile was centred on the PLOT's half-width, and a plot is barely
//   A WALL  wider than the dwelling on it: 55 % of every 1.08-long log was inside
//           the wall at tiers 3 and up, and what showed was log ends projecting
//           out of the plaster with nothing under them. It measures off
//           `mainMass` now, so it stands clear of whatever plan was drawn — and
//           `GEO.log` (a 5-sided prism, 16 triangles) makes a five-log stack
//           cheaper than the four cylinders that were floating.
//   AND ONE THAT WAS NOT geometry at all: three of the ten roof FAMILIES were
//           dyes, not roofing, so twelve seeds in forty roofed the town magenta
//           and teal. All ten are materials now, and rule 0 in `buildPalette`
//           gives the dominant 46 % to an earth one on every seed there is; the
//           day's signature hue moved off the roofs onto its own paint table.
//           Also: the `windmill` house flavour is retired for a `stables`,
//           because `mill` is a LANDMARK and a village with four of them has
//           spent it (see the note over FLAVORS).
//   COST    z1200 404 k → 405 k triangles against a 420 k gate, 920 → 926 draws;
//           a dwelling is ~1 triangle CHEAPER and a flavour is 0.28 draw calls
//           cheaper. Eight scenes pass.
//
// ── THE VILLAGE TIER (idea T-21) ───────────────────────────────────────────
// A milestone must upgrade the PLACE without changing what kind of place it is:
//   0 hamlet · 1 village · 2 market village · 3 market town
// One module-level switch drives it, and everything built AFTER the switch is
// built in the new fabric. Standing buildings are not restyled — town.js already
// owns remounting, and a silent restyle of 1 200 groups is not something this
// file should decide to do. The wiring town.js codes against is four calls:
//
//   setVillageTier(t) -> VillageFabric   set 0..3 (clamped). Idempotent; returns
//                                        the fabric now in force. Call it BEFORE
//                                        a growth cascade, or remount to restyle.
//   villageTier()     -> number          the tier in force
//   villageFabric()   -> VillageFabric   the frozen descriptor (see the typedef)
//   villageTierFor(n) -> number          pure: building count -> tier, using
//                                        VILLAGE_TIER_AT. No side effects.
//
// `VillageFabric` also carries the two things this file cannot draw itself —
// `lane`/`laneColor` (roads are environs') and `stalls` (the square is town.js's)
// — so the whole upgrade reads off ONE object instead of five duplicated tables.
// What buildings.js does with the tier on its own: the thatch→clay-tile share of
// roofs, the boundary a plot gets (paling → hedge → hedge+wall → wall), how much
// yard clutter (woodpile, water butt, washing line, garden plot) and how many
// door lanterns and lit hearths a dwelling carries, and how dressed the market
// hall, the green and the inn yard are.
import * as THREE from './vendor/three.module.js';
// F4. One onBeforeCompile patch — rim, base AO, world-space grain, and the
// far-land colour match — applied to every lit material the town mints. It adds
// no draw call, no texture and no attribute (a merged building has no UVs at
// all, which is why this is a shader patch and not a texture), and it is
// idempotent. ORDER: anything that assigns onBeforeCompile AFTER it clobbers it.
import { applyTownSurface } from './surface.js';

/* ═══ small helpers ═════════════════════════════════════════════ */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const seededR = s => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const TAU = Math.PI * 2;
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };

/** Tier vocabulary. Index === tier. */
// 'Keep' is gone with the battlements it named (see buildHouse's top tier): a
// village's grandest dwelling is a merchant's house, not a castle. Eight entries,
// index === tier, still exported — town.js's footer and the floating callouts
// read this array and nothing persists it.
export const TIER_NAMES = Object.freeze(
  ['Tent', 'Shack', 'Cabin', 'Cottage', 'House', 'Villa', 'Manor', 'Merchant House']);

/** @param {number} color @param {object} [extra] @returns {THREE.MeshStandardMaterial} */
export function std(color, extra, role) {
  return applyTownSurface(new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .85 }, extra)), role);
}

/** Lighten (k>0) / darken (k<0) a hex colour. @returns {number} 0xRRGGBB */
export function shade(hex, k) {
  const c = new THREE.Color(hex), t = new THREE.Color(k < 0 ? 0x000000 : 0xffffff);
  return c.lerp(t, Math.abs(k)).getHex();
}
/** Blend two hex colours. @returns {number} 0xRRGGBB */
export const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();

/** Scale a colour down until its luminance is at most `maxL`, keeping its hue.
 *  A fixed darkening is the wrong tool for a surface whose problem is that it
 *  faces the sun: the same lerp that tames a near-white plaster crown crushes a
 *  day whose walls are already dark. This caps the albedo and leaves anything
 *  already below the cap alone. Works in linear space, which is where a
 *  brightness cap actually means something. @returns {number} 0xRRGGBB */
export function capLum(hex, maxL) {
  const c = new THREE.Color(hex);
  const l = Math.max(1e-4, c.r * .3 + c.g * .59 + c.b * .11);
  return c.multiplyScalar(Math.min(1, maxL / l)).getHex();
}

/* ═══ the day palette ═══════════════════════════════════════════
   A building's colour says nothing about which model spent the tokens — it says
   which DAY this is. One seeded palette per calendar day paints every roof,
   wall, timber and awning, so the town is recognisably repainted each morning
   and recognisably itself all day long.

   Three rules do all the work:
     1. three primaries + one accent, never two neighbouring hues, always at
        least one neutral — that is what makes a street read as a town rather
        than as a paint chart;
     2. one plaster "wash" per day, 12 % into every wall — the cheapest and
        strongest "somewhere else today" signal there is;
     3. the mix drifts with the band, so the core reads civic and old and the
        outskirts read rustic and thatched.
   Everything is integer-seeded and decided at spawn: zero per-frame cost, and
   roof shading stays quantised to 7 steps so matFor's cache stays ~80 entries.
   Nothing here is ever gold — gold is the altar's, and it means tokens. */

/** Civic material vocabulary — shared by landmarks and bridges. */
const GOLD = 0xD9AE4B, GOLD_HI = 0xF3D07A, STONE = 0xCEC3A8, STONE_D = 0x968C77, SLATE = 0x4E545E;

/* ── the village material vocabulary ─────────────────────────────
   The retired landmark set was built out of near-white civic limestone and gold,
   which is what made a nine-rung ladder read as a capital city. A real village is
   made of seven things and none of them is bright: fieldstone the colour of the
   ground it came out of, lime plaster gone grey under the eaves, oak weathered to
   silver-brown, thatch, clay tile, stone slate and soft red brick. Saturation is
   never the variation — weathering and moss are. */
const FIELD = 0x9C9585, FIELD_D = 0x77715F, FIELD_L = 0xB0A895;   // fieldstone rubble
const LIME = 0xDCD2BB, LIME_D = 0xBDB199;                         // limewashed plaster
const OAK = 0x6C5437, OAK_D = 0x4C3C27, OAK_S = 0x8A7A62;         // oak: fresh, tarred, silvered
const THATCH_L = 0xA89460, THATCH_D = 0x82703F;                   // reed, and its shadowed courses
const TILE = 0x9E5A44, TILE_D = 0x7A4636;                         // clay pantile
const SLATE_R = 0x5C6068, MOSS = 0x6B7A4E, BRICK = 0x96604A;
const IRON = 0x3E3B36, BRASS = 0xA8823C, EARTH = 0x6A6150, MUD = 0x554B3C;

/* ── village tiers ──────────────────────────────────────────────
   See the header. One switch, one frozen descriptor, no per-frame cost: every
   consumer reads the object, nothing recomputes it. */

/** Tier vocabulary. Index === tier. @type {readonly string[]} */
export const VILLAGE_TIER_NAMES = Object.freeze(['hamlet', 'village', 'market village', 'market town']);
/** Building counts at which each tier begins. `villageTierFor` reads this. */
export const VILLAGE_TIER_AT = Object.freeze([0, 45, 130, 320]);

/**
 * @typedef {Object} VillageFabric
 * @property {number} tier      0..3
 * @property {string} name      'hamlet' | 'village' | 'market village' | 'market town'
 * @property {'dirt'|'gravel'|'cobble'|'cobble'} lane   what the lanes are surfaced with
 * @property {number} laneColor 0xRRGGBB — the surface tint that goes with `lane`
 * @property {number} thatch    0..1 share of dwelling roofs still thatched
 * @property {'paling'|'hedge'|'wall'} boundary  what a plot is fenced with
 * @property {number} enclosed  0..1 share of plots that HAVE a boundary at all
 * @property {number} clutter   0..1 yard-clutter density (woodpile, butt, washing, plot)
 * @property {number} lantern   0..1 share of doors with a lantern beside them
 * @property {number} hearth    0..1 share of hearths alight (smoke)
 * @property {number} stalls    market stalls the square carries
 */
const FABRICS = [0, 1, 2, 3].map(t => Object.freeze({
  tier: t,
  name: VILLAGE_TIER_NAMES[t],
  lane: ['dirt', 'gravel', 'cobble', 'cobble'][t],
  laneColor: [0x6B5F49, 0x7C7360, 0x86827A, 0x8E8A80][t],
  thatch: [.82, .46, .22, .10][t],
  boundary: ['paling', 'hedge', 'hedge', 'wall'][t],
  enclosed: [.42, .62, .74, .86][t],
  clutter: [.30, .48, .62, .74][t],
  lantern: [.02, .12, .30, .52][t],
  hearth: [.45, .60, .74, .86][t],
  stalls: [0, 2, 5, 9][t]
}));
let VTIER = 1;                                    // 'village' — today's town, unchanged

/**
 * Set the tier the next buildings are built in. Idempotent; nothing standing is
 * restyled (see the header).
 * @param {number} t 0..3, clamped @returns {VillageFabric} the fabric now in force
 */
export function setVillageTier(t) { VTIER = clamp(Math.round(t) | 0, 0, 3); return FABRICS[VTIER]; }
/** @returns {number} 0..3 */
export function villageTier() { return VTIER; }
/** @returns {VillageFabric} frozen — read it, never mutate it */
export function villageFabric() { return FABRICS[VTIER]; }
/**
 * Pure: how many buildings make a hamlet a market town.
 * @param {number} buildings @returns {number} 0..3
 */
export function villageTierFor(buildings) {
  const n = buildings | 0;
  let t = 0; for (let i = 1; i < 4; i++) if (n >= VILLAGE_TIER_AT[i]) t = i;
  return t;
}

/* ── THE TEN ROOF FAMILIES ARE TEN MATERIALS, NOT TEN HUES ──────
   AESTHETIC.md: "Avoid saturated primaries… Variation comes from weathering and
   material, not from hue." Three of these families were not roofing at all —
   Seafoam 0x4F8A7A, Azure 0x3E6E8E and Plum 0x6B4A6B are dyes, and nothing has
   ever been roofed in them. The generator does not care what a family MEANS, so
   a seed that drew Plum first and Seafoam third roofed 46 % of the town magenta
   and 18 % of it teal: seeds 4, 10, 13, 14, 16, 18, 19, 20, 24, 33, 36 and 37
   were all villages with no earth in them, twelve days in forty.

   Every entry below is now something a roof is actually made of: two clay tiles
   and a buff pantile; Welsh slate, a tarred slate and a silvered one; the green
   stone slate of the north, a pale limestone slate, a blue-grey Burlington and
   the heather-purple Penrhyn. The purple and the green survive as SLATES —
   muted, low-chroma, and quarried — which is the honest version of the two
   families they replace.

   `earth` marks the warm, organic materials, and rule 0 in `buildPalette` gives
   the DOMINANT family (46 % of the roofs, before thatch is counted on top of it)
   to one of them on every seed there is. So the day still changes what the town
   is roofed in; it can no longer change what the town is roofed WITH.
   `name` is a UI asset: tooltips and the Gazette use it. */
const FAM = Object.freeze([
  { name: 'Terracotta', hex: 0xB4553C, rustic: .70, earth: true },   // clay pantile
  { name: 'Ochre', hex: 0x8E4A38, rustic: .90, earth: true },        // old tile, weathered
  { name: 'Saffron', hex: 0xBE8B4A, rustic: .45, earth: true },      // buff pantile
  { name: 'Slate', hex: 0x4E545E, rustic: .00, neutral: true },      // Welsh blue slate
  { name: 'Charcoal', hex: 0x3A3A38, rustic: .00, neutral: true },   // tarred slate
  { name: 'Moss', hex: 0x5B6B47, rustic: 1.0, earth: true },         // green slate, mossed
  { name: 'Limestone', hex: 0x9A9078, rustic: .55, earth: true, neutral: true },  // stone slate
  { name: 'Bluestone', hex: 0x53616E, rustic: .10, neutral: true },  // Burlington blue-grey
  { name: 'Heather', hex: 0x6B5A64, rustic: .05 },                   // heather-purple slate
  { name: 'Ashblue', hex: 0x6E7C86, rustic: .15, neutral: true }     // slate gone silver
]);
/* THE DAY'S SIGNATURE HUE IS NOT A ROOF. It used to be the fourth roof family,
   which is how a loud colour got onto 8 % of the roofs and how the hero number
   ended up wearing whatever the roofs happened to draw. These are PAINT and DYE
   — the awnings, the market crates, the pennants, the flowers by the door, and
   the token count on the dark chrome — so they are allowed the chroma a roof is
   not. Nothing here is ever gold: gold is the fountain's, and it means tokens. */
const ACCENTS = Object.freeze([
  0xC4522E, 0xD08A2A, 0xB0403C, 0x3D7E6B, 0x2F6C93,
  0x6D4A86, 0x7C8A32, 0xA33468, 0x2E7D46, 0xA96E2E
]);
const WASHES = Object.freeze([['chalk', 0xE9E2CE], ['sand', 0xD9C69C], ['lime', 0xDCE2CE],
['rose', 0xE4CFC4], ['quarry', 0xC9C6BC]]);
const PLASTERS = [0xE6DCC5, 0xCFC1A4, 0xDACAB1, 0xBCAC91, 0xCBC4B6, 0xAB9B83, 0xE2D6B9, 0xA19687];
const WOODS = [0x6B533A, 0x7A6446, 0x5A4530, 0x86704E];
const GRASSES = [0x8C9C5E, 0x7F9455, 0x96A468, 0x86985C];
const WATERS = [0x2F6F86, 0x35708F, 0x2B6B78, 0x3D7A93];
// the painted lady's licence: the one place saturation is allowed on a WALL
const LADY_WALLS = [0x9C5B7A, 0x4F7E86, 0xC08A3E, 0x6C6FA6, 0x3F7C5E, 0xB8574B];
const LADY_DOORS = [0x2F5D8C, 0x1F6B57, 0x8A2E3C, 0x2B3A6B];
const THATCH = 0x9E9068;                               // reed, greyer than straw: the tier
                                                      // makes this common, and at 0xB09A66 half a
                                                      // village came out gold.
const MAX_BAND = 9;                                   // plan.bandOf tops out around here

/* colour analysis in plain sRGB bytes — no THREE.Color round-trip, so the
   harmony rules mean the same thing whatever the renderer's working space is */
const R8 = h => (h >> 16) & 255, G8 = h => (h >> 8) & 255, B8 = h => h & 255;
const lumOf = h => (.2126 * R8(h) + .7152 * G8(h) + .0722 * B8(h)) / 255;
const chromaOf = h => (Math.max(R8(h), G8(h), B8(h)) - Math.min(R8(h), G8(h), B8(h))) / 255;
function hueOf(hex) {
  const r = R8(hex) / 255, g = G8(hex) / 255, b = B8(hex) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 1e-6) return 0;
  const h = mx === r ? (g - b) / d % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)) % 360; return d > 180 ? 360 - d : d; };
/** Pull a hue k of the way to its own-luminance grey — the "≥ 12 % grey" guardrail. */
const greyed = (hex, k) => { const l = Math.round(lumOf(hex) * 255); return mix(hex, (l << 16) | (l << 8) | l, k); };
const cssOf = hex => '#' + (hex >>> 0).toString(16).padStart(6, '0');

/** Deterministic 32-bit stream, for the once-per-day palette draw. */
const lcg = seed => { let s = (seed >>> 0) || 0x9E3779B9; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
/** Stable 0..1 hash of two integers — the per-plot picker. Pure integer maths. */
function h2(a, b) {
  let h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x165667B1, 0xC2B2AE35);
  h ^= h >>> 15; h = Math.imul(h, 0x2545F491); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * @typedef {Object} Palette
 * @property {number[]} roofs     the 4 chosen family hexes, [p0, p1, p2, accentFamily]
 * @property {string[]} roofNames the 4 family names
 * @property {number[]} walls     the 3 plaster bases after the wash
 * @property {number} trim @property {number} civic
 * @property {number} accent      the day's signature hue
 * @property {string} accentCss
 * @property {number} ground      grass base tint (environs multiplies its canvas by this)
 * @property {number} water       river / lake tint
 * @property {string} wash        'chalk'|'sand'|'lime'|'rose'|'quarry'
 * @property {string[]} dots      3 css swatches for the header "weather vane"
 */
/**
 * @typedef {Object} Paint
 * @property {number} roof   tile colour, shade-varied and quantised
 * @property {number} wall   plaster
 * @property {number} wall2  plaster, -15 %
 * @property {number} trim   timber
 * @property {number} stone  wall, -34 %
 * @property {number} door
 * @property {number} accent crates / awnings / flags / pennants
 * @property {number} civic  the day's civic accent — landmarks only
 * @property {boolean} rare  painted lady
 */

let PAL = null, PAL_SEED = -1;
const famAt = new Map();          // plot idx → roof family, so a tooltip can name a standing roof

function buildPalette(daySeed) {
  const rnd = lcg(Math.imul(daySeed | 0, 0x9E3779B1) ^ 0x5F356495);
  const order = FAM.map((f, i) => [i, rnd()]).sort((a, b) => a[1] - b[1]).map(o => o[0]);
  // rule 0: THE DOMINANT ROOF IS AN EARTH MATERIAL, on every seed. `familyFor`
  // gives p0 46 % of the roofs before thatch is counted on top of it, so this one
  // line is what guarantees the charter's "a village reads as made of earth-
  // coloured materials" no matter what the other three draw. It is a seeded pick,
  // not a fixed one — five of the ten families qualify.
  const pri = [order.find(i => FAM[i].earth)];
  // rule 1: no two primaries within 25° of hue unless one of them is a neutral
  const agrees = (i, j) => FAM[i].neutral || FAM[j].neutral || hueGap(FAM[i].hex, FAM[j].hex) >= 25;
  for (const i of order) { if (pri.length === 3) break; if (pri.indexOf(i) < 0 && pri.every(j => agrees(i, j))) pri.push(i); }
  for (const i of order) { if (pri.length === 3) break; if (pri.indexOf(i) < 0) pri.push(i); }
  // …and every town gets one neutral, or the street reads as a paint chart
  if (!pri.some(i => FAM[i].neutral)) pri[2] = order.find(i => FAM[i].neutral && pri.indexOf(i) < 0);
  // rule 2: the fourth roof — 8 % of the town — is the material left standing
  // that differs most from the dominant one. It used to be "the loudest", which
  // was the whole point when the table held dyes; now every candidate is a roof,
  // so what it is picking is contrast, not volume.
  const dom = FAM[pri[0]].hex;
  const rest = order.filter(i => pri.indexOf(i) < 0).sort((a, b) => chromaOf(FAM[b].hex) - chromaOf(FAM[a].hex));
  const fight = rest.filter(i => hueGap(FAM[i].hex, dom) >= 60 || Math.abs(lumOf(FAM[i].hex) - lumOf(dom)) >= .25);
  const pool = fight.length ? fight : rest;
  // anything within .14 chroma of the front runner is a tie, and the seed breaks
  // ties, or one family would take the fourth slot six days in ten
  const tied = pool.filter(i => chromaOf(FAM[i].hex) >= chromaOf(FAM[pool[0]].hex) - .14);
  const acc = tied[(rnd() * tied.length) | 0];

  const chosen = [pri[0], pri[1], pri[2], acc];
  const roofs = chosen.map(i => greyed(FAM[i].hex, .12));           // every roof hue keeps ≥ 12 % grey
  const wash = WASHES[(rnd() * WASHES.length) | 0];
  const walls = PLASTERS.map(h => [h, rnd()]).sort((a, b) => a[1] - b[1])
    .slice(0, 3).map(o => mix(o[0], wash[1], .12));
  const civicI = [0, 1, 2].reduce((a, b) => lumOf(roofs[a]) <= lumOf(roofs[b]) ? a : b);   // the deepest primary
  const rusticI = [0, 1, 2].reduce((a, b) => FAM[chosen[a]].rustic >= FAM[chosen[b]].rustic ? a : b);
  /* THE SIGNATURE HUE, drawn from ACCENTS and no longer from the roofs. It has to
     carry the hero number on dark chrome, where a greyed roof tile reads as mud —
     which is why it used to be a roof family at full chroma, and why 8 % of the
     town was roofed in it. Same rule as before, applied to paint instead: take
     the one that FIGHTS the dominant roof, and let the seed break the ties, so a
     terracotta town gets a blue or a green awning and a slate one gets a red.
     It is a VETO, not a requirement: "must differ by 55°" reads as good colour
     theory and comes out as nine days in ten under a cool awning, because the
     dominant roof is warm on half the seeds and every warm accent then fails.
     Rejecting only what is close in hue AND close in value keeps madder red over
     pale limestone — which is the prettiest day there is — and still never puts
     a terracotta awning on a terracotta street. */
  const aOrd = ACCENTS.map((h, i) => [i, rnd()]).sort((a, b) => a[1] - b[1]).map(o => o[0]);
  const aFit = aOrd.filter(i => hueGap(ACCENTS[i], dom) >= 30 || Math.abs(lumOf(ACCENTS[i]) - lumOf(dom)) >= .14);
  const accent = shade(ACCENTS[(aFit.length ? aFit : aOrd)[0]], .06);
  // guardrail: the darkest roof must stand off the grass by .18 luminance
  let ground = mix(GRASSES[(rnd() * GRASSES.length) | 0], wash[1], .10);
  const dark = Math.min(lumOf(roofs[0]), lumOf(roofs[1]), lumOf(roofs[2]), lumOf(roofs[3]));
  for (let i = 0; i < 10 && lumOf(ground) - dark < .18; i++) ground = shade(ground, .06);
  // band drift: neutrals hold the civic core, rustics take the outskirts
  const tilt = [0, 1, 2].map(i => (FAM[chosen[i]].rustic - (FAM[chosen[i]].neutral ? .85 : 0)) * .7);
  tilt.push(-.35);                                                  // the accent thins out at the edge

  return {
    roofs, roofNames: chosen.map(i => FAM[i].name), walls,
    trim: WOODS[(rnd() * WOODS.length) | 0], civic: roofs[civicI],
    accent, accentCss: cssOf(accent),
    ground, water: mix(WATERS[(rnd() * WATERS.length) | 0], roofs[3], .08),
    wash: wash[0], dots: [cssOf(roofs[0]), cssOf(roofs[1]), cssOf(roofs[2])],
    // internal, not part of the published typedef
    seed: daySeed >>> 0, rusticI, tilt,
    painted: [mix(roofs[civicI], 0x1E1B18, .30), mix(roofs[3], 0x1E1B18, .34), mix(roofs[1], 0x1E1B18, .28)]
  };
}

const todaySeed = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

/** Seeded per day. Idempotent, rebuild-safe, pure integer maths.
 *  @param {number} daySeed YYYYMMDD @returns {Palette} */
export function initPalette(daySeed) {
  const s = daySeed >>> 0;
  if (PAL && PAL_SEED === s) return PAL;
  PAL_SEED = s; PAL = buildPalette(s); famAt.clear();
  return PAL;
}
/** The live palette (after initPalette). @returns {Palette} */
export function palette() { return PAL || initPalette(todaySeed()); }
/** @returns {number} 0xRRGGBB — hero number, floaters, fireworks, beacon */
export function dayAccent() { return palette().accent; }

/** Which of the 4 families roofs plot `idx` in `band`. 46/28/18/8, tilted by band. */
function familyFor(idx, band) {
  const P = palette(), u = clamp((band || 0) / MAX_BAND, 0, 1);
  const w = [.46 * (1 + P.tilt[0] * u), .28 * (1 + P.tilt[1] * u), .18 * (1 + P.tilt[2] * u), .08 * (1 + P.tilt[3] * u)];
  let r = h2(idx, P.seed ^ 0x3131) * (w[0] + w[1] + w[2] + w[3]);
  for (let i = 0; i < 3; i++) if ((r -= w[i]) < 0) return i;
  return 3;
}

/** @param {number} idx plot index @returns {?('painted-lady'|'thatch'|'blue-door')} */
export function rareOf(idx) {
  if (!(idx >= 0)) return null;
  const s = palette().seed, core = 1 - clamp(idx / 200, 0, 1);
  if (h2(idx, s ^ 0x0BAD) < .010 + .022 * core) return 'painted-lady';   // ~1.5 %, weighted to the core
  if (h2(idx, s ^ 0x7EA0) < .055 * clamp((idx - 90) / 220, 0, 1)) return 'thatch';   // the outskirts still thatch
  if (h2(idx, s ^ 0x51DE) < .028) return 'blue-door';
  return null;
}

/** @param {number} idx @returns {string} 'Terracotta' — tooltips + Gazette */
export function roofNameOf(idx) {
  const fi = famAt.has(idx) ? famAt.get(idx) : familyFor(idx, 0);
  return fi < 0 ? 'Thatch' : palette().roofNames[fi];
}

/** The shared body: a shade-varied roof, plaster tinted to it, timber by band. */
function body(idx, band, base, vary) {
  const P = palette(), u = clamp((band || 0) / MAX_BAND, 0, 1);
  const rv = (Math.round(h2(idx, P.seed ^ 0x71C5) * 7) / 7 - .5) * vary;   // 7 steps — the cache depends on it
  // the wall is tinted toward the family BASE, never toward the shaded roof: one
  // lerp per (plaster × family) instead of one per house
  const wall = mix(P.walls[(h2(idx, P.seed ^ 0x2AA3) * 3) | 0], base, .08);
  // painted timbers are a civic-core habit; the outskirts leave the wood bare
  const trim = h2(idx, P.seed ^ 0x5C1D) < .55 - .42 * u
    ? P.painted[(h2(idx, P.seed ^ 0x9911) * 3) | 0]
    : WOODS[(h2(idx, P.seed ^ 0x4477) * WOODS.length) | 0];
  return {
    roof: shade(base, rv), wall, wall2: shade(wall, -.15), trim, stone: shade(wall, -.34),
    door: mix(0x3B2C1E, trim, .35), accent: P.accent, civic: P.civic, rare: false
  };
}

/** @param {number} idx plot index @param {number} band @returns {Paint} */
export function paintHouse(idx, band) {
  const P = palette(), rare = rareOf(idx), F = FABRICS[VTIER];
  // THE TIER'S LOUDEST SIGNAL. `rareOf`'s 'thatch' is untouched — it is a rarity
  // badge and the tooltip means it — but on top of it every plot takes the
  // fabric's own thatch roll, weighted to the outskirts because that is the order
  // a real parish re-roofs in: the core buys tile first and the far lanes last.
  // A hamlet is reed; a market town is clay.
  const edge = clamp((idx - 24) / 190, 0, 1);
  const thatch = rare === 'thatch' || h2(idx, P.seed ^ 0x7A7C) < F.thatch * (.35 + .65 * edge);
  const fi = familyFor(idx, band);
  famAt.set(idx, thatch ? -1 : fi);
  const p = body(idx, band, thatch ? THATCH : P.roofs[fi], .16);
  // WEATHERING, NOT HUE — the charter's rule, and the cheapest realism there is.
  // A roof is never the colour it was laid: reed silvers and greens, tile grows
  // lichen and soots up under the trees. Two seeded lerps, no triangles, and they
  // do more for a street of sixty than any geometry in this file.
  p.reed = thatch;
  p.roof = mix(p.roof, thatch ? MOSS : SLATE_R, (thatch ? .24 : .13) * h2(idx, P.seed ^ 0x4E55));
  if (rare === 'blue-door') p.door = LADY_DOORS[(h2(idx, P.seed ^ 0x1357) * LADY_DOORS.length) | 0];
  // How far out this plot is, published for dressPlot: the fabric is weighted to
  // the CORE the same way thatch is weighted to the outskirts. A market town has
  // walls, lanterns and swept yards around the square and paling out on the
  // farm lanes — which is both what a real one looks like and what keeps 977
  // dressed plots inside the triangle budget.
  p.edge = edge;
  if (rare === 'painted-lady') {                                          // …and the whole street knows it
    // greyed 14 %: the licence is a painted house, not a plastic one, and the
    // charter's "avoid saturated primaries" still applies to the exception.
    p.wall = greyed(LADY_WALLS[(h2(idx, P.seed ^ 0xBEEF) * LADY_WALLS.length) | 0], .14);
    p.wall2 = shade(p.wall, -.15); p.stone = shade(p.wall, -.34);
    p.trim = mix(p.wall, 0xFFF4E0, .72);                                  // pale trim against a loud wall
    p.door = LADY_DOORS[(h2(idx, P.seed ^ 0x1357) * LADY_DOORS.length) | 0];
    p.rare = true;
  }
  // …and a stone footing, so the plaster stops meeting the grass at a hard edge
  p.foot = mix(shade(p.wall, -.44), FIELD_D, .40);
  return p;
}

/** @param {string} kind @param {number} idx @param {number} band @returns {Paint} */
export function paintFlavor(kind, idx, band) {
  const P = palette();
  // the public buildings wear the day's accent, the working ones the oldest roof
  const fi = kind === 'market' || kind === 'tavern' || kind === 'bakery' ? 3
    : kind === 'farm' || kind === 'stables' || kind === 'forge' ? P.rusticI
      : familyFor(idx, band);
  famAt.set(idx, fi);
  return body(idx, band, P.roofs[fi], .14);
}

/**
 * Landmark paint. The near-white civic limestone and the gold that used to
 * define this set were what made a nine-rung ladder read as a capital city; the
 * ladder is a village's now, so the vocabulary is a village's: fieldstone, lime
 * plaster, oak, and a clay tile that carries the day's colour as a STAIN rather
 * than being that colour. A market town has re-roofed in tile; a hamlet's civic
 * buildings are still under stone slate.
 * @param {string} kind @returns {Paint}
 */
export function paintLandmark(kind) {
  const P = palette(), F = FABRICS[VTIER];
  let k = 0; for (let i = 0; i < (kind || '').length; i++) k = (Math.imul(k, 31) + kind.charCodeAt(i)) | 0;
  const base = VTIER >= 2 ? TILE : mix(SLATE_R, TILE, .30);
  return {
    roof: shade(mix(base, P.civic, .24), (h2(k, P.seed ^ 0x606C) - .5) * .10),
    wall: LIME, wall2: LIME_D, trim: OAK, stone: FIELD,
    door: OAK_D, accent: P.accent, civic: P.civic, rare: false,
    // additive, landmark-only — the builders below read these by name
    thatch: shade(THATCH_L, (h2(k, P.seed ^ 0x33B1) - .5) * .09), fabric: F
  };
}

/** @param {boolean} main @returns {Paint} */
export function paintBridge(main) {
  const P = palette();
  return main
    // A near-white limestone crossing out-valued every roof in the town and read
    // as a strip of paper laid over the river — the marquee feature of a river
    // town was the loudest and least crafted object on screen. Weathered stone.
    ? {
      roof: mix(SLATE, P.civic, .22), wall: shade(STONE, -.26), wall2: shade(STONE, -.34),
      trim: P.trim, stone: shade(STONE_D, -.10), door: 0x3E2C1A,
      accent: P.accent, civic: P.civic, rare: false
    }
    : {
      roof: WOODS[2], wall: mix(WOODS[1], 0xC9C6BC, .22), wall2: WOODS[0], trim: WOODS[1],
      stone: shade(STONE_D, -.12), door: 0x3E2C1A, accent: P.accent, civic: P.civic, rare: false
    };
}

/* ═══ procedural textures (cached; module-owned, never disposed) ═ */
const texCache = new Map();
const NO_SRGB = 1;                 // …a linear multiplier, not a colour: see fabricTex
function canvasTex(key, w, h, draw, linear) {
  let t = texCache.get(key);
  if (!t) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return t;
}
// Awnings are striped in the day's accent — a market square that changes colour
// every morning is the palette's loudest, cheapest signal.
const stripeTex = hex => canvasTex('stripe' + (hex >>> 0).toString(16), 64, 64, (x, w, h) => {
  x.fillStyle = '#EFE3C8'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#' + (hex >>> 0).toString(16).padStart(6, '0');
  for (let i = 0; i < 4; i++) x.fillRect(i * 16 + 3, 0, 8, h);
});
/* ── THE ONE TEXTURE THE TOWN WEARS ─────────────────────────────
   AESTHETIC.md's complaint, in full: "Avoid saturated primaries and plastic-
   looking uniform surfaces. Variation comes from weathering and material, not
   from hue." Geometry cannot answer that — a wall is flat because a wall IS
   flat, and the thing wrong with it is that every square metre of it is exactly
   the same value. That is a texture's job, and until `concatMeshes` learned to
   emit UVs (see the note there) the merged town had no texture coordinates at
   all to hang one on.

   So: ONE greyscale map, shared by every merged building in the town, projected
   triplanar from the geometry. It is a MULTIPLIER, not paint — NoColorSpace, so
   its bytes are used as linear scalars rather than decoded from sRGB, and its
   range is deliberately 0.82…1.0 so it can dirty a surface and never dye it.
   Content is lichen and rain-wash at low frequency (which is why it never
   shimmers, and why it needs no mip it has not got) plus a faint joint grid
   that reads as courses on a roof and as render panels on a wall.
   Cost: one texture bind on a material every house already shares. */
const fabricTex = () => canvasTex('fabric', 256, 256, (x, S) => {
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S);
  const rnd = lcg(0x5A17C0DE);
  x.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 120; i++) {
    const px = rnd() * S, py = rnd() * S, r = 7 + rnd() * 48;
    const v = Math.round(216 + rnd() * 32);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const gx = px + ox * S, gy = py + oy * S;                 // drawn nine times: tileable
      if (gx < -r || gx > S + r || gy < -r || gy > S + r) continue;
      const gr = x.createRadialGradient(gx, gy, 0, gx, gy, r);
      gr.addColorStop(0, `rgb(${v},${v},${v})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.beginPath(); x.arc(gx, gy, r, 0, TAU); x.fill();
    }
  }
  x.globalAlpha = .32; x.fillStyle = '#d2d2d2';
  for (let i = 0; i < S; i += 16) { x.fillRect(0, i, S, 1); x.fillRect(i, 0, 1, S); }
  x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
}, NO_SRGB);
const ploughTex = () => canvasTex('plough', 128, 128, (x, w, h) => {
  x.fillStyle = '#57432C'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i++) {
    x.fillStyle = i % 2 ? '#6A5236' : '#4A3824';
    x.fillRect(0, Math.round(i * h / 9), w, Math.round(h / 18));
  }
});
// The wizard tower's spiral, the cathedral's stained glass and the sky-gate's
// nebula were deleted with the landmarks that used them (see AESTHETIC.md).
// Nothing in a village is made of a nebula.

/* ═══ shared materials & geometry caches ════════════════════════ */
/** Shared material cache. Read-only for consumers. */
// The street furniture takes the 'prop' variant: a bench is 0.6 units tall, and
// a 1.30-unit AO ramp would darken the whole of it. The golds take 'metal' —
// there is no env map in this scene, which is why metalness alone renders gold
// as flat mustard, and the travelling lobe is what makes it read as metal.
export const MAT = {
  trunk: std(0x4a3a28, null, 'prop'), leafA: std(0x46573d, null, 'prop'), leafB: std(0x55684a, null, 'prop'),
  stone: std(0x8d8878, { roughness: .9 }), stoneDark: std(0x5f5b50),
  water: new THREE.MeshStandardMaterial({ color: 0x2f6f86, roughness: .25, metalness: .1 }),
  wood: std(0x6b533a, null, 'prop'), rock: std(0x777268, { roughness: 1 }, 'prop'),
  bush: std(0x3e5030, null, 'prop'), lampPole: std(0x4a4a46, null, 'prop'), door: std(0x3b2c1e),
  bulb: new THREE.MeshBasicMaterial({ color: 0xffd68c }),
  // gold family — see the metalness note on KIND.metal
  gold: applyTownSurface(new THREE.MeshStandardMaterial({ color: 0xD9AE4B, roughness: .35, metalness: .3 }), 'metal'),
  goldHi: applyTownSurface(new THREE.MeshStandardMaterial({ color: 0xF3D07A, roughness: .25, metalness: .35, emissive: 0xF3D07A, emissiveIntensity: .14 }), 'metal'),
  goldDark: applyTownSurface(new THREE.MeshStandardMaterial({ color: 0x8A6B1E, roughness: .45, metalness: .3 }), 'metal'),
  canvasStripe: applyTownSurface(new THREE.MeshStandardMaterial({ map: stripeTex(0xB24A42), roughness: .95, side: THREE.DoubleSide }))
};

// A unit triangular prism: cross-section (-.5,0)(.5,0)(0,1) extruded z -.5..+.5.
// Scaling it gives every gable roof and awning in the town for one geometry.
function gablePrism() {
  const s = new THREE.Shape();
  s.moveTo(-.5, 0); s.lineTo(.5, 0); s.lineTo(0, 1); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -.5);
  return g;
}

/** Flat-shaded soup: `tri` triangles handed in as a flat vertex list. Non-indexed,
 *  so computeVertexNormals gives FACE normals — a roof with a crease, not a blob. */
function faceted(v) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/* ── BOXES WITH THEIR BURIED FACES LEFT OFF ─────────────────────
   A village is boxes standing on the ground and boxes bedded in a roof, and
   `GEO.unit` draws all twelve triangles of every one of them. Two of those
   twelve can never be seen: the face lying on the ground, and the face under
   the string course / the coping / the chimney cap that was built on top of it.
   There are a dozen boxes in a dwelling and about a thousand dwellings.

   THE SHADOW PASS IS WHY THIS IS SAFE, and it is the only part that needs
   arguing — a triangle here is charged twice at `z1200` precisely because the
   shadow map is a second pass over the same geometry. three renders that pass
   from a material's BACK faces (`shadowSide` flips FrontSide → BackSide), so
   what writes a building's shadow is its UNDERSIDE and its far walls, never its
   lit top. Two consequences, and they are exactly the two faces dropped here:
     · a TOP face never writes shadow at all while the sun is above the horizon
       — its normal always faces the light — so dropping one is free in both
       passes and costs nothing but the pixels it was hiding;
     · dropping a BOTTOM face only matters for light rays that would have left
       through it, and a ray leaving through the floor of a box carries on below
       y = 0 — under the box's own footprint, which the box is standing on. The
       silhouette that casts onto the ground OUTSIDE the footprint is written by
       the far walls, and they are all still here.
   So: `ubox` for anything resting on the ground or bedded in a roof, `utube`
   for anything that also has something built on top of it. `boundingBox` is
   unchanged — the rim vertices are still there — so `impostorOf` measures the
   same mass it always did, and `mainMass` knows all three shapes. */
function openBox(withTop) {
  const v = [], P = (x, y, z) => [x * .5, y * .5, z * .5];
  const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1));      // +z
  quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1));  // -z
  quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1));      // +x
  quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1));  // -x
  if (withTop) quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1));
  return faceted(v);
}

/* The same argument, one shape further on: a RIDGE is the gable prism with 62 %
   of its height bedded in the slopes it caps (see `ridge`), so its floor is
   inside the roof it sits on and nothing above ground ever leaves through it.
   Six triangles instead of eight, on every ridge in the town. */
function ridgePrism() {
  const v = [], quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  const A = [-.5, 0, .5], B = [.5, 0, .5], C = [0, 1, .5];
  const D = [.5, 0, -.5], E = [-.5, 0, -.5], F = [0, 1, -.5];
  v.push(...A, ...B, ...C);      // the +z gable cap
  v.push(...D, ...E, ...F);      // the -z gable cap
  quad(B, D, F, C);              // the +x slope
  quad(E, A, C, F);              // the -x slope
  return faceted(v);
}

/* ── THE HIPPED ROOF, and why it is not the pyramid it replaces ──
   `mp` used to be a 4-sided cone turned 45°, which is a PAVILION roof: it comes
   to a point, its faces address the diagonals, and — because a 4-segment cone's
   base corners land at .509·r — it finished up NARROWER than the walls it sat on.
   Two thirds of the dwellings in the town wore one, so two thirds of the town had
   a pointed tent roof that under-hung its own eaves. A real cottage has a hip: two
   long slopes meeting at a short ridge, two hipped ends, and eaves that overhang.

   Same 8 triangles as the cone, authored in the same unit box the cone occupied
   (x, z in ±.5, y 0..1) so `mp` only loses its 45° turn — and `impostorOf` knows
   the shape by identity and still hands lod.js a 4-sided pyramid at exactly the
   footprint it used to compute. The far town does not change; the near town stops
   looking like a campsite. */
const RIDGE_HALF = .14;                                   // ridge runs x ±.14 at the top
function hipRoof() {
  // Centred in y like the cone it replaces, so every `mp(…)` call site keeps the
  // position it already has.
  const a = [-.5, -.5, -.5], b = [.5, -.5, -.5], c = [.5, -.5, .5], d = [-.5, -.5, .5];
  const e = [-RIDGE_HALF, .5, 0], f = [RIDGE_HALF, .5, 0];
  return faceted([].concat(
    d, c, f, d, f, e,        // the +z slope
    b, a, e, b, e, f,        // the -z slope
    c, b, f,                 // the +x hip
    a, d, e,                 // the -x hip
    a, b, c, a, c, d         // the soffit — an overhanging eave is seen from below
  ));
}

/* ── A SPLIT LOG ────────────────────────────────────────────────
   A woodpile was four `GEO.trunk`s — a 6-sided CYLINDER, 24 triangles, of which
   twelve are the two end fans. A log is a prism and its end is a pentagon at the
   size it is drawn (0.16 units; `GEO.crop` has been a 5-segment cone all along
   for the same reason), so this is 16: ten for the five sides, six for the two
   caps. BOTH caps stay — a plot is walked past on either side and an open end is
   a hole you can see the ground through, which is not the trade `openBox` makes.
   Authored lying along x, length 1, radius 1, so `scale(len, r, r)` places it. */
function logPrism() {
  const n = 5, v = [], c = [];
  for (let i = 0; i < n; i++) { const a = (i + .5) / n * TAU; c.push([Math.cos(a), Math.sin(a)]); }
  for (let i = 0; i < n; i++) {
    const p = c[i], q = c[(i + 1) % n];
    v.push(-.5, p[0], p[1], -.5, q[0], q[1], .5, q[0], q[1]);
    v.push(-.5, p[0], p[1], .5, q[0], q[1], .5, p[0], p[1]);
  }
  for (let i = 1; i < n - 1; i++) {
    v.push(.5, c[0][0], c[0][1], .5, c[i][0], c[i][1], .5, c[i + 1][0], c[i + 1][1]);
    v.push(-.5, c[0][0], c[0][1], -.5, c[i + 1][0], c[i + 1][1], -.5, c[i][0], c[i][1]);
  }
  return faceted(v);
}

/* A gable END: the triangle of PLASTER that closes a gable roof. The prism's own
   extrude caps are roof-coloured, so every gabled cottage in the town used to have
   two tile-coloured triangles where its walls should be — the single most visible
   material lie in the dwellings. Inset to .485/.965 of the prism so the roof's own
   edge shows round it as a verge, and pushed 2‰ proud so it wins the depth test. */
function gableEnd() {
  return faceted([
    -.485, 0, .502, .485, 0, .502, 0, .965, .502,
    .485, 0, -.502, -.485, 0, -.502, 0, .965, -.502
  ]);
}

/* ── ROOF FURNITURE, AT EYE LEVEL ───────────────────────────────
   From 200 units up a roof ends where its colour ends. From 1.6 m it ends at a
   BOARD: a gable verge carries a barge board nailed over the tile edge, an eave
   carries a fascia the gutter would hang off, and a tiled ridge on a house with
   any money in it carries a course of crest tiles. Until now a verge was the raw
   sawn edge of an extruded prism and an eave was the raw edge of the same prism —
   the two lines the stroll camera spends most of its time looking at.

   All three are authored in the ROOF'S OWN unit space, so one geometry apiece
   serves every roof in the town and the trim inherits the roof's scale, its yaw
   and its per-house pitch for free: `gtrim` takes the gable prism's transform
   exactly as `gend` does, `htrim` takes the hip's. Everything is 'trim', which
   means (a) it lands in the merge bucket the body already opened — no draw call,
   no material — and (b) `impRole` scores it 0, so a board hanging 12 cm below an
   eave never grows the far town's box or enters its roof contest.

   NOT ON THATCH. A reed roof has no verge board and no fascia: the reed wraps
   the verge and the eave course IS the eave. Putting oak on it would be the
   material lie the plastered gable ends were invented to stop. */
const VERGE = .105;                 // barge/fascia drop, as a fraction of roof height

/* Barge boards on all four verges, plus a fascia along both eaves — twelve
   triangles for the whole of a gable roof's edge. The gable prism spans x ±.5,
   y 0..1, z ±.5 with its ridge along z, so a verge is the line (±.5,0)→(0,1) at
   z = ±.5 and an eave is the line x = ±.5, y = 0. The band hangs straight DOWN
   from each, which is what a board nailed to a rafter foot does and — unlike a
   true perpendicular offset — survives the non-uniform scale a roof arrives with. */
function gableTrim() {
  const k = VERGE, ze = .508, xe = .504, v = [];
  const quad = (p0, p1, p2, p3) => v.push(
    p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2],
    p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  for (const s of [1, -1]) {                       // the two gable ends
    const z = s * ze;
    // wound CCW seen from +z, then reversed for the far end so both face out
    const L = [[-.5, -k, z], [0, 1 - k, z], [0, 1, z], [-.5, 0, z]];
    const R = [[0, 1 - k, z], [.5, -k, z], [.5, 0, z], [0, 1, z]];
    if (s > 0) { quad(...L); quad(...R); } else { quad(...L.slice().reverse()); quad(...R.slice().reverse()); }
  }
  for (const s of [1, -1]) {                       // the two eaves
    const x = s * xe;
    const q = [[x, -k, -.5], [x, 0, -.5], [x, 0, .5], [x, -k, .5]];
    if (s > 0) quad(...q); else quad(...q.slice().reverse());
  }
  return faceted(v);
}
/* The same fascia round a hipped roof, which has four eaves and no verge at all.
   `hipRoof` spans ±.5 in x and z with its eave line at y = -.5. */
function hipTrim() {
  const k = VERGE, e = .504, y0 = -.5, v = [];
  const quad = (p0, p1, p2, p3) => v.push(
    p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2],
    p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  for (const s of [1, -1]) {
    const x = s * e, q = [[x, y0 - k, -.5], [x, y0, -.5], [x, y0, .5], [x, y0 - k, .5]];
    if (s > 0) quad(...q); else quad(...q.slice().reverse());
    const z = s * e, r = [[-.5, y0 - k, z], [.5, y0 - k, z], [.5, y0, z], [-.5, y0, z]];
    if (s > 0) quad(...r); else quad(...r.slice().reverse());
  }
  return faceted(v);
}
/* A course of ridge crestings: five clay crest tiles standing on the ridge roll,
   drawn front and back so the ridge line reads the same from either side of the
   lane. Ten triangles, and only ever on the MAIN ridge of a tiled house grand
   enough to have bought them — see `R.crest`. Authored along local x, y 0..1. */
function ridgeCrest() {
  const n = 5, gap = .19, v = [];                       // …with air between them: a
  for (let i = 0; i < n; i++) {                         // continuous zigzag reads as a
    const c = -.5 + (i + .5) / n, hw = (1 - gap) / (2 * n);   // battlement, and the one
    const x0 = c - hw, x1 = c + hw;                     // thing a village roof must
    v.push(x0, 0, .004, x1, 0, .004, c, 1, .004);       // never look like is a wall-walk
    v.push(x1, 0, -.004, x0, 0, -.004, c, 1, -.004);
  }
  return faceted(v);
}

/* ── A WINDOW'S BARS ────────────────────────────────────────────
   A pane was one dark rectangle in a surround. That is exactly right at the four
   pixels a window gets from the orbit camera, and it is the weakest thing on a
   façade from 1.35 units — the stroll mode is what made it unarguable. What turns
   a rectangle into a window is the MULLION and the TRANSOM, and laid flat over the
   glass they are one or two quads: the timber is DRAWN, not modelled, exactly as
   the surround, the door and every half-timber stud in this file already are.

   Authored in the pane's own unit square (±.5) so one geometry serves every
   opening in the town, and the transom crosses the mullion rather than being
   mitred round it — two coplanar quads of the same colour and the same normal,
   which is two triangles saved and invisibly identical. A cross window is the
   17th-century form and goes on the houses that would have had one; the poorer
   and older cottages get the single mullion, which is the older form anyway.

   …EXCEPT THAT A SINGLE MULLION IS NOT WHAT A POOR OLD COTTAGE HAS. It has a
   LEADED LIGHT: small quarries in lead cames, because that is the only way to
   glaze an opening before anyone can roll a pane the size of one. `kind` 2 is
   that — three lights by four courses, in cames half the width of a mullion.
   It wants to be a texture on the pane rather than five more quads, and it
   cannot be: `mergeStatic` refuses any material carrying a `map`, so a mapped
   pane is a merge bucket of its own and a merge bucket of its own is a draw call
   on every house that has a window. (Letting it merge is no better — the merged
   town's UVs are triplanar world projections, so the lead grid would be a
   lattice at 2.6 world units per repeat, cropped arbitrarily by each opening,
   not aligned to a single one.) Ten triangles is what it costs to be honest, and
   it is charged ONLY where `cross` is false — the poor and old houses, which is
   tiers 2-3 — so it is bought entirely out of the scenes with the headroom: at
   `z1200` every dwelling is tier 4 or better and not one of these is built. */
function winBars(kind) {
  const b = kind === 2 ? .030 : .055, t = .058, v = [];
  const quad = (x0, y0, x1, y1) => v.push(
    x0, y0, 0, x1, y0, 0, x1, y1, 0,
    x0, y0, 0, x1, y1, 0, x0, y1, 0);
  if (kind === 2) {                                  // the leaded light: 3 × 4 quarries
    for (const x of [-1 / 6, 1 / 6]) quad(x - b, -.5, x + b, .5);
    for (const y of [-.25, 0, .25]) quad(-.5, y - b, .5, y + b);
    return faceted(v);
  }
  quad(-b, -.5, b, .5);                              // the mullion
  if (kind === 1) quad(-.5, -t, .5, t);              // …and the transom, straight across
  return faceted(v);
}

/** Shared geometry cache. */
export const GEO = {
  trunk: new THREE.CylinderGeometry(.13, .18, .8, 6),
  leafA: new THREE.ConeGeometry(.95, 1.7, 7),
  leafB: new THREE.ConeGeometry(.65, 1.2, 7),
  bush: new THREE.SphereGeometry(.6, 8, 6),
  rock: new THREE.DodecahedronGeometry(.5, 0),
  bulb: new THREE.SphereGeometry(.22, 10, 8),
  pole: new THREE.CylinderGeometry(.07, .09, 2.9, 6),
  unit: new THREE.BoxGeometry(1, 1, 1),
  ubox: openBox(true),            // 10 triangles: a box with no floor
  utube: openBox(false),          // 8 triangles: …and nothing on the lid either
  // Open-ended: a 4-sided cone is only ever a cap, a tent or a heap in this file,
  // and every one of them has its base bedded in the thing underneath it.
  pyr: new THREE.ConeGeometry(.72, 1, 4, 1, true),
  gable: gablePrism(),
  ridgeP: ridgePrism(),           // 6 triangles: the gable prism minus its bedded floor
  hip: hipRoof(),
  gend: gableEnd(),
  gtrim: gableTrim(),             // 12 triangles: four barge boards and two fascias
  htrim: hipTrim(),               // 8 triangles: a fascia round all four eaves
  crest: ridgeCrest(),            // 10 triangles: five crest tiles, both faces
  log: logPrism(),                // 16 triangles: a split log, lying along x
  wmull: winBars(0),              // 2 triangles: a single mullion
  wcross: winBars(1),             // 4 triangles: mullion and transom
  wlead: winBars(2),              // 10 triangles: a leaded light, 3 × 4 quarries
  sphere: new THREE.SphereGeometry(1, 12, 10),
  // A 0.24-radius scarecrow's head does not need 216 triangles — `ball` picks
  // this one under 0.7 units, which is every ball in the town except a dome.
  orb: new THREE.SphereGeometry(1, 7, 5),
  plane: new THREE.PlaneGeometry(1, 1),
  crop: new THREE.ConeGeometry(.11, .5, 5, 1, true),   // …and a cabbage is planted in soil

  coin: new THREE.CylinderGeometry(.55, .55, .09, 20)
};

const OWNED_GEO = new Set(Object.values(GEO));
const OWNED_MAT = new Set(Object.values(MAT));

/* ═══ the material cache — THE perf lever ═══════════════════════ */
// The matte kinds deliberately share ONE lighting model: the static merge buckets
// by roughness/metalness, so splitting hairs there would cost a draw call per
// kind per building. Colour already tells a roof from a wall.
const KIND = {
  roof: { roughness: .85 }, wall: { roughness: .85 }, trim: { roughness: .85 },
  stone: { roughness: .85 }, wood: { roughness: .85 },
  glass: { roughness: .25, metalness: .1 },
  // metalness stays low on purpose: there is no environment map in this scene, so
  // a physically metallic surface renders almost black.
  metal: { roughness: .35, metalness: .25 },
  // pennants and banners are single quads seen from both sides; they are `keep`ed
  // out of the static merge but there is no reason for each one to mint a material
  flag: { roughness: .8, side: THREE.DoubleSide }
};
const qc = c => Math.min(248, ((c + 4) >> 3) << 3);            // 8-step channel quantisation
const quantHex = h => (qc(h >> 16 & 255) << 16) | (qc(h >> 8 & 255) << 8) | qc(h & 255);
const matCache = new Map();

/**
 * Cached MeshStandardMaterial — SHARED, never mutate the result.
 * @param {number} hex 0xRRGGBB
 * @param {'roof'|'wall'|'trim'|'stone'|'wood'|'glass'|'metal'} kind
 * @returns {THREE.MeshStandardMaterial}
 */
export function matFor(hex, kind) {
  const k = KIND[kind] ? kind : 'wall', q = quantHex(hex | 0), key = k + '|' + q;
  let m = matCache.get(key);
  if (!m) {
    m = applyTownSurface(new THREE.MeshStandardMaterial(Object.assign({ color: q }, KIND[k])),
      k === 'metal' ? 'metal' : 'building');
    matCache.set(key, m); OWNED_MAT.add(m);
  }
  return m;
}

/* ── ground plates are not walls ────────────────────────────────
   surface.js has a 'ground' role for exactly this and its comment says why: a
   plate is ALL grazing angle from a 40-degree orbit, so the building role's
   fresnel rim (a pale sky blue, at .34) covers the whole of it. The village
   green rendered as a pond the size of the green, and every landmark's worn
   earth apron rendered as a puddle, until this existed.

   The role has to SURVIVE THE STATIC MERGE, which mints a fresh material and
   re-applies the surface pass at the default role — so `userData.srole` is part
   of the merge bucket key and is handed to `mergedMat`. That is the whole of the
   mechanism: a ground plate merges with other ground plates and with nothing
   else, and it costs no extra draw call. */
const groundMats = new Map();
function groundMat(hex, rough) {
  const r = rough === undefined ? 1 : rough, q = quantHex(hex | 0), key = q + '|' + r;
  let m = groundMats.get(key);
  if (!m) {
    m = applyTownSurface(new THREE.MeshStandardMaterial({ color: q, roughness: r }), 'ground');
    groundMats.set(key, m); OWNED_MAT.add(m);
  }
  return m;
}
const asGround = m => { m.rotation.x = -Math.PI / 2; m.userData.noCast = true; m.userData.srole = 'ground'; return m; };
/** A flat disc lying in the xz plane — worn earth, a green, a pond. */
const gdisc = (r, hex, seg, rough) => asGround(new THREE.Mesh(new THREE.CircleGeometry(r, seg || 20), groundMat(hex, rough)));
/** A flat annulus — a trodden verge, a muddy pond rim. */
const gring = (r0, r1, hex, seg) => asGround(new THREE.Mesh(new THREE.RingGeometry(r0, r1, seg || 20), groundMat(hex)));
/** A flat rectangle — a dug bed, a threshold. */
const gquad = (w, d, hex) => { const m = asGround(new THREE.Mesh(GEO.plane, groundMat(hex))); m.scale.set(w, d, 1); return m; };

// One striped canvas per (quantised) accent — in practice one per day.
const stripeMats = new Map([[quantHex(0xB24A42), MAT.canvasStripe]]);
function stripeMat(hex) {
  const q = quantHex(hex | 0);
  let m = stripeMats.get(q);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: stripeTex(q), roughness: .95, side: THREE.DoubleSide });
    stripeMats.set(q, m); OWNED_MAT.add(m);
  }
  return m;
}

/* ═══ primitive builders ════════════════════════════════════════ */
/** @returns {THREE.Mesh} */
export function box(w, h, d, color, extra) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color, extra)); }

/** 4-sided pyramid roof. @returns {THREE.Mesh} */
export function pyramid(w, d, h, color) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(.72, 1, 4), std(color, { roughness: .7 }));
  m.rotation.y = Math.PI / 4;
  m.scale.set(w * .78, h, d * .78);
  return m;
}

// Internal, cache-backed equivalents — everything below builds with these.
// `userData.k` records the material kind the mesh was built with. It costs one
// field on an object that already has a `userData`, and it is the only thing that
// tells a wall from a roof from a timber AFTER matFor has quantised their colours
// into a shared cache — deriveImpostor reads it in finish(), one step before the
// static merge folds all three into a single vertex-coloured buffer.
const tag = (m, k) => { m.userData.k = KIND[k] ? k : 'wall'; return m; };
/* `open`: 1 leaves the FLOOR off (the box stands on the ground, or is bedded in
   a roof), 2 leaves the lid off as well (something is built on top of it). See
   the openBox note for why neither costs a pixel or a shadow. */
const BOXES = new Set([GEO.unit, GEO.ubox, GEO.utube]);
const mb = (w, h, d, hex, kind, open) => {
  const m = new THREE.Mesh(open === 2 ? GEO.utube : open ? GEO.ubox : GEO.unit, matFor(hex, kind || 'wall'));
  m.scale.set(w, h, d); return tag(m, kind || 'wall');
};
const mp = (w, d, h, hex) => { const m = new THREE.Mesh(GEO.hip, matFor(hex, 'roof')); m.scale.set(w, h, d); return tag(m, 'roof'); };
/* A BOARD, NOT A BOX. Anything applied flat to a wall — a window, its surround, a
   door, a timber stud — is two triangles, not twelve. Six thousand window boxes
   were 144 k triangles of hidden faces; this is where the roof detail is paid for.
   `face`: +1 toward +z, -1 toward -z, 0 already facing +z with no yaw. */
const board = (w, h, hex, kind, face) => {
  const m = new THREE.Mesh(GEO.plane, matFor(hex, kind || 'wood'));
  m.scale.set(w, h, 1); if (face < 0) m.rotation.y = Math.PI;
  return tag(m, kind || 'wood');
};
const cone4 = (r, h, hex, kind) => { const m = new THREE.Mesh(GEO.pyr, matFor(hex, kind || 'roof')); m.rotation.y = Math.PI / 4; m.scale.set(r / .72, h, r / .72); return tag(m, kind || 'roof'); };
// alongX: the ridge runs parallel to world x (the scale swaps with the y-rotation)
const mgab = (w, h, d, hex, alongX) => {
  const m = new THREE.Mesh(GEO.gable, matFor(hex, 'roof'));
  if (alongX) { m.rotation.y = Math.PI / 2; m.scale.set(d, h, w); } else m.scale.set(w, h, d);
  return tag(m, 'roof');
};
// …and the same prism with its bedded floor left off, for ridges only.
const mrid = (w, h, d, hex, alongX) => {
  const m = new THREE.Mesh(GEO.ridgeP, matFor(hex, 'roof'));
  if (alongX) { m.rotation.y = Math.PI / 2; m.scale.set(d, h, w); } else m.scale.set(w, h, d);
  return tag(m, 'roof');
};
const cyl = (rt, rb, h, seg, hex, kind) => tag(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), matFor(hex, kind || 'stone')), kind || 'stone');
const cn = (r, h, seg, hex, kind) => tag(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), matFor(hex, kind || 'roof')), kind || 'roof');
const ball = (r, hex, kind) => { const m = new THREE.Mesh(r < .7 ? GEO.orb : GEO.sphere, matFor(hex, kind || 'stone')); m.scale.setScalar(r); return tag(m, kind || 'stone'); };
const plate = (w, h, mat) => { const m = new THREE.Mesh(GEO.plane, mat); m.scale.set(w, h, 1); return m; };
const keep = o => { o.userData.nomerge = true; return o; };     // exempt from the static merge

/* ═══ static merge ══════════════════════════════════════════════ */
const mergeMats = new Map();
function mergedMat(src, role) {
  const r = role || 'building';
  const k = `${src.roughness}|${src.metalness}|${src.side}|${src.flatShading ? 1 : 0}|${r}`;
  let m = mergeMats.get(k);
  if (!m) {
    // The merge is where a wall stops being a wall, so the surface pass has to
    // be re-applied here: the merged material is a NEW material, and it is the
    // one 90 % of the town is actually drawn with. `role` is what keeps a ground
    // plate a ground plate through the merge — see the groundMat comment.
    m = applyTownSurface(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: src.roughness, metalness: src.metalness,
      side: src.side, flatShading: src.flatShading,
      // …and this is the whole of the texture pass: the buildings' merge bucket —
      // the material 90 % of the town is drawn with — wears the weathering map.
      // Not the ground plates (they have environs' own paint) and not the metals.
      map: r === 'building' ? fabricTex() : null
    }), r);
    mergeMats.set(k, m); OWNED_MAT.add(m);
  }
  return m;
}

// Concatenate meshes into one indexed BufferGeometry, baking each source
// material's colour into a vertex-colour attribute. BufferGeometryUtils is not
// in the vendored build, so this is by hand.
/* THE UVs ARE BAKED HERE, and this is the only place they could be. Every source
   geometry in the town is a shared unit box, prism or hip scaled to twenty
   different sizes, so its own UVs mean nothing once it is a wall — a 0.05-thick
   window board and a 4-unit gable would wear the same square of texture. What
   IS meaningful after the merge is world-relative position and world normal, so
   the projection is triplanar: pick the dominant axis of the transformed normal
   and drop the other two coordinates in as u,v. A box face's vertices all carry
   the same normal, so a face never straddles two projections; a cylinder does,
   four times round, and at this frequency the seam is invisible.
   `salt` slides the sample window per group so two identical cottages side by
   side do not wear the same blotch in the same place. */
const UV_K = 1 / 2.6;              // world units per texture repeat: low and quiet
let uvSalt = 0;
function concatMeshes(list, inv) {
  let vN = 0, iN = 0;
  for (const c of list) { const p = c.geometry.attributes.position; vN += p.count; iN += c.geometry.index ? c.geometry.index.count : p.count; }
  const P = new Float32Array(vN * 3), N = new Float32Array(vN * 3), C = new Float32Array(vN * 3);
  const U = new Float32Array(vN * 2);
  const I = vN > 65535 ? new Uint32Array(iN) : new Uint16Array(iN);
  const m4 = new THREE.Matrix4(), m3 = new THREE.Matrix3(), v = new THREE.Vector3();
  const su = (uvSalt * .6180339887) % 1, sv = (uvSalt * .3819660113) % 1;
  let vo = 0, io = 0;
  for (const c of list) {
    m4.multiplyMatrices(inv, c.matrixWorld); m3.getNormalMatrix(m4);
    const g = c.geometry, pa = g.attributes.position, na = g.attributes.normal, col = c.material.color;
    for (let i = 0; i < pa.count; i++) {
      const o = (vo + i) * 3;
      v.fromBufferAttribute(pa, i).applyMatrix4(m4); P[o] = v.x; P[o + 1] = v.y; P[o + 2] = v.z;
      if (na) { v.fromBufferAttribute(na, i).applyMatrix3(m3).normalize(); N[o] = v.x; N[o + 1] = v.y; N[o + 2] = v.z; }
      C[o] = col.r; C[o + 1] = col.g; C[o + 2] = col.b;
      const ax = Math.abs(N[o]), ay = Math.abs(N[o + 1]), az = Math.abs(N[o + 2]), u = (vo + i) * 2;
      if (ay >= ax && ay >= az) { U[u] = P[o] * UV_K + su; U[u + 1] = P[o + 2] * UV_K + sv; }
      else if (ax >= az) { U[u] = P[o + 2] * UV_K + su; U[u + 1] = P[o + 1] * UV_K + sv; }
      else { U[u] = P[o] * UV_K + su; U[u + 1] = P[o + 1] * UV_K + sv; }
    }
    if (g.index) { const ix = g.index; for (let i = 0; i < ix.count; i++) I[io++] = ix.getX(i) + vo; }
    else for (let i = 0; i < pa.count; i++) I[io++] = vo + i;
    vo += pa.count;
  }
  uvSalt++;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.setIndex(new THREE.BufferAttribute(I, 1));
  out.computeBoundingSphere();
  return out;
}

function mergeStatic(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), buckets = new Map();
  (function walk(o) {
    for (const c of o.children) {
      if (c.userData.nomerge) continue;                        // exempt: subtree stays intact
      const m = c.material;
      if (c.isMesh && !c.isInstancedMesh && c.children.length === 0 && m && m.isMeshStandardMaterial
        && !m.transparent && !m.map && !m.normalMap && !m.vertexColors) {
        // Emissive materials can't be vertex-colour-folded, so bucket them by
        // identity — windows and coals keep the exact material winMats/glow hold.
        const em = m.emissive && m.emissive.getHex() !== 0;
        const key = (em ? 'e' + m.id : `s|${m.roughness}|${m.metalness}|${m.side}|${m.flatShading ? 1 : 0}`)
          + '|' + (c.userData.srole || '')
          + '|' + (c.castShadow ? 1 : 0) + (c.receiveShadow ? 1 : 0);
        let b = buckets.get(key);
        if (!b) buckets.set(key, b = { list: [], mat: em ? m : null, role: c.userData.srole });
        b.list.push(c);
        continue;
      }
      if (c.children.length) walk(c);
    }
  })(g);
  for (const b of buckets.values()) {
    if (b.list.length < 2) continue;
    const first = b.list[0];
    const mesh = new THREE.Mesh(concatMeshes(b.list, inv), b.mat || mergedMat(first.material, b.role));
    mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
    mesh.userData.srole = b.role;
    for (const c of b.list) { if (c.parent) c.parent.remove(c); if (!OWNED_GEO.has(c.geometry)) c.geometry.dispose(); }
    g.add(mesh);
  }
}

// An animated sub-group moves as a rigid unit, so its own internals can still be
// welded — a 4-sail windmill hub goes from 9 draws to 2.
const weld = o => { mergeStatic(o); return keep(o); };

const UD = () => ({ hTop: 0, baseScale: 1, kind: 'house', label: '', span: 1, winMats: [], spin: [], smoke: [], glow: [], sway: [], pointLights: [] });

function finish(g, ud, noMerge, imp) {
  g.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = o.material, fx = !!m && (m.transparent === true || m.blending === THREE.AdditiveBlending);
    o.castShadow = !fx && o.userData.noCast !== true;
    o.receiveShadow = !fx;
  });
  // The last moment the parts are still parts (see the impostor section below).
  if (imp) ud.imp = impostorOf(g, imp === true ? null : imp);
  if (!noMerge) mergeStatic(g);
  g.userData = Object.assign(UD(), ud);
  return g;
}
/* ═══ impostors — what a building is at twelve pixels ═══════════
   The camera auto-frames the whole plat, so a house SHRINKS as the town grows:
   31 px at 200 buildings, 12 px at the 1200 cap. At that size a building IS a
   coloured box with a roof on it, which is what `lod.js` draws the far town with
   — seven InstancedMeshes for the whole settlement instead of ~4 800 groups.

   The swap is only invisible if the box matches the real mass, so the spec is
   READ OFF the group here, one step before mergeStatic folds every wall, roof and
   timber into one vertex-coloured buffer and the distinction is gone forever.
   Everything is LOCAL and UNSCALED: lod multiplies by the group's own scale.

   Three rules, and they are the whole file's worth of judgement:
     body  the bounding box of the solid mass — meshes tagged wall/stone/roof that
           reach 22 % of the biggest one's footprint, plus anything over 5 % and
           0.8 wide that stands nearly as tall (corner turrets, a villa's tower,
           a counting-house lantern; a chimney is never that wide). Timber, glass,
           doors, flags, awnings and ground plates are decoration and never count.
     roof  the widest gable or cone standing over that mass, replayed EXACTLY:
           lod owns the same two geometries, so copying scale, rotation.y and
           position.y reproduces the real roof rather than approximating it.
     ch    the tallest slim stone stack clearing the mass — a chimney.
   A builder may hand `finish` an override object for anything it knows better
   (the market is a canopy on four posts and has no mass to measure at all). */

/**
 * @typedef {Object} Impostor  local to the group, UNSCALED — lod applies the scale
 * @property {number} w @property {number} d @property {number} h @property {number} y0
 * @property {number} rk   roof: 0 none · 1 gable prism · 2 pyramid/cone
 * @property {number} rw @property {number} rd @property {number} rh   roof scale
 * @property {number} ry   roof yaw, added to the group's own
 * @property {number} rY   roof origin y — a gable's eave line, a cone's centre
 * @property {number} wall @property {number} roof   0xRRGGBB, as drawn
 * @property {?{x:number,y:number,z:number}} ch      chimney top
 * @property {?{geo:'sails'|'awning'|'field',x:number,y:number,z:number,s:number,color:number}} extra
 */

const IMP_A_REL = .22;      // …of the biggest footprint: this is the building
const IMP_A_TALL = .05;     // …and this much, standing high and at least
const IMP_TALL_W = .80;     // …this wide, is a turret. Narrower is a chimney.
const IMP_TALL_Y = .88;
const IMP_ROOF_REL = .25;   // a roof narrower than this is a turret cap, not the roof
const IMP_CH_AREA = .40, IMP_CH_H = .55;

// Measured once per mesh into shared scratch, then read five times: a founding
// cascade builds 1 200 of these back to back, so nothing here may allocate.
const IMP_MAX = 128;
const _ib = new THREE.Box3();
const _ibx = new Float64Array(IMP_MAX * 6);   // min xyz, max xyz
const _ia = new Float64Array(IMP_MAX);        // footprint area
const _ic = new Int32Array(IMP_MAX);          // material colour, as drawn
const _ir = new Uint8Array(IMP_MAX);          // 0 ignore · 1 solid mass · 2 roof · 3+roof kind

/** 0 ignore · 1 solid mass · 2 roof candidate. */
function impRole(m) {
  if (!m.isMesh || m.isInstancedMesh || m.userData.noCast) return 0;
  const k = m.userData.k;
  if (k !== 'wall' && k !== 'stone' && k !== 'roof') return 0;
  const g = m.geometry;
  if (!g) return 0;
  if (k !== 'roof') return 1;
  // A gable prism, a hip or a cone tagged 'roof' is A ROOF; a flat slab or a dome
  // tagged 'roof' is mass that happens to be roof-coloured (3), which is where the
  // roof colour comes from when there is no roof to read it off.
  // GEO.ridgeP is listed with the gable prism it is cut from so a ridge scores
  // exactly what it scored when it WAS one: a roof candidate that loses the
  // contest on area (IMP_ROOF_REL) rather than a lump of roof-coloured mass.
  return g === GEO.gable || g === GEO.ridgeP || g === GEO.hip || g.type === 'ConeGeometry' ? 2 : 3;
}

/**
 * @param {THREE.Group} g a group whose meshes are still unmerged
 * @param {?Object} over builder overrides, merged last
 * @returns {?Impostor}
 */
function impostorOf(g, over) {
  const ch = g.children, n = Math.min(ch.length, IMP_MAX);
  let aMax = 0, aWall = 0, wallHex = 0;
  for (let i = 0; i < n; i++) {
    const m = ch[i];
    let r = impRole(m);
    if (r) {
      const gg = m.geometry;
      if (!gg.boundingBox) gg.computeBoundingBox();
      if (!gg.boundingBox) r = 0;
      else {
        m.updateMatrix();                      // Box3.applyMatrix4 walks the 8
        _ib.copy(gg.boundingBox).applyMatrix4(m.matrix);   // corners: rotation counts
        const o = i * 6;
        _ibx[o] = _ib.min.x; _ibx[o + 1] = _ib.min.y; _ibx[o + 2] = _ib.min.z;
        _ibx[o + 3] = _ib.max.x; _ibx[o + 4] = _ib.max.y; _ibx[o + 5] = _ib.max.z;
        _ia[i] = (_ib.max.x - _ib.min.x) * (_ib.max.z - _ib.min.z);
        _ic[i] = m.material.color.getHex();
        // TWO CONTESTS, NOT ONE. `aMax` is the relative-area yardstick and every
        // mass counts towards it, but the WALL COLOUR may only be read off a real
        // wall (role 1). Role 3 is roof-coloured mass — a dome or a flat slab
        // tagged 'roof' — and it is often the biggest footprint in the group, so
        // letting it win this contest painted the whole impostor in the roof's
        // dark colour. That is where the near-black boxes in the far town came
        // from: a pale cottage under a slate dome came back as a slate cottage.
        if (r !== 2) {
          if (_ia[i] > aMax) aMax = _ia[i];
          if (r === 1 && _ia[i] > aWall) { aWall = _ia[i]; wallHex = _ic[i]; }
        }
      }
    }
    _ir[i] = r;
  }
  // A DOME OR A SLAB SITTING ON TOP IS A CAP, NOT MASS. The impostor kit has a
  // box, a gable prism and a pyramid, and none of those is a dome — so a domed
  // tower (which is most of what a rich town is made of: Keeps, Cathedrals,
  // Counting-Houses) came back as a plain box with a coloured lid, i.e. an open
  // crate. A shallow pyramid at the dome's own height, width and colour reads as
  // a capped tower at every distance the impostor is ever seen from.
  //   The guards matter: a flat-roofed MARKET is mostly slab, and turning that
  // into a pyramid would halve the building. A cap has to be short relative to
  // what it sits on, and it has to sit at the TOP of it.
  let capI = -1;
  {
    let wallTop = -1e9, wallBot = 1e9, hiTop = -1e9;
    for (let i = 0; i < n; i++) {
      if (_ir[i] !== 1) continue;
      const o = i * 6;
      if (_ibx[o + 4] > wallTop) wallTop = _ibx[o + 4];
      if (_ibx[o + 1] < wallBot) wallBot = _ibx[o + 1];
    }
    if (wallTop > -1e8) {
      const wallH = Math.max(.2, wallTop - wallBot);
      for (let i = 0; i < n; i++) {
        if (_ir[i] !== 3) continue;
        const o = i * 6, capH = _ibx[o + 4] - _ibx[o + 1];
        if (_ibx[o + 1] < wallTop - wallH * .28) continue;   // not on top: it IS the building
        if (capH > wallH * .55) continue;                    // too tall to be a lid
        if (_ibx[o + 4] <= hiTop) continue;
        hiTop = _ibx[o + 4]; capI = i;
      }
    }
    if (capI >= 0) _ir[capI] = 4;                            // excluded from the mass
  }

  // the core: the meshes that are unambiguously the building
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9;
  const grow = o => {
    if (_ibx[o] < x0) x0 = _ibx[o]; if (_ibx[o + 3] > x1) x1 = _ibx[o + 3];
    if (_ibx[o + 2] < z0) z0 = _ibx[o + 2]; if (_ibx[o + 5] > z1) z1 = _ibx[o + 5];
    if (_ibx[o + 1] < y0) y0 = _ibx[o + 1]; if (_ibx[o + 4] > y1) y1 = _ibx[o + 4];
  };
  for (let i = 0; i < n; i++) if (_ir[i] === 1 || _ir[i] === 3) { if (_ia[i] >= IMP_A_REL * aMax) grow(i * 6); }
  const coreTop = y1;
  for (let i = 0; i < n; i++) {                // …then the towers standing beside it
    if (_ir[i] !== 1 && _ir[i] !== 3) continue;
    const o = i * 6;
    if (_ia[i] < IMP_A_TALL * aMax || _ia[i] >= IMP_A_REL * aMax) continue;
    if (Math.min(_ibx[o + 3] - _ibx[o], _ibx[o + 5] - _ibx[o + 2]) < IMP_TALL_W) continue;
    if (_ibx[o + 4] >= IMP_TALL_Y * coreTop) grow(o);
  }

  // the roof, replayed rather than approximated
  let rk = 0, rw = 0, rh = 0, rd = 0, ry = 0, rY = 0, roofHex = -1, rBest = 0;
  for (let i = 0; i < n; i++) {
    if (_ir[i] !== 2 || _ia[i] <= rBest || _ia[i] < IMP_ROOF_REL * aMax) continue;
    const m = ch[i];
    if (Math.abs(m.rotation.x) > 1e-4 || Math.abs(m.rotation.z) > 1e-4) continue;
    rBest = _ia[i];
    const gg = m.geometry, p = gg.parameters, cone = gg !== GEO.gable && gg !== GEO.ridgeP;
    // lod's own prism is bit-identical and its cone is ConeGeometry(.72, 1, 4), so
    // a cone of any radius/height/segment count maps by ratio and lands exactly.
    const kr = cone && p ? p.radius / .72 : 1, kh = cone && p ? p.height : 1;
    rk = cone ? 2 : 1;
    rw = m.scale.x * kr; rd = m.scale.z * kr; rh = m.scale.y * kh;
    ry = m.rotation.y; rY = m.position.y;
    // THE HIP IS DESCRIBED TO lod AS THE PYRAMID IT USED TO BE. A 4-segment cone
    // turned 45° puts its four base vertices on the corners of an axis-aligned
    // rectangle 1.018·r across, so dividing by that and adding the turn hands back
    // a pyramid whose footprint IS the hip's — same y centre, same eave line, and
    // the same `rY - rh·.30` clamp on the mass box. lod.js is untouched by this.
    if (gg === GEO.hip) { rw = m.scale.x / 1.018; rd = m.scale.z / 1.018; ry += Math.PI / 4; }
    roofHex = _ic[i];
  }
  // …and if there was no roof primitive, the cap we set aside becomes one.
  if (!rk && capI >= 0) {
    const o = capI * 6;
    const cw = _ibx[o + 3] - _ibx[o], cd = _ibx[o + 5] - _ibx[o + 2];
    const cheight = Math.max(.06, _ibx[o + 4] - _ibx[o + 1]);
    rk = 2;                                    // the pyramid: three.js centres it, so rY is its MIDDLE
    rw = cw * .99; rd = cd * .99; rh = cheight;
    ry = 0; rY = (_ibx[o + 1] + _ibx[o + 4]) * .5;
    roofHex = _ic[capI];
  }
  if (roofHex < 0) {                           // a slab that is the building, not a lid
    let hi = -1e9;
    for (let i = 0; i < n; i++) if (_ir[i] === 3 && _ibx[i * 6 + 4] > hi) { hi = _ibx[i * 6 + 4]; roofHex = _ic[i]; }
  }

  if (x1 <= x0) {                            // …and a lean-to is roof all the way down
    // Nothing to measure and nothing overriding it: no silhouette exists, so say
    // so. lod reads null as "keep this one real", which is the honest answer.
    if (!rk) return over && over.w > 0 && over.h > 0 && over.d > 0
      ? Object.assign({ w: 0, d: 0, h: 0, y0: 0, rk: 0, rw: 0, rh: 0, rd: 0, ry: 0, rY: 0, wall: 0x9A9080, roof: 0x6E6656, ch: null, extra: null }, over)
      : null;
    x0 = -rw / 2; x1 = rw / 2; z0 = -rd / 2; z1 = rd / 2;
    y0 = Math.min(0, rY); y1 = Math.max(y0 + .06, rY);
    if (!wallHex) wallHex = roofHex < 0 ? 0x9A9080 : roofHex;
  }
  y0 = Math.max(0, y0);
  // A corner of the mass poking through its own eaves shows as a wrong-coloured
  // notch on the skyline; sinking it a fifth of the way up the roof never does.
  //
  // THE TWO ROOF PRIMITIVES DO NOT SHARE AN ORIGIN, and this line used to assume
  // they did. gablePrism() spans y 0..1, so `rY` IS its eave line; GEO.pyr is a
  // ConeGeometry, which three centres at y -.5..+.5, so for a pyramid `rY` is the
  // roof's MIDDLE and its eave line is rY - rh/2. Clamping both to rY + rh*.2 left
  // the wall box standing 0.7·rh proud all the way round every pyramid-roofed
  // house — the far town rendered as open-topped crates with a coloured panel
  // recessed in the lid, which is the single ugliest thing LOD did. lod.js has
  // always known the difference (its bTop uses rh vs rh*.5 per kind); this is the
  // producing end finally agreeing with it.
  if (rk) y1 = Math.min(y1, rk === 2 ? rY - rh * .30 : rY + rh * .20);
  const h = Math.max(.06, y1 - y0);
  if (!wallHex) wallHex = roofHex >= 0 ? shade(roofHex, .26) : 0x9A9080;
  if (roofHex < 0) roofHex = shade(wallHex, -.18);

  // the chimney: slim, tall, and standing clear of the mass
  let cx = 0, cy = -1e9, cz = 0;
  for (let i = 0; i < n; i++) {
    if (_ir[i] !== 1 || _ia[i] > IMP_CH_AREA) continue;
    const o = i * 6;
    if (_ibx[o + 4] - _ibx[o + 1] < IMP_CH_H || _ibx[o + 4] < y1 - .2 || _ibx[o + 4] <= cy) continue;
    cx = (_ibx[o] + _ibx[o + 3]) * .5; cy = _ibx[o + 4]; cz = (_ibx[o + 2] + _ibx[o + 5]) * .5;
  }

  const imp = {
    w: Math.max(.06, x1 - x0), d: Math.max(.06, z1 - z0), h, y0,
    rk, rw, rh, rd, ry, rY, wall: wallHex, roof: roofHex,
    ch: cy > -1e8 ? { x: cx, y: cy, z: cz } : null, extra: null
  };
  return over ? Object.assign(imp, over) : imp;
}

/**
 * The cheap stand-in `lod.js` draws a settled building with past ~26 px — see the
 * section comment above for what it measures and why. Deterministic per input and
 * allocation-free on the hot path: a group's spec is derived once, at build time,
 * and every later call hands back the same object.
 *
 * @param {THREE.Group|{tier?:number,flavor?:string,seed?:number,idx?:number,band?:number,paint?:Paint}} src
 *        a group from buildHouse/buildFlavor, or a descriptor to derive one from
 * @returns {?Impostor} null for anything with no derivable silhouette (landmarks,
 *        bridges, trees) — `lod.set` reads null as "keep this one real", which is
 *        exactly right for the handful of groups that live outside `coldRoot`.
 */
export function deriveImpostor(src) {
  if (!src) return null;
  if (src.isObject3D) return (src.userData && src.userData.imp) || null;
  // Descriptor path — for harnesses and any consumer that wants a silhouette
  // without a group. It builds and drops one; never call it per frame.
  const seed = src.seed === undefined ? (src.idx || 0) * 7919 + 13 : src.seed;
  const idx = src.idx || 0, band = src.band || 0;
  const paint = src.paint || (src.flavor ? paintFlavor(src.flavor, idx, band) : paintHouse(idx, band));
  const g = src.flavor ? buildFlavor(src.flavor, paint, seed) : buildHouse(src.tier | 0, paint, seed);
  const imp = g.userData.imp || null;
  disposeGroup(g);
  return imp;
}

/**
 * The town's ONE lit-window material for `hex` — the exact object every group's
 * `userData.winMats` holds. Hand it to `lod.js` as `cfg.winMat` so town.js's
 * single `emissiveIntensity` write lights the impostors' panes in the same frame
 * as the real ones. Shared and cached: never mutate anything but that intensity.
 * @param {number} [hex=0xffd68c] @returns {THREE.MeshStandardMaterial}
 */
export function winMatFor(hex) { return winMat(hex === undefined ? 0xffd68c : hex, false); }

/* ═══ doors & windows ═══════════════════════════════════════════
   ALL OF THIS USED TO BE BOXES, and that is where the town's triangles were. A
   window was two 12-triangle boxes of which twenty faces were buried in a wall;
   at seven windows a villa that is 168 triangles to draw four visible rectangles,
   and the town builds about six thousand of them. As boards they are 4 triangles
   each and they read BETTER, because the budget bought a proper surround: a pale
   reveal with the pane recessed in it, instead of two flush slabs. The 120 k
   triangles this gave back are what paid for every roof below. */
/** `x` moves the door off centre — a range with a cross-wing does not have its
 *  door in the middle of the elevation, and a symmetrical one is the giveaway
 *  that a street was stamped out rather than built. */
function addDoor(g, wallD, h, hex, x) {
  const c = hex === undefined ? 0x3b2c1e : hex;
  const z = wallD / 2, dx = x || 0;
  g.add(at(board(.86, h + .18, mix(c, 0xD8CDB4, .70), 'trim', 1), dx, (h + .18) / 2 - .05, z + .03));
  g.add(at(board(.62, h, c, 'wood', 1), dx, h / 2, z + .05));
}
// Lit windows share ONE material town-wide — town.js drives every winMats entry
// to the same intensity anyway, and a per-building material would mean 300 live
// materials. `priv` mints a private one for the few buildings that glow on their
// own schedule (the tavern).
/* GLASS IS DARK; A HOLE IS BLACK. The lit pane's base colour was 0x11141c, which
   is what it looks like for the sixteen hours a day the emissive is switched OFF —
   so four windows in five were a black rectangle in daylight, and daylight is most
   of the picture. The unlit fifth was fixed to a sky reflection last night and the
   lit majority was not. This is the same fix at the same value scale: dark enough
   that the mullion still crosses it, light enough that it is a window and not a
   hole knocked in a wall. `lod.js` only shows impostor panes when night > .15, and
   at night the emissive is overdriven to 2.2 and swamps the albedo, so the far
   town is unaffected either way. */
const GLASS_DIM = 0x28323C;
const winCache = new Map();
function winMat(hex, priv) {
  if (priv) return new THREE.MeshStandardMaterial({ color: GLASS_DIM, emissive: hex, emissiveIntensity: 0, roughness: .45 });
  let m = winCache.get(hex);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: GLASS_DIM, emissive: hex, emissiveIntensity: 0, roughness: .45 }); winCache.set(hex, m); OWNED_MAT.add(m); }
  return m;
}
// The ~20% of panes that stay dark fold straight into the body geometry.
// An unlit pane is a sky reflection, not a hole: near-black glass read as soot
// marks or bomb damage in daylight, which is most of the day. Every pane also
// gets a timber frame, which is what stops it reading as a punched opening.
const GLASS_OFF = 0x8EA2B4;
/**
 * @typedef {Object} WinStyle  everything a façade needs to know about its openings
 * @property {number} reveal  the splay round the opening — limewash, paler than the wall
 * @property {number} bar     mullion, transom and glazing bars: oak
 * @property {number} sill    the dressed stone that throws the rain clear
 * @property {boolean} cross  a cross window (mullion AND transom), or a plain mullion
 * @property {boolean} lead   a leaded light — 3 × 4 quarries in lead cames. Wins
 *                            over `cross`; the old and poor form (see winBars)
 * @property {number} shut    0..1 share of openings that carry shutters
 * @property {number} shutHex the shutters' paint
 * @property {number} upD     the wall depth for UPPER-storey openings: a jettied
 *                            storey's windows are not in the same plane as the
 *                            ground floor's, and putting them there buries them
 * @property {number} ww      the width of the wall the grid is laid out on, and
 * @property {number} wx      …where its centre is — a range with a cross-wing is
 *                            not centred on the plot and its windows are not either
 * @property {number} doorX   where the front door is, so the grid can avoid it
 * @property {number} upW @property {number} upZ  the jettied storey's width and
 *                            z-centre, for the same reason `upD` exists
 * @property {number} ends    how many openings the two GABLE ENDS carry between
 *                            them — 0 when both flanks are built against
 * @property {number} endSign when set, all of `ends` goes on that flank (-1 / +1)
 */
const WIN_DEF = { reveal: 0xCBC0A7, bar: 0x4E4133, sill: 0xB5AA91, cross: false, shut: 0 };
/* FIVE PIECES, TEN TRIANGLES, and every one of them is flat: a limewashed reveal,
   the glass, the bars, and a stone sill. The old window was a 4-triangle pane in a
   4-triangle surround whose surround was DARKER than its glass, so from the lane
   it read as a brown smudge rather than as a hole in a wall with something in it.
   Everything here lands in the merge bucket the body already opened ('trim' and
   'wood' are the same roughness as 'wall'), so a window still costs no draw call —
   and everything is tagged so `impRole` scores it 0 and a sill never grows the
   far town's box.

   ONE OPENING, ANYWHERE, AT ANY YAW — because the massing kit needs to put a
   window in a cross-wing's gable and in a dormer and in the three faces of an
   oriel, and those are not on the façade grid. `yaw` is the wall's outward
   direction; everything is then offset along that normal and, for the shutters,
   along its tangent. */
function addPane(g, S, x, y, z, yaw, mat, sd, k) {
  const rev = S.reveal === undefined ? WIN_DEF.reveal : S.reveal;
  const bar = S.bar === undefined ? WIN_DEF.bar : S.bar;
  const sil = S.sill === undefined ? WIN_DEF.sill : S.sill;
  const s = Math.sin(yaw), c = Math.cos(yaw), q = k || 1;
  const put = (o, out, dy, tan) => {
    o.rotation.y = yaw;
    o.position.set(x + s * out + c * (tan || 0), y + (dy || 0), z + c * out - s * (tan || 0));
    g.add(o); return o;
  };
  put(board(.66 * q, .80 * q, rev, 'trim', 0), .026);
  // The unlit pane takes the WALL lighting model, not 'glass'. A roughness of
  // its own is a merge bucket of its own, and a bucket of its own is a third
  // draw call on every house that has one dark window — which is most of them.
  const p = new THREE.Mesh(GEO.plane, mat); p.scale.set(.47 * q, .60 * q, 1);
  put(p, .048);
  const b = tag(new THREE.Mesh(S.lead ? GEO.wlead : S.cross ? GEO.wcross : GEO.wmull, matFor(bar, 'trim')), 'trim');
  b.scale.set(.47 * q, .60 * q, 1); put(b, .064);
  put(board(.80 * q, .11 * q, sil, 'trim', 0), .076, -.455 * q);
  // Shutters — half the point of them is that they are never all on, and never on
  // every opening, so they break a repeated elevation up for four triangles on
  // the houses that can afford the paint.
  if (S.shut && seededR(sd) < S.shut)
    for (const t of [-1, 1])
      put(board(.20 * q, .80 * q, t < 0 ? S.shutHex : shade(S.shutHex, -.12), 'trim', 0),
        .058, 0, t * .44 * q);
}

/* THE FAÇADE GRID. The old one marched along a fixed 0.95 stride from a fixed
   0.78 inset, which on a 2.2-wide cottage front put EVERY opening within 30 cm of
   the middle — where the door-clearance rule then deleted it. That is why so many
   of the small houses in the town had a blank elevation with a door in it, and it
   is the first thing the stroll mode shows you. The grid now fits the wall it is
   on: two, three or four bays, spread across the width, and the door is moved off
   centre rather than the windows being deleted around it. */
function addWindows(g, count, wallW, wallH, wallD, seed, priv, style) {
  const S = style || WIN_DEF;
  const upD = S.upD || wallD, upZ = S.upZ || 0;
  const ww = S.ww || wallW, wx = S.wx || 0, dx = S.doorX || 0;
  const upW = S.upW || ww;
  const cols = clamp(Math.round((ww - .5) / .95), 2, 4);
  const span = Math.max(.9, ww - 1.02);
  let lit = null;
  const glass = on => {
    if (!on) return matFor(GLASS_OFF, 'wall');
    if (!lit) lit = winMat(0xffd68c, priv);
    return lit;
  };
  /* TWO WINDOWS IN ONE HOLE, AND THEN A HOLE TOO FEW. The grid has at most `cols`
     bays and `count` is 7 or 8 on the big plans, so `i % cols` comes round two and
     three times; the storey and the side are separate rolls, and when both of them
     repeat as well the opening was placed EXACTLY on top of one already built —
     1.1 duplicate panes on a villa and 1.5 on a manor, ten triangles apiece drawn
     inside another ten and z-fighting against them.
       Keying the slot stopped the z-fight and DROPPED the opening, which is the
     wrong half of the fix: the elevation it belonged to just went blank instead,
     and so did every elevation the door-clearance rule cleared. Count the grid
     and there was never a shortage — 3 bays × 2 storeys × 2 sides is twelve
     slots, the door rule takes one column's worth of the front ground floor, and
     seven or eight openings still have nine or ten places to be. So an opening
     that cannot have the slot it drew WALKS to the next free one (stride 5, which
     is coprime with 8, 12 and 16, so it visits every slot exactly once before it
     gives up) — one bay along and round to the other elevation, which is where a
     real builder would have put it.
       It is NOT free, whatever the arithmetic above suggests: every opening now
     lands, so a villa gains ~1.9 panes and a manor ~2.1 over what the third pass
     drew — 13 triangles a house. `count` is one lower on both of those plans to
     pay for it, which still leaves them with more glass than they had and every
     bay the grid lays out filled. */
  const taken = new Set(), nSlot = cols * 4, twoS = wallH > 2.4;
  const xAt = c => wx - span / 2 + c * span / (cols - 1);
  // A slot is unusable if it is already glazed, if it is upstairs on a cottage
  // that has no upstairs, or if it is the front ground-floor bay the door is in.
  const shut = s => taken.has(s) || ((s & 2) !== 0 && !twoS) ||
    ((s & 1) === 1 && (s & 2) === 0 && Math.abs(xAt(s >> 2) - dx) < .74);
  for (let i = 0; i < count; i++) {
    const side = seededR(seed * 1.7 + 300 + i) < .64 ? 1 : -1;   // two thirds face the lane
    const upper = twoS && seededR(seed + i) < .5;
    let slot = (i % cols) * 4 + (upper ? 2 : 0) + (side > 0 ? 1 : 0);
    for (let k = 0; k < nSlot && shut(slot); k++) slot = (slot + 5) % nSlot;
    if (shut(slot)) continue;                                    // a wall with no room left
    taken.add(slot);
    const sd = (slot & 1) ? 1 : -1, up = (slot & 2) !== 0, x = xAt(slot >> 2);
    const y = wallH * .42 + (up ? wallH * .34 : 0);
    const z = up ? upZ + sd * upD / 2 : sd * wallD / 2;
    addPane(g, S, x, y, z, sd > 0 ? 0 : Math.PI,
      glass(seededR(seed + 40 + i) < .8), seed * 1.31 + 70 + i);
  }
  /* THE FLANKS WERE BLANK, and a lane is two rows of flanks: from 200 units up
     you only ever see a house's front and its roof, but at 1.35 units you walk
     PAST buildings and what you are looking at most of the time is a gable end.
     Every dwelling in the town had two of them and neither had an opening in it.
     Same grid logic turned ninety degrees. `ends` is 0 or 1 on the plans whose
     flank is already occupied by a cross-wing — a window into a 10 cm gap between
     two ranges is ten triangles nobody will ever see. */
  const ends = S.ends === undefined ? 2 : S.ends, one = !!S.endSign;
  for (let i = 0; i < ends; i++) {
    const sx = one ? S.endSign : (i % 2 ? 1 : -1);
    // With both flanks free they are glazed in pairs, one storey then the other;
    // with only one free they climb it. Either way a two-storey gable end never
    // ends up with a single window in the bottom corner of four metres of plaster.
    const upper = wallH > 2.4 && (one ? i % 2 === 1 : i >= ends / 2);
    const dd = upper ? upD : wallD, cz = upper ? upZ : 0;
    const z = cz + (seededR(seed * 5.1 + 520 + i) - .5) * Math.max(.5, dd - 1.7);
    const y = wallH * .42 + (upper ? wallH * .34 : 0);
    addPane(g, S, wx + sx * (upper ? upW : ww) / 2, y, z, sx * Math.PI / 2,
      glass(seededR(seed * 5.1 + 540 + i) < .72), seed * 1.9 + 560 + i);
  }
  return lit;
}
// Free-standing lit panes (towers, halls) that don't fit the façade grid.
function lamplight(g, spots, hex) {
  const lit = winMat(hex || 0xffd68c);
  for (const [x, y, z, w, h, ry] of spots) {
    const m = new THREE.Mesh(GEO.unit, lit);
    m.scale.set(w, h, .08); m.position.set(x, y, z); m.rotation.y = ry || 0; g.add(m);
  }
  return lit;
}

/* ═══ the dwelling roof kit ═════════════════════════════════════
   AESTHETIC.md: "Roofs are the biggest surface the camera sees — they carry the
   most detail budget." They were carrying none. A cottage roof was one coloured
   prism or one pointed cone, with the prism's extrude caps — the two triangles a
   real building plasters and calls its gable ends — left tile-coloured.

   What a roof is now, for about 22 triangles:
     · the slopes;
     · the PLASTER GABLE ENDS, inset so the tile edge shows round them as a verge;
     · a ridge — dark tiles bedded in mortar, or on a thatched cottage a fat pale
       roll of straw;
     · on thatch, the deep eave course that makes reed read as a mattress rather
       than as tile in a different colour;
     · a pitch that is not the same on the house next door.
   `R` is one object per house so none of this re-derives a colour per roof. */

/** Anything cut in the roof's own unit space and worn at the roof's own scale:
 *  the plaster gable end, the barge boards, the eaves fascia. */
function roofSkin(A, geo, hex, w, hh, d, x, y, z, alongX) {
  const m = new THREE.Mesh(geo, matFor(hex, 'trim'));
  if (alongX) { m.rotation.y = Math.PI / 2; m.scale.set(d, hh, w); } else m.scale.set(w, hh, d);
  return A(at(tag(m, 'trim'), x, y, z));
}

/** @param {Object} R roof kit @param {boolean} [plain] a dormer: ends, no ridge */
function gabRoof(A, R, w, h, d, x, y, z, alongX, plain) {
  const hh = plain ? h : h * R.pitch;
  A(at(mgab(w, hh, d, R.roof, alongX), x, y, z));
  roofSkin(A, GEO.gend, R.gable, w, hh, d, x, y, z, alongX);
  if (y + hh > R.top) R.top = y + hh;
  if (plain) return;
  // The verge and the eaves. Reed has neither — see the roof-furniture note.
  if (!R.reed) roofSkin(A, GEO.gtrim, R.barge, w, hh, d, x, y, z, alongX);
  /* …AND WHAT REED HAS INSTEAD, which a gable was going without. `hipRoofAt` has
     always given thatch its deep overhanging eave course — the fat bottom course
     that makes reed read as a mattress rather than as tile in a different colour
     — and this function never did, so the one roof in the town wearing the wrong
     material was a thatched GABLE. Same eight triangles as the hip's, wrapping
     the verge as well as the eave, because that is what reed does at a gable end.
     TAGGED 'trim', for the reason written out over the hip's own eave course: it
     is deliberately WIDER than the roof it hangs under, `impRole` gives the roof
     contest to the widest 'roof' mesh, and that is exactly how the far town lost
     every thatched hip to a flat-topped box once already. */
  else roofSkin(A, GEO.gable, R.eave, w * 1.06, hh * .34, d * 1.07, x, y - hh * .07, z, alongX);
  ridge(A, R, (alongX ? w : d) * (R.reed ? .93 : .99), R.reed ? .22 : .15, alongX, x, y + hh, z);
}

/* THE RIDGE IS A LITTLE ROOF, NOT A BOX. It was a `mb` — twelve triangles, of
   which the underside and both ends are bedded in the slopes it sits on. The
   prism this file already owns is eight, it is the right SHAPE (a capping tile
   has two faces meeting at the ridge line, and a thatched roof's is a rolled
   straw hip), and `mgab` already knows how to turn it to run either way. Four
   triangles back on every ridge in the town, and there are about 1.4 per house:
   this is what the cross-wings and porches below are paid for with.
   `impRole` scores a gable prism as a ROOF CANDIDATE rather than as mass, which
   is a change from the box — but the roof contest takes the LARGEST candidate
   and a ridge is a twentieth of the roof it caps, so it is filtered by
   IMP_ROOF_REL before it is ever compared. */
function ridge(A, R, span, h, alongX, x, yTop, z) {
  const cross = R.reed ? .34 : .30;
  const y0 = yTop - h * .62;
  A(at(mrid(alongX ? span : cross, h, alongX ? cross : span, R.ridge, alongX), x, y0, z));
  // THE CRESTING IS A ONE-SHOT. A house with a cross-wing raises three ridges and
  // a crested outbuilding is nobody's idea of a village; `R.crest` is consumed by
  // the first ridge that asks for it, which is always the main range's.
  if (!R.crest) return;
  R.crest = false;
  const cr = tag(new THREE.Mesh(GEO.crest, matFor(R.crestHex, 'trim')), 'trim');
  cr.scale.set(span * .80, .17, 1);
  if (!alongX) cr.rotation.y = Math.PI / 2;
  A(at(cr, x, y0 + h * .88, z));
}

/** The hipped roof. `y` is the CENTRE, exactly as the cone it replaced. */
function hipRoofAt(A, R, w, d, h, x, y, z) {
  const hh = h * R.pitch, yy = y + (hh - h) / 2;         // the eave line stays put
  A(at(mp(w, d, hh, R.roof), x, yy, z));
  // A hip has four eaves and no verge at all, so it takes the fascia and nothing
  // else. Same rule as the gable: never on reed.
  if (!R.reed) roofSkin(A, GEO.htrim, R.barge, w, hh, d, x, yy, z, false);
  ridge(A, R, w * 2 * RIDGE_HALF + .28, R.reed ? .20 : .15, true, x, yy + hh / 2 + .06, z);
  // TAGGED 'trim', AND IT MATTERS. The reed eave course is deliberately WIDER
  // than the roof it sits under (that overhang is the whole point of thatch),
  // and `impRole` scores every 'roof' mesh into a contest the widest one wins.
  // So the far town picked the eave course as the roof of every hipped thatched
  // cottage and drew it `hh*.30` tall — a third of the real height — which is
  // why they read as flat-topped from a distance. Only `userData.k` changes
  // here: the material is untouched, so the merge bucket and the near view are
  // exactly as they were.
  if (R.reed) A(at(tag(mp(w * 1.05, d * 1.06, hh * .30, R.eave), 'trim'), x, yy - hh * .35, z));
  if (yy + hh / 2 > R.top) R.top = yy + hh / 2;
}

/** Sill, wall-plate, two studs and two braces on the +z face — 6 boards, 12
 *  triangles, and the difference between a plastered box and a cottage somebody
 *  framed. The centre is left clear: a stud through the front door reads as a
 *  mistake, and the braces are what actually say "oak frame" at ten pixels. */
function timbers(A, w, h, x, y, z, hex) {
  for (const dy of [.11, h - .11]) A(at(board(w, .18, hex, 'trim', 1), x, y + dy, z));
  for (const s of [-1, 1]) {
    A(at(board(.17, h * .92, hex, 'trim', 1), x + s * w * .34, y + h / 2, z));
    A(at(board(.15, h * .72, hex, 'trim', 1), x + s * w * .19, y + h * .47, z)).rotation.z = s * .60;
  }
}

/** The biggest box standing on the ground: what a plinth goes under and a frame
 *  goes on. Measured off what was just built, so no silhouette has to remember
 *  to ask, and no builder repeats its own dimensions. */
function mainMass(g) {
  let best = null, bA = 0;
  for (const c of g.children) {
    if (!c.isMesh || !BOXES.has(c.geometry) || c.userData.k !== 'wall') continue;
    if (c.position.y - c.scale.y / 2 > .14) continue;
    const a = c.scale.x * c.scale.z;
    if (a > bA) { bA = a; best = c; }
  }
  return best;
}

/* ═══ the fabric a plot is dressed in ═══════════════════════════
   The visible half of the village tier, and the half the camera sees most of:
   a hamlet is a rough paling fence and a woodpile, a market town is a low
   fieldstone wall, a clipped hedge, a lantern beside the door and a water butt
   under the eave. Boundaries always leave a gap for the path, because a fence
   with no gate reads as a pen.

   TWO INVARIANTS, both invisible from outside and both load-bearing:
     · every piece is tagged 'wood' or 'trim', NEVER 'wall'/'stone'/'roof', so
       `impRole` scores it 0 and the far-town impostor keeps measuring the
       dwelling instead of its garden fence;
     · every piece lands in a merge bucket the body already opened (same
       roughness, no map, no emissive — the lantern reuses the town's ONE lit
       pane material), so a dressed plot costs the same two draw calls an
       undressed one did. Only vertices, and only on plots near enough to be
       drawn real at all.
   Budget: at most one boundary and at most ONE clutter item per plot. */
const PLOT_W = [0, 2.4, 2.6, 3.0, 3.2, 3.4, 3.6, 3.6];   // by house tier
const PLOT_F = [0, 2.0, 2.1, 2.4, 2.5, 2.6, 2.7, 2.8];   // …and its front line: a hedge
                                                        // planted against the wall reads as a
                                                        // packing crate, not as a garden

function dressPlot(g, t, seed, paint, lit) {
  if (t < 1) return lit;                                   // a tent has no garden
  const F = FABRICS[VTIER], A = o => { g.add(o); return o; };
  const W = PLOT_W[t], fz = PLOT_F[t], hw = W / 2 + .35;
  const r = n => seededR(seed * 3.71 + n * 1.13);
  // 0 at the plaza, 1 out on the frontier. paintHouse publishes it; anything
  // that does not (flavours, landmarks) sits in the middle.
  const edge = paint && typeof paint.edge === 'number' ? paint.edge : .5;

  /* THE BOUNDARY — two runs with the path between them, and the single loudest
     thing the village tier says: a market town is walled and a hamlet is paled,
     and you read that from the lane before you read anything else about the
     place. It is also the most expensive object on a plot — the fieldstone wall
     was 72 triangles, more than the roof of the house behind it.
     Every piece of it stands ON THE GROUND, and the coping and the gate piers
     have something or nothing above them, so the whole boundary is built out of
     `ubox`/`utube` (see the openBox note). Same stones, same coping, same gate:
     56 triangles for the wall, 124 for the paling. Nothing about the signal
     changes — the pieces that went are the ones lying face-down in the grass. */
  if (r(1) < F.enclosed * (1 - .58 * edge)) {
    const runs = [[-hw, -.62], [.62, hw]];
    if (F.boundary === 'paling') {
      for (const [a, b] of runs) {
        const n = Math.max(2, Math.round((b - a) / .30));
        for (let i = 0; i < n; i++) {                      // riven boards, none of them straight
          const x = a + (i + .5) * (b - a) / n, h = .62 + r(i + 4) * .16;
          A(at(mb(.09, h, .05, i % 2 ? OAK_S : shade(OAK_S, -.10), 'wood', 1), x, h / 2, fz)).rotation.z = (r(i + 20) - .5) * .13;
        }
        A(at(mb(b - a, .06, .07, shade(OAK_S, -.16), 'wood'), (a + b) / 2, .44, fz));
      }
    } else if (F.boundary === 'hedge') {
      for (const [a, b] of runs) {                         // three clipped lengths, none level
        const n = Math.max(1, Math.round((b - a) / .85));
        for (let i = 0; i < n; i++) {
          const w = (b - a) / n, h = .68 + r(i + 9) * .13;
          A(at(mb(w * 1.10, h, .46 + r(i + 14) * .07, mix(MOSS, 0x35472C, .18 + r(i + 30) * .3), 'wood', 1),
            a + (i + .5) * w, h / 2, fz));
        }
      }
    } else {                                               // a low fieldstone wall, on its coping
      for (const [a, b] of runs) {
        A(at(mb(b - a, .56, .34, FIELD, 'wood', 2), (a + b) / 2, .28, fz));     // …the coping is its lid
        A(at(mb(b - a, .09, .42, FIELD_D, 'wood', 1), (a + b) / 2, .60, fz));
      }
      for (const sx of [-.62, .62]) A(at(mb(.36, .84, .36, FIELD_D, 'wood', 1), sx, .42, fz));  // gate piers
    }
  }

  /* one piece of yard clutter — the thing that says someone lives here */
  if (r(2) < F.clutter * (1 - .46 * edge)) {
    const pick = Math.floor(r(3) * 4), sx = r(7) < .5 ? -1 : 1;
    if (pick === 0) {
      /* A WOODPILE, STACKED AGAINST THE FLANK — and it used to be drawn half
         inside the house. `W/2 - .1` is the PLOT's half-width and a plot is
         barely wider than the dwelling standing on it, so a 1.08-long log
         centred on that line put 55 % of its length inside the wall at every
         tier from 3 up. What showed was three log ends projecting out of the
         plaster with nothing under them — logs hanging in the air at the wall,
         which is what the quality sweep saw and called floating. A woodpile
         LEANS ON a wall; it never grows through one.
         So it is measured off the mass the house actually built rather than off
         the plot: `mainMass` knows the range's real half-width whatever plan was
         drawn, and the stack starts one log-radius clear of it. The logs run
         front-to-back with their sawn ends to the lane, three on the ground and
         two nested in the valleys between them — which is how cordwood is
         stacked and, at 16 triangles a log against `GEO.trunk`'s 24, one log
         cheaper than the four that were floating. */
      const M = mainMass(g);
      const LR = .155, LL = 1.06, step = LR * 2 + .012;
      const wx = M ? M.scale.x / 2 : W / 2 - .55;
      const px = (M ? M.position.x : 0) + sx * (wx + LR + .05);
      const pz = M ? M.position.z + M.scale.z * .12 : fz - 1.15;
      for (let i = 0; i < 5; i++) {
        const row = i > 2 ? 1 : 0, k = i - row * 3;
        const l = new THREE.Mesh(GEO.log, matFor(i % 2 ? OAK_S : shade(OAK_S, -.15), 'wood'));
        l.scale.set(LL, LR, LR); l.rotation.y = Math.PI / 2;   // sawn ends to the lane
        A(at(tag(l, 'wood'), px + sx * (k + row * .5) * step, LR + row * LR * 1.73, pz));
      }
    } else if (pick === 1) {                               // a water butt under the eave
      const butt = new THREE.Mesh(GEO.trunk, matFor(OAK_D, 'wood'));
      butt.scale.set(1.7, .95, 1.7); A(at(butt, sx * (W / 2 - .25), .38, fz - .5));
      A(at(mb(.42, .05, .42, IRON, 'wood', 1), sx * (W / 2 - .25), .77, fz - .5));
    } else if (pick === 2) {                               // a washing line, hung out
      for (const dz of [-.1, -1.5]) A(at(mb(.08, 1.5, .08, OAK_S, 'wood', 1), sx * (W / 2 + .2), .75, fz - .9 + dz * .5));
      A(at(mb(.04, .04, 1.5, shade(OAK_S, -.2), 'wood'), sx * (W / 2 + .2), 1.42, fz - 1.05));
      for (let i = 0; i < 3; i++)
        A(at(mb(.03, .44 + r(i + 40) * .16, .34, mix(LIME, paint.wall, .35), 'trim'),
          sx * (W / 2 + .2), 1.16, fz - .55 - i * .42));
    } else {                                               // a garden plot, dug over
      // A BOX, NOT A GROUND PLATE. `gquad` mints the 'ground' surface role, and a
      // role is its own merge bucket — so one dug bed per plot is one mesh that
      // CANNOT merge into the body, i.e. one extra draw call and one extra
      // sub-mesh on every dressed house. Measured on the founding cascade: draws
      // 126 -> 1448, cpu p50 2.1 -> 5.8 ms, drainMaxMs 20 -> 1063. The ground
      // role is worth a draw call on a landmark's ten-unit apron and is worth
      // nothing at all on a 1.5-unit vegetable patch.
      A(at(mb(1.5, .07, 1.1, MUD, 'trim', 1), sx * (W / 2 - .5), .035, fz - 1.0));
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(GEO.crop, matFor(mix(MOSS, 0x8C9C5E, r(i + 55)), 'wood'));
        c.scale.setScalar(.8); tag(c, 'wood');
        A(at(c, sx * (W / 2 - .5) + (i % 2 ? .34 : -.34), .2, fz - 1.28 + Math.floor(i / 2) * .55));
      }
    }
  }

  /* a lantern beside the door — the town lighting itself as it prospers */
  if (r(5) < F.lantern * (1 - .62 * edge)) {
    const m = winMat(0xffd68c); lit = lit || m;
    A(at(mb(.10, 1.05, .10, IRON, 'wood', 1), .74, .52, fz - .18));
    A(at(mb(.14, .10, .34, IRON, 'wood'), .74, 1.02, fz - .34));
    const pane = new THREE.Mesh(GEO.unit, m); pane.scale.set(.20, .26, .20);
    A(at(pane, .74, .86, fz - .48));
    A(at(mb(.26, .08, .26, IRON, 'wood'), .74, 1.02, fz - .48));
  }
  return lit;
}

/* ═══ houses — 8 tiers × 3 silhouettes ══════════════════════════ */
/**
 * A dwelling. The silhouette variant is derived from `seed` so a street of
 * sixty never photocopies; the colours all arrive pre-decided in `paint`.
 * @param {number} tier 0..7 @param {Paint} paint from paintHouse() @param {number} seed
 * @returns {THREE.Group}
 */
export function buildHouse(tier, paint, seed) {
  const g = new THREE.Group();
  const t = clamp(tier | 0, 0, 7);
  const { roof, wall, wall2, trim, stone, accent, door } = paint;
  const v = Math.floor(seededR(seed * 2.31 + 4.4) * 3);
  const A = o => { g.add(o); return o; };
  let lit = null, hTop = 1.6, chim = null, flagObj = null, altLabel = null;
  /* THE ROOF KIT — one object per house, read by every roof it raises. `pitch`
     is why a lane of cottages stops reading as one model stamped out sixty
     times; `top` is the real apex, measured rather than hand-declared, so hTop
     no longer drifts from the geometry when a pitch changes. */
  const R = {
    roof, gable: mix(wall, LIME, .10), reed: !!paint.reed, top: 0,
    pitch: .90 + seededR(seed * 5.13 + 2.7) * .22,
    ridge: paint.reed ? shade(roof, .11) : shade(roof, -.17),
    eave: shade(roof, -.14),
    // Barge boards and fascia: the house's own timber, weathered a shade further
    // than the frame on its front — a board on a roof edge is the first thing on
    // a building to silver. Crestings are fired clay and cost money, so a tiled
    // manor or merchant's house has them and a cottage does not.
    barge: greyed(mix(trim, OAK_D, .55), .18),
    crestHex: shade(mix(roof, TILE_D, .34), -.10),
    crest: t >= 6 && !paint.reed
  };
  const gb = (w, h, d, x, y, z, ax, plain) => gabRoof(A, R, w, h, d, x, y, z, ax, plain);
  const hp = (w, d, h, x, y, z) => hipRoofAt(A, R, w, d, h, x, y, z);
  // A chimney is a stack, a corbelled cap and a pot. The cap and the pot are
  // 'trim' so `impRole` still measures the stack itself as the chimney.
  const stack = (w, h, x, y, z) => {
    // The shaft is bedded in the roof and wears its own cap; the pot stands on the
    // cap. Only the CAP keeps its underside — a corbel is a thing you see from below.
    A(at(mb(w, h, w, stone, 'stone', 2), x, y, z));
    A(at(mb(w * 1.34, .12, w * 1.34, capLum(shade(stone, -.30), .20), 'trim'), x, y + h / 2 + .06, z));
    A(at(mb(w * .46, .32, w * .46, TILE_D, 'trim', 1), x, y + h / 2 + .29, z));
    chim = new THREE.Vector3(x, y + h / 2 + .58, z);
  };

  /* ── HOW THIS HOUSE'S OPENINGS ARE MADE ──────────────────────────
     One object, read by every window on the elevation. The reveal is limewash
     over the wall's own colour so the opening reads as a hole with a splayed
     edge; the bars are the roof timber gone grey; the sill is dressed stone off
     the same footing the plinth is cut from. Cross windows and shutters are a
     wealth cue and a town cue: a cottage on the frontier has a plain mullion and
     no paint, a merchant's house on the square has both. */
  const WIN = {
    reveal: mix(wall, 0xFFF4DE, .34),
    bar: greyed(mix(trim, OAK_D, .74), .20),
    sill: mix(shade(wall, -.16), FIELD_L, .46),
    cross: t >= 4 || (t >= 2 && seededR(seed * 4.19 + 8.8) < .34),
    // …and everything that did NOT get a cross window is old enough to be leaded.
    // Below tier 2 there is no glazing worth naming, so it stays a bar.
    lead: t >= 2 && t < 4 && !(seededR(seed * 4.19 + 8.8) < .34),
    shut: t >= 3 ? .30 * (1 - .55 * (typeof paint.edge === 'number' ? paint.edge : .5)) : 0,
    shutHex: greyed(mix(paint.door, MOSS, .28), .16),
    // The rest is where the walls ARE, and each plan below fills it in. `ends` is
    // how many openings the two gable ends carry between them: a cottage flank
    // takes one, and a three-metre farmhouse flank with a single window in the
    // bottom corner is the thing that reads as a warehouse from the lane.
    upD: 0, upW: 0, upZ: 0, ww: 0, wx: 0, doorX: 0, ends: t >= 4 ? 3 : 2, endSign: 0
  };
  // One opening off the grid — a gable, a dormer, an oriel's cheek. It shares the
  // town's ONE lit-pane material, so it costs nothing but its own ten triangles.
  const win = (x, y, z, yaw, on, k) => {
    if (on && !lit) lit = winMat(0xffd68c);
    addPane(g, WIN, x, y, z, yaw, on ? lit : matFor(GLASS_OFF, 'wall'), seed * 2.11 + x * 13.7 + y * 5.3, k);
  };
  /* THE DOOR IS NOT IN THE MIDDLE. On a two-bay cottage front a central door
     collides with both bays and the clearance rule deletes them, which is the
     blank-walled cottage the stroll mode kept finding; on a three-bay front it
     only ever costs the middle one. Standing the door on an outer bay costs
     nothing, is what a real cottage looks like, and gives the grid its bay back.
     It also publishes the grid to `WIN`, so the windows and the door are laid out
     from ONE decision rather than two that have to be kept in step by hand.
     `fx` forces the door somewhere the grid did not choose — a porch has already
     decided where the front door is, and the grid has to be told rather than
     asked. `wallD` is only ever the door's own z-plane, so a porched plan hands
     in the porch's front face instead of the wall's. */
  const dr = (wallD, wallW, h, cx, fx) => {
    const span = Math.max(.9, wallW - 1.02), x0 = cx || 0;
    const cols = clamp(Math.round((wallW - .5) / .95), 2, 4);
    const r = seededR(seed * 6.1 + 2.2);
    WIN.ww = wallW; WIN.wx = x0;
    WIN.doorX = fx === undefined
      ? x0 + (cols > 2 && r < .40 ? 0 : (r < .70 ? -1 : 1) * span / 2)
      : fx;
    addDoor(g, wallD, h, door, WIN.doorX);
  };

  /* ── THE MASSING KIT ─────────────────────────────────────────────
     Tiers 5 and 6 are 625 of the town's 977 dwellings and both were the same
     object twice over: a ground storey, an upper storey of IDENTICAL plan, and a
     string course between them. From 200 units up that is a roof with a box under
     it and nobody could tell; from the lane it is 625 shoeboxes.

     A real village house is a RANGE with things done to it. Five verbs, and the
     rule for all of them is that they redistribute the footprint rather than
     inflate it — the envelope of every plan below is within 4 % of the box it
     replaces, so `impostorOf` measures the same silhouette it always did and the
     far town does not know any of this happened. */

  // Two storeys, the upper one JETTIED out over the lane on its bressummer beam.
  // This costs NOTHING — the two boxes were already there, they were merely the
  // same size, which is the one thing a jettied storey is not. `F` carries the
  // two front faces out, because a window in the upper storey is 26 cm further
  // into the street than a window below it and putting them in one plane buries
  // half of them in the wall.
  const EL = { wd: 3, ud: 3, h0: 2, dz: 1.5, dx: 0, ww: 3, wx: 0, uw: 3, uz: 0 };
  const storeys = (w, d, h0, h1, cx) => {
    const jz = .26, x0 = cx || 0;
    // Both storeys are `utube`s: the ground floor stands on the ground and wears
    // the string course, the upper one is bedded in the string course and wears
    // the roof. Eight faces nobody could see, on two thirds of the town's houses.
    A(at(mb(w, h0, d, wall, 'wall', 2), x0, h0 / 2, 0));
    A(at(mb(w + .13, h1, d + jz, wall2, 'wall', 2), x0, h0 + h1 / 2, jz / 2));
    A(at(mb(w + .27, .14, d + jz + .14, trim, 'trim'), x0, h0 + .03, jz / 2));
    EL.wd = d; EL.ud = d + jz; EL.h0 = h0; EL.dz = d / 2; EL.dx = x0;
    EL.ww = w; EL.wx = x0; EL.uw = w + .13; EL.uz = jz / 2;
    return h0 + h1;
  };

  // A gabled CROSS-WING: a second range set at right angles with its gable end to
  // the lane. The commonest plan in an English village after the plain range, and
  // the one that does most to a street, because a gable is a different shape from
  // an eave and half the houses now present one.
  const crossWing = (w, d, h, x, z, rh) => {
    A(at(mb(w, h, d, wall, 'wall', 2), x, h / 2, z));
    gb(w + .28, rh, d + .26, x, h, z, false);
    const zf = z + d / 2;                                  // …and it is glazed, or it is a barn
    win(x, h * .30, zf, 0, seededR(seed + x * 3.1 + 1.7) < .8);
    win(x, h * .73, zf, 0, seededR(seed + x * 3.1 + 2.9) < .7);
    win(x, h + rh * .30, z + (d + .26) * .505, 0, seededR(seed + x * 3.1 + 4.3) < .5, .74);
  };

  // A single-storey back kitchen with the main roof swept down over it: a
  // CATSLIDE. The slope is tagged 'trim', not 'roof' — same colour, same merge
  // bucket, but `impRole` then scores it 0, so a rotated box never confuses the
  // far town's roof contest. The outshut itself is honest mass and is measured.
  // `lift` is how far above the outshut's wall-plate the sweep starts; a cottage
  // is half the height of a manor and the same 30 cm reads as a hole in the wall.
  const catslide = (w, d, h, backZ, eaveZ, eaveY, lift) => {
    A(at(mb(w, h, d, wall2, 'wall', 1), 0, h / 2, backZ - d / 2));
    const z0 = backZ - d - .18, y0 = h + (lift === undefined ? .30 : lift);
    const run = eaveZ - z0, rise = eaveY - y0;
    const sl = A(at(mb(w + .34, .16, Math.hypot(run, rise), R.roof, 'trim'),
      0, (eaveY + y0) / 2, (eaveZ + z0) / 2));
    sl.rotation.x = -Math.atan2(rise, run);
  };

  // An enclosed gabled PORCH over the door — a draught lobby, and the one piece
  // of a cottage that is always at eye level. It takes the door WITH it: the
  // front wall is no longer where the front door is, which is the whole point.
  const porch = (w, h, d, x) => {
    const z = EL.wd / 2 + d / 2 - .10;
    A(at(mb(w, h, d, wall2, 'wall', 2), x, h / 2, z));
    gb(w + .24, .46, d + .30, x, h, z, false, true);
    EL.dz = z + d / 2; EL.dx = x;
  };

  // A DORMER in the roof slope. Kept under .80 in both plan dimensions on
  // purpose: that is `IMP_TALL_W`, the width at which impostorOf stops calling a
  // tall thing decoration and starts folding it into the mass box.
  const dormer = (x, y, z, w) => {
    A(at(mb(w, .68, .92, wall2, 'wall', 2), x, y, z));   // bedded in the slope, capped by its own roof
    gb(w + .18, .44, 1.02, x, y + .34, z, true, true);
    win(x, y + .02, z + .47, 0, seededR(seed + x * 9.7 + 5.5) < .75, .72);
  };

  // An external chimney BREAST climbing the gable wall, which is what a stack
  // added to a house that was built without one actually looks like.
  const breast = (x, z, w, d, h) => A(at(mb(w, h, d, mix(stone, FIELD_D, .42), 'stone', 1), x, h / 2, z));

  // A BAY, and above the ground floor an ORIEL: the merchant's brag.
  const bay = (x, y, z, w, h) => {
    A(at(mb(w, h, .60, wall2, 'wall'), x, y + h / 2, z + .30));
    A(at(mb(w + .20, .13, .78, trim, 'trim'), x, y + h + .07, z + .30));
    win(x, y + h * .54, z + .60, 0, true);                 // glazed on all three faces —
    for (const s of [-1, 1])                               // an unglazed bay is a buttress
      win(x + s * w / 2, y + h * .54, z + .30, s * Math.PI / 2, true, .78);
  };

  if (t === 0) {
    // A tent should read poor, not neon: dun canvas, a dark doorway, guy ropes
    // and a patch of trodden earth so it is pitched on the ground, not dropped.
    const canvas = mix(0xB9AE93, roof, .22);
    const earth = A(at(plate(2.9, 2.9, matFor(0x6A6150, 'wall')), 0, .05, 0));
    earth.rotation.x = -Math.PI / 2; earth.userData.noCast = true;
    if (v === 2) {                                             // lean-to
      A(at(mgab(2.2, 1.3, 2.1, canvas, true), 0, 0, 0));
      A(at(mb(.12, 1.35, .12, trim, 'wood'), 0, .68, .95));
      A(at(mb(.62, .78, .05, 0x241D16, 'wood'), 0, .39, 1.03));
      hTop = 1.35;
    } else {
      const r = v === 1 ? 1.0 : 1.15, h = v === 1 ? 1.7 : 1.5;
      A(at(cone4(r, h, canvas, 'wall'), 0, h / 2, 0));
      A(at(mb(.5, h * .52, .05, 0x241D16, 'wood'), 0, h * .26, r * .78));   // door flap
      for (const s of [-1, 1]) {                                            // guy ropes
        const rope = A(at(mb(.045, h * .95, .045, 0x6B6150, 'wood'), s * (r * .92), h * .42, -r * .5));
        rope.rotation.z = -s * .58; rope.rotation.x = .22;
        A(at(mb(.11, .16, .11, trim, 'wood'), s * (r * 1.42), .08, -r * .78));
      }
      if (v === 1) A(at(mb(.6, .4, .5, trim, 'wood'), 1.05, .2, .5));
      hTop = h;
    }
  } else if (t === 1) {
    if (v === 1) {
      A(at(mb(2.2, 1.5, 2.2, wall, 'wall', 2), 0, .75, 0));
      gb(2.6, .95, 2.5, 0, 1.5, 0, true);
      dr(2.2, 2.2, 1.1); lit = addWindows(g, 2, 2.2, 1.3, 2.2, seed, false, WIN); hTop = 2.45;
    } else {
      A(at(mb(2.4, 1.4, 2, wall, 'wall', 2), 0, .7, 0));
      gb(2.6, .62, 2.3, 0, 1.4, 0, true);                   // a shallow gable, not a flat plate
      if (v === 2) {                                           // lean-to shed on the flank
        A(at(mb(1.2, .95, 1.6, wall2, 'wall', 2), 1.7, .48, .2));
        gb(1.4, .42, 1.7, 1.7, .95, .2, true, true);
      }
      dr(2, 2.4, 1.05); hTop = 1.6;
    }
  } else if (t === 2) {
    if (v === 1) {
      A(at(mb(2.6, 1.9, 2.2, wall, 'wall', 2), 0, .95, 0));
      gb(2.9, 1.25, 2.5, 0, 1.9, 0, true);
      stack(.3, .85, .85, 2.5, 0);
      dr(2.2, 2.6, 1.2); lit = addWindows(g, 3, 2.6, 1.6, 2.2, seed, false, WIN); hTop = 3.15;
    } else if (v === 2) {                                      // L-plan with a porch
      A(at(mb(2.4, 1.8, 2.2, wall, 'wall', 2), -.35, .9, 0));
      hp(2.6, 2.4, 1.0, -.35, 2.28, 0);
      A(at(mb(1.5, 1.4, 1.5, wall2, 'wall', 2), 1.35, .7, .5));
      hp(1.7, 1.7, .8, 1.35, 1.78, .5);
      for (const dx of [-1.0, .3]) A(at(mb(.12, 1.1, .12, trim, 'wood', 1), dx, .55, 1.35));
      WIN.ends = 1; WIN.endSign = -1;              // the flank is the wing's
      dr(2.2, 2.4, 1.2, -.35); lit = addWindows(g, 3, 2.4, 1.5, 2.2, seed, false, WIN); hTop = 3.0;
    } else {
      A(at(mb(2.6, 1.8, 2.2, wall, 'wall', 2), 0, .9, 0));
      hp(2.8, 2.4, 1.1, 0, 2.32, 0);
      dr(2.2, 2.6, 1.2); lit = addWindows(g, 3, 2.6, 1.5, 2.2, seed, false, WIN); hTop = 3;
    }
  } else if (t === 3) {
    /* THE COTTAGE, IN FIVE PLANS — and this is the tier the town is actually
       MADE OF below the wealthy core. Tiers 5 and 6 got their five plans apiece
       last night; 3 and 4 were left as one prism with a roof and a chimney, which
       is fine at 200 units up and is a row of shoeboxes from the lane.

       A tier-3 dwelling is HUMBLER than a tier-5, and the mistake to avoid is
       giving it the villa's kit at four fifths scale. It gets a catslide outshut,
       a lean-to, an off-centre door, a single dormer, a porch — never an H-plan,
       never an oriel, never a jetty. Same rule as the tiers above: redistribute
       the footprint, do not inflate it. Every plan below keeps the 3.0 × 2.6
       range and the 2.1 wall-plate it has always had, so the far town measures
       the silhouette it always did. */
    const v3 = Math.floor(seededR(seed * 4.63 + 7.29) * 5);
    if (v3 === 0) {                                            // gable + dormer
      A(at(mb(3, 2.1, 2.6, wall, 'wall', 2), 0, 1.05, 0));
      gb(3.3, 1.5, 2.9, 0, 2.1, 0, true);
      dormer(-.62, 2.44, .96, .72);
      stack(.34, .95, 1.0, 2.9, -.3);
      dr(2.6, 3, 1.3); lit = addWindows(g, 4, 3, 1.8, 2.6, seed, false, WIN); hTop = 3.6;
    } else if (v3 === 1) {                                     // hipped, with a real porch
      // Was a flat 12-triangle slab on two posts — a carport. An enclosed gabled
      // porch is what a cottage has, it takes the front door out with it, and the
      // kit already builds one.
      A(at(mb(3, 2.1, 2.6, wall, 'wall', 2), 0, 1.05, 0));
      hp(3.2, 2.8, 1.3, 0, 2.75, 0);
      stack(.34, .9, -.98, 2.8, .35);
      EL.wd = 2.6;
      const px = seededR(seed * 8.31 + 1.07) < .5 ? -.80 : .80;
      dr((2.6 / 2 - .10 + .78) * 2, 3, 1.25, 0, px);
      porch(1.14, 1.62, .78, px);
      lit = addWindows(g, 4, 3, 1.8, 2.6, seed, false, WIN); hTop = 3.5;
    } else if (v3 === 2) {                                     // catslide back kitchen
      A(at(mb(3, 2.1, 2.6, wall, 'wall', 2), 0, 1.05, 0));
      gb(3.3, 1.5, 2.9, 0, 2.1, 0, true);
      catslide(2.2, .95, 1.15, -1.30, -1.45, 2.10, .18);
      stack(.34, .95, -.96, 2.9, .30);
      dr(2.6, 3, 1.3); lit = addWindows(g, 4, 3, 1.8, 2.6, seed, false, WIN); hTop = 3.6;
    } else if (v3 === 3) {                                     // lean-to on the flank
      // A mono-pitch outshut against the gable wall — the wash-house, the privy,
      // the coal store. The slope is a rotated slab tagged 'trim', exactly as the
      // catslide's is, so `impRole` never mistakes it for the roof.
      A(at(mb(3, 2.1, 2.6, wall, 'wall', 2), 0, 1.05, 0));
      gb(3.3, 1.5, 2.9, 0, 2.1, 0, true);
      const sx = seededR(seed * 4.77 + 2.31) < .5 ? -1 : 1;
      /* AND IT HAS TO STAY A LEAN-TO IN THE FAR TOWN TOO. At 1.15 × 1.85 the
         outshut's footprint was 2.13 against a 7.80 range — 27 %, over
         `IMP_A_REL`'s 22 % — so `impostorOf` folded it into the mass and this
         plan alone came back as a box 4.1 wide under a 3.3 roof. That box is not
         the honest answer it looks like: lod centres the mass on the plot, so it
         stood 0.55 proud on the side with no outshut and 0.55 short on the side
         with one; it took the outshut's full 2.1-unit wall height when the real
         thing is 1.22; and the quarter of its width the roof does not reach read
         as flat-topped, which is the exact error the thatched hips were fixed
         for. 1.15 × 1.40 is 1.61 — under the threshold with 6 % to spare, and a
         wash-house is a shallow building anyway. The mass box is the 3.0 × 2.6
         range again, which is what the note at the top of this tier promises. */
      A(at(mb(1.15, 1.22, 1.40, wall2, 'wall', 1), sx * 2.02, .61, .18));
      const sl = A(at(mb(1.60, .14, 1.02, R.roof, 'trim'), sx * 2.00, 1.50, .18));
      sl.rotation.z = -sx * .50;
      // The breast climbs the SAME gable, behind the lean-to rather than opposite
      // it: the far flank is the only elevation this plan has left to glaze, and
      // a stack standing in the middle of it would take the last window with it.
      breast(sx * 1.62, -1.10, .76, .46, 2.85);
      stack(.32, .95, sx * 1.62, 3.30, -1.10);
      WIN.ends = 1; WIN.endSign = -sx;                         // the near flank is the lean-to's
      dr(2.6, 3, 1.3); lit = addWindows(g, 4, 3, 1.8, 2.6, seed, false, WIN); hTop = 3.6;
    } else {                                                   // the plain range, hipped
      A(at(mb(3, 2.1, 2.6, wall, 'wall', 2), 0, 1.05, 0));
      hp(3.2, 2.8, 1.3, 0, 2.75, 0);
      stack(.34, .9, .9, 2.8, .4);
      dr(2.6, 3, 1.3); lit = addWindows(g, 4, 3, 1.8, 2.6, seed, false, WIN); hTop = 3.5;
    }
  } else if (t === 4) {
    /* THE HOUSE, IN FIVE PLANS. One rung up from the cottage and one rung below
       the villa: it is allowed a cross-wing and a chimney breast, and it is still
       a single-storey-and-attic range, not two full storeys with a jetty. */
    const v4 = Math.floor(seededR(seed * 3.17 + 5.83) * 5);
    if (v4 === 0) {                                            // cross-gable
      // Was hand-built to the same dimensions the `crossWing` verb now carries —
      // and the hand-built one was a BARN: an unglazed box with a roof on it.
      A(at(mb(3.2, 2.7, 2.8, wall, 'wall', 2), 0, 1.35, 0));
      gb(3.5, 1.7, 3.0, 0, 2.7, 0, true);
      crossWing(1.60, 1.70, 2.30, 1.18, 1.15, 1.10);
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      stack(.36, 1.0, -1.1, 3.4, .3);
      dr(2.8, 3.2, 1.4, -.30); lit = addWindows(g, 5, 3.2, 2.3, 2.8, seed, false, WIN); hTop = 4.4;
    } else if (v4 === 1) {                                     // hipped, twin stacks
      A(at(mb(3.4, 2.6, 2.9, wall, 'wall', 2), 0, 1.3, 0));
      A(at(mb(3.6, .16, 3.1, trim, 'trim'), 0, 2.66, 0));
      hp(3.6, 3.1, 1.4, 0, 3.45, 0);
      stack(.34, 1.0, -1.1, 3.4, .35); stack(.34, 1.0, 1.1, 3.4, .35);
      dr(2.9, 3.4, 1.4); lit = addWindows(g, 5, 3.4, 2.2, 2.9, seed, false, WIN); hTop = 4.3;
    } else if (v4 === 2) {                                     // gable + catslide + breast
      // The range is drawn SHALLOWER than the other plans by exactly what the
      // outshut adds back, so the mass box is 3.40 deep either way and the far
      // town cannot tell which plan it is looking at.
      A(at(mb(3.2, 2.7, 2.45, wall, 'wall', 2), 0, 1.35, .11));
      gb(3.5, 1.7, 2.65, 0, 2.7, .10, true);
      catslide(2.5, .95, 1.55, -1.22, -1.22, 2.70, .20);
      breast(1.66, -.18, .86, .52, 2.95);
      WIN.ends = 2; WIN.endSign = -1;
      stack(.36, 1.0, 1.66, 3.60, -.18);
      dr(2.67, 3.2, 1.4, -.40); lit = addWindows(g, 5, 3.2, 2.3, 2.67, seed, false, WIN); hTop = 4.4;
    } else if (v4 === 3) {                                     // hipped, porch and dormer
      A(at(mb(3.2, 2.7, 2.8, wall, 'wall', 2), 0, 1.35, 0));
      hp(3.4, 3.0, 1.5, 0, 3.45, 0);
      dormer(-.86, 3.16, 1.02, .74);
      stack(.36, 1.0, -1.06, 3.55, -.35);
      EL.wd = 2.8;
      dr((2.8 / 2 - .10 + .86) * 2, 3.2, 1.35, 0, .86);
      porch(1.20, 1.70, .86, .86);
      lit = addWindows(g, 5, 3.2, 2.3, 2.8, seed, false, WIN); hTop = 4.3;
    } else {                                                   // the plain range, hipped
      A(at(mb(3.2, 2.7, 2.8, wall, 'wall', 2), 0, 1.35, 0));
      hp(3.4, 3, 1.5, 0, 3.45, 0);
      stack(.36, 1.0, -1.0, 3.5, .5);
      dr(2.8, 3.2, 1.4); lit = addWindows(g, 5, 3.2, 2.3, 2.8, seed, false, WIN); hTop = 4.3;
    }
  } else if (t === 5) {
    /* THE VILLA, IN FIVE PLANS. It was one: a 3.4 × 3.0 box, an identical box on
       top of it, a string course and a choice of three roofs — and it is 1 house
       in 3 across the whole town. The five below are five different FOOTPRINTS
       (long range, cross-wing, porched-and-dormered, dovecote yard, double-pile),
       all inside a 3.6 × 3.3 envelope, so the far town is looking at the same
       building it always was. `v5` is its own roll: three variants was never
       enough for 350 houses. */
    WIN.ends = 3;                                              // two storeys of gable end
    const v5 = Math.floor(seededR(seed * 3.91 + 6.17) * 5);
    if (v5 === 0) {                                            // long range, catslide back kitchen
      storeys(3.30, 2.10, 1.90, 1.80);
      gb(3.60, 1.42, 2.54, 0, 3.70, .10, true);
      catslide(2.44, 1.10, 1.95, -1.00, -1.17, 3.70);
      stack(.38, 1.00, 1.16, 4.48, -.42);
      EL.dx = -.78; hTop = 5.35;
    } else if (v5 === 1) {                                     // range + gabled cross-wing
      storeys(2.16, 2.94, 1.90, 1.80, -.62);
      gb(2.46, 1.42, 3.24, -.62, 3.70, .10, true);
      crossWing(1.52, 2.42, 3.42, 1.32, .18, 1.18);
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      stack(.36, .95, -1.52, 4.42, -.62);
      hTop = 5.45;
    } else if (v5 === 2) {                                     // hipped, with a porch and a dormer
      storeys(3.32, 2.90, 2.16, 1.54);
      hp(3.56, 3.16, 1.55, 0, 4.46, .10);
      dormer(-.94, 4.26, 1.22, .76);
      porch(1.18, 1.72, .84, .62);
      stack(.38, 1.00, -1.20, 4.55, -.48);
      hTop = 5.40;
    } else if (v5 === 3) {                                     // …and a round stone dovecote
      // Was a 4.6-unit limewashed corner TOWER, which from the working framing
      // read as a grain silo standing in somebody's garden — and is the same
      // defensive vocabulary the top tier just lost. Shorter than the house,
      // fieldstone rather than plaster, and capped with a wide overhanging cone:
      // a dovecote is a thing a prosperous village actually has.
      storeys(3.28, 2.86, 1.90, 1.80);
      hp(3.52, 3.12, 1.55, 0, 4.44, .10);
      A(at(cyl(.86, .98, 3.06, 9, mix(stone, FIELD, .45), 'wall'), 1.92, 1.53, 1.14));
      A(at(cn(1.18, .96, 9, R.ridge), 1.92, 3.52, 1.14));
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      stack(.38, 1.00, -1.24, 4.52, -.44);
      EL.dx = -.66; hTop = 5.50;
    } else {                                                   // double-pile: two gables to the lane
      // Two parallel ranges under two gables, which is what a house that has been
      // added to twice looks like from the street: a valley between them, two
      // ridges, and an elevation that is not symmetrical about anything.
      for (const [px, pw, ph] of [[-.86, 1.62, 1.34], [.82, 1.58, 1.16]]) {
        A(at(mb(pw, 1.90, 2.86, wall, 'wall', 2), px, .95, 0));
        A(at(mb(pw + .10, 1.80, 3.12, wall2, 'wall', 2), px, 2.80, .13));
        gb(pw + .26, ph, 3.34, px, 3.70, .13, false);
      }
      A(at(mb(3.58, .14, 3.26, trim, 'trim'), .02, 1.93, .13));
      EL.wd = 2.86; EL.ud = 3.12; EL.h0 = 1.90; EL.dz = 1.43; EL.dx = .82;
      EL.ww = 3.28; EL.wx = 0; EL.uw = 3.40; EL.uz = .13; WIN.ends = 2; WIN.endSign = 1;
      breast(-1.72, -.40, .92, .56, 4.10);
      stack(.36, .95, -1.72, 4.62, -.40);
      hTop = 5.05;
    }
    WIN.upD = EL.ud; WIN.upW = EL.uw; WIN.upZ = EL.uz;
    WIN.ww = EL.ww; WIN.wx = EL.wx; WIN.doorX = EL.dx;
    addDoor(g, EL.dz * 2, 1.5, door, EL.dx); lit = addWindows(g, 6, 3.4, 3.2, EL.wd, seed, false, WIN) || lit;
  } else if (t === 6) {
    /* THE MANOR, IN FIVE PLANS — the other half of the 625. Same rule as tier 5:
       redistribute, never inflate. The two variants that already had wings keep
       them (they were the only two plans in the town with a real L to them); what
       is new is the H-plan with a gable at each end, the catslide-and-porch, and
       an oriel over the door on the plan that has a porch to put it above. */
    WIN.ends = 3;
    const v6 = Math.floor(seededR(seed * 2.63 + 3.41) * 5);
    if (v6 === 0) {                                            // H-plan: a gable at each end
      storeys(2.10, 3.06, 2.00, 1.90);
      gb(2.40, 1.50, 3.44, 0, 3.90, .10, true);
      crossWing(1.44, 2.58, 3.56, -1.80, .16, 1.18);
      crossWing(1.44, 2.58, 3.56, 1.80, .16, 1.18);
      WIN.ends = 0;
      stack(.38, 1.10, 0, 5.50, -1.10);
      hTop = 5.90;
    } else if (v6 === 1) {                                     // long gable + 3 dormers
      storeys(3.52, 3.10, 2.00, 1.90);
      gb(3.86, 1.72, 3.48, 0, 3.90, .12, true);
      for (const px of [-1.16, 0, 1.16]) dormer(px, 4.32, 1.24, .76);
      stack(.38, 1.10, 1.42, 4.92, -.62);
      hTop = 5.90;
    } else if (v6 === 2) {                                     // hipped range + service wing
      storeys(3.46, 3.04, 2.00, 1.90);
      hp(3.78, 3.42, 1.78, 0, 4.80, .12);
      A(at(mb(1.90, 1.76, 1.94, wall, 'wall', 2), 2.56, .88, .34));
      hp(2.14, 2.16, 1.00, 2.56, 2.26, .34);
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      stack(.38, 1.10, -1.24, 4.92, .48);
      EL.dx = -.80; hTop = 5.90;
    } else if (v6 === 3) {                                     // porched, with an oriel over it
      storeys(3.48, 2.86, 2.24, 1.66);
      hp(3.80, 3.24, 1.76, 0, 4.78, .12);
      porch(1.34, 1.80, .90, -.70);
      bay(-.70, 2.36, 1.43, 1.36, 1.24);
      dormer(1.14, 4.24, 1.28, .76);
      stack(.38, 1.10, 1.34, 4.92, -.60);
      hTop = 5.90;
    } else {                                                   // long range, catslide back kitchen
      storeys(3.50, 2.34, 2.00, 1.90);
      gb(3.84, 1.58, 2.80, 0, 3.90, .12, true);
      catslide(2.84, 1.20, 2.10, -1.10, -1.28, 3.90);
      breast(1.86, -.30, 1.00, .60, 4.30);
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      stack(.38, 1.10, 1.86, 5.00, -.30);
      EL.dx = -.90; hTop = 5.90;
    }
    WIN.upD = EL.ud; WIN.upW = EL.uw; WIN.upZ = EL.uz;
    WIN.ww = EL.ww; WIN.wx = EL.wx; WIN.doorX = EL.dx;
    addDoor(g, EL.dz * 2, 1.6, door, EL.dx); lit = addWindows(g, 7, 3.6, 3.4, EL.wd, seed, false, WIN) || lit;
  } else {
    const raise = (x, y) => {                                  // pennant on a pole
      A(at(cyl(.05, .05, 1.6, 5, 0xc3c2b7, 'trim'), x, y, 0));
      const f = keep(plate(1.1, .6, matFor(accent, 'flag')));
      A(at(f, x + .6, y + .4, 0));
      flagObj = f;
    };
    /* ── THE CASTLE IS RETIRED ────────────────────────────────────
       AESTHETIC.md struck the wizard tower and the sky-gate off the LANDMARK
       ladder, but the dwelling ladder went on topping out at a crenellated keep
       with corner turrets and a curtain wall — and unlike a landmark, of which
       there is one, the top house tiers repeat right across the wealthy core of
       a big town. The stroll mode made it unarguable: standing in the lane
       beside a merlon is a far louder violation than seeing one from 200 units
       up. A village does not contain keeps. It contains, at its grandest, a
       farmhouse, a merchant's house and a town house — three storeys, dressed
       stone, a lot of chimneys, and nothing to shoot arrows through.

       This is also triangle-NEGATIVE: eight merlon cubes, a parapet deck and
       four 8-sided turrets were ~200 triangles of fortification per keep, and
       the domestic replacements come in under what they cost. `capLum` stays
       exported — the landmarks still need a brightness cap on up-facing
       plaster, which is the real lesson the battlements taught. */
    WIN.ends = 3;
    const v7 = Math.floor(seededR(seed * 1.77 + 9.13) * 5);
    const quoin = mix(shade(wall, -.26), FIELD, .45);           // dressed stone at the corners
    if (v7 === 3) {                                            // the guildhall and its courtyard
      A(at(mb(4.4, 3.0, 2.6, wall, 'wall', 2), 0, 1.5, -.7));  // long range
      gb(4.7, 1.5, 2.9, 0, 3.0, -.7, true);
      A(at(mb(4.9, .14, 3.0, trim, 'trim'), 0, 3.06, -.7));
      for (const dx of [-1.75, 1.75]) {                        // wings enclosing a yard
        A(at(mb(1.5, 2.4, 2.4, wall2, 'wall', 2), dx, 1.2, 1.4));
        gb(1.8, 1.1, 2.7, dx, 2.4, 1.4, true);
      }
      A(at(mb(4.6, .5, .35, stone, 'stone', 1), 0, .25, 2.5));    // the yard wall + gate piers
      for (const dx of [-.95, .95]) A(at(mb(.42, 1.9, .42, stone, 'stone', 1), dx, .95, 2.5));
      A(at(mb(2.4, .28, .5, trim, 'wood'), 0, 2.0, 2.5));      // the lintel over the gate
      raise(-1.75, 3.9);
      // A SLAB IS NOT A DOOR. Twelve triangles, five faces of them inside a wall,
      // where every other door in the town is `addDoor`'s two boards: a limewashed
      // surround with the leaf recessed in it, four triangles, and the only version
      // of a door this file draws that reads as an opening rather than a panel.
      addDoor(g, 1.20, 1.70, door);
      WIN.ends = 0;
      lit = addWindows(g, 7, 3.6, 2.4, 2.6, seed, false, WIN); hTop = 5.1; altLabel = 'Guildhall';
    } else if (v7 === 4) {                                     // the counting-house
      // Was a domed rotunda on a portico: capital-city vocabulary, 886 triangles
      // apiece, and 216 of them in one sphere. A market town's counting-house is
      // a solid stone house with a strong-room wing and a cupola for the clock.
      A(at(mb(3.4, 2.5, 3.0, wall, 'wall', 2), 0, 1.25, 0));
      A(at(mb(3.5, 2.2, 3.1, wall2, 'wall', 2), 0, 3.60, 0));
      A(at(mb(3.6, .14, 3.2, trim, 'trim'), 0, 2.48, 0));
      hp(3.8, 3.4, 1.6, 0, 5.50, 0);
      for (const s of [-1, 1]) A(at(board(.30, 4.6, quoin, 'trim', 1), s * 1.62, 2.4, 1.56));
      A(at(mb(.88, .88, .88, wall2, 'wall', 1), 0, 6.55, 0));  // the cupola …
      A(at(cn(.76, .70, 6, roof), 0, 7.32, 0));
      A(at(ball(.15, GOLD_HI, 'metal'), 0, 7.70, 0));          // … and its gilded vane
      stack(.38, 1.10, -1.30, 6.05, -.70);
      A(at(mb(1.9, 1.6, 1.9, stone, 'stone', 2), 2.60, .80, .40));  // the strong-room
      hp(2.2, 2.2, .90, 2.60, 2.05, .40);
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      lit = addWindows(g, 6, 3.4, 4.4, 3.0, seed, false, WIN); hTop = 7.7; altLabel = 'Counting-House';
    } else if (v7 % 3 === 1) {                                 // the farmhouse and its yard
      A(at(mb(4.2, 2.3, 3.0, wall, 'wall', 2), 0, 1.15, 0));
      A(at(mb(4.3, 2.0, 3.1, wall2, 'wall', 2), 0, 3.35, 0));
      A(at(mb(4.5, .14, 3.2, trim, 'trim'), 0, 2.34, 0));
      gb(4.7, 1.6, 3.4, 0, 4.35, 0, true);
      A(at(mb(2.2, 1.7, 2.4, wall2, 'wall', 2), 3.10, .85, .50));  // the service wing
      gb(2.5, .95, 2.7, 3.10, 1.70, .50, true);
      stack(.40, 1.10, -1.60, 5.20, -.50); stack(.40, 1.10, 1.60, 5.20, -.50);
      A(at(mb(3.8, .60, .34, stone, 'stone', 1), -.70, .30, 2.35));  // the yard wall …
      for (const dx of [-2.55, 1.25]) A(at(mb(.40, 1.45, .40, stone, 'stone', 1), dx, .72, 2.35));
      WIN.ends = 2; WIN.endSign = -1;              // one flank is taken; glaze the other twice
      lit = addWindows(g, 8, 4.2, 4.2, 3.0, seed, false, WIN); hTop = 5.9; altLabel = 'Farmhouse';
    } else if (v7 % 3 === 2) {                                 // the town house, gable to the street
      A(at(mb(3.0, 2.4, 3.2, wall, 'wall', 2), 0, 1.20, 0));
      A(at(mb(3.2, 2.1, 3.4, wall2, 'wall', 1), 0, 3.50, .10));  // the jetty
      A(at(mb(3.3, .14, 3.5, trim, 'trim'), 0, 2.44, .10));
      A(at(mb(3.1, 1.35, 3.3, wall, 'wall', 2), 0, 5.225, .10));  // the attic storey, standing ON the jetty
                                                               // rather than 5 cm above it, as it was
      gb(3.4, 1.5, 3.6, 0, 5.90, .10, false);                  // …and its gable, facing the lane
      A(at(mb(2.4, .16, .95, trim, 'trim'), 0, 2.34, 1.92));   // the shop hood
      for (const dx of [-1.05, 1.05]) A(at(mb(.14, 2.2, .14, trim, 'wood', 1), dx, 1.10, 2.24));
      stack(.40, 1.15, -1.05, 6.60, -.80);
      // The jetty is 20 cm proud of the shop front, so the upper windows are too.
      WIN.upD = 3.4; WIN.upZ = .10;
      lit = addWindows(g, 7, 3.0, 5.0, 3.2, seed, false, WIN); hTop = 7.4; altLabel = 'Town House';
    } else {                                                   // the merchant's house
      A(at(mb(3.8, 2.4, 3.4, wall, 'wall', 2), 0, 1.20, 0));
      A(at(mb(3.9, 2.1, 3.5, wall2, 'wall', 2), 0, 3.45, 0));
      A(at(mb(4.0, .14, 3.6, trim, 'trim'), 0, 2.42, 0));
      hp(4.2, 3.8, 1.70, 0, 5.35, 0);
      for (const s of [-1, 1]) A(at(board(.32, 4.5, quoin, 'trim', 1), s * 1.82, 2.35, 1.76));
      A(at(mb(1.6, .18, 1.0, trim, 'trim'), 0, 2.20, 2.05));   // a pillared door hood
      for (const dx of [-.62, .62]) A(at(mb(.15, 2.05, .15, trim, 'wood', 1), dx, 1.03, 2.12));
      bay(0, 2.42, 1.72, 1.48, 1.48);                          // …and an oriel standing on it
      stack(.40, 1.20, -1.50, 5.90, -.60); stack(.40, 1.20, 1.50, 5.90, -.60);
      lit = addWindows(g, 8, 3.8, 4.4, 3.4, seed, false, WIN); hTop = 6.8;
    }
    if (v7 !== 3) addDoor(g, v7 === 4 ? 3.0 : v7 % 3 === 1 ? 3.0 : v7 % 3 === 2 ? 3.2 : 3.4, 1.7, door);
  }
  /* ── what every dwelling gets, measured off what it just built ──
     A footing so the plaster stops meeting the grass at a hard edge, and — on
     the older, denser part of the town — an oak frame on the front. Both find
     their own dimensions, so twenty silhouettes did not have to be edited to
     say the same thing twenty times. */
  if (t >= 1) {
    const M = mainMass(g);
    if (M) {
      A(at(mb(M.scale.x + .13, .26, M.scale.z + .13, paint.foot || shade(wall, -.44), 'trim', 1),
        M.position.x, .13, M.position.z));
      const eg = typeof paint.edge === 'number' ? paint.edge : .5;
      if (t >= 2 && seededR(seed * 7.7 + 1.3) < .50 - .34 * eg)
        timbers(A, M.scale.x * .92, M.scale.y - .12, M.position.x,
          M.position.y - M.scale.y / 2 + .06, M.position.z + M.scale.z / 2 + .02,
          greyed(mix(trim, OAK_D, .72), .22));
    }
  }
  // The painted lady also keeps flowers: one silhouette cue so she is findable
  // at framing distance, not just a colour you have to fly down to notice.
  if (paint.rare && t >= 1) for (const dx of [-.85, .85]) {
    A(at(mb(.34, .32, .34, trim, 'wood', 2), dx, .16, 2.15));
    A(at(cone4(.26, .34, shade(accent, .12), 'wall'), dx, .48, 2.15));
  }
  if (R.top > hTop) hTop = R.top;                 // the apex, measured — pitch varies
  lit = dressPlot(g, t, seed, paint, lit);
  const s = .94 + seededR(seed + 91) * .13;
  g.scale.setScalar(s);
  const ud = { hTop: hTop * s, baseScale: s, kind: 'house', label: altLabel || TIER_NAMES[t], rare: !!paint.rare, winMats: lit ? [lit] : [] };
  if (flagObj) ud.sway = [{ obj: flagObj, axis: 'y', amp: .28, period: 620 }];
  // Hearths above Cabin smoke lazily — a lived-in skyline in the very first
  // frame. The tier only ever ADDS: a market village lights the cottages' fires
  // too, and every hearth draws a little harder, so "more smoke" is monotone in
  // the milestone and no rung can ever take a chimney back.
  const F = FABRICS[VTIER];
  if (chim && (t >= 3 || (VTIER >= 2 && t >= 2)))
    ud.smoke = [{ p: chim, every: Math.round((2600 + seededR(seed + 12) * 1800) * (1.25 - F.hearth * .4)), size: .8, last: 0 }];
  return finish(g, ud, false, true);
}

/* ═══ flavour buildings ═════════════════════════════════════════ */
/* THE WINDMILL FLAVOUR IS RETIRED, and it had to be. `mill` is a LANDMARK — the
   thing a town earns at ten million tokens, after the well and the smithy — and
   an ordinary house flavour that is also a windmill spent that. A 233-building
   village stood three or four of them, so the landmark arrived as the fourth
   mill in town; a 300 K hamlet could raise one before it had earned any landmark
   at all. It is also simply not what a village looks like: parishes have ONE
   mill, which is why the miller is a person in the village and not a trade.
   In its place, at the same weight, the working building a village has as many
   of as it has farms — a stable range with an open cart bay. Seven entries
   still, same total weight, so `flavorRoll`'s ~1-in-6 rate and `pickFlavor`'s
   never-twice-in-a-row rule are untouched. */
/** Flavour vocabulary. */
export const FLAVORS = Object.freeze(['bakery', 'tavern', 'market', 'stables', 'farm', 'forge', 'well']);
const FW = [['bakery', 18], ['tavern', 15], ['market', 13], ['stables', 9], ['farm', 18], ['forge', 12], ['well', 11]];

function flavorRoll(plotIdx, band) {
  if (plotIdx < 0 || seededR(plotIdx * 2.7) >= .16) return null;  // ~1 plot in 6
  const pool = band >= 2 ? FW : FW.filter(e => e[0] !== 'farm');  // fields belong on the outskirts
  let tot = 0; for (const e of pool) tot += e[1];
  let r = seededR(plotIdx * 9.17 + 5.53) * tot, i = 0;
  for (; i < pool.length - 1; i++) { r -= pool[i][1]; if (r < 0) break; }
  return { pool, i };
}
/**
 * Deterministic sprinkle — roughly 1 plot in 6, never the same kind twice in a
 * row, never a farm inside band 2.
 * @param {number} plotIdx @param {number} band @returns {string|null}
 */
export function pickFlavor(plotIdx, band) {
  const a = flavorRoll(plotIdx, band); if (!a) return null;
  const prev = flavorRoll(plotIdx - 1, band);
  if (prev && prev.pool[prev.i][0] === a.pool[a.i][0]) return a.pool[(a.i + 1) % a.pool.length][0];
  return a.pool[a.i][0];
}

const FLAVOR_LABEL = { bakery: 'Bakery', tavern: 'Tavern', market: 'Market Stall', stables: 'Stables', farm: 'Farm', forge: 'Forge', well: 'Well' };

/**
 * @param {string} kind a FLAVORS entry @param {Paint} paint from paintFlavor()
 * @param {number} seed @returns {THREE.Group}
 */
export function buildFlavor(kind, paint, seed) {
  const g = new THREE.Group(), A = o => { g.add(o); return o; };
  const { roof, wall, wall2, trim, accent, door } = paint;
  const ud = { kind, label: FLAVOR_LABEL[kind] || kind, hTop: 3.5 };
  // The working buildings get the same openings the dwellings do — a bakery with
  // a blind brown rectangle beside a cottage with a mullioned window is the kind
  // of inconsistency the stroll mode finds in about four seconds.
  const WIN = {
    reveal: mix(wall, 0xFFF4DE, .32), bar: greyed(mix(trim, OAK_D, .74), .20),
    sill: mix(shade(wall, -.16), FIELD_L, .46), cross: true,
    shut: kind === 'tavern' ? .5 : .2, shutHex: greyed(mix(paint.door, MOSS, .28), .16)
  };
  let lit = null;
  // What the far tier cannot measure off the meshes. Sails, canopies and a
  // ploughed field are the whole silhouette of three of these seven, and none of
  // them is a wall: lod draws them as one extra instanced quad or cross.
  let imp = true;

  if (kind === 'bakery') {
    A(at(mb(3.0, 2.2, 2.6, wall, 'wall', 2), 0, 1.1, 0));
    A(at(mp(3.2, 2.8, 1.3, roof), 0, 2.85, 0));
    A(at(mb(.55, 1.9, .55, 0x8B4A3A, 'stone', 2), .9, 3.15, .6));   // fat brick chimney
    A(at(mb(.66, .18, .66, 0x6E3A2E, 'stone'), .9, 4.16, .6));
    const aw = A(at(plate(1.9, 1.0, stripeMat(accent)), 0, 1.66, 1.74));
    aw.rotation.x = -Math.PI / 2 + .36;
    A(at(mb(.7, .5, .5, 0x9A7B4F, 'wood', 2), -1.35, .25, 1.5));    // bread crates
    A(at(mb(.55, .4, .45, 0xB08A57, 'wood', 1), -1.35, .7, 1.5));
    addDoor(g, 2.6, 1.35, door);
    lit = addWindows(g, 4, 3.0, 1.9, 2.6, seed, false, WIN);
    ud.hTop = 4.3;
    ud.smoke = [{ p: new THREE.Vector3(.9, 4.6, .6), every: 1400, size: .95, last: 0 }];
  } else if (kind === 'tavern') {
    A(at(mb(3.6, 2.0, 3.0, wall, 'wall', 2), 0, 1.0, 0));
    A(at(mb(3.9, 1.5, 3.2, wall2, 'wall', 2), 0, 2.75, .2));        // first-floor jetty
    A(at(mb(4.0, .1, 3.3, trim, 'trim'), 0, 1.98, .2));
    A(at(mgab(4.1, 1.5, 3.5, roof, true), 0, 3.5, .2));
    A(at(mb(.4, 1.5, .4, 0x8B7A62, 'stone', 1), -1.3, 3.8, -.6));
    A(at(mb(.1, .1, 1.1, 0x3E3227, 'wood'), 1.35, 3.2, 2.05));      // sign bracket
    const sign = new THREE.Group();
    const bd = plate(1.0, .7, matFor(shade(accent, .1), 'wood'));
    bd.rotation.y = Math.PI / 2; sign.add(at(bd, 0, -.5, 0));
    sign.add(at(mb(.05, .34, .05, 0x3E3227, 'wood'), 0, -.05, 0));
    g.add(weld(at(sign, 1.35, 3.16, 2.45)));
    addDoor(g, 3.0, 1.5, door);
    lit = addWindows(g, 6, 3.6, 2.0, 3.0, seed, true, WIN);
    ud.hTop = 5.0;
    ud.sway = [{ obj: sign, axis: 'z', amp: .12, period: 900 }];
    // a tavern is warm even at noon — glow, not the plain night-window loop
    if (lit) { ud.glow = [{ mat: lit, day: .35, night: 1.5 }]; lit = null; }
    ud.smoke = [{ p: new THREE.Vector3(-1.3, 4.7, -.6), every: 2100, size: .8, last: 0 }];
  } else if (kind === 'market') {
    for (const [dx, dz] of [[-1.7, -1.5], [1.7, -1.5], [-1.7, 1.5], [1.7, 1.5]])
      A(at(mb(.14, 2.1, .14, 0x6B533A, 'wood', 1), dx, 1.05, dz));
    for (const s of [-1, 1]) {                                      // shared striped canvas
      const pn = A(at(plate(4.3, 2.0, stripeMat(accent)), 0, 2.32, s * .88));
      pn.rotation.x = -Math.PI / 2 + s * .48;
    }
    A(at(mb(3.9, .09, .5, 0x6B533A, 'wood'), 0, 1.0, -1.45));       // counter
    let i = 0;
    for (const [dx, dz, s] of [[-1.2, .9, .55], [-.5, 1.1, .45], [.9, .8, .6]])
      A(at(mb(s, s, s, shade(accent, i++ % 2 ? .15 : -.2), 'wood', 1), dx, s / 2, dz));
    A(at(cyl(.36, .36, .7, 10, 0x7A5A38, 'wood'), 1.55, .35, -.6));
    ud.hTop = 2.8;
    // four posts, two canvases and a counter: nothing here is a wall to measure
    imp = {
      w: 3.9, d: 3.1, h: 1.05, y0: 0, wall: 0x6B533A, roof: 0x5A4530,
      extra: { geo: 'awning', x: 0, y: 2.3, z: 0, s: 4.0, color: mix(0xEFE3C8, accent, .5) }
    };
  } else if (kind === 'stables') {
    /* A stable range with an open cart bay: low, long, and made of what a
       village makes outbuildings out of — a stone plinth, boarded oak above it,
       one roof over both halves, and a hayloft door with the hoist beam still
       sticking out over it. Nothing here is taller than the cottage next door,
       which is the point: it takes the retired windmill's slot without taking a
       landmark's silhouette with it. */
    A(at(mb(4.42, .40, 2.84, FIELD, 'stone', 1), .12, .20, 0));            // the plinth skirt
    A(at(mb(2.50, 2.04, 2.50, wall, 'wall', 2), -.80, 1.02, 0));           // the stable range
    for (const dy of [.52, 1.54])                                          // its oak boarding
      A(at(board(2.36, .15, shade(trim, -.12), 'trim', 1), -.80, dy, 1.27));
    A(at(mb(1.94, 2.04, .26, wall2, 'wall', 2), 1.42, 1.02, -1.12));       // the cart bay's back
    for (const dz of [-1.06, 1.06])                                        // …and its posts
      A(at(mb(.22, 2.04, .22, OAK, 'wood', 2), 2.26, 1.02, dz));
    A(at(mb(2.10, .16, 2.40, OAK, 'trim'), 1.42, 1.96, 0));                // the bay's wall plate
    A(at(mgab(4.70, 1.20, 3.00, roof, true), .12, 2.04, 0));
    A(at(mb(4.50, .14, .30, shade(roof, -.16), 'roof'), .12, 3.16, 0));    // the ridge
    A(at(mb(.14, .14, 1.30, OAK_D, 'wood'), -1.30, 2.30, 1.20));           // the hoist beam…
    A(at(mb(.09, .30, .09, IRON, 'wood'), -1.30, 2.08, 1.78));             // …and its block
    A(at(mb(1.30, .34, .52, OAK_S, 'wood'), 1.30, .57, 1.14));             // the trough…
    A(at(mb(1.08, .06, .34, mix(palette().water, 0x0A0E12, .55), 'wall'), 1.30, .75, 1.14));
    for (const [bx, bz] of [[2.14, .34], [2.06, -.44]])                    // …straw bales…
      A(at(mb(.62, .40, .46, mix(THATCH_L, roof, .12), 'wood', 1), bx, .60, bz));
    A(at(cone4(.54, .56, MUD, 'wall'), -2.34, .27, -1.16));                // …and the muck heap
    addDoor(g, 2.50, 1.42, door, -1.30);
    lit = addWindows(g, 2, 2.50, 2.30, 2.50, seed, false,
      Object.assign({}, WIN, { ww: 2.50, wx: -.80, doorX: -1.30 }));
    ud.hTop = 3.30;
  } else if (kind === 'farm') {
    const field = A(at(plate(4.6, 4.0, new THREE.MeshStandardMaterial({ map: ploughTex(), roughness: 1 })), 0, .02, .3));
    field.rotation.x = -Math.PI / 2; field.userData.noCast = true; keep(field);
    const crops = new THREE.InstancedMesh(GEO.crop, matFor(0x6E8C43, 'wall'), 21);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < 21; i++) {
      const r = Math.floor(i / 7), c = i % 7, s = .8 + seededR(seed + i) * .7;
      sc.set(s, s, s); p.set(-1.8 + c * .6, .25 * s, -.7 + r * 1.15);
      m4.compose(p, q, sc); crops.setMatrixAt(i, m4);
    }
    crops.instanceMatrix.needsUpdate = true; A(keep(crops));
    const sc2 = new THREE.Group();                                  // scarecrow
    sc2.add(at(mb(.11, 1.9, .11, 0x6B533A, 'wood'), 0, .95, 0));
    sc2.add(at(mb(1.3, .1, .1, 0x6B533A, 'wood'), 0, 1.5, 0));
    sc2.add(at(ball(.24, 0xC9B27E, 'wall'), 0, 2.0, 0));
    sc2.add(at(cone4(.42, .3, shade(accent, .1), 'trim'), 0, 2.22, 0));
    g.add(weld(at(sc2, 1.55, 0, -1.5)));
    for (const dx of [-2.2, 0, 2.2]) A(at(mb(.11, .8, .11, 0x7A6446, 'wood', 1), dx, .4, 2.35));
    A(at(mb(4.5, .07, .07, 0x7A6446, 'wood'), 0, .68, 2.35));
    A(at(mb(1.9, 1.3, 1.6, wall, 'wall', 2), -1.5, .65, -1.9));     // tool shed
    A(at(mgab(2.2, .8, 1.9, roof, true), -1.5, 1.3, -1.9));
    ud.hTop = 2.5;
    ud.sway = [{ obj: sc2, axis: 'y', amp: .09, period: 1300 }];
    // the shed derives on its own; the field is what says "farm" at 12 px
    imp = { extra: { geo: 'field', x: 0, y: .06, z: .3, s: 4.3, color: 0x5A462E } };
  } else if (kind === 'forge') {
    A(at(mb(3.0, 1.3, 2.6, 0x8d8878, 'stone', 1), 0, .65, 0));
    A(at(mb(2.8, 1.1, 2.4, wall, 'wall', 2), 0, 1.85, 0));
    A(at(mgab(3.2, .9, 2.8, roof, true), 0, 2.4, 0));
    A(at(mb(.6, 1.6, .6, 0x77716A, 'stone', 1), -1.0, 3.0, -.5));   // squat chimney
    const coalM = new THREE.MeshStandardMaterial({ color: 0x2A1A12, emissive: 0xFF8A2A, emissiveIntensity: .6, roughness: .7 });
    const coal = at(new THREE.Mesh(GEO.plane, coalM), 0, 1.15, 1.32);
    coal.scale.set(1.0, .55, 1); A(coal);
    A(at(mb(.62, .28, .34, 0x54514C, 'metal'), 1.55, 1.02, 1.1));   // anvil
    A(at(mb(.3, .55, .28, 0x54514C, 'metal'), 1.55, .62, 1.1));
    A(at(mb(.5, .3, .5, 0x4B453E, 'stone', 1), 1.55, .15, 1.1));
    ud.hTop = 3.9;
    ud.glow = [{ mat: coalM, day: .6, night: 1.4 }];
    ud.smoke = [{ p: new THREE.Vector3(-1.0, 4.0, -.5), every: 1700, size: .85, last: 0 }];
  } else {                                                          // well
    /* THE SAME THREE MISTAKES THE LANDMARK WELL HAD, at a sixth of the size and
       twenty times as often: the water was a disc at y .53 inside a drum that
       tops out at .55, so it read as a pale lid ON the rim; the bucket hung .55
       below its beam, which put it INSIDE the shaft; and the posts stood at
       ±.80 on a drum of radius .95, i.e. buried in the stonework. Same fixes,
       and cheaper than what it replaces: the mouth and the water are two flat
       discs instead of a 52-triangle cylinder, and the roof loses a prism. */
    A(at(cyl(.86, .96, .48, 14, 0x8d8878, 'stone'), 0, .24, 0));
    A(at(cyl(1.02, .98, .17, 14, 0x9C9788, 'stone'), 0, .565, 0));      // the kerb
    // THE SHAFT STANDS 4 cm PROUD OF THE KERB, which is the whole trick: a `cyl`
    // is closed, so the kerb wears a stone lid and anything below it is sealed
    // in. One short dark cylinder ON TOP of that lid covers it, and what is left
    // to see is a stone ring with black water down the middle of it. The
    // landmark well does the same thing with `ground` plates, which are free
    // there because the apron has already opened that bucket; here there is no
    // apron, and a bucket of its own would be a draw call on every well in town.
    A(at(cyl(.68, .68, .05, 10, mix(palette().water, 0x0A1014, .42), 'wall'), 0, .665, 0));
    for (const dx of [-1.06, 1.06]) {
      A(at(mb(.32, .12, .32, 0x7C776B, 'stone', 1), dx, .06, 0));
      A(at(mb(.13, 1.32, .13, 0x6B533A, 'wood'), dx, .66, 0));
    }
    A(at(mb(2.32, .11, .13, 0x6B533A, 'wood'), 0, 1.32, 0));
    A(at(mgab(2.36, .58, 1.28, roof, true), 0, 1.34, 0));
    A(at(mb(2.26, .11, .28, shade(roof, .07), 'roof'), 0, 1.88, 0));
    A(at(cyl(.09, .09, 1.72, 6, 0x5A4530, 'wood'), 0, 1.06, 0)).rotation.z = Math.PI / 2;
    for (const dx of [-1, 1]) A(at(mb(.26, .15, .15, IRON, 'wood'), dx * 1.00, 1.06, 0));
    A(at(mb(.20, .07, .07, IRON, 'wood'), 1.20, 1.06, 0));              // a crank to turn it by
    A(at(mb(.07, .07, .28, IRON, 'wood'), 1.28, 1.06, .14));
    const bucket = new THREE.Group();                                   // …hanging over the mouth
    bucket.add(at(cyl(.02, .02, .16, 5, 0x4A3A28, 'wood'), 0, -.08, 0));
    bucket.add(at(cyl(.16, .13, .24, 8, 0x6B533A, 'wood'), 0, -.28, 0));
    g.add(weld(at(bucket, 0, 1.06, 0)));
    ud.hTop = 1.99;
    ud.sway = [{ obj: bucket, axis: 'x', amp: .11, period: 1100 }];
  }

  const s = .96 + seededR(seed + 91) * .08;
  g.scale.setScalar(s);
  ud.hTop *= s; ud.baseScale = s;
  if (lit) ud.winMats = [lit];
  return finish(g, ud, false, imp);
}

/* ═══ landmarks ═════════════════════════════════════════════════
   THE FANTASY SET IS RETIRED. `wizard_tower`, `skygate`, `observatory` and
   `golden_statue` are gone, and `cathedral` has been rusticated into a parish
   `chapel` — see AESTHETIC.md, which is binding on this file. What replaced them
   is the ten things a real village earns, in roughly the order it earns them:
   a well, a forge, a mill, a market cross, a tithe barn, a market hall, a
   chapel, a bell, a green and an inn.

   HEIGHTS CAME DOWN AND THEY STAY DOWN. The old set topped out at a 26-unit
   sky-gate and a 20-unit cathedral; the tallest thing here is a squat church
   tower at 12.6, which is what a church tower is in a village — the tallest
   thing for a mile and not very tall. The charter's ceiling is ~14 and nothing
   here needs to argue with it. Growth shows as MORE, not TALLER.

   A retired key still resolves: `buildLandmark` falls back to the well rather
   than throwing, so a stale rung in town.js's ladder raises a well, not a crash.

   The test for every one of these is the charter's: would a photograph of a real
   village look like this? */
/** Landmark metadata, keyed by kind. town.js reads `span` and `label`. */
export const LANDMARK_DEFS = Object.freeze({
  well: { span: 1, hTop: 2.9, label: 'Village Well' },
  smithy: { span: 2, hTop: 5.6, label: 'Smithy' },
  mill: { span: 2, hTop: 10.4, label: 'Mill' },
  market_cross: { span: 1, hTop: 4.9, label: 'Market Cross' },
  tithe_barn: { span: 3, hTop: 8.4, label: 'Tithe Barn' },
  market_hall: { span: 3, hTop: 8.4, label: 'Market Hall' },
  chapel: { span: 3, hTop: 12.6, label: 'Parish Chapel' },
  bell_tower: { span: 2, hTop: 11.0, label: 'Bell Tower' },
  village_green: { span: 3, hTop: 4.8, label: 'Village Green' },
  inn: { span: 3, hTop: 8.3, label: 'The Inn' }
});

/* ── the landmark construction kit ──────────────────────────────
   Three shapes carry most of the village: a thatched roof, a timber-framed
   panel, and a run of rubble walling. Each is a handful of boxes and each is
   the difference between "a coloured prism" and "a building someone thatched". */

/** A reed roof: the mass, the fat overhanging eave course, and the ridge roll.
 *  Thatch is a mattress, not a sheet — the eave is what says so. */
function reed(A, w, h, d, x, y, z, alongX, hex) {
  const c = hex === undefined ? THATCH_L : hex;
  A(at(mgab(w, h, d, c, alongX), x, y, z));
  A(at(mgab(w * 1.05, h * .34, d * 1.09, shade(c, -.11), alongX), x, y - .11, z));
  A(at(mb(alongX ? w * .99 : d * .28, .18, alongX ? d * .28 : w * .99, shade(c, .07), 'roof'),
    x, y + h - .05, z));
  // sedge pegging over the ridge — three dark stitches, the cheapest craft cue
  // there is. They sit ON the roll, not above it: proud of the ridge they read as
  // battlements, which is the last thing a thatched roof should look like.
  for (let i = -1; i <= 1; i++)
    A(at(mb(alongX ? .06 : d * .32, .05, alongX ? d * .32 : .06, THATCH_D, 'roof'),
      x + (alongX ? i * w * .27 : 0), y + h + .015, z + (alongX ? 0 : i * d * .27)));
}

/** Studs, sill, mid-rail and wall-plate on the +z face of a plastered box.
 *  A framed wall reads as BUILT; an unframed one reads as extruded. */
function frame(A, w, h, x, y, z, hex, n) {
  const c = hex === undefined ? OAK : hex, t = .12, zz = z + .02;
  for (const dy of [.06, h * .52, h - .10]) A(at(mb(w, .17, t, c, 'trim'), x, y + dy, zz));
  const k = n || Math.max(3, Math.round(w / .95));
  for (let i = 0; i < k; i++) A(at(mb(t, h, t, c, 'trim'), x - w / 2 + (i + .5) * w / k, y + h / 2, zz));
}

/** Rubble courses on the +z face: the joint lines that stop fieldstone reading
 *  as poured concrete. Four bands, offset, in the wall's own shadow. */
function courses(A, w, h, x, y, z, hex) {
  const c = hex === undefined ? FIELD_D : hex;
  for (let i = 1; i < 4; i++)
    A(at(mb(w * (.97 - (i % 2) * .05), .05, .06, c, 'trim'), x + (i % 2 ? .07 : -.07) * w, y + h * i / 4, z + .02));
}

/** A worn earth apron — every landmark stands on ground people walk on. */
const apron = (A, r, hex) => A(at(gdisc(r, hex === undefined ? EARTH : hex, 18), 0, .045, 0));

/** A barrel / water butt / stacked log — GEO.trunk is a cached 6-sided cylinder
 *  and it is the right shape for all three, which keeps them free. */
function drum(A, sx, sy, x, y, z, hex, lying) {
  const m = new THREE.Mesh(GEO.trunk, matFor(hex, 'wood'));
  m.scale.set(sx, sy, sx); tag(m, 'wood');
  if (lying) m.rotation.z = Math.PI / 2;
  return A(at(m, x, y, z));
}

/**
 * @param {string} kind a LANDMARK_DEFS key @param {Paint} paint from paintLandmark()
 * @param {number} seed @returns {THREE.Group}
 */
export function buildLandmark(kind, paint, seed) {
  // An unknown key still raises the well rather than throwing: the ladder, this
  // table and layout.js's LM must agree, and if they ever drift again the town
  // should lose a landmark, not the frame.
  const def = LANDMARK_DEFS[kind] || LANDMARK_DEFS.well;
  const { civic, accent } = paint;
  const g = new THREE.Group(), A = o => { g.add(o); return o; };
  const spin = [], sway = [], glow = [], smoke = [], lights = [];
  let lit = null;

  const roof = paint.roof, F = paint.fabric || FABRICS[VTIER], thatchC = paint.thatch || THATCH_L;

  if (kind === 'smithy') {
    /* A forge is built out of what will not burn: fieldstone to the eave, lime
       plaster above it, and a brick stack fat enough to swallow the fire. The
       work happens in the open bay at the side, which is why a village smithy is
       the one building you can see the inside of from the street. */
    apron(A, 5.8, MUD);
    A(at(mb(4.4, 1.55, 3.4, FIELD, 'stone'), -.4, .78, 0));
    courses(A, 4.4, 1.55, -.4, 0, 1.70);
    A(at(mb(4.2, 1.20, 3.2, LIME, 'wall'), -.4, 2.15, 0));
    frame(A, 4.2, 1.20, -.4, 1.55, 1.60, OAK, 5);
    A(at(mb(4.6, .16, 3.5, OAK, 'trim'), -.4, 2.83, 0));
    A(at(mgab(4.9, 1.50, 3.7, roof, true), -.4, 2.78, 0));
    A(at(mb(4.8, .14, .26, shade(roof, .08), 'roof'), -.4, 4.22, 0));
    A(at(mb(1.00, 5.00, 1.00, BRICK, 'stone'), -2.0, 2.50, -.9));            // the forge stack
    A(at(mb(1.22, .26, 1.22, shade(BRICK, -.20), 'stone'), -2.0, 5.12, -.9));
    for (const [px, pz] of [[1.5, 2.5], [3.5, 2.5], [3.5, .4]])              // the open bay
      A(at(mb(.22, 2.30, .22, OAK, 'trim'), px, 1.15, pz));
    A(at(mb(3.6, .16, 2.9, roof, 'roof'), 2.5, 2.60, 1.45)).rotation.x = .17;
    A(at(mb(3.7, .10, .22, OAK, 'trim'), 2.5, 2.28, 2.72));
    A(at(mb(1.4, .85, 1.2, FIELD_D, 'stone'), 2.6, .42, 1.9));               // the hearth
    const coalM = new THREE.MeshStandardMaterial({ color: 0x2A1810, emissive: 0xFF7A22, emissiveIntensity: .6, roughness: .75 });
    const coal = at(new THREE.Mesh(GEO.plane, coalM), 2.6, .87, 1.9);
    coal.rotation.x = -Math.PI / 2; coal.scale.set(1.05, .85, 1); A(coal);
    A(at(mb(.9, 1.0, .55, OAK_S, 'wood'), 2.6, .85, 1.0)).rotation.x = .30;  // the bellows
    drum(A, 2.2, 1.0, 3.5, .40, -.2, OAK_D);                                 // the slack tub
    drum(A, 1.7, .72, 1.4, .29, 3.0, OAK_S);                                 // the anvil's stump
    A(at(mb(.80, .26, .34, IRON, 'metal'), 1.4, .70, 3.0));
    A(at(mb(.30, .24, .28, IRON, 'metal'), 1.4, .48, 3.0));
    A(at(cone4(.85, .60, 0x2B2723, 'stone'), -3.4, .30, 2.0));               // the coal heap
    for (let i = 0; i < 5; i++)                                              // the woodpile
      drum(A, 1.0, 1.9, -3.5 + (i > 2 ? .22 : 0), .17 + (i > 2 ? .29 : 0), -1.3 - (i % 3) * .33,
        i % 2 ? OAK_S : shade(OAK_S, -.13), true);
    lit = lamplight(g, [[-1.4, 1.95, 1.68, .5, .6, 0], [.5, 1.95, 1.68, .5, .6, 0]]);
    glow.push({ mat: coalM, day: .55, night: 1.5 });
    smoke.push({ p: new THREE.Vector3(-2.0, 5.4, -.9), every: 1500, size: .95, last: 0 });

  } else if (kind === 'mill') {
    /* The sails stay — they are the joke lod.js draws at four pixels. Everything
       under them came down and got dirtier: a tarred, tapering tower on a rubble
       base, a boat cap, a reefing gallery, and the tailpole the miller walks
       round to turn the cap into the wind. */
    apron(A, 5.2);
    A(at(cyl(2.35, 2.65, .55, 12, FIELD_D, 'stone'), 0, .27, 0));
    A(at(cyl(1.25, 2.15, 5.00, 12, LIME, 'wall'), 0, 3.05, 0));
    A(at(cyl(2.02, 2.22, 1.35, 12, shade(OAK_D, .05), 'wall'), 0, 1.22, 0));  // the tarred skirt
    A(at(cyl(1.92, 1.92, .14, 12, OAK_S, 'wood'), 0, 5.55, 0));               // the reefing gallery
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU;
      A(at(mb(.09, .50, .09, OAK_S, 'wood'), Math.cos(a) * 1.82, 5.86, Math.sin(a) * 1.82));
    }
    A(at(cyl(1.50, 1.50, .18, 12, OAK_D, 'wood'), 0, 5.62, 0));
    A(at(cn(1.45, 1.50, 12, shade(OAK_D, .06)), 0, 6.30, 0));                 // the boat cap
    const hub = new THREE.Group();
    const shaft = cyl(.26, .26, .80, 8, OAK_D, 'wood'); shaft.rotation.x = Math.PI / 2; hub.add(shaft);
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Group();
      b.add(at(mb(.24, 4.40, .14, OAK_D, 'wood'), 0, 2.20, 0));               // the whip
      b.add(at(mb(.98, 3.50, .09, LIME_D, 'trim'), .60, 2.35, .10));          // its canvas
      for (let j = 0; j < 5; j++)
        b.add(at(mb(1.02, .07, .06, OAK_S, 'wood'), .60, .95 + j * .70, .16));  // …and its bars
      b.rotation.z = i / 4 * TAU + .16; hub.add(b);
    }
    g.add(weld(at(hub, 0, 5.95, 1.75)));
    spin.push({ obj: hub, axis: 'z', rate: 3.4e-4, phase: seededR(seed) * TAU });
    A(at(mb(.20, 6.40, .20, OAK_S, 'wood'), 0, 3.10, -2.50)).rotation.x = .66;   // the tailpole
    drum(A, 1.9, .50, 0, .28, -4.50, OAK_D, true);
    A(at(mb(2.6, .16, .16, OAK_S, 'wood'), 0, .95, -4.30));
    A(at(mb(3.0, 1.70, 2.4, LIME_D, 'wall'), -3.8, .85, 1.3));                // the miller's lean-to
    reed(A, 3.4, 1.10, 2.8, -3.8, 1.70, 1.3, true, thatchC);
    for (const [sx, sz] of [[-2.5, 3.0], [-1.9, 3.35], [-3.2, 3.4]]) {        // sacks of flour
      const sk = ball(.40, mix(LIME_D, 0xC9B27E, .5), 'wall'); sk.scale.set(.40, .30, .34);
      A(at(sk, sx, .30, sz));
    }
    A(at(mb(1.1, .16, .34, OAK_S, 'wood'), 0, .64, 2.60));                    // steps to the door
    A(at(mb(1.1, .16, .34, OAK_S, 'wood'), 0, .34, 2.92));
    A(at(mb(1.0, 1.90, .16, OAK_D, 'wood'), 0, 1.30, 2.14));
    const vane = new THREE.Group();
    vane.add(at(cyl(.05, .05, .90, 5, IRON, 'metal'), 0, .45, 0));
    vane.add(at(plate(.62, .38, matFor(BRASS, 'metal')), .32, .84, 0));
    g.add(weld(at(vane, 0, 7.00, 0)));
    spin.push({ obj: vane, axis: 'y', rate: 8e-5, phase: 0 });
    lit = lamplight(g, [[-.8, 2.4, 2.06, .45, .6, 0], [.8, 2.4, 2.06, .45, .6, 0], [0, 4.3, 1.63, .4, .55, 0]]);

  } else if (kind === 'market_cross') {
    /* Three worn steps, a socket stone and a shaft. It is where the charter was
       read out, where the butter was sold and where everybody sat; the tier
       decides how much of the market has arrived around it. */
    apron(A, 4.6);
    for (let i = 0; i < 3; i++)
      A(at(cyl(2.05 - i * .42, 2.15 - i * .42, .30, 8, i ? FIELD : FIELD_D, 'stone'), 0, .15 + i * .30, 0)).rotation.y = Math.PI / 8;
    A(at(cyl(1.05, 1.10, .10, 8, MOSS, 'stone'), 0, .06, 0));
    A(at(mb(.86, .55, .86, FIELD_D, 'stone'), 0, 1.22, 0)).rotation.y = Math.PI / 8;
    A(at(cyl(.19, .30, 2.50, 8, FIELD_L, 'stone'), 0, 2.75, 0));
    A(at(mb(.52, .52, .52, FIELD_L, 'stone'), 0, 4.22, 0)).rotation.y = Math.PI / 8;
    A(at(cone4(.36, .32, FIELD_L, 'stone'), 0, 4.62, 0));
    A(at(ball(.10, BRASS, 'metal'), 0, 4.82, 0));
    const st = Math.min(4, F.stalls);
    for (let i = 0; i < st; i++) {
      const a = i / Math.max(1, st) * TAU + .6, r = 3.2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, tx = -Math.sin(a), tz = Math.cos(a), ry = -a - Math.PI / 2;
      A(at(mb(1.55, .10, .95, OAK_S, 'wood'), x, .88, z)).rotation.y = ry;
      for (const s of [-.62, .62]) A(at(mb(.10, .88, .10, OAK_S, 'wood'), x + tx * s, .44, z + tz * s));
      const cv = A(at(plate(1.75, 1.25, stripeMat(accent)), x, 1.48, z));
      cv.rotation.set(-Math.PI / 2 + .44, ry, 0); cv.userData.noCast = true;
      A(at(mb(.42, .42, .42, shade(accent, i % 2 ? .16 : -.22), 'wood'), x + tx * .3, 1.14, z + tz * .3));
    }
    for (const [cx, cz, s] of [[1.6, 2.0, .50], [-2.0, 1.5, .42], [-1.5, -2.0, .46]])
      A(at(mb(s, s, s, shade(OAK_S, -.12), 'wood'), cx, s / 2, cz));

  } else if (kind === 'tithe_barn') {
    /* The biggest roof in the parish and the surest sign it was a rich one: a
       stone plinth, black-boarded oak above it, and a roof half again as tall as
       the walls it sits on, with two waggon porches you could drive a loaded
       cart straight through. Nothing about it is grand except its size. */
    apron(A, 8.8, MUD);
    // THE ROOF IS THE BUILDING. Nearly twice the height of the walls under it and
    // overhanging them on every side; a barn whose roof only matches its walls is
    // a big house, which is exactly what the first pass looked like. The boarding
    // is weathered silver rather than tar-black for the same reason: an unlit
    // gable of black oak is a hole in the daylight.
    const board = mix(OAK_S, LIME, .30), boardD = mix(OAK_D, LIME, .20);
    A(at(mb(13.0, 1.05, 6.50, FIELD, 'stone'), 0, .52, 0));
    courses(A, 13.0, 1.05, 0, 0, 3.25);
    A(at(mb(12.6, 2.45, 6.05, board, 'wall'), 0, 2.28, 0));
    for (let i = 0; i < 17; i++) {                                            // vertical boarding…
      const x = -6.1 + i * .765;
      for (const sz of [-1, 1])
        A(at(mb(.12, 2.45, .07, i % 2 ? boardD : shade(boardD, .10), 'trim'), x, 2.28, sz * 3.05));
    }
    for (let i = 0; i < 8; i++) {                                             // …on the gables too
      const z = -2.65 + i * .757;
      for (const sx of [-1, 1])
        A(at(mb(.07, 2.45, .12, i % 2 ? boardD : shade(boardD, .10), 'trim'), sx * 6.32, 2.28, z));
    }
    for (const sz of [-1, 1]) A(at(mb(12.7, .14, .10, shade(boardD, .18), 'trim'), 0, 2.30, sz * 3.10));
    A(at(mb(13.2, .22, 6.55, OAK, 'trim'), 0, 3.60, 0));                      // the wall plate
    A(at(mgab(13.9, 4.40, 7.35, roof, true), 0, 3.55, 0));
    A(at(mb(13.8, .22, .36, shade(roof, .08), 'roof'), 0, 7.90, 0));
    for (let i = 0; i < 6; i++) {                                             // buttress piers
      const x = (i % 3 - 1) * 4.2, sz = i < 3 ? -1 : 1;
      A(at(mb(.75, 2.40, 1.00, FIELD_D, 'stone'), x, 1.20, sz * 3.55));
      A(at(cone4(.62, .48, FIELD_D, 'stone'), x, 2.58, sz * 3.55));
    }
    for (const dx of [-3.7, 3.7]) {                                           // the waggon porches
      A(at(mb(3.50, 1.05, 2.50, FIELD, 'stone'), dx, .52, 4.10));
      A(at(mb(3.50, 2.35, 2.50, board, 'wall'), dx, 2.22, 4.10));
      A(at(mgab(3.90, 1.55, 2.95, roof, false), dx, 3.40, 4.10));
      A(at(mb(2.50, 3.00, .18, OAK_D, 'wood'), dx, 1.58, 5.30));
      for (let i = 0; i < 3; i++) A(at(mb(2.50, .13, .07, OAK, 'trim'), dx, .60 + i * 1.02, 5.42));
      A(at(mb(.14, 3.00, .10, OAK, 'trim'), dx, 1.58, 5.42));
    }
    for (const [cx, cz, s] of [[-6.9, 5.4, 1.15], [-5.6, 6.1, .95], [6.7, 5.8, 1.05]])   // haycocks
      A(at(cone4(s * 1.05, s * 1.10, mix(THATCH_L, 0xC9B27E, .35), 'wall'), cx, s * .55, cz));
    A(at(mb(3.0, .22, 1.5, OAK_S, 'wood'), 5.4, .86, 6.4));                   // the hay cart
    for (const sz of [-1, 1]) drum(A, 2.6, .32, 5.4, .48, 6.4 + sz * .8, OAK_D, true);
    A(at(mb(.9, .55, .9, FIELD_D, 'stone'), 0, .28, 6.2));                    // the mounting block
    lit = lamplight(g, [[-3.7, 2.4, 5.42, .34, .44, 0], [3.7, 2.4, 5.42, .34, .44, 0]]);

  } else if (kind === 'market_hall') {
    /* The one landmark that survived unchanged in spirit: an open arcaded ground
       floor you hold the market under, and a jettied timber-framed room over it
       you hold everything else in. It gained the upper room it always needed —
       ten posts holding up nothing was a bandstand, not a hall. */
    apron(A, 7.6);
    A(at(mb(10.6, .22, 7.00, FIELD_D, 'stone'), 0, .11, 0));
    A(at(mb(10.0, .38, 6.40, FIELD, 'stone'), 0, .30, 0));
    for (const dx of [-3.9, -1.95, 0, 1.95, 3.9]) for (const dz of [-2.3, 2.3]) {
      A(at(mb(.56, .24, .56, FIELD_D, 'stone'), dx, .58, dz));
      A(at(mb(.34, 2.85, .34, OAK, 'trim'), dx, 2.13, dz));
      for (const sx of [-1, 1])
        A(at(mb(.90, .18, .22, OAK, 'trim'), dx + sx * .50, 3.24, dz)).rotation.z = sx * .62;
    }
    A(at(mb(10.2, .34, 6.70, OAK, 'trim'), 0, 3.72, 0));                      // the bressumer
    A(at(mb(10.7, 2.35, 6.95, LIME, 'wall'), 0, 5.07, 0));                    // the jettied room
    frame(A, 10.7, 2.35, 0, 3.89, 3.455, OAK, 11);
    frame(A, 10.7, 2.35, 0, 3.89, -3.515, OAK, 11);
    A(at(mb(11.0, .18, 7.20, OAK, 'trim'), 0, 6.33, 0));
    A(at(mgab(11.2, 2.00, 7.40, roof, true), 0, 6.27, 0));
    A(at(mb(11.1, .16, .30, shade(roof, .08), 'roof'), 0, 8.21, 0));
    for (const dx of [-2.6, 0, 2.6]) {                                        // dormers
      A(at(mb(.95, .75, 1.00, LIME_D, 'wall'), dx, 6.62, 2.55));
      A(at(mgab(1.15, .55, 1.10, roof, true), dx, 7.35, 2.55));
    }
    for (let i = 0; i < 6; i++)                                               // the outside stair
      A(at(mb(1.30, .22, .44, OAK_S, 'wood'), 5.85, .62 + i * .54, 2.10 - i * .44));
    A(at(mb(.12, 3.40, .12, OAK, 'trim'), 5.20, 2.00, -.30));
    for (let i = 0; i < F.stalls; i++) {                                      // the market itself
      const x = -3.9 + (i % 5) * 1.95, z = i < 5 ? 1.25 : -1.25, s = z > 0 ? 1 : -1;
      A(at(mb(1.55, .10, .95, OAK_S, 'wood'), x, .92, z));
      for (const sx of [-.62, .62]) A(at(mb(.09, .48, .09, OAK_S, 'wood'), x + sx, .68, z));
      const cv = A(at(plate(1.70, 1.15, stripeMat(accent)), x, 1.58, z + s * .10));
      cv.rotation.x = -Math.PI / 2 + s * .45; cv.userData.noCast = true;
      A(at(mb(.42, .42, .42, shade(accent, i % 2 ? .18 : -.22), 'wood'), x - .30, 1.19, z));
    }
    for (const [cx, cz, s] of [[-4.7, 2.9, .55], [-4.1, 3.35, .45], [4.5, 3.1, .50]])
      A(at(mb(s, s, s, shade(OAK_S, -.10), 'wood'), cx, .49 + s / 2, cz));
    drum(A, 2.4, .55, 4.9, .55, 2.6, OAK_D);
    A(at(mb(.10, .10, .80, IRON, 'wood'), -4.4, 3.45, 3.60));                 // the bracket lantern
    lit = lamplight(g, [[-3.6, 5.1, 3.50, .55, .80, 0], [-1.2, 5.1, 3.50, .55, .80, 0],
    [1.2, 5.1, 3.50, .55, .80, 0], [3.6, 5.1, 3.50, .55, .80, 0],
    [-3.6, 5.1, -3.50, .55, .80, 0], [-1.2, 5.1, -3.50, .55, .80, 0],
    [1.2, 5.1, -3.50, .55, .80, 0], [3.6, 5.1, -3.50, .55, .80, 0],
    [-4.4, 3.20, 3.96, .30, .38, 0]]);
    sway.push({ obj: A(at(keep(plate(1.1, .75, matFor(shade(accent, .10), 'flag'))), 5.20, 2.85, -.30)), axis: 'y', amp: .20, period: 760 });

  } else if (kind === 'chapel') {
    /* NOT a cathedral. A nave you could fit sixty people in, a lower chancel, a
       south porch, and a squat west tower with a plain parapet and no spire —
       the tallest thing in the parish at 12.6 units, which is the whole point:
       in a village the church tower wins by a little, not by a mile. */
    apron(A, 8.4);
    A(at(mb(7.20, 3.40, 4.60, FIELD, 'stone'), 0, 1.70, -.60));               // the nave
    courses(A, 7.20, 3.40, 0, 0, 1.70);
    A(at(mb(7.50, .18, 4.90, FIELD_L, 'stone'), 0, 3.48, -.60));
    A(at(mgab(7.60, 2.30, 5.00, roof, true), 0, 3.55, -.60));
    A(at(mb(7.50, .16, .28, shade(roof, .08), 'roof'), 0, 5.80, -.60));
    A(at(mb(3.80, 2.60, 3.40, FIELD, 'stone'), 0, 1.30, -4.40));              // the chancel
    A(at(mgab(4.00, 1.60, 3.60, roof, true), 0, 2.66, -4.40));
    A(at(mb(2.95, 9.60, 2.95, FIELD, 'stone'), 0, 4.80, 3.20));               // the west tower
    courses(A, 2.95, 9.60, 0, 0, 4.68);
    for (const y of [3.30, 6.40]) A(at(mb(3.15, .16, 3.15, FIELD_L, 'stone'), 0, y, 3.20));
    for (const [dx, dz] of [[-1.40, -1.40], [1.40, -1.40], [-1.40, 1.40], [1.40, 1.40]])
      A(at(mb(.62, 6.40, .62, FIELD_D, 'stone'), dx, 3.20, 3.20 + dz));       // clasping buttresses
    for (const [dx, dz, w, d] of [[0, 1.50, 1.00, .18], [0, -1.50, 1.00, .18], [1.50, 0, .18, 1.00], [-1.50, 0, .18, 1.00]])
      A(at(mb(w, 2.00, d, OAK_D, 'wood'), dx, 8.10, 3.20 + dz));              // belfry louvres
    A(at(mb(3.30, .40, 3.30, FIELD_L, 'stone'), 0, 9.80, 3.20));              // the parapet
    for (const [dx, dz] of [[-1.38, -1.38], [1.38, -1.38], [-1.38, 1.38], [1.38, 1.38]])
      A(at(mb(.34, .70, .34, FIELD_L, 'stone'), dx, 10.30, 3.20 + dz));
    A(at(mp(2.50, 2.50, .85, roof), 0, 10.42, 3.20));
    const cock = new THREE.Group();
    cock.add(at(cyl(.05, .05, 1.30, 5, IRON, 'metal'), 0, .65, 0));
    cock.add(at(plate(.50, .42, matFor(BRASS, 'metal')), .20, 1.42, 0));
    g.add(weld(at(cock, 0, 10.85, 3.20)));
    spin.push({ obj: cock, axis: 'y', rate: 7e-5, phase: 0 });
    A(at(mb(2.30, 2.20, 1.90, FIELD, 'stone'), 2.20, 1.10, 2.70));            // the south porch
    A(at(mgab(2.60, 1.35, 2.20, roof, false), 2.20, 2.20, 2.70));
    A(at(mb(1.10, 1.90, .18, OAK_D, 'wood'), 2.20, .95, 3.66));
    for (const sx of [-1, 1]) {                                               // the churchyard wall
      A(at(mb(4.20, .62, .40, FIELD, 'trim'), sx * 4.20, .31, 5.60));
      A(at(mb(4.20, .10, .48, FIELD_D, 'trim'), sx * 4.20, .66, 5.60));
      A(at(mb(.24, 2.20, .24, OAK, 'trim'), sx * .90, 1.10, 5.60));           // …and its lych gate
    }
    reed(A, 2.40, .70, 1.50, 0, 2.20, 5.60, true, thatchC);
    for (const [hx, hz, hr] of [[-3.0, 3.4, .12], [-3.9, 2.4, -.09], [3.4, 4.5, .07], [-2.4, 4.6, -.05]])
      A(at(mb(.44, .78, .12, FIELD_L, 'trim'), hx, .39, hz)).rotation.z = hr;  // headstones
    A(at(cyl(.28, .42, 1.20, 6, OAK_D, 'trim'), -4.80, .60, 2.20));           // the yew
    A(at(cone4(1.25, 2.30, 0x2F4230, 'trim'), -4.80, 2.10, 2.20));
    A(at(cone4(.85, 1.50, 0x36492F, 'trim'), -4.80, 3.30, 2.20));
    // LANCETS, NOT PICTURE WINDOWS. `lamplight` panes are unlit-black by day
    // (they carry the emissive material at zero intensity), so a 1.4 × 1.9 pane
    // on a sunlit nave wall is a hole punched in the church. Narrow openings in
    // pale stone surrounds are both what a parish church has and what reads.
    for (const [wx, wz, wy] of [[-3.60, -1.40, 0], [-3.60, .60, 0], [3.60, -1.40, 0], [3.60, .60, 0]])
      A(at(mb(.30, 1.85, 1.05, FIELD_L, 'stone'), wx, 2.05 + wy, wz - .60));
    A(at(mb(1.35, 1.95, .30, FIELD_L, 'stone'), 0, 1.95, -6.02));
    lit = lamplight(g, [
      [-3.66, 2.10, -1.40, .55, 1.45, Math.PI / 2], [3.66, 2.10, -1.40, .55, 1.45, Math.PI / 2],
      [-3.66, 2.10, .60, .55, 1.45, Math.PI / 2], [3.66, 2.10, .60, .55, 1.45, Math.PI / 2],
      [0, 1.95, -6.20, .70, 1.45, 0], [0, 5.40, 4.70, .55, .85, 0]]);

  } else if (kind === 'bell_tower') {
    /* Kept, at village scale: 15 units of civic campanile became a 10.9-unit
       stone shaft in three stages with an open oak belfry on top. The clock face
       stopped being gold leaf — a village clock is a limewashed dial with iron
       hands, and gold on it was the altar's colour doing the wrong job. */
    apron(A, 4.8);
    A(at(mb(3.70, .50, 3.70, FIELD_D, 'stone'), 0, .25, 0));
    A(at(mb(3.05, 2.60, 3.05, FIELD, 'stone'), 0, 1.80, 0));
    A(at(mb(3.25, .16, 3.25, FIELD_L, 'stone'), 0, 3.16, 0));
    A(at(mb(2.75, 2.35, 2.75, FIELD, 'stone'), 0, 4.40, 0));
    A(at(mb(2.95, .16, 2.95, FIELD_L, 'stone'), 0, 5.63, 0));
    A(at(mb(2.50, 1.25, 2.50, FIELD, 'stone'), 0, 6.30, 0));
    courses(A, 3.05, 2.60, 0, .50, 1.54);
    for (const [dx, dz] of [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]])
      A(at(mb(.30, 1.80, .30, OAK, 'trim'), dx, 7.82, dz));                   // the belfry posts
    for (const [x, z, w, d] of [[0, -1.0, 2.30, .28], [0, 1.0, 2.30, .28], [-1.0, 0, .28, 2.30], [1.0, 0, .28, 2.30]])
      A(at(mb(w, .30, d, OAK, 'trim'), x, 8.87, z));
    const bell = new THREE.Group();
    bell.add(at(mb(.90, .16, .16, OAK_D, 'wood'), 0, .06, 0));                // the headstock
    bell.add(at(cyl(.48, .82, 1.05, 10, 0x8A6A38, 'metal'), 0, -.58, 0));
    bell.add(at(ball(.15, 0x6E5327, 'metal'), 0, -1.18, 0));
    g.add(weld(at(bell, 0, 8.72, 0)));
    sway.push({ obj: bell, axis: 'z', amp: .10, period: 700 });
    A(at(mp(2.70, 2.70, 1.00, roof), 0, 9.50, 0));
    const bvane = new THREE.Group();
    bvane.add(at(cyl(.05, .05, .80, 5, IRON, 'metal'), 0, .40, 0));
    bvane.add(at(plate(.60, .40, matFor(BRASS, 'metal')), .30, .76, 0));
    g.add(weld(at(bvane, 0, 9.98, 0)));
    spin.push({ obj: bvane, axis: 'y', rate: 9e-5, phase: 0 });
    A(at(new THREE.Mesh(new THREE.CircleGeometry(.82, 20), matFor(mix(LIME, 0xFFFFFF, .30), 'trim')), 0, 6.30, 1.27));
    A(at(new THREE.Mesh(new THREE.RingGeometry(.78, .88, 20), matFor(IRON, 'trim')), 0, 6.30, 1.29));
    A(at(mb(.07, .58, .05, IRON, 'trim'), 0, 6.54, 1.31));
    A(at(mb(.46, .06, .05, IRON, 'trim'), .17, 6.24, 1.31)).rotation.z = -.50;
    A(at(mb(2.00, .12, .50, OAK_S, 'wood'), 0, .72, 2.70));                   // the bench
    for (const sx of [-.70, .70]) A(at(mb(.16, .60, .38, OAK_S, 'wood'), sx, .42, 2.70));
    A(at(mb(.90, .50, .90, FIELD_D, 'stone'), -2.40, .25, 2.20));
    lit = lamplight(g, [[0, 2.40, 1.56, .50, .80, 0], [0, 4.60, 1.41, .45, .75, 0]]);

  } else if (kind === 'village_green') {
    /* Not a building at all, which is the point: a mown common, a pond with
       geese on it, a bench, a spreading tree and a post-and-rail fence along the
       lane. It is the cheapest landmark in the set and probably the most
       village-looking thing in the town. */
    A(at(gdisc(9.60, mix(palette().ground, 0x8CA35C, .55), 26), 0, .07, 0));   // the mown common
    A(at(gring(9.05, 9.70, mix(EARTH, palette().ground, .30), 26), 0, .09, 0));  // the trodden verge
    A(at(gdisc(3.55, MUD, 22), 3.20, .10, -2.40));                             // the pond's muddy rim
    // A village pond is not a swimming pool: the day's river blue, taken most of
    // the way to the green it stands in and darkened. Saturation is the charter's
    // one hard "no" on a surface this big.
    A(at(gdisc(2.95, shade(mix(palette().water, 0x4C5A44, .46), -.16), 22, .42), 3.20, .13, -2.40));
    for (const sx of [-1, 1]) A(at(mb(.14, .80, .14, OAK_S, 'wood'), 3.20 + sx * .35, .50, -3.60));
    A(at(mb(1.00, .55, .85, LIME_D, 'wall'), 3.20, 1.12, -3.60));             // the duck house
    reed(A, 1.20, .42, 1.00, 3.20, 1.39, -3.60, true, thatchC);
    for (let i = 0; i < 4; i++) {                                             // geese
      const gs = new THREE.Group(), a = i * 1.7 + seededR(seed + i) * .7;
      const bd = ball(.26, 0xE9E5DA, 'wall'); bd.scale.set(.34, .22, .24); gs.add(at(bd, 0, .24, 0));
      gs.add(at(mb(.11, .34, .11, 0xE9E5DA, 'wall'), .18, .44, 0));
      const hd = ball(.12, 0xE9E5DA, 'wall'); gs.add(at(hd, .22, .62, 0));
      gs.add(at(mb(.15, .06, .06, 0xC98A34, 'trim'), .33, .60, 0));
      gs.rotation.y = a;
      g.add(weld(at(gs, 3.20 + Math.cos(a) * 2.30, .14, -2.40 + Math.sin(a) * 1.90)));
      sway.push({ obj: gs, axis: 'x', amp: .07, period: 900 + i * 130 });
    }
    A(at(cyl(.34, .52, 2.20, 8, 0x4A3A28, 'trim'), -3.40, 1.10, 2.00));       // the tree
    for (const [ox, oy, oz, r] of [[0, 2.90, 0, 1.90], [-.90, 2.50, .50, 1.30], [.90, 2.60, -.50, 1.35], [.10, 3.50, .30, 1.25]]) {
      const lf = ball(r, mix(0x46573D, 0x5F7247, seededR(seed + r * 7)), 'trim');
      lf.scale.set(r, r * .78, r); A(at(lf, -3.40 + ox, oy, 2.00 + oz));
    }
    A(at(mb(2.20, .13, .55, OAK_S, 'wood'), -1.40, .60, 4.40));               // the bench
    for (const sx of [-.80, .80]) A(at(mb(.16, .50, .42, OAK_S, 'wood'), -1.40 + sx, .34, 4.40));
    A(at(mb(2.20, .10, .12, OAK_S, 'wood'), -1.40, .98, 4.62));
    for (const sx of [-.80, .80]) A(at(mb(.12, .45, .12, OAK_S, 'wood'), -1.40 + sx, .84, 4.62));
    for (let i = 0; i <= 8; i++) {                                            // post and rail
      const a = -1.15 + i * .27, x = Math.cos(a) * 9.00, z = Math.sin(a) * 9.00;
      A(at(mb(.14, 1.00, .14, OAK_S, 'wood'), x, .50, z));
      if (i === 8) break;
      const a1 = a + .27, x1 = Math.cos(a1) * 9.00, z1 = Math.sin(a1) * 9.00;
      for (const y of [.42, .82])
        A(at(mb(Math.hypot(x1 - x, z1 - z), .08, .07, shade(OAK_S, -.12), 'wood'), (x + x1) / 2, y, (z + z1) / 2))
          .rotation.y = -Math.atan2(z1 - z, x1 - x);
    }
    A(at(mb(.11, 2.60, .11, IRON, 'wood'), -6.20, 1.30, -3.00));              // the green's lamp
    A(at(mb(.30, .08, .30, IRON, 'wood'), -6.20, 2.66, -3.00));
    A(at(cone4(.22, .20, IRON, 'metal'), -6.20, 2.82, -3.00));
    lit = lamplight(g, [[-6.20, 2.46, -3.00, .24, .30, 0]]);

  } else if (kind === 'inn') {
    /* The busiest building in the village and the only one lit at noon. A stone
       plinth, a plastered ground floor with a carriage arch punched through it,
       a jettied and framed upper floor, dormers, two brick stacks both drawing,
       a stable range round the back and a sign that swings. */
    apron(A, 7.4, MUD);
    A(at(mb(8.80, .55, 5.50, FIELD, 'stone'), -.20, .28, 0));
    A(at(mb(5.60, 2.55, 5.20, LIME, 'wall'), -1.60, 1.82, 0));
    A(at(mb(1.30, 2.55, 5.20, LIME, 'wall'), 3.60, 1.82, 0));
    A(at(mb(2.70, .75, 5.20, LIME, 'wall'), 1.90, 2.72, 0));                  // the arch head
    for (const sz of [-1, 1]) A(at(mb(2.90, .22, .30, OAK, 'trim'), 1.90, 2.30, sz * 2.68));
    A(at(mb(9.00, .30, 5.70, OAK, 'trim'), -.20, 3.24, 0));                   // the bressumer
    A(at(mb(8.90, 2.25, 5.70, LIME, 'wall'), -.20, 4.50, 0));                 // the jetty
    frame(A, 8.90, 2.25, -.20, 3.38, 2.83, OAK, 9);
    frame(A, 8.90, 2.25, -.20, 3.38, -2.91, OAK, 9);
    A(at(mb(9.20, .18, 5.90, OAK, 'trim'), -.20, 5.72, 0));
    A(at(mgab(9.40, 1.75, 6.10, roof, true), -.20, 5.66, 0));
    A(at(mb(9.30, .16, .28, shade(roof, .08), 'roof'), -.20, 7.36, 0));
    for (const dx of [-2.90, -.20, 2.50]) {                                   // dormers
      A(at(mb(.90, .70, .95, LIME_D, 'wall'), dx, 6.00, 2.30));
      A(at(mgab(1.10, .50, 1.05, roof, true), dx, 6.68, 2.30));
    }
    // A CHIMNEY HAS TO CLEAR ITS OWN RIDGE. The first pass put both stacks at
    // z -.7 and topped them out at 7.2 under a 7.41 ridge, so the inn's whole
    // silhouette — and both plumes of smoke — were sealed inside the roof.
    for (const [cx, cz, ct] of [[-3.40, -.20, 8.15], [2.60, .25, 7.85]]) {
      A(at(mb(.85, ct - 4.50, .85, BRICK, 'stone'), cx, (4.50 + ct) / 2, cz));
      A(at(mb(1.05, .24, 1.05, shade(BRICK, -.20), 'stone'), cx, ct + .12, cz));
      smoke.push({ p: new THREE.Vector3(cx, ct + .45, cz), every: 1250, size: .9, last: 0 });
    }
    // the arch's soffit and the shadowed passage behind it, so the opening reads
    // as somewhere a coach goes through rather than as a notch in the plaster
    A(at(mb(2.70, .12, 5.20, shade(OAK_D, -.18), 'trim'), 1.90, 2.29, 0));
    A(at(mb(2.60, 1.75, .30, shade(LIME_D, -.34), 'wall'), 1.90, 1.45, -2.35));
    for (const sx of [-1, 1]) A(at(mb(.22, 1.75, 4.80, shade(LIME_D, -.20), 'wall'), 1.90 + sx * 1.24, 1.45, 0));
    A(at(mb(5.20, 2.00, 2.60, LIME_D, 'wall'), 1.40, 1.00, -5.00));           // the stable range
    reed(A, 5.60, 1.35, 3.00, 1.40, 2.00, -5.00, true, thatchC);
    for (const dx of [-.60, 1.40, 3.40]) A(at(mb(1.10, 1.50, .14, OAK_D, 'wood'), dx, .75, -3.62));
    A(at(mb(1.90, .50, .70, FIELD_D, 'stone'), -2.40, .25, -4.20));           // the trough
    A(at(mb(1.70, .10, .50, mix(palette().water, 0x0B0F12, .38), 'glass'), -2.40, .48, -4.20));
    A(at(mb(2.60, .20, 1.30, OAK_S, 'wood'), 4.60, .86, -2.00));              // the cart
    for (const sz of [-1, 1]) drum(A, 2.30, .30, 4.60, .48, -2.00 + sz * .80, OAK_D, true);
    A(at(mb(2.00, .12, .50, OAK_S, 'wood'), -3.40, .92, 3.10));               // benches out front
    for (const sx of [-.70, .70]) A(at(mb(.16, .58, .40, OAK_S, 'wood'), -3.40 + sx, .62, 3.10));
    drum(A, 2.20, .55, -1.20, .55, 3.20, OAK_D);
    drum(A, 2.20, .55, -.40, .55, 3.45, OAK_D);
    A(at(mb(1.30, 2.10, .18, OAK_D, 'wood'), -1.60, 1.60, 2.68));             // the door
    A(at(mb(1.50, .18, .50, OAK, 'trim'), -1.60, 2.78, 2.80));
    A(at(mb(.10, .10, 1.50, IRON, 'wood'), -3.90, 3.55, 3.25));               // the sign bracket
    A(at(mb(.10, .55, .10, IRON, 'wood'), -3.90, 3.30, 3.95));
    const sign = new THREE.Group();
    sign.add(at(plate(1.15, .80, matFor(shade(accent, .06), 'wood')), 0, -.50, 0));
    sign.add(at(mb(1.20, .09, .06, OAK_D, 'wood'), 0, -.10, 0));
    sign.add(at(mb(1.20, .09, .06, OAK_D, 'wood'), 0, -.90, 0));
    g.add(weld(at(sign, -3.90, 3.50, 3.95)));
    sway.push({ obj: sign, axis: 'z', amp: .13, period: 950 });
    // Warm at noon, like the tavern — and on its OWN material, minted by asking
    // winMat for a hex nothing else uses, so driving its glow can never reach
    // the town-wide lit-window material every other building shares.
    const wm = lamplight(g, [
      [-3.30, 1.80, 2.63, .80, 1.00, 0], [-.40, 1.80, 2.63, .80, 1.00, 0], [3.60, 1.80, 2.63, .70, 1.00, 0],
      [-3.30, 4.50, 2.88, .80, 1.10, 0], [-1.30, 4.50, 2.88, .80, 1.10, 0], [.80, 4.50, 2.88, .80, 1.10, 0], [2.80, 4.50, 2.88, .80, 1.10, 0],
      [-2.90, 6.05, 2.80, .50, .50, 0], [-.20, 6.05, 2.80, .50, .50, 0], [2.50, 6.05, 2.80, .50, .50, 0],
      [-3.30, 4.50, -2.96, .80, 1.10, 0], [.80, 4.50, -2.96, .80, 1.10, 0],
      [-4.46, 1.80, .60, 1.00, 1.00, Math.PI / 2], [-4.46, 4.50, .60, 1.00, 1.10, Math.PI / 2]], 0xFFCE86);
    glow.push({ mat: wm, day: .40, night: 1.60 });
    A(at(mb(.12, .12, .50, IRON, 'wood'), 3.90, 2.95, 2.85));                 // the arch lantern
    lit = lamplight(g, [[3.90, 2.70, 3.10, .26, .32, 0]]);

  } else {
    /* THE WELL — the first thing a settlement gets, and the graceful fallback:
       a retired ladder key (wizard_tower, skygate, observatory, golden_statue,
       cathedral, windmill) lands here and raises a well rather than throwing,
       which is what keeps the window between this file and town.js's ladder
       from being a crash. */
    /* IT WAS SIX THINGS WRONG AT ONCE, and it is the FIRST landmark the town
       earns. Every one of them is worth writing down, because five of the six
       are the same mistake — geometry authored where nothing can see it:

         · THE SHAFT WAS SOLID and the water was a disc at y .55 INSIDE a drum
           that runs 0 to .74, so the one thing a well is for was sealed in
           stone. The bucket was worse: it hung 75 cm below its own beam, which
           put it at y .65 — also inside the drum. A well with no water and no
           bucket is a stone barrel with a hat on.
         · THE COPING WAS A DISC, so the drum's own lid showed as a flat stone
           plate over the mouth. A kerb is a RING. It is built here as one, in
           the `ground` role the apron has already opened, which costs nothing:
           the mouth is dark inside it and the water is 40 cm down the shaft.
         · THE POSTS STOOD ON THE DRUM at x ±1.12, which is the drum's own
           radius — so each one was buried to its knees in the stonework and
           read as a single black stick with nothing under it. They stand on the
           ground now, on their own pad stones, clear of the kerb.
         · THE ROOF WAS TOO SHALLOW FOR ITS OWN RIDGE: at h .58 over d 1.70 the
           straw roll (`reed` gives it 28 % of the depth) covered most of the
           pitch, and what was left read as a flat tilted slab with the darker
           eave course wedging out from under it. Steeper, and narrower than the
           span it covers, so the roll sits on a roof instead of being one.
         · THE WINDLASS TURNED NOTHING. No rope, no crank you could put a hand
           on, and the barrel ran the wrong way — parallel to the beam it hangs
           from rather than across the two posts.
         · AND THE TROUGH floated its own water 2 cm proud of its rim, which is
           the same bug the inn's trough has and the reason a pale slab appeared
           to hover beside the drum. */
    apron(A, 3.7);
    const wtr = palette().water;
    /* THE SHAFT, AND WHY IT IS A STACK OF FLAT PLATES. `cyl` makes CLOSED
       cylinders, so a drum always wears a stone lid and nothing put inside it
       can ever be seen — which is exactly how the water and the bucket came to
       be sealed in the masonry. The kerb's own top is therefore built as a RING
       and the mouth as a dark disc inside it, laid over the coping so the lid is
       covered rather than fought with. All three are `ground`-role plates, which
       is the bucket `apron` has already opened, so the whole of this costs no
       draw call and no material. */
    A(at(cyl(1.02, 1.16, .56, 14, FIELD, 'stone'), 0, .28, 0));               // the rubble drum
    A(at(cyl(1.18, 1.18, .10, 14, MOSS, 'stone'), 0, .06, 0));                // moss at the foot
    A(at(cyl(1.24, 1.20, .22, 14, FIELD_L, 'stone'), 0, .67, 0));             // the dressed kerb
    A(at(gring(.80, 1.25, shade(FIELD_L, -.05), 16), 0, .789, 0));            // …worn smooth on top
    A(at(gdisc(.81, 0x141811, 14), 0, .783, 0));                              // the shaft, in shadow
    A(at(gdisc(.50, mix(wtr, 0x0A1014, .34), 14), 0, .786, 0));               // …and the water in it
    // two posts, standing on the GROUND on their own pad stones, clear of the kerb
    for (const sx of [-1, 1]) {
      A(at(mb(.44, .16, .44, FIELD_D, 'stone', 1), sx * 1.42, .08, 0));
      A(at(mb(.18, 1.90, .18, OAK, 'trim'), sx * 1.42, 1.03, 0));
      A(at(mb(.46, .12, .14, OAK_D, 'trim'), sx * 1.18, 1.74, 0)).rotation.z = -sx * .66;  // knee brace
    }
    A(at(mb(3.10, .16, .18, OAK, 'trim'), 0, 1.94, 0));                       // the head beam
    /* THE ROOF IS BUILT HERE RATHER THAN BY `reed`, and this is the fix the old
       well needed most. `reed` is authored for a BUILDING: it hangs an eave
       course 5 % wider and 9 % deeper under the roof and rolls a ridge 28 % of
       the depth over the top of it, both of which are right on a 3-metre barn
       and neither of which is right on a 2-metre well-head. At this size the
       eave course is a second slab a hand's breadth under the first — the "flat
       tilted slab with a dark wedge poking through its underside" — and the roll
       is wider than the pitch it sits on. One steep mass, a narrow roll, three
       sedge stitches, and rafter feet you can see. */
    const rw = 2.90, rh = .96, rd = 1.86, ry = 1.94;
    A(at(mgab(rw, rh, rd, thatchC, true), 0, ry, 0));
    A(at(mb(rw * .96, .15, rd * .20, shade(thatchC, .07), 'roof'), 0, ry + rh - .05, 0));
    for (let i = -1; i <= 1; i++)
      A(at(mb(.06, .05, rd * .24, THATCH_D, 'roof'), i * rw * .26, ry + rh + .015, 0));
    for (const sz of [-1, 1])                                                 // the rafter feet
      A(at(mb(rw * .99, .09, .09, shade(OAK_D, .06), 'trim'), 0, ry + .02, sz * rd * .47));
    // THE WINDLASS, ACROSS THE POSTS. A barrel, its two iron gudgeons, a crank
    // with a throw and a grip you could put a hand on, and the rope it winds.
    const wl = cyl(.15, .15, 2.30, 8, OAK_D, 'wood'); wl.rotation.z = Math.PI / 2;
    A(at(wl, 0, 1.46, 0));
    for (const sx of [-1, 1]) A(at(mb(.34, .20, .20, IRON, 'metal'), sx * 1.36, 1.46, 0));
    A(at(mb(.24, .10, .10, IRON, 'metal'), 1.62, 1.46, 0));                   // the crank: stub…
    A(at(mb(.09, .09, .40, IRON, 'metal'), 1.72, 1.46, .20));                 // …throw…
    A(at(mb(.30, .08, .08, IRON, 'metal'), 1.88, 1.46, .40));                 // …and grip
    const bucket = new THREE.Group();                                         // hangs OVER the mouth
    bucket.add(at(cyl(.022, .022, .24, 5, shade(OAK_S, -.34), 'wood'), 0, -.12, 0));  // the rope
    bucket.add(at(mb(.40, .045, .045, IRON, 'metal'), 0, -.26, 0));           // its bail
    bucket.add(at(cyl(.21, .17, .30, 8, OAK_D, 'wood'), 0, -.43, 0));
    bucket.add(at(cyl(.22, .22, .045, 8, IRON, 'metal'), 0, -.34, 0));        // and its hoop
    g.add(weld(at(bucket, 0, 1.46, 0)));
    sway.push({ obj: bucket, axis: 'x', amp: .09, period: 1150 });
    /* The trough, on two stone blocks. Its water stands a few cm PROUD of the
       rim and has to: `mb` is a closed box, so a water plate set down inside a
       trough is under the trough's own lid and cannot be seen — the same trap
       that sealed the water in the shaft. Brim-full, with the rim showing all
       round it, is the honest version. It is matte, not `glass`: a 40 cm puddle
       in a shaded log takes the sky at every grazing angle a `glass` roughness
       has, and came back paler than the stone beside it — which is exactly why
       the old one read as a pale slab balanced on a box. Matte also lands it in
       the bucket the body already opened rather than minting one of its own. */
    A(at(mb(1.42, .40, .62, OAK_S, 'wood'), 2.34, .32, .10));
    A(at(mb(1.20, .06, .40, mix(wtr, 0x0A0E12, .55), 'wall'), 2.34, .53, .10));
    for (const sx of [-.48, .48]) A(at(mb(.32, .14, .48, FIELD_D, 'stone', 1), 2.34 + sx, .07, .10));
    // a pail set down beside the kerb, and it is a PAIL: a tapered tub with an
    // iron hoop and a bail, not the 30 cm stump `drum` was drawing here
    A(at(cyl(.23, .19, .32, 8, OAK_S, 'wood'), -1.66, .16, .94));
    A(at(cyl(.24, .24, .045, 8, IRON, 'metal'), -1.66, .27, .94));
    A(at(mb(.44, .045, .045, IRON, 'metal'), -1.66, .38, .94));
    // A wishing well is a real village thing, and it is the one place left where
    // gold still means tokens — a coin on the kerb, not a statue over the roof.
    // …lying FLAT. GEO.coin is already a disc about its own y axis; an older
    // rotation stood it on edge, like a wheel someone had leaned there.
    for (const [cx, cz] of [[.50, .86], [.78, .70]])
      A(at(new THREE.Mesh(GEO.coin, MAT.goldHi), cx, .80, cz)).scale.set(.21, .45, .21);
  }

  return finish(g, {
    kind, label: def.label, span: def.span, hTop: def.hTop, baseScale: 1,
    winMats: lit ? [lit] : [], spin, sway, glow, smoke, pointLights: lights
  });
}

/* ═══ bridges ═══════════════════════════════════════════════════ */
/**
 * A river crossing. Local +x runs along the span, the origin is the deck centre
 * and y = 0 is the ROAD SURFACE — town.js drops it straight onto the road plate
 * at `plan.bridges[i]` and rotates it by that entry's `a`.
 *
 * The main crossing is masonry — piers, a segmental arch, a lantern at each end;
 * the lesser ones are timber trestles. Both read at framing distance because the
 * parapets, not the deck, are the silhouette.
 * @param {{span:number,w:number,main:boolean}} spec from plan.bridges
 * @param {Paint} paint from paintBridge() @param {number} seed
 * @returns {THREE.Group}
 */
/* ── WHY THE OLD ONE READ AS A PLANK, and it was not for want of parts ──
   The crossing already had abutments, two piers, cutwaters, a segmental arch and
   a parapet. Every one of them except the parapet was drawn UNDER WATER, and
   that is a fact about two numbers in two other files: town.js floats the bridge
   group at y = .30 (the minimum lift that stops the deck being read through the
   river) and environs floats the water plate at y = .06. So the waterline sits
   at y = -.24 in this group's own space — 6 cm ABOVE the deck's own underside.
   The abutments (-.66…-.06), the cutwaters (-.85…-.15) and the whole arch were
   below it and had never once been seen; of the 2.05-unit piers, 19 cm showed.
   What was left above water was a deck and two rails: a plank.

   THE HOOK, and it is one number: `g.position.set(b.x, .30, b.z)` in town.js's
   bridge mount wants to be ~1.05, with `DECK_Y` in camera.js (which is where the
   stroll walker's feet meet a bridge) moved with it. Everything below is
   authored for that — springing at the waterline, crown under the deck — so the
   arches light up the moment it lands.
   WHAT CARRIES IT UNTIL THEN is the half of a bridge that was never in the
   water: the abutments and their splayed wing walls where the road meets the
   bank, the parapet standing on a kerb course under a coping, squared piers at
   all four corners, and — the one feature that most says "village bridge" — the
   cutwaters carried up past the deck into triangular REFUGES that break the
   parapet line. That is a silhouette from a 300-unit orbit, which two parallel
   rails never were. */
export function buildBridge(spec, paint, seed) {
  const span = Math.max(5, (spec && spec.span) || 12);
  const w = Math.max(2.4, (spec && spec.w) || 3.4);
  const main = !!(spec && spec.main);
  const { wall2, trim, stone, accent } = paint;
  const g = new THREE.Group(), A = o => { g.add(o); return o; };
  const sway = [];
  const hw = w / 2, deckB = -.30, jit = seededR(seed * 1.9 + 3.3);
  const K = main ? 'stone' : 'wood';                       // …the material it is made of
  const deckHex = main ? shade(stone, -.16) : shade(trim, -.06);
  const railHex = main ? shade(wall2, -.10) : shade(trim, -.12);
  const copeHex = main ? shade(stone, -.04) : shade(trim, -.22);
  const pierHex = main ? mix(stone, FIELD_D, .30) : shade(trim, -.18);

  // THE DECK IS A ROAD, NOT A MONUMENT. Painted in `wall` (near-white limestone)
  // it out-valued every roof in the town and pulled the eye clean off the plaza —
  // a 42-unit strip of paper laid across the river. A trodden surface is the
  // darkest part of a bridge, and the parapets carry the silhouette.
  A(at(mb(span, .30, w, deckHex, K), 0, deckB / 2, 0));
  // Grain in both directions: plank ribs on the trestle, joint courses on the
  // masonry. Either way the deck reads as made of pieces rather than poured.
  for (let i = 0; i < 7; i++)
    A(at(mb(main ? .18 : .34, .09, w, shade(main ? stone : trim, -.14), K),
      (i / 6 - .5) * (span - .9), .04, 0));

  /* THE PARAPETS carry the crossing from above: at a 300-unit orbit a bridge is
     two parallel lines with a gap between them. They stand on a KERB course now
     — the step a cart wheel is kept off the edge by — and wear a coping wide
     enough to catch the sun along its whole length. */
  for (const sz of [-1, 1]) {
    const z = sz * (hw - .13);
    A(at(mb(span, .13, .38, shade(railHex, -.08), K), 0, .065, z));
    if (main) {
      A(at(mb(span, .70, .25, railHex, 'stone', 2), 0, .48, z));
      A(at(mb(span + .12, .16, .40, copeHex, 'stone'), 0, .91, z));
    } else {
      // A TIMBER CROSSING HAS A HANDRAIL, not a wall: posts through a top rail
      // and a mid rail, with daylight between them.
      A(at(mb(span, .15, .22, copeHex, 'wood'), 0, .96, z));
      A(at(mb(span, .10, .16, railHex, 'wood'), 0, .58, z));
      const nP = clamp(Math.round(span / 2.2), 4, 9);
      for (let i = 0; i < nP; i++)
        A(at(mb(.17, .92, .21, shade(trim, -.20), 'wood', 1), (i / (nP - 1) - .5) * (span - .5), .46, z));
    }
  }
  // squared piers at all four corners — what a parapet ENDS in
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    A(at(mb(.50, 1.10, .50, copeHex, K, 1), sx * (span / 2 - .18), .55, sz * (hw - .10)));

  /* THE ABUTMENTS, and the wing walls that splay back into the bank. This is the
     answer to "the ends rest on open water": the deck lands on a mass of masonry
     that rises to the road, and two walls run back from it to hold the approach
     up. All of it is above the waterline, which the old 0.6-tall abutment sunk
     at y -.36 never was. */
  for (const sx of [-1, 1]) {
    const ex = sx * (span / 2 + .28);
    A(at(mb(1.25, 1.35, w + .62, pierHex, K, 2), ex, -.60, 0));
    A(at(mb(1.45, .18, w + .78, copeHex, K), ex, .01, 0));
    for (const sz of [-1, 1]) {
      // TALL ENOUGH TO BE BURIED. These were authored when the deck sat at
      // y .30 and their underside reached local −.57, which was under the bank.
      // The deck is at 1.05 now — the lift that finally brought the arches out
      // of the river — so −.57 is world +.48, and the bank there is carved .28
      // BELOW datum: they hung three quarters of a unit in the air. The top and
      // the coping have not moved; the wall simply reaches down into the earth
      // it is supposed to be retaining. Same box, so it costs nothing.
      const wg = A(at(mb(1.80, 1.75, .34, pierHex, K, 2), ex + sx * .80, -.625, sz * (hw + .42)));
      wg.rotation.y = -sx * sz * .42;                      // splayed into the bank
      const cp = A(at(mb(1.92, .15, .44, copeHex, K), ex + sx * .80, .29, sz * (hw + .42)));
      cp.rotation.y = -sx * sz * .42;
    }
  }

  /* THE PIERS, THEIR CUTWATERS AND THE REFUGES OVER THEM. A cutwater is a
     vertical triangular prism with its nose upstream, and on a village bridge it
     does not stop at the deck — it is carried up past the parapet as a refuge
     you step into when a cart comes. `GEO.gable` is that prism already; turned
     -90° about x its extrusion becomes the vertical and its apex the nose. */
  const nP = main ? clamp(Math.round(span / 11), 2, 3) : 2;
  const pierW = main ? 1.20 : .70, nose = main ? 1.05 : .60;
  const pierX = [];
  for (let i = 0; i < nP; i++) pierX.push((((i + 1) / (nP + 1)) - .5) * span * (.94 + jit * .06));
  pierX.forEach((px, i) => {
    A(at(mb(pierW, 2.60, w * .84, pierHex, K, 2), px, deckB - 1.30, 0));
    for (const sz of [-1, 1]) {
      const cw = new THREE.Mesh(GEO.gable, matFor(pierHex, K));
      cw.rotation.x = -Math.PI / 2 * sz; cw.scale.set(pierW, nose, 2.40);
      A(at(tag(cw, K), px, deckB - 1.20, sz * (w * .42)));
    }
    // …and up into a refuge, on alternate sides, so the parapet is never a
    // 40-unit unbroken line and the crossing has something to read at any angle
    const sz = i % 2 ? 1 : -1, rz = sz * (hw + nose * .34);
    A(at(mb(pierW * .92, 1.32, nose * .82, pierHex, K, 2), px, .26, rz));
    A(at(mb(pierW * 1.06, .17, nose * .96, copeHex, K), px, .99, rz));
  });

  /* THE ARCHES. One barrel per opening: springing at the waterline, crown tucked
     under the deck. Four radial segments is deliberate — an arch ring is dressed
     stone with visible joints, not a pipe — and at 96 triangles apiece three of
     them cost less than half of what the single 6×22 torus they replace did.
     Not one pixel of this shows until the deck lift above lands; it is the part
     that stops being a lie when it does. */
  if (main) {
    const bounds = [-span / 2 - .2].concat(pierX).concat([span / 2 + .2]);
    for (let i = 0; i + 1 < bounds.length; i++) {
      const c = Math.max(1.6, (bounds[i + 1] - bounds[i]) - pierW);
      const rise = Math.min(1.15, c * .34);
      const r = (c * c / 4 + rise * rise) / (2 * rise), th = Math.asin(clamp(c / (2 * r), 0, 1));
      const arch = new THREE.Mesh(new THREE.TorusGeometry(r, .26, 4, 12, th * 2), matFor(pierHex, 'stone'));
      arch.rotation.z = Math.PI / 2 - th;                  // centre the arc on the crown
      arch.scale.z = (w * .80) / .52;
      A(at(tag(arch, 'stone'), (bounds[i] + bounds[i + 1]) / 2, deckB - .08 - r, 0));
    }
  }

  let lit = null;
  if (main) {
    lit = winMat(0xffd68c);
    // a lamp standing ON the corner pier at each end, on opposite kerbs — the
    // bridge-watchers' corner. It used to be a 2.1-unit post rising off the deck
    // beside the parapet, with the parapet's own coping cutting across its shin.
    for (const sx of [-1, 1]) {
      const post = new THREE.Group();
      post.add(at(mb(.14, 1.02, .14, trim, 'wood'), 0, .51, 0));
      post.add(at(mb(.40, .09, .40, copeHex, 'stone'), 0, 1.06, 0));
      const pane = new THREE.Mesh(GEO.unit, lit);
      pane.scale.set(.27, .34, .27); post.add(at(pane, 0, 1.28, 0));
      post.add(at(cone4(.30, .28, shade(accent, -.1), 'metal'), 0, 1.56, 0));
      A(weld(at(post, sx * (span / 2 - .18), 1.10, sx * (hw - .10))));
      sway.push({ obj: post, axis: 'z', amp: .035, period: 1700 });
    }
  }

  return finish(g, {
    kind: 'bridge', label: main ? 'Stone Bridge' : 'Timber Bridge',
    hTop: main ? 2.9 : 2.2, baseScale: 1, span: 1, deckSpan: span,
    winMats: lit ? [lit] : [], sway
  });
}

/* ═══ trees ═════════════════════════════════════════════════════ */
/** @param {number} seed @returns {THREE.Group} kind:'tree' */
export function buildTree(seed) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(GEO.trunk, MAT.trunk); trunk.position.y = .4; g.add(trunk);
  const c1 = new THREE.Mesh(GEO.leafA, MAT.leafA); c1.position.y = 1.5; g.add(c1);
  const c2 = new THREE.Mesh(GEO.leafB, MAT.leafB); c2.position.y = 2.3; g.add(c2);
  const s = .8 + seededR(seed) * .6; g.scale.set(s, s, s);
  g.rotation.y = seededR(seed + 5) * 6.28;
  // three shared geometries already — merging would mint a unique buffer per tree
  return finish(g, { kind: 'tree', label: 'break', hTop: 2.9 * s, baseScale: s }, true);
}

/* ═══ the next-building progress meter ══════════════════════════ */
/**
 * Stands alone on the plot being paid for.
 * @returns {THREE.Group} userData.setHeight / setProgress / setGhost
 */
export function buildScaffold() {
  const g = new THREE.Group();
  // Lit timber, not an unlit wireframe: the old chartreuse MeshBasicMaterial cage
  // stayed at full brightness at midnight and read as hazard tape around a vacant
  // lot. A cottage-sized frame of MeshStandardMaterial posts on a patch of
  // trodden earth reads as a building site at every hour.
  const R = 1.5;
  const woodM = new THREE.MeshStandardMaterial({ color: 0x7A6446, roughness: .92 });
  const plankM = new THREE.MeshStandardMaterial({ color: 0x8E7752, roughness: .95 });
  const dirtM = new THREE.MeshStandardMaterial({ color: 0x6A6150, roughness: 1 });
  const trackM = new THREE.MeshStandardMaterial({ color: 0x322E26, roughness: .9 });
  const fillM = new THREE.MeshStandardMaterial({
    color: 0xF3D07A, emissive: 0xD9A441, emissiveIntensity: .5, roughness: .6
  });
  const ghostable = [woodM, plankM, dirtM];
  const dirt = new THREE.Mesh(GEO.plane, dirtM);
  dirt.rotation.x = -Math.PI / 2; dirt.scale.set(R * 2.5, R * 2.5, 1); dirt.position.y = .05; g.add(dirt);

  const posts = [], rails = [], braces = [];
  for (const [dx, dz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
    const p = new THREE.Mesh(GEO.unit, woodM);
    p.scale.set(.16, 1, .16); p.position.set(dx, .5, dz); g.add(p); posts.push(p);
  }
  for (const k of [.46, .95]) {
    const band = [];
    for (const [x, z, w, d] of [[0, -R, R * 2, .1], [0, R, R * 2, .1], [-R, 0, .1, R * 2], [R, 0, .1, R * 2]]) {
      const b = new THREE.Mesh(GEO.unit, woodM);
      b.scale.set(w, .11, d); b.position.set(x, 1, z); g.add(b); band.push(b);
    }
    rails.push({ band, k });
  }
  for (const [x, z, ry] of [[0, -R, 0], [-R, 0, Math.PI / 2]]) {          // diagonal braces
    const b = new THREE.Mesh(GEO.unit, woodM);
    b.scale.set(.1, 1, .1); b.position.set(x, .5, z); b.rotation.y = ry; g.add(b); braces.push(b);
  }
  for (let i = 0; i < 3; i++) {                                            // plank stack
    const pl = new THREE.Mesh(GEO.unit, plankM);
    pl.scale.set(1.9, .14, .42);
    pl.position.set(R + .55, .07 + i * .15, -R + .5 + i * .06);
    pl.rotation.y = .18 + i * .07; g.add(pl);
  }
  // The readout: a wide bar on ONE face, sized to be legible from 240 units out
  const track = new THREE.Mesh(GEO.unit, trackM);
  track.scale.set(1.25, 1, .12); g.add(track);
  const fill = new THREE.Mesh(GEO.unit, fillM);
  fill.scale.set(1.1, .01, .1); g.add(fill);
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  dirt.receiveShadow = true;

  let H = 1, P = 0;
  const layout = () => {
    for (const p of posts) { p.scale.y = H; p.position.y = H / 2; }
    for (const r of rails) for (const b of r.band) b.position.y = H * r.k;
    for (const b of braces) {
      const len = Math.hypot(R * 2, H);
      b.scale.y = len; b.position.y = H / 2;
      b.rotation.z = Math.atan2(R * 2, H) * (b.rotation.y ? -1 : 1);
    }
    const bh = Math.max(.12, H * .88);
    track.scale.y = bh; track.position.set(0, bh / 2 + .05, R + .1);
    const f = Math.max(.01, P * bh);
    fill.scale.y = f; fill.position.set(0, f / 2 + .05, R + .17);
  };
  layout();

  const out = finish(g, {
    kind: 'scaffold', label: 'next building', hTop: 1, baseScale: 1,
    setHeight(h) { H = Math.max(.4, h || 0); layout(); g.userData.hTop = H; },
    setProgress(p) { P = clamp(p || 0, 0, 1); layout(); },
    /** Tint the progress bar. Always gold: gold is the only colour that means tokens. */
    setTint(hex) { fillM.color.setHex(hex); fillM.emissive.setHex(hex); },
    setGhost(on) {
      for (const m of ghostable) { m.transparent = on; m.opacity = on ? .26 : 1; m.needsUpdate = true; }
      track.visible = fill.visible = !on;
    }
  }, true);
  for (const p of posts) p.castShadow = true;
  dirt.receiveShadow = true;
  return out;
}

/* ═══ disposal ══════════════════════════════════════════════════ */
/** Dispose a group's owned geometry/materials; cached shared ones are spared. */
export function disposeGroup(g) {
  g.traverse(o => {
    if (o.isInstancedMesh) o.dispose();
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.geometry && !OWNED_GEO.has(o.geometry)) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]))
      if (m && !OWNED_MAT.has(m)) m.dispose();
  });
}
