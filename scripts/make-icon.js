// Genera build/icon.ico y build/icon.png a partir de build/icon-fuente.png (512 × 512, con las
// esquinas transparentes; la ilustración se hizo con Codex).
// Uso: npm run icon
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 64, 48, 32, 24, 16];

// Un .ico es una cabecera, una tabla de entradas y las imágenes (aquí, PNG) una tras otra.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(() => {
  const out = path.join(__dirname, '..', 'build');
  const source = nativeImage.createFromPath(path.join(out, 'icon-fuente.png'));
  if (source.isEmpty()) {
    console.error('Falta build/icon-fuente.png.');
    app.exit(1);
    return;
  }
  const base = source.resize({ width: 256, height: 256, quality: 'best' });
  const images = SIZES.map((size) => ({
    size,
    png: (size === 256 ? base : source.resize({ width: size, height: size, quality: 'best' })).toPNG(),
  }));
  fs.writeFileSync(path.join(out, 'icon.ico'), buildIco(images));
  fs.writeFileSync(path.join(out, 'icon.png'), base.toPNG());
  console.log('Icono generado en', out);
  app.quit();
});
