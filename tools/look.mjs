// Free-camera close-up of a debug spot: node tools/look.mjs "<query>" <kind> out.png [dist] [height]
import { chromium } from 'playwright-core';
const [query, kind, out, dist = '2.5', height = '1.6'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PE', e.message));
await p.goto('http://localhost:30140/' + query + '&free');
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
const info = await p.evaluate(([kind, dist, height]) => {
  const app = window.__app(), fc = window.__freecam;
  const f = app.ctx.focus;
  const s = (app.ctx.spots || []).filter(s => s.kind === kind).sort((a, b) => Math.hypot(a.x - f[0], a.z - f[1]) - Math.hypot(b.x - f[0], b.z - f[1]))[0];
  if (!s) return 'none';
  const dx = s.ox ? -s.ox : 0.7, dz = s.oz ? -s.oz : 0.7;
  const l = Math.hypot(dx, dz);
  const x = s.x + dx / l * dist + dz / l * 0.8, z = s.z + dz / l * dist - dx / l * 0.8;
  fc.camera.position.set(x, app.ctx.gy(x, z) + height, z);
  fc.yaw = Math.atan2(-(s.x - x), -(s.z - z));
  fc.pitch = -Math.atan2(height, Math.hypot(s.x - x, s.z - z));
  return JSON.stringify(s);
}, [kind, +dist, +height]);
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
console.log(info);
await b.close();
