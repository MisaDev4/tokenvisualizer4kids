# Token Town — NPC system design

Status: **designed, implemented and visually verified** against the real renderer.
A working module lives at
`%TEMP%\claude\<project>\<session-id>\scratchpad\npcproto\renderer\npcs.js`
and is drop-in: copy it to `town/src/renderer/npcs.js` and apply the integration
diff in §8. Nothing under `town/` was modified — the prototype is an isolated
copy of the whole renderer plus its own Electron shell.

---

## 1. Rendering strategy — InstancedMesh per body part

**Chosen: 6 InstancedMeshes, CPU-composed matrices. Not Group-per-NPC.**

| | Group per NPC | Instanced (chosen) |
|---|---|---|
| draw calls @160 NPCs | ~960–1120 | **6** |
| scene-graph nodes | 1120 | 6 |
| per-frame CPU | 160 `updateMatrixWorld` subtree walks | ~1100 `Matrix4` ops, measured **0.20 ms** |
| per-NPC color | free | `setColorAt`, re-uploaded only on index change |

The town *already* spends ~250–490 draw calls on buildings (each house is a
Group of 6–10 meshes with unique materials). Adding a thousand more would
roughly triple the scene's draw calls and blow the 60 fps budget on a mid GPU.
Instancing is where it matters most, and it costs nothing in expressiveness
because the animation is procedural — there is no skeleton to skin and no
parenting to preserve, so **composing a matrix *is* posing the villager**.

The six meshes:

| mesh | geometry | count | notes |
|---|---|---|---|
| `body` | `Cylinder(.115,.175,.34,7)` translated to y=0 | MAX | smock/robe, 7-sided so it facets in sunlight |
| `head` | `Sphere(.125,10,8)` translated to y=.455 | MAX | |
| `hat` | `Cone(.155,.18,7)`, base at origin | MAX | one geometry, 5 silhouettes via per-NPC scale |
| `arm` | `Capsule(.042,.10,2,5)`, pivot at shoulder | MAX×2 | both arms in one mesh, index `i*2+a` |
| `disc` | `Circle(.20,10)` flat | MAX | fake contact shadow |
| `lamp` | `Sphere(.075,8,6)` basic emissive | 20 | night owls only |

**Key trick:** `body`, `head` and `hat` geometries are *pre-translated* in local
space, so body and head share **one** root matrix — 3 buffer writes, 1 compose.
Only the hat (per-NPC scale), the two arms (swing) and the ground disc
(no bob/roll) need an extra `multiplyMatrices`. Per NPC per frame: 2 composes +
3 multiplies + 2 small composes ≈ 7 matrix ops.

**Two gotchas that will bite anyone re-implementing this:**

1. `im.frustumCulled = false` is **mandatory**. Three derives an InstancedMesh's
   bounding sphere from the *geometry*, not the instance spread, so a 0.6-unit
   sphere at the origin culls the entire population the moment the camera looks
   away from the town centre.
2. `setColorAt()` allocates `instanceColor` sized by the mesh's **current**
   `count`. Allocate all colors while `count` is still the capacity, *then* set
   `count = 0`. Setting `count = 0` first silently allocates a zero-length
   buffer and every villager renders black.

**No real shadows.** At 0.6 units a villager is sub-texel in a 2048² shadow map
that has to cover a 300-unit town — it produces shimmer, not shadow. Each
villager instead gets a translucent contact disc at y=.045 with
`renderOrder = 1` (so it sorts after the town's transparent road overlay), fading
from opacity .28 by day to .10 at night. This is the single biggest "they're
standing on the ground, not floating" cue and costs one draw call.

## 2. Look

~0.62 units tall before per-NPC scale `0.88–1.12` → **0.55–0.70 range**, a
3-head chibi so the head still reads at 60 units. Verified legible at the default
camera (dist 62) and charming close up.

- **Robes** — 12 warm, high-value hues (mustard, terracotta, rose, sage, cream,
  sky, plum, amber, lime, linen, jade, peach). The grass is dark olive
  (`#3f4a29`) and the roads are dun; villagers have to *out-value* the ground,
  not just differ in hue, or they vanish at distance.
- **Skin** — 6 tones, also used for the arms.
- **Hats** — 7 colors × 5 seeded silhouettes from one cone: bareheaded (30%),
  pointed, flat straw (squashed 1.32/0.40), tall stovepipe (0.80/1.75), hair puff.
  Bareheaded is encoded as a zero-scale instance — simpler than a second mesh.
- All variation is `srand(seed)`-derived, so a villager looks the same for its
  whole life.

**Gait** (dt-paced): step phase `ph += speed*5.8*dt`; bob `|sin ph| * .028`;
waddle roll `sin ph * .12` about the *forward* axis; 0.05 rad forward lean; arms
counter-swing ±0.55 rad. Yaw is `angLerp`-smoothed at 9/s toward the travel
direction, wrapped shortest-way so nobody spins 350° at a corner. Idle villagers
breathe.

## 3. Population curve

```js
popForBuildings(b) = b <= 0 ? 3 : max(4, round(160 * (1 - exp(-b / 80))))
```

Slope at the origin is exactly **2 villagers per building**; the exponential
tapers to the cap so the number always moves but never explodes.

| buildings | 0 | 5 | 10 | 25 | 50 | 100 | 200 | 400 |
|---|---|---|---|---|---|---|---|---|
| villagers | 3 | 10 | 19 | 42 | 74 | 114 | 147 | 159 |

Cap **160** (`NPC_CAP`, overridable via `cfg.cap`). An empty town keeps 3
caretakers at the altar so it is never dead. Measured cost at the cap: 0.20 ms
CPU, 6 draw calls.

## 4. Movement on the road network

The road network is already parametric, which is the whole reason path-following
here is cheap and looks intentional: **ring r is the circle of radius
`roadR(r)`; spoke k is the ray at `SPOKE_A0 + k/6·2π`.** A villager's position is
a scalar (angle or distance) plus a lane offset, so walking is one add per frame
and they land exactly on painted road.

Three leg types — `{t:'ring', r, a1}`, `{t:'spoke', k, s1}`, `{t:'walk', x, z}` —
and a router that exploits the polar layout: **every route is at most
ring → spoke → ring → doorstep.**

```
routeTo(n, x, z):
  both inside plaza      → straight walk
  target inside plaza    → [ring to nearest spoke, spoke inward, walk]
  from inside plaza      → [walk to spoke mouth, spoke outward, ring, walk]
  otherwise              → [ring to target's spoke, spoke, ring, walk]
```

Legs resolve their start state in `beginLeg()` when they *begin*, not when they
are planned — otherwise the third leg of a queued route computes its start angle
from a position the villager has not reached yet and teleports them. (I wrote
that bug first; it is the non-obvious part of the design.)

Lane offset `±0.65` radially keeps two-way traffic from walking a single line;
seeded speeds 0.95–1.45 u/s stop clumping without any collision system —
villager-vs-villager overlap is invisible at this scale and not worth the cost.

Final approach to a building stops 2.4 units in front of the door, along the
building's own facing yaw, so nobody walks through walls.

## 5. Worship — the town's heartbeat

Villagers converge on the monument, stand on a **fixed slot** and perform a rite
in time with a shared chant clock.

- **42 slots** in three arcs at monument radius + 0.8 / +2.3 / +3.7 (10/14/18
  slots), clamped inside the plaza, jittered ±0.25. Slots are handed out
  lowest-first, so a small congregation fills the inner arc and reads as a
  deliberate circle rather than a scatter. Radii are offsets from
  `cfg.monumentR` because the altar is another module and will change size.
- **Steady state 18% of the population** worships (≥2 always), **42% during a
  celebration** — a visible pilgrimage after a token burst.
- **Three rites**, seeded per villager: **bow** (rhythmic 0.62 rad pitch),
  **arms raised to the altar** (arms to −2.35 rad, splayed, swaying), **kneel**
  (root drops 0.17, 0.34 rad pitch, arms lowered).
- All three are driven by `chant = now/2400·2π` with a ±0.6 rad per-villager
  phase offset, so **the crowd bows together but not robotically**. Collective
  rhythm is what sells worship; individually-timed bows read as noise.
- Everyone in `worship`/`cheer` faces the monument via `atan2(MON.x-x, MON.z-z)`.

## 6. Celebrations

`celebrate(pos, { runners, cheerRadius, milestone })`:

- Everyone within `cheerRadius` (default 18) switches to **cheer**: jump
  `|sin(t·7.5)|·0.34`, arms thrown up, 0.1 rad body wobble, for 2.0–3.4 s. The
  cheer start is offset by `distance·18 ms`, so the celebration **ripples
  outward** from the new building.
- Up to `runners` (default 3) strollers within 60 units switch to **run** —
  routed to the site at 2.6× speed, then cheer on arrival.
- Worship target jumps to 42% for 9 s (20 s if `milestone`).

## 7. Night

`ctx.night` (already computed in `tick()` as `1 - day`) drives everything:

- Outdoor population scales by `1 - 0.78·night` → at full dark ~22% remain.
  Verified: 57 villagers by day → 13 at 23:00.
- Surplus villagers are chosen **outermost-first** (the plaza stays busy
  longest), routed to a random building's doorstep and despawned there with a
  0.3 s shrink — they walk home rather than blinking out.
- **Night owls**: up to `min(18, 35% of population)` carry a lantern — an
  instanced emissive sphere at hand height with a subtle flicker. Exactly **two
  shared PointLights** (7 candela × night, distance 11) follow the two carriers
  nearest the camera, re-targeted every 500 ms so they never strobe.
- The contact discs fade at night so nobody drags a hard shadow under moonlight.

## 8. API and integration

```js
// npcs.js
export const NPC_CAP = 160;
export function popForBuildings(buildings) -> number;
export function initNPCs(scene, cfg) -> NPCSystem;

cfg = {
  roadR:        (r) => number,      // town.js roadR — ring road radius
  plazaR:       12,                 // PLAZA_R
  monument:     THREE.Vector3,      // altar centre
  monumentR:    4.9,                // keep-out radius; worship arcs sit outside it
  spokes:       { n: 6, a0: -Math.PI/2 + 0.3 },
  rings:        () => number,       // current outermost ring INDEX (inclusive)
  getBuildings: () => [{ pos: THREE.Vector3, yaw: number }],
  cap:          160
}

NPCSystem = {
  count, worshippers,                       // getters, for the stats footer
  setPopulation(n),                         // idempotent; safe every frame
  setBuildingCount(b),                      // = setPopulation(popForBuildings(b))
  update(dt, now, { night, camera }),       // now = performance.now()
  celebrate(pos, { runners, cheerRadius, milestone }),
  dispose()
}
```

What the module needs from the growth core, in the core's terms:

1. **`getBuildingPositions()`** — I need `{pos, yaw}` per building (yaw for the
   doorstep), so please expose `getBuildings()` rather than bare positions.
   Returning a live array each call is fine; it is only read on spawn/home.
2. **Monument position + radius** — a `Vector3` and a scalar keep-out.
3. **`night`** — already in `tick()`.
4. **Ring count** — the *painted* outermost ring index (`groundRings`), not the
   plot count, or villagers will walk ring roads that were never drawn.
5. **`SPOKE_N` / `SPOKE_A0` must be hoisted out of `makeRoadTexture`.** Today the
   spoke angle `-π/2 + i/6·2π + .3` is an inline literal inside the texture
   painter. If the NPC network and the texture disagree by that `.3`, every
   villager walks on grass. This is the one change the core *must* make.

Integration (7 edits, all verified working):

```js
import { initNPCs, popForBuildings, NPC_CAP } from './npcs.js';
const SPOKE_N = 6, SPOKE_A0 = -Math.PI / 2 + .3;        // + use these in makeRoadTexture

const npcs = initNPCs(scene, { roadR, plazaR: PLAZA_R, monument: MONUMENT,
  monumentR: 4.9, spokes: { n: SPOKE_N, a0: SPOKE_A0 },
  rings: () => Math.max(0, groundRings),
  getBuildings: () => plots.filter(p => p.kind === 'house' && p.group)
    .map(p => ({ pos: p.group.position, yaw: p.group.rotation.y })), cap: NPC_CAP });

refreshFraming()  → npcs.setPopulation(popForBuildings(buildingCount));
tick()            → npcs.update(dt, now, { night, camera });
new building      → npcs.celebrate(pos, { runners: 2 });
tier-up/milestone → npcs.celebrate(pos, { milestone: true, runners: 4 });
```

## 9. The headless constraint

Every decision about **existence** is wall-clock:

- `setPopulation` spawns the whole delta **immediately**, no per-second ramp.
- Villagers spawn **already spread over the road network**, never at one point.
- 22% of spawns are placed **directly into a worship slot**, so t=0 already shows
  the rite — the plaza is never empty in a screenshot.
- Role changes are scheduled against `now` timestamps (`n.until`, `n.idleUntil`),
  never accumulated from dt.
- Pop-in scale is `(now - bornAt)/380`, not a dt integration.

Only gait phase and travel distance consume dt. A 3 fps headless run therefore
shows a fully populated, worshipping town whose villagers simply have not walked
very far — which is exactly what the screenshots below show.

## 10. Verification

Rendered offscreen via an isolated Electron shell (`npcproto/`, a full copy of
the renderer + `npcs.js`). No window was ever shown.

| shot | result |
|---|---|
| `day1.png` (35 buildings, auto-framed) | 57 villagers, 12 at the altar, walking the ring roads and spokes |
| `close.png` (dist 26) | silhouettes read as little people: hats, robes, skin tones, one mid-rite with arms raised |
| `night.png` (hour=23) | 13 of 57 outdoors, a lantern-carrier casting a warm pool on the road |
| `cap.png` (pop=160) | dense congregation ringing the altar; **npc update 0.20 ms**, 6 NPC draw calls |
| `celebrate.png` | cheer ripple with arms up, runners converging |
| `final.png` (pop=90) | worship arcs clear of the basin after the `monumentR` change |

All in `…/scratchpad/`. Clean up strays with
`Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`.

## 11. Reconciling with the growth-core and monument designs

Both peer designs publish an NPC-facing contract. Mine already accommodates
them; here is the merge, and the one real conflict.

**Monument `getAttractor()` → wire it in.** `npcs.js` takes an optional
`cfg.attractor: () => ({center, r0, r1, focus})` and prefers it over the static
`monumentR`. Worship arcs are placed at `r0 + {0.8, 2.3, 3.7}`, clamped to
`[r0+0.5, min(r1, PLAZA_R-0.8)]`. With the monument agent's `r0 5.6 / r1 10.5`
the three arcs land at 6.4 / 7.9 / 9.3 — inside their annulus, clear of the
benches at R≈8.6. `focus.y` is consumed too: worshippers now **tilt their heads
up** toward the floating coin, `gaze = -atan2(focus.y - .5, distance)` clamped to
0.5 rad. Standing in a ring staring at the ground would have wasted the coin.

**Monument `onCelebrate` / `onPulse` → two different responses.**

```js
monument.onCelebrate(() => npcs.celebrate(MONUMENT.position,
  { milestone: true, runners: 8, cheerRadius: 999 }));   // whole town cheers
monument.onPulse(() => npcs.pulse());                    // every token increase
```

`onPulse` fires roughly every 2 s while you work — far too often for a full
celebration, so it maps to the new **`pulse()`** method: a 700 ms unison dip
added on top of whatever rite each worshipper is performing (bowers bow deeper,
kneelers sink, arm-raisers stretch higher). The congregation visibly throbs in
time with your token count and visibly goes still when you stop working. This is
the cheapest, strongest version of "the monument is the town's heartbeat" and it
costs one timestamp.

**Conflict: who owns the population curve.** The growth design proposes
`pop = clamp(round(0.8·N^0.85), 3, 120)`; mine is `160·(1-e^(-N/80))`. They
disagree badly at the low end — at 25 buildings growth gives 13 souls, mine
gives 42 — and the brief asks for *~2 per building early*, which only mine
delivers. They also disagree at the top (120 vs 160).

Recommendation: **the NPC layer owns the curve**, growth calls
`npcs.setBuildingCount(n)` and publishes nothing about population. Rationale:
the cap is a rendering-perf number, and only the NPC module knows its measured
cost (0.15–0.20 ms at 160). If the integrator prefers the growth curve, it is a
one-line swap in `popForBuildings` — but please pick one owner, because two
modules computing a population target will fight every frame.

Note also that under the new growth model building counts run into the hundreds,
so my curve saturates by ~N=250. That is intended: past that point the *town*
keeps growing and the crowd stays at a readable density instead of turning the
plaza into soup.

**`TOWN.plotPos` / `ringOf`** — not needed. The NPC layer only wants
`getBuildings() → [{pos, yaw}]` and the outermost *painted* ring index.

## 12. Bug found in the existing `town.js` (unrelated to NPCs, please fix)

**Demo mode is currently broken.** In a plain browser / any run without the
preload bridge, module evaluation reaches the demo `onData({type:'init'…})` call
at line ~728, which calls `applyInit → refreshFraming`, which reads `userDist` —
declared with `let` at line ~738. Result:

```
Uncaught ReferenceError: Cannot access 'userDist' before initialization
```

The renderer never starts. Confirmed by rendering **pristine, unmodified**
`town.js` in the same harness (`pristine.png`). The real app is unaffected because
`window.townAPI` exists there and `applyInit` runs later via IPC — so this only
bites the standalone/browser path the project explicitly wants to keep working.

Fix: hoist `const target = new THREE.Vector3(0,3,0);` and
`let az, pol, dist, idleT, userDist` above the session-state / data-feed section.
That is what the prototype does.

Also add `pulse()` and `attractor` to the §8 API block:

```js
cfg.attractor = () => monument.getAttractor();   // optional; overrides monumentR
npcs.pulse();                                    // 700 ms unison dip of the congregation
```
