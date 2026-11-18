// Actualización desde GitHub.
//
// Compara la versión de package.json en la rama main del repositorio con la
// instalada. Si la publicada es mayor, la interfaz muestra el botón «Actualizar».
// Al pulsarlo se descarga el código, se instalan sus dependencias (npm ci), se
// genera el ejecutable con scripts/package.mjs y se comprueba que haya un acceso
// directo en el escritorio. La carpeta del programa no se puede sustituir con
// Claudes abierto, así que al cerrarlo un instalador aparte (install-update.js)
// la cambia por la nueva, guardando la anterior como copia, y si se ha pedido
// reiniciar vuelve a abrirlo.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = 'Picaresco/Claudes';
const BRANCH = 'main';
const EXE = 'Claudes.exe'; // nombre que le da scripts/package.mjs
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const STEP_TIMEOUT = 15 * 60 * 1000;
const MIN_NODE = '22.12.0'; // lo que pide @electron/packager

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

const two = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

function findNode() {
  try {
    const out = execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true });
    const found = out.split(/\r?\n/).map((s) => s.trim()).find((p) => /node\.exe$/i.test(p) && fs.existsSync(p));
    if (found) return found;
  } catch { /* no está en el PATH */ }
  const guess = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
  return fs.existsSync(guess) ? guess : null;
}

function tarExe() {
  const builtIn = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(builtIn) ? builtIn : 'tar.exe';
}

// Entorno para npm y el empaquetado: sin lo que Electron pueda haber dejado y sin
// bajar el binario de Electron a node_modules (el empaquetador usa su propia caché).
function buildEnv() {
  const env = {
    ...process.env,
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
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
  // versión nueva ya está generada y solo falta cerrar Claudes para instalarla.
  constructor({ app, net, shell, log, logsDir, onChange, onReady }) {
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
    this.installDir = path.dirname(process.execPath);
    this.workDir = process.env.CLAUDES_USER_DATA
      ? path.join(app.getPath('userData'), 'actualizacion')
      : path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'Claudes-update');
    this.state = { status: 'idle', current: this.current, latest: null, step: '', error: '', result: null };
    this.ready = null; // { dir, version, logFile } con la versión nueva ya generada
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
    let latest;
    try {
      const res = await this.net.fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GitHub ha respondido ${res.status}`);
      latest = (await res.json()).version;
      if (!latest) throw new Error('package.json sin versión');
    } catch (err) {
      this.log(`actualización: no se pudo consultar la versión publicada (${err.message})`);
      return this.info();
    }
    if (['working', 'ready'].includes(this.state.status)) return this.info();
    const available = compareVersions(latest, this.current) > 0;
    if (available && latest !== this.state.latest) this.log(`actualización: hay una versión nueva en GitHub (${latest}; instalada ${this.current})`);
    this.set({ status: available ? 'available' : 'idle', latest, error: '', step: '' });
    return this.info();
  }

  // Descarga, genera el ejecutable y deja la versión nueva lista para instalar.
  async start() {
    if (['working', 'ready'].includes(this.state.status)) return;
    if (!this.app.isPackaged) {
      this.set({ status: 'error', error: 'La actualización solo funciona en el Claudes instalado, no al ejecutarlo desde el código.' });
      return;
    }
    if (!fs.existsSync(path.join(this.installDir, 'resources', 'app.asar'))) {
      this.set({ status: 'error', error: `No reconozco la carpeta del programa (${this.installDir}).` });
      return;
    }

    this.set({ status: 'working', step: 'Preparando', error: '' });
    let out = null;
    let logFile = null;
    try {
      fs.mkdirSync(this.logsDir(), { recursive: true });
      logFile = path.join(this.logsDir(), `actualizacion-${stamp()}.log`);
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
      note(`Claudes ${this.current} → ${this.state.latest || '?'} · programa en ${this.installDir}`);
      const node = findNode();
      if (!node) throw new Error('Para actualizar hace falta Node.js instalado (no encuentro «node»).');
      const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
      if (compareVersions(nodeVersion, MIN_NODE) < 0) throw new Error(`Para generar el ejecutable hace falta Node.js ${MIN_NODE} o posterior (tienes ${nodeVersion}).`);
      const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(npmCli)) throw new Error(`No encuentro npm junto a Node.js (${npmCli}).`);
      note(`node ${nodeVersion} en ${node}`);

      step('Descargando el código de GitHub');
      await fs.promises.rm(this.workDir, { recursive: true, force: true });
      await fs.promises.mkdir(this.workDir, { recursive: true });
      const res = await this.net.fetch(`https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GitHub ha respondido ${res.status} al descargar el código.`);
      const zip = path.join(this.workDir, 'codigo.zip');
      await fs.promises.writeFile(zip, Buffer.from(await res.arrayBuffer()));

      step('Descomprimiendo');
      await run('La descompresión', tarExe(), ['-xf', zip, '-C', this.workDir], { cwd: this.workDir, env: process.env, out });
      const folder = fs.readdirSync(this.workDir, { withFileTypes: true })
        .find((d) => d.isDirectory() && fs.existsSync(path.join(this.workDir, d.name, 'package.json')));
      if (!folder) throw new Error('El código descargado no tiene package.json.');
      const src = path.join(this.workDir, folder.name);
      const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
      if (compareVersions(version, this.current) <= 0) throw new Error(`La versión descargada (${version}) no es más nueva que la instalada (${this.current}).`);
      note(`versión descargada: ${version}`);

      const env = buildEnv();
      step('Instalando dependencias');
      await run('npm ci', node, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd: src, env, out });

      step('Generando el ejecutable');
      const outDir = path.join(this.workDir, 'build');
      await run('El empaquetado', node, [path.join('scripts', 'package.mjs'), outDir], { cwd: src, env, out });
      const built = path.join(outDir, 'Claudes-win32-x64');
      if (!fs.existsSync(path.join(built, EXE)) || !fs.existsSync(path.join(built, 'resources', 'app.asar'))) {
        throw new Error('El empaquetado no ha generado el ejecutable.');
      }

      step('Comprobando el acceso directo del escritorio');
      try {
        const link = this.ensureShortcut();
        note(link.created ? `acceso directo creado: ${link.file}` : `acceso directo ya presente: ${link.file}`);
      } catch (err) {
        note(`AVISO: no se pudo comprobar el acceso directo (${err.message})`);
      }

      this.ready = { dir: built, version, logFile, node };
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
    const file = path.join(desktop, 'Claudes.lnk');
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
  // (install-update.js, con el node.exe del sistema) para que la ponga en su sitio
  // en cuanto este proceso termine, y devuelve lo que hay que recordar.
  // PowerShell no sirve aquí: lanzado sin consola, como se lanzan los procesos
  // que sobreviven a quien los abre, no llega a ejecutarse.
  installOnQuit() {
    if (!this.ready) return null;
    const { dir, version, logFile, node } = this.ready;
    this.ready = null;
    try {
      // Fuera de app.asar: el node.exe del sistema no puede leer dentro de él.
      const script = path.join(this.workDir, 'instalar.js');
      fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'install-update.js')));
      const log = logFile || path.join(this.workDir, 'instalar.log');
      const child = spawn(node, [
        script, String(process.pid), dir, this.installDir, EXE, log, this.relaunch ? '1' : '0',
      ], { cwd: this.workDir, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      this.log(`actualización: instalando ${version} al cerrar${this.relaunch ? ' y volviendo a abrir' : ''}`);
      return { version, from: this.current, log };
    } catch (err) {
      this.log(`actualización: no se pudo lanzar el instalador (${err.message})`);
      return null;
    }
  }
}

module.exports = { Updater, compareVersions };
