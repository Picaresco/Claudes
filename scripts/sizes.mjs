// Aviso de archivos que crecen, para npm test de este proyecto: cuando uno llega a
// 1 000 líneas conviene revisar si hay que partirlo, y otra vez cada vez que crece un
// 20 % más (1 200, 1 440, 1 728…). La escalera es la misma que usa la app para avisar a
// Claude en cualquier proyecto (src/main/growth.js).
//
// Es un aviso, no un freno: las líneas son solo un indicio. Tras revisar un archivo
// (se parta o no) se anota su tamaño y el aviso calla hasta el siguiente escalón:
//
//   npm run revisado -- src/main/main.js "por qué se deja así"
//
// Lo anotado queda en scripts/revisiones-tamano.json. Lo usa scripts/check.mjs (npm test).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const growth = require('../src/main/growth.js');
export const { nextStep, needsReview, countLines, codeLines, FIRST, GROWTH, CODE } = growth;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(root, 'scripts', 'revisiones-tamano.json');

// Lo anotado. Sin archivo, nada; si el archivo existe pero no se puede leer o está dañado
// (p. ej. tras una mezcla de cambios), falla: así nunca se sobrescribe el historial.
export function readLog(file = LOG) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`No se puede leer ${path.basename(file)}: ${err.message}`, { cause: err });
  }
  let log;
  try { log = JSON.parse(text); } catch (err) {
    throw new Error(`${path.basename(file)} está dañado (${err.message}); arréglalo antes de anotar nada`, { cause: err });
  }
  if (!log || typeof log !== 'object' || Array.isArray(log)) {
    throw new Error(`${path.basename(file)} está dañado (no es una lista de archivos); arréglalo antes de anotar nada`);
  }
  return log;
}

// Archivos que tocan revisión: [{ file, lines, reviewed, step }]. `files` son rutas relativas a `base`.
export function pending(files, { base = root, log = readLog() } = {}) {
  const out = [];
  for (const file of files) {
    let lines;
    try { lines = codeLines(file, fs.readFileSync(path.join(base, file), 'utf8')); } catch { continue; } // p. ej. un cuaderno dañado: no se puede contar
    const reviewed = (log[file] && log[file].lineas) || 0;
    if (needsReview(lines, reviewed)) out.push({ file, lines, reviewed, step: nextStep(reviewed) });
  }
  return out;
}

// Anota que un archivo se ha revisado con su tamaño de ahora.
export function markReviewed(file, note = '', { base = root, logFile = LOG } = {}) {
  const rel = path.relative(base, path.resolve(base, file)).split(path.sep).join('/');
  const lines = codeLines(rel, fs.readFileSync(path.join(base, rel), 'utf8'));
  const log = readLog(logFile);
  log[rel] = { lineas: lines, fecha: new Date().toISOString().slice(0, 10), ...(note ? { nota: note } : {}) };
  const sorted = Object.fromEntries(Object.keys(log).sort().map((key) => [key, log[key]]));
  fs.writeFileSync(logFile, `${JSON.stringify(sorted, null, 2)}\n`);
  return { file: rel, lines, next: nextStep(lines) };
}

// npm run revisado -- <archivo> ["nota"]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...note] = process.argv.slice(2);
  if (!file) {
    console.error('Uso: npm run revisado -- <archivo> ["por qué se deja así"]');
    process.exit(1);
  }
  try {
    const done = markReviewed(file, note.join(' '));
    console.log(`Anotado: ${done.file} revisado con ${done.lines} líneas. Volverá a avisar al llegar a ${done.next}.`);
  } catch (err) {
    console.error(`No he podido anotar ${file}: ${err.message}`);
    process.exit(1);
  }
}
