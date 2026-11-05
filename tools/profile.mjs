// CPU profile of a scene build: node tools/profile.mjs "<query>" -> top self-time functions
import { chromium } from 'playwright-core';
const [query] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
const cdp = await p.context().newCDPSession(p);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await p.goto('http://localhost:30140/' + query);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const { profile } = await cdp.send('Profiler.stop');
const self = new Map();
const dt = profile.timeDeltas; const counts = new Map();
profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
for (const n of profile.nodes) {
  const t = counts.get(n.id) || 0; if (!t) continue;
  const f = n.callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
  self.set(k, (self.get(k) || 0) + t);
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
for (const [k, t] of top) console.log((t / 1000).toFixed(0).padStart(6), 'ms ', k);
await b.close();
