/* Ideas — the board.
 *
 * Six columns of draggable cards over one file (ideas.json) that agents also
 * write. Three rules shape everything below:
 *
 *  1. The user's typing is sacred. Every change is an *op*, not a snapshot, so a
 *     file that changed underneath us can be re-adopted and our unsaved ops
 *     replayed on top instead of clobbering the agent's write (or losing ours).
 *  2. Nothing verification-visible waits on an animation. Drops mutate the model
 *     synchronously and re-render; the flying card is decoration that catches up.
 *  3. A decline without a reason is worse than no decline — the reason is the
 *     only thing that stops the next agent wave re-pitching a settled idea. So
 *     the reason is asked for BEFORE the move is committed, never after.
 *
 * Store contract (see src/preload.js):
 *   window.ideasAPI.load()               -> Promise<{ok, doc, notice}>
 *   window.ideasAPI.save(doc)            -> Promise<{ok, doc, external, error?}>
 *   window.ideasAPI.onExternalChange(cb) -> cb(doc)
 * doc = { v, rev, writtenMs, ideas:[ {id,title,note,status,size,tags,origin,order,
 *         createdMs,updatedMs,statusMs,declineReason,result} ] }
 * The store's returned doc is canonical (it mints ids and repacks order), so
 * every save adopts it.
 */
'use strict';

/* ── columns ───────────────────────────────────────────────────────────── */
const COLUMNS = [
  { id: 'inbox', label: 'Inbox',
    empty: 'Nothing yet. Type above — half-formed is fine, that is what this column is for.' },
  { id: 'proposed', label: 'Proposed',
    empty: 'No suggestions in flight. The next agent wave will drop some here.' },
  { id: 'approved', label: 'Approved',
    empty: 'Empty on purpose. Nothing gets built until you drag it here.' },
  { id: 'building', label: 'Building',
    empty: 'Nothing under construction.' },
  { id: 'shipped', label: 'Shipped',
    empty: 'Nothing shipped yet. It lands here when it verifies and commits.' },
  { id: 'declined', label: 'Declined',
    empty: 'Nothing settled yet. A decline needs a reason — that reason is what makes it stick.' }
];
const STATUS_SET = new Set(COLUMNS.map(c => c.id));
const SIZES = ['S', 'M', 'L'];

/* ── the store bridge ────────────────────────────────────────────────────── */
const bridge = (window.ideasAPI && typeof window.ideasAPI.load === 'function') ? window.ideasAPI : null;

/* ── state ─────────────────────────────────────────────────────────────── */
let doc = { version: 1, rev: 0, ideas: [] };
let baseRev = null;          // the rev we loaded / last saved against
let pendingOps = [];         // applied locally, not yet confirmed on disk
let undoStack = [];          // each entry: {label, ops:[inverse ops]}
let edit = null;             // {id,title,note,size,tags} — the live editor draft
let drag = null;             // see beginDrag()
let queuedAdopt = null;      // an external change that arrived mid-drag
let lastProject = localStorage.getItem('ideas.project') || 'T';

const $ = sel => document.querySelector(sel);
const board = $('#board'), dragLayer = $('#dragLayer'), banner = $('#banner');
const saveChip = $('#saveState'), toastEl = $('#toast');
const dlg = $('#reasonDlg'), reasonText = $('#reasonText'),
  reasonOk = $('#reasonOk'), reasonCancel = $('#reasonCancel'), reasonTitle = $('#reasonTitle');

const cols = new Map();      // status -> {root, cards, count}
const cardEls = new Map();   // idea id -> card element (kept across columns so the
                             // open editor survives a move or an external reload)

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── model helpers ─────────────────────────────────────────────────────── */
const find = id => doc.ideas.find(i => i.id === id);
/** Unknown statuses are shown in Inbox but never rewritten on disk unless the
 *  user actually moves the card — an agent's vocabulary is not ours to edit. */
const bucketOf = i => (STATUS_SET.has(i.status) ? i.status : 'inbox');
const ordered = status => doc.ideas.filter(i => bucketOf(i) === status)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
const renumber = status => ordered(status).forEach((i, n) => { i.order = n; });

function nextId(prefix) {
  let max = 0;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  for (const i of doc.ideas) { const m = re.exec(i.id || ''); if (m) max = Math.max(max, +m[1]); }
  return `${prefix}-${max + 1}`;
}

/** Ops are the unit of change: small, id-addressed, and replayable onto a doc
 *  we have never seen before. That is what makes concurrent agent writes safe. */
function applyOp(d, op) {
  if (op.t === 'add') {
    if (d.ideas.some(i => i.id === op.idea.id)) return;      // replay is idempotent
    d.ideas.push({ ...op.idea });
    renumberIn(d, op.idea.status);
  } else if (op.t === 'remove') {                            // reachable only via undo
    const ix = d.ideas.findIndex(i => i.id === op.id);
    if (ix < 0) return;
    const st = d.ideas[ix].status;
    d.ideas.splice(ix, 1);
    renumberIn(d, st);
  } else if (op.t === 'patch') {
    const it = d.ideas.find(i => i.id === op.id);
    if (!it) return;
    Object.assign(it, op.fields);
    it.updatedMs = Date.now();
  } else if (op.t === 'place') {
    const it = d.ideas.find(i => i.id === op.id);
    if (!it) return;
    const from = it.status;
    const list = orderedIn(d, op.status).filter(x => x.id !== op.id);
    const ix = op.before ? list.findIndex(x => x.id === op.before) : -1;
    if (it.status !== op.status) it.statusMs = Date.now();
    it.status = op.status;
    it.updatedMs = Date.now();
    list.splice(ix < 0 ? list.length : ix, 0, it);
    list.forEach((x, n) => { x.order = n; });
    if (from !== op.status) renumberIn(d, from);
  }
}
// doc-agnostic twins of ordered()/renumber(), used by applyOp during replay
const orderedIn = (d, status) => d.ideas.filter(i => (STATUS_SET.has(i.status) ? i.status : 'inbox') === status)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
const renumberIn = (d, status) => orderedIn(d, status).forEach((i, n) => { i.order = n; });

/** The id that currently follows `id` in its column — the anchor a `place` op
 *  needs so an inverse move lands back exactly where it came from. */
function beforeIdOf(id) {
  const list = ordered(bucketOf(find(id)));
  const ix = list.findIndex(i => i.id === id);
  return ix >= 0 && list[ix + 1] ? list[ix + 1].id : null;
}

/* ── commit / undo ─────────────────────────────────────────────────────── */
function commit(label, ops, inverse, { undoable = true } = {}) {
  for (const op of ops) applyOp(doc, op);
  pendingOps.push(...ops);
  if (undoable && inverse && inverse.length) {
    undoStack.push({ label, ops: inverse });
    if (undoStack.length > 80) undoStack.shift();
  }
  render();
  scheduleSave();
}

function undo() {
  const step = undoStack.pop();
  if (!step) return toast('nothing to undo');
  if (edit) closeEditor(false);
  commit('undo', step.ops, null, { undoable: false });
  toast('undid ' + step.label);
}

/* ── save pipeline ─────────────────────────────────────────────────────── */
let saveTimer = null, saving = false, dirty = false, retryMs = 1500;

function setSave(state, text) { saveChip.dataset.state = state; saveChip.textContent = text; }

function scheduleSave(delay = 400) {
  dirty = true;
  if (!saving) setSave('dirty', 'unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}

async function flush() {
  if (saving || !dirty || !bridge) return;
  saving = true; dirty = false;
  const inFlight = pendingOps.slice();
  setSave('saving', 'saving…');
  doc.rev = baseRev;
  let res;
  try { res = await bridge.save(doc); }
  catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
  saving = false;

  if (!res || res.ok !== true) {
    setSave('failed', 'save failed — retrying');
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
    return;
  }
  retryMs = 1500;
  pendingOps = pendingOps.filter(op => !inFlight.includes(op));
  // The store's copy is canonical — it mints ids, repacks order and stamps a
  // missing decline reason — so adopt it, replaying anything typed since.
  adopt(res.doc, { replay: true, quiet: true });
  if (res.external) toast('ideas.json had changed on disk — the replaced copy is in .ideas-backups');
  if (dirty || pendingOps.length) scheduleSave(150);
  else setSave('saved', 'saved ' + new Date().toTimeString().slice(0, 5));
}

/* ── adopting an external doc without losing anything ──────────────────── */
function normalize(raw) {
  const src = (raw && raw.doc ? raw.doc : raw) || {};
  const d = { v: 1, rev: 0, ...src };
  d.ideas = (Array.isArray(src.ideas) ? src.ideas : []).map((raw2, n) => {
    const i = { ...raw2 };                       // unknown fields ride along untouched
    i.id = String(i.id || `X-${n + 1}`);
    i.title = String(i.title || '(untitled)');
    i.note = i.note == null ? '' : String(i.note);
    i.status = String(i.status || 'inbox').toLowerCase();
    i.size = i.size == null ? '' : String(i.size);
    i.tags = Array.isArray(i.tags) ? i.tags.map(String) : (i.tags ? String(i.tags).split(/[\s,]+/).filter(Boolean) : []);
    i.origin = i.origin === 'claude' ? 'claude' : 'user';
    i.order = Number.isFinite(i.order) ? i.order : n;
    i.declineReason = i.declineReason == null ? '' : String(i.declineReason);
    return i;
  });
  return d;
}

/** Replace the in-memory doc with a fresher one from disk. The editor draft, the
 *  focus and any unsaved ops all survive; that is the whole point. */
function adopt(raw, { replay = true, quiet = false } = {}) {
  if (drag) { queuedAdopt = { raw, replay, quiet }; return; }   // never yank the board mid-drag
  const fresh = normalize(raw);
  doc = fresh;
  baseRev = fresh.rev ?? null;
  if (replay) for (const op of pendingOps) applyOp(doc, op);
  // An idea being edited that vanished from the file is re-created rather than
  // dropped: half-typed user text is never the thing we throw away.
  if (edit && !find(edit.id)) {
    const revived = {
      id: edit.id, title: edit.title || '(untitled)', note: edit.note, status: 'inbox',
      size: edit.size, tags: parseTags(edit.tags), origin: 'user', order: 0,
      createdMs: Date.now(), updatedMs: Date.now(), statusMs: Date.now(), declineReason: ''
    };
    const op = { t: 'add', idea: revived };
    applyOp(doc, op); pendingOps.push(op);
    toast(`${edit.id} was gone from the file — your edit was kept`);
    scheduleSave();
  }
  for (const id of [...cardEls.keys()]) if (!find(id)) cardEls.delete(id);
  render();
  if (pendingOps.length) scheduleSave(200);
  if (!quiet) toast('ideas.json changed on disk — reloaded');
}

/* ── rendering (keyed, so DOM identity survives moves and reloads) ──────── */
function buildBoard() {
  board.replaceChildren();
  for (const def of COLUMNS) {
    const col = document.createElement('section');
    col.className = 'col';
    col.dataset.status = def.id;
    col.innerHTML =
      `<div class="col-head"><span class="nm">${esc(def.label)}</span><span class="n">0</span></div>` +
      (def.id === 'inbox'
        ? `<div class="add">
             <input id="addInput" type="text" autocomplete="off" spellcheck="false"
                    placeholder="add an idea…" title="Enter keeps it. t:/k: picks the project, #tag tags it.">
             <div class="proj" role="group" aria-label="project">
               <button type="button" data-proj="T" title="Token Town">T</button>
               <button type="button" data-proj="K" title="Token Tracker">K</button>
             </div>
           </div>` : '') +
      `<div class="empty">${esc(def.empty)}</div><div class="cards"></div>`;
    board.appendChild(col);
    cols.set(def.id, { root: col, cards: col.querySelector('.cards'), count: col.querySelector('.n') });
  }
  wireAddBox();
}

function cardSig(i) {
  return [i.title, i.note, i.size, (i.tags || []).join(','), i.origin, i.declineReason,
    bucketOf(i)].join('');
}

function viewHTML(i) {
  const tags = (i.tags || []).filter(Boolean);
  return `<div class="card-top">` +
    `<span class="cid">${esc(i.id)}</span>` +
    `<span class="by">${i.origin === 'claude' ? 'claude' : 'you'}</span>` +
    (i.size ? `<span class="sz">${esc(i.size)}</span>` : '') +
    `</div>` +
    `<h3 class="ctitle">${esc(i.title)}</h3>` +
    (i.note ? `<p class="cnote">${esc(i.note)}</p>` : '') +
    (tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '') +
    (bucketOf(i) === 'declined' && i.declineReason ? `<p class="reason">${esc(i.declineReason)}</p>` : '');
}

function cardFor(i) {
  let el = cardEls.get(i.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.dataset.id = i.id;
    cardEls.set(i.id, el);
  }
  el.dataset.origin = i.origin === 'claude' ? 'claude' : 'user';
  if (edit && edit.id === i.id) return el;          // the editor owns the body
  const sig = cardSig(i);
  if (el.dataset.sig !== sig) { el.dataset.sig = sig; el.innerHTML = viewHTML(i); }
  return el;
}

function render() {
  if (drag) return;                                  // never re-render mid-drag
  const focus = captureFocus();
  for (const def of COLUMNS) {
    const c = cols.get(def.id);
    const list = ordered(def.id);
    c.count.textContent = String(list.length);
    c.root.classList.toggle('has-cards', list.length > 0);
    c.cards.replaceChildren(...list.map(cardFor));   // moves existing nodes, no rebuild
  }
  restoreFocus(focus);
}

function captureFocus() {
  const a = document.activeElement;
  const card = a && a.closest ? a.closest('.card') : null;
  if (!card) return null;
  return {
    id: card.dataset.id,
    field: a === card ? null : (a.className.split(/\s+/)[0] || null),
    start: a.selectionStart, end: a.selectionEnd
  };
}

function restoreFocus(f) {
  if (!f) return;
  const card = cardEls.get(f.id);
  if (!card || !card.isConnected) return;
  const el = f.field ? card.querySelector('.' + f.field) : card;
  if (!el) { card.focus({ preventScroll: true }); return; }
  el.focus({ preventScroll: true });
  if (f.start != null && el.setSelectionRange) {
    try { el.setSelectionRange(f.start, f.end); } catch { /* not a text field */ }
  }
}

/* ── adding ────────────────────────────────────────────────────────────── */
const parseTags = s => [...new Set(String(s || '').split(/[\s,]+/)
  .map(t => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))];

function wireAddBox() {
  const input = $('#addInput');
  const setProj = p => {
    lastProject = p;
    localStorage.setItem('ideas.project', p);
    for (const b of document.querySelectorAll('.proj button'))
      b.setAttribute('aria-pressed', String(b.dataset.proj === p));
  };
  for (const b of document.querySelectorAll('.proj button'))
    b.addEventListener('click', () => { setProj(b.dataset.proj); input.focus(); });
  setProj(lastProject);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addIdea(input.value); input.value = ''; }
    else if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

/** `t: …` / `k: …` picks the project, `#tag` anywhere becomes a tag. Everything
 *  else is the title — the box must never make you think before typing. */
function addIdea(text) {
  let s = String(text || '').trim();
  if (!s) return;
  let proj = lastProject;
  const pm = /^([tk])\s*[:.]\s*/i.exec(s);
  if (pm) { proj = pm[1].toUpperCase(); s = s.slice(pm[0].length); }
  const tags = [];
  s = s.replace(/(^|\s)#([\w-]+)/g, (_m, sp, t) => { tags.push(t.toLowerCase()); return sp; }).trim();
  if (!s) return;
  const now = Date.now();
  const idea = {
    id: nextId(proj), title: s, note: '', status: 'inbox', size: '', tags,
    origin: 'user', order: -1, createdMs: now, updatedMs: now, statusMs: now, declineReason: ''
  };
  // order -1 then renumber puts a new idea at the TOP of Inbox: the thing you
  // just thought of is the thing you are still thinking about.
  commit('add ' + idea.id, [{ t: 'add', idea }], [{ t: 'remove', id: idea.id }]);
  const el = cardEls.get(idea.id);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

/* ── inline editor ─────────────────────────────────────────────────────── */
function editorHTML(i) {
  return `<div class="card-top"><span class="cid">${esc(i.id)}</span>` +
    `<span class="by">${i.origin === 'claude' ? 'claude' : 'you'}</span></div>` +
    `<div class="editor">` +
    `<input class="e-title" type="text" spellcheck="false" value="${esc(edit.title)}">` +
    `<textarea class="e-note" rows="3" placeholder="why it might be worth it…">${esc(edit.note)}</textarea>` +
    `<div class="e-row">` +
    `<div class="sizes">${SIZES.map(z =>
      `<button type="button" class="e-size" data-size="${z}" aria-pressed="${String(edit.size === z)}">${z}</button>`).join('')}</div>` +
    `<input class="e-tags" type="text" spellcheck="false" placeholder="#tags" value="${esc(edit.tags)}">` +
    `</div>` +
    `<div class="e-row e-actions"><span class="e-hint">esc cancels</span>` +
    `<button type="button" class="btn e-cancel">cancel</button>` +
    `<button type="button" class="btn primary e-save">save</button></div></div>`;
}

function openEditor(id) {
  if (edit && edit.id === id) return;
  if (edit) closeEditor(true);
  const i = find(id);
  if (!i) return;
  edit = { id, title: i.title || '', note: i.note || '', size: i.size || '', tags: (i.tags || []).join(' ') };
  const el = cardEls.get(id);
  if (!el) return;
  el.classList.add('editing');
  el.innerHTML = editorHTML(i);
  const t = el.querySelector('.e-title');
  el.addEventListener('input', onEditInput);
  el.querySelector('.e-note').addEventListener('input', autoGrow);
  autoGrow.call(el.querySelector('.e-note'));
  for (const b of el.querySelectorAll('.e-size')) b.addEventListener('click', () => {
    edit.size = edit.size === b.dataset.size ? '' : b.dataset.size;
    for (const o of el.querySelectorAll('.e-size')) o.setAttribute('aria-pressed', String(o.dataset.size === edit.size));
  });
  el.querySelector('.e-save').addEventListener('click', () => closeEditor(true));
  el.querySelector('.e-cancel').addEventListener('click', () => closeEditor(false));
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

function autoGrow() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 220) + 'px'; }

function onEditInput(e) {
  if (!edit) return;
  const t = e.target;
  if (t.classList.contains('e-title')) edit.title = t.value;
  else if (t.classList.contains('e-note')) edit.note = t.value;
  else if (t.classList.contains('e-tags')) edit.tags = t.value;
}

function closeEditor(save) {
  if (!edit) return;
  const draft = edit; edit = null;
  const el = cardEls.get(draft.id);
  if (el) {
    el.classList.remove('editing');
    el.removeEventListener('input', onEditInput);
    delete el.dataset.sig;                    // force a fresh view render
  }
  const i = find(draft.id);
  if (save && i) {
    const title = draft.title.trim();
    if (!title) toast('a card needs a title — kept the old one');
    const fields = { title: title || i.title, note: draft.note.trim(), size: draft.size, tags: parseTags(draft.tags) };
    const before = { title: i.title, note: i.note, size: i.size, tags: (i.tags || []).slice() };
    const same = fields.title === before.title && fields.note === (before.note || '') &&
      fields.size === (before.size || '') && fields.tags.join(',') === before.tags.join(',');
    if (!same) {
      commit('edit ' + draft.id, [{ t: 'patch', id: draft.id, fields }],
        [{ t: 'patch', id: draft.id, fields: before }]);
      return;                                  // commit() renders
    }
  }
  render();
}

/* ── moving cards ──────────────────────────────────────────────────────── */
/** The single funnel every move goes through — drag, keyboard, whatever comes
 *  later. Declining detours through the reason dialog before anything commits. */
async function moveCard(id, status, before, label) {
  const i = find(id);
  if (!i) return;
  const from = bucketOf(i), fromBefore = beforeIdOf(id);
  if (from === status && (before || null) === fromBefore) return;   // no-op
  const inverse = [{ t: 'place', id, status: i.status, before: fromBefore }];
  const ops = [{ t: 'place', id, status, before: before || null }];
  if (status === 'declined') {
    const reason = await askReason(i);
    if (reason == null) { toast(`kept in ${labelOf(from)} — a decline needs a reason`); return; }
    ops.push({ t: 'patch', id, fields: { declineReason: reason } });
    inverse.unshift({ t: 'patch', id, fields: { declineReason: i.declineReason || '' } });
  }
  commit(label || `move ${id} to ${labelOf(status)}`, ops, inverse);
}
const labelOf = s => (COLUMNS.find(c => c.id === s) || { label: s }).label;

/* ── the decline gate ──────────────────────────────────────────────────── */
function askReason(idea) {
  return new Promise(resolve => {
    reasonTitle.textContent = `Decline ${idea.id} — ${idea.title}`;
    reasonText.value = idea.declineReason || '';
    reasonOk.disabled = !reasonText.value.trim();
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      reasonText.removeEventListener('input', onInput);
      reasonText.removeEventListener('keydown', onKey);
      reasonOk.removeEventListener('click', onOk);
      reasonCancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onInput = () => { reasonOk.disabled = !reasonText.value.trim(); };
    const onOk = () => { const v = reasonText.value.trim(); if (v) finish(v); };
    const onCancel = e => { if (e) e.preventDefault(); finish(null); };
    const onKey = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onOk(); }
      e.stopPropagation();                       // the board's hotkeys stay out of here
    };
    reasonText.addEventListener('input', onInput);
    reasonText.addEventListener('keydown', onKey);
    reasonOk.addEventListener('click', onOk);
    reasonCancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    reasonText.focus();
  });
}

/* ── drag and drop ─────────────────────────────────────────────────────────
 * Pointer events, not HTML5 drag-and-drop, and the reasons are concrete:
 *   · HTML5 DnD hands the drag image to the OS — no tilt, no shadow, no control
 *     of the grab offset, and no way to animate a spring-back on an invalid drop.
 *   · dragover/dragleave fire per child element, so every real implementation
 *     ends up counting enter/leave events to stop the drop indicator flickering.
 *   · dataTransfer is useless to us: both ends are the same document.
 *   · Decisively: synthetic drag events cannot drive the OS drag loop, so a
 *     headless screenshot run could never verify the drag. Pointer events can be
 *     dispatched, so the mid-drag frame below is a thing I can actually capture.
 */
const PRESS_SLOP = 5;
let press = null;

board.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const card = e.target.closest('.card');
  if (!card || card.classList.contains('editing')) return;
  if (e.target.closest('input, textarea, button')) return;
  const r = card.getBoundingClientRect();
  press = { id: card.dataset.id, card, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', cancelDrag);
});

function onPointerMove(e) {
  if (!press) return;
  if (!drag) {
    if (Math.abs(e.clientX - press.x) < PRESS_SLOP && Math.abs(e.clientY - press.y) < PRESS_SLOP) return;
    beginDrag(e);
  }
  drag.px = e.clientX; drag.py = e.clientY;
  drag.clone.style.left = (e.clientX - drag.dx) + 'px';
  drag.clone.style.top = (e.clientY - drag.dy) + 'px';
  placeSlot(e.clientX, e.clientY);
}

function beginDrag(e) {
  if (edit) closeEditor(true);
  const card = cardEls.get(press.id) || press.card;
  const r = card.getBoundingClientRect();
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.style.height = r.height + 'px';
  card.after(slot);
  const clone = card.cloneNode(true);
  clone.classList.remove('is-source');
  clone.removeAttribute('tabindex');
  clone.style.width = r.width + 'px';
  clone.style.left = (e.clientX - press.dx) + 'px';
  clone.style.top = (e.clientY - press.dy) + 'px';
  dragLayer.appendChild(clone);
  card.classList.add('is-source');
  document.body.classList.add('dragging');
  drag = {
    id: press.id, card, clone, slot, dx: press.dx, dy: press.dy,
    from: bucketOf(find(press.id)), fromBefore: beforeIdOf(press.id),
    px: e.clientX, py: e.clientY
  };
  autoScrollTick();
}

/** Where would it land? First card whose midpoint is below the cursor. */
function placeSlot(x, y) {
  const col = (document.elementFromPoint(x, y) || document.body).closest('.col');
  for (const c of cols.values()) c.root.classList.toggle('drop-target', !!col && c.root === col);
  if (!col) return;
  const list = cols.get(col.dataset.status).cards;
  let target = null;
  for (const n of list.children) {
    if (!n.classList.contains('card') || n.classList.contains('is-source')) continue;
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2) { target = n; break; }
  }
  if (target) { if (drag.slot.nextElementSibling !== target || drag.slot.parentElement !== list) list.insertBefore(drag.slot, target); }
  else if (drag.slot.parentElement !== list || drag.slot.nextElementSibling) list.appendChild(drag.slot);
}

/** A column taller than its viewport has to scroll while you hold a card over
 *  its edge, or the bottom of Proposed is unreachable with the mouse alone. */
function autoScrollTick() {
  if (!drag) return;
  const el = drag.slot.parentElement;
  if (el && el.scrollHeight > el.clientHeight) {
    const r = el.getBoundingClientRect(), zone = 46;
    let dv = 0;
    if (drag.py < r.top + zone) dv = -Math.ceil((r.top + zone - drag.py) / 4);
    else if (drag.py > r.bottom - zone) dv = Math.ceil((drag.py - (r.bottom - zone)) / 4);
    if (dv) { el.scrollTop += dv; placeSlot(drag.px, drag.py); }
  }
  requestAnimationFrame(autoScrollTick);
}

function onPointerUp(e) {
  const p = press, d = drag;
  detachPointer();
  if (!d) {                                   // a click, not a drag → edit in place
    if (p && e.target.closest('.card') === p.card) openEditor(p.id);
    return;
  }
  const col = d.slot.closest('.col');
  const status = col ? col.dataset.status : d.from;
  let before = null;
  for (let n = d.slot.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains('card') && !n.classList.contains('is-source')) { before = n.dataset.id; break; }
  }
  const dropRect = d.slot.getBoundingClientRect();
  finishDrag(d);
  // The model moves NOW; the clone's flight is decoration that can be missed.
  const p2 = moveCard(d.id, status, before);
  flyClone(d.clone, cardEls.get(d.id), dropRect);
  if (p2 && p2.then) p2.then(afterDrag); else afterDrag();
}

function cancelDrag() {
  const d = drag;
  detachPointer();
  if (!d) return;
  const rect = d.slot.getBoundingClientRect();
  finishDrag(d);
  render();
  flyClone(d.clone, cardEls.get(d.id), rect);
  afterDrag();
}

function detachPointer() {
  press = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', cancelDrag);
}

/** Tear the drag state down BEFORE committing, so render() is unblocked. */
function finishDrag(d) {
  drag = null;
  d.slot.remove();
  d.card.classList.remove('is-source');
  document.body.classList.remove('dragging');
  for (const c of cols.values()) c.root.classList.remove('drop-target');
}

function flyClone(clone, landing, fallbackRect) {
  const r = (landing && landing.isConnected) ? landing.getBoundingClientRect() : fallbackRect;
  clone.classList.add('returning');
  clone.style.left = r.left + 'px';
  clone.style.top = r.top + 'px';
  setTimeout(() => clone.remove(), 200);
}

function afterDrag() {
  if (!queuedAdopt) return;
  const q = queuedAdopt; queuedAdopt = null;
  adopt(q.raw, q);
}

/* ── keyboard ──────────────────────────────────────────────────────────── */
const cardsIn = status => ordered(status).map(i => cardEls.get(i.id)).filter(Boolean);

function focusNeighbour(card, dCol, dRow) {
  const status = card.closest('.col').dataset.status;
  const ix = COLUMNS.findIndex(c => c.id === status);
  const list = cardsIn(status);
  const row = list.indexOf(card);
  if (dRow) {
    const n = list[row + dRow];
    if (n) n.focus();
    return;
  }
  for (let k = ix + dCol; k >= 0 && k < COLUMNS.length; k += dCol) {
    const other = cardsIn(COLUMNS[k].id);
    if (other.length) { (other[Math.min(row, other.length - 1)]).focus(); return; }
  }
}

document.addEventListener('keydown', e => {
  if (dlg.open) return;
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');

  if (typing && a.closest('.card')) {                  // inside the inline editor
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
    else if (e.key === 'Enter' && !e.shiftKey && !a.classList.contains('e-note')) {
      e.preventDefault(); closeEditor(true);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeEditor(true); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault(); undo(); return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); const i = $('#addInput'); if (i) { i.focus(); i.select(); } return; }
  if (e.key === 'Escape') { if (drag) cancelDrag(); else if (edit) closeEditor(false); return; }

  const card = a && a.closest ? a.closest('.card') : null;
  if (!card) {
    if (e.key.startsWith('Arrow')) {                   // enter the board from nowhere
      const first = COLUMNS.map(c => cardsIn(c.id)[0]).find(Boolean);
      if (first) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  const id = card.dataset.id;
  const status = card.closest('.col').dataset.status;
  const ix = COLUMNS.findIndex(c => c.id === status);

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const to = COLUMNS[ix + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!to) return;
      const row = cardsIn(status).indexOf(card);
      const dest = ordered(to.id);
      moveCard(id, to.id, (dest[Math.min(row, dest.length)] || {}).id || null);
      requestAnimationFrame(() => { const el = cardEls.get(id); if (el) el.focus({ preventScroll: true }); });
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = ordered(status), row = list.findIndex(i => i.id === id);
      const to = row + (e.key === 'ArrowDown' ? 1 : -1);
      if (to < 0 || to >= list.length) return;
      // moving down means landing *after* the card currently there
      const before = e.key === 'ArrowDown' ? (list[to + 1] || {}).id || null : list[to].id;
      moveCard(id, status, before, `reorder ${id}`);
      requestAnimationFrame(() => { const el = cardEls.get(id); if (el) el.focus({ preventScroll: true }); });
    }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); focusNeighbour(card, 0, e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); focusNeighbour(card, e.key === 'ArrowRight' ? 1 : -1, 0); }
  else if (e.key === 'Enter') { e.preventDefault(); openEditor(id); }
});

/* ── chrome ────────────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 4200);
}

function showBanner(msg) { banner.textContent = msg; banner.classList.add('on'); }

/* ── boot ──────────────────────────────────────────────────────────────── */
buildBoard();
render();

if (!bridge) {
  showBanner('No store bridge — this window is not connected to ideas.json, so nothing you type here will be kept.');
  setSave('failed', 'no store');
} else {
  bridge.load().then(d => {
    adopt(d, { replay: false, quiet: true });
    setSave(d && d.readOnly ? 'idle' : 'saved', d && d.readOnly ? 'read-only' : 'saved');
    if (d && d.path) $('#fileChip').textContent = d.path;
    if (d && d.notice) toast(d.notice.message);
  }).catch(err => {
    showBanner('Could not read ideas.json: ' + ((err && err.message) || err));
    setSave('failed', 'load failed');
  });
  bridge.onExternalChange(d => {
    if (d && normalize(d).rev === baseRev && baseRev != null) return;   // our own write, echoed
    if (d && (d.ideas || d.doc || Array.isArray(d))) adopt(d);
    else bridge.load().then(fresh => adopt(fresh)).catch(() => { });
  });
  // A window that is closing must not sit on an unsaved keystroke.
  window.addEventListener('beforeunload', () => { if (edit) closeEditor(true); if (dirty) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) flush(); });
}

/* ── DOM / CSS hooks the design lane can rely on ───────────────────────────
 *  header · #fileChip · #keys · #saveState[data-state=idle|dirty|saving|saved|failed]
 *  #banner.on · #toast.on · #dragLayer · dialog#reasonDlg .dlg
 *  #board > .col[data-status=inbox|proposed|approved|building|shipped|declined]
 *    .col-head > .nm/.n · .col.has-cards · .col.drop-target · --tint per column
 *    .add > #addInput + .proj button[data-proj][aria-pressed]
 *    .cards > .card | .slot   ·   .empty
 *  .card[data-id][data-origin=user|claude] .card-top>.cid/.by/.sz, .ctitle,
 *    .cnote, .tags>.tag, .reason ; states: .editing .is-source :focus-visible
 *  .card .editor > .e-title .e-note .sizes>.e-size[aria-pressed] .e-tags
 *    .e-actions > .e-hint .e-cancel .e-save ; .btn/.btn.primary are shared
 *  Anything may be restyled from theme.css; only .card.is-source (display:none),
 *  .slot's height and #dragLayer .card's left/top are set from JS.
 */
