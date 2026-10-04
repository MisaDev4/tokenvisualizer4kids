# Fresh-eyes QA sweep

A read-only pass over the whole app after ~20 changes landed in one day, each of which had
only ever been verified in isolation by the agent that built it. 60 renders across token
counts (3e5 · 3e6 · 2e8 · 2e10 · 3.18e10), hours (6 · 13 · 18 · 23), five seeds covering all
five layout archetypes, five cameras, and the weather / season / market / event / range flags,
plus the epoch leak bench.

**Nothing crashed, blanked or threw** at any combination. The findings below are all quality,
not stability. Items are struck through as they are fixed; the list is the working queue.

---

## Confirmed on screen by the integrator

### 1. The town's own portrait is a modern city — FIXED (see git log)
The horizon ghost, the header strip and every almanac card drew a dense row of flat-topped
tower blocks with a needle spire, centred on the **retired Token Altar**. On screen in every
frame at every token count, hour and seed. `chronicle.js`'s silhouette renderer never got the
village pass: `K_ALTAR` still existed and was pushed unconditionally at the town centre;
houses below tier 5 were flat-topped slabs; landmarks drew as spires and **domes**, and there
is no dome anywhere in the village set; then a vertical exaggeration of up to **3.4×** turned
a village into Manhattan.

### 2. Weather and season are chrome-only
`--wx=rain` at 13:00 is pixel-for-pixel a fair day with a greyer grade and a chip that reads
"steady rain". `--wx=snow` is indistinguishable. **`--season=winter` renders a GREENER,
lusher meadow than the August default** — no snow, no bare branches, no frost — and spring is
very nearly the same image. `weather.js` says so itself: the rainbow is *"the first mesh this
module has ever owned, and it is the only one"*. Snow cannot land either — cover accumulates
over four real minutes and only pre-loads when the *rolled* climate is snowy, so a forced snow
day never whitens a roof.

**FIXED** — `99b4e6d`. Eight kinds now, all drawn from the town's own tables (buildHouse's
per-tier apex heights, `LANDMARK_DEFS` in ladder order), no vertical exaggeration at all, and
the tallest thing in the picture is the chapel tower. Two stale-data bugs fell out with it:
the biggest days were drawn one landmark short, twice over, by two different pieces of
arithmetic. The Chronicle Stone came down from 5.46 units to 1.53 and moved off the main
approach in the same pass.

### 3. The copy gate was enforced on the new modules and not on the old chrome
**FIXED** — `b4659db`.
`news.js`, `mayor.js` and `market.js` are clean. `town.js` had seven second-person strings,
three of them pace-pressure, including the zero-token screen telling the user what to do to
make the town grow. `events.js` ships bare imperatives — *"Mind the thatch."*, *"Mind your
hat."* — which are second person with the pronoun left out; `news.js` names that exact
construction as the thing to avoid.

---

## The rest, ranked, worst first

4. **The Village Well is visibly broken** — the first landmark the user earns, at 1M. Roof is
   a tilted slab with an unlit wedge poking through its underside on one post that stops in
   mid-air; the trough is half-sunk into the drum at a wrong angle; no windlass, rope or
   bucket. `buildings.js buildLandmark('well')`.
5. **`--cam=stroll` at the cap puts the lens inside a building** (`--tokens=2e10`). At 2e8 the
   walker's own avatar fills a third of the frame with a carried prop clipping through its
   torso; at 2e10 an arm is detached.
6. **The token counter is a floating black LED billboard**, offset up-and-left so it overlaps
   rooftops rather than sitting over the fountain, roughly three cottages wide. It is the
   loudest object in the app. (The user did ask for the count *above* the fountain — the brief
   is right, the execution is not.)
7. **Woodpiles float in mid-air** beside houses at sill height.
8. **Speech bubbles park on the fountain** in ~25 of 60 shots, hiding the counter, and
   `--shot-ui=0` does not hide them — `body.noui` covers every other overlay but not the
   pooled `.bub` divs. Off-screen speakers clamp to the viewport edge and render half cut off.
9. **"Landmark {order} of nine"** — there are ten. The deed card correctly says 10, so the two
   disagree on screen in the same session. `news.js`.
10. **Stale copy naming the deleted monument**: *"squinting at the monument"* in `events.js`,
    whose other two lines in the same event say "the fountain".
11. **`grandest` names an arbitrary tier-7 house** — the first at the highest tier, so a 33.9B
    all-time town reports "grandest Farmhouse" where a 200M town said "Town House".
12. **The roof palette can roll a town with no earth tone in it** — whole villages of magenta,
    plum and teal. The charter forbids exactly this.
13. **Bridges are railless planks** that float and overshoot both banks. No piers, no parapets.
14. **At the user's real scale the whole town is impostors.** At 2e10 and above — which is what
    their 31.8B all-time produces — essentially every building is a flat box with a saturated
    pyramid roof and no material read at all. **All the house look-dev is invisible at the size
    they actually use.**
15. **Villager population halves with the clock** — 329 at 13:00 vs 148 at 23:00 on the same
    town; 1326 vs 597 at the cap. The footer labels it "villagers", the metric the user was
    told to watch, so a busy day at 11pm reads as emptier than a quiet one at noon.
16. **`windmill` is a house flavour as well as the `mill` landmark**, so three or four
    windmills stand in one village and a 300K hamlet can have one before it earns the mill.
17. **The archetype chip contradicts the tier** — "crossroads market town" over a 20-building
    Prosperity-I hamlet.
18. Small but real: almanac prints "first light 00:00 · busiest hour 00:00"; large cream bokeh
    blobs drift across every frame including clear midday and read as a dirty lens; carried
    props are unattached; honours emoji contradict the charter (🏙 cityscape, 🏰 castle).

## Suspected, not proven

- `--bow=1` produced no visible rainbow in four cameras at hour 18. The pin does set the
  channel and the hour is inside the arming window, so it may simply be off-frame every time.
- Events take far longer than the documented shot delay to become visible, and the Crier's
  shout can disagree with where the event actually is ("Over the rooftops" for a balloon far
  out over open farmland).

## Clean

- No crash, blank or thrown error anywhere in the matrix.
- Epoch leak gate passes.
- Market day works; `--range=all|currentMonth|session` all render and re-found correctly.
- **The fountain itself is good** — octagonal basin, real water, jets, shaft, upper dish. The
  problem is everything standing next to it.
- `mayor.js`, `market.js` and `news.js` copy is clean on the gate.
