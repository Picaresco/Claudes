// Módulos pequeños: guardado del estado, conversaciones, servidor MCP y plugins incluidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/main/store');
const sessions = require('../src/main/sessions');
const { createMcp } = require('../src/main/mcp');
const { tempDir } = require('./helpers');

test('Store guarda, recupera y aparta un archivo dañado', (t) => {
  const file = path.join(tempDir(t), 'sub', 'state.json');
  const store = new Store(file);
  assert.equal(store.get('x', 'defecto'), 'defecto');
  store.set('x', { a: 1 });
  store.flush();
  assert.deepEqual(new Store(file).get('x'), { a: 1 });
  fs.writeFileSync(file, '{ roto');
  const again = new Store(file);
  assert.equal(again.get('x', null), null); // empieza de cero…
  assert.equal(fs.readFileSync(file.replace(/\.json$/, '.corrupt.json'), 'utf8'), '{ roto'); // …sin perder el dañado
});

test('plan decide con qué conversación arranca una pestaña', (t) => {
  const cfg = tempDir(t);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const cwd = path.join(cfg, 'Mi proyecto');
  const dir = path.join(cfg, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const old = '11111111-1111-4111-8111-111111111111';
  const recent = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(dir, `${old}.jsonl`), '');
  fs.writeFileSync(path.join(dir, `${recent}.jsonl`), '');
  fs.writeFileSync(path.join(dir, 'notas.txt'), ''); // no es una conversación
  const past = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(dir, `${old}.jsonl`), past, past);

  // La propia de la pestaña, si existe y no está abierta en otra.
  assert.deepEqual(sessions.plan({ cwd, sessionId: old, mode: 'resume' }), { args: ['--resume', old], sessionId: old, resumed: true });
  assert.equal(sessions.plan({ cwd, sessionId: old, mode: 'resume', exclude: [old] }).resumed, false);
  assert.equal(sessions.plan({ cwd, sessionId: '33333333-3333-4333-8333-333333333333', mode: 'resume' }).resumed, false);
  // «Continuar»: la más reciente que no esté en uso.
  assert.equal(sessions.plan({ cwd, mode: 'continue' }).sessionId, recent);
  assert.equal(sessions.plan({ cwd, mode: 'continue', exclude: [recent] }).sessionId, old);
  // Nueva: un identificador propio.
  const fresh = sessions.plan({ cwd, mode: 'new' });
  assert.equal(fresh.resumed, false);
  assert.deepEqual(fresh.args, ['--session-id', fresh.sessionId]);
  assert.match(fresh.sessionId, /^[0-9a-f-]{36}$/);
  // Una carpeta sin conversaciones.
  assert.equal(sessions.plan({ cwd: path.join(cfg, 'otra'), mode: 'continue' }).resumed, false);
});

test('el servidor MCP atiende lo necesario para ofrecer herramientas', async () => {
  const tools = [{ name: 'saludar', description: 'Saluda', inputSchema: { type: 'object' } }];
  const handle = createMcp({
    name: 'prueba', version: '1.0.0', tools,
    callTool: async (tabId, name, args) => { if (args.falla) throw new Error('no puedo'); return `hola ${args.quien} desde ${tabId}`; },
  });
  const call = (body) => handle('t1', body);
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.json.result.protocolVersion, '2025-03-26');
  assert.equal(init.json.result.serverInfo.name, 'prueba');
  assert.deepEqual((await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools, tools);
  const ok = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'saludar', arguments: { quien: 'Ana' } } });
  assert.deepEqual(ok.json.result, { content: [{ type: 'text', text: 'hola Ana desde t1' }], isError: false });
  // Un fallo de la herramienta es un resultado que Claude puede leer, no un error del protocolo.
  const bad = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'saludar', arguments: { falla: true } } });
  assert.equal(bad.json.result.isError, true);
  assert.equal((await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'otra' } })).json.error.code, -32602);
  assert.equal((await call({ jsonrpc: '2.0', id: 6, method: 'no/existe' })).json.error.code, -32601);
  assert.deepEqual(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), { status: 202 }); // aviso: sin respuesta
  const batch = await call([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }]);
  assert.equal(batch.json.length, 1);
});

test('el plugin explicativo incluido está completo y su texto se puede leer', () => {
  const dir = path.join(__dirname, '..', 'src', 'plugins', 'explanatory-output-style');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'explanatory-output-style');
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-start\.sh/);
  const script = fs.readFileSync(path.join(dir, 'hooks-handlers', 'session-start.sh'), 'utf8');
  assert.ok(!script.includes('\r'), 'el script de bash tiene que llevar finales de línea LF');
  // Lo mismo que hace main.js para dar el estilo explicativo con el hook.
  const json = /<<\s*'EOF'\s*\n([\s\S]*?)\nEOF/.exec(script);
  assert.match(JSON.parse(json[1]).hookSpecificOutput.additionalContext, /★ Insight/);
});
