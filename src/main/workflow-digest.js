// «Workflow»: lo que se envía al modelo para dibujar el mapa de un proyecto. Lo elige la app,
// no el modelo, que nunca lee la carpeta por su cuenta:
//   - la lista de archivos (con git, la que git no deja fuera; sin git, recorriendo la carpeta
//     sin node_modules, dist, .venv…), sin enlaces, binarios, .env ni archivos de claves;
//   - los manifiestos enteros (package.json, docker-compose, Dockerfile, README…), recortados;
//   - de cada archivo de código, el principio y las líneas que dicen cómo se conecta (imports,
//     funciones, rutas, temporizadores, procesos que lanza…), hasta un tope;
//   - todo pasa por maskSecrets: lo que tenga pinta de clave sale tapado.
// La huella (ruta → hash del contenido) dice qué archivos han cambiado desde el último mapa,
// sin depender de la sesión de Claude: así se sabe si hay que rehacerlo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { scanText, maskSecrets, isEnvFile, findGit } = require('./secrets');

const MAX_LIST = 4000; // archivos que se tienen en cuenta (los primeros por prioridad)
const MAX_HASH_BYTES = 1024 * 1024; // un archivo mayor entra en la huella por tamaño y fecha
const MAX_TREE = 1200; // rutas que se enseñan en el árbol
const MAX_MANIFEST = 6000; // caracteres de cada manifiesto
const MAX_PIECE = 2400; // de cada extracto de código
const BUDGET = { full: 110000, refresh: 45000 }; // caracteres en total

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', 'env', '__pycache__',
  'vendor', 'target', 'obj', '.next', '.nuxt', '.cache', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.gradle',
  '.terraform', '.tox', 'bower_components', '.parcel-cache', '.svelte-kit', '.angular', 'site-packages', '.claude']);
const BINARY = /\.(png|jpe?g|gif|bmp|ico|webp|tiff?|psd|svgz|mp[34]|wav|ogg|flac|avi|mov|mkv|webm|zip|7z|rar|gz|tgz|bz2|xz|tar|jar|war|exe|dll|so|dylib|bin|o|a|lib|class|pyc|pdb|wasm|ttf|otf|woff2?|eot|pdf|docx?|xlsx?|pptx?|db|sqlite3?|mdb|accdb|iso|img|dmg|msi|node|map|lock)$/i;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|pfx|p12|crt|cer|der|jks|keystore|kdbx|ovpn)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.htpasswd|credentials(\.\w+)?|secrets?\.(json|ya?ml|toml|ini|txt)|.*secret.*\.json)$/i;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|setup\.(py|cfg)|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|settings\.gradle|composer\.json|Gemfile|[\w.-]+\.csproj|[\w.-]+\.sln|(docker-)?compose[\w.-]*\.ya?ml|Dockerfile[\w.-]*|Containerfile|Makefile|Procfile|nginx\.conf|Caddyfile|vite\.config\.\w+|webpack\.config\.\w+|tsconfig\.json|serverless\.ya?ml|app\.ya?ml|\.github\/workflows\/[\w.-]+\.ya?ml)$/i;
const README = /(^|\/)readme(\.\w+)?$/i;
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|kts|scala|cs|fs|vb|php|swift|m|mm|c|cc|cpp|cxx|h|hpp|lua|pl|r|dart|ex|exs|erl|clj|sh|bash|ps1|psm1|bat|cmd|sql|html?|css|scss)$/i;
const CONFIG = /\.(ya?ml|toml|ini|cfg|conf|json|xml|properties)$/i;
const ENTRY = /(^|\/)(main|index|app|server|cli|program|startup|manage|wsgi|asgi|__main__|bootstrap|run|start|worker|daemon|service)\.\w+$/i;
// Líneas que dicen cómo se conecta un archivo con lo demás.
const LINK_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\b|module\.exports|(const|let|var)\s+.{1,80}=\s*(require|await import)\(|#include|using\s+[\w.]+;|use\s+[\w:]+|package\s+\w|@(app|router|api|bp|blueprint)\.\w+|@(Get|Post|Put|Delete|Controller|Route|Scheduled|Cron)\b|\b(app|router|server)\.(get|post|put|patch|delete|use|listen|route)\(|(async\s+)?function\s+\w+|(async\s+)?def\s+\w+|class\s+\w+|func\s+\w+|fn\s+\w+|public\s+(static\s+)?(class|interface|async|void)\b)|\b(spawn|execFile|exec|fork|setInterval|setTimeout|schedule|cron|fetch|axios|requests\.\w+|http\.(get|request)|createServer|WebSocket|ipcMain\.\w+|ipcRenderer\.\w+|subprocess\.\w+|Popen|listen)\s*\(/;

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
const slash = (p) => p.replace(/\\/g, '/');

// Lista de archivos del proyecto: con git, los que sigue y los nuevos que no deja fuera.
function gitList(folder, git) {
  return new Promise((resolve) => {
    execFile(git, ['-C', folder, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      resolve(String(stdout).split('\0').filter(Boolean));
    });
  });
}
function walkList(folder, limit = 20000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(child); } else if (entry.isFile()) out.push(child);
    }
  }
  return out;
}

// ¿Se tiene en cuenta este archivo? (nunca claves, binarios ni carpetas generadas)
function wanted(rel) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  const name = parts[parts.length - 1];
  if (SECRET_FILE.test(rel) || isEnvFile(name) || BINARY.test(name)) return false;
  return CODE.test(name) || CONFIG.test(name) || MANIFEST.test(rel) || README.test(rel) || /\.(md|txt|rst)$/i.test(name) || !path.extname(name);
}

// Orden de interés: manifiestos y README, puntos de entrada, código poco profundo, el resto.
function rank(rel) {
  const depth = rel.split('/').length - 1;
  if (MANIFEST.test(rel)) return depth;
  if (README.test(rel)) return 1 + depth;
  if (CODE.test(rel)) return (ENTRY.test(rel) ? 10 : 20) + depth * 2 + (/(^|\/)(tests?|spec|__tests__|e2e|fixtures|examples?|docs?)\//i.test(rel) ? 30 : 0);
  return 60 + depth;
}

// Archivos del proyecto, ordenados por interés: [{ rel, full }] y si se ha recortado la lista.
async function listFiles(folder) {
  const git = findGit();
  let list = git ? await gitList(folder, git) : null;
  if (!list) list = walkList(folder);
  const all = list.map(slash).filter(wanted);
  all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { files: all.slice(0, MAX_LIST).map((rel) => ({ rel, full: path.join(folder, rel) })), total: all.length };
}

// Lee un archivo de texto (null si no existe, es un enlace, es binario o es muy grande).
function readText(full) {
  let st;
  try { st = fs.lstatSync(full); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_HASH_BYTES) return null;
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  if (text.includes('\0')) return null;
  return text;
}

// Huella del proyecto: { rel: { h, s, m } } (hash del contenido, tamaño y fecha). `previous`
// evita volver a leer los archivos con el mismo tamaño y la misma fecha.
async function fingerprint(folder, previous = {}) {
  const { files, total } = await listFiles(folder);
  const out = {};
  for (const { rel, full } of files) {
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const old = previous[rel];
    if (old && old.s === st.size && old.m === st.mtimeMs) { out[rel] = old; continue; }
    const text = st.size <= MAX_HASH_BYTES ? readText(full) : null;
    out[rel] = { h: text === null ? `${st.size}:${st.mtimeMs}` : sha1(text), s: st.size, m: st.mtimeMs };
  }
  return { manifest: out, total, partial: total > files.length };
}

// Qué ha cambiado entre dos huellas: { added, removed, modified } (rutas).
function diff(before = {}, after = {}) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const rel of Object.keys(after)) {
    if (!before[rel]) added.push(rel);
    else if (before[rel].h !== after[rel].h) modified.push(rel);
  }
  for (const rel of Object.keys(before)) if (!after[rel]) removed.push(rel);
  return { added, removed, modified, count: added.length + removed.length + modified.length };
}

// Extracto de un archivo de código: el principio y las líneas que dicen cómo se conecta.
function excerpt(text, max = MAX_PIECE) {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = lines.slice(0, 25);
  const links = [];
  for (let i = 25; i < lines.length && links.length < 80; i += 1) {
    const line = lines[i];
    if (line.length < 300 && LINK_LINE.test(line)) links.push(`${i + 1}: ${line.trim()}`);
  }
  let out = head.join('\n');
  if (links.length) out += `\n[…]\n${links.join('\n')}`;
  if (lines.length > 25) out += `\n[${lines.length} líneas en total]`;
  return out.length > max ? `${out.slice(0, max)}\n[… recortado]` : out;
}

// El material que se envía: { text, used, masked, size, partial }. `only`: si se da, solo
// esos archivos (más los manifiestos), para rehacer el mapa con lo que ha cambiado.
async function material(folder, { kind = 'full', only = null } = {}) {
  const budget = BUDGET[kind] || BUDGET.full;
  const { files, total } = await listFiles(folder);
  const chosen = only ? files.filter((f) => only.has(f.rel) || MANIFEST.test(f.rel)) : files;
  const parts = [];
  const used = [];
  let masked = 0;
  let size = 0;
  let cut = false;
  const add = (title, body, rel) => {
    const found = scanText(body, rel).length;
    const safe = found ? maskSecrets(body) : body;
    masked += found;
    const block = `=== ${title} ===\n${safe}`;
    if (size + block.length > budget) { cut = true; return false; }
    parts.push(block);
    size += block.length;
    if (rel) used.push(rel);
    return true;
  };
  const tree = files.slice(0, MAX_TREE).map((f) => f.rel).join('\n') + (total > MAX_TREE ? `\n[… y ${total - MAX_TREE} archivos más]` : '');
  add(`Árbol del proyecto (${total} archivos)`, tree, null);
  const codeTotal = chosen.filter((f) => CODE.test(f.rel) && !MANIFEST.test(f.rel)).length;
  let codeShown = 0;
  for (const f of chosen) {
    if (cut) break;
    const text = readText(f.full);
    if (text === null || !text.trim()) continue;
    if (MANIFEST.test(f.rel) || README.test(f.rel)) {
      add(f.rel, text.length > MAX_MANIFEST ? `${text.slice(0, MAX_MANIFEST)}\n[… recortado]` : text, f.rel);
    } else if (CODE.test(f.rel) && add(`${f.rel} (extracto)`, excerpt(text), f.rel)) {
      codeShown += 1;
    }
  }
  // Parcial: si la lista se recortó o quedó fuera más del 30 % del código.
  const partial = total > files.length || (codeTotal > 0 && codeShown < codeTotal * 0.7);
  return { text: parts.join('\n\n'), used, masked, size, partial, total };
}

module.exports = { listFiles, fingerprint, diff, material, excerpt, wanted, rank, MAX_LIST };
