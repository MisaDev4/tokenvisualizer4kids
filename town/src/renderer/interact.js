// The interaction layer — everything that answers "what is that, and what can I
// do with it". Three things live here and nothing else does:
//
//   1. PICKING — a 20 Hz ray against town.js's live `hitTargets` plus npcs' own
//      closed-form crowd pick. The hovered thing gets the cursor, a 3 % lift and
//      the receipt tooltip, so the town reads as touchable before you click it.
//   2. THE DEED CARD — click a building, a villager or the altar and a docked
//      card says what it is, what it cost, and which stretch of your day paid for
//      it. A gold ring lands on the ground under the subject and binds the two.
//   3. THE CHROME — the keymap, the mode pill, one self-expiring toast, the
//      first-launches hint strip and the `?` key sheet.
//
// interact.js imports nothing but three.js. town.js is the sole mediator: it
// hands us `describe(entity) → Deed` (its widened `tipFor`) and a rig to drive.
// EVERY input is optional — with no `describe`, no `rig` and no roster this file
// still runs, and degrades to today's hover tooltip and nothing more (§3 null
// object). It never throws on a missing capability and never swallows an error
// from the raycast: a broken pick must be visible in the banner, not silent.
//
// EXISTENCE IS WALL-CLOCK. Ring opacity, card presence, toast expiry, the hint
// strip and the `--select` retry all key off the `now` town.js passes in; `dt` is
// never read and never accumulated. A 9 s headless capture must always land on a
// lit ring and a finished card, and at ~1 fps a dt-paced fade would still be
// invisible. Corollary, and the most important implementation note in this file:
// BASE CSS IS THE FINAL STATE — every element's resting style is its visible
// style and the keyframes only travel toward it, so a throttled compositor can
// never screenshot a blank card. `[hidden]` does all the hiding.
//
// WE CANNOT EDIT index.html (append-only, owned elsewhere), so this file injects
// its own banner-delimited base sheet BEFORE the core sheet — anything index.html
// also styles wins there, and anything it does not still looks right — and builds
// its own nodes into the container it is handed (`cfg.stage`).
//
// LOD IS A PARTNER, NOT A SPECIAL CASE (§8.1). Once lod.js lands, settled houses
// are re-parented under its `coldRoot` and leave `hitTargets`, so neither "the
// child of the scene" nor the raycaster can find one again. Two consequences,
// both local to this file: `groupOf` resolves a hit by OWNERSHIP — the outermost
// node still carrying the same entity, which is exactly the group town.js
// mounted — and `pickAt` folds `lod.pick(ray)`/`lod.pickDist` into the same
// nearest-wins contest as the raycaster and the crowd. `cfg.lod` is optional and
// every call on it is probed: with no lod this file is byte-for-byte the
// behaviour it had before stage E.
//
// THE VIGNETTE HAS ONE OWNER AND IT IS NOT US (§8.4). `--vig` is an inline style
// on <html>, written by environs.js today and taken over by postfx.js from stage
// C. A `body.photo{--vig:.30}` rule here would beat both — `body` is a nearer
// ancestor of `.stage::after` than `:root` — and photo mode would be vignetted
// twice, once in the shader and once in CSS. So the rule is deliberately absent:
// photo mode takes the chrome away and touches nothing else.
//
// PUBLIC SURFACE (backlog §4.3)
//   initInteract(cfg) → { update(now, ctx), afterRender(), select(entity),
//                         clearSelection(), toast(msg, ms), reset(), dispose() }
//   `reset()` is the epoch hook (§5 risk 3); `dispose()` is shutdown.
//
// COST: 1 draw call (the selection ring — additive, no shadow, no depth write)
// and no new material or geometry per selection. CPU: the 20 Hz ray is the hover
// block moved out of town.js, not new work; the crowd pick is ~160 × 12 flops on
// the same 20 Hz beat; per frame we touch one group scale and one ring uniform.
// Zero allocation in update() — every vector, colour and ray is hoisted, and the
// card's dt/dd nodes are pooled. Measured budget: < 0.9 ms/frame in orbit.
//
// WHAT THE INTEGRATION WAVE MUST WIRE (all of it one-line):
//   • `const ui = initInteract({ stage, canvas, scene, camera, rig, hitTargets,
//        npcs, describe: describeEnt, sources: shotSources, getPlan: () => plan,
//        villager: news.villagerFor, saveShot: window.townAPI?.saveShot })`
//     — created after `rig` and `npcs`, before the first `tick()`.
//   • the day stage E lands, two more fields: `lod, houses` — that is the WHOLE
//     of §8.1's handshake on this side, and it needs nothing else from town.js.
//   • `ui.update(now, ctx)` in `tick()` AFTER the animEnts pop/bump block (it
//     multiplies the scale that block writes) and after `rig.update()`.
//   • `ui.afterRender()` on the line after `renderer.render(scene, camera)` — the
//     picture grab is only legal in the same task as the draw.
//   • `hardReset()` → `ui.reset()`.
//   • town.js's hover block (the Raycaster, the mousemove/mouseleave listeners,
//     the `#tip` writes in `tick()`) is deleted; `tipFor` becomes `describeEnt`
//     and returns a Deed. Until it does, its three-string return still works.
//   • main.js forwards `select` and `shot-ui` in its query list (§4.9).
import * as THREE from './vendor/three.module.js';

/**
 * @typedef {Object} Deed  what town.js's describe() returns for an entity
 * @property {string} title              'Villa'
 * @property {string} [badge]            '✦ Painted Lady' — gold pill beside the title
 * @property {string} sub                '#142 of 431 · band 3'
 * @property {Array<[string,string]>} rows   ≤ 5 label/value pairs
 * @property {string} [flavor]           ONE italic line, Crier voice
 * @property {string[]} [acts]           action ids: 'focus'|'follow'|'walk'|'tour'
 * @property {{x:number,y:number,z:number,hTop:number,dist?:number}} at   focus + ring anchor
 *   `dist` is an OPTIONAL framing override in world units. camera.js sizes a
 *   focus from `hTop` and caps it at 46, which frames a house perfectly and puts
 *   a 54-unit altar's own pillars across the whole frame. Only describe() knows
 *   a subject is wider than it is tall, so only describe() may say so.
 * @property {boolean} [live]            re-render the rows once a second
 */
/**
 * @typedef {Object} InteractConfig
 * @property {HTMLElement} stage         the container every overlay is built into
 * @property {HTMLCanvasElement} canvas
 * @property {THREE.Scene} scene
 * @property {THREE.PerspectiveCamera} camera
 * @property {Object} [rig]              camera.js's rig; absent ⇒ no camera verbs
 * @property {Array<THREE.Object3D>} [hitTargets]   town.js's LIVE array — shared, never copied
 * @property {Object} [lod]              lod.js's system: `pick`/`pickDist`/`entAt`/`boxAt`/
 *                                       `tierOf`/`maxOrd`, each probed. Absent ⇒ stage-E-less
 * @property {Array<Object>} [houses]    town.js's LIVE ordinal→entity array; only a fallback
 *                                       for `lod.entAt`, and unnecessary when lod is passed
 * @property {Object} [npcs]             the crowd; every method probed before use
 * @property {(e:Object)=>(Deed|string[])} [describe]
 * @property {()=>Object} [sources]      shot sources (the tour's; accepted, unused here)
 * @property {()=>Object} [getPlan]
 * @property {(seed:number)=>{name:string,trade:string}} [villager]
 * @property {(name:string,dataURL:string)=>Promise<string>} [saveShot]
 */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const slug = s => String(s || 'town').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'town';

/* ═══ base sheet ════════════════════════════════════════════════
   Inserted at the TOP of <head> so index.html's core sheet always wins a tie —
   the same contract news.js ships under. Every resting state is the visible one. */
const CSS = `
/* ═══════════════ v4: interact ═══════════════ */
#deed[hidden],#modePill[hidden],#toast[hidden],#keys[hidden],#sheet[hidden]{display:none}
#gl.pick{cursor:pointer}
#tip .t4{color:#6f6d66; margin-top:2px}
#tip.mine{position:absolute; background:rgba(16,16,15,.94); border:1px solid rgba(255,255,255,.18);
  border-radius:6px; padding:6px 9px; font:11px "Segoe UI",system-ui; pointer-events:none; z-index:5;
  white-space:nowrap; color:#C3C2B7}
#tip.mine .t1{color:#EDEBE0; font-weight:600} #tip.mine .t3{color:#898781}
#deed{position:absolute; left:16px; bottom:16px; width:306px; max-width:calc(100% - 32px); z-index:4;
  background:rgba(20,20,19,.94); border:1px solid var(--hairline,rgba(255,255,255,.10));
  border-radius:10px; padding:13px 15px 12px; box-shadow:0 10px 34px rgba(0,0,0,.55);
  opacity:1; transform:none}
#deed.in{animation:deedIn .22s cubic-bezier(.2,.9,.3,1)}
@keyframes deedIn{from{opacity:.25; transform:translateY(10px)} to{opacity:1; transform:none}}
#deed .dHead{display:flex; align-items:baseline; gap:8px; padding-right:16px}
#deed .dName{color:var(--ink,#fff); font:600 16px "Segoe UI",system-ui}
#deed .dBadge{font-size:10.5px; color:#14120C; background:var(--accent,#D9A441);
  border-radius:9px; padding:1px 7px; white-space:nowrap}
#deed .dBadge:empty{display:none}
#deed .dSub{color:var(--muted,#898781); font-size:11.5px; margin-top:2px}
#deed dl{display:grid; grid-template-columns:96px 1fr; gap:3px 10px; margin:11px 0 0; font-size:12px}
#deed dl:empty{display:none}
#deed dt{color:var(--muted,#898781)}
#deed dd{margin:0; color:var(--ink2,#C3C2B7); font-variant-numeric:tabular-nums}
#deed .dFlavor{margin-top:10px; color:#CBB07A; font-style:italic; font-size:12px}
#deed .dFlavor:empty{display:none}
#deed .dActs{margin-top:11px; display:flex; gap:7px; flex-wrap:wrap}
#deed .dActs:empty{display:none}
#deed button.act{background:rgba(255,255,255,.06); border:1px solid var(--hairline,rgba(255,255,255,.10));
  color:var(--ink2,#C3C2B7); border-radius:7px; padding:4px 10px; font:11.5px "Segoe UI",system-ui; cursor:pointer}
#deed button.act:hover{background:rgba(217,164,65,.18); border-color:rgba(217,164,65,.5); color:var(--ink,#fff)}
#deed .dX{position:absolute; top:7px; right:8px; background:none; border:0; cursor:pointer;
  color:var(--muted,#898781); font-size:13px; line-height:1; padding:2px 4px}
#deed .dX:hover{color:var(--ink,#fff)}
#modePill{position:absolute; top:12px; left:50%; transform:translateX(-50%); z-index:5;
  background:rgba(16,16,15,.88); border:1px solid var(--hairline,rgba(255,255,255,.10));
  border-radius:14px; padding:5px 13px; font-size:12px; color:var(--ink2,#C3C2B7);
  white-space:nowrap; text-align:center; max-width:calc(100% - 28px); overflow:hidden; text-overflow:ellipsis}
#modePill kbd,#sheet kbd{font:600 10.5px "Segoe UI",system-ui; color:var(--muted,#898781);
  border:1px solid var(--hairline,rgba(255,255,255,.10)); border-radius:4px; padding:0 4px; margin:0 2px}
#toast{position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:6;
  background:rgba(16,16,15,.92); border:1px solid var(--hairline,rgba(255,255,255,.10));
  border-radius:8px; padding:7px 14px; font-size:12.5px; color:var(--ink2,#C3C2B7); max-width:78%}
#keys{position:absolute; bottom:16px; left:50%; transform:translateX(-50%); z-index:5;
  font-size:12px; color:var(--muted,#898781); background:rgba(13,13,13,.5);
  padding:6px 14px; border-radius:9px; max-width:88%; text-align:center}
#sheet{position:absolute; inset:0; z-index:7; display:grid; place-items:center;
  background:rgba(13,13,13,.72)}
#sheet .card{background:rgba(20,20,19,.96); border:1px solid var(--hairline,rgba(255,255,255,.10));
  border-radius:12px; padding:18px 22px 16px; box-shadow:0 14px 44px rgba(0,0,0,.6);
  max-height:86%; overflow:auto}
#sheet h2{margin:0 0 12px; font:600 14px "Segoe UI",system-ui; color:var(--ink,#fff);
  letter-spacing:.06em; text-transform:uppercase}
#sheet dl{display:grid; grid-template-columns:auto 1fr; gap:5px 16px; margin:0; font-size:12.5px}
#sheet dt{color:var(--ink2,#C3C2B7); white-space:nowrap}
#sheet dd{margin:0; color:var(--muted,#898781)}
#sheet .foot{margin-top:14px; font-size:11px; color:var(--muted,#898781)}
#sheet .card.honours{width:min(520px,90vw)}
#sheet .hCount{margin:-6px 0 12px; font-size:11.5px; letter-spacing:.06em;
  text-transform:uppercase; color:var(--accent,#D9A441)}
#sheet .hList{list-style:none; margin:0; padding:0; display:grid; gap:8px}
#sheet .hList li{display:grid; grid-template-columns:22px 1fr; gap:2px 10px; align-items:baseline}
#sheet .hIcon{grid-row:span 2; font-size:15px; line-height:1.1}
#sheet .hName{font:600 12.5px "Segoe UI",system-ui; color:var(--ink,#fff)}
#sheet .hBlurb{font-size:11.5px; color:var(--muted,#898781)}
#sheet .hEmpty{margin-top:2px}
body.photo header,body.photo #news,body.photo footer,
body.photo #deed,body.photo #tip,body.photo #keys,body.photo #modePill,
/* #overlay is where news.js's speech bubbles and the milestone floaters live.
   They are DOM, not scene, so they survived a mode whose key-sheet promise is
   'chrome out of the way' — and Ctrl+S saves exactly what is on screen, so two
   bubbles ended up in the saved PNG. */
body.photo #overlay,body.photo #banner{display:none}
/* NO --vig here, on purpose (§8.4): the vignette has exactly one owner, the
   inline style on <html> — environs.js today, postfx.js from stage C — and a
   rule on body would silently beat both and darken photo mode twice. */
/* ═══ the stroll's chrome ═══════════════════════════════════════
   PHOTO MODE'S TREATMENT, ONE STEP SHORT OF IT. At 200 units the header, the
   Crier's row and the footer are a margin round a picture of a town; at eye
   height they are ~19 % of the frame taken off the top and the bottom, and the
   top and the bottom of a street-level frame are the sky and the road — the two
   things you went down there to look at.

   The lever is LAYOUT, not opacity. <body> is a flex COLUMN of
   header / #news / .stage / footer, so the three siblings do not cover the
   canvas, they SHORTEN it. Taking header and footer out of flow (they are
   position:static children of a static body, so absolute resolves against the
   viewport) gives every pixel of that height to .stage and leaves the readouts
   floating over the picture, scrimmed, where they cost nothing but their own
   ink. The user keeps the number they came for; the frame comes back whole.

   THE CRIER'S ROW GOES ENTIRELY, and it is the one thing here that is a real
   loss. It is the widest, tallest band of the three and it sits exactly on the
   roof line. It is also the one whose content has a better channel at street
   level: news.js speaks through #overlay bubbles over the villagers' own heads,
   and the Crier is a person you can walk up to. It is back the moment you leave.

   THE CENSUS GOES TOO (.zB — buildings, villagers, Prosperity). Down here you
   are standing in the answer. .zA (the total) and .zC (what is coming next)
   are the two things a walk cannot show you, so they stay. */
body.stroll #news{display:none}
/* The scrims are heavier than they look on a dark page because what is behind
   them at eye level is a WHITE NOON SKY and a sunlit road, not the near-black
   the palette was picked against. A gradient that reads as a whisper over a
   0x0D page has to be a real gradient over a lit cobble street or the hero
   number — amber on cream — is illegible. */
body.stroll header,body.stroll #stats{position:absolute; left:0; right:0; z-index:6;
  border:0; text-shadow:0 1px 4px rgba(0,0,0,.95), 0 0 12px rgba(0,0,0,.6)}
body.stroll header{top:0; padding:7px 16px;
  background:linear-gradient(180deg,rgba(9,9,9,.86) 0%,rgba(9,9,9,.52) 62%,rgba(9,9,9,0) 100%)}
/* pointer-events:none on the footer only: it is a pure readout, and floated it
   now sits over 40-odd px of canvas that a click ought to be able to reach. The
   header keeps its events — almanac.js hangs the parchment card off hovering it. */
body.stroll #stats{bottom:0; padding:26px 16px 8px; pointer-events:none;
  background:linear-gradient(0deg,rgba(9,9,9,.88) 0%,rgba(9,9,9,.55) 48%,rgba(9,9,9,0) 100%)}
body.stroll #stats .zB{display:none}
/* …and our own nodes stand off the two floating strips rather than under them */
body.stroll #modePill{top:44px}
body.stroll #deed{bottom:56px}
body.stroll #toast,body.stroll #keys{bottom:54px}
/* --shot-ui=0. This used to hide only interact's own nodes, which made it a
   'hide the interaction layer' switch wearing a 'no chrome' label: the header,
   the crier bar and the footer all stayed, so nobody using it for a clean plate
   got one. It now means what almanac.js's comment says it means. */
body.noui header,body.noui #news,body.noui footer,body.noui #overlay,
body.noui #deed,body.noui #tip,body.noui #keys,body.noui #modePill,
body.noui #toast,body.noui #sheet{display:none}
@media (prefers-reduced-motion:reduce){#deed.in{animation:none}}
@media (max-width:820px){#deed{width:264px}}
`;
function ensureCss() {
  if (document.getElementById('interactBaseCss')) return;
  const st = document.createElement('style');
  st.id = 'interactBaseCss'; st.textContent = CSS;
  const h = document.head || document.documentElement;
  h.insertBefore(st, h.firstChild);
}

/* ═══ copy ══════════════════════════════════════════════════════
   §6 gate: celebratory or plainly descriptive, never an instruction aimed at the
   user. Every line here is a noun phrase or third person — "a click opens a
   deed", not "click a building" — and every mode line names its own exit. */
const ACT_LABEL = { focus: 'Focus', follow: 'Follow a resident', walk: 'Walk there', tour: 'Tour the town' };
const MODE_LINE = {
  focus: 'Looking closer', follow: 'Following along', tour: 'A tour of the town',
  photo: 'Photo mode', stroll: 'Down at street level', orbit: ''
};
const MODE_TOAST = {
  focus: 'Looking closer · <kbd>Esc</kbd> for the whole town',
  follow: 'Following along · <kbd>Esc</kbd> to let them go',
  tour: 'A tour of the town · <kbd>Esc</kbd> to stop it',
  photo: 'Photo mode · <kbd>Ctrl</kbd>+<kbd>S</kbd> saves the picture · <kbd>Esc</kbd> to leave',
  stroll: 'Down at street level · <kbd>Esc</kbd> for the whole town again'
};
// The first clause is the first thing a hand does, so it names the LEFT button's
// gesture: camera.js drags the town with it and looks around with the right.
const HINT_LINE = 'a drag moves the town · right-drag looks around · a click opens a deed · '
  + '<kbd>F</kbd> follows a villager · <kbd>T</kbd> tours the town · <kbd>?</kbd> for every key';
const TIP_HINT = '— a click opens the deed';

/**
 * Build the interaction layer. Safe to call with an empty config: every
 * capability is probed, and the ones that are missing simply do not exist.
 * @param {InteractConfig} cfg
 * @returns {Object} the InteractUI of §4.3
 */
export function initInteract(cfg) {
  const c = cfg || {};
  const stage = c.stage || null, canvas = c.canvas || null;
  const scene = c.scene || null, camera = c.camera || null;
  const rig = c.rig || null, npcs = c.npcs || null;
  // LAZY, because the almanac is built after us: town.js hands a getter, not the
  // module. Everything below probes through alm() so an app without one simply
  // has no 'A' key and no arbiter, which is the null-object rule this file runs on.
  const almGet = typeof c.almanac === 'function' ? c.almanac : () => (c.almanac || null);
  // charter.ledger() — plain data for the honours sheet. Same lazy shape and same
  // null-object rule: no ledger, no 'H' key, no row in the sheet.
  const ledgerOf = typeof c.ledger === 'function' ? c.ledger : null;
  const alm = () => { const a = almGet(); return a && typeof a.showCard === 'function' ? a : null; };
  const hitTargets = Array.isArray(c.hitTargets) ? c.hitTargets : [];
  const lod = c.lod || null, houses = Array.isArray(c.houses) ? c.houses : null;
  const describe = typeof c.describe === 'function' ? c.describe : null;
  const villager = typeof c.villager === 'function' ? c.villager : null;
  const saveShot = typeof c.saveShot === 'function' ? c.saveShot : null;
  const can = (o, k) => !!(o && typeof o[k] === 'function');

  ensureCss();

  /* ── test hooks. main.js forwards `select` and `shot-ui` (§4.9); read here so
     the module is self-contained and a plain browser gets them too. ── */
  const Q = new URLSearchParams(location.search);
  const SHOT_UI = Q.get('shot-ui') !== '0';
  let pendingSel = Q.get('select') || null, pendingAt = 0, pendingSince = 0;
  if (!SHOT_UI) document.body.classList.add('noui');
  /* `--cam=beat` — the only way to photograph the sky beat. It is a MILESTONE
     reaction and town.js fires it from fireMilestone, which a headless run has no
     way to provoke; town.js's own --cam dispatch does not know the word and falls
     through to `rig.orbit({snap:true})`, which is exactly the state the beat is
     supposed to lift out of. Paired with `--bow=1 --hour=18` this is the shot
     that proves weather.js's rainbow is reachable. */
  let pendingBeat = Q.get('cam') === 'beat' ? 4200 : 0;

  /* ═══ DOM. We own every node we mint; `#tip` is adopted if the core shipped
     one, so its shipped styling keeps applying and only the fourth line is new. */
  const mk = (tag, id, parent, cls) => {
    const el = document.createElement(tag);
    if (id) el.id = id; if (cls) el.className = cls;
    (parent || stage).appendChild(el);
    return el;
  };
  const minted = [];
  let tipEl = stage ? stage.querySelector('#tip') : null;
  const tipAdopted = !!tipEl;
  if (stage && !tipEl) {
    tipEl = mk('div', 'tip', stage, 'mine'); minted.push(tipEl);
    for (const k of ['t1', 't2', 't3']) mk('div', '', tipEl, k);
    tipEl.style.display = 'none';
  }
  let tipL4 = null;
  if (tipEl) { tipL4 = mk('div', '', tipEl, 't4'); }

  let deedEl = null, dName = null, dBadge = null, dSub = null, dRows = null, dFlavor = null, dActs = null;
  let pillEl = null, toastEl = null, keysEl = null, sheetEl = null;
  if (stage) {
    deedEl = mk('aside', 'deed'); minted.push(deedEl);
    deedEl.hidden = true;
    const x = mk('button', '', deedEl, 'dX'); x.textContent = '✕';
    x.setAttribute('aria-label', 'close');
    x.addEventListener('click', () => clearSelection());
    const head = mk('div', '', deedEl, 'dHead');
    dName = mk('span', '', head, 'dName'); dBadge = mk('span', '', head, 'dBadge');
    dSub = mk('div', '', deedEl, 'dSub');
    dRows = mk('dl', '', deedEl, 'dRows');
    dFlavor = mk('div', '', deedEl, 'dFlavor');
    dActs = mk('div', '', deedEl, 'dActs');

    pillEl = mk('div', 'modePill'); pillEl.hidden = true; minted.push(pillEl);
    toastEl = mk('div', 'toast'); toastEl.hidden = true; minted.push(toastEl);
    keysEl = mk('div', 'keys'); keysEl.hidden = true; minted.push(keysEl);
    keysEl.innerHTML = HINT_LINE;
    sheetEl = mk('div', 'sheet'); sheetEl.hidden = true; minted.push(sheetEl);
  }

  /* ═══ the selection ring — the whole 3D footprint of this module ═══
     One geometry, one material, one mesh, scaled per subject: a ring minted per
     selection would leak a geometry every click across an epoch's lifetime. */
  // TWO RINGS, NORMAL BLENDING. One additive gold ring reads beautifully over wet
  // road and vanishes over pale sand — additive over an already-bright surface adds
  // almost nothing, and on the altar's plaza it was invisible outright. The ring is
  // the only spatial answer to 'which one did I click', so it may not be the thing
  // that fails on a bright afternoon. A thin dark ring immediately outside a bright
  // one reads on any ground there is.
  const ringGeo = new THREE.RingGeometry(.92, 1, 40).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xFFDE93, transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide
  });
  const haloGeo = new THREE.RingGeometry(1, 1.09, 40).rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x14120C, transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  const halo = new THREE.Mesh(haloGeo, haloMat);
  ring.renderOrder = 2; ring.visible = false; ring.matrixAutoUpdate = true;
  halo.renderOrder = 1; halo.visible = false; halo.matrixAutoUpdate = true;
  ring.frustumCulled = false; halo.frustumCulled = false;
  ring.raycast = () => { };          // or the ring becomes its own hover target
  halo.raycast = () => { };
  if (scene) { scene.add(ring); scene.add(halo); }
  let ringK = 0;                     // 0..1 wall-clock fade

  /* ═══ state ════════════════════════════════════════════════════ */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const _v = new THREE.Vector3(), _p = { x: 0, y: 0, z: 0 };
  let mouseIn = false, mousePx = { x: 0, y: 0 }, rect = null, rectAt = -1e9;
  let hoverAt = 0, hover = null, hoverGroup = null, hoverDeed = null;
  let sel = null, selGroup = null, selDeed = null, liveAt = 0;
  let downAt = 0, downX = 0, downY = 0, dragPx = 0;
  let lastNow = 0, mode = 'orbit', modeSeen = 'orbit';
  let toastUntil = 0, sheetOpen = false;
  let firstDataAt = 0, hintFrom = 0, hintDone = false, tipHints = 0;
  let grabWanted = false, grabCtx = null, grabName = '';
  let dead = false, lastCtx = null;

  /* ── hover/selection lift. A hovered building rises 3 %: the single cheapest
     signal that the town is touchable. Two slots at most (hover + selection),
     keyed by group so a group that is both only lifts once.
     NOT the emissive bump the design asked for: buildings.js shares ONE lit-window
     material town-wide (winCache), so raising it would light every window in the
     town, and town.js rewrites it from `night` every frame regardless. ── */
  const lifts = new Map();           // group → {e, k, base, wrote}
  const LIFT_TAU = .14, LIFT_K = .03;
  const liftable = e => !!e && e.kind !== 'monument' && e.kind !== 'scaffold'
    && !(e.popT < 1 || e.bumpT < 1 || e.rising);
  /** Put the scale back and let go. The one exit that leaves no trace behind. */
  function relax(g, L) {
    g.scale.setScalar(L.base);
    if (!g.matrixAutoUpdate) g.updateMatrix();
    lifts.delete(g);
  }
  function stepLifts(wdt) {
    for (const [g, L] of lifts) {
      // A building that started animating again (a promotion, a remount) belongs
      // to town.js for the duration: drop the lift rather than fight its writes
      // — town.js is writing the scale every frame, so it needs no restoring.
      if (!liftable(L.e)) { lifts.delete(g); continue; }
      // One that has gone to an impostor belongs to lod: the group is hidden and
      // nobody will ever write this scale again, so restore it before letting go
      // or it comes back 3 % oversized the next time it is drawn for real.
      if (!drawnFull(L.e)) { relax(g, L); continue; }
      const want = (g === hoverGroup || g === selGroup) ? 1 : 0;
      L.k += (want - L.k) * (1 - Math.exp(-wdt / LIFT_TAU));
      // town.js owns the base: if it wrote the scale since our last write, adopt
      // what it wrote rather than compound on top of it.
      if (Math.abs(g.scale.x - L.wrote) > 1e-4) L.base = g.userData.baseScale || g.scale.x;
      if (want === 0 && L.k < .008) {
        g.scale.setScalar(L.base); if (!g.matrixAutoUpdate) g.updateMatrix();
        lifts.delete(g); continue;
      }
      const s = L.base * (1 + LIFT_K * L.k);
      g.scale.setScalar(s); L.wrote = s;
      if (!g.matrixAutoUpdate) g.updateMatrix();
    }
  }
  /** Idempotent, and cheap enough to re-assert every frame: that is how a lift
   *  comes back by itself when a building returns from an impostor to a group. */
  function armLift(g, ent) {
    if (!g || lifts.has(g) || !liftable(ent) || !drawnFull(ent)) return;
    lifts.set(g, { e: ent, k: 0, base: g.userData.baseScale || g.scale.x, wrote: -1 });
  }
  function dropLifts() { for (const [g, L] of lifts) relax(g, L); lifts.clear(); }

  /* ═══ the lod handshake (§8.1) ══════════════════════════════════
     Every question about a settled house goes through lod, because lod is the
     only thing that still knows where it is: which ordinal a ray hit, which
     entity that ordinal is, where its box stands, and whether it is being drawn
     as a real group. All four are probed, and with no lod they answer -1, null,
     null and "yes, it is real" — which is the pre-stage-E behaviour exactly. */
  /** A house entity's ordinal in lod's index space (town.js's `houses`), or -1. */
  const ordOf = e => !e || e.kind !== 'house' ? -1
    : (e.idx >= 0 ? e.idx : (e.n > 0 ? e.n - 1 : -1));
  function entAt(ord) {
    if (!(ord >= 0)) return null;
    if (can(lod, 'entAt')) { const e = lod.entAt(ord); if (e) return e; }
    return (houses && houses[ord]) || null;
  }
  // lod's box is exact in every tier and needs no matrixWorld — the right anchor
  // for a ring under a house whose group is hidden, or whose root is detached.
  const _box = {};
  const lodBox = ent => can(lod, 'boxAt') ? lod.boxAt(ordOf(ent), _box) : null;
  /** Drawn as its own group (so a 3 % lift is visible), rather than as an instance. */
  function drawnFull(ent) {
    if (!can(lod, 'tierOf')) return true;
    const o = ordOf(ent);
    return o < 0 || lod.tierOf(o) <= 0;      // -1 unregistered · 0 FULL · 1|2 impostor
  }

  /* ═══ deeds ═════════════════════════════════════════════════════ */
  /**
   * The group a hit object belongs to, resolved by OWNERSHIP rather than by depth
   * in the scene: town.js's `tagEnt` writes the entity onto every node of the
   * subtree it mounts, so the group is the OUTERMOST ancestor still carrying that
   * same entity, and the containers above it carry none. Both simpler rules are
   * wrong — stopping at the first tagged node returns the hit mesh, and walking
   * to the child of the scene returns lod's `hotRoot`/`coldRoot`, which would
   * scale the entire town by 1.03 and anchor every deed at the origin (§8.1).
   */
  function groupOf(o, ent) {
    if (!o) return null;
    const want = ent || (o.userData && o.userData.ent) || null;
    let top = null;
    for (let n = o; n && n !== scene; n = n.parent) {
      const e = n.userData && n.userData.ent;
      if (e && (!want || e === want)) top = n;
      else if (top) break;               // we have left the entity: this is a container
    }
    return top || o;                     // untagged subtree: the hit, never a root
  }
  /**
   * Normalise whatever describe() gave us into a Deed, and guarantee an anchor.
   * town.js's pre-v4 `tipFor` returns three strings; that shape still works, so
   * this file is useful the day it lands and richer the day describeEnt lands.
   */
  function asDeed(x, ent, group) {
    let d;
    if (Array.isArray(x)) d = { title: x[0] || '', sub: x[1] || '', rows: [], flavor: x[2] || '' };
    else if (x && typeof x === 'object') d = x;
    else d = { title: (ent && (ent.label || ent.kind)) || 'this plot', sub: '', rows: [] };
    if (!d.at) {
      const a = { x: 0, y: 0, z: 0, hTop: 3.5 }, b = lodBox(ent);
      // lod's box first: a house drawn as an impostor has a hidden group, and in
      // mode A its root is detached, so its matrixWorld is nobody's business.
      if (b) { a.x = b.x; a.y = b.y; a.z = b.z; a.hTop = b.h; }
      else if (group) { group.getWorldPosition(_v); a.x = _v.x; a.y = _v.y; a.z = _v.z; a.hTop = group.userData.hTop || 3.5; }
      // A pose whose `alive` is false is (0,0,0) — the altar — not a location.
      // Leaving the anchor at the default is honest; flying to the monument is not.
      else if (ent && ent.pose && ent.pose.alive !== false) { a.x = ent.pose.x; a.y = 0; a.z = ent.pose.z; a.hTop = 1.4; }
      d.at = a;
    }
    return d;
  }
  function deedFor(ent, group) {
    // town.js gets first refusal on EVERY kind now, villagers included: it is the
    // only module that knows which building a villager lives in. villagerDeed
    // stays as the fallback for a host with no describe(), which is what makes
    // this file useful on its own.
    const d = describe ? describe(ent) : null;
    if (d) return asDeed(d, ent, group);
    if (ent && ent.kind === 'villager') return villagerDeed(ent);
    return asDeed(null, ent, group);
  }
  /** A villager card town.js has no opinion about yet: name and trade are all the truth we have. */
  function villagerDeed(ent) {
    const v = ent.view || (villager ? villager(ent.handle) : null) || null;
    const name = (v && (v.name || v.fullName)) || 'One of the villagers';
    const trade = (v && (v.trade || v.job)) || '';
    const d = { title: name, sub: trade || 'out on the road', rows: [], acts: ['follow'] };
    if (v && v.home) d.rows.push(['home', String(v.home)]);
    if (v && v.quarter) d.rows.push(['quarter', String(v.quarter)]);
    return asDeed(d, ent, null);
  }

  /* row pool: a card that rebuilds its <dt>/<dd> pairs on every 1 Hz live tick
     churns the DOM for nothing, so the nodes are minted once and reused. */
  const rowPool = [];
  function renderRows(rows) {
    if (!dRows) return;
    const list = Array.isArray(rows) ? rows.slice(0, 5) : [];
    while (rowPool.length < list.length) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dRows.appendChild(dt); dRows.appendChild(dd); rowPool.push([dt, dd]);
    }
    for (let i = 0; i < rowPool.length; i++) {
      const [dt, dd] = rowPool[i], r = list[i];
      const on = !!r;
      dt.hidden = !on; dd.hidden = !on;
      if (on) { dt.textContent = String(r[0] ?? ''); dd.textContent = String(r[1] ?? ''); }
    }
  }
  function actAvailable(id) {
    if (id === 'focus') return can(rig, 'focus');
    if (id === 'follow') return can(rig, 'follow') && (can(npcs, 'nearest') || (sel && sel.kind === 'villager'));
    if (id === 'walk') return can(rig, 'walkTo');
    if (id === 'tour') return can(rig, 'tour');
    return false;
  }
  /** camera.js's focus opts for a deed anchor — `dist` only when it asked. */
  // A deed anchor may carry BOTH a distance and an absolute bearing; pass through
  // only what it actually asked for, so the rig's own defaults still apply.
  const focusOpts = at => {
    if (!at) return null;
    let o = null;
    if (at.dist > 0) (o = o || {}).dist = at.dist;
    if (isFinite(at.az)) (o = o || {}).az = at.az;
    if (isFinite(at.pol)) (o = o || {}).pol = at.pol;
    return o;
  };
  function runAct(id, d) {
    if (id === 'focus') rig.focus(d.at, focusOpts(d.at));
    else if (id === 'tour') rig.tour(true);
    else if (id === 'walk') rig.walkTo(d.at.x, d.at.z);
    else if (id === 'follow') {
      const h = sel && sel.kind === 'villager' ? sel.handle
        : (can(npcs, 'nearest') ? npcs.nearest(d.at, 26) : null);
      if (h == null || rig.follow(h) === false) toast('Nobody is about just here.');
    }
  }
  function renderActs(d) {
    dActs.textContent = '';
    const ids = Array.isArray(d.acts) ? d.acts : [];
    for (const id of ids) {
      // A button that cannot do its job is worse than no button: only offer the
      // verbs the rig actually has this wave.
      if (!ACT_LABEL[id] || !actAvailable(id)) continue;
      const b = document.createElement('button');
      b.className = 'act'; b.type = 'button'; b.textContent = ACT_LABEL[id];
      b.addEventListener('click', () => runAct(id, selDeed || d));
      dActs.appendChild(b);
    }
  }
  function renderDeed(d, animate) {
    if (!deedEl) return;
    dName.textContent = d.title || '';
    dBadge.textContent = d.badge || '';
    dSub.textContent = d.sub || '';
    renderRows(d.rows);
    dFlavor.textContent = d.flavor || '';
    renderActs(d);
    deedEl.hidden = false;
    if (animate) { deedEl.classList.remove('in'); void deedEl.offsetWidth; deedEl.classList.add('in'); }
    retireHint();
  }

  /* ═══ selection ═════════════════════════════════════════════════ */
  function select(ent, opts) {
    if (dead) return;
    if (!ent) { clearSelection(); return; }
    const o = opts || {};
    // THE CHROME ARBITER, BOTH WAYS. almanac's canShow already stops a card
    // opening over a deed; nothing closed a card that was ALREADY pinned when a
    // deed opened under it, so the two could still share the screen.
    { const a = alm(); if (a && a.visible) a.hide(); }
    sel = ent;
    selGroup = ent.kind === 'villager' ? null : (ent.group || o.group || null);
    selDeed = deedFor(ent, selGroup);
    liveAt = clock();
    armLift(selGroup, ent);
    renderDeed(selDeed, true);
    placeRing(selDeed.at);
    if (o.focus && can(rig, 'focus')) rig.focus(selDeed.at, focusOpts(selDeed.at));
  }
  function clearSelection() {
    sel = null; selGroup = null; selDeed = null;
    // The card leaves at once; the ring fades out under it over ~180 ms, which is
    // what ties the two together on the way out as well as the way in.
    if (deedEl) { deedEl.hidden = true; deedEl.classList.remove('in'); }
  }
  function placeRing(at) {
    if (!at) return;
    const r = Math.max(2.2, (at.hTop || 3.5) * .55);
    ring.position.set(at.x, (at.y || 0) + .06, at.z);
    ring.scale.set(r, 1, r);
    halo.position.set(at.x, (at.y || 0) + .05, at.z);
    halo.scale.set(r, 1, r);
    ring.visible = true; halo.visible = true;
  }
  function stepRing(now, wdt) {
    const want = sel ? 1 : 0;
    ringK += (want - ringK) * (1 - Math.exp(-wdt / .18));
    if (want && ringK > .995) ringK = 1;
    if (!want && ringK < .004) {
      ringK = 0; ring.visible = halo.visible = false; ringMat.opacity = haloMat.opacity = 0; return;
    }
    // breathing on the WALL CLOCK: a 9 s headless capture must always land on a
    // ring that is lit, whatever frame it happens to sample. The dark companion
    // breathes with it at a lower amplitude — it is the contrast, not the light.
    ringMat.opacity = ringK * (.74 + .16 * Math.sin(now / 620));
    haloMat.opacity = ringK * .48;
    ring.visible = halo.visible = true;
  }

  /* ═══ picking ═══════════════════════════════════════════════════ */
  function refreshRect(now) {
    if (!canvas) return null;
    if (!rect || now - rectAt > 500) { rect = canvas.getBoundingClientRect(); rectAt = now; }
    return rect;
  }
  function pickAt(now) {
    const r = refreshRect(now);
    if (!r || !r.width || !camera) return null;
    ndc.set((mousePx.x / r.width) * 2 - 1, -(mousePx.y / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let ent = null, group = null, dist = Infinity;
    if (hitTargets.length) {
      const hits = ray.intersectObjects(hitTargets, true);
      for (const h of hits) {
        if (!h.object.userData.ent) continue;
        ent = h.object.userData.ent; group = groupOf(h.object, ent); dist = h.distance; break;
      }
    }
    // Settled houses are lod's: they have left `hitTargets` and the raycaster
    // cannot reach them at all. `pick()` is an exact ray/OBB test that is right
    // in every tier, and `pickDist` is the same ray parameter the raycaster
    // reports, so all three picks are one nearest-wins contest. Read `pickDist`
    // immediately: it belongs to the pick that just ran.
    if (can(lod, 'pick')) {
      const ord = lod.pick(ray);
      if (ord >= 0 && lod.pickDist < dist) {
        const e = entAt(ord);
        if (e) { ent = e; group = e.group || null; dist = lod.pickDist; }
      }
    }
    // The crowd is picked closed-form by npcs (160 ray/sphere tests, no matrix
    // inverse); nearer wins, so a villager in a doorway beats the house behind.
    if (can(npcs, 'raycast')) {
      const n = npcs.raycast(ray);
      if (n && n.dist < dist) {
        const view = can(npcs, 'personAt') ? npcs.personAt(n.handle) : null;
        const pose = can(npcs, 'track') ? npcs.track(n.handle) : null;
        ent = { kind: 'villager', handle: n.handle, seed: n.handle, view, pose };
        group = null;
      }
    }
    return ent ? { ent, group } : null;
  }
  /** Look-only states. The founding ritual is one of them: until ctx.intro
   *  reaches 1 the plat is a ceremony, not a place you poke at (a feed that never
   *  sends intro counts as settled, never as permanently inert). */
  function suppressed() {
    return !SHOT_UI || sheetOpen || mode === 'photo' || mode === 'tour'
      || document.body.classList.contains('photo')
      || !!(lastCtx && typeof lastCtx.intro === 'number' && lastCtx.intro < 1);
  }
  /** The tooltip yields its slot to a toast or the sheet — the chrome budget is
   *  kept structurally, and hover picking (cursor, lift) carries on underneath. */
  const tipBlocked = () => sheetOpen || !!(toastEl && !toastEl.hidden);
  function showTip(d) {
    if (!tipEl) return;
    if (tipBlocked()) { hideTip(); return; }
    const r = rect;
    tipEl.style.display = 'block';
    tipEl.children[0].textContent = (d.title || '') + (d.badge ? '  ' + d.badge : '');
    tipEl.children[1].textContent = d.sub || '';
    tipEl.children[2].textContent = d.flavor || (d.rows && d.rows[0] ? d.rows[0][0] + ' ' + d.rows[0][1] : '');
    if (tipL4) tipL4.textContent = tipHints < 3 ? TIP_HINT : '';
    // clamp inside the stage: a card that runs off the bottom right is unreadable
    const w = tipEl.offsetWidth || 180, h = tipEl.offsetHeight || 48;
    const maxX = (r ? r.width : 9999) - w - 6, maxY = (r ? r.height : 9999) - h - 6;
    tipEl.style.left = Math.max(4, Math.min(mousePx.x + 16, maxX)) + 'px';
    tipEl.style.top = Math.max(4, Math.min(mousePx.y + 2, maxY)) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  function setHover(hit) {
    const ent = hit ? hit.ent : null;
    if (ent === hover) {
      // Same thing, possibly a new group under it (a promotion remounts it) or a
      // tier it can be lifted in again — both are re-asserted, neither re-reads
      // the deed, which is the whole point of holding the hover by entity.
      if (ent) { if (hit.group) hoverGroup = hit.group; armLift(hoverGroup, ent); showTip(hoverDeed || asDeed(null, ent, null)); }
      return;
    }
    if (ent && hover && ent.kind === 'villager' && hover.kind === 'villager'
      && ent.handle === hover.handle) return;
    hover = ent; hoverGroup = hit ? hit.group : null;
    if (canvas) canvas.classList.toggle('pick', !!ent);
    if (!ent) { hoverDeed = null; hideTip(); return; }
    armLift(hoverGroup, ent);
    hoverDeed = deedFor(ent, hoverGroup);
    if (tipHints < 3) tipHints++;
    showTip(hoverDeed);
  }

  /* ═══ chrome ════════════════════════════════════════════════════
     The budget (§5 risk 5) is at most two of ours on screen at once. It is kept
     structurally, not by hope: the sheet is modal, a toast retires the hint strip
     and hides the pill, and the tooltip stands down for either of them. */
  function toast(msg, ms) {
    if (!toastEl || !msg) return;
    toastEl.innerHTML = String(msg);
    toastEl.hidden = false;
    toastUntil = clock() + (ms || 2600);
    retireHint();
    hideTip();
  }
  function retireHint() {
    if (hintDone) return;
    hintDone = true;
    if (keysEl) keysEl.hidden = true;
  }
  function stepChrome(now) {
    if (!stage) return;
    if (toastEl && !toastEl.hidden && now > toastUntil) toastEl.hidden = true;
    const toasting = toastEl && !toastEl.hidden;
    if (pillEl) {
      const want = !toasting && !sheetOpen && mode !== 'orbit' && MODE_LINE[mode] !== undefined;
      if (want) {
        const txt = pillText();
        if (txt !== pillEl.dataset.txt) { pillEl.dataset.txt = txt; pillEl.innerHTML = txt; }
        pillEl.hidden = false;
      } else pillEl.hidden = true;
    }
    if (keysEl && !hintDone) {
      // 6 s after the first tokens land, gone by 20 s, and only for a user's first
      // three launches — a returning user should not be taught the same thing forever.
      if (!hintFrom && firstDataAt && now - firstDataAt > 6000 && !sheetOpen && !toasting) {
        if (hintsLeft() > 0) { keysEl.hidden = false; hintFrom = now; bumpHints(); }
        else hintDone = true;
      } else if (hintFrom && now - hintFrom > 14000) retireHint();
    }
    if (sheetOpen) { hideTip(); if (keysEl) keysEl.hidden = true; }
  }
  function pillText() {
    const base = (rig && typeof rig.caption === 'string' && rig.caption) || MODE_LINE[mode] || '';
    let who = '';
    if (mode === 'focus' && selDeed) who = ' · ' + esc(selDeed.title);
    // …and if nothing was SELECTED, ask the roster who the rig is following.
    // Neither path that starts a follow selects anybody — F resolves a handle and
    // hands it straight to rig.follow(), and town.js's --cam=follow hook calls
    // rig.follow(npcs.nearest(…)) — so the verb the hint strip advertises gave a
    // bare 'Following along' with no name, while the tour pill always names its
    // subject. The rig has always known the handle; it just was not asked.
    if (mode === 'follow') {
      if (sel && sel.kind === 'villager' && selDeed) who = ' · ' + esc(selDeed.title);
      else {
        const h = rig && rig.followHandle;
        const p = (h != null && can(npcs, 'personAt')) ? npcs.personAt(h) : null;
        const nm = p && (p.name || p.fullName);
        if (nm) who = ' · ' + esc(nm);
      }
    }
    return base + who + ' <kbd>Esc</kbd>';
  }
  function hintsLeft() {
    try { return 3 - (parseInt(localStorage.getItem('tt.hints') || '0', 10) || 0); } catch { return 3; }
  }
  function bumpHints() {
    try { localStorage.setItem('tt.hints', String((parseInt(localStorage.getItem('tt.hints') || '0', 10) || 0) + 1)); } catch { /* private mode: the strip simply shows again */ }
  }

  /* ═══ the key sheet ═════════════════════════════════════════════
     Built from what this build can actually do, so it can never promise a verb
     the rig does not have this wave. */
  function sheetRows() {
    const r = [['drag · wheel', 'moves the town about · moves in and out'],
    ['right-drag', 'looks around from where you are'],
    ['click', 'opens the deed for whatever is under the cursor']];
    if (can(rig, 'focus')) r.push(['double-click', 'opens the deed and goes over to it']);
    r.push(['Esc', 'steps back one thing at a time']);
    if (can(rig, 'orbit')) r.push(['Space · Home', 'frames the whole town again']);
    if (can(rig, 'follow')) r.push(['F', 'follows the villager under the cursor']);
    if (can(rig, 'stroll')) r.push(['G', 'goes down to street level']);
    if (can(rig, 'tour')) r.push(['T', 'a slow tour of the town']);
    if (can(rig, 'photo')) r.push(['P', 'photo mode — chrome out of the way']);
    if (alm()) r.push(['A', "the almanac — the last fortnight's pages"]);
    if (ledgerOf) r.push(['H', 'the honours the town has been awarded']);
    if (canvas) r.push(['Ctrl+S', 'saves a picture of the town']);
    if (can(rig, 'jumpTo')) r.push(['1 – 5', 'saved viewpoints · Shift sets one']);
    r.push(['?', 'this sheet']);
    return r;
  }
  function openSheet() {
    if (!sheetEl || sheetOpen) return;
    let h = '<div class="card"><h2>The keys</h2><dl>';
    for (const [k, v] of sheetRows()) h += `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`;
    h += '</dl><div class="foot">any key closes this</div></div>';
    sheetEl.innerHTML = h;
    sheetEl.hidden = false; sheetOpen = true;
    retireHint(); hideTip();
  }
  /* ── the Honours ──────────────────────────────────────────────
     charter.ledger() has always returned exactly what a trophy case needs and had
     no caller, so an earned badge appeared ONCE as a ticker line and a toast and
     was then unreachable forever. For a feature whose whole job is to celebrate,
     having nowhere to go back and look was the largest remaining gap. Nothing new
     is computed here — this is a reader. */
  function openHonours() {
    if (!sheetEl || sheetOpen || !ledgerOf) return;
    const L = ledgerOf();
    if (!L) return;
    const T = L.totals || {};
    let h = '<div class="card honours"><h2>The Honours</h2>';
    h += `<div class="hCount">${L.count} of ${L.of} recorded</div>`;
    if (L.earned && L.earned.length) {
      h += '<ul class="hList">';
      for (const b of L.earned)
        h += `<li><span class="hIcon">${esc(b.icon || '✦')}</span>` +
          `<span class="hName">${esc(b.name)}</span>` +
          `<span class="hBlurb">${esc(b.blurb || '')}</span></li>`;
      h += '</ul>';
    } else {
      h += '<div class="hBlurb hEmpty">The register is open and the first page is blank.</div>';
    }
    if (L.secretLine) h += `<div class="foot">${esc(L.secretLine)}</div>`;
    h += `<div class="foot">${T.days || 0} days recorded · ${T.buildings || 0} buildings raised · ${T.milestones || 0} milestones</div>`;
    h += '<div class="foot">any key closes this</div></div>';
    sheetEl.innerHTML = h;
    sheetEl.hidden = false; sheetOpen = true;
    retireHint(); hideTip();
  }
  function closeSheet() { if (sheetEl) sheetEl.hidden = true; sheetOpen = false; }

  /* ═══ input ═════════════════════════════════════════════════════ */
  const onMove = e => {
    const r = refreshRect(clock());
    if (!r) return;
    mouseIn = true;
    mousePx.x = e.clientX - r.left; mousePx.y = e.clientY - r.top;
    if (downAt) dragPx = Math.max(dragPx, Math.hypot(e.clientX - downX, e.clientY - downY));
  };
  const onLeave = () => { mouseIn = false; setHover(null); };
  const onDown = e => {
    if (e.button !== 0) return;
    onMove(e);                       // a tap with no movement still needs a cursor
    downAt = nowMs(); downX = e.clientX; downY = e.clientY; dragPx = 0;
  };
  const onUp = e => {
    if (e.button !== 0) return;
    const t = nowMs() - downAt, moved = rig && typeof rig.dragPx === 'number' ? rig.dragPx : dragPx;
    const wasDown = downAt;
    downAt = 0;
    // A click is a tap that did not travel: the same test camera.js's drag uses,
    // so spinning the town never opens a card.
    if (!wasDown || t > 400 || moved >= 5) return;
    if (sheetOpen) { closeSheet(); return; }
    if (suppressed()) return;        // the tour, photo mode and --shot-ui=0 are look-only
    const hit = pickAt(clock());
    if (hit) select(hit.ent, { group: hit.group });
    else clearSelection();
  };
  const onDbl = e => {
    if (sheetOpen || suppressed()) return;
    const hit = pickAt(clock());
    // THE HANDSHAKE camera.js's wiring contract asks for. The rig is constructed
    // before us, so ITS dblclick handler runs first on every double-click and does
    // `userDist = false; panX = panZ = 0; orbit()`. Our focus then wins and the
    // frame looks right — but the wheel zoom and the pan the user had set are
    // already gone, and Esc afterwards returned them to an auto-framed town
    // instead of the view they were in. preventDefault is what tells the rig the
    // event was consumed. The empty-ground case is deliberately NOT handled here:
    // camera.js owns it, which is the whole point of the handshake.
    if (hit) { stop(e); select(hit.ent, { group: hit.group, focus: true }); }
  };
  // a synthetic event (a test hook, a dispatched key) may carry no preventDefault
  const stop = e => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); };
  const onCtx = stop;

  const onKey = e => {
    if (dead) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      if ((k === 's' || k === 'S') && canvas) { stop(e); requestPicture(); }
      return;
    }
    if (e.altKey) return;
    if (sheetOpen) { closeSheet(); stop(e); return; }
    switch (k) {
      case 'Escape':
        if (alm() && alm().pinned) alm().hide();
        else if (sel) clearSelection();
        else if (mode !== 'orbit' && can(rig, 'orbit')) rig.orbit();
        break;
      case ' ': case 'Spacebar': case 'Home':
        if (can(rig, 'orbit')) { rig.orbit(); stop(e); }
        break;
      case '?': case 'F1':
        openSheet(); stop(e); break;
      case 'a': case 'A':
        // The almanac's own wiring note asks for this and nothing bound it, so the
        // parchment card — the warmest thing in the feature — was reachable only
        // by hovering the header strip or by waiting for a day to roll over.
        {
          const a = alm();
          if (a) { stop(e); if (a.pinned) a.hide(); else a.showCard(null, { pin: true }); }
        }
        break;
      case 'h': case 'H':
        if (ledgerOf) { stop(e); openHonours(); }
        break;
      case 'f': case 'F': followUnderCursor(); break;
      case 'g': case 'G':
        if (can(rig, 'stroll')) rig.stroll(mode === 'stroll' ? undefined : groundUnderCursor());
        break;
      case 't': case 'T':
        if (can(rig, 'tour')) rig.tour(mode !== 'tour'); break;
      case 'p': case 'P':
        if (can(rig, 'photo')) rig.photo(mode !== 'photo'); break;
      case '1': case '2': case '3': case '4': case '5': {
        const i = +k;
        if (e.shiftKey && can(rig, 'bookmark')) { rig.bookmark(i); toast('This view is saved on ' + i + '.'); }
        else if (can(rig, 'jumpTo') && rig.jumpTo(i) === false) toast('Nothing saved on ' + i + ' yet.');
        break;
      }
      default: return;
    }
  };
  function groundUnderCursor() {
    if (!mouseIn || !can(rig, 'screenToGround')) return undefined;
    return rig.screenToGround(mousePx.x, mousePx.y, _v) ? { x: _v.x, z: _v.z } : undefined;
  }
  function followUnderCursor() {
    if (!can(rig, 'follow')) return;
    let h = null;
    if (mouseIn) { const hit = pickAt(clock()); if (hit && hit.ent.kind === 'villager') h = hit.ent.handle; }
    if (h == null && can(npcs, 'nearest')) {
      const at = selDeed ? selDeed.at : (rig && rig.focusPoint) || _p;
      h = npcs.nearest(at, 90);
    }
    if (h == null || rig.follow(h) === false) toast('Nobody is about just here.');
  }

  /* ═══ the picture ═══════════════════════════════════════════════
     preserveDrawingBuffer is false and must stay false (it costs a full-screen
     copy every frame at 1200 buildings). The buffer is readable if and only if it
     is read in the SAME TASK as the draw — hence afterRender(), called on the
     line after renderer.render(). If that render ever moves off tick(), this
     silently returns a black picture. */
  function requestPicture() {
    if (!canvas) return;
    grabWanted = true;
    grabName = `${slug(lastCtx && lastCtx.townName)}-${stamp()}.png`;
  }
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function afterRender() {
    if (!grabWanted || dead) return;
    grabWanted = false;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    if (!grabCtx) grabCtx = document.createElement('canvas').getContext('2d');
    const cv = grabCtx.canvas;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    grabCtx.drawImage(canvas, 0, 0);          // valid: same task as the render
    const url = cv.toDataURL('image/png');
    const name = grabName;
    if (saveShot) {
      Promise.resolve(saveShot(name, url))
        .then(p => toast('Saved · ' + esc(String(p || name)).split(/[\\/]/).pop(), 3200))
        .catch(() => toast('That picture could not be saved.', 3200));
    } else {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      toast('Saved · ' + esc(name), 3200);
    }
  }

  /* ═══ the --select test hook ════════════════════════════════════
     A headless run has no mouse, so this is the only way to screenshot the card.
     It retries on the wall clock because the subject may not be built yet, and it
     DOES move the camera — the one selection that may, since the point of the
     capture is to see the ring and the lift at a legible size. */
  /** `house:42` → that house exactly; `house` → the first one that exists yet. */
  function houseSel(arg) {
    const hit = e => e ? { ent: e, group: e.group || null } : null;
    if (arg) { const n = +arg, e = n > 0 ? entAt(n - 1) : null; return e && e.n === n ? hit(e) : null; }
    const hi = lod && typeof lod.maxOrd === 'number' ? lod.maxOrd : (houses ? houses.length - 1 : -1);
    for (let i = 0; i <= hi; i++) { const e = entAt(i); if (e) return hit(e); }
    return null;
  }
  function resolveSel(spec) {
    const [kindRaw, argRaw] = String(spec).split(':');
    const kind = kindRaw.toLowerCase(), arg = argRaw || '';
    if (kind === 'villager') {
      let h = null;
      // ROSTER MEMBERSHIP IS NOT PRESENCE. personAt() answers for anybody on the
      // roster, spawned or not, and track() returns {0,0,0,alive:false} for one who
      // is not — so `--select=villager:5` flew the camera to (0,0), which is the
      // altar, and then cleared the selection on the next frame with 'They have
      // gone in for the night.' at one in the afternoon. Fall through to whoever
      // IS about instead.
      const alive = n => { const t = can(npcs, 'track') ? npcs.track(n) : null; return !!t && t.alive !== false; };
      if (arg && can(npcs, 'personAt') && npcs.personAt(+arg) && alive(+arg)) h = +arg;
      if (h == null && can(npcs, 'nearest')) h = npcs.nearest(_p, 500);
      if (h == null) return null;
      const view = can(npcs, 'personAt') ? npcs.personAt(h) : null;
      return { ent: { kind: 'villager', handle: h, seed: h, view, pose: can(npcs, 'track') ? npcs.track(h) : null }, group: null };
    }
    const want = kind === 'altar' ? 'monument' : kind;
    // Houses first, through lod's registry: after stage E a settled one is not in
    // `hitTargets` at all, and this hook is how the deed screenshot gets taken.
    if (want === 'house') { const h = houseSel(arg); if (h) return h; }
    for (const g of hitTargets) {
      const e = g.userData && g.userData.ent;
      if (!e || e.kind !== want) continue;
      // YOU CANNOT SELECT WHAT IS NOT DRAWN. memorial.js registers the Chronicle
      // Stone, the horizon ghost and the bunting once at init and only makes them
      // visible when the chronicle arrives — and until then their groups sit at
      // the origin. Resolving one early opened a deed anchored on the altar and
      // captioned "the mason waits". The hook retries for 20 s; that is what the
      // retry is FOR. (Houses never reach here: houseSel answers first, and lod
      // owns their visibility.)
      if (g.visible === false) continue;
      if (want === 'house' && arg && e.n !== +arg) continue;
      if (want === 'landmark' && arg && e.lm !== arg && slug(e.label) !== slug(arg)) continue;
      return { ent: e, group: g };
    }
    return null;
  }
  function stepPending(now) {
    if (!pendingSel) return;
    if (!pendingSince) pendingSince = now;
    if (now - pendingAt < 400) return;
    pendingAt = now;
    const hit = resolveSel(pendingSel);
    if (hit) { pendingSel = null; select(hit.ent, { group: hit.group, focus: true }); }
    else if (now - pendingSince > 20000) pendingSel = null;   // it was never going to exist
  }

  /* ═══ the frame ═════════════════════════════════════════════════ */
  /** Does this mode change the LAYOUT of <body>'s flex column? Both classes take
   *  siblings of .stage out of flow, and only those two do. */
  const chromeMode = m => m === 'photo' || m === 'stroll';
  const nowMs = () => performance.now();
  /** The clock every deadline this module owns is measured against: the frame
   *  stamp town.js hands us, so a stepped or scripted run (`window.__tick`, a
   *  bench, a harness) cannot expire a toast the instant it is raised. Identical
   *  to performance.now() in the running app. */
  const clock = () => lastNow || nowMs();
  function update(now, ctx) {
    if (dead) return;
    now = typeof now === 'number' ? now : nowMs();
    const wdt = lastNow ? clamp((now - lastNow) / 1000, 0, .5) : .016;
    lastNow = now;
    if (ctx) {
      lastCtx = ctx;
      if (!firstDataAt && ctx.totalTok > 0) firstDataAt = now;
    }

    // mode changes are POLLED, so a tour or a photo the rig started on its own
    // (attract mode, a test hook) gets the same pill and the same toast.
    mode = (rig && rig.mode) || 'orbit';
    if (mode !== modeSeen) {
      // ONE SENTENCE, ONE PLACE. Both the toast (bottom-centre, 2.6 s) and the
      // pill (top-centre, for as long as the mode lasts) were saying the same
      // words, which read as an inconsistency and dragged the eye from the bottom
      // of the frame to the top for no new information. The pill carries the mode;
      // the toast is reserved for what the pill CANNOT say — photo mode's save
      // key, 'nobody is about just here', a bookmark write.
      const t = MODE_TOAST[mode];
      if (t && SHOT_UI && MODE_LINE[mode] === undefined) toast(t, 2600);
      else if (mode === 'photo' && SHOT_UI) toast(MODE_TOAST.photo, 3400);
      document.body.classList.toggle('photo', mode === 'photo');
      document.body.classList.toggle('stroll', mode === 'stroll');
      // …AND TELL THE APP THE CANVAS JUST CHANGED SIZE. Both classes take flex
      // children out of <body>'s column, so .stage — and with it #gl — grows by
      // the height of whatever left. Nothing in the app is watching for that:
      // town.js sizes the drawing buffer from `stage.clientHeight` and only ever
      // re-reads it on `window.resize`, which a class change does not fire. The
      // CSS box stretches, the buffer does not, and the picture is scaled — a
      // latent bug in photo mode since the day it learned to hide the footer.
      if (chromeMode(mode) !== chromeMode(modeSeen)) window.dispatchEvent(new Event('resize'));
      modeSeen = mode;
    }

    // a followed villager who has gone in for the night takes the card with them
    if (sel && sel.kind === 'villager') {
      const t = can(npcs, 'track') ? npcs.track(sel.handle) : null;
      // `track()` returns a real `y` now — a villager crossing a bridge stands
      // 1.05 above datum, and a ring pinned to y 0 was left in the river.
      if (t && t.alive !== false) { sel.pose = t; placeRing({ x: t.x, y: t.y || 0, z: t.z, hTop: 1.4 }); }
      else { clearSelection(); toast('They have gone in for the night.'); }
    }
    // …and a selected BUILDING must survive everything that can happen to its
    // group underneath it: a promotion mints a new one, an impostor hides the old
    // one. Re-adopt rather than let the card outlive the thing it describes.
    if (sel && sel.kind !== 'villager') {
      if (sel.group && sel.group !== selGroup) {
        selGroup = sel.group;
        selDeed = deedFor(sel, selGroup);
        renderDeed(selDeed, false);
        placeRing(selDeed.at);
      }
      armLift(selGroup, sel);          // idempotent: comes back when the tier does
    }

    if (mouseIn && !suppressed() && !(rig && rig.dragging) && now - hoverAt > 50) {
      hoverAt = now;
      setHover(pickAt(now));
    } else if (suppressed() && hover) setHover(null);

    stepLifts(wdt);
    stepRing(now, wdt);

    // the monument's card counts up while you read it; everything else is static
    if (sel && selDeed && selDeed.live && deedEl && now - liveAt > 1000) {
      liveAt = now;
      const d = deedFor(sel, selGroup);
      // The ring follows the anchor. The altar's plaza breathes as it climbs and
      // the Chronicle Stone stands on that rim, so a ring placed once drifts off
      // its own subject over the course of an afternoon.
      const a = d.at, b = selDeed && selDeed.at;
      if (a && (!b || Math.abs(a.x - b.x) > .5 || Math.abs(a.z - b.z) > .5)) placeRing(a);
      selDeed = d; renderRows(d.rows);
      dName.textContent = d.title || ''; dSub.textContent = d.sub || '';
      // The badge too. It is a LIVE value on the one card that carries it — the
      // altar's badge is the same Prosperity numeral the footer prints, and
      // leaving it out of this repaint froze it at the cold-open's "Prosperity I"
      // while the footer two hundred pixels below said IV.
      dBadge.textContent = d.badge || '';
    }

    stepPending(now);
    // …and the beat's own one-shot, on the same wall clock and the same "wait for
    // the plat to be a place" test the --cam dispatch uses.
    if (pendingBeat && firstDataAt && now - firstDataAt > pendingBeat && can(rig, 'beat')) {
      pendingBeat = 0; rig.beat('rainbow');
    }
    stepChrome(now);
  }

  /* ═══ lifecycle ═════════════════════════════════════════════════ */
  if (canvas) {
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('contextmenu', onCtx);
  }
  window.addEventListener('keydown', onKey);

  /** Epoch switch: the town under the cursor is about to be demolished. */
  function reset() {
    clearSelection();
    setHover(null);
    dropLifts();
    ringK = 0; ring.visible = halo.visible = false; ringMat.opacity = haloMat.opacity = 0;
    if (deedEl) { deedEl.hidden = true; deedEl.classList.remove('in'); }
    hideTip();
    pendingSince = 0;
  }
  function dispose() {
    if (dead) return;
    dead = true;
    reset();
    if (canvas) {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.classList.remove('pick');
    }
    window.removeEventListener('keydown', onKey);
    if (scene) { scene.remove(ring); scene.remove(halo); }
    ringGeo.dispose(); ringMat.dispose(); haloGeo.dispose(); haloMat.dispose();
    for (const el of minted) el.remove();
    if (tipAdopted && tipL4) { tipL4.remove(); hideTip(); }
    rowPool.length = 0;
    if (grabCtx) { grabCtx.canvas.width = grabCtx.canvas.height = 1; grabCtx = null; }
    document.body.classList.remove('photo', 'noui', 'stroll');
  }

  return {
    update, afterRender, select, clearSelection, toast, reset, dispose,
    /** The trophy case. Bound to H, and to --ledger for a verification shot. */
    honours: openHonours,
    /** the live deed, for the tour's captions and the bench */
    get selected() { return selDeed; },
    get hovering() { return hover; }
  };
}
