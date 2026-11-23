// Registro de depuración de la app.
//
// Con la depuración activada, cada sesión de Claude arranca con --debug-file y la app
// anota además su propia actividad (arranques, hooks, salidas, errores). Todo queda en
// <datos de la app>\logs y se borra solo pasada una semana.
const fs = require('fs');
const path = require('path');

const LOG_DAYS = 7;
const LOG_MAX_BYTES = 300 * 1024 * 1024;

const two = (n) => String(n).padStart(2, '0');
const dayStamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
// Fechas para nombres de archivo y líneas de registro: «20261123», «20261123-094512» y «09:45:12».
const localStamp = (d = new Date()) => `${dayStamp(d)}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

// Un nombre de pestaña convertido en algo que vale como nombre de archivo.
const safeFileName = (name) => (String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 40) || 'sesion');

// logsDir() da la carpeta de los registros. `enabled` se puede leer y cambiar.
function createAppLog(logsDir) {
  let enabled = true;
  let stream = null;
  let streamDay = '';

  // Una línea en el registro del día (claudes-<fecha>.log), con la hora local.
  function log(text) {
    if (!enabled) return;
    try {
      const now = new Date();
      const day = dayStamp(now);
      if (day !== streamDay) {
        if (stream) stream.end();
        fs.mkdirSync(logsDir(), { recursive: true });
        stream = fs.createWriteStream(path.join(logsDir(), `claudes-${day}.log`), { flags: 'a' });
        stream.on('error', () => { /* disco lleno o sin permiso: se sigue sin registro */ });
        streamDay = day;
      }
      const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
      stream.write(`${time} ${String(text).replace(/\r?\n/g, ' ⏎ ')}\n`);
    } catch { /* el registro nunca debe romper la app */ }
  }

  // Borra los registros de más de una semana y, si aun así ocupan demasiado, los más antiguos.
  function clean() {
    let files;
    try {
      files = fs.readdirSync(logsDir())
        .filter((name) => name.endsWith('.log'))
        .map((name) => { const file = path.join(logsDir(), name); const st = fs.statSync(file); return { file, mtime: st.mtimeMs, size: st.size }; })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return; }
    const limit = Date.now() - LOG_DAYS * 24 * 60 * 60 * 1000;
    let total = 0;
    for (const entry of files) {
      total += entry.size;
      if (entry.mtime < limit || total > LOG_MAX_BYTES) {
        try { fs.unlinkSync(entry.file); } catch { /* en uso */ }
      }
    }
  }

  return {
    log,
    clean,
    get enabled() { return enabled; },
    set enabled(value) { enabled = Boolean(value); },
  };
}

module.exports = { createAppLog, dayStamp, localStamp, clock, safeFileName };
