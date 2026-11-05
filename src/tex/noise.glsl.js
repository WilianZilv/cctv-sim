// Tileable noise toolkit used by the texture baker. All functions take an integer
// period so the baked tiles wrap seamlessly.
export const NOISE = /* glsl */ `
uniform float uSeed;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx + uSeed * 0.1731) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx + uSeed * 0.1731) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx + uSeed * 0.1731) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(mod(i, per));
  float b = hash12(mod(i + vec2(1, 0), per));
  float c = hash12(mod(i + vec2(0, 1), per));
  float d = hash12(mod(i + vec2(1, 1), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(mod(i, per)) * 2.0 - 1.0;
  vec2 gb = hash22(mod(i + vec2(1, 0), per)) * 2.0 - 1.0;
  vec2 gc = hash22(mod(i + vec2(0, 1), per)) * 2.0 - 1.0;
  vec2 gd = hash22(mod(i + vec2(1, 1), per)) * 2.0 - 1.0;
  float a = dot(ga, f), b = dot(gb, f - vec2(1, 0)), c = dot(gc, f - vec2(0, 1)), d = dot(gd, f - vec2(1, 1));
  return 0.5 + 0.7 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, per);
    n += a;
    p = p * 2.0; per = per * 2.0; a *= 0.5;
  }
  return s / n;
}

// ridged fbm for crack-like structures
float rfbm(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * (1.0 - abs(gnoise(p, per) * 2.0 - 1.0));
    n += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / n;
}

// Periodic voronoi. Returns F1, F2, border distance (exact), cell hash.
// Also writes cell center offset.
vec4 voronoi(vec2 p, vec2 per, float jit, out vec2 cellId, out vec2 toC) {
  vec2 n = floor(p), f = fract(p);
  vec2 mg, mr;
  float F1 = 8.0, F2 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j);
    vec2 o = hash22(mod(n + g, per)) * jit + (1.0 - jit) * 0.5;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; mr = r; mg = g; }
    else if (d < F2) F2 = d;
  }
  float md = 8.0;
  for (int j = -2; j <= 2; j++)
  for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(i, j);
    vec2 o = hash22(mod(n + g, per)) * jit + (1.0 - jit) * 0.5;
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  cellId = mod(n + mg, per);
  toC = mr;
  return vec4(sqrt(F1), sqrt(F2), md, hash12(cellId + 7.13));
}

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
vec3 hex(float h) {
  return srgb(vec3(floor(h / 65536.0), mod(floor(h / 256.0), 256.0), mod(h, 256.0)) / 255.0);
}

// rounded-box distance in a cell; returns distance to the nearest edge (0 at edge)
float boxEdge(vec2 q, vec2 hb) {
  vec2 d = hb - abs(q);
  return min(d.x, d.y);
}
`;
