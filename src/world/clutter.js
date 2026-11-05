// Loose objects on the ground: leaf litter under trees and rubble near vacant lots
// and the skip. Dirt and weeds live in grime.js.
import * as THREE from 'three';
import { Batcher } from './mesh.js';

export function buildClutter(ctx) {
  const { layout, lib, rng, group, focus } = ctx;
  const B = new Batcher();
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const r = rng.fork('clutter');
  // ---- leaf litter under trees
  const litter = lib.get('foliage_small', { side: THREE.DoubleSide, porosity: 0.4, irGain: 2.5, ao: false });
  for (const t of ctx.treeCanopies || []) {
    if (!near(t.x, t.z, 70)) continue;
    for (let k = 0; k < Math.round(4 + t.r * 3); k++) {
      const a = r.float(0, Math.PI * 2), d = Math.sqrt(r.next()) * t.r * 1.2;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      const onRoad = layout.regions.carr.contains(x, z);
      const y = onRoad ? ctx.roadSurf(x, z) : ctx.sidewalkY(x, z);
      const g = new THREE.PlaneGeometry(r.float(0.4, 0.9), r.float(0.4, 0.9)).rotateX(-Math.PI / 2).rotateY(r.float(0, 6));
      g.translate(x, y + 0.012, z);
      B.add('litter', litter, g);
    }
  }

  // ---- loose rubble and brick pieces near vacant lots and the skip
  const brick = lib.get('brick_raw', { pom: false });
  const concrete = lib.get('concrete_raw', { pom: false });
  const spots = layout.lots.filter(l => l.use === 'vacant' && near(l.c[0], l.c[1], 70)).map(l => ({ x: l.c[0] - l.n[0] * 0.6, z: l.c[1] - l.n[1] * 0.6, n: 12 }));
  for (const o of ctx.obstacles || []) spots.push({ x: o.x, z: o.z, n: 18 });
  for (const sp of spots) {
    for (let k = 0; k < sp.n; k++) {
      const x = sp.x + r.gauss(0, 0.9), z = sp.z + r.gauss(0, 0.9);
      const onRoad = layout.regions.carr.contains(x, z);
      const y = onRoad ? ctx.roadSurf(x, z) : ctx.sidewalkY(x, z);
      const s = r.float(0.05, 0.18);
      const g = r.chance(0.5) ? new THREE.BoxGeometry(s * 1.6, s * 0.7, s) : new THREE.DodecahedronGeometry(s * 0.6, 0);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y + s * 0.25, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(r.float(0, 1), r.float(0, 6), r.float(0, 1))), new THREE.Vector3(1, 1, 1));
      B.add('rubble', r.chance(0.6) ? brick : concrete, g, m);
    }
  }

  return B.build(group, { castShadow: false });
}
