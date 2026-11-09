// Guardado en disco del estado de la app (pestañas, recientes, ventana).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // primera vez: aún no hay archivo
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.data = parsed;
    } catch {
      // Archivo dañado: se aparta para no pisarlo y se empieza de cero.
      try { fs.copyFileSync(this.file, this.file.replace(/\.json$/, '.corrupt.json')); } catch { /* sin copia */ }
    }
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('No se pudo guardar el estado:', err.message);
    }
  }
}

module.exports = { Store };
