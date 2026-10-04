# Token Town v3 — Monument Escalation & the Free Colour World

Design owner: this doc covers (1) the plaza centrepiece ladder and (2) the palette system that
replaces model-family attribution. It does **not** cover layout/river, countryside, ticker or the
range plumbing — those are other agents' surfaces. Every place the two touch is marked **SEAM**.

Files: `src/renderer/monument.js` (rewrite of the ladder, same public API), `src/renderer/palette.js`
(new), `src/renderer/buildings.js` (colour policy removed, becomes a pure consumer),
`src/renderer/town.js` (family plumbing deleted), `src/renderer/index.html` (header/footer),
`src/renderer/npcs.js` (two tiny cfg changes). No C#. No npm deps.

---

# PART 1 — THE MONUMENT

## 1.0 What is wrong today

Ten tiers exist but they are *adjustments*, not events: `T_COIN_R` goes 1.6 → 3.2 across the whole
1000× token range, `T_LIFT` moves the coin 1.6 units once, `T_STELE` stretches a slab by 38 %, and
the base gains one 2.7-radius drum. `growFor(outerR)` (1.0 → 1.55) then does more visual work than
the entire tier ladder. A 1B-token day and a 5M-token day differ by ~4 units of height. The number
the town exists to celebrate has no skyline.

The redesign keeps everything that is load-bearing — one `setTier(n)` swap, idempotent/jumpable
tier rows, zero geometry allocation after init, wall-clock scheduling, emissive-first lighting —
and replaces the *amounts*.

## 1.1 The hard geometric constraint (read before designing anything wider)

`R0 = 18` is the radius of the innermost plot ring and it can never move: plot positions are a pure
function of index, and moving `R0` relocates every house in the town. NPCs are promised a keep-out
of `attractor.r0` and worship in arcs out to `r1 = r0 + 4.4`.

> **Invariant:** `footprintR(tier) × growS + 4.4 ≤ 17.4`, i.e. `footprintR × growS ≤ 13`.

Therefore the escalation is **vertical and aerial**, not wide. Grandeur comes from height, floating
elements, thin tall spires, light and sky furniture — not from a bigger disc of stone. This is also
the better read: a 78-unit needle over a 112-unit-radius city is a skyline anchor; a 30-unit-wide
plinth is a car park. `growS` is retuned to `1.0 … 1.18` (was 1.55) so the tier table owns the size
and the two effects stop compounding.

## 1.2 The ladder: eleven silhouettes

`LADDER`'s `mon:` column stays the single owner of tier↔tokens (monument.js must never hold a
token table again — it used to and it drifted). New mapping, one distinct tier per rung:

| rung | tokens | mon |
|---|---|---|
| first_light | 250 k | 1 |
| millionaire | 1 M | 2 |
| windfall | 5 M | 3 |
| market_day | 10 M | 4 |
| bell | 25 M | 5 |
| arcane | 50 M | 6 |
| cathedral | 100 M | 7 |
| gilded | 250 M | 8 |
| scholar | 500 M | 9 |
| skygate | 1 B | 10 |

Tier tables become 11 rows (index 0..10). `clamp(n, 0, 10)`.

### The silhouettes

| T | name | h (crown) | footR | plazaR | what arrives |
|---|---|---|---|---|---|
| 0 | **Survey Stone** | 3.2 | 2.6 | 12 | a cairn of three rough stones, two stakes and a plank ledger board. Reads as "ground has been broken", not "a shrine with nothing in it". |
| 1 | **Waystone** | 8 | 4.2 | 12 | one octagonal drum, a short stele, the coin (r 1.6), two braziers. First fire. |
| 2 | **Shrine** | 13 | 5.2 | 12 | second drum, stele grows, 4 braziers, coin r 2.2, **halo ×1**. |
| 3 | **Gilded Altar** | 17 | 5.8 | 13 | moat ring fills, gold banding on stele + ledger frame, coin r 2.6. |
| 4 | **Coin Fountain** | 22 | 6.6 | 13.5 | terraced basin with 4 spouts that pour a **continuous stream of falling coin motes** into the moat; halo ×2; **aura begins**. |
| 5 | **Colonnade Sanctum** | 29 | 7.6 | 14 | a ring of 12 fluted pillars + architrave lifts the coin into an open temple; beacon .25; **first point light (60 cd)**. |
| 6 | **Ziggurat of Ledgers** | 37 | 8.6 | 14.5 | base becomes 5 stepped terraces with stair flights; 4 tall obelisks at the plaza edge; braziers → 8; beacon .45; light 160. |
| 7 | **Orbital Reliquary** | 46 | 9.4 | 15 | the coin **lifts free of the stone** and floats; 3 counter-rotating orbital rings; 8 orbiting coins; pillars gilded; light 380; aura 40. |
| 8 | **Solar Vault** | 54 | 10.0 | 15.5 | the whole base gold-plated; a second, larger coin-disc above the first; the obelisks become lit spires with flame tips; beacon .65; light 700; sky glyph faint. |
| 9 | **Radiant Colossus** | 62 | 10.6 | 15.5 | a gilded spire pierces both coins and continues into the sky; two flanking light-towers; ledger reframed in radiant gold; sky glyph full; light 1200. |
| 10 | **The Skyward Mint** | 78 (sky ring at 92) | 11.0 | 15.5 | a slow sky ring above the beam; permanent **coin-rain** aura; beacon 1.0; light 1800 — the town's night sun. Coin r 5.2. |

Every row visibly dwarfs the previous one: heights are ×1.35–1.6 per step at the low end and
+8–16 units per step at the high end, so a tier-up is never subtle even at a nine-ring framing.

### Tier tables (replacing T_COIN_Y … T_BEACON)

```js
// index === tier, 0..10. Everything the ladder changes is one number in one of these.
const T_H      = [3.2, 8, 13, 17, 22, 29, 37, 46, 54, 62, 78];   // crown height, reference only
const T_FOOT   = [2.6, 4.2, 5.2, 5.8, 6.6, 7.6, 8.6, 9.4, 10.0, 10.6, 11.0];
const T_PLAZA  = [12, 12, 12, 13, 13.5, 14, 14.5, 15, 15.5, 15.5, 15.5];
const T_DRUMS  = [0, 1, 2, 2, 3, 3, 5, 5, 5, 5, 5];              // visible stepped terraces
const T_SPIRE  = [0, .55, 1, 1.25, 1.5, 2.1, 2.8, 3.4, 4.0, 5.2, 6.6];   // stele/spire scale.y
const T_COIN_Y = [0, 5.4, 8.6, 10.4, 12.6, 17.0, 22.5, 29.0, 34.0, 39.0, 48.0];
const T_COIN_R = [0, 1.6, 2.2, 2.6, 2.8, 3.2, 3.6, 4.0, 4.4, 4.8, 5.2];
const T_HALOS  = [0, 0, 1, 1, 2, 2, 2, 3, 4, 5, 5];
const T_PILLAR = [0, 0, 0, 0, 0, 12, 12, 12, 12, 12, 12];         // instance count
const T_OBEL   = [0, 0, 0, 0, 0, 0, 4, 4, 8, 8, 8];
const T_BRAZ   = [0, 2, 4, 4, 4, 4, 8, 8, 8, 8, 8];
const T_BEACON = [0, 0, 0, 0, 0, .25, .45, .55, .65, .80, 1.0];
const T_LIGHT  = [0, 0, 0, 0, 0, 60, 160, 380, 700, 1200, 1800]; // candela (r160 physical)
const T_AURA   = [0, 0, 0, 0, 18, 26, 34, 44, 56, 68, 84];        // live aura motes
const T_TAB_Y  = [3.4, 6.2, 9.0, 11.4, 14.5, 18.0, 22.0, 26.5, 30.0, 33.5, 38.0];
const T_TAB_S  = [.34, 1, 1, 1, 1, 1.06, 1.06, 1.13, 1.13, 1.2, 1.2];
const growFor = outerR => clamp(1 + (outerR - 39) / 63 * .18, 1, 1.18);
```

Material escalation stays a set of thresholds read inside `applyTier` (as today):
`frameGold ≥ 3`, `steleGold ≥ 5`, `pillarGold ≥ 7`, `baseGold ≥ 8`, `allRadiant ≥ 9`.

## 1.3 Construction — everything built once, toggled per tier

The current module allocates every part at init and only flips `visible` + eases scalars. Keep
that exactly; the new parts follow the same rule, with repeated furniture as `InstancedMesh` whose
*count* is the tier's number and whose unused instances are parked at `y = -999` (the idiom
`revealScatter` already uses in town.js).

New/changed nodes:

- **terraces** — one octagonal `CylinderGeometry(1,1,1,8)` in an `InstancedMesh(5)`. Each visible
  terrace gets `(rTop, rBot, h, y)` from a table scaled by `T_FOOT[n] / T_FOOT[10]`; hidden ones park.
  Replaces the four hand-placed `drums`. **1 draw.**
- **spire** — the old stele, re-profiled: a 4-sided tapered shaft that at T ≥ 9 continues *through*
  the coin as a needle. One mesh, `scale.y = T_SPIRE[n]`. Ledger bands ride it as today.
- **colonnade** — `InstancedMesh(16)` of a fluted column (an 8-segment cylinder with a chamfered
  cap baked in), 12 used, ring radius `T_FOOT[n] × .82`. Plus an architrave torus (1 mesh, hidden
  below T5). **2 draws.**
- **obelisks** — `InstancedMesh(8)` of a tall tapered 4-sided shaft, at radius `T_FOOT[n] + 1.6`,
  height `T_H[n] × .42`. At T ≥ 8 each gets a flame at its tip (part of the flame instancer).
  **1 draw.**
- **braziers** — bowls and posts fold into one `InstancedMesh(8)` each (or one welded pair);
  flames into a single additive `InstancedMesh(16)` (8 braziers + 8 obelisk tips), per-instance
  scale.y animated from the same `Math.sin` bank used today. **3 draws.**
- **fountain (T ≥ 4)** — a basin ring (1 mesh) + 4 spout blocks folded into the terrace instancer;
  the *water* is the aura particle system in `fountain` mode (see 1.5), not geometry.
- **coin** — unchanged construction (`coinPivot` → `coinScale`), radius from `T_COIN_R`. At T ≥ 8 a
  second, larger disc appears above it, sharing the same geometry and materials at a different
  scale — one extra mesh, 2 draws total for both because they share the 3-material array.
- **halos** — 5 tori sharing 2 materials; make them one `InstancedMesh(5)` whose matrices are
  rewritten each frame (5 `compose()` calls is free) so the counter-rotation survives. **1 draw.**
- **orbit** — existing `InstancedMesh`-able 8 coins. **1 draw.**
- **sky ring (T10)** — 3 concentric additive tori at `y ≈ 92`, one shared material. **1 draw.**
- **beacon / sky glyph / shockwave / pulse ring / plate / ledger** — unchanged.

### Draw-call budget (steady state, T10, worst case)

terraces 1 · spire 1 · colonnade 2 · obelisks 1 · braziers 2 · flames 1 · moat 1 · basin 1 ·
coins 2 · halos 1 · orbit 1 · ledger 3 (backing, face, frame-instancer) · beacon 1 · sky glyph 1 ·
sky ring 1 · particles 1 = **21**, of which 3 (shockwave, pulse, plate) only exist during a
ceremony and 5 are hidden below T5. Under the ~20 target for the common tiers, +1 at 1B. ✔

## 1.4 Light — the monument becomes the night sun

Today the monument owns zero lights, deliberately (adding one would fight the sun). That rule
relaxes at exactly one point: **one `PointLight`, created at init, intensity 0 until T5.**

```js
const sun2 = new THREE.PointLight(0xFFC65A, 0, 0, 2);   // distance 0 = infinite, decay 2
sun2.position.y = 6; sun2.castShadow = false;           // NEVER: 6 shadow faces would halve fps
group.add(sun2);
// per frame:
sun2.intensity = T_LIGHT[tier] * clamp(night * 1.3 - .12, 0, 1) * (1 + .06 * Math.sin(now / 1300));
```

Candela with `decay: 2` means illuminance falls as `I/d²`. At T10, `1800 / 60²  = 0.5` at
mid-town — a warm gold wash over roofs at midnight without touching daylight (the `night` gate
zeroes it before dawn). Precedent for magnitude: the wizard tower's 16 cd at distance 20.

**SEAM (town.js, 3 lines, optional but worth it):** `monument.nightSun` (0..1 getter) lets the
conductor tint the hemisphere so the *sky* agrees with the ground:

```js
const ns = monument.nightSun * night;
hemi.groundColor.lerp(GOLD_GROUND, .35 * ns);
hemi.intensity = (.16 + day * .38 + .10 * ns) * LI;
```

Everything else stays emissive-only. The beacon keeps its night gate (a gold shaft in daylight
reads as a rendering artefact — that comment is still true and still load-bearing).

## 1.5 Particle auras

The pool grows `PN 140 → 240` and gains a second mode. Same buffer, same `Points`, one draw.

- **burst** (existing) — gravity −12, bounce at y .1, life .55–1.25 s. Untouched.
- **aura** (new, T ≥ 4) — motes with `p.aura = true`: spawned on a **wall-clock** cadence
  (`now - lastAura > 1000 / rate`, where `rate = T_AURA[n] / 2.2`), zero gravity, upward drift
  `vy ∈ [.6, 1.5]`, slow inward swirl (`vx,vz` rotated about Y by `.4 rad/s`), life 2.2 s, so a
  headless 1 fps shot always shows a full column. Spawn ring radius `T_FOOT[n] × .7`, from y .4.
- **fountain** (T ≥ 4, a flavour of aura) — 4 emitters at the spouts, downward-arcing motes with
  gravity, landing in the moat. Reads as coins pouring into the treasury.
- **coin-rain** (T10) — aura motes spawn *above* the crown (y 70–92) and fall past the whole
  monument. Colour cycles GOLD_HI ↔ white.

Point size already scales with camera distance (`pMat.size = .36 * clamp(camD/62,1,3.4)`); keep it.

## 1.6 The ledger at every tier

The ledger must stay the most legible object in the frame at T0 *and* at T10.

- Position: `T_TAB_Y[n]` (≈ 0.5 × crown height) + half the plate's camera-scaled height, as today.
  It never rises above `0.62 × crown` so the camera's auto-framing always contains it.
- Size: the existing constant-apparent-size trick is unchanged (`screenK / growS`), which is what
  stops a 78-unit monument from carrying a 40-unit billboard.
- Frame material escalates (stone → gold → radiant) but the **canvas layout never changes**: same
  two rows, same 176 px digits, same progress bar. The number is the one thing that must not
  become a design element.
- T ≥ 7: the plate gains a thin additive backing halo (one quad, GOLD_HI at .10) so the black
  ledger doesn't become a hole punched in a wall of gold light.
- T ≥ 9: at high tiers the coin is above the ledger and both are above the rooftops; the ledger
  stays yaw-billboarded (never tips) — a pitching plate at 38 units reads as a floating screen.

## 1.7 The tier-up ceremony

Four phases, all scheduled on the clock `update()` is fed (`clockNow()`), never `performance.now()`
directly — `__tick` stepping must stay coherent. Total 3.2 s.

| t (ms) | phase | what |
|---|---|---|
| 0 – 600 | **charge** | braziers flare to 1.8×; the aura reverses — motes rush *inward and down* to the coin; a gold wireframe outline of the *incoming* silhouette snaps up from the ground (one additive cylinder using the beacon material, scaled to the new footprint/height, opacity .35 → 0 over the phase). `npcs.celebrate(MON_POS, {milestone:true, runners:8, cheerRadius:999})` fires at t=0 so the run-in overlaps the charge. |
| 600 – 800 | **flash** | coin emissive spikes to 1.6; a single additive sphere (reuse the shockwave material on a sphere mesh) blooms from the coin to 3× footprint and dies; `npcs.pulse()` at t=700 → the whole congregation bows in unison; the new parts are revealed here (`show(o, true, base, animate)` → the existing `pops` easeOutBack). |
| 800 – 2000 | **wave** | ground shockwave ring sweeps to `max(outerR, plaza×2)` (existing `shock`); a *vertical* gold ring climbs the new spire at 40 u/s and fades at the crown; 120-mote burst from the coin; the title plate fades in. |
| 2000 – 3200 | **settle** | scalars ease to the new tier row (`k = 1 - exp(-dtMs/170)`, unchanged); plate fades out; braziers return to baseline; aura resumes outward at the new rate. |

Public surface (additive; no existing signature changes):

```js
monument.setTier(n, {animate:true})      // unchanged
monument.celebrate(title, colorHex)      // unchanged — town.js already calls both
monument.ceremony                        // getter → {phase:'charge'|'flash'|'wave'|'settle'|null, k:0..1}
monument.nightSun                        // getter → 0..1
monument.tierName                        // getter → 'Orbital Reliquary'  (SEAM: ticker copy)
```

**SEAM (ticker agent):** `tierName` is the headline for the news line — *"The Orbital Reliquary
opens on the plaza — crowds gather."* Fire it off the same `fireMilestone` call site that already
exists in town.js.

**SEAM (npcs.js):** nothing required. `getAttractor()` already returns live `{center, r0, r1}` and
`r0 = footprintR × growS` keeps the worship circle hugging the growing base. Villagers walk to
arcs at `r0 + .8 / +2.3 / +3.7`, which at T10 puts the congregation at 13–17 — inside ring 0. ✔

## 1.8 The plaza grows

`PLAZA_R` stops being a constant.

```js
let plazaR = 12;                                   // town.js module state
const setPlazaR = r => { if (Math.abs(r - plazaR) < .4) return; plazaR = r; scafDirty = true;
                         updateRoads(groundRings, true); layoutPlazaFurniture(); };
```

- `makeRoadTexture(rings)` → `makeRoadTexture(rings, plazaR)`; `updateRoads(rings, force)` repaints
  when either changed. The repaint is a 2048² canvas — it already happens on every ring change, and
  a plaza step happens at most 10 times in a day. Fine.
- Plaza lamps (6, at `PLAZA_R + 1.4`) and benches (4, at `R = 10.6`) move to
  `plazaR + 1.4` / `plazaR - 1.4`: hold them in a `plazaFurniture` array with a base ratio and
  reposition in `layoutPlazaFurniture()`.
- `ctx.plazaR` becomes live (it is already read per frame by npcs and monument).
- **npcs.js:** `cfg.plazaR` accepts a **function** as well as a number (`const PLAZA = typeof
  cfg.plazaR === 'function' ? cfg.plazaR : () => (cfg.plazaR || 12)`; ~4 call sites). This is the
  only npcs.js edit this design requires.
- Capped at 15.5 so `plazaR + 2.5 < R0 = 18` — the plaza must never eat ring 0.

**SEAM (layout agent):** if the organic/river layout moves the innermost plot radius, publish it as
`innerR()` and change the cap to `innerR() - 2.5`; the invariant in §1.1 becomes
`footprintR × growS + 4.4 ≤ innerR() - .6`.

## 1.9 Camera framing

`refreshFraming()` sizes the camera from `outer` only. A 78-unit crown on a young-but-rich town
would be cropped. One-line fix:

```js
const monTop = monument.crownHeight;               // new getter: T_H[tier] * growS
if (!userDist) dist = clamp(Math.max(outer * (1.35 + .5*clamp(outer/112,0,1)) + 20, monTop * 2.1), 50, 300);
target.y = 3 + Math.max(outer * .05, monTop * .16);
```

Call it from `fireMilestone` too (it already schedules a dolly punch-in at +150 ms — a tier-up is
exactly the moment the altar should be the subject).

---

# PART 2 — THE FREE COLOUR WORLD

> User: *"Houses shouldn't be related to the models used — free colour usage."*

Model→colour attribution dies completely: it is deleted from the buildings, the header, the footer,
the tooltips, the particles and the growth bookkeeping. What replaces it is a **seeded per-day town
palette**: every morning the town wakes up as a different place.

## 2.1 New module: `src/renderer/palette.js`

Owns *all* colour policy. `buildings.js` becomes a pure consumer that never derives a colour.

```js
export function initPalette(seed)          // seeded per day; idempotent, rebuild-safe
export function paintHouse(idx, ring)      // → Paint
export function paintFlavor(kind, idx, ring)
export function paintLandmark(kind)
export function paintScaffold()            // always gold — gold means tokens
export const townName = () => 'Ashenford'  // seeded per day
export const dayAccent = () => 0xC9932F    // one hex: hero number, floaters, fireworks
export const paletteDots = () => ['#B4553C','#4E545E','#5B6B47']   // header mark
export const roofNameOf = idx => 'Terracotta'                       // tooltips
export const rareOf = idx => null | 'painted-lady' | 'thatch' | 'blue-door'
```

```js
/** @typedef {Object} Paint
 *  @property {number} roof   tile colour, already shade-varied and quantised
 *  @property {number} wall   plaster
 *  @property {number} wall2  plaster, −15 %
 *  @property {number} trim   timber
 *  @property {number} stone  wall, −34 %
 *  @property {number} door
 *  @property {number} accent crates/awnings/flags/pennants
 *  @property {boolean} rare  painted lady */
```

## 2.2 The palette model

**Roof families** — ten, each a base hex plus a name (the name is a UI asset: tooltips and the
ticker both use it):

| family | hex | reads as |
|---|---|---|
| Terracotta | `#B4553C` | warm south |
| Ochre | `#8E4A38` | old brick |
| Saffron | `#C9932F` | market town |
| Slate | `#4E545E` | civic, northern |
| Charcoal | `#3A3A38` | industrial |
| Moss | `#5B6B47` | thatch/turf |
| Seafoam | `#4F8A7A` | coastal |
| Azure | `#3E6E8E` | harbour |
| Plum | `#6B4A6B` | wealthy |
| Ashblue | `#6E7C86` | quarry |

**A day's town palette** = seeded pick of **3 primaries + 1 accent** with two harmony rules:

1. No two primaries within 25° of hue *unless* one is a neutral (Slate / Charcoal / Ashblue).
   Every palette gets at least one neutral — that is what makes a street read as a town rather
   than a paint chart.
2. The accent is the highest-chroma family not already picked; it must contrast the dominant
   primary by ≥ 60° hue or ≥ .25 lightness.

**Roof mix:** primaries at 46 % / 28 % / 18 %, accent 8 %, chosen by
`seededR(idx * 3.13 + daySeed)`. Per-house shade variation stays exactly as today — ±8 %,
**quantised to 7 steps** so `matFor`'s 8-step channel quantisation keeps the material cache at
~60–100 materials. *Do not let hue vary continuously per house; that detonates the cache.*

**Walls:** the existing `PLASTER` array, picked by seed, tinted **8 % toward its own roof** (was
13 % toward the family) plus **12 % toward the day's wash** — a per-day plaster tone from
{chalk `#E9E2CE`, sand `#D9C69C`, lime `#DCE2CE`, rose-wash `#E4CFC4`, quarry-grey `#C9C6BC`}.
The wash is the single strongest "this is a different town today" signal and costs one lerp.

**Ring drift (archetype harmonisation):** the mix tilts by ring so the town reads as
older-in-the-middle: rings 0–2 favour the neutral primary + more painted trim (civic core);
rings ≥ 5 favour Moss/Ochre and timber trim (outskirts/thatch). Implement as a per-ring weight
multiplier on the three primaries — `w[i] * (1 + RING_TILT[i] * u)` where `u = ring / maxRing`.

**Rare houses (~1.5 %, weighted toward the core):** the *painted lady* — a saturated **wall**
(not just a roof), a contrasting trim, and a bright door. This is the one place saturation is
allowed on a wall. `rareOf(idx)` returns the tag so the tooltip can say **✦ Painted Lady** and the
ticker agent can announce *"No. 214 has been painted plum. Neighbours divided."*

**Landmarks:** keep their own material language (limestone + slate + gold), but `lmRoof(hex, k)`
takes the day's **civic accent** (the deepest primary) instead of the dominant family colour.
Landmarks are the town's institutions; they should agree with the town, not with a model.

**The monument stays gold at every tier, always.** Gold is the only colour in this world that
means "tokens", and it is the reason the altar reads as the subject. Nothing else may be gold
except the scaffold's progress bar (which *is* tokens being spent).

## 2.3 The day seed

**SEAM (shared with the layout/river agent — this must be one integer, in one place).**

```js
// src/renderer/seed.js
export let daySeed = 0;
export const setDaySeed = ms => { const d = new Date(ms);
  daySeed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
export const srand = n => { const x = Math.sin(n * 127.1 + daySeed * 311.7) * 43758.5453;
                            return x - Math.floor(x); };
```

Set from `applyInit`/`applyBuckets` via the existing `dayKey` rollover path — the same event that
already triggers `hardReset()` and a full rebuild, so a new palette costs nothing extra. Seed from
the **local calendar date**, not the range start: with `SelectedRange = last30`, the town should
still repaint each morning rather than being frozen in a month-old palette.
**SEAM (range agent):** the range only changes what is *counted*; it must not change the seed.

## 2.4 buildings.js — the surgery

Delete: `PLASTER`, `TIMBER`, `roofOf`, `wallOf`, `timberOf` (they move to palette.js). Keep and
export `shade`, `mix`, `matFor`, `std` — palette.js uses them.

Signature change, three functions:

```js
buildHouse(tier, paint, seed)      // was (tier, colorHex, seed)
buildFlavor(kind, paint, seed)
buildLandmark(kind, paint, seed)   // paint.civic + paint.gold
```

The bodies barely change — the derivation preamble collapses:

```js
// before
const rv = (Math.round(seededR(seed*1.7)*7)/7 - .5)*.16;
const roof = shade(roofOf(colorHex), rv), wall = wallOf(colorHex, seed);
const wall2 = shade(wall,-.15), trim = timberOf(seed), stone = shade(wall,-.34);
// after
const { roof, wall, wall2, trim, stone, accent } = paint;
```

Then every remaining `shade(colorHex, ±k)` (market crates, tavern sign, scarecrow hat, flags,
pennants, market-hall banner) becomes `accent` or `shade(accent, ±k)`. `lmRoof(colorHex, k)` →
`lmRoof(paint.civic, k)`. The tent's `mix(0xB9AE93, colorHex, .22)` → `mix(0xB9AE93, roof, .22)`.
`buildScaffold().setTint(hex)` stays but is always called with GOLD_HI.

Everything else in buildings.js — the material cache, the static merge, tiers, flavours, windows —
is untouched. The merge and cache are colour-agnostic by construction.

## 2.5 town.js — what dies

| deleted | replaced by |
|---|---|
| `FAMILY_TOKENS`, `FAMILY_SEEDS`, `colorsCfg`, `families`, `famKeyOf`, `famOf` | nothing |
| `rebuildLegend()` + `#legend` element | header identity (§2.6) |
| `familyForBuilding(n)`, `spent` Map | nothing — plots have no owner |
| `F` Map (familyKey → tokens) | a single scalar `Tsum` |
| `dom{key,color,css}`, `updateDominant()` | `dayAccent()` |
| `ctx.dominantColor`, `ctx.dominantCss` | `ctx.accent`, `ctx.accentCss` (day palette) |
| `famShare(key)`, family line in `tipFor` | roof-family + rare tag (§2.7) |
| `e.famKey` on every entity | `e.paint` (kept so bursts can match the house) |
| footer per-family chips | pace + palette chips (§2.6) |

**Bookkeeping becomes model-blind.** `cell` (`"<bucket>|<model>" → absolute tokens`) **must stay
keyed by model** — the DB emits one upsertable row per (bucket, model) and the delta logic depends
on it. Only the *fold* changes:

```js
// applyInit / applyBuckets
for (const r of msg.buckets) {
  const key = r.b + '|' + r.model, prev = cell.get(key) || 0;
  if (r.tok <= prev) continue;
  cell.set(key, r.tok);
  Tsum += r.tok - prev;                       // was: F.set(famKeyOf(r.model), …)
  grew = true;
}
T = Math.max(Tfloor, Tsum); Tfloor = T;
```

`applyOverride()` collapses to `T = Tfloor = TOK_OVERRIDE; Tsum = T;` — no per-family rescale.
`hardReset()` drops `F.clear(); spent.clear(); families.clear(); rebuildLegend()` and gains
`Tsum = 0; initPalette(daySeed)`.

`mountEnt`: `const paint = e.flavor ? paintFlavor(e.flavor, e.idx, e.ring) : paintHouse(e.idx, e.ring)`
— stored on the entity so remount/promote repaints identically and the burst can match the roof.

Particle/floater colours: `famOf(e.famKey).color` → `e.paint.roof` (a burst the colour of the house
that just arrived is *better* than a family colour); `dom.css` in the "+N houses!" floater →
`accentCss`; `ctx.dominantColor` in the milestone fireworks → `ctx.accent`.

## 2.6 Header and footer

**Header** (`index.html`) — the legend was 60 % of it. Replace with the town's identity:

```html
<header>
  <span class="dot"></span><h1>Token Town</h1>
  <span class="dots" id="paletteDots"></span>       <!-- 3 × 9px rounded swatches: today's palette -->
  <span class="townName" id="townName">—</span>     <!-- seeded per day: "Ashenford" -->
  <span class="rangeChip" id="rangeChip">today</span>
  <div class="meta">☀ <b id="sunTxt">—</b> · <b id="clock">—</b></div>
</header>
```

The palette dots are the "weather vane": three silent swatches that change every morning and
quietly explain why the town looks different. The town name gives the day an identity worth
screenshotting. **SEAM (range agent):** `#rangeChip` is your surface — set it from
`msg.rangeLabel` (`'this session'`, `'last 24 h'`, `'last 7 days'`, `'August'`, `'all time'`);
palette.js just reserves the slot and leaves it at `today` if nothing sets it.

**Footer** — family chips out, two better numbers in:

```
[hero total] tokens today · 🏠 431 buildings · 🧍 118 villagers ·
⚡ 1.4M/h · next building [bar] 62% · ✦ next: Sky-Gate Arch at 1.00B [bar] 71% · 290M to go ·
Prosperity VII · grandest: Keep · 🌳 6 breaks · since 08:14
```

- **⚡ pace** — tokens/hour over the last 6 five-minute buckets. New, honest, brag-worthy, and it
  is the number that makes the ticker's "the economy is great today" line true. Computed in the
  existing 500 ms stat tick from `cell` (sum of buckets with `b ≥ now - 30 min`, ×2).
- Hero number is coloured `dayAccent()` instead of the dominant family colour.
- `since <b>08:14</b>` becomes the range's own start label (range agent).

## 2.7 Tooltips

```
House      →  Villa                             #142 of 431 · settled 14:07     Terracotta roof · ring 3
Painted    →  Villa ✦ Painted Lady              #214 of 431 · settled 15:22     Plum walls · the talk of the ring
Flavour    →  Tavern                            #88 of 431 · settled 11:40      Saffron roof · ring 2
Landmark   →  Cathedral 🏛                      unlocked at 100M · 13:02        landmark 6 of 9
Monument   →  The Orbital Reliquary             431M tokens today               next: Observatory at 500M — 71%
Grove      →  break 🌳                          14:20 → 15:00 · 40 min          no tokens burned
```

The monument's first line now names its **tier**, which is the cheapest possible way to make the
escalation legible: hovering the middle tells you what stage of the arc you are in.

## 2.8 Perf & headless notes

- Palette work is pure integer maths at build time; zero per-frame cost, zero new draw calls.
- Material count: 4 roof families × 7 shade steps + 8 plasters × 5 washes + timbers ≈ 80 quantised
  materials — the same order as today's family system. The 8-step quantisation in `matFor` is what
  guarantees this; the ±8 % shade must stay quantised or the cache grows per house.
- Everything colour-related is decided at spawn, so a 1 fps headless shot is unaffected.
- Monument: aura spawn, ceremony phases, tier reveal pops and the counter ease are all wall-clock;
  only flame flicker, coin spin, halo rotation and particle integration are `dt`-paced. A
  `--shot-delay=9000` run at T10 must show: full aura column, beacon, sky ring, lit obelisks and a
  legible ledger.
- Verify with: `npx electron . --shot=<abs>.png --shot-delay=9000 --tokens=1e9 --hour=23`
  (night sun + beacon + colossus), `--tokens=5e6` (mid ladder), `--tokens=3e5` (Waystone, must not
  look like a bug), and a plain-browser demo load (no preload bridge) for the palette.

## 2.9 Order of work (the two halves are independent)

1. `seed.js` + `palette.js` (no renderer changes yet; unit-testable in isolation).
2. `buildings.js` signature swap → town.js `mountEnt`/`placeLandmark` call sites. Town renders in
   free colours; families still computed but unused.
3. Delete the family plumbing (§2.5), header/footer/tooltips (§2.6–2.7).
4. Monument tier tables + new nodes (§1.2–1.3) — visible immediately at every `--tokens=`.
5. Light, aura, ceremony (§1.4–1.7).
6. Plaza growth (§1.8) + camera framing (§1.9) — last, because it touches the road texture and
   npcs cfg, which the layout agent is also editing.
