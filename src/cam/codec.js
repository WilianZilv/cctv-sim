// Real video coding stage: frames leaving the camera ISP are encoded with the
// browser's actual H.264/H.265 encoder (WebCodecs) at the DVR's bitrate/GOP/fps,
// decoded again, and only the decoded frames are shown. The encoded stream can
// be recorded as an Annex-B elementary stream (.h264 / .h265, plays in VLC/ffplay).
//
// Rate control is ours, like a DVR with a VBV buffer: the encoder runs in
// per-frame quantizer mode, I-frames get a slightly better QP than P-frames, and
// the P-frame QP drifts to hold the average bitrate over the GOP. (Letting the
// browser do realtime CBR starves every I-frame and makes it pulse once per GOP.)

function avcCodecString(w, h) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  // baseline profile; level by macroblock count
  const level = mbs <= 1620 ? 0x1f : mbs <= 8192 ? 0x28 : mbs <= 22080 ? 0x32 : 0x33;
  return 'avc1.4200' + level.toString(16).padStart(2, '0');
}

export class CodecLink {
  constructor(spec, displayCanvas) {
    this.spec = spec;
    this.display = displayCanvas;
    this.g = displayCanvas.getContext('2d');
    displayCanvas.width = spec.res[0];
    displayCanvas.height = spec.res[1];
    this.frameIndex = 0;
    this.pending = 0;
    this.recording = null;
    this.ok = false;
    this.codecName = '';
    this.stats = { bytes: 0, frames: 0, kbps: 0, keyframes: 0 };
    this.lastStatT = performance.now();
    this.bytesWindow = 0;
  }

  static supported() { return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'; }

  async init() {
    const { spec } = this;
    const [w, h] = spec.res;
    const candidates = [];
    if (spec.codec === 'H.265') candidates.push({ codec: 'hev1.1.6.L120.90', name: 'H.265', hevc: { format: 'annexb' } });
    candidates.push({ codec: avcCodecString(w, h), name: 'H.264', avc: { format: 'annexb' } });
    candidates.push({ codec: 'avc1.42E033', name: 'H.264', avc: { format: 'annexb' } });
    for (const c of candidates) {
      const base = {
        codec: c.codec, width: w, height: h, framerate: spec.fps, hardwareAcceleration: 'no-preference',
        ...(c.avc ? { avc: c.avc } : {}), ...(c.hevc ? { hevc: c.hevc } : {}),
      };
      const qpCfg = { ...base, bitrateMode: 'quantizer', latencyMode: 'realtime' };
      const vbrCfg = { ...base, bitrate: spec.kbps * 1000, bitrateMode: 'variable', latencyMode: 'quality' };
      try {
        let cfg = qpCfg;
        let s = await VideoEncoder.isConfigSupported(qpCfg).catch(() => ({ supported: false }));
        this.qpMode = !!s.supported;
        if (!s.supported) { cfg = vbrCfg; s = await VideoEncoder.isConfigSupported(vbrCfg); }
        if (!s.supported) continue;
        const d = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: w, codedHeight: h });
        if (!d.supported) continue;
        this.encCfg = s.config;
        this.codecName = c.name;
        this.decoder = new VideoDecoder({
          output: (frame) => { this.g.drawImage(frame, 0, 0, w, h); frame.close(); this.lastDecoded = performance.now(); },
          error: (e) => { console.warn('[sim] decoder', e); this.ok = false; },
        });
        this.decoder.configure({ codec: c.codec, codedWidth: w, codedHeight: h, optimizeForLatency: true });
        this.encoder = new VideoEncoder({
          output: (chunk) => this.onChunk(chunk),
          error: (e) => { console.warn('[sim] encoder', e); this.ok = false; },
        });
        this.encoder.configure(cfg);
        this.isHevc = !!c.hevc;
        // starting QP from the bit budget per pixel (6 QP steps ~ 2x bits)
        const bpp = spec.kbps * 1000 / (spec.fps * w * h);
        this.qpP = Math.min(44, Math.max(20, 30 - 6 * Math.log2(bpp / 0.06)));
        this.targetBits = spec.kbps * 1000 / spec.fps;
        this.avgBits = this.targetBits;
        this.ok = true;
        return true;
      } catch (e) { console.warn('[sim] codec config failed', c.codec, e); }
    }
    return false;
  }

  onChunk(chunk) {
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    this.stats.bytes += buf.length;
    if (this.qpMode) {
      // average over roughly one GOP; nudge the P-frame QP toward the target
      const a = 1 / Math.max(4, this.spec.gop);
      this.avgBits += (buf.length * 8 - this.avgBits) * a;
      const err = Math.log2(Math.max(1, this.avgBits) / this.targetBits);
      this.qpP = Math.min(48, Math.max(14, this.qpP + Math.max(-0.4, Math.min(0.4, err * 1.2))));
      this.stats.qp = Math.round(this.qpP);
    }
    this.bytesWindow += buf.length;
    this.stats.frames++;
    if (chunk.type === 'key') this.stats.keyframes++;
    if (this.recording) this.recording.push(buf);
    if (!this.noDecode) try { this.decoder.decode(new EncodedVideoChunk({ type: chunk.type, timestamp: chunk.timestamp, data: buf })); }
    catch (e) { console.warn('[sim] decode', e); }
    this.pending = Math.max(0, this.pending - 1);
    const now = performance.now();
    if (now - this.lastStatT > 2000) {
      this.stats.kbps = Math.round(this.bytesWindow * 8 / (now - this.lastStatT));
      this.bytesWindow = 0;
      this.lastStatT = now;
    }
  }

  // source: the WebGL canvas holding the ISP output for this capture
  push(source) {
    if (!this.ok || this.encoder.state !== 'configured') return;
    // drop frames if the encoder falls behind, like a DVR would
    if (this.encoder.encodeQueueSize > 10) { this.dropped = (this.dropped || 0) + 1; return; }
    const ts = Math.round(this.frameIndex * 1e6 / this.spec.fps);
    const frame = new VideoFrame(source, { timestamp: ts, duration: Math.round(1e6 / this.spec.fps) });
    const key = this.frameIndex % this.spec.gop === 0 || this.forceKey;
    this.forceKey = false;
    const opts = { keyFrame: key };
    if (this.qpMode) {
      // I-frames a few steps finer: they are the reference the whole GOP builds on
      const qp = Math.round(Math.max(10, Math.min(51, key ? this.qpP - 3 : this.qpP)));
      if (this.isHevc) opts.hevc = { quantizer: qp }; else opts.avc = { quantizer: qp };
    }
    this.encoder.encode(frame, opts);
    frame.close();
    this.frameIndex++;
    this.pending++;
  }

  startRecording() { this.recording = []; this.forceKey = true; }
  stopRecording() {
    const parts = this.recording || [];
    this.recording = null;
    const ext = this.codecName === 'H.265' ? 'h265' : 'h264';
    return { blob: new Blob(parts, { type: 'video/' + ext }), ext };
  }

  async flush() { if (this.ok) { await this.encoder.flush(); await this.decoder.flush(); } }

  dispose() {
    try { this.encoder?.close(); } catch { /* closed */ }
    try { this.decoder?.close(); } catch { /* closed */ }
  }
}
