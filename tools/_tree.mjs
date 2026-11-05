import { chromium } from 'playwright-core';
const [query, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await p.evaluate(() => {
  const app = window.__app(), fc = window.__freecam, f = app.ctx.focus;
  const t = app.ctx.treeCanopies.filter(t => t.r > 1.5).sort((a, b) => Math.hypot(a.x - f[0], a.z - f[1]) - Math.hypot(b.x - f[0], b.z - f[1]))[0];
  const x = t.x + 9, z = t.z + 5;
  fc.camera.position.set(x, app.ctx.gy(x, z) + 2, z);
  fc.yaw = Math.atan2(-(t.x - x), -(t.z - z));
  fc.pitch = Math.atan2(t.y - app.ctx.gy(x, z) - 2.5, Math.hypot(t.x - x, t.z - z));
});
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
await b.close();
