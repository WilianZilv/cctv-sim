// Facade variety for houses and small buildings. Each building draws a random
// combination of these features; none is a rule, most houses get two or three.
//   barrado      - band of tiles / stone / darker paint at the foot of the facade
//   twoTone      - upper floor painted in another colour
//   cornice      - concrete band between floors
//   balcony      - slab on the upper floor with grille / masonry / glass railing
//   unfinished   - top floor in raw brick/block with concrete columns and rebar
//   garageCover  - sheet roof on posts over the front yard / driveway
//   stair        - external stair to the upper floor (kitnet style)
//   roof extras  - TV antenna, satellite dish, solar water heater, clothesline
import * as THREE from 'three';
import { boxGeometry, wallStrip } from './mesh.js';

export function frameOut(x, y, z, ox, oz, out = 0) {
  const X = new THREE.Vector3(oz, 0, -ox).normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(ox, 0, oz).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  m.setPosition(x + ox * out, y, z + oz * out);
  return m;
}

export function pickFeatures(b, r, city) {
  const f = {};
  const small = b.floors <= 3;
  f.barrado = r.chance(0.35) ? r.weighted([['ceramic', 2], ['stone', 2], ['paint', 2], ['pastilha', 1], ['brick', 0.8]]) : null;
  f.barradoH = r.float(0.6, 1.3);
  f.twoTone = b.floors >= 2 && r.chance(0.3);
  f.cornice = b.floors >= 2 && r.chance(0.45);
  f.balcony = b.floors >= 2 && small && r.chance(0.4) ? r.weighted([['grille', 3], ['masonry', 2], ['glass', 0.6], ['balustre', 0.8]]) : null;
  f.unfinished = b.floors >= 2 && small && r.chance(city === 'sp' ? 0.2 : 0.1);
  f.garageCover = small && r.chance(0.35) ? r.weighted([['fibro', 3], ['poly', 2], ['metal', 1.5]]) : null;
  f.stair = b.floors >= 2 && small && r.chance(0.14);
  f.antenna = r.chance(0.45);
  f.dish = r.chance(0.25);
  f.solar = r.chance(city === 'sp' ? 0.18 : 0.12);
  f.clothes = !b.pitched && r.chance(0.25);
  f.window = r.weighted([['sliding', 4], ['vitro', 2], ['shutter', 1.5], ['maxim', 1.2]]);
  return f;
}

// e: { a, tx, tz, ox, oz, len }, street-facing edge of building b
export function buildFacadeFeatures(B, M, ctx, b, e, f, r, info) {
  const { lib } = ctx;
  const { groundRef, top } = info;
  const P = (s, h, out = 0) => {
    const x = e.a[0] + e.tx * s, z = e.a[1] + e.tz * s;
    const w = b.warp ? b.warp(x, h, z) : [0, 0];
    return [x + w[0] + e.ox * out, h, z + w[1] + e.oz * out];
  };
  const along = (s0, s1) => [[e.a[0] + e.tx * s0, e.a[1] + e.tz * s0], [e.a[0] + e.tx * s1, e.a[1] + e.tz * s1]];
  const side = info.side;
  const skin = (mat, key, y0, y1, out) => {
    const [p0, p1] = along(0.02, e.len - 0.02);
    const g = wallStrip([p0, p1], { bottom: () => y0, top: () => y1, side, step: 1.5, uOffset: 0, vRef: () => groundRef, warp: (x, y, z) => { const w = b.warp(x, y, z); return [w[0] + e.ox * out, w[1] + e.oz * out]; } });
    B.add(key, mat, g);
  };

  // ---- barrado at the foot of the facade
  if (f.barrado) {
    const mat = f.barrado === 'ceramic' ? lib.get(r.pick(['ceramic_red', 'ladrilho', 'ladrilho_b']), { grime: 1 })
      : f.barrado === 'stone' ? lib.get(r.chance(0.6) ? 'canjiquinha' : 'stone_slab', { grime: 0.8 })
      : f.barrado === 'pastilha' ? lib.get(r.pick(['pastilha_blue', 'pastilha_beige', 'pastilha_brown']), { grime: 0.6 })
      : f.barrado === 'brick' ? lib.get('brick', { grime: 0.8 })
      : lib.get('plaster_smooth', { tint: info.accent, grime: 1.4, spall: 1 });
    skin(mat, 'barrado:' + mat.uuid, groundRef - 0.4, groundRef + f.barradoH, 0.012);
  }
  // ---- upper floors in another colour
  if (f.twoTone) {
    const mat = lib.get('plaster_stucco', { tint: info.accent2, grime: 1.2, spall: 1 });
    skin(mat, 'twotone:' + mat.uuid, groundRef + b.floorH, top + (info.parapet || 0), 0.008);
  }
  // ---- concrete band between floors
  if (f.cornice) {
    for (let fl = 1; fl < b.floors; fl++) {
      const y = groundRef + fl * b.floorH;
      const [x, , z] = P(e.len / 2, y, 0.06);
      B.add('cornice', M.cap, boxGeometry(e.len + 0.1, 0.16, 0.12), frameOut(x, y, z, e.ox, e.oz, 0));
    }
  }
  // ---- unfinished top floor: raw masonry skin, columns, rebar sticking out
  if (f.unfinished) {
    const y0 = groundRef + (b.floors - 1) * b.floorH;
    const mat = lib.get(r.chance(0.6) ? 'brick_raw' : 'block_raw', { grime: 0.7 });
    skin(mat, 'unfinished:' + mat.uuid, y0, top + 0.3, 0.015);
    const conc = lib.get('concrete_raw', { grime: 0.8 });
    const steel = lib.plain({ color: '#5a3a2a', roughness: 0.7, metalness: 0.6 }, { porosity: 0.1 });
    const n = Math.max(2, Math.round(e.len / 3.5) + 1);
    for (let i = 0; i < n; i++) {
      const s = 0.15 + (e.len - 0.3) * i / (n - 1);
      const [x, , z] = P(s, y0, 0.05);
      B.add('column', conc, boxGeometry(0.2, top - y0 + 0.3, 0.2), frameOut(x, (y0 + top + 0.3) / 2, z, e.ox, e.oz, 0));
      // rebar waiting for the next floor
      for (let k = 0; k < 4; k++) {
        const rx = (k % 2 ? 0.06 : -0.06), rz = (k > 1 ? 0.06 : -0.06);
        const g = new THREE.CylinderGeometry(0.006, 0.006, r.float(0.5, 1.1), 4);
        const hh = g.parameters.height;
        B.add('rebar', steel, g, new THREE.Matrix4().makeTranslation(x + e.oz * rx + e.ox * rz, top + 0.3 + hh / 2, z - e.ox * rx + e.oz * rz));
      }
    }
    const [bx, , bz] = P(e.len / 2, top + 0.15, 0.05);
    B.add('beam', conc, boxGeometry(e.len, 0.3, 0.2), frameOut(bx, top + 0.15, bz, e.ox, e.oz, 0));
  }
  // ---- balcony on the first upper floor
  if (f.balcony && e.len > 3) {
    const w = Math.min(e.len - 0.6, r.float(2, 4.5)), depth = r.float(0.8, 1.3);
    const s = r.float(w / 2 + 0.3, e.len - w / 2 - 0.3);
    const y = groundRef + b.floorH;
    const [x, , z] = P(s, y, depth / 2);
    B.add('balcony', M.cap, boxGeometry(w, 0.14, depth), frameOut(x, y - 0.07, z, e.ox, e.oz, 0));
    const [fx, , fz] = P(s, y, depth - 0.03);
    if (f.balcony === 'masonry') {
      B.add('balconyWall', lib.get('plaster_smooth', { tint: info.accent, grime: 1 }), boxGeometry(w, 0.95, 0.1), frameOut(fx, y + 0.47, fz, e.ox, e.oz, 0));
    } else if (f.balcony === 'glass') {
      B.add('balconyGlass', lib.plain({ color: '#9fb4bb', roughness: 0.05, transparent: true, opacity: 0.35 }, { porosity: 0, dirt: 0 }), boxGeometry(w, 0.9, 0.012), frameOut(fx, y + 0.5, fz, e.ox, e.oz, 0));
      B.add('balconyRail', M.steel('#c2c5c7'), boxGeometry(w, 0.04, 0.05), frameOut(fx, y + 0.97, fz, e.ox, e.oz, 0));
    } else {
      const gm = M.steel(r.pick(['#1d1e1f', '#ecebe6', '#2f2f30', '#7b2b25']));
      const nb = Math.round(w / (f.balcony === 'balustre' ? 0.18 : 0.12));
      for (let i = 0; i <= nb; i++) {
        const ss = s - w / 2 + w * i / nb;
        const [bx2, , bz2] = P(ss, y, depth - 0.03);
        const g = f.balcony === 'balustre' ? new THREE.CylinderGeometry(0.035, 0.045, 0.8, 6) : boxGeometry(0.015, 0.9, 0.015);
        B.add('balconyBar' + f.balcony, f.balcony === 'balustre' ? M.cap : gm, g, frameOut(bx2, y + 0.45, bz2, e.ox, e.oz, 0));
      }
      B.add('balconyRail', f.balcony === 'balustre' ? M.cap : gm, boxGeometry(w, 0.06, f.balcony === 'balustre' ? 0.12 : 0.04), frameOut(fx, y + 0.92, fz, e.ox, e.oz, 0));
    }
    // a glass door onto the balcony
    const [dx, , dz] = P(s, y, 0.02);
    B.add('glass', M.glass, new THREE.PlaneGeometry(Math.min(1.6, w - 0.4), 2.1), frameOut(dx, y + 1.05, dz, e.ox, e.oz, 0));
  }
  // ---- external stair up to the second floor
  if (f.stair && e.len > 4.5) {
    const run = r.float(3, 3.8), sw = 0.85;
    const s0 = r.chance(0.5) ? 0.2 : e.len - run - 0.2;
    const dir = s0 < e.len / 2 ? 1 : -1;
    const steps = Math.round(b.floorH / 0.18);
    const conc = lib.get('concrete_old', { grime: 1 });
    for (let i = 0; i < steps; i++) {
      const s = dir > 0 ? s0 + run * i / steps : s0 + run - run * i / steps;
      const h = (i + 1) * b.floorH / steps;
      const [x, , z] = P(s, groundRef, sw / 2 + 0.02);
      B.add('stair', conc, boxGeometry(run / steps + 0.02, h, sw), frameOut(x, groundRef + h / 2, z, e.ox, e.oz, 0));
    }
    const [lx, , lz] = P(dir > 0 ? s0 + run + 0.6 : s0 - 0.6, groundRef + b.floorH, sw / 2 + 0.02);
    B.add('stair', conc, boxGeometry(1.2, 0.14, sw), frameOut(lx, groundRef + b.floorH - 0.07, lz, e.ox, e.oz, 0));
    const gm = M.steel('#1d1e1f');
    for (let i = 0; i <= 6; i++) {
      const s = s0 + run * i / 6;
      const h = (dir > 0 ? i / 6 : 1 - i / 6) * b.floorH;
      const [x, , z] = P(s, groundRef, sw + 0.02);
      B.add('stairRail', gm, boxGeometry(0.03, 0.95, 0.03), frameOut(x, groundRef + h + 0.48, z, e.ox, e.oz, 0));
    }
  }
}

// cover on posts from the facade to the front wall, over the driveway
export function garageCover(B, M, ctx, lot, f, r) {
  const { lib } = ctx;
  const g = lot.gates.find(x => x.kind === 'garage');
  if (!g || !lot.setback || lot.setback < 2.2) return;
  const [tx, tz] = lot.t, [nx, nz] = lot.n;
  const w = g.w + r.float(0.4, 1.2), d = lot.setback - 0.2;
  const cx = lot.a[0] + tx * g.s + nx * (d / 2 + 0.1), cz = lot.a[1] + tz * g.s + nz * (d / 2 + 0.1);
  const y0 = ctx.sidewalkY(cx, cz);
  const hHouse = r.float(2.6, 3.0), hFront = hHouse - d * r.float(0.08, 0.15);
  const mat = f.garageCover === 'fibro' ? M.fibroCover
    : f.garageCover === 'poly' ? lib.plain({ color: r.pick(['#d8d4c4', '#9ab2b8', '#c9b98a']), roughness: 0.3, transparent: true, opacity: 0.6, side: THREE.DoubleSide }, { porosity: 0, dirt: 0 })
    : lib.get('steel', { tint: r.pick(['#8a8c8a', '#5a3b28', '#3a4a5c', '#b7b2a4']), grime: 0.8 });
  const slope = Math.atan2(hHouse - hFront, d);
  const roof = new THREE.BoxGeometry(w, 0.02, d / Math.cos(slope));
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(tx, 0, tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-nx, 0, -nz));
  m.multiply(new THREE.Matrix4().makeRotationX(-slope));
  m.setPosition(cx, y0 + (hHouse + hFront) / 2, cz);
  B.add('cover:' + mat.uuid, mat, roof, m);
  const post = M.steel(r.pick(['#1d1e1f', '#ecebe6', '#5d5f60']));
  for (const sx of [-1, 1]) {
    const px = lot.a[0] + tx * (g.s + sx * w / 2 * 0.95) + nx * 0.25, pz = lot.a[1] + tz * (g.s + sx * w / 2 * 0.95) + nz * 0.25;
    B.add('coverPost', post, boxGeometry(0.06, hFront, 0.06, 1, 0), new THREE.Matrix4().makeTranslation(px, y0 + hFront / 2, pz));
  }
}

export function roofExtras(B, M, ctx, b, f, c, top, r) {
  const steel = M.steel('#9a9ea2');
  const hRoof = top + (b.pitched ? 1.2 : 0.1);
  if (f.antenna) {
    const [x, z] = [c[0] + r.float(-2, 2), c[1] + r.float(-2, 2)];
    const h = r.float(1.8, 3.5);
    B.add('antenna', steel, new THREE.CylinderGeometry(0.015, 0.02, h, 5), new THREE.Matrix4().makeTranslation(x, hRoof + h / 2, z));
    const yaw = r.float(0, 3.14);
    for (let i = 0; i < r.int(4, 9); i++) {
      const l = 0.9 - i * 0.07;
      const g = new THREE.CylinderGeometry(0.006, 0.006, l, 3).rotateZ(Math.PI / 2).rotateY(yaw);
      g.translate(x + Math.cos(yaw) * i * 0.12, hRoof + h - 0.1, z - Math.sin(yaw) * i * 0.12);
      B.add('antenna', steel, g);
    }
  }
  if (f.dish) {
    const [x, z] = [c[0] + r.float(-2.5, 2.5), c[1] + r.float(-2.5, 2.5)];
    const g = new THREE.SphereGeometry(0.32, 12, 6, 0, Math.PI * 2, 0, 0.7).rotateX(-1.2).rotateY(r.float(0, 6));
    B.add('dish', M.cap, g, new THREE.Matrix4().makeTranslation(x, hRoof + 0.5, z));
    B.add('antenna', steel, new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), new THREE.Matrix4().makeTranslation(x, hRoof + 0.25, z));
  }
  if (f.solar) {
    const panel = M.solar;
    const yaw = r.float(0, 6.28);
    for (let i = 0; i < r.int(1, 3); i++) {
      const x = c[0] + r.float(-1.5, 1.5), z = c[1] + r.float(-1.5, 1.5);
      const g = new THREE.BoxGeometry(1.0, 0.06, 2.0).rotateX(-0.45).rotateY(yaw);
      B.add('solar', panel, g, new THREE.Matrix4().makeTranslation(x, hRoof + 0.55, z));
      B.add('solarTank', M.ac, new THREE.CylinderGeometry(0.22, 0.22, 1.2, 10).rotateZ(Math.PI / 2).rotateY(yaw), new THREE.Matrix4().makeTranslation(x, hRoof + 1.05, z));
    }
  }
  if (f.clothes) {
    const x = c[0] + r.float(-2, 2), z = c[1] + r.float(-2, 2);
    const yaw = r.float(0, 3.14);
    const line = M.steel('#d9d8d2');
    for (const k of [-1, 1]) B.add('clothesPost', line, new THREE.CylinderGeometry(0.015, 0.015, 1.6, 4), new THREE.Matrix4().makeTranslation(x + Math.cos(yaw) * k * 1.5, top + 0.8, z - Math.sin(yaw) * k * 1.5));
    const cols = ['#c23b3b', '#3b6fc2', '#e8e4da', '#2f2f2f', '#d9b23a', '#5a9a5a', '#d97aa8'];
    for (let i = 0; i < r.int(3, 9); i++) {
      const t = r.float(-1.3, 1.3);
      const g = new THREE.PlaneGeometry(r.float(0.3, 0.7), r.float(0.3, 0.8)).translate(0, -0.3, 0).rotateY(yaw);
      g.translate(x + Math.cos(yaw) * t, top + 1.55, z - Math.sin(yaw) * t);
      B.add('cloth' + i % 4, ctx.lib.plain({ color: r.pick(cols), roughness: 0.9, side: THREE.DoubleSide }, { porosity: 0.8, dirt: 0 }), g);
    }
  }
}
