// Catalogue of the vehicle pack: node tools/vehicles-manifest.mjs
// Parses every .dff/.txd once and writes src/vehicles/manifest.json with each
// model's kind (from its GTA SA slot), size, wheel layout, plate quads and
// textures it cannot find, so the game picks parked vehicles without parsing all.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { parseDFF, parseTXD } from '../src/vehicles/rw.js';

const DIR = 'assets/Pack 184 vehicles Extras - GTA Brasil v4/';
const generic = parseTXD(readFileSync(DIR + '_CFG/generic/vehicle.txd'));

// GTA SA slot -> what it is (the pack swaps the models but keeps the slots)
const KIND = {
  plane: 'andromed at400 beagle cropdust dodo hydra nevada rustler shamal skimmer stunt rcbaron',
  heli: 'cargobob hunter leviathn maverick polmav raindanc seaspar sparrow vcnmav rcgoblin rcraider',
  boat: 'coastg dinghy jetmax launch marquis predator reefer speeder squalo tropic vortex',
  train: 'freight freiflat streak streakc tram freibox freiform',
  trailer: 'artict1 artict2 artict3 petrotr bagboxa bagboxb tugstair farmtr1 utiltr1',
  odd: 'rcbandit rccam rctiger kart mower combine dozer dumper forklift baggage tug caddy monster monstera monsterb hotring hotrina hotrinb bloodra bandito dune duneride rhino quad sweeper tractor',
  moto: 'bf400 faggio fcr900 freeway nrg500 pcj600 pizzaboy sanchez wayfarer copbike',
  bicycle: 'bike bmx mtbike',
  bus: 'bus coach',
  truck: 'linerun petro rdtrain roadtrain packer cement flatbed dft30 mule yankee benson barracks firetruk firela trash securica boxville boxburg',
  van: 'burrito pony rumpo moonbeam topfun newsvan berkley camper journey walton bobcat sadler sadlshit yosemite picador',
  emergency: 'ambulan copcarla copcarsf copcarvg copcarru enforcer fbiranch fbitruck swatvan',
};
const kindOf = (n) => Object.entries(KIND).find(([, v]) => v.split(' ').includes(n))?.[0] || 'car';

const out = [];
for (const f of readdirSync(DIR + 'VEHICLES').filter(f => f.endsWith('.dff'))) {
  const name = f.slice(0, -4);
  try {
    const d = parseDFF(readFileSync(DIR + 'VEHICLES/' + f));
    const txdPath = DIR + 'VEHICLES/' + name + '.txd';
    const txd = existsSync(txdPath) ? parseTXD(readFileSync(txdPath)) : new Map();
    const frames = d.frames.map(fr => fr.name);
    // extent of the intact geometry, in the model's own space
    const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    const world = (i) => { // frame position in model space (translation chain only)
      const p = [0, 0, 0];
      for (let j = i; j >= 0; j = d.frames[j].parent) for (let k = 0; k < 3; k++) p[k] += d.frames[j].pos[k];
      return p;
    };
    const missing = new Set();
    let plates = 0;
    for (const a of d.atomics) {
      const fn = d.frames[a.frame].name.toLowerCase();
      if (fn.endsWith('_dam') || fn.includes('_vlo')) continue;
      const g = d.geometries[a.geometry];
      const o = world(a.frame);
      if (g.pos) for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], g.pos[i + k] + o[k]); max[k] = Math.max(max[k], g.pos[i + k] + o[k]); }
      for (const m of g.materials) {
        if (m.texture && !txd.has(m.texture) && !generic.has(m.texture)) missing.add(m.texture);
        if (m.texture === 'carpback') plates++;
      }
    }
    const wheels = frames.filter(n => /^wheel_[lr][fbm]_dummy$/.test(n)).length;
    // a wheel model to copy to the dummies (same rule as isWheelFrame in vehicle.js);
    // some mods leave it to a shared wheel file the pack does not carry
    const wheelMesh = d.atomics.some(a => { const n = d.frames[a.frame].name; return /^wheel/i.test(n) && !/dummy/i.test(n); });
    out.push({
      name, kind: kindOf(name),
      // RW is z-up, y forward: width x, length y, height z
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(v => +v.toFixed(2)),
      wheels, wheelMesh, bikeWheels: frames.includes('wheel_front') && frames.includes('wheel_rear'),
      plates, missing: [...missing],
    });
  } catch (e) {
    out.push({ name, kind: 'broken', error: e.message });
  }
}
out.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('src/vehicles/manifest.json', JSON.stringify(out, null, 1));
const by = {};
for (const v of out) (by[v.kind] ||= []).push(v.name);
for (const [k, v] of Object.entries(by)) console.log(k.padEnd(10), v.length, v.join(' '));
console.log('missing textures:', out.filter(v => v.missing?.length).map(v => v.name + '(' + v.missing.join(',') + ')').join(' '));
console.log('no plate quad:', out.filter(v => ['car', 'van', 'truck', 'bus', 'emergency', 'moto'].includes(v.kind) && !v.plates).map(v => v.name).join(' '));
