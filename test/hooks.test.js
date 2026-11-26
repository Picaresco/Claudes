const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { HookServer, jsonField, toolInputSummary } = require('../src/main/hooks');
const { tempDir, waitFor } = require('./helpers');

test('jsonField lee un valor de un JSON cortado', () => {
  const text = '{"session_id":"abc","tool_name":"Read","tool_input":{"file_path":"C:\\\\x \\"y\\".txt","n":[1,{"a":2}]},"tool_response":"aaaaaaaa';
  assert.equal(jsonField(text, 'session_id'), 'abc');
  assert.deepEqual(jsonField(text, 'tool_input'), { file_path: 'C:\\x "y".txt', n: [1, { a: 2 }] });
  assert.equal(jsonField(text, 'tool_response'), undefined); // cortado: no está entero
  assert.equal(jsonField(text, 'no_esta'), undefined);
});

test('toolInputSummary se queda con lo que necesita el registro', () => {
  assert.deepEqual(toolInputSummary('Read', { file_path: 'a.txt', offset: 5 }), { file: 'a.txt', pages: '', offset: 5, limit: null });
  assert.deepEqual(toolInputSummary('Bash', { command: 'ls', run_in_background: true }), { command: 'ls' });
  assert.deepEqual(toolInputSummary('WebSearch', { query: 'x' }), { query: 'x' });
  assert.equal(toolInputSummary('mcp__s__t', { a: 'b'.repeat(500) }).summary.length, 200);
  assert.deepEqual(toolInputSummary('Edit', { file_path: 'a.js', old_string: 'x' }), { file: 'a.js' }); // de lo editado, solo el archivo
  assert.equal(toolInputSummary('TodoWrite', { todos: [] }), null);
  assert.equal(toolInputSummary('Read', null), null);
});

async function startServer(t) {
  const events = [];
  const server = new HookServer(path.join(tempDir(t), 'hooks'), (tabId, event) => events.push({ tabId, ...event }));
  await server.start();
  t.after(() => server.stop());
  const settings = JSON.parse(fs.readFileSync(server.settingsFile('t1', { language: 'spanish' }), 'utf8'));
  const urlOf = (event) => settings.hooks[event][0].hooks[0].url;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { server, events, settings, urlOf, post };
}

test('el archivo de ajustes lleva los hooks y los ajustes extra', async (t) => {
  const { settings, server } = await startServer(t);
  assert.equal(settings.language, 'spanish');
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'PermissionRequest']) {
    assert.match(settings.hooks[event][0].hooks[0].url, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/hook/[a-f0-9]{32}/t1/${event}$`));
  }
});

test('un aviso de hook llega con lo que interesa y sin token no se atiende', async (t) => {
  const { events, urlOf, post, server } = await startServer(t);
  const res = await post(urlOf('PostToolUse'), {
    session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true }, tool_use_id: 'tu1', tool_response: { stdout: 'ok', stderr: 'aviso', interrupted: false },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ''); // sin nada que decir
  await waitFor(() => events.length === 1);
  assert.deepEqual({ ...events[0], size: null }, {
    tabId: 't1', event: 'PostToolUse', sessionId: 's1', notificationType: null, message: null,
    toolName: 'Bash', toolInput: { command: 'npm test' }, background: true, size: null, prompt: null, request: null, plan: null, planTooBig: false, cwd: null, stopHookActive: false,
    // Para «pruebas antes de terminar»: qué llamada es y, de una orden, cómo ha ido.
    toolUseId: 'tu1', shell: { command: 'npm test', output: 'ok\naviso', interrupted: false, partial: false },
    // Para el panel «Actividad».
    narr: { input: { command: 'npm test', description: '' }, task: null, agentId: null, agentType: null, transcript: null, last: null, error: null, interrupted: false },
  });
  assert.ok(events[0].size > 0);
  const bad = await post(`http://127.0.0.1:${server.port}/hook/${'0'.repeat(32)}/t1/Stop`, {});
  assert.equal(bad.status, 404);
  assert.equal(events.length, 1);
});

test('de un aviso enorme se lee el principio', async (t) => {
  const { events, urlOf, post } = await startServer(t);
  await post(urlOf('PostToolUse'), { session_id: 's2', tool_name: 'Read', tool_input: { file_path: 'grande.txt' }, tool_response: 'x'.repeat(200 * 1024) });
  await waitFor(() => events.length === 1);
  assert.equal(events[0].sessionId, 's2');
  assert.deepEqual(events[0].toolInput.file, 'grande.txt');
  assert.ok(events[0].size > 200 * 1024);
  assert.equal(events[0].shell, null);
});

test('el resultado de una orden se lee entero aunque sea grande', async (t) => {
  const { events, urlOf, post } = await startServer(t);
  const input = { command: 'npm test; git status' };
  // Más de lo que se guarda de un aviso normal: el resumen de las pruebas va al final.
  await post(urlOf('PostToolUse'), { session_id: 's3', tool_name: 'Bash', tool_input: input, tool_response: { stdout: `${'línea de relleno\n'.repeat(12000)}ℹ fail 1`, stderr: '' }, tool_use_id: 'tu9' });
  await waitFor(() => events.length === 1);
  assert.equal(events[0].toolUseId, 'tu9');
  assert.equal(events[0].shell.command, 'npm test; git status');
  assert.equal(events[0].shell.partial, false);
  assert.ok(events[0].shell.output.endsWith('ℹ fail 1'));
  assert.equal(events[0].shell.output.length, 8000);
  // Y si es descomunal, se sabe que falta: no se da por buena una salida que no se ha visto.
  await post(urlOf('PostToolUse'), { session_id: 's3', tool_name: 'Bash', tool_input: input, tool_response: { stdout: 'x'.repeat(1200 * 1024), stderr: '' }, tool_use_id: 'tu10' });
  await waitFor(() => events.length === 2);
  assert.deepEqual(events[1].shell, { command: 'npm test; git status', output: '', interrupted: false, partial: true });
});

test('la respuesta al hook lleva el contexto adicional, y el modo de pruebas bloquea los mensajes', async (t) => {
  const { server, urlOf, post } = await startServer(t);
  server.respond = (tabId, event) => (event === 'UserPromptSubmit' ? { hookSpecificOutput: { hookEventName: event, additionalContext: `hola ${tabId}` } } : null);
  const res = await post(urlOf('UserPromptSubmit'), { session_id: 's', prompt: 'x' });
  assert.equal((await res.json()).hookSpecificOutput.additionalContext, 'hola t1');
  assert.equal(await (await post(urlOf('Stop'), {})).text(), '');
  server.blockPrompts = true;
  assert.equal((await (await post(urlOf('UserPromptSubmit'), { prompt: 'x' })).json()).decision, 'block');
});

test('la línea de estado y el MCP llegan a quien los atiende', async (t) => {
  const { server, post } = await startServer(t);
  const status = [];
  server.onStatus = (tabId, data) => status.push({ tabId, data });
  const statusUrl = /http:\S+/.exec(server.statusLineCommand('t1'))[0];
  await post(statusUrl, { context_window: { used_percentage: 12 } });
  await waitFor(() => status.length === 1);
  assert.equal(status[0].data.context_window.used_percentage, 12);

  server.mcp = async (tabId, body) => ({ status: 200, json: { jsonrpc: '2.0', id: body.id, result: { tabId } } });
  const mcpUrl = JSON.parse(fs.readFileSync(server.mcpFile('t1', 'srv'), 'utf8')).mcpServers.srv.url;
  assert.deepEqual((await (await post(mcpUrl, { jsonrpc: '2.0', id: 7, method: 'ping' })).json()).result, { tabId: 't1' });
  assert.equal((await post(mcpUrl, 'esto no es JSON')).status, 400);

  server.forget('t1');
  assert.deepEqual(fs.readdirSync(server.dir), []);
});

test('quien responde recibe el aviso ya leído y puede tardar un poco', async (t) => {
  const { server, urlOf, post } = await startServer(t);
  const seen = [];
  server.respond = async (tabId, eventName, event) => {
    seen.push(event);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    return eventName === 'PostToolUse' ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: `editado ${event.toolInput.file}` } } : null;
  };
  // Una edición normal.
  const edit = await post(urlOf('PostToolUse'), { session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\app.js', old_string: 'a', new_string: 'b' } });
  assert.equal((await edit.json()).hookSpecificOutput.additionalContext, 'editado C:\\x\\app.js');
  // Un archivo grande escrito de una vez: la entrada llega cortada, pero la ruta va al principio.
  const write = await post(urlOf('PostToolUse'), { session_id: 's', tool_name: 'Write', tool_input: { file_path: 'C:\\x\\grande.py', content: 'x'.repeat(300 * 1024) } });
  assert.equal((await write.json()).hookSpecificOutput.additionalContext, 'editado C:\\x\\grande.py');
  assert.deepEqual(seen.map((e) => e.toolName), ['Edit', 'Write']);
  // Si quien responde falla, el hook contesta vacío en vez de quedarse colgado.
  server.respond = async () => { throw new Error('fallo'); };
  const failed = await post(urlOf('PostToolUse'), { tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
  assert.equal(failed.status, 200);
  assert.equal(await failed.text(), '');
});

test('la ruta del archivo escrito se encuentra aunque vaya detrás de un contenido enorme', async (t) => {
  const { server, urlOf, post } = await startServer(t);
  const seen = [];
  server.respond = (tabId, eventName, event) => { seen.push(event); return null; };
  // Como lo manda Claude Code: los campos comunes primero. El contenido va antes que la
  // ruta (relativa) y lleva un falso «"file_path":» dentro del propio texto.
  const content = JSON.stringify('const a = {"file_path": "señuelo.js"};\n'.repeat(4000));
  const body = `{"session_id":"s","cwd":"C:\\\\Código\\\\src","tool_name":"Write","tool_input":{"content":${content},"file_path":"grande.js"}}`;
  assert.ok(body.length > 64 * 1024);
  await post(urlOf('PostToolUse'), body);
  assert.equal(seen[0].toolInput.file, 'grande.js');
  assert.equal(seen[0].cwd, 'C:\\Código\\src');
  // En otra herramienta, una ruta que solo aparece en la respuesta no se toma como suya.
  const mcp = `{"session_id":"s","tool_name":"mcp__x__subir","tool_input":{"datos":${content}},"tool_response":{"file_path":"C:\\\\salida.txt"}}`;
  await post(urlOf('PostToolUse'), mcp);
  assert.equal(seen[1].toolInput, null);
});

test('los avisos llegan a la app en orden aunque la respuesta tarde', async (t) => {
  const { server, events, urlOf, post } = await startServer(t);
  let release;
  server.respond = (tabId, eventName) => (eventName === 'PostToolUse' ? new Promise((resolve) => { release = resolve; }) : null);
  const slow = post(urlOf('PostToolUse'), { tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
  await waitFor(() => events.length === 1); // la app ya lo sabe, aunque la respuesta siga pendiente
  await post(urlOf('PermissionRequest'), { tool_name: 'Bash' });
  await waitFor(() => events.length === 2);
  assert.deepEqual(events.map((e) => e.event), ['PostToolUse', 'PermissionRequest']);
  release({ marca: 'respuesta lenta' });
  // Llega la respuesta de verdad, no la vacía de cuando se agota la espera.
  assert.equal((await (await slow).json()).marca, 'respuesta lenta');
});

test('un cuerpo que no es un objeto no deja el hook colgado', async (t) => {
  const { events, urlOf, post } = await startServer(t);
  for (const body of ['null', '[1,2]', '"texto"']) {
    const res = await post(urlOf('Stop'), body);
    assert.equal(res.status, 200, body);
  }
  await waitFor(() => events.length === 3);
  assert.ok(events.every((e) => e.event === 'Stop' && e.sessionId === null));
});

test('de una edición se guarda la ruta entera, aunque sea muy larga', () => {
  const long = `C:\\${'carpeta\\'.repeat(120)}archivo.js`;
  assert.equal(toolInputSummary('Write', { file_path: long, content: 'x' }).file, long);
  assert.equal(toolInputSummary('NotebookEdit', { notebook_path: 'C:\\a.ipynb' }).file, 'C:\\a.ipynb');
});

test('el hook Stop puede esperar a una revisión larga y se cancela si Claude Code deja de esperar', async (t) => {
  const { server, settings, urlOf, post } = await startServer(t);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 900); // Stop espera hasta 15 min
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].timeout, 5); // los demás, 5 s
  // Una respuesta que tarda más que el límite de los demás avisos (2 s).
  server.respond = (tabId, eventName) => new Promise((resolve) => {
    setTimeout(() => resolve(eventName === 'Stop' ? { decision: 'block', reason: 'Codex: revisa esto' } : null), 2300);
  });
  const res = await post(urlOf('Stop'), { stop_hook_active: false });
  assert.equal((await res.json()).decision, 'block');
  // Si quien llamó se va (Esc, pestaña cerrada), quien responde recibe el aviso.
  let signal;
  server.respond = (tabId, eventName, event, s) => { signal = s; return new Promise(() => {}); };
  const controller = new AbortController();
  const pending = post(urlOf('Stop'), {}).catch(() => null);
  await waitFor(() => signal);
  controller.abort();
  // Con fetch no se puede cortar a mitad sin AbortSignal: se corta la conexión del servidor.
  server.server.closeAllConnections();
  await pending;
  await waitFor(() => signal.aborted);
});

test('si la respuesta no llega a tiempo, se contesta vacío y quien responde se entera', async (t) => {
  const { server, urlOf, post } = await startServer(t);
  let signal;
  server.respond = (tabId, eventName, event, s) => { signal = s; return new Promise(() => {}); };
  const res = await post(urlOf('PostToolUse'), { tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
  assert.equal(res.status, 200); // a los 2 s, vacío
  assert.equal(signal.aborted, true);
});

test('el plan que presenta Claude llega aparte, con espera larga y sin repetir el aviso', async (t) => {
  const { server, events, settings, post } = await startServer(t);
  const entry = settings.hooks.PreToolUse.find((h) => h.matcher === 'ExitPlanMode');
  assert.equal(entry.hooks[0].timeout, 900);
  assert.match(entry.hooks[0].url, /\/t1\/PlanReview$/);
  assert.equal(settings.hooks.PreToolUse[0].matcher, undefined); // el normal, para todas las herramientas
  let seen = null;
  server.respond = (tabId, eventName, event) => new Promise((resolve) => {
    seen = { eventName, plan: event.plan };
    setTimeout(() => resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'crítica' } }), 2300); // más que los 2 s normales
  });
  const res = await post(entry.hooks[0].url, { tool_name: 'ExitPlanMode', tool_input: { plan: '1. Hacer A\n2. Hacer B' } });
  assert.equal((await res.json()).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(seen, { eventName: 'PlanReview', plan: '1. Hacer A\n2. Hacer B' });
  assert.equal(events.length, 0); // a la interfaz ya le llega el PreToolUse normal
});

test('el mensaje del usuario llega entero para criticar un plan', async (t) => {
  const { events, urlOf, post } = await startServer(t);
  await post(urlOf('UserPromptSubmit'), { prompt: 'x'.repeat(5000) });
  await waitFor(() => events.length === 1);
  assert.equal(events[0].prompt.length, 80);
  assert.equal(events[0].request.length, 4000);
});

test('si Claude Code deja de esperar a una herramienta MCP, esta se entera', async (t) => {
  const { server } = await startServer(t);
  let signal;
  server.mcp = (tabId, body, s) => { signal = s; return new Promise(() => {}); };
  const url = `http://127.0.0.1:${server.port}/mcp/${server.token}/t1`;
  const controller = new AbortController();
  const pending = fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }), signal: controller.signal }).catch(() => null);
  await waitFor(() => signal);
  controller.abort();
  await pending;
  await waitFor(() => signal.aborted);
});

test('un plan grande se lee entero, y uno enorme se marca', async (t) => {
  const { server, settings, post } = await startServer(t);
  const url = settings.hooks.PreToolUse.find((h) => h.matcher === 'ExitPlanMode').hooks[0].url;
  const seen = [];
  server.respond = (tabId, eventName, event) => { seen.push(event); return null; };
  const plan = `1. ${'ñ'.repeat(40000)}`; // 40 000 caracteres y unos 80 KB: más que el principio que se guarda de otros avisos
  await post(url, { cwd: 'C:\\p', tool_name: 'ExitPlanMode', tool_input: { plan } });
  assert.equal(seen[0].plan, plan);
  assert.equal(seen[0].planTooBig, false);
  assert.equal(seen[0].cwd, 'C:\\p');
  // Más de 60 000 caracteres: no se recorta en silencio, se marca.
  await post(url, { tool_name: 'ExitPlanMode', tool_input: { plan: 'x'.repeat(70000) } });
  assert.deepEqual([seen[1].plan, seen[1].planTooBig], [null, true]);
  await post(url, { tool_name: 'ExitPlanMode', tool_input: { plan: 'x'.repeat(1100 * 1024) } });
  assert.equal(seen[2].planTooBig, true);
});
