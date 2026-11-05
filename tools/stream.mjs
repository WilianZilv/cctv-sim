// Simulated cameras as RTSP streams.
//
//   node tools/stream.mjs --cams 4 --cycle 10m [--port 8554] [--codec h264|h265] [--res 1920x1080]
//                         [--user admin --pass xxx | --no-auth] [--city sp|cwb|any]
//                         [--res-per-cam 1280x720,1920x1080] [--dataset dir [--dataset-debug N]]
//
// Each camera runs headless (no window) in its own page with the real WebCodecs
// encoder; every encoded frame goes to the RTSP server as rtsp://host:port/camN.
// Every --cycle (staggered across cameras) a camera moves to a new random seed:
// a new street, camera model, time and weather, like switching to another site.
// --dataset: while streaming, every camera also saves crops of whole, unobstructed
// vehicles with their plate corners (YOLO pose, see tools/dataset-writer.mjs), taken
// from the very frames it hands to the encoder.
// Needs the dev server (npm run dev) on :30140, or pass --start-vite.
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import { RtspServer, Stream } from '../server/rtsp.js';
import { DatasetWriter } from './dataset-writer.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const dur = (s) => { const m = String(s).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/); if (!m) throw new Error('duração inválida: ' + s); return +m[1] * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] || 's']; };

const CAMS = +opt('cams', 2);
const CYCLE = dur(opt('cycle', '10m'));
const PORT = +opt('port', 8554);
const CODEC = opt('codec', 'h264');
// one resolution per stream: the camera model changes with every seed, the output does not
// a comma list gives each camera one of them at random (still fixed for that stream)
const RES = opt('res', '1920x1080').split(',');
// --res-per-cam 1280x720,1920x1080: camera N gets the Nth (overrides --res)
const RES_CAM = opt('res-per-cam', '').split(',').filter(Boolean);
const CITY = opt('city', 'any');
const STATS = dur(opt('stats', '60s'));
const APP = opt('app', 'http://localhost:30140/');
const dataset = opt('dataset') ? new DatasetWriter(opt('dataset'), { debug: +opt('dataset-debug', 0) }) : null;
const auth = flag('no-auth') ? null : { user: opt('user', 'admin'), pass: opt('pass', crypto.randomBytes(6).toString('base64url')) };

const ts = () => new Date().toLocaleTimeString('pt-BR');
const log = (...a) => console.log(`[${ts()}]`, ...a);
const seedOf = () => crypto.randomBytes(4).toString('hex').slice(0, 8);

if (flag('start-vite')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { port: 30140, strictPort: true } });
  await vite.listen();
  log('vite em http://localhost:30140');
}

const streams = new Map();
const server = new RtspServer({ port: PORT, streams, auth, log });
await server.listen();

// one browser per camera: each gets its own GPU process, so the shader compiles and
// uploads of a camera changing seed do not stall the others' frames
const launch = () => chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

class Camera {
  constructor(n) {
    this.n = n;
    this.path = '/cam' + n;
    this.stream = new Stream(this.path);
    streams.set(this.path, this.stream);
    this.stream.onWantKey = () => this.page?.evaluate(() => window.__forceKey?.()).catch(() => {});
    this.frames = 0;
    this.res = RES_CAM[n - 1] || RES[crypto.randomInt(RES.length)];
  }
  async recover(why) {
    if (this.recovering || stopping) return;
    this.recovering = true;
    log(`cam${this.n} ${why}: reiniciando`);
    const old = this.browser;
    this.browser = null;
    await old?.close().catch(() => {});
    for (let i = 0; ; i++) {
      try { await this.start(); break; } catch (e) {
        log(`cam${this.n} falhou ao reiniciar:`, e.message.split('\n')[0]);
        await this.browser?.close().catch(() => {});
        await new Promise(r => setTimeout(r, Math.min(60000, 5000 * (i + 1))));
      }
    }
    this.recovering = false;
  }
  async start() {
    this.browser = await launch();
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
    this.page.on('pageerror', e => log(`cam${this.n} erro:`, e.message));
    // a crashed page or browser comes back on its own (hours of streaming wear the GPU process)
    this.page.on('crash', () => this.recover('página travou'));
    this.browser.on('disconnected', () => this.recover('navegador caiu'));
    await this.page.exposeFunction('__streamChunk', (b64, key, tsUs, hevc, fps) => {
      this.frames++;
      this.stream.push(Buffer.from(b64, 'base64'), key, tsUs, hevc, fps);
    });
    if (dataset) await dataset.attach(this.page);
    // the binding has to exist before the app reads it
    this.seed = seedOf();
    const q = new URLSearchParams({ seed: this.seed, stream: '1', vcodec: CODEC, vres: this.res });
    if (dataset) q.set('dataset', '1');
    if (CITY !== 'any') q.set('city', CITY);
    await this.page.goto(APP + '?' + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await this.waitReady();
    log(`cam${this.n} no ar: seed ${this.seed} — ${await this.describe()}`);
  }
  async waitReady() {
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      if (await this.page.evaluate(() => window.__ready === true || !!window.__error).catch(() => false)) return;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  async describe() {
    return this.page.evaluate(() => { const a = window.__app(); return `${a.spec.name}, ${a.spec.res.join('x')} ${a.spec.fps} fps, ${a.site.city} · ${a.site.roadName || 'rua sem nome'}`; }).catch(() => '?');
  }
  async next() {
    this.seed = seedOf();
    log(`cam${this.n} trocando para seed ${this.seed}…`);
    await this.page.evaluate((s) => window.__setSeed(s), this.seed);
    await this.waitReady();
    log(`cam${this.n} no ar: seed ${this.seed} — ${await this.describe()}`);
  }
}

const cams = [];
for (let i = 1; i <= CAMS; i++) cams.push(new Camera(i));
// one at a time: building a scene is heavy
for (const c of cams) await c.start();

const host = 'localhost';
const cred = auth ? `${auth.user}:${auth.pass}@` : '';
log('RTSP pronto (somente TCP):');
for (const c of cams) console.log(`   rtsp://${cred}${host}:${PORT}${c.path}`);
if (auth) console.log(`   usuário ${auth.user}  senha ${auth.pass}`);
if (dataset) console.log(`   dataset em ${dataset.out}`);

// cycles, staggered so the cameras do not all rebuild at once
cams.forEach((c, i) => {
  const loop = async () => {
    try { if (!c.recovering) await c.next(); } catch (e) { log(`cam${c.n} falhou ao trocar:`, e.message.split('\n')[0]); c.recover('troca falhou'); }
    setTimeout(loop, CYCLE);
  };
  setTimeout(loop, CYCLE + (CYCLE / CAMS) * i);
});

// health line: frames delivered, and in the page frames captured / dropped before encoding
setInterval(async () => {
  const parts = [];
  for (const c of cams) {
    const p = await c.page.evaluate(() => { const a = window.__app(); return { cap: a.cctv.frame, drop: a.codec?.dropped || 0, hw: a.codec?.encCfg?.hardwareAcceleration, codec: a.codec?.codecName, fps: a.spec.fps }; }).catch(() => ({}));
    // (a seed change restarts the page's counters)
    const delta = (now, last) => now >= (last ?? now) ? now - (last ?? now) : now;
    const dc = delta(p.cap, c.lastCap), dd = delta(p.drop, c.lastDrop);
    c.lastCap = p.cap; c.lastDrop = p.drop;
    const sec = STATS / 1000;
    parts.push(`cam${c.n} ${(c.frames / sec).toFixed(1)}/${p.fps} fps (capt ${(dc / sec).toFixed(1)}, desc ${dd}) ${c.stream.viewers.size}v`);
    c.frames = 0;
  }
  log(parts.join(' | ') + (dataset ? ` | dataset ${dataset.saved}` : ''));
}, STATS);

let stopping = false;
const stop = async () => {
  stopping = true; log('encerrando'); server.close(); await Promise.all(cams.map(c => c.browser?.close())); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
