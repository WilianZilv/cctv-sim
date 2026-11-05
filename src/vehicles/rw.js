// RenderWare (GTA San Andreas, PC) readers: .dff models and .txd texture
// dictionaries. Pure JS, no three.js, so it also runs in Node for inspection.
//
// Every RW file is a tree of chunks: u32 type, u32 size, u32 library version,
// then `size` bytes of payload (a Struct chunk first, then children).

const CH = {
  STRUCT: 0x01, STRING: 0x02, EXTENSION: 0x03, TEXTURE: 0x06, MATERIAL: 0x07, MATLIST: 0x08,
  FRAMELIST: 0x0e, GEOMETRY: 0x0f, CLUMP: 0x10, ATOMIC: 0x14, TEXNATIVE: 0x15, TEXDICT: 0x16,
  GEOMLIST: 0x1a, BINMESH: 0x50e, FRAME_NAME: 0x253f2fe,
};

class Reader {
  constructor(buf, off = 0, end = buf.byteLength) {
    this.dv = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    this.u8a = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    this.o = off; this.end = end;
  }
  u8() { return this.dv.getUint8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  str(n) {
    let s = '';
    for (let i = 0; i < n; i++) { const c = this.u8a[this.o + i]; if (!c) break; s += String.fromCharCode(c); }
    this.o += n;
    return s;
  }
  bytes(n) { const b = this.u8a.subarray(this.o, this.o + n); this.o += n; return b; }
  header() { return { type: this.u32(), size: this.u32(), ver: this.u32(), start: this.o + 0 }; }
  // children of a chunk whose payload spans [start, start + size)
  *chunks(start, size) {
    let o = start;
    while (o + 12 <= start + size) {
      this.o = o;
      const h = this.header();
      h.start = this.o;
      yield h;
      o = h.start + h.size;
    }
  }
}

// ---------------------------------------------------------------- DFF
export function parseDFF(buf) {
  const r = new Reader(buf);
  const top = [...r.chunks(0, buf.byteLength)].find(c => c.type === CH.CLUMP);
  if (!top) throw new Error('DFF sem clump');
  const out = { frames: [], geometries: [], atomics: [] };
  for (const c of [...r.chunks(top.start, top.size)]) {
    if (c.type === CH.FRAMELIST) readFrames(r, c, out.frames);
    else if (c.type === CH.GEOMLIST) readGeometries(r, c, out.geometries);
    else if (c.type === CH.ATOMIC) {
      const st = [...r.chunks(c.start, c.size)].find(k => k.type === CH.STRUCT);
      r.o = st.start;
      out.atomics.push({ frame: r.u32(), geometry: r.u32(), flags: r.u32() });
    }
  }
  return out;
}

function readFrames(r, c, frames) {
  const kids = [...r.chunks(c.start, c.size)];
  const st = kids[0];
  r.o = st.start;
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const rot = []; for (let k = 0; k < 9; k++) rot.push(r.f32());
    const pos = [r.f32(), r.f32(), r.f32()];
    const parent = r.i32();
    r.u32();
    frames.push({ rot, pos, parent, name: '' });
  }
  // one extension per frame carries its name
  const exts = kids.filter(k => k.type === CH.EXTENSION);
  exts.forEach((e, i) => {
    for (const k of r.chunks(e.start, e.size)) if (k.type === CH.FRAME_NAME && frames[i]) { r.o = k.start; frames[i].name = r.str(k.size); }
  });
}

function readGeometries(r, c, list) {
  for (const g of [...r.chunks(c.start, c.size)]) if (g.type === CH.GEOMETRY) list.push(readGeometry(r, g));
}

function readGeometry(r, c) {
  const kids = [...r.chunks(c.start, c.size)];
  const st = kids.find(k => k.type === CH.STRUCT);
  r.o = st.start;
  const flags = r.u32();
  const nTri = r.u32(), nVert = r.u32(), nMorph = r.u32();
  if (c.ver < 0x34000 && (c.ver & 0xffff0000) < 0x34000) { /* SA is 3.6: no surface props */ }
  const native = (flags & 0x01000000) !== 0;
  let nTex = (flags >> 16) & 0xff;
  if (!nTex) nTex = flags & 0x80 ? 2 : flags & 0x04 ? 1 : 0;
  const g = { flags, nVert, colors: null, uvs: [], tris: [], pos: null, normals: null, materials: [], meshes: null };
  if (!native) {
    if (flags & 0x08) { g.colors = new Uint8Array(r.bytes(nVert * 4)); }
    for (let t = 0; t < nTex; t++) { const uv = new Float32Array(nVert * 2); for (let i = 0; i < nVert * 2; i++) uv[i] = r.f32(); g.uvs.push(uv); }
    for (let i = 0; i < nTri; i++) { const b = r.u16(), a = r.u16(), m = r.u16(), cc = r.u16(); g.tris.push(a, b, cc, m); }
  }
  for (let m = 0; m < Math.max(1, nMorph); m++) {
    r.f32(); r.f32(); r.f32(); r.f32(); // bounding sphere
    const hasV = r.u32(), hasN = r.u32();
    if (m > 0) break;
    if (hasV) { g.pos = new Float32Array(nVert * 3); for (let i = 0; i < nVert * 3; i++) g.pos[i] = r.f32(); }
    if (hasN) { g.normals = new Float32Array(nVert * 3); for (let i = 0; i < nVert * 3; i++) g.normals[i] = r.f32(); }
  }
  const ml = kids.find(k => k.type === CH.MATLIST);
  if (ml) g.materials = readMaterials(r, ml);
  const ext = kids.find(k => k.type === CH.EXTENSION);
  if (ext) {
    for (const k of r.chunks(ext.start, ext.size)) if (k.type === CH.BINMESH) g.meshes = readBinMesh(r, k);
  }
  return g;
}

function readMaterials(r, c) {
  const kids = [...r.chunks(c.start, c.size)];
  r.o = kids[0].start;
  const n = r.u32();
  const idx = []; for (let i = 0; i < n; i++) idx.push(r.i32());
  const unique = kids.filter(k => k.type === CH.MATERIAL).map(k => readMaterial(r, k));
  let u = 0;
  return idx.map(i => (i < 0 ? unique[u++] : unique[i]));
}

function readMaterial(r, c) {
  const kids = [...r.chunks(c.start, c.size)];
  r.o = kids[0].start;
  r.u32();
  const color = [r.u8(), r.u8(), r.u8(), r.u8()];
  r.u32();
  const textured = r.u32();
  const m = { color, texture: null, mask: null };
  if (textured) {
    const t = kids.find(k => k.type === CH.TEXTURE);
    if (t) {
      const strs = [...r.chunks(t.start, t.size)].filter(k => k.type === CH.STRING);
      if (strs[0]) { r.o = strs[0].start; m.texture = r.str(strs[0].size).toLowerCase(); }
      if (strs[1]) { r.o = strs[1].start; m.mask = r.str(strs[1].size).toLowerCase(); }
    }
  }
  return m;
}

// triangle strips/lists per material (used when the geometry has no triangle list)
function readBinMesh(r, c) {
  r.o = c.start;
  const strip = r.u32() === 1;
  const n = r.u32();
  r.u32();
  const meshes = [];
  for (let i = 0; i < n; i++) {
    const cnt = r.u32(), mat = r.u32();
    const idx = new Uint32Array(cnt);
    for (let k = 0; k < cnt; k++) idx[k] = r.u32();
    meshes.push({ mat, idx, strip });
  }
  return meshes;
}

// ---------------------------------------------------------------- TXD
// returns Map name -> { width, height, rgba (Uint8Array, top row first), alpha }
export function parseTXD(buf) {
  const r = new Reader(buf);
  const top = [...r.chunks(0, buf.byteLength)].find(c => c.type === CH.TEXDICT);
  if (!top) throw new Error('TXD sem dicionário');
  const out = new Map();
  for (const c of [...r.chunks(top.start, top.size)]) {
    if (c.type !== CH.TEXNATIVE) continue;
    const st = [...r.chunks(c.start, c.size)].find(k => k.type === CH.STRUCT);
    try {
      const t = readNative(r, st);
      if (t) out.set(t.name.toLowerCase(), t);
    } catch (e) { /* unsupported raster: skip */ }
  }
  return out;
}

function readNative(r, st) {
  r.o = st.start;
  const platform = r.u32();
  if (platform !== 8 && platform !== 9) return null;
  r.u8(); r.u8(); r.u16();
  const name = r.str(32), mask = r.str(32);
  const rasterFormat = r.u32();
  const fourcc = r.u32(); // D3D9: format / FourCC; D3D8: hasAlpha
  const width = r.u16(), height = r.u16();
  r.u8(); // depth
  const levels = r.u8();
  r.u8(); // raster type
  const extra = r.u8(); // D3D8: DXT number; D3D9: flags
  let dxt = 0;
  if (platform === 8) dxt = extra;
  else if (extra & 0x08) dxt = { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 }[fourcc] || 0;
  const fmt = rasterFormat & 0xf00;
  let palette = null;
  if (rasterFormat & 0x2000) palette = r.bytes(256 * 4);
  else if (rasterFormat & 0x4000) palette = r.bytes(32 * 4);
  const size = r.u32();
  const data = r.bytes(size);
  let rgba;
  if (dxt === 1) rgba = decodeDXT1(data, width, height);
  else if (dxt === 3) rgba = decodeDXT3(data, width, height);
  else if (dxt === 5) rgba = decodeDXT5(data, width, height);
  else if (palette) {
    rgba = new Uint8Array(width * height * 4);
    const four = rasterFormat & 0x4000;
    for (let i = 0; i < width * height; i++) {
      const p = four ? (data[i >> 1] >> ((i & 1) * 4)) & 15 : data[i];
      rgba.set(palette.subarray(p * 4, p * 4 + 4), i * 4);
    }
  } else if (fmt === 0x500 || fmt === 0x600) {
    // B, G, R, A
    rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = data[i * 4 + 2]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4];
      rgba[i * 4 + 3] = fmt === 0x600 ? 255 : data[i * 4 + 3];
    }
  } else if (fmt === 0x100 || fmt === 0x200 || fmt === 0x300 || fmt === 0xa00) {
    rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = data[i * 2] | (data[i * 2 + 1] << 8);
      let R, G, B, A = 255;
      if (fmt === 0x200) { R = (v >> 11) & 31; G = (v >> 5) & 63; B = v & 31; R = R * 255 / 31; G = G * 255 / 63; B = B * 255 / 31; }
      else if (fmt === 0x300) { A = ((v >> 12) & 15) * 17; R = ((v >> 8) & 15) * 17; G = ((v >> 4) & 15) * 17; B = (v & 15) * 17; }
      else { A = fmt === 0x100 ? (v >> 15) * 255 : 255; R = ((v >> 10) & 31) * 255 / 31; G = ((v >> 5) & 31) * 255 / 31; B = (v & 31) * 255 / 31; }
      rgba[i * 4] = R; rgba[i * 4 + 1] = G; rgba[i * 4 + 2] = B; rgba[i * 4 + 3] = A;
    }
  } else return null;
  let alpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) { alpha = true; break; }
  return { name, mask, width, height, rgba, alpha, levels };
}

function rgb565(c) { return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31]; }
function colorBlock(data, o, out, w, h, bx, by, dxt1, alphaFn) {
  const c0 = data[o] | (data[o + 1] << 8), c1 = data[o + 2] | (data[o + 3] << 8);
  const a = rgb565(c0), b = rgb565(c1);
  const pal = [a, b];
  if (c0 > c1 || !dxt1) { pal.push(a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)); }
  else { pal.push(a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]); }
  const bits = data[o + 4] | (data[o + 5] << 8) | (data[o + 6] << 16) | (data[o + 7] << 24);
  for (let p = 0; p < 16; p++) {
    const x = bx + (p & 3), y = by + (p >> 2);
    if (x >= w || y >= h) continue;
    const s = (bits >>> (p * 2)) & 3;
    const i = (y * w + x) * 4;
    out[i] = pal[s][0]; out[i + 1] = pal[s][1]; out[i + 2] = pal[s][2];
    out[i + 3] = alphaFn ? alphaFn(p) : (dxt1 && c0 <= c1 && s === 3 ? 0 : 255);
  }
}
function decodeDXT1(d, w, h) {
  const out = new Uint8Array(w * h * 4);
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) { colorBlock(d, o, out, w, h, bx, by, true); o += 8; }
  return out;
}
function decodeDXT3(d, w, h) {
  const out = new Uint8Array(w * h * 4);
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    const ao = o;
    colorBlock(d, o + 8, out, w, h, bx, by, false, (p) => ((d[ao + (p >> 1)] >> ((p & 1) * 4)) & 15) * 17);
    o += 16;
  }
  return out;
}
function decodeDXT5(d, w, h) {
  const out = new Uint8Array(w * h * 4);
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    const a0 = d[o], a1 = d[o + 1];
    const pal = [a0, a1];
    if (a0 > a1) for (let k = 1; k < 7; k++) pal.push(((7 - k) * a0 + k * a1) / 7);
    else { for (let k = 1; k < 5; k++) pal.push(((5 - k) * a0 + k * a1) / 5); pal.push(0, 255); }
    // 48 bits of 3-bit indices
    let lo = d[o + 2] | (d[o + 3] << 8) | (d[o + 4] << 16), hi = d[o + 5] | (d[o + 6] << 8) | (d[o + 7] << 16);
    const idx = (p) => (p < 8 ? (lo >> (p * 3)) & 7 : (hi >> ((p - 8) * 3)) & 7);
    colorBlock(d, o + 8, out, w, h, bx, by, false, (p) => pal[idx(p)]);
    o += 16;
  }
  return out;
}

// ---------------------------------------------------------------- carcols.dat
// palette of the 'col' section: index -> [r, g, b, metallic] (metallic from the
// colour's name in the comment: poly, metallic, mica, pearl)
export function parseCarcols(text) {
  const cols = [];
  let inCol = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (line === 'col') { inCol = true; continue; }
    if (line === 'end') { if (inCol) break; continue; }
    if (inCol) {
      const m = line.match(/(\d+)[\s,.]+(\d+)[\s,.]+(\d+)/);
      if (m) cols.push([+m[1], +m[2], +m[3], /poly|metal|mica|pearl/i.test(raw) ? 1 : 0]);
    }
  }
  return cols;
}
// per-vehicle colour pairs from a vehicle's carcols line: "name, a,b, c,d, ..."
export function parseColorPairs(line) {
  const nums = line.split(',').slice(1).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}
