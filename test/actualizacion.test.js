// La actualización completa, contra un servidor local que hace de GitHub, y el instalador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Updater, parseManifest, PACKAGE_DIR, EXE } = require('../src/main/updater');
const { tempDir, makeZip } = require('./helpers');

const windows = process.platform === 'win32'; // se descomprime con el tar.exe de Windows

test('parseManifest solo acepta un latest.json completo', () => {
  const good = { version: '1.2.3', file: 'ClaudHome-win32-x64.zip', size: 10, sha256: 'A'.repeat(64) };
  assert.deepEqual(parseManifest(good), { ...good, sha256: 'a'.repeat(64) });
  for (const bad of [null, {}, { ...good, version: 'última' }, { ...good, file: '../otro.zip' }, { ...good, file: 'x.exe' }, { ...good, sha256: 'abc' }, { ...good, size: 0 }]) {
    assert.equal(parseManifest(bad), null, JSON.stringify(bad));
  }
});

// Publica una versión falsa: latest.json y su zip. `tweak` permite estropearla.
async function publish(t, version, tweak = (m) => m) {
  const zip = makeZip({
    [`${PACKAGE_DIR}/${EXE}`]: 'programa nuevo',
    [`${PACKAGE_DIR}/resources/app.asar`]: 'código nuevo',
    [`${PACKAGE_DIR}/locales/es.pak`]: 'x'.repeat(5000),
  });
  const manifest = tweak({ version, file: 'ClaudHome-win32-x64.zip', size: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') });
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/latest/download/latest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } else if (req.url === `/download/v${version}/${manifest.file}`) {
      res.writeHead(200); // en dos trozos, para que haya avance que contar
      res.write(zip.subarray(0, 300));
      setTimeout(() => res.end(zip.subarray(300)), 20);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const before = process.env.CLAUDES_UPDATE_URL;
  process.env.CLAUDES_UPDATE_URL = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => { if (before === undefined) delete process.env.CLAUDES_UPDATE_URL; else process.env.CLAUDES_UPDATE_URL = before; });
  return { manifest, hits };
}

function makeUpdater(t, current = '1.0.0') {
  const base = tempDir(t);
  const installDir = path.join(base, 'programa');
  fs.mkdirSync(path.join(installDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'resources', 'app.asar'), 'código viejo');
  fs.writeFileSync(path.join(installDir, EXE), 'programa viejo');
  const states = [];
  const logs = [];
  const updater = new Updater({
    app: { getVersion: () => current, isPackaged: true, getPath: () => path.join(base, 'escritorio'), getAppPath: () => base },
    net: { fetch },
    shell: { readShortcutLink: () => { throw new Error('ilegible'); }, writeShortcutLink: (file) => { fs.writeFileSync(file, 'lnk'); return true; } },
    log: (text) => logs.push(text),
    logsDir: () => path.join(base, 'logs'),
    onChange: (info) => states.push(info),
    installDir,
    workDir: path.join(base, 'trabajo'),
  });
  return { updater, base, installDir, states, logs };
}

test('sin versión nueva (o sin ninguna publicada) no ofrece nada', async (t) => {
  await publish(t, '1.0.0');
  const { updater, logs } = makeUpdater(t, '1.0.0');
  assert.equal((await updater.check()).status, 'idle');
  process.env.CLAUDES_UPDATE_URL += 'no-existe/';
  assert.equal((await updater.check()).status, 'idle');
  assert.match(logs.join('\n'), /todavía no hay ninguna versión publicada/);
});

test('un latest.json incompleto se ignora', async (t) => {
  await publish(t, '2.0.0', (m) => ({ ...m, sha256: 'no-es-un-hash' }));
  const { updater, logs } = makeUpdater(t);
  assert.equal((await updater.check()).status, 'idle');
  assert.match(logs.join('\n'), /latest\.json incompleto/);
});

test('descarga, comprueba y deja lista la versión nueva', { skip: !windows }, async (t) => {
  const { hits } = await publish(t, '2.0.0');
  const { updater, base, states } = makeUpdater(t);
  let ready = null;
  updater.onReady = (info) => { ready = info; };
  const found = await updater.check();
  assert.equal(found.status, 'available');
  assert.equal(found.latest, '2.0.0');
  await updater.start();
  assert.equal(updater.info().status, 'ready', updater.info().error);
  assert.equal(ready.latest, '2.0.0');
  const built = path.join(base, 'trabajo', 'build', PACKAGE_DIR);
  assert.equal(updater.ready.dir, built);
  assert.equal(fs.readFileSync(path.join(built, EXE), 'utf8'), 'programa nuevo');
  assert.equal(fs.readFileSync(path.join(built, 'locales', 'es.pak'), 'utf8').length, 5000);
  assert.ok(!fs.existsSync(path.join(base, 'trabajo', 'ClaudHome-win32-x64.zip')), 'el zip se borra tras descomprimir');
  assert.ok(fs.existsSync(path.join(base, 'escritorio', 'ClaudHome.lnk')));
  assert.ok(states.some((s) => /^Descargando \(\d+ %\)$/.test(s.step)), 'avisa del avance de la descarga');
  assert.deepEqual(hits, ['/latest/download/latest.json', '/download/v2.0.0/ClaudHome-win32-x64.zip']);
  // Con la versión ya lista no vuelve a consultar ni a descargar.
  await updater.check();
  await updater.start();
  assert.equal(hits.length, 2);
  const log = fs.readFileSync(path.join(base, 'logs', fs.readdirSync(path.join(base, 'logs'))[0]), 'utf8');
  assert.match(log, /descarga comprobada \(tamaño y SHA-256\)/);
});

test('una descarga que no coincide con lo publicado no se instala', async (t) => {
  await publish(t, '2.0.0', (m) => ({ ...m, sha256: 'f'.repeat(64) }));
  const { updater, base } = makeUpdater(t);
  await updater.check();
  await updater.start();
  assert.equal(updater.info().status, 'error');
  assert.match(updater.info().error, /no coincide con la versión publicada/);
  assert.equal(updater.ready, null);
  assert.equal(updater.installOnQuit(), null);
  assert.ok(!fs.existsSync(path.join(base, 'trabajo', 'build')));
});

// ── El instalador (install-update.js), con el Node de las pruebas ──
const installer = path.join(__dirname, '..', 'src', 'main', 'install-update.js');

function installScene(t) {
  const base = tempDir(t);
  const target = path.join(base, 'Programa');
  const source = path.join(base, 'trabajo', 'nueva');
  for (const [dir, label] of [[target, 'viejo'], [source, 'nuevo']]) {
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, EXE), `programa ${label}`);
    fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), `código ${label}`);
  }
  const dead = spawnSync(process.execPath, ['-e', '']).pid; // un proceso que ya ha terminado
  const log = path.join(base, 'instalar.log');
  const run = (options = {}) => spawnSync(process.execPath, [installer, String(dead), source, target, EXE, log, '0', '5'], { encoding: 'utf8', ...options });
  return { base, target, source, log, run };
}

test('el instalador cambia la carpeta del programa y guarda la anterior', (t) => {
  const { target, source, log, run } = installScene(t);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(target, EXE), 'utf8'), 'programa nuevo');
  assert.equal(fs.readFileSync(path.join(target, 'resources', 'app.asar'), 'utf8'), 'código nuevo');
  assert.equal(fs.readFileSync(path.join(`${target}.anterior`, EXE), 'utf8'), 'programa viejo');
  assert.ok(!fs.existsSync(source));
  assert.match(fs.readFileSync(log, 'utf8'), /versión nueva instalada .*movida entera/);
});

test('si la carpeta nueva está en uso, el instalador la mueve pieza a pieza', { skip: !windows }, (t) => {
  // Windows no deja mover la carpeta de trabajo de un proceso en marcha: es lo que
  // pasa de verdad, porque el instalador corre con el Claudes.exe de la carpeta nueva.
  const { target, source, log, run } = installScene(t);
  assert.equal(run({ cwd: source }).status, 0);
  assert.equal(fs.readFileSync(path.join(target, EXE), 'utf8'), 'programa nuevo');
  assert.equal(fs.readFileSync(path.join(target, 'resources', 'app.asar'), 'utf8'), 'código nuevo');
  assert.equal(fs.readFileSync(path.join(`${target}.anterior`, EXE), 'utf8'), 'programa viejo');
  assert.match(fs.readFileSync(log, 'utf8'), /2 elementos movidos/);
});

test('sin versión nueva que poner, el instalador no toca el programa', (t) => {
  const { target, source, log, run } = installScene(t);
  fs.rmSync(source, { recursive: true });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(target, EXE), 'utf8'), 'programa viejo');
  assert.ok(!fs.existsSync(`${target}.anterior`));
  assert.match(fs.readFileSync(log, 'utf8'), /no está la versión nueva/);
});
