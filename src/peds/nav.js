// Where pedestrians can walk: a grid over the sidewalks around the camera's focus.
//  - cell kinds: sidewalk, carriageway, nothing (lots, buildings)
//  - obstacles: everything static that stands on the sidewalk between the knee
//    and the head (poles, trees, bins, signs, bus stops, the odd motorcycle) is
//    read straight from the scene's geometry; parked cars block the carriageway
//  - dist: metres to the nearest wall, kerb or obstacle. Paths keep a margin
//    from them (people do not brush along walls) and prefer the middle.
//  - crossings: straight lines across a street from kerb to kerb, mostly just
//    past a corner, clear of parked cars.
import * as THREE from 'three';
import { distPointLine, pointAt } from '../core/geom.js';

const CELL = 0.35;
const NONE = 0, WALK = 1, ROAD = 2;
export const MIN_CLEAR = 0.3;      // body radius plus a little: closer is not walkable
const PREF_CLEAR = 0.75;           // walls and kerbs closer than this cost extra

export class NavGrid {
  constructor(ctx, half = 48) {
    const { layout, focus } = ctx;
    this.ctx = ctx;
    this.N = Math.ceil(2 * half / CELL);
    this.x0 = focus[0] - half; this.z0 = focus[1] - half;
    const N = this.N, n = N * N;
    this.kind = new Uint8Array(n);
    this.ground = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    const { sidewalk, carr } = layout.regions;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = this.x0 + (i + 0.5) * CELL, z = this.z0 + (j + 0.5) * CELL;
      const k = j * N + i;
      if (carr.contains(x, z)) this.kind[k] = ROAD;
      else if (sidewalk.contains(x, z)) { this.kind[k] = WALK; this.ground[k] = ctx.sidewalkY(x, z); }
    }
    this.scanObstacles(ctx);
    for (const car of ctx.parked || []) this.blockObject(car, 0.35);
    this.distanceField();
    this.components();
    this.crossings = this.findCrossings(ctx);
  }

  cell(x, z) {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return -1;
    return j * this.N + i;
  }
  center(k) { return [this.x0 + (k % this.N + 0.5) * CELL, this.z0 + (Math.floor(k / this.N) + 0.5) * CELL]; }
  clear(x, z) { const k = this.cell(x, z); return k < 0 ? 0 : this.dist[k]; }
  isRoad(x, z) { const k = this.cell(x, z); return k >= 0 && this.kind[k] === ROAD; }
  walkable(k) { return k >= 0 && this.dist[k] >= MIN_CLEAR; }

  // static meshes: any surface point standing on a sidewalk cell between 0.25 and
  // 1.9 m above it blocks the cell (edges sampled every 15 cm). Vehicles are left
  // out (parked ones are added by footprint, traffic moves).
  scanObstacles(ctx) {
    const N = this.N, x1 = this.x0 + N * CELL, z1 = this.z0 + N * CELL;
    const box = new THREE.Box3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const mark = (x, y, z) => {
      const k = this.cell(x, z);
      if (k < 0 || this.kind[k] !== WALK) return;
      const h = y - this.ground[k];
      if (h > 0.25 && h < 1.9) this.blocked[k] = 1;
    };
    const edge = (p, q) => {
      const len = p.distanceTo(q), n = Math.max(1, Math.ceil(len / 0.15));
      for (let s = 0; s <= n; s++) { const t = s / n; mark(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t); }
    };
    ctx.group.updateMatrixWorld(true);
    const skip = (o) => { for (let p = o; p; p = p.parent) if (p.userData?.size && p.userData?.materials) return true; return false; };
    ctx.group.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.visible || o.userData.decal) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.every(m => !m || m.transparent || m.polygonOffset || !m.visible)) return;
      const g = o.geometry, pos = g.attributes.position;
      if (!pos) return;
      if (!g.boundingBox) g.computeBoundingBox();
      box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      if (box.max.x < this.x0 || box.min.x > x1 || box.max.z < this.z0 || box.min.z > z1) return;
      if (skip(o)) return;
      const idx = g.index, m = o.matrixWorld;
      const tri = idx ? idx.count / 3 : pos.count / 3;
      for (let t = 0; t < tri; t++) {
        const ia = idx ? idx.getX(t * 3) : t * 3, ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(m);
        b.fromBufferAttribute(pos, ib).applyMatrix4(m);
        c.fromBufferAttribute(pos, ic).applyMatrix4(m);
        if (Math.max(a.x, b.x, c.x) < this.x0 || Math.min(a.x, b.x, c.x) > x1 || Math.max(a.z, b.z, c.z) < this.z0 || Math.min(a.z, b.z, c.z) > z1) continue;
        edge(a, b); edge(b, c); edge(c, a);
      }
    });
  }

  // a vehicle's footprint (plus a margin) blocks whatever cells it covers
  blockObject(obj, pad) {
    obj.updateMatrixWorld(true);
    const size = obj.userData.size;
    if (!size) return;
    const hw = size.x / 2 + pad, hl = size.z / 2 + pad;
    const e = obj.matrixWorld.elements;
    const ax = e[0], az = e[2], bx = e[8], bz = e[10];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    const cx = obj.position.x, cz = obj.position.z;
    const r = Math.hypot(hw, hl);
    for (let z = cz - r; z <= cz + r; z += CELL * 0.5) for (let x = cx - r; x <= cx + r; x += CELL * 0.5) {
      const dx = x - cx, dz = z - cz;
      if (Math.abs((dx * ax + dz * az) / la) > hw || Math.abs((dx * bx + dz * bz) / lb) > hl) continue;
      const k = this.cell(x, z);
      if (k >= 0) this.blocked[k] = 1;
    }
  }

  // metres from each sidewalk cell to the nearest cell that is not free sidewalk
  // (two-pass chamfer, 1 / sqrt 2)
  distanceField() {
    const N = this.N, n = N * N, INF = 1e9;
    const d = new Float32Array(n);
    for (let k = 0; k < n; k++) d[k] = this.kind[k] === WALK && !this.blocked[k] ? INF : 0;
    const D1 = CELL, D2 = CELL * Math.SQRT2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + D1);
      if (j > 0) {
        v = Math.min(v, d[k - N] + D1);
        if (i > 0) v = Math.min(v, d[k - N - 1] + D2);
        if (i < N - 1) v = Math.min(v, d[k - N + 1] + D2);
      }
      d[k] = v;
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i < N - 1) v = Math.min(v, d[k + 1] + D1);
      if (j < N - 1) {
        v = Math.min(v, d[k + N] + D1);
        if (i < N - 1) v = Math.min(v, d[k + N + 1] + D2);
        if (i > 0) v = Math.min(v, d[k + N - 1] + D2);
      }
      d[k] = v;
    }
    // the grid border is not a wall
    for (let k = 0; k < n; k++) if (d[k] >= INF) d[k] = 50;
    // a cell's value is the distance from its centre to the obstacle's edge
    for (let k = 0; k < n; k++) if (d[k]) d[k] -= CELL / 2;
    this.dist = d;
  }

  // connected walkable areas (each side of a block is usually one)
  components() {
    const N = this.N, comp = new Int32Array(N * N).fill(-1);
    let id = 0;
    const stack = [];
    for (let s = 0; s < N * N; s++) {
      if (comp[s] >= 0 || !this.walkable(s)) continue;
      comp[s] = id; stack.push(s);
      while (stack.length) {
        const k = stack.pop(), i = k % N;
        for (const nk of [k - 1, k + 1, k - N, k + N]) {
          if (nk < 0 || nk >= N * N || comp[nk] >= 0) continue;
          if ((nk === k - 1 && i === 0) || (nk === k + 1 && i === N - 1)) continue;
          if (!this.walkable(nk)) continue;
          comp[nk] = id; stack.push(nk);
        }
      }
      id++;
    }
    this.comp = comp;
  }

  // the walkable cell nearest to (x, z) with at least `need` clearance, within r
  snap(x, z, r = 1.5, need = MIN_CLEAR + 0.1) {
    let best = -1, bd = Infinity;
    const c = Math.ceil(r / CELL);
    const k0 = this.cell(x, z);
    if (k0 < 0) return -1;
    const i0 = k0 % this.N, j0 = Math.floor(k0 / this.N);
    for (let j = j0 - c; j <= j0 + c; j++) for (let i = i0 - c; i <= i0 + c; i++) {
      if (i < 0 || j < 0 || i >= this.N || j >= this.N) continue;
      const k = j * this.N + i;
      if (this.dist[k] < need) continue;
      const [cx, cz] = this.center(k);
      const d = Math.hypot(cx - x, cz - z);
      if (d < bd && d <= r) { bd = d; best = k; }
    }
    return best;
  }

  // A* between two cells (8-neighbour); -> [[x, z], ...] smoothed, or null
  path(from, to) {
    if (from < 0 || to < 0 || this.comp[from] !== this.comp[to] || this.comp[from] < 0) return null;
    const N = this.N;
    const g = this._g || (this._g = new Float32Array(N * N));
    const came = this._came || (this._came = new Int32Array(N * N));
    const stamp = this._stamp || (this._stamp = new Uint32Array(N * N));
    const closed = this._closed || (this._closed = new Uint32Array(N * N));
    const run = (this._run = (this._run || 0) + 1);
    const ti = to % N, tj = Math.floor(to / N);
    const h = (k) => { const dx = Math.abs(k % N - ti), dz = Math.abs(Math.floor(k / N) - tj); return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * CELL; };
    const heap = new Heap();
    g[from] = 0; stamp[from] = run; came[from] = -1;
    heap.push(from, h(from));
    const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false, iter = 0;
    while (heap.size && iter++ < 60000) {
      const k = heap.pop();
      if (closed[k] === run) continue;
      closed[k] = run;
      if (k === to) { found = true; break; }
      const i = k % N, j = Math.floor(k / N);
      for (const [di, dj, w] of nb) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nk = nj * N + ni;
        if (!this.walkable(nk) || closed[nk] === run) continue;
        // no corner cutting past a blocked cell
        if (di && dj && (!this.walkable(j * N + ni) || !this.walkable(nj * N + i))) continue;
        const cl = this.dist[nk];
        const cost = w * CELL * (1 + 3 * Math.max(0, PREF_CLEAR - cl) / PREF_CLEAR);
        const ng = g[k] + cost;
        if (stamp[nk] === run && ng >= g[nk]) continue;
        stamp[nk] = run; g[nk] = ng; came[nk] = k;
        heap.push(nk, ng + h(nk));
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = to; k >= 0; k = came[k]) cells.push(k);
    cells.reverse();
    return this.smooth(cells.map(k => this.center(k)));
  }

  // free line between two points: every sample keeps `need` clearance
  sight(a, b, need) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 0.15));
    for (let s = 0; s <= n; s++) if (this.clear(a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n) < need) return false;
    return true;
  }

  // string pulling (shortcuts that keep the margin), then rounded corners
  smooth(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 40);
      const need = Math.min(PREF_CLEAR, this.clear(...pts[i]) - 0.05, ...pts.slice(i, j + 1).map(p => this.clear(...p) - 0.05));
      while (j > i + 1 && !this.sight(pts[i], pts[j], Math.max(MIN_CLEAR, need))) j--;
      out.push(pts[j]);
      i = j;
    }
    // resample at ~0.6 m and round with two Chaikin passes
    let r = [];
    for (let k = 0; k < out.length - 1; k++) {
      const a = out[k], b = out[k + 1], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.6));
      for (let s = 0; s < n; s++) r.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
    }
    r.push(out[out.length - 1]);
    for (let pass = 0; pass < 2; pass++) {
      const c = [r[0]];
      for (let k = 0; k < r.length - 1; k++) {
        const a = r[k], b = r[k + 1];
        c.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      c.push(r[r.length - 1]);
      // keep only what stays walkable
      r = c.filter((p, k) => k === 0 || k === c.length - 1 || this.clear(p[0], p[1]) >= MIN_CLEAR);
    }
    return r;
  }

  // Kerb-to-kerb lines across the streets near the focus. People cross just past
  // the corner of an intersection (weight 3) or anywhere along the block (1).
  findCrossings(ctx) {
    const { layout, focus } = ctx;
    const roads = layout.roads.filter(r => r.w >= 4);
    const out = [];
    const near = (x, z, d) => Math.hypot(x - focus[0], z - focus[1]) < d;
    for (const rd of roads) {
      if (!rd.pts.some(p => near(p[0], p[1], 120))) continue;
      // arc length of the intersections along this road
      const nodes = [];
      let s = 0;
      for (let i = 0; i < rd.pts.length; i++) {
        if (i > 0) s += Math.hypot(rd.pts[i][0] - rd.pts[i - 1][0], rd.pts[i][1] - rd.pts[i - 1][1]);
        const [px, pz] = rd.pts[i];
        for (const o of roads) {
          if (o === rd || distPointLine(px, pz, o.pts).d > 1) continue;
          nodes.push({ s, clear: o.w / 2 + Math.max(o.swL || 0, o.swR || 0) });
        }
      }
      const cand = [];
      for (const nd of nodes) for (const dir of [-1, 1]) for (const extra of [1.2, 2.5, 4]) cand.push({ s: nd.s + dir * (nd.clear + extra), w: 3 });
      for (let t = 8; t < rd.len - 8; t += 9) cand.push({ s: t, w: 1 });
      for (const c of cand) {
        if (c.s < 1 || c.s > rd.len - 1) continue;
        const q = pointAt(rd.pts, c.s);
        if (!near(q.x, q.z, 42)) continue;
        // inside an intersection the far kerb is not across this road
        if (nodes.some(nd => Math.abs(nd.s - c.s) < nd.clear + 0.8)) continue;
        const nx = -q.dz, nz = q.dx, off = rd.w / 2 + 0.55;
        const ka = this.snap(q.x + nx * off, q.z + nz * off, 1.0), kb = this.snap(q.x - nx * off, q.z - nz * off, 1.0);
        if (ka < 0 || kb < 0 || this.comp[ka] === this.comp[kb]) continue;
        const a = this.center(ka), b = this.center(kb);
        // straight across: nothing but carriageway and kerb on the way, no parked car
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > rd.w + 3) continue;
        let ok = true;
        const n = Math.ceil(len / 0.2);
        for (let k = 0; k <= n && ok; k++) {
          const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n;
          const cc = this.cell(x, z);
          if (cc < 0 || this.kind[cc] === NONE || this.blocked[cc]) ok = false;
          // and not across another street
          if (ok && this.kind[cc] === ROAD && roads.some(o => o !== rd && distPointLine(x, z, o.pts).d < o.w / 2 - 0.3)) ok = false;
        }
        if (!ok) continue;
        if (out.some(o => Math.hypot(o.a[0] - a[0], o.a[1] - a[1]) < 1.5)) continue;
        out.push({ a, b, ka, kb, road: rd, w: c.w, dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len], len });
      }
    }
    return out;
  }
}

class Heap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p;
    let i = k.length;
    k.push(key); p.push(pri);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pri) break;
      k[i] = k[up]; p[i] = p[up]; i = up;
    }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p, top = k[0];
    const lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        k[i] = k[c]; p[i] = p[c]; i = c;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}
