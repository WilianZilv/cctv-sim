// Canvas-painted signage: shop fronts, house numbers, street plates, warning plates,
// and spray-painted pichacao tags.
import * as THREE from 'three';

const SHOPS = [
  ['PADARIA', ['E CONFEITARIA', 'PÃO QUENTE', '']], ['BAR', ['DO ZÉ', 'DO TIÃO', 'DO BAIANO', 'E LANCHONETE', 'DA TIA']],
  ['MERCADINHO', ['SÃO JORGE', 'BOM PREÇO', 'DA VILA', 'PRIMAVERA']], ['AUTO PEÇAS', ['SÃO PAULO', 'CENTRAL', 'NOVA ERA']],
  ['OFICINA MECÂNICA', ['DO ALEMÃO', 'E FUNILARIA', '']], ['BORRACHARIA', ['24 HORAS', '']], ['SALÃO', ['BELEZA PURA', 'ESPAÇO MULHER', 'DA NEIDE']],
  ['BARBEARIA', ['VIP', 'DO VAL', 'STYLE']], ['LANCHONETE', ['E PASTELARIA', 'DO JAPA', '']], ['PIZZARIA', ['BELLA NAPOLI', 'DO BAIRRO']],
  ['AÇOUGUE', ['E FRIOS', 'BOI GORDO']], ['FARMÁCIA', ['POPULAR', 'SÃO JOÃO', 'DROGA VIDA']], ['PET SHOP', ['AMIGO FIEL', 'BANHO E TOSA']],
  ['LAVANDERIA', ['EXPRESSA', '']], ['ADEGA', ['E CONVENIÊNCIA', '24H']], ['MATERIAIS P/ CONSTRUÇÃO', ['ALIANÇA', 'DO POVO']],
  ['IGREJA EVANGÉLICA', ['ASSEMBLEIA DE DEUS', 'CHAMA VIVA']], ['ASSISTÊNCIA TÉCNICA', ['CELULAR E INFORMÁTICA']],
  ['PAPELARIA', ['E XEROX', 'CRIATIVA']], ['SACOLÃO', ['HORTIFRUTI', 'DA FEIRA']], ['CHAVEIRO', ['24H', '']], ['LOJA', ['DE ROUPAS', 'TUDO 10']],
];
const PALETTES = [
  ['#c4161c', '#ffffff'], ['#f2c500', '#1a1a1a'], ['#0b4ea2', '#ffffff'], ['#0f7a3a', '#ffffff'], ['#ffffff', '#c4161c'],
  ['#1a1a1a', '#f2c500'], ['#e86a10', '#ffffff'], ['#6b2d8f', '#ffffff'], ['#f4f1e8', '#0b4ea2'],
];

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function fitText(g, text, maxW, size, font = 'bold', family = 'Arial Black, Arial, sans-serif') {
  // text width scales with the font size: measure once and solve for the size
  g.font = `${font} ${size}px ${family}`;
  const w = g.measureText(text).width;
  if (w <= maxW) return;
  const s = Math.max(8, Math.floor(size * maxW / w));
  g.font = `${font} ${s}px ${family}`;
}

function phone(r, city) {
  const ddd = city === 'cwb' ? '41' : '11';
  return `(${ddd}) 9${r.int(1000, 9999)}-${r.int(1000, 9999)}`;
}

export function shopSign(r, city, aspect) {
  const [kind, subs] = r.pick(SHOPS);
  const sub = r.pick(subs);
  const [bg, fg] = r.pick(PALETTES);
  const w = 1024, h = Math.max(128, Math.round(1024 / aspect));
  const tex = canvasTex(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // faded / dirty
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(255,255,255,0.05)'); grd.addColorStop(1, 'rgba(40,30,20,0.25)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, kind, w * 0.9, h * (sub ? 0.45 : 0.6));
    g.fillText(kind, w / 2, h * (sub ? 0.36 : 0.5));
    if (sub) { fitText(g, sub, w * 0.8, h * 0.22, 'bold', 'Arial, sans-serif'); g.fillText(sub, w / 2, h * 0.68); }
    if (r.chance(0.6)) { fitText(g, phone(r, city), w * 0.4, h * 0.12, 'bold', 'Arial, sans-serif'); g.fillText(phone(r, city), w / 2, h * 0.88); }
    // rust/dirt streaks
    for (let i = 0; i < 25; i++) {
      g.fillStyle = `rgba(60,40,20,${r.float(0.03, 0.12)})`;
      const x = r.float(0, w);
      g.fillRect(x, r.float(0, h * 0.3), r.float(2, 8), r.float(h * 0.3, h));
    }
  });
  return tex;
}

export function houseNumber(r, num) {
  const style = r.int(0, 2);
  return canvasTex(128, 96, (g, w, h) => {
    g.fillStyle = style === 0 ? '#1d3e7a' : style === 1 ? '#f2f0ea' : '#3a2a1e';
    g.fillRect(0, 0, w, h);
    g.fillStyle = style === 1 ? '#202020' : '#f2f0ea';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, String(num), w * 0.85, 70, 'bold', 'Arial, sans-serif');
    g.fillText(String(num), w / 2, h / 2 + 3);
  });
}

export function streetPlate(name, city) {
  return canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = city === 'cwb' ? '#163a6b' : '#1d4f9c';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#f2f2f2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const words = name.split(' ');
    const prefix = words[0].length <= 4 ? words[0] : '';
    const rest = prefix ? words.slice(1).join(' ') : name;
    if (prefix) { g.font = 'bold 26px Arial, sans-serif'; g.fillText(prefix.toUpperCase(), w / 2, 34); }
    fitText(g, rest.toUpperCase(), w * 0.9, 50, 'bold', 'Arial Narrow, Arial, sans-serif');
    g.fillText(rest.toUpperCase(), w / 2, prefix ? 80 : h / 2);
  });
}

export function warningPlate(r) {
  const text = r.pick([['CUIDADO', 'CERCA ELÉTRICA'], ['CUIDADO', 'CÃO BRAVO'], ['NÃO ESTACIONE', 'GARAGEM'], ['ALUGA-SE', ''], ['VENDE-SE', ''], ['PROIBIDO', 'JOGAR LIXO']]);
  const yellow = text[0] === 'CUIDADO';
  const red = text[0].startsWith('NÃO') || text[0] === 'PROIBIDO';
  return {
    tex: canvasTex(256, 160, (g, w, h) => {
      g.fillStyle = yellow ? '#f2c500' : red ? '#f4f1ea' : '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = red ? '#c4161c' : '#111';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      fitText(g, text[0], w * 0.9, 46);
      g.fillText(text[0], w / 2, text[1] ? h * 0.33 : h * 0.4);
      if (text[1]) { fitText(g, text[1], w * 0.9, 36); g.fillText(text[1], w / 2, h * 0.7); }
      if (!yellow && !red) { fitText(g, phone(r, 'sp'), w * 0.8, 26, 'bold', 'Arial'); g.fillText(phone(r, 'sp'), w / 2, h * 0.78); }
    }),
    aspect: 256 / 160,
  };
}

// pichacao: tall angular "runic" letters in black spray, typical of Sao Paulo walls
export function tagTexture(r, w = 1024, h = 256) {
  return canvasTex(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    const color = r.weighted([['rgba(15,15,15,0.92)', 6], ['rgba(170,25,25,0.85)', 1], ['rgba(30,40,120,0.85)', 0.6], ['rgba(240,240,240,0.9)', 0.4]]);
    g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'miter';
    const rows = r.chance(0.3) ? 2 : 1;
    for (let row = 0; row < rows; row++) {
      const letters = r.int(4, 9);
      const lh = (h / rows) * r.float(0.55, 0.85);
      const y0 = (h / rows) * row + (h / rows - lh) / 2;
      let x = r.float(10, 60);
      const lw = Math.min((w - x - 20) / letters, lh * 0.45);
      g.lineWidth = r.float(4, 9);
      for (let i = 0; i < letters; i++) {
        g.beginPath();
        const segs = r.int(2, 4);
        let px = x + r.float(0, lw * 0.3), py = y0 + lh;
        g.moveTo(px, py);
        for (let k = 0; k < segs; k++) {
          px = x + r.float(0, lw * 0.85);
          py = r.chance(0.5) ? y0 + r.float(0, lh * 0.15) : y0 + lh * r.float(0.5, 1);
          g.lineTo(px, py);
        }
        g.stroke();
        if (r.chance(0.3)) { g.beginPath(); g.moveTo(x, y0 + lh * 0.5); g.lineTo(x + lw * 0.7, y0 + lh * 0.45); g.stroke(); }
        x += lw * r.float(0.85, 1.15);
      }
      // drips
      for (let i = 0; i < r.int(0, 6); i++) {
        const dx = r.float(20, x);
        g.lineWidth = 2; g.beginPath(); g.moveTo(dx, y0 + lh); g.lineTo(dx, y0 + lh + r.float(5, 30)); g.stroke();
      }
    }
  });
}
