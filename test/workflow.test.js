// Botón «Workflow»: qué se envía al modelo, cómo se comprueba lo que devuelve, cuándo se
// rehace el mapa y dónde va cada cosa al dibujarlo.
process.env.CLAUDES_WORKFLOW_EVERY_MS = '60'; // el ciclo de 5 minutos, en milisegundos para las pruebas
process.env.CLAUDES_WORKFLOW_ENTER_MS = '150'; // y los 30 s entre entradas en un proyecto
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempDir } = require('./helpers');
const digest = require('../src/main/workflow-digest');
const { createWorkflow, validate, fullPrompt, refreshPrompt, GUIDE } = require('../src/main/workflow');

const loadLayout = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'workflow-layout.js')).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(10); }
  return false;
}
// Las claves de prueba se montan al ejecutar: así este archivo no dispara el aviso de claves.
const fakeKey = () => `sk-ant-${'Ab3'.repeat(12)}`;

function project(t) {
  const dir = tempDir(t);
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('package.json', '{"name":"tienda","main":"src/index.js"}\n');
  w('README.md', '# Tienda\nVende pan.\n');
  w('src/index.js', "const http = require('http');\nconst db = require('./db');\nhttp.createServer(handler).listen(8080);\nfunction handler(req, res) { db.save(req); }\n");
  w('src/db.js', `const password = "${'Pw9'.repeat(4)}Zq";\nmodule.exports = { save() {} };\n`);
  w('.env', `ANTHROPIC_KEY=${fakeKey()}\n`);
  w('logo.png', 'PNG');
  w('node_modules/x/index.js', 'module.exports = 1;\n');
  return dir;
}

const MAP = {
  resumen: 'Una tienda que guarda pedidos',
  bloques: [
    { id: 'cliente', nombre: 'Cliente', tipo: 'persona', resumen: 'Hace pedidos' },
    { id: 'api', nombre: 'Servidor', tipo: 'nucleo', resumen: 'Recibe y guarda pedidos' },
    { id: 'bd', nombre: 'Base de datos', tipo: 'datos', resumen: 'Pedidos guardados' },
    { id: 'pago', nombre: 'Pasarela', tipo: 'externo', resumen: 'Cobra' },
  ],
  modulos: [
    { id: 'http', bloque: 'api', nombre: 'Servidor HTTP', sub: 'src/index.js', detalle: ['Escucha en el puerto 8080'], archivos: ['src/index.js'], reglas: [{ texto: 'Solo pedidos válidos', fuente: 'src/index.js' }], bucles: [{ texto: 'Inventado', fuente: 'no/existe.js' }] },
    { id: 'guarda', bloque: 'api', nombre: 'Guardado', sub: 'src/db.js', detalle: [], archivos: ['src/db.js'] },
    { id: 'huerfano', bloque: 'nada', nombre: 'Sin bloque' },
  ],
  flechas: [
    { de: 'cliente', a: 'api', tipo: 'datos', texto: 'pide' },
    { de: 'api', a: 'bd', tipo: 'datos', texto: 'guarda', doble: true },
    { de: 'api', a: 'pago', tipo: 'regla', texto: '✕ con token' },
    { de: 'api', a: 'fantasma', tipo: 'datos', texto: 'rota' },
  ],
  internas: [{ de: 'http', a: 'guarda', tipo: 'datos' }],
  reglas: [{ bloque: 'api', texto: 'Solo desde la red local', fuente: 'src/index.js' }],
};

test('la guía del Workflow (SKILL.md) está completa y los dos motores la reciben entera', () => {
  assert.equal(GUIDE.name, 'workflow-de-proyecto');
  assert.match(GUIDE.version, /^\d+$/);
  assert.equal(GUIDE.number, Number(GUIDE.version));
  for (const part of ['## Método', '## Cómo escribir', '## Formato', '## Ejemplo', '"flechas"', 'persona | interfaz | nucleo | proceso | datos | externo']) assert.ok(GUIDE.body.includes(part), `falta «${part}»`);
  // El ejemplo de la guía es un mapa válido: lo que se pide se puede dibujar.
  const example = JSON.parse(/## Ejemplo[\s\S]*?```\n([\s\S]*?)\n```/.exec(GUIDE.body)[1]);
  const map = validate(example);
  assert.equal(map.bloques.length, 5);
  assert.equal(map.flechas.length, 4);
  assert.deepEqual(map.stack.map((s) => s.nombre), ['Python', 'FastAPI', 'PostgreSQL', 'Vue', 'Docker Compose']);
  assert.equal(map.stack[0].version, '3.12');
  const full = fullPrompt({ name: 'tienda', text: 'MATERIAL', partial: false });
  const again = refreshPrompt({ name: 'tienda', text: 'CAMBIOS', map, changes: { added: [], modified: ['a.js'], removed: [] } });
  for (const prompt of [full, again]) assert.ok(prompt.includes(GUIDE.body));
  assert.ok(full.endsWith('MATERIAL') && again.endsWith('CAMBIOS'));
});

test('lo que se envía: sin .env, binarios ni node_modules, y lo que parece una clave sale tapado', async (t) => {
  const dir = project(t);
  const { files } = await digest.listFiles(dir);
  const rels = files.map((f) => f.rel);
  assert.ok(rels.includes('src/index.js') && rels.includes('package.json'));
  assert.ok(!rels.includes('.env') && !rels.includes('logo.png') && !rels.some((r) => r.startsWith('node_modules/')));
  assert.equal(rels[0], 'package.json'); // los manifiestos, primero
  const shown = await digest.material(dir);
  assert.match(shown.text, /createServer/);
  assert.ok(!shown.text.includes('Pw9Pw9Pw9Pw9Zq'), 'la contraseña no sale');
  assert.ok(!shown.text.includes(fakeKey()));
  assert.ok(shown.masked >= 1);
  assert.deepEqual(new Set(shown.used), new Set(['package.json', 'README.md', 'src/index.js', 'src/db.js']));
});

test('la huella dice qué archivos han cambiado, sin releer los que no', async (t) => {
  const dir = project(t);
  const first = await digest.fingerprint(dir);
  const again = await digest.fingerprint(dir, first.manifest);
  assert.equal(digest.diff(first.manifest, again.manifest).count, 0);
  assert.equal(again.manifest['src/index.js'], first.manifest['src/index.js']); // el mismo objeto: no se ha releído
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'cambiado\n');
  fs.writeFileSync(path.join(dir, 'src', 'nuevo.js'), 'nuevo\n');
  fs.rmSync(path.join(dir, 'README.md'));
  const changes = digest.diff(first.manifest, (await digest.fingerprint(dir, first.manifest)).manifest);
  assert.deepEqual(changes.modified, ['src/index.js']);
  assert.deepEqual(changes.added, ['src/nuevo.js']);
  assert.deepEqual(changes.removed, ['README.md']);
});

test('lo que devuelve el modelo se comprueba: referencias rotas fuera y reglas solo con su archivo', () => {
  const map = validate(MAP, new Set(['src/index.js', 'src/db.js', 'package.json']));
  assert.deepEqual(map.bloques.map((b) => b.id), ['cliente', 'api', 'bd', 'pago']);
  assert.deepEqual(map.modulos.map((m) => m.id), ['http', 'guarda']); // sin el que no tiene bloque
  assert.equal(map.flechas.length, 3); // sin la que va a un bloque que no existe
  assert.deepEqual(map.modulos[0].reglas, ['Solo pedidos válidos']);
  assert.deepEqual(map.modulos[0].bucles, []); // cita un archivo que no se le enseñó
  assert.equal(map.reglas.length, 1);
  // La vuelta de una flecha se junta con la ida: una sola, de doble sentido.
  const both = validate({ ...MAP, flechas: [{ de: 'cliente', a: 'api', tipo: 'datos', texto: 'pide' }, { de: 'api', a: 'cliente', tipo: 'datos', texto: 'responde' }] });
  assert.deepEqual(both.flechas, [{ de: 'cliente', a: 'api', tipo: 'datos', texto: 'pide', doble: true }]);
  assert.equal(validate({ bloques: [{ id: 'a', tipo: 'nucleo' }] }), null); // con un solo bloque no hay mapa
  assert.equal(validate(null), null);
  const secret = validate({ ...MAP, resumen: `usa ${fakeKey()}` });
  assert.ok(!secret.resumen.includes(fakeKey()));
  const long = validate({ ...MAP, resumen: 'palabra '.repeat(60) });
  assert.ok(long.resumen.length <= 160);
});

test('el mapa se dibuja sin bloques montados y con cada flecha y tarjeta en su sitio', async () => {
  const { layoutMap, wrap } = await loadLayout();
  const big = {
    ...MAP,
    bloques: [...MAP.bloques, { id: 'web', nombre: 'Web', tipo: 'interfaz', resumen: 'La tienda' }, { id: 'cola', nombre: 'Cola', tipo: 'proceso', resumen: 'Tareas' }, { id: 'mail', nombre: 'Correo', tipo: 'externo', resumen: 'Envía' }],
    modulos: [...MAP.modulos.slice(0, 2), ...[1, 2, 3, 4, 5].map((n) => ({ id: `w${n}`, bloque: 'web', nombre: `Pantalla ${n}`, sub: 'web' }))],
    flechas: [...MAP.flechas.slice(0, 3), { de: 'cliente', a: 'bd', tipo: 'datos', texto: 'lejos' }, { de: 'cola', a: 'bd', tipo: 'bucle', texto: '↻ cada 5 min' }, { de: 'web', a: 'mail', tipo: 'datos', texto: 'avisa' }, { de: 'cliente', a: 'web', tipo: 'datos', texto: 'usa' }],
  };
  const L = layoutMap(validate(big));
  const boxes = [...L.blocks, ...L.ext];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `«${a.id}» y «${b.id}» se montan`);
    }
  }
  for (const c of L.cards) {
    const b = L.blocks.find((x) => x.id === c.bloque);
    assert.ok(c.x >= b.x && c.y >= b.y && c.x + c.w <= b.x + b.w && c.y + c.h <= b.y + b.h, `la tarjeta «${c.id}» se sale de su bloque`);
  }
  assert.equal(L.blocks.find((b) => b.id === 'web').cols, 2); // cinco piezas: dos columnas
  assert.equal(L.arrows.length, 7);
  for (const a of L.arrows) {
    assert.match(a.d, /^M[\d.-]+ [\d.-]+/);
    assert.ok(a.at[0] >= 0 && a.at[0] <= L.W && a.at[1] >= 0 && a.at[1] <= L.H, `la etiqueta «${a.text}» se sale del lienzo`);
  }
  for (const e of L.ext) assert.ok(e.y + e.h < L.band, 'los servicios de internet van en su banda');
  assert.deepEqual(wrap('una frase bastante larga que no cabe en un renglón', 14, 2), ['una frase', 'bastante larga…']);
});

test('el mapa se hace al abrir, se guarda, y solo se rehace si el proyecto cambia con la ventana abierta', async (t) => {
  const dir = project(t);
  const data = tempDir(t);
  const asked = [];
  const sent = [];
  const codex = {
    chatgptLogin: async () => true,
    askCodex: async ({ prompt, effort }) => { asked.push({ prompt, effort }); return { ok: true, text: JSON.stringify(MAP) }; },
  };
  const make = (extra = {}) => createWorkflow({
    codexState: { usable: () => true }, codex, model: 'modelo', findClaude: () => null,
    workDir: () => path.join(data, 'vacia'), dir: () => path.join(data, 'mapas'), send: (ch, snap) => sent.push(snap), ...extra,
  });
  const wf = make();
  const first = wf.open(dir, 't1');
  assert.equal(first.status, 'working');
  assert.ok(await until(() => wf.get(dir).status === 'ready'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].effort, 'medium');
  assert.match(asked[0].prompt, /Dibuja el mapa/);
  assert.ok(!asked[0].prompt.includes(fakeKey()));
  assert.equal(wf.get(dir).map.bloques.length, 4);
  assert.ok(fs.readdirSync(path.join(data, 'mapas')).some((f) => f.endsWith('.json')));
  // Sin cambios, los ciclos no preguntan nada.
  await wait(200);
  assert.equal(asked.length, 1);
  // Un cambio: se rehace con razonamiento bajo y con el mapa actual.
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), "const cola = require('./cola');\n");
  assert.ok(await until(() => asked.length === 2));
  assert.equal(asked[1].effort, 'low');
  assert.match(asked[1].prompt, /Este es el mapa actual/);
  assert.match(asked[1].prompt, /src\/index\.js/);
  // Cerrada la ventana, no se rehace aunque cambie.
  wf.close(dir);
  fs.writeFileSync(path.join(dir, 'src', 'db.js'), 'otro\n');
  await wait(250);
  assert.equal(asked.length, 2);
  wf.stop();
  // Otra vez la app: el mapa guardado se enseña al momento.
  const again = make();
  const snap = again.open(dir, 't1');
  assert.equal(snap.status, 'ready');
  assert.equal(snap.map.bloques.length, 4);
  again.stop();
  // Un mapa hecho con una versión anterior de la guía (p. ej. sin stack) se completa al entrar,
  // con el modelo rápido y sin rehacerlo desde cero. Retocar el texto de la guía no cuenta: solo
  // el número de versión.
  const file = fs.readdirSync(path.join(data, 'mapas')).find((f) => f.endsWith('.json'));
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'mapas', file), 'utf8'));
  assert.equal(saved.guideVersion, GUIDE.number);
  fs.writeFileSync(path.join(data, 'mapas', file), JSON.stringify({ ...saved, guideVersion: 1 }));
  const before = asked.length;
  const third = make();
  third.enter(dir, 't1');
  assert.ok(await until(() => asked.length === before + 1));
  assert.equal(asked[before].effort, 'low');
  assert.match(asked[before].prompt, /Se hizo con la versión 1 de la guía/);
  assert.match(asked[before].prompt, /=== package\.json ===/); // los manifiestos, para sacar el stack
  assert.ok(await until(() => third.get(dir).status === 'ready' && !third.get(dir).oldGuide));
  third.stop();
});

test('al actualizar se conservan las reglas y bucles ya comprobados; uno nuevo sin archivo, no', () => {
  const prev = validate(MAP, new Set(['src/index.js']));
  assert.deepEqual(prev.modulos[0].reglas, ['Solo pedidos válidos']);
  const echoed = { ...MAP, modulos: [{ ...MAP.modulos[0], reglas: ['Solo pedidos válidos', 'Inventada sin archivo'] }] };
  const again = validate(echoed, new Set(['src/db.js']), prev);
  assert.deepEqual(again.modulos[0].reglas, ['Solo pedidos válidos']);
});

test('al entrar en un proyecto el mapa se prepara solo, de uno en uno y como mucho una vez cada poco', async (t) => {
  const one = project(t);
  const two = project(t);
  const data = tempDir(t);
  const asked = [];
  let running = 0;
  let most = 0;
  const codex = {
    chatgptLogin: async () => true,
    askCodex: async ({ effort }) => {
      running += 1;
      most = Math.max(most, running);
      asked.push(effort);
      await wait(80);
      running -= 1;
      return { ok: true, text: JSON.stringify({ ...MAP, stack: [{ nombre: 'Node.js', version: '22', para: 'el servidor' }] }) };
    },
  };
  const wf = createWorkflow({ codexState: { usable: () => true }, codex, model: 'm', findClaude: () => null, workDir: () => path.join(data, 'v'), dir: () => path.join(data, 'mapas') });
  t.after(() => wf.stop());
  wf.enter(one, 't1');
  wf.enter(two, 't2'); // otro proyecto: espera su turno
  wf.enter(one, 't1'); // otra vez enseguida: no cuenta
  assert.ok(await until(() => wf.get(one)?.status === 'ready' && wf.get(two)?.status === 'ready'));
  assert.deepEqual(asked, ['medium', 'medium']);
  assert.equal(most, 1, 'nunca dos mapas a la vez');
  assert.deepEqual(wf.get(one).map.stack, [{ nombre: 'Node.js', version: '22', para: 'el servidor' }]);
  assert.equal(wf.get(one).next, 0, 'sin la ventana abierta no se programa la revisión de 5 minutos');
  // Al volver a entrar, pasado el plazo y con cambios, se actualiza.
  fs.writeFileSync(path.join(one, 'src', 'index.js'), 'cambio\n');
  await wait(170);
  wf.enter(one, 't1');
  assert.ok(await until(() => asked.length === 3));
  assert.equal(asked[2], 'low');
});

test('sin Codex y con el plan al 80 %, al entrar no se dibuja el primer mapa; al pulsar «Workflow» sí', async (t) => {
  const dir = project(t);
  const data = tempDir(t);
  const wf = createWorkflow({ codexState: { usable: () => false }, codex: {}, model: 'm', findClaude: () => null, workDir: () => path.join(data, 'v'), dir: () => path.join(data, 'mapas'), planBusy: () => true });
  t.after(() => wf.stop());
  wf.enter(dir, 't1');
  assert.ok(await until(() => wf.get(dir)?.paused));
  assert.equal(wf.get(dir).status, 'idle');
  wf.open(dir, 't1'); // el usuario lo pide: se intenta (aquí sin Claude Code, así que falla)
  assert.ok(await until(() => wf.get(dir).status === 'error'));
  assert.match(wf.get(dir).error, /Claude Code/);
});

test('sin Codex y con el plan de Claude al 80 %, el mapa no se rehace solo', async (t) => {
  const dir = project(t);
  const data = tempDir(t);
  const codex = { chatgptLogin: async () => true, askCodex: async () => ({ ok: true, text: JSON.stringify(MAP) }) };
  const opts = { codex, model: 'm', findClaude: () => null, workDir: () => path.join(data, 'v'), dir: () => path.join(data, 'mapas') };
  const withCodex = createWorkflow({ ...opts, codexState: { usable: () => true } });
  withCodex.open(dir, 't1');
  assert.ok(await until(() => withCodex.get(dir).status === 'ready'));
  withCodex.stop();
  const noCodex = createWorkflow({ ...opts, codexState: { usable: () => false }, planBusy: () => true });
  noCodex.open(dir, 't1');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'cambio\n');
  assert.ok(await until(() => noCodex.get(dir).paused));
  assert.equal(noCodex.get(dir).status, 'ready'); // conserva el mapa anterior, sin errores
  assert.ok(noCodex.get(dir).pending >= 1);
  noCodex.stop();
});
