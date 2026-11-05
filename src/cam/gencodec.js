// Real H.264 / H.265 round trip for the dataset generator (src/gen.js): each camera's
// frames are encoded with the browser's WebCodecs encoder (NVENC & co. when there is
// one) at the camera's bitrate / GOP / fps and decoded again; the labelled frame is
// cropped from the DECODED picture, so it carries the real codec's blocking, ringing
// and smearing.
//
// One encoder and one decoder per page, reconfigured when the codec or resolution
// changes (hardware encoders allow only a few sessions per GPU, and every worker is a
// page). Rate control is ours, per frame, in quantizer mode: the camera's kbps is a
// bit budget per frame; the QP starts from the budget per pixel and is corrected
// after every frame by how far its size was from the budget (I-frames get ~4x the
// bits of a P-frame and a few QP steps finer). Without quantizer mode the encoder's
// own VBR runs at the camera's bitrate.

function avcCodecString(w, h) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const level = mbs <= 1620 ? 0x1f : mbs <= 8192 ? 0x28 : mbs <= 22080 ? 0x32 : 0x33;
  return 'avc1.4200' + level.toString(16).padStart(2, '0');
}

export class GenCodec {
  static supported() { return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'; }

  constructor() {
    this.key = '';
    this.cfgCache = new Map();
  }

  // a working configuration for this codec / size, or null
  async pick(codecName, w, h) {
    const k = `${codecName}|${w}x${h}`;
    if (this.cfgCache.has(k)) return this.cfgCache.get(k);
    const cands = [];
    if (codecName === 'H.265') cands.push({ codec: 'hev1.1.6.L120.90', name: 'H.265', hevc: { format: 'annexb' } });
    cands.push({ codec: avcCodecString(w, h), name: 'H.264', avc: { format: 'annexb' } });
    cands.push({ codec: 'avc1.640028', name: 'H.264', avc: { format: 'annexb' } });
    let found = null;
    for (const c of cands) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const base = { codec: c.codec, width: w, height: h, framerate: 15, hardwareAcceleration: hw, latencyMode: 'realtime', ...(c.avc ? { avc: c.avc } : { hevc: c.hevc }) };
        const q = await VideoEncoder.isConfigSupported({ ...base, bitrateMode: 'quantizer' }).catch(() => ({ supported: false }));
        let cfg = q.supported ? q.config : null;
        if (!cfg) { const v = await VideoEncoder.isConfigSupported({ ...base, bitrateMode: 'variable', bitrate: 2e6 }).catch(() => ({ supported: false })); if (v.supported) cfg = v.config; }
        if (!cfg) continue;
        const d = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: w, codedHeight: h }).catch(() => ({ supported: false }));
        if (!d.supported) continue;
        found = { cfg, name: c.name, codec: c.codec, hevc: !!c.hevc, qp: cfg.bitrateMode === 'quantizer' };
        break;
      }
      if (found) break;
    }
    this.cfgCache.set(k, found);
    return found;
  }

  // ready for a new camera (its first frame will be a keyframe); false if no codec
  async start(spec) {
    const [w, h] = spec.res;
    const f = await this.pick(spec.codec, w, h);
    if (!f) return false;
    const key = `${f.codec}|${w}x${h}|${f.qp}`;
    // a new codec or size: new encoder and decoder (reconfiguring a hardware encoder
    // to another size crashes the GPU process in Chrome on this machine)
    if (this.failed || (this.encoder && key !== this.key)) { this.close(); this.failed = false; this.key = ''; }
    if (!this.encoder) {
      this.encoder = new VideoEncoder({ output: (c) => this.onChunk(c), error: (e) => { console.warn('[gen] encoder', e.message); this.failed = true; } });
      this.decoder = new VideoDecoder({ output: (fr) => this.onFrame(fr), error: (e) => { console.warn('[gen] decoder', e.message); this.failed = true; } });
    }
    if (key !== this.key) {
      const cfg = { ...f.cfg, framerate: spec.fps };
      if (!f.qp) { cfg.bitrate = spec.kbps * 1000; }
      this.encoder.configure(cfg);
      this.decoder.configure({ codec: f.codec, codedWidth: w, codedHeight: h, optimizeForLatency: true });
      this.key = key;
    } else if (!f.qp) {
      this.encoder.configure({ ...f.cfg, framerate: spec.fps, bitrate: spec.kbps * 1000 });
    }
    this.f = f;
    this.spec = spec;
    this.name = f.name;
    this.n = 0;
    this.want = -1;
    this.types = [];
    this.sizes = [];
    // QP from the bit budget per pixel (6 QP steps ~ 2x the bits); P-frames get the
    // budget left once the GOP's I-frame (~4x a P-frame) is paid for
    const bpp = spec.kbps * 1000 / (spec.fps * w * h);
    this.qpP = Math.min(46, Math.max(20, 34 - 6 * Math.log2(bpp / 0.06)));
    this.pBits = spec.kbps * 1000 / spec.fps * spec.gop / (spec.gop + 3);
    this.out?.close();
    this.out = null;
    return true;
  }

  // a frame of the camera (the WebGL canvas, just drawn); key: force an I-frame
  push(source, key, last = false) {
    const ts = Math.round(this.n * 1e6 / this.spec.fps);
    const frame = new VideoFrame(source, { timestamp: ts, duration: Math.round(1e6 / this.spec.fps) });
    const opts = { keyFrame: key };
    if (this.f.qp) {
      const qp = Math.round(Math.max(10, Math.min(51, key ? this.qpP - 3 : this.qpP)));
      if (this.f.hevc) opts.hevc = { quantizer: qp }; else opts.avc = { quantizer: qp };
      this.lastQp = qp;
    }
    if (last) this.want = ts;
    this.encoder.encode(frame, opts);
    frame.close();
    this.n++;
  }

  onChunk(chunk) {
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    const bits = buf.length * 8;
    if (chunk.type !== 'key' && this.f?.qp) {
      // fast correction (8 frames is all a camera gets to settle): ~6 QP steps per
      // doubling of the bits, damped
      const err = Math.log2(Math.max(1, bits) / this.pBits);
      this.qpP = Math.min(50, Math.max(16, this.qpP + Math.max(-6, Math.min(6, err * 4.5))));
    }
    if (chunk.timestamp === this.want) { this.wantType = chunk.type === 'key' ? 'I' : 'P'; this.wantBytes = buf.length; }
    if (chunk.type !== 'key') this.sizes.push(buf.length);
    try { this.decoder.decode(new EncodedVideoChunk({ type: chunk.type, timestamp: chunk.timestamp, data: buf })); }
    catch (e) { console.warn('[gen] decode', e.message); this.failed = true; }
  }

  onFrame(fr) {
    if (fr.timestamp === this.want) { this.out?.close(); this.out = fr; } else fr.close();
  }

  // the decoded labelled frame (a VideoFrame owned by this object until the next start)
  async finish() {
    await this.encoder.flush();
    await this.decoder.flush();
    if (this.failed || !this.out) return null;
    // measured bitrate of the P-frames (for the meta)
    const avg = this.sizes.reduce((a, b) => a + b, 0) / Math.max(1, this.sizes.length);
    return { frame: this.out, type: this.wantType, bytes: this.wantBytes, kbpsReal: Math.round(avg * 8 * this.spec.fps / 1000), qp: this.lastQp };
  }

  close() {
    this.out?.close(); this.out = null;
    try { this.encoder?.close(); } catch { /* closed */ }
    try { this.decoder?.close(); } catch { /* closed */ }
    this.encoder = this.decoder = null;
  }
}
