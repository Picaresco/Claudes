// Revisión rápida del código, sin arrancar la app (npm run check):
//  1. Sintaxis de todos los .js y .mjs de src/ y scripts/.
//  2. Cada #id que usa la interfaz existe en index.html.
//  3. Cada api.x() que usa la interfaz existe en preload.js.
//  4. Cada canal de preload.js tiene quien lo atienda (o lo envíe) en el proceso principal.
//  5. La versión de package.json tiene su sección en CHANGELOG.md.
//  6. Lo que cada módulo de la interfaz importa existe y está exportado.
//  7. Aviso (no fallo) de los archivos que llegan a 1 000 líneas o crecen un 20 % más
//     desde su última revisión (scripts/sizes.mjs).
// Lo demás (nombres sin definir, imports sin usar…) lo revisa ESLint: npm run lint.
// Un fallo de sintaxis en la interfaz deja la ventana en blanco: esto lo caza antes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pending } from './sizes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const problems = [];
const fail = (text) => problems.push(text);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// 1. Sintaxis
const files = [...walk('src'), ...walk('scripts'), ...(fs.existsSync(path.join(root, 'test')) ? walk('test') : [])];
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (res.status !== 0) fail(`Sintaxis: ${file}\n${String(res.stderr).split('\n').slice(0, 5).join('\n')}`);
}

// 2. Los #id de la interfaz
const html = read('src/renderer/index.html');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const uiFiles = walk('src/renderer');
for (const file of uiFiles) {
  const code = read(file);
  const used = new Set([
    ...[...code.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]),
    ...[...code.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
  ]);
  for (const id of used) if (!htmlIds.has(id)) fail(`${file} usa #${id}, que no está en index.html`);
}

// 3. Las funciones del puente
const preload = read('src/preload/preload.js');
const bridge = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
for (const file of uiFiles) {
  for (const name of new Set([...read(file).matchAll(/\bapi\.(\w+)\b/g)].map((m) => m[1]))) {
    if (!bridge.has(name)) fail(`${file} llama a api.${name}, que no está en preload.js`);
  }
}

// 4. Los canales del puente
const mainCode = walk('src/main').map(read).join('\n');
for (const [, kind, channel] of preload.matchAll(/(invoke|send|on)\('([\w:-]+)'/g)) {
  const wanted = kind === 'invoke' ? `ipcMain.handle('${channel}'` : kind === 'send' ? `ipcMain.on('${channel}'` : `send('${channel}'`;
  if (!mainCode.includes(wanted)) fail(`preload.js usa el canal «${channel}» (${kind}) y el proceso principal no tiene ${wanted}…)`);
}

// 5. La versión y su sección del CHANGELOG
const { version } = JSON.parse(read('package.json'));
if (!new RegExp(`^## ${version.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}$`, 'm').test(read('CHANGELOG.md'))) {
  fail(`CHANGELOG.md no tiene la sección «## ${version} — AAAA-MM-DD»`);
}

// 6. Los módulos de la interfaz (renderer.js y ui/*.js)
// El navegador no carga nada si un import pide algo que el otro módulo no exporta, y
// eso ESLint no lo mira. Que no se use nada sin importarlo sí lo comprueba ESLint.
const words = (text) => text.match(/[A-Za-z_$][\w$]*/g) || [];
const modules = new Map(); // archivo → { exported, imported }
for (const file of uiFiles.filter((f) => /^src\/renderer\/(renderer\.js$|ui\/)/.test(f))) {
  const raw = read(file);
  const exported = new Set([...raw.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const imported = [...raw.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)]
    .map((m) => ({ names: words(m[1]), from: path.posix.join(path.posix.dirname(file), m[2]) }));
  modules.set(file, { exported, imported });
}
for (const [file, m] of modules) {
  for (const imp of m.imported) {
    const source = modules.get(imp.from);
    if (!source) { fail(`${file} importa de ${imp.from}, que no existe`); continue; }
    for (const name of imp.names) {
      if (!source.exported.has(name)) fail(`${file} importa «${name}» de ${imp.from}, que no lo exporta`);
    }
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  console.error(`\n${problems.length === 1 ? '1 problema' : `${problems.length} problemas`}.`);
  process.exit(1);
}
console.log(`✓ Revisión correcta: ${files.length} archivos, ${htmlIds.size} elementos de la interfaz, ${bridge.size} funciones del puente, ${modules.size} módulos de la interfaz, versión ${version}.`);

// 7. Archivos que han crecido (aviso, no fallo): a las 1 000 líneas y cada 20 % más.
const grown = pending([...walk('src'), ...walk('scripts')]);
for (const g of grown) {
  console.log(`⚠ ${g.file} tiene ${g.lines} líneas (${g.reviewed ? `revisado con ${g.reviewed}; ` : ''}aviso a partir de ${g.step}). `
    + 'Revisa si conviene partirlo y anótalo: npm run revisado -- ' + g.file);
}
