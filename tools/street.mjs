// street-level view along the focus road: node tools/street.mjs "<query>" out.png [back] [height]
import { chromium } from 'playwright-core';
const [query, out, back = '0', hgt = '1.7'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
p.on('console', m => { if (m.text().includes('Shader Error')) console.log('SHADER ERROR'); });
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 300000 });
await p.evaluate(([back, hgt]) => {
  const app = window.__app(), fc = window.__freecam, f = app.ctx.focus;
  const lot = app.layout.lots.slice().sort((a, b) => Math.hypot(a.c[0] - f[0], a.c[1] - f[1]) - Math.hypot(b.c[0] - f[0], b.c[1] - f[1]))[0];
  const x = lot.c[0] - lot.n[0] * (lot.sw + lot.road.w * 0.3) - lot.t[0] * back, z = lot.c[1] - lot.n[1] * (lot.sw + lot.road.w * 0.3) - lot.t[1] * back;
  fc.camera.position.set(x, app.ctx.gy(x, z) + hgt, z);
  const dx = lot.t[0] + lot.n[0] * 0.55, dz = lot.t[1] + lot.n[1] * 0.55;
  fc.yaw = Math.atan2(-dx, -dz); fc.pitch = -0.08;
}, [+back, +hgt]);
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
console.log(await p.evaluate(() => window.__error || 'ok'));
await b.close();
