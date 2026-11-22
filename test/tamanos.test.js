// El aviso de archivos que crecen: la escalera y el aviso de la app a Claude
// (src/main/growth.js) y el de npm test de este proyecto (scripts/sizes.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Growth, nextStep, needsReview, EDIT_TOOLS } = require('../src/main/growth');
const { tempDir } = require('./helpers');

const loadSizes = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'sizes.mjs')).href);
const lines = (n) => `${Array.from({ length: n }, (_, i) => `// línea ${i + 1}`).join('\n')}\n`;

test('los escalones son 1 000, 1 200, 1 440, 1 728…', () => {
  assert.equal(nextStep(0), 1000);
  assert.equal(nextStep(999), 1000);
  assert.equal(nextStep(1000), 1200);
  assert.equal(nextStep(1310), 1440); // avisado entre dos escalones: el siguiente
  assert.equal(nextStep(1440), 1728);
  assert.equal(needsReview(999), false);
  assert.equal(needsReview(1000), true);
  assert.equal(needsReview(1199, 1000), false);
  assert.equal(needsReview(1200, 1000), true);
  assert.ok(EDIT_TOOLS.has('Edit') && EDIT_TOOLS.has('Write') && !EDIT_TOOLS.has('Read'));
});

function makeGrowth(t) {
  const saved = {};
  const logs = [];
  const growth = new Growth({ store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } }, log: (text) => logs.push(text) });
  const cwd = tempDir(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  const write = (file, n) => fs.writeFileSync(path.join(cwd, file), lines(n));
  return { growth, cwd, write, saved, logs };
}

test('la app avisa a Claude al llegar a un escalón, y solo una vez por escalón', async (t) => {
  const { growth, cwd, write, logs } = makeGrowth(t);
  write('src/app.js', 999);
  assert.equal(await growth.edited(cwd, path.join(cwd, 'src', 'app.js')), null); // aún no

  write('src/app.js', 1005);
  const notice = await growth.edited(cwd, path.join(cwd, 'src', 'app.js'));
  assert.match(notice, /buenas prácticas/);
  assert.match(notice, /tiene ya 1005 líneas/);
  assert.match(notice, /No lo partas por tu cuenta/);
  assert.match(notice, /hasta que llegue a 1200 líneas/);
  assert.equal(logs.length, 1);
  assert.equal(await growth.edited(cwd, path.join(cwd, 'src', 'app.js')), null); // ya avisado

  write('src/app.js', 1199);
  assert.equal(await growth.edited(cwd, 'src/app.js'), null); // ruta relativa a la carpeta del proyecto
  write('src/app.js', 1230);
  assert.match(await growth.edited(cwd, 'src/app.js'), /tiene ya 1230 líneas \(la última vez que se avisó tenía 1005\)/);
});

test('un archivo que se parte y vuelve a crecer avisa de nuevo', async (t) => {
  const { growth, cwd, write, saved } = makeGrowth(t);
  write('src/app.js', 1500);
  assert.ok(await growth.edited(cwd, 'src/app.js'));
  write('src/app.js', 300); // se ha partido
  assert.equal(await growth.edited(cwd, 'src/app.js'), null);
  assert.deepEqual(Object.values(saved.fileGrowth)[0], {}); // se olvida lo anotado
  write('src/app.js', 1001);
  assert.ok(await growth.edited(cwd, 'src/app.js'));
});

test('solo cuenta el código, por proyecto, y lo que no se puede leer se ignora', async (t) => {
  const { growth, cwd, write, saved } = makeGrowth(t);
  write('notas.md', 3000);
  write('datos.json', 3000);
  write('src/estilos.css', 3000);
  for (const file of ['notas.md', 'datos.json', 'src/estilos.css']) assert.equal(await growth.edited(cwd, file), null, file);
  assert.equal(await growth.edited(cwd, 'src/no-existe.py'), null);
  assert.equal(await growth.edited(cwd, null), null);
  assert.equal(await growth.edited(null, 'src/app.js'), null);

  write('src/servidor.py', 1100);
  assert.ok(await growth.edited(cwd, 'src/servidor.py'));
  // Otro proyecto con un archivo del mismo nombre lleva su propia cuenta.
  const other = tempDir(t);
  fs.mkdirSync(path.join(other, 'src'));
  fs.writeFileSync(path.join(other, 'src', 'servidor.py'), lines(1100));
  assert.ok(await growth.edited(other, 'src/servidor.py'));
  assert.equal(Object.keys(saved.fileGrowth).length, 2);
  assert.deepEqual(Object.keys(Object.values(saved.fileGrowth)[0]), ['src/servidor.py']); // se guarda la ruta dentro del proyecto
});

test('npm test avisa de lo que ha crecido y calla tras anotar la revisión', async (t) => {
  const { pending, markReviewed, readLog } = await loadSizes();
  const base = tempDir(t);
  const logFile = path.join(base, 'revisiones.json');
  fs.mkdirSync(path.join(base, 'src'));
  fs.writeFileSync(path.join(base, 'src', 'pequeno.js'), lines(120));
  fs.writeFileSync(path.join(base, 'src', 'grande.js'), lines(1030));
  const files = ['src/pequeno.js', 'src/grande.js'];
  const check = () => pending(files, { base, log: readLog(logFile) });

  assert.deepEqual(check(), [{ file: 'src/grande.js', lines: 1030, reviewed: 0, step: 1000 }]);
  const done = markReviewed('src/grande.js', 'se queda así: es una tabla de datos', { base, logFile });
  assert.deepEqual(done, { file: 'src/grande.js', lines: 1030, next: 1200 });
  assert.equal(readLog(logFile)['src/grande.js'].nota, 'se queda así: es una tabla de datos');
  assert.deepEqual(check(), []); // revisado: calla

  fs.writeFileSync(path.join(base, 'src', 'grande.js'), lines(1199));
  assert.deepEqual(check(), []); // aún no llega al escalón siguiente
  fs.writeFileSync(path.join(base, 'src', 'grande.js'), lines(1201));
  assert.deepEqual(check(), [{ file: 'src/grande.js', lines: 1201, reviewed: 1030, step: 1200 }]);
});

test('lo anotado en el proyecto corresponde a archivos que existen', async () => {
  const { readLog } = await loadSizes();
  for (const [file, entry] of Object.entries(readLog())) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} ya no existe: quítalo de scripts/revisiones-tamano.json`);
    assert.ok(entry.lineas > 0 && /^\d{4}-\d{2}-\d{2}$/.test(entry.fecha), file);
  }
});

test('si contar las líneas tarda demasiado no se avisa ni se anota (el aviso no llegaría)', async (t) => {
  const { growth, cwd, write, saved, logs } = makeGrowth(t);
  write('src/app.js', 1500);
  assert.equal(await growth.edited(cwd, 'src/app.js', { budget: -1 }), null);
  assert.equal(saved.fileGrowth, undefined); // nada anotado: la próxima edición lo intentará
  assert.match(logs.join('\n'), /ha tardado demasiado/);
  assert.ok(await growth.edited(cwd, 'src/app.js'));
});

test('una ruta relativa se resuelve con la carpeta de trabajo de la sesión', async (t) => {
  const { growth, cwd, write, saved } = makeGrowth(t);
  write('src/app.js', 1100);
  // La sesión trabaja en src/: la ruta relativa es «app.js», pero se anota dentro del proyecto.
  assert.ok(await growth.edited(cwd, 'app.js', { base: path.join(cwd, 'src') }));
  assert.deepEqual(Object.keys(Object.values(saved.fileGrowth)[0]), ['src/app.js']);
  assert.equal(await growth.edited(cwd, 'app.js'), null); // sin esa carpeta, app.js no existe en la raíz
});

test('de un cuaderno de Jupyter cuentan las celdas de código', async (t) => {
  const { growth, cwd } = makeGrowth(t);
  const nb = (codeLinesEach, textLinesEach) => JSON.stringify({ cells: [
    { cell_type: 'code', source: Array.from({ length: codeLinesEach }, (_, i) => `x${i} = ${i}\n`), outputs: [{ text: 'mucho\n'.repeat(5000) }] },
    { cell_type: 'markdown', source: 'texto\n'.repeat(textLinesEach) },
  ] });
  fs.writeFileSync(path.join(cwd, 'datos.ipynb'), nb(900, 3000)); // 900 de código: no llega
  assert.equal(await growth.edited(cwd, 'datos.ipynb'), null);
  fs.writeFileSync(path.join(cwd, 'datos.ipynb'), nb(1050, 10));
  assert.match(await growth.edited(cwd, 'datos.ipynb'), /tiene ya 1050 líneas/);
  fs.writeFileSync(path.join(cwd, 'roto.ipynb'), '{ no es json');
  assert.equal(await growth.edited(cwd, 'roto.ipynb'), null);
});

test('un historial de revisiones dañado no se sobrescribe', async (t) => {
  const { markReviewed, readLog } = await loadSizes();
  const base = tempDir(t);
  const logFile = path.join(base, 'revisiones.json');
  fs.writeFileSync(path.join(base, 'a.js'), lines(10));
  assert.deepEqual(readLog(logFile), {}); // sin archivo: vacío
  fs.writeFileSync(logFile, '{ "a.js": { "lineas": 5');
  assert.throws(() => readLog(logFile), /está dañado/);
  assert.throws(() => markReviewed('a.js', '', { base, logFile }), /está dañado/);
  assert.equal(fs.readFileSync(logFile, 'utf8'), '{ "a.js": { "lineas": 5'); // intacto
  fs.writeFileSync(logFile, '[{ "a.js": 5 }]'); // JSON válido, pero no es una lista de archivos
  assert.throws(() => markReviewed('a.js', '', { base, logFile }), /está dañado/);
  assert.equal(fs.readFileSync(logFile, 'utf8'), '[{ "a.js": 5 }]');
});

test('un cuaderno dañado no impide revisar el resto', async (t) => {
  const { pending } = await loadSizes();
  const base = tempDir(t);
  fs.writeFileSync(path.join(base, 'roto.ipynb'), '{ no es json');
  fs.writeFileSync(path.join(base, 'grande.js'), lines(1100));
  assert.deepEqual(pending(['roto.ipynb', 'grande.js'], { base, log: {} }).map((p) => p.file), ['grande.js']);
});

test('con defer, el escalón no se anota hasta que el aviso se entrega', async (t) => {
  const { growth, cwd, write, saved } = makeGrowth(t);
  write('src/app.js', 1100);
  const first = await growth.edited(cwd, 'src/app.js', { defer: true });
  assert.match(first.notice, /tiene ya 1100 líneas/);
  assert.equal(saved.fileGrowth, undefined);
  assert.ok(await growth.edited(cwd, 'src/app.js', { defer: true })); // no entregado: se repite
  first.commit();
  assert.equal(await growth.edited(cwd, 'src/app.js', { defer: true }), null);
});
