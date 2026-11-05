// Seeded 2D value noise for geometry imperfections (road undulation, uneven
// sidewalks, bowed walls). Smooth, cheap, deterministic per seed.
export function makeNoise(seed = 1) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) vals[i] = rnd() * 2 - 1;
  const fade = t => t * t * (3 - 2 * t);
  const v = (x, y) => vals[perm[(perm[x & 255] + y) & 511]];
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), w = fade(yf);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * w;
  }
  function fbm(x, y, oct = 3) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { sum += amp * noise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm; // roughly -1..1
  }
  return { noise, fbm };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
