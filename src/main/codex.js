// Codex CLI: detecta si está instalado y con sesión de ChatGPT, y le pide imágenes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const GENERATE_TIMEOUT = 5 * 60 * 1000;

let codexPath; // undefined = sin buscar todavía; null = no encontrado

function findCodex() {
  if (codexPath !== undefined) return codexPath;
  let found = [];
  try {
    const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
    found = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
  } catch { /* no está en el PATH */ }
  codexPath = found.find((c) => /\.exe$/i.test(c)) || found.find((c) => /\.(cmd|bat)$/i.test(c)) || null;
  return codexPath;
}

// Un .cmd (instalación por npm) solo se puede lanzar a través del intérprete;
// los argumentos que se le pasan aquí nunca llevan texto del usuario.
const viaShell = (exe) => /\.(cmd|bat)$/i.test(exe);

// Un programa, buscado solo en las carpetas absolutas del PATH (nunca en la actual).
function findOnPath(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* no está aquí */ }
  }
  return null;
}

// Cómo lanzar Codex. Con la instalación de npm, codex.cmd solo llama a node con su
// codex.js: se lanza eso directamente, sin cmd.exe. Así las rutas con espacios o de red
// (UNC) van tal cual y no se busca ningún programa en la carpeta del proyecto. Si no se
// encuentra, se usa el .cmd a través del intérprete.
function launcher(exe) {
  if (!viaShell(exe)) return { command: exe, prefix: [], shell: false };
  const script = path.join(path.dirname(exe), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const bundled = path.join(path.dirname(exe), 'node.exe');
  const node = fs.existsSync(bundled) ? bundled : findOnPath(process.platform === 'win32' ? 'node.exe' : 'node');
  if (node && fs.existsSync(script)) return { command: node, prefix: [script], shell: false };
  return { command: exe, prefix: [], shell: true };
}

function run(exe, args, timeout) {
  const l = launcher(exe);
  return new Promise((resolve) => {
    execFile(l.command, [...l.prefix, ...args], { encoding: 'utf8', windowsHide: true, timeout, shell: l.shell }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: `${stdout || ''}\n${stderr || ''}` });
    });
  });
}

// Estado de Codex en este equipo:
//   mode 'chatgpt' → sesión iniciada con una suscripción de ChatGPT
//   mode 'apikey'  → sesión con clave de API (se factura aparte, no es la suscripción)
async function detect() {
  codexPath = undefined; // puede haberse instalado o desinstalado desde la última vez
  const exe = findCodex();
  if (!exe) return { installed: false, loggedIn: false, mode: null };
  const status = await run(exe, ['login', 'status'], 15000);
  const loggedIn = status.ok && /logged in/i.test(status.text) && !/not logged in/i.test(status.text);
  let mode = null;
  if (loggedIn) mode = /chatgpt/i.test(status.text) ? 'chatgpt' : 'apikey';
  // El asesor necesita poder lanzar Codex aislado (versiones recientes).
  const help = await run(exe, ['exec', '--help'], 15000);
  const advisor = help.ok && /--ignore-user-config/.test(help.text) && /--ignore-rules/.test(help.text);
  return { installed: true, loggedIn, mode, advisor, sandbox: sandboxConfigured() };
}

// En Windows, Codex necesita su zona protegida configurada ([windows] sandbox en su
// config.toml) para poder ejecutar hasta un «git status»; sin ella, no lee el proyecto.
function sandboxConfigured() {
  if (process.platform !== 'win32') return true;
  try { return Boolean(userSetting(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'), 'windows', 'sandbox')); } catch { return false; }
}

// ¿Ha podido Codex leer el proyecto? Se cuentan sus comandos: los rechazados por su zona
// protegida (líneas «ERROR … exec_command failed … blocked by policy» del registro) o que
// fallan con acceso denegado, frente a los que funcionan («succeeded in …» en una
// revisión; exit_code 0 en el registro JSON). No se miran frases sueltas: el contenido de un
// archivo leído (o un diff) puede decir «blocked by policy» sin que nada haya fallado.
// { blocked: no ha funcionado ninguno y alguno se ha denegado; partial: unos sí y otros no,
// que es habitual: Codex prueba otra vía y lee el proyecto igual }.
const DENIED = /blocked by policy|Access to the path [^\n]{0,400}? is denied|Acceso denegado|access is denied/i;
function accessReport(stdout, stderr) {
  let failed = 0;
  let succeeded = 0;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/\bERROR\b.*exec_command failed/.test(line) && DENIED.test(line)) failed += 1;
    else if (/^\s*succeeded in \d+/.test(line)) succeeded += 1;
  }
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event && event.type === 'item.completed' && event.item;
    if (!item || item.type !== 'command_execution') continue;
    if (item.exit_code === 0) succeeded += 1;
    else if (DENIED.test(String(item.aggregated_output || ''))) failed += 1;
  }
  return { blocked: failed > 0 && succeeded === 0, partial: failed > 0 && succeeded > 0 };
}

const configPath = () => path.join(codexHome(), 'config.toml');

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// La imagen más reciente que Codex haya guardado desde `since`.
function newestGeneratedImage(since) {
  const root = path.join(codexHome(), 'generated_images');
  let best = null;
  const consider = (file) => {
    if (!IMAGE_FILE.test(file)) return;
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
    if (mtime >= since && (!best || mtime > best.mtime)) best = { file, mtime };
  };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) { consider(full); continue; }
    let recent = false;
    try { recent = fs.statSync(full).mtimeMs >= since; } catch { /* carpeta borrada */ }
    if (!recent) continue; // hay miles de carpetas antiguas: solo se miran las tocadas ahora
    try { for (const name of fs.readdirSync(full)) consider(path.join(full, name)); } catch { /* sin acceso */ }
  }
  return best ? best.file : null;
}

function buildPrompt({ description, shape, transparent }) {
  const lines = [
    'Genera UNA sola imagen con tu herramienta de generación de imágenes y nada más.',
    '',
    'Descripción de la imagen:',
    description,
    '',
  ];
  if (shape) lines.push(`Proporción: ${shape}.`);
  if (transparent) lines.push('El fondo debe ser transparente.');
  lines.push(
    'No escribas código, no crees ni modifiques otros archivos y no pidas aclaraciones: si falta algún detalle, decídelo tú.',
    'Al terminar, responde únicamente con la ruta absoluta del archivo de imagen generado.',
  );
  return lines.join('\n');
}

// Elige un nombre libre para no pisar un archivo que ya exista.
function freePath(wanted) {
  if (!fs.existsSync(wanted)) return wanted;
  const { dir, name, ext } = path.parse(wanted);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return wanted;
}

function resolveOutput(cwd, file) {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  let target = typeof file === 'string' && file.trim() ? file.trim() : `imagen-codex-${stamp}.png`;
  if (!path.isAbsolute(target)) target = path.join(cwd, target);
  if (!/\.png$/i.test(target)) target += '.png';
  target = path.normalize(target);
  // Solo dentro de la carpeta de la sesión: lo que haya que mover fuera lo hará
  // Claude con sus propias herramientas y permisos.
  const relative = path.relative(cwd, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`La imagen solo se puede guardar dentro de la carpeta de la sesión (${cwd}).`);
  }
  return freePath(target);
}

// Pide una imagen a Codex y la copia a la carpeta de la sesión.
// Devuelve { path } o lanza un error con un mensaje explicable al usuario.
function generateImage({ description, shape, transparent, file, cwd, workDir }) {
  return new Promise((resolve, reject) => {
    const exe = findCodex();
    if (!exe) { reject(new Error('Codex no está instalado en este equipo.')); return; }
    if (typeof description !== 'string' || !description.trim()) { reject(new Error('Falta la descripción de la imagen.')); return; }
    let target;
    try {
      target = resolveOutput(cwd, file); // se comprueba antes de gastar una generación
    } catch (err) {
      reject(err);
      return;
    }

    fs.mkdirSync(workDir, { recursive: true });
    const started = Date.now() - 2000; // margen por la resolución del reloj del disco
    // La petición va por la entrada estándar («-»): así no hay límites ni comillas que escapar.
    // --ephemeral: no deja la petición en el historial de sesiones de Codex.
    // --sandbox read-only: Codex no puede cambiar nada del equipo; la imagen la guarda él en su carpeta.
    // La carpeta de trabajo, como directorio (con -C, una ruta con espacios se partiría en cmd.exe).
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '-'];
    const l = launcher(exe);
    const child = spawn(l.command, [...l.prefix, ...args], { cwd: workDir, env: reviewEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: l.shell });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya había salido */ }
      finish(reject, new Error('Codex ha tardado más de 5 minutos y se ha cancelado la petición.'));
    }, GENERATE_TIMEOUT);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish(reject, new Error(`No se pudo ejecutar Codex: ${err.message}`)));
    child.on('close', (code) => {
      // Cada línea es un evento JSON; interesan el último mensaje de Codex y los errores.
      let lastMessage = '';
      let failure = '';
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') lastMessage = String(event.item.text || '');
        if (event.type === 'error' || event.type === 'turn.failed') failure = String(event.message || (event.error && event.error.message) || failure);
      }

      const named = lastMessage.trim().replace(/^["'`]+|["'`]+$/g, '');
      const source = IMAGE_FILE.test(named) && fs.existsSync(named) ? named : newestGeneratedImage(started);
      if (!source) {
        const reason = failure || lastMessage.trim() || stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `Codex terminó con el código ${code}.`;
        finish(reject, new Error(`Codex no ha generado ninguna imagen. ${reason}`.slice(0, 800)));
        return;
      }
      try {
        const final = freePath(target); // por si alguien creó ese archivo mientras tanto
        fs.mkdirSync(path.dirname(final), { recursive: true });
        fs.copyFileSync(source, final);
        finish(resolve, { path: final });
      } catch (err) {
        finish(reject, new Error(`La imagen se generó (${source}) pero no se pudo copiar a su destino: ${err.message}`));
      }
    });

    child.stdin.on('error', () => { /* Codex cerró la entrada antes de tiempo */ });
    child.stdin.end(buildPrompt({ description: description.trim(), shape, transparent }));
  });
}

// La herramienta tal como la ve Claude en sus sesiones.
const IMAGE_TOOL = {
  name: 'generar_imagen',
  description: 'Genera una imagen nueva (ilustración, icono, logotipo, foto, textura, sprite, maqueta de pantalla…) '
    + 'con la suscripción de Codex del usuario y la guarda como PNG dentro de la carpeta de la sesión. '
    + 'Suele tardar entre 20 y 90 segundos. Devuelve la ruta del archivo; ábrelo con Read si necesitas ver el resultado. '
    + 'Cada llamada consume una generación del plan de Codex del usuario: úsala cuando haga falta una imagen de verdad, no para probar.',
  inputSchema: {
    type: 'object',
    properties: {
      descripcion: {
        type: 'string',
        description: 'Qué debe mostrar la imagen: sujeto, estilo, colores, composición y cualquier texto que deba aparecer escrito.',
      },
      archivo: {
        type: 'string',
        description: 'Dónde guardarla, relativo a la carpeta de la sesión (por ejemplo "assets/portada.png"). Si se omite, se guarda como imagen-codex-<fecha>.png. No sobrescribe: si el archivo existe, se añade un número al nombre.',
      },
      formato: {
        type: 'string',
        enum: ['cuadrada', 'horizontal', 'vertical'],
        description: 'Proporción de la imagen.',
      },
      fondo_transparente: {
        type: 'boolean',
        description: 'true para pedir la imagen con fondo transparente.',
      },
    },
    required: ['descripcion'],
  },
};

// ── Revisión de código, segunda opinión y crítica de planes ──────────
// `codex exec review --uncommitted` revisa los cambios sin confirmar de un repositorio git:
// en solo lectura, sin pedir aprobaciones y sin guardar la sesión (--ephemeral), con el
// proveedor de OpenAI y sin claves de API del entorno. Que la sesión sea la de ChatGPT se
// comprueba justo antes (chatgptLogin).
// Devuelve { ok, code, text (lo que escribe al final: el veredicto y los hallazgos), log
// (todo lo demás, para el registro), seconds, aborted }.
const REVIEW_TIMEOUT = 12 * 60 * 1000;
// Entorno para Codex al revisar: sin claves de API (así usa la cuenta de ChatGPT y no
// factura aparte) y sin buscar programas en la carpeta del proyecto (codex.cmd lanza
// «node» sin ruta).
function reviewEnv() {
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)) delete env[key];
  return env;
}

// ¿Tiene Codex ahora mismo la sesión de ChatGPT? Se mira justo antes de cada revisión.
function chatgptLogin() {
  const exe = findCodex();
  if (!exe) return Promise.resolve(false);
  return new Promise((resolve) => {
    const l = launcher(exe);
    execFile(l.command, [...l.prefix, 'login', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: l.shell, env: reviewEnv() }, (error, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      resolve(!error && /logged in/i.test(text) && !/not logged in/i.test(text) && /chatgpt/i.test(text));
    });
  });
}
const activeRuns = new Set(); // cómo parar cada ejecución de Codex en marcha
// Codex como asesor, aislado: sin la configuración del usuario (sus servidores MCP, que no
// respetan el modo solo lectura) y sin las funciones que actúan fuera de él.
const OFF_FEATURES = ['computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'image_generation'];
const ISOLATED = ['--ignore-user-config', '--ignore-rules', ...OFF_FEATURES.flatMap((f) => ['-c', `features.${f}=false`])];
// Un ajuste de texto de config.toml (section null: fuera de cualquier [tabla]), o null.
function userSetting(text, section, key) {
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table) { current = table[1].trim(); continue; }
    if (current !== section) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([\\w-]+)"`).exec(line);
    if (m) return m[1];
  }
  return null;
}

// Sin la configuración del usuario se pierden dos ajustes que hacen falta: dónde guarda su
// sesión (cli_auth_credentials_store) y la zona protegida de Windows ([windows] sandbox, sin
// la cual Codex bloquea hasta un «git status» y no puede leer el proyecto). Se pasan esos dos.
function isolation() {
  let text = '';
  try { text = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'); } catch { /* sin config.toml */ }
  const args = [...ISOLATED];
  const store = userSetting(text, null, 'cli_auth_credentials_store');
  if (store) args.push('-c', `cli_auth_credentials_store="${store}"`);
  const sandbox = userSetting(text, 'windows', 'sandbox');
  if (sandbox) args.push('-c', `windows.sandbox="${sandbox}"`);
  return args;
}

// Lanza Codex con estos argumentos y, si se da, este texto por la entrada estándar.
// Siempre sin claves de API del entorno; se para con `signal`, al pasar `timeout` o al
// cerrar la app (stopReviews). Devuelve { ok, code, text (salida), log (errores y
// progreso), seconds, aborted }.
function runCodex({ args, cwd, stdin = null, signal = null, timeout }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const exe = findCodex();
    if (!exe) { resolve({ ok: false, code: null, text: '', log: 'Codex no está instalado.', seconds: 0, aborted: false }); return; }
    if (signal && signal.aborted) { resolve({ ok: false, code: null, text: '', log: '', seconds: 0, aborted: true }); return; }
    const l = launcher(exe);
    // La ruta completa (sin nombres abreviados de Windows), que es la que la zona protegida reconoce.
    let dir = cwd;
    try { dir = fs.realpathSync.native(cwd); } catch { /* se usa tal cual */ }
    const child = spawn(l.command, [...l.prefix, ...args], { cwd: dir, env: reviewEnv(), stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, shell: l.shell });
    let text = '';
    let log = '';
    let settled = false;
    let aborted = false;
    // Con un .cmd, lo que corre es cmd.exe: hay que terminar también lo que lanzó.
    const kill = () => {
      try {
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill();
      } catch { /* ya había salido */ }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeRuns.delete(stop);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ...result, seconds: Math.round((Date.now() - start) / 1000), aborted });
    };
    const onAbort = () => { aborted = true; kill(); };
    const stop = () => onAbort();
    activeRuns.add(stop);
    const timer = setTimeout(() => { kill(); log += '\n[ClaudHome] Codex ha tardado demasiado y se ha cancelado'; }, timeout);
    if (signal) {
      if (signal.aborted) { onAbort(); } else signal.addEventListener('abort', onAbort);
    }
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    child.on('error', (err) => finish({ ok: false, code: null, text, log: `${log}\nNo se pudo ejecutar Codex: ${err.message}` }));
    child.on('close', (code) => finish({ ok: code === 0 && !aborted, code, text, log }));
    if (stdin !== null) {
      child.stdin.on('error', () => { /* Codex cerró la entrada antes de tiempo */ });
      child.stdin.end(stdin);
    }
  });
}

async function reviewChanges({ cwd, model, effort, signal, timeout = REVIEW_TIMEOUT }) {
  const args = ['exec', 'review', '--uncommitted', '--ephemeral', ...isolation(),
    '-c', 'history.persistence="none"', '-c', 'sandbox_mode="read-only"', '-c', 'model_provider="openai"'];
  // review_model manda sobre model en las revisiones: se fijan los dos.
  if (model) args.push('-c', `model="${model}"`, '-c', `review_model="${model}"`);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  const result = await runCodex({ args, cwd, signal, timeout });
  return { ...result, ...accessReport('', result.log) };
}

// ── Límites de uso de la cuenta ──────────────────────────────────────
// Huella de la sesión guardada de Codex (cambia al iniciar sesión con otra cuenta), para
// no mostrar el uso de una cuenta como si fuera de otra. null si no se sabe.
function authStamp() {
  try { return fs.statSync(path.join(codexHome(), 'auth.json')).mtimeMs; } catch { return null; }
}

// Lo que lleva gastado el plan de ChatGPT en Codex, sin gastar nada: se le pregunta a
// «codex app-server» por su protocolo (JSON-RPC por la entrada estándar) con
// account/rateLimits/read, y se cierra. Tarda alrededor de un segundo.

// De la respuesta de account/rateLimits/read: { pct, resetsAt (ms), windowMins, plan,
// reached, other } (other: la otra ventana, si la hay) o null.
function limitsFrom(result) {
  const limits = result && (result.rateLimits || (result.rateLimitsByLimitId && result.rateLimitsByLimitId.codex));
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter((w) => w && Number.isFinite(w.usedPercent));
  if (!windows.length) return null;
  // La ventana semanal si la hay; si no, la más larga.
  const main = windows.find((w) => w.windowDurationMins === 10080) || windows.reduce((a, b) => ((b.windowDurationMins || 0) > (a.windowDurationMins || 0) ? b : a));
  const other = windows.find((w) => w !== main) || null;
  const toWindow = (w) => ({ pct: w.usedPercent, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null, windowMins: w.windowDurationMins || null });
  const reached = Boolean(limits.rateLimitReachedType) || result.ordinaryUsageAllowed === false;
  // La ventana agotada (la que llega al 100 %), para decir cuándo se renueva esa y no otra;
  // si hay varias, la que se renueva más tarde (hasta entonces no se puede usar).
  const full = reached
    ? windows.filter((w) => w.usedPercent >= 100).sort((a, b) => (b.resetsAt || 0) - (a.resetsAt || 0))[0] || null
    : null;
  return {
    ...toWindow(main),
    plan: limits.planType || null,
    reached,
    reachedWindow: full ? toWindow(full) : null,
    other: other ? toWindow(other) : null,
  };
}

const killTree = (child, viaCmd) => {
  try {
    if (viaCmd && process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
  } catch { /* ya había salido */ }
};

function readLimits(timeout = 15000) {
  return new Promise((resolve) => {
    const exe = findCodex();
    if (!exe) { resolve(null); return; }
    const l = launcher(exe);
    let child;
    try {
      child = spawn(l.command, [...l.prefix, 'app-server'], { cwd: os.homedir(), env: reviewEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: l.shell });
    } catch { resolve(null); return; }
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeRuns.delete(stopRead);
      try { child.stdin.end(); } catch { /* ya cerrada */ }
      killTree(child, true); // también lo que lance (con npm, node lanza el Codex nativo)
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    const stopRead = () => finish(null); // al cerrar la app (stopReviews)
    activeRuns.add(stopRead);
    const send = (msg) => { try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { finish(null); } };
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1024 * 1024) { finish(null); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { finish(null); return; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' }); // sin parámetros: las versiones antiguas no los admiten
        } else if (msg.id === 2) {
          finish(msg.error ? null : limitsFrom(msg.result));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'claudhome', version: '1' } } });
  });
}

// Para todo lo de Codex en marcha (al cerrar la app).
function stopReviews() {
  for (const stop of [...activeRuns]) stop();
}

// ── Segunda opinión ──────────────────────────────────────────────────
// Codex como asesor de Claude: lee el proyecto en solo lectura y responde a lo que Claude
// le plantea (código, seguridad, planes, flujos de trabajo, un problema que no sale…).
// Nunca cambia nada: opina, y quien decide y actúa es Claude.
const OPINION_TIMEOUT = 9 * 60 * 1000; // por debajo de MCP_TOOL_TIMEOUT (10 min)
const MAX_PROMPT = 60000;
const SCOPES = { codigo: 'código', seguridad: 'seguridad', plan: 'plan o enfoque', flujo: 'flujo de trabajo', problema: 'un problema sin resolver', otro: 'otro' };
const clipText = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[… recortado]` : text);

// Lo que se le pide a Codex cuando Claude quiere una segunda opinión.
function opinionPrompt({ question, scope, files }) {
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 30);
  return [
    'Eres el asesor de Claude Code, otro agente que trabaja en este mismo proyecto, y te pide una segunda opinión.',
    'Trabajas en solo lectura: lee los archivos y haz las consultas que necesites para entender el proyecto, pero no cambies nada.',
    `Ámbito: ${SCOPES[scope] || SCOPES.otro}.`,
    `Lo que te plantea Claude:\n${clipText(String(question).trim(), MAX_PROMPT)}`,
    list.length ? `Archivos que Claude considera relevantes:\n${list.map((f) => `- ${f}`).join('\n')}` : '',
    'Da tu análisis con independencia: qué harías tú y por qué, riesgos o puntos ciegos, alternativas, y en qué discrepas del planteamiento de Claude.',
    'Sé concreto (archivos, funciones, líneas, comandos) y responde en español, en menos de 600 palabras.',
  ].filter(Boolean).join('\n\n');
}

// Lo que se le pide a Codex para criticar un plan antes de que el usuario lo vea.
function planPrompt({ request, plan }) {
  return [
    'Eres el segundo revisor de Claude Code, otro agente que trabaja en este mismo proyecto. Claude ha preparado el plan de abajo y todavía no se lo ha presentado al usuario.',
    'Trabajas en solo lectura: lee los archivos que necesites para comprobar el plan contra el proyecto real, pero no cambies nada.',
    request ? `Petición del usuario:\n${clipText(String(request).trim(), 4000)}` : '',
    `Plan de Claude:\n${clipText(String(plan).trim(), MAX_PROMPT)}`,
    'Critícalo con independencia: riesgos, pasos que faltan o sobran, supuestos que no se cumplen en este proyecto, alternativas mejores y cuestiones de seguridad si las hay.',
    'Sé concreto (archivos, funciones, comandos) y breve: como mucho 500 palabras, en español. Si el plan te parece bien, dilo y señala solo lo que mejorarías.',
  ].filter(Boolean).join('\n\n');
}

// Del registro de eventos de `codex exec --json`: el último mensaje de Codex y el error, si lo hubo.
function lastAgentMessage(stdout) {
  let message = '';
  let failure = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') message = String(event.item.text || '');
    if (event.type === 'error' || event.type === 'turn.failed') failure = String(event.message || (event.error && event.error.message) || failure);
  }
  return { message: message.trim(), failure };
}

// Pide a Codex una respuesta en solo lectura, en la carpeta del proyecto. Devuelve lo de
// runCodex con `text` = la respuesta de Codex y `failure` = su error, si lo hubo.
async function askCodex({ cwd, prompt, model, effort, signal, timeout = OPINION_TIMEOUT }) {
  // La carpeta va solo como directorio de trabajo: con -C y una ruta abreviada de Windows
  // (C:\Users\NOMBRE~1\…), la zona protegida le niega a Codex la lectura del proyecto.
  const args = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json', ...isolation(),
    '-c', 'history.persistence="none"', '-c', 'model_provider="openai"'];
  if (model) args.push('-c', `model="${model}"`);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push('-'); // la petición, por la entrada estándar: sin límites ni comillas que escapar
  const result = await runCodex({ args, cwd, stdin: prompt, signal, timeout });
  const { message, failure } = lastAgentMessage(result.text);
  // Las salidas de sus comandos van en el registro JSON (stdout): ahí se ven los bloqueos.
  return { ...result, ok: result.ok && Boolean(message), text: message, failure, ...accessReport(result.text, result.log) };
}

// La herramienta tal como la ve Claude en sus sesiones.
const OPINION_TOOL = {
  name: 'segunda_opinion',
  description: 'Pide a Codex (OpenAI, su modelo más capaz, razonando a fondo) una segunda opinión independiente. '
    + 'Codex es tu asesor en este proyecto: puede leer sus archivos, pero no cambia nada. '
    + 'Úsala ante decisiones importantes (arquitectura, enfoque de una tarea grande, cambios de seguridad o de infraestructura), '
    + 'y cuando prepares un plan para una tarea grande fuera del modo planificación: pídela con ámbito «plan» antes de empezar a ejecutarlo '
    + '(en modo planificación no hace falta: ClaudHome ya se lo envía a Codex al presentarlo), '
    + 'cuando lleves varios intentos sin resolver un problema, o cuando el usuario te la pida. No la uses para cosas sencillas. '
    + 'Tarda entre medio minuto y varios minutos y gasta del plan de ChatGPT del usuario. '
    + 'Devuelve su análisis: compáralo con el tuyo y dale al usuario una sola recomendación, señalando en qué coincidís y en qué no.',
  inputSchema: {
    type: 'object',
    properties: {
      pregunta: {
        type: 'string',
        description: 'Qué quieres que analice: el problema, la decisión o el plan, con el contexto necesario, lo que ya has pensado o probado y tu propuesta. Sin claves ni contraseñas.',
      },
      ambito: {
        type: 'string',
        enum: Object.keys(SCOPES),
        description: 'De qué trata: codigo, seguridad, plan, flujo (de trabajo), problema (algo que no sale) u otro.',
      },
      archivos: {
        type: 'array',
        items: { type: 'string' },
        description: 'Rutas de los archivos más relevantes, para que Codex empiece por ellos.',
      },
    },
    required: ['pregunta'],
  },
};

// Los hallazgos de una revisión: «- [P1] Título — ruta:líneas» y su explicación sangrada.
function parseReview(text) {
  const out = { summary: '', findings: [] };
  const raw = String(text || '').replace(/\r/g, '');
  // El resumen va antes del encabezado («Review comment:», «Full review comments:») o del primer hallazgo.
  const end = raw.search(/^(?:(?:Full )?review comments?:\s*$|- \[P\d\])/im);
  out.summary = (end >= 0 ? raw.slice(0, end) : raw).trim();
  let current = null;
  for (const line of raw.split('\n')) {
    const head = /^- \[P(\d)\]\s+(.+?)(?:\s+[—-]\s+(\S.*))?$/.exec(line);
    if (head) {
      current = { priority: Number(head[1]), title: head[2].trim(), location: (head[3] || '').trim(), body: '' };
      out.findings.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.body = `${current.body} ${line.trim()}`.trim();
    }
  }
  return out;
}

module.exports = {
  detect, generateImage, IMAGE_TOOL, reviewChanges, parseReview, stopReviews, chatgptLogin,
  askCodex, opinionPrompt, planPrompt, lastAgentMessage, OPINION_TOOL, SCOPES, ISOLATED, launcher, userSetting,
  readLimits, limitsFrom, authStamp, accessReport, sandboxConfigured, configPath,
};
