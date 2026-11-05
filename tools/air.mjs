// aerial free-cam view over the focus: node tools/air.mjs "<query>" out.png [height]
import { chromium } from 'playwright-core';
const [query, out, hgt = '45'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
p.on('console', m => { if (m.text().includes('Shader Error')) console.log('SHADER ERROR'); });
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 300000 });
await p.evaluate((h) => { const fc = window.__freecam, c = window.__app().ctx; fc.camera.position.set(c.focus[0] - h * 0.5, c.gy(c.focus[0], c.focus[1]) + h, c.focus[1] + h * 0.5); fc.yaw = -0.785; fc.pitch = -0.9; }, +hgt);
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
console.log(await p.evaluate(() => window.__error || 'ok'));
await b.close();
