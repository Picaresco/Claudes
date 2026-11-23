// Proceso principal de Claudes: arranque, sesiones de las pestañas y avisos de los hooks.
// Cada pieza vive en su módulo: la ventana (window.js), los procesos de terminal (ptys.js),
// las consolas y su entorno (shells.js), el portapapeles (clipboard.js), el estilo de las
// respuestas y los plugins (style.js), el registro de depuración (applog.js), lo que se
// sabe de cada pestaña (tabs.js), lo que se sabe de Codex (codex-state.js) y los canales
// con la interfaz (ipc.js).
const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, clipboard, shell, screen, net, nativeImage } = require('electron');
const fs = require('fs');
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
const { createTestReminder } = require('./testcheck');
const { createCodexState } = require('./codex-state');
const { registerIpc } = require('./ipc');
const { createOptimizer } = require('./optimize');
const { createOptimizeHints } = require('./optimize-hint');
const { createChecker } = require('./optimize-check');
const { createNarrator } = require('./narrator');
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
let testcheck = null; // pruebas antes de terminar (testcheck.js)
let optimizer = null; // botón «Optimiza» (optimize.js)
let optimizeHints = null; // cuándo se recomienda (optimize-hint.js)
let optimizeChecker = null; // la segunda mirada de Haiku (optimize-check.js)
let narrator = null; // panel «Actividad»: lo que hace Claude, contado por Haiku (narrator.js)
// Avisos tras una edición: el hook espera 2 s; cada aviso tiene 1,5 s para decidir (si se
// pasa, no anota nada) y a los 1,7 s se contesta con lo que haya.
const NOTICE_BUDGET = 1500;
const NOTICE_LIMIT = 1700;

const logsDir = () => path.join(app.getPath('userData'), 'logs');
const logger = createAppLog(logsDir); // registro de depuración (applog.js)
const appLog = logger.log;
const tabs = new Tabs(); // lo que se sabe de cada pestaña (tabs.js)
const tabLabel = (id) => tabs.label(id);

// Avisa a la interfaz por un canal (cuando ya hay ventana).
const send = (channel, ...args) => { if (wm) wm.send(channel, ...args); };

// Si el proceso de Claude de una pestaña termina sin avisar de que paraba, el panel
// «Actividad» deja de decir que está trabajando.
const ptys = createPtys({
  pty,
  send: (channel, ...args) => {
    if (channel === 'pty:exit' && narrator && typeof args[0] === 'string' && !args[0].includes(':')) narrator.exited(args[0]);
    send(channel, ...args);
  },
  log: appLog,
  label: tabLabel,
});
// Las preguntas a Haiku («Optimiza» y el panel «Actividad») van siempre con la cuenta de
// Claude del usuario (su plan), nunca con una clave de API ni a través de Bedrock o Vertex,
// que se cobran aparte: sin la cuenta, no se pregunta y la app sigue sin Haiku.
const haikuEnv = () => {
  const env = childEnv({});
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[name];
  return env;
};
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
// Lo que se sabe de Codex y lo que está haciendo ahora mismo (codex-state.js).
const codexState = createCodexState({
  codex,
  tabs,
  send,
  log: appLog,
  persist: (on) => store.set('codexImages', on),
  workDir: () => path.join(app.getPath('temp'), 'Claudes-codex'),
  netlog: () => netlog, // se crea más tarde
});
// ── Ajustes de cada sesión ─────────────────────────────────────────

// Ajustes de Claude Code que Claudes añade a la sesión de una pestaña. `allow` son
// las reglas para leer sin preguntar los documentos del contexto del proyecto.
function sessionSettings(tabId, allow = []) {
  const mine = userSettings();
  // Dictado activado y los plugins integrados que toquen (style.js).
  // (El dictado arranca en modo «mantener»: el botón del micrófono decide si le llega la tecla; ipc.js.)
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
  if (!codexState.state.checkedAt) await codexState.refresh();
  const withMcp = Boolean(codexState.state.installed);
  const withCodex = withMcp && codexState.state.enabled; // con la herramienta de imágenes
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
  if (optimizeHints) optimizeHints.refresh(o.id); // si conviene optimizar este proyecto
  return { ok: true, sessionId: chosen.sessionId, resumed: chosen.resumed, codex: withCodex };
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
      tabs, store, usable: codexState.advisorUsable, codex, log: appLog, logsDir,
      // El resultado también le llega al panel «Actividad» (si no hay nada, la tarea termina ahí),
      // en orden con los avisos de los hooks, que el panel también procesa con setImmediate.
      send: (channel, ...args) => {
        if (channel === 'review:result' && narrator) setImmediate(() => narrator.review(args[0], args[1]));
        send(channel, ...args);
      },
      detailedLogs: () => logger.enabled, // la salida completa, solo con la depuración activada
      // Lo que lleve claves no se envía a Codex.
      checkSecrets: (cwd, signal) => (secrets ? secrets.reviewInput(cwd, signal) : { ok: false, files: [] }),
      checkLogin: () => codex.chatgptLogin(), // justo antes de cada revisión
      netlog: () => netlog, // se crea más tarde
      sandboxMissing: () => codexState.state.sandbox === false,
      onBusy: codexState.adviseBusy, // el indicador de la barra superior y, al terminar, el uso
    });
    testcheck = createTestReminder({ tabs, log: appLog });
    optimizer = createOptimizer({ tabs, log: appLog });
    // Antes de recomendar «Optimiza», Haiku lee lo que más ha cambiado y dice si conviene
    // (optimize-check.js). Lo que se le envía queda en el «Log».
    optimizeChecker = createChecker({
      findClaude: sessions.findClaude,
      env: haikuEnv,
      workDir: () => path.join(app.getPath('temp'), 'Claudes-haiku'),
      log: appLog,
    });
    optimizeHints = createOptimizeHints({
      store, tabs, send, log: appLog,
      check: async ({ folder, files, signals, tabId }) => {
        const answer = await optimizeChecker.check({ folder, files, signals });
        for (const file of answer.files || []) if (netlog) netlog.record({ tabId, kind: 'archivo', target: path.join(folder, file), detail: 'Haiku: ¿conviene optimizar?', dest: 'Anthropic' });
        return answer;
      },
    });
    // Panel «Actividad»: con el panel abierto, Haiku cuenta lo que va haciendo Claude.
    narrator = createNarrator({
      tabs, send, log: appLog,
      findClaude: sessions.findClaude,
      env: haikuEnv,
      workDir: () => path.join(app.getPath('temp'), 'Claudes-haiku'),
      open: store.get('activityOpen', true) !== false,
    });
    hookServer = new HookServer(path.join(app.getPath('userData'), 'hooks'), (tabId, event) => {
      if (DEV && process.env.CLAUDES_LOG_HOOKS) console.log('[hook]', event.event, event.prompt ? `«${event.prompt}»` : '');
      appLog(`hook de ${tabLabel(tabId)}: ${event.event}${event.toolName ? ` ${event.toolName}` : ''}${event.notificationType ? ` ${event.notificationType}` : ''}`);
      // El «Log» escribe en disco y puede leer la carpeta del proyecto: se hace después de
      // contestar al hook (setImmediate conserva el orden de llegada).
      if (netlog) setImmediate(() => netlog.fromHook(tabId, event));
      // Lo que necesita la revisión de Codex: si el turno ha editado código y, al pararse,
      // si se va a revisar (la interfaz no lo da por terminado mientras tanto).
      if (event.event === 'UserPromptSubmit') { review.turnStarted(tabId, event.prompt, event.request); testcheck.turnStarted(tabId, event.prompt); }
      if (event.event === 'PostToolUse') review.toolUsed(tabId, event.toolName, event.toolInput && event.toolInput.file, event.cwd);
      // ¿Conviene optimizar? Cada cambio de código cuenta (se cuenta después de contestar).
      if (event.event === 'UserPromptSubmit') optimizeHints.turnStarted(tabId);
      if (event.event === 'PostToolUse' && EDIT_TOOLS.has(event.toolName) && event.toolInput && event.toolInput.file) {
        const file = event.toolInput.file;
        setImmediate(() => { optimizeHints.edited(tabId, file, event.cwd).catch(() => { /* se contará con el siguiente */ }); });
      }
      // Pruebas antes de terminar: qué se cambia, qué pruebas se pasan y cómo acaban.
      if (event.event === 'PreToolUse') testcheck.toolStarting(tabId, event.toolName, event.toolUseId);
      if (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') {
        testcheck.toolUsed(tabId, event.toolName, event.toolInput, {
          cwd: event.cwd, failed: event.event === 'PostToolUseFailure', background: event.background, shell: event.shell, toolUseId: event.toolUseId,
        });
      }
      delete event.shell; // la orden entera y su salida no van al registro ni a la interfaz
      // Al pararse: primero, las pruebas (que las pase si cambió código sin pasarlas, o que
      // no termine sin más si han fallado); después (en el siguiente Stop), la revisión de
      // Codex. Si el turno se para con las pruebas sin pasar, la interfaz se lo dice al usuario.
      if (event.event === 'Stop') {
        event.testsAsk = testcheck.willAsk(tabId);
        event.reviewing = !event.testsAsk && review.willReview(tabId, event);
        event.testsFailing = event.testsAsk ? null : testcheck.failing(tabId);
      }
      // Con /clear la pestaña pasa a otra conversación: los hooks llevan la actual.
      const tab = tabs.get(tabId);
      if (event.sessionId && tab && tab.folder) tab.session = event.sessionId;
      if (event.cwd && tab) tab.cwd = event.cwd; // donde trabaja ahora (para preguntar a Codex)
      // La carpeta del agente que va a pedir una segunda opinión (puede ser un subagente en otra copia).
      if (event.event === 'PreToolUse' && event.toolName === `mcp__${CODEX_SERVER}__${codex.OPINION_TOOL.name}` && tab) tab.opinionCwd = event.cwd;
      if (limits && (event.event === 'Stop' || event.event === 'StopFailure')) limits.refreshSoon();
      // El panel «Actividad», después de contestar al hook (lee el registro de la conversación) y
      // en el orden de llegada, con lo que ya se sabe de Stop (pruebas, revisión).
      const forActivity = { ...event };
      setImmediate(() => narrator.event(tabId, forActivity));
      delete event.narr; // solo para el panel «Actividad»
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
      if (eventName === 'Stop') return event.testsAsk ? testcheck.answer(tabId) : review.onStop(tabId, event, signal);
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
      // Botón «Optimiza»: las instrucciones completas, si se acaba de confirmar.
      const optimize = optimizer.consume(tabId, event && event.prompt);
      if (optimize) { parts.push(optimize); optimizeHints.optimized(tabId); }
      return parts.length ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } } : null;
    };
    hookServer.mcp = createMcp({
      name: 'claudes-codex',
      version: app.getVersion(),
      // La segunda opinión siempre; las imágenes, si están activadas.
      tools: codexState.tools,
      callTool: (tabId, name, args, signal) => (name === codex.OPINION_TOOL.name ? review.secondOpinion(tabId, args, signal) : codexState.drawImage(tabId, args)),
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
    codexState.restore({ enabled: store.get('codexImages', false) });
    style.brief = store.get('briefMode', false) === true;
    codexState.refresh().catch(() => { /* se reintentará al consultar el estado */ });
    codexState.start();
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
    registerIpc({
      electron: { app, ipcMain, dialog, Notification, Menu, clipboard, shell },
      DEV, store, wm, ptys, pasteboard, hookServer, contexts, tabs, logger, logsDir, appLog, send,
      sessions, shellList, createPty, sessionSettings, codex, codexState, review, style, limits,
      previewer, netlog, updater, restartToUpdate, optimizer, optimizeHints, gitBash, narrator,
    });
    wm.create();
    limits.start();
  });

  app.on('window-all-closed', () => {
    ptys.killAll();
    codex.stopReviews(); // una revisión de Codex en marcha no sigue tras cerrar
    codexState.stop();
    if (optimizeChecker) optimizeChecker.stop(); // una pregunta a Haiku en marcha no sigue tras cerrar
    if (narrator) narrator.stop();
    if (hookServer) hookServer.stop();
    if (limits) limits.stop();
    // Con una versión nueva lista, se instala ahora que Claudes se cierra.
    const attempt = updater ? updater.installOnQuit() : null;
    if (attempt && store) store.set('updateAttempt', attempt);
    if (store) store.flush();
    app.quit();
  });
}
