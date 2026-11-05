// Dataset annotation: crops of whole, unobstructed vehicles from the camera's own
// output frame, with the four corners of each readable plate (YOLO pose labels,
// see tools/dataset.mjs).
//
// Geometry is exact to the output image: a world point goes through the render
// camera (which covers the lens' span) and then through the inverse of the ISP's
// barrel distortion (solved numerically) to the pixel the ISP writes it to.
//
// "Nothing in the way" is measured, not guessed: the vehicle alone is rendered to
// a depth buffer with the very camera of the frame just captured, and compared
// with that frame's depth (the scene pass keeps it as a texture). Any pixel of the
// vehicle with something nearer in the frame is an obstruction: poles, trees,
// people, other cars. The plate gets the same test (its own bumper can hide it at
// steep angles), and the OSD text and the visor count as obstructions too.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

const LAYER = 30;

// local-space vertices of a geometry's convex hull, flat [x, y, z, ...], cached per
// geometry (all of them when the hull is degenerate: plates, decals, flat cards)
const HULLS = new WeakMap();
function hullOf(geo) {
  let h = HULLS.get(geo);
  if (h) return h;
  const p = geo.attributes.position;
  const all = () => { const a = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { a[i * 3] = p.getX(i); a[i * 3 + 1] = p.getY(i); a[i * 3 + 2] = p.getZ(i); } return a; };
  if (p.count <= 64) h = all();
  else {
    try {
      const pts = [];
      for (let i = 0; i < p.count; i++) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      const hull = new ConvexHull().setFromPoints(pts);
      const vs = new Set();
      for (const f of hull.faces) { let e = f.edge; do { vs.add(e.head().point); e = e.next; } while (e !== f.edge); }
      if (vs.size >= 4) { h = new Float32Array(vs.size * 3); let i = 0; for (const v of vs) { h[i++] = v.x; h[i++] = v.y; h[i++] = v.z; } }
    } catch (e) { /* degenerate */ }
    if (!h) h = all();
  }
  HULLS.set(geo, h);
  return h;
}

const CMP_FS = /* glsl */ `
uniform sampler2D tScene, tObj;
uniform float uNear, uFar, uEps, uRel;
varying vec2 vUv;
float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  float o = texture2D(tObj, vUv).r;
  if (o >= 1.0) { gl_FragColor = vec4(0.0); return; }
  float lo = lin(o), ls = lin(texture2D(tScene, vUv).r);
  gl_FragColor = vec4(1.0, ls < lo - (uEps + lo * uRel) ? 1.0 : 0.0, 0.0, 1.0);
}`;

export class Annotator {
  // opts: minCar (px, crop width), minPlate (px, plate width), maxDist (m)
  constructor(renderer, cctv, ctx, opts = {}) {
    this.r = renderer;
    this.cctv = cctv;
    this.ctx = ctx;
    this.opts = { minCar: 300, minPlate: 14, maxDist: 70, every: 0.5, ...opts };
    const { width: RW, height: RH } = cctv.sceneRT;
    this.RW = RW; this.RH = RH;
    this.covRT = new THREE.WebGLRenderTarget(RW, RH, { depthBuffer: true, depthTexture: new THREE.DepthTexture(RW, RH) });
    this.maskRT = new THREE.WebGLRenderTarget(RW, RH, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.covCam = new THREE.PerspectiveCamera();
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.cmp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tObj: { value: null }, uNear: { value: 0.1 }, uFar: { value: 4000 }, uEps: { value: 0.05 }, uRel: { value: 0.002 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: CMP_FS,
    }));
    // stand-in for a plate's printed face (inset from the rounded corners)
    this.probe = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.depthMat);
    this.probe.matrixAutoUpdate = false;
    this.probe.layers.set(LAYER);
    this.ray = new THREE.Raycaster();
    this.glass = new WeakMap();  // vehicle -> its see-through meshes
    this.vp = new THREE.Matrix4();
    this.seen = new Map();       // vehicle -> { t, x, z } of its last sample
    this.why = {};               // why vehicles were turned down (tally, for tuning)
    this.lastStep = -1e9;
  }

  // reuse for another camera with the same render size (src/gen.js keeps one per size)
  setCamera(cctv) {
    if (cctv.sceneRT.width !== this.RW || cctv.sceneRT.height !== this.RH) throw new Error('Annotator: render size differs');
    this.cctv = cctv;
    this.seen.clear();
  }

  dispose() {
    this.covRT.dispose(); this.maskRT.dispose(); this.depthMat.dispose();
    this.cmp.dispose(); this.probe.geometry.dispose();
  }

  // world point -> clip [x, y, w] of the render camera
  clip(x, y, z) {
    const e = this.vp.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, w];
  }

  // render NDC -> output pixel (x right, y down, continuous: pixel i spans [i, i+1]).
  // The ISP samples the scene at distort(uv) (cctv.js): this inverts it.
  toPixel(nx, ny) {
    const { k, span, aspect, W, H } = this.cctv;
    const qx = nx * span, qy = ny / aspect * span;
    const rd = Math.hypot(qx, qy);
    let rho = rd;
    if (k && rd > 0) for (let i = 0; i < 12; i++) rho -= (rho + k * rho * rho * rho - rd) / (1 + 3 * k * rho * rho);
    const s = rd > 0 ? rho / rd : 1;
    const u = qx * s * 0.5 + 0.5, v = qy * s * aspect * 0.5 + 0.5;
    return [u * W, (1 - v) * H];
  }

  // output pixel -> render NDC (inverse of toPixel)
  fromPixel(px, py) {
    const { k, span, aspect, W, H } = this.cctv;
    const ox = (px / W - 0.5) * 2, oy = (0.5 - py / H) * 2 / aspect;
    const rho = Math.hypot(ox, oy);
    const s = rho > 0 ? (rho + k * rho * rho * rho) / rho : 1;
    return [ox * s / span, oy * s * aspect / span];
  }

  // render box (render px, y up) of an output rectangle [x0, y0, x1, y1]: its edges
  // are curved in render space (the lens' barrel), so they are walked
  renBox([x0, y0, x1, y1]) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (x, y) => {
      const [nx, ny] = this.fromPixel(x, y);
      const rx = (nx * 0.5 + 0.5) * this.RW, ry = (ny * 0.5 + 0.5) * this.RH;
      if (rx < b[0]) b[0] = rx; if (rx > b[2]) b[2] = rx; if (ry < b[1]) b[1] = ry; if (ry > b[3]) b[3] = ry;
    };
    for (let i = 0; i <= 8; i++) {
      const f = i / 8;
      add(x0 + (x1 - x0) * f, y0); add(x0 + (x1 - x0) * f, y1);
      add(x0, y0 + (y1 - y0) * f); add(x1, y0 + (y1 - y0) * f);
    }
    return b;
  }

  // projected extent of a vehicle and everything hanging from it (a motorcycle's
  // rider is a SkinnedMesh below its root): output box and render box (render px,
  // y up), or null when part of it is behind the lens.
  // Rigid meshes are projected through the vertices of their convex hull only (the
  // extremes of a perspective projection are always hull vertices: exact, and a GTA
  // car body has 10-30x fewer of them); skinned ones vertex by vertex with skinning
  // applied (getVertexPosition), thinned out when dense.
  extent(root) {
    let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    let ok = true;
    const v = new THREE.Vector3();
    const e = this.vp.elements;
    const point = (x, y, z) => {
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w < 0.2) { ok = false; return; }
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      const [px, py] = this.toPixel(nx, ny);
      if (px < ox0) ox0 = px; if (px > ox1) ox1 = px; if (py < oy0) oy0 = py; if (py > oy1) oy1 = py;
      const rx = (nx * 0.5 + 0.5) * this.RW, ry = (ny * 0.5 + 0.5) * this.RH;
      if (rx < rx0) rx0 = rx; if (rx > rx1) rx1 = rx; if (ry < ry0) ry0 = ry; if (ry > ry1) ry1 = ry;
    };
    root.traverseVisible(o => {
      if (!ok || !o.isMesh || o.isInstancedMesh) return;
      const m = o.matrixWorld.elements;
      if (o.isSkinnedMesh || o.morphTargetInfluences?.some(x => x)) {
        const n = o.geometry.attributes.position.count;
        const step = Math.max(1, Math.floor(n / 6000));
        for (let i = 0; i < n && ok; i += step) {
          o.getVertexPosition(i, v);
          v.applyMatrix4(o.matrixWorld);
          point(v.x, v.y, v.z);
        }
        return;
      }
      const h = hullOf(o.geometry);
      for (let i = 0; i < h.length && ok; i += 3) {
        const x = h[i], y = h[i + 1], z = h[i + 2];
        point(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
    });
    if (!ok || ox0 === Infinity) return null;
    return { out: [ox0, oy0, ox1, oy1], ren: [rx0, ry0, rx1, ry1] };
  }

  // pixels covered by `objects` (rendered alone) and how many of them have something
  // nearer in the captured frame, inside the render box `ren`. The objects are
  // traversed whole: every descendant (wheels, a motorcycle's rider) is part of them,
  // so it never counts as an obstruction of its own vehicle.
  coverage(scene, objects, ren, eps, rel) {
    const r = this.r;
    const tagged = [];
    for (const obj of objects) obj.traverse(o => { if ((o.isMesh || o.isPoints) && !o.layers.isEnabled(LAYER)) { o.layers.enable(LAYER); tagged.push(o); } });
    this.covCam.copy(this.cctv.camera);
    this.covCam.layers.set(LAYER);
    const prevTarget = r.getRenderTarget(), prevOverride = scene.overrideMaterial, prevBg = scene.background, prevAuto = r.autoClear;
    scene.overrideMaterial = this.depthMat;
    scene.background = null;
    r.setRenderTarget(this.covRT);
    r.autoClear = true;
    r.render(scene, this.covCam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    for (const o of tagged) o.layers.disable(LAYER);
    const u = this.cmp.material.uniforms;
    u.tScene.value = this.cctv.sceneRT.depthTexture;
    u.tObj.value = this.covRT.depthTexture;
    u.uNear.value = this.cctv.camera.near; u.uFar.value = this.cctv.camera.far;
    u.uEps.value = eps; u.uRel.value = rel;
    r.setRenderTarget(this.maskRT);
    this.cmp.render(r);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    const x0 = Math.max(0, Math.floor(ren[0]) - 1), y0 = Math.max(0, Math.floor(ren[1]) - 1);
    const x1 = Math.min(this.RW, Math.ceil(ren[2]) + 1), y1 = Math.min(this.RH, Math.ceil(ren[3]) + 1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return { cov: 0, occ: 0 };
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(this.maskRT, x0, y0, w, h, buf);
    let cov = 0, occ = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] > 127) { cov++; if (buf[i + 1] > 127) occ++; }
    return { cov, occ };
  }

  // see-through parts of the vehicle itself (glass, tinted covers: transparent, no
  // depth written, so coverage() cannot see them) between the camera and the plate
  glassOver(root, p) {
    let glass = this.glass.get(root);
    if (!glass) {
      glass = [];
      root.traverse(o => { if (o.isMesh && [o.material].flat().some(m => m.transparent)) glass.push(o); });
      this.glass.set(root, glass);
    }
    // (a burnt-out shell hides its glass: wear changes from round to round)
    glass = glass.filter(o => o.visible && [o.material].flat().some(m => m.visible !== false));
    if (!glass.length) return false;
    const cam = this.cctv.camera.position, dir = new THREE.Vector3();
    for (const q of p.pts) {
      dir.copy(q).sub(cam);
      const len = dir.length();
      this.ray.set(cam, dir.divideScalar(len));
      this.ray.far = len - 0.005;
      if (this.ray.intersectObjects(glass, false).length) return true;
    }
    return false;
  }

  // the plates of a vehicle that face the camera: corners TL, TR, BR, BL as printed,
  // in output pixels
  plates(root) {
    const out = [];
    const cam = this.cctv.camera.position;
    const m = new THREE.Matrix4(), c = new THREE.Vector3(), n = new THREE.Vector3(), v = new THREE.Vector3();
    for (const p of root.userData.plates || []) {
      m.multiplyMatrices(root.matrixWorld, p.m);
      c.setFromMatrixPosition(m);
      n.setFromMatrixColumn(m, 2).normalize();
      const to = cam.clone().sub(c);
      const dist = to.length();
      const facing = n.dot(to) / dist;
      if (facing < 0.2) continue;     // edge-on or the back of it
      const w = p.mm[0] / 1000, h = p.mm[1] / 1000;
      const corners = [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]].map(([x, y]) => {
        v.set(x, y, 0).applyMatrix4(m);
        const [nx, ny, cw] = this.clip(v.x, v.y, v.z);
        return cw > 0.2 ? this.toPixel(nx, ny) : null;
      });
      if (corners.some(q => !q)) continue;
      // the printed face, inset from the rounded corners, 1 mm proud
      this.probe.matrix.copy(m).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.001)).multiply(new THREE.Matrix4().makeScale(w * 0.9, h * 0.8, 1));
      this.probe.matrixWorld.copy(this.probe.matrix);
      const ren = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
        v.set(x, y, 0).applyMatrix4(this.probe.matrix);
        const [nx, ny] = this.clip(v.x, v.y, v.z);
        const rx = (nx * 0.5 + 0.5) * this.RW, ry = (ny * 0.5 + 0.5) * this.RH;
        ren[0] = Math.min(ren[0], rx); ren[1] = Math.min(ren[1], ry); ren[2] = Math.max(ren[2], rx); ren[3] = Math.max(ren[3], ry);
      }
      const area = Math.abs(corners.reduce((s, [x, y], i) => { const [x2, y2] = corners[(i + 1) % 4]; return s + x * y2 - x2 * y; }, 0)) / 2;
      const pts = [];
      for (const gx of [-0.4, -0.2, 0, 0.2, 0.4]) for (const gy of [-0.3, 0, 0.3]) pts.push(new THREE.Vector3(gx * w, gy * h, 0.001).applyMatrix4(m));
      out.push({ corners, pts, area, dist, facing, kind: p.mm[0] < 300 ? 'moto' : 'carro', ren, width: Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) });
    }
    return out;
  }

  // vehicles worth a sample at time t: whole in frame, nothing in the way, a readable
  // plate. Returns [{ root, crop: [x, y, w, h], plates: [{ corners, ... }] }]
  find(scene, t, rng) {
    const { W, H } = this.cctv;
    const o = this.opts;
    this.cctv.camera.updateMatrixWorld();
    this.vp.multiplyMatrices(this.cctv.camera.projectionMatrix, this.cctv.camera.matrixWorldInverse);
    const cam = this.cctv.camera.position;
    const cars = [...(this.ctx.parked || []), ...(this.ctx.traffic?.cars || []).filter(c => c.active).map(c => c.obj)];
    const osd = this.cctv.hideOSD ? [] : this.cctv.osd.rects || [];
    const visor = this.cctv.pIsp.material.uniforms.uVisor.value;
    const visorY = visor > 0 ? H * (0.05 * visor + 0.02 + 0.03 + 0.01) : 0;
    const found = [];
    const no = (k) => { this.why[k] = (this.why[k] || 0) + 1; };
    for (const root of cars) {
      if (!root || !root.visible) continue;
      const pos = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
      if (pos.distanceTo(cam) > o.maxDist) { no('longe'); continue; }
      // a parked car once per scene; a moving one again after it moved on
      const last = this.seen.get(root);
      if (last && (last.parked || t - last.t < 1.5 || Math.hypot(pos.x - last.x, pos.z - last.z) < 2)) continue;
      const [nx, ny, w] = this.clip(pos.x, pos.y + 0.7, pos.z);
      if (w < 0.5 || Math.abs(nx) > 1.3 || Math.abs(ny) > 1.3) { no('fora'); continue; }
      const ext = this.extent(root);
      if (!ext) { no('fora'); continue; }
      const [x0, y0, x1, y1] = ext.out;
      // whole in frame, clear of the OSD and the visor
      if (x0 < 2 || y0 < Math.max(2, visorY) || x1 > W - 2 || y1 > H - 2) { no('cortado'); continue; }
      if (x1 - x0 < o.minCar) { no('pequeno'); continue; }
      if (osd.some(([a, b, c, d]) => a < x1 && c > x0 && b < y1 && d > y0)) { no('osd'); continue; }
      const all = this.plates(root);
      if (!all.length) { no('placa de costas'); continue; }
      const plates = all.filter(p => p.width >= o.minPlate);
      if (!plates.length) { no('placa pequena'); continue; }
      const car = this.coverage(scene, [root], ext.ren, 0.05, 0.002);
      // (a leaf tip on a roof rack is tolerated: up to 1% of the vehicle, never the plate)
      if (car.cov < 50 || car.occ > Math.max(3, car.cov * 0.01)) { no('obstruido'); continue; }
      const clear = plates.filter(p => {
        scene.add(this.probe);
        const c = this.coverage(scene, [this.probe], p.ren, 0.02, 0.002);
        scene.remove(this.probe);
        return c.cov >= 4 && c.occ <= c.cov * 0.02 && !this.glassOver(root, p);
      });
      if (!clear.length) { no('placa obstruida'); continue; }
      no('ok');
      // the crop fits the vehicle: its projected extent, out to whole pixels
      const bh = y1 - y0;
      const cx0 = Math.max(0, Math.floor(x0)), cy0 = Math.max(0, Math.floor(y0));
      const cx1 = Math.min(W, Math.ceil(x1)), cy1 = Math.min(H, Math.ceil(y1));
      found.push({ root, box: [x0, y0, x1, y1], crop: [cx0, cy0, cx1 - cx0, cy1 - cy0], plates: clear, dist: pos.distanceTo(cam), pos, bh });
    }
    return found;
  }

  // Generator mode (src/gen.js): like find(), but a vehicle cut by the frame edge is
  // accepted as long as its plates are not. Crop = the vehicle's projected box clipped
  // to the frame (tight), at least minCar wide and minVis of the whole box; the car
  // body's obstruction is measured on its visible part only; the OSD and the visor
  // only matter over the plate. Returns [{ root, box, crop, plates, cut, vis, occ, ... }]
  // plateOnly (rectified-plate datasets): the vehicle itself may be small, mostly out
  // of the frame or partly hidden; only its plates' own checks apply
  findGen(scene, cars, { parkedOnly = false, plateOnly = false } = {}) {
    const { W, H } = this.cctv;
    const o = { minVis: 0.25, maxOcc: 0.03, margin: 3, ...this.opts };
    this.cctv.camera.updateMatrixWorld();
    this.vp.multiplyMatrices(this.cctv.camera.projectionMatrix, this.cctv.camera.matrixWorldInverse);
    const cam = this.cctv.camera.position;
    const parked = new Set(this.ctx.parked || []);
    const osd = this.cctv.hideOSD ? [] : this.cctv.osd.rects || [];
    const visor = this.cctv.pIsp.material.uniforms.uVisor.value;
    const visorY = visor > 0 ? H * (0.05 * visor + 0.02 + 0.03 + 0.01) : 0;
    const found = [];
    this.verdict = new Map();     // root -> reason (or 'ok'), for the generator's stats
    let cur = null;
    const no = (k) => { this.why[k] = (this.why[k] || 0) + 1; this.verdict.set(cur, k); };
    const pos = new THREE.Vector3();
    for (const root of cars) {
      if (!root || !root.visible) continue;
      cur = root;
      if (parkedOnly && !parked.has(root)) { no('movendo em quadro P'); continue; }
      pos.setFromMatrixPosition(root.matrixWorld);
      const dist = pos.distanceTo(cam);
      if (dist > o.maxDist) { no('longe'); continue; }
      const [nx, ny, w] = this.clip(pos.x, pos.y + 0.7, pos.z);
      if (w < 0.5 || Math.abs(nx) > 2.5 || Math.abs(ny) > 2.5) { no('fora'); continue; }
      const ext = this.extent(root);
      if (!ext) { no('fora'); continue; }
      const [x0, y0, x1, y1] = ext.out;
      const cx0 = Math.max(0, Math.floor(x0)), cy0 = Math.max(0, Math.floor(y0));
      const cx1 = Math.min(W, Math.ceil(x1)), cy1 = Math.min(H, Math.ceil(y1));
      if (!plateOnly && cx1 - cx0 < o.minCar) { no('pequeno'); continue; }
      const full = (x1 - x0) * (y1 - y0), shown = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0);
      const vis = Math.min(1, shown / Math.max(1, full));
      if (!plateOnly && vis < o.minVis) { no('cortado demais'); continue; }
      const cut = x0 < -0.5 || y0 < -0.5 || x1 > W + 0.5 || y1 > H + 0.5;
      const all = this.plates(root);
      if (!all.length) { no('placa de costas'); continue; }
      // a plate facing the camera but out of the picture (even partly): its vehicle
      // would go in with a visible, unlabelled plate (or a label off the image)
      const m = o.margin;
      const inFrame = (p) => p.corners.every(([x, y]) => x >= m && x <= W - m && y >= Math.max(m, visorY) && y <= H - m);
      if (all.some(p => !inFrame(p) && p.corners.some(([x, y]) => x > 0 && x < W && y > 0 && y < H))) { no('placa cortada'); continue; }
      // every visible plate gets a label, so one too small for a usable label (top
      // edge, or area of the quad) sends the whole vehicle away: a crop with a
      // visible plate left unlabelled teaches the model to ignore plates
      const plates = all.filter(inFrame);
      if (!plates.length) { no('placa fora'); continue; }
      if (plates.some(p => p.width < o.minPlate || p.area < (o.minPlateArea || 0))) { no('placa pequena'); continue; }
      const overOSD = (p) => {
        const xs = p.corners.map(c => c[0]), ys = p.corners.map(c => c[1]);
        const a0 = Math.min(...xs), a1 = Math.max(...xs), b0 = Math.min(...ys), b1 = Math.max(...ys);
        return osd.some(([a, b, c, d]) => a < a1 && c > a0 && b < b1 && d > b0);
      };
      if (plates.some(overOSD)) { no('osd na placa'); continue; }
      // obstruction of the body, on the part inside the frame
      const fr = this.renBox([cx0, cy0, cx1, cy1]);
      const ren = [Math.max(ext.ren[0], fr[0]), Math.max(ext.ren[1], fr[1]), Math.min(ext.ren[2], fr[2]), Math.min(ext.ren[3], fr[3])];
      const car = plateOnly ? { cov: 1, occ: 0 } : this.coverage(scene, [root], ren, 0.05, 0.002);
      if (car.cov < 50 && !plateOnly || car.occ > Math.max(3, car.cov * o.maxOcc)) { no('obstruido'); continue; }
      const clear = plates.filter(p => {
        scene.add(this.probe);
        const c = this.coverage(scene, [this.probe], p.ren, 0.02, 0.002);
        scene.remove(this.probe);
        return c.cov >= 4 && c.occ <= c.cov * 0.02 && !this.glassOver(root, p);
      });
      if (clear.length < plates.length) { no('placa obstruida'); continue; }
      no('ok');
      found.push({ root, box: [x0, y0, x1, y1], crop: [cx0, cy0, cx1 - cx0, cy1 - cy0], plates: clear, dist, cut, vis, occ: car.occ / car.cov, moving: !parked.has(root) });
    }
    return found;
  }

  mark(root, t) {
    const pos = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
    this.seen.set(root, { t, x: pos.x, z: pos.z, parked: (this.ctx.parked || []).includes(root) });
  }

  // output pixels (x, y from the top left) of the emulated codec's frame, as ImageData
  pixels(x, y, w, h) {
    const buf = new Uint8Array(w * h * 4);
    this.r.readRenderTargetPixels(this.cctv.output, x, this.cctv.H - y - h, w, h, buf);
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let j = 0; j < h; j++) img.data.set(buf.subarray((h - 1 - j) * row, (h - j) * row), j * row);
    return img;
  }

  // the crop's pixels from the frame just captured: the camera's final output (the
  // emulated codec's), or with a real encoder the very frame handed to it (canvas)
  async image(crop, type = 'image/jpeg', quality = 0.95) {
    const [x, y, w, h] = crop;
    const buf = new Uint8Array(w * h * 4);
    if (this.cctv.codecMode === 'real') {
      const gl = this.r.getContext();
      if (gl.drawingBufferWidth !== this.cctv.W || gl.drawingBufferHeight !== this.cctv.H) return null;
      this.r.setRenderTarget(null);
      gl.readPixels(x, this.cctv.H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    } else this.r.readRenderTargetPixels(this.cctv.output, x, this.cctv.H - y - h, w, h, buf);
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let j = 0; j < h; j++) img.data.set(buf.subarray((h - 1 - j) * row, (h - j) * row), j * row);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    return c.convertToBlob({ type, quality });
  }
}

// one YOLO pose line: class, plate box, 4 keypoints (visible), in the crop's 0..1
export function yoloLine(plate, crop) {
  const [cx, cy, cw, ch] = crop;
  const k = plate.corners.map(([x, y]) => [(x - cx) / cw, (y - cy) / ch]);
  const xs = k.map(p => p[0]), ys = k.map(p => p[1]);
  const bx0 = Math.max(0, Math.min(...xs)), bx1 = Math.min(1, Math.max(...xs));
  const by0 = Math.max(0, Math.min(...ys)), by1 = Math.min(1, Math.max(...ys));
  const f = (n) => n.toFixed(6);
  return ['0', f((bx0 + bx1) / 2), f((by0 + by1) / 2), f(bx1 - bx0), f(by1 - by0), ...k.flatMap(([x, y]) => [f(x), f(y), '2'])].join(' ');
}
