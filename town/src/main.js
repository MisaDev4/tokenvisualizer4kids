// Token Town shell — window management and plumbing only. All data knowledge
// lives in datafeed.js (spawned under the system Node.js so node:sqlite is
// available); all rendering lives in renderer/. Swap either independently.
// v4 adds two main-process concerns: the bench protocol (the page owns the
// schedule, main owns the files and the exit code) and the chronicle store —
// the one writer of town-chronicle.json.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const chronicle = require('./chronicle-store.js');

const argOf = name => {
  const a = process.argv.find(v => v.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const hasFlag = name => process.argv.some(v => v === `--${name}` || v.startsWith(`--${name}=`));

// Self-test hook: `electron . --shot=out.png [--shot-delay=4000]` renders the
// real town headlessly-ish, saves a screenshot, and exits.
const shotPath = argOf('shot');
const shotDelay = Number(argOf('shot-delay') || 4000);

// T-16 — AMBIENT AUDIO. Chromium's default autoplay policy hands back a
// SUSPENDED AudioContext until the page has seen a real user gesture, which is
// exactly why the town could sit there silent after launch: nothing in a town
// you only watch is a gesture. Token Town is a single-purpose desktop app the
// user opened on purpose — that IS the gesture — so the policy is lifted here.
// audio.js still keeps a gesture listener armed as a fallback for the case
// where the switch does not take, and still honours the mute toggle.
// MUST be set before app ready; command-line switches are read at that point.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The bench is a second headless mode. vsync pins every frame to 16.7 ms and
// hides all throughput signal, so it goes off — for the bench only.
const isBench = hasFlag('bench');
if (isBench) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}

// A screenshot or bench run must never be swallowed by an already-open window:
// it takes its own lock-free process, renders offscreen, and exits.
const isShotRun = !!shotPath || isBench;
if (!isShotRun && !app.requestSingleInstanceLock()) app.quit();
// Verification runs are ALWAYS headless: the window is never shown, never takes
// focus, and never appears in the taskbar. Verification must not hijack the
// user's screen. paintWhenInitiallyHidden + backgroundThrottling:false keep the
// renderer painting (and rAF firing) while hidden, so the capture is real.
const headless = isShotRun;

// The §4.7 interlock, decided here rather than trusted to the store: any run
// that fabricates the number, the seed, the clock or the data source leaves the
// chronicle read-only, so a verification screenshot never awards TEN BILLION
// forever. One-way — nothing downstream can clear it.
const SYNTHETIC = isShotRun || ['tokens', 'seed', 'hour', 'still', 'demo', 'range',
  'chronicle', 'mix', 'limits', 'limit-reset'].some(hasFlag) || argOf('feed') === 'demo';

const indexPath = path.join(__dirname, 'renderer', 'index.html');
let win = null;
let feed = null;
const pending = [];      // messages that arrived before the page finished loading
// The feed sends one `init` per epoch and `config` only when latitude changes. A
// renderer reload in between used to receive nothing but `buckets` — which the
// page drops until it has an init — so a reloaded window sat empty forever.
// Keep the last of each and replay them.
let lastInit = null;
let lastConfig = null;
// The depth lane is a DELTA stream — sendDepth only emits fields that moved — so a
// renderer reload that missed the init's block would sit with no depth at all
// until something happened to change. Latch the merged view and replay it.
let lastDepth = null;
let rendererReady = false;

function forward(msg) {
  if (msg && msg.type === 'init') lastInit = msg;
  else if (msg && msg.type === 'config') lastConfig = msg;
  else if (msg && msg.type === 'depth') lastDepth = Object.assign(lastDepth || { type: 'depth' }, msg);
  if (rendererReady && win && !win.isDestroyed()) win.webContents.send('town:data', msg);
  else pending.push(msg);
}

function startFeed() {
  const feedScript = path.join(__dirname, 'datafeed.js');
  // The renderer has no channel back to the feed, so range test hooks must reach
  // the feed itself — a `?range=` that only got as far as the page is cosmetic.
  const args = [feedScript];
  for (const k of ['range', 'gap', 'session-start', 'epoch-quantum', 'limits', 'limit-reset', 'mix', 'hide']) {
    const v = argOf(k);
    if (v !== null) args.push(`--${k}=${v}`);
  }
  feed = spawn('node', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  feed.on('error', () =>
    forward({ type: 'error', message: 'Could not start the data feed — is Node.js installed and on PATH?' }));
  feed.stderr.on('data', d => console.error('[datafeed]', String(d).trim()));
  readline.createInterface({ input: feed.stdout }).on('line', line => {
    try { forward(JSON.parse(line)); } catch { /* partial line on shutdown */ }
  });
}

/** The one navigation path. A bench scene switch supersedes the load in flight,
 *  so ERR_ABORTED (-3) is the protocol working rather than a failure. */
function loadPage(query) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  // EVERY verification load carries the headless marker into the page, bench
  // scene switches included (those arrive with their own query object and would
  // otherwise drop it). audio.js used to infer this from
  // `document.visibilityState === 'hidden'` — which is WRONG here:
  // paintWhenInitiallyHidden keeps the document 'visible' even with show:false,
  // as a --shot run reports directly. With sound on by default that mis-read
  // would have played the town's soundscape out of the user's speakers every
  // time an agent took a screenshot. Say it explicitly instead of guessing.
  const q = Object.assign({}, query || {});
  if (headless) q.headless = '1';
  return win.loadFile(indexPath, Object.keys(q).length ? { query: q } : undefined)
    .catch(e => { if (!e || e.errno !== -3) console.error('[shell] load failed:', (e && e.message) || e); });
}

/* ═══ the bench protocol (BENCH-README §3) ═════════════════════════
   bench.js never touches the filesystem and main never learns what a scene is:
   the page measures, prints four line protocols, and asks for the next load. */
const benchRows = [];
const benchShotDir = argOf('bench-shot') || (hasFlag('bench-shot') ? path.join(process.cwd(), 'bench-shots') : null);
const benchJson = argOf('bench-json');
let benchQ = Promise.resolve();   // serialises every capture BEFORE the next navigation

function finishBench() {
  const L = (s, n) => String(s).padEnd(n), R = (s, n) => String(s).padStart(n);
  console.log('');
  console.log(L('scene', 8) + R('bldgs', 7) + R('draws', 7) + R('tris k', 8) + R('cpu p50', 9) + R('cpu p99', 9) + '  result');
  for (const r of benchRows) {
    const d = r.draw || {}, c = r.cpuMs || {}, t = r.town || {};
    console.log(L(r.scene, 8) + R(t.buildings ?? '-', 7) + R(d.calls ?? '-', 7) +
      R(d.triangles === undefined ? '-' : Math.round(d.triangles / 1000), 8) +
      R(c.p50 ?? '-', 9) + R(c.p99 ?? '-', 9) + '  ' +
      (r.skipped ? 'SKIPPED' : r.pass ? 'pass' : 'FAIL ' + (r.fail || []).join(', ')));
    if (r.notes && r.notes.length) console.log('        notes: ' + r.notes.join(' '));
    // A skipped gate is an unwired gate, not a green one — say so loudly.
    if (r.skipped) console.error(`[bench] ${r.scene} did not run: the gate is UNWIRED, not passing.`);
  }
  if (benchJson) {
    try { fs.writeFileSync(benchJson, JSON.stringify(benchRows, null, 2)); console.log('bench json:', benchJson); }
    catch (e) { console.error('[bench] json write failed:', e.message); }
  }
  const ok = benchRows.length > 0 && benchRows.every(r => r.pass);
  console.log(`bench ${ok ? 'PASS' : 'FAIL'} — ${benchRows.length} scene(s)`);
  app.exit(ok ? 0 : 1);
}

/** @returns true when the line was a bench protocol line (and is not an error to log). */
function benchRoute(message) {
  if (message.startsWith('TOWNBENCH_SHOT ')) {
    const name = message.slice(15).trim().replace(/[^\w.-]/g, '_');
    // The page holds the wall clock open for ~700 ms; that is the whole window.
    if (benchShotDir) benchQ = benchQ.then(async () => {
      fs.mkdirSync(benchShotDir, { recursive: true });
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(benchShotDir, name + '.png'), img.toPNG());
    }).catch(e => console.error('[bench] shot failed:', e.message));
    return true;
  }
  if (message.startsWith('TOWNBENCH_LOAD ')) {
    let query = null;
    try { query = JSON.parse(message.slice(15)); } catch { console.error('[bench] unreadable load request'); return true; }
    benchQ = benchQ.then(() => loadPage(query));
    return true;
  }
  if (message.startsWith('TOWNBENCH_DONE')) { benchQ = benchQ.then(finishBench); return true; }
  if (message.startsWith('TOWNBENCH ')) {
    try { benchRows.push(JSON.parse(message.slice(10))); }
    catch { console.error('[bench] unreadable row'); }
    return true;
  }
  return false;
}

function createWindow() {
  // --bench-size=1920x1080 sizes the bench window; everything else gets the app's own.
  const size = /^(\d+)x(\d+)$/.exec(argOf('bench-size') || '');
  win = new BrowserWindow({
    width: size ? +size[1] : 1380, height: size ? +size[2] : 880,
    minWidth: 760, minHeight: 520,
    backgroundColor: '#0D0D0D',
    title: 'Token Town',
    autoHideMenuBar: true,
    show: !headless,
    skipTaskbar: headless,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  // forwarded to the page for visual tests. `--map=` from §4.9 is deliberately
  // absent: the Kingdom Map is cut from v4 and almanac.js ships no showMap().
  const query = {};
  for (const k of [
    // v3: day/night, forced token total, frozen feed, demo cadence, forced
    // seed/range, skipped founding ritual
    'hour', 'tokens', 'still', 'demo', 'feed', 'range', 'seed', 'intro',
    'post', 'lod',                                       // picture (lod=off|med|low: the
                                                         // A/B switch for the far town)
    'cam', 'select', 'shot-ui', 'ui',                    // place
    'wx', 'season', 'bow',                               // sky. `bow=0..1` pins the
                                                         // rainbow channel and NOTHING
                                                         // else, so the sun stays put and
                                                         // the flag proves the physics
                                                         // rather than bypassing it.
                                                         // wxi/wxcover/moon are
                                                         // NOT forwarded: nothing in
                                                         // the renderer reads them, and
                                                         // a flag that silently does
                                                         // nothing is worse than no flag
    'chronicle', 'almanac', 'ledger',                    // memory / progression
    'event', 'eventAt',                                  // force a rare event, and when
    'market',                                            // market=demo sweeps a whole
                                                         // market day into 96 s; also
                                                         // on|arrive|setup|pack|mon..sun
    'audio',                                             // audio=chip mounts it inert for a
                                                         // docs shot; audio=on forces the
                                                         // engine on in a plain browser
    'limits', 'limit-reset', 'mix', 'hide',              // data depth (also sent to the feed)
    'bench', 'bench-scene', 'bench-frames', 'bench-warmup',
    'bench-budget', 'bench-dpr', 'bench-pump', 'bench-settle',
    'v3'                                                 // the feed-protocol pin
  ]) {
    const v = argOf(k);
    if (v !== null) query[k] = v;
  }
  if (isBench) query.bench = query.bench || '1';         // `--bench` carries no value
  if (benchShotDir) query['bench-shot'] = '1';           // the page asks; the file write stays here
  loadPage(query);

  // surface page errors on stdout — a headless run has no devtools to open — and
  // carry the bench protocol on the same channel.
  if (headless) {
    // Electron <=35 passes (event, level, message, line, source); >=36 passes (event, details).
    win.webContents.on('console-message', (...a) => {
      const d = (a[1] && typeof a[1] === 'object') ? a[1] : { level: a[1], message: a[2] };
      const message = String(d.message ?? '');
      const level = typeof d.level === 'number' ? d.level : ({ info: 1, warning: 2, error: 3 })[d.level] || 0;
      if (isBench && benchRoute(message)) return;
      if (level >= 2) console.error('[page]', message);
    });
  }

  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, img.toPNG());
          console.log('shot saved:', shotPath);
        } catch (e) { console.error('shot failed:', e.message); }
        app.quit();
      }, shotDelay);
    });
  }
}

ipcMain.on('town:ready', () => {
  rendererReady = true;
  const queued = pending.splice(0);
  if (lastDepth && !queued.some(m => m.type === 'depth')) queued.unshift(lastDepth);
  if (lastConfig && !queued.some(m => m.type === 'config')) queued.unshift(lastConfig);
  if (lastInit && !queued.some(m => m.type === 'init')) queued.unshift(lastInit);
  // The record has to reach the renderer AHEAD of the first init — including a
  // replayed one — or a cold open re-awards badges that were already earned.
  queued.unshift(chronicle.message());
  for (const msg of queued) win.webContents.send('town:data', msg);
});

// Photo mode's "keep this one" (C6). A verification run never writes to Pictures.
ipcMain.handle('town:saveShot', async (_e, name, dataURL) => {
  if (isShotRun) return null;
  try {
    const dir = path.join(app.getPath('pictures'), 'Token Town');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, String(name || 'token-town.png').replace(/[^\w.-]/g, '_'));
    fs.writeFileSync(file, Buffer.from(String(dataURL).split(',')[1] || '', 'base64'));
    return file;
  } catch { return null; }   // a keepsake is not worth an error banner
});

app.on('second-instance', () => {
  if (win && !headless) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  chronicle.configure({ synthetic: SYNTHETIC });
  chronicle.load();                          // sync, before the window opens
  // Every bench scene forces `feed=demo`, which takes the renderer's no-bridge
  // path — so the bench never spawns the feed and never reads the user's day.
  if (!isBench) startFeed();
  createWindow();
  chronicle.attach(ipcMain);
  // A hung run must never leave a stray process on the user's machine.
  if (isBench) setTimeout(() => { console.error('[bench] watchdog fired'); app.exit(2); }, 180000);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => chronicle.dispose());
app.on('quit', () => { if (feed) feed.kill(); });
