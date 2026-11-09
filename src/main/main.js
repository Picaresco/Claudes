// Proceso principal de Claudes: ventana, procesos de terminal, avisos y guardado.
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, clipboard, shell, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const pty = require('node-pty');
const { Store } = require('./store');
const { HookServer } = require('./hooks');
const { createMcp } = require('./mcp');
const sessions = require('./sessions');
const codex = require('./codex');

// Permite probar la app con una carpeta de datos aparte, sin tocar la real.
if (process.env.CLAUDES_USER_DATA) app.setPath('userData', path.resolve(process.env.CLAUDES_USER_DATA));
app.setAppUserModelId('com.claudes.app');

const DEV = !app.isPackaged;

let win = null;
let store = null;
let hookServer = null;
let summary = { working: 0 };
let closeApproved = false; // el usuario ya ha decidido cerrar aunque haya sesiones trabajando
let closeDialogOpen = false;
const ptys = new Map(); // id → { proc, killed, waiters, buffer, timer }
const liveNotifications = new Set();

const CLOSE_BUTTONS = ['Guardar estado y cerrar', 'Cerrar ya', 'Cancelar'];

const two = (n) => String(n).padStart(2, '0');
const dayStamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
const localStamp = (d = new Date()) => `${dayStamp(d)}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;

// ── Registro de depuración ─────────────────────────────────────────
// Con la depuración activada, cada sesión de Claude arranca con --debug-file y
// la app anota además su propia actividad (arranques, hooks, salidas, errores).
// Todo queda en <datos de la app>\logs y se borra solo pasada una semana.

const LOG_DAYS = 7;
const LOG_MAX_BYTES = 300 * 1024 * 1024;
let debugEnabled = true;
let appLogStream = null;
let appLogDay = '';
const tabNames = new Map(); // id de pestaña → nombre, para que los registros se lean bien
const tabLogs = new Map(); // id de pestaña → registro de Claude de su último arranque

const logsDir = () => path.join(app.getPath('userData'), 'logs');
const tabLabel = (id) => {
  const base = String(id).replace(/:sh$/, '');
  return `«${tabNames.get(base) || base}»${String(id).endsWith(':sh') ? ' (terminal extra)' : ''}`;
};

function appLog(text) {
  if (!debugEnabled) return;
  try {
    const now = new Date();
    const day = dayStamp(now);
    if (day !== appLogDay) {
      if (appLogStream) appLogStream.end();
      fs.mkdirSync(logsDir(), { recursive: true });
      appLogStream = fs.createWriteStream(path.join(logsDir(), `claudes-${day}.log`), { flags: 'a' });
      appLogStream.on('error', () => { /* disco lleno o sin permiso: se sigue sin registro */ });
      appLogDay = day;
    }
    const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    appLogStream.write(`${time} ${String(text).replace(/\r?\n/g, ' ⏎ ')}\n`);
  } catch { /* el registro nunca debe romper la app */ }
}

// Borra los registros de más de una semana y, si aun así ocupan demasiado, los más antiguos.
function cleanLogs() {
  let files = [];
  try {
    files = fs.readdirSync(logsDir())
      .filter((name) => name.endsWith('.log'))
      .map((name) => { const file = path.join(logsDir(), name); const st = fs.statSync(file); return { file, mtime: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return; }
  const limit = Date.now() - LOG_DAYS * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const entry of files) {
    total += entry.size;
    if (entry.mtime < limit || total > LOG_MAX_BYTES) {
      try { fs.unlinkSync(entry.file); } catch { /* en uso */ }
    }
  }
}

const safeFileName = (name) => (String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 40) || 'sesion');

// ── Codex ──────────────────────────────────────────────────────────

const CODEX_SERVER = 'codex-imagenes'; // nombre del servidor MCP: la herramienta se ve como mcp__codex-imagenes__generar_imagen
const tabFolders = new Map(); // id de pestaña → carpeta de su sesión
let codexState = { installed: false, loggedIn: false, mode: null, enabled: false, busy: 0, checkedAt: 0 };

// Solo se usa con sesión de ChatGPT: es la suscripción lo que se quiere aprovechar.
const codexUsable = () => codexState.installed && codexState.loggedIn && codexState.mode === 'chatgpt';

function codexInfo() {
  const { installed, loggedIn, mode, enabled, busy } = codexState;
  return { installed, loggedIn, mode, enabled, busy, usable: codexUsable(), active: enabled && codexUsable() };
}

async function refreshCodex() {
  const found = await codex.detect();
  codexState = { ...codexState, ...found, checkedAt: Date.now() };
  send('codex:changed', codexInfo());
  return codexInfo();
}

// Lo que ocurre cuando Claude llama a la herramienta «generar_imagen».
async function codexTool(tabId, _name, args) {
  const cwd = tabFolders.get(tabId);
  if (!cwd) throw new Error('Esta sesión ya no está abierta en Claudes.');
  if (!codexState.enabled) throw new Error('Las imágenes con Codex están desactivadas en Claudes (indicador «Codex» de la barra superior).');
  codexState.busy += 1;
  send('codex:changed', codexInfo());
  const startedAt = Date.now();
  appLog(`Codex: ${tabLabel(tabId)} pide una imagen (${String(args.descripcion || '').length} caracteres de descripción)`);
  try {
    const result = await codex.generateImage({
      description: args.descripcion,
      shape: ['cuadrada', 'horizontal', 'vertical'].includes(args.formato) ? args.formato : null,
      transparent: args.fondo_transparente === true,
      file: args.archivo,
      cwd,
      workDir: path.join(app.getPath('temp'), 'Claudes-codex'),
    });
    appLog(`Codex: imagen lista en ${Math.round((Date.now() - startedAt) / 1000)} s → ${result.path}`);
    return `Imagen generada con Codex y guardada en: ${result.path}`;
  } catch (err) {
    appLog(`Codex: fallo tras ${Math.round((Date.now() - startedAt) / 1000)} s: ${err && err.message}`);
    throw err;
  } finally {
    codexState.busy = Math.max(0, codexState.busy - 1);
    send('codex:changed', codexInfo());
  }
}

// Variables que una sesión de Claude Code pone a sus procesos hijos. Si Claudes
// se lanza desde dentro de una, no deben heredarse a las sesiones de las pestañas.
const SESSION_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'AI_AGENT', 'ELECTRON_RUN_AS_NODE',
];

const gitBash = [
  process.env.CLAUDE_CODE_GIT_BASH_PATH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
].find((p) => p && fs.existsSync(p)) || null;

function shellList() {
  const list = [
    { key: 'powershell', name: 'PowerShell' },
    { key: 'cmd', name: 'Símbolo del sistema (cmd)' },
  ];
  if (gitBash) list.push({ key: 'gitbash', name: 'Git Bash' });
  return list;
}

function shellCommand(kind) {
  if (kind === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [], env: {} };
  if (kind === 'gitbash' && gitBash) return { file: gitBash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } };
  return { file: 'powershell.exe', args: ['-NoLogo'], env: {} };
}

function childEnv(extra) {
  const env = { ...process.env };
  for (const name of SESSION_MARKERS) delete env[name];
  return { ...env, COLORTERM: 'truecolor', TERM_PROGRAM: 'Claudes', ...extra };
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ── Procesos de terminal ───────────────────────────────────────────

function spawnPty(id, file, args, options) {
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(options.cols | 0, 20),
    rows: Math.max(options.rows | 0, 5),
    cwd: options.cwd,
    env: options.env,
  });
  const entry = { proc, killed: false, waiters: [], buffer: '', timer: null };
  ptys.set(id, entry);

  const flush = () => {
    entry.timer = null;
    if (!entry.buffer) return;
    const data = entry.buffer;
    entry.buffer = '';
    send('pty:data', id, data);
  };
  // La salida se agrupa unos milisegundos para no saturar la interfaz.
  proc.onData((data) => {
    entry.buffer += data;
    if (!entry.timer) entry.timer = setTimeout(flush, 4);
  });
  proc.onExit(({ exitCode }) => {
    clearTimeout(entry.timer);
    flush();
    if (ptys.get(id) === entry) ptys.delete(id);
    appLog(`proceso de ${tabLabel(id)} termina con código ${exitCode}${entry.killed ? ' (cerrado por la app)' : ''}`);
    entry.waiters.forEach((done) => done());
    if (!entry.killed) send('pty:exit', id, exitCode);
  });
}

// Termina un proceso y espera a que haya salido (o a un máximo de 2 s).
function killPty(id) {
  const entry = ptys.get(id);
  if (!entry) return Promise.resolve();
  entry.killed = true;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    entry.waiters.push(() => { clearTimeout(timer); resolve(); });
    try { entry.proc.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

function killAll() {
  for (const entry of ptys.values()) {
    entry.killed = true;
    try { entry.proc.kill(); } catch { /* ya había salido */ }
  }
  ptys.clear();
}

function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

async function createPty(o) {
  if (!o || typeof o.id !== 'string' || typeof o.cwd !== 'string') return { ok: false, error: 'Petición no válida.' };
  let isDir = false;
  try { isDir = fs.statSync(o.cwd).isDirectory(); } catch { /* no existe */ }
  if (!isDir) return { ok: false, error: `La carpeta no existe: ${o.cwd}` };

  await killPty(o.id);
  const base = { cwd: o.cwd, cols: o.cols, rows: o.rows };

  if (o.kind === 'shell') {
    const sh = shellCommand(o.shell);
    spawnPty(o.id, sh.file, sh.args, { ...base, env: childEnv(sh.env) });
    appLog(`terminal extra de ${tabLabel(o.id)} arranca: ${path.basename(sh.file)} en ${o.cwd}`);
    return { ok: true };
  }

  if (typeof o.name === 'string' && o.name) tabNames.set(o.id, o.name);
  const exe = sessions.findClaude();
  if (!exe) {
    appLog(`sesión ${tabLabel(o.id)}: no se encuentra claude en el equipo`);
    return { ok: false, error: 'No encuentro Claude Code en este equipo (el comando «claude» no está instalado o no está en el PATH).' };
  }
  const chosen = sessions.plan({ cwd: o.cwd, sessionId: o.sessionId, mode: o.mode, exclude: o.exclude });
  const args = [...chosen.args, '--settings', hookServer.settingsFile(o.id)];
  const extraEnv = { CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1', CLAUDES_TAB_ID: o.id };

  // Con las imágenes de Codex activadas, la sesión arranca con la herramienta «generar_imagen».
  if (codexState.enabled && !codexState.checkedAt) await refreshCodex();
  const withCodex = codexState.enabled && codexUsable();
  tabFolders.set(o.id, o.cwd);
  if (withCodex) {
    args.push('--mcp-config', hookServer.mcpFile(o.id, CODEX_SERVER));
    // Una imagen puede tardar más que el límite por defecto de una herramienta.
    if (!process.env.MCP_TOOL_TIMEOUT) extraEnv.MCP_TOOL_TIMEOUT = String(10 * 60 * 1000);
  }

  // Registro de depuración de Claude Code para este arranque.
  let logFile = null;
  if (debugEnabled) {
    fs.mkdirSync(logsDir(), { recursive: true });
    logFile = path.join(logsDir(), `${localStamp()}-${safeFileName(o.name)}.log`);
    args.push('--debug-file', logFile);
    tabLogs.set(o.id, logFile);
  }
  appLog(`sesión ${tabLabel(o.id)} arranca: ${chosen.resumed ? 'retoma' : 'conversación nueva'} ${chosen.sessionId} en ${o.cwd}`
    + `${withCodex ? ' · con Codex' : ''}${logFile ? ` · registro ${path.basename(logFile)}` : ''} · ${path.basename(exe)}`);
  const env = childEnv(extraEnv);
  if (/\.(cmd|bat)$/i.test(exe)) {
    // Instalación por npm: claude es un .cmd y hay que lanzarlo a través de cmd.exe.
    const line = `/d /s /c "${[exe, ...args].map(quoteForCmd).join(' ')}"`;
    spawnPty(o.id, process.env.ComSpec || 'cmd.exe', line, { ...base, env });
  } else {
    spawnPty(o.id, exe, args, { ...base, env });
  }
  return { ok: true, sessionId: chosen.sessionId, resumed: chosen.resumed, codex: withCodex };
}

// ── Portapapeles ───────────────────────────────────────────────────

const pasteDir = () => path.join(app.getPath('temp'), 'Claudes-pegado');

// Una imagen copiada (una captura, «Copiar imagen» del navegador…) se guarda
// como archivo para poder pegar su ruta, igual que un archivo arrastrado.
function savePastedImage(buffer) {
  const stamp = localStamp();
  fs.mkdirSync(pasteDir(), { recursive: true });
  let file = path.join(pasteDir(), `imagen-${stamp}.png`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(pasteDir(), `imagen-${stamp}-${n}.png`);
  fs.writeFileSync(file, buffer);
  return file;
}

// Las imágenes pegadas ya viajaron con su mensaje: pasada una semana se borran.
function cleanPastedImages() {
  const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let names = [];
  try { names = fs.readdirSync(pasteDir()); } catch { return; }
  for (const name of names) {
    const file = path.join(pasteDir(), name);
    try { if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file); } catch { /* en uso */ }
  }
}

// Qué hay que pegar: archivos copiados en el Explorador, si no texto, si no una imagen.
async function readClipboard() {
  const result = { files: [], text: '', imagePath: null };
  let items = [];
  try { items = await clipboard.read(); } catch { /* portapapeles vacío u ocupado */ }

  for (const item of items) {
    if (!item.types.includes('text/uri-list')) continue;
    try {
      const blob = await item.getType('text/uri-list');
      const list = Buffer.from(await blob.arrayBuffer()).toString('utf8');
      for (const line of list.split(/\r?\n/)) {
        const uri = line.trim();
        if (!/^file:/i.test(uri)) continue;
        try { result.files.push(fileURLToPath(uri)); } catch { /* URI que no es una ruta local */ }
      }
    } catch { /* formato no legible */ }
  }
  if (result.files.length) return result;

  try { result.text = await clipboard.readText(); } catch { /* sin texto */ }
  if (result.text) return result;

  for (const item of items) {
    if (!item.types.includes('image/png')) continue;
    try {
      const blob = await item.getType('image/png');
      result.imagePath = savePastedImage(Buffer.from(await blob.arrayBuffer()));
      break;
    } catch (err) {
      console.error('No se pudo guardar la imagen del portapapeles:', err.message);
    }
  }
  return result;
}

// ── Ventana ────────────────────────────────────────────────────────

function initialBounds() {
  const saved = store.get('window', null);
  const fallback = { width: 1360, height: 860 };
  if (!saved || !(saved.width > 0) || !(saved.height > 0)) return fallback;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => (
    saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80
    && saved.y >= a.y - 20 && saved.y < a.y + a.height - 80
  ));
  const size = { width: saved.width, height: saved.height };
  return onScreen ? { ...size, x: saved.x, y: saved.y } : size;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Claudes',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    backgroundColor: '#0C0E11',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0C0E11', symbolColor: '#A9AFB9', height: 50 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (store.get('window', {}).maximized) win.maximize();

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => (process.env.CLAUDES_SHOT ? win.showInactive() : win.show()));

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      store.set('window', { ...win.getNormalBounds(), maximized: win.isMaximized() });
    }, 400);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('focus', () => win.flashFrame(false));

  win.on('close', (event) => {
    if (closeApproved || summary.working === 0) { store.flush(); return; }
    // Hay sesiones trabajando: se pregunta antes de cerrar.
    event.preventDefault();
    if (closeDialogOpen) return;
    closeDialogOpen = true;
    const n = summary.working;
    const ask = (DEV && process.env.CLAUDES_AUTO_CONFIRM)
      ? () => Promise.resolve({ response: 0 }) // solo para pruebas automáticas
      : (options) => dialog.showMessageBox(win, options);
    ask({
      type: 'question',
      message: n === 1 ? 'Claude está trabajando en una sesión' : `Claude está trabajando en ${n} sesiones`,
      detail: '«Guardar estado y cerrar» pide a Claude que pare y deje anotado por dónde iba, para retomarlo al volver. '
        + '«Cerrar ya» interrumpe el trabajo en el punto en que esté; la conversación queda guardada igualmente.',
      buttons: CLOSE_BUTTONS,
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }).then(({ response }) => {
      closeDialogOpen = false;
      if (!win) return;
      if (response === 1) { closeApproved = true; win.close(); }
      else if (response === 0) send('app:wrapup'); // la interfaz avisa con app:closeNow al terminar
    });
  });
  win.on('closed', () => { win = null; });

  // La interfaz es un único documento local: ni ventanas nuevas ni navegación.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // Si la interfaz se cae o deja de responder, que quede constancia.
  win.webContents.on('render-process-gone', (_event, details) => appLog(`la interfaz se ha caído: ${details.reason} (código ${details.exitCode})`));
  win.on('unresponsive', () => appLog('la ventana ha dejado de responder'));
  win.on('responsive', () => appLog('la ventana vuelve a responder'));

  if (DEV) devTools();
}

// Ayudas solo para desarrollo: mensajes de la interfaz en la consola y captura
// de la ventana a un PNG (CLAUDES_SHOT) tras ejecutar un guion (CLAUDES_TEST_JS).
function devTools() {
  win.webContents.on('console-message', (event, ...legacy) => {
    const message = event && event.message !== undefined ? event.message : legacy[1];
    const level = event && event.level !== undefined ? event.level : legacy[0];
    console.log(`[interfaz:${level}] ${message}`);
  });
  const shot = process.env.CLAUDES_SHOT;
  if (!shot) return;
  const delay = Number(process.env.CLAUDES_SHOT_DELAY) || 4000;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (process.env.CLAUDES_TEST_JS) {
          const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.CLAUDES_TEST_JS, 'utf8'), true);
          if (result !== undefined) console.log('[guion]', JSON.stringify(result));
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
        console.log('[captura]', shot);
      } catch (err) {
        console.error('[captura] error:', err.message);
      }
      if (process.env.CLAUDES_SHOT_QUIT) { summary = { working: 0 }; app.quit(); }
    }, delay);
  });
}

// ── Comunicación con la interfaz ───────────────────────────────────

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    home: os.homedir(),
    shells: shellList(),
    claudeFound: Boolean(sessions.findClaude()),
    windowsBuild: Number(os.release().split('.')[2]) || 0,
  }));

  ipcMain.handle('state:load', () => store.get('ui', null));
  ipcMain.on('state:save', (_e, state) => {
    if (state && typeof state === 'object' && Array.isArray(state.tabs)) store.set('ui', state);
  });

  ipcMain.handle('pty:create', async (_e, options) => {
    try {
      return await createPty(options);
    } catch (err) {
      return { ok: false, error: `No se pudo iniciar: ${err && err.message ? err.message : err}` };
    }
  });
  ipcMain.on('pty:write', (_e, id, data) => {
    const entry = ptys.get(id);
    if (entry && typeof data === 'string') entry.proc.write(data);
  });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => {
    const entry = ptys.get(id);
    if (!entry || !(cols >= 2) || !(rows >= 1)) return;
    try { entry.proc.resize(cols | 0, rows | 0); } catch { /* el proceso acaba de salir */ }
  });
  ipcMain.handle('pty:kill', async (_e, id) => {
    await killPty(id);
    if (typeof id === 'string' && !id.includes(':')) {
      hookServer.forget(id);
      tabFolders.delete(id);
      tabNames.delete(id);
      tabLogs.delete(id);
    }
  });

  // Registro de depuración: estado, interruptor y acceso a los archivos.
  const debugInfo = () => ({ enabled: debugEnabled, dir: logsDir() });
  ipcMain.handle('debug:get', debugInfo);
  ipcMain.handle('debug:set', (_e, on) => {
    if (debugEnabled && !on) appLog('registro de depuración desactivado');
    debugEnabled = Boolean(on);
    store.set('debugLogs', debugEnabled);
    if (debugEnabled) appLog('registro de depuración activado');
    return debugInfo();
  });
  // Abre el registro de Claude de una pestaña; sin pestaña (o sin registro), la carpeta.
  ipcMain.on('debug:open', (_e, tabId) => {
    const file = typeof tabId === 'string' ? tabLogs.get(tabId) : null;
    if (file && fs.existsSync(file)) { shell.openPath(file); return; }
    fs.mkdirSync(logsDir(), { recursive: true });
    shell.openPath(logsDir());
  });
  ipcMain.on('log', (_e, text) => appLog(`interfaz: ${String(text).slice(0, 600)}`));

  ipcMain.handle('codex:status', async (_e, refresh) => {
    // Como mucho una comprobación por minuto, salvo que se pida expresamente.
    if (refresh || Date.now() - codexState.checkedAt > 60000) return refreshCodex();
    return codexInfo();
  });
  ipcMain.handle('codex:setEnabled', async (_e, on) => {
    await refreshCodex();
    codexState.enabled = Boolean(on) && codexUsable();
    store.set('codexImages', codexState.enabled);
    send('codex:changed', codexInfo());
    return codexInfo();
  });

  ipcMain.on('status:summary', (_e, value) => {
    summary = { working: Math.max(0, Number(value && value.working) || 0) };
  });

  ipcMain.on('notify', (_e, o) => {
    if (!o || !Notification.isSupported()) return;
    const notification = new Notification({ title: String(o.title || 'Claudes'), body: String(o.body || ''), silent: true });
    liveNotifications.add(notification); // sin esta referencia, el clic se pierde
    notification.on('click', () => { showWindow(); send('notify:click', o.tabId); });
    notification.on('close', () => liveNotifications.delete(notification));
    notification.on('failed', (_event, error) => {
      liveNotifications.delete(notification);
      console.error('La notificación no se pudo mostrar:', error);
      appLog(`notificación «${o.title}»: Windows no la ha mostrado (${error})`);
    });
    notification.on('show', () => {
      if (DEV) console.log('[notificación mostrada]', o.title);
      appLog(`notificación mostrada: «${o.title}»`);
    });
    notification.show();
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  ipcMain.handle('fs:isDir', (_e, target) => {
    try { return typeof target === 'string' && fs.statSync(target).isDirectory(); } catch { return false; }
  });

  ipcMain.handle('dialog:pickFolder', async (_e, startAt) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Elige la carpeta de la sesión',
      defaultPath: typeof startAt === 'string' && fs.existsSync(startAt) ? startAt : os.homedir(),
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:confirm', async (_e, o) => {
    if (DEV && process.env.CLAUDES_AUTO_CONFIRM) return true; // solo para pruebas automáticas
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      message: String(o.message || ''),
      detail: String(o.detail || ''),
      buttons: [String(o.confirmLabel || 'Aceptar'), 'Cancelar'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  });

  ipcMain.handle('menu:tab', (_e, o) => new Promise((resolve) => {
    let settled = false;
    const pick = (value) => () => { settled = true; resolve(value); };
    const menu = Menu.buildFromTemplate([
      { label: 'Cambiar nombre', accelerator: 'F2', registerAccelerator: false, click: pick('rename') },
      {
        label: 'Color',
        submenu: (o.colors || []).map((c) => ({
          label: c.name, type: 'radio', checked: c.key === o.color, click: pick(`color:${c.key}`),
        })),
      },
      { type: 'separator' },
      { label: 'Nueva conversación', click: pick('newconv') },
      { label: 'Abrir carpeta en el Explorador', click: pick('folder') },
      { type: 'separator' },
      {
        label: 'Ver el registro de depuración de esta sesión',
        enabled: Boolean(tabLogs.get(o.id) && fs.existsSync(tabLogs.get(o.id))),
        click: pick('log'),
      },
      { label: 'Abrir la carpeta de registros', click: pick('logs') },
      { type: 'separator' },
      { label: 'Cerrar pestaña', accelerator: 'Ctrl+Shift+W', registerAccelerator: false, click: pick('close') },
    ]);
    // El aviso de cierre del menú puede llegar antes que el de la opción elegida.
    menu.popup({ window: win, callback: () => setTimeout(() => { if (!settled) resolve(null); }, 150) });
  }));

  ipcMain.handle('dialog:choose', async (_e, o) => {
    if (DEV && process.env.CLAUDES_AUTO_CONFIRM) return 0; // solo para pruebas automáticas
    const buttons = Array.isArray(o.buttons) ? o.buttons.map(String) : ['Aceptar', 'Cancelar'];
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      message: String(o.message || ''),
      detail: String(o.detail || ''),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    return result.response;
  });

  ipcMain.on('app:closeNow', () => {
    closeApproved = true;
    if (win) win.close();
  });

  ipcMain.handle('clipboard:read', readClipboard);
  ipcMain.on('clipboard:write', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text).catch(() => { /* portapapeles ocupado */ });
  });

  if (DEV) {
    ipcMain.on('dev:input', (_e, event) => {
      if (win && event && typeof event === 'object') win.webContents.sendInputEvent(event);
    });
  }
  ipcMain.on('shell:openPath', (_e, target) => {
    if (typeof target !== 'string') return;
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    else if (fs.existsSync(target)) shell.openPath(target);
  });
}

// ── Arranque ───────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // los atajos del menú por defecto chocarían con la terminal
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
    debugEnabled = store.get('debugLogs', true) !== false; // activado salvo que se haya apagado
    cleanLogs();
    appLog(`──── Claudes ${app.getVersion()} arranca (Electron ${process.versions.electron}, ${app.isPackaged ? 'ejecutable' : 'desde el código'}) ────`);
    process.on('uncaughtException', (err) => {
      appLog(`ERROR sin capturar en el proceso principal: ${(err && err.stack) || err}`);
      dialog.showErrorBox('Error en Claudes', String((err && err.stack) || err));
    });
    process.on('unhandledRejection', (reason) => {
      appLog(`promesa rechazada sin capturar en el proceso principal: ${(reason && reason.stack) || reason}`);
    });
    hookServer = new HookServer(path.join(app.getPath('userData'), 'hooks'), (tabId, event) => {
      if (DEV && process.env.CLAUDES_LOG_HOOKS) console.log('[hook]', event.event, event.prompt ? `«${event.prompt}»` : '');
      appLog(`hook de ${tabLabel(tabId)}: ${event.event}${event.toolName ? ` ${event.toolName}` : ''}${event.notificationType ? ` ${event.notificationType}` : ''}`);
      send('hook', tabId, event);
    });
    // Solo para pruebas: los mensajes se bloquean antes de llegar al modelo (no gastan tokens).
    hookServer.blockPrompts = DEV && Boolean(process.env.CLAUDES_BLOCK_PROMPTS);
    hookServer.mcp = createMcp({
      name: 'claudes-codex',
      version: app.getVersion(),
      tools: [codex.IMAGE_TOOL],
      callTool: codexTool,
    });
    const innerMcp = hookServer.mcp;
    hookServer.mcp = (tabId, body) => {
      const methods = [].concat(body).map((m) => (m && m.method) || '?').join(', ');
      if (DEV && process.env.CLAUDES_LOG_HOOKS) console.log('[mcp]', methods);
      appLog(`MCP de ${tabLabel(tabId)}: ${methods}`);
      return innerMcp(tabId, body);
    };
    await hookServer.start();
    cleanPastedImages();
    codexState.enabled = store.get('codexImages', false) === true;
    refreshCodex().catch(() => { /* se reintentará al consultar el estado */ });
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => {
    killAll();
    if (hookServer) hookServer.stop();
    if (store) store.flush();
    app.quit();
  });
}
