# Token Town — Growth Model design

The town stops being a timeline of 5-minute intervals and becomes a **pure function of one
number**: `T`, today's total tokens. Everything visible — building count, ring count, tier
mix, villager count, landmarks, monument scale — derives from `T` (plus a per-family split
of `T` for colour). One number in, a whole township out.

Design goal, stated as a feeling: *the number going up must be visibly, immediately,
repeatedly rewarding*, from a 1M-token afternoon to a 1B-token grind.

---

## 1. The core curve: tokens → buildings

### 1.1 Formula

```js
const TOK_UNIT = 1e6, K = 32, P = 3 / 8;          // 3/8 = 0.375
const townSize  = T => Math.min(1200, Math.floor(K * Math.pow(Math.max(T,0) / TOK_UNIT, P)));
const tokensFor = n => TOK_UNIT * Math.pow(n / K, 1 / P);   // inverse: 1/P = 8/3
const costOf    = n => tokensFor(n) - tokensFor(n - 1);      // price of the nth building
```

`N(T) = 32 · (T / 1M)^(3/8)`, i.e. the *n*th building costs
`c(n) ≈ (8/3)·T(n)/n ∝ n^(5/3)` — a classic incremental-game escalating price. Power law,
not exponential: exponential (`cost = base·g^n`) makes `N ∝ log T`, which flattens into a
dead line by mid-morning. A power law keeps `N` climbing forever, just politely.

Why `p = 3/8`: it is the exponent that satisfies both ends of the calibration brief
simultaneously — a 1M light day must already be a *town* (32 buildings), a 1B monster day
must be a *sprawl* but not a slum (426 buildings). `log(426/32) / log(1000) = 0.375`. It is
also a clean fraction, so the inverse is the exact cube root of the eighth power.

`Math.min(1200, …)` is a pure safety valve for absurd inputs (≈ 24B tokens); it is never
reached in practice and exists so a corrupt DB read cannot try to allocate 100k meshes.

### 1.2 Calibration table

| total tokens | buildings | rings | outer radius | cost of the *next* building | prosperity `L` |
|---|---|---|---|---|---|
| 10k    | 5   | 1  | 18    | 4k    | 0.00 |
| 50k    | 10  | 1  | 18    | 13k   | 0.00 |
| 200k   | 17  | 2  | 28.5  | 30k   | 0.00 |
| **1M**   | **32**  | 2  | 28.5  | 86k   | 0.80 |
| **5M**   | **58**  | 3  | 39    | 228k  | 1.61 |
| **20M**  | **98**  | 4  | 49.5  | 543k  | 2.30 |
| **50M**  | **138** | 5  | 60    | 958k  | 2.76 |
| **100M** | **179** | 6  | 70.5  | 1.5M  | 3.10 |
| **300M** | **271** | 7  | 81    | 2.9M  | 3.65 |
| **1B**   | **426** | 9  | 102   | 6.2M  | 4.25 |
| 3B     | 644 | 11 | 123   | 12.4M | 4.80 |

Milestone building costs: #1 at 97 tokens, #5 at 7k, #10 at 45k, #32 at 1.0M, #100 at 20.9M,
#200 at 132M, #300 at 391M, #426 at 1.00B.

The existing `plotSlot`/`ringCap`/`plotPos` machinery absorbs this untouched: ring caps are
15/24/33/42/51/60/69/78/87 (cumulative 459 through ring 8), so a 1B day fills nine rings at
radius 102 — and `refreshFraming()`'s `clamp(outer*1.55+20, 56, 260)` frames it at distance
178, inside the existing clamp. **No layout constants change.**

### 1.3 The first minute must erupt

This is the single most important property of the curve. At session start the town is empty
and the first Claude response lands 1–5k tokens:

| first response | buildings that appear |
|---|---|
| 1k  | 3 |
| 5k  | 4–5 |
| 50k | 10 |
| 500k| 24 |

So the opening seconds of any session detonate 3–24 buildings in one cascade, not one house.
A single busy 5-minute interval early on (1–3M) takes the town from ~10 to ~45 buildings.
This is exactly the "a huge burst adds MANY buildings" requirement, and it is free — it falls
out of the power law's steep left end.

### 1.4 Anti-stall analysis

Marginal cost rises, so late-day growth slows. Realistic pairings (people at 1B totals are
also burning tokens fast — read the diagonal, not the corners):

| sustained rate | at T=1M | at T=20M | at T=100M | at T=1B |
|---|---|---|---|---|
| 200k / 5 min (light) | 1 bldg / 2.1 min | 13.6 min | 36.9 min | — |
| 1M / 5 min (normal)  | 0.4 min | 2.7 min | 7.4 min | 31 min |
| 5M / 5 min (heavy)   | 0.1 min | 0.5 min | **1.5 min** | **6.2 min** |
| 20M / 5 min (agent swarm) | — | 0.1 min | 0.4 min | **1.6 min** |

Worst realistic case is ~6 minutes between new buildings on a 1B day. That is too long for
the town to look frozen, so the model deliberately layers **four other always-moving reward
channels** so something visible happens at least every ~20–40 s at any `T`:

1. **The next-building scaffold** (§6.3) — a world-space progress meter that fills
   continuously. Never stalls, by construction.
2. **The monument crystal** (§7) — scale/emissive are continuous functions of `log T`, so it
   is *always* growing while tokens flow.
3. **Tier promotions** (§2) — prosperity `L` rises continuously; every 0.25 of `L` promotes a
   wave of existing buildings. Between building #425 and #426 on a 1B day, roughly 20–40
   existing buildings redevelop. Your old fringe becomes downtown: the most emotionally
   satisfying growth signal in the whole design.
4. **Villagers + landmarks** (§2.4, §8) — new souls arrive on a slower cadence, landmarks
   fire at fixed milestones with a full-screen-worthy celebration.

Growth never stalls; only *one* of the five channels ever does, and only late.

---

## 2. What drives tier, size and variety

Interval size no longer exists, so tier comes from three orthogonal inputs: how rich the town
is, where the building stands, and its own luck.

```js
const TIERS = ['Tent','Shack','Cabin','Cottage','House','Villa','Manor','Keep'];  // .tok removed
const prosperity = T => Math.max(0, 1.15 * Math.log10(Math.max(T,1) / 2e5));      // "L"
function tierOf(idx, maxRing, L) {
  const u = (ringOf(idx) + 0.35) / (maxRing + 0.9);        // 0 = plaza, ~0.85 = frontier
  const grandeur = 2.4 * (1 - u) * (1 - u) - 0.9 * u;      // downtown premium, fringe malus
  return clamp(Math.round(L + grandeur + rarity(idx, L)), 0, 7);
}
function rarity(idx, L) {                                   // deterministic per plot
  const r = seededR(idx * 3.13 + 7.7), hi = 0.012 + 0.004 * L;  // big towns roll better
  return r > 1 - hi * .34 ? 3 : r > 1 - hi ? 2 : r > .80 ? 1 : r < .10 ? -1 : 0;
}
```

* **Prosperity `L = 1.15·log₁₀(T / 200k)`** — the town-wide floor. Deliberately logarithmic
  where the building count is a power law: the town gets *wider* fast and *grander* slowly,
  which is what makes 300 buildings read as a city rather than 300 castles.
* **Ring grandeur** — a quadratic downtown premium. `u` is normalised against the *current*
  outer ring, so it re-evaluates as the town grows: today's scruffy edge is tomorrow's
  midtown. This is the redevelopment engine.
* **Rarity roll** — seeded on the plot index so it is stable across recomputes (never a
  flicker). Weighted by `L`: the legendary (+3) and rare (+2) bands widen as the town
  prospers, so a big town sprouts the occasional Keep in the suburbs.

### 2.1 Resulting tier histograms (measured)

```
0.3M  N=20  Tent:3 Shack:2 Cabin:9 Cottage:6
1M    N=32  Tent:13 Shack:4 Cabin:9 Cottage:6
5M    N=58  Tent:3 Shack:17 Cabin:18 Cottage:14 House:6
20M   N=98  Shack:6 Cabin:47 Cottage:25 House:14 Villa:6
100M  N=179 Shack:2 Cabin:18 Cottage:77 House:53 Villa:19 Manor:10
1B    N=426 Cabin:5 Cottage:62 House:200 Villa:101 Manor:41 Keep:17
```

Note 100M → 1B: Cottages 77→62 while Houses 53→200. Existing buildings visibly level up; the
whole skyline lifts. Every histogram has 4–6 tiers in play, so no snapshot is monotonous.

### 2.2 Shape variety within a tier

Each tier gets **3 silhouette variants** chosen by `seededR(idx*1.9)`: e.g. Cottage →
gable / L-plan / dormer; House → townhouse / farmhouse-with-barn / courtyard. Plus the
existing per-seed roof-shade jitter and `0.94–1.07` scale jitter, which stay. 8 tiers × 3
variants = 24 archetypes, enough that a 60-building ring never photocopies, few enough to
instance (§10).

### 2.3 Construction gradient at the frontier

The newest `min(8, ceil(N*0.04))` buildings render **one tier below** their settled tier and
wear scaffolding; ~2.5 s after spawn they promote to their true tier with a puff of dust.
This restores the "town under construction" reading at the edge even on a rich day where the
frontier is already building Villas — and it is what sells "look how fast this is growing".

### 2.4 Landmarks (token milestones)

Landmarks live on a dedicated **civic ring at R = 15.6** (between the plaza edge at 12 and
the first house ring at 18, 10 slots ≈ 9.8 units apart — they fit, and they read as
monumental because they're taller than everything near them and sit inside the road loop).

| threshold | landmark | flavour |
|---|---|---|
| 250k | **Well** | first civic act; a villager idles at it |
| 1M | **Windmill** | animated sails (wall-clock driven) |
| 5M | **Chapel** | its bell rings on every later milestone |
| 20M | **Library** | glowing windows day and night |
| 50M | **Watchtower** | rotating beacon at night |
| 100M | **Cathedral** | tallest building in town, stained glass |
| 250M | **Observatory** | dome tracks the real sun |
| 500M | **Great Forge** | smoke + ember particles |
| 1B | **The Wonder** | gold monolith; unlocks a permanent aurora over the town |
| 2.5B / 5B | **Colossus I / II** | placed at cardinal points on the outskirts |

Each unlock: 60-particle gold burst, a large centred floater (`✦ CATHEDRAL — 100M tokens`),
a chip appended to the footer, a brass ring added to the monument plinth, and the Chapel
bell. Landmarks do **not** consume building plots and are **not** counted in `N`.

---

## 3. Family attribution — keeping the model colours meaningful

Buckets still arrive per model, so keep per-family running totals `F[k]`, `T = ΣF[k]`.
Each building gets exactly one family colour, assigned at spawn by **debt settlement**:

```js
// spent[k] = tokens this family has already "paid" for buildings it owns.
function familyForBuilding(n) {
  let best = null, bestOwed = -Infinity;
  for (const k of families) { const owed = F[k] - (spent[k] || 0); if (owed > bestOwed) { bestOwed = owed; best = k; } }
  spent[best] = (spent[best] || 0) + costOf(n);
  return best;
}
```

Pick the family with the most unspent tokens, charge it `costOf(n)`. Properties:

* **Exact proportional attribution.** The colour histogram of the town converges to each
  family's share of `T` to within one building — hovering "Opus 38%" and counting red roofs
  agree. Largest-remainder, not random, so it never drifts.
* **Deterministic and replayable.** Backfill and live growth run the identical function, so
  a restart reproduces the same town.
* **Robust to absolute/upserted totals.** It only ever reads `F[k]`, never deltas, so a
  bucket that gets revised upward simply gives that family more owed tokens next spawn.
* **Spatially honest.** Because buildings spawn in time order and rings fill outward, the
  inner rings are coloured by the models you used this morning — the "growth rings of a tree"
  reading that replaces the clock face (§6.1).

A late-arriving new family (first Haiku call at 4 pm) immediately has huge unspent debt and
therefore claims the next several buildings — a visible green streak appears exactly where
and when it should.

Rendering: family colour is applied per-instance (`instanceColor`), and each archetype's
geometry bakes wall/roof/trim shading into vertex colours, so one material serves every
family (§10).

---

## 4. Live behaviour: the incremental algorithm

### 4.1 State

```js
const cell = new Map();     // "<bucket>|<model>" → absolute tokens (upsert-proof)
const F = new Map();        // familyKey → tokens
let T = 0, Tfloor = 0;      // total; monotonic guard
let built = 0;              // buildings materialised
const spawnQ = [];          // pending indices, drained on a wall-clock timer
```

### 4.2 On every `buckets` message (every 2 s)

```js
function applyBuckets(msg) {
  for (const r of msg.buckets) {
    const key = r.b + '|' + r.model, prev = cell.get(key) || 0;
    if (r.tok <= prev) continue;                 // upsert re-read, no change
    cell.set(key, r.tok);
    const k = famKeyOf(r.model);
    F.set(k, (F.get(k) || 0) + (r.tok - prev));  // add the delta only
  }
  T = Math.max(Tfloor, [...F.values()].reduce((a, b) => a + b, 0));
  Tfloor = T;                                    // totals only ever go UP
  syncTown();
}
```

`Tfloor` is the "only goes up" guard: a partial DB read, a WAL-locked poll or a truncated
bucket set can never demolish the town. (Corollary: the *only* thing that resets the town is
an explicit new-day / new-session event — see §4.6.)

The datafeed sends only the last two buckets per poll, so the `cell` map naturally
accumulates the whole day and the sum stays exact even though each message is partial.

### 4.3 `syncTown()` — the one reconciliation function

```js
function syncTown() {
  const want = townSize(T);
  for (let n = built + 1; n <= want; n++) spawnQ.push(n);   // queue, don't build inline
  built = Math.max(built, want);
  updateProsperity(T);        // may queue tier promotions (§4.5)
  updateLandmarks(T);         // fires milestone celebrations
  updatePopulation(want);     // villager arrivals/departures
  updateMonument(T);          // crystal scale, digit texture, next-milestone ring
  updateScaffold(T, want);    // progress meter on plot #want+1  (§6.3)
}
```

Everything is idempotent and derived from `T` — call it as often as you like.

### 4.4 Spawn queue and pop-in

Drained on a **wall-clock timer** (`performance.now()`), never `dt`-paced, so a headless
screenshot run still shows a finished town:

```js
const drainRate = q => q > 120 ? q / 1.4 : q > 12 ? 26 : 7;   // buildings per second
```

* **Trickle (1–12 new)** — ~7/s, each with `easeOutBack` pop from `scale 0.01`, an 18-particle
  burst in its family colour, and a floater. Floaters are aggregated so a burst of 5 reads
  `+5 houses!` at the *centroid* rather than five overlapping `+1`s. Every 10th building and
  every tier ≥ 5 spawn gets its own named floater (`⭐ Villa!`).
* **Surge (13–120)** — 26/s, ordered by plot index so it sweeps outward as a wave; particles
  every 3rd building only (particle pool is 600).
* **Backfill / cascade (>120)** — the whole town in **1.4 s** flat regardless of count, still
  animated (this is the delight moment on launch), particles suppressed, floaters replaced by
  a single centred one at the monument: `✦ Township of 426`. Landmarks unlock silently during
  backfill and then all light up together at the end.

Per-frame cap: at most `ceil(rate * dt)` spawns and never more than 40 in one frame, so even
the 1.4 s cascade stays smooth.

### 4.5 Promotion waves

`updateProsperity` recomputes tiers only when `floor(L / 0.25)` changes or `maxRing` changes
(i.e. rarely). Buildings whose tier changed go into a promotion queue drained at ~10/s,
ordered inner-ring-first, each with a 6-particle dust puff and a `0.9→1.0` scale bounce. A
whole-town promotion of 40 buildings therefore plays as a 4-second wave rolling outward from
the plaza. Cheap: a promotion is just moving an instance between archetype pools (§10).

### 4.6 Init / restart / day rollover

* `init` message: fold `msg.buckets` into `cell`/`F`, compute `T`, run the **cascade**
  (§4.4). Landmarks, monument, villagers all appear during the cascade.
* Because attribution is deterministic, a restart mid-day rebuilds the *same* town.
* Day rollover: if an `init` arrives with `sessionStartMs` newer than the current one, or `T`
  computed from a fresh `cell` is < 25 % of `Tfloor`, play a 2 s fade-out ("a new day"), clear
  everything, and cascade the new (tiny) town. This is the only sanctioned reset.

---

## 5. Numbers formatting

`fmtTok` gains a billions branch — the headline number spends most of a heavy day there:

```js
const fmtTok = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M'
                  : n >= 1e3 ? Math.round(n/1e3)+'k' : ''+Math.round(n);
```

---

## 6. Fate of the existing metaphors

### 6.1 The clock face → growth rings

Rings still fill clockwise from noon in *creation* order, so the spatial reading survives —
it just changes name. Inner rings are the morning, the outer edge is right now. Nothing in
`plotPos` changes; the tooltip carries the timestamp (`settled 09:42`) so the information is
still there, and it now means "when this plot was settled" instead of "which interval this
is". Optional flourish: the monument's obelisk acts as a gnomon whose shadow sweeps the
plaza with the real sun — the clock metaphor moves to the centre where it belongs.

### 6.2 Idle "break" trees → parks

Trees no longer consume building plots (plots are earned now; you cannot be *given* one for
doing nothing). Instead, ≥ 10 minutes with no token growth plants a tree on the **verge**
— the bush/rock band at `R = R0 + ring*RGAP + 4.6` — at the angle of the last settled plot,
so the grove sits right where construction paused and reads as "the town rested here". Each
further idle interval thickens the same grove (up to 6 trees) rather than starting a new one;
the grove keeps its `start`/`end` for the tooltip. Long breaks therefore ring the frontier
with woodland, which is pretty rather than punishing. The `break 🌳` legend chip stays.

### 6.3 Scaffolding → the next-building progress meter

The best repurposing in the redesign. Scaffolding no longer wraps a growing house; it stands
alone on plot `N+1` — the plot you are currently *paying for* — with a vertical fill bar
climbing its frame:

```js
const progress = (T - tokensFor(N)) / (tokensFor(N + 1) - tokensFor(N));   // 0..1
```

Always visible, always moving, and it converts abstract token flow into "I can see the next
house arriving". When it hits 1 the scaffold flashes, the building pops in, and the scaffold
teleports to the new `N+1`. Two ghost scaffolds sit on `N+2`/`N+3` at 25 % opacity so the
frontier reads as planned lots. Hovering the scaffold: `next building · 62% · 33k to go`.

### 6.4 Hover tooltips

Three lines now (`#tip` gains a `.t3`):

| target | line 1 | line 2 | line 3 |
|---|---|---|---|
| building | `Villa · Opus` | `#214 of 426 · settled 14:22` | `Opus: 402.1M today (38%)` |
| landmark | `Cathedral 🏛` | `unlocked at 100M · 14:22` | `landmark 6 of 10` |
| grove | `break 🌳` | `10:15 → 10:45 · 30 min` | `no tokens burned` |
| monument | `The Token Altar` | `842.7M tokens today` | `next: The Wonder at 1B — 84%` |
| scaffold | `next building` | `#427 · 62%` | `2.4M tokens to go` |

Everything hoverable answers "what did I do to earn this and how does it fit in the day".

---

## 7. The monument (feature 3) — spec + NPC interface

The fountain is demoted to a ring of four small basins; the plaza centre gets **The Token
Altar**:

* **3-step stone plinth** (r 4.6 → 2.8), with one **brass ring** inlaid per landmark unlocked.
* **Obelisk**, height `9 + 2.4·log₁₀(T/1e6)` clamped to `[9, 20]` — grows all day.
* **Live digits**: a `CanvasTexture` on all four faces showing `fmtTok(T)` in large type,
  redrawn on a **500 ms wall-clock timer** (same discipline as the stats footer, so headless
  screenshots show the real number). Digit colour = the dominant family's colour.
* **Crystal**: a faceted icosahedron floating above, `scale = 0.6 + 0.28·log₁₀(T/1e5)`,
  emissive, slowly rotating, tinted by the dominant family. Continuous growth = the
  never-stalling reward channel.
* **Token pulse**: every time `T` increases, a light ring travels up the obelisk (0.6 s) and
  a few coin-particles spiral into the crystal. At 2 s poll cadence this is a steady
  heartbeat whenever you're working, and visibly stops when you stop.
* **Next-milestone ring**: a glowing arc around the plinth filling toward the next landmark.

Interface published for the villager/NPC layer:

```js
export const MONUMENT = {
  position: new THREE.Vector3(0, 0, 0),
  radius: 5.2,                       // NPCs must not path inside this
  worshipSlots: [ …16 Vector3s at r 7.5… ],  // face-the-altar idle poses
  onPulse: cb => …                   // fires on every token increase → cheer animation
};
export const TOWN = { size: () => built, population: () => popTarget, plotPos, ringOf };
```

Population target (owned here, consumed by the NPC layer):
`pop = clamp(round(0.8 · N^0.85), 3, 120)` → N=32 → 15 souls, N=98 → 34, N=179 → 55,
N=426 → 120 (cap). The cap is a performance number, not a design one; new arrivals get a
floater (`a villager arrives`) and walk in from the road spokes toward the altar.

---

## 8. Stats footer

Rebuilt around the headline number, still on the 500 ms wall-clock timer:

```
[ 842.7M tokens today ]   🏘 271 buildings  ▮Fable 118 ▮Opus 96 ▮Sonnet 44 ▮Haiku 13
🧍 78 villagers   ⛏ next building 62%   ✦ next: The Wonder at 1B — 84%
Prosperity IV · grandest: Keep   🌳 3 breaks   since 08:12
```

* **Total tokens is the hero** — ~22 px, tabular-nums, tinted by the dominant family, with a
  brief flash on every increase. It is the number the user is being invited to grow.
* Per-family chips keep the existing colour-swatch form (they now count buildings *owned*,
  which by §3 equals the family's token share).
* Two progress readouts — next building, next landmark — so there is always a "nearly there".
* `Prosperity I–VII` is `floor(L)+1` in roman numerals: a slow, dignified level-up.
* `— demo data` suffix retained in demo mode.

---

## 9. Demo mode

Synthetic feed must exercise the whole range, and must look impressive in a screenshot:

* **Backfill**: a ~140M-token day across ~90 buckets, four model families with realistic
  shares (Fable 45 %, Opus 30 %, Sonnet 18 %, Haiku 7 %) and two idle gaps → ~200 buildings,
  6 rings, landmarks up to Cathedral, all arriving in the 1.4 s cascade.
* **Live**: every 2.2 s add a heavy-tailed burst — `1e5 + pow(rand,3) * 4e7` — to a random
  family. Most ticks give 1–3 buildings, roughly one tick in fifteen erupts with 15+ and
  crosses a landmark. Screenshots taken at any moment catch particles and floaters.
* **URL calibration knobs** (huge for verification, no visible window needed):
  `?tokens=1e9` forces an exact total, `?tokens=1e9&still=1` freezes it (deterministic
  screenshots for the tier table above), `?demo=slow|fast`, plus the existing `?hour=N`.

---

## 10. Performance plan (300+ buildings at 60 fps)

The current code allocates fresh `BoxGeometry` + `MeshStandardMaterial` per building part —
about 8 draw calls each. At 426 buildings that is ~3,400 draw calls and thousands of live
materials. Non-negotiable to fix, and the growth model is designed to make it easy:

* **24 archetypes** (8 tiers × 3 variants), each pre-merged into **one** `BufferGeometry` at
  startup by concatenating part attributes by hand (no `BufferGeometryUtils` in the vendored
  build — it is ~30 lines to merge position/normal/color/index).
* Part shading is **baked into vertex colours** as multipliers (roof 1.0, wall 0.58, trim
  1.30, door 0.12). three.js multiplies `material.color × instanceColor × vertexColor`, so
  **family colour rides on `instanceColor`** and one shared `MeshStandardMaterial`
  (`vertexColors: true`) serves every family and every tier.
* One `InstancedMesh` per archetype, capacity grown in powers of two (`128 → 256 → …`), with
  a free-list. **A tier promotion = free the instance in pool A, allocate in pool B**; a spawn
  = allocate; both are matrix writes, no allocation. Pop-in animation is a per-instance
  scale, so animating 40 buildings at once costs one `instanceMatrix` upload.
* Windows: a separate instanced quad-strip archetype sharing one emissive material whose
  `emissiveIntensity` is driven by the night factor — the existing per-house `winMats` loop
  disappears entirely.
* **Result: ~24–30 draw calls for the whole town**, plus the existing 5 scenery instances,
  the ground, the sky and the landmarks (which stay as individual groups — there are ≤ 11 and
  they want unique animation).
* Hover: raycasting instanced meshes returns `instanceId`; keep a flat `plots[]` array indexed
  by building index and a `archetype → [buildingIdx]` map to resolve it. Cheaper than the
  current `hitTargets` group list.
* Shadows: bump `sun.shadow.mapSize` to 4096 once `maxRing ≥ 6` (texel goes from 0.125 to
  0.0625 world units at the 1B extent); the existing `refreshFraming` already resizes the
  shadow camera to the town.

---

## 11. Constants summary

```js
const TOK_UNIT = 1e6, K = 32, P = 3/8, N_CAP = 1200;   // growth curve
const L_BASE = 2e5, L_GAIN = 1.15, L_STEP = .25;       // prosperity
const GRAND_A = 2.4, GRAND_B = .9, U_PAD = .35, U_DEN = .9;  // ring grandeur
const RARE_BASE = .012, RARE_GAIN = .004;              // rarity roll
const CIVIC_R = 15.6, CIVIC_SLOTS = 10;                // landmark ring
const POP_K = .8, POP_P = .85, POP_CAP = 120;          // villagers
const IDLE_MS = 10 * 60 * 1000, GROVE_MAX = 6;         // breaks → parks
const CASCADE_MS = 1400, FRONTIER_FRAC = .04;          // spawn pacing
```

## 12. Implementation order

1. `townSize`/`tokensFor`/`costOf` + the `cell`/`F`/`Tfloor` ingest rewrite; delete
   `MIN_HOUSE_TOK`, `TIERS[].tok`, `finalizeInterval`, `addTokens`, `liveSlots`, `cur`.
2. Archetype/instance-pool rendering layer (§10) — do this *before* wiring growth, or the
   first 400-building test tanks the frame rate and hides everything else.
3. `syncTown` + spawn queue + cascade; footer + monument digits on the 500 ms timer.
4. Prosperity/promotion waves, frontier scaffolds, groves.
5. Landmarks, monument, `MONUMENT`/`TOWN` exports for the NPC layer.
6. Demo feed + `?tokens=` calibration knob; screenshot the table's rows to verify.
