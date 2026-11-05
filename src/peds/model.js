// GTA San Andreas peds (assets/peds, see tools/peds-extract.mjs) as three.js
// skinned meshes: one SkinnedMesh and one material per ped, the bones named by
// their HAnim id ("b" + id) so one AnimationClip drives every model.
import * as THREE from 'three';
import { parseDFF, parseTXD } from '../vehicles/rw.js';
import { parseSkinning } from './rwskin.js';
import { parseIFP } from './ifp.js';
import { KITS, paintKit } from './jersey.js';

const BASE = '/assets/peds/';
const fetchBuf = async (p) => {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error('não achei ' + p);
  return new Uint8Array(await r.arrayBuffer());
};
const boneName = (id) => 'b' + id;
// RenderWare is z-up; the model's root turns it y-up (forward +y -> -z)
const RW_TO_Y = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const Y_TO_RW = RW_TO_Y.clone().invert();

// parsed files and clips: shared by every world build
const SHARED = { manifest: null, ifp: null, models: new Map(), clips: new Map() };

export class PedLibrary {
  constructor(lib) {
    this.lib = lib;          // the world's material library (wetness, IR, fog)
    this.templates = new Map();
  }

  async init() {
    if (!SHARED.manifest) {
      SHARED.manifest = (async () => {
        // ped.ifp: walking and standing; bike.ifp: riding a motorcycle (tools/bike-anims.mjs)
        const [list, ifp, bike] = await Promise.all([fetch(BASE + 'peds.json').then(r => r.json()), fetchBuf('ped.ifp'), fetchBuf('bike.ifp').catch(() => null)]);
        SHARED.ifp = parseIFP(ifp);
        if (bike) SHARED.ifp.anims.push(...parseIFP(bike).anims);
        return list;
      })();
    }
    this.list = await SHARED.manifest;
    return this.list;
  }

  async load(name) {
    if (!SHARED.models.has(name)) {
      const entry = this.list.find(p => p.name === name);
      SHARED.models.set(name, (async () => {
        const [dff, txd] = await Promise.all([fetchBuf(`models/${name}.dff`), fetchBuf(`models/${entry.txd}.txd`)]);
        return { entry, dff: parseDFF(dff), skin: parseSkinning(dff), txd: parseTXD(txd) };
      })());
    }
    return SHARED.models.get(name);
  }

  // geometry, material, bone layout and clips of a model (per world: the material
  // belongs to the world's material library)
  async template(name) {
    if (this.templates.has(name)) return this.templates.get(name);
    const p = (async () => {
      const m = await this.load(name);
      const { dff, skin, txd, entry } = m;
      const gi = dff.atomics[0]?.geometry ?? 0;
      const g = dff.geometries[gi], sk = skin.skins[gi];
      if (!sk || !skin.hierarchy) throw new Error('ped sem skin: ' + name);
      // the body texture (most used); small accessories (watch, earrings) are left out
      // so the ped draws with a single material
      const use = new Map();
      for (let i = 0; i < g.tris.length; i += 4) { const t = g.materials[g.tris[i + 3]]?.texture; use.set(t, (use.get(t) || 0) + 1); }
      const main = [...use.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const index = [];
      for (let i = 0; i < g.tris.length; i += 4) if (g.materials[g.tris[i + 3]]?.texture === main) index.push(g.tris[i], g.tris[i + 1], g.tris[i + 2]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
      if (g.normals) geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs[0] || new Float32Array(g.nVert * 2), 2));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Uint16Array.from(sk.indices), 4));
      // weights sum to one (the game does not always)
      const w = sk.weights.slice();
      for (let v = 0; v < g.nVert; v++) { const s = w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3]; if (s > 0) for (let k = 0; k < 4; k++) w[v * 4 + k] /= s; else w[v * 4] = 1; }
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
      geo.setIndex(index);
      if (!g.normals) geo.computeVertexNormals();

      const src = txd.get(main) || [...txd.values()][0];
      const tex = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.flipY = false;
      tex.needsUpdate = true;
      const mat = this.lib.plain({ name: 'ped:' + name, map: tex, roughness: 0.8, metalness: 0 }, { porosity: 0.35, dirt: 0.1, spec: 0.5, skyvisSpec: 0 });
      const body = { g, sk, index, src, tex };

      // bones present in this model: one clip set per bone layout
      const ids = skin.hierarchy.map(h => h.id);
      const sig = ids.slice().sort((a, b) => a - b).join(',');
      const t = { name, entry, dff, skin, geo, mat, ids, sig, body, kits: new Map(), clips: clipsFor(sig, new Set(ids)) };
      t.ground = groundOffset(t);
      return t;
    })();
    this.templates.set(name, p);
    return p;
  }

  // the model's material with a football shirt painted on (KITS), made once per model
  kitMaterial(t, kit) {
    if (!t.kits.has(kit)) {
      const { g, sk, index, src, tex } = t.body;
      const rgba = paintKit(g, sk, t.ids, index, src, KITS[kit]);
      const k = tex.clone();
      k.image = { data: rgba, width: src.width, height: src.height };
      k.needsUpdate = true;
      t.kits.set(kit, this.lib.plain({ name: 'ped:' + t.name + ':' + kit, map: k, roughness: 0.8, metalness: 0 }, { porosity: 0.35, dirt: 0.1, spec: 0.5, skyvisSpec: 0 }));
    }
    return t.kits.get(kit);
  }

  // a ready-to-place ped: origin between the feet on the ground, facing -Z;
  // opts.kit puts on a football shirt
  async create(name, opts = {}) {
    const t = await this.template(name);
    const { root, mesh } = buildRig(t);
    if (opts.kit && KITS[opts.kit]) mesh.material = this.kitMaterial(t, opts.kit);
    root.name = 'ped:' + name;
    const mixer = new THREE.AnimationMixer(root);
    return { root, mesh, mixer, template: t };
  }
}

// frames -> bones under a y-up body; the skinned mesh beside them
function buildRig(t) {
  const { dff, skin } = t;
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.x = -Math.PI / 2;
  body.position.y = t.ground ?? 0;
  root.add(body);
  const nodes = dff.frames.map((f, i) => {
    const o = new THREE.Bone();
    const id = skin.boneIds[i];
    o.name = id >= 0 ? boneName(id) : 'f' + i;
    const r = f.rot;
    o.matrix.set(r[0], r[3], r[6], f.pos[0], r[1], r[4], r[7], f.pos[1], r[2], r[5], r[8], f.pos[2], 0, 0, 0, 1);
    o.matrix.decompose(o.position, o.quaternion, o.scale);
    return o;
  });
  dff.frames.forEach((f, i) => (f.parent >= 0 ? nodes[f.parent] : body).add(nodes[i]));
  const byId = new Map();
  nodes.forEach((n, i) => { if (skin.boneIds[i] >= 0) byId.set(skin.boneIds[i], n); });
  const bones = skin.hierarchy.map(h => byId.get(h.id));
  // inverse bind matrices come in RW space (rows: right, up, at, pos); the mesh is
  // bound under the rotated body, so they are taken back through that rotation
  const sk = skin.skins[dff.atomics[0]?.geometry ?? 0];
  const inverses = sk.inverse.slice(0, bones.length).map(m => new THREE.Matrix4().set(
    m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], 0, 0, 0, 1).multiply(Y_TO_RW));
  const mesh = new THREE.SkinnedMesh(t.geo, t.mat);
  body.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, inverses), RW_TO_Y.clone());
  // the pose changes the extent little: a fixed sphere around the body (RW space)
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.25);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, -0.9, -1.15), new THREE.Vector3(0.9, 0.9, 1.0));
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return { root, mesh };
}

// height of the root above the soles: lowest skinned vertex in the first frame of
// the standing pose
function groundOffset(t) {
  const { root, mesh } = buildRig({ ...t, ground: 0 });
  const idle = t.clips[t.entry.idle] || Object.values(t.clips)[0];
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(idle).play();
  mixer.update(0);
  root.updateMatrixWorld(true);
  mesh.skeleton.update();
  const v = new THREE.Vector3();
  let min = Infinity;
  const n = t.geo.attributes.position.count;
  for (let i = 0; i < n; i += 3) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); min = Math.min(min, v.y); }
  mixer.stopAllAction();
  return -min;
}

// IFP animations -> clips keyed by lower-case name. The walk cycles carry the
// ped forward on the root bone: that drift is taken out (the agent moves the
// ped) and kept as clip.userData.speed (m/s at timeScale 1), so the feet do not
// slide when the agent moves at speed * timeScale.
function clipsFor(sig, ids) {
  if (SHARED.clips.has(sig)) return SHARED.clips.get(sig);
  const out = {};
  for (const a of SHARED.ifp.anims) {
    const tracks = [];
    let duration = 0, speed = 0;
    for (const o of a.objects) {
      if (!ids.has(o.boneId) || !o.times.length) continue;
      const n = o.times.length;
      const times = Float32Array.from(o.times);
      duration = Math.max(duration, times[n - 1]);
      // keep consecutive quaternions in the same hemisphere for slerp
      const q = Float32Array.from(o.rot);
      for (let f = 1; f < n; f++) {
        const d = q[f * 4] * q[f * 4 - 4] + q[f * 4 + 1] * q[f * 4 - 3] + q[f * 4 + 2] * q[f * 4 - 2] + q[f * 4 + 3] * q[f * 4 - 1];
        if (d < 0) for (let k = 0; k < 4; k++) q[f * 4 + k] = -q[f * 4 + k];
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(boneName(o.boneId) + '.quaternion', times, q));
      if (o.trans) {
        const p = Float32Array.from(o.trans);
        if (o.boneId === 0 && n > 1) {
          const T = times[n - 1] - times[0];
          const dy = p[(n - 1) * 3 + 1] - p[1];
          if (T > 0 && dy > 0.2) {
            speed = dy / T;
            for (let f = 0; f < n; f++) p[f * 3 + 1] -= dy * (times[f] - times[0]) / T;
          }
        }
        tracks.push(new THREE.VectorKeyframeTrack(boneName(o.boneId) + '.position', times, p));
      }
    }
    const clip = new THREE.AnimationClip(a.name, duration, tracks);
    clip.userData = { speed };
    out[a.name.toLowerCase()] = clip;
  }
  SHARED.clips.set(sig, out);
  return out;
}
