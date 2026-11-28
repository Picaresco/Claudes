// SuperPowers con Codex (src/main/git-init.js): si la carpeta no tiene git, uno local con una foto
// de partida para que Codex pueda revisar; nunca en carpetas generales, de red o con otro repo dentro.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tempDir } = require('./helpers');
const { findGit } = require('../src/main/secrets');
const { ensureRepo, unsuitable, inside, literal, MARK } = require('../src/main/git-init');

const git = findGit();
const noGit = git ? false : 'git no está instalado';
// Las claves de prueba se montan al ejecutar: así este archivo no dispara el aviso de claves.
const fakeKey = () => `sk-ant-${'Ab3'.repeat(12)}`;
const run = (cwd, ...args) => execFileSync(git, args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

// Un proyecto de prueba fuera de las carpetas generales (env y home de mentira).
function project(t, files) {
  const base = tempDir(t);
  const dir = path.join(base, 'web');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.mkdirSync(dir, { recursive: true });
  const opts = { hooksDir: path.join(base, 'sin-hooks'), env: {}, home: path.join(base, 'casa'), drives: async () => [] };
  return { base, dir, opts };
}

test('no en la raíz de un disco, la carpeta del usuario, las generales, el sistema, OneDrive ni la red', () => {
  const home = path.resolve('/Usuarios/ana');
  const env = { OneDrive: path.join(home, 'OneDrive - Clinica'), SystemRoot: path.resolve('/Windows'), ProgramFiles: path.resolve('/Program Files'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  const why = (dir) => unsuitable(path.resolve(dir), env, home);
  assert.match(why('/'), /raíz/);
  assert.match(why(home), /usuario/);
  assert.match(why(path.join(home, 'Documents')), /general/);
  assert.match(why(path.join(home, 'Escritorio')), /general/);
  assert.match(why(path.join(home, 'OneDrive - Clinica', 'web')), /OneDrive/);
  assert.match(why(path.join(home, 'AppData', 'Local', 'Temp', 'x')), /sistema/);
  assert.match(why(path.resolve('/Program Files/App')), /sistema/);
  assert.match(unsuitable('\\\\servidor\\proyectos\\web', env, home), /red/);
  assert.equal(why(path.join(home, 'Documents', 'web')), null); // un proyecto dentro de Documentos, sí
  assert.equal(why(path.join(home, 'proyectos', 'web')), null);
  assert.equal(inside(path.join(home, 'OneDriveX'), path.join(home, 'OneDrive')), false); // por componentes, no por texto
});

test('un nombre de archivo raro se deja fuera tal cual (sin comodines)', () => {
  assert.equal(literal('conf/clave [1].json'), '/conf/clave\\ \\[1\\].json');
  assert.equal(literal('#notas!.txt'), '/\\#notas\\!.txt');
});

test('crea el git con la foto de partida: sin lo pesado, sin claves y sin tocar el proyecto', { skip: noGit }, async (t) => {
  const { base, dir, opts } = project(t, {
    'index.js': 'console.log(1);\n',
    'src/calc.js': 'module.exports = (a, b) => a + b;\n',
    'node_modules/x/index.js': 'module.exports = 1;\n',
    '.env': 'CLAVE=1\n',
    'config.js': `module.exports = { key: "${fakeKey()}" };\n`,
  });
  // Un GIT_DIR heredado no puede mandar git a otra parte.
  const elsewhere = path.join(base, 'otro');
  fs.mkdirSync(elsewhere);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = elsewhere;
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  const result = await ensureRepo(dir, opts);
  delete process.env.GIT_DIR;
  assert.equal(result.state, 'created');
  assert.equal(result.files, 2);
  assert.deepEqual(result.excluded, ['config.js']);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(run(dir, 'ls-files').split('\n').sort(), ['index.js', 'src/calc.js']);
  assert.equal(run(dir, 'log', '-1', '--format=%an <%ae>'), 'ClaudHome <claudhome@localhost>');
  assert.equal(run(dir, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(run(dir, 'remote'), ''); // sin remoto: nada sale del equipo
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false); // las exclusiones van en .git/info/exclude
  assert.equal(fs.existsSync(path.join(dir, '.git', MARK)), true);
  assert.equal(run(dir, 'status', '--porcelain'), ''); // lo de fuera no aparece como cambio
  // Un cambio de Claude sí aparece: es lo que revisará Codex.
  fs.appendFileSync(path.join(dir, 'src', 'calc.js'), '// cambio\n');
  assert.equal(run(dir, 'status', '--porcelain'), 'M src/calc.js');
  // La segunda vez ya es un repositorio.
  assert.equal((await ensureRepo(dir, opts)).state, 'exists');
});

test('una carpeta vacía también tiene su punto de partida', { skip: noGit }, async (t) => {
  const { dir, opts } = project(t, {});
  const result = await ensureRepo(dir, opts);
  assert.equal(result.state, 'created');
  assert.equal(run(dir, 'rev-list', '--count', 'HEAD'), '1');
});

test('con otro repositorio dentro o demasiado grande no se crea, y no queda nada a medias', { skip: noGit }, async (t) => {
  const nested = project(t, { 'a.js': '1\n', 'lib/b.js': '2\n' });
  run(path.join(nested.dir, 'lib'), 'init', '-q');
  const one = await ensureRepo(nested.dir, nested.opts);
  assert.equal(one.state, 'skipped');
  assert.match(one.reason, /otro repositorio git \(lib\)/);
  assert.equal(fs.existsSync(path.join(nested.dir, '.git')), false);

  const big = project(t, { 'a.js': '1\n', 'b.js': '2\n', 'c.js': '3\n' });
  const two = await ensureRepo(big.dir, { ...big.opts, maxFiles: 2 });
  assert.equal(two.state, 'skipped');
  assert.match(two.reason, /demasiados archivos/);
  assert.equal(fs.existsSync(path.join(big.dir, '.git')), false);
});

test('ni en la carpeta del usuario ni en una unidad de red', { skip: noGit }, async (t) => {
  const { dir, opts } = project(t, { 'a.js': '1\n' });
  const home = await ensureRepo(dir, { ...opts, home: dir });
  assert.equal(home.state, 'skipped');
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  if (process.platform === 'win32') {
    const drive = path.parse(dir).root.slice(0, 2).toUpperCase();
    const net = await ensureRepo(dir, { ...opts, drives: async () => [drive] });
    assert.equal(net.state, 'skipped');
    assert.match(net.reason, /unidad de red/);
  }
});
