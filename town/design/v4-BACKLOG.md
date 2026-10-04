# Token Town v4 — THE BACKLOG

*Showrunner's cut of eight area designs (`v4-{interaction,lifesim,weather,history,progression,
datadepth,lookdev,engine}.md`). This document is the schedule of record: if an idea is not in
§2, it is not in v4. Everything here is written so a fleet of 8–10 agents can start work the
hour the wave opens.*

---

## 1. THE PITCH

**v4 is the wave where the town stops being a screensaver and becomes a place you can look at,
point at, and remember.** Four things define it: **The Picture** — a real photographic pipeline
(exposure, tone curve, bloom, contact shadows, a surface pass) that fixes a measured defect —
today 95.5 % of a noon frame sits in a 100-level band and *not one pixel is brighter than
L=164* — and then makes the grade get richer as the number grows, so the photograph itself is
the progress bar; **The Place** — a proper camera rig, click-a-building → a deed card that says
*"cost 4.24M tokens · paid for by your 14:05–14:10 burst"*, and a 7-shot cinematic tour that
starts itself after four idle minutes; **The People** — a persistent per-epoch roster with
names, homes and trades, and a Town Crier who walks to the plaza and shouts the headline you
just read on the ticker; **The Memory** — a chronicle *derived* from `usage.db` (nothing
load-bearing is stored, so nothing can corrupt), giving you yesterday's town on the horizon
with its lamps lit, a Chronicle Stone with your records engraved on it, and the Overtaking.
Underneath all four sits the engine wave that pays for them — a headless bench, impostor LOD
(5 350 draws → ~300 at the 1200 cap) and a road plate that stops stalling the founding cascade
— plus a seasonal sky, because October should feel like October.

**Deliberately NOT in v4, and why:**

| cut | reason |
|---|---|
| **Drought / scorched weather** ("you walked away, the town dried out") | Negative feedback for *not* spending tokens. The grove metaphor is the app's contract: idle time plants woodland. Quiet is green, never cracked earth. The `resume` rain-after-drought beat dies with it — kill the darling. |
| **The Treasury / cost-as-coin (D3)** | Money is the one number that can make growing the town feel bad. The tracker owns cost; the town owns the story. |
| **Districts per repo (D1)** | Analytics wearing a hat. It is L, it is the largest privacy surface in the fleet, and "a map of your repos" is a dashboard, not a toy. Revisit in v5 with `estate.js` intact. |
| **Ranks, curtain walls, the rare-event subsystem (dragon, circus, eclipse)** | Meta-game sprawl. 25 badges deliver ~80 % of the delight for ~2 % of the geometry. The Charter (buildings that persist into every future town) is v4.1's headline, not v4's. |
| **Street-level stroll (S4)** | L, with real fog/scale/collision risk, and *follow-a-villager* + the tour already deliver "go inside it" at a third of the cost. |
| **SSAO · texture atlas · chunk batching · GPU-native town** | Measured as not-the-bottleneck (18 textures) or replaced by a cheaper win (blob shadows beat SSAO at 2 % of the cost). Do not speculate; the bench decides. |
| **Any nag whatsoever** | No goals, no countdowns, no "X to go" outside the Honours panel, no streak that can break, no notifications, no second-person imperatives. Binding banned-substring list in §6. |

Two standing gates, applied on sight: **anything that risks usage guilt is cut**, and
**anything that misses the bench budget does not merge.**

### 1.1 The rule that makes new files legal

REDESIGN-V3 §13.6's "no new files under `town/`" was a v3.0 single-pass scoping rule and is
**lifted for v4**. The npm ban is permanent. Exactly fourteen new files are granted, each with
a single owner, each `init*()`-shaped, each exporting `reset()` and `dispose()`, and **none of
them importing another** — `town.js` remains the sole mediator:

```
renderer/  camera.js  interact.js  postfx.js  surface.js  grounding.js  lod.js
           weather.js chronicle.js memorial.js almanac.js charter.js  civics.js
           bench.js
main/      chronicle-store.js
```

This is the whole reason the fleet can run 10-wide: eleven of the fourteen have **zero
collision surface**.

---

## 2. THE RANKED BACKLOG

Sizes: **S** ≤ ~120 lines / half a session · **M** ~120–350 · **L** ~350+ or research.
"Acceptance" is what an offscreen `--shot` or a `--bench` run must show. Nothing is done
because an implementer says so.

### 2.1 MUST — v4 is not v4 without these

| id | title | value | size | files | deps | acceptance |
|---|---|---|---|---|---|---|
| **F1** | **The seams** — `town.js` anchor commit + `camera.js` rig extraction | The one edit that lets nine other agents never open `town.js` | **L** | `town.js`, `camera.js`* | — | `--bench-scene=all` within noise of baseline; `--shot --hour=13/19/23` ≤ 0.5 % pixel-diff vs pre-v4 |
| **F2** | **Shell & harness** — `--bench`, forwarded query flags, chronicle IPC + atomic store, `saveShot` IPC, replay of `chronicle`/`depth` | Nothing downstream is verifiable or persistable without it | **L** | `main.js`, `preload.js`, `package.json`, `bench.js`*, `chronicle-store.js`* | — | `npx electron . --bench --bench-scene=all` prints 7 rows in < 90 s, exit 0, **no window, no stray process**; baseline table pasted into this doc |
| **F3** | **`postfx.js`** — HDR target, own tone curve, 2-octave bloom, grade, in-shader vignette, dithering | The single biggest change to what the app looks like | **L** | `postfx.js`* | F1 contract | `lookdev-hist.mjs`: noon p5–p95 span ≥ **130** (from 61), ≥ **1.5 %** above L 220 (from 0.0 %), night ≥ **0.8 %** above L 200 while p50 ≤ 22 |
| **F4** | **`surface.js`** — rim light, base AO, world-space grain, far-value match | Keeps the new 5.7:1 key:fill from turning shadow sides to mud; fixes the town dissolving paler than its own fields | **M** | `surface.js`* (hooks landed by F7) | **ships in the same commit as F3** | Lit vs shaded gable ΔL ≥ 34 at noon (today ~18); outskirts converge to `uLandFar`, not to sky |
| **F5** | **`grounding.js`** — pooled blob contact shadows, elongated along the sun azimuth | Buildings stop being stickers on a tablecloth; free long shadows at golden hour | **M** | `grounding.js`* (call sites landed by F1) | F1 | 1 draw call; every band has a blob; `--hour=19` shot shows directional stretch; matrix sweep ≤ 2 Hz |
| **F6** | **`chronicle.js`** — derived day model + the shared `paintSkyline` painter | Every past day's town is reconstructible from a date; day one is already rich | **M** | `chronicle.js`* | F10 shape | node harness: `dayIndexOf`↔`dateOfDayIndex` over 3 000 days incl. every 2024-27 DST flip; `archetypeOf(s) === buildPlan(s).kind` over 200 seeds |
| **F7** | **`buildings.js` pass** — role/`pk` vertex tags, merge-template cache, `applyTownSurface` + `applyWeatherUniforms` hooks | Unblocks LOD, the surface pass and snow; 6–10× faster cascade mount | **M** | `buildings.js` | — | `--bench-scene=found` mount CPU −6× ; `s1200` shot pixel-identical to baseline |
| **F8** | **`layout.js` pass** — wear becomes a tiling texture, `paintGround` opts, `archetypeOf` export, cobbles | Removes 26 000 `fillRect`s from every repaint — the founding cascade's real stall | **M** | `layout.js` | — | `found`: `paintGroundMs` < 60 total (from est. 250–600), `maxFrameMs` < 90; 8 canonical seeds bit-identical |
| **F9** | **`npcs.js` pass** — NPC LOD (part-drop + third-rate) + the **Person roster** | Headroom for 400 villagers, and the identity layer everything in People depends on | **M** | `npcs.js` | — | `__npcStats()` reports a minted roster; `--seed=N` twice ⇒ identical names; 2 draws saved at far tier |
| **F10** | **`datafeed.js` pass** — `chronicle` + `todayTok` + `today{}` + `limits`/`mix`, protocol v4 | Day-scoped truth (badges, streaks, the ghost race) regardless of the selected range | **M** | `datafeed.js` | — | feed harness: folded local-day totals match a JS `Date` ground truth across 400 days; first build < 150 ms; **a depth failure never suppresses `init`** |
| **E1** | **Impostor LOD + the `town.js` micro-pass** — `lod.js`, `entsMove/entsPop` split, analytic hover pick, instanced trees/lamps/benches, detach-don't-hide | 5 350 draws → ~300 at the cap. This is the headroom every other feature spends | **L** | `lod.js`*, `town.js` | F1, F2, F7 | `s1200` ≤ **300 draws**, ≤ 300 k tris, cpu p50 ≤ **6.0 ms**; `--bench-shot` A/B at medPx 17/20/25 indistinguishable |
| **C1** | **Picking, hover lift, selection ring** | The town becomes touchable: cursor changes, the building wakes up, a gold ring lands under it | **M** | `interact.js`*, `index.html` | F1 | `--select=house:120` shot shows ring + lifted building; ring opacity is wall-clock so a 9 s capture always catches it lit |
| **C2** | **The deed card** — *"cost 4.24M tokens · paid for by your 14:05–14:10 burst"* | The best line in the whole fleet: every rooftop becomes a receipt for a slice of your day | **M** | `interact.js`, `index.html` (`describeEnt`/`paidFor` land in F1) | C1 | `--select=` shot shows title, cost, the `paid for by` row, household, flavour, and two action buttons |
| **P3** | **The Town Crier** — pinned `folk[0]` walks to the camera-facing plaza rim and shouts the live headline with a bell | The screenshot people send to someone | **M** | `npcs.js`, `news.js`, `town.js` | F9, P1, P2 | within 45 s a `.bub.crier` with a gold nameplate sits over a villager inside `plazaR`; the wall-clock walk deadline makes it fire even at 1 fps |
| **H1** | **Chronicle wiring + the storage bridge** | Days start adding up; and **deleting the file loses nothing but a counter and three prefs** | **M** | `chronicle.js`, `chronicle-store.js`, `town.js` anchors | F2, F6 | all four degradation paths (missing/corrupt/newer-`v`/no-bridge) render exactly v3; corrupt file is quarantined with no banner |
| **S1** | **`weather.js` core** — 11 eased channels, seasons, per-day climate, moon phase, the `WX` bus, `grade` | Every day's sky is different and a burst visibly gathers cloud — **with zero new meshes** | **L** | `weather.js`* | F1 | `wx-harness.mjs`: 3 650 seeds, no NaN, season histogram within 8 %; a 1.5/1.7 `paceRatio` square wave produces **zero** regime changes; 1 fps and 120 fps agree within 0.03 at every minute |
| **S2** | **Atmosphere wiring** — 3-stop sky + sun lobe, 38° lens, shadow `normalBias`, moon disc, the weather grade block, the wind clock | Fixes an *inverted* sky gradient (horizon is currently 23 L brighter than zenith) and hands the sails a wind that can change without teleporting | **M** | `town.js` (wave-2 owner) | F3, S1 | `px.mjs` strip y=150→land **monotonically non-increasing**, zenith L 95–115, horizon 150–180; `?wx=storm` dims the sun without a cut |

### 2.2 SHOULD — the difference between good and a poster

| id | title | value | size | files | deps | acceptance |
|---|---|---|---|---|---|---|
| **C3** | Keymap + toast + mode pill + hint strip + `?` sheet | Discoverability without clutter; every toast names its exit key; hints show for 3 launches then never | S | `interact.js`, `index.html` | C1 | `?`-sheet shot; no two overlays visible at once (§6 chrome budget) |
| **C4** | **Cinematic tour + attract mode** | 7 shots, ~51 s, `at()→null` skips; after 4 idle minutes it starts itself — the tray toy sells itself | M | `camera.js`, `interact.js` | F1 | `--cam=tour:2` shot has *arrived* (not mid-ease) with its caption; `prefers-reduced-motion` disables attract |
| **C5** | Follow a villager | Rides a 4 px smudge down to 11 units where the gaits, lanterns, rites and bubbles the app already renders finally exist | M | `npcs.js` (+4 methods), `camera.js`, `interact.js` | C1, F9 | `--cam=follow` shot: subject centred, `tau.az=1.4` lag visible on a corner, pill names them |
| **C6** | Photo mode + postcard PNG | Chrome hides, letterbox, caption baked into the saved file — the only shell change in the area | M | `interact.js`, `main.js`/`preload.js`, `index.html` | C3, F2 | `--cam=photo` shot: bars, caption, no chrome; save writes to `Pictures/Token Town` and **never** during a `--shot` run |
| **C7** | Minimap = compass | Reuses `plan.paintGround` with a minimap affine and `wear:0` — **zero `layout.js` change**; the plan never rotates so −Z is always up | M | `interact.js`, `index.html` | C1, F8 | ≤ 0.5 ms/s; view wedge + altar dot + landmark ticks present in a shot |
| **C8** | Villager hover card | Three lines that are *true*: name, trade + workplace, home + quarter | S | `npcs.js`, `interact.js` | C5, P1 | hover ray at a contact disc yields a card naming a building that exists in `getBuildings()` |
| **P1** | **Homes** | `goHome()` targets *your own house*; dusk reads as a town going to bed | M | `npcs.js` | F9, F1 | `--hour=19`: `homed/roster === 1`, no two non-kin share a doorstep |
| **P2** | **Real names in the ticker** | `{name}` sources the live roster with a per-line dedupe — retroactively upgrades ~40 existing lines | S | `news.js`, `town.js` | F9 | within 9 s a ticker line names a villager that `personAt()` resolves to an embodied actor |
| **P4** | Jobs + daily routine | Villagers stand *outside their workplace* at 10:00 — a destination policy, not new navigation | M | `npcs.js` | P1 | `--hour=10`: `jobbed/roster > .8`, visible clustering at premises |
| **P5** | Gossip engine (`cast()` + `PEOPLE` corpus + 7 slots) | ~1 ambient headline in 4 names a resident you can go and find, with a *real* friend/rival | M | `npcs.js`, `news.js`, `town.js` | P1, P2 | every `{who}` line is `unusable()` with an empty roster — ticker degrades byte-for-byte to today |
| **P6** | The protagonist | One named villager whose fortune integrates `paceRatio` on a 45 s exponential, 5 debounced bands, wardrobe + Crier + hover | M | `npcs.js`, `news.js` | P1 | band change fires at most once per 90 s; `repaintHero` is one `setColorAt` |
| **P7** | Children + dogs | Children called in first at dusk; one instanced dog per ~12 households, asleep on the doorstep at 03:00 | S | `npcs.js` | P4 | +1 draw call total; a dog is visible in a `--hour=3` shot |
| **H2** | **The horizon ghost** | Yesterday's town on the gate bearing, **with its lamps lit after dark** — one billboard, 2 draws | M | `memorial.js`* | H1 | `--hour=23 ?chronicle=demo`: skyline ≈ 30 % of stage width, tallest spire ≈ 45 px, window dots lit |
| **H3** | **The Chronicle Stone** | Records as engraved facts; a gold inlay creeps up **only** inside the last 20 % of a record (`pressure()`), blank-with-a-promise on day one | M | `memorial.js` | H1 | day-one variant reads `the mason waits`; no bar below 0.80; a falling record re-cuts the texture 900 ms after the burst |
| **H4** | Header 14-day skyline strip | Always-on, quiet days drawn as meadow lines — never gaps | S | `almanac.js`*, `index.html` | H1 | must live in the **header** (`town.js` rewrites `#stats` every 500 ms) |
| **H5** | The Almanac card | A day gets a proper full stop at the turnover; typography borrows the founding plate | M | `almanac.js`, `index.html` | H4 | `?almanac=1` shot shows a *finished* card (base CSS is the final state) |
| **H6** | **The Overtaking** | Crossing yesterday's final total once: a stamp, an engraved earliest-overtaking record, and 9 birds lifting off the ghost | S | `town.js`, `news.js`, `memorial.js` | H1 | fires once, only upward, only when `ctx.rangeIsDay`; no symmetric "you fell behind" exists in the codebase |
| **H7** | Streak bunting | Pennants between the plaza lamps; **gained, never lost**, with the one off-switch | S | `memorial.js` | H1 | nothing below `spell.len >= 3`; `setView` may only ever raise the count |
| **B1** | **Badges — 25, 6 secret** | Zero geometry, highest delight-per-line in the fleet; three of them reward *breaks* | M | `charter.js`*, `news.js` | F2 schema | node harness: each badge fires exactly once, `n` climbs, merge is monotonic under shuffled replay |
| **B2** | Award pipeline + cold-open parade | Reuses `fireMilestone`/`drainMilestoneQueue` verbatim; a 9-badge cold open is a parade, capped at 6 + one summary line | M | `town.js` | B1 | 1 Hz wall-clock check; `?chronicle=fake` shot shows a decorated town |
| **B3** | The Honours panel | The **only** surface in the app where an unearned thing may be listed | M | `index.html`, `charter.js`, `town.js` | B1 | `display:none` during `--shot` unless `?ledger=1`; secrets collapse to one locked line |
| **R6** | Tilt-shift | The strongest "this is a toy town" signal in photography, tracking the monument | M | `postfx.js` | F3 | dropped at `quality:'med'`; blur applied *before* the bloom add |
| **R7** | **Prosperity heat** | The grade gets richer as the number grows — *the picture is a progress bar* | S | `postfx.js`, `town.js` (1 line) | F3 | `?tokens=5e6` vs `?tokens=1.2e9` shots differ measurably in saturation/contrast; clamped so a 1B day cannot go neon |
| **R8** | Water fresnel + specular streak | The river stops reading as a paved road; with bloom on, a sunset streak is worth more than any other environs change | S | `environs.js` | F3 | `art-river`-equivalent crop distinguishable from a street |
| **R9** | Night town-glow on the ground | The town lights its own field instead of sitting on black paper | S | `environs.js` | F3 | `--hour=23`: ground luminance falls off with distance from the plat |
| **S3** | **Precipitation + splash** | Rain, snow and gold in **one draw**, kind chosen by where `aRnd` falls in stacked bands so rain→snow is a turnover; ripples go lamp-gold at night | L | `weather.js` | S1, S2 | `?wx=rain` / `?wx=snow` / `?wx=goldrain` settled at 7 s; ≤ 2 draws; volume scales with framing (`uR = clamp(dist*.55, 34, 150)`) |
| **S4** | environs handover | Deletes `stepWeather()`; **one owner for `fog.color`**, at last | M | `environs.js` | S1, S2 | no visual change on a clear day; grep proves a single fog writer |
| **S5** | Settled snow + wet albedo | One `onBeforeCompile` on world-normal.y (buildings are vertex-colour-merged, so per-material tinting is impossible); `startCover` opens a snow day already white | M | `buildings.js`, `environs.js`, `town.js` | S3 | `?wxcover=1` across 3 palettes keeps walls in colour; roads whiten at 0.6× |
| **S6** | Weather copy + NPC weather | Umbrellas, hurry in rain, streets emptying in a downpour, lanterns at noon under a thunderhead, and the Bureau of Weather | M | `news.js`, `npcs.js` | S3 | +1 draw (umbrella pool); no corpus line names a model |
| **D1** | **The Reservoir** | Plan limits already on disk as a water tower + cistern + deep well that **visibly refill ~5×/day** — the highest-frequency reward available anywhere in this data | M | `civics.js`*, `datafeed.js`, `town.js`, `news.js` | F10 | `--limits=none` builds **no tower** (an empty vessel is a lie); `--limit-reset=4000` fires the fill ceremony inside one screenshot |
| **D2** | Mill · Forge · Granary | Three *existing* buildings start working at the cache-read / output / cache-write rates; the honest **214:1** grind stat | S | `buildings.js`, `town.js` | F10 | zero new meshes, 3 float writes in the existing loop; footer stat moves when `--mix=` changes |
| **E2** | Shadow budget | Re-arm on `Δsun > 0.0015 rad` not every 500 ms; near/far 60/280; 1024² in impostor mode | S | `town.js` | E1 | ~1.6 depth passes/s reclaimed in the bench |
| **E3** | Memory audit + leak bench | Memoise the two glow textures and the signpost boards, cap `matCache`, and prove it | S | `town.js`, `buildings.js`, `bench.js` | F2 | `--bench-scene=epochs`: geometries drift ≤ 5 and heap ≤ 8 MB across 20 epoch switches |

### 2.3 COULD — take them if the wave has room

| id | title | size | files | note |
|---|---|---|---|---|
| S7 | Storm deck + lightning as cloud-glow (no bolt geometry) + NPC `startle()` | M | `weather.js`, `index.html`, `npcs.js` | flash is a CSS white-out, never a light spike |
| S8 | Morning mist layer + burn-off | M | `weather.js` | the prettiest frame the app can make |
| S9 | Rainbow incl. the secondary bow | S | `weather.js` | fires 6 s after a daylight milestone — a rainbow *is* a reward |
| **S10** | **Seasonal foliage** | M | `environs.js`, `buildings.js` | **if only one COULD ships, ship this** — cheapest way to make October feel like October |
| C9 | Bookmarks `1`–`5`, `[`/`]` landmark browse, click a ticker headline → fly to its subject | S | `interact.js`, `news.js` | |
| C10 | Street-level stroll | L | `camera.js`, `interact.js` | needs `fogDist ≥ 55`, `EYE = 1.35`, a 12 Hz shadow re-arm. **v5 candidate** |
| P8 | Market day · arrivals · lit windows = occupancy | S/M | `npcs.js`, `news.js`, `town.js` | occupancy needs `winMats` per house — check against E1's shared emissive first |
| B4 | **The Charter** — `buildPlan(seed, opts.extraSites)` + Records Hall / Mint / Almshouse | L | `layout.js`, `buildings.js`, `town.js` | *"once earned, it stands in every future town"* is the strongest single idea in the fleet — and it is **v4.1's headline**, not v4's. Land `extraSites` (S, bit-identical with empty opts) in v4 so v4.1 starts warm |
| D3 | Couriers — one cart per live agent session | M | `npcs.js`, `town.js` | truest picture of how this user actually works |
| D4 | The Shift — the town dresses for a night worker | S | `town.js`, `environs.js` | zero query cost, computed from `init.buckets` |
| R10 | Fake specular for gold (matcap-ish) | S | `surface.js`, `buildings.js`, `monument.js` | with bloom on, a travelling highlight is the difference between gold-coloured and gold |
| E4 | Chunk batching / merge-template widening / GPU-native town | L | new | **only if `--bench-scene=z1200` misses budget.** Do not speculate |
| H8 | Kingdom Map overlay | L | `almanac.js` | wants the strip's interaction and the card's typography to exist first |

---

## 3. THE PARALLEL SCHEDULE

**The two rules that make this collide-proof:**

1. **One owner per existing file per wave.** No exceptions. A new-file author who needs a hook
   in `town.js` / `buildings.js` / `environs.js` writes the hook *as a contract* and that
   file's wave owner lands it.
2. **The null-object rule.** Wave 0 lands **every** call site for every module that does not
   exist yet, against a frozen no-op object. `grounding.place()`, `lod.set()`, `post.render()`,
   `wx.update()`, `interact.update()`, `memorial.setView()`, `estate.districtAt()`,
   `charter.check()` all exist and do nothing from day one. Later waves swap the null object
   for the real one in **one line**.

`index.html` is the documented exception: append-only, one banner-delimited section per task
(`<!-- ═══ v4: interact ═══ -->`), which merges trivially.

### Wave 0 — THE SEAMS (10 agents · gate: F1 must land before wave 1 opens)

| agent | task | files **owned** |
|---|---|---|
| CORE | **F1** anchors + `camera.js` rig | `town.js`, `camera.js`* |
| SHELL | **F2** bench, flags, IPC, store | `main.js`, `preload.js`, `package.json`, `bench.js`*, `chronicle-store.js`* |
| POST | **F3** postfx | `postfx.js`* |
| SURF | **F4** surface | `surface.js`* |
| GRND | **F5** grounding | `grounding.js`* |
| CHRON | **F6** chronicle model + `paintSkyline` | `chronicle.js`* |
| BLD | **F7** buildings pass | `buildings.js` |
| LAY | **F8** layout pass | `layout.js` |
| NPC | **F9** npc LOD + roster | `npcs.js` |
| FEED | **F10** protocol v4 | `datafeed.js` |

Untouched in wave 0: `environs.js`, `news.js`, `monument.js`, `index.html`.
**F3 + F4 must land in the same commit** (L1 alone takes key:fill to 5.7:1 with no rim light —
the intermediate state is worse than today).
**SHELL's first deliverable is the bench baseline**, pasted into `v4-engine.md` §4, before any
other agent claims a perf win.

### Wave 1 — THE PICTURE & THE PLACE (10 agents)

| agent | tasks | files **owned** |
|---|---|---|
| TOWN-1 | **E1** (LOD + micro-pass + furniture) | `town.js`, `lod.js`* |
| UI | **C1 C2 C3** | `interact.js`*, `index.html §interact` |
| CAM | **C4** tour + attract + `focus` mode | `camera.js` |
| WX | **S1** weather core | `weather.js`* |
| MEM | **H2 H3 H7** | `memorial.js`* |
| ALM | **H4 H5** | `almanac.js`*, `index.html §almanac` |
| NPC | **P1 P4** + the crier's npcs half | `npcs.js` |
| NEWS | **P2 P5**(copy) + `headline()` + RECORD/SPELL/CHRON + `deedFlavor`/`villagerFor` | `news.js` |
| ENV | **R8 R9** + `landFar()` getter | `environs.js` |
| CHTR | **B1** badge engine (pure, node-tested) | `charter.js`* |

Lanes NEWS and UI are written *against the contracts in §4 while NPC is still building them* —
every new `npcs` method is specified null-safe and every `{who}` line is gated by news'
existing `unusable()` truth check, so an absent roster degrades the ticker to today's behaviour
byte-for-byte. Nobody blocks.

### Wave 2 — THE SKY & THE MEMORY (9 agents)

| agent | tasks | files **owned** |
|---|---|---|
| TOWN-2 | **S2** atmosphere wiring + **H1** chronicle wiring + **P3** crier relay | `town.js` |
| WX | **S3** precip + splash | `weather.js` |
| ENV | **S4** handover (**owns `environs.js` alone for the window — highest collision risk in v4**) | `environs.js` |
| NPC | **P6 P7** + S6's npcs half | `npcs.js` |
| NEWS | **S6** weather corpus + badge/charter corpus | `news.js` |
| UI | **C5**(interact half) **C6 C7 C8** | `interact.js`, `index.html §interact` |
| POST | **R6 R7** | `postfx.js` |
| BLD | **S5** snow shader + **D2** `spin.k` tags | `buildings.js` |
| CIV | **D1** reservoir | `civics.js`*, `datafeed.js` |

### Wave 3 — PAYOFF & PROOF (8 agents)

| agent | tasks | files **owned** |
|---|---|---|
| TOWN-3 | **B2 H6 E2 E3** + D1/D2 mounts | `town.js` |
| CHTR | **B3** honours panel | `charter.js`, `index.html §ledger` |
| MEM | record celebration + high-fidelity ghost | `memorial.js` |
| WX | **S7 S8 S9** | `weather.js` |
| NPC | **D3 P8** | `npcs.js` |
| LAY | **B4-prep** `buildPlan(seed, {extraSites})`, bit-identical with empty opts | `layout.js` |
| ENV | **S10** seasonal foliage | `environs.js` |
| QA | acceptance suite: every gate in §2, the leak bench, the copy audit | `bench.js`, scratchpad harnesses |

---

## 4. PINNED CONTRACTS (code against these from hour one)

### 4.1 `camera.js`

```js
/** @typedef {'orbit'|'focus'|'follow'|'tour'|'photo'} CamMode */
/** @typedef {{x:number,y:number,z:number,hTop?:number,id?:string}} Anchor */
export function initCamera(camera, cfg);   // cfg: {canvas, stage, sampleHeight, getPlan,
                                           //       getBuildings, resolveFollow, onMode, onShot}
/** rig: read-only  mode, dist, fogDist (≥55 in close modes), focusPoint,
 *       shadowCenter, shadowExtent, moving, dragging, dragPx, userDist
 *  framing (town.js calls): setFrame(bounds, monTop), setIntroBias(distMul, polAdd),
 *       punch(strength?, ms?), snap()
 *  modes  (interact.js calls): orbit({snap}), focus(anchor, opts), follow(handle),
 *       tour(on, shots?), photo(on), bookmark(i), jumpTo(i)
 *  utility: screenToGround(px,py,out), update(wdt, now, ctx), dispose() */
```
`update` takes **`wdt` (clamped wall clock), never the physics `dt`.** Easing law:
`cur + (goal-cur) * (1 - exp(-wdt/tau))`, azimuth along the short arc. `refreshFraming()`
writes only the *orbit* goal, in every mode — leaving a mode is therefore always free.

### 4.2 `postfx.js` / `surface.js` / `grounding.js`

```js
export function initPost(renderer, scene, camera, {quality:'high'|'med'|'off', headless});
//  → { render(now), setSize(w,h), setGrade(g), setQuality(q), quality, enabled, dispose() }
export function gradeFor(day, night, glowK, heat, out);   // PURE. postfx never accumulates.

export const SURF = { uRimCol, uRimK, uBaseAO, uGrainK, uLandFar, uFarK, uFarD };
export function applyTownSurface(m, role='building'|'prop'|'metal');  // idempotent
//  requires m.customProgramCacheKey = () => 'town-surface-' + role

export function initGrounding(scene, {capacity=1400});
//  → { place(slot,x,z,radius,height), clear(slot), clearAll(),
//      update(now, ctx, sunDir), dispose() }
```
**Grade layering, binding:** `weather` multiplies *scene* quantities (sun/hemi/moon intensity,
fog density + one colour lerp, sky uniforms, star opacity, `roadMat`); `postfx` grades the
*image* (exposure, curve, bloom, sat, contrast, vignette, tilt). Neither reads the other.
`town.js`'s single sky-and-light block applies weather first, then calls `post.setGrade(...)`.
**`fog.color` has exactly one writer: `town.js` sets the base, `weather` applies one lerp,
`environs` only reads.**

### 4.3 `interact.js`

```js
export function initInteract(cfg);   // cfg: {stage, canvas, scene, camera, rig, hitTargets,
                                     //       npcs, describe, sources, getPlan, villager,
                                     //       toast?, saveShot?}
//  → { update(now, ctx), afterRender(), select(e), clearSelection(), toast(msg,ms), dispose() }

/** @typedef {Object} Deed
 *  @property {string} title @property {string} [badge] @property {string} sub
 *  @property {Array<[string,string]>} rows        ≤5 label/value pairs
 *  @property {string} [flavor] @property {string[]} [acts]
 *  @property {{x,y,z,hTop}} at @property {boolean} [live] */
```
`town.js` supplies `describe(entity) → Deed` (the widened `tipFor`) and
`paidFor(n) → ?{ms, wMs, tok}` (binary search of `bins`' cumulative sum for where the day's
tokens crossed `tokensFor(n)`).

### 4.4 `npcs.js` additive surface (every method null-safe before the roster exists)

```js
rosterSize() · personAt(id) → ?VillagerView · randomName() → string ('' when empty)
protagonist() → ?VillagerView · cast(kind, out) → boolean       // fills who/who2/job/place/…
crier() → ?{x,y,z,name,text,ready} · announce(text) → boolean · crierSpeaking() → boolean
hitMeshes() → Object3D[] · villagerAt(obj, instanceId) → ?VillagerView
raycast(ray) → ?{handle, dist}   // closed-form ray/sphere over npcs[], NOT InstancedMesh.raycast
track(handle) → ?pose · nearest(p, r) → ?handle · pin(handle) · startle()
heroEvent() → ?ev (consuming) · marketEvent() → ?ev
```
`n.seed` is the stable handle. `getBuildings()` (F1) returns entries carrying
`{pos, yaw, idx, kind, label, flavor, tier}`; landmarks use negative synthetic `idx`.

### 4.5 `news.js` additive surface

```js
headline() → {html, plain, cat}
initNews({ …, nameOf: () => string, cast: (kind, out) => boolean, country: () => lines })
say(v, kind, { text?, ttl?, who?, job? })     // `who` renders a gold nameplate; max ONE live
```
New slots `{who}{who2}{job}{place}{home}{quarter}{fortune}{rel}{best}{spell}{ghost}{days}{was}`
all registered in `NEEDS`, so a line whose fact is missing is skipped by the existing
`unusable()` gate. **With `nameOf`/`cast` absent the ticker is byte-for-byte today's.**

### 4.6 `weather.js`

```js
export const WX = Object.freeze({ uWet, uCover, uGust, uDust, uCloud, uWxT, uWindV, uFlash });
export function initWeather(scene, {daySeed, lat, quality, maxAnisotropy, biome, plazaPos});
//  → { group, ch, grade, id, label, glyph, climate, settled,
//      update(dt, now, ctx)  /* dt IS IGNORED */, event(kind, data),
//      setSeed(daySeed, dateMs, lat, biome), setQuality(q), news(), wetnessAt(x,z), dispose() }
export function seasonOf(dateMs, lat) · climateFor(daySeed, dateMs, lat, biome) · moonPhase(dateMs)
```
Channels ease on the wall clock with a **900 ms snap window** after init and every `setSeed`,
so `--shot-delay=7000` always lands on a settled sky. `daySeed` owns weather; **a range change
must never re-roll the climate.** `REGIMES.drought` / `.scorched` are **removed** (§1).

### 4.7 Persistence — one file, one writer, two disjoint subtrees

`%LOCALAPPDATA%\TokenTracker\town-chronicle.json` (co-located with `usage.db`, so it survives
a reinstall/re-clone; it is a **new** file — the rule "the tracker's `settings.json` is read,
never written" is untouched).

```jsonc
{ "v":1, "app":"token-town", "writtenMs":0,
  "prefs":  { "showStreaks":true, "ghost":true, "strip":true },   // history
  "days":   { "810512": { "seen":1, "overtookMs":… } },           // history — non-derivable only
  "stats":  { "kept":42, "firstSeenMs":… },                       // history
  "totals": { "days":41, "buildings":12044, "milestones":118 },   // progression
  "badges": { "small_hours": { "date":20260703, "at":…, "n":7 } },// progression
  "seen":   { "arch":[…], "roof":[…], "biome":[…] } }             // progression
```
```js
// preload
townAPI.chronicle = { load: () => Promise<doc>, save: patch => void };  // save is fire-and-forget
```
Merge: recurse objects · `Math.max` on `totals.*` and `*.n` · first-write-wins on `*At`/`date`
· set-union (cap 64) on `seen.*` · **no delete API**. Write: debounce 4 s, tmp + `fsync` +
`rename`, quarantine on parse failure, **read-only when `doc.v > 1`**.
**Interlock:** `SYNTHETIC = FORCE_DEMO || TOK_OVERRIDE || SEED_OVERRIDE || HOUR_OVERRIDE ||
isShotRun` ⇒ read-only. A verification screenshot must never award TEN BILLION forever.
**Invariant:** delete the file and the only user-visible change is the `kept` count and three
prefs. Everything else re-derives from `usage.db`.

### 4.8 Feed protocol v4 (all fields optional; a v3 feed leaves every consumer dormant)

```jsonc
{ "type":"init", "v":4, …,
  "todayTok": 412719834,
  "today":     { "date":20260806, "tok":…, "hours":[24], "firstMs":…, "lastMs":…,
                 "peakBucket":…, "breaks":… },
  "chronicle": { "days":[dayIdx,tok, …], "firstMs":…, "builtMs":… },   // quiet days OMITTED
  "depth":     { "mix":{i,o,cr,cw,cw1,rs,msg,sess},
                 "limits":{ "plan":"max","fetchedMs":…,"accounts":3,
                            "rows":[{key:'burst'|'week'|'scoped', pct, sev, resetsAtMs}] },
                 "hidePersonal": false } }
{ "type":"depth", "now":…, "mix":{…}, "limits":{…} }    // 2 s tick, fields omitted when unchanged
```
Never emitted, ever: `AccessToken`, `RefreshToken`, `Email`, account `Id`, `OrgUuid`, any
`source_path`, any `session_id`. The third limit row is currently labelled `"Fable"` — a model
name; the town keys it `scoped` and calls it **"the deep well (the scoped allowance)"**.
A depth/chronicle failure must **never** suppress the `init`.

### 4.9 New test hooks (add to `main.js`'s forwarded list in F2)

`--bench --bench-scene= --bench-frames= --bench-shot=` · `--cam=orbit|tour:N|follow|photo` ·
`--select=house:120|altar|landmark:<id>|villager:0` · `--shot-ui=0` · `--post=off|med|high` ·
`--wx=<regime> --wxi= --wxcover= --season= --moon=` · `--chronicle=demo|fake|off --map=1
--almanac=1 --ledger=1` · `--limits=<a,b,c>|none --limit-reset=<ms> --mix=<cr,cw,o> --hide=1`

---

## 5. RISK REGISTER

| # | risk | why it is likely | guardrail |
|---|---|---|---|
| **1** | **`town.js` merge contention collapses the fleet into a queue.** Every one of the eight area docs edits it; it is 2 158 lines and is the conductor by design. | Ten agents, one file. | **One `town.js` owner per wave, named in §3.** Wave 0's F1 pre-lands *every* call site against null objects and cuts eight banner-delimited regions. Any task that needs a new `town.js` hook mid-wave files it as a contract against the next wave's owner — it does not open the file. |
| **2** | **Perf cliff.** A post pass (+1.4 ms), weather (≤ 6 draws), 220 people, blob shadows, a deed card and a minimap all land in six weeks against a 60 fps @ 1200+160 budget. | Every area sized its own cost in isolation; nobody measured the sum. | **F2 ships first and its output is the baseline.** Every wave ends with `--bench-scene=all`; a regression in `cpuMs.p50` or `draw.calls` past budget blocks the merge. Hard sub-budgets: weather ≤ 6 draws (0 on a clear day, enforced by an explicit `budget()` pass), interaction < 0.9 ms in orbit, lifesim ≤ 0.10 ms + 2 draws, postfx auto-downgrades on a **frame count** (never a wall-clock timer — a `--shot` run sees 300 ms frames and would downgrade itself, silently invalidating every verification image). |
| **3** | **Epoch teardown leaks.** Six new modules each own GPU resources, and the app is a tray toy that runs for days across dozens of epoch switches. | `hardReset` currently knows about the systems that existed when it was written. | Every new module **must** export `reset()` (epoch) and `dispose()` (shutdown); F1 registers all of them in `hardReset` in one list. Enforcement is mechanical: `--bench-scene=epochs` runs 20 epoch switches and **fails the build** if `info.memory.geometries` drifts > 5 or the heap > 8 MB. E3 also memoises the duplicated glow texture and the per-range signpost textures and caps the unbounded `matCache`. |
| **4** | **Persistence corruption / two owners of one file.** Two designers independently specified a `chronicle.js` with different schemas in different directories. | Real collision, found in review. | §4.7 is binding: **one path, one writer (`chronicle-store.js` in main), two disjoint subtrees, monotonic per-leaf merge, no delete API, atomic tmp+fsync+rename, quarantine on parse failure, read-only on a newer `v`.** Plus the `SYNTHETIC` interlock and the invariant that deleting the file loses nothing load-bearing — which removes the entire migration/repair risk class rather than managing it. |
| **5** | **Chrome clutter and usage guilt.** v4 adds a deed card, a minimap, a mode pill, a toast, a hint strip, a key sheet, a weather chip, a skyline strip, an almanac card and an honours panel. Any one of them could start nagging. | Ten surfaces, eight authors, one small window. | **Chrome budget: at most two v4 overlays visible at once** (`#deed` + `#mini`); the pill/toast/keys are mutually exclusive and self-expiring; `body.photo` and `--shot-ui=0` hide all of it. **Copy is reviewed against a banned-substring list** (§6) and rejected on a hit. Structural anti-guilt: quiet days are green meadows, streaks may be gained but never lost, records get a progress bar **only** inside the last 20 % (`pressure()`), comparison fires only upward (the Overtaking has no symmetric event), and drought weather is cut outright. |
| 6 | **Layout instability.** `archetypeOf(seed)` assumes `pickArchetype` is the first consumer of `sub(seed, 0x5f356495)`; `buildPlan(seed, {extraSites})` could silently move plots. | Both are one-line assumptions with silent failure modes. | Harness asserts `archetypeOf(s) === buildPlan(s).kind` over ≥ 200 seeds, and `buildPlan(s)` vs `buildPlan(s, {extraSites: []})` **bit-identical** on the 8 canonical seeds. Weather sectors and district sectors freeze at the epoch; a plot never moves once placed. |
| 7 | **Colour-space re-tune under the post pass.** The sky dome, veil, mote and monument `ShaderMaterial`s write `gl_FragColor` with no `colorspace_fragment` and today bypass output encoding *by accident*. Under an HDR render target they land linear and get encoded once — their on-screen appearance **will** change. | Not a bug; a one-session re-authoring of stops. | Budget it explicitly in wave 0 (POST + the wave-2 sky owner). Acceptance is a pixel measurement (`px.mjs` strip monotonically non-increasing), never a hex value. Also expect additive blends to get *softer* (the shoulder eats them) — plan on raising particle/beacon opacity 20–35 %. |

---

## 6. THE COPY GATE (binding on every string added in v4)

Rejected in review, case-insensitive: `you need` · `only … to go` · `keep going` · `don't stop`
· `almost there` · `so close` · `hurry` · `streak` (as a losable thing) · `you should` ·
`try to` · `come back` · `daily goal` · `challenge` · `earn more` · any second-person
imperative in the first clause · any model name (`Opus`, `Sonnet`, `Haiku`, `Fable`, …) ·
any filesystem path, session id, email or account identifier.

Permitted second person: past tense and description only — *"You were here on a day something
happened."* The Crier and the Almanac talk **about the town**; the Honours panel is the only
surface that may address the user, and only in the past tense.

---

## 7. DEFINITION OF DONE FOR v4

1. `--bench --bench-scene=all` passes every budget in `v4-engine.md` §4, on the same machine,
   against the wave-0 baseline.
2. `lookdev-hist.mjs` passes all nine gates in `v4-lookdev.md` §7.
3. Twelve verification shots exist in the scratchpad and each shows a **finished** state at
   9 s: noon · golden · night · deed · tour · follow · photo · minimap · rain · snow · ghost ·
   crier.
4. `--bench-scene=epochs` shows no leak; `?chronicle=off` and a v3 feed both render exactly v3.
5. Every corpus file passes the §6 grep.
6. The user opens it, watches the number go up, and it feels great. That one is not scriptable —
   ask them.
