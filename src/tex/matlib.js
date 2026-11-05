// Runtime materials built on the baked texture sets. A shared shader patch adds
// paint tinting, wall grime, rain wetness/puddles, macro variation and the
// near-infrared response used by the camera's night mode.
import * as THREE from 'three';
import { WEAR_VERT_DECL, WEAR_VERT, WEAR_FRAG_DECL, WEAR_FRAG_COLOR, WEAR_FRAG_ROUGH, WEAR_FRAG_METAL, WEAR_FRAG_NORMAL, WEAR_FRAG_CLEARCOAT_NORMAL, WEAR_FRAG_COAT } from './carwear.glsl.js';

export const globalUniforms = {
  uWet: { value: 0 },        // 0 dry .. 1 soaked
  uPuddles: { value: 0 },    // puddle coverage on flat ground
  uRainRate: { value: 0 },   // ripple animation strength
  uTime: { value: 0 },
  uIR: { value: 0 },         // 1 when the camera is in IR (night) mode
  uNoiseTex: { value: null },
  // 2D radiance-cascade GI (env/gi.js)
  uGiD0: { value: null }, uGiD1: { value: null }, uGiD2: { value: null }, uGiD3: { value: null },
  uGiRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uGiY: { value: 0 },
  uGiStrength: { value: 0 },
  // block height field for sky occlusion (env/skyvis.js)
  uHF: { value: null },
  uHFRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uSkyVis: { value: 0 },
  // screen-space contact occlusion (env/ssao.js)
  uSSAO: { value: null },
  uSSAORes: { value: new THREE.Vector2(1, 1) },
  uSSAOOn: { value: 0 },
  // parallax occlusion mapping
  uSunWorld: { value: new THREE.Vector3(0, 1, 0) },
  uPomShadow: { value: 1 },   // strength of relief self-shadowing (0 at night)
  uPomFar: { value: 38 },     // POM fades out with distance (meters)
  uPomBoost: { value: 1 },    // global depth multiplier (debug / art direction)
  uFogMie: { value: 0 },
  // weathering layer (world/grime.js)
  uDirtMap: { value: null },
  uGroundTex: { value: null },
  uDirtRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uDirtAmt: { value: 0 },      // forward scattering of haze toward the sun
  // vehicle and people shadows from street lamps and the sun (env/silhouettes.js):
  // atlas of 3x2 tiles holding the distance at which each light ray hits them
  uSilMap: { value: null },
  uSilOn: { value: 0 },
  uSilM: { value: Array.from({ length: 5 }, () => new THREE.Matrix4()) },
  uSilF: { value: Array.from({ length: 5 }, () => new THREE.Vector4(0, 0, 0, -1)) },   // lamp pos / -sun dir, mode (0 lamp, 1 sun, -1 off)
  uSilS: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) },             // tile metres scale, light size, intensity
  uSilSun: { value: new THREE.Vector3(0, 1, 0) },
};

const VERT_DECL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vWallH;
`;
const VERT_BODY = /* glsl */ `
{
  vec4 wp4 = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
    wn = mat3(instanceMatrix) * wn;
  #endif
  vWPos = (modelMatrix * wp4).xyz;
  vWNrm = normalize(mat3(modelMatrix) * wn);
  vWallH = uv.y;
}
`;

const FRAG_DECL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
varying float vWallH;
uniform float uWet, uPuddles, uRainRate, uTime, uIR;
uniform sampler2D uNoiseTex;
uniform vec3 uTint;
uniform float uTintMask;    // 1 = map alpha is a paint mask
uniform float uGrime;       // rising damp + rain streak amount (walls)
uniform float uMacro;       // large-scale tone variation (ground)
uniform float uPorosity;    // how much water darkens the surface
uniform float uPuddleOK;    // receives puddles
uniform float uIRGain;      // near-IR reflectance relative to visible luma
uniform float uSpall;       // painted render: amount of paint / render loss and repaint patches
float spallMask = 0.0;
uniform float uPaintWear;   // >= 0: road paint, alpha eaten by wear noise
float puddleMask;
float wetMask;
float ormAO = 1.0;
float ormH = 1.0;
uniform float uSpecLevel;   // dielectric F0 scale for this material (1 = standard 4%)
uniform float uHasOrm;
float ormMetal = 1.0;
uniform float uOrmAO;
uniform sampler2D uGiD0, uGiD1, uGiD2, uGiD3;
uniform vec4 uGiRect;
uniform float uGiY, uGiStrength;
uniform sampler2D uHF;
uniform vec4 uHFRect;
uniform float uSkyVis;
uniform float uSkyVisSpec;
uniform float uFogMie;
uniform sampler2D uDirtMap, uGroundTex;
uniform vec4 uDirtRect;
uniform float uDirtAmt;
uniform float uDirtOK;
float tyreMask = 0.0;
float dirtMask = 0.0;
float oilMask = 0.0;
uniform vec3 uSunWorld;
uniform sampler2D uSSAO;
uniform vec2 uSSAORes;
uniform float uSSAOOn;
uniform sampler2D uSilMap;
uniform float uSilOn;
uniform float uSilRecv;
uniform mat4 uSilM[5];
uniform vec4 uSilF[5];
uniform vec4 uSilS[5];
uniform vec3 uSilSun;
// light k reaching P (0..1): the distance where its rays were stopped by a vehicle
// or a person, compared with P's own distance to the light. Blockers found around
// P give the penumbra width (wider the farther P lies behind them), then that many
// samples are averaged.
float silVis(int k, vec3 P) {
  vec4 F = uSilF[k];
  if (F.w < -0.5) return 1.0;
  vec4 c = uSilM[k] * vec4(P, 1.0);
  if (c.w <= 0.0) return 1.0;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (uv.x < 0.01 || uv.y < 0.01 || uv.x > 0.99 || uv.y > 0.99) return 1.0;
  float dR = F.w > 0.5 ? dot(P, F.xyz) : distance(P, F.xyz);
  vec2 org = vec2(mod(float(k), 3.0), floor(float(k) / 3.0));
  vec4 S = uSilS[k];
  // tile size in metres where P is
  float span = F.w > 0.5 ? S.x : S.x * dR;
  float bias = 0.04 + 0.01 * dR * (1.0 - F.w);
  // blocker search over a fixed 0.6 m neighbourhood
  float rs = 0.6 / span;
  float sum = 0.0, n = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 q = clamp(uv + vec2(float(i), float(j)) * rs * 0.5, 0.002, 0.998);
    float dB = texture2D(uSilMap, (q + org) / vec2(3.0, 2.0)).r;
    if (dB < dR - bias) { sum += dB; n += 1.0; }
  }
  if (n < 0.5) return 1.0;
  float dB = sum / n;
  // penumbra in metres: light size scaled by how far P is behind the blocker
  float pen = F.w > 0.5 ? (dR - dB) * S.y : S.y * (dR - dB) / max(dB, 0.1);
  float rf = clamp(pen / span, 0.4 / 512.0, 0.06);
  float lit = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 o = vec2(float(i), float(j)) + 0.5 * vec2(fract(sin(float(i * 7 + j * 13) + dot(P.xz, vec2(12.9898, 78.233))) * 43758.5453) - 0.5);
    vec2 q = clamp(uv + o * rf * 0.5, 0.002, 0.998);
    float d = texture2D(uSilMap, (q + org) / vec2(3.0, 2.0)).r;
    lit += d < dR - bias ? 0.0 : 1.0;
  }
  return lit / 25.0;
}
`;

// after map_fragment: tint + grime + macro + wet darkening
const FRAG_COLOR = /* glsl */ `
{
  #ifdef USE_MAP
  #ifdef USE_ALPHATEST
  {
    vec2 dx = dFdx(vMapUv * 512.0), dy = dFdy(vMapUv * 512.0);
    float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1.0));
    diffuseColor.a *= 1.0 + 0.3 * lod;
  }
  #endif
  #ifdef VTINT
  vec3 tintC = uTint * vColor.rgb;   // paint colour carried per vertex (merged batches)
  #else
  vec3 tintC = uTint;
  #endif
  if (uTintMask > 0.5) {
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * tintC, sampledDiffuseColor.a);
    diffuseColor.a = opacity;
  } else {
    diffuseColor.rgb *= tintC;
  }
  #else
  #ifdef VTINT
  diffuseColor.rgb *= uTint * vColor.rgb;
  #else
  diffuseColor.rgb *= uTint;
  #endif
  #endif
  if (uPaintWear >= 0.0) {
    float pn = texture2D(uNoiseTex, vWPos.xz * 0.21).g * 0.55 + texture2D(uNoiseTex, vWPos.xz * 1.9).b * 0.3 + texture2D(uNoiseTex, vWPos.xz * 7.3).r * 0.15;
    float thr = 0.3 + uPaintWear * 0.38;
    diffuseColor.a *= smoothstep(thr, thr + 0.06, pn) * 0.93;
  }
  vec3 nz = texture2D(uNoiseTex, vWPos.xz * 0.013).rgb;
  if (uMacro > 0.0) {
    vec3 nz2 = texture2D(uNoiseTex, vWPos.xz * 0.061 + 0.37).rgb;
    diffuseColor.rgb *= 1.0 + uMacro * ((nz.r - 0.5) * 1.1 + (nz2.g - 0.5) * 0.6);
  }
  if (uGrime > 0.0) {
    // rising damp / splash zone near the base of walls
    float n1 = texture2D(uNoiseTex, vec2(vWPos.x + vWPos.z, vWallH) * vec2(0.35, 0.8)).r;
    float base = 1.0 - smoothstep(0.05, 0.35 + 0.5 * n1, vWallH);
    // vertical streaks
    float st = texture2D(uNoiseTex, vec2((vWPos.x + vWPos.z) * 0.9, vWallH * 0.04)).g;
    float streak = smoothstep(0.52, 0.75, st) * 0.6;
    float g = clamp((base * 0.75 + streak) * uGrime, 0.0, 0.85);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.42, 0.40, 0.36), g);
    // mould / damp patches: large irregular blotches, greener near the ground,
    // and black run-off below the top edge of walls
    vec2 wp2 = vec2(vWPos.x + vWPos.z, vWPos.y);
    float m1 = texture2D(uNoiseTex, wp2 * vec2(0.09, 0.13) + 0.31).r;
    float m2 = texture2D(uNoiseTex, wp2 * vec2(0.45, 0.6) + 0.77).g;
    float m3 = texture2D(uNoiseTex, wp2 * vec2(2.1, 2.6)).b;
    // per 8 m stretch of wall: uniform random, so some walls are neglected and some are not
    float owner = fract(sin(dot(floor(vec2(vWPos.x, vWPos.z) * 0.125), vec2(127.1, 311.7))) * 43758.5453);
    // damp climbs from the ground; only neglected walls get it high up
    float damp = (1.0 - smoothstep(0.1, 0.6 + 1.6 * owner * owner, vWallH)) * (0.4 + 0.6 * owner);
    float mould = smoothstep(0.5, 0.7, m1 * 0.6 + m2 * 0.3 + m3 * 0.1 + 0.25 * damp - 0.1) * damp * uGrime * 1.4;
    vec3 mouldCol = mix(vec3(0.16, 0.17, 0.12), vec3(0.09, 0.09, 0.08), m2);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mouldCol * 2.2, clamp(mould * 0.8, 0.0, 0.75));
    // fine speckle of dirt everywhere on exterior walls
    diffuseColor.rgb *= 1.0 - 0.12 * uGrime * smoothstep(0.4, 0.8, m3);

    if (uSpall > 0.0 && abs(vWNrm.y) < 0.5) {
      // ---- facade wear on painted render
      // repainted / patched rectangles in a slightly different shade, faded paint
      vec2 cell = floor(wp2 * vec2(0.55, 0.9) + vec2(owner * 7.0, 0.0));
      float ch = fract(sin(dot(cell, vec2(41.3, 289.1))) * 43758.5);
      float patchK = step(0.8, ch) * uSpall;
      diffuseColor.rgb *= mix(1.0, 0.85 + 0.3 * fract(ch * 13.7), patchK);
      float fade = smoothstep(0.45, 0.75, m1) * 0.35 * uSpall;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.333))) * 1.12 + 0.03, fade);

      // ---- broken render: paint gone -> grey cement render -> brick underneath.
      // Loss concentrates near the ground (damp) and is patchy along the wall.
      float hb = vWallH;
      // damage lives at the foot of the wall (damp, knocks) and on some walls only
      // about a third of the walls are damaged; damage hugs the foot of the wall
      float bad = smoothstep(0.5, 0.75, owner);
      float zone = bad * ((1.0 - smoothstep(0.1, 0.9 + 0.6 * owner, hb)) * 0.8 + 0.15);
      float sp = texture2D(uNoiseTex, wp2 * vec2(0.22, 0.3) + 0.13).g * 0.7 + texture2D(uNoiseTex, wp2 * vec2(1.3, 1.6) + 0.57).r * 0.3;
      // noise sits around 0.5 +- 0.15: thresholds calibrated to that range
      float t1 = 1.0 - (0.15 + 0.5 * zone) * uSpall;   // paint lost
      float t2 = t1 + 0.06;                    // render lost too (brick shows)
      float paintGone = smoothstep(t1 - 0.012, t1, sp);
      float brickShow = smoothstep(t2 - 0.01, t2, sp);
      if (paintGone > 0.0) {
        float g = 0.24 + 0.08 * m3;
        vec3 render = vec3(g, g * 0.98, g * 0.94) * (0.8 + 0.3 * m2);
        // the broken edge casts a thin shadow / dirty rim
        float rim = smoothstep(t1 - 0.025, t1 - 0.01, sp) * (1.0 - paintGone);
        diffuseColor.rgb *= 1.0 - 0.45 * rim;
        diffuseColor.rgb = mix(diffuseColor.rgb, render, paintGone);
        if (brickShow > 0.0) {
          // procedural brick in world space: tijolinho or tijolo baiano depending on the wall
          bool baiano = owner > 0.45;
          vec2 bs = baiano ? vec2(0.29, 0.195) : vec2(0.24, 0.075);
          vec2 bp = wp2 / bs;
          float row = floor(bp.y);
          bp.x += mod(row, 2.0) * 0.5;
          vec2 f = fract(bp);
          vec2 id = floor(bp);
          float mt = baiano ? 0.05 : 0.06;
          float mortar = max(step(f.x, mt * bs.y / bs.x * 1.5), step(f.y, mt * 2.0));
          float bh = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 brick = baiano ? mix(vec3(0.33, 0.14, 0.07), vec3(0.45, 0.21, 0.11), bh) : mix(vec3(0.26, 0.09, 0.05), vec3(0.38, 0.15, 0.08), bh);
          brick *= 0.8 + 0.35 * m3;
          vec3 mort = vec3(0.36, 0.35, 0.33) * (0.8 + 0.3 * m2);
          vec3 bc = mix(brick, mort, mortar);
          float rim2 = smoothstep(t2 - 0.02, t2 - 0.008, sp) * (1.0 - brickShow);
          diffuseColor.rgb *= 1.0 - 0.35 * rim2;
          diffuseColor.rgb = mix(diffuseColor.rgb, bc, brickShow);
        }
        spallMask = paintGone;
      }
    }
  }
  // ---- weathering: dirt map + height above ground
  if (uDirtAmt > 0.0 && uDirtOK > 0.5) {
    vec2 duv = (vWPos.xz - uDirtRect.xy) / uDirtRect.zw;
    if (duv.x > 0.0 && duv.y > 0.0 && duv.x < 1.0 && duv.y < 1.0) {
      vec4 dm = texture2D(uDirtMap, duv);
      float upv = clamp(vWNrm.y, 0.0, 1.0);
      float n1 = texture2D(uNoiseTex, vWPos.xz * 0.31 + vWPos.y * 0.2).g;
      float n2 = texture2D(uNoiseTex, vWPos.xz * 2.7 + vWPos.y * 1.3).b;
      float n3 = texture2D(uNoiseTex, vWPos.xz * 9.1 - vWPos.y * 3.1).r;
      float brk = smoothstep(0.2, 0.8, n1 * 0.55 + n2 * 0.3 + n3 * 0.15);
      float hAbove = vWPos.y - texture2D(uGroundTex, duv).r;
      // horizontal: sediment, moss, tyre wear, oil
      float dr = smoothstep(0.02, 0.6, dm.r);
      // light dirt is sparse patches; heavy dirt closes into a continuous layer
      float patchy = smoothstep(0.62 - 0.5 * dr, 0.78 - 0.3 * dr, n1 * 0.6 + n2 * 0.25 + n3 * 0.15);
      float dirt = dr * upv * patchy * (0.6 + 0.6 * brk);
      // vertical: splash zone and rising damp; higher and patchier where the ground is dirty
      float vert = (1.0 - upv) * (0.35 + dr) * (1.0 - smoothstep(0.02, 0.15 + 0.55 * n1 * (0.4 + dm.r), hAbove)) * step(-0.2, hAbove);
      dirt = clamp((dirt + vert * (0.6 + 0.6 * brk)) * uDirtAmt, 0.0, 0.9);
      // dirt colour varies by place (A channel): cement dust, dry sand, red soil, black grime
      float hue = dm.a;
      vec3 c0 = vec3(0.31, 0.30, 0.28), c1 = vec3(0.42, 0.35, 0.24), c2 = vec3(0.23, 0.13, 0.08), c3 = vec3(0.055, 0.05, 0.042);
      vec3 dcol = hue < 0.333 ? mix(c0, c1, hue * 3.0) : hue < 0.666 ? mix(c1, c2, (hue - 0.333) * 3.0) : mix(c2, c3, (hue - 0.666) * 3.0);
      dcol *= 0.65 + 0.7 * n2;
      // vertical splash is always darker (mud + soot)
      vec3 sed = mix(dcol, dcol * 0.45, (1.0 - upv) * 0.6);
      diffuseColor.rgb = mix(diffuseColor.rgb, sed, dirt);
      dirtMask = dirt;
      float moss = dm.b * (0.2 + 0.8 * smoothstep(0.45, 0.75, n2)) * uDirtAmt * mix(1.0 - smoothstep(0.0, 0.4, hAbove), 1.0, upv);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.06, 0.025) + diffuseColor.rgb * 0.3, clamp(moss * 0.55, 0.0, 0.6));
      // tyre wear and oil share G: darker and smoother
      tyreMask = dm.g * upv * (0.4 + 0.6 * smoothstep(0.3, 0.7, n1 * 0.5 + n3 * 0.5)) * uDirtAmt;
      diffuseColor.rgb *= 1.0 - 0.6 * clamp(tyreMask, 0.0, 1.0);
    }
  }
  #ifdef CAR_WEAR
  ${WEAR_FRAG_COLOR}
  #endif
  // wetness: horizontal surfaces soak fully, vertical ones only partly
  float up = clamp(vWNrm.y, 0.0, 1.0);
  wetMask = uWet * mix(0.45, 1.0, up);
  float pn = texture2D(uNoiseTex, vWPos.xz * 0.045).r * 0.7 + texture2D(uNoiseTex, vWPos.xz * 0.21).g * 0.3;
  puddleMask = uPuddleOK * smoothstep(0.92, 1.0, up) * smoothstep(0.66 - uPuddles * 0.16, 0.78 - uPuddles * 0.16, pn);
  #ifdef CAR_WEAR
  float dark = wetMask * max(uPorosity, wearPoro);
  #else
  float dark = wetMask * uPorosity;
  #endif
  diffuseColor.rgb *= mix(1.0, 0.45, dark);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, puddleMask);
  // near infrared: chlorophyll and many dyes reflect strongly
  float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(clamp(l * uIRGain, 0.0, 0.9)), uIR);
}
`;

const FRAG_ROUGH = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  ormAO = texelRoughness.r;
  ormMetal = texelRoughness.b;
  ormH = texelRoughness.a;
#endif
{
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.32 + 0.05, wetMask * 0.9);
  roughnessFactor = mix(roughnessFactor, 1.0, dirtMask * (1.0 - wetMask));
  roughnessFactor = mix(roughnessFactor, 0.95, spallMask);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.7, clamp(tyreMask, 0.0, 1.0));
  roughnessFactor = mix(roughnessFactor, 0.03, puddleMask);
}
`;

const FRAG_NORMAL = /* glsl */ `
{
  // water fills the micro relief
  normal = normalize(mix(normal, nonPerturbedNormal, max(puddleMask, wetMask * 0.15)));
  if (uRainRate > 0.0 && puddleMask > 0.0) {
    // rain ripples: expanding rings from random drops
    vec2 p = vWPos.xz * 3.0;
    vec2 cell = floor(p);
    vec2 acc = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j);
      vec2 h = fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453);
      float t = fract(uTime * (0.9 + h.x) + h.y);
      vec2 d = p - (c + h);
      float r = length(d);
      float ring = sin((r - t * 0.9) * 40.0) * (1.0 - t) * smoothstep(0.0, 0.05, r) * (1.0 - smoothstep(t * 0.9 - 0.02, t * 0.9 + 0.08, r));
      acc += normalize(d + 1e-5) * ring;
    }
    vec3 w = vec3(acc.x, 0.0, acc.y) * 0.25 * uRainRate * puddleMask;
    normal = normalize(normal + (viewMatrix * vec4(w, 0.0)).xyz);
  }
}
`;

// sky visibility: horizon angle along 8 azimuths over the block height field.
// Horizontal surfaces lose cos^2 of the horizon elevation, vertical ones 1 - sin.
const FRAG_SKYVIS = /* glsl */ `
if (uSkyVis > 0.0) {
  vec3 svN = normalize(vWNrm);
  vec3 o = vWPos + svN * 0.3;
  vec2 ouv = (o.xz - uHFRect.xy) / uHFRect.zw;
  if (ouv.x > 0.0 && ouv.y > 0.0 && ouv.x < 1.0 && ouv.y < 1.0) {
    float hl = length(svN.xz);
    vec2 nh = hl > 0.01 ? svN.xz / hl : vec2(0.0);
    float acc = 0.0, wsum = 0.0;
    // ground facing up: the baked value (one read instead of 64)
    vec4 hf0 = textureLod(uHF, ouv, 0.0);
    if (svN.y > 0.9 && vWPos.y - hf0.b < 0.5) { acc = hf0.g; wsum = 1.0; }
    else for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982 + 0.39;
      vec2 d = vec2(cos(a), sin(a));
      float w = mix(1.0, max(dot(d, nh), 0.0), hl);
      if (w <= 0.001) continue;
      float slope = 0.0;
      // per-pixel jittered start hides the remaining steps in the height field
      float t = 0.45 + 0.25 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      for (int j = 0; j < 8; j++) {
        vec2 q = (o.xz + d * t - uHFRect.xy) / uHFRect.zw;
        if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
        slope = max(slope, (textureLod(uHF, q, 0.0).r - o.y) / t);
        t *= 1.75;
      }
      float s2 = slope * slope;
      float horiz = 1.0 / (1.0 + s2);
      float vert = 1.0 - slope * inversesqrt(1.0 + s2);
      acc += w * mix(horiz, vert, hl);
      wsum += w;
    }
    float sv = wsum > 0.0 ? acc / wsum : 1.0;
    reflectedLight.indirectDiffuse *= mix(1.0, sv, uSkyVis);
    reflectedLight.indirectSpecular *= mix(1.0, sv, uSkyVis * uSkyVisSpec);
  }
}
`;

// Specular map: how much each texel can reflect. Derived from the baked relief:
// joints, pores and cracks (low height) and occluded spots (AO) barely reflect,
// tops of stones and tiles do. A per-material level sets the F0 (bitumen and
// dusty concrete are dull, glazed ceramic and pastilha shine). Water fills the
// cavities, so wet surfaces reflect everywhere.
const FRAG_SPEC = /* glsl */ `
{
  float cav = uHasOrm > 0.5 ? smoothstep(0.05, 0.55, ormH) : 1.0;
  float spec = uSpecLevel * mix(0.12, 1.0, cav) * mix(0.35, 1.0, ormAO);
  // fine dust breaks up the sheen at the texel scale
  spec *= 0.75 + 0.5 * texture2D(uNoiseTex, vWPos.xz * 3.7 + vWPos.y * 0.9).b;
  spec *= 1.0 - 0.85 * dirtMask * (1.0 - wetMask);
  spec = mix(spec, max(spec, 1.0), max(wetMask * 0.85, puddleMask));
  spec = mix(spec, 1.0, metalnessFactor);
  reflectedLight.directSpecular *= spec;
  reflectedLight.indirectSpecular *= spec;
}
`;

const FRAG_SSAO = /* glsl */ `
reflectedLight.indirectDiffuse *= mix(1.0, ormAO, uOrmAO);
// rough dielectrics (concrete, asphalt, plaster) barely mirror the sky: specular occlusion
{
  float rr = roughnessFactor * roughnessFactor;
  reflectedLight.indirectSpecular *= mix(1.0, 0.3, rr * (1.0 - metalnessFactor));
}
if (uSSAOOn > 0.5) {
  float sao = pow(texture2D(uSSAO, gl_FragCoord.xy / uSSAORes).r, 1.7);
  reflectedLight.indirectDiffuse *= sao;
  reflectedLight.indirectSpecular *= mix(1.0, sao, 0.7);
}

`;

const FRAG_SIL = /* glsl */ `
if (uSilOn > 0.5 && uSilRecv > 0.5) {
  vec3 P = vWPos;
  vec3 N = normalize(vWNrm);
  vec3 Po = P + N * 0.04;
  float wSum = 0.0, wLit = 0.0;
  for (int k = 0; k < 5; k++) {
    vec4 F = uSilF[k];
    if (F.w < -0.5) continue;
    float w;
    if (F.w > 0.5) w = uSilS[k].z * max(dot(N, uSilSun), 0.0);
    else { vec3 L = F.xyz - P; float dd = max(dot(L, L), 0.25); w = uSilS[k].z * max(dot(N, L * inversesqrt(dd)), 0.0) / dd; }
    if (w <= 0.0) continue;
    wSum += w;
    wLit += w * silVis(k, Po);
  }
  if (wSum > 0.0) { float v = wLit / wSum;
    reflectedLight.directDiffuse *= v;
    reflectedLight.directSpecular *= v;
  }
}
`;

// indirect light from the street GI: 4 directional irradiance maps, weighted by the
// horizontal normal (same scheme as book-club-radio's giHook)
const FRAG_GI = /* glsl */ `
if (uGiStrength > 0.0) {
  vec2 gn = length(vWNrm.xz) > 0.01 ? normalize(vWNrm.xz) : vec2(0.0);
  vec2 guv = (vWPos.xz + gn * 0.4 - uGiRect.xy) / uGiRect.zw;
  if (guv.x > 0.0 && guv.y > 0.0 && guv.x < 1.0 && guv.y < 1.0) {
    vec3 L0 = texture2D(uGiD0, guv).rgb;
    vec3 L1 = texture2D(uGiD1, guv).rgb;
    vec3 L2 = texture2D(uGiD2, guv).rgb;
    vec3 L3 = texture2D(uGiD3, guv).rgb;
    vec3 E = (L0 + L1 + L2 + L3) * 0.25;
    float hl = length(vWNrm.xz);
    if (hl > 0.01) {
      float a = dot(gn, vec2(0.7071, 0.7071));
      float b = dot(gn, vec2(-0.7071, 0.7071));
      vec4 w = vec4(a, b, -a, -b) * 0.5 + 0.5;
      w *= w;
      E = mix(E, (L0 * w.x + L1 * w.y + L2 * w.z + L3 * w.w) / max(dot(w, vec4(1.0)), 0.001), hl);
    }
    // ground does not light itself; light bounced off the street fades with height
    float face = 1.0 - 0.8 * clamp(vWNrm.y, 0.0, 1.0);
    float hgt = clamp(1.0 - (vWPos.y - uGiY - 3.0) / 25.0, 0.25, 1.0);
    float giAO = uSSAOOn > 0.5 ? texture2D(uSSAO, gl_FragCoord.xy / uSSAORes).r : 1.0;
    reflectedLight.indirectDiffuse += BRDF_Lambert(material.diffuseColor) * E * uGiStrength * face * hgt * giAO;
  }
}
`;

// Parallax occlusion mapping: the height (ORM alpha) shifts all texture lookups along
// the view ray (linear search + binary refinement), then a short march toward the sun
// gives the relief its own shadows. Tangent frame from screen derivatives, in meters.
const POM_DECL = /* glsl */ `
uniform float uPomDepth;
uniform float uPomShadow, uPomFar, uPomBoost;
`;
const POM_MAIN = /* glsl */ `
vec2 pomUv = vMapUv;
float pomShadow = 1.0;
{
  float pdist = length(vViewPosition);
  float fade = 1.0 - smoothstep(uPomFar * 0.55, uPomFar, pdist);
  vec2 st0 = dFdx(vMapUv), st1 = dFdy(vMapUv);
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  float detUv = st0.x * st1.y - st1.x * st0.y;
  if (fade > 0.0 && abs(detUv) > 1e-12) {
    vec3 dPdu = (q0 * st1.y - q1 * st0.y) / detUv;
    vec3 dPdv = (q1 * st0.x - q0 * st1.x) / detUv;
    float lu = length(dPdu), lv = length(dPdv);
    vec3 Tu = dPdu / lu, Tv = dPdv / lv;
    vec3 Ng = normalize(cross(dPdu, dPdv));
    vec3 Vv = normalize(vViewPosition);
    if (dot(Ng, Vv) < 0.0) Ng = -Ng;
    vec3 Vt = vec3(dot(Vv, Tu), dot(Vv, Tv), dot(Vv, Ng));
    float depth = uPomDepth * uPomBoost * fade;
    // uv shift for one full depth unit along the view ray
    vec2 full = -Vt.xy / max(Vt.z, 0.12) * depth / vec2(lu, lv);
    // parallax shift on screen, in pixels: no point marching finer than that, and
    // below half a pixel the relief is invisible
    float uvPerPx = max(length(st0), length(st1));
    float shiftPx = length(full) / max(uvPerPx, 1e-7);
    float layers = min(mix(28.0, 8.0, clamp(Vt.z, 0.0, 1.0)), ceil(shiftPx * 1.5));
    if (shiftPx < 0.5) layers = 0.0;
    float dl = 1.0 / max(layers, 1.0);
    vec2 duv = full * dl;
    vec2 uv = vMapUv;
    float cur = 0.0;
    float d = 1.0 - textureGrad(roughnessMap, uv, st0, st1).a;
    if (layers > 0.0) {
    for (int i = 0; i < 32; i++) {
      if (cur >= d || float(i) >= layers) break;
      uv += duv; cur += dl;
      d = 1.0 - textureGrad(roughnessMap, uv, st0, st1).a;
    }
    // relief refinement between the last two layers
    vec2 a = uv - duv, b = uv;
    float ca = cur - dl, cb = cur;
    for (int k = 0; k < 5; k++) {
      vec2 m = (a + b) * 0.5; float cm = (ca + cb) * 0.5;
      float dm = 1.0 - textureGrad(roughnessMap, m, st0, st1).a;
      if (cm >= dm) { b = m; cb = cm; } else { a = m; ca = cm; }
    }
    pomUv = (a + b) * 0.5;
    // self-shadowing toward the sun
    if (uPomShadow > 0.0 && shiftPx > 1.0) {
      vec3 Lv = normalize((viewMatrix * vec4(uSunWorld, 0.0)).xyz);
      vec3 Lt = vec3(dot(Lv, Tu), dot(Lv, Tv), dot(Lv, Ng));
      if (Lt.z > 0.02) {
        float d0 = 1.0 - textureGrad(roughnessMap, pomUv, st0, st1).a;
        vec2 luv = Lt.xy / max(Lt.z, 0.1) * depth / vec2(lu, lv);
        float occ = 0.0;
        for (int j = 1; j <= 10; j++) {
          float t = float(j) / 10.0 * d0;
          if (t <= 0.0) break;
          float dh = 1.0 - textureGrad(roughnessMap, pomUv + luv * t, st0, st1).a;
          occ = max(occ, (d0 - t - dh) * (1.0 - float(j) / 11.0));
        }
        pomShadow = 1.0 - clamp(occ * 10.0, 0.0, 1.0) * uPomShadow * fade;
      }
    }
    }
  }
}
`;
const POM_APPLY = /* glsl */ `
reflectedLight.directDiffuse *= pomShadow;
reflectedLight.directSpecular *= pomShadow;
`;
// three chunks with their uv varying swapped for the parallax-shifted one
const pomChunk = (name, varying) => THREE.ShaderChunk[name].split(varying).join('pomUv');

// haze brightens toward the sun (Mie forward scattering): aerial perspective
const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
{
  vec3 fd = normalize(vWPos - cameraPosition);
  float mie = pow(max(dot(fd, uSunWorld), 0.0), 6.0);
  vec3 fcol = fogColor * (1.0 + uFogMie * (mie * 1.2 + 0.1));
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fcol, fogFactor);
}
#endif
`;

const STOCH = /* glsl */ `
vec2 stochHash(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec4 texStochG(sampler2D t, vec2 uv, vec2 dx, vec2 dy) {
  // triangle grid in a skewed space; each vertex gets a random texture offset
  vec2 s = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv * 2.4);
  vec2 b = floor(s);
  vec3 f = vec3(fract(s), 0.0); f.z = 1.0 - f.x - f.y;
  vec3 w; vec2 v1, v2, v3;
  if (f.z > 0.0) { w = vec3(f.z, f.y, f.x); v1 = b; v2 = b + vec2(0.0, 1.0); v3 = b + vec2(1.0, 0.0); }
  else { w = vec3(-f.z, 1.0 - f.y, 1.0 - f.x); v1 = b + 1.0; v2 = b + vec2(1.0, 0.0); v3 = b + vec2(0.0, 1.0); }
  vec4 c1 = textureGrad(t, uv + stochHash(v1), dx, dy);
  vec4 c2 = textureGrad(t, uv + stochHash(v2), dx, dy);
  vec4 c3 = textureGrad(t, uv + stochHash(v3), dx, dy);
  // sharpened weights keep contrast instead of a blurry average
  w = pow(w, vec3(6.0)); w /= (w.x + w.y + w.z);
  return c1 * w.x + c2 * w.y + c3 * w.z;
}
vec4 texStoch(sampler2D t, vec2 uv) { return texStochG(t, uv, dFdx(uv), dFdy(uv)); }
`;

function patch(material, opts) {
  const u = {
    uTint: { value: new THREE.Color(opts.tint ?? '#ffffff') },
    uTintMask: { value: opts.tintMask ? 1 : 0 },
    uGrime: { value: opts.grime ?? 0 },
    uMacro: { value: opts.macro ?? 0 },
    uPorosity: { value: opts.porosity ?? 0.6 },
    uPuddleOK: { value: opts.puddles ? 1 : 0 },
    uIRGain: { value: opts.irGain ?? 1.15 },
    uSpall: { value: opts.spall ?? 0 },
    uPaintWear: { value: opts.paintWear ?? -1 },
    uDirtOK: { value: opts.dirt ?? 1 },
    uSpecLevel: { value: opts.spec ?? 1 },
    // 0 for objects with their own reflection probe (the probe already sees what blocks the sky)
    uSkyVisSpec: { value: opts.skyvisSpec ?? 0.75 },
    // 0 for vehicles: they would shadow themselves through their own silhouette
    uSilRecv: { value: opts.silRecv ?? 1 },
    uHasOrm: { value: opts.hasOrm ? 1 : 0 },
    uOrmAO: { value: opts.ao === false ? 0 : 0.8 },
    uPomDepth: { value: opts.pomDepth ?? 0 },
  };
  const pom = (opts.pomDepth ?? 0) > 0;
  const stoch = !!opts.stoch;
  // vehicle condition (src/vehicles/wear.js): one uniforms object per car, shared by
  // all its materials; only the kind of surface is per material
  const wear = opts.wear || null;
  if (wear) { u.uWearKind = { value: opts.wearKind ?? 1 }; u.uWearScrape = { value: opts.wearScrape ?? 0 }; }
  if (pom) material.defines = { ...(material.defines || {}), USE_POM: '' };
  if (wear) material.defines = { ...(material.defines || {}), CAR_WEAR: '' };
  material.userData.u = u;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, globalUniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_COLOR)
      .replace('#include <color_fragment>', material.userData.vtint ? '' : '#include <color_fragment>')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= ormMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + FRAG_SPEC + FRAG_SKYVIS + FRAG_SSAO + FRAG_GI + FRAG_SIL)
      .replace('#include <fog_fragment>', FRAG_FOG);
    if (wear) {
      Object.assign(shader.uniforms, wear);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WEAR_VERT_DECL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WEAR_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + WEAR_FRAG_DECL)
        .replace('#include <metalnessmap_fragment>\nmetalnessFactor *= ormMetal;', '#include <metalnessmap_fragment>\nmetalnessFactor *= ormMetal;\n' + WEAR_FRAG_ROUGH + WEAR_FRAG_METAL)
        .replace('#include <clearcoat_normal_fragment_maps>', '#include <clearcoat_normal_fragment_maps>\n' + WEAR_FRAG_CLEARCOAT_NORMAL)
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + WEAR_FRAG_COAT);
      // the dent slope goes in before the rain's own normal tweaks
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>\n', '#include <normal_fragment_maps>\n' + WEAR_FRAG_NORMAL);
    }
    if (pom) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + POM_DECL)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + POM_MAIN)
        .replace('#include <map_fragment>', pomChunk('map_fragment', 'vMapUv'))
        .replace('#include <normal_fragment_maps>', pomChunk('normal_fragment_maps', 'vNormalMapUv'))
        .replace('#include <roughnessmap_fragment>', pomChunk('roughnessmap_fragment', 'vRoughnessMapUv'))
        .replace('#include <metalnessmap_fragment>', pomChunk('metalnessmap_fragment', 'vMetalnessMapUv'))
        .replace('#include <aomap_fragment>', pomChunk('aomap_fragment', 'vAoMapUv'))
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + POM_APPLY);
    }
  };
  if (stoch) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + STOCH)
        .replace(/texture2D\(\s*(map|normalMap|roughnessMap)\s*,/g, 'texStoch($1,')
        .replace(/textureGrad\(roughnessMap,/g, 'texStochG(roughnessMap,');
    };
  }
  material.customProgramCacheKey = () => 'cctv-surface-v2' + (pom ? '-pom' : '') + (stoch ? '-st' : '') + (wear ? '-wear1' : '');
  return material;
}

export class MaterialLibrary {
  constructor(baker) {
    this.baker = baker;
    this.cache = new Map();
    globalUniforms.uNoiseTex.value = baker.get('noise').map;
    globalUniforms.uNoiseTex.value.colorSpace = THREE.NoColorSpace;
  }

  // name: texture set; opts: tint, tintMask, grime, macro, porosity, puddles, side, cutout, normalScale, rough
  // one of the texture sets sharing this base name (name, name_b, name_c, ...)
  variant(name, r) {
    const list = [name, name + '_b', name + '_c', name + '_d'].filter(n => { try { this.baker.get(n); return true; } catch { return false; } });
    return list.length ? r.pick(list) : name;
  }

  get(name, opts = {}) {
    const key = name + JSON.stringify(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    const m = this.build(name, opts);
    // Tinted materials differ only by a colour: the Batcher merges everything
    // that shares the texture by drawing a white-tinted shared material and
    // writing the colour per vertex (one draw instead of one per lot)
    if (opts.tint !== undefined && !opts.noShare) {
      const shared = this.get(name, { ...opts, tint: undefined, vtint: true, tintMaskFrom: opts.tint !== undefined });
      m.userData.shared = shared;
      m.userData.tint = new THREE.Color(opts.tint);
    }
    this.cache.set(key, m);
    return m;
  }

  build(name, opts) {
    const set = this.baker.get(name);
    const def = set.def;
    const m = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.orm,
      roughness: opts.rough ?? 1,
      metalness: opts.metal ?? 1,
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      side: opts.side ?? THREE.FrontSide,
      alphaTest: def.cutout ? 0.45 : 0,
      transparent: false,
    });
    if (def.cutout) m.alphaToCoverage = true;
    const pomDepth = opts.pom === false || def.cutout || !(set.depth > 0.0015) ? 0 : set.depth * (opts.pomScale ?? 1);
    const SPEC = { asphalt: 0.5, concrete: 0.6, concreteRaw: 0.55, petitpave: 0.9, tiles: def.p[1] > 0.5 && def.p[1] < 1.5 ? 0.75 : 1.15, paver: 0.6, grass: 0.45, soil: 0.35, plaster: 0.55, masonry: 0.55, stone: 0.8, pastilha: 1.35, roofCeramic: 0.6, fibro: 0.5, metal: 1.0, wood: 0.7, bark: 0.4, foliage: 0.45 };
    patch(m, { ...opts, stoch: opts.stoch ?? (opts.macro > 0 && !def.cutout), spec: opts.spec ?? SPEC[def.m] ?? 1, hasOrm: true, pomDepth, tintMask: def.tint && (opts.tint !== undefined || opts.tintMaskFrom) ? true : false, tint: opts.tint ?? '#ffffff' });
    if (opts.vtint) { m.vertexColors = true; m.defines = { ...(m.defines || {}), VTINT: 1 }; m.userData.vtint = true; }
    return m;
  }

  // plain PBR material that still gets wetness / IR handling
  plain(params, opts = {}) {
    // textures by uuid: JSON.stringify would serialize their pixels to data URLs
    const flat = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v && v.isTexture ? 'tex:' + v.uuid : v && v.isColor ? v.getHex() : v]));
    // a car's wear uniforms by id (opts.wearId), never serialized
    const key = 'plain' + JSON.stringify(flat) + JSON.stringify(opts, (k, v) => (k === 'wear' ? undefined : v));
    if (this.cache.has(key)) return this.cache.get(key);
    const Cls = params.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const p = { ...params };
    delete p.physical;
    const m = new Cls(p);
    patch(m, { porosity: 0.2, ...opts });
    if (opts.vtint) { m.vertexColors = true; m.defines = { ...(m.defines || {}), VTINT: 1 }; m.userData.vtint = true; }
    this.cache.set(key, m);
    // a flat colour without texture: share a white material, colour per vertex
    // (not for emissive ones: night lighting changes them at runtime)
    if (!opts.vtint && !opts.noShare && !opts.wear && params.color !== undefined && !params.map && !params.transparent && !params.emissive && !params.emissiveMap) {
      const col = new THREE.Color(params.color);
      m.userData.shared = this.plain({ ...params, color: '#ffffff' }, { ...opts, vtint: true });
      m.userData.tint = col;
    }
    return m;
  }
}
