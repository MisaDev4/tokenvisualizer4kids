# Token Town v3 — Creative Direction

Connective tissue for the five v3 workstreams (layout · environs · news · range · monument+palette).
This document does not own a file. It owns the **agreements between files**: the vibe, the
opening ritual, the shared contracts, the cross-system delights, the chrome, and the three
moments that have to land. Where it conflicts with a specialist doc on a matter of *tone,
shared data, or who-owns-what*, this wins. Where it conflicts on *how to build your thing*,
you win.

Grounding: I shot the current build at 500M (`scratchpad/v2-day.png`). The user's six notes
are all correct and all visible in that frame — a bullseye of nine perfect rings, a green
pool-table with a hard flat horizon, roofs sorted into a four-colour bar chart, a footer that
is a wall of chips, and a centre that reads as *tidy* rather than *the whole point*.

---

## 1. THE VIBE BIBLE

### 1.1 One sentence

> **A pocket-sized medieval boomtown that takes itself completely seriously, administered by
> a municipal government that files paperwork about your token spend.**

That sentence is the whole joke and the whole warmth. The town is earnest. The *framing* is
deadpan. Nothing in the world winks at the camera; the Gazette does the winking.

### 1.2 Six adjectives (use these words in code review)

| adjective | means | fails when |
|---|---|---|
| **Storybook** | hand-placed feel, chunky readable silhouettes, warm materials | it looks procedural / like a heightmap demo |
| **Handmade** | jitter, wobble, nothing perfectly aligned, no two days alike | grids, bullseyes, perfect symmetry (← today's bug) |
| **Deadpan-municipal** | civic voice, ledgers, plaques, quarterly filings, a Mayor | jokes told by the *world* instead of the *paperwork* |
| **Cozy-monumental** | small houses, absurd centrepiece; scale contrast is the gag | everything big, or everything twee |
| **Seeded, not designed** | today is a *place you found*, not a *layout someone chose* | a recognisable "the algorithm again" fingerprint |
| **Legible over lush** | you can read the town at 300 units in a 1 fps screenshot | fog/bloom/grass that costs you the silhouette |

### 1.3 Reference points

* **Cities: Skylines' Chirper** — the tonal north star for the ticker. Municipal, present
  tense, mildly concerned about drainage.
* **Cookie Clicker's news line** — the escalation curve. Early lines are quaint; at 1B they
  should be quietly unhinged, *in the same civil-servant voice*.
* **Animal Crossing** — palette and roundness. Saturated but never neon; every hue has grey in it.
* **Ghibli countryside (Totoro's hills, not Laputa's spectacle)** — the environs target:
  layered, hazy, subordinate, three depth planes.
* **A municipal seal / an old plat map** — the name plate, the signpost, the tooltip plates,
  the monument's ledger face. Serif, engraved, *official*.
* **NOT Wes Anderson.** Wes Anderson is centred and symmetrical, which is precisely the
  perfect-circle failure the user asked us to kill. Borrow his *labelling* (flat pastel chips,
  deadpan captions, tidy typography) and none of his *composition*.

### 1.4 Where whimsy lives, where legibility wins

**Whimsy zone — go as far as you like.** Ticker copy · speech bubbles · town names and
archetypes · landmark silhouettes · the top half of the monument · NPC behaviour and rituals ·
weather flavour · the cemetery joke.

**Legibility zone — whimsy is banned.** The hero number · the range label · both progress
bars · the 3-line tooltip · the monument's counter face · the road/path network (it must read
as *navigable*, not as decoration) · building silhouettes at framing distance 62–300 · the
error banner.

**Quiet zone — the countryside.** It is a matte, not a subject. Hard rule in §3.5.

### 1.5 The whimsy budget — one signature gag each

More than one signature gag per specialist and the app stops being a place and becomes a bit.
Claim exactly one; everything else you build should be sincere.

| specialist | signature gag |
|---|---|
| layout | the **archetype names** ("riverside market town", "hill terraces", "crossroads") |
| environs | **weather encodes pace**, not randomness (§4.9) |
| news | the **Gazette voice** itself |
| range | the signpost's second board reads the range — *the town knows what window you asked for* |
| monument | the **top of the ladder is absurdly overbuilt** — tier 9 should embarrass tier 8 |

---

## 2. THE DAILY RITUAL — the first 20 seconds

The user opens the town roughly once a day, to a place that has never existed before. That
arrival is the highest-frequency emotional beat in the product and today it does not exist:
the current build hands you a finished bullseye and a floater.

**Design rule: the town must be *found*, then *founded*, then *inhabited* — in that order.**

### 2.1 The script (wall clock from the first `init`)

```
t = 0.00   THE PLAT. Terrain, river, roads, bridges, plaza — drawn. NO buildings, NO
           monument, NO villagers. Camera 1.35× final dist, pol +0.10 (higher, map-like).
           roadMat.opacity = 0.15.  This beat is short but load-bearing: it is the only
           moment the day's SHAPE is visible without houses on top of it.

t = 0.15   THE MASTHEAD. Centre-screen HTML plate fades up over 0.4 s:
                          MILLBROOK-ON-LEDGER
             founded Thursday 6 August · riverside market town · seed 8F3A
           Serif, letter-spaced, day-accent rule above and below. Holds to 3.4 s,
           fades out by 4.2 s. HTML, not geometry — this is the one moment crisp text
           beats a CanvasTexture.

t = 0.90   THE CASCADE. The existing 1.4 s flat cascade, unchanged in mechanism, but
           ordered as a WAVE FROM THE GATE: sort the spawn queue by distance along the
           road network from the town gate (layout supplies `gateOrder(plotIdx)`; falls
           back to plot index, which already spirals). roadMat.opacity ramps 0.15 → 1
           across the same window, so the ground appears to be trodden in by the arrival.

t = 2.30   THE MONUMENT LANDS LAST. It starts at scale 0 and pops to the tier the day
           deserves, animated, at the END of the sweep. Today it is already sitting there
           on frame 0, which spends the punchline before the joke.

t = 2.40   THE CHARTER. Existing choreography, unchanged and correct: shockwave to the
           town edge, gold burst at the coin, `✦ Township of 329` big floater,
           npcs.celebrate(milestone) — the whole population converging on the shrine.

t = 2.60   THE SETTLE. Camera eases from the survey angle down and in to the default
           framing over 2.2 s, easeOutCubic. `dollyBias()` is already the hook; this
           replaces the current 13 % nudge with a real move.

t = 3.00   THE DATELINE. The ticker's first line is ALWAYS the same shape:
             ⬥ MILLBROOK GAZETTE — Thursday edition. Population 157. The river is high.

t = 6.50   THE COMPARISON. Second headline, always this shape:
             ⬥ Yesterday's Ashford burned 412.7M. Today's pace: ahead by 89.2M.
           `prevDayTok` is already in the feed and this is the most motivating single
           fact the app owns. It must appear inside the first ten seconds, every day.

t ≈ 5–8    First speech bubbles. Steady state by 8 s.
```

### 2.2 Constraints on the ritual

* **Everything must be finished and stable by t = 6 s** — a `--shot-delay=9000` run has to
  catch a settled town, not a name plate.
* **`?intro=0` skips the whole ritual** (core-owned URL knob). Specialists screenshotting
  their own layer should use it; the acceptance shots must not.
* The ritual runs on a **true cold open and on a day rollover** — both are "a new place".
  It does *not* run on a range change (§3.3): that is a re-survey, not a founding. A range
  change gets a 0.6 s crossfade and a ticker line, nothing more.
* The masthead is HTML in `#overlay`; it must not be raycastable and must not survive
  `hardReset()` as a stray node.

### 2.3 The name outlives the plate — the signpost

Once the masthead fades, the name must still exist **in the world**, or the day's identity
evaporates in four seconds. A wooden fingerpost stands where the main road meets the outer
ring (the "gate"): two boards, the town name burnt into the upper one, the range on the
lower. It is hover-testable and it is the town's ID card.

```
tooltip:  Millbrook-on-Ledger
          riverside market town · founded 06 Aug · seed 8F3A
          showing: this session — since 08:12
```

This is item #3 in §4 and it is a **must**. It converts a transient overlay into a place.

---

## 3. SHARED CONTRACTS — the parts that must not disagree

Five people are editing five layers of one town. These five agreements are the entire reason
this document exists. Break one and the town looks like five towns.

### 3.1 The seed contract

One seed, one PRNG, one place.

```js
// core, town.js — the single source of "which day is this"
const daySeed = ms => { const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); };
// everyone derives: seededR(SEED * k + offset)  — the EXISTING helper, no new PRNG
```

* `SEED` is published on `ctx.seed` (int) and `ctx.seedHex` (the 4-char tag shown to the user).
* **Nobody calls `Math.random()` for anything persistent.** Layout, palette, town name,
  archetype, weather, landmark flavour, NPC wardrobe distribution — all derive from `SEED`.
  `Math.random()` remains legal only for *ephemeral* particles and gait noise.
* Rationale, non-negotiable: a mid-day reload must rebuild the identical town. The current
  build already guarantees this for buildings; v3 must not lose it.
* **`?seed=N` overrides** (new core URL knob). This is how you screenshot three consecutive
  days for the §6 acceptance test, and how anyone reproduces a bug.

### 3.2 The palette contract — model attribution dies here

Family colours are gone: no `roofOf(familyColor)`, no legend, no per-family footer chips, no
`famShare()` tooltip line. What replaces them is a **seeded day palette** published on `ctx`.

```js
ctx.palette = {
  roofs:  [7 × 0xRRGGBB],   // harmonised; buildings pick by seededR(plotIdx), not by model
  walls:  [3 × 0xRRGGBB],
  trim:    0xRRGGBB,
  accent:  0xRRGGBB,        // the day's signature hue
  accentCss: '#rrggbb',
  ground:  0xRRGGBB,        // grass base tint — environs
  water:   0xRRGGBB,        // river/mill-pond — layout
  sky: { topDay, botDay, topNight, botNight, warm }
};
```

**The zero-cost migration:** `ctx.dominantColor` / `ctx.dominantCss` are **kept as fields and
re-pointed at `palette.accent` / `palette.accentCss`.** I verified the consumers — they are
all in `town.js` (milestone fireworks, scaffold tint, spawn floaters, landmark tint, the hero
number) plus JSDoc-only mentions in `monument.js` and `npcs.js`. So `monument.js` and
`npcs.js` need **zero changes** to inherit the day's colour. Do it this way.

The accent must reach, on the same day: roofs' harmony, the hero number's tint, the masthead
rule, the ticker bullet, the monument beacon (§4.10), the scaffold, and the milestone
fireworks' non-gold half. One hue, seven surfaces — that is what makes a day feel *authored*.

Palette guardrails: every roof hue carries ≥12 % grey; no two adjacent roofs in the `roofs`
array may differ by <25° hue; the darkest roof must still separate from `palette.ground` by
≥0.18 luminance (in the shot, several dark roofs already fight the grass at ring 8).

### 3.3 The range contract

The town follows the tracker's selected range. `datafeed.js` resolves the start itself, polls
`settings.json` by mtime, and re-emits `init` on change; the renderer treats every `init` as
an epoch reset (it already does).

```js
ctx.rangeLabel   // 'this session' | 'the last 4 hours' | 'today' | 'the last 7 days' |
                 // 'this month' | 'all time'
ctx.rangeShort   // 'session' | '4 h' | 'today' | '7 d' | 'month' | 'all'
ctx.rangeStartMs
```

**Every "today" string in the codebase must become the range label.** The complete list, so
nobody misses one:

| file:line | current |
|---|---|
| `town.js:1601` | footer `tokens today` |
| `town.js:1388` | monument tooltip `${fmtTok(T)} tokens today` |
| `town.js:1383` | `famShare()` — **deleted entirely** with family attribution |
| `index.html:71` | `#hint` — `No tokens yet today.` |
| `monument.js:378` | the ledger tablet's engraved `TOKENS TODAY` header |
| `town.js:1612` | footer `since 08:00` → moves into the header range chip |

Two behavioural consequences the range specialist must handle and the others must respect:

1. **Day rollover only applies when the range is day-scoped.** A `last 30 days` town must not
   demolish itself at midnight. Gate the existing `dayKey()` rollover on `rangeShort` being
   `today` / `session`.
2. **The "beat yesterday" rung is day-scoped too.** On a 7-day range it is meaningless —
   suppress `spliceBestRung` and the §4.5 ghost ring, and say so in the ticker once
   (`⬥ Records are kept by the day; you're viewing a week.`).

### 3.4 The event contract — one bus, no direct wires

The ticker, speech bubbles, weather and the river all want to know what just happened. They
must not each grow their own probe into `town.js`'s internals. One call, fired by `town.js`
at the sites that already exist:

```js
news.post(kind, data)   // kind ∈ 'founded' 'built' 'surge' 'promoted' 'milestone' 'landmark'
                        //        'idle' 'resume' 'pace' 'rollover' 'range' 'record'
```

Fire sites, all of which already exist in `town.js`:

| kind | fired at | data |
|---|---|---|
| `founded` | end of cascade | `{name, archetype, n, pop}` |
| `built` | `drainSpawnQueue` trickle | `{n, count, label, tier}` |
| `surge` | `drainSpawnQueue` surge/cascade | `{count, centroid}` |
| `promoted` | `drainPromotionQueue` | `{count, fromTier, toTier}` ← **see §5.2** |
| `milestone` | `fireMilestone` | `{title, tok, lm}` |
| `landmark` | `placeLandmark` | `{kind, label, order}` |
| `idle` / `resume` | `updateGroves` / `applyBuckets` grew | `{minutes}` |
| `pace` | 500 ms stats timer, on band change | `{tokPerMin, vsYesterday}` |
| `record` | `best` rung crosses | `{prevDayTok}` |

The news layer decides what is worth a headline; `town.js` decides what happened. Nothing
else subscribes to `town.js`, and no module imports another (the no-circular-imports rule
from REDESIGN.md §0.1 still stands).

### 3.5 The countryside subordination rule — quantified

The user's note 1 in their words: *"the outside area looks kinda bad — empty; maybe it fades
out."* In the shot it is worse than empty: a flat lit plane with a hard horizon line, brighter
in places than the town, with conifers scattered at a uniform density that reads as noise.

Enforceable limits for the environs specialist:

* **Luminance/saturation ceiling.** Nothing beyond `outerR + 30` may exceed **0.55 relative
  luminance** or **0.35 saturation**. The countryside is always the second-brightest thing
  in frame.
* **The fade band** starts at `outerR × 1.15` and is complete by `outerR × 2.4`, and it must
  be driven by `outerR` so it *grows with the town* — a fixed-radius fade will strangle a
  9-ring town and marooned a 2-ring one.
* **Break the horizon.** At least **60 % of azimuths** must have a silhouette element (hill
  ridge, treeline mass, haze bank) above the flat ground line. The single flat arc in the
  current shot is the largest visual defect in the app.
* **Three depth planes, not one**: near verge (hedgerow/rock, already exists and is
  ring-gated — keep that), mid country (fields, copses, the river's continuation), far
  ridge (silhouette + haze only, no detail, no shadows).
* **Motion is banned out there.** No swaying far trees, no drifting far clouds fast enough to
  catch the eye. Motion in the periphery steals attention from the one place where motion
  means "your number went up".
* **Cost ceiling**: ≤ 8 extra draw calls and ≤ 4 extra materials for the entire countryside.
  It is a backdrop; it does not get to spend the 1200-building budget.

### 3.6 The screenshot-safety rule, restated for the new subsystems

REDESIGN.md invariant 2 still governs everything. Newly at risk in v3:

* The **ticker** must post line 1 off `performance.now()` and must be **fade-swap, not
  scrolling** — a marquee screenshots mid-slide and is unreadable. Hold 7 s, cross-fade 0.4 s,
  milestone lines hold 12 s.
* **Speech bubbles**: at least one must be alive and legible at t = 6 s. Schedule against
  `now`, not against accumulated `dt` or gait phase.
* The **masthead** must be gone by t = 4.2 s so it never occludes the acceptance shot.
* **Weather** transitions on the wall clock; a `--shot` run must land in a settled weather
  state, not a 20 %-through crossfade.
* The **river**'s existence is geometry (fine); only its scroll speed may be `dt`-paced.

---

## 4. CROSS-SYSTEM DELIGHTS — ranked

Each is ≤ 15 lines of real code and each connects **two or more** specialists' layers, which
is the point: these are what make five parallel workstreams read as one product.

### MUST (6)

**1. The day palette on everything · palette × all**
The migration in §3.2. One accent hue reaching roofs, hero number, masthead rule, ticker
bullet, beacon, scaffold, fireworks. After the layout, this is the strongest "new place today"
signal there is, and it costs one `ctx` field re-point.

**2. The Gazette reports what actually happened · all × news**
The `news.post` bus in §3.4, with copy pools keyed by `kind`. The difference between a ticker
that is furniture and a ticker that is alive is entirely whether `⬥ Fourteen houses raised on
Mill Row this hour.` is *true*. It always must be.

**3. The signpost at the gate · layout × news × range**
§2.3. Fingerpost, two boards, name + range, hover for the founding record. Makes the name a
fact about the world rather than a caption.

**4. The Gazette knows the archetype · layout × news**
Copy pools gate on `layout.archetype`. `riverside` unlocks bridge/ferry/flood/mill lines;
`hill` unlocks terrace/quarry/switchback lines; `crossroads` unlocks toll/traffic/inn lines.
Ten archetype-specific lines beat a hundred generic ones — this is what makes the seed feel
like an author rather than a shuffle.

**5. Yesterday's ghost ring · feed × layout × monument × footer**
A faint ring painted on the ground at the radius today's town reaches when it equals
yesterday's total: `plotSlot(plotIndexOf(townSize(prevDayTok) - 1)).r`. You grow toward a line
drawn on your own land. Crossing it fires the existing `best` rung and
`🏅 Beat yesterday!`, and the Gazette gets a `record` headline. ~15 lines: one ring mesh, one
radius computation, wired into machinery that already exists. Suppressed on non-day ranges
(§3.3).

**6. Bridge-watchers · layout × npcs**
An NPC crossing a bridge has a 25 % chance to stop mid-span for 2–4 s, turn to face
downstream, and (10 %) emit a speech bubble. Uses the prototype's existing pause/role
scheduling. This is the screenshot the user will send to someone.

### SHOULD (5)

**7. The Mayor · npcs × news × monument**
Exactly one villager: chain of office (a small gold torus), distinct hat, a fixed patrol
between the monument and the signpost. The **only** NPC whose bubbles use the deadpan
municipal register ("Filing the quarterly."; "The ledger is up-to-date."; "Noted."). Hover:
`The Mayor · has held office for 9 h 14 m`. One instance override + one route + one copy pool.

**8. Bubbles echo the headline · news × npcs**
800 ms after a headline posts, the villager nearest the camera says a 2–4-word civilian
version of it. `⬥ The river is running high.` → `"River's up!"`. Same shared bubble atlas.
Costs one lookup table and makes the ticker feel like it is reporting on people rather than
narrating at them.

**9. Weather encodes pace · environs × feed**
Not random. Clear = normal; **golden haze** = ahead of yesterday; overcast/light rain = idle
> 20 min; wind and blown leaves = a surge just landed. The sky becomes a status readout you
*feel*. It also gives the environs layer a reason to exist beyond decoration, and it is the
environs specialist's one signature gag.

**10. The beacon takes the day's accent · monument × palette**
Gold stays the coin's identity — do not touch it. But the **beacon column, the milestone
shockwave, and the sky glyph** take `palette.accent`, so the night skyline is a different
colour every day. Three material colour assignments.

**11. The river runs at your pace · layout × feed**
Water scroll speed (and a ±6 % width scale) track tokens/min over the last 10 minutes. Idle
goes glassy and still; a surge makes it run. One uniform, updated from the same 500 ms timer
that already drives the footer.

### COULD (4)

**12. The chimney census · buildings × night × feed**
At night, the fraction of houses with lit windows equals the fraction of the range's tokens
spent in the last hour. A dark quarter of town means "you stopped working over there".
Currently every window in the town lights on one shared emissive material — this needs a
second material and a per-house bucket assignment, so it is genuinely a *could*.

**13. The bell answers a milestone · monument × buildings × npcs**
If the Bell Tower is standing when a milestone fires, its bell gets a `sway` amplitude burst
and every NPC within 40 units turns to face the tower for 1.5 s. The town *reacting to itself*
is worth more than another particle burst.

**14. The Cemetery of the Perfect Circle · joke × layout**
A tiny walled plot on the outskirts. Three headstones. Hover:
`Here lies Perfect Circle · 2026–2026 · It was very tidy.` Twelve lines. Ship it — it is
exactly the kind of thing that makes someone show the app to a colleague, and it converts the
v2→v3 change into part of the fiction instead of a silent rewrite.

**15. Lantern-moths on the water · environs × night × layout**
A handful of additive points drifting over the river after dusk. Pure atmosphere; the only
countryside motion I would allow, and only because it is *inside* `outerR`.

---

## 5. THE FEEL-GOOD AUDIT — the three moments

Everything above is in service of exactly three feelings. If a change does not serve one of
them, it is decoration and it should lose to something that does.

### 5.1 "I opened it and it's a *new place*." — once a day, the highest-value beat

| subsystem | contribution |
|---|---|
| layout | a genuinely different silhouette: river or none, gate position, density, archetype |
| palette | a different colour identity — you'd recognise yesterday's town by its roofs |
| news | the masthead, the name, the dateline |
| environs | a different horizon: weather, haze, ridge line |
| core | the empty-plat beat, then the wave from the gate |
| monument | lands last, at the tier the day deserves |

**Failure mode:** two consecutive days look 90 % alike and the ritual becomes a loading screen.
**Guard (acceptance test):** shoot `?seed=` for three consecutive days at the same `?tokens=`.
A person who has not read the code must be able to tell them apart at a glance and describe
each in one phrase. If they can't, the layout and palette variance is too low — and it is
better to over-vary at first and pull back.

### 5.2 "The number went up and I can *see* it." — every two seconds while working

| subsystem | contribution |
|---|---|
| core | buildings pop; the scaffold bar visibly moves |
| npcs | cheer ripple outward, runners sprint in |
| monument | pulse up the stele, counter rolls |
| news | a headline about the thing that just happened |
| environs | **nothing.** The countryside holds still so the town owns the motion. |

**Failure mode — and this is the single most important note in this document.**
`townSize` is a power law: `T = 500M → 329 buildings`, and the *next* building costs ~4 M.
On a heavy day, a genuine 2 M burst therefore produces **no new building at all** — the app's
core reward silently stops paying exactly when the user is working hardest. The scaffold bar
inching is not enough.

**Guard:** when tokens increase but `townSize(T)` does not, the town must get **richer instead
of wider**, and every layer must treat that as a first-class event:

* `updateProsperity` already recomputes tiers and queues promotions — the redevelopment engine
  exists. Make sure it can fire on a sub-plot increase, not only on a `floor(L/.25)` band change.
* `drainPromotionQueue` must fire `news.post('promoted', …)` and `npcs.celebrate(pos, {runners:2})`,
  which today only `drainSpawnQueue` does. A promotion wave currently produces a 6-particle
  dust puff and total silence everywhere else.
* The Gazette needs promotion copy: `⬥ Three cottages on Mill Row rebuilt in stone.`
* The scaffold's `setProgress` must remain the one channel that can never stall (it already is).

### 5.3 "A milestone." — a few times a day

| subsystem | contribution |
|---|---|
| monument | tier pop, shockwave, beacon steps up in the day's accent |
| buildings | the landmark rises through its scaffold; the bell answers (§4.13) |
| npcs | the whole population converges and worships |
| news | an ALL-CAPS banner headline, held 12 s |
| core | camera punch-in, four fireworks, the big floater |
| footer | the next-rung bar resets to near-zero and starts climbing again |

**Failure mode:** it fires while the user is looking at their editor and the entire show is
spent on an empty room.
**Guard — milestones must leave *evidence*, not just a performance.** The landmark stays. The
beacon stays taller. The Gazette keeps a persistent counter the user can find later:
`🏆 4 milestones today` in the footer's zone B, and the last milestone headline is retrievable
by hovering the ticker. Arriving twenty minutes late must still feel like arriving at a party
that happened, not at a room where nothing occurred.

---

## 6. THE CHROME — header and footer, now that the legend is dead

The family legend's death frees the entire centre of the header. That space is the ticker's,
and the trade is a good one.

### 6.1 Header

```
● Millbrook-on-Ledger  riverside market town      ⬥ Fourteen houses raised on Mill Row.        ◷ this session · since 08:12   ☀ 04:36 → 19:23 · 15:34
└seal └── name (h1) ──┘ └── archetype chip ──┘    └────────── THE TICKER (flex:1) ──────────┘  └──── range chip ────────┘   └──── sun/clock ────┘
```

* **The seal** replaces the generic blue dot: a 16 px procedurally drawn sigil from `SEED`
  (three shapes, `palette.accent`). It changes daily and costs one tiny canvas.
* **The name is the `<h1>`.** "Token Town" is the *product*; the header should carry the
  *place*. Also set `document.title` to it (renderer-side, free, and `main.js` stays untouched).
* **The archetype chip** in muted text right after the name — the layout specialist's gag,
  permanently on screen, one word or two.
* **The ticker takes `flex:1`** and is centre-left aligned so short lines don't float. Bullet
  `⬥` in `palette.accentCss`. Fade-swap only (§3.6). Milestone lines get `font-weight:700`,
  the accent colour and a 12 s hold. Hovering the ticker reveals the last five headlines in a
  `#tip`-styled stack — that is where a missed milestone is recovered (§5.3).
* **The range chip earns its pixels.** If the town silently follows a 30-day window, the hero
  number is a lie the user can't detect. `◷ this session · since 08:12`, muted, always visible,
  and it *flashes once* when the range changes.
* Sun times and clock stay exactly as they are; they are cheap and they sell the solar clock.

### 6.2 Footer — three zones, one row where it fits, two when narrow

```
  500.0M  tokens · this session          🏘 329 buildings · 🧍 157 villagers · Prosperity IV      next building ▓▓▓░░░░ 5%
  ▲ 89.2M ahead of yesterday             grandest Keep · 🌳 2 breaks · 🏆 4 milestones            ✦ Sky-Gate Arch at 1.00B ░░ 0% · 500.0M to go
 └────────── ZONE A: the hero ──────────┘└──────────── ZONE B: the town, muted ────────────┘└──── ZONE C: the two reward bars ────┘
```

**Zone A — the hero.** Keeps its 22 px tabular-nums treatment and its flash, tinted
`palette.accentCss` instead of the dominant family. The label carries the range. Underneath,
the **only comparison that matters**: `▲ 89.2M ahead of yesterday` in green / `▼ 60.2M behind`
in amber. `prevDayTok` is already in the feed; the app currently spends it on a single
milestone rung and then throws it away. Hidden on non-day ranges.

**Zone B — the town, muted.** All the chips that used to be per-family collapse into one plain
sentence. Nothing here is coloured. `🏆 N milestones` is new and is the §5.3 evidence trail.

**Zone C — the two reward bars.** These are the channels that pay out continuously, and they
should be the widest thing in the footer now that four family chips have left. Give
`next building` a bar at least 120 px wide — at 74 px, 5 % is three pixels of movement per
building and the meter reads as static.

**Deleted:** the four family chips, `famShare()`, the legend and `rebuildLegend()`, the
`break` legend chip (the groves keep their tooltip), and `since 08:00` (now the header's range
chip). The `— demo data` suffix survives as a small muted tag at the extreme right.

---

## 7. ACCEPTANCE — what "v3 is done" looks like

Beyond REDESIGN.md §8, which still applies in full:

- [ ] **Three seeds, three towns.** `?seed=` for three consecutive dates at `?tokens=5e8&still=1`:
      visibly different plans, different palettes, different horizons. Nameable at a glance.
- [ ] **No circle.** No shot contains a full unbroken concentric arc. The word "bullseye" does
      not occur to a fresh viewer.
- [ ] **The horizon is broken** in ≥ 60 % of azimuths, and nothing outside the town outranks
      the town in brightness or saturation.
- [ ] **No model attribution survives** anywhere: no legend, no family chips, no `famShare`
      tooltip line, no colour that means "Opus".
- [ ] **The range label is visible in every shot** and matches `settings.json`; changing
      `SelectedRange` in the tracker re-inits the town within ~2 s without a full ritual.
- [ ] **Ticker legible in a 9 s headless shot**, mid-line, never mid-scroll; ≥ 1 speech bubble
      alive at t = 6 s.
- [ ] **A promotion-only tick is visible.** With `T` increased by 2 M on a 500 M town and zero
      new plots, a viewer can still tell something happened (§5.2).
- [ ] **A milestone leaves evidence** discoverable 20 minutes later without having watched it.
- [ ] Day and night shots at 5e6 / 5e8 / 1e9 with no error banner, ≥ 60 fps at 1200 buildings
      and 160 villagers.
