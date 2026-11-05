// Reflection probes for every vehicle, refreshed several times a second (the GTA V
// approach): each vehicle has its own small cube capture, taken just above its
// roof, of a low-detail stand-in of the street (probescene.js) instead of the
// full scene, so a probe costs a few draw calls per face. Three prefilters the
// cube by roughness (PMREM) when a material uses it, reusing its targets.
// Lamp heads are not in the stand-in: their light already reaches the car directly.
import * as THREE from 'three';
import { buildProbeScene } from './probescene.js';

const SIZE = 128;   // cube face (the clear coat of a car a few hundred pixels wide)
const RATE = 6;     // refreshes per second of every probe

export class CarProbes {
  // parked: vehicles that stay put; traffic: [{ obj, active }] (moving vehicles)
  constructor(renderer, ctx, env, parked = [], traffic = []) {
    this.renderer = renderer;
    this.ctx = ctx;
    this.proxy = buildProbeScene(ctx, env);
    this.items = [
      ...parked.map(obj => ({ obj, moving: null })),
      ...traffic.map(t => ({ obj: t.obj, moving: t })),
    ].map(it => {
      const rt = new THREE.WebGLCubeRenderTarget(SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
      const cam = new THREE.CubeCamera(0.1, 150, rt);
      for (const m of it.obj.userData.materials || []) m.envMap = rt.texture;
      return { ...it, rt, cam };
    });
    this.next = 0;
    this.budget = 0;
    this.stats = { captures: 0 };
    console.log('[sim] probe scene', Math.round(this.proxy.triangles), 'triangles,', this.items.length, 'probes');
  }

  // moving blocks of the stand-in: every vehicle (paint colour) and person
  blocks() {
    const out = [];
    for (const it of this.items) {
      it.block = null;
      if (it.moving && !it.moving.active) continue;
      const o = it.obj, s = o.userData.size;
      it.block = { x: o.position.x, y: o.position.y, z: o.position.z, yaw: o.rotation.y, w: s.x, l: s.z, h: s.y * 0.85, color: o.userData.paint };
      out.push(it.block);
    }
    for (const p of this.ctx.pedAgents || []) out.push({ x: p.x, y: this.ctx.sidewalkY?.(p.x, p.z) ?? 0, z: p.z, yaw: 0, w: 0.45, l: 0.3, h: 1.7 });
    this.proxy.setDynamic(out);
  }

  capture(it) {
    const r = this.renderer, o = it.obj;
    const s = o.userData.size;
    const at = it.cam.position.set(o.position.x, o.position.y + s.y + 0.25, o.position.z);
    it.cam.updateMatrixWorld(true);
    if (it.cam.coordinateSystem !== r.coordinateSystem) { it.cam.coordinateSystem = r.coordinateSystem; it.cam.updateCoordinateSystem(); }
    this.proxy.sync(at);
    const slot = it.block?.slot ?? -1;
    this.proxy.hideSlot(slot, true);           // its own block would surround the camera
    const prev = r.getRenderTarget();
    // the stand-in's own sun shadow map is redrawn about once a second (the main
    // scene's shadows are not affected: they are only drawn when its pass asks)
    const now = performance.now();
    r.shadowMap.needsUpdate = now - (this.lastShadow || 0) > 1000;
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    it.cam.update(r, this.proxy.scene);         // also flags the cube for re-prefiltering
    r.shadowMap.needsUpdate = false;
    r.setRenderTarget(prev);
    this.proxy.hideSlot(slot, false);
    this.stats.captures++;
  }

  // every probe now (after a build or a change of time / weather)
  updateAll() {
    this.blocks();
    for (const it of this.items) if (!it.moving || it.moving.active) this.capture(it);
  }

  // called once per frame: RATE refreshes per probe per second, spread over frames
  tick() {
    // own clock: it is called only on the frames the camera captures
    const now = performance.now();
    const dt = this.lastTick === undefined ? 0 : (now - this.lastTick) / 1000;
    this.lastTick = now;
    const live = this.items.filter(it => !it.moving || it.moving.active);
    if (!live.length) return;
    this.budget = Math.min(this.budget + live.length * RATE * Math.min(dt, 0.25), live.length);
    if (this.budget < 1) return;
    this.blocks();
    while (this.budget >= 1) {
      this.capture(live[this.next++ % live.length]);
      this.budget -= 1;
    }
  }

  dispose() {
    for (const it of this.items) it.rt.dispose();
    this.proxy.dispose();
  }
}
