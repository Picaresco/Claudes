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
  assert.equal(toolInputSummary('Edit', { file_path: 'a' }), null);
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
  const res = await post(urlOf('PostToolUse'), { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ''); // sin nada que decir
  await waitFor(() => events.length === 1);
  assert.deepEqual({ ...events[0], size: null }, {
    tabId: 't1', event: 'PostToolUse', sessionId: 's1', notificationType: null, message: null,
    toolName: 'Bash', toolInput: { command: 'npm test' }, background: true, size: null, prompt: null,
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
