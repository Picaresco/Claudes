// Cuándo se recomienda «Optimiza» (src/main/optimize-hint.js): señales gratuitas y, cuando
// pasan su umbral, la segunda mirada de Haiku.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createOptimizeHints, evaluate, signals, EDITS, BIG, OLD_DAYS, OLD_EDITS, SNOOZE_DAYS, RECHECK_DAYS, RECHECK_EDITS } = require('../src/main/optimize-hint');
const { Tabs } = require('../src/main/tabs');
const { tempDir } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const rec = (o = {}) => ({ since: T0, last: null, edits: 0, files: {}, baseline: {}, changed: {}, ai: null, snoozed: 0, told: false, ...o });
const yes = (o = {}) => ({ at: T0, verdict: true, reason: 'calc.js repite el cálculo del IVA', edits: 0, ...o });

test('las señales gratuitas: muchos cambios, archivos grandes o hace tiempo, explicadas', () => {
  assert.deepEqual(signals(null), []);
  assert.deepEqual(signals(rec({ edits: EDITS - 1 }), T0), []);
  assert.match(signals(rec({ edits: EDITS }), T0)[0], /150 cambios de código desde que ClaudHome sigue este proyecto/);
  assert.match(signals(rec({ edits: 200, last: T0 }), T0)[0], /desde la última optimización/);
  assert.match(signals(rec({ files: { 'src/main.js': BIG + 400 } }), T0)[0], /main\.js tiene 1200 líneas/);
  assert.deepEqual(signals(rec({ files: { 'src/main.js': 900 }, baseline: { 'src/main.js': 900 } }), T0), []); // ya lo era al optimizar
  assert.equal(signals(rec({ files: { 'src/main.js': 1040 }, baseline: { 'src/main.js': 900 } }), T0).length, 1); // +15 %
  assert.match(signals(rec({ files: { 'a.js': 500, 'b.js': 1000, 'c.js': 2000 } }), T0)[0], /^c\.js tiene 2000 líneas y b\.js tiene 1000 líneas$/);
  assert.match(signals(rec({ files: { 'a.js': 900, 'b.js': 1000, 'c.js': 2000 } }), T0)[0], /y otro más es muy grande/);
  assert.match(signals(rec({ files: { 'a.js': 900, 'b.js': 1000, 'c.js': 2000, 'd.js': 850 } }), T0)[0], /y 2 más son muy grandes/);
  assert.deepEqual(signals(rec({ edits: OLD_EDITS - 1 }), T0 + OLD_DAYS * DAY), []);
  assert.match(signals(rec({ edits: OLD_EDITS }), T0 + OLD_DAYS * DAY)[0], /hace 30 días que ClaudHome lo sigue y lleva 40 cambios/);
});

test('solo se recomienda con el visto bueno de Haiku; si no se le puede preguntar, valen las señales', () => {
  const ready = rec({ edits: EDITS });
  // Señales sin Haiku todavía: no se recomienda, se le pregunta.
  assert.deepEqual([evaluate(ready, T0).recommended, evaluate(ready, T0).needsCheck], [false, true]);
  // Sin señales no se le pregunta nada.
  assert.deepEqual([evaluate(rec({ edits: 3 }), T0).recommended, evaluate(rec({ edits: 3 }), T0).needsCheck], [false, false]);
  // Dice que sí: recomendado, con su motivo primero.
  const ok = evaluate(rec({ edits: EDITS, ai: yes() }), T0);
  assert.equal(ok.recommended, true);
  assert.equal(ok.reasons[0], 'calc.js repite el cálculo del IVA');
  assert.match(ok.reasons[1], /150 cambios/);
  // Dice que no: ni se recomienda ni se le vuelve a preguntar hasta pasados unos días y más cambios.
  const no = rec({ edits: EDITS, ai: yes({ verdict: false, edits: EDITS }) });
  assert.deepEqual([evaluate(no, T0).recommended, evaluate(no, T0).needsCheck], [false, false]);
  assert.equal(evaluate(no, T0 + RECHECK_DAYS * DAY).needsCheck, false); // pasan los días, pero sin cambios
  assert.equal(evaluate({ ...no, edits: EDITS + RECHECK_EDITS }, T0 + 2 * DAY).needsCheck, false); // cambios, pero pronto
  assert.equal(evaluate({ ...no, edits: EDITS + RECHECK_EDITS }, T0 + RECHECK_DAYS * DAY).needsCheck, true);
  // No se le pudo preguntar: valen las señales y se reintenta al día siguiente.
  const failed = rec({ edits: EDITS, ai: yes({ verdict: null, reason: '' }) });
  assert.deepEqual([evaluate(failed, T0).recommended, evaluate(failed, T0).needsCheck], [true, false]);
  assert.equal(evaluate(failed, T0 + DAY).needsCheck, true);
  // Una respuesta de antes de la última optimización no vale para esta ronda.
  assert.equal(evaluate(rec({ edits: EDITS, last: T0 + 10, ai: yes() }), T0 + 20).needsCheck, true);
  // «Ahora no»: ni recomendado ni se pregunta, hasta que pase.
  const later = rec({ edits: EDITS, ai: yes(), snoozed: T0 + DAY });
  assert.deepEqual([evaluate(later, T0).recommended, evaluate(later, T0).snoozed], [false, true]);
  assert.equal(evaluate(later, T0 + 2 * DAY).recommended, true);
  assert.equal(evaluate(rec({ edits: EDITS, snoozed: T0 + DAY }), T0).needsCheck, false);
});

function setup(t, answer = { recommend: true, reason: 'a.js tiene dos funciones repetidas' }) {
  const dir = tempDir(t);
  const data = {};
  const store = { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
  const tabs = new Tabs();
  Object.assign(tabs.ensure('t1'), { name: 'Web', folder: dir });
  Object.assign(tabs.ensure('t2'), { name: 'Web (otra)', folder: dir });
  const sent = [];
  const logs = [];
  const asked = [];
  let clock = T0;
  const s = { dir, data, tabs, sent, logs, asked, answer };
  s.hints = createOptimizeHints({
    store, tabs, send: (ch, id, hint) => sent.push([ch, id, hint]), log: (x) => logs.push(x), now: () => clock,
    check: async (req) => { asked.push(req); return typeof s.answer === 'function' ? s.answer(req) : s.answer; },
  });
  s.write = (name, lines) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x\n'.repeat(lines)); };
  s.tick = (ms) => { clock += ms; };
  s.edits = async (name, n) => { for (let i = 0; i < n; i += 1) await s.hints.edited('t1', name); await s.hints.settled(); };
  return s;
}

test('al pasar el umbral se pregunta a Haiku una vez, con los archivos que más han cambiado, y se avisa con su motivo', async (t) => {
  const s = setup(t);
  s.write('a.js', 10);
  s.write('b.js', 20);
  s.write('README.md', 10);
  await s.hints.edited('t1', 'README.md'); // un documento no cuenta
  await s.hints.edited('t1', path.join(s.dir, '..', 'fuera.js')); // fuera del proyecto, tampoco
  await s.hints.edited('otra', 'a.js'); // ni de una pestaña sin carpeta
  await s.edits('b.js', 10);
  await s.edits('a.js', EDITS - 11);
  assert.equal(s.asked.length, 0);
  assert.equal(s.sent.length, 0);
  await s.edits('a.js', 1); // pasa el umbral
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.asked[0].files.map((f) => [f.name, f.edits, f.lines]), [['a.js', 140, 10], ['b.js', 10, 20]]);
  assert.match(s.asked[0].signals[0], /150 cambios/);
  assert.equal(s.asked[0].folder, s.dir);
  assert.equal(s.hints.hint('t1').recommended, true);
  assert.deepEqual(s.sent.map(([ch, id, h]) => [ch, id, h.recommended, h.first, h.reasons[0]]), [
    ['optimize:hint', 't1', true, true, 'a.js tiene dos funciones repetidas'], ['optimize:hint', 't2', true, true, 'a.js tiene dos funciones repetidas'],
  ]);
  assert.match(s.logs.join('\n'), /se lo pregunta a Haiku[\s\S]*se recomienda para «Web»/);
  await s.edits('a.js', 3); // ya recomendado: no se vuelve a preguntar ni a avisar
  assert.equal(s.asked.length, 1);
  assert.ok(s.sent.slice(2).every(([, , h]) => !h.first));
});

test('si Haiku dice que no, no se molesta y se espera a más cambios', async (t) => {
  const s = setup(t, { recommend: false, reason: 'está limpio' });
  s.write('a.js', 10);
  await s.edits('a.js', EDITS);
  assert.equal(s.asked.length, 1);
  assert.equal(s.hints.hint('t1').recommended, false);
  assert.ok(s.sent.every(([, , h]) => !h.recommended));
  await s.edits('a.js', RECHECK_EDITS + 5);
  assert.equal(s.asked.length, 1); // demasiado pronto
  s.tick(RECHECK_DAYS * DAY);
  s.answer = { recommend: true, reason: 'a.js ha crecido con código repetido' };
  await s.edits('a.js', 1);
  assert.equal(s.asked.length, 2);
  assert.equal(s.hints.hint('t1').reasons[0], 'a.js ha crecido con código repetido');
});

test('si no se puede preguntar a Haiku, valen las señales y se reintenta al día siguiente', async (t) => {
  const s = setup(t, () => { throw new Error('sin conexión'); });
  s.write('a.js', 10);
  await s.edits('a.js', EDITS);
  assert.equal(s.hints.hint('t1').recommended, true);
  assert.match(s.hints.hint('t1').reasons[0], /150 cambios/);
  s.answer = { error: 'no se encuentra claude' };
  await s.edits('a.js', 1);
  assert.equal(s.asked.length, 1); // el mismo día, no
  s.tick(DAY);
  s.answer = { recommend: false, reason: 'limpio' };
  await s.edits('a.js', 1);
  assert.equal(s.asked.length, 2);
  assert.equal(s.hints.hint('t1').recommended, false); // ahora sí ha podido mirar, y no hace falta
});

test('si ya conviene al abrir la sesión (ha pasado un mes), se pregunta y se avisa entonces', async (t) => {
  const s = setup(t);
  s.write('a.js', 10);
  await s.edits('a.js', OLD_EDITS);
  assert.equal(s.asked.length, 0); // aún no hace un mes
  s.tick((OLD_DAYS + 1) * DAY);
  s.hints.refresh('t1'); // se abre la sesión
  await s.hints.settled();
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0].signals[0], /hace 31 días/);
  assert.deepEqual(s.sent.filter(([, , h]) => h.first).map(([, id]) => id), ['t1', 't2']);
  s.hints.refresh('t1'); // al volver a abrirla, ni se pregunta ni se avisa otra vez
  await s.hints.settled();
  assert.equal(s.asked.length, 1);
  assert.equal(s.sent.filter(([, , h]) => h.first).length, 2);
  s.hints.refresh('nadie');
});

test('al optimizar se pone a cero, lo que cambia la propia optimización no cuenta, y «Ahora no» espera unos días', async (t) => {
  const s = setup(t);
  s.write('src/grande.js', BIG + 100);
  await s.edits('src/grande.js', 1);
  assert.equal(s.hints.hint('t1').recommended, true);
  assert.equal(s.asked[0].files[0].name, 'src/grande.js');
  const snoozed = s.hints.snooze('t1');
  assert.equal(snoozed.recommended, false);
  assert.match(s.logs.join('\n'), /lo deja para más adelante \(7 días\)/);
  s.tick((SNOOZE_DAYS + 1) * DAY);
  assert.equal(s.hints.hint('t1').recommended, true);
  // Empieza una optimización: a cero, y sus cambios no cuentan ni hacen preguntar a Haiku.
  s.hints.optimized('t1');
  assert.equal(s.hints.hint('t1').recommended, false);
  await s.edits('src/grande.js', EDITS + 10);
  assert.equal(s.asked.length, 1);
  s.write('src/grande.js', 300); // la optimización lo deja en 300 líneas: el nuevo punto de partida
  await s.edits('src/grande.js', 1);
  s.hints.turnStarted('t1');
  s.write('src/grande.js', BIG + 10);
  await s.edits('src/grande.js', 1); // vuelve a crecer mucho
  assert.equal(s.asked.length, 2);
  assert.equal(s.hints.hint('t1').recommended, true);
  const own = s.sent.filter(([, id]) => id === 't1');
  assert.equal(own[own.length - 1][2].first, true); // y se vuelve a avisar, tras la optimización
});

test('una respuesta de Haiku que llega cuando ya ha empezado otra optimización no cuenta', async (t) => {
  let release;
  const s = setup(t, () => new Promise((resolve) => { release = () => resolve({ recommend: true, reason: 'tarde' }); }));
  s.write('a.js', 10);
  for (let i = 0; i < EDITS; i += 1) await s.hints.edited('t1', 'a.js');
  assert.equal(s.asked.length, 1);
  s.tick(1000);
  s.hints.optimized('t1'); // el usuario optimiza mientras Haiku piensa
  release();
  await s.hints.settled();
  assert.equal(s.hints.hint('t1').recommended, false);
});
