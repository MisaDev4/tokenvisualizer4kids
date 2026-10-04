# Token Town v4 — **LIFESIM**: the villagers become people

> Area doc. Companion to `REDESIGN-V3.md`; every rule in V3 §0 (ownership), §0.2 (module
> rules), §11.1 (no `Math.random()` outside particles/gait), §13 (invariants) still binds.
> Nothing here adds an npm dep, a file under `town/`, or a light.

---

## 0. The problem, stated honestly

Today a villager is an **actor**: a pose, a colour triple, a state string and a leg queue.
It has no memory, no identity and no stake. `goHome()` picks a *random* building. The
Crier's `{name}` slot draws from a hard-coded list of 24 people who do not exist and are
never seen. The result is a crowd, and a crowd is scenery.

There is a second, harder problem, visible in `base-day.png`: at 454 buildings the camera
sits ~300 units out and a villager is **3–4 px tall**. Any lifesim whose payoff is only
visible at 20 units is a lifesim the user will never see. So v4 routes the payoff through
the three channels that are legible at any camera distance:

| channel | legible at | who owns it |
|---|---|---|
| the Crier's ticker line | always (12.5 px type) | `news.js` |
| speech bubbles | always (11.5 px DOM, pooled) | `news.js` |
| the hover card | when the user leans in | `town.js` |

…and the 3D layer (homes, routines, children, dogs, the crier walking to the plaza) exists
to make those three channels **true**. The joke only lands because Bram really is standing
outside the bakery.

**The one-sentence goal:** the Crier says *"Bram Cachewright has opened a second bakery and
Ivy Pell is not speaking to him,"* and the user can find Bram, hover him, and read
*"Baker at the Bakery on Coin Row · lives at the Cottage on Mill End."*

---

## 1. The data model

### 1.1 Person vs. Actor — the central split

The population **fluctuates** (dusk cuts it 55 %, `despawn()` swap-removes, an epoch resets
everything). Identity must not. So:

* **`Person`** — a persistent record in a per-epoch roster. Owns identity, wardrobe, home,
  job, relationships, mood. Lives for the whole epoch. Roster size `ROSTER_CAP = 220`.
* **`Actor`** — the existing `npcs[]` entry: position, legs, state, pose. Transient.
  Gains exactly one new field: `n.p` — a direct reference to its `Person`.

Wardrobe **moves off the actor onto the person**. That is the cheapest possible identity
win: the same villager who walked past at 09:00 is recognisably the same one at 21:00,
because a Person is minted once and an Actor borrows its colours.

```js
/**
 * A townsperson. Minted once per epoch, never mutated except by the life tick.
 * Field order is grouped so V8 keeps one hidden class for the whole roster.
 * @typedef {Object} Person
 * ── identity ───────────────────────────────────────────────────────────────
 * @property {number} id            index into `folk`; stable for the epoch
 * @property {number} seed          id*7919 + planSeed — every seeded draw uses it
 * @property {string} given         'Bram'
 * @property {string} sur           'Cachewright'
 * @property {string} name          'Bram Cachewright' (pre-joined; never rebuilt)
 * @property {string} epithet       '' | 'the Younger' | 'Two-Loaves' | 'the Devout'
 * @property {number} age           0 child · 1 adult · 2 elder
 * @property {number} trait         index into TRAITS
 * ── wardrobe (was on the actor) ────────────────────────────────────────────
 * @property {number} robe @property {number} skin @property {number} hatc
 * @property {?number[]} hat        HATS entry @property {number} rite  0..2
 * @property {number} scale @property {number} speed @property {number} lat
 * ── place in the world ─────────────────────────────────────────────────────
 * @property {number} homeIdx       plot index of the house they live in; -1 = homeless
 * @property {number} homeSeq       buildingsCache epoch that homeIdx was resolved against
 * @property {string} homeLabel     'Cottage' — cached at assignment
 * @property {string} quarter       'Coin Row' — quarterOf(home), cached
 * @property {number} jobId         index into JOBS/TRADES, or -1
 * @property {number} jobIdx        plot index of the workplace; -1 for a landless trade
 * @property {number} jobX @property {number} jobZ   resolved work point (doorstep)
 * ── the social graph (static; zero maintenance) ────────────────────────────
 * @property {number} friend        person id, or -1
 * @property {number} rival         person id, or -1
 * @property {number} kin           spouse/parent id, or -1  (mutual)
 * ── the only dynamic state ─────────────────────────────────────────────────
 * @property {number} mood          0..1, drifts with paceRatio; cosmetic only
 * @property {number} fortune       -1..1, the protagonist's only; 0 for everyone else
 * @property {number} band          fortune band 0..4, debounced
 * @property {number} spokeAt       last bubble, ms (moved off the actor)
 * @property {number} storyAt       last time the Crier told a story about them, ms
 * @property {number} actor         index into npcs[] while embodied, else -1
 */
```

**Memory.** 220 persons × ~30 slots ≈ 55 KB. One allocation burst per epoch, in
`mintRoster()`, never per frame.

### 1.2 Ownership and where each piece lives

| piece | file | why |
|---|---|---|
| roster, names, homes, jobs, routine, crier, dogs | `npcs.js` | it is the villagers' module |
| all copy, all slots, bubbles, nameplates | `news.js` | copy has exactly one owner |
| enriched `getBuildings()`, wiring, hover card | `town.js` | sole mediator (V3 §0.2) |

`npcs.js` never imports `news.js` and never will. `town.js` relays, exactly as it already
does for `pickSpeaker → say`.

---

## 2. `npcs.js` — new module-level constants and exports

```js
/* ═══ v4 lifesim constants ══════════════════════════════════════ */
export const ROSTER_CAP = 220;          // > NPC_CAP so a dusk shrink returns the SAME people
const CHILD_SHARE   = .16;              // of the roster, once buildings > 40
const ELDER_SHARE   = .12;
const DOG_MAX       = 20;               // one instanced mesh, one draw call
const HOME_CAP      = 3;                // residents per house before a house is "full"
const THINK_MS      = 6;                // wall-clock ms of elapsed time that buys 1 route plan
const LIFE_MS       = 8;                // …that buys 1 life tick
const ROUTE_MIN = 2, ROUTE_MAX = 120;
const LIFE_MIN  = 1, LIFE_MAX  = 64;
const CRIER_EVERY   = 45000;            // ± 10 s, seeded
const CRIER_CRY_MS  = 6200;
const CRIER_WALK_DEADLINE = 6000;       // arrive-or-shout-anyway; the wall-clock guarantee
```

### 2.1 Public surface — **purely additive**. No existing signature changes.

```js
/**
 * A read-only projection of a Person, handed to town.js. The SAME object is reused
 * for every call (it is scratch) — read the fields out, never retain it.
 * @typedef {Object} VillagerView
 * @property {number} id @property {string} name @property {string} epithet
 * @property {string} job        'Baker' | 'Carter' | 'Town Crier' | ''
 * @property {string} jobPlace   'the Bakery' | 'the Market Hall' | ''
 * @property {string} home       'Cottage' | ''
 * @property {string} quarter    'Coin Row'
 * @property {string} trait      'thrifty'
 * @property {string} portrait   'brick-red robe, wide flat cap · walks unhurried'
 * @property {string} state      the actor's state, or 'indoors' when not embodied
 * @property {number} x @property {number} z   world position (0,0 when indoors)
 * @property {boolean} hero      is the epoch's protagonist
 * @property {number} band       fortune band 0..4 (hero only; 2 otherwise)
 */

/* — identity ————————————————————————————————————————————————— */
/** @returns {number} live roster size (0 before the first mint) */
rosterSize()
/** @param {number} id @returns {?VillagerView} scratch view, or null */
personAt(id)
/** One seeded name, preferring an EMBODIED adult (so the Crier names someone visible).
 *  Never returns the same name twice inside 1200 ms — news' `{name}` calls this per slot.
 *  @returns {string} '' when the roster is empty (callers fall back to their own list) */
randomName()
/** @returns {?VillagerView} the epoch's protagonist, or null */
protagonist()

/* — the story cast ————————————————————————————————————————— */
/**
 * Fill a gossip cast IN PLACE. Allocation-free; all fields are strings, always set
 * (empty when unavailable). Picks a fresh `who` (storyAt older than 90 s) and pairs
 * them with their own friend/rival, so the relationship in the line is REAL.
 * @param {'gossip'|'feud'|'romance'|'work'|'move'|'fortune'} kind
 * @param {{who:string,who2:string,job:string,place:string,home:string,quarter:string,
 *          rel:string,fortune:string}} out  mutated in place
 * @returns {boolean} false when the roster cannot supply this kind of story
 */
cast(kind, out)

/* — the crier ——————————————————————————————————————————————— */
/** @returns {?{x:number,z:number,y:number,name:string,ready:boolean}} scratch, or null */
crier()
/**
 * Send the crier to the plaza to shout something. Idempotent while an announcement is
 * running (a second call inside CRIER_CRY_MS is dropped and returns false).
 * @param {string} text plain text, already truncated by the caller
 * @returns {boolean} accepted
 */
announce(text)
/** True on the ONE frame the crier starts shouting; town.js relays the bubble then. */
crierSpeaking()

/* — hover ——————————————————————————————————————————————————— */
/** Meshes to add to town.js's raycast list. Stable identity; call once. */
hitMeshes()          // → [IM.body, IM.disc]
/** @param {THREE.Object3D} obj @param {number} instanceId @returns {?VillagerView} */
villagerAt(obj, instanceId)

/* — extended, backward-compatible ——————————————————————————— */
/**
 * @param {?string} want   …unchanged…
 * @param {THREE.Vector3} out
 * @param {?VillagerView} [outMeta]  when passed, receives the speaker's identity
 * @returns {?string} the villager's state
 */
pickSpeaker(want, out, outMeta)
```

Every one of these is **null-safe before the roster exists** and before `getBuildings()`
returns anything. That is what lets `news.js` and `town.js` be written against the contract
*in parallel with* the roster implementation: the ticker degrades to exactly today's
behaviour (see §4.4).

---

## 3. The lifesim, mechanism by mechanism

### 3.1 Names — `mintRoster(seed)`

Two corpora, module-private, in `npcs.js`:

```js
const GIVEN = ['Bram','Mabel','Otto','Ness','Sil','Perpetua','Fen','Wren','Tam','Ivy','Peg',
  'Nib','Grum','Harriet','Barnaby','Bill','Cass','Doll','Ebb','Fitch','Gil','Hesper','Ilsa',
  'Jory','Kit','Lark','Merrit','Nan','Orrin','Pell','Quill','Rue','Sedge','Thess','Ulla',
  'Verity','Wick','Yarrow','Zeb','Ambrose','Bess','Corin','Dove','Elgar','Flor','Gudrun',
  'Hob','Inge','Tibb'];                                                              // 49
const SUR = ['Quire','Cachewright','Tallis','Marrow','Cottrell','Snub','Pell','Ashwood',
  'Vellum','Rooksbury','Hask','Dunnage','Trundle','Flit','Mott','Ossick','Pemb','Bynn',
  'Coffer','Grist','Wickham','Chitwood','Ledgerly','Sumner','Draypool','Mintlaw','Scrivener',
  'Burrow','Thrift','Oddfellow','Penny','Hoard','Bale','Furlong','Gale','Harrow','Ives',
  'Jessop','Keld','Lunt','Marsh','Nettle','Ord','Pike','Rill','Stub','Threlfall',
  'Undercroft','Verger','Cobb'];                                                     // 50
const EPITHET = ['the Younger','the Elder','of the Mill','Two-Loaves','Ninepence',
  'the Devout','the Doubter','the Quick','No-Cart','the Third'];
const TRAITS = ['devout','sceptical','gossipy','shy','loud','sentimental','thrifty',
  'extravagant','superstitious','practical','lovelorn','argumentative','cheerful','doleful',
  'curious','unbothered'];
```

2 450 full names for a 220-person roster ⇒ ~99.99 % chance of at least one collision, so
mint with a `Set`: on a duplicate `given|sur`, step `sur` forward until free. Minting is
**once per epoch**, never per frame, so the Set is free.

```js
/**
 * Build the whole roster for an epoch. Called from adoptPlan() when ctx.planSeed changes,
 * and lazily on the first update() if no roster exists. Deterministic in `seed`.
 * @param {number} seed ctx.planSeed
 */
function mintRoster(seed) { /* … */ }
```

Rules inside the mint:
* `folk[0]` is **always the Town Crier**: `job = 'Town Crier'`, `epithet = 'the Crier'`,
  `hat = HATS[3]` (the very tall one), `pinned = true`.
* 8 % of adults get an epithet (`srand(p.seed*3.3) < .08`).
* `age`: `id % 7 === 3 && buildings > 40 → child`; then `srand(seed*5.1) < ELDER_SHARE → elder`.
  Children get `scale ×= .66`, `speed ×= 1.22`, 70 % bareheaded.
* Social graph: `friend = (id + 1 + floor(srand*17)) % n`, `rival = (id + 7 + floor(srand*23)) % n`,
  never self, never equal. `kin` for ~35 % of adults, **made mutual in a second pass** and
  co-housed (§3.3).
* Protagonist: `heroId = 1 + (hash(seed ^ 0x5EED) % (n - 1))` — never the crier.

### 3.2 Quarters — street names for free (no `layout.js` change)

`layout.js` has no street names and is another owner's file, so v4 derives a **quarter** from
position alone:

```js
const Q_HEAD = ['Coin','Mill','Tally','Ledger','Ash','Cinder','Reed','Salt','Bell','Hollow',
  'Chandler','Quill'];
const Q_TAIL = ['Row','Quarter','End','Gate','Lane','Side','Yard','Green'];
/**
 * A stable, seeded neighbourhood name for a point. Pure; ~40 ns; cached on the Person.
 * 8 angular sectors × 3 radial rings = 24 quarters, which is more than any real town
 * ever shows at once.
 * @param {number} x @param {number} z @returns {string}
 */
function quarterOf(x, z) {
  const r = Math.hypot(x, z);
  if (r < plazaR() + 6) return 'the Plaza';
  if (plan && plan.isWet && (plan.isWet(x + 5, z) || plan.isWet(x - 5, z))) return 'the Wet Side';
  const sec = ((Math.atan2(z, x) / TAU * 8 + 8) | 0) % 8;
  const ring = Math.min(2, (r / 34) | 0);
  const k = sec * 3 + ring;
  return Q_HEAD[Math.floor(srand(qSeed + k * 1.7) * Q_HEAD.length) % Q_HEAD.length] + ' ' +
         Q_TAIL[Math.floor(srand(qSeed + k * 9.3) * Q_TAIL.length) % Q_TAIL.length];
}
```

### 3.3 Homes — a villager belongs to a house

**Prerequisite (§5.1): `cfg.getBuildings()` must carry `idx`, `kind`, `label`, `flavor`.**

```js
/** @typedef {Object} BuildingRef
 *  @property {THREE.Vector3} pos @property {number} yaw
 *  @property {number} idx      plot index — the ONLY stable handle across a remount
 *  @property {string} kind     'house' | 'landmark' | 'bridge'
 *  @property {string} label    'Cottage' | 'Market Hall'
 *  @property {string} flavor   '' | 'bakery' | 'tavern' | …
 *  @property {number} tier     0..7 for houses, -1 otherwise
 */
```

npcs keeps a lazily-rebuilt index:

```js
let bIndex = null, bSeq = 0;          // Map<idx, BuildingRef>, and a monotone rebuild count
function buildingIndex() {
  const bs = cfg.getBuildings();
  if (bs !== bCacheRef) {             // town.js hands back a NEW array only when dirty
    bCacheRef = bs; bSeq++;
    bIndex = new Map();
    homesFree.length = 0; worksFree.length = 0;
    for (const b of bs) {
      bIndex.set(b.idx, b);
      if (b.kind === 'house' && !b.flavor) homesFree.push(b.idx);
      else if (JOBS[b.flavor] || JOBS[b.lm]) worksFree.push(b.idx);
    }
  }
  return bIndex;
}
```

`town.js`'s `buildingsForNPCs()` already returns the *same array object* until
`buildingsDirty` flips, so identity comparison is the whole invalidation protocol. **Cost:
O(B) once per building change, not per frame.**

Assignment (inside the life tick, ≤ LIFE_N persons/frame):

```
if (p.homeIdx < 0 || !bIndex.has(p.homeIdx)) {
  // prefer a house near where they already are, with room, and near their kin
  anchor = p.kin >= 0 && folk[p.kin].homeIdx >= 0 ? folk[p.kin].home : actor position or plaza
  scan 24 candidates drawn from homesFree via the seeded stream,
    score = -dist(anchor) - 40 * (residents[idx] >= HOME_CAP)
  pick the best; residents[idx]++; p.homeIdx = idx;
  p.homeLabel = ref.label; p.quarter = quarterOf(ref.pos.x, ref.pos.z);
}
```

24 candidates × cheap arithmetic ≈ 1 µs. A full roster homes itself in ≈ 220/LIFE_N frames
(≈ 1.2 s at 60 fps; **one frame** at 1 fps, because LIFE_N scales with elapsed wall clock).

`kin` pairs share a home: the second of the pair copies the first's `homeIdx` and does not
consume a slot beyond `HOME_CAP + 1`.

**`goHome()` becomes:**

```js
function goHome(n, now) {
  freeSlot(n); n.state = 'home'; n.legs.length = 0; n.leg = null;
  const b = n.p && n.p.homeIdx >= 0 ? bIndex.get(n.p.homeIdx) : null;
  if (!b) { const r = randomBuilding(n.seed + now); if (!r) { n.dying = .01; return; } return routeTo(n, doorstep(r)); }
  const d = 2.4;
  routeTo(n, b.pos.x + Math.sin(b.yaw) * d, b.pos.z + Math.cos(b.yaw) * d);
}
```

That is a **six-line diff** and it is the single change that makes dusk read as a town going
to bed rather than a crowd dispersing.

### 3.4 Jobs

```js
/** kind (flavor or landmark) → trade. `shift` is [startHour, endHour), wrapping. */
const JOBS = {
  bakery:       { title: 'Baker',                cap: 2, shift: [4, 13]  },
  tavern:       { title: 'Taverner',             cap: 3, shift: [11, 24] },
  market:       { title: 'Trader',               cap: 4, shift: [8, 17]  },
  windmill:     { title: 'Miller',               cap: 2, shift: [6, 18]  },
  farm:         { title: 'Farmhand',             cap: 4, shift: [5, 19]  },
  forge:        { title: 'Smith',                cap: 2, shift: [7, 18]  },
  well:         { title: 'Water-carrier',        cap: 1, shift: [6, 20]  },
  market_hall:  { title: 'Clerk of the Hall',    cap: 4, shift: [8, 17]  },
  bell_tower:   { title: 'Bell-ringer',          cap: 1, shift: [5, 21]  },
  cathedral:    { title: 'Acolyte',              cap: 4, shift: [0, 24]  },
  wizard_tower: { title: "Wizard's Apprentice",  cap: 1, shift: [20, 4]  },
  observatory:  { title: 'Star-clerk',           cap: 2, shift: [19, 5]  },
  golden_statue:{ title: 'Statue-polisher',      cap: 1, shift: [7, 16]  },
  skygate:      { title: 'Gatewarden',           cap: 2, shift: [0, 24]  }
};
/** No premises. Everyone else gets one of these; the site is a road point in their quarter. */
const TRADES = ['Carter','Hod-carrier','Scaffolder','Ledger-clerk','Thatcher','Drover',
  'Reed-cutter','Chandler','Cooper','Wheelwright','Rat-catcher','Night-watch','Goose-girl',
  'Tanner','Bell-boy'];
/** riverside + lakeside only; the site is a bridge midpoint from plan.bridges */
const WATER_TRADES = ['Ferryman','Bargeman','Eel-catcher'];
```

Assignment, in the same life tick, immediately after homing:

```
if (p.jobId < 0) {
  if (p.age === 0)  { p.job = 'child'; p.jobIdx = -1; }        // children do not work
  else scan 16 candidates from worksFree nearest p.home with staff[idx] < JOBS[kind].cap
       → title + jobIdx + doorstep point
  else                                                          // nothing free
       title = TRADES[hash(p.seed) % TRADES.length]  (or WATER_TRADES on a wet plan)
       jobIdx = -1; jobX/jobZ = a seeded road point inside their quarter
}
```

Elders: 30 % get `title = 'retired ' + trade` and are exempt from work-phase routing (they
stroll and worship instead). This is free flavour: one branch.

### 3.5 The daily routine — real clock, table-driven

`npcs.js` derives the hour itself from `ctx.simNow` (one `Date` reused, refreshed at most
once per 5 s) so **no `town.js` change is required**; if core later adds `ctx.hour`, prefer it.

```js
// phase by local hour: 0 dawn · 1 work · 2 dinner · 3 evening · 4 night · 5 tavern
const PHASE = new Uint8Array([4,4,4,4, 0,0,0, 1,1,1,1,1, 2, 1,1,1,1, 3,3, 5,5,5, 4,4]);
// destination weights per phase — work, tavern, home, market, wander (sum 100)
const DEST = [
  [55,  0,  5,  8, 32],   // 0 dawn      — the bakers and the millers are already out
  [68,  2,  2,  8, 20],   // 1 work
  [20, 26, 18, 12, 24],   // 2 dinner
  [30, 24,  8, 14, 24],   // 3 evening
  [10,  8, 46,  2, 34],   // 4 night     — most of these are already indoors anyway
  [12, 34, 20,  6, 28]    // 5 tavern
];
// multiplier on the EXISTING wantWorship share; the worship arithmetic is untouched
const WORSHIP_BIAS = [1.15, 0.85, 0.90, 1.00, 1.25, 1.10];
```

`newErrand()` gains one call:

```js
/**
 * Where is this villager going next? Returns false to fall through to today's behaviour
 * (a seeded road point), which is what happens for the homeless, the jobless and children.
 * @param {Actor} n @param {number} now @returns {boolean} routed
 */
function pickDestination(n, now) {
  const p = n.p; if (!p) return false;
  const ph = PHASE[hourNow | 0], w = DEST[ph];
  // off-shift workers never route to work, whatever the phase says
  const onShift = p.jobIdx >= 0 && inShift(JOBS[p.jobKind].shift, hourNow);
  let r = rnd() * 100, pickDest = 4;
  for (let i = 0; i < 5; i++) { r -= (i === 0 && !onShift ? 0 : w[i]); if (r <= 0) { pickDest = i; break; } }
  switch (pickDest) {
    case 0: return routeTo(n, p.jobX, p.jobZ), true;                    // work
    case 1: return routeToKind(n, 'tavern');                            // the nearest tavern
    case 2: return goHome(n, now), true;
    case 3: return routeToKind(n, marketDay ? 'market_hall' : 'market');
    default: return false;                                              // wander: today's path
  }
}
```

`routeToKind(n, kind)` scans `worksFree` for the nearest building of that kind (≤ 8
candidates, seeded) and routes to its doorstep; returns `false` if the town has none, which
falls through to a wander. **Everything about movement below this line is unchanged** — same
graph, same legs, same `advance()`. Jobs and routines are a *destination policy*, not a new
navigation system. That is the whole reason this fits the perf budget.

Loitering at a destination: on arrival in `stroll`, if the destination was `work`/`tavern`/
`market`, set `n.idleUntil = now + 8000 + srand(...) * 14000` and face the building. Villagers
therefore *stand outside their workplace* rather than orbiting it — which is what makes a
screenshot show four people outside the forge at 10:00.

### 3.6 Children and dogs

**Children (S).** `p.age === 0`. Three rules, all one-liners:
1. Never worship (skipped in the `enterWorship` recruitment scan), never work.
2. **Trail a parent.** If `p.kin >= 0` and the parent is embodied and moving, the child's
   errand copies the parent's *current* destination with a seeded 2.2-unit offset. Costs one
   pointer chase per errand.
3. Bubble kind `'child'` (§4.3), and at dusk children are the **first** batch sent home by
   the shrink pool (sort key: `age === 0 ? -1e6 : polarR`). "The children are called in first"
   is a free, legible beat at 18:00.

**Dogs (S).** One new `InstancedMesh`, one draw call:

```js
G.dog = mergeGeometries([                       // built by hand, not imported: three's
  new THREE.CapsuleGeometry(.075, .16, 2, 5).rotateZ(Math.PI/2).translate(0, .17, 0),
  new THREE.SphereGeometry(.07, 8, 6).translate(.14, .24, 0),
  new THREE.ConeGeometry(.035, .12, 5).rotateZ(-.7).translate(-.14, .24, 0)   // tail
]);                                             // …or three separate small IMs if the
                                                // BufferGeometryUtils vendor file is absent
IM.dog = mk(G.dog, M.dog, DOG_MAX);
```

A dog belongs to a household (`dogOf[homeIdx]`) and shadows whichever resident is embodied,
at `1.1 + .5*sin(now/700)` units behind, with a tail wag driven by `dt` (cosmetic) and a
position driven by the owner's position (existence, wall-clock-safe). When no resident is
out, the dog sleeps on the doorstep — which means **there is always a dog visible somewhere**,
even at 03:00, and that is worth its one draw call.

### 3.7 The Town Crier — the marquee feature

`folk[0]`. Wall-clock state machine, entirely inside `npcs.js` except for the bubble relay:

```
idle          → at `crierNextAt` (seeded 45 s ± 10 s), town.js calls announce(text)
announce()    → store text; state 'toPlaza'; crierDeadline = now + CRIER_WALK_DEADLINE
                route to the plaza rim point chosen to face the CAMERA:
                  a = atan2(cam.x, cam.z);  R = plazaR() - 1.2
                  target = (sin(a)*R, cos(a)*R)         ← he always steps into shot
'toPlaza'     → on arrival OR at crierDeadline (whichever first): state 'crying'
'crying'      → until now + CRIER_CRY_MS: face the town centre-of-mass, right arm up
                holding the bell (IM.bell, count ≤ 1), left hand cupped; a 3.1 Hz bell shake.
                crierSpeaking() returns true on the first frame of this state.
              → then newErrand(), crierNextAt = now + CRIER_EVERY ± 10 s
```

Guarantees:
* The crier is **`pinned`**: exempt from the dusk `goHome` shrink pool and re-spawned first
  when `active < live`, so he exists in every screenshot.
* The walk deadline is what makes it screenshot-safe: at 1 fps he may never "arrive", so the
  shout happens on the clock regardless and the bubble still fires.
* `announce()` returns `false` while an announcement is running — town.js must not queue.

**town.js relay (≈ 12 lines, in the same place as `pullBubble`):**

```js
let crierAt = 0;
function pullCrier(now) {
  if (now - crierAt < 12000) return;              // he cannot be told twice inside 12 s
  const c = npcs.crier(); if (!c) return;
  const h = news.headline();                      // {html, plain}
  if (!h || !h.plain) return;
  if (npcs.announce(shout(h.plain))) crierAt = now;
}
/** First sentence, ≤ 58 chars, no trailing punctuation soup. */
const shout = s => { const t = s.split(/(?<=[.!?])\s/)[0]; return t.length > 58 ? t.slice(0, 55).trimEnd() + '…' : t; };
// …and in tick(), right after pullBubble(now):
if (npcs.crierSpeaking()) {
  const c = npcs.crier();
  _bv.set(c.x, c.y, c.z);
  news.say(_bv, 'crier', { text: c.text, ttl: 6000, who: c.name });
}
```

The payoff: the ticker line the user just read is **shouted by a person standing in the
plaza with a bell.** That is the screenshot they send to someone.

### 3.8 The protagonist — "a named villager whose fortunes track the token pace"

One person per epoch. Only their `fortune` is dynamic, updated in the life tick when it is
their turn (≈ once per second):

```js
// wall-clock exponential, 45 s time constant — a genuine boom moves him in ~2 minutes
const target = clamp((paceNow - 1) * .6, -1, 1);
hero.fortune += (target - hero.fortune) * (1 - Math.exp(-(now - heroAt) / 45000));
heroAt = now;
const band = hero.fortune < -.55 ? 0 : hero.fortune < -.2 ? 1 : hero.fortune < .2 ? 2
           : hero.fortune < .55 ? 3 : 4;
if (band !== hero.band && now - heroBandAt > 90000) {        // debounce: no yo-yo headlines
  const up = band > hero.band;
  hero.band = band; heroBandAt = now;
  heroEvent = { band, up };                                   // town.js polls and posts
  repaintHero();
}
```

`FORTUNE_NAMES = ['Ruined','Struggling','Getting by','Prospering','Rich beyond sense']`.

**Three visible channels:**
1. **Wardrobe** — `repaintHero()` lerps the robe toward `0xF3D07A` by `max(0, fortune)`, gives
   a hat at band ≥ 3 if bareheaded, and `scale ×= 1 + .05 * max(0, fortune)`. One
   `setColorAt` on band change; zero per-frame cost.
2. **The Crier** — a `HERO` corpus (§4.2) fires on the band change.
3. **The hover card** — the card shows `✦ Prospering` for the hero only.

Polled by town.js in the 500 ms stats tick:

```js
const hv = npcs.heroEvent();                       // consumes; returns null when nothing
if (hv) news.post('fortune', { who: hv.name, job: hv.job, quarter: hv.quarter,
                               fortune: FORTUNE_NAMES[hv.band], up: hv.up });
```

### 3.9 Market day

`marketDay = ((daySeed >>> 3) % 7) < 2 && hourNow >= 9 && hourNow < 15`. Effects, all cheap:
* `DEST[ph][3]` (market) is multiplied by 2.4 while it holds.
* `routeToKind('market_hall')` gets a **ring destination**: a seeded point on a 7-unit circle
  around the hall rather than its doorstep, so 20+ villagers form a crowd instead of a queue.
* `news.post('marketOpen'/'marketClose')` once each, wall-clock latched.
* Bubble kind `'market'` becomes eligible.

---

## 4. `news.js` — the copy layer

### 4.1 New slots

Added to `slotVal()` and to `NEEDS` (so a line naming a person is **skipped entirely** when
the roster cannot supply one — the existing `unusable()` machinery does this for free):

| slot | source | in `NEEDS` |
|---|---|---|
| `{who}` | `S.who` (from a `cast` item) | ✔ |
| `{who2}` | `S.who2` | ✔ |
| `{job}` | `S.job` | ✔ |
| `{place}` | `S.place` — 'the Bakery' | ✔ |
| `{home}` | `S.home` — 'Cottage' | ✔ |
| `{quarter}` | `S.quarter` — 'Coin Row' | ✔ |
| `{fortune}` | `S.fortune` — 'Prospering' | ✔ |
| `{rel}` | `S.rel` — 'their oldest friend' \| 'a rival of long standing' | ✔ |

And **`{name}` changes source**: `slotVal('name')` becomes

```js
case 'name': {
  const n = nameOf ? nameOf() : '';            // opts.nameOf → npcs.randomName()
  return n || FOLK[Math.floor(rnd() * FOLK.length)];
}
```

with a per-line memo so `'{name} and {name} are not speaking'` never prints the same person
twice: keep `lineNames[]`, cleared at the top of `show()`/`showText()`, redraw once on a hit.
**This one change retroactively upgrades ~40 existing lines** — `'{name} paints their door a
colour'` now names a resident the user can go and find. Highest charm-per-byte in the doc.

### 4.2 New corpora

```js
PEOPLE: [                                       // ambient gossip, weight 12
  '{who}, {job} of {quarter}, has opened a second {place}. {who2} is not speaking to them.',
  '{who} and {who2} were seen on the bridge again. The town has chosen sides. Both sides.',
  '{who} the {job} predicts the total will double by supper. {who2} has bet a loaf against it.',
  '{who} has moved into the {home} on {quarter}. The neighbours are thrilled and lying.',
  '{who} was late to the altar and blames the {place}. The Ledger does not take excuses.',
  '{who2} has not forgiven {who} for the business with the cart. Nobody remembers the cart.',
  'The {job} {who} has written to the Crier. The letter is long. The point is not in it.',
  '{who} claims to have counted every chimney in {town}. The count is disputed by {who2}.',
  '{who} of {quarter} reports sleeping badly. The Ledger was loud again.',
  '{who} and {who2} have agreed to disagree, loudly, in the street, for an hour.',
  '{who} left flowers at the altar. {who2} left an itemised receipt.',
  '{who} says the town was better when it was smaller. {who} arrived on Tuesday.',
  '{who} has taken up the {job}\'s trade at forty. The other {job}s are being polite.',
  'A child of {who}\'s has learned to count to **{tok}**. Slowly, and out loud.',
  '{who} of {quarter} is described by {who2} as "a lot, lately". No further comment given.',
  '{who} has named a goose after the total. The goose is unimpressed and now famous.'
],
HERO_UP: [                                      // posted on a fortune band rise
  '{who} the {job} is doing well. {who} would like everyone to know it.',
  '{who} has bought a second cart. The first cart is furious.',
  'Fortune smiles on {who} of {quarter}. Fortune is fickle and {who} knows it.',
  '{who} has hired help. The help is {who2}, who needed the work.',
  '**{fortune}**, the town has decided, is the word for {who} this week.',
  'The {place} now belongs to {who}. Nobody is sure when this was agreed.'
],
HERO_DN: [                                      // …and on a fall
  '{who} is having a thin week. The tavern has extended credit. Once.',
  '{who} the {job} has stopped mentioning the total in company.',
  '{who} sold the good cart. Nobody asks about it. Loudly.',
  '{who} says things are fine. {who2} has seen the ledger and says nothing.',
  '**{fortune}**, they are calling it, when {who} is not in the room.'
],
MARKET: [
  'Market day in {town}. Everything costs a token and nothing costs less.',
  'Stalls up by seven. {who} has the good corner again. {who2} has written to the council.',
  'Market day: **{villagers}** villagers, four stalls, one goat, no system.',
  'The market opens. Prices are set by shouting, as the charter requires.',
  'A cheese of unusual size has arrived at market. {who} is guarding it.',
  'Market day ends. The square is swept. The goat is not found.'
],
CRIED: [                                        // rare; the Crier reports on himself
  'The Crier is {who}, and has been since before {who} could read.',
  '{who} the Crier has lost his voice. {who} continues at volume.',
  'The Crier\'s bell has been valued at **{tok}**. The Crier disagrees.'
]
```

`CAT_OF` gains: `gossip → PEOPLE`, `marketOpen/marketClose → MARKET`, and `fortune` picks its
side in `post()` exactly the way `pace` does:

```js
if (type === 'fortune') cat = d.up ? 'HERO_UP' : 'HERO_DN';
```

`fortune` and `marketOpen` are **urgent**; `gossip` is not.

Ambient weighting (`ambient()`): `add('PEOPLE', 12)` alongside the existing
`ECON/CIVIC/CULT` at 10 — so roughly **one ambient headline in four names a real resident**,
which is the right dose. `PEOPLE` is added *only when* `cast('gossip', S)` succeeds, so an
empty roster silently reverts to today's mix.

### 4.3 Bubbles

New kinds (`RAW_BUB`): `work`, `tavern`, `market`, `child`, `crier`.

```js
child: ['Is it a big number?','I can count to ten!','Dad says it goes up.',
  'Can I touch the Coin?','That house wasn\'t there!','I found a stick.','Watch this!',
  'Mum! MUM!','The dog\'s gone in the river.','Why is everyone kneeling?'],
tavern: ['Another. And one for {who2}.','Who\'s paying? Not me.','Sing the Ledger song!',
  'I\'ve had two. Maybe four.','Last one. Definitely last one.','Put it on my tally.'],
market: ['Two for a token. Fine, three.','Best price in {town}. Honest.',
  'That is not a cheese.','Weigh it again. Slowly.','I\'ll take the lot.'],
work: ['Back to it, then.','Long shift. Long total.','Nearly done. Nearly.']
```

**Job-flavoured work bubbles** — a second lookup keyed by trade, tried before the generic
`work` pool:

```js
const JOBBUB = {
  Baker: ['Oven\'s been on since four.','Six dozen loaves. Six.','Flour\'s up again.'],
  Smith: ['The anvil sang this morning.','Nails. It\'s always nails.','Mind the sparks.'],
  Miller: ['Wind\'s in the wrong quarter.','The stones want dressing.'],
  Trader: ['Best price in {town}. Honest.','Two for a token. Fine, three.'],
  Taverner: ['One at a time! ONE.','We\'re out of the good stuff.'],
  Farmhand: ['The field doesn\'t care about tokens.','Rain by Thursday. Trust me.'],
  'Water-carrier': ['The well is fine. It\'s FINE.'],
  'Bell-ringer': ['One more peal and I\'m done.'],
  Acolyte: ['The Coin is warm today.','…and the sum thereof…'],
  'Clerk of the Hall': ['Column four does not balance.','Ink everywhere. Again.'],
  'Night-watch': ['Nothing to report. As usual.'],
  Carter: ['Mind the cart! …there\'s no cart.'],
  'Star-clerk': ['The stars are also a ledger.'],
  "Wizard's Apprentice": ['It hums. It always hums.'],
  Gatewarden: ['Nobody comes through. That is the job.'],
  Ferryman: ['The bridge took my trade and my temper.']
};
```

`say()` gains one option and the pool divs gain two child spans (still **never `innerHTML`** —
`textContent` on each span):

```js
/**
 * @param {THREE.Vector3} v @param {string} kind
 * @param {{text?:string, ttl?:number, who?:string, job?:string}} [opts]
 *        `who` renders a small gold nameplate line above the remark. Capped: at most ONE
 *        live nameplate bubble at a time (two named bubbles read as a comic strip).
 */
say(v, kind, opts)
```

CSS additions to news.js's fallback sheet (index.html may override):

```css
.bub .who{display:block; font:700 9.5px/1.3 "Segoe UI",system-ui; letter-spacing:.07em;
  text-transform:uppercase; color:#D9A441; margin-bottom:2px; opacity:.95}
.bub.crier{max-width:270px; background:rgba(52,40,20,.94); border-color:rgba(243,208,122,.55)}
.bub.crier:after{border-top-color:rgba(52,40,20,.94)}
.bub.crier .who:before{content:'❖ '}
.bub.child{background:rgba(22,30,24,.90); border-color:rgba(180,220,180,.22); color:#DFEBDD;
  font-size:10.5px}
.bub.child:after{border-top-color:rgba(22,30,24,.90)}
.bub.tavern{background:rgba(40,26,14,.92); border-color:rgba(226,160,90,.34)}
.bub.tavern:after{border-top-color:rgba(40,26,14,.92)}
```

Base state is the final state, as always — the nameplate span is opaque at rest.

### 4.4 New `news.js` API

```js
/** The headline currently on the bar, for the crier to shout. Plain text is the markup
 *  stripped of <b>/<i>, entity-decoded — safe to hand to textContent.
 *  @returns {{html:string, plain:string, cat:string}} */
headline()
```

and two new `NewsOpts` fields, both optional:

```js
 * @property {()=>string} [nameOf]   a live resident's name for the {name} slot
 * @property {(kind:string, out:object)=>boolean} [cast]  fills the {who}/{who2}/… slots
```

**Contract-first degradation.** With `nameOf`/`cast` absent (or returning `''`/`false`), the
ticker is byte-for-byte what it is today: `PEOPLE` never enters the ambient pool, every
`{who}` line is `unusable()`, `{name}` falls back to `FOLK`. This is what lets `news.js` and
`npcs.js` be built **in parallel by two agents in the same wave.**

---

## 5. `town.js` — wiring, and the hover card

### 5.1 Enriched `getBuildings()` — **the one true prerequisite**

```js
function buildingsForNPCs() {
  if (buildingsDirty) {
    buildingsCache = [];
    for (const e of houses) if (e && e.group) buildingsCache.push({
      pos: e.group.position, yaw: e.group.rotation.y,
      idx: e.idx, kind: 'house', label: e.label || '', flavor: e.flavor || '', tier: e.tier
    });
    for (const e of landmarks.values()) if (e.group) buildingsCache.push({
      pos: e.group.position, yaw: e.group.rotation.y,
      idx: -1000 - (e.order | 0), kind: 'landmark', label: e.label || '',
      flavor: '', lm: e.lm, tier: -1
    });
    buildingsDirty = false;
  }
  return buildingsCache;
}
```

Landmarks get **negative synthetic idx** so one `Map<idx, ref>` covers both. Everything else
in npcs already reads only `pos`/`yaw`, so this is additive and cannot break the current
behaviour. **S, and it must land before §3.3/§3.4.**

### 5.2 The hover card

```js
// once, next to the other addHit() calls
for (const m of npcs.hitMeshes()) hitTargets.push(m);
```

and in the existing hover block, before `tipFor(ent)`:

```js
const hit = hits.find(h => h.object.userData.ent || h.instanceId != null);
if (hit && hit.instanceId != null && !hit.object.userData.ent) {
  const v = npcs.villagerAt(hit.object, hit.instanceId);
  if (v) { showTip(
    `${v.name}${v.epithet ? ' ' + v.epithet : ''}${v.hero ? ' ✦' : ''}`,
    `${v.job}${v.jobPlace ? ' at ' + v.jobPlace : ''} · lives at the ${v.home} on ${v.quarter}`,
    `${v.portrait} · ${v.trait}`); return; }
}
```

Three lines, matching the existing tooltip shape exactly:

```
Bram Cachewright ✦
Baker at the Bakery · lives at the Cottage on Coin Row
brick-red robe, wide flat cap, walks unhurried · thrifty · bows at the altar
```

**The portrait generator** (`npcs.js`, pure, cached on the Person at mint):

```js
const ROBE_NAME = ['wheat','brick-red','rose','sage','cream','slate-blue','plum','ember',
  'moss','dust','pine','coral'];                     // parallel to ROBE
const HAT_NAME = ['bare-headed','a plain cone hat','a wide flat cap','a very tall hat',
  'a soft round cap'];                               // keyed by the HATS silhouette
const GAIT = s => s < 1.05 ? 'walks unhurried' : s < 1.3 ? 'walks brisk' : 'always late';
const RITE_NAME = ['bows at the altar','raises both arms','kneels'];
portrait = `${ROBE_NAME[i]} robe, ${HAT_NAME[j]}, ${GAIT(p.speed)}`;
```

`IM.body` is ~0.2 units wide (2–3 px at the 300-unit framing) and `IM.disc` is a 0.27-unit
ground circle directly under the feet — raycast **both**; the disc is the forgiving target.
This is explicitly a lean-in feature. Set `canvas.style.cursor = 'help'` while a villager is
under the pointer.

### 5.3 The rest of the wiring (all small)

```js
const news = initNews({ …existing…,
  nameOf: () => npcs.randomName(),
  cast:   (kind, out) => npcs.cast(kind, out)
});
// in tick(), after pullBubble(now):
pullCrier(now);
if (npcs.crierSpeaking()) { /* §3.7 relay */ }
// in the 500 ms stats tick:
const hv = npcs.heroEvent(); if (hv) news.post('fortune', hv);
const mk = npcs.marketEvent(); if (mk) news.post(mk.open ? 'marketOpen' : 'marketClose', mk);
// gossip: one post every 70-140 s, so PEOPLE also fires as an EVENT and not only as ambient
if (gotData && ctx.intro >= 1 && now - gossipAt > gossipEvery) {
  gossipAt = now; gossipEvery = 70000 + Math.random() * 70000;   // chrome cadence: Math.random OK here
  news.post('gossip', {});                                       // news pulls the cast itself
}
```

---

## 6. The update budget — exact

Two round-robin passes, both **wall-clock scaled** so a 1 fps headless capture converges
inside one frame (V3 §13.2, the rule that breaks the most changes):

```js
// at the top of update(), once
const elapsed = Math.min(now - lastNow || 16, 1000);
const routeBudget = clamp(ROUTE_MIN + (elapsed / THINK_MS | 0), ROUTE_MIN, ROUTE_MAX);
const lifeBudget  = clamp(LIFE_MIN  + (elapsed / LIFE_MS  | 0), LIFE_MIN,  LIFE_MAX);
```

| pass | what it does | frequency | budget |
|---|---|---|---|
| **pose loop** (existing) | matrices, gait, lanterns | every actor, every frame | unchanged, ~0.20 ms @160 |
| **state transitions** (existing) | `now > n.until` compares | every actor, every frame | unchanged, ~0.01 ms |
| **think** (new) | `pickDestination` + `routeTo`/A* | FIFO `wantRoute[]`, round-robin | `routeBudget` (4 @60 fps, 120 @1 fps) |
| **life** (new) | home, job, mood, hero fortune, dog owner | round-robin cursor over `folk` | `lifeBudget` (3 @60 fps, 64 @1 fps) |
| **dogs** (new) | ≤20 matrix composes | every frame | ~0.02 ms |

Costs measured against the existing profile (160 NPCs = 0.15–0.20 ms/frame, 6 draw calls):

```
think : ~10 µs per A* on a ≤500-node graph (and plan.pathTo is CACHED) × 4  =  0.040 ms
life  : ~1 µs per person (24-candidate home scan is the worst case)   × 3   =  0.003 ms
dogs  : compose+upload                                                       =  0.020 ms
crier : one state compare                                                    =  0.000 ms
────────────────────────────────────────────────────────────────────────────────────────
added, steady state                                                          ≈ 0.063 ms
```

**Budget: ≤ 0.10 ms/frame added, +1 draw call (dogs), +1 draw call (the crier's bell,
`count ≤ 1`).** Total NPC layer: 8 draw calls, ~0.28 ms. Well inside the 60 fps @ 1200
buildings envelope.

**The critical routing change:** when a villager wants a new route it is *enqueued*, not
planned inline. Until it is served it keeps walking its current leg or stands still (already
a legal state — `idleUntil`). No visible stall: at 60 fps the queue never exceeds ~2 entries
because only ~1 villager per 20 s per head needs a plan (160 heads ÷ 20 s = 8 plans/s vs a
budget of 240/s).

**Verification hook** (must ship with the feature, since we cannot open a window):

```js
window.__npcStats = () => ({ actors, roster, homed, jobbed, routesQueued, thinkMs, lifeMs,
  crierState, heroBand, dogs });
```

Read it from the headless shot harness the same way `__tick` is used today.

---

## 7. Wall-clock discipline — the checklist for this feature

Everything below is **existence**, and must key off `performance.now()` / `Date.now()`:

* roster minted (synchronously on the first `update()` after a plan swap — not deferred)
* home/job assignment convergence (via `lifeBudget` scaling — a 1 fps frame homes everyone)
* the crier's announce schedule, walk deadline, and the 6.2 s shout
* market-day open/close latches
* the hero's fortune integration (`1 - exp(-Δt/45000)`, never `+= dt * k`)
* children sent home at dusk
* dog sleep/wake

`dt`-driven (cosmetic only): tail wag, bell shake, gait, the child's trailing lag spring.

---

## 8. Ranked plan

Sizes are for one implementer working in one file. **Files touched** is the scheduling key.

### MUST

| # | item | size | files |
|---|---|---|---|
| **L1** | **Person roster**: `mintRoster`, names, epithets, traits, wardrobe moved off the actor onto the Person, `folk[]`, `n.p`, `rosterSize/personAt/randomName`, epoch re-mint from `ctx.planSeed` | **M** | `npcs.js` |
| **L2** | **Enriched `getBuildings()`** (§5.1) — `idx`/`kind`/`label`/`flavor`/`tier`, synthetic negative idx for landmarks | **S** | `town.js` |
| **L3** | **Homes** — `buildingIndex()`, resident counts, kin co-housing, `goHome()` targets the villager's own house, `quarterOf()` | **M** | `npcs.js` |
| **L4** | **Real names in the Crier** — `{name}` sources `nameOf()`, per-line dedupe memo, `initNews({nameOf})` wiring | **S** | `news.js`, `town.js` |
| **L5** | **Jobs + routine** — `JOBS`/`TRADES`, `PHASE`/`DEST`/`WORSHIP_BIAS`, `pickDestination()`, `routeToKind()`, loiter-on-arrival | **M** | `npcs.js` |
| **L6** | **The Town Crier NPC** — pinned `folk[0]`, camera-facing plaza rim, bell mesh, walk deadline, `announce/crierSpeaking/crier`; `news.headline()`; `.bub.crier` + nameplate span; `pullCrier()` relay | **M** | `npcs.js`, `news.js`, `town.js` |

### SHOULD

| # | item | size | files |
|---|---|---|---|
| **L7** | **Gossip engine** — `cast(kind,out)`, `PEOPLE` corpus, the 7 new slots + `NEEDS`, `CAT_OF.gossip`, ambient weight 12, the 70–140 s `post('gossip')` timer | **M** | `npcs.js`, `news.js`, `town.js` |
| **L8** | **The protagonist** — fortune integrator, 5 bands, debounce, `repaintHero()`, `heroEvent()`, `HERO_UP`/`HERO_DN` | **M** | `npcs.js`, `news.js`, `town.js` |
| **L9** | **Villager hover card** — `hitMeshes()`, `villagerAt()`, portrait generator, `tipFor` branch, `cursor:help` | **S** | `npcs.js`, `town.js` |
| **L10** | **Children** — 16 % of roster, no work/worship, trail a parent, sent home first at dusk, `child` bubbles | **S** | `npcs.js`, `news.js` |
| **L11** | **Dogs** — `IM.dog`, one per ~12 households, shadow the owner, sleep on the doorstep | **S** | `npcs.js` |
| **L12** | **Job-flavoured bubbles** — `JOBBUB`, `work`/`tavern`/`market` kinds, `say({job})`, `pickSpeaker(want,out,outMeta)` | **S** | `news.js`, `npcs.js`, `town.js` |
| **L13** | **Market day** — seeded 2-in-7, ring destination around the hall, `MARKET` corpus, open/close latches | **S** | `npcs.js`, `news.js` |

### COULD

| # | item | size | files |
|---|---|---|---|
| **L14** | **Nameplates** for the hero and the crier when `camDist < 120` — reuse the `.who` span, cap 1 live | **S** | `news.js` |
| **L15** | **Follow-a-villager camera** — click a villager to orbit them at 18 units; ESC / drag releases. The single most fun thing in this doc, and the most likely to fight the existing framing code | **M** | `town.js`, `npcs.js` |
| **L16** | **A lit window means someone is home** — `npcs.residentsIn(idx)` → town.js drives that house's `winMats` emissive. Turns the night skyline into an occupancy map | **M** | `npcs.js`, `town.js`, maybe `buildings.js` |
| **L17** | **Arrivals** — when the town grows past a threshold a new Person walks in along the gate road with a bundle, and the Crier files `'{who} has arrived from somewhere. Nobody asks where.'` | **S** | `npcs.js`, `news.js` |
| **L18** | **Guilds from `source_path`** — the feed already knows which project burned the tokens; hash it into a guild name and give ~30 % of villagers a guild ("of the Tokentracker Guild"). Note V3 §12 killed *visual* model attribution; a **textual, non-colour** project signal is a different thing, but it needs the feed protocol extended and an explicit sign-off | **L** | `datafeed.js`, `town.js`, `npcs.js`, `news.js` |
| **L19** | **Census panel** — a hoverable footer chip listing the five most-mentioned residents with their jobs and fortunes | **M** | `town.js`, `index.html` |

---

## 9. Build order and parallelism

```
                    ┌─ L2 (town: getBuildings)  ── prerequisite for L3, L5
   L1 (roster) ─────┼─ L3 (homes) ─┬─ L5 (jobs+routine) ─┬─ L13 (market)
                    │              │                     └─ L10 (children) ─ L11 (dogs)
                    ├─ L6 (crier)  │
                    ├─ L7 (gossip) ┘
                    ├─ L8 (hero)
                    └─ L9 (hover)

   L4 (news {name}) ── independent; ships value the moment L1 lands
```

**Must be built before anything else: L1 and L2.** L2 is a 10-line `town.js` change and
should be handed to core in the *same* wave that starts L1, not after it.

**Three non-colliding lanes after L1+L2:**

| lane | owner | items | file |
|---|---|---|---|
| **A** | npcs | L1 → L3 → L5 → L10/L11/L13 | `npcs.js` only |
| **B** | news | L4 → L7 copy/slots → L12 → L14 | `news.js` only |
| **C** | core | L2 → L9 → the L6/L7/L8 relays | `town.js` only |

Lanes B and C are written **against the contract in §2.1 while lane A is still building it**,
because every new npcs method is specified to be null-safe and every new corpus line is
gated by `unusable()`. Nobody blocks.

The only true three-file items are **L6** (crier) and **L7** (gossip); schedule each as a
single implementer touching all three files in one commit, in a wave where lanes A/B/C are
idle — or split them: the `npcs.js` half first, the `news.js`+`town.js` half in the next wave
(the crier simply never announces until the relay lands, which is a safe intermediate state).

---

## 10. Acceptance — what "it worked" looks like

Verified only via the headless shot harness (`--shot`, `--hour`, `--seed`) and
`window.__npcStats()`. Never a visible window.

1. `--hour=10` at ≥ 60 buildings: villagers are **clustered at premises**, not evenly spread
   on the road graph. `__npcStats().jobbed / roster > .8`.
2. `--hour=19`: lantern-carriers converge on **distinct** houses; no two villagers share a
   doorstep unless they are `kin`. `homed / roster === 1`.
3. Any hour, within 9 s: the ticker has shown **at least one line naming a resident**, and
   that name resolves via `personAt()` to an embodied villager.
4. Within 45 s of load (or immediately after `announce()`): a `.bub.crier` bubble exists in
   the DOM with a gold nameplate, anchored over a villager standing inside the plaza radius.
5. A hover ray at a villager's contact disc yields a three-line card whose second line names
   a building that exists in `getBuildings()`.
6. `__npcStats().thinkMs + .lifeMs < 0.12` at 160 actors, and the frame time in a 1200-house
   town is unchanged within noise from pre-v4.
7. `--seed=N` twice ⇒ **identical roster**: same names, same jobs, same protagonist. A user
   who reloads must meet the same townsfolk.
8. Nothing in `NEWS_CORPUS` names a model (the existing test still passes over the new pools).

---

## 11. Risks, and the answers

| risk | answer |
|---|---|
| A 500-node A* per errand × 160 villagers tanks the frame | routes are queued and budgeted (§6); `plan.pathTo` is already cached; the steady-state demand (8/s) is 3 % of the budget |
| Homes churn when the town promotes/rebuilds a house | homes key on **plot idx**, which survives `remountEnt()`; only an epoch reset re-homes |
| The roster desyncs from the actor pool after `despawn()`'s swap-remove | `p.actor` is updated in exactly the two places that already move an actor (`despawn`, `spawn`); `personAt().state` returns `'indoors'` when `p.actor < 0` |
| The crier is culled by the dusk shrink and the feature silently dies | `pinned` — excluded from the shrink pool, re-spawned first; covered by acceptance #4 |
| Named gossip gets repetitive | `storyAt` per person (90 s cooldown) + the existing 26-slot anti-repeat ring, which already keys by (category, line) |
| `{who}` lines print when the roster is empty | they are `unusable()` — the existing truth gate, reused verbatim. This is why the slots go in `NEEDS` |
| Two agents collide in `npcs.js` | they must not; lane A is one owner. L6/L7's npcs halves are the only cross-lane touch and are scheduled explicitly (§9) |
| Villagers are 3 px tall so nobody sees any of this | by design the payoff is in the ticker, the bubbles and the hover card — all camera-distance-independent. L15 (follow cam) is the "could" that closes the loop |
