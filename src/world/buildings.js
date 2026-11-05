// Buildings: extruded footprints with facade materials, windows, doors, roofs,
// water tanks, AC units, and the street frontage of shops and flush houses.
import * as THREE from 'three';
import { centroid, pointInRing, Region } from '../core/geom.js';
import { polyGeometry, wallStrip, boxGeometry, frameMatrix, Batcher, crookMatrix } from './mesh.js';
import { shopSign, houseNumber, tagTexture } from './signs.js';
import { makeNoise, hashSeed } from '../core/noise.js';
import { pickFeatures, buildFacadeFeatures, garageCover, roofExtras } from './houseparts.js';
import { wallColor } from '../map/layout.js';

export function buildBuildings(ctx) {
  const { layout, lib, gy, group, focus, rng } = ctx;
  const B = new Batcher();
  const near = (x, z, r) => Math.hypot(x - focus[0], z - focus[1]) < r * (ctx.detail ?? 1);
  const M = materials(ctx);

  // which lots each building sits on
  const lotOf = new Map();
  for (const lot of layout.lots) if (lot.building) lotOf.set(lot.building, lot);
  // which lots are fronted directly by each building
  for (const lot of layout.lots) {
    if (lot.building && (lot.use === 'shop' || lot.use === 'house_flush')) (lot.building.flushLots ||= []).push(lot);
  }

  for (const b of layout.buildings) {
    const ring = b.outer;
    const c = centroid(ring);
    if (!near(c[0], c[1], 165)) continue;
    const detail = near(c[0], c[1], 120);
    const r = b.rng;
    let minG = Infinity, maxG = -Infinity;
    for (const p of ring) { const h = gy(p[0], p[1]); minG = Math.min(minG, h); maxG = Math.max(maxG, h); }
    const groundRef = gy(c[0], c[1]) + 0.17;
    const base = minG - 0.4;
    const top = groundRef + b.h;
    // nothing is plumb: the whole building leans a little and its walls bow and ripple
    const d2r = Math.PI / 180;
    const leanX = Math.tan(r.gauss(0, b.mapped ? 0.25 : 0.35) * d2r), leanZ = Math.tan(r.gauss(0, b.mapped ? 0.25 : 0.35) * d2r);
    const bow = r.float(0.006, b.facade === 'plaster' ? 0.022 : 0.012);
    const bn = makeNoise(hashSeed(String(b.id) + ':' + c[0].toFixed(1)));
    b.warp = (x, y, z) => {
      const hgt = Math.max(0, y - groundRef);
      const w = bn.fbm((x + z) * 0.35, y * 0.35, 2) * bow;
      return [leanX * hgt + w * 0.7, leanZ * hgt + w * 0.7];
    };
    b.shift = (x, y, z) => b.warp(x, y, z);
    b.groundRef = groundRef; b.top = top;
    const facadeTex = lib.variant({ plaster: r.pick(['plaster_stucco', 'plaster_grafiato', 'plaster_smooth']), brick: 'brick', stone: r.pick(['stone_slab', 'canjiquinha']), pastilha: r.pick(['pastilha_blue', 'pastilha_beige', 'pastilha_brown', 'pastilha_green', 'pastilha_white', 'pastilha_grey']), concrete: 'concrete_raw', block_raw: 'block_raw', brick_raw: 'brick_raw' }[b.facade], r);
    const tintable = b.facade === 'plaster';
    const facadeMat = lib.get(facadeTex, { tint: tintable ? b.color : undefined, grime: b.facade === 'pastilha' ? 0.4 : 1.2, porosity: 0.5, spall: tintable ? 1 : 0 });

    // roof shape
    const obb = orientedBox(ring);
    const rect = Math.abs(b.area) / (obb.hu * obb.hv * 4);
    const pitched = b.roof !== 'flat' && rect > 0.82 && b.floors <= 3 && Math.min(obb.hu, obb.hv) < 9;
    const parapet = pitched ? 0 : r.float(0.4, 1.1);
    b.pitched = pitched;

    // ---------- walls ----------
    let perim = 0;
    const edges = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], q = ring[(i + 1) % ring.length];
      const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      if (len < 0.05) continue;
      const tx = (q[0] - a[0]) / len, tz = (q[1] - a[1]) / len;
      const mx = (a[0] + q[0]) / 2, mz = (a[1] + q[1]) / 2;
      const rightInside = pointInRing(mx - tz * 0.05, mz + tx * 0.05, ring);
      const side = rightInside ? -1 : 1;
      const ox = -tz * side, oz = tx * side; // outward normal
      B.add('facade:' + b.id, facadeMat, wallStrip([a, q], { bottom: () => base, top: () => top + parapet, side, step: detail ? 1.5 : 50, rowStep: detail ? 1.5 : 0, uOffset: perim, vRef: () => groundRef, warp: b.warp }));
      if (parapet > 0) {
        B.add('parapetIn', M.renderGrey, wallStrip([a, q], { bottom: () => top, top: () => top + parapet, side: -side, step: detail ? 1.5 : 50, uOffset: perim, vRef: () => top, warp: b.warp }));
      }
      edges.push({ a, q, len, tx, tz, ox, oz, mx, mz, s0: perim, side });
      perim += len;
    }
    // parapet cap and roof slab
    if (!pitched) {
      const [sx, sz] = b.warp(c[0], top, c[1]);
      const slab = polyGeometry([{ outer: ring, holes: [] }], { yFn: () => top, uvFn: (x, z) => [x, z], maxEdge: 50 });
      slab.translate(sx, 0, sz);
      B.add('roofslab', M.roofSlab, slab);
      if (parapet > 0) {
        const capReg = Region.fromRings([ring]).minus(Region.fromRings([ring]).offset(-0.15));
        B.add('cap', M.cap, polyGeometry(capReg.expolys(), { yFn: () => top + parapet + 0.01, uvFn: (x, z) => [x, z], maxEdge: 50 }).translate(sx, 0, sz));
      }
      if (b.waterTank && detail) waterTank(B, M, c, top, ring, r);
    } else {
      buildPitchedRoof(B, M, b, obb, top, facadeMat, r);
      if (b.waterTank && detail && r.chance(0.5)) {
        // small masonry box on the roof holding the tank (castelinho)
        const [cx, cz] = [c[0] + r.float(-1, 1), c[1] + r.float(-1, 1)];
        B.add('castelo', facadeMat, boxGeometry(1.8, 1.6, 1.8), frameMatrix(cx, top + 0.6, cz, obb.ux, obb.uz));
        B.add('roofslab', M.roofSlab, boxGeometry(2.0, 0.08, 2.0), frameMatrix(cx, top + 1.44, cz, obb.ux, obb.uz));
      }
    }

    if (!detail) continue;

    // ---------- facade variety ----------
    const feat = pickFeatures(b, r, ctx.city);
    b.feat = feat;
    const fr = r.fork('features');
    const info = { groundRef, top, parapet, accent: wallColor(fr), accent2: wallColor(fr) };
    const streetEdges = edges.filter(e => e.len > 2.5 && [3, 8, 15].some(k => layout.regions.outer.contains(e.mx + e.ox * k, e.mz + e.oz * k)));
    if (b.floors <= 4) for (const e of streetEdges.slice(0, 2)) buildFacadeFeatures(B, M, ctx, b, e, feat, fr, { ...info, side: e.side });
    if (b.floors <= 4) roofExtras(B, M, ctx, b, feat, c, top, fr);
    const myLot = lotOf.get(b);
    if (feat.garageCover && myLot) garageCover(B, M, ctx, myLot, feat, fr);

    // ---------- windows ----------
    const streetSide = (e) => {
      for (const k of [3, 8, 15]) if (layout.regions.outer.contains(e.mx + e.ox * k, e.mz + e.oz * k)) return true;
      return false;
    };
    const flushFront = (e) => (b.flushLots || []).some(l => {
      const dx = e.mx - l.a[0], dz = e.mz - l.a[1];
      const along = dx * l.t[0] + dz * l.t[1], off = dx * l.n[0] + dz * l.n[1];
      return along > -1 && along < l.len + 1 && off < (l.setback || 0) + 1.5 && e.ox * l.n[0] + e.oz * l.n[1] < -0.7;
    });
    const winStyle = {
      frame: r.pick(['#c2c5c7', '#ecebe6', '#3a2a1f', '#1f1f1f', '#8a8d8f']),
      grille: r.chance(Math.min(1, (b.floors <= 2 ? 0.7 : 0.3) * ctx.cfg.buildings.windowGrille)),
      grilleColor: r.pick(['#1d1e1f', '#ecebe6', '#2f2f30', '#4a3a2c']),
      w: b.floors >= 4 ? r.float(1.2, 2.0) : r.float(1.0, 1.6),
      h: r.float(1.0, 1.3),
      spacing: b.floors >= 4 ? r.float(2.6, 3.6) : r.float(2.8, 4.5),
      type: b.floors >= 5 ? 'sliding' : feat.window,
      shutterColor: r.pick(['#5a3b28', '#2f4a36', '#ecebe6', '#7b2b25', '#3a4a5c']),
    };
    for (const e of edges) {
      const street = streetSide(e);
      if (e.len < 1.5) continue;
      if (!street && !r.chance(0.35)) continue;
      const front = flushFront(e);
      const tt = [e.ox, e.oz]; // frame z must be outward: X such that X x Y = outward
      const fx = e.oz, fz = -e.ox; // X = (oz, -ox) gives Z = (-fz, fx)?? verified below
      const n = Math.max(1, Math.floor((e.len - 0.8) / winStyle.spacing));
      for (let f = 0; f < b.floors; f++) {
        if (f === 0 && front) continue;
        for (let k = 0; k < n; k++) {
          if (!street && r.chance(0.5)) continue;
          const s = (k + 0.5) * e.len / n;
          const x = e.a[0] + e.tx * s + e.ox * 0.0, z = e.a[1] + e.tz * s + e.oz * 0.0;
          const y = groundRef + f * b.floorH + 1.05;
          if (y + winStyle.h > top - 0.2) continue;
          const [wx, wz] = b.warp(x, y + winStyle.h / 2, z);
          addWindow(B, M, ctx, { x: x + wx, y, z: z + wz, ox: e.ox, oz: e.oz, w: Math.min(winStyle.w, e.len / n - 0.5), h: winStyle.h, style: winStyle, ground: f === 0, r, b });
        }
      }
      // front door for houses set back from the street
      if (street && !front && b.floors <= 3 && e.len > 3 && r.chance(0.6) && !b.doorDone) {
        b.doorDone = true;
        const s = r.float(0.8, e.len - 0.8);
        const x = e.a[0] + e.tx * s, z = e.a[1] + e.tz * s;
        const [dx, dz] = b.warp(x, groundRef + 1.05, z);
        const m = outwardFrame(x + dx, groundRef + 1.05, z + dz, e.ox, e.oz, 0.03);
        B.add('door', M.wood, boxGeometry(0.9, 2.1, 0.05), m);
      }
    }
  }

  // ---------- frontage of shops and flush houses ----------
  for (const lot of layout.lots) {
    if (!lot.building || !(lot.use === 'shop' || lot.use === 'house_flush')) continue;
    if (!near(lot.c[0], lot.c[1], 120)) continue;
    lotFacade(B, M, ctx, lot);
  }

  // pichacao on walls and facades near the camera
  tags(ctx, group);

  return B.build(group);
}

function materials(ctx) {
  const { lib } = ctx;
  const glass = lib.plain({ physical: true, color: '#0b0e10', roughness: 0.06, metalness: 0.0, envMapIntensity: 1.3, ior: 1.5 }, { porosity: 0, irGain: 0.3, dirt: 0 });
  const glassLit = lib.plain({ color: '#2b261c', emissive: '#ffcf8e', emissiveIntensity: 0, roughness: 0.1 }, { porosity: 0 });
  ctx.nightEmissive.push({ mat: glassLit, base: 0.35 });
  return {
    glass, glassLit,
    renderGrey: lib.get('plaster_smooth', { tint: '#a29d94', grime: 1.2 }),
    roofSlab: lib.get('concrete_old', { tint: '#7e7a72', macro: 0.5, porosity: 0.7, puddles: true }),
    cap: lib.get('concrete_plain', { tint: '#cfcac0', grime: 0.3 }),
    wood: lib.get('wood', { grime: 0.3 }),
    roofCeramicV: (r) => lib.get(lib.variant('roof_ceramic', r), { porosity: 0.6, side: THREE.DoubleSide }),
    fibroV: (r) => lib.get(lib.variant('fibro', r), { porosity: 0.5, side: THREE.DoubleSide }),
    roofCeramic: lib.get('roof_ceramic', { porosity: 0.6, side: THREE.DoubleSide }),
    fibro: lib.get('fibro', { porosity: 0.5, side: THREE.DoubleSide }),
    fibroCover: lib.get('fibro', { porosity: 0.5, side: THREE.DoubleSide, pom: false }),
    solar: lib.plain({ color: '#1b2a44', roughness: 0.15, metalness: 0.3 }, { porosity: 0, dirt: 0.5 }),
    tank: lib.plain({ color: '#2462a8', roughness: 0.45, metalness: 0.0 }, { porosity: 0 }),
    tankLid: lib.plain({ color: '#1d4f8a', roughness: 0.5 }, { porosity: 0 }),
    ac: lib.plain({ color: '#e6e5e0', roughness: 0.5, metalness: 0.1 }, { porosity: 0.1 }),
    acGrille: lib.plain({ color: '#3a3a3a', roughness: 0.6, metalness: 0.4 }),
    sill: lib.get('concrete_plain', { tint: '#e2ddd2', grime: 0.4 }),
    frame: (c) => lib.plain({ color: c, roughness: 0.45, metalness: c === '#c2c5c7' || c === '#8a8d8f' ? 0.7 : 0.1 }, { porosity: 0.1 }),
    steel: (c) => lib.get('steel', { tint: c, porosity: 0.1 }),
  };
}

// frame whose local +z is the outward normal (ox, oz); `out` pushes it off the wall
function outwardFrame(x, y, z, ox, oz, out = 0) {
  // local X = up x outward = (oz, 0, -ox)
  const X = new THREE.Vector3(oz, 0, -ox).normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(ox, 0, oz).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  m.setPosition(x + ox * out, y, z + oz * out);
  return m;
}

function addWindow(B0, M, ctx, o) {
  const { x, y, z, ox, oz, w, h, style, ground, r } = o;
  if (w < 0.5) return;
  const crook = crookMatrix(x, y, z, oz, -ox, r, { lean: 0.4, roll: 0.5, twist: 0.4, shift: 0.006 });
  const B = { add: (k, mat, g, m) => B0.add(k, mat, g, m ? crook.clone().multiply(m) : crook) };
  const cy = y + h / 2;
  const lit = r.chance(Math.min(1, 0.3 * ctx.cfg.buildings.litWindows));
  const glassMat = lit ? M.glassLit : M.glass;
  const type = style.type || 'sliding';
  const closed = type === 'shutter' && r.chance(0.45);
  if (closed) {
    // venezianas closed: louvred wood panel
    const sm = ctx.lib.get('wood', { tint: style.shutterColor, grime: 0.6 });
    B.add('shutter', sm, boxGeometry(w, h, 0.03, 1, 0), outwardFrame(x, cy, z, ox, oz, 0.03));
    for (let i = 0; i < Math.round(h / 0.06); i++) B.add('louver', sm, boxGeometry(w - 0.04, 0.015, 0.02, 1, 0), outwardFrame(x, y + 0.03 + i * 0.06, z, ox, oz, 0.05));
  } else {
    const g = new THREE.PlaneGeometry(w, h);
    B.add(lit ? 'glassLit' : 'glass', glassMat, g, outwardFrame(x, cy, z, ox, oz, 0.025));
    // something behind the glass: curtains or blinds in many homes
    if (!lit && r.chance(0.45)) {
      const cc = r.pick(['#d9d2c0', '#b9a37f', '#8a6f8f', '#c9c9c9', '#a8b8c8', '#e8e0d0', '#7a5a4a']);
      const cw = w * r.float(0.3, 1);
      B.add('curtain', ctx.lib.plain({ color: cc, roughness: 0.95 }, { porosity: 0.8, dirt: 0 }), new THREE.PlaneGeometry(cw, h * 0.95), outwardFrame(x + oz * (w - cw) / 2 * r.sign(), cy, z - ox * (w - cw) / 2 * r.sign(), ox, oz, -0.06));
    }
  }
  if (type === 'vitro') {
    // steel vitro: grid of small panes
    const gm = M.steel(style.frame === '#ecebe6' ? '#ecebe6' : '#2a2b2c');
    const nc = Math.max(2, Math.round(w / 0.25)), nr = Math.max(2, Math.round(h / 0.25));
    for (let i = 1; i < nc; i++) { const s = -w / 2 + w * i / nc; B.add('vitro', gm, boxGeometry(0.018, h, 0.02, 1, 0), outwardFrame(x + oz * s, cy, z - ox * s, ox, oz, 0.035)); }
    for (let j = 1; j < nr; j++) B.add('vitro', gm, boxGeometry(w, 0.018, 0.02, 1, 0), outwardFrame(x, y + h * j / nr, z, ox, oz, 0.035));
  } else if (type === 'shutter' && !closed) {
    // open shutters folded against the wall on both sides
    const sm = ctx.lib.get('wood', { tint: style.shutterColor, grime: 0.6 });
    for (const sx of [-1, 1]) B.add('shutter', sm, boxGeometry(w / 2, h, 0.03, 1, 0), outwardFrame(x + oz * sx * (w * 0.75 + 0.06), cy, z - ox * sx * (w * 0.75 + 0.06), ox, oz, 0.04));
  } else if (type === 'maxim') {
    // maxim-ar: one pane pushed out at the bottom
    const pm = new THREE.Matrix4().makeRotationX(-r.float(0.1, 0.4));
    const m = outwardFrame(x, y + h, z, ox, oz, 0.04).multiply(pm).multiply(new THREE.Matrix4().makeTranslation(0, -h / 2, 0));
    B.add('glass', glassMat, new THREE.PlaneGeometry(w * 0.95, h * 0.95), m);
  }
  const fm = M.frame(style.frame);
  const ft = 0.05, fd = 0.07;
  B.add('wframe', fm, boxGeometry(w + ft * 2, ft, fd), outwardFrame(x, y - ft / 2, z, ox, oz, 0.03));
  B.add('wframe', fm, boxGeometry(w + ft * 2, ft, fd), outwardFrame(x, y + h + ft / 2, z, ox, oz, 0.03));
  for (const sx of [-1, 1]) {
    B.add('wframe', fm, boxGeometry(ft, h, fd), outwardFrame(x + oz * sx * (w / 2 + ft / 2), cy, z - ox * sx * (w / 2 + ft / 2), ox, oz, 0.03));
  }
  B.add('wframe', fm, boxGeometry(0.035, h, 0.04), outwardFrame(x, cy, z, ox, oz, 0.04));
  B.add('sill', M.sill, boxGeometry(w + 0.16, 0.035, 0.16), outwardFrame(x, y - ft - 0.02, z, ox, oz, 0.06));
  if (ground && style.grille) {
    const gm = M.steel(style.grilleColor);
    const n = Math.max(2, Math.round(w / 0.11));
    const bar = boxGeometry(0.014, h + 0.1, 0.014);
    for (let i = 0; i <= n; i++) {
      const s = -w / 2 + w * i / n;
      B.add('wgrille', gm, bar, outwardFrame(x + oz * s, cy, z - ox * s, ox, oz, 0.12));
    }
    for (const yy of [y - 0.02, y + h + 0.02, cy]) B.add('wgrille', gm, boxGeometry(w + 0.04, 0.025, 0.02), outwardFrame(x, yy, z, ox, oz, 0.12));
  }
  if (r.chance(Math.min(1, 0.12 * ctx.cfg.buildings.ac))) {
    // split AC condenser on brackets under the window
    const s = r.float(-w / 2, w / 2);
    const m = outwardFrame(x + oz * s, y - 0.5, z - ox * s, ox, oz, 0.2);
    B.add('ac', M.ac, boxGeometry(0.8, 0.55, 0.28), m);
    B.add('acg', M.acGrille, new THREE.CircleGeometry(0.2, 16), outwardFrame(x + oz * (s + 0.1), y - 0.5, z - ox * (s + 0.1), ox, oz, 0.341));
  }
}

function waterTank(B, M, c, top, ring, r) {
  for (let tries = 0; tries < 6; tries++) {
    const x = c[0] + r.float(-3, 3), z = c[1] + r.float(-3, 3);
    if (!pointInRing(x, z, ring)) continue;
    const big = r.chance(0.3);
    const rad = big ? 0.85 : 0.68, h = big ? 1.1 : 0.85;
    const body = new THREE.CylinderGeometry(rad, rad * 0.9, h, 24);
    B.add('tank', M.tank, body, new THREE.Matrix4().makeTranslation(x, top + h / 2, z));
    const lid = new THREE.CylinderGeometry(rad * 0.98, rad * 1.02, 0.12, 24);
    B.add('tankLid', M.tankLid, lid, new THREE.Matrix4().makeTranslation(x, top + h + 0.06, z));
    return;
  }
}

function orientedBox(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 0.5) continue;
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
    let mu = Infinity, Mu = -Infinity, mv = Infinity, Mv = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      mu = Math.min(mu, u); Mu = Math.max(Mu, u); mv = Math.min(mv, v); Mv = Math.max(Mv, v);
    }
    const area = (Mu - mu) * (Mv - mv);
    if (!best || area < best.area) best = { area, ux, uz, mu, Mu, mv, Mv };
  }
  const cu = (best.mu + best.Mu) / 2, cv = (best.mv + best.Mv) / 2;
  let hu = (best.Mu - best.mu) / 2, hv = (best.Mv - best.mv) / 2;
  let ux = best.ux, uz = best.uz;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  if (hv > hu) { [hu, hv] = [hv, hu]; [ux, uz] = [-uz, ux]; }
  return { cx, cz, ux, uz, hu, hv };
}

function buildPitchedRoof(B, M, b, obb, top, facadeMat, r) {
  const ceramic = b.roof === 'ceramic';
  const mat = ceramic ? M.roofCeramicV(r) : M.fibroV(r);
  const o = 0.45;
  const { cx, cz, ux, uz, hu, hv } = obb;
  const vx = -uz, vz = ux;
  const P = (u, v, y) => new THREE.Vector3(cx + ux * u + vx * v, y, cz + uz * u + vz * v);
  const shed = !ceramic && r.chance(0.55);
  const slope = ceramic ? r.float(0.3, 0.4) : r.float(0.1, 0.18);
  const U = hu + o, V = hv + o;
  const quads = [];
  if (shed) {
    const rise = 2 * hv * slope;
    quads.push([P(-U, -V, top + rise + o * slope), P(U, -V, top + rise + o * slope), P(U, V, top - o * slope), P(-U, V, top - o * slope)]);
    // fill triangle walls (oitao) on the short ends
    for (const su of [-1, 1]) tri(B, facadeMat, P(su * hu, -hv, top), P(su * hu, hv, top), P(su * hu, -hv, top + rise), su > 0);
    B.add('facade:' + b.id, facadeMat, quadGeo(P(-hu, -hv, top), P(hu, -hv, top), P(hu, -hv, top + rise), P(-hu, -hv, top + rise)));
  } else {
    const rise = hv * slope;
    const ridge = top + rise;
    quads.push([P(-U, -V, top - o * slope), P(U, -V, top - o * slope), P(U, 0, ridge), P(-U, 0, ridge)]);
    quads.push([P(U, V, top - o * slope), P(-U, V, top - o * slope), P(-U, 0, ridge), P(U, 0, ridge)]);
    for (const su of [-1, 1]) tri(B, facadeMat, P(su * hu, -hv, top), P(su * hu, hv, top), P(su * hu, 0, ridge), su > 0);
    if (ceramic) {
      // ridge cap row
      const cap = new THREE.CylinderGeometry(0.09, 0.09, U * 2, 8, 1, false, 0, Math.PI);
      cap.rotateZ(Math.PI / 2);
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(vx, 0, vz));
      m.setPosition(cx, ridge + 0.02, cz);
      B.add('roof:' + b.roof, mat, cap, m);
    }
  }
  for (const q of quads) {
    const g = quadGeo(...q, true);
    B.add('roof:' + b.roof, mat, g);
  }
}

function quadGeo(a, b, c, d, slopeUV = false) {
  const g = new THREE.BufferGeometry();
  const pos = [a, b, c, a, c, d].flatMap(p => [p.x, p.y, p.z]);
  // uv: u along a->b, v along a->d (meters)
  const ab = b.clone().sub(a), ad = d.clone().sub(a);
  const lu = ab.length(), lv = ad.length();
  const U = ab.normalize(), V = ad.normalize();
  const uvs = [a, b, c, a, c, d].flatMap(p => { const q = p.clone().sub(a); return [q.dot(U), q.dot(V)]; });
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

function tri(B, mat, a, b, c, flip) {
  const g = new THREE.BufferGeometry();
  const pts = flip ? [a, c, b] : [a, b, c];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(p => [p.x, p.y, p.z]), 3));
  const ab = b.clone().sub(a).normalize();
  g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap(p => { const q = p.clone().sub(a); return [q.dot(ab), q.y]; }), 2));
  g.computeVertexNormals();
  const m = mat.clone();
  m.side = THREE.DoubleSide;
  B.add('gable', mat, g);
}

function lotFacade(B, M, ctx, lot) {
  const { lib, gy, rng } = ctx;
  const r = lot.rng.fork('facade');
  const b = lot.building;
  // the wall the frontage elements hang on: the building edge facing the street that
  // overlaps this lot; elements follow that edge (its line, its extent, its lean)
  let wall = null;
  const ring = b.outer;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1) continue;
    let ex = (q[0] - p[0]) / L, ez = (q[1] - p[1]) / L;
    // edge normal pointing to the street (against the lot's inward normal)
    let enx = -ez, enz = ex;
    if (enx * lot.n[0] + enz * lot.n[1] > 0) { enx = -enx; enz = -enz; }
    if (-(enx * lot.n[0] + enz * lot.n[1]) < 0.94) continue;
    // extent of the edge projected on the lot frontage
    const sp = (P) => (P[0] - lot.a[0]) * lot.t[0] + (P[1] - lot.a[1]) * lot.t[1];
    const s0 = Math.max(0, Math.min(sp(p), sp(q))), s1 = Math.min(lot.len, Math.max(sp(p), sp(q)));
    if (s1 - s0 < 1.2) continue;
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const dist = (mid[0] - lot.a[0]) * lot.n[0] + (mid[1] - lot.a[1]) * lot.n[1];
    if (dist < -0.5 || dist > 2.5) continue;
    if (!wall || dist < wall.dist) wall = { p, ex, ez, enx, enz, s0, s1, dist, L };
  }
  if (!wall) return;
  const [tx, tz] = [wall.ex * Math.sign(wall.ex * lot.t[0] + wall.ez * lot.t[1] || 1), wall.ez * Math.sign(wall.ex * lot.t[0] + wall.ez * lot.t[1] || 1)];
  const ox = wall.enx, oz = wall.enz; // outward toward the street
  // point on the wall at frontage coordinate s (lot.a based), plus the building lean
  const at = (s) => {
    const fx = lot.a[0] + lot.t[0] * s, fz = lot.a[1] + lot.t[1] * s;
    const d = (fx - wall.p[0]) * ox + (fz - wall.p[1]) * oz;
    const x = fx - ox * d, z = fz - oz * d;
    const w = b.warp ? b.warp(x, (b.groundRef ?? 0) + 1.5, z) : [0, 0];
    return [x + w[0], z + w[1]];
  };
  const inWall = (s, hw) => s - hw >= wall.s0 - 0.05 && s + hw <= wall.s1 + 0.05;
  // local copies: other layers still use the lot's own frontage
  const gates = lot.gates.filter(g => inWall(g.s, g.w / 2));
  const S0 = wall.s0, S1 = wall.s1, SM = (S0 + S1) / 2;
  const ground = (s) => ctx.sidewalkY(...at(s)) + 0.0;
  const topY = b.top ?? (ground(SM) + b.h);

  if (lot.use === 'shop') {
    const doorH = r.float(2.7, 3.2);
    const sMat = r.chance(0.5) ? lib.get('rollup_galv', { grime: 0.8 }) : lib.get('rollup', { tint: r.pick(['#b8b5ad', '#3a4a5c', '#2b2c2e', '#7b2b25', '#e9e7e0', '#2f4a36']), grime: 0.8 });
    for (const g of gates) {
      const [x, z] = at(g.s);
      const y0 = ground(g.s);
      if (g.open) {
        const tex = interiorTexture(r);
        const im = lib.plain({ map: tex, color: '#ffffff', roughness: 0.9, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.08 }, { porosity: 0 });
        ctx.nightEmissive.push({ mat: im, base: 0.5, day: 0.08 });
        B.add('interior:' + lot.id + g.s, im, new THREE.PlaneGeometry(g.w, doorH), outwardFrame(x, y0 + doorH / 2, z, ox, oz, 0.02));
        B.add('rollbox', M.steel('#6d6e6b'), boxGeometry(g.w + 0.1, 0.35, 0.3), outwardFrame(x, y0 + doorH + 0.18, z, ox, oz, 0.15));
      } else {
        B.add('rollup:' + lot.id, sMat, boxGeometry(g.w, doorH, 0.03), outwardFrame(x, y0 + doorH / 2, z, ox, oz, 0.03));
        B.add('rollbox', M.steel('#6d6e6b'), boxGeometry(g.w + 0.1, 0.35, 0.3), outwardFrame(x, y0 + doorH + 0.18, z, ox, oz, 0.15));
      }
      // guides
      for (const sx of [-1, 1]) {
        const [gx, gz] = at(g.s + sx * (g.w / 2 + 0.03));
        B.add('guides', M.steel('#5d5f60'), boxGeometry(0.06, doorH, 0.06), outwardFrame(gx, y0 + doorH / 2, gz, ox, oz, 0.03));
      }
    }
    // signboard over the doors
    const signH = Math.min(r.float(0.7, 1.2), Math.max(0.4, topY - (ground(SM) + 3.5)));
    if (signH > 0.35) {
      const w = S1 - S0 - r.float(0.2, 1.0);
      const tex = shopSign(r, ctx.city, w / signH);
      const sm = lib.plain({ map: tex, roughness: 0.6, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0 }, { porosity: 0.1 });
      if (r.chance(0.5)) ctx.nightEmissive.push({ mat: sm, base: 0.6 });
      const [x, z] = at(SM);
      B.add('sign:' + lot.id, sm, boxGeometry(w, signH, 0.06, 0), outwardFrame(x, ground(SM) + 3.4 + signH / 2, z, ox, oz, 0.06));
      // the box geometry got uvScale 0: rebuild the front face with a plane carrying the texture
      B.add('signface:' + lot.id, sm, new THREE.PlaneGeometry(w, signH), outwardFrame(x, ground(SM) + 3.4 + signH / 2, z, ox, oz, 0.115));
    }
  } else {
    // house built on the property line: garage gate + door + windows
    for (const g of gates) {
      const [x, z] = at(g.s);
      const y0 = ground(g.s);
      const h = g.kind === 'garage' ? r.float(2.2, 2.6) : 2.1;
      const tex = g.style === 'slats' ? 'gate_slats' : g.style === 'sheet_perf' ? 'gate_perf' : 'gate_ribs';
      const gm = g.style === 'grille' ? M.steel(g.color) : lib.get(tex, { tint: g.color, grime: 0.7, porosity: 0.1 });
      B.add('fgate:' + tex + g.color, gm, boxGeometry(g.w, h, 0.04), outwardFrame(x, y0 + h / 2, z, ox, oz, 0.03));
      B.add('lintel', M.sill, boxGeometry(g.w + 0.2, 0.12, 0.12), outwardFrame(x, y0 + h + 0.06, z, ox, oz, 0.06));
    }
    // windows in the free space
    const occupied = gates.map(g => [g.s - g.w / 2 - 0.4, g.s + g.w / 2 + 0.4]);
    for (let s = S0 + 1.0; s < S1 - 1.0; s += 2.2) {
      if (occupied.some(([a, c]) => s + 0.7 > a && s - 0.7 < c)) continue;
      const [x, z] = at(s);
      addWindow(B, M, ctx, { x, y: ground(s) + 1.1, z, ox, oz, w: 1.2, h: 1.0, style: { frame: '#c2c5c7', grille: true, grilleColor: '#1d1e1f' }, ground: true, r, b });
    }
    // house number plate
    if (r.chance(0.7)) {
      const tex = houseNumber(r, r.int(12, 2900));
      const [x, z] = at(Math.min(S1 - 0.4, S0 + 0.5));
      B.add('num:' + lot.id, lib.plain({ map: tex, roughness: 0.5 }), new THREE.PlaneGeometry(0.22, 0.16), outwardFrame(x, ground(S0 + 0.5) + 1.8, z, ox, oz, 0.02));
    }
  }
}

function interiorTexture(r) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#3a3832'); grd.addColorStop(1, '#14130f');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  // fluorescent tubes
  g.fillStyle = '#f4f6f0';
  for (let i = 0; i < 3; i++) g.fillRect(30 + i * 75, 18 + r.int(0, 6), 50, 4);
  // shelves with goods
  for (let y = 70; y < 230; y += 34) {
    g.fillStyle = '#2a2722'; g.fillRect(0, y + 26, 256, 4);
    for (let x = 0; x < 256; x += r.int(6, 14)) {
      g.fillStyle = `hsl(${r.int(0, 360)}, ${r.int(20, 70)}%, ${r.int(20, 55)}%)`;
      g.fillRect(x, y + r.int(4, 12), r.int(4, 10), 26 - r.int(0, 10));
    }
  }
  // counter
  g.fillStyle = '#5a4a3a'; g.fillRect(r.int(0, 120), 180, 120, 76);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tags(ctx, group) {
  const { layout, lib, focus } = ctx;
  for (const lot of layout.lots) {
    if (!lot.wall || !lot.wall.tagged || Math.hypot(lot.c[0] - focus[0], lot.c[1] - focus[1]) > 70) continue;
    const r = lot.rng.fork('tag');
    const L = lot.len;
    const w = Math.min(L - 0.4, r.float(1.5, 4.5));
    const h = Math.min(lot.wall.h - 0.3, w * r.float(0.2, 0.35));
    if (w < 0.8 || h < 0.3) continue;
    const s = r.float(w / 2 + 0.2, L - w / 2 - 0.2);
    // avoid gates
    if (lot.gates.some(g => Math.abs(g.s - s) < g.w / 2 + w / 2)) continue;
    const tex = tagTexture(r);
    const m = lib.plain({ map: tex, transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }, { porosity: 0.3 });
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const x = lot.a[0] + tx * s - nx * 0.005, z = lot.a[1] + tz * s - nz * 0.005;
    const y = ctx.sidewalkY(x, z) + lot.wall.h - h / 2 - r.float(0.05, 0.4);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(outwardFrame(x, y, z, -nx, -nz, 0.0));
    group.add(mesh);
  }
}
