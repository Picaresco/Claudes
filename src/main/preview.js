// Vista previa de archivos para la tarjeta que aparece al pasar el ratón sobre
// una ruta o una imagen pegada: miniatura de las imágenes, primera página de los
// PDF, primeras líneas de los archivos de texto y, para lo demás, la miniatura
// que tenga Windows o el icono de su tipo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;
const PDF = /\.pdf$/i;
const TEXT = /\.(txt|md|markdown|csv|tsv|log|json|jsonl|xml|ya?ml|ini|cfg|conf|toml|env|js|mjs|cjs|ts|tsx|jsx|py|ps1|psm1|sh|bat|cmd|sql|html?|css|scss|less|c|h|cpp|hpp|cs|java|kt|go|rs|rb|php|vue|svelte|gitignore|gitattributes)$/i;
const THUMB = { width: 360, height: 360 };
const TEXT_BYTES = 2400;
const TEXT_LINES = 14;
const CACHE_SIZE = 200;

function createPreview({ app, nativeImage }) {
  const cache = new Map(); // «ruta|fecha|tamaño» → vista previa
  const remember = (key, value) => {
    cache.set(key, value);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return value;
  };
  // Se lanza como comando codificado: así no depende de la política de ejecución de scripts.
  const pdfCommand = Buffer.from(fs.readFileSync(path.join(__dirname, 'pdf-page.ps1'), 'utf8'), 'utf16le').toString('base64');
  const tempDir = () => path.join(app.getPath('temp'), 'Claudes-vista-previa');

  function renderPdf(file) {
    return new Promise((resolve) => {
      let png;
      try {
        fs.mkdirSync(tempDir(), { recursive: true });
        png = path.join(tempDir(), `${crypto.randomUUID()}.png`);
      } catch {
        resolve(null);
        return;
      }
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', pdfCommand], {
        env: { ...process.env, CLAUDES_PDF: file, CLAUDES_PNG: png, CLAUDES_PDF_WIDTH: '480' },
        windowsHide: true,
        timeout: 20000,
      }, (err, stdout) => {
        let result = null;
        if (!err) {
          const image = nativeImage.createFromPath(png);
          if (!image.isEmpty()) result = { image: image.toDataURL(), pages: Number.parseInt(stdout, 10) || null };
        }
        fs.rm(png, { force: true }, () => { /* ya no estaba */ });
        resolve(result);
      });
    });
  }

  function readText(file) {
    const buffer = Buffer.alloc(TEXT_BYTES);
    const fd = fs.openSync(file, 'r');
    let length = 0;
    try { length = fs.readSync(fd, buffer, 0, TEXT_BYTES, 0); } finally { fs.closeSync(fd); }
    const text = buffer.subarray(0, length).toString('utf8').replace(/^﻿/, '');
    if (text.includes('\u0000')) return null; // binario
    return text.split(/\r?\n/).slice(0, TEXT_LINES).map((line) => line.replace(/\t/g, '  ').slice(0, 160)).join('\n');
  }

  async function thumbnail(file) {
    try {
      const image = await nativeImage.createThumbnailFromPath(file, THUMB);
      return image.isEmpty() ? null : image;
    } catch {
      return null; // Windows no tiene miniatura para este archivo
    }
  }

  async function preview(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    let st;
    try { st = await fs.promises.stat(file); } catch { return null; }
    if (!st.isFile()) return null;
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (cache.has(key)) return cache.get(key);

    const result = {
      path: file, name: path.basename(file), ext: path.extname(file).slice(1).toUpperCase(), size: st.size,
      kind: 'icon', image: null, text: null, width: 0, height: 0, pages: null,
    };
    try {
      if (IMAGE.test(file)) {
        let image = await thumbnail(file);
        if (!image) {
          const full = nativeImage.createFromPath(file);
          if (!full.isEmpty()) image = full.resize({ width: Math.min(THUMB.width, full.getSize().width) });
        }
        if (image) { result.kind = 'image'; result.image = image.toDataURL(); }
        if (st.size < 40 * 1024 * 1024) {
          const full = nativeImage.createFromPath(file);
          if (!full.isEmpty()) ({ width: result.width, height: result.height } = full.getSize());
        }
      } else if (PDF.test(file)) {
        const page = await renderPdf(file);
        if (page) { result.kind = 'page'; result.image = page.image; result.pages = page.pages; }
      } else if (TEXT.test(file) && st.size > 0) {
        const text = readText(file);
        if (text !== null) { result.kind = 'text'; result.text = text; }
      }
      if (result.kind === 'icon') {
        const image = await thumbnail(file);
        if (image) { result.kind = 'image'; result.image = image.toDataURL(); }
      }
      if (!result.image && result.kind !== 'text') {
        const icon = await app.getFileIcon(file, { size: 'large' });
        if (!icon.isEmpty()) result.image = icon.toDataURL();
      }
    } catch {
      /* se muestra lo que se haya podido obtener */
    }
    return remember(key, result);
  }

  // De una lista de rutas candidatas, las que son archivos que existen.
  async function existing(list) {
    const found = [];
    if (!Array.isArray(list)) return found;
    for (const item of list.slice(0, 80)) {
      if (typeof item !== 'string' || item.length > 400 || !path.isAbsolute(item)) continue;
      try { if ((await fs.promises.stat(item)).isFile()) found.push(item); } catch { /* no existe */ }
    }
    return found;
  }

  // Lo que quede de una ejecución anterior que se cerrara a medias.
  function cleanTemp() {
    fs.rm(tempDir(), { recursive: true, force: true }, () => { /* en uso */ });
  }

  return { preview, existing, cleanTemp };
}

module.exports = { createPreview };
