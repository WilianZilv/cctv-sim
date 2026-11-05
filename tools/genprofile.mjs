// Scene generation profile: node tools/genprofile.mjs [seed ...]
// For each seed: a cold load (fresh browser, nothing cached), then a warm rebuild
// in the same page (Shift+G, new random seed) with the CPU profiler on.
// Prints the [sim] stage timings of both and the top self-time functions of the warm one.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['fvwckd99', '4uqp457y', '334brdef'];
const CFG = process.env.CFG;

async function waitReady(page) {
  const end = Date.now() + 300000;
  while (Date.now() < end && !(await page.evaluate(() => window.__ready === true || !!window.__error))) await page.waitForTimeout(100);
}
const parse = (lines) => {
  const out = {};
  for (const l of lines) {
    const m = l.match(/^\[sim\] (.+?) (\d+) ms/);
    if (m) out[m[1]] = (out[m[1]] || 0) + +m[2];
  }
  return out;
};

const runs = [];
const funcs = new Map();
// self time attributed to the build stage on the stack: stage -> fn -> ms
const STAGES = ['buildGround', 'buildWalls', 'buildBuildings', 'buildProps', 'buildGrime', 'buildYards', 'buildLitter', 'buildLayout', 'siteAt', 'bakeAll', 'StreetGI', 'compileAsync', 'animate', 'loop', 'frame'];
const byStage = new Map();
for (const seed of seeds) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  if (CFG) await page.addInitScript(c => localStorage.setItem('cctv-sim-config-v1', c), CFG);
  let lines = [];
  page.on('console', m => { if (m.text().startsWith('[sim]')) lines.push(m.text()); });
  const t0 = Date.now();
  await page.goto('http://localhost:30140/?seed=' + seed + '&frames=5');
  await waitReady(page);
  runs.push({ seed, kind: 'frio', wall: Date.now() - t0, ...parse(lines) });

  // warm: a new scene in the same page, profiled
  lines = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await page.evaluate(() => { window.__ready = false; });
  await cdp.send('Profiler.start');
  const t1 = Date.now();
  await page.keyboard.press('Shift+KeyG');
  await waitReady(page);
  const { profile } = await cdp.send('Profiler.stop');
  runs.push({ seed: seed + ' → aleatória', kind: 'quente', wall: Date.now() - t1, ...parse(lines) });
  const dt = profile.timeDeltas, counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
  const parent = new Map(), byId = new Map();
  for (const n of profile.nodes) { byId.set(n.id, n); for (const c of n.children || []) parent.set(c, n.id); }
  for (const n of profile.nodes) {
    const t = counts.get(n.id) || 0;
    if (!t) continue;
    let stage = 'outros', p = n.id;
    while (p !== undefined) { const fn = byId.get(p).callFrame.functionName; if (STAGES.includes(fn)) { stage = fn; break; } p = parent.get(p); }
    const fk = (n.callFrame.functionName || '(anon)') + ' ' + n.callFrame.url.split('/').pop().split('?')[0] + ':' + (n.callFrame.lineNumber + 1);
    if (!byStage.has(stage)) byStage.set(stage, new Map());
    const sm = byStage.get(stage); sm.set(fk, (sm.get(fk) || 0) + t / 1000 / seeds.length);
    const f = n.callFrame;
    const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
    funcs.set(k, (funcs.get(k) || 0) + t / 1000 / seeds.length);
  }
  await browser.close();
}

const stages = ['site', 'layout', 'bake', 'buildGround', 'buildWalls', 'buildBuildings', 'buildProps', 'buildClutter', 'buildGrime', 'buildYards', 'buildLitter', 'buildFarField', 'world built in', 'environment', 'simulation', 'gi', 'skyvis', 'camera', 'conditions', 'compile', 'rebuild total', 'first frame'];
const pad = (s, n) => String(s).padStart(n);
console.log('etapa'.padEnd(16) + runs.map(r => pad(r.kind, 9)).join(''));
for (const st of stages) console.log(st.replace(' in', '').padEnd(16) + runs.map(r => pad(r[st] ?? '-', 9)).join(''));
console.log('relógio total'.padEnd(16) + runs.map(r => pad(r.wall, 9)).join(''));
console.log('\nseeds: ' + runs.map(r => r.seed).join(' | '));
console.log('\nCPU (rebuild quente, média por seed, self time):');
const top = [...funcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35);
for (const [k, t] of top) console.log(pad(t.toFixed(0), 6) + ' ms  ' + k);
console.log('\nCPU por etapa (rebuild quente, média por seed):');
for (const [st, m] of [...byStage.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const tot = [...m.values()].reduce((x, y) => x + y, 0);
  if (tot < 50) continue;
  console.log('\n' + st + ' ' + tot.toFixed(0) + ' ms');
  for (const [k, t] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) if (t > 20) console.log(pad(t.toFixed(0), 8) + ' ms  ' + k);
}
writeFileSync('shots/genprofile.json', JSON.stringify({ runs, top }, null, 1));
