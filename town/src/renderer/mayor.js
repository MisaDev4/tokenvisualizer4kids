// THE MAYOR — idea T-22. One named civic figure, unlocked at a milestone the
// caller names, who lives on the square, walks out to the fountain now and then,
// and tells the village how it is getting on.
//
// He is a VILLAGE mayor and nothing else (AESTHETIC.md): a long wool coat, a
// short shoulder cape, a broad felt hat, a linen cravat and a brass chain of
// office with a medallion on it. No staff, no crown, no glow, no floating
// anything. He is ~35 % taller than a villager and half again as broad, which
// with the hat brim and the one brass glint at his chest is what makes him
// findable in a crowd of 900 at normal framing — the silhouette does the work,
// not the size.
//
// Three rules govern this file:
//
//  1. EXISTENCE IS WALL-CLOCK. Whether he is out, where along the walk he is,
//     whether the bubble is up and when he goes home are all derived from
//     `performance.now()` deltas against a phase stamp — never from accumulated
//     `dt`. A headless run paints at ~1 fps; a screenshot 9 s in must show him
//     genuinely part-way across the square, not standing on his doorstep with a
//     frame counter that never advanced. `dt` is read for exactly nothing.
//  2. HE NEVER ASKS FOR MORE. The copy gate is absolute and it is the reason
//     this module has a corpus of its own rather than borrowing the Crier's: no
//     line may nag, guilt, chase, set a target, mention a streak the town is in
//     danger of losing, or observe that anything has slowed. A quiet day is a
//     good day and several lines say so warmly. He celebrates what exists.
//  3. EVERY INPUT IS OPTIONAL. `initMayor(null, undefined)` builds, updates,
//     resets and disposes without throwing — it just never has a scene to stand
//     in, so it stands in none. Absent `facts` means he has nothing true to say
//     and says nothing at all rather than printing an empty slot.
//
// Imports: three, and surface.js for the town's shared material pass. Nothing
// else. He never learns that news.js, npcs.js or town.js exist — the caller
// hands him a `say`, a `facts` and a couple of getters and mediates the rest.
import * as THREE from './vendor/three.module.js';
import { applyTownSurface } from './surface.js';

/**
 * The default unlock, in tokens: the `market_day` rung of town.js's LADDER —
 * the moment the place stops being a hamlet and gets a market hall. It is
 * exported rather than buried so the caller can pass its own rung
 * (`LADDER.find(m => m.id === 'market_day').tok`) and this file never becomes
 * the second owner of the ladder.
 */
export const MAYOR_UNLOCK_TOK = 10e6;

/* ── the wall clock, in ms. Every one of these is a DEADLINE, not a duration to
      integrate: a phase ends when now ≥ t0 + span, whatever the frame rate. ── */
const WALK_MS = 6500;      // residence → the mark at the fountain
const ARRIVE_MS = 9000;    // …the inaugural walk, from the edge of town, slower
const MARK_WAIT_MS = 6000;  // he will wait this long for the Crier to finish
const SPEAK_MS = 9000;      // he holds the square
const BUB_MS = 7600;        // …and the remark hangs for most of it
const LINGER_MS = 4500;     // stays on afterward, being seen
const BACK_MS = 7000;       // and walks home
const FIRST_MS = 6000;      // first address after a quiet unlock
const PERIOD_MS = 8 * 60000;   // between addresses. An occasion, not a loop.
const RETRY_MS = 2500;      // …when the bubble was refused (off screen, pool full)

/* ── proportions, in LOCAL units. A villager is 0.60 tall at scale 1 and is
      drawn at scale ~1.55, so authoring him at 0.80 and drawing at 1.62 puts his
      hat brim at ~1.30 world units against a villager's ~0.95. ── */
const SCALE = 1.62;
const HAT_TOP = 0.855;      // local y of the crown — the bubble's tether
const COAT_H = 0.46, SHOULDER_Y = 0.455, HEAD_Y = 0.585;

/* ── the wardrobe. Weathered wool, felt, linen, oak and brass; no saturated
      primaries, nothing plastic. The coat is the darkest large surface on the
      square, which is exactly why he reads against the villagers' warm robes. ── */
const WOOL = 0x33403A, WOOL_D = 0x28322D, FELT = 0x2B2822;
const LINEN = 0xE3DCC8, BRASS = 0xB08A3E, OAK = 0x5A4330;
const SKINS = [0xF2CBA6, 0xE0B187, 0xC98F63, 0xA5714A, 0x7B5334];

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const easeInOut = k => k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
/** three's convention: local +z is front, so facing (dx,dz) is atan2(dx,dz). */
const faceOf = (dx, dz) => Math.atan2(dx, dz);
const wrapPi = d => { d = (d + Math.PI) % (Math.PI * 2); return (d < 0 ? d + Math.PI * 2 : d) - Math.PI; };

/** Seeded, non-allocating. §11.1 bans Math.random() outside particles and gait. */
const stream = s => { let r = (s >>> 0) || 1; return () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; }; };
const hash1 = s => {
  let x = Math.imul((s | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/* ═══ the name ══════════════════════════════════════════════════
   Minted from the plan seed, so a township keeps its mayor for the whole epoch
   and `?seed=N` twice elects the same person. The register matches the town's
   voice (news.js's FOLK, npcs.js's roster) without importing either — a lateral
   import for twenty strings would be a worse trade than twenty strings. */
const GIVEN = ['Ambrose', 'Perpetua', 'Cornelius', 'Hesper', 'Bartholomew', 'Wilhelmina',
  'Osric', 'Clemency', 'Reginald', 'Dorcas', 'Aloysius', 'Temperance', 'Horatio', 'Millicent',
  'Ferdinand', 'Augusta', 'Lambert', 'Prudence', 'Silas', 'Honoria'];
const SUR = ['Pemberton', 'Cachewright', 'Ledgerly', 'Dunnage', 'Whistledown', 'Bellwether',
  'Thackery', 'Marrowby', 'Quilty', 'Hollowell', 'Prendergast', 'Winterbourne', 'Oakstave',
  'Fettle', 'Ravensworth', 'Micklewhite', 'Barrowmill', 'Stapleford', 'Vellum', 'Kettlewell'];

/**
 * The mayor's name for a given seed. Deterministic, stable for the epoch.
 * @param {number} seed  ctx.planSeed
 * @returns {string} e.g. 'Ambrose Pemberton' — the title is carried separately
 */
export function mayorNameFor(seed) {
  const s = (seed >>> 0) || 1;
  return GIVEN[Math.floor(hash1(s + 613) * GIVEN.length) % GIVEN.length] + ' ' +
    SUR[Math.floor(hash1(s + 26417) * SUR.length) % SUR.length];
}

/* ═══ THE CORPUS ════════════════════════════════════════════════
   Register: a proud small-town official. Warm, faintly pompous, fond of the
   place and of his own chain of office. Deadpan; never explains the joke.
   Spoken aloud, so one or two short sentences — the crier bubble is wide enough
   for about seventy characters at normal framing.

   THE COPY GATE, checked line by line and binding on anything added here:
     · Nothing may nag, guilt, chase or pressure. NO SECOND PERSON AT ALL —
       not "you", not "your", not even in an idiom. The mayor talks TO the
       village ABOUT the village; the moment a line can be read as addressed
       to the person watching, it can be read as a demand made of them.
     · No targets, no goals, no streak that could be broken, no "keep it up",
       no "come back", no observation that anything has slowed or fallen off.
     · A quiet day is a GOOD day and the QUIET pool says so without irony.
     · He celebrates what exists. He never once asks for more of it.

   `{slots}` are resolved from the Crier's world model; any slot in NEEDS that
   resolves to 0 or '' makes the whole line unusable, so a fact the town does not
   have yet is never printed as a blank. */
const RAW = {
  /* ── his first words in office. No slots but {town}: he may be elected in a
        hamlet with nothing else to boast of yet. ── */
  INAUGURAL: [
    'I accept the office, the chain and the hat. Chiefly the hat.',
    'Sworn in beside the fountain, as the charter requires. Splendid.',
    '{town} has a mayor now. {town} appears to be taking it well.',
    'My first act in office: to stand here and admire the place.',
    'I am {mayor}, and I intend to be insufferable about this town.',
    'The chain fits. The town fits. We shall get along famously.'
  ],
  /* ── the town is bigger than it was ── */
  BUILD: [
    '{b} roofs under my care, and every one of them a good roof.',
    'The survey stands at {b} buildings. I have counted them. Twice.',
    '{b} buildings in {town}, and not one of them an eyesore. Nearly.',
    'Another street finished. {town} is getting itself a reputation.',
    'The plat now carries {b} houses. The map has needed a second sheet.'
  ],
  /* ── AESTHETIC.md rule 2: the people are the point, so the mayor is proudest
        of them. This pool is weighted highest of the boasts. ── */
  PEOPLE: [
    '{villagers} souls in {town}, and every one of them accounted for.',
    'A census of {villagers}. I know most of their names. Some of them.',
    '{villagers} villagers. The square has never been so hard to cross.',
    'Population {villagers}. The baker has asked me to stop announcing it.',
    '{villagers} neighbours, one fountain, and a great deal of goodwill.',
    'There are {villagers} of us now. I find that genuinely marvellous.'
  ],
  /* ── the ledger. States the figure; never suggests a bigger one. ── */
  TOTAL: [
    'The ledger reads {tok}. I have had it read to me slowly, for pleasure.',
    '{tok} through the counting house. Remarkable. Wholly remarkable.',
    'The treasury stands at {tok}, and nobody is to touch it.',
    'Our books balance at {tok}. Three clerks have fainted with relief.'
  ],
  /* ── the Chronicle Stone. Upward only, and admiring — the record is a thing
        the town HAS, never a bar it is under. ── */
  RECORD: [
    'The Stone still reads {best}. A fine figure. It has earned its rest.',
    'Our record stands at {best}, and the mason is proud of the lettering.',
    'The Stone says {best}. I have polished it. It did not need polishing.'
  ],
  /* ── landmarks ── */
  LANDMARK: [
    'The {landmark} is finished. I cut a ribbon. I kept the ribbon.',
    'We have a {landmark} now. Few villages of this size can say so.',
    'The {landmark} stands. The masons have my thanks and my whole budget.'
  ],
  GRANDEST: [
    'The finest building in {town} is a {grandest}. I say that without envy.',
    'A {grandest} is the pride of this parish, and I did not build it.'
  ],
  TIER: [
    'The {tierName} is a credit to the square. And to the masons. Mostly them.',
    'They call it the {tierName} now. I shall try to live up to it.'
  ],
  /* ── the archive and the unbroken run. SPELL states a length; there is no
        line here about a run ending, and none may be added. ── */
  SPELL: [
    '{spell} days running, and the bunting is holding up admirably.',
    'A spell of {spell} days. The pennant-maker has never been happier.'
  ],
  ARCHIVE: [
    '{days} towns before this one in the record. I have read all of it.',
    'The archive holds {days} towns. Ours is the one I am standing in.'
  ],
  MILES: [
    '{milestones} milestones on the books. I intend to frame the list.',
    'We have passed {milestones} marks of note. Each one had a cake.'
  ],
  /* ── THE QUIET POOL. The most important twelve lines in the file: a slow hour
        is celebrated on its own terms, warmly, with no hint that it should have
        been otherwise. Nothing here notices an absence. ── */
  QUIET: [
    'A quiet afternoon in {town}. The trees consider it the best kind.',
    'The square is quiet. A quiet square is a contented square.',
    'Nothing much happened today, and it happened beautifully.',
    'A slow hour. I have spent it admiring the fountain. I recommend it.',
    '{breaks} groves where the work stopped. The town is better for the shade.',
    'The orchards were planted in the hours nobody was counting. Good hours.',
    'A restful day is entered in the almanac as restful. That is the whole entry.',
    'Peace in {town}, and a clerk asleep at his desk. Leave him.'
  ],
  /* ── after dark ── */
  NIGHT: [
    'Lamps lit, doors shut, town accounted for. Goodnight, {town}.',
    'The night watch reports nothing, at length. I am delighted.',
    '{town} sleeps well. That is a mayor\'s whole job, in the end.',
    'A fine night for standing about being mayor. Which I am. Doing.',
    'The lanterns are lit and the fountain is talking to itself. Lovely.'
  ],
  /* ── the town is visibly busy. Praise for the town, never a demand. ── */
  BOOM: [
    'Busy morning. The carts have not stopped and neither has the baker.',
    'A great deal is happening at once. I am extremely calm about it.',
    'The town is humming. I take no credit and all of the pride.',
    'Every scaffold in {town} is occupied. I have stopped counting hammers.'
  ],
  /* ── pompous civic filler, always usable, so the bag is never empty ── */
  CIVIC: [
    'The council met. The council will meet again. That is the council.',
    'I have inspected the fountain. It is wet. Excellent.',
    'Complaints this week: one. About me. From me.',
    'A word from the mayor: things are, on balance, good.',
    'The state of {town} is sound. I have the chain to prove it.',
    'Business of the day: none. Mood of the day: excellent.',
    'I am told the economy is doing something. It looks well on it.',
    'Order in the square! …much obliged. That was all.',
    'I have been asked to say a few words. These are they.',
    '{town} is in good heart. So, for the record, is its mayor.',
    'The bench has been repaired. I shall now sit on it, officially.',
    'I declare this an ordinary day, and ordinary days are underrated.'
  ]
};

/** Slots whose absence would make a line a lie or a blank. `{town}` and
 *  `{mayor}` are not in here: both always resolve. */
const NEEDS = {
  b: 1, villagers: 1, tok: 1, best: 1, landmark: 1, grandest: 1,
  tierName: 1, spell: 1, days: 1, milestones: 1, breaks: 1
};

const SLOT_RE = /\{(\w+)\}/g;
/** Compiled once at load: text plus its distinct slot names. */
function compile(lines) {
  const n = lines.length, c = { n, text: lines.slice(), slots: new Array(n) };
  for (let i = 0; i < n; i++) {
    const s = []; let m;
    SLOT_RE.lastIndex = 0;
    while ((m = SLOT_RE.exec(lines[i]))) if (s.indexOf(m[1]) < 0) s.push(m[1]);
    c.slots[i] = s;
  }
  return c;
}
const CORPUS = {};
for (const k in RAW) CORPUS[k] = compile(RAW[k]);

/** The frozen corpus, for tests and for reading the copy gate in one place. */
export const MAYOR_CORPUS = (() => {
  const o = {};
  for (const k in RAW) o[k] = Object.freeze(RAW[k].slice());
  return Object.freeze(o);
})();

/* ═══ geometry helper ═══════════════════════════════════════════
   A mayor assembled as fourteen meshes would be fourteen draw calls for one
   character. Merging by MATERIAL takes it to nine, and the merge is trivial
   because every source primitive is a three built-in with matching attributes.
   Non-indexed throughout: the arithmetic is then a straight concatenation. */
function mergeGeos(parts) {
  let total = 0;
  const gs = [];
  for (const p of parts) {
    const src = p.geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (p.m) g.applyMatrix4(p.m);          // transforms normals too
    src.dispose();                          // the un-merged source never renders
    gs.push(g);
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of gs) {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    pos.set(P.array, o * 3);
    if (N) nor.set(N.array, o * 3);
    if (U) uv.set(U.array, o * 2);
    o += P.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}
/** Build a TRS matrix without leaking scratch into the module scope. */
function mat(x, y, z, rx, s) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, 0, 0));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s || 1, s || 1, s || 1));
  return m;
}

/* ═══ types ═════════════════════════════════════════════════════ */

/**
 * @typedef {Object} MayorCfg   every field optional; every absent field a no-op
 * @property {number} [unlockTok]     tokens at which he takes office. Default MAYOR_UNLOCK_TOK.
 * @property {number} [unlockTier]    …or a fountain tier; whichever fires first wins.
 * @property {Object} [facts]         news.facts — READ IN PLACE, never retained by value
 * @property {(v:THREE.Vector3, kind:string, opts?:Object)=>boolean} [say]  news.say
 * @property {()=>boolean} [crierSpeaking]   he waits for the Crier rather than talking over him
 * @property {()=>THREE.Vector3} [getCoinPos]  fountain.getCoinPos — what he addresses
 * @property {()=>number} [fountainR]        fountain.radius — his keep-out
 * @property {()=>number} [plazaR]           live plaza radius
 * @property {(x:number,z:number)=>number} [sampleHeight]  env.sampleHeight; 0 when absent
 * @property {()=>{x:number,z:number}} [homePos]   his residence; derived from the plaza when absent
 * @property {number} [seed]          ctx.planSeed — his name and the line shuffle
 * @property {number} [periodMs]      between addresses. Default 8 min.
 * @property {string} [bubbleKind]    news.js bubble class. Default 'crier' (the wide gold one).
 * @property {(info:MayorInfo)=>void} [onUnlock]   fired ONCE, only for a live arrival
 * @property {(text:string, info:MayorInfo)=>void} [onAddress]  each address, as he begins it
 */
/**
 * @typedef {Object} MayorInfo
 * @property {string} name @property {string} title @property {boolean} ceremony
 * @property {number} x @property {number} y @property {number} z
 */
/**
 * @typedef {Object} Mayor
 * @property {THREE.Group} group
 * @property {boolean} unlocked @property {boolean} present @property {boolean} speaking
 * @property {string} name @property {string} title @property {string} state
 * @property {number} draws        draw calls he is costing RIGHT NOW
 * @property {(opts?:{ceremony?:boolean})=>boolean} unlock
 * @property {(text?:string)=>boolean} address
 * @property {()=>?{x:number,y:number,z:number,name:string,text:string,ready:boolean}} speech
 * @property {(dt:number, now:number, ctx:Object)=>void} update
 * @property {()=>void} reset @property {()=>void} dispose
 */

/* states, in order of the routine */
const S_LOCKED = 'locked', S_HOME = 'home', S_WALK = 'walking', S_ARRIVE = 'arriving',
  S_MARK = 'waiting', S_SPEAK = 'speaking', S_LINGER = 'lingering', S_BACK = 'returning';

/**
 * Build the mayor and add him to the scene. Null-safe: `initMayor(null)` returns
 * a working handle that simply has nowhere to stand.
 * @param {?THREE.Scene} scene
 * @param {MayorCfg} [cfg]
 * @returns {Mayor}
 */
export function initMayor(scene, cfg) {
  const o = cfg || {};
  const fn = (f, d) => typeof f === 'function' ? f : d;

  const sayFn = typeof o.say === 'function' ? o.say : null;
  const crierBusy = fn(o.crierSpeaking, () => false);
  const coinPos = fn(o.getCoinPos, null);
  const fountainR = fn(o.fountainR, () => 4.0);
  const plazaRFn = fn(o.plazaR, () => 12);
  const heightAt = fn(o.sampleHeight, () => 0);
  const homeFn = fn(o.homePos, null);
  const onUnlock = fn(o.onUnlock, null);
  const onAddress = fn(o.onAddress, null);
  const bubbleKind = typeof o.bubbleKind === 'string' ? o.bubbleKind : 'crier';
  const periodMs = o.periodMs > 0 ? o.periodMs : PERIOD_MS;
  const unlockTok = typeof o.unlockTok === 'number' && o.unlockTok >= 0 ? o.unlockTok : MAYOR_UNLOCK_TOK;
  const unlockTier = typeof o.unlockTier === 'number' ? o.unlockTier : Infinity;
  /** news.facts, read in place. Absent ⇒ every slotted line is unusable and the
   *  CIVIC/QUIET/NIGHT pools carry him — which is the honest degradation. */
  let facts = o.facts && typeof o.facts === 'object' ? o.facts : null;

  let seed = (o.seed >>> 0) || 1;
  let rnd = stream(seed ^ 0x51ed270b);
  let name = mayorNameFor(seed);
  const TITLE = 'THE MAYOR';

  /* ── the figure ──────────────────────────────────────────────── */
  const geos = [], mats = [];
  const group = new THREE.Group();
  group.name = 'mayor';
  group.visible = false;
  let disposed = false;

  const surf = (m, role) => { applyTownSurface(m, role || 'prop'); mats.push(m); return m; };
  const std = (color, opt) => surf(new THREE.MeshStandardMaterial(
    Object.assign({ color, roughness: .93, metalness: 0 }, opt)));

  const matWool = std(WOOL, { flatShading: true, roughness: .95 });
  const matCape = std(WOOL_D, { flatShading: true, roughness: .96 });
  const matFelt = std(FELT, { roughness: .97 });
  const matLinen = std(LINEN, { roughness: .88 });
  const matOak = std(OAK, { roughness: .9 });
  const matSkin = std(SKINS[Math.floor(hash1(seed + 91) * SKINS.length) % SKINS.length], { roughness: .86 });
  // The one glint on him. 'metal' is surface.js's tighter-rim variant, which
  // with bloom on is the difference between brass-coloured and brass.
  const matBrass = surf(new THREE.MeshStandardMaterial({
    color: BRASS, roughness: .34, metalness: .8, emissive: 0x1c1204, emissiveIntensity: .22
  }), 'metal');
  const matDisc = (m => (mats.push(m), m))(new THREE.MeshBasicMaterial({
    color: 0x0a0c07, transparent: true, opacity: .26, depthWrite: false
  }));

  const add = (geo, m, name_) => {
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name_;
    // No real shadow, for npcs.js's reason: the shadow map covers a 300-unit
    // town and is only re-armed twice a second, so a moving 1.3-unit caster
    // produces shimmer and lag. The contact disc grounds him instead.
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.frustumCulled = false;         // one object, and culling it costs more
    group.add(mesh);
    return mesh;
  };

  // 1 · the coat. A lathe: hem flaring out at the ground, waist, chest, and the
  // opening at the neck. Eight segments and flat-shaded, so it reads as cut
  // cloth rather than as a lampshade.
  const coatProf = [[0, 0], [.205, 0], [.196, .07], [.168, .20], [.150, .33],
  [.142, .42], [.128, COAT_H], [0, COAT_H]].map(p => new THREE.Vector2(p[0], p[1]));
  // 2 · the shoulder cape — the single most mayoral piece of the silhouette: it
  // widens him at exactly the height the eye reads a person's build. Its hem is
  // held at .196, INSIDE the shoulder line, or it swallows both arms.
  const capeProf = [[.100, .10], [.196, 0], [.190, -.02], [.088, .075]]
    .map(p => new THREE.Vector2(p[0], p[1]));
  const coat = add(mergeGeos([
    { geo: new THREE.LatheGeometry(coatProf, 8) }
  ]), matWool, 'coat');
  const cape = add(mergeGeos([
    { geo: new THREE.LatheGeometry(capeProf, 8), m: mat(0, SHOULDER_Y - .10, 0) }
  ]), matCape, 'cape');

  // 3 · head
  add(new THREE.SphereGeometry(.128, 10, 8).translate(0, HEAD_Y, 0), matSkin, 'head');

  // 4 · the hat: broad brim, straight crown. The brim is what makes him
  // identifiable from above, which is the angle this camera mostly uses — and
  // it has to sit ON the skull (head top is .713), not through it.
  const hat = add(mergeGeos([
    { geo: new THREE.CylinderGeometry(.262, .268, .022, 14), m: mat(0, .716, 0) },
    { geo: new THREE.CylinderGeometry(.134, .144, .140, 12), m: mat(0, .785, 0) },
    { geo: new THREE.CylinderGeometry(.136, .136, .014, 12), m: mat(0, .722, 0) }   // the brim's inner rim
  ]), matFelt, 'hat');

  // 5 · linen: the cravat at the throat and two cuffs at the wrists' rest pose
  add(mergeGeos([
    { geo: new THREE.CylinderGeometry(.072, .086, .045, 8), m: mat(0, .500, .012) },
    { geo: new THREE.SphereGeometry(.042, 6, 5), m: mat(0, .468, .062) }
  ]), matLinen, 'cravat');

  // 6 · THE CHAIN OF OFFICE — the one thing on him that catches the light, and
  // the detail that says "mayor" rather than "man in a good coat". It lies ON
  // the cape (r .175 against the cape's .162 at that height) and the medallion
  // hangs BELOW the cape hem, which is both how a real chain sits and the only
  // way either part is visible from a camera 60 units out. The hat band's
  // buckle is the third piece and rides in the same mesh.
  add(mergeGeos([
    { geo: new THREE.TorusGeometry(.175, .0165, 5, 16), m: mat(0, .400, .004, Math.PI / 2) },
    { geo: new THREE.CylinderGeometry(.052, .052, .016, 10), m: mat(0, .295, .170, Math.PI / 2) },
    { geo: new THREE.BoxGeometry(.020, .075, .014), m: mat(0, .348, .168) },   // the link between them
    { geo: new THREE.BoxGeometry(.042, .028, .018), m: mat(0, .742, .140) }
  ]), matBrass, 'chain');

  // 7/8 · the arms. Separate meshes because they are the only part that moves
  // independently; the geometry is SHARED, so it is two draw calls and one
  // buffer. Pivot at the shoulder, exactly as npcs.js poses a villager's — and
  // registered for disposal exactly once, by hand, because `add` would list it
  // twice and dispose it twice.
  const armGeo = new THREE.CapsuleGeometry(.050, .135, 1, 6).translate(0, -.105, 0);
  geos.push(armGeo);
  const armL = add(armGeo, matWool, 'armL');
  const armR = add(armGeo, matWool, 'armR');
  geos.length -= 2;                       // undo add()'s two registrations
  // OUTSIDE the cape hem (.196), or the cape simply eats both of them.
  armL.position.set(-.212, SHOULDER_Y - .012, 0);
  armR.position.set(.212, SHOULDER_Y - .012, 0);

  // 9 · a plain oak cane with a brass head. Not a staff — a walking stick, the
  // sort a parish official leans on while telling everyone how well things are.
  const cane = add(mergeGeos([
    { geo: new THREE.CylinderGeometry(.0135, .0115, .50, 6), m: mat(0, .25, 0) }
  ]), matOak, 'cane');
  cane.position.set(.235, 0, .055);

  // 10 · the contact disc. npcs.js's trick, at the mayor's scale: it is what
  // stops him reading as a sticker floating a centimetre above the cobbles.
  const disc = add(new THREE.CircleGeometry(.30, 14).rotateX(-Math.PI / 2), matDisc, 'disc');
  disc.position.y = .012;
  disc.renderOrder = 1;

  const DRAWS = group.children.length;      // 9

  if (scene && scene.add) scene.add(group);

  /* ── state ───────────────────────────────────────────────────── */
  let state = S_LOCKED;
  let phaseT0 = 0, phaseMs = 0;
  let nextAt = 0;                 // wall-clock stamp of the next address
  let lastNow = 0;
  let sawBelow = false;           // …an honest frame with the total under the bar
  let saidText = '', bubbled = false, bubbleAt = 0;
  const fromP = { x: 0, z: 0 }, toP = { x: 0, z: 0 }, at = { x: 0, y: 0, z: 0 };
  let yaw = 0, wantYaw = 0, groundY = 0, lastTurn = 0;

  /* ── ctx cache, refreshed once per update ── */
  let camX = 0, camZ = 62, camY = 40, townName = '', nightNow = 0, paceNow = 1, poseK = 1;
  let bearing = hash1(seed + 4409) * Math.PI * 2;      // where his residence sits

  const _v = new THREE.Vector3();
  const INFO = { name: '', title: TITLE, ceremony: false, x: 0, y: 0, z: 0 };
  const SPEECH = { x: 0, y: 0, z: 0, name: '', text: '', ready: false };

  const clock = () => lastNow || (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ═══ slots ═════════════════════════════════════════════════════ */
  function slotVal(k) {
    const f = facts;
    switch (k) {
      case 'town': return townName || 'the town';
      case 'mayor': return name;
      case 'b': return f ? f.buildings : 0;
      case 'villagers': return f ? f.villagers : 0;
      case 'tok': return (f && f.tokStr) || '';
      case 'best': return (f && f.bestStr) || '';
      case 'landmark': return (f && f.landmark) || '';
      case 'grandest': return (f && f.grandest) || '';
      case 'tierName': return (f && f.tierName) || '';
      case 'spell': return f ? f.spell : 0;
      case 'days': return f ? f.days : 0;
      case 'milestones': return f ? f.milestones : 0;
      case 'breaks': return f ? f.breaks : 0;
      default: return '';
    }
  }
  /** A line is unusable when any slot it NEEDS would print nothing worth saying.
   *  Two extra guards, because grammar is part of truth: "1 days running" and
   *  "2 towns before this one" are both lines the town would never say. */
  function unusable(c, i) {
    const s = c.slots[i];
    for (let j = 0; j < s.length; j++) {
      const k = s[j];
      if (!NEEDS[k]) continue;
      const v = slotVal(k);
      if (v === '' || v === 0 || v === '0') return true;
      if ((k === 'spell' || k === 'days' || k === 'milestones' || k === 'breaks' ||
        k === 'b' || k === 'villagers') && v < 2) return true;
    }
    return false;
  }

  /* ── anti-repeat: a shuffled cursor per pool plus a short global ring ── */
  const cursors = Object.create(null);
  const RING_N = 9;
  const ring = new Array(RING_N).fill('');
  let ringI = 0;
  const seen = key => ring.indexOf(key) >= 0;
  const remember = key => { ring[ringI] = key; ringI = (ringI + 1) % RING_N; };

  function pickLine(cat) {
    const c = CORPUS[cat];
    if (!c || !c.n) return '';
    let s = cursors[cat];
    if (!s || s.order.length !== c.n) {
      s = cursors[cat] = { order: new Int32Array(c.n), i: c.n };
      for (let i = 0; i < c.n; i++) s.order[i] = i;
    }
    let fallback = -1;
    for (let t = 0; t < c.n; t++) {
      if (s.i >= c.n) {
        for (let i = c.n - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1)), tmp = s.order[i];
          s.order[i] = s.order[j]; s.order[j] = tmp;
        }
        s.i = 0;
      }
      const idx = s.order[s.i++];
      if (unusable(c, idx)) continue;
      if (fallback < 0) fallback = idx;
      if (!seen(cat + idx)) { fallback = idx; break; }
    }
    if (fallback < 0) return '';
    remember(cat + fallback);
    SLOT_RE.lastIndex = 0;
    return c.text[fallback].replace(SLOT_RE, (_, k) => String(slotVal(k)));
  }

  /* ── which pool. Probabilities first (the state of the town gets to speak),
        then an evenly-mixed bag of whatever is actually true. ── */
  const bagCat = new Array(14), bagW = new Float32Array(14);
  function composeLine() {
    const f = facts;
    let r = rnd(), p = 0, cat = '';
    if (nightNow > .55) { p += .34; if (r < p) cat = 'NIGHT'; }
    if (!cat && paceNow < .6) { p += .34; if (r < p) cat = 'QUIET'; }
    else if (!cat && paceNow > 1.45) { p += .26; if (r < p) cat = 'BOOM'; }
    if (cat) { const t = pickLine(cat); if (t) return t; }

    let n = 0;
    const addCat = (c, w) => { bagCat[n] = c; bagW[n] = w; n++; };
    addCat('CIVIC', 9);
    addCat('QUIET', 6);                       // always in the mix; never a rebuke
    if (f && f.villagers >= 2) addCat('PEOPLE', 13);
    if (f && f.buildings >= 2) addCat('BUILD', 9);
    if (f && f.tokStr) addCat('TOTAL', 6);
    if (f && f.bestStr) addCat('RECORD', 5);
    if (f && f.landmark) addCat('LANDMARK', 5);
    if (f && f.grandest) addCat('GRANDEST', 4);
    if (f && f.tierName) addCat('TIER', 3);
    if (f && f.spell >= 3) addCat('SPELL', 4);
    if (f && f.days >= 2) addCat('ARCHIVE', 4);
    if (f && f.milestones >= 2) addCat('MILES', 3);

    let tot = 0;
    for (let i = 0; i < n; i++) tot += bagW[i];
    r = rnd() * tot;
    for (let i = 0; i < n; i++) {
      r -= bagW[i];
      if (r <= 0) { const t = pickLine(bagCat[i]); if (t) return t; break; }
    }
    return pickLine('CIVIC') || pickLine('QUIET') || '';
  }

  /* ═══ places ════════════════════════════════════════════════════ */
  const centre = () => {
    const c = coinPos && coinPos();
    return c && typeof c.x === 'number' ? c : null;
  };
  const cx = () => { const c = centre(); return c ? c.x : 0; };
  const cz = () => { const c = centre(); return c ? c.z : 0; };

  /** Where he stands to speak: just off the fountain's kerb, on the camera's
   *  side, swung 0.55 rad round from it. The Crier takes the plaza RIM on the
   *  camera's exact bearing (npcs.js's crierSpot), so the two can never end up
   *  in the same square metre — different radius AND different bearing. */
  function markSpot(out) {
    const ox = cx(), oz = cz();
    const R = Math.max(fountainR() + 1.7, 5.6);
    let dx = camX - ox, dz = camZ - oz;
    const L = Math.hypot(dx, dz) || 1;
    const a = Math.atan2(dx / L, dz / L) + .55;
    out.x = ox + Math.sin(a) * R;
    out.z = oz + Math.cos(a) * R;
    return out;
  }
  /** His residence. PASS `homePos` — a real doorstep on the inner ring is worth
   *  the two lines it costs the caller, because it is what makes him a resident
   *  rather than a spawn point. Without one he lives at a fixed seeded bearing
   *  just outside the square, which is where a mayor's house would be anyway. */
  function homeSpot(out) {
    if (homeFn) {
      const h = homeFn();
      if (h && typeof h.x === 'number' && typeof h.z === 'number') { out.x = h.x; out.z = h.z; return out; }
    }
    const R = Math.max(plazaRFn() + 5.5, 15);
    out.x = cx() + Math.sin(bearing) * R;
    out.z = cz() + Math.cos(bearing) * R;
    return out;
  }
  /** Where he walks in from on the day he takes office: the FAR rim of the
   *  square, directly opposite the camera, so the inaugural walk crosses the
   *  whole plaza toward the viewer. Deliberately not the edge of town — the
   *  plaza is the one large piece of open ground he can cross without walking
   *  through somebody's kitchen, and this module has no street graph. */
  function arrivalSpot(out) {
    const R = Math.max(plazaRFn() - 1.0, fountainR() + 3.2);
    let dx = camX - cx(), dz = camZ - cz();
    const L = Math.hypot(dx, dz) || 1;
    out.x = cx() - dx / L * R;
    out.z = cz() - dz / L * R;
    return out;
  }

  /* ═══ the routine ═══════════════════════════════════════════════ */
  function enter(next, span, now) { state = next; phaseT0 = now; phaseMs = span; }

  /** Begin an address. Returns false when he is already out. */
  function beginAddress(now, text, cer) {
    if (state !== S_HOME && state !== S_LOCKED) return false;
    const t = (typeof text === 'string' && text.trim()) || composeLine();
    if (!t) { nextAt = now + 20000; return false; }   // nothing true to say: try later
    saidText = t; bubbled = false; bubbleAt = 0;
    if (cer) { arrivalSpot(fromP); enter(S_ARRIVE, ARRIVE_MS, now); }
    else { homeSpot(fromP); enter(S_WALK, WALK_MS, now); }
    markSpot(toP);
    at.x = fromP.x; at.z = fromP.z;
    yaw = wantYaw = faceOf(toP.x - fromP.x, toP.z - fromP.z);
    if (onAddress) {
      fillInfo(cer);
      try { onAddress(t, INFO); } catch (e) { /* a listener must never stall the town */ }
    }
    return true;
  }

  function fillInfo(cer) {
    INFO.name = name; INFO.title = TITLE; INFO.ceremony = !!cer;
    INFO.x = at.x; INFO.y = groundY; INFO.z = at.z;
    return INFO;
  }

  /** The wall-clock arbiter. Runs BEFORE the pose, so the frame it decides on is
   *  already drawn correctly — a 1 fps capture never shows a stale phase. */
  function stepRoutine(now) {
    const e = now - phaseT0;
    switch (state) {
      case S_LOCKED:
        return;
      case S_HOME:
        if (nextAt && now >= nextAt) beginAddress(now, '', false);
        return;
      case S_WALK:
      case S_ARRIVE:
        if (e >= phaseMs) {
          at.x = toP.x; at.z = toP.z;
          enter(S_MARK, MARK_WAIT_MS, now);
        }
        return;
      case S_MARK: {
        // He waits for the Crier rather than shouting over him — but only for so
        // long, because a deadline is the only thing a headless run can rely on.
        let busy = false;
        try { busy = !!crierBusy(); } catch (err) { busy = false; }
        if (!busy || e >= phaseMs) enter(S_SPEAK, SPEAK_MS, now);
        return;
      }
      case S_SPEAK:
        if (e >= phaseMs) enter(S_LINGER, LINGER_MS, now);
        return;
      case S_LINGER:
        if (e >= phaseMs) { homeSpot(toP); fromP.x = at.x; fromP.z = at.z; enter(S_BACK, BACK_MS, now); }
        return;
      case S_BACK:
        if (e >= phaseMs) {
          at.x = toP.x; at.z = toP.z;
          state = S_HOME; phaseT0 = now; phaseMs = 0;
          saidText = ''; bubbled = false;
          nextAt = now + periodMs;
        }
        return;
    }
  }

  /* ═══ the pose ══════════════════════════════════════════════════
     Everything positional is derived from the phase stamp; only the sway, the
     arm swing and the cane are periodic in `now`. There is no integrated state
     anywhere in here, which is the whole reason a 1 fps shot is truthful. */
  function pose(now) {
    const out = state !== S_LOCKED && state !== S_HOME;
    group.visible = out;
    if (!out) return;

    const e = now - phaseT0;
    let walking = false, fade = 1;
    if (state === S_WALK || state === S_ARRIVE || state === S_BACK) {
      const k = easeInOut(clamp(e / Math.max(1, phaseMs), 0, 1));
      at.x = fromP.x + (toP.x - fromP.x) * k;
      at.z = fromP.z + (toP.z - fromP.z) * k;
      walking = k < .999;
      if (walking) wantYaw = faceOf(toP.x - fromP.x, toP.z - fromP.z);
      // npcs.js's pop-in curve, on the wall clock: he steps out of a doorway
      // over 420 ms and back into one the same way, instead of appearing.
      fade = state === S_BACK ? clamp((phaseMs - e) / 420, 0, 1) : clamp(e / 420, 0, 1);
    }
    if (!walking) wantYaw = faceOf(camX - at.x, camZ - at.z);   // he addresses the camera
    // Yaw is smoothed on the WALL CLOCK, not on dt: at 1 fps the exponential
    // collapses to "already facing", which is exactly what a shot should show.
    yaw = state === S_HOME ? wantYaw : yaw + wrapPi(wantYaw - yaw) * clamp((now - lastTurn) / 260, 0, 1);
    lastTurn = now;

    groundY = 0;
    try { groundY = heightAt(at.x, at.z) || 0; } catch (err) { groundY = 0; }

    const s = SCALE * poseK * (.55 + .45 * fade);
    // The gait: a slow deliberate roll, not a villager's waddle. He does not
    // hurry, because he is the mayor.
    const t = now / 1000;
    const bob = walking ? Math.abs(Math.sin(t * 2.5)) * .022 : Math.sin(t * .7) * .006;
    const roll = walking ? Math.sin(t * 2.5) * .045 : Math.sin(t * .55) * .012;

    group.position.set(at.x, groundY + bob * s, at.z);
    group.rotation.set(0, yaw, roll);
    group.scale.setScalar(s);

    if (state === S_SPEAK || state === S_MARK) {
      // ONE arm raised and swung wide — the universal shape of a person
      // addressing a square, and big enough to read at 60 units. The other
      // rests on the cane.
      const st = (now - phaseT0) / 1000;
      armL.rotation.set(-2.30 + Math.sin(st * 1.9) * .22, 0, -.78);
      armR.rotation.set(-.34 + Math.sin(st * 1.3) * .05, 0, .26);
      cane.rotation.set(0, 0, .04);
    } else if (walking) {
      armL.rotation.set(Math.sin(t * 2.5) * .34, 0, -.22);
      armR.rotation.set(-Math.sin(t * 2.5) * .20 - .18, 0, .18);
      cane.rotation.set(Math.sin(t * 2.5) * .16, 0, .05);
    } else {
      armL.rotation.set(-.16 + Math.sin(t * .8) * .05, 0, -.24);
      armR.rotation.set(-.26, 0, .20);
      cane.rotation.set(0, 0, .04);
    }
    // The disc stays flat on the ground whatever the body is doing. It is a
    // circle, so only the roll has to be undone; the yaw is invisible on it.
    disc.rotation.set(0, 0, -roll);
    disc.position.set(0, .012 - bob, 0);
  }

  /* ═══ the bubble ════════════════════════════════════════════════
     Offered once per address and retried on a wall-clock cadence while it is
     being refused — he can be behind the fountain, off screen, or the pool can
     be full. news.js gives a 'crier' bubble VIP treatment (it takes a slot
     rather than losing the moment), which is exactly the weight a mayoral
     address should carry, and is why the Crier is waited out first. */
  function offerSpeech(now) {
    if (state !== S_SPEAK || bubbled || !saidText || !sayFn) return;
    if (bubbleAt && now - bubbleAt < RETRY_MS) return;
    bubbleAt = now;
    const y = groundY + HAT_TOP * SCALE * poseK + .20;
    let ok = false;
    try {
      ok = !!sayFn(_v.set(at.x, y, at.z), bubbleKind, {
        text: saidText, who: 'Mayor ' + name, ttl: BUB_MS
      });
    } catch (e) { ok = false; }
    if (ok) bubbled = true;
  }

  /* ═══ the unlock ════════════════════════════════════════════════ */
  function takeOffice(now, cer) {
    if (state !== S_LOCKED) return false;
    if (cer) {
      if (onUnlock) { fillInfo(true); try { onUnlock(INFO); } catch (e) { } }
      state = S_HOME; phaseT0 = now; phaseMs = 0;
      nextAt = 0;
      // …and he walks in from the edge of town to say his first words.
      beginAddress(now, pickLine('INAUGURAL'), true);
    } else {
      // He was already in office when this window opened. No fanfare for a
      // range switch; he simply lives here, and his first address comes at the
      // ordinary cadence, soon enough that a short capture still catches him.
      homeSpot(at);
      state = S_HOME; phaseT0 = now; phaseMs = 0;
      nextAt = now + FIRST_MS;
    }
    return true;
  }

  function checkUnlock(now, ctx) {
    if (state !== S_LOCKED) return;
    const tok = ctx && typeof ctx.totalTok === 'number' ? ctx.totalTok : 0;
    const tier = facts && typeof facts.tier === 'number' ? facts.tier : -1;
    const settled = !ctx || (ctx.intro === undefined || ctx.intro >= 1);
    const cascading = !!(facts && facts.cascading);
    if (!settled || cascading) return;                 // the founding owns the frame
    const met = tok >= unlockTok || tier >= unlockTier;
    if (!met) { sawBelow = true; return; }
    // CEREMONY IS EARNED BY BEING WATCHED. He only walks in from the edge of
    // town when the threshold was crossed while somebody was looking; a window
    // that opens on a town which already passed it just has a mayor in it.
    takeOffice(now, sawBelow);
  }

  /* ═══ update ════════════════════════════════════════════════════ */
  /**
   * @param {number} dt   seconds — deliberately unread; see the header
   * @param {number} now  performance.now()
   * @param {Object} ctx  the per-frame town context
   */
  function update(dt, now, ctx) {
    if (disposed) return;
    lastNow = now = (typeof now === 'number' && now > 0) ? now
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (ctx) {
      const cam = ctx.camera;
      if (cam && cam.position) { camX = cam.position.x; camY = cam.position.y; camZ = cam.position.z; }
      if (typeof ctx.townName === 'string' && ctx.townName) townName = ctx.townName;
      if (typeof ctx.night === 'number') nightNow = clamp(ctx.night, 0, 1);
      if (typeof ctx.paceRatio === 'number' && ctx.paceRatio > 0) paceNow = ctx.paceRatio;
      // A new epoch is a new town and a new mayor. Re-minting off ctx means the
      // caller never has to remember to hand the seed to reset().
      const ps = (ctx.planSeed >>> 0) || 0;
      if (ps && ps !== seed) {
        seed = ps; name = mayorNameFor(seed); rnd = stream(seed ^ 0x51ed270b);
        bearing = hash1(seed + 4409) * Math.PI * 2;
        for (const k in cursors) delete cursors[k];
      }
    }
    // The same distance term npcs.js applies, so he never shrinks out of
    // proportion with the crowd he is talking to as the camera pulls out.
    const camD = Math.hypot(camX, camY, camZ);
    poseK = 1 + .5 * clamp((camD - 80) / 170, 0, 1);

    checkUnlock(now, ctx);
    stepRoutine(now);
    pose(now);
    offerSpeech(now);
  }

  /* ═══ epoch reset ═══════════════════════════════════════════════ */
  function reset() {
    state = S_LOCKED;
    phaseT0 = phaseMs = 0;
    nextAt = 0; lastTurn = 0;
    sawBelow = false;
    saidText = ''; bubbled = false; bubbleAt = 0;
    at.x = at.z = 0; at.y = 0; groundY = 0; yaw = wantYaw = 0;
    ring.fill(''); ringI = 0;
    for (const k in cursors) delete cursors[k];
    group.visible = false;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    group.visible = false;
    if (group.parent) group.parent.remove(group);
    group.clear();
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    geos.length = 0; mats.length = 0;
  }

  return {
    group,
    get unlocked() { return state !== S_LOCKED; },
    get present() { return state !== S_LOCKED && state !== S_HOME; },
    get speaking() { return state === S_SPEAK; },
    get name() { return name; },
    get title() { return TITLE; },
    get state() { return state; },
    /** Draw calls he is costing this frame — 9 while out, 0 while home. */
    get draws() { return group.visible ? DRAWS : 0; },
    /**
     * Put him in office now. Idempotent; false if he already is.
     * @param {{ceremony?:boolean}} [opts] ceremony:true walks him in from the
     *        edge of town for an inaugural address. Defaults to true.
     */
    unlock(opts) { return takeOffice(clock(), !opts || opts.ceremony !== false); },
    /**
     * Send him out now. `text` overrides the corpus (the caller may want to
     * announce something specific); otherwise he picks his own line.
     * @returns {boolean} false when he is already out or has nothing true to say
     */
    address(text) { return beginAddress(clock(), text || '', false); },
    /**
     * The bubble tether, for a caller that would rather relay the remark itself
     * than hand over a `say`. `y` is the top of his hat. Shared scratch — read
     * it, do not keep it.
     */
    speech() {
      if (state !== S_SPEAK || !saidText) return null;
      SPEECH.x = at.x; SPEECH.z = at.z;
      SPEECH.y = groundY + HAT_TOP * SCALE * poseK + .20;
      SPEECH.name = name; SPEECH.text = saidText; SPEECH.ready = true;
      return SPEECH;
    },
    update, reset, dispose
  };
}
