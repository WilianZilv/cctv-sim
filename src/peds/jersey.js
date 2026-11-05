// Football shirts painted over a ped's own texture (Flamengo: red and black hoops).
// The shirt is found by the skeleton, not by the texture layout, so it works on any
// ped: texels of triangles skinned to the spine and clavicles are the shirt; on the
// pelvis and upper arms only those whose colour is closer to the chest than to the
// legs / hands (waistband and bare arms stay as they were). Each shirt texel is
// coloured by its height on the body, in the bind pose, so the hoops run level
// around the torso whatever the UVs, and keeps the original's light and folds.
//
// Bind pose of the SA peds: +x up (feet -1, head 0.85), +y forward, +z the ped's left.

const SHIRT = new Set([2, 3, 21, 31]);         // spine, spine1, clavicles
const MAYBE = { 1: 41, 22: 24, 32: 34 };       // pelvis vs thigh, upper arm vs hand

export const KITS = {
  flamengo: {
    hoops: [[0.72, 0.04, 0.07], [0.035, 0.03, 0.03]],    // red, black (linear-ish, sRGB 0..1)
    hoop: 0.065,                                           // m per hoop
    collar: [0.035, 0.03, 0.03],
    crest: true,
  },
};

const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const median = (arr) => {
  if (!arr.length) return null;
  const out = [];
  for (let k = 0; k < 3; k++) { const s = arr.map(c => c[k]).sort((a, b) => a - b); out.push(s[s.length >> 1]); }
  return out;
};

// g: parsed geometry, sk: its skin, ids: hierarchy bone ids, index: triangle list
// (the body material's), img: { rgba, width, height } -> new Uint8Array rgba
export function paintKit(g, sk, ids, index, img, kit) {
  const { width: W, height: H } = img;
  const src = img.rgba, out = new Uint8Array(src);
  const uv = g.uvs[0];
  if (!uv) return out;
  const bone = new Int32Array(g.nVert);
  for (let v = 0; v < g.nVert; v++) {
    let b = 0;
    for (let k = 1; k < 4; k++) if (sk.weights[v * 4 + k] > sk.weights[v * 4 + b]) b = k;
    bone[v] = ids[sk.indices[v * 4 + b]];
  }
  const texel = (x, y) => { const o = (((y % H) + H) % H * W + ((x % W) + W) % W) * 4; return [src[o] / 255, src[o + 1] / 255, src[o + 2] / 255]; };

  // walk the texels of every triangle of the given bones: fn(x, y, pos)
  const raster = (want, fn) => {
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i], b = index[i + 1], c = index[i + 2];
      if (!want(bone[a], bone[b], bone[c])) continue;
      const ax = uv[a * 2] * W, ay = uv[a * 2 + 1] * H, bx = uv[b * 2] * W, by = uv[b * 2 + 1] * H, cx = uv[c * 2] * W, cy = uv[c * 2 + 1] * H;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-9) continue;
      const x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx));
      const y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        // texel centre, with half a texel of slack so seams get covered
        let best = null;
        for (const [ox, oy] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) {
          const px = x + ox, py = y + oy;
          const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
          const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4) { best = [w0, w1, w2]; break; }
        }
        if (!best) continue;
        const p = [0, 1, 2].map(k => best[0] * g.pos[a * 3 + k] + best[1] * g.pos[b * 3 + k] + best[2] * g.pos[c * 3 + k]);
        fn(x, y, p);
      }
    }
  };
  const sample = (id) => { const s = []; raster((p, q, r) => p === id && q === id && r === id, (x, y) => s.push(texel(x, y))); return median(s); };
  const chest = sample(3);
  if (!chest) return out;
  const ref = {};
  for (const [b, other] of Object.entries(MAYBE)) ref[b] = sample(other);

  // neck line: the top of the chest bone's skin, the collar sits just under it
  let top = -Infinity;
  for (let v = 0; v < g.nVert; v++) if (bone[v] === 3) top = Math.max(top, g.pos[v * 3]);
  const chestL = Math.max(0.08, lum(chest));

  raster((p, q, r) => [p, q, r].some(id => SHIRT.has(id) || id in MAYBE), (x, y, pos) => {
    const t = texel(x, y);
    // whichever bone this texel's triangle mostly belongs to was not passed: decide
    // from the colour where the shirt can end (waist, sleeves)
    const h = pos[0], fwd = pos[1], side = pos[2];
    for (const b of Object.keys(MAYBE)) {
      if (!ref[b]) continue;
      // texels near that bone's region: lower than the chest (pelvis) or out on the arm
      const inPelvis = b === '1' && h < 0.12, inArm = b !== '1' && Math.abs(side) > 0.2 && h < top - 0.05;
      if ((inPelvis || inArm) && dist2(t, chest) > dist2(t, ref[b]) * 0.8) return;
    }
    let col;
    if (h > top - 0.035) col = kit.collar;
    else {
      const k = Math.floor((top - h) / kit.hoop);
      col = kit.hoops[k % kit.hoops.length];
      // crest on the left chest: a small white-edged shield
      if (kit.crest && fwd > 0.04 && side > 0.04 && side < 0.11 && h < top - 0.06 && h > top - 0.15) {
        const cx = side - 0.075, cy = h - (top - 0.1);
        const inShield = Math.abs(cx) < 0.032 - Math.max(0, -cy) * 0.4 && cy < 0.04;
        if (inShield) col = Math.abs(cx) > 0.022 - Math.max(0, -cy) * 0.4 || cy > 0.03 ? [0.85, 0.85, 0.82] : col;
      }
    }
    // the original's folds and light, as a ratio to the chest's own tone
    // (softened: a printed shirt underneath must not show through)
    const s = Math.min(1.2, Math.max(0.7, 1 + (lum(t) / chestL - 1) * 0.4));
    const o = (((y % H) + H) % H * W + ((x % W) + W) % W) * 4;
    for (let k = 0; k < 3; k++) out[o + k] = Math.min(255, Math.round(col[k] * s * 255));
  });
  return out;
}
