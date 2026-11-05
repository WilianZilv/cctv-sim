// Debug view: every baked material on a lit plane, for tuning the texture shaders.
import * as THREE from 'three';
import { TextureBaker, TEX_DEFS } from '../tex/baker.js';
import { MaterialLibrary } from '../tex/matlib.js';

export async function runTexGallery(renderer, container) {
  const baker = new TextureBaker(renderer, 'gallery');
  const only = new URLSearchParams(location.search).get('only');
  const names = Object.keys(TEX_DEFS).filter(n => n !== 'noise' && (!only || n.includes(only)));
  const t0 = performance.now();
  await baker.bakeAll(['noise', ...names]);
  console.log('[sim] baked', names.length, 'in', Math.round(performance.now() - t0), 'ms');
  const lib = new MaterialLibrary(baker);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#202226');
  const sun = new THREE.DirectionalLight('#fff4e0', 3);
  sun.position.set(-3, 5, 4);
  scene.add(sun, new THREE.HemisphereLight('#bcd2ff', '#3a3226', 0.8));
  const cols = Math.ceil(Math.sqrt(names.length * 16 / 9));
  const tints = { plaster_stucco: '#d9a36f', plaster_grafiato: '#9eb6c9', gate_ribs: '#7b2b25', gate_slats: '#2b2c2e', rollup: '#3a4a5c', gate_flat: '#f2f2ef', gate_perf: '#2f4a36', steel: '#46403a' };
  names.forEach((n, i) => {
    const def = TEX_DEFS[n];
    const size = def.cutout ? 1 : Math.min(def.tile, 2);
    const geo = new THREE.PlaneGeometry(1, 1);
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * size, uv.getY(k) * size);
    const m = lib.get(n, tints[n] ? { tint: tints[n] } : {});
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set((i % cols) * 1.08, -Math.floor(i / cols) * 1.08, 0);
    scene.add(mesh);
    const label = document.createElement('div');
    label.textContent = n;
    label.style.cssText = 'position:absolute;color:#ddd;font:11px system-ui;pointer-events:none;text-shadow:0 1px 2px #000';
    label.dataset.i = i;
    container.appendChild(label);
    mesh.userData.label = label;
  });
  const rows = Math.ceil(names.length / cols);
  const cam = new THREE.OrthographicCamera(-0.6, cols * 1.08 - 0.5, 0.6, -rows * 1.08 + 0.5, 0.1, 10);
  cam.position.z = 5;
  renderer.setSize(window.innerWidth, window.innerHeight);
  const aspect = window.innerWidth / window.innerHeight;
  const w = cols * 1.08 + 0.1, h = rows * 1.08 + 0.1;
  if (w / h > aspect) { const hh = w / aspect; cam.top = 0.6; cam.bottom = 0.6 - hh; } else { const ww = h * aspect; cam.right = -0.6 + ww; cam.bottom = 0.6 - h; }
  cam.updateProjectionMatrix();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const tick = () => {
    renderer.render(scene, cam);
    scene.traverse(o => {
      if (!o.userData.label) return;
      const p = o.position.clone().add(new THREE.Vector3(-0.48, 0.5, 0)).project(cam);
      o.userData.label.style.left = ((p.x + 1) / 2 * window.innerWidth) + 'px';
      o.userData.label.style.top = ((1 - p.y) / 2 * window.innerHeight) + 'px';
    });
  };
  tick();
  return { tick };
}
