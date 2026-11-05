// Builds the whole scene for a seed: site selection, street layout, textures,
// static geometry, props and the camera mount.
import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { chooseSite, siteAt } from '../map/mapdata.js';
import { buildLayout } from '../map/layout.js';
import { TextureBaker, TEX_DEFS } from '../tex/baker.js';
import { MaterialLibrary } from '../tex/matlib.js';
import { buildGround } from './ground.js';
import { buildWalls } from './walls.js';
import { buildBuildings } from './buildings.js';
import { buildProps } from './props.js';
import { buildClutter } from './clutter.js';
import { buildFarField } from './far.js';
import { buildGrime } from './grime.js';
import { buildLitter } from './litter.js';
import { buildYards } from './yards.js';
import { buildParkedCars } from './parked.js';
import { VehicleLibrary } from '../vehicles/vehicle.js';
import { buildPedestrians } from '../peds/index.js';
import { buildTraffic } from '../traffic/index.js';

export async function buildWorld(seed, opts, renderer, log, cfg, baker = null) {
  const rng = new Rng(seed);
  const t0 = performance.now();
  const tk = (label, t) => console.log('[sim] ' + label, Math.round(performance.now() - t), 'ms');
  let ts = performance.now();
  const site = opts.location ? await siteAt(opts.location.lat, opts.location.lon, log) : await chooseSite(rng.fork('site'), opts, log);
  log(`Montando a rua em ${site.city}${site.roadName ? ' — ' + site.roadName : ''}…`);
  tk('site', ts); ts = performance.now();
  const layout = buildLayout(site, rng.fork('layout'), cfg);
  tk('layout', ts); ts = performance.now();

  const texSize = +(cfg?.tex?.size || 512);
  // dataset generator: the procedural textures stay the same from world to world
  // (only their baking seed differs; the samples vary plenty without it)
  const keepTex = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gen') === '1';
  if (!baker || (!keepTex && baker.seed !== seed) || baker.size !== texSize) {
    baker?.dispose();
    log('Gerando texturas procedurais…');
    baker = new TextureBaker(renderer, seed, texSize);
  }
  await baker.bakeAll(['noise', ...Object.keys(TEX_DEFS).filter(n => n !== 'noise')], (p) => log(`Gerando texturas procedurais… ${Math.round(p * 100)}%`));
  baker.setFilter(cfg?.tex?.filter, cfg?.tex?.aniso);
  tk('bake', ts);
  const lib = new MaterialLibrary(baker);

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const gy = (x, z) => site.elevation.sample(x, z);
  const cam = layout.camera;
  const focus = [cam.x + cam.dir[0] * 20, cam.z + cam.dir[1] * 20];
  const ctx = { site, layout, lib, gy, rng: rng.fork('world'), group, scene, focus, city: site.cityKey, nightEmissive: [], lights: [], renderer, cfg, detail: site.radius / 170 };

  log('Construindo ruas e calçadas…');
  { const t1 = performance.now(); buildGround(ctx); console.log('[sim] buildGround', Math.round(performance.now() - t1), 'ms'); }
  log('Construindo muros e portões…');
  { const t1 = performance.now(); buildWalls(ctx); console.log('[sim] buildWalls', Math.round(performance.now() - t1), 'ms'); }
  log('Construindo edificações…');
  { const t1 = performance.now(); buildBuildings(ctx); console.log('[sim] buildBuildings', Math.round(performance.now() - t1), 'ms'); }
  log('Postes, fiação, árvores e mobiliário urbano…');
  { const t1 = performance.now(); buildProps(ctx); console.log('[sim] buildProps', Math.round(performance.now() - t1), 'ms'); }
  log('Sujeira, mato e entulho…');
  { const t1 = performance.now(); buildClutter(ctx); console.log('[sim] buildClutter', Math.round(performance.now() - t1), 'ms'); }
  log('Horizonte…');
  log('Sujeira e desgaste…');
  { const t1 = performance.now(); ctx.grime = buildGrime(ctx); console.log('[sim] buildGrime', Math.round(performance.now() - t1), 'ms'); }
  { const t1 = performance.now(); buildYards(ctx); console.log('[sim] buildYards', Math.round(performance.now() - t1), 'ms'); }
  { const t1 = performance.now(); buildLitter(ctx); console.log('[sim] buildLitter', Math.round(performance.now() - t1), 'ms'); }
  log('Veículos…');
  { const t1 = performance.now(); ctx.vehicles = new VehicleLibrary(lib); try { ctx.parked = await buildParkedCars(ctx, ctx.vehicles); } catch (e) { console.warn('[sim] veículos', e); ctx.parked = []; } console.log('[sim] buildVehicles', Math.round(performance.now() - t1), 'ms'); }
  log('Trânsito e pedestres…');
  { const t1 = performance.now(); try { ctx.traffic = await buildTraffic(ctx, ctx.vehicles); } catch (e) { console.warn('[sim] trânsito', e); ctx.traffic = null; } console.log('[sim] buildTraffic', Math.round(performance.now() - t1), 'ms'); }
  { const t1 = performance.now(); try { ctx.peds = await buildPedestrians(ctx); } catch (e) { console.warn('[sim] pedestres', e); ctx.peds = null; } console.log('[sim] buildPedestrians', Math.round(performance.now() - t1), 'ms'); }
  { const t1 = performance.now(); buildFarField(ctx); console.log('[sim] buildFarField', Math.round(performance.now() - t1), 'ms'); }

  const camGround = cam.kind === 'pole' ? ctx.sidewalkY(cam.x, cam.z) : gy(cam.x, cam.z) + 0.17;
  ctx.cameraPose = {
    position: new THREE.Vector3(cam.x, camGround + cam.h, cam.z),
    yaw: cam.yaw, pitch: THREE.MathUtils.degToRad(cam.pitch), roll: THREE.MathUtils.degToRad(cam.roll),
  };
  console.log(`[sim] world built in ${Math.round(performance.now() - t0)} ms`, { lots: layout.lots.length, buildings: layout.buildings.length, roads: layout.roads.length });
  return { scene, ctx, site, layout, baker, lib };
}
