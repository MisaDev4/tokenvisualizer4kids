# Ideas — Token Tracker & Token Town

<!-- GENERATED FILE — do not hand-edit. The source of truth is `ideas.json`
     beside it; this file is rewritten from it on every save and is never read
     back. Change things in the Ideas board app (Ideas.cmd) or edit ideas.json. -->

The running list of what to build next. An idea that only exists in a conversation is
gone by tomorrow, and the agent fleets can't read your taste out of a transcript.

## How to use it

| you want to | do this |
|---|---|
| dump an idea, however rough | open the Ideas board and type it into **Inbox** |
| review what Claude is proposing | drag cards out of **Proposed** — right into **Approved**, or into **Declined** with a reason |
| work a card by hand | edit `ideas.json`; the board reloads itself when the file changes |

Nothing gets built off **Proposed** — Claude may only build from **Approved**. Anything in
**Declined** is settled: agents must not re-pitch it unless you move it back yourself.

Ideas carry a stable id (`T-n` town, `K-n` tracker) so you can approve by reference. Sizes:
S ≈ an hour, M ≈ a session, L ≈ a whole agent wave.

---

## 🆕 Inbox — yours, not worked up yet

_(empty)_

---

## 💡 Proposed — Claude's suggestions, awaiting your call · 10

| id | idea | size | why it might be worth it |
|---|---|---|---|
| **T-1** | **The Charter** | L | earn a civic building once (Records Hall, Mint, Almshouse) and it stands in *every* future town — The fleet called this the strongest single idea it produced. It's the thing that makes days accumulate into something instead of resetting. v4 already lands the `extraSites` hook it needs, so it starts warm. |
| **K-2** | **Coverage sentinel: the tracker notices untracked AI usage instead of the user noticing it** | M | Watch for signs of harness activity that produced no usage events (e.g. codex.exe/claude processes running, or known AI dirs like ~/.codex being written) and show a "possible untracked usage" warning with what ran and when. Strongest signal: the provider-side rate-limit windows the tracker already polls (CodexLimitsService/ClaudeLimitsService) are billing-side truth that count even trace-less calls — if a window's used% climbs while the local ledger stays flat, something ran untracked. Every miss so far was found by the user eyeballing dashboards; this flips detection to the tracker. |
| **K-3** | **Per-file client sniff fallback: a codex-shaped file in a claude-tagged root is silently ignored** | S | Roots carry one client tag, and every *.jsonl under them is parsed with that client's parser only (loop-learning\data\runs is claude-tagged, so codex-shaped files there yield zero events, no error). When a file produces no events under its root's parser, re-sniff it and parse with the shape it actually matches. |
| **T-2** | **Couriers** | M | one cart on the roads per live agent session, hauling between buildings — The truest picture of how you actually work: parallel agent fleets become visible traffic. |
| **T-6** | **Morning mist + burn-off** | M | Claimed to be "the prettiest frame the app can make". |
| **T-7** | **Storm deck + lightning** | M | as cloud-glow (no bolt geometry), villagers startle — Flash is a CSS white-out, never a light spike, so it can't blow out the render. |
| **T-9** | **Click a headline → fly to its subject** | S | plus bookmarks 1–5 and `[`/`]` to browse landmarks — Makes the crier's gossip navigable instead of decorative. |
| **T-11** | **Kingdom Map** | L | every past town as a village on one wider map — Wants the almanac strip's interaction and typography to exist first. |
| **K-4** | **Keep a history of the plan-limit meters, not just the latest reading** | S | The Limits page polls the 5h / Week / Fable percentages every few minutes but only the latest snapshot survives (accounts.json). Append every distinct reading (account, label, percent, resetsAt, fetchedMs) to a small limit_readings table in usage.db and prune after ~90 days. With that, 'did Anthropic shrink the 5h window?' is one query: tokens spent between two readings divided by the percent moved, plotted over weeks. On 2026-09-04 answering it took an hour of forensics across transcript error lines and bot chat logs, and July was unanswerable. |
| **K-5** | **Attribute a session to the account it started under, not the one signed in now** | S | A running Claude Code process keeps the OAuth token it read at launch, so when claude-swap switches accounts the bot's long-lived sessions keep charging the old account for hours. The Limits page's local-usage-per-account attribution uses the signed-in timeline at each event's time, so those events land on the wrong account (seen 2026-09-04: account A's 5h meter rose 17->25% while the timeline attributed $0 to it; account B's readings matched only after re-attributing by session start). Fix: attribute each top-level session (and its subagents) to the account active at its first event; a session that outlives a swap stays with its original account. |

---

## ✅ Approved — queued to build

_(empty)_

---

## 🔨 Building · 1

| id | idea | where |
|---|---|---|
| T-18 | **General graphics pass** | Improve the visuals across the board — materials, lighting, silhouettes, texture detail, the post grade, night mood. Standing work: keep raising quality rather than shipping one feature. |

---

## 🚢 Shipped · 19

| id | idea | result |
|---|---|---|
| T-23 | **Double-click a live block to read the transcript behind it** | The block says what a response cost; nothing said what it was. Asked for directly. · Double-clicking any block in Live opens a read-only viewer of the .jsonl it was parsed out of — prompts, replies, thinking, tool calls and their results — scrolled to that response and outlined in blue. Claude Code and Codex logs (both rollout formats), with a filter box, Copy all, Show file, and a curtain while Hide personal data is on. |
| T-13 | **v2** | town driven by one number (total tokens), villagers, monument with live ledger, milestone landmarks. |
| K-6 | **Keep a copy of transcripts that vanish seconds after they're indexed, so Live blocks always open** | Cause: the Discord bot's narrator forks (`claude -p --resume --fork-session`), refusal-rewind cuts and model-restore copies each write a new full-history .jsonl under ~/.claude/projects, the tracker indexes it within a second, and the bot unlinks it right after (narrator.js:723, bot.js:10021/10087/10237/10554/20850). In the last 3 days 2,656 of 7,698 Claude events (380 files, all from the bot's agents) point at deleted files, so double-clicking those blocks shows "The log this block came from is gone". Fix in the tracker: tee the complete lines the parser already reads into a compressed vault under the data dir keyed by source path; drop a vault copy once its source has survived ~24h (so the vault only ends up holding files that actually disappeared), cap the vault by size/age; the transcript viewer falls back to the vault when the recorded path is missing. Alternative, cheaper but outside this repo: have the bot move those copies to an archive folder instead of unlinking. · The collector tees every young transcript it parses into %LOCALAPPDATA%\TokenTracker\transcript-vault; copies whose source survives a day are dropped, copies of vanished logs are gzipped and kept (30 days / 1 GB, settings.json). Double-clicking a block whose log was deleted now opens the copy and says so in the header. Verified live: a bot fork vanished, was compressed 234 KB to 68 KB and stayed openable. |
| T-15 | **v4** | photographic render, camera rig, deed cards, LOD, weather, chronicle (ghost town / records / almanac), badges — agent wave in flight · photographic render, camera rig, deed cards, LOD, weather, chronicle and badges — 15-agent wave, wired and committed |
| T-17 | **random rare events is fun. you put that in declined but it sounds fun. they should be properly spaced out though, making them actually special when they happen** | rare events with proven spacing: ~2 a day at two hours of use, 28-minute hard minimum, legendary about once a fortnight |
| K-1 | **AWS GPU usage tab: a second, separate tab for AWS GPU compute (rendering/videogen) — not the Opus AWS token usage, GPU only** | Groundwork checked: AWS CLI v2 is installed and credentialed on this machine (us-east-1), and a g6e.2xlarge "videogen-worker" is running today, so the data is reachable. · GPU tab shipped: one free describe-instances call per open/refresh, instance cards with live burn rate and est. run cost, its own ledger — token views untouched |
| T-19 | **Shrink the monument to a fountain** | Way too big and prominent, and it upgrades far too much. Make it a lot smaller and simpler — something like a fountain with the token count floating above it. Cut the tier ladder right down. · the Token Altar is gone; fountain.js is a village fountain under 7 units with the count on a board above it |
| T-20 | **Many more people in the town** | The people are the important part and there are nowhere near enough. May need a full redesign to support far more NPCs moving around. When the token count goes up the user should SEE many more villagers — that is the reward. · NPC_CAP 160 -> 1400 on a curve that never saturates; 1326 villagers at 1200 buildings, and triangles went DOWN via a near/far wardrobe split |
| T-21 | **Tiers of town, village aesthetic** | Clear upgrades at milestones: small village growing into something bigger. Keep the old-fashioned village look throughout — not a modern city. · fantasy landmarks retired for smithy/mill/market cross/tithe barn/chapel/green/inn; hamlet -> village -> market village -> market town re-skins the town as it grows |
| T-22 | **A town mayor who gives the news** | Unlocked at some point. He delivers the news — the economy is great, that sort of thing. · Mayor Horatio Stapleford: unlocked at 10M, walks to the fountain every 8 min, 66 lines with no second person anywhere |
| T-14 | **v3** | organic seeded layouts (5 archetypes, rivers, bridges, a new town each day), range synced to the tracker's selection, model-free palettes, escalating monument, crier ticker + speech bubbles, countryside. |
| K-7 | **Count Codex runs that save no transcript (codex exec --ephemeral)** | Why: --ephemeral writes no rollout to ~/.codex/sessions, and the rollout was the tracker's only Codex source. It kept recurring: loop-learning lost ~150 calls on 2026-08-27 and built its own mirror (tools/model_backend.mjs); machinelearning/tinyboss/gen.mjs ran an ~800-call GPT-6 Luna job on 2026-09-24 that was never counted. Built with Codex's rollout tracer instead of a relay: Codex 0.156 ignores OPENAI_BASE_URL for ChatGPT logins, and --ignore-user-config drops openai_base_url. The app sets the user-level CODEX_ROLLOUT_TRACE_ROOT to its data folder (cleared on exit); every Codex process writes a trace bundle there with each call's token_usage, even with --ephemeral --ignore-user-config. Only threads with no rollout path are billed, so nothing counts twice; bundles are pruned once indexed. loop-learning's mirror now stands down while the trace root is set. · Settings → Count Codex runs that save no session log (on by default); covers Codex processes started after the app sets the variable. |
| T-16 | **audio. tycoon games have great ambient audio, like your overseeing a real town. would be cool. should be a toggle, and location based(further out is quieter)** | procedural ambient audio, silent until you click its chip; builds no audio graph at all before then |
| T-12 | **The Shift** | the town dresses differently for a night worker — Zero query cost, computed from data already in `init`. · the town reads the hours you keep and dresses for them; confidence is the dial, so it is bit-identical until the data says something |
| T-10 | **Market day** | arrivals, crowds, lit windows meaning real occupancy — The town currently has no weekly rhythm. · carts before light, trestles up in a staggered ripple, trade, pack-down; the weekday is minted once per town and kept. Zero draw calls on the other six days |
| T-8 | **Gold that actually glints** | fake specular travelling highlight on the monument — With bloom on, this is the difference between gold-coloured and gold. · the real bug was no environment map, so metalness 0.85 sent diffuse to zero with no IBL to pay it back. Fake env off the mirror direction plus a broad specular lobe; brass under lamplight is the best it looks |
| T-5 | **Rainbow after a daylight milestone** | secondary bow included — A rainbow *is* a reward — fires ~6 s after the celebration. · physically placed on the antisolar point off the DRAWN sun, secondary bow and Alexander dark band, one draw call and zero triangles when down. Not yet visible from the orbit camera -- a milestone tilt-up beat is queued |
| T-4 | **Seasonal foliage** | October actually looks like October — Cheapest possible way to make the town feel tied to the real year. Flagged "if only one ships, ship this". · nine continuous seasonal drivers off one phase angle, per-tree stagger in the autumn turn, winter as a silhouette change; z1200 triangles went DOWN 416k to 395k |
| T-3 | **Street-level stroll** | walk your own streets in first person — The town is built and you can only ever look down at it. Needs fog ≥55, eye height 1.35, a 12 Hz shadow re-arm. · G, or Walk there on any deed: first person at eye height, expressed inside the orbit maths so every transition still works; walker constrained to the street graph |

---

## 🚫 Declined — settled, do not re-propose · 5

Kept here **on purpose**: without it, every new design wave re-pitches the same rejected
ideas. Move a row out yourself if you change your mind.

| id | idea | why it's out |
|---|---|---|
| T-D1 | **Cost / money as a treasury, coins, spend totals** | Money is the one number that makes growth feel *bad*. The whole app exists to make the number feel good. |
| T-D2 | **Drought / scorched weather on idle days** | Punishes you for **not** spending. Quiet stretches stay green meadows. |
| T-D3 | **Per-repo or per-project districts** | "Analytics in a hat" — biggest privacy surface in the design, weakest charm payoff. |
| T-D4 | **Ranks, city walls, dragons, random rare events** | Sprawl. 25 badges deliver ~80% of the delight at 2% of the geometry. |
| T-D5 | **SSAO, texture atlasing, chunk batching** | Measured as *not* the bottleneck. Revisit only if a bench scene misses budget — don't speculate. |

---

## For agents reading this file

- Propose into **Proposed** with the next free id; never invent an "approved" row.
  **Only the user promotes to Approved**, and you may only build from **Approved**.
- Read **Declined** before proposing anything, and don't re-pitch what's there —
  every declined row carries the reason it is out.
- Declining something requires a reason. A row with no reason is not a decision.
- When work starts, move the row to **Building**; when it verifies and commits, move it
  to **Shipped** with a one-line result.
- Write to `ideas.json`, not to this file — this one is regenerated and your edit would
  be overwritten on the next save.
- Keep rows to one line. Detail belongs in a design doc, linked from the row.
