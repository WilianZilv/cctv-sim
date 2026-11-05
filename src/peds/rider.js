// People riding the moving motorcycles: a GTA ped posed with the game's riding
// animation (tools/bike-anims.mjs -> assets/peds/bike.ifp), a closed helmet on its
// head, sitting on the bike's ped_frontseat frame (and now and then a passenger on
// ped_backseat), parented to the vehicle root so they move with it and count as
// part of the vehicle (dataset crops, obstruction checks, silhouette shadows).
//
// The riding clips are still poses (two keyframes), so a rider is not a skinned
// mesh: its pose is baked once per model and clip into a plain mesh (shared
// geometry, no skinning on the GPU, exact vertices for the annotator). Two poses
// per rider: riding, and stopped with a foot down (traffic.update switches them).
//
// Objects (all under the vehicle root):
//   root.userData.riders = [group, ...]
//   group  'rider:<ped>' | 'passenger:<ped>'  userData { rider: true, seat: 'front'|'back', ped }
//     mesh    userData { rider: true }                the baked body
//     helmet  userData { rider: true, helmet: true }  shell + visor (children)
import * as THREE from 'three';
import { PedLibrary } from './model.js';

// riding pose of each motorcycle -> prefix of its clips. The game's groups
// (vehicles.ide: bikes sport, bikev scooter, bikeh chopper, biked dirt, wf) do not
// fit the pack's Brazilian replacements: the "freeway" is no chopper, the "faggio"
// is a naked street bike, the "wayfarer" a step-through. Chosen by eye:
// sport bikes lean forward (bikes), street, trail and dirt bikes sit upright
// (biked), the step-through keeps the feet on the floorboard (bikev).
const GROUP = { bf400: 'bikes', pcj600: 'bikes', copbike: 'biked', faggio: 'biked', fcr900: 'biked', freeway: 'biked', nrg500: 'biked', pizzaboy: 'biked', sanchez: 'biked', wayfarer: 'bikev' };
const HELMET_COLORS = ['#111214', '#111214', '#151619', '#e8e8e6', '#e0e2e4', '#b0151a', '#1c3f9a', '#6d7175', '#3a3d42'];
const HEAD = 'b5';
const NO_RIDE = new Set(['cwmyfr']);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));         // HAnim head
const SHELL = new THREE.SphereGeometry(1, 22, 16);
// visor: the front of the shell, eye level (three's sphere: phi = 3pi/2 faces -z)
const VISOR = new THREE.SphereGeometry(1.025, 18, 8, 1.5 * Math.PI - 0.95, 1.9, 1.2, 0.62);

export class RiderFactory {
  constructor(lib) {
    this.lib = lib;
    this.peds = new PedLibrary(lib);
    this.poses = new Map();   // ped/clip -> { geo, helmet: { pos, quat, scale } }
  }

  async init() {
    const list = await this.peds.init();
    // riders: mostly young and middle-aged men, some women; no elderly, nor the
    // one whose hair would poke through the helmet
    this.list = list.filter(p => !/old/.test(p.group || '') && !NO_RIDE.has(p.name));
    if (!this.list.length) this.list = list;
    return this;
  }

  // rider (and maybe passenger) on a motorcycle made by VehicleLibrary.create;
  // opts.passenger: true / false forces one (or none), opts.ped / opts.group force the choices
  async mount(bike, model, rng, opts = {}) {
    const g = opts.group || GROUP[model] || 'bikes';
    bike.updateMatrixWorld(true);
    const inv = bike.matrixWorld.clone().invert();
    const seatOf = (name) => {
      let n = null;
      bike.traverse(o => { if (!n && o.name === name) n = o; });
      return n ? n.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : null;
    };
    const front = seatOf('ped_frontseat');
    if (!front) return null;
    const riders = [];
    const add = async (seat, pos, clip, still) => {
      const female = rng.chance(seat === 'front' ? 0.15 : 0.45);
      const pool = this.list.filter(p => (p.sex === 'f') === female);
      const entry = (opts.ped && this.list.find(p => p.name === opts.ped)) || rng.pick(pool.length ? pool : this.list);
      const r = await this.rider(entry.name, clip, still, rng);
      if (!r) return;
      r.position.copy(pos);
      r.userData.seat = seat;
      r.name = (seat === 'front' ? 'rider:' : 'passenger:') + entry.name;
      bike.add(r);
      riders.push(r);
    };
    await add('front', front, g + '_ride', g + '_still');
    // a passenger now and then (not on the delivery scooter or the police bike)
    const back = seatOf('ped_backseat');
    if (back && model !== 'pizzaboy' && model !== 'copbike' && (opts.passenger ?? rng.chance(0.1))) await add('back', back, g + '_passenger', null);
    bike.userData.riders = riders;
    return riders;
  }

  // a posed ped with a helmet: Group with origin at the seat (the ped's root frame)
  async rider(name, clip, still, rng) {
    const ride = await this.pose(name, clip);
    if (!ride) return null;
    const stop = still ? await this.pose(name, still) : null;
    const t = await this.peds.template(name);
    const group = new THREE.Group();
    group.userData = { rider: true, ped: name };
    const mesh = new THREE.Mesh(ride.geo, t.mat);
    mesh.userData.rider = true;
    mesh.castShadow = false;            // shadow maps are static; silhouettes cover it
    mesh.receiveShadow = true;
    group.add(mesh);
    // a helmet, almost always (the law; the odd one rides without)
    let helmet = null;
    if (rng.chance(0.93)) {
      helmet = new THREE.Group();
      helmet.userData = { rider: true, helmet: true };
      const color = rng.pick(HELMET_COLORS);
      const shell = new THREE.Mesh(SHELL, this.lib.plain({ color, roughness: 0.22, metalness: 0 }, { porosity: 0, dirt: 0.05, noShare: true }));
      const visor = new THREE.Mesh(VISOR, this.lib.plain({ color: '#07080a', roughness: 0.06, metalness: 0.2 }, { porosity: 0, dirt: 0.02, noShare: true }));
      for (const m of [shell, visor]) { m.userData.rider = true; m.castShadow = false; m.receiveShadow = true; helmet.add(m); }
      group.add(helmet);
    }
    const apply = (p) => {
      mesh.geometry = p.geo;
      if (helmet) { helmet.position.copy(p.helmet.pos); helmet.quaternion.copy(p.helmet.quat); helmet.scale.copy(p.helmet.scale); }
    };
    apply(ride);
    // stopped: a foot on the ground
    group.userData.setMoving = (moving) => {
      const p = moving || !stop ? ride : stop;
      if (mesh.geometry !== p.geo) apply(p);
    };
    return group;
  }

  // the ped in a clip's first frame, baked: geometry in the seat frame (y up,
  // -z forward, origin at the ped's root frame) and where its helmet goes
  async pose(name, clipName) {
    const key = name + '/' + clipName;
    if (!this.poses.has(key)) this.poses.set(key, (async () => {
      const t = await this.peds.template(name);
      const clip = t.clips[clipName];
      if (!clip) return null;
      const { root, mesh, mixer } = await this.peds.create(name);
      const head = mesh.skeleton.bones.find(b => b.name === HEAD);
      const bodyY = t.ground ?? 0;
      // head orientation standing (to know where the face points) ...
      const idle = t.clips[t.entry.idle] || clip;
      let a = mixer.clipAction(idle).play();
      mixer.update(0);
      root.updateMatrixWorld(true);
      const q0 = head.getWorldQuaternion(new THREE.Quaternion());
      a.stop();
      // ... and on the bike
      mixer.clipAction(clip).play();
      mixer.update(0);
      root.updateMatrixWorld(true);
      const q1 = head.getWorldQuaternion(new THREE.Quaternion());
      const rel = q1.multiply(q0.invert());    // standing head -> riding head
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rel), up = new THREE.Vector3(0, 1, 0).applyQuaternion(rel);

      // skin every vertex on the CPU (positions and normals)
      const geo0 = t.geo, n = geo0.attributes.position.count;
      const P = geo0.attributes.position, N = geo0.attributes.normal;
      const si = geo0.attributes.skinIndex, sw = geo0.attributes.skinWeight;
      const sk = mesh.skeleton;
      const bm = sk.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, sk.boneInverses[i]).multiply(mesh.bindMatrix));
      const headIdx = sk.bones.indexOf(head);
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
      const M = new THREE.Matrix4(), tmp = new THREE.Matrix4(), v = new THREE.Vector3(), nv = new THREE.Vector3();
      const N3 = new THREE.Matrix3();
      const headPts = [];
      for (let i = 0; i < n; i++) {
        M.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        let hw = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (!w) continue;
          const bi = si.getComponent(i, k);
          tmp.copy(bm[bi]).multiplyScalar(w);
          for (let e = 0; e < 16; e++) M.elements[e] += tmp.elements[e];
          if (bi === headIdx) hw += w;
        }
        v.fromBufferAttribute(P, i).applyMatrix4(M);
        v.y -= bodyY;
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        if (N) {
          nv.fromBufferAttribute(N, i).applyMatrix3(N3.setFromMatrix4(M)).normalize();
          nor[i * 3] = nv.x; nor[i * 3 + 1] = nv.y; nor[i * 3 + 2] = nv.z;
        }
        if (hw > 0.6) headPts.push(v.clone());
      }
      mixer.stopAllAction();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', geo0.attributes.uv);
      geo.setIndex(geo0.index);
      if (N) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); else geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();

      // helmet: an ellipsoid around the head vertices, in the head's own axes
      const z = fwd.clone().negate().normalize();
      const y = up.clone().addScaledVector(z, -up.dot(z)).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate();
      for (const p of headPts) {
        const c = new THREE.Vector3(p.dot(x), p.dot(y), p.dot(z));
        lo.min(c); hi.max(c);
      }
      const mid = lo.clone().add(hi).multiplyScalar(0.5), half = hi.clone().sub(lo).multiplyScalar(0.5);
      // a helmet is round and bigger than the head: about 0.13 x 0.15 x 0.16 m half sizes
      const helmet = {
        pos: x.clone().multiplyScalar(mid.x).addScaledVector(y, mid.y + 0.012).addScaledVector(z, mid.z + 0.005),
        quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)),
        scale: new THREE.Vector3(clamp(half.x * 1.12, 0.118, 0.145), clamp(half.y * 1.04, 0.13, 0.158), clamp(half.z * 1.12, 0.142, 0.17)),
      };
      return { geo, helmet };
    })());
    return this.poses.get(key);
  }
}
