// Flicker probe: grabs consecutive camera frames (before the encoder, from the WebGL
// canvas, and after it, from the decoded display) and reports how much static pixels
// change. node tools/flicker.mjs "<query>" [label]
import { chromium } from 'playwright-core';
const [query = '', label = 'f'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
if (process.env.CFG) await p.addInitScript(c => localStorage.setItem('cctv-sim-config-v1', c), process.env.CFG);
p.on('pageerror', e => console.log('PE', e.message));
await p.goto('http://localhost:30140/' + query);
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 120000 });
await p.waitForTimeout(+(process.env.SETTLE || 10000));
const res = await p.evaluate(async () => {
  const app = window.__app();
  const grab = (canvas) => {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  const gl = app.cctv.renderer.domElement;
  const disp = document.querySelector('#view canvas:nth-child(2)');
  const waitCapture = () => new Promise(res => {
    const f0 = app.cctv.frame;
    const tick = () => (app.cctv.frame > f0 ? setTimeout(res, 30) : requestAnimationFrame(tick));
    tick();
  });
  const frames = { pre: [], post: [] };
  for (let i = 0; i < 6; i++) {
    await waitCapture();
    frames.pre.push(grab(gl));
    frames.post.push(grab(disp));
  }
  const stats = (list) => {
    const out = [];
    let worst = null;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].data, bb = list[i].data;
      let sum = 0, changed = 0, n = a.length / 4;
      const diff = new Uint8ClampedArray(a.length);
      for (let k = 0; k < n; k++) {
        const d = (Math.abs(a[k * 4] - bb[k * 4]) + Math.abs(a[k * 4 + 1] - bb[k * 4 + 1]) + Math.abs(a[k * 4 + 2] - bb[k * 4 + 2])) / 3;
        sum += d; if (d > 2) changed++;
        diff[k * 4] = diff[k * 4 + 1] = diff[k * 4 + 2] = Math.min(255, d * 20); diff[k * 4 + 3] = 255;
      }
      out.push({ mean: +(sum / n).toFixed(3), changedPct: +(100 * changed / n).toFixed(2) });
      worst = { diff, w: list[i].width, h: list[i].height };
    }
    const c = document.createElement('canvas');
    c.width = worst.w; c.height = worst.h;
    c.getContext('2d').putImageData(new ImageData(worst.diff, worst.w, worst.h), 0, 0);
    return { out, png: c.toDataURL('image/png') };
  };
  const pre = stats(frames.pre), post = stats(frames.post);
  return { pre: pre.out, post: post.out, prePng: pre.png, postPng: post.png, exposure: app.cctv.exposure, gain: app.cctv.gain };
});
const fs = await import('fs');
fs.writeFileSync(`shots/${label}-pre.png`, Buffer.from(res.prePng.split(',')[1], 'base64'));
fs.writeFileSync(`shots/${label}-post.png`, Buffer.from(res.postPng.split(',')[1], 'base64'));
console.log(JSON.stringify({ pre: res.pre, post: res.post, exposure: res.exposure, gain: res.gain }));
await b.close();
