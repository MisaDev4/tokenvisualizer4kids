// Node test for the Ideas store. No framework, no dependencies: `npm test` here
// is `node test/store.test.js`. Everything runs in a fresh temp root, except one
// read-only copy of the real IDEAS.md used to prove the migration is faithful.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const store = require('../src/store.js');

const REPO = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}

let clock = Date.UTC(2026, 7, 6, 12, 0, 0);
const now = () => (clock += 7);

let roots = [];
function freshRoot(seedMarkdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-test-'));
  roots.push(root);
  if (seedMarkdown) fs.writeFileSync(path.join(root, 'IDEAS.md'), seedMarkdown);
  store.dispose();
  store.configure({ root, now, readOnly: false });
  return root;
}
const readJson = root => JSON.parse(fs.readFileSync(path.join(root, 'ideas.json'), 'utf8'));

// The seed is the hand-written board as it was before the app existed; the real
// IDEAS.md is generated now, so the fixture is kept beside the test.
const SEED_MD = fs.readFileSync(path.join(__dirname, 'IDEAS.seed.md'), 'utf8');

// ── 1. migration fidelity ─────────────────────────────────────────────────────
console.log('\nmigration');
let migratedDoc = null;
test('seeds ideas.json from the hand-written IDEAS.md, once', () => {
  const root = freshRoot(SEED_MD);
  const { doc, notice } = store.load();
  migratedDoc = doc;
  assert.strictEqual(notice.kind, 'migrated', 'expected a migrated notice');
  assert.ok(fs.existsSync(path.join(root, 'ideas.json')), 'ideas.json was not written');
  const backups = fs.readdirSync(path.join(root, '.ideas-backups'));
  assert.ok(backups.some(f => f.startsWith('IDEAS.pre-migration-')),
    'the hand-written IDEAS.md was replaced without keeping a copy');
});

test('all twelve v4 proposals survive, with ids, sizes and reasoning', () => {
  const proposed = migratedDoc.ideas.filter(i => i.status === 'proposed');
  assert.strictEqual(proposed.length, 12, 'expected 12 proposals, got ' + proposed.length);
  for (let n = 1; n <= 12; n++) {
    const it = proposed.find(i => i.id === 'T-' + n);
    assert.ok(it, 'missing T-' + n);
    assert.ok(it.title.length > 2, 'T-' + n + ' has no title');
    assert.ok(it.note.length > 10, 'T-' + n + ' lost its reasoning');
    assert.ok(['S', 'M', 'L', 'S/M'].includes(it.size), 'T-' + n + ' lost its size: ' + it.size);
    assert.strictEqual(it.origin, 'claude');
  }
  const t1 = proposed.find(i => i.id === 'T-1');
  assert.strictEqual(t1.title, 'The Charter');
  assert.strictEqual(t1.size, 'L');
  assert.ok(t1.note.includes('strongest single idea'), 'T-1 note truncated: ' + t1.note);
  assert.strictEqual(proposed.find(i => i.id === 'T-10').size, 'S/M');
  assert.ok(proposed.find(i => i.id === 'T-9').title.startsWith('Click a headline'));
});

test('all five declined rows survive WITH their reasons', () => {
  const declined = migratedDoc.ideas.filter(i => i.status === 'declined');
  assert.strictEqual(declined.length, 5, 'expected 5 declined rows, got ' + declined.length);
  for (let n = 1; n <= 5; n++) {
    const it = declined.find(i => i.id === 'T-D' + n);
    assert.ok(it, 'missing T-D' + n);
    assert.ok(it.declineReason.length > 20, 'T-D' + n + ' lost its reason');
    assert.notStrictEqual(it.declineReason, store.NO_REASON);
  }
  assert.ok(declined.find(i => i.id === 'T-D1').declineReason.includes('feel *bad*'));
  assert.ok(declined.find(i => i.id === 'T-D5').title.includes('SSAO'));
});

test('the shipped and building rows survive and get minted ids in age order', () => {
  const shipped = migratedDoc.ideas.filter(i => i.status === 'shipped');
  const building = migratedDoc.ideas.filter(i => i.status === 'building');
  assert.deepStrictEqual(shipped.map(i => i.title), ['v2', 'v3']);
  assert.ok(shipped[0].note.includes('villagers'), 'v2 lost its note');
  assert.ok(shipped[1].note.includes('crier ticker'), 'v3 lost its note');
  assert.strictEqual(building.length, 1);
  assert.strictEqual(building[0].title, 'v4');
  assert.ok(building[0].note.includes('photographic render'), 'v4 lost its note');
  assert.ok(building[0].note.includes('agent wave in flight'), 'v4 lost the "where" column');
  // minted after T-12, oldest work first
  assert.deepStrictEqual([shipped[0].id, shipped[1].id, building[0].id], ['T-13', 'T-14', 'T-15']);
});

test('nothing else leaks in — the how-to and agent-guidance tables are not ideas', () => {
  assert.strictEqual(migratedDoc.ideas.length, 20, 'expected 12+5+2+1 = 20 ideas');
  assert.ok(!migratedDoc.ideas.some(i => /Propose into/.test(i.title)), 'guidance bullet became an idea');
  assert.ok(!migratedDoc.ideas.some(i => /dump an idea/.test(i.title)), 'how-to row became an idea');
});

// ── 2. IDEAS.md is a faithful, output-only rendering ──────────────────────────
console.log('\nIDEAS.md rendering');
test('regenerated IDEAS.md carries every id, reason and section', () => {
  const md = fs.readFileSync(path.join(roots[roots.length - 1], 'IDEAS.md'), 'utf8');
  for (const i of migratedDoc.ideas) assert.ok(md.includes(i.id), i.id + ' missing from IDEAS.md');
  for (const i of migratedDoc.ideas.filter(x => x.status === 'declined')) {
    assert.ok(md.includes(i.declineReason.slice(0, 30)), i.id + ' lost its reason in the render');
  }
  for (const word of ['Inbox', 'Proposed', 'Approved', 'Building', 'Shipped', 'Declined',
    'For agents reading this file', 'Only the user promotes to Approved']) {
    assert.ok(md.includes(word), 'IDEAS.md lost the section vocabulary: ' + word);
  }
  assert.ok(md.includes('GENERATED FILE'), 'the generated file does not say it is generated');
});

test('the render is a pure function of the document (no timestamp churn)', () => {
  const a = store.renderMarkdown(migratedDoc);
  clock += 5 * 60 * 1000;
  const b = store.renderMarkdown(migratedDoc);
  assert.strictEqual(a, b, 'IDEAS.md changed without the board changing');
});

test('a pipe or newline in a title cannot break the table', () => {
  const d = store.normDoc({ ideas: [{ id: 'T-1', title: 'a | b', note: 'one\ntwo', status: 'proposed' }] });
  const md = store.renderMarkdown(d);
  const row = md.split('\n').find(l => l.includes('a \\| b'));
  assert.ok(row, 'pipe was not escaped');
  assert.strictEqual(row.split(/(?<!\\)\|/).length - 2, 4, 'row has the wrong column count: ' + row);
});

// ── 3. saving ─────────────────────────────────────────────────────────────────
console.log('\nsaving');
test('a save writes valid JSON, bumps rev and leaves no tmp file', () => {
  const root = freshRoot(null);
  const { doc } = store.load();
  doc.ideas.push({ id: '', title: 'Freeze the river in winter', status: 'inbox', origin: 'user', tags: ['town'] });
  const res = store.save(doc);
  assert.ok(res.ok, 'save failed: ' + res.error);
  const on = readJson(root);
  assert.strictEqual(on.v, 1);
  assert.strictEqual(on.app, 'token-ideas');
  assert.ok(on.rev > doc.rev, 'rev did not advance');
  assert.strictEqual(on.ideas.length, 1);
  assert.strictEqual(on.ideas[0].id, 'T-1', 'the store did not mint an id');
  assert.ok(!fs.existsSync(path.join(root, 'ideas.json.tmp')), 'left a .tmp behind');
  assert.ok(fs.existsSync(path.join(root, 'IDEAS.md')), 'IDEAS.md was not regenerated');
});

test('hostile input still produces a valid, fully-typed document', () => {
  const root = freshRoot(null);
  store.load();
  const nasty = JSON.parse('{"ideas":[{"__proto__":{"pwned":1},"id":"  T-9  ","title":"   ","note":42,' +
    '"status":"nonsense","size":"XXL","tags":["A","A","b",1,{},"c","d","e","f","g","h","i"],' +
    '"origin":"root","order":"NaN","createdMs":"soon","declineReason":null},' +
    '{"id":"T-9","title":"duplicate id","status":"declined"},' +
    '{"title":"no id at all","status":"approved","tags":["tracker"]},' +
    'null,7,"nope"],"rev":-5,"v":"x"}');
  const res = store.save(nasty);
  assert.ok(res.ok, 'save failed: ' + res.error);
  const on = readJson(root);                          // throws if the JSON is invalid
  assert.strictEqual({}.pwned, undefined, 'prototype pollution got through');
  assert.strictEqual(on.ideas.length, 6, 'an idea was dropped: ' + on.ideas.length);
  const ids = on.ideas.map(i => i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids survived: ' + ids);
  assert.ok(ids.includes('T-9'));
  for (const i of on.ideas) {
    assert.ok(store.STATUSES.includes(i.status), 'bad status ' + i.status);
    assert.ok(store.SIZES.includes(i.size), 'bad size ' + i.size);
    assert.ok(['user', 'claude'].includes(i.origin), 'bad origin ' + i.origin);
    assert.ok(Array.isArray(i.tags) && i.tags.length <= 8, 'bad tags ' + JSON.stringify(i.tags));
    assert.ok(i.tags.every(t => typeof t === 'string'));
    assert.strictEqual(typeof i.title, 'string');
    assert.ok(i.title.length > 0, 'blank title survived');
    assert.strictEqual(typeof i.note, 'string');
    assert.ok(Number.isFinite(i.order) && Number.isFinite(i.createdMs) && Number.isFinite(i.updatedMs));
    if (i.status === 'declined') assert.ok(i.declineReason.length > 0, 'a declined row has no reason');
  }
  assert.ok(on.rev >= 1 && Number.isInteger(on.rev));
});

test('a declined card without a reason is stamped, never dropped', () => {
  freshRoot(null); store.load();
  const res = store.save({ ideas: [{ id: 'T-1', title: 'x', status: 'declined' }] });
  assert.strictEqual(res.doc.ideas[0].declineReason, store.NO_REASON);
});

test('an external rewrite is noticed, and the copy it replaced is kept', () => {
  const root = freshRoot(null);
  let { doc } = store.load();
  doc.ideas.push({ id: '', title: 'ours', status: 'inbox' });
  doc = store.save(doc).doc;
  const theirs = JSON.parse(JSON.stringify(doc));
  theirs.ideas.push({ id: 'T-42', title: 'from an agent', status: 'proposed', origin: 'claude' });
  theirs.rev = doc.rev + 5;
  fs.writeFileSync(path.join(root, 'ideas.json'), JSON.stringify(theirs, null, 2));
  const res = store.save(doc);
  assert.ok(res.ok && res.external, 'the external write was not noticed');
  assert.ok(res.doc.rev > theirs.rev, 'rev did not advance past the external revision');
  const kept = JSON.parse(fs.readFileSync(path.join(root, '.ideas-backups', 'ideas.prev.json'), 'utf8'));
  assert.ok(kept.ideas.some(i => i.id === 'T-42'), 'the overwritten agent card was not backed up');
});

// ── 4. corruption ─────────────────────────────────────────────────────────────
console.log('\ncorruption');
test('a truncated ideas.json is quarantined and recovered from the backup', () => {
  const root = freshRoot(null);
  let { doc } = store.load();
  doc.ideas.push({ id: '', title: 'precious', status: 'approved' });
  doc = store.save(doc).doc;
  doc.ideas.push({ id: '', title: 'also precious', status: 'approved' });
  store.save(doc);
  // now half a write lands on top of it
  fs.writeFileSync(path.join(root, 'ideas.json'), '{ "v":1, "ideas": [ {"id":"T-1", ');
  store.dispose(); store.configure({ root, now });
  const { doc: back, notice } = store.load();
  assert.strictEqual(notice.kind, 'recovered', 'expected a recovery, got ' + notice.kind);
  assert.ok(back.ideas.some(i => i.title === 'precious'), 'the backup did not restore the board');
  const files = fs.readdirSync(path.join(root, '.ideas-backups'));
  assert.ok(files.some(f => f.startsWith('ideas.corrupt-')), 'the bad file was destroyed instead of kept');
  assert.ok(fs.existsSync(path.join(root, 'ideas.json')), 'the recovered board was not written back');
});

test('with no backup to fall back on, a corrupt file still opens an empty board', () => {
  const root = freshRoot(null);
  fs.writeFileSync(path.join(root, 'ideas.json'), 'not json at all');
  store.dispose(); store.configure({ root, now });
  const { doc, notice } = store.load();
  assert.strictEqual(notice.kind, 'quarantined');
  assert.deepStrictEqual(doc.ideas, []);
  assert.ok(fs.readdirSync(path.join(root, '.ideas-backups')).some(f => f.startsWith('ideas.corrupt-')));
  assert.ok(!fs.existsSync(path.join(root, 'ideas.json')), 'the unreadable file was left in place');
});

test('a crash mid-write leaves the previous board intact', () => {
  const root = freshRoot(null);
  let { doc } = store.load();
  doc.ideas.push({ id: '', title: 'survivor', status: 'approved' });
  doc = store.save(doc).doc;
  const good = fs.readFileSync(path.join(root, 'ideas.json'), 'utf8');
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('simulated power cut'); };
  let res;
  try {
    const next = JSON.parse(good);
    next.ideas.push({ id: '', title: 'never landed', status: 'inbox' });
    res = store.save(next);
  } finally { fs.fsyncSync = realFsync; }
  assert.ok(!res.ok, 'a failed write reported success');
  assert.strictEqual(fs.readFileSync(path.join(root, 'ideas.json'), 'utf8'), good,
    'a half-written file replaced a good one');
});

test('a read-only run never writes', () => {
  const root = freshRoot(SEED_MD);
  store.dispose(); store.configure({ root, now, readOnly: true });
  const { doc, notice } = store.load();
  assert.strictEqual(notice.kind, 'migrated');
  assert.strictEqual(doc.ideas.length, 20, 'the read-only run still parsed the seed');
  assert.ok(!fs.existsSync(path.join(root, 'ideas.json')), '--shot wrote to the board');
  doc.ideas.push({ id: '', title: 'nope', status: 'inbox' });
  const res = store.save(doc);
  assert.ok(!res.ok && /read-only/.test(res.error));
  assert.ok(!fs.existsSync(path.join(root, 'ideas.json')), '--shot wrote to the board');
  assert.strictEqual(fs.readFileSync(path.join(root, 'IDEAS.md'), 'utf8'), SEED_MD,
    '--shot rewrote the user IDEAS.md');
  store.configure({ readOnly: false });
});

// ── 5. watching ───────────────────────────────────────────────────────────────
(async () => {
  console.log('\nwatching');
  await atest('an external write reloads the board; our own save does not', async () => {
    const root = freshRoot(null);
    let { doc } = store.load();
    doc.ideas.push({ id: '', title: 'seed', status: 'inbox' });
    doc = store.save(doc).doc;
    const seen = [];
    const unwatch = store.watch(d => seen.push(d));
    await new Promise(r => setTimeout(r, 80));

    doc.ideas.push({ id: '', title: 'from the window', status: 'inbox' });
    doc = store.save(doc).doc;
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(seen.length, 0, 'our own write fired an external-change event');

    const theirs = JSON.parse(fs.readFileSync(path.join(root, 'ideas.json'), 'utf8'));
    theirs.ideas.push({ id: 'T-42', title: 'from an agent', status: 'proposed', origin: 'claude' });
    fs.writeFileSync(path.join(root, 'ideas.json'), JSON.stringify(theirs, null, 2));
    await new Promise(r => setTimeout(r, 600));
    unwatch();
    assert.strictEqual(seen.length, 1, 'expected exactly one reload, got ' + seen.length);
    assert.ok(seen[0].ideas.some(i => i.id === 'T-42'), 'the reload did not carry the agent card');
    assert.ok(seen[0].ideas.some(i => i.title === 'from the window'), 'the reload lost our card');
  });

  store.dispose();
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* temp */ } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
