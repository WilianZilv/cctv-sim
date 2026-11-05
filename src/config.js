import { LOOKS } from './cam/grade.js';
// Generator and camera parameters exposed in the UI. Weights are multipliers on the
// built-in (city-aware) probabilities: 1 keeps the default, 0 disables an option.
// `apply` says what a change needs: 'rebuild' regenerates the scene (textures are
// kept), 'camera' recreates the camera/codec, 'live' takes effect next frame.

export const DEFAULTS = {
  roads: {
    widthScale: 1, sidewalkScale: 1, wear: 1, patches: 1, centerLine: 1, crosswalks: 1, bumps: 1, paintWear: 1,
  },
  sidewalk: {
    concrete: 1, concrete_old: 1, ceramic_red: 1, caquinho: 1, ladrilho: 1, paver: 1, grass_strip: 1, petitpave: 1,
  },
  lots: {
    widthScale: 1, commercial: 1, vacant: 1, genBuildings: true, garage: 1,
  },
  walls: {
    heightScale: 1, plaster_full: 1, base_grille: 1, grille: 1, block_raw: 1, stone_base: 1, low_wall: 1, brick_raw: 1,
    electric: 1, concertina: 1, spikes: 1, glass: 1, tags: 1,
  },
  buildings: {
    floorsScale: 1, ceramic: 1, fibro: 1, flat: 1, waterTank: 1, windowGrille: 1, ac: 1, litWindows: 1,
  },
  grime: {
    amount: 1, weeds: 1,
  },
  props: {
    poleSpacing: 35, trees: 1, trash: 1, wires: 1, cacamba: 1, streetlightsOn: true,
  },
  camera: {
    mount: 'auto', quality: 'auto', model: 'auto', tier: 'auto',
    height: 0, yaw: 0, pitch: 0, roll: 0,
  },
  lens: {
    hfov: 0, distortion: -1, focus: -1, dirt: -1, web: 'auto', visor: 'auto',
  },
  isp: {
    sharp: -1, sat: -1, noise: -1, dwdr: -1, irMode: 'auto', exposureBias: 0,
  },
  codec: {
    kbps: 0, fps: 0, gop: 0, codec: 'auto',
  },
  tex: { size: 512, filter: 'trilinear', aniso: 8 },
  grade: { fxaa: 'yes', look: 'natural', ...structuredClone(LOOKS.natural) },
};

const MOUNTS = { 'Automático': 'auto', 'Topo do muro': 'wall_top', 'Quina do muro': 'wall_corner', 'Fachada': 'facade', 'Poste': 'pole' };
const QUALITY = { 'Automático': 'auto', 'Bem apontada': 'ok', 'Muito alta (céu)': 'too_flat', 'Muito baixa (chão)': 'too_steep', 'Torta': 'skewed' };
const AUTO_YN = { 'Automático': 'auto', 'Sim': 'yes', 'Não': 'no' };

// [path, label, min|options, max, step, apply]
export const SCHEMA = [
  { folder: 'Ruas', items: [
    ['roads.widthScale', 'Largura da pista', 0.6, 1.8, 0.01, 'rebuild'],
    ['roads.sidewalkScale', 'Largura da calçada', 0.3, 2, 0.01, 'rebuild'],
    ['roads.wear', 'Desgaste do asfalto', 0, 3, 0.05, 'rebuild'],
    ['roads.patches', 'Remendos', 0, 4, 0.05, 'rebuild'],
    ['roads.paintWear', 'Desgaste da pintura', 0, 2, 0.05, 'rebuild'],
    ['roads.centerLine', 'Faixa central', 0, 3, 0.05, 'rebuild'],
    ['roads.crosswalks', 'Faixas de pedestre', 0, 3, 0.05, 'rebuild'],
    ['roads.bumps', 'Lombadas', 0, 3, 0.05, 'rebuild'],
  ] },
  { folder: 'Calçadas (pesos)', items: [
    ['sidewalk.concrete', 'Concreto', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.concrete_old', 'Concreto velho', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.ceramic_red', 'Cerâmica vermelha', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.caquinho', 'Caquinho', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.ladrilho', 'Ladrilho hidráulico', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.paver', 'Paver', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.grass_strip', 'Faixa de grama', 0, 5, 0.1, 'rebuild'],
    ['sidewalk.petitpave', 'Petit-pavé', 0, 5, 0.1, 'rebuild'],
  ] },
  { folder: 'Lotes', items: [
    ['lots.widthScale', 'Largura dos lotes', 0.5, 2, 0.01, 'rebuild'],
    ['lots.commercial', 'Comércio', 0, 4, 0.05, 'rebuild'],
    ['lots.vacant', 'Terrenos vazios', 0, 4, 0.05, 'rebuild'],
    ['lots.garage', 'Portões de garagem', 0, 1.4, 0.05, 'rebuild'],
    ['lots.genBuildings', 'Completar casas não mapeadas', null, null, null, 'rebuild'],
  ] },
  { folder: 'Muros (pesos)', items: [
    ['walls.heightScale', 'Altura dos muros', 0.4, 1.6, 0.01, 'rebuild'],
    ['walls.plaster_full', 'Rebocado', 0, 5, 0.1, 'rebuild'],
    ['walls.base_grille', 'Mureta + grade', 0, 5, 0.1, 'rebuild'],
    ['walls.grille', 'Só grade', 0, 5, 0.1, 'rebuild'],
    ['walls.block_raw', 'Bloco aparente', 0, 5, 0.1, 'rebuild'],
    ['walls.brick_raw', 'Tijolo baiano', 0, 5, 0.1, 'rebuild'],
    ['walls.stone_base', 'Base de pedra', 0, 5, 0.1, 'rebuild'],
    ['walls.low_wall', 'Muro baixo', 0, 5, 0.1, 'rebuild'],
    ['walls.electric', 'Cerca elétrica', 0, 5, 0.1, 'rebuild'],
    ['walls.concertina', 'Concertina', 0, 5, 0.1, 'rebuild'],
    ['walls.spikes', 'Lanças', 0, 5, 0.1, 'rebuild'],
    ['walls.glass', 'Caco de vidro', 0, 5, 0.1, 'rebuild'],
    ['walls.tags', 'Pichação', 0, 2.2, 0.05, 'rebuild'],
  ] },
  { folder: 'Edificações', items: [
    ['buildings.floorsScale', 'Andares (não mapeados)', 0.5, 3, 0.05, 'rebuild'],
    ['buildings.ceramic', 'Telhado cerâmico', 0, 5, 0.1, 'rebuild'],
    ['buildings.fibro', 'Fibrocimento', 0, 5, 0.1, 'rebuild'],
    ['buildings.flat', 'Laje', 0, 5, 0.1, 'rebuild'],
    ['buildings.waterTank', 'Caixas d\'água', 0, 1.6, 0.05, 'rebuild'],
    ['buildings.windowGrille', 'Grades nas janelas', 0, 1.4, 0.05, 'rebuild'],
    ['buildings.ac', 'Ar-condicionado', 0, 6, 0.1, 'rebuild'],
    ['buildings.litWindows', 'Janelas acesas à noite', 0, 3, 0.05, 'rebuild'],
  ] },
  { folder: 'Sujeira e desgaste', items: [
    ['grime.amount', 'Sujeira (camada)', 0, 2.5, 0.05, 'rebuild'],
    ['grime.weeds', 'Mato nas frestas', 0, 4, 0.05, 'rebuild'],
  ] },
  { folder: 'Mobiliário urbano', items: [
    ['props.poleSpacing', 'Distância entre postes (m)', 15, 80, 1, 'rebuild'],
    ['props.wires', 'Emaranhado de fios', 0, 3, 0.05, 'rebuild'],
    ['props.trees', 'Árvores', 0, 4, 0.05, 'rebuild'],
    ['props.trash', 'Lixo', 0, 4, 0.05, 'rebuild'],
    ['props.cacamba', 'Caçamba', 0, 3, 0.05, 'rebuild'],
    ['props.streetlightsOn', 'Postes acendem à noite', null, null, null, 'live'],
  ] },
  { folder: 'Câmera: instalação', items: [
    ['camera.mount', 'Montagem', MOUNTS, null, null, 'rebuild'],
    ['camera.quality', 'Apontamento', QUALITY, null, null, 'rebuild'],
    ['camera.height', 'Altura extra (m)', -2, 4, 0.05, 'live'],
    ['camera.yaw', 'Girar (graus)', -90, 90, 0.5, 'live'],
    ['camera.pitch', 'Inclinação (graus)', -45, 45, 0.5, 'live'],
    ['camera.roll', 'Rolagem (graus)', -15, 15, 0.1, 'live'],
  ] },
  { folder: 'Câmera: lente e sensor', items: [
    ['lens.hfov', 'FOV horizontal (0 = modelo)', 0, 125, 1, 'camera'],
    ['lens.distortion', 'Distorção barril (-1 = modelo)', -1, 0.45, 0.01, 'camera'],
    ['lens.focus', 'Foco (-1 = modelo)', -1, 1, 0.01, 'live'],
    ['lens.dirt', 'Sujeira na lente (-1 = modelo)', -1, 1, 0.01, 'camera'],
    ['lens.web', 'Teia de aranha', AUTO_YN, null, null, 'camera'],
    ['lens.visor', 'Viseira aparecendo', AUTO_YN, null, null, 'live'],
    ['isp.irMode', 'Modo noturno IR', { 'Automático': 'auto', 'Forçar cor': 'day', 'Forçar IR': 'ir' }, null, null, 'live'],
    ['isp.exposureBias', 'Compensação de exposição (EV)', -3, 3, 0.1, 'live'],
    ['isp.noise', 'Ruído (-1 = modelo)', -1, 4, 0.05, 'live'],
    ['isp.sharp', 'Nitidez (-1 = modelo)', -1, 3, 0.05, 'live'],
    ['isp.sat', 'Saturação (-1 = modelo)', -1, 2, 0.05, 'live'],
    ['isp.dwdr', 'DWDR (-1 = modelo)', -1, 1, 0.05, 'live'],
  ] },
  { folder: 'Imagem: antisserrilhado e cor', items: [
    ['tex.size', 'Resolução das texturas', { '32 px': 32, '64 px': 64, '128 px': 128, '256 px': 256, '512 px': 512, '1024 px': 1024 }, null, null, 'rebuild'],
    ['tex.filter', 'Filtro de textura', { 'Ponto (nearest)': 'nearest', 'Linear (sem mipmap)': 'linear', 'Bilinear': 'bilinear', 'Trilinear': 'trilinear' }, null, null, 'live'],
    ['tex.aniso', 'Anisotrópico', { 'Desligado': 1, '2x': 2, '4x': 4, '8x': 8, '16x': 16 }, null, null, 'live'],
    ['grade.fxaa', 'FXAA', { 'Sim': 'yes', 'Não': 'no' }, null, null, 'live'],
  ] },
  { folder: 'Câmera: gravação', items: [
    ['codec.codec', 'Codec', { 'Modelo': 'auto', 'H.264': 'H.264', 'H.265': 'H.265' }, null, null, 'camera'],
    ['codec.kbps', 'Bitrate kbps (0 = modelo)', 0, 8000, 32, 'camera'],
    ['codec.fps', 'FPS (0 = modelo)', 0, 30, 1, 'camera'],
    ['codec.gop', 'GOP em quadros (0 = modelo)', 0, 120, 1, 'camera'],
  ] },
];

export function getPath(obj, path) { return path.split('.').reduce((o, k) => o[k], obj); }

const STORE = 'cctv-sim-config-v1';
export function loadConfig() {
  const cfg = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) for (const g of Object.keys(cfg)) Object.assign(cfg[g], saved[g] || {});
  } catch { /* storage unavailable */ }
  return cfg;
}
export function saveConfig(cfg) {
  try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* storage unavailable */ }
}
export function resetConfig(cfg) {
  for (const g of Object.keys(DEFAULTS)) Object.assign(cfg[g], structuredClone(DEFAULTS[g]));
}

// weighted entries scaled by user multipliers: entries [[key, w]], mult {key: m}
export function scaled(entries, mult) {
  const out = entries.map(([k, w]) => [k, w * (mult?.[k] ?? 1)]);
  return out.some(e => e[1] > 0) ? out : entries;
}

// camera spec with user overrides applied
export function applySpecOverrides(spec, cfg) {
  const s = { ...spec };
  const { lens, isp, codec } = cfg;
  if (lens.hfov > 0) s.hfov = lens.hfov;
  if (lens.distortion >= 0) s.k = lens.distortion;
  if (lens.dirt >= 0) s.dirt = lens.dirt;
  if (lens.web !== 'auto') s.web = lens.web === 'yes';
  if (codec.codec !== 'auto') s.codec = codec.codec;
  if (codec.kbps > 0) s.kbps = codec.kbps;
  if (codec.fps > 0) s.fps = codec.fps;
  if (codec.gop > 0) s.gop = codec.gop; else if (codec.fps > 0) s.gop = Math.round(spec.gop / spec.fps * s.fps);
  return s;
}
