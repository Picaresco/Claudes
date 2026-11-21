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
  await limits.refresh();
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
  await limits.refresh();
  assert.equal(last().conversations.t1.output, 20);
  fs.appendFileSync(file, second.slice(40));
  await limits.refresh();
  assert.equal(last().conversations.t1.output, 50);
  const sentBefore = last();
  await limits.refresh(); // sin cambios: no se vuelve a avisar
  assert.equal(last(), sentBefore);
});

test('las conversaciones antiguas se saltan, salvo la de una pestaña abierta', async (t) => {
  const { project, limits, open, last } = setup(t);
  const now = Date.now();
  const file = path.join(project, 'vieja.jsonl');
  fs.writeFileSync(file, line(1, 'vieja', now - 20 * DAY, 40) + line(2, 'vieja', now - 19 * DAY, 2));
  const old = (now - 15 * DAY) / 1000;
  fs.utimesSync(file, old, old);
  await limits.refresh();
  assert.equal(limits.answers.size, 0); // no se ha leído
  open.set('t1', 'vieja'); // se abre en una pestaña
  await limits.refresh();
  assert.equal(last().conversations.t1.output, 42);
});

test('pasada la hora de renovación cuenta desde entonces y ya no da porcentaje', async (t) => {
  const { project, limits, last } = setup(t);
  const now = Date.now();
  fs.writeFileSync(path.join(project, 'conv.jsonl'), line(1, 'conv', now - 3 * HOUR, 500) + line(2, 'conv', now - 10 * 60e3, 8));
  limits.plan = { five_hour: { pct: 80, resetsAt: now - HOUR } }; // se renovó hace una hora
  await limits.refresh();
  const w = last().plan.five_hour;
  assert.equal(w.expired, true);
  assert.equal(w.pct, null);
  assert.equal(w.tokens.output, 8); // solo lo de después de renovarse
});
