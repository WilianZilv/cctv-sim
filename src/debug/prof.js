// Runtime profiler, active with ?prof=1. Each section ends with gl.finish(), so
// its time covers the CPU work and the GPU work it submitted (it slows the frame
// down a little; numbers are for comparing sections, not absolute frame rates).
// window.__prof.reset() / .report() are used by tools/rtprofile.mjs.
const params = new URLSearchParams(location.search);

export const prof = {
  on: params.get('prof') === '1',
  gl: null, renderer: null,
  stats: new Map(),
  stack: [],
  frames: 0,

  attach(renderer) { this.renderer = renderer; this.gl = renderer.getContext(); },

  begin(name) {
    if (!this.on) return;
    this.gl.finish();
    const info = this.renderer.info.render;
    this.stack.push({ name, t: performance.now(), calls: info.calls, tris: info.triangles });
  },

  end() {
    if (!this.on) return;
    this.gl.finish();
    const s = this.stack.pop();
    const info = this.renderer.info.render;
    // nested sections are reported with their parent's name as prefix
    const name = this.stack.map(x => x.name).concat(s.name).join('/');
    let e = this.stats.get(name);
    if (!e) this.stats.set(name, e = { ms: 0, n: 0, calls: 0, tris: 0, max: 0 });
    const ms = performance.now() - s.t;
    e.ms += ms; e.n++; e.max = Math.max(e.max, ms);
    e.calls += info.calls - s.calls; e.tris += info.triangles - s.tris;
  },

  section(name, fn) {
    if (!this.on) return fn();
    this.begin(name);
    try { return fn(); } finally { this.end(); }
  },

  frame() { if (this.on) this.frames++; },

  reset() { this.stats.clear(); this.frames = 0; },

  // per frame averages (ms, draw calls, triangles) and per call averages
  report() {
    const out = {};
    for (const [k, e] of this.stats) out[k] = { perFrame: +(e.ms / Math.max(1, this.frames)).toFixed(3), perCall: +(e.ms / e.n).toFixed(3), max: +e.max.toFixed(2), n: e.n, calls: Math.round(e.calls / e.n), tris: Math.round(e.tris / e.n) };
    return { frames: this.frames, sections: out };
  },
};
window.__prof = prof;
