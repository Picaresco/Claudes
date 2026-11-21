const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createContext, docxToText, readRule, parseTitle } = require('../src/main/context');
const { tempDir, makeZip } = require('./helpers');

test('readRule escribe las rutas de Windows como las compara Claude Code', () => {
  assert.equal(readRule('C:\\Docs\\x.pdf', false), 'Read(//c/Docs/x.pdf)');
  assert.equal(readRule('D:\\Proyectos\\web\\', true), 'Read(//d/Proyectos/web/**)');
  assert.equal(readRule('C:\\Docs\\informe[1].pdf', false), null); // con comodines no se puede expresar
  assert.equal(readRule('\\\\servidor\\compartida\\x.pdf', false), null); // sin letra de unidad
});

test('parseTitle saca el título de la página', () => {
  assert.equal(parseTitle('<html><head><title> Hola &amp; adiós </title></head></html>'), 'Hola & adiós');
  assert.equal(parseTitle('<meta property="og:title" content="Título OG"><title>Otro</title>'), 'Título OG');
  assert.equal(parseTitle('<title>Caf&#233; &#x1F512;</title>'), 'Café 🔒');
  assert.equal(parseTitle('<p>sin título</p>'), null);
});

test('docxToText pasa un Word a texto', (t) => {
  const dir = tempDir(t);
  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Primer párrafo</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Uno</w:t><w:tab/><w:t>dos &amp; tres</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>';
  const file = path.join(dir, 'doc.docx');
  fs.writeFileSync(file, makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }));
  assert.equal(docxToText(file), 'Primer párrafo\nUno\tdos & tres\nA | B');
  fs.writeFileSync(path.join(dir, 'no.docx'), makeZip({ 'otro.txt': 'x' }));
  assert.throws(() => docxToText(path.join(dir, 'no.docx')), /no parece un documento de Word/);
});

function makeContext(t) {
  const userData = tempDir(t);
  const logs = [];
  const ctx = createContext({ app: { getPath: () => userData }, net: null, log: (text) => logs.push(text) });
  return { ctx, userData, logs };
}

test('prepare escribe el resumen y da los permisos de lectura', async (t) => {
  const { ctx } = makeContext(t);
  const docs = tempDir(t);
  const file = path.join(docs, 'notas.txt');
  fs.writeFileSync(file, 'hola');
  fs.mkdirSync(path.join(docs, 'carpeta'));
  fs.writeFileSync(path.join(docs, 'carpeta', 'a.md'), 'a');
  const context = {
    note: 'Usa siempre euros.',
    items: [
      { path: file },
      { path: path.join(docs, 'carpeta') },
      { path: path.join(docs, 'no-existe.pdf') },
      { path: path.join(docs, 'apagado.txt'), enabled: false },
      { url: 'https://example.com/guia', title: 'Guía' },
    ],
  };
  const out = await ctx.prepare('t1', 'Proyecto', context);
  assert.ok(out.promptFile && fs.existsSync(out.promptFile));
  const text = fs.readFileSync(out.promptFile, 'utf8');
  assert.match(text, /# Contexto del proyecto «Proyecto»/);
  assert.match(text, /Usa siempre euros\./);
  assert.ok(text.includes(`${file} — texto`));
  assert.match(text, /carpeta con 1 archivo/);
  assert.ok(!text.includes('no-existe.pdf'));
  assert.match(text, /https:\/\/example\.com\/guia — «Guía»/);
  assert.ok(out.allow.includes('WebFetch(domain:example.com)'));
  assert.equal(out.allow.filter((r) => r.startsWith('Read(')).length, process.platform === 'win32' ? 2 : 0);
});

test('sin contexto no hay archivo; un cambio se entrega una sola vez', async (t) => {
  const { ctx } = makeContext(t);
  const empty = await ctx.prepare('t1', 'Proyecto', { note: '', items: [] });
  assert.equal(empty.promptFile, null);
  assert.equal(ctx.pendingUpdate('t1'), null); // nada ha cambiado
  await ctx.update('t1', 'Proyecto', { note: 'Nueva nota', items: [] });
  const first = ctx.pendingUpdate('t1');
  assert.match(first.hookSpecificOutput.additionalContext, /Nueva nota/);
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(ctx.pendingUpdate('t1'), null); // ya entregado
  await ctx.update('t1', 'Proyecto', { note: '', items: [] });
  assert.match(ctx.pendingUpdate('t1').hookSpecificOutput.additionalContext, /ha quitado el contexto/);
  assert.equal(ctx.pendingUpdate('otra'), null); // pestaña desconocida
});
