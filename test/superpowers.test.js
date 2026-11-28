// SuperPowers por pestaña (src/main/superpowers.js): la pasada final del Stop, el aviso de cómo
// trabajar y, con review.js, la revisión final de Codex aunque «Codex asesora» esté apagado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSuperpowers, NOTE_ON, NOTE_OFF } = require('../src/main/superpowers');
const { createReview, WRAPUP_START } = require('../src/main/review');
const { Tabs } = require('../src/main/tabs');

function make({ on = true } = {}) {
  const tabs = new Tabs();
  let clock = 1000;
  const sp = createSuperpowers({ tabs, now: () => clock });
  tabs.ensure('t1').superpowers = on;
  return { sp, tabs, tick: (ms) => { clock += ms; } };
}

test('la pasada final se pide una vez por turno, solo si ha cambiado algo y nunca al cerrar', () => {
  const { sp, tabs } = make();
  sp.turnStarted('t1', 'Explícame el código');
  sp.toolUsed('t1', 'Read', 'a.js');
  sp.toolUsed('t1', 'Bash');
  assert.equal(sp.willAsk('t1'), false); // no ha cambiado nada

  sp.turnStarted('t1', 'Arregla el cálculo');
  sp.toolUsed('t1', 'Edit', 'src/calc.js');
  assert.equal(sp.willAsk('t1'), true);
  assert.equal(tabs.get('t1').superAsked, true); // la revisión de Codex lo mira
  assert.equal(sp.willAsk('t1'), false); // ya se le ha pedido en este turno

  sp.turnStarted('t1', `${WRAPUP_START} Resume lo hecho.`);
  sp.toolUsed('t1', 'Write', 'NOTAS.md');
  assert.equal(sp.willAsk('t1'), false); // el turno de cerrar la sesión no tiene pasada
});

test('apagado no pide nada ni apunta lo visual; solo que ha cambiado algo, para comparar', () => {
  const { sp, tabs } = make({ on: false });
  sp.turnStarted('t1', 'Cambia el color');
  sp.toolUsed('t1', 'Edit', 'estilo.css');
  sp.toolUsed('t1', sp.CAPTURE_TOOL);
  assert.equal(sp.willAsk('t1'), false);
  assert.equal(tabs.get('t1').spEdited, true);
  assert.deepEqual(tabs.get('t1').spVisual, []);
  assert.equal(tabs.get('t1').spCaptures, 0);
});

test('la medida de cada tarea: con o sin SuperPowers, lo que tarda y si la pasada corrigió algo', () => {
  const { sp, tabs, tick } = make();
  sp.turnStarted('t1', 'Explica el código');
  assert.equal(sp.turnEnded('t1', 'none'), null); // sin cambios no cuenta
  sp.turnStarted('t1', 'Arregla el cálculo');
  sp.toolUsed('t1', 'Edit', 'calc.js');
  sp.willAsk('t1');
  sp.toolUsed('t1', 'Edit', 'calc.js'); // la pasada encuentra algo y lo corrige
  tick(90_000);
  assert.deepEqual(sp.turnEnded('t1', 'ok'), { mode: 'with', seconds: 90, fixed: true, tests: 'ok' });
  assert.equal(sp.turnEnded('t1', 'ok'), null); // una vez por turno
  tabs.get('t1').superpowers = false;
  sp.turnStarted('t1', 'Otra cosa');
  sp.toolUsed('t1', 'Write', 'b.js');
  tick(30_000);
  assert.deepEqual(sp.turnEnded('t1', 'pending'), { mode: 'without', seconds: 30, fixed: false, tests: 'pending' });
});

test('la respuesta lleva lo pedido y, si ha cambiado algo visual, las capturas con sus archivos', () => {
  const { sp } = make();
  sp.turnStarted('t1', 'p', 'Pon el botón de enviar en verde y que valide el correo');
  sp.toolUsed('t1', 'Edit', 'C:\\web\\estilo.css');
  sp.toolUsed('t1', 'Edit', 'C:\\web\\form.js');
  sp.toolUsed('t1', 'MultiEdit', 'C:\\web\\estilo.css'); // repetido: una sola vez
  assert.equal(sp.willAsk('t1'), true);
  const answer = sp.answer('t1');
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /Pon el botón de enviar en verde y que valide el correo/);
  assert.match(answer.reason, /\(estilo\.css\)/);
  assert.match(answer.reason, /390, 1024 y 1440/);
  assert.match(answer.reason, /Pasada final/);
  assert.match(answer.reason, /hasta tres mejoras/);

  sp.turnStarted('t1', 'Suma bien');
  sp.toolUsed('t1', 'Edit', 'calc.py');
  sp.willAsk('t1');
  assert.doesNotMatch(sp.answer('t1').reason, /Has cambiado archivos que se ven/);
});

test('el resumen sale de lo visto (pruebas, capturas, Codex) y una sola vez', () => {
  const { sp, tick } = make();
  sp.turnStarted('t1', 'Rediseña la cabecera');
  sp.toolUsed('t1', 'Edit', 'cabecera.html');
  assert.equal(sp.summary('t1', { tests: 'ok' }), null); // aún no hay pasada
  sp.willAsk('t1');
  tick(42_000);
  let pass = sp.summary('t1', { tests: 'ok', codex: true });
  assert.deepEqual(pass, { tests: 'ok', captures: 'missing', captured: 0, visual: ['cabecera.html'], codex: true, seconds: 42 });
  assert.equal(sp.summary('t1', { tests: 'ok' }), null); // ya se ha dado

  sp.turnStarted('t1', 'Rediseña el pie');
  sp.toolUsed('t1', 'Edit', 'pie.vue');
  sp.willAsk('t1');
  sp.captured('t1', 3); // una llamada a capturar_pantalla con sus tres anchos
  pass = sp.summary('t1', { tests: 'none' });
  assert.equal(pass.captures, 'ok');
  assert.equal(pass.captured, 3);

  // Una captura de antes del cambio visual no enseña cómo ha quedado; y lo visual que se cambia
  // en la propia pasada también cuenta.
  sp.turnStarted('t1', 'Ajusta el menú');
  sp.captured('t1', 3);
  sp.toolUsed('t1', 'Edit', 'menu.css');
  sp.willAsk('t1');
  sp.toolUsed('t1', 'Edit', 'menu.html');
  pass = sp.summary('t1', { tests: 'ok' });
  assert.equal(pass.captures, 'missing');
  assert.deepEqual(pass.visual, ['menu.css', 'menu.html']);

  sp.turnStarted('t1', 'Arregla el cálculo');
  sp.toolUsed('t1', 'Edit', 'calc.js');
  sp.willAsk('t1');
  assert.equal(sp.summary('t1', { tests: 'failing' }).captures, 'skip'); // nada visual: no hacía falta
});

test('el aviso de cómo trabajar: una vez, otra tras /clear o al resumirse, y «apagado» al quitarlo', () => {
  const { sp, tabs } = make();
  const say = (sessionId = 's1', prompt = 'hola') => sp.note('t1', { prompt, sessionId });
  sp.sessionStarted('t1');
  assert.equal(say(), NOTE_ON);
  assert.equal(say(), null); // ya lo sabe
  assert.equal(say('s2'), NOTE_ON); // /clear: otra conversación
  sp.compacted('t1');
  assert.equal(say('s2'), NOTE_ON); // resumida: puede haberse quedado fuera
  assert.equal(say('s2', `${WRAPUP_START} …`), null); // al cerrar, no

  // Se apaga: la sesión se reinicia retomando la misma conversación, que lleva el aviso.
  tabs.get('t1').superpowers = false;
  sp.sessionStarted('t1');
  assert.equal(say('s2'), NOTE_OFF);
  assert.equal(say('s2'), null);
  // Al reiniciar, la app olvida lo de la pestaña (tabs.forget), pero la conversación retomada
  // sigue llevando el aviso de «activado»: se le dice que se ha apagado.
  tabs.get('t1').superpowers = true;
  sp.sessionStarted('t1');
  assert.equal(say('s3'), NOTE_ON);
  tabs.forget('t1');
  tabs.ensure('t1').superpowers = false;
  sp.sessionStarted('t1');
  assert.equal(say('s3'), NOTE_OFF);
  // Una conversación que nunca lo oyó no necesita que se le diga que está apagado.
  sp.sessionStarted('t1');
  assert.equal(say('s9'), null);
});

test('el aviso se repite en una conversación larga', () => {
  const { sp } = make();
  assert.equal(sp.note('t1', { prompt: 'a', sessionId: 's1' }), NOTE_ON);
  let again = 0;
  for (let i = 0; i < 31; i += 1) if (sp.note('t1', { prompt: 'a', sessionId: 's1' }) === NOTE_ON) again += 1;
  assert.equal(again, 1);
});

test('con SuperPowers, Codex revisa al final aunque «Codex asesora» esté apagado, y tras la pasada', () => {
  const tabs = new Tabs();
  const saved = { codexReview: false };
  const review = createReview({
    tabs,
    store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } },
    usable: () => true,
    codex: {},
    send: () => {},
    log: () => {},
    logsDir: () => '.',
    extraFor: (tabId) => Boolean((tabs.get(tabId) || {}).superpowers),
  });
  const sp = createSuperpowers({ tabs });
  const tab = tabs.ensure('t1');
  tab.folder = process.cwd();
  const turn = (text) => { review.turnStarted('t1', text); sp.turnStarted('t1', text); };
  const edit = (file) => { review.toolUsed('t1', 'Edit', file, process.cwd()); sp.toolUsed('t1', 'Edit', file); };

  // Sin SuperPowers y con «Codex asesora» apagado: no se revisa.
  turn('Arregla el cálculo');
  edit('src/main/superpowers.js');
  assert.equal(review.willReview('t1', { stopHookActive: false }), false);

  // Con SuperPowers: primer Stop, la pasada; el siguiente (stopHookActive), la revisión.
  tab.superpowers = true;
  turn('Arregla el cálculo');
  edit('src/main/superpowers.js');
  assert.equal(sp.willAsk('t1'), true);
  assert.equal(review.willReview('t1', { stopHookActive: true }), true);

  // Otra pestaña sin SuperPowers sigue sin revisión.
  const other = tabs.ensure('t2');
  other.folder = process.cwd();
  review.turnStarted('t2', 'Arregla');
  review.toolUsed('t2', 'Edit', 'src/main/superpowers.js', process.cwd());
  assert.equal(review.willReview('t2', { stopHookActive: false }), false);
});

test('al arrancar: esfuerzo alto como mínimo y hasta dos agentes, salvo lo que ya tenga el usuario', () => {
  const { powerEffort, powerEnv } = require('../src/main/superpowers');
  assert.equal(powerEffort(null, null), 'high');
  assert.equal(powerEffort('low', 'max'), 'high'); // manda el de la pestaña, subido a alto
  assert.equal(powerEffort('xhigh', null), 'xhigh');
  assert.equal(powerEffort(null, 'max'), 'max'); // el predeterminado de Claude Code ya es mayor
  assert.equal(powerEffort('raro', 'medium'), 'high');
  assert.deepEqual(powerEnv({}), { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' });
  assert.deepEqual(powerEnv({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5' }), { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' });
});

test('lo que aporta en el proyecto: con y sin, medias, correcciones, pruebas y Codex', () => {
  const { createPowerStats } = require('../src/main/power-stats');
  const saved = {};
  const stats = createPowerStats({ store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } } });
  assert.equal(stats.get('C:/p'), null); // sin nada con SuperPowers, no se enseña
  stats.record('C:/p', { mode: 'without', seconds: 60, fixed: false, tests: 'pending' });
  assert.equal(stats.get('C:/p'), null);
  stats.record('C:/p', { mode: 'with', seconds: 120, fixed: true, tests: 'ok' });
  stats.record('C:/P', { mode: 'with', seconds: 9 * 3600, fixed: false, tests: 'none' }); // misma carpeta; una tarea abierta no infla la media
  stats.codexFound('C:/p', 2);
  const got = stats.get('c:/p');
  assert.deepEqual(got.with, { turns: 2, minutes: 121, fixed: 1, tested: 1, green: 1 });
  assert.deepEqual(got.without, { turns: 1, minutes: 1, fixed: 0, tested: 1, green: 0 });
  assert.equal(got.codex, 2);
});

test('pasada proporcional: ligera en un cambio pequeño del proyecto, completa en uno grande', () => {
  const { sp, tabs } = make();
  const path = require('path');
  const dir = path.resolve('proyecto-de-prueba');
  const tmp = path.resolve('temporal-de-claude');
  tabs.get('t1').folder = dir;
  // Pequeño y solo de vista: sin pruebas nuevas ni vistas previas aparte, una ronda de capturas.
  sp.turnStarted('t1', 'p', 'Pon el título arriba');
  sp.toolUsed('t1', 'Edit', path.join(dir, 'templates', 'login.html'));
  sp.toolUsed('t1', 'Write', path.join(tmp, 'vista-previa.html')); // fuera del proyecto: no cuenta
  sp.toolUsed('t1', 'Write', path.join(tmp, 'banco.py'));
  sp.willAsk('t1');
  let reason = sp.answer('t1').reason;
  assert.match(reason, /pasada ligera/);
  assert.match(reason, /No hace falta escribir pruebas nuevas/);
  assert.match(reason, /una ronda con capturar_pantalla/);
  assert.match(reason, /Sin montar páginas de vista previa/);
  assert.match(reason, /daría por hecho aunque no lo haya dicho/);
  assert.doesNotMatch(reason, /reparte la comprobación/);
  assert.doesNotMatch(reason, /por separado/); // sin ejemplos que apunten a un caso concreto

  // Pequeño con lógica: las pruebas que ya tenga, sin archivo nuevo.
  sp.turnStarted('t1', 'p', 'Corrige la suma');
  sp.toolUsed('t1', 'Edit', 'calc.py', dir); // relativa a la carpeta de trabajo
  sp.willAsk('t1');
  reason = sp.answer('t1').reason;
  assert.match(reason, /pasada ligera/);
  assert.match(reason, /no hace falta un archivo de pruebas nuevo/);

  // Grande: la suite completa, pruebas para la lógica y reparto.
  sp.turnStarted('t1', 'p', 'Añade los filtros');
  for (const f of ['api.py', 'logs.py', 'trace.js', 'trace.html']) sp.toolUsed('t1', 'Edit', path.join(dir, f));
  sp.willAsk('t1');
  reason = sp.answer('t1').reason;
  assert.doesNotMatch(reason, /pasada ligera/);
  assert.match(reason, /suite de pruebas completa/);
  assert.match(reason, /añade las pruebas que falten para la lógica/);
  assert.match(reason, /reparte la comprobación/);
  assert.match(reason, /daría por hecho/);

  // Muchas ediciones de un mismo archivo también cuentan como cambio grande.
  sp.turnStarted('t1', 'p', 'Rehaz la hoja de estilos');
  for (let i = 0; i < 7; i += 1) sp.toolUsed('t1', 'Edit', path.join(dir, 'estilo.css'));
  sp.willAsk('t1');
  reason = sp.answer('t1').reason;
  assert.doesNotMatch(reason, /pasada ligera/);
  assert.doesNotMatch(reason, /añade las pruebas que falten/); // solo vista: sin pruebas nuevas
});

test('lo que Claude deja fuera del proyecto no impide la revisión de Codex («varios repositorios»)', async () => {
  const { tabs } = make();
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claudhome-sp-repo-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claudhome-sp-tmp-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const review = createReview({ tabs, store: { get: (_k, d) => d }, usable: () => true, codex: {}, send: () => {}, log: () => {}, logsDir: () => '.', extraFor: () => true });
    tabs.ensure('t9').folder = repo;
    review.turnStarted('t9', 'Cambia el panel');
    review.toolUsed('t9', 'Edit', path.join(repo, 'app.py'));
    review.toolUsed('t9', 'Write', path.join(scratch, 'banco.py')); // fuera y sin repositorio: no cuenta
    assert.ok(tabs.get('t9').reviewRepo, 'se queda con el repositorio del proyecto');
    assert.equal(tabs.get('t9').edited, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
