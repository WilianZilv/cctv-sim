// Large-scale sky occlusion: a height field of the block (ground, buildings, walls,
// tree crowns). Shaders march it along 8 azimuths to find the horizon angle and scale
// the sky/environment light by how much sky each point actually sees, so narrow
// streets, wall bases and yards get darker ambient like in reality.
import * as THREE from 'three';
import { globalUniforms } from '../tex/matlib.js';
import { pointInRing } from '../core/geom.js';

const RES = 512;

export function buildSkyVisibility(ctx, center, size = 180) {
  const { layout, gy } = ctx;
  const x0 = center[0] - size / 2, z0 = center[1] - size / 2;
  const k = RES / size;
  const data = new Float32Array(RES * RES * 4);
  // ground
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const g = gy(x0 + (i + 0.5) / k, z0 + (j + 0.5) / k) + 0.15;
    data[(j * RES + i) * 4] = g;
    data[(j * RES + i) * 4 + 2] = g;   // B: bare ground height (R gets raised below)
  }
  const raise = (i, j, h) => {
    if (i < 0 || j < 0 || i >= RES || j >= RES) return;
    const o = (j * RES + i) * 4;
    if (h > data[o]) data[o] = h;
  };
  // buildings: scan their bounding boxes
  for (const b of layout.buildings) {
    const ring = b.outer;
    let mx = Infinity, Mx = -Infinity, mz = Infinity, Mz = -Infinity;
    for (const p of ring) { mx = Math.min(mx, p[0]); Mx = Math.max(Mx, p[0]); mz = Math.min(mz, p[1]); Mz = Math.max(Mz, p[1]); }
    const top = (b.top ?? (gy(ring[0][0], ring[0][1]) + b.h)) + (b.pitched ? 1.2 : 0.6);
    const i0 = Math.floor((mx - x0) * k), i1 = Math.ceil((Mx - x0) * k), j0 = Math.floor((mz - z0) * k), j1 = Math.ceil((Mz - z0) * k);
    for (let j = Math.max(0, j0); j <= Math.min(RES - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(RES - 1, i1); i++) {
      if (pointInRing(x0 + (i + 0.5) / k, z0 + (j + 0.5) / k, ring)) raise(i, j, top);
    }
  }
  // front walls
  for (const lot of layout.lots) {
    if (!lot.wall || lot.wall.style === 'fence_wire') continue;
    const h = (lot.wall.style === 'grille' ? 0.6 : 1) * lot.wall.h;
    for (let s = 0; s <= lot.len; s += 0.25) {
      const x = lot.a[0] + lot.t[0] * s + lot.n[0] * 0.08, z = lot.a[1] + lot.t[1] * s + lot.n[1] * 0.08;
      raise(Math.floor((x - x0) * k), Math.floor((z - z0) * k), gy(x, z) + 0.15 + h);
    }
  }
  // tree crowns are left out: they are not solid columns (SSAO and shadows cover them)

  // G: sky visibility of a horizontal surface at ground level, baked once (the same
  // march the shader does, 8 azimuths x 8 steps). The street never changes, and
  // ground is most of the picture: there the shader reads this instead of marching.
  const hAt = (x, z) => {
    const i = Math.floor((x - x0) * k), j = Math.floor((z - z0) * k);
    if (i < 0 || j < 0 || i >= RES || j >= RES) return -1e9;
    return data[(j * RES + i) * 4];
  };
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const o = (j * RES + i) * 4;
    const x = x0 + (i + 0.5) / k, z = z0 + (j + 0.5) / k, y = data[o + 2] + 0.3;
    let acc = 0;
    for (let a = 0; a < 8; a++) {
      const ang = a * 0.7853982 + 0.39, dx = Math.cos(ang), dz = Math.sin(ang);
      let slope = 0, t = 0.55;
      for (let s = 0; s < 8; s++) {
        const h = hAt(x + dx * t, z + dz * t);
        if (h < -1e8) break;
        slope = Math.max(slope, (h - y) / t);
        t *= 1.75;
      }
      acc += 1 / (1 + slope * slope);
    }
    data[o + 1] = acc / 8;
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat, THREE.FloatType);
  // filtered so the horizon search does not show 35 cm blocks
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  globalUniforms.uHF.value = tex;
  globalUniforms.uHFRect.value.set(x0, z0, size, size);
  globalUniforms.uSkyVis.value = 1;
  return { tex, dispose() { tex.dispose(); globalUniforms.uSkyVis.value = 0; } };
}
