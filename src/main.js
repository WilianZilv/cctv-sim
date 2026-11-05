import * as THREE from 'three';
import GUI from 'lil-gui';
import { runTexGallery } from './debug/texgallery.js';
import { FreeCam } from './debug/freecam.js';
import { randomSeed, Rng } from './core/rng.js';
import { buildWorld } from './world/index.js';
import { Environment, WEATHERS } from './env/environment.js';
import { localDate } from './env/sun.js';
import { CCTVCamera } from './cam/cctv.js';
import { pickCamera, CAMERA_MODELS, TIERS } from './cam/models.js';
import { globalUniforms } from './tex/matlib.js';
import { Simulation } from './agents/simulation.js';
import { CodecLink } from './cam/codec.js';
import { StreetGI } from './env/gi.js';
import { buildSkyVisibility } from './env/skyvis.js';
import { SSAO } from './env/ssao.js';
import { MapPicker } from './ui/mappicker.js';
import { GradeEditor } from './ui/gradeeditor.js';
import { CarProbes } from './vehicles/probes.js';
import { SilhouetteShadows } from './env/silhouettes.js';
import { prof } from './debug/prof.js';
import { Annotator, yoloLine } from './cam/annotate.js';
import { LOOKS, applyGrade } from './cam/grade.js';
import { SCHEMA, getPath, loadConfig, saveConfig, resetConfig, applySpecOverrides } from './config.js';

const params = new URLSearchParams(location.search);
const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const helpEl = document.getElementById('help');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
// checking every program for errors makes the driver finish compiling it on the spot,
// which defeats parallel shader compilation; ?shadercheck=1 turns it back on
renderer.debug.checkShaderErrors = params.get('shadercheck') === '1';
renderer.shadowMap.enabled = true;
// shadow maps are redrawn on demand (see loop): the street is static and the sun slow
renderer.shadowMap.autoUpdate = false;
let lastShadow = -1e9;
prof.attach(renderer);
if (prof.on) window.THREE = THREE;
// per-section draw counts need the counters to run over the whole frame
if (prof.on) renderer.info.autoReset = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the camera pipeline encodes itself
view.appendChild(renderer.domElement);
// decoded video from the real encoder is shown here
const display = document.createElement('canvas');
display.style.display = 'none';
view.appendChild(display);
const showDecoded = (on) => { display.style.display = on ? 'block' : 'none'; renderer.domElement.style.display = on ? 'none' : 'block'; };

const log = (msg) => { statusEl.textContent = msg; };

if (params.get('debug') === 'tex') {
  renderer.domElement.style.aspectRatio = 'auto';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  runTexGallery(renderer, document.body).then(() => { window.__ready = true; }).catch(e => { window.__error = e.message; console.error(e); });
} else {
  start();
}

// Seeded defaults for date/time/weather; URL and UI can override.
function seededConditions(seed, cityKey) {
  const r = new Rng(seed + '/conditions');
  const month = r.int(1, 12);
  const day = r.int(1, 28);
  const hour = r.weighted([[r.float(6, 9), 2], [r.float(9, 16), 4], [r.float(16, 19), 2.5], [r.float(19, 24), 2], [r.float(0, 6), 1.2]]);
  const rainy = month >= 10 || month <= 3;
  const fogBias = cityKey === 'cwb' && (month >= 5 && month <= 8) && hour < 10 ? 3 : 0.3;
  const weather = r.weighted([['clear', 3], ['partly', 3], ['overcast', 2.5], ['wet', rainy ? 1.5 : 0.6], ['drizzle', cityKey === 'cwb' ? 1.5 : 0.8], ['rain', rainy ? 1.2 : 0.3], ['fog', fogBias]]);
  return { year: 2026, month, day, hour, weather };
}

async function start() {
  const cfg = loadConfig();
  // streaming mode (tools/stream.mjs): ?stream=1 sends every encoded chunk out through
  // window.__streamChunk (a Playwright binding); ?vcodec=h264|h265 fixes the codec
  // so a stream keeps its format across seed changes
  const streaming = params.get('stream') === '1';
  // generator mode (tools/dataset.mjs, src/gen.js): no display loop; the page drives
  // the simulation and its own cameras as fast as the GPU goes
  const genMode = params.get('gen') === '1';
  if (params.get('vcodec')) cfg.codec.codec = params.get('vcodec') === 'h265' ? 'H.265' : 'H.264';
  const state = {
    seed: params.get('seed') || randomSeed(),
    city: params.get('city') || 'any',
    hour: 12, weather: 'clear', month: 6, day: 15, speed: 1,
    paused: false, raw: params.has('raw'), free: params.has('free'),
    // explicit place chosen on the map; null = seed picks a random street
    location: params.has('lat') && params.has('lon') ? { lat: +params.get('lat'), lon: +params.get('lon') } : null,
  };
  // grade saved by an older version (adjustments instead of a full state)
  if (!Array.isArray(cfg.grade.lift)) Object.assign(cfg.grade, structuredClone(LOOKS.natural), { look: 'natural' });
  applyGrade(cfg.grade);
  let gradeSave = null;
  const gradeEditor = new GradeEditor((g) => {
    Object.assign(cfg.grade, g);
    applyGrade(cfg.grade);
    clearTimeout(gradeSave);
    gradeSave = setTimeout(() => saveConfig(cfg), 300);
  });
  gradeEditor.set(cfg.grade);
  window.__grade = gradeEditor;
  const picker = new MapPicker((loc) => {
    state.location = loc;
    poseOverride = null;
    freecam.placed = false;
    rebuild({ keepConditions: true });
  });
  let app = null;
  let baker = null;
  let building = false;
  let pendingRebuild = null;
  let poseOverride = null;   // set by "install the camera here" in free mode
  const freecam = new FreeCam(view);
  if (params.get('pom') === '0') globalUniforms.uPomFar.value = 0;
  if (params.has('pomboost')) globalUniforms.uPomBoost.value = +params.get('pomboost');
  const ssao = params.get('ssao') === '0' ? null : new SSAO(renderer);

  // ---------------------------------------------------------------- UI
  const gui = new GUI({ title: 'Simulador CCTV' });
  gui.domElement.style.setProperty('--width', '310px');
  const fScene = gui.addFolder('Cena');
  fScene.add({ f: () => openMap() }, 'f').name('Escolher local no mapa (M)');
  fScene.add(state, 'seed').name('Seed').onFinishChange(() => rebuild({ keepConditions: false }));
  fScene.add(state, 'city', { 'Qualquer': 'any', 'São Paulo': 'sp', 'Curitiba': 'cwb' }).name('Cidade').onChange(() => rebuild({ keepConditions: false }));
  fScene.add({ f: () => { state.seed = randomSeed(); state.location = null; poseOverride = null; refreshGui(); rebuild({ keepConditions: false }); } }, 'f').name('Gerar nova cena em local aleatório');
  fScene.add({ f: () => { state.seed = randomSeed(); poseOverride = null; refreshGui(); rebuild({ keepConditions: true }); } }, 'f').name('Variar a cena no mesmo local');
  fScene.add({ f: () => rebuild({ keepConditions: true }) }, 'f').name('Regerar com os parâmetros atuais');
  fScene.add(state, 'free').name('Câmera livre (tecla F)').onChange(v => setFree(v));
  fScene.add({ f: () => installHere() }, 'f').name('Instalar a câmera de segurança aqui');

  const fEnv = gui.addFolder('Condições');
  fEnv.add(state, 'hour', 0, 23.99, 0.01).name('Hora').onChange(() => applyConditions());
  fEnv.add(state, 'month', 1, 12, 1).name('Mês').onChange(() => applyConditions());
  fEnv.add(state, 'weather', Object.fromEntries(Object.entries(WEATHERS).map(([k, v]) => [v.label, k]))).name('Clima').onChange(() => applyConditions());
  fEnv.add(state, 'speed', 0, 60, 0.1).name('Velocidade do tempo');
  fEnv.add(state, 'paused').name('Pausar');

  const fGen = gui.addFolder('Gerador');
  fGen.close();
  const camInfo = { model: '', res: '', fps: '', bitrate: '', mount: '', codec: '' };
  const camModels = { 'Automático (seed)': 'auto', ...Object.fromEntries(CAMERA_MODELS.map(m => [TIERS[m.tier].split(' ')[0] + ': ' + m.name, m.id])) };
  const camTiers = { 'Qualquer (proporção real)': 'auto', ...Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [v, k])) };
  for (const sec of SCHEMA) {
    const isCam = sec.folder.startsWith('Câmera') || sec.folder.startsWith('Imagem');
    const f = (isCam ? gui : fGen).addFolder(sec.folder);
    f.close();
    if (sec.folder === 'Câmera: instalação') {
      f.add(cfg.camera, 'tier', camTiers).name('Categoria').onChange(() => { saveConfig(cfg); rebuildCamera(); });
      f.add(cfg.camera, 'model', camModels).name('Modelo').onChange(() => { saveConfig(cfg); rebuildCamera(); });
    }
    for (const [path, label, a, b, step, apply] of sec.items) {
      const [g, key] = path.split('.');
      const obj = cfg[g];
      let c;
      if (a === null) c = f.add(obj, key);
      else if (typeof a === 'object') c = f.add(obj, key, a);
      else c = f.add(obj, key, a, b, step);
      c.name(label);
      const handler = () => {
        saveConfig(cfg);
        if (apply === 'rebuild') scheduleRebuild();
        else if (apply === 'camera') rebuildCamera();
        else applyLive();
      };
      if (apply === 'live') c.onChange(handler); else c.onFinishChange(handler);
    }
    if (sec.folder.startsWith('Imagem')) f.add({ open: () => gradeEditor.toggle(true) }, 'open').name('Editor de color grading (L)');
    if (sec.folder === 'Câmera: gravação') {
      f.add(camInfo, 'model').name('Modelo em uso').disable();
      f.add(camInfo, 'res').name('Resolução').disable();
      f.add(camInfo, 'fps').name('FPS / GOP').disable();
      f.add(camInfo, 'bitrate').name('Bitrate').disable();
      f.add(camInfo, 'mount').name('Instalação').disable();
      f.add(camInfo, 'codec').name('Codec (real)').disable();
    }
  }
  const fTools = gui.addFolder('Ferramentas');
  fTools.close();
  fTools.add(state, 'raw').name('Ver render limpo (sem câmera)');
  const rec = { on: false, toggle: () => toggleRecording() };
  const recCtl = fTools.add(rec, 'toggle').name('Gravar stream do codec');
  fTools.add({ f: () => { resetConfig(cfg); saveConfig(cfg); refreshGui(); gradeEditor.set(cfg.grade); applyGrade(cfg.grade); rebuild({ keepConditions: true }); } }, 'f').name('Restaurar parâmetros padrão');
  fTools.add({ f: () => navigator.clipboard?.writeText(JSON.stringify({ seed: state.seed, cfg }, null, 1)) }, 'f').name('Copiar parâmetros (JSON)');
  if (params.has('capture') || genMode) gui.hide();

  function refreshGui() { gui.controllersRecursive().forEach(c => c.updateDisplay()); }
  function scheduleRebuild() {
    clearTimeout(pendingRebuild);
    pendingRebuild = setTimeout(() => rebuild({ keepConditions: true }), 500);
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (picker.isOpen) return;
    if (e.code === 'KeyM') openMap();
    if (e.code === 'KeyL') gradeEditor.toggle();
    if (e.code === 'KeyF') { state.free = !state.free; setFree(state.free); refreshGui(); }
    if (e.code === 'KeyG' && e.shiftKey) { state.seed = randomSeed(); state.location = null; poseOverride = null; refreshGui(); rebuild({ keepConditions: false }); }
  });

  function openMap() {
    const site = app?.site;
    picker.open(site ? { lat: site.lat, lon: site.lon } : null);
  }

  // ---------------------------------------------------------------- time
  let simClock = 0;
  let baseDate = null;
  const currentDate = () => new Date(baseDate.getTime() + simClock * 1000);

  function applyConditions() {
    lastShadow = -1e9;
    if (!app) return;
    const h = Math.floor(state.hour), mi = Math.floor((state.hour - h) * 60);
    baseDate = localDate(2026, state.month, Math.min(state.day, 28), h, mi, -3);
    simClock = 0;
    app.env.configure(currentDate(), state.weather);
    app.ctx.month = state.month;
  }

  // ---------------------------------------------------------------- camera + codec
  function cameraPose() {
    const base = poseOverride || app.ctx.cameraPose;
    const c = cfg.camera;
    const d = THREE.MathUtils.degToRad;
    return {
      position: base.position.clone().add(new THREE.Vector3(0, c.height, 0)),
      euler: new THREE.Euler(base.pitch + d(c.pitch), base.yaw + d(c.yaw), base.roll + d(c.roll), 'YXZ'),
    };
  }

  // the mount's aim (map/layout.js) is chosen before the lens: fine for a wide one,
  // but a long lens on that aim sees a patch of pavement. With a narrow field of view
  // the installer points it at the cars instead: a parked car seen from front or back
  // (its plate toward the camera), at the distance where it fills about half the frame
  function aimForLens(ctx, spec) {
    const p0 = ctx.cameraPose0 || (ctx.cameraPose0 = { ...ctx.cameraPose });
    ctx.cameraPose = { ...p0 };
    if (spec.hfov >= 75 || !ctx.parked?.length) return;
    const r = new Rng(state.seed + '/aim');
    const half = THREE.MathUtils.degToRad(spec.hfov / 2);
    const ideal = 2.25 / Math.tan(half) * 2;
    const P = p0.position;
    const cand = [];
    for (const c of ctx.parked) {
      const dx = c.position.x - P.x, dz = c.position.z - P.z, d = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dx, -dz);
      // the side of the street the installer faces
      const turn = Math.abs(((yaw - p0.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (turn > 1.2 || d < 3) continue;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
      const endOn = Math.abs(fwd.x * dx + fwd.z * dz) / d;
      cand.push({ c, d, yaw, fwd, s: Math.abs(Math.log(d / ideal)) + (1 - endOn) * 1.5 + r.float(0, 0.3) });
    }
    cand.sort((a, b) => a.s - b.s);
    // in sight: no wall, house or tree between the mount and the end of the car facing it
    const world = [];
    app.scene.traverse(o => { if (o.isMesh && o.visible && !o.isSkinnedMesh) world.push(o); });
    const vehicles = new Set();
    for (const c of [...ctx.parked, ...(ctx.traffic?.cars || []).map(k => k.obj)]) c.traverse(o => vehicles.add(o));
    const blockers = world.filter(o => !vehicles.has(o));
    const ray = new THREE.Raycaster();
    let best = null;
    for (const k of cand.slice(0, 6)) {
      const end = k.c.position.clone().addScaledVector(k.fwd, (k.fwd.x * (P.x - k.c.position.x) + k.fwd.z * (P.z - k.c.position.z) > 0 ? 1 : -1) * 2);
      end.y += 0.5;
      const dir = end.clone().sub(P);
      const len = dir.length();
      ray.set(P, dir.normalize());
      ray.far = len - 0.5;
      if (!ray.intersectObjects(blockers, false).length) { best = k; break; }
    }
    if (!best) return;
    const ty = best.c.position.y + 0.6;
    ctx.cameraPose = { ...p0, yaw: best.yaw + r.gauss(0, half * 0.25), pitch: -Math.atan2(P.y - ty, best.d) + r.gauss(0, half * 0.15) };
  }

  async function makeCamera() {
    const { scene, env } = app;
    let spec = pickCamera(new Rng(state.seed + '/camera'), cfg.camera.tier, cfg.camera.model);
    spec = applySpecOverrides(spec, cfg);
    aimForLens(app.ctx, spec);
    // streaming: every model is delivered at the stream's fixed resolution
    // (as if the model were made at that resolution: its bitrate scales with the pixels,
    // so each model keeps its own compression: a cheap DVR still breaks up, a good IP
    // camera stays clean)
    // (the generator makes its own cameras: this one only serves the build, keep it small)
    const vres = params.get('vres') || (genMode ? '1280x720' : null);
    if (vres) {
      const [w, h] = vres.split('x').map(Number);
      if (w > 0 && h > 0) spec = { ...spec, res: [w, h], kbps: Math.max(256, Math.round(spec.kbps * (w * h) / (spec.res[0] * spec.res[1]))) };
    }
    const cctv = new CCTVCamera(renderer, spec, state.seed);
    if (ssao) cctv.postRender = (depth, cam, w, h) => ssao.fromDepth(depth, cam, w, h);
    cctv.applyLive(cfg);
    // IR LEDs, or the warm white LEDs of full-colour models
    const irLight = new THREE.SpotLight(spec.nightColor ? '#ffe2b8' : '#ffffff', 0, spec.irRange * 2.2, THREE.MathUtils.degToRad(Math.min(80, spec.hfov * 0.42)), 0.8, 2);
    irLight.position.set(0, 0, 0.05);
    irLight.target.position.set(0, 0, -1);
    cctv.camera.add(irLight, irLight.target);
    scene.add(cctv.camera);
    app.irLight = irLight;
    env.setIR = (ir, lamp = ir) => {
      globalUniforms.uIR.value = ir ? 1 : 0;
      irLight.intensity = lamp ? spec.irRange * spec.irRange * (spec.nightColor ? 0.00025 : 0.0005) : 0;
      // strictly boolean: three counts visible === undefined as visible, which would
      // change the light count (and every shader) against what was precompiled
      irLight.visible = !!lamp;
    };
    let codec = null;
    if (CodecLink.supported() && params.get('codec') !== 'emulated' && !genMode) {
      codec = new CodecLink(spec, display);
      // nobody watches the page while streaming: skip the local decode
      codec.noDecode = streaming;
      if (await codec.init()) cctv.codecMode = 'real'; else { codec.dispose(); codec = null; }
    }
    if (codec && streaming && window.__streamChunk) {
      const onChunk = codec.onChunk.bind(codec);
      const hevc = codec.codecName === 'H.265';
      codec.onChunk = (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        window.__streamChunk(btoa(s), chunk.type === 'key', chunk.timestamp, hevc, spec.fps);
        onChunk(chunk);
      };
    }
    app.cctv = cctv;
    app.codec = codec;
    app.spec = spec;
    // dataset mode (tools/dataset.mjs, tools/stream.mjs --dataset): vehicle crops with
    // plate keypoints, from the camera's own output
    if (params.get('dataset') === '1') {
      const num = (k, d) => (params.get(k) ? +params.get(k) : d);
      app.annot = new Annotator(renderer, cctv, app.ctx, { minCar: num('mincar', 300), minPlate: num('minplate', 14), maxDist: num('maxdist', 70) });
      app.annotRng = new Rng(state.seed + '/dataset');
    }
    if (!state.free) renderer.setSize(spec.res[0], spec.res[1], false);
    updateCamInfo();
  }

  async function rebuildCamera() {
    if (!app) return;
    app.codec?.dispose();
    if (app.cctv) { app.scene.remove(app.cctv.camera); app.cctv.dispose(); }
    await makeCamera();
  }

  function applyLive() {
    if (!app) return;
    app.cctv.applyLive(cfg);
    baker?.setFilter(cfg.tex.filter, cfg.tex.aniso);
    for (const l of app.env.lights) l.disabled = !cfg.props.streetlightsOn;
  }

  function updateCamInfo() {
    const { spec, codec, layout } = app;
    camInfo.model = spec.name;
    camInfo.res = `${spec.res[0]}x${spec.res[1]}`;
    camInfo.fps = `${spec.fps} fps, GOP ${spec.gop}`;
    camInfo.bitrate = `${spec.kbps} kbps ${spec.codec}`;
    camInfo.mount = poseOverride ? 'posição manual' : `${layout.camera.kind}, ${layout.camera.h.toFixed(1)} m, ${layout.camera.quality}`;
    camInfo.codec = codec ? `${codec.codecName} WebCodecs` : 'emulado (DCT)';
    refreshGui();
  }

  // illuminance at the camera (sky, sun, street lamps): what the IR-cut photocell reads
  function ambientLux(env, at) {
    let art = 0;
    for (const l of env.lights) if (l.light.visible && l.light.position) art += l.light.intensity * 1000 / Math.max(9, l.light.position.distanceToSquared(at));
    return (env.state.sunE || 0) * 1000 * 0.3 + (env.state.skyLux || 0) + art;
  }

  // ---------------------------------------------------------------- world
  async function rebuild({ keepConditions }) {
    if (building) { scheduleRebuild(); return; }
    building = true;
    const prevSeed = app?.seed;
    if (app) disposeApp(app);
    app = null;
    // stage timings for tools/genprofile.mjs
    let tS = performance.now();
    const tR = tS;
    const T = (label) => { const n = performance.now(); console.log('[sim] ' + label, Math.round(n - tS), 'ms'); tS = n; };
    try {
      const w = await buildWorld(state.seed, { city: state.city, location: state.location }, renderer, log, cfg, baker);
      baker = w.ctx.lib.baker;
      tS = performance.now();
      const { scene, ctx, site, layout } = w;
      if (prevSeed !== state.seed) poseOverride = null;
      const env = new Environment(scene, renderer, site, baker.get('noise').map);
      env.lights.push(...ctx.lights);
      env.nightEmissive.push(...ctx.nightEmissive);
      env.setFocus(new THREE.Vector3(ctx.focus[0], ctx.cameraPose.position.y - 3, ctx.focus[1]));
      app = { scene, ctx, site, layout, env, seed: state.seed };
      T('environment');
      app.sim = new Simulation(ctx, scene, state.seed, null);
      T('simulation');
      app.gi = params.get('gi') === '0' ? null : new StreetGI(renderer, ctx, ctx.focus, 100);
      T('gi');
      app.skyvis = params.get('skyvis') === '0' ? null : buildSkyVisibility(ctx, ctx.focus, 180);
      T('skyvis');
      await makeCamera();
      T('camera');
      applyLive();
      if (!keepConditions) {
        const c = seededConditions(state.seed, site.cityKey);
        const pu = (k) => params.get(k);
        state.hour = pu('hour') ? +pu('hour') : c.hour;
        state.month = pu('month') ? +pu('month') : c.month;
        state.day = c.day;
        state.weather = pu('weather') || c.weather;
      }
      applyConditions();
      if (state.free && !freecam.placed) { placeFreecam(); }
      setFree(state.free);
      T('conditions');
      // KHR_parallel_shader_compile: build every program at once instead of one by one
      // inside the first frame. Done after lighting is set up, because the light
      // setup (which lamps are on, IR lamp) is part of each program.
      // same photocell decision the camera makes on its first frame, so the IR lamp
      // (a spot light: part of every program key) matches what gets precompiled
      app.env.state.date = currentDate();
      app.env.update(simClock);
      const dark = ambientLux(app.env, cameraPose().position) < app.spec.irThreshold;
      app.env.setIR(dark && !app.spec.nightColor, dark);
      log('Compilando shaders…');
      // compile against the camera's own render target: its colour space is part of the
      // program key, compiling for the canvas would build every program twice
      renderer.setRenderTarget(app.cctv.sceneRT);
      try { await renderer.compileAsync(scene, app.cctv.camera); } catch (e) { /* first frame will compile */ }
      T('compile');
      console.log('[sim] rebuild total', Math.round(performance.now() - tR), 'ms');
      // reflection probes of the parked cars (after the programs exist)
      { const t1 = performance.now(); app.probes = new CarProbes(renderer, ctx, env, ctx.parked || [], ctx.traffic?.cars || []); app.probes.updateAll(); console.log('[sim] car probes', Math.round(performance.now() - t1), 'ms'); }
      // who casts silhouette shadows: every vehicle and person from the lamps; from the
      // sun only what moves (the static sun shadow map already has the parked cars)
      {
        const traffic = (ctx.traffic?.cars || []).map(c => c.obj);
        const people = []; scene.traverse(o => { if (o.isSkinnedMesh) people.push(o); });
        app.sil = new SilhouetteShadows(renderer);
        app.sil.setCasters(ctx.parked || [], traffic, people);
      }
      app.tReady = performance.now();
      app.progsAtReady = new Set((renderer.info.programs || []).map(p => p.id));
      if (params.has('progdebug')) { const v = []; scene.traverse(o => { if (o.isSpotLight && o.visible !== false) v.push((o.parent?.type || '') + ':' + o.intensity.toFixed(2)); }); console.log('[progs] spots at compile: ' + v.join(' ')); app.spotsAt = v.length; }
      renderer.setRenderTarget(null);
      const url = new URL(location.href);
      url.searchParams.set('seed', state.seed);
      if (state.location) { url.searchParams.set('lat', state.location.lat.toFixed(6)); url.searchParams.set('lon', state.location.lon.toFixed(6)); }
      else { url.searchParams.delete('lat'); url.searchParams.delete('lon'); }
      history.replaceState(null, '', url);
      log(`${site.city} · ${site.roadName || 'rua sem nome'} · ${site.lat.toFixed(5)}, ${site.lon.toFixed(5)}`);
      frames = 0;
    } catch (e) {
      console.error(e);
      log('Erro: ' + e.message);
      if (state.location) setTimeout(() => openMap(), 300);
      window.__error = e.message;
    }
    building = false;
  }

  function disposeApp(a) {
    a.annot?.dispose();
    a.codec?.dispose();
    a.freeView?.dispose();
    a.gi?.dispose();
    a.skyvis?.dispose();
    a.ctx?.grime?.dispose();
    a.cctv?.dispose();
    a.sim?.dispose?.();
    a.probes?.dispose();
    a.sil?.dispose();
    a.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) { if (m.map?.isCanvasTexture) m.map.dispose(); m.dispose(); }
    });
    a.env.pmrem.dispose();
    a.env.envRT?.dispose();
  }

  // ---------------------------------------------------------------- free camera
  function placeFreecam() {
    const pose = cameraPose();
    freecam.camera.position.copy(pose.position).add(new THREE.Vector3(0, 1.2, 0));
    freecam.yaw = pose.euler.y;
    freecam.pitch = pose.euler.x * 0.5;
    freecam.placed = true;
  }

  function setFree(on) {
    freecam.enabled = on;
    helpEl.style.display = on ? 'block' : 'none';
    if (!app) return;
    if (on) {
      if (!freecam.placed) placeFreecam();
      showDecoded(false);
      const w = Math.min(1920, view.clientWidth || 1600), h = Math.min(1080, view.clientHeight || 900);
      renderer.setSize(w, h, false);
      makeFreeView(w, h);
    } else {
      app.freeView?.dispose();
      app.freeView = null;
      renderer.setSize(app.spec.res[0], app.spec.res[1], false);
      showDecoded(!!app.codec && !state.raw);
      if (app.ctx) app.env.setFocus(new THREE.Vector3(app.ctx.focus[0], app.ctx.cameraPose.position.y - 3, app.ctx.focus[1]));
    }
  }

  // The free camera goes through the same ISP as the security camera (exposure,
  // tone curve, white balance, WDR) so the scene looks the same; only the lens
  // warp, sensor noise, OSD and codec are left out.
  function makeFreeView(w, h) {
    app.freeView?.dispose();
    const spec = {
      ...app.spec, res: [w, h], hfov: 75, k: 0, sensor: 0, sharp: 0.25, dirt: 0, web: false, visor: false,
      focus: 1, analog: false, fps: 240, wbError: [0, 0], dwdr: Math.min(app.spec.dwdr, 0.3),
    };
    const fv = new CCTVCamera(renderer, spec, state.seed + '/free');
    fv.codecMode = 'real';       // render the ISP output straight to the canvas
    fv.hideOSD = true;
    fv.live.irMode = 'day';      // a human eye, not the IR-cut camera
    if (ssao) fv.postRender = (depth, cam, w2, h2) => ssao.fromDepth(depth, cam, w2, h2);
    fv.setIRHook = false;
    app.freeView = fv;
  }

  function installHere() {
    if (!app) return;
    const c = freecam.camera;
    poseOverride = { position: c.position.clone(), yaw: freecam.yaw, pitch: freecam.pitch, roll: 0 };
    cfg.camera.height = 0; cfg.camera.yaw = 0; cfg.camera.pitch = 0; cfg.camera.roll = 0;
    saveConfig(cfg);
    state.free = false;
    setFree(false);
    updateCamInfo();
  }

  function toggleRecording() {
    if (!app?.codec) return;
    if (!rec.on) { app.codec.startRecording(); rec.on = true; recCtl.name('Parar e salvar'); return; }
    rec.on = false; recCtl.name('Gravar stream do codec');
    app.codec.flush().then(() => {
      const { blob, ext } = app.codec.stopRecording();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cctv-${state.seed}.${ext}`;
      a.click();
    });
  }
  setInterval(() => { if (app?.codec) { camInfo.codec = `${app.codec.codecName} · ${app.codec.stats.kbps} kbps medidos`; refreshGui(); } }, 2000);

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  let frames = 0;
  let gl0 = null;
  const readyAfter = +(params.get('frames') || 45);
  const tonemapped = (cam, exposure) => {
    renderer.setRenderTarget(null);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    ssao?.render(app.scene, cam, renderer.domElement.width, renderer.domElement.height);
    renderer.setRenderTarget(null);
    renderer.render(app.scene, cam);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  };

  function loop() {
    requestAnimationFrame(loop);
    if (!app || !app.cctv || building) return;
    const now = performance.now();
    let dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (params.has('capture')) dt = 1 / 30;
    const realDt = dt;
    if (state.paused) dt = 0;
    simClock += dt * state.speed;
    const t = simClock;
    const { env, cctv, sim } = app;
    if (prof.on) renderer.info.reset();
    prof.frame();

    const pose = cameraPose();
    cctv.camera.position.copy(pose.position);
    cctv.camera.rotation.copy(pose.euler);
    cctv.camera.updateMatrixWorld();

    env.state.date = currentDate();
    env.clockDate = new Date(env.state.date.getTime() - 3 * 3600 * 1000);
    prof.section('env', () => env.update(t));
    // once a second of simulated time (and every frame while flying, since the
    // shadow frustum follows the free camera)
    // and for the first frames after a build, while lights and frusta settle
    // (applied by the camera right before its scene pass: other passes render
    // partial scenes and would bake an incomplete shadow map)
    if (frames < 10 || state.free || Math.abs(t - lastShadow) > 1) { cctv.shadowDue = true; if (app.freeView) app.freeView.shadowDue = true; lastShadow = t; }
    // car reflections follow the slow changes of the street (sun, clouds, lamps):
    // one car every 300 frames, about 50 ms each
    prof.begin('probes');
    // reflections and silhouette shadows only matter on frames the camera captures
    // (the loop runs at the display rate, the camera at its own 10-30 fps)
    const due = state.free || state.raw || cctv.isDue(t);
    if (due) app.probes?.tick(realDt);
    // vehicle and people shadows from the lamps (and from the sun, for what moves)
    if (app.sil && due) prof.section('silhouettes', () => app.sil.update(env, state.free ? freecam.camera.position : cctv.camera.position, app.ctx.focus));
    prof.end();
    env.ambientLux = ambientLux(env, cctv.camera.position);
    env.wbCast = -env.state.nightF * 0.25;
    env.rainOnLens = WEATHERS[state.weather].rain * (app.layout.camera.kind === 'facade' ? 0.3 : 1);
    prof.section('sim', () => sim.update(dt * Math.min(state.speed, 3), t, env));
    prof.section('gi', () => app.gi?.update(t, env, sim.giDynamics ? sim.giDynamics() : {}));
    const viewCam = state.free ? freecam.camera : cctv.camera;
    if (env.rain.mesh.visible) {
      // drops carry the sky light around them and glint near lamps and the IR LEDs
      const amb = env.sky.material.uniforms.uSkyAmb.value.clone().add(env.sky.material.uniforms.uPollution.value.clone().multiplyScalar(3));
      const lamps = [];
      for (const l of env.lights) if (l.light.visible && l.light.isSpotLight && l.light.intensity > 0) lamps.push({ pos: l.light.position, color: l.light.color, intensity: l.light.intensity });
      if (app.irLight?.visible) lamps.push({ pos: viewCam.position, color: app.irLight.color, intensity: app.irLight.intensity * 0.6 });
      lamps.sort((a, b) => a.pos.distanceToSquared(viewCam.position) - b.pos.distanceToSquared(viewCam.position));
      if (app.irLight?.visible) { const i = lamps.findIndex(l => l.pos === viewCam.position); if (i > 0) lamps.unshift(lamps.splice(i, 1)[0]); }
      // shutter: auto exposure runs the shutter up to 1/30 before adding gain
      const shutter = THREE.MathUtils.clamp(cctv.exposure / 25 / 30, 1 / 120, 1 / 30);
      prof.section('rain', () => env.rain.update(t, viewCam.position, amb, shutter, lamps));
    }

    if (state.free) {
      freecam.update(realDt, renderer.domElement.width / renderer.domElement.height);
      env.setFocus(freecam.camera.position.clone().add(new THREE.Vector3(-Math.sin(freecam.yaw) * 25, -2, -Math.cos(freecam.yaw) * 25)));
      if (!app.freeView) makeFreeView(renderer.domElement.width, renderer.domElement.height);
      const fv = app.freeView;
      fv.camera.position.copy(freecam.camera.position);
      fv.camera.quaternion.copy(freecam.camera.quaternion);
      fv.camera.updateMatrixWorld();
      prof.section('capture', () => fv.capture(app.scene, performance.now() / 1000, realDt, env));
    } else if (state.raw) {
      showDecoded(false);
      tonemapped(cctv.camera, cctv.exposure);
    } else {
      if (app.codec) showDecoded(true);
      const captured = prof.section('capture', () => cctv.capture(app.scene, t, dt, env));
      if (app.codec) { if (captured) prof.section('codec', () => app.codec.push(renderer.domElement)); }
      if (captured && app.annot && window.__ready) annotate(t);
      else prof.section('present', () => cctv.present());
    }
    frames++;
    if (frames === 1 && app.tReady) { gl0 = renderer.getContext(); gl0.finish(); console.log('[sim] first frame', Math.round(performance.now() - app.tReady), 'ms');
      if (params.has('progdebug')) { const v = []; app.scene.traverse(o => { if (o.isSpotLight && o.visible !== false) v.push((o.parent?.type || '') + ':' + o.intensity.toFixed(2)); }); console.log('[progs] spots at first frame: ' + v.join(' ')); }
      if (params.has('progdebug')) window.__progdump = { ready: (renderer.info.programs || []).filter(p => app.progsAtReady.has(p.id)).map(p => p.cacheKey), fresh: (renderer.info.programs || []).filter(p => !app.progsAtReady.has(p.id)).map(p => p.cacheKey) };
      if (params.has('progdebug')) console.log('[progs] new in first frame: ' + (renderer.info.programs || []).filter(p => !app.progsAtReady.has(p.id)).map(p => p.name + '#' + p.cacheKey.slice(0, 60).replace(/\s+/g, ' ')).join(' | ')); }
    if (frames === readyAfter) {
      window.__ready = true;
      console.log('[sim] ready', JSON.stringify({ exposure: cctv.exposure, gain: cctv.gain, ir: cctv.irMode, q: cctv.lastQ, codec: app.codec ? app.codec.codecName + ' ' + JSON.stringify(app.codec.stats) : 'emulated', sunEl: env.state.sunEl, lux: Math.round(env.ambientLux), info: info(renderer) }));
    }
  }
  // vehicles in this frame that make a sample: crop + plate corners, handed to
  // window.__datasetSample(meta JSON, image base64)
  function annotate(t) {
    const a = app.annot;
    // moving vehicles only on intra frames: a P frame of the emulated codec copies
    // still-looking blocks from the previous one, so a moving car smears behind where
    // it really is (and where its label says)
    const iFrame = !!app.codec || app.cctv.frame % app.spec.gop === 0;
    if (t - a.lastStep < a.opts.every && !iFrame) return;
    a.lastStep = t;
    const found = a.find(app.scene, t, app.annotRng).filter(f => iFrame || (app.ctx.parked || []).includes(f.root)).slice(0, 3);
    for (const f of found) {
      a.mark(f.root, t);
      const meta = {
        seed: state.seed, t: +t.toFixed(2), frame: app.cctv.frame,
        camera: app.spec.name, res: app.spec.res, kbps: app.spec.kbps, hfov: +app.spec.hfov.toFixed(1),
        ir: !!app.cctv.irMode, hour: +state.hour.toFixed(2), weather: state.weather, city: app.site.city,
        vehicle: f.root.name, plate: f.root.userData.plate, plateKind: f.root.userData.plateKind,
        moving: !(app.ctx.parked || []).includes(f.root), dist: +f.dist.toFixed(2),
        box: f.box.map(v => +v.toFixed(2)), crop: f.crop,
        plates: f.plates.map(p => ({ corners: p.corners.map(c => c.map(v => +v.toFixed(3))), width: +p.width.toFixed(1), facing: +p.facing.toFixed(3), kind: p.kind })),
        labels: f.plates.map(p => yoloLine(p, f.crop)),
      };
      a.image(f.crop).then(b => b && b.arrayBuffer()).then(buf => {
        if (!buf) return;
        const u8 = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        window.__datasetSample?.(JSON.stringify(meta), btoa(s));
      });
    }
  }
  // tools/dataset.mjs --debug: the saved crop with its label drawn back on, read from
  // the YOLO line itself (box, then TL red, TR green, BR blue, BL yellow)
  window.__datasetOverlay = async (b64, metaJson) => {
    const meta = JSON.parse(metaJson);
    const img = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]));
    const S = 3, c = new OffscreenCanvas(img.width * S, img.height * S), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, c.width, c.height);
    for (const line of meta.labels) {
      const v = line.split(' ').slice(1).map(Number);
      const X = (x) => x * c.width, Y = (y) => y * c.height;
      if (meta.task === 'chars') {
        g.strokeStyle = ['#ffffff', '#ff3030', '#30ff60', '#ffe020', '#ff8020', '#20e0ff'][+line.split(' ')[0]] || '#fff'; g.lineWidth = 1;
        g.strokeRect(X(v[0] - v[2] / 2), Y(v[1] - v[3] / 2), X(v[2]), Y(v[3]));
        continue;
      }
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
      g.strokeRect(X(v[0] - v[2] / 2), Y(v[1] - v[3] / 2), X(v[2]), Y(v[3]));
      const kp = [0, 1, 2, 3].map(i => [X(v[4 + i * 3]), Y(v[5 + i * 3])]);
      g.strokeStyle = '#00e5ff'; g.beginPath(); kp.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
      ['#ff2020', '#20ff20', '#2060ff', '#ffe020'].forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(kp[i][0], kp[i][1], 2.5, 0, 7); g.fill(); });
    }
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  window.__app = () => app;
  // a new scene with this seed (streaming: cameras change place every cycle)
  window.__setSeed = (seed) => { state.seed = seed; state.location = null; poseOverride = null; window.__ready = false; frames = 0; rebuild({ keepConditions: false }); };
  window.__forceKey = () => { if (app?.codec) app.codec.forceKey = true; };
  window.__gu = globalUniforms;
  window.__freecam = freecam;
  window.__state = state;
  const built = rebuild({ keepConditions: false });
  if (genMode) startGenerator(built);
  else loop();

  // ---------------------------------------------------------------- generator
  // what src/gen.js needs from this module: the app, its clock and conditions, and
  // the per-view environment setup the display loop does for its camera
  async function startGenerator(first) {
    const { Generator } = await import('./gen.js');
    const host = {
      renderer, cfg,
      get app() { return app; },
      get state() { return state; },
      clock: () => simClock,
      // simulated time forward (callers keep dt small: traffic and people are
      // integrated with it)
      step(dt) {
        simClock += dt;
        const { env, sim } = app;
        env.state.date = currentDate();
        env.clockDate = new Date(env.state.date.getTime() - 3 * 3600 * 1000);
        sim.update(dt, simClock, env);
      },
      // new hour / weather without resetting the clock (traffic keeps its time)
      setConditions({ hour, month = state.month, weather }) {
        state.hour = hour; state.month = month; state.weather = weather;
        const h = Math.floor(hour), mi = Math.floor((hour - h) * 60);
        baseDate = new Date(localDate(2026, month, Math.min(state.day, 28), h, mi, -3).getTime() - simClock * 1000);
        app.env.configure(currentDate(), weather);
        app.ctx.month = month;
      },
      async compile() {
        renderer.setRenderTarget(app.cctv.sceneRT);
        try { await renderer.compileAsync(app.scene, app.cctv.camera); } catch (e) { /* compiled on first use */ }
        renderer.setRenderTarget(null);
      },
      specOverrides: (spec) => applySpecOverrides(spec, cfg),
      lux: (pos) => ambientLux(app.env, pos),
      // a generator camera joins the scene: SSAO, live settings, and the one IR lamp
      // (moved from camera to camera: a second light would change every program)
      attach(cctv) {
        const spec = cctv.spec;
        if (ssao) cctv.postRender = (depth, cam, w, h) => ssao.fromDepth(depth, cam, w, h);
        cctv.applyLive(cfg);
        const ir = app.irLight;
        ir.color.set(spec.nightColor ? '#ffe2b8' : '#ffffff');
        ir.distance = spec.irRange * 2.2;
        ir.angle = THREE.MathUtils.degToRad(Math.min(80, spec.hfov * 0.42));
        cctv.camera.add(ir, ir.target);
        app.scene.add(cctv.camera);
        app.env.setIR = (on, lamp = on) => {
          globalUniforms.uIR.value = on ? 1 : 0;
          ir.intensity = lamp ? spec.irRange * spec.irRange * (spec.nightColor ? 0.00025 : 0.0005) : 0;
          ir.visible = !!lamp;
        };
      },
      detach(cctv) {
        app.cctv.camera.add(app.irLight, app.irLight.target);
        app.scene.remove(cctv.camera);
      },
      // environment as seen from this camera, right before it captures
      prepare(cctv, lensRain) {
        const { env, sim } = app;
        const t = simClock;
        env.state.date = currentDate();
        env.clockDate = new Date(env.state.date.getTime() - 3 * 3600 * 1000);
        env.update(t);
        app.gi?.update(t, env, sim.giDynamics ? sim.giDynamics() : {});
        const P = cctv.camera.position;
        env.ambientLux = ambientLux(env, P);
        env.wbCast = -env.state.nightF * 0.25;
        env.rainOnLens = WEATHERS[state.weather].rain * lensRain;
        app.probes?.tick();
        app.sil?.update(env, P, app.ctx.focus);
        if (env.rain.mesh.visible) {
          const amb = env.sky.material.uniforms.uSkyAmb.value.clone().add(env.sky.material.uniforms.uPollution.value.clone().multiplyScalar(3));
          const lamps = [];
          for (const l of env.lights) if (l.light.visible && l.light.isSpotLight && l.light.intensity > 0) lamps.push({ pos: l.light.position, color: l.light.color, intensity: l.light.intensity });
          lamps.sort((a, b) => a.pos.distanceToSquared(P) - b.pos.distanceToSquared(P));
          if (app.irLight.visible) lamps.unshift({ pos: P, color: app.irLight.color, intensity: app.irLight.intensity * 0.6 });
          const shutter = THREE.MathUtils.clamp(cctv.exposure / 25 / 30, 1 / 120, 1 / 30);
          env.rain.update(t, P, amb, shutter, lamps);
        }
      },
      async rebuild(seed) {
        state.seed = seed; state.location = null; poseOverride = null;
        window.__error = undefined;
        await rebuild({ keepConditions: false });
        if (window.__error) throw new Error(window.__error);
      },
    };
    const g = new Generator(host);
    window.__gen = g;
    await first;
    window.__genReady = !window.__error;
  }
}

function info(r) {
  return { calls: r.info.render.calls, tris: r.info.render.triangles, geos: r.info.memory.geometries, tex: r.info.memory.textures };
}
