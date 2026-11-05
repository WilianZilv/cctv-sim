// Compares the picture handed to the encoder with the decoded picture: levels and saturation.
import { chromium } from 'playwright-core';
const [query] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:30140/' + query);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => {
  const stats = (cv) => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 270;
    const g = c.getContext('2d'); g.drawImage(cv, 0, 0, 480, 270);
    const d = g.getImageData(0, 0, 480, 270).data;
    const Y = [], S = [];
    for (let i = 0; i < d.length; i += 4) { const r = d[i], gg = d[i + 1], bb = d[i + 2]; Y.push(0.299 * r + 0.587 * gg + 0.114 * bb); const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb); S.push(mx ? (mx - mn) / mx : 0); }
    Y.sort((a, b) => a - b); const q = (k) => Y[Math.floor(k * (Y.length - 1))].toFixed(0);
    return { p1: q(0.01), p50: q(0.5), p99: q(0.99), sat: (S.reduce((a, b) => a + b, 0) / S.length).toFixed(3) };
  };
  const gl = window.__app().cctv.renderer.domElement;
  const disp = document.querySelector('#view canvas:nth-child(2)');
  return JSON.stringify({ preEncode: stats(gl), decoded: disp.style.display !== 'none' ? stats(disp) : null });
}));
await b.close();
