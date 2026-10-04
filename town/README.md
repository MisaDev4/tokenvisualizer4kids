# Token Town

Standalone 3D companion app for Token Tracker: your Claude usage as a living town.

The town is a pure function of **one number and one seed**. The number is `T`, the tokens
in whatever window Token Tracker has selected; `N = 32 · (T/1M)^(3/8)` buildings stand at
any moment, so a burst of tokens detonates *many* houses at once and the township only
ever grows. The seed is the **epoch** — it decides where every street goes, so the town is
a place you *found* rather than a layout someone chose, and no two days are alike.

**The street plan** (`layout.js`) is grown by road agents through one of five archetypes —
*crossroads market town*, *riverside market town*, *valley ribbon village*, *lakeside
town*, *hill terraces* — with junctions, blocks, dead ends, constructed bridges and a
river or lake where the archetype has one. Houses stand on frontages along their own
street and face it. Nothing is concentric; the plaza is the origin but rarely the centre.

**Colour** is a seeded property of the *day*, not of the model you used. Ten roof families
(Terracotta, Ochre, Saffron, Slate, Charcoal, Moss, Limestone, Bluestone, Heather, Ashblue) are
narrowed to three primaries and an accent under two harmony rules, walls are tinted toward
a daily plaster wash, and the mix drifts by band so the middle of town reads older than
the edges. About one house in seventy is a *painted lady*.

**The fountain** in the market square is the centrepiece, and it is deliberately small: it
tops out under seven units, shorter than a cottage with its chimney. Eleven rungs from a
Stone Basin to The Great Fountain buy DETAIL — water, a carved column, bronze spouts,
lanterns, planters, a cobbled apron, a second bowl — never height. Growth shows as more
houses and more people; the fountain just keeps count, on a board above it carrying the
live total and the range you selected.

**The countryside** (`environs.js`) is scaled to the town, never the other way round:
hedgerows and farmland just past the last house, orchards and copses beyond, distant hills
and haze on the horizon — all of it fading toward the sky so the edge of the world is
mathematically unseeable. Weather encodes your pace: a golden haze when you are booming,
overcast when you have gone quiet.

**The picture** (`postfx.js`, `surface.js`) is a photograph rather than a diagram. The
scene renders into an HDR buffer and one composite pass applies exposure, a filmic curve
with a real shoulder, two octaves of bloom, lift/gain, a tilt-shift band and an
aspect-correct vignette. Saturation, contrast and the vignette run **after** the sRGB
transfer, on display values — which is the difference between a night with silhouettes in
it and a town floating in a void. The grade warms and enriches a little as the day's
number grows.

**The camera and the deeds** (`camera.js`, `interact.js`). A rig owns orbit, focus,
follow, a six-shot tour, street level (`G`) and photo mode (`P`); it never puts the lens
inside the fountain, and photo mode keeps tracking the town as it grows. Everything is
clickable in every level of detail, and every building has a **deed card** naming what it
cost and which stretch of your own day paid for it.

**The memory** (`chronicle.js`, `memorial.js`, `almanac.js`, `charter.js`) is derived,
not stored: a calendar date alone reconstructs that day's seed, plan, archetype and name.
The **Chronicle Stone** on the plaza rim carries the records, **yesterday's town** stands
lit on the eastern horizon, the header carries a fourteen-day **almanac** strip whose pages
open as parchment cards (`A`), and a **charter** of honours records what the town has been
awarded (`H`).

**Level of detail** (`lod.js`) draws the far town as seven instanced streams — one box, two
roof kinds, chimneys, windows and silhouette extras — so 1 200 buildings cost ~240 draw
calls instead of ~4 800. Impostors are derived from the real mesh at build time and go
through the same fragment pass as the near town, so the swap leaves no colour seam.

**The Crier** (`news.js`) is a municipal newspaper in a row under the header — 190-odd
headlines about the town's economy, its buildings, its market square and its nights, plus
speech bubbles over the villagers — depth-tested, so nobody talks through a wall. Up to
**1 326 villagers** walk the real road graph on a near/far wardrobe split, step around each
other and around you, gather at the fountain, carry lanterns and loads after dark, and stop
halfway across a bridge to watch the water.

**Milestones**: eleven absolute rungs from 250k to 2.5B unlock landmarks (Well, Smithy,
Mill, Market Cross, Tithe Barn, Market Hall, Parish Chapel, Bell Tower, Village Green, Inn)
with fireworks, a shockwave and a pilgrimage. Six further named rungs — 2.5B, 5B, 10B,
25B, 50B, 100B — carry the horizon past the last landmark; the fountain caps at tier 10 and
the landmark set is complete by 2.5B, so these are title and celebration only. Between the
rungs, half-decade *minor* ones fire
at a magnitude-relative step, so the cadence is the same (~5 events per decade) on a 3M
day and a 1B one — and if the previous window's total is known, "🏅 Past …" is spliced in
as its own rung. A timber scaffold on the next plot fills as you pay for the next
building, idle stretches plant groves behind the frontage, and the sky follows your real
local sun (golden hour, visible sun, stars, lamp-lit streets).

**The range follows the tracker.** Whatever window is selected in Token Tracker — this
session, the last N hours, today, the last N days, this month, all time — is what the town
counts, and changing it there re-founds the town here within about two seconds, with a new
seed and therefore a new place. Every range is redrawn at least daily, which is what gives
you a different town every morning.

## Architecture (ten files, three swappable layers)

- `src/datafeed.js` — **data adapter**. Runs under the system Node.js, reads Token
  Tracker's `usage.db` (read-only, WAL) + `settings.json` (range, session gap, latitude),
  resolves the selected range into an **epoch**, and emits a JSON-lines protocol v4:
  `init` (the epoch, its seed and labels, the previous window's total, history folded to
  an adaptive bin + the last two hours at native 5-minute resolution) then `buckets`
  every 2 s (absolute totals for that live tail — upsert-proof),
  `config` (latitude), `depth` every 2 s (the cache read/write mix and the plan's limit
  rows — never a token, an id or an email) and `error`. An `init` also carries the day's
  own totals and a chronicle block, which is what the memory layer is derived from.
  Exactly one `init` per epoch; an `init` *is* a reset.
  Nothing in this app ever writes to `settings.json`, `usage.db` or the tracker.
- `src/main.js` — **Electron shell**. Window + plumbing only.
- `src/renderer/` — **three.js renderer**, twenty modules with no lateral imports. Each
  is a null object when its dependency is missing, and each is registered in `town.js`'s
  single teardown list:
  `town.js` (the conductor: seeds, epochs, growth, milestones, camera, chrome — and the
  sole mediator between the rest), `layout.js` (the street plan), `buildings.js`
  (construction + the palette), `fountain.js` (the plaza centrepiece), `npcs.js` (villagers),
  `environs.js` (the countryside), `news.js` (the Crier), `postfx.js` (the image),
  `surface.js` (the shared fragment pass), `grounding.js` (contact shadows), `camera.js`
  (the rig), `interact.js` (hover, deeds, keys), `lod.js` (the far town), `weather.js`
  (the sky's own day), `chronicle.js` + `chronicle-store.js` (the derived record),
  `memorial.js` (stone, ghost, bunting), `almanac.js` (the almanac strip), `charter.js`
  (honours), `audio.js` (ambient sound, off until you ask for it), `events.js` (rare
  events) , `shift.js` (the hours you keep) and `bench.js` (the perf harness). Opened in
  a plain browser it runs on synthetic demo data.

## Run

```
npm install
npm start
```

Requires Node.js 22.13+ on PATH (the datafeed uses the built-in `node:sqlite`).
Token Tracker has a "Town ↗" button that launches this app.

## Self-test screenshot (the only way to verify a change)

```
npx electron . --shot=out.png --shot-delay=9000     # --hour=23 forces night
```

A founding cascade on a large range needs longer than 9 s to settle — allow
`--shot-delay=13000` for `--range=all` or a forced `--tokens` in the billions.

Renders the real town **offscreen** and exits: the window is never shown, never takes
focus, never hits the taskbar, and skips the single-instance lock so an already-open
Town can't swallow the run. Page errors go to stdout and into the in-app error banner.

Knobs (forwarded to the page as URL params; the range flags also reach the feed):

| flag | effect |
|---|---|
| `--hour=13\|23` | forces the solar clock |
| `--tokens=5e8` | forces the token total |
| `--still=1` | freezes the feed |
| `--seed=N` | overrides the plan seed **and** the day seed — same town, on demand |
| `--intro=0` | skips the founding ritual (use it when shooting one layer) |
| `--feed=demo` | the no-bridge synthetic path *inside* the shell |
| `--demo=slow\|fast` | synthetic feed cadence |
| `--range=<key>` | overrides the selected range (never writes settings.json) |
| `--gap=<hours>`, `--session-start=<ms>` | session testing without pinning the tracker |
| `--epoch-quantum=<ms>` | forces a live epoch reset inside one screenshot |
| `--post=high\|med\|off` | picture tier. Pinned in headless runs — and the run prints the tier it pinned |
| `--lod=off\|med\|low` | the far-town A/B: `off` keeps every building a real group |
| `--wx=clear\|rain\|storm\|…` | forces the day's weather instead of rolling it from the date |
| `--season=<name>` | forces the season the weather rolls inside |
| `--cam=orbit\|photo\|follow\|tour[:N]` | drives the rig once the town has landed; `tour:N` counts from 1 |
| `--select=house:N\|landmark\|fountain\|villager[:N]\|chronicle_stone` | opens a deed card and frames its subject |
| `--shot-ui=0` | no chrome at all: header, crier bar, footer and the interaction layer |
| `--chronicle=demo` | a synthetic record: the horizon ghost, the stone, the almanac and the honours |
| `--almanac=1` | opens an almanac card |
| `--ledger=1` | opens the Honours register |
| `--hide=1` | the tracker's "hide personal data" mode, applied at the feed |
| `--v3=1` | pins the feed to protocol v3 (no depth, chronicle or today block) |

## Perf (the same binary, budgets armed)

```
npx electron . --bench --bench-scene=all              # eight scenes, budgets ARMED
npx electron . --bench --bench-scene=epochs          # 20 epoch switches — the leak gate
npx electron . --bench --bench-scene=all --bench-json=out.json
```

`BENCH_BUDGETS` in `bench.js` **is** the acceptance contract: draw calls, triangles and CPU
percentiles per scene, a frame-time gate on the founding cascade, and a leak gate that
fails on geometry drift or heap growth across twenty epoch switches. `--bench-budget=off`
silences the perf budgets and exists only for capturing a baseline — a stage measured with
it switched off has no perf gate at all.

Never launch the app visibly just to look at a change — it lands on whatever the user is
doing. Kill strays with `Get-Process electron | Stop-Process -Force`.

Note: hidden windows paint at a low frame rate, so anything driven by per-frame `dt`
lags in a screenshot. Everything about *existence* — buildings, villagers, headlines,
counters — is driven by `performance.now()`; only continuous motion uses `dt`. The same
rule in CSS: base styles are the final state, animations only travel toward them.

## Config

Read from Token Tracker's `settings.json`: `SelectedRange`, `SessionGapHours`,
`ManualSessionStartMs` (the window the town counts) and optional `TownLatitude` (refines
sunrise/sunset; defaults to 50°N). The file is polled, never written.
