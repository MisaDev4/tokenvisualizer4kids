// The proof-sheet renderer. Reads buildings.js DIRECTLY — no town.js, no plan,
// no data feed — so it shows exactly what the construction library builds.
import * as THREE from '../../src/renderer/vendor/three.module.js';
import {
  initPalette, palette, LANDMARK_DEFS, buildLandmark, paintLandmark,
  buildHouse, paintHouse, setVillageTier, villageFabric, VILLAGE_TIER_NAMES
} from '../../src/renderer/buildings.js';

const err = document.getElementById('err');
window.addEventListener('error', e => {
  err.style.display = 'block';
  err.textContent += (e.message || e.error) + '\n' + ((e.error && e.error.stack) || '') + '\n';
  console.log('PAGE ERROR ' + (e.message || e.error));
});

const q = new URLSearchParams(location.search);
const row = q.get('row') || 'a';
const hour = Number(q.get('hour') || 13);
const only = q.get('only') || '';
const seed = Number(q.get('seed') || 4242);
const night = hour >= 19 || hour < 6;

initPalette(20260806);
const P = palette();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 1.35 : 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? 0x10141F : 0x9FB6C8);
scene.fog = new THREE.Fog(night ? 0x10141F : 0x9FB6C8, 120, 400);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({ color: P.ground, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// Fill matters: with a single key light an unlit gable goes to near black and you
// end up "fixing" a material that was never the problem.
scene.add(new THREE.HemisphereLight(night ? 0x2A3350 : 0xC6D8E8, night ? 0x191C24 : 0x8B8875, night ? .55 : 1.55));
scene.add(new THREE.AmbientLight(night ? 0x1B2030 : 0xB6B3A2, night ? .25 : .45));
const sun = new THREE.DirectionalLight(night ? 0x8FA6D8 : 0xFFF1D6, night ? .35 : 1.85);
sun.position.set(-40, 60, 45); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const c = sun.shadow.camera;
c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.near = 1; c.far = 220; c.updateProjectionMatrix();
scene.add(sun);

const KEYS = Object.keys(LANDMARK_DEFS);
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .5, 800);
const cap = document.getElementById('cap');
let label = '';

function lightUp(g) {                       // night: drive winMats + glow, as town.js does
  const u = g.userData || {};
  for (const m of (u.winMats || [])) m.emissiveIntensity = night ? 1.5 : 0;
  for (const w of (u.glow || [])) w.mat.emissiveIntensity = night ? w.night : w.day;
}

if (row === 'tiers') {
  // Four plots of the same six dwellings, one per village tier: the fabric is
  // the only thing that changes.
  const one = q.get('tier') === null ? -1 : Number(q.get('tier'));
  const tiers = one >= 0 ? [one] : [0, 1, 2, 3];
  const names = [];
  tiers.forEach((t, r) => {
    setVillageTier(t);
    const f = villageFabric();
    names.push(`${t} ${VILLAGE_TIER_NAMES[t]} — thatch ${f.thatch} · ${f.boundary} · clutter ${f.clutter} · lantern ${f.lantern} · lane ${f.lane}`);
    const n = one >= 0 ? 4 : 5;
    for (let i = 0; i < n; i++) {
      const idx = 40 + i * 37 + t * 3, tier = [3, 4, 2, 5, 3][i];
      const g = buildHouse(tier, paintHouse(idx, 2), seed + i * 17 + t * 5);
      g.position.set((i - (n - 1) / 2) * (one >= 0 ? 7.5 : 11), 0, (r - (tiers.length - 1) / 2) * 13);
      scene.add(g); lightUp(g);
    }
  });
  label = names.join('   |   ');
  const d = one >= 0 ? 22 : 52;
  camera.fov = one >= 0 ? 36 : 44; camera.updateProjectionMatrix();
  camera.position.set(0, one >= 0 ? 7 : 30, d);
  camera.lookAt(0, one >= 0 ? 2.2 : 1.5, 0);
} else {
  setVillageTier(q.get('tier') === null ? 2 : Number(q.get('tier')));
  const list = only ? [only] : (row === 'b' ? KEYS.slice(5) : KEYS.slice(0, 5));
  const span = only ? 0 : 26;
  const box = new THREE.Box3(), all = new THREE.Box3();
  list.forEach((k, i) => {
    const g = buildLandmark(k, paintLandmark(k), (seed ^ (i * 2654435761)) >>> 0);
    g.position.set((i - (list.length - 1) / 2) * span, 0, 0);
    g.rotation.y = only ? -.55 : -.42;
    scene.add(g); lightUp(g);
    g.updateMatrixWorld(true); box.setFromObject(g); all.union(box);
  });
  label = list.map(k => `${k} · span ${LANDMARK_DEFS[k].span} · hTop ${LANDMARK_DEFS[k].hTop} · "${LANDMARK_DEFS[k].label}"`).join('   |   ');
  // frame whatever got built, rather than guessing: a tithe barn is 14 wide and
  // a market cross is 4, and the same camera cannot judge both
  const size = all.getSize(new THREE.Vector3()), mid = all.getCenter(new THREE.Vector3());
  camera.fov = only ? 34 : 46; camera.updateProjectionMatrix();
  const need = Math.max(size.x / camera.aspect, size.y * 1.35) * 1.25;
  const dist = need / (2 * Math.tan(camera.fov * Math.PI / 360));
  camera.position.set(mid.x + (only ? dist * .55 : 0), Math.max(size.y * .62, 3), dist);
  camera.lookAt(mid.x, size.y * .42, 0);
}
cap.textContent = `${label}    [hour ${hour}${night ? ' night' : ' day'}]`;

renderer.render(scene, camera);
requestAnimationFrame(() => renderer.render(scene, camera));
setTimeout(() => { renderer.render(scene, camera); console.log('LMSHOT READY'); }, 400);
