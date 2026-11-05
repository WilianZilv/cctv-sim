// Writes plate keypoint samples (Ultralytics YOLO pose layout) as pages in dataset
// mode hand them over (window.__datasetSample): used by tools/dataset.mjs and
// tools/stream.mjs --dataset.
//
//   out/data.yaml
//   out/images/{train,val}/<seed>_<frame>_<vehicle>.jpg   vehicle crop
//   out/labels/{train,val}/<same>.txt                     0 cx cy w h x1 y1 2 ... x4 y4 2
//   out/meta.jsonl                                        one line per sample
//   out/debug/<same>.png                                  first N, labels drawn on
//   (--task chars: rectified plates, a box per character; tools/ocr_crops.py cuts the
//   character OCR datasets from them)
//
// The split is by seed, so a scene is never in both train and val.
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SEG_CLASSES } from '../src/vehicles/plates.js';

export class DatasetWriter {
  // task 'chars': rectified plates, a box per character, class = plate type (YOLO detect)
  constructor(out, { val = 0.1, format = 'jpg', debug = 0, limit = Infinity, onSave = null, task = 'plates' } = {}) {
    this.out = resolve(out);
    this.val = val; this.format = format; this.debug = debug; this.limit = limit; this.onSave = onSave;
    this.saved = 0; this.debugged = 0;
    for (const d of ['images/train', 'images/val', 'labels/train', 'labels/val', ...(debug ? ['debug'] : [])]) mkdirSync(join(this.out, d), { recursive: true });
    if (!existsSync(join(this.out, 'data.yaml')) && task === 'chars') {
      writeFileSync(join(this.out, 'data.yaml'), [
        `# Rectified plates from cctv-sim cameras in a letterbox: a box per printed character`,
        `# and one around the plate, classed with its type (tools/dataset-writer.mjs, --task chars)`,
        `path: ${this.out.replace(/\\/g, '/')}`,
        `train: images/train`,
        `val: images/val`,
        ``,
        `names:`,
        ...SEG_CLASSES.map((n, i) => `  ${i}: ${n}`),
        ``,
      ].join('\n'));
    } else if (!existsSync(join(this.out, 'data.yaml'))) {
      writeFileSync(join(this.out, 'data.yaml'), [
        `# Plate corners on vehicle crops from cctv-sim (tools/dataset-writer.mjs)`,
        `path: ${this.out.replace(/\\/g, '/')}`,
        `train: images/train`,
        `val: images/val`,
        ``,
        `# keypoints: top-left, top-right, bottom-right, bottom-left (as printed)`,
        `kpt_shape: [4, 3]`,
        `# a horizontal flip mirrors the plate: left and right corners swap`,
        `flip_idx: [1, 0, 3, 2]`,
        ``,
        `names:`,
        `  0: placa`,
        ``,
      ].join('\n'));
    }
  }

  get done() { return this.saved >= this.limit; }

  split(seed) { return (parseInt(crypto.createHash('md5').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff) < this.val ? 'val' : 'train'; }

  // hooks a page up: its samples land here (call before the page loads the app)
  async attach(page) {
    await page.exposeFunction('__datasetSample', (metaJson, b64) => this.write(page, metaJson, b64));
  }

  write(page, metaJson, b64) {
    if (this.done) return false;
    const meta = JSON.parse(metaJson);
    const split = this.split(meta.seed);
    // --demo: the vehicle crop the plate came from, beside the dataset
    if (meta.demo) {
      mkdirSync(join(this.out, 'demo'), { recursive: true });
      writeFileSync(join(this.out, 'demo', `${meta.name}.jpg`), Buffer.from(meta.demo.image, 'base64'));
      meta.demo = { crop: meta.demo.crop, corners: meta.demo.corners };
    }
    // (the generator names its samples itself: several cameras per scene)
    const name = meta.name ? String(meta.name).replace(/[^\w-]/g, '') : `${meta.seed}_${String(meta.frame).padStart(6, '0')}_${String(meta.vehicle).replace(/[^\w-]/g, '')}`;
    writeFileSync(join(this.out, 'images', split, `${name}.${this.format}`), Buffer.from(b64, 'base64'));
    writeFileSync(join(this.out, 'labels', split, `${name}.txt`), meta.labels.join('\n') + '\n');
    const file = `images/${split}/${name}.${this.format}`;
    appendFileSync(join(this.out, 'meta.jsonl'), JSON.stringify({ file, ...meta }) + '\n');
    this.saved++;
    if (this.debugged < this.debug) {
      this.debugged++;
      page.evaluate(([b, m]) => window.__datasetOverlay?.(b, m), [b64, metaJson])
        .then(png => png && writeFileSync(join(this.out, 'debug', `${name}.png`), Buffer.from(png, 'base64'))).catch(() => {});
    }
    this.onSave?.(meta, split);
    return true;
  }
}
