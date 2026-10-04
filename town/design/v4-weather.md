# Token Town v4 — WEATHER, SEASONS & SKY

**Area owner doc.** New module `town/src/renderer/weather.js` plus small, surgical hooks in
`town.js`, `environs.js`, `buildings.js`, `npcs.js`, `news.js`, `index.html`.

Read alongside `REDESIGN-V3.md` §6 (environs), §6.6 (night), §6.7 (dt is ignored), §11 (seeds,
epoch, module contract). Everything here obeys those rules; where it changes one, it says so.

---

## 0. The pitch in four lines

1. **The sky already knows what you did.** v3 ships a two-state gag (`st.haze` / `st.cast` off
   `paceRatio`) buried inside environs. v4 promotes it to a real atmosphere layer with its own
   module, and makes it the second-loudest reward channel after the monument.
2. **Today has weather because today is a day.** Real calendar season + `daySeed` pick a
   baseline: snow in January, mist in October, thunderheads in July. Reload gives the same
   weather; tomorrow gives a different one. This is the same promise the palette makes.
3. **The weather bends to the ledger.** A burst gathers a storm. A milestone rains money. A
   long silence dries the place out — and the moment you come back, *it rains*, and the whole
   town cheers. That last beat is the best thing in this document.
4. **It is six draw calls and it survives a 1 fps headless shot**, because every particle is
   parametric on `performance.now()` and every transition is eased on the wall clock.

---

## 1. What exists today (read before you touch anything)

| Fact | Where | Consequence for us |
|---|---|---|
| `st.haze` / `st.cast` weather (boom/bust/calm), 8 s wall-clock crossfade | `environs.js:1432-1448` | **Delete and re-home into weather.js.** Keep the 8 s discipline. |
| Shared uniform bus `U` reaches ground / water / fields / blades / flora / sky / motes with one write | `environs.js:366-389` | Our channels join it the same way. One write, seven materials. |
| `uWind` already drives blade sway, field sway, cloud speed, water ripple | `environs.js:1461` and the injected chunks | Gusts are **one multiply** on an existing uniform. Free. |
| Clouds + birds are ONE instanced mesh, 54 + 42, orbit computed in the vertex shader | `environs.js:950-1043` | Overcast is `uCloudFrac`/`uCloudA`/`uCloudCol`, not new geometry. Free. |
| `fogFor(dist, biome)` is THE fog authority, clamped `0.0009 … 0.0032` | `environs.js:104-107` | We multiply the *result*, and we must respect the clamp ceiling — mist needs the clamp raised, see §7.3. |
| Buildings are **merged into vertex-coloured static meshes**; roofs share `mergedMat` | `buildings.js:519-549` | Snow on roofs **cannot** be a per-building material tweak. It must be a shader injection on world-normal.y. §8.1. |
| `matFor()` caches materials by `kind|quantHex`; `OWNED_MAT` is a live set | `buildings.js:420-433` | One retro-fit pass over `OWNED_MAT` patches every existing material; a mint hook covers the rest. |
| town.js owns sun / moon / hemi / sky dome / stars / fog colour / road plate material | `town.js:199-263, 1884-1926` | Grading is applied in exactly one place (§6.2), ~14 lines. |
| `spin` animations use `a.phase + now * a.rate` — absolute clock | `town.js:1997` | Multiplying `now` would jump. We need a **wind clock** accumulator. §6.3. |
| NPCs are 6 instanced pools (`body/head/hat/arm/disc/lamp`), 2 real lights | `npcs.js:207-216` | Umbrellas = a 7th pool. Adding one is the established idiom. |
| `lat` arrives from the feed (`msg.lat`) and drives `computeSun()` | `town.js:1621` | Southern hemisphere gets its seasons flipped for free. |
| `?hour=N`, `?seed=N`, `?tokens=N`, `?still=1`, `?demo=` test hooks | `town.js:133-146` | We add `?wx=`, `?season=`, `?moon=`. |
| Headless shots run at ~1 fps; anything a screenshot must show is `performance.now()`-driven | CLAUDE.md, §6.7 | Non-negotiable. Every formula below is `fract()`-of-wall-clock, and channels **snap** for the first 900 ms. |

**The one rule I am adding to the spec:** *weather never invents a mesh that a clear noon day
pays for.* Every weather mesh is `visible = false` at its resting value and the resting value
of a clear day is all-zero. A clear day costs **0 extra draw calls** and 8 uniform writes.

---

## 2. Module layout and the ordering constraint

```
weather.js   ← NEW. Owns: channels, the state machine, the uniform bus,
                 precip, splash, deck, mist, bow, aurora, moon. Imports THREE only.
town.js      ← sole mediator (unchanged rule). Constructs weather BEFORE environs.
environs.js  ← consumes 4 new uniforms; loses stepWeather().
buildings.js ← consumes 2 new uniforms via a one-time material patch.
npcs.js      ← consumes 3 scalars via cfg getters.
news.js      ← gains a WEATHER corpus category + 2 bubble kinds.
```

**Hard ordering (put this in a comment at the call site):**

```js
// weather.js exports a MODULE-SCOPE uniform bus, so import order alone guarantees the
// objects exist. What is NOT free is the material patch: buildings.js mints materials at
// module scope (MAT), so applyWeatherUniforms() must run before the first frame — and it
// retro-fits OWNED_MAT, so it is order-independent in practice. Belt and braces: call it
// immediately after the import block.
import { WX, initWeather, seasonOf, climateFor, moonPhase } from './weather.js';
import { applyWeatherUniforms } from './buildings.js';
applyWeatherUniforms(WX);                     // ← before initEnvirons, before any buildHouse
const env = initEnvirons(scene, plan, { ..., wx: WX });
const wx  = initWeather(scene, { daySeed, lat, quality: 'high', maxAnisotropy: MAXA,
                                 biome: env.biome, plazaPos: MON_POS });
```

`initWeather` needs `env.biome`, and `initEnvirons` needs the `WX` bus — but not the weather
*object*. So: bus → environs → weather. No cycle.

---

## 3. The channel model (the whole design in one table)

There is no weather *enum* at runtime. There are **eleven scalar channels**, each eased
independently on the wall clock. Regimes are just named target vectors. This is what makes
"never a hard cut" structurally true rather than a promise: nothing can cut, because nothing
is discrete.

```js
/**
 * @typedef {Object} WxChannels   every value 0..1 unless noted
 * @property {number} rain     falling rain intensity (streak count + splash rate)
 * @property {number} snow     falling snow intensity
 * @property {number} gold     falling tokens/coins — the reward channel
 * @property {number} cover    SETTLED snow on roofs and ground (slow; hours)
 * @property {number} wet      SETTLED water on roads and ground (fast up, slow down)
 * @property {number} cloud    overcast fraction: deck alpha + environs cloud count
 * @property {number} mist     ground mist layer + fog multiplier
 * @property {number} dust     drought haze: amber fog, desaturated ground
 * @property {number} bow      rainbow opacity
 * @property {number} aurora   aurora opacity (night only)
 * @property {number} gust     WIND, 0.35 … 2.60, resting 1.0 (NOT 0..1)
 */
```

Two derived, not eased:

* `flash` — lightning, a 90 ms impulse, written directly (§7.4).
* `moon` — `{phase, illum, ang}` from the real date, recomputed once a minute (§7.7).

### 3.1 Easing law

```js
// One critically-simple exponential approach per channel, on the WALL clock.
// tau is in ms. dtw is clamped wall-clock delta (max 500 ms) so a 1 fps frame still
// advances the right *amount*, and 12 stalled frames cannot overshoot.
const k = 1 - Math.exp(-dtw / TAU[name]);
ch[name] += (target[name] - ch[name]) * k;
```

```js
const TAU = Object.freeze({
  rain: 6000, snow: 9000, gold: 1400,          // gold arrives fast — it is a reward
  cover: 240000, wet: 12000,                   // settled state is slow…
  cloud: 8000, mist: 20000, dust: 45000,       // …drought creeps in, it does not slam
  bow: 4000, aurora: 15000, gust: 4500
});
const TAU_OUT = Object.freeze({                // asymmetric where it reads better
  gold: 5000,                                  // money stops falling reluctantly
  wet: 150000,                                 // roads stay dark long after the rain
  cover: 900000,                               // snow takes 15 min of sun to melt
  bow: 9000, mist: 40000, dust: 90000
});
// tau = (target < ch && TAU_OUT[name]) ? TAU_OUT[name] : TAU[name];
```

**The snap rule (screenshot survival).** For the first `SNAP_MS = 900` after `initWeather` and
after every `setSeed()` (epoch change), `k = 1`. A `--shot --shot-delay=7000` run therefore
lands on a *settled* sky, never 20 % through a crossfade. This mirrors environs' existing 8 s
discipline and §6.7's intent. `wx.settled === true` once the snap window closes AND every
channel is within 0.02 of target — exported for the test harness.

### 3.2 Regime table — the named target vectors

```js
export const REGIMES = Object.freeze({
  clear:     { cloud:.10, gust:1.00 },
  fair:      { cloud:.32, gust:1.00 },
  overcast:  { cloud:.82, gust:0.80 },
  drizzle:   { rain:.28, cloud:.70, gust:0.85, wet:.55 },
  rain:      { rain:.68, cloud:.88, gust:1.15, wet:.90 },
  downpour:  { rain:1.00, cloud:.96, gust:1.50, wet:1.00 },
  storm:     { rain:.85, cloud:1.00, gust:2.10, wet:1.00, thunder:1 },
  flurry:    { snow:.30, cloud:.72, gust:0.75, cover:.35 },
  snow:      { snow:.72, cloud:.90, gust:0.90, cover:.85 },
  blizzard:  { snow:1.00, cloud:1.00, gust:2.40, cover:1.00 },
  mist:      { mist:.85, cloud:.35, gust:0.45 },
  drought:   { dust:.70, cloud:.05, gust:1.25 },
  scorched:  { dust:1.00, cloud:.02, gust:1.40 },
  goldrain:  { gold:1.00, cloud:.30, gust:0.90 },   // additive overlay, see §5.3
  mintdrip:  { gold:0.14 }                          // localised, see §9.13
});
```

Unlisted keys resolve to **0**, except `gust` which resolves to `1.00` and `cover`/`wet` which
**hold their current value** (settled state is not a function of the current regime — it is
history). That last exception is the difference between "the snow melted the instant it
stopped falling" and a town that stays white all afternoon.

---

## 4. Seasons and the calendar

```js
/**
 * @typedef {Object} Season
 * @property {number} t        0..1 around the year; 0 = vernal equinox
 * @property {0|1|2|3} idx     spring | summer | autumn | winter
 * @property {string} id       'spring'|'summer'|'autumn'|'winter'
 * @property {string} label    'spring'|'high summer'|'autumn'|'deep winter'
 * @property {number} rainP @property {number} snowP @property {number} mistP
 * @property {number} stormP @property {number} droughtP @property {number} auroraP
 * @property {number} coldness 0 (Aug) … 1 (Jan) — drives snow-vs-rain and aurora
 */
/** @param {number} dateMs @param {?number} lat  @returns {Season} */
export function seasonOf(dateMs, lat);
```

Implementation, exactly:

```js
const d = new Date(dateMs);
const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);   // 1..366
let t = ((doy - 79) / 365.2422) % 1;               // 79 = ~20 March
if ((lat || 50) < 0) t = (t + 0.5) % 1;            // the feed knows where you are
const idx = Math.floor(t * 4 + 0.5) % 4;           // equinox-centred quarters
const coldness = 0.5 - 0.5 * Math.cos((t + 0.25) * TAU);   // 1 at winter solstice
```

| season | `rainP` | `snowP` | `mistP` | `stormP` | `droughtP` | `auroraP` |
|---|---|---|---|---|---|---|
| spring | .34 | .04 | .22 | .10 | .06 | .06 |
| summer | .20 | .00 | .10 | .22 | .24 | .00 |
| autumn | .36 | .03 | .34 | .08 | .06 | .12 |
| winter | .20 | .32 | .20 | .03 | .04 | .24 |

`snowP` is additionally gated on `coldness > 0.45` so a freak March snow is possible and an
August one is not. Southern-hemisphere users get January blizzards, which is correct and funny.

### 4.1 The day's climate roll — deterministic, once per `daySeed`

```js
/**
 * Today's baseline weather. Pure function of the calendar date, the day seed and the
 * biome environs already rolled — so the sky and the fields agree about what kind of day
 * it is. Reloading at 3 pm gives the same sky as at 9 am.
 * @param {number} daySeed  YYYYMMDD, from town.js §11.1
 * @param {number} dateMs   @param {?number} lat  @param {?Biome} biome  environs' own roll
 * @returns {Climate}
 */
export function climateFor(daySeed, dateMs, lat, biome);

/**
 * @typedef {Object} Climate
 * @property {Season} season
 * @property {string} base       resting regime id for the whole day
 * @property {number} intensity  0.55..1.15 multiplier on the base regime's channels
 * @property {number} windRoll   0.65..1.45 — today's prevailing wind, before gusts
 * @property {number} windDir    radians; the direction weather travels
 * @property {boolean} morningMist
 * @property {boolean} auroraTonight
 * @property {number} startCover 0..1 snow ALREADY on the roofs at open (see §4.2)
 * @property {string} label      'a clear cold morning' — for the header chip + the Crier
 */
```

Biome coupling (environs already rolled a biome from the same `daySeed`; they must not
contradict each other):

```js
mistP   *= biome.id === 'misty'    ? 2.2 : 1;
droughtP*= biome.id === 'goldrush' ? 1.7 : 1;
rainP   *= biome.id === 'spring'   ? 1.3 : biome.id === 'goldrush' ? .6 : 1;
snowP   *= biome.id === 'heather'  ? 1.2 : 1;
windRoll = biome.wind * (0.85 + r() * 0.5);       // environs already rolled 0.6-1.4
```

Selection is a single weighted draw over `{clear, fair, overcast, drizzle, rain, storm,
flurry, snow, mist, drought}` using the season table × biome multipliers, with `clear`/`fair`
absorbing the remainder (they are always ≥ 0.30 combined — most days are just days).

### 4.2 `startCover` — the screenshot rule applied to *state*

Snow cover is a 4-minute accumulator. A user opening the app on a snow day must not watch the
roofs whiten from zero; the snow has been falling since the small hours. So:

```js
// If today's BASE regime is snow-bearing, cover starts where an hour of it would have left it.
startCover = snowy ? clamp(0.35 + 0.55 * intensity, 0, 1) * fracOfDayElapsed01(dateMs) : 0;
```

`fracOfDayElapsed01` ramps 0 → 1 between 00:00 and 09:00 and holds at 1 — open the town at
07:00 and there is a dusting; open it at lunchtime and it is properly white. Snow that *starts
mid-session* accumulates honestly from wherever it was. This is the same reasoning that put
`backfillGroves` in town.js.

---

## 5. The state machine

Three layers, evaluated in order, each allowed to override the one under it. There is no
`switch`. `pick()` runs at **2 Hz** (it is compared against `now`, not `dt`), the channels ease
every frame.

```
   ┌ layer 0  BASELINE ──── climate.base + intensity                (changes once a day)
   ├ layer 1  DIURNAL ───── morning mist / afternoon cumulus / night calm   (hour-driven)
   └ layer 2  LEDGER ────── the gag: pace, idle, milestones, tier   (the loud one)
```

### 5.1 Layer 1 — diurnal

| window | effect | why |
|---|---|---|
| `sunSr - 0.7 h … sunSr + 2.4 h` and `climate.morningMist` | `mist → 0.85`, `gust → 0.45` | mist mornings are the prettiest frame the app can make |
| sun elevation crosses 0.30 | `mist → 0` over `TAU_OUT.mist` (40 s) | it burns off, it does not switch off |
| `13:00 … 18:00`, base ∈ {clear, fair} | `cloud += 0.18 * summerness` | fair-weather cumulus build; makes afternoons feel different from mornings |
| `night > 0.7` | `gust *= 0.55` | environs already drops wind at night; keep one owner — **move that multiply here** |
| `night > 0.85 && cloud < 0.25 && climate.auroraTonight` | `aurora → 0.35 + 0.65 * tokenGlow` | §9.12 |

### 5.2 Layer 2 — the ledger overrides (the point of the whole feature)

Inputs from `ctx`: `paceRatio`, `perMin`, `totalTok`, `night`, plus two town.js additions —
`ctx.idleMs` (already tracked as `idleSince`; expose it) and `ctx.monTier`.

```js
/** Hysteresis is explicit and generous: weather that flickers is worse than no weather. */
const LEDGER = [
  // id            enter                         hold      exit                  regime
  { id:'thunder',  when: pr => pr > 3.0,         dwell:45e3, until: pr => pr < 2.0, r:'storm'    },
  { id:'gather',   when: pr => pr > 1.6,         dwell:90e3, until: pr => pr < 1.1, r:'overcast+', mixK:.75 },
  { id:'scorched', when: (_,idle) => idle > 90*60e3, dwell:0, until:(_,i)=> i < 4*60e3, r:'scorched' },
  { id:'drought',  when: (_,idle) => idle > 25*60e3, dwell:0, until:(_,i)=> i < 3*60e3, r:'drought'  },
];
```

* **`dwell`** = the condition must hold continuously for this long before the regime engages.
  A single fat 5-minute bucket must not summon a thunderstorm.
* **`until`** = the *exit* predicate, deliberately far from the entry predicate. Enter a
  gathering storm at `pr > 1.6`; leave it only under `1.1`.
* `overcast+` means `REGIMES.overcast` blended `mixK` of the way over the baseline — a boom on
  a snow day gives you a **snow squall**, not a substitution. Blending, not replacing, is what
  keeps the season legible under the gag.

**Precipitation follows the storm.** A `gather`/`thunder` regime raises `cloud` but only adds
`rain` if `season.coldness < 0.55` — otherwise it adds `snow`. Boom weather in January is a
blizzard. This is one line and it is worth ten.

### 5.3 Impulses (not regimes — additive overlays with their own clocks)

```js
/** @param {'milestone'|'tierUp'|'best'|'boot'|'resume'|'landmark'} kind @param {object} [data] */
wx.event(kind, data);
```

| event | fired from | effect |
|---|---|---|
| `milestone` | `town.js:fireMilestone` | `gold` impulse → 1.0, hold 14 s, release over `TAU_OUT.gold`. Arms a rainbow (§9.11) if daylight. |
| `best` | same | as `milestone` plus `gust → 1.6` for 6 s: the flags snap. |
| `tierUp` | `fireMilestone` | if `data.tier >= 8`, latch the **Mint cloud** (§9.13) permanently for this epoch. |
| `landmark` | `placeLandmark` | 4 s `gold` at 0.35 over the landmark site only. |
| `resume` | town.js when `applyBuckets` sees growth **and** `dust > 0.35` | **THE RAIN AFTER THE DROUGHT.** See below. |
| `boot` | `startRitual(full)` | snap window re-arms; on a `goldrain` day the founding gets 3 s of gold. |

**`resume` — the best moment in the feature.** You walked away, the town dried out, the ground
cracked, the Crier got sarcastic. You come back, one bucket lands, and:

```
t=0.0s   dust target → 0, cloud → 0.85 (tau forced to 2500 ms — this ONE transition is fast)
t=0.6s   rain → 0.75, gust → 1.4
t=1.2s   news.post('weather', {id:'firstrain'})   "Rain at last. The Bureau credits the Mint."
t=1.5s   npcs.celebrate(ctx.bounds centre, {runners: 6, cheerRadius: 999})
t=6.0s   rain eases to the baseline regime; wet stays at 1.0 for two minutes
t=8.0s   if daylight and sun elevation in [.06,.50] → bow → 0.8 for 45 s
```

That is: you were punished with dust, and the app throws a rainbow at you for coming back.
Ranked **MUST**.

### 5.4 The resolved target

```js
function resolveTarget(now, ctx) {
  const T = Object.assign({}, ZERO, { gust: 1, cover: ch.cover, wet: ch.wet });
  blend(T, REGIMES[climate.base], climate.intensity);      // layer 0
  applyDiurnal(T, now, ctx);                               // layer 1
  const led = activeLedger(now, ctx);                      // layer 2
  if (led) blend(T, REGIMES[led.r], led.mixK == null ? 1 : led.mixK);
  applyImpulses(T, now);                                   // additive, clamped
  // settled state is integrated, never targeted directly
  T.wet   = Math.max(T.wet,   clamp(ch.rain * 1.2, 0, 1));
  T.cover = clamp(ch.cover + (ch.snow > .05 ? dtw / 240e3 : -dtw / 900e3) * (1 - ch.rain), 0, 1);
  T.gust  = clamp(T.gust * climate.windRoll * (1 - .45 * ctx.night), .35, 2.6);
  return T;
}
```

Note `cover` melts under `rain` as well as under time — a warm front after a snowfall clears
the roofs in about four minutes, which reads exactly right.

---

## 6. `weather.js` public API — copy verbatim

```js
/* ═══ the uniform bus ═══════════════════════════════════════════
   Plain {value} objects, module-scope, shared by reference with environs (its U dict),
   buildings (its material patch) and weather's own materials. One write reaches
   everything. This is the environs idiom (§6.7) applied across module boundaries. */
export const WX = Object.freeze({
  uWet:   { value: 0 },      // 0..1  settled water: darker albedo + grazing sheen
  uCover: { value: 0 },      // 0..1  settled snow: whitens upward-facing faces
  uGust:  { value: 1 },      // .35..2.6  multiplies environs' uWind
  uDust:  { value: 0 },      // 0..1  drought desaturation on ground + fields
  uWxT:   { value: 0 },      // performance.now(), the ONE clock for all weather motion
  uWindV: { value: new THREE.Vector2(1, 0) },   // unit heading weather travels
  uFlash: { value: 0 }       // 0..1  lightning, 90 ms impulse
});

/** @param {number} dateMs @param {?number} lat @returns {Season} */          export function seasonOf(dateMs, lat);
/** @param {number} daySeed @param {number} dateMs @param {?number} lat @param {?Biome} biome @returns {Climate} */
                                                                              export function climateFor(daySeed, dateMs, lat, biome);
/** Real synodic phase. @param {number} dateMs
 *  @returns {{phase:number, illum:number, waxing:boolean, name:string}} */    export function moonPhase(dateMs);
export const REGIMES;                                                       // frozen Record<string, Partial<WxChannels>>
export const WX_LABEL;                                                      // frozen Record<regimeId, {glyph, chip, crier}>

/**
 * @typedef {Object} WeatherCfg
 * @property {number} daySeed          §11.1 — palette/biome/weather all share it
 * @property {?number} lat             from the feed; flips seasons below the equator
 * @property {'high'|'low'} [quality]
 * @property {number} [maxAnisotropy]
 * @property {?Biome} biome            environs' own roll, so the two agree
 * @property {THREE.Vector3} plazaPos  the Mint cloud's anchor
 */
/**
 * @typedef {Object} WxGrade   how town.js must grade the scene THIS FRAME
 * @property {number} sunMul     × directional sun intensity        0.18 … 1.10
 * @property {number} hemiMul    × hemisphere intensity             0.75 … 1.35
 * @property {number} moonMul    × moon light (carries the phase)   0.15 … 1.25
 * @property {number} fogMul     × fogFor()'s density               0.85 … 4.20
 * @property {number} fogTint    0xRRGGBB the fog colour is pulled toward
 * @property {number} fogTintK   0 … 0.55
 * @property {number} skyTintK   0 … 0.70   how far the sky dome desaturates to slate
 * @property {number} starMul    × star opacity                     0.05 … 1.00
 * @property {number} sunBallA   × sun ball + halo opacity          0.00 … 1.00
 * @property {number} shadowMul  × shadow contrast (via sun colour) 0.30 … 1.00
 * @property {number} wetK       0 … 1   road plate darkening
 * @property {number} windMul    0.35 … 2.60  the windmill/flag clock multiplier
 * @property {number} flash      0 … 1   this frame's lightning
 */
/**
 * @typedef {Object} Weather
 * @property {THREE.Group} group
 * @property {WxChannels} ch          LIVE, mutated in place. Read only.
 * @property {WxGrade} grade          LIVE, mutated in place. Read only.
 * @property {string} id              dominant regime id, for chrome + the Crier
 * @property {string} label           'a gathering storm'
 * @property {string} glyph           '🌧' — one char for the header chip
 * @property {Climate} climate
 * @property {boolean} settled        channels are within 0.02 of target (test harness)
 * @property {(dt:number, now:number, ctx:TownCtx)=>void} update   dt IS IGNORED
 * @property {(kind:string, data?:object)=>void} event
 * @property {(daySeed:number, dateMs:number, lat:?number, biome:?Biome)=>void} setSeed
 * @property {(q:'high'|'low')=>void} setQuality
 * @property {()=>Array<{w:number,text:string}>} news
 * @property {(x:number,z:number)=>number} wetnessAt      npcs asks: puddle here?
 * @property {()=>void} dispose
 */
/** @param {THREE.Scene} scene @param {WeatherCfg} cfg @returns {Weather} */
export function initWeather(scene, cfg);
```

### 6.1 Test hooks (`town.js` query params, parsed in weather.js)

| param | effect |
|---|---|
| `?wx=storm` | pin the regime; ledger + diurnal disabled; snaps instantly |
| `?wx=snow&wxi=1` | pin regime **and** intensity |
| `?season=winter` | pin the season, leave the roll alone |
| `?moon=0.5` | pin the phase (0 new, .5 full) |
| `?wxcover=0.8` | pin settled snow (screenshot the roofs without waiting 4 min) |
| `window.__wx` | `{ set(id), ch, grade, climate, settled }` for the harness |

The existing `--shot` harness gets a one-liner: `npx electron . --shot=... --shot-delay=7000`
already loads `index.html`; the params ride on the same URL the shot mode builds.

### 6.2 town.js integration — the entire diff, ~26 lines

```js
// in tick(), AFTER the existing sun/sky block and BEFORE env.update:
ctx.idleMs = idleSince ? simNow - idleSince : 0;      // NEW ctx field
ctx.monTier = monument.tier;                           // NEW ctx field
wx.update(dt, now, ctx);
const G = wx.grade;

sun.intensity   *= G.sunMul;
hemi.intensity  *= G.hemiMul;
moon.intensity  *= G.moonMul;                          // the phase is IN moonMul
sunBall.material.opacity = G.sunBallA;                 // (sunBall needs transparent:true)
sunHalo.material.opacity *= G.sunBallA;
sunBall.visible = sunHalo.visible = day > .02 && G.sunBallA > .02;
skyMat.uniforms.top.value.lerp(SKY.slate, G.skyTintK);
skyMat.uniforms.bot.value.lerp(SKY.slate, G.skyTintK * .8);
scene.fog.color.copy(bot).lerp(_wxc.setHex(G.fogTint), G.fogTintK);
scene.fog.density = fogFor(dist, env.biome) * G.fogMul;   // ← also in refreshFraming
for (const m of starMats) m.opacity = m.userData.peak * Math.pow(night, 1.4) * G.starMul;
roadMat.color.setScalar(1 - .26 * G.wetK);
roadMat.roughness = .95 - .40 * G.wetK;
// lightning: a CSS white-out, not a light — see index.html §6.4
if (G.flash !== lastFlash) { document.documentElement.style
  .setProperty('--flash', G.flash.toFixed(3)); lastFlash = G.flash; }
```

Order matters: `wx.update` **before** `env.update`, because environs reads `WX.uGust` and its
own `fog.color` sampling happens inside `env.update`. And `fogFor(...) * G.fogMul` must also be
applied in `refreshFraming()` (`town.js:349`) or a re-frame will stamp the mist away.

**The `fogFor` clamp.** `fogFor` clamps at `0.0032`. Mist wants ~`0.011`. Options: (a) multiply
outside the clamp as above — correct, and it is what the diff does; (b) raise the clamp. Take
(a): `fogFor` stays "the fog authority for *clear-air aerial perspective*", weather is a
declared multiplier on top of it. Document that sentence in `fogFor`'s JSDoc.

### 6.3 The wind clock (windmills, flags, sails)

`town.js:1997` is `a.obj.rotation[a.axis] = a.phase + now * a.rate`. Multiplying `now` by wind
teleports the sails whenever wind changes. Accumulate instead:

```js
// module scope
let windClock = 0, windLast = performance.now();
// in tick(), right after wx.update:
windClock += (now - windLast) * wx.grade.windMul; windLast = now;
// in the animEnts loop:
if (u.spin) for (const a of u.spin) a.obj.rotation[a.axis] = a.phase + windClock * a.rate;
if (u.sway) for (const a of u.sway) a.obj.rotation[a.axis] =
  a.amp * (0.55 + 0.55 * wx.grade.windMul) * Math.sin(windClock / a.period);
```

`windClock` is wall-clock-derived, so a headless run still shows sails at a plausible angle,
and a storm visibly spins them 2.1× faster. Flags snapping in a gust is pure profit for one
multiply. **Do not** apply `windMul` to `monument.js`'s own spins — the altar is indoors,
conceptually; its sky ring is machinery, not weather.

### 6.4 `index.html` additions (3 rules + 1 span)

```css
:root{ --flash:0; --wet:0 }
/* Lightning is a compositor white-out, not a light: a DirectionalLight spike costs a
   full shadow re-render on the ONE frame that must not stall, and CSS runs on the
   compositor's own clock — the same reasoning that moved the founding plate's fade. */
.stage::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:1;
  background:#EAF0FF;opacity:calc(var(--flash) * .55);mix-blend-mode:screen}
#wxChip{font-variant-emoji:text}
```

Header: `<span class="chip" id="wxChip">☀ clear</span>` next to `#rangeBadge`. town.js writes
`wxChip.textContent = wx.glyph + ' ' + wx.label` on the 500 ms stats tick. Free, and it is the
one place the user can *read* what the sky is doing.

---

## 7. The meshes — exact specs

Draw-call budget: **6 maximum simultaneously visible**, enforced (§7.8).

### 7.1 `precip` — rain + snow + gold in ONE draw

* **Geometry** `InstancedBufferGeometry` from a `PlaneGeometry(1,1)`. `N_PRECIP = 1800`
  (`low`: 700). Attributes: `aCell` (vec3, uniformly-random in a unit cylinder ×
  [0,1] height), `aRnd` (float).
* **Volume**: a *camera-anchored* column, radius `R = 46`, height `H = 34`, so precipitation is
  always around the eye regardless of a 30-house or 1200-house framing. `uEye` = camera
  position, written once per frame.
* **Vertex shader (the whole trick):**

```glsl
float fall  = fract(aCell.y + uWxT * uSpeed * (0.72 + 0.56 * aRnd));
float y     = uH * (1.0 - fall);
vec3  base  = vec3(uEye.x + aCell.x * uR, y, uEye.z + aCell.z * uR);
base.xz    += uWindV * (uH - y) * uSlant * uGust;          // slant grows with the fall
// pick this instance's KIND by where aRnd falls in the stacked bands. Because the bands
// grow and shrink continuously, rain→snow reads as a turnover, never a swap.
float on = step(aRnd, uRain + uSnow + uGold);
float kSnow = step(uRain, aRnd) * step(aRnd, uRain + uSnow);
float kGold = step(uRain + uSnow, aRnd) * on;
```

* **Rain instance**: quad `0.030 × (0.85 + 1.7·aRnd)` units, stretched along the *screen*
  projection of the fall direction (billboard, then rotate by the slant); alpha ramp along y so
  the head is bright and the tail vanishes. `uSpeed = 0.00042` (≈ 14 u/s). Colour
  `mix(uFogCol, 0xC8D6E8, 0.55)` by day, `mix(uFogCol, 0x8FA0BC, 0.35)` at night, alpha
  `0.34 * uRain`.
* **Snow instance**: quad `0.11 × 0.11`, soft round alpha, `uSpeed × 0.11`, plus sway
  `base.x += sin(uWxT*0.00072 + aRnd*41.0) * 0.85` and a slow tumble in the alpha lobe. Colour
  `0xF2F6FF`, alpha `0.85 * uSnow`.
* **Gold instance**: a rotating rhombus `0.20 × 0.20`, colour `GOLD_HI 0xF3D07A`,
  `blending: Additive` — implemented as *the same material* with `gl_FragColor.a` premultiplied
  and `blending: NormalBlending` so we do not need a second draw. Falls at `uSpeed × 0.55`,
  spins on `uWxT * 0.004 + aRnd * 6.3`, and gets a specular twinkle
  `pow(max(sin(uWxT*0.006 + aRnd*30.0),0.0), 8.0)`.
* **Near fade**: `alpha *= smoothstep(1.6, 7.0, distance(base, uEye))` — no streaks smeared on
  the lens.
* **Material**: `ShaderMaterial{ transparent:true, depthWrite:false, depthTest:true,
  side:DoubleSide, fog:false }`. `depthTest:true` matters — rain is correctly occluded by
  buildings, which is most of what sells it.
* `visible = (rain + snow + gold) > 0.004`. **1 draw.**

### 7.2 `splash` — ripples, and the reason night rain is beautiful

* Instanced `PlaneGeometry(1,1)` laid flat, `N_SPLASH = 240` (`low`: 90), on a camera-anchored
  disc of radius 34, at `y = 0.055` (above the road plate's `0.02`, below the lamp pools' `0.04`
  — check: pools are at `.04`, so use `y = 0.07` and `renderOrder = 3`).
* Per instance: `ph = fract(uWxT * 0.0017 + aRnd * 7.13)`; ring radius `0.14 + ph * 0.78`;
  alpha `(1 - ph)^2.2 * uRain * uOn` where `uOn = step(aRnd, uRain)` — so the *number* of
  ripples scales with intensity, not just their opacity.
* Fragment: a 1-pixel-soft ring, `alpha *= smoothstep(0.5,0.42,abs(len-r))`.
* **Night**: ripple colour lerps from `0xBFD2E4` to the lamp gold `0xFFC46B` as `uNight` rises,
  and alpha ×1.35. Ripples under street lamps twinkle. This is the single cheapest piece of
  delight in the document.
* Snow gets ripples too, at `uSnow * 0.25`, as a soft *dust puff* rather than a ring
  (`ph` slower, ring softer). Same draw.
* `visible = (rain > 0.05 || snow > 0.25)`. **1 draw.**

### 7.3 `mist` — the morning layer

* 64 (`low`: 0 — mist is the first thing to go) Y-billboarded soft quads, one instanced mesh,
  sizes 26–70 units, `y ∈ [0.9, 3.4]`, scattered on a camera-anchored annulus `r ∈ [8, 130]`,
  drifting on `uWxT * 0.000035 * uWindV`.
* Fragment: a very soft horizontal-elongated blob, colour = the live fog colour brightened 18 %,
  alpha `0.085 * uMist` each. Overlapping 64 of them at 0.085 gives a genuine layered
  ground-fog that houses stand *in*, which no amount of `FogExp2` can do.
* Also drives `grade.fogMul = 1 + 2.6 * mist` and `grade.fogTint = 0xD8DEE4, fogTintK = .35 * mist`.
* `visible = mist > 0.02`. **1 draw.**

### 7.4 `deck` — the storm ceiling and the lightning

* Geometry: `SphereGeometry(640, 28, 8, 0, TAU, 0, 0.66)` (a cap from the zenith down to ~52°
  elevation), `side: BackSide`. It sits *inside* the sky dome (820) and *above* environs'
  cloud orbits (120–260 world, but those ride up with the camera; at the widest framing the
  camera is at ~360 y, so the cap at 640 radius still reads as ceiling). Cheap 2-octave
  analytic noise, no texture:

```glsl
float n = 0.55 * vnoise(vDir.xz * 2.3 + uWxT * 0.000012 * uWindV)
        + 0.30 * vnoise(vDir.xz * 5.7 - uWxT * 0.000021 * uWindV);
float a = uCloud * smoothstep(0.30, 0.86, n) * rimFade;   // rimFade → 0 at the cap edge
vec3  c = mix(vec3(0.62,0.66,0.72), vec3(0.16,0.18,0.22), uCloud) * (1.0 - 0.55 * uNight);
// the flash lights the cloud FROM INSIDE, at a seeded azimuth
float d = distance(vDir.xz, uBolt.yz);
c += vec3(0.9,0.94,1.0) * uBoltA * exp(-d * d * 6.0);
```

* **Lightning is the cloud lighting up, not a polyline.** It is prettier, it is one uniform,
  and it cannot look like a bug. Schedule: while `thunder` is active, a strike every
  `6 + rand*8` seconds; each strike is a 3-flicker envelope over 220 ms:
  `uBoltA = [0.9, 0.35, 1.0, 0.2, 0.55] sampled on the WALL CLOCK`, plus `grade.flash` peaking
  at `0.75 * (0.4 + 0.6*night)` for 90 ms.
* Thunder rumble: none (the app is silent). Instead, `npcs` gets a `startle` impulse 400 ms
  after the flash — everyone's walk speed jumps for 1.2 s (§8.3). Cheap, funny, and it sells
  the sound that isn't there.
* `visible = cloud > 0.12`. **1 draw.**

### 7.5 `bow` — the rainbow

* One camera-facing quad, 300 × 170 units, centred at the **anti-solar point** (the sun's
  azimuth + π, elevation `-sunEl`), pushed out to `r = 520`. Fragment paints the arc:

```glsl
float d = length((vP - vec2(0.0, -0.62)) * vec2(1.0, 1.0));   // circle centred below frame
float band = smoothstep(0.72, 0.735, d) * (1.0 - smoothstep(0.79, 0.805, d));
vec3 col = spectrum(clamp((d - 0.735) / 0.055, 0.0, 1.0));    // 6-stop ramp, no texture
float a = band * uBow * 0.26;
// the SECONDARY bow: fainter, reversed, 1.30x radius — the detail that makes people point
float d2band = smoothstep(0.955,0.97,d) * (1.0 - smoothstep(1.02,1.035,d));
col += spectrum(1.0 - clamp((d - 0.97)/0.05, 0.0, 1.0)) * 0.0;   // (see note)
a += d2band * uBow * 0.09;
```

  `blending: Additive`, `depthWrite:false`, `fog:false`.
* **Trigger**: `rain` falls below 0.15 having peaked above 0.40 within the last 3 min; day;
  `sunEl ∈ [0.06, 0.50]`; `cloud < 0.80`. Also fired unconditionally 8 s after a `resume`
  event, and 6 s after a `milestone` fired in daylight (a rainbow *is* a reward).
* Lifetime: fade in 4 s, hold 45 s, fade out 9 s (`TAU_OUT.bow`).
* `visible = bow > 0.01`. **1 draw.**

### 7.6 `aurora` — cold clear nights

* `CylinderGeometry(430, 430, 240, 40, 4, true)` open-ended, `side: BackSide`, but only the
  northern ~120° is opaque (fade the rest in the fragment by azimuth) — a curtain across one
  side of the sky, not a tube around the town.
* Fragment: vertical ramp × three scrolling noise columns at different speeds; the classic
  palette `mix(0x3BE39A, 0x6E6BE0, ramp)` with a `0xB8FFE0` rim at the bottom edge.
  `blending: Additive`, alpha ≤ `0.42 * night * uAurora`.
* **The gag**: `tokenGlow = clamp(log10(max(T,1e6) / 1e6) / 3.2, 0, 1)` — a 1 B day makes the
  aurora *twice as bright and one hue greener* than a 5 M day. On a milestone at night, the
  aurora flares to 1.0 for 8 s. The sky celebrates with you, silently, and only you know why.
* `visible = aurora > 0.01`. **1 draw.**

### 7.7 `moon` — real phase from the real date

```js
/** Conway-style synodic approximation, ±0.5 day over a century. Good enough for a toy,
 *  and it is RIGHT tonight, which is the whole point. */
export function moonPhase(dateMs) {
  const SYN = 29.530588853, EPOCH = Date.UTC(2000, 0, 6, 18, 14);   // a known new moon
  const phase = (((dateMs - EPOCH) / 864e5) / SYN) % 1;
  const p = phase < 0 ? phase + 1 : phase;
  return { phase: p, illum: 0.5 - 0.5 * Math.cos(p * Math.PI * 2), waxing: p < 0.5,
           name: MOON_NAMES[Math.round(p * 8) % 8] };
}
const MOON_NAMES = ['new','waxing crescent','first quarter','waxing gibbous',
                    'full','waning gibbous','last quarter','waning crescent'];
```

* One quad, 34 units, on a fixed dome radius 700, at the **anti-solar** azimuth with a
  `+0.22 rad` inclination offset so it is not perfectly opposite. Fragment: a disc, minus a
  second disc offset by `(1 - 2*illum) * 1.05` in x (flipped by `waxing`) — a real terminator
  in four instructions. Plus a `0.18` halo lobe that thickens with `cloud` (a ring round the
  moon before rain: an actual folk-weather signal, and free).
* `grade.moonMul = 0.28 + 0.95 * illum` feeds town.js's existing `moon` DirectionalLight.
  **A new-moon night is genuinely darker than a full-moon night.** Twelve lines, and the town
  has a lunar cycle.
* `visible = night > 0.15 && cloud < 0.92`. **1 draw.**

### 7.8 The budget enforcer

```js
// Priority order, highest first. If more than MAX_DRAWS want to be visible, the tail is
// hidden. This is a hard invariant, not a hope: the ceiling in §6.4 of the v3 spec is
// 8 draws for the whole countryside and weather must not quietly double it.
const MAX_DRAWS = 6;
const PRI = [precip, splash, deck, mist, aurora, bow, moonQ];
function budget() {
  let n = 0;
  for (const m of PRI) { const w = m.userData.want; m.visible = w && ++n <= MAX_DRAWS; }
}
```

In practice the exclusions make this near-unreachable: `mist` is a calm-morning state and
`deck` needs `cloud > 0.12`; `bow` is daytime and `aurora` is night; `moon` is night. The
worst honest case is a night blizzard with a bright moon = precip + splash + deck + moon = 4.

---

## 8. Cross-module hooks

### 8.1 `buildings.js` — snow on roofs, wet on walls (**the one shader injection**)

```js
/** Wire the weather uniform bus into every material this module has minted or will mint.
 *  Called ONCE by town.js before the first frame. Idempotent.
 *  @param {typeof WX} U */
export function applyWeatherUniforms(U) {
  WXU = U;
  for (const m of OWNED_MAT) patch(m);       // MAT, matFor's cache, stripeMats, mergedMat
}
function patch(m) {
  if (!WXU || m.userData.wxPatched) return;
  m.userData.wxPatched = true;
  m.onBeforeCompile = s => {
    s.uniforms.uCover = WXU.uCover; s.uniforms.uWet = WXU.uWet;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN; varying vec3 vWP;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWN = normalize(mat3(modelMatrix) * objectNormal);
        vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCover; uniform float uWet;\nvarying vec3 vWN; varying vec3 vWP;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // SNOW settles on what faces the sky. The dither keeps it from being a flat wash —
        // a low-poly roof with a uniform white top reads as a bug, not as snow.
        float sn = smoothstep(0.46, 0.88, vWN.y) * uCover;
        sn *= 0.70 + 0.30 * sin(vWP.x * 3.7) * sin(vWP.z * 3.1);
        sn *= 1.0 - 0.55 * smoothstep(0.0, 1.4, vWP.y);   // eaves and walls stay clear-ish
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.925, 0.945, 0.985), clamp(sn, 0.0, 1.0));
        // WET darkens everything a little and the ground-facing faces most.
        diffuseColor.rgb *= 1.0 - 0.17 * uWet * (0.55 + 0.45 * (1.0 - vWN.y));`);
  };
  m.customProgramCacheKey = () => 'wx1';       // one variant for the whole town
  m.needsUpdate = true;
}
// and in matFor()/stripeMat()/mergedMat(): `patch(m)` right after the cache miss mints it.
```

Cost: 2 varyings, ~12 ALU in the fragment, **zero** draw calls, and it works through the static
merge because it keys off world normal, not material identity. The `vWP.y` term is why a
Cottage gets a white roof and white eaves but keeps its walls — snow that ignores height reads
as paint.

`vWN.y > 0.46` also whitens the **road plate** if we patch `roadMat` (town.js owns it) —
do that too, at 0.6× strength, or the streets stay green in a blizzard.

**Sizes**: S per material family, M total including the retro-fit and the `nomerge` audit.

### 8.2 `environs.js` — four uniform reads, one deletion

```js
// 1. accept the bus
export function initEnvirons(scene, plan, opts = {}) {
  const WXU = opts.wx || null;
  ...
  if (WXU) Object.assign(U, { uWet: WXU.uWet, uCover: WXU.uCover, uDust: WXU.uDust });
```

* **Delete `stepWeather()`** (`:1432-1448`) and the `st.haze/st.cast/st.wxFrom/st.wxTo/st.wxAt/
  st.slowSince/st.wx` state. Replace their four consumers:
  * `U.uWind.value = b.wind * WXU.uGust.value * (1 - .6*night)` — the `st.cast` term goes; gust
    already carries it. (Keep the night term **or** move it to weather's diurnal layer — pick
    weather, and delete it here, so there is one owner. §5.1.)
  * `U.uCloudA.value = lerp(.85, .18, night) * (1 - .28 * WXU.uDust.value)`
  * `U.uCloudFrac.value = clamp(.58 * b.clouds + .40 * cloudChannel, .12, 1)` — needs the
    `cloud` channel, so add `uCloud` to the bus (a 8th uniform; harmless).
  * the `fog.color.lerp` block at `:1470-1475` — **weather owns fog tinting now** (§6.2). Keep
    only `U.uFog.value.copy(fog.color)`.
* **Ground shader** (`:666-678`), add after the cloud-shadow line:
  ```glsl
  // settled snow on the countryside, and drought bleaching
  float g = smoothstep(0.0, 1.0, uCover);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90,0.93,0.98), g * 0.92);
  diffuseColor.rgb *= 1.0 - 0.20 * uWet;
  float lum = dot(diffuseColor.rgb, vec3(0.3,0.5,0.2));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(1.10,1.02,0.86), uDust * 0.55);
  ```
* **Water shader** (`:764`): `envRipple(..., 0.4 + 0.6*uWind)` already scales with wind; add
  `* (1.0 + 1.6 * uRain)` for rain-pocked water. One multiply, one new uniform.
* **Fields/blades**: nothing. They already ride `uWind`, which now carries gusts.
* `news()`: drop the `st.haze/st.cast` lines (weather owns weather copy now, §8.4).

**Size**: M. Touches ~40 lines across 6 sites. This is the file with the highest collision risk
— schedule it against nothing else.

### 8.3 `npcs.js` — umbrellas, hurry, startle

```js
// cfg additions (getters, so npcs never holds a stale value)
const npcs = initNPCs(scene, { ...,
  wxRain: () => wx.ch.rain, wxSnow: () => wx.ch.snow, wxGust: () => wx.grade.windMul });
```

1. **Umbrella pool.** `G.brolly = new THREE.ConeGeometry(0.34, 0.20, 8)` + `IM.brolly =
   mk(G.brolly, M.brolly, MAX, 1)` — a 7th instanced draw, tinted per villager from the same
   wardrobe palette. A villager carries one when `srand(n.seed * 3.7) < rain` (so the count
   ramps *with* intensity), positioned at `head + 0.30`, tilted `atan(0.16 * gust)` into
   `uWindV`. `IM.brolly.count` is the carrier count; non-carriers are simply not written.
2. **Snow**: no umbrellas below `rain`; instead `srand(n.seed*5.1) < snow*0.25` villagers stop
   for 2.5 s and `sEff` bobs — looking up. And **the lantern pool comes out in a storm**:
   `nLamp` currently keys off `night`; make it `night || cloud > 0.85` so a thunderstorm at
   noon has people carrying lights. Gorgeous, and it is one boolean.
3. **Gait**: `speed *= 1 + 0.30 * rain - 0.22 * snow` (hurry in rain, trudge in snow). At
   `rain > 0.75`, 30 % of `stroll` villagers convert to `home` — the streets *empty*, which is
   the strongest single signal that the weather is real.
4. **Startle** (`wx` → town.js → `npcs.startle()`): 400 ms after a lightning flash, every
   villager's speed ×1.6 for 1.2 s and `spokeAt` resets so the bubble sampler picks someone
   with something to say about it.

**Size**: M. New export: `startle()`.

### 8.4 `news.js` — the Bureau of Weather

* `CAT_OF.weather = 'WEATHER'`; `URGENT.weather = 1` for `firstrain`/`bolt`/`bow` only.
* New corpus category `WEATHER` (~34 lines) keyed on `{id}` slots. Copy, ranked by how much I
  want to see it:

```
firstrain  "Rain at last. The Bureau of Weather credits the Mint and refuses to elaborate."
firstrain  "Rain on the high road. Somebody has started working again."
firstrain  "The drought is declared over, retroactively, as of four minutes ago."
gather     "The sky over the plaza is thickening. The Bureau advises everyone to keep going."
gather     "Cloud building from the west at the same rate as the ledger. Coincidence unproven."
thunder    "Thunder over the Mint. Not one villager has looked up from their work."
thunder    "Lightning struck the {landmark}. The {landmark} is fine. It has seen worse days."
bolt       "That one was close. The Bureau has revised its advice to: keep going, but faster."
goldrain   "It is raining money. Officially, meteorologically, this is weather."
goldrain   "Coins in the gutters. The street sweepers have requested a larger broom."
drought    "Dust on the high road. The Mint has struck nothing for {minutes} minutes."
drought    "The well is fine. The well is always fine. It is the *sky* we are worried about."
scorched   "The riverbed is now a rumour. The Bureau recommends sending tokens."
snow       "Snow on every roof in {name}. {buildings} chimneys, all of them smoking."
snow       "Snow settling. The masons have declared a holiday and gone to the tavern."
blizzard   "Blizzard. Visibility: poor. Morale: unaccountably excellent."
mist       "Mist off the low ground until noon. Distances are not to be trusted today."
mist       "The far fields have gone missing. They are expected back by eleven."
bow        "A rainbow over the plaza. The Bureau has no explanation and does not want one."
bow        "Double rainbow above the {landmark}. The Crier is having a moment."
aurora     "Lights over the north field tonight, and they are the exact colour of money."
aurora     "The sky is showing off. So, frankly, is the ledger: {tokStr}."
moonfull   "Full moon over {name}. Everything is silver and nobody is asleep."
moonnew    "New moon. The lamps are the only argument against the dark tonight."
clearcold  "Clear and cold. The kind of morning that makes a number look bigger."
```

* Two new bubble kinds in `bubText`: `'rain'` (`"my hat!"`, `"typical"`, `"good for the crops"`,
  `"the ledger doesn't care"`) and `'snow'` (`"first snow!"`, `"mind the ice"`, `"it's sticking!"`).
  town.js's `BUB_WANT` rotation gains a weather slot when `rain + snow > 0.3`.
* `wx.news()` returns weighted country lines the same way `env.news()` does, and town.js passes
  **both** into `initNews({ country: () => env.news().concat(wx.news()) })`.

**Size**: S.

---

## 9. Ranked backlog

Sizes: **S** ≤ ~120 lines / half a session · **M** ~120-350 · **L** ~350+ or high-risk.
"Touches" lists every file an implementer will open — the showrunner schedules off this column.

### MUST

| # | Item | Size | Touches |
|---|---|---|---|
| **W1** | **`weather.js` skeleton**: channels, easing law + snap rule, `REGIMES`, `seasonOf`, `climateFor`, `moonPhase`, the `WX` bus, `grade` computation, `update/setSeed/event/news/dispose`, test hooks. **No meshes.** Ships a working sky-grading-only weather system: clouds thicken, sun dims, fog tints, wind gusts. | L | `weather.js` (new) |
| **W2** | **town.js integration**: the 26-line grade block (§6.2), the wind clock (§6.3), `ctx.idleMs`/`ctx.monTier`, ordering, `#wxChip`, `--flash`, `hardReset` → `wx.setSeed`, `applyInit` → `wx.event('boot')`, `fogFor × fogMul` in `refreshFraming` too. | M | `town.js`, `index.html` |
| **W3** | **Precip mesh** (rain + snow + gold, 1 draw) **and splash ripples** (1 draw), incl. night lamp-gold ripples and the near-camera fade. | L | `weather.js` |
| **W4** | **environs handover**: delete `stepWeather`, wire `uGust/uCloud/uWet/uCover/uDust/uRain`, hand fog tinting to weather, rain-pocked water. | M | `environs.js` |
| **W5** | **Ledger reactivity**: gather / thunder / drought / scorched with dwell+hysteresis, the `milestone` gold impulse, and **`resume` — the rain after the drought** with its 8-beat choreography (§5.3). | M | `weather.js`, `town.js` (2 event calls) |
| **W6** | **Settled state shaders**: snow cover + wet albedo injected into buildings' materials and environs' ground; `startCover` so a snow day opens white. | M | `buildings.js`, `environs.js`, `town.js` (roadMat) |

W1 → W2 must land before anything else; W3/W4/W5/W6 are independent of each other once W1+W2
exist and can go to four parallel implementers.

### SHOULD

| # | Item | Size | Touches |
|---|---|---|---|
| **W7** | **Storm deck + cloud-flash lightning** (§7.4), the `--flash` white-out envelope, the strike scheduler. | M | `weather.js`, `index.html` |
| **W8** | **Morning mist layer + burn-off** (§7.3), plus `mistP` biome coupling with `misty`. | M | `weather.js` |
| **W9** | **NPC weather**: umbrella pool, gait, streets emptying in a downpour, lanterns at noon under a thunderhead, `startle()`. | M | `npcs.js`, `town.js` |
| **W10** | **Moon phase** (§7.7): the quad, the terminator, the halo before rain, `grade.moonMul` into the existing moon light. | S | `weather.js`, `town.js` |
| **W11** | **The Crier learns weather**: `WEATHER` corpus, `weather` event type, `rain`/`snow` bubble kinds, `country: env+wx`. | S | `news.js`, `town.js` |
| **W12** | **Rainbow** (§7.5), incl. the secondary bow and the post-`resume` / post-milestone triggers. | S | `weather.js` |
| **W13** | **Hover receipt for the sky**: `tipFor({kind:'weather'})` on a click-through region, or simpler — hovering `#wxChip` shows `["A gathering storm", "wind 2.1× · cloud 88% · since 14:32", "the Mint is running hot"]`. | S | `town.js`, `index.html` |

### COULD

| # | Item | Size | Touches |
|---|---|---|---|
| **W14** | **Aurora** (§7.6) with `tokenGlow` brightness and the milestone flare. | M | `weather.js` |
| **W15** | **The Mint cloud** — at monument tier ≥ 8, a small permanent gold cloud anchored over the plaza dripping coins onto the altar (`mintdrip`). Reuses the precip mesh with a second, localised volume (`uEye` → `plazaPos` for the gold band only). Pairs beautifully with tier 10's existing coin-rain. | S | `weather.js`, `town.js` |
| **W16** | **Puddles that persist**: `wetnessAt(x,z)` from a 32×32 coarse field seeded by low ground; puddle decals on the road plate that dry out over ten minutes. NPCs walk round them. | M | `weather.js`, `environs.js`, `npcs.js` |
| **W17** | **Seasonal foliage**: `season.leafTint` into environs' `colorFor('tree')`; bare branches in deep winter, blossom instances in spring, gold in autumn. Highest charm-per-line of anything in COULD. | M | `environs.js`, `buildings.js` (`buildTree`) |
| **W18** | **A working weather vane** on the bell tower and the windmill: the existing `spin` vane (`buildings.js:1129`) becomes a `point` entry driven by `uWindV`. Also a wind sock at the gate. | S | `buildings.js`, `town.js` |
| **W19** | **Dust devils** in `scorched`: reuse the splash instances as a rising spiral of grit. One extra uniform, no extra draw. | S | `weather.js` |
| **W20** | **Snow-day town**: villagers build a snowman on the plaza at `cover > 0.8` (one flavour mesh), footprints in the snow on the road plate. | M | `buildings.js`, `npcs.js`, `town.js` |
| **W21** | **Weather history strip** in the hover receipt: the last 6 hours as 6 glyphs (`☀☀🌥🌧🌧🌈`). The user's day, told by the sky. | S | `weather.js`, `town.js` |

---

## 10. Performance, and how we prove it

| Budget | Value | How it is held |
|---|---|---|
| Draw calls (weather) | **≤ 6**, enforced (§7.8); typical clear day **0** | every mesh `visible=false` at rest |
| Materials | 7 (`precip, splash, mist, deck, bow, aurora, moon`) | all `ShaderMaterial`, no textures except one 64² soft-dot for snow/mist |
| Textures | **1** (`mkSoftDot`, 64², shared) | rainbow/aurora/deck are analytic |
| Per-frame CPU | **~14 uniform writes + 0 allocations** | channels are a fixed object; `_v2`/`_c` scratch at module scope |
| GPU instances | 1800 precip + 240 splash + 64 mist = 2104 quads | ≈ 4.2 k triangles — under half the NPC crowd's cost |
| `pick()` rate | 2 Hz | compared against `now`, never `dt` |
| Material recompiles | **1**, at `applyWeatherUniforms` | `customProgramCacheKey` → `'wx1'` |

**Degradation ladder** (`setQuality('low')` or auto):
1. `mist` off · `aurora` off · `bow` off
2. `N_PRECIP` 1800 → 700, `N_SPLASH` 240 → 90
3. `deck` segments 28×8 → 16×5
4. settled-state shader injection stays — it is the cheapest thing here and the most visible.

**Auto-drop**: weather keeps a 2 s EWMA of `now - lastNow`. Above 26 ms it calls
`setQuality('low')` once per epoch and posts nothing (a "reducing quality" headline would be
the least charming line in the app).

### Verification (offscreen only — never a visible window)

```powershell
# each of these is a settled state by t=7 s because of the snap rule
npx electron . "--shot=$S\wx-rain.png"     --shot-delay=7000   # + ?wx=rain
npx electron . "--shot=$S\wx-snow.png"     --shot-delay=7000   # ?wx=snow&wxcover=0.9
npx electron . "--shot=$S\wx-storm-n.png"  --shot-delay=7000   # ?wx=storm&hour=22
npx electron . "--shot=$S\wx-mist.png"     --shot-delay=7000   # ?wx=mist&hour=7
npx electron . "--shot=$S\wx-drought.png"  --shot-delay=7000   # ?wx=drought
npx electron . "--shot=$S\wx-bow.png"      --shot-delay=7000   # ?wx=rain&wxbow=1&hour=17
npx electron . "--shot=$S\wx-aurora.png"   --shot-delay=7000   # ?wx=clear&hour=1&season=winter
npx electron . "--shot=$S\wx-gold.png"     --shot-delay=7000   # ?wx=goldrain
```

Plus a headless unit harness (`wx-harness.mjs`, the `news-harness.mjs` pattern — stub THREE,
drive `update()` with synthetic `ctx`) asserting:
* 3650 consecutive `daySeed`s produce no `NaN`, no unknown regime, and a season histogram
  within 8 % of the §4 table;
* `climateFor` is pure — same inputs, same output, 10 000 trials;
* the ledger's hysteresis cannot oscillate: a `paceRatio` square wave at 1.5/1.7 with 10 s
  period produces **zero** regime changes;
* every channel stays in range across a 24 h simulated day at 1 fps *and* at 120 fps, and the
  two agree to within 0.03 at every minute boundary (this is the wall-clock rule, tested).

---

## 11. Risks, and the honest answers

1. **`onBeforeCompile` on merged materials.** `mergedMat` and `matFor` both mint
   `MeshStandardMaterial`; the injection uses `objectNormal`/`transformed`, which exist in both
   the standard vertex chunks. Risk is a three.js chunk-name drift on upgrade — but the vendored
   three is pinned at r160 and the codebase already string-patches four shaders in environs, so
   this is an established, accepted technique here.
2. **Fog ownership.** Three parties currently write `scene.fog.color`: town.js (per frame),
   environs (haze/cast lerp), and now weather. **Resolution: town.js writes the base, weather
   applies exactly one lerp in the grade block, environs only reads.** Environs' write at
   `:1470-1475` is deleted by W4. Put that sentence in `environs.update`'s comment where the
   old block was, or someone will add it back.
3. **Precipitation at a 500-unit framing.** The column is 46 units around the *camera*, and at
   a 1200-building town the camera is 350+ units from the town. The rain is therefore around
   the *viewer*, not around the town — which is correct for a first-person weather illusion and
   wrong if you read it as simulation. Mitigation: scale `uR` with `dist`
   (`R = clamp(dist * 0.55, 34, 150)`) and `uH` likewise, so the volume grows with the shot and
   the streak count spreads instead of thinning. Test at `?tokens=3e10`.
4. **"The sky is now doing too much."** Real risk: v3's art direction is calm, and a storm plus
   an aurora plus a rainbow plus golden rain is a slot machine. Mitigations, all structural:
   `bow` and `aurora` are mutually exclusive by daylight; the ledger layer can only ever run
   **one** regime; impulses are capped at one active at a time (`gold` re-triggering just
   extends the hold). And clear/fair is ≥ 30 % of days by construction.
5. **Snow cover vs. the day palette.** `initPalette(daySeed)` can hand us a day of saturated
   red roofs; 90 % white over them is a different town. The `vWP.y` falloff and the 0.30 dither
   keep walls and lower storeys in colour. Screenshot `?wxcover=1` against three palettes
   (`?seed=`) before calling W6 done.
6. **Southern hemisphere with no `lat`.** The feed may send `lat: null`. Default 50 (the
   existing `let lat = 50`), i.e. northern seasons. Correct default, no crash.
7. **Epoch changes.** `hardReset` must call `wx.setSeed(daySeed, Date.now(), lat, env.biome)`,
   which re-arms the snap window — a range switch gives you the same *day's* weather (daySeed
   is unchanged by range, §11.1), snapped in. Do **not** re-roll `climateFor` on a range change;
   that would make the weather a function of the range, which is exactly the mistake §11.1
   exists to prevent.

---

## 12. The one-paragraph version for the showrunner

Build `weather.js` (W1) and its town.js grade block (W2) first — together they are a complete,
shippable feature that makes every day's sky different and every burst of work visibly gather a
storm, with **zero new meshes**. Then fan out: W3 (particles) is the biggest single win and
touches only the new file; W4 (environs handover) is the highest collision risk and should own
`environs.js` alone for its window; W5 (ledger + the rain-after-drought) is the emotional
payload and is pure `weather.js`; W6 (snow cover) is the prettiest and touches three files
lightly. Everything in SHOULD is independently schedulable. If only one COULD ever ships, make
it W17 (seasonal foliage) — it is the cheapest way to make October feel like October.
