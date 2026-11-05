// GPU rain as camera-facing streak quads in a box that follows the camera.
// A drop has no colour of its own: it refracts/reflects what is around it, so it
// carries the ambient sky light (invisible against the sky, faint against dark
// walls) plus a strong forward-scattered glint from nearby lamps, headlights and
// the camera's own IR LEDs. Streak length = fall speed x exposure time; drops
// close to the lens are out of focus (wide and faint).
import * as THREE from 'three';

const MAX_LIGHTS = 8;

export function createRain(count = 60000) {
  const corner = new Float32Array(count * 4 * 2);
  const seed = new Float32Array(count * 4 * 4);
  const idx = [];
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < 4; k++) {
      corner.set([k & 1 ? 1 : -1, k & 2 ? 1 : 0], (i * 4 + k) * 2);
      seed.set(s, (i * 4 + k) * 4);
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  g.setIndex(idx);
  const lightPos = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4());
  const lightCol = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3());
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRate: { value: 0 },
      uAmbient: { value: new THREE.Vector3() }, uExpTime: { value: 1 / 60 }, uWind: { value: new THREE.Vector2(0.6, 0.2) },
      uLightPos: { value: lightPos }, uLightCol: { value: lightCol }, uNLights: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #define MAX_LIGHTS ${MAX_LIGHTS}
      attribute vec2 aCorner;
      attribute vec4 aSeed;
      uniform float uTime, uRate, uExpTime;
      uniform vec3 uCenter, uAmbient;
      uniform vec2 uWind;
      uniform vec4 uLightPos[MAX_LIGHTS];   // xyz, intensity (kcd)
      uniform vec3 uLightCol[MAX_LIGHTS];
      uniform int uNLights;
      varying vec3 vCol;
      varying float vA;
      varying float vX;
      void main() {
        vec3 box = vec3(22.0, 14.0, 22.0);
        float speed = 6.5 + aSeed.w * 3.0;
        vec3 p = vec3(aSeed.x, 0.0, aSeed.y) * box;
        p.y = box.y - mod(aSeed.z * box.y + uTime * speed, box.y);
        p.xz += uWind * (box.y - p.y) * 0.08;
        vec3 lo = uCenter - box * 0.5;
        vec3 wp = vec3(lo.x + mod(p.x - lo.x, box.x), uCenter.y - 5.0 + p.y, lo.z + mod(p.z - lo.z, box.z));
        vec3 vel = vec3(uWind.x * 0.6, -speed, uWind.y * 0.6);
        // streak: from the drop back along its motion during the exposure
        float len = max(0.02, speed * uExpTime);
        vec3 top = wp - vel / speed * len;
        vec3 pos = mix(wp, top, aCorner.y);
        vec4 v = viewMatrix * vec4(pos, 1.0);
        vec4 v0 = viewMatrix * vec4(wp, 1.0), v1 = viewMatrix * vec4(top, 1.0);
        vec2 dir = normalize((v1.xy / -v1.z) - (v0.xy / -v0.z) + vec2(1e-5));
        vec2 side = vec2(-dir.y, dir.x);
        float dist = -v.z;
        // drop ~2 mm; near the lens it is blurred into a wide, faint smear
        float blur = 0.012 * max(0.0, 1.8 - dist);
        float w = 0.0012 + blur;
        v.xy += side * aCorner.x * (w + dist * 0.0007);
        gl_Position = projectionMatrix * v;
        vX = aCorner.x;
        // light carried by the drop: ambient sky plus forward-scattered lamps
        vec3 col = uAmbient * 0.6;
        vec3 toCam = normalize(cameraPosition - wp);
        for (int i = 0; i < MAX_LIGHTS; i++) {
          if (i >= uNLights) break;
          vec3 L = uLightPos[i].xyz - wp;
          float d2 = max(dot(L, L), 2.0);
          vec3 Ln = L * inversesqrt(d2);
          // glints when the drop sits between the light and the camera
          // drops scatter forward strongly and also retro-reflect toward the source
          float c = dot(-Ln, toCam);
          float fwd = pow(max(c, 0.0), 6.0) * 6.0 + pow(max(-c, 0.0), 8.0) * 3.0 + 0.3;
          col += uLightCol[i] * uLightPos[i].w / d2 * fwd * 0.4;
        }
        float isOn = step(aSeed.w, uRate);
        // a thin streak over a long exposure covers each pixel only briefly
        float cover = clamp(0.02 / len, 0.15, 1.0);
        vA = isOn * (0.4 + 0.6 * aSeed.x) * cover / (1.0 + blur * 250.0) * smoothstep(0.4, 1.5, dist);
        vCol = col;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      varying float vX;
      void main() {
        if (vA <= 0.0) discard;
        float prof = 1.0 - vX * vX;
        gl_FragColor = vec4(vCol * vA * prof, 1.0);
      }`,
    // streak quads are built in view space; their winding depends on the fall direction
    side: THREE.DoubleSide,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  return {
    mesh,
    setRate(r) { mat.uniforms.uRate.value = r; mesh.visible = r > 0; },
    // lights: [{ pos: Vector3, color: Color, intensity }] nearest first
    update(t, center, ambient, exposureTime, lights = []) {
      const u = mat.uniforms;
      u.uTime.value = t;
      u.uCenter.value.copy(center);
      u.uAmbient.value.set(ambient.r, ambient.g, ambient.b);
      u.uExpTime.value = exposureTime;
      const n = Math.min(MAX_LIGHTS, lights.length);
      for (let i = 0; i < n; i++) {
        const l = lights[i];
        lightPos[i].set(l.pos.x, l.pos.y, l.pos.z, l.intensity);
        lightCol[i].set(l.color.r, l.color.g, l.color.b);
      }
      u.uNLights.value = n;
    },
  };
}
