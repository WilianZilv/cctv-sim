// Small objects people leave on the street: garbage bags (real bag shapes: a sagging
// body with folds and a knotted neck), torn bags spilling rubbish, cups, bottles,
// cans, paper, cardboard, and scattered litter along curbs and gutters.
import * as THREE from 'three';
import { Batcher } from './mesh.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// garbage bag: an icosphere sagging under its own weight, flattened on the ground,
// with random folds and a twisted neck at the top
let _bagSphere = null;
export function bagGeometry(r, size = 0.3) {
  // indexed so the folds shade smoothly (icosahedron geometry comes unindexed);
  // the welded sphere is the same every time, so it is built once and cloned
  if (!_bagSphere) _bagSphere = mergeVertices(new THREE.IcosahedronGeometry(1, 4));
  const g = _bagSphere.clone();
  const pos = g.attributes.position;
  const ph = [r.float(0, 6), r.float(0, 6), r.float(0, 6)];
  const tilt = [r.gauss(0, 0.15), r.gauss(0, 0.15)];
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // folds and lumps
    const f = 1 + 0.09 * Math.sin(x * 7 + ph[0]) * Math.sin(y * 6 + ph[1]) + 0.06 * Math.sin(z * 9 + ph[2] + y * 4);
    x *= f; z *= f; y *= f;
    // pear shape: wide bottom, narrow top, slumped
    const t = (y + 1) / 2;
    const w = 1.15 - 0.55 * t * t;
    x *= w; z *= w;
    y = y < -0.3 ? -0.3 + (y + 0.3) * 0.25 : y * 0.85;
    // neck: tie the top into a twist
    if (t > 0.88) { const k = (t - 0.88) / 0.12; x *= 1 - 0.75 * k; z *= 1 - 0.75 * k; y += k * 0.35; }
    x += tilt[0] * (y + 0.4); z += tilt[1] * (y + 0.4);
    pos.setXYZ(i, x * size, (y + 0.42) * size, z * size);
  }
  g.computeVertexNormals();
  return g;
}

export function buildLitter(ctx) {
  const { layout, lib, rng, group, focus } = ctx;
  const r = rng.fork('litter');
  const B = new Batcher();
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const M = {
    black: lib.plain({ color: '#0e0e0f', roughness: 0.32, metalness: 0 }, { porosity: 0.05, spec: 1.2, dirt: 0 }),
    blue: lib.plain({ color: '#26457a', roughness: 0.35 }, { porosity: 0.05, dirt: 0 }),
    green: lib.plain({ color: '#2c4a2a', roughness: 0.35 }, { porosity: 0.05, dirt: 0 }),
    white: lib.plain({ color: '#d9d8d2', roughness: 0.45, side: THREE.DoubleSide }, { porosity: 0.3, dirt: 0 }),
    paper: lib.plain({ color: '#cfc8b4', roughness: 0.9, side: THREE.DoubleSide }, { porosity: 0.8, dirt: 0 }),
    card: lib.plain({ color: '#8a6a45', roughness: 0.9, side: THREE.DoubleSide }, { porosity: 0.8, dirt: 0 }),
    pet: lib.plain({ color: '#9fb6a8', roughness: 0.1, transparent: true, opacity: 0.55 }, { porosity: 0, dirt: 0 }),
    can: lib.plain({ color: '#b02a22', roughness: 0.3, metalness: 0.8 }, { porosity: 0, dirt: 0 }),
    canS: lib.plain({ color: '#9aa0a6', roughness: 0.3, metalness: 0.9 }, { porosity: 0, dirt: 0 }),
    cup: lib.plain({ color: '#e8e4da', roughness: 0.5 }, { porosity: 0.2, dirt: 0 }),
  };
  const place = (key, mat, g, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    B.add(key, mat, g, m);
  };
  const groundY = (x, z) => (layout.regions.carr.contains(x, z) ? ctx.roadSurf(x, z) : ctx.sidewalkY(x, z));

  // a bit of scattered small litter, more where the frontage is neglected
  const smallItem = (x, z) => {
    const y = groundY(x, z);
    const k = r.weighted([['paper', 4], ['cup', 2], ['pet', 1.5], ['can', 1.2], ['card', 0.8], ['bagScrap', 1.5]]);
    if (k === 'paper') { const g = new THREE.PlaneGeometry(r.float(0.08, 0.22), r.float(0.06, 0.18), 2, 2).rotateX(-Math.PI / 2); const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, Math.abs(p.getX(i) * p.getZ(i)) * r.float(5, 15)); g.computeVertexNormals(); place('paper', M.paper, g, x, y + 0.004, z, 0, r.float(0, 6), 0); }
    else if (k === 'cup') place('cup', M.cup, new THREE.CylinderGeometry(0.04, 0.03, 0.1, 8, 1, true), x, y + 0.035, z, Math.PI / 2, r.float(0, 6), 0);
    else if (k === 'pet') place('pet', M.pet, new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8), x, y + 0.035, z, Math.PI / 2, r.float(0, 6), 0);
    else if (k === 'can') place('can', r.chance(0.6) ? M.can : M.canS, new THREE.CylinderGeometry(0.033, 0.033, 0.12, 10), x, y + 0.033, z, Math.PI / 2, r.float(0, 6), 0);
    else if (k === 'card') place('card', M.card, new THREE.BoxGeometry(r.float(0.2, 0.5), 0.005, r.float(0.2, 0.4)), x, y + 0.004, z, r.gauss(0, 0.05), r.float(0, 6), 0);
    else { const g = bagGeometry(r, r.float(0.05, 0.1)); g.scale(1.6, 0.3, 1.2); place('scrap', r.chance(0.7) ? M.white : M.black, g, x, y, z, 0, r.float(0, 6), 0); }
  };

  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 85)) continue;
    const lr = lot.rng.fork('litter');
    const ng = lot.neglect ?? 0.3;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const Q = (s, o) => [lot.a[0] + tx * s - nx * o, lot.a[1] + tz * s - nz * o];
    // garbage bags put out for collection, at the curb or against the wall
    if (lr.chance(0.25 + 0.35 * ng)) {
      const s0 = lr.float(0.4, Math.max(0.5, lot.len - 0.4));
      const atCurb = lr.chance(0.6);
      const [bx, bz] = Q(s0, atCurb ? lot.sw - lr.float(0.25, 0.5) : lr.float(0.2, 0.4));
      const n = lr.weighted([[1, 3], [2, 3], [3, 2], [5, 1], [8, 0.4]]);
      for (let i = 0; i < n; i++) {
        const x = bx + lr.gauss(0, 0.3), z = bz + lr.gauss(0, 0.3);
        const size = lr.float(0.22, 0.34);
        const mat = lr.weighted([[M.black, 6], [M.blue, 1], [M.green, 0.6], [M.white, 1.2]]);
        place('bag' + mat.uuid, mat, bagGeometry(lr, size), x, groundY(x, z) - 0.01, z, 0, lr.float(0, 6), 0);
      }
      // dogs and collectors tear some open: rubbish around them
      if (lr.chance(0.4)) for (let i = 0; i < lr.int(3, 12); i++) smallItem(bx + lr.gauss(0, 0.7), bz + lr.gauss(0, 0.7));
    }
    // scattered litter along the frontage and in the gutter
    const items = Math.round(lr.float(0, 2) + ng * ng * 10);
    for (let i = 0; i < items; i++) {
      const [x, z] = Q(lr.float(0, lot.len), lr.chance(0.5) ? lot.sw + lr.float(-0.3, 0.35) : lr.float(0.1, lot.sw));
      smallItem(x, z);
    }
  }
  return B.build(group, { castShadow: true });
}
