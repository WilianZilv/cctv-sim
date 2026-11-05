// Front walls (muros), grilles, gates and wall toppers along each lot frontage.
import * as THREE from 'three';
import { boxGeometry, frameMatrix, Batcher, crookMatrix } from './mesh.js';

const T = 0.16;

export function buildWalls(ctx) {
  const { layout, lib, gy, group, focus } = ctx;
  const B = new Batcher();
  const near = (x, z, r) => Math.hypot(x - focus[0], z - focus[1]) < r * (ctx.detail ?? 1);
  const swY = ctx.sidewalkY;

  const plaster = (color, grime = 1, kind = 'plaster_stucco') => lib.get(kind, { tint: color, grime: grime * 1.3, porosity: 0.5, spall: 1 });
  const capMat = lib.get('concrete_plain', { tint: '#d8d4cb', grime: 0.4 });
  const steelMat = c => lib.get('steel', { tint: c, porosity: 0.1 });
  const wireMat = lib.plain({ color: '#8b8d8f', roughness: 0.4, metalness: 0.8 }, { porosity: 0 });
  wireMat.userData.noShadow = true;

  // everything added while `crook` is set gets the same out-of-true transform
  let crook = null;
  const Bc = { add: (key, mat, g, m) => B.add(key, mat, g, crook && m ? crook.clone().multiply(m) : (crook || m)) };
  const addBox = (key, mat, w, h, d, x, y, z, tx, tz, uvScale = 1) => {
    if (w <= 0.001 || h <= 0.001) return;
    const g = boxGeometry(w, h, d, uvScale);
    Bc.add(key, mat, g, frameMatrix(x, y, z, tx, tz));
  };

  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 135)) continue;
    const r = lot.rng.fork('walls');
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const at = (s, o = 0) => [lot.a[0] + tx * s + nx * o, lot.a[1] + tz * s + nz * o];
    const L = lot.len;
    const wall = lot.wall;
    if (!wall) continue;

    const wallMat = wall.style === 'block_raw' ? lib.get(lib.variant('block_raw', r), { grime: 0.8 })
      : wall.style === 'brick_raw' ? lib.get(lib.variant('brick_raw', r), { grime: 0.6 })
      : plaster(wall.color, 1, lib.variant(r.pick(['plaster_stucco', 'plaster_grafiato', 'plaster_smooth']), r));
    const stoneMat = lib.get(r.chance(0.7) ? 'canjiquinha' : 'stone_slab', { grime: 0.5 });
    const grilleColor = r.pick(['#1d1e1f', '#2a2b2d', '#f0efe9', '#3b4b3e', '#5d5f60', '#7a2a24']);

    // solid intervals between gates
    const gates = lot.gates.slice().sort((a, b) => a.s - b.s);
    const intervals = [];
    let cur = 0;
    for (const g of gates) {
      const g0 = g.s - g.w / 2 - 0.12, g1 = g.s + g.w / 2 + 0.12;
      if (g0 > cur + 0.05) intervals.push([cur, g0]);
      cur = Math.max(cur, g1);
    }
    if (L > cur + 0.05) intervals.push([cur, L]);

    const pillarAt = (s, hTop) => {
      const [x, z] = at(s, T / 2);
      const y0 = swY(x, z) - 0.3;
      const prev = crook;
      crook = crookMatrix(x, y0 + 0.3, z, tx, tz, r, { lean: 0.7, roll: 0.5, twist: 1.5, shift: 0.015 });
      const h = hTop + 0.3 + 0.08;
      if (wall.style === 'grille' || wall.style === 'base_grille' || wall.style === 'low_wall' || wall.style === 'plaster_full' || wall.style === 'stone_base') {
        addBox('wall:' + lot.id, wall.style === 'stone_base' ? wallMat : wallMat, 0.28, h, 0.28, x, y0 + h / 2, z, tx, tz);
        addBox('cap', capMat, 0.34, 0.05, 0.34, x, y0 + h + 0.025, z, tx, tz);
      }
      crook = prev;
    };

    for (const [s0, s1] of intervals) {
      const len = s1 - s0;
      const nPanels = Math.max(1, Math.round(len / 3));
      const pl = len / nPanels;
      for (let k = 0; k < nPanels; k++) {
        const a = s0 + k * pl, b = a + pl, m = (a + b) / 2;
        const [x, z] = at(m, T / 2);
        const [xa, za] = at(a), [xb, zb] = at(b);
        const base = Math.min(swY(xa, za), swY(xb, zb), swY(x, z)) - 0.35;
        const ground = swY(x, z);
        const top = ground + wall.h + r.gauss(0, 0.025);
        crook = crookMatrix(x, ground, z, tx, tz, r, { lean: 0.6, roll: 0.3, twist: 0.35, shift: 0.012 });
        const H = top - base;
        switch (wall.style) {
          case 'plaster_full':
          case 'block_raw':
          case 'brick_raw':
          case 'low_wall': {
            addBox('wall:' + lot.id, wallMat, pl, H, T, x, base + H / 2, z, tx, tz);
            if (wall.style === 'plaster_full' || wall.style === 'low_wall') addBox('cap', capMat, pl + 0.01, 0.05, T + 0.07, x, top + 0.025, z, tx, tz);
            break;
          }
          case 'stone_base': {
            const hb = ground + wall.baseH - base;
            addBox('stone:' + lot.id, stoneMat, pl, hb, T + 0.03, x, base + hb / 2, z, tx, tz);
            addBox('wall:' + lot.id, wallMat, pl, H - hb, T, x, base + hb + (H - hb) / 2, z, tx, tz);
            addBox('cap', capMat, pl + 0.01, 0.05, T + 0.07, x, top + 0.025, z, tx, tz);
            break;
          }
          case 'base_grille':
          case 'grille': {
            const bh = wall.style === 'grille' ? 0.25 : wall.baseH;
            const hb = ground + bh - base;
            addBox('wall:' + lot.id, wallMat, pl, hb, T, x, base + hb / 2, z, tx, tz);
            addBox('cap', capMat, pl + 0.01, 0.04, T + 0.05, x, base + hb + 0.02, z, tx, tz);
            grille(Bc, steelMat(grilleColor), at, a + 0.14, b - 0.14, ground + bh + 0.04, top, T / 2, tx, tz, r);
            break;
          }
          case 'fence_wire': {
            for (let s = a; s <= b + 0.01; s += pl) {
              const [px, pz] = at(s, 0.05);
              addBox('post', lib.get('concrete_raw', {}), 0.1, wall.h + 0.4, 0.1, px, swY(px, pz) - 0.4 + (wall.h + 0.4) / 2, pz, tx, tz);
            }
            for (let w = 0; w < 4; w++) {
              const y = ground + 0.4 + w * (wall.h - 0.5) / 3;
              addBox('wire', wireMat, pl, 0.006, 0.006, x, y, z, tx, tz);
            }
            break;
          }
        }
        // pillars at panel joints
        if (k > 0 && wall.style !== 'fence_wire') pillarAt(a, wall.h);
        topper(Bc, wall.topper, at, a, b, top + (wall.style === 'plaster_full' ? 0.05 : 0.0), T / 2, tx, tz, wireMat, steelMat('#3a3b3c'), lib, r);
        crook = null;
      }
    }
    // pillars around gates
    for (const g of gates) {
      pillarAt(g.s - g.w / 2 - 0.14, wall.h);
      pillarAt(g.s + g.w / 2 + 0.14, wall.h);
      const [gx, gz] = at(g.s, 0.06);
      // gates sag and sit out of square on their hinges
      crook = crookMatrix(gx, swY(gx, gz), gz, tx, tz, r, { lean: 0.6, roll: 0.6, twist: 0.8, shift: 0.02 });
      gate(Bc, g, lot, wall, at, swY, lib, steelMat, tx, tz, r);
      crook = null;
    }
    // side wall (divisa) at the a-end, going into the lot
    if (wall.style !== 'fence_wire') {
      const sideLen = Math.min(lot.depth, lot.setback ? Math.max(lot.setback + 1.5, 4) : r.float(5, 12));
      const sh = Math.max(wall.h, r.float(1.8, 2.6));
      const [x, z] = at(0.08, sideLen / 2);
      const base = swY(...at(0.08, 0.2)) - 0.3;
      const sideMat = r.chance(0.5) ? wallMat : r.chance(0.5) ? lib.get('block_raw', { grime: 0.8 }) : plaster('#b9b5ad', 1.2, 'plaster_smooth');
      crook = crookMatrix(x, base + 0.3, z, nx, nz, r, { lean: 0.6, roll: 0.4, twist: 0.4 });
      addBox('side:' + lot.id, sideMat, sideLen, sh + 0.3, 0.14, x, base + (sh + 0.3) / 2, z, nx, nz);
      crook = null;
    }
  }
  return B.build(group);
}

function grille(B, mat, at, s0, s1, y0, y1, off, tx, tz, r) {
  const h = y1 - y0;
  if (h < 0.2 || s1 - s0 < 0.1) return;
  const pitch = r.float(0.1, 0.14);
  const bar = r.chance(0.6) ? 0.016 : 0.012;
  const n = Math.floor((s1 - s0) / pitch);
  const [cx, cz] = at((s0 + s1) / 2, off);
  // rails
  for (const y of [y0 + 0.03, y1 - 0.03]) {
    B.add('grille', mat, boxGeometry(s1 - s0, 0.03, 0.03), frameMatrix(cx, y, cz, tx, tz));
  }
  const g = boxGeometry(bar, h, bar);
  for (let i = 0; i <= n; i++) {
    const s = s0 + (s1 - s0) * i / Math.max(1, n);
    const [x, z] = at(s, off);
    B.add('grille', mat, g, frameMatrix(x, y0 + h / 2, z, tx, tz));
  }
}

function topper(B, kind, at, s0, s1, y, off, tx, tz, wireMat, postMat, lib, r) {
  if (kind === 'none') return;
  const len = s1 - s0;
  const [cx, cz] = at((s0 + s1) / 2, off);
  if (kind === 'electric') {
    const posts = Math.max(1, Math.round(len / 2.5));
    for (let i = 0; i <= posts; i++) {
      const [x, z] = at(s0 + len * i / posts, off);
      B.add('efpost', postMat, boxGeometry(0.02, 0.55, 0.02), frameMatrix(x, y + 0.275, z, tx, tz));
    }
    for (let w = 0; w < 5; w++) {
      B.add('ewire', wireMat, boxGeometry(len, 0.005, 0.005), frameMatrix(cx, y + 0.08 + w * 0.11, cz, tx, tz));
    }
  } else if (kind === 'concertina') {
    const turns = Math.max(2, Math.round(len / 0.14));
    const pts = [];
    const R = 0.22;
    for (let i = 0; i <= turns * 10; i++) {
      const t = i / (turns * 10);
      const a = t * turns * Math.PI * 2;
      const s = s0 + len * t;
      const [x, z] = at(s, off + Math.cos(a) * R * 0.25);
      pts.push(new THREE.Vector3(x + Math.cos(a) * 0.0, y + R + Math.sin(a) * R, z).add(new THREE.Vector3(-tz, 0, tx).multiplyScalar(Math.cos(a) * R * 0.75)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    B.add('concertina', wireMat, new THREE.TubeGeometry(curve, pts.length, 0.004, 3, false));
    for (let i = 0; i <= Math.round(len / 3); i++) {
      const [x, z] = at(s0 + len * i / Math.max(1, Math.round(len / 3)), off);
      B.add('efpost', postMat, boxGeometry(0.03, 0.45, 0.03), frameMatrix(x, y + 0.22, z, tx, tz));
    }
  } else if (kind === 'spikes') {
    const n = Math.floor(len / 0.12);
    const cone = new THREE.ConeGeometry(0.018, 0.12, 4);
    for (let i = 0; i < n; i++) {
      const [x, z] = at(s0 + 0.06 + i * 0.12, off);
      B.add('spikes', postMat, cone, frameMatrix(x, y + 0.06, z, tx, tz));
    }
  } else if (kind === 'glass') {
    const n = Math.floor(len / 0.05);
    const glass = lib.plain({ color: '#5f7d55', roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.7 });
    for (let i = 0; i < n; i++) {
      const [x, z] = at(s0 + i * 0.05 + r.float(0, 0.04), off + r.float(-0.05, 0.05));
      const g = new THREE.ConeGeometry(r.float(0.01, 0.03), r.float(0.03, 0.08), 3);
      g.rotateY(r.float(0, 6));
      B.add('glass', glass, g, frameMatrix(x, y + 0.02, z, tx, tz));
    }
  }
}

function gate(B, g, lot, wall, at, swY, lib, steelMat, tx, tz, r) {
  const [cx, cz] = at(g.s, 0.06);
  const ground = swY(cx, cz);
  const h = Math.min(wall.h + (g.kind === 'garage' ? 0 : 0.05), r.float(2.0, 2.6));
  const style = g.style;
  const color = g.color;
  if (style === 'grille') {
    const mat = steelMat(color);
    grille(B, mat, at, g.s - g.w / 2, g.s + g.w / 2, ground + 0.03, ground + h, 0.06, tx, tz, r);
    // frame verticals
    for (const s of [g.s - g.w / 2, g.s + g.w / 2]) {
      const [x, z] = at(s, 0.06);
      B.add('gateframe', mat, boxGeometry(0.04, h, 0.04), frameMatrix(x, ground + h / 2, z, tx, tz));
    }
    if (g.kind === 'garage') {
      const [x, z] = at(g.s, 0.06);
      B.add('gateframe', mat, boxGeometry(0.04, h, 0.04), frameMatrix(x, ground + h / 2, z, tx, tz));
    }
    return;
  }
  const tex = style === 'slats' ? 'gate_slats' : style === 'sheet_perf' ? 'gate_perf' : (lot.id % 2 ? 'gate_ribs' : 'gate_flat');
  const mat = lib.get(tex, { tint: color, grime: 0.7, porosity: 0.1 });
  B.add('gate:' + tex + color, mat, boxGeometry(g.w, h - 0.03, 0.045), frameMatrix(cx, ground + 0.03 + (h - 0.03) / 2, cz, tx, tz));
  const fmat = steelMat(color);
  // frame
  B.add('gateframe', fmat, boxGeometry(g.w, 0.05, 0.06), frameMatrix(cx, ground + h - 0.025, cz, tx, tz));
  B.add('gateframe', fmat, boxGeometry(g.w, 0.05, 0.06), frameMatrix(cx, ground + 0.05, cz, tx, tz));
  if (g.kind === 'garage' && r.chance(0.6)) {
    // split into two leaves
    B.add('gateframe', fmat, boxGeometry(0.05, h, 0.065), frameMatrix(cx, ground + h / 2, cz, tx, tz));
  }
  // handle / lock box
  const [hx, hz] = at(g.s + g.w * 0.35, 0.0);
  B.add('handle', lib.plain({ color: '#2a2a2a', roughness: 0.4, metalness: 0.7 }), boxGeometry(0.06, 0.12, 0.05), frameMatrix(hx, ground + 1.1, hz, tx, tz));
}
