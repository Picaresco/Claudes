// La segunda mirada de Haiku antes de recomendar «Optimiza» (src/main/optimize-check.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createChecker, material, prompt, verdict, command, ARGS } = require('../src/main/optimize-check');
const { tempDir } = require('./helpers');

test('a Haiku se le enseñan los archivos que más han cambiado, recortados y sin los que llevan claves', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.js'), 'function suma(a, b) { return a + b; }\n');
  fs.writeFileSync(path.join(dir, 'grande.js'), 'x'.repeat(50000));
  fs.writeFileSync(path.join(dir, 'config.js'), `const token = '${'ghp_'}${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}';\n`);
  fs.writeFileSync(path.join(dir, 'bin.js'), 'a\0b');
  const shown = material(dir, [
    { name: 'a.js', edits: 9, lines: 1 }, { name: 'config.js', edits: 5, lines: 1 }, { name: 'no-existe.js', edits: 4 },
    { name: 'bin.js', edits: 3 }, { name: 'grande.js', edits: 2, lines: 1 },
  ]);
  assert.deepEqual(shown.used, ['a.js', 'grande.js']);
  assert.deepEqual(shown.skipped, ['config.js']);
  assert.ok(!shown.text.includes('ghp_'));
  assert.match(shown.text, /=== a\.js \(1 líneas, 9 cambios recientes\) ===/);
  assert.match(shown.text, /\[… recortado: 38000 caracteres más\]/);
  assert.ok(shown.size <= 60000);
  const text = prompt({ signals: ['150 cambios de código'], text: shown.text });
  assert.match(text, /señales en el proyecto: 150 cambios de código\./);
  assert.match(text, /no la recomiendes aunque haya muchos cambios/);
  assert.match(text, /"recomendar": true o false/);
});

test('entiende la respuesta de Claude Code y descarta lo que no sea un veredicto claro', () => {
  const wrap = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra });
  assert.deepEqual(verdict(wrap('{"recomendar": true, "motivo": "calc.js repite\\nel IVA `x`"}')), { recommend: true, reason: 'calc.js repite el IVA x' });
  assert.deepEqual(verdict(wrap('Aquí va:\n```json\n{"recomendar": false, "motivo": "limpio"}\n```')), { recommend: false, reason: 'limpio' });
  assert.equal(verdict(wrap('{"recomendar": "sí"}')), null);
  assert.equal(verdict(wrap('no sé')), null);
  assert.equal(verdict(wrap('{"recomendar": true}', { is_error: true })), null);
  assert.equal(verdict('esto no es JSON'), null);
  assert.equal(verdict(''), null);
  assert.ok(verdict(wrap(`{"recomendar": true, "motivo": "${'x'.repeat(500)}"}`)).reason.length <= 201);
});

test('el motivo se enseña en una frase y, si es largo, recortado por una palabra entera', () => {
  const { shortReason } = require('../src/main/optimize-check');
  // El que dio Haiku en la prueba real: dos frases y largo.
  const real = 'En calc.js hay tres funciones idénticas para calcular el precio con IVA (precioConIva, precioFinal y precioTienda), además de dos sumas repetidas (suma y sumar) y una función sinUso que nunca se usa. Unificarlas dejaría el archivo más corto y claro.';
  assert.equal(shortReason(real), 'En calc.js hay tres funciones idénticas para calcular el precio con IVA (precioConIva, precioFinal y precioTienda), además de dos sumas repetidas (suma y sumar) y una función sinUso que nunca se usa.');
  const long = shortReason(`${'palabra '.repeat(40)}fin`);
  assert.ok(long.length <= 201);
  assert.match(long, /palabra…$/);
  assert.equal(shortReason('calc.js repite el IVA.'), 'calc.js repite el IVA.');
  assert.equal(shortReason('Corto. Otra frase.'), 'Corto. Otra frase.'); // la primera es demasiado corta para cortar ahí
  assert.equal(shortReason(null), '');
});

test('se lanza sin herramientas, sin servidores MCP, sin configuración y sin guardar la sesión', () => {
  for (const flag of ['-p', '--tools', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '--system-prompt']) {
    assert.ok(ARGS.includes(flag), flag);
  }
  assert.equal(ARGS[ARGS.indexOf('--model') + 1], 'haiku');
  assert.equal(ARGS[ARGS.indexOf('--tools') + 1], '');
  assert.deepEqual(command('C:\\x\\claude.exe', ['-p']), { file: 'C:\\x\\claude.exe', args: ['-p'], verbatim: false });
  // Con un .cmd va por cmd.exe, y el argumento vacío no se pierde.
  const viaCmd = command('C:\\npm\\claude.cmd', ['-p', '--tools', '', '--system-prompt', 'Hola "tú"']);
  assert.equal(viaCmd.verbatim, true);
  assert.equal(viaCmd.args[3], '"C:\\npm\\claude.cmd -p --tools "" --system-prompt "Hola ""tú"""" '.trim()); // y la comilla que cierra la línea
});

test('pregunta, y si no hay Claude, se corta o no entiende la respuesta, no decide', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  const logs = [];
  const answer = { type: 'result', is_error: false, result: '{"recomendar": true, "motivo": "a.js tiene código repetido"}' };
  let input = '';
  const checker = createChecker({
    findClaude: () => 'C:\\x\\claude.exe', workDir: () => dir, log: (x) => logs.push(x),
    run: async (cmd, text) => { input = text; return { code: 0, stdout: JSON.stringify(answer) }; },
  });
  const ok = await checker.check({ folder: dir, files: [{ name: 'a.js', edits: 3, lines: 1 }], signals: ['150 cambios'] });
  assert.deepEqual([ok.recommend, ok.reason, ok.files], [true, 'a.js tiene código repetido', ['a.js']]);
  assert.match(input, /=== a\.js/);
  assert.match(logs.join('\n'), /Haiku lo recomienda \(1 archivos/);
  // Sin Claude, sin archivos legibles, cortado o con una respuesta que no se entiende: error.
  assert.match((await createChecker({ findClaude: () => null, workDir: () => dir }).check({ folder: dir, files: [], signals: [] })).error, /no se encuentra claude/);
  assert.match((await checker.check({ folder: dir, files: [{ name: 'no-existe.js', edits: 1 }], signals: [] })).error, /no hay archivos/);
  const cut = createChecker({ findClaude: () => 'claude.exe', workDir: () => dir, log: (x) => logs.push(x), run: async () => ({ code: null, stdout: '' }) });
  assert.equal((await cut.check({ folder: dir, files: [{ name: 'a.js', edits: 1 }], signals: [] })).error, 'sin respuesta');
  assert.match(logs.join('\n'), /no ha podido decidir \(cortado o sin arrancar/);
  const odd = createChecker({ findClaude: () => 'claude.exe', workDir: () => dir, run: async () => ({ code: 0, stdout: 'hola' }) });
  assert.equal((await odd.check({ folder: dir, files: [{ name: 'a.js', edits: 1 }], signals: [] })).error, 'sin respuesta');
});

test('lanza de verdad un proceso con la pregunta por la entrada estándar y lo corta si tarda', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  // Un «claude» de mentira (node con un guion): contesta según lo que recibe por la entrada estándar.
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, "let s='';process.stdin.on('data',(d)=>{s+=d;});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({is_error:false,result:JSON.stringify({recomendar:s.includes('=== a.js'),motivo:'leído por la entrada'})}));});");
  const slow = path.join(dir, 'slow.js');
  fs.writeFileSync(slow, 'setTimeout(() => {}, 60000);');
  const logs = [];
  const make = (script, timeout) => createChecker({ findClaude: () => process.execPath, args: [script], workDir: () => path.join(dir, 'cwd'), timeout, log: (x) => logs.push(x) });
  const files = [{ name: 'a.js', edits: 1, lines: 1 }];
  const ok = await make(fake, 20000).check({ folder: dir, files, signals: ['x'] });
  assert.deepEqual([ok.recommend, ok.reason], [true, 'leído por la entrada']);
  assert.ok(fs.existsSync(path.join(dir, 'cwd'))); // se lanza en su propia carpeta
  const started = Date.now();
  const checker = make(slow, 400);
  const cut = await checker.check({ folder: dir, files, signals: ['x'] });
  assert.equal(cut.error, 'sin respuesta');
  assert.ok(Date.now() - started < 10000);
  checker.stop(); // sin nada en marcha, no pasa nada
});
