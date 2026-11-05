// Drainage and utility hardware: cast-iron manhole covers in the asphalt (sunk or
// proud, with their ring of patched asphalt), curb inlets (boca de lobo) with the
// concrete slab on the sidewalk and the grate in the gutter, and concrete
// telecom/water boxes on the sidewalk.
import * as THREE from 'three';
import { pointAt } from '../core/geom.js';
import { frameMatrix, boxGeometry } from './mesh.js';

function canvasPair(size, draw) {
  const a = document.createElement('canvas'), h = document.createElement('canvas');
  a.width = a.height = h.width = h.height = size;
  draw(a.getContext('2d'), h.getContext('2d'), size);
  const map = new THREE.CanvasTexture(a); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(h); bump.colorSpace = THREE.NoColorSpace;
  return { map, bump };
}

// round cast-iron cover: rim, raised pattern, utility name
function ironCover(r, kind, label) {
  return canvasPair(512, (g, hgt, S) => {
    const c = S / 2, R = S / 2 - 4;
    // base iron, mottled with rust and road grime
    g.fillStyle = '#2b2927'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${90 + r.int(0, 50)},${50 + r.int(0, 25)},${30 + r.int(0, 15)},${r.float(0.03, 0.12)})`;
      g.beginPath(); g.arc(r.float(0, S), r.float(0, S), r.float(2, 18), 0, 7); g.fill();
    }
    hgt.fillStyle = '#404040'; hgt.fillRect(0, 0, S, S);
    const raised = (fn) => {
      // pattern is worn shiny on top, so lighter in albedo and high in the bump map
      g.save(); hgt.save();
      g.fillStyle = 'rgba(120,118,112,0.55)'; hgt.fillStyle = '#d0d0d0';
      g.strokeStyle = 'rgba(120,118,112,0.55)'; hgt.strokeStyle = '#d0d0d0';
      fn(g); fn(hgt);
      g.restore(); hgt.restore();
    };
    // outer frame ring and gap
    g.lineWidth = hgt.lineWidth = 14;
    g.strokeStyle = '#3a3733'; hgt.strokeStyle = '#ffffff';
    g.beginPath(); g.arc(c, c, R - 7, 0, 7); g.stroke();
    hgt.beginPath(); hgt.arc(c, c, R - 7, 0, 7); hgt.stroke();
    g.lineWidth = hgt.lineWidth = 4;
    g.strokeStyle = '#090807'; hgt.strokeStyle = '#000000';
    g.beginPath(); g.arc(c, c, R - 17, 0, 7); g.stroke();
    hgt.beginPath(); hgt.arc(c, c, R - 17, 0, 7); hgt.stroke();
    if (kind === 'grid') {
      raised(x => {
        x.lineWidth = 7;
        for (let i = -6; i <= 6; i++) {
          x.beginPath(); x.moveTo(c + i * 30, c - R); x.lineTo(c + i * 30, c + R); x.stroke();
          x.beginPath(); x.moveTo(c - R, c + i * 30); x.lineTo(c + R, c + i * 30); x.stroke();
        }
      });
    } else {
      raised(x => {
        x.lineWidth = 6;
        for (let k = 1; k <= 4; k++) { x.beginPath(); x.arc(c, c, (R - 30) * k / 4.2, 0, 7); x.stroke(); }
        for (let a = 0; a < 16; a++) {
          const t = a / 16 * Math.PI * 2;
          x.beginPath(); x.moveTo(c + Math.cos(t) * 40, c + Math.sin(t) * 40); x.lineTo(c + Math.cos(t) * (R - 25), c + Math.sin(t) * (R - 25)); x.stroke();
        }
      });
    }
    // cast lettering across the middle
    g.save(); hgt.save();
    for (const x of [g, hgt]) {
      x.fillStyle = x === g ? '#2b2927' : '#404040';
      x.fillRect(c - 150, c - 34, 300, 68);
      x.fillStyle = x === g ? 'rgba(140,136,128,0.8)' : '#e0e0e0';
      x.font = 'bold 40px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(label, c, c);
    }
    g.restore(); hgt.restore();
    // pick holes
    for (const t of [0.6, 3.74]) {
      g.fillStyle = '#050505'; hgt.fillStyle = '#000';
      for (const x of [g, hgt]) { x.beginPath(); x.ellipse(c + Math.cos(t) * (R - 60), c + Math.sin(t) * (R - 60), 12, 6, t, 0, 7); x.fill(); }
    }
    // tar and dirt at the edge
    const grd = g.createRadialGradient(c, c, R * 0.7, c, c, R);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(10,9,8,0.5)');
    g.fillStyle = grd; g.fillRect(0, 0, S, S);
  });
}

function grate(r) {
  return canvasPair(256, (g, hgt, S) => {
    g.fillStyle = '#060504'; g.fillRect(0, 0, S, S);
    hgt.fillStyle = '#000'; hgt.fillRect(0, 0, S, S);
    const bars = 9;
    for (let i = 0; i < bars; i++) {
      const x = 10 + i * (S - 20) / (bars - 1);
      g.fillStyle = `rgb(${55 + r.int(0, 20)},${45 + r.int(0, 10)},${38})`; g.fillRect(x - 6, 0, 12, S);
      hgt.fillStyle = '#fff'; hgt.fillRect(x - 6, 0, 12, S);
    }
    for (const y of [6, S - 14]) { g.fillStyle = '#3c3530'; g.fillRect(0, y, S, 8); hgt.fillStyle = '#fff'; hgt.fillRect(0, y, S, 8); }
    // leaves and trash caught in the grate
    for (let i = 0; i < 20; i++) {
      g.fillStyle = r.pick(['#3b3420', '#4a3a22', '#2a2a28', '#5a4a30', '#d8d2c0']);
      g.beginPath(); g.ellipse(r.float(0, S), r.float(0, S), r.float(4, 14), r.float(2, 6), r.float(0, 3), 0, 7); g.fill();
    }
  });
}

function concreteLid(r, label) {
  return canvasPair(256, (g, hgt, S) => {
    g.fillStyle = '#7a776f'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${r.int(30, 90)},${r.int(30, 85)},${r.int(30, 80)},${r.float(0.04, 0.15)})`;
      g.fillRect(r.float(0, S), r.float(0, S), r.float(2, 20), r.float(2, 20));
    }
    hgt.fillStyle = '#808080'; hgt.fillRect(0, 0, S, S);
    // steel frame and handle slots
    g.strokeStyle = '#45423d'; g.lineWidth = 10; g.strokeRect(5, 5, S - 10, S - 10);
    hgt.strokeStyle = '#ffffff'; hgt.lineWidth = 10; hgt.strokeRect(5, 5, S - 10, S - 10);
    g.strokeStyle = '#0a0a0a'; g.lineWidth = 3; g.strokeRect(12, 12, S - 24, S - 24);
    for (const y of [0.3, 0.7]) {
      g.fillStyle = '#0d0c0b'; g.fillRect(S * 0.42, S * y - 6, S * 0.16, 12);
      hgt.fillStyle = '#000'; hgt.fillRect(S * 0.42, S * y - 6, S * 0.16, 12);
    }
    if (label) { g.fillStyle = 'rgba(40,38,34,0.7)'; g.font = 'bold 22px Arial'; g.textAlign = 'center'; g.fillText(label, S / 2, S / 2 + 8); }
  });
}

// ring of patched asphalt around a cover; inner edge dips (sunk cover) or rises (proud cover)
function coverRing(x, z, r0, r1, yIn, yOut) {
  const seg = 32;
  const pos = [], uv = [];
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const p = (a, rr) => [x + Math.cos(a) * rr, z + Math.sin(a) * rr];
    const A = p(a0, r0), Bp = p(a1, r0), C = p(a1, r1), D = p(a0, r1);
    const ys = [yIn(A), yIn(Bp), yOut(C), yOut(D)];
    // counter-clockwise seen from above so the face points up
    const v = [[A, ys[0]], [Bp, ys[1]], [C, ys[2]], [A, ys[0]], [C, ys[2]], [D, ys[3]]];
    for (const [[px, pz], py] of v) { pos.push(px, py, pz); uv.push(px, pz); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

export function buildDrains(ctx, B) {
  const { layout, lib, rng, focus } = ctx;
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const cwb = ctx.city === 'cwb';
  const r0 = rng.fork('drain-tex');
  const coverMats = [
    ['round', cwb ? 'SANEPAR' : 'SABESP'], ['round', 'ESGOTO'], ['grid', 'ÁGUAS PLUVIAIS'], ['round', cwb ? 'COPEL' : 'ENEL'], ['grid', 'TELEFONICA'],
  ].map(([kind, label]) => {
    const { map, bump } = ironCover(r0, kind, label);
    return lib.plain({ map, bumpMap: bump, bumpScale: 3, roughness: 0.8, metalness: 0.2 }, { porosity: 0.15, puddles: true, spec: 0.35 });
  });
  const ringMat = lib.get('asphalt_patch', { macro: 0.25, porosity: 0.7, puddles: true });
  const gr = grate(r0);
  const grateMat = lib.plain({ map: gr.map, bumpMap: gr.bump, bumpScale: 4, roughness: 0.6, metalness: 0.4 }, { porosity: 0.1 });
  const holeMat = lib.plain({ color: '#030303', roughness: 1 }, { porosity: 0 });
  const slabMat = lib.get('concrete_old', { tint: '#a8a49c', macro: 0.3, puddles: true });
  const lids = ['', cwb ? 'SANEPAR' : 'SABESP', 'TELEFONICA', 'GAS'].map(l => {
    const { map, bump } = concreteLid(r0, l);
    return lib.plain({ map, bumpMap: bump, bumpScale: 2, roughness: 0.85 }, { porosity: 0.5, puddles: true });
  });

  // ---- manholes (planned earlier by planManholes, the road mesh has holes for them)
  for (const mh of ctx.manholes || []) {
    const surf = ctx.roadSurf(mh.x, mh.z);
    const top = surf - mh.sink;
    const lid = new THREE.CylinderGeometry(mh.r, mh.r, 0.08, 40);
    lid.translate(mh.x, top - 0.04, mh.z);
    B.add('manhole', coverMats[mh.kind % coverMats.length], lid);
    // patched ring sloping from the road surface into the cover
    B.add('manholeRing', ringMat, coverRing(mh.x, mh.z, mh.r - 0.005, mh.rr + 0.02, () => top + 0.002, (p) => ctx.roadSurf(p[0], p[1])));
    (ctx.spots ||= []).push({ kind: 'manhole', x: mh.x, z: mh.z });
  }

  for (const road of layout.roads) {
    if (!road.pts.some(p => near(p[0], p[1], 120))) continue;
    const pr = rng.fork('drains' + road.pts[0].join());


    // ---- curb inlets near street ends and along the curb
    if (road.sw < 0.8 || road.cls === 'service') continue;
    const spots = [];
    for (const side of [-1, 1]) {
      for (const s of [pr.float(6, 11), road.len - pr.float(6, 11)]) if (s > 0 && s < road.len && pr.chance(0.7)) spots.push([s, side]);
      for (let s = pr.float(20, 40); s < road.len - 15; s += pr.float(35, 70)) if (pr.chance(0.6)) spots.push([s, side]);
    }
    for (const [s, side] of spots) {
      const q = pointAt(road.pts, s);
      const off = side * road.w / 2;
      const ex = q.x - q.dz * off, ez = q.z + q.dx * off;   // curb line
      if (!near(ex, ez, 90)) continue;
      // there must be a sidewalk behind, and no driveway ramp here
      const ox = -q.dz * side, oz = q.dx * side;            // from road toward sidewalk
      if (!layout.regions.sidewalk.contains(ex + ox * 0.4, ez + oz * 0.4)) continue;
      if ((ctx.ramps || []).some(rp => Math.hypot(rp.x - ex, rp.z - ez) < rp.w / 2 + 2)) continue;
      const len = pr.float(0.8, 1.2);
      const road0 = ctx.roadSurf(ex - ox * 0.05, ez - oz * 0.05);
      const sw0 = ctx.sidewalkY(ex + ox * 0.3, ez + oz * 0.3);
      const openH = Math.max(0.05, (sw0 - road0) - 0.04);
      // dark mouth in the curb face, facing the road
      const mouth = new THREE.PlaneGeometry(len, openH);
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(-oz, 0, ox), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-ox, 0, -oz));
      m.setPosition(ex - ox * 0.004, road0 + openH / 2 + 0.005, ez - oz * 0.004);
      B.add('inletMouth', holeMat, mouth, m);
      (ctx.spots ||= []).push({ kind: 'inlet', x: ex, z: ez, ox, oz });
      // concrete slab over the box on the sidewalk
      const sx = ex + ox * 0.45, sz = ez + oz * 0.45;
      B.add('inletSlab', slabMat, boxGeometry(len + 0.3, 0.05, 0.7), frameMatrix(sx, ctx.sidewalkY(sx, sz) + 0.012 + pr.float(-0.01, 0.02), sz, q.dx, q.dz));
      // grate in the gutter on some
      if (pr.chance(0.45)) {
        const gx = ex - ox * 0.22, gz = ez - oz * 0.22;
        const plane = new THREE.PlaneGeometry(len, 0.35).rotateX(-Math.PI / 2);
        B.add('grate', grateMat, plane, frameMatrix(gx, ctx.roadSurf(gx, gz) + 0.006, gz, q.dx, q.dz));
      }
    }

    // ---- concrete boxes on the sidewalk (water meter, telecom, gas)
    for (const side of [-1, 1]) {
      for (let s = pr.float(5, 25); s < road.len; s += pr.float(15, 40)) {
        if (!pr.chance(0.5)) continue;
        const q = pointAt(road.pts, s);
        const off = side * (road.w / 2 + Math.min((side > 0 ? road.swR : road.swL) * 0.7, pr.float(0.4, 1.2)));
        const x = q.x - q.dz * off, z = q.z + q.dx * off;
        if (!near(x, z, 80) || !layout.regions.sidewalk.contains(x, z)) continue;
        const big = pr.chance(0.3);
        const w = big ? 0.6 : 0.4, d = big ? 0.9 : 0.4;
        const lidGeo = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
        B.add('lid', pr.pick(lids), lidGeo, frameMatrix(x, ctx.sidewalkY(x, z) + 0.006 + pr.float(-0.01, 0.015), z, q.dx, q.dz));
      }
    }
  }
}

// Manhole positions, decided before the carriageway is meshed.
export function planManholes(ctx) {
  const { layout, rng, focus } = ctx;
  const out = [];
  for (const road of layout.roads) {
    if (!road.pts.some(p => Math.hypot(p[0] - focus[0], p[1] - focus[1]) < 120)) continue;
    const pr = rng.fork('manholes' + road.pts[0].join());
    const n = Math.max(1, Math.floor(road.len / pr.float(25, 55)));
    for (let i = 0; i < n; i++) {
      const q = pointAt(road.pts, pr.float(0, road.len));
      if (Math.hypot(q.x - focus[0], q.z - focus[1]) > 95) continue;
      // mostly in the wheel paths or on the centerline
      const lane = pr.weighted([[0, 2], [road.w * 0.25, 2], [-road.w * 0.25, 2], [pr.float(-road.w / 2 + 1, road.w / 2 - 1), 1]]);
      const x = q.x - q.dz * lane, z = q.z + q.dx * lane;
      const r = pr.weighted([[0.33, 3], [0.4, 1.5], [0.3, 1]]);
      out.push({
        x, z, r, rr: r + pr.float(0.2, 0.45),
        sink: pr.weighted([[pr.float(0.01, 0.035), 3], [-pr.float(0.005, 0.02), 1.2], [0, 1]]),
        kind: pr.int(0, 4),
      });
    }
  }
  return out;
}
