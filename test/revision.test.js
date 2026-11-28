// Codex como segundo revisor (src/main/review.js y la parte de src/main/codex.js que lo lanza).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createReview, EARLY_NOTE, FOLLOW_NOTE, FOLLOW_SOON, isGitRepo, repoRoot, reasonFor, verdict, WRAPUP_START } = require('../src/main/review');
const { parseReview, opinionPrompt, planPrompt, lastAgentMessage, lineReader, SCOPES, OPINION_TOOL, ISOLATED, launcher, userSetting, limitsFrom, accessReport, sandboxConfigured } = require('../src/main/codex');
const { Tabs } = require('../src/main/tabs');
const { tempDir, waitFor } = require('./helpers');

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
  const none = 'I could not find any issues with this change.';
  assert.equal(verdict(parseReview(none), none).state, 'clean'); // no encontrar problemas es un veredicto
  const ask = 'Please provide the diff you want me to review.';
  assert.equal(verdict(parseReview(ask), ask).state, 'unclear');
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

function makeReview(t, { enabled = true, usable = true, result = null, detailed = true, reviewChanges = null, checkSecrets = null, checkLogin = null, askCodex = null } = {}) {
  const saved = { codexReview: enabled };
  const sent = [];
  const logs = [];
  const records = [];
  const calls = [];
  const busy = [];
  const tabs = new Tabs();
  const logs_ = tempDir(t);
  const review = createReview({
    tabs,
    store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } },
    usable: () => usable,
    codex: {
      parseReview, opinionPrompt, planPrompt, SCOPES,
      askCodex: async (opts) => { calls.push({ ask: opts }); return askCodex ? askCodex(opts) : { ok: true, text: 'Opinión de Codex: falta el paso de las pruebas.', seconds: 12, aborted: false }; },
      reviewChanges: async (opts) => { calls.push(opts); if (reviewChanges) return reviewChanges(opts); return result || { ok: true, code: 0, text: SAMPLE, log: 'registro', seconds: 37, aborted: false }; },
    },
    send: (...args) => sent.push(args),
    log: (text) => logs.push(text),
    logsDir: () => logs_,
    detailedLogs: () => detailed,
    ...(checkSecrets ? { checkSecrets } : {}),
    ...(checkLogin ? { checkLogin } : {}),
    onBusy: (delta) => { busy.push(delta); },
    netlog: () => ({ record: (entry) => records.push(entry) }),
  });
  return { review, tabs, saved, sent, logs, records, calls, busy, logsDir: logs_ };
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
  assert.match(answer.reason, /Codex \(gpt-6\.2-astra, razonamiento medium\)/); // un cambio pequeño: razonamiento medio
  assert.equal(calls[0].cwd, dir);
  assert.equal(calls[0].model, 'gpt-6.2-astra');
  assert.equal(calls[0].effort, 'medium'); // el que se dice es el que se usa
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

// Un turno listo para revisar en un repositorio con un cambio.
function armed(t, options) {
  const dir = gitRepo(t);
  const fixture = makeReview(t, options);
  fixture.tabs.ensure('t1').folder = dir;
  fixture.review.turnStarted('t1', 'Cambia a');
  fixture.review.toolUsed('t1', 'Edit', 'a.js', dir);
  fixture.review.willReview('t1', { event: 'Stop' });
  return { ...fixture, dir };
}

test('sin cambios que revisar, o apagado mientras se comprobaba, no se lanza Codex', async (t) => {
  const empty = armed(t, { checkSecrets: async () => ({ ok: true, files: [], empty: true }) });
  assert.equal(await empty.review.onStop('t1', { event: 'Stop' }), null);
  assert.equal(empty.calls.length, 0);
  assert.deepEqual(empty.sent.map(([, , r]) => r.state), ['nothing']);
  const fixture = armed(t, { checkSecrets: async () => { fixture.review.enabled = false; return { ok: true, files: [] }; } });
  assert.equal(await fixture.review.onStop('t1', { event: 'Stop' }), null);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.records.length, 0); // no ha salido nada
});

test('si Codex no tiene ahora la sesión de ChatGPT, no se revisa', async (t) => {
  const { review, calls, sent, records } = armed(t, { checkLogin: async () => false });
  assert.equal(await review.onStop('t1', { event: 'Stop' }), null);
  assert.equal(calls.length, 0);
  assert.equal(records.length, 0);
  assert.match(sent[0][2].reason, /sesión de tu cuenta de ChatGPT/);
});

test('con el turno sin revisión, las ediciones no se siguen', (t) => {
  const { review, tabs } = makeReview(t, { enabled: false });
  tabs.ensure('t1').folder = 'C:\\x';
  review.turnStarted('t1', 'hola');
  review.toolUsed('t1', 'Edit', 'a.js');
  assert.equal(tabs.get('t1').edited, false);
  assert.equal(tabs.get('t1').reviewRepo, undefined); // ni se busca el repositorio
});

test('lo que se le pide a Codex: solo lectura, el ámbito, y el plan con la petición', () => {
  const opinion = opinionPrompt({ question: '¿Uso colas o un cron?', scope: 'seguridad', files: ['src/a.js', '', 7] });
  assert.match(opinion, /solo lectura/);
  assert.match(opinion, /no cambies nada/);
  assert.match(opinion, /Ámbito: seguridad/);
  assert.match(opinion, /- src\/a\.js/);
  assert.match(opinion, /en qué discrepas/);
  assert.match(opinionPrompt({ question: 'x', scope: 'raro' }), /Ámbito: otro/);
  const plan = planPrompt({ request: 'Añade login', plan: '1. Crear tabla' });
  assert.match(plan, /todavía no se lo ha presentado/);
  assert.match(plan, /Petición del usuario:\nAñade login/);
  assert.match(plan, /Plan de Claude:\n1\. Crear tabla/);
  assert.deepEqual(Object.keys(SCOPES), OPINION_TOOL.inputSchema.properties.ambito.enum);
  assert.deepEqual(OPINION_TOOL.inputSchema.required, ['pregunta']);
});

test('del registro de Codex se saca su último mensaje o su error', () => {
  const out = [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Primero.' } }),
    'no es json',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '  Mi opinión final.  ' } }),
  ].join('\n');
  assert.deepEqual(lastAgentMessage(out), { message: 'Mi opinión final.', failure: '' });
  assert.deepEqual(lastAgentMessage(JSON.stringify({ type: 'turn.failed', error: { message: 'límite de uso' } })), { message: '', failure: 'límite de uso' });
});

test('la salida de Codex se lee por líneas sin guardarla entera', () => {
  const lines = [];
  const reader = lineReader((line) => lines.push(line));
  reader.push('{"a":1}\r\n{"b"');
  reader.push(':2}\nsin final');
  reader.end();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', 'sin final']);
  // Una línea enorme (la salida de un comando que vuelca megas) se salta entera, y se sigue.
  const big = [];
  const r2 = lineReader((line) => big.push(line.length > 20 ? 'ENORME' : line));
  r2.push('antes\n');
  for (let i = 0; i < 9; i += 1) r2.push('x'.repeat(1024 * 1024));
  r2.push('resto de la enorme\ndespués\n');
  r2.end();
  assert.deepEqual(big, ['antes', 'después']);
});

// Una pestaña con un turno empezado, en una carpeta de verdad.
function started(t, options, request = 'Añade un inicio de sesión') {
  const fixture = makeReview(t, options);
  const dir = tempDir(t);
  fixture.tabs.ensure('t1').folder = dir;
  fixture.review.turnStarted('t1', request.slice(0, 80), request);
  return { ...fixture, dir };
}

test('con «Codex asesora», cada plan se critica antes de presentarlo, una vez por turno', async (t) => {
  const { review, calls, sent, records, busy, dir } = started(t);
  const answer = await review.onPlan('t1', { plan: '1. Crear la tabla de usuarios\n2. Añadir el formulario' });
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /falta el paso de las pruebas/);
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /Segunda opinión \(Codex\)/);
  assert.equal(calls[0].ask.cwd, dir);
  assert.match(calls[0].ask.prompt, /Petición del usuario:\nAñade un inicio de sesión/);
  assert.match(calls[0].ask.prompt, /1\. Crear la tabla de usuarios/);
  assert.equal(calls[0].ask.model, 'gpt-6.2-astra');
  assert.deepEqual(sent.map(([, , r]) => r.state), ['plan-running', 'plan-done']);
  assert.equal(records[0].external, true);
  assert.deepEqual(busy, [1, -1]);
  // Claude lo ajusta y lo vuelve a presentar: ya no se critica.
  assert.equal(await review.onPlan('t1', { plan: '1. Crear la tabla\n2. Pruebas\n3. Formulario' }), null);
  assert.equal(calls.length, 1);
});

test('la crítica del plan no se hace sin «Codex asesora», con claves en el plan o si Codex falla', async (t) => {
  const off = started(t, { enabled: false });
  assert.equal(await off.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.equal(off.calls.length, 0);
  const secret = started(t);
  assert.equal(await secret.review.onPlan('t1', { plan: `1. Poner password = "${'Hosp'}ital2024!" en config.js` }), null);
  assert.equal(secret.calls.length, 0);
  assert.deepEqual(secret.sent.map(([, , r]) => r.state), ['plan-secret']);
  const failing = started(t, { askCodex: () => ({ ok: false, text: '', failure: 'límite de uso', seconds: 3, aborted: false }) });
  assert.equal(await failing.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.deepEqual(failing.sent.map(([, , r]) => r.state), ['plan-running', 'plan-error']);
  const noLogin = started(t, { checkLogin: async () => false });
  assert.equal(await noLogin.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.equal(noLogin.calls.length, 0);
  assert.equal(await started(t).review.onPlan('t1', { plan: '   ' }), null); // sin plan
});

test('la segunda opinión responde con el análisis de Codex y le pide a Claude que lo contraste', async (t) => {
  const { review, calls, sent, records, busy, dir } = started(t);
  const text = await review.secondOpinion('t1', { pregunta: '¿Separo esto en dos servicios?', ambito: 'codigo', archivos: ['src/app.js'] });
  assert.match(text, /Segunda opinión de Codex \(gpt-6\.2-astra, razonamiento high, 12 s\)/); // de código, sin profundidad pedida: alto
  assert.match(text, /falta el paso de las pruebas/);
  assert.match(text, /no la sigas a ciegas/);
  assert.equal(calls[0].ask.cwd, dir);
  assert.match(calls[0].ask.prompt, /Ámbito: código/);
  assert.match(calls[0].ask.prompt, /- src\/app\.js/);
  assert.deepEqual(sent.map(([, , r]) => r.state), ['opinion-running', 'opinion-done']);
  assert.match(records[0].target, /Segunda opinión/);
  assert.deepEqual(busy, [1, -1]);
});

test('la segunda opinión no se pide sin pregunta, con claves, sin la cuenta de ChatGPT o si falla', async (t) => {
  const base = started(t);
  await assert.rejects(base.review.secondOpinion('t1', {}), /Falta la pregunta/);
  await assert.rejects(base.review.secondOpinion('t1', { pregunta: `La contraseña es password = "${'Hosp'}ital2024!"` }), /clave o contraseña/);
  await assert.rejects(base.review.secondOpinion('otra', { pregunta: 'x' }), /ya no está abierta/);
  assert.equal(base.calls.length, 0);
  await assert.rejects(started(t, { checkLogin: async () => false }).review.secondOpinion('t1', { pregunta: 'x' }), /cuenta de ChatGPT/);
  await assert.rejects(started(t, { usable: false }).review.secondOpinion('t1', { pregunta: 'x' }), /cuenta de ChatGPT/);
  const failing = started(t, { askCodex: () => ({ ok: false, text: '', failure: 'límite de uso', seconds: 3, aborted: false }) });
  await assert.rejects(failing.review.secondOpinion('t1', { pregunta: 'x' }), /no ha podido responder: límite de uso/);
  const cancelled = started(t, { askCodex: () => ({ ok: false, text: '', failure: '', seconds: 3, aborted: true }) });
  await assert.rejects(cancelled.review.secondOpinion('t1', { pregunta: 'x' }), /cancelado/);
});

test('con «Codex asesora» apagado no se le consulta nada a Codex', async (t) => {
  const off = started(t, { enabled: false });
  await assert.rejects(off.review.secondOpinion('t1', { pregunta: '¿Qué hago?' }), /apagado el asesoramiento/);
  assert.equal(await off.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.equal(off.calls.length, 0);
  assert.equal(off.records.length, 0);
  // Apagarlo vale al momento, también a mitad de turno.
  const on = started(t);
  on.review.enabled = false;
  await assert.rejects(on.review.secondOpinion('t1', { pregunta: 'x' }), /apagado/);
  assert.equal(await on.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.equal(on.calls.length, 0);
});

test('«Codex asesora» viene apagado: lo enciende el usuario si quiere usar Codex', () => {
  const make = (saved) => createReview({ tabs: new Tabs(), store: { get: (k, f) => (k in saved ? saved[k] : f), set: () => {} }, usable: () => true, codex: {}, send: () => {}, log: () => {}, logsDir: () => '' });
  assert.equal(make({}).enabled, false);
  assert.equal(make({ codexReview: false }).enabled, false);
  assert.equal(make({ codexReview: true }).enabled, true);
});

test('Codex trabaja aislado: sin la configuración ni las reglas del usuario, sin control del ordenador ni imágenes', () => {
  assert.ok(ISOLATED.includes('--ignore-user-config'));
  assert.ok(ISOLATED.includes('--ignore-rules'));
  for (const feature of ['computer_use', 'browser_use', 'apps', 'image_generation']) {
    assert.equal(ISOLATED[ISOLATED.indexOf(`features.${feature}=false`) - 1], '-c', feature); // con -c: si no existe en otra versión, se ignora
  }
  assert.ok(!ISOLATED.includes('--disable'));
});

test('con la instalación de npm, Codex se lanza sin cmd.exe', (t) => {
  const dir = tempDir(t);
  const cmd = path.join(dir, 'codex.cmd');
  fs.writeFileSync(cmd, '@echo off');
  assert.equal(launcher(cmd).shell, true); // sin su codex.js al lado: a través del intérprete
  const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  assert.deepEqual(launcher(cmd), { command: path.join(dir, 'node.exe'), prefix: [script], shell: false });
  assert.deepEqual(launcher('C:\\x\\codex.exe'), { command: 'C:\\x\\codex.exe', prefix: [], shell: false });
});

test('las rutas de la segunda opinión también se miran por si llevan claves', async (t) => {
  const { review, calls } = started(t);
  await assert.rejects(review.secondOpinion('t1', { pregunta: '¿Está bien esta conexión?', archivos: [`postgres://admin:${'Hosp'}ital2024@10.0.0.5/db`] }), /clave o contraseña/);
  // Un carácter nulo no esconde una clave.
  await assert.rejects(review.secondOpinion('t1', { pregunta: `\0 password = "${'Hosp'}ital2024!"` }), /clave o contraseña/);
  assert.equal(calls.length, 0);
  const plan = started(t);
  plan.review.turnStarted('t1', 'x', '\0');
  assert.equal(await plan.review.onPlan('t1', { plan: `1. Poner password = "${'Hosp'}ital2024!"` }), null);
  assert.deepEqual(plan.sent.map(([, , r]) => r.state), ['plan-secret']);
});

test('si se cancela mientras se comprueba la cuenta, no se pregunta a Codex', async (t) => {
  const controller = new AbortController();
  const { review, calls, records } = started(t, { checkLogin: async () => { controller.abort(); return true; } });
  await assert.rejects(review.secondOpinion('t1', { pregunta: 'x' }, controller.signal), /cancelado/);
  assert.equal(calls.length, 0);
  assert.equal(records.length, 0);
});

test('el plan se critica en la carpeta en la que trabaja Claude, y uno demasiado grande se avisa', async (t) => {
  const { review, calls } = started(t);
  const other = tempDir(t);
  await review.onPlan('t1', { plan: '1. Algo', cwd: other });
  assert.equal(calls[0].ask.cwd, other);
  const big = started(t);
  assert.equal(await big.review.onPlan('t1', { plan: null, planTooBig: true }), null);
  assert.deepEqual(big.sent.map(([, , r]) => r), [{ state: 'plan-error', reason: 'big' }]);
  assert.equal(big.calls.length, 0);
});

test('al apagar «Codex asesora», lo que está en marcha se para y no se usa', async (t) => {
  const fixture = started(t, { askCodex: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ok: false, text: '', failure: '', seconds: 4, aborted: true }));
  }) });
  const pending = fixture.review.secondOpinion('t1', { pregunta: '¿Qué hago?' });
  await new Promise((r) => setTimeout(r, 20));
  fixture.review.enabled = false;
  await assert.rejects(pending, /apagado el asesoramiento de Codex mientras respondía/);
  // La crítica del plan, igual: no llega a Claude.
  const plan = started(t, { askCodex: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ ok: false, text: '', failure: '', seconds: 4, aborted: true }));
  }) });
  const answer = plan.review.onPlan('t1', { plan: '1. Algo' });
  await new Promise((r) => setTimeout(r, 20));
  plan.review.enabled = false;
  assert.equal(await answer, null);
  assert.equal(plan.sent[plan.sent.length - 1][2].state, 'aborted');
});

test('los archivos que se le señalan a Codex se miran antes, y un YAML pegado también', async (t) => {
  const { review, dir, calls } = started(t);
  fs.writeFileSync(path.join(dir, 'config.yml'), `db:\n  password: ${'Kx9m'}P2vLq\n`);
  fs.writeFileSync(path.join(dir, 'grande.txt'), 'x'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = 1;\n');
  await assert.rejects(review.secondOpinion('t1', { pregunta: '¿Está bien la configuración?', archivos: ['app.js', 'config.yml'] }), /config\.yml lleva lo que parece una clave/);
  await assert.rejects(review.secondOpinion('t1', { pregunta: 'x', archivos: ['grande.txt'] }), /demasiado grande/);
  await assert.rejects(review.secondOpinion('t1', { pregunta: `Mira esto:\ndb:\n  password: ${'Kx9m'}P2vLq` }), /clave o contraseña/);
  assert.equal(calls.length, 0);
  await review.secondOpinion('t1', { pregunta: 'x', archivos: ['app.js', 'no-existe.js'] }); // limpio: sí
  assert.equal(calls.length, 1);
});

test('la segunda opinión se pide en la carpeta del agente que la pide', async (t) => {
  const { review, tabs, calls } = started(t);
  const other = tempDir(t);
  tabs.get('t1').cwd = tempDir(t); // un aviso posterior, de otro agente
  tabs.get('t1').opinionCwd = other;
  await review.secondOpinion('t1', { pregunta: 'x' });
  assert.equal(calls[0].ask.cwd, other);
});

test('de la configuración del usuario se conservan solo su almacén de sesión y su zona protegida de Windows', () => {
  const toml = ['model = "gpt-6.2-sol"', 'cli_auth_credentials_store = "keyring"', '', '[windows]', 'sandbox = "elevated"', '', '[mcp_servers.node_repl]', 'command = "x"', 'sandbox = "otro"'].join('\n');
  assert.equal(userSetting(toml, null, 'cli_auth_credentials_store'), 'keyring');
  assert.equal(userSetting(toml, 'windows', 'sandbox'), 'elevated');
  assert.equal(userSetting(toml, null, 'sandbox'), null); // fuera de [windows] no cuenta
  assert.equal(userSetting('', 'windows', 'sandbox'), null);
});

test('del uso de la cuenta de Codex se toma el límite semanal', () => {
  const week = { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1795690311 };
  assert.deepEqual(limitsFrom({ ordinaryUsageAllowed: true, rateLimits: { primary: week, secondary: null, planType: 'prolite', rateLimitReachedType: null } }),
    { pct: 7, resetsAt: 1795690311000, windowMins: 10080, plan: 'prolite', reached: false, reachedWindow: null, other: null });
  // Con dos ventanas, la semanal es la principal aunque venga en segundo lugar.
  const five = { usedPercent: 40, windowDurationMins: 300, resetsAt: 1795600000 };
  const both = limitsFrom({ rateLimits: { primary: five, secondary: week, planType: 'plus' } });
  assert.equal(both.pct, 7);
  assert.equal(both.other.pct, 40);
  // Límite alcanzado, o uso no permitido.
  assert.equal(limitsFrom({ rateLimits: { primary: week, rateLimitReachedType: 'rate_limit_reached' } }).reached, true);
  // Agotada la de 5 horas: se dice cuándo se renueva esa, no la semanal.
  const full5 = limitsFrom({ rateLimits: { primary: { ...five, usedPercent: 100 }, secondary: week, rateLimitReachedType: 'rate_limit_reached' } });
  assert.deepEqual([full5.pct, full5.reachedWindow.windowMins, full5.reachedWindow.resetsAt], [7, 300, 1795600000000]);
  // Las dos agotadas: la renovación más tardía (la semanal).
  const both100 = limitsFrom({ rateLimits: { primary: { ...five, usedPercent: 100 }, secondary: { ...week, usedPercent: 100 }, rateLimitReachedType: 'rate_limit_reached' } });
  assert.equal(both100.reachedWindow.windowMins, 10080);
  assert.equal(limitsFrom({ ordinaryUsageAllowed: false, rateLimits: { primary: week } }).reached, true);
  // Sin datos.
  assert.equal(limitsFrom(null), null);
  assert.equal(limitsFrom({ rateLimits: { primary: null, secondary: null } }), null);
  assert.equal(limitsFrom({ rateLimitsByLimitId: { codex: { primary: week } } }).pct, 7);
});

test('se reconoce cuando a Codex le bloquean la lectura, contando comandos y no frases', () => {
  const rejected = '2026-11-22T13:59:27Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(git status) rejected: blocked by policy" }';
  assert.deepEqual(accessReport('', rejected), { blocked: true, partial: false });
  // Unos sí y otros no: lectura parcial.
  assert.deepEqual(accessReport('', `${rejected}\nexec\ngit diff in C:\\x\n succeeded in 52ms:\n`), { blocked: false, partial: true });
  // Registro JSON: un acceso denegado, sin nada que funcione.
  const denied = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: "Access to the path 'C:\\x\\suma.js' is denied." } });
  assert.deepEqual(accessReport(denied, ''), { blocked: true, partial: false });
  // Leer un archivo (o un diff) que dice «blocked by policy» no es un bloqueo.
  const read = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, aggregated_output: 'const DENIED = /blocked by policy|is denied/;' } });
  const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Nada fue blocked by policy.' } });
  assert.deepEqual(accessReport(`${read}\n${message}`, 'warning: unable to access ignore: Permission denied'), { blocked: false, partial: false });
});

test('en Windows se sabe si Codex tiene configurada su zona protegida', (t) => {
  const home = tempDir(t);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; });
  if (process.platform !== 'win32') { assert.equal(sandboxConfigured(), true); return; }
  assert.equal(sandboxConfigured(), false); // sin config.toml
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');
  assert.equal(sandboxConfigured(), false);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[windows]\nsandbox = "elevated"\n');
  assert.equal(sandboxConfigured(), true);
});

test('si Codex no puede leer el proyecto, se avisa y no se da nada por bueno', async (t) => {
  // Revisión: no se da por revisada.
  const dir = gitRepo(t);
  const rev = makeReview(t, { result: { ok: true, code: 0, text: 'Repository reads were blocked, so I could not inspect the changes.', log: 'rejected: blocked by policy', seconds: 9, aborted: false, blocked: true } });
  rev.tabs.ensure('t1').folder = dir;
  rev.review.turnStarted('t1', 'Cambia a');
  rev.review.toolUsed('t1', 'Edit', 'a.js', dir);
  rev.review.willReview('t1', { event: 'Stop' });
  assert.equal(await rev.review.onStop('t1', { event: 'Stop' }), null);
  assert.equal(rev.sent[rev.sent.length - 1][2].state, 'blocked');
  // Plan: pasa sin crítica.
  const blockedAsk = () => ({ ok: true, text: 'No pude leer nada.', seconds: 5, aborted: false, blocked: true });
  const plan = started(t, { askCodex: blockedAsk });
  assert.equal(await plan.review.onPlan('t1', { plan: '1. Algo' }), null);
  assert.deepEqual(plan.sent.map(([, , r]) => r.state), ['plan-running', 'blocked']);
  // Segunda opinión: se le dice a Claude que Codex no ha visto el código.
  const op = started(t, { askCodex: blockedAsk });
  const text = await op.review.secondOpinion('t1', { pregunta: '¿Qué hago?' });
  assert.match(text, /^Aviso: Codex no ha podido leer los archivos del proyecto/);
  assert.ok(op.sent.some(([, , r]) => r.state === 'blocked'));
});

test('hallazgos sin haber podido leer el proyecto llevan aviso; una lectura parcial, no', async (t) => {
  const dir = gitRepo(t);
  const run = async (extra) => {
    const fx = makeReview(t, { result: { ok: true, code: 0, text: SAMPLE, log: '', seconds: 20, aborted: false, ...extra } });
    fx.tabs.ensure('t1').folder = dir;
    fx.review.turnStarted('t1', 'Cambia a');
    fx.review.toolUsed('t1', 'Edit', 'a.js', dir);
    fx.review.willReview('t1', { event: 'Stop' });
    return { answer: await fx.review.onStop('t1', { event: 'Stop' }), fx };
  };
  const blocked = await run({ blocked: true });
  assert.match(blocked.answer.reason, /^Aviso: Codex no ha podido leer parte del proyecto \(se le ha denegado el acceso/);
  assert.match(blocked.answer.reason, /\[P1\] Await transcript reads/);
  assert.equal(blocked.fx.sent[blocked.fx.sent.length - 1][2].partial, true);
  // Algún comando rechazado y otros bien: habitual, solo al registro.
  const partial = await run({ partial: true });
  assert.ok(!/^Aviso/.test(partial.answer.reason));
  assert.equal(partial.fx.sent[partial.fx.sent.length - 1][2].partial, false);
  assert.match(partial.fx.logs.join('\n'), /pudo leer el proyecto por otra vía/);
});

test('una segunda opinión bloqueada sin respuesta explica el bloqueo', async (t) => {
  const fx = started(t, { askCodex: () => ({ ok: false, text: '', failure: '', seconds: 6, aborted: false, blocked: true }) });
  await assert.rejects(fx.review.secondOpinion('t1', { pregunta: '¿Qué hago?' }), /no ha podido leer el proyecto \(se le ha denegado el acceso a los archivos\)/);
  assert.ok(fx.sent.some(([, , r]) => r.state === 'blocked' && r.op === 'opinion'));
  // Los avisos de bloqueo dicen de qué operación son.
  const plan = started(t, { askCodex: () => ({ ok: true, text: 'x', seconds: 5, aborted: false, blocked: true }) });
  await plan.review.onPlan('t1', { plan: '1. Algo' });
  assert.equal(plan.sent[plan.sent.length - 1][2].op, 'plan');
});

test('tras el recordatorio de pruebas, Codex revisa en el Stop siguiente', (t) => {
  const { review, tabs } = makeReview(t);
  tabs.ensure('t1').folder = 'C:\\x';
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit', 'a.js');
  tabs.get('t1').testsAsked = true; // el primer Stop fue para pedirle las pruebas
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), true);
});

test('con SuperPowers, Codex revisa a la vez que la pasada final y lo encontrado llega al terminarla', async (t) => {
  const dir = gitRepo(t);
  let finish;
  const { review, tabs, calls, logs } = makeReview(t, { reviewChanges: () => new Promise((resolve) => { finish = resolve; }) });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit');
  assert.equal(review.startEarly('t1'), true); // primer Stop: se le pide la pasada y Codex empieza
  assert.equal(review.startEarly('t1'), false); // una sola vez
  await waitFor(() => calls.length === 1);
  assert.ok(logs.some((l) => /a la vez que la pasada final/.test(l)));
  // Claude acaba la pasada (segundo Stop) antes que Codex: se espera a lo que diga.
  tabs.get('t1').superAsked = true;
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), true);
  const pending = review.onStop('t1', { event: 'Stop', cwd: dir }, new AbortController().signal);
  finish({ ok: true, code: 0, text: SAMPLE, log: '', seconds: 30, aborted: false });
  const answer = await pending;
  assert.equal(answer.decision, 'block');
  assert.ok(answer.reason.startsWith(EARLY_NOTE));
  assert.match(answer.reason, /\[P1\] Await transcript reads/);
  assert.equal(calls.length, 1); // no se revisa dos veces
  assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null);
});

test('la revisión lanzada con la pasada no empieza sin motivo y se para si cambia el turno o se interrumpe', async (t) => {
  const dir = gitRepo(t);
  const signals = [];
  const { review, tabs, calls } = makeReview(t, {
    reviewChanges: (opts) => new Promise((resolve) => {
      signals.push(opts.signal);
      opts.signal.addEventListener('abort', () => resolve({ ok: false, aborted: true, code: 1, seconds: 1, text: '', log: '' }));
    }),
  });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Explícame a');
  assert.equal(review.startEarly('t1'), false); // sin editar nada, no
  review.toolUsed('t1', 'Edit');
  assert.equal(review.startEarly('t1'), true);
  await waitFor(() => calls.length === 1);
  review.turnStarted('t1', 'Otra cosa'); // el usuario sigue: la de antes se para
  assert.equal(signals[0].aborted, true);
  // Interrumpido mientras se espera lo que diga Codex: se para y Claude termina sin más.
  review.toolUsed('t1', 'Edit');
  review.startEarly('t1');
  await waitFor(() => calls.length === 2);
  tabs.get('t1').superAsked = true;
  review.willReview('t1', { event: 'Stop', stopHookActive: true });
  const stop = new AbortController();
  const pending = review.onStop('t1', { event: 'Stop', cwd: dir }, stop.signal);
  stop.abort();
  assert.equal(await pending, null);
  assert.equal(signals[1].aborted, true);
  // Con la revisión apagada, tampoco.
  const off = makeReview(t, { enabled: false });
  off.tabs.ensure('t1').folder = dir;
  off.review.turnStarted('t1', 'Cambia a');
  off.review.toolUsed('t1', 'Edit');
  assert.equal(off.review.startEarly('t1'), false);
});

test('si la pasada cambia código, Codex hace una segunda ronda mientras Claude corrige lo de la primera', async (t) => {
  const dir = gitRepo(t);
  const big = { lines: 400, paths: ['a.js'] }; // un cambio grande: la primera ronda va en xhigh
  const replies = [SAMPLE, 'Findings:\n- [P2] Falta validar el valor nuevo — a.js:3\n  Detalle.\n'];
  const { review, tabs, calls } = makeReview(t, {
    checkSecrets: async () => ({ ok: true, files: [], ...big }),
    reviewChanges: async () => ({ ok: true, code: 0, text: replies[calls.length - 1], log: '', seconds: 20, aborted: false }),
  });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Añade los filtros');
  review.toolUsed('t1', 'Edit');
  assert.equal(review.startEarly('t1'), true); // primer Stop: la pasada y la primera ronda a la vez
  review.toolUsed('t1', 'Edit', 'a.js'); // la pasada final cambia código
  tabs.get('t1').superAsked = true;
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), true);
  const first = await review.onStop('t1', { event: 'Stop', cwd: dir });
  assert.ok(first.reason.startsWith(EARLY_NOTE));
  assert.ok(first.reason.includes(FOLLOW_SOON)); // le avisa de que viene otra ronda
  assert.match(first.reason, /\[P1\] Await transcript reads/);
  await waitFor(() => calls.length === 2); // la segunda ya está en marcha mientras Claude corrige
  assert.equal(calls[0].effort, 'xhigh');
  assert.equal(calls[1].effort, 'high'); // un repaso: como mucho «high»
  // Claude termina de corregir: lo de la segunda ronda.
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), true);
  const second = await review.onStop('t1', { event: 'Stop', cwd: dir });
  assert.ok(second.reason.startsWith(FOLLOW_NOTE));
  assert.match(second.reason, /Falta validar el valor nuevo/);
  // Y ahí se acaba: no hay una tercera.
  review.toolUsed('t1', 'Edit', 'a.js');
  assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), false);
  assert.equal(calls.length, 2);
});

test('sin hallazgos en la primera ronda pero con cambios en la pasada, se revisa lo último antes de terminar; sin cambios, no', async (t) => {
  const dir = gitRepo(t);
  const clean = 'The change looks correct.\n';
  const replies = [clean, 'Findings:\n- [P1] Rompe la búsqueda vacía — a.js:1\n  Detalle.\n'];
  const { review, tabs, calls } = makeReview(t, { reviewChanges: async () => ({ ok: true, code: 0, text: replies[calls.length - 1], log: '', seconds: 5, aborted: false }) });
  tabs.ensure('t1').folder = dir;
  review.turnStarted('t1', 'Cambia a');
  review.toolUsed('t1', 'Edit');
  review.startEarly('t1');
  review.toolUsed('t1', 'Edit', 'a.js'); // la pasada cambia código
  tabs.get('t1').superAsked = true;
  review.willReview('t1', { event: 'Stop', stopHookActive: true });
  const answer = await review.onStop('t1', { event: 'Stop', cwd: dir });
  assert.equal(calls.length, 2);
  assert.ok(answer.reason.startsWith(FOLLOW_NOTE));
  assert.match(answer.reason, /Rompe la búsqueda vacía/);
  // Sin cambios en la pasada: una sola ronda, como siempre.
  const other = makeReview(t, { result: { ok: true, code: 0, text: SAMPLE, log: '', seconds: 5, aborted: false } });
  other.tabs.ensure('t1').folder = dir;
  other.review.turnStarted('t1', 'Cambia a');
  other.review.toolUsed('t1', 'Edit');
  other.review.startEarly('t1');
  other.tabs.get('t1').superAsked = true;
  other.review.willReview('t1', { event: 'Stop', stopHookActive: true });
  const only = await other.review.onStop('t1', { event: 'Stop', cwd: dir });
  assert.ok(!only.reason.includes(FOLLOW_SOON));
  assert.equal(other.review.willReview('t1', { event: 'Stop', stopHookActive: true }), false);
  assert.equal(other.calls.length, 1);
});

test('si la revisión de la pasada acaba antes que Claude, al pararse se repite cómo acabó (no se queda en «revisando»)', async (t) => {
  const dir = gitRepo(t);
  const cases = [
    [{ result: { ok: true, code: 0, text: 'The change looks correct.\n', log: '', seconds: 5, aborted: false } }, 'clean'],
    [{ checkSecrets: async () => ({ ok: true, files: ['test_x.py'] }) }, 'secret'],
  ];
  for (const [opts, state] of cases) {
    const { review, tabs, sent } = makeReview(t, opts);
    tabs.ensure('t1').folder = dir;
    review.turnStarted('t1', 'Cambia a');
    review.toolUsed('t1', 'Edit');
    review.startEarly('t1');
    await waitFor(() => sent.some(([, , r]) => r.state === state)); // acaba mientras Claude hace la pasada
    const before = sent.length;
    tabs.get('t1').superAsked = true;
    assert.equal(review.willReview('t1', { event: 'Stop', stopHookActive: true }), true); // la pestaña pasa a «revisando»
    assert.equal(await review.onStop('t1', { event: 'Stop', cwd: dir }), null);
    assert.equal(sent.length, before + 1, state);
    assert.equal(sent[sent.length - 1][2].state, state); // y se le vuelve a decir cómo acabó
  }
});
