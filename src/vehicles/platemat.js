// The licence plate as a material: an aluminium sheet with stamped characters
// and border, covered by retroreflective film.
//
// From generatePlate(..., { relief: true }) the plate has, beside its colour,
// a relief: height (255 = relief.heightMM), film coverage and bare metal. The
// height becomes a tangent-space normal map; film and metal ride along in a
// second texture read by the plate's own shader addition:
//   - the film is a semi-gloss sheet under a thin clear coat;
//   - retroreflection: glass beads / micro prisms send light back toward its
//     source, so a lamp right next to the lens (the camera's IR LEDs, a
//     headlight behind the camera) makes the white film glow. The printed ink
//     filters what comes back: black characters stay black, the blue band
//     returns blue, worn film returns less;
//   - where the film is gone (screws, peeled corners, deep scratches) the
//     aluminium shows: metallic, no retroreflection.
// All plates share one program; textures and two scalars are per plate.
import * as THREE from 'three';

const BEVEL = 2.5;

// normal map from the height layer (R) of the packed relief
function normalTexture(relief) {
  const { width: W, height: H, data, mmPerPx, heightMM } = relief;
  // height step per texel -> slope. A die-stamped flank is steeper than the
  // ramp a texel or two wide can hold: BEVEL gives it back
  const k = heightMM / 255 / mmPerPx * BEVEL;
  const out = new Uint8Array(W * H * 4);
  const hAt = (x, y) => data[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // +x along u (right), +y along v (down the rows): tangent and bitangent of the UVs
    const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 0.5 * k;
    const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 0.5 * k;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * W + x) * 4;
    out[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    out[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    out[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
    // film and metal share the alpha: 0.5..1 film coverage, 0.5..0 bare metal
    const film = data[i + 1] / 255, metal = data[i + 2] / 255;
    out[i + 3] = Math.round(metal > 0.5 ? (1 - metal) * 127 : 128 + film * 127);
  }
  return dataTexture(out, W, H);
}

function dataTexture(data, W, H) {
  const t = new THREE.DataTexture(data, W, H);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const DECL = /* glsl */ `
uniform float uPlateRetro;    // retroreflection of this plate's film (0 painted sheet .. 1 new film)
uniform float uPlateAge;
vec4 plateProps = vec4(0.0);
// retroreflected radiance per unit irradiance, around the source direction.
// Real sheeting returns some hundred times what white paint does within a
// fraction of a degree; this keeps the shape (a narrow core and a wide skirt)
// at a level the camera's exposure can still hold.
float plateRetroLobe(vec3 L, vec3 V, vec3 N) {
  float c = clamp(dot(L, V), -1.0, 1.0);
  float a = acos(c);                      // observation angle
  float core = exp(-pow(a / 0.035, 2.0)); // ~2 degrees
  float skirt = exp(-pow(a / 0.14, 2.0)); // ~8 degrees
  // entrance angle: the beads lose efficiency off-axis
  float ent = pow(clamp(dot(N, L), 0.0, 1.0), 0.6);
  return (4.5 * core + 0.6 * skirt) * ent;
}
`;

// film, metal and age, after the base roughness / metalness and the wear system
const ROUGH = /* glsl */ `
{
  float pa = texture2D(normalMap, vNormalMapUv).a;
  plateProps = vec4(0.0, clamp(pa * 2.0 - 1.0, 0.0, 1.0), clamp(1.0 - pa * 2.0, 0.0, 1.0), 0.0);
  float metal = plateProps.b;
  // aluminium (screws, peeled film) is metallic and smoother; the film has a
  // fine pebbled grain that the age turns dull
  roughnessFactor = mix(roughnessFactor + 0.25 * uPlateAge, 0.32, metal);
  metalnessFactor = mix(metalnessFactor, 0.9, metal);
}
`;

const RETRO = /* glsl */ `
{
  float film = plateProps.g * uPlateRetro * (1.0 - plateProps.b);
  if (film > 0.0) {
    vec3 Vv = normalize(vViewPosition);
    // a micro-prism cell structure: the return varies a little from cell to
    // cell, fading out where a cell is smaller than a pixel
    vec2 cuv = vMapUv * vec2(1400.0, 460.0);
    vec2 fw = fwidth(cuv);
    float cellVis = 1.0 - smoothstep(0.3, 0.9, max(fw.x, fw.y));
    vec2 ci = floor(cuv);
    float h = fract(sin(dot(ci, vec2(127.1, 311.7))) * 43758.5453);
    film *= 1.0 + (h - 0.5) * 0.5 * cellVis;
    // dirt and wetness (water film scatters the return) take their share
    film *= (1.0 - 0.8 * dirtMask) * (1.0 - 0.5 * wetMask);
    vec3 ret = vec3(0.0);
    IncidentLight rl;
    #if NUM_SPOT_LIGHTS > 0
    for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
      getSpotLightInfo(spotLights[i], geometryPosition, rl);
      ret += rl.color * plateRetroLobe(rl.direction, Vv, normal);
    }
    #endif
    #if NUM_POINT_LIGHTS > 0
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      getPointLightInfo(pointLights[i], geometryPosition, rl);
      ret += rl.color * plateRetroLobe(rl.direction, Vv, normal);
    }
    #endif
    #if NUM_DIR_LIGHTS > 0
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      getDirectionalLightInfo(directionalLights[i], rl);
      ret += rl.color * plateRetroLobe(rl.direction, Vv, normal);
    }
    #endif
    // the ink filters what comes back, crossed twice on the way in and out:
    // dark print stays dark, the blue band returns little (diffuseColor: after
    // dirt, wetness and the IR response)
    vec3 ink = diffuseColor.rgb / 0.92;
    reflectedLight.directSpecular += ret * ink * ink * 0.92 * film;
  }
}
`;

function extend(m, retro, age) {
  const u = { uPlateRetro: { value: retro }, uPlateAge: { value: age } };
  m.userData.plate = u;
  m.defines = { ...(m.defines || {}), PLATE_FILM: '' };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prev.call(m, shader, r);
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DECL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + RETRO)
      // the lacquer follows the stamped relief (no second normal map: texture units are short)
      .replace('#include <clearcoat_normal_fragment_maps>', '#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = normal;\n#endif');
    // after the surface patch and the wear system have set their roughness and metalness
    const i = shader.fragmentShader.indexOf('#include <normal_fragment_begin>');
    shader.fragmentShader = shader.fragmentShader.slice(0, i) + ROUGH + shader.fragmentShader.slice(i);
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => prevKey() + '-plate1';
  return m;
}

// a new plate on the same materials (dataset rounds): the face's colour and relief
// textures get the new pixels in place (same sizes: same kind of vehicle), the film's
// scalars follow. plate: from generatePlate(..., { relief })
export function replacePlate(mats, plate) {
  const face = mats[0];
  const put = (tex, data, W, H) => {
    if (tex.image.width === W && tex.image.height === H) tex.image.data.set(data);
    else tex.image = { data: new Uint8Array(data), width: W, height: H };
    tex.needsUpdate = true;
  };
  const c = plate.canvas;
  put(face.map, c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  const relief = plate.relief;
  if (relief && face.normalMap) {
    const n = normalTexture(relief);
    put(face.normalMap, n.image.data, n.image.width, n.image.height);
    n.dispose();
    const film = relief.retro > 0, age = plate.wear;
    face.roughness = film ? 0.42 : 0.5;
    face.clearcoat = film ? 0.55 - 0.35 * age : 0.7 - 0.4 * age;
    face.clearcoatRoughness = 0.12 + 0.3 * age;
    if (face.userData.plate) { face.userData.plate.uPlateRetro.value = relief.retro; face.userData.plate.uPlateAge.value = age; }
  }
}

// [face, edge] materials for one plate. lib: MaterialLibrary; look: the car's
// look (plate, plateRelief, age, wear, id); wear: the car's wear uniforms or null.
export function plateMaterials(lib, look, wear) {
  const relief = look.plateRelief;
  const age = look.plateWear ?? look.age;
  const common = { skyvisSpec: 0, silRecv: 0, wear, wearId: look.id, wearKind: 4 };
  const face = { name: 'car' + look.id, color: '#ffffff', map: look.plate, roughness: 0.4, metalness: 0 };
  let faceMat;
  if (relief) {
    const film = relief.retro > 0;
    Object.assign(face, {
      physical: true, normalMap: normalTexture(relief),
      // film under a thin lacquer; the painted old sheets are glossier enamel
      roughness: film ? 0.42 : 0.5,
      clearcoat: film ? 0.55 - 0.35 * age : 0.7 - 0.4 * age,
      clearcoatRoughness: 0.12 + 0.3 * age,
    });
    faceMat = extend(lib.plain(face, { porosity: 0.08, dirt: 0.2 + 0.4 * look.age, ...common }), relief.retro, age);
  } else {
    faceMat = lib.plain(face, { porosity: 0.1, dirt: 0.2 + 0.4 * look.age, ...common });
  }
  const edge = lib.plain({ name: 'car' + look.id, color: '#a9adb0', roughness: 0.35, metalness: 0.9 }, { porosity: 0, dirt: 0.3, ...common });
  return [faceMat, edge];
}
