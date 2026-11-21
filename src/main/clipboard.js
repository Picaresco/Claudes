// Portapapeles: qué hay que pegar en la terminal.
//
// clipboard es el de Electron; dir() es la carpeta donde se guardan las imágenes
// pegadas; stamp() da la fecha y la hora para el nombre del archivo.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

function createClipboard({ clipboard, dir, stamp }) {
  // Una imagen copiada (una captura, «Copiar imagen» del navegador…) se guarda
  // como archivo para poder pegar su ruta, igual que un archivo arrastrado.
  function saveImage(buffer) {
    const now = stamp();
    fs.mkdirSync(dir(), { recursive: true });
    let file = path.join(dir(), `imagen-${now}.png`);
    for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir(), `imagen-${now}-${n}.png`);
    fs.writeFileSync(file, buffer);
    return file;
  }

  // Las imágenes pegadas ya viajaron con su mensaje: pasada una semana se borran.
  function cleanOld() {
    const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let names = [];
    try { names = fs.readdirSync(dir()); } catch { return; }
    for (const name of names) {
      const file = path.join(dir(), name);
      try { if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file); } catch { /* en uso */ }
    }
  }

  // Qué hay que pegar: archivos copiados en el Explorador, si no texto, si no una imagen.
  async function read() {
    const result = { files: [], text: '', imagePath: null };
    let items = [];
    try { items = await clipboard.read(); } catch { /* portapapeles vacío u ocupado */ }

    for (const item of items) {
      if (!item.types.includes('text/uri-list')) continue;
      try {
        const blob = await item.getType('text/uri-list');
        const list = Buffer.from(await blob.arrayBuffer()).toString('utf8');
        for (const line of list.split(/\r?\n/)) {
          const uri = line.trim();
          if (!/^file:/i.test(uri)) continue;
          try { result.files.push(fileURLToPath(uri)); } catch { /* URI que no es una ruta local */ }
        }
      } catch { /* formato no legible */ }
    }
    if (result.files.length) return result;

    try { result.text = await clipboard.readText(); } catch { /* sin texto */ }
    if (result.text) return result;

    for (const item of items) {
      if (!item.types.includes('image/png')) continue;
      try {
        const blob = await item.getType('image/png');
        result.imagePath = saveImage(Buffer.from(await blob.arrayBuffer()));
        break;
      } catch (err) {
        console.error('No se pudo guardar la imagen del portapapeles:', err.message);
      }
    }
    return result;
  }

  return { read, cleanOld };
}

module.exports = { createClipboard };
