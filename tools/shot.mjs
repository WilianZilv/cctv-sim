// Headless capture: node tools/shot.mjs "<query>" out.png [waitMs]
// Uses the installed Chrome in new-headless mode with the real GPU (no window).
import { chromium } from 'playwright-core';
const [query = '', out = 'shots/shot.png', wait = '60000'] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', m => { if (!m.text().includes('X4')) logs.push(`[${m.type()}] ${m.text().slice(0, 1500)}`); });
let failed = false;
page.on('pageerror', e => { logs.push('[pageerror] ' + e.message); failed = true; });
if (process.env.CFG) await page.addInitScript(c => localStorage.setItem('cctv-sim-config-v1', c), process.env.CFG);
const t0 = Date.now();
await page.goto('http://localhost:30140/' + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  const end = Date.now() + +wait;
  while (Date.now() < end && !failed) {
    if (await page.evaluate(() => window.__ready === true || !!window.__error)) break;
    await page.waitForTimeout(500);
  }
  if (Date.now() >= end) throw new Error('t');
} catch { logs.push('[timeout] waiting for __ready'); }
const err = await page.evaluate(() => window.__error || null);
if (err) logs.push('[app error] ' + err);
await page.waitForTimeout(300);
await page.screenshot({ path: out });
console.log(logs.join('\n'));
console.log(`done in ${Date.now() - t0} ms -> ${out}`);
await browser.close();
