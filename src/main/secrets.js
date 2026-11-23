// Buena práctica para cualquier proyecto: avisar cuando hay una clave o contraseña escrita
// en un archivo que Claude acaba de editar.
//
// Una clave que llega a GitHub (o a cualquier copia del proyecto) hay que darla por robada
// aunque se borre después: queda en el historial. Cuando Claude edita un archivo, la app lo
// mira y, si encuentra algo con pinta de clave, se lo dice en ese momento para que la pase
// a un .env que git no suba y se lo cuente al usuario. Es un aviso, no un freno.
//
// - El aviso viaja en la respuesta al hook PostToolUse, como el de archivos que crecen.
// - Nunca se guarda ni se repite la clave: de cada una se recuerda solo una huella corta,
//   para no avisar dos veces de la misma clave en el mismo archivo.
// - Un .env es el sitio correcto para las claves: de él solo se avisa si git lo subiría.
// - Antes de una revisión de Codex (review.js) se comprueba lo que se le va a enviar: el
//   diff de lo que sigue git y los archivos nuevos que no deja fuera. Si lleva claves, o
//   no se ha podido comprobar todo, no se envía.
// - Como el de crecimiento, no ve lo que Claude cambia con comandos de la terminal.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { norm } = require('./growth');

const MAX_BYTES = 2 * 1024 * 1024; // un archivo mayor no se escribe a mano
const DEFAULT_BUDGET = 1500; // ms: el hook espera 2 s a la respuesta
const MAX_REMEMBERED = 50; // huellas recordadas por archivo
const MAX_DIFF = 20 * 1024 * 1024; // lo que se comprueba antes de una revisión de Codex
const MAX_UNTRACKED = 2000; // archivos nuevos como mucho (si hay más, no se comprueba: no se envía)

// Formatos conocidos de claves. `group`: el grupo con el valor secreto (si no, todo).
// `check`: lo que tiene que cumplir el valor (las claves de verdad mezclan letras y cifras;
// un identificador-en-minúsculas-largo no es una clave). `generic`: un nombre que suele
// llevar un secreto (password, api_key…) con un valor; se exige algo más para no confundir
// etiquetas, palabras sueltas o código con contraseñas. `files`: solo en esos archivos.
// `raw`: el valor no se compara con los de ejemplo (el contenido de una clave privada).
// Todos los tramos tienen límite: una línea muy larga (código minificado) no puede dejar
// colgado el proceso principal.
const SECRET_NAMES = '(?:password|passwd|pwd|contrase(?:ñ|n)a|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key)';
const mixed = (v) => /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
const hasDigit = (v) => /\d/.test(v);
const PATTERNS = [
  { kind: 'una clave de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, check: mixed },
  { kind: 'una clave de OpenAI', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, check: mixed },
  { kind: 'un token de GitHub', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, check: hasDigit },
  { kind: 'una clave de AWS', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, check: hasDigit },
  { kind: 'una clave de Google', re: /\bAIza[0-9A-Za-z_-]{35}/g, check: hasDigit },
  { kind: 'un token de Slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, check: hasDigit },
  { kind: 'una clave de Stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, check: hasDigit },
  { kind: 'una clave privada', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----([A-Za-z0-9+/=\s]{40,400})/g, group: 1, raw: true, check: (v) => v.replace(/\s/g, '').length >= 40 },
  { kind: 'una contraseña dentro de una dirección de conexión', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`]{1,64}:([^\s@/'"`]{3,128})@/gi, group: 1 },
  // nombre = "valor" (también nombre: 'valor', "nombre": "valor", nombre => "valor")
  { kind: 'una contraseña o clave escrita en el código', re: new RegExp(`(?<![\\w.-])[\\w.-]{0,40}${SECRET_NAMES}[\\w.-]{0,40}["']?[ \\t]{0,8}(?::|=>|=)[ \\t]{0,8}(["'\`])([^"'\`\\s]{6,200})\\1`, 'gi'), group: 2, generic: true },
  // NOMBRE=valor en un .env o en un guion (export, set, $env:)
  { kind: 'una contraseña o clave escrita en el código', re: /^[ \t]{0,40}(?:export[ \t]{1,8}|set[ \t]{1,8}|\$env:)?[A-Za-z0-9_]{0,40}(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]{0,40}[ \t]{0,8}=[ \t]{0,8}([^\s"'`#<>]{6,200})(?:[ \t]+#[^\n]*)?[ \t]*$/gim, group: 1, generic: true },
  // nombre: valor sin comillas, en archivos de configuración (YAML, INI, TOML…)
  { kind: 'una contraseña o clave escrita en la configuración', re: new RegExp(`^[ \\t-]{0,40}[\\w.-]{0,40}${SECRET_NAMES}[\\w.-]{0,40}[ \\t]{0,8}:[ \\t]{0,8}([^\\s"'\`#<>]{6,200})(?:[ \\t]+#[^\\n]*)?[ \\t]*$`, 'gim'), group: 1, generic: true, files: /\.(ya?ml|ini|conf|cfg|properties|toml)$/i },
];

// Valores de ejemplo, plantillas y referencias a variables: no son claves de verdad.
const PLACEHOLDER = /example|ejemplo|sample|muestra|dummy|fake|placeholder|changeme|c[aá]mbiame|redacted|xxx|\*\*\*|\.\.\.|\$\{[^}]*\}|\{\{|\}\}|<[^>]*>|^\$[A-Za-z_]\w*$|%[A-Za-z_]\w*%|%[sd(]|^(?:your|tu)[_-]/i;
// Un valor que es solo el nombre del campo («password», «api_key», «db_password_here»).
const NAME_ONLY = /^(?:(?:my|mi|the)[_-]?)?(?:db[_-]?|database[_-]?)?(?:password|passwd|pwd|contrase(?:ñ|n)a|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key|clave)(?:[_-]?(?:here|aqu[ií]))?$/i;
const REPEATED = /(.)\1{5,}/;
// Código, no un valor: una llamada, un índice, una ruta de objeto (config.clave) o el final
// de una expresión.
const CODE_LIKE = /[()[\]]|[;,]$|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

function plausible(value, generic) {
  if (PLACEHOLDER.test(value) || NAME_ONLY.test(value) || REPEATED.test(value)) return false;
  if (!generic) return true;
  if (CODE_LIKE.test(value)) return false;
  // Una palabra corta («Bearer», «basic») o un número corto (un puerto, un plazo) no es una contraseña.
  if (!/[^A-Za-z]/.test(value) && value.length < 16) return false;
  if (/^\d+$/.test(value) && value.length < 12) return false;
  return true;
}

const fingerprint = (kind, value) => crypto.createHash('sha256').update(`${kind}\n${value}`).digest('hex').slice(0, 12);

// Lo que parece una clave en un texto: [{ kind, line, fp }], sin el valor. Una por huella.
// file: nombre del archivo (algunos patrones solo valen para ciertos tipos).
function scanText(input, file = '', { allPatterns = false } = {}) {
  const out = [];
  const seen = new Set();
  const covered = []; // [inicio, fin) de los valores ya encontrados
  if (typeof input !== 'string' || !input || input.includes('\0')) return out; // vacío o binario
  const text = input.replace(/\r\n?/g, '\n'); // saltos de Windows: «$» es el final de la línea
  for (const { kind, re, group, generic, check, files, raw } of PATTERNS) {
    if (files && !files.test(file) && !allPatterns) continue; // en un texto libre (una pregunta, un plan), todos
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && out.length < 20) {
      const value = group ? m[group] : m[0];
      if ((!raw && !plausible(value, generic)) || (check && !check(value))) continue;
      const start = m.index + m[0].indexOf(value);
      if (covered.some(([a, b]) => start < b && start + value.length > a)) continue; // ya contada
      const fp = fingerprint(kind, raw ? value.replace(/\s/g, '') : value);
      if (seen.has(fp)) continue;
      seen.add(fp);
      covered.push([start, start + value.length]);
      out.push({ kind, line: text.slice(0, start).split('\n').length, fp });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// El texto con lo que parece una clave tapado («****»), con los mismos patrones que scanText.
// Para lo que se le pasa a otro modelo (el panel «Actividad», narrator.js).
function maskSecrets(input) {
  if (typeof input !== 'string' || !input) return '';
  let text = input;
  for (const { re, group, generic, check, raw } of PATTERNS) {
    text = text.replace(re, (...m) => {
      const value = group ? m[group] : m[0];
      if (typeof value !== 'string' || (!raw && !plausible(value, generic)) || (check && !check(value))) return m[0];
      return m[0].replace(value, '****');
    });
  }
  return text;
}

// .env, .env.local, .env.production… (no las plantillas: .env.example, .env.sample…).
const isEnvFile = (file) => /^\.env(\..+)?$/i.test(path.basename(file)) && !/\.(example|sample|template|dist|defaults?)$/i.test(file);

// ¿Está la carpeta dentro de un repositorio git? (una carpeta o archivo .git en ella o en
// alguna superior; sin lanzar git).
function insideGitRepo(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// git, buscado solo en las carpetas absolutas del PATH: nunca en la del proyecto.
let gitPath;
function findGit() {
  if (gitPath !== undefined) return gitPath;
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  gitPath = null;
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) { gitPath = candidate; return gitPath; } } catch { /* no está aquí */ }
    }
  }
  return gitPath;
}

// ¿Lo deja git fuera (.gitignore)? true, false o null si no se sabe (sin git, fuera de un
// repositorio…). Un archivo ya confirmado no está «fuera», aunque .gitignore lo nombre.
function isIgnored(full) {
  const git = findGit();
  if (!git) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(git, ['check-ignore', '-q', '--', full], { cwd: path.dirname(full), windowsHide: true, timeout: 5000 }, (err) => {
      if (!err) resolve(true);
      else resolve(err.code === 1 ? false : null);
    });
  });
}


// Texto de un archivo: UTF-8 o UTF-16 (lo que escribe PowerShell 5 con «>»), según su
// marca o por sus ceros alternos. null si es binario.
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const be = (start) => { const b = Buffer.from(buf.subarray(start, start + ((buf.length - start) & ~1))); b.swap16(); return b.toString('utf16le'); };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return be(2);
  if (!buf.includes(0)) return buf.toString('utf8');
  const n = Math.min(buf.length, 4096) & ~1;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) { if (i % 2) odd += 1; else even += 1; }
  if (odd > n / 4 && even === 0) return buf.toString('utf16le');
  if (even > n / 4 && odd === 0) return be(0);
  return null;
}

async function readText(full) {
  const st = await fs.promises.stat(full);
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  return decodeText(await fs.promises.readFile(full));
}

class Secrets {
  // store: el guardado de la app (clave «secretWarnings»); log(texto): registro de la app.
  constructor({ store, log }) {
    this.store = store;
    this.log = log || (() => {});
  }

  // Claude acaba de editar `file` en el proyecto `project`. Devuelve el aviso para Claude,
  // o null. base: carpeta para resolver una ruta relativa; budget: ms como mucho (si se
  // pasa, no se avisa ni se anota: el aviso ya no llegaría).
  // defer: devuelve { notice, commit } y no anota nada hasta commit() (cuando el aviso
  // de verdad llega a Claude).
  async edited(project, file, { base = null, budget = DEFAULT_BUDGET, defer = false } = {}) {
    if (!project || typeof file !== 'string' || !file) return null;
    const deadline = Date.now() + budget;
    const full = path.resolve(base || project, file);
    if (/[\\/](?:\.git|node_modules)[\\/]/i.test(full)) return null;
    let text;
    try { text = await readText(full); } catch { return null; }
    if (text === null) return null;
    let notice;
    let key;
    let fresh;
    if (isEnvFile(full)) {
      // El sitio de las claves: solo hay que avisar si git lo subiría.
      if (!scanText(text, full).length || !insideGitRepo(path.dirname(full)) || (await isIgnored(full)) !== false) return null;
      fresh = [{ fp: 'gitignore' }];
      key = this.keyFor(project, full);
      if (this.remembered(project, key).includes('gitignore')) return null;
      notice = [
        `ClaudHome · buenas prácticas: el archivo ${full} guarda claves o contraseñas, pero git no lo deja fuera: se subiría con ellas a GitHub.`,
        `Añade su nombre (${path.basename(full)}, o .env* para todos) al .gitignore del proyecto; si ya estaba confirmado en git, sácalo del repositorio con «git rm --cached» sin borrarlo del disco.`,
        'Díselo al usuario en una o dos frases, sin escribir nunca las claves en tus respuestas.',
      ].join(' ');
    } else {
      const found = scanText(text, full);
      if (!found.length) return null;
      key = this.keyFor(project, full);
      const known = this.remembered(project, key);
      fresh = found.filter((f) => !known.includes(f.fp));
      if (!fresh.length) return null;
      const kinds = [...new Set(fresh.map((f) => f.kind))];
      const lines = [...new Set(fresh.map((f) => f.line))];
      notice = [
        `ClaudHome · buenas prácticas: en el archivo ${full} hay lo que parece ${kinds.join(', ')} (línea${lines.length > 1 ? 's' : ''} ${lines.join(', ')}).`,
        'Una clave o contraseña escrita en el código acaba en GitHub y en cualquier copia del proyecto, y entonces hay que darla por robada aunque se borre después.',
        'Pásala ya a una variable de entorno o a un archivo .env que git no suba (comprueba que .env está en .gitignore) y léela desde el código por su nombre, para que todo siga funcionando igual.',
        'Que el usuario te haya dado la clave no significa que quiera tenerla escrita en el código: hazlo aunque te la haya dado él.',
        'Déjala como está solo si es un valor de ejemplo o falso, o si el usuario te ha pedido expresamente que quede escrita en ese archivo.',
        'En cualquier caso, cuéntaselo al usuario en una o dos frases y no escribas nunca la clave en tus respuestas.',
        'No volverás a recibir este aviso por esta misma clave en este archivo.',
      ].join(' ');
    }
    if (Date.now() > deadline) {
      this.log(`buenas prácticas: revisar si ${full} tiene claves ha tardado demasiado; se deja para la próxima edición`);
      return null;
    }
    const commit = () => {
      this.remember(project, key, fresh.map((f) => f.fp));
      this.log(`buenas prácticas: posible clave en ${full}: se avisa a Claude`);
    };
    if (defer) return { notice, commit };
    commit();
    return notice;
  }

  // Lo que vería Codex al revisar los cambios sin confirmar del repositorio de `cwd`.
  reviewInput(cwd, signal) { return reviewInput(cwd, signal); }

  keyFor(project, full) {
    const p = norm(project);
    return norm(full).startsWith(`${p}/`) ? norm(full).slice(p.length + 1) : norm(full);
  }

  remembered(project, key) {
    const all = this.store.get('secretWarnings', {});
    return ((all[norm(project)] || {})[key]) || [];
  }

  remember(project, key, fps) {
    const all = { ...this.store.get('secretWarnings', {}) };
    const mine = { ...(all[norm(project)] || {}) };
    mine[key] = [...new Set([...(mine[key] || []), ...fps])].slice(-MAX_REMEMBERED);
    all[norm(project)] = mine;
    this.store.set('secretWarnings', all);
  }
}

// Un diff de git, por archivos: [[ruta, texto]], sin las marcas de línea (+, -, espacio)
// para que los patrones que miran el principio de la línea funcionen igual.
function splitDiff(text) {
  const parts = [];
  let current = null;
  let inHunk = false; // las cabeceras (---, +++, index…) van antes del primer @@
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (head) { current = [head[1].replace(/^"|"$/g, ''), [], false]; parts.push(current); inHunk = false; continue; }
    if (!current) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      const context = line.replace(/^@@[^@]*@@ ?/, ''); // la línea de la función que contiene el cambio
      if (context) current[1].push(context);
      continue;
    }
    if (!inHunk && /^Binary files /.test(line)) { current[2] = true; continue; }
    if (inHunk && /^[+\- ]/.test(line)) current[1].push(line.slice(1)); // también «------BEGIN…» borrado
  }
  // [ruta, texto], y [ruta, '', true] si git lo trata como binario.
  return parts.map(([file, lines, binary]) => (binary ? [file, lines.join('\n'), true] : [file, lines.join('\n')]));
}

// Lo que verá Codex en una revisión de cambios sin confirmar (`--uncommitted`): el diff de
// lo que sigue git, preparado o no (también las líneas borradas), y los archivos nuevos que
// git no deja fuera. Devuelve { ok, files }: ok = false si no se ha podido comprobar todo
// (sin git, demasiado grande, un archivo que no se puede leer…), y files, los que llevan
// algo con pinta de clave (rutas relativas a la raíz del repositorio).
// git se lanza sin programas del proyecto: sin diff externos, sin filtros y sin fsmonitor.
async function reviewInput(cwd, signal = null) {
  const git = findGit();
  if (!git) return { ok: false, files: [] };
  const stopped = () => Boolean(signal && signal.aborted);
  const run = (args, where) => new Promise((resolve) => {
    if (stopped()) { resolve(null); return; }
    const config = ['core.fsmonitor=false', 'core.quotepath=off', 'diff.noprefix=false', 'diff.mnemonicPrefix=false', 'diff.relative=false'];
    execFile(git, [...config.flatMap((c) => ['-c', c]), ...args], { cwd: where, windowsHide: true, timeout: 30000, maxBuffer: MAX_DIFF, encoding: 'utf8', ...(signal ? { signal } : {}) }, (err, stdout) => resolve(err ? null : stdout));
  });
  const cancelled = (files = []) => ({ ok: false, files, aborted: true });
  const top = await run(['rev-parse', '--show-toplevel'], cwd);
  if (stopped()) return cancelled();
  if (top === null) return { ok: false, files: [] };
  const root = path.resolve(top.trim());
  // Lo preparado (frente a lo confirmado) y lo no preparado (frente a lo preparado), por
  // separado: una clave preparada y luego borrada de la copia de trabajo sigue en lo preparado.
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
  const diffs = [await run([...diffArgs, '--cached'], root), await run(diffArgs, root)];
  if (stopped()) return cancelled();
  if (diffs.some((d) => d === null)) return { ok: false, files: [] };
  const risky = new Set();
  // Lo que git trata como binario puede ser texto en UTF-16 (scripts de PowerShell): se lee
  // la versión preparada (git cat-file, sin filtros) o la de la copia de trabajo.
  const readBlob = (spec) => new Promise((resolve) => {
    execFile(git, ['cat-file', 'blob', spec], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: MAX_BYTES + 1, encoding: 'buffer', ...(signal ? { signal } : {}) }, (err, stdout) => resolve(err ? null : stdout));
  });
  let tracked = 0;
  let lines = 0; // líneas cambiadas (y las de los archivos nuevos)
  const paths = new Set(); // archivos que cambian
  for (const [which, diff] of [['cached', diffs[0]], ['work', diffs[1]]]) {
    const parts = splitDiff(diff);
    if (diff.trim() && !parts.length) return { ok: false, files: [] }; // un formato que no se entiende: sin comprobar
    tracked += parts.length;
    // Las líneas añadidas o quitadas (sin las cabeceras «--- a/…» y «+++ b/…»).
    lines += (diff.match(/^[+-](?!\+\+ |-- )/gm) || []).length;
    for (const [rel, text, binary] of parts) {
      paths.add(rel);
      if (!binary) { if (scanText(text, rel).length) risky.add(rel); continue; }
      let buf;
      if (which === 'cached') buf = await readBlob(`:${rel}`);
      else { try { const st = await fs.promises.stat(path.join(root, rel)); if (st.size <= MAX_BYTES) buf = await fs.promises.readFile(path.join(root, rel)); else return { ok: false, files: [...risky] }; } catch { continue; } } // borrado: nada que leer
      if (stopped()) return cancelled([...risky]);
      if (buf === null) continue; // borrado del índice
      const decoded = decodeText(buf);
      if (decoded !== null && scanText(decoded, rel).length) risky.add(rel);
    }
  }
  const listed = await run(['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (listed === null) return { ok: false, files: [] };
  const untracked = listed.split('\0').filter(Boolean);
  if (untracked.length > MAX_UNTRACKED) return { ok: false, files: [...risky] };
  for (const rel of untracked) {
    if (stopped()) return cancelled([...risky]);
    const full = path.join(root, rel);
    let text;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) continue;
      const head = Buffer.alloc(Math.min(8192, st.size));
      const fh = await fs.promises.open(full, 'r');
      try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
      if (decodeText(head) === null) continue; // binario: no es texto que se pueda leer como clave
      if (st.size > MAX_BYTES) return { ok: false, files: [...risky] }; // texto enorme: no se ha podido comprobar
      text = decodeText(await fs.promises.readFile(full));
    } catch {
      return { ok: false, files: [...risky] };
    }
    if (text === null) continue;
    paths.add(rel);
    lines += text.split('\n').length;
    if (scanText(text, rel).length) risky.add(rel);
  }
  // Sin nada que revisar (Claude ya lo ha confirmado o deshecho): no se lanza Codex.
  if (!tracked && !untracked.length) return { ok: true, files: [], empty: true };
  return { ok: true, files: [...risky], lines, paths: [...paths] };
}

module.exports = { Secrets, scanText, maskSecrets, isEnvFile, findGit, splitDiff, reviewInput, decodeText };
