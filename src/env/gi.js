// Street GI on top of the 2D radiance cascades: a top-down plan of the block around
// the camera. Buildings and walls occlude; open ground is a faint emitting medium
// (sunlight bounced off the pavement, minus cast shadows); sunlit facades, lamp
// pools, open shops and headlights are emitters. Materials read 4 directional
// irradiance maps by world x/z (see matlib.js).
import * as THREE from 'three';
import { RadianceCascades } from './radianceCascades.js';
import { globalUniforms } from '../tex/matlib.js';

const R = 256;
const MEDIUM = 0.03; // opacity of an open texel (makes ground bounce local)

export class StreetGI {
  constructor(renderer, ctx, center, size = 100) {
    this.ctx = ctx;
    this.size = size;
    this.x0 = center[0] - size / 2;
    this.z0 = center[1] - size / 2;
    this.k = R / size;
    this.rc = new RadianceCascades(renderer, R);
    this.data = new Float32Array(R * R * 4);
    this.tex = new THREE.DataTexture(this.data, R, R, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.rc.rayM.uniforms.uScene.value = this.tex;
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = R; return c; };
    this.occCanvas = mk();
    this.shadowCanvas = mk();
    this.emitCanvas = mk();
    this.drawStaticOccluders();
    this.occ = this.occCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, R, R).data;
    const u = globalUniforms;
    u.uGiD0.value = this.rc.dirs[0].texture;
    u.uGiD1.value = this.rc.dirs[1].texture;
    u.uGiD2.value = this.rc.dirs[2].texture;
    u.uGiD3.value = this.rc.dirs[3].texture;
    u.uGiRect.value.set(this.x0, this.z0, size, size);
    u.uGiY.value = ctx.gy(center[0], center[1]);
    u.uGiStrength.value = 1;
    this.last = -1;
  }

  px(x, z) { return [(x - this.x0) * this.k, (z - this.z0) * this.k]; }

  drawStaticOccluders() {
    const g = this.occCanvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, R, R);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    for (const b of this.ctx.layout.buildings) {
      g.beginPath();
      b.outer.forEach((p, i) => { const [x, y] = this.px(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill();
    }
    g.lineWidth = Math.max(1, 0.25 * this.k);
    for (const lot of this.ctx.layout.lots) {
      if (!lot.wall || lot.wall.style === 'fence_wire' || lot.wall.style === 'grille') continue;
      g.globalAlpha = lot.wall.style === 'base_grille' || lot.wall.style === 'low_wall' ? 0.5 : 1;
      g.beginPath();
      lot.front.forEach((p, i) => { const [x, y] = this.px(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // env: Environment; dyn: { cars: [{x,z,len,wid,dx,dz,lights}] }
  update(t, env, dyn = {}) {
    const key = [env.sunDirQ ? env.sunDirQ.toArray().map(v => v.toFixed(3)).join() : '', (env.state.nightF || 0).toFixed(2), env.lights.filter(l => l.light.visible).length, (dyn.cars || []).length, (dyn.cars || []).map(c => c.x.toFixed(0) + c.z.toFixed(0)).join()].join('|');
    if (key === this.key && this.last >= 0) return;
    if (t - this.last < 0.25 && this.last >= 0) return;
    this.key = key;
    this.last = t;
    const st = env.state;
    const sunE = st.sunE || 0;
    const sunCol = env.sun.color;
    const sd = env.sun.position.clone().sub(env.sun.target.position).normalize();
    const sinEl = Math.max(0.02, sd.y);
    const hx = sd.x, hz = sd.z, hl = Math.hypot(hx, hz) || 1;

    // cast shadows of buildings and walls on the ground plane
    const sg = this.shadowCanvas.getContext('2d', { willReadFrequently: true });
    sg.fillStyle = '#000'; sg.fillRect(0, 0, R, R);
    if (sunE > 0.2) {
      sg.fillStyle = '#fff';
      const cot = Math.min(80, Math.sqrt(1 - sinEl * sinEl) / sinEl);
      const ox = -hx / hl, oz = -hz / hl;
      for (const b of this.ctx.layout.buildings) {
        const h = (b.top ?? b.h) - (this.ctx.gy(b.outer[0][0], b.outer[0][1]));
        const L = Math.min(80, h * cot);
        sweep(sg, b.outer, ox * L, oz * L, this);
      }
      for (const lot of this.ctx.layout.lots) {
        if (!lot.wall) continue;
        const L = Math.min(40, lot.wall.h * cot);
        sweep(sg, lot.front, ox * L, oz * L, this, true);
      }
    }
    const shadow = sg.getImageData(0, 0, R, R).data;

    // emitters drawn additively, in units of `scale`
    const eg = this.emitCanvas.getContext('2d', { willReadFrequently: true });
    eg.globalCompositeOperation = 'source-over';
    eg.fillStyle = '#000'; eg.fillRect(0, 0, R, R);
    eg.globalCompositeOperation = 'lighter';
    const emitters = [];
    // sunlit facades re-radiate into the street
    if (sunE > 0.2) {
      const Esun = sunE / sinEl;
      for (const b of this.ctx.layout.buildings) {
        const ring = b.outer;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], c = ring[(i + 1) % ring.length];
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (len < 0.5) continue;
          // outward normal: test side
          let nx = (c[1] - a[1]) / len, nz = -(c[0] - a[0]) / len;
          const mx = (a[0] + c[0]) / 2 + nx * 0.2, mz = (a[1] + c[1]) / 2 + nz * 0.2;
          if (pointIn(mx, mz, ring)) { nx = -nx; nz = -nz; }
          const cosI = (nx * hx + nz * hz) / hl * Math.sqrt(1 - sinEl * sinEl);
          if (cosI <= 0) continue;
          emitters.push({ kind: 'line', a, c, nx, nz, v: 0.35 * Esun * cosI, col: sunCol });
        }
      }
    }
    // artificial lights: pools on the ground under each lamp
    for (const l of env.lights) {
      if (!l.light.visible || !l.light.isSpotLight || l.light.intensity <= 0) continue;
      const p = l.light.position;
      const h = Math.max(3, p.y - this.ctx.gy(p.x, p.z));
      emitters.push({ kind: 'disc', x: p.x, z: p.z, r: h * 1.3, v: 0.25 * l.light.intensity / (h * h), col: l.light.color });
    }
    for (const c of dyn.cars || []) {
      if (!c.lights) continue;
      emitters.push({ kind: 'cone', x: c.x + c.dx * c.len / 2, z: c.z + c.dz * c.len / 2, dx: c.dx, dz: c.dz, r: 14, v: c.lights, col: new THREE.Color(1, 0.95, 0.85) });
    }
    for (const s of dyn.shops || []) emitters.push({ kind: 'line', a: s.a, c: s.c, nx: s.nx, nz: s.nz, v: s.v, col: new THREE.Color(1, 0.97, 0.9) });

    const ground = 0.1 * sunE;
    let scale = Math.max(ground, 1e-6);
    for (const e of emitters) scale = Math.max(scale, e.v);
    for (const e of emitters) {
      const col = `rgb(${Math.round(255 * Math.min(1, e.v / scale * e.col.r))},${Math.round(255 * Math.min(1, e.v / scale * e.col.g))},${Math.round(255 * Math.min(1, e.v / scale * e.col.b))})`;
      if (e.kind === 'line') {
        eg.strokeStyle = col; eg.lineWidth = 1.5;
        eg.beginPath();
        // drawn just inside the occluder so the texels are opaque emitters
        const [x1, y1] = this.px(e.a[0] - e.nx * 0.15, e.a[1] - e.nz * 0.15), [x2, y2] = this.px(e.c[0] - e.nx * 0.15, e.c[1] - e.nz * 0.15);
        eg.moveTo(x1, y1); eg.lineTo(x2, y2); eg.stroke();
      } else if (e.kind === 'disc') {
        const [x, y] = this.px(e.x, e.z);
        const gr = eg.createRadialGradient(x, y, 0, x, y, e.r * this.k);
        gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,1)');
        eg.fillStyle = gr; eg.beginPath(); eg.arc(x, y, e.r * this.k, 0, Math.PI * 2); eg.fill();
      } else if (e.kind === 'cone') {
        const [x, y] = this.px(e.x, e.z);
        const gr = eg.createRadialGradient(x, y, 0, x, y, e.r * this.k);
        gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,1)');
        eg.fillStyle = gr; eg.beginPath(); eg.moveTo(x, y);
        const a = Math.atan2(e.dz, e.dx);
        eg.arc(x, y, e.r * this.k, a - 0.45, a + 0.45); eg.closePath(); eg.fill();
      }
    }
    const em = eg.getImageData(0, 0, R, R).data;

    // compose the float plan
    const d = this.data, occ = this.occ;
    const gc = sunCol;
    for (let i = 0; i < R * R; i++) {
      // canvas row 0 is z0: DataTexture row 0 is also the first row (flipY false)
      const o = occ[i * 4] / 255;
      const sh = shadow[i * 4] / 255;
      const er = em[i * 4] / 255 * scale, egc = em[i * 4 + 1] / 255 * scale, eb = em[i * 4 + 2] / 255 * scale;
      const lit = ground * (1 - sh);
      const j = i * 4;
      if (o > 0.5) {
        d[j] = er; d[j + 1] = egc; d[j + 2] = eb; d[j + 3] = o;
        // occluders only emit where something was drawn on them
      } else {
        const a = MEDIUM;
        d[j] = lit * gc.r + er; d[j + 1] = lit * gc.g + egc; d[j + 2] = lit * gc.b + eb; d[j + 3] = a + o;
      }
    }
    this.tex.needsUpdate = true;
    this.rc.compute(1);
  }

  dispose() { this.rc.dispose(); this.tex.dispose(); globalUniforms.uGiStrength.value = 0; }
}

function sweep(g, ring, dx, dz, gi, open = false) {
  // union of the ring and its translate, plus the quads joining each edge
  const P = ring.map(p => gi.px(p[0], p[1]));
  const Q = ring.map(p => gi.px(p[0] + dx, p[1] + dz));
  const n = P.length;
  const lim = open ? n - 1 : n;
  for (let i = 0; i < lim; i++) {
    const j = (i + 1) % n;
    g.beginPath();
    g.moveTo(P[i][0], P[i][1]); g.lineTo(P[j][0], P[j][1]); g.lineTo(Q[j][0], Q[j][1]); g.lineTo(Q[i][0], Q[i][1]);
    g.closePath(); g.fill();
  }
}

function pointIn(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
