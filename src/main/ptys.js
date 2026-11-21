// Procesos de terminal de las pestañas (la sesión de Claude y la terminal extra).
//
// pty es node-pty; send(canal, …) avisa a la interfaz; log(texto) anota en el registro
// de la app; label(id) da el nombre de la pestaña para ese registro.
function createPtys({ pty, send, log, label }) {
  const ptys = new Map(); // id → { proc, killed, waiters, buffer, timer }

  function spawn(id, file, args, options) {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(options.cols | 0, 20),
      rows: Math.max(options.rows | 0, 5),
      cwd: options.cwd,
      env: options.env,
    });
    const entry = { proc, killed: false, waiters: [], buffer: '', timer: null };
    ptys.set(id, entry);

    const flush = () => {
      entry.timer = null;
      if (!entry.buffer) return;
      const data = entry.buffer;
      entry.buffer = '';
      send('pty:data', id, data);
    };
    // La salida se agrupa unos milisegundos para no saturar la interfaz.
    proc.onData((data) => {
      entry.buffer += data;
      if (!entry.timer) entry.timer = setTimeout(flush, 4);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(entry.timer);
      flush();
      if (ptys.get(id) === entry) ptys.delete(id);
      log(`proceso de ${label(id)} termina con código ${exitCode}${entry.killed ? ' (cerrado por la app)' : ''}`);
      entry.waiters.forEach((done) => done());
      if (!entry.killed) send('pty:exit', id, exitCode);
    });
    return entry;
  }

  // Termina un proceso y espera a que haya salido (o a un máximo de 2 s).
  function kill(id) {
    const entry = ptys.get(id);
    if (!entry) return Promise.resolve();
    entry.killed = true;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      entry.waiters.push(() => { clearTimeout(timer); resolve(); });
      try { entry.proc.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }

  function killAll() {
    for (const entry of ptys.values()) {
      entry.killed = true;
      try { entry.proc.kill(); } catch { /* ya había salido */ }
    }
    ptys.clear();
  }

  // Lo que se teclea en la terminal.
  function write(id, data) {
    const entry = ptys.get(id);
    if (entry && typeof data === 'string') entry.proc.write(data);
  }

  function resize(id, cols, rows) {
    const entry = ptys.get(id);
    if (!entry || !(cols >= 2) || !(rows >= 1)) return;
    try { entry.proc.resize(cols | 0, rows | 0); } catch { /* el proceso acaba de salir */ }
  }

  return { spawn, kill, killAll, write, resize, has: (id) => ptys.has(id) };
}

module.exports = { createPtys };
