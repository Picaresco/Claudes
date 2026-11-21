// Prepara lo que se publica en un «release» de GitHub a partir del ejecutable ya
// generado por scripts/package.mjs (lo usa .github/workflows/ci.yml):
//
//   node scripts/release.mjs <carpeta con Claudes-win32-x64> [carpeta de salida]
//
// Deja en la carpeta de salida:
//   - ClaudHome-win32-x64.zip: la carpeta del programa, comprimida con el tar.exe de Windows;
//   - latest.json: { version, file, size, sha256 }, lo que consulta la app para actualizarse;
//   - notas.md: los cambios de esta versión, sacados de CHANGELOG.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseChangelog, PACKAGE_DIR, EXE, MANIFEST } = require('../src/main/updater.js');
const { version } = require('../package.json');

const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
const out = path.resolve(process.argv[3] || dist);
const built = path.join(dist, PACKAGE_DIR);
if (!fs.existsSync(path.join(built, EXE))) {
  console.error(`No encuentro ${path.join(built, EXE)}: genera antes el ejecutable con «npm run package».`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

// El tar.exe de Windows (bsdtar) escribe zip cuando el archivo acaba en .zip (-a).
const file = 'ClaudHome-win32-x64.zip';
const zip = path.join(out, file);
fs.rmSync(zip, { force: true });
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const res = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', dist, PACKAGE_DIR], { stdio: 'inherit' });
if (res.status !== 0) {
  console.error(`tar.exe no ha podido comprimir (código ${res.status}).`);
  process.exit(1);
}

const hash = crypto.createHash('sha256');
const fd = fs.openSync(zip, 'r');
const buffer = Buffer.alloc(4 * 1024 * 1024);
for (let n = fs.readSync(fd, buffer); n > 0; n = fs.readSync(fd, buffer)) hash.update(buffer.subarray(0, n));
fs.closeSync(fd);
const manifest = { version, file, size: fs.statSync(zip).size, sha256: hash.digest('hex') };
fs.writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

const section = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).find((v) => v.version === version);
if (!section || !section.items.length) {
  console.error(`CHANGELOG.md no tiene los cambios de la versión ${version}.`);
  process.exit(1);
}
fs.writeFileSync(path.join(out, 'notas.md'), `${section.items.map((item) => `- ${item}`).join('\n')}\n`);

console.log(`ClaudHome ${version}: ${file} (${(manifest.size / 1024 / 1024).toFixed(1)} MB, sha256 ${manifest.sha256.slice(0, 12)}…), ${MANIFEST} y notas.md en ${out}`);
