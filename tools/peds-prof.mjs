// What the pedestrians cost at runtime: node tools/peds-prof.mjs [seed ...]
// Same page (?prof=1, src/debug/prof.js), A/B: peds shown vs hidden (the
// simulation keeps running), then the per-frame sections and draw calls of each.
// Vite's HMR client is stubbed out so edits elsewhere do not reload the page.
import { chromium } from 'playwright-core';
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['fvwckd99', '4uqp457y'];
const WINDOW = +(process.env.WINDOW || 4000);
const HMR_STUB = 'export const createHotContext=()=>({accept(){},dispose(){},prune(){},invalidate(){},decline(){},on(){},off(){},send(){},data:{}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const ErrorOverlay=class{};';

for (const seed of seeds) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.route('**/@vite/client', r => r.fulfill({ body: HMR_STUB, contentType: 'application/javascript' }));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:30140/?seed=${seed}&prof=1&frames=30${process.env.EXTRA || ''}`);
  await page.waitForFunction(() => window.__ready === true && !!window.__app?.(), null, { timeout: 180000 });
  await page.waitForTimeout(1500);
  const measure = async (show) => {
    await page.evaluate((show) => { const p = window.__app().ctx.peds; if (p) p.group.visible = show; }, show);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__prof.reset());
    const t0 = Date.now();
    await page.waitForTimeout(WINDOW);
    const rep = await page.evaluate(() => window.__prof.report());
    rep.fps = rep.frames / ((Date.now() - t0) / 1000);
    return rep;
  };
  const info = await page.evaluate(() => { const p = window.__app().ctx.peds; return p ? { n: p.agents.length, crossings: p.nav.crossings.length } : null; });
  const on1 = await measure(true), off = await measure(false), on2 = await measure(true);
  console.log(`\n=== ${seed}: ${info ? info.n + ' pedestres, ' + info.crossings + ' travessias' : 'sem pedestres'}`);
  console.log('seção'.padEnd(24) + 'com (ms, draws)'.padStart(20) + 'sem (ms, draws)'.padStart(20) + 'com de novo'.padStart(20));
  const keys = [...new Set([...Object.keys(on1.sections), ...Object.keys(off.sections)])].sort((a, b) => (on1.sections[b]?.perFrame || 0) - (on1.sections[a]?.perFrame || 0));
  const cell = (r, k) => { const e = r.sections[k]; return e ? `${e.perCall.toFixed(2)} ${String(e.calls).padStart(5)}`.padStart(20) : ''.padStart(20); };
  for (const k of keys.slice(0, 16)) console.log(k.padEnd(24) + cell(on1, k) + cell(off, k) + cell(on2, k));
  console.log('fps (headless, gl.finish por seção):'.padEnd(44) + on1.fps.toFixed(1).padStart(6) + off.fps.toFixed(1).padStart(20) + on2.fps.toFixed(1).padStart(20));
  await browser.close();
}
