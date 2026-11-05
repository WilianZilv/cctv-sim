// Street furniture: concrete utility poles with the usual tangle of wires,
// streetlights, transformers, trees, trash, meter boxes, signs, bus stops, bumps.
import * as THREE from 'three';
import { pointAt, Region } from '../core/geom.js';
import { boxGeometry, frameMatrix, Batcher } from './mesh.js';
import { streetPlate, warningPlate } from './signs.js';
import { bagGeometry } from './litter.js';

export function buildProps(ctx) {
  const { layout, lib, gy, group, focus, rng } = ctx;
  const B = new Batcher();
  const near = (x, z, r) => Math.hypot(x - focus[0], z - focus[1]) < r * (ctx.detail ?? 1);
  const M = {
    concrete: lib.get('concrete_raw', { grime: 0.6, porosity: 0.5 }),
    wire: lib.plain({ color: '#151515', roughness: 0.6, metalness: 0.0 }, { porosity: 0, irGain: 0.8 }),
    wireBright: lib.plain({ color: '#7d8083', roughness: 0.35, metalness: 0.9 }, { porosity: 0 }),
    porcelain: lib.plain({ color: '#d9d6cf', roughness: 0.25 }, { porosity: 0 }),
    metalGrey: lib.plain({ color: '#7a7d80', roughness: 0.5, metalness: 0.6 }, { porosity: 0.1 }),
    darkMetal: lib.plain({ color: '#2c2d2f', roughness: 0.5, metalness: 0.5 }, { porosity: 0.1 }),
    bark: lib.get('bark', { porosity: 0.4, irGain: 1.4 }),
    soil: lib.get('soil', { porosity: 0.5 }),
    bin: lib.plain({ color: '#3d6b3a', roughness: 0.6 }, { porosity: 0.1 }),
    binGrey: lib.plain({ color: '#5d6062', roughness: 0.6 }, { porosity: 0.1 }),
    bag: lib.plain({ color: '#121212', roughness: 0.35 }, { porosity: 0.05, irGain: 0.9 }),
    bagBlue: lib.plain({ color: '#2b4f8a', roughness: 0.4 }, { porosity: 0.05 }),
    meter: lib.plain({ color: '#c8c6be', roughness: 0.5, metalness: 0.2 }, { porosity: 0.1 }),
    yellow: lib.plain({ color: '#d8a91c', roughness: 0.6 }, { porosity: 0.3 }),
    black: lib.plain({ color: '#151515', roughness: 0.6 }, { porosity: 0.3 }),
  };
  const sY = (x, z) => ctx.sidewalkY(x, z);

  // ---------- utility poles ----------
  const poles = [];
  const carr = layout.regions.carr;
  for (const road of layout.roads) {
    if (road.cls === 'service' || road.sw < 1) continue;
    if (!road.pts.some(p => near(p[0], p[1], 150))) continue;
    const pr = rng.fork('poles' + road.pts[0].join());
    const side = pr.sign();
    const off = side * (road.w / 2 + 0.35);
    if ((side > 0 ? road.swR : road.swL) < 1) continue;
    const spacing = ctx.cfg.props.poleSpacing * pr.float(0.85, 1.15);
    for (let s = pr.float(3, spacing); s < road.len - 2; s += spacing * pr.float(0.85, 1.15)) {
      const q = pointAt(road.pts, s);
      const x = q.x - q.dz * off, z = q.z + q.dx * off;
      if (!near(x, z, 140)) continue;
      // keep off the carriageway of crossing streets
      if (carr.contains(x, z)) continue;
      if (poles.some(p => Math.hypot(p.x - x, p.z - z) < 12)) continue;
      const kind = pr.weighted([['dt', 3], ['round', 1.5]]);
      const h = pr.float(9.5, 11.5);
      const toward = pr.gauss(0.012, 0.015) * -side;
      const lx = -q.dz * toward + pr.gauss(0, 0.01), lz = q.dx * toward + pr.gauss(0, 0.01);
      poles.push({ x, z, y: sY(x, z), h, kind, road, tx: q.dx, tz: q.dz, side, lx, lz, transformer: pr.chance(0.2), light: pr.chance(0.85), r: pr.fork('p' + poles.length) });
    }
  }
  for (const p of poles) buildPole(B, M, p, lib, ctx);
  // wires between neighbouring poles of the same road side
  for (let i = 0; i < poles.length; i++) {
    const a = poles[i];
    let best = null, bd = 48;
    for (let j = 0; j < poles.length; j++) {
      if (i === j) continue;
      const b = poles[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < bd && d > 8 && (b.x - a.x) * a.tx + (b.z - a.z) * a.tz > 0) { bd = d; best = b; }
    }
    if (best) wiresBetween(B, M, a, best, a.r, ctx.cfg.props.wires);
  }
  // service drops from poles to houses
  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 90) || lot.use === 'vacant') continue;
    const r = lot.rng.fork('drop');
    let best = null, bd = 30;
    for (const p of poles) { const d = Math.hypot(p.x - lot.c[0], p.z - lot.c[1]); if (d < bd) { bd = d; best = p; } }
    if (!best || !r.chance(0.8)) continue;
    const s = r.float(0.3, lot.len - 0.3);
    const fx = lot.a[0] + lot.t[0] * s + lot.n[0] * 0.3, fz = lot.a[1] + lot.t[1] * s + lot.n[1] * 0.3;
    const mastH = (lot.wall ? lot.wall.h : 2.8) + r.float(0.6, 1.4);
    const fy = sY(fx, fz) + mastH;
    // mast (pontalete) + meter box on the wall
    B.add('mast', M.metalGrey, new THREE.CylinderGeometry(0.025, 0.025, mastH, 6), new THREE.Matrix4().makeTranslation(fx, sY(fx, fz) + mastH / 2, fz));
    if (lot.wall) B.add('meter', M.meter, boxGeometry(0.35, 0.45, 0.18), frameMatrix(fx - lot.n[0] * 0.38, sY(fx, fz) + 1.3, fz - lot.n[1] * 0.38, lot.t[0], lot.t[1]));
    catenary(B, M.wire, att(best, best.x, best.y + 6.6, best.z), [fx, fy, fz], r.float(0.12, 0.3), 0.006);
    if (r.chance(0.6)) catenary(B, M.wire, att(best, best.x, best.y + 5.4, best.z), [fx, fy - 0.3, fz], r.float(0.15, 0.4), 0.004);
  }

  // ---------- streetlights as real lights near the camera ----------
  const lamps = poles.filter(p => p.light).map(p => ({ p, d: Math.hypot(p.x - focus[0], p.z - focus[1]) })).sort((a, b) => a.d - b.d);
  const sodiumShare = ctx.city === 'cwb' ? 0.35 : 0.2;
  lamps.forEach(({ p, d }, idx) => {
    const sodium = p.r.chance(sodiumShare);
    const color = sodium ? new THREE.Color('#ffae55') : new THREE.Color(p.r.pick(['#fff1e0', '#ffffff', '#f2f4ff']));
    const ax = -p.side * 0 + (-p.tz) * (-p.side), az = p.tx * (-p.side); // arm points over the road
    const ly = p.y + p.h - 1.4;
    const [lx, , lz] = att(p, p.x + ax * 1.9, ly, p.z + az * 1.9);
    const emissive = lib.plain({ color: '#222222', emissive: color, emissiveIntensity: 0, roughness: 0.3 }, { porosity: 0 });
    B.add('lampHead' + idx, M.darkMetal, boxGeometry(0.62, 0.1, 0.3), frameMatrix(lx, ly + 0.05, lz, ax, az));
    const lens = new THREE.PlaneGeometry(0.5, 0.24).rotateX(Math.PI / 2);
    B.add('lampLens' + idx, emissive, lens, frameMatrix(lx, ly - 0.005, lz, ax, az));
    const broken = p.r.chance(0.08);
    const entry = { mat: emissive, matBase: broken ? 0 : 60, threshold: p.r.float(0.2, 0.5) };
    if (idx < 10 && d < 90 && !broken) {
      const light = new THREE.SpotLight(color, 0, 45, THREE.MathUtils.degToRad(72), 0.6, 2);
      light.position.set(lx, ly - 0.1, lz);
      light.target.position.set(lx + ax * 3, p.y, lz + az * 3);
      // one shadowed streetlight keeps the material shaders inside 16 texture units
      light.castShadow = idx < 1;
      if (light.castShadow) { light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.0005; light.shadow.camera.near = 0.5; light.shadow.camera.far = 40; }
      group.add(light, light.target);
      entry.light = light;
      entry.base = sodium ? 1.6 : 2.4; // kcd
    } else {
      entry.light = new THREE.Object3D();
      entry.base = 0;
    }
    ctx.lights.push(entry);
  });

  // ---------- trees ----------
  const trees = [];
  for (const road of layout.roads) {
    if (road.sw < 1.4) continue;
    if (!road.pts.some(p => near(p[0], p[1], 130))) continue;
    const tr = rng.fork('trees' + road.pts[0].join());
    const density = tr.weighted([[0, 1.5], [0.03, 2], [0.07, 2], [0.12, 1]]) * ctx.cfg.props.trees;
    const n = Math.floor(road.len * density);
    for (let i = 0; i < n; i++) {
      const s = tr.float(2, road.len - 2);
      const q = pointAt(road.pts, s);
      const side = tr.sign();
      const off = side * (road.w / 2 + 0.45);
      const x = q.x - q.dz * off, z = q.z + q.dx * off;
      if (!near(x, z, 120) || carr.contains(x, z)) continue;
      if (poles.some(p => Math.hypot(p.x - x, p.z - z) < 2.5) || trees.some(t => Math.hypot(t.x - x, t.z - z) < 5)) continue;
      if ((ctx.ramps || []).some(r => Math.hypot(r.x - x, r.z - z) < r.w / 2 + 0.8)) continue;
      trees.push({ x, z, r: tr.fork('t' + i) });
    }
  }
  for (const t of trees) { buildTree(B, M, ctx, t); (ctx.spots ||= []).push({ kind: 'tree', x: t.x, z: t.z }); }

  // ---------- trash ----------
  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 70)) continue;
    const r = lot.rng.fork('trash');
    const s = r.float(0.5, lot.len - 0.5);
    const [nx, nz] = lot.n, [tx, tz] = lot.t;
    const tm = ctx.cfg.props.trash;
    if (ctx.city === 'cwb' && r.chance(Math.min(1, 0.45 * tm)) && lot.use !== 'vacant') {
      // elevated wire-mesh cage on a post
      const off = -(lot.sw - 0.45);
      const x = lot.a[0] + tx * s + nx * off, z = lot.a[1] + tz * s + nz * off;
      if (carr.contains(x, z)) continue;
      const y = sY(x, z);
      B.add('cagePost', M.darkMetal, new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6), new THREE.Matrix4().makeTranslation(x, y + 0.6, z));
      cage(B, M, x, y + 1.2, z, tx, tz, r);
    } else if (ctx.city === 'sp' && r.chance(Math.min(1, 0.15 * tm))) {
      const x = lot.a[0] + tx * s - nx * 0.5, z = lot.a[1] + tz * s - nz * 0.5;
      const y = sY(x, z);
      B.add('bin', r.chance(0.5) ? M.bin : M.binGrey, boxGeometry(0.58, 1.0, 0.72), frameMatrix(x, y + 0.5, z, tx, tz));
    }
    // warning / for-sale plates on walls
    if (lot.wall && lot.wall.h > 1.5 && r.chance(0.25)) {
      const { tex, aspect } = warningPlate(r);
      const m = lib.plain({ map: tex, roughness: 0.5 }, { porosity: 0.1 });
      const ps = r.float(0.4, lot.len - 0.4);
      if (!lot.gates.some(g => Math.abs(g.s - ps) < g.w / 2 + 0.4)) {
        const x = lot.a[0] + tx * ps - nx * 0.01, z = lot.a[1] + tz * ps - nz * 0.01;
        const w = 0.45;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w / aspect), m);
        mesh.position.set(x, sY(x, z) + Math.min(lot.wall.h - 0.3, 1.6), z);
        mesh.lookAt(x - nx, mesh.position.y, z - nz);
        group.add(mesh);
      }
    }
  }

  // ---------- caçamba (rubble skip) ----------
  {
    const r = rng.fork('cacamba');
    if (r.chance(Math.min(1, 0.35 * ctx.cfg.props.cacamba))) {
      const lot = r.pick(layout.lots.filter(l => near(l.c[0], l.c[1], 45)));
      if (lot) {
        const s = r.float(1.5, Math.max(1.6, lot.len - 1.5));
        const off = -(lot.sw + 1.1);
        const x = lot.a[0] + lot.t[0] * s + lot.n[0] * off, z = lot.a[1] + lot.t[1] * s + lot.n[1] * off;
        const y = ctx.roadSurf(x, z);
        const col = r.pick(['#d08a1c', '#c43a1d', '#2f6db0', '#d8c31e', '#3d6b3a']);
        const m = lib.get('steel', { tint: col, grime: 1.2 });
        B.add('cacamba', m, boxGeometry(3.2, 1.2, 1.7), frameMatrix(x, y + 0.6, z, lot.t[0], lot.t[1]));
        const rubble = lib.get('brick_raw', {});
        const g = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
        g.scale(1.4, 0.5, 0.75);
        B.add('rubble', rubble, g, frameMatrix(x, y + 1.1, z, lot.t[0], lot.t[1]));
        ctx.obstacles = (ctx.obstacles || []).concat([{ x, z, r: 1.8 }]);
      }
    }
  }

  // ---------- speed bumps ----------
  for (const bump of ctx.bumps || []) {
    const { q, road } = bump;
    const w = road.w;
    const g = new THREE.CylinderGeometry(1.0, 1.0, w, 16, 1, false, -0.55, 1.1);
    g.rotateZ(Math.PI / 2);
    g.scale(1, 0.12, 1.85);
    const m = frameMatrix(q.x, ctx.roadSurf(q.x, q.z) - 0.1, q.z, -q.dz, q.dx);
    const mat = lib.get('asphalt_patch', { macro: 0.2, puddles: false });
    B.add('bump', mat, g, m);
    // painted chevrons
    const paint = lib.plain({ color: '#d8a91c', roughness: 0.6, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }, { porosity: 0.2, paintWear: 0.5 });
    for (let o = -w / 2 + 0.5; o < w / 2 - 0.3; o += 1.0) {
      const sg = new THREE.PlaneGeometry(0.45, 1.5).rotateX(-Math.PI / 2);
      sg.translate(0, 0.02, 0);
      const x = q.x - q.dz * o, z = q.z + q.dx * o;
      B.add('bumpPaint', paint, sg, frameMatrix(x, ctx.roadSurf(x, z) + 0.0, z, q.dx, q.dz));
    }
    ctx.bumpsBuilt = true;
  }

  // ---------- street name plates at corners ----------
  const plateDone = new Set();
  for (const road of layout.roads) {
    if (!road.name || road.cls === 'service') continue;
    for (const end of [road.pts[0], road.pts[road.pts.length - 1]]) {
      if (!near(end[0], end[1], 80)) continue;
      const key = road.name + Math.round(end[0] / 20) + Math.round(end[1] / 20);
      if (plateDone.has(key)) continue;
      plateDone.add(key);
      const pr = rng.fork('plate' + key);
      const q = pointAt(road.pts, end === road.pts[0] ? 6 : road.len - 6);
      const ps = pr.sign();
      const off = ps * (road.w / 2 + (ps > 0 ? road.swR : road.swL) - 0.4);
      const x = q.x - q.dz * off, z = q.z + q.dx * off;
      if (carr.contains(x, z)) continue;
      const y = sY(x, z);
      B.add('signPost', M.metalGrey, new THREE.CylinderGeometry(0.03, 0.03, 2.8, 6), new THREE.Matrix4().makeTranslation(x, y + 1.4, z));
      const tex = streetPlate(road.name, ctx.city);
      const m = lib.plain({ map: tex, roughness: 0.4, side: THREE.DoubleSide }, { porosity: 0.1 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225), m);
      plate.position.set(x, y + 2.6, z);
      plate.lookAt(x - q.dz, y + 2.6, z + q.dx);
      group.add(plate);
    }
  }

  // ---------- bus stops ----------
  for (const stop of ctx.site.stops) {
    if (!near(stop.pos[0], stop.pos[1], 90)) continue;
    let best = null, bd = 25;
    for (const lot of layout.lots) { const d = Math.hypot(lot.c[0] - stop.pos[0], lot.c[1] - stop.pos[1]); if (d < bd) { bd = d; best = lot; } }
    if (!best || best.sw < 2) continue;
    const r = rng.fork('stop' + stop.name);
    const s = best.len / 2;
    const off = -(best.sw * 0.55);
    const x = best.a[0] + best.t[0] * s + best.n[0] * off, z = best.a[1] + best.t[1] * s + best.n[1] * off;
    const y = sY(x, z);
    const [tx, tz] = best.t;
    const frameMat = lib.get('steel', { tint: ctx.city === 'cwb' ? '#1d5f9e' : '#3a3d40', grime: 0.5 });
    for (const sx of [-1.6, 1.6]) {
      const px = x + tx * sx - best.n[0] * 0.6, pz = z + tz * sx - best.n[1] * 0.6;
      B.add('stopPost', frameMat, boxGeometry(0.08, 2.5, 0.08), frameMatrix(px, y + 1.25, pz, tx, tz));
    }
    B.add('stopRoof', frameMat, boxGeometry(3.6, 0.08, 1.6), frameMatrix(x, y + 2.52, z, tx, tz));
    B.add('stopBench', M.metalGrey, boxGeometry(2.4, 0.06, 0.4), frameMatrix(x + best.n[0] * 0.3, y + 0.45, z + best.n[1] * 0.3, tx, tz));
    const glass = lib.plain({ color: '#a8b8bf', roughness: 0.1, transparent: true, opacity: 0.25 }, { porosity: 0 });
    B.add('stopGlass', glass, boxGeometry(3.2, 1.8, 0.02), frameMatrix(x + best.n[0] * 0.55, y + 1.3, z + best.n[1] * 0.55, tx, tz));
    ctx.busStops = (ctx.busStops || []).concat([{ x, z, road: best.road, lot: best }]);
  }

  ctx.poles = poles;
  ctx.trees = trees;
  return B.build(group);
}

// point on a leaning pole: x/z drift with height above its base
const att = (p, x, y, z) => [x + p.lx * (y - p.y), y, z + p.lz * (y - p.y)];

function buildPole(B0, M, p, lib, ctx) {
  const lean = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.atan(p.lz), 0, -Math.atan(p.lx), 'XYZ')))
    .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
  const B = { add: (k, mat, g, m) => B0.add(k, mat, g, m ? lean.clone().multiply(m) : lean) };
  const { x, z, y, h, kind } = p;
  const bury = 0.3;
  if (kind === 'dt') {
    // double-T section: two flanges + web, tapered by scaling
    const g = new THREE.BoxGeometry(0.28, h + bury, 0.16, 1, 4, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) + (h + bury) / 2) / (h + bury);
      const s = 1 - 0.45 * t;
      pos.setX(i, pos.getX(i) * s);
      pos.setZ(i, pos.getZ(i) * (1 - 0.25 * t));
    }
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.3, uv.getY(i) * h);
    g.computeVertexNormals();
    B.add('pole', M.concrete, g, frameMatrix(x, y - bury + (h + bury) / 2, z, p.tx, p.tz));
  } else {
    const g = new THREE.CylinderGeometry(0.09, 0.16, h + bury, 10, 4);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.8, uv.getY(i) * h);
    B.add('pole', M.concrete, g, new THREE.Matrix4().makeTranslation(x, y - bury + (h + bury) / 2, z));
  }
  const top = y + h;
  // primary crossarm with three insulators
  const nx = -p.tz, nz = p.tx;
  B.add('crossarm', M.concrete, boxGeometry(2.0, 0.1, 0.1), frameMatrix(x, top - 0.4, z, nx, nz));
  for (const o of [-0.9, 0, 0.9]) {
    B.add('insul', M.porcelain, new THREE.CylinderGeometry(0.05, 0.07, 0.18, 8), new THREE.Matrix4().makeTranslation(x + nx * o, top - 0.26, z + nz * o));
  }
  // secondary rack
  for (let i = 0; i < 4; i++) B.add('insul', M.porcelain, new THREE.CylinderGeometry(0.035, 0.035, 0.08, 6).rotateZ(Math.PI / 2), frameMatrix(x + p.tx * 0.12, y + 7.2 - i * 0.2, z + p.tz * 0.12, p.tx, p.tz));
  // telecom clamps + coiled spare fibre
  B.add('clamp', M.darkMetal, boxGeometry(0.22, 0.12, 0.22), frameMatrix(x, y + 5.6, z, p.tx, p.tz));
  if (p.r.chance(0.35)) {
    const coil = new THREE.TorusGeometry(p.r.float(0.25, 0.4), 0.025, 5, 20);
    B.add('coil', M.wire, coil, frameMatrix(x + nx * 0.25, y + 5.0, z + nz * 0.25, p.tx, p.tz));
  }
  if (p.r.chance(0.3)) {
    // splice box (CTO) hanging on the telecom strand
    B.add('cto', M.darkMetal, boxGeometry(0.35, 0.25, 0.15), frameMatrix(x + p.tx * 1.2, y + 5.45, z + p.tz * 1.2, p.tx, p.tz));
  }
  if (p.transformer) {
    B.add('trafo', M.metalGrey, new THREE.CylinderGeometry(0.33, 0.33, 1.1, 14), new THREE.Matrix4().makeTranslation(x - nx * 0.45, top - 2.1, z - nz * 0.45));
    for (const o of [-0.15, 0, 0.15]) B.add('insul', M.porcelain, new THREE.CylinderGeometry(0.03, 0.04, 0.2, 6), new THREE.Matrix4().makeTranslation(x - nx * 0.45 + p.tx * o, top - 1.45, z - nz * 0.45 + p.tz * o));
  }
  if (p.light) {
    // bracket arm toward the street
    const ax = nx * -p.side, az = nz * -p.side;
    const arm = new THREE.CylinderGeometry(0.03, 0.03, 2.0, 6).rotateZ(Math.PI / 2 - 0.2);
    B.add('arm', M.metalGrey, arm, frameMatrix(x + ax * 0.95, top - 1.55, z + az * 0.95, ax, az));
  }
  // painted number band on some poles
  if (p.r.chance(0.5)) B.add('poleBand', M.yellow, boxGeometry(0.3, 0.25, 0.2), frameMatrix(x, y + 2.2, z, p.tx, p.tz));
}

function wiresBetween(B, M, a, b, r, wires = 1) {
  const nx = -a.tz, nz = a.tx;
  const ta = a.y + a.h, tb = b.y + b.h;
  // primary
  for (const o of [-0.9, 0, 0.9]) catenary(B, M.wireBright, att(a, a.x + nx * o, ta - 0.2, a.z + nz * o), att(b, b.x + nx * o, tb - 0.2, b.z + nz * o), 0.06 + r.float(0, 0.02), 0.006);
  // secondary (multiplexed bundle)
  for (let i = 0; i < 3; i++) catenary(B, M.wire, att(a, a.x, a.y + 7.2 - i * 0.2, a.z), att(b, b.x, b.y + 7.2 - i * 0.2, b.z), 0.08 + i * 0.01, 0.008);
  // telecom: the infamous tangle
  const n = Math.round(r.int(3, 11) * wires);
  for (let i = 0; i < n; i++) {
    const ya = a.y + 5.6 + r.float(-0.25, 0.15), yb = b.y + 5.6 + r.float(-0.25, 0.15);
    catenary(B, M.wire, att(a, a.x + r.float(-0.12, 0.12), ya, a.z + r.float(-0.12, 0.12)), att(b, b.x + r.float(-0.12, 0.12), yb, b.z + r.float(-0.12, 0.12)), r.float(0.07, 0.16), r.float(0.004, 0.011));
  }
}

function catenary(B, mat, a, b, sagK, radius) {
  // sagK is metres of sag per (10 m of span)^2
  const span = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const lowEnd = Math.min(a[1], b[1]);
  const sag = Math.max(0.05, Math.min(sagK * (span / 10) * (span / 10), 1.6, lowEnd - 4.6 - (Math.max(a[1], b[1]) - lowEnd) * 0.25));
  const pts = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t));
  }
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, radius, 3, false);
  B.add('wire:' + (mat.uuid), mat, g);
}

function cage(B, M, x, y, z, tx, tz, r) {
  const w = r.float(0.8, 1.4), d = 0.5, h = 0.55;
  const bar = 0.012;
  for (let i = 0; i <= 8; i++) {
    const s = -w / 2 + w * i / 8;
    for (const o of [-d / 2, d / 2]) B.add('cage', M.darkMetal, boxGeometry(bar, h, bar), frameMatrix(x + tx * s - tz * o, y + h / 2, z + tz * s + tx * o, tx, tz));
  }
  for (const yy of [0, h]) B.add('cage', M.darkMetal, boxGeometry(w, bar, d), frameMatrix(x, y + yy, z, tx, tz));
  if (r.chance(0.6)) {
    const g = bagGeometry(r, 0.22);
    B.add('bag', M.bag, g, new THREE.Matrix4().makeTranslation(x + tx * 0.2, y + 0.01, z + tz * 0.2));
  }
}

export function buildTree(B, M, ctx, t) {
  const { r, x, z } = t;
  const y = ctx.sidewalkY(x, z);
  const species = r.weighted([['sibipiruna', 3], ['ficus', 2], ['ipe', 1.2], ['young', 1.5], ['murta', 1]]);
  const month = ctx.month ?? 10;
  const H = species === 'young' ? r.float(2.5, 4) : species === 'murta' ? r.float(3, 5) : r.float(5.5, 10);
  const trunkH = species === 'young' ? H * 0.6 : H * r.float(0.35, 0.5);
  const tr = species === 'young' ? 0.05 : r.float(0.12, 0.25);
  const lean = [r.gauss(0, 0.05), r.gauss(0, 0.05)];
  const trunk = new THREE.CylinderGeometry(tr * 0.7, tr, trunkH, 8, 3);
  const uv = trunk.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tr * 6, uv.getY(i) * trunkH);
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(lean[1], 0, -lean[0]));
  m.setPosition(x + lean[0] * trunkH / 2, y + trunkH / 2, z + lean[1] * trunkH / 2);
  B.add('trunk', M.bark, trunk, m);
  // tree pit
  B.add('pit', M.soil, new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2), new THREE.Matrix4().makeTranslation(x, y + 0.01, z));
  const top = new THREE.Vector3(x + lean[0] * trunkH, y + trunkH, z + lean[1] * trunkH);
  // branches
  const nb = species === 'young' ? 0 : r.int(3, 6);
  const tips = [];
  for (let i = 0; i < nb; i++) {
    const a = r.float(0, Math.PI * 2), el = r.float(0.5, 1.1);
    const len = (H - trunkH) * r.float(0.5, 0.8);
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const g = new THREE.CylinderGeometry(tr * 0.25, tr * 0.5, len, 5);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const bm = new THREE.Matrix4().compose(top, q, new THREE.Vector3(1, 1, 1));
    B.add('trunk', M.bark, g, bm);
    tips.push(top.clone().addScaledVector(dir, len));
  }
  // canopy from crossed alpha cards
  const flowering = species === 'ipe' && (month >= 7 && month <= 9);
  const leafTex = species === 'ficus' ? 'foliage_dark' : species === 'sibipiruna' ? 'foliage_small' : flowering ? (r.chance(0.5) ? 'foliage_ipe' : 'foliage_ipe_y') : r.chance(0.5) ? 'foliage_broad' : 'foliage_small';
  const leafMat = ctx.lib.get(leafTex, { side: THREE.DoubleSide, porosity: 0.2, irGain: 3.2, ao: false, dirt: 0 });
  const crownR = species === 'young' ? r.float(0.6, 1.0) : species === 'murta' ? r.float(1.2, 1.8) : (H - trunkH) * r.float(0.55, 0.8);
  const center = top.clone().add(new THREE.Vector3(0, crownR * 0.7, 0));
  // inner volume: a few lumpy blobs in deep green, the shaded inside of the crown
  if (species !== 'young') {
    const coreMat = M.leafCore || (M.leafCore = ctx.lib.plain({ color: '#1a2a12', roughness: 0.95 }, { porosity: 0.2, irGain: 2.6 }));
    const lumps = 3 + Math.floor(crownR * 1.5);
    for (let i = 0; i < lumps; i++) {
      const g = new THREE.IcosahedronGeometry(crownR * r.float(0.15, 0.22), 1);
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        const v = new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k));
        v.multiplyScalar(1 + 0.18 * Math.sin(v.x * 3.1 + i) * Math.cos(v.z * 2.7 - i));
        pos.setXYZ(k, v.x, v.y * 0.8, v.z);
      }
      g.computeVertexNormals();
      const off = new THREE.Vector3(r.float(-0.3, 0.3), r.float(-0.2, 0.2), r.float(-0.3, 0.3)).multiplyScalar(crownR);
      B.add('leafCore', coreMat, g, new THREE.Matrix4().makeTranslation(center.x + off.x, center.y + off.y, center.z + off.z));
    }
  }
  const cards = species === 'young' ? 16 : Math.round(55 + crownR * 25);
  for (let i = 0; i < cards; i++) {
    const u = r.float(-1, 1), th = r.float(0, Math.PI * 2);
    const rr = species === 'young' ? Math.cbrt(r.float(0.15, 1)) : r.float(0.45, 1.0);
    const p = new THREE.Vector3(Math.sqrt(1 - u * u) * Math.cos(th), u * 0.75, Math.sqrt(1 - u * u) * Math.sin(th)).multiplyScalar(crownR * rr).add(center);
    if (tips.length && r.chance(0.4)) p.lerp(r.pick(tips), 0.5);
    const size = r.float(0.9, 1.5) * Math.min(1.4, crownR * 0.7 + 0.45);
    const g = new THREE.PlaneGeometry(size, size);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.float(-0.6, 0.6), r.float(0, Math.PI), r.float(-0.4, 0.4)));
    // normals pointing outward from crown center give plausible lighting on cards
    const mtx = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
    const gg = g.clone().applyMatrix4(mtx);
    const nrm = gg.attributes.normal, pos = gg.attributes.position;
    for (let k = 0; k < nrm.count; k++) {
      const v = new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)).sub(center).normalize();
      nrm.setXYZ(k, v.x, v.y * 0.8 + 0.2, v.z);
    }
    B.add('leaves:' + leafTex, leafMat, gg);
  }
  ctx.treeCanopies = (ctx.treeCanopies || []).concat([{ x, z, y: center.y, r: crownR }]);
}
