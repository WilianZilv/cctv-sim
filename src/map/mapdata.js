// Mapbox is used only as a data source: road centerlines, building footprints,
// house numbers, bus stops and terrain elevation. Nothing from Mapbox is drawn.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { Region } from '../core/geom.js';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const Z = 16;
const TERRAIN_Z = 15;

// Urban bounding boxes, plus a few denser sub-areas so most draws land on streets.
export const CITIES = {
  sp: {
    name: 'São Paulo', tz: -3,
    boxes: [
      [-23.66, -46.75, -23.49, -46.55, 4], // centro expandido
      [-23.62, -46.55, -23.52, -46.45, 2], // zona leste
      [-23.75, -46.75, -23.62, -46.62, 2], // zona sul
      [-23.50, -46.72, -23.45, -46.58, 1], // zona norte
    ],
  },
  cwb: {
    name: 'Curitiba', tz: -3,
    boxes: [
      [-25.49, -49.33, -25.39, -49.23, 4],
      [-25.55, -49.33, -25.49, -49.24, 2],
      [-25.39, -49.31, -25.35, -49.22, 1],
    ],
  },
};

export const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'street_limited', 'service', 'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link']);
const SITE_CLASSES = new Set(['street', 'street_limited', 'tertiary', 'secondary']);

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = (lon + 180) / 360 * n;
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return [x, y];
}
function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return [lon, lat];
}

async function cachedFetch(url, key) {
  let cache = null;
  try { cache = await caches.open('cctv-sim-tiles-v1'); } catch { /* no Cache API */ }
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
  if (cache) await cache.put(key, res.clone());
  return res;
}

async function fetchVectorTile(x, y) {
  const key = `https://tiles.local/v/${Z}/${x}/${y}`;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/${Z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`;
  const res = await cachedFetch(url, key);
  return new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
}

// decoded terrain tiles, kept per session; the promise is stored so a prefetch and
// the real load share one request
const terrainMemo = new Map();
function terrainTile(x, y) {
  const k = x + ',' + y;
  if (!terrainMemo.has(k)) {
    const p = fetchTerrainTile(x, y);
    p.catch(() => terrainMemo.delete(k));
    terrainMemo.set(k, p);
  }
  return terrainMemo.get(k);
}
function terrainTileRange(proj, radius) {
  const [lonA, latA] = proj.toLonLat(-radius, -radius);
  const [lonB, latB] = proj.toLonLat(radius, radius);
  const [x0, y0] = lonLatToTile(lonA, latA, TERRAIN_Z);
  const [x1, y1] = lonLatToTile(lonB, latB, TERRAIN_Z);
  const out = [];
  for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++) out.push([tx, ty]);
  return out;
}

async function fetchTerrainTile(x, y) {
  const key = `https://tiles.local/t/${TERRAIN_Z}/${x}/${y}`;
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${TERRAIN_Z}/${x}/${y}@2x.pngraw?access_token=${TOKEN}`;
  const res = await cachedFetch(url, key);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const h = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < h.length; i++) h[i] = -10000 + (d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2]) * 0.1;
  return { w: bmp.width, h: bmp.height, data: h };
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  return a;
}

function classifyRings(rings) {
  const polys = [];
  let cur = null, ccw = undefined;
  for (const r of rings) {
    const a = signedArea(r);
    if (a === 0) continue;
    if (ccw === undefined) ccw = a < 0;
    if (ccw === a < 0) { cur = [r]; polys.push(cur); } else if (cur) cur.push(r);
  }
  return polys;
}

// Local metric frame centered on (lat0, lon0): x east, z south (three.js -Z is north).
export function makeProjection(lat0, lon0) {
  const R = 6378137;
  const k = Math.cos(lat0 * Math.PI / 180);
  const mx = lon => R * lon * Math.PI / 180;
  const my = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const mx0 = mx(lon0), my0 = my(lat0);
  return {
    toLocal(lon, lat) { return [(mx(lon) - mx0) * k, -(my(lat) - my0) * k]; },
    toLonLat(x, z) {
      const lon = (x / k + mx0) / R * 180 / Math.PI;
      const lat = (2 * Math.atan(Math.exp((-z / k + my0) / R)) - Math.PI / 2) * 180 / Math.PI;
      return [lon, lat];
    },
  };
}

// Tiles carry a buffer beyond their extent; when several tiles are merged each one is
// cut to its own square so nothing is duplicated.
function clipLinePx(line, ext) {
  const out = [];
  let cur = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const tests = [[-dx, a.x], [dx, ext - a.x], [-dy, a.y], [dy, ext - a.y]];
    let ok = true;
    for (const [p, q] of tests) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const pa = { x: a.x + dx * t0, y: a.y + dy * t0 }, pb = { x: a.x + dx * t1, y: a.y + dy * t1 };
    if (!cur.length || t0 > 0) { if (cur.length > 1) out.push(cur); cur = [pa]; }
    cur.push(pb);
    if (t1 < 1) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function clipRingPx(ring, ext) {
  let pts = ring;
  const edges = [
    [p => p.x >= 0, (a, b) => -a.x / (b.x - a.x)],
    [p => p.x <= ext, (a, b) => (ext - a.x) / (b.x - a.x)],
    [p => p.y >= 0, (a, b) => -a.y / (b.y - a.y)],
    [p => p.y <= ext, (a, b) => (ext - a.y) / (b.y - a.y)],
  ];
  for (const [inside, tAt] of edges) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) { const t = tAt(a, b); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}

function parseTile(tile, tx, ty, proj, radius, clip = false) {
  const lines = (g, ext) => clip ? g.flatMap(l => clipLinePx(l, ext)) : g;
  const polys = (g, ext) => {
    const ps = classifyRings(g);
    if (!clip) return ps;
    return ps.map(rings => rings.map(r => clipRingPx(r, ext))).filter(rings => rings[0].length >= 3).map(rings => rings.filter(r => r.length >= 3));
  };
  const inTile = (pt, ext) => !clip || (pt.x >= 0 && pt.x < ext && pt.y >= 0 && pt.y < ext);
  const toLocal = (p, ext) => {
    const [lon, lat] = tileToLonLat(tx + p.x / ext, ty + p.y / ext, Z);
    return proj.toLocal(lon, lat);
  };
  const inR = ([x, z]) => Math.abs(x) < radius && Math.abs(z) < radius;
  const out = { roads: [], buildings: [], structures: [], housenums: [], stops: [], landuse: [], pois: [] };
  const L = tile.layers;

  if (L.road) {
    for (let i = 0; i < L.road.length; i++) {
      const f = L.road.feature(i);
      const p = f.properties;
      const geom = f.loadGeometry();
      if (f.type === 1) {
        for (const ring of geom) for (const pt of ring) {
          if (!inTile(pt, L.road.extent)) continue;
          const q = toLocal(pt, L.road.extent);
          if (inR(q)) out.structures.push({ cls: p.class, type: p.type, pos: q });
        }
        continue;
      }
      if (f.type !== 2) continue;
      if (p.structure === 'tunnel' || (p.layer && p.layer < 0)) continue;
      for (const line of lines(geom, L.road.extent)) {
        const pts = line.map(pt => toLocal(pt, L.road.extent));
        if (!pts.some(inR)) continue;
        out.roads.push({ cls: p.class, type: p.type, oneway: p.oneway === 'true' || p.oneway === true, name: p.name || '', structure: p.structure, pts });
      }
    }
  }
  if (L.building) {
    for (let i = 0; i < L.building.length; i++) {
      const f = L.building.feature(i);
      const p = f.properties;
      if (p.underground === 'true' || p.underground === true) continue;
      for (const poly of polys(f.loadGeometry(), L.building.extent)) {
        const rings = poly.map(r => r.map(pt => toLocal(pt, L.building.extent)));
        // drop the closing duplicate vertex
        for (const r of rings) { const a = r[0], b = r[r.length - 1]; if (a[0] === b[0] && a[1] === b[1]) r.pop(); }
        if (!rings[0].some(inR)) continue;
        out.buildings.push({ id: p.building_id, type: p.type, height: +p.height || 0, minHeight: +p.min_height || 0, rings });
      }
    }
  }
  if (L.structure) {
    for (let i = 0; i < L.structure.length; i++) {
      const f = L.structure.feature(i);
      const p = f.properties;
      const geom = f.loadGeometry().map(r => r.map(pt => toLocal(pt, L.structure.extent)));
      if (!geom.some(r => r.some(inR))) continue;
      out.structures.push({ cls: p.class, type: p.type, geom, geomType: f.type });
    }
  }
  if (L.housenum_label) {
    for (let i = 0; i < L.housenum_label.length; i++) {
      const f = L.housenum_label.feature(i);
      if (!inTile(f.loadGeometry()[0][0], L.housenum_label.extent)) continue;
      const q = toLocal(f.loadGeometry()[0][0], L.housenum_label.extent);
      if (inR(q)) out.housenums.push({ pos: q, num: f.properties.house_num });
    }
  }
  if (L.transit_stop_label) {
    for (let i = 0; i < L.transit_stop_label.length; i++) {
      const f = L.transit_stop_label.feature(i);
      if (f.properties.mode !== 'bus') continue;
      if (!inTile(f.loadGeometry()[0][0], L.transit_stop_label.extent)) continue;
      const q = toLocal(f.loadGeometry()[0][0], L.transit_stop_label.extent);
      if (inR(q)) out.stops.push({ pos: q, name: f.properties.name || '' });
    }
  }
  if (L.landuse) {
    for (let i = 0; i < L.landuse.length; i++) {
      const f = L.landuse.feature(i);
      for (const poly of polys(f.loadGeometry(), L.landuse.extent)) {
        const rings = poly.map(r => r.map(pt => toLocal(pt, L.landuse.extent)));
        if (!rings[0].some(inR)) continue;
        out.landuse.push({ cls: f.properties.class, type: f.properties.type, rings });
      }
    }
  }
  if (L.poi_label) {
    for (let i = 0; i < L.poi_label.length; i++) {
      const f = L.poi_label.feature(i);
      if (!inTile(f.loadGeometry()[0][0], L.poi_label.extent)) continue;
      const q = toLocal(f.loadGeometry()[0][0], L.poi_label.extent);
      if (inR(q)) out.pois.push({ pos: q, cls: f.properties.class, cat: f.properties.category_en, name: f.properties.name || '' });
    }
  }
  return out;
}

function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2));
  const x = a[0] + dx * t, z = a[1] + dz * t;
  return [Math.hypot(px - x, pz - z), x, z, t];
}

// Elevation grid in local meters, smoothed so SRTM noise does not make the street wavy.
async function loadElevation(proj, radius) {
  const tiles = new Map();
  await Promise.all(terrainTileRange(proj, radius).map(([tx, ty]) => terrainTile(tx, ty).then(t => tiles.set(`${tx},${ty}`, t))));
  const step = 2, n = Math.ceil(radius * 2 / step) + 1;
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -radius + i * step, z = -radius + j * step;
      const [lon, lat] = proj.toLonLat(x, z);
      const [fx, fy] = lonLatToTile(lon, lat, TERRAIN_Z);
      const t = tiles.get(`${Math.floor(fx)},${Math.floor(fy)}`);
      const u = (fx - Math.floor(fx)) * t.w - 0.5, v = (fy - Math.floor(fy)) * t.h - 0.5;
      const iu = Math.max(0, Math.min(t.w - 2, Math.floor(u))), iv = Math.max(0, Math.min(t.h - 2, Math.floor(v)));
      const a = u - iu, b = v - iv;
      const d = t.data, w = t.w;
      grid[j * n + i] = (d[iv * w + iu] * (1 - a) + d[iv * w + iu + 1] * a) * (1 - b) + (d[(iv + 1) * w + iu] * (1 - a) + d[(iv + 1) * w + iu + 1] * a) * b;
    }
  }
  // separable gaussian blur, sigma ~8 m
  const blur = (src) => {
    const k = [], r = 8;
    let s = 0;
    for (let i = -r; i <= r; i++) { const w = Math.exp(-((i * step) ** 2) / (2 * 64)); k.push(w); s += w; }
    const tmp = new Float32Array(n * n), dst = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let o = -r; o <= r; o++) acc += src[j * n + Math.max(0, Math.min(n - 1, i + o))] * k[o + r];
      tmp[j * n + i] = acc / s;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let o = -r; o <= r; o++) acc += tmp[Math.max(0, Math.min(n - 1, j + o)) * n + i] * k[o + r];
      dst[j * n + i] = acc / s;
    }
    return dst;
  };
  const sm = blur(grid);
  const c = (n - 1) / 2;
  const h0 = sm[c * n + c];
  for (let i = 0; i < sm.length; i++) sm[i] -= h0;
  return {
    base: h0,
    sample(x, z) {
      const u = Math.max(0, Math.min(n - 1.001, (x + radius) / step));
      const v = Math.max(0, Math.min(n - 1.001, (z + radius) / step));
      const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j;
      return (sm[j * n + i] * (1 - a) + sm[j * n + i + 1] * a) * (1 - b) + (sm[(j + 1) * n + i] * (1 - a) + sm[(j + 1) * n + i + 1] * a) * b;
    },
  };
}

// Picks a street location for the seed. Rejects parks, water and empty tiles.
// half-size of the generated square, in meters (500 m across)
export const SITE_RADIUS = 250;
// dataset generator (?gen=1): its cameras aim within ~75 m of the street's focus, from
// at most 80 m away; a smaller built area builds and renders faster (the far field
// still fills the horizon)
const GEN_RADIUS = 180;
const GEN = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gen') === '1';

export async function chooseSite(rng, opts = {}, log = () => {}) {
  for (let attempt = 0; attempt < 14; attempt++) {
    const r = rng.fork('site' + attempt);
    const cityKey = opts.city && opts.city !== 'any' ? opts.city : r.weighted([['sp', 0.6], ['cwb', 0.4]]);
    const city = CITIES[cityKey];
    const box = r.weighted(city.boxes.map(b => [b, b[4]]));
    const lat = r.float(box[0], box[2]);
    const lon = r.float(box[1], box[3]);
    const [fx, fy] = lonLatToTile(lon, lat, Z);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    log(`Buscando dados de ${city.name} (${lat.toFixed(4)}, ${lon.toFixed(4)})…`);
    let tile;
    try { tile = await fetchVectorTile(tx, ty); } catch (e) { log('Falha no tile: ' + e.message); continue; }

    // Candidate street segments inside the inner part of the tile so the whole region
    // is covered by this single tile.
    const [tlon, tlat] = tileToLonLat(tx + 0.5, ty + 0.5, Z);
    const tileProj = makeProjection(tlat, tlon);
    const tileData = parseTile(tile, tx, ty, tileProj, 400);
    const [px, pz] = tileProj.toLocal(lon, lat);
    const half = 280; // half tile width in meters (approx, z16 at this latitude)
    let best = null;
    for (const road of tileData.roads) {
      if (!SITE_CLASSES.has(road.cls)) continue;
      for (let i = 0; i < road.pts.length - 1; i++) {
        const a = road.pts[i], b = road.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 25) continue;
        const [d, x, z, t] = distToSeg(px, pz, a, b);
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        // keep away from the segment ends so the camera does not sit inside an intersection
        if (t * len < 10 || (1 - t) * len < 10) continue;
        const score = d + (road.cls === 'street' ? 0 : 25) + r.float(0, 30);
        if (!best || score < best.score) best = { score, x, z, road, seg: i };
      }
    }
    if (!best) { log('Sem rua adequada, tentando outro ponto…'); continue; }
    const nBuild = tileData.buildings.filter(b => Math.hypot(b.rings[0][0][0] - best.x, b.rings[0][0][1] - best.z) < 90).length;
    if (nBuild < 6) { log('Poucas construções mapeadas, tentando outro ponto…'); continue; }

    // the region is larger than a tile: load it like a picked point (all tiles around)
    const [slon, slat] = tileProj.toLonLat(best.x, best.z);
    const site = await siteAt(slat, slon, log);
    return { ...site, cityKey, city: city.name, picked: undefined };
  }
  throw new Error('Não foi possível encontrar um local com ruas e construções.');
}

// ---------------------------------------------------------------- explicit location
function cityFor(lat, lon) {
  for (const [key, c] of Object.entries(CITIES)) {
    for (const b of c.boxes) if (lat >= b[0] - 0.05 && lat <= b[2] + 0.05 && lon >= b[1] - 0.05 && lon <= b[3] + 0.05) return key;
  }
  return lat < -24.5 ? 'cwb' : 'sp';
}

// join road pieces cut at tile borders back into continuous polylines
function stitchRoads(roads) {
  const key = r => r.cls + '|' + r.name + '|' + r.oneway;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3;
  const out = [];
  const pool = roads.slice();
  while (pool.length) {
    const r = pool.pop();
    let pts = r.pts.slice();
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < pool.length; i++) {
        const o = pool[i];
        if (key(o) !== key(r)) continue;
        const e = pts[pts.length - 1], b0 = pts[0], os = o.pts[0], oe = o.pts[o.pts.length - 1];
        if (near(e, os)) pts = pts.concat(o.pts.slice(1));
        else if (near(oe, b0)) pts = o.pts.concat(pts.slice(1));
        else if (!r.oneway && near(e, oe)) pts = pts.concat(o.pts.slice(0, -1).reverse());
        else if (!r.oneway && near(b0, os)) pts = o.pts.slice(1).reverse().concat(pts);
        else continue;
        pool.splice(i, 1);
        merged = true;
        break;
      }
    }
    out.push({ ...r, pts });
  }
  return out;
}

// building parts cut by tile borders are unioned back by id
function mergeBuildings(list) {
  const byId = new Map(), out = [];
  for (const b of list) {
    if (b.id === undefined || b.id === null) { out.push(b); continue; }
    if (!byId.has(b.id)) byId.set(b.id, []);
    byId.get(b.id).push(b);
  }
  for (const parts of byId.values()) {
    if (parts.length === 1) { out.push(parts[0]); continue; }
    let reg = new Region();
    for (const p of parts) reg = reg.union(Region.fromRings(p.rings));
    for (const ex of reg.expolys()) out.push({ ...parts[0], rings: [ex.outer, ...ex.holes] });
  }
  return out;
}

// Loads everything around an arbitrary point (any tile layout), then re-centres on the
// nearest street so the camera has a frontage to mount on.
export async function siteAt(lat, lon, log = () => {}) {
  const radius = GEN ? GEN_RADIUS : SITE_RADIUS;
  const span = radius + 140;
  let proj = makeProjection(lat, lon);
  const [lonA, latA] = proj.toLonLat(-span, span);
  const [lonB, latB] = proj.toLonLat(span, -span);
  const [x0, y0] = lonLatToTile(lonA, latA, Z);
  const [x1, y1] = lonLatToTile(lonB, latB, Z);
  const jobs = [];
  for (let tx = Math.floor(Math.min(x0, x1)); tx <= Math.floor(Math.max(x0, x1)); tx++) {
    for (let ty = Math.floor(Math.min(y0, y1)); ty <= Math.floor(Math.max(y0, y1)); ty++) {
      jobs.push(fetchVectorTile(tx, ty).then(tile => ({ tile, tx, ty })));
    }
  }
  // relief tiles download alongside the vector tiles (wide enough for the street snap)
  for (const [tx, ty] of terrainTileRange(proj, radius + 200)) terrainTile(tx, ty).catch(() => {});
  log(`Buscando dados do mapa (${jobs.length} tiles)…`);
  const tiles = await Promise.all(jobs);
  const parseAll = (pj) => {
    const acc = { roads: [], buildings: [], structures: [], housenums: [], stops: [], landuse: [], pois: [] };
    for (const { tile, tx, ty } of tiles) {
      const d = parseTile(tile, tx, ty, pj, span, true);
      for (const k of Object.keys(acc)) acc[k].push(...d[k]);
    }
    acc.roads = stitchRoads(acc.roads);
    acc.buildings = mergeBuildings(acc.buildings);
    return acc;
  };
  let data = parseAll(proj);
  // snap to the nearest street
  let best = null;
  for (const road of data.roads) {
    if (!DRIVABLE.has(road.cls) || road.cls === 'service') continue;
    for (let i = 0; i < road.pts.length - 1; i++) {
      const [d, x, z] = distToSeg(0, 0, road.pts[i], road.pts[i + 1]);
      const score = d + (SITE_CLASSES.has(road.cls) ? 0 : 15);
      if (!best || score < best.score) best = { score, d, x, z, road };
    }
  }
  if (!best || best.d > 150) throw new Error('Nenhuma rua perto do ponto escolhido.');
  const [slon, slat] = proj.toLonLat(best.x, best.z);
  proj = makeProjection(slat, slon);
  data = parseAll(proj);
  const inR = ([x, z]) => Math.abs(x) < radius && Math.abs(z) < radius;
  data.roads = data.roads.filter(r => r.pts.some(inR));
  data.buildings = data.buildings.filter(b => b.rings[0].some(inR));
  log('Carregando relevo…');
  let elevation;
  try { elevation = await loadElevation(proj, radius + 20); } catch (e) {
    log('Sem dados de relevo: ' + e.message);
    elevation = { base: 800, sample: () => 0 };
  }
  const cityKey = cityFor(slat, slon);
  return { cityKey, city: CITIES[cityKey].name, lat: slat, lon: slon, radius, proj, elevation, roadName: best.road.name, picked: [lat, lon], ...data };
}
