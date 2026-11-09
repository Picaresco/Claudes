// Genera build/icon.ico y build/icon.png a partir del dibujo de abajo.
// Uso: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="52" fill="#14171C" stroke="#3A414D" stroke-width="4"/>
  <path d="M56 100h52l16-28h76v112H56z" fill="none" stroke="#E7E9EC" stroke-width="14" stroke-linejoin="round"/>
  <path d="M56 130h144" stroke="#E7E9EC" stroke-width="14"/>
  <path d="M84 147l15 10-15 10" fill="none" stroke="#FF8A65" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256, height: 256, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const page = `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const shot = await win.webContents.capturePage();
  if (shot.isEmpty()) {
    console.error('No se pudo dibujar el icono.');
    app.exit(1);
    return;
  }
  const base = shot.resize({ width: 256, height: 256, quality: 'best' });
  const images = SIZES.map((size) => ({
    size,
    png: (size === 256 ? base : base.resize({ width: size, height: size, quality: 'best' })).toPNG(),
  }));
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.ico'), buildIco(images));
  fs.writeFileSync(path.join(out, 'icon.png'), base.toPNG());
  console.log('Icono generado en', out);
  app.quit();
});
