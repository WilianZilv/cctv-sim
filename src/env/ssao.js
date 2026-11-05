// Screen-space ambient occlusion for contact darkening (wall bases, corners, curbs,
// window reveals). Normally computed from the depth the main pass already wrote
// (fromDepth: normals rebuilt from depth, used by the next frame, which is the
// same picture for a fixed camera); render() keeps the old normal+depth prepass
// for the debug views. A normal-oriented hemisphere SSAO and a depth-aware blur. Materials sample the result by screen
// position and apply it to indirect light only (see matlib.js).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { globalUniforms } from '../tex/matlib.js';

const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const N = 14;

const AO_FS = /* glsl */ `
uniform sampler2D tNormal, tDepth;
uniform mat4 uProj, uInvProj;
uniform vec3 uKernel[${N}];
uniform float uRadius;
uniform vec2 uDepthTexel;
varying vec2 vUv;
vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
#ifdef RECON_NORMAL
  // normal from the depth of the neighbours (the smaller step on each axis, so
  // silhouettes do not bend it)
  vec2 tx = uDepthTexel;
  vec3 px = viewPos(vUv + vec2(tx.x, 0.0)) - P, nx = P - viewPos(vUv - vec2(tx.x, 0.0));
  vec3 py = viewPos(vUv + vec2(0.0, tx.y)) - P, ny = P - viewPos(vUv - vec2(0.0, tx.y));
  vec3 dx = abs(px.z) < abs(nx.z) ? px : nx, dy = abs(py.z) < abs(ny.z) ? py : ny;
  vec3 Nn = normalize(cross(dx, dy));
#else
  vec3 Nn = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
#endif
  float a = h12(gl_FragCoord.xy) * 6.2831853;
  vec3 rnd = vec3(cos(a), sin(a), 0.0);
  vec3 T = normalize(rnd - Nn * dot(rnd, Nn));
  vec3 B = cross(Nn, T);
  mat3 TBN = mat3(T, B, Nn);
  // radius grows a little with distance so far geometry still gets some occlusion
  float R = uRadius * (1.0 + 0.02 * -P.z);
  float occ = 0.0;
  for (int i = 0; i < ${N}; i++) {
    vec3 S = P + TBN * uKernel[i] * R;
    vec4 c = uProj * vec4(S, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float sz = viewPos(uv).z;
    float range = smoothstep(0.0, 1.0, R / max(abs(P.z - sz), 1e-3));
    occ += (sz >= S.z + 0.025 * R ? 1.0 : 0.0) * range;
  }
  float ao = 1.0 - occ / float(${N});
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

const BLUR_FS = /* glsl */ `
uniform sampler2D tAO, tDepth;
uniform vec2 uTexel;
uniform mat4 uInvProj;
varying vec2 vUv;
float vz(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.z / v.w; }
void main() {
  float z0 = vz(vUv);
  float sum = 0.0, wsum = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 uv = vUv + vec2(float(i), float(j)) * uTexel;
    float w = exp(-float(i * i + j * j) / 4.5) * exp(-abs(vz(uv) - z0) / (0.05 * abs(z0) + 0.05));
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
}`;

export class SSAO {
  constructor(renderer) {
    this.renderer = renderer;
    this.normalMat = new THREE.MeshNormalMaterial();
    this.normalMatDouble = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    const kernel = [];
    for (let i = 0; i < N; i++) {
      // hemisphere samples, denser near the origin
      let v;
      do { v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()); } while (v.length() > 1 || v.length() < 0.1);
      v.normalize();
      const s = i / N;
      v.multiplyScalar(0.15 + 0.85 * s * s);
      kernel.push(v);
    }
    this.pAO = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: AO_FS,
      uniforms: { tNormal: { value: null }, tDepth: { value: null }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uKernel: { value: kernel }, uRadius: { value: 0.6 }, uDepthTexel: { value: new THREE.Vector2() } },
    }));
    this.pAOd = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: AO_FS, defines: { RECON_NORMAL: 1 },
      uniforms: { tNormal: { value: null }, tDepth: { value: null }, uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uKernel: { value: kernel }, uRadius: { value: 0.6 }, uDepthTexel: { value: new THREE.Vector2() } },
    }));
    this.pBlur = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: BLUR_FS,
      uniforms: { tAO: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uInvProj: { value: new THREE.Matrix4() } },
    }));
    this.w = 0; this.h = 0;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.prepass?.dispose(); this.ao?.dispose(); this.blur?.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.prepass = new THREE.WebGLRenderTarget(w, h, { depthTexture, depthBuffer: true, type: THREE.UnsignedByteType });
    this.ao = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.blur = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }

  // fullW/fullH: size of the target the main pass will render into
  render(scene, camera, fullW, fullH) {
    const r = this.renderer;
    this.resize(Math.max(1, Math.round(fullW / 2)), Math.max(1, Math.round(fullH / 2)));
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const hidden = [];
    scene.traverse(o => {
      // alpha-cut foliage, decals and particles would show up as solid quads
      // decals (polygon-offset overlays) z-fight with the surface under them once the override
      // material drops their offset: they would show up as dark AO rings
      if (o.visible && (o.isLineSegments || o.isPoints || (o.material && (o.material.transparent || o.material.alphaTest > 0 || o.material.polygonOffset)))) { hidden.push(o); o.visible = false; }
    });
    scene.overrideMaterial = this.normalMatDouble;
    scene.background = null;
    const prevFog = scene.fog;
    scene.fog = null;
    r.setRenderTarget(this.prepass);
    r.setClearColor(0x8080ff, 1);
    r.clear();
    r.render(scene, camera);
    r.setClearColor(0x000000, 0);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;
    for (const o of hidden) o.visible = true;

    const u = this.pAO.material.uniforms;
    u.tNormal.value = this.prepass.texture;
    u.tDepth.value = this.prepass.depthTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    r.setRenderTarget(this.ao); this.pAO.render(r);
    const b = this.pBlur.material.uniforms;
    b.tAO.value = this.ao.texture;
    b.tDepth.value = this.prepass.depthTexture;
    b.uTexel.value.set(1 / this.w, 1 / this.h);
    b.uInvProj.value.copy(camera.projectionMatrixInverse);
    r.setRenderTarget(this.blur); this.pBlur.render(r);
    r.setRenderTarget(null);
    globalUniforms.uSSAO.value = this.blur.texture;
    globalUniforms.uSSAORes.value.set(fullW, fullH);
    globalUniforms.uSSAOOn.value = 1;
  }

  // AO from the main pass' resolved depth (full size depthTex), at half resolution;
  // materials read it on the next frame
  fromDepth(depthTex, camera, fullW, fullH) {
    const r = this.renderer;
    this.resize(Math.max(1, Math.round(fullW / 2)), Math.max(1, Math.round(fullH / 2)));
    const u = this.pAOd.material.uniforms;
    u.tDepth.value = depthTex;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uDepthTexel.value.set(1 / fullW, 1 / fullH);
    r.setRenderTarget(this.ao); this.pAOd.render(r);
    const b = this.pBlur.material.uniforms;
    b.tAO.value = this.ao.texture;
    b.tDepth.value = depthTex;
    b.uTexel.value.set(1 / this.w, 1 / this.h);
    b.uInvProj.value.copy(camera.projectionMatrixInverse);
    r.setRenderTarget(this.blur); this.pBlur.render(r);
    globalUniforms.uSSAO.value = this.blur.texture;
    globalUniforms.uSSAORes.value.set(fullW, fullH);
    globalUniforms.uSSAOOn.value = 1;
  }

  dispose() {
    this.prepass?.dispose(); this.ao?.dispose(); this.blur?.dispose();
    this.normalMat.dispose(); this.normalMatDouble.dispose();
    globalUniforms.uSSAOOn.value = 0;
  }
}
