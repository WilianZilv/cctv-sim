// Distribution check of generatePlate: tallies N plates and saves a contact sheet
// of the first ones (headless).
//   node tools/plate-tally.mjs out.png [n=200] [balanced=1]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [out = 'shots/plate-tally.png', n = '200', balanced = '1'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PE', e.message));
await page.goto('http://localhost:30140/plates.html?n=0');
await page.waitForFunction(() => window.__ready === true || !!window.__error);
const r = await page.evaluate(async ({ n, balanced }) => {
  const { Rng } = await import('/src/core/rng.js');
  const { loadPlateAssets, generatePlate } = await import('/src/vehicles/plates.js');
  await loadPlateAssets();
  const tally = {};
  const add = (k, v) => { tally[k] ??= {}; tally[k][v] = (tally[k][v] || 0) + 1; };
  const sheet = document.createElement('canvas');
  const cols = 8, cw = 220, ch = 110, rows = 7;
  sheet.width = cols * cw; sheet.height = rows * ch;
  const g = sheet.getContext('2d');
  g.fillStyle = '#3a3d42'; g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = '11px monospace'; g.fillStyle = '#ddd';
  for (let i = 0; i < n; i++) {
    const vehicle = i % 2 ? 'moto' : 'carro';
    const p = generatePlate(new Rng('tally/' + i), balanced ? { vehicle, balanced: true, relief: true } : { vehicle, relief: true, wear: 0.1 + 0.6 * Math.random() });
    add('vehicle', p.vehicle); add('style', p.style); add('category', p.style + '/' + p.category);
    if (p.model) add('model', p.model);
    if (p.font) add('font', p.font);
    add('wear', ['0-0.25', '0.25-0.5', '0.5-0.75', '0.75-1'][Math.min(3, Math.floor(p.wear * 4))]);
    add('weighted', String(p.weighted));
    add('retro', p.relief.retro > 0 ? 'film' : 'painted');
    add('combo', [p.vehicle, p.style, p.model || '-', p.category].join(' '));
    if (i < cols * rows) {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      const s = Math.min((cw - 10) / p.canvas.width, (ch - 22) / p.canvas.height);
      g.drawImage(p.canvas, x + 5, y + 4, p.canvas.width * s, p.canvas.height * s);
      g.fillText(`${p.style[0]}${p.model ? '/' + p.model : ''} ${p.category.slice(0, 4)} ${p.font || ''} w${p.wear.toFixed(2)}`, x + 5, y + ch - 6);
    }
  }
  return { tally, url: sheet.toDataURL() };
}, { n: +n, balanced: balanced === '1' });
fs.writeFileSync(out, Buffer.from(r.url.split(',')[1], 'base64'));
for (const [k, v] of Object.entries(r.tally)) console.log(k.padEnd(9), Object.entries(v).sort().map(([a, b]) => `${a}:${b}`).join('  '));
console.log('->', out);
await browser.close();
