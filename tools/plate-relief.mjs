// Relief layers of one generated plate: colour, height / film / metal (headless).
//   node tools/plate-relief.mjs out.png '{"wear":0.8,"style":"mercosul","vehicle":"moto"}'
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out, optsJson = '{}'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PE', e.message));
await page.goto('http://localhost:30140/plates.html?n=0');
await page.waitForFunction(() => window.__ready === true || !!window.__error);
const url = await page.evaluate(async (opts) => {
  const { Rng } = await import('/src/core/rng.js');
  const { loadPlateAssets, generatePlate } = await import('/src/vehicles/plates.js');
  await loadPlateAssets();
  const p = generatePlate(new Rng(opts.seed || 'dump'), { relief: true, ...opts });
  const { width: W, height: H, data } = p.relief;
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(p.canvas, 0, 0);
  for (let ch = 0; ch < 3; ch++) {
    const id = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const v = data[i * 4 + ch]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    g.putImageData(id, ((ch + 1) % 2) * W, Math.floor((ch + 1) / 2) * H);
  }
  return c.toDataURL();
}, JSON.parse(optsJson));
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
