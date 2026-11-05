// Low-detail stand-in of the street for reflection probes (the GTA V approach:
// reflections render a cheap version of the world, so they can be refreshed many
// times a second). Built once from the layout: ground coloured by surface
// (asphalt, sidewalk, yards), buildings and front walls as painted boxes, trees
// as blobs, the sky environment as background, the sun, the sky fill and the
// nearest street lamps as lights, and every vehicle and pedestrian as a moving
// block. One static mesh plus two instanced meshes: a few draw calls per face.
import * as THREE from 'three';

const R = 95;          // metres around the focus
const CELL = 1.5;      // ground grid
const MAX_DYN = 48;    // vehicle and pedestrian blocks
const N_LAMPS = 6;     // fixed, so the probe program never recompiles

const C = (hex) => new THREE.Color(hex);   // sRGB hex -> linear working colour

export function buildProbeScene(ctx, env) {
  const { layout, focus } = ctx;
  const scene = new THREE.Scene();
  const pos = [], col = [];
  const tri = (a, b, c, color) => { for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); col.push(color.r, color.g, color.b); } };
  const quad = (a, b, c, d, color) => { tri(a, b, c, color); tri(a, c, d, color); };
  const near = (x, z, r = R) => Math.hypot(x - focus[0], z - focus[1]) < r;

  // ---- ground
  const { carr, sidewalk } = layout.regions;
  const ASPHALT = C('#3b3b3d'), WALK = C('#9a958b'), YARD = C('#6e675c');
  const n = Math.ceil(2 * R / CELL);
  const x0 = focus[0] - R, z0 = focus[1] - R;
  const gv = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = x0 + i * CELL, z = z0 + j * CELL;
    let y, c;
    if (carr.contains(x, z)) { y = ctx.roadSurf(x, z); c = ASPHALT; }
    else if (sidewalk.contains(x, z)) { y = ctx.sidewalkY(x, z); c = WALK; }
    else { y = ctx.gy(x, z) + 0.17; c = YARD; }
    gv.push([x, y, z, c]);
  }
  const V = (i, j) => gv[j * (n + 1) + i];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
    const cc = a[3] === b[3] && a[3] === c[3] ? a[3] : a[3].clone().add(b[3]).add(c[3]).add(d[3]).multiplyScalar(0.25);
    // counter-clockwise seen from above (x east, z south)
    tri(a, d, c, cc); tri(a, c, b, cc);
  }

  // ---- buildings: prisms from the footprint
  const ROOF = { ceramic: C('#8a4f3c'), fibro: C('#9c9a92'), flat: C('#8d8a84') };
  for (const b of layout.buildings) {
    const ring = b.outer;
    if (!ring?.length) continue;
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    if (!near(cx, cz, R + 20)) continue;
    const base = b.groundRef ?? ctx.gy(cx, cz);
    const top = b.top ?? base + (b.h || 6);
    const wallC = C(b.color || '#b8b0a2');
    let area = 0;
    for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; area += p[0] * q[1] - q[0] * p[1]; }
    const ccw = area > 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const [A, B2] = ccw ? [q, p] : [p, q];
      quad([A[0], base, A[1]], [B2[0], base, B2[1]], [B2[0], top, B2[1]], [A[0], top, A[1]], wallC);
    }
    const tris = THREE.ShapeUtils.triangulateShape(ring.map(p => new THREE.Vector2(p[0], p[1])), []);
    const roofC = ROOF[b.roof] || ROOF.flat;
    for (const t of tris) {
      const [a, bb, c] = t.map(k => [ring[k][0], top, ring[k][1]]);
      // facing up
      const cross = (bb[0] - a[0]) * (c[2] - a[2]) - (bb[2] - a[2]) * (c[0] - a[0]);
      if (cross < 0) tri(a, bb, c, roofC); else tri(a, c, bb, roofC);
    }
  }

  // ---- front walls: thin boxes along each lot frontage
  const box = (cx, cy, cz, tx, tz, len, h, th, color) => {
    const nx = -tz, nz = tx;
    const P = (s, y, o) => [cx + tx * s + nx * o, cy + y, cz + tz * s + nz * o];
    const l = len / 2, t = th / 2;
    quad(P(-l, 0, t), P(l, 0, t), P(l, h, t), P(-l, h, t), color);
    quad(P(l, 0, -t), P(-l, 0, -t), P(-l, h, -t), P(l, h, -t), color);
    quad(P(-l, h, t), P(l, h, t), P(l, h, -t), P(-l, h, -t), color);
    quad(P(-l, 0, -t), P(-l, 0, t), P(-l, h, t), P(-l, h, -t), color);
    quad(P(l, 0, t), P(l, 0, -t), P(l, h, -t), P(l, h, t), color);
  };
  for (const lot of layout.lots) {
    const w = lot.wall;
    if (!w || !near(lot.a[0], lot.a[1])) continue;
    const cx = lot.a[0] + lot.t[0] * lot.len / 2, cz = lot.a[1] + lot.t[1] * lot.len / 2;
    box(cx, ctx.gy(cx, cz) + 0.17, cz, lot.t[0], lot.t[1], lot.len, w.h, 0.2, C(w.color || '#b8b0a2'));
  }

  // ---- trees: trunk and a crown
  const TRUNK = C('#4a3b2c'), LEAF = C('#3c5428');
  const ico = new THREE.IcosahedronGeometry(1, 0).toNonIndexed().attributes.position.array;
  for (const t of ctx.trees || []) {
    if (!near(t.x, t.z)) continue;
    const y0 = ctx.sidewalkY ? ctx.sidewalkY(t.x, t.z) : ctx.gy(t.x, t.z);
    box(t.x, y0, t.z, 1, 0, 0.25, 2.6, 0.25, TRUNK);
    const cr = 2.2, cy = y0 + 4.2;
    for (let i = 0; i < ico.length; i += 9) tri(
      [t.x + ico[i] * cr, cy + ico[i + 1] * cr * 0.8, t.z + ico[i + 2] * cr],
      [t.x + ico[i + 3] * cr, cy + ico[i + 4] * cr * 0.8, t.z + ico[i + 5] * cr],
      [t.x + ico[i + 6] * cr, cy + ico[i + 7] * cr * 0.8, t.z + ico[i + 8] * cr], LEAF);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const world = new THREE.Mesh(geo, mat);
  world.matrixAutoUpdate = false;
  world.castShadow = world.receiveShadow = true;
  scene.add(world);

  // ---- moving blocks: vehicles (paint colour) and people
  const dynGeo = new THREE.BoxGeometry(1, 1, 1);
  dynGeo.translate(0, 0.5, 0);
  const dyn = new THREE.InstancedMesh(dynGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }), MAX_DYN);
  dyn.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dyn.frustumCulled = false;
  dyn.castShadow = dyn.receiveShadow = true;
  dyn.count = 0;
  for (let i = 0; i < MAX_DYN; i++) dyn.setColorAt(i, new THREE.Color(1, 1, 1));
  scene.add(dyn);

  // ---- lights (copies of the real ones, synced every capture)
  // the sun casts shadows here too: without them every wall and the street were
  // sunlit in the reflections, and the cars came out far too bright
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 400 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const fill = new THREE.HemisphereLight();
  scene.add(fill);
  const lamps = [];
  for (let i = 0; i < N_LAMPS; i++) { const l = new THREE.PointLight('#ffffff', 0, 40, 2); lamps.push(l); scene.add(l); }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p3 = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
  const ped = new THREE.Color('#5a5650');
  let lastEnv = null;

  return {
    scene,
    // vehicles: [{ obj, x, z, yaw, w, l, h, color }], skip: the vehicle whose probe is being captured
    sync(at) {
      // sun, fill, sky
      sun.color.copy(env.sun.color); sun.intensity = env.sun.visible === false ? 0 : env.sun.intensity;
      // anchored on the focus (not the probe) so one shadow map serves every probe
      const f = new THREE.Vector3(focus[0], at.y, focus[1]);
      sun.position.copy(env.sun.position).sub(env.sun.target.position).normalize().multiplyScalar(200).add(f);
      sun.target.position.copy(f);
      sun.target.updateMatrixWorld();
      fill.color.copy(env.fill.color); fill.groundColor.copy(env.fill.groundColor); fill.intensity = env.fill.intensity;
      if (env.envRT && env.envRT !== lastEnv) { lastEnv = env.envRT; scene.background = env.envRT.texture; scene.environment = env.envRT.texture; }
      // the street lamps nearest to the probe
      const lit = env.lights.filter(l => l.light.visible && l.light.intensity > 0 && l.light.position)
        .sort((a, b) => a.light.position.distanceToSquared(at) - b.light.position.distanceToSquared(at));
      for (let i = 0; i < N_LAMPS; i++) {
        const src = lit[i]?.light;
        if (!src) { lamps[i].intensity = 0; continue; }
        lamps[i].position.copy(src.getWorldPosition(p3));
        lamps[i].color.copy(src.color);
        // a spot pointing down lights about half the sphere a point light would
        lamps[i].intensity = src.intensity * 0.5;
        lamps[i].distance = src.distance || 40;
      }
    },
    setDynamic(blocks) {
      let k = 0;
      for (const b of blocks) {
        if (k >= MAX_DYN) break;
        q.setFromAxisAngle(yAxis, b.yaw || 0);
        sc.set(b.w, b.h, b.l);
        m4.compose(p3.set(b.x, b.y, b.z), q, sc);
        dyn.setMatrixAt(k, m4);
        dyn.setColorAt(k, b.color || ped);
        b.slot = k++;
      }
      dyn.count = k;
      dyn.instanceMatrix.needsUpdate = true;
      if (dyn.instanceColor) dyn.instanceColor.needsUpdate = true;
    },
    // hide one block (the car being captured sits inside its own block)
    hideSlot(k, hidden) {
      if (k === undefined || k < 0) return;
      dyn.getMatrixAt(k, m4);
      if (hidden) { dyn.userData.saved = m4.clone(); dyn.setMatrixAt(k, new THREE.Matrix4().makeScale(0, 0, 0)); }
      else if (dyn.userData.saved) dyn.setMatrixAt(k, dyn.userData.saved);
      dyn.instanceMatrix.needsUpdate = true;
    },
    triangles: pos.length / 9,
    dispose() { geo.dispose(); mat.dispose(); dynGeo.dispose(); dyn.material.dispose(); },
  };
}
