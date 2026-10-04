# Token Town — the pre-v4 bench baseline

Taken at the top of the A–D wiring wave, on the tree with **only** the bench hooks landed in
`town.js` (they are inert without `?bench`), before `camera.js` / `postfx.js` / `surface.js` /
`grounding.js` existed. Every later perf claim in this wave is a ratio against these numbers.

```
npx electron . --bench --bench-scene=all --bench-budget=off --bench-json=bench-base.json
```

Machine: Windows 10, the user's own box. Window 1367×714 @ dpr 1, pumped, 600 frames /
120 warmup per steady scene. Raw rows: `scratchpad/bench-base.json`.

| scene  | bldgs | draws | tris k | cpu p50 | cpu p99 | geometries | programs |
|--------|------:|------:|-------:|--------:|--------:|-----------:|---------:|
| s200   |   200 |   690 |    247 |     1.5 |     2.0 |        494 |       35 |
| s600   |   599 |  1843 |    392 |     4.7 |    12.0 |       1356 |       36 |
| s1200  |   987 |  2950 |    519 |     6.6 |    12.5 |       2202 |       36 |
| n1200  |   987 |  2952 |    488 |     7.6 |    11.1 |       2212 |       37 |
| z1200  |   987 |  1267 |    357 |     4.1 |     7.6 |       2217 |       36 |
| found  |     0 |   107 |    160 |     0.3 |     1.0 |         45 |       24 |
| epochs |   599 |  1862 |    370 |     4.3 |     8.8 |       1362 |       38 |

`epochs` (20 switches, gate ARMED — `feed: onData` is wired):
geometry drift **−47**, textures **0**, programs **0**, heap **0 MB**. Probe drift all negative
(bins −77, cells −308, animEnts −9, hitTargets −9), i.e. the teardown over-collects rather
than leaking. Well inside the ≤5 / ≤8 MB budget.

## Notes on the rows themselves (true of the baseline and of every run after it)

* **`s1200` is 987 buildings, not 1200.** The pinned seed `0x5EED` plans a layout that tops
  out below `N_CAP`; `bench.js` reports what settled rather than asserting a count.
* **`found` measures 0 buildings.** The founding scene's window closes before the cascade
  lands on this machine, so `settleMs: 0`, `buildingsAt3s: 0`, `paintGroundCalls: 0`. It is a
  pre-existing property of the harness on this box, identical on both sides of the comparison,
  and it means the `found` row carries no signal this wave. Its one real number is
  `maxFrameMs: 400.1` (the module-evaluation frame).
* **`jsHeapMB` is pinned at 33.47** in every row — `performance.memory` in this Electron
  reports the quantised heap-limit bucket, so the leak gate's heap term is inert and the
  geometry/texture/program terms are doing all the work.
* Draw calls include the shadow depth pass (`callsShadow` ≈ `calls`), which is what the
  budget numbers in `BENCH_BUDGETS` are written against.
* `--bench-budget=off` silences the perf budgets (today's tree misses all of them by design —
  that is the point of the v4 wave) but never the leak budget, which gated from this first run.

---

## Stage D result (commit `ec65620`), same machine, same flags

Raw rows: `scratchpad/bench-D.json`.

| scene  | draws base → D | cpu p50 base → D | cpu p99 base → D | geometries | programs base → D |
|--------|---------------:|-----------------:|-----------------:|-----------:|------------------:|
| s200   |    690 → 700   |    1.5 → 1.5     |    2.0 → 2.1     | 494 → 496  |          35 → 46  |
| s600   |   1843 → 1853  |    4.7 → 4.1     |   12.0 → 5.1     | 1356 → 1346|          36 → 47  |
| s1200  |   2950 → 2960  |    6.6 → 6.7     |   12.5 → 8.5     | 2202 → 2203|          36 → 47  |
| n1200  |   2952 → 2962  |    7.6 → 6.8     |   11.1 → 8.6     | 2212 → 2204|          37 → 48  |
| z1200  |   1267 → 1277  |    4.1 → 3.8     |    7.6 → 5.3     | 2217 → 2179|          36 → 47  |
| found  |    107 → 117   |    0.3 → 0.4     |    1.0 → 1.1     |   45 → 47  |          24 → 30  |
| epochs |   1862 → 1872  |    4.3 → 4.2     |    8.8 → 10.2    | 1362 → 1302|          38 → 49  |

**+10 draw calls, flat, in every scene** — nine postfx passes at the `high` tier plus the one
instanced blob field. It does not scale with the town, which is the whole point.

**cpu p50 is unchanged or better**; p99 improved everywhere but `epochs` (10.2 vs 8.8 — that
window contains twenty teardowns, and eleven more `reset()` calls now run inside each one).

**programs +11 and CONSTANT across all twenty epoch switches** (drift 0): postfx's four passes
plus surface's role variants. A per-epoch program leak would have shown here and did not.

`epochs` leak gate, armed: geometries **−52**, textures **0**, programs **0**, heap **0 MB**.
Probe drift all negative, now including `grounding: −3`.
