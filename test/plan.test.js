// Seguimiento del plan (panel «Actividad»), autocompactar y dirección de GitHub de la tarjeta
// del proyecto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createPlanTracker, PLAN_NOTE } = require('../src/main/plan');
const { compactEnv, compactTarget, githubUrl, repoUrl, DEFAULT_COMPACT } = require('../src/main/project-card');
const { narration } = require('../src/main/hooks');
const { createContext } = require('../src/main/context');
const { tempDir } = require('./helpers');

// Un aviso como el que manda hooks.js (con lo del panel en `narr`).
const hook = (event, payload) => ({
  event, sessionId: payload.session_id || 's1', toolName: payload.tool_name || null, narr: narration(event, payload),
});
const created = (id, subject, extra = {}) => hook('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject }, tool_response: { task: { id, subject } }, ...extra });
const updated = (taskId, status, extra = {}) => hook('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId, status }, tool_response: { success: true }, ...extra });

test('el aviso de una tarea trae su número, el texto y el estado', () => {
  assert.deepEqual(narration('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Crear uno.txt' }, tool_response: { task: { id: '1', subject: 'Crear uno.txt' } } }).task,
    { id: '1', subject: 'Crear uno.txt', status: 'pending' });
  assert.deepEqual(narration('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' }, tool_response: { success: true } }).task,
    { id: '1', subject: '', status: 'completed' });
  // Sin cambiar (un hook no la deja cerrar), con un número raro o antes de usarla: nada.
  assert.equal(narration('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' }, tool_response: { success: false } }).task, null);
  assert.equal(narration('PostToolUse', { tool_name: 'TaskCreate', tool_input: {}, tool_response: { task: { id: '../x' } } }).task, null);
  assert.equal(narration('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'x' } }).task, null);
});

test('el plan sigue el estado de cada paso, solo del hilo principal', () => {
  const sent = [];
  const plans = createPlanTracker({ send: (...args) => sent.push(args), now: () => 1000 });
  plans.event('t1', hook('UserPromptSubmit', {}));
  plans.event('t1', created('1', 'Revisar el carrito'));
  plans.event('t1', created('2', 'Añadir Bizum'));
  plans.event('t1', created('3', 'Probar el pago'));
  plans.event('t1', updated('1', 'in_progress'));
  plans.event('t1', created('9', 'Tarea de un agente', { agent_id: 'a1' })); // no cuenta
  plans.event('t1', updated('1', 'completed'));
  plans.event('t1', updated('2', 'in_progress'));
  const plan = plans.get('t1');
  assert.deepEqual(plan.steps.map((s) => [s.text, s.status]), [['Revisar el carrito', 'done'], ['Añadir Bizum', 'work'], ['Probar el pago', 'todo']]);
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 3);
  assert.equal(sent.at(-1)[0], 'plan:update');
  assert.equal(sent.at(-1)[1], 't1');
  // Una tarea borrada sale; otra pestaña no se entera.
  plans.event('t1', updated('3', 'deleted'));
  assert.equal(plans.get('t1').total, 2);
  assert.equal(plans.get('t2'), null);
});

test('un plan nuevo empieza con el siguiente encargo, no con un último paso del mismo', () => {
  const plans = createPlanTracker();
  plans.event('t1', created('1', 'Uno'));
  plans.event('t1', updated('1', 'completed'));
  plans.event('t1', created('2', 'Un último paso')); // mismo encargo: se añade
  assert.equal(plans.get('t1').total, 2);
  plans.event('t1', updated('2', 'completed'));
  plans.event('t1', hook('UserPromptSubmit', {})); // otro encargo
  plans.event('t1', created('3', 'Otra cosa'));
  assert.deepEqual(plans.get('t1').steps.map((s) => s.text), ['Otra cosa']);
  // Otra conversación en la pestaña (/clear): el plan se vacía.
  plans.event('t1', hook('UserPromptSubmit', { session_id: 's2' }));
  assert.equal(plans.get('t1'), null);
});

test('con TodoWrite (modelos anteriores) llega la lista entera', () => {
  const plans = createPlanTracker();
  const todos = Array.from({ length: 15 }, (_, n) => ({ content: `Paso ${n + 1}`, status: n < 2 ? 'completed' : n === 2 ? 'in_progress' : 'pending' }));
  plans.event('t1', hook('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos } }));
  const plan = plans.get('t1');
  assert.equal(plan.total, 15); // no se corta en 12
  assert.equal(plan.done, 2);
  assert.equal(plan.steps[2].status, 'work');
  plans.forget('t1');
  assert.equal(plans.get('t1'), null);
});

test('la instrucción del plan va delante del contexto y no se pierde al cambiarlo', async (t) => {
  const userData = tempDir(t);
  const ctx = createContext({ app: { getPath: () => userData }, net: null, log: () => {} });
  const out = await ctx.prepare('t1', 'Proyecto', { note: '', items: [] }, PLAN_NOTE);
  assert.ok(out.promptFile, 'sin contexto del usuario también hay archivo');
  assert.match(fs.readFileSync(out.promptFile, 'utf8'), /TaskCreate/);
  assert.equal(out.text, ''); // el contexto del usuario sigue vacío
  assert.equal(ctx.pendingUpdate('t1'), null); // la instrucción no cuenta como cambio
  await ctx.update('t1', 'Proyecto', { note: 'Usa euros.', items: [] });
  const text = fs.readFileSync(out.promptFile, 'utf8');
  assert.ok(text.indexOf('TaskCreate') < text.indexOf('Usa euros.'));
  assert.doesNotMatch(ctx.pendingUpdate('t1').hookSpecificOutput.additionalContext, /TaskCreate/);
});

test('autocompactar: el porcentaje de la pestaña, corregido por lo que reserva Claude Code', () => {
  assert.equal(DEFAULT_COMPACT, 85);
  assert.equal(compactEnv(85, 1000000), '86.7'); // 86,7 % de 980 000 = 85 % de 1 000 000
  assert.equal(compactEnv(null, null), '86.7'); // sin dato: el 85 % y una ventana de 1 M
  assert.equal(compactEnv(95, 200000), '100'); // con ventanas pequeñas no pasa de 100
  assert.equal(compactEnv(50, 1000000), '51');
  assert.equal(compactTarget(20), 85); // fuera de 30–95: el de siempre
  assert.equal(compactTarget('70'), 70);
});

test('la dirección de GitHub se construye de nuevo, sin claves ni nada más', () => {
  assert.equal(githubUrl('https://github.com/Picaresco/Claudes.git'), 'https://github.com/Picaresco/Claudes');
  // Una dirección con usuario y clave (aquí, de mentira): ninguna de las dos se copia.
  assert.equal(githubUrl(`https://usuario:${'no-es-una-clave'}@github.com/Picaresco/Claudes`), 'https://github.com/Picaresco/Claudes');
  assert.equal(githubUrl('git@github.com:Picaresco/Plugin-Work.git'), 'https://github.com/Picaresco/Plugin-Work');
  assert.equal(githubUrl('ssh://git@github.com/Picaresco/Claudes.git'), 'https://github.com/Picaresco/Claudes');
  assert.equal(githubUrl('https://github.com/Picaresco/Claudes/'), 'https://github.com/Picaresco/Claudes');
  for (const bad of ['https://gitlab.com/a/b', 'https://github.com.evil.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a', 'git@github.com:../b.git', 'file:///C:/repo', '', null]) {
    assert.equal(githubUrl(bad), null, String(bad));
  }
});

test('repoUrl prefiere «origin» y solo da direcciones de GitHub', async () => {
  const fake = (stdout, err = null) => (_cmd, args, _opts, done) => { assert.deepEqual(args.slice(0, 3), ['-C', 'C:\\p', 'config']); done(err, stdout); };
  assert.equal(await repoUrl('C:\\p', { run: fake('remote.mio.url https://github.com/yo/fork\nremote.origin.url git@github.com:org/app.git\n') }), 'https://github.com/org/app');
  assert.equal(await repoUrl('C:\\p', { run: fake('remote.origin.url https://gitlab.com/org/app\nremote.gh.url https://github.com/org/app\n') }), 'https://github.com/org/app');
  assert.equal(await repoUrl('C:\\p', { run: fake('remote.origin.url https://gitlab.com/org/app\n') }), null);
  assert.equal(await repoUrl('C:\\p', { run: fake('', new Error('no es un repositorio')) }), null);
  assert.equal(await repoUrl(''), null);
});
