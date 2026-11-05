// CPU profile of the render loop (not the build): node tools/rtcpu.mjs [seed] [ms]
// Samples the main thread for a few seconds once the scene runs and prints the
// functions with the most self time.
import { chromium } from 'playwright-core';
const [seed = 'fvwckd99', ms = '4000'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://localhost:30140/?seed=${seed}&frames=30${process.env.EXTRA || ''}`);
while (!(await page.evaluate(() => window.__ready === true))) await page.waitForTimeout(300);
await page.waitForTimeout(1500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
const f0 = await page.evaluate(() => { let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.__fc = () => n; return 0; });
await cdp.send('Profiler.start');
await page.waitForTimeout(+ms);
const { profile } = await cdp.send('Profiler.stop');
const frames = await page.evaluate(() => window.__fc());
const counts = new Map();
profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (profile.timeDeltas[i] || 0)));
const self = new Map();
let total = 0;
for (const n of profile.nodes) {
  const t = (counts.get(n.id) || 0) / 1000; if (!t) continue;
  total += t;
  const f = n.callFrame;
  const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
  self.set(k, (self.get(k) || 0) + t);
}
console.log(`${frames} frames in ${ms} ms (${(frames / (+ms / 1000)).toFixed(1)} fps); sampled ${total.toFixed(0)} ms`);
for (const [k, t] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(String((t / frames).toFixed(3)).padStart(8) + ' ms/frame  ' + k);
await browser.close();
