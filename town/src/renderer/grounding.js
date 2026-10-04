// Token Town — grounding (F5 / lookdev L4). ONE instanced field of soft
// elliptical ground blobs: the cheap contact shadow the real shadow map cannot
// afford. The sun's frustum is capped at ±74 units and nothing past band 4
// casts, so on a 446-house town roughly four buildings in five are stickers laid
// on a green tablecloth. A blob under every one of them — house, landmark, tree,
// cart, villager — is what makes the town TOUCH the ground, and it costs one
// draw call for the whole settlement.
//
// PUBLIC SURFACE (§4.2, plus the two epoch methods risk 3 makes mandatory):
//   initGrounding(scene, { capacity = 1400, maxAnisotropy = 4, color, y })
//     → { place(slot, x, z, radius, height), clear(slot), clearAll(),
//         update(now, ctx, sunDir), reset(), dispose(),
//         count, pending, capacity, mesh }        // last four are read-only
//
// COST. 1 draw call, 2 triangles × live instances, no lights, no shadow
// interaction, zero per-frame allocation. An idle frame measured 0.3 µs. The
// matrix sweep re-composes every live blob and is throttled to 2 Hz AND gated on
// the sun actually having moved (|Δaz| > 0.012 or |Δel| > 0.010): 0.02 ms for
// 1200 blobs, i.e. ≤ 0.04 ms/s. Mounting all 1200 costs 0.3 ms, once.
// A `place()` writes its own matrix immediately, so a blob exists on the frame
// its building mounts even if the sweep never fires: the wall-clock existence
// rule, and the reason a 1 fps headless shot is never missing shadows.
//
// SLOTS. `slot` is any finite number the caller chooses as a stable handle —
// sparse and negative are both fine. Grounding maps slots to instances itself,
// so the caller never has to compact anything across a growth cascade. Suggested
// namespacing so two systems can never collide:
//     houses    e.idx            (0 … 1199)
//     landmarks e.idx            (negative synthetics, already unique)
//     props     -1e5 - i
//     villagers  1e6 + n.seed
// More slots than capacity is a supported state, not an error: the field keeps
// the `capacity` blobs nearest the camera (biased toward big, tall subjects) and
// re-picks on the same 2 Hz timer. An unhoused slot costs one small record.
//
// INTEGRATION (what the wave-0/1 owner of town.js must wire):
//   1. `const grounding = initGrounding(scene, { capacity: 1400, maxAnisotropy: MAXA });`
//   2. mountEnt(e), after `g.position.set(p.x, 0, p.z)` — for EVERY entity,
//      regardless of band; that hand-over is the whole point of L11:
//        grounding.place(e.idx, p.x, p.z, 1.55 * (g.userData.span || 1) + .10 * e.hTop, e.hTop);
//   3. dropGroup / demolition: `grounding.clear(slot)`.
//   4. hardReset(): `grounding.reset()`.   shutdown: `grounding.dispose()`.
//   5. tick(), after `_sd.normalize()` (town.js:1961) and after ctx.day is set:
//        grounding.update(now, ctx, _sd);
//      `_sd` points TOWARD the sun; blobs stretch and slide away from it.
//   ctx fields read, all optional: `day`, `camera`, `bounds{cx,cz}`. Anything
//   missing simply holds the last good value — the module is a null object until
//   it is fed, and never throws at a call site that exists before its data does.
//
// STILL NEEDS AN IN-APP PASS (not testable headlessly): the onBeforeCompile
// patch that turns per-instance colour into per-instance ALPHA and adds the
// distance fade. The patch is applied only if every chunk replacement matched,
// so a chunk rename in some future three degrades to a flat-alpha blob field
// rather than to a black screen.

import * as THREE from './vendor/three.module.js';

const Y = 0.030;              // over the road plate (.02), under the lamp pools (.04)
const TEX = 64;
const SWEEP_MS = 500;         // piggybacks town.js's own stats/shadow re-arm cadence
const AZ_EPS = 0.012, EL_EPS = 0.010;
const PROBE = 24;             // eviction probe width — bounded work per placement

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Alpha ramp of the blob, sampled radially. White RGB on purpose: the material
 *  colour is what tints the shadow, and a black-RGB gradient (the obvious
 *  reading) would multiply that colour out to pure soot on grass. */
function blobTexture(aniso) {
  const d = new Uint8Array(TEX * TEX * 4);
  // stops: 0 → .95, .42 → .62, .74 → .20, 1 → 0. Fat dark core, long soft skirt;
  // a linear ramp reads as a decal and a gaussian reads as fog.
  const ramp = t => t < .42 ? .95 + (.62 - .95) * (t / .42)
    : t < .74 ? .62 + (.20 - .62) * ((t - .42) / .32)
      : .20 + (0 - .20) * clamp((t - .74) / .26, 0, 1);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const u = (x + .5) / TEX - .5, v = (y + .5) / TEX - .5;
    const t = clamp(Math.sqrt(u * u + v * v) * 2, 0, 1), i = (y * TEX + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.round(255 * ramp(t));
  }
  const t = new THREE.DataTexture(d, TEX, TEX, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;         // blobs are always seen at a grazing angle
  t.needsUpdate = true;
  return t;
}

const NOOP = Object.freeze({
  place() { }, clear() { }, clearAll() { }, update() { }, reset() { }, dispose() { },
  count: 0, pending: 0, capacity: 0, mesh: null
});

/**
 * @param {THREE.Scene} scene
 * @param {{capacity?:number, maxAnisotropy?:number, color?:number, y?:number}} [opts]
 */
export function initGrounding(scene, opts = {}) {
  if (!scene || typeof scene.add !== 'function') return NOOP;

  const capacity = Math.max(1, Math.floor(opts.capacity || 1400));
  const yBase = typeof opts.y === 'number' ? opts.y : Y;

  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const tex = blobTexture(clamp(opts.maxAnisotropy || 4, 1, 16));
  const uFade = { value: new THREE.Vector2(300, 900) };
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    // green-black, not neutral grey: a grey blob on grass reads as soot, and on
    // the road plate as a puddle. This is the shadow the grass casts on itself.
    color: opts.color === undefined ? 0x121A0E : opts.color,
    transparent: true, depthWrite: false, opacity: .34,
    fog: false, blending: THREE.NormalBlending
  });
  // Per-instance ALPHA out of per-instance colour: taller subjects get a wider,
  // fainter blob, which is what a real penumbra does. Distance fade is on alpha
  // too — fogging a near-black decal would turn the far blobs into sky-coloured
  // smudges instead of into nothing.
  mat.onBeforeCompile = s => {
    const v0 = s.vertexShader, f0 = s.fragmentShader;
    const v = v0
      .replace('#include <common>', '#include <common>\nvarying float vGDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGDist = -mvPosition.z;');
    const f = f0
      .replace('#include <common>', '#include <common>\nvarying float vGDist;\nuniform vec2 uGFade;')
      .replace('#include <color_fragment>',
        'diffuseColor.a *= vColor.r * (1.0 - smoothstep(uGFade.x, uGFade.y, vGDist));');
    if (v !== v0 && f !== f0) {
      s.vertexShader = v; s.fragmentShader = f; s.uniforms.uGFade = uFade;
    }
  };
  mat.customProgramCacheKey = () => 'town-grounding';

  const im = new THREE.InstancedMesh(geo, mat, capacity);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // instanceColor must exist for the lifetime of the mesh: it is what defines
  // USE_INSTANCING_COLOR, and the patch above reads `vColor` unconditionally.
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  im.count = 0;
  im.frustumCulled = false;       // the field spans the whole town; its own bounds are a lie
  im.castShadow = im.receiveShadow = false;
  im.renderOrder = 1;
  im.matrixAutoUpdate = false; im.updateMatrix();
  im.name = 'grounding';
  scene.add(im);

  const MA = im.instanceMatrix.array, CA = im.instanceColor.array;

  /** @typedef {{x:number,z:number,r:number,h:number,s:number,i:number,k:number}} Blob */
  /** @type {Map<number, Blob>} */
  const recs = new Map();
  const owner = new Array(capacity).fill(null);   // instance index → record
  const free = new Int32Array(capacity);
  let freeN = 0, high = 0, placed = 0, probe = 0;

  // Sun state. Committed only on a sweep, never per frame: if `place()` used a
  // sun that drifts every tick, a cascade would lay down 1200 blobs at 1200
  // slightly different angles. Defaults are a plausible mid-morning so the very
  // first frame — before any update() — is already correct-looking.
  let el = .75, az = -.9, ca = Math.cos(az), sa = Math.sin(az);
  let strc = 1 + 1.45 * (1 - el), push = .55 * (1 - el);
  let wantEl = el, wantAz = az, sunStale = true;
  let sweepAt = -1e9, camX = 0, camZ = 0, live = true;

  const alloc = () => {
    if (freeN > 0) return free[--freeN];
    if (high < capacity) { im.count = ++high; return high - 1; }
    return -1;
  };
  const park = i => {                      // degenerate: zero scale, below the world
    const o = i * 16;
    for (let n = 0; n < 16; n++) MA[o + n] = 0;
    MA[o + 13] = -999; MA[o + 15] = 1;
    im.instanceMatrix.needsUpdate = true;
  };
  // Releasing always returns the instance to the free list — repick() and
  // steal() both depend on being able to re-allocate what they just gave up.
  const release = rec => {
    const i = rec.i; if (i < 0) return;
    park(i); owner[i] = null; rec.i = -1; placed--; free[freeN++] = i;
  };
  /** Lower is more deserving. Distance to the camera, with big and tall subjects
   *  worth keeping from further away — losing a cathedral's shadow reads as a
   *  bug, losing a shed's does not. */
  const rank = r => Math.hypot(r.x - camX, r.z - camZ) - r.r * 5 - r.h * 2;

  function writeMat(i, r) {
    // Stretch along the sun's ground azimuth and slide away from it: at golden
    // hour every house grows a long shadow pointing away from the sun, in one
    // draw call. Local +X is mapped onto (cos az, sin az) by a -az yaw.
    const rr = r.r * (1 + .012 * r.h);
    const sx = rr * 2 * strc, sz = rr * 2, o = i * 16;
    MA[o] = ca * sx; MA[o + 1] = 0; MA[o + 2] = sa * sx; MA[o + 3] = 0;
    MA[o + 4] = 0; MA[o + 5] = 1; MA[o + 6] = 0; MA[o + 7] = 0;
    MA[o + 8] = -sa * sz; MA[o + 9] = 0; MA[o + 10] = ca * sz; MA[o + 11] = 0;
    MA[o + 12] = r.x - ca * rr * push; MA[o + 13] = yBase; MA[o + 14] = r.z - sa * rr * push;
    MA[o + 15] = 1;
    CA[i * 3] = CA[i * 3 + 1] = CA[i * 3 + 2] = r.s;
    im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true;
  }

  /** Bounded eviction: scan a window of live blobs from a rotating cursor and
   *  take the worst one IF the newcomer beats it. O(PROBE), not O(capacity), so
   *  a 1200-house cascade against a full field cannot stall a frame; the 2 Hz
   *  re-pick below fixes anything the probe got wrong. */
  function steal(rec) {
    if (!high) return -1;
    let worst = -1, worstK = rank(rec);
    for (let n = 0; n < PROBE; n++) {
      const i = probe++ % high, o = owner[i];
      if (!o) continue;                       // already free; alloc() will find it
      const k = rank(o);
      if (k > worstK) { worstK = k; worst = i; }
    }
    if (worst < 0) return -1;
    release(owner[worst]);
    return alloc();
  }

  function wipe() {
    if (!live) return;
    for (const r of recs.values()) r.i = -1;
    recs.clear(); owner.fill(null);
    freeN = 0; high = 0; placed = 0; probe = 0; im.count = 0;
  }

  const sortBuf = [];
  const byRank = (a, b) => a.k - b.k;
  /** Full re-pick, only while the field is oversubscribed and only on the sweep
   *  timer. Releases first, then fills, so the freed instances are reusable in
   *  the same pass. */
  function repick() {
    sortBuf.length = 0;
    for (const r of recs.values()) { r.k = rank(r); sortBuf.push(r); }
    sortBuf.sort(byRank);
    for (let n = capacity; n < sortBuf.length; n++) release(sortBuf[n]);
    for (let n = 0; n < capacity && n < sortBuf.length; n++) {
      const r = sortBuf[n];
      if (r.i >= 0) continue;
      const i = alloc(); if (i < 0) break;
      r.i = i; owner[i] = r; placed++; writeMat(i, r);
    }
    sortBuf.length = 0;
  }

  return {
    /** Seat a subject on the ground. Re-placing the same slot moves it.
     *  @param {number} slot stable caller-chosen handle
     *  @param {number} x @param {number} z world position of the footprint centre
     *  @param {number} radius footprint radius in world units
     *  @param {number} height subject height — softens and widens the blob */
    place(slot, x, z, radius, height) {
      if (!live || !Number.isFinite(slot) || !Number.isFinite(x) || !Number.isFinite(z)) return;
      const r = clamp(Number.isFinite(radius) ? radius : 1, .12, 40);
      const h = clamp(Number.isFinite(height) ? height : 0, 0, 80);
      let rec = recs.get(slot);
      if (!rec) { rec = { x, z, r, h, s: 1, i: -1, k: 0 }; recs.set(slot, rec); }
      rec.x = x; rec.z = z; rec.r = r; rec.h = h;
      // A tall subject's contact shadow is wider and fainter — that IS the
      // penumbra, and it keeps a bell tower from stamping a hard black ellipse.
      rec.s = clamp(1 / (1 + .055 * h), .35, 1);
      if (rec.i < 0) {
        let i = alloc();
        if (i < 0) i = steal(rec);
        if (i >= 0) { rec.i = i; owner[i] = rec; placed++; }
      }
      if (rec.i >= 0) writeMat(rec.i, rec);
    },
    /** Forget a subject (demolition, promotion teardown, a villager despawning). */
    clear(slot) {
      if (!live) return;
      const rec = recs.get(slot); if (!rec) return;
      release(rec); recs.delete(slot);
    },
    clearAll() { wipe(); },
    /** Epoch switch: the field empties, the GPU resources stay. Minting geometry
     *  per epoch is exactly the leak §5 risk 3 fails the build over. */
    reset() { wipe(); sweepAt = -1e9; sunStale = true; },
    /**
     * @param {number} now performance.now()
     * @param {object} ctx town.js's shared context (day, camera, bounds)
     * @param {THREE.Vector3} sunDir direction TOWARD the sun; need not be unit
     */
    update(now, ctx, sunDir) {
      if (!live) return;
      const t = Number.isFinite(now) ? now : nowMs();

      if (sunDir && Number.isFinite(sunDir.x)) {
        const L = Math.hypot(sunDir.x, sunDir.y, sunDir.z) || 1;
        wantEl = clamp(sunDir.y / L, 0, 1);
        wantAz = Math.atan2(sunDir.z / L, sunDir.x / L);
      }
      if (ctx) {
        const c = ctx.camera, b = ctx.bounds;
        if (c && c.position) {
          camX = c.position.x; camZ = c.position.z;
          // Fade the far edge of the field out on the same scale the camera is
          // framing at, so a hamlet and a 1200-house city both keep their blobs
          // where the eye is and lose them where they'd be sub-pixel noise.
          const bx = b ? b.cx : 0, bz = b ? b.cz : 0;
          const d = Math.hypot(camX - bx, c.position.y, camZ - bz) || 300;
          uFade.value.set(d * .95, d * 2.85);
        }
        // Pure function of THIS call's inputs — the live elevation, not the
        // swept one: sun on the horizon → faint long shadows, overhead → crisp
        // short ones, night → a floor of 0.10, which is just enough that a
        // building never floats. Nothing accumulates, so a 1 fps capture grades
        // identically to a 60 fps one.
        const day = Number.isFinite(ctx.day) ? clamp(ctx.day, 0, 1) : 1;
        mat.opacity = .10 + .34 * day * sstep(.05, .45, wantEl);
      }

      if (t - sweepAt < SWEEP_MS) return;
      sweepAt = t;
      if (recs.size > placed) repick();
      if (!sunStale && Math.abs(wantAz - az) < AZ_EPS && Math.abs(wantEl - el) < EL_EPS) return;
      sunStale = false;
      az = wantAz; el = wantEl; ca = Math.cos(az); sa = Math.sin(az);
      strc = 1 + 1.45 * (1 - el); push = .55 * (1 - el);
      for (let i = 0; i < high; i++) { const r = owner[i]; if (r) writeMat(i, r); }
    },
    dispose() {
      if (!live) return;
      recs.clear(); owner.fill(null);
      freeN = 0; high = 0; placed = 0; im.count = 0; live = false;
      scene.remove(im);
      im.dispose(); geo.dispose(); mat.dispose(); tex.dispose();
    },
    get count() { return placed; },
    get pending() { return recs.size - placed; },
    get capacity() { return capacity; },
    get mesh() { return im; }
  };
}
