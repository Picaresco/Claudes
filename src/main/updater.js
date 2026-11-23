// Actualización desde GitHub.
//
// Cada versión se publica en GitHub como un «release» con el ejecutable ya generado
// (lo hace .github/workflows/ci.yml al subir una versión nueva a main):
//   - ClaudHome-win32-x64.zip: la carpeta del programa;
//   - latest.json: { version, file, size, sha256 } de ese zip.
// La app consulta latest.json del último release. Si su versión es mayor que la
// instalada, la interfaz muestra el botón «Actualizar». Al pulsarlo se descarga el
// zip, se comprueba (tamaño y SHA-256), se descomprime con el tar.exe de Windows y se
// comprueba que haya un acceso directo en el escritorio. No hace falta Node.js.
// La carpeta del programa no se puede sustituir con Claudes abierto, así que al
// cerrarlo un instalador aparte (install-update.js, ejecutado por el Claudes.exe
// nuevo en modo Node) la cambia por la nueva, guardando la anterior como copia, y
// si se ha pedido reiniciar vuelve a abrirlo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { localStamp, clock } = require('./applog');

const REPO = 'Picaresco/Claudes';
const BRANCH = 'main';
const EXE = 'Claudes.exe'; // nombre que le da scripts/package.mjs
const PACKAGE_DIR = 'Claudes-win32-x64'; // carpeta que genera scripts/package.mjs y que va dentro del zip
const MANIFEST = 'latest.json';
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const STEP_TIMEOUT = 5 * 60 * 1000;
const IDLE_TIMEOUT = 60 * 1000; // descarga sin recibir nada

// Dónde están los releases. CLAUDES_UPDATE_URL lo cambia para las pruebas.
const releasesUrl = () => (process.env.CLAUDES_UPDATE_URL || `https://github.com/${REPO}/releases`).replace(/\/+$/, '');

// Lo que dice latest.json, si está completo y es de fiar; si no, null.
function parseManifest(data) {
  if (!data || typeof data !== 'object') return null;
  const version = String(data.version || '');
  const file = String(data.file || '');
  const sha256 = String(data.sha256 || '').toLowerCase();
  const size = Number(data.size);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[\w.-]+\.zip$/.test(file) || !/^[a-f0-9]{64}$/.test(sha256) || !(size > 0)) return null;
  return { version, file, sha256, size };
}

function versionParts(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
}

// > 0 si a es mayor que b, < 0 si es menor, 0 si son iguales.
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Secciones de CHANGELOG.md: «## X.Y.Z — fecha» seguido de un punto («- ») por cambio.
// Una línea sangrada continúa el punto anterior.
function parseChangelog(text) {
  const versions = [];
  let section = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const head = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—–-]+\s*(.*))?$/.exec(line.trim());
    if (head) {
      section = { version: head[1], date: (head[2] || '').trim(), items: [] };
      versions.push(section);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) { section = null; continue; }
    if (!section) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) section.items.push(item[1].trim());
    else if (/^\s{2,}\S/.test(line) && section.items.length) section.items[section.items.length - 1] += ` ${line.trim()}`;
  }
  return versions;
}


function tarExe() {
  const builtIn = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(builtIn) ? builtIn : 'tar.exe';
}

// Ejecuta un programa, copia su salida al registro y, si falla, devuelve un error
// con sus últimas líneas.
function run(label, file, args, { cwd, env, out }) {
  return new Promise((resolve, reject) => {
    out.write(`[${clock()}] $ ${[file, ...args].join(' ')}\n`);
    let tail = '';
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    const keep = (chunk) => {
      out.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya había salido */ }
      reject(new Error(`${label} ha tardado demasiado.`));
    }, STEP_TIMEOUT);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`${label}: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      const last = tail.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
      reject(new Error(`${label} ha fallado (código ${code})${last ? `: ${last.slice(0, 200)}` : ''}`));
    });
  });
}

class Updater {
  // onChange(info) se llama con cada cambio de estado; onReady(info) cuando la
  // versión nueva ya está descargada y solo falta cerrar Claudes para instalarla.
  // installDir y workDir solo se pasan en las pruebas.
  constructor({ app, net, shell, log, logsDir, onChange, onReady, installDir, workDir }) {
    this.app = app;
    this.net = net;
    this.shell = shell;
    this.log = log;
    this.logsDir = logsDir;
    this.onChange = onChange || (() => {});
    this.onReady = onReady || (() => {});
    // Solo para pruebas: fingir que la instalada es otra versión.
    this.fakeVersion = process.env.CLAUDES_UPDATE_FAKE_VERSION || null;
    this.current = this.fakeVersion || app.getVersion();
    // Desde el código no hay ejecutable que sustituir: solo se comprueba al probar.
    this.enabled = app.isPackaged || Boolean(this.fakeVersion);
    this.installDir = installDir || path.dirname(process.execPath);
    this.workDir = workDir || (process.env.CLAUDES_USER_DATA
      ? path.join(app.getPath('userData'), 'actualizacion')
      : path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'Claudes-update'));
    this.manifest = null; // latest.json del último release
    this.state = { status: 'idle', current: this.current, latest: null, step: '', error: '', result: null };
    this.ready = null; // { dir, version, logFile } con la versión nueva ya descomprimida
    this.relaunch = false; // al instalar, volver a abrir Claudes
  }

  info() {
    return { ...this.state };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.info());
  }

  // Resultado de la instalación que se dejó preparada al cerrar la vez anterior.
  noteAttempt(attempt) {
    if (!attempt || !attempt.version) return;
    const ok = compareVersions(this.app.getVersion(), attempt.version) >= 0;
    this.state.result = { ok, version: attempt.version, log: attempt.log || null };
    this.log(`actualización: ${ok ? `instalada la versión ${attempt.version}` : `no se ha instalado la versión ${attempt.version}`}`);
  }

  // Comprueba al poco de arrancar y después cada pocas horas.
  schedule() {
    if (!this.enabled) return;
    setTimeout(() => this.check(), 8000);
    setInterval(() => this.check(), CHECK_EVERY).unref();
    // Lo que quedara de una actualización anterior ya no sirve.
    setTimeout(() => {
      if (!['working', 'ready'].includes(this.state.status)) {
        fs.promises.rm(this.workDir, { recursive: true, force: true }).catch(() => { /* en uso */ });
      }
    }, 30000);
  }

  async check() {
    if (!this.enabled || ['working', 'ready'].includes(this.state.status)) return this.info();
    let manifest;
    try {
      const res = await this.net.fetch(`${releasesUrl()}/latest/download/${MANIFEST}`, { cache: 'no-store' });
      if (res.status === 404) throw new Error('todavía no hay ninguna versión publicada');
      if (!res.ok) throw new Error(`GitHub ha respondido ${res.status}`);
      manifest = parseManifest(await res.json());
      if (!manifest) throw new Error(`${MANIFEST} incompleto`);
    } catch (err) {
      this.log(`actualización: no se pudo consultar la versión publicada (${err.message})`);
      return this.info();
    }
    if (['working', 'ready'].includes(this.state.status)) return this.info();
    const latest = manifest.version;
    const available = compareVersions(latest, this.current) > 0;
    if (available && latest !== this.state.latest) this.log(`actualización: hay una versión nueva en GitHub (${latest}; instalada ${this.current})`);
    this.manifest = manifest;
    this.set({ status: available ? 'available' : 'idle', latest, error: '', step: '' });
    return this.info();
  }

  // Cambios de las versiones posteriores a la instalada, hasta la publicada, de la
  // más nueva a la más antigua. Desde el código se lee el CHANGELOG.md local.
  async changes() {
    const latest = this.state.latest;
    const result = { current: this.current, latest, versions: [], error: '' };
    let text;
    try {
      const local = path.join(this.app.getAppPath(), 'CHANGELOG.md');
      if (!this.app.isPackaged && fs.existsSync(local)) {
        text = fs.readFileSync(local, 'utf8');
      } else {
        const res = await this.net.fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/CHANGELOG.md`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`GitHub ha respondido ${res.status}`);
        text = await res.text();
      }
    } catch (err) {
      this.log(`actualización: no se pudo leer la lista de cambios (${err.message})`);
      result.error = 'No se ha podido descargar la lista de cambios.';
      return result;
    }
    result.versions = parseChangelog(text)
      .filter((v) => compareVersions(v.version, this.current) > 0 && (!latest || compareVersions(v.version, latest) <= 0))
      .sort((a, b) => compareVersions(b.version, a.version));
    return result;
  }

  // Descarga un archivo a disco. Devuelve lo recibido y su SHA-256.
  async download(url, file, onProgress) {
    const controller = new AbortController();
    let idle = null;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT); };
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let writeError = null;
    out.on('error', (err) => { writeError = err; });
    let received = 0;
    arm();
    try {
      const res = await this.net.fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`GitHub ha respondido ${res.status} al descargar la versión nueva.`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (writeError) throw writeError;
        arm();
        received += value.length;
        hash.update(value);
        // Si el disco va más lento que la red, se espera a que escriba (o a que falle),
        // quitando las dos esperas al terminar para no ir acumulándolas.
        if (!out.write(value)) {
          await new Promise((resolve) => {
            const done = () => { out.off('drain', done); out.off('error', done); resolve(); };
            out.once('drain', done);
            out.once('error', done);
          });
        }
        onProgress(received);
      }
      await new Promise((resolve) => out.end(resolve));
      if (writeError) throw writeError;
    } catch (err) {
      out.destroy();
      if (controller.signal.aborted) throw new Error('La descarga se ha quedado parada. Comprueba la conexión y vuelve a intentarlo.', { cause: err });
      throw err;
    } finally {
      clearTimeout(idle);
    }
    return { received, sha256: hash.digest('hex') };
  }

  // Descarga la versión nueva, la comprueba y la deja lista para instalar.
  async start() {
    if (['working', 'ready'].includes(this.state.status)) return;
    if (!this.app.isPackaged) {
      this.set({ status: 'error', error: 'La actualización solo funciona en el ClaudHome instalado, no al ejecutarlo desde el código.' });
      return;
    }
    if (!fs.existsSync(path.join(this.installDir, 'resources', 'app.asar'))) {
      this.set({ status: 'error', error: `No reconozco la carpeta del programa (${this.installDir}).` });
      return;
    }
    const manifest = this.manifest;
    if (!manifest || compareVersions(manifest.version, this.current) <= 0) {
      this.set({ status: 'error', error: 'No hay ninguna versión más nueva publicada.' });
      return;
    }

    this.set({ status: 'working', step: 'Preparando', error: '' });
    let out = null;
    let logFile = null;
    try {
      fs.mkdirSync(this.logsDir(), { recursive: true });
      logFile = path.join(this.logsDir(), `actualizacion-${localStamp()}.log`);
      out = fs.createWriteStream(logFile, { flags: 'a' });
      out.on('error', () => { /* sin registro, se sigue */ });
    } catch {
      out = { write() {}, end() {} };
    }
    const note = (text) => out.write(`[${clock()}] ${text}\n`);
    const step = (text) => {
      note(text);
      this.log(`actualización: ${text}`);
      this.set({ status: 'working', step: text, error: '' });
    };

    try {
      const { version } = manifest;
      note(`Claudes ${this.current} → ${version} · programa en ${this.installDir}`);

      step('Descargando');
      await fs.promises.rm(this.workDir, { recursive: true, force: true });
      await fs.promises.mkdir(this.workDir, { recursive: true });
      const zip = path.join(this.workDir, manifest.file);
      const url = `${releasesUrl()}/download/v${version}/${manifest.file}`;
      note(`${url} (${Math.round(manifest.size / 1024 / 1024)} MB)`);
      let shown = -1;
      const got = await this.download(url, zip, (received) => {
        const pct = Math.min(99, Math.floor((received / manifest.size) * 100));
        if (pct === shown) return;
        shown = pct;
        this.set({ status: 'working', step: `Descargando (${pct} %)`, error: '' });
      });
      if (got.received !== manifest.size || got.sha256 !== manifest.sha256) {
        note(`recibido: ${got.received} bytes, sha256 ${got.sha256}; esperado: ${manifest.size} bytes, sha256 ${manifest.sha256}`);
        throw new Error('La descarga no coincide con la versión publicada. Vuelve a intentarlo.');
      }
      note('descarga comprobada (tamaño y SHA-256)');

      step('Descomprimiendo');
      const outDir = path.join(this.workDir, 'build');
      await fs.promises.mkdir(outDir, { recursive: true });
      await run('La descompresión', tarExe(), ['-xf', zip, '-C', outDir], { cwd: this.workDir, env: process.env, out });
      const built = path.join(outDir, PACKAGE_DIR);
      const asar = path.join(built, 'resources', 'app.asar');
      if (!fs.existsSync(path.join(built, EXE)) || !fs.existsSync(asar)) throw new Error('La descarga no contiene el programa.');
      // Dentro de Electron se puede leer el package.json del app.asar descargado.
      let packed = null;
      try { packed = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8')).version; } catch { /* fuera de Electron no se puede leer */ }
      if (packed && packed !== version) throw new Error(`La descarga trae la versión ${packed} y se esperaba la ${version}.`);
      await fs.promises.rm(zip, { force: true });

      step('Comprobando el acceso directo del escritorio');
      try {
        const link = this.ensureShortcut();
        note(link.created ? `acceso directo creado: ${link.file}` : `acceso directo ya presente: ${link.file}`);
      } catch (err) {
        note(`AVISO: no se pudo comprobar el acceso directo (${err.message})`);
      }

      this.ready = { dir: built, version, logFile };
      note('versión nueva lista: se instalará al cerrar Claudes');
      this.log(`actualización: versión ${version} lista para instalar`);
      this.set({ status: 'ready', latest: version, step: '' });
      this.onReady(this.info());
    } catch (err) {
      note(`ERROR: ${err.message}`);
      this.log(`actualización: fallo (${err.message})`);
      this.set({ status: 'error', step: '', error: err.message });
    } finally {
      out.end();
    }
  }

  // Asegura que en el escritorio haya un acceso directo que abra este Claudes.
  ensureShortcut() {
    const desktop = process.env.CLAUDES_DESKTOP_DIR || this.app.getPath('desktop');
    const target = path.join(this.installDir, EXE);
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    let names = [];
    try { names = fs.readdirSync(desktop); } catch { /* sin escritorio todavía */ }
    for (const name of names) {
      if (!/\.lnk$/i.test(name)) continue;
      const file = path.join(desktop, name);
      try {
        if (same(this.shell.readShortcutLink(file).target, target)) return { file, created: false };
      } catch { /* acceso directo ilegible: se ignora */ }
    }
    fs.mkdirSync(desktop, { recursive: true });
    const file = path.join(desktop, 'ClaudHome.lnk');
    const ok = this.shell.writeShortcutLink(file, 'create', {
      target,
      cwd: this.installDir,
      icon: target,
      iconIndex: 0,
      appUserModelId: 'com.claudes.app',
      description: 'Sesiones de Claude Code en pestañas',
    });
    if (!ok) throw new Error(`Windows no ha creado ${file}`);
    return { file, created: true };
  }

  // Se llama justo antes de salir. Si hay una versión lista, lanza el instalador
  // (install-update.js) para que la ponga en su sitio en cuanto este proceso termine,
  // y devuelve lo que hay que recordar. Lo ejecuta el Claudes.exe nuevo en modo Node
  // (ELECTRON_RUN_AS_NODE): así no depende de que haya Node.js en el equipo.
  // PowerShell no sirve aquí: lanzado sin consola, como se lanzan los procesos
  // que sobreviven a quien los abre, no llega a ejecutarse.
  installOnQuit() {
    if (!this.ready) return null;
    const { dir, version, logFile } = this.ready;
    this.ready = null;
    try {
      // Fuera de app.asar, en un archivo suelto que el instalador pueda leer siempre.
      const script = path.join(this.workDir, 'instalar.js');
      fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'install-update.js')));
      const log = logFile || path.join(this.workDir, 'instalar.log');
      const child = spawn(path.join(dir, EXE), [
        script, String(process.pid), dir, this.installDir, EXE, log, this.relaunch ? '1' : '0',
      ], { cwd: this.workDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      this.log(`actualización: instalando ${version} al cerrar${this.relaunch ? ' y volviendo a abrir' : ''}`);
      return { version, from: this.current, log };
    } catch (err) {
      this.log(`actualización: no se pudo lanzar el instalador (${err.message})`);
      return null;
    }
  }
}

module.exports = { Updater, compareVersions, parseChangelog, parseManifest, PACKAGE_DIR, EXE, MANIFEST };
