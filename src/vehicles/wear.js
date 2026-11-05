// Vehicle condition: how dirty, scratched, dented, rusty, crashed or burnt one car
// is. Seeded from the car's own rng (VehicleLibrary.create forks 'wear').
//
// Two layers:
//  - structure, fixed when the car is built: damaged parts (the model's *_dam
//    meshes instead of *_ok), doors ajar, bonnet / boot popped, bumpers drooping
//    or missing, glass gone on burnt cars;
//  - surface, uniforms only (src/tex/carwear.glsl.js): dust, mud, scratches,
//    crash scrapes, rust, sun fade, fire, and up to 3 dents (vertex push + normal).
//
// Runtime API: root.userData.rerollWear(rng) re-rolls the surface layer of a built
// car (uniforms only, no rebuild, no new shader program), keeping it consistent
// with its structural damage (a crashed car stays at least 'worn', a burnt one
// stays burnt). It returns the new state, also kept in root.userData.wear:
//   { tier: 'clean'|'used'|'worn'|'wrecked'|'burnt', dust, mud, scratch, rust,
//     burnt, scrape, fade, dents, parts: [ 'bump_front:dam', 'door_lf:ajar', ... ] }
import * as THREE from 'three';

// overall mix of a street: most cars used, some clean, some beaten up, a few
// wrecks, rare burnt shells
const TIERS = [['clean', 0.16], ['used', 0.48], ['worn', 0.24], ['wrecked', 0.09], ['burnt', 0.03]];
const TIER_RANK = { clean: 0, used: 1, worn: 2, wrecked: 3, burnt: 4 };

// linear albedo
const DUST = [[0.42, 0.37, 0.30], [0.38, 0.37, 0.35], [0.40, 0.27, 0.19], [0.33, 0.31, 0.28]];
const MUD = [[0.20, 0.08, 0.035], [0.13, 0.085, 0.05], [0.15, 0.14, 0.13], [0.09, 0.07, 0.05], [0.24, 0.12, 0.06]];

export function makeWearUniforms() {
  return {
    uWear0: { value: new THREE.Vector4() },
    uWear1: { value: new THREE.Vector4() },
    uWear2: { value: new THREE.Vector4(0, 1, 0.6, 1) },
    uDustCol: { value: new THREE.Color() },
    uMudCol: { value: new THREE.Color() },
    uWheels: { value: new THREE.Vector4(0.8, -1.4, 1.4, 0.32) },
    uDent: { value: [0, 1, 2].map(() => new THREE.Vector4(0, 0, 0, 1)) },
    uDentN: { value: [0, 1, 2].map(() => new THREE.Vector4(0, 0, 1, 0)) },
    uDentP: { value: [0, 1, 2].map(() => new THREE.Vector4(1, 0, 0, 0)) },
  };
}

// floor: lowest tier allowed; burnt only when allowed (a new car) or required
export function pickTier(rng, age, floor = 'clean', allowBurnt = true) {
  if (floor === 'burnt') return 'burnt';
  // old cars lean worse, new ones cleaner
  const w = TIERS.map(([t, p]) => [t, p * (t === 'clean' ? 1.6 - 1.2 * age : t === 'used' ? 1 : 0.6 + 0.8 * age)]);
  const ok = w.filter(([t]) => TIER_RANK[t] >= TIER_RANK[floor] && (t !== 'burnt' || allowBurnt));
  let r = rng.next() * ok.reduce((s, x) => s + x[1], 0);
  for (const [t, p] of ok) if ((r -= p) <= 0) return t;
  return ok[ok.length - 1][0];
}

// the condition a car is built with: tier + structural choices
// force: a tier name to build that condition (tests, dataset balancing)
export function rollCondition(rng, age, force = null) {
  const t0 = pickTier(rng, age);
  const tier = TIER_RANK[force] !== undefined ? force : t0;
  return { tier, age, rng };
}

const PART_RE = /^(door_[lr][fr]|bonnet|boot|bump_front|bump_rear|windscreen|wing_[lr][fr])_dummy$/i;

// which part frames show their damaged mesh, which get posed, which go missing.
// frames: dff frames; hasGeo(i): frame i carries geometry
export function planParts(frames, cond, hasGeo) {
  const { tier } = cond;
  const rng = cond.rng.fork('parts');
  const plan = { swap: new Map(), hide: new Set(), poses: [], parts: [], glassGone: false };
  if (tier === 'clean') return plan;
  const kids = frames.map(() => []);
  frames.forEach((f, i) => { if (f.parent >= 0) kids[f.parent].push(i); });
  const parts = [];
  frames.forEach((f, i) => {
    const m = f.name.match(PART_RE);
    if (!m) return;
    const isOk = (k) => /_ok$/i.test(frames[k].name) && !/^ug_/i.test(frames[k].name);
    const isDam = (k) => /_dam$/i.test(frames[k].name) && !/^ug_/i.test(frames[k].name);
    const ok = kids[i].find(k => isOk(k) && hasGeo(k));
    // mods misname the damaged one (door_rf_dummy > door_lf_dam): pair by parent
    const dam = kids[i].find(k => isDam(k) && hasGeo(k));
    parts.push({ dummy: i, part: m[1].toLowerCase(), ok, dam });
  });
  // how many parts are damaged, and how likely each pose is
  const R = {
    used: { dam: [0, 0, 0, 0, 0, 0, 1], droop: 0.05, ajar: 0.03, pop: 0.0, missB: 0, missH: 0 },
    worn: { dam: [0, 0, 1, 1, 1, 2], droop: 0.22, ajar: 0.05, pop: 0.05, missB: 0.02, missH: 0 },
    wrecked: { dam: [1, 2, 3, 3, 4, 5], droop: 0.45, ajar: 0.2, pop: 0.3, missB: 0.12, missH: 0.06 },
    burnt: { dam: [2, 3, 4, 5, 6], droop: 0.4, ajar: 0.25, pop: 0.35, missB: 0.2, missH: 0.12 },
  }[tier];
  const W = { bump_front: 3, bump_rear: 2.6, bonnet: 1.2, boot: 0.8, windscreen: 1, door_lf: 1, door_rf: 1, door_lr: 0.7, door_rr: 0.7, wing_lf: 1, wing_rf: 1 };
  const nDam = rng.pick(R.dam);
  const pool = parts.filter(p => p.ok != null && p.dam != null);
  for (let n = 0; n < nDam && pool.length; n++) {
    let r = rng.next() * pool.reduce((s, p) => s + W[p.part], 0), k = 0;
    for (; k < pool.length - 1; k++) if ((r -= W[pool[k].part]) <= 0) break;
    const p = pool.splice(k, 1)[0];
    plan.swap.set(p.ok, p.dam);
    plan.parts.push(p.part + ':dam');
  }
  const byPart = (re) => parts.filter(p => re.test(p.part) && (p.ok != null || p.dam != null));
  // a bumper hanging loose at one end, or gone
  for (const p of byPart(/^bump_/)) {
    if (rng.chance(R.missB * 0.5)) { plan.hide.add(p.dummy); plan.parts.push(p.part + ':missing'); continue; }
    if (rng.chance(R.droop * 0.6)) {
      const severe = tier === 'wrecked' || tier === 'burnt';
      plan.poses.push({ dummy: p.dummy, type: 'bumper', end: rng.sign(), drop: rng.float(0.03, severe ? 0.16 : 0.07), yaw: rng.float(0.5, severe ? 4 : 2) * Math.PI / 180, sag: rng.float(0.005, 0.02) });
      plan.parts.push(p.part + ':droop');
    }
  }
  for (const p of byPart(/^bonnet$/)) {
    if (rng.chance(R.missH)) { plan.hide.add(p.dummy); plan.parts.push('bonnet:missing'); continue; }
    if (rng.chance(R.pop)) { plan.poses.push({ dummy: p.dummy, type: 'lid', angle: rng.float(1.5, tier === 'used' || tier === 'worn' ? 3.5 : 9) * Math.PI / 180 }); plan.parts.push('bonnet:popped'); }
  }
  for (const p of byPart(/^boot$/)) {
    if (rng.chance(R.pop * 0.6)) { plan.poses.push({ dummy: p.dummy, type: 'lid', angle: rng.float(1.5, tier === 'used' || tier === 'worn' ? 3 : 7) * Math.PI / 180 }); plan.parts.push('boot:popped'); }
  }
  for (const p of byPart(/^door_/)) {
    if (rng.chance(R.ajar * 0.5)) {
      const open = rng.chance(0.15);
      plan.poses.push({ dummy: p.dummy, type: 'door', angle: (open ? rng.float(18, 40) : rng.float(2, 9)) * Math.PI / 180 });
      plan.parts.push(p.part + (open ? ':open' : ':ajar'));
    }
  }
  if (tier === 'burnt' && rng.chance(0.75)) { plan.glassGone = true; plan.parts.push('glass:gone'); }
  return plan;
}

const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();

// box of the visible meshes under a dummy, in the dummy's own space
function partBox(dummy, isVisible) {
  dummy.updateMatrixWorld(true);
  const inv = dummy.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  dummy.traverse(o => {
    if (!o.isMesh || o.userData.plateSize || !isVisible(o)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(_m.multiplyMatrices(inv, o.matrixWorld)));
  });
  return box.isEmpty() ? null : box;
}

// rotate a node by `angle` about `axis` (dummy space) through point `pivot`
// (dummy space): local' = local * T(p) R T(-p)
function rotateAbout(node, axis, angle, pivot) {
  const R = new THREE.Matrix4().makeRotationAxis(axis.clone().normalize(), angle);
  const T = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  const Ti = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  const L = new THREE.Matrix4().compose(node.position, node.quaternion, node.scale);
  return L.multiply(T).multiply(R).multiply(Ti);
}
function setLocal(node, L) { L.decompose(node.position, node.quaternion, node.scale); node.updateMatrixWorld(true); }

// pose the planned parts. Called once the car stands on the ground (root space:
// y up, -Z forward) and before the plates are recorded, so plates on a moved part
// follow it. A bumper never ends up below 4 cm.
export function poseParts(root, nodes, plan, isVisible) {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const toRoot = (node, pLocal) => pLocal.clone().applyMatrix4(node.parent.matrixWorld).applyMatrix4(rootInv);
  for (const pose of plan.poses) {
    const node = nodes[pose.dummy];
    const box = partBox(node, isVisible);
    if (!box) continue;
    // root axes in the dummy's space
    const rot = new THREE.Matrix4().extractRotation(_m.multiplyMatrices(rootInv, node.matrixWorld)).invert();
    const upL = new THREE.Vector3(0, 1, 0).applyMatrix4(rot), fwdL = new THREE.Vector3(0, 0, -1).applyMatrix4(rot), sideL = new THREE.Vector3(1, 0, 0).applyMatrix4(rot);
    const c = box.getCenter(new THREE.Vector3());
    const corner = (pick) => new THREE.Vector3(pick(box.min.x, box.max.x, 'x'), pick(box.min.y, box.max.y, 'y'), pick(box.min.z, box.max.z, 'z'));
    // a point of the box extreme along direction d (dummy space)
    const extreme = (d, base) => corner((lo, hi, k) => (Math.abs(d[k]) > 0.5 ? (d[k] > 0 ? hi : lo) : base[k]));
    const centerRoot = (L) => c.clone().applyMatrix4(L).applyMatrix4(node.parent.matrixWorld).applyMatrix4(rootInv);
    const c0 = toRoot(node, c.clone().applyMatrix4(new THREE.Matrix4().compose(node.position, node.quaternion, node.scale)));
    if (pose.type === 'door') {
      // hinge on the front outer edge, axis up; open outward
      const out = Math.sign(c0.x) || 1;
      const pivot = extreme(fwdL, extreme(sideL.clone().multiplyScalar(out), c));
      let best = null;
      for (const s of [1, -1]) {
        const L = rotateAbout(node, upL, s * pose.angle, pivot);
        const x = centerRoot(L).x * out;
        if (!best || x > best.x) best = { L, x };
      }
      setLocal(node, best.L);
    } else if (pose.type === 'lid') {
      // hinge on the edge toward the cabin, top; the free edge lifts
      const towardCabin = c0.z < 0 ? fwdL.clone().negate() : fwdL;
      const pivot = extreme(upL, extreme(towardCabin, c));
      let best = null;
      for (const s of [1, -1]) {
        const L = rotateAbout(node, sideL, s * pose.angle, pivot);
        const y = centerRoot(L).y;
        if (!best || y > best.y) best = { L, y };
      }
      setLocal(node, best.L);
    } else if (pose.type === 'bumper') {
      // still held at one end, the other end drops and pulls away from the body
      const held = extreme(sideL.clone().multiplyScalar(pose.end), c);
      const width = Math.max(0.5, box.getSize(new THREE.Vector3()).dot(new THREE.Vector3(Math.abs(sideL.x), Math.abs(sideL.y), Math.abs(sideL.z))));
      const L0 = new THREE.Matrix4().compose(node.position, node.quaternion, node.scale);
      let angle = Math.asin(Math.min(0.5, pose.drop / width));
      for (let tries = 0; tries < 6; tries++, angle *= 0.6) {
        node.position.setFromMatrixPosition(L0); node.quaternion.setFromRotationMatrix(L0);
        let L = null;
        for (const s of [1, -1]) {
          const cand = rotateAbout(node, fwdL, s * angle, held);
          const y = centerRoot(cand).y;
          if (!L || y < L.y) L = { m: cand, y };
        }
        setLocal(node, L.m);
        // pull the loose end out a little (yaw about the held end), and sag
        let Y = null;
        for (const s of [1, -1]) {
          const cand = rotateAbout(node, upL, s * pose.yaw * (tries ? 0.5 : 1), held);
          const p = centerRoot(cand);
          const outward = Math.abs(p.z);
          if (!Y || outward > Y.o) Y = { m: cand, o: outward };
        }
        setLocal(node, Y.m);
        node.position.addScaledVector(new THREE.Vector3(0, -1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(_m.copy(node.parent.matrixWorld).premultiply(rootInv)).invert()), pose.sag);
        node.updateMatrixWorld(true);
        const b = new THREE.Box3();
        node.traverse(o => { if (o.isMesh && isVisible(o)) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.union(o.geometry.boundingBox.clone().applyMatrix4(_m.multiplyMatrices(rootInv, o.matrixWorld))); } });
        if (b.isEmpty() || b.min.y > 0.04) break;
      }
    }
  }
}

// points on the painted body where dents may go (root space, after the merge):
// sides, nose and tail between 0.25 and 1.3 m, away from the plates
export function dentSites(root, plates) {
  const out = [];
  const platePos = plates.map(p => new THREE.Vector3().setFromMatrixPosition(p.m));
  for (const o of root.children) {
    if (!o.isMesh || o.material?.userData?.u?.uWearKind?.value !== 0) continue;
    const pos = o.geometry.attributes.position, nrm = o.geometry.attributes.normal;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      const y = pos.getY(i);
      if (y < 0.25 || y > 1.3) continue;
      const p = new THREE.Vector3(pos.getX(i), y, pos.getZ(i));
      if (platePos.some(q => q.distanceTo(p) < 0.55)) continue;
      // push direction: the surface normal, or straight out from the car's axis
      const outv = new THREE.Vector3(p.x, 0, p.z * 0.35).normalize();
      let n = nrm ? new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).normalize() : outv.clone();
      if (Math.abs(n.y) > 0.6) continue;
      if (n.dot(outv) < 0) n = outv;
      out.push(p.x, p.y, p.z, n.x, n.y, n.z);
    }
  }
  return new Float32Array(out);
}

// the surface layer: writes the uniforms, returns the state
export function rollSurface(u, rng, tier, age, ctx) {
  const s = { tier, dust: 0, mud: 0, scratch: 0, rust: 0, burnt: 0, scrape: 0, fade: 0, dents: 0 };
  const U = (a, b) => rng.float(a, b);
  const old = age > 0.55 ? (age - 0.55) / 0.45 : 0;
  let nd = 0, depth = [0.015, 0.03], rad = [0.15, 0.32];
  switch (tier) {
    case 'clean':
      s.dust = U(0, 0.12); s.scratch = U(0, 0.08); s.mud = rng.chance(0.1) ? U(0.05, 0.2) : 0;
      break;
    case 'used':
      s.dust = U(0.12, 0.45); s.scratch = U(0.1, 0.4); s.mud = rng.chance(0.4) ? U(0.1, 0.45) : 0;
      s.rust = old * U(0, 0.3); s.fade = old * U(0, 0.5);
      nd = rng.chance(0.35) ? 1 : 0; s.scrape = U(0, 0.4);
      break;
    case 'worn':
      s.dust = U(0.3, 0.7); s.scratch = U(0.3, 0.7); s.mud = rng.chance(0.55) ? U(0.2, 0.7) : U(0, 0.15);
      s.rust = U(0.05, 0.25) + old * U(0, 0.4); s.fade = (0.2 + old) * U(0, 0.6);
      nd = rng.chance(0.7) ? rng.int(1, 2) : 0; depth = [0.02, 0.05]; rad = [0.2, 0.45]; s.scrape = U(0.2, 0.65);
      break;
    case 'wrecked':
      s.dust = U(0.35, 0.8); s.scratch = U(0.5, 0.9); s.mud = rng.chance(0.5) ? U(0.2, 0.8) : U(0, 0.2);
      s.rust = U(0.1, 0.4) + old * U(0, 0.35); s.fade = (0.3 + old) * U(0, 0.6);
      nd = rng.int(2, 3); depth = [0.04, 0.08]; rad = [0.25, 0.6]; s.scrape = U(0.55, 1);
      break;
    case 'burnt':
      s.burnt = U(0.75, 1); s.dust = U(0.2, 0.6); s.scratch = U(0.2, 0.6); s.rust = U(0.2, 0.5); s.mud = rng.chance(0.3) ? U(0.1, 0.4) : 0;
      nd = rng.int(1, 3); depth = [0.03, 0.07]; rad = [0.25, 0.55]; s.scrape = U(0.3, 0.8);
      break;
  }
  // a muddy streak of luck: dirt-road cars
  if (tier !== 'clean' && rng.chance(0.08)) s.mud = U(0.6, 1);
  const seed = rng.float(0, 100);
  u.uWear0.value.set(s.dust, s.mud, s.scratch, Math.min(1, s.rust));
  // fire starts in the engine bay (front) or the cabin
  const half = (ctx.size?.z || 4.5) / 2;
  const fireZ = rng.chance(0.6) ? -half * U(0.4, 0.9) : U(-0.4, 0.4);
  u.uWear1.value.set(s.burnt, s.scrape, seed, Math.min(1, s.fade));
  u.uWear2.value.set(fireZ, U(1.2, 4), U(0.45, 0.8), U(0.3, 1));
  u.uDustCol.value.setRGB(...rng.pick(DUST)).multiplyScalar(U(0.85, 1.1));
  u.uMudCol.value.setRGB(...rng.pick(MUD)).multiplyScalar(U(0.85, 1.15));
  // dents at random body points
  const sites = ctx.sites || new Float32Array(0), nSites = sites.length / 6;
  for (let i = 0; i < 3; i++) {
    const D = u.uDent.value[i], N = u.uDentN.value[i], P = u.uDentP.value[i];
    if (i >= nd || !nSites) { N.w = 0; continue; }
    let r = U(rad[0], rad[1]), k = -1;
    // the bowl must not reach a plate (the plate does not follow the push)
    for (let t = 0; t < 12 && k < 0; t++) {
      const c = Math.floor(rng.next() * nSites) * 6;
      const near = (ctx.platePos || []).reduce((m, q) => Math.min(m, Math.hypot(q.x - sites[c], q.y - sites[c + 1], q.z - sites[c + 2])), Infinity);
      if (near > r + 0.12) k = c;
      else if (t > 6) r = Math.max(0.12, near - 0.12);
    }
    if (k < 0) { N.w = 0; continue; }
    // sit the centre a little outside the panel: the dent is a bowl, not a hole
    D.set(sites[k], sites[k + 1], sites[k + 2], r);
    N.set(sites[k + 3], sites[k + 4], sites[k + 5], U(depth[0], depth[1]));
    P.set(U(1.0, 1.8), (tier === 'clean' ? 0 : U(0.4, 1)) * Math.min(1, s.scrape + 0.4), U(0.3, 1) * (tier === 'wrecked' || tier === 'burnt' ? 1 : 0.5), U(0, 10));
    s.dents++;
  }
  return s;
}

// structural floor for rerolls: the damage that is built in sets the lowest tier
export function floorTier(plan, tier) {
  if (tier === 'burnt') return 'burnt';
  const n = plan.parts.length;
  if (n >= 3 || plan.hide.size) return 'wrecked';
  if (n >= 2) return 'worn';
  if (n >= 1) return 'used';
  return 'clean';
}

