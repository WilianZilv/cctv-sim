// Top-down sequence of the traffic: node tools/trafficview.mjs [seed] [frames] [interval ms]
// Saves shots/traffic/f_NN.png and a contact sheet shots/traffic/sheet.png.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [seed = 'fvwckd99', n = '12', every = '1500'] = process.argv.slice(2);
mkdirSync('shots/traffic', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => console.log('[pageerror]', (e.stack || e.message).split('\n').slice(0, 4).join(' | ')));
page.on('console', m => { if (/\[sim\] traffic|trânsito/.test(m.text())) console.log(m.text()); });
await page.goto(`http://localhost:30140/?seed=${seed}&frames=10&free`);
while (!(await page.evaluate(() => window.__ready === true))) await page.waitForTimeout(300);
const setView = () => page.evaluate(() => {
  const app = window.__app(), f = app.ctx.focus;
  const c = window.__freecam.camera;
  c.position.set(f[0], 75, f[1] + 0.01);
  c.lookAt(f[0], 0, f[1]);
  window.__freecam.copyFrom(c);
  document.querySelector('.lil-gui')?.remove();
});
await setView();
// the dev server reloads the page when files change (other sessions editing)
const ensure = async () => { if (!(await page.evaluate(() => typeof window.__app === 'function' && window.__ready === true))) { while (!(await page.evaluate(() => window.__ready === true).catch(() => false))) await page.waitForTimeout(300); await setView(); } };
for (let i = 0; i < +n; i++) {
  await page.waitForTimeout(+every);
  await ensure();
  const info = await page.evaluate(() => (window.__app().ctx.traffic?.cars || []).filter(c => c.active).map(c => c.v.toFixed(1) + (c.v < 0.5 ? '(#' + c.id + ' ' + c.x.toFixed(0) + ',' + c.z.toFixed(0) + ' ' + c.why + ' u' + c.u.toFixed(0) + '/' + c.lane.len.toFixed(0) + (c.curve ? ' curve' : '') + ')' : '')).join(' '));
  console.log(i, 'speeds', info);
  await page.screenshot({ path: `shots/traffic/f_${String(i).padStart(2, '0')}.png` });
}
await browser.close();
execSync(`ffmpeg -y -loglevel error -i shots/traffic/f_%02d.png -vf "scale=426:-1,tile=4x${Math.ceil(+n / 4)}" -frames:v 1 shots/traffic/sheet.png`);
