// Pedestrians from the GTA San Andreas install: node tools/peds-extract.mjs [gta dir]
// Reads (never writes) models/gta3.img (IMG v2), data/peds.ide and anim/ped.ifp,
// and writes to assets/peds/:
//   models/<name>.dff, models/<txd>.txd   a selection of everyday civilians
//   ped.ifp                               only the animations the peds use
//   peds.json                             [{ name, txd, sex, walk, idle }]
// so the browser never touches the 1 GB archive.
import { openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseIFP, sliceIFP } from '../src/peds/ifp.js';

const GTA = process.argv[2] || 'D:/Jogos/GTA San Andreas';
const OUT = 'assets/peds';

// everyday civilians: street clothes, no police, gangs, criminals, beachwear,
// skaters or joggers. Their own walk style comes from the animation group.
const PICK = `
  bmori bmost bmyri wmyst wmyri wmori wmost hmori hmost hmyri hmyst omori omost omyri
  omyst wmybu sbmyst swmyst somyst sbmori swmori wmyclot wmyva dwmolc1 bmochil wmymech
  cwmyfr wmyconb sbmost swmost
  bfori bfyri bfyst hfori hfyri hfyst ofori ofyri ofyst wfori wfyri wfyst sbfori swfyri
  sofyst wfyclot bfybu wfybu sofori sbfost`.trim().split(/\s+/);

// animation group (peds.ide) -> walk and idle clips of the "ped" block (animgrp.dat)
const GROUPS = {
  man: ['walk_civi', 'idle_stance'], oldman: ['walk_old', 'idlestance_old'],
  gang1: ['walk_civi', 'idle_stance'], gang2: ['walk_civi', 'idle_stance'],
  woman: ['woman_walknorm', 'woman_idlestance'], busywoman: ['woman_walkbusy', 'woman_idlestance'],
  sexywoman: ['woman_walksexy', 'woman_idlestance'], oldwoman: ['woman_walkold', 'woman_idlestance'],
  oldfatwoman: ['woman_walkfatold', 'woman_idlestance'], shopping: ['woman_walkshop', 'woman_idlestance'],
};
// every ped can also borrow these (variety, waiting at the kerb)
const EXTRA = ['walk_civi', 'walk_old', 'woman_walknorm', 'woman_walkshop', 'idle_stance', 'woman_idlestance', 'roadcross', 'roadcross_female'];

// ---- IMG v2: "VER2", u32 entries; entry = u32 offset, u16 size, u16 size2 (sectors), char[24] name
function openImg(path) {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(8);
  readSync(fd, head, 0, 8, 0);
  if (head.toString('latin1', 0, 4) !== 'VER2') throw new Error('IMG não é VER2: ' + path);
  const n = head.readUInt32LE(4);
  const dir = Buffer.alloc(n * 32);
  readSync(fd, dir, 0, dir.length, 8);
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    const off = dir.readUInt32LE(o), s1 = dir.readUInt16LE(o + 4), s2 = dir.readUInt16LE(o + 6);
    const name = dir.toString('latin1', o + 8, o + 32).replace(/\0.*$/s, '').toLowerCase();
    entries.set(name, { off: off * 2048, size: (s1 || s2) * 2048 });
  }
  return {
    entries,
    read(name) {
      const e = entries.get(name.toLowerCase());
      if (!e) return null;
      const b = Buffer.alloc(e.size);
      readSync(fd, b, 0, e.size, e.off);
      return b;
    },
    close() { closeSync(fd); },
  };
}

// ---- peds.ide: id, model, txd, type, stat, animgroup, ...
const ide = new Map();
let inPeds = false;
for (const raw of readFileSync(join(GTA, 'data/peds.ide'), 'latin1').split(/\r?\n/)) {
  const line = raw.replace(/#.*/, '').trim();
  if (line === 'peds') { inPeds = true; continue; }
  if (line === 'end') { inPeds = false; continue; }
  if (!inPeds || !line) continue;
  const f = line.split(',').map(s => s.trim());
  if (f.length < 6) continue;
  ide.set(f[1].toLowerCase(), { model: f[1].toLowerCase(), txd: f[2].toLowerCase(), type: f[3], group: f[5].toLowerCase() });
}

mkdirSync(join(OUT, 'models'), { recursive: true });
const img = openImg(join(GTA, 'models/gta3.img'));
// a few trimmed files: DFF/TXD sizes come rounded up to whole sectors; RW files
// know their own length (first chunk header), so the padding is cut off
const trim = (b) => b.subarray(0, Math.min(b.length, b.readUInt32LE(4) + 12));
const list = [];
const anims = new Set(EXTRA);
for (const name of PICK) {
  const d = ide.get(name);
  if (!d) { console.warn('fora do peds.ide:', name); continue; }
  const dff = img.read(d.model + '.dff'), txd = img.read(d.txd + '.txd');
  if (!dff || !txd) { console.warn('fora do gta3.img:', name); continue; }
  const [walk, idle] = GROUPS[d.group] || GROUPS[d.type === 'CIVFEMALE' ? 'woman' : 'man'];
  anims.add(walk); anims.add(idle);
  writeFileSync(join(OUT, 'models', d.model + '.dff'), trim(dff));
  writeFileSync(join(OUT, 'models', d.txd + '.txd'), trim(txd));
  list.push({ name: d.model, txd: d.txd, sex: d.type === 'CIVFEMALE' ? 'f' : 'm', group: d.group, walk, idle });
}
img.close();

const ifpBuf = readFileSync(join(GTA, 'anim/ped.ifp'));
const pkg = parseIFP(ifpBuf);
const keep = pkg.anims.filter(a => anims.has(a.name.toLowerCase()));
const missing = [...anims].filter(n => !keep.some(a => a.name.toLowerCase() === n));
if (missing.length) console.warn('animações ausentes:', missing.join(' '));
writeFileSync(join(OUT, 'ped.ifp'), sliceIFP(ifpBuf, keep, 'ped'));
writeFileSync(join(OUT, 'peds.json'), JSON.stringify(list, null, 1));
console.log(`${list.length} peds, ${keep.length} animações (${keep.map(a => a.name).join(' ')}) -> ${OUT}`);
