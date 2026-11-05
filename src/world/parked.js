// Vehicles parked along the curb near the camera, drawn from the whole pack
// (src/vehicles/manifest.json): mostly cars, some vans and pickups, a few
// motorcycles, the odd truck, bus or service vehicle. Cars face the direction of
// traffic for their side; motorcycles stand angled against the curb on their
// side stand. Every vehicle keeps clear of driveways, intersections and the others.
import * as THREE from 'three';
import { pointAt, distPointLine } from '../core/geom.js';
import MANIFEST from '../vehicles/manifest.json';
import { RiderFactory } from '../peds/rider.js';

// relative frequency of each kind on a residential street (per model)
// (10 motorcycle models against ~80 cars: at 1.5 each they are ~15% of the parked
// vehicles; the police bike stays rare)
const KIND_WEIGHT = { car: 1, van: 0.6, moto: 1.5, truck: 0.08, bus: 0.05, emergency: 0.06, bicycle: 0.25 };
const MODEL_WEIGHT = { copbike: 0.05 };
// someone sitting on a parked motorcycle (waiting, a delivery stop), a foot on the
// ground; the dataset generator (gen=1) wants most motorcycles ridden
const GEN = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gen') === '1';
const RIDER_PARKED = GEN ? 0.65 : 0.2;
// GTA trucks are oversized: skip what would not fit a Brazilian street
// (and with wheels to show: a few mods rely on a wheel file the pack lacks)
const fits = (v) => v.size?.[0] > 0 && v.size[0] < 3.1 && v.size[1] < 12.5 && (v.wheelMesh || v.bikeWheels);
// sports and luxury slots of the game: rare on a residential street
const RARE = new Set('alpha banshee bullet cheetah comet elegy euros flash hotknife infernus jester phoenix stretch stratum sultan supergt turismo uranus zr350'.split(' '));
export const PARKABLE = MANIFEST.filter(v => KIND_WEIGHT[v.kind] && fits(v));
const weightOf = (v) => KIND_WEIGHT[v.kind] * (RARE.has(v.name) ? 0.25 : 1) * (MODEL_WEIGHT[v.name] ?? 1);

export async function buildParkedCars(ctx, vlib, { count = [4, 9] } = {}) {
  const { layout, rng, group, focus } = ctx;
  const r = rng.fork('parked');
  const roads = layout.roads.filter(rd => rd.cls !== 'service' && rd.w >= 5.5);
  // arc length of the point of each road closest to the camera's focus: spots are
  // drawn around it (stitched roads run for a kilometre)
  const arcAt = (pts, seg, t) => { let s = 0; for (let i = 0; i < seg; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s + t * Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]); };
  const nearRoads = roads.map(rd => { const p = distPointLine(focus[0], focus[1], rd.pts); return { rd, d: p.d, s0: arcAt(rd.pts, p.seg, p.t) }; }).filter(n => n.d < 50);
  // driveways: nothing blocks a gate
  const gates = [];
  for (const lot of layout.lots) for (const g of lot.driveways || []) gates.push([lot.a[0] + lot.t[0] * g.s, lot.a[1] + lot.t[1] * g.s, g.w / 2 + 0.6]);
  const pool = PARKABLE.map(v => [v, weightOf(v)]);
  const placed = [];   // { x, z, rad }
  const cars = [];
  let riders = null;
  const want = r.int(count[0], count[1]);
  for (let n = 0; n < want * 3 && cars.length < want && nearRoads.length; n++) {
    const v = r.weighted(pool);
    const two = v.kind === 'moto' || v.kind === 'bicycle';
    const [w, len] = v.size;
    // find a spot for this vehicle's footprint
    let spot = null;
    for (let tries = 0; tries < 25 && !spot; tries++) {
      const { rd, s0 } = r.pick(nearRoads);
      const s = Math.max(len, Math.min(rd.len - len, s0 + r.float(-45, 45)));
      const q = pointAt(rd.pts, s);
      const side = r.chance(0.5) ? 1 : -1;
      // right-hand normal of travel (x east, z south)
      const nx = -q.dz * side, nz = q.dx * side;
      // cars along the curb; two-wheelers across it, back wheel near the kerb
      const reach = two ? len / 2 + 0.25 : w / 2 + 0.2;
      const off = rd.w / 2 - reach;
      const x = q.x + nx * off, z = q.z + nz * off;
      const rad = two ? Math.max(w, 0.9) : len / 2;
      if (Math.hypot(x - focus[0], z - focus[1]) > 55) continue;
      if (gates.some(([gx, gz, gw]) => Math.hypot(x - gx, z - gz) < gw + rad)) continue;
      if (roads.some(o => o !== rd && distPointLine(x, z, o.pts).d < o.w / 2 + 6)) continue;
      if (placed.some(p => Math.hypot(p.x - x, p.z - z) < p.rad + rad + r.float(0.5, 1.6))) continue;
      // traffic keeps to the right: on side +1 a car faces along the road
      const dx = q.dx * side, dz = q.dz * side;
      const yaw = two
        ? Math.atan2(nx, nz) + (r.chance(0.5) ? 1 : -1) * r.float(0, 0.6)   // nose to the street
        : Math.atan2(-dx, -dz) + r.gauss(0, 0.02);
      spot = { x, z, yaw, rad };
    }
    if (!spot) continue;
    let car;
    try {
      car = await vlib.create(v.name, r.fork('car' + cars.length), { moto: v.kind === 'moto', plate: v.kind !== 'bicycle' });
    } catch (e) { console.warn('[sim] veículo', v.name, e.message); continue; }
    car.userData.model = v.name;
    car.userData.kind = v.kind;
    car.position.set(spot.x, ctx.roadSurf(spot.x, spot.z), spot.z);
    car.rotation.set(0, spot.yaw, 0, 'YXZ');
    if (two) {
      let held = false;
      if (v.kind === 'moto' && r.chance(RIDER_PARKED)) {
        if (!riders) riders = new RiderFactory(ctx.lib).init().catch(e => { console.warn('[sim] pilotos', e.message); return null; });
        const rf = await riders;
        try { held = !!(await rf?.mount(car, v.name, r.fork('rider' + cars.length)))?.length; } catch (e) { console.warn('[sim] piloto', v.name, e.message); }
        for (const rd of car.userData.riders || []) rd.userData.setMoving?.(false);
      }
      // on the side stand it leans a little to its left; held up by its rider, barely
      car.rotation.z = held ? r.float(0.02, 0.07) : r.float(0.12, 0.22);
      car.position.y += 0.02;
    } else seatOnWheels(car, ctx.roadSurf);
    group.add(car);
    placed.push(spot);
    cars.push(car);
  }
  console.log('[sim] parked', cars.map(c => c.userData.model + ':' + c.userData.kind).join(' '));
  return cars;
}

// rest the car on its four tyres: height from their mean ground level, pitch from
// front vs rear, roll from left vs right (streets have camber and slope)
function seatOnWheels(car, groundY) {
  car.updateMatrixWorld(true);
  const w = {};
  car.traverse(o => { const m = o.name.match(/^wheel_([lr])([fb])_dummy$/); if (m) w[m[1] + m[2]] = o.getWorldPosition(o.position.clone()); });
  if (!w.lf || !w.rf || !w.lb || !w.rb) return;
  const g = (p) => groundY(p.x, p.z);
  const lf = g(w.lf), rf = g(w.rf), lb = g(w.lb), rb = g(w.rb);
  const base = car.position.y;
  const wheelbase = Math.hypot(w.lf.x - w.lb.x, w.lf.z - w.lb.z) || 2.5;
  const track = Math.hypot(w.lf.x - w.rf.x, w.lf.z - w.rf.z) || 1.5;
  const pitch = Math.atan2((lf + rf) / 2 - (lb + rb) / 2, wheelbase);
  const roll = Math.atan2((rf + rb) / 2 - (lf + lb) / 2, track);
  car.position.y = (lf + rf + lb + rb) / 4 + (car.position.y - base);
  car.rotation.x = pitch;
  car.rotation.z = roll;
}
