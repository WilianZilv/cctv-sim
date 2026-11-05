// Synthetic plate dataset in YOLO format, rendered by src/vehicles/plates.js
// in headless Chrome (needs the Vite dev server on :30140).
//
//   node tools/plates-dataset.mjs --out D:/datasets/placas --count 20000
//
// Options (defaults in brackets):
//   --out DIR          output root [shots/plates-dataset]
//   --count N          plates in train [1000]; --val F adds F*N val plates [0.25]
//   --seed S           base seed [plates]; plate i uses seed "S/split/i"
//   --labels ocr|plate per-character boxes with 36 OCR classes, or the same
//                      boxes labeled by plate type (mercosul/antiga/antiga_invertida) [ocr]
//   --width W          car plate width in px [288]; motos keep the real 200x170 aspect
//   --moto-width W     [W * 0.45]
//   --wear A..B        wear range [0..0.8]; --moto F share of motos [0.25]
//   --antiga F         share of old-style plates [0.3]; --comercial F [0.12]; --verde F [0.03]
//   --weighted         favor characters OCR confuses (as in plate_generator.py)
//   --font NAME        slim1|slim|regular|auto [auto]
//   --format jpg|png   [jpg]; --quality Q jpg quality 0..1 [0.92]
//   --margin X,Y       box margin in px at 96 px plate width, like plate_generator.py [1,2]
// Writes images/{train,val}, labels/{train,val}, meta.jsonl and data.yaml.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const range = (s, d) => (s ? String(s).split(/\.\.|,/).map(Number) : d);
const cfg = {
  out: path.resolve(args.out || 'shots/plates-dataset'),
  count: +(args.count || 1000),
  val: +(args.val ?? 0.25),
  seed: args.seed || 'plates',
  labels: args.labels || 'ocr',
  width: +(args.width || 288),
  motoWidth: +(args['moto-width'] || 0),
  wear: range(args.wear, [0, 0.8]),
  moto: +(args.moto ?? 0.25),
  antiga: +(args.antiga ?? 0.3),
  comercial: +(args.comercial ?? 0.12),
  verde: +(args.verde ?? 0.03),
  weighted: !!args.weighted,
  font: args.font || 'auto',
  format: args.format === 'png' ? 'png' : 'jpg',
  quality: +(args.quality || 0.92),
  margin: range(args.margin, [1, 2]),
};
cfg.motoWidth ||= Math.round(cfg.width * 0.45);

const PLATE_CLASSES = ['mercosul', 'antiga', 'antiga_invertida'];
const CHAR_NAMES = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

for (const split of ['train', 'val']) {
  fs.mkdirSync(path.join(cfg.out, 'images', split), { recursive: true });
  fs.mkdirSync(path.join(cfg.out, 'labels', split), { recursive: true });
}
const names = cfg.labels === 'plate' ? PLATE_CLASSES : CHAR_NAMES;
fs.writeFileSync(path.join(cfg.out, 'data.yaml'),
  `path: .\ntrain: images/train\nval: images/val\n\nnc: ${names.length}\nnames:\n${names.map((n) => `  - '${n}'`).join('\n')}\n`);
const meta = fs.createWriteStream(path.join(cfg.out, 'meta.jsonl'));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto('http://localhost:30140/plates.html?n=0', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true || !!window.__error, null, { timeout: 60000 });

// Renders one batch inside the page and returns encoded images plus labels.
const renderBatch = (job) => page.evaluate(async ({ cfg, split, from, to }) => {
  const { Rng } = await import('/src/core/rng.js');
  const { loadPlateAssets, generatePlate } = await import('/src/vehicles/plates.js');
  await loadPlateAssets();
  const out = [];
  for (let i = from; i < to; i++) {
    const rng = new Rng(`${cfg.seed}/${split}/${i}`);
    const vehicle = rng.chance(cfg.moto) ? 'moto' : 'carro';
    const style = rng.chance(cfg.antiga) ? 'antiga' : 'mercosul';
    const r = rng.next();
    const category = r < cfg.comercial ? 'comercial'
      : style === 'antiga' && r < cfg.comercial + cfg.verde ? 'experiencia' : 'particular';
    const wear = rng.float(cfg.wear[0], cfg.wear[1]);
    const p = generatePlate(rng, { vehicle, style, category, wear, weighted: cfg.weighted, font: cfg.font });

    const W = vehicle === 'moto' ? cfg.motoWidth : cfg.width;
    const H = Math.round(W * p.canvas.height / p.canvas.width);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    // Plates are cropped tight, so fill the transparent corners with a car-ish dark tone.
    const shade = Math.round(rng.float(15, 90));
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.fillRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(p.canvas, 0, 0, W, H);
    const sx = W / p.canvas.width, sy = H / p.canvas.height;
    const mx = cfg.margin[0] * W / 96, my = cfg.margin[1] * W / 96;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const boxes = p.chars.map((ch) => {
      const x0 = clamp((ch.x0 * sx - mx) / W), x1 = clamp((ch.x1 * sx + mx) / W);
      const y0 = clamp((ch.y0 * sy - my) / H), y1 = clamp((ch.y1 * sy + my) / H);
      return { cls: cfg.labels === 'plate' ? p.plateClassId : ch.cls, ch: ch.ch, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    });
    const url = cfg.format === 'png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', cfg.quality);
    out.push({
      i, url, boxes, W, H,
      meta: { text: p.text, style: p.style, category: p.category, vehicle, plateClass: p.plateClass, uf: p.uf, city: p.city, wear: +wear.toFixed(3) },
    });
  }
  return out;
}, job);

const t0 = Date.now();
const BATCH = 50;
for (const [split, n] of [['train', cfg.count], ['val', Math.round(cfg.count * cfg.val)]]) {
  for (let from = 0; from < n; from += BATCH) {
    const items = await renderBatch({ cfg, split, from, to: Math.min(n, from + BATCH) });
    for (const it of items) {
      const name = `${it.meta.vehicle}_${it.meta.plateClass}_${it.meta.text.replace('-', '')}_${String(it.i).padStart(6, '0')}`;
      const b64 = it.url.slice(it.url.indexOf(',') + 1);
      fs.writeFileSync(path.join(cfg.out, 'images', split, `${name}.${cfg.format}`), Buffer.from(b64, 'base64'));
      fs.writeFileSync(path.join(cfg.out, 'labels', split, `${name}.txt`),
        it.boxes.map((b) => `${b.cls} ${b.cx.toFixed(6)} ${b.cy.toFixed(6)} ${b.w.toFixed(6)} ${b.h.toFixed(6)}`).join('\n') + '\n');
      meta.write(JSON.stringify({ split, file: `${name}.${cfg.format}`, ...it.meta }) + '\n');
    }
    process.stdout.write(`\r${split} ${Math.min(n, from + BATCH)}/${n}`);
  }
  process.stdout.write('\n');
}
meta.end();
await browser.close();
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${cfg.out}`);
