// Vehicle condition in the shared surface shader (matlib patch(), opts.wear):
// dents, dust, mud, scratches, crash scrapes, rust, sun fade and fire damage,
// all in the car's own space (root-local: origin on the ground under the car's
// centre, y up, -Z forward) so nothing swims on a moving car. Every material of
// one car shares one uniforms object (src/vehicles/wear.js), so all cars run the
// same few programs. uWearKind (per material): 0 paint, 1 trim / interior /
// chassis, 2 glass, 3 lamp, 4 plate, 5 wheel.

export const WEAR_VERT_DECL = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNrm;
uniform sampler2D uNoiseTex;
uniform float uWearKind;
uniform vec4 uDent[3];    // centre xyz, radius
uniform vec4 uDentN[3];   // push direction (outward surface normal), depth (0 = none)
uniform vec4 uDentP[3];   // vertical squash, scrape, crinkle, seed
`;

// after begin_vertex: dents push the body in. The displacement is a function of
// position only, so parts that touch (door, wing, glass) move together: no cracks
export const WEAR_VERT = /* glsl */ `
vCarPos = transformed;
vCarNrm = objectNormal;
if (uWearKind < 3.5) {
  for (int i = 0; i < 3; i++) {
    vec4 N = uDentN[i];
    if (N.w <= 0.0) continue;
    vec4 D = uDent[i];
    vec3 d = transformed - D.xyz;
    vec3 q = d * vec3(1.0, uDentP[i].x, 1.0);
    float s2 = dot(q, q) / (D.w * D.w);
    if (s2 < 1.0) {
      float f = (1.0 - s2) * (1.0 - s2);
      float nz = textureLod(uNoiseTex, (transformed.xz + transformed.y * 0.7) * 0.6 + uDentP[i].w, 0.0).g;
      transformed -= N.xyz * N.w * f * (0.4 + 1.2 * nz);
    }
  }
}
`;

export const WEAR_FRAG_DECL = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNrm;
uniform float uWearKind;
uniform float uWearScrape;  // torn metal of the model's damaged parts: always scraped
uniform vec4 uWear0;      // dust, mud, scratches, rust
uniform vec4 uWear1;      // burnt, scrape, seed, sun fade
uniform vec4 uWear2;      // fire origin z, fire spread, mud height, plate grime
uniform vec3 uDustCol;
uniform vec3 uMudCol;
uniform vec4 uWheels;     // half track, front axle z, rear axle z, wheel radius
uniform vec4 uDent[3];
uniform vec4 uDentN[3];
uniform vec4 uDentP[3];
uniform mat3 normalMatrix;
vec3 wearDentG = vec3(0.0);   // dent slope (car space), applied to the normal
float wearMatte = 0.0;        // 0..1 toward wearRough
float wearRough = 0.9;
float wearCoatLoss = 0.0;     // clear coat gone (bare, dusty, burnt)
float wearCoatHaze = 0.0;
float wearMetal = 0.0;        // bare steel showing
float wearPoro = 0.0;         // mud and dust soak up rain
float wHash(float n) { return fract(sin(n) * 43758.5453); }
// one family of thin scratches along 'q.x': a band every 'band' metres holds one
// with probability 'dens', of random length, offset and width (antialiased; a
// scratch narrower than a pixel fades instead of flickering)
float wScratch(vec2 q, float band, float dens, float seed) {
  float id = floor(q.y / band);
  float h1 = wHash(id * 12.9898 + seed), h2 = wHash(id * 78.233 + seed * 1.7), h3 = wHash(id * 37.719 + seed * 3.1), h4 = wHash(id * 4.581 + seed * 5.3);
  if (h1 > dens) return 0.0;
  float u0 = (h3 - 0.5) * 5.0, len = 0.08 + 0.9 * h4 * h4;
  float seg = smoothstep(u0, u0 + 0.03, q.x) * (1.0 - smoothstep(u0 + len - 0.06, u0 + len, q.x));
  float cy = (id + 0.15 + 0.7 * h2) * band + 0.004 * sin(q.x * (3.0 + 6.0 * h2) + h3 * 6.28);
  float w = 0.0006 + 0.0014 * h3 * h3;
  float fw = max(fwidth(q.y), 1e-5);
  float cov = clamp((w + 0.5 * fw - abs(q.y - cy)) / fw, 0.0, 1.0) * clamp(2.0 * w / fw, 0.0, 1.0);
  return cov * seg * (0.5 + 0.5 * h4);
}
`;

// in FRAG_COLOR, after the base colour and before rain / IR
export const WEAR_FRAG_COLOR = /* glsl */ `
{
  vec3 p = vCarPos;
  vec3 cn = normalize(vCarNrm);
  float kind = uWearKind;
  bool paint = kind < 0.5, trim = kind > 0.5 && kind < 1.5, glass = kind > 1.5 && kind < 2.5;
  bool lamp = kind > 2.5 && kind < 3.5, plate = kind > 3.5 && kind < 4.5, wheel = kind > 4.5;
  float seed = uWear1.z;
  vec2 so = vec2(fract(seed * 0.37), fract(seed * 0.71)) * 7.0;
  // planar projection on the dominant axis: sides use (z, y), front / back (x, y), top (x, z)
  vec3 an = abs(cn);
  vec2 pp = an.x > an.y && an.x > an.z ? p.zy : (an.y > an.z ? p.xz : p.xy);
  float side = an.x > 0.55 ? 1.0 : 0.0;
  float upv = clamp(cn.y, 0.0, 1.0);
  float h = p.y;
  float n1 = texture2D(uNoiseTex, pp * 0.21 + so).r;          // ~0.3 m blotches
  float n2 = texture2D(uNoiseTex, pp * 0.37 + so.yx).g;       // ~0.15 m
  float n3 = texture2D(uNoiseTex, pp * 0.45 + so * 1.3).b;    // ~3 cm
  float n4 = texture2D(uNoiseTex, pp * 2.3 + so * 0.7).b;     // ~7 mm speckle
  float fbm = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;               // 0.5 +- 0.15
  vec3 base = diffuseColor.rgb;

  // ---- dents: slope of the push-in for the normal, and where the paint cracked
  float dentK = 0.0, scrapeZ = 0.0;
  if (!plate && !wheel) {
    for (int i = 0; i < 3; i++) {
      vec4 N = uDentN[i];
      if (N.w <= 0.0) continue;
      vec4 D = uDent[i];
      vec3 d = p - D.xyz;
      vec3 A = vec3(1.0, uDentP[i].x, 1.0);
      vec3 q = d * A;
      float s2 = dot(q, q) / (D.w * D.w);
      if (s2 < 1.0) {
        float g = 1.0 - s2;
        // height = depth (1 - s2)^2: its gradient tilts the normal toward the centre
        wearDentG += N.w * 4.0 * g * (d * A * A) / (D.w * D.w) * -1.0;
        // crumpled sheet in deep dents
        float cr = uDentP[i].z * g * g * N.w * 0.35;
        vec2 e = vec2(0.004, 0.0);
        float c0 = texture2D(uNoiseTex, pp * 0.5 + uDentP[i].w).g;
        float cx = texture2D(uNoiseTex, (pp + e.xy) * 0.5 + uDentP[i].w).g;
        float cy = texture2D(uNoiseTex, (pp + e.yx) * 0.5 + uDentP[i].w).g;
        vec2 cg = vec2(cx - c0, cy - c0) / 0.004 * cr;
        if (an.x > an.y && an.x > an.z) wearDentG += vec3(0.0, cg.y, cg.x);
        else if (an.y > an.z) wearDentG += vec3(cg.x, 0.0, cg.y);
        else wearDentG += vec3(cg.x, cg.y, 0.0);
        dentK = max(dentK, g * g);
        // the scrape stretches past the dent along the car (it slid along something)
        vec3 ds = d * vec3(1.0, 1.6, 0.55);
        float z = 1.0 - dot(ds, ds) / (D.w * D.w * 1.7);
        scrapeZ = max(scrapeZ, clamp(z, 0.0, 1.0) * uDentP[i].y);
      }
    }
    wearDentG -= cn * dot(wearDentG, cn);
  }

  scrapeZ = max(scrapeZ, uWearScrape * (0.75 + 0.5 * n2));
  // ---- sun fade: chalky, lighter, less saturated paint on roofs and bonnets
  if (paint && uWear1.w > 0.0) {
    float f = uWear1.w * (0.35 + 0.65 * upv) * smoothstep(0.35, 0.65, n1 * 0.7 + n2 * 0.3 + 0.1 * upv);
    float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * 1.1 + 0.05, clamp(f * 0.8, 0.0, 0.8));
    wearCoatLoss = max(wearCoatLoss, f * 0.9);
    wearMatte = max(wearMatte, f * 0.6);
  }

  // ---- scratches and scuffs: sides 0.35..1.15 m, bumper corners
  if ((paint || trim) && uWear0.z > 0.0) {
    float zone = (side * (smoothstep(0.3, 0.45, h) * (1.0 - smoothstep(1.0, 1.25, h))) + (1.0 - side) * (1.0 - upv) * (1.0 - smoothstep(0.55, 0.8, h)) * 0.7);
    zone *= 0.5 + 0.8 * smoothstep(0.4, 0.6, n1);
    float S = uWear0.z * zone;
    if (S > 0.01) {
      vec2 q = pp;
      float a1 = 0.06 + 0.1 * fract(seed * 1.3), a2 = -0.12 - 0.2 * fract(seed * 2.1);
      mat2 r1 = mat2(cos(a1), sin(a1), -sin(a1), cos(a1));
      mat2 r2 = mat2(cos(a2), sin(a2), -sin(a2), cos(a2));
      float sc = wScratch(r1 * q, 0.016, 0.35 * S, seed) + wScratch(r2 * q + 3.1, 0.021, 0.22 * S, seed + 9.0);
      // fine swirl haze: cloudy, lighter, the clear coat is chewed up
      float haze = smoothstep(0.55, 0.75, n2 * 0.6 + n3 * 0.4) * S * 0.5;
      // deep ones reach primer or steel
      float deep = step(0.6, wHash(floor((r1 * q).y / 0.016) + seed * 7.0));
      vec3 under = mix(vec3(0.62, 0.62, 0.6), mix(vec3(0.33, 0.33, 0.32), vec3(0.55, 0.55, 0.56), step(0.5, n4)), deep);
      sc = clamp(sc, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6 + 0.25, haze * 0.35);
      diffuseColor.rgb = mix(diffuseColor.rgb, under, sc * (trim ? 0.5 : 0.85));
      wearCoatHaze = max(wearCoatHaze, haze);
      wearMatte = max(wearMatte, sc * 0.7);
      wearMetal = max(wearMetal, sc * deep * 0.6);
    }
  }

  // ---- crash scrape around dents: paint scraped to primer and steel, streaked along the car
  if ((paint || trim || lamp) && scrapeZ > 0.0) {
    float streak = texture2D(uNoiseTex, vec2(pp.x * 0.12, pp.y * 1.6) + so).g;
    float m = smoothstep(0.55, 0.8, scrapeZ + (fbm - 0.5) * 1.2 + (streak - 0.5) * 0.5);
    if (m > 0.0) {
      float metal = smoothstep(0.55, 0.7, streak * 0.6 + n3 * 0.4 + (scrapeZ - 0.5) * 0.3);
      vec3 primer = mix(vec3(0.3, 0.3, 0.29), vec3(0.22, 0.225, 0.22), n2);
      vec3 steel = vec3(0.42, 0.42, 0.44) * (0.85 + 0.3 * n4);
      vec3 sc = mix(primer, steel, metal * 0.75);
      // paint torn off leaves a ragged lighter rim
      float rim = smoothstep(0.35, 0.55, scrapeZ + (fbm - 0.5) * 1.2 + (streak - 0.5) * 0.5) * (1.0 - m);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7 + 0.12, rim * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, lamp ? diffuseColor.rgb * 0.5 + 0.25 : sc, m * 0.95);
      wearCoatLoss = max(wearCoatLoss, max(m, rim));
      wearMatte = max(wearMatte, m * (1.0 - 0.5 * metal));
      wearRough = mix(wearRough, 0.55, metal * m);
      wearMetal = max(wearMetal, m * metal * 0.8);
    }
  }
  if (paint && dentK > 0.0) {
    // creased paint in the middle of a dent: cracked clear coat
    wearCoatHaze = max(wearCoatHaze, dentK * 0.7);
  }

  // ---- rust: lower edges (sills, arch lips, door bottoms), scrapes, a few
  // random spots; clustered pits with a blistered ring, not an even speckle
  if ((paint || trim) && uWear0.w > 0.0) {
    float low = 1.0 - smoothstep(0.22, 0.42 + 0.15 * n1, h);
    float zone = max(low * 0.9, scrapeZ * 0.8) + 0.45 * smoothstep(0.66, 0.76, n1);
    float field = n3 * 0.5 + n2 * 0.3 + n4 * 0.2 + zone * uWear0.w * 0.55;
    float r = smoothstep(0.68, 0.74, field);
    float halo = smoothstep(0.63, 0.68, field) * (1.0 - r);
    if (r + halo > 0.0) {
      vec3 rc = mix(vec3(0.19, 0.065, 0.025), vec3(0.32, 0.13, 0.045), n4) * (0.7 + 0.5 * n2);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.75, 0.62, 0.5), halo * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, rc, r);
      wearCoatLoss = max(wearCoatLoss, max(r, halo * 0.5));
      wearMatte = max(wearMatte, r);
      wearMetal *= 1.0 - r;
    }
  }

  // ---- dust film: settles on top surfaces and the lower body, washed into
  // vertical streaks on the sides
  float dust = 0.0;
  if (uWear0.x > 0.0) {
    float lowB = 1.0 - smoothstep(0.1, 0.9, h);
    // soft run-off streaks on the sides, ~10 cm wide and broken up
    float st = texture2D(uNoiseTex, vec2(pp.x * 0.5, h * 0.03) + so).g;
    float streak = (1.0 - upv) * (st - 0.5) * 1.4;
    float cover = 0.25 + 0.55 * upv + 0.45 * lowB;
    dust = uWear0.x * cover * clamp(1.0 + 1.4 * (n1 - 0.5) + 0.8 * (n2 - 0.5) + streak, 0.2, 1.6) * 0.8;
    float dmax = glass ? 0.45 : plate ? 0.3 * uWear2.w : lamp ? 0.5 : wheel ? 0.5 : 0.8;
    dust = min(dust, dmax);
    vec3 dc = uDustCol * (0.9 + 0.2 * n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, dc, dust);
    if (glass) diffuseColor.a = mix(diffuseColor.a, 1.0, dust * 0.6);
    wearCoatHaze = max(wearCoatHaze, dust * 1.6);
    wearMatte = max(wearMatte, dust * 0.9);
    wearPoro = max(wearPoro, dust * 0.5);
  }

  // ---- mud / earth: splashes up from the wheels, heavier behind them, around the arches and on the lower body
  if (uWear0.y > 0.0) {
    float mh = uWear2.z;
    float low = 1.0 - smoothstep(0.08, mh * (0.45 + 0.8 * n1), h);
    float arch = 0.0;
    if (an.x > 0.4) {
      float r = uWheels.w;
      float df = length(vec2(p.z - uWheels.y, h - r)), dr = length(vec2(p.z - uWheels.z, h - r));
      // behind the wheel (+z) the spray reaches farther
      float bf = smoothstep(-0.2, 0.5, p.z - uWheels.y), br = smoothstep(-0.2, 0.5, p.z - uWheels.z);
      arch = max(1.0 - smoothstep(r + 0.02, r + 0.18 + 0.3 * bf + 0.25 * n2, df), 1.0 - smoothstep(r + 0.02, r + 0.18 + 0.3 * br + 0.25 * n2, dr));
    }
    float zone = max(low, arch);
    if (wheel) zone = 0.7 + 0.3 * n1;
    // splatter: continuous at the bottom, breaking into drops above
    float spl = n4 * 0.45 + n3 * 0.35 + n2 * 0.2;
    float m = smoothstep(0.72 - 0.42 * zone * uWear0.y, 0.76 - 0.42 * zone * uWear0.y, spl) * zone;
    // tyres and rims: a film, caked where the noise says so
    if (wheel) m = uWear0.y * 0.7 * smoothstep(0.38, 0.62, fbm);
    m *= glass ? 0.4 : trim ? 0.8 : 1.0;
    if (plate) m = min(m * uWear2.w, 0.35) * step(0.62, n4);
    vec3 mc = uMudCol * (0.65 + 0.7 * n3);
    // dried edges are lighter, the middle stays dark
    mc = mix(mc, mc * 1.6 + 0.04, smoothstep(0.5, 0.8, n2) * 0.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, mc, clamp(m, 0.0, 0.95));
    if (glass) diffuseColor.a = mix(diffuseColor.a, 1.0, m);
    wearCoatLoss = max(wearCoatLoss, m);
    wearMatte = max(wearMatte, m);
    wearRough = mix(wearRough, 0.95, m);
    wearPoro = max(wearPoro, m * 0.9);
    wearMetal *= 1.0 - m;
  }

  // ---- fire: soot and charred paint, oxide where the paint burnt off, ash white
  // on the hottest panels; spreads from where it started (engine bay / cabin)
  if (uWear1.x > 0.0) {
    float reach = 1.0 - smoothstep(uWear2.y * 0.6, uWear2.y * 1.2 + 0.4, abs(p.z - uWear2.x) - 0.8 * (h - 0.6));
    float b = uWear1.x * clamp(reach + (fbm - 0.5) * 0.8, 0.0, 1.0);
    if (plate) b = min(b, 0.4);
    if (b > 0.0) {
      // soot where it burnt hardest, grey primer / ash where the paint went,
      // dull oxide brown where that rusted after the fire, in coarse patches
      vec3 soot = mix(vec3(0.012, 0.011, 0.01), vec3(0.05, 0.047, 0.044), n2);
      vec3 ash = mix(vec3(0.1, 0.097, 0.093), vec3(0.2, 0.19, 0.18), n3);
      vec3 oxide = mix(vec3(0.07, 0.04, 0.025), vec3(0.13, 0.07, 0.04), n3);
      float hot = clamp(b * 1.3 - 0.3 + (n1 - 0.5), 0.0, 1.0);
      vec3 burnt = mix(ash, soot, smoothstep(0.45, 0.8, hot + (n2 - 0.5) * 0.8));
      burnt = mix(burnt, oxide, smoothstep(0.56, 0.68, n1 * 0.5 + n2 * 0.5 + (1.0 - upv) * 0.06) * (paint ? 0.75 : 0.2));
      if (!paint) burnt = mix(burnt, soot, 0.6);
      burnt *= 0.85 + 0.3 * n4;
      float k = smoothstep(0.1, 0.6, b);
      // the edge of the burn: blistered, browned paint
      float edge = smoothstep(0.0, 0.2, b) * (1.0 - k);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.35, 0.28, 0.22), edge);
      diffuseColor.rgb = mix(diffuseColor.rgb, burnt, k);
      if (glass) diffuseColor.a = mix(diffuseColor.a, 0.95, k);
      wearCoatLoss = max(wearCoatLoss, max(k, edge));
      wearMatte = max(wearMatte, k);
      wearRough = mix(wearRough, 0.85, k);
      wearMetal *= 1.0 - k;
    }
  }
  dirtMask = max(dirtMask, clamp(wearMatte * 0.6, 0.0, 0.9));
}
`;

// after roughnessmap / metalnessmap
export const WEAR_FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(roughnessFactor, wearRough, wearMatte * (1.0 - 0.6 * wetMask));
`;
export const WEAR_FRAG_METAL = /* glsl */ `
metalnessFactor = mix(metalnessFactor, 0.85, wearMetal);
`;
// after normal_fragment_maps (view-space normal)
export const WEAR_FRAG_NORMAL = /* glsl */ `
if (dot(wearDentG, wearDentG) > 1e-8) normal = normalize(normal + normalMatrix * wearDentG * faceDirection);
`;
export const WEAR_FRAG_CLEARCOAT_NORMAL = /* glsl */ `
#ifdef USE_CLEARCOAT
if (dot(wearDentG, wearDentG) > 1e-8) clearcoatNormal = normalize(clearcoatNormal + normalMatrix * wearDentG * faceDirection);
#endif
`;
// after lights_physical_fragment: dust, scrapes and fire take the clear coat off;
// a wet film brings some of the gloss back
export const WEAR_FRAG_COAT = /* glsl */ `
#ifdef USE_CLEARCOAT
material.clearcoat *= 1.0 - clamp(wearCoatLoss, 0.0, 1.0) * (1.0 - 0.6 * wetMask);
material.clearcoatRoughness = clamp(mix(material.clearcoatRoughness, 0.45, clamp(wearCoatHaze, 0.0, 1.0) * (1.0 - 0.7 * wetMask)), 0.0, 1.0);
#endif
`;
