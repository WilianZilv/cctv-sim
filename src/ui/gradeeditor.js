// Colour grading editor: lift/gamma/gain colour wheels, split toning, tone and
// colour sliders, looks (built-in and saved), before/after split and JSON
// copy/paste. Edits go straight to the shared grade uniforms.
import { LOOKS, LOOK_NAMES, GRADE, gradeState, hueRGB, parseCube, setLut, setLutAmount } from '../cam/grade.js';

const LOOKS_STORE = 'cctv-sim-looks-v1';
const LUT_STORE = 'cctv-sim-lut-v1';
const ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const CSS = `
#ge { position: fixed; left: 12px; top: 12px; width: 352px; max-height: calc(100vh - 24px); overflow-y: auto; z-index: 2500;
  background: rgba(22,23,26,0.96); border: 1px solid #33363c; border-radius: 8px; color: #dfe2e6;
  font: 12px system-ui, sans-serif; display: none; user-select: none; box-shadow: 0 8px 30px rgba(0,0,0,0.45); }
#ge.open { display: block; }
#ge .ge-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2b2e33; position: sticky; top: 0; background: #17181b; z-index: 1; }
#ge .ge-title { font-weight: 600; font-size: 13px; flex: 1; }
#ge .ge-sec { padding: 10px 12px; border-bottom: 1px solid #2b2e33; }
#ge .ge-sec h4 { margin: 0 0 8px; font-size: 11px; font-weight: 600; color: #9aa0a8; text-transform: uppercase; letter-spacing: 0.04em; }
#ge button, #ge select { height: 26px; border-radius: 5px; border: 1px solid #3a3e45; background: #22252a; color: #e2e5e9; font: 12px system-ui, sans-serif; padding: 0 9px; cursor: pointer; }
#ge button:hover { background: #2b2f35; }
#ge button.icon { width: 26px; padding: 0; display: grid; place-items: center; }
#ge .ge-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#ge .ge-row + .ge-row { margin-top: 6px; }
#ge select { flex: 1; min-width: 0; }
#ge input[type=text], #ge textarea { background: #15171a; border: 1px solid #3a3e45; color: #e2e5e9; border-radius: 5px; font: 12px ui-monospace, monospace; padding: 4px 6px; }
#ge input[type=text] { flex: 1; height: 26px; box-sizing: border-box; font-family: system-ui, sans-serif; }
#ge textarea { width: 100%; height: 120px; box-sizing: border-box; resize: vertical; }
#ge .ge-wheels { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
#ge .ge-wheels.two { grid-template-columns: repeat(2, 1fr); width: 66%; }
#ge .ge-wheel { display: flex; flex-direction: column; align-items: center; gap: 4px; }
#ge .ge-wheel canvas { width: 96px; height: 96px; cursor: crosshair; touch-action: none; }
#ge .ge-wheel .lbl { color: #b9bec5; }
#ge .ge-wheel .val { color: #7f8690; font: 10px ui-monospace, monospace; }
#ge .ge-wheel input[type=range] { width: 96px; }
#ge .ge-slider { display: grid; grid-template-columns: 92px 1fr 44px; align-items: center; gap: 8px; }
#ge .ge-slider + .ge-slider { margin-top: 4px; }
#ge .ge-slider span:first-child { color: #b9bec5; cursor: default; }
#ge .ge-slider span:last-child { text-align: right; font: 11px ui-monospace, monospace; color: #9aa0a8; }
#ge input[type=range] { accent-color: #5b8def; height: 16px; margin: 0; }
#ge .ge-hint { color: #7f8690; font-size: 11px; margin-top: 6px; }
#ge .ge-lutname { margin: 8px 0 6px; font-size: 12px; word-break: break-all; }
#ge button:disabled, #ge input:disabled { opacity: 0.4; cursor: default; }
#ge .ge-msg { color: #8fd18f; font-size: 11px; min-height: 14px; margin-top: 4px; }
#ge label { display: flex; align-items: center; gap: 6px; color: #b9bec5; }
`;

// [key, label, min, max, step, neutral]
const SLIDERS = [
  ['temp', 'Temperatura', -1, 1, 0.01, 0],
  ['tint', 'Tint', -1, 1, 0.01, 0],
  ['contrast', 'Contraste', 0.5, 1.8, 0.01, 1],
  ['pivot', 'Pivô', 0.2, 0.7, 0.01, 0.45],
  ['sat', 'Saturação', 0, 2, 0.01, 1],
  ['vibrance', 'Vibrance', -1, 1, 0.01, 0],
];
// wheel luminance sliders: [min, max, step, neutral]
const WHEEL_LUM = { lift: [-0.1, 0.1, 0.002, 0], gamma: [0.5, 1.6, 0.01, 1], gain: [0.6, 1.5, 0.01, 1] };

export class GradeEditor {
  // onChange(state): called on every edit with the full grade state
  constructor(onChange) {
    this.onChange = onChange;
    this.state = gradeState();
    this.look = 'natural';
    // the LUT sits on top of any look: choosing a look does not remove it
    this.lut = { name: '', amount: 1 };
    this.controls = [];
    if (!document.getElementById('ge-css')) {
      const st = document.createElement('style'); st.id = 'ge-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.id = 'ge';
    document.body.appendChild(this.el);
    this.build();
    this.loadStoredLut();
    // keep keys typed in the panel from reaching the camera controls
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get isOpen() { return this.el.classList.contains('open'); }
  toggle(on = !this.isOpen) {
    this.el.classList.toggle('open', on);
    if (!on) this.setCompare(false);
  }

  // load a state from outside (config on start)
  set(grade) {
    this.state = gradeState(grade);
    this.look = grade?.look || 'custom';
    if (typeof grade?.lutAmount === 'number') this.lut.amount = grade.lutAmount;
    setLutAmount(this.lut.amount);
    this.refresh();
  }

  emit() { this.onChange({ look: this.look, ...structuredClone(this.state), lutName: this.lut.name, lutAmount: this.lut.amount }); }

  // ---- LUT
  loadStoredLut() {
    try {
      const saved = JSON.parse(localStorage.getItem(LUT_STORE) || 'null');
      if (saved?.text) this.useLut(saved.name, saved.text, false);
    } catch { /* nothing stored, or unreadable */ }
  }

  // returns an error message or null
  useLut(name, text, store = true) {
    let lut;
    try { lut = parseCube(text); } catch (e) { return e.message; }
    setLut(lut);
    this.lut.name = name;
    this.lut.size = lut.size;
    setLutAmount(this.lut.amount);
    let note = null;
    if (store) {
      try { localStorage.setItem(LUT_STORE, JSON.stringify({ name, text })); } catch { note = 'grande demais para salvar, vale só nesta sessão'; }
    }
    this.refresh();
    return note ? { warn: note } : null;
  }

  removeLut() {
    setLut(null);
    this.lut.name = '';
    this.lut.size = 0;
    try { localStorage.removeItem(LUT_STORE); } catch { /* storage unavailable */ }
    this.refresh();
    this.emit();
  }

  edited() {
    this.look = 'custom';
    this.lookSel.value = 'custom';
    this.emit();
  }

  customLooks() { try { return JSON.parse(localStorage.getItem(LOOKS_STORE) || '{}'); } catch { return {}; } }
  saveCustomLooks(v) { try { localStorage.setItem(LOOKS_STORE, JSON.stringify(v)); } catch { /* storage unavailable */ } }

  fillLooks() {
    const sel = this.lookSel;
    sel.innerHTML = '';
    const add = (value, text, parent = sel) => { const o = document.createElement('option'); o.value = value; o.textContent = text; parent.appendChild(o); };
    for (const [k, n] of Object.entries(LOOK_NAMES)) add(k, n);
    const mine = Object.keys(this.customLooks());
    if (mine.length) {
      const g = document.createElement('optgroup'); g.label = 'Salvos';
      for (const n of mine) add('my:' + n, n, g);
      sel.appendChild(g);
    }
    add('custom', 'Personalizado');
    sel.value = [...sel.options].some(o => o.value === this.look) ? this.look : 'custom';
  }

  build() {
    const el = this.el;
    el.innerHTML = '';
    const h = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); for (const k of kids) n.append(k); return n; };
    const msg = h('div', { className: 'ge-msg' });
    const flash = (t, bad = false) => { msg.textContent = t; msg.style.color = bad ? '#e08a8a' : '#8fd18f'; clearTimeout(this._msgT); this._msgT = setTimeout(() => { msg.textContent = ''; }, 2500); };

    // header
    const close = h('button', { className: 'icon', title: 'Fechar (L)', innerHTML: ICON_X, onclick: () => this.toggle(false) });
    el.append(h('div', { className: 'ge-head' }, h('div', { className: 'ge-title', textContent: 'Color grading' }), close));

    // looks, JSON
    const looks = h('div', { className: 'ge-sec' });
    this.lookSel = h('select', {
      onchange: () => {
        const v = this.lookSel.value;
        if (v === 'custom') return;
        const src = v.startsWith('my:') ? this.customLooks()[v.slice(3)] : LOOKS[v];
        if (!src) return;
        this.state = gradeState(src);
        this.look = v;
        this.refresh();
        this.emit();
      },
    });
    this.fillLooks();
    const nameIn = h('input', { type: 'text', placeholder: 'Nome do look' });
    const saveRow = h('div', { className: 'ge-row' }, nameIn, h('button', {
      textContent: 'Salvar look',
      onclick: () => {
        const n = nameIn.value.trim();
        if (!n) { flash('Dê um nome ao look', true); return; }
        const all = this.customLooks(); all[n] = structuredClone(this.state); this.saveCustomLooks(all);
        this.look = 'my:' + n; this.fillLooks(); nameIn.value = ''; this.emit();
        flash('Look salvo');
      },
    }), h('button', {
      textContent: 'Apagar',
      title: 'Apaga o look salvo selecionado',
      onclick: () => {
        if (!this.look.startsWith('my:')) { flash('Selecione um look salvo', true); return; }
        const all = this.customLooks(); delete all[this.look.slice(3)]; this.saveCustomLooks(all);
        this.look = 'custom'; this.fillLooks(); this.emit();
        flash('Look apagado');
      },
    }));
    const pasteBox = h('textarea', { placeholder: 'Cole o JSON aqui e clique em Aplicar' });
    const pasteRow = h('div', { className: 'ge-row' }, pasteBox);
    const pasteApply = h('button', { textContent: 'Aplicar' });
    const pasteWrap = h('div', {}, pasteRow, h('div', { className: 'ge-row' }, pasteApply));
    pasteWrap.style.display = 'none';
    const applyJson = (text) => {
      try {
        const j = JSON.parse(text);
        const src = j.grade || j;
        this.state = gradeState(src);
        const la = src.lut?.amount ?? src.lutAmount;
        if (typeof la === 'number') { this.lut.amount = la; setLutAmount(la); }
        this.look = 'custom';
        this.refresh(); this.emit();
        flash('JSON aplicado');
        return true;
      } catch { flash('JSON inválido', true); return false; }
    };
    pasteApply.onclick = () => { if (applyJson(pasteBox.value)) pasteWrap.style.display = 'none'; };
    const jsonRow = h('div', { className: 'ge-row' },
      h('button', {
        textContent: 'Copiar JSON',
        onclick: async () => {
          const text = JSON.stringify({ look: this.look, ...this.state, lut: this.lut.name ? { name: this.lut.name, amount: this.lut.amount } : null }, null, 2);
          try { await navigator.clipboard.writeText(text); flash('JSON copiado'); } catch {
            pasteBox.value = text; pasteWrap.style.display = 'block'; pasteBox.select(); flash('Copie do campo abaixo');
          }
        },
      }),
      h('button', {
        textContent: 'Colar JSON',
        onclick: async () => {
          try { const t = await navigator.clipboard.readText(); if (t && applyJson(t)) return; } catch { /* no clipboard permission */ }
          pasteWrap.style.display = 'block'; pasteBox.value = ''; pasteBox.focus();
        },
      }),
      h('button', {
        textContent: 'Restaurar',
        title: 'Volta ao look Natural',
        onclick: () => { this.state = gradeState(LOOKS.natural); this.look = 'natural'; this.refresh(); this.emit(); },
      }));
    looks.append(h('h4', { textContent: 'Look' }), h('div', { className: 'ge-row' }, this.lookSel), saveRow, jsonRow, pasteWrap, msg);
    el.append(looks);

    // LUT (.cube)
    const lutSec = h('div', { className: 'ge-sec' });
    const file = h('input', { type: 'file', accept: '.cube,text/plain' });
    file.style.display = 'none';
    const lutName = h('div', { className: 'ge-lutname' });
    const lutAmt = h('input', { type: 'range', min: 0, max: 1, step: 0.01 });
    const lutVal = h('span');
    const lutMsg = h('div', { className: 'ge-msg' });
    const lutFlash = (t, bad) => { lutMsg.textContent = t; lutMsg.style.color = bad ? '#e08a8a' : '#8fd18f'; clearTimeout(this._lutT); this._lutT = setTimeout(() => { lutMsg.textContent = ''; }, 4000); };
    const loadFile = async (f) => {
      if (!f) return;
      const r = this.useLut(f.name.replace(/\.cube$/i, ''), await f.text());
      if (typeof r === 'string') lutFlash('LUT inválido: ' + r, true);
      else { lutFlash(r?.warn ? 'LUT carregado (' + r.warn + ')' : 'LUT carregado', !!r?.warn); this.emit(); }
    };
    file.onchange = () => { loadFile(file.files[0]); file.value = ''; };
    const removeBtn = h('button', { textContent: 'Remover', onclick: () => { this.removeLut(); lutFlash('LUT removido'); } });
    lutAmt.oninput = () => { this.lut.amount = +lutAmt.value; setLutAmount(this.lut.amount); lutVal.textContent = (+lutAmt.value).toFixed(2); this.emit(); };
    lutSec.append(h('h4', { textContent: 'LUT (.cube)' }),
      h('div', { className: 'ge-row' }, h('button', { textContent: 'Enviar .cube', onclick: () => file.click() }), removeBtn, file),
      lutName,
      h('div', { className: 'ge-slider' }, h('span', { textContent: 'Intensidade' }), lutAmt, lutVal),
      lutMsg);
    // drop a .cube anywhere on the panel
    el.addEventListener('dragover', (e) => { e.preventDefault(); });
    el.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
    this.controls.push(() => {
      lutName.textContent = this.lut.name ? `${this.lut.name} · ${this.lut.size}³` : 'Nenhum LUT. Envie ou arraste um .cube para o painel.';
      lutName.style.color = this.lut.name ? '#dfe2e6' : '#7f8690';
      lutAmt.value = this.lut.amount; lutVal.textContent = (+this.lut.amount).toFixed(2);
      lutAmt.disabled = removeBtn.disabled = !this.lut.name;
    });
    el.append(lutSec);

    // before / after
    const cmp = h('div', { className: 'ge-sec' });
    this.cmpCheck = h('input', { type: 'checkbox', onchange: () => this.setCompare(this.cmpCheck.checked) });
    this.cmpPos = h('input', { type: 'range', min: 0.05, max: 0.95, step: 0.01, value: 0.5, oninput: () => { if (this.cmpCheck.checked) GRADE.uGCompare.value = +this.cmpPos.value; } });
    this.cmpPos.style.flex = '1';
    cmp.append(h('div', { className: 'ge-row' }, h('label', {}, this.cmpCheck, 'Antes / depois'), this.cmpPos));
    el.append(cmp);

    // wheels
    const wh = h('div', { className: 'ge-sec' });
    const grid = h('div', { className: 'ge-wheels' });
    for (const [key, label] of [['lift', 'Sombras (lift)'], ['gamma', 'Meios (gamma)'], ['gain', 'Altas (gain)']]) grid.append(this.wheel(key, label, true));
    wh.append(h('h4', { textContent: 'Rodas de cor' }), grid, h('div', { className: 'ge-hint', textContent: 'Arraste a bolinha para tingir; duplo clique zera. O slider embaixo mexe na luminância.' }));
    el.append(wh);

    const sp = h('div', { className: 'ge-sec' });
    const grid2 = h('div', { className: 'ge-wheels two' });
    for (const [key, label] of [['sh', 'Sombras'], ['hi', 'Altas luzes']]) grid2.append(this.wheel(key, label, false));
    sp.append(h('h4', { textContent: 'Split toning' }), grid2);
    el.append(sp);

    // sliders
    const sl = h('div', { className: 'ge-sec' });
    sl.append(h('h4', { textContent: 'Tom e cor' }));
    for (const [key, label, min, max, step, neutral] of SLIDERS) {
      const val = h('span');
      const inp = h('input', { type: 'range', min, max, step });
      const lab = h('span', { textContent: label, title: 'Duplo clique zera' });
      const show = () => { val.textContent = (+this.state[key]).toFixed(2); };
      inp.oninput = () => { this.state[key] = +inp.value; show(); this.edited(); };
      lab.ondblclick = () => { this.state[key] = neutral; inp.value = neutral; show(); this.edited(); };
      this.controls.push(() => { inp.value = this.state[key]; show(); });
      sl.append(h('div', { className: 'ge-slider' }, lab, inp, val));
    }
    el.append(sl);
    this.refresh();
  }

  setCompare(on) {
    if (this.cmpCheck) this.cmpCheck.checked = on;
    GRADE.uGCompare.value = on ? +this.cmpPos.value : 0;
  }

  // a colour wheel editing state[key] = [hue, amount, (luminance)]
  wheel(key, label, withLum) {
    const S = 96, R = 44;
    const wrap = document.createElement('div');
    wrap.className = 'ge-wheel';
    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = S * dpr;
    const g = cv.getContext('2d');
    // the hue disc is drawn once
    const disc = document.createElement('canvas');
    disc.width = disc.height = S * dpr;
    {
      const d = disc.getContext('2d');
      const img = d.createImageData(S * dpr, S * dpr);
      const c = (S * dpr) / 2, rr = R * dpr;
      for (let y = 0; y < S * dpr; y++) for (let x = 0; x < S * dpr; x++) {
        const dx = x - c, dy = c - y, r = Math.hypot(dx, dy);
        if (r > rr + 1) continue;
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const col = hueRGB(hue, Math.min(1, r / rr) * 0.75, 0.42);
        const i = (y * S * dpr + x) * 4;
        img.data[i] = col.r * 255; img.data[i + 1] = col.g * 255; img.data[i + 2] = col.b * 255;
        img.data[i + 3] = 255 * Math.max(0, Math.min(1, rr + 1 - r));
      }
      d.putImageData(img, 0, 0);
    }
    const val = document.createElement('div');
    val.className = 'val';
    const draw = () => {
      const [hue, amt] = this.state[key];
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, S, S);
      g.drawImage(disc, 0, 0, S, S);
      g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(S / 2 - 5, S / 2); g.lineTo(S / 2 + 5, S / 2); g.moveTo(S / 2, S / 2 - 5); g.lineTo(S / 2, S / 2 + 5); g.stroke();
      const a = hue * Math.PI / 180, px = S / 2 + Math.cos(a) * amt * R, py = S / 2 - Math.sin(a) * amt * R;
      g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
      const lum = withLum ? ` · ${(+this.state[key][2]).toFixed(withLum && key === 'lift' ? 3 : 2)}` : '';
      val.textContent = `${Math.round(hue)}° · ${(amt * 100).toFixed(0)}%${lum}`;
    };
    const pick = (e) => {
      const b = cv.getBoundingClientRect();
      const dx = e.clientX - b.left - b.width / 2, dy = b.top + b.height / 2 - e.clientY;
      const amt = Math.min(1, Math.hypot(dx, dy) / (R * b.width / S));
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      this.state[key][0] = Math.round(hue);
      this.state[key][1] = +amt.toFixed(3);
      draw(); this.edited();
    };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pick(e); });
    cv.addEventListener('pointermove', (e) => { if (cv.hasPointerCapture(e.pointerId)) pick(e); });
    cv.addEventListener('dblclick', () => { this.state[key][1] = 0; draw(); this.edited(); });
    const lab = document.createElement('div');
    lab.className = 'lbl';
    lab.textContent = label;
    wrap.append(cv, lab);
    if (withLum) {
      const [min, max, step, neutral] = WHEEL_LUM[key];
      const inp = document.createElement('input');
      Object.assign(inp, { type: 'range', min, max, step, title: 'Duplo clique zera' });
      inp.oninput = () => { this.state[key][2] = +inp.value; draw(); this.edited(); };
      inp.ondblclick = () => { this.state[key][2] = neutral; inp.value = neutral; draw(); this.edited(); };
      this.controls.push(() => { inp.value = this.state[key][2]; });
      wrap.append(inp);
    }
    wrap.append(val);
    this.controls.push(draw);
    return wrap;
  }

  refresh() {
    if (this.lookSel) this.fillLooks();
    for (const f of this.controls) f();
  }
}

