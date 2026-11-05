// What sits between the front wall and the house: a garden bed, shrubs, a small
// tree, potted plants, a bench, a parked bike, a tank, a hose, a dog house... Each
// yard draws a few of these, scaled by its size and how cared for it is.
import * as THREE from 'three';
import { Batcher, boxGeometry, frameMatrix } from './mesh.js';
import { buildTree } from './props.js';

export function buildYards(ctx) {
  const { layout, lib, group, focus } = ctx;
  const B = new Batcher();
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const M = {
    soil: lib.get('soil', { pom: false }),
    pot: lib.plain({ color: '#8a4a2c', roughness: 0.85 }, { porosity: 0.6 }),
    potB: lib.plain({ color: '#3a3a3a', roughness: 0.6 }, { porosity: 0.3 }),
    potW: lib.plain({ color: '#d8d4ca', roughness: 0.7 }, { porosity: 0.4 }),
    curb: lib.get('concrete_old', { tint: '#b0aca4', pom: false }),
    bark: lib.get('bark', { pom: false }),
    wood: lib.get('wood', { grime: 0.6 }),
    tank: lib.plain({ color: '#2462a8', roughness: 0.45 }, { porosity: 0 }),
    steel: lib.get('steel', { tint: '#2a2b2c', grime: 0.6 }),
  };
  const shrubMats = ['foliage_broad', 'foliage_small', 'foliage_dark'].map(n => lib.get(n, { side: THREE.DoubleSide, porosity: 0.2, irGain: 3, ao: false, dirt: 0 }));
  const flowerMats = ['foliage_ipe', 'foliage_ipe_y'].map(n => lib.get(n, { side: THREE.DoubleSide, porosity: 0.2, irGain: 2.5, ao: false, dirt: 0 }));
  // a shrub: a few crossed foliage cards around a point
  const shrub = (x, y, z, size, r, flowers = false) => {
    const mat = flowers && r.chance(0.5) ? r.pick(flowerMats) : r.pick(shrubMats);
    for (let i = 0; i < 3 + Math.round(size * 3); i++) {
      const s = size * r.float(0.6, 1.1);
      const g = new THREE.PlaneGeometry(s, s);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x + r.gauss(0, size * 0.2), y + s * 0.42 + r.float(0, size * 0.3), z + r.gauss(0, size * 0.2)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(r.float(-0.4, 0.4), r.float(0, Math.PI), r.float(-0.3, 0.3))),
        new THREE.Vector3(1, 1, 1));
      const gg = g.applyMatrix4(m);
      const n = gg.attributes.normal; for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
      B.add('shrub' + mat.uuid, mat, gg);
    }
  };

  for (const lot of layout.lots) {
    if (lot.use === 'vacant' || !lot.wall || !near(lot.c[0], lot.c[1], 95)) continue;
    // yard depth: up to the house, or a stretch of the lot when nothing is built
    const d = lot.building ? (lot.setback || 0) : Math.min(lot.depth, 9);
    if (d < 1.4) continue;
    const r = lot.rng.fork('yard2');
    const care = 1 - (lot.neglect ?? 0.3);
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const Q = (s, o) => { const x = lot.a[0] + tx * s + nx * o, z = lot.a[1] + tz * s + nz * o; return [x, ctx.gy(x, z) + 0.19, z]; };
    const garage = lot.gates.find(g => g.kind === 'garage');
    // free stretches of the yard (not in front of the garage gate)
    const free = (s) => !garage || Math.abs(s - garage.s) > garage.w / 2 + 0.3;
    const pickS = () => { for (let k = 0; k < 8; k++) { const s = r.float(0.4, lot.len - 0.4); if (free(s)) return s; } return null; };

    // garden bed along the wall or the house, with a small curb
    if (r.chance(0.35 + 0.35 * care)) {
      const s = pickS();
      if (s !== null) {
        const len = Math.min(r.float(1.2, 4), lot.len - 0.6), dep = r.float(0.4, 0.8);
        const o = r.chance(0.6) ? 0.15 + dep / 2 : d - dep / 2 - 0.1;
        const [x, y, z] = Q(s, o);
        B.add('bedSoil', M.soil, boxGeometry(len, 0.12, dep, 1, 0), frameMatrix(x, y + 0.02, z, tx, tz));
        B.add('bedCurb', M.curb, boxGeometry(len + 0.1, 0.2, 0.08), frameMatrix(x - nx * dep / 2, y + 0.05, z - nz * dep / 2, tx, tz));
        for (let i = 0; i < Math.round(len * 1.6); i++) {
          const [sx, sy, sz] = Q(s + r.float(-len / 2, len / 2), o + r.float(-dep / 3, dep / 3));
          shrub(sx, sy + 0.08, sz, r.float(0.35, 0.9) * (0.6 + 0.6 * care), r, care > 0.5);
        }
      }
    }
    // a tree in the yard
    if (d > 2.5 && r.chance(0.3)) {
      const s = pickS();
      if (s !== null) {
        const [x, , z] = Q(s, r.float(1, d - 1));
        buildTree(B, M, { ...ctx, sidewalkY: (xx, zz) => ctx.gy(xx, zz) + 0.19 }, { x, z, r: r.fork('yardtree') });
      }
    }
    // potted plants by the door and on the wall
    for (let i = 0; i < Math.round(r.float(0, 4) * care); i++) {
      const s = pickS();
      if (s === null) continue;
      const [x, y, z] = Q(s, r.float(0.3, d - 0.3));
      const h = r.float(0.2, 0.45);
      B.add('pot', r.pick([M.pot, M.pot, M.potB, M.potW]), new THREE.CylinderGeometry(h * 0.6, h * 0.42, h, 10), new THREE.Matrix4().makeTranslation(x, y + h / 2, z));
      shrub(x, y + h, z, r.float(0.3, 0.7), r, true);
    }
    // odds and ends
    if (r.chance(0.25)) {
      const s = pickS();
      if (s !== null) { const [x, y, z] = Q(s, d - 0.4); B.add('bench', M.wood, boxGeometry(1.2, 0.05, 0.35), frameMatrix(x, y + 0.42, z, tx, tz)); for (const k of [-0.5, 0.5]) B.add('benchLeg', M.steel, boxGeometry(0.04, 0.42, 0.3), frameMatrix(x + tx * k, y + 0.21, z + tz * k, tx, tz)); }
    }
    if (r.chance(0.18)) {
      const s = pickS();
      if (s !== null) { const [x, y, z] = Q(s, r.float(0.6, d - 0.6)); B.add('doghouse', M.wood, boxGeometry(0.7, 0.6, 0.8), frameMatrix(x, y + 0.3, z, tx, tz)); }
    }
    if (r.chance(0.12)) {
      const s = pickS();
      if (s !== null) { const [x, y, z] = Q(s, d - 0.6); B.add('yardTank', M.tank, new THREE.CylinderGeometry(0.5, 0.45, 0.8, 16), new THREE.Matrix4().makeTranslation(x, y + 0.4, z)); }
    }
    // grass between the paving in neglected yards
    if (r.chance(0.4 * (1 - care) + 0.1)) {
      for (let i = 0; i < Math.round(lot.len * d * 0.4); i++) {
        const s = r.float(0.2, lot.len - 0.2);
        const [x, y, z] = Q(s, r.float(0.2, d - 0.2));
        shrub(x, y - 0.05, z, r.float(0.15, 0.35), r);
      }
    }
  }
  return B.build(group, { castShadow: true });
}
