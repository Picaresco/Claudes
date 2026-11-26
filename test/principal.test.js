// Las piezas del proceso principal que no dependen de Electron: la tabla de pestañas,
// el estilo de las respuestas y los plugins, las consolas, los procesos de terminal,
// lo que se lee de Claude Code y el registro de depuración.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Tabs } = require('../src/main/tabs');
const { createStyle, EXPLAIN_PLUGIN, DESIGN_PLUGIN, YOU_SHOULD_KNOW, BRIEF_TEXT } = require('../src/main/style');
const { childEnv, quoteForCmd, shellList, shellCommand, SESSION_MARKERS } = require('../src/main/shells');
const { createPtys } = require('../src/main/ptys');
const { userSettings, usageFrom } = require('../src/main/claude-config');
const { createAppLog, localStamp, safeFileName } = require('../src/main/applog');
const { tempDir, waitFor } = require('./helpers');

test('la tabla de pestañas nombra, lista las conversaciones y olvida todo de una vez', () => {
  const tabs = new Tabs();
  assert.equal(tabs.get('t1'), undefined);
  assert.equal(tabs.label('t1'), '«t1»'); // sin nombre todavía
  const tab = tabs.ensure('t1');
  assert.equal(tabs.ensure('t1'), tab); // siempre el mismo registro
  assert.equal(tab.style, undefined); // hasta que arranque una sesión
  Object.assign(tab, { name: 'Proyecto', folder: 'C:\\x', session: 's1', log: 'a.log', usage: { pct: 5 } });
  tabs.ensure('t2');
  assert.equal(tabs.label('t1'), '«Proyecto»');
  assert.equal(tabs.label('t1:sh'), '«Proyecto» (terminal extra)');
  assert.deepEqual([...tabs.sessions()], [['t1', 's1']]); // t2 no tiene conversación
  tabs.forget('t1');
  assert.equal(tabs.get('t1'), undefined);
  assert.equal(tabs.sessions().size, 0);
});

function makeStyle(t, { gitBash = 'C:\\Git\\bin\\bash.exe', settings = {} } = {}) {
  const tabs = new Tabs();
  const logs = [];
  const dstDir = path.join(tempDir(t), 'plugins');
  const style = createStyle({
    srcDir: path.join(__dirname, '..', 'src', 'plugins'),
    dstDir,
    userSettings: () => settings,
    gitBash,
    tabs,
    log: (text) => logs.push(text),
    label: (id) => tabs.label(id),
  });
  return { style, tabs, logs, dstDir };
}

const plugin = (dstDir, name) => ({ name, dir: path.join(dstDir, name) });
const names = (plugins) => plugins.map((p) => p.name);

test('los plugins se copian y se pasan a las sesiones; en modo resumido, sin el explicativo', (t) => {
  const { style, dstDir } = makeStyle(t);
  assert.deepEqual(style.prepare(), [EXPLAIN_PLUGIN, DESIGN_PLUGIN]);
  assert.ok(fs.existsSync(path.join(dstDir, EXPLAIN_PLUGIN, 'hooks-handlers', 'session-start.sh')));
  assert.ok(fs.existsSync(path.join(dstDir, DESIGN_PLUGIN, 'skills', DESIGN_PLUGIN, 'SKILL.md')));
  assert.deepEqual(style.sessionPlugins(), [plugin(dstDir, EXPLAIN_PLUGIN), plugin(dstDir, DESIGN_PLUGIN)]);
  style.brief = true;
  assert.deepEqual(style.sessionPlugins(), [plugin(dstDir, DESIGN_PLUGIN)]);
});

test('sin Git Bash solo va el de diseño; el que el usuario ya tiene activado no se pasa', (t) => {
  const none = makeStyle(t, { gitBash: null });
  assert.deepEqual(none.style.prepare(), [DESIGN_PLUGIN]);
  assert.deepEqual(names(none.style.sessionPlugins()), [DESIGN_PLUGIN]);
  const mine = makeStyle(t, { settings: { enabledPlugins: { [`${EXPLAIN_PLUGIN}@claude-plugins-official`]: true } } });
  mine.style.prepare();
  assert.deepEqual(names(mine.style.sessionPlugins()), [DESIGN_PLUGIN]);
  const both = makeStyle(t, { settings: { enabledPlugins: { [`${EXPLAIN_PLUGIN}@claude-plugins-official`]: true, [`${DESIGN_PLUGIN}@claude-plugins-official`]: true } } });
  both.style.prepare();
  assert.deepEqual(both.style.sessionPlugins(), []);
  // Apagado por el usuario en su Claude Code: el de diseño se respeta; el explicativo lo decide «Resumido».
  const off = makeStyle(t, { settings: { enabledPlugins: { [`${EXPLAIN_PLUGIN}@claude-plugins-official`]: false, [`${DESIGN_PLUGIN}@claude-plugins-official`]: false } } });
  off.style.prepare();
  assert.deepEqual(names(off.style.sessionPlugins()), [EXPLAIN_PLUGIN]);
});

test('«You should know» se enciende salvo que el usuario ya lo haya decidido', (t) => {
  const { style } = makeStyle(t);
  assert.deepEqual(style.sessionSettings({}), { enabledPlugins: { [YOU_SHOULD_KNOW]: true } });
  assert.deepEqual(style.sessionSettings({ enabledPlugins: { [YOU_SHOULD_KNOW]: false } }), {});
  assert.deepEqual(style.sessionSettings({ enabledPlugins: { [YOU_SHOULD_KNOW]: true } }), {});
});

test('el interruptor «Resumido» se le dice a cada sesión una vez, con su siguiente mensaje', (t) => {
  const { style, tabs, logs } = makeStyle(t);
  style.prepare();
  assert.equal(style.update('t1'), null); // todavía no es una sesión de ClaudHome
  style.started('t1', style.sessionPlugins()); // arranca con el plugin: ya explica
  assert.equal(tabs.get('t1').style, 'explain');
  assert.equal(style.update('t1'), null); // nada que cambiar

  style.brief = true;
  assert.equal(style.update('t1'), BRIEF_TEXT);
  assert.equal(style.update('t1'), null); // ya lo sabe
  assert.match(logs.join('\n'), /pasa a resumido/);

  style.brief = false;
  const back = style.update('t1');
  assert.match(back, /modo explicativo/);
  assert.match(back, /★ Insight/); // el texto del propio plugin
  assert.equal(style.update('t1'), null);
});

test('una sesión que arranca sin el plugin recibe el estilo con su primer mensaje', (t) => {
  const brief = makeStyle(t);
  brief.style.prepare();
  brief.style.brief = true;
  brief.style.started('t1', brief.style.sessionPlugins()); // en resumido arranca sin plugin
  assert.equal(brief.tabs.get('t1').style, null);
  assert.equal(brief.style.update('t1'), BRIEF_TEXT);

  const noBash = makeStyle(t, { gitBash: null });
  noBash.style.prepare();
  noBash.style.started('t1', noBash.style.sessionPlugins());
  assert.match(noBash.style.update('t1'), /★ Insight/); // sin Git Bash, el estilo explicativo lo da el hook
});

test('el entorno de las pestañas no hereda las marcas de una sesión de Claude Code', (t) => {
  const before = { ...process.env };
  t.after(() => { for (const name of SESSION_MARKERS) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
  process.env.CLAUDECODE = '1';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const env = childEnv({ CLAUDES_TAB_ID: 't1' });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TERM_PROGRAM, 'Claudes');
  assert.equal(env.CLAUDES_TAB_ID, 't1');
  // El resto del entorno pasa tal cual. En Windows la variable puede llamarse «Path»:
  // process.env la encuentra con cualquier mayúscula, pero una copia no.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  assert.equal(env[pathKey], process.env.PATH);
});

test('las consolas y las comillas para cmd.exe', () => {
  assert.equal(quoteForCmd('simple'), 'simple');
  assert.equal(quoteForCmd('C:\\Mis documentos\\a.txt'), '"C:\\Mis documentos\\a.txt"');
  assert.equal(quoteForCmd('di "hola"'), '"di ""hola"""');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.deepEqual(shellList().slice(0, 2).map((s) => s.key), ['powershell', 'cmd']);
  assert.equal(shellCommand('otra').file, 'powershell.exe');
  assert.deepEqual(shellCommand('cmd').args, []);
});

// Un node-pty de mentira: guarda lo que se le pide y deja simular su salida.
function fakePty() {
  const procs = [];
  return {
    procs,
    spawn(file, args, options) {
      const proc = { file, args, options, written: [], resized: null, killed: false, onData(fn) { proc.data = fn; }, onExit(fn) { proc.exit = fn; },
        write(data) { proc.written.push(data); }, resize(cols, rows) { proc.resized = [cols, rows]; }, kill() { proc.killed = true; setTimeout(() => proc.exit({ exitCode: 1 }), 5); } };
      procs.push(proc);
      return proc;
    },
  };
}

test('los procesos de terminal agrupan la salida, avisan al salir y se cierran', async () => {
  const pty = fakePty();
  const sent = [];
  const logs = [];
  const ptys = createPtys({ pty, send: (...args) => sent.push(args), log: (text) => logs.push(text), label: (id) => `«${id}»` });
  ptys.spawn('t1', 'claude.exe', ['--resume', 'x'], { cols: 3, rows: 2, cwd: 'C:\\x', env: {} });
  const proc = pty.procs[0];
  assert.deepEqual([proc.options.cols, proc.options.rows], [20, 5]); // tamaño mínimo
  assert.equal(ptys.has('t1'), true);

  proc.data('hola ');
  proc.data('mundo');
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0], ['pty:data', 't1', 'hola mundo']); // dos trozos, un solo aviso

  ptys.write('t1', 'ls\r');
  ptys.write('t1', 42); // lo que no es texto se ignora
  ptys.write('otra', 'x'); // y lo de una pestaña sin proceso
  assert.deepEqual(proc.written, ['ls\r']);
  ptys.resize('t1', 120, 40);
  ptys.resize('t1', 1, 40); // tamaño imposible: se ignora
  assert.deepEqual(proc.resized, [120, 40]);

  // Sale por su cuenta: se avisa a la interfaz.
  proc.exit({ exitCode: 0 });
  assert.deepEqual(sent[1], ['pty:exit', 't1', 0]);
  assert.equal(ptys.has('t1'), false);
  assert.match(logs[0], /proceso de «t1» termina con código 0$/);

  // Lo cierra la app: se espera a que salga y no se avisa como salida inesperada.
  ptys.spawn('t2', 'cmd.exe', [], { cols: 80, rows: 24, cwd: 'C:\\x', env: {} });
  await ptys.kill('t2');
  assert.equal(pty.procs[1].killed, true);
  assert.equal(sent.filter(([channel]) => channel === 'pty:exit').length, 1);
  assert.match(logs[1], /cerrado por la app/);
  await ptys.kill('no-existe'); // no falla
});

test('el tamaño pedido mientras el proceso arranca o se cierra no se pierde', async () => {
  const pty = fakePty();
  const ptys = createPtys({ pty, send: () => {}, log: () => {}, label: (id) => id });
  // La terminal cambia de ancho antes de que exista el proceso (p. ej. aparece «Actividad»).
  ptys.resize('t1', 96, 30);
  ptys.spawn('t1', 'claude.exe', [], { cols: 140, rows: 30, cwd: 'C:\\x', env: {} });
  assert.deepEqual([pty.procs[0].options.cols, pty.procs[0].options.rows], [96, 30]);
  // Al reiniciar: lo que llega mientras se cierra el anterior es para el nuevo.
  const closing = ptys.kill('t1');
  ptys.resize('t1', 110, 32);
  await closing;
  assert.equal(pty.procs[0].resized, null);
  ptys.spawn('t1', 'claude.exe', [], { cols: 96, rows: 30, cwd: 'C:\\x', env: {} });
  assert.deepEqual([pty.procs[1].options.cols, pty.procs[1].options.rows], [110, 32]);
  // Ya usado: el siguiente arranque, con lo que pida la interfaz.
  await ptys.kill('t1');
  ptys.spawn('t1', 'claude.exe', [], { cols: 120, rows: 40, cwd: 'C:\\x', env: {} });
  assert.deepEqual([pty.procs[2].options.cols, pty.procs[2].options.rows], [120, 40]);
});

test('usageFrom calcula el llenado de la conversación', () => {
  assert.equal(usageFrom({}), null);
  assert.equal(usageFrom({ context_window: { context_window_size: 0 } }), null);
  assert.deepEqual(usageFrom({ context_window: { context_window_size: 200000, used_percentage: 41.6 } }), { size: 200000, used: null, pct: 42 });
  assert.deepEqual(usageFrom({ context_window: { context_window_size: 1000, current_usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 } } }),
    { size: 1000, used: 250, pct: 25 });
});

test('userSettings lee la configuración de Claude Code, también con BOM o sin archivo', (t) => {
  const dir = tempDir(t);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  assert.deepEqual(userSettings(), {}); // sin archivo
  fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF{"language":"spanish"}');
  assert.deepEqual(userSettings(), { language: 'spanish' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ roto');
  assert.deepEqual(userSettings(), {});
});

test('el registro de depuración escribe por días, se puede apagar y limpia lo antiguo', async (t) => {
  const dir = path.join(tempDir(t), 'logs');
  const logger = createAppLog(() => dir);
  logger.log('primera\nlínea');
  logger.enabled = false;
  logger.log('esto no se apunta');
  logger.enabled = true;
  logger.log('segunda');
  const file = path.join(dir, `claudes-${localStamp().slice(0, 8)}.log`);
  await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('segunda'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\d\d:\d\d:\d\d\.\d{3} primera ⏎ línea\n\d\d:\d\d:\d\d\.\d{3} segunda\n$/);
  // Un registro de hace dos semanas se borra; el de hoy, no.
  const old = path.join(dir, 'viejo.log');
  fs.writeFileSync(old, 'x');
  const past = Date.now() / 1000 - 14 * 86400;
  fs.utimesSync(old, past, past);
  logger.clean();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(file), true);
  assert.equal(safeFileName('Mi proyecto: web/2'), 'Mi_proyecto__web_2');
  assert.equal(safeFileName(''), 'sesion');
});
