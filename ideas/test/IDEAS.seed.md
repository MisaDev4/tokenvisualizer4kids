# Ideas — Token Tracker & Token Town

The running list of what to build next. **This file is the source of truth**, not chat: an
idea that only exists in a conversation is gone by tomorrow, and the agent fleets can't read
your taste out of a transcript.

## How to use it

| you want to | do this |
|---|---|
| dump an idea, however rough | `/idea the river should freeze in winter` |
| review what Claude is proposing | `/ideas` — then say e.g. `approve T-3, T-7 · decline T-5, too fiddly` |
| edit anything by hand | just open this file; the format is only a convention |

Nothing gets built off **Proposed** — Claude may only build from **Approved**. Anything in
**Declined** is settled: agents must not re-pitch it unless you move it back yourself.

Ideas carry a stable id (`T-n` town, `K-n` tracker) so you can approve by reference. Sizes:
S ≈ an hour, M ≈ a session, L ≈ a whole agent wave.

---

## 🆕 Inbox — yours, not worked up yet

_(empty — `/idea …` lands here)_

---

## 💡 Proposed — Claude's suggestions, awaiting your call

Carried over from the v4 design wave: eight designers explored, a showrunner ranked, and
these survived the cut but didn't fit v4.

| id | idea | size | why it might be worth it |
|---|---|---|---|
| **T-1** | **The Charter** — earn a civic building once (Records Hall, Mint, Almshouse) and it stands in *every* future town | L | The fleet called this the strongest single idea it produced. It's the thing that makes days accumulate into something instead of resetting. v4 already lands the `extraSites` hook it needs, so it starts warm. |
| **T-2** | **Couriers** — one cart on the roads per live agent session, hauling between buildings | M | The truest picture of how you actually work: parallel agent fleets become visible traffic. |
| **T-3** | **Street-level stroll** — walk your own streets in first person | L | The town is built and you can only ever look down at it. Needs fog ≥55, eye height 1.35, a 12 Hz shadow re-arm. |
| **T-4** | **Seasonal foliage** — October actually looks like October | M | Cheapest possible way to make the town feel tied to the real year. Flagged "if only one ships, ship this". |
| **T-5** | **Rainbow after a daylight milestone**, secondary bow included | S | A rainbow *is* a reward — fires ~6 s after the celebration. |
| **T-6** | **Morning mist + burn-off** | M | Claimed to be "the prettiest frame the app can make". |
| **T-7** | **Storm deck + lightning** as cloud-glow (no bolt geometry), villagers startle | M | Flash is a CSS white-out, never a light spike, so it can't blow out the render. |
| **T-8** | **Gold that actually glints** — fake specular travelling highlight on the monument | S | With bloom on, this is the difference between gold-coloured and gold. |
| **T-9** | **Click a headline → fly to its subject**, plus bookmarks 1–5 and `[`/`]` to browse landmarks | S | Makes the crier's gossip navigable instead of decorative. |
| **T-10** | **Market day** — arrivals, crowds, lit windows meaning real occupancy | S/M | The town currently has no weekly rhythm. |
| **T-11** | **Kingdom Map** — every past town as a village on one wider map | L | Wants the almanac strip's interaction and typography to exist first. |
| **T-12** | **The Shift** — the town dresses differently for a night worker | S | Zero query cost, computed from data already in `init`. |

---

## ✅ Approved — queued to build

_(empty)_

---

## 🔨 Building

| id | idea | where |
|---|---|---|
| — | **v4**: photographic render, camera rig, deed cards, LOD, weather, chronicle (ghost town / records / almanac), badges | agent wave in flight |

---

## 🚢 Shipped

- **v2** — town driven by one number (total tokens), villagers, monument with live ledger, milestone landmarks.
- **v3** — organic seeded layouts (5 archetypes, rivers, bridges, a new town each day), range synced to the tracker's selection, model-free palettes, escalating monument, crier ticker + speech bubbles, countryside.

---

## 🚫 Declined — settled, do not re-propose

Kept here **on purpose**: without it, every new design wave re-pitches the same rejected
ideas. Move a row out yourself if you change your mind.

| id | idea | why it's out |
|---|---|---|
| T-D1 | Cost / money as a treasury, coins, spend totals | Money is the one number that makes growth feel *bad*. The whole app exists to make the number feel good. |
| T-D2 | Drought / scorched weather on idle days | Punishes you for **not** spending. Quiet stretches stay green meadows. |
| T-D3 | Per-repo or per-project districts | "Analytics in a hat" — biggest privacy surface in the design, weakest charm payoff. |
| T-D4 | Ranks, city walls, dragons, random rare events | Sprawl. 25 badges deliver ~80% of the delight at 2% of the geometry. |
| T-D5 | SSAO, texture atlasing, chunk batching | Measured as *not* the bottleneck. Revisit only if a bench scene misses budget — don't speculate. |

---

## For agents reading this file

- Propose into **Proposed** with the next free id; never invent an "approved" row.
- Read **Declined** before proposing anything, and don't re-pitch what's there.
- When work starts, move the row to **Building**; when it verifies and commits, move it to
  **Shipped** with a one-line result.
- Keep rows to one line. Detail belongs in a design doc, linked from the row.
