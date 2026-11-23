// Panel «Actividad» (src/main/narrator.js): pasos al momento, Haiku los cuenta y, con el
// panel cerrado, no se le pregunta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createNarrator, describe, commandLabel, shortName, readTranscript, buildPrompt, parseLines, firstSentence,
} = require('../src/main/narrator');
const { narration, HookServer } = require('../src/main/hooks');
const { tempDir } = require('./helpers');

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('no ha llegado a tiempo');
    await wait(10);
  }
}
const answer = (lineas) => ({ code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ lineas }) }) });

test('cada herramienta se cuenta con palabras de todos los días', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'ya.js'), 'x');
  const ctx = { folder: dir, cwd: dir };
  assert.equal(describe('Read', { file: path.join(dir, 'src', 'calc.js') }, ctx).show, 'Leyendo src/calc.js');
  assert.equal(describe('Read', { file: path.join(dir, 'a', 'b', 'c', 'd.js') }, ctx).show, 'Leyendo …/c/d.js');
  assert.equal(describe('Read', { file: 'C:\\otra\\cosa\\fuera.md' }, ctx).show, 'Leyendo fuera.md');
  assert.equal(describe('Write', { file: path.join(dir, 'nuevo.js') }, ctx).show, 'Creando nuevo.js');
  assert.equal(describe('Write', { file: 'ya.js' }, ctx).show, 'Reescribiendo ya.js'); // relativa a la carpeta de trabajo
  assert.equal(describe('Edit', { file: path.join(dir, 'ya.js') }, ctx).kind, 'edit');
  assert.equal(describe('Grep', { pattern: 'precioConIva' }, ctx).info, 'Busca el texto «precioConIva» en el proyecto');
  assert.equal(describe('WebFetch', { url: 'https://www.example.com/a?token=secreto' }, ctx).show, 'Leyendo la web example.com');
  assert.doesNotMatch(describe('WebFetch', { url: 'https://www.example.com/a?token=secreto' }, ctx).info, /secreto/);
  const tests = describe('Bash', { command: 'npm test 2>&1 | tail -12', description: 'Run the tests' }, ctx);
  assert.deepEqual([tests.kind, tests.show], ['tests', 'Pasando las pruebas']);
  assert.match(tests.info, /su descripción: «Run the tests»/);
  const agent = describe('Agent', { agent: 'Explore', task: 'Buscar el cálculo del IVA' }, ctx);
  assert.equal(agent.show, 'Llamando a un agente «Explore»: Buscar el cálculo del IVA');
  assert.equal(agent.wait, 'Esperando al agente «Buscar el cálculo del IVA»');
  assert.match(describe('TodoWrite', { todos: [{ content: 'Leer calc.js', status: 'completed' }, { content: 'Unir funciones', status: 'in_progress' }] }, ctx).info, /Leer calc\.js \(hecha\); Unir funciones \(en curso\)/);
  assert.equal(describe('mcp__claudhome-codex__segunda_opinion', {}, ctx).kind, 'codex');
  assert.equal(describe('mcp__claude_ai_Gmail__search_threads', { summary: '{"q":"x"}' }, ctx).show, 'Usando «search threads» de Gmail');
  assert.equal(describe('ToolSearch', {}, ctx), null);
  assert.equal(describe('Inventada', {}, ctx).show, 'Usando Inventada');
  assert.equal(shortName('', dir, dir), 'un archivo');
});

test('los comandos se reconocen aunque empiecen por cd o lleven variables, y sin claves', () => {
  assert.equal(commandLabel('cd /c/proyecto && git status --short', 'bash'), 'Mirando los cambios en git');
  assert.equal(commandLabel('git -C x commit -m "algo"', 'bash'), 'Guardando los cambios en git');
  assert.equal(commandLabel('npm ci', 'bash'), 'Instalando dependencias');
  assert.equal(commandLabel('NODE_ENV=test npm run build', 'bash'), 'Ejecutando «build»');
  assert.equal(commandLabel('Get-ChildItem -Recurse src', 'powershell'), 'Mirando qué archivos hay');
  assert.equal(commandLabel('node --test', 'bash'), 'Pasando las pruebas');
  assert.equal(commandLabel('"C:\\Program Files\\nodejs\\node.exe" script.js', 'powershell'), 'Ejecutando un programa de JavaScript');
  const odd = commandLabel('mysql -u root --password=superSecreta123 < datos.sql', 'bash');
  assert.match(odd, /^Ejecutando «mysql/);
  assert.doesNotMatch(odd, /superSecreta/);
  assert.equal(commandLabel('', 'bash'), 'Ejecutando un comando');
});

test('del registro de la conversación se leen los textos de Claude (no los de sus agentes) y solo líneas enteras', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'conv.jsonl');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line({ type: 'user', message: { content: [{ type: 'text', text: 'hola' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Voy a leer calc.js.' }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read' }] } })
    + line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'del agente' }] } })
    + '{"type":"assistant","message":{"content":[{"type":"text","text":"a me');
  const first = readTranscript(file, 0);
  assert.deepEqual(first.items, [{ type: 'text', text: 'Voy a leer calc.js.' }, { type: 'tool', id: 'tu1' }]);
  fs.appendFileSync(file, 'dias"}]}}\n');
  const second = readTranscript(file, first.offset);
  assert.deepEqual(second.items, [{ type: 'text', text: 'a medias' }]);
  assert.deepEqual(readTranscript(file, second.offset).items, []);
  assert.deepEqual(readTranscript(path.join(dir, 'no-existe.jsonl'), 0).items, []);
});

test('lo que se le pregunta a Haiku y cómo se entiende lo que contesta', () => {
  const text = buildPrompt({
    request: 'Arregla el IVA', recent: ['He mirado calc.js.'], final: true,
    steps: [{ info: 'Lee el archivo calc.js' }, { info: 'Ejecuta un comando', agent: 'Explore' }],
  });
  assert.match(text, /Lo que ha pedido el usuario: «Arregla el IVA»/);
  assert.match(text, /- He mirado calc\.js\./);
  assert.match(text, /1\. Lee el archivo calc\.js\n2\. \[un agente «Explore» que trabaja para Claude\] Ejecuta un comando/);
  assert.match(text, /una sola línea que empiece por «Listo:»/);
  assert.doesNotMatch(buildPrompt({ request: '', recent: [], steps: [{ info: 'x' }], final: false }), /Listo:/);
  assert.deepEqual(parseLines(answer([{ tipo: 'fallo', texto: 'Ha fallado una `prueba`.' }, { tipo: 'raro', texto: 'Listo: todo bien.' }, 'Sin tipo.', { tipo: 'leer' }]).stdout), [
    { kind: 'fail', text: 'Ha fallado una prueba.' }, { kind: 'done', text: 'Listo: todo bien.' }, { kind: 'say', text: 'Sin tipo.' },
  ]);
  assert.ok(parseLines(answer([{ tipo: 'otro', texto: 'palabra '.repeat(60) }]).stdout)[0].text.length <= 201);
  assert.equal(parseLines('no es JSON'), null);
  assert.equal(parseLines(JSON.stringify({ is_error: true, result: '{"lineas":[]}' })), null);
  assert.deepEqual(parseLines(answer([]).stdout), []);
  assert.equal(firstSentence('Voy a leer calc.js para ver el IVA. Después lo cambio.'), 'Voy a leer calc.js para ver el IVA.');
});

// Una pestaña de prueba con su carpeta y un Haiku de mentira que apunta lo que recibe y contesta
// cada vez una frase distinta.
const SAID = ['Miro calc.js e iva.js', 'Las pruebas fallan por el redondeo', 'Cambio el tipo del impuesto', 'Reviso el total final', 'Compruebo otra cosa distinta', 'Leo la documentación'];
function setup(t, { enabled = true, reply = null } = {}) {
  const dir = tempDir(t);
  const tabs = new Map([['t1', { name: 'Prueba', folder: dir }]]);
  const sent = [];
  const asked = [];
  const logs = [];
  const narrator = createNarrator({
    tabs, enabled, gather: 30, gap: 0, findClaude: () => 'claude.exe', workDir: () => dir, log: (x) => logs.push(x),
    send: (channel, tabId, snap) => sent.push({ channel, tabId, snap }),
    run: async (_cmd, input) => { asked.push(input); return reply ? reply(input, asked.length) : answer([{ tipo: 'leer', texto: SAID[(asked.length - 1) % SAID.length] }]); },
  });
  t.after(() => narrator.stop());
  const last = () => narrator.get('t1');
  const ev = (event, extra = {}) => narrator.event('t1', { event, cwd: dir, ...extra, narr: { input: {}, ...(extra.narr || {}) } });
  return { dir, narrator, sent, asked, logs, last, ev };
}

test('cada paso sale al momento en gris y, a los pocos segundos, Haiku lo cuenta en su lugar', async (t) => {
  const { dir, asked, last, ev } = setup(t);
  ev('UserPromptSubmit', { request: 'Arregla el cálculo del IVA' });
  assert.deepEqual(last().now && last().now.text, 'Pensando…');
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'a', narr: { input: { file: path.join(dir, 'calc.js') } } });
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'b', narr: { input: { file: path.join(dir, 'iva.js') } } });
  // Al momento: la petición y una sola línea gris con los dos archivos.
  assert.deepEqual(last().entries.map((e) => [e.src, e.text, e.pending]), [
    ['user', 'Arregla el cálculo del IVA', false], ['local', 'Leyendo calc.js, iva.js', true],
  ]);
  assert.equal(last().now.text, 'Leyendo iva.js');
  await waitFor(() => last().entries.some((e) => e.src === 'haiku'));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Lo que ha pedido el usuario: «Arregla el cálculo del IVA»/);
  assert.match(asked[0], /1\. Lee el archivo calc\.js\n2\. Lee el archivo iva\.js/);
  assert.deepEqual(last().entries.map((e) => [e.src, e.kind, e.text]), [
    ['user', 'user', 'Arregla el cálculo del IVA'], ['haiku', 'read', 'Miro calc.js e iva.js'],
  ]);
  // Terminan las lecturas: piensa. Falla un comando: se cuenta el fallo con su motivo.
  ev('PostToolUse', { toolName: 'Read', toolUseId: 'a' });
  ev('PostToolUse', { toolName: 'Read', toolUseId: 'b' });
  assert.equal(last().now.text, 'Pensando…');
  ev('PreToolUse', { toolName: 'Bash', toolUseId: 'c', narr: { input: { command: 'npm test', description: 'Run tests' } } });
  ev('PostToolUseFailure', { toolName: 'Bash', toolUseId: 'c', narr: { error: 'Exit code 1\n1 failing' } });
  assert.deepEqual(last().entries.slice(-2).map((e) => e.text), ['Pasando las pruebas', 'No ha salido: pasando las pruebas']);
  await waitFor(() => asked.length === 2);
  assert.match(asked[1], /- Miro calc.js e iva.js/); // lo ya contado, para no repetirlo
  assert.match(asked[1], /FALLA el paso «Ejecuta un comando \(su descripción: «Run tests»\): npm test»: Exit code 1 1 failing/);
  // Al pararse: el final con la respuesta de Claude, enseguida.
  ev('Stop', { narr: { last: 'He corregido el IVA y las pruebas pasan.' } });
  assert.equal(last().now, null);
  await waitFor(() => asked.length === 3);
  assert.match(asked[2], /Termina la tarea y le responde al usuario: «He corregido el IVA y las pruebas pasan\.»/);
  assert.match(asked[2], /empiece por «Listo:»/);
  await waitFor(() => !last().entries.some((e) => e.pending));
});

test('con la actividad desactivada no se le pregunta a Haiku y los pasos se quedan con sus palabras', async (t) => {
  const { dir, narrator, asked, last, ev } = setup(t, { enabled: false });
  ev('UserPromptSubmit', { request: 'Hola' });
  ev('PreToolUse', { toolName: 'Edit', toolUseId: 'a', narr: { input: { file: path.join(dir, 'a.js') } } });
  await wait(120);
  assert.equal(asked.length, 0);
  assert.deepEqual(last().entries.map((e) => [e.text, e.pending]), [['Hola', false], ['Cambiando a.js', false]]);
  assert.equal(last().enabled, false);
  // Se abre: lo nuevo ya se cuenta. Se cierra con pasos esperando: se quedan como están.
  narrator.setEnabled(true);
  ev('PreToolUse', { toolName: 'Edit', toolUseId: 'b', narr: { input: { file: path.join(dir, 'b.js') } } });
  await waitFor(() => asked.length === 1);
  ev('PreToolUse', { toolName: 'Edit', toolUseId: 'c', narr: { input: { file: path.join(dir, 'c.js') } } });
  narrator.setEnabled(false);
  await wait(120);
  assert.equal(asked.length, 1);
  assert.deepEqual(last().entries.slice(-1).map((e) => [e.text, e.pending]), [['Cambiando c.js', false]]);
});

test('si Haiku no contesta, se quedan los pasos y, tras varios fallos, se le deja descansar', async (t) => {
  const { dir, asked, last, ev, logs } = setup(t, { reply: () => ({ code: 1, stdout: '' }) });
  for (const [n, file] of ['a.js', 'b.js', 'c.js', 'd.js'].entries()) {
    ev('PreToolUse', { toolName: 'Edit', toolUseId: `x${n}`, narr: { input: { file: path.join(dir, file) } } });
    if (n < 3) await waitFor(() => asked.length === n + 1);
  }
  await wait(120);
  assert.equal(asked.length, 3); // el cuarto ya no se pregunta
  assert.deepEqual(last().entries.map((e) => [e.text, e.pending]), [['Cambiando a.js', false], ['Cambiando b.js', false], ['Cambiando c.js', false], ['Cambiando d.js', false]]);
  assert.match(logs.join('\n'), /Haiku ha fallado 3 veces seguidas/);
});

test('lo que escribe Claude va delante de la herramienta que lo sigue, y su respuesta final no se repite', async (t) => {
  const { dir, asked, ev } = setup(t);
  const conv = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(conv, '');
  const add = (content) => fs.appendFileSync(conv, `${JSON.stringify({ type: 'assistant', message: { content } })}\n`);
  ev('UserPromptSubmit', { request: 'Revisa', narr: { transcript: conv } });
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'tu1', narr: { input: { file: path.join(dir, 'a.js') }, transcript: conv } });
  // El texto que precede a la herramienta llega al registro un poco después.
  add([{ type: 'text', text: 'Primero miro a.js para entender el problema.' }]);
  add([{ type: 'tool_use', id: 'tu1', name: 'Read' }]);
  ev('PostToolUse', { toolName: 'Read', toolUseId: 'tu1', narr: { transcript: conv } });
  add([{ type: 'text', text: 'Todo correcto: a.js está bien.' }]);
  ev('Stop', { narr: { transcript: conv, last: 'Todo correcto: a.js está bien.' } });
  await waitFor(() => asked.length >= 1);
  await wait(60);
  const all = asked.join('\n');
  assert.match(all, /1\. Claude escribe: «Primero miro a\.js para entender el problema\.»\n2\. Lee el archivo a\.js/);
  assert.equal(all.match(/Todo correcto/g).length, 1); // solo en el final
});

test('los pasos de un agente llevan su nombre y, mientras trabaja, se le espera', async (t) => {
  const { dir, last, ev, asked } = setup(t);
  ev('PreToolUse', { toolName: 'Agent', toolUseId: 'ag', narr: { input: { agent: 'Explore', task: 'Buscar el IVA' } } });
  ev('SubagentStart', { narr: { agentId: 'a1', agentType: 'Explore' } });
  ev('PreToolUse', { toolName: 'Grep', toolUseId: 'g1', narr: { input: { pattern: 'IVA' }, agentId: 'a1', agentType: 'Explore' } });
  assert.equal(last().now.text, 'Agente «Explore»: buscando «IVA»');
  ev('PostToolUse', { toolName: 'Grep', toolUseId: 'g1', narr: { agentId: 'a1', agentType: 'Explore' } });
  assert.equal(last().now.text, 'Esperando al agente «Buscar el IVA»');
  ev('SubagentStop', { narr: { agentId: 'a1', agentType: 'Explore', last: 'El IVA está en calc.js' } });
  await waitFor(() => asked.length >= 1);
  await wait(60);
  assert.match(asked.join('\n'), /\[un agente «Explore» que trabaja para Claude\] Busca el texto «IVA»/);
  assert.match(asked.join('\n'), /El agente «Explore» termina y le cuenta a Claude: «El IVA está en calc\.js»/);
  ev('PostToolUse', { toolName: 'Agent', toolUseId: 'ag' });
  assert.equal(last().now.text, 'Pensando…');
  assert.ok(dir);
});

test('el aviso trae lo del panel: el agente, el registro, la respuesta final y el error', async (t) => {
  const n = narration('PostToolUseFailure', {
    tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' }, agent_id: 'a1', agent_type: 'Explore',
    transcript_path: 'C:\\x\\conv.jsonl', error: 'Exit code 1', is_interrupt: false,
  });
  assert.deepEqual(n, {
    input: { command: 'npm test', description: 'Run tests' }, agentId: 'a1', agentType: 'Explore', transcript: 'C:\\x\\conv.jsonl', last: null, error: 'Exit code 1', interrupted: false,
  });
  assert.equal(narration('Stop', { last_assistant_message: 'Hecho.' }).last, 'Hecho.');
  assert.equal(narration('PostToolUse', { error: 'x' }).error, null);
  const dir = tempDir(t);
  const server = new HookServer(dir, () => {});
  await server.start();
  t.after(() => server.stop());
  const settings = JSON.parse(fs.readFileSync(server.settingsFile('t1'), 'utf8'));
  assert.ok(settings.hooks.SubagentStart && settings.hooks.SubagentStop);
});

test('lo que se vio en la prueba real: patrones legibles, trámites fuera y agentes ajenos sin contar', async (t) => {
  const { dir, last, ev, asked } = setup(t);
  const ctx = { folder: dir, cwd: dir };
  assert.equal(describe('Glob', { pattern: '**/*.js' }, ctx).show, 'Buscando archivos (**/*.js)');
  assert.equal(describe('Grep', { pattern: '(?i)(iva|vat)+' }, ctx).show, 'Buscando en el código');
  assert.match(describe('Grep', { pattern: '(?i)(iva|vat)+' }, ctx).info, /con la expresión «\(\?i\)\(iva\|vat\)\+»/);
  assert.equal(describe('SubagentHandback', {}, ctx), null);
  // El informe de un agente en segundo plano llega como un mensaje, pero no lo ha escrito el usuario.
  ev('UserPromptSubmit', { request: 'Arregla el IVA' });
  ev('SubagentStart', { narr: { agentId: 'a1', agentType: 'Explore' } });
  assert.equal(last().now.text, 'Pensando… (el agente «Explore» trabaja en paralelo)');
  ev('UserPromptSubmit', { request: '<agent-message from="a1" [Subagent hand-back] The text below is the final report>El IVA está en calc.js</agent-message>' });
  assert.deepEqual(last().entries.filter((e) => e.src === 'user').map((e) => e.text), ['Arregla el IVA']);
  assert.equal(last().entries[last().entries.length - 1].text, 'Le llega el informe de un agente');
  // Un agente que no se ha visto empezar (el de un plugin) no se cuenta; el visto, una vez.
  ev('SubagentStop', { narr: { agentId: 'otro', agentType: null, last: 'nada' } });
  ev('SubagentStop', { narr: { agentId: 'a1', agentType: 'Explore', last: 'hecho' } });
  ev('SubagentStop', { narr: { agentId: 'a1', agentType: 'Explore', last: 'hecho' } });
  await waitFor(() => asked.length >= 1);
  await wait(60);
  const all = asked.join('\n');
  assert.match(all, /Lo que ha pedido el usuario: «Arregla el IVA»/);
  assert.match(all, /Le llega el informe final de un agente que trabajaba en segundo plano: «.*El IVA está en calc\.js»/);
  assert.equal((all.match(/El agente «Explore» termina/g) || []).length, 1);
  assert.doesNotMatch(all, /agente «agente»/);
});

test('un texto de Claude que llega cuando su paso ya se contó solo sirve de contexto, sin línea propia', async (t) => {
  const { dir, asked, last, ev } = setup(t);
  const conv = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(conv, '');
  const add = (content) => fs.appendFileSync(conv, `${JSON.stringify({ type: 'assistant', message: { content } })}\n`);
  ev('UserPromptSubmit', { request: 'Revisa', narr: { transcript: conv } });
  ev('PreToolUse', { toolName: 'Agent', toolUseId: 'tu1', narr: { input: { agent: 'Explore', task: 'Buscar el IVA' }, transcript: conv } });
  await waitFor(() => asked.length === 1); // ya contado
  add([{ type: 'text', text: 'Primero lanzo un agente para buscar el IVA.' }]);
  add([{ type: 'tool_use', id: 'tu1', name: 'Agent' }]);
  ev('PostToolUse', { toolName: 'Agent', toolUseId: 'tu1', narr: { transcript: conv } });
  await wait(120);
  assert.equal(asked.length, 1); // solo contexto: no se pregunta por ello
  assert.ok(!last().entries.some((e) => /Primero lanzo/.test(e.text)));
  // Con el siguiente paso, va como contexto.
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'tu2', narr: { input: { file: path.join(dir, 'a.js') }, transcript: conv } });
  await waitFor(() => asked.length === 2);
  assert.match(asked[1], /antes de pasos que ya le has contado \(no lo cuentes otra vez[^\n]*\n- «Primero lanzo un agente para buscar el IVA\.»/);
  assert.match(asked[1], /1\. Lee el archivo a\.js/);
  // La respuesta final en trozos (un bloque de texto y una lista) no se cuenta dos veces.
  add([{ type: 'text', text: 'Las pruebas ya pasan:' }]);
  ev('Stop', { narr: { transcript: conv, last: 'Las pruebas ya pasan:\n- iva\n- total' } });
  await waitFor(() => asked.length === 3);
  assert.doesNotMatch(asked[2], /Claude escribe/);
});

test('lo que Haiku repite con otras palabras no se enseña, y como mucho una línea por paso', () => {
  const { similar, fresh } = require('../src/main/narrator');
  // Lo que pasó en la prueba real: tres veces lo mismo.
  assert.ok(similar('Primero voy a buscar dónde se calcula el IVA en el proyecto, con un agente de exploración.', 'Lanzo un agente de exploración para localizar dónde se calcula el IVA en el proyecto.'));
  assert.ok(!similar('Vuelvo a pasar las pruebas para ver si el cambio arregla los dos fallos.', 'Ahora ejecuto las pruebas para ver qué está fallando exactamente.'));
  const lines = [
    { kind: 'plan', text: 'Primero voy a buscar dónde se calcula el IVA en el proyecto.' },
    { kind: 'agent', text: 'Lanzo un agente para buscar dónde se calcula el IVA en el proyecto.' },
    { kind: 'tests', text: 'Paso las pruebas.' },
    { kind: 'done', text: 'Listo: todo arreglado.' },
  ];
  assert.deepEqual(fresh(lines, [], 5).map((l) => l.kind), ['plan', 'tests', 'done']);
  assert.deepEqual(fresh(lines, [], 1).map((l) => l.kind), ['plan', 'done']); // al terminar, el «Listo» y como mucho un aviso
  assert.deepEqual(fresh(lines.slice(0, 2), [], 1).map((l) => l.kind), ['plan']);
  assert.deepEqual(fresh([{ kind: 'done', text: 'Listo: todo arreglado.' }], ['Listo: todo arreglado.'], 1).length, 1); // el final, siempre
});

test('de un cambio, Haiku sabe qué cambia (sin claves) y de un archivo nuevo, cuántas líneas tiene', (t) => {
  const dir = tempDir(t);
  const ctx = { folder: dir, cwd: dir };
  assert.equal(describe('Edit', { file: path.join(dir, 'calc.js'), old: 'const IVA = 0.12;', new: 'const IVA = 0.21;' }, ctx).info,
    'Cambia el archivo calc.js: cambia «const IVA = 0.12;» por «const IVA = 0.21;»');
  assert.doesNotMatch(describe('Edit', { file: 'c.js', old: 'password=viejaClave1', new: 'password=nuevaClave2' }, ctx).info, /Clave/);
  assert.match(describe('Edit', { file: 'c.js', old: '', new: 'function nueva() {}' }, ctx).info, /añade «function nueva\(\) \{\}»/);
  assert.match(describe('Write', { file: path.join(dir, 'nuevo.js'), lines: 40 }, ctx).info, /Crea el archivo nuevo nuevo\.js \(40 líneas\)/);
  assert.equal(describe('MultiEdit', { file: 'c.js', edits: 3 }, ctx).info, 'Cambia 3 partes del archivo c.js');
  const n = narration('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'c.js', old_string: 'a', new_string: 'b' } });
  assert.deepEqual(n.input, { file: 'c.js', old: 'a', new: 'b' });
  assert.equal(narration('PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'c.js', content: 'a\nb\nc' } }).input.lines, 3);
});

test('la respuesta final que llega tarde al registro y el informe de un agente que ya terminó no se repiten', async (t) => {
  const { dir, asked, ev } = setup(t);
  const conv = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(conv, '');
  const add = (content) => fs.appendFileSync(conv, `${JSON.stringify({ type: 'assistant', message: { content } })}\n`);
  ev('UserPromptSubmit', { request: 'Revisa', narr: { transcript: conv } });
  ev('PreToolUse', { toolName: 'Agent', toolUseId: 'ag', narr: { input: { agent: 'Explore', task: 'Buscar' }, transcript: conv } });
  ev('SubagentStart', { narr: { agentId: 'a1', agentType: 'Explore' } });
  ev('Stop', { narr: { transcript: conv, last: 'Las pruebas pasan; el agente sigue buscando.' } });
  await waitFor(() => asked.length >= 1);
  ev('SubagentStop', { narr: { agentId: 'a1', agentType: 'Explore', last: 'El IVA está en calc.js' } });
  // El informe del agente llega como un mensaje, y la respuesta final de antes, ahora al registro.
  ev('UserPromptSubmit', { request: '<agent-message from="a1">El IVA está en calc.js</agent-message>', narr: { transcript: conv } });
  add([{ type: 'text', text: 'Las pruebas pasan; el agente sigue buscando.' }]);
  add([{ type: 'text', text: 'El agente confirma que el IVA está en calc.js.' }]);
  ev('Stop', { narr: { transcript: conv, last: 'El agente confirma que el IVA está en calc.js.' } });
  await waitFor(() => asked.length >= 2);
  await wait(80);
  const later = asked.slice(1).join('\n');
  assert.doesNotMatch(later, /Claude escribe: «Las pruebas pasan/);
  assert.doesNotMatch(later, /Le llega el informe/);
  assert.match(later, /El agente «Explore» termina y le cuenta a Claude: «El IVA está en calc\.js»/);
});

// Revisión de Codex de la 0.24.0.
test('lo que se le pasa a Haiku va sin claves, también en la petición, los textos de Claude y los errores', async (t) => {
  const key = `${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
  const { asked, ev } = setup(t);
  ev('UserPromptSubmit', { request: `Sube el código con el token ${key}` });
  ev('PreToolUse', { toolName: 'Bash', toolUseId: 'b', narr: { input: { command: 'git push' } } });
  ev('PostToolUseFailure', { toolName: 'Bash', toolUseId: 'b', narr: { error: `Exit code 1\nfatal: https://x:${key}@github.com denied; password=Sup3rS3creta` } });
  await waitFor(() => asked.length === 1);
  assert.ok(!asked[0].includes(key));
  assert.doesNotMatch(asked[0], /Sup3rS3creta/);
  assert.match(asked[0], /Sube el código con el token \*\*\*\*/);
});

test('una tarea nueva no se mezcla con lo que quedaba de la anterior', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { asked, ev } = setup(t, { reply: async (input, n) => { if (n === 1) await gate; return answer([{ tipo: 'otro', texto: SAID[n - 1] }]); } });
  ev('UserPromptSubmit', { request: 'Primera tarea' });
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'a', narr: { input: { file: 'a.js' } } });
  await waitFor(() => asked.length === 1); // Haiku tarda en contestar…
  ev('Stop', { narr: { last: 'Primera hecha.' } });
  ev('UserPromptSubmit', { request: 'Segunda tarea' }); // … y mientras, el usuario sigue
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'b', narr: { input: { file: 'b.js' } } });
  release();
  await waitFor(() => asked.length === 3);
  assert.match(asked[1], /«Primera tarea»[\s\S]*Termina la tarea y le responde al usuario: «Primera hecha\.»/);
  assert.doesNotMatch(asked[1], /b\.js/);
  assert.match(asked[2], /«Segunda tarea»[\s\S]*Lee el archivo b\.js/);
  assert.doesNotMatch(asked[2], /Termina la tarea/);
});

test('si Codex revisa y no encuentra nada, la tarea termina; si encuentra algo, Claude sigue', async (t) => {
  const { narrator, asked, last, ev } = setup(t);
  ev('UserPromptSubmit', { request: 'Cambia algo' });
  ev('Stop', { reviewing: true, narr: { last: 'He cambiado a.js.' } });
  assert.equal(last().now.text, 'Codex revisa los cambios');
  narrator.review('t1', { state: 'running' });
  assert.equal(last().now.text, 'Codex revisa los cambios');
  narrator.review('t1', { state: 'found', count: 2 });
  assert.equal(last().now.text, 'Pensando…');
  ev('Stop', { reviewing: false, narr: { last: 'Corregido lo que vio Codex.' } });
  assert.equal(last().now, null);
  // Otra vez, ahora sin nada que corregir: la parada que esperaba es la final.
  ev('UserPromptSubmit', { request: 'Otra cosa' });
  ev('Stop', { reviewing: true, narr: { last: 'Hecho lo otro.' } });
  narrator.review('t1', { state: 'clean', seconds: 20 });
  assert.equal(last().now, null);
  await waitFor(() => asked.some((q) => /responde al usuario: «Hecho lo otro\.»/.test(q)));
});

test('si el proceso de Claude termina a medias, deja de contar que trabaja; desactivar la actividad corta lo que preguntaba', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { narrator, asked, last, ev } = setup(t, { reply: async () => { await gate; return answer([{ tipo: 'leer', texto: 'Respuesta que llega tarde' }]); } });
  ev('UserPromptSubmit', { request: 'Algo' });
  ev('PreToolUse', { toolName: 'Read', toolUseId: 'a', narr: { input: { file: 'a.js' } } });
  assert.equal(last().now.text, 'Leyendo a.js');
  narrator.exited('t1');
  assert.equal(last().now, null);
  await waitFor(() => asked.length === 1);
  narrator.setEnabled(false);
  release();
  await wait(80);
  assert.ok(!last().entries.some((e) => /llega tarde/.test(e.text)));
  assert.deepEqual(last().entries.slice(-1).map((e) => [e.text, e.pending]), [['Leyendo a.js', false]]);
});

test('un mensaje del usuario que empieza por una etiqueta sigue siendo suyo; los nombres de archivo no pierden caracteres', (t) => {
  const { last, ev } = setup(t);
  ev('UserPromptSubmit', { request: '<div>Arregla este HTML</div>' });
  assert.deepEqual(last().entries.map((e) => e.src), ['user']);
  assert.deepEqual(parseLines(answer([{ tipo: 'leer', texto: 'Leo **test_activity.js** y el código `C#`.' }]).stdout).map((l) => l.text), ['Leo test_activity.js y el código C#.']);
  const { similar } = require('../src/main/narrator');
  assert.ok(!similar('Las pruebas pasan', 'Las pruebas no pasan'));
  assert.ok(!similar('Las pruebas de calc.js pasan', 'Las pruebas de calc.js fallan'));
});
