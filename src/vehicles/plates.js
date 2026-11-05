// Synthetic Brazilian license plates drawn on a canvas, for vehicle plate
// textures and OCR data. Backgrounds and fonts live in assets/plates/.
//
//   await loadPlateAssets();
//   const { canvas, text, kind } = generatePlate(rng, { vehicle: 'carro', style: 'auto', category: 'auto', wear: 0.3 });
//
// Every random draw goes through the given Rng, so the same seed gives the same plate.

const asset = (name) => new URL(`../../assets/plates/${name}`, import.meta.url).href;

const IMAGES = {
  carro_mercosul: 'carro_mercosul.png',
  carro_mercosul_branca: 'carro_mercosul_branca.png',
  carro_antiga: 'carro_antiga.png',
  carro_antiga_vermelha: 'carro_antiga_vermelha.png',
  moto_mercosul: 'moto_mercosul.png',
  moto_mercosul_branca: 'moto_mercosul_branca.png',
  moto_antiga: 'moto_antiga.png',
  moto_antiga_vermelha: 'moto_antiga_vermelha.png',
  carro_antiga_verde: 'carro_antiga_verde.png',
  moto_antiga_verde: 'moto_antiga_verde.png',
};

const FONTS = {
  PlateMercosul: 'mercosul_fonte.ttf',
  PlateAntiga: 'antiga_fonte.ttf',
};
// one face: the FE-Mercosur of the real plates (there are no slim cuts)
const MERCOSUL_FONT = 'PlateMercosul';

// Real plate sizes in mm (Contran 729/2018 and the older grey plates).
const SIZE_MM = { carro: [400, 130], moto: [200, 170] };

// Height of the blue band in the Mercosul backgrounds (source pixels).
const MERCOSUL_BAND = { carro: 46, moto: 44 };

// City strip of the old-style backgrounds, in source pixels: the strip area
// that holds the baked-in city name, the clean column used to paint over it,
// and where our own city text goes (center + cap height + max width).
const ANTIGA_STRIP = {
  carro: { erase: [140, 20, 425, 31], sampleX: 125, cx: 339, cy: 35.5, cap: 20, maxW: 400 },
  moto: { erase: [84, 52, 408, 52], sampleX: 86, cx: 288, cy: 78, cap: 34, maxW: 350 },
};

const CITIES = {
  SP: [
    'SÃO PAULO', 'CAMPINAS', 'SANTOS', 'GUARULHOS', 'OSASCO', 'SANTO ANDRÉ', 'SÃO BERNARDO DO CAMPO',
    'SÃO CAETANO DO SUL', 'DIADEMA', 'MAUÁ', 'CARAPICUÍBA', 'BARUERI', 'COTIA', 'MOGI DAS CRUZES',
    'SÃO JOSÉ DOS CAMPOS', 'TAUBATÉ', 'JUNDIAÍ', 'SOROCABA', 'PIRACICABA', 'LIMEIRA', 'AMERICANA',
    'RIBEIRÃO PRETO', 'FRANCA', 'BAURU', 'MARÍLIA', 'ARARAQUARA', 'SÃO CARLOS', 'PRESIDENTE PRUDENTE',
    'SÃO JOSÉ DO RIO PRETO', 'ITAQUAQUECETUBA', 'SUZANO', 'PRAIA GRANDE', 'GUARUJÁ', 'SÃO VICENTE',
  ],
  PR: [
    'CURITIBA', 'LONDRINA', 'MARINGÁ', 'PONTA GROSSA', 'CASCAVEL', 'SÃO JOSÉ DOS PINHAIS', 'FOZ DO IGUAÇU',
    'COLOMBO', 'GUARAPUAVA', 'PARANAGUÁ', 'ARAUCÁRIA', 'TOLEDO', 'APUCARANA', 'PINHAIS', 'CAMPO LARGO',
    'ALMIRANTE TAMANDARÉ', 'UMUARAMA', 'PIRAQUARA', 'CAMBÉ', 'FAZENDA RIO GRANDE', 'PARANAVAÍ',
    'FRANCISCO BELTRÃO', 'PATO BRANCO', 'TELÊMACO BORBA', 'CASTRO', 'ROLÂNDIA', 'IRATI', 'UNIÃO DA VITÓRIA',
  ],
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
// Characters OCR models confuse most get extra weight when opts.weighted is set.
const WEIGHTED_LETTERS = 'BGODSQIEAMWHXUVYTJ'.repeat(5) + LETTERS;
const WEIGHTED_DIGITS = '410856'.repeat(5) + DIGITS;

// OCR class ids (same order as the yolov11-training data.yaml) and plate classes.
export const CHAR_CLASSES = LETTERS + DIGITS;
export const PLATE_CLASSES = ['mercosul', 'antiga', 'antiga_invertida'];
// classes of the rectified-plate dataset: what the reader needs of the type, on
// every character box (0-2) and on one box around the whole plate (3-5). A
// Mercosul plate's ink colour changes nothing (always dark on white); old red /
// green plates are white on colour (inverted before the OCR)
export const SEG_CLASSES = ['mercosul', 'antiga', 'antiga_invertida', 'placa_mercosul', 'placa_antiga', 'placa_antiga_invertida'];
export const segFamily = (plateType) => (plateType.startsWith('mercosul') ? 0 : plateType === 'antiga' ? 1 : 2);
// plate types by colour (meta): layout x category, particular / comercial (red) / experiencia (green)
export const PLATE_TYPES = ['mercosul', 'mercosul_vermelha', 'mercosul_verde', 'antiga', 'antiga_vermelha', 'antiga_verde'];
// Mercosul character colours by category
const MERCOSUL_INK = { comercial: '#b3121a', experiencia: '#0d6b35' };

const assets = { images: null, clean: null };
let loading = null;

export function loadPlateAssets() {
  if (!loading) loading = doLoad();
  return loading;
}

async function doLoad() {
  const fontJobs = Object.entries(FONTS).map(async ([family, file]) => {
    const face = new FontFace(family, `url(${asset(file)})`);
    await face.load();
    document.fonts.add(face);
  });
  const images = {};
  const imageJobs = Object.entries(IMAGES).map(([key, file]) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images[key] = img; resolve(); };
    img.onerror = () => reject(new Error(`plates: failed to load ${file}`));
    img.src = asset(file);
  }));
  await Promise.all([...fontJobs, ...imageJobs]);
  assets.images = images;
  // Old-style backgrounds come with a city name painted in the top strip;
  // wipe it once by stretching a clean column of the strip over it.
  assets.clean = {};
  for (const key of Object.keys(images).filter((k) => k.includes('_antiga'))) {
    const img = images[key];
    const c = makeCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const s = ANTIGA_STRIP[key.split('_')[0]];
    const [x, y, w, h] = s.erase;
    g.drawImage(img, s.sampleX, y, 1, h, x, y, w, h);
    assets.clean[key] = c;
  }
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const randChar = (rng, set) => set[Math.floor(rng.next() * set.length)];

// First letter of the old series per state (SP: BFA..GKI, PR: AAA..BEZ).
function seriesLetters(rng, uf) {
  let a;
  if (uf === 'SP') a = rng.pick(['B', 'C', 'D', 'E', 'F', 'G']);
  else a = rng.chance(0.8) ? 'A' : 'B';
  let b = randChar(rng, LETTERS);
  if (uf === 'PR' && a === 'B') b = randChar(rng, 'ABCDE');
  if (uf === 'SP' && a === 'B') b = randChar(rng, 'FGHIJKLMNOPQRSTUVWXYZ');
  if (uf === 'SP' && a === 'G') b = randChar(rng, 'ABCDEFGHIJK');
  return a + b + randChar(rng, LETTERS);
}

// uniform: every character position drawn uniformly (no regional series, no
// weighting), so each letter and each digit turns up about as often (datasets)
export function generatePlateText(rng, style, uf = 'SP', weighted = false, uniform = false) {
  if (uniform) weighted = false;
  const L = weighted ? WEIGHTED_LETTERS : LETTERS;
  // Plates issued after 2018 have no regional series; older ones kept theirs on conversion.
  const head = uniform || weighted || (style === 'mercosul' && rng.chance(0.35))
    ? randChar(rng, L) + randChar(rng, L) + randChar(rng, L)
    : seriesLetters(rng, uf);
  const d = () => randChar(rng, weighted ? WEIGHTED_DIGITS : DIGITS);
  if (style === 'mercosul') return head + d() + randChar(rng, L) + d() + d();
  return `${head}-${d()}${d()}${d()}${d()}`;
}

export function generatePlate(rng, opts = {}) {
  if (!assets.images) throw new Error('plates: call await loadPlateAssets() first');
  const vehicle = opts.vehicle === 'moto' ? 'moto' : 'carro';
  // opts.balanced (dataset generation): every 'auto' choice uniform instead of
  // street frequencies — layout, Mercosul model, category, state, wear (unless
  // given), every character uniform
  const bal = !!opts.balanced;
  let style = opts.style || 'auto';
  if (style === 'auto') style = bal ? rng.pick(['mercosul', 'antiga']) : rng.chance(0.75) ? 'mercosul' : 'antiga';
  let model = opts.model || 'auto';
  if (model === 'auto') model = bal ? rng.pick(['atual', '2018']) : 'atual';
  let category = opts.category || 'auto';
  if (category === 'auto') {
    category = bal ? rng.pick(['particular', 'comercial', 'experiencia'])
      : rng.chance(0.1) ? 'comercial' : rng.chance(0.01) ? 'experiencia' : 'particular';
  }
  const wear = Math.min(1, Math.max(0, bal && opts.wear == null ? rng.float(0, 1) : opts.wear ?? 0.25));
  let uf = opts.uf || 'auto';
  if (uf === 'auto') uf = rng.chance(bal ? 0.5 : 0.6) ? 'SP' : 'PR';
  const city = opts.city || rng.pick(CITIES[uf] || CITIES.SP);
  const weighted = opts.weighted ?? false;
  const text = opts.text || generatePlateText(rng, style, uf, !!weighted, bal);
  const font = style === 'mercosul' ? 'FE-Mercosur' : 'antiga';

  const [mmW, mmH] = SIZE_MM[vehicle];
  const W = Math.round(opts.width || (vehicle === 'carro' ? 512 : 300));
  const H = Math.round(W * mmH / mmW);
  const canvas = makeCanvas(W, H);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (opts.relief) reliefBegin(W, H);

  let chars, relief = null;
  try {
    chars = style === 'mercosul'
      ? drawMercosul(g, W, H, vehicle, category, text, rng, wear, MERCOSUL_FONT, model)
      : drawAntiga(g, W, H, vehicle, category, text, uf, city, rng, wear);

    applyWear(g, W, H, rng, wear, style);
    if (opts.warp !== false && rng.chance(0.15 + 0.4 * wear)) {
      const dyAt = warp(canvas, rng, wear);
      for (const c of chars) { const dy = dyAt((c.x0 + c.x1) / 2); c.y0 += dy; c.y1 += dy; }
    }
    if (R) relief = reliefEnd(g, rng, wear, mmW);
  } finally {
    R = null;
  }
  for (const c of chars) c.cls = CHAR_CLASSES.indexOf(c.ch);

  const plateClass = style === 'mercosul' ? 'mercosul' : category === 'particular' ? 'antiga' : 'antiga_invertida';
  const plateType = style + ({ comercial: '_vermelha', experiencia: '_verde' }[category] || '');
  return {
    canvas, relief, text, kind: style, style, category, vehicle, uf, model: style === 'mercosul' ? model : null, font, wear, weighted: !!weighted, city: style === 'antiga' ? city : null,
    plateClass, plateClassId: PLATE_CLASSES.indexOf(plateClass), plateType, plateTypeId: PLATE_TYPES.indexOf(plateType), chars,
  };
}

// ----------------------------------------------------------------- Relief
// With opts.relief the plate also gets three greyscale layers for the 3D sheet,
// drawn by the same calls that paint the colour: height (stamped characters,
// border bead, riveted strip, screw heads; 255 = RELIEF_MM), retroreflective
// film coverage, and bare metal (screws, film peeled down to the aluminium).
// reliefEnd packs them into one RGBA array: R height (softened into a bevel),
// G film, B metal.
export const RELIEF_MM = 1.5;
const HGT = { rim: 100, strip: 45, char: 175, screw: 255 };
let R = null;

const grey = (v) => `rgb(${v},${v},${v})`;

function reliefBegin(W, H) {
  const layer = () => {
    const c = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    return c;
  };
  R = { h: layer(), f: layer(), m: layer(), W, H, retro: 1 };
}

// fn(ctx, layer) on each relief layer ('h', 'f', 'm'), state saved around it
function rel(fn) {
  if (!R) return;
  for (const k of ['h', 'f', 'm']) { R[k].save(); fn(R[k], k); R[k].restore(); }
}

// The bare sheet: film over the whole face (retro: how reflective it is), a
// raised bead inset along the border.
function reliefBlank(W, H, r, inset, bead, retro) {
  if (!R) return;
  R.retro = retro;
  rel((c, k) => {
    roundRect(c, 0, 0, W, H, r);
    c.fillStyle = k === 'f' ? '#fff' : '#000';
    c.fill();
    if (k === 'h') {
      roundRect(c, inset, inset, W - 2 * inset, H - 2 * inset, Math.max(1, r - inset));
      c.strokeStyle = grey(HGT.rim);
      c.lineWidth = bead;
      c.stroke();
    }
  });
}

// Shading and wear that follow the relief, then the packed layers.
function reliefEnd(g, rng, wear, mmW) {
  const { W, H } = R;
  // a stamped edge is a ramp about a millimetre wide, not a step
  const soft = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
  soft.fillStyle = '#000';
  soft.fillRect(0, 0, W, H);
  soft.filter = `blur(${(0.55 * W / mmW).toFixed(2)}px)`;
  soft.drawImage(R.h.canvas, 0, 0);
  const h = soft.getImageData(0, 0, W, H).data;
  const f = R.f.getImageData(0, 0, W, H).data;
  const m = R.m.getImageData(0, 0, W, H).data;
  const id = g.getImageData(0, 0, W, H);
  const p = id.data;
  const out = new Uint8Array(W * H * 4);
  // the foil on the character faces rubs thin in patches (washing brushes,
  // sun) and greys toward the film under it; dirt settles in the crease at
  // their foot
  const rub = Math.max(0, wear - 0.3) * rng.float(0.3, 0.9);
  const cell = Math.max(3, W / 90);
  const seed = rng.float(0, 1000);
  const hash = (a, b) => { const n = Math.sin(a * 12.9898 + b * 78.233 + seed) * 43758.5453; return n - Math.floor(n); };
  const vnoise = (x, y) => {
    const gx = x / cell, gy = y / cell, ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const hv = h[i] / HGT.char;
    if (p[i + 3] > 0 && hv > 0.04 && hv < 1.1) {
      if (hv < 0.3 && f[i] > 128) {
        const k = 1 - 0.18 * Math.sin(hv / 0.3 * Math.PI);
        p[i] *= k; p[i + 1] *= k; p[i + 2] *= k;
      } else if (rub > 0 && hv > 0.75) {
        const t = rub * Math.max(0, vnoise(x, y) * 1.6 - 0.5);
        p[i] += (200 - p[i]) * t; p[i + 1] += (200 - p[i + 1]) * t; p[i + 2] += (192 - p[i + 2]) * t;
      }
    }
    out[i] = h[i];
    out[i + 1] = p[i + 3] ? f[i] : 0;
    out[i + 2] = m[i];
    out[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return { width: W, height: H, data: out, retro: R.retro, mmPerPx: mmW / W, heightMM: RELIEF_MM };
}

// ---------------------------------------------------------------- Mercosul

// Current model (Contran 780/2019): flat blue band, white body with a black
// rim, QR code and "BR" on the left, no city emblem. Layout in plate fractions,
// measured from photos of real plates.
const MERCOSUL_LAYOUT = {
  carro: {
    band: 0.225, rim: 0.012, radius: 0.025,
    logo: [0.085, 0.13], flag: [0.925, 0.13, 0.068], brasil: [0.515, 0.125, 0.085],
    qr: [0.048, 0.43, 0.052], br: [0.073, 0.86, 0.105, 0.82],
    // No cy: centered vertically in the white area between band and rim.
    lines: [{ from: 0, to: 7, cx: 0.515, w: 0.78 }], cap: 0.47,
  },
  // Motorcycles: no QR, two mounting slots cut through the band, wide glyphs
  // (fill = ink width of an 'H' as a fraction of its cell).
  moto: {
    band: 0.186, rim: 0.012, radius: 0.03,
    logo: [0.17, 0.1], flag: [0.885, 0.1, 0.117], brasil: [0.49, 0.121, 0.071],
    qr: null, br: [0.078, 0.87, 0.114, 0.58], slots: [[0.22, 0.05], [0.777, 0.05], 0.088, 0.036],
    lines: [{ from: 0, to: 3, cx: 0.507, cy: 0.38, w: 0.534 }, { from: 3, to: 7, cx: 0.512, cy: 0.73, w: 0.728 }],
    cap: 0.32, fill: 0.8,
  },
};

function drawMercosul(g, W, H, vehicle, category, text, rng, wear, font, model) {
  if (model === '2018') return drawMercosul2018(g, W, H, vehicle, category, text, rng, wear, font);
  const L = MERCOSUL_LAYOUT[vehicle];
  const rim = L.rim * W, r = L.radius * W, bandH = L.band * H;

  // Plate blank: thin white edge, black rim, white body.
  roundRect(g, 0, 0, W, H, r);
  g.fillStyle = '#f4f4f2';
  g.fill();
  roundRect(g, rim * 0.5, rim * 0.5, W - rim, H - rim, r * 0.9);
  g.fillStyle = '#151515';
  g.fill();
  reliefBlank(W, H, r, rim, rim * 1.1, 1);
  const ix = rim * 1.5, iw = W - rim * 3;
  roundRect(g, ix, ix, iw, H - rim * 3, r * 0.75);
  g.save();
  g.clip();
  g.fillStyle = '#f7f7f5';
  g.fillRect(0, 0, W, H);
  // Faint security pattern in the white body.
  g.strokeStyle = 'rgba(150,160,175,0.10)';
  g.lineWidth = Math.max(0.5, W / 600);
  const phase = rng.float(0, Math.PI * 2);
  for (let k = 0; k < 9; k++) {
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const y = bandH + (H - bandH) * (0.1 + k * 0.1) + Math.sin(x / W * 9 + phase + k) * H * 0.03;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }

  // Blue band.
  const bg = g.createLinearGradient(0, 0, 0, bandH);
  bg.addColorStop(0, '#2c5cb5');
  bg.addColorStop(1, '#1f4a9c');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, bandH);
  const fade = wear * rng.float(0, 0.45);
  if (fade > 0.02) { g.fillStyle = `rgba(200,215,235,${fade})`; g.fillRect(0, 0, W, bandH); }

  // "BRASIL", Mercosul logo, flag.
  g.fillStyle = '#f5f7fb';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${L.brasil[2] * H * 1.38}px Arial, Helvetica, sans-serif`;
  g.letterSpacing = `${L.brasil[2] * H * 0.18}px`;
  g.fillText('BRASIL', L.brasil[0] * W, L.brasil[1] * H);
  g.letterSpacing = '0px';
  drawMercosulLogo(g, L.logo[0] * W, L.logo[1] * H, bandH);
  drawFlag(g, L.flag[0] * W, L.flag[1] * H, L.flag[2] * W);
  g.restore();

  // Mounting slots are holes through the plate.
  if (L.slots) {
    const [a, b, sw, sh] = L.slots;
    const cut = (c) => {
      for (const [sx, sy] of [a, b]) {
        roundRect(c, (sx - sw / 2) * W, (sy - sh / 2) * H, sw * W, sh * H, sh * H / 2);
        c.fill();
      }
    };
    g.save();
    g.globalCompositeOperation = 'destination-out';
    cut(g);
    g.restore();
    rel((c) => { c.fillStyle = '#000'; cut(c); });
  }

  // QR code and condensed "BR".
  if (L.qr) drawQr(g, L.qr[0] * W, L.qr[1] * H, L.qr[2] * W, rng);
  g.save();
  g.fillStyle = '#151515';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${L.br[2] * H * 1.38}px Arial, Helvetica, sans-serif`;
  g.translate(L.br[0] * W, L.br[1] * H);
  g.scale(L.br[3], 1);
  g.fillText('BR', 0, 0);
  g.restore();

  const color = MERCOSUL_INK[category] || '#151515';
  const depth = H * 0.008;
  const whiteMid = (bandH + H - rim * 1.5) / 2;
  return L.lines.flatMap((ln) =>
    drawCells(g, text.slice(ln.from, ln.to), font, L.cap * H, ln.cx * W, ln.cy != null ? ln.cy * H : whiteMid,
      ln.w * W, color, depth, L.fill));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// Southern Cross stars over a small "MERCOSUL" caption.
function drawMercosulLogo(g, x, y, bandH) {
  const s = bandH;
  g.save();
  g.fillStyle = '#f5f7fb';
  const stars = [[-0.08, -0.3, 0.05], [0.08, -0.12, 0.045], [-0.02, -0.02, 0.04], [-0.17, -0.1, 0.04], [0.02, -0.2, 0.025]];
  for (const [dx, dy, r] of stars) star(g, x + dx * s, y + dy * s, r * s);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${s * 0.2}px Arial, Helvetica, sans-serif`;
  g.fillText('MERCOSUL', x, y + s * 0.3);
  g.restore();
}

function star(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

// Brazilian flag with a thin white frame, w wide.
function drawFlag(g, cx, cy, w) {
  const h = w * 0.7, x = cx - w / 2, y = cy - h / 2;
  g.fillStyle = '#f5f7fb';
  g.fillRect(x - w * 0.05, y - w * 0.05, w * 1.1, h + w * 0.1);
  g.fillStyle = '#16a04a';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#f7d116';
  g.beginPath();
  g.moveTo(cx, y + h * 0.1); g.lineTo(x + w * 0.92, cy); g.lineTo(cx, y + h * 0.9); g.lineTo(x + w * 0.08, cy);
  g.closePath(); g.fill();
  g.fillStyle = '#1d3f8f';
  g.beginPath(); g.arc(cx, cy, h * 0.24, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#f5f7fb';
  g.lineWidth = h * 0.05;
  g.beginPath(); g.arc(cx + h * 0.05, cy + h * 0.45, h * 0.5, -Math.PI * 0.68, -Math.PI * 0.42); g.stroke();
}

// Random 21x21 QR-looking matrix with the three finder squares.
function drawQr(g, x, y, size, rng) {
  const n = 21, m = size / n;
  g.fillStyle = '#f7f7f5';
  g.fillRect(x - m, y - m, size + 2 * m, size + 2 * m);
  g.fillStyle = 'rgba(30,30,30,0.85)';
  const finder = (i, j) => (i < 8 && j < 8) || (i >= n - 8 && j < 8) || (i < 8 && j >= n - 8);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (finder(i, j)) continue;
    if (rng.chance(0.5)) g.fillRect(x + i * m, y + j * m, m, m);
  }
  for (const [i, j] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    g.fillRect(x + i * m, y + j * m, 7 * m, 7 * m);
    g.fillStyle = '#f7f7f5'; g.fillRect(x + (i + 1) * m, y + (j + 1) * m, 5 * m, 5 * m);
    g.fillStyle = 'rgba(30,30,30,0.85)'; g.fillRect(x + (i + 2) * m, y + (j + 2) * m, 3 * m, 3 * m);
  }
}

// First Mercosul model (2018-2020), with the city emblem column, from the PNG backgrounds.
function drawMercosul2018(g, W, H, vehicle, category, text, rng, wear, font) {
  const img = assets.images[`${vehicle}_mercosul`];
  // The band keeps its own proportion; the white body stretches to the real
  // plate height (the source images are cropped short at the bottom).
  const band = MERCOSUL_BAND[vehicle];
  const bandH = band * W / img.width;
  reliefBlank(W, H, W * 0.025, W * 0.012, W * 0.013, 1);
  g.drawImage(img, 0, 0, img.width, band, 0, 0, W, bandH);
  g.drawImage(img, 0, band, img.width, img.height - band, 0, bandH, W, H - bandH);
  // Sun fading: blend toward the pale variant of the same background.
  const fade = wear * rng.float(0, 0.5);
  if (fade > 0.02) {
    const pale = assets.images[`${vehicle}_mercosul_branca`];
    g.globalAlpha = fade;
    g.drawImage(pale, 0, 0, pale.width, band, 0, 0, W, bandH);
    g.globalAlpha = 1;
  }

  const color = MERCOSUL_INK[category] || '#141414';
  const bodyTop = bandH, bodyH = H - bandH;
  if (vehicle === 'carro') {
    const cap = H * 0.45;
    const cy = bodyTop + bodyH * 0.52;
    return drawCells(g, text, font, cap, W * 0.475, cy, W * 0.77, color, 0.6);
  }
  const cap = H * 0.27;
  return [
    ...drawCells(g, text.slice(0, 3), font, cap, W * 0.465, bodyTop + bodyH * 0.27, W * 0.52, color, 0.6),
    ...drawCells(g, text.slice(3), font, cap, W * 0.465, bodyTop + bodyH * 0.71, W * 0.7, color, 0.6),
  ];
}

// --------------------------------------------------------------- Old style

function drawAntiga(g, W, H, vehicle, category, text, uf, city, rng, wear) {
  const variant = { comercial: '_vermelha', experiencia: '_verde' }[category] || '';
  const src = assets.clean[`${vehicle}_antiga${variant}`];
  g.drawImage(src, 0, 0, W, H);
  const sx = W / src.width, sy = H / src.height;
  const ink = variant ? '#f4f1ea' : '#121212';
  if (R) {
    // painted sheet: only some of the later ones carry a reflective film
    const moto = vehicle === 'moto';
    reliefBlank(W, H, W * (moto ? 0.04 : 0.03), W * (moto ? 0.018 : 0.011), W * (moto ? 0.012 : 0.008), rng.chance(0.35) ? 0.55 : 0);
    // the riveted city strip sits on top of the sheet
    const [x0, x1, y0, y1] = moto ? [0.072, 0.946, 0.103, 0.224] : [0.074, 0.928, 0.09, 0.26];
    R.h.fillStyle = grey(HGT.strip);
    R.h.fillRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H);
  }

  // City strip: "SP · CAMPINAS" on cars, "SP-CAMPINAS" on motorcycles.
  const s = ANTIGA_STRIP[vehicle];
  const label = vehicle === 'carro' ? `${uf} · ${city}` : `${uf}-${city}`;
  drawLine(g, label, 'PlateAntiga', s.cap * sy, s.cx * sx, s.cy * sy, s.maxW * sx, ink, 0.15, 0.4);

  const [letters, numbers] = text.split('-');
  if (vehicle === 'carro') {
    // in the font's own proportions (nearly unscaled): tight spacing, the line
    // spans the plate between the rims like on the real ones
    return drawLine(g, `${letters}-${numbers}`, 'PlateAntiga', H * 0.47, W * 0.5, H * 0.625, W * 0.9, ink, 0.03, 1);
  }
  return [
    ...drawLine(g, letters, 'PlateAntiga', H * 0.27, W * 0.5, H * 0.45, W * 0.62, ink, 0.18, 1),
    ...drawLine(g, numbers, 'PlateAntiga', H * 0.27, W * 0.5, H * 0.78, W * 0.8, ink, 0.12, 1),
  ];
}

// ------------------------------------------------------------------- Text

// Sizes the font so an 'H' is cap pixels tall. Some plate fonts sit partly
// below the baseline, so the ink height counts the descent too; drop is how far
// the baseline must be raised to put the ink bottom at the line bottom.
function fontFor(g, family, cap) {
  g.font = `100px ${family}`;
  g.textBaseline = 'alphabetic';
  const m = g.measureText('H');
  const ink = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 70;
  const px = 100 * cap / ink;
  g.font = `${px}px ${family}`;
  return { px, drop: m.actualBoundingBoxDescent * px / 100 };
}

// Embossed text: dark lower-right edge, light upper-left edge, then the face.
// With a relief the 3D sheet does the shading: only a trace stays painted (it
// helps at distances where the normal map is averaged away).
function emboss(g, draw, color, depth) {
  const d = depth;
  g.save();
  g.fillStyle = R ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.45)';
  draw(d, d);
  g.fillStyle = R ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)';
  draw(-d * 0.7, -d * 0.7);
  g.fillStyle = color;
  draw(0, 0);
  g.restore();
  if (R) {
    const c = R.h;
    c.save();
    c.font = g.font; c.textAlign = g.textAlign; c.textBaseline = g.textBaseline; c.letterSpacing = g.letterSpacing;
    c.fillStyle = grey(HGT.char);
    draw(0, 0, c);
    c.restore();
  }
}

// Fixed-pitch layout: each character centered in an equal cell, squeezed if
// wider. With fill set, glyphs are stretched horizontally so an 'H' covers
// that fraction of the cell (the wide motorcycle glyphs).
function drawCells(g, str, family, cap, cx, cy, totalW, color, depth, fill = 0) {
  g.save();
  const { drop } = fontFor(g, family, cap);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'center';
  const cell = totalW / str.length;
  const x0 = cx - totalW / 2;
  const base = cy + cap / 2 - drop;
  const mH = g.measureText('H');
  const stretch = fill ? (cell * fill) / inkWidth(mH) : 1;
  const scaleOf = (m) => Math.min(stretch, (cell * 0.92) / m.width);
  const draw = (dx, dy, c = g) => {
    for (let i = 0; i < str.length; i++) {
      c.save();
      c.translate(x0 + cell * (i + 0.5) + dx, base + dy);
      c.scale(scaleOf(g.measureText(str[i])), 1);
      c.fillText(str[i], 0, 0);
      c.restore();
    }
  };
  emboss(g, draw, color, depth);
  const minW = inkWidth(mH) * scaleOf(mH);
  const boxes = [];
  for (let i = 0; i < str.length; i++) {
    const m = g.measureText(str[i]);
    const k = scaleOf(m);
    const x = x0 + cell * (i + 0.5);
    boxes.push(box(str[i], x - m.actualBoundingBoxLeft * k, base - m.actualBoundingBoxAscent,
      x + m.actualBoundingBoxRight * k, base + m.actualBoundingBoxDescent, minW));
  }
  g.restore();
  return boxes;
}

// Tight character box in canvas pixels.
// Thin glyphs (I, 1) are widened around their center to minW, the ink width
// of an 'H', so every crop has the same width as a regular character.
function box(ch, x0, y0, x1, y1, minW = 0) {
  const grow = Math.max(0, minW - (x1 - x0)) / 2;
  return { ch, x0: x0 - grow, y0, x1: x1 + grow, y1 };
}

const inkWidth = (m) => m.actualBoundingBoxLeft + m.actualBoundingBoxRight;

// Proportional line, scaled horizontally to fit maxW.
function drawLine(g, str, family, cap, cx, cy, maxW, color, letterSpacing, depth) {
  g.save();
  const { px, drop } = fontFor(g, family, cap);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const spacing = px * letterSpacing;
  const widths = [...str].map((ch) => g.measureText(ch).width);
  const natural = widths.reduce((a, b) => a + b, 0) + spacing * (widths.length - 1);
  const k = Math.min(1, maxW / natural);
  const base = cy + cap / 2 - drop;
  const draw = (dx, dy, c = g) => {
    c.save();
    c.translate(cx - (natural * k) / 2 + dx, base + dy);
    c.scale(k, 1);
    let x = 0;
    [...str].forEach((ch, i) => { c.fillText(ch, x, 0); x += widths[i] + spacing; });
    c.restore();
  };
  emboss(g, draw, color, depth);
  // Boxes only for OCR classes (hyphens, dots and the city strip are skipped by the caller).
  const minW = inkWidth(g.measureText('H')) * k;
  const boxes = [];
  const left = cx - (natural * k) / 2;
  let x = 0;
  [...str].forEach((ch, i) => {
    if (CHAR_CLASSES.includes(ch)) {
      const m = g.measureText(ch);
      boxes.push(box(ch, left + (x - m.actualBoundingBoxLeft) * k, base - m.actualBoundingBoxAscent,
        left + (x + m.actualBoundingBoxRight) * k, base + m.actualBoundingBoxDescent, minW));
    }
    x += widths[i] + spacing;
  });
  g.restore();
  return boxes;
}

// ------------------------------------------------------------------- Wear

function applyWear(g, W, H, rng, wear, style) {
  const u = Math.min(W, H) / 130; // scale for strokes, ~1 at car plate height
  g.save();
  // Everything stays inside the plate's own alpha (rounded corners).
  g.globalCompositeOperation = 'source-atop';

  // Old film lets go at a corner or an edge, down to the bare aluminium.
  if (R && R.retro > 0 && wear > 0.4 && rng.chance((wear - 0.4) * 1.4)) {
    for (let n = rng.chance(0.3) ? 2 : 1; n > 0; n--) peel(g, W, H, rng, wear);
  }

  // Screws: most plates have two, in the band (Mercosul) or on the city strip rivets (old style).
  if (rng.chance(0.75)) {
    const rust = wear * rng.float(0.2, 1);
    // Motorcycle Mercosul: in the mounting slots.
    const ys = style === 'mercosul' ? (W / H > 2 ? 0.105 : 0.05) : (W / H > 2 ? 0.18 : 0.165);
    const xs = style === 'mercosul' ? (W / H > 2 ? rng.float(0.27, 0.31) : 0.22 + rng.float(-0.02, 0.02)) : (W / H > 2 ? 0.105 : 0.11);
    for (const x of [xs, 1 - xs]) drawScrew(g, x * W, ys * H, 4.2 * u, rng, rust, H);
  }

  // Overall fade: a pale wash over paint and characters.
  const fade = wear * rng.float(0, 0.22);
  if (fade > 0.01) {
    g.fillStyle = `rgba(232,230,220,${fade})`;
    g.fillRect(0, 0, W, H);
  }
  // Sun-aged film yellows and loses its sheen.
  if (R && R.retro > 0 && wear > 0.3) {
    const y = (wear - 0.3) / 0.7 * rng.float(0.3, 1);
    g.fillStyle = `rgba(226,205,140,${0.22 * y})`;
    g.fillRect(0, 0, W, H);
    R.retro *= 1 - 0.45 * y;
  }

  // Road grime collects toward the bottom edge.
  const grime = wear * rng.float(0.15, 0.6);
  const lg = g.createLinearGradient(0, H * rng.float(0.3, 0.6), 0, H);
  lg.addColorStop(0, 'rgba(90,75,55,0)');
  lg.addColorStop(1, `rgba(90,75,55,${grime * 0.55})`);
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);

  // Dust blotches.
  const blotches = Math.round(wear * rng.float(4, 16));
  for (let i = 0; i < blotches; i++) {
    const x = rng.float(0, W), y = rng.float(0, H) * 0.6 + rng.float(0, H) * 0.4;
    const r = rng.float(0.05, 0.25) * W;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const a = wear * rng.float(0.05, 0.22);
    rg.addColorStop(0, `rgba(105,90,70,${a})`);
    rg.addColorStop(1, 'rgba(105,90,70,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Scratches: thin bright line with a faint dark edge.
  const scratches = Math.round(wear * wear * rng.float(0, 9));
  for (let i = 0; i < scratches; i++) {
    const x = rng.float(0, W), y = rng.float(0, H);
    const len = rng.float(0.04, 0.3) * W, ang = rng.float(-0.5, 0.5) + (rng.chance(0.2) ? Math.PI / 2 : 0);
    const bend = rng.float(-0.1, 0.1) * len;
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    const mx = (x + x2) / 2 - Math.sin(ang) * bend, my = (y + y2) / 2 + Math.cos(ang) * bend;
    const w = rng.float(0.4, 1.1) * u;
    g.lineCap = 'round';
    g.strokeStyle = `rgba(40,35,30,${rng.float(0.1, 0.25)})`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x + 0.6, y + 0.6); g.quadraticCurveTo(mx + 0.6, my + 0.6, x2 + 0.6, y2 + 0.6); g.stroke();
    g.strokeStyle = `rgba(250,250,245,${rng.float(0.25, 0.6)})`;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(mx, my, x2, y2); g.stroke();
    // the film is cut along the scratch, the deep ones down to the metal
    const deep = R && rng.chance(0.4);
    rel((c, k) => {
      if (k === 'h') return;
      c.lineCap = 'round';
      c.lineWidth = w * (k === 'm' ? 0.6 : 1.2);
      c.strokeStyle = k === 'f' ? grey(70) : grey(deep ? 200 : 0);
      c.globalCompositeOperation = k === 'm' ? 'lighten' : 'darken';
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(mx, my, x2, y2); c.stroke();
    });
  }
  g.restore();

  // Fine grain / dust speckle.
  const grain = 3 + wear * 14;
  const id = g.getImageData(0, 0, W, H);
  const p = id.data;
  const speck = wear * 0.012;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] === 0) continue;
    let n = (rng.next() - 0.5) * grain;
    if (rng.next() < speck) n -= rng.float(20, 70);
    p[i] += n; p[i + 1] += n; p[i + 2] += n * 0.9;
  }
  g.putImageData(id, 0, 0);
}

function drawScrew(g, x, y, r, rng, rust, H) {
  // Rust streak running down from the screw.
  if (rust > 0.35) {
    const len = H * rng.float(0.1, 0.35) * rust;
    const lg = g.createLinearGradient(0, y, 0, y + len);
    lg.addColorStop(0, `rgba(120,60,20,${0.35 * rust})`);
    lg.addColorStop(1, 'rgba(120,60,20,0)');
    g.fillStyle = lg;
    g.fillRect(x - r * 0.5, y, r, len);
  }
  const rg = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  const metal = rust > 0.5 ? ['#c9b8a0', '#7a5a3a'] : ['#f2f2f0', '#8c8f94'];
  rg.addColorStop(0, metal[0]);
  rg.addColorStop(1, metal[1]);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.arc(x + r * 0.2, y + r * 0.25, r * 1.05, 0, Math.PI * 2); g.fill();
  g.fillStyle = rg;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  // Phillips slot.
  const a = rng.float(0, Math.PI);
  // a domed head standing off the sheet, bare metal, its cross sunk in it
  rel((c, k) => {
    if (k === 'h') {
      const dome = c.createRadialGradient(x, y, 0, x, y, r);
      dome.addColorStop(0, grey(HGT.screw));
      dome.addColorStop(0.7, grey(Math.round(HGT.screw * 0.8)));
      dome.addColorStop(1, grey(Math.round(HGT.screw * 0.45)));
      c.fillStyle = dome;
    } else c.fillStyle = k === 'm' ? grey(rust > 0.5 ? 120 : 255) : '#000';
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    if (k === 'h') {
      c.strokeStyle = grey(Math.round(HGT.screw * 0.5));
      c.lineWidth = Math.max(0.8, r * 0.22);
      c.beginPath();
      for (const t of [a, a + Math.PI / 2]) {
        c.moveTo(x - Math.cos(t) * r * 0.6, y - Math.sin(t) * r * 0.6);
        c.lineTo(x + Math.cos(t) * r * 0.6, y + Math.sin(t) * r * 0.6);
      }
      c.stroke();
    }
  });
  g.strokeStyle = 'rgba(40,40,40,0.7)';
  g.lineWidth = Math.max(0.8, r * 0.22);
  g.beginPath();
  for (const t of [a, a + Math.PI / 2]) {
    g.moveTo(x - Math.cos(t) * r * 0.6, y - Math.sin(t) * r * 0.6);
    g.lineTo(x + Math.cos(t) * r * 0.6, y + Math.sin(t) * r * 0.6);
  }
  g.stroke();
}

// Film peeled off near a corner or along an edge: an irregular patch of dull
// aluminium with a lifted, darker rim of torn film around it.
function peel(g, W, H, rng, wear) {
  const u = Math.min(W, H);
  const corner = rng.chance(0.7);
  const cx = corner ? (rng.chance(0.5) ? 0 : W) : rng.float(0.1, 0.9) * W;
  const cy = corner ? (rng.chance(0.5) ? 0 : H) : (rng.chance(0.6) ? H : 0);
  const rad = u * rng.float(0.08, 0.2) * (0.6 + wear * 0.6);
  const pts = [];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const rr = rad * (0.6 + 0.4 * Math.sin(a * 3 + rng.float(0, 6)) * 0.5 + rng.float(0, 0.45));
    pts.push([cx + Math.cos(a) * rr * (corner ? 1 : 1.8), cy + Math.sin(a) * rr]);
  }
  const path = (c) => {
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
  };
  path(g);
  g.fillStyle = '#a3a6a8';
  g.fill();
  g.strokeStyle = 'rgba(70,64,55,0.55)';
  g.lineWidth = Math.max(1, u / 110);
  g.stroke();
  rel((c, k) => {
    path(c);
    if (k === 'h') { c.strokeStyle = grey(30); c.lineWidth = Math.max(1, u / 90); c.globalCompositeOperation = 'lighten'; c.stroke(); return; }
    c.fillStyle = k === 'm' ? '#fff' : '#000';
    c.fill();
  });
}

// Slight bend: shift columns vertically along a smooth curve, plus a soft
// shading band where the metal folds.
function warp(canvas, rng, wear) {
  const W = canvas.width, H = canvas.height;
  const g = canvas.getContext('2d');
  const amp = H * rng.float(0.006, 0.02) * (0.5 + wear);
  const fold = rng.float(0.15, 0.85);
  const sharp = rng.float(2, 6);
  const step = 2;
  // the relief layers move with the print
  for (const c of [g, ...(R ? [R.h, R.f, R.m] : [])]) {
    const src = makeCanvas(W, H);
    src.getContext('2d').drawImage(c.canvas, 0, 0);
    if (c === g) c.clearRect(0, 0, W, H);
    else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    for (let x = 0; x < W; x += step) {
      const t = x / W - fold;
      const dy = amp * Math.exp(-sharp * sharp * t * t) * 1.6 - amp * 0.3;
      c.drawImage(src, x, 0, step, H, x, dy, step, H);
    }
  }
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const fx = fold * W, fw = W / sharp * 0.6;
  const lg = g.createLinearGradient(fx - fw, 0, fx + fw, 0);
  const a = 0.08 + 0.1 * wear;
  lg.addColorStop(0, 'rgba(0,0,0,0)');
  lg.addColorStop(0.45, `rgba(255,255,255,${a})`);
  lg.addColorStop(0.55, `rgba(0,0,0,${a})`);
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);
  g.restore();
  // Vertical shift at a given x, so callers can move label boxes along.
  return (x) => { const t = x / W - fold; return amp * Math.exp(-sharp * sharp * t * t) * 1.6 - amp * 0.3; };
}
