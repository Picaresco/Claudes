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

test('apagado no pide nada ni cuenta nada', () => {
  const { sp, tabs } = make({ on: false });
  sp.turnStarted('t1', 'Cambia el color');
  sp.toolUsed('t1', 'Edit', 'estilo.css');
  assert.equal(sp.willAsk('t1'), false);
  assert.equal(tabs.get('t1').spEdited, false);
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
  sp.toolUsed('t1', sp.CAPTURE_TOOL);
  sp.toolUsed('t1', sp.CAPTURE_TOOL);
  pass = sp.summary('t1', { tests: 'none' });
  assert.equal(pass.captures, 'ok');
  assert.equal(pass.captured, 2);

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
