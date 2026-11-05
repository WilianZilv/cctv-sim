// Bakes procedural PBR texture sets (albedo / normal / ORM) on the GPU once per
// seed and caches them. One small program per (material, pass) keeps the D3D
// shader compiler fast; normals are derived from a baked height field.
import * as THREE from 'three';
import { NOISE } from './noise.glsl.js';
import { MATERIALS_GLSL } from './materials.glsl.js';

const SURF_MAIN = /* glsl */ `
uniform float uRes;
uniform vec2 uHRange;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  Surf s = surfaceAt(uv);
#if PASS == 0
  gl_FragColor = vec4(s.alb, s.a);
#elif PASS == 1
  gl_FragColor = vec4(s.ao, clamp(s.rough, 0.02, 1.0), s.metal, clamp((s.h - uHRange.x) / max(uHRange.y - uHRange.x, 1e-6), 0.0, 1.0));
#else
  gl_FragColor = vec4(s.h, 0.0, 0.0, 1.0);
#endif
}
`;

const NORMAL_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform float uRes;
uniform float uTile;
uniform float uNormalStrength;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float e = 1.0 / uRes;
  float hl = texture2D(uHeight, fract(uv - vec2(e, 0.0))).r;
  float hr = texture2D(uHeight, fract(uv + vec2(e, 0.0))).r;
  float hd = texture2D(uHeight, fract(uv - vec2(0.0, e))).r;
  float hu = texture2D(uHeight, fract(uv + vec2(0.0, e))).r;
  vec2 g = vec2(hr - hl, hu - hd) / (2.0 * e * uTile);
  vec3 n = normalize(vec3(-g * uNormalStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

// min/max of the height field, reduced on the GPU (one output texel per block)
const MINMAX_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform float uStride;
uniform float uRes;
void main() {
  vec2 base = floor(gl_FragCoord.xy) * uStride;
  float mn = 1e9, mx = -1e9;
  for (int j = 0; j < 32; j++) {
    if (float(j) >= uStride) break;
    for (int i = 0; i < 32; i++) {
      if (float(i) >= uStride) break;
      float h = texelFetch(uHeight, ivec2(base + vec2(i, j)), 0).r;
      mn = min(mn, h); mx = max(mx, h);
    }
  }
  gl_FragColor = vec4(mn, mx, 0.0, 1.0);
}
`;

const MAT_ID = {
  asphalt: 0, concrete: 1, petitpave: 2, tiles: 3, paver: 4, grass: 5, soil: 6, plaster: 7, masonry: 8,
  stone: 9, pastilha: 10, concreteRaw: 11, roofCeramic: 12, fibro: 13, metal: 14, wood: 15, bark: 16, foliage: 17, noise: 18,
};

// name -> definition. tile = meters covered by one texture repeat.
export const TEX_DEFS = {
  asphalt_new: { m: 'asphalt', tile: 4, p: [0.12, 0.0, 0.25, 0], pom: 1.2, size: 512, ns: 1.0 },
  asphalt_old: { m: 'asphalt', tile: 4, p: [0.85, 0.55, 0.0, 0], pom: 1.2, size: 512, ns: 1.0 },
  asphalt_patchy: { m: 'asphalt', tile: 4, p: [0.55, 0.25, 0.1, 0], pom: 1.2, size: 512, ns: 1.0 },
  asphalt_patch: { m: 'asphalt', tile: 3, p: [0.05, 0.0, 0.7, 0], pom: 1.2, size: 512, ns: 1.0 },
  concrete: { m: 'concrete', tile: 3, p: [0.35, 1.5, 0.6, 0], pom: 1, size: 512, ns: 1.0 },
  concrete_old: { m: 'concrete', tile: 3, p: [0.95, 1.0, 0.35, 0], pom: 1.3, size: 512, ns: 1.0 },
  concrete_plain: { m: 'concrete', tile: 3, p: [0.6, 0.0, 0.5, 0], size: 512, ns: 1.0 },
  concrete_slab: { m: 'concrete', tile: 3, p: [0.7, 3.0, 0.4, 0], pom: 1.3, size: 512, ns: 1.0 },
  petitpave_0: { m: 'petitpave', tile: 2, p: [0, 0.6, 0, 0], pom: 1.6, size: 512, ns: 1.0 },
  petitpave_1: { m: 'petitpave', tile: 4, p: [1, 0.4, 0, 0], pom: 1.6, size: 512, ns: 1.0 },
  petitpave_2: { m: 'petitpave', tile: 3, p: [2, 0.5, 0, 0], pom: 1.6, size: 512, ns: 1.0 },
  petitpave_3: { m: 'petitpave', tile: 3, p: [3, 0.5, 0, 0], pom: 1.6, size: 512, ns: 1.0 },
  ceramic_red: { m: 'tiles', tile: 2, p: [0.25, 0, 0.6, 0], pom: 2, size: 512, ns: 1.0 },
  ladrilho: { m: 'tiles', tile: 2, p: [0.2, 1, 0.7, 0], pom: 1.6, size: 512, ns: 1.0 },
  ladrilho_b: { m: 'tiles', tile: 2, p: [0.2, 1, 0.6, 1], pom: 1.6, size: 512, ns: 1.0 },
  caquinho: { m: 'tiles', tile: 2, p: [0.075, 2, 0.6, 0], pom: 2, size: 512, ns: 1.0 },
  paver: { m: 'paver', tile: 2, p: [0, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  paver_red: { m: 'paver', tile: 2, p: [1, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  grass: { m: 'grass', tile: 3, p: [0.3, 0.3, 0, 0], size: 512, ns: 1.0 },
  grass_dry: { m: 'grass', tile: 3, p: [0.8, 0.6, 0, 0], size: 512, ns: 1.0 },
  soil: { m: 'soil', tile: 3, p: [0, 0, 0, 0], size: 512, ns: 1.0 },
  soil_red: { m: 'soil', tile: 3, p: [1, 0, 0, 0], size: 512, ns: 1.0 },
  plaster_stucco: { m: 'plaster', tile: 2, p: [0, 0.4, 0, 0], size: 512, ns: 1.0, tint: true },
  plaster_grafiato: { m: 'plaster', tile: 2, p: [1, 0.5, 0, 0], pom: 1.5, size: 512, ns: 1.0, tint: true },
  plaster_smooth: { m: 'plaster', tile: 2, p: [2, 0.7, 0, 0], size: 512, ns: 1.0, tint: true },
  brick: { m: 'masonry', tile: 2.4, p: [0, 0, 0, 0], pom: 2, size: 512, ns: 1.0 },
  brick_raw: { m: 'masonry', tile: 2.4, p: [1, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  block_raw: { m: 'masonry', tile: 2.4, p: [2, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  canjiquinha: { m: 'stone', tile: 2, p: [0, 0, 0, 0], pom: 1.1, size: 512, ns: 1.0 },
  stone_slab: { m: 'stone', tile: 2, p: [1, 0, 0, 0], pom: 2, size: 512, ns: 1.0 },
  pastilha_blue: { m: 'pastilha', tile: 1, p: [0.025, 0, 0, 0], c1: '#3d6e93', c2: '#7fa7c2', pom: 1.5, size: 512, ns: 1.0 },
  pastilha_beige: { m: 'pastilha', tile: 1, p: [0.025, 0, 0, 0], c1: '#d9cfbd', c2: '#b8a98f', pom: 1.5, size: 512, ns: 1.0 },
  pastilha_brown: { m: 'pastilha', tile: 1, p: [0.05, 0, 0, 0], c1: '#6b4a35', c2: '#a07a58', pom: 1.5, size: 512, ns: 1.0 },
  concrete_raw: { m: 'concreteRaw', tile: 2, p: [0, 0, 0, 0], size: 512, ns: 1.0 },
  roof_ceramic: { m: 'roofCeramic', tile: 3.4, p: [0.6, 0, 0, 0], pom: 1, size: 512, ns: 1.0 },
  fibro: { m: 'fibro', tile: 3.54, p: [0.6, 0, 0, 0], pom: 1, size: 512, ns: 1.0 },
  gate_ribs: { m: 'metal', tile: 2, p: [0, 0.4, 0, 0], pom: 1.5, size: 512, ns: 1.0, tint: true },
  gate_flat: { m: 'metal', tile: 2, p: [1, 0.5, 0, 0], size: 512, ns: 1.0, tint: true },
  gate_slats: { m: 'metal', tile: 2, p: [2, 0.4, 0, 0], pom: 1.5, size: 512, ns: 1.0, tint: true },
  rollup: { m: 'metal', tile: 2, p: [3, 0.3, 0, 0], pom: 1.5, size: 512, ns: 1.0, tint: true },
  rollup_galv: { m: 'metal', tile: 2, p: [3, 0.3, 1, 0], pom: 1.5, size: 512, ns: 1.0 },
  gate_perf: { m: 'metal', tile: 2, p: [4, 0.3, 0, 0], size: 512, ns: 1.0, tint: true },
  steel: { m: 'metal', tile: 2, p: [1, 0.7, 0, 0], size: 512, ns: 0.5, tint: true },
  wood: { m: 'wood', tile: 1.2, p: [0, 0, 0, 0], pom: 1.5, size: 512, ns: 1.0 },
  bark: { m: 'bark', tile: 1, p: [0, 0, 0, 0], pom: 2, size: 512, ns: 1.0 },
  foliage_broad: { m: 'foliage', tile: 1, p: [0, 0, 0, 0], c1: '#2e4a1c', c2: '#5d7a2c', size: 512, ns: 1.0, cutout: true },
  foliage_small: { m: 'foliage', tile: 1, p: [1, 0, 0, 0], c1: '#34501f', c2: '#6e8a33', size: 512, ns: 1.0, cutout: true },
  foliage_dark: { m: 'foliage', tile: 1, p: [0, 0, 0, 0], c1: '#1d3214', c2: '#3a5422', size: 512, ns: 1.0, cutout: true },
  foliage_ipe: { m: 'foliage', tile: 1, p: [1, 0, 0, 0], c1: '#b0408a', c2: '#e07ab8', size: 512, ns: 1.0, cutout: true },
  foliage_ipe_y: { m: 'foliage', tile: 1, p: [1, 0, 0, 0], c1: '#c99a12', c2: '#f0cb35', size: 512, ns: 1.0, cutout: true },
  weeds: { m: 'foliage', tile: 1, p: [3, 0, 0, 0], c1: '#3e4f1e', c2: '#8a8a3c', size: 512, ns: 1.0, cutout: true },
  weeds_dry: { m: 'foliage', tile: 1, p: [3, 0, 0, 0], c1: '#6b6234', c2: '#a69a62', size: 512, ns: 1.0, cutout: true },
  // ---- variants (the picker in matlib chooses among name, name_b, name_c, ...)
  asphalt_old_b: { m: 'asphalt', tile: 4, p: [0.7, 0.35, 0.05, 0], pom: 1.2, size: 512, ns: 1.0 },
  asphalt_old_c: { m: 'asphalt', tile: 4, p: [0.95, 0.75, 0.0, 0], pom: 1.2, size: 512, ns: 1.0 },
  asphalt_new_b: { m: 'asphalt', tile: 4, p: [0.3, 0.05, 0.15, 0], pom: 1.2, size: 512, ns: 1.0 },
  concrete_b: { m: 'concrete', tile: 3, p: [0.55, 1.2, 0.45, 0], pom: 1, size: 512, ns: 1.0 },
  concrete_c: { m: 'concrete', tile: 3, p: [0.2, 2.0, 0.75, 0], pom: 1, size: 512, ns: 1.0 },
  concrete_d: { m: 'concrete', tile: 3, p: [0.8, 0.75, 0.3, 0], pom: 1, size: 512, ns: 1.0 },
  concrete_old_b: { m: 'concrete', tile: 3, p: [1.0, 1.5, 0.25, 0], pom: 1.3, size: 512, ns: 1.0 },
  ceramic_red_b: { m: 'tiles', tile: 2, p: [0.3, 0, 0.8, 0], pom: 2, size: 512, ns: 1.0 },
  ceramic_red_c: { m: 'tiles', tile: 2, p: [0.2, 0, 0.4, 0], pom: 2, size: 512, ns: 1.0 },
  ladrilho_c: { m: 'tiles', tile: 2, p: [0.2, 1, 0.8, 2], pom: 1.6, size: 512, ns: 1.0 },
  caquinho_b: { m: 'tiles', tile: 2, p: [0.06, 2, 0.8, 0], pom: 2, size: 512, ns: 1.0 },
  paver_b: { m: 'paver', tile: 2, p: [0, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  paver_red_b: { m: 'paver', tile: 2, p: [1, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  plaster_stucco_b: { m: 'plaster', tile: 2, p: [0, 0.8, 0, 0], size: 512, ns: 1.0, tint: true },
  plaster_grafiato_b: { m: 'plaster', tile: 2, p: [1, 0.9, 0, 0], pom: 1.5, size: 512, ns: 1.0, tint: true },
  plaster_smooth_b: { m: 'plaster', tile: 2, p: [2, 0.3, 0, 0], size: 512, ns: 1.0, tint: true },
  brick_b: { m: 'masonry', tile: 2.4, p: [0, 0, 0, 0], pom: 2, size: 512, ns: 1.0 },
  brick_raw_b: { m: 'masonry', tile: 2.4, p: [1, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  block_raw_b: { m: 'masonry', tile: 2.4, p: [2, 0, 0, 0], pom: 2.2, size: 512, ns: 1.0 },
  stone_slab_b: { m: 'stone', tile: 2, p: [1, 0, 0, 0], pom: 2, size: 512, ns: 1.0 },
  canjiquinha_b: { m: 'stone', tile: 2, p: [0, 0, 0, 0], pom: 1.1, size: 512, ns: 1.0 },
  pastilha_green: { m: 'pastilha', tile: 1, p: [0.025, 0, 0, 0], c1: '#5d7f63', c2: '#86a58a', pom: 1.5, size: 512, ns: 1.0 },
  pastilha_white: { m: 'pastilha', tile: 1, p: [0.025, 0, 0, 0], c1: '#e4e1d9', c2: '#c9c4b8', pom: 1.5, size: 512, ns: 1.0 },
  pastilha_grey: { m: 'pastilha', tile: 1, p: [0.05, 0, 0, 0], c1: '#8a8c8c', c2: '#b0b1ae', pom: 1.5, size: 512, ns: 1.0 },
  roof_ceramic_b: { m: 'roofCeramic', tile: 3.4, p: [0.9, 0, 0, 0], pom: 1, size: 512, ns: 1.0 },
  roof_ceramic_c: { m: 'roofCeramic', tile: 3.4, p: [0.3, 0, 0, 0], pom: 1, size: 512, ns: 1.0 },
  fibro_b: { m: 'fibro', tile: 3.54, p: [0.95, 0, 0, 0], pom: 1, size: 512, ns: 1.0 },
  wood_b: { m: 'wood', tile: 1.2, p: [0, 0, 0, 0], pom: 1.5, size: 512, ns: 1.0 },
  grass_b: { m: 'grass', tile: 3, p: [0.5, 0.5, 0, 0], size: 512, ns: 1.0 },
  soil_b: { m: 'soil', tile: 3, p: [0, 0, 0, 0], size: 512, ns: 1.0 },
  noise: { m: 'noise', tile: 1, p: [0, 0, 0, 0], size: 512, ns: 1.0 },
};

const VERT = 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';

export class TextureBaker {
  // size: resolution of every material texture (the noise texture keeps its own)
  constructor(renderer, seed, size = 512) {
    this.renderer = renderer;
    this.seed = seed;
    this.size = size;
    this.cache = new Map();
    this.programs = new Map();
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.normalMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: NORMAL_FRAG,
      uniforms: { uHeight: { value: null }, uRes: { value: 1 }, uTile: { value: 1 }, uNormalStrength: { value: 1 } },
      depthTest: false, depthWrite: false,
    });
    this.heightRT = new Map();
    this.minmaxMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: MINMAX_FRAG, uniforms: { uHeight: { value: null }, uStride: { value: 16 }, uRes: { value: 1 } }, depthTest: false, depthWrite: false });
    this.minmaxRT = new THREE.WebGLRenderTarget(128, 128, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.blocks = 0;
  }

  program(matId, pass) {
    const key = matId + ':' + pass;
    let m = this.programs.get(key);
    if (!m) {
      m = new THREE.ShaderMaterial({
        defines: { MAT: matId, PASS: pass },
        vertexShader: VERT,
        fragmentShader: NOISE + MATERIALS_GLSL + SURF_MAIN,
        uniforms: {
          uSeed: { value: 0 }, uTile: { value: 1 }, uP: { value: new THREE.Vector4() },
          uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uRes: { value: 1024 }, uHRange: { value: new THREE.Vector2(0, 1) },
        },
        depthTest: false, depthWrite: false,
      });
      this.programs.set(key, m);
    }
    return m;
  }

  makeTarget(size, srgb, mips = true) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
    rt.texture.anisotropy = Math.min(8, this.maxAniso);
    return rt;
  }

  // Texture filtering of every baked material texture:
  // 'nearest' (point), 'linear' (no mipmaps), 'bilinear' (nearest mip level),
  // 'trilinear' (blend of two mip levels); aniso 1 = off.
  setFilter(mode = 'trilinear', aniso = 8) {
    const gl = this.renderer.getContext();
    const ext = this.renderer.extensions.get('EXT_texture_filter_anisotropic');
    const MIN = { nearest: [THREE.NearestFilter, gl.NEAREST], linear: [THREE.LinearFilter, gl.LINEAR], bilinear: [THREE.LinearMipmapNearestFilter, gl.LINEAR_MIPMAP_NEAREST], trilinear: [THREE.LinearMipmapLinearFilter, gl.LINEAR_MIPMAP_LINEAR] }[mode] || [THREE.LinearMipmapLinearFilter, gl.LINEAR_MIPMAP_LINEAR];
    const mag = mode === 'nearest' ? [THREE.NearestFilter, gl.NEAREST] : [THREE.LinearFilter, gl.LINEAR];
    const a = Math.max(1, Math.min(+aniso || 1, this.maxAniso));
    for (const set of this.cache.values()) for (const rt of set.targets) {
      const t = rt.texture;
      t.minFilter = MIN[0]; t.magFilter = mag[0]; t.anisotropy = a;
      // render-target textures are not re-uploaded, so set the GL state directly
      const tex = this.renderer.properties.get(t).__webglTexture;
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, MIN[1]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag[1]);
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, a);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.renderer.resetState();
  }

  heightTarget(size) {
    let rt = this.heightRT.get(size);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.FloatType, format: THREE.RGBAFormat, generateMipmaps: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false,
      });
      this.heightRT.set(size, rt);
    }
    return rt;
  }

  get(name, variant = 0) {
    const set = this.cache.get(name + ':' + variant);
    if (!set) throw new Error('texture not baked: ' + name);
    return set;
  }

  async drawBlocks(material, rt, size) {
    const r = this.renderer;
    const gl = r.getContext();
    const block = 512;
    this.quad.material = material;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    for (let by = 0; by < size; by += block) {
      for (let bx = 0; bx < size; bx += block) {
        rt.scissorTest = true;
        rt.scissor.set(bx, by, Math.min(block, size - bx), Math.min(block, size - by));
        rt.viewport.set(0, 0, size, size);
        r.setRenderTarget(rt);
        r.render(this.scene, this.cam);
        gl.flush();
        // yield by time, not by count: small textures bake in one go
        if (performance.now() - (this.lastYield || 0) > 40) { await new Promise(res => setTimeout(res, 0)); this.lastYield = performance.now(); }
      }
    }
    rt.scissorTest = false;
    r.autoClear = prevAuto;
    r.setRenderTarget(null);
  }

  // Bakes in small blocks and yields between them so the GPU watchdog never fires.
  async bake(name, variant = 0) {
    const key = name + ':' + variant;
    if (this.cache.has(key)) return this.cache.get(key);
    const def = TEX_DEFS[name];
    if (!def) throw new Error('unknown texture ' + name);
    const size = name === 'noise' ? def.size : this.size;
    const matId = MAT_ID[def.m];
    const albedo = this.makeTarget(size, true);
    const orm = this.makeTarget(size, false);
    const normal = this.makeTarget(size, false);
    const height = this.heightTarget(size);
    const outs = [albedo, orm, height];
    const hRange = new THREE.Vector2(0, 1);
    // height first: its range normalizes the height stored in the ORM alpha
    for (const pass of [2, 0, 1]) {
      const m = this.program(matId, pass);
      m.uniforms.uHRange.value.copy(hRange);
      const u = m.uniforms;
      u.uSeed.value = (hashStr(this.seed + name) % 1000) + variant * 17.0;
      u.uTile.value = def.tile;
      u.uP.value.set(...def.p);
      u.uC1.value.set(def.c1 || '#ffffff');
      u.uC2.value.set(def.c2 || '#ffffff');
      u.uRes.value = size;
      await this.drawBlocks(m, outs[pass], size);
      if (pass === 2) {
        const stride = size / 128;
        const mu = this.minmaxMat.uniforms;
        mu.uHeight.value = height.texture;
        mu.uStride.value = stride;
        this.quad.material = this.minmaxMat;
        this.renderer.setRenderTarget(this.minmaxRT);
        this.renderer.render(this.scene, this.cam);
        this.renderer.setRenderTarget(null);
        const buf = new Float32Array(128 * 128 * 4);
        this.renderer.readRenderTargetPixels(this.minmaxRT, 0, 0, 128, 128, buf);
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < 128 * 128; i++) { mn = Math.min(mn, buf[i * 4]); mx = Math.max(mx, buf[i * 4 + 1]); }
        hRange.set(mn, mx > mn ? mx : mn + 1e-4);
      }
    }
    const nu = this.normalMat.uniforms;
    nu.uHeight.value = height.texture;
    nu.uRes.value = size;
    nu.uTile.value = def.tile;
    nu.uNormalStrength.value = def.ns;
    await this.drawBlocks(this.normalMat, normal, size);

    const targets = [albedo, normal, orm];
    for (const rt of targets) rt.texture.repeat.set(1 / def.tile, 1 / def.tile);
    // depth: relief amplitude in meters, used by parallax occlusion mapping
    const set = { map: albedo.texture, normalMap: normal.texture, orm: orm.texture, def, targets, depth: (hRange.y - hRange.x) * (def.pom ?? 1) };
    this.cache.set(key, set);
    return set;
  }

  async bakeAll(names, onProgress = () => {}) {
    // compile every program up front; with KHR_parallel_shader_compile the driver
    // builds them in parallel instead of one by one inside the first draw
    const todo = names.filter(n => !this.cache.has(n + ':0'));
    if (todo.length) {
      const scene = new THREE.Scene();
      const geo = this.quad.geometry;
      const ids = [...new Set(todo.map(n => MAT_ID[TEX_DEFS[n].m]))];
      for (const id of ids) for (const pass of [0, 1, 2]) scene.add(new THREE.Mesh(geo, this.program(id, pass)));
      scene.add(new THREE.Mesh(geo, this.normalMat), new THREE.Mesh(geo, this.minmaxMat));
      for (const m of scene.children) m.frustumCulled = false;
      try { await this.renderer.compileAsync(scene, this.cam); } catch (e) { /* falls back to compiling on first draw */ }
    }
    let i = 0;
    for (const n of names) {
      await this.bake(n);
      onProgress(++i / names.length, n);
    }
  }

  dispose() {
    for (const set of this.cache.values()) for (const rt of set.targets) rt.dispose();
    for (const rt of this.heightRT.values()) rt.dispose();
    for (const m of this.programs.values()) m.dispose();
    this.cache.clear();
    this.normalMat.dispose();
    this.minmaxMat.dispose();
    this.minmaxRT.dispose();
  }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
