// Creates (once) the playit.gg TCP tunnel to the RTSP server and prints its public
// address. Uses the agent key from bin/playit/playit.secret (tools/playit-claim.mjs).
//   node tools/playit-tunnel.mjs [localPort=8554]
import { readFileSync } from 'node:fs';

const API = 'https://api.playit.gg';
const key = readFileSync(new URL('../bin/playit/playit.secret', import.meta.url), 'utf8').trim();
const port = +(process.argv[2] || 8554);
const call = async (path, body) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Agent-Key ' + key }, body: JSON.stringify(body) });
  return r.json();
};

const run = await call('/agents/rundata', {});
const agentId = run.data?.agent_id;
if (!agentId) { console.log('rundata:', JSON.stringify(run).slice(0, 400)); process.exit(1); }

const show = (list) => {
  for (const t of list.data?.tunnels || []) {
    const conn = t.connect_addresses || t.custom_domain || t.assigned_domain || t;
    console.log('túnel', t.name, '→', JSON.stringify(conn).slice(0, 300));
  }
};
let list = await call('/v1/tunnels/list', {});
const mine = (list.data?.tunnels || []).find(t => t.name === 'cctv-rtsp');
if (!mine) {
  const res = await call('/tunnels/create', {
    name: 'cctv-rtsp', tunnel_type: null, port_type: 'tcp', port_count: 1,
    origin: { type: 'agent', details: { agent_id: agentId, local_ip: '127.0.0.1', local_port: port } },
    enabled: true, alloc: null, firewall_id: null, proxy_protocol: null,
  });
  console.log('create:', JSON.stringify(res).slice(0, 400));
  list = await call('/v1/tunnels/list', {});
}
show(list);
