# Token Town — Monument, Milestones & Building Variety

Design owner: monument / milestone ladder / building variety.
Companion agents own: growth core (how many buildings, plot allocation), NPCs, index.html.
Everything here is written against the current `src/renderer/town.js` vocabulary
(`std/shade/box/pyramid`, `MAT`/`GEO` caches, `burst3d`, `floatText`, `plotPos`, `seededR`).

---

## 0. Module split & contracts

Four files after the refactor. `town.js` stays the conductor; it must not learn what a
cathedral is.

```
renderer/
  town.js         scene, lights, ground, camera, data feed, main loop  (existing, trimmed)
  buildings.js    MAT/GEO/material cache + buildHouse + buildFlavor + buildLandmark
  monument.js     the plaza centerpiece (absorbs the fountain)
  milestones.js   the threshold ladder + celebration scheduling
```

ES modules, relative imports, no new deps. `import * as THREE from './vendor/three.module.js'`
in each — module caching keeps it one instance.

### 0.1 `buildings.js`

Moves the existing primitives out of `town.js` verbatim, then adds to them.

```js
export const MAT, GEO;                     // existing shared caches, unchanged keys
export function std(color, extra);         // existing
export function shade(hex, k);             // existing
export function box(w,h,d,color,extra);    // existing
export function pyramid(w,d,h,color);      // existing
export function matFor(colorHex, kind);    // NEW — cached, see §4.4
export function disposeGroup(g);           // existing, extended to spare cached mats
export function buildHouse(tier, colorHex, seed);          // existing, unchanged behaviour

export const FLAVORS;                      // ['bakery','tavern','market','farm','forge','well']
export function pickFlavor(plotIdx, seed); // deterministic sprinkle → kind | null
export function buildFlavor(kind, colorHex, seed);         // → Group

export const LANDMARKS;                    // { kind: {span, h, label, minTok} }
export function buildLandmark(kind, seed); // → Group
```

**Uniform group contract.** Every builder (`buildHouse`, `buildFlavor`, `buildLandmark`)
returns a `THREE.Group` whose `userData` carries:

```js
{
  hTop,                 // world height of the top, AFTER g.scale — floaters anchor here
  baseScale,            // for the existing popT easing
  winMats: [],          // emissive window materials; town.js's night loop already walks these
  kind,                 // 'house' | 'bakery' | 'cathedral' | …
  label,                // tooltip title, e.g. 'Cathedral'
  span: 1,              // plots consumed (landmarks only ever >1)
  spin: [],             // [{obj, axis:'x'|'y'|'z', rate, phase}] — wall-clock driven
  smoke: [],            // [{p: Vector3(local), every: ms, size}] chimney anchors
  glow: []              // [{mat, day, night}] emissive strengths per day/night
}
```

`town.js` then drives *all* buildings with three type-agnostic loops (one for `winMats`,
one for `spin`, one for `smoke`) and never branches on building kind. Critically, **spin
and smoke are wall-clock**, not `dt`-accumulated:

```js
for (const s of g.userData.spin) s.obj.rotation[s.axis] = s.phase + now * s.rate;
```

so a 3 fps headless screenshot still shows blades at a plausible angle instead of frozen
at zero. (Same reason the stats footer is gated on `performance.now()`.)

### 0.2 `monument.js`

```js
export function initMonument(scene, opts) → Monument

Monument = {
  group,                                  // added to scene at origin
  update(dt, now, ctx),                   // ctx = {day, night, simNow, camera, outerR}
  setTotal(tok),                          // live total; drives the counter (eased)
  setTier(n, {animate = true} = {}),      // 0..9 — milestone module calls this
  applyMilestonesInstantly(tok),          // init path: jump to the right tier, no FX
  celebrate(milestone),                   // the 2.2 s show (bursts + upgrade pop + shockwave)
  setNext(nextTok, progress01, label),    // feeds the tablet's "NEXT" bar
  getAttractor(),                         // {center: Vector3, r0: 5.6, r1: 10.5, focus: Vector3}
  onCelebrate(cb),                        // NPC agent subscribes → cheer/face the monument
  tier                                    // read-only current tier
}
```

`getAttractor()` is the NPC contract: `center` is world origin, `r0..r1` the annulus NPCs
mill inside, `focus` the point they look at (the coin, ~y 6–11 by tier). `onCelebrate`
fires with `{id, title, tok}` so villagers can throw their arms up.

### 0.3 `milestones.js`

```js
export const LADDER;                        // §2 table, ascending, frozen

export function createMilestones({ monument, onLandmark, onFloater }) → {
  seed(total),        // init: returns {tier, landmarks:[kind]} — fires nothing
  setTotal(total),    // live: queues + fires crossings, calls monument.setTier / celebrate
  next(total),        // {tok, title, progress01}
  reset()             // new day: total went backwards → graceful teardown
}
```

`onLandmark(kind, {instant})` is the growth core's hook: it allocates `span` plots, calls
`buildLandmark(kind, seed)`, places and reveals it. `instant: true` on the `seed()` path
means "already standing, no rise animation, no fireworks".

---

## 1. THE MONUMENT — "The Great Ledger"

Replaces the fountain group entirely, but keeps water (the fountain reads well and the
NPC agent wants a gathering rim). Footprint fits inside `PLAZA_R = 12` with room for the
worship annulus and the 4 existing benches at R ≈ 8.6.

### 1.1 Anatomy (parts, bottom to top)

| part | geometry | y | appears |
|---|---|---|---|
| **Stepped base** | 3 octagonal drums `CylinderGeometry(5.2/4.4/3.6, …, .5, 8)` | 0 → 1.5 | always |
| **Water ring** | annulus `RingGeometry(3.7, 5.0)` laid flat, `MAT.water`, bobbing y like today's fountain | 1.05 | tier ≥ 3 |
| **Stele** | tapered slab `CylinderGeometry(1.05, 1.35, 4.2, 4)` + small pyramid cap, `MAT.stone` | 1.5 → 5.7 | always (shrinks into the drum at tier ≥ 6) |
| **Braziers** | 4 bowls `CylinderGeometry(.42,.28,.36,8)` + flame cone, on the base corners | 1.6 | tier ≥ 1 |
| **The Coin** | `CylinderGeometry(2.6, 2.6, .42, 40)` stood vertical (`rotation.x = π/2`) + a rim ring `TorusGeometry(2.62,.11,6,40)`; both faces carry a canvas glyph | 6.4 (t1) → 11.2 (t9) | tier ≥ 1 |
| **The Tablet** | `PlaneGeometry(11.5, 3.4)` + 4-box stone/gold frame, yaw-billboarded | 8.6 (t0: engraved on the stele instead) | always |
| **Halo rings** | `TorusGeometry(R, .10, 8, 56)`, tilted, counter-rotating | 5–9 | 1 @ t2, 2 @ t4, 3 @ t7, 5 @ t9 |
| **Coin orbit** | 8 mini-coins `CylinderGeometry(.5,.5,.12,16)` orbiting at R 6.6 | 5.4 | tier ≥ 7 |
| **Beacon** | open `CylinderGeometry(1.5, .35, 120, 12, 1, true)` additive, `depthWrite:false`, `fog:false`, `castShadow:false`, scrolling gradient texture | 0 → 120 | faint t5, full t6+ |
| **Sky glyph** | additive ring `TorusGeometry(26, .5, 6, 64)` at y 44, 3°/s | 44 | tier ≥ 9 |
| **Prestige lanterns** | 6 small emissive spheres orbiting at R 14, y 12 | — | +1 ring per prestige (2B/5B/10B) |

Everything except the beacon / sky glyph casts and receives shadows.

### 1.2 The live counter (this is the feature)

**Where.** A `CanvasTexture` on the Tablet plane, `11.5 × 3.4` world units, mounted at
y ≈ 8.6 and **yaw-billboarded** (`tablet.rotation.y = atan2(cam.x - 0, cam.z - 0)`,
recomputed each frame — Y only, so it never tips and still catches the sun). It reads as a
floating obsidian ledger held in a stone/gold frame, not as an HTML sign. The frame is real
geometry, so the billboarding is legible as an object turning to face you.

**Legibility budget (checked).** Camera default `dist = 62`, FOV 46° vertical, stage ≈
1380×780 px. Visible height at the plaza = `2·62·tan(23°) ≈ 52.6` units over 780 px →
**14.8 px per world unit**. The big compact number is drawn at 190/288 of the canvas height
→ ≈ 2.24 world units → **≈ 33 px tall on screen**. Even at the auto-framed far end
(`dist = 260`) it is ≈ 8 px — still a legible shape, and the framing only reaches there on
enormous towns where the beacon is doing the talking anyway.

**Canvas layout** (1024 × 288, redrawn only when the string changes):

```
┌────────────────────────────────────────────────────────┐
│  TOKENS TODAY                                (44px, #C3C2B7, letterSpacing 6) │
│  128.4M                                     (190px bold, gold #F0C86A)        │
│  128 447 902                                (46px, #8E8878, tabular cells)    │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  NEXT 250M           (10px bar, gold; 34px caption)     │
└────────────────────────────────────────────────────────┘
```

- Background `#14120E` with a 3 px gold inner border → dark enough that using the same
  texture as `emissiveMap` makes only the glyphs glow.
- **Tabular digits without relying on font features:** measure `ctx.measureText('0').width`
  once per size, then draw each character centred in its own fixed cell. Zero jitter as
  digits roll, and it works whatever `Segoe UI` does.
- Compact format: `< 1e6` → grouped integer as the *big* line and no second line;
  `1e6 ≤ n < 1e9` → `128.4M`; `≥ 1e9` → `1.284B`. Big line always ≤ 7 glyphs → the font
  size never has to shrink. The exact integer lives on the small line, grouped with thin
  spaces (never commas — narrower and cleaner in cells).
- Progress bar is fed by `setNext()`; at max tier it becomes a solid gold bar reading
  `LEGEND`.

**Update cadence.** `setTotal()` only stores the target. `update()` eases the *displayed*
value toward it on **wall clock** (`disp += (target - disp) * (1 - exp(-Δms / 260))`),
so the number visibly rolls up when tokens land, and a headless run with `--shot-delay=8000`
still lands on the true value. Redraw is gated: at most every 90 ms, and skipped entirely
when the formatted string is unchanged (idle cost = zero).

**Material.**
```js
new THREE.MeshStandardMaterial({
  map: tex, emissive: 0xffffff, emissiveMap: tex,
  emissiveIntensity: .22 + night * 1.15, roughness: .55, metalness: 0
});
tex.colorSpace = THREE.SRGBColorSpace;
tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
```
Lit and grounded by day, self-lit and glowing at night — same `night` value the lamps use.

### 1.3 The Coin (the worship object)

Gold palette used everywhere in this design:

```js
GOLD      = 0xD9A441   // body
GOLD_HI   = 0xF3D07A   // rim / highlights
GOLD_DARK = 0x8A5F1E   // engraved relief
GOLD_EM   = 0xFFB43C   // emissive at night
```
`MeshStandardMaterial({color: GOLD, metalness: .85, roughness: .28, emissive: GOLD_EM,
emissiveIntensity: .05 + night * .45})`.

Faces carry a 256×256 canvas glyph: a milled outer ring of 60 ticks, an inner circle, and
a big `⟠`-ish token mark (drawn as two nested chevrons + a dot — no font dependency), with
`TOKEN · TOWN` set around the rim. Both faces share one texture.

Idle: spins about its own vertical axis at 0.35 rad/s (`dt`-paced is fine — it's decorative,
its *existence* is what a screenshot must prove). Because it stands vertical, the spin
periodically flashes edge-on, which reads unmistakably as a coin. It also bobs
±0.18 units on `sin(now/1600)` and pulses `emissiveIntensity` on `sin(now/1100)`.

### 1.4 Tier ladder of the monument

| tier | unlocked at | what changes |
|---|---|---|
| 0 | 0 | stone base + stele, counter engraved small on the stele face, no coin |
| 1 | 250 k | tablet raises off the stele and starts to float; coin appears (small, r 1.6); braziers lit |
| 2 | 1 M | coin → r 2.2; first halo ring; tablet frame turns gold |
| 3 | 5 M | water ring fills the basin; base gains a second step; coin r 2.6 |
| 4 | 10 M | second halo ring (counter-rotating); braziers gain real flame flicker |
| 5 | 25 M | monument rises: everything above the base lifts +1.6; faint beacon (opacity .06) |
| 6 | 50 M | stele plated in gold; full beacon (opacity .18, scrolling) |
| 7 | 100 M | third halo; the 8-coin orbit appears |
| 8 | 250 M | base becomes a 4-step gold ziggurat; tablet grows to 13 × 3.9 |
| 9 | 1 B | **Ascended**: 5-ring orrery, sky glyph at y 44, beacon opacity .28, everything gold |

Tier transitions animate over 0.65 s with the existing `easeOutBack`: new parts pop from
`scale 0.01`, the lift is a lerp, materials cross-fade by tweening `color`/`metalness`.
`applyMilestonesInstantly()` runs the same code path with `animate:false` — parts are added
at final scale, no bursts, no floaters.

---

## 2. MILESTONES

### 2.1 The ladder

Calibrated to real totals (cache reads included): a light day ≈ 1–5 M, a busy 5-minute
interval ≈ millions, a heavy day 100 M–1 B+. The goal is: **something in the first minute,
something to chase all day.**

| # | tokens | id | title (floater) | monument | landmark unlocked |
|---|---:|---|---|---|---|
| 1 | 250 k | `first_light` | `🔥 First light` | → 1 | — |
| 2 | 1 M | `millionaire` | `🪙 1M tokens!` | → 2 | **Well** (tiny, span 1) |
| 3 | 5 M | `windfall` | `🌾 5M tokens!` | → 3 | **Windmill** (span 2) |
| 4 | 10 M | `market_day` | `🎪 10M tokens!` | → 4 | **Market Hall** (span 3) |
| 5 | 25 M | `bell` | `🔔 25M tokens!` | → 5 | **Bell Tower** (span 2) |
| 6 | 50 M | `arcane` | `🔮 50M tokens!` | → 6 | **Wizard Tower** (span 2) |
| 7 | 100 M | `cathedral` | `🏆 100M tokens!` | → 7 | **Cathedral** (span 3) |
| 8 | 250 M | `gilded` | `🗿 250M tokens!` | → 8 | **Golden Statue** (span 2) |
| 9 | 500 M | `scholar` | `🔭 500M tokens!` | → 8 | **Observatory** (span 3) |
| 10 | 1 B | `skygate` | `🌌 1 BILLION tokens` | → 9 | **Sky-Gate Arch** (span 3) |
| 11+ | 2 B, 5 B, 10 B | `prestige_n` | `✨ Prestige II / III / IV` | +lantern ring | one extra **Golden Statue** (new pose seed) |
| — | every 100 M past 1 B | `tick` | `+100M` | — | — (small burst only) |

Two shapes of event: **major** (rows 1–11: full show + monument tier + landmark) and
**tick** (a 20-particle gold burst at the coin plus a floater — keeps the very long tail
of a 2 B day feeling alive without any new geometry).

### 2.2 Celebration choreography

Reuses `burst3d` + `floatText` unchanged; adds one new primitive, the shockwave ring.

```
t = 0.00  monument.celebrate(m):
            burst3d(coinPos, GOLD_HI, 70, 11)
            shockwave: RingGeometry(1,1.25) flat at y .12, additive, scales 1 → outerR*0.9
                       over 1.1 s, opacity 0.55 → 0 (one shared mesh, pooled)
            floatText(coinPos + y2.4, m.title, '#F3D07A')
            monument.setTier(m.mon)             // parts pop with easeOutBack
t = 0.15  camera nudge: dist *= .965 then springs back over 1.2 s (only if !userDist)
t = 0.20 → 1.60   four fireworks, 350 ms apart, at random points on a circle of
            radius rand(0.45, 0.95) × outerR, y = rand(14, 22):
            burst3d(p, i % 2 ? GOLD_HI : familyColorOfTheMoment, 55, 9)
t = 0.60  onLandmark(kind) → growth core places it; the landmark rises from y = -hTop
            to 0 over 0.9 s with easeOutBack, wrapped in the existing buildScaffold()
            for its first 2.5 s, then a 24-particle dust burst at its base
t = 2.20  done
```

Queueing rules (a single 5-minute burst can cross three thresholds at once):

- crossings fire **in ascending order, 900 ms apart** off a wall-clock queue;
- if more than 3 are pending, collapse: apply every monument tier and every landmark
  instantly, but play **one** show for the highest with the title
  `🏆 100M tokens! (+3 milestones)`;
- `seed()` at init applies *everything* already passed with zero FX — no fireworks spam
  when the app is opened at 4 pm on a 400 M day;
- `reset()` (total dropped, i.e. a new day) fades the extras out over 1.5 s, returns the
  monument to tier 0, and removes landmark groups via `disposeGroup`.

### 2.3 Progress feedback between milestones

The tablet's bottom bar is the whole story: `setNext(tok, progress01, 'NEXT 250M')`.
Progress is **logarithmic between the two neighbouring rungs**
(`log(t/prev) / log(next/prev)`) so it doesn't sit at 4 % for an hour. At 90 % the bar
starts pulsing on `sin(now/400)` — a visible "almost there".

---

## 3. BUILDING VARIETY

### 3.1 Flavor buildings (sprinkled by the growth core)

`pickFlavor(plotIdx, seed)` is deterministic: `seededR(plotIdx * 2.7) < .16 →` pick from a
weighted table, else `null` (a normal house). Roughly 1 in 6 plots. Two extra rules so the
sprinkle looks planned: never two of the same kind adjacent (`plotIdx-1` check), and
`farm` only on ring ≥ 2 (fields belong on the outskirts).

All six use the existing box/pyramid/cone vocabulary and the family colour that plot would
have used, so the streets stay colour-coded by model.

| kind | w | mass | signature | animated |
|---|---|---|---|---|
| **bakery** | 3.0 | box 3.0×2.2×2.6, pyramid roof, **fat brick chimney** (.55 sq, 1.6 tall) offset to the front, striped awning over the door (2 tilted boxes, cream/red), a bread-crate box on the ground | `smoke: [{p:(0.9, 4.6, 0.6), every: 1400}]` |
| **tavern** | 3.6 | wider, lower box 3.6×2.0×3.0 + first-floor jetty overhang (3.9 wide box, +0.2 z), gable roof, **hanging sign** on an L bracket (plane 1.0×0.7, family colour, 1.2 units off the façade) | sign swings `rotation.z = .12·sin(now/900)`; windows `glow: {day:.35, night:1.5}` — a tavern is warm at noon too |
| **market** | 4.2 | no walls: 4 posts + a **striped canvas roof** (procedural 128×128 stripe texture, cached, shared by every stall), 3 crate boxes in family colours, a barrel `CylinderGeometry(.36,.36,.7,10)` | — |
| **windmill** (small) | 2.6 | tapered tower `CylinderGeometry(1.0,1.5,3.6,8)`, cone cap, hub + **4 blades** (`box(.16,3.2,.09)` + sail plane 0.8×2.6) | `spin: [{obj: hub, axis:'z', rate: 4.2e-4}]` |
| **farm** | 5.0 | flat plowed quad (canvas: brown with 9 furrow stripes) + 3 rows of 7 tiny cones **as one InstancedMesh per plot** + a scarecrow (cross of 2 boxes, sack head) + 3 fence posts | scarecrow `rotation.y = .09·sin(now/1300)` |
| **forge** | 3.0 | stone base (`MAT.stone`) + timber upper, squat chimney, an **anvil** (box + wedge) outside, glowing coals: a 0.5×0.5 plane, `MeshBasicMaterial` `GOLD_EM`, `glow: {day:.6, night:1.4}` | `smoke` + a 6-particle spark `burst3d` every ~4 s (see §3.3) |
| **well** | 1.8 | round stone kerb + two posts + a tiny gable roof + bucket on a rope (thin box) | bucket bobs |

Each returns `winMats` so the existing night loop lights it, and `hTop` so floaters and
tooltips land right.

### 3.2 Landmarks

`buildLandmark(kind, seed)`. All are noticeably taller than a Keep (7.1) so they read as
skyline events. Placement rule for the growth core: take the next `span` free plots; **if
fewer than `span` remain in the current ring, skip to the next ring** (never straddle a
ring seam), position at the mean of the claimed plot positions, face the plaza with
`plotFacing`, and mark the skipped plots consumed so houses don't overlap.

| kind | span | hTop | build |
|---|---|---|---|
| **well** | 1 | 2.4 | the flavor well at 1.4× scale, gold coin resting on the kerb |
| **windmill** | 2 | 11.0 | stone tower `Cyl(1.5,2.2,6,8)` + cone cap 2.4×1.6 + hub + 4 blades (`box(.22,4.6,.12)` + sail `Plane(1.1,3.6)` each), lower shed + fence; `spin` on Z at 3.4e-4 |
| **market_hall** | 3 | 8.0 | 8 timber posts on a stone podium, two tilted roof boxes forming a gable, striped awnings down both flanks, 6 stalls with family-coloured crates, a banner pole with a 1.4×2.6 flag plane; 8 lantern `winMats` |
| **bell_tower** | 2 | 15.0 | 4 stacked, slightly tapering stone boxes; belfry = 4 corner posts + 4 arch headers; bronze bell `Cyl(.9,.55,1.2,10)` metalness .8; pyramid roof + gold weathervane. Bell sways `rotation.z = .10·sin(now/700)`; the vane spins slowly |
| **wizard_tower** | 2 | 18.0 | 4 cylinders stacked, each offset ~0.25 and rotated, tapering 2.0→1.1; conical roof with a **spiral stripe canvas**; orb `Sphere(.8)` emissive `#9085E9`; one `PointLight(0x9085E9, night*16, 20)` — the only extra light any landmark is allowed; floating rune ring (`Torus(1.6,.06)`) spinning on Y |
| **cathedral** | 3 | 20.0 | nave box 8×5×5 + apse cone, two front towers 2.2 sq × 12 with 4.5 spires, 6 thin tilted buttress boxes, **rose window** `CircleGeometry(1.4,20)` with a stained-glass canvas (family-coloured wedges), 8 tall arched window planes; gold finial. `glow: {day:.25, night:1.8}` on the glass |
| **golden_statue** | 2 | 12.0 | 3-step plinth + a stylised villager in the **NPC vocabulary** (capsule body, sphere head, box arms) in gold metal, arms raised holding a coin (the monument coin geometry at 0.55×). The held coin spins — visually rhymes with the plaza |
| **observatory** | 3 | 14.0 | drum `Cyl(4,4.2,5,16)` + hemisphere dome (`SphereGeometry(4.1, 20, 10, 0, 2π, 0, π/2)`) with a slit box cut visually by a dark inset; a telescope box poking out at 35°; two wings with book-stack windows. `spin` on the dome, Y, 6e-5 (a slow, deliberate turn) |
| **skygate** | 3 | 26.0 | two tapered pylons 2.6 sq × 18 + an arch (`TorusGeometry(5.5,.9,8,24, π)`) spanning them, gold runes as small emissive boxes up the pylons, and a **portal plane** inside the arch: `PlaneGeometry(9,14)`, additive, a scrolling nebula canvas (`map.offset.y = now * 4e-5`), opacity .35. The town's "you did it" object — visible from the far framing distance |

Tooltips: `userData.label` + `userData.unlockedAt` so hover reads
`Cathedral · unlocked at 100M tokens`. Landmarks go in `hitTargets` like houses.

### 3.3 Smoke & sparks

A second small `Points` pool next to `parts`, because `PointsMaterial.size` is global and
smoke wants to be big, slow and gravity-free:

```js
const MAXPUFF = 96;
// material: size .9, color 0xB9B4A8, opacity .42, transparent, depthWrite:false, sizeAttenuation
puff3d(v, n = 1)   // life 2.2–3.4 s, vy +0.55, tiny outward drift + a constant wind (0.25, 0, 0.1)
```
`town.js` walks every mounted group's `userData.smoke` on a **wall-clock** schedule
(`if (now - anchor.last > anchor.every)`), converts the local anchor to world once at mount
time (buildings never move), and calls `puff3d`. 96 particles, one extra draw call, and a
chimney is smoking in the very first screenshot frame. Forge sparks reuse `burst3d` with
`n = 6, spd = 2.2, GOLD_EM`.

---

## 4. Performance notes (300+ buildings)

1. **`matFor(colorHex, kind)` cache.** `buildHouse` currently calls `std()` 4–6 times per
   building — 300 houses = ~1600 unique materials, i.e. 1600 uniform uploads and a lot of
   GC. Quantise the per-building `shade()` jitter to 8 steps and key a `Map` on
   `hex<<3 | roughnessBucket`. Material count collapses to ~60 for the whole town, draw
   calls sort and batch far better, and `disposeGroup` simply skips anything the cache owns.
2. **Freeze static buildings.** After `place()`, set `group.matrixAutoUpdate = false` and
   `group.updateMatrix()`. Only the live-interval buildings, the monument and NPCs need
   per-frame matrix updates.
3. **Shadow budget.** Beyond ring 4, set `castShadow = false` on buildings (keep
   `receiveShadow`). The shadow camera already stretches to fit the town, so distant
   shadows are sub-pixel mush anyway — this roughly halves the shadow pass on a big town.
4. **One light rule.** Only the wizard tower and the existing 6 plaza lamps own
   `PointLight`s. The monument's glow is emissive materials + the beacon, never lights.
5. **Beacon / portal / sky glyph**: `fog:false`, `depthWrite:false`, `castShadow:false`,
   `renderOrder` above the town so they blend cleanly.
6. Flavor farms use one `InstancedMesh` per plot (21 crops, 1 draw call); the forest and
   verge scatter already do the right thing.

---

## 5. Verification plan (headless only)

```powershell
cd <repo>/town
npx electron . --shot=<scratchpad>/mon-day.png   --shot-delay=8000 --hour=13
npx electron . --shot=<scratchpad>/mon-night.png --shot-delay=8000 --hour=23
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

Demo mode must exercise this: add `?tok=` (or a demo total ramp) so a browser/headless run
can be pinned to 1 M / 120 M / 1.4 B and each monument tier screenshotted. Checklist per
shot: counter string correct and sharp; big line ≥ 30 px; tablet facing camera; coin
spinning (edge-on is acceptable, absent is not); tier-appropriate parts present; beacon
visible at night without washing out the sky; at least one chimney smoking.
