// Fast plate-keypoint dataset generator (?gen=1, driven by tools/dataset.mjs).
//
// The world build (streets, GI, probes, shader compile) is the expensive part, so
// one scene is used for several rounds. Each round may change the hour / weather,
// moves traffic forward a few seconds and then installs 4-6 cameras one after the
// other, each with its own model, resolution, lens and codec look (pickCamera, with
// a narrower field of view than the stock lenses) aimed at a vehicle's plate side
// from 1.5 to 12 m high. A camera takes a few frames at its own fps (so auto
// exposure, the temporal noise filter and the emulated codec have a history), then
// its last frame is annotated (Annotator.findGen) and the crops go to Node through
// window.__datasetSample. Nothing waits on requestAnimationFrame or the wall clock.
import * as THREE from 'three';
import { Rng } from './core/rng.js';
import { CCTVCamera } from './cam/cctv.js';
import { pickCamera, CAMERA_MODELS } from './cam/models.js';
import { Annotator, yoloLine } from './cam/annotate.js';
import { PLATE_TYPES, segFamily } from './vehicles/plates.js';
import { GenCodec } from './cam/gencodec.js';

const D2R = Math.PI / 180;
// installers here mostly zoom in: weighted toward long lenses
const HFOV = [[[12, 30], 3], [[30, 50], 4], [[50, 75], 2], [[75, 105], 1]];
const WEATHER = [['clear', 3], ['partly', 3], ['overcast', 2.5], ['wet', 1], ['drizzle', 0.8], ['rain', 0.7], ['fog', 0.4]];

export const GEN_DEFAULTS = {
  rounds: 6,             // camera rounds per scene (world build)
  cams: [4, 6],          // cameras per round
  res: ['1280x720', '1920x1080'],
  codec: 'real',         // 'real': WebCodecs H.264/H.265 round trip; 'emulated': the in-shader DCT
  warm: null,            // frames before the annotated one (default: 8 real, 3 emulated)
  minPlateLum: 35,       // plate area of the final crop: mean luma (0-255) ...
  minPlateStd: 8,        // ... and its contrast, below which the crop is noise
  minCropLum: 24,        // mean luma of the whole crop
  advance: [2, 6],       // simulated seconds between rounds
  condProb: 0.35,        // chance a round changes hour / weather
  intraParked: 0.4,      // chance a camera aimed at a parked vehicle ends on an I-frame anyway
  maxPer: 3,             // samples per camera
  minCar: 300, minPlate: 28, minPlateArea: 400, maxDist: 80, minVis: 0.25, maxOcc: 0.03,
  substep: 0.1,          // simulation step (s)
  quality: 0.95,
  // task 'chars': instead of the vehicle crop, each plate rectified from its corners
  // into a size x size letterbox, every character box labelled with the plate type
  task: 'plates',        // 'plates' (vehicle crops + corners), 'chars', or 'both' from the same pictures
  maxPerChars: 8,        // task 'both': rectified plates per camera (maxPer is for the vehicle crops)
  rerollPlates: true,    // a new plate on every vehicle each round
  negProb: 0.1,          // chars: chance a rectified plate brings a not-a-plate quad (empty label) along
  size: 320,             // rectified sample side (px)
  jitter: 0.5,           // corner noise standing in for the keypoint model (typical error): sigma px ...
  jitterRel: 0.006,      // ... + this share of the plate width
  jitterClean: 0.25,     // share of plates rectified from the exact corners
  charPad: [0.05, 0.04], // character labels: room around the glyph's box, share of its width / height on each side
  minCharStd: 8,         // luma contrast (stroke-wide blur) inside the character boxes below which a plate is unreadable
};

// meshes left out of the line-of-sight rays (by the world's own names): ground layers
// and fine detail, millions of triangles that cannot hide a plate from a camera at
// 1.5 m or more, or that a ray tests badly (wires, grilles); the annotator's depth
// test still sees them
const NOT_BLOCKERS = /^(gutter|road|yard|sw|curb|patch|crack|gravel|tar|mk|pothole|manhole|bump|bed|inlet|litter|paper|can|cup|pet|wire|ewire|wgrille|wframe|louver|antenna|dish|concertina|rebar|spikes|clamp|crossarm|cable|grate|lid|weeds|card|far:)/;

// a macrotask boundary that background-tab timer throttling does not stretch
const yieldTask = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

export class Generator {
  constructor(host) {
    this.host = host;
    this.annots = new Map();      // render size -> Annotator
    this.stopped = false;
    this.count = 0;
  }

  stop() { this.stopped = true; }

  // a new world (seed): the generator's own GPU objects go first
  async next(seed) {
    this.disposeAnnots();
    await this.host.rebuild(seed);
  }

  disposeAnnots() { for (const a of this.annots.values()) a.dispose(); this.annots.clear(); }

  annotator(cctv, o) {
    const key = cctv.sceneRT.width + 'x' + cctv.sceneRT.height;
    let a = this.annots.get(key);
    if (!a) { a = new Annotator(this.host.renderer, cctv, this.host.app.ctx, o); this.annots.set(key, a); }
    else { a.setCamera(cctv); Object.assign(a.opts, o); }
    a.why = {};
    return a;
  }

  // ------------------------------------------------------------------ one scene
  async scene(options = {}) {
    const o = { ...GEN_DEFAULTS, ...options };
    const host = this.host, app = host.app;
    if (!app) throw new Error('no scene');
    const seed = app.seed;
    const rng = new Rng(seed + '/gen');
    const stats = { seed, city: app.site.city, rounds: 0, cams: 0, noPose: 0, samples: 0, why: {}, target: {}, trace: [], ms: { step: 0, place: 0, capture: 0, annotate: 0, cond: 0 } };
    const tm = (k, t0) => { stats.ms[k] += performance.now() - t0; };
    this.blockers = this.findBlockers(app);
    this.condMs = stats.condMs = { compile: 0, probes: 0 };
    this.shadowDue = true;
    await this.precompile();
    // the real codec, if this browser has one
    if (this.real === undefined) {
      this.real = null;
      if (GenCodec.supported()) { const c = new GenCodec(); if (await c.pick('H.264', 1280, 720)) this.real = c; }
      if (!this.real) console.warn('[gen] sem WebCodecs H.264: usando o codec emulado');
    }
    const real = o.codec !== 'emulated' && !!this.real;
    o.real = real;
    if (o.warm == null) o.warm = real ? 8 : 3;
    stats.codec = real ? 'real' : 'emulado';
    const pending = [];
    for (let round = 0; round < o.rounds && !this.stopped; round++) {
      let t0 = performance.now();
      if (round > 0 && rng.chance(o.condProb)) { await this.changeConditions(rng.fork('cond' + round)); }
      tm('cond', t0);
      t0 = performance.now();
      this.advance(round === 0 ? rng.float(0.5, 2) : rng.float(o.advance[0], o.advance[1]), o.substep);
      // another look for every vehicle (dust, mud, scratches, rust: uniforms only)
      // ... and another plate: many more plate texts per world (character variety)
      if (round > 0) for (const v of this.vehicles(app)) {
        v.root.userData.rerollWear?.(rng.fork(`wear${round}/${v.root.id}`));
        if (o.rerollPlates) v.root.userData.rerollPlate?.(rng.fork(`plate${round}/${v.root.id}`));
      }
      tm('step', t0);
      stats.rounds++;
      const nCams = rng.int(o.cams[0], o.cams[1]);
      let prev = null;
      for (let i = 0; i < nCams && !this.stopped; i++) {
        const r = rng.fork(`r${round}c${i}`);
        const spec = this.makeSpec(r, o);
        t0 = performance.now();
        let pose = null;
        for (let k = 0; k < 16 && !pose; k++) {
          const target = prev && k === 0 && r.chance(0.3) ? this.refresh(prev) : this.pickTarget(r);
          if (target) pose = this.place(target, spec, r, o);
        }
        tm('place', t0);
        if (!pose) { stats.noPose++; continue; }
        prev = pose.target;
        await this.shoot(spec, pose, r, { round, i, o, stats, pending, tm });
        stats.cams++;
        await yieldTask();
      }
    }
    await Promise.all(pending);
    return stats;
  }

  // simulated time forward in small steps
  advance(secs, sub = 0.1) {
    let left = secs;
    while (left > 1e-6) { const dt = Math.min(sub, left); this.host.step(dt); left -= dt; }
  }

  async changeConditions(r) {
    const host = this.host;
    const hour = r.weighted([[r.float(6, 9), 2], [r.float(9, 16), 4], [r.float(16, 19), 2.5], [r.float(19, 24), 2], [r.float(0, 6), 1.2]]);
    const weather = r.chance(0.5) ? host.state.weather : r.weighted(WEATHER);
    let t0 = performance.now();
    host.setConditions({ hour, weather });
    await this.precompile();
    this.condMs.compile += performance.now() - t0; t0 = performance.now();
    host.app.probes?.updateAll();
    this.condMs.probes += performance.now() - t0;
    this.shadowDue = true;
  }

  // programs for both states of the camera's lamp (IR / white LEDs: a spot light,
  // part of every program's key) under the current street lights, compiled in
  // parallel now instead of one by one inside a camera's first frame (seconds)
  async precompile() {
    const app = this.host.app, ir = app.irLight;
    // what goes into the program keys: which lights are on, which cast shadows
    const key = String(this.host.lux(new THREE.Vector3(app.ctx.focus[0], 4, app.ctx.focus[1])) < 60) + app.env.lights.map(l => (l.light.visible && !l.disabled ? 1 : 0)).join('') + '|' + app.env.sun.castShadow + '|' + app.env.sun.visible;
    if (this.compiled?.scene === app && this.compiled.keys.has(key)) return;
    if (this.compiled?.scene !== app) this.compiled = { scene: app, keys: new Set() };
    this.compiled.keys.add(key);
    const was = ir.visible, int = ir.intensity;
    // the lamp only comes on in the dark (no camera switches to night above ~40 lux)
    const f = app.ctx.focus;
    const dark = this.host.lux(new THREE.Vector3(f[0], app.ctx.gy(f[0], f[1]) + 4, f[1])) < 60;
    for (const lamp of dark ? [!was, was] : [false]) {
      ir.visible = lamp; ir.intensity = lamp ? 1 : 0;
      await this.host.compile();
    }
    ir.visible = was; ir.intensity = int;
  }

  // ------------------------------------------------------------------ camera spec
  makeSpec(r, o) {
    let spec = pickCamera(r, 'auto', 'auto');
    spec = this.host.specOverrides(spec);
    const model = CAMERA_MODELS.find(m => m.id === spec.id) || spec;
    const [lo, hi] = r.weighted(HFOV);
    const hfov = r.float(lo, hi);
    // a long lens has next to no barrel distortion
    const k = model.k * Math.min(1, (hfov / model.hfov) ** 2);
    const [w, h] = r.pick(o.res).split('x').map(Number);
    // what the DVR really gets: installers leave sub-streams, VBR caps and starved
    // 1-2 Mbps 1080p channels; the model's usual setting, scaled gently with the
    // pixels and spread wide (lognormal, 0.3-1.5x)
    const spread = Math.min(1.5, Math.max(0.3, Math.exp(r.gauss(Math.log(0.75), 0.45))));
    const kbps = Math.max(200, Math.round(spec.kbps * Math.sqrt((w * h) / (spec.res[0] * spec.res[1])) * spread));
    return { ...spec, hfov, k, res: [w, h], kbps, modelRes: spec.res };
  }

  // ------------------------------------------------------------------ targets
  vehicles(app) {
    const out = [];
    for (const root of app.ctx.parked || []) if (root.visible) out.push({ root, moving: false, kind: root.userData.kind });
    for (const c of app.ctx.traffic?.cars || []) if (c.active && c.obj.visible) out.push({ root: c.obj, moving: true, car: c, kind: c.kind });
    return out;
  }

  // the same vehicle again (a traffic car may have left since)
  refresh(t) { return t.moving && !t.car.active ? null : t; }

  pickTarget(r) {
    const app = this.host.app;
    const f = app.ctx.focus;
    const list = this.vehicles(app).filter(v => (v.root.userData.plates || []).length && Math.hypot(v.root.position.x - f[0], v.root.position.z - f[1]) < 75);
    if (!list.length) return null;
    return r.weighted(list.map(v => [v, (v.moving ? 1.3 : 1) * (v.kind === 'moto' ? 2.5 : 1)]));
  }

  // meshes a line of sight can hit: the street minus vehicles, people, sky, rain
  findBlockers(app) {
    const skip = new Set();
    for (const v of this.vehicles(app)) v.root.traverse(o => skip.add(o));
    for (const c of app.ctx.traffic?.cars || []) c.obj.traverse(o => skip.add(o));
    const list = [];
    const box = new THREE.Box3();
    app.scene.traverseVisible(o => {
      if (!o.isMesh || o.isSkinnedMesh || skip.has(o) || o === app.env.rain?.mesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.side === THREE.BackSide || m.transparent && !m.alphaTest && !m.alphaMap && (m.opacity ?? 1) < 0.5) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      if (o.geometry.boundingSphere.radius * o.matrixWorld.getMaxScaleOnAxis() > 600) return;
      // ground-hugging meshes (road, gutters, kerbs, yards: millions of triangles)
      // cannot hide a plate from a lens 1.5 m up or more; the annotator's depth test
      // has the last word anyway
      if (NOT_BLOCKERS.test(o.name)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      if (box.max.y - box.min.y < 0.6) return;
      list.push(o);
    });
    return list;
  }

  // a pose looking at the target's plate side, or null
  place(target, spec, r, o) {
    const app = this.host.app;
    const { root } = target;
    root.updateMatrixWorld(true);
    const plates = root.userData.plates || [];
    if (!plates.length) return null;
    const p = r.pick(plates);
    const M = new THREE.Matrix4().multiplyMatrices(root.matrixWorld, p.m);
    const pc = new THREE.Vector3().setFromMatrixPosition(M);
    const n = new THREE.Vector3().setFromMatrixColumn(M, 2);
    n.y = 0;
    if (n.lengthSq() < 1e-6) return null;
    n.normalize();
    // where a moving vehicle will be when the camera takes its annotated frame
    const lead = o.warm / spec.fps;
    const shift = new THREE.Vector3();
    if (target.moving) shift.set(target.car.tx, 0, target.car.tz).multiplyScalar(target.car.v * lead);
    pc.add(shift);
    const size = root.userData.size || new THREE.Vector3(1.8, 1.5, 4.5);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3()).add(shift);
    // viewing direction around the plate's normal: mostly within +-60 deg, sometimes more oblique
    const a = r.weighted([[THREE.MathUtils.clamp(r.gauss(0, 26 * D2R), -60 * D2R, 60 * D2R), 5], [r.sign() * r.float(60, 78) * D2R, 1]]);
    const dir = n.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
    // distance where the vehicle fills about `fill` of the frame width
    const fill = r.weighted([[r.float(0.3, 0.6), 3], [r.float(0.6, 1.0), 4], [r.float(1.0, 1.4), 2]]);
    const wObj = Math.abs(size.x * Math.cos(a)) + Math.abs(size.z * Math.sin(a));
    const tanH = Math.tan(spec.hfov / 2 * D2R);
    const range = Math.max(2.2, wObj / (fill * 2 * tanH));
    const hgt = r.weighted([[r.float(1.5, 2.5), 1.5], [r.float(2.5, 7), 6], [r.float(7, 12), 2]]);
    const gy = app.ctx.gy;
    // an installer does not look straight down on a plate: up to 20-45 deg below the
    // horizon (a high camera ends up further away, the vehicle smaller)
    const dy = gy(center.x, center.z) + hgt - center.y;
    const maxElev = r.float(20, 45) * D2R;
    const horiz = Math.max(Math.sqrt(Math.max(range * range - dy * dy, 0)), 2.0, dy / Math.tan(maxElev));
    const cam = new THREE.Vector3(center.x + dir.x * horiz, 0, center.z + dir.z * horiz);
    cam.y = gy(cam.x, cam.z) + hgt;
    if (cam.distanceTo(center) > o.maxDist * 0.9) return null;
    // too small in the picture for a sample (estimate)
    if (wObj / (2 * cam.distanceTo(center) * tanH) * spec.res[0] < o.minCar * 0.95) return null;
    // ... or its plate too small for a label (estimate, with headroom so that most
    // samples land well above the annotator's limits)
    {
      const toCam = cam.clone().sub(pc), dp = toCam.length();
      const pxPerM = spec.res[0] / (2 * dp * tanH);
      const cosA = Math.max(0, n.dot(toCam.clone().setY(0).normalize())) * Math.cos(Math.atan2(toCam.y, Math.hypot(toCam.x, toCam.z)));
      const pw = p.mm[0] / 1000 * pxPerM * Math.abs(Math.cos(a)), ph = p.mm[1] / 1000 * pxPerM * Math.cos(Math.atan2(toCam.y, Math.hypot(toCam.x, toCam.z)));
      if (cosA < 0.25 || pw < o.minPlate * 1.25 || pw * ph < (o.minPlateArea || 0) * 1.4) return null;
    }
    // not inside or against another vehicle
    for (const v of this.vehicles(app)) {
      const s = v.root.userData.size;
      const rad = s ? Math.max(s.x, s.z) / 2 + 0.6 : 2.5;
      if (Math.hypot(v.root.position.x - cam.x, v.root.position.z - cam.z) < rad && cam.y - v.root.position.y < (s ? s.y : 2) + 0.5) return null;
    }
    // plate in sight, and the camera not inside a house, wall or tree: a ray from the
    // plate out to the lens crosses nothing
    const from = pc.clone().addScaledVector(n, 0.08);
    const to = cam.clone().sub(from);
    const len = to.length();
    const ray = new THREE.Raycaster(from, to.normalize(), 0, len - 0.2);
    ray.firstHitOnly = true;
    if (ray.intersectObjects(this.blockers, false).length) return null;
    // aim: at the vehicle, off by a random amount (sometimes enough to cut it)
    const look = center.clone().sub(cam);
    const yaw0 = Math.atan2(-look.x, -look.z), pitch0 = Math.atan2(look.y, Math.hypot(look.x, look.z));
    const aspect = spec.res[0] / spec.res[1];
    const halfV = Math.atan(tanH / aspect);
    const offX = r.weighted([[0.12, 3], [0.45, 2], [0.85, 1.2]]);
    const yaw = yaw0 + r.float(-1, 1) * offX * spec.hfov / 2 * D2R;
    const pitch = pitch0 + r.float(-1, 1) * offX * 0.6 * halfV;
    const roll = r.weighted([[r.gauss(0, 0.6 * D2R), 6], [r.gauss(0, 3 * D2R), 1]]);
    // ... but the plate stays inside the frame: if the offset pushed it out, turn
    // back just enough to bring it to 80% of the way to the edge
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(pitch, yaw, roll, 'YXZ');
    const inv = new THREE.Quaternion();
    for (let it = 0; it < 3; it++) {
      q.setFromEuler(e);
      const v = pc.clone().sub(cam).applyQuaternion(inv.copy(q).invert());
      if (v.z > -0.5) return null;
      const px = v.x / -v.z / tanH, py = v.y / -v.z / (tanH / aspect);
      const cx = THREE.MathUtils.clamp(px, -0.8, 0.8), cy = THREE.MathUtils.clamp(py, -0.75, 0.75);
      if (cx === px && cy === py) break;
      e.y -= Math.atan(cx * tanH) - Math.atan(px * tanH);
      e.x += Math.atan(py * tanH / aspect) - Math.atan(cy * tanH / aspect);
    }
    // keeping the plate in frame can tip a close, high camera nearly straight down:
    // no installation looks at a plate from above 50 deg
    const toCam = cam.clone().sub(pc);
    if (e.x < -50 * D2R || Math.atan2(toCam.y, Math.hypot(toCam.x, toCam.z)) > 50 * D2R) return null;
    q.setFromEuler(e);
    return { position: cam, quaternion: q, target, height: hgt, pitch: e.x / D2R, view: a / D2R, fill };
  }

  // ------------------------------------------------------------------ capture + annotate
  async shoot(spec, pose, r, { round, i, o, stats, pending, tm }) {
    const host = this.host, app = host.app;
    const { scene, env } = app;
    let t0 = performance.now();
    const tCam = t0;
    const cctv = new CCTVCamera(host.renderer, spec, `${app.seed}/g${round}/${i}`);
    // real codec: the ISP output is drawn into the WebGL canvas (at the camera's size)
    // and handed to the encoder from there
    const codec = o.real && await this.real.start(spec) ? this.real : null;
    if (o.trace) console.log("[gen] cam", spec.codec, spec.res.join("x"), spec.fps, spec.gop, spec.kbps, codec && codec.name, codec && codec.key);
    cctv.codecMode = codec ? 'real' : 'emulated';
    if (codec) host.renderer.setSize(spec.res[0], spec.res[1], false);
    host.attach(cctv);
    cctv.camera.position.copy(pose.position);
    cctv.camera.quaternion.copy(pose.quaternion);
    cctv.camera.updateMatrixWorld();
    // moving target: the labelled frame is an I-frame (a P-frame copies blocks of the
    // previous one and smears whatever moves); parked target: usually wherever the
    // GOP happens to be (a P-frame), and then only parked vehicles are labelled
    // (a real codec does not displace content: no such care)
    const intraFinal = !codec && (pose.target.moving || r.chance(o.intraParked));
    // real codec: the GOP started before the camera was "switched on", so the
    // labelled frame is usually a P-frame mid-GOP (sometimes the I-frame)
    const phase = r.int(0, spec.gop - 1);
    const lensRain = r.chance(0.3) ? 0.3 : 1;     // under an eave, or out in the rain
    const dt = 1 / spec.fps;
    try {
      for (let j = 0; j <= o.warm; j++) {
        if (j > 0) { const s0 = performance.now(); this.advance(dt, o.substep); stats.ms.step += performance.now() - s0; t0 += performance.now() - s0; }
        if (j === 0 || (j === o.warm && intraFinal)) cctv.forceIntra = true;
        host.prepare(cctv, lensRain);
        if (this.shadowDue) { cctv.shadowDue = true; this.shadowDue = false; }
        cctv.capture(scene, host.clock(), dt, env);
        if (codec) codec.push(host.renderer.domElement, j === 0 || (phase + j) % spec.gop === 0, j === o.warm);
      }
      tm('capture', t0);
      t0 = performance.now();
      const a = this.annotator(cctv, { minCar: o.minCar, minPlate: o.minPlate, minPlateArea: o.minPlateArea, maxDist: o.maxDist, minVis: o.minVis, maxOcc: o.maxOcc });
      const vs = this.vehicles(app);
      const kinds = new Map(vs.map(v => [v.root, v.kind]));
      const cars = vs.map(v => v.root);
      // the target first, then whatever else is in the picture
      cars.sort((x, y) => (y === pose.target.root) - (x === pose.target.root));
      // task 'both': one picture, two datasets, each with its own acceptance (vehicle
      // crops need the vehicle well framed, rectified plates only the plate)
      const tasks = o.task === 'both' ? ['plates', 'chars'] : [o.task];
      const finds = tasks.map(t => a.findGen(scene, cars, { parkedOnly: !codec && !cctv.lastIntra, plateOnly: t === 'chars' && !o.demo }));
      // the picture the samples come from: the decoded frame, or the emulated output
      let px = null, dec = null;
      if (codec) {
        if (o.trace) console.log("[gen] finish"); dec = await codec.finish(); if (o.trace) console.log("[gen] decoded", dec && dec.type);
        if (!dec) { a.why['codec falhou'] = (a.why['codec falhou'] || 0) + finds[0].length; finds.forEach(f => (f.length = 0)); }
        else {
          const [W, H] = spec.res;
          if (!this.frameCanvas || this.frameCanvas.width !== W || this.frameCanvas.height !== H) { this.frameCanvas = new OffscreenCanvas(W, H); this.frameCtx = this.frameCanvas.getContext('2d', { willReadFrequently: true }); }
          this.frameCtx.drawImage(dec.frame, 0, 0, W, H);
          px = (x, y, w, h) => this.frameCtx.getImageData(x, y, w, h);
        }
      } else px = (x, y, w, h) => a.pixels(x, y, w, h);
      // plates too dark or flat to see anything in (night, no lamp): noise, not a sample
      const lit = (f) => {
        // (and the vehicle itself: a lit plate in a black frame of sensor noise is no sample either)
        const ok = cropLuma(px, f.crop) >= o.minCropLum && f.plates.every(p => { p.luma = plateLuma(px, p.corners, spec.res); return p.luma.mean >= o.minPlateLum && p.luma.std >= o.minPlateStd; });
        if (!ok) { a.why['placa escura'] = (a.why['placa escura'] || 0) + 1; a.why.ok--; a.verdict.set(f.root, 'placa escura'); }
        return ok;
      };
      // (both: rectified plates take more per picture, as in a chars-only run)
      const work = tasks.flatMap((t, ti) => finds[ti].filter(lit).slice(0, t === 'chars' && o.task === 'both' ? o.maxPerChars : o.maxPer).map(f => [t, f]));
      for (const k in a.why) stats.why[k] = (stats.why[k] || 0) + a.why[k];
      const tv = a.verdict.get(pose.target.root) || 'nao avaliado';
      stats.target[tv] = (stats.target[tv] || 0) + 1;
      if (o.trace) stats.trace.push({ ms: Math.round(performance.now() - tCam), res: spec.res.join('x'), hfov: +spec.hfov.toFixed(0), h: +pose.height.toFixed(1), fill: +pose.fill.toFixed(2), ir: !!cctv.irMode, moving: pose.target.moving, kind: pose.target.kind, target: tv, n: work.length, progs: host.renderer.info.programs?.length });
      const hfov = +spec.hfov.toFixed(1);
      for (const [task, f] of work) {
        const n = this.count++;
        const vid = String(f.root.name || f.root.userData.model || 'v').replace(/[^\w-]/g, '');
        const meta = {
          name: `${app.seed}_r${round}c${i}_${String(n).padStart(5, '0')}_${vid}`,
          seed: app.seed, round, cam: i, t: +host.clock().toFixed(2), frame: cctv.frame,
          camera: spec.name, model: spec.id, tier: spec.tier, res: spec.res, kbps: spec.kbps, fps: spec.fps, gop: spec.gop, codec: codec ? codec.name : spec.codec,
          codecMode: codec ? 'real' : 'emulated', frameType: codec ? dec.type : (cctv.lastIntra ? 'I' : 'P'), intra: codec ? dec.type === 'I' : !!cctv.lastIntra,
          kbpsMeasured: codec ? dec.kbpsReal : undefined, qp: codec ? dec.qp : undefined,
          hfov, k: +spec.k.toFixed(4),
          camHeight: +pose.height.toFixed(2), pitch: +pose.pitch.toFixed(1), viewAngle: +pose.view.toFixed(1),
          camPos: pose.position.toArray().map(v => +v.toFixed(2)),
          ir: !!cctv.irMode, exposure: +cctv.exposure.toFixed(4), gain: +cctv.gain.toFixed(2),
          hour: +host.state.hour.toFixed(2), weather: host.state.weather, city: app.site.city,
          vehicle: f.root.name, model3d: f.root.userData.model, vkind: kinds.get(f.root) || 'car',
          wear: f.root.userData.wear?.tier, wearParts: f.root.userData.wear?.parts,
          plate: f.root.userData.plate, plateKind: f.root.userData.plateKind, plateInfo: f.root.userData.plateInfo,
          target: f.root === pose.target.root, moving: f.moving, dist: +f.dist.toFixed(2),
          cut: f.cut, visible: +f.vis.toFixed(3), occluded: +f.occ.toFixed(4),
          box: f.box.map(v => +v.toFixed(2)), crop: f.crop,
          plates: f.plates.map(p => ({ corners: p.corners.map(c => c.map(v => +v.toFixed(3))), width: +p.width.toFixed(1), facing: +p.facing.toFixed(3), kind: p.kind, area: +p.area.toFixed(1), lumaMean: +p.luma.mean.toFixed(1), lumaStd: +p.luma.std.toFixed(1) })),
          labels: f.plates.map(p => yoloLine(p, f.crop)),
        };
        const send = (img, meta) => pending.push(img.then(b => b.arrayBuffer()).then(buf => {
          const u8 = new Uint8Array(buf);
          let s = '';
          for (let q = 0; q < u8.length; q += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(q, q + 0x8000));
          return window.__datasetSample?.(JSON.stringify(meta), btoa(s));
        }).catch(e => console.error('[gen] sample', e)));
        if (task === 'chars') {
          const chars = f.root.userData.plateChars;
          if (!chars || !PLATE_TYPES.includes(meta.plateInfo?.type)) continue;
          const type = segFamily(meta.plateInfo.type);
          const { box, crop, plates, labels, ...common } = meta;
          meta.plates.forEach((pm, k) => {
            const sample = rectifyPlate(px, spec.res, f.plates[k].corners, pm.kind, chars, type, o, r);
            if (!sample) return;
            if (sample.charStd < o.minCharStd) { stats.why['placa ilegivel'] = (stats.why['placa ilegivel'] || 0) + 1; return; }
            stats.samples++;
            // demo (end-to-end ALPR videos): the vehicle crop goes along, plate corners in it
            const demo = o.demo ? (codec ? cropBlob(px, f.crop, o.quality) : a.image(f.crop, 'image/jpeg', o.quality)).then(blobB64) : null;
            const plate = sample.blob;
            if (demo) sample.blob = demo.then(b64 => { sample.demo = { image: b64, crop: f.crop, corners: pm.corners.map(([x, y]) => [+(x - f.crop[0]).toFixed(2), +(y - f.crop[1]).toFixed(2)]) }; return plate; });
            send(sample.blob, { ...common, name: meta.name + '_p' + k, get demo() { return sample.demo; }, task: 'chars', plateType: meta.plateInfo.type, plateSide: pm, jittered: sample.jittered, letterbox: sample.letterbox, boxPad: o.charPad, charStd: +sample.charStd.toFixed(1), chars: sample.chars, labels: sample.labels });
            // now and then a plate-sized quad elsewhere on the vehicle (bumper, grille,
            // lamps), rectified the same way with no characters: what the reader gets
            // when the keypoint model fires on something that is not a plate
            if (!o.demo && r.chance(o.negProb)) {
              const quad = notPlate(f.plates[k].corners, f.plates.map(p => p.corners), f.crop, spec.res, r);
              const neg = quad && rectifyPlate(px, spec.res, quad, pm.kind, [], type, o, r);
              if (neg) {
                stats.samples++;
                send(neg.blob, { ...common, name: meta.name + '_n' + k, task: 'chars', negative: true, plateType: null, quad: quad.map(c => c.map(v => +v.toFixed(2))), letterbox: neg.letterbox, chars: [], labels: [] });
              }
            }
          });
          continue;
        }
        stats.samples++;
        // pixels read now, JPEG-encoded later
        send(codec ? cropBlob(px, f.crop, o.quality) : a.image(f.crop, 'image/jpeg', o.quality), meta);
      }
      tm('annotate', t0);
    } finally {
      host.detach(cctv);
      cctv.dispose();
    }
  }
}

// luma statistics of a plate (its quad's box, 15% in from the edges), output pixels
// mean luma (0-255) of a crop
function cropLuma(px, [x, y, w, h]) {
  const d = px(x, y, w, h).data;
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return n ? s / n : 0;
}

function plateLuma(px, corners, [W, H]) {
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ix = (x1 - x0) * 0.15, iy = (y1 - y0) * 0.15;
  x0 = Math.max(0, Math.floor(x0 + ix)); x1 = Math.min(W, Math.ceil(x1 - ix));
  y0 = Math.max(0, Math.floor(y0 + iy)); y1 = Math.min(H, Math.ceil(y1 - iy));
  if (x1 - x0 < 1 || y1 - y0 < 1) return { mean: 0, std: 0 };
  const d = px(x0, y0, x1 - x0, y1 - y0).data;
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += l; s2 += l * l; n++; }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

const blobB64 = (b) => b.arrayBuffer().then(buf => {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let q = 0; q < u8.length; q += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(q, q + 0x8000));
  return btoa(s);
});

// JPEG of a crop of the decoded frame (pixels copied now, encoded asynchronously)
function cropBlob(px, [x, y, w, h], quality) {
  const img = px(x, y, w, h);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

// ------------------------------------------------------------------ rectified plates
// homography taking the unit square (u, v: 0..1, v down as printed) to the quad
// TL, TR, BR, BL
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
const applyH = (m, u, v) => { const w = m[6] * u + m[7] * v + m[8]; return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w]; };
function invertH(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e, D = f * g - d * i, E = a * i - c * g, F = c * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  const det = a * A + b * D + c * G;
  return [A, B, C, D, E, F, G, Hh, I].map(x => x / det);
}

// a plate seen by the camera, as the plate reader will get it: warped flat from
// its corners (noisy, like the keypoint model's) into a size x size letterbox
// (car plates a wide band, motorcycle plates nearly the whole square), with each
// printed character's box, class = plate type. Pixels from the decoded frame.
function rectifyPlate(px, [W, H], corners, kind, chars, type, o, r) {
  const width = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
  // a share of plates exact, the rest with the keypoint model's typical error
  const sig = !o.jitter || r.chance(o.jitterClean) ? 0 : o.jitter + o.jitterRel * width;
  const jittered = corners.map(([x, y]) => [x + clampG(r, sig), y + clampG(r, sig)]);
  const S = o.size, mm = kind === 'moto' ? [200, 170] : [400, 130];
  const sc = Math.min(S / mm[0], S / mm[1]);
  const pw = Math.round(mm[0] * sc), ph = Math.round(mm[1] * sc);
  const ox = Math.floor((S - pw) / 2), oy = Math.floor((S - ph) / 2);
  const Ht = squareToQuad(corners), Hj = squareToQuad(jittered), Hji = invertH(Hj);
  // source pixels: the jittered quad's box in the frame (+2 px for the bilinear taps)
  const xs = jittered.map(c => c[0]), ys = jittered.map(c => c[1]);
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2), by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const bw = Math.min(W, Math.ceil(Math.max(...xs)) + 2) - bx, bh = Math.min(H, Math.ceil(Math.max(...ys)) + 2) - by;
  if (bw < 2 || bh < 2) return null;
  const src = px(bx, by, bw, bh).data;
  // a plate bigger in the frame than in the letterbox is averaged over n x n taps
  // per output pixel (area reduction) instead of one bilinear tap that would alias
  const height = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]);
  const ns = Math.max(1, Math.min(4, Math.ceil(Math.max(width / pw, height / ph))));
  const acc = [0, 0, 0];
  const out = new ImageData(S, S), d = out.data;
  d.fill(114);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;   // (opaque: JPEG would blend 114 alpha to ~51)
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    acc[0] = acc[1] = acc[2] = 0;
    for (let sy = 0; sy < ns; sy++) for (let sx = 0; sx < ns; sx++) {
      let [fx, fy] = applyH(Hj, (x + (sx + 0.5) / ns) / pw, (y + (sy + 0.5) / ns) / ph);
      fx -= bx + 0.5; fy -= by + 0.5;
      const x0 = Math.max(0, Math.min(bw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(bh - 2, Math.floor(fy)));
      const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
      const i00 = (y0 * bw + x0) * 4, i10 = i00 + 4, i01 = i00 + bw * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) acc[ch] += (src[i00 + ch] * (1 - ax) + src[i10 + ch] * ax) * (1 - ay) + (src[i01 + ch] * (1 - ax) + src[i11 + ch] * ax) * ay;
    }
    const o4 = ((oy + y) * S + ox + x) * 4;
    for (let ch = 0; ch < 3; ch++) d[o4 + ch] = acc[ch] / (ns * ns);
    d[o4 + 3] = 255;
  }
  // character boxes: printed position -> frame (true corners) -> rectified (jittered)
  const labels = [], boxes = [], padded = [];
  const [padX, padY] = o.charPad || [0, 0];
  for (const c of chars) {
    const q = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([u, v]) => {
      const [fx, fy] = applyH(Ht, u, v);
      const [uu, vv] = applyH(Hji, fx, fy);
      return [ox + uu * pw, oy + vv * ph];
    });
    const x0 = Math.max(ox, Math.min(...q.map(p => p[0]))), x1 = Math.min(ox + pw, Math.max(...q.map(p => p[0])));
    const y0 = Math.max(oy, Math.min(...q.map(p => p[1]))), y1 = Math.min(oy + ph, Math.max(...q.map(p => p[1])));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    boxes.push([c.ch, Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)]);
    // the label: the glyph's box with a little room around it (the stroke's soft edge,
    // the stamped relief's bevel), never past the plate
    const bx0 = Math.max(ox, x0 - (x1 - x0) * padX), bx1 = Math.min(ox + pw, x1 + (x1 - x0) * padX);
    const by0 = Math.max(oy, y0 - (y1 - y0) * padY), by1 = Math.min(oy + ph, y1 + (y1 - y0) * padY);
    padded.push([c.ch, bx0, by0, bx1, by1]);
    labels.push(`${type} ${((bx0 + bx1) / 2 / S).toFixed(6)} ${((by0 + by1) / 2 / S).toFixed(6)} ${((bx1 - bx0) / S).toFixed(6)} ${((by1 - by0) / S).toFixed(6)}`);
  }
  if (!labels.length && chars.length) return null;
  // and one box around the whole plate, classed with its type (3 + family)
  if (chars.length) labels.push(`${3 + type} ${((ox + pw / 2) / S).toFixed(6)} ${((oy + ph / 2) / S).toFixed(6)} ${(pw / S).toFixed(6)} ${(ph / S).toFixed(6)}`);
  // readable at all? luma spread over the character boxes (ink against the plate),
  // measured on a box blur about a stroke wide: sensor noise averages out, strokes stay
  const lum = new Float64Array((S + 1) * (S + 1));     // integral image of luma
  for (let y = 0; y < S; y++) {
    let row = 0;
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      row += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum[(y + 1) * (S + 1) + x + 1] = lum[y * (S + 1) + x + 1] + row;
    }
  }
  const charH = boxes.reduce((m, b) => m + b[4] - b[2], 0) / Math.max(1, boxes.length);
  const k = Math.max(1, Math.round(charH / 16));       // half window
  let s1 = 0, s2 = 0, n = 0;
  for (const [, x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ax = Math.max(0, x - k), bx2 = Math.min(S, x + k + 1), ay = Math.max(0, y - k), by2 = Math.min(S, y + k + 1);
    const l = (lum[by2 * (S + 1) + bx2] - lum[ay * (S + 1) + bx2] - lum[by2 * (S + 1) + ax] + lum[ay * (S + 1) + ax]) / ((bx2 - ax) * (by2 - ay));
    s1 += l; s2 += l * l; n++;
  }
  const charStd = n ? Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2)) : 0;
  // OCR labels for later: each box with its character, normalised like the YOLO lines
  const chs = padded.map(([ch, x0, y0, x1, y1]) => [ch, +((x0 + x1) / 2 / S).toFixed(6), +((y0 + y1) / 2 / S).toFixed(6), +((x1 - x0) / S).toFixed(6), +((y1 - y0) / S).toFixed(6)]);
  const cv = new OffscreenCanvas(S, S);
  cv.getContext('2d').putImageData(out, 0, 0);
  return { blob: cv.convertToBlob({ type: 'image/jpeg', quality: o.quality }), labels, charStd, chars: chs, jittered: jittered.map(c => c.map(v => +v.toFixed(2))), letterbox: [ox, oy, pw, ph] };
}
// a plate-shaped quad on the same vehicle that misses every plate: the plate moved
// along its own up (the body above it) and sideways, scaled a little, inside the
// vehicle's crop and the frame. null when nothing fits after a few tries
function notPlate(corners, plates, [cx, cy, cw, ch], [W, H], r) {
  const [tl, tr, br, bl] = corners;
  const mid = corners.reduce((a, c) => [a[0] + c[0] / 4, a[1] + c[1] / 4], [0, 0]);
  const up = [(tl[0] + tr[0] - bl[0] - br[0]) / 2, (tl[1] + tr[1] - bl[1] - br[1]) / 2];
  const right = [(tr[0] + br[0] - tl[0] - bl[0]) / 2, (tr[1] + br[1] - tl[1] - bl[1]) / 2];
  const boxOf = (q) => [Math.min(...q.map(c => c[0])), Math.min(...q.map(c => c[1])), Math.max(...q.map(c => c[0])), Math.max(...q.map(c => c[1]))];
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const taken = plates.map(boxOf);
  for (let k = 0; k < 8; k++) {
    const u = r.float(1.2, 5), v = r.float(-1.3, 1.3), s = r.float(0.8, 1.4);
    const c = [mid[0] + up[0] * u + right[0] * v, mid[1] + up[1] * u + right[1] * v];
    const q = corners.map(([x, y]) => [c[0] + (x - mid[0]) * s, c[1] + (y - mid[1]) * s]);
    const b = boxOf(q);
    if (b[0] < Math.max(2, cx) || b[1] < Math.max(2, cy) || b[2] > Math.min(W - 2, cx + cw) || b[3] > Math.min(H - 2, cy + ch)) continue;
    if (taken.some(t => hit(t, b))) continue;
    return q;
  }
  return null;
}

// gaussian noise cut at 2.5 sigma
const clampG = (r, s) => Math.max(-2.5 * s, Math.min(2.5 * s, r.gauss(0, s)));
