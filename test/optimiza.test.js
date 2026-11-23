// Botón «Optimiza» (src/main/optimize.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OPTIMIZE_START, checkProject, instructions, createOptimizer } = require('../src/main/optimize');
const { Tabs } = require('../src/main/tabs');
const { tempDir } = require('./helpers');

test('la petición que escribe la interfaz es la que reconoce el proceso principal', () => {
  const constants = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'constants.js'), 'utf8');
  const prompt = /export const OPTIMIZE_PROMPT = '([^']+)'/.exec(constants);
  assert.ok(prompt, 'OPTIMIZE_PROMPT en constants.js');
  assert.ok(prompt[1].startsWith(OPTIMIZE_START));
  assert.ok(prompt[1].length <= 200); // una línea corta en la terminal
});

test('las instrucciones llevan la red de seguridad, se adaptan al proyecto y no permiten tocar la rama original', () => {
  const base = instructions({ git: true, dirty: false, branch: 'main', stamp: '20261123-101500' });
  for (const must of ['`optimiza-20261123-101500`', 'desde la rama «main»', 'No toques la rama original', 'no hagas push',
    'Sin red de seguridad, no se toca', 'Un commit por mejora', 'deshaz ese paso', 'añadir dependencias', 'sistemas reales',
    'Repite las mediciones', 'segunda_opinion', 'subagente revisor', 'antes/después', '`git switch main`', 'No la unas tú']) {
    assert.ok(base.includes(must), must);
  }
  assert.ok(!/git init/.test(base));
  assert.ok(!/cambios sin confirmar/.test(base));
  const dirty = instructions({ git: true, dirty: true, branch: 'develop', stamp: 'x' });
  assert.match(dirty, /Punto de partida: cambios sin confirmar/);
  assert.match(dirty, /git switch develop/);
  const none = instructions({ git: false, stamp: 'x' });
  assert.match(none, /no usa git/);
  assert.match(none, /git init/);
  assert.match(none, /\.env/);
  assert.match(none, /git switch <rama anterior>/);
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.invalid', ...args], { cwd, stdio: 'pipe' });

test('sabe si el proyecto usa git, en qué rama está y si tiene cambios sin confirmar', async (t) => {
  assert.deepEqual(await checkProject(path.join(tempDir(t), 'no-existe')), { ok: false, error: 'La carpeta de este proyecto ya no existe.' });
  assert.equal((await checkProject(null)).ok, false);
  const plain = tempDir(t);
  // Una carpeta temporal puede quedar dentro de otro repositorio; si es así, esta parte no se comprueba.
  const outside = await checkProject(plain);
  assert.equal(outside.ok, true);
  const repo = tempDir(t);
  git(repo, 'init', '-q', '-b', 'principal');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'inicio');
  assert.deepEqual(await checkProject(repo), { ok: true, git: true, dirty: false, branch: 'principal' });
  fs.writeFileSync(path.join(repo, 'a.js'), 'y');
  assert.deepEqual(await checkProject(repo), { ok: true, git: true, dirty: true, branch: 'principal' });
  if (!outside.git) assert.deepEqual(outside, { ok: true, git: false, dirty: false, branch: null });
});

test('las instrucciones solo se añaden a la petición del botón, una vez y si llega a tiempo', () => {
  let clock = 1000;
  const logs = [];
  const tabs = new Tabs();
  const optimizer = createOptimizer({ tabs, log: (text) => logs.push(text), now: () => clock });
  const project = { ok: true, git: true, dirty: false, branch: 'main' };
  assert.equal(optimizer.consume('t1', `${OPTIMIZE_START} …`), null); // sin confirmar
  optimizer.arm('t1', project);
  assert.equal(optimizer.consume('t1', 'Otra cosa que escribe el usuario'), null); // no es la petición: sigue preparada
  assert.equal(optimizer.consume('t2', `${OPTIMIZE_START} …`), null); // otra pestaña
  assert.match(optimizer.consume('t1', `${OPTIMIZE_START} con el método…`), /botón «Optimiza»/);
  assert.match(logs.join('\n'), /Optimiza: .* empieza \(git: sí\)/);
  assert.equal(optimizer.consume('t1', `${OPTIMIZE_START} …`), null); // una sola vez
  optimizer.arm('t1', project);
  clock += 3 * 60 * 1000; // demasiado tarde
  assert.equal(optimizer.consume('t1', `${OPTIMIZE_START} …`), null);
  assert.equal(optimizer.consume('t1', null), null);
});
