// Skinned RenderWare models (GTA San Andreas peds): what src/vehicles/rw.js does
// not read. Pure JS, no three.js.
//  - HAnim plugin (0x11E) in a frame's extension: the bone id of the frame; the
//    root bone also lists the whole hierarchy (bone id, index, flags) in the
//    order the skin's indices and matrices use.
//  - Skin plugin (0x116) in the geometry's extension: per vertex four bone
//    indices and weights, and each bone's inverse bind matrix.

const CH = { STRUCT: 0x01, EXTENSION: 0x03, FRAMELIST: 0x0e, GEOMETRY: 0x0f, CLUMP: 0x10, GEOMLIST: 0x1a, SKIN: 0x116, HANIM: 0x11e };

function* chunks(dv, start, size) {
  let o = start;
  while (o + 12 <= start + size) {
    const type = dv.getUint32(o, true), sz = dv.getUint32(o + 4, true);
    yield { type, size: sz, start: o + 12 };
    o += 12 + sz;
  }
}

// -> { boneIds: [frame index -> bone id or -1], hierarchy: [{ id, index, flags }],
//      skins: [per geometry: { numBones, indices: Uint8Array(4n), weights: Float32Array(4n),
//      inverse: [Float32Array(16) per bone, RW row-major: right, up, at, pos] } | null] }
export function parseSkinning(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const clump = [...chunks(dv, 0, u8.byteLength)].find(c => c.type === CH.CLUMP);
  if (!clump) throw new Error('DFF sem clump');
  const out = { boneIds: [], hierarchy: null, skins: [] };
  for (const c of chunks(dv, clump.start, clump.size)) {
    if (c.type === CH.FRAMELIST) {
      let i = 0;
      for (const k of chunks(dv, c.start, c.size)) {
        if (k.type !== CH.EXTENSION) continue;
        out.boneIds[i] = -1;
        for (const e of chunks(dv, k.start, k.size)) {
          if (e.type !== CH.HANIM) continue;
          let o = e.start + 4;                  // version
          out.boneIds[i] = dv.getInt32(o, true);
          const n = dv.getUint32(o + 4, true);
          o += 8;
          if (n > 0) {
            o += 8;                             // flags, key frame size
            const h = [];
            for (let b = 0; b < n; b++, o += 12) h.push({ id: dv.getInt32(o, true), index: dv.getInt32(o + 4, true), flags: dv.getUint32(o + 8, true) });
            out.hierarchy = h;
          }
        }
        i++;
      }
    } else if (c.type === CH.GEOMLIST) {
      for (const g of chunks(dv, c.start, c.size)) {
        if (g.type !== CH.GEOMETRY) continue;
        const st = [...chunks(dv, g.start, g.size)].find(k => k.type === CH.STRUCT);
        const nVert = dv.getUint32(st.start + 8, true);
        const ext = [...chunks(dv, g.start, g.size)].find(k => k.type === CH.EXTENSION);
        let skin = null;
        if (ext) for (const e of chunks(dv, ext.start, ext.size)) if (e.type === CH.SKIN) skin = readSkin(dv, u8, e.start, nVert);
        out.skins.push(skin);
      }
    }
  }
  return out;
}

function readSkin(dv, u8, o, nVert) {
  const numBones = u8[o], numUsed = u8[o + 1];
  o += 4 + numUsed;
  const indices = u8.slice(o, o + nVert * 4);
  o += nVert * 4;
  const weights = new Float32Array(nVert * 4);
  for (let i = 0; i < nVert * 4; i++, o += 4) weights[i] = dv.getFloat32(o, true);
  const inverse = [];
  for (let b = 0; b < numBones; b++) {
    if (!numUsed && dv.getUint32(o, true) === 0xdeaddead) o += 4;   // pre-3.6 files
    const m = new Float32Array(16);
    for (let k = 0; k < 16; k++, o += 4) m[k] = dv.getFloat32(o, true);
    inverse.push(m);
  }
  return { numBones, indices, weights, inverse };
}
