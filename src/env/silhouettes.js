// Shadows of vehicles and people from the street lamps (which have no shadow maps)
// and, for what moves, from the sun (the sun's shadow map is static).
//
// Each lamp near the view looks at the street and records, for every direction,
// how far its light travels before it hits a vehicle or a person: the 2D outline
// of everything that moves, as seen from the lamp, with the distance to it. The
// sun does the same over the area around the camera, for traffic and pedestrians.
// All of it goes into one texture atlas. A surface point then compares its own
// distance to the light with the distance where the light was stopped: nearer
// the occluder the shadow is sharp, farther away it spreads (percentage-closer
// soft shadows, matlib.js FRAG_SIL).
import * as THREE from 'three';
import { globalUniforms } from '../tex/matlib.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const SIL_LAYER = 5;        // everything that casts lamp shadows (all vehicles, people)
export const SIL_MOVING = 6;       // casts sun shadows here (the static sun map has the rest)
const TILE = 512, COLS = 3, ROWS = 2;
const LAMPS = 4;                   // tiles 0..3; tile 4 is the sun
const FOV = 140;
const FAR_NONE = 1e4;

const DEPTH_VS = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec3 vW;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
}`;
const DEPTH_FS = /* glsl */ `
uniform vec4 uFn;   // xyz: lamp position or sun direction; w: 0 lamp, 1 sun
varying vec3 vW;
void main() {
  float d = uFn.w > 0.5 ? dot(vW, uFn.xyz) : distance(vW, uFn.xyz);
  gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
}`;

export class SilhouetteShadows {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(TILE * COLS, TILE * ROWS, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.rt.scissorTest = true;
    this.mat = new THREE.ShaderMaterial({ name: 'silhouette', vertexShader: DEPTH_VS, fragmentShader: DEPTH_FS, uniforms: { uFn: { value: new THREE.Vector4() } }, side: THREE.DoubleSide });
    this.lampCams = Array.from({ length: LAMPS }, () => new THREE.PerspectiveCamera(FOV, 1, 0.2, 60));
    this.sunCam = new THREE.OrthographicCamera(-45, 45, 45, -45, 1, 400);
    for (const c of this.lampCams) c.layers.set(SIL_LAYER);
    this.sunCam.layers.set(SIL_MOVING);
    globalUniforms.uSilMap.value = this.rt.texture;
  }

  // The casters live in a small scene of their own (the main scene has hundreds of
  // objects to walk through for each of the five views): one position-only mesh
  // per vehicle, following its object, and the people's skinned meshes, sharing
  // their skeletons. parked / moving: vehicle roots; people: skinned meshes.
  setCasters(parked, moving, people) {
    this.casters?.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) o.geometry.dispose(); });
    const sc = new THREE.Scene();
    const follow = [];
    const vehicle = (root, sun) => {
      root.updateMatrixWorld(true);
      const inv = root.matrixWorld.clone().invert();
      const parts = [];
      root.traverse(m => {
        if (!m.isMesh || m.isSkinnedMesh || !m.visible || m.material?.transparent) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', m.geometry.attributes.position.clone());
        if (m.geometry.index) g.setIndex(m.geometry.index.clone());
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        parts.push(g.index ? g.toNonIndexed() : g);
      });
      if (!parts.length) return;
      const geo = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(SIL_LAYER);
      if (sun) mesh.layers.enable(SIL_MOVING);
      sc.add(mesh);
      follow.push([mesh, root]);
    };
    for (const o of parked) vehicle(o, false);
    for (const o of moving) vehicle(o, true);
    for (const p of people) {
      const m = new THREE.SkinnedMesh(p.geometry, this.mat);
      m.bind(p.skeleton, p.bindMatrix);
      m.matrixAutoUpdate = false;
      m.layers.set(SIL_LAYER); m.layers.enable(SIL_MOVING);
      m.frustumCulled = false;
      sc.add(m);
      follow.push([m, p]);
    }
    this.casters = sc;
    this.follow = follow;
  }

  update(env, viewPos, focus) {
    if (!this.casters) return;
    const scene = this.casters;
    for (const [m, src] of this.follow) {
      let vis = src.visible;
      for (let p = src.parent; p && vis; p = p.parent) vis = p.visible;
      m.visible = vis;
      // the caster scene recomputes matrixWorld from matrix: set the local matrix
      if (vis) { m.matrix.copy(src.matrixWorld); m.matrixWorldNeedsUpdate = true; }
    }
    const r = this.renderer;
    const M = globalUniforms.uSilM.value, F = globalUniforms.uSilF.value, S = globalUniforms.uSilS.value;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const shadowAuto = r.shadowMap.autoUpdate, shadowNeeds = r.shadowMap.needsUpdate;
    r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setClearColor(new THREE.Color(FAR_NONE, 0, 0), 1);

    const tile = (k, cam, fn) => {
      const x = (k % COLS) * TILE, y = Math.floor(k / COLS) * TILE;
      this.rt.viewport.set(x, y, TILE, TILE);
      this.rt.scissor.set(x, y, TILE, TILE);
      r.setRenderTarget(this.rt);
      r.clear();
      if (!cam) return;
      this.mat.uniforms.uFn.value.copy(fn);
      r.render(scene, cam);
    };

    // the lit lamps nearest the view
    const lit = env.lights.filter(l => l.light.visible && l.light.intensity > 0 && l.light.isSpotLight)
      .sort((a, b) => a.light.position.distanceToSquared(viewPos) - b.light.position.distanceToSquared(viewPos));
    const tmp = new THREE.Vector3();
    for (let k = 0; k < LAMPS; k++) {
      const L = lit[k]?.light;
      if (!L) { F[k].set(0, 0, 0, -1); tile(k, null); continue; }
      const cam = this.lampCams[k];
      L.getWorldPosition(cam.position);
      L.target.getWorldPosition(tmp);
      // straight down with a lean toward where the lamp points
      tmp.set(cam.position.x + (tmp.x - cam.position.x) * 0.3, cam.position.y - 10, cam.position.z + (tmp.z - cam.position.z) * 0.3);
      cam.up.set(1, 0, 0);
      cam.lookAt(tmp);
      cam.updateMatrixWorld(true);
      M[k].multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      F[k].set(cam.position.x, cam.position.y, cam.position.z, 0);
      // metres per unit of tile at 1 m distance; light source size; irradiance scale
      S[k].set(2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)), 0.35, L.intensity, 0);
      tile(k, cam, F[k]);
    }
    // the sun
    const sunDir = env.sun.position.clone().sub(env.sun.target.position).normalize();
    const sunOn = env.sun.visible !== false && sunDir.y > 0.02 && env.sun.intensity > 0;
    if (sunOn) {
      const c = this.sunCam;
      c.position.set(focus[0], 0, focus[1]).addScaledVector(sunDir, 150);
      c.up.set(0, 1, 0);
      if (Math.abs(sunDir.y) > 0.99) c.up.set(1, 0, 0);
      c.lookAt(focus[0], 0, focus[1]);
      c.updateMatrixWorld(true);
      M[LAMPS].multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
      // depth = distance along the light ray from a plane: dot(P, -sunDir)
      F[LAMPS].set(-sunDir.x, -sunDir.y, -sunDir.z, 1);
      S[LAMPS].set(c.right - c.left, 0.012, env.sun.intensity, 0);
      tile(LAMPS, c, F[LAMPS]);
    } else { F[LAMPS].set(0, 0, 0, -1); tile(LAMPS, null); }
    globalUniforms.uSilSun.value.copy(sunDir);

    r.setClearColor(prevClear, prevAlpha);
    r.shadowMap.autoUpdate = shadowAuto; r.shadowMap.needsUpdate = shadowNeeds;
    r.setRenderTarget(prevTarget);
    globalUniforms.uSilOn.value = 1;
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
    globalUniforms.uSilOn.value = 0;
  }
}
