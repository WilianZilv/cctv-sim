// Plate material check: puts the CCTV camera (and its IR lamp) in front of a car's
// plate and saves a frame. Headless.
//   node tools/plate-look.mjs out.png "seed=x&hour=12" '{"dist":0.7,"fov":40,"pick":"front|graze|sun|moto","az":0,"el":0}'
// pick: 'graze' takes the plate whose face is most edge-on to the sun, 'sun' the
// one facing it most, 'moto' a motorcycle plate, a number the n-th plate by
// distance from the camera. az/el (degrees) swing the camera around the plate.
// dist <= 0 keeps the camera where it is and only crops around the plate (CCTV view).
import { chromium } from 'playwright-core';

const [out = 'shots/plate-look.png', query = 'hour=12', optsJson = '{}'] = process.argv.slice(2);
const opts = { dist: 0.7, fov: 40, pick: 0, az: 0, el: 0, raw: false, ...JSON.parse(optsJson) };
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PE', e.message));
p.on('console', m => { const t = m.text(); if (/error|shader|program|webgl/i.test(t) && !/X4000|X4122|X3595|Mismatch between texture format/.test(t) && !/\[progs\]/.test(t)) console.log('C', t.slice(0, 600)); });
await p.goto(`http://localhost:30140/?${query}${opts.raw ? '&raw' : ''}&shadercheck=1&capture&codec=emulated`);
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 180000 });
const err = await p.evaluate(() => window.__error);
if (err) { console.log('ERROR', err); await b.close(); process.exit(1); }
const info = await p.evaluate(async (o) => {
  const app = window.__app();
  // which cars stand still (parked): positions a second apart
  const pos0 = new Map();
  app.scene.traverse(obj => { if (obj.userData?.plates?.length) pos0.set(obj, obj.getWorldPosition(obj.position.clone())); });
  await new Promise(r => setTimeout(r, 1200));
  const cam = app.cctv.camera;
  const sun = window.__gu.uSunWorld.value;
  const list = [];
  app.scene.traverse(obj => {
    const pl = obj.userData?.plates;
    if (!pl?.length || !obj.visible) return;
    if (o.still !== false && pos0.has(obj) && obj.getWorldPosition(obj.position.clone()).distanceTo(pos0.get(obj)) > 0.01) return;
    obj.updateMatrixWorld(true);
    for (const pp of pl) {
      const m = obj.matrixWorld.clone().multiply(pp.m);
      const e = m.elements;
      const c = { x: e[12], y: e[13], z: e[14] };
      const Z = { x: e[8], y: e[9], z: e[10] }, X = { x: e[0], y: e[1], z: e[2] }, Y = { x: e[4], y: e[5], z: e[6] };
      const d = Math.hypot(c.x - cam.position.x, c.y - cam.position.y, c.z - cam.position.z);
      list.push({ obj, pm: pp.m, m, c, X, Y, Z, mm: pp.mm, d, sunDot: Z.x * sun.x + Z.y * sun.y + Z.z * sun.z, toCam: (Z.x * (cam.position.x - c.x) + Z.y * (cam.position.y - c.y) + Z.z * (cam.position.z - c.z)) / d });
    }
  });
  if (!list.length) return { err: 'no plates' };
  list.sort((a, b) => a.d - b.d);
  let t;
  if (o.pick === 'graze') t = list.filter(q => q.mm[0] > 300).sort((a, b) => Math.abs(a.sunDot - 0.12) - Math.abs(b.sunDot - 0.12))[0];
  else if (o.pick === 'sun') t = list.filter(q => q.mm[0] > 300).sort((a, b) => b.sunDot - a.sunDot)[0];
  else if (o.pick === 'moto') t = list.find(q => q.mm[0] < 300) || list[0];
  else if (o.pick === 'visible') t = list.filter(q => q.toCam > 0.3)[0] || list[0];
  else t = list[+o.pick] || list[0];
  // follow the plate every frame (traffic keeps moving): the camera takes its
  // pose from ctx.cameraPose (plus the live config's mount offset, measured here)
  const off = cam.position.clone().sub(app.ctx.cameraPose.position);
  const update = () => {
    const e = t.obj.matrixWorld.clone().multiply(t.pm).elements;
    t.c = { x: e[12], y: e[13], z: e[14] };
    t.X = { x: e[0], y: e[1], z: e[2] }; t.Y = { x: e[4], y: e[5], z: e[6] }; t.Z = { x: e[8], y: e[9], z: e[10] };
    if (o.dist <= 0) return;
    const az = o.az * Math.PI / 180, el = o.el * Math.PI / 180;
    const dir = {};
    for (const k of ['x', 'y', 'z']) dir[k] = (t.Z[k] * Math.cos(az) + t.X[k] * Math.sin(az)) * Math.cos(el) + t.Y[k] * Math.sin(el);
    const P = { x: t.c.x + dir.x * o.dist, y: t.c.y + dir.y * o.dist, z: t.c.z + dir.z * o.dist };
    const dx = t.c.x - P.x, dy = t.c.y - P.y, dz = t.c.z - P.z;
    app.ctx.cameraPose = { position: cam.position.clone().set(P.x - off.x, P.y - off.y, P.z - off.z), yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), roll: 0 };
    if (o.fov && cam.fov !== o.fov) { cam.fov = o.fov; cam.updateProjectionMatrix(); }
  };
  // a test lamp skimming the plate face from the left (o.graze: degrees above the face)
  if (o.graze != null) {
    const sun = app.scene.getObjectByProperty('isDirectionalLight', true);
    const L = sun.clone(); L.castShadow = false; L.intensity = o.lampI || 4; L.color.set('#ffffff');
    app.scene.add(L, L.target);
    const a = o.graze * Math.PI / 180;
    const upd = () => { L.target.position.set(t.c.x, t.c.y, t.c.z); L.position.set(t.c.x + (-t.X.x * Math.cos(a) + t.Z.x * Math.sin(a)) * 5 + t.Y.x * 1.5, t.c.y + (-t.X.y * Math.cos(a) + t.Z.y * Math.sin(a)) * 5 + t.Y.y * 1.5, t.c.z + (-t.X.z * Math.cos(a) + t.Z.z * Math.sin(a)) * 5 + t.Y.z * 1.5); };
    window.__lampUpd = upd;
  }
  if (o.ns) app.scene.traverse(m => { for (const mt of [].concat(m.material || [])) if (mt.userData?.plate) mt.normalScale.set(o.ns, o.ns); });
  window.__plateFrames = 0;
  const loop = () => { update(); window.__lampUpd?.(); window.__plateFrames++; requestAnimationFrame(loop); };
  loop();  window.__plateTarget = t;
  return { n: list.length, d: t.d, mm: t.mm, sunDot: t.sunDot, toCam: t.toCam, ir: !!app.cctv.irMode, irLight: app.irLight?.visible, uIR: window.__gu.uIR.value, sunEl: app.env.state.sunEl, plate: t.obj.userData.plate, info: t.obj.userData.plateInfo };
}, opts);
console.log(JSON.stringify(info));
// enough frames for the camera to capture a few times at the new pose
await p.waitForFunction((n) => window.__plateFrames > n, opts.frames || 40, { timeout: 120000 });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => ({ cam: window.__app().cctv.camera.position.toArray().map(v => +v.toFixed(2)), tgt: [window.__plateTarget.c.x, window.__plateTarget.c.y, window.__plateTarget.c.z].map(v => +v.toFixed(2)), st: { speed: window.__state.speed, paused: window.__state.paused, hour: window.__state.hour }, fr: window.__plateFrames, ir: !!window.__app().cctv.irMode, irLight: window.__app().irLight?.visible, uIR: window.__gu.uIR.value, exposure: window.__app().cctv.exposure }))));
// screen box of the plate corners, for the CCTV-distance crop
const box = await p.evaluate(() => {
  const app = window.__app(), t = window.__plateTarget, cam = app.cctv.camera;
  const cv = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = cv.getBoundingClientRect();
  const pts = [];
  const w = t.mm[0] / 2000, h = t.mm[1] / 2000;
  for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
    const P = cam.position.clone().set(t.c.x + t.X.x * sx * w + t.Y.x * sy * h, t.c.y + t.X.y * sx * w + t.Y.y * sy * h, t.c.z + t.X.z * sx * w + t.Y.z * sy * h);
    P.project(cam);
    pts.push([r.left + (P.x * 0.5 + 0.5) * r.width, r.top + (0.5 - P.y * 0.5) * r.height]);
  }
  return pts;
});
if (opts.dist > 0) await p.screenshot({ path: out });
else {
  const xs = box.map(q => q[0]), ys = box.map(q => q[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const s = Math.max(60, (Math.max(...xs) - Math.min(...xs)) * 3);
  await p.screenshot({ path: out.replace(/\.png$/, '-full.png') });
  const x0 = Math.min(1280 - s, Math.max(0, cx - s / 2)), y0 = Math.min(720 - s * 0.6, Math.max(0, cy - s * 0.3));
  await p.screenshot({ path: out, clip: { x: Math.max(0, x0), y: Math.max(0, y0), width: Math.min(s, 1280), height: Math.min(s * 0.6, 720) } });
  console.log('corners', JSON.stringify(box.map(q => q.map(Math.round))));
}
console.log('->', out);
await b.close();
