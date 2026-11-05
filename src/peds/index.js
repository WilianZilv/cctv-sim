// Pedestrians: GTA San Andreas civilians walking the sidewalks around the camera.
//
// Contract with the rest of the simulator:
//  - buildPedestrians(ctx) is awaited during the world build, after the parked
//    cars; it adds its objects to ctx.group (or ctx.scene) and returns an object
//    with update(dt, t, env) and dispose(), or null.
//  - it keeps ctx.pedAgents = [{ x, z, crossing }] current every update, so
//    traffic can yield to people crossing.
//  - it may read ctx.trafficCars = [{ x, z, dx, dz, speed, len }] (kept by the
//    traffic module) to wait before crossing.
//
// Each ped walks from one point of the sidewalk to another (A* over src/peds/nav.js),
// sometimes stops for a while, and now and then crosses the street straight from
// kerb to kerb: it stops at the kerb, looks both ways and waits for a gap in the
// traffic. Animations come from the game (walk style per model, idle, looking
// around); the walk is played at the rate that matches the ped's speed.
import * as THREE from 'three';
import { PedLibrary } from './model.js';
import { NavGrid } from './nav.js';

const RANGE = 40;          // trips stay within this distance of the focus
// share of peds in a Flamengo shirt (?kits=1 for all of them, to look at)
const KIT_SHARE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('kits') ? 1 : 1 / 15;
const FADE = 0.25;         // animation cross-fade (s)

export async function buildPedestrians(ctx, { count = [6, 15] } = {}) {
  ctx.pedAgents = [];
  // ?nopeds: none (A/B checks)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nopeds')) return null;
  const r = ctx.rng.fork('peds');
  const t0 = performance.now();
  const nav = new NavGrid(ctx);
  console.log('[sim] peds nav', Math.round(performance.now() - t0), 'ms,', nav.crossings.length, 'travessias');
  const lib = new PedLibrary(ctx.lib);
  const list = await lib.init();

  const group = new THREE.Group();
  group.name = 'peds';
  ctx.group.add(group);
  const want = r.int(count[0], count[1]);
  const agents = [];
  const taken = [];
  for (let n = 0; n < want; n++) {
    const ar = r.fork('ped' + n);
    // a free spot near the focus, not on top of another ped
    let k = -1;
    for (let tries = 0; tries < 40 && k < 0; tries++) {
      const a = ar.float(0, Math.PI * 2), d = Math.sqrt(ar.next()) * 30;
      const c = nav.snap(ctx.focus[0] + Math.cos(a) * d, ctx.focus[1] + Math.sin(a) * d, 2, 0.6);
      if (c < 0) continue;
      const [x, z] = nav.center(c);
      if (taken.some(p => Math.hypot(p[0] - x, p[1] - z) < 2.5)) continue;
      k = c;
    }
    if (k < 0) continue;
    const entry = ar.pick(list);
    let ped;
    // a few in a football shirt, not a crowd of fans
    const kit = ar.fork('kit').chance(KIT_SHARE) ? 'flamengo' : null;
    try { ped = await lib.create(entry.name, { kit }); } catch (e) { console.warn('[sim] ped', entry.name, e.message); continue; }
    const [x, z] = nav.center(k);
    taken.push([x, z]);
    group.add(ped.root);
    agents.push(new Agent(ped, entry, nav, ctx, ar, x, z));
  }
  const shadows = new PedShadows(group, Math.max(1, agents.length));
  console.log('[sim] peds', agents.map(a => a.entry.name).join(' '));

  ctx.pedAgents = agents.map(a => a.pub);
  // fewer people out at night: a ped leaves when it ends a trip out of the camera's
  // reach, and comes back walking in from there
  const rr = r.fork('respawn');
  const far = (x, z) => { const c = ctx.cameraPose?.position; return !c || Math.hypot(x - c.x, z - c.z) > 30; };
  const spawnPoint = () => {
    for (let tries = 0; tries < 30; tries++) {
      const a = rr.float(0, Math.PI * 2), d = rr.float(15, RANGE);
      const k = nav.snap(ctx.focus[0] + Math.cos(a) * d, ctx.focus[1] + Math.sin(a) * d, 2, 0.6);
      if (k < 0) continue;
      const [x, z] = nav.center(k);
      if (far(x, z) || tries > 20) return [x, z];
    }
    return null;
  };
  let first = true;
  return {
    group, agents, nav,
    update(dt, t, env) {
      const cars = ctx.trafficCars || [];
      const target = Math.max(1, Math.round(agents.length * (1 - 0.75 * (env?.state?.nightF || 0))));
      if (first) { agents.forEach((a, i) => a.setActive(i < target)); first = false; }
      let on = agents.reduce((n, a) => n + (a.active ? 1 : 0), 0);
      for (const a of agents) if (on > target && a.active && a.state === 'idle' && far(a.x, a.z)) { a.setActive(false); on--; }
      if (on < target) {
        const a = agents.find(a => !a.active), p = spawnPoint();
        if (a && p) { a.x = p[0]; a.z = p[1]; a.setActive(true); }
      }
      for (const a of agents) if (a.active) a.update(dt, agents, cars);
      shadows.update(agents, env);
      ctx.pedAgents = agents.filter(a => a.active).map(a => a.pub);
    },
    dispose() {
      ctx.group.remove(group);
      shadows.dispose();
      for (const a of agents) a.mixer.stopAllAction();
      ctx.pedAgents = [];
    },
  };
}

class Agent {
  constructor(ped, entry, nav, ctx, rng, x, z) {
    this.ped = ped; this.root = ped.root; this.mixer = ped.mixer; this.entry = entry;
    this.nav = nav; this.ctx = ctx; this.r = rng;
    this.x = x; this.z = z;
    this.yaw = rng.float(0, Math.PI * 2);
    this.y = ctx.sidewalkY(x, z);
    // walk style: the model's own, sometimes borrowed from its sex's common ones
    const clips = ped.template.clips;
    const own = clips[entry.walk] ? entry.walk : entry.sex === 'f' ? 'woman_walknorm' : 'walk_civi';
    const alt = entry.sex === 'f' ? ['woman_walknorm', 'woman_walkshop'] : ['walk_civi'];
    const walkName = rng.chance(0.75) ? own : rng.pick(alt);
    this.walkClip = clips[walkName] || clips.walk_civi;
    this.idleClip = clips[entry.idle] || clips.idle_stance;
    this.lookClip = clips[entry.sex === 'f' ? 'roadcross_female' : 'roadcross'] || this.idleClip;
    // people walk at 1.1-1.6 m/s; the clip plays at the rate that fits
    const base = this.walkClip.userData.speed || 1.4;
    this.speed = THREE.MathUtils.clamp(rng.gauss(1.32, 0.13) * (walkName.includes('old') ? 0.75 : 1), 0.8, 1.7);
    this.rate = this.speed / base;
    this.actions = {
      walk: this.mixer.clipAction(this.walkClip),
      idle: this.mixer.clipAction(this.idleClip),
      look: this.mixer.clipAction(this.lookClip),
    };
    this.actions.walk.timeScale = this.rate;
    this.actions.look.setLoop(THREE.LoopOnce, 1);
    this.actions.look.clampWhenFinished = true;
    this.cur = null;
    this.side = 0;            // lateral offset when passing someone (m)
    this.pub = { x, z, crossing: false, dx: 0, dz: 0 };
    this.state = 'idle';
    this.timer = rng.float(0, 3);
    this.play('idle', 0);
    // start each one at its own phase of the cycle
    this.actions.walk.time = rng.float(0, this.walkClip.duration);
    this.actions.idle.time = rng.float(0, this.idleClip.duration);
    this.place(0);
  }

  setActive(on) {
    this.active = on;
    this.root.visible = on;
    this.trip = []; this.leg = null; this.state = 'idle';
    this.timer = this.r.float(0, 2);
    this.y = this.ctx.sidewalkY(this.x, this.z);
    this.place(0);
  }

  play(name, fade = FADE) {
    if (this.cur === name) return;
    const next = this.actions[name];
    next.enabled = true;
    if (name === 'look') next.reset();
    next.setEffectiveWeight(1);
    next.play();
    if (this.cur) this.actions[this.cur].crossFadeTo(next, fade, false);
    this.cur = name;
  }

  // a new trip: somewhere else on this side, or across the street
  plan() {
    const { nav, r, ctx } = this;
    const here = nav.snap(this.x, this.z, 1.5);
    if (here < 0) return false;
    if (nav.crossings.length && r.chance(0.3)) {
      // crossings whose near kerb is on this side and not far
      const opts = [];
      for (const c of nav.crossings) {
        for (const [ka, kb, a, b] of [[c.ka, c.kb, c.a, c.b], [c.kb, c.ka, c.b, c.a]]) {
          if (nav.comp[ka] !== nav.comp[here]) continue;
          const d = Math.hypot(a[0] - this.x, a[1] - this.z);
          if (d < 3 || d > 30) continue;
          opts.push([{ ka, kb, a, b, len: c.len, dir: [(b[0] - a[0]) / c.len, (b[1] - a[1]) / c.len] }, c.w / (1 + d / 10)]);
        }
      }
      if (opts.length) {
        const cr = r.weighted(opts);
        const p1 = nav.path(here, cr.ka);
        if (p1) {
          this.trip = [{ kind: 'walk', pts: p1 }, { kind: 'kerb', cross: cr }, { kind: 'cross', pts: [cr.a, cr.b], cross: cr }];
          const after = this.destination(cr.kb, 6, 22);
          if (after) this.trip.push({ kind: 'walk', pts: after });
          return true;
        }
      }
    }
    const p = this.destination(here, 8, 35);
    if (!p) return false;
    this.trip = [{ kind: 'walk', pts: p }];
    return true;
  }

  // a path from cell `from` to a random point of the same sidewalk
  destination(from, dmin, dmax) {
    const { nav, r, ctx } = this;
    const [fx, fz] = nav.center(from);
    for (let tries = 0; tries < 8; tries++) {
      const a = r.float(0, Math.PI * 2), d = r.float(dmin, dmax);
      const x = fx + Math.cos(a) * d, z = fz + Math.sin(a) * d;
      // drift back toward the focus when far from it
      if (Math.hypot(x - ctx.focus[0], z - ctx.focus[1]) > RANGE) continue;
      const k = nav.snap(x, z, 2.5, 0.55);
      if (k < 0 || nav.comp[k] !== nav.comp[from]) continue;
      const p = nav.path(from, k);
      if (p && p.length > 1) return p;
    }
    return null;
  }

  startLeg() {
    const leg = this.trip[0];
    this.leg = leg;
    if (leg.kind === 'walk' || leg.kind === 'cross') {
      // from where the ped stands (the path starts at a cell centre)
      if (Math.hypot(leg.pts[0][0] - this.x, leg.pts[0][1] - this.z) > 0.05) leg.pts.unshift([this.x, this.z]);
      leg.cum = [0];
      for (let i = 1; i < leg.pts.length; i++) leg.cum.push(leg.cum[i - 1] + Math.hypot(leg.pts[i][0] - leg.pts[i - 1][0], leg.pts[i][1] - leg.pts[i - 1][1]));
      leg.s = 0;
      this.play('walk');
    } else if (leg.kind === 'kerb') {
      // turn to the street, look both ways, then wait for a gap
      this.play('look');
      this.timer = Math.min(this.lookClip.duration, 3.5) + this.r.float(0, 1);
      this.waited = 0;
      this.faceYaw = Math.atan2(-leg.cross.dir[0], -leg.cross.dir[1]);
    }
  }

  nextLeg() {
    this.trip.shift();
    if (this.trip.length) this.startLeg();
    else { this.leg = null; this.state = 'idle'; this.timer = this.r.chance(0.35) ? this.r.float(2, 9) : this.r.float(0, 0.6); this.play('idle'); }
  }

  // is the road clear for the time it takes to cross? (cars within reach and heading
  // for the crossing line)
  gap(cr, cars) {
    const need = cr.len / this.speed + 2.5;
    const mx = (cr.a[0] + cr.b[0]) / 2, mz = (cr.a[1] + cr.b[1]) / 2;
    for (const c of cars) {
      const rx = mx - c.x, rz = mz - c.z;
      if (rx * rx + rz * rz > 90 * 90) continue;
      // distance ahead of the car to the crossing, and how far off its line it passes
      const along = rx * c.dx + rz * c.dz;
      const lateral = Math.abs(rx * c.dz - rz * c.dx);
      const half = (c.len || 4.5) / 2;
      if (along < -half - 1 || lateral > cr.len / 2 + 2) continue;
      if (along < half + 2) return false;                       // on the crossing
      if ((along - half) / Math.max(0.5, c.speed) < need) return false;
    }
    return true;
  }

  update(dt, agents, cars) {
    const { nav } = this;
    this.pub.crossing = false;
    if (this.state === 'idle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.plan()) { this.state = 'trip'; this.startLeg(); }
        else this.timer = this.r.float(1, 3);
      }
    } else {
      const leg = this.leg;
      if (leg.kind === 'kerb') {
        this.turnTo(this.faceYaw, dt, 3);
        this.timer -= dt;
        this.waited += dt;
        if (this.timer <= 0) {
          if (this.gap(leg.cross, cars)) { this.pub.crossing = true; this.nextLeg(); }
          else {
            if (this.cur === 'look') this.play('idle');
            this.timer = 0.4;
            // gave up: walk on along this side instead
            if (this.waited > 25) { this.trip = []; this.leg = null; this.state = 'idle'; this.timer = 0; this.play('idle'); }
          }
        }
      } else {
        // walking: slow down behind someone, step aside to pass
        const v = this.speed * this.yieldFactor(agents, dt);
        leg.s += v * dt;
        const L = leg.cum[leg.cum.length - 1];
        if (leg.kind === 'cross') this.pub.crossing = true;
        if (leg.s >= L) { this.setOnPath(leg, L); this.nextLeg(); }
        else this.setOnPath(leg, leg.s, dt);
        this.actions.walk.timeScale = this.rate * v / this.speed;
      }
    }
    this.place(dt);
  }

  // position at arc length s of the leg, plus the passing offset
  setOnPath(leg, s, dt = 0) {
    const { pts, cum } = leg;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const seg = Math.max(1e-6, cum[i] - cum[i - 1]);
    const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
    const dx = (b[0] - a[0]) / seg, dz = (b[1] - a[1]) / seg;
    let x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    // ease the passing offset back to the path; only where it stays walkable
    if (leg.kind === 'walk' && this.side) {
      const ox = x - dz * this.side, oz = z + dx * this.side;
      if (this.nav.clear(ox, oz) >= 0.3) { x = ox; z = oz; } else this.side *= 0.8;
    }
    this.x = x; this.z = z;
    this.pub.dx = dx; this.pub.dz = dz;
    if (dt > 0) {
      // face a little ahead along the path (smoother through the rounded corners)
      const la = this.lookAhead(leg, s + 0.8);
      const hx = la[0] - this.x, hz = la[1] - this.z;
      if (hx * hx + hz * hz > 1e-4) this.turnTo(Math.atan2(-hx, -hz), dt, 5);
    }
  }

  lookAhead(leg, s) {
    const { pts, cum } = leg;
    if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  }

  // others close ahead: step to the right to pass (or slow down if there is no room)
  yieldFactor(agents, dt) {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let f = 1, side = 0;
    for (const o of agents) {
      if (o === this || !o.active) continue;
      const rx = o.x - this.x, rz = o.z - this.z;
      const d = Math.hypot(rx, rz);
      if (d > 2.4 || d < 1e-3) continue;
      const ahead = (rx * fx + rz * fz) / d;
      if (ahead < 0.5) continue;
      // someone ahead: pass on the right
      side = Math.max(side, 0.55 * (1 - d / 2.4) + 0.2);
      if (d < 0.9) f = Math.min(f, Math.max(0.15, (d - 0.5) / 0.4));
    }
    this.side += (side - this.side) * Math.min(1, dt * (side > this.side ? 2.5 : 0.8));
    return f;
  }

  turnTo(target, dt, rate) {
    let d = target - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const step = rate * dt;
    this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  place(dt) {
    const { ctx, nav } = this;
    // kerb height: asphalt on the carriageway, sidewalk elsewhere; stepping down
    // the kerb takes a moment instead of a jump
    const gy = nav.isRoad(this.x, this.z) ? ctx.roadSurf(this.x, this.z) : ctx.sidewalkY(this.x, this.z);
    this.y = dt > 0 ? this.y + (gy - this.y) * Math.min(1, dt * 10) : gy;
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.yaw;
    this.mixer.update(dt);
    this.pub.x = this.x; this.pub.z = this.z;
  }
}

// Shadows without the shadow map (it is redrawn about once a second, peds move):
//  - a soft contact shadow under each ped
//  - a long thin one away from the sun, only where the sun reaches the ground
//    (the fragment reads the street's shadow map), as dark as the sun's share of
//    the light. Two instanced meshes: two draw calls for all peds.
class PedShadows {
  constructor(group, n) {
    const tex = blobTexture();
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.contactMat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.sunMat = sunShadowMaterial(tex);
    this.contact = new THREE.InstancedMesh(geo, this.contactMat, n);
    this.sun = new THREE.InstancedMesh(geo.clone().translate(0, 0, -0.5), this.sunMat, n);
    for (const m of [this.contact, this.sun]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.renderOrder = 2;
      m.userData.decal = true;
      m.count = 0;
      group.add(m);
    }
    this.sun.receiveShadow = true;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
  }
  update(agents, env) {
    const sun = env?.sun;
    let dir = null, len = 0, strength = 0;
    if (sun && sun.intensity > 0 && sun.castShadow) {
      dir = new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
      const el = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      if (el > 0.03) {
        len = Math.min(6, 1.7 / Math.tan(el));
        // direct sun vs sky light on the ground (klux)
        const e = sun.intensity * Math.sin(el);
        strength = 0.75 * e / (e + 18);
      }
    }
    this.sunMat.uniforms.uStrength.value = strength;
    let k = 0;
    for (const a of agents) {
      if (!a.root.visible) continue;
      this.p.set(a.x, a.y + 0.02, a.z);
      this.q.setFromAxisAngle(this.up, a.yaw);
      this.s.set(0.75, 1, 0.6);
      this.contact.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
      if (len > 0.05) {
        // away from the sun, from the feet
        this.q.setFromAxisAngle(this.up, Math.atan2(dir.x, dir.z));
        this.s.set(0.5, 1, len);
        this.sun.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
      }
      k++;
    }
    this.contact.count = k;
    this.sun.count = len > 0.05 ? k : 0;
    this.contact.instanceMatrix.needsUpdate = true;
    this.sun.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.contact.geometry.dispose(); this.sun.geometry.dispose();
    this.contactMat.alphaMap.dispose(); this.contactMat.dispose(); this.sunMat.dispose();
  }
}

// radial falloff in the alpha channel
function blobTexture() {
  const N = 64, d = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
    const r = Math.min(1, Math.hypot(x, y));
    const a = Math.pow(1 - r * r, 1.6);
    const k = (j * N + i) * 4;
    d[k] = d[k + 1] = d[k + 2] = Math.round(a * 255); d[k + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// black, alpha = blob * strength * (1 - street shadow): a Lambert material keeps
// three's shadow-map lookup; the sun's visibility at the fragment is read off the
// directional light after shadowing
function sunShadowMaterial(tex) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaMap: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.uniforms = { uStrength: { value: 0 } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uStrength = m.uniforms.uStrength;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uStrength;')
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
  float sunVis = 1.0;
  #if NUM_DIR_LIGHTS > 0
    sunVis = clamp(length(directLight.color) / max(length(directionalLights[ NUM_DIR_LIGHTS - 1 ].color), 1e-6), 0.0, 1.0);
  #endif`)
      .replace('#include <opaque_fragment>', 'gl_FragColor = vec4(0.0, 0.0, 0.0, diffuseColor.a * uStrength * sunVis);');
  };
  m.customProgramCacheKey = () => 'ped-sun-shadow';
  return m;
}
