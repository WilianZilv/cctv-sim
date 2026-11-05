// Record the camera's real encoded stream headless:
//   node tools/record.mjs "<query>" out.h264 [seconds]
// Prints the measured frame rate so the raw stream can be muxed at real speed.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const [query = '', out = 'shots/rec.h264', secs = '12'] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', e => console.log('[pageerror] ' + e.message));
await page.goto('http://localhost:30140/' + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
const end = Date.now() + 180000;
while (Date.now() < end && !(await page.evaluate(() => window.__ready === true || !!window.__error))) await page.waitForTimeout(500);
const err = await page.evaluate(() => window.__error || null);
if (err) { console.log('[app error] ' + err); process.exit(1); }
await page.evaluate(() => { window.__recT0 = performance.now(); window.__app().codec.startRecording(); });
await page.waitForTimeout(+secs * 1000);
const res = await page.evaluate(async () => {
  const c = window.__app().codec;
  const n = c.recording.length;
  const dt = (performance.now() - window.__recT0) / 1000;
  await c.flush();
  const { blob, ext } = c.stopRecording();
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return { data: btoa(s), ext, n, dt, fps: window.__app().spec.fps, place: document.querySelector('#status')?.textContent || '' };
});
writeFileSync(out, Buffer.from(res.data, 'base64'));
console.log(JSON.stringify({ out, ext: res.ext, frames: res.n, seconds: res.dt, rate: res.n / res.dt, camFps: res.fps }));
await browser.close();
