// Renders the PWA and browser icons from public/logo.svg and public/favicon.svg.
// Run: npm run icons -w web
// Phone/app icons put the symbol on the light-mode background (warm off-white #FBF8F5).
// Icons get versioned file names so phones, browsers and Cloudflare never keep an old copy.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const OFF_WHITE = '#FBF8F5';
const UI_FILL = 0.96; // share of logo.svg's square the symbol occupies

const logo = readFileSync(path.join(pub, 'logo.svg'), 'utf8');
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[\s\S]*?<\/title>/, '');

// symbolShare: how much of the icon the symbol itself covers.
// rounded: the app's own icon shape (the soft tile of the brand: 2/64 margin, corner radius 30 %
// of the tile) with transparent corners. Used where the system shows the icon as-is (desktop
// Chrome/Edge, Windows, some Android launchers). Full-bleed squares are only for iOS and the
// Android maskable icon, because those systems cut their own rounded shape.
function tile(size, symbolShare, rounded = false) {
  const box = (size * symbolShare) / UI_FILL;
  const off = (size - box) / 2;
  const m = (size * 2) / 64;
  const t = size - 2 * m;
  const bg = rounded
    ? `<rect x="${m}" y="${m}" width="${t}" height="${t}" rx="${t * 0.3}" fill="${OFF_WHITE}"/>`
    : `<rect width="${size}" height="${size}" fill="${OFF_WHITE}"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${bg}` +
      `<svg x="${off}" y="${off}" width="${box}" height="${box}" viewBox="0 0 256 256">${inner}</svg></svg>`,
  );
}

const png = (svg, size) => sharp(svg, { density: 600 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const icons = [
  ['pwa-any-192.png', tile(192, 0.6, true), 192],
  ['pwa-any-512.png', tile(512, 0.6, true), 512],
  ['pwa-maskable-512.png', tile(512, 0.54), 512],
  ['apple-touch-icon.png', tile(180, 0.66), 180],
];
for (const [name, svg, size] of icons) {
  writeFileSync(path.join(pub, name), await png(svg, size));
  console.log('wrote', name);
}

// favicon.ico (16, 32, 48) with PNG entries; 16 and 32 use the small-size cut in favicon.svg.
const fav = readFileSync(path.join(pub, 'favicon.svg'));
const entries = [
  [16, await png(fav, 16)],
  [32, await png(fav, 32)],
  [48, await png(Buffer.from(logo), 48)],
];
const head = Buffer.alloc(6 + 16 * entries.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(entries.length, 4);
let offset = head.length;
entries.forEach(([size, data], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(size, e);
  head.writeUInt8(size, e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(data.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(path.join(pub, 'favicon.ico'), Buffer.concat([head, ...entries.map(([, d]) => d)]));
console.log('wrote favicon.ico');

// Icon names used by earlier versions (old logo; square-cornered first version of the new one).
for (const old of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'pwa-192.png', 'pwa-512.png']) {
  rmSync(path.join(pub, old), { force: true });
}
