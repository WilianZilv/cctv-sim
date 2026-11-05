// Security cameras found on Brazilian streets, from DVR kits to decent IP cameras.
// hfov in degrees, kbps = typical main-stream setting left by installers.
// sensor: noise scale (1 = cheap 1/2.9" CMOS); starlight: low-light gain headroom;
// wdr: true (sensor) WDR strength; night: 'ir' | 'color' (white LED, ColorVu/Full Color);
// varifocal: hfov range the installer zoomed to.
export const TIERS = { budget: 'Entrada (kit DVR)', mid: 'Intermediária (IP)', pro: 'Boa (IP starlight/WDR)' };

export const CAMERA_MODELS = [
  // --- budget: HDCVI/AHD on a DVR
  { id: 'vhd1220b', tier: 'budget', name: 'Intelbras VHD 1220 B 3.6mm', res: [1920, 1080], hfov: 92, k: 0.16, irRange: 20, sensor: 1.0, sharp: 0.9, sat: 0.85, weight: 4, kbps: [[1024, 1], [1536, 1], [2048, 3], [3072, 1]] },
  { id: 'vhd1220d', tier: 'budget', name: 'Intelbras VHD 1220 D 2.8mm', res: [1920, 1080], hfov: 106, k: 0.24, irRange: 20, sensor: 1.0, sharp: 0.9, sat: 0.85, weight: 3, kbps: [[1024, 1], [1536, 1], [2048, 3], [3072, 1]] },
  { id: 'vhd1120b', tier: 'budget', name: 'Intelbras VHD 1120 B 720p', res: [1280, 720], hfov: 88, k: 0.15, irRange: 20, sensor: 1.4, sharp: 1.2, sat: 0.8, weight: 1.5, kbps: [[768, 1], [1024, 2], [1536, 1]] },
  { id: 'hik2ce', tier: 'budget', name: 'Hikvision DS-2CE16D0T 2.8mm', res: [1920, 1080], hfov: 103, k: 0.23, irRange: 20, sensor: 0.9, sharp: 0.8, sat: 0.95, weight: 2, kbps: [[1536, 1], [2048, 3], [3072, 1]] },
  { id: 'giga', tier: 'budget', name: 'Giga GS0270 2.6mm', res: [1920, 1080], hfov: 110, k: 0.28, irRange: 20, sensor: 1.3, sharp: 1.1, sat: 1.0, weight: 1, kbps: [[1024, 2], [2048, 2]] },
  { id: 'mibo', tier: 'budget', name: 'Intelbras Mibo iM5 (Wi-Fi)', res: [1920, 1080], hfov: 108, k: 0.22, irRange: 10, sensor: 1.1, sharp: 0.9, sat: 1.0, weight: 1.2, kbps: [[768, 1], [1024, 2], [1536, 1]] },
  { id: 'analog960h', tier: 'budget', name: 'Câmera analógica 960H (DVR antigo)', res: [960, 480], hfov: 80, k: 0.12, irRange: 15, sensor: 1.8, sharp: 1.4, sat: 0.7, weight: 0.3, analog: true, kbps: [[512, 1], [768, 1]] },

  // --- mid: plain IP cameras on an NVR
  { id: 'vip1230b', tier: 'mid', name: 'Intelbras VIP 1230 B G4 2.8mm', res: [1920, 1080], hfov: 103, k: 0.2, irRange: 30, sensor: 0.7, sharp: 0.65, sat: 0.95, weight: 3, kbps: [[2048, 2], [3072, 2], [4096, 1]] },
  { id: 'vip3430b', tier: 'mid', name: 'Intelbras VIP 3430 B 4MP 2.8mm', res: [2560, 1440], hfov: 100, k: 0.18, irRange: 30, sensor: 0.6, sharp: 0.55, sat: 1.0, weight: 3, wdr: 0.6, kbps: [[3072, 1], [4096, 3], [6144, 1]] },
  { id: 'hik1043', tier: 'mid', name: 'Hikvision DS-2CD1043G2-I 4MP', res: [2560, 1440], hfov: 98, k: 0.17, irRange: 30, sensor: 0.6, sharp: 0.55, sat: 1.0, weight: 2.5, kbps: [[3072, 1], [4096, 3], [6144, 1]] },
  { id: 'vip1230fc', tier: 'mid', name: 'Intelbras VIP 1230 B Full Color', res: [1920, 1080], hfov: 100, k: 0.2, irRange: 20, sensor: 0.6, sharp: 0.6, sat: 1.05, weight: 1.5, night: 'color', starlight: 2, kbps: [[2048, 2], [3072, 2]] },
  { id: 'dahua2441', tier: 'mid', name: 'Dahua IPC-HFW2441S WizSense 4MP', res: [2560, 1440], hfov: 98, k: 0.17, irRange: 30, sensor: 0.5, sharp: 0.5, sat: 1.0, weight: 2, wdr: 0.7, starlight: 3, kbps: [[4096, 3], [6144, 1]] },

  // --- pro: starlight sensors, real WDR, ColorVu, varifocal, 4K
  { id: 'vip5450z', tier: 'pro', name: 'Intelbras VIP 5450 Z 4MP varifocal', res: [2560, 1440], hfov: 70, varifocal: [32, 100], k: 0.06, irRange: 50, sensor: 0.4, sharp: 0.45, sat: 1.0, weight: 2, wdr: 0.85, starlight: 5, kbps: [[4096, 2], [6144, 2], [8192, 1]] },
  { id: 'hikcolorvu', tier: 'pro', name: 'Hikvision ColorVu DS-2CD2047G2 4MP F1.0', res: [2560, 1440], hfov: 92, k: 0.14, irRange: 40, sensor: 0.35, sharp: 0.45, sat: 1.05, weight: 2, wdr: 0.8, starlight: 8, night: 'color', kbps: [[4096, 2], [6144, 2]] },
  { id: 'hikacusense', tier: 'pro', name: 'Hikvision DS-2CD2043G2-IU AcuSense 4MP', res: [2560, 1440], hfov: 96, k: 0.15, irRange: 40, sensor: 0.4, sharp: 0.45, sat: 1.0, weight: 2, wdr: 0.85, starlight: 4, kbps: [[4096, 2], [6144, 2], [8192, 1]] },
  { id: 'hik4k', tier: 'pro', name: 'Hikvision DS-2CD2387G2 ColorVu 4K', res: [3840, 2160], hfov: 108, k: 0.18, irRange: 40, sensor: 0.4, sharp: 0.4, sat: 1.05, weight: 0.6, wdr: 0.85, starlight: 8, night: 'color', kbps: [[8192, 2], [12288, 1]] },
];

const TIER_WEIGHT = { budget: 0.4, mid: 0.38, pro: 0.22 };

const OSD_FORMATS = [
  { id: 'dmy-dow', pos: 'tl' },  // 22-10-2026 Qua 14:32:05
  { id: 'ymd', pos: 'tl' },      // 2026-10-22 14:32:05
  { id: 'dmy-slash', pos: 'tr' },// 22/10/2026 14:32:05
  { id: 'mdy-dow', pos: 'tl' },  // 10-22-2026 QUA 14:32:05 (DVR left in US format)
];
const NAMES = ['CAM 01', 'CAM 02', 'CAM 03', 'CAM 04', 'CAM1', 'CAM 5', 'FRENTE', 'RUA', 'GARAGEM', 'PORTAO', 'CALCADA', 'Camera 01', 'ENTRADA', 'D1', 'IPC'];

// tier: 'auto' picks by the population weights above
export function pickCamera(rng, tier = 'auto', modelId = 'auto') {
  const pool = tier === 'auto' ? CAMERA_MODELS : CAMERA_MODELS.filter(c => c.tier === tier);
  const forced = CAMERA_MODELS.find(c => c.id === modelId);
  const m = forced || rng.weighted(pool.map(c => [c, c.weight * (tier === 'auto' ? TIER_WEIGHT[c.tier] / tierSum(c.tier) : 1)]));
  const r = rng.fork('camsettings');
  const good = m.tier !== 'budget';
  const fps = good ? r.weighted([[15, 2], [20, 2], [25, 2], [30, 1]]) : r.weighted([[15, 4], [12, 2], [10, 1.5], [7, 0.6], [20, 1], [25, 0.8], [30, 0.6]]);
  const kbps = r.weighted(m.kbps);
  const fmt = r.pick(OSD_FORMATS);
  // fixed-lens models are sold with 2.8 to 12 mm lenses: the installer's pick, named
  // in the model. Weighted toward the longer ones: a camera watching a street from
  // across it frames the cars, not the whole block (plates stay readable)
  let hfov = m.hfov, name = m.name;
  if (m.varifocal) hfov = r.float(m.varifocal[0], m.varifocal[0] + (m.varifocal[1] - m.varifocal[0]) * 0.5);
  else if (!m.analog) {
    const own = +(m.name.match(/(\d\.\d)mm/)?.[1] || 2.8);
    const lens = r.weighted([[own, 2], [3.6, 2], [6, 2], [8, 0.7]]);
    if (lens !== own) {
      // same sensor: the field of view scales with the focal length
      const half = Math.atan(Math.tan(m.hfov * Math.PI / 360) * own / lens);
      hfov = Math.round(half * 360 / Math.PI);
      name = /\d\.\dmm/.test(m.name) ? m.name.replace(/\d\.\dmm/, lens.toFixed(1) + 'mm') : m.name + ' ' + lens.toFixed(1) + 'mm';
    }
  }
  return {
    ...m,
    name,
    hfov,
    fps,
    kbps: Math.round(kbps),
    gop: good ? r.pick([1, 2, 2]) * fps : r.pick([1, 2, 2, 4]) * fps,
    codec: good ? r.weighted([['H.264', 1], ['H.265', 3]]) : r.weighted([['H.264', 4], ['H.265', 1]]),
    osd: { fmt: fmt.id, pos: fmt.pos, name: r.pick(NAMES), namePos: r.pick(['br', 'bl', 'br']), scale: r.float(0.9, 1.25), showName: r.chance(0.85) },
    // installation and wear
    dirt: r.weighted([[r.float(0.0, 0.1), 5], [r.float(0.15, 0.35), 2], [r.float(0.5, 0.8), good ? 0.2 : 0.5]]),
    web: r.chance(good ? 0.06 : 0.12),
    visor: r.chance(0.15),             // sunshield edge intrudes on the top of the frame
    focus: m.varifocal ? 1 : r.weighted([[1, 9], [r.float(0.75, 0.92), good ? 0.3 : 1]]),
    wbError: [r.gauss(0, good ? 0.02 : 0.05), r.gauss(0, good ? 0.015 : 0.04)],
    timeOffset: r.weighted([[0, 3], [r.int(-9, 9) * 60, 1], [r.int(-90, 90) * 60, 0.4]]), // DVR clock drift
    // digital WDR on cheap cameras (halo-prone); true WDR cameras rely on the sensor instead
    dwdr: m.wdr ? 0 : r.chance(0.25) ? r.float(0.2, 0.5) : 0,
    wdr: m.wdr || 0,
    starlight: m.starlight || 1,
    irThreshold: r.float(6, 35) / (m.starlight || 1), // lux at the photocell where the IR-cut flips to night
    nightColor: m.night === 'color',
    gain: r.float(0.9, 1.15),
    analog: !!m.analog,
  };
}

function tierSum(t) { return CAMERA_MODELS.filter(c => c.tier === t).reduce((s, c) => s + c.weight, 0); }
