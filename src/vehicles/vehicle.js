// GTA San Andreas vehicles (RenderWare .dff/.txd from the "GTA Brasil" pack) as
// three.js objects: frame hierarchy, the parts a car shows when intact (no *_dam,
// no LOD), the wheel copied to every wheel dummy, paint from carcols.dat and the
// colour-coded materials the game recolours (paint, head/tail lights).
import * as THREE from 'three';
import { parseDFF, parseTXD, parseCarcols, parseColorPairs } from './rw.js';
import { loadPlateAssets, generatePlate } from './plates.js';
import { plateMaterials, replacePlate } from './platemat.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeWearUniforms, rollCondition, planParts, poseParts, dentSites, rollSurface, floorTier, pickTier } from './wear.js';

const BASE = '/assets/Pack 184 vehicles Extras - GTA Brasil v4/';
const enc = (p) => encodeURI(BASE + p);

// material colours the game replaces at runtime
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
const PRIMARY = key([60, 255, 0]), SECONDARY = key([255, 0, 175]);
// third and fourth colours: trim and interior pieces, matte
const TERTIARY = key([0, 255, 255]), QUATERNARY = key([255, 0, 255]);
const LIGHTS = new Map([
  [key([255, 175, 0]), 'head'], [key([0, 255, 200]), 'head'],
  [key([185, 255, 0]), 'tail'], [key([255, 60, 0]), 'tail'],
]);

async function fetchBuf(path) {
  const r = await fetch(enc(path));
  if (!r.ok) throw new Error('não achei ' + path);
  return new Uint8Array(await r.arrayBuffer());
}

const SHARED = { models: new Map(), ready: null, generic: null, palette: null, pairs: null };

export class VehicleLibrary {
  // parsed files are shared by every library (one per world build); textures and
  // materials belong to the world's material library
  constructor(lib) {
    this.lib = lib;
    this.models = SHARED.models;
    this.textures = new Map();
  }
  get ready() { return SHARED.ready; }
  set ready(p) { SHARED.ready = p; }
  get generic() { return SHARED.generic; }
  set generic(v) { SHARED.generic = v; }
  get palette() { return SHARED.palette; }
  set palette(v) { SHARED.palette = v; }
  get pairs() { return SHARED.pairs; }
  set pairs(v) { SHARED.pairs = v; }

  // vehicle.txd (shared textures), colour palette and per-model colour pairs
  init() {
    if (!this.ready) {
      this.ready = (async () => {
        this.generic = parseTXD(await fetchBuf('_CFG/generic/vehicle.txd'));
        const cc = new TextDecoder('latin1').decode(await fetchBuf('_CFG/carcols.dat'));
        this.palette = parseCarcols(cc);
        this.pairs = new Map();
        let inCar = false;
        for (const raw of cc.split(/\r?\n/)) {
          const line = raw.replace(/#.*/, '').trim();
          if (line === 'car' || line === 'car4') { inCar = true; continue; }
          if (line === 'end') { inCar = false; continue; }
          if (inCar && line.includes(',')) this.pairs.set(line.split(',')[0].trim().toLowerCase(), parseColorPairs(line));
        }
      })();
    }
    return this.ready;
  }

  async load(name) {
    await this.init();
    if (!this.models.has(name)) {
      this.models.set(name, (async () => {
        const [dff, txd] = await Promise.all([fetchBuf(`VEHICLES/${name}.dff`), fetchBuf(`VEHICLES/${name}.txd`)]);
        return { dff: parseDFF(dff), txd: parseTXD(txd) };
      })());
    }
    return this.models.get(name);
  }

  texture(model, name) {
    if (!name) return null;
    const src = model.txd.get(name) || this.generic.get(name);
    if (!src) return null;
    const k = (model.txd.has(name) ? model.name + '/' : '') + name;
    if (!this.textures.has(k)) {
      const t = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.needsUpdate = true;
      t.userData.alpha = src.alpha;
      this.textures.set(k, t);
    }
    return this.textures.get(k);
  }

  // A ready-to-place car: origin on the ground under its centre, facing -Z.
  // opts.moto: two-wheeler (motorcycle plate); opts.plate === false: none (bicycles);
  // opts.wear: force a condition tier (else seeded, see wear.js)
  async create(name, rng, opts = {}) {
    const model = await this.load(name);
    model.name = name;
    const { dff } = model;
    const pairs = this.pairs.get(name) || [[1, 1]];
    const [ci, cj] = pairs[Math.floor(rng.next() * pairs.length)];
    // each car has its own materials (its reflection probe goes on them) and finish:
    // how old the clear coat is and how dirty the car is
    const age = rng.next();
    const look = {
      id: ++carSerial, age,
      paint: this.paintColor(ci), paint2: this.paintColor(cj),
      metal: !!this.palette[ci]?.[3], metal2: !!this.palette[cj]?.[3],
    };
    const paint = look.paint;
    // condition (src/vehicles/wear.js): structural damage now, surface wear after the merge
    // opts.wear: force a tier ('clean' | 'used' | 'worn' | 'wrecked' | 'burnt')
    const cond = rollCondition(rng.fork('wear'), age, opts.wear);
    const atomicOf = new Map(dff.atomics.map((a, i) => [a.frame, i]));
    const plan = planParts(dff.frames, cond, (i) => atomicOf.has(i));
    look.wear = makeWearUniforms();
    look.glassGone = plan.glassGone;
    // its licence plate (same on both ends), worn like the rest of the car
    await loadPlateAssets();
    const makePlate = (r) => generatePlate(r, {
      vehicle: opts.moto ? 'moto' : 'carro', style: 'auto', category: 'auto', relief: !FLAT_PLATES,
      // dataset generation: every plate type and wear level about equally often
      ...(BALANCED_PLATES ? { balanced: true } : { wear: 0.1 + 0.6 * age }),
    });
    const plate = opts.plate === false ? { text: null, kind: null } : makePlate(rng.fork('plate'));
    look.plate = plate.canvas ? plateTexture(plate.canvas) : null;
    look.plateRelief = plate.relief || null;
    look.plateWear = plate.wear ?? 0.1 + 0.6 * age;
    look.plateSize = opts.moto ? PLATE_MM.moto : PLATE_MM.carro;
    const mats = new Map();
    const material = (m) => this.material(model, m, look, mats);

    // frames -> Object3D tree (RW is z-up; the root turns it y-up)
    const nodes = dff.frames.map(f => {
      const o = new THREE.Object3D();
      o.name = f.name;
      const r = f.rot;
      o.matrix.set(r[0], r[3], r[6], f.pos[0], r[1], r[4], r[7], f.pos[1], r[2], r[5], r[8], f.pos[2], 0, 0, 0, 1);
      o.matrix.decompose(o.position, o.quaternion, o.scale);
      return o;
    });
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.rotation.x = -Math.PI / 2;
    root.add(body);
    dff.frames.forEach((f, i) => (f.parent >= 0 ? nodes[f.parent] : body).add(nodes[i]));
    // VehFuncs folding passenger pegs ("f_fpeg1=ax-80ay-30": the folded rotation in
    // degrees about the frame's own axes): the model has them out; folded unless the
    // bike carries a passenger (opts.passenger). "f_an4a=az±20" are the brake / clutch
    // levers (pulled when braking): left at rest.
    if (!opts.passenger) dff.frames.forEach((f, i) => {
      const m = f.name.match(/^f_fpeg\d*=(.*)$/i);
      if (!m) return;
      const ang = {};
      for (const [, k, v] of m[1].matchAll(/a([xyz])(-?\d+(?:\.\d+)?)/gi)) ang[k.toLowerCase()] = +v * Math.PI / 180;
      const deg = (k) => ang[k] || 0;
      nodes[i].quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg('x'), deg('y'), deg('z'), 'XYZ')));
    });

    const shown = this.visibleFrames(dff.frames, rng, plan);
    // the model's wheel, copied to every wheel dummy below: "wheel" in the game, but
    // mods name it "Wheel", "wheel_gn2", or carry VehFuncs variants ("wheel0_[CLASS]",
    // "wheel1_[SLE]": the one the rules show, else the first)
    const wheels = [];
    for (const a of dff.atomics) {
      const f = dff.frames[a.frame];
      const mesh = new THREE.Mesh(this.geometry(dff.geometries[a.geometry]), dff.geometries[a.geometry].materials.map(material));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (isWheelFrame(f.name)) { wheels.push({ mesh, shown: shown[a.frame] }); mesh.visible = false; }
      else if (/^wheel_(front|rear)$/.test(f.name)) mesh.userData.wheel = true;
      else mesh.visible = shown[a.frame] && !plan.hideMesh?.has(a.frame);
      nodes[a.frame].add(mesh);
      // the game's plate quads are replaced by a real-size plate. A damaged part
      // without plate quads keeps the plate where its intact version had it.
      let plateGeo = mesh.visible ? dff.geometries[a.geometry] : null;
      if (!plateGeo && plan.swapped?.has(a.frame)) {
        const dam = dff.atomics[atomicOf.get(plan.swap.get(a.frame))];
        if (dam && !plateFrames(dff.geometries[dam.geometry]).length) plateGeo = dff.geometries[a.geometry];
      }
      if (plateGeo && look.plate) for (const fr of plateFrames(plateGeo)) nodes[a.frame].add(this.plateMesh(fr, look));
    }
    // wheels carry no car-space wear (they spin on their own frame when moving)
    const wheelMeshes = [...wheels.map(w => w.mesh)];
    root.traverse(o => { if (o.isMesh && o.userData.wheel) wheelMeshes.push(o); });
    for (const w of wheelMeshes) for (const m of [].concat(w.material)) { const k = m.userData.u?.uWearKind; if (k && k.value === 1) k.value = 5; }
    const wheel = (wheels.find(w => w.shown) || wheels[0])?.mesh;
    // the model carries one wheel; every wheel dummy gets a copy (left side mirrored)
    if (wheel) {
      const rf = nodes.find(n => n.name === 'wheel_rf_dummy');
      for (const n of nodes) {
        if (!/^wheel_[lr][fbm]_dummy$/.test(n.name)) continue;
        const w = wheel.clone();
        w.userData.wheel = true;
        w.visible = true;
        w.position.set(0, 0, 0); w.quaternion.identity(); w.scale.set(1, 1, 1);
        // same offset from the dummy as the original (usually none)
        if (n === rf) w.position.copy(wheel.parent.position);
        if (n.name[6] === 'l') w.scale.x = -1;
        n.add(w);
      }
    }
    // stand on the ground: lowest point of the wheels at y = 0
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse(o => { if (o.isMesh && o.visible && isVisible(o)) box.expandByObject(o); });
    const center = box.getCenter(new THREE.Vector3());
    body.position.set(-center.x, -box.min.y, -center.z);
    // doors ajar, lids popped, bumpers hanging: before the plates are recorded so
    // a plate on a moved part goes with it
    poseParts(root, nodes, plan, isVisible);
    root.updateMatrixWorld(true);
    // wheel arches for the mud spray: half track, front / rear axle z, radius
    {
      const wz = [], wx = [];
      let wr = 0.32;
      for (const n of nodes) if (/^wheel_[lr][fbm]_dummy$/.test(n.name)) { const p = new THREE.Vector3().setFromMatrixPosition(n.matrixWorld); wz.push(p.z); wx.push(Math.abs(p.x)); wr = Math.max(0.2, p.y); }
      if (wz.length) look.wear.uWheels.value.set(Math.max(...wx), Math.min(...wz), Math.max(...wz), wr);
      else { const sz = box.getSize(new THREE.Vector3()); look.wear.uWheels.value.set(sz.x / 2 - 0.15, -sz.z * 0.32, sz.z * 0.32, 0.3); }
    }
    // where the plates are (the merge folds their meshes into the body): a frame per
    // plate relative to the root, centre of the printed face, x right, y up, z out
    // (dataset annotation: src/cam/annotate.js)
    root.updateMatrixWorld(true);
    const rootInv = root.matrixWorld.clone().invert();
    const plates = [];
    root.traverse(o => { if (o.userData.plateSize && isVisible(o)) plates.push({ m: new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld), mm: o.userData.plateSize }); });
    // a parked car never moves a part: one mesh per material instead of ~40 meshes
    // with several materials each (draw calls are the cost here)
    mergeByMaterial(root, !!opts.dynamic);
    root.name = root.name || name;
    root.userData = { plates, wheels: root.userData.wheels || [], size: box.getSize(new THREE.Vector3()), paint, ...plateData(plate), materials: [...mats.values()], lamps: [...mats.values()].filter(m => m.userData.lamp) };
    // root.userData.rerollPlate(rng): another plate (text, type, wear) on the same
    // car, textures updated in place (dataset rounds: more plates per world)
    if (plate.text && look.plateMats) root.userData.rerollPlate = (r) => {
      const p = makePlate(r);
      replacePlate(look.plateMats, p);
      Object.assign(root.userData, plateData(p));
    };
    // surface wear (uniforms only): dust, mud, scratches, scrapes, rust, fire, dents.
    // root.userData.rerollWear(rng) rolls a new one on the same car (see wear.js)
    const sites = opts.moto || opts.plate === false ? new Float32Array(0) : dentSites(root, plates);
    const ctx = { size: root.userData.size, sites, platePos: plates.map(p => new THREE.Vector3().setFromMatrixPosition(p.m)) };
    const floor = floorTier(plan, cond.tier);
    const roll = (r, tier) => {
      const st = rollSurface(look.wear, r, tier, age, ctx);
      st.parts = plan.parts.slice();
      root.userData.wear = st;
      root.userData.wearUniforms = look.wear;
      return st;
    };
    roll(cond.rng.fork('surface'), cond.tier);
    root.userData.rerollWear = (r) => roll(r, pickTier(r, age, floor, floor === 'burnt'));
    return root;
  }

  paintColor(i) {
    const c = this.palette[i] || [200, 200, 200];
    return new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
  }

  // Intact parts only (no *_dam, no LOD), plus the VehFuncs variants:
  //  - f_class: its children are classes ("bau[70]": weight 70); one is chosen.
  //    Any frame tagged "[name]" (or "_[name]") shows only with that class.
  //  - f_extras: a child "name:N" is a group showing one of its children (none
  //    for :0); a leaf child stays; an untagged child with parts of its own is an
  //    optional accessory (driving-school sign...) and stays hidden.
  // plan (wear.js planParts): parts showing their *_dam mesh, parts gone
  visibleFrames(frames, rng, plan = null) {
    const kids = frames.map(() => []);
    frames.forEach((f, i) => { if (f.parent >= 0) kids[f.parent].push(i); });
    const shown = frames.map(() => true);
    const hide = (i) => { shown[i] = false; for (const k of kids[i]) hide(k); };
    const lname = (i) => frames[i].name.toLowerCase();
    const base = (n) => n.replace(/\[.*$/, '').replace(/[?:].*$/, '').trim();
    frames.forEach((f, i) => { const n = lname(i); if (n.endsWith('_dam') || n.includes('_vlo')) hide(i); });
    // classes
    const classes = new Set();
    frames.forEach((f, i) => {
      if (lname(i) !== 'f_class' || !kids[i].length) return;
      const opts = kids[i].map(k => { const m = lname(k).match(/\[(\d+)\]/); return [k, m ? +m[1] : 1]; });
      let t = rng.next() * opts.reduce((s, o) => s + o[1], 0), keep = opts[0][0];
      for (const [k, w] of opts) { if ((t -= w) <= 0) { keep = k; break; } }
      classes.add(base(lname(keep)));
      for (const k of kids[i]) if (k !== keep) hide(k);
    });
    const tagOf = (i) => { const m = lname(i).match(/\[([a-z][^\]]*)\]/); return m ? m[1].split(/[,\s]+/) : null; };
    frames.forEach((f, i) => { const t = tagOf(i); if (t && classes.size && !t.some(c => classes.has(c))) hide(i); });
    // extras
    frames.forEach((f, i) => {
      if (!lname(i).startsWith('f_extras')) return;
      for (const g of kids[i]) {
        if (tagOf(g)) continue;
        const m = lname(g).match(/:(\d+)/);
        if (m) {
          if (m[1] === '0' || !kids[g].length) { if (m[1] === '0') hide(g); continue; }
          const keep = kids[g][Math.floor(rng.next() * kids[g].length)];
          for (const k of kids[g]) if (k !== keep) hide(k);
        } else if (kids[g].length) hide(g);
      }
    });
    // a hidden frame hides everything under it
    const vis = (i) => { let j = i; while (j >= 0) { if (!shown[j]) return false; j = frames[j].parent; } return true; };
    if (plan) {
      // only where the intact part would show (classes and extras may hide it)
      plan.swapped = new Set([...plan.swap.keys()].filter(vis));
      plan.hideMesh = new Set();
      const unhide = (i) => { shown[i] = true; for (const k of kids[i]) unhide(k); };
      for (const ok of plan.swapped) {
        const dam = plan.swap.get(ok);
        // what hangs off the intact part (plate_front_ok, ...) stays unless the
        // damaged one brings its own (wipers *_dam under windscreen_dam)
        if (kids[dam].length) shown[ok] = false; else plan.hideMesh.add(ok);
        unhide(dam);
      }
      for (const d of plan.hide) shown[d] = false;
    }
    return frames.map((_, i) => vis(i));
  }

  geometry(g) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    if (g.normals) geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs[0] || new Float32Array(g.nVert * 2), 2));
    // triangles grouped by material
    const byMat = new Map();
    if (g.tris.length) {
      for (let i = 0; i < g.tris.length; i += 4) {
        const m = g.tris[i + 3];
        if (!byMat.has(m)) byMat.set(m, []);
        byMat.get(m).push(g.tris[i], g.tris[i + 1], g.tris[i + 2]);
      }
    } else if (g.meshes) {
      for (const s of g.meshes) {
        const out = byMat.get(s.mat) || [];
        if (!s.strip) out.push(...s.idx);
        else for (let i = 0; i + 2 < s.idx.length; i++) {
          const a = s.idx[i], b = s.idx[i + 1], c = s.idx[i + 2];
          if (a === b || b === c || a === c) continue;
          if (i & 1) out.push(b, a, c); else out.push(a, b, c);
        }
        byMat.set(s.mat, out);
      }
    }
    const index = [];
    for (const [m, list] of [...byMat.entries()].sort((a, b) => a[0] - b[0])) {
      geo.addGroup(index.length, list.length, m);
      for (const v of list) index.push(v);
    }
    geo.setIndex(index);
    if (!g.normals) geo.computeVertexNormals();
    return geo;
  }

  // Contran 729/2018: aluminium sheet (PLATE_MM) with rounded corners. The
  // printed face carries the generated plate; the edge is bare metal.
  plateMesh(fr, look) {
    if (!look.plateMats) {
      // embossed, retroreflective face and bare aluminium edge (platemat.js)
      look.plateMats = plateMaterials(this.lib, look, NO_WEAR ? null : look.wear);
    }
    const m = new THREE.Mesh(plateGeometry(look.plateSize), look.plateMats);
    m.matrixAutoUpdate = false;
    m.matrix.copy(fr);
    m.userData.plateSize = look.plateSize;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  material(model, m, look, cache) {
    const code = key(m.color);
    const lamp = LIGHTS.get(code);
    const k = (m.texture || '') + '|' + m.color.join(',');
    if (cache.has(k)) return cache.get(k);
    const map = this.texture(model, m.texture);
    const alpha = m.color[3] / 255;
    const tex = (m.texture || '').toLowerCase();
    // GTA draws the plate as a background quad (carpback) with a text strip on top
    // (carplate), both smaller than a real plate: hidden, a plate mesh takes over
    if (tex === 'carplate' || tex === 'carpback') {
      const mat = this.lib.plain({ name: 'car' + look.id, visible: false }, {});
      cache.set(k, mat);
      return mat;
    }
    let params, opts = { porosity: 0.05, dirt: 0.15 + 0.45 * look.age }, wearKind = 1;
    // damaged parts carry torn-metal faces textured with an alpha scratch decal
    // (meant to blend over paint): drawn as paint scraped down to primer and steel
    const torn = tex.includes('vehiclescratch');
    if (torn) {
      params = { physical: true, color: look.paint, roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.2, side: THREE.DoubleSide };
      opts.wearScrape = 0.9;
      wearKind = 0;
    } else if (code === PRIMARY || code === SECONDARY) {
      // car paint in layers: base coat (solid, or metallic with aluminium flakes
      // that each catch the light at their own angle) under a clear coat that
      // reflects like glass when new and hazes with age
      const metal = code === PRIMARY ? look.metal : look.metal2;
      params = {
        physical: true, color: code === PRIMARY ? look.paint : look.paint2, map,
        roughness: metal ? 0.38 : 0.5, metalness: metal ? 0.4 : 0,
        clearcoat: 1, clearcoatRoughness: 0.03 + 0.22 * look.age * look.age,
      };
      if (metal) { params.normalMap = flakeTexture(); params.normalScale = new THREE.Vector2(0.1, 0.1); }
      opts.spec = 1.2;
      wearKind = 0;
    } else if (code === TERTIARY || code === QUATERNARY) {
      const c = (code === TERTIARY ? look.paint2 : look.paint).clone().multiplyScalar(0.55);
      params = { color: c, map, roughness: 0.7, metalness: 0 };
    } else if (lamp) {
      params = { color: lamp === 'head' ? '#f2f2ee' : '#b01810', map, roughness: 0.15, emissive: lamp === 'head' ? '#fff4e0' : '#ff1a0a', emissiveIntensity: 0 };
      wearKind = 3;
    } else if (alpha < 0.99 || tex.includes('shatter')) {
      // glass
      params = { color: new THREE.Color().setRGB(m.color[0] / 255 * 0.25, m.color[1] / 255 * 0.27, m.color[2] / 255 * 0.28, THREE.SRGBColorSpace), map, transparent: true, opacity: 0.35 + 0.5 * alpha, roughness: 0.05, depthWrite: false };
      opts = { porosity: 0, dirt: 0.15, spec: 1.5 };
      wearKind = 2;
      // a burnt-out shell has lost its glass
      if (look.glassGone) params.visible = false;
    } else {
      const col = new THREE.Color().setRGB(m.color[0] / 255, m.color[1] / 255, m.color[2] / 255, THREE.SRGBColorSpace);
      const tyre = tex.includes('tyre');
      params = { color: col, map, roughness: tyre ? 0.85 : 0.55, metalness: tex.includes('wheel') ? 0.3 : 0 };
      if (map?.userData.alpha) { params.alphaTest = 0.5; params.side = THREE.DoubleSide; }
      opts = { porosity: tyre ? 0.6 : 0.1, dirt: tyre ? 0.6 : 0.3 };
      if (tyre || tex.includes('wheel')) wearKind = 5;
    }
    params.name = 'car' + look.id;
    opts.skyvisSpec = 0;
    opts.silRecv = 0;
    opts.wear = NO_WEAR ? null : look.wear;
    opts.wearId = look.id;
    opts.wearKind = wearKind;
    const mat = this.lib.plain(params, opts);
    if (lamp) mat.userData.lamp = lamp;
    cache.set(k, mat);
    return mat;
  }
}

let carSerial = 0;
// ?nowear: cars without the condition shader (A/B checks of look and frame time)
const NO_WEAR = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nowear');
// ?flatplates: plates without relief / retroreflection (A/B checks)
// gen=1 (dataset generator): plate types balanced instead of street frequencies
const BALANCED_PLATES = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gen') === '1';
const FLAT_PLATES = typeof location !== 'undefined' && new URLSearchParams(location.search).has('flatplates');

// Contran sizes: cars 400 x 130 mm, motorcycles 200 x 170 mm
export const PLATE_MM = { carro: [400, 130], moto: [200, 170] };
const PLATE_R = 0.008, PLATE_T = 0.0012;

// one rounded plate, shared by every car: front face UVs 0..1 (v down, like
// the plate texture rows), the edge gets a single texel near the border
const _plateGeo = new Map();
// what a vehicle's userData says about its plate
function plateData(plate) {
  return {
    plate: plate.text, plateKind: plate.kind,
    // printed characters as fractions of the plate face (the texture spans all of it)
    plateChars: plate.chars ? plate.chars.map(c => ({ ch: c.ch, x0: c.x0 / plate.canvas.width, y0: c.y0 / plate.canvas.height, x1: c.x1 / plate.canvas.width, y1: c.y1 / plate.canvas.height })) : null,
    plateInfo: plate.text ? { type: plate.plateType, style: plate.style, category: plate.category, model: plate.model, font: plate.font, wear: +plate.wear.toFixed(3), vehicle: plate.vehicle, uf: plate.uf, weighted: plate.weighted, retro: plate.relief ? +plate.relief.retro.toFixed(3) : null } : null,
  };
}

function plateGeometry(mm) {
  const key = mm.join('x');
  if (_plateGeo.has(key)) return _plateGeo.get(key);
  const W = mm[0] / 1000, H = mm[1] / 1000, r = PLATE_R;
  const sh = new THREE.Shape();
  sh.moveTo(-W / 2 + r, -H / 2);
  sh.lineTo(W / 2 - r, -H / 2); sh.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + r);
  sh.lineTo(W / 2, H / 2 - r); sh.quadraticCurveTo(W / 2, H / 2, W / 2 - r, H / 2);
  sh.lineTo(-W / 2 + r, H / 2); sh.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - r);
  sh.lineTo(-W / 2, -H / 2 + r); sh.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + r, -H / 2);
  const g = new THREE.ExtrudeGeometry(sh, { depth: PLATE_T, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -PLATE_T);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + W / 2) / W, (H / 2 - p.getY(i)) / H);
  _plateGeo.set(key, g);
  return g;
}

// where each plate quad of a geometry sits: centre, right (u), up (-v) and the
// outward normal, as a matrix in the geometry's own space. A geometry may hold
// several quads (front and rear, or a duplicate): each connected piece is one.
function plateFrames(g) {
  const out = [];
  const mi = g.materials.findIndex(m => m.texture === 'carpback');
  if (mi < 0 || !g.uvs[0]) return out;
  const P = (v) => new THREE.Vector3(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
  const U = (v) => [g.uvs[0][v * 2], g.uvs[0][v * 2 + 1]];
  // triangles of the material, grouped into pieces that share a vertex position
  const tris = [];
  for (let i = 0; i < g.tris.length; i += 4) if (g.tris[i + 3] === mi) tris.push([g.tris[i], g.tris[i + 1], g.tris[i + 2]]);
  const pkey = (v) => g.pos.slice(v * 3, v * 3 + 3).map(x => Math.round(x * 1000)).join(',');
  const parent = tris.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  tris.forEach((t, i) => { for (const v of t) { const k = pkey(v); if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i); } });
  const pieces = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!pieces.has(r)) pieces.set(r, []); pieces.get(r).push(t); });
  for (const list of pieces.values()) {
    let T = null, B = null;
    const verts = new Set();
    for (const [a, b, c] of list) {
      verts.add(a); verts.add(b); verts.add(c);
      if (T) continue;
      const e1 = P(b).sub(P(a)), e2 = P(c).sub(P(a));
      const du1 = U(b)[0] - U(a)[0], dv1 = U(b)[1] - U(a)[1], du2 = U(c)[0] - U(a)[0], dv2 = U(c)[1] - U(a)[1];
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) > 1e-6) {
        T = e1.clone().multiplyScalar(dv2).sub(e2.clone().multiplyScalar(dv1)).divideScalar(det);
        B = e2.clone().multiplyScalar(du1).sub(e1.clone().multiplyScalar(du2)).divideScalar(det);
      }
    }
    if (!T) continue;
    const c = new THREE.Vector3(), n = new THREE.Vector3();
    for (const v of verts) { c.add(P(v)); if (g.normals) n.add(new THREE.Vector3(g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2])); }
    c.divideScalar(verts.size);
    const X = T.normalize(), Y0 = B.normalize().negate();
    const Z = new THREE.Vector3().crossVectors(X, Y0).normalize();
    if (n.lengthSq() > 0 && Z.dot(n) < 0) Z.negate();
    const Y = new THREE.Vector3().crossVectors(Z, X).normalize();
    // the UV layout may be mirrored: keep the printed face reading left to right
    const Xr = Y.dot(Y0) < 0 ? X.clone().negate() : X;
    const Yr = new THREE.Vector3().crossVectors(Z, Xr);
    // a couple of millimetres proud of the bumper
    c.addScaledVector(Z, 0.002);
    // two quads in the same place (a doubled face) get one plate
    if (out.some(m => new THREE.Vector3().setFromMatrixPosition(m).distanceTo(c) < 0.05)) continue;
    out.push(new THREE.Matrix4().makeBasis(Xr, Yr, Z).setPosition(c));
  }
  return out;
}

// plate canvas -> texture. Rows top first, like the RenderWare UVs.
function plateTexture(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const t = new THREE.DataTexture(new Uint8Array(d), W, H);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// tangent-space normals of metallic flakes: small facets tilted at random,
// repeated many times over the body
let _flakes = null;
function flakeTexture() {
  if (_flakes) return _flakes;
  const N = 256, data = new Uint8Array(N * N * 4);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const cell = 3;
  for (let y = 0; y < N; y += cell) for (let x = 0; x < N; x += cell) {
    const a = rnd() * Math.PI * 2, t = Math.pow(rnd(), 1.5) * 0.6;
    const nx = Math.sin(t) * Math.cos(a), ny = Math.sin(t) * Math.sin(a), nz = Math.cos(t);
    for (let j = 0; j < cell; j++) for (let i = 0; i < cell; i++) {
      const k = ((y + j) % N * N + (x + i) % N) * 4;
      data[k] = (nx * 0.5 + 0.5) * 255; data[k + 1] = (ny * 0.5 + 0.5) * 255; data[k + 2] = (nz * 0.5 + 0.5) * 255; data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(70, 70);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return (_flakes = t);
}

// keepWheels: moving vehicles keep their wheels as separate meshes (they spin);
// they end up in root.userData.wheels
function mergeByMaterial(root, keepWheels = false) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const meshes = [];
  const wheels = [];
  root.traverse(o => { if (o.isMesh && isVisible(o)) (keepWheels && o.userData.wheel ? wheels : meshes).push(o); });
  root.userData.wheels = wheels.map(w => { w.geometry.computeBoundingBox(); const b = w.geometry.boundingBox; return { mesh: w, radius: Math.max(0.15, (b.max.z - b.min.z) / 2) }; });
  const byMat = new Map();
  for (const o of meshes) {
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(m);
    const mirrored = m.determinant() < 0;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    for (const gr of groups) {
      const mat = mats[gr.materialIndex];
      if (!mat || !mat.visible || !gr.count) continue;
      const part = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        const a = g.attributes[name], n = a.itemSize;
        const arr = a.array.slice(gr.start * n, (gr.start + gr.count) * n);
        // a mirrored copy (left wheels) keeps facing outward
        if (mirrored) for (let t = 0; t < gr.count; t += 3) for (let k = 0; k < n; k++) { const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k; const v = arr[i1]; arr[i1] = arr[i2]; arr[i2] = v; }
        part.setAttribute(name, new THREE.BufferAttribute(arr, n));
      }
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(part);
    }
    g.dispose();
  }
  for (const o of meshes) o.removeFromParent();
  for (const [mat, parts] of byMat) {
    const geo = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !mat.transparent;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

function isWheelFrame(name) { return /^wheel/i.test(name) && !/dummy/i.test(name) && !/^wheel_(front|rear)$/i.test(name); }
function isVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

// switch head / tail lamps on (night) or off
export function setVehicleLights(car, on) {
  for (const m of car.userData.lamps || []) m.emissiveIntensity = on ? (m.userData.lamp === 'head' ? 2.5 : 1.6) : 0;
}
