// Turns raw map data into a street plan: carriageway / curb / sidewalk regions,
// lots with front walls and gates, building assignments and the camera mount.
import { DRIVABLE } from './mapdata.js';
import { scaled } from '../config.js';
import { Region, END, polyLength, pointAt, offsetLine, rayToRings, distPointLine, centroid, ringArea, pointInRing } from '../core/geom.js';

const ROAD_SPEC = {
  motorway: { w: [18, 24], sw: [0, 0] },
  trunk: { w: [16, 22], sw: [3, 4.5] },
  primary: { w: [13, 18], sw: [3, 4.5] },
  secondary: { w: [10, 13], sw: [2.5, 4] },
  tertiary: { w: [8.5, 11], sw: [2.2, 3.5] },
  street: { w: [6.5, 9], sw: [1.6, 3.0] },
  street_limited: { w: [5.5, 7], sw: [1.2, 2.2] },
  service: { w: [3.5, 5], sw: [0, 0] },
  primary_link: { w: [6, 8], sw: [0, 1.5] },
  secondary_link: { w: [6, 8], sw: [0, 1.5] },
  tertiary_link: { w: [6, 8], sw: [0, 1.5] },
  trunk_link: { w: [6, 8], sw: [0, 1.5] },
};

const ARTERIAL = new Set(['primary', 'secondary', 'trunk', 'tertiary']);

function sidewalkMaterialFor(rng, city, central, mult) {
  if (city === 'cwb') {
    return rng.weighted(scaled([['petitpave', central ? 4 : 1.2], ['concrete', 3], ['paver', 1.6], ['concrete_old', 1.5], ['grass_strip', 1]], mult));
  }
  return rng.weighted(scaled([['concrete', 4], ['concrete_old', 2], ['ceramic_red', 1.3], ['caquinho', 0.8], ['ladrilho', 0.7], ['paver', 1.5], ['grass_strip', 0.8], ['petitpave', 0.25]], mult));
}

export function buildLayout(map, rng, cfg) {
  const R = map.radius;
  let tl = performance.now();
  const lap = (l) => { console.log('[sim]   layout.' + l, Math.round(performance.now() - tl), 'ms'); tl = performance.now(); };
  const region = Region.rect(-R, -R, R, R);
  const city = map.cityKey;

  // ---------- roads ----------
  const roads = [];
  for (const r of map.roads) {
    if (!DRIVABLE.has(r.cls)) continue;
    if (r.pts.length < 2 || polyLength(r.pts) < 2) continue;
    const spec = ROAD_SPEC[r.cls];
    const rr = rng.fork('road:' + (r.name || r.cls + r.pts[0].join(',')));
    let w = rr.float(spec.w[0], spec.w[1]);
    if (r.oneway && r.cls === 'street') w = Math.min(w, rr.float(6.5, 8));
    w *= cfg.roads.widthScale;
    // each side of the street has its own sidewalk: usually 1.5-3 m, but some blocks
    // keep a wide front strip (a car length or more) where cars park nose-in
    const sideWidth = () => {
      if (spec.sw[1] <= 0) return 0;
      const k = rr.weighted([['normal', 6], ['wide', 1.4], ['deep', r.cls === 'street' || r.cls === 'tertiary' ? 0.9 : 0.3]]);
      const v = k === 'normal' ? rr.float(spec.sw[0], spec.sw[1]) : k === 'wide' ? rr.float(3.4, 5.2) : rr.float(5.5, 8.5);
      return v * cfg.roads.sidewalkScale;
    };
    const swR = sideWidth(), swL = sideWidth();
    const sw = Math.max(swR, swL);
    const wear = cfg.roads.wear;
    roads.push({
      ...r, w, sw, swR, swL,
      asphalt: rr.weighted(scaled([['asphalt_old', 3], ['asphalt_new', 1.3], ['asphalt_patchy', 2]], { asphalt_old: wear, asphalt_patchy: wear, asphalt_new: Math.max(0, 2 - wear) })),
      centerLine: r.cls === 'service' || r.oneway ? 'none' : rr.weighted([['double_yellow', 2 * cfg.roads.centerLine], ['dashed_yellow', 2 * cfg.roads.centerLine], ['none', 1.5]]),
      paintWear: Math.min(1, rr.float(0.15, 0.9) * cfg.roads.paintWear),
      len: polyLength(r.pts),
    });
  }

  const carr = Region.fromLines(roads.map(r => ({ pts: r.pts, half: r.w / 2 })), 0, END.round).close(4).and(region);
  // one-sided strips per side + round caps of the narrower side so corners stay filled
  let outerRaw = Region.fromLines(roads.filter(r => r.sw > 0).map(r => ({ pts: r.pts, half: r.w / 2 + Math.min(r.swL, r.swR) })), 0, END.round);
  for (const r of roads) {
    for (const [side, sw] of [[1, r.swR], [-1, r.swL]]) {
      if (sw <= 0) continue;
      const inner = offsetLine(r.pts, side * r.w / 2 * 0.98);
      const outerL = offsetLine(r.pts, side * (r.w / 2 + sw));
      outerRaw = outerRaw.union(Region.fromRings([inner.concat(outerL.slice().reverse())]));
    }
  }
  outerRaw = outerRaw.close(1.5);
  const outer = outerRaw.union(carr).and(region);
  const sidewalk = outer.minus(carr);
  const gutter = carr.minus(carr.offset(-0.4)).and(sidewalk.offset(0.45));
  const blocks = region.minus(outer);
  const outerRings = outer.rings();

  lap('roads+regions');
  // ---------- buildings (clip off anything that falls on the public way) ----------
  const buildings = [];
  // offset once, not per building
  const outerOff = outer.offset(0.3);
  // most buildings never reach the public way: walk their outline every 0.5 m and
  // only run the (whole-network) boolean when some point falls inside it
  const touchesWay = (rings) => {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.5));
        for (let k = 0; k < n; k++) if (outerOff.contains(p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n)) return true;
      }
    }
    return false;
  };
  for (const b of map.buildings) {
    const reg = touchesWay(b.rings) ? Region.fromRings(b.rings).minus(outerOff) : Region.fromRings(b.rings).union(null);
    for (const ex of reg.expolys()) {
      const a = Math.abs(ringArea(ex.outer));
      if (a < 6) continue;
      buildings.push({ id: b.id, type: b.type, height: b.height, minHeight: b.minHeight, outer: ex.outer, holes: ex.holes, area: a, mapped: true });
    }
  }

  lap('buildings');
  // ---------- lots along property lines ----------
  const lots = [];
  const lotRng = rng.fork('lots');
  const nearRoad = (x, z) => {
    let best = null;
    for (const r of roads) {
      const d = distPointLine(x, z, r.pts);
      if (!best || d.d < best.d) best = { d: d.d, road: r, seg: d.seg, t: d.t };
    }
    return best;
  };

  for (const ring of outerRings) {
    // split the ring into straight-ish runs at sharp corners
    const n = ring.length;
    if (n < 3) continue;
    const pts = ring.concat([ring[0]]);
    const runs = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      cur.push(pts[i]);
      if (i < pts.length - 1) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const d1 = Math.atan2(b[1] - a[1], b[0] - a[0]), d2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let da = Math.abs(d2 - d1); if (da > Math.PI) da = 2 * Math.PI - da;
        if (da > 0.5) { runs.push(cur); cur = [pts[i]]; }
      }
    }
    if (cur.length > 1) runs.push(cur);

    for (const run of runs) {
      const L = polyLength(run);
      if (L < 3) continue;
      // which side is the street: probe the right normal at the middle
      const mid = pointAt(run, L / 2);
      if (Math.abs(mid.x) > R - 2 || Math.abs(mid.z) > R - 2) continue;
      const rx = -mid.dz, rz = mid.dx;
      const streetRight = outer.contains(mid.x + rx * 0.4, mid.z + rz * 0.4);
      const sideSign = streetRight ? -1 : 1; // inward (into lot) normal = sideSign * right normal
      const nr = nearRoad(mid.x, mid.z);
      if (!nr) continue;
      const road = nr.road;
      const commercialBias = Math.min(0.95, (ARTERIAL.has(road.cls) ? 0.65 : 0.22) * cfg.lots.commercial);
      let s = 0;
      while (s < L - 2.5) {
        let w = lotRng.weighted([[lotRng.float(4.8, 6.5), 1.2], [lotRng.float(8, 10.5), 2.5], [lotRng.float(10.5, 15), 1], [lotRng.float(15, 24), 0.4]]) * cfg.lots.widthScale;
        if (L - s - w < 4) w = L - s;
        const s0 = s, s1 = Math.min(L, s + w);
        s = s1;
        const front = [];
        const steps = Math.max(1, Math.ceil((s1 - s0) / 2));
        for (let k = 0; k <= steps; k++) { const q = pointAt(run, s0 + (s1 - s0) * k / steps); front.push([q.x, q.z]); }
        const a = front[0], b = front[front.length - 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 2) continue;
        const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
        const nx = -tz * sideSign, nz = tx * sideSign; // into the lot
        const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
        if (Math.hypot(cx, cz) > R - 10) continue;
        const depth = Math.min(32, rayToRings(cx + nx * 0.2, cz + nz * 0.2, nx, nz, outerRings, 80) / 2);
        lots.push({
          id: lots.length, front, a, b, len, t: [tx, tz], n: [nx, nz], c: [cx, cz], depth: Math.max(4, depth),
          road, roadDist: nr.d, sw: Math.max(0.3, nr.d - road.w / 2), commercialBias, rng: lotRng.fork('lot' + lots.length),
        });
      }
    }
  }

  lap('lots');
  // ---------- assign buildings to lots ----------
  for (const lot of lots) {
    let setback = Infinity, hit = null;
    const samples = 5;
    for (let k = 0; k < samples; k++) {
      const f = (k + 0.5) / samples;
      const ox = lot.a[0] + (lot.b[0] - lot.a[0]) * f + lot.n[0] * 0.05;
      const oz = lot.a[1] + (lot.b[1] - lot.a[1]) * f + lot.n[1] * 0.05;
      for (const b of buildings) {
        const c = b.outer[0];
        if (Math.abs(c[0] - ox) > 70 || Math.abs(c[1] - oz) > 70) continue;
        const d = rayToRings(ox, oz, lot.n[0], lot.n[1], [b.outer], lot.depth + 2);
        if (d < lot.depth + 2 && d < setback) { setback = d; hit = b; }
      }
    }
    lot.building = hit;
    lot.setback = hit ? setback : null;
  }

  lap('assign');
  // ---------- lot programme: walls, gates, use ----------
  for (const lot of lots) {
    const r = lot.rng;
    const flush = lot.building && lot.setback < 1.0;
    let use;
    if (flush) use = r.chance(lot.commercialBias + (lot.building.type === 'retail' || lot.building.type === 'commercial' ? 0.4 : 0)) ? 'shop' : 'house_flush';
    else if (lot.building) use = r.chance(lot.commercialBias * 0.35) ? 'shop_setback' : 'house';
    else use = r.weighted([['house_gen', cfg.lots.genBuildings ? 6 : 0], ['vacant', 1.4 * cfg.lots.vacant], ['yard', 1], ['shop_gen', cfg.lots.genBuildings ? lot.commercialBias * 4 : 0]]);
    lot.use = use;
    lot.sidewalkMat = sidewalkMaterialFor(r, city, ARTERIAL.has(lot.road.cls), cfg.sidewalk);
    lot.sidewalkTint = r.float(-0.08, 0.08);

    if (use === 'shop' || use === 'house_flush' || use === 'shop_gen') {
      lot.wall = null;
    } else {
      const style = use === 'vacant'
        ? r.weighted([['block_raw', 3], ['plaster_full', 2], ['fence_wire', 1]])
        : r.weighted(scaled([['plaster_full', 4.5], ['base_grille', 3.5], ['grille', 2.2], ['block_raw', city === 'sp' ? 1.2 : 0.4], ['stone_base', 1.5], ['low_wall', city === 'cwb' ? 2.2 : 1.0], ['brick_raw', city === 'sp' ? 0.9 : 0.3]], cfg.walls));
      const h = (style === 'low_wall' ? r.float(0.8, 1.3) : style === 'grille' ? r.float(1.6, 2.2) : r.float(1.8, 2.9)) * cfg.walls.heightScale;
      lot.wall = {
        style, h,
        baseH: style === 'base_grille' ? r.float(0.4, 1.1) : style === 'stone_base' ? r.float(0.8, 1.3) : 0,
        topper: h > 1.7 ? r.weighted(scaled([['none', 3], ['electric', 3], ['concertina', 1.5], ['spikes', 1], ['glass', 0.4]], cfg.walls)) : 'none',
        color: wallColor(r),
        tagged: r.chance((city === 'sp' ? 0.45 : 0.2) * cfg.walls.tags),
      };
    }

    // gates / doors along the frontage
    lot.gates = [];
    const L = lot.len;
    const wantsGarage = use !== 'vacant' && use !== 'shop' && L >= 4.8 && r.chance(Math.min(1, (use === 'yard' ? 0.8 : 0.72) * cfg.lots.garage));
    let cursor = r.float(0.15, 0.6);
    if (wantsGarage) {
      const gw = Math.min(L - 1.6, r.float(2.8, 3.6));
      const left = r.chance(0.5);
      const pos = left ? cursor + gw / 2 : L - cursor - gw / 2;
      lot.gates.push({ kind: 'garage', s: pos, w: gw, style: r.weighted([['sheet', 4], ['grille', 1.5], ['slats', 2], ['sheet_perf', 1]]), color: r.pick(GATE_COLORS) });
      if (L - gw - cursor > 2.0) {
        const pw = r.float(0.9, 1.1);
        const ps = left ? Math.min(L - pw / 2 - 0.3, pos + gw / 2 + r.float(0.4, 1.5) + pw / 2) : Math.max(pw / 2 + 0.3, pos - gw / 2 - r.float(0.4, 1.5) - pw / 2);
        lot.gates.push({ kind: 'door', s: ps, w: pw, style: r.pick(['sheet', 'grille', 'slats']), color: lot.gates[0].color });
      }
    } else if (use === 'shop') {
      // roll-up doors take most of the frontage
      const nDoors = Math.max(1, Math.floor(L / r.float(3.5, 5.5)));
      const span = L / nDoors;
      for (let i = 0; i < nDoors; i++) lot.gates.push({ kind: 'rollup', s: span * (i + 0.5), w: Math.min(span - 0.5, 4.2), open: r.chance(0.6) });
    } else if (use !== 'vacant' && L > 2) {
      const pw = r.float(0.9, 1.1);
      lot.gates.push({ kind: 'door', s: r.float(pw, L - pw), w: pw, style: r.pick(['sheet', 'grille', 'slats']), color: r.pick(GATE_COLORS) });
    }
    lot.driveways = lot.gates.filter(g => g.kind === 'garage' || (g.kind === 'rollup' && r.chance(0.3)));
    lot.curbPaint = r.weighted([['none', 6], ['white', 1.5], ['yellow', 0.6]]);
  }

  lap('programme');
  // ---------- procedural buildings for unmapped lots ----------
  for (const lot of lots) {
    if (lot.building) continue;
    const r = lot.rng;
    if (lot.use === 'vacant' || lot.use === 'yard') continue;
    const shop = lot.use === 'shop_gen';
    const setback = shop ? 0 : r.weighted([[r.float(0.0, 1.0), 1], [r.float(2.5, 6), 3]]);
    const side = shop ? 0.05 : r.float(0, 1.4);
    const w = lot.len - side * (r.chance(0.5) ? 1 : 2);
    const d = Math.min(lot.depth - setback - 0.5, r.float(8, 16));
    if (w < 3 || d < 4) continue;
    const s0 = (lot.len - w) / 2;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const p = (s, o) => [lot.a[0] + tx * s + nx * o, lot.a[1] + tz * s + nz * o];
    const outerRing = [p(s0, setback), p(s0 + w, setback), p(s0 + w, setback + d), p(s0, setback + d)];
    // skip if overlapping mapped buildings
    const [cx, cz] = centroid(outerRing);
    if (buildings.some(b => pointInRing(cx, cz, b.outer))) continue;
    const b = { id: 'gen' + lot.id, type: shop ? 'commercial' : 'house', height: 0, minHeight: 0, outer: ringArea(outerRing) < 0 ? outerRing.reverse() : outerRing, holes: [], area: w * d, mapped: false, lot };
    buildings.push(b);
    lot.building = b;
    lot.setback = setback;
    if (setback < 1.0) { lot.wall = null; lot.use = shop ? 'shop' : 'house_flush'; }
  }

  lap('procbuildings');
  // ---------- building programme ----------
  const bRng = rng.fork('buildings');
  for (const [bi, b] of buildings.entries()) {
    const r = bRng.fork(String(b.id) + ':' + bi);
    b.rng = r;
    let floors;
    if (b.height > 0) floors = Math.max(1, Math.round(b.height / 3));
    else floors = Math.max(1, Math.round((b.area > 600 ? r.int(2, 4) : r.weighted([[1, 5], [2, 4], [3, 1]])) * cfg.buildings.floorsScale));
    b.floors = floors;
    b.floorH = r.float(2.8, 3.2);
    b.h = b.height > 0 ? Math.max(b.height, 2.6) : floors * b.floorH + r.float(0.2, 0.6);
    const tall = floors >= 5;
    b.facade = tall
      ? r.weighted([['plaster', 3], ['pastilha', 2.5], ['concrete', 1], ['brick', 0.6]])
      : r.weighted([['plaster', 6], ['brick', 0.8], ['stone', 0.6], ['pastilha', 0.6], ['block_raw', city === 'sp' ? 1 : 0.3], ['brick_raw', city === 'sp' ? 1.2 : 0.3]]);
    b.color = (tall ? r.pick(TOWER_COLORS) : wallColor(r));
    b.roof = tall ? 'flat' : r.weighted(scaled([['ceramic', 4], ['fibro', 3], ['flat', 2.5]], cfg.buildings));
    b.waterTank = b.roof !== 'ceramic' && r.chance(Math.min(1, 0.6 * cfg.buildings.waterTank));
  }

  lap('bprog');
  const camera = chooseCameraMount(lots, roads, map, rng.fork('camera'), cfg.camera);

  return { roads, regions: { carr, outer, sidewalk, gutter, blocks, region }, lots, buildings, camera, R };
}

export const WALL_COLORS = [
  // whites and greys
  '#ece8df', '#f3f1ea', '#d6d2c8', '#b9b6ae', '#9c9a94',
  // beiges / sand
  '#e4d3a8', '#d9c08a', '#cdb48c', '#e8cfa0',
  // yellows / ochres
  '#e8c547', '#f0d35c', '#d9a52b', '#c98d2a',
  // oranges, terracotta, reds
  '#e08a3c', '#c8633a', '#b0442f', '#9b2f28', '#c25b52',
  // greens
  '#7da05a', '#5f8f4a', '#3f6b45', '#a9c27a', '#2f5a48',
  // blues / teal
  '#5d8fbf', '#3e6f9e', '#8fb4d6', '#3d8a8a', '#6fb0b0',
  // pinks / lilac
  '#e3a0a8', '#c97a9a', '#a88cc0',
];
// about half the houses are white/beige/grey, the rest painted in strong colours
export function wallColor(r) {
  const base = r.chance(0.5) ? r.pick(WALL_COLORS.slice(0, 9)) : r.pick(WALL_COLORS.slice(9));
  return agePaint(base, r);
}
// exposed paint fades toward grey-beige and darkens with dirt over the years
export function agePaint(hex, r) {
  const c = parseInt(hex.slice(1), 16);
  let R = (c >> 16) / 255, G = ((c >> 8) & 255) / 255, B = (c & 255) / 255;
  const age = r.weighted([[r.float(0.15, 0.35), 1], [r.float(0.35, 0.6), 3], [r.float(0.6, 0.85), 2]]);
  const l = 0.3 * R + 0.59 * G + 0.11 * B;
  const fadeTo = [l * 1.02 + 0.03, l * 0.98 + 0.025, l * 0.9 + 0.01];
  const k = 0.25 + 0.5 * age;
  const dark = 1 - 0.18 * age;
  R = (R * (1 - k) + fadeTo[0] * k) * dark; G = (G * (1 - k) + fadeTo[1] * k) * dark; B = (B * (1 - k) + fadeTo[2] * k) * dark;
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(R) + h(G) + h(B);
}
const TOWER_COLORS = ['#e6e1d7', '#d9d4ca', '#cbc4b8', '#b9b4ab', '#e9dfcf', '#c4beb2', '#a8a29a', '#8f9295'];
export const GATE_COLORS = ['#1e1f20', '#2b2c2e', '#f2f2ef', '#6d6e6b', '#8a8c8a', '#5a3b28', '#3a4a5c', '#7b2b25', '#2f4a36', '#b7b2a4', '#46403a'];

function nearestOnRoad(pts, x, z) {
  let best = Infinity, bs = 0, acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (z - a[1]) * (b[1] - a[1])) / (L * L || 1)));
    const d = Math.hypot(a[0] + (b[0] - a[0]) * t - x, a[1] + (b[1] - a[1]) * t - z);
    if (d < best) { best = d; bs = acc + L * t; }
    acc += L;
  }
  return bs;
}
function pointAlong(pts, s) { return pointAt(pts, Math.max(0, Math.min(polyLength(pts), s))); }
function dotDir(pts, s, tx, tz) { const q = pointAt(pts, s); return q.dx * tx + q.dz * tz; }

function chooseCameraMount(lots, roads, map, r, ccfg) {
  // prefer lots facing the seed street near the origin
  const cand = lots
    .filter(l => Math.hypot(l.c[0], l.c[1]) < 26 && l.roadDist < 25)
    .map(l => ({ l, score: Math.hypot(l.c[0], l.c[1]) + (l.road.name === map.roadName ? 0 : 12) + r.float(0, 10) }))
    .sort((a, b) => a.score - b.score);
  const lot = (cand[0] || { l: lots.slice().sort((a, b) => Math.hypot(...a.c) - Math.hypot(...b.c))[0] }).l;
  let kind = lot.wall
    ? r.weighted([['wall_top', 3], ['facade', lot.building ? 2 : 0], ['wall_corner', 1.5], ['pole', 0.5]])
    : r.weighted([['facade', 4], ['pole', 0.6]]);
  if (ccfg.mount !== 'auto') {
    kind = ccfg.mount;
    if ((kind === 'wall_top' || kind === 'wall_corner') && !lot.wall) kind = 'facade';
  }

  const [tx, tz] = lot.t, [nx, nz] = lot.n;
  const s = kind === 'wall_corner' ? r.pick([0.25, lot.len - 0.25]) : r.float(0.2, 0.8) * lot.len;
  let off = -0.18; // bracket toward the street
  let h;
  if (kind === 'wall_top' || kind === 'wall_corner') h = lot.wall.h + r.float(0.1, 0.5);
  else if (kind === 'facade') {
    off = (lot.setback || 0) - 0.15;
    h = lot.building ? Math.min(lot.building.h - 0.3, r.float(2.6, 4.2)) : r.float(2.6, 3.4);
    h = Math.max(2.4, h);
  } else { off = -(Math.min(lot.sw, 2.5) - 0.35); h = r.float(3.5, 5.2); }

  const x = lot.a[0] + tx * s + nx * off;
  const z = lot.a[1] + tz * s + nz * off;
  // installers aim roughly at the street; pick a target on the carriageway then add
  // the usual mistakes on top
  if ((kind === 'facade' || kind === 'pole') && lot.wall && lot.setback > 0.5) h = Math.max(h, lot.wall.h + r.float(0.6, 1.6));
  const road = lot.road;
  const along = r.sign();
  const D = r.float(7, 26);
  const nearest = nearestOnRoad(road.pts, x, z);
  const tgt = pointAlong(road.pts, nearest + along * D * (dotDir(road.pts, nearest, tx, tz) >= 0 ? 1 : -1));
  const lateral = r.float(-road.w * 0.4, road.w * 0.4);
  const txp = tgt.x - tgt.dz * lateral, tzp = tgt.z + tgt.dx * lateral;
  let dx = txp - x, dz = tzp - z;
  const dist = Math.hypot(dx, dz);
  dx /= dist; dz /= dist;
  let yaw = Math.atan2(-dx, -dz) + r.gauss(0, 0.12);
  let quality = r.weighted([['ok', 4], ['too_flat', 1.3], ['too_steep', 1], ['skewed', 1.2]]);
  if (ccfg.quality !== 'auto') quality = ccfg.quality;
  let pitch = -Math.atan2(h, dist) * 180 / Math.PI + r.gauss(0, 3);
  if (quality === 'too_flat') pitch += r.float(6, 14);
  if (quality === 'too_steep') pitch -= r.float(10, 22);
  pitch = Math.max(-65, Math.min(-1, pitch));
  dx = -Math.sin(yaw); dz = -Math.cos(yaw);
  const roll = quality === 'skewed' ? r.float(3, 7) * r.sign() : r.gauss(0, 1.2);
  return { lot, kind, x, z, h, dir: [dx, dz], yaw, pitch, roll, quality, mountOffset: off, s };
}
