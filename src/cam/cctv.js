// Camera pipeline: lens -> sensor -> ISP -> OSD -> H.264-like block coding -> display.
// The scene is rendered in linear kilolux units; everything after that emulates a
// cheap CMOS camera feeding a low-bitrate DVR.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Rng } from '../core/rng.js';
import { GRADE, applyGrade } from './grade.js';
import { prof } from '../debug/prof.js';

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

function pass(frag, uniforms, defines = {}) {
  return new FullScreenQuad(new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false }));
}

function rt(w, h, type = THREE.HalfFloatType, filter = THREE.LinearFilter, opts = {}) {
  return new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false, generateMipmaps: false, ...opts });
}

// ------------------------------------------------------------------ shaders
// FXAA (3.11-style edge search + subpixel blend) on the linear HDR scene; the edge
// test runs on a tone-mapped luma so it sees edges the way the final image will
const FXAA_FS = /* glsl */ `
precision highp float;
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uExposure; uniform float uSub;
varying vec2 vUv;
vec3 S(vec2 uv){ return textureLod(tSrc, uv, 0.0).rgb; }
float L(vec3 c){ float y = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0) * uExposure; return sqrt(y / (1.0 + y)); }
float stepQ(int i){ return i < 5 ? 1.0 : i == 5 ? 1.5 : i < 10 ? 2.0 : i == 10 ? 4.0 : 8.0; }
void main(){
  vec2 uv = vUv;
  vec3 cM = S(uv);
  float lM = L(cM);
  float lN = L(S(uv + vec2(0.0, uTexel.y))), lS = L(S(uv - vec2(0.0, uTexel.y)));
  float lE = L(S(uv + vec2(uTexel.x, 0.0))), lW = L(S(uv - vec2(uTexel.x, 0.0)));
  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(cM, 1.0); return; }
  float lNE = L(S(uv + uTexel)), lSW = L(S(uv - uTexel));
  float lNW = L(S(uv + vec2(-uTexel.x, uTexel.y))), lSE = L(S(uv + vec2(uTexel.x, -uTexel.y)));
  float lNS = lN + lS, lWE = lW + lE;
  float edgeH = abs(-2.0 * lW + lNW + lSW) + abs(-2.0 * lM + lNS) * 2.0 + abs(-2.0 * lE + lNE + lSE);
  float edgeV = abs(-2.0 * lS + lSW + lSE) + abs(-2.0 * lM + lWE) * 2.0 + abs(-2.0 * lN + lNW + lNE);
  bool horz = edgeH >= edgeV;
  float l1 = horz ? lS : lW, l2 = horz ? lN : lE;
  float g1 = l1 - lM, g2 = l2 - lM;
  bool steep1 = abs(g1) >= abs(g2);
  float gScaled = 0.25 * max(abs(g1), abs(g2));
  float stepLen = horz ? uTexel.y : uTexel.x;
  float lLocal;
  if (steep1) { stepLen = -stepLen; lLocal = 0.5 * (l1 + lM); } else lLocal = 0.5 * (l2 + lM);
  vec2 cur = uv;
  if (horz) cur.y += stepLen * 0.5; else cur.x += stepLen * 0.5;
  vec2 off = horz ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  vec2 u1 = cur - off, u2 = cur + off;
  float e1 = L(S(u1)) - lLocal, e2 = L(S(u2)) - lLocal;
  bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;
  for (int i = 0; i < 12; i++) {
    if (r1 && r2) break;
    float q = stepQ(i);
    if (!r1) { u1 -= off * q; e1 = L(S(u1)) - lLocal; r1 = abs(e1) >= gScaled; }
    if (!r2) { u2 += off * q; e2 = L(S(u2)) - lLocal; r2 = abs(e2) >= gScaled; }
  }
  float d1 = horz ? uv.x - u1.x : uv.y - u1.y;
  float d2 = horz ? u2.x - uv.x : u2.y - uv.y;
  bool dir1 = d1 < d2;
  float pixOff = -min(d1, d2) / (d1 + d2) + 0.5;
  bool correct = ((dir1 ? e1 : e2) < 0.0) != (lM < lLocal);
  float fin = correct ? pixOff : 0.0;
  // subpixel aliasing (wires, foliage cutouts): blend toward the neighbourhood
  float lAvg = (2.0 * (lNS + lWE) + lNE + lNW + lSE + lSW) / 12.0;
  float s1 = clamp(abs(lAvg - lM) / range, 0.0, 1.0);
  float s2 = (-2.0 * s1 + 3.0) * s1 * s1;
  fin = max(fin, s2 * s2 * uSub);
  vec2 fuv = uv;
  if (horz) fuv.y += fin * stepLen; else fuv.x += fin * stepLen;
  gl_FragColor = vec4(S(fuv), 1.0);
}`;


const BRIGHT_FS = /* glsl */ `
uniform sampler2D tSrc; uniform float uExposure; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25 * uExposure;
  // inf/NaN from an overflowing half-float pixel would smear a black block through the blur chain
  if (any(isnan(c)) || any(isinf(c))) c = vec3(40.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 b = c * max(l - 1.0, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(min(b, vec3(40.0)), 1.0);
}`;

const DOWN_FS = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP_FS = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 uTexel; uniform float uMix; varying vec2 vUv;
void main(){
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0,  1.0)).rgb;
  c *= 0.25;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c * uMix, 1.0);
}`;

const LUM_FS = /* glsl */ `
uniform sampler2D tSrc; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // centre-weighted metering
  vec2 d = vUv - vec2(0.5, 0.45);
  float w = 1.0 - smoothstep(0.2, 0.75, length(d * vec2(1.0, 1.4))) * 0.7;
  gl_FragColor = vec4(log(max(l, 1e-7)) * w, w, min(l, 2000.0) * w, 1.0);
}`;

// colour average for auto white balance; clipped and very dark areas do not vote
const COL_FS = /* glsl */ `
uniform sampler2D tSrc; uniform float uExposure; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = step(0.03, l) * (1.0 - step(0.9, max(c.r, max(c.g, c.b))));
  gl_FragColor = vec4(c * w, w);
}`;

// exposed log-luminance at 1/8 resolution, 4x4 taps
const LOGLUM_FS = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uExposure; varying vec2 vUv;
void main(){
  float s = 0.0;
  for (int j = -2; j < 2; j++) for (int i = -2; i < 2; i++) {
    vec3 c = texture2D(tSrc, vUv + (vec2(i, j) + 0.5) * uTexel).rgb;
    s += log(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) * uExposure, 1e-3, 64.0));
  }
  gl_FragColor = vec4(s / 16.0, 0.0, 0.0, 1.0);
}`;

const ISP_FS = /* glsl */ `
precision highp float;
uniform sampler2D tScene, tBloom, tPrev, tLens, tLocal;
uniform vec2 uLocalTexel;
// smooth local luminance: tent filter over the coarse log map, back to linear
float localLum(vec2 uv) {
  float s = 0.0, w = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float k = (2.0 - abs(float(i))) * (2.0 - abs(float(j)));
    s += texture2D(tLocal, uv + vec2(i, j) * uLocalTexel).r * k; w += k;
  }
  return exp(s / w);
}
uniform vec2 uRes;
uniform float uK;           // barrel distortion
uniform float uSpan;        // render half-width in distorted units
uniform float uAspect;
uniform float uExposure;
uniform float uGain;        // analog gain multiplier (noise)
uniform float uIR;
uniform vec3 uWB;
uniform float uSat;
uniform float uTime;
uniform float uNoise;
uniform float uFocus;
uniform float uCA;
uniform float uDwdr;
uniform float uWdr;
uniform float uBloom;
uniform float uDnr;
uniform float uDirt;
uniform float uWeb;
uniform float uVisor;
uniform float uRainLens;
uniform float uAmbientIR;
uniform float uFrame;
uniform float uAnalog;
uniform vec3 uGTemp, uGShadow, uGHigh, uGLift, uGGamma, uGGain;
uniform float uGContrast, uGPivot, uGSat, uGVibrance, uGCompare;
uniform highp sampler3D uLut;
uniform float uLutSize, uLutAmount;
uniform vec3 uLutMin, uLutMax;
varying vec2 vUv;

float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gauss(vec2 p){ vec2 u = h22(p); return sqrt(-2.0 * log(max(u.x, 1e-6))) * cos(6.2831853 * u.y); }

vec2 distort(vec2 uv, float scale) {
  vec2 p = (uv - 0.5) * 2.0;
  p.y /= uAspect;
  float r2 = dot(p, p);
  vec2 s = p * (1.0 + uK * r2) * scale;
  s /= uSpan;
  s.y *= uAspect;
  return s * 0.5 + 0.5;
}

vec3 sampleScene(vec2 uv) {
  // lens: chromatic aberration grows toward the edges
  vec3 c;
  c.r = texture2D(tScene, distort(uv, 1.0 + uCA)).r;
  c.g = texture2D(tScene, distort(uv, 1.0)).g;
  c.b = texture2D(tScene, distort(uv, 1.0 - uCA)).b;
  return c;
}

void main() {
  vec2 uv = vUv;
  vec4 lens = texture2D(tLens, uv);
  // water drops on the dome refract
  uv += (lens.rg - 0.5) * 0.06 * lens.a * uRainLens;

  vec3 c = sampleScene(uv);
  if (any(isnan(c)) || any(isinf(c))) c = vec3(60000.0);
  if (uFocus < 0.99) {
    // soft focus: small ring of taps
    float r = (1.0 - uFocus) * 3.0 / uRes.x;
    vec3 acc = c;
    for (int i = 0; i < 6; i++) {
      float a = float(i) * 1.0472;
      acc += sampleScene(uv + vec2(cos(a), sin(a) * uAspect) * r);
    }
    c = acc / 7.0;
  }
  // vignetting (cos^4 + mechanical)
  vec2 pc = (vUv - 0.5) * vec2(1.0, 1.0 / uAspect) * 2.0;
  float vig = pow(max(0.0, 1.0 - 0.18 * dot(pc, pc)), 2.0);
  c *= vig;

  // exposure and bloom/veiling glare (dirt makes it worse)
  c *= uExposure;
  vec3 bloom = texture2D(tBloom, uv).rgb;
  c += bloom * (uBloom + uDirt * 0.12 + lens.b * 0.5);
  // general veiling glare from a dirty dome
  vec3 haze = vec3(exp(texture2D(tLocal, vec2(0.5)).r)) / max(uExposure, 1e-6);
  c += haze * uDirt * 0.04;

  // spider web lit by the IR LEDs / headlights
  c += vec3(lens.b * 0.0 + uWeb) * 0.0;

  // IR mode: monochrome, with near-IR-ish response; IR has less colour info
  float Y = dot(c, vec3(0.299, 0.587, 0.114));
  if (uIR > 0.5) c = vec3(dot(c, vec3(0.4, 0.35, 0.25)));

  // true WDR (multi-exposure sensor)
  // done on low-frequency luminance so local contrast (shadows, texture) survives;
  // mostly pulls highlights down, lifts deep shadows a little
  if (uWdr > 0.0) {
    float yl = max(localLum(uv), 1e-4);
    float e = yl > 0.18 ? -0.45 : -0.15;
    c *= pow(yl / 0.18, e * uWdr);
  }
  // DWDR: local tone mapping using a heavily blurred luminance -> halos
  float localY = localLum(uv);
  float comp = pow(max(localY, 0.02) / 0.35, -uDwdr * 0.45);
  c *= mix(1.0, clamp(comp, 0.55, 1.25), uDwdr);

  // white balance error, then the grade's colour temperature
  c *= uWB;
  bool graded = vUv.x >= uGCompare;
  if (uIR < 0.5 && graded) c *= uGTemp;

  // sensor noise (photon shot + read), scaled by analog gain
  vec2 px = floor(vUv * uRes);
  float seed = fract(uTime * 7.31) * 100.0;
  float lum = max(dot(c, vec3(0.333)), 0.0);
  float shot = sqrt(lum * uGain) * 0.0025 * uNoise;
  float read = 0.001 * uNoise * uGain;
  float nY = gauss(px + seed) * (shot + read);
  vec3 nC = vec3(gauss(px + seed + 17.0), gauss(px + seed + 31.0), gauss(px + seed + 47.0)) * (shot + read) * 0.45;
  if (uIR > 0.5) nC = vec3(0.0);
  c += nY + nC;
  // column fixed-pattern noise visible at high gain
  c += (h12(vec2(px.x, 3.0)) - 0.5) * 0.0035 * log2(max(1.0, uGain / 4.0)) * uNoise;
  // hot pixels
  if (uGain > 6.0 && h12(px * 1.37) > 0.99985) c += vec3(0.6, 0.2, 0.15) * (uIR > 0.5 ? 0.0 : 1.0) + 0.4;

  // camera tone curve: extended Reinhard (white at 4x mid range) in linear,
  // Rec.709-like encode, then a mild S for the punchy look of consumer ISPs
  // filmic curve (ACES fit) on luminance: a toe that keeps real blacks and a
  // shoulder that still reaches ~90% for sunlit walls; hue kept by scaling RGB
  c = max(c, 0.0) * 0.8;
  float Yl = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float Yt = (Yl * (2.51 * Yl + 0.03)) / (Yl * (2.43 * Yl + 0.59) + 0.14);
  c = c * (Yt / max(Yl, 1e-6));
  // channels pushed past white bleed into the others instead of clipping to a hue
  float over = max(max(c.r, c.g), c.b);
  if (over > 1.0) c = mix(c / over, vec3(1.0), clamp((over - 1.0) * 0.5, 0.0, 1.0));
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
  // saturation (ISPs push it a little)
  float y2 = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(y2), c, uSat * 1.12 * (uIR > 0.5 ? 0.0 : 1.0));

  // colour grading (display-referred): split toning, lift/gamma/gain wheels,
  // contrast, saturation, vibrance. In IR mode only the luminance part applies.
  if (graded) {
    float colour = uIR > 0.5 ? 0.0 : 1.0;
    vec3 lift = mix(vec3(dot(uGLift, vec3(0.3333))), uGLift, colour);
    vec3 gam = mix(vec3(dot(uGGamma, vec3(0.3333))), uGGamma, colour);
    vec3 gain = mix(vec3(dot(uGGain, vec3(0.3333))), uGGain, colour);
    float yg = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c += (uGShadow * (1.0 - smoothstep(0.08, 0.5, yg)) + uGHigh * smoothstep(0.4, 0.9, yg)) * colour;
    c = c * gain + lift * (1.0 - c);
    c = pow(max(c, 0.0), 1.0 / max(gam, vec3(0.05)));
    // contrast as an S around the pivot that eases into black and white
    vec3 cc = clamp(c, 0.0, 1.0);
    c = mix(uGPivot * pow(cc / uGPivot, vec3(uGContrast)), 1.0 - (1.0 - uGPivot) * pow((1.0 - cc) / (1.0 - uGPivot), vec3(uGContrast)), step(uGPivot, cc));
    float mxv = max(c.r, max(c.g, c.b)), mnv = min(c.r, min(c.g, c.b));
    float yv = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(yv), c, (uGSat + uGVibrance * (1.0 - clamp((mxv - mnv) * 1.5, 0.0, 1.0))) * colour + (1.0 - colour));
    // 3D LUT (.cube), sampled at texel centres, on the display-encoded image
    if (uLutAmount > 0.0) {
      vec3 lc = clamp((c - uLutMin) / (uLutMax - uLutMin), 0.0, 1.0);
      vec3 l = texture(uLut, lc * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
      if (uIR > 0.5) l = vec3(dot(l, vec3(0.2126, 0.7152, 0.0722)));
      c = mix(c, l, uLutAmount);
    }
  }
  // before/after divider
  if (uGCompare > 0.0 && abs(vUv.x - uGCompare) < 0.6 / uRes.x) c = vec3(1.0);

  // sunshield (visor) edge at the top of the frame, out of focus
  if (uVisor > 0.0) {
    float edge = smoothstep(0.05 * uVisor + 0.02, 0.05 * uVisor - 0.03, 1.0 - vUv.y + 0.03 * sin(vUv.x * 3.0));
    vec3 vis = vec3(0.04) + vec3(0.25) * uIR * uAmbientIR;
    c = mix(c, vis, edge);
  }

  // 3D noise reduction: blend with previous frame where little changed -> ghost trails
  vec3 prev = texture2D(tPrev, vUv).rgb;
  if (any(isnan(prev))) prev = c;
  float diff = length(c - prev);
  // the motion threshold follows the expected noise level, so noise is averaged, motion is not
  float nsig = (0.0025 * sqrt(0.2 * uGain) + 0.001 * uGain) * uNoise * 5.0;
  float k = uDnr * (1.0 - smoothstep(0.03 + 2.5 * nsig, 0.12 + 0.1 * uDnr + 5.0 * nsig, diff));
  c = mix(c, prev, k);

  // analog cameras: line jitter and soft horizontal resolution
  if (uAnalog > 0.5) {
    c += (h12(vec2(px.y, floor(uTime * 30.0))) - 0.5) * 0.02;
  }
  if (any(isnan(c))) c = vec3(1.0);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// OSD + sharpening + RGB -> YCbCr (JPEG range, centred)
const PRE_FS = /* glsl */ `
uniform sampler2D tSrc, tOSD;
uniform vec2 uTexel;
uniform float uSharp;
uniform float uChromaBlur;
varying vec2 vUv;
vec3 toYCC(vec3 c){
  c *= 255.0;
  return vec3(0.299 * c.r + 0.587 * c.g + 0.114 * c.b - 128.0,
              -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b,
              0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb
         + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 wide = texture2D(tSrc, vUv + uTexel * vec2(2.0, 2.0)).rgb + texture2D(tSrc, vUv - uTexel * vec2(2.0, 2.0)).rgb
            + texture2D(tSrc, vUv + uTexel * vec2(-2.0, 2.0)).rgb + texture2D(tSrc, vUv - uTexel * vec2(-2.0, 2.0)).rgb;
  vec3 blur = (n * 0.75 + wide * 0.25) / 4.0;
  // aggressive unsharp mask, typical of cheap ISPs (white halos on edges)
  vec3 s = c + (c - blur) * uSharp;
  // OSD is burnt in before encoding
  vec4 osd = texture2D(tOSD, vUv);
  s = mix(s, osd.rgb, osd.a);
  vec3 ycc = toYCC(clamp(s, 0.0, 1.0));
  // 4:2:0 chroma: average chroma over 2x2
  vec2 base = (floor(gl_FragCoord.xy / 2.0) * 2.0 + 1.0) * uTexel;
  vec3 cAvg = vec3(0.0);
  cAvg += toYCC(texture2D(tSrc, base + uTexel * vec2(-0.5, -0.5)).rgb);
  cAvg += toYCC(texture2D(tSrc, base + uTexel * vec2(0.5, -0.5)).rgb);
  cAvg += toYCC(texture2D(tSrc, base + uTexel * vec2(-0.5, 0.5)).rgb);
  cAvg += toYCC(texture2D(tSrc, base + uTexel * vec2(0.5, 0.5)).rgb);
  ycc.yz = mix(ycc.yz, cAvg.yz * 0.25, uChromaBlur);
  gl_FragColor = vec4(ycc, 1.0);
}`;

// OSD + sharpening, RGB out: what the camera hands to the real encoder
const PREOUT_FS = /* glsl */ `
uniform sampler2D tSrc, tOSD;
uniform vec2 uTexel;
uniform float uSharp;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb;
  vec3 n = texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb
         + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 wide = texture2D(tSrc, vUv + uTexel * vec2(2.0, 2.0)).rgb + texture2D(tSrc, vUv - uTexel * vec2(2.0, 2.0)).rgb
            + texture2D(tSrc, vUv + uTexel * vec2(-2.0, 2.0)).rgb + texture2D(tSrc, vUv - uTexel * vec2(-2.0, 2.0)).rgb;
  vec3 blur = (n * 0.75 + wide * 0.25) / 4.0;
  vec3 s = c + (c - blur) * uSharp;
  vec4 osd = texture2D(tOSD, vUv);
  s = mix(s, osd.rgb, osd.a);
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const DCT_COMMON = /* glsl */ `
uniform sampler2D tSrc;
float cK(int k){ return k == 0 ? 0.35355339 : 0.5; }
float cosT(int n, int k){ return cos(float(2 * n + 1) * float(k) * 0.19634954); }
`;

// forward DCT along rows
const DCT_ROW_FS = DCT_COMMON + /* glsl */ `
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int bx = (p.x / 8) * 8; int k = p.x - bx;
  vec3 acc = vec3(0.0);
  for (int n = 0; n < 8; n++) acc += texelFetch(tSrc, ivec2(bx + n, p.y), 0).rgb * cosT(n, k);
  gl_FragColor = vec4(acc * cK(k), 1.0);
}`;

// forward DCT along columns + quantisation (+ dequantisation)
const DCT_COL_Q_FS = DCT_COMMON + /* glsl */ `
uniform float uQ;      // quality scale (1 = q50)
uniform float uQC;     // chroma scale
uniform float uDeadzone;
const float QL[64] = float[64](16.,11.,10.,16.,24.,40.,51.,61.,12.,12.,14.,19.,26.,58.,60.,55.,14.,13.,16.,24.,40.,57.,69.,56.,14.,17.,22.,29.,51.,87.,80.,62.,18.,22.,37.,56.,68.,109.,103.,77.,24.,35.,55.,64.,81.,104.,113.,92.,49.,64.,78.,87.,103.,121.,120.,101.,72.,92.,95.,98.,112.,100.,103.,99.);
const float QC[64] = float[64](17.,18.,24.,47.,99.,99.,99.,99.,18.,21.,26.,66.,99.,99.,99.,99.,24.,26.,56.,99.,99.,99.,99.,99.,47.,66.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.,99.);
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int by = (p.y / 8) * 8; int l = p.y - by;
  int k = p.x - (p.x / 8) * 8;
  vec3 acc = vec3(0.0);
  for (int m = 0; m < 8; m++) acc += texelFetch(tSrc, ivec2(p.x, by + m), 0).rgb * cosT(m, l);
  acc *= cK(l);
  // texture rows go bottom-up; JPEG tables are top-down, k = column, l = row
  int qi = l * 8 + k;
  float ql = max(1.0, QL[qi] * uQ);
  float qc = max(1.0, QC[qi] * uQ * uQC);
  vec3 q = vec3(ql, qc, qc);
  vec3 v = acc / q;
  // dead zone: encoders kill small coefficients more than plain rounding would
  v = sign(v) * floor(abs(v) + 0.5 - uDeadzone);
  v = max(v, vec3(-2048.0));
  gl_FragColor = vec4(v * q, 1.0);
}`;

const IDCT_COL_FS = DCT_COMMON + /* glsl */ `
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int by = (p.y / 8) * 8; int m = p.y - by;
  vec3 acc = vec3(0.0);
  for (int l = 0; l < 8; l++) acc += cK(l) * texelFetch(tSrc, ivec2(p.x, by + l), 0).rgb * cosT(m, l);
  gl_FragColor = vec4(acc, 1.0);
}`;

const IDCT_ROW_FS = DCT_COMMON + /* glsl */ `
uniform sampler2D tPrev;   // previous decoded frame (RGB)
uniform sampler2D tSource; // pre-coding YCbCr of this frame
uniform float uSkip;       // P-frame skip threshold (0 = I-frame)
uniform float uDeblock;
vec3 toRGB(vec3 y){
  float Y = y.x + 128.0;
  return vec3(Y + 1.402 * y.z, Y - 0.344136 * y.y - 0.714136 * y.z, Y + 1.772 * y.y) / 255.0;
}
vec3 toYCC(vec3 c){
  c *= 255.0;
  return vec3(0.299 * c.r + 0.587 * c.g + 0.114 * c.b - 128.0, -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}
vec3 decodeAt(ivec2 p){
  int bx = (p.x / 8) * 8; int n = p.x - bx;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 8; k++) acc += cK(k) * texelFetch(tSrc, ivec2(bx + k, p.y), 0).rgb * cosT(n, k);
  return acc;
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 ycc = decodeAt(p);
  // light deblocking across block edges
  int ex = p.x - (p.x / 8) * 8, ey = p.y - (p.y / 8) * 8;
  if (uDeblock > 0.0 && (ex == 0 || ex == 7)) {
    vec3 o = decodeAt(p + ivec2(ex == 0 ? -1 : 1, 0));
    ycc = mix(ycc, (ycc + o) * 0.5, uDeblock);
  }
  vec3 rgb = toRGB(ycc);
  if (uSkip > 0.0) {
    // macroblock (16x16) skip decision taken by comparing the source with the reference
    ivec2 mb = (p / 16) * 16;
    float d = 0.0;
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      ivec2 q = mb + ivec2(i * 4 + 2, j * 4 + 2);
      vec3 s = texelFetch(tSource, q, 0).rgb;
      vec3 r = toYCC(texelFetch(tPrev, q, 0).rgb);
      d += abs(s.x - r.x) + 0.5 * (abs(s.y - r.y) + abs(s.z - r.z));
    }
    d /= 16.0;
    if (d < uSkip) rgb = texelFetch(tPrev, p, 0).rgb;
  }
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const PRESENT_FS = /* glsl */ `
uniform sampler2D tSrc; varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`;

export class CCTVCamera {
  constructor(renderer, spec, seed) {
    this.renderer = renderer;
    this.spec = spec;
    this.rng = new Rng(seed + '/cam-pipeline');
    const [W, H] = spec.res;
    this.W = W; this.H = H;
    this.aspect = W / H;
    const k = spec.k;
    this.k = k;
    // render span so the distorted frame corners are covered
    this.span = 1 + k * (1 + 1 / (this.aspect * this.aspect));
    const tanH = Math.tan(THREE.MathUtils.degToRad(spec.hfov / 2)) / (1 + k);
    const renderTanH = tanH * this.span;
    const vfov = 2 * Math.atan(renderTanH / this.aspect);
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(vfov), this.aspect, 0.1, 4000);
    this.camera.layers.enableAll();

    // render at sensor resolution (MSAA 4x + FXAA); ?ss=1.35 brings back supersampling
    const ss = Math.min(+(new URLSearchParams(location.search).get('ss') || 1), 3300 / W);
    const RW = Math.round(W * ss), RH = Math.round(H * ss);
    // depth kept as a texture: SSAO reads it after the pass (see env/ssao.js)
    this.sceneRT = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: new THREE.DepthTexture(RW, RH) });
    this.lumRT = rt(64, 36, THREE.FloatType, THREE.NearestFilter);
    this.colRT = rt(64, 36, THREE.FloatType, THREE.NearestFilter);
    this.awb = [1, 1, 1];
    this.awbTarget = [1, 1, 1];
    this.bloomRTs = [];
    let bw = Math.ceil(W / 2), bh = Math.ceil(H / 2);
    for (let i = 0; i < 6; i++) { this.bloomRTs.push(rt(bw, bh)); bw = Math.max(1, Math.ceil(bw / 2)); bh = Math.max(1, Math.ceil(bh / 2)); }
    this.bloomUp = this.bloomRTs.map(r => rt(r.width, r.height));
    this.ispRT = [rt(W, H), rt(W, H)];
    this.yccRT = rt(W, H, THREE.FloatType, THREE.NearestFilter);
    this.dctA = rt(W, H, THREE.FloatType, THREE.NearestFilter);
    this.dctB = rt(W, H, THREE.FloatType, THREE.NearestFilter);
    this.outRT = [rt(W, H, THREE.UnsignedByteType, THREE.LinearFilter), rt(W, H, THREE.UnsignedByteType, THREE.LinearFilter)];
    this.ping = 0;

    this.pBright = pass(BRIGHT_FS, { tSrc: { value: null }, uExposure: { value: 1 }, uTexel: { value: new THREE.Vector2() } });
    this.pDown = pass(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.pUp = pass(UP_FS, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 1 } });
    this.pLum = pass(LUM_FS, { tSrc: { value: null } });
    this.pCol = pass(COL_FS, { tSrc: { value: null }, uExposure: { value: 1 } });
    this.lens = makeLensTexture(this.rng, spec, W, H);
    this.pIsp = pass(ISP_FS, {
      tScene: { value: null }, tBloom: { value: null }, tPrev: { value: null }, tLens: { value: this.lens }, tLocal: { value: null }, uLocalTexel: { value: new THREE.Vector2() },
      uRes: { value: new THREE.Vector2(W, H) }, uK: { value: k }, uSpan: { value: this.span }, uAspect: { value: this.aspect },
      uExposure: { value: 1 }, uGain: { value: 1 }, uIR: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: spec.sat },
      uTime: { value: 0 }, uNoise: { value: spec.sensor }, uFocus: { value: spec.focus }, uCA: { value: 0.0004 + k * 0.0012 },
      uDwdr: { value: spec.dwdr }, uWdr: { value: spec.wdr || 0 }, uBloom: { value: spec.tier === 'budget' ? 0.035 : 0.015 }, uDnr: { value: 0.3 }, uDirt: { value: spec.dirt }, uWeb: { value: spec.web ? 1 : 0 },
      uVisor: { value: 0 }, uRainLens: { value: 0 }, uAmbientIR: { value: 0 }, uFrame: { value: 0 },
      uAnalog: { value: spec.analog ? 1 : 0 },
      ...GRADE,
    });
    this.pFxaa = pass(FXAA_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2(1 / RW, 1 / RH) }, uExposure: { value: 1 }, uSub: { value: 0.6 } });
    this.aaRT = rt(RW, RH);
    this.fxaa = true;
    this.osd = new OSD(spec, W, H);
    this.pPre = pass(PRE_FS, { tSrc: { value: null }, tOSD: { value: this.osd.texture }, uTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uSharp: { value: spec.sharp }, uChromaBlur: { value: 1 } });
    this.pDctR = pass(DCT_ROW_FS, { tSrc: { value: null } });
    this.pDctC = pass(DCT_COL_Q_FS, { tSrc: { value: null }, uQ: { value: 1 }, uQC: { value: 1.3 }, uDeadzone: { value: 0.2 } });
    this.pIdctC = pass(IDCT_COL_FS, { tSrc: { value: null } });
    this.pIdctR = pass(IDCT_ROW_FS, { tSrc: { value: null }, tPrev: { value: null }, tSource: { value: null }, uSkip: { value: 0 }, uDeblock: { value: 0.35 } });
    this.pPresent = pass(PRESENT_FS, { tSrc: { value: null } });
    this.pPreOut = pass(PREOUT_FS, { tSrc: { value: null }, tOSD: { value: this.osd.texture }, uTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uSharp: { value: spec.sharp } });
    // 'real': WebCodecs encoder downstream; 'emulated': in-shader DCT fallback
    this.codecMode = 'emulated';

    this.visorAmount = this.rng.float(0.4, 1.2);
    this.live = { irMode: 'auto', exposureBias: 0 };
    this.applyLive({});
    // auto exposure state
    this.exposure = 0.05;
    this.gain = 1;
    this.irMode = false;
    this.nightMode = false;
    this.lumPending = false;
    this.logAvg = Math.log(10);
    this.frame = 0;
    this.lastCapture = -1;
    this.complexity = 1;
    this.irSwitchTime = -10;
  }

  // Exposure control: target mid grey, limited by shutter and gain like a real sensor.
  updateExposure(dt) {
    const avg = Math.exp(this.logAvg);
    // in low light the AE aims darker to keep noise down (typical -1..-1.5 EV at high gain)
    const nightBias = 1 / (1 + 0.3 * Math.log2(Math.max(1, this.gain)));
    const target = 0.19 * nightBias / Math.max(avg, 1e-6);
    // max exposure at full gain: in our units ~0.0004 klux scene luminance maps to mid grey
    const maxExp = 900 * this.spec.gain * (this.spec.starlight || 1);  // shutter 1/30 + 48 dB (+ sensor sensitivity)
    const minExp = 0.0005;
    const desired = THREE.MathUtils.clamp(target, minExp, maxExp);
    const err = Math.log(desired) - Math.log(this.exposure);
    if (Math.abs(err) > 0.25) this.aeActive = true;
    if (this.aeActive) {
      const rate = 1 - Math.exp(-dt * 2.2);
      this.exposure = Math.exp(Math.log(this.exposure) + err * rate);
      if (Math.abs(err) < 0.04) this.aeActive = false;
    }
    // gain = the part of the exposure that the shutter cannot cover
    const shutterLimit = 25;
    this.gain = Math.max(1, this.exposure / (shutterLimit * (this.spec.starlight || 1)));
  }

  async readLuminance() {
    if (this.lumPending) return;
    this.lumPending = true;
    try {
      const buf = new Float32Array(64 * 36 * 4);
      await this.renderer.readRenderTargetPixelsAsync(this.lumRT, 0, 0, 64, 36, buf);
      const cb = new Float32Array(64 * 36 * 4);
      await this.renderer.readRenderTargetPixelsAsync(this.colRT, 0, 0, 64, 36, cb);
      this.applyMetering(buf, cb);
    } catch (e) { /* ignore */ }
    this.lumPending = false;
  }

  // power-on metering: blocking read so the first frames already have the right
  // exposure and white balance instead of drifting into place
  meterNow() {
    const buf = new Float32Array(64 * 36 * 4), cb = new Float32Array(64 * 36 * 4);
    this.renderer.readRenderTargetPixels(this.lumRT, 0, 0, 64, 36, buf);
    this.renderer.readRenderTargetPixels(this.colRT, 0, 0, 64, 36, cb);
    this.applyMetering(buf, cb);
  }

  applyMetering(buf, cb) {
    {
      let sl = 0, sw = 0;
      for (let i = 0; i < 64 * 36; i++) { sl += buf[i * 4]; sw += buf[i * 4 + 1]; }
      if (sw > 0) this.logAvg = sl / sw;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < 64 * 36; i++) { r += cb[i * 4]; g += cb[i * 4 + 1]; b += cb[i * 4 + 2]; w += cb[i * 4 + 3]; }
      if (w > 20 && r > 0 && b > 0) {
        // partial grey world: cheap AWB leaves some of the cast in
        const k = 0.45;
        this.awbTarget = [THREE.MathUtils.clamp(Math.pow(g / r, k), 0.6, 1.7), 1, THREE.MathUtils.clamp(Math.pow(g / b, k), 0.6, 1.7)];
      }
    }
  }

  // true when capture() at time t would take a frame
  isDue(t) { return this.lastCapture < 0 || t - this.lastCapture >= (1 / this.spec.fps) * 0.999; }

  // ambientLux: scene illuminance estimate (for the IR-cut switch)
  capture(scene, t, dt, env) {
    const r = this.renderer;
    const spec = this.spec;
    const capDt = 1 / spec.fps;
    if (t - this.lastCapture < capDt * 0.999 && this.lastCapture >= 0) return false;
    const frameDt = this.lastCapture < 0 ? capDt : t - this.lastCapture;
    // keep to the camera's own clock: a frame taken late (display frames do not
    // line up with 1/fps) does not push the next one later, so 15 fps stays 15
    this.lastCapture = this.lastCapture >= 0 && frameDt < capDt * 2 ? this.lastCapture + capDt : t;
    this.frame++;

    // IR cut filter: switch on illuminance, with hysteresis
    const lux = env.ambientLux;
    let dark = this.nightMode ? lux < spec.irThreshold * 3 : lux < spec.irThreshold;
    if (this.live.irMode !== 'auto') { dark = this.live.irMode === 'ir'; this.irSwitchTime = -10; }
    if (dark !== !!this.nightMode && t - this.irSwitchTime > 4) { this.nightMode = dark; this.irSwitchTime = t; }
    this.irMode = this.nightMode && !spec.nightColor;
    if (this.setIRHook !== false) env.setIR(this.irMode, this.nightMode);

    prof.begin('pre');
    this.preRender?.(scene, this.camera, this.sceneRT.width, this.sceneRT.height);
    prof.end();
    prof.begin('scene');
    r.setRenderTarget(this.sceneRT);
    r.clear();
    // shadow maps are redrawn only when asked for (renderer.shadowMap.autoUpdate is off)
    if (this.shadowDue) { r.shadowMap.needsUpdate = true; this.shadowDue = false; }
    r.render(scene, this.camera);
    r.shadowMap.needsUpdate = false;
    prof.end();
    prof.begin('ssao');
    this.postRender?.(this.sceneRT.depthTexture, this.camera, this.sceneRT.width, this.sceneRT.height);
    prof.end();
    prof.begin('post');
    // FXAA on the scene (shader aliasing: wires, foliage cutouts, specular)
    let sceneTex = this.sceneRT.texture;
    if (this.fxaa) {
      const fu = this.pFxaa.material.uniforms;
      fu.tSrc.value = sceneTex;
      fu.uExposure.value = this.exposure * Math.pow(2, this.live.exposureBias);
      r.setRenderTarget(this.aaRT); this.pFxaa.render(r);
      sceneTex = this.aaRT.texture;
    }

    // luminance for AE
    this.pLum.material.uniforms.tSrc.value = sceneTex;
    r.setRenderTarget(this.lumRT); this.pLum.render(r);
    this.pCol.material.uniforms.tSrc.value = sceneTex;
    this.pCol.material.uniforms.uExposure.value = this.exposure;
    r.setRenderTarget(this.colRT); this.pCol.render(r);
    if (this.frame <= 3) {
      // boot: meter synchronously and jump straight to the settled exposure / white balance
      this.meterNow();
      for (let k = 0; k < 4; k++) { this.aeActive = true; this.updateExposure(100); }
      this.awb = this.awbTarget.slice();
      this.pCol.material.uniforms.uExposure.value = this.exposure;
      r.setRenderTarget(this.colRT); this.pCol.render(r);
    } else {
      if (this.frame % 3 === 0) this.readLuminance();
      for (let i = 0; i < 3; i++) this.awb[i] += (this.awbTarget[i] - this.awb[i]) * Math.min(1, frameDt * 0.8);
      this.updateExposure(frameDt);
    }

    // bloom chain
    const B = this.bloomRTs;
    this.pBright.material.uniforms.tSrc.value = sceneTex;
    this.pBright.material.uniforms.uExposure.value = this.exposure;
    this.pBright.material.uniforms.uTexel.value.set(0.5 / this.W, 0.5 / this.H);
    r.setRenderTarget(B[0]); this.pBright.render(r);
    for (let i = 1; i < B.length; i++) {
      this.pDown.material.uniforms.tSrc.value = B[i - 1].texture;
      this.pDown.material.uniforms.uTexel.value.set(1 / B[i - 1].width, 1 / B[i - 1].height);
      r.setRenderTarget(B[i]); this.pDown.render(r);
    }
    let src = B[B.length - 1];
    for (let i = B.length - 2; i >= 0; i--) {
      this.pUp.material.uniforms.tSrc.value = src.texture;
      this.pUp.material.uniforms.tBase.value = B[i].texture;
      this.pUp.material.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pUp.material.uniforms.uMix.value = 1.0;
      r.setRenderTarget(this.bloomUp[i]); this.pUp.render(r);
      src = this.bloomUp[i];
    }

    prof.end();
    prof.begin('isp');
    // ISP
    const u = this.pIsp.material.uniforms;
    const prev = this.ispRT[this.ping], next = this.ispRT[1 - this.ping];
    u.tScene.value = sceneTex;
    u.tBloom.value = this.bloomUp[0].texture;
    u.tPrev.value = prev.texture;
    u.tLocal.value = B[4].texture;
    // local luminance should be the un-thresholded blur: approximate with a deep bloom level of the scene
    u.tLocal.value = this.localLum(r, sceneTex);
    u.uExposure.value = this.exposure * Math.pow(2, this.live.exposureBias);
    u.uGain.value = this.gain;
    u.uIR.value = this.irMode ? 1 : 0;
    u.uTime.value = t;
    u.uFrame.value = this.frame;
    u.uDnr.value = this.frame <= 3 ? 0 : THREE.MathUtils.clamp(0.5 + Math.log2(this.gain) * 0.06, 0.5, 0.82);
    const wb = this.irMode ? [1, 1] : spec.wbError;
    const warmCast = env.wbCast || 0; // auto WB fails under sodium light
    const awb = this.irMode ? [1, 1, 1] : this.awb;
    u.uWB.value.set(awb[0] * (1 + wb[0] + warmCast * 0.15), awb[1], awb[2] * (1 - wb[1] - warmCast * 0.2));
    u.uRainLens.value = env.rainOnLens || 0;
    u.uAmbientIR.value = this.irMode ? 1 : 0;
    r.setRenderTarget(next); this.pIsp.render(r);
    this.ping = 1 - this.ping;
    prof.end();

    if (!this.hideOSD) this.osd.update(env.clockDate, spec);
    if (this.codecMode === 'real') {
      // hand the frame to the real encoder: draw it into the (hidden) WebGL canvas
      this.pPreOut.material.uniforms.tSrc.value = next.texture;
      r.setRenderTarget(null);
      this.pPreOut.render(r);
      return true;
    }
    // OSD + sharpen + YCbCr
    this.pPre.material.uniforms.tSrc.value = next.texture;
    r.setRenderTarget(this.yccRT); this.pPre.render(r);

    // block coding
    const gopPos = this.frame % spec.gop;
    // forceIntra (one shot): the generator (src/gen.js) asks for an I-frame when it
    // labels moving vehicles (a P-frame copies blocks of the previous frame and
    // smears them) and on a camera's very first frame (nothing to predict from yet)
    const iFrame = gopPos === 0 || !!this.forceIntra;
    this.forceIntra = false;
    this.lastIntra = iFrame;
    // bits per pixel per frame drive the quantiser
    const bpp = spec.kbps * 1000 / (spec.fps * this.W * this.H);
    const noiseLoad = 1 + Math.max(0, Math.log2(this.gain)) * 0.25 + (env.rainOnLens || 0) * 0.3;
    let q = THREE.MathUtils.clamp(0.06 / bpp * noiseLoad, 0.25, 9);
    if (spec.codec === 'H.265') q *= 0.7;
    if (!iFrame) q *= 1.15;
    this.pDctR.material.uniforms.tSrc.value = this.yccRT.texture;
    r.setRenderTarget(this.dctA); this.pDctR.render(r);
    this.pDctC.material.uniforms.tSrc.value = this.dctA.texture;
    this.pDctC.material.uniforms.uQ.value = q;
    this.pDctC.material.uniforms.uDeadzone.value = THREE.MathUtils.clamp(0.1 + q * 0.04, 0.1, 0.35);
    r.setRenderTarget(this.dctB); this.pDctC.render(r);
    this.pIdctC.material.uniforms.tSrc.value = this.dctB.texture;
    r.setRenderTarget(this.dctA); this.pIdctC.render(r);
    const outPrev = this.outRT[this.frame % 2], out = this.outRT[1 - this.frame % 2];
    const ui = this.pIdctR.material.uniforms;
    ui.tSrc.value = this.dctA.texture;
    ui.tPrev.value = outPrev.texture;
    ui.tSource.value = this.yccRT.texture;
    ui.uSkip.value = iFrame ? 0 : THREE.MathUtils.clamp(1.2 + q * 1.4, 1.0, 14);
    ui.uDeblock.value = THREE.MathUtils.clamp(q * 0.12, 0.1, 0.5);
    r.setRenderTarget(out); this.pIdctR.render(r);
    this.output = out;
    this.lastQ = q;
    return true;
  }

  // blurred scene luminance (pre-threshold) for DWDR: reuse a separate tiny chain
  localLum(r, src) {
    if (!this.localRT) {
      this.localRT = [rt(Math.ceil(this.W / 16), Math.ceil(this.H / 16), THREE.HalfFloatType), rt(Math.ceil(this.W / 64), Math.ceil(this.H / 64), THREE.HalfFloatType)];
    }
    if (!this.pLogLum) this.pLogLum = pass(LOGLUM_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: 1 } });
    const lu = this.pLogLum.material.uniforms;
    lu.tSrc.value = src;
    lu.uTexel.value.set(4 / this.sceneRT.width, 4 / this.sceneRT.height);
    lu.uExposure.value = this.exposure * Math.pow(2, this.live.exposureBias);
    r.setRenderTarget(this.localRT[0]); this.pLogLum.render(r);
    this.pDown.material.uniforms.tSrc.value = this.localRT[0].texture;
    this.pDown.material.uniforms.uTexel.value.set(2 / this.localRT[0].width, 2 / this.localRT[0].height);
    r.setRenderTarget(this.localRT[1]); this.pDown.render(r);
    this.pIsp.material.uniforms.uLocalTexel.value.set(1 / this.localRT[1].width, 1 / this.localRT[1].height);
    return this.localRT[1].texture;
  }

  // UI overrides that do not need new render targets; -1 / 'auto' keep the model value
  applyLive(cfg) {
    const { lens = {}, isp = {} } = cfg;
    const spec = this.spec;
    const u = this.pIsp.material.uniforms;
    const pick = (v, d) => (v === undefined || v < 0 ? d : v);
    u.uFocus.value = pick(lens.focus, spec.focus);
    u.uNoise.value = pick(isp.noise, spec.sensor);
    u.uSat.value = pick(isp.sat, spec.sat);
    u.uDwdr.value = pick(isp.dwdr, spec.dwdr);
    const visor = lens.visor === undefined || lens.visor === 'auto' ? spec.visor : lens.visor === 'yes';
    u.uVisor.value = visor ? this.visorAmount : 0;
    const sharp = pick(isp.sharp, spec.sharp);
    this.pPre.material.uniforms.uSharp.value = sharp;
    this.pPreOut.material.uniforms.uSharp.value = sharp;
    this.live.irMode = isp.irMode || 'auto';
    this.live.exposureBias = isp.exposureBias || 0;
    this.fxaa = (cfg.grade?.fxaa ?? 'yes') !== 'no';
    if (cfg.grade) applyGrade(cfg.grade);
  }

  present() {
    if (!this.output) return;
    const r = this.renderer;
    this.pPresent.material.uniforms.tSrc.value = this.output.texture;
    r.setRenderTarget(null);
    this.pPresent.render(r);
  }

  dispose() {
    for (const x of [this.sceneRT, this.aaRT, this.lumRT, this.colRT, ...this.bloomRTs, ...this.bloomUp, ...this.ispRT, this.yccRT, this.dctA, this.dctB, ...this.outRT, ...(this.localRT || [])]) x.dispose();
    this.osd.texture.dispose();
    this.lens.dispose();
  }
}

// ------------------------------------------------------------------ OSD
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
class OSD {
  constructor(spec, W, H) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.g = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.last = '';
    this.rects = [];             // [x0, y0, x1, y1] of each text, px from the top left
  }
  update(date, spec) {
    const d = new Date(date.getTime() + spec.timeOffset * 1000);
    const p = n => String(n).padStart(2, '0');
    // date is already local wall-clock time stored in UTC fields
    const Y = d.getUTCFullYear(), M = p(d.getUTCMonth() + 1), D = p(d.getUTCDate());
    const hh = p(d.getUTCHours()), mm = p(d.getUTCMinutes()), ss = p(d.getUTCSeconds());
    const dow = DOW[d.getUTCDay()];
    let text;
    switch (spec.osd.fmt) {
      case 'ymd': text = `${Y}-${M}-${D} ${hh}:${mm}:${ss}`; break;
      case 'dmy-slash': text = `${D}/${M}/${Y} ${hh}:${mm}:${ss}`; break;
      case 'mdy-dow': text = `${M}-${D}-${Y} ${dow.toUpperCase()} ${hh}:${mm}:${ss}`; break;
      default: text = `${D}-${M}-${Y} ${dow} ${hh}:${mm}:${ss}`;
    }
    if (text === this.last) return;
    this.last = text;
    const { g, canvas } = this;
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    this.rects = [];
    const size = Math.round(H * 0.034 * spec.osd.scale);
    g.font = `${size}px "Consolas", "Lucida Console", monospace`;
    g.textBaseline = 'top';
    g.lineJoin = 'round';
    const draw = (s, x, y, align) => {
      g.textAlign = align;
      g.lineWidth = Math.max(2, size * 0.14);
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.strokeText(s, x, y);
      g.fillStyle = '#ffffff';
      g.fillText(s, x, y);
      const w = g.measureText(s).width, pad = g.lineWidth;
      const x0 = align === 'right' ? x - w : x;
      this.rects.push([x0 - pad, y - pad, x0 + w + pad, y + size * 1.15 + pad]);
    };
    const m = Math.round(H * 0.03);
    if (spec.osd.pos === 'tr') draw(text, W - m, m, 'right'); else draw(text, m, m, 'left');
    if (spec.osd.showName) {
      const y = H - m - size;
      if (spec.osd.namePos === 'bl') draw(spec.osd.name, m, y, 'left'); else draw(spec.osd.name, W - m, y, 'right');
    }
    this.texture.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ lens texture
// RG: drop normal, B: dirt / smudge density (scatters light), A: drop mask
function makeLensTexture(rng, spec, W, H) {
  const w = 512, h = Math.round(512 * H / W);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const data = img.data;
  for (let i = 0; i < w * h; i++) { data[i * 4] = 128; data[i * 4 + 1] = 128; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0; }
  // dirt blobs
  const dirtN = Math.floor(spec.dirt * 60);
  const dirt = new Float32Array(w * h);
  for (let k = 0; k < dirtN; k++) {
    const cx = rng.float(0, w), cy = rng.float(0, h), r = rng.float(4, 40), s = rng.float(0.1, 0.5);
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d < 1) dirt[y * w + x] += s * (1 - d * d);
      }
  }
  // spider web: radial + spiral strands near a corner, out of focus
  if (spec.web) {
    const cx = rng.pick([rng.float(0, w * 0.25), rng.float(w * 0.75, w)]), cy = rng.float(h * 0.05, h * 0.4);
    const spokes = rng.int(5, 9);
    const R = rng.float(w * 0.2, w * 0.45);
    const plot = (x, y, a) => {
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const X = Math.round(x + ox), Y = Math.round(y + oy);
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        dirt[Y * w + X] += a * Math.exp(-(ox * ox + oy * oy) / 3);
      }
    };
    for (let s = 0; s < spokes; s++) {
      const a = s / spokes * Math.PI * 2 + rng.float(-0.2, 0.2);
      for (let t = 0; t < R; t += 1.5) plot(cx + Math.cos(a) * t, cy + Math.sin(a) * t + t * t * 0.0008, 0.05);
    }
    for (let t = 0; t < 40 * Math.PI; t += 0.02) {
      const rr = R * 0.1 + t * R / (40 * Math.PI) * 0.9;
      plot(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr * 0.9, 0.012);
    }
  }
  for (let i = 0; i < w * h; i++) data[i * 4 + 2] = Math.min(255, dirt[i] * 255);
  // water drops (used only when it rains on an unsheltered dome)
  const drops = rng.int(15, 45);
  for (let k = 0; k < drops; k++) {
    const cx = rng.float(0, w), cy = rng.float(0, h), r = rng.float(3, 16);
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
        const dx = (x - cx) / r, dy = (y - cy) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const i = (y * w + x) * 4;
        data[i] = 128 + dx * 120; data[i + 1] = 128 - dy * 120; data[i + 3] = 255;
      }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = true;
  return t;
}
