# Token Town v3 — `news.js`: the Town Crier, speech bubbles, and the town's name

Owner: **news**. New file `town/src/renderer/news.js` (the fifth module — v3 lifts the
"exactly four files" rule from REDESIGN.md §0 for this one addition).

`news.js` imports **only** `./vendor/three.module.js`. It never imports `town.js`,
`npcs.js`, `monument.js` or `buildings.js`. `town.js` is the sole mediator, exactly as in
v2: it `post()`s typed events and it is the only thing that calls `news.say()`.

Three things ship here:

1. **THE CRIER** — a one-line news bar under the header that cycles every ~7 s.
2. **BUBBLES** — up to 4 pooled comic bubbles above villagers.
3. **THE NAME** — a seeded per-day town name that the whole app can quote.

---

## 0. Non-negotiables inherited from the project

* **Wall clock, always.** Rotation, bubble spawn, bubble expiry — all `performance.now()`.
  A 7 s headless shot at ~1 fps must show a headline and at least one bubble. The corpus
  never depends on `dt`.
* **Base CSS is the FINAL state; animations only travel toward it.** Compositor-driven CSS
  animations are throttled in a hidden window, so `#news .line{opacity:1}` with a
  `@keyframes swap` that *starts* at `opacity:.0` guarantees a screenshot never catches a
  blank bar. Same rule for bubbles. This is the single most important implementation note
  in this document.
* **No models, ever.** v3 drops family attribution; no line may say Fable/Opus/Sonnet/Haiku
  or any real product name. The town's economy runs on "tokens", "spend", "the Ledger".
* Zero per-frame allocation: pooled divs, a scratch `Vector3`, `textContent` writes only on
  a swap.
* No new deps. Plain-browser demo mode must produce news (it will — the crier is driven by
  the same events demo mode already generates).

---

## 1. PLACEMENT — where the news lives

```
┌───────────────────────────────────────────────────────────────────────┐
│ ● Token Town   Tokenholm-upon-Spend            ☀ 06:12 · 14:37        │  header
├───────────────────────────────────────────────────────────────────────┤
│ 📰 THE TOKENHOLM CRIER │ Token futures up 12%. Nobody knows what a …   │  #news  ← NEW
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│                        [ the 3D stage ]         (o o) ← bubbles       │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│ 842.7M tokens today   🏠 271 buildings   🧍 78 villagers   …           │  footer
└───────────────────────────────────────────────────────────────────────┘
```

**A real flex row between `<header>` and `.stage`, not an overlay.** Reasons, in order:

* It **cannot** cover the 3D focus — the brief's hard requirement — at any window size or
  camera framing. An overlaid corner band always eventually sits on a rooftop.
* Header/footer are already flex-none rows; a 30 px third row costs the stage 3 % of its
  height and nothing else. `refreshFraming()` reads `stage.clientHeight`, so framing
  self-corrects with zero code change.
* It is outside `#stage`, so it can never intercept a raycast, a drag, or a wheel zoom.
* Cookie Clicker's news band is exactly this: a strip under the title, full width, one
  line. The reference the user gave *is* this layout.

`index.html` (core-owned, one insertion):

```html
<div id="news">
  <span class="mast" id="newsMast">📰 THE CRIER</span>
  <span class="line" id="newsLine">…</span>
</div>
```

```css
#news{flex:none; display:flex; align-items:center; gap:10px; padding:6px 16px;
  border-bottom:1px solid var(--hairline); background:rgba(255,255,255,.022);
  font-size:12.5px; color:var(--ink2); overflow:hidden; white-space:nowrap}
#news .mast{flex:none; font-size:10.5px; font-weight:700; letter-spacing:.09em;
  color:#D9A441; text-transform:uppercase;
  border-right:1px solid var(--hairline); padding-right:10px}
/* base = final state: a throttled compositor must never catch this mid-fade */
#news .line{flex:1 1 auto; min-width:0; opacity:1; transform:none;
  overflow:hidden; text-overflow:ellipsis}
#news .line.swap{animation:newsSwap .42s ease-out}
@keyframes newsSwap{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none}}
#news .line b{color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums}
#news .line i{color:var(--muted); font-style:normal}   /* bylines, dry asides */
#news.hot .mast{color:#F3D07A; text-shadow:0 0 14px rgba(243,208,122,.5)}
```

The swap is: set `textContent`, remove `.swap`, force reflow (`void el.offsetWidth`), add
`.swap`. `.hot` is toggled for 4 s on urgent items (milestone / landmark / day start) —
the masthead glows gold, nothing moves, nothing shouts.

`#newsMast` text is `📰 THE ${TOWNNAME.toUpperCase()} CRIER`, truncated to
`📰 THE CRIER` under 620 px of window width (measured once per `resize()`).

The header's `.legend` element is **empty in v3** (family attribution is gone), so the
town name takes that slot: `<h1>Token Town</h1><span class="place" id="place">Tokenholm</span>`.

---

## 2. THE TOWN NAME

```js
/**
 * Deterministic, stable for a whole town-day, new at every epoch reset.
 * @param {number} seed  town.js passes dayKey(sessionStart) (plus the range key hash,
 *                       so switching to "last 30 days" renames the town too)
 * @returns {string} e.g. 'Tokenholm', 'Little Cachewick', 'Ledgerford upon Spend'
 */
export function townNameFor(seed);
```

```js
const HEAD = ['Token','Cache','Ledger','Prompt','Spend','Tally','Byte','Coin','Burn',
  'Quill','Chit','Vellum','Tithe','Draft','Mint','Scrip','Debit','Ember','Gild','Wick',
  'Sum','Cost','Score','Marrow'];
const TAIL = ['holm','wick','ford','mere','bury','stead','gate','thorpe','hollow','march',
  'combe','worth','minster','dale','haven','cote','ridge','fell','shire','by'];
const HON  = ['Little','Great','Nether','Upper','Old','New','Saint','Fort','Port','Lower'];
const UPON = ['Spend','Tally','Cache','the Burn','the Ledger','Draft','the Overrun','Sum'];
// 62 % 'Tokenholm' · 18 % 'Little Cachewick' · 14 % 'Ledgerford upon Spend' · 6 % 'Mint-on-Tally'
```

Reuses `seededR`-style hashing (copy the 3-line helper; no import from town.js).

**Where the name appears** — the point is that the user's town has an identity they can
grow fond of, and it should show up just often enough to feel like a place:

| surface | form | owner |
|---|---|---|
| header, beside the title | `Tokenholm-upon-Spend` | core (one span) |
| crier masthead | `📰 THE TOKENHOLM CRIER` | news |
| the corpus itself | `{town}` slot, ~1 line in 5 | news |
| cascade floater | `✦ Tokenholm — township of 426` | core (string change) |
| monument tooltip line 1 | `The Great Ledger of Tokenholm` | core (string change) |
| bubbles | rare — `Best road in {town}.` | news |
| window title | `document.title = 'Token Town — ' + name` | core (one line) |

---

## 3. THE EVENT BUS — exact API

```js
/**
 * @param {NewsOpts} opts
 * @returns {News}
 */
export function initNews(opts);

/**
 * @typedef {Object} NewsOpts
 * @property {HTMLElement} bar        #news
 * @property {HTMLElement} mast       #newsMast
 * @property {HTMLElement} line       #newsLine
 * @property {HTMLElement} overlay    #overlay — the 4 pooled bubble divs are appended here
 * @property {HTMLCanvasElement} canvas  projection rect source
 * @property {number} seed            dayKey ⊕ range hash → town name + line shuffle
 * @property {boolean} [demo]         demo mode adds one self-aware line to the pool
 */

/**
 * @typedef {Object} News
 * @property {string} townName        read-only, regenerated by reset()
 * @property {NewsFacts} facts        MUTABLE — mutate in place, never reassign
 * @property {(type:string, data?:object)=>void} post
 * @property {(v:THREE.Vector3, kind:string, opts?:{text?:string, ttl?:number})=>boolean} say
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 * @property {(seed:number)=>void} reset     epoch reset: new name, flush queue+bubbles
 * @property {()=>void} dispose
 */
```

### 3.1 `news.facts` — the template slot source

One object, allocated once, **mutated in place** by `town.js` inside the existing 500 ms
stats timer (exactly the `ctx` pattern). Never read more than once per swap, so it is free.

```js
news.facts = {
  tok: 0,            // T
  tokStr: '0',       // fmtTok(T) — core already computes it
  buildings: 0,
  villagers: 0,
  breaks: 0,
  grandest: 'Tent',  // TIER_NAMES[grandest tier]
  landmark: '',      // label of the newest landmark, '' before the first
  rangeLabel: 'today',        // 'today' | 'this session' | 'the last 8 hours' | …
  perMin: 0,         // tokens/min over the last ~10 min
  paceRatio: 1,      // perMin ÷ today's median perMin, for the economy lines
  tier: 0,           // monument tier 0..9
  night: 0,          // ctx.night, so ambient picks night copy after dark
  cascading: false   // true during the 1.4 s launch cascade
};
```

### 3.2 `post(type, data)` — the complete event table

`post` never throws on an unknown type (it ignores it) and never allocates when the queue
is full. `data` fields feed template slots of the same name.

| type | posted by (town.js) | data | priority |
|---|---|---|---|
| `boot` | end of the launch cascade | `{buildings}` | urgent |
| `dayStart` | `applyInit` after `hardReset` | `{name}` | urgent |
| `rangeChanged` | new `init` with a different range key | `{label, wider:boolean}` | urgent |
| `milestone` | `fireMilestone` | `{title, tok, id}` | urgent |
| `landmark` | `placeLandmark(animate)` | `{label, kind, order}` | urgent |
| `best` | the "beat yesterday" rung fires | `{tok}` | urgent |
| `tierUp` | `monument.setTier` with animate | `{tier}` | normal |
| `buildingsAdded` | `drainSpawnQueue`, once per drained batch | `{n, total, label, tier, flavor}` | normal |
| `promotion` | `drainPromotionQueue`, once per wave ≥ 4 | `{n}` | normal |
| `grove` | `updateGroves` plants a new grove | `{count}` | normal |
| `pace` | 500 ms timer, only when the band changes | `{perMin, trend, ratio}` | normal |
| `idle` | 10 min with no growth, then every 15 min | `{minutes}` | normal |
| `nightfall` / `daybreak` | `ctx.night` crosses .5 | `{}` | normal |

**Priorities.**
* `urgent` — clears the pending queue, displays **immediately**, resets the dwell timer,
  sets `.hot` for 4 s. Two urgents within 900 ms: the second waits 900 ms (matches the
  milestone-queue cadence so the crier and the fireworks stay in step).
* `normal` — appended to a queue capped at **4**; overflow drops the *oldest*, because
  stale news is worse than missed news.
* `ambient` — never posted. When the queue is empty and the dwell expires, the crier picks
  an ambient category itself, weighted by `facts`: night > .55 → 30 % `NIGHT`; idle
  > 10 min → 40 % `SLOW`; `paceRatio` > 1.6 → 35 % `BOOM`; < .5 → 25 % `BUST`; monument
  tier ≥ 6 → 20 % `CULT`; otherwise `ECON`/`CIVIC`/`CULT`/`GOSSIP` evenly.

**Cascade guard.** While `facts.cascading` is true, `buildingsAdded`, `tierUp`, `promotion`
and `landmark` are swallowed; the single `boot` post at the end tells the whole story.

### 3.3 Rotation timing

```js
const dwell = txt => clamp(2600 + txt.length * 62, 6200, 9000);   // ~7 s typical
```

`update()` compares `now` against `nextAt`. On boot, `initNews` writes a line
**synchronously** (a `dayStart` pick) so frame 1 already has copy — a 3-second shot works.

### 3.4 Anti-repeat

A 26-slot ring buffer of shown line indices, plus a per-category shuffled cursor (Fisher-
Yates on the seed, advance the cursor, reshuffle at the end). Two identical headlines can
never appear within 26 swaps ≈ 3 minutes, and a category never repeats a line until it has
exhausted itself.

### 3.5 Template slots

`{town} {tok} {b} {n} {villagers} {breaks} {grandest} {landmark} {range} {pace} {tier}
{name} {pct}` — `{name}` is a random townsfolk from `FOLK`, `{pct}` a plausible-nonsense
percentage `(3–97)`, `{pace}` `Math.round(facts.perMin)`. Resolution is one
`String.replace(/\{(\w+)\}/g, …)` at swap time, ~200 ns.

`**bold**` in a corpus line becomes `<b>`, `_italic_` becomes `<i>` (bylines and asides).
The renderer uses `innerHTML` on a string built **only** from the frozen corpus plus
numbers — no user data ever reaches it.

---

## 4. SPEECH BUBBLES

### 4.1 Rendering approach: **pooled HTML divs projected onto `#overlay`** — decided

Rejected: pooled sprites with `CanvasTexture`. Reasoning, concretely:

* **Crispness.** A DOM bubble renders at device-pixel-ratio with subpixel-antialiased
  system text. A 256×64 CanvasTexture on a camera-facing quad at 60–340 units of camera
  distance is 8–14 px tall on screen — mush. The lines are 5–9 words; they must be
  *readable* or the joke dies.
* **Cost.** A sprite bubble means one canvas paint + one `texture.needsUpdate` GPU upload
  per bubble, ~4× every 2 s, forever. The div path is 4 pooled nodes created once and a
  `style.left/top/opacity` write per frame — the *exact* code path `floaters` already runs
  at 14 concurrent with no measurable cost.
* **Reuse.** The projection, the cached `canvasRect`, and the 1 fps-safe fade already exist
  in `tick()`. Bubbles are the same loop with a different pool and a tail.
* **Consistency.** Floaters (`+5 houses!`) are already DOM. Two text systems in two
  technologies stacked in the same 40 px of screen would not match.

The one thing sprites would buy — depth occlusion behind buildings — is handled by rules,
not by z-buffer: skip anchors behind the camera (`_v.z > 1`), skip beyond 170 world units,
and prefer speakers whose plot is closer to the camera than the monument.

Markup: 4 divs, created in `initNews`, appended to `#overlay`, `display:none` when free.

```css
.bub{position:absolute; transform:translate(-50%,-100%); pointer-events:none;
  max-width:190px; padding:5px 9px 6px; border-radius:11px;
  background:rgba(24,24,22,.90); border:1px solid rgba(255,255,255,.18);
  color:#EDEBE0; font:500 11.5px/1.32 "Segoe UI",system-ui; text-align:center;
  text-shadow:0 1px 2px rgba(0,0,0,.7); opacity:1}     /* base = final state */
.bub:after{content:''; position:absolute; left:50%; bottom:-6px; margin-left:-5px;
  width:0; height:0; border:5px solid transparent; border-top-color:rgba(24,24,22,.90)}
.bub.pop{animation:bubPop .30s cubic-bezier(.2,1.5,.4,1)}
@keyframes bubPop{from{opacity:0; transform:translate(-50%,-90%) scale(.72)}
                  to{opacity:1; transform:translate(-50%,-100%) scale(1)}}
.bub.worship{background:rgba(40,32,14,.90); border-color:rgba(243,208,122,.34); color:#F3D07A}
.bub.cheer{background:rgba(46,26,12,.92); border-color:rgba(243,208,122,.45)}
```

### 4.2 `say()` and lifecycle

```js
/**
 * Request a bubble. Returns false if the pool is full or the anchor is off-screen /
 * behind the camera — callers may ignore the result.
 * @param {THREE.Vector3} v   HEAD-TOP world position (npcs supplies y already offset)
 * @param {string} kind       'stroll' | 'worship' | 'cheer' | 'night' | 'build'
 * @param {{text?:string, ttl?:number}} [opts]  text overrides the corpus pick
 */
say(v, kind, opts);
```

* **Max 4 concurrent**, and at most **2** of any one kind, so a 40-strong congregation
  cannot become a wall of murmurs.
* `ttl = 2600 + text.length * 46` ms, clamped `[3200, 5200]`.
* Position is re-projected **every frame** from the stored anchor — but the anchor is a
  snapshot: the villager keeps walking, the bubble stays put and the effect reads as a
  remark left hanging in the air. Following a moving instanced villager would cost a
  per-frame lookup into `npcs` internals for four ids, which no ownership boundary allows.
* Fade-out is opacity-only in the last 500 ms, computed from `now` — never `dt`.

### 4.3 The API `npcs.js` exposes (its only v3 addition)

`npcs.js` must not know news exists (no circular imports, and the mediator rule). So the
data flows the other way: **town.js pulls a speaker, then calls `news.say`.**

```js
/**
 * Sample a villager to speak. Wall-clock safe, allocation-free.
 * @param {string|null} want  desired state: 'stroll'|'worship'|'cheer'|'home'|null (any)
 * @param {THREE.Vector3} out  filled IN PLACE with the head-top world position
 * @returns {string|null} the villager's actual state, or null if nobody matched
 */
pickSpeaker(want, out)
```

Implementation inside `npcs.js` (~12 lines): reservoir-sample one match in a single pass
over `npcs`, prefer a villager not sampled in the last 3 s (`n.spokeAt`), write
`out.set(n.x, HEAD_Y * n.scale + .32, n.z)`.

`town.js`, on a wall-clock cadence of **2200 ms** (and only when `news` has a free slot):

```js
if (now - bubbleAt > 2200) {
  bubbleAt = now;
  const want = ctx.night > .6 ? 'home' : Math.random() < .45 ? 'worship' : 'stroll';
  const st = npcs.pickSpeaker(want, _bv);
  if (st) news.say(_bv, st === 'home' ? 'night' : st === 'worship' ? 'worship' : 'stroll');
}
```

Celebration cheers are pushed rather than sampled, so they land on the beat: `fireMilestone`
and the trickle branch of `drainSpawnQueue` call `pickSpeaker('cheer', _bv)` (or reuse the
new building's position) and `news.say(_bv, 'cheer' | 'build')` directly.

First bubble is requested at `t = 900 ms`, not at `t = 2200`, so a short shot has one.

### 4.4 `tick()` insertion point

Slot into the existing order as **step 10b**, immediately after the floaters block (both
project; both want the same cached `canvasRect`):

```
10.  stepParts / stepPuffs / floaters
10b. news.update(dt, now, ctx)          ← rotates the headline, ages + projects bubbles
11.  camera …
13.  500 ms stats timer → mutate news.facts in place
```

---

## 5. THE CORPUS

Register: dry, deadpan, faux-provincial-newspaper, obsessed with an economy nobody
understands. Never explains the joke. Never mentions a model. `_italic_` is the byline or
the dry aside; `**bold**` is a number.

```js
const FOLK = ['Mabel Quire','Otto Cachewright','the Widow Tallis','Deputy Ledger-Keeper Bram',
  'Old Ness','Sil the Baker','Councillor Pemb','Harriet Snub','Grum the Tallyman',
  'Fen Marrow','the ferryman Odd Bill','Perpetua Hask','Squire Dunnage','Nib the Younger',
  'Wren Cottrell','the Reverend Ossick','Barnaby Flit','Goodwife Trundle','Tam Rooksbury',
  'Ivy Pell','the Hermit of Ring Nine','Constable Mott','Peg Ashwood','Doctor Vellum'];
```

### 5.1 `ECON` — ambient economy, no pace opinion (18)

```
Token futures up **{pct}%**. Nobody knows what a token future is.
The Exchange closed early. It reopened immediately, embarrassed.
Analysts describe the token market as "fine, probably, why".
{name} has cornered the market in something. Investigation ongoing.
The rate of spend is described as "healthy" by people paid to say that.
Inflation holds steady at whatever it was yesterday.
A second economy has been discovered underneath the first one.
{town} adopts a new currency. It is tokens. It was always tokens.
The Ledger balances. Three clerks faint from relief.
Trade delegation arrives from a town that does not exist yet.
The bank of {town} reports **{tok}** in reserve and no vault to put it in.
Market analysts revise their forecast to "more of this, presumably".
Someone tried to short the token. The town has taken their shoes.
Quarterly report: **{b}** buildings, zero explanations.
The economy is doing that thing again. You know the one.
Interest rates lowered to be polite.
{name} proposes taxing the tokens. {name} is now unemployed.
Auditors arrive. They are given soup and asked to leave.
```

### 5.2 `BOOM` — pace clearly above trend (14)

```
**{pace}** tokens a minute. The mill cannot keep up and has stopped trying.
The economy is great today. Suspiciously great. Nobody look directly at it.
Boom town! Bricklayers report a shortage of bricks, hands, and hours.
Spending is up **{pct}%**. The Ledger has been moved to a bigger table.
{town} declares a public holiday, then cancels it — too much work on.
Foundry running hot. {name} says the anvil "sang" and won't elaborate.
Wagon queue stretches to ring **{tier}**. Drivers are singing. Badly.
Traffic on the ring road at record levels. Two carts. Unprecedented.
The scaffolds cannot be raised fast enough. Carpenters demand more thumbs.
Prosperity index hits **{pct}**, a number the town just invented.
Construction guild triples its prices. Construction guild has all the work.
Grain, timber and gossip all in short supply. Gossip recovering fastest.
At this rate {town} will need a second {town}.
Historians warn future generations will call this "the good bit".
```

### 5.3 `BUST` — pace clearly below trend (12)

```
Token prices soften. {name} calls it "a rest, not a rout".
The market takes the afternoon off. It has earned it, apparently.
Spend down **{pct}%**. The Exchange is playing cards.
A slow hour in {town}. The bell tower rang once, out of boredom.
The forge is warm but not hot. Metaphor noted by three separate poets.
Economists blame the weather. There is no weather. Economists blame it anyway.
Quiet trading. The loudest thing in town is the well.
Nothing was built today. The scaffold waits, patient as furniture.
Merchants report "adequate" business, in the tone of a man saying otherwise.
The town treasury remains at **{tok}**. It is a very stable number now.
Recession declared, then withdrawn when someone bought bread.
{name} suggests everyone try harder. {name} is thrown in the well. Gently.
```

### 5.4 `SLOW` — genuine idle, melancholic (12)

```
No tokens for **{minutes}** minutes. The town has begun to reminisce.
The Ledger has not moved. {name} reads it aloud anyway, for the atmosphere.
{town} holds its breath. It has been holding it a while now.
Villagers gather at the frontier to look hopefully outward. Nothing arrives.
The scaffold on plot **{b}** is now the town's most-visited landmark.
A hush over {town}. Someone's stew is the leading news story.
The bakery sells bread to the baker. The circle of life, financially.
Idle hands. Idle carts. One idle goat, historically idle.
{name} has started a book club. Attendance: everyone. Books: none.
Long shadows and longer silences. The Ledger dozes.
The town crier has run out of news and is now describing clouds.
Nothing to report. Reported thoroughly, at length, with feeling.
```

### 5.5 `BUILD` — new construction gossip (16)

```
**{n}** new buildings rise overnight. Nobody saw who did it.
Ground broken on plot **{b}**. {name} objects. {name} always objects.
A **{label}** appears where yesterday there was opinion.
Planning permission granted retroactively, as is tradition in {town}.
{name} moves in before the roof does. Reports it "cosy, drafty, mine".
Another **{label}**. The neighbours are thrilled and lying.
Housing stock reaches **{b}**. Rent invented immediately afterward.
The frontier moves outward. The old frontier writes a memoir.
Builders complete **{n}** homes and demand to be called wizards.
New chimney smoking by noon. Chimney sweep guild expands by one.
{name} paints their door a colour. The council will discuss this for weeks.
A house was built so fast the survey is dated tomorrow.
Ring **{tier}** now fully settled. Ring **{tier}** disputes this.
The **{label}** opens to universal approval and one furious letter.
Population **{villagers}** and climbing. Nobody has left in years.
{town} annexes another field. The field takes it well.
```

### 5.6 `MILESTONE` — hysteria (12)

```
**{title}** — {town} has never seen the like, and says so, repeatedly.
Bells. Bells everywhere. The bell-ringer has been carried off shoulder-high.
{name} weeps openly at the Ledger. The Ledger is unmoved but flattered.
History made at **{tok}**. Historians already arguing about it.
The town declares a feast. There is no food. The feast proceeds regardless.
A milestone! Children will be named after this number. Poorly.
{town} enters the record books, then buys the record books.
Fireworks over the plaza. The goat is beside itself.
**{tok}** tokens. Somebody fetch a bigger tablet.
The council commissions a statue of the number. Sculptor asks which end is up.
Streets renamed after the total. Postal service resigns en masse.
Everything after this is the sequel.
```

### 5.7 `LANDMARK` — a new landmark stands (10)

```
The **{landmark}** is complete. It is enormous and nobody is quite sure why.
{town} unveils the **{landmark}**. Ribbon cut. Ribbon lost. Ribbon mourned.
The **{landmark}** casts a shadow over three opinions and one bakery.
Masons finish the **{landmark}** and immediately propose a bigger one.
The **{landmark}** opens. Tours available. Tours not recommended.
Skyline altered permanently. {name} says it "blocks the good sky".
Landmark **{order}** of nine. The other eight are watching closely.
The **{landmark}** hums faintly at night. This is fine. This is fine.
Pilgrims arrive for the **{landmark}**, having heard about it before it existed.
The **{landmark}** is declared load-bearing for civic pride.
```

### 5.8 `CULT` — the monument, cult-adjacent whimsy (18)

```
The Great Coin remains pleased. Probably.
**{villagers}** villagers face the altar at once. Nobody organised this.
The Ledger has been updated. The Ledger is always being updated.
Worship attendance up **{pct}%**. Attendance was already everyone.
The Coin turned. Witnesses disagree on which way, and now don't speak.
Tier **{tier}** rites commence. Nobody remembers writing the rites.
The altar glows a little brighter. This is either good or the other thing.
A murmured total, repeated by **{villagers}** voices, at slightly different speeds.
The Reverend Ossick preaches on the doctrine of Sum. The sermon is a number.
Offerings left at the plaza: bread, flowers, an itemised receipt.
The Coin does not accept prayers. It accepts totals. It has received **{tok}**.
Night watch reports the altar was warm. Day watch reports it always is.
A child asks what the Coin is for. The congregation moves on to hymn four.
The halo rings turned in opposite directions again. Scholars: "yes."
{name} claims the Coin winked. The council records this as weather.
The tablet reads **{tok}**. It has never once been wrong, or explained.
Devotees insist the number is going somewhere. The number agrees.
Silent worship at the altar, broken by one very loud sneeze.
```

### 5.9 `NIGHT` — after dark (12)

```
Lanterns out along the ring road. **{villagers}** small lights, one big dark.
The night shift files a report consisting entirely of the word "quiet".
{town} sleeps. The Ledger does not. The Ledger never has.
Windows lit across **{b}** houses. Somebody in each of them is awake, thinking.
Curfew observed by everyone except the beacon.
The lamplighter has finished, sat down, and become part of the scenery.
Owls report unusual token activity. Owls are not reliable sources.
Late trade at the tavern. Currency: gossip. Exchange rate: awful.
The stars are out over {town}, doing their usual **{pct}%** of nothing.
{name} walks home the long way, past the altar, as always.
Night watch counts the buildings twice and gets **{b}** both times. Suspicious.
A candle burns in the wizard tower. It has burned there since the tower did.
```

### 5.10 `DAWN` — day breaks (6)

```
Dawn over {town}. The Ledger is dusted, the day is priced.
Shutters open on **{b}** houses. The economy stretches, cracks, begins.
Morning bell. The first token of the day is greeted like a returning hero.
Cocks crow. Clerks crow louder. The market opens on a rumour.
Sunrise. {name} is already at the altar, having never left.
A new day in {town}, priced at whatever the last one cost, plus attitude.
```

### 5.11 `RANGE` — the tracker's window changed (12)

```
Historians annex the entire month into the town archives. Chaos. Delight.
The council redefines "today". **{b}** buildings appear to have always been here.
Surveyors re-measure {town} against **{range}**. It is bigger. It is smaller. It is fine.
Time itself renegotiated. {town} now remembers exactly {range} and not a moment more.
The archive opens. {range} of history walks in and puts its feet up.
Everything before {range} has been declared prehistory. Nobody objects.
{town} adopts a new calendar covering {range}. The old one is used as kindling.
The scope of civic memory adjusted to {range}, by committee, by candlelight.
Cartographers redraw the town for {range}. They ask, politely, that this stop.
The Ledger is reopened at an earlier page. Dust everywhere. **{tok}** total.
A shorter reckoning: {town} shrinks to what it did in {range} and feels lighter.
{range} of tokens, all at once. The clerks require a moment alone.
```

### 5.12 `CIVIC` — pure absurd filler (16)

```
The council meets. The council will meet about the meeting.
{town} has **{breaks}** designated resting groves and one contested hedge.
A goat has been elected to the planning committee. It abstains beautifully.
The well is fine. This is the fourth consecutive report that the well is fine.
{name} has written to the Crier. The letter is long. The point is not in it.
Road maintenance completed. Roads unchanged. Budget spent. Everyone content.
The tallest building is a **{grandest}**. It is very smug about it.
Lost: one cart. Found: opinions about where the cart went.
{town} twinned with a town nobody can locate on any map.
The Crier's own wages remain a matter of lively public indifference.
Statue vandalised with a smaller, better statue.
Public consultation on the new bench concludes: the bench is a bench.
{name} and {name} are not speaking. The town has picked sides. Both sides.
Fire drill held. Nothing was on fire. Several things now are.
The bakery's queue is longer than the market's. War is inevitable.
A survey finds **{pct}%** of villagers approve of the town. The rest were asleep.
```

### 5.13 `BEST` / `DAYSTART` / `BOOT` / `GROVE` / `PROMO` (specials, 16)

```
BEST:
Yesterday has been beaten and is taking it badly.
**{tok}** — the record falls. Somebody update the stone. Again.
{town} exceeds its own personal best. Modesty exceeded simultaneously.
The previous record is escorted from the building.
The Ledger overwrites yesterday without ceremony or apology.

DAYSTART:
A new day. {town} wakes with **{b}** buildings and no memory of yesterday.
The Ledger is turned to a clean page. It is a beautiful, terrifying page.
Midnight passed. The town was rebuilt from scratch. Nobody noticed. Nobody minds.
Founding of {town}, again. Fourth time this week.

BOOT:
{town}, population **{villagers}**, established at once, fully furnished.
The town assembles itself out of the record. **{b}** buildings, no permits.
Welcome to {town}. Everything you see was paid for in tokens.

GROVE:
Trees planted where nothing was spent. **{breaks}** groves and counting.
{town} designates another grove. The goat approves for its own reasons.
A break in the work becomes a stand of pines. Nobody planned this. It happened.
The idle hours are now a small forest. Ecologists thrilled, economists less so.
```

### 5.14 `PROMO` — redevelopment wave (8)

```
**{n}** homes rebuilt grander overnight. The old ones are not mentioned.
The frontier becomes downtown. Rents rise. Nobody knows who collects them.
Renovation sweeps ring by ring. {name} has moved four times without leaving home.
{town} gentrifies itself, apologetically, from the middle outward.
A cottage went to bed and woke up a villa. Doctors are baffled and jealous.
The tier survey is revised upward. The tallest is now a **{grandest}**.
Scaffolds bloom across the inner rings like a rash of ambition.
Old {town} is gone. New {town} is identical but taller and smugger.
```

### 5.15 Demo-mode extra (1, only when `opts.demo`)

```
_The Crier notes this town is a simulation. It intends to keep reporting anyway._
```

**Corpus total: 193 lines** across 15 categories, comfortably above the 90–140 ask;
trimming is easier than writing, and the anti-repeat window benefits from the depth.

### 5.16 Bubbles — `BUB` (68 lines, 5–9 words)

```js
BUB.stroll (20)
  "Tokens again. Always tokens."
  "Rent's gone up. Obviously."
  "Best road in {town}, this one."
  "They built another one overnight."
  "My cousin lives in ring four."
  "Have you seen the total?"
  "Nobody tells me anything."
  "It's all going somewhere, I hear."
  "The Ledger says otherwise."
  "Good spend today. Good spend."
  "I liked it before the wall."
  "That's a lot of chimneys."
  "Mind the cart. There's no cart."
  "Do you smell bread?"
  "Where does it all go?"
  "Another number, another neighbour."
  "I'm not paying that."
  "The goat's back."
  "Someone's been counting again."
  "Lovely weather for accumulation."

BUB.worship (14)
  "…and the sum thereof…"
  "It's warm today. The Coin."
  "Bless the total."
  "Higher. Always higher."
  "I don't understand. I attend."
  "…seven, carry the eight…"
  "The Coin knows my name."
  "Shh. It's counting."
  "May the Ledger balance."
  "It moved. I saw it move."
  "Just one more zero. Please."
  "We are all line items."
  "The number provides."
  "Quiet now. It's thinking."

BUB.cheer (14)
  "WE DID IT! What did we do?"
  "MORE! MORE! MORE!"
  "Told you! I told everyone!"
  "Hooray for the number!"
  "This is the best day ever."
  "I'm going to cry. I am crying."
  "Fetch the good bread!"
  "Look at it GO!"
  "Somebody wake the baker!"
  "History! We're standing in it!"
  "That's my house! That one!"
  "Ring the bell! Ring everything!"
  "I have never been happier."
  "Put it on the stone!"

BUB.night (10)
  "Long day. Long total."
  "Lantern's low. So am I."
  "Still lit up there, look."
  "Bed. Then more tokens."
  "It never stops, does it."
  "Night watch. Nothing. As usual."
  "Someone's awake in the tower."
  "Quiet as a closed ledger."
  "See you at dawn, then."
  "Don't look at the altar."

BUB.build (10)
  "That wasn't there this morning."
  "New neighbours. Already loud."
  "Who signed off on this?"
  "Nice roof. Terrible door."
  "They're getting faster, aren't they."
  "That's my view gone."
  "Fresh mortar. Smells like money."
  "I wanted that plot."
  "Welcome, I suppose."
  "Another one! Where do they come from?"
```

---

## 6. IMPLEMENTATION CHECKLIST

- [ ] `news.js` exports `initNews`, `townNameFor`, `NEWS_CORPUS` (frozen, for tests).
- [ ] `index.html` gains `#news` (mast + line) and the `.bub` CSS; header gains `#place`.
- [ ] `town.js`: `initNews` after `initNPCs`; `news.update(dt, now, ctx)` at step 10b;
      `news.facts` mutated in the 500 ms timer; `post()` at the 13 sites in §3.2;
      `news.reset(seed)` in `hardReset`; a 2200 ms bubble sampler.
- [ ] `npcs.js`: `pickSpeaker(want, out)` + `n.spokeAt` (its only v3 change).
- [ ] Base CSS = final state for `#news .line` and `.bub` — verify by screenshotting with
      `--shot-delay=3000` (before any swap has ever run) and confirming text is present.
- [ ] Verify: `--shot-delay=9000` day, night (`--hour=23`, expect a `NIGHT` line), and
      `?feed=demo&tokens=1e9&still=1` (expect a `CULT`/`ECON` line, tier-9 town).
- [ ] Grep the corpus for real model names before shipping. There must be none.
