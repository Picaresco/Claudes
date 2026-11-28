// ── SuperPowers con Codex: un git local si la carpeta no tiene ─────
// La revisión de Codex (review.js) compara lo que cambia Claude con lo confirmado en git: sin
// repositorio no revisa nada. Al encender SuperPowers con Codex (al pulsar el botón, nunca al
// abrir una pestaña), si la carpeta del proyecto no tiene git se crea uno local con una foto
// del estado actual (un primer commit de «ClaudHome»). Sin remoto: nada sale del equipo.
// - No se crea en carpetas generales (la raíz de un disco, la del usuario, Escritorio,
//   Documentos, Descargas…), del sistema o de programas, de red (UNC o unidad conectada) ni
//   sincronizadas con OneDrive; tampoco si git no puede decir si ya es un repositorio
//   (permisos, propietario dudoso…), si dentro hay otro repositorio o si la foto sería muy
//   grande (más de 5 000 archivos o 200 MB).
// - Lo pesado y lo que suele llevar claves (node_modules, .env, *.pem…) se deja fuera en
//   .git/info/exclude: no se crea ningún .gitignore en el proyecto. Los archivos en los que
//   secrets.js ve algo con pinta de clave también se dejan fuera: no entran en la foto.
// - git va aislado: sin hooks, sin plantilla, sin variables GIT_* heredadas y con la identidad
//   ClaudHome solo para ese commit. Si algo falla, se borra el .git creado (solo si lleva la
//   marca de ClaudHome) y se dice por qué.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { findGit, scanText, decodeText } = require('./secrets');
const { repoRoot } = require('./review');

const MAX_FILES = 5000;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_SCAN = 2 * 1024 * 1024; // un texto mayor no se mira (no es una configuración a mano)
const MARK = 'claudhome-init'; // dentro de .git: lo ha creado ClaudHome (solo entonces se borra)
const MESSAGE = 'ClaudHome: punto de partida para que Codex revise los cambios';
// Fuera de la foto: lo pesado que se regenera y lo que suele llevar claves.
const EXCLUDE = [
  'node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', '.next/', '.nuxt/', '.cache/', 'coverage/',
  '*.log', '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '.npmrc', '.pypirc', '.netrc', '.ssh/', '.aws/',
  'credentials*.json', 'service-account*.json', '.DS_Store', 'Thumbs.db', 'desktop.ini',
];

const win = process.platform === 'win32';
const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
// ¿Está `child` dentro de `parent` (o es la misma)? Por componentes, sin distinguir mayúsculas en Windows.
function inside(child, parent) {
  if (!parent) return false;
  const rel = path.relative(win ? parent.toLowerCase() : parent, win ? child.toLowerCase() : child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Por qué no se debe convertir esta carpeta en un repositorio (null si se puede).
function unsuitable(dir, env = process.env, home = os.homedir()) {
  if (dir.startsWith('\\\\') || dir.startsWith('//')) return 'es una carpeta de red';
  if (same(path.parse(dir).root.replace(/[\\/]+$/, ''), dir.replace(/[\\/]+$/, ''))) return 'es la raíz de un disco';
  if (same(dir, home)) return 'es tu carpeta de usuario';
  const general = ['Desktop', 'Escritorio', 'Documents', 'Documentos', 'Downloads', 'Descargas', 'Pictures', 'Imágenes', 'Music', 'Música', 'Videos', 'Vídeos', 'Favorites', 'Links', 'Saved Games', 'Contacts', 'Searches'];
  if (general.some((name) => same(dir, path.join(home, name)))) return 'es una carpeta general del usuario (Escritorio, Documentos, Descargas…)';
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    if (env[key] && inside(dir, path.resolve(env[key]))) return 'está sincronizada con OneDrive (git dentro de OneDrive puede estropearse)';
  }
  if (inside(dir, path.join(home, 'OneDrive'))) return 'está sincronizada con OneDrive (git dentro de OneDrive puede estropearse)';
  for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
    if (env[key] && inside(dir, path.resolve(env[key]))) return 'es una carpeta del sistema o de programas';
  }
  return null;
}

// Entorno de git: sin GIT_* heredadas (un GIT_DIR o GIT_WORK_TREE lo mandaría a otra parte),
// sin preguntar nada y sin buscar programas en la carpeta del proyecto.
function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', NoDefaultCurrentDirectoryInExePath: '1' };
}

function runner(git, cwd, hooksDir) {
  const config = ['core.fsmonitor=false', `core.hooksPath=${hooksDir}`, 'commit.gpgsign=false', 'core.quotepath=off', 'init.defaultBranch=main'];
  return (args, timeout = 30000) => new Promise((resolve) => {
    execFile(git, [...config.flatMap((c) => ['-c', c]), ...args], { cwd, env: gitEnv(), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Unidades de Windows conectadas a carpetas de red («net use»): 'Z:' …
function networkDrives() {
  if (!win) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'net.exe'), ['use'], { windowsHide: true, timeout: 5000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? [] : [...String(stdout).matchAll(/\s([A-Z]:)\s+\\\\/gi)].map((m) => m[1].toUpperCase())));
  });
}

// Un patrón de .git/info/exclude que nombra exactamente ese archivo (desde la raíz).
const literal = (rel) => `/${rel.replace(/\\/g, '/').replace(/[*?[\]!#\\ ]/g, (c) => `\\${c}`)}`;

// ¿Lleva algo con pinta de clave? Los binarios y los textos enormes no se miran.
async function risky(full, rel) {
  try {
    const st = await fs.promises.lstat(full);
    if (!st.isFile() || st.size > MAX_SCAN) return false;
    const text = decodeText(await fs.promises.readFile(full));
    return text !== null && scanText(text, rel).length > 0;
  } catch { return false; }
}

const busy = new Map(); // una sola vez a la vez por carpeta

// Crea el repositorio si hace falta. Devuelve { state, reason?, files?, excluded? }:
// 'exists' (ya lo era), 'created', 'skipped' (no se debe: reason) o 'failed' (reason).
function ensureRepo(folder, { hooksDir, log = () => {}, env = process.env, home = os.homedir(), git = findGit(), drives = networkDrives, maxFiles = MAX_FILES, maxTotal = MAX_TOTAL } = {}) {
  const key = win ? String(folder).toLowerCase() : String(folder);
  const prev = busy.get(key) || Promise.resolve();
  const next = prev.then(() => create(folder, { hooksDir, log, env, home, git, drives, maxFiles, maxTotal }));
  busy.set(key, next.catch(() => {}));
  return next;
}

async function create(folder, { hooksDir, log, env, home, git, drives, maxFiles, maxTotal }) {
  if (typeof folder !== 'string' || !folder) return { state: 'failed', reason: 'la carpeta no es válida' };
  if (repoRoot(folder)) return { state: 'exists' };
  if (!git) return { state: 'skipped', reason: 'git no está instalado en este equipo' };
  let dir;
  try { dir = fs.realpathSync.native(path.resolve(folder)); } catch { return { state: 'failed', reason: 'no se puede leer la carpeta' }; }
  const why = unsuitable(dir, env, home) || unsuitable(path.resolve(folder), env, home);
  if (why) return { state: 'skipped', reason: why };
  const drive = path.parse(path.resolve(folder)).root.slice(0, 2).toUpperCase();
  if (/^[A-Z]:$/.test(drive) && (await drives()).includes(drive)) return { state: 'skipped', reason: 'es una unidad de red' };
  if (!hooksDir) return { state: 'failed', reason: 'falta la carpeta sin hooks' };
  fs.mkdirSync(hooksDir, { recursive: true });
  const run = runner(git, dir, hooksDir);
  // ¿Es ya un repositorio para git (un .git que no se ve, otra forma)? Solo se sigue si git dice que no.
  const probe = await run(['rev-parse', '--is-inside-work-tree']);
  if (probe.ok) return { state: 'exists' };
  if (!/not a git repository/i.test(probe.stderr)) {
    const first = probe.stderr.split(/\r?\n/).find((l) => l.trim()) || 'sin respuesta';
    return { state: 'skipped', reason: `git no puede decir si ya es un repositorio (${first.trim().slice(0, 160)})` };
  }
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(gitDir)) return { state: 'exists' };
  const undo = (reason) => {
    try { if (fs.existsSync(path.join(gitDir, MARK))) fs.rmSync(gitDir, { recursive: true, force: true }); } catch (err) { log(`git local de SuperPowers en ${dir}: no se ha podido quitar el .git a medias (${err.message})`); }
    return { state: 'failed', reason };
  };
  const init = await run(['init', '-q', '--template=']);
  if (!init.ok || !fs.existsSync(gitDir)) return undo(`git init ha fallado: ${init.stderr.trim().slice(0, 160)}`);
  try {
    fs.writeFileSync(path.join(gitDir, MARK), `${new Date().toISOString()}\n`);
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), `# ClaudHome (SuperPowers): fuera de la foto\n${EXCLUDE.join('\n')}\n`);
  } catch (err) { return undo(`no se puede escribir en .git (${err.message})`); }
  // Lo que entraría en la foto, según el propio git.
  const listed = await run(['ls-files', '--others', '--exclude-standard', '-z']);
  if (!listed.ok) return undo('git no ha podido listar los archivos');
  const files = listed.stdout.split('\0').filter(Boolean);
  const nested = files.find((rel) => rel.endsWith('/'));
  if (nested) return { ...undo(`dentro hay otro repositorio git (${nested.replace(/\/$/, '')})`), state: 'skipped' };
  if (files.length > maxFiles) return { ...undo(`el proyecto tiene demasiados archivos para la foto (más de ${maxFiles})`), state: 'skipped' };
  let total = 0;
  const excluded = [];
  for (const rel of files) {
    const full = path.join(dir, rel);
    try { total += (await fs.promises.lstat(full)).size; } catch { /* desaparecido: git lo dirá */ }
    if (total > maxTotal) return { ...undo(`el proyecto es demasiado grande para la foto (más de ${Math.round(maxTotal / 1048576)} MB)`), state: 'skipped' };
    if (await risky(full, rel)) excluded.push(rel);
  }
  if (excluded.length) {
    try { fs.appendFileSync(path.join(gitDir, 'info', 'exclude'), `# Parecen llevar una clave\n${excluded.map(literal).join('\n')}\n`); } catch (err) { return undo(`no se puede escribir en .git (${err.message})`); }
  }
  const add = await run(['add', '-A'], 120000);
  if (!add.ok) return undo(`git add ha fallado: ${add.stderr.trim().slice(0, 160)}`);
  const commit = await run(['-c', 'user.name=ClaudHome', '-c', 'user.email=claudhome@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', MESSAGE], 60000);
  if (!commit.ok) return undo(`git commit ha fallado: ${commit.stderr.trim().slice(0, 160)}`);
  log(`git local de SuperPowers creado en ${dir}: ${files.length - excluded.length} archivos en la foto${excluded.length ? `, ${excluded.length} fuera por parecer llevar una clave` : ''}`);
  return { state: 'created', files: files.length - excluded.length, excluded };
}

module.exports = { ensureRepo, unsuitable, inside, literal, EXCLUDE, MARK, MESSAGE };
