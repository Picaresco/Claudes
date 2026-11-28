// Capturas de pantalla de SuperPowers (src/main/capture.js): qué se deja capturar y cargar, y el
// MCP de la app con herramientas por pestaña y resultados con imágenes (src/main/mcp.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { resolveTarget, allowRequest, widthsFrom, report, CAPTURE_TOOL } = require('../src/main/capture');
const { createMcp } = require('../src/main/mcp');
const { tempDir } = require('./helpers');

function project(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hola</h1>');
  fs.writeFileSync(path.join(dir, 'docs', 'demo.htm'), '<p>demo</p>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'x');
  return dir;
}

test('se captura una página del proyecto o de localhost, y nada más', (t) => {
  const dir = project(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'fuera.html'), '<p>fuera</p>');
  const roots = [dir];
  assert.equal(resolveTarget('index.html', roots).url, pathToFileURL(fs.realpathSync.native(path.join(dir, 'index.html'))).href);
  assert.equal(resolveTarget(path.join(dir, 'docs', 'demo.htm'), roots).label, path.join('docs', 'demo.htm'));
  assert.equal(resolveTarget('localhost:5173/citas', roots).url, 'http://localhost:5173/citas');
  assert.equal(resolveTarget('http://127.0.0.1:8080', roots).url, 'http://127.0.0.1:8080/');
  assert.equal(resolveTarget('http://[::1]:3000/', roots).url, 'http://[::1]:3000/');
  assert.throws(() => resolveTarget('https://example.com', roots), /no webs de internet/);
  assert.throws(() => resolveTarget('http://192.168.1.10:3000', roots), /no webs de internet/);
  assert.throws(() => resolveTarget('http://localhost.example.com', roots), /no webs de internet/);
  assert.throws(() => resolveTarget('ftp://localhost/x', roots), /no webs de internet/);
  assert.throws(() => resolveTarget('app.js', roots), /Solo se capturan páginas/);
  assert.throws(() => resolveTarget('no-existe.html', roots), /No encuentro/);
  assert.throws(() => resolveTarget(path.join(outside, 'fuera.html'), roots), /fuera de la carpeta/);
  assert.throws(() => resolveTarget('../' + path.basename(outside) + '/fuera.html', roots), /fuera de la carpeta|No encuentro/);
  assert.throws(() => resolveTarget('', roots), /Falta/);
  assert.throws(() => resolveTarget('index.html', []), /ya no está abierta/);
});

test('la carpeta en la que trabaja la sesión solo vale para las rutas relativas, y las rutas de red de fuera ni se abren', (t) => {
  const dir = project(t);
  // Relativa a una subcarpeta del proyecto.
  assert.equal(resolveTarget('demo.htm', [dir], path.join(dir, 'docs')).label, 'demo.htm');
  // Aunque la sesión trabaje fuera, eso no abre esa carpeta.
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'x.html'), '<p>x</p>');
  assert.throws(() => resolveTarget(path.join(outside, 'x.html'), [dir], outside), /fuera de la carpeta/);
  // Una ruta de red de fuera se rechaza sin intentar abrirla (no se queda esperando a la red).
  const started = Date.now();
  assert.throws(() => resolveTarget('\\\\servidor-que-no-existe\\carpeta\\x.html', [dir]), /fuera de la carpeta/);
  assert.equal(allowRequest('file://servidor-que-no-existe/carpeta/x.css', [dir]), false);
  assert.ok(Date.now() - started < 1000);
});

test('un enlace dentro del proyecto que apunta fuera no sirve para salirse', (t) => {
  const dir = project(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'secreto.html'), '<p>x</p>');
  try {
    fs.symlinkSync(outside, path.join(dir, 'enlace'), 'junction');
  } catch {
    t.skip('no se pueden crear enlaces en este equipo');
    return;
  }
  assert.throws(() => resolveTarget('enlace/secreto.html', [dir]), /fuera de la carpeta/);
  assert.equal(allowRequest(pathToFileURL(path.join(dir, 'enlace', 'secreto.html')).href, [dir]), false);
});

test('lo que pide la página: del proyecto y de este equipo sí; de internet, no', (t) => {
  const dir = project(t);
  const roots = [dir];
  assert.equal(allowRequest(pathToFileURL(path.join(dir, 'docs', 'estilo.css')).href, roots), true);
  assert.equal(allowRequest(pathToFileURL(path.join(dir, '..', 'otro', 'x.css')).href, roots), false);
  assert.equal(allowRequest('http://localhost:5173/@vite/client', roots), true);
  assert.equal(allowRequest('ws://localhost:5173/', roots), true);
  assert.equal(allowRequest('http://app.localhost/', roots), true);
  assert.equal(allowRequest('data:image/png;base64,AAA', roots), true);
  assert.equal(allowRequest('https://fonts.googleapis.com/css2?family=Inter', roots), false);
  assert.equal(allowRequest('http://10.0.0.5/', roots), false);
  assert.equal(allowRequest('chrome://settings', roots), false);
  assert.equal(allowRequest('no es una url', roots), false);
});

test('anchos: los de serie, o hasta 3 entre 320 y 1920 sin repetir', () => {
  assert.deepEqual(widthsFrom(undefined), [390, 1024, 1440]);
  assert.deepEqual(widthsFrom([]), [390, 1024, 1440]);
  assert.deepEqual(widthsFrom([100, 5000, 800]), [320, 1920, 800]);
  assert.deepEqual(widthsFrom([800, 800, 1024, 1280, 1440]), [800, 1024, 1280]);
  assert.deepEqual(widthsFrom(['x']), [390, 1024, 1440]);
});

test('el texto para Claude: rutas, desbordes, lo bloqueado y los errores de la consola', () => {
  const text = report({
    target: { label: 'index.html' },
    full: false,
    blocked: ['fonts.googleapis.com'],
    shots: [
      { width: 390, file: 'C:\\c\\1-390.png', overflow: 112, errors: ['Uncaught TypeError: x is undefined'] },
      { width: 1440, file: 'C:\\c\\1-1440.png', overflow: 0, errors: [] },
    ],
  });
  assert.match(text, /«index\.html» a 390, 1440 px/);
  assert.match(text, /C:\\c\\1-390\.png/);
  assert.match(text, /a 390 px .*desborde horizontal de 112 px/);
  assert.match(text, /fonts\.googleapis\.com/);
  assert.match(text, /Uncaught TypeError/);
  assert.match(text, /vuelve a capturar/);
});

test('el MCP de la app: cada pestaña ve sus herramientas y no puede llamar a las de otra', async () => {
  const other = { name: 'otra', description: '', inputSchema: { type: 'object' } };
  const mcp = createMcp({
    name: 'x', version: '1',
    tools: (tabId) => (tabId === 'con' ? [other, CAPTURE_TOOL] : [other]),
    callTool: async (_tabId, name) => (name === CAPTURE_TOOL.name ? { content: [{ type: 'text', text: 'hecho' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] } : 'texto'),
  });
  const list = async (tabId) => (await mcp(tabId, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools.map((x) => x.name);
  assert.deepEqual(await list('con'), ['otra', 'capturar_pantalla']);
  assert.deepEqual(await list('sin'), ['otra']);
  const call = (tabId, name) => mcp(tabId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { objetivo: 'index.html' } } });
  const denied = (await call('sin', 'capturar_pantalla')).json;
  assert.equal(denied.error.code, -32602);
  const shot = (await call('con', 'capturar_pantalla')).json.result;
  assert.deepEqual(shot.content.map((c) => c.type), ['text', 'image']);
  assert.equal(shot.isError, false);
  assert.deepEqual((await call('sin', 'otra')).json.result.content, [{ type: 'text', text: 'texto' }]);
});
