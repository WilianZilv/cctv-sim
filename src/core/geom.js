// 2D polygon helpers. Points are [x, z] in meters. Clipper works in integers,
// so everything is scaled to centimeters on the way in.
import ClipperLib from 'clipper-lib';

const S = 100;
const toC = path => path.map(([x, z]) => ({ X: Math.round(x * S), Y: Math.round(z * S) }));
const fromC = path => path.map(p => [p.X / S, p.Y / S]);

export const JOIN = { round: ClipperLib.JoinType.jtRound, miter: ClipperLib.JoinType.jtMiter, square: ClipperLib.JoinType.jtSquare };
export const END = { round: ClipperLib.EndType.etOpenRound, butt: ClipperLib.EndType.etOpenButt, square: ClipperLib.EndType.etOpenSquare, closed: ClipperLib.EndType.etClosedPolygon };

// A "region" is a list of ExPolygons: { outer: ring, holes: [ring] }, kept in clipper space
// internally as flat Paths so boolean ops chain cheaply.
export class Region {
  constructor(paths = []) { this.paths = paths; }
  static fromRings(rings) { return new Region(rings.map(toC)); }
  static fromLines(lines, halfWidth, end = END.round, join = JOIN.round) {
    const co = new ClipperLib.ClipperOffset(2, 4);
    const out = new ClipperLib.Paths();
    // each line may carry its own width
    const r = new Region();
    for (const l of lines) {
      co.Clear();
      co.AddPath(toC(l.pts || l), join, end);
      const sol = new ClipperLib.Paths();
      co.Execute(sol, (l.half ?? halfWidth) * S);
      for (const p of sol) out.push(p);
    }
    r.paths = out;
    return r.union(new Region());
  }
  static rect(x0, z0, x1, z1) { return Region.fromRings([[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]); }
  bool(other, type) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(this.paths, ClipperLib.PolyType.ptSubject, true);
    if (other) c.AddPaths(other.paths, ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    c.Execute(type, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return new Region(sol);
  }
  union(o) { return this.bool(o, ClipperLib.ClipType.ctUnion); }
  minus(o) { return this.bool(o, ClipperLib.ClipType.ctDifference); }
  and(o) { return this.bool(o, ClipperLib.ClipType.ctIntersection); }
  offset(d, join = JOIN.round) {
    const co = new ClipperLib.ClipperOffset(2, 4);
    co.AddPaths(this.paths, join, END.closed);
    const sol = new ClipperLib.Paths();
    co.Execute(sol, d * S);
    return new Region(sol);
  }
  // morphological closing: rounds concave corners (curb radius at intersections)
  close(r) { return this.offset(r).offset(-r); }
  open(r) { return this.offset(-r).offset(r); }
  simplify(tol = 0.05) {
    return new Region(ClipperLib.JS.Clean(this.paths, tol * S));
  }
  area() { let a = 0; for (const p of this.paths) a += ClipperLib.Clipper.Area(p); return a / (S * S); }
  isEmpty() { return this.paths.length === 0 || Math.abs(this.area()) < 0.01; }
  // even-odd test over outer rings + holes, with edges bucketed in 1 m rows so a
  // query only looks at the few edges crossing its row
  contains(x, z) {
    if (!this._rows) this._buildRows();
    const row = this._rows.get(Math.floor(z));
    if (!row) return false;
    let inside = false;
    for (let i = 0; i < row.length; i += 4) {
      const ax = row[i], az = row[i + 1], bx = row[i + 2], bz = row[i + 3];
      if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
    }
    return inside;
  }
  _buildRows() {
    const rows = new Map();
    for (const p of this.paths) {
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const ax = p[j].X / S, az = p[j].Y / S, bx = p[i].X / S, bz = p[i].Y / S;
        for (let r = Math.floor(Math.min(az, bz)); r <= Math.floor(Math.max(az, bz)); r++) {
          let a = rows.get(r);
          if (!a) { a = []; rows.set(r, a); }
          a.push(ax, az, bx, bz);
        }
      }
    }
    this._rows = rows;
  }
  rings() { return this.paths.map(fromC); }
  // ExPolygons, for triangulation
  expolys() {
    const c = new ClipperLib.Clipper();
    c.AddPaths(this.paths, ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const out = [];
    const walk = node => {
      for (const ch of node.Childs()) {
        if (!ch.IsHole()) {
          out.push({ outer: fromC(ch.Contour()), holes: ch.Childs().map(h => fromC(h.Contour())) });
          for (const h of ch.Childs()) walk(h);
        }
      }
    };
    walk(tree);
    return out;
  }
}

export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}
export function centroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

// position + unit tangent at arc length s
export function pointAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= l || i === pts.length - 1) {
      const t = l > 0 ? Math.max(0, Math.min(1, s / l)) : 0;
      const dx = l > 0 ? (b[0] - a[0]) / l : 1, dz = l > 0 ? (b[1] - a[1]) / l : 0;
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx, dz, seg: i - 1 };
    }
    s -= l;
  }
  const p = pts[pts.length - 1];
  return { x: p[0], z: p[1], dx: 1, dz: 0, seg: pts.length - 2 };
}

// offset a polyline sideways (positive = right of travel direction in x-east/z-south frame)
export function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    // right normal of (tx,tz) with z pointing south: (-tz, tx)
    let nx = -tz, nz = tx;
    let k = 1;
    if (i > 0 && i < pts.length - 1) {
      const ux = p[0] - a[0], uz = p[1] - a[1], ul = Math.hypot(ux, uz) || 1;
      const n1x = -uz / ul, n1z = ux / ul;
      const cos = n1x * nx + n1z * nz;
      k = 1 / Math.max(0.5, cos);
    }
    out.push([p[0] + nx * d * k, p[1] + nz * d * k]);
  }
  return out;
}

export function resample(pts, step) {
  const L = polyLength(pts);
  const n = Math.max(1, Math.round(L / step));
  const out = [];
  for (let i = 0; i <= n; i++) { const q = pointAt(pts, L * i / n); out.push([q.x, q.z]); }
  return out;
}

export function distPointSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  return { d: Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t), t };
}

export function distPointLine(px, pz, pts) {
  let best = { d: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distPointSeg(px, pz, pts[i], pts[i + 1]);
    if (r.d < best.d) best = { d: r.d, seg: i, t: r.t };
  }
  return best;
}

export function segIntersect(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

// distance along a ray to the first crossing with any ring edge
export function rayToRings(ox, oz, dx, dz, rings, maxD) {
  const b = [ox + dx * maxD, oz + dz * maxD];
  let best = maxD;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const t = segIntersect([ox, oz], b, r[j], r[i]);
      if (t !== null && t * maxD > 0.05) best = Math.min(best, t * maxD);
    }
  }
  return best;
}
