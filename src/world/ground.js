// Street surface: carriageway, gutter, curbs with driveway cuts, per-lot sidewalks,
// yards, paint markings, asphalt patches and utility covers.
import * as THREE from 'three';
import { Region, offsetLine, pointAt, polyLength, distPointLine } from '../core/geom.js';
import { polyGeometry, wallStrip, Batcher } from './mesh.js';
import { makeNoise, hashSeed } from '../core/noise.js';
import { buildDrains, planManholes } from './drains.js';

const CURB = 0.15;

export function buildGround(ctx) {
  const { layout, lib, gy, rng, group, focus } = ctx;
  const { regions, lots, roads } = layout;
  const B = new Batcher();
  let tg = performance.now();
  const lap = (l) => { console.log('[sim]   ground.' + l, Math.round(performance.now() - tg), 'ms'); tg = performance.now(); };
  const near = (x, z, r) => Math.hypot(x - focus[0], z - focus[1]) < r * (ctx.detail ?? 1);

  // ---------- driveway ramps (guia rebaixada) ----------
  const ramps = [];
  for (const lot of lots) {
    for (const g of lot.driveways) {
      const sw = lot.sw;
      if (sw < 0.8) continue;
      ramps.push({ x: lot.a[0] + lot.t[0] * g.s, z: lot.a[1] + lot.t[1] * g.s, t: lot.t, n: lot.n, w: g.w, sw });
    }
  }
  const RAMP_CELL = 8, rampCells = new Map();
  const rampKey = (i, j) => i * 100003 + j;
  for (const r of ramps) {
    for (let i = Math.floor((r.x - 8) / RAMP_CELL); i <= Math.floor((r.x + 8) / RAMP_CELL); i++) {
      for (let j = Math.floor((r.z - 8) / RAMP_CELL); j <= Math.floor((r.z + 8) / RAMP_CELL); j++) {
        const k = rampKey(i, j);
        if (!rampCells.has(k)) rampCells.set(k, []);
        rampCells.get(k).push(r);
      }
    }
  }
  const curbTop = (x, z) => {
    let h = CURB;
    const cell = rampCells.get(rampKey(Math.floor(x / RAMP_CELL), Math.floor(z / RAMP_CELL)));
    if (!cell) return h;
    for (const r of cell) {
      const dx = x - r.x, dz = z - r.z;
      if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
      const along = Math.abs(dx * r.t[0] + dz * r.t[1]);
      const off = -(dx * r.n[0] + dz * r.n[1]); // toward the street
      if (along > r.w / 2 + 0.5 || off < r.sw - 0.9) continue;
      const k = smooth(r.sw - 0.9, r.sw - 0.15, off) * (1 - smooth(r.w / 2, r.w / 2 + 0.5, along));
      h = Math.min(h, CURB - 0.11 * k);
    }
    return h;
  };
  // ---------- imperfect surfaces ----------
  // Roads have a crown (camber) and slow undulation; sidewalks are built lot by lot,
  // so they step and tilt, and fall toward the curb.
  const nz = makeNoise(hashSeed(rng.seedStr + '/surface'));
  // nearest road (by distance to its edge) precomputed on a 1 m grid; the surface
  // functions run for every vertex, so a per-call search over all roads is too slow
  const nearestRoadExact = (x, z) => {
    let best = null;
    for (const r of roads) {
      const d = distPointLine(x, z, r.pts).d;
      if (!best || d - r.w / 2 < best.d - best.r.w / 2) best = { d, r };
    }
    return best;
  };
  const RG = layout.R + 4, GN = Math.ceil(RG * 2) + 1;
  const gridD = new Float32Array(GN * GN), gridR = new Int16Array(GN * GN).fill(-1);
  // same answer as nearestRoadExact, but segments are bucketed so each cell only
  // looks at nearby ones, widening the search until nothing farther can win
  const BS = 20, BN = Math.ceil(GN / BS) + 1;
  const buckets = Array.from({ length: BN * BN }, () => []);
  let maxHalf = 0;
  roads.forEach((r, ri) => {
    maxHalf = Math.max(maxHalf, r.w / 2);
    for (let s = 0; s < r.pts.length - 1; s++) {
      const a = r.pts[s], b = r.pts[s + 1];
      const i0 = Math.floor((Math.min(a[0], b[0]) + RG) / BS), i1 = Math.floor((Math.max(a[0], b[0]) + RG) / BS);
      const j0 = Math.floor((Math.min(a[1], b[1]) + RG) / BS), j1 = Math.floor((Math.max(a[1], b[1]) + RG) / BS);
      for (let j = Math.max(0, j0); j <= Math.min(BN - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(BN - 1, i1); i++) buckets[j * BN + i].push([ri, a, b]);
    }
  });
  const segDist = (x, z, a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
  };
  for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
    const x = i - RG, z = j - RG, bi = Math.floor(i / BS), bj = Math.floor(j / BS);
    let bestV = Infinity, bestD = 0, bestR = -1;
    for (let ring = 0; ring < BN; ring++) {
      // everything in this ring is at least (ring - 1) * BS away
      if (bestR >= 0 && (ring - 1) * BS - maxHalf > bestV) break;
      for (let jj = bj - ring; jj <= bj + ring; jj++) for (let ii = bi - ring; ii <= bi + ring; ii++) {
        if (Math.max(Math.abs(ii - bi), Math.abs(jj - bj)) !== ring || ii < 0 || jj < 0 || ii >= BN || jj >= BN) continue;
        for (const [ri, a, b] of buckets[jj * BN + ii]) {
          const d = segDist(x, z, a, b), v = d - roads[ri].w / 2;
          if (v < bestV) { bestV = v; bestD = d; bestR = ri; }
        }
      }
    }
    if (bestR >= 0) { gridD[j * GN + i] = bestD; gridR[j * GN + i] = bestR; }
  }
  const nearestRoad = (x, z) => {
    const u = Math.max(0, Math.min(GN - 1.001, x + RG)), v = Math.max(0, Math.min(GN - 1.001, z + RG));
    const i = Math.floor(u), j = Math.floor(v), a = u - i, c = v - j;
    const k = j * GN + i;
    const ri = gridR[Math.round(v) * GN + Math.round(u)];
    if (ri < 0) return null;
    const d = (gridD[k] * (1 - a) + gridD[k + 1] * a) * (1 - c) + (gridD[k + GN] * (1 - a) + gridD[k + GN + 1] * a) * c;
    return { d, r: roads[ri] };
  };
  ctx.roadY = (x, z) => {
    const nr = nearestRoad(x, z);
    let y = 0;
    if (nr) {
      const half = nr.r.w / 2;
      const k = Math.min(1, nr.d / half);
      y += Math.max(0, 1 - k * k) * half * 0.02; // ~2% cross slope
    }
    y += nz.fbm(x * 0.06, z * 0.06, 3) * 0.035 + nz.fbm(x * 0.35 + 50, z * 0.35, 2) * 0.008;
    return y;
  };
  ctx.roadSurf = (x, z) => gy(x, z) + ctx.roadY(x, z);
  const terrace = (v) => { const f = Math.floor(v); return f + smooth(0.8, 1, v - f); };
  ctx.swOffset = (x, z) => {
    // owners each pour their own stretch: terraced steps of a few cm, slight waviness
    let y = terrace(nz.noise(x * 0.11 + 13, z * 0.11 - 7) * 2.2) * 0.03;
    y += nz.fbm(x * 0.5 - 31, z * 0.5, 2) * 0.008;
    const nr = nearestRoad(x, z);
    if (nr) y += Math.max(0, nr.d - nr.r.w / 2) * 0.018; // fall toward the curb
    return y;
  };
  ctx.sidewalkY = (x, z) => gy(x, z) + curbTop(x, z) + ctx.swOffset(x, z);
  ctx.ramps = ramps;

  lap('setup');
  // ---------- carriageway ----------
  const roadMats = {};
  const asphaltFor = (x, z) => {
    let best = null, bd = 1e9;
    for (const r of roads) { const d = distPointLine(x, z, r.pts).d - r.w / 2; if (d < bd) { bd = d; best = r; } }
    return best ? best.asphalt : 'asphalt_old';
  };
  // split the carriageway by dominant asphalt type of the nearest road (Voronoi-ish via road buffers)
  const types = [...new Set(roads.map(r => r.asphalt))];
  let remaining = regions.carr;
  for (const type of types) {
    const rs = roads.filter(r => r.asphalt === type);
    const zone = Region.fromLines(rs.map(r => ({ pts: r.pts, half: r.w / 2 + 2 })), 0);
    const piece = remaining.and(zone);
    remaining = remaining.minus(zone);
    roadMats[type] = piece;
  }
  if (!remaining.isEmpty()) roadMats.asphalt_old = (roadMats.asphalt_old || new Region()).union(remaining);
  // holes for manhole covers and their patched rings
  ctx.manholes = planManholes(ctx);
  if (ctx.manholes.length) {
    const holes = Region.fromRings(ctx.manholes.map(mh => Array.from({ length: 32 }, (_, i) => [mh.x + Math.cos(i / 32 * Math.PI * 2) * mh.rr, mh.z + Math.sin(i / 32 * Math.PI * 2) * mh.rr])));
    for (const k of Object.keys(roadMats)) roadMats[k] = roadMats[k].minus(holes);
  }
  for (const [type, reg] of Object.entries(roadMats)) {
    const geo = polyGeometry(reg.expolys(), { yFn: ctx.roadSurf, uvFn: (x, z) => [x, z], maxEdge: 1.6 });
    B.add('road:' + type, lib.get(lib.variant(type, rng), { macro: 0.35, porosity: 0.7, puddles: true }), geo);
  }

  // gutter (sarjeta): darker concrete strip next to the curb
  const gutterGeo = polyGeometry(regions.gutter.expolys(), { yFn: (x, z) => ctx.roadSurf(x, z) + 0.004, uvFn: (x, z) => [x, z], maxEdge: 1.0 });
  B.add('gutter', lib.get('concrete_plain', { tint: '#9a968e', macro: 0.4, porosity: 0.8, puddles: true }), gutterGeo);

  lap('carriageway');
  // ---------- curbs ----------
  const curbMat = {
    // double-sided: the ring orientation test can flip a strip; a culled curb shows the sky through it
    none: lib.get('concrete_old', { tint: '#c9c5bb', macro: 0.3, grime: 0.6, side: THREE.DoubleSide }),
    white: lib.get('concrete_plain', { tint: '#e8e6df', macro: 0.25, grime: 0.9, side: THREE.DoubleSide }),
    yellow: lib.get('concrete_plain', { tint: '#d4a91e', macro: 0.25, grime: 0.8, side: THREE.DoubleSide }),
  };
  const sideReg = regions.sidewalk;
  for (const ring of regions.carr.rings()) {
    // walk the ring, emit strips only where a sidewalk is beside it
    const closed = ring.concat([ring[0]]);
    let run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const mid = run[Math.floor(run.length / 2)];
      const lot = nearestLot(lots, mid[0], mid[1]);
      const paint = lot ? lot.curbPaint : 'none';
      // which side faces the road?
      const a = run[0], b = run[1];
      const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
      const rx = -tz / l, rz = tx / l;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const roadRight = regions.carr.contains(mx + rx * 0.2, mz + rz * 0.2);
      const geo = curbGeometry(run, roadRight ? 1 : -1, ctx, gy);
      B.add('curb:' + paint, curbMat[paint], geo);
      run = [];
    };
    // densify first, then test each sample on both sides of the edge: testing only
    // the ring vertices dropped whole straight stretches when one vertex failed
    const dense = [];
    for (let i = 0; i < closed.length - 1; i++) {
      const p = closed[i], q = closed[i + 1];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.max(1, Math.ceil(L / 0.4));
      for (let k = 0; k < n; k++) dense.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n, (q[0] - p[0]) / (L || 1), (q[1] - p[1]) / (L || 1)]);
    }
    if (dense.length) dense.push(dense[0]);
    for (const [px, pz, dx, dz] of dense) {
      const nx = -dz, nz = dx;
      const onSidewalk = sideReg.contains(px + nx * 0.12, pz + nz * 0.12) || sideReg.contains(px - nx * 0.12, pz - nz * 0.12);
      if (onSidewalk && near(px, pz, 150)) run.push([px, pz]);
      else flush();
    }
    flush();
  }

  lap('curbs');
  // ---------- sidewalks, one piece per lot ----------
  // the sidewalk is cut into 40 m tiles so each lot clips against a small region
  // (same pieces as clipping the whole sidewalk, much cheaper)
  const TS = 40;
  const swTiles = new Map();
  const tileOf = (i, j) => {
    const k = i + ',' + j;
    if (!swTiles.has(k)) swTiles.set(k, regions.sidewalk.and(Region.rect(i * TS, j * TS, (i + 1) * TS, (j + 1) * TS)));
    return k;
  };
  const swMats = new Map();
  const swMat = (name, tint) => {
    const key = name + tint;
    if (!swMats.has(key)) {
      let tex = name;
      if (name === 'petitpave') tex = 'petitpave_' + rng.weighted([[0, 6], [1, 1], [2, 1], [3, 1]]);
      if (name === 'grass_strip') tex = 'concrete';
      swMats.set(key, lib.get(lib.variant(tex, rng), { macro: 0.3, porosity: 0.6, puddles: true, tint: tint }));
    }
    return swMats.get(key);
  };
  for (const lot of lots) {
    if (!near(lot.c[0], lot.c[1], 140)) continue;
    const sw = lot.sw + 0.6;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const ext = 0.02;
    const quad = [
      [lot.a[0] - tx * ext + nx * 0.3, lot.a[1] - tz * ext + nz * 0.3],
      [lot.b[0] + tx * ext + nx * 0.3, lot.b[1] + tz * ext + nz * 0.3],
      [lot.b[0] + tx * ext - nx * sw, lot.b[1] + tz * ext - nz * sw],
      [lot.a[0] - tx * ext - nx * sw, lot.a[1] - tz * ext - nz * sw],
    ];
    const qr = Region.fromRings([quad]);
    let piece = new Region();
    const xs = quad.map(p => p[0]), zs = quad.map(p => p[1]);
    for (let i = Math.floor(Math.min(...xs) / TS); i <= Math.floor(Math.max(...xs) / TS); i++) {
      for (let j = Math.floor(Math.min(...zs) / TS); j <= Math.floor(Math.max(...zs) / TS); j++) {
        const k = tileOf(i, j);
        const t = swTiles.get(k);
        if (t.isEmpty()) continue;
        piece = piece.union(t.and(qr));
        swTiles.set(k, t.minus(qr));
      }
    }
    if (piece.isEmpty()) continue;
    const ox = lot.a[0], oz = lot.a[1];
    const uvFn = (x, z) => [(x - ox) * tx + (z - oz) * tz, (x - ox) * nx + (z - oz) * nz];
    const shade = 1 + lot.sidewalkTint;
    const tint = '#' + new THREE.Color(shade, shade, shade * 0.98).getHexString();
    if (lot.sidewalkMat === 'grass_strip') {
      // concrete walking strip along the lot, grass between it and the curb
      const roadSw = lot.sw;
      const strip = Math.min(1.3, roadSw * 0.55);
      lot.grassEdge = { from: strip, to: roadSw };
      const walkQuad = Region.fromRings([[quad[0], quad[1], [lot.b[0] - nx * strip, lot.b[1] - nz * strip], [lot.a[0] - nx * strip, lot.a[1] - nz * strip]]]);
      const walk = piece.and(walkQuad), grass = piece.minus(walkQuad);
      B.add('sw:concrete' + tint, swMat('concrete', tint), polyGeometry(walk.expolys(), { yFn: ctx.sidewalkY, uvFn, maxEdge: 0.7 }));
      B.add('sw:grass', lib.get(rng.chance(0.5) ? 'grass' : 'grass_dry', { macro: 0.4, porosity: 0.3 }), polyGeometry(grass.expolys(), { yFn: (x, z) => ctx.sidewalkY(x, z) + 0.01, uvFn, maxEdge: 0.7 }));
    } else {
      B.add('sw:' + lot.sidewalkMat + tint, swMat(lot.sidewalkMat, tint), polyGeometry(piece.expolys(), { yFn: ctx.sidewalkY, uvFn, maxEdge: 0.7 }));
    }
  }
  // leftovers: tiles never touched by a lot, plus what remains of touched ones
  const R0 = layout.R;
  for (let i = Math.floor(-R0 / TS); i <= Math.floor(R0 / TS); i++) for (let j = Math.floor(-R0 / TS); j <= Math.floor(R0 / TS); j++) tileOf(i, j);
  let swRemaining = new Region();
  for (const t of swTiles.values()) if (!t.isEmpty()) swRemaining.paths.push(...t.paths);
  if (!swRemaining.isEmpty()) {
    B.add('sw:rest', lib.get('concrete_old', { macro: 0.3, porosity: 0.6, puddles: true }), polyGeometry(swRemaining.expolys(), { yFn: ctx.sidewalkY, uvFn: (x, z) => [x, z], maxEdge: 1.2 }));
  }

  lap('sidewalks');
  // ---------- block interiors (yards behind walls) ----------
  const yardGeo = polyGeometry(regions.blocks.expolys(), { yFn: (x, z) => gy(x, z) + CURB + 0.02, uvFn: (x, z) => [x, z], maxEdge: 3 });
  B.add('yard', lib.get('concrete_plain', { macro: 0.5, tint: '#b8b3a8', porosity: 0.5, puddles: true }), yardGeo);
  // front yards with their own floor
  for (const lot of lots) {
    if (!lot.building || !lot.setback || lot.setback < 1.2 || !near(lot.c[0], lot.c[1], 110)) continue;
    const r = lot.rng.fork('yard');
    const kind = r.weighted([['ceramic_red', 3], ['concrete_plain', 3], ['grass', 1.5], ['paver', 1.5], ['ladrilho', 0.6], ['stone_slab', 0.8], ['soil', 0.5]]);
    lot.yardKind = kind;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const d = lot.setback;
    const quad = [
      [lot.a[0] + nx * 0.1, lot.a[1] + nz * 0.1], [lot.b[0] + nx * 0.1, lot.b[1] + nz * 0.1],
      [lot.b[0] + nx * d, lot.b[1] + nz * d], [lot.a[0] + nx * d, lot.a[1] + nz * d],
    ];
    const reg = Region.fromRings([quad]).and(regions.blocks);
    const ox = lot.a[0], oz = lot.a[1];
    B.add('fy:' + kind, lib.get(kind, { macro: 0.3, porosity: 0.5, puddles: true }), polyGeometry(reg.expolys(), {
      yFn: (x, z) => gy(x, z) + CURB + 0.035, uvFn: (x, z) => [(x - ox) * tx + (z - oz) * tz, (x - ox) * nx + (z - oz) * nz], maxEdge: 1.5,
    }));
  }

  lap('yards');
  // ---------- asphalt patches and trench scars ----------
  const patchMat = lib.get('asphalt_patch', { macro: 0.3, porosity: 0.7, puddles: true });
  patchMat.polygonOffset = true; patchMat.polygonOffsetFactor = -2; patchMat.polygonOffsetUnits = -2;
  // a newer, still-black patch and an older one already greying like the road
  const patchMat2 = lib.get('asphalt_patchy', { macro: 0.5, porosity: 0.7, puddles: true, tint: '#9a9a9a' });
  patchMat2.polygonOffset = true; patchMat2.polygonOffsetFactor = -2; patchMat2.polygonOffsetUnits = -2;
  const seamMat = lib.plain({ color: '#0a0a0a', roughness: 0.35, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }, { porosity: 0.1, paintWear: 0.25, spec: 1.2 });
  seamMat.userData.noShadow = true;
  for (const road of roads) {
    const L = road.len;
    const pr = rng.fork('patch' + road.pts[0].join());
    const density = road.asphalt === 'asphalt_patchy' ? 0.12 : road.asphalt === 'asphalt_old' ? 0.07 : 0.02;
    const n = Math.floor(L * density * pr.float(0.5, 1.5) * ctx.cfg.roads.patches);
    for (let i = 0; i < n; i++) {
      const s = pr.float(0, L);
      const q = pointAt(road.pts, s);
      if (!near(q.x, q.z, 110)) continue;
      const trench = pr.chance(0.18);
      const len = trench ? pr.float(6, 25) : pr.float(0.8, 4.5);
      const wid = trench ? pr.float(0.5, 0.9) : pr.float(0.6, 3);
      const off = pr.float(-road.w / 2 + wid / 2, road.w / 2 - wid / 2) * (trench ? 1 : 0.9);
      const ang = trench ? 0 : pr.gauss(0, 0.06);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const tx = q.dx * ca - q.dz * sa, tz = q.dx * sa + q.dz * ca;
      const nx = -tz, nz = tx;
      const cx = q.x + nx * off, cz = q.z + nz * off;
      // cut lines are never straight: subdivide each edge and jitter it
      const corners = [[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2]];
      const ring = [];
      for (let c = 0; c < 4; c++) {
        const [a0, b0] = corners[c], [a1, b1] = corners[(c + 1) % 4];
        const segs = Math.max(2, Math.round(Math.hypot(a1 - a0, b1 - b0) / 0.35));
        for (let k = 0; k < segs; k++) {
          const t = k / segs;
          const a = a0 + (a1 - a0) * t + pr.gauss(0, 0.04), b = b0 + (b1 - b0) * t + pr.gauss(0, 0.04);
          ring.push([cx + tx * a + nx * b, cz + tz * a + nz * b]);
        }
      }
      const reg = Region.fromRings([ring]).and(regions.carr);
      const raise = pr.float(-0.004, 0.012);
      const mat = pr.chance(0.5) ? patchMat : patchMat2;
      B.add('patch' + mat.uuid, mat, polyGeometry(reg.expolys(), { yFn: (x, z) => ctx.roadSurf(x, z) + 0.006 + raise, uvFn: (x, z) => [x + i * 3.1, z], maxEdge: 1.0 }));
      // tar sealant spilled along the cut
      const seam = Region.fromRings([ring]).offset(pr.float(0.04, 0.09)).minus(Region.fromRings([ring]).offset(-0.03)).and(regions.carr);
      B.add('patchSeam', seamMat, polyGeometry(seam.expolys(), { yFn: (x, z) => ctx.roadSurf(x, z) + 0.007 + Math.max(0, raise), uvFn: (x, z) => [x, z], maxEdge: 0.5 }));
    }
  }

  lap('patches');
  // ---------- markings ----------
  buildMarkings(ctx, B, near);

  lap('markings');
  // ---------- manholes, curb inlets, sidewalk boxes ----------
  buildDrains(ctx, B);

  lap('drains');
  const meshes = B.build(group, { castShadow: false });
  lap('merge');
  for (const m of meshes) m.receiveShadow = true;
  for (const m of meshes) if (m.name.startsWith('curb')) m.castShadow = true;
  return meshes;
}

function buildMarkings(ctx, B, near) {
  const { layout, lib, gy, rng } = ctx;
  const { roads } = layout;
  const paintMat = (color, wear) => {
    const m = lib.plain({ color, roughness: 0.55, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }, { porosity: 0.15, paintWear: wear });
    m.userData.noShadow = true;
    return m;
  };
  const ribbon = (pts, half, y = 0.008) => {
    const pos = [], uv = [];
    const L = polyLength(pts);
    const n = Math.max(1, Math.ceil(L / 0.8));
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const q = pointAt(pts, L * i / n);
      const nx = -q.dz, nz = q.dx;
      const a = [q.x + nx * half, q.z + nz * half], b = [q.x - nx * half, q.z - nz * half];
      if (prev) {
        const [pa, pb] = prev;
        for (const v of [pa, b, pb, pa, a, b]) { pos.push(v[0], ctx.roadSurf(v[0], v[1]) + y, v[1]); uv.push(v[0], v[1]); }
      }
      prev = [a, b];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    // ensure normals point up
    const nrm = g.attributes.normal;
    for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) < 0) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    return g;
  };
  const dashes = (pts, on, off, half, key, mat) => {
    const L = polyLength(pts);
    for (let s = on * 0.3; s < L - on; s += on + off) {
      const a = pointAt(pts, s), b = pointAt(pts, s + on);
      if (!near(a.x, a.z, 120)) continue;
      B.add(key, mat, ribbon([[a.x, a.z], [b.x, b.z]], half));
    }
  };

  for (const road of roads) {
    if (!road.pts.some(p => near(p[0], p[1], 130))) continue;
    const wear = road.paintWear;
    const yellow = paintMat('#c19431', wear);
    const white = paintMat('#c6c3ba', wear);
    if (road.centerLine === 'double_yellow') {
      B.add('mk:y:' + wear, yellow, ribbon(offsetLine(road.pts, 0.09), 0.05));
      B.add('mk:y:' + wear, yellow, ribbon(offsetLine(road.pts, -0.09), 0.05));
    } else if (road.centerLine === 'dashed_yellow') {
      dashes(road.pts, 3, 6, 0.05, 'mk:y:' + wear, yellow);
    }
    // crosswalks + stop lines at ends that meet another road
    for (const end of [0, 1]) {
      const pts = end === 0 ? road.pts : road.pts.slice().reverse();
      const p0 = pts[0];
      const meets = roads.some(o => o !== road && o.pts.some(p => Math.hypot(p[0] - p0[0], p[1] - p0[1]) < 1));
      if (!meets || !near(p0[0], p0[1], 110)) continue;
      const cr = rng.fork('xw' + p0.join());
      const other = roads.filter(o => o !== road && o.pts.some(p => Math.hypot(p[0] - p0[0], p[1] - p0[1]) < 1));
      const crossW = Math.max(...other.map(o => o.w / 2 + o.sw));
      if (polyLength(road.pts) < crossW + 8) continue;
      const hasZebra = cr.chance(Math.min(1, (road.cls === 'street' ? 0.35 : 0.75) * ctx.cfg.roads.crosswalks));
      const start = crossW + cr.float(0.8, 2.0);
      if (hasZebra) {
        const q = pointAt(pts, start + 1.75);
        const len = cr.float(3, 4);
        const stripeW = 0.4, gap = cr.float(0.4, 0.6);
        for (let o = -road.w / 2 + 0.5; o < road.w / 2 - 0.4; o += stripeW + gap) {
          const cx = q.x - q.dz * (o + stripeW / 2), cz = q.z + q.dx * (o + stripeW / 2);
          B.add('mk:w:' + wear, white, ribbon([[cx - q.dx * len / 2, cz - q.dz * len / 2], [cx + q.dx * len / 2, cz + q.dz * len / 2]], stripeW / 2));
        }
      }
      if (cr.chance(0.6) && !road.oneway) {
        // stop line on the incoming half
        const q = pointAt(pts, start + (hasZebra ? 4.5 : 0.5));
        const a = [q.x, q.z], b = [q.x + q.dz * road.w / 2 * 0.95, q.z - q.dx * road.w / 2 * 0.95];
        B.add('mk:w:' + wear, white, ribbon([a, b], 0.2));
      }
    }
    // speed bump (lombada) occasionally
    const br = rng.fork('bump' + road.pts[0].join());
    if (road.cls === 'street' && br.chance(Math.min(1, 0.3 * ctx.cfg.roads.bumps)) && road.len > 40) {
      const q = pointAt(road.pts, br.float(15, road.len - 15));
      if (near(q.x, q.z, 100)) ctx.bumps = (ctx.bumps || []).concat([{ q, road }]);
    }
  }
}

function nearestLot(lots, x, z) {
  let best = null, bd = 6;
  for (const l of lots) {
    const d = Math.hypot(l.c[0] - x, l.c[1] - z) - l.len / 2;
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

// Curb profile along a run: face from below the road up to a rounded nose that
// meets the sidewalk ~6 cm back. side: +1 if the road is on the right of travel.
function curbGeometry(run, side, ctx, gy) {
  // profile (offset toward the sidewalk, height below the sidewalk top)
  const prof = [[0, null], [0, 0.045], [0.006, 0.022], [0.018, 0.008], [0.035, 0.002], [0.06, 0]];
  const rows = [];
  let s = 0;
  for (let i = 0; i < run.length; i++) {
    const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    // toward the sidewalk = away from the road
    const nx = tz * side, nz = -tx * side;
    if (i > 0) s += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
    const [x, z] = run[i];
    const top = ctx.sidewalkY(x + nx * 0.06, z + nz * 0.06);
    const bot = Math.min(ctx.roadSurf(x, z), gy(x, z)) - 0.15;
    rows.push(prof.map(([o, d], k) => {
      const y = d === null ? bot : top - d;
      return [x + nx * o, y, z + nz * o, s, k === 0 ? 0 : (top - bot) - d + (k > 1 ? o : 0)];
    }));
  }
  const pos = [], uv = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let k = 0; k < prof.length - 1; k++) {
      const A = rows[i][k], Bv = rows[i][k + 1], C = rows[i + 1][k], D = rows[i + 1][k + 1];
      const tri = side > 0 ? [A, C, Bv, Bv, C, D] : [A, Bv, C, Bv, D, C];
      for (const v of tri) { pos.push(v[0], v[1], v[2]); uv.push(v[3], v[4]); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
