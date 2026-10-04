// Ideas store — the one writer of ideas.json, and the only thing standing between
// the user's idea list and losing it. Everything else in this app is a view.
//
// ═══ THE FILES ══════════════════════════════════════════════════════════════
//   <repo>/ideas.json          SOURCE OF TRUTH. Read and written by this app AND
//                              by agent fleets. Small, sorted, human-editable.
//   <repo>/IDEAS.md            GENERATED on every save. Output only — it is never
//                              parsed back, with exactly one exception: the
//                              one-time migration when ideas.json does not exist.
//   <repo>/.ideas-backups/     ideas.prev.json (the file each save replaced),
//                              quarantined copies of anything that would not
//                              parse, and the pre-migration IDEAS.md. Read only
//                              when ideas.json itself is unreadable.
//
// ═══ SCHEMA (v1) ════════════════════════════════════════════════════════════
//   { "v":1, "app":"token-ideas", "rev":42, "writtenMs":…, "ideas":[ Idea, … ] }
//
//   Idea = {
//     id:            "T-13"        stable; T-n = Token Town, K-n = the tracker.
//                                  Minted when blank, never renumbered — the user
//                                  says "approve T-3".
//     title:         "Market day"  one line, the card's face.
//     note:          "…"           free text; why it's worth it / where it lives.
//     status:        "proposed"    inbox|proposed|approved|building|shipped|declined
//     size:          "M"           "" | S | M | L | S/M | M/L  (S≈hour M≈session L≈wave)
//     tags:          ["town"]      lowercase, deduped, ≤8. "tracker" picks the K prefix.
//     origin:        "claude"      "user" | "claude" — who put it on the board.
//     declineReason: ""            REQUIRED when status==="declined": the reason is
//                                  what stops the next agent wave re-pitching it.
//     result:        ""            one-line outcome, rendered on Shipped rows.
//     order:         3000          sort key within its column, ascending.
//     createdMs, updatedMs, statusMs   epoch ms.
//   }
//
// ═══ SAFETY, IN FULL ════════════════════════════════════════════════════════
// Writes are atomic (tmp + fsync + rename) and the file being replaced is copied
// to .ideas-backups/ideas.prev.json first. A file that will not parse is renamed
// aside, never overwritten, and the board reopens from ideas.prev.json. Every
// document — parsed file, IPC payload, migration output — is rebuilt field by
// field from a whitelist, so a save can never emit invalid JSON.
//
// This is a single-user board, so there is no merge: an agent that rewrites
// ideas.json while the window is open shows up through watch() within ~200ms,
// and if a save does land on top of an external write, that write is in
// ideas.prev.json.
//
// ═══ PUBLIC SURFACE (CommonJS, main process only) ═══════════════════════════
//   configure(opts) -> module   {root?, jsonPath?, mdPath?, backupDir?, readOnly?, now?}
//   load()          -> {doc, notice}   sync, memoised, never throws
//   save(doc)       -> {ok, doc, external, error?}
//   watch(cb)       -> unwatch         cb(doc) on any EXTERNAL change
//   dispose()       -> void
//   renderMarkdown(doc) / migrateFromMarkdown(text) / normDoc(raw)  (also for tests)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const V = 1;
const APP = 'token-ideas';
const STATUSES = ['inbox', 'proposed', 'approved', 'building', 'shipped', 'declined'];
const STATUS_SET = new Set(STATUSES);
const SIZES = ['', 'S', 'M', 'L', 'S/M', 'M/L'];
const ORIGINS = new Set(['user', 'claude']);

const CORRUPT_KEEP = 5;
const MAX_TAGS = 8;
const MAX_TITLE = 200;
const MAX_NOTE = 4000;
const WATCH_DEBOUNCE_MS = 180;
const NO_REASON = '(no reason recorded)';   // declined rows must always say something

const UNSAFE = ['__proto__', 'constructor', 'prototype'];

// ── small helpers ─────────────────────────────────────────────────────────────

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const str = (v, cap) => {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return cap && s.length > cap ? s.slice(0, cap) : s;
};
const oneLine = (v, cap) => str(v, cap).replace(/\s*\n+\s*/g, ' ');
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
const digest = text => crypto.createHash('sha1').update(text, 'utf8').digest('hex');
const clone = o => JSON.parse(JSON.stringify(o));

// ── configuration / state ─────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, '..', '..');
let paths = {
  json: path.join(repoRoot, 'ideas.json'),
  md: path.join(repoRoot, 'IDEAS.md'),
  backups: path.join(repoRoot, '.ideas-backups')
};
let nowFn = Date.now;
let readOnly = false;          // --shot and other verification runs never write

let doc = null;                // the canonical in-memory document
let lastDigest = null;         // sha1 of the bytes we last read from / wrote to disk
let quarantined = false;
let migrated = false;
let watcher = null;
let watchTimer = null;
let watchCbs = [];

/** Point the store somewhere else (tests, --data=). Call before load(). */
function configure(opts) {
  const o = opts || {};
  if (typeof o.root === 'string' && o.root) {
    paths = {
      json: path.join(o.root, 'ideas.json'),
      md: path.join(o.root, 'IDEAS.md'),
      backups: path.join(o.root, '.ideas-backups')
    };
  }
  if (typeof o.jsonPath === 'string' && o.jsonPath) paths.json = path.resolve(o.jsonPath);
  if (typeof o.mdPath === 'string' && o.mdPath) paths.md = path.resolve(o.mdPath);
  if (typeof o.backupDir === 'string' && o.backupDir) paths.backups = path.resolve(o.backupDir);
  if (typeof o.now === 'function') nowFn = o.now;
  if (o.readOnly !== undefined) readOnly = !!o.readOnly;
  if (o.root || o.jsonPath) { doc = null; lastDigest = null; }
  return module.exports;
}

// ── normalisation ─────────────────────────────────────────────────────────────

const emptyDoc = () => ({ v: V, app: APP, rev: 0, writtenMs: 0, ideas: [] });

function idPrefix(idea) {
  const tags = Array.isArray(idea.tags) ? idea.tags.map(t => String(t).toLowerCase()) : [];
  return (tags.includes('tracker') || tags.includes('app')) ? 'K' : 'T';
}

/** Next free number for a prefix. T-D5 counts as 5, so a mint can't collide. */
function nextNumber(all, prefix) {
  let max = 0;
  const re = new RegExp('^' + prefix + '-D?(\\d+)$', 'i');
  for (const it of all) {
    const m = re.exec(String(it.id || ''));
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return max + 1;
}

function normIdea(raw, ctx) {
  const r = isPlain(raw) ? raw : {};
  const now = ctx.now;
  const size = String(r.size || '').toUpperCase().replace(' ', '');
  const tags = [];
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) {
      const s = oneLine(t, 40).toLowerCase();
      if (s && !tags.includes(s) && tags.length < MAX_TAGS) tags.push(s);
    }
  }
  const created = num(r.createdMs, now);
  const idea = {
    id: oneLine(r.id, 24).replace(/[^\w.\-/]/g, ''),
    title: oneLine(r.title, MAX_TITLE),
    note: str(r.note, MAX_NOTE),
    status: STATUS_SET.has(r.status) ? r.status : 'inbox',
    size: SIZES.includes(size) ? size : '',
    tags,
    origin: ORIGINS.has(r.origin) ? r.origin : 'user',
    declineReason: str(r.declineReason, MAX_NOTE),
    result: oneLine(r.result, MAX_NOTE),
    order: num(r.order, (ctx.index + 1) * 1000),
    createdMs: created,
    updatedMs: num(r.updatedMs, created),
    statusMs: num(r.statusMs, created)
  };
  // A card with no words at all is still kept — losing it is worse than an empty row.
  if (!idea.title && idea.note) idea.title = idea.note.split('\n')[0].slice(0, 80);
  if (!idea.title) idea.title = '(untitled)';
  // The reason is the whole point of the Declined column: never let one be blank.
  if (idea.status === 'declined' && !idea.declineReason) idea.declineReason = NO_REASON;
  return idea;
}

/** Rebuild a whole document from anything. Mints missing ids, dedupes, sorts, repacks order. */
function normDoc(raw) {
  const r = isPlain(raw) ? raw : {};
  const now = nowFn();
  const out = emptyDoc();
  out.rev = Math.max(0, Math.trunc(num(r.rev, 0)));
  out.writtenMs = num(r.writtenMs, 0);

  const ideas = (Array.isArray(r.ideas) ? r.ideas : []).map((x, index) => normIdea(x, { now, index }));

  // Ids: mint the blanks, break duplicates.
  const seen = new Set();
  const counters = {};
  for (const idea of ideas) {
    if (!idea.id || seen.has(idea.id)) {
      const p = idPrefix(idea);
      if (counters[p] === undefined) counters[p] = nextNumber(ideas, p);
      do { idea.id = `${p}-${counters[p]++}`; } while (seen.has(idea.id));
    }
    seen.add(idea.id);
  }

  // Column order: stable, ascending, repacked so the file diffs cleanly.
  const rank = new Map(STATUSES.map((s, i) => [s, i]));
  ideas.sort((a, b) => (rank.get(a.status) - rank.get(b.status)) ||
    (a.order - b.order) || (a.createdMs - b.createdMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let n = 0, prev = null;
  for (const idea of ideas) {
    if (idea.status !== prev) { n = 0; prev = idea.status; }
    idea.order = ++n * 1000;
  }
  out.ideas = ideas;
  return out;
}

/** Stable key order + 2-space indent: the file reads like a document and diffs like one. */
function serialize(d) {
  return JSON.stringify({
    v: V, app: APP, rev: d.rev, writtenMs: d.writtenMs,
    ideas: d.ideas.map(i => ({
      id: i.id, title: i.title, note: i.note, status: i.status, size: i.size,
      tags: i.tags, origin: i.origin, declineReason: i.declineReason, result: i.result,
      order: i.order, createdMs: i.createdMs, updatedMs: i.updatedMs, statusMs: i.statusMs
    }))
  }, null, 2) + '\n';
}

// ── IDEAS.md rendering (OUTPUT ONLY) ──────────────────────────────────────────

const cell = s => String(s === undefined || s === null ? '' : s)
  .replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim() || '—';
const bold = s => '**' + cell(s) + '**';

const SECTION = {
  inbox: { icon: '🆕', name: 'Inbox', blurb: 'yours, not worked up yet' },
  proposed: { icon: '💡', name: 'Proposed', blurb: "Claude's suggestions, awaiting your call" },
  approved: { icon: '✅', name: 'Approved', blurb: 'queued to build' },
  building: { icon: '🔨', name: 'Building', blurb: '' },
  shipped: { icon: '🚢', name: 'Shipped', blurb: '' },
  declined: { icon: '🚫', name: 'Declined', blurb: 'settled, do not re-propose' }
};

function table(rows, head) {
  const out = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.join(' | ') + ' |');
  return out.join('\n');
}

const PREAMBLE = `# Ideas — Token Tracker & Token Town

<!-- GENERATED FILE — do not hand-edit. The source of truth is \`ideas.json\`
     beside it; this file is rewritten from it on every save and is never read
     back. Change things in the Ideas board app (Ideas.cmd) or edit ideas.json. -->

The running list of what to build next. An idea that only exists in a conversation is
gone by tomorrow, and the agent fleets can't read your taste out of a transcript.

## How to use it

${table([
  ['dump an idea, however rough', 'open the Ideas board and type it into **Inbox**'],
  ['review what Claude is proposing', 'drag cards out of **Proposed** — right into **Approved**, or into **Declined** with a reason'],
  ['work a card by hand', 'edit `ideas.json`; the board reloads itself when the file changes']
], ['you want to', 'do this'])}

Nothing gets built off **Proposed** — Claude may only build from **Approved**. Anything in
**Declined** is settled: agents must not re-pitch it unless you move it back yourself.

Ideas carry a stable id (\`T-n\` town, \`K-n\` tracker) so you can approve by reference. Sizes:
S ≈ an hour, M ≈ a session, L ≈ a whole agent wave.`;

// The contract the fleets are held to, restated where they will actually read it.
const FOOTER = `
---

## For agents reading this file

- Propose into **Proposed** with the next free id; never invent an "approved" row.
  **Only the user promotes to Approved**, and you may only build from **Approved**.
- Read **Declined** before proposing anything, and don't re-pitch what's there —
  every declined row carries the reason it is out.
- Declining something requires a reason. A row with no reason is not a decision.
- When work starts, move the row to **Building**; when it verifies and commits, move it
  to **Shipped** with a one-line result.
- Write to \`ideas.json\`, not to this file — this one is regenerated and your edit would
  be overwritten on the next save.
- Keep rows to one line. Detail belongs in a design doc, linked from the row.
`;

/** A skimmable rendering of the board, in the same vocabulary the hand-written file used. */
function renderMarkdown(d) {
  const L = [PREAMBLE];

  for (const status of STATUSES) {
    const s = SECTION[status];
    const rows = d.ideas.filter(i => i.status === status);
    L.push('');
    L.push('---');
    L.push('');
    L.push(`## ${s.icon} ${s.name}${s.blurb ? ' — ' + s.blurb : ''}${rows.length ? ` · ${rows.length}` : ''}`);
    L.push('');
    if (status === 'declined') {
      L.push('Kept here **on purpose**: without it, every new design wave re-pitches the same rejected');
      L.push('ideas. Move a row out yourself if you change your mind.');
      L.push('');
    }
    if (!rows.length) { L.push('_(empty)_'); continue; }
    // Every section is a table with an id column: the id is how the user refers to
    // a card in conversation, and it is what lets this file re-seed a lost
    // ideas.json without renumbering the board.
    if (status === 'shipped') {
      L.push(table(rows.map(i => [cell(i.id), bold(i.title),
        [i.note, i.result].filter(Boolean).map(x => cell(x)).join(' · ')]), ['id', 'idea', 'result']));
    } else if (status === 'declined') {
      L.push(table(rows.map(i => [cell(i.id), bold(i.title) + (i.note ? ' — ' + cell(i.note) : ''),
        cell(i.declineReason)]), ['id', 'idea', "why it's out"]));
    } else if (status === 'building') {
      L.push(table(rows.map(i => [cell(i.id), bold(i.title), cell(i.note)]), ['id', 'idea', 'where']));
    } else {
      L.push(table(rows.map(i => [bold(i.id), bold(i.title), cell(i.size), cell(i.note)]),
        ['id', 'idea', 'size', status === 'proposed' ? 'why it might be worth it' : 'notes']));
    }
  }

  L.push(FOOTER);
  return L.join('\n');
}

// ── the one-time migration from the hand-written IDEAS.md ─────────────────────

const SECTION_WORDS = [
  [/\binbox\b/i, 'inbox'], [/\bproposed\b/i, 'proposed'], [/\bapproved\b/i, 'approved'],
  [/\bbuilding\b/i, 'building'], [/\bshipped\b/i, 'shipped'], [/\bdeclined\b/i, 'declined']
];

/** Only the heading's first phrase counts, so "do not re-propose" can't rename a section. */
function sectionOf(heading) {
  const head = String(heading).split(/\s+[—–]\s+/)[0];
  for (const [re, status] of SECTION_WORDS) if (re.test(head)) return status;
  return null;
}

function colKey(name) {
  const n = String(name).toLowerCase().replace(/\*/g, '').trim();
  if (n === 'id') return 'id';
  if (n === 'idea' || n === 'title' || n === 'what') return 'idea';
  if (n === 'size') return 'size';
  if (/^why it'?s out|^why not|^reason/.test(n)) return 'reason';
  return 'note';
}

/** "**The Charter** — earn a civic building once …" -> {title, note}. */
function splitIdea(text) {
  const s = String(text).trim();
  let title = '', note = '';
  const b = /^\*\*(.+?)\*\*/.exec(s);
  if (b) { title = b[1]; note = s.slice(b[0].length); }
  else {
    const m = /\s+[—–]\s+/.exec(s);
    if (m && m.index <= 70) { title = s.slice(0, m.index); note = s.slice(m.index + m[0].length); }
    else { title = s; note = ''; }
  }
  note = note.replace(/^\s*[—–\-:,;]\s*/, '').trim();
  title = title.replace(/\*\*/g, '').trim();
  return { title, note };
}

/** Parse the hand-written board ONCE. This is the only place IDEAS.md is ever read. */
function migrateFromMarkdown(text) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let status = null, cols = null;

  for (const raw of lines) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { status = sectionOf(h[1]); cols = null; continue; }
    if (!status) continue;

    if (line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;          // separator
      if (!cols) { cols = cells.map(colKey); continue; }              // header
      const row = { note: [] };
      cells.forEach((c, i) => {
        const k = cols[i] || 'note';
        if (k === 'note') { if (c && c !== '—') row.note.push(c); }
        else row[k] = c;
      });
      const ideaCell = row.idea || '';
      if (!ideaCell || ideaCell === '—') continue;
      const { title, note } = splitIdea(ideaCell);
      items.push({
        id: String(row.id || '').replace(/\*/g, '').replace(/^—$/, '').trim(),
        title, note: (note ? [note] : []).concat(row.note).join(' — '), status,
        size: String(row.size || '').replace(/\*/g, '').trim(),
        declineReason: status === 'declined' ? String(row.reason || '').trim() : ''
      });
      continue;
    }

    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      const body = b[1].trim();
      if (!body || /^_/.test(body)) continue;
      const { title, note } = splitIdea(body);
      if (!title) continue;
      items.push({ id: '', title, note, status, size: '', declineReason: '' });
    }
  }

  // Mint the ids the file didn't carry, oldest work first, so v2/v3/v4 read in
  // the order they happened rather than the order the sections appear.
  const mintRank = { shipped: 0, building: 1, approved: 2, proposed: 3, inbox: 4, declined: 5 };
  const now = nowFn();
  const counters = {};
  for (const i of items.filter(x => !x.id).sort((a, b) => mintRank[a.status] - mintRank[b.status])) {
    if (counters.T === undefined) counters.T = nextNumber(items, 'T');
    i.id = `T-${counters.T++}`;
  }

  return normDoc({
    v: V, app: APP, rev: 1, writtenMs: 0,
    ideas: items.map((i, index) => ({
      id: i.id, title: i.title, note: i.note, status: i.status, size: i.size,
      tags: [/^K-/i.test(i.id) ? 'tracker' : 'town'],
      origin: 'claude',              // every row in the seed file came out of a design wave
      declineReason: i.declineReason, result: '',
      order: (index + 1) * 1000,
      createdMs: now, updatedMs: now, statusMs: now
    }))
  });
}

// ── disk ──────────────────────────────────────────────────────────────────────

function parseDoc(raw) {
  const parsed = JSON.parse(raw);
  if (!isPlain(parsed) || !Array.isArray(parsed.ideas)) throw new Error('shape');
  // Strip any own `__proto__` JSON.parse handed back before it reaches [[Set]].
  for (const k of UNSAFE) if (Object.prototype.hasOwnProperty.call(parsed, k)) delete parsed[k];
  return normDoc(parsed);
}

function stamp() {
  const d = new Date(nowFn());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** An unreadable file may be the user's only copy: rename it aside, never overwrite it. */
function quarantine() {
  try {
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.copyFileSync(paths.json, path.join(paths.backups, `ideas.corrupt-${stamp()}.json`));
    fs.unlinkSync(paths.json);
    const files = fs.readdirSync(paths.backups).filter(f => f.startsWith('ideas.corrupt-')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - CORRUPT_KEEP))) {
      try { fs.unlinkSync(path.join(paths.backups, f)); } catch { /* best effort */ }
    }
    quarantined = true;
  } catch { /* nothing to salvage; the board still opens */ }
}

const backupPath = () => path.join(paths.backups, 'ideas.prev.json');

/** Copy the file that is about to be replaced. One rolling copy is the whole net. */
function backup() {
  try {
    if (!fs.existsSync(paths.json)) return;
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.copyFileSync(paths.json, backupPath());
  } catch { /* a missing backup must not block the save */ }
}

/** tmp + fsync + rename. A half-written board must never replace a good one. */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  catch { fs.unlinkSync(file); fs.renameSync(tmp, file); }   // AV / locked-file retry
}

// ── load ──────────────────────────────────────────────────────────────────────

/**
 * @returns {{doc:object, notice:{kind:string,message:string}|null}}
 * kinds: 'migrated' | 'recovered' | 'quarantined' | 'created' | 'readonly' | null
 */
function load() {
  if (doc) return { doc: snapshot(), notice: null };
  quarantined = false;
  migrated = false;
  let notice = null;
  let d = null;

  let raw = null;
  try { raw = fs.readFileSync(paths.json, 'utf8'); } catch { /* first run */ }
  if (raw !== null) {
    lastDigest = digest(raw);
    try { d = parseDoc(raw); }
    catch {
      quarantine();
      // The file was unreadable and has been renamed aside. Before starting empty,
      // reach for the rolling backup — that is what it is for.
      try { d = parseDoc(fs.readFileSync(backupPath(), 'utf8')); } catch { d = null; }
      notice = d
        ? { kind: 'recovered', message: `ideas.json was unreadable — restored ${d.ideas.length} ideas from the backup (the bad file is in .ideas-backups).` }
        : { kind: 'quarantined', message: 'ideas.json could not be read — it was moved to .ideas-backups and a fresh board was started.' };
    }
  }

  if (!d) {
    let md = null;
    if (!quarantined) { try { md = fs.readFileSync(paths.md, 'utf8'); } catch { /* no seed file */ } }
    if (md) {
      d = migrateFromMarkdown(md);
      migrated = true;
      notice = { kind: 'migrated', message: `Seeded ${d.ideas.length} ideas from IDEAS.md.` };
      // The hand-written file is about to be replaced by a generated one. Keep it.
      if (!readOnly) {
        try {
          fs.mkdirSync(paths.backups, { recursive: true });
          fs.copyFileSync(paths.md, path.join(paths.backups, `IDEAS.pre-migration-${stamp()}.md`));
        } catch { /* best effort */ }
      }
    } else {
      d = normDoc(emptyDoc());
      if (!notice) notice = { kind: 'created', message: 'New board — ideas.json will be created on your first change.' };
    }
  }

  doc = d;
  // Persist a migration or a recovery straight away, so the agents' source of
  // truth exists before the user touches anything. A merely-empty board writes
  // nothing: an app that opens must not create files it was not asked for.
  if (!readOnly && (migrated || (notice && notice.kind === 'recovered'))) commit(doc);
  if (readOnly && !notice) notice = { kind: 'readonly', message: 'Read-only run: nothing will be written.' };
  return { doc: snapshot(), notice };
}

function snapshot() { return clone(doc || (doc = normDoc(emptyDoc()))); }

// ── save ──────────────────────────────────────────────────────────────────────

/** Write `d` (already normalised) and regenerate IDEAS.md. */
function commit(d) {
  d.rev = (d.rev || 0) + 1;
  d.writtenMs = nowFn();
  const json = serialize(d);
  backup();
  writeAtomic(paths.json, json);
  lastDigest = digest(json);
  try { writeAtomic(paths.md, renderMarkdown(d)); }
  catch (e) { console.error('[ideas] IDEAS.md render failed:', e.message); }   // never fail a save over the view
  doc = d;
  return doc;
}

/**
 * @param {object} incoming the full document the renderer was editing
 * @returns {{ok:boolean, doc:object, external:boolean, error?:string}}
 *   `doc` is ALWAYS the canonical result — adopt it, don't keep your own copy.
 *   `external:true` means the file had changed underneath us; the version we
 *   replaced is in .ideas-backups/ideas.prev.json.
 */
function save(incoming) {
  if (!doc) load();
  if (readOnly) return { ok: false, doc: snapshot(), external: false, error: 'read-only run' };
  const ours = normDoc(incoming);

  // Re-read every time: the watcher can lag by a couple of hundred ms.
  let external = false;
  try {
    const raw = fs.readFileSync(paths.json, 'utf8');
    if (digest(raw) !== lastDigest) {
      external = true;
      try { ours.rev = Math.max(ours.rev, parseDoc(raw).rev); }
      catch { quarantine(); }        // garbage on disk: keep it, ours is the better copy
    }
  } catch { /* ENOENT: nothing on disk yet */ }

  try {
    commit(ours);
    return { ok: true, doc: snapshot(), external };
  } catch (e) {
    return { ok: false, doc: snapshot(), external, error: (e && e.message) || 'write failed' };
  }
}

// ── watching ──────────────────────────────────────────────────────────────────

/**
 * Watch ideas.json for changes made by anyone else. `cb(doc)` fires only for
 * EXTERNAL edits — our own writes are recognised by content digest.
 * @returns {function} unwatch
 */
function watch(cb) {
  if (typeof cb === 'function') watchCbs.push(cb);
  if (!watcher) {
    // Watch the DIRECTORY: an atomic rename replaces the inode, and a file watch
    // on Windows goes deaf the first time that happens.
    try {
      fs.mkdirSync(path.dirname(paths.json), { recursive: true });
      watcher = fs.watch(path.dirname(paths.json), { persistent: false }, (_e, name) => {
        if (name && path.basename(String(name)) !== path.basename(paths.json)) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(poll, WATCH_DEBOUNCE_MS);
      });
    } catch { /* no watcher: the save path still re-reads before every write */ }
  }
  return () => {
    if (typeof cb === 'function') watchCbs = watchCbs.filter(f => f !== cb);
    if (!watchCbs.length) disposeWatcher();
  };
}

function poll() {
  watchTimer = null;
  let raw = null;
  try { raw = fs.readFileSync(paths.json, 'utf8'); } catch { return; }
  if (digest(raw) === lastDigest) return;                 // our own write coming back
  let fresh = null;
  try { fresh = parseDoc(raw); }
  catch { return; }                                       // mid-write by someone else: the next event settles it
  lastDigest = digest(raw);
  doc = fresh;
  const snap = snapshot();
  for (const cb of watchCbs.slice()) { try { cb(snap); } catch { /* a listener must not kill the watcher */ } }
}

function disposeWatcher() {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (watcher) { try { watcher.close(); } catch { /* already gone */ } watcher = null; }
}

function dispose() { disposeWatcher(); watchCbs = []; doc = null; lastDigest = null; }

module.exports = {
  V, APP, STATUSES, SIZES, NO_REASON,
  configure, load, snapshot, save, watch, dispose,
  renderMarkdown, migrateFromMarkdown, normDoc, serialize,
  get paths() { return { ...paths }; },
  get readOnly() { return readOnly; },
  get quarantined() { return quarantined; },
  get migrated() { return migrated; }
};
