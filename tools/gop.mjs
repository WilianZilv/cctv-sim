// GOP probe: per-frame sharpness of the decoded video over ~2 GOPs, plus QP/bitrate.
// node tools/gop.mjs "<query>"
import { chromium } from 'playwright-core';
const [query] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
if (process.env.CFG) await p.addInitScript(c => localStorage.setItem('cctv-sim-config-v1', c), process.env.CFG);
p.on('pageerror', e => console.log('PE', e.message));
await p.goto('http://localhost:30140/' + query);
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
await p.waitForTimeout(4000);
const r = await p.evaluate(async () => {
  const app = window.__app();
  const disp = document.querySelector('#view canvas:nth-child(2)');
  const c = document.createElement('canvas'); c.width = 480; c.height = 270;
  const g = c.getContext('2d', { willReadFrequently: true });
  // sharpness = mean absolute horizontal gradient of the decoded picture
  const sharp = () => { g.drawImage(disp, 0, 0, 480, 270); const d = g.getImageData(0, 0, 480, 270).data; let s = 0; for (let i = 4; i < d.length; i += 4) s += Math.abs(d[i] - d[i - 4]); return s / (d.length / 4); };
  const out = [];
  let lastDec = app.codec.lastDecoded;
  const t0 = performance.now();
  while (out.length < Math.min(70, app.spec.gop * 2 + 4) && performance.now() - t0 < 20000) {
    await new Promise(r => requestAnimationFrame(r));
    if (app.codec.lastDecoded !== lastDec) { lastDec = app.codec.lastDecoded; out.push(+sharp().toFixed(2)); }
  }
  return { gop: app.spec.gop, fps: app.spec.fps, kbps: app.spec.kbps, qpMode: app.codec.qpMode, qp: app.codec.stats.qp, measured: app.codec.stats.kbps, sharp: out };
});
console.log(JSON.stringify(r));
await b.close();
