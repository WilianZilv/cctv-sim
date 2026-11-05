// GTA San Andreas animation packages (.ifp, "ANP3"). Pure JS, no three.js, so the
// extractor in tools/ uses it too.
//
//   "ANP3", u32 size, char[24] package name, u32 animation count
//   per animation: char[24] name, u32 object count, u32 frame data size, u32 compressed
//   per object:    char[24] bone name, u32 frame type, u32 frame count, i32 bone id
//   frame type 1/3: rotation only, 2/4: rotation and translation
//   compressed frames (int16): qx qy qz qw (/4096), time (/60 s)[, tx ty tz (/1024)]
//   uncompressed: the same as float32, time in seconds
// Rotations are in the same convention as the frame matrices of the DFF (columns
// right, up, at), local to the parent bone; translations too.

const dec = (u8, o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = u8[o + i]; if (!c) break; s += String.fromCharCode(c); } return s; };

// -> { name, anims: [{ name, start, end, objects: [{ name, boneId, times, rot, trans }] }] }
// rot: Float32Array of x,y,z,w per frame; trans: Float32Array of x,y,z or null.
// start/end: byte range of the animation in the file (to copy it elsewhere).
export function parseIFP(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dec(u8, 0, 4);
  if (magic !== 'ANP3') throw new Error('IFP não suportado: ' + magic);
  const pkg = dec(u8, 8, 24);
  const n = dv.getUint32(32, true);
  let o = 36;
  const anims = [];
  for (let a = 0; a < n; a++) {
    const start = o;
    const name = dec(u8, o, 24);
    const nObj = dv.getUint32(o + 24, true), packed = dv.getUint32(o + 32, true) === 1;
    o += 36;
    const objects = [];
    for (let k = 0; k < nObj; k++) {
      const bname = dec(u8, o, 24);
      const type = dv.getUint32(o + 24, true), nf = dv.getUint32(o + 28, true), boneId = dv.getInt32(o + 32, true);
      o += 36;
      const times = new Float32Array(nf), rot = new Float32Array(nf * 4);
      const trans = type === 2 || type === 4 ? new Float32Array(nf * 3) : null;
      for (let f = 0; f < nf; f++) {
        let qx, qy, qz, qw, t;
        if (packed) {
          qx = dv.getInt16(o, true) / 4096; qy = dv.getInt16(o + 2, true) / 4096; qz = dv.getInt16(o + 4, true) / 4096; qw = dv.getInt16(o + 6, true) / 4096;
          t = dv.getInt16(o + 8, true) / 60;
          o += 10;
          if (trans) { trans[f * 3] = dv.getInt16(o, true) / 1024; trans[f * 3 + 1] = dv.getInt16(o + 2, true) / 1024; trans[f * 3 + 2] = dv.getInt16(o + 4, true) / 1024; o += 6; }
        } else {
          qx = dv.getFloat32(o, true); qy = dv.getFloat32(o + 4, true); qz = dv.getFloat32(o + 8, true); qw = dv.getFloat32(o + 12, true);
          t = dv.getFloat32(o + 16, true);
          o += 20;
          if (trans) { trans[f * 3] = dv.getFloat32(o, true); trans[f * 3 + 1] = dv.getFloat32(o + 4, true); trans[f * 3 + 2] = dv.getFloat32(o + 8, true); o += 12; }
        }
        const l = Math.hypot(qx, qy, qz, qw) || 1;
        rot[f * 4] = qx / l; rot[f * 4 + 1] = qy / l; rot[f * 4 + 2] = qz / l; rot[f * 4 + 3] = qw / l;
        times[f] = t;
      }
      objects.push({ name: bname, boneId, times, rot, trans });
    }
    anims.push({ name, start, end: o, objects });
  }
  return { name: pkg, anims };
}

// a new ANP3 package holding some animations of another (raw byte copies); an
// animation carrying its own .buf (parsed from another file) is copied from that one
export function sliceIFP(buf, anims, name = 'ped') {
  const view = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const u8 = buf ? view(buf) : null;
  const body = anims.reduce((s, a) => s + (a.end - a.start), 0);
  const out = new Uint8Array(36 + body);
  const dv = new DataView(out.buffer);
  out.set([65, 78, 80, 51]);          // ANP3
  dv.setUint32(4, out.length - 8, true);
  for (let i = 0; i < Math.min(23, name.length); i++) out[8 + i] = name.charCodeAt(i);
  dv.setUint32(32, anims.length, true);
  let o = 36;
  for (const a of anims) { out.set((a.buf ? view(a.buf) : u8).subarray(a.start, a.end), o); o += a.end - a.start; }
  return out;
}
