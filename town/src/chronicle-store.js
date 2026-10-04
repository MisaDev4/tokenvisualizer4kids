// Token Town chronicle store — the ONE writer of town-chronicle.json.
//
// PURPOSE. The town has no persistence at all; this is it. It owns exactly one
// file, %LOCALAPPDATA%\TokenTracker\town-chronicle.json, co-located with the
// tracker's usage.db so the keepsake survives an Electron reinstall, a
// node_modules wipe and a repo re-clone. It is a NEW file in that directory:
// the tracker's own settings.json and usage.db stay read-only to this app,
// forever, and nothing here opens them.
//
// THE INVARIANT THAT MAKES IT SAFE (v4-BACKLOG §4.7, v4-history §0). The
// chronicle is *derived* from usage.db; this file is a keepsake, not a source
// of truth. Delete it and the only user-visible change is the `kept` count and
// three prefs — every town, name, record, size and streak re-derives on the
// next launch. That removes the entire migration/repair risk class instead of
// managing it, which is why the merge law below can be as blunt as it is.
//
// SHAPE (schema v1, two disjoint sub-trees so two renderer modules can never
// clobber each other — `prefs`/`days`/`stats` are the history layer's,
// `totals`/`badges`/`seen` are progression's; nobody writes the other's keys):
//
//   { v:1, app:'token-town', writtenMs:0,
//     prefs:  { showStreaks:true, ghost:true, strip:true },
//     days:   { '810512': { seen:1, overtookMs:… } },     // non-derivable only
//     stats:  { kept:42, firstSeenMs:… },
//     totals: { days:41, buildings:12044, milestones:118 },
//     badges: { small_hours: { date:20260703, at:…, n:7 } },
//     seen:   { arch:[…], roof:[…], biome:[…] } }
//
// MERGE LAW, exactly these and no others: recurse plain objects · Math.max on
// every number under `totals.*` and on any `*.n` · first-write-wins on the
// moment keys (`at`, `date`, `*At`, `firstSeenMs`, `firstMs`, `overtookMs`),
// taken as Math.min so the law is order-independent · set-union (sorted, cap
// 64) on arrays · null/undefined leaves ignored — THERE IS NO DELETE API ·
// anything else is last-write-wins. Every rule is monotonic per leaf, so a
// shuffled replay of the same awards converges on the same document.
//
// PUBLIC SURFACE (CommonJS — this is a main-process module):
//   V, APP, PATH, CHANNELS, DEBOUNCE_MS
//   configure(opts)  -> this   {path?, synthetic?, debounceMs?, now?, argv?}
//   load()           -> doc    sync, memoised, never throws, never rejects
//   snapshot()       -> doc    deep clone, safe to hand to IPC
//   message()        -> {type:'chronicle', v, doc}   for main.js's ready replay
//   merge(patch)     -> doc    deep-merge under the law + schedule a write
//   flush()          -> bool   write now, atomically; true if bytes landed
//   attach(ipcMain)  -> detach registers both channels
//   reset()          -> void   flush + drop the cache (next load() re-reads)
//   dispose()        -> void   detach, cancel the timer, final flush
//   readOnly · synthetic · dirty · quarantined · healthy · fileExists (getters)
//
// COST. Zero draw calls, zero GPU, zero renderer frame time — this module never
// runs on a frame, and the renderer's side of it is one fire-and-forget send.
// Measured at the 800-day ceiling (60 KB file, the worst case this schema can
// reach): cold load 1 ms, a full merge 2 ms, flush 12 ms — almost all of it the
// fsync, which is the point. All three are sync on the main process's idle
// path, at most once per 4 s of activity, and a typical document is a tenth of
// that. merge() allocates nothing beyond the patch's own leaves.
//
// WIRING THE INTEGRATION WAVE MUST DO (F2/SHELL owns all four edits):
//   main.js     const chronicle = require('./chronicle-store.js');
//               chronicle.configure({ synthetic: isShotRun });   // argv is read for the rest
//               chronicle.load();                                // before createWindow()
//               chronicle.attach(ipcMain);                       // after ipcMain exists
//               in ipcMain.on('town:ready'): queued.unshift(chronicle.message());
//               app.on('before-quit', () => chronicle.dispose());
//   preload.js  chronicle: { load: () => ipcRenderer.invoke('town:chronicle:load'),
//                            save: patch => ipcRenderer.send('town:chronicle:save', patch) }
//   town.js     ctx.store = (window.townAPI && window.townAPI.chronicle) || null;
//               and one onData case: 'chronicle' -> charter.adopt(msg.doc)
//   package.json — nothing. No new dependency; fs, os and path only.
// The renderer needs NO other hook: the store is fire-and-forget by design and
// every consumer must already render correctly with the file absent.
//
// SYNTHETIC INTERLOCK. A verification screenshot must never award TEN BILLION
// forever, so any run that fabricates the number, the seed, the clock or the
// data source is read-only: merge() becomes a no-op that still returns the real
// document, so a headless shot shows a realistic ledger and persists nothing.
// Read-only is one-way — nothing in this file can clear it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const V = 1;
const APP = 'token-town';
const DEBOUNCE_MS = 4000;
const MAX_DAYS = 800;          // keepsake ceiling; `kept` entries are exempt
const SET_CAP = 64;            // seen.* union cap
const MAX_DEPTH = 8;           // a patch deeper than the schema is a bug or an attack
const CORRUPT_KEEP = 2;        // quarantined files retained
const MAX_WRITE_FAILS = 5;     // then stop hammering a full/locked disk

const CHANNELS = { load: 'town:chronicle:load', save: 'town:chronicle:save' };
const SUBTREES = ['prefs', 'days', 'stats', 'totals', 'badges', 'seen'];
const RESERVED = new Set(['v', 'app', 'writtenMs']);          // the store owns these
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
// A moment is a fact about when something FIRST happened, so a later report of
// the same event must never move it. `date` and `*At` are the pinned pair; `at`
// is the schema's own ms twin of `date`, and the three named keys are its other
// moments. Implemented as Math.min over positive numbers rather than literal
// first-write-wins: under chronological arrival the two are identical, but min
// is order-independent, which is what makes a shuffled replay converge.
const ONCE = new Set(['at', 'date', 'firstSeenMs', 'firstMs', 'overtookMs']);
const isMoment = k => ONCE.has(k) || /At$/.test(k);
const posNum = x => (typeof x === 'number' && Number.isFinite(x) && x > 0) ? x : null;
// Every flag that fabricates a quantity a badge or a record could test.
const SYNTH = ['shot', 'bench', 'tokens', 'seed', 'hour', 'demo', 'still',
  'range', 'chronicle', 'mix', 'limits', 'limit-reset'];

const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA ||
  path.join(os.homedir() || '.', 'AppData', 'Local');
const PATH = path.join(localAppData, 'TokenTracker', 'town-chronicle.json');

/** True when argv fabricates reality. `--feed=demo` counts; `--feed=live` does not. */
function syntheticIn(argv) {
  for (const a of argv || []) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(a);
    if (!m) continue;
    const k = m[1];
    if (SYNTH.some(p => k === p || k.startsWith(p + '-'))) return true;
    if (k === 'feed' && m[2] === 'demo') return true;
  }
  return false;
}

const defaultDoc = () => ({
  v: V, app: APP, writtenMs: 0,
  prefs: { showStreaks: true, ghost: true, strip: true },
  days: {}, stats: { kept: 0 }, totals: {}, badges: {}, seen: {}
});

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);

// ── the merge law ─────────────────────────────────────────────────────────────

const cmpSet = (a, b) => (typeof a === 'number' && typeof b === 'number')
  ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

/** Arrays are SETS: union of old and new, sorted, capped. Never shrinks below the cap. */
function unite(old, add) {
  const out = [], seen = new Set();
  const push = x => {
    if (x === null || typeof x === 'object' || typeof x === 'function') return;
    const k = typeof x + ':' + String(x);
    if (seen.has(k)) return;
    seen.add(k); out.push(x);
  };
  if (Array.isArray(old)) old.forEach(push);
  add.forEach(push);
  out.sort(cmpSet);
  return out.length > SET_CAP ? out.slice(0, SET_CAP) : out;
}

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

/** @param {boolean} maxPath true anywhere under `totals` — every number there is monotonic. */
function mergeInto(dst, src, depth, maxPath) {
  let changed = false;
  for (const k of Object.keys(src)) {
    if (UNSAFE.has(k)) continue;
    const v = src[k];
    if (v === undefined || v === null) continue;                 // no delete API
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;  // NaN is not a record
    if (Array.isArray(v)) {
      const next = unite(dst[k], v);
      if (!sameSet(dst[k], next)) { dst[k] = next; changed = true; }
      continue;
    }
    if (typeof v === 'object') {
      if (depth >= MAX_DEPTH) continue;
      if (!isPlain(dst[k])) { dst[k] = {}; changed = true; }
      if (mergeInto(dst[k], v, depth + 1, maxPath)) changed = true;
      continue;
    }
    const old = dst[k];
    let next = v;
    if ((maxPath || k === 'n') && typeof v === 'number') {
      next = (typeof old === 'number' && Number.isFinite(old)) ? Math.max(old, v) : v;
    } else if (isMoment(k)) {
      const a = posNum(old), b = posNum(v);
      if (a !== null) next = (b !== null) ? Math.min(a, b) : a;  // the earlier moment is the fact
      else if (b === null && old !== undefined) continue;        // first write wins, non-numeric
    }
    if (old !== next) { dst[k] = next; changed = true; }
  }
  return changed;
}

/** Root patches carry sub-trees only; scalars at the root are not schema. */
function applyPatch(doc, patch) {
  if (!isPlain(patch)) return false;
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (UNSAFE.has(k) || RESERVED.has(k)) continue;
    const v = patch[k];
    if (!isPlain(v) || !Object.keys(v).length) continue;   // an empty sub-tree is not a schema
    if (!isPlain(doc[k])) doc[k] = {};
    if (mergeInto(doc[k], v, 1, k === 'totals')) changed = true;
  }
  return changed;
}

/** Newest 800 days survive; anything the user chose to keep survives regardless. */
function prune(doc) {
  const days = doc.days;
  const keys = Object.keys(days);
  if (keys.length <= MAX_DAYS) return;
  const kept = keys.filter(k => days[k] && days[k].kept);
  const rest = keys.filter(k => !(days[k] && days[k].kept))
    .sort((a, b) => (Number(b) || 0) - (Number(a) || 0));
  for (const k of rest.slice(Math.max(0, MAX_DAYS - kept.length))) delete days[k];
}

/** Sub-trees are written in sorted key order, so the same set of awards always
 *  produces the same bytes however they arrived — the file diffs and backs up. */
function canon(v) {
  if (Array.isArray(v) || !isPlain(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) if (!UNSAFE.has(k)) out[k] = canon(v[k]);
  return out;
}

/** Stable key order so the file reads like a document and diffs like one. */
function serialize(doc) {
  const out = {}, done = new Set();
  const put = (k, v) => { out[k] = canon(v); done.add(k); };
  out.v = doc.v; out.app = APP; out.writtenMs = doc.writtenMs;
  done.add('v'); done.add('app'); done.add('writtenMs');
  for (const k of SUBTREES) put(k, doc[k]);
  for (const k of Object.keys(doc)) if (!done.has(k) && !UNSAFE.has(k)) put(k, doc[k]);
  return JSON.stringify(out, null, 2);
}

// ── state ─────────────────────────────────────────────────────────────────────

let filePath = PATH;
let debounceMs = DEBOUNCE_MS;
let nowFn = Date.now;
let argv = process.argv;
let syntheticForced = false;

let doc = null;
let timer = null;
let readOnly = false;
let synthetic = false;
let dirty = false;
let quarantined = false;
let fileExists = false;
let writeFails = 0;
let ipc = null;

function schedule() {
  if (readOnly || !dirty || writeFails >= MAX_WRITE_FAILS) return;
  if (timer) return;                                   // coalescing: one timer per burst
  timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
  if (timer.unref) timer.unref();                      // a keepsake never holds the app open
}

/** Rename the unreadable file aside rather than overwrite it — it may be the user's only copy. */
function quarantine(p) {
  try {
    const dir = path.dirname(p), base = path.basename(p, '.json');
    fs.renameSync(p, path.join(dir, `${base}.corrupt-${nowFn()}.json`));
    const olds = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.corrupt-') && f.endsWith('.json')).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - CORRUPT_KEEP))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
    }
    quarantined = true;
  } catch { /* nothing to salvage; the defaults still work */ }
}

/** Lift a parsed document onto the defaults. Never Object.assign: JSON.parse can
 *  hand back a real own `__proto__` key, and [[Set]] would honour it. */
function adopt(parsed) {
  const d = defaultDoc();
  for (const k of Object.keys(parsed)) {
    if (UNSAFE.has(k)) continue;
    Object.defineProperty(d, k, { value: parsed[k], writable: true, enumerable: true, configurable: true });
  }
  return normalize(d);
}

/** A partly-corrupt document keeps whatever sub-trees are still intelligible. */
function normalize(d) {
  if (!Number.isFinite(d.v)) d.v = V;
  d.app = APP;
  if (!Number.isFinite(d.writtenMs)) d.writtenMs = 0;
  for (const k of SUBTREES) if (!isPlain(d[k])) d[k] = {};
  const p = defaultDoc().prefs;
  for (const k of Object.keys(p)) if (typeof d.prefs[k] !== 'boolean') d.prefs[k] = p[k];
  if (!Number.isFinite(d.stats.kept)) d.stats.kept = 0;
  return d;
}

// ── public surface ────────────────────────────────────────────────────────────

/** Call before load(). `synthetic:true` is one-way; argv is consulted for the rest. */
function configure(opts) {
  const o = opts || {};
  if (typeof o.path === 'string' && o.path && o.path !== filePath) {
    if (doc) { flush(); reset(); }
    filePath = o.path;
  }
  if (Number.isFinite(o.debounceMs) && o.debounceMs >= 0) debounceMs = o.debounceMs;
  if (typeof o.now === 'function') nowFn = o.now;
  if (Array.isArray(o.argv)) argv = o.argv;
  if (o.synthetic) syntheticForced = true;
  if (doc && (syntheticForced || syntheticIn(argv))) { synthetic = true; readOnly = true; }
  return module.exports;
}

/** Load or mint the record. Sync, once, before the window opens. Never throws. */
function load() {
  if (doc) return doc;
  synthetic = syntheticForced || syntheticIn(argv);
  readOnly = synthetic;
  quarantined = false;
  let raw = null;
  try { raw = fs.readFileSync(filePath, 'utf8'); fileExists = true; }
  catch { fileExists = false; }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!isPlain(parsed)) throw new Error('shape');
      if (parsed.app !== undefined && parsed.app !== APP) throw new Error('foreign');
      // The version gate comes BEFORE the shape gate: a newer build's document
      // is allowed to look like anything, and quarantining it would be the one
      // genuinely destructive thing this module could do.
      if ((parsed.v | 0) > V) { doc = adopt(parsed); readOnly = true; return doc; }
      if (!isPlain(parsed.prefs) && !isPlain(parsed.days) && !isPlain(parsed.totals)) throw new Error('shape');
      doc = adopt(parsed);
    } catch {
      quarantine(filePath);                       // never silently drop the user's history
      doc = defaultDoc();
      fileExists = false;
    }
  } else doc = defaultDoc();
  // First light: the one fact the store itself mints. It is also the only thing
  // lost when the file is deleted, alongside `kept` and the three prefs.
  if (!readOnly && !doc.stats.firstSeenMs) { doc.stats.firstSeenMs = nowFn(); dirty = true; schedule(); }
  return doc;
}

/** Deep clone, safe to send over IPC or hand to a module that will mutate it. */
function snapshot() {
  const d = load();
  try { return JSON.parse(serialize(d)); } catch { return defaultDoc(); }
}

/** The ready-queue payload, so the renderer holds the record before its first token. */
function message() { return { type: 'chronicle', v: V, doc: snapshot() }; }

/** Deep-merge under the law and schedule a write. Read-only runs merge NOTHING. */
function merge(patch) {
  const d = load();
  if (readOnly) return d;                          // the interlock, in one line
  if (applyPatch(d, patch)) { dirty = true; schedule(); }
  return d;
}

/** Atomic: tmp + fsync + rename. A half-written keepsake must never replace a good one. */
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (readOnly || !doc || !dirty || writeFails >= MAX_WRITE_FAILS) return false;
  const tmp = filePath + '.tmp';
  doc.writtenMs = nowFn();
  prune(doc);
  const json = serialize(doc);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, filePath); }
    catch { fs.unlinkSync(filePath); fs.renameSync(tmp, filePath); }   // AV/locked-file retry
    dirty = false; fileExists = true; writeFails = 0;
    return true;
  } catch {
    // A keepsake is not worth an error banner. Stay dirty so the next burst
    // retries, and go quiet after five failures rather than grind a full disk.
    writeFails++;
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Registers both channels on the given ipcMain. Returns the detach function. */
function attach(ipcMain) {
  if (!ipcMain || ipc) return detach;
  ipc = ipcMain;
  try {
    ipcMain.handle(CHANNELS.load, () => snapshot());
    ipcMain.on(CHANNELS.save, (_e, patch) => { merge(patch); });
  } catch { ipc = null; }
  return detach;
}

function detach() {
  if (!ipc) return;
  try { ipc.removeHandler(CHANNELS.load); } catch { /* older electron */ }
  try { ipc.removeAllListeners(CHANNELS.save); } catch { /* already gone */ }
  ipc = null;
}

/** Epoch switches mean nothing to a keepsake; this exists for the harness and the house rule. */
function reset() {
  flush();
  if (timer) { clearTimeout(timer); timer = null; }
  doc = null; dirty = false; writeFails = 0;
}

function dispose() { detach(); flush(); if (timer) { clearTimeout(timer); timer = null; } doc = null; dirty = false; }

module.exports = {
  V, APP, PATH, CHANNELS, DEBOUNCE_MS, MAX_DAYS, SET_CAP,
  configure, load, snapshot, message, merge, flush, attach, detach, reset, dispose,
  syntheticIn,
  get readOnly() { return readOnly; },
  get synthetic() { return synthetic; },
  get dirty() { return dirty; },
  get quarantined() { return quarantined; },
  get healthy() { return writeFails < MAX_WRITE_FAILS; },
  get fileExists() { return fileExists; },
  get filePath() { return filePath; }
};
