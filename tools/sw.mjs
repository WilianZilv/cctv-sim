// view along the sidewalk of the most neglected lot near the focus: node tools/sw.mjs "<query>" out.png
import { chromium } from 'playwright-core';
const [query, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 300000 });
console.log(await p.evaluate(() => {
  const app = window.__app(), fc = window.__freecam, f = app.ctx.focus;
  const l = app.layout.lots.filter(l => Math.hypot(l.c[0] - f[0], l.c[1] - f[1]) < 40 && l.road.sw > 1.4).sort((a, b) => b.neglect - a.neglect)[0];
  const x = l.a[0] - l.n[0] * l.road.sw * 0.5 - l.t[0] * 2.5, z = l.a[1] - l.n[1] * l.road.sw * 0.5 - l.t[1] * 2.5;
  fc.camera.position.set(x, app.ctx.sidewalkY(x, z) + 1.6, z);
  fc.yaw = Math.atan2(-l.t[0], -l.t[1]); fc.pitch = -0.45;
  return 'neglect ' + l.neglect.toFixed(2);
}));
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
await b.close();
