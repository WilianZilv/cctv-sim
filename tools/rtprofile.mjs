// Runtime profile (not the build): node tools/rtprofile.mjs [seed ...]
// Loads each seed with ?prof=1 (src/debug/prof.js), lets it settle, then
//  1. times every section of a frame (CPU + the GPU work it submits),
//  2. A/B tests: shadow maps frozen, SSAO off, cars hidden, and each group of
//     scene meshes hidden in turn, measuring how much the scene render drops,
//  3. lists what the scene is made of (draw calls, triangles, shadow lights).
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['fvwckd99', '4uqp457y'];
const WINDOW = +(process.env.WINDOW || 4000);

const results = [];
for (const seed of seeds) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:30140/?seed=${seed}&prof=1&frames=30${process.env.EXTRA || ""}`);
  while (!(await page.evaluate(() => window.__ready === true && typeof window.__app === 'function'))) await page.waitForTimeout(300);
  await page.waitForTimeout(1500);

  const measure = async (label, setup, undo, arg) => {
    if (setup) await page.evaluate(setup, arg);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__prof.reset());
    const t0 = Date.now();
    await page.waitForTimeout(WINDOW);
    const rep = await page.evaluate(() => window.__prof.report());
    rep.fps = rep.frames / ((Date.now() - t0) / 1000);
    if (undo) await page.evaluate(undo, arg);
    return { label, ...rep };
  };

  const base = await measure('base');
  // what the scene is made of
  const scene = await page.evaluate(() => {
    const app = window.__app();
    const groups = new Map();
    let shadowLights = [];
    app.scene.traverse(o => {
      if (o.isLight && o.castShadow && o.visible) shadowLights.push(`${o.type} ${o.shadow.mapSize.x}`);
      if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLineSegments) return;
      const key = (o.name || o.parent?.name || o.type).split(/[:|#]/)[0].replace(/\d+$/, '') || o.type;
      const g = groups.get(key) || { key, meshes: 0, tris: 0, inst: 0, shadow: 0, visible: 0 };
      const geo = o.geometry;
      const tri = geo ? (geo.index ? geo.index.count : geo.attributes.position?.count || 0) / 3 : 0;
      const n = o.isInstancedMesh ? o.count : 1;
      g.meshes++; g.tris += tri * n; g.inst += n > 1 ? n : 0; g.shadow += o.castShadow ? 1 : 0; g.visible += o.visible ? 1 : 0;
      groups.set(key, g);
    });
    const r = app.cctv.renderer;
    return {
      groups: [...groups.values()].sort((a, b) => b.tris - a.tris),
      shadowLights, programs: r.info.programs?.length, textures: r.info.memory.textures, geometries: r.info.memory.geometries,
      res: [app.cctv.sceneRT.width, app.cctv.sceneRT.height], cam: app.spec.name, fps: app.spec.fps,
    };
  });
  const tests = [];
  tests.push(await measure('sombras congeladas', () => { window.__app().cctv.renderer.shadowMap.autoUpdate = false; window.__app().cctv.renderer.shadowMap.needsUpdate = false; window.__noShadow = true; }, () => { window.__app().cctv.renderer.shadowMap.autoUpdate = false; window.__noShadow = false; }));
  tests.push(await measure('material barato (só geometria)', () => { window.__app().scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x808080 }); }, () => { window.__app().scene.overrideMaterial = null; }));
  tests.push(await measure('barato + sombras congeladas', () => { window.__app().scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x808080 }); window.__app().cctv.renderer.shadowMap.autoUpdate = false; window.__app().cctv.renderer.shadowMap.needsUpdate = false; window.__noShadow = true; }, () => { window.__app().scene.overrideMaterial = null; window.__app().cctv.renderer.shadowMap.autoUpdate = false; window.__noShadow = false; }));
  for (const [label, k, v] of [['sem visibilidade do céu', 'uSkyVis', 0], ['sem POM', 'uPomFar', 0], ['sem GI', 'uGiStrength', 0]]) tests.push(await measure(label, ([k, v]) => { window.__gu_prev = window.__gu[k].value; window.__gu[k].value = v; }, ([k]) => { window.__gu[k].value = window.__gu_prev; }, [k, v]));
  tests.push(await measure('sem silhuetas', () => { const a = window.__app(); a._silU = a.sil.update; a.sil.update = () => {}; window.__gu.uSilOn.value = 0; }, () => { const a = window.__app(); a.sil.update = a._silU; }));
  tests.push(await measure('sem sondas de reflexo', () => { const a = window.__app(); a._prT = a.probes.tick; a.probes.tick = () => {}; }, () => { const a = window.__app(); a.probes.tick = a._prT; }));
  tests.push(await measure('sem SSAO', () => { const c = window.__app().cctv; c._pre = c.preRender; c.preRender = null; }, () => { const c = window.__app().cctv; c.preRender = c._pre; }));
  tests.push(await measure('sem carros', () => { for (const c of window.__app().ctx.parked || []) c.visible = false; window.__app().scene.traverse(o => { if (o.userData.decal) o.visible = false; }); }, () => { for (const c of window.__app().ctx.parked || []) c.visible = true; window.__app().scene.traverse(o => { if (o.userData.decal) o.visible = true; }); }));
  // hide each big group of meshes in turn
  for (const g of process.env.GROUPS === '0' ? [] : scene.groups.slice(0, 14)) {
    tests.push(await measure('sem ' + g.key, (k) => {
      window.__hidden = [];
      window.__app().scene.traverse(o => {
        if ((o.isMesh || o.isInstancedMesh || o.isPoints || o.isLineSegments) && ((o.name || o.parent?.name || o.type).split(/[:|#]/)[0].replace(/\d+$/, '') || o.type) === k && o.visible) { o.visible = false; window.__hidden.push(o); }
      });
    }, () => { for (const o of window.__hidden) o.visible = true; }, g.key));
  }
  results.push({ seed, base, scene, tests });
  await browser.close();
}

const fmt = (x) => String(x).padStart(8);
for (const r of results) {
  console.log(`\n=== ${r.seed}  câmera ${r.scene.cam} (${r.scene.fps} fps), cena ${r.scene.res.join('x')}, ${r.scene.programs} programas, ${r.scene.textures} texturas`);
  console.log(`luzes com sombra: ${r.scene.shadowLights.join(', ') || 'nenhuma'}`);
  console.log(`fps no headless (com gl.finish por seção): ${r.base.fps.toFixed(1)}`);
  console.log('seção'.padEnd(26) + fmt('ms/quad') + fmt('ms/cham') + fmt('máx') + fmt('chamad.') + fmt('draws') + '   triângulos');
  for (const [k, e] of Object.entries(r.base.sections).sort((a, b) => b[1].perFrame - a[1].perFrame)) console.log(k.padEnd(26) + fmt(e.perFrame) + fmt(e.perCall) + fmt(e.max) + fmt(e.n) + fmt(e.calls) + '   ' + e.tris);
  const sc = (rep) => rep.sections['capture/scene']?.perCall ?? NaN;
  const ss = (rep) => rep.sections['capture/ssao']?.perCall ?? NaN;
  console.log(`\nA/B (ms por captura: cena / ssao):  base ${sc(r.base).toFixed(2)} / ${ss(r.base).toFixed(2)}`);
  for (const t of r.tests) console.log('  ' + t.label.padEnd(28) + fmt(sc(t).toFixed(2)) + ' / ' + ss(t).toFixed(2) + `   (cena ${(sc(t) - sc(r.base)).toFixed(2)})`);
  console.log('\ngrupos de malhas (triângulos):');
  for (const g of r.scene.groups.slice(0, 20)) console.log('  ' + g.key.padEnd(26) + fmt(g.meshes) + ' malhas' + fmt(Math.round(g.tris)) + ' tri' + (g.inst ? ` ${g.inst} inst` : '') + ` sombra:${g.shadow}`);
}
writeFileSync('shots/rtprofile.json', JSON.stringify(results, null, 1));
