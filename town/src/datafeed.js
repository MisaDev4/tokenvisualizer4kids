// Token Town data adapter — the ONLY thing in the app that knows where data
// comes from. Runs under the system Node.js (node:sqlite is built in there;
// Electron's bundled Node may not have it), reads Token Tracker's usage.db
// READ-ONLY, and speaks a tiny JSON-lines protocol on stdout (v4):
//
//   {type:'init', v:4, now, range:{…}, prev, lat, buckets:[{b,w,tok,model?}],
//                 todayTok, today:{…}, chronicle:{…}, depth:{…}}
//   {type:'buckets', now, buckets, prev?, todayTok?}   // absolute, live tail
//   {type:'depth', now, mix?, limits?, hidePersonal?}  // 2 s; unchanged fields omitted
//   {type:'config', lat}              // cosmetic — never resets the town
//   {type:'error', message}
//
// EVERY v4 FIELD IS OPTIONAL AND INDEPENDENTLY FALLIBLE. A v3 renderer ignores
// them; a v4 renderer treats an absent block as "that layer is unavailable" and
// stays dormant. A locked DB, a torn accounts.json or an old schema may cost one
// block and never the `init` — the town's core loop is one number and it has to
// keep working. Nothing here ever fails an init over history or depth.
//
// THE RANGE. The town mirrors whatever window Token Tracker has selected. The
// feed resolves `SelectedRange` from settings.json exactly the way the C# does
// (UsageDatabase.ResolveRange / ResolveSessionStartAsync), follows the file for
// changes, and emits exactly ONE `init` per *epoch* — the pair (rangeKey,
// epochId). The renderer treats an init with a new epochId as a full teardown
// and rebuild. Within an epoch the window anchor is FROZEN, which is what keeps
// the town's total monotonic; at a boundary it is recomputed exactly, so drift
// never accumulates. Every key's quantum is at most one local day, so midnight
// is an ordinary epoch boundary and the town is re-surveyed daily for free.
//
// Totals are ABSOLUTE sums, not deltas — rows in usage.db are upserted as
// responses stream, so re-reading the aggregate is the only upsert-proof
// approach. Nothing here ever writes: not the DB, not settings.json.
'use strict';

const fs = require('fs');
const path = require('path');

const INT_MS = 5 * 60 * 1000;          // the native bucket
const POLL_MS = 2000;
const MIN_MS = 60e3, HOUR_MS = 3600e3, DAY_MS = 864e5;
const TAIL_MS = 2 * HOUR_MS;           // how much of the window stays at native resolution
const CATCHUP_MAX = 12 * HOUR_MS;      // a longer sleep than this reinits instead of catching up
const LOOKBACK_MS = 30 * DAY_MS;       // session scan window (UsageDatabase.cs:1016)
// Same definition of "tokens" as Token Tracker's own totals.
const TOK_SUM = 'input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens';

// ── v4 knobs ──────────────────────────────────────────────────────────────────
const IDLE_MS = 10 * MIN_MS;           // town.js's break threshold, mirrored exactly
const CHRON_DAYS = 400;                // 13 months — enough for a year in review
const CHRON_BIN = 15 * MIN_MS;
const CHRON_MAX_MS = 10 * MIN_MS;      // the chronicle is rebuilt at most this often
const TODAY_TOK_MS = 30e3;             // how often `buckets` carries today's total
const SESS_MS = 60e3;                  // full-window distinct-session refresh
const SOFT_LOG_MS = 30e3;              // throttle on the "one layer is down" stderr note

// argv: `[db] [settings]` positionally (back-compat) plus `--flag=value` knobs.
const FLAGS = new Map();
const POS = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)=([\s\S]*)$/.exec(a);
  if (m) FLAGS.set(m[1], m[2]); else POS.push(a);
}
const flagNum = (name) => {
  const v = FLAGS.get(name);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const dataDir = path.join(process.env.LOCALAPPDATA || '', 'TokenTracker');
const dbPath = POS[0] || path.join(dataDir, 'usage.db');
const settingsPath = POS[1] || path.join(dataDir, 'settings.json');
const accountsPath = POS[2] || path.join(dataDir, 'accounts.json');

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function fail(message) { send({ type: 'error', message }); }
function log(line) { process.stderr.write(line + '\n'); }

let sqlite;
try {
  sqlite = require('node:sqlite');
} catch {
  fail('This Node.js has no built-in SQLite module (need Node 22.13+; found ' + process.version + ').');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  // THE PATH GOES TO STDERR, NOT TO THE PAGE. `dbPath` contains the Windows
  // profile name, and this string is rendered verbatim in the error banner —
  // which is exactly the thing a user screenshots into a bug report. The
  // developer still gets the full path on the log channel, where it is useful
  // and nobody is looking at it.
  log('database not found at ' + dbPath);
  fail("Token Tracker's database has not been created yet — run Token Tracker at least once.");
  process.exit(1);
}

// Read-only is the polite mode (we must never write to the tracker's DB), but
// a WAL database can refuse read-only open when no writer is around to own
// the -shm file. Fall back to a normal open — we still only ever SELECT.
let db;
try {
  db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  db.prepare('SELECT COUNT(*) FROM usage_events').get();
} catch {
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.prepare('SELECT COUNT(*) FROM usage_events').get();
  } catch (e) {
    fail('Could not open usage.db: ' + e.message);
    process.exit(1);
  }
}

// ── statements ────────────────────────────────────────────────────────────────
// The live tail keeps the model dimension (the renderer's `cell` map is keyed by
// bucket|model so an upsert can only ever raise a cell, never double-count).
const tailStmt = db.prepare(`
  SELECT (timestamp_ms / ${INT_MS}) * ${INT_MS} AS b, model, SUM(${TOK_SUM}) AS tok
  FROM usage_events
  WHERE timestamp_ms >= ?
  GROUP BY b, model
  ORDER BY b`);

// Folded history: one row per bin, model dimension collapsed. `all` at 6 h is
// 394 rows instead of 13 639 at 5 min — the init stays a ~22 KB message.
const histCache = new Map();
function histStmtFor(binMs) {
  let s = histCache.get(binMs);
  if (!s) {
    s = db.prepare(`
      SELECT (timestamp_ms / ${binMs}) * ${binMs} AS b, SUM(${TOK_SUM}) AS tok
      FROM usage_events
      WHERE timestamp_ms >= ? AND timestamp_ms < ?
      GROUP BY b
      ORDER BY b`);
    histCache.set(binMs, s);
  }
  return s;
}

const spanStmt = db.prepare(
  `SELECT SUM(${TOK_SUM}) AS tok FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?`);
const maxStmt = db.prepare('SELECT MAX(timestamp_ms) AS m FROM usage_events');
// The session boundary query, verbatim from UsageDatabase.cs:1019-1029.
const gapStmt = db.prepare(`
  SELECT timestamp_ms FROM (
    SELECT timestamp_ms, timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY timestamp_ms) AS gap
    FROM usage_events WHERE timestamp_ms >= ?)
  WHERE gap >= ? ORDER BY timestamp_ms DESC LIMIT 1`);
const firstStmt = db.prepare('SELECT MIN(timestamp_ms) AS m FROM usage_events WHERE timestamp_ms >= ?');
// …and the same thing bounded above, for "the session before this one".
const gapBeforeStmt = db.prepare(`
  SELECT timestamp_ms FROM (
    SELECT timestamp_ms, timestamp_ms - LAG(timestamp_ms) OVER (ORDER BY timestamp_ms) AS gap
    FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?)
  WHERE gap >= ? ORDER BY timestamp_ms DESC LIMIT 1`);
const firstBeforeStmt = db.prepare(
  'SELECT MIN(timestamp_ms) AS m FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?');

function readTail(fromMs) {
  return tailStmt.all(fromMs)
    .map(r => ({ b: Number(r.b), w: INT_MS, model: r.model, tok: Number(r.tok) }));
}
function readHistory(fromMs, toMs, binMs) {
  return histStmtFor(binMs).all(fromMs, toMs)
    .map(r => ({ b: Number(r.b), w: binMs, tok: Number(r.tok) }));
}
function readSpan(fromMs, toMs) {
  try { return Number(spanStmt.get(fromMs, toMs).tok) || 0; } catch { return 0; }
}
function maxEventMs() {
  try { return Number(maxStmt.get().m || 0); } catch { return 0; }
}

/* ── protocol v4 statements ───────────────────────────────────────────────────
   `cache_write_1h_tokens` arrived in a later tracker migration, so a database
   written by an older build has no such column and `prepare` would throw at
   load — taking the whole feed down over a field nobody has yet. Sniff it once
   and substitute a literal zero. */
const HAS_CW1 = (() => {
  try { return !!db.prepare("SELECT 1 FROM pragma_table_info('usage_events') WHERE name = 'cache_write_1h_tokens'").get(); }
  catch { return false; }
})();

// Today at native resolution: the day block, `todayTok` and the break count all
// fold out of this one indexed scan (5.8 ms on a 259 k-row database).
const todayStmt = db.prepare(`
  SELECT (timestamp_ms / ${INT_MS}) * ${INT_MS} AS b, SUM(${TOK_SUM}) AS tok,
         MIN(timestamp_ms) AS f, MAX(timestamp_ms) AS l
  FROM usage_events
  WHERE timestamp_ms >= ? AND timestamp_ms < ?
  GROUP BY b
  ORDER BY b`);

// The chronicle scans 13 months at 15 min — coarse enough that a heavy year is
// ~4 400 rows (113 ms), fine enough that every row lands inside one local day.
const chronStmt = db.prepare(`
  SELECT (timestamp_ms / ${CHRON_BIN}) * ${CHRON_BIN} AS b, SUM(${TOK_SUM}) AS tok
  FROM usage_events
  WHERE timestamp_ms >= ?
  GROUP BY b
  ORDER BY b`);

// The mix, additively: every column here is a SUM, which is what lets the live
// value be (frozen history + re-read tail) instead of a full-window re-scan.
const mixStmt = db.prepare(`
  SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr,
         SUM(cache_write_tokens) cw, ${HAS_CW1 ? 'SUM(cache_write_1h_tokens)' : '0'} cw1,
         SUM(reasoning_tokens) rs, SUM(message_count) msg
  FROM usage_events
  WHERE timestamp_ms >= ? AND timestamp_ms < ?`);
// COUNT(DISTINCT) is the one non-additive column, so it gets its own slow lane.
const sessStmt = db.prepare(
  'SELECT COUNT(DISTINCT session_id) s FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?');

// ── range algebra (mirrors the C# exactly) ────────────────────────────────────
const HOURS = { last1: 1, last4: 4, last8: 8, last12: 12, last18: 18, last24: 24 };
const DAYS = { last7: 7, last10: 10, last15: 15, last30: 30 };
// Epoch quantum per key: how often the town is torn down and re-surveyed.
// Absent ⇒ one local day. A teardown is a big visual event; 15 min is a rhythm,
// 5 min would be a nervous tic.
const QUANTUM = { last1: 15 * MIN_MS, last4: 30 * MIN_MS, last8: HOUR_MS, last12: HOUR_MS, last18: 2 * HOUR_MS, last24: 2 * HOUR_MS };

const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
// A strictly-increasing integer that ticks over at LOCAL midnight, DST included.
const dayIndex = ms => {
  const d = new Date(ms);
  return d.getFullYear() * 400 +
    Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / DAY_MS);
};

// MainWindow.xaml.cs:4524 verbatim.
const normalizeRangeKey = k =>
  k === 'previousMonth' ? 'currentMonth'
    : (k === 'session' || k === 'today' || k === 'currentMonth' || k === 'all'
      || HOURS[k] !== undefined || DAYS[k] !== undefined) ? k : 'last7';

// 32-bit FNV-1a — the epoch id becomes the town's layout seed.
const seedOf = s => {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
};

// History resolution self-tunes off the SPAN, not the key.
const binFor = span =>
  span <= 6 * HOUR_MS ? INT_MS
    : span <= 36 * HOUR_MS ? 15 * MIN_MS
      : span <= 45 * DAY_MS ? HOUR_MS
        : 6 * HOUR_MS;

const quantumOverride = flagNum('epoch-quantum');   // test hook: force a live epoch reset

/* ── latitude, from the operating system ──────────────────────────────────────
   Day length drives the whole sky: sunrise/sunset chip, lamp lighting, star
   opacity, the night exodus. A handful of city zones plus a continent fallback
   gets it inside a few degrees anywhere, which is far better than a constant. */
const TZ_LAT = {
  'Europe/London': 51.5, 'Europe/Dublin': 53.3, 'Europe/Lisbon': 38.7, 'Europe/Madrid': 40.4,
  'Europe/Paris': 48.9, 'Europe/Brussels': 50.8, 'Europe/Amsterdam': 52.4, 'Europe/Berlin': 52.5,
  'Europe/Zurich': 47.4, 'Europe/Rome': 41.9, 'Europe/Vienna': 48.2, 'Europe/Prague': 50.1,
  'Europe/Warsaw': 52.2, 'Europe/Stockholm': 59.3, 'Europe/Oslo': 59.9, 'Europe/Helsinki': 60.2,
  'Europe/Copenhagen': 55.7, 'Europe/Athens': 38.0, 'Europe/Kyiv': 50.5, 'Europe/Moscow': 55.8,
  'Europe/Istanbul': 41.0, 'Europe/Bucharest': 44.4, 'Europe/Budapest': 47.5,
  'America/New_York': 40.7, 'America/Toronto': 43.7, 'America/Chicago': 41.9,
  'America/Denver': 39.7, 'America/Phoenix': 33.4, 'America/Los_Angeles': 34.1,
  'America/Vancouver': 49.3, 'America/Mexico_City': 19.4, 'America/Bogota': 4.7,
  'America/Lima': -12.0, 'America/Sao_Paulo': -23.5, 'America/Buenos_Aires': -34.6,
  'Asia/Tokyo': 35.7, 'Asia/Seoul': 37.6, 'Asia/Shanghai': 31.2, 'Asia/Hong_Kong': 22.3,
  'Asia/Singapore': 1.4, 'Asia/Bangkok': 13.8, 'Asia/Kolkata': 22.6, 'Asia/Calcutta': 22.6,
  'Asia/Dubai': 25.2, 'Asia/Jerusalem': 31.8, 'Asia/Tehran': 35.7, 'Asia/Jakarta': -6.2,
  'Australia/Sydney': -33.9, 'Australia/Melbourne': -37.8, 'Australia/Perth': -31.9,
  'Australia/Brisbane': -27.5, 'Pacific/Auckland': -36.9,
  'Africa/Cairo': 30.0, 'Africa/Lagos': 6.5, 'Africa/Nairobi': -1.3, 'Africa/Johannesburg': -26.2
};
const REGION_LAT = {
  Europe: 50, America: 38, Asia: 30, Africa: 5, Australia: -31,
  Pacific: -18, Atlantic: 38, Indian: -12, Antarctica: -70, UTC: 45, Etc: 45
};
function osLatitude() {
  try {
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
    if (TZ_LAT[tz] !== undefined) return TZ_LAT[tz];
    const region = tz.split('/')[0];
    if (REGION_LAT[region] !== undefined) return REGION_LAT[region];
  } catch { /* no Intl data: the default is a perfectly good northern town */ }
  return 50;
}

// The epoch id is the TEARDOWN trigger: it changes whenever the renderer must
// re-read the window from scratch.
function epochIdOf(key, now, sess) {
  const base = identityOf(key, now, sess);
  const q = quantumOverride || (key === 'session' ? 0 : (QUANTUM[key] || 0));
  if (!q) return base;
  // Slots are aligned to LOCAL midnight so a quantum boundary never drifts.
  return `${base}.${Math.floor((now - startOfDay(now)) / q)}`;
}
// The IDENTITY is what the town is called and how it is laid out, and it must NOT
// carry the quantum slot. It did, and `range.seed` is derived from it, so a
// rolling key re-surveyed itself into a completely different township — new name,
// new archetype, new street plan — every 15 minutes on `last1` and every 30 on
// `last4`, under a 600 ms crossfade the renderer explicitly calls "a re-survey,
// not a founding". A day-scoped identity means a re-quantum re-surveys the SAME
// town, which is what the design and the visual treatment both already assume.
function identityOf(key, now, sess) {
  if (key === 'session') return sess.manual ? `session:pin:${sess.startMs}` : `session:${sess.startMs}`;
  return `${key}:${dayIndex(now)}`;
}

const hhmm = ms => new Date(ms).toTimeString().slice(0, 5);
function sinceLabelOf(ms, now) {
  if (ms >= startOfDay(now)) return hhmm(ms);
  const d = new Date(ms);
  if (now - ms < 6 * DAY_MS) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(ms)}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function labelsFor(key, now, startMs, manual) {
  if (key === 'session') return { label: `Session · ${manual ? 'pinned' : 'since'} ${hhmm(startMs)}`, short: 'this session' };
  if (key === 'today') return { label: 'Today', short: 'today' };
  if (key === 'all') return { label: 'All time', short: 'all time' };
  if (key === 'currentMonth') {
    const d = new Date(startMs), name = d.toLocaleString(undefined, { month: 'long' });
    return {
      label: d.getFullYear() === new Date(now).getFullYear() ? name : `${name} ${d.getFullYear()}`,
      short: 'this month'
    };
  }
  const h = HOURS[key];
  if (h !== undefined) {
    return h === 1 ? { label: 'Last hour', short: 'the last hour' }
      : { label: `Last ${h} hours`, short: `the last ${h} h` };
  }
  const d = DAYS[key];
  return { label: `Last ${d} days`, short: `the last ${d} days` };
}

// ── settings follow ───────────────────────────────────────────────────────────
const argRange = FLAGS.has('range') ? normalizeRangeKey(String(FLAGS.get('range'))) : null;
const argGap = flagNum('gap');
// `--session-start=<ms>` pins; `--session-start=none` (or 0) explicitly UNpins,
// which is the only way to exercise the gap query while the tracker holds a pin.
const argPin = FLAGS.has('session-start') ? (flagNum('session-start') > 0 ? flagNum('session-start') : null) : undefined;

/* v4 test hooks (v4-datadepth §8). `--v3=1` pins the wire to protocol 3, which
   is the only way to prove "a v3 feed renders exactly v3" without checking out
   the old file; `--depth=0` keeps the history layer and drops depth alone. */
const PROTO = FLAGS.get('v3') === '1' || FLAGS.get('v3') === '' ? 3 : 4;
const DEPTH_ON = PROTO >= 4 && FLAGS.get('depth') !== '0';
const argLimits = FLAGS.has('limits') ? String(FLAGS.get('limits')).trim() : null;
const argLimitReset = flagNum('limit-reset');
const argMix = FLAGS.has('mix')
  ? String(FLAGS.get('mix')).split(',').map(Number).filter(n => Number.isFinite(n) && n >= 0)
  : null;
const argHide = FLAGS.get('hide') === '1';

let raw = { key: 'currentMonth', gapHours: 4, manualStartMs: null, lat: null, hide: false };  // AppSettings defaults
const effective = r => ({
  key: argRange || r.key,
  gapHours: argGap && argGap > 0 ? argGap : r.gapHours,
  manualStartMs: argPin !== undefined ? argPin : r.manualStartMs,
  lat: r.lat,
  hide: argHide || r.hide
});
let cfg = effective(raw);
let settingsStat = null;

// settings.json is 45 KB and the tracker rewrites ALL of it on tab switches, so
// stat-gate first and then content-compare only the four fields we care about.
// `File.WriteAllText` truncates before it writes, so torn reads are expected,
// not exceptional: on a parse failure return WITHOUT latching the stat.
function pollSettings() {
  let st;
  try { st = fs.statSync(settingsPath); } catch { return; }
  if (settingsStat && st.mtimeMs === settingsStat.mtimeMs && st.size === settingsStat.size) return;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return; }
  settingsStat = st;

  const gap = Number(doc.SessionGapHours);
  const next = {
    key: normalizeRangeKey(String(doc.SelectedRange ?? 'currentMonth')),
    gapHours: gap > 0 ? gap : 4,
    manualStartMs: typeof doc.ManualSessionStartMs === 'number' ? doc.ManualSessionStartMs : null,
    // The tracker has never written TownLatitude and (the C# is off limits) never
    // will, so `lat` stayed null forever and the sun clock was hard-coded to 50 N
    // for every user on earth. Fall back to the OS time zone, which is free and
    // right to within a few degrees.
    lat: typeof doc.TownLatitude === 'number' ? doc.TownLatitude : osLatitude(),
    // The tracker's own privacy switch, mirrored. Cosmetic, exactly like `lat`:
    // it re-emits `depth` on the next tick and never touches the epoch.
    hide: doc.HidePersonalData === true
  };
  if (next.key === raw.key && next.gapHours === raw.gapHours
    && next.manualStartMs === raw.manualStartMs && next.lat === raw.lat
    && next.hide === raw.hide) return;
  raw = next;

  const was = cfg;
  cfg = effective(raw);
  if (cfg.key !== was.key || cfg.gapHours !== was.gapHours || cfg.manualStartMs !== was.manualStartMs) {
    sessionDirty = true;    // the epoch compare in tick() turns this into a reinit
  } else if (cfg.lat !== was.lat) {
    send({ type: 'config', lat: cfg.lat });   // cosmetic — recolouring must not detonate the town
  }
}

// ── session ───────────────────────────────────────────────────────────────────
let sess = { startMs: 0, manual: false };
let sessionDirty = true;
let lastEventMs = 0;

const gapMsOf = () => Math.max(1, cfg.gapHours) * HOUR_MS;

function resolveSessionStart(now, gapMs) {
  const lookback = now - LOOKBACK_MS;
  try {
    const r = gapStmt.get(lookback, gapMs);
    if (r && r.timestamp_ms != null) return Number(r.timestamp_ms);
    const f = firstStmt.get(lookback);
    if (f && f.m != null) return Number(f.m);
  } catch { /* fall through to an honest empty window */ }
  return Math.floor(now / INT_MS) * INT_MS;
}

// The full LAG query costs 67 ms — too much for a 2 s poll. Its semantics are
// exactly "the newest event that follows a >= gap silence", so after the one
// authoritative resolution a new session is detectable in 0.09 ms: MAX() only
// moves when a genuinely new event lands, and backfilled rows can't fake it.
function refreshSession(now) {
  if (cfg.key !== 'session') return;
  if (cfg.manualStartMs != null) {
    // Clamped to now. A pin in the future made startMs > now, so both queries
    // returned nothing and the town was correctly empty — but prevFor still ran
    // with to = startMs, prevSessionStart happily returned the CURRENT real
    // session, and the footer under a town with zero buildings read "▼ 1.1B
    // behind your last session", with an unreachable finish line spliced into
    // the ladder to match.
    const pin = Math.min(cfg.manualStartMs, now);
    if (!sess.manual || sess.startMs !== pin) sess = { startMs: pin, manual: true };
    sessionDirty = false;
    return;
  }
  const gapMs = gapMsOf();
  if (sessionDirty || sess.manual || !sess.startMs) {
    sess = { startMs: resolveSessionStart(now, gapMs), manual: false };
    sessionDirty = false;
    lastEventMs = Math.max(sess.startMs, maxEventMs());
    return;
  }
  const m = maxEventMs();
  if (lastEventMs && m > lastEventMs && m - lastEventMs >= gapMs) sess.startMs = m;
  if (m > lastEventMs) lastEventMs = m;
}

function prevSessionStart(before, gapMs) {
  const lookback = before - LOOKBACK_MS;
  try {
    const r = gapBeforeStmt.get(lookback, before, gapMs);
    if (r && r.timestamp_ms != null) return Number(r.timestamp_ms);
    const f = firstBeforeStmt.get(lookback, before);
    if (f && f.m != null) return Number(f.m);
  } catch { /* no comparable window */ }
  return null;
}

// ── the epoch ─────────────────────────────────────────────────────────────────
let cur = null;              // the range object currently in force
let lastSentBucket = 0;
// failure back-off state (see sendInit): a persistently failing range query must
// not spin a 0.5 Hz SQL retry and an error line per poll for the rest of the day.
let failUntil = 0, lastFailAt = -1e9, lastFailMsg = '';

function buildRange(now) {
  const key = cfg.key;
  let startMs, lenMs = null, rolling = false, manual = false;
  if (key === 'session') { startMs = sess.startMs; manual = sess.manual; }
  else if (HOURS[key] !== undefined) { lenMs = HOURS[key] * HOUR_MS; startMs = now - lenMs; rolling = true; }
  else if (DAYS[key] !== undefined) { lenMs = DAYS[key] * DAY_MS; startMs = now - lenMs; rolling = true; }
  else if (key === 'today') startMs = startOfDay(now);
  else if (key === 'currentMonth') startMs = startOfMonth(now);
  else startMs = 0;                                            // 'all'

  const binMs = binFor(Math.max(INT_MS, now - startMs));
  // Floored to binMs so the last folded bin is whole and no bucket `b` can ever
  // be produced by both queries — the renderer's cell map cannot collide.
  const tailStartMs = Math.max(startMs, Math.floor(Math.max(0, now - TAIL_MS) / binMs) * binMs);
  const epochId = epochIdOf(key, now, sess);
  const identity = identityOf(key, now, sess);
  const { label, short } = labelsFor(key, now, startMs, manual);
  return {
    key, epochId, seed: seedOf(identity), seedStr: identity,
    startMs, lenMs, rolling, manual, dayIndex: dayIndex(now), binMs, tailStartMs,
    label, short, sinceLabel: key === 'all' ? null : sinceLabelOf(startMs, now),
    isDay: key === 'today' || key === 'session'
  };
}

// The one comparison the town is allowed to care about, in the shape of the
// range the user actually picked.
function prevFor(range, now) {
  const { key, startMs, lenMs } = range;
  let from = null, to = startMs, label = null;
  if (key === 'all') return null;
  // NAMES, NOT INSTRUCTIONS. These strings end up as a milestone title, a footer
  // row and a ladder label; 'beat …' made every one of them a second-person
  // imperative about spending, which the copy gate forbids. They name the window
  // being compared against and let the surface decide the sentence.
  if (key === 'today') { from = startOfDay(startMs - 12 * HOUR_MS); label = 'yesterday'; }   // DST-safe "yesterday"
  else if (key === 'currentMonth') {
    const d = new Date(startMs);
    from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    label = 'last month';
  } else if (key === 'session') {
    from = prevSessionStart(startMs, gapMsOf());
    label = 'your last session';
  } else if (lenMs) {
    from = startMs - lenMs;
    const h = HOURS[key];
    label = h !== undefined
      ? (h === 1 ? 'the previous hour' : `the previous ${h} h`)
      : `the previous ${DAYS[key]} days`;
  }
  if (from == null || !(to > from)) return null;
  if (startMs >= (now || Date.now())) return null;   // a window that has not opened has no rival
  const tok = readSpan(from, to);
  if (!(tok > 0)) return null;
  // PACE PARTNER. Racing a live, half-finished window against a completed one is
  // honest and joyless: the footer opened on "▼ 597M behind" and stayed there all
  // day. `atTok` is what the previous window had scored at the SAME elapsed
  // offset, which is the comparison a runner would actually make.
  const elapsed = Math.max(0, (now || Date.now()) - startMs);
  const atTok = elapsed >= to - from ? tok : readSpan(from, Math.min(to, from + elapsed));
  return { tok, atTok, label };
}

/* ═══ protocol v4 ═════════════════════════════════════════════════════════════
   Three additive layers — THE DAY, THE CHRONICLE, THE DEPTH — each with its own
   try/catch and its own throttled stderr note. None of them may ever reach
   `send({type:'error'})`: to the renderer that means "the feed is broken", and a
   missing almanac is not a broken feed. */

// One stderr line per failing layer per 30 s. A DB that is locked for an hour
// must not write 1 800 identical lines.
const softAt = new Map();
function softFail(tag, e, now) {
  if (now - (softAt.get(tag) || -1e9) < SOFT_LOG_MS) return;
  softAt.set(tag, now);
  log(`${tag} unavailable: ${(e && e.message) || e}`);
}

// ── the day ───────────────────────────────────────────────────────────────────
const dateNum = ms => {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

/** Today folded into the shape the almanac and the badge charter read, from
 *  local midnight to now. `hours` is local (every real UTC offset is a whole
 *  multiple of 15 min, so a 5-minute bucket never straddles an hour edge).
 *  `breaks` counts idle gaps with town.js's own IDLE_MS threshold, measured
 *  bucket-end to next-bucket-start and running the last gap out to `now` —
 *  the same arithmetic as `backfillGroves`, so the number in the almanac and
 *  the groves on the verge tell one story. */
function buildToday(now) {
  const from = startOfDay(now);
  const rows = todayStmt.all(from, now + 1);
  const hours = new Array(24).fill(0);
  let tok = 0, peakBucket = 0, breaks = 0, firstMs = 0, lastMs = 0, prevEnd = 0;
  for (const r of rows) {
    const b = Number(r.b), t = Number(r.tok) || 0;
    tok += t;
    if (t > peakBucket) peakBucket = t;
    hours[new Date(b).getHours()] += t;
    if (prevEnd && b - prevEnd >= IDLE_MS) breaks++;
    prevEnd = b + INT_MS;
    if (!firstMs) firstMs = Number(r.f) || b;
    lastMs = Math.max(lastMs, Number(r.l) || b);
  }
  if (prevEnd && now - prevEnd >= IDLE_MS) breaks++;   // the rest being taken right now
  return { date: dateNum(from), tok, hours, firstMs, lastMs, peakBucket, breaks };
}

// ── the chronicle ─────────────────────────────────────────────────────────────
let chronCache = null, chronAt = -1e9, chronDay = -1;

/** `days` is FLAT and ascending — [dayIdx, tok, dayIdx, tok, …] — with QUIET
 *  DAYS OMITTED. Absence is not data: the renderer fills the gaps with meadows,
 *  so there is no threshold here to tune and no zero to argue about. */
function buildChronicle(now) {
  const rows = chronStmt.all(startOfDay(now) - (CHRON_DAYS - 1) * DAY_MS);
  const acc = new Map();
  let firstMs = 0;
  for (const r of rows) {
    const tok = Number(r.tok);
    if (!(tok > 0)) continue;
    const b = Number(r.b);
    if (!firstMs) firstMs = b;
    const k = dayIndex(b);                       // LOCAL, DST-exact
    acc.set(k, (acc.get(k) || 0) + tok);
  }
  const keys = [...acc.keys()].sort((a, b) => a - b);
  const days = new Array(keys.length * 2);
  for (let i = 0; i < keys.length; i++) { days[i * 2] = keys[i]; days[i * 2 + 1] = acc.get(keys[i]); }
  return { days, firstMs, builtMs: now };
}

// Held across epochs and returned STALE on failure — history is the one thing
// that must never regress mid-session.
function chronicleFor(now) {
  const di = dayIndex(now);
  if (chronCache && di === chronDay && now - chronAt < CHRON_MAX_MS) return chronCache;
  try { chronCache = buildChronicle(now); chronAt = now; chronDay = di; }
  catch (e) { softFail('chronicle', e, now); }
  return chronCache;
}

// ── the depth · the mix ───────────────────────────────────────────────────────
const MIX_SUMS = ['i', 'o', 'cr', 'cw', 'cw1', 'rs', 'msg'];
const zeroMix = () => ({ i: 0, o: 0, cr: 0, cw: 0, cw1: 0, rs: 0, msg: 0 });

function readMix(fromMs, toMs) {
  const r = mixStmt.get(fromMs, toMs) || {};
  const out = zeroMix();
  for (const k of MIX_SUMS) out[k] = Number(r[k]) || 0;
  return out;
}

// The same two-resolution trick that keeps `all` at 22 KB: every mix column is a
// SUM, so the window before the live tail is frozen for the epoch (72 ms once)
// and only the tail is re-read (0.5 ms per poll). The result is an ABSOLUTE
// total every tick — upsert-proof, with nothing for the renderer to accumulate.
let mixHist = null, sessVal = 0, sessAt = -1e9;

function currentMix(now) {
  if (!mixHist || !cur) return null;
  const tail = readMix(cur.tailStartMs, now + 1);
  const out = zeroMix();
  for (const k of MIX_SUMS) out[k] = mixHist[k] + tail[k];
  // Distinct sessions cannot be added across the seam (one session spans it), so
  // this is a real full-window count on its own slow lane: 78 ms worst case
  // (`all`) once a minute is 0.13 % of a core, and the number moves that slowly.
  if (now - sessAt >= SESS_MS) { sessVal = Number(sessStmt.get(cur.startMs, now + 1).s) || 0; sessAt = now; }
  out.sess = sessVal;
  if (argMix) {                                 // --mix=<cr,cw,o>, for mill/forge extremes
    if (argMix.length > 0) out.cr = argMix[0];
    if (argMix.length > 1) out.cw = argMix[1];
    if (argMix.length > 2) out.o = argMix[2];
  }
  return out;
}

// ── the depth · plan limits ───────────────────────────────────────────────────
// accounts.json also holds AccessToken, RefreshToken, Email, Id and OrgUuid.
// This projection is the ONLY thing that ever leaves that file: a key, three
// numbers per row, the plan word, a fetch time and a count. Nothing else is read
// and nothing else may ever be added here.
const LIMIT_KEY = label => label === '5h' ? 'burst' : label === 'Week' ? 'week' : 'scoped';
const pctOf = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const sevOf = v => v === 'critical' || v === 'warning' ? v : 'normal';
const sevFor = pct => pct >= 95 ? 'critical' : pct >= 70 ? 'warning' : 'normal';
// Forced rows still need plausible clocks: the burst window turns over about
// five times a day, both weeklies on the same schedule.
const FORCED = [
  { key: 'burst', in: 3 * HOUR_MS },
  { key: 'week', in: 3 * DAY_MS },
  { key: 'scoped', in: 3 * DAY_MS }
];

let acctStat = null, limitsVal = null;

function readLimits() {
  let st;
  try { st = fs.statSync(accountsPath); } catch { return (limitsVal = null); }
  if (acctStat && st.mtimeMs === acctStat.mtimeMs && st.size === acctStat.size) return limitsVal;
  let doc;
  // Torn read of a file the tracker rewrites every few minutes: keep the last
  // good projection and do NOT latch the stat, exactly as pollSettings does.
  try { doc = JSON.parse(fs.readFileSync(accountsPath, 'utf8')); } catch { return limitsVal; }
  acctStat = st;

  const list = Array.isArray(doc && doc.Accounts) ? doc.Accounts : [];
  const withMeters = list.filter(a => a && Array.isArray(a.Limits) && a.Limits.length);
  // The tracker's hero meters belong to the SIGNED-IN account, and the file
  // records which one that is: `Timeline` is appended once per poll with
  // whatever the tracker resolved from the credentials on disk, so its newest
  // span names the same account — without this process ever reading a
  // credential. LastSeenActiveMs is only the fallback, because it is stamped on
  // every adopted credential (CLI *and* desktop app, milliseconds apart) rather
  // than on the winner alone.
  const spans = Array.isArray(doc && doc.Timeline) ? doc.Timeline : [];
  let tail = null;
  for (const s of spans) if (s && (!tail || Number(s.EndMs) > Number(tail.EndMs))) tail = s;
  let best = tail ? withMeters.find(a => a.Id === tail.AccountId) : null;
  if (!best) {
    for (const a of withMeters) {
      if (!best || (Number(a.LastSeenActiveMs) || 0) > (Number(best.LastSeenActiveMs) || 0)) best = a;
    }
  }
  const rows = best ? best.Limits.map(l => {
    const at = Date.parse(l && l.ResetsAt);
    return {
      key: LIMIT_KEY(String((l && l.Label) || '')),
      pct: pctOf(l && l.Percent),
      sev: sevOf(l && l.Severity),
      resetsAtMs: Number.isFinite(at) ? at : null
    };
  }) : [];
  // No accounts, or an account with no meters ⇒ null, and the town builds no
  // reservoir at all. An empty vessel would read as "you are out of water",
  // which is a lie; absence is the honest state.
  limitsVal = rows.length
    ? { plan: String(best.Plan || ''), fetchedMs: Number(best.LastFetchedMs) || 0, accounts: list.length, rows }
    : null;
  return limitsVal;
}

function limitsFor(now) {
  if (argLimits === 'none') return null;
  let out = readLimits();
  if (argLimits) {
    const pcts = argLimits.split(',').map(Number).filter(Number.isFinite);
    const rows = FORCED.slice(0, Math.max(1, pcts.length)).map((f, i) => {
      const pct = pctOf(pcts[i]);
      return { key: f.key, pct, sev: sevFor(pct), resetsAtMs: now + f.in };
    });
    out = { plan: (out && out.plan) || 'max', fetchedMs: now, accounts: (out && out.accounts) || 1, rows };
  }
  if (out && argLimitReset > 0) {
    // Put the burst window's turnover inside one screenshot so the refill
    // ceremony can be verified without waiting on the real clock.
    out = { ...out, rows: out.rows.map(r => r.key === 'burst' ? { ...r, resetsAtMs: now + argLimitReset } : r) };
  }
  // The plan word is the tracker's own ("max"). It is an account attribute, so
  // it is scrubbed at the source rather than trusted to the renderer — with the
  // switch on, a devtools inspection of the feed leaks nothing about the user.
  // `accounts` is how many Claude accounts are signed in — a personal fact, and
  // it was riding straight through the --hide scrub beside the plan word it was
  // supposed to sit next to.
  if (out && cfg.hide) out = { ...out, plan: '', accounts: 0 };
  return out;
}

// ── the depth · assembly ──────────────────────────────────────────────────────
// Signatures of the last values sent, so the 2 s tick can omit what has not
// moved. Seeded by the init, so the first tick after an epoch resends nothing.
const depthSig = { mix: '', limits: '', hide: '' };

function buildDepth(now, range) {
  if (!DEPTH_ON) return null;
  mixHist = null; sessAt = -1e9;
  const out = {};
  try {
    mixHist = range.tailStartMs > range.startMs ? readMix(range.startMs, range.tailStartMs) : zeroMix();
    const m = currentMix(now);
    if (m) out.mix = m;
  } catch (e) { mixHist = null; softFail('mix', e, now); }
  try { const l = limitsFor(now); if (l) out.limits = l; } catch (e) { softFail('limits', e, now); }
  out.hidePersonal = !!cfg.hide;
  depthSig.mix = JSON.stringify(out.mix || null);
  depthSig.limits = JSON.stringify(out.limits || null);
  depthSig.hide = String(out.hidePersonal);
  return out;
}

/** The 2 s tick. Emits nothing at all when nothing moved — which, on an idle
 *  machine with a settled accounts.json, is most ticks. */
function sendDepth(now) {
  if (!DEPTH_ON || !cur) return;
  let mix = null, lim = null;
  try { mix = currentMix(now); } catch (e) { softFail('mix', e, now); return; }
  try { lim = limitsFor(now); } catch (e) { softFail('limits', e, now); }
  const hide = !!cfg.hide;
  const sig = { mix: JSON.stringify(mix || null), limits: JSON.stringify(lim || null), hide: String(hide) };
  const out = { type: 'depth', now };
  let n = 0;
  if (sig.mix !== depthSig.mix) { out.mix = mix; depthSig.mix = sig.mix; n++; }
  if (sig.limits !== depthSig.limits) { out.limits = lim; depthSig.limits = sig.limits; n++; }
  if (sig.hide !== depthSig.hide) { out.hidePersonal = hide; depthSig.hide = sig.hide; n++; }
  if (n) send(out);
}

// ── the v4 block on `init` ────────────────────────────────────────────────────
let todayTokAt = 0, depthMs = 0, chronDays = 0;

function attachV4(msg, now, range) {
  if (PROTO < 4) return;
  const t0 = Date.now();
  let day = null;
  try { day = buildToday(now); } catch (e) { softFail('today', e, now); }
  if (day) { msg.today = day; msg.todayTok = day.tok; }
  else { const t = readSpan(startOfDay(now), now + 1); if (t > 0) msg.todayTok = t; }
  todayTokAt = now;

  const ch = chronicleFor(now);
  if (ch) { msg.chronicle = ch; chronDays = ch.days.length / 2; }

  const depth = buildDepth(now, range);
  if (depth) msg.depth = depth;
  depthMs = Date.now() - t0;
}

/** `todayTok` on the ordinary bucket message, at most once per 30 s. It is what
 *  keeps the streak and the ghost race live on a range that is not the day. */
function refreshTodayTok(now) {
  if (PROTO < 4 || now - todayTokAt < TODAY_TOK_MS) return undefined;
  todayTokAt = now;
  try { return readSpan(startOfDay(now), now + 1); } catch { return undefined; }
}

function sendInit(now, why) {
  const range = buildRange(now);
  let hist = [], tail = [];
  try {
    if (range.tailStartMs > range.startMs) hist = readHistory(range.startMs, range.tailStartMs, range.binMs);
    tail = readTail(range.tailStartMs);
  } catch (e) {
    // Back off. `cur` is only latched on success, so tick() re-evaluated the
    // epoch compare as still-changed and retried on EVERY 2 s poll — a locked or
    // corrupt DB produced an unbounded stream of identical error lines forever.
    const msg = 'Range query failed: ' + e.message;
    if (msg !== lastFailMsg || now - lastFailAt > 30000) { lastFailAt = now; lastFailMsg = msg; fail(msg); }
    failUntil = now + 30000;
    return false;
  }
  failUntil = 0; lastFailMsg = '';
  cur = range;
  lastSentBucket = Math.floor(now / INT_MS) * INT_MS;
  const msg = {
    type: 'init', v: PROTO, now, range,
    prev: prevFor(range, now),
    lat: cfg.lat,
    sessionStartMs: range.startMs,          // legacy alias — one release
    buckets: hist.concat(tail)
  };
  attachV4(msg, now, range);                // never throws; a dead layer is simply absent
  send(msg);
  log(`range=${range.key} start=${new Date(range.startMs).toISOString()} `
    + `bin=${range.binMs / 60e3}m bins=${hist.length}+${tail.length} epoch=${range.epochId} seed=${range.seed} (${why})`
    + (PROTO >= 4 ? ` v4=${chronDays}d/${depthMs}ms` : ' v3'));
  return true;
}

// Absolute totals for the live tail only — cost is independent of the range.
// Catch-up matters: a sleeping machine used to lose every bucket it slept
// through, because the poll only ever re-read the last two intervals.
function sendBuckets(now) {
  const curBucket = Math.floor(now / INT_MS) * INT_MS;
  if (now - lastSentBucket > CATCHUP_MAX) return void sendInit(now, 'catch-up');
  const from = Math.max(cur.tailStartMs, Math.min(curBucket - INT_MS, lastSentBucket));
  try { send({ type: 'buckets', now, buckets: readTail(from), prev: refreshPrev(now), todayTok: refreshTodayTok(now) }); }
  catch { return; }                          // transient lock — next poll catches up
  lastSentBucket = curBucket;
}

// THE PACE PARTNER HAS TO KEEP WALKING. prevFor's `atTok` is "what the previous
// window had at this same elapsed offset", and it was only ever computed inside
// sendInit — which fires on an epoch CHANGE. For `session` the epoch id is
// `session:<startMs>` and for `today` it is `today:<dayIndex>`; neither moves
// while you work. Open the town at 09:05 on `today`, leave it until 18:00, and
// the footer was still racing your live nine-hour total against yesterday-by-
// 09:05 — so the headline "▲ ahead of this point in your last session" inflated
// monotonically all day, which is exactly the dishonesty it was added to fix.
// (last1…last24 self-corrected only because their quantum re-inits.)
// One indexed aggregate a minute, folded into the ordinary bucket message.
let prevAt = 0, prevVal = null;
function refreshPrev(now) {
  if (!cur || now - prevAt < 60000) return undefined;
  prevAt = now;
  try { prevVal = prevFor(cur, now); } catch { return undefined; }
  return prevVal;
}

function tick() {
  try {
    pollSettings();
    const now = Date.now();
    refreshSession(now);
    if (!cur || epochIdOf(cfg.key, now, sess) !== cur.epochId) {
      if (now >= failUntil) sendInit(now, 'epoch');
    } else { sendBuckets(now); sendDepth(now); }
  } catch { /* transient lock / torn read — the next tick retries */ }
}

pollSettings();
refreshSession(Date.now());
// A FAILED FIRST READ IS NOT A FATAL ONE. sendInit returns false for any SQL
// failure — including the transient lock and the torn WAL read this file goes
// out of its way to expect everywhere else — and exiting here killed the feed
// for good, because main.js only watches for a spawn `error`, not a clean exit.
// Launching the town while the tracker happened to be mid-write therefore meant
// no data, ever, with nothing to restart it. sendInit has already set failUntil
// and reported the error, so the ordinary interval retries in 30 s. The two
// genuinely unrecoverable cases (no node:sqlite, no DB file) still exit above.
sendInit(Date.now(), 'start');
setInterval(tick, POLL_MS);
