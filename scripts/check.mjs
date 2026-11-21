// Revisión rápida del código, sin arrancar la app (npm run check):
//  1. Sintaxis de todos los .js y .mjs de src/ y scripts/.
//  2. Cada #id que usa la interfaz existe en index.html.
//  3. Cada api.x() que usa la interfaz existe en preload.js.
//  4. Cada canal de preload.js tiene quien lo atienda (o lo envíe) en el proceso principal.
//  5. La versión de package.json tiene su sección en CHANGELOG.md.
// Un fallo de sintaxis en la interfaz deja la ventana en blanco: esto lo caza antes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const uiFiles = ['src/renderer/renderer.js', 'src/renderer/splash.js'];
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
const renderer = read('src/renderer/renderer.js');
for (const name of new Set([...renderer.matchAll(/\bapi\.(\w+)\b/g)].map((m) => m[1]))) {
  if (!bridge.has(name)) fail(`renderer.js llama a api.${name}, que no está en preload.js`);
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

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  console.error(`\n${problems.length === 1 ? '1 problema' : `${problems.length} problemas`}.`);
  process.exit(1);
}
console.log(`✓ Revisión correcta: ${files.length} archivos, ${htmlIds.size} elementos de la interfaz, ${bridge.size} funciones del puente, versión ${version}.`);
