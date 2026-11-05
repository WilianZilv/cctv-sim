// Colour grading shared by every camera (security camera and free view). The
// state is a plain object (cfg.grade) so it can be saved, copied as JSON and
// edited in the grading panel.
import * as THREE from 'three';

export const GRADE = {
  uGTemp: { value: new THREE.Vector3(1, 1, 1) },
  uGLift: { value: new THREE.Vector3() },
  uGGamma: { value: new THREE.Vector3(1, 1, 1) },
  uGGain: { value: new THREE.Vector3(1, 1, 1) },
  uGContrast: { value: 1 }, uGPivot: { value: 0.45 },
  uGSat: { value: 1 }, uGVibrance: { value: 0 },
  uGShadow: { value: new THREE.Vector3() }, uGHigh: { value: new THREE.Vector3() },
  // before/after: pixels left of this x (0..1) skip the grade; 0 = off
  uGCompare: { value: 0 },
  // 3D LUT (.cube) applied after the grade; amount 0 = no LUT
  uLut: { value: placeholderLut() },
  uLutSize: { value: 1 }, uLutAmount: { value: 0 },
  uLutMin: { value: new THREE.Vector3(0, 0, 0) }, uLutMax: { value: new THREE.Vector3(1, 1, 1) },
};

function placeholderLut() {
  const t = new THREE.Data3DTexture(new Float32Array([0, 0, 0, 1]), 1, 1, 1);
  t.format = THREE.RGBAFormat; t.type = THREE.FloatType; t.needsUpdate = true;
  return t;
}

// Parse an Adobe/Resolve .cube 3D LUT. Returns { size, data (RGBA float), min, max, title }.
export function parseCube(text) {
  let size = 0, title = '';
  const min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    const k = p[0].toUpperCase();
    if (k === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (k === 'LUT_3D_SIZE') size = parseInt(p[1], 10);
    else if (k === 'LUT_1D_SIZE') throw new Error('LUT 1D não suportado, use um LUT 3D');
    else if (k === 'DOMAIN_MIN') for (let i = 0; i < 3; i++) min[i] = +p[i + 1];
    else if (k === 'DOMAIN_MAX') for (let i = 0; i < 3; i++) max[i] = +p[i + 1];
    else if (/^[-+.\d]/.test(p[0]) && p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
  }
  if (!size || size < 2 || size > 128) throw new Error('LUT_3D_SIZE ausente ou inválido');
  if (vals.length !== size * size * size * 3) throw new Error(`esperava ${size ** 3} linhas de cor, achei ${vals.length / 3}`);
  // .cube order: red changes fastest, then green, then blue = x, y, z of the 3D texture
  const data = new Float32Array(size * size * size * 4);
  for (let i = 0, j = 0; i < vals.length; i += 3, j += 4) {
    data[j] = vals[i]; data[j + 1] = vals[i + 1]; data[j + 2] = vals[i + 2]; data[j + 3] = 1;
  }
  return { size, data, min, max, title };
}

export function setLut(lut) {
  const old = GRADE.uLut.value;
  if (!lut) {
    GRADE.uLut.value = placeholderLut();
    GRADE.uLutSize.value = 1;
    GRADE.uLutAmount.value = 0;
  } else {
    const t = new THREE.Data3DTexture(lut.data, lut.size, lut.size, lut.size);
    t.format = THREE.RGBAFormat; t.type = THREE.FloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    GRADE.uLut.value = t;
    GRADE.uLutSize.value = lut.size;
    GRADE.uLutMin.value.fromArray(lut.min);
    GRADE.uLutMax.value.fromArray(lut.max);
  }
  old.dispose();
}
export function setLutAmount(a) { GRADE.uLutAmount.value = GRADE.uLutSize.value > 1 ? a : 0; }

// wheels are [hue degrees, amount 0..1, luminance]; split toning is [hue, amount]
const look = (o) => ({
  temp: 0, tint: 0, contrast: 1, pivot: 0.45, sat: 1, vibrance: 0,
  lift: [0, 0, 0], gamma: [0, 0, 1], gain: [0, 0, 1], sh: [210, 0], hi: [40, 0], ...o,
});
export const LOOKS = {
  natural: look({ temp: 0.06, contrast: 1.14, sat: 0.91, vibrance: -0.09, lift: [0, 0, -0.038], gain: [0, 0, 0.94], sh: [254, 0.307], hi: [237, 0.245] }),
  neutral: look({}),
  warm: look({ temp: 0.25, tint: 0.05, contrast: 1.06, vibrance: 0.1, sh: [30, 0.08], hi: [45, 0.2] }),
  cold: look({ temp: -0.25, tint: -0.03, contrast: 1.08, vibrance: 0.05, sh: [210, 0.2], hi: [200, 0.08] }),
  faded: look({ temp: 0.05, contrast: 0.88, vibrance: -0.3, lift: [0, 0, 0.04], gamma: [0, 0, 1.05], gain: [0, 0, 0.97], sh: [200, 0.08], hi: [50, 0.08] }),
  film: look({ temp: 0.06, contrast: 1.14, vibrance: 0.1, lift: [0, 0, -0.008], gamma: [0, 0, 0.98], sh: [195, 0.3], hi: [35, 0.25] }),
};
export const LOOK_NAMES = { natural: 'Natural', neutral: 'Neutro', warm: 'Quente', cold: 'Frio', faded: 'Lavado', film: 'Filme' };
export const GRADE_KEYS = Object.keys(LOOKS.neutral);

// how far the edge of each wheel pushes the colour
export const WHEEL_RANGE = { lift: 0.06, gamma: 0.2, gain: 0.2, sh: 0.12, hi: 0.12 };

// zero-mean RGB direction of a hue, scaled so pure hues have unit length
export function hueDir(h) {
  const k = (n) => { const x = (n + h / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(x - 3, 9 - x, 1)); };
  const r = k(0), g = k(8), b = k(4), m = (r + g + b) / 3;
  const v = new THREE.Vector3(r - m, g - m, b - m);
  return v.multiplyScalar(1 / Math.max(v.length(), 1e-6));
}
export function hueRGB(h, s = 1, l = 0.5) { return new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l); }

export function gradeState(g) {
  const out = structuredClone(LOOKS.natural);
  if (!g) return out;
  for (const k of GRADE_KEYS) if (g[k] !== undefined && typeof g[k] === typeof out[k]) out[k] = structuredClone(g[k]);
  return out;
}

export function applyGrade(g) {
  const s = gradeState(g);
  GRADE.uGTemp.value.set(1 + 0.14 * s.temp, 1 - 0.06 * s.tint, 1 - 0.14 * s.temp);
  const off = (w, r) => hueDir(w[0]).multiplyScalar(w[1] * r);
  GRADE.uGLift.value.copy(off(s.lift, WHEEL_RANGE.lift)).addScalar(s.lift[2]);
  GRADE.uGGamma.value.copy(off(s.gamma, WHEEL_RANGE.gamma)).addScalar(1).multiplyScalar(s.gamma[2]);
  GRADE.uGGain.value.copy(off(s.gain, WHEEL_RANGE.gain)).addScalar(1).multiplyScalar(s.gain[2]);
  GRADE.uGContrast.value = s.contrast;
  GRADE.uGPivot.value = s.pivot;
  GRADE.uGSat.value = s.sat;
  GRADE.uGVibrance.value = s.vibrance;
  GRADE.uGShadow.value.copy(off(s.sh, WHEEL_RANGE.sh));
  GRADE.uGHigh.value.copy(off(s.hi, WHEEL_RANGE.hi));
}
applyGrade();
