// Cuándo se recomienda «Optimiza» (src/main/optimize-hint.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createOptimizeHints, evaluate, EDITS, BIG, OLD_DAYS, OLD_EDITS, SNOOZE_DAYS } = require('../src/main/optimize-hint');
const { Tabs } = require('../src/main/tabs');
const { tempDir } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const rec = (o = {}) => ({ since: T0, last: null, edits: 0, files: {}, baseline: {}, snoozed: 0, told: false, ...o });

test('se recomienda por muchos cambios, por archivos grandes o porque hace tiempo, y dice por qué', () => {
  assert.equal(evaluate(null).recommended, false);
  assert.equal(evaluate(rec({ edits: EDITS - 1 }), T0).recommended, false);
  const many = evaluate(rec({ edits: EDITS }), T0);
  assert.equal(many.recommended, true);
  assert.match(many.reasons[0], /150 cambios de código desde que ClaudHome sigue este proyecto/);
  assert.match(evaluate(rec({ edits: 200, last: T0 }), T0).reasons[0], /desde la última optimización/);
  // Archivos grandes: con el nombre y sus líneas; los que ya eran grandes al optimizar, solo si han crecido.
  const big = evaluate(rec({ files: { 'src/main.js': BIG + 400, 'a.js': 10 } }), T0);
  assert.equal(big.recommended, true);
  assert.match(big.reasons[0], /main\.js tiene 1200 líneas/);
  assert.equal(evaluate(rec({ files: { 'src/main.js': 900 }, baseline: { 'src/main.js': 900 } }), T0).recommended, false);
  assert.equal(evaluate(rec({ files: { 'src/main.js': 1040 }, baseline: { 'src/main.js': 900 } }), T0).recommended, true); // +15 %
  assert.match(evaluate(rec({ files: { 'a.js': 500, 'b.js': 1000, 'c.js': 2000 } }), T0).reasons[0], /^c\.js tiene 2000 líneas y b\.js tiene 1000 líneas$/);
  assert.match(evaluate(rec({ files: { 'a.js': 900, 'b.js': 1000, 'c.js': 2000 } }), T0).reasons[0], /c\.js tiene 2000 líneas, b\.js tiene 1000 líneas y otro más es muy grande/);
  assert.match(evaluate(rec({ files: { 'a.js': 900, 'b.js': 1000, 'c.js': 2000, 'd.js': 850 } }), T0).reasons[0], /y 2 más son muy grandes/);
  // Hace tiempo, pero solo si ha habido cambios.
  assert.equal(evaluate(rec({ edits: OLD_EDITS - 1 }), T0 + OLD_DAYS * DAY).recommended, false);
  assert.match(evaluate(rec({ edits: OLD_EDITS }), T0 + OLD_DAYS * DAY).reasons[0], /hace 30 días que ClaudHome lo sigue y lleva 40 cambios/);
  // «Ahora no»: sigue habiendo motivos, pero no se recomienda hasta que pase.
  const later = evaluate(rec({ edits: 500, snoozed: T0 + DAY }), T0);
  assert.equal(later.recommended, false);
  assert.equal(later.snoozed, true);
  assert.equal(evaluate(rec({ edits: 500, snoozed: T0 + DAY }), T0 + 2 * DAY).recommended, true);
});

function setup(t) {
  const dir = tempDir(t);
  const data = {};
  const store = { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
  const tabs = new Tabs();
  Object.assign(tabs.ensure('t1'), { name: 'Web', folder: dir });
  Object.assign(tabs.ensure('t2'), { name: 'Web (otra)', folder: dir });
  const sent = [];
  const logs = [];
  let clock = T0;
  const hints = createOptimizeHints({ store, tabs, send: (ch, id, hint) => sent.push([ch, id, hint]), log: (x) => logs.push(x), now: () => clock });
  const write = (name, lines) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x\n'.repeat(lines)); };
  return { dir, data, tabs, sent, logs, hints, write, tick: (ms) => { clock += ms; } };
}

test('cuenta los cambios de código del proyecto y avisa una vez, a todas sus pestañas', async (t) => {
  const s = setup(t);
  s.write('a.js', 10);
  s.write('README.md', 10);
  await s.hints.edited('t1', 'README.md'); // un documento no cuenta
  await s.hints.edited('t1', path.join(s.dir, '..', 'fuera.js')); // fuera del proyecto, tampoco
  await s.hints.edited('otra', 'a.js'); // ni de una pestaña sin carpeta
  for (let i = 0; i < EDITS - 1; i += 1) await s.hints.edited('t1', 'a.js');
  assert.equal(s.hints.hint('t1').recommended, false);
  assert.equal(s.sent.length, 0);
  await s.hints.edited('t1', 'a.js');
  assert.equal(s.hints.hint('t1').recommended, true);
  assert.deepEqual(s.sent.map(([ch, id, h]) => [ch, id, h.recommended, h.first]), [['optimize:hint', 't1', true, true], ['optimize:hint', 't2', true, true]]);
  assert.match(s.logs.join('\n'), /se recomienda para «Web»/);
  await s.hints.edited('t1', 'a.js'); // ya recomendado: no se repite el aviso, pero el motivo se pone al día
  assert.equal(s.sent.length, 4);
  assert.deepEqual(s.sent.slice(2).map(([, , h]) => [h.first, h.reasons[0]]), [[undefined, `${EDITS + 1} cambios de código desde que ClaudHome sigue este proyecto`], [undefined, `${EDITS + 1} cambios de código desde que ClaudHome sigue este proyecto`]]);
  assert.equal((s.logs.join('\n').match(/se recomienda/g) || []).length, 1);
  // Se guarda: otra app (o un reinicio) lo ve igual.
  const again = createOptimizeHints({ store: { get: (k, d) => (k in s.data ? s.data[k] : d), set: () => {} }, tabs: s.tabs, now: () => T0 });
  assert.equal(again.hint('t1').recommended, true);
  // Un archivo que se va haciendo grande.
  const b = setup(t);
  b.write('src/grande.js', BIG + 50);
  await b.hints.edited('t1', 'src/grande.js');
  assert.match(b.hints.hint('t1').reasons[0], /grande\.js tiene 850 líneas/);
});

test('si ya conviene al abrir la sesión (ha pasado un mes), se avisa entonces, una vez', async (t) => {
  const s = setup(t);
  s.write('a.js', 10);
  for (let i = 0; i < OLD_EDITS; i += 1) await s.hints.edited('t1', 'a.js');
  assert.equal(s.sent.length, 0); // aún no hace un mes
  s.tick((OLD_DAYS + 1) * DAY);
  s.hints.refresh('t1'); // se abre la sesión
  assert.deepEqual(s.sent.map(([, id, h]) => [id, h.recommended, h.first]), [['t1', true, true], ['t2', true, true]]);
  assert.match(s.sent[0][2].reasons[0], /hace 31 días que ClaudHome lo sigue y lleva 40 cambios/);
  s.hints.refresh('t1'); // al volver a abrirla, ya no se repite
  assert.deepEqual(s.sent.slice(2).map(([, , h]) => h.first), [undefined, undefined]);
  // Sin carpeta, no hace nada.
  s.hints.refresh('nadie');
  assert.equal(s.sent.length, 4);
});

test('al optimizar se pone a cero, lo que cambia la propia optimización no cuenta, y «Ahora no» espera unos días', async (t) => {
  const s = setup(t);
  s.write('src/grande.js', BIG + 100);
  await s.hints.edited('t1', 'src/grande.js');
  assert.equal(s.hints.hint('t1').recommended, true);
  // «Ahora no».
  const snoozed = s.hints.snooze('t1');
  assert.equal(snoozed.recommended, false);
  assert.match(s.logs.join('\n'), /lo deja para más adelante \(7 días\)/);
  s.tick((SNOOZE_DAYS + 1) * DAY);
  assert.equal(s.hints.hint('t1').recommended, true);
  // Empieza una optimización: a cero, y sus cambios no cuentan ni hacen saltar el aviso.
  s.hints.optimized('t1');
  assert.equal(s.hints.hint('t1').recommended, false); // el grande ya lo era: solo cuenta si crece
  for (let i = 0; i < EDITS + 10; i += 1) await s.hints.edited('t1', 'src/grande.js');
  assert.equal(s.hints.hint('t1').recommended, false);
  // La optimización lo ha dejado en 300 líneas: ese es el punto de partida.
  s.write('src/grande.js', 300);
  await s.hints.edited('t1', 'src/grande.js');
  s.hints.turnStarted('t1'); // siguiente turno, ya normal
  s.write('src/grande.js', BIG + 10);
  await s.hints.edited('t1', 'src/grande.js');
  assert.equal(s.hints.hint('t1').recommended, true); // ha vuelto a crecer mucho
  const sent = s.sent.filter(([, id]) => id === 't1');
  assert.equal(sent[sent.length - 1][2].first, true); // y se vuelve a avisar, tras la optimización
});
