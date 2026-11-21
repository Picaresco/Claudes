// Ayudas comunes de las pruebas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// Carpeta temporal que se borra al terminar la prueba.
function tempDir(t, prefix = 'claudhome-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Un .zip mínimo con las entradas dadas ({ nombre: contenido }), comprimidas con deflate.
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw); // tar.exe la comprueba al descomprimir
    const file = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(file.length, 26);
    locals.push(local, file, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(file.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, file);
    offset += local.length + file.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Espera a que se cumpla una condición (para lo que llega por un evento).
async function waitFor(check, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('la condición no se ha cumplido a tiempo');
    await new Promise((r) => setTimeout(r, 10));
  }
}

module.exports = { tempDir, makeZip, waitFor };
