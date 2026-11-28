// Ideas para el proyecto de SuperPowers (src/main/ideas.js): cuándo se piensa una, el filtro de
// «merece la pena», el visto bueno de Codex y las tres respuestas del usuario.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdeas, parseIdea, worthIt, tryPrompt, similar, slugOf, prompt, EVERY } = require('../src/main/ideas');
const { Tabs } = require('../src/main/tabs');

const IDEA = {
  titulo: 'La lista de citas no se puede usar en el móvil',
  tipo: 'visual',
  por_que: 'Por debajo de 800 px la tabla se corta y no se ve el botón de anular.',
  que_hacer: 'En citas.css, por debajo de 800 px, mostrar cada cita como una tarjeta.',
  ganancia: 5, confianza: 4, esfuerzo: 2, riesgo: 'bajo', archivos: ['citas.css'], pagina: 'citas.html', ancho: 390,
};
const answer = (idea) => ({ text: `Aquí va:\n\`\`\`json\n${JSON.stringify({ idea })}\n\`\`\`` });

function make({ reply = answer(IDEA), codex = null, superpowers = true } = {}) {
  const saved = {};
  const store = { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = JSON.parse(JSON.stringify(v)); } };
  const tabs = new Tabs();
  const tab = tabs.ensure('t1');
  tab.folder = 'C:\\proy\\web-clinica';
  tab.superpowers = superpowers;
  let clock = Date.UTC(2026, 10, 28, 9);
  const sent = [];
  const asked = [];
  const records = [];
  const ideas = createIdeas({
    store, tabs, send: (...args) => sent.push(args),
    material: async () => ({ text: 'ÁRBOL', used: ['a.html'], masked: 0, size: 5 }),
    ask: async (text) => { asked.push(text); return typeof reply === 'function' ? reply(asked.length) : reply; },
    codexCheck: async () => codex,
    capture: async (_tabId, card) => ({ file: `C:\\capturas\\${card.width}.png`, width: card.width }),
    record: (entry) => records.push(entry),
    now: () => clock,
  });
  let said = 0;
  const turns = async (n) => {
    for (let i = 0; i < n; i += 1) { ideas.turnDone('t1', `petición ${said}`); said += 1; }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));
  };
  return { ideas, tabs, saved, sent, asked, records, turns, tick: (ms) => { clock += ms; } };
}

test('lo pedido que se le pasa al modelo de las ideas va con las claves tapadas', async () => {
  const { ideas, asked } = make();
  const key = `sk-ant-${'Ab3'.repeat(12)}`; // montada al ejecutar: este archivo no lleva una clave escrita
  for (let i = 0; i < EVERY; i += 1) ideas.turnDone('t1', `Conecta la API con la clave ${key}`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], new RegExp(key));
});

test('se piensa una idea tras 5 turnos con cambios, como mucho una al día y solo con SuperPowers', async () => {
  const off = make({ superpowers: false });
  await off.turns(EVERY);
  assert.equal(off.asked.length, 0);

  const { asked, sent, records, turns, tick, ideas } = make();
  await turns(EVERY - 1);
  assert.equal(asked.length, 0);
  await turns(1);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /petición 4/); // lo último que ha pedido el usuario
  assert.equal(records[0].kind, 'idea'); // lo que sale queda en el «Log»
  assert.equal(sent.length, 1);
  const card = sent[0][2];
  assert.equal(sent[0][0], 'ideas:card');
  assert.equal(card.title, IDEA.titulo);
  assert.equal(card.kind, 'visual');
  assert.deepEqual(card.before, { file: 'C:\\capturas\\390.png', width: 390 }); // la captura de «ahora»
  assert.equal(ideas.get('t1').id, card.id);
  // Con una idea esperando respuesta no se piensa otra; tampoco el mismo día.
  ideas.act('t1', card.id, 'no');
  await turns(EVERY);
  assert.equal(asked.length, 1);
  tick(25 * 3600 * 1000);
  await turns(EVERY);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /ya ha rechazado[\s\S]*La lista de citas no se puede usar en el móvil/);
});

test('solo se enseña si merece la pena de verdad, y nunca si Codex no coincide', async () => {
  const weak = make({ reply: answer({ ...IDEA, ganancia: 3 }) });
  await weak.turns(EVERY);
  assert.equal(weak.sent.length, 0);
  const none = make({ reply: { text: '{"idea": null}' } });
  await none.turns(EVERY);
  assert.equal(none.sent.length, 0);
  const against = make({ codex: { agrees: false, why: 'la tabla ya es adaptable' } });
  await against.turns(EVERY);
  assert.equal(against.sent.length, 0);
  const agrees = make({ codex: { agrees: true, why: '' } });
  await agrees.turns(EVERY);
  assert.equal(agrees.sent[0][2].codex, true);
  const noCodex = make();
  await noCodex.turns(EVERY);
  assert.equal(noCodex.sent[0][2].codex, null);
});

test('las tres respuestas: más tarde (un día), no me interesa y pruébalo en una rama aparte', async () => {
  const { ideas, turns, sent, tick, saved } = make();
  await turns(EVERY);
  const card = sent[0][2];
  assert.equal(ideas.act('t1', 'otra', 'later').ok, false); // otra idea: nada
  assert.equal(ideas.act('t1', card.id, 'later').ok, true);
  assert.equal(ideas.get('t1'), null);
  assert.deepEqual(sent.at(-1), ['ideas:clear', 't1', card.id]); // se quita en todas las pestañas del proyecto
  assert.equal(ideas.act('t1', card.id, 'try').ok, false); // aplazada: ni desde otra pestaña
  tick(24 * 3600 * 1000 + 1);
  assert.equal(ideas.get('t1').id, card.id); // vuelve al día siguiente
  const tried = ideas.act('t1', card.id, 'try');
  assert.match(tried.prompt, /git worktree add "\.\.\/web-clinica-idea-la-lista-de-citas-no-se-puede-usar-en-el" -b idea\/la-lista-de-citas-no-se-puede-usar-en-el»/);
  // Una carpeta con espacios no rompe la orden.
  assert.match(tryPrompt({ ...card, files: [] }, 'C:\\Proyectos\\Mi Web'), /git worktree add "\.\.\/mi-web-idea-/);
  assert.match(tried.prompt, /capturar_pantalla/);
  assert.equal(ideas.get('t1'), null);
  assert.equal(saved.ideas[Object.keys(saved.ideas)[0]].tried[0].title, IDEA.titulo);
});

test('el filtro aprende: con 3 rechazos en un mes pide la ganancia máxima y nada parecido a lo rechazado', () => {
  const now = Date.UTC(2026, 10, 28);
  const idea = parseIdea(JSON.stringify({ idea: { ...IDEA, ganancia: 4 } }));
  assert.equal(worthIt(idea, {}, now).ok, true);
  const three = { rejected: [1, 2, 3].map((i) => ({ title: `Otra cosa distinta número ${i}`, at: now - i * 1000 })) };
  assert.match(worthIt(idea, three, now).why, /hace falta 5/);
  const old = { rejected: [1, 2, 3].map((i) => ({ title: `Otra cosa distinta número ${i}`, at: now - 60 * 24 * 3600 * 1000 })) };
  assert.equal(worthIt(idea, old, now).ok, true); // los de hace dos meses ya no cuentan
  assert.match(worthIt(idea, { rejected: [{ title: 'La lista de citas no se usa bien en el móvil', at: now }] }, now).why, /parecida/);
  assert.equal(worthIt({ ...idea, effort: 4 }, {}, now).ok, false);
  assert.equal(worthIt({ ...idea, confidence: 3 }, {}, now).ok, false);
  assert.equal(worthIt({ ...idea, risk: 'alto' }, {}, now).ok, false);
});

test('la respuesta del modelo se limpia y lo que falta la invalida', () => {
  assert.equal(parseIdea('no hay JSON'), null);
  assert.equal(parseIdea('{"idea": {"titulo": "x"}}'), null);
  // Sin esfuerzo (o sin un número) no vale: no se puede decir que cueste poco.
  assert.equal(parseIdea(JSON.stringify({ idea: { ...IDEA, esfuerzo: null } })), null);
  assert.equal(parseIdea(JSON.stringify({ idea: { ...IDEA, esfuerzo: 'poco' } })), null);
  assert.equal(parseIdea(JSON.stringify({ idea: { ...IDEA, confianza: undefined } })), null);
  const idea = parseIdea(JSON.stringify({ idea: { ...IDEA, ganancia: 9, ancho: 777, riesgo: 'raro', archivos: ['a', 3, ''] } }));
  assert.equal(idea.gain, 5);
  assert.equal(idea.width, 390);
  assert.equal(idea.risk, 'medio');
  assert.deepEqual(idea.files, ['a']);
  assert.equal(similar('Botón de enviar sin contraste', 'El botón enviar tiene poco contraste'), true);
  assert.equal(similar('Botón de enviar sin contraste', 'La tabla se corta en el móvil'), false);
  assert.equal(slugOf('¡Añadir búsqueda!'), 'anadir-busqueda');
  assert.equal(slugOf('Mostrar el calendario semanal completamente responsivo'), 'mostrar-el-calendario-semanal'); // por palabra entera
  assert.equal(slugOf('!!!'), 'idea');
  assert.match(prompt({ name: 'p', text: 'T' }), /\{"idea": null\}/);
  assert.match(tryPrompt({ ...parseIdea(JSON.stringify({ idea: { ...IDEA, tipo: 'funcional' } })) }, 'C:\\p\\api'), /añade las que hagan falta/);
});
