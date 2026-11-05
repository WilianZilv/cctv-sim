// Geometry helpers: polygon triangulation draped over terrain, wall strips,
// boxes in arbitrary frames, and a batcher that merges geometry per material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Triangulate ExPolygons, subdivide long edges, then drape with yFn.
// uvFn(x, z) -> [u, v] in meters.
// Numeric key for a ground position (1 mm grid); string keys were the main cost here.
const pkey = (x, z) => (Math.round(x * 1000) + 2097152) * 4194304 + (Math.round(z * 1000) + 2097152);

export function polyGeometry(expolys, { yFn, uvFn, maxEdge = 2.5, normalUp = true }) {
  // every subdivided vertex is shared by ~6 triangles: evaluate height/uv once and
  // give it an index, so normals can be accumulated per vertex without a second lookup
  const cache = new Map();
  const vx = [], vy = [], vz = [], vu = [], vv = [];
  const tri = [];
  const vert = (x, z) => {
    const k = pkey(x, z);
    let i = cache.get(k);
    if (i === undefined) {
      i = vx.length;
      const w = uvFn(x, z);
      vx.push(x); vy.push(yFn(x, z)); vz.push(z); vu.push(w[0]); vv.push(w[1]);
      cache.set(k, i);
    }
    return i;
  };
  const emit = (p, q, r) => {
    // keep counter-clockwise when seen from above (+y): x-east, z-south
    const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (cross < 0) tri.push(vert(p[0], p[1]), vert(q[0], q[1]), vert(r[0], r[1]));
    else tri.push(vert(p[0], p[1]), vert(r[0], r[1]), vert(q[0], q[1]));
  };
  for (const ex of expolys) {
    if (ex.outer.length < 3) continue;
    const contour = ex.outer.map(p => new THREE.Vector2(p[0], p[1]));
    const holes = ex.holes.filter(h => h.length >= 3).map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
    const all = contour.concat(...holes);
    for (const t of tris) {
      const A = all[t[0]], B = all[t[1]], C = all[t[2]];
      subdivide([A.x, A.y], [B.x, B.y], [C.x, C.y], maxEdge, emit, 0);
    }
  }
  const n = tri.length;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let t = 0; t < n; t++) {
    const i = tri[t];
    pos[t * 3] = vx[i]; pos[t * 3 + 1] = vy[i]; pos[t * 3 + 2] = vz[i];
    uv[t * 2] = vu[i]; uv[t * 2 + 1] = vv[i];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (normalUp) {
    // smooth normals: area-weighted average of the faces sharing each vertex
    // (flat per-triangle normals make the uneven ground look faceted)
    const acc = new Float32Array(vx.length * 3);
    for (let t = 0; t < n; t += 3) {
      const i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
      const ax = vx[i1] - vx[i0], ay = vy[i1] - vy[i0], az = vz[i1] - vz[i0];
      const bx = vx[i2] - vx[i0], by = vy[i2] - vy[i0], bz = vz[i2] - vz[i0];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (const i of [i0, i1, i2]) { acc[i * 3] += nx; acc[i * 3 + 1] += ny; acc[i * 3 + 2] += nz; }
    }
    const nrm = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      const i = tri[t] * 3;
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
      nrm[t * 3] = acc[i] / l; nrm[t * 3 + 1] = acc[i + 1] / l; nrm[t * 3 + 2] = acc[i + 2] / l;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  } else g.computeVertexNormals();
  return g;
}

function subdivide(a, b, c, maxEdge, emit, depth) {
  const lab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const lbc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2;
  const lca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
  const m = Math.max(lab, lbc, lca);
  if (m <= maxEdge * maxEdge || depth > 12) { emit(a, b, c); return; }
  if (m === lab) { const p = mid(a, b); subdivide(a, p, c, maxEdge, emit, depth + 1); subdivide(p, b, c, maxEdge, emit, depth + 1); }
  else if (m === lbc) { const p = mid(b, c); subdivide(a, b, p, maxEdge, emit, depth + 1); subdivide(a, p, c, maxEdge, emit, depth + 1); }
  else { const p = mid(c, a); subdivide(a, b, p, maxEdge, emit, depth + 1); subdivide(p, b, c, maxEdge, emit, depth + 1); }
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Vertical strip along a polyline. bottom/top: (x, z, s) -> y. Normal faces `side`
// (+1 = right of travel). u = arc length, v = height above bottom reference.
// rowStep subdivides vertically; warp(x, y, z) -> [dx, dz] bends the wall out of true.
export function wallStrip(pts, { bottom, top, side = 1, step = 1.5, uOffset = 0, vRef, rowStep = 0, warp = null }) {
  const pos = [], uv = [], idx = [];
  let s = uOffset;
  const samples = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
      const t = k / n;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, s + L * t]);
    }
    s += L;
  }
  let rows = 1;
  if (rowStep > 0) {
    const [x, z, u] = samples[0];
    rows = Math.max(1, Math.ceil((top(x, z, u) - bottom(x, z, u)) / rowStep));
  }
  const R = rows + 1;
  for (const [x, z, u] of samples) {
    const yb = bottom(x, z, u), yt = top(x, z, u);
    const ref = vRef ? vRef(x, z, u) : yb;
    for (let j = 0; j < R; j++) {
      const y = yb + (yt - yb) * j / rows;
      const w = warp ? warp(x, y, z) : null;
      pos.push(x + (w ? w[0] : 0), y, z + (w ? w[1] : 0));
      uv.push(u, y - ref);
    }
  }
  for (let i = 0; i < samples.length - 1; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * R + j, b = a + 1, c = a + R, d = c + 1;
      if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

// Box with world-scale UVs (meters) on every face. Placed by matrix.
// Nothing built is a perfect box: edges of anything thicker than a few cm get a
// small rounded bevel (cast concrete, plaster corners, caps).
// The rounded box is RoundedBoxGeometry's construction (2 segments per corner), but
// the per-vertex corner sign and bevel normal do not depend on the box size, so
// they are computed once into a template and each box is a single pass over it.
let _roundTpl = null, _plainTpl = null;
function roundTemplate() {
  if (_roundTpl) return _roundTpl;
  const seg = 5, half = 0.5 / seg;
  const p = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg).toNonIndexed().attributes.position.array;
  const sign = new Float32Array(p.length), nrm = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    let nx = p[i] - Math.sign(p[i]) * half, ny = p[i + 1] - Math.sign(p[i + 1]) * half, nz = p[i + 2] - Math.sign(p[i + 2]) * half;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[i] = nx / l; nrm[i + 1] = ny / l; nrm[i + 2] = nz / l;
    sign[i] = Math.sign(p[i]); sign[i + 1] = Math.sign(p[i + 1]); sign[i + 2] = Math.sign(p[i + 2]);
  }
  return (_roundTpl = { sign, nrm });
}
function plainTemplate() {
  if (_plainTpl) return _plainTpl;
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  return (_plainTpl = { pos: g.attributes.position.array, nrm: g.attributes.normal.array, uv: g.attributes.uv.array });
}

export function boxGeometry(w, h, d, uvScale = 1, bevel = null) {
  const m = Math.min(w, h, d);
  let r = bevel ?? (m >= 0.06 ? Math.min(0.02, m * 0.18) : 0);
  const g = new THREE.BufferGeometry();
  if (r <= 0) {
    const T = plainTemplate();
    const n = T.pos.length;
    const pos = new Float32Array(n), uv = new Float32Array(n / 3 * 2);
    for (let i = 0, j = 0; i < n; i += 3, j += 2) {
      pos[i] = T.pos[i] * w; pos[i + 1] = T.pos[i + 1] * h; pos[i + 2] = T.pos[i + 2] * d;
      const nx = Math.abs(T.nrm[i]), ny = Math.abs(T.nrm[i + 1]);
      let su, sv;
      if (nx > 0.5) { su = d; sv = h; } else if (ny > 0.5) { su = w; sv = d; } else { su = w; sv = h; }
      uv[j] = T.uv[j] * su * uvScale; uv[j + 1] = T.uv[j + 1] * sv * uvScale;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(T.nrm.slice(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }
  r = Math.min(w / 2, h / 2, d / 2, r);
  const T = roundTemplate();
  const n = T.sign.length;
  const bx = w / 2 - r, by = h / 2 - r, bz = d / 2 - r;
  const pos = new Float32Array(n), uv = new Float32Array(n / 3 * 2);
  for (let i = 0, j = 0; i < n; i += 3, j += 2) {
    const nx = T.nrm[i], ny = T.nrm[i + 1], nz = T.nrm[i + 2];
    const x = bx * T.sign[i] + nx * r, y = by * T.sign[i + 1] + ny * r, z = bz * T.sign[i + 2] + nz * r;
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    // planar UVs in meters by the dominant normal axis
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const X = x + w / 2, Y = y + h / 2, Z = z + d / 2;
    if (ax >= ay && ax >= az) { uv[j] = Z * uvScale; uv[j + 1] = Y * uvScale; }
    else if (ay >= az) { uv[j] = X * uvScale; uv[j + 1] = Z * uvScale; }
    else { uv[j] = X * uvScale; uv[j + 1] = Y * uvScale; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(T.nrm.slice(), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// frame matrix: origin (x,y,z), tangent (tx,tz) as local +x, up as +y, normal as +z
export function frameMatrix(x, y, z, tx, tz, yaw = null) {
  const m = new THREE.Matrix4();
  const X = new THREE.Vector3(tx, 0, tz).normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3().crossVectors(X, Y);
  m.makeBasis(X, Y, Z);
  m.setPosition(x, y, z);
  return m;
}

// Builders rarely get things plumb, level and square. Returns a matrix that rotates
// around a pivot (usually the base of the element) by small random angles:
// lean = tilt about the element's own axis, roll = out of level, twist = about vertical.
export function crookMatrix(px, py, pz, tx, tz, r, { lean = 0.5, roll = 0.25, twist = 0.3, shift = 0.01 } = {}) {
  const d = Math.PI / 180;
  const T = new THREE.Vector3(tx, 0, tz).normalize();
  const N = new THREE.Vector3(-tz, 0, tx).normalize();
  const q = new THREE.Quaternion()
    .multiply(new THREE.Quaternion().setFromAxisAngle(T, r.gauss(0, lean) * d))
    .multiply(new THREE.Quaternion().setFromAxisAngle(N, r.gauss(0, roll) * d))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.gauss(0, twist) * d));
  const off = N.clone().multiplyScalar(r.gauss(0, shift));
  const m = new THREE.Matrix4().makeTranslation(px + off.x, py, pz + off.z);
  m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
  m.multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
  return m;
}

// Collects geometry per material key and merges it into few meshes.
const CELL = Infinity;   // cell splitting off: draw calls cost more than the triangles it culls
// Splits a non-indexed triangle soup into one geometry per CELL x CELL square
// (by triangle centroid). Small geometries come back unchanged.
export function splitCells(geo, cell = CELL) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (geo.index || (bb.max.x - bb.min.x < cell * 1.25 && bb.max.z - bb.min.z < cell * 1.25)) return [geo];
  const pos = geo.attributes.position.array;
  const nTri = pos.length / 9;
  const keyOf = new Int32Array(nTri);
  const count = new Map();
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3, cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    const k = (Math.floor(cx / cell) + 1000) * 4096 + (Math.floor(cz / cell) + 1000);
    keyOf[t] = k;
    count.set(k, (count.get(k) || 0) + 1);
  }
  if (count.size === 1) return [geo];
  const names = Object.keys(geo.attributes);
  const parts = new Map();
  for (const [k, n] of count) {
    const arrays = {};
    for (const a of names) arrays[a] = new Float32Array(n * 3 * geo.attributes[a].itemSize);
    parts.set(k, { arrays, fill: 0 });
  }
  for (let t = 0; t < nTri; t++) {
    const p = parts.get(keyOf[t]);
    for (const a of names) {
      const src = geo.attributes[a].array, size = geo.attributes[a].itemSize * 3;
      p.arrays[a].set(src.subarray(t * size, t * size + size), p.fill * size);
    }
    p.fill++;
  }
  const out = [];
  for (const p of parts.values()) {
    const g = new THREE.BufferGeometry();
    for (const a of names) g.setAttribute(a, new THREE.BufferAttribute(p.arrays[a], geo.attributes[a].itemSize, geo.attributes[a].normalized));
    out.push(g);
  }
  geo.dispose();
  return out;
}

export class Batcher {
  constructor() { this.groups = new Map(); }
  add(key, material, geometry, matrix = null) {
    if (!geometry || !geometry.attributes.position || geometry.attributes.position.count === 0) return;
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (matrix) { g = g === geometry ? g.clone() : g; g.applyMatrix4(matrix); }
    // keep attribute sets compatible
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    // tinted material: draw the shared one, the tint goes per vertex
    // (only while the handle still draws like the shared material: callers may have
    // set polygon offset, culling or shadow flags on their own copy)
    const sh = material.userData.shared;
    if (sh && material.polygonOffset === sh.polygonOffset && material.side === sh.side && material.transparent === sh.transparent
      && material.alphaTest === sh.alphaTest && !!material.userData.noShadow === !!sh.userData.noShadow && material.visible) {
      const c = material.userData.tint;
      if (g === geometry) g = g.clone();
      const n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      material = material.userData.shared;
    }
    // a group is one material; callers' keys are labels (only their prefix is kept,
    // so 'facade:12' and 'facade:40' with the same material become one draw)
    key = key.split(/[:#]/)[0] + '|' + material.uuid;
    let e = this.groups.get(key);
    if (!e) { e = { material, list: [] }; this.groups.set(key, e); }
    e.list.push(g);
  }
  build(parent, { castShadow = true, receiveShadow = true } = {}) {
    const meshes = [];
    for (const [key, e] of this.groups) {
      const merged = mergeGeometries(e.list, false);
      for (const g of e.list) g.dispose();
      if (!merged) continue;
      // one mesh per 40 m cell, so the camera (and shadow) frustum can skip what it
      // does not see: a single street-wide mesh is always drawn in full
      for (const geo of splitCells(merged, CELL)) {
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, e.material);
        mesh.name = key;
        mesh.castShadow = castShadow && !e.material.userData.noShadow;
        mesh.receiveShadow = receiveShadow;
        parent.add(mesh);
        meshes.push(mesh);
      }
    }
    this.groups.clear();
    return meshes;
  }
}
