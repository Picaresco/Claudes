// Proceso principal de Claudes: arranque, sesiones de las pestañas y comunicación
// con la interfaz. Cada pieza vive en su módulo: la ventana (window.js), los procesos
// de terminal (ptys.js), las consolas y su entorno (shells.js), el portapapeles
// (clipboard.js), el estilo de las respuestas y los plugins (style.js), el registro de
// depuración (applog.js) y lo que se sabe de cada pestaña (tabs.js).
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, clipboard, shell, screen, net, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Store } = require('./store');
const { HookServer } = require('./hooks');
const { createMcp } = require('./mcp');
const sessions = require('./sessions');
const codex = require('./codex');
const { Updater } = require('./updater');
const { createPreview } = require('./preview');
const { createContext } = require('./context');
const { NetLog, OWN_MCP } = require('./netlog');
const { Limits } = require('./limits');
const { Growth, EDIT_TOOLS } = require('./growth');
const { createReview } = require('./review');
const { Secrets } = require('./secrets');
const { Tabs } = require('./tabs');
const { createAppLog, localStamp, safeFileName } = require('./applog');
const { gitBash, shellList, shellCommand, childEnv, quoteForCmd } = require('./shells');
const { createPtys } = require('./ptys');
const { createClipboard } = require('./clipboard');
const { createWindowManager } = require('./window');
const { createStyle } = require('./style');
const { userSettings, usageFrom } = require('./claude-config');

// Permite probar la app con una carpeta de datos aparte, sin tocar la real.
if (process.env.CLAUDES_USER_DATA) app.setPath('userData', path.resolve(process.env.CLAUDES_USER_DATA));
app.setAppUserModelId('com.claudes.app');

const DEV = !app.isPackaged;

let store = null;
let wm = null; // la ventana (window.js)
let hookServer = null;
let updater = null;
let previewer = null;
let contexts = null; // contexto del proyecto de cada pestaña (context.js)
let netlog = null; // «Log»: lo que ha visto Claude y lo que sale hacia internet (netlog.js)
let limits = null; // límites de uso del plan y tokens gastados en cada periodo (limits.js)
let growth = null; // aviso de archivos de código que crecen mucho (growth.js)
let review = null; // Codex como segundo revisor del código (review.js)
let secrets = null; // aviso de claves y contraseñas escritas en los archivos (secrets.js)
// Avisos tras una edición: el hook espera 2 s; cada aviso tiene 1,5 s para decidir (si se
// pasa, no anota nada) y a los 1,7 s se contesta con lo que haya.
const NOTICE_BUDGET = 1500;
const NOTICE_LIMIT = 1700;
const liveNotifications = new Set();

const logsDir = () => path.join(app.getPath('userData'), 'logs');
const logger = createAppLog(logsDir); // registro de depuración (applog.js)
const appLog = logger.log;
const tabs = new Tabs(); // lo que se sabe de cada pestaña (tabs.js)
const tabLabel = (id) => tabs.label(id);

// Avisa a la interfaz por un canal (cuando ya hay ventana).
const send = (channel, ...args) => { if (wm) wm.send(channel, ...args); };

const ptys = createPtys({ pty, send, log: appLog, label: tabLabel });
const pasteboard = createClipboard({ clipboard, dir: () => path.join(app.getPath('temp'), 'Claudes-pegado'), stamp: localStamp });
// Plugins de las sesiones e interruptor «Resumido» (style.js).
const style = createStyle({
  srcDir: path.join(__dirname, '..', 'plugins'),
  dstDir: path.join(app.getPath('userData'), 'plugins'),
  userSettings,
  gitBash,
  tabs,
  log: appLog,
  label: tabLabel,
});

// ── Codex ──────────────────────────────────────────────────────────

// Servidor MCP de la app para Codex: las herramientas se ven como mcp__claudhome-codex__segunda_opinion
// y mcp__claudhome-codex__generar_imagen.
const CODEX_SERVER = OWN_MCP;
let codexState = { installed: false, loggedIn: false, mode: null, enabled: false, busy: 0, checkedAt: 0 };

// Solo se usa con sesión de ChatGPT: es la suscripción lo que se quiere aprovechar.
const codexUsable = () => codexState.installed && codexState.loggedIn && codexState.mode === 'chatgpt';
// El asesor (segunda opinión, planes y revisión) necesita además una versión reciente de Codex.
const advisorUsable = () => codexUsable() && codexState.advisor !== false;

function codexInfo() {
  const { installed, loggedIn, mode, enabled, busy, advisor, limits } = codexState;
  return { installed, loggedIn, mode, enabled, busy, advisor: advisor !== false, usable: codexUsable(), active: enabled && codexUsable(), limits: limits || null };
}

async function refreshCodex() {
  const found = await codex.detect();
  codexState = { ...codexState, ...found, checkedAt: Date.now() };
  // El dato de uso es de una cuenta: sin sesión, o si la sesión ha cambiado, no vale.
  if (!codexUsable() || (codexState.limits && codexState.limits.authStamp !== codex.authStamp())) codexState.limits = null;
  send('codex:changed', codexInfo());
  refreshCodexLimits();
  return codexInfo();
}

// Uso del plan de ChatGPT en Codex (barra inferior): al detectarlo, cada 10 minutos y poco
// después de cada trabajo de Codex. No gasta nada.
let limitsBusy = false;
let limitsAgain = false; // otra lectura pedida mientras había una en curso
let limitsSoon = null;
async function refreshCodexLimits() {
  if (!codexUsable()) return;
  if (limitsBusy) { limitsAgain = true; return; }
  limitsBusy = true;
  try {
    const limits = await codex.readLimits();
    if (limits) codexState.limits = { ...limits, checkedAt: Date.now(), stale: false, authStamp: codex.authStamp() };
    else if (codexState.limits) codexState.limits = { ...codexState.limits, stale: true }; // se muestra con su hora
    send('codex:changed', codexInfo());
  } finally {
    limitsBusy = false;
    if (limitsAgain) { limitsAgain = false; refreshCodexLimits(); }
  }
}
function codexLimitsSoon() {
  clearTimeout(limitsSoon);
  limitsSoon = setTimeout(refreshCodexLimits, 4000);
}
// Cada 10 minutos, también la sesión (por si se inicia o se cierra desde un terminal).
setInterval(() => { refreshCodex().catch(() => { /* se intentará la próxima vez */ }); }, 10 * 60 * 1000);

// Lo que ocurre cuando Claude llama a la herramienta «generar_imagen».
async function codexTool(tabId, _name, args) {
  const cwd = (tabs.get(tabId) || {}).folder;
  if (!cwd) throw new Error('Esta sesión ya no está abierta en ClaudHome.');
  if (!codexState.enabled) throw new Error('Las imágenes con Codex están desactivadas en ClaudHome (indicador «Codex» de la barra superior).');
  codexState.busy += 1;
  send('codex:changed', codexInfo());
  const startedAt = Date.now();
  appLog(`Codex: ${tabLabel(tabId)} pide una imagen (${String(args.descripcion || '').length} caracteres de descripción)`);
  if (netlog) netlog.record({ tabId, kind: 'imagen', target: 'Descripción de una imagen', detail: `${String(args.descripcion || '').length} caracteres`, dest: 'OpenAI (Codex)', external: true });
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
    codexLimitsSoon();
    send('codex:changed', codexInfo());
  }
}

// ── Dictado por voz ────────────────────────────────────────────────
// Cada sesión arranca con el dictado de Claude Code activado en modo «mantener»:
// Claude graba mientras se mantiene pulsada la barra espaciadora y para al soltarla.
// Claude Code reconoce la tecla mantenida por sus repeticiones, así que el botón
// del micrófono de la interfaz decide si esas repeticiones le llegan. Apagado, una
// pulsación larga es un solo espacio y nunca se graba. Como no hace falta reiniciar
// nada, el botón vale al momento para todas las pestañas.

let voiceEnabled = false;

// Ajustes de Claude Code que Claudes añade a la sesión de una pestaña. `allow` son
// las reglas para leer sin preguntar los documentos del contexto del proyecto.
function sessionSettings(tabId, allow = []) {
  const mine = userSettings();
  // Dictado activado y los plugins integrados que toquen (style.js).
  const settings = { voice: { enabled: true, mode: 'hold' }, ...style.sessionSettings(mine) };
  // Sin idioma, Claude Code dicta en inglés. Ese mismo ajuste fija el idioma de las
  // respuestas; si el usuario ya ha elegido uno, se respeta el suyo.
  if (!(typeof mine.language === 'string' && mine.language.trim())) settings.language = 'spanish';
  if (allow.length) settings.permissions = { allow };
  // Línea de estado que solo le pasa a la app el uso del contexto (no muestra nada).
  // Si el usuario tiene la suya, se respeta y la pestaña se queda sin indicador.
  if (!mine.statusLine) settings.statusLine = { type: 'command', command: hookServer.statusLineCommand(tabId), padding: 0 };
  return settings;
}

// ── Actualización ──────────────────────────────────────────────────
// La interfaz enseña los cambios y solo con «Update» se genera la versión nueva,
// en segundo plano. Al terminar, Claudes se reinicia para instalarla.

// Cierra Claudes por el camino normal (pregunta si hay sesiones trabajando) y,
// al salir, el instalador pone la versión nueva y vuelve a abrirlo. Si en esa
// pregunta se elige «Cancelar», la versión queda lista y se instala al cerrar.
function restartToUpdate() {
  if (!updater || updater.state.status !== 'ready') return;
  updater.relaunch = true;
  if (wm) wm.close();
}

// ── Sesiones de las pestañas ───────────────────────────────────────

async function createPty(o) {
  if (!o || typeof o.id !== 'string' || typeof o.cwd !== 'string') return { ok: false, error: 'Petición no válida.' };
  let isDir = false;
  try { isDir = fs.statSync(o.cwd).isDirectory(); } catch { /* no existe */ }
  if (!isDir) return { ok: false, error: `La carpeta no existe: ${o.cwd}` };

  await ptys.kill(o.id);
  const base = { cwd: o.cwd, cols: o.cols, rows: o.rows };

  if (o.kind === 'shell') {
    const sh = shellCommand(o.shell);
    ptys.spawn(o.id, sh.file, sh.args, { ...base, env: childEnv(sh.env) });
    appLog(`terminal extra de ${tabLabel(o.id)} arranca: ${path.basename(sh.file)} en ${o.cwd}`);
    return { ok: true };
  }

  const tab = tabs.ensure(o.id);
  if (typeof o.name === 'string' && o.name) tab.name = o.name;
  const exe = sessions.findClaude();
  if (!exe) {
    appLog(`sesión ${tabLabel(o.id)}: no se encuentra claude en el equipo`);
    return { ok: false, error: 'No encuentro Claude Code en este equipo (el comando «claude» no está instalado o no está en el PATH).' };
  }
  const chosen = sessions.plan({ cwd: o.cwd, sessionId: o.sessionId, mode: o.mode, exclude: o.exclude });
  // Contexto del proyecto de la pestaña: resumen para Claude y permiso para leer sus documentos.
  let ctx = { promptFile: null, allow: [] };
  try {
    ctx = await contexts.prepare(o.id, o.name, o.context);
  } catch (err) {
    appLog(`contexto de ${tabLabel(o.id)}: no se pudo preparar (${err.message})`);
  }
  const args = [...chosen.args, '--settings', hookServer.settingsFile(o.id, sessionSettings(o.id, ctx.allow))];
  // Solo al ejecutar desde el código: arrancar en un modo de permisos (p. ej. «plan»), para las pruebas.
  if (DEV && process.env.CLAUDES_TEST_PERMISSION_MODE) args.push('--permission-mode', process.env.CLAUDES_TEST_PERMISSION_MODE);
  tab.usage = null;
  if (ctx.promptFile) args.push('--append-system-prompt-file', ctx.promptFile);
  const plugins = style.sessionPlugins();
  for (const plugin of plugins) args.push('--plugin-dir', plugin.dir);
  style.started(o.id, plugins);
  const extraEnv = { CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1', CLAUDES_TAB_ID: o.id };

  // Con Codex instalado, la sesión arranca con las herramientas de la app: «segunda_opinion»
  // (que se niega si no hay sesión de ChatGPT o el asesor está apagado: así sirve aunque se
  // inicie sesión después) y «generar_imagen» si las imágenes están activadas.
  if (!codexState.checkedAt) await refreshCodex();
  const withMcp = Boolean(codexState.installed);
  const withCodex = withMcp && codexState.enabled; // con la herramienta de imágenes
  tab.folder = o.cwd;
  tab.session = chosen.sessionId;
  if (withMcp) {
    args.push('--mcp-config', hookServer.mcpFile(o.id, CODEX_SERVER));
    // Una imagen o una segunda opinión pueden tardar más que el límite por defecto de una herramienta.
    if (!process.env.MCP_TOOL_TIMEOUT) extraEnv.MCP_TOOL_TIMEOUT = String(10 * 60 * 1000);
  }

  // Registro de depuración de Claude Code para este arranque.
  let logFile = null;
  if (logger.enabled) {
    fs.mkdirSync(logsDir(), { recursive: true });
    logFile = path.join(logsDir(), `${localStamp()}-${safeFileName(o.name)}.log`);
    args.push('--debug-file', logFile);
    tab.log = logFile;
  }
  appLog(`sesión ${tabLabel(o.id)} arranca: ${chosen.resumed ? 'retoma' : 'conversación nueva'} ${chosen.sessionId} en ${o.cwd}`
    + `${withMcp ? ` · con Codex (segunda opinión${withCodex ? ' e imágenes' : ''})` : ''}${ctx.promptFile ? ` · con contexto (${ctx.allow.length} permisos de lectura)` : ''}`
    + `${plugins.length ? ` · plugins: ${plugins.map((p) => p.name).join(', ')}` : ''}`
    + `${logFile ? ` · registro ${path.basename(logFile)}` : ''} · ${path.basename(exe)}`);
  const env = childEnv(extraEnv);
  if (/\.(cmd|bat)$/i.test(exe)) {
    // Instalación por npm: claude es un .cmd y hay que lanzarlo a través de cmd.exe.
    const line = `/d /s /c "${[exe, ...args].map(quoteForCmd).join(' ')}"`;
    ptys.spawn(o.id, process.env.ComSpec || 'cmd.exe', line, { ...base, env });
  } else {
    ptys.spawn(o.id, exe, args, { ...base, env });
  }
  return { ok: true, sessionId: chosen.sessionId, resumed: chosen.resumed, codex: withCodex };
}

// ── Comunicación con la interfaz ───────────────────────────────────

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    home: os.homedir(),
    shells: shellList(),
    claudeFound: Boolean(sessions.findClaude()),
    windowsBuild: Number(os.release().split('.')[2]) || 0,
    dev: DEV,
    // Minutos sin actividad tras los que se duerme una sesión que no estás viendo.
    sleepMinutes: Number(process.env.CLAUDES_SLEEP_MINUTES) > 0 ? Number(process.env.CLAUDES_SLEEP_MINUTES) : 45,
    // Animación de arranque. Para pruebas: CLAUDES_NO_SPLASH la quita y, desde el código,
    // CLAUDES_SPLASH_AT=<ms> la deja quieta en ese instante.
    splash: !process.env.CLAUDES_NO_SPLASH,
    splashAt: DEV && Number.isFinite(Number(process.env.CLAUDES_SPLASH_AT)) && process.env.CLAUDES_SPLASH_AT !== undefined
      ? Number(process.env.CLAUDES_SPLASH_AT) : null,
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
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.handle('pty:kill', async (_e, id) => {
    await ptys.kill(id);
    if (typeof id === 'string' && !id.includes(':')) {
      hookServer.forget(id);
      contexts.forget(id);
      tabs.forget(id);
    }
  });

  // Registro de depuración: estado, interruptor y acceso a los archivos.
  const debugInfo = () => ({ enabled: logger.enabled, dir: logsDir() });
  ipcMain.handle('debug:get', debugInfo);
  ipcMain.handle('debug:set', (_e, on) => {
    if (logger.enabled && !on) appLog('registro de depuración desactivado');
    logger.enabled = Boolean(on);
    store.set('debugLogs', logger.enabled);
    if (logger.enabled) appLog('registro de depuración activado');
    return debugInfo();
  });
  // Abre el registro de Claude de una pestaña; sin pestaña (o sin registro), la carpeta.
  ipcMain.on('debug:open', (_e, tabId) => {
    const file = typeof tabId === 'string' ? (tabs.get(tabId) || {}).log : null;
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

  // Micrófono para dictar: la interfaz lo aplica a las teclas; aquí solo se recuerda.
  ipcMain.handle('voice:get', () => ({ enabled: voiceEnabled }));
  ipcMain.handle('voice:set', (_e, on) => {
    voiceEnabled = Boolean(on);
    store.set('voiceDictation', voiceEnabled);
    appLog(`micrófono para dictar ${voiceEnabled ? 'activado' : 'desactivado'}`);
    return { enabled: voiceEnabled };
  });

  // Actualización desde GitHub.
  ipcMain.handle('update:get', () => updater.info());
  ipcMain.handle('update:changes', () => updater.changes());
  ipcMain.handle('update:start', () => {
    updater.start(); // tarda minutos: el avance llega por update:changed
    return updater.info();
  });
  ipcMain.on('update:restart', restartToUpdate);

  // Botón «Resumido»: vale para todas las pestañas desde su siguiente mensaje.
  // Interruptor «Codex asesora»: apagarlo vale al momento; encenderlo, desde el siguiente turno.
  const reviewInfo = () => ({ enabled: review.enabled, usable: advisorUsable(), model: review.MODEL, effort: review.EFFORT, sandbox: codexState.sandbox !== false, codexConfig: codex.configPath() });
  ipcMain.handle('review:get', () => reviewInfo());
  ipcMain.handle('review:set', (_e, on) => {
    review.enabled = Boolean(on) && advisorUsable();
    appLog(`revisión de Codex ${review.enabled ? 'activada' : 'desactivada'}`);
    return reviewInfo();
  });

  ipcMain.handle('brief:get', () => ({ enabled: style.brief }));
  ipcMain.handle('brief:set', (_e, on) => {
    style.brief = Boolean(on);
    store.set('briefMode', style.brief);
    appLog(`respuestas ${style.brief ? 'resumidas' : 'con explicaciones'} (botón «Resumido»)`);
    return { enabled: style.brief };
  });

  // Límites de uso del plan (5 horas y semanal) y tokens gastados en cada periodo.
  ipcMain.handle('limits:get', () => (limits ? limits.snapshot() : null));

  ipcMain.on('status:summary', (_e, value) => {
    wm.setBusy(value && value.working);
  });

  ipcMain.on('notify', (_e, o) => {
    if (!o || !Notification.isSupported()) return;
    const notification = new Notification({ title: String(o.title || 'ClaudHome'), body: String(o.body || ''), silent: true });
    liveNotifications.add(notification); // sin esta referencia, el clic se pierde
    notification.on('click', () => { wm.show(); send('notify:click', o.tabId); });
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
    if (wm.win && !wm.win.isFocused()) wm.win.flashFrame(true);
  });

  // Vista previa de los archivos sobre los que se pasa el ratón en la terminal.
  ipcMain.handle('preview:file', (_e, target) => previewer.preview(target));
  ipcMain.handle('preview:existing', (_e, list) => previewer.existing(list));

  // Contexto del proyecto: datos de cada elemento para el panel, cambios, lo que
  // recibe Claude y los diálogos para añadir archivos o carpetas.
  ipcMain.handle('context:describe', (_e, items) => contexts.describe(items));
  ipcMain.handle('context:prompt', async (_e, tabId, name, context) => (await contexts.build(String(tabId), name, context)).text);
  ipcMain.handle('context:update', async (_e, tabId, name, context) => {
    if (typeof tabId !== 'string') return false;
    const result = await contexts.update(tabId, name, context);
    // Con la sesión abierta se reescriben sus ajustes con los permisos nuevos (por si
    // Claude Code los recarga); el resumen se lo da el hook con el siguiente mensaje.
    if (ptys.has(tabId)) hookServer.settingsFile(tabId, sessionSettings(tabId, result.allow));
    return true;
  });
  ipcMain.handle('context:link', (_e, url) => contexts.linkInfo(url));

  // «Log»: lo que ha visto Claude y lo que sale hacia internet.
  ipcMain.handle('netlog:get', () => (netlog ? netlog.entries() : []));
  ipcMain.on('netlog:openFile', () => {
    const file = netlog && netlog.todayFile();
    if (file && fs.existsSync(file)) shell.openPath(file);
    else { fs.mkdirSync(logsDir(), { recursive: true }); shell.openPath(logsDir()); }
  });
  ipcMain.handle('context:pick', async (_e, kind) => {
    const folder = kind === 'folder';
    const result = await dialog.showOpenDialog(wm.win, {
      title: folder ? 'Añadir una carpeta al contexto del proyecto' : 'Añadir archivos al contexto del proyecto',
      properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('fs:isDir', (_e, target) => {
    try { return typeof target === 'string' && fs.statSync(target).isDirectory(); } catch { return false; }
  });

  ipcMain.handle('dialog:pickFolder', async (_e, startAt) => {
    const result = await dialog.showOpenDialog(wm.win, {
      title: 'Elige la carpeta de la sesión',
      defaultPath: typeof startAt === 'string' && fs.existsSync(startAt) ? startAt : os.homedir(),
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:confirm', async (_e, o) => {
    if (DEV && process.env.CLAUDES_AUTO_CONFIRM) return true; // solo para pruebas automáticas
    const result = await dialog.showMessageBox(wm.win, {
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
        enabled: Boolean((tabs.get(o.id) || {}).log && fs.existsSync(tabs.get(o.id).log)),
        click: pick('log'),
      },
      { label: 'Abrir la carpeta de registros', click: pick('logs') },
      { type: 'separator' },
      { label: 'Cerrar pestaña', accelerator: 'Ctrl+Shift+W', registerAccelerator: false, click: pick('close') },
    ]);
    // El aviso de cierre del menú puede llegar antes que el de la opción elegida.
    menu.popup({ window: wm.win, callback: () => setTimeout(() => { if (!settled) resolve(null); }, 150) });
  }));

  ipcMain.handle('dialog:choose', async (_e, o) => {
    if (DEV && process.env.CLAUDES_AUTO_CONFIRM) return 0; // solo para pruebas automáticas
    const buttons = Array.isArray(o.buttons) ? o.buttons.map(String) : ['Aceptar', 'Cancelar'];
    const result = await dialog.showMessageBox(wm.win, {
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
    wm.closeNow();
  });

  ipcMain.handle('clipboard:read', () => pasteboard.read());
  ipcMain.on('clipboard:write', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text).catch(() => { /* portapapeles ocupado */ });
  });

  if (DEV) {
    ipcMain.on('dev:input', (_e, event) => {
      if (wm.win && event && typeof event === 'object') wm.win.webContents.sendInputEvent(event);
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
  app.on('second-instance', () => { if (wm) wm.show(); });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // los atajos del menú por defecto chocarían con la terminal
    store = new Store(path.join(app.getPath('userData'), 'state.json'));
    logger.enabled = store.get('debugLogs', true) !== false; // activado salvo que se haya apagado
    logger.clean();
    wm = createWindowManager({
      electron: { app, BrowserWindow, dialog, screen },
      store,
      log: appLog,
      dev: DEV,
      onCloseCancelled: () => { if (updater) updater.relaunch = false; }, // ya no se cierra: tampoco se reinicia
    });
    appLog(`──── Claudes ${app.getVersion()} arranca (Electron ${process.versions.electron}, ${app.isPackaged ? 'ejecutable' : 'desde el código'}) ────`);
    process.on('uncaughtException', (err) => {
      appLog(`ERROR sin capturar en el proceso principal: ${(err && err.stack) || err}`);
      dialog.showErrorBox('Error en ClaudHome', String((err && err.stack) || err));
    });
    process.on('unhandledRejection', (reason) => {
      appLog(`promesa rechazada sin capturar en el proceso principal: ${(reason && reason.stack) || reason}`);
    });
    // Codex como segundo revisor (review.js): se crea antes que el servidor de hooks.
    review = createReview({
      tabs, store, usable: advisorUsable, codex, send, log: appLog, logsDir,
      detailedLogs: () => logger.enabled, // la salida completa, solo con la depuración activada
      // Lo que lleve claves no se envía a Codex.
      checkSecrets: (cwd, signal) => (secrets ? secrets.reviewInput(cwd, signal) : { ok: false, files: [] }),
      checkLogin: () => codex.chatgptLogin(), // justo antes de cada revisión
      netlog: () => netlog, // se crea más tarde
      sandboxMissing: () => codexState.sandbox === false,
      onBusy: (delta) => {
        codexState.busy = Math.max(0, codexState.busy + delta);
        send('codex:changed', codexInfo());
        if (delta < 0) codexLimitsSoon(); // lo gastado se ve al momento en la barra inferior
      },
    });
    hookServer = new HookServer(path.join(app.getPath('userData'), 'hooks'), (tabId, event) => {
      if (DEV && process.env.CLAUDES_LOG_HOOKS) console.log('[hook]', event.event, event.prompt ? `«${event.prompt}»` : '');
      appLog(`hook de ${tabLabel(tabId)}: ${event.event}${event.toolName ? ` ${event.toolName}` : ''}${event.notificationType ? ` ${event.notificationType}` : ''}`);
      // El «Log» escribe en disco y puede leer la carpeta del proyecto: se hace después de
      // contestar al hook (setImmediate conserva el orden de llegada).
      if (netlog) setImmediate(() => netlog.fromHook(tabId, event));
      // Lo que necesita la revisión de Codex: si el turno ha editado código y, al pararse,
      // si se va a revisar (la interfaz no lo da por terminado mientras tanto).
      if (event.event === 'UserPromptSubmit') review.turnStarted(tabId, event.prompt, event.request);
      if (event.event === 'PostToolUse') review.toolUsed(tabId, event.toolName, event.toolInput && event.toolInput.file, event.cwd);
      if (event.event === 'Stop') event.reviewing = review.willReview(tabId, event);
      // Con /clear la pestaña pasa a otra conversación: los hooks llevan la actual.
      const tab = tabs.get(tabId);
      if (event.sessionId && tab && tab.folder) tab.session = event.sessionId;
      if (event.cwd && tab) tab.cwd = event.cwd; // donde trabaja ahora (para preguntar a Codex)
      // La carpeta del agente que va a pedir una segunda opinión (puede ser un subagente en otra copia).
      if (event.event === 'PreToolUse' && event.toolName === `mcp__${CODEX_SERVER}__${codex.OPINION_TOOL.name}` && tab) tab.opinionCwd = event.cwd;
      if (limits && (event.event === 'Stop' || event.event === 'StopFailure')) limits.refreshSoon();
      send('hook', tabId, event);
    });
    // Solo para pruebas: los mensajes se bloquean antes de llegar al modelo (no gastan tokens).
    hookServer.blockPrompts = DEV && Boolean(process.env.CLAUDES_BLOCK_PROMPTS);
    // Si el contexto del proyecto cambió con la sesión abierta, se le da a Claude con el siguiente mensaje.
    contexts = createContext({ app, net, log: appLog });
    // Uso del contexto de cada sesión: se avisa a la interfaz cuando cambia el porcentaje.
    // Límites de uso del plan: llegan con los mismos datos, en cualquier pestaña. También
    // se cuentan los tokens de la conversación de cada pestaña.
    limits = new Limits({ store, send, log: appLog, openSessions: () => tabs.sessions() });
    hookServer.onStatus = (tabId, data) => {
      limits.fromStatus(data);
      limits.refreshSoon();
      const usage = usageFrom(data);
      if (!usage) return;
      const tab = tabs.get(tabId);
      const last = tab && tab.usage;
      if (last && last.pct === usage.pct && last.size === usage.size) return;
      if (tab) tab.usage = usage;
      send('session:usage', tabId, usage);
    };
    // Con cada mensaje, lo que la sesión tenga que saber: el estilo del botón «Resumido»
    // si ha cambiado y el contexto del proyecto si se cambió con la sesión abierta.
    // Y tras cada edición de Claude, los avisos de buenas prácticas: si el archivo ha
    // crecido hasta un escalón (growth.js) o si lleva una clave escrita (secrets.js).
    growth = new Growth({ store, log: appLog });
    secrets = new Secrets({ store, log: appLog });
    hookServer.respond = async (tabId, eventName, event, signal) => {
      // Al pararse Claude: la revisión de Codex, si toca.
      if (eventName === 'Stop') return review.onStop(tabId, event, signal);
      // Al presentar un plan: la crítica de Codex, si toca.
      if (eventName === 'PlanReview') return review.onPlan(tabId, event, signal);
      if (eventName === 'PostToolUse') {
        const tab = tabs.get(tabId);
        const file = event && EDIT_TOOLS.has(event.toolName) && event.toolInput && event.toolInput.file;
        // Una ruta relativa se resuelve con la carpeta de trabajo de la sesión (puede ser
        // una subcarpeta); el proyecto, para recordar lo avisado, es la carpeta de la pestaña.
        if (!file || !tab || !tab.folder) return null;
        // Cada aviso con su propio límite, por debajo del de la respuesta: si uno se retrasa,
        // el otro llega igual. Lo que acaba fuera de plazo no se anota (lo comprueban antes).
        const within = (promise) => Promise.race([promise, new Promise((resolve) => { setTimeout(resolve, NOTICE_LIMIT, null); })]);
        const notices = (await Promise.all([
          within(growth.edited(tab.folder, file, { base: event.cwd, budget: NOTICE_BUDGET, defer: true })),
          within(secrets.edited(tab.folder, file, { base: event.cwd, budget: NOTICE_BUDGET, defer: true })),
        ])).filter(Boolean);
        // Solo se anota lo avisado si el aviso llega a Claude (si no, se repetirá).
        if (signal && signal.aborted) return null;
        notices.forEach((n) => n.commit());
        const notice = notices.map((n) => n.notice).join('\n\n');
        return notice ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice } } : null;
      }
      if (eventName !== 'UserPromptSubmit') return null;
      const parts = [];
      const styleText = style.update(tabId);
      if (styleText) parts.push(styleText);
      const ctx = contexts.pendingUpdate(tabId);
      if (ctx) parts.push(ctx.hookSpecificOutput.additionalContext);
      return parts.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } } : null;
    };
    hookServer.mcp = createMcp({
      name: 'claudes-codex',
      version: app.getVersion(),
      // La segunda opinión siempre; las imágenes, si están activadas.
      tools: () => [...(codexState.installed && codexState.advisor !== false ? [codex.OPINION_TOOL] : []), ...(codexState.enabled && codexUsable() ? [codex.IMAGE_TOOL] : [])],
      callTool: (tabId, name, args, signal) => (name === codex.OPINION_TOOL.name ? review.secondOpinion(tabId, args, signal) : codexTool(tabId, name, args)),
    });
    const innerMcp = hookServer.mcp;
    hookServer.mcp = (tabId, body, signal) => {
      const methods = [].concat(body).map((m) => (m && m.method) || '?').join(', ');
      if (DEV && process.env.CLAUDES_LOG_HOOKS) console.log('[mcp]', methods);
      appLog(`MCP de ${tabLabel(tabId)}: ${methods}`);
      return innerMcp(tabId, body, signal);
    };
    await hookServer.start();
    pasteboard.cleanOld();
    previewer = createPreview({ app, nativeImage });
    previewer.cleanTemp();
    codexState.enabled = store.get('codexImages', false) === true;
    voiceEnabled = store.get('voiceDictation', false) === true;
    style.brief = store.get('briefMode', false) === true;
    refreshCodex().catch(() => { /* se reintentará al consultar el estado */ });
    updater = new Updater({
      app, net, shell, log: appLog, logsDir,
      onChange: (info) => {
        send('update:changed', info);
        // Solo para pruebas automáticas: actualizar en cuanto haya versión nueva.
        if (process.env.CLAUDES_UPDATE_AUTO && info.status === 'available') setImmediate(() => updater.start());
      },
      onReady: restartToUpdate, // ya se aceptó con «Update»
    });
    updater.noteAttempt(store.get('updateAttempt', null));
    store.set('updateAttempt', null);
    updater.schedule();
    // «Log»: lo que ha visto Claude y lo que sale hacia internet, a partir de los hooks.
    netlog = new NetLog({
      logsDir,
      send,
      tabName: (id) => (tabs.get(id) || {}).name || null,
      cwdOf: (id) => (tabs.get(id) || {}).folder || null,
    });
    const pluginNames = style.prepare();
    appLog(gitBash ? `plugins para las sesiones: ${pluginNames.join(', ') || 'ninguno'}` : 'sin Git Bash: las sesiones arrancan sin plugins');
    registerIpc();
    wm.create();
    limits.start();
  });

  app.on('window-all-closed', () => {
    ptys.killAll();
    codex.stopReviews(); // una revisión de Codex en marcha no sigue tras cerrar
    if (hookServer) hookServer.stop();
    if (limits) limits.stop();
    // Con una versión nueva lista, se instala ahora que Claudes se cierra.
    const attempt = updater ? updater.installOnQuit() : null;
    if (attempt && store) store.set('updateAttempt', attempt);
    if (store) store.flush();
    app.quit();
  });
}
