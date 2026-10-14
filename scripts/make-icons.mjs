// Generates the app + tray icons (a small agent-graph glyph) as PNGs, no dependencies.
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#16131f');
const LINE = hex('#5b5670');
const NODES = [
  { x: 0.5, y: 0.3, r: 0.13, c: hex('#b49cff') },
  { x: 0.2, y: 0.72, r: 0.1, c: hex('#f0956a') },
  { x: 0.5, y: 0.72, r: 0.1, c: hex('#7aa7ff') },
  { x: 0.8, y: 0.72, r: 0.1, c: hex('#6fd08c') },
];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function sample(u, v, withBg) {
  // returns [r,g,b,a] for a point in unit space
  let col = null;
  if (withBg) {
    const rr = 0.2, m = 0.02;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - rr), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - rr), 0);
    if (Math.hypot(qx, qy) <= rr) col = [...BG, 255];
  }
  const lw = withBg ? 0.03 : 0.05;
  for (const n of NODES.slice(1)) if (segDist(u, v, NODES[0].x, NODES[0].y, n.x, n.y) < lw) col = [...LINE, 255];
  for (const n of NODES) if (Math.hypot(u - n.x, v - n.y) < n.r * (withBg ? 1 : 1.25)) col = [...n.c, 255];
  return col ?? [0, 0, 0, 0];
}

function render(size, withBg) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, withBg);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      const i = (y * size + x) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / (ss * ss));
    }
  return png(size, buf);
}

fs.mkdirSync(path.join(root, 'build', 'tray'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(512, true));
fs.writeFileSync(path.join(root, 'build', 'tray', 'tray.png'), render(16, false));
fs.writeFileSync(path.join(root, 'build', 'tray', 'tray@2x.png'), render(32, false));
console.log('icons written to build/ and build/tray/');
