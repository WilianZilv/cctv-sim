// close-up of the nearest plaster wall from the sidewalk: node tools/wall.mjs "<query>" out.png
import { chromium } from 'playwright-core';
const [query, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
p.on('console', m => { if (m.text().includes('Shader Error')) console.log('SHADER ERROR'); });
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 300000 });
console.log(await p.evaluate(() => {
  const app = window.__app(), fc = window.__freecam, f = app.ctx.focus;
  const l = app.layout.lots.filter(l => l.wall && l.wall.style === 'plaster_full' && l.len > 5).sort((a, b) => Math.hypot(a.c[0] - f[0], a.c[1] - f[1]) - Math.hypot(b.c[0] - f[0], b.c[1] - f[1]))[0];
  if (!l) return 'none';
  const s = l.len * 0.3, off = -2.6;
  const x = l.a[0] + l.t[0] * s + l.n[0] * off, z = l.a[1] + l.t[1] * s + l.n[1] * off;
  fc.camera.position.set(x, app.ctx.sidewalkY(x, z) + 1.5, z);
  const tx = l.a[0] + l.t[0] * (s + 2.5), tz = l.a[1] + l.t[1] * (s + 2.5);
  fc.yaw = Math.atan2(-(tx - x), -(tz - z)); fc.pitch = -0.12;
  return 'ok';
}));
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
await b.close();
