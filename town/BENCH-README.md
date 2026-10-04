# `--bench` — the headless performance harness

`bench.js` measures the inside of Token Town's frame and prints one greppable line per
scene. It exists because none of the numbers in `v4-engine.md` are measurements yet, and
because the leak gate (`--bench-scene=epochs`) is the only mechanical enforcement of the
epoch-teardown discipline in v4. **It never opens a visible window** — the bench window is
created exactly the way `--shot=` already creates one (`show:false`, `skipTaskbar:true`,
`paintWhenInitiallyHidden:true`, `backgroundThrottling:false`).

---

## 1 · Running it

```powershell
cd <repo>\town

# the whole suite: 7 scenes, one line each, exit 0 iff every budget was met
npx electron . --bench --bench-scene=all

# THE BASELINE RUN (pre-v4 tree). Perf budgets off — today's tree misses all of
# them by construction — but the leak gate stays armed.
npx electron . --bench --bench-scene=all --bench-budget=off --bench-json=.\bench-base.json

# one scene, with reference PNGs for A/B review
npx electron . --bench --bench-scene=s1200 --bench-shot=.\bench-shots

# the leak gate on its own (the merge gate; ~30 s)
npx electron . --bench --bench-scene=epochs

# tune
npx electron . --bench --bench-scene=s600 --bench-frames=900 --bench-warmup=180
```

Strays: `Get-Process electron | Stop-Process -Force`. A run that hangs is killed by main's
180 s watchdog with exit code 2, so it cannot leave one behind on its own.

### Flags (§4.9)

| flag | default | meaning |
|---|---|---|
| `--bench` | — | turns the whole thing on; also switches vsync off in main |
| `--bench-scene=` | `all` | `all`, one name, or a comma list. Names: `s200 s600 s1200 n1200 z1200 found epochs` |
| `--bench-frames=` | `600` | measured frames per steady scene |
| `--bench-warmup=` | `120` | discarded frames before measuring (shader compiles, first uploads) |
| `--bench-shot=<dir>` | off | writes `<dir>/<scene>.png` — makes the bench a visual regression tool too |
| `--bench-json=<file>` | off | main writes the collected rows as a JSON array |
| `--bench-budget=` | `v4` | `off` reports without gating **perf**; the leak budget is never silenced |
| `--bench-dpr=` | `1` | pixel ratio, pinned so two machines compare. `native` opts out |
| `--bench-pump=` | `1` | `0` disables the frame pump (see §4) |
| `--bench-settle=` | `20000` | ms cap on "wait for the town to stop growing" |
| `--bench-size=` | `1380x880` | window size (main.js applies it at window creation) |

One page load per scene: `tokens`, `hour` and `intro` are read into module consts when
town.js loads, so switching scenes *is* a reload. The page owns the schedule and asks main
to load the next scene; main knows nothing about scenes.

Every scene forces `feed=demo&still=1` and (except `epochs`) `seed=0x5EED`: the bench must
never depend on what the user did today.

---

## 2 · Reading a row

```
TOWNBENCH {"v":1,"scene":"s1200","label":"the full plat, noon","measure":"steady",
 "size":"1380x880","buffer":"1380x880","dpr":"1","pumped":true,"frames":600,"warmup":120,
 "ms":4140,
 "cpuMs":  {"p50":5.81,"p90":6.38,"p95":6.4,"p99":10.2,"max":11.36,"mean":5.86},
 "frameMs":{"p50":6.9,"p90":6.9,"p95":6.9,"p99":6.9,"max":6.9,"mean":6.9},
 "draw":{"calls":287,"callsShadow":394,"triangles":248113},
 "mem":{"geometries":412,"textures":19,"programs":24,"jsHeapMB":86.4},
 "town":{"buildings":1200,"villagers":160,"lod":"A","hot":0,"impostors":1200},
 "budget":{"calls":300,"trianglesK":300,"cpuP50":6,"cpuP99":12},"fail":[],"pass":true}
```

* **`cpuMs` is the number that matters.** `performance.now()` at the end of `tick` minus the
  stamp at the top — three.js's draw-call overhead is CPU-side, and this is the only figure
  independent of the GPU in the machine.
* **`frameMs`** is the interval between frames. Meaningful only because vsync is off; when
  `pumped` is true it is the pump's cadence, i.e. sustained throughput, not rAF.
* **`draw.calls` is the MODE**, `draw.callsShadow` the max. three counts the shadow depth
  pass inside `render()`; conflating the ~58 quiet frames in 60 with the re-armed ones makes
  the number jump by hundreds and unusable as a budget.
* percentile law, pinned: `sorted[Math.floor(p/100 * (n-1))]`.
* **`pass` / `fail`** — `fail` names each miss as `metric got>cap`, e.g.
  `["draw.calls 512>300","cpuMs.p50 9>6"]`. Exit code 1 if any row fails.
* **`notes`** is where degradation is declared out loud: `cam:unpinned`, `settle:timeout`,
  `budget:off`, `heap:unavailable`, `epochs:no-feed-hook`, `reset:restarted@run`. A row with
  notes is still a real measurement, but read them before quoting the number.

`measure:'founding'` adds:

```json
"founding":{"settleMs":3410,"maxFrameMs":78,"framesOver50":3,"framesOver100":0,
            "buildingsAt3s":1200,"buildings":1200,"paintGroundCalls":10,"paintGroundMs":214}
```
`settleMs` is measured from the frame that queues the first plot to the frame the count
stops moving — and that first frame, the most expensive one in the product, is *inside* the
window. `paintGround*` arrive through `bench.add()` from `updateRoads`.

`measure:'epochs'` adds:

```json
"epochs":{"cycles":20,"armed":true,
          "samples":[{"geometries":412,"textures":19,"programs":24,"heapMB":86.4}, …],
          "drift":{"geometries":1,"textures":0,"programs":0,"heapMB":2.1},
          "probeDrift":{}}
```
`drift` is `median(last 3 cycles) − median(cycles 1-3)`: cycle 0 pays every one-off
allocation, so including it would report a leak that is really a warm-up. **Pass = drift
`geometries ≤ 5`, `textures ≤ 2`, `programs ≤ 2`, `heapMB ≤ 8`.** `probeDrift` lists any
counter town.js's `probe()` hook reports that did not return to its first-cycle value —
`LADDER.length`, `bins.size`, `hitTargets.length` and friends (E12 #6).

A `cycles` count below 20, or a `no-teardown` / `cycle-timeout` note, **fails**: a leak bench
that stopped early proves nothing. `armed:false` + `skipped:true` means the `feed` hook was
not wired — that does not fail the build, it fails this README.

### Budgets (v4-engine.md §4 — the contract)

| scene | draws | tris | cpu p50 | cpu p99 |
|---|---|---|---|---|
| `s200` | ≤ 520 | ≤ 280 k | ≤ 3.5 ms | ≤ 7 ms |
| `s600` | ≤ 300 | ≤ 260 k | ≤ 4.5 ms | ≤ 9 ms |
| `s1200` | ≤ 300 | ≤ 300 k | ≤ 6.0 ms | ≤ 12 ms |
| `n1200` | ≤ 320 | ≤ 310 k | ≤ 6.5 ms | ≤ 13 ms |
| `z1200` | ≤ 700 | ≤ 420 k | ≤ 8.0 ms | ≤ 16 ms |

`found`: `maxFrameMs ≤ 90`, `framesOver50 ≤ 4`, `framesOver100 = 0`, `settleMs ≤ 4000`,
`paintGroundMs ≤ 60`, `buildingsAt3s ≥ 98 %` of the final count (a ratio, not a hard 1200:
some plans genuinely top out below `N_CAP` — every ribbon does, around 890-1108).

### Baselines, not absolutes

The bench measures a machine as much as a commit, so what travels between machines is the
ratio. Keep `bench-base.json` from the wave-0 run and diff later runs against it:

```js
import { compareRuns } from './town/src/renderer/bench.js';
import base from './bench-base.json' with { type: 'json' };
import cur  from './bench-now.json'  with { type: 'json' };
console.log(compareRuns(base, cur));   // [{scene, cpuP50, cpuP99, calls, triangles, regressed}]
```
`regressed` is `cpuP50 > 1.12×` or **any** growth in draw calls.

---

## 3 · Wiring (what the integration wave must land)

### `main.js` — the shell lane

```js
const isBench = process.argv.includes('--bench');
// vsync pins every frame to 16.7 ms and hides all throughput signal. Off, for bench only.
if (isBench) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
const isShotRun = process.argv.some(a => a.startsWith('--shot=')) || isBench;   // no single-instance lock
const headless  = !!shotPath || isBench;                                        // show:false, skipTaskbar:true
// --bench-size=1920x1080 → the BrowserWindow's width/height (default 1380x880).
// The scenes force feed=demo, so `startFeed()` can be skipped under --bench.
```

Forward to the page query, alongside the existing `hour/tokens/still/demo/feed/range/seed/intro`:
`bench` (as `'1'`), `bench-scene`, `bench-frames`, `bench-warmup`, `bench-shot` (as a
boolean — the file write stays in main), `bench-budget`, `bench-dpr`, `bench-pump`,
`bench-settle`.

Then route four console messages. `bench.js` never touches the filesystem:

```js
const rows = [];
let shots = Promise.resolve();                 // serialises capture BEFORE navigation
function route(message, level) {
  if (message.startsWith('TOWNBENCH ')) { try { rows.push(JSON.parse(message.slice(10))); } catch {} return; }
  if (message.startsWith('TOWNBENCH_SHOT ')) {
    const name = message.slice(15).trim();
    if (shotDir) shots = shots.then(async () => {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }).catch(e => console.error('[bench] shot failed:', e.message));
    return;
  }
  // The page owns the schedule; main only obeys. `query` is ready to hand to loadFile.
  if (message.startsWith('TOWNBENCH_LOAD ')) {
    const query = JSON.parse(message.slice(15));
    shots = shots.then(() => win.loadFile(indexPath, { query }));
    return;
  }
  if (message.startsWith('TOWNBENCH_DONE')) { shots.then(finishBench); return; }
  if (level >= 2) console.error('[page]', message);
}
// Electron ≤35 passes (event, level, message, line, source); ≥36 passes (event, details).
win.webContents.on('console-message', (...a) => {
  const d = (a[1] && typeof a[1] === 'object') ? a[1] : { level: a[1], message: a[2] };
  route(String(d.message), typeof d.level === 'number' ? d.level : ({ info: 1, warning: 2, error: 3 })[d.level] || 0);
});
// A hung run must never leave a stray process.
if (isBench) setTimeout(() => { console.error('[bench] watchdog fired'); app.exit(2); }, 180000);
```

`finishBench()` pretty-prints a table (scene · buildings · draws · tris · cpu p50/p99 ·
pass), writes `--bench-json` if given, and calls
`app.exit(rows.length && rows.every(r => r.pass) ? 0 : 1)`. Print a loud line for any row
with `skipped:true` — that is an unwired gate, not a green one.

### `town.js` — six lines and a hooks object (F1's owner lands these)

```js
// ── test hooks block ──
const BENCH_ON = Q.get('bench') !== null;
let bench = null, benchPinned = false;

// ── tick() ──
function tick(now) {
  const t0 = BENCH_ON ? performance.now() : 0;
  /* …existing body, unchanged, ending in renderer.render(scene, camera)… */
  if (bench) bench.sample(now, t0, {
    buildings: houses.length, villagers: npcs.count, spawnQ: spawnQ.length,
    lod: lod ? lod.mode : 'B', hot: lod ? lod.hotCount : houses.length,
    impostors: lod ? lod.activeCount : 0
  });
}

// ── the idle orbit drift, in tick() ──
if (!benchPinned) { idleT += dt; if (idleT > 3) az += dt * .045; }

// ── hardReset(), last line ──
if (bench) bench.reset();

// ── updateRoads(), around plan.paintGround(…) ──
const _pg = BENCH_ON ? performance.now() : 0;
plan.paintGround(roadCtx, roadX, { … });
if (bench) { bench.add('paintGroundCalls'); bench.add('paintGroundMs', performance.now() - _pg); }

// ── bottom of the file, just before requestAnimationFrame(frame) ──
if (BENCH_ON) bench = (await import('./bench.js')).initBench(renderer, Q, {
  feed: onData,                                  // REQUIRED by the leak gate
  pinCamera: cam => {                            // freeze the idle drift; cam = [az, pol, dist]
    benchPinned = true;
    if (cam) { az = cam[0]; pol = cam[1]; dist = cam[2]; userDist = true; }
    applyCam();
  },
  probe: () => ({ ladder: LADDER.length, bins: bins.size, cells: cell.size,
                  animEnts: animEnts.length, hitTargets: hitTargets.length,
                  floaters: floaters.length, liveScaf: liveScaf.length, fxQ: fxQ.length })
});
```

Notes for the integrator:

* **Import it behind the flag only.** town.js must not import anything from `bench.js` on
  the normal path; the dynamic import keeps the cost at exactly zero.
* `renderer.info.autoReset` is `true`, so `sample()` must be the **last** statement of
  `tick`, after `render()` — that is the only moment `info.render.*` is readable.
* `pinCamera(null)` (every scene but `z1200`) must **not** set `userDist`: auto-framing has
  to keep working, only the slow idle rotation is frozen.
* `bench.reset()` is what tells the leak gate a teardown happened. Without it the gate falls
  back to observing the plat empty, which is slower but still correct.
* Post-F1 the `pinCamera` body becomes `rig.orbit()` / a `setFrame` pin — same contract.
* After E1, `lod` in the sample is the real LOD system; before it, the fallbacks above are
  correct and the row reads `lod:"B"`.

---

## 4 · The pump, and why `pumped` is in the row

A hidden Electron window is composited at a handful of frames a second no matter what
`backgroundThrottling:false` says, and 720 frames at 1 fps is twelve minutes — the whole
suite has ninety seconds. So while a bench scene is running, `bench.js` drives extra ticks
itself through town.js's existing `window.__tick` hook, off a `MessageChannel` macrotask (no
4 ms nesting clamp), and stops the moment the scene finishes. Consequences, all intended:

* `cpuMs` stays honest — it only ever measures the inside of `tick()`.
* `frameMs` becomes the pump's cadence: sustained throughput, not rAF. `pumped:true` says so.
* The pump stops before `TOWNBENCH_SHOT`, and the page holds the wall clock open for 700 ms,
  so `capturePage()` catches a real presented frame rather than a stale one.
* `--bench-pump=0` turns it off. Use it if a row looks impossible; expect a long run.

---

## 5 · Verification status

Verified in plain Node (`scratchpad/bench-sim.mjs`, 90 assertions, `node bench-sim.mjs`):
the scene table's token→building inversion, query construction and flag carry-over, the
percentile and mode laws, budget evaluation and the exact failure strings, `budget=off`,
the bootstrap→scene→scene→DONE protocol played back the way main.js will play it (7 rows,
in order), the founding measurement including its first frame, the leak gate against a clean
teardown and against injected 12-geometry and 1 MB-per-epoch leaks, the unwired-hook path,
`reset()` restarting a window an epoch switch invalidated, `dispose()` silencing everything,
and the pump carrying a 150-frame scene on a single rAF frame.

Still needs one in-app pass (nothing here is testable without a GPU and a shell):

1. `renderer.info` numbers against the real scene graph — the shapes are stubbed, the values
   are not.
2. The real headless frame rate, and therefore whether the suite lands inside 90 s.
3. `capturePage()` landing on the intended frame with the pump stopped.
4. `performance.memory` in Electron 34 (present in Chromium; the row degrades to
   `heap:unavailable` and a `heapMB` drift of 0 if it is not).
5. Whether 600 frames is enough for `cpuMs.p99` to settle on this machine — if p99 wanders
   between two runs of the same commit, raise `--bench-frames`.
