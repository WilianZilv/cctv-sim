// Headless checks of the pedestrians: node tools/peds-shot.mjs <seed> [outPrefix]
// Saves the CCTV view, close-ups of a few peds from the free camera (side and
// front), a burst of a walking ped (to see the legs move) and, if one happens
// within the wait, a ped crossing the street. Prints the [sim] peds log lines.
import { chromium } from 'playwright-core';
const [seed = 'fvwckd99', prefix = 'shots/peds', extra = ''] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
// Vite's HMR client stubbed out: edits elsewhere do not reload the page mid-run
await p.route('**/@vite/client', r => r.fulfill({ contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},dispose(){},prune(){},invalidate(){},decline(){},on(){},off(){},send(){},data:{}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
p.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
p.on('console', m => { const t = m.text(); if (/peds|pedestres|ped |skin|bone|PropertyBinding|THREE/i.test(t)) console.log('[' + m.type() + ']', t.slice(0, 400)); });
await p.goto(`http://localhost:30140/?seed=${seed}${extra}`);
await p.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 180000 });
await p.waitForTimeout(2000);
await p.screenshot({ path: `${prefix}-cctv.png` });

// free camera aimed at a ped: from the side at distance d
const aim = (i, d, ang, h = 1.0) => p.evaluate(([i, d, ang, h]) => {
  const app = window.__app(), peds = app.ctx.peds;
  if (!peds) return null;
  const a = peds.agents[i % peds.agents.length];
  const fc = window.__freecam;
  // ang: 0 in front, PI/2 to its side (the side with more room: usually the street)
  const nav = peds.nav;
  // a clear line of sight: no wall, lot or parked car between the ped and the camera
  const room = (yw) => { let s = 0; for (let k = 1; k <= 10; k++) { const c = nav.cell(a.x - Math.sin(yw) * d * k / 10, a.z - Math.cos(yw) * d * k / 10); s += c >= 0 && nav.kind[c] && !nav.blocked[c] ? 1 : 0; } return s; };
  let yaw = a.yaw + ang, best = -1;
  for (const da of [0, 0.25, -0.25, 0.5, -0.5]) for (const sg of ang ? [1, -1] : [1]) {
    const yw = a.yaw + sg * ang + da, r = room(yw) - Math.abs(da);
    if (r > best) { best = r; yaw = yw; }
  }
  if (a.leg?.kind === 'cross') { const dir = a.leg.cross.dir; yaw = Math.atan2(dir[0], dir[1]) + ang; }
  const c = fc.camera;
  c.position.set(a.x - Math.sin(yaw) * d, a.y + h, a.z - Math.cos(yaw) * d);
  c.lookAt(a.x, a.y + 0.9, a.z);
  fc.copyFrom(c);
  return { name: a.entry.name, state: a.state, leg: a.leg?.kind, x: a.x.toFixed(1), z: a.z.toFixed(1), anim: a.cur };
}, [i, d, ang, h]);
const key = async (k) => { await p.keyboard.press(k); await p.waitForTimeout(300); };
await key('KeyF');   // free camera
const n = await p.evaluate(() => window.__app().ctx.peds?.agents.length || 0);
console.log('peds:', n, await p.evaluate(() => window.__app().ctx.peds?.nav.crossings.length));
for (let i = 0; i < Math.min(n, 3); i++) {
  // a walking one if possible
  for (let k = 0; k < 20; k++) {
    const st = await p.evaluate((i) => window.__app().ctx.peds.agents[i].cur, i);
    if (st === 'walk') break;
    await p.waitForTimeout(500);
  }
  console.log('side', i, JSON.stringify(await aim(i, 3.2, Math.PI / 2)));
  await p.waitForTimeout(120);
  await p.screenshot({ path: `${prefix}-ped${i}-side.png` });
  console.log('front', i, JSON.stringify(await aim(i, 3.2, 0)));
  await p.waitForTimeout(120);
  await p.screenshot({ path: `${prefix}-ped${i}-front.png` });
}
// burst: one ped from the side, four frames 0.15 s apart
for (let f = 0; f < 4; f++) {
  await aim(0, 3.0, Math.PI / 2, 0.9);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${prefix}-burst${f}.png` });
}
// wait for someone to cross
let found = null;
for (let k = 0; k < 120 && !found; k++) {
  found = await p.evaluate(() => { const a = window.__app().ctx.peds.agents.findIndex(a => a.leg?.kind === 'cross' && a.leg.s > 1.5); return a >= 0 ? a : null; });
  if (found === null) await p.waitForTimeout(500);
}
if (found !== null) {
  console.log('crossing', JSON.stringify(await aim(found, 8, 1.2, 2.2)));
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${prefix}-cross.png` });
  // and from the CCTV camera
  await key('KeyF');
  await p.screenshot({ path: `${prefix}-cross-cctv.png` });
} else console.log('nobody crossed in 60 s');
console.log(JSON.stringify(await p.evaluate(() => window.__app().ctx.pedAgents.slice(0, 4))));
await b.close();
