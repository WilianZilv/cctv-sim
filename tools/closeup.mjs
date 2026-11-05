// Close-up of a textured front wall in free-camera mode: node tools/closeup.mjs "<query>" out.png
import { chromium } from 'playwright-core';
const [query, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
const info = await p.evaluate(() => {
  const app = window.__app(), fc = window.__freecam;
  const want = (process => ['stone_base', 'brick_raw', 'block_raw'])();
  const f = app.ctx.focus;
  const lots = app.layout.lots.filter(l => l.wall && want.includes(l.wall.style) && l.len > 4)
    .sort((a, b) => Math.hypot(a.c[0] - f[0], a.c[1] - f[1]) - Math.hypot(b.c[0] - f[0], b.c[1] - f[1]));
  const l = lots[0];
  if (!l) return 'no wall';
  const s = l.len * 0.5, off = -1.6;
  const x = l.a[0] + l.t[0] * (s - 1.2) + l.n[0] * off, z = l.a[1] + l.t[1] * (s - 1.2) + l.n[1] * off;
  const y = app.ctx.sidewalkY(x, z) + 1.2;
  fc.camera.position.set(x, y, z);
  const tx = l.a[0] + l.t[0] * s, tz = l.a[1] + l.t[1] * s;
  fc.yaw = Math.atan2(-(tx - x), -(tz - z));
  fc.pitch = -0.25;
  return l.wall.style;
});
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
console.log(info);
await b.close();
