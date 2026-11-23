// «Codex asesora»: ClaudHome le dice a cada sesión cuándo pedir la segunda opinión. Hace falta
// porque, con muchos servidores MCP, Claude Code difiere las herramientas y Claude no ve su
// descripción (cuándo usarla) hasta que la busca: en la prueba real no la pedía por su cuenta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReview, ADVISOR_ON, ADVISOR_OFF } = require('../src/main/review');
const { Tabs } = require('../src/main/tabs');

function setup({ enabled = true, usable = true } = {}) {
  const saved = { codexReview: enabled };
  const state = { usable };
  const logs = [];
  const tabs = new Tabs();
  const review = createReview({
    tabs, store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } },
    usable: () => state.usable, codex: {}, send: () => {}, log: (x) => logs.push(x), logsDir: () => '',
  });
  return { review, tabs, state, logs };
}

test('con «Codex asesora» encendido, la sesión lo sabe con su primer mensaje, una sola vez', () => {
  const { review, tabs } = setup();
  tabs.ensure('t1');
  assert.equal(review.advisorNote('t1', 'Hola'), ADVISOR_ON);
  assert.equal(review.advisorNote('t1', 'Otra cosa'), null);
  assert.match(ADVISOR_ON, /mcp__claudhome-codex__segunda_opinion/);
  assert.match(ADVISOR_ON, /ToolSearch/); // por si la herramienta está diferida
  assert.match(ADVISOR_ON, /seguridad/);
  assert.match(ADVISOR_ON, /arquitectura/);
  assert.match(ADVISOR_ON, /sin esperar a que te lo pidan/);
  // Una sesión nueva (o retomada) lo vuelve a oír.
  review.sessionStarted('t1');
  assert.equal(review.advisorNote('t1', 'Hola'), ADVISOR_ON);
});

test('al apagarlo (o si Codex deja de estar disponible), la sesión lo sabe; apagado desde el principio, no se le dice nada', () => {
  const { review, tabs, state } = setup();
  tabs.ensure('t1');
  review.advisorNote('t1', 'Hola');
  review.enabled = false;
  assert.equal(review.advisorNote('t1', 'Sigue'), ADVISOR_OFF);
  assert.equal(review.advisorNote('t1', 'Sigue'), null);
  review.enabled = true;
  assert.equal(review.advisorNote('t1', 'Sigue'), ADVISOR_ON);
  state.usable = false; // sin sesión de ChatGPT
  assert.equal(review.advisorNote('t1', 'Sigue'), ADVISOR_OFF);
  const off = setup({ enabled: false });
  off.tabs.ensure('t2');
  assert.equal(off.review.advisorNote('t2', 'Hola'), null);
});

test('el mensaje de cerrar la sesión no lleva el aviso', () => {
  const { review, tabs } = setup();
  tabs.ensure('t1');
  const { WRAPUP_START } = require('../src/main/review');
  assert.equal(review.advisorNote('t1', `${WRAPUP_START} y más`), null);
  assert.equal(review.advisorNote('t1', 'Hola'), ADVISOR_ON);
});

test('Codex razona lo que haga falta: más a fondo en seguridad, cambios grandes, planes largos y problemas atascados', () => {
  const { reviewEffort, planEffort, opinionEffort } = require('../src/main/review');
  // Revisión del código, por lo que cambia.
  assert.equal(reviewEffort({ lines: 4, paths: ['calc.js'] }), 'medium');
  assert.equal(reviewEffort({ lines: 120, paths: ['src/tienda.js'] }), 'high');
  assert.equal(reviewEffort({ lines: 900, paths: ['src/tienda.js'] }), 'xhigh');
  assert.equal(reviewEffort({ lines: 3, paths: ['src/auth/login.js'] }), 'xhigh'); // seguridad, aunque sea poco
  assert.equal(reviewEffort({ lines: 3, paths: ['.env'] }), 'xhigh');
  assert.equal(reviewEffort({ lines: 3, paths: ['deploy/docker-compose.yml'] }), 'xhigh');
  assert.equal(reviewEffort({ lines: 3, paths: ['db/migrations/002.sql'] }), 'xhigh');
  assert.equal(reviewEffort({}), 'medium');
  // Crítica de un plan: por lo largo que es.
  assert.equal(planEffort('Paso 1. Paso 2.'), 'high');
  assert.equal(planEffort('x'.repeat(4000)), 'xhigh');
  // Segunda opinión: la profundidad que pida Claude; si no, por el ámbito.
  assert.equal(opinionEffort('codigo', 'rapida'), 'medium');
  assert.equal(opinionEffort('seguridad', 'normal'), 'high');
  assert.equal(opinionEffort('codigo', 'a_fondo'), 'xhigh');
  assert.equal(opinionEffort('codigo'), 'high');
  assert.equal(opinionEffort('seguridad'), 'xhigh');
  assert.equal(opinionEffort('problema', 'inventada'), 'xhigh');
  assert.match(ADVISOR_ON, /«profundidad»/);
});

test('el aviso se repite si la conversación ya no lo tiene: tras /clear, al resumirse y cada 30 mensajes', () => {
  const { ADVISOR_EVERY } = require('../src/main/review');
  const { review, tabs } = setup();
  tabs.ensure('t1');
  assert.equal(review.advisorNote('t1', 'Hola', 's1'), ADVISOR_ON);
  assert.equal(review.advisorNote('t1', 'Sigue', 's1'), null);
  // /clear: otra conversación (otro identificador).
  assert.equal(review.advisorNote('t1', 'Tarea nueva', 's2'), ADVISOR_ON);
  assert.equal(review.advisorNote('t1', 'Sigue', 's2'), null);
  // La conversación se resume.
  review.compacted('t1');
  assert.equal(review.advisorNote('t1', 'Sigue', 's2'), ADVISOR_ON);
  // Conversación larga: se recuerda cada ADVISOR_EVERY mensajes, no antes.
  let told = 0;
  // (pasados 30 mensajes sin él, el siguiente lo lleva)
  for (let i = 0; i < (ADVISOR_EVERY + 1) * 2; i += 1) if (review.advisorNote('t1', `mensaje ${i}`, 's2')) told += 1;
  assert.equal(told, 2);
  // Apagado, resumir no hace que se le diga nada.
  review.enabled = false;
  assert.equal(review.advisorNote('t1', 'Sigue', 's2'), ADVISOR_OFF);
  review.compacted('t1');
  assert.equal(review.advisorNote('t1', 'Sigue', 's2'), null);
});
