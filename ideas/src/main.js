// Ideas — the shell. Window management and plumbing only: every fact about the
// board lives in store.js, every pixel lives in renderer/. Swap either alone.
//
// LAUNCH WITH THE FILE, NOT THE FOLDER: `electron ideas\src\main.js`.
// `electron ideas` resolves its argument the way require() does — extensions
// before directories — so with ideas.json sitting next to the ideas\ folder it
// silently tries to run the board's DATA as the app and hangs. Ideas.cmd and
// the npm scripts all point at this file for that reason.
//
// Flags:
//   --shot=<abs.png> [--shot-delay=2500]   render offscreen, save a PNG, exit.
//                                          Hidden window, no taskbar entry, no
//                                          focus steal, no single-instance lock,
//                                          and READ-ONLY — a verification run can
//                                          never touch the real ideas.json.
//   --data=<dir|file.json>                 point the store somewhere else (tests).
//   --readonly                             open the real board without write access.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./store.js');

const argOf = name => {
  const a = process.argv.find(v => v.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const hasFlag = name => process.argv.some(v => v === `--${name}` || v.startsWith(`--${name}=`));

const shotPath = argOf('shot');
const shotDelay = Number(argOf('shot-delay') || 2500);
const isShotRun = !!shotPath;
const readOnly = isShotRun || hasFlag('readonly');

// A screenshot run takes its own lock-free process so it can never be swallowed
// by an open window — and it is never shown, so it can never steal the screen.
if (!isShotRun && !app.requestSingleInstanceLock()) app.quit();
const headless = isShotRun;

// The store is configured before anything can ask it a question.
const dataArg = argOf('data');
store.configure({
  readOnly,
  ...(dataArg ? (/\.json$/i.test(dataArg)
    ? { jsonPath: dataArg, mdPath: dataArg.replace(/\.json$/i, '.md'), backupDir: path.join(path.dirname(dataArg), '.ideas-backups') }
    : { root: dataArg }) : {})
});

const pagePath = path.join(__dirname, 'renderer', 'index.html');

// ── window state ──────────────────────────────────────────────────────────────
// Kept beside the tracker's own data, not in the repo: the board's geometry is a
// machine preference, not a thing to commit.
const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA ||
  path.join(os.homedir() || '.', 'AppData', 'Local');
const STATE_PATH = path.join(localAppData, 'TokenTracker', 'ideas-window.json');
const DEFAULT_STATE = { width: 1460, height: 900, x: null, y: null, maximized: false };

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
    return {
      width: Math.max(900, n(s.width, DEFAULT_STATE.width)),
      height: Math.max(560, n(s.height, DEFAULT_STATE.height)),
      x: n(s.x, null), y: n(s.y, null),
      maximized: !!s.maximized
    };
  } catch { return { ...DEFAULT_STATE }; }
}

let saveStateTimer = null;
function saveState() {
  if (!win || win.isDestroyed() || headless) return;
  const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const state = { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* geometry is not worth an error */ }
}
const scheduleSaveState = () => {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveState, 400);
  if (saveStateTimer.unref) saveStateTimer.unref();
};

// ── window ────────────────────────────────────────────────────────────────────

let win = null;
let unwatch = null;

function createWindow() {
  const s = loadState();
  win = new BrowserWindow({
    width: s.width, height: s.height,
    ...(s.x !== null && s.y !== null ? { x: s.x, y: s.y } : {}),
    minWidth: 900, minHeight: 560,
    backgroundColor: '#0D0D0D',
    title: 'Ideas',
    autoHideMenuBar: true,
    show: !headless,
    skipTaskbar: headless,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false
    }
  });
  if (s.maximized && !headless) win.maximize();
  win.loadFile(pagePath).catch(e => console.error('[ideas] load failed:', (e && e.message) || e));

  win.on('resize', scheduleSaveState);
  win.on('move', scheduleSaveState);
  win.on('close', saveState);

  // A headless run has no devtools, so page errors go to stdout where the
  // verification script can see them.
  if (headless) {
    win.webContents.on('console-message', (...a) => {
      const d = (a[1] && typeof a[1] === 'object') ? a[1] : { level: a[1], message: a[2] };
      const level = typeof d.level === 'number' ? d.level : ({ info: 1, warning: 2, error: 3 })[d.level] || 0;
      if (level >= 2) console.error('[page]', String(d.message ?? ''));
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[ideas] did-fail-load', code, desc));
  }

  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, img.toPNG());
          console.log('shot saved:', shotPath);
        } catch (e) { console.error('shot failed:', e.message); }
        app.exit(0);
      }, shotDelay);
    });
  }
}

// ── IPC (see preload.js for the renderer-side contract) ───────────────────────

ipcMain.handle('ideas:load', () => {
  const { doc, notice } = store.load();
  return { ok: true, doc, notice, readOnly: store.readOnly, path: store.paths.json };
});

ipcMain.handle('ideas:save', (_e, incoming) => store.save(incoming));

// ── lifecycle ─────────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.whenReady().then(() => {
  store.load();                       // sync, before the window asks
  createWindow();
  // An agent rewriting ideas.json must show up on the board without a restart.
  unwatch = store.watch(doc => {
    if (win && !win.isDestroyed()) win.webContents.send('ideas:changed', doc);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (unwatch) unwatch(); store.dispose(); });
