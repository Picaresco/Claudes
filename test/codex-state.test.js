// Lo que la app sabe de Codex y lo que está haciendo (src/main/codex-state.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexState } = require('../src/main/codex-state');
const { Tabs } = require('../src/main/tabs');

// Un Codex de mentira: qué detecta, qué uso devuelve y cómo responde al pedirle una imagen.
function setup({ found = { installed: true, loggedIn: true, mode: 'chatgpt', advisor: true }, limits = { pct: 40, windowMins: 10080 }, image = null } = {}) {
  const sent = [];
  const logs = [];
  const saved = [];
  const records = [];
  const fake = {
    detect: async () => ({ ...found }),
    authStamp: () => 'cuenta-1',
    readLimits: async () => limits,
    generateImage: async (o) => { if (image instanceof Error) throw image; return { path: `${o.cwd}/imagen.png` }; },
    OPINION_TOOL: { name: 'segunda_opinion' },
    IMAGE_TOOL: { name: 'generar_imagen' },
  };
  const tabs = new Tabs();
  Object.assign(tabs.ensure('t1'), { name: 'Web', folder: 'C:/proyectos/web' });
  const state = createCodexState({
    codex: fake, tabs, send: (channel, info) => sent.push([channel, info]), log: (t) => logs.push(t), persist: (on) => saved.push(on),
    workDir: () => 'C:/tmp/codex', netlog: () => ({ record: (r) => records.push(r) }),
  });
  return { state, sent, logs, saved, records, fake };
}

test('sabe si Codex se puede usar y solo enciende las imágenes si se puede', async () => {
  const ok = setup();
  assert.equal(ok.state.usable(), false); // aún sin comprobar
  const info = await ok.state.refresh();
  assert.equal(info.usable, true);
  assert.equal(ok.state.advisorUsable(), true);
  assert.equal((await ok.state.setEnabled(true)).active, true);
  assert.deepEqual(ok.saved, [true]);
  assert.deepEqual(ok.state.tools().map((t) => t.name), ['segunda_opinion', 'generar_imagen']);
  // Con una clave de API, ni asesora ni dibuja; la segunda opinión se ofrece igual (se niega ella).
  const api = setup({ found: { installed: true, loggedIn: true, mode: 'api', advisor: true } });
  await api.state.refresh();
  assert.equal(api.state.usable(), false);
  assert.equal((await api.state.setEnabled(true)).enabled, false);
  assert.deepEqual(api.saved, [false]);
  assert.deepEqual(api.state.tools().map((t) => t.name), ['segunda_opinion']);
  // Con un Codex antiguo no hay segunda opinión; sin Codex, ninguna herramienta.
  const old = setup({ found: { installed: true, loggedIn: true, mode: 'chatgpt', advisor: false } });
  await old.state.refresh();
  assert.equal(old.state.advisorUsable(), false);
  assert.deepEqual(old.state.tools(), []);
  const none = setup({ found: { installed: false, loggedIn: false, mode: null } });
  await none.state.refresh();
  assert.deepEqual(none.state.tools(), []);
  // Lo guardado se recupera al arrancar, sin comprobar aún nada.
  const back = setup();
  back.state.restore({ enabled: true });
  assert.equal(back.state.state.enabled, true);
  back.state.restore({ enabled: 'sí' });
  assert.equal(back.state.state.enabled, false);
});

test('el uso del plan es de la cuenta: si cambia la sesión, se olvida', async () => {
  const s = setup();
  await s.state.refresh();
  await s.state.refreshLimits();
  assert.equal(s.state.info().limits.pct, 40);
  // Otra cuenta, y su uso aún no se puede leer: el de la anterior no se enseña.
  s.fake.authStamp = () => 'cuenta-2';
  s.fake.readLimits = async () => null;
  await s.state.refresh();
  await s.state.refreshLimits();
  assert.equal(s.state.info().limits, null);
  // Con la nueva leída, si una lectura posterior falla, se queda ese dato marcado como viejo.
  s.fake.readLimits = async () => ({ pct: 5, windowMins: 10080 });
  await s.state.refreshLimits();
  assert.equal(s.state.info().limits.authStamp, 'cuenta-2');
  s.fake.readLimits = async () => null;
  await s.state.refreshLimits();
  assert.equal(s.state.info().limits.stale, true);
  assert.equal(s.state.info().limits.pct, 5);
  assert.ok(s.sent.every(([channel]) => channel === 'codex:changed'));
});

test('cada trabajo de Codex se ve con su pestaña, su icono y desde cuándo, y desaparece al terminar', async () => {
  const s = setup();
  await s.state.refresh();
  s.state.adviseBusy(1, 't1', 'revisión del código', 'review');
  s.state.adviseBusy(1, 'otra', 'segunda opinión', 'opinion');
  const info = s.state.info();
  assert.equal(info.busy, 2);
  assert.equal(info.advising, 2);
  assert.deepEqual(info.jobs.map((j) => [j.tab, j.what, j.icon]), [['Web', 'revisión del código', 'review'], [null, 'segunda opinión', 'opinion']]);
  assert.ok(info.jobs.every((j) => Number.isFinite(j.startedAt)));
  s.state.adviseBusy(-1, 't1', 'revisión del código', 'review');
  assert.deepEqual(s.state.info().jobs.map((j) => j.what), ['segunda opinión']);
  s.state.adviseBusy(-1, 't1', 'algo que no estaba', 'review'); // no rompe nada
  s.state.adviseBusy(-1, 'otra', 'segunda opinión', 'opinion');
  assert.equal(s.state.info().busy, 0);
  s.state.stop();
});

test('una imagen: se niega si no toca y, pase lo que pase, el pincel se quita al terminar', async () => {
  const s = setup();
  await s.state.refresh();
  await assert.rejects(s.state.drawImage('t1', { descripcion: 'un gato' }), /desactivadas/);
  await assert.rejects(s.state.drawImage('cerrada', { descripcion: 'un gato' }), /ya no está abierta/);
  await s.state.setEnabled(true);
  const done = await s.state.drawImage('t1', { descripcion: 'un gato', formato: 'raro' });
  assert.match(done, /guardada en: C:\/proyectos\/web\/imagen\.png/);
  assert.equal(s.state.info().drawing, 0);
  assert.equal(s.records.length, 1); // queda en el «Log»
  assert.equal(s.records[0].detail, '7 caracteres');
  assert.ok(s.sent.some(([, info]) => info.drawing === 1)); // se vio el pincel mientras dibujaba
  const bad = setup({ image: new Error('Codex no responde') });
  await bad.state.refresh();
  await bad.state.setEnabled(true);
  await assert.rejects(bad.state.drawImage('t1', { descripcion: 'x' }), /Codex no responde/);
  assert.equal(bad.state.info().drawing, 0);
  assert.match(bad.logs.join('\n'), /fallo tras/);
  s.state.stop();
  bad.state.stop();
});
