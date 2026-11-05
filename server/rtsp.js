// Minimal RTSP server (RFC 2326) for the simulated cameras. No dependencies.
//  - one path per camera (/cam1, /cam2, ...), any number of viewers each
//  - RTP over the RTSP TCP connection (interleaved), which is what works through
//    TCP tunnels; a UDP SETUP gets 461 and clients retry over TCP
//  - H.264 (RFC 6184) and H.265 (RFC 7798) packetization, fragmentation units for
//    large NAL units; SPS/PPS (and VPS) also go into the SDP
//  - HTTP Digest authentication (MD5) when a user is set
//  - a viewer starts at the next key frame (the source is asked for one at once)
import net from 'node:net';
import crypto from 'node:crypto';

const MTU = 1400;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Annex-B byte stream -> NAL units (without start codes)
export function splitNals(buf) {
  const out = [];
  let i = 0, start = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const sc = buf[i + 2] === 1 ? 3 : 4;
      if (start >= 0) out.push(buf.subarray(start, i));
      i += sc;
      start = i;
    } else i++;
  }
  if (start >= 0) out.push(buf.subarray(start));
  return out.filter(n => n.length);
}

export class Stream {
  constructor(path) {
    this.path = path;
    this.viewers = new Set();
    this.hevc = false;
    this.params = {};          // sps, pps, vps (Buffers)
    this.ready = false;
    this.lastTs = null;        // last RTP timestamp (90 kHz)
    this.fps = 15;
    this.onWantKey = () => {};
  }

  // one encoded access unit from the camera (Annex-B)
  push(data, key, tsUs, hevc, fps) {
    if (hevc !== this.hevc) { this.hevc = hevc; this.params = {}; }
    this.fps = fps || this.fps;
    // RTP time from the wall clock at arrival: a live source, so players pace by
    // real time (the encoder's own timestamps restart with every new seed)
    const now = performance.now();
    if (this.t0 === undefined) { this.t0 = now; this.rtpBase = crypto.randomInt(1 << 30); }
    const ts = (this.rtpBase + Math.round((now - this.t0) * 90)) >>> 0;
    this.lastTs = ts;
    const nals = splitNals(data);
    for (const n of nals) {
      const t = this.hevc ? (n[0] >> 1) & 0x3f : n[0] & 0x1f;
      if (this.hevc) { if (t === 32) this.params.vps = Buffer.from(n); else if (t === 33) this.params.sps = Buffer.from(n); else if (t === 34) this.params.pps = Buffer.from(n); }
      else { if (t === 7) this.params.sps = Buffer.from(n); else if (t === 8) this.params.pps = Buffer.from(n); }
    }
    if (this.params.sps && this.params.pps) this.ready = true;
    for (const v of this.viewers) {
      if (!v.playing) continue;
      if (v.waitKey) { if (!key) continue; v.waitKey = false; }
      v.sendAccessUnit(nals, ts, this.hevc);
    }
  }

  sdp(host) {
    const p = this.params;
    let fmtp;
    if (this.hevc) {
      fmtp = `a=rtpmap:96 H265/90000\r\na=fmtp:96 sprop-vps=${p.vps?.toString('base64') || ''};sprop-sps=${p.sps.toString('base64')};sprop-pps=${p.pps.toString('base64')}\r\n`;
    } else {
      const pli = p.sps.subarray(1, 4).toString('hex');
      fmtp = `a=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=${pli};sprop-parameter-sets=${p.sps.toString('base64')},${p.pps.toString('base64')}\r\n`;
    }
    return `v=0\r\no=- ${Date.now()} 1 IN IP4 ${host}\r\ns=cctv-sim ${this.path}\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\n${fmtp}a=framerate:${this.fps}\r\na=control:track1\r\n`;
  }
}

class Viewer {
  constructor(sock) {
    this.sock = sock;
    this.seq = crypto.randomInt(65536);
    this.ssrc = crypto.randomInt(2 ** 31);
    this.channel = 0;
    this.playing = false;
    this.waitKey = true;
  }
  rtp(payload, ts, marker) {
    const h = Buffer.alloc(12);
    h[0] = 0x80; h[1] = 96 | (marker ? 0x80 : 0);
    h.writeUInt16BE(this.seq, 2); this.seq = (this.seq + 1) & 0xffff;
    h.writeUInt32BE(ts, 4); h.writeUInt32BE(this.ssrc, 8);
    const len = 12 + payload.length;
    const il = Buffer.from([0x24, this.channel, len >> 8, len & 0xff]);
    // drop the frame for a viewer that cannot keep up instead of buffering forever
    if (this.sock.writableLength > 8 << 20) { this.waitKey = true; return false; }
    this.sock.write(Buffer.concat([il, h, payload]));
    return true;
  }
  sendAccessUnit(nals, ts, hevc) {
    for (let i = 0; i < nals.length; i++) {
      const n = nals[i], last = i === nals.length - 1;
      if (n.length <= MTU) { if (!this.rtp(n, ts, last)) return; continue; }
      if (hevc) {
        const type = (n[0] >> 1) & 0x3f;
        const ph = Buffer.from([(n[0] & 0x81) | (49 << 1), n[1]]);
        for (let o = 2; o < n.length; o += MTU) {
          const end = Math.min(n.length, o + MTU);
          const fu = Buffer.from([(o === 2 ? 0x80 : 0) | (end === n.length ? 0x40 : 0) | type]);
          if (!this.rtp(Buffer.concat([ph, fu, n.subarray(o, end)]), ts, last && end === n.length)) return;
        }
      } else {
        const ind = (n[0] & 0xe0) | 28, type = n[0] & 0x1f;
        for (let o = 1; o < n.length; o += MTU) {
          const end = Math.min(n.length, o + MTU);
          const hdr = Buffer.from([ind, (o === 1 ? 0x80 : 0) | (end === n.length ? 0x40 : 0) | type]);
          if (!this.rtp(Buffer.concat([hdr, n.subarray(o, end)]), ts, last && end === n.length)) return;
        }
      }
    }
  }
}

export class RtspServer {
  // streams: Map path -> Stream; auth: { user, pass } or null
  constructor({ port = 8554, streams, auth = null, log = console.log }) {
    this.port = port; this.streams = streams; this.auth = auth; this.log = log;
    this.realm = 'cctv-sim';
    this.server = net.createServer(sock => this.client(sock));
  }
  // '::' accepts IPv4 and IPv6 (Windows resolves localhost to ::1 first)
  listen() { return new Promise(res => this.server.listen({ port: this.port, host: '::', ipv6Only: false }, res)); }
  close() { this.server.close(); }

  client(sock) {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const sessions = new Map();     // session id -> { viewer, stream }
    const nonce = crypto.randomBytes(12).toString('hex');
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        // interleaved data from the client (RTCP receiver reports): skip
        if (buf.length >= 4 && buf[0] === 0x24) { const len = buf.readUInt16BE(2); if (buf.length < 4 + len) return; buf = buf.subarray(4 + len); continue; }
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const lines = head.split('\r\n');
        const hdr = {};
        for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) hdr[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
        const blen = +(hdr['content-length'] || 0);
        if (buf.length < end + 4 + blen) return;
        buf = buf.subarray(end + 4 + blen);
        this.request(sock, lines[0], hdr, sessions, nonce);
      }
    });
    const cleanup = () => { for (const s of sessions.values()) s.stream.viewers.delete(s.viewer); sessions.clear(); };
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  }

  request(sock, line, hdr, sessions, nonce) {
    const [method, url] = line.split(' ');
    const cseq = hdr.cseq || '0';
    const reply = (code, text, extra = {}, body = '') => {
      let r = `RTSP/1.0 ${code} ${text}\r\nCSeq: ${cseq}\r\nServer: cctv-sim\r\n`;
      for (const [k, v] of Object.entries(extra)) r += `${k}: ${v}\r\n`;
      if (body) r += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
      sock.write(r + '\r\n' + body);
    };
    if (method === 'OPTIONS') return reply(200, 'OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
    // authentication (Digest)
    if (this.auth && !this.authorized(method, hdr.authorization, nonce)) {
      return reply(401, 'Unauthorized', { 'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${nonce}"` });
    }
    let path = '/';
    try { path = new URL(url.replace(/^rtsp:/i, 'http:')).pathname; } catch { /* keep / */ }
    const base = path.replace(/\/track1$/, '').replace(/\/$/, '');
    const stream = this.streams.get(base);
    if (method === 'GET_PARAMETER' || method === 'SET_PARAMETER') return reply(200, 'OK', hdr.session ? { Session: hdr.session } : {});
    if (method === 'TEARDOWN') {
      const s = sessions.get((hdr.session || '').split(';')[0]);
      if (s) { s.stream.viewers.delete(s.viewer); sessions.delete(hdr.session.split(';')[0]); }
      return reply(200, 'OK');
    }
    if (!stream) return reply(404, 'Not Found');
    if (method === 'DESCRIBE') {
      if (!stream.ready) return reply(503, 'Service Unavailable', { 'Retry-After': '5' });
      const host = sock.localAddress?.replace('::ffff:', '') || '0.0.0.0';
      const base64Url = url.endsWith('/') ? url : url + '/';
      return reply(200, 'OK', { 'Content-Type': 'application/sdp', 'Content-Base': base64Url }, stream.sdp(host));
    }
    if (method === 'SETUP') {
      const tr = hdr.transport || '';
      if (!/RTP\/AVP\/TCP/i.test(tr)) return reply(461, 'Unsupported Transport');
      const m = tr.match(/interleaved=(\d+)/);
      const viewer = new Viewer(sock);
      viewer.channel = m ? +m[1] : 0;
      const id = crypto.randomBytes(8).toString('hex');
      sessions.set(id, { viewer, stream });
      return reply(200, 'OK', { Transport: `RTP/AVP/TCP;unicast;interleaved=${viewer.channel}-${viewer.channel + 1};ssrc=${viewer.ssrc.toString(16).padStart(8, '0')}`, Session: `${id};timeout=60` });
    }
    if (method === 'PLAY') {
      const id = (hdr.session || '').split(';')[0];
      const s = sessions.get(id);
      if (!s) return reply(454, 'Session Not Found');
      s.viewer.playing = true;
      s.viewer.waitKey = true;
      s.stream.viewers.add(s.viewer);
      s.stream.onWantKey();
      this.log(`[rtsp] ${sock.remoteAddress} playing ${s.stream.path}`);
      return reply(200, 'OK', { Session: id, Range: 'npt=0.000-', 'RTP-Info': `url=${url.replace(/\/$/, '')}/track1;seq=${s.viewer.seq};rtptime=${s.stream.lastTs ?? 0}` });
    }
    return reply(405, 'Method Not Allowed');
  }

  authorized(method, header, nonce) {
    if (!header) return false;
    if (header.startsWith('Basic ')) {
      const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      return u === this.auth.user && p === this.auth.pass;
    }
    if (!header.startsWith('Digest ')) return false;
    const f = {};
    for (const m of header.slice(7).matchAll(/(\w+)="?([^",]*)"?/g)) f[m[1]] = m[2];
    if (f.username !== this.auth.user || f.nonce !== nonce) return false;
    const ha1 = md5(`${this.auth.user}:${this.realm}:${this.auth.pass}`);
    const ha2 = md5(`${method}:${f.uri}`);
    const expect = f.qop ? md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
    return expect === f.response;
  }
}
