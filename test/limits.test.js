const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Limits, limitsFromStatus } = require('../src/main/limits');
const { tempDir } = require('./helpers');

const DAY = 86400e3;
const HOUR = 3600e3;

const line = (id, session, t, output) => `${JSON.stringify({
  type: 'assistant', sessionId: session, requestId: `r${id}`, timestamp: new Date(t).toISOString(),
  message: { id: `m${id}`, model: 'x', usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
})}\n`;

// Una carpeta de configuración de Claude Code falsa, con sus conversaciones.
function setup(t) {
  const cfg = tempDir(t);
  const project = path.join(cfg, 'projects', 'C--x');
  fs.mkdirSync(project, { recursive: true });
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const saved = {};
  const sent = [];
  const open = new Map();
  const limits = new Limits({
    store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } },
    send: (channel, snap) => sent.push(snap),
    log: () => {},
    openSessions: () => open,
  });
  t.after(() => limits.stop());
  return { project, limits, sent, open, saved, last: () => sent[sent.length - 1] };
}

test('limitsFromStatus lee los límites de la línea de estado', () => {
  const reset = Math.round(Date.now() / 1000) + 3600;
  assert.deepEqual(limitsFromStatus({ rate_limits: { seven_day: { used_percentage: 61.4, resets_at: reset } } }),
    { seven_day: { pct: 61.4, resetsAt: reset * 1000 } });
  assert.equal(limitsFromStatus({}), null);
  assert.equal(limitsFromStatus({ rate_limits: { five_hour: { used_percentage: 'x', resets_at: reset } } }), null);
  // También en milisegundos o como fecha.
  assert.equal(limitsFromStatus({ rate_limits: { five_hour: { used_percentage: 5, resets_at: reset * 1000 } } }).five_hour.resetsAt, reset * 1000);
});

test('una sesión parada no pisa los datos con un periodo viejo ni baja el porcentaje', (t) => {
  const { limits, saved } = setup(t);
  const reset = Math.round((Date.now() + 2 * HOUR) / 1000);
  limits.fromStatus({ rate_limits: { five_hour: { used_percentage: 34, resets_at: reset } } });
  limits.fromStatus({ rate_limits: { five_hour: { used_percentage: 90, resets_at: reset - 5 * 3600 } } }); // periodo anterior
  limits.fromStatus({ rate_limits: { five_hour: { used_percentage: 20, resets_at: reset } } }); // mismo periodo, menos
  assert.equal(limits.plan.five_hour.pct, 34);
  limits.fromStatus({ rate_limits: { five_hour: { used_percentage: 40, resets_at: reset } } });
  assert.equal(limits.plan.five_hour.pct, 40);
  limits.fromStatus({ rate_limits: { five_hour: { used_percentage: 2, resets_at: reset + 5 * 3600 } } }); // periodo nuevo
  assert.equal(limits.plan.five_hour.pct, 2);
  assert.deepEqual(saved.planLimits, limits.plan); // se guarda para el siguiente arranque
});

test('cuenta cada respuesta una vez, por periodo y por conversación', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  // La misma respuesta en dos líneas (la última trae más salida) y otra distinta.
  fs.writeFileSync(path.join(project, 'conv.jsonl'), line(1, 'conv', now - HOUR, 5) + line(1, 'conv', now - HOUR, 50) + line(2, 'conv', now - 30 * 60e3, 7)
    + '{"type":"user","message":{"content":"hola"}}\n' + 'línea rota\n');
  // Un subagente de esa conversación y una respuesta de hace 5 días en otra.
  fs.mkdirSync(path.join(project, 'conv', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, 'conv', 'subagents', 'agent-a.jsonl'), line(3, 'conv', now - 20 * 60e3, 3));
  fs.writeFileSync(path.join(project, 'otra.jsonl'), line(4, 'otra', now - 5 * DAY, 100));
  open.set('t1', 'conv');
  limits.fromStatus({ rate_limits: {
    five_hour: { used_percentage: 34.6, resets_at: Math.round((now + 2 * HOUR) / 1000) },
    seven_day: { used_percentage: 12, resets_at: Math.round((now + DAY) / 1000) },
  } });
  await limits.refresh({ full: true });
  const snap = last();
  assert.equal(snap.plan.five_hour.pct, 35);
  assert.equal(snap.plan.five_hour.tokens.output, 60); // 50 + 7 + 3
  assert.equal(snap.plan.five_hour.tokens.total, 60 + 3 * 1110);
  assert.equal(snap.plan.seven_day.tokens.output, 160); // más la de hace 5 días
  assert.deepEqual(snap.conversations.t1, { input: 30, output: 60, cacheWrite: 300, cacheRead: 3000, total: 3390 });
});

test('lee solo lo nuevo y espera a que la línea esté completa', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  const file = path.join(project, 'conv.jsonl');
  const second = line(2, 'conv', now - 60e3, 30);
  fs.writeFileSync(file, line(1, 'conv', now - 2 * 60e3, 20) + second.slice(0, 40)); // la segunda, a medio escribir
  open.set('t1', 'conv');
  await limits.refresh({ full: true });
  assert.equal(last().conversations.t1.output, 20);
  fs.appendFileSync(file, second.slice(40));
  await limits.refresh({ full: true });
  assert.equal(last().conversations.t1.output, 50);
  const sentBefore = last();
  await limits.refresh({ full: true }); // sin cambios: no se vuelve a avisar
  assert.equal(last(), sentBefore);
});

test('las conversaciones antiguas se saltan, salvo la de una pestaña abierta', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  const file = path.join(project, 'vieja.jsonl');
  fs.writeFileSync(file, line(1, 'vieja', now - 20 * DAY, 40) + line(2, 'vieja', now - 19 * DAY, 2));
  const old = (now - 15 * DAY) / 1000;
  fs.utimesSync(file, old, old);
  await limits.refresh({ full: true });
  assert.equal(limits.answers.size, 0); // no se ha leído
  open.set('t1', 'vieja'); // se abre en una pestaña
  await limits.refresh({ full: true });
  assert.equal(last().conversations.t1.output, 42);
});

test('pasada la hora de renovación cuenta desde entonces y ya no da porcentaje', async (t) => {
  const { project, limits, last } = setup(t);
  const now = Date.now();
  fs.writeFileSync(path.join(project, 'conv.jsonl'), line(1, 'conv', now - 3 * HOUR, 500) + line(2, 'conv', now - 10 * 60e3, 8));
  limits.plan = { five_hour: { pct: 80, resetsAt: now - HOUR } }; // se renovó hace una hora
  await limits.refresh({ full: true });
  const w = last().plan.five_hour;
  assert.equal(w.expired, true);
  assert.equal(w.pct, null);
  assert.equal(w.tokens.output, 8); // solo lo de después de renovarse
});

test('tras una respuesta solo se miran las conversaciones abiertas; el resto, en el recorrido completo', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  const mine = path.join(project, 'mia.jsonl');
  const other = path.join(project, 'ajena.jsonl');
  fs.writeFileSync(mine, line(1, 'mia', now - 5 * 60e3, 10));
  fs.writeFileSync(other, line(2, 'ajena', now - 5 * 60e3, 100));
  open.set('t1', 'mia');
  limits.plan = { five_hour: { pct: 10, resetsAt: now + HOUR } };
  await limits.refresh({ full: true });
  assert.equal(last().plan.five_hour.tokens.output, 110);

  // Las dos crecen y la mía lanza un subagente; el recuento rápido solo ve lo mío.
  fs.appendFileSync(mine, line(3, 'mia', now - 60e3, 5));
  fs.appendFileSync(other, line(4, 'ajena', now - 60e3, 1000));
  fs.mkdirSync(path.join(project, 'mia', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, 'mia', 'subagents', 'agent-x.jsonl'), line(5, 'mia', now - 30e3, 2));
  const listed = [];
  const readdir = fs.promises.readdir;
  fs.promises.readdir = (dir, ...rest) => { listed.push(path.relative(project, String(dir))); return readdir(dir, ...rest); };
  t.after(() => { fs.promises.readdir = readdir; });
  await limits.refresh();
  assert.equal(last().conversations.t1.output, 17); // 10 + 5 + 2 del subagente
  assert.equal(last().plan.five_hour.tokens.output, 117); // lo ajeno nuevo aún no cuenta
  assert.ok(listed.length > 0 && listed.every((dir) => dir.startsWith('mia')), `solo se ha mirado mi conversación: ${listed.join(', ')}`);

  await limits.refresh({ full: true }); // el del minuto
  assert.equal(last().plan.five_hour.tokens.output, 1117);
});

test('una conversación recién creada obliga a recorrerlo todo para encontrarla', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  fs.writeFileSync(path.join(project, 'vieja.jsonl'), line(1, 'vieja', now - 60e3, 10));
  open.set('t1', 'vieja');
  await limits.refresh({ full: true });
  fs.writeFileSync(path.join(project, 'nueva.jsonl'), line(2, 'nueva', now - 30e3, 4)); // tras un /clear
  open.set('t1', 'nueva');
  await limits.refresh();
  assert.equal(last().conversations.t1.output, 4);
});

test('un recorrido completo pedido con otro en marcha se hace al terminar', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  fs.writeFileSync(path.join(project, 'mia.jsonl'), line(1, 'mia', now - 60e3, 10));
  open.set('t1', 'mia');
  limits.plan = { five_hour: { pct: 10, resetsAt: now + HOUR } };
  await limits.refresh({ full: true });
  fs.writeFileSync(path.join(project, 'ajena.jsonl'), line(2, 'ajena', now - 30e3, 100));
  const quick = limits.refresh(); // rápido: no ve la ajena…
  limits.refresh({ full: true }); // …y este se queda pendiente
  await quick;
  await limits.running;
  assert.equal(last().plan.five_hour.tokens.output, 110);
});

test('el modelo y el esfuerzo de la sesión salen de lo que Claude Code le pasa a su línea de estado', () => {
  const { modelFrom } = require('../src/main/claude-config');
  // Lo que llega de verdad (capturado con Claude Code 2.1.331).
  assert.deepEqual(modelFrom({ model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' }, effort: { level: 'medium' }, fast_mode: false }),
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', effort: 'medium', fast: false });
  assert.deepEqual(modelFrom({ model: { id: 'claude-opus-5-5' } }), { id: 'claude-opus-5-5', name: 'claude-opus-5-5', effort: null, fast: false });
  assert.equal(modelFrom({}), null);
  assert.equal(modelFrom(null), null);
});

test('guardar el modelo y el esfuerzo como predeterminados de Claude Code, sin tocar lo demás', (t) => {
  const fs = require('fs');
  const path = require('path');
  const { saveDefaultModel } = require('../src/main/claude-config');
  const { tempDir } = require('./helpers');
  const dir = tempDir(t);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));
  assert.deepEqual(saveDefaultModel({ model: 'claude-sonnet-5-5', effort: 'high' }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    model: 'sonnet', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5': { effortLevel: 'high' } },
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'sonnet'); // el alias, como /model
  assert.deepEqual(saveDefaultModel({ model: 'claude-fable-5-2', effort: 'max' }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'claude-fable-5-2'); // sin alias conocido, el id
  // Lo que no se puede leer no se sobrescribe; lo que no es válido no se guarda.
  fs.writeFileSync(file, '{ roto');
  assert.equal(saveDefaultModel({ model: 'claude-opus-5-5', effort: 'low' }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ roto');
  assert.equal(saveDefaultModel({ model: 'opus; rm -rf', effort: 'low' }).ok, false);
  assert.equal(saveDefaultModel({ model: 'claude-opus-5-5', effort: 'turbo' }).ok, false);
});
