// Motorcycle rider poses from the GTA San Andreas install: node tools/bike-anims.mjs [gta dir]
// Reads (never writes) anim/anim.img (IMG v2) and writes assets/peds/bike.ifp with
// only the riding animations of each bike animation group (vehicles.ide):
//   bikes (sport: pcj600 fcr900 nrg500 copbike bf400), bikev (scooter: faggio
//   pizzaboy), bikeh (chopper: freeway), biked (dirt: sanchez), wayfarer
// -> <Group>_Ride, <Group>_Still, <Group>_passenger (clips in src/peds/model.js,
// riders in src/peds/rider.js).
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIFP, sliceIFP } from '../src/peds/ifp.js';

const GTA = process.argv[2] || 'D:/Jogos/GTA San Andreas';
const OUT = 'assets/peds/bike.ifp';
const FILES = ['bikes', 'bikev', 'bikeh', 'biked', 'wayfarer'];
const KEEP = /_(ride|still|passenger)$/i;

// IMG v2: "VER2", u32 entries; entry = u32 offset, u16 size, u16 size2 (sectors of 2048), char[24] name
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
    entries.set(dir.toString('latin1', o + 8, o + 32).replace(/\0.*$/s, '').toLowerCase(), { off: off * 2048, size: (s1 || s2) * 2048 });
  }
  return {
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

const img = openImg(join(GTA, 'anim/anim.img'));
const keep = [];
for (const f of FILES) {
  const buf = img.read(f + '.ifp');
  if (!buf) { console.warn('fora do anim.img:', f); continue; }
  for (const a of parseIFP(buf).anims) if (KEEP.test(a.name)) keep.push({ ...a, buf });
}
img.close();
writeFileSync(OUT, sliceIFP(null, keep, 'bike'));
console.log(`${keep.length} animações (${keep.map(a => a.name).join(' ')}) -> ${OUT}`);
