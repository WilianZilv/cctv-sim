// Weathering layers on top of the clean base scene.
//
// Layer 1 - dirt map: a top-down texture over the block, painted from the street
//   layout, that every material reads by world x/z (see matlib.js):
//     R  dirt / sediment  (curb line, gutter, wall bases, corners, around poles)
//     G  tyre wear        (wheel paths, driveway tracks: darker and polished)
//     B  damp / moss      (shaded wall bases, gutters, under trees)
//     A  dirt colour      (0 cement dust, .33 dry sand, .66 red soil, 1 black grime)
//   tyre wear and oil drips share G.
//   plus a ground-height texture so vertical surfaces know how high above the
//   ground a pixel is (splash and rising damp at the foot of every wall, curb, pole).
// Layer 2 - weeds: instanced tufts in slab joints, along the curb, in the gutter,
//   at wall bases, around poles and trees, and over vacant lots.
// Layer 3 - asphalt marks: sealed cracks (tar snakes), skid marks, paint drips.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { pointAt, polyLength, offsetLine } from '../core/geom.js';
import { Batcher } from './mesh.js';
import { globalUniforms } from '../tex/matlib.js';

const RES = 3072;

export function buildGrime(ctx) {
  let t = performance.now();
  const dirt = buildDirtMap(ctx);
  console.log('[sim]  dirt map', Math.round(performance.now() - t), 'ms'); t = performance.now();
  const weeds = buildWeeds(ctx);
  console.log('[sim]  weeds', Math.round(performance.now() - t), 'ms'); t = performance.now();
  const marks = buildMarks(ctx);
  console.log('[sim]  marks', Math.round(performance.now() - t), 'ms');
  return { dispose() { dirt.dispose(); weeds?.geometry.dispose(); } , marks };
}

// ------------------------------------------------------------------ layer 1
function buildDirtMap(ctx) {
  const { layout, gy, rng } = ctx;
  const R = layout.R;
  const k = RES / (2 * R);
  const P = (x, z) => [(x + R) * k, (z + R) * k];
  const r = rng.fork('dirtmap');
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = RES; const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#000'; g.fillRect(0, 0, RES, RES); g.lineCap = 'round'; g.lineJoin = 'round'; return { c, g }; };
  const ch = { dirt: mk(), tyre: mk(), moss: mk(), hue: mk() };
  ch.oil = ch.tyre;
  // default colour: grey dust
  ch.hue.g.fillStyle = 'rgb(40,40,40)'; ch.hue.g.fillRect(0, 0, RES, RES);
  const cityKey = ctx.city;
  const pickHue = (rr) => rr.weighted([[rr.float(0.0, 0.2), 3], [rr.float(0.28, 0.42), 3], [rr.float(0.6, 0.72), cityKey === 'cwb' ? 1.2 : 1.8], [rr.float(0.85, 1.0), 2]]);
  const fillPoly = (gc, pts, style) => { gc.save(); gc.fillStyle = style; gc.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? gc.lineTo(x, y) : gc.moveTo(x, y); }); gc.closePath(); gc.fill(); gc.restore(); };
  const stroke = (g, pts, width, alpha, blur = 0) => {
    if (pts.length < 2) return;
    g.save();
    g.strokeStyle = `rgba(255,255,255,${alpha})`;
    g.lineWidth = Math.max(1, width * k);
    g.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.restore();
  };
  const disc = (g, x, z, rad, alpha, blur = 0) => {
    g.save();
    g.fillStyle = `rgba(255,255,255,${alpha})`;
    const [px, py] = P(x, z);
    g.beginPath(); g.arc(px, py, Math.max(0.6, rad * k), 0, Math.PI * 2); g.fill();
    g.restore();
  };

  // sediment along every curb: thick in the gutter, thinner on the sidewalk side
  for (const ring of layout.regions.carr.rings()) {
    const pts = ring.concat([ring[0]]);
    stroke(ch.dirt.g, pts, 0.45, 0.22, 0.05);
    stroke(ch.moss.g, pts, 0.4, 0.12, 0.2);
  }
  // wall bases and building feet; owners differ in how they keep the front
  for (const lot of layout.lots) {
    // how dirty this stretch of sidewalk is: most fronts are swept, some are filthy
    const lr = lot.rng.fork('neglect');
    const neglect = lot.use === 'vacant' ? lr.float(0.6, 1) : lr.weighted([[lr.float(0, 0.12), 4], [lr.float(0.15, 0.45), 3], [lr.float(0.5, 1), 1.5]]);
    lot.neglect = neglect;
    const hue = pickHue(lr);
    const sw = lot.sw;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const Q = (s, o) => [lot.a[0] + tx * s - nx * o, lot.a[1] + tz * s - nz * o];
    // colour for the whole frontage, sidewalk and the gutter in front of it
    const hv = Math.round(hue * 255);
    fillPoly(ch.hue.g, [Q(-0.2, -0.5), Q(lot.len + 0.2, -0.5), Q(lot.len + 0.2, sw + 0.8), Q(-0.2, sw + 0.8)], `rgb(${hv},${hv},${hv})`);
    // wall base, curb line and the sidewalk itself, each with its own strength
    stroke(ch.dirt.g, lot.front, 0.3 + 0.9 * neglect, 0.15 + 0.7 * neglect, 0.25);
    const curbLine = [Q(0, sw - 0.12), Q(lot.len, sw - 0.12)];
    stroke(ch.dirt.g, curbLine, 0.3 + 0.9 * neglect, lr.float(0.1, 0.3) + 0.6 * neglect, 0.2);
    if (neglect > 0.2) fillPoly(ch.dirt.g, [Q(0, 0), Q(lot.len, 0), Q(lot.len, sw), Q(0, sw)], `rgba(255,255,255,${(neglect * neglect * 0.55).toFixed(3)})`);
    // loose blotches: spilled soil, a pile swept to one side, a muddy patch
    for (let k = 0; k < Math.round(neglect * 6 + lr.float(0, 1.5)); k++) {
      const [bx, bz] = Q(lr.float(0, lot.len), lr.float(0.1, sw));
      // irregular: a cluster of small splats, not a round disc
      const br = lr.float(0.2, 0.8), ba = lr.float(0.2, 0.6);
      for (let q = 0; q < 7; q++) disc(ch.dirt.g, bx + lr.gauss(0, br * 0.6), bz + lr.gauss(0, br * 0.6), br * lr.float(0.15, 0.5), ba);
      // some blotches are a different soil than the rest of the frontage
      if (lr.chance(0.35)) { const v = Math.round(pickHue(lr) * 255); const [px, py] = P(bx, bz); ch.hue.g.fillStyle = `rgb(${v},${v},${v})`; ch.hue.g.beginPath(); ch.hue.g.arc(px, py, lr.float(0.3, 0.9) * k + 1, 0, 6.3); ch.hue.g.fill(); }
    }
    stroke(ch.moss.g, lot.front, 0.4, 0.05 + 0.45 * neglect, 0.15);
    // tyre tracks and oil in front of garages
    for (const g of lot.driveways || []) {
      const cx = lot.a[0] + lot.t[0] * g.s, cz = lot.a[1] + lot.t[1] * g.s;
      const sw = lot.sw + 3.0;
      for (const side of [-0.75, 0.75]) {
        const ox = cx + lot.t[0] * side, oz = cz + lot.t[1] * side;
        stroke(ch.tyre.g, [[ox + lot.n[0] * 2, oz + lot.n[1] * 2], [ox - lot.n[0] * sw, oz - lot.n[1] * sw]], 0.35, 0.5, 0.15);
      }
      if (r.chance(0.6)) disc(ch.oil.g, cx - lot.n[0] * (lot.sw + 1.2), cz - lot.n[1] * (lot.sw + 1.2), r.float(0.3, 0.6), r.float(0.3, 0.7), 0.15);
    }
  }
  for (const b of layout.buildings) stroke(ch.dirt.g, b.outer.concat([b.outer[0]]), 0.5, b.rng ? b.rng.fork('dirt').float(0.05, 0.5) : 0.25, 0.2);
  // poles, trees, bins
  for (const p of ctx.poles || []) { disc(ch.dirt.g, p.x, p.z, 0.45, r.float(0.2, 0.7), 0.15); disc(ch.moss.g, p.x, p.z, 0.3, 0.3, 0.1); }
  for (const t of ctx.treeCanopies || []) { disc(ch.dirt.g, t.x, t.z, 0.9, 0.5, 0.2); disc(ch.moss.g, t.x, t.z, t.r * 1.1, 0.35, t.r * 0.4); }

  // traffic: wheel paths, oil stripe in the middle of each lane, parking strip
  for (const road of layout.roads) {
    if (road.cls === 'service' && road.w < 4.5) continue;
    const lanes = road.oneway ? [0] : [-road.w / 4, road.w / 4];
    for (const lc of lanes) {
      const centre = offsetLine(road.pts, lc);
      for (const w of [-0.85, 0.85]) stroke(ch.tyre.g, offsetLine(centre, w), 0.7, 0.85, 0.2);
      stroke(ch.oil.g, centre, 0.55, 0.6, 0.2);
    }
    // parked cars leak along both curbs
    for (const side of [-1, 1]) {
      const L = road.len;
      for (let s = r.float(0, 4); s < L; s += r.float(2, 6)) {
        const q = pointAt(road.pts, s);
        const off = side * (road.w / 2 - 1.1);
        disc(ch.oil.g, q.x - q.dz * off, q.z + q.dx * off, r.float(0.15, 0.45), r.float(0.15, 0.6), 0.1);
      }
    }
  }
  // speed bumps and stop lines collect rubber
  for (const bump of ctx.bumps || []) {
    const { q, road } = bump;
    for (const d of [-1.5, 1.5]) {
      const x = q.x + q.dx * d, z = q.z + q.dz * d;
      stroke(ch.tyre.g, [[x - q.dz * road.w / 2, z + q.dx * road.w / 2], [x + q.dz * road.w / 2, z - q.dx * road.w / 2]], 1.2, 0.4, 0.4);
    }
  }

  // pack into one RGBA float texture
  // one soft blur per channel (about 25 cm), then the four canvases are packed into
  // one RGBA render target on the GPU (no pixel readback)
  const blurred = (o) => {
    const t = document.createElement('canvas'); t.width = t.height = RES;
    const tg = t.getContext('2d');
    tg.filter = `blur(${(0.25 * k).toFixed(1)}px)`;
    tg.drawImage(o.c, 0, 0);
    const ct = new THREE.CanvasTexture(t);
    ct.colorSpace = THREE.NoColorSpace; ct.flipY = false; ct.generateMipmaps = false; ct.minFilter = THREE.NearestFilter; ct.magFilter = THREE.NearestFilter;
    return ct;
  };
  const srcs = [blurred(ch.dirt), blurred(ch.tyre), blurred(ch.moss), blurred(ch.hue)];
  const rt = new THREE.WebGLRenderTarget(RES, RES, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const pack = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { t0: { value: srcs[0] }, t1: { value: srcs[1] }, t2: { value: srcs[2] }, t3: { value: srcs[3] } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D t0, t1, t2, t3; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(t0, vUv).r, texture2D(t1, vUv).r, texture2D(t2, vUv).r, texture2D(t3, vUv).r); }',
    depthTest: false, depthWrite: false,
  }));
  const rr = ctx.renderer;
  const prevRT = rr.getRenderTarget();
  rr.setRenderTarget(rt); pack.render(rr); rr.setRenderTarget(prevRT);
  pack.material.dispose(); pack.dispose();
  for (const t of srcs) t.dispose();
  const tex = rt.texture;

  // ground height (incl. sidewalk) for vertical grime
  const GR = 256;
  // half float: filterable everywhere (linear filtering of 32-bit float needs an extension)
  const gh = new Uint16Array(GR * GR * 4);
  for (let j = 0; j < GR; j++) for (let i = 0; i < GR; i++) {
    const x = -R + (i + 0.5) / GR * 2 * R, z = -R + (j + 0.5) / GR * 2 * R;
    gh[(j * GR + i) * 4] = THREE.DataUtils.toHalfFloat(gy(x, z) + 0.15);
  }
  const gtex = new THREE.DataTexture(gh, GR, GR, THREE.RGBAFormat, THREE.HalfFloatType);
  gtex.minFilter = THREE.LinearFilter; gtex.magFilter = THREE.LinearFilter; gtex.needsUpdate = true;

  const u = globalUniforms;
  u.uDirtMap.value = tex;
  u.uGroundTex.value = gtex;
  u.uDirtRect.value.set(-R, -R, 2 * R, 2 * R);
  u.uDirtAmt.value = ctx.cfg?.grime?.amount ?? 1;
  return { dispose() { rt.dispose(); gtex.dispose(); u.uDirtAmt.value = 0; } };
}

// ------------------------------------------------------------------ layer 2
function buildWeeds(ctx) {
  const { layout, lib, rng, focus } = ctx;
  const r = rng.fork('weeds2');
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const list = []; // [x, y, z, size, rot, dry]
  const add = (x, z, y, size, dry) => list.push([x, y, z, size, r.float(0, Math.PI), dry ? 1 : 0]);
  const swY = ctx.sidewalkY, rdY = ctx.roadSurf;
  const amt = ctx.cfg?.grime?.weeds ?? 1;

  // curb joint (sidewalk side) and gutter (road side)
  for (const ring of layout.regions.carr.rings()) {
    const pts = ring.concat([ring[0]]);
    const L = polyLength(pts);
    for (let s = 0; s < L; s += 0.25) {
      const q = pointAt(pts, s);
      if (!near(q.x, q.z, 90)) continue;
      const nx = -q.dz, nz = q.dx;
      const inSw = layout.regions.sidewalk.contains(q.x + nx * 0.3, q.z + nz * 0.3);
      const sgn = inSw ? 1 : -1;
      if (!layout.regions.sidewalk.contains(q.x + nx * 0.3 * sgn, q.z + nz * 0.3 * sgn)) continue;
      // the sidewalk/curb joint
      if (r.chance(0.16 * amt)) { const x = q.x + nx * sgn * 0.17, z = q.z + nz * sgn * 0.17; add(x, z, swY(x, z), r.float(0.06, 0.22), r.chance(0.45)); }
      // the asphalt/gutter joint
      if (r.chance(0.1 * amt)) { const x = q.x - nx * sgn * r.float(0.03, 0.4), z = q.z - nz * sgn * r.float(0.03, 0.4); add(x, z, rdY(x, z), r.float(0.05, 0.18), r.chance(0.6)); }
    }
  }
  // wall bases, slab joints and vacant lots, scaled by how neglected each front is
  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 90)) continue;
    const ng = lot.neglect ?? 0.5;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    for (let s = 0; s < lot.len; s += 0.2) {
      if (lot.gates.some(g => Math.abs(g.s - s) < g.w / 2)) continue;
      if (!r.chance((0.05 + 0.35 * ng * ng) * amt)) continue;
      const o = r.float(0.02, 0.12);
      const x = lot.a[0] + tx * s - nx * o, z = lot.a[1] + tz * s - nz * o;
      add(x, z, swY(x, z), r.float(0.08, 0.4) * (0.6 + ng), r.chance(0.35));
    }
    // sidewalk slab joints: grid aligned with the lot, 1-1.5 m slabs
    const slab = r.float(1.0, 1.5);
    const sw = lot.sw;
    for (let s = slab; s < lot.len; s += slab) {
      for (let o = 0.2; o < sw - 0.1; o += 0.18) {
        if (!r.chance((0.02 + 0.2 * ng) * amt)) continue;
        const x = lot.a[0] + tx * s - nx * o, z = lot.a[1] + tz * s - nz * o;
        add(x, z, swY(x, z), r.float(0.05, 0.16), r.chance(0.4));
      }
    }
    for (let o = slab * 0.7; o < sw - 0.2; o += slab) {
      for (let s = 0.1; s < lot.len; s += 0.18) {
        if (!r.chance((0.015 + 0.15 * ng) * amt)) continue;
        const x = lot.a[0] + tx * s - nx * o, z = lot.a[1] + tz * s - nz * o;
        add(x, z, swY(x, z), r.float(0.05, 0.14), r.chance(0.4));
      }
    }
    if (lot.use === 'vacant') {
      for (let n = 0; n < Math.min(140, lot.len * lot.depth * 0.6); n++) {
        const s = r.float(0.2, lot.len - 0.2), d = r.float(0.3, Math.min(lot.depth, 14));
        const x = lot.a[0] + tx * s + nx * d, z = lot.a[1] + tz * s + nz * d;
        add(x, z, ctx.gy(x, z) + 0.17, r.float(0.35, 1.1), r.chance(0.5));
      }
    }
  }
  for (const p of ctx.poles || []) {
    if (!near(p.x, p.z, 80)) continue;
    for (let n = 0; n < r.int(2, 9) * amt; n++) { const a = r.float(0, 6.3), d = r.float(0.12, 0.3); const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d; add(x, z, swY(x, z), r.float(0.1, 0.35), r.chance(0.4)); }
  }
  // grass never ends in a straight line: tufts spill over the edges of every
  // grass area (sidewalk strips, grass front yards) onto the paving next to it
  const edgeRow = (pts, density, size, inside) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nx = -(b[1] - a[1]) / (L || 1), nz = (b[0] - a[0]) / (L || 1);
      for (let s = 0; s < L; s += 1 / density) {
        const o = r.gauss(0.04, 0.09) * inside;
        const x = a[0] + (b[0] - a[0]) * s / L + nx * o, z = a[1] + (b[1] - a[1]) * s / L + nz * o;
        add(x, z, swY(x, z), size * r.float(0.5, 1.3), r.chance(0.2));
      }
    }
  };
  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 90)) continue;
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const Q = (s, o) => [lot.a[0] + tx * s - nx * o, lot.a[1] + tz * s - nz * o];
    if (lot.grassEdge) {
      // both long edges of the grass strip
      edgeRow([Q(0, lot.grassEdge.from), Q(lot.len, lot.grassEdge.from)], 12 * amt, 0.24, -1);
      edgeRow([Q(0, lot.grassEdge.to - 0.05), Q(lot.len, lot.grassEdge.to - 0.05)], 9 * amt, 0.2, 1);
    }
    if (lot.yardKind === 'grass' && lot.setback > 1.2) {
      const P = (s, o) => [lot.a[0] + tx * s + nx * o, lot.a[1] + tz * s + nz * o];
      edgeRow([P(0, 0.15), P(lot.len, 0.15)], 6 * amt, 0.25, 1);
    }
  }
  for (const t of ctx.trees || []) {
    if (!near(t.x, t.z, 80)) continue;
    for (let n = 0; n < r.int(3, 12) * amt; n++) { const x = t.x + r.float(-0.45, 0.45), z = t.z + r.float(-0.45, 0.45); add(x, z, swY(x, z), r.float(0.1, 0.4), r.chance(0.3)); }
  }
  if (!list.length) return null;

  // one tuft = two crossed cards with up-facing normals
  const cards = [];
  for (const a of [0, Math.PI / 2]) {
    const p = new THREE.PlaneGeometry(1, 0.9).translate(0, 0.42, 0).rotateY(a).toNonIndexed();
    cards.push(p);
  }
  const pos = [], uv = [], nrm = [];
  for (const c of cards) { pos.push(...c.attributes.position.array); uv.push(...c.attributes.uv.array); for (let i = 0; i < c.attributes.position.count; i++) nrm.push(0, 1, 0); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));

  const meshes = [];
  for (const dry of [0, 1]) {
    const items = list.filter(l => l[5] === dry);
    if (!items.length) continue;
    const mat = lib.get(dry ? 'weeds_dry' : 'weeds', { side: THREE.DoubleSide, porosity: 0.2, irGain: dry ? 2.2 : 3, ao: false, pom: false, dirt: 0 });
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    items.forEach(([x, y, z, s, rot], i) => {
      e.set(r.gauss(0, 0.12), rot, r.gauss(0, 0.12));
      m.compose(new THREE.Vector3(x, y - 0.01, z), q.setFromEuler(e), new THREE.Vector3(s, s * r.float(0.7, 1.2), s));
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = 'weeds';
    ctx.group.add(im);
    meshes.push(im);
  }
  return meshes[0];
}

// ------------------------------------------------------------------ layer 3
function buildMarks(ctx) {
  const { layout, lib, rng, group, focus } = ctx;
  const r = rng.fork('marks');
  const B = new Batcher();
  const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d * (ctx.detail ?? 1);
  const ribbon = (pts, half, lift) => {
    const pos = [], uv = [];
    const L = polyLength(pts);
    const n = Math.max(1, Math.ceil(L / 0.25));
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const q = pointAt(pts, L * i / n);
      const w = half * (0.7 + 0.6 * Math.sin(i * 1.7) * 0.5);
      const a = [q.x - q.dz * w, q.z + q.dx * w], b = [q.x + q.dz * w, q.z - q.dx * w];
      if (prev) for (const v of [prev[0], b, prev[1], prev[0], a, b]) { pos.push(v[0], ctx.roadSurf(v[0], v[1]) + lift, v[1]); uv.push(v[0], v[1]); }
      prev = [a, b];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const nrm = new Float32Array(pos.length); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return g;
  };
  const decal = (opts) => {
    const m = lib.plain({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide, ...opts.p }, { porosity: 0.1, paintWear: opts.wear, spec: opts.spec, dirt: 0 });
    m.userData.noShadow = true;
    return m;
  };
  // crack sealant: a dull sheen (it glared white at grazing angles when glossy)
  const tar = decal({ p: { color: '#070707', roughness: 0.6 }, wear: 0.15, spec: 0.7 });
  const skid = decal({ p: { color: '#0b0b0b', roughness: 0.6, opacity: 0.45 }, wear: 0.4, spec: 0.6 });
  const drip = decal({ p: { color: '#d8d6cc', roughness: 0.6, opacity: 0.8 }, wear: 0.5, spec: 0.6 });
  const crack = decal({ p: { color: '#0d0c0b', roughness: 0.95, opacity: 0.75 }, wear: 0.12, spec: 0.2 });
  const holeMat = lib.get('asphalt_old', { tint: '#5c5a57', macro: 0.4, porosity: 0.9, puddles: true, dirt: 0, pom: false, side: THREE.DoubleSide });
  holeMat.polygonOffset = true; holeMat.polygonOffsetFactor = -3; holeMat.polygonOffsetUnits = -3;
  const gravel = lib.plain({ color: '#3a3836', roughness: 0.9 }, { porosity: 0.5, dirt: 0 });
  // irregular blob outline around (cx, cz)
  const blob = (cx, cz, rad, n = 14) => {
    const pts = [];
    const ph = r.float(0, 6);
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      const rr = rad * (0.65 + 0.35 * Math.sin(a * 2 + ph) * 0.6 + r.float(0, 0.4));
      pts.push([cx + Math.cos(a) * rr, cz + Math.sin(a) * rr]);
    }
    return pts;
  };
  // pothole: broken asphalt bowl a few cm deep with crumbled edges and loose gravel
  const pothole = (cx, cz, rad) => {
    const ring = blob(cx, cz, rad);
    const pos = [], uv = [];
    const depth = r.float(0.03, 0.07);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const A = [a[0], ctx.roadSurf(a[0], a[1]) + 0.004, a[1]], Bv = [b[0], ctx.roadSurf(b[0], b[1]) + 0.004, b[1]];
      const C = [cx, ctx.roadSurf(cx, cz) - depth, cz];
      for (const v of [A, C, Bv]) { pos.push(...v); uv.push(v[0], v[2]); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const nn = g.attributes.normal; for (let i = 0; i < nn.count; i++) if (nn.getY(i) < 0) nn.setXYZ(i, -nn.getX(i), -nn.getY(i), -nn.getZ(i));
    B.add('pothole', holeMat, g);
    for (let k = 0; k < r.int(4, 14); k++) {
      const a = r.float(0, 6.3), d = rad * r.float(0.6, 1.8);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, sz = r.float(0.015, 0.05);
      const gg = new THREE.DodecahedronGeometry(sz, 0);
      gg.translate(x, ctx.roadSurf(x, z) + sz * 0.4, z);
      B.add('gravel', gravel, gg);
    }
  };
  // open crack: wandering line that sometimes forks
  const openCrack = (x, z, ang, len, width) => {
    const pts = [[x, z]];
    const base = ang;
    for (let d = 0; d < len; d += 0.07) {
      ang = base + r.gauss(0, 0.7);
      x += Math.cos(ang) * 0.07; z += Math.sin(ang) * 0.07;
      if (!layout.regions.carr.contains(x, z)) break;
      pts.push([x, z]);
      if (r.chance(0.04) && len > 1) openCrack(x, z, ang + r.sign() * r.float(0.5, 1.2), len * 0.4, width * 0.7);
    }
    if (pts.length > 2) B.add('crack', crack, ribbon(pts, width, 0.008));
  };

  for (const road of layout.roads) {
    if (!road.pts.some(p => near(p[0], p[1], 110))) continue;
    const L = road.len;
    // tar snakes: crack sealing, wandering lines along and across the road
    const nSnakes = Math.floor(L / r.float(6, 14) * (road.asphalt === 'asphalt_new' ? 0.3 : 1));
    for (let i = 0; i < nSnakes; i++) {
      const s0 = r.float(0, L);
      const q = pointAt(road.pts, s0);
      if (!near(q.x, q.z, 100)) continue;
      const off = r.float(-road.w / 2 + 0.3, road.w / 2 - 0.3);
      let x = q.x - q.dz * off, z = q.z + q.dx * off;
      const across = r.chance(0.35);
      let ang = Math.atan2(q.dz, q.dx) + (across ? Math.PI / 2 : 0) + r.gauss(0, 0.2);
      const pts = [[x, z]];
      const len = r.float(1.5, 9);
      for (let d = 0; d < len; d += 0.3) {
        ang += r.gauss(0, 0.25);
        x += Math.cos(ang) * 0.3; z += Math.sin(ang) * 0.3;
        if (!layout.regions.carr.contains(x, z)) break;
        pts.push([x, z]);
      }
      if (pts.length > 2) B.add('tar', tar, ribbon(pts, r.float(0.018, 0.04), 0.009));
    }
    // potholes and open cracks: old asphalt breaks up mostly in the wheel paths and
    // along the gutter
    const wear = road.asphalt === 'asphalt_new' ? 0.15 : road.asphalt === 'asphalt_patchy' ? 1.2 : 0.8;
    for (let i = 0; i < Math.floor(L / r.float(12, 30) * wear); i++) {
      const q = pointAt(road.pts, r.float(0, L));
      if (!near(q.x, q.z, 100)) continue;
      const off = r.weighted([[road.w / 2 - r.float(0.4, 0.9), 2], [-road.w / 2 + r.float(0.4, 0.9), 2], [r.sign() * road.w / 4 + r.gauss(0, 0.4), 2], [r.float(-road.w / 2, road.w / 2), 1]]);
      const x = q.x - q.dz * off, z = q.z + q.dx * off;
      if (!layout.regions.carr.contains(x, z)) continue;
      pothole(x, z, r.float(0.12, 0.45));
      if (r.chance(0.6)) openCrack(x, z, r.float(0, 6.3), r.float(0.8, 3), r.float(0.008, 0.02));
    }
    for (let i = 0; i < Math.floor(L / r.float(3, 8) * wear); i++) {
      const q = pointAt(road.pts, r.float(0, L));
      if (!near(q.x, q.z, 100)) continue;
      const off = r.float(-road.w / 2 + 0.2, road.w / 2 - 0.2);
      openCrack(q.x - q.dz * off, q.z + q.dx * off, Math.atan2(q.dz, q.dx) + (r.chance(0.5) ? Math.PI / 2 : 0) + r.gauss(0, 0.3), r.float(0.5, 4), r.float(0.006, 0.016));
    }
    // skid marks near street ends and bumps
    const ends = [pointAt(road.pts, Math.min(L, 10)), pointAt(road.pts, Math.max(0, L - 10))];
    for (const b of ctx.bumps || []) if (b.road === road) ends.push(b.q);
    for (const q of ends) {
      if (!near(q.x, q.z, 100) || !r.chance(0.6)) continue;
      const lane = road.oneway ? 0 : r.sign() * road.w / 4;
      const len = r.float(2, 9), bend = r.gauss(0, 0.08);
      for (const w of [-0.75, 0.75]) {
        const pts = [];
        for (let d = 0; d <= len; d += 0.4) {
          const s = d - len;
          const qx = q.x + q.dx * s - q.dz * (lane + w + bend * d * d * 0.1), qz = q.z + q.dz * s + q.dx * (lane + w + bend * d * d * 0.1);
          pts.push([qx, qz]);
        }
        B.add('skid', skid, ribbon(pts, 0.09, 0.008));
      }
    }
    // paint drips: a trail of white drops from a leaking can
    if (r.chance(0.25)) {
      let s = r.float(0, L);
      const off = r.float(-road.w / 2 + 0.5, road.w / 2 - 0.5);
      for (let k = 0; k < r.int(15, 60); k++) {
        s += r.float(0.2, 0.9);
        if (s > L) break;
        const q = pointAt(road.pts, s);
        const x = q.x - q.dz * off + r.gauss(0, 0.05), z = q.z + q.dx * off + r.gauss(0, 0.05);
        if (!near(x, z, 100)) continue;
        const g = new THREE.CircleGeometry(r.float(0.01, 0.04), 8).rotateX(-Math.PI / 2);
        g.translate(x, ctx.roadSurf(x, z) + 0.01, z);
        B.add('drip', drip, g);
      }
    }
  }
  // ---- broken sidewalks: cracked slabs, holes down to the soil, lifted or sunken
  // pieces, more of it in front of neglected lots
  const soilMat = lib.get('soil', { tint: '#a8988a', macro: 0.4, porosity: 0.8, puddles: true, dirt: 0, pom: false, side: THREE.DoubleSide });
  const fragMat = lib.get('concrete_old', { tint: '#b8b4ac', pom: false });
  soilMat.polygonOffset = true; soilMat.polygonOffsetFactor = -3; soilMat.polygonOffsetUnits = -3;
  const swCrack = decal({ p: { color: '#1c1a17', roughness: 0.95, opacity: 0.6 }, wear: 0.15, spec: 0.2 });
  const slabMats = new Map();
  const swRibbon = (pts, half) => {
    const pos = [], uv = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l * half, nz = dx / l * half;
      const q = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
      for (const v of [q[0], q[2], q[1], q[0], q[3], q[2]]) { pos.push(v[0], ctx.sidewalkY(v[0], v[1]) + 0.006, v[1]); uv.push(v[0], v[1]); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const nrm = new Float32Array(pos.length); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return geo;
  };
  for (const lot of layout.lots) {
    if (!near(lot.c[0], lot.c[1], 90) || lot.sw < 1) continue;
    const ng = lot.neglect ?? 0.3;
    const lr = lot.rng.fork('brokensw');
    const [tx, tz] = lot.t, [nx, nz] = lot.n;
    const Q = (s, o) => [lot.a[0] + tx * s - nx * o, lot.a[1] + tz * s - nz * o];
    const sw = lot.sw;
    // cracks across and along the slabs
    for (let i = 0; i < Math.round(lr.float(0, 4) + ng * 10); i++) {
      let [x, z] = Q(lr.float(0, lot.len), lr.float(0.1, sw - 0.1));
      let ang = lr.chance(0.5) ? Math.atan2(tz, tx) : Math.atan2(-nz, -nx);
      const pts = [[x, z]];
      for (let d = 0; d < lr.float(0.4, 2.2); d += 0.06) { const a2 = ang + lr.gauss(0, 0.6); x += Math.cos(a2) * 0.06; z += Math.sin(a2) * 0.06; if (!layout.regions.sidewalk.contains(x, z)) break; pts.push([x, z]); }
      if (pts.length > 3) B.add('swcrack', swCrack, swRibbon(pts, lr.float(0.0025, 0.006)));
    }
    if (!lr.chance(0.3 + 0.7 * ng)) continue;
    // holes where a slab broke out: soil showing, with loose fragments
    for (let i = 0; i < lr.int(1, 1 + Math.round(ng * 3)); i++) {
      const [cx, cz] = Q(lr.float(0.3, lot.len - 0.3), lr.float(0.3, sw - 0.3));
      if (!layout.regions.sidewalk.contains(cx, cz)) continue;
      const rad = lr.float(0.15, 0.5);
      const ring = blob(cx, cz, rad, 12);
      const pos = [], uv = [];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        for (const v of [[cx, cz], a, b]) { pos.push(v[0], ctx.sidewalkY(v[0], v[1]) - (v === a || v === b ? -0.004 : 0.012), v[1]); uv.push(v[0], v[1]); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const nn = new Float32Array(pos.length); for (let k = 1; k < nn.length; k += 3) nn[k] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      B.add('swhole', soilMat, geo);
      // broken edge of the paving around the hole
      B.add('swcrack', swCrack, swRibbon(ring.concat([ring[0]]), 0.012));
      for (let k = 0; k < lr.int(1, 4); k++) {
        const a3 = lr.float(0, 6.3), d = rad * lr.float(0.3, 1.4), sz = lr.float(0.03, 0.09);
        const x = cx + Math.cos(a3) * d, z = cz + Math.sin(a3) * d;
        const gg = new THREE.BoxGeometry(sz * 1.6, sz * 0.5, sz);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, ctx.sidewalkY(x, z) + sz * 0.2, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(lr.gauss(0, 0.3), lr.float(0, 6), lr.gauss(0, 0.3))), new THREE.Vector3(1, 1, 1));
        B.add('swfrag', fragMat, gg, m);
      }
    }
    // a slab lifted by a root or sunk: a tilted piece of the same pavement
    if (lr.chance(0.4 + 0.4 * ng)) {
      const [cx, cz] = Q(lr.float(0.5, lot.len - 0.5), lr.float(0.4, sw - 0.4));
      if (layout.regions.sidewalk.contains(cx, cz)) {
        const key = lot.sidewalkMat;
        if (!slabMats.has(key)) slabMats.set(key, lib.get(key === 'petitpave' ? 'petitpave_0' : key === 'grass_strip' ? 'concrete' : key, { macro: 0.3, porosity: 0.6, pom: false }));
        const w = lr.float(0.5, 1.1), d = lr.float(0.4, Math.min(1.0, sw - 0.2));
        const geo = new THREE.BoxGeometry(w, 0.06, d);
        const uvA = geo.attributes.uv; for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) * w, uvA.getY(k) * d);
        const lift = lr.chance(0.6) ? lr.float(0.02, 0.07) : -lr.float(0.01, 0.03);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, ctx.sidewalkY(cx, cz) - 0.03 + lift, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(lr.gauss(0, 0.06), Math.atan2(-tz, tx), lr.gauss(0, 0.06))), new THREE.Vector3(1, 1, 1));
        B.add('swslab' + key, slabMats.get(key), geo, m);
      }
    }
  }
  return B.build(group, { castShadow: false });
}
