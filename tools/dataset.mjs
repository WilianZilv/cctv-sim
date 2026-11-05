// Plate keypoint dataset (Ultralytics YOLO pose), fast generator: crops of vehicles
// taken from simulated security cameras' own output, labelled with each readable
// plate's box and its 4 corners (TL, TR, BR, BL as printed) in the crop. Layout and
// labels: tools/dataset-writer.mjs. The page side is src/gen.js (?gen=1).
//
//   node tools/dataset.mjs --out dataset/1_plate_corners --count 2000
//   node tools/dataset.mjs --task chars --out dataset/2_char_segmentation --count 2000
//        [--workers 2] [--rounds 6 (chars: 10)] [--cams 4-6] [--res 1280x720,1920x1080]
//        [--codec real|emulated] [--warm 8 (real) / 3 (emulated)] [--advance 2-6] [--cond 0.35] [--max-per 3 (chars: 8)]
//        [--min-car 300] [--min-plate 28] [--min-plate-area 400] [--min-crop-lum 24] [--max-dist 80] [--min-vis 0.25] [--max-occ 0.03]
//        [--min-plate-lum 35] [--min-plate-std 8]
//        [--task plates|chars|both (--out-corners, --out-chars, --count-corners N)] [--size 320] [--jitter 0.5] [--jitter-rel 0.006] [--jitter-clean 0.25] [--min-char-std 8] [--neg 0.1] [--demo]
//        [--scenes-per-page 12] [--val 0.1] [--debug 20] [--app http://localhost:30140/]
//
// Each worker is a headless Chrome that builds a random scene (seed: street, time,
// weather), then runs --rounds camera rounds on it: every round moves traffic on a
// few seconds (and maybe changes hour / weather) and installs --cams cameras, each
// with its own model, resolution (--res), narrow-ish lens, height and aim at a
// vehicle's plate side. No real-time pacing: the page steps the simulation itself.
// The page is reloaded every --scenes-per-page scenes (and after a crash).
// Needs the dev server (npm run dev) on :30140.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import { DatasetWriter } from './dataset-writer.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const range = (s) => { const [a, b] = String(s).split('-').map(Number); return [a, Number.isFinite(b) ? b : a]; };

const COUNT = +opt('count', 1000);
const WORKERS = +opt('workers', 2);
const PER_PAGE = +opt('scenes-per-page', 12);
// rectified plates (--task chars) only need the plate: more of them per camera, and
// more rounds per world (its build is then shared by more samples)
// --task both: the same pictures feed both datasets (vehicle crops into --out-corners,
// rectified plates into --out-chars); --count is the rectified plates', and the vehicle
// crops keep coming until then
const TASK = opt('task', 'plates');
const BOTH = TASK === 'both';
const CHARS = TASK === 'chars' || BOTH;
const VERBOSE = args.includes('--verbose');
const APP = opt('app', 'http://localhost:30140/');
const genOpts = {
  rounds: +opt('rounds', CHARS ? 10 : 6),
  cams: range(opt('cams', '4-6')),
  res: opt('res', '1280x720,1920x1080').split(','),
  codec: opt('codec', 'real'),
  warm: opt('warm') ? +opt('warm') : null,
  minPlateLum: +opt('min-plate-lum', 35),
  minPlateStd: +opt('min-plate-std', 8),
  minCropLum: +opt('min-crop-lum', 24),
  advance: range(opt('advance', '2-6')),
  condProb: +opt('cond', 0.35),
  maxPer: +opt('max-per', TASK === 'chars' ? 8 : 3),
  maxPerChars: +opt('max-per-chars', 8),
  minCar: +opt('min-car', 300),
  minPlate: +opt('min-plate', 28),
  minPlateArea: +opt('min-plate-area', 400),
  maxDist: +opt('max-dist', 80),
  minVis: +opt('min-vis', 0.25),
  maxOcc: +opt('max-occ', 0.03),
  task: TASK,
  size: +opt('size', 320),
  jitter: +opt('jitter', 0.5),
  jitterRel: +opt('jitter-rel', 0.006),
  jitterClean: +opt('jitter-clean', 0.25),
  minCharStd: +opt('min-char-std', 8),
  negProb: +opt('neg', 0.1),
  demo: args.includes('--demo'),
};

const ts = () => new Date().toLocaleTimeString('pt-BR');
const log = (...a) => console.log(`[${ts()}]`, ...a);
const seedOf = () => crypto.randomBytes(4).toString('hex');
const T0 = Date.now();
const rate = () => (writer.saved / Math.max(1e-9, (Date.now() - T0) / 60000)).toFixed(1);

const pages = new Set();
const corners = BOTH ? new DatasetWriter(opt('out-corners', 'dataset/1_plate_corners'), { val: +opt('val', 0.1), limit: +opt('count-corners', Infinity) }) : null;
const writer = new DatasetWriter(BOTH ? opt('out-chars', 'dataset/2_char_segmentation') : opt('out', CHARS ? 'dataset/2_char_segmentation' : 'dataset/1_plate_corners'), {
  val: +opt('val', 0.1), debug: +opt('debug', 0), limit: COUNT, task: CHARS ? 'chars' : 'plates',
  onSave: () => {
    if (writer.saved % 50 === 0) log(`${writer.saved}/${COUNT} amostras, ${rate()}/min${corners ? `; +${corners.saved} crops de veículo` : ''}`);
    if (writer.done) for (const p of pages) p.evaluate(() => window.__gen?.stop()).catch(() => {});
  },
});

const launch = () => chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const withTimeout = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}: tempo esgotado (${ms / 1000}s)`)), ms); })]).finally(() => clearTimeout(timer));
};
const why = {};

async function worker(n) {
  let browser = await launch();
  let page = null, fails = 0, onPage = 0;
  const newPage = async () => {
    if (page) { pages.delete(page); await page.close().catch(() => {}); }
    if (!browser.isConnected()) browser = await launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', e => log(`w${n} erro:`, e.message));
    page.on('console', m => { if (m.type() === 'error' && /\[gen\]/.test(m.text())) log(`w${n}`, m.text()); });
    // the dev server's live reload (someone editing the project) would navigate the
    // page away mid-scene: its websocket is answered here and never hears of a change
    await page.routeWebSocket(/.*/, () => {});
    if (corners) await page.exposeFunction('__datasetSample', (m, b) => (JSON.parse(m).task === 'chars' ? writer : corners).write(page, m, b));
    else await writer.attach(page);
    pages.add(page);
    onPage = 0;
  };
  // a scene: a fresh page (new seed in the URL) or the next seed in the same page
  const build = async (seed) => {
    const t = Date.now();
    if (!page || onPage >= PER_PAGE) {
      await newPage();
      await page.goto(APP + '?' + new URLSearchParams({ seed, gen: '1', codec: 'emulated', capture: '1' }), { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => window.__genReady !== undefined || !!window.__error, null, { timeout: 240000, polling: 250 });
      const err = await page.evaluate(() => (window.__genReady ? null : window.__error || 'falhou'));
      if (err) throw new Error(err);
    } else {
      await withTimeout(page.evaluate(s => window.__gen.next(s), seed), 240000, 'cena');
    }
    onPage++;
    return Date.now() - t;
  };
  while (!writer.done && fails < 5) {
    const seed = seedOf();
    const before = writer.saved;
    try {
      const tb = await build(seed);
      const t = Date.now();
      const st = await withTimeout(page.evaluate(o => window.__gen.scene(o), genOpts), 600000, 'geração');
      for (const k in st.why) why[k] = (why[k] || 0) + st.why[k];
      const ms = Object.entries(st.ms).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ');
      log(`w${n} seed ${seed} (${writer.split(seed)}, ${st.city}, codec ${st.codec}): ${writer.saved - before} amostras de ${st.cams} câmeras em ${st.rounds} rodadas; mundo ${(tb / 1000).toFixed(1)}s, geração ${((Date.now() - t) / 1000).toFixed(1)}s (${ms}); total ${writer.saved}/${COUNT}, ${rate()}/min`);
      if (VERBOSE) log(`w${n}   sem pose ${st.noPose}; recusas: ${JSON.stringify(st.why)}`);
      fails = 0;
    } catch (e) {
      fails++;
      log(`w${n} seed ${seed} falhou:`, e.message.split('\n')[0]);
      // a crashed or stuck page stays dead: start a fresh one (and browser, if it went)
      try { await newPage(); } catch (e2) { await browser.close().catch(() => {}); browser = await launch().catch(() => null); if (!browser) break; page = null; }
      onPage = PER_PAGE;
    }
  }
  if (fails >= 5) log(`w${n} desistiu depois de 5 falhas seguidas`);
  await browser?.close().catch(() => {});
}

log(`gerando ${COUNT} amostras em ${writer.out} com ${WORKERS} navegador(es)`);
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
const mins = (Date.now() - T0) / 60000;
log(`pronto: ${writer.saved} amostras em ${mins.toFixed(1)} min (${rate()}/min)`);
log('motivos (veículos recusados):', JSON.stringify(Object.fromEntries(Object.entries(why).sort((a, b) => b[1] - a[1]))));
// debug overlays still being drawn by the pages are lost with them: give them a moment
await new Promise(r => setTimeout(r, 500));
process.exit(0);
