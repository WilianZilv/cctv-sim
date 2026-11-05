// Links the playit agent (bin/playit) to a playit.gg account, the way the official
// playit-cli "setup" does: a claim code, a link the account owner opens to accept,
// then the agent's secret key, written to bin/playit/playit.secret.
//   node tools/playit-claim.mjs
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const API = 'https://api.playit.gg';
const call = async (path, body) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const code = crypto.randomBytes(5).toString('hex');
console.log('Abra e aceite: https://playit.gg/claim/' + code);
let last = '';
for (;;) {
  const r = await call('/claim/setup', { code, agent_type: 'self-managed', version: 'playit 1.0.12' });
  const st = r.data ?? r.status;
  if (st !== last) { console.log('estado:', JSON.stringify(r)); last = st; }
  if (st === 'UserAccepted') break;
  if (st === 'UserRejected' || r.status === 'fail') { console.log('falhou'); process.exit(1); }
  await new Promise(res => setTimeout(res, 2000));
}
const ex = await call('/claim/exchange', { code });
const key = ex.data?.secret_key;
if (!key) { console.log('troca falhou:', JSON.stringify(ex)); process.exit(1); }
writeFileSync(new URL('../bin/playit/playit.secret', import.meta.url), key + '\n');
console.log('vinculado: bin/playit/playit.secret');
