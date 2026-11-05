// Physically based sky: single-scattering atmosphere (Rayleigh + Mie, Nishita style)
// with the planet's shadow for twilight, a limb-darkened sun, sun-lit clouds, an
// overcast layer, and the orange/grey glow a city throws onto its night sky.
// Output is radiance in kcd/m2 so it matches the rest of the lighting.
import * as THREE from 'three';

// Earth/atmosphere constants (meters). Mie is a bit hazier than textbook: big-city air.
export const ATMO = {
  rPlanet: 6371e3, rAtmos: 6471e3, kRlh: [5.5e-6, 13.0e-6, 22.4e-6], kMie: 21e-6, shRlh: 8e3, shMie: 1.2e3, g: 0.76,
};

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir;
uniform float uSunI;       // direct sun scale after clouds (0..1)
uniform float uSkyScale;   // atmosphere output -> kcd/m2
uniform vec3 uSunCol;      // sun radiance colour at the ground (transmitted)
uniform vec3 uSkyAmb;      // zenith sky radiance (for cloud ambient)
uniform float uCloud;      // cloud coverage 0..1
uniform float uOvercast;   // uniform grey layer 0..1
uniform float uFog;
uniform vec3 uFogColor;
uniform vec3 uPollution;   // night glow, kcd/m2, at the horizon
uniform float uTime;
uniform sampler2D uNoise;
uniform float uMoon;
uniform float uMS;
uniform float uDisc;       // 0 for the environment map: the sun is already a DirectionalLight         // multiple-scattering / twilight floor (kcd/m2)

#define PI 3.14159265
const float R_PLANET = ${ATMO.rPlanet.toFixed(1)};
const float R_ATMOS = ${ATMO.rAtmos.toFixed(1)};
const vec3 K_RLH = vec3(${ATMO.kRlh.map(v => v.toExponential(3)).join(', ')});
const float K_MIE = ${ATMO.kMie.toExponential(3)};
const float SH_RLH = ${ATMO.shRlh.toFixed(1)};
const float SH_MIE = ${ATMO.shMie.toFixed(1)};
const float G_MIE = ${ATMO.g};

vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float b = 2.0 * dot(rd, r0);
  float c = dot(r0, r0) - sr * sr;
  float d = b * b - 4.0 * c;
  if (d < 0.0) return vec2(1e5, -1e5);
  d = sqrt(d);
  return vec2((-b - d) * 0.5, (-b + d) * 0.5);
}

vec3 atmosphere(vec3 r, vec3 pSun) {
  vec3 r0 = vec3(0.0, R_PLANET + 900.0, 0.0);
  vec2 p = rsi(r0, r, R_ATMOS);
  if (p.x > p.y) return vec3(0.0);
  vec2 pg = rsi(r0, r, R_PLANET);
  if (pg.x > 0.0) p.y = min(p.y, pg.x);
  p.x = max(p.x, 0.0);
  const int I = 16;
  const int J = 6;
  float iStep = (p.y - p.x) / float(I);
  float iOdR = 0.0, iOdM = 0.0;
  vec3 totR = vec3(0.0), totM = vec3(0.0);
  float mu = dot(r, pSun), mumu = mu * mu, gg = G_MIE * G_MIE;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * G_MIE, 1.5) * (2.0 + gg));
  for (int i = 0; i < I; i++) {
    vec3 ip = r0 + r * (p.x + iStep * (float(i) + 0.5));
    float ih = length(ip) - R_PLANET;
    float odR = exp(-ih / SH_RLH) * iStep, odM = exp(-ih / SH_MIE) * iStep;
    iOdR += odR; iOdM += odM;
    // planet shadow, soft across the terminator so twilight has no banding
    float along = dot(ip, pSun);
    float closest = along < 0.0 ? length(ip - pSun * along) : 1e9;
    float lit = smoothstep(R_PLANET - 1500.0, R_PLANET + 3000.0, closest);
    if (lit <= 0.0) continue;
    float jStep = rsi(ip, pSun, R_ATMOS).y / float(J);
    float jOdR = 0.0, jOdM = 0.0;
    for (int j = 0; j < J; j++) {
      vec3 jp = ip + pSun * (jStep * (float(j) + 0.5));
      float jh = length(jp) - R_PLANET;
      jOdR += exp(-jh / SH_RLH) * jStep;
      jOdM += exp(-jh / SH_MIE) * jStep;
    }
    vec3 att = exp(-(K_MIE * 1.1 * (iOdM + jOdM) + K_RLH * (iOdR + jOdR)));
    totR += odR * att * lit; totM += odM * att * lit;
  }
  return pR * K_RLH * totR + pM * K_MIE * totM;
}

float cloudField(vec2 p) {
  vec2 w = vec2(texture2D(uNoise, p * 0.05 + 0.13).r, texture2D(uNoise, p * 0.05 + 0.71).g) - 0.5;
  p += w * 0.9;
  return texture2D(uNoise, p * 0.11).r * 0.55 + texture2D(uNoise, p * 0.37 + 0.3).g * 0.3 + texture2D(uNoise, p * 1.3 + 0.7).b * 0.15;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 sd = normalize(uSunDir);
  float cosT = dot(d, sd);

  // clear sky from the atmosphere (views below the horizon look slightly up so the
  // dome never shows the black planet)
  vec3 ad = normalize(vec3(d.x, max(d.y, 0.002), d.z));
  vec3 col = atmosphere(ad, sd) * uSkyScale;
  col += uMS * vec3(0.35, 0.45, 0.7) * (0.7 + 0.3 * clamp(h, 0.0, 1.0)) + uMS * vec3(0.5, 0.3, 0.2) * pow(max(cosT, 0.0), 3.0) * (1.0 - clamp(h, 0.0, 1.0));

  // sun disc with limb darkening, attenuated by the air mass it is seen through
  float sunR = 0.00468;
  float ang = acos(clamp(cosT, -1.0, 1.0));
  if (ang < sunR && h > 0.0 && uDisc > 0.5) {
    float mu = sqrt(max(0.0, 1.0 - (ang / sunR) * (ang / sunR)));
    col += uSunCol * uSunI * 5.0e3 * (0.4 + 0.6 * mu);
  }

  // clouds on a high flat layer, lit by the transmitted sun and the blue sky
  if (h > 0.0) {
    vec2 p = d.xz / (h + 0.06) * 1.2 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = cloudField(p);
    float cov = smoothstep(1.0 - uCloud * 0.95 - 0.05, 1.05 - uCloud * 0.6, n + uCloud * 0.25);
    float thick = clamp((n + uCloud * 0.25 - (1.0 - uCloud * 0.95)) * 3.0, 0.0, 1.0);
    float silver = pow(max(cosT, 0.0), 6.0) * (1.0 - thick) * 2.5;
    vec3 sunLit = uSunCol * uSunI * 25.0 * (0.55 + 0.45 * (1.0 - thick) + silver);
    vec3 amb = uSkyAmb * 1.6 + uPollution * 1.6;
    vec3 cloudCol = (sunLit * (1.0 - 0.6 * thick) + amb) * mix(1.0, 0.55, thick * uCloud);
    col = mix(col, cloudCol, cov * smoothstep(0.0, 0.1, h));
  }

  // overcast deck: diffuse grey lit from above, brighter toward zenith
  float dayLum = dot(uSkyAmb, vec3(0.2126, 0.7152, 0.0722)) + dot(uSunCol, vec3(0.2126, 0.7152, 0.0722)) * uSunI * 0.25;
  vec3 deck = vec3(0.86, 0.88, 0.9) * dayLum * mix(0.55, 1.0, clamp(h, 0.0, 1.0)) * 1.25;
  deck += uPollution * mix(1.6, 0.9, clamp(h, 0.0, 1.0));
  col = mix(col, deck, uOvercast);

  // urban sky glow: sodium / LED light scattered by the air, strongest at the horizon
  float hz = 1.0 - clamp(h, 0.0, 1.0);
  col += uPollution * (0.25 + 0.75 * hz * hz * hz);
  col += vec3(0.6, 0.7, 1.0) * 1.0e-6 * uMoon;

  // haze toward the horizon
  col = mix(col, uFogColor, clamp(uFog * (1.0 - smoothstep(0.0, 0.5, max(h, 0.0))) + uFog * 0.5, 0.0, 1.0));
  // below the horizon: what is left is ground bounce and haze
  if (h < 0.0) col = mix(col, uFogColor * 0.6, smoothstep(0.0, -0.08, h));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSky(noiseTex) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunI: { value: 1 }, uSkyScale: { value: 1 },
      uSunCol: { value: new THREE.Color(1, 1, 1) }, uSkyAmb: { value: new THREE.Color(1, 1, 1) },
      uCloud: { value: 0.3 }, uOvercast: { value: 0 }, uFog: { value: 0 }, uFogColor: { value: new THREE.Color() },
      uPollution: { value: new THREE.Color(0, 0, 0) }, uTime: { value: 0 }, uNoise: { value: noiseTex }, uMoon: { value: 0 }, uMS: { value: 0 }, uDisc: { value: 1 },
    },
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// ---- CPU side of the same model: sun transmittance and zenith radiance -------------
function rsi(r0, rd, sr) {
  const b = 2 * (rd[0] * r0[0] + rd[1] * r0[1] + rd[2] * r0[2]);
  const c = r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2] - sr * sr;
  const d = b * b - 4 * c;
  if (d < 0) return [1e5, -1e5];
  const s = Math.sqrt(d);
  return [(-b - s) / 2, (-b + s) / 2];
}

// colour of direct sunlight at the ground (transmittance), sun elevation in radians
export function sunTransmittance(el) {
  const A = ATMO;
  const r0 = [0, A.rPlanet + 900, 0];
  const sd = [Math.cos(el), Math.sin(el), 0];
  if (rsi(r0, sd, A.rPlanet)[0] > 0) return [0, 0, 0];
  const L = rsi(r0, sd, A.rAtmos)[1];
  const n = 64, step = L / n;
  let odR = 0, odM = 0;
  for (let i = 0; i < n; i++) {
    const t = step * (i + 0.5);
    const p = [r0[0] + sd[0] * t, r0[1] + sd[1] * t, r0[2]];
    const hgt = Math.hypot(p[0], p[1], p[2]) - A.rPlanet;
    odR += Math.exp(-hgt / A.shRlh) * step;
    odM += Math.exp(-hgt / A.shMie) * step;
  }
  return A.kRlh.map(k => Math.exp(-(k * odR + A.kMie * 1.1 * odM)));
}

// sky radiance for a direction (same integration as the shader), unscaled
export function skyRadiance(dir, sunDir) {
  const A = ATMO;
  const r0 = [0, A.rPlanet + 900, 0];
  const p = rsi(r0, dir, A.rAtmos);
  const I = 24, J = 8;
  const iStep = p[1] / I;
  let iOdR = 0, iOdM = 0;
  const totR = [0, 0, 0], totM = [0, 0, 0];
  const mu = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const gg = A.g * A.g;
  const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
  const pM = 3 / (8 * Math.PI) * ((1 - gg) * (mu * mu + 1)) / (Math.pow(1 + gg - 2 * mu * A.g, 1.5) * (2 + gg));
  for (let i = 0; i < I; i++) {
    const t = iStep * (i + 0.5);
    const ip = [r0[0] + dir[0] * t, r0[1] + dir[1] * t, r0[2] + dir[2] * t];
    const ih = Math.hypot(...ip) - A.rPlanet;
    const odR = Math.exp(-ih / A.shRlh) * iStep, odM = Math.exp(-ih / A.shMie) * iStep;
    iOdR += odR; iOdM += odM;
    if (rsi(ip, sunDir, A.rPlanet)[0] > 0) continue;
    const jStep = rsi(ip, sunDir, A.rAtmos)[1] / J;
    let jOdR = 0, jOdM = 0;
    for (let j = 0; j < J; j++) {
      const s = jStep * (j + 0.5);
      const jp = [ip[0] + sunDir[0] * s, ip[1] + sunDir[1] * s, ip[2] + sunDir[2] * s];
      const jh = Math.hypot(...jp) - A.rPlanet;
      jOdR += Math.exp(-jh / A.shRlh) * jStep;
      jOdM += Math.exp(-jh / A.shMie) * jStep;
    }
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(A.kMie * 1.1 * (iOdM + jOdM) + A.kRlh[c] * (iOdR + jOdR)));
      totR[c] += odR * att; totM[c] += odM * att;
    }
  }
  return [0, 1, 2].map(c => pR * A.kRlh[c] * totR[c] + pM * A.kMie * totM[c]);
}
