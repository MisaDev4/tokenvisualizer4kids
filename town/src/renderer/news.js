// The Town Crier. Three things live here and nothing else does:
//
//   1. THE TICKER — a one-line municipal gazette under the header that cycles on the
//      wall clock, ingests typed events from town.js with priorities, and picks its
//      own ambient copy when nothing is happening.
//   2. THE BUBBLES — up to 4 pooled HTML divs projected over the stage. DOM, not
//      sprites: a 5–9 word remark is 8–14 px tall at real camera distance and has to
//      be READ, so it renders at device-pixel-ratio with the same projection path the
//      floaters already prove at 1 fps.
//   3. THE NAME — a seeded town name the whole app quotes.
//
// The town is earnest; the Gazette does all the winking (REDESIGN-V3 §1). No line may
// name a model — the economy here runs on tokens, spend and the Ledger.
//
// EXISTENCE IS WALL-CLOCK. Rotation, event display, bubble spawn and bubble expiry all
// key off `performance.now()`; `dt` is never read. A 3 s headless shot must already
// show a headline, and a 7 s one a bubble. Corollary, and the single most important
// implementation note in this file: BASE CSS IS THE FINAL STATE — `.line` and `.bub`
// are fully opaque at rest and the keyframes only travel TOWARD that, so a throttled
// compositor can never screenshot a blank bar.
//
// news.js imports nothing but three.js. town.js is the sole mediator: it post()s
// events and it is the only caller of say().
//
// v6 · THE BANNER AND THE WIRE. Two changes, and they are the same change: the
// ticker was 12.5 px of sans in a 29 px strip, so the only writing in the app
// with a voice was set at the weight of a tooltip and nobody read it. It is a
// masthead now — gilt edge, serif nameplate, the headline itself in 17 px italic
// Georgia with its numbers upright and gold — and the copy has been rewritten to
// deserve the size. The new house voice is WIRE: two beats, a full stop between
// them, the joke in the last four words, a local nobody doing a small thing
// reported with the gravity of a coronation. It carries ~40 % of ambient, with
// NOTICE (the small ads) behind it, and every older pool has been topped up so
// the whole gazette rotates further before it repeats. Dwell went up with the
// point size: a punchline in the last four words cannot be swapped out early.
//
// v5 · STREET LEVEL. `--cam=stroll` puts the camera at 1.35 m among the crowd,
// and two things that were invisible from 200 units up became the whole picture:
//   · A bubble is DOM, so it has no depth. A remark from behind a cottage used
//     to draw straight through the wall. news.js now runs its own SIGHT TEST —
//     a uniform grid over `ctx.getBuildings()` and a segment/cylinder march from
//     the eye to the speaker — and a blocked remark is not spawned and not drawn.
//     If town.js ever hands over `ctx.occluded(v)` (a real raycast against the
//     LOD instances), that is used instead and the grid is never built.
//   · Bubbles were sized on a LINEAR distance ramp tuned for one framing. They
//     are now sized by the speaker's ANGULAR size — how many pixels tall the
//     person actually is — so the same curve reads at two metres and at five
//     hundred, and the collision boxes are the elements' measured sizes rather
//     than two constants.
//
// v5.1 · WHERE A REMARK IS ALLOWED TO SIT. Three rules, all re-decided every
// frame by place() rather than once at spawn, because the speaker walks and the
// camera swings and a box that was clear when the remark was made is not clear
// three seconds later:
//   · NOTHING COVERS THE NUMBER. The fountain's counter is the one thing on
//     screen this app exists to show, and it is directly above the heads of the
//     crowd most likely to be talking. A remark whose box would land on it hangs
//     UNDER its speaker instead and the tail turns over; if neither way up is
//     clear it is not drawn, and not made. The Crier is no longer exempt — his
//     is the widest card in the app and he is walked to the plaza rim on purpose.
//   · A SPEAKER OFF SCREEN SAYS NOTHING. The frustum test is the frustum now,
//     and it is re-run every frame instead of only `z > 1`.
//   · A REMARK AT THE EDGE OF THE FRAME IS WHOLE. The box slides inside the
//     picture and the tail (`--nub`) travels back the other way to stay on the
//     villager, rather than being clipped in half by #overlay's overflow.
//
// v4 adds three optional sources and one reader, all additive and all null-safe:
// `nameOf` (a live resident for {name}), `cast` (the {who}/{job}/{quarter}/… gossip
// cast), the chronicle's five facts on `facts`, and `headline()` — the copy the
// Crier walks to the plaza and shouts. THE DEGRADATION RULE IS ABSOLUTE: with no
// roster and no chronicle, every new slot is in NEEDS and every new pool is gated
// out of the ambient mix, so the ticker is byte-for-byte what it was in v3.
import * as THREE from './vendor/three.module.js';

/**
 * Per-frame read-only town context. Owned and mutated in place by town.js.
 * @typedef {Object} TownCtx
 * @property {number} day @property {number} night @property {number} simNow
 * @property {THREE.PerspectiveCamera} camera
 * @property {number} totalTok @property {number} buildingCount
 * @property {number} perMin @property {number} paceRatio
 * @property {Object} plan @property {number} frontierK @property {number} band
 * @property {{cx:number,cz:number,r:number}} bounds @property {number} outerR
 * @property {number} plazaR @property {THREE.Vector3} monumentPos
 * @property {Object} palette @property {number} accent @property {string} accentCss
 * @property {number} daySeed @property {number} planSeed @property {string} seedHex
 * @property {string} townName
 * @property {string} rangeKey @property {string} rangeLabel @property {string} rangeShort
 * @property {number} rangeStartMs @property {boolean} rangeIsDay
 * @property {number} intro         0..1 founding-ritual progress; 1 = settled
 *
 * Optional, all read defensively — news.js works with none of them:
 * @property {()=>Array<{pos:THREE.Vector3, hTop:number, span?:number}>} [getBuildings]
 *   already on ctx for npcs; the sight test builds its occluder grid from it.
 *   `span` is not on the row today and is guessed from hTop when absent.
 * @property {number} [monumentTop]  monument.crownHeight — the top of the notice
 *   board. Without it the fountain keep-out guards a generous world band instead.
 * @property {(v:THREE.Vector3)=>boolean} [occluded]  true if `v` is hidden from
 *   the camera by town geometry. Overrides the built-in grid entirely.
 */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const str = v => typeof v === 'string' ? v : '';
/** Same shape as the footer's hero number, so a headline and the footer never disagree. */
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));

/* ═══ seeded randomness ═════════════════════════════════════════
   Copied, not imported: news.js imports nothing but three (§0.2). Two streams —
   `hash1` for one-shot deterministic draws (the name), `stream` for the shuffles. */
const hash1 = s => {
  let x = Math.imul((s | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
const stream = seed => { let a = (seed >>> 0) || 1; return () => {
  a = (a + 0x6D2B79F5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/* ═══ the name ══════════════════════════════════════════════════ */

const HEAD = ['Token', 'Cache', 'Ledger', 'Prompt', 'Spend', 'Tally', 'Byte', 'Coin', 'Burn',
  'Quill', 'Chit', 'Vellum', 'Tithe', 'Draft', 'Mint', 'Scrip', 'Debit', 'Ember', 'Gild', 'Wick',
  'Sum', 'Cost', 'Score', 'Marrow'];
const TAIL = ['holm', 'wick', 'ford', 'mere', 'bury', 'stead', 'gate', 'thorpe', 'hollow', 'march',
  'combe', 'worth', 'minster', 'dale', 'haven', 'cote', 'ridge', 'fell', 'shire', 'by'];
const HON = ['Little', 'Great', 'Nether', 'Upper', 'Old', 'New', 'Saint', 'Fort', 'Port', 'Lower'];
const UPON = ['Spend', 'Tally', 'Cache', 'the Burn', 'the Ledger', 'Draft', 'the Overrun', 'Sum'];
/** The hyphenated form cannot take a definite article: 'Mint-on-the Ledger' is not a place. */
const UPON1 = UPON.filter(s => s.indexOf(' ') < 0);

/**
 * The town's name. Deterministic and stable for a whole epoch — a place the user can
 * grow fond of, and a new one when the epoch turns.
 * 62 % 'Tokenholm' · 18 % 'Little Cachewick' · 14 % 'Ledgerford upon Spend' · 6 % 'Mint-on-Tally'.
 * @param {number} seed  ctx.planSeed
 * @returns {string}
 */
export function townNameFor(seed) {
  const s = (seed >>> 0) || 1;
  const pick = (arr, salt) => arr[Math.floor(hash1(s + salt) * arr.length) % arr.length];
  const core = pick(HEAD, 17) + pick(TAIL, 331);
  const f = hash1(s + 7717);
  if (f < 0.62) return core;
  if (f < 0.80) return pick(HON, 991) + ' ' + core;
  if (f < 0.94) return core + ' upon ' + pick(UPON, 4409);
  return pick(HEAD, 55) + '-on-' + pick(UPON1, 6101);
}

/* ═══ the corpus ════════════════════════════════════════════════
   Register: dry, deadpan, faux-provincial-newspaper, obsessed with an economy nobody
   understands. Never explains the joke. **bold** is a number, _italic_ an aside.
   A leading `~` marks a DAY-SCOPED line (it says "yesterday" or "a new day") — skipped
   when the tracker's range is not a day window. The marker is stripped at load. */

const FOLK = ['Mabel Quire', 'Otto Cachewright', 'the Widow Tallis', 'Deputy Ledger-Keeper Bram',
  'Old Ness', 'Sil the Baker', 'Councillor Pemb', 'Harriet Snub', 'Grum the Tallyman',
  'Fen Marrow', 'the ferryman Odd Bill', 'Perpetua Hask', 'Squire Dunnage', 'Nib the Younger',
  'Wren Cottrell', 'the Reverend Ossick', 'Barnaby Flit', 'Goodwife Trundle', 'Tam Rooksbury',
  'Ivy Pell', 'the Hermit of Ring Nine', 'Constable Mott', 'Peg Ashwood', 'Doctor Vellum'];

const RAW = {
  /* ── THE WIRE. The flagship ambient pool and the one that sets the house
        voice: two beats, a full stop between them, and the second beat is the
        joke. A local nobody does a small thing; the paper reports it with the
        gravity of a coronation and no further comment. Nothing here is unkind
        and nothing here is a complaint — the town is delighted with itself and
        the Gazette is delighted with the town.
        Short ON PURPOSE. These have to land inside one glance at a banner, so
        the target is under ~80 characters and the punchline is the last four
        words. Anything that needs a subordinate clause belongs in CIVIC. ── */
  WIRE: [
    '{town} man discovers thing. Is thrilled.',
    'Local woman does sum correctly. Town in uproar, then applause.',
    'Scientists baffled by {town}. Scientists were already baffled.',
    'New study links tokens to more tokens. Funding renewed instantly.',
    'Is your neighbour a token? Nine signs, page four.',
    '{name} wins argument with a door. Door lodges appeal.',
    'Hole discovered in ground. Authorities call it "a good hole".',
    'Bread invented again, locally, by accident. Baker unavailable, eating.',
    '{town} declared "a place" by visiting official. Bunting deployed.',
    'Man bites ledger. Ledger unharmed, quietly flattered.',
    '{name} has a hunch. The hunch has been minuted.',
    'Weather described as "outside" by leading local expert.',
    'Rumour travels {town} at **{pct}** miles per hour, overtaking cart.',
    'Everything fine, reports man standing in a bucket.',
    '{town} wins award for having the award. Award pleased.',
    'Tokens found inside other tokens. Enquiry widens, narrows, stops.',
    'Chimney sweep sweeps chimney. Front page in {town}.',
    'Hat found. Owner not found. Hat coping admirably.',
    'Sky reported "up" for ninth consecutive day. Streak holds.',
    '{name} has opinions and, worryingly, a ladder.',
    'Study finds **{pct}%** of {town} is other people. Remainder is goat.',
    'Man attempts to spend one token twice. Ledger says no, kindly.',
    'Local dog learns the word "total". Dog now insufferable.',
    'Bell rung. Reason unclear. Everybody came anyway.',
    'Number goes up. Town goes "ooh". Cycle repeats.',
    'Ladder leans against nothing for third day running.',
    'Village pump named finest in {town}. It is the only pump.',
    'Cart discovered in hedge. Hedge presses no charges.',
    'Fog reported over {town}. Fog denies everything.',
    '{name} builds small model of {town}. Puts small {name} in it.',
    'Two clerks agree. Bells rung in error, then on purpose.',
    'Coin found under mattress. Mattress promoted to bank.',
    '{town} names a street after a number. Number blushes.',
    'Local soup declared The Good Soup. Rival soup furious.',
    'Man walks length of {town}. Confirms it is, in fact, there.',
    'Cheese located. Panic subsides. Cheese thanked publicly.',
    'A queue has formed. Nobody knows for what. Excellent queue.',
    'Local expert consulted, then ignored, then warmly thanked.',
    'Nothing happened today. It happened extremely well.',
    '{name} counts to **{tok}** aloud. Doctors intrigued, mildly.',
    '{town} boasts **{b}** buildings, one hedge, and no idea.',
    'Local child asks good question. Council adjourns until spring.',
    'Man mistakes fountain for other fountain. There is one fountain.',
    'Duck arrives. Duck is given a title. Duck accepts.',
    '{town} tries whistling. Results described as "encouraging".',
    'Rain forecast. Rain arrives. Forecaster insufferable for a week.',
    'Local man proud of shed. Shed unaware. Shed magnificent.',
    'Someone has painted a rock. The rock is now a landmark.',
    '{name} declared "a lot" by own reflection. Reflection stands by it.',
    'Boy claims to have seen the total. Boy is nine. Boy is believed.',
    'Wheel reinvented in {town}. It is rounder. Nobody will say how.',
    'Fire prevented by nobody doing anything. Heroes everywhere.',
    'Local pigeon returns after long absence. Pigeon says nothing.',
    'Study: **{pct}%** of villagers enjoy being counted. Rest not asked.',
    'Man saws plank. Plank halves. {town} has seen it now.',
    'A stranger says hello. {town} discusses this until Thursday.'
  ],
  /* ── the small ads, which in a paper this size are the best-read page.
        Same rhythm as WIRE, different frame: a notice is somebody ASKING the
        town for something, which is a joke you can only tell once a town
        exists. ── */
  NOTICE: [
    'Notice: lost, one cart. Reward offered: the cart.',
    'For sale: one ladder, slightly opinionated. Apply to {name}.',
    'Wanted: somebody to count things. Must supply own fingers.',
    'For sale: a hole. Excellent hole. Buyer collects.',
    'Notice: the bench is wet. The bench has been wet since March.',
    'Wanted: a second goat. First goat unaware of this notice.',
    'Notice: the well is closed for cleaning. The well is not dirty. The well is proud.',
    'For hire: {name}, for purposes {name} would rather not put in writing.',
    'Lost: one afternoon. Last seen near the fountain, in good spirits.',
    'Wanted: a larger tablet, for larger numbers. Enquire at the Ledger.',
    'Notice: {town} would like it known that it is doing very well, thank you.',
    'Found: something. Owner may describe it in detail to claim it.',
    'Notice: the Crier will shout as usual, at the usual volume, about the usual.',
    'For sale: **{b}** opinions, one careful owner, no reasonable offer refused.',
    'Wanted: witnesses to a small kindness on the market road. No hurry.',
    'Notice: whoever keeps tidying the square is asked, gently, to keep doing it.'
  ],
  /* ── ambient economy, no opinion on pace ── */
  ECON: [
    'Token futures up **{pct}%**. Nobody knows what a token future is.',
    'The Exchange closed early. It reopened immediately, embarrassed.',
    'Analysts describe the token market as "fine, probably, why".',
    '{name} has cornered the market in something. Investigation ongoing.',
    'The rate of spend is described as "healthy" by people paid to say that.',
    'Inflation holds steady at whatever it was yesterday.',
    'A second economy is found under the first. Both are audited. Both deny it.',
    '{town} adopts a new currency. It is tokens. It was always tokens.',
    'The Ledger balances. Three clerks faint from relief.',
    'A trade delegation arrives, unannounced, from three streets away.',
    'The bank of {town} reports **{tok}** in reserve and no vault to put it in.',
    'Forecast issued: **{pct}%** more of exactly this. Forecasters applaud themselves.',
    'Someone tried to short the token. The town has taken their shoes.',
    'Quarterly report: **{b}** buildings, zero explanations.',
    'A committee sits to explain the economy. It emerges holding a turnip.',
    'Interest rates lowered to be polite.',
    '{name} proposes taxing the tokens. {name} is now unemployed.',
    'Auditors arrive. They are given soup and asked to leave.',
    'Token declared "strong" against the loaf, "weak" against the goat.',
    'The Exchange has a new floor. It is the old floor, swept.',
    'Economists forecast **{pct}%**. Economists forecast this every week.',
    '{town} briefly considers a second currency, then has a lie-down.',
    'The Ledger is described as "up to date", a claim under investigation.',
    'A man offers to buy the whole town. He is offered a chair instead.',
    'Market confidence measured at **{pct}**. Instrument not explained.',
    'Trade is brisk. Nobody can say with what, or with whom, or why.',
    'The mint runs out of ink and carries on from memory.',
    'The town treasury is counted. Twice. By {name}. Loudly.'
  ],
  /* ── pace clearly above trend ── */
  BOOM: [
    '**{pace}** tokens a minute. The mill cannot keep up and has stopped trying.',
    'The economy is great today. Suspiciously great. Nobody look directly at it.',
    'Boom town! Bricklayers report a shortage of bricks, hands, and hours.',
    'Spending is up **{pct}%**. The Ledger has been moved to a bigger table.',
    '{town} declares a public holiday, then cancels it — too much work on.',
    'Foundry running hot. {name} says the anvil "sang" and won\'t elaborate.',
    'Wagon queue stretches to ring **{ring}**. Drivers are singing. Badly.',
    'Traffic on the ring road at record levels. Two carts. Unprecedented.',
    'The scaffolds cannot be raised fast enough. Carpenters demand more thumbs.',
    'Prosperity index hits **{pct}**, a number the town just invented.',
    'Construction guild triples its prices. Construction guild has all the work.',
    'Grain, timber and gossip all in short supply. Gossip recovering fastest.',
    'At this rate {town} will need a second {town}.',
    'Historians warn future generations will call this "the good bit".',
    'Everybody is busy. Even the goat has been given a job.',
    'The Ledger is being written at a run. The handwriting is a scandal.',
    '{town} runs out of nails at **{pace}** a minute. Improvises. Thrives.',
    'Bells rung by mistake, then on purpose, then for the sheer joy of it.',
    'Somebody has built a thing on top of another thing. Both are working.',
    'The mill turns so fast it has been asked, politely, to slow down.',
    'Boom declared official. Nobody can find the paperwork. Boom continues.',
    'Local man cannot keep up and is delighted about it.'
  ],
  /* ── pace clearly below trend ── */
  BUST: [
    'Token prices soften. {name} calls it "a rest, not a rout".',
    'The market takes the afternoon off. It has earned it, apparently.',
    'Spend down **{pct}%**. The Exchange is playing cards.',
    'A slow hour in {town}. The bell tower rang once, out of boredom.',
    'The forge is warm but not hot. Metaphor noted by three separate poets.',
    'Economists blame the weather. There is no weather. Economists blame it anyway.',
    'Quiet trading. The loudest thing in town is the well.',
    'Nothing was built this hour. The scaffold waits, patient as furniture.',
    'Merchants report "adequate" business, in the tone of a man saying otherwise.',
    'The town treasury remains at **{tok}**. It is a very stable number now.',
    'Recession declared, then withdrawn when someone bought bread.',
    '{name} suggests everyone try harder. {name} is thrown in the well. Gently.',
    'Trading described as "thoughtful". Nobody is trading. Everybody is thinking.',
    'The Exchange has taken up whittling. Results promising.',
    'A slow morning. The most-traded item in {town} is news of the slow morning.',
    'Prices hold. Tempers hold. The goat holds a small piece of rope.',
    'Local man watches the Ledger for an hour and reports "not yet".',
    'The town does less, and does it beautifully.'
  ],
  /* ── genuine idle, melancholic ── */
  SLOW: [
    'No tokens for **{minutes}** minutes. The town has begun to reminisce.',
    'The Ledger has not moved. {name} reads it aloud anyway, for the atmosphere.',
    '{town} holds its breath. It has been holding it a while now.',
    'Villagers gather at the frontier to look hopefully outward. Nothing arrives.',
    'The scaffold on plot **{b}** is now the town\'s most-visited landmark.',
    'A hush over {town}. Someone\'s stew is the leading news story.',
    'The bakery sells bread to the baker. The circle of life, financially.',
    'Idle hands. Idle carts. One idle goat, historically idle.',
    '{name} has started a book club. Attendance: everyone. Books: none.',
    'Long shadows and longer silences. The Ledger dozes.',
    'The town crier has run out of news and is now describing clouds.',
    'Nothing to report. Reported thoroughly, at length, with feeling.',
    'The Crier has begun reading the almanac aloud. He is on the tides.',
    '{town} has counted its chimneys. {town} is now counting them again.',
    'A leaf crossed the square. It was the day\'s leading item.',
    'The fountain is the only thing in {town} still saying anything.',
    'Somebody is asleep on the green and the whole town is being quiet about it.',
    '**{minutes}** minutes of nothing, kept in immaculate order.'
  ],
  /* ── new construction gossip ── */
  BUILD: [
    '**{n}** new buildings rise overnight. Nobody saw who did it.',
    'Ground broken on plot **{b}**. {name} objects. {name} always objects.',
    'A **{label}** appears where yesterday there was opinion.',
    'Planning permission granted retroactively, as is tradition in {town}.',
    '{name} moves in before the roof does. Reports it "cosy, drafty, mine".',
    'Another **{label}**. The neighbours are thrilled and lying.',
    'Housing stock reaches **{b}**. Rent invented immediately afterward.',
    'The frontier moves outward. The old frontier writes a memoir.',
    'Builders complete **{n}** homes and demand to be called wizards.',
    'New chimney smoking by noon. Chimney sweep guild expands by one.',
    '{name} paints their door a colour. The council will discuss this for weeks.',
    'A house was built so fast the survey is dated tomorrow.',
    'Ring **{ring}** now fully settled. Ring **{ring}** disputes this.',
    'The **{label}** opens to universal approval and one furious letter.',
    'Population **{villagers}** and climbing. Nobody has left in years.',
    '{town} annexes another field. The field takes it well.',
    'A house appears overnight. Its door is already sticking, charmingly.',
    'New roof goes on. Old sky files a complaint.',
    'Builders finish early and stand about admiring themselves. Fair enough.',
    '{name} inspects the new **{label}** and pronounces it "a building".',
    'Somebody has put a window in. The town has gathered to look through it.',
    'Ring **{ring}** gets a lamp. Ring **{ring}** has never felt so metropolitan.',
    '**{n}** new addresses invented. The postman is informed by rumour.'
  ],
  /* ── hysteria ── */
  MILESTONE: [
    '**{title}** — {town} has never seen the like, and says so, repeatedly.',
    'Bells. Bells everywhere. The bell-ringer has been carried off shoulder-high.',
    '{name} weeps openly at the Ledger. The Ledger is unmoved but flattered.',
    'History made at **{tok}**. Historians already arguing about it.',
    'The town declares a feast. There is no food. The feast proceeds regardless.',
    'A milestone! Children will be named after this number. Poorly.',
    '{town} enters the record books, then buys the record books.',
    'Fireworks over the plaza. The goat is beside itself.',
    '**{tok}** tokens. Somebody fetch a bigger tablet.',
    'The council commissions a statue of the number. Sculptor asks which end is up.',
    'Streets renamed after the total. Postal service resigns en masse.',
    'Everything after this is the sequel.',
    '**{tok}**. The Crier read it out, then sat down, then read it out again.',
    'The goat has been garlanded. The goat is having the day of its life.',
    'Strangers embrace in the street. They will be embarrassed by supper.',
    'A number this size has never been shouted in {town} before. It has now.',
    'The bakery gives away bread. THE BAKERY GIVES AWAY BREAD.'
  ],
  /* ── a new landmark stands. TEN of them, and the ladder was rebuilt to the
        village set in AESTHETIC.md: well, smithy, mill, market cross, tithe
        barn, market hall, chapel, bell tower, village green, inn. Nothing here
        may promise height — the deed card reads "landmark 1 of 10" off the same
        list, and the two used to disagree on screen in the same session. ── */
  LANDMARK: [
    'The **{landmark}** is finished. It is smaller than the argument about it.',
    '{town} unveils the **{landmark}**. Ribbon cut. Ribbon lost. Ribbon mourned.',
    'The **{landmark}** casts a shadow over three opinions and one bakery.',
    'Masons finish the **{landmark}** and immediately propose a bigger one.',
    'The **{landmark}** opens. Tours available. Tours not recommended.',
    'Skyline altered permanently. {name} says it "blocks the good sky".',
    'Landmark **{order}** of ten. The other nine are watching closely.',
    'The **{landmark}** creaks at night. This is normal. This is normal.',
    'Pilgrims arrive for the **{landmark}**, having heard about it before it existed.',
    'The **{landmark}** is declared load-bearing for civic pride.'
  ],
  /* ── the fountain, and the square that forms around it ──
     This used to be a cult that worshipped a floating Coin. The Coin and the
     altar under it are gone (see AESTHETIC.md), and a village fountain is a
     better centre anyway: it is where people meet, queue, gossip and loiter.
     The internal key stays CULT, and npcs.js's seated state stays 'worship',
     because renaming an identifier across five modules buys the user nothing.
     What the user READS is a village square. ── */
  CULT: [
    'The fountain is running well today. This is agreed by everyone present.',
    '**{villagers}** villagers around the fountain at once. Nobody organised this.',
    'The Ledger has been updated. The Ledger is always being updated.',
    'Fountain attendance up **{pct}%**. Attendance was already everyone.',
    'Somebody has cleaned the basin. Nobody will admit to it.',
    'The **{tierName}** is inspected by the council and found to be, quote, wet.',
    'The water catches the light for a moment and the whole square looks up.',
    'A total is read aloud at the fountain by **{villagers}** voices, at slightly different speeds.',
    'The Reverend Ossick has blessed the water. The water was fine already.',
    'Left at the fountain today: bread, flowers, and an itemised receipt.',
    'The board over the fountain reads **{tok}**. It has never once been wrong.',
    'Night watch reports the fountain still talking to itself. It always is.',
    'A child asks where the water comes from. The square debates this until supper.',
    'Two boys have been fished out of the basin. Both claim they were sent.',
    '{name} throws a coin in the fountain and declines to say what for.',
    'The queue at the fountain is long and entirely good-natured.',
    'Somebody says the number is going somewhere. The number agrees.',
    'Quiet at the fountain, broken by one very loud sneeze.',
    'A dog drinks from the basin. The council decides not to have seen it.',
    'The board is read by somebody who cannot read. They get the gist.',
    'Meeting held at the fountain. Agenda: the fountain. Outcome: warmth.',
    'Somebody has left a hat on the rim. It suits the fountain enormously.',
    'The water is doing the thing it does. Everyone agrees it is doing it well.',
    'Two villagers arrive to argue and stay to admire the stonework.',
    'A song starts at the fountain, badly, and is joined by **{villagers}** people.'
  ],
  /* ── after dark ── */
  NIGHT: [
    'Lanterns out along the ring road. **{villagers}** small lights, one big dark.',
    'The night shift files a report consisting entirely of the word "quiet".',
    '{town} sleeps. The Ledger does not. The Ledger never has.',
    'Windows lit across **{b}** houses. Somebody in each of them is awake, thinking.',
    'Curfew observed by everyone except the forge.',
    'The lamplighter has finished, sat down, and become part of the scenery.',
    'Owls report unusual token activity. Owls are not reliable sources.',
    'Late trade at the tavern. Currency: gossip. Exchange rate: awful.',
    'The stars are out over {town}, doing their usual **{pct}%** of nothing.',
    '{name} walks home the long way, past the fountain, as always.',
    'Night watch counts the buildings twice and gets **{b}** both times. Suspicious.',
    'A candle burns in an upstairs window. It has burned there as long as anyone recalls.',
    'Somebody is baking at this hour. The whole street knows and nobody minds.',
    'The moon over {town} is described by the night watch as "the usual one".',
    'A cat crosses the square with the air of a creature that owns it.',
    'Nothing is happening, in **{b}** separate buildings, very peacefully.',
    'The last lamp on the ring road belongs to nobody and is lit anyway.'
  ],
  /* ── day breaks ── */
  DAWN: [
    'Dawn over {town}. The Ledger is dusted, the day is priced.',
    'Shutters open on **{b}** houses. The economy stretches, cracks, begins.',
    'Morning bell. The first token of the day is greeted like a returning hero.',
    'Cocks crow. Clerks crow louder. The market opens on a rumour.',
    'Sunrise. {name} is already at the fountain, having never left.',
    'A new day in {town}, priced at whatever the last one cost, plus attitude.',
    'First cart of the morning. It is empty. It is early. It is trying.',
    'The baker has been up for hours and would like this widely known.',
    'Light on **{b}** roofs at once. Somebody should paint it. Nobody will.',
    'Dawn. The goat is already awake and already disappointed in everyone.'
  ],
  /* ── the tracker's window changed. Split, because "the archive opens and puts
        its feet up" is a WIDENING joke and it was being told when the user
        narrowed from all time down to one session. ── */
  RANGE: [
    'The council redefines "now". **{b}** buildings appear to have always been here.',
    'Surveyors re-measure {town} against {range}. It is bigger. It is smaller. It is fine.',
    'Time itself renegotiated. {town} now remembers exactly {range} and not a moment more.',
    'The scope of civic memory adjusted to {range}, by committee, by candlelight.',
    'Cartographers redraw the town for {range}. They ask, politely, that this stop.'
  ],
  RANGE_UP: [
    'Historians annex the whole archive into the town records. Chaos. Delight.',
    'The archive opens. {range} of history walks in and puts its feet up.',
    'Everything before {range} has been declared prehistory. Nobody objects.',
    '{town} adopts a new calendar covering {range}. The old one is used as kindling.',
    'The Ledger is reopened at an earlier page. Dust everywhere. **{tok}** total.',
    '{range} of tokens, all at once. The clerks require a moment alone.',
    'The town remembers further back today, and is quietly smug about it.'
  ],
  RANGE_DN: [
    'A shorter reckoning: {town} shrinks to what it did in {range} and feels lighter.',
    'The records are trimmed to {range}. Two clerks are trimmed with them.',
    'Civic memory shortened to {range}. The town insists this was always the plan.',
    'Everything but {range} is filed under Later. The drawer will not close.',
    'The Ledger is closed at an earlier page. **{tok}** stands, and stands alone.',
    'A smaller window, a tidier town. The archivists take the afternoon off.'
  ],
  /* ── how this window is going against the last one. The one comparison the
        user actually cares about, and until now the ticker never mentioned it. ── */
  VERSUS: [
    '**{tok}** so far. Last time the town had managed **{prev}**. The Ledger is keeping score.',
    'The Crier compares this window with the last and declines to say which is winning.',
    'A clerk chalks **{prev}** on one board and **{tok}** on the other, then hides.',
    'Bets are being taken on whether {town} beats **{prev}**. The odds are opinions.',
    'Last time: **{prev}**. This time: **{tok}**. The difference has been noted, twice.',
    'The Ledger keeps last window at **{prev}** for comparison. It is not being kind.',
    '{name} asks whether **{tok}** is good. Nobody will say until it passes **{prev}**.'
  ],
  /* ── pure absurd filler ── */
  CIVIC: [
    'The council meets. The council will meet about the meeting.',
    '{town} has **{breaks}** designated resting groves and one contested hedge.',
    'A goat has been elected to the planning committee. It abstains beautifully.',
    'The well is fine. This is the fourth consecutive report that the well is fine.',
    '{name} has written to the Crier. The letter is long. The point is not in it.',
    'Road maintenance completed. Roads unchanged. Budget spent. Everyone content.',
    'The tallest building is a **{grandest}**. It is very smug about it.',
    'Lost: one cart. Found: opinions about where the cart went.',
    '{town} twinned with a town nobody can locate on any map.',
    'The Crier\'s own wages remain a matter of lively public indifference.',
    'Statue vandalised with a smaller, better statue.',
    'Public consultation on the new bench concludes: the bench is a bench.',
    '{name} and {name} are not speaking. The town has picked sides. Both sides.',
    'Fire drill held. Nothing was on fire. Several things now are.',
    'The bakery\'s queue is longer than the market\'s. War is inevitable.',
    'A survey finds **{pct}%** of villagers approve of the town. The rest were asleep.',
    'Council votes to paint the door. Council votes on the colour for six weeks.',
    'A new bylaw forbids something nobody was doing. Compliance total.',
    'The town motto is revised to "Well, Quite". Everyone is happy with it.',
    'The lost property box now contains a hat, a boot, and a smaller box.',
    '{name} has been made responsible for the hedge and takes it very seriously.',
    'Signpost repainted by a volunteer. It is beautiful. It is wrong.',
    'The tallest thing in {town} is still the **{grandest}**, and it knows.',
    'A committee of **{pct}** meets to discuss committees. Refreshments provided.',
    'Somebody swept the whole square before anyone was up. No suspects. No charges.',
    'The bench has been moved four feet. Both factions claim victory.'
  ],
  /* ── the personal best falls ── */
  BEST: [
    '~Yesterday has been beaten and is taking it badly.',
    '**{tok}** — the record falls. Somebody update the stone. Again.',
    '{town} exceeds its own personal best. Modesty exceeded simultaneously.',
    'The previous record is escorted from the building.',
    '~The Ledger overwrites yesterday without ceremony or apology.'
  ],
  DAYSTART: [
    'A new page. {town} wakes with **{b}** buildings and no memory of the last one.',
    'The Ledger is turned to a clean page. It is a beautiful, terrifying page.',
    '~Midnight passed. The town was rebuilt from scratch. Nobody noticed. Nobody minds.',
    'Founding of {town}, again. Fourth time this week.',
    'The surveyors have been out since before light. {town} exists. Officially.'
  ],
  BOOT: [
    '{town}, population **{villagers}**, established at once, fully furnished.',
    'The town assembles itself out of the record. **{b}** buildings, no permits.',
    'Welcome to {town}. Everything here was paid for in tokens.'
  ],
  GROVE: [
    'Trees planted where nothing was spent. **{breaks}** groves and counting.',
    '{town} designates another grove. The goat approves for its own reasons.',
    'A break in the work becomes a stand of pines. Nobody planned this. It happened.',
    'The idle hours are now a small forest. Ecologists thrilled, economists less so.'
  ],
  /* ── redevelopment wave: the town gets RICHER, not wider ── */
  PROMO: [
    '**{n}** homes rebuilt grander overnight. The old ones are not mentioned.',
    'The frontier becomes downtown. Rents rise. Nobody knows who collects them.',
    'Renovation sweeps street by street. {name} has moved four times without leaving home.',
    '{town} gentrifies itself, apologetically, from the middle outward.',
    'A cottage went to bed and woke up a villa. Doctors are baffled and jealous.',
    'The tier survey is revised upward. The tallest is now a **{grandest}**.',
    'Scaffolds bloom across the inner streets like a rash of ambition.',
    'Old {town} is gone. New {town} is identical but taller and smugger.'
  ],
  /* ── the fountain is improved ──
     It is a fountain, so it never towers: every rung buys stonework, water,
     lanterns or flowers. The copy must not promise height it will not deliver. ── */
  TIERUP: [
    'They call it the **{tierName}** now. Nobody voted for this. Everybody approves.',
    'Tier **{tier}** attained. The masons are sent for. The masons were already coming.',
    'New stonework at the fountain, and the whole square came out to watch it set.',
    '**{tierName}**, the masons call it. It stands where a plainer one used to.',
    'The fountain is improved. The plaza is asked, politely, to make room.',
    'Tier **{tier}**. Scholars insist there is a limit. Scholars have been wrong before.',
    'The new basin is deeper by a hand. The baker has written a letter about it.',
    'The **{tierName}** is opened with a short speech and a long queue.'
  ],
  /* ── a crossing opens ── */
  BRIDGE: [
    'The bridge is open. **{pct}%** of the town crossed it immediately, for no reason.',
    'A bridge! {town} can now reach the bit of {town} it could already see.',
    'Bridge completed. Two banks, one town, endless jurisdictional confusion.',
    'The first cart across the new bridge was empty. Symbolism noted by all.',
    'Engineers pronounce the span "sound". Engineers cross it one at a time.',
    'The bridge has been named, unnamed, and named again, all before noon.',
    'Bridge-watchers appear overnight. Their duties are unclear and deeply felt.',
    'The river passes under the new bridge without acknowledging it.'
  ],
  /* ── v4 · the people. Every line here names a resident the user can actually
        go and find, so every line is gated on {who}: with no roster the whole
        pool is unusable() and the ticker reverts to exactly its v3 mix. ── */
  PEOPLE: [
    '{who}, {job} of {quarter}, has opened a second {place}. {who2} is not speaking to them.',
    '{who} and {who2} were seen on the bridge again. The town has chosen sides. Both sides.',
    '{who} the {job} predicts the total will double by supper. {who2} has bet a loaf against it.',
    '{who} has moved into the {home} on {quarter}. The neighbours are thrilled and lying.',
    '{who} was late to the square and blames the {place}. The Ledger does not take excuses.',
    '{who2} has not forgiven {who} for the business with the cart. Nobody remembers the cart.',
    'The {job} {who} has written to the Crier. The letter is long. The point is not in it.',
    '{who} claims to have counted every chimney in {town}. The count is disputed by {who2}.',
    '{who} of {quarter} reports sleeping badly. The Ledger was loud again.',
    '{who} and {who2} have agreed to disagree, loudly, in the street, for an hour.',
    '{who} left flowers at the fountain. {who2} left an itemised receipt.',
    '{who} says the town was better when it was smaller. {who} arrived on Tuesday.',
    '{who} has taken up the {job}\'s trade at forty. The other {job}s are being polite.',
    'A child of {who}\'s has learned to count to **{tok}**. Slowly, and out loud.',
    '{who} of {quarter} is described by {who2} as "a lot, lately". No further comment given.',
    '{who} has named a goose after the total. The goose is unimpressed and now famous.',
    '{who2} is {rel} to {who}. The distinction is observed daily and explained never.',
    'The {place} on {quarter} closes early. {who} blames the weather, the roof and {who2}.',
    '{who} the {job} has been counted twice in the census and intends to keep both.',
    'A {home} on {quarter} changes hands for an undisclosed number of tokens and one hen.',
    '{who} the {job} has invented a shortcut. It is longer. {who} is committed.',
    '{who} of {quarter} waves at everybody. {who2} has begun waving pre-emptively.',
    '{who} has been seen carrying a plank with intent. The town watches, hopeful.',
    '{who} tells {who2} the number. {who2} tells the whole of {quarter} by noon.',
    '{who} the {job} whistles the same eight notes daily. {quarter} knows them now.',
    '{who} has fixed the {place} roof. Badly. Warmly. It holds.',
    '{who2} claims to have met {who} before {who} arrived. Nobody is checking.'
  ],
  /* ── the protagonist's fortune rises. Celebratory; the town's story, not the
        user's report card. ── */
  HERO_UP: [
    '{who} the {job} is doing well. {who} would like everyone to know it.',
    '{who} has bought a second cart. The first cart is furious.',
    'Fortune smiles on {who} of {quarter}. Fortune is fickle and {who} knows it.',
    '{who} has hired help. The help is {who2}, who needed the work.',
    '**{fortune}**, the town has decided, is the word for {who} this week.',
    'The {place} now belongs to {who}. Nobody is sure when this was agreed.',
    '{who} has had the {home} on {quarter} repainted. Twice. In the same colour.'
  ],
  /* ── …and falls. Wry, never a complaint, never a verdict on anybody. ── */
  HERO_DN: [
    '{who} is having a quiet one. The tavern has extended credit, graciously, once.',
    '{who} the {job} has taken up fishing. The Ledger was not consulted.',
    '{who} sold the good cart and speaks of the bad cart with real affection.',
    '{who} says things are fine. {who2} agrees, at length, unprompted.',
    '**{fortune}**, they are calling it, in the fond way the town calls everything.',
    '{who} of {quarter} has begun a hobby. Nobody can establish what it is.'
  ],
  /* ── market day ── */
  MARKET: [
    'Market day in {town}. Everything costs a token and nothing costs less.',
    'Stalls up by seven. {who} has the good corner again. {who2} has written to the council.',
    // NO STALL COUNT. market.js raises 0/2/5/9 of them by village tier, and this
    // line used to say "four stalls" on every one of those days.
    'Market day: **{villagers}** villagers, a square full of trestles, one goat, no system.',
    'The market opens. Prices are set by shouting, as the charter requires.',
    'A cheese of unusual size has arrived at market. {who} is guarding it.',
    'Market day ends. The square is swept. The goat is not found.',
    'The {job} {who} sells out by noon and spends the afternoon being modest about it.',
    'Two stalls have merged into one argument. Trade continues around it.',
    'A turnip of no particular merit sells for **{pct}** tokens. Bidding was fierce.',
    '{who} is selling something under a cloth and will not say what.',
    'The market smells of bread, rope and other people\'s money.',
    'A child buys one apple with great ceremony. The stall applauds.',
    '{who2} has brought a scale. The market regards this as showing off.'
  ],
  /* ── the Crier on the Crier. Never names him: news.js is not told who he is,
        so these stay true whoever folk[0] turns out to be. ── */
  CRIER: [
    'The Crier\'s bell has been valued at **{tok}**. The Crier disagrees.',
    '{who} has asked the Crier to speak up. The Crier has asked {who} to stand closer.',
    'The Crier has lost his voice and continues at volume. The news is unaffected.',
    'The Crier is paid in bread and the goodwill of {town}. The bread is the reliable part.',
    '{who2} follows the Crier around repeating the headlines a beat late. This is now tradition.'
  ],
  /* ── v4 · the chronicle. The record falls (upward only — there is no line in
        this file for a record being lost, and none may be added). ── */
  RECORD: [
    'RECORD. **{tok}** in one day — the Stone is re-cut. The mason charges extra for long numbers.',
    'Best day ever recorded. The previous best, **{was}**, is escorted quietly out of the ledger.',
    'The Chronicle Stone gains a line. {name} claims to have felt it happen.',
    'A new high-water mark is chiselled. The old one is sanded off and sold as gravel.',
    'History revised at **{tok}**. The Recorder needs a bigger chisel and a smaller ego.',
    'The Stone is warm where the mason has been working. **{was}** is now merely historic.'
  ],
  RECORD_B: [
    'Largest township on record: **{b}** buildings. The map is redrawn on a second sheet.',
    'The survey has never had to count this far. **{b}** roofs, and a lie-down afterwards.',
    'A bigger town than any in the archive. The archive is taking it extremely well.',
    'Record township. **{was}** was the old mark; the surveyor has kept the old sheet, fondly.'
  ],
  /* ── an unbroken run. R3: this only ever reports a spell that EXISTS. ── */
  SPELL: [
    'Day **{spell}** of an unbroken spell. The bunting has been let out twice.',
    '{town} has not had a quiet day in **{spell}**. The orchards are starting to talk.',
    'The bunting reaches the far lamp. Council votes to buy more lamp.',
    'Longest spell on record equalled. Nobody can remember what a record is for.',
    '**{spell}** days running. The pennant-maker has moved into larger premises.'
  ],
  /* ── antiquarian ambient: the archive, the Stone, and yesterday's town out
        on the eastern road ── */
  CHRON: [
    'The Recorder is updating the almanac. It is mostly weather and one good number.',
    'Back-numbers of this paper are kept in the Stone. They are heavy and largely correct.',
    '{ghost} is visible on the eastern road today. It waves. We are fairly sure it waves.',
    'A rider from {ghost} brings news of **{prev}**. The rider is given soup.',
    'The archive holds **{days}** towns before this one. All of them insist they were the best.',
    'Cartographers add {town} to the kingdom map. They spell it wrong. It stays.',
    'The Recorder notes that yesterday happened. Motion carried.',
    'A quiet week is entered in the almanac as "restful". The orchards concur.',
    'The Stone reads **{best}** at the top. Nobody has asked it to explain itself.',
    'Someone asks what the Stone is for. The Recorder says "later". Nobody presses.',
    'Smoke on the eastern horizon: {ghost} is still standing, and still smug.',
    'The road east is walkable in a day, they say. Nobody has tried since the Stone went up.',
    '{name} proposes a museum. It would contain the Stone, which cannot be moved.',
    '**{days}** towns in the record and not one of them filed its paperwork.',
    'The almanac is bound in something. The Recorder would rather not say what.'
  ],
  /* ── the Overtaking. Fires ONCE, upward only, and has no counterpart. ── */
  OVERTAKE: [
    'OVERTAKEN. {ghost}\'s final tally passed at **{was}**. Bells, briefly.',
    '{town} is now ahead of {ghost}, which took until nightfall to manage **{was}**.',
    'The eastern horizon has been overtaken. Nine birds left the ghost town in disgust.',
    'The moment **{was}** was passed has been written down twice, in two different hands.',
    '{ghost} held **{was}**. {town} holds more. The Stone will hear about this.'
  ],
  /* ── the Register of Honours ── */
  BADGE: [
    '**{label}** is entered in the Register of Honours. The Register is mostly empty and very proud.',
    'The council awards **{label}**. There is no ceremony budget, so everyone claps twice.',
    '{name} pins **{label}** to the noticeboard. It falls off. It is pinned again, harder.',
    'Honour recorded: **{label}**. _{title}_',
    'A small brass plate now reads **{label}**. It will be polished by nobody, forever.',
    '**{label}**. The Registry notes this and, unusually, smiles.',
    'The Register gains **{label}** and immediately requires a second shelf.'
  ],
  /* ── only when opts.demo ── */
  DEMO: [
    '_The Crier notes this town is a simulation. It intends to keep reporting anyway._'
  ]
};

/** Archetype-gated ambient pools, keyed by plan.kind (§3.3 closed enum). */
const RAW_ARCH = {
  riverside: [
    'The river is up **{pct}%**. The ferryman charges the same and shrugs the same.',
    'Bridge toll abolished. Bridge toll reinstated. Bridge toll now called a "gift".',
    'The mill leat runs brown. The miller says this is normal. The miller says everything is normal.',
    'Flood watch posted. The river has never flooded. The watch is posted anyway.',
    'Both banks claim to be the real {town}. The bridge declines to comment.',
    'Fish counted: several. Fish caught: fewer. Fish discussed: endlessly.',
    'The ferryman Odd Bill has opinions about the new bridge. All of them are wet.',
    'Reeds cut along the south bank. Somebody will thatch something eventually.'
  ],
  hillring: [
    'Terrace three has slipped a foot downhill. Terrace four is delighted.',
    'The quarry yields stone, dust, and a persistent sense of grievance.',
    'Switchback road resurfaced. Carts still arrive sideways. Tradition upheld.',
    'Sheep counted at **{pct}** head. The sheep dispute the methodology.',
    'Drystone wall completed without mortar, permits, or a single kind word.',
    'Uphill neighbours look down on downhill neighbours. Geographically. Only geographically.',
    'The wind on the ridge is declared a public nuisance and a civic asset.',
    'A boulder has moved. Nobody saw it. Everybody has a theory.'
  ],
  crossroads: [
    'Traffic at the crossroads: two carts, one goat, and a lengthy misunderstanding.',
    'The toll house reopens. The toll is one token. Nobody has change.',
    'The inn is full. The inn has three rooms. Arithmetic is being avoided.',
    'A stranger arrives by the east road and orders soup in a foreign accent.',
    'Signpost repainted. It now points four ways, all of them convincingly.',
    'The north road is closed. The north road was never open. Progress.',
    'Merchants meet at the market square and immediately disagree about everything.',
    'Coaching schedule published. It is a work of fiction and everybody knows it.'
  ],
  ribbon: [
    'The valley narrows. The town narrows with it, politely.',
    'News travels the length of {town} in nine minutes, arriving improved.',
    'Terraced gardens declared "steep but characterful" by people who do not garden.',
    'The far end of the village claims the near end is putting on airs.',
    'One street, **{b}** opinions, and a very tired postman.',
    'Fog fills the valley by dusk. The town continues by feel.',
    '{name} walks the whole of {town} in an afternoon and calls it a pilgrimage.',
    'The valley wind carries smoke, gossip and the smell of somebody\'s supper.'
  ],
  lakeside: [
    'The lake is flat as a ledger. Something under it disagrees.',
    'Reed beds harvested. Three baskets, one boat, and a great deal of standing about.',
    'The shore has moved again. Cartographers now draw it in pencil.',
    'Fishing quota set at "some". Enforcement described as "gestural".',
    '{name} swears the lake was smaller last week. The lake is unavailable for comment.',
    'Orchards on the dry side report a good year, smugly, as always.',
    'Mist off the water by morning. The town appears to be floating and rather likes it.',
    'A boat has been named after the total. The boat is unimpressed.'
  ]
};

/** 5–9 words, spoken aloud, no numbers — a bubble is overheard, not read.
 *
 * THE COPY GATE BITES HARDEST HERE, and it did not used to. From 200 units up a
 * remark is chatter you fly over; in `--cam=stroll` the camera stands at eye
 * height two metres from the speaker, who is often facing it — so a bubble that
 * says "you", or that gives a bare order ("mind the step", "look at it GO"), is
 * a villager talking AT the user. Second person with the pronoun left out is
 * still second person. Every line below is therefore said ABOUT the world or
 * about the speaker, never to whoever is holding the camera; a line that wants
 * an imperative gets it in the third person ("somebody's fetching the good
 * bread"). Nothing here asks for a bigger number either — 'MORE! MORE! MORE!'
 * lived in `cheer` and is exactly the pressure the gate exists to keep out. */
const RAW_BUB = {
  stroll: [
    'Tokens again. Always tokens.', 'Rent\'s gone up. Obviously.',
    'Best road in {town}, this one.', 'They built another one overnight.',
    'My cousin lives out past the mill.', 'That total keeps climbing, apparently.',
    'Nobody tells me anything.', 'It\'s all going somewhere, I hear.',
    'The Ledger says otherwise.', 'Good spend today. Good spend.',
    'I liked it before the wall.', 'That\'s a lot of chimneys.',
    'There\'s a cart coming. There isn\'t.', 'Somebody\'s baking. I\'d know that smell.',
    'Where does it all go?', 'Another number, another neighbour.',
    'I\'m not paying that.', 'The goat\'s back.',
    'Someone\'s been counting again.', 'Lovely weather for accumulation.'
  ],
  // At the fountain. These are people loitering by the water, not a congregation:
  // the Coin they used to pray to does not exist any more. Nothing here asks for
  // a bigger number — 'Just one more zero. Please.' lived in this pool and is
  // exactly the pressure the copy gate exists to keep out.
  worship: [
    'Cold hands. Warm afternoon.', 'It\'s running well today.',
    'Best water in the county, this.', 'That step is slick as glass.',
    'I come here to think, mostly.', '…seven, carry the eight…',
    'Somebody\'s put flowers on it.', 'It talks, if nobody else does.',
    'My father sat on this rim.', 'It moved. The water. I saw it.',
    'The board\'s been read twice already.', 'Everyone ends up here eventually.',
    'Good place to wait for someone.', 'Quiet here. That\'s the point.'
  ],
  cheer: [
    'WE DID IT! What did we do?', 'AGAIN! It went up AGAIN!',
    'I said so! I said so first!', 'Hooray for the number!',
    'This is the best day ever.', 'I\'m going to cry. I am crying.',
    'Somebody\'s fetching the good bread!', 'And off it GOES!',
    'Somebody\'s waking the baker!', 'History! We\'re standing in it!',
    'That\'s my house! That one!', 'The bell! They\'re ringing everything!',
    'I have never been happier.', 'It\'s going on the stone!'
  ],
  night: [
    'Long day. Long total.', 'Lantern\'s low. So am I.',
    'Still lit up there, that window.', 'Bed. Then more tokens.',
    'It never stops, does it.', 'Night watch. Nothing. As usual.',
    'Someone\'s awake in the tower.', 'Quiet as a closed ledger.',
    'Dawn, then. Same as ever.', 'Fountain\'s still going.'
  ],
  build: [
    'That wasn\'t there this morning.', 'New neighbours. Already loud.',
    'Who signed off on this?', 'Nice roof. Terrible door.',
    'They\'re getting faster, aren\'t they.', 'That\'s my view gone.',
    'Fresh mortar. Smells like money.', 'I wanted that plot.',
    'They\'ll be made welcome. Eventually.', 'Another one! Where do they come from?'
  ],
  bridge: [
    'Deep today. Deeper than March.', 'I come here to think.',
    'Something went under. Big.', 'Best view in {town}.',
    'It goes all the way out, they say.', 'Nobody built this. It was here.',
    'Spitting and counting. Old game.', 'The water doesn\'t care.',
    'Halfway across is nowhere. I like it.', 'Ten more minutes. Then home.'
  ],
  /* v4 · said at a workplace, in a tavern, at a stall, or by somebody four feet tall */
  work: [
    'Back to it, I suppose.', 'Long shift. Long total.', 'Nearly done. Nearly.',
    'Whose turn is the counting?', 'Hands like bricks today.', 'One more, then bread.'
  ],
  tavern: [
    'Another. And one for {who2}.', 'Who\'s paying? Not me.',
    'They\'re singing the Ledger song again!',
    'I\'ve had two. Maybe four.', 'Last one. Definitely last one.', 'It goes on my tally.',
    'To the number! Whatever it is.'
  ],
  market: [
    'Two for a token. Fine, three.', 'Best price in {town}. Honest.',
    'That is not a cheese.', 'That wants weighing again. Slowly.', 'I\'ll take the lot.',
    'Half a token and I\'ll stop talking.'
  ],
  child: [
    'Is it a big number?', 'I can count to ten!', 'Dad says it goes up.',
    'Can I go in the fountain?', 'That house wasn\'t there!', 'I found a stick.',
    'I can do a trick!', 'Mum! MUM!', 'The dog\'s gone in the river.',
    'Why is everyone standing about?'
  ],
  /* the crier's own pool is a fallback only — town.js always passes opts.text.
     'Hear ye!' was the obvious line and it is literally second person plural. */
  crier: [
    'Oyez! The Ledger has moved.', 'By order of the Ledger!', 'News! Some of it new!'
  ]
};

/** Trade-flavoured work remarks, tried before the generic `work` pool when
    say() is handed a `job`. A baker who says "back to it, then" is furniture;
    a baker who says "flour's up again" is a person with a morning behind him.
    KEYED ON npcs.js's OWN `job` NOUNS — bare, singular, lowercase, straight out
    of its TRADES table. They used to be capitalised titles from a vocabulary
    npcs has never used, so `JOB[job]` could not match anything and the whole
    table was unreachable; four of the trades in it (a wizard's apprentice, a
    star-clerk, an acolyte, a gatewarden) were staff of the fantasy landmark set
    AESTHETIC.md retired, and are gone with it. */
const RAW_JOB = {
  baker: ['Oven\'s been on since four.', 'Six dozen loaves. Six.', 'Flour\'s up again.'],
  smith: ['The anvil sang this morning.', 'Nails. It\'s always nails.', 'Sparks everywhere. As usual.'],
  miller: ['Wind\'s in the wrong quarter.', 'The stones want dressing.'],
  brewer: ['Two days yet. It\'ll keep.', 'The mash is sulking again.'],
  mason: ['That course is out by a thumb.', 'Good stone. Bad weather for it.'],
  thatcher: ['Another roof, another winter.', 'Reeds are short this year.'],
  carter: ['A cart coming through! …there isn\'t.', 'Loaded twice, paid once.'],
  cooper: ['Hoops on before dinner. Maybe.', 'That stave\'s green. It\'ll tell on me.'],
  potter: ['Kiln\'s up. Nobody dares breathe.', 'Three cracked. Two will do.'],
  weaver: ['Warp\'s tight. Too tight.', 'Six ells since light.'],
  fisher: ['Nothing running this morning.', 'The river keeps its own ledger.'],
  shepherd: ['Counted them twice. Twice.', 'One short. There\'s always one short.'],
  reckoner: ['Column four does not balance.', 'Ink everywhere. Again.'],
  scribe: ['A fair hand costs extra.', 'That word was spelled right yesterday.'],
  warden: ['Nothing to report. As usual.', 'Quiet watch. Long watch.'],
  reeve: ['The council will discuss it. Eventually.', 'Motion carried. Nobody moved.'],
  physician: ['Rest and broth. That is the whole of it.', 'It\'s the damp. It\'s always the damp.'],
  carpenter: ['Measured twice. Cut once. Mostly.', 'Green timber. Somebody\'s idea of thrift.'],
  ostler: ['The grey one bites. Fair warning.', 'Fresh straw by noon.'],
  gardener: ['Frost took the early rows.', 'The pears know something we don\'t.']
};

/* ═══ corpus compilation ════════════════════════════════════════
   Done once at module load: strip the `~` day marker, pre-convert the bold/italic
   markup to HTML, and pre-scan each line for its {slots}. A swap is then one
   .replace() over a pre-built string, ~200 ns. */

const SLOT_RE = /\{(\w+)\}/g;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const markup = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/_(.+?)_/g, '<i>$1</i>');

/** The same line with the emphasis markers taken out — what headline().plain and
    the Crier's shout are built from, so neither has to un-parse HTML. */
const plainOf = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1');

function compile(lines) {
  const n = lines.length;
  const c = { n, text: new Array(n), html: new Array(n), plain: new Array(n),
    slots: new Array(n), day: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    let t = lines[i];
    if (t.charCodeAt(0) === 126) { c.day[i] = 1; t = t.slice(1); }   // '~'
    c.text[i] = t;
    // markup escapes first, so a slot value substituted later can never open a tag
    c.html[i] = markup(t);
    c.plain[i] = plainOf(t);
    const s = []; let m;
    SLOT_RE.lastIndex = 0;
    while ((m = SLOT_RE.exec(t))) if (s.indexOf(m[1]) < 0) s.push(m[1]);
    c.slots[i] = s;
  }
  return c;
}

const CORPUS = {};
for (const k in RAW) CORPUS[k] = compile(RAW[k]);
const ARCH = {};
for (const k in RAW_ARCH) ARCH[k] = compile(RAW_ARCH[k]);
const BUB = {};
for (const k in RAW_BUB) BUB[k] = compile(RAW_BUB[k]);
const JOB = {};
for (const k in RAW_JOB) JOB[k] = compile(RAW_JOB[k]);

/** Dense category ids — the anti-repeat ring stores (id·1024 + line), collision-free. */
const CAT_ID = {}; { let i = 1; for (const k in CORPUS) CAT_ID[k] = i++; CAT_ID.ARCH = i++; }

/** The frozen corpus, for tests (grep it for model names — there are none). */
export const NEWS_CORPUS = (() => {
  const out = { FOLK: Object.freeze(FOLK.slice()), ARCH: {}, BUB: {}, JOB: {} };
  for (const k in CORPUS) out[k] = Object.freeze(CORPUS[k].text.slice());
  for (const k in ARCH) out.ARCH[k] = Object.freeze(ARCH[k].text.slice());
  for (const k in BUB) out.BUB[k] = Object.freeze(BUB[k].text.slice());
  for (const k in JOB) out.JOB[k] = Object.freeze(JOB[k].text.slice());
  Object.freeze(out.ARCH); Object.freeze(out.BUB); Object.freeze(out.JOB);
  return Object.freeze(out);
})();

/* ═══ fallback stylesheet ═══════════════════════════════════════
   index.html is core's file and carries the real rules. This sheet is PREPENDED to
   <head>, so anything core defines wins on document order — it only fills in when the
   page has not been updated yet, and it is where the crier's own hover history lives
   (class names core never uses). Base state is the FINAL state, always. */
const CSS = `
#news{flex:none; position:relative; display:flex; align-items:center; gap:14px;
  padding:9px 18px 10px; min-height:48px; overflow:hidden; white-space:nowrap;
  border-bottom:1px solid var(--hairline);
  box-shadow:inset 0 -3px 0 -2px rgba(217,164,65,.28);
  background:linear-gradient(90deg,rgba(217,164,65,.10),rgba(217,164,65,0) 38%),
    linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.012))}
#news:before{content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:linear-gradient(180deg,#F3D07A,#B99248 55%,#6E5526); opacity:.9}
#news .mast{flex:none; align-self:stretch; display:flex; align-items:center;
  font:700 12.5px/1 Georgia,"Times New Roman",serif; letter-spacing:.17em;
  color:#C99B4A; text-transform:uppercase;
  border-right:1px solid rgba(217,164,65,.30); padding-right:14px}
#news .line{flex:1 1 auto; min-width:0; opacity:1; transform:none;
  font:italic 400 17px/1.32 Georgia,"Times New Roman",serif; color:#EFEADA;
  overflow:hidden; text-overflow:ellipsis}
#news .line.swap{animation:newsSwap .42s ease-out}
/* never from zero — see the newsIn note in index.html: at ~1 fps a capture that
   lands inside the fade shows an empty news bar */
@keyframes newsSwap{from{opacity:.4; transform:translateY(6px)} to{opacity:1; transform:none}}
#news .line b{color:#F3D07A; font-style:normal; font-weight:700; font-variant-numeric:tabular-nums}
#news .line i{color:#B4AF9F; font-style:normal}
#news.hot{box-shadow:inset 0 -3px 0 -2px rgba(243,208,122,.72)}
#news.hot .mast{color:#F3D07A; text-shadow:0 0 16px rgba(243,208,122,.5)}
/* --bg is the pill's own colour and every kind below re-states only that: the
   tail is a border triangle, so it has to be able to read the same value from
   whichever end of the bubble it is drawn at. */
.bub{--bg:rgba(24,24,22,.90);
  position:absolute; transform:translate(-50%,-100%); pointer-events:none;
  max-width:190px; padding:5px 9px 6px; border-radius:11px;
  background:var(--bg); border:1px solid rgba(255,255,255,.18);
  color:#EDEBE0; font:500 11.5px/1.32 "Segoe UI",system-ui; text-align:center;
  text-shadow:0 1px 2px rgba(0,0,0,.7); opacity:1}
/* tail + leader. A dark pill floating over a roof with no stem is not speech —
   you cannot tell who said it. The stem points at the villager.
   --nub is how far the tail sits from the box's own centre. place() slides the
   BOX sideways to keep it inside the frame and moves the tail the other way by
   the same pixels, so a remark from somebody standing at the edge of the picture
   is still whole AND still plainly theirs. */
.bub:after{content:''; position:absolute; left:calc(50% + var(--nub,0px)); bottom:-7px;
  margin-left:-6px; width:0; height:0; border:6px solid transparent; border-top-color:var(--bg)}
/* The stem grows with camera distance (--stem, set in place()): when the
   speaker is a 2-px dot the line has further to travel, and it ends in a small
   bright ring so the eye has something to land on down there. Without the ring
   the leader just faded into grass and the bubble read as a system toast. */
.bub:before{content:''; position:absolute; left:calc(50% + var(--nub,0px)); top:100%;
  margin-left:-1px; width:2px; height:var(--stem,14px);
  background:linear-gradient(rgba(255,255,255,.52), rgba(255,255,255,.06));
  box-shadow:0 0 0 .5px rgba(0,0,0,.45)}
.bub .anchor{position:absolute; left:calc(50% + var(--nub,0px)); width:7px; height:7px;
  margin-left:-3.5px; top:calc(100% + var(--stem,14px) - 3px); border-radius:50%;
  border:1.5px solid rgba(255,255,255,.85); box-shadow:0 0 3px rgba(0,0,0,.8)}
/* UNDER — the remark hangs BELOW its speaker and the tail turns over to point
   back up at them. A bubble grows out of a villager's head, and for anybody
   standing on the square that is exactly where the fountain's counter is: the
   one number the whole app exists to show. Turning the remark over clears it. */
.bub.under{transform:translate(-50%,0)}
.bub.under:after{bottom:auto; top:-7px; border-top-color:transparent; border-bottom-color:var(--bg)}
.bub.under:before{top:auto; bottom:100%}
.bub.under .anchor{top:auto; bottom:calc(100% + var(--stem,14px) - 3px)}
.bub.pop{animation:bubPop .30s cubic-bezier(.2,1.5,.4,1)}
/* scale, not transform: the transform is what says which way up the bubble is,
   and a keyframe that wrote it would flip an under remark back over for the
   length of the pop. Base state is still the final state. */
@keyframes bubPop{from{opacity:.45; scale:.72} to{opacity:1; scale:1}}
.bub.worship{--bg:rgba(40,32,14,.90); border-color:rgba(243,208,122,.34); color:#F3D07A}
.bub.cheer{--bg:rgba(46,26,12,.92); border-color:rgba(243,208,122,.45)}
.bub.night{--bg:rgba(14,18,30,.90); border-color:rgba(150,180,255,.20); color:#D3DCEF}
.bub.bridge{--bg:rgba(16,28,30,.90); border-color:rgba(140,200,205,.22); color:#DCEBEC}
/* the nameplate. A remark with a name over it is a PERSON talking; without one it
   is the town muttering. Opaque at rest like everything else in this file, and
   capped at one live plate — two named bubbles read as a comic strip. */
.bub .who{display:block; font:700 9.5px/1.3 "Segoe UI",system-ui; letter-spacing:.07em;
  text-transform:uppercase; color:#D9A441; margin-bottom:2px; opacity:.95}
.bub .say{display:block}
.bub.crier{max-width:270px; --bg:rgba(52,40,20,.94); border-color:rgba(243,208,122,.55)}
.bub.crier .who:before{content:'❖ '}
.bub.child{--bg:rgba(22,30,24,.90); border-color:rgba(180,220,180,.22); color:#DFEBDD}
.bub.tavern{--bg:rgba(40,26,14,.92); border-color:rgba(226,160,90,.34)}
.bub.market{--bg:rgba(34,30,16,.91); border-color:rgba(214,196,120,.28)}
.bub.work{--bg:rgba(28,26,24,.91); border-color:rgba(255,255,255,.16)}
/* --shot-ui=0 promises no chrome at all and a speech bubble is chrome: photo
   mode has always taken #overlay away with the rest of it. interact.js owns the
   class; say() simply stands down while it is on, and this rule is the backstop
   for a remark that was already in the air when it landed. */
body.noui .bub{display:none !important}
/* the crier's back numbers: a milestone missed twenty minutes ago, recovered */
.newsHist{position:fixed; z-index:7; display:none; pointer-events:none; max-width:min(72vw,720px);
  background:rgba(16,16,15,.96); border:1px solid rgba(255,255,255,.18); border-radius:6px;
  padding:7px 10px; font-size:11px; color:#C3C2B7; line-height:1.55;
  box-shadow:0 8px 26px rgba(0,0,0,.55)}
.newsHist div{white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.newsHist div:first-child{color:#EDEBE0}
.newsHist b{color:#EDEBE0; font-weight:600; font-variant-numeric:tabular-nums}
.newsHist i{color:#898781; font-style:normal}
.newsHist .hd{color:#D9A441; font-size:9.5px; font-weight:700; letter-spacing:.09em;
  text-transform:uppercase; margin-bottom:3px}
`;
function ensureCss() {
  if (document.getElementById('newsBaseCss')) return;
  const st = document.createElement('style');
  st.id = 'newsBaseCss'; st.textContent = CSS;
  const h = document.head || document.documentElement;
  h.insertBefore(st, h.firstChild);   // core's own sheet, later in the doc, always wins
}

/* ═══ the crier ═════════════════════════════════════════════════ */

const MAX_BUB = 4;          // four remarks is a conversation; eight is a riot
const MAX_PER_KIND = 2;
// Two at eye level, three from the air. It used to be a flat 2 because "three
// start colliding" — but that was guesswork against a fixed 200 × 46 px box.
// Collision is now measured off the elements themselves, and from 200 units up a
// bubble is ~110 px wide, so three of them genuinely fit.
const liveCapFor = camH => camH > 34 ? 3 : 2;
// EARSHOT, and it is DELIBERATELY not shortened at street level. The obvious
// street-level tuning is a street's length — 46 units, since at 1.35 m the far
// side of town is behind three rows of roofs — and it is wrong twice over.
// First, a flat gate is exactly the v3 mistake this line was written to undo:
// the sampler picks a villager from the WHOLE roster, so a tight radius rejects
// most of them and the town falls silent (measured: 16 of 22 offers dropped in
// twenty seconds on foot, one bubble in the whole run). Second, it is now
// redundant — the sight test rejects the ones actually behind a roof, on
// evidence rather than on a radius, and a speaker at the far end of an open
// street SHOULD be able to call out. Distance is answered by size, not silence.
const earshot2For = camDist => { const r = Math.max(170, camDist * .95 + 60); return r * r; };
// A remark holds longer on foot. Fewer speakers are in frame at eye level and
// each one is the only thing being said, so a 3.2 s aside leaves the street mute
// between pulls; from the air there are four conversations to look at.
const ttlFor = (len, camH) => clamp(2600 + len * 46, 3200, 5200) * (camH < 8 ? 1.5 : 1);
const RING_N = 26;          // ≈ 3 minutes of headlines before a repeat is possible
const URGENT_GAP = 900;     // matches the milestone queue cadence, so crier and fireworks stay in step
// A beat longer than v5's 6.2–9.0 s. The headline is 17 px italic serif now, not
// 12.5 px sans — it is a thing you look UP at and read, and the two-beat WIRE
// items put the joke in the last four words, so a swap that lands a shade early
// takes the punchline with it. Still comfortably under the ten seconds at which
// a ticker starts reading as frozen.
const dwellFor = txt => clamp(2900 + txt.length * 64, 6800, 9600);

/* ── how big a remark is ────────────────────────────────────────
   v4 sized a bubble on a LINEAR ramp off camera distance — 13.5 px falling by
   .011 px per unit, floored at 8.5. That was tuned at one framing and it is flat
   everywhere else: a speaker at 2 m and a speaker at 200 m came out 13.5 px and
   11.3 px, two sizes the eye cannot tell apart. What the eye actually reads is
   ANGULAR size, so that is what drives it now: `headPx` is how many pixels tall
   the villager himself is, and the font follows it logarithmically (a person
   sixty times taller on screen gets a font two and a half times bigger).
     8 px person → 10.6 px font   ·  a market town from orbit
    57 px person → 15.4 px font   ·  across the square on foot
   240 px person → 19.0 px font   ·  two metres away
   The leader stem runs the OTHER way — it exists to reach down to a speaker too
   small to see, so it shrinks to nothing as they fill the frame — and the bright
   anchor ring is dropped entirely once the speaker is plainly visible. */
const HEAD_M = 1.75;        // a villager, head to heel, in world units
const fontFor = headPx => Math.round(clamp(5.3 + 2.5 * Math.log(headPx), 9, 19.5) * 2) / 2;
const stemFor = headPx => Math.round(clamp(64 / Math.pow(headPx, .55), 5, 34));
const widthFor = (fs, kind, rw) =>   // the crier reads a whole sentence off the ticker
  Math.round(Math.min(fs * (kind === 'crier' ? 21 : 15), Math.max(150, rw * .42)));

/* ═══ the sight test ════════════════════════════════════════════
   A bubble is a DOM element over the canvas: it has no depth, so nothing stops
   it drawing over the cottage its speaker is standing behind. From 200 units up
   that was a blemish carried in the handoff notes since v4. At eye height it is
   the whole illusion, so it is an occlusion query now — screen space, like the
   two rejections that were already here, just against geometry.

   Built from what ctx already carries for npcs: every building's position and
   hTop. Each becomes an upright cylinder, and the eye→speaker segment is tested
   against them. Cost control, in order of how much it saves:

     1. THE ROOF PLANE. The eye is usually far above every roof, so the segment
        cannot touch anything until it descends below the tallest one. Starting
        the march there turns a 225-unit orbit ray into a ~6-unit walk.
     2. A UNIFORM GRID, DDA-marched, so only the cells the ray really crosses are
        opened. A building is linked into every cell its footprint touches.
     3. A STAMP, so a building spanning two cells is tested once per query.
     4. The callers throttle: a live bubble re-tests at ~7 Hz, not per frame.

   Zero geometry, zero draw calls, no allocation after the grid is built. */
// Three development switches, all OFF in the shipped file. `DIAG` counts why
// remarks were refused and prints DG to the console; `PROBE` parks a permanent
// test bubble behind the nearest wall with somebody behind it; `PROBE_BYPASS`
// turns the sight test OFF so the probe can show what it used to look like.
// Flip PROBE and PROBE_BYPASS together to reproduce the before/after by eye.
const DIAG = false;
const PROBE = false;
const PROBE_BYPASS = false;
const DG = { calls:0, pool:0, far:0, screen:0, board:0, coll:0, occ:0, ok:0, sightMs:0, sightN:0, stepMs:0, stepN:0, camH:0, camD:0, bld:0 };
if (typeof window !== 'undefined') window.__newsDiag = DG;
const SIGHT_CELL = 16;
/** Footprint radius. town.js grounds a building with `1.55·span + .10·hTop`, so
    that is the formula. `span` is not on the ctx row today and is inferred from
    height — the three sizes separate cleanly, because a chapel is tall AND wide. */
const spanOf = h => h > 11 ? 3 : h > 8 ? 2 : 1;

function makeSight() {
  let cap = 0, linkCap = 0, cellCap = 0;
  let bx = null, bz = null, br = null, by0 = null, by1 = null, stamp = null;
  let head = null, next = null, item = null;
  let n = 0, gnx = 0, gnz = 0, cell = SIGHT_CELL, minX = 0, minZ = 0;
  let maxTop = 0, ground = 0, tick = 0;

  function rebuild(rows) {
    n = 0; maxTop = 0;
    const m0 = rows ? rows.length : 0;
    if (!m0) return;
    if (m0 > cap) {
      cap = Math.max(128, m0 + (m0 >> 1));
      bx = new Float32Array(cap); bz = new Float32Array(cap); br = new Float32Array(cap);
      by0 = new Float32Array(cap); by1 = new Float32Array(cap); stamp = new Int32Array(cap);
    }
    stamp.fill(0); tick = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity, gy = 0, m = 0;
    for (let i = 0; i < m0; i++) {
      const e = rows[i], p = e && e.pos;
      if (!p) continue;
      const h = e.hTop > 0 ? e.hTop : 3.5;
      const r = 1.55 * (e.span > 0 ? e.span : spanOf(h)) + .10 * h;
      bx[m] = p.x; bz[m] = p.z; br[m] = r;
      // The base runs a little UNDER the ground it stands on, so a villager
      // downhill of a cottage is never seen through the gap beneath its sill.
      by0[m] = p.y - 2.5; by1[m] = p.y + h;
      if (p.x - r < x0) x0 = p.x - r;
      if (p.x + r > x1) x1 = p.x + r;
      if (p.z - r < z0) z0 = p.z - r;
      if (p.z + r > z1) z1 = p.z + r;
      if (by1[m] > top) top = by1[m];
      gy += p.y; m++;
    }
    n = m;
    if (!m) return;
    ground = gy / m; maxTop = top; minX = x0; minZ = z0;
    const w = Math.max(x1 - x0, 1), d = Math.max(z1 - z0, 1);
    cell = Math.max(SIGHT_CELL, Math.max(w, d) / 160);
    gnx = Math.max(1, Math.min(192, Math.ceil(w / cell)));
    gnz = Math.max(1, Math.min(192, Math.ceil(d / cell)));
    const need = gnx * gnz;
    if (need > cellCap) { cellCap = need; head = new Int32Array(cellCap); }
    head.fill(-1, 0, need);
    const links = m * 4 + 8;          // cell >= 16 and r <= ~6 ⇒ at most 2 × 2
    if (links > linkCap) { linkCap = links; next = new Int32Array(linkCap); item = new Int32Array(linkCap); }
    let li = 0;
    for (let i = 0; i < m; i++) {
      const r = br[i];
      let a = Math.floor((bx[i] - r - minX) / cell), b = Math.floor((bx[i] + r - minX) / cell);
      let c = Math.floor((bz[i] - r - minZ) / cell), e = Math.floor((bz[i] + r - minZ) / cell);
      if (a < 0) a = 0; if (c < 0) c = 0;
      if (b >= gnx) b = gnx - 1; if (e >= gnz) e = gnz - 1;
      for (let z = c; z <= e; z++) for (let x = a; x <= b; x++) {
        if (li >= linkCap) return;
        const k = z * gnx + x;
        item[li] = i; next[li] = head[k]; head[k] = li; li++;
      }
    }
  }

  /** Segment vs the upright cylinders linked into one cell. */
  function hitCell(k, fx, fy, fz, dx, dy, dz, a2, t0, t1, tx, tz) {
    for (let li = head[k]; li >= 0; li = next[li]) {
      const i = item[li];
      if (stamp[i] === tick) continue;
      stamp[i] = tick;
      const r = br[i], ox = fx - bx[i], oz = fz - bz[i];
      const cc = ox * ox + oz * oz - r * r;
      if (cc <= 0) continue;                        // the EYE is inside this footprint
      const qx = tx - bx[i], qz = tz - bz[i];
      if (qx * qx + qz * qz <= r * r) continue;     // …or the SPEAKER is
      const b = 2 * (ox * dx + oz * dz);
      const disc = b * b - 4 * a2 * cc;
      if (disc <= 0) continue;
      const s = Math.sqrt(disc), inv = .5 / a2;
      let ta = (-b - s) * inv, tb = (-b + s) * inv;
      if (tb <= t0 || ta >= t1) continue;
      if (ta < t0) ta = t0;
      if (tb > t1) tb = t1;
      // y is monotonic along the segment, so the solid is entered iff the y range
      // over [ta,tb] overlaps [base, top]. This is what keeps the test honest
      // from the air: at 200 units up the ray clears every roof until the last
      // few metres, exactly as the eye does.
      const ya = fy + dy * ta, yb = fy + dy * tb;
      const lo = ya < yb ? ya : yb, hi = ya < yb ? yb : ya;
      if (hi < by0[i] || lo > by1[i]) continue;
      return true;
    }
    return false;
  }

  /** @returns {boolean} true if a building stands between the eye and the anchor. */
  function blocked(fx, fy, fz, tx, ty, tz) {
    if (!n) return false;
    const dx = tx - fx, dy = ty - fy, dz = tz - fz;
    const a2 = dx * dx + dz * dz;
    if (a2 < 1e-4) return false;
    let t0 = 0;
    if (fy > maxTop) {
      if (dy > -1e-4) return false;                 // above every roof, level or rising
      t0 = (maxTop - fy) / dy;
      if (t0 >= 1) return false;
    }
    // Never let a speaker's OWN wall occlude them: the last 1.1 units are theirs.
    const len = Math.sqrt(a2 + dy * dy);
    const t1 = 1 - 1.1 / Math.max(len, 1.2);
    if (t1 <= t0) return false;
    tick++;
    const ax = fx + dx * t0, az = fz + dz * t0;
    const ex = fx + dx * t1, ez = fz + dz * t1;
    let cx = Math.floor((ax - minX) / cell), cz = Math.floor((az - minZ) / cell);
    const ecx = Math.floor((ex - minX) / cell), ecz = Math.floor((ez - minZ) / cell);
    const rx = ex - ax, rz = ez - az;
    const sx = rx > 0 ? 1 : -1, sz = rz > 0 ? 1 : -1;
    const ax_ = Math.abs(rx), az_ = Math.abs(rz);
    const dtx = ax_ > 1e-6 ? cell / ax_ : Infinity;
    const dtz = az_ > 1e-6 ? cell / az_ : Infinity;
    let ntx = ax_ > 1e-6 ? (rx > 0 ? (cx + 1) * cell + minX - ax : ax - (cx * cell + minX)) / ax_ : Infinity;
    let ntz = az_ > 1e-6 ? (rz > 0 ? (cz + 1) * cell + minZ - az : az - (cz * cell + minZ)) / az_ : Infinity;
    for (let g = 0; g < 160; g++) {
      if (cx >= 0 && cx < gnx && cz >= 0 && cz < gnz
        && hitCell(cz * gnx + cx, fx, fy, fz, dx, dy, dz, a2, t0, t1, tx, tz)) return true;
      if (cx === ecx && cz === ecz) break;
      if (ntx < ntz) { cx += sx; ntx += dtx; } else { cz += sz; ntz += dtz; }
    }
    return false;
  }

  return { rebuild, blocked, get n() { return n; }, get ground() { return ground; } };
}

/** Event type → corpus category. Unknown types fall through and are ignored. */
const CAT_OF = {
  boot: 'BOOT', dayStart: 'DAYSTART', rangeChanged: 'RANGE', milestone: 'MILESTONE',
  landmark: 'LANDMARK', best: 'BEST', tierUp: 'TIERUP', buildingsAdded: 'BUILD',
  promotion: 'PROMO', grove: 'GROVE', idle: 'SLOW', nightfall: 'NIGHT',
  daybreak: 'DAWN', bridge: 'BRIDGE',
  // v4 · people, chronicle, honours. Unknown until the module that fires them
  // lands; post() ignores a type it cannot place, so wiring order does not matter.
  gossip: 'PEOPLE', marketOpen: 'MARKET', marketClose: 'MARKET',
  record: 'RECORD', overtake: 'OVERTAKE', spell: 'SPELL', chronicle: 'CHRON',
  badge: 'BADGE'
};
const URGENT = { boot: 1, dayStart: 1, rangeChanged: 1, milestone: 1, landmark: 1, best: 1,
  record: 1, overtake: 1, badge: 1, fortune: 1, marketOpen: 1 };
/** Swallowed while the launch cascade is running: the single `boot` tells the story. */
const CASCADE_MUTE = { buildingsAdded: 1, tierUp: 1, promotion: 1, landmark: 1 };
/** Slots whose zero/empty value would make a line a lie. Every v4 slot is in here,
    which is the whole degradation story: with no roster and no chronicle every new
    line is unusable() and the ticker is exactly what it was in v3. */
const NEEDS = {
  landmark: 1, grandest: 1, label: 1, title: 1, tierName: 1, order: 1,
  b: 1, villagers: 1, breaks: 1, n: 1, tok: 1, minutes: 1, pace: 1, prev: 1,
  who: 1, who2: 1, job: 1, place: 1, home: 1, quarter: 1, fortune: 1, rel: 1,
  best: 1, spell: 1, ghost: 1, days: 1, was: 1
};
/** The cast kinds npcs.cast() understands (§4.4 closed enum), by category. */
const CAST_OF = { PEOPLE: 'gossip', MARKET: 'gossip', CRIER: 'gossip',
  HERO_UP: 'fortune', HERO_DN: 'fortune' };

/**
 * @typedef {Object} NewsOpts
 * @property {HTMLElement} bar     #news   @property {HTMLElement} mast  #newsMast
 * @property {HTMLElement} line    #newsLine
 * @property {HTMLElement} overlay #overlay — the 4 pooled bubble divs are appended here
 * @property {HTMLCanvasElement} canvas   projection rect source
 * @property {number} seed         ctx.planSeed → town name + line shuffle
 * @property {string} archetype    plan.kind — gates archetype-specific copy
 * @property {boolean} [demo]
 * @property {()=>Array<{w:number,text:string}>} [country]   environs.news + weather.news, mixed into ambient
 * @property {()=>string} [nameOf]   a live resident for {name}; '' ⇒ fall back to FOLK
 * @property {(kind:string, out:object)=>boolean} [cast]     fills {who}/{who2}/{job}/…
 */
/**
 * @typedef {Object} NewsFacts   allocated once, mutated in town.js's 500 ms stats timer
 * @property {number} tok @property {string} tokStr @property {number} buildings
 * @property {number} villagers @property {number} breaks @property {string} grandest
 * @property {string} landmark @property {string} rangeLabel @property {number} perMin
 * @property {number} paceRatio @property {number} tier @property {number} night
 * @property {boolean} cascading @property {number} milestones @property {string} tierName
 * @property {string} prevStr    previous window's total; '' ⇒ VERSUS never fires
 * @property {string} ghost      yesterday's town name; '' ⇒ CHRON's ghost lines never fire
 * @property {string} bestStr    the Stone's top line, formatted like tokStr
 * @property {number} days       towns in the archive before this one
 * @property {number} spell      length of the current unbroken run, 0 when there is none
 */
/**
 * @typedef {Object} News
 * @property {string} townName        read-only, regenerated by reset()
 * @property {NewsFacts} facts        MUTABLE — mutate in place, NEVER reassign
 * @property {(type:string, data?:object)=>void} post   never throws on an unknown type
 * @property {(v:THREE.Vector3, kind:string, opts?:{text?:string, ttl?:number, who?:string, job?:string})=>boolean} say
 * @property {()=>{html:string, plain:string, cat:string}} headline
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update
 * @property {(seed:number, archetype:string)=>void} reset
 * @property {()=>void} dispose
 */

/**
 * Build the crier. Writes its first headline SYNCHRONOUSLY, so frame 1 already has copy.
 * @param {NewsOpts} opts
 * @returns {News}
 */
export function initNews(opts) {
  const o = opts || {};
  ensureCss();

  /* ── DOM. Core owns the row; we only fill the container it hands us. ── */
  const bar = o.bar || null;
  let mast = o.mast || null, line = o.line || null;
  if (bar && !mast) { mast = document.createElement('span'); mast.className = 'mast'; bar.appendChild(mast); }
  if (bar && !line) { line = document.createElement('span'); line.className = 'line'; bar.appendChild(line); }
  const overlay = o.overlay || null;
  const canvas = o.canvas || null;

  let seed = (o.seed >>> 0) || 1;
  let archetype = o.archetype || '';
  const demo = !!o.demo;
  const country = typeof o.country === 'function' ? o.country : null;
  // Both optional and both null-checked at every use: this is the whole reason
  // news.js and npcs.js can be written in parallel (§4.5).
  const nameOf = typeof o.nameOf === 'function' ? o.nameOf : null;
  const castOf = typeof o.cast === 'function' ? o.cast : null;

  let townName = townNameFor(seed);
  let rnd = stream(seed ^ 0x5bf03635);

  /** @type {NewsFacts} — allocated ONCE; town.js mutates it in place. */
  const facts = {
    tok: 0, tokStr: '0', buildings: 0, villagers: 0, breaks: 0, grandest: '',
    landmark: '', rangeLabel: 'today', perMin: 0, paceRatio: 1, tier: 0, night: 0,
    cascading: false, milestones: 0, tierName: '',
    // the previous window's total, so the gazette can read the same dashboard the
    // user is reading. Empty string ⇒ VERSUS never fires.
    prevStr: '',
    // v4 · the chronicle's four facts. All zero/'' until town.js's stats tick has a
    // chronicle to read, and every line that needs one is unusable() until then.
    ghost: '', bestStr: '', days: 0, spell: 0
  };

  /* ── per-frame ctx cache (read-only; refreshed in update) ── */
  let cam = null, band = -1, rangeIsDay = true, intro = 1, nightNow = 0, paceNow = 1;

  /* ── rotation state ── */
  const ring = new Int32Array(RING_N).fill(-1);
  let ringI = 0;
  const cursors = Object.create(null);
  let nextAt = 0, hotUntil = 0, lastUrgentAt = -1e9, idleSinceMs = 0;
  const history = [];                       // last 5 rendered headlines (html)
  let histEl = null, histShown = false;

  /* ── the event queues. Fixed pools: post() never allocates. ── */
  const mkItem = () => ({ used: false, cat: '', urgent: false, hold: 0,
    n: 0, label: '', title: '', tok: '', order: 0, minutes: 0, count: 0,
    tierName: '', tier: -1, range: '',
    // v4 · the cast (filled in place by npcs.cast) and the chronicle's event facts
    who: '', who2: '', job: '', place: '', home: '', quarter: '', fortune: '', rel: '',
    was: '', ghost: '', best: '', spell: 0, days: 0 });
  const POOL = []; for (let i = 0; i < 10; i++) POOL.push(mkItem());
  const normalQ = [], urgentQ = [];
  const NORMAL_CAP = 4, URGENT_CAP = 3;
  const take = () => { for (let i = 0; i < POOL.length; i++) if (!POOL[i].used) { POOL[i].used = true; return POOL[i]; } return null; };
  const give = it => { it.used = false; it.label = it.title = it.tok = it.tierName = it.range = ''; it.tier = -1; it.n = it.order = it.minutes = it.count = 0; clearCast(it); it.was = it.ghost = it.best = ''; it.spell = it.days = 0; };
  /** The eight fields npcs.cast() owns, blanked together so a stale name can never
      be borrowed by the next line that happens to use {who}. */
  const clearCast = t => { t.who = t.who2 = t.job = t.place = t.home = t.quarter = t.fortune = t.rel = ''; };

  /** The item currently on screen — its data feeds the template slots. */
  const S = mkItem();

  /* ── ambient weighting scratch (reused; ambient picks must not allocate) ── */
  const ambCat = new Array(20), ambW = new Float32Array(20);
  let countryCache = null, countryAt = -1e9;
  // market day is a window, not an event: `marketOpen` opens it, `marketClose`
  // shuts it, and the 4 h backstop means a missed close cannot leave the Gazette
  // selling cheese at midnight.
  let marketUntil = 0;

  /* ═══ slots ═══ */
  const pctRnd = () => 3 + Math.floor(rnd() * 95);
  function slotVal(k) {
    switch (k) {
      case 'town': return townName;
      case 'tok': return S.tok || facts.tokStr || '0';
      case 'b': return facts.buildings;
      case 'n': return S.n;
      case 'villagers': return facts.villagers;
      case 'breaks': return facts.breaks;
      case 'grandest': return facts.grandest;
      case 'landmark': return S.label || facts.landmark;
      case 'label': return S.label || facts.grandest;
      case 'title': return S.title;
      case 'order': return S.order;
      case 'minutes': return S.minutes;
      case 'range': return S.range || facts.rangeLabel;
      case 'prev': return facts.prevStr || '';
      case 'pace': return Math.round(facts.perMin);
      case 'tier': return S.tier >= 0 ? S.tier : facts.tier;
      case 'tierName': return S.tierName || facts.tierName;
      case 'ring': return Math.max(1, band + 1);
      // ONE VILLAGER PER LINE. "{name} objects. {name} always objects." is only a
      // joke if it is the same person twice, and drawing a fresh FOLK entry per
      // OCCURRENCE printed "Squire Dunnage objects. the Reverend Ossick always
      // objects." — which also shows the second fault: several FOLK entries lead
      // with a lowercase article, and several templates put {name} at the start
      // of a sentence. The render memo below holds it; sentence-cased where it
      // lands. npcs.randomName() has its own 1200 ms anti-repeat, which is exactly
      // why the memo has to stay once a roster exists.
      case 'name': return (nameOf && nameOf()) || FOLK[Math.floor(rnd() * FOLK.length)];
      case 'pct': return pctRnd();
      // v4 · the cast. cast() fills these on S before the render; every one of
      // them is in NEEDS, so an empty roster skips the line rather than printing
      // "  of  has opened a second  ".
      case 'who': return S.who;
      case 'who2': return S.who2;
      case 'job': return S.job;
      case 'place': return S.place;
      case 'home': return S.home;
      case 'quarter': return S.quarter;
      case 'fortune': return S.fortune;
      case 'rel': return S.rel;
      // v4 · the chronicle
      case 'best': return S.best || facts.bestStr || '';
      case 'was': return S.was;
      case 'ghost': return S.ghost || facts.ghost || '';
      case 'spell': return S.spell || facts.spell || 0;
      case 'days': return S.days || facts.days || 0;
      default: return '';
    }
  }
  /* Per-render slot memo. Two jobs: it is what keeps ONE VILLAGER PER LINE true,
     and it is what lets headline().plain be built from the same draws as the html
     — {pct} and {name} both consume the seeded stream, so recomputing them for the
     plain form would print a different number to the one on the bar. Parallel
     arrays, never rebuilt: a line has at most a handful of distinct slots. */
  const memoK = [], memoV = [];
  let memoN = 0;
  const newRender = () => { memoN = 0; };
  function slotOf(k) {
    for (let i = 0; i < memoN; i++) if (memoK[i] === k) return memoV[i];
    const v = slotVal(k);
    memoK[memoN] = k; memoV[memoN] = v; memoN++;
    return v;
  }
  /** Ask npcs for a cast, straight onto S. False (and S left blank) when the
      roster cannot supply one, which is what makes every {who} line unusable. */
  function castFor(cat) {
    const kind = CAST_OF[cat];
    if (!kind) return false;
    if (S.who) return true;                       // a posted event already carried one
    if (!castOf) return false;
    let ok = false;
    try { ok = !!castOf(kind, S); } catch (e) { ok = false; }
    if (!ok) clearCast(S);
    return ok && !!S.who;
  }
  // Looking back over whitespace and any markup tags: if the first real character
  // before this slot is a full stop (or there is nothing before it at all), the
  // slot opens a sentence and has to be capitalised.
  function opensSentence(str, off) {
    for (let i = off - 1; i >= 0; i--) {
      const c = str[i];
      if (c === ' ' || c === '\n' || c === '\t') continue;
      if (c === '>') { const j = str.lastIndexOf('<', i); if (j < 0) return false; i = j; continue; }
      return c === '.' || c === '!' || c === '?' || c === '—' || c === ':';
    }
    return true;
  }
  const cased = (k, v, str, off) =>
    (k === 'name' && v && opensSentence(str, off)) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  const slotFn = (_, k, off, str) => cased(k, esc(slotOf(k)), str, off);
  /** Same substitution against the marker-stripped line — offsets differ, so the
      sentence test is re-run rather than reused. */
  const plainFn = (_, k, off, str) => cased(k, String(slotOf(k)), str, off);

  /** True if any of the line's slots would resolve to nothing worth printing — the
      difference between a living ticker and furniture is that the copy is TRUE. */
  function unusable(c, i) {
    if (c.day[i] && !rangeIsDay) return true;
    const s = c.slots[i];
    for (let j = 0; j < s.length; j++) {
      const k = s[j];
      if (!NEEDS[k]) continue;
      const v = slotVal(k);
      if (v === '' || v === 0 || v === '0') return true;
      if (k === 'n' && v < 2) return true;              // "1 new buildings" is not a sentence
    }
    return false;
  }

  /* ═══ anti-repeat: shuffled per-category cursor + a 26-slot ring ═══ */
  function cursorFor(key, n) {
    let s = cursors[key];
    if (!s || s.order.length !== n) {
      s = cursors[key] = { order: new Int32Array(n), i: n };
      for (let i = 0; i < n; i++) s.order[i] = i;
    }
    return s;
  }
  function reshuffle(s, n) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1)), t = s.order[i]; s.order[i] = s.order[j]; s.order[j] = t;
    }
    s.i = 0;
  }
  const keyOf = (cat, i) => (CAT_ID[cat] || 0) * 1024 + i;
  function seen(cat, i) { const k = keyOf(cat, i); for (let j = 0; j < RING_N; j++) if (ring[j] === k) return true; return false; }
  function remember(cat, i) { ring[ringI] = keyOf(cat, i); ringI = (ringI + 1) % RING_N; }

  const poolOf = cat => cat === 'ARCH' ? (ARCH[archetype] || null) : CORPUS[cat];

  /** Pick an index in `cat`, skipping recent and untrue lines. -1 if the pool is empty. */
  function pickLine(cat) {
    const c = poolOf(cat);
    if (!c || !c.n) return -1;
    const s = cursorFor(cat, c.n);
    let fallback = -1;
    for (let t = 0; t < c.n; t++) {
      if (s.i >= c.n) reshuffle(s, c.n);
      const idx = s.order[s.i++];
      if (unusable(c, idx)) continue;
      if (fallback < 0) fallback = idx;
      if (!seen(cat, idx)) return idx;
    }
    return fallback;
  }

  /* ═══ the swap ═══════════════════════════════════════════════
     Set the html, drop .swap, force reflow, re-add — a 420 ms fade + 6 px slide.
     Never a marquee: a scrolling line screenshots mid-slide and reads as garbage. */
  function show(cat, idx, urgent, hold, now) {
    const c = poolOf(cat);
    if (!c || idx < 0 || idx >= c.n) return;
    SLOT_RE.lastIndex = 0;
    newRender();                                              // one villager per line
    const html = c.html[idx].replace(SLOT_RE, slotFn);
    SLOT_RE.lastIndex = 0;
    setHeadline(html, c.plain[idx].replace(SLOT_RE, plainFn), cat);
    remember(cat, idx);
    history.unshift(html); if (history.length > 5) history.length = 5;
    if (line) {
      line.innerHTML = html;
      line.classList.remove('swap');
      void line.offsetWidth;                                  // restart the keyframe
      line.classList.add('swap');
    }
    if (bar) {
      if (urgent) { bar.classList.add('hot'); hotUntil = now + 4000; }
      else if (now >= hotUntil) bar.classList.remove('hot');
    }
    nextAt = now + (hold || dwellFor(c.text[idx]));
    if (histShown) renderHistory();
  }

  /** Free-text line (countryside colour handed over by environs). */
  function showText(text, now) {
    SLOT_RE.lastIndex = 0;
    newRender();                                              // one villager per line
    const html = markup(String(text)).replace(SLOT_RE, slotFn);
    SLOT_RE.lastIndex = 0;
    setHeadline(html, plainOf(String(text)).replace(SLOT_RE, plainFn), 'LAND');
    history.unshift(html); if (history.length > 5) history.length = 5;
    if (line) {
      line.innerHTML = html;
      line.classList.remove('swap'); void line.offsetWidth; line.classList.add('swap');
    }
    if (bar && now >= hotUntil) bar.classList.remove('hot');
    nextAt = now + dwellFor(text);
    if (histShown) renderHistory();
  }

  function applyItem(it) {
    S.n = it.n; S.label = it.label; S.title = it.title; S.tok = it.tok;
    S.order = it.order; S.minutes = it.minutes; S.count = it.count;
    S.tierName = it.tierName; S.tier = it.tier; S.range = it.range;
    S.who = it.who; S.who2 = it.who2; S.job = it.job; S.place = it.place;
    S.home = it.home; S.quarter = it.quarter; S.fortune = it.fortune; S.rel = it.rel;
    S.was = it.was; S.ghost = it.ghost; S.best = it.best; S.spell = it.spell; S.days = it.days;
  }
  function clearItem() {
    S.n = 0; S.label = ''; S.title = ''; S.tok = ''; S.order = 0;
    S.minutes = 0; S.count = 0; S.tierName = ''; S.tier = -1; S.range = '';
    clearCast(S); S.was = S.ghost = S.best = ''; S.spell = 0; S.days = 0;
  }

  /* ═══ headline() ═════════════════════════════════════════════
     The bar's current copy in both forms. `plain` is what the Crier shouts, so it
     must be safe for textContent: it is built from the marker-stripped template
     with UNESCAPED slot values, never by un-parsing the html. */
  let headHtml = '', headPlain = '', headCat = '';
  const HEADLINE = { html: '', plain: '', cat: '' };
  function setHeadline(html, plain, cat) { headHtml = html; headPlain = plain; headCat = cat; }
  /** @returns {{html:string, plain:string, cat:string}} a shared scratch object —
   *  read it, do not keep it. */
  function headline() {
    HEADLINE.html = headHtml; HEADLINE.plain = headPlain; HEADLINE.cat = headCat;
    return HEADLINE;
  }

  /* ═══ ambient self-selection ═════════════════════════════════
     Nobody posts ambient. When the queue is empty and the dwell expires the crier
     reaches for the category the town's own state suggests. */
  function ambient(now) {
    clearItem();
    // The state-of-the-town categories are PROBABILITIES, not weights: when the town
    // is asleep, three lines in ten are about the dark. One draw, tested in order.
    let r = rnd(), p = 0;
    let cat = '';
    if (nightNow > .55) { p += .30; if (r < p) cat = 'NIGHT'; }
    if (!cat && idleSinceMs && now - idleSinceMs > 600000) { p += .40; if (r < p) cat = 'SLOW'; }
    if (!cat && paceNow > 1.6) { p += .35; if (r < p) cat = 'BOOM'; }
    else if (!cat && paceNow < .5) { p += .25; if (r < p) cat = 'BUST'; }
    if (!cat && facts.tier >= 6) { p += .20; if (r < p) cat = 'CULT'; }
    if (cat) { const i = pickLine(cat); if (i >= 0) { show(cat, i, false, 0, now); return; } }

    // otherwise: the evenly-mixed civic background, plus this archetype's own colour
    // and whatever environs and the weather say is actually happening out there
    let n = 0;
    const add = (c, w) => { ambCat[n] = c; ambW[n] = w; n++; };
    // THE WIRE CARRIES THE VOICE, so it carries the weight: roughly two ambient
    // headlines in five are a two-beat local-nobody item, which is what makes the
    // bar read as a newspaper rather than as a status line with jokes in it. The
    // pool is 56 lines deep against a 26-slot anti-repeat ring, so that share
    // still costs the reader a repeat only every few hundred headlines.
    add('WIRE', 26); add('NOTICE', 6);
    add('ECON', 9); add('CIVIC', 9); add('CULT', 9);
    if (facts.prevStr) add('VERSUS', 6);
    if (ARCH[archetype]) add('ARCH', 8);
    if (demo) add('DEMO', 1.5);
    // A POOL IS ONLY IN THE MIX WHEN ITS FACTS EXIST. pickLine would skip every
    // unusable line and return -1, which stalls the bar for 4 s — so the gate has
    // to be here, not in unusable(). Roster absent ⇒ v3's mix, exactly.
    if (castFor('PEOPLE')) {
      add('PEOPLE', 12);                        // ≈ 1 ambient line in 4 names a resident
      add('CRIER', 2);
      if (marketUntil && now < marketUntil) add('MARKET', 7);
    }
    if (facts.ghost || facts.bestStr || facts.days > 0) add('CHRON', 7);
    if (facts.spell >= 3) add('SPELL', 3);

    // countryside lines: weight 1 against the pool, refreshed at most every 30 s so a
    // per-swap call can never become a per-frame allocation
    let land = null;
    if (country) {
      if (now - countryAt > 30000) { countryAt = now; try { countryCache = country(); } catch (e) { countryCache = null; } }
      land = countryCache && countryCache.length ? countryCache : null;
    }
    let tot = 0; for (let i = 0; i < n; i++) tot += ambW[i];
    const landW = land ? Math.max(1, tot * .10) : 0;
    r = rnd() * (tot + landW);
    if (land && r >= tot) {
      let lt = 0; for (let i = 0; i < land.length; i++) lt += (land[i].w || 1);
      let q = rnd() * lt;
      for (let i = 0; i < land.length; i++) { q -= (land[i].w || 1); if (q <= 0) { showText(land[i].text, now); return; } }
    }
    for (let i = 0; i < n; i++) {
      r -= ambW[i];
      if (r <= 0) { const idx = pickLine(ambCat[i]); if (idx >= 0) show(ambCat[i], idx, false, 0, now); else nextAt = now + 4000; return; }
    }
    const idx = pickLine('CIVIC'); if (idx >= 0) show('CIVIC', idx, false, 0, now); else nextAt = now + 4000;
  }

  /* ═══ post ═══════════════════════════════════════════════════ */
  function post(type, data) {
    const now = performance.now();
    if (!type) return;
    if (facts.cascading && CASCADE_MUTE[type]) return;
    const d = data || {};

    // pace posts pick their own side of the ledger
    let cat = CAT_OF[type];
    if (type === 'pace') {
      const ratio = typeof d.ratio === 'number' ? d.ratio : (d.trend === 'down' ? .4 : 1.8);
      cat = ratio < 1 ? 'BUST' : 'BOOM';
    }
    // A range change is a widening or a narrowing, never both. `wider` was already
    // being passed and thrown away, so shrinking the window told archive-opening
    // jokes at the user.
    if (type === 'rangeChanged' && typeof d.wider === 'boolean') cat = d.wider ? 'RANGE_UP' : 'RANGE_DN';
    // the protagonist's fortune picks its side exactly the way `pace` does
    if (type === 'fortune') cat = d.up === false ? 'HERO_DN' : 'HERO_UP';
    // one record event, two stones: a best day and a biggest town read nothing alike
    if (type === 'record') cat = d.key === 'overtake' ? 'OVERTAKE' : d.key === 'largest' ? 'RECORD_B' : 'RECORD';
    if (type === 'marketOpen') marketUntil = now + 4 * 3600e3;
    if (type === 'marketClose') marketUntil = 0;
    if (!cat || !CORPUS[cat]) return;                          // unknown type: ignored, never thrown

    if (type === 'buildingsAdded' || type === 'promotion' || type === 'milestone') idleSinceMs = 0;
    if (type === 'idle' && !idleSinceMs) idleSinceMs = now - (d.minutes || 10) * 60000;

    const it = take();
    if (!it) return;                                           // pools exhausted: drop, don't allocate
    it.cat = cat;
    it.urgent = !!URGENT[type];
    it.hold = (type === 'milestone' || type === 'best' || type === 'record' || type === 'overtake') ? 12000 : 0;
    it.n = (d.n | 0) || (d.count | 0);
    it.label = typeof d.label === 'string' ? d.label : (typeof d.kind === 'string' ? d.kind : '');
    it.title = typeof d.title === 'string' ? d.title : '';
    it.tok = typeof d.tok === 'number' ? fmtTok(d.tok) : (typeof d.tok === 'string' ? d.tok : '');
    it.order = d.order | 0;
    it.minutes = d.minutes | 0;
    it.count = d.count | 0;
    it.tierName = typeof d.tierName === 'string' ? d.tierName : '';
    it.tier = typeof d.tier === 'number' ? d.tier : -1;
    if (type === 'rangeChanged') {
      // {range} wants the sentence form ("the last 24 h"), not the header badge
      it.range = typeof d.short === 'string' ? d.short : (facts.rangeLabel || d.label || '');
      it.label = '';                                           // {label} names a building, never a range
    } else it.range = '';

    /* ── v4 payloads ─────────────────────────────────────────────────────────
       Each of these is copied from the shape its owning module documents; a
       field that is absent stays '' and takes its lines out of the pool. */
    it.who = str(d.who); it.who2 = str(d.who2); it.job = str(d.job);
    it.place = str(d.place); it.home = str(d.home); it.quarter = str(d.quarter);
    it.fortune = str(d.fortune); it.rel = str(d.rel);
    it.ghost = str(d.ghost); it.best = str(d.best);
    it.spell = (d.spell | 0) || (d.len | 0);
    it.days = d.days | 0;
    if (cat === 'RECORD' || cat === 'OVERTAKE') {
      // chronicle sends raw numbers; the bar and the footer must agree on the format
      if (typeof d.now === 'number') it.tok = fmtTok(d.now);
      it.was = typeof d.was === 'number' ? fmtTok(d.was) : str(d.was);
    } else if (cat === 'RECORD_B') {
      it.was = typeof d.was === 'number' ? String(d.was) : str(d.was);   // buildings, not tokens
    } else it.was = str(d.was);
    if (cat === 'BADGE') {
      // Two shapes reach here and both must read right: town.js's own
      // {label:award.title, title:award.blurb}, and a raw charter Award — whose
      // `kind` is the literal string 'badge' and must never reach {label}.
      it.label = str(d.blurb) ? (str(d.title) || str(d.name)) : str(d.label);
      it.title = str(d.blurb) || (str(d.label) ? str(d.title) : '');
    }
    // A people line posted without a cast asks the roster for one at display time;
    // if the roster cannot supply it, every line in the pool is unusable and the
    // item is dropped by pickLine — which is the correct silence, not a hole.
    if (CAST_OF[cat] && !it.who && castOf) {
      applyItem(it);
      if (castFor(cat)) {
        it.who = S.who; it.who2 = S.who2; it.job = S.job; it.place = S.place;
        it.home = S.home; it.quarter = S.quarter; it.rel = S.rel;
        if (!it.fortune) it.fortune = S.fortune;
      }
    }

    if (it.urgent) {
      // urgent displaces everything pending — but two urgents never land inside 900 ms
      for (let i = 0; i < normalQ.length; i++) give(normalQ[i]);
      normalQ.length = 0;
      if (now - lastUrgentAt >= URGENT_GAP) {
        lastUrgentAt = now;
        applyItem(it);
        const idx = pickLine(it.cat);
        if (idx >= 0) show(it.cat, idx, true, it.hold, now);
        give(it);
      } else {
        if (urgentQ.length >= URGENT_CAP) give(urgentQ.shift());
        urgentQ.push(it);
      }
    } else {
      if (normalQ.length >= NORMAL_CAP) give(normalQ.shift());  // stale news is worse than missed news
      normalQ.push(it);
    }
  }

  /* ═══ bubbles ════════════════════════════════════════════════
     Pooled divs, projected each frame from a SNAPSHOT anchor: the villager walks on
     and the remark hangs in the air, which reads better than a label glued to a head
     (and costs no lookup into npcs' internals). A caller that CAN keep a live handle
     on its speaker passes `opts.at` and the remark follows them instead — nothing
     does yet, and without it this is v4's behaviour to the pixel. */
  const bubs = [];
  if (overlay) for (let i = 0; i < MAX_BUB; i++) {
    const el = document.createElement('div');
    el.className = 'bub'; el.style.display = 'none';
    // Three permanent children, so a remark is never assembled with innerHTML:
    // the gold nameplate, the speech itself, and the marker at the far end of the
    // leader that gives a sub-pixel speaker something the eye can land on.
    const who = document.createElement('span');
    who.className = 'who'; who.style.display = 'none';
    const txt = document.createElement('span');
    txt.className = 'say';
    const anchor = document.createElement('span');
    anchor.className = 'anchor';
    el.appendChild(who); el.appendChild(txt); el.appendChild(anchor);
    overlay.appendChild(el);
    // w/h are the element's MEASURED box at the font size it was measured at, so
    // collision is against the real thing and rescaling it costs no second read.
    bubs.push({ el, who, txt, anchor, kind: '', named: false, born: 0, ttl: 0,
      alive: false, hidden: true, off: false, blocked: false, covered: false,
      occlAt: 0, at: null,
      // `ring` starts true because the CSS draws the anchor by default; the first
      // place() that decides otherwise is then the one that hides it.
      op: -1, px: 0, py: 0, cy: 0, fs: 0, mw: 0, mh: 0, mfs: 12, ring: true,
      // where the BOX ended up after place() slid it clear of the frame edge, how
      // far the tail had to travel back to stay on the speaker, and which way up
      // the remark is drawn. All three are re-decided every frame.
      left: -1e9, nub: 0, under: false,
      p: new THREE.Vector3() });
  }
  /* `--shot-ui=0` is documented as "no chrome at all", and a speech bubble is
     chrome — photo mode has taken #overlay away with the rest of it since v4,
     and the flag that promises a clean plate was leaving the loudest overlay in.
     interact.js owns the class (it reads the flag and puts `noui` on <body>);
     this side simply does not speak while it is on, so nothing is spawned,
     projected or measured. One DOMTokenList lookup per frame and per offer. */
  const chromeGone = () => document.body.classList.contains('noui');

  const _v = new THREE.Vector3();
  // Refreshed once a frame in update(); all four are inputs to whether a remark is
  // worth making at all, and none of them may be read before the first update().
  let camDist = 62;         // eye → origin, the v4 framing proxy
  let camH = 60;            // eye → the ground the town stands on. THE street-level test.
  let focalPx = 900;        // pixels per world unit at unit distance
  let maxLive = 2;
  // The fountain's notice board, in screen pixels: the number the whole app is
  // about, which no remark may sit on.
  const board = { on: false, x: 0, y0: 0, y1: 0, hw: 0 };
  const _mv = new THREE.Vector3();
  let rect = null;
  const invalidateRect = () => { rect = null; };
  window.addEventListener('resize', invalidateRect);

  function rectOf() {
    if (!rect || !rect.width) rect = (canvas || overlay || document.body).getBoundingClientRect();
    return rect;
  }

  /* ── the sight test's town model ──────────────────────────────
     Rebuilt only when town.js hands back a different building array (it caches
     one and rebuilds it on a structural change), plus a 4 s safety net. If ctx
     ever carries `occluded()` — a real raycast against the LOD instances — that
     is authoritative and the grid is never built at all. */
  const sight = makeSight();
  let occludedFn = null, bldRows = null, sightAt = -1e9, groundY = 0;
  function refreshSight(now, c) {
    occludedFn = typeof c.occluded === 'function' ? c.occluded : null;
    if (occludedFn) { bldRows = null; return; }
    if (typeof c.getBuildings !== 'function') return;
    let rows = null;
    try { rows = c.getBuildings(); } catch (e) { rows = null; }
    if (!rows || (rows === bldRows && now - sightAt < 4000)) return;
    bldRows = rows; sightAt = now;
    sight.rebuild(rows);
    groundY = sight.n ? sight.ground : 0;
  }
  /** True when town geometry stands between the eye and this anchor. */
  function outOfSight(v) {
    if (occludedFn) { try { return !!occludedFn(v); } catch (e) { return false; } }
    const p = cam.position;
    return sight.blocked(p.x, p.y, p.z, v.x, v.y, v.z);
  }

  /** A trade's own remarks come first when one is on offer — the generic `work`
      pool is the fallback for a job nobody wrote lines for.
      Slot-gated like the ticker: 'Another. And one for {who2}.' was printing
      "…and one for ." on every night the roster had not just handed the Gazette
      a cast, because S is the TICKER's item and is cleared between headlines. */
  function bubText(kind, job) {
    const c = (kind === 'work' && job && JOB[job]) ? JOB[job] : (BUB[kind] || BUB.stroll);
    const key = 'B_' + (c === JOB[job] ? 'J_' + job : kind), s = cursorFor(key, c.n);
    let idx = -1;
    for (let t = 0; t < c.n; t++) {
      if (s.i >= c.n) reshuffle(s, c.n);
      const i = s.order[s.i++];
      const sl = c.slots[i];
      let ok = true;
      for (let j = 0; j < sl.length; j++) {
        const v = slotVal(sl[j]);
        if (v === '' || v === 0 || v === '0') { ok = false; break; }
      }
      if (ok) { idx = i; break; }
    }
    if (idx < 0) return '';
    SLOT_RE.lastIndex = 0;
    return c.text[idx].replace(SLOT_RE, (_, k) => slotVal(k));
  }

  const retire = b => {
    b.alive = false; b.kind = ''; b.named = false;
    b.blocked = false; b.off = false; b.covered = false; b.at = null;
    b.el.style.display = 'none'; b.el.className = 'bub';   // …which also drops `under`
    b.el.style.visibility = ''; b.hidden = false;
    b.left = -1e9; b.nub = 0; b.under = false;
    b.who.style.display = 'none';
  };
  /** Strip the nameplate but leave the remark standing — how an ordinary named
      bubble yields to the Crier without the speech vanishing mid-sentence. */
  const unname = b => { b.named = false; b.who.style.display = 'none'; };

  /** How tall the SPEAKER is on screen, in px — the one number every piece of
      bubble sizing is derived from. */
  const headPxAt = d => HEAD_M * focalPx / Math.max(d, .45);
  /** A live bubble's current box. Measured once at spawn and rescaled by font
      size, which is exact to within a rounding: the element's width cap and its
      text both scale linearly with `fs`. */
  const boxW = b => b.mw * b.fs / b.mfs;
  const boxH = b => b.mh * b.fs / b.mfs;

  /**
   * Request a bubble. False when the pool is full, the kind is over-represented, the
   * anchor is behind the camera / out of frame / too far to read, its box would land
   * on another remark or has nowhere to sit that does not cover the fountain's
   * counter, the speaker is standing behind a building, or the chrome has been
   * taken away by `--shot-ui=0`. Callers may ignore the result.
   * @param {THREE.Vector3} v HEAD-TOP world position @param {string} kind
   * @param {{text?:string, ttl?:number, who?:string, job?:string,
   *          at?:(out:THREE.Vector3)=>boolean}} [opts]
   *        `who` draws a gold nameplate over the remark — at most ONE live at a
   *        time, because two named bubbles read as a comic strip.
   *        `at` re-reads the speaker's head each frame into the vector it is
   *        handed, and returns false once they are gone. Optional: without it the
   *        remark hangs in the air where it was said, as it always has.
   */
  function say(v, kind, opts) {
    if (!bubs.length || !v || !cam) return false;
    if (chromeGone()) return false;                         // `--shot-ui=0`: no chrome at all
    if (DIAG) DG.calls++;
    const k = BUB[kind] ? kind : 'stroll';
    // THE CRIER OUTRANKS EVERYTHING. town.js offers his shout on exactly one frame
    // — the frame crierSpeaking() flips true — so a full pool would lose the
    // marquee moment outright. He takes a slot instead of failing.
    const vip = k === 'crier';
    let free = null, same = 0, live = 0, oldest = null, named = null;
    for (let i = 0; i < bubs.length; i++) {
      const b = bubs[i];
      if (!b.alive) { if (!free) free = b; continue; }
      live++;
      if (b.kind === k) same++;
      if (b.named) named = b;
      if (b.kind !== 'crier' && (!oldest || b.born < oldest.born)) oldest = b;
    }
    if (vip && (!free || live >= maxLive) && oldest) { retire(oldest); free = oldest; live--; same = 0; }
    if (!free || same >= MAX_PER_KIND || live >= maxLive) { if (DIAG) DG.pool++; return false; }
    const d = cam.position.distanceTo(v);
    if (d * d > earshot2For(camDist)) { if (DIAG) DG.far++; return false; }
    _v.copy(v).project(cam);
    // FRUSTUM, and it is exactly the frustum now. The old ±1.05 let a speaker
    // 2.5 % outside the picture start talking, and place() only ever re-tested
    // `z > 1` afterwards — so the remark hung against the edge of the frame with
    // half of it clipped away by #overlay's overflow, attached to nobody.
    if (_v.z > 1 || _v.x < -1 || _v.x > 1 || _v.y < -1 || _v.y > 1) { if (DIAG) DG.screen++; return false; }
    // The candidate's own box is not laid out yet, so it is predicted from the
    // font size it is about to get — the same curve place() will apply. The
    // prediction is only a seed: the real box is measured below and every
    // screen-space rejection is made against that.
    const fs0 = fontFor(headPxAt(d));
    // DEPTH, LAST, because it is the only test that walks the town. A remark from
    // behind a wall is not softened or dimmed — it is not made. The crier is NOT
    // exempt: a shout through a cottage is exactly as wrong as a mutter through
    // one, and town.js re-offers his line every frame until he is in view.
    if (DIAG) {
      const _t0 = performance.now();
      const _o = PROBE_BYPASS ? false : outOfSight(v);
      DG.sightMs += performance.now() - _t0; DG.sightN++;
      if (_o) { DG.occ++; return false; }
    } else if (!PROBE_BYPASS && outOfSight(v)) return false;

    const job = (opts && opts.job) || '';
    const text = (opts && opts.text) || bubText(k, job);
    if (!text) return false;                                // every line in the pool was untrue
    let name = (opts && opts.who) || '';
    if (name && named) { if (vip) unname(named); else name = ''; }
    const now = performance.now();
    free.kind = k; free.alive = true; free.hidden = false; free.off = false;
    free.blocked = false; free.occlAt = now; free.op = -1;
    free.at = (opts && typeof opts.at === 'function') ? opts.at : null;
    free.named = !!name; free.born = now;
    free.ttl = (opts && opts.ttl) || ttlFor(text.length, camH);
    free.p.copy(v);
    const el = free.el;
    free.txt.textContent = text;                            // never innerHTML: bubbles are plain speech
    free.who.textContent = name;
    free.who.style.display = name ? 'block' : 'none';
    el.className = 'bub ' + k;
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    free.fs = 0;                                            // force place() to re-size for this kind
    free.left = -1e9; free.nub = 0; free.under = false; free.covered = false;
    // Seed the box with the prediction so the first place() has something sane to
    // reason about, then lay it out and read what it actually came to.
    free.mw = widthFor(fs0, k, rectOf().width); free.mh = fs0 * 3.4; free.mfs = fs0;
    place(free);
    // ONE layout read per remark, and it is the one the .pop keyframe needed
    // anyway. Everything downstream — collision, the board box — rescales this.
    free.mw = el.offsetWidth; free.mh = el.offsetHeight; free.mfs = free.fs || fs0;
    place(free);                                            // …now against the real box
    // SCREEN-SPACE REJECTION, and it happens HERE rather than on a predicted box
    // because the two things it protects are worth measuring for. One remark
    // parked on the fountain's counter hides the number the whole app is about;
    // two that overlap are two nobody can read. Losing the turn is cheap — the
    // sampler pulls again in 2.2 s, and town.js re-offers the Crier every frame.
    // NOBODY IS EXEMPT FROM THE COUNTER, the Crier least of all: he is walked to
    // the plaza rim on purpose, so his is the widest card in the app and it is
    // aimed straight at the one thing it may not cover.
    if (free.covered) { retire(free); if (DIAG) DG.board++; return false; }
    const bw0 = boxW(free), bh0 = boxH(free);
    for (let i = 0; i < bubs.length; i++) {
      const b = bubs[i];
      if (!b.alive || b.hidden || b === free) continue;
      if (Math.abs(free.px - b.px) < (bw0 + boxW(b)) * .5 + 8
        && Math.abs(free.cy - b.cy) < (bh0 + boxH(b)) * .5 + 6) {
        if (!vip) { retire(free); if (DIAG) DG.coll++; return false; }
        retire(b);
      }
    }
    el.classList.add('pop');
    if (DIAG) DG.ok++;
    return true;
  }

  /** Would a box this wide, spanning [yTop,yBot], lie over the fountain's
   *  counter? A plain rectangle overlap — which the spawn test used not to be:
   *  it compared the ANCHOR against the board's lower edge with a flat 8 px of
   *  slack, so a villager standing at the fountain, whose head projects a few
   *  pixels below the counter, passed the test and then grew forty pixels of
   *  pill straight up over the number. */
  const overBoard = (x, w, yTop, yBot) => board.on
    && Math.abs(x - board.x) < board.hw + w * .5
    && yBot > board.y0 - 2 && yTop < board.y1 + 2;

  function place(b) {
    const r = rectOf();
    _v.copy(b.p).project(cam);
    // OFF SCREEN IS OFF SCREEN. `z > 1` is behind the eye; the four that follow
    // are a speaker who has walked out of the picture, or whom the camera has
    // swung away from. Only the first of these was tested before, so a remark
    // whose villager had left the frame carried on being drawn hard against the
    // edge with half of it clipped off by #overlay's overflow — a speech bubble
    // for somebody who is not on screen, which is not speech, it is a label.
    if (_v.z > 1 || _v.x < -1 || _v.x > 1 || _v.y < -1 || _v.y > 1) { b.off = true; applyVis(b); return; }
    b.off = false;
    const ax = (_v.x + 1) / 2 * r.width, ay = (-_v.y + 1) / 2 * r.height;
    b.py = ay;
    // A BUBBLE HAS TO LOOK ATTACHED TO A PERSON, and the only honest measure of
    // that is how big the person is: `head` is the speaker's own height in
    // pixels. v4 read camera distance on a linear ramp, which was tuned at one
    // framing and flat at every other — at range=all a 165 px pill sat over
    // fifteen buildings while its villager was a 2 px dot, and in stroll a
    // speaker at arm's length got a font 2 px larger than one across the valley.
    const head = headPxAt(cam.position.distanceTo(b.p));
    const fs = fontFor(head);
    if (fs !== b.fs) {
      b.fs = fs;
      b.el.style.fontSize = fs.toFixed(1) + 'px';
      b.el.style.maxWidth = widthFor(fs, b.kind, r.width) + 'px';
      // The leader runs the other way: it exists to reach DOWN to a speaker too
      // small to see, so it shortens as they fill the frame…
      b.el.style.setProperty('--stem', stemFor(head) + 'px');
      // …and the bright ring at its foot is dropped once the speaker is plainly
      // a person. At two metres it lands on their face and reads as a reticle.
      const ring = head < 26;
      if (ring !== b.ring) { b.ring = ring; b.anchor.style.display = ring ? 'block' : 'none'; }
      // the plate rides the same curve as the speech, or a far speaker gets a
      // name bigger than the thing they said
      if (b.named) b.who.style.fontSize = (fs * .74).toFixed(1) + 'px';
    }
    /* ── WHICH WAY UP, AND HOW FAR OVER ─────────────────────────
       Both re-decided every frame, because everything they answer to moves: the
       speaker walks, the camera swings, and the counter's projected box swings
       with it. The old code decided once at spawn and never looked again, which
       is how a remark that was clear of the number when it was made ended up
       parked squarely on it three seconds later.

       UP is the natural reading — speech rises out of a head — so it is kept
       whenever it is legal. It is illegal in two cases and only two: the box
       would cover the fountain's counter, or it would run off the top of the
       frame. Then the remark hangs UNDER its speaker instead, and the tail turns
       over. When neither way is legal the remark is not drawn; `say()` reads the
       same flag and does not make it in the first place. */
    const w = boxW(b), h = boxH(b);
    const upOK = ay - h > 2 && !overBoard(ax, w, ay - h, ay);
    const under = upOK ? false : (ay + h < r.height - 2 && !overBoard(ax, w, ay, ay + h));
    b.covered = !upOK && !under;
    if (under !== b.under) { b.under = under; b.el.classList.toggle('under', under); }
    // …and sideways, so a speaker at the edge of the picture gets a WHOLE remark
    // rather than a clipped one. The box slides inside the frame and the tail
    // travels back the other way to stay on them; it stops at the box's own
    // corner, which is close enough that nobody reads it as detached.
    const half = w * .5, mid = r.width * .5;
    const left = clamp(ax, Math.min(half + 4, mid), Math.max(r.width - half - 4, mid));
    const nub = clamp(ax - left, 10 - half, half - 10);
    b.px = left;                                        // the BOX centre: what collides
    b.cy = under ? ay + h * .5 : ay - h * .5;
    if (left !== b.left) { b.left = left; b.el.style.left = left.toFixed(1) + 'px'; }
    if (nub !== b.nub) { b.nub = nub; b.el.style.setProperty('--nub', nub.toFixed(1) + 'px'); }
    b.el.style.top = ay.toFixed(1) + 'px';
    applyVis(b);
  }

  /** One place decides whether a remark is on screen: behind the camera, out of
      frame, behind a building, or with nowhere to sit that does not cover the
      number. All four are invisibility, not removal — the speaker is still
      talking, and a step to the left brings the remark back. */
  function applyVis(b) {
    const hide = b.off || b.blocked || b.covered;
    if (hide !== b.hidden) { b.el.style.visibility = hide ? 'hidden' : 'visible'; b.hidden = hide; }
  }

  // `_pb` holds the WINNER in world space. It has to be separate from `_pv`,
  // which the loop below reuses as scratch for the NDC projection of every
  // candidate it examines — including candidates examined AFTER the winner was
  // chosen, which is how the first version of this probe ended up handing say()
  // a normalised-device coordinate and reporting that an occluded speaker had
  // been allowed to talk. The probe was wrong, not the sight test.
  const _pv = new THREE.Vector3(), _pp = new THREE.Vector3(), _pb = new THREE.Vector3();
  let probeAt = 0, probeOn = false;
  function probeStep(now) {
    if (probeOn) return;
    if (now - probeAt < 700) return;
    probeAt = now;
    if (!bldRows) return;
    const o = cam.position;
    let best = -1, bd = 1e9;
    for (let i = 0; i < bldRows.length; i++) {
      const e = bldRows[i], q = e && e.pos;
      if (!q) continue;
      const dx = q.x - o.x, dz = q.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d < 6 || d > 34 || d > bd) continue;
      const h = e.hTop > 0 ? e.hTop : 3.5;
      const r = 1.55 * (h > 11 ? 3 : h > 8 ? 2 : 1) + .10 * h;
      // stand the speaker squarely behind this building, at head height
      _pp.set(q.x + dx / d * (r + 2.6), q.y + 1.75, q.z + dz / d * (r + 2.6));
      _pv.copy(_pp).project(cam);
      if (_pv.z > 1 || Math.abs(_pv.x) > .8 || Math.abs(_pv.y) > .7) continue;
      if (!sight.blocked(o.x, o.y, o.z, _pp.x, _pp.y, _pp.z)) continue;
      best = i; bd = d; _pb.copy(_pp);
    }
    if (best < 0) { console.warn('[probe] no wall with anybody behind it'); return; }
    const ok = say(_pb, 'stroll', { text: 'Behind that wall, and audible.', ttl: 60000 });
    console.warn('[probe] wall#' + best + ' at ' + bd.toFixed(1) + 'u  spawned=' + ok + '  bypass=' + PROBE_BYPASS);
    if (ok) probeOn = true;
  }

  function stepBubbles(now) {
    for (let i = 0; i < bubs.length; i++) {
      const b = bubs[i];
      if (!b.alive) continue;
      const age = now - b.born;
      if (age >= b.ttl) { retire(b); continue; }
      // FOLLOW, when the caller kept a handle on its speaker. Nothing passes
      // `at` today, so this is dead weight of one branch per bubble per frame.
      if (b.at && !b.at(b.p)) { retire(b); continue; }
      // ~7 Hz, staggered across the pool, and ON THE WALL CLOCK — a headless
      // capture runs at about 1 fps and must never land on a frame where the
      // remark is still drawn through the wall because dt had not accumulated.
      if (now - b.occlAt >= 130) { b.occlAt = now + i * 9; b.blocked = PROBE_BYPASS ? false : outOfSight(b.p); }
      place(b);
      // fade is computed from the wall clock, never accumulated dt
      const op = age > b.ttl - 500 ? clamp((b.ttl - age) / 500, 0, 1) : 1;
      if (op !== b.op) { b.el.style.opacity = op === 1 ? '1' : op.toFixed(2); b.op = op; }
    }
  }
  const clearBubbles = () => { for (let i = 0; i < bubs.length; i++) retire(bubs[i]); };

  /* ═══ masthead + the hover back-numbers ══════════════════════ */
  function paintMast() {
    if (!mast) return;
    // 620 px was the threshold when the masthead was 11 px of sans. It is a 12.5 px
    // letter-spaced serif now — 'THE LITTLE CACHEWICK CRIER' is close to 300 px —
    // so the town's name comes out of it while there is still room for a headline.
    mast.textContent = window.innerWidth < 900
      ? '❖ THE CRIER' : '❖ THE ' + townName.toUpperCase() + ' CRIER';
  }
  function renderHistory() {
    if (!histEl) return;
    let h = '<div class="hd">back numbers</div>';
    for (let i = 0; i < history.length; i++) h += '<div>' + history[i] + '</div>';
    histEl.innerHTML = h;
    const r = bar.getBoundingClientRect();
    histEl.style.left = Math.round(r.left + 10) + 'px';
    histEl.style.top = Math.round(r.bottom + 6) + 'px';
  }
  const onEnter = () => { if (!histEl || history.length < 2) return; histShown = true; histEl.style.display = 'block'; renderHistory(); };
  const onLeave = () => { histShown = false; if (histEl) histEl.style.display = 'none'; };
  if (bar) {
    histEl = document.createElement('div');
    histEl.className = 'newsHist';
    document.body.appendChild(histEl);
    bar.addEventListener('mouseenter', onEnter);
    bar.addEventListener('mouseleave', onLeave);
  }
  window.addEventListener('resize', paintMast);
  paintMast();

  /* ═══ the loop ═══════════════════════════════════════════════ */
  function update(dt, now, ctx) {
    if (ctx) {
      cam = ctx.camera || cam;
      if (typeof ctx.band === 'number') band = ctx.band;
      rangeIsDay = ctx.rangeIsDay !== false;
      intro = typeof ctx.intro === 'number' ? ctx.intro : 1;
      nightNow = typeof ctx.night === 'number' ? ctx.night : (facts.night || 0);
      paceNow = ctx.paceRatio || facts.paceRatio || 1;
      if (cam) {
        camDist = cam.position.length();
        const r = rectOf();
        // Pixels per world unit at unit distance. cam.fov is the VERTICAL field,
        // and the rig swings it from 34 (photo) to 58 (stroll), so a bubble that
        // sized itself on distance alone was reading a different world to the one
        // on screen.
        focalPx = r.height / (2 * Math.tan(cam.fov * Math.PI / 360)) || 900;
        refreshSight(now, ctx);
        // THE STREET-LEVEL TEST, and it is deliberately not `rig.mode`: what
        // matters is that the eye is down among the roofs, and a user who has
        // dollied the orbit camera into a lane is just as much on the street as
        // one who pressed the stroll key. news.js is not told the mode anyway.
        camH = cam.position.y - groundY;
        maxLive = liveCapFor(camH);

        // THE BOARD KEEP-OUT. This used to be a point projected at y = 13 with a
        // flat 300 × 280 px box around it — sized for the gilded altar whose
        // ledger floated up there. That altar is gone (AESTHETIC.md); the village
        // fountain's notice board tops out at `crownHeight`, six to twelve units
        // up, so the old box has been guarding empty air ever since, and at eye
        // level it can sit off the top of the screen while the board itself fills
        // the middle. Project the board's real extent instead — fountain.js holds
        // its apparent size roughly constant with tabS = clamp(.10 + camD/108,
        // .58, 2.3) over a 5.2 × 1.46 plate — and let overBoard() inflate it by
        // the box of whichever remark is asking. This is a WORLD band projected
        // per frame, not a screen box remembered from a spawn: the plaza crowd
        // walks and the camera swings, so the guard has to move with them.
        const mp = ctx.monumentPos;
        const mx = mp ? mp.x : 0, mz = mp ? mp.z : 0;
        const camD = Math.hypot(cam.position.x - mx, cam.position.y, cam.position.z - mz);
        // THE SIGN'S OWN LAW, kept in step with fountain.js. It hangs on a bracket
        // now, not in the air, and its apparent size is held against the honest
        // world-units-per-screen-share -- which, unlike raw distance, survives the
        // stroll's much wider lens. Copying camD alone under-guarded exactly
        // there. 4.0 x 1.125 board, so half-width 2.0.
        const halfV = camD * Math.tan(cam.fov * Math.PI / 360);
        const tabS = clamp(.23 + halfV / 52.2, .64, 1.95);
        // The top is the one number news.js cannot derive; ctx.monumentTop is the
        // hook for it. Without one, guard the whole band the board can occupy.
        const top = ctx.monumentTop > 0 ? ctx.monumentTop : 12;
        const bot = Math.max(2.4, top - 1.125 * tabS - (ctx.monumentTop > 0 ? 0 : 5));
        const e = cam.matrixWorld.elements;                 // camera right, in world
        _mv.set(mx, top, mz).project(cam);
        board.on = _mv.z <= 1;
        board.x = (_mv.x + 1) / 2 * r.width;
        board.y0 = (-_mv.y + 1) / 2 * r.height;
        _mv.set(mx, bot, mz).project(cam);
        board.y1 = (-_mv.y + 1) / 2 * r.height;
        if (board.y1 < board.y0) { const t = board.y0; board.y0 = board.y1; board.y1 = t; }
        _mv.set(mx + e[0] * 2.0 * tabS, (top + bot) * .5, mz + e[2] * 2.0 * tabS).project(cam);
        board.hw = Math.min(r.width * .4, Math.abs((_mv.x + 1) / 2 * r.width - board.x) + 12);
      }
    }
    if (bar && hotUntil && now >= hotUntil) { bar.classList.remove('hot'); hotUntil = 0; }

    // a queued urgent as soon as the 900 ms spacing allows — before any dwell test
    if (urgentQ.length && now - lastUrgentAt >= URGENT_GAP) {
      const it = urgentQ.shift();
      lastUrgentAt = now;
      applyItem(it);
      const idx = pickLine(it.cat);
      if (idx >= 0) show(it.cat, idx, true, it.hold, now);
      give(it);
    } else if (now >= nextAt) {
      if (normalQ.length) {
        const it = normalQ.shift();
        applyItem(it);
        const idx = pickLine(it.cat);
        if (idx >= 0) show(it.cat, idx, false, it.hold, now); else nextAt = now + 1200;
        give(it);
      } else if (intro >= 1) {
        ambient(now);                       // hold the crier's fire during the founding ritual
      } else nextAt = now + 800;
    }

    if (cam && PROBE) probeStep(now);
    // …and if the chrome has been taken away, take any remark still in the air
    // with it rather than leaving it hanging over a plate that is meant to be clean.
    if (chromeGone()) {
      for (let i = 0; i < bubs.length; i++) if (bubs[i].alive) retire(bubs[i]);
    } else if (cam) {
      if (DIAG) {
        const _t0 = performance.now();
        stepBubbles(now);
        DG.stepMs += performance.now() - _t0; DG.stepN++;
        DG.camH = camH; DG.camD = camDist; DG.bld = sight.n;
        if (DG.stepN % 4 === 0) console.warn('[newsdiag] ' + JSON.stringify(DG));
      } else stepBubbles(now);
    }
  }

  /* ═══ epoch reset ════════════════════════════════════════════ */
  function reset(newSeed, newArchetype, dayRoll) {
    seed = (newSeed >>> 0) || seed;
    if (typeof newArchetype === 'string') archetype = newArchetype;
    townName = townNameFor(seed);
    rnd = stream(seed ^ 0x5bf03635);
    for (const k in cursors) delete cursors[k];
    ring.fill(-1); ringI = 0;
    history.length = 0;
    for (let i = 0; i < normalQ.length; i++) give(normalQ[i]); normalQ.length = 0;
    for (let i = 0; i < urgentQ.length; i++) give(urgentQ[i]); urgentQ.length = 0;
    lastUrgentAt = -1e9; hotUntil = 0; idleSinceMs = 0;
    countryCache = null; countryAt = -1e9; marketUntil = 0;
    // the whole town is about to be demolished and rebuilt: the occluder grid
    // that describes the old one must not survive into the new epoch
    bldRows = null; sightAt = -1e9;
    setHeadline('', '', '');
    clearItem(); clearBubbles();
    if (bar) bar.classList.remove('hot');
    paintMast();
    firstLine(!!dayRoll);                   // never leave the bar blank across a reset
  }

  function dispose() {
    window.removeEventListener('resize', paintMast);
    window.removeEventListener('resize', invalidateRect);
    if (bar) { bar.removeEventListener('mouseenter', onEnter); bar.removeEventListener('mouseleave', onLeave); }
    if (histEl && histEl.parentNode) histEl.parentNode.removeChild(histEl);
    for (let i = 0; i < bubs.length; i++) if (bubs[i].el.parentNode) bubs[i].el.parentNode.removeChild(bubs[i].el);
    bubs.length = 0; histEl = null;
  }

  /** The first headline is written SYNCHRONOUSLY — a 3 s shot must not catch an
   *  empty bar. It used to draw from DAYSTART unconditionally, both at boot and
   *  on every reset, so the very first thing a user could read at 18:19 was
   *  "Midnight passed. The town was rebuilt from scratch." — a claim about a
   *  day rollover that had not happened, and which of the two lines they got was
   *  a race with the founding post. The DAYSTART copy is good; it just has to be
   *  true, so it is now reserved for a reset that really was a calendar day. */
  function firstLine(dayRoll) {
    const now = performance.now();
    clearItem();
    for (const cat of (dayRoll ? ['DAYSTART', 'BOOT', 'CIVIC'] : ['BOOT', 'CIVIC'])) {
      const idx = pickLine(cat);
      if (idx >= 0) { show(cat, idx, cat === 'DAYSTART', 0, now); break; }
    }
    lastUrgentAt = -1e9;                    // the founding post must not be delayed by this line
  }
  firstLine(false);

  return {
    get townName() { return townName; },
    facts,
    post, say, headline, update, reset, dispose
  };
}
