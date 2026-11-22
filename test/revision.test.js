// Codex como segundo revisor (src/main/review.js y la parte de src/main/codex.js que lo lanza).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createReview, isGitRepo, repoRoot, reasonFor, verdict, WRAPUP_START } = require('../src/main/review');
const { parseReview } = require('../src/main/codex');
const { Tabs } = require('../src/main/tabs');
const { tempDir } = require('./helpers');

// Lo que escribe `codex review` al final, como en la prueba de concepto.
const SAMPLE = [
  'The transcript scanner no longer counts appended usage records after the first read.',
  '',
  'Full review comments:',
  '',
  '- [P1] Await transcript reads before storing their byte offsets — C:/x/src/limits.js:195-195',
  '  `readFrom()` returns a Promise, so `scan()` can finish before the reads complete.',
  '  Await the read before storing its numeric offset.',
  '',
  '- [P2] Advance past an already reviewed growth threshold — C:/x/src/growth.js:27-27',
  '  After a warning at exactly 1,000 lines, `nextStep(1000)` now returns 1,000.',
  '',
].join('\n');

test('parseReview separa el resumen y cada hallazgo con su prioridad', () => {
  const r = parseReview(SAMPLE);
  assert.equal(r.summary, 'The transcript scanner no longer counts appended usage records after the first read.');
  assert.equal(r.findings.length, 2);
  assert.deepEqual({ ...r.findings[0], body: r.findings[0].body.slice(0, 30) }, {
    priority: 1, title: 'Await transcript reads before storing their byte offsets', location: 'C:/x/src/limits.js:195-195', body: '`readFrom()` returns a Promise',
  });
  assert.match(r.findings[0].body, /Await the read before storing/); // las líneas sangradas se juntan
  assert.equal(r.findings[1].priority, 2);
  // Sin hallazgos: solo el resumen.
  assert.deepEqual(parseReview('The change adds a method without altering behavior.\n'), { summary: 'The change adds a method without altering behavior.', findings: [] });
  assert.deepEqual(parseReview(''), { summary: '', findings: [] });
});

test('con un solo hallazgo, el resumen no lo repite', () => {
  const one = 'The only change breaks `suma`.\n\nReview comment:\n\n- [P1] Restore addition in `suma` — C:/x/suma.js:3-3\n  `suma(2, 3)` returns -1.\n';
  const r = parseReview(one);
  assert.equal(r.summary, 'The only change breaks `suma`.');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].body, '`suma(2, 3)` returns -1.');
  // Sin encabezado, el resumen acaba en el primer hallazgo.
  assert.equal(parseReview('Resumen.\n- [P2] Algo — a.js:1\n  Detalle.\n').summary, 'Resumen.');
});

test('un resultado vacío no es «sin problemas», y unas marcas [Pn] sin formato sí son hallazgos', () => {
  assert.equal(verdict(parseReview(''), '').state, 'unclear');
  assert.equal(verdict(parseReview('   \n'), '   \n').state, 'unclear');
  assert.equal(verdict(parseReview('The change looks correct.'), 'The change looks correct.').state, 'clean');
  const cannot = 'I could not inspect the changes because the repository is not accessible.';
  assert.equal(verdict(parseReview(cannot), cannot).state, 'unclear');
  assert.equal(verdict(parseReview('No he podido revisar los cambios.'), 'No he podido revisar los cambios.').state, 'unclear');
  const odd = 'Findings:\n* [P1] Something odd\n* [P3] Minor';
  assert.deepEqual(verdict(parseReview(odd), odd), { state: 'found', count: 2, priorities: [1, 3] });
  assert.match(reasonFor(parseReview(odd), odd), /\* \[P1\] Something odd/); // se pasa tal cual
  // Todo lo que recibe Claude tiene límite, también un resumen enorme.
  const big = `${'resumen '.repeat(5000)}\n- [P2] A — a.js:1\n  ${'x'.repeat(30000)}\n`;
  assert.ok(reasonFor(parseReview(big), big).length < 16000);
});

test('lo que se le dice a Claude incluye los hallazgos y le deja decidir', () => {
  const text = reasonFor(parseReview(SAMPLE), SAMPLE);
  assert.match(text, /ha encontrado 2 posibles problemas \(1 P1, 1 P2/);
  assert.match(text, /\[P1\] Await transcript reads/);
  assert.match(text, /Evalúa cada uno con criterio propio/);
  assert.match(text, /no volverá a revisar en este turno/);
  assert.match(text, /no solo los tuyos/); // también hay cambios del usuario
  assert.ok(!text.includes('Full review comments:'));
  const huge = SAMPLE + '- [P3] Otro — a.js:1\n  ' + 'x'.repeat(20000) + '\n';
  assert.match(reasonFor(parseReview(huge), huge), /\[… recortado\]/);
});

function makeReview(t, { enabled = true, usable = true, result = null, detailed = true, reviewChanges = null, checkSecrets = null } = {}) {
  const saved = { codexReview: enabled };
  const sent = [];
  const logs = [];
  const records = [];
  const calls = [];
  const tabs = new Tabs();
  const logs_ = tempDir(t);
  const review = createReview({
    tabs,
    store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } },
    usable: () => usable,
    codex: {
      parseReview,
      reviewChanges: async (opts) => { calls.push(opts); if (reviewChanges) return reviewChanges(opts); return result || { ok: true, code: 0, text: SAMPLE, log: 'registro', seconds: 37, aborted: false }; },
    },
    send: (...args) => sent.push(args),
    log: (text) => logs.push(text),
    logsDir: () => logs_,
    detailedLogs: () => detailed,
    ...(checkSecrets ? { checkSecrets } : {}),
    netlog: () => ({ record: (entry) => records.push(entry) }),
  });
  return { review, tabs, saved, sent, logs, records, calls, logsDir: logs_ };
}

// Un repositorio git de verdad, con un cambio sin confirmar.
function gitRepo(t) {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 2;\n');
  return dir;
}

test('solo se revisa un turno que ha editado código, una vez, y no el de cerrar la sesión', (t) => {
  const { review, tabs } = makeReview(t);
  tabs.ensure('t1').folder = 'C:\\x';
  const stop = (extra = {}) => review.willReview('t1', { event: 'Stop', stopHookActive: false, ...extra });

  review.turnStarted('t1', 'Explícame este código');
  review.toolUsed('t1', 'Read');
  review.toolUsed('t1', 'Bash');
  assert.equal(stop(), false); // no ha editado nada

  review.toolUsed('t1', 'Edit');
  assert.equal(stop(), true);
  assert.equal(stop({ stopHookActive: true }), false); // segundo Stop del turno: Claude ya sigue por la revisión

  review.turnStarted('t1', 'Otra cosa');
  assert.equal(stop(), false); // el turno nuevo empieza sin ediciones

  review.turnStarted('t1', `${WRAPUP_START} No continúes con la tarea…`);
  review.toolUsed('t1', 'Write');
  assert.equal(stop(), false); // el turno de cerrar la sesión no se revisa

  assert.equal(review.willReview('otra', { event: 'Stop' }), false); // pestaña sin sesión de Claude
});

test('apagado, o sin Codex con sesión de ChatGPT, no se revisa', (t) => {
  for (const options of [{ enabled: false }, { usable: false }]) {
    const { review, tabs } = makeReview(t, options);
    tabs.ensure('t1').folder = 'C:\\x';
    review.turnStarted('t1', 'hola');
    review.toolUsed('t1', 'Edit');
    assert.equal(review.willReview('t1', { event: 'Stop' }), false, JSON.stringify(options));
  }
  const { review, tabs, saved } = makeReview(t, { enabled: false });
  tabs.ensure('t1').folder = 'C:\\x';
  review.turnStarted('t1', 'hola');
  review.toolUsed('t1', 'Edit');
  review.enabled = true; // encendido a mitad de turno: vale desde el siguiente
  assert.equal(saved.codexReview, true); // se recuerda
  assert.equal(review.willReview('t1', { event: 'Stop' }), false);
  review.turnStarted('t1', 'otro');
  review.toolUsed('t1', 'Edit');
  assert.equal(review.willReview('t1', { event: 'Stop' }), true);
  review.enabled = false; // apagarlo sí vale al momento
  assert.equal(review.willReview('t1', { event: 'Stop' }), false);
});

test('solo cuenta la edición de archivos de código', (t) => {
  const { review, tabs } = makeReview(t);
  tabs.ensure('t1').folder = 'C:\\x';
  review.turnStarted('t1', 'Actualiza la documentación');
  review.toolUsed('t1', 'Write', 'C:\\x\\README.md');
  review.toolUsed('t1', 'Edit', 'datos.json');
  assert.equal(review.willReview('t1', { event: 'Stop' }), false);
  for (const file of ['src/app.js', 'pagina.html', 'analisis.ipynb', null]) { // sin ruta conocida: se cuenta
    review.turnStarted('t1', 'Cambia código');
    review.toolUsed('t1', 'Edit', file);
    assert.equal(review.willReview('t1', { event: 'Stop' }), true, String(file));
  }
});

test('con hallazgos, devuelve a Claude lo encontrado y deja constancia', async (t) => {
  const dir = gitRepo(t);
  const { review, tabs, sent, records, calls, logsDir } = makeReview(t);
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit');
  assert.equal(review.willReview('t1', { event: 'Stop' }), true);
  const answer = await review.onStop('t1', { event: 'Stop', cwd: dir }, new AbortController().signal);
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /Codex \(gpt-6\.2-astra, razonamiento xhigh\)/);
  assert.equal(calls[0].cwd, dir);
  assert.equal(calls[0].model, 'gpt-6.2-astra');
  assert.equal(calls[0].effort, 'xhigh');
  assert.deepEqual(sent.map(([, , r]) => r.state), ['running', 'found']);
  assert.deepEqual(sent[1][2].priorities, [1, 2]);
  assert.equal(records[0].external, true); // lo revisado sale hacia OpenAI: queda en el «Log»
  assert.match(records[0].dest, /OpenAI/);
  const logFile = fs.readdirSync(logsDir).find((f) => f.startsWith('revision-codex-'));
  assert.match(fs.readFileSync(path.join(logsDir, logFile), 'utf8'), /\[P1\] Await transcript reads/);
  // Ya revisado: un Stop más sin editar no vuelve a revisar.
  assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null);
  // Ni aunque Claude edite al corregir y el aviso no diga que es el segundo Stop (avisos grandes).
  review.toolUsed('t1', 'Edit', 'a.js');
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: false }), false);
  assert.equal(calls.length, 1);
});

test('el resultado de un turno ya pasado no cambia el estado del nuevo', async (t) => {
  const dir = gitRepo(t);
  let finish;
  const { review, tabs, sent } = makeReview(t, { reviewChanges: () => new Promise((resolve) => { finish = resolve; }) });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js');
  review.willReview('t1', { event: 'Stop' });
  const pending = review.onStop('t1', { event: 'Stop', cwd: dir }, new AbortController().signal);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map(([, , r]) => r.state), ['running']);
  review.turnStarted('t1', 'Otra cosa'); // el usuario ya ha seguido
  finish({ ok: false, code: null, text: '', log: '', seconds: 5, aborted: true });
  assert.equal(await pending, null);
  assert.deepEqual(sent.map(([, , r]) => r.state), ['running']); // el «interrumpida» no llega
});

test('sin la depuración activada no se guarda la salida completa', async (t) => {
  const dir = gitRepo(t);
  const { review, tabs, sent, logsDir } = makeReview(t, { detailed: false });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js');
  review.willReview('t1', { event: 'Stop' });
  assert.equal((await review.onStop('t1', { event: 'Stop', cwd: dir })).decision, 'block');
  assert.equal(sent[1][2].file, null);
  assert.deepEqual(fs.readdirSync(logsDir), []);
});

test('sin hallazgos, con fallo o interrumpida, Claude termina sin más', async (t) => {
  const dir = gitRepo(t);
  const cases = [
    [{ ok: true, code: 0, text: 'The change looks correct.\n', log: '', seconds: 20, aborted: false }, 'clean'],
    [{ ok: false, code: 1, text: '', log: 'error de red', seconds: 3, aborted: false }, 'error'],
    [{ ok: false, code: null, text: '', log: '', seconds: 9, aborted: true }, 'aborted'],
    [{ ok: true, code: 0, text: '', log: '', seconds: 4, aborted: false }, 'error'], // sin veredicto
    [{ ok: true, code: 0, text: 'Unable to review: git failed.', log: '', seconds: 4, aborted: false }, 'error'],
  ];
  for (const [result, state] of cases) {
    const { review, tabs, sent } = makeReview(t, { result });
    tabs.ensure('t1').folder = dir;
    review.turnStarted('t1', 'Cambia a');
    review.toolUsed('t1', 'Write');
    review.willReview('t1', { event: 'Stop' });
    assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null, state);
    assert.equal(sent[sent.length - 1][2].state, state);
  }
});

test('en una carpeta sin git no se revisa y se avisa del motivo', async (t) => {
  const dir = tempDir(t);
  const { review, tabs, sent, calls } = makeReview(t);
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit');
  review.willReview('t1', { event: 'Stop' });
  assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null);
  assert.equal(calls.length, 0);
  assert.equal(sent[0][2].state, 'skipped');
  assert.match(sent[0][2].reason, /solo revisa proyectos con git/);
  assert.equal(isGitRepo(dir), false);
  const repo = gitRepo(t);
  fs.mkdirSync(path.join(repo, 'src', 'ui'), { recursive: true });
  assert.equal(isGitRepo(path.join(repo, 'src', 'ui')), true);
  assert.equal(repoRoot(path.join(repo, 'src', 'ui')), path.resolve(repo));
  assert.equal(isGitRepo(''), false);
});

test('si lo que se enviaría lleva una clave, o no se puede comprobar, no se envía a Codex', async (t) => {
  const dir = gitRepo(t);
  for (const [answer, expected] of [
    [{ ok: true, files: ['config.js'] }, { state: 'secret', files: ['config.js'], unchecked: false }],
    [{ ok: false, files: [] }, { state: 'secret', files: [], unchecked: true }],
  ]) {
    const asked = [];
    const { review, tabs, sent, calls, records } = makeReview(t, { checkSecrets: async (cwd) => { asked.push(cwd); return answer; } });
    tabs.ensure('t1').folder = dir;
    review.turnStarted('t1', 'Conecta con la base de datos');
    review.toolUsed('t1', 'Edit', 'config.js', dir);
    assert.equal(review.willReview('t1', { event: 'Stop' }), true);
    assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null);
    assert.deepEqual(asked, [dir]); // se mira el repositorio entero, no solo lo de Claude
    assert.equal(calls.length, 0); // Codex no ha recibido nada
    assert.equal(records.length, 0); // ni ha salido nada
    assert.deepEqual(sent.map(([, , r]) => r), [expected]);
  }
});

test('se revisa el repositorio de lo que ha editado Claude, no la carpeta en la que acaba', async (t) => {
  const a = gitRepo(t);
  const b = gitRepo(t);
  const { review, tabs, calls, sent } = makeReview(t);
  tabs.ensure('t1').folder = a;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'src/a.js', a); // relativa: a la carpeta de trabajo de ese momento
  review.willReview('t1', { event: 'Stop' });
  await review.onStop('t1', { event: 'Stop', cwd: b }); // la sesión ha acabado en otro sitio
  assert.equal(calls[0].cwd, a);
  // Código de dos repositorios en un mismo turno: no se revisa ninguno.
  review.turnStarted('t1', 'Cambia los dos');
  review.toolUsed('t1', 'Edit', path.join(a, 'a.js'));
  review.toolUsed('t1', 'Edit', path.join(b, 'b.js'));
  review.willReview('t1', { event: 'Stop' });
  assert.equal(await review.onStop('t1', { event: 'Stop', cwd: a }), null);
  assert.equal(calls.length, 1);
  assert.match(sent[sent.length - 1][2].reason, /varios repositorios/);
});

test('si se interrumpe mientras se comprueba, la pestaña deja de mostrar «revisando»', async (t) => {
  const dir = gitRepo(t);
  const controller = new AbortController();
  const { review, tabs, sent, calls } = makeReview(t, { checkSecrets: async () => { controller.abort(); return { ok: true, files: [] }; } });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js', dir);
  review.willReview('t1', { event: 'Stop' });
  assert.equal(await review.onStop('t1', { event: 'Stop' }, controller.signal), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(sent.map(([, , r]) => r.state), ['aborted']);
});

test('la salida hacia OpenAI se anota antes de enviar nada', async (t) => {
  const dir = gitRepo(t);
  let seenAtStart = null;
  const fixture = makeReview(t, { reviewChanges: () => { seenAtStart = fixture.records.length; return { ok: false, code: null, text: '', log: '', seconds: 1, aborted: true }; } });
  const { review, tabs } = fixture;
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js', dir);
  review.willReview('t1', { event: 'Stop' });
  await review.onStop('t1', { event: 'Stop' });
  assert.equal(seenAtStart, 1);
});


test('lo que encuentre Codex en un turno ya pasado no se le devuelve a Claude', async (t) => {
  const dir = gitRepo(t);
  let finish;
  const { review, tabs, sent } = makeReview(t, { reviewChanges: () => new Promise((resolve) => { finish = resolve; }) });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js', dir);
  review.willReview('t1', { event: 'Stop' });
  const pending = review.onStop('t1', { event: 'Stop' });
  await new Promise((r) => setImmediate(r));
  review.turnStarted('t1', 'Otra cosa'); // el usuario ya ha seguido
  finish({ ok: true, code: 0, text: SAMPLE, log: '', seconds: 30, aborted: false });
  assert.equal(await pending, null); // sin «block»
  assert.deepEqual(sent.map(([, , r]) => r.state), ['running']);
});

test('si el turno cambia mientras se comprueba, Codex no llega a lanzarse', async (t) => {
  const dir = gitRepo(t);
  const fixture = makeReview(t, { checkSecrets: async () => { fixture.review.turnStarted('t1', 'nuevo'); return { ok: true, files: [] }; } });
  const { review, tabs, calls } = fixture;
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js', dir);
  review.willReview('t1', { event: 'Stop' });
  assert.equal(await review.onStop('t1', { event: 'Stop' }), null);
  assert.equal(calls.length, 0);
});

test('en Windows, el mismo repositorio escrito con otras mayúsculas es el mismo', { skip: process.platform !== 'win32' && 'solo en Windows' }, async (t) => {
  const dir = gitRepo(t);
  const { review, tabs, calls } = makeReview(t);
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', path.join(dir, 'a.js'));
  review.toolUsed('t1', 'Edit', path.join(dir.toUpperCase(), 'a.js'));
  assert.equal(review.willReview('t1', { event: 'Stop' }), true);
  await review.onStop('t1', { event: 'Stop' });
  assert.equal(calls.length, 1);
});
