// Street traffic around the camera.
//
// Lanes: every road gets one lane per direction of travel (one for one-way
// streets), drawn to the right of the centre line. Each lane carries a lateral
// offset profile sampled every metre: where cars are parked on its side the lane
// moves toward the centre to pass them, and where that would put a car over the
// centre line the stretch is "narrow" (one car at a time, the one coming the
// other way waits).
// Junctions: crossings of road centre lines and road ends meeting another road;
// a car approaching one may turn onto the other road along a smooth curve, and
// gives way to whoever reaches the junction first.
// Driving: intelligent driver model (keeps distance to the vehicle ahead, stops
// for stop points and for people crossing in front).
// Vehicles appear and disappear out of sight, 60-140 m from the camera's focus.
import * as THREE from 'three';
import { pointAt, distPointLine } from '../core/geom.js';
import MANIFEST from '../vehicles/manifest.json';
import { setVehicleLights } from '../vehicles/vehicle.js';
import { RiderFactory } from '../peds/rider.js';

// per model; 10 motorcycle models against ~80 cars: at 2.4 each they are ~22% of
// the traffic, as on Brazilian streets (the police bike stays rare: MODEL_WEIGHT)
const KIND_WEIGHT = { car: 1, van: 0.5, moto: 2.4, truck: 0.08, bus: 0.06, emergency: 0.04 };
const MODEL_WEIGHT = { copbike: 0.08 };
const RARE = new Set('alpha banshee bullet cheetah comet elegy euros flash hotknife infernus jester phoenix stretch stratum sultan supergt turismo uranus zr350'.split(' '));
// (and with wheels to show: a few mods rely on a wheel file the pack lacks)
const fits = (v) => v.size?.[0] > 0 && v.size[0] < 3.1 && v.size[1] < 12.5 && (v.wheelMesh || v.bikeWheels);
const POOL = MANIFEST.filter(v => KIND_WEIGHT[v.kind] && fits(v)).map(v => [v, KIND_WEIGHT[v.kind] * (RARE.has(v.name) ? 0.25 : 1) * (MODEL_WEIGHT[v.name] ?? 1)]);

const SPAWN_MIN = 60, SPAWN_MAX = 115, DESPAWN = 140;

export async function buildTraffic(ctx, vlib) {
  const { layout, focus } = ctx;
  const r = ctx.rng.fork('traffic');
  ctx.trafficCars = [];
  const roads = layout.roads.filter(rd => rd.w >= 4.5 && rd.cls !== 'service' && rd.len > 20);
  if (!roads.length) return null;

  // ---------------------------------------------------------------- lanes
  const lanes = [];
  for (const rd of roads) {
    rd.lanes = [];
    const dirs = rd.oneway ? [1] : [1, -1];
    for (const dir of dirs) {
      const lane = { road: rd, dir, len: rd.len, base: rd.oneway ? 0 : rd.w / 4, junctions: [], opposite: null };
      lanes.push(lane);
      rd.lanes.push(lane);
    }
    if (rd.lanes.length === 2) { rd.lanes[0].opposite = rd.lanes[1]; rd.lanes[1].opposite = rd.lanes[0]; }
  }
  // geometry along a lane (u = distance travelled along it)
  const centerAt = (lane, u) => {
    const s = lane.dir > 0 ? u : lane.len - u;
    const q = pointAt(lane.road.pts, Math.max(0, Math.min(lane.len, s)));
    return { x: q.x, z: q.z, tx: q.dx * lane.dir, tz: q.dz * lane.dir };
  };
  const offsetAt = (lane, u) => {
    const o = lane.off;
    const i = Math.max(0, Math.min(o.length - 1, u));
    const i0 = Math.floor(i), f = i - i0;
    return o[i0] * (1 - f) + o[Math.min(o.length - 1, i0 + 1)] * f;
  };
  const laneAt = (lane, u) => {
    const c = centerAt(lane, u);
    const off = offsetAt(lane, u);
    // right of travel (x east, z south)
    return { x: c.x - c.tz * off, z: c.z + c.tx * off, tx: c.tx, tz: c.tz };
  };

  // lateral room left by parked cars, per lane
  const parked = (ctx.parked || []).map(c => {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    return { x: c.position.x, z: c.position.z, fx: fwd.x, fz: fwd.z, w: c.userData.size.x, l: c.userData.size.z };
  });
  for (const lane of lanes) {
    const n = Math.ceil(lane.len) + 1;
    const off = new Float32Array(n).fill(lane.base);
    const half = lane.road.w / 2;
    for (const p of parked) {
      // project the parked car on the road: along (u) and across (signed, + = right of this lane's travel)
      const pr = distPointLine(p.x, p.z, lane.road.pts);
      if (pr.d > half + 1) continue;
      let s = 0;
      for (let i = 0; i < pr.seg; i++) s += Math.hypot(lane.road.pts[i + 1][0] - lane.road.pts[i][0], lane.road.pts[i + 1][1] - lane.road.pts[i][1]);
      s += pr.t * Math.hypot(lane.road.pts[pr.seg + 1][0] - lane.road.pts[pr.seg][0], lane.road.pts[pr.seg + 1][1] - lane.road.pts[pr.seg][1]);
      const u = lane.dir > 0 ? s : lane.len - s;
      const c = centerAt(lane, u);
      const across = -(p.x - c.x) * c.tz + (p.z - c.z) * c.tx;
      if (across <= 0) continue;   // on the other side: the other lane's business
      // inner edge of the parked vehicle, minus half a car and a margin
      const halfW = Math.abs(p.fx * c.tz - p.fz * c.tx) * p.l / 2 + Math.abs(p.fx * c.tx + p.fz * c.tz) * p.w / 2;
      const room = across - halfW - 0.95 - 0.35;
      const reach = p.l / 2 + 7;
      for (let k = Math.max(0, Math.floor(u - reach)); k <= Math.min(n - 1, Math.ceil(u + reach)); k++) {
        // full shift beside the car, eased in and out over 6 m
        const d = Math.max(0, Math.abs(k - u) - p.l / 2 - 1);
        const ease = d >= 6 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d / 6);
        off[k] = Math.min(off[k], lane.base + (Math.min(room, lane.base) - lane.base) * ease);
      }
    }
    lane.off = off;
  }
  // narrow stretches, shared by both directions of a road: where the two lanes,
  // each moved over to pass its parked cars, no longer fit side by side
  for (const rd of roads) {
    for (const l of rd.lanes) l.narrow = [];
    if (rd.lanes.length < 2) continue;
    const [A, B] = rd.lanes[0].dir > 0 ? rd.lanes : [rd.lanes[1], rd.lanes[0]];
    const n = A.off.length;
    let start = -1;
    for (let k = 0; k < n; k++) {
      // two cars pass each other slowly with ~2.1 m between their centre lines
      const isN = A.off[k] + B.off[Math.max(0, Math.min(n - 1, Math.round(rd.len) - k))] < 2.1;
      if (isN && start < 0) start = Math.max(0, k - 3);
      if ((!isN || k === n - 1) && start >= 0) {
        const end = Math.min(n - 1, k + 3);
        // stretches less than a car length apart are one stretch
        const last = A.narrow[A.narrow.length - 1];
        if (last && start - last[1] < 12) last[1] = end; else A.narrow.push([start, end]);
        start = -1;
      }
    }
    B.narrow = A.narrow.map(([a, b]) => [rd.len - b, rd.len - a]).reverse();
  }

  // ---------------------------------------------------------------- junctions
  const segX = (a, b, c, d) => {
    const r1x = b[0] - a[0], r1z = b[1] - a[1], r2x = d[0] - c[0], r2z = d[1] - c[1];
    const den = r1x * r2z - r1z * r2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * r2z - (c[1] - a[1]) * r2x) / den, u = ((c[0] - a[0]) * r1z - (c[1] - a[1]) * r1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  };
  const arcOf = (pts) => { const a = [0]; for (let i = 1; i < pts.length; i++) a.push(a[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return a; };
  for (const rd of roads) rd.arc = arcOf(rd.pts);
  const junctions = [];
  const CLS = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, street: 1 };
  const rank = (rd) => (CLS[rd.cls] || 0) * 100 + rd.w * 2 + Math.min(rd.len, 2000) / 1000;
  const addJ = (r1, s1, r2, s2) => {
    const q = pointAt(r1.pts, s1);
    if (junctions.some(j => Math.hypot(j.x - q.x, j.z - q.z) < 4)) {
      const j = junctions.find(j => Math.hypot(j.x - q.x, j.z - q.z) < 4);
      if (!j.at.some(a => a.road === r1)) j.at.push({ road: r1, s: s1 });
      if (!j.at.some(a => a.road === r2)) j.at.push({ road: r2, s: s2 });
      return;
    }
    junctions.push({ x: q.x, z: q.z, at: [{ road: r1, s: s1 }, { road: r2, s: s2 }], r: Math.max(r1.w, r2.w) / 2 + 2.5, main: rank(r1) >= rank(r2) ? r1 : r2 });
  };
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = roads[i], B = roads[j];
    for (let a = 0; a < A.pts.length - 1; a++) for (let b = 0; b < B.pts.length - 1; b++) {
      const t = segX(A.pts[a], A.pts[a + 1], B.pts[b], B.pts[b + 1]);
      if (t === null) continue;
      const x = A.pts[a][0] + (A.pts[a + 1][0] - A.pts[a][0]) * t, z = A.pts[a][1] + (A.pts[a + 1][1] - A.pts[a][1]) * t;
      const pb = distPointLine(x, z, B.pts);
      addJ(A, A.arc[a] + t * (A.arc[a + 1] - A.arc[a]), B, B.arc[pb.seg] + pb.t * (B.arc[pb.seg + 1] - B.arc[pb.seg]));
    }
    // a road ending on (or near) the other one: T junction
    for (const [P, Q] of [[A, B], [B, A]]) for (const [end, sEnd] of [[P.pts[0], 0], [P.pts[P.pts.length - 1], P.len]]) {
      const pq = distPointLine(end[0], end[1], Q.pts);
      if (pq.d < Q.w / 2 + 3) addJ(P, sEnd, Q, Q.arc[pq.seg] + pq.t * (Q.arc[pq.seg + 1] - Q.arc[pq.seg]));
    }
  }
  // per lane, junctions in travel order (u)
  for (const lane of lanes) {
    for (const j of junctions) {
      const a = j.at.find(a => a.road === lane.road);
      if (!a) continue;
      lane.junctions.push({ j, u: lane.dir > 0 ? a.s : lane.len - a.s });
    }
    lane.junctions.sort((a, b) => a.u - b.u);
  }

  // ---------------------------------------------------------------- vehicles
  const nCars = r.int(5, 10);
  const cars = [];
  // people on the motorcycles (src/peds/rider.js)
  let riders = null;
  const ridersFor = async () => {
    if (!riders) riders = new RiderFactory(ctx.lib).init().catch(e => { console.warn('[sim] pilotos', e.message); return null; });
    return riders;
  };
  for (let i = 0; i < nCars; i++) {
    const v = r.weighted(POOL);
    let obj;
    try { obj = await vlib.create(v.name, r.fork('t' + i), { moto: v.kind === 'moto', dynamic: true }); } catch (e) { continue; }
    obj.traverse(o => { if (o.isMesh) o.castShadow = false; });   // shadow maps are static; the contact shadow moves with it
    if (v.kind === 'moto') {
      const rf = await ridersFor();
      try { await rf?.mount(obj, v.name, r.fork('rider' + i)); } catch (e) { console.warn('[sim] piloto', v.name, e.message); }
    }
    obj.visible = false;
    ctx.group.add(obj);
    const size = obj.userData.size;
    cars.push({
      id: cars.length, obj, kind: v.kind, len: size.z, wid: size.x,
      lane: null, u: 0, v: 0, v0: 0, curve: null, plan: null, active: false, stopFor: null, wait: 0,
      x: 0, z: 0, tx: 0, tz: 1, wheelTurn: 0,
    });
  }
  const drv = r.fork('drivers');

  // lanes that pass in front of the camera: most vehicles start on one of them,
  // upstream, so they drive through the picture
  for (const lane of lanes) {
    let best = 1e9, bu = 0;
    for (let u = 0; u < lane.len; u += 2) { const p = laneAt(lane, u); const d = Math.hypot(p.x - focus[0], p.z - focus[1]); if (d < best) { best = d; bu = u; } }
    lane.focusD = best; lane.focusU = bu;
  }
  const seen = lanes.filter(l => l.focusD < 35);
  const spawn = (car, first = false) => {
    for (let tries = 0; tries < 40; tries++) {
      const viaCam = seen.length && drv.chance(0.8);
      const lane = viaCam ? drv.pick(seen) : drv.pick(lanes);
      const u = first ? drv.float(5, Math.max(6, lane.len - 25))
        : viaCam ? lane.focusU - drv.float(SPAWN_MIN, SPAWN_MAX) : drv.float(10, Math.max(11, lane.len - 25));
      if (u < 3 || u > lane.len - 25) continue;
      const p = laneAt(lane, u);
      const d = Math.hypot(p.x - focus[0], p.z - focus[1]);
      if (d > SPAWN_MAX + 10 || (!first && d < SPAWN_MIN)) continue;
      if (cars.some(c => c.active && Math.hypot(c.x - p.x, c.z - p.z) < 15)) continue;
      if (lane.narrow.some(([a, b]) => u > a - 5 && u < b + 5)) continue;
      Object.assign(car, { lane, u, curve: null, plan: null, active: true, stopFor: null, wait: 0 });
      car.v0 = (car.kind === 'truck' || car.kind === 'bus' ? 7.5 : 9) * drv.float(0.8, 1.25);   // ~30-40 km/h
      car.v = car.v0 * 0.8;
      place(car, 0);
      car.obj.visible = true;
      return true;
    }
    return false;
  };

  // pose from the lane (or from the turn curve)
  const place = (car, ds) => {
    let p;
    if (car.curve) {
      const c = car.curve;
      const t = Math.min(1, c.d / c.length);
      const P = bez(c.p, t), T = bezT(c.p, t);
      const l = Math.hypot(T[0], T[1]) || 1;
      p = { x: P[0], z: P[1], tx: T[0] / l, tz: T[1] / l };
    } else p = laneAt(car.lane, car.u);
    car.x = p.x; car.z = p.z; car.tx = p.tx; car.tz = p.tz;
    const o = car.obj;
    const h = car.len * 0.4;
    const yf = ctx.roadSurf(p.x + p.tx * h, p.z + p.tz * h), yb = ctx.roadSurf(p.x - p.tx * h, p.z - p.tz * h);
    o.position.set(p.x, (yf + yb) / 2, p.z);
    o.rotation.set(Math.atan2(yf - yb, 2 * h), Math.atan2(-p.tx, -p.tz), 0, 'YXZ');
    for (const w of o.userData.wheels) w.mesh.rotation.x -= ds / w.radius;
  };

  // build the turn curve from the current lane to another lane at a junction
  const planTurn = (car, jn) => {
    const opts = [];
    for (const a of jn.j.at) {
      if (a.road === car.lane.road) continue;
      for (const tl of a.road.lanes) {
        const u2 = tl.dir > 0 ? a.s : tl.len - a.s;
        if (tl.len - u2 < 30) continue;   // would end right away
        opts.push({ lane: tl, u: u2 });
      }
    }
    // going straight is also an option when the road goes on
    const straight = car.lane.len - jn.u > 30;
    if (!opts.length || (straight && !drv.chance(0.35))) return null;
    const o = drv.pick(opts);
    const rr = jn.j.r;
    const a0 = Math.max(0, jn.u - rr), u1 = o.u + rr;
    const A = laneAt(car.lane, a0), B = laneAt(o.lane, u1);
    const k = rr * 0.9;
    const p = [[A.x, A.z], [A.x + A.tx * k, A.z + A.tz * k], [B.x - B.tx * k, B.z - B.tz * k], [B.x, B.z]];
    let length = 0, prev = p[0];
    for (let i = 1; i <= 16; i++) { const q = bez(p, i / 16); length += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
    return { startU: a0, p, length, d: 0, next: o.lane, nextU: u1 };
  };

  // ---------------------------------------------------------------- update
  const IDM = { a: 1.4, b: 2.5, s0: 2.2, T: 1.3 };
  const update = (dt, t, env) => {
    dt = Math.min(dt, 0.1);
    const night = (env?.state?.nightF || 0) > 0.45;
    // keep the pool alive
    for (const car of cars) {
      if (!car.active) { if (drv.chance(0.02)) spawn(car); continue; }
      if (Math.hypot(car.x - focus[0], car.z - focus[1]) > DESPAWN) { car.active = false; car.obj.visible = false; }
    }
    const act = cars.filter(c => c.active);
    for (const car of act) {
      if (car.lights !== night) { setVehicleLights(car.obj, night); car.lights = night; }
      // nearest obstacle ahead (gap in metres, its speed)
      let gap = 1e9, vLead = 0;
      car.why = '';
      const ahead = (x, z, w, len, v, why) => {
        const dx = x - car.x, dz = z - car.z;
        const along = dx * car.tx + dz * car.tz;
        if (along <= 0 || along > 60) return;
        const lat = Math.abs(-dx * car.tz + dz * car.tx);
        if (lat > car.wid / 2 + w / 2 + 0.25) return;
        const g = along - car.len / 2 - len / 2;
        if (g < gap) { gap = g; vLead = v; car.why = why; }
      };
      for (const o of act) {
        if (o === car) continue;
        const dot = o.tx * car.tx + o.tz * car.tz;
        // oncoming traffic in its own lane passes by: only a vehicle squarely in
        // this car's path counts (narrow stretches are arbitrated separately)
        if (dot < -0.5 && Math.abs(-(o.x - car.x) * car.tz + (o.z - car.z) * car.tx) > 1.0) continue;
        ahead(o.x, o.z, o.wid, o.len, Math.max(0, o.v * dot), 'car');
      }
      for (const p of ctx.pedAgents || []) ahead(p.x, p.z, 0.8, 0.6, 0, 'ped');
      // stop points: junctions (give way to whoever is closer) and narrow stretches
      if (!car.curve) {
        const lane = car.lane;
        for (const jn of lane.junctions) {
          const d = jn.u - car.u;
          if (d < 0 || d > 30) continue;
          // priority road: going straight along the main road never stops here;
          // from a side road, or when turning, wait for the junction to clear and for
          // main-road traffic (a turn off the main road waits for oncoming traffic)
          const turning = car.plan?.jn === jn && !!car.plan.turn;
          const onMain = lane.road === jn.j.main;
          if (onMain && !turning) break;
          const myDist = Math.hypot(jn.j.x - car.x, jn.j.z - car.z);
          const busy = act.some(o => {
            if (o === car) return false;
            if (o.curve) return o.curve.via === jn.j;
            const od = Math.hypot(jn.j.x - o.x, jn.j.z - o.z);
            const toward = (jn.j.x - o.x) * o.tx + (jn.j.z - o.z) * o.tz > 0;
            if (o.lane === lane) return false;                      // the queue is handled by the gap
            if (od < jn.j.r && toward) return true;                  // inside, still crossing
            if (!toward || od > jn.j.r + 30 || (o.v < 0.3 && od > jn.j.r + 3)) return false;
            if (o.lane.road === jn.j.main) return onMain ? o.lane === lane.opposite : true;
            // two side-road cars: the nearer one first
            return !onMain && (od < myDist - 0.5 || (Math.abs(od - myDist) <= 0.5 && o.id < car.id));
          });
          if (busy) { const g = d - jn.j.r - car.len / 2; if (g < gap) { gap = Math.max(0, g); vLead = 0; car.why = 'junction'; } }
          break;
        }
        for (const [a, b] of lane.narrow) {
          const d = a - car.u;
          if (d < 0 || d > 25 || !lane.opposite) continue;
          // someone coming the other way inside (or about to enter) the stretch
          const opp = lane.opposite;
          const oa = lane.len - b, ob = lane.len - a;
          // the one already inside, or the nearer one, goes first (ties: lane +1);
          // two cars that ended up waiting for each other: the lower id goes
          const coming = act.some(o => {
            if (o.lane !== opp || o.curve || o.u > ob) return false;
            if (o.u >= oa) return true;
            const od = oa - o.u;
            if (od > 25) return false;
            if (car.v < 0.2 && o.v < 0.2 && car.wait > 3 && o.wait > 3) return o.id < car.id;
            return od < d - 0.5 || (Math.abs(od - d) <= 0.5 && opp.dir > 0);
          });
          if (coming) { const g = d - car.len / 2 - 1; if (g < gap) { gap = Math.max(0, g); vLead = 0; car.why = 'narrow'; } }
          break;
        }
        // end of the road with nowhere to turn: slow down and leave
        const left = lane.len - car.u;
        if (left < 25 && !car.plan) { const g = left - car.len / 2; if (g < gap) { gap = Math.max(0.1, g); vLead = 0; car.why = 'end'; } }
      }
      // intelligent driver model
      const dv = car.v - vLead;
      const sStar = IDM.s0 + Math.max(0, car.v * IDM.T + car.v * dv / (2 * Math.sqrt(IDM.a * IDM.b)));
      let acc = IDM.a * (1 - Math.pow(car.v / car.v0, 4) - (gap < 1e8 ? Math.pow(sStar / Math.max(gap, 0.1), 2) : 0));
      // slower through turns
      if (car.curve) acc = Math.min(acc, (5.5 - car.v) * 2);
      car.v = Math.max(0, car.v + Math.max(-7, acc) * dt);
      car.wait = car.v < 0.2 ? car.wait + dt : 0;
      // riders put a foot down once the bike has stopped
      for (const rd of car.obj.userData.riders || []) rd.userData.setMoving?.(car.wait < 0.4);
      let ds = car.v * dt;
      if (car.curve) {
        car.curve.d += ds;
        if (car.curve.d >= car.curve.length) { car.lane = car.curve.next; car.u = car.curve.nextU + (car.curve.d - car.curve.length); car.curve = null; car.plan = null; }
      } else {
        car.u += ds;
        // decide what to do at the next junction, once
        const jn = car.lane.junctions.find(j => j.u - car.u > 0 && j.u - car.u < 35);
        if (jn && car.plan?.jn !== jn) car.plan = { jn, turn: planTurn(car, jn) };
        if (car.plan?.turn && car.u >= car.plan.turn.startU) { car.curve = car.plan.turn; car.curve.via = car.plan.jn.j; car.curve.d = car.u - car.curve.startU; }
        if (car.u > car.lane.len - 2) { car.active = false; car.obj.visible = false; continue; }
      }
      place(car, ds);
    }
    // publish for pedestrians and anything else that needs to know
    ctx.trafficCars = act.filter(c => c.active).map(c => ({ x: c.x, z: c.z, dx: c.tx, dz: c.tz, speed: c.v, len: c.len }));
  };

  // start with the road already in motion
  for (const car of cars) if (drv.chance(0.7)) spawn(car, true);
  console.log('[sim] traffic', lanes.length, 'lanes', junctions.length, 'junctions', cars.length, 'vehicles');
  return {
    update, cars, lanes, junctions,
    dispose() { for (const c of cars) c.obj.removeFromParent(); },
  };
}

function bez(p, t) {
  const u = 1 - t;
  return [0, 1].map(k => u * u * u * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t * t * t * p[3][k]);
}
function bezT(p, t) {
  const u = 1 - t;
  return [0, 1].map(k => 3 * u * u * (p[1][k] - p[0][k]) + 6 * u * t * (p[2][k] - p[1][k]) + 3 * t * t * (p[3][k] - p[2][k]));
}
