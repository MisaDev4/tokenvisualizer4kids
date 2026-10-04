# Handoff — Token Town, the village pass

Written mid-flight so a fresh session (or a different account) can pick this up cold.
Check `git log` and the working tree first — background agents may have advanced things
since this was written.

**Branch:** `limits-cookie-fallback` · **nothing pushed** · main branch is `main`.

---

## 1. What the user asked for, in their words

- *"the central monument is way too big or prominent … I was thinking something like a
  fountain, that just has the token count above it"*
- *"the people in the town are a much more important part … when their token count goes up,
  they see that there's way more people"*
- *"tiers of towns … clear upgrades after milestones … but keep the old fashioned style,
  like, village aesthetic"*
- *"a town mayor … and he gave news, like, the economy is great or something"*
- *"we should retire those ones and stick with village appropriate ones. like, more realistic"*

Standing instructions: **keep working until told to stop**; **at most 3 subagents at once**;
when the list runs dry, improve the visuals, the realism, the houses and the juice rather
than stopping.

**`town/AESTHETIC.md` is the binding charter.** Every agent must read it. Three rules:
growth shows as MORE not TALLER · the people are the point · nothing magical.

---

## 2. Shipped and committed this session

| commit | what |
|---|---|
| `9a32017` | **`town/AESTHETIC.md`** — the charter |
| `f88c444` | `town/design/` — 20 design docs rescued from temp scratchpads |
| `fe72360` | **The fountain.** `monument.js` (1589 lines) deleted; `fountain.js` is a village fountain, under 7 units, eleven rungs that buy detail not height, no post-1B multiplier. Same public contract, so town.js's call sites stood. |
| `5a1a4cb` | **The crowd.** `NPC_CAP` 160 → 1400 on a curve that never saturates; **1326 villagers at 1200 buildings**. Two wardrobes (160 detailed near / 40-tri far), wall-clock time slicing. Triangles went DOWN on every far scene. |
| `ea1feed` | **Audio, rare events, the Shift** (T-16/17/12), wired. Also: `main.js` forwards a flag WHITELIST and `event`/`eventAt`/`audio` were missing from it, so the documented verification flags did nothing. |
| `f20b964` | **The mayor.** Unlocked at 10M, walks to the fountain every 8 min, 66 lines with no second person anywhere. |
| `f8a8885` | **The cult of the Coin retired** from news.js — it was describing an altar that no longer exists, and one line ("Just one more zero. Please.") was a copy-gate failure. |
| `fed1a78` | **The village.** Fantasy landmarks retired for smithy / mill / market cross / tithe barn / chapel / green / inn; hamlet → village → market village → market town, with a visible re-skin at each tier. |
| `3a3ea4c` | **Street-level stroll** (T-3). `G`, or "Walk there" on a deed. First person expressed inside the orbit maths, walker constrained to `plan.graph`. |

---

## 3. In flight (3 agents, the user's cap)

| agent | owns | doing |
|---|---|---|
| look-dev | `buildings.js` | make houses look better at **zero net triangle cost** — texture and weathering over geometry, find waste to pay for detail. Also asked (by follow-up message) to retire the castle-keep top house tiers. |
| foliage | `environs.js` | T-4 seasonal foliage — real calendar month visible in the land, blended across boundaries |
| market | `market.js` (new) | T-10 market day — stalls on the square, arrivals, a weekly rhythm. `villageFabric().stalls` already returns 0/2/5/9 and nothing places them. |

**None of them may touch `town.js`** — it is the conductor and the real serialization
constraint. They report hooks; the integrator lands them.

---

## 4. Things that will bite you

- **THE TRIANGLE BUDGET IS FULL.** `z1200` sits at **418k against 420k** and fails the build
  at 421k. Anything added must be paid for. The market-town fabric is what consumed the
  headroom; it is now weighted toward the town core (walls and lanterns around the square,
  paling on the farm lanes) which is both cheaper and more truthful.
- **FOUR TABLES MUST AGREE** or landmarks silently never appear: `buildings.js`
  `LANDMARK_DEFS`, `layout.js` `LM` (site reservation by building ordinal), `town.js`
  `LADDER`'s `lm:` column, and `chronicle.js` `MARK_SITES`. `placeLandmark` returns early on
  a missing site with no error. The ladder's token rungs and LM's ordinals are derived from
  each other — the comment above `LADDER` records the mapping.
- **`main.js` forwards a flag whitelist** (~line 182). A new debug flag does nothing until
  it is added there. This has already silently swallowed one agent's verification path.
- **Renderer `console.log` is NOT forwarded** to the terminal; `console.error` is. A
  diagnostic that prints nothing may just be using the wrong level.
- **Wall-clock rule.** Headless paints at ~1 fps, so anything a screenshot must show is
  driven by `performance.now()`, never accumulated `dt`. A dt-scaled spawn budget once
  photographed 316 of 1140 villagers.
- **PowerShell here-strings break** on commit messages containing double quotes; write the
  message to a file and use `git commit -F`.

---

## 5. The rules (`CLAUDE.md` is authoritative)

1. **Never open a window on the user's screen.** Verify ONLY offscreen, from `town/`:
   `npx electron . --shot=<ABS>.png --shot-delay=10000 [--hour=13|23] [--seed=N] [--tokens=2e8] [--cam=stroll] [--event=<id>] [--bench --bench-scene=all|epochs]`
   Kill strays: `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`
2. **Commit completed work**, one concern per commit, on a branch, never pushed, no PRs.
3. **Ideas live in `ideas.json`**; `IDEAS.md` is GENERATED — regenerate it through
   `ideas/src/store.js`'s own `renderMarkdown`, never hand-edit.
4. Don't touch `source/**` (the C# tracker) from town work.
5. **Copy gate:** nothing may nag, guilt, or pressure the user into spending tokens, and
   nothing addresses them in the second person. Quiet days are fine days.

---

## 6. What to do next

**Every approved idea in `ideas.json` is now built and committed.** What remains is the
open-ended improvement the user asked for: *"if you run out of stuff, you can always improve
how the visuals look… improve how the houses look."*

The live queue, in the order the agents themselves ranked it:

1. **Tiers 3 and 4 are still one prism with a roof**, and they are the majority of the town
   below the wealthy core. The massing kit exists; they never got plans. **(in flight)**
2. **The villagers walk at 1.7–2.6 m/s** at the derived scale — everyone is power-walking
   and the user is the slowest person in town. **(in flight)**
3. Roof furniture at eye level: barge boards, ridge crestings, a proper eaves fascia.
4. Leaded lights on the older houses — wants a texture on the pane, not geometry.
5. **Nothing terraces.** Two or three houses sharing a party wall along the core lanes would
   do more for "market town" than anything else, but it needs `layout.js`.
6. The stroll walker never stops for people; it needs a crowd query in the rig's config.

### The scale, settled

**One world unit ≈ 1.78 m**, derived from the only object whose size is not a matter of
opinion — a person (a villager stands 0.964 u). Corroborated by the architecture: cottage
ridge 6.2 m, manor ridge 10.5 m, lane 6.6 m across. `camera.js` walks at 0.72 u/s and
`EYE_H` is 0.90. **Anything with physical units should be checked against this** — several
things were written as though 1 u = 1 m and were wrong by that factor.

### The triangle budget

`z1200` measures **406k against a 420k gate that fails the build**, verified on a quiet
machine with 8/8 passing. Treat it as the scarce resource it is; every agent that has spent
in this file has paid for it by finding waste first.

### Known gaps

- **`found` fails its CPU-time gates when several agents render at once, and passes on a
  quiet box.** Confirmed 8/8 pass with the machine idle. Do not chase it under load; A/B
  against `git show HEAD:` instead of trusting an absolute sweep.
- `bench.js`'s `jsHeapMB` is pinned by Electron's quantised heap reporting — the leak gate
  rests on geometry/texture/program counts.
- The `leviathan` rare event (a whale in the sky, once a fortnight) is a deliberate tall tale
  and sits in tension with the charter's "nothing magical". Kept; worth asking the user.
- The rainbow's curtain modulation does not know where the shower is, and nothing casts the
  bow — a milestone bow can appear over a dry town.
- Spring is the weakest season: it differs from summer only in colour.

### A lesson worth keeping

An agent hit a session limit mid-task and left its feature **switched off behind a debug
flag**, with a half-written probe drawing a test bubble into the live picture; another left
temporary census instrumentation in `buildings.js`. Both were recoverable, but brief agents
to **leave their file shippable at every point** — instrumentation somewhere it cannot ship,
debug switches defaulted off, and never the thing they are building left bypassed.
