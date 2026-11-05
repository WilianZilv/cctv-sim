// One plate, enlarged, with its OCR boxes printed: for checking layout against photos.
//   node tools/plate-closeup.mjs out.png '{"vehicle":"moto","style":"mercosul","text":"BRA2E19","wear":0}' [scale]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [out = 'shots/plate-closeup.png', optsJson = '{}', scale = '2'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:30140/plates.html?n=0');
await page.waitForFunction(() => window.__ready === true || !!window.__error);
const r = await page.evaluate(async ({ opts, scale }) => {
  const { Rng } = await import('/src/core/rng.js');
  const { loadPlateAssets, generatePlate } = await import('/src/vehicles/plates.js');
  await loadPlateAssets();
  const p = generatePlate(new Rng(opts.seed || 'closeup'), { warp: false, ...opts });
  const W = p.canvas.width, H = p.canvas.height;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(p.canvas, 0, 0, c.width, c.height);
  return {
    url: c.toDataURL(), W, H, text: p.text,
    chars: p.chars.map((b) => `${b.ch} x ${(b.x0 / W).toFixed(3)}..${(b.x1 / W).toFixed(3)} y ${(b.y0 / H).toFixed(3)}..${(b.y1 / H).toFixed(3)}`),
  };
}, { opts: JSON.parse(optsJson), scale: +scale });
fs.writeFileSync(out, Buffer.from(r.url.split(',')[1], 'base64'));
console.log(`${r.text} ${r.W}x${r.H}\n${r.chars.join('\n')}\n-> ${out}`);
await browser.close();
