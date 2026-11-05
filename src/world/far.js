// Far field beyond the detailed region: ground out to the horizon, a low-detail city
// (houses, a few towers, tree crowns) on a street grid aligned with the site, and
// a ring of distant hills. Cheap materials, no shadows; haze does the rest.
import * as THREE from 'three';
import { Region } from '../core/geom.js';
import { polyGeometry, Batcher } from './mesh.js';
import { WALL_COLORS } from '../map/layout.js';

// Window grid computed from world position on vertical faces: no UVs needed, works
// for any instance scale. Glass is dark with some sky; a share are lit at night.
const farNight = { value: 0 };
export function setFarNight(v) { farNight.value = v; }
function withWindows(mat, o) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.uniforms.uFarNight = farNight;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFarNight;\nfloat winMask = 0.0; float winLit = 0.0;')
      .replace('vec3 nz = texture2D(uNoiseTex, vWPos.xz * 0.013).rgb;', `
  {
    vec3 wn = normalize(vWNrm);
    if (abs(wn.y) < 0.5) {
      vec2 t = normalize(vec2(-wn.z, wn.x));
      float hz = dot(vWPos.xz, t);
      float fy = vWPos.y / ${o.floorH.toFixed(2)};
      float fx = hz / ${o.bay.toFixed(2)};
      float cx = abs(fract(fx) - 0.5), cy = fract(fy);
      winMask = step(cx, ${o.win.toFixed(2)} * 0.5) * step(${o.rows[0].toFixed(2)}, cy) * step(cy, ${o.rows[1].toFixed(2)}) * step(1.0, vWPos.y - 0.0);
      float h = fract(sin(dot(floor(vec2(fx, fy)) + floor(vWPos.xz * 0.05), vec2(12.9898, 78.233))) * 43758.5453);
      winLit = winMask * step(1.0 - ${o.lit.toFixed(2)}, h);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.035, 0.04) + 0.04 * h, winMask);
    }
  }
  vec3 nz = texture2D(uNoiseTex, vWPos.xz * 0.013).rgb;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.55) * winLit * uFarNight * 0.004;');
  };
  const key = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => key + '-farwin';
  return mat;
}

export function buildFarField(ctx) {
  const { layout, lib, gy, group, rng, city } = ctx;
  const R = layout.R;
  const r = rng.fork('far');
  const B = new Batcher();
  const edgeY = (x, z) => gy(Math.max(-R, Math.min(R, x)), Math.max(-R, Math.min(R, z)));

  // ---- ground ring out to 1.5 km (sits a hair under the detailed ground at the seam)
  const ring = Region.rect(-1500, -1500, 1500, 1500).minus(Region.rect(-R + 1, -R + 1, R - 1, R - 1));
  const groundMat = lib.get('asphalt_old', { macro: 0.6, porosity: 0.6 });
  B.add('farGround', groundMat, polyGeometry(ring.expolys(), { yFn: (x, z) => edgeY(x, z) - 0.25, uvFn: (x, z) => [x, z], maxEdge: 120 }));

  // ---- street grid aligned with the main road near the camera
  const main = layout.roads.slice().sort((a, b) => b.len - a.len)[0];
  let ang = 0;
  if (main) { const a = main.pts[0], b = main.pts[main.pts.length - 1]; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
  const blockU = r.float(70, 110), blockV = r.float(45, 70), street = r.float(9, 14);
  const towerP = city === 'sp' ? 0.02 : 0.01;
  const mats = new Map();
  const wallMat = (c) => {
    if (!mats.has(c)) mats.set(c, lib.plain({ color: c, roughness: 0.9 }, { porosity: 0.4, grime: 0.6 }));
    return mats.get(c);
  };
  const roofMats = [lib.plain({ color: '#8a4a32', roughness: 0.85 }, { porosity: 0.5 }), lib.plain({ color: '#7d7d78', roughness: 0.9 }, { porosity: 0.5 }), lib.plain({ color: '#6a3a28', roughness: 0.85 }, { porosity: 0.5 })];
  const treeMat = lib.plain({ color: '#24371a', roughness: 0.95 }, { porosity: 0.2, irGain: 2.6 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const roofG = new THREE.ConeGeometry(0.75, 1, 4, 1).rotateY(Math.PI / 4);
  // far tree: three crossed leaf cards around a dark core, instanced
  const blob = (() => {
    const parts = [];
    for (let k = 0; k < 3; k++) {
      const p = new THREE.PlaneGeometry(2.3, 2.0);
      p.rotateY(k * Math.PI / 3);
      parts.push(p);
    }
    const top = new THREE.PlaneGeometry(2.1, 2.1).rotateX(-Math.PI / 2);
    parts.push(top);
    const pos = [], uv = [], nrm = [];
    for (const p of parts) {
      const g = p.toNonIndexed();
      pos.push(...g.attributes.position.array); uv.push(...g.attributes.uv.array);
      for (let i = 0; i < g.attributes.position.count; i++) nrm.push(0, 1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  })();
  const coreG = new THREE.IcosahedronGeometry(0.6, 1);
  const leafMat = lib.get('foliage_dark', { side: THREE.DoubleSide, porosity: 0.2, irGain: 2.6, ao: false, pom: false });
  // instanced: thousands of far boxes would make the merge step slow
  const inst = new Map();
  const place = (g, mat, key, x, y, z, sx, sy, sz, rot, color) => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(sx, sy, sz));
    const k = key;
    let e = inst.get(k);
    if (!e) { e = { g, mat: k === 'farWall' ? wallMatAll : k === 'farTower' ? towerMat : mat, list: [] }; inst.set(k, e); }
    e.list.push([m, color]);
  };
  const wallMatAll = withWindows(lib.plain({ color: '#ffffff', roughness: 0.9 }, { porosity: 0.4 }), { floorH: 2.9, bay: 3.2, win: 0.42, rows: [0.38, 0.78], lit: 0.12 });
  const towerMat = withWindows(lib.plain({ color: '#ffffff', roughness: 0.6 }, { porosity: 0.3 }), { floorH: 2.9, bay: 1.8, win: 0.55, rows: [0.25, 0.85], lit: 0.25 });
  const rot = -ang;
  const maxD = 900;
  for (let i = -Math.ceil(maxD / blockU); i <= Math.ceil(maxD / blockU); i++) {
    for (let j = -Math.ceil(maxD / blockV); j <= Math.ceil(maxD / blockV); j++) {
      // lots along both long sides of each block
      for (const side of [0, 1]) {
        let s = street / 2;
        while (s < blockU - street / 2) {
          const w = r.float(6, 14);
          const d = r.float(9, 18);
          const cu = i * blockU + s + w / 2, cv = j * blockV + (side ? blockV - street / 2 - d / 2 : street / 2 + d / 2);
          s += w + r.float(0, 1.5);
          const x = ux * cu + vx * cv, z = uz * cu + vz * cv;
          const dist = Math.hypot(x, z);
          if (dist > maxD || (Math.abs(x) < R + 4 && Math.abs(z) < R + 4)) continue;
          const y0 = edgeY(x, z) - 0.3;
          if (r.chance(0.12)) {
            // a tree in a yard instead of a house
            const tr = r.float(2.5, 5);
            place(blob, leafMat, 'farTree', x, y0 + tr * 1.3, z, tr, tr, tr, r.float(0, 6));
            place(coreG, treeMat, 'farCore', x, y0 + tr * 1.3, z, tr, tr * 0.8, tr, 0);
            continue;
          }
          const tower = dist > 350 && r.chance(towerP);
          const h = tower ? r.float(25, 75) : r.weighted([[r.float(3, 4), 5], [r.float(5.5, 7.5), 3], [r.float(8, 11), 1]]);
          const col = tower ? r.pick(['#7a766f', '#6c6862', '#85807a', '#5f5c58']) : r.pick(WALL_COLORS);
          place(box, null, tower ? 'farTower' : 'farWall', x, y0 + h / 2, z, w * 0.95, h, d, rot, col);
          if (!tower && r.chance(0.55)) place(roofG, r.pick(roofMats), 'farRoof', x, y0 + h + 0.9, z, w * 1.05, 1.8, d * 1.05, rot);
          if (tower) { (ctx.farLights ||= []).push({ x, y: y0 + h, z }); }
        }
      }
      // street trees on some blocks
      if (r.chance(0.5)) {
        for (let k = 0; k < r.int(1, 4); k++) {
          const cu = i * blockU + r.float(0, blockU), cv = j * blockV + street / 2;
          const x = ux * cu + vx * cv, z = uz * cu + vz * cv;
          if (Math.hypot(x, z) > maxD || (Math.abs(x) < R + 4 && Math.abs(z) < R + 4)) continue;
          const tr = r.float(2.5, 4.5);
          place(blob, leafMat, 'farTree', x, edgeY(x, z) + tr * 1.4, z, tr, tr, tr, r.float(0, 6));
          place(coreG, treeMat, 'farCore', x, edgeY(x, z) + tr * 1.4, z, tr, tr * 0.8, tr, 0);
        }
      }
    }
  }

  // ---- distant hills: a jagged ring 2.5-4 km out, coloured like vegetation; haze greys them
  const hillMat = lib.plain({ color: city === 'cwb' ? '#2e3d26' : '#3a4234', roughness: 1 }, { porosity: 0.2, irGain: 2 });
  const N = 256;
  const pos = [];
  const base = edgeY(0, 0) - 20;
  const hr = r.fork('hills');
  const phase = [hr.float(0, 6), hr.float(0, 6), hr.float(0, 6)];
  const amp = city === 'cwb' ? 45 : 70;
  const hAt = (a) => Math.max(0, amp * (0.55 + 0.45 * Math.sin(a * 3 + phase[0])) * (0.6 + 0.4 * Math.sin(a * 7 + phase[1])) + 18 * Math.sin(a * 23 + phase[2]));
  for (let k = 0; k < N; k++) {
    const a0 = k / N * Math.PI * 2, a1 = (k + 1) / N * Math.PI * 2;
    const rd = 3200;
    const p = (a, h) => [Math.cos(a) * rd, base + h, Math.sin(a) * rd];
    const A = p(a0, 0), Bp = p(a1, 0), C = p(a1, hAt(a1)), D = p(a0, hAt(a0));
    pos.push(...A, ...C, ...Bp, ...A, ...D, ...C);
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
  hg.computeVertexNormals();
  hillMat.side = THREE.DoubleSide;
  B.add('hills', hillMat, hg);

  for (const [k, e] of inst) {
    const im = new THREE.InstancedMesh(e.g, e.mat, e.list.length);
    e.list.forEach(([m, c], i) => { im.setMatrixAt(i, m); if (c) im.setColorAt(i, new THREE.Color(c)); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = 'far:' + k;
    group.add(im);
  }
  const meshes = B.build(group, { castShadow: false, receiveShadow: false });
  for (const m of meshes) m.name = 'far:' + m.name;
  return meshes;
}
