// Comunicación con la interfaz: los canales que atiende el proceso principal (los que
// usa preload.js). Cada uno hace poco: delega en el módulo de lo suyo (ptys.js, codex-state.js,
// updater.js, context.js…). Se registran una vez, al arrancar, con todo ya creado.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkProject } = require('./optimize');
const { saveDefaultModel, defaultModel } = require('./claude-config');

function registerIpc({
  electron: { app, ipcMain, dialog, Notification, Menu, clipboard, shell },
  DEV, store, wm, ptys, pasteboard, hookServer, contexts, tabs, logger, logsDir, appLog, send,
  sessions, shellList, createPty, sessionSettings, codex, codexState, review, style, limits,
  previewer, netlog, updater, restartToUpdate, optimizer, optimizeHints, gitBash, narrator, workflow,
}) {
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

  // Codex: cómo está (como mucho una comprobación por minuto, salvo que se pida) y el
  // interruptor de imágenes.
  ipcMain.handle('codex:status', (_e, refresh) => codexState.status(refresh));
  ipcMain.handle('codex:setEnabled', (_e, on) => codexState.setEnabled(on));

  // Botón «Optimiza» (optimize.js): cómo está el proyecto y, al confirmar, preparar las
  // instrucciones para la siguiente petición de esa pestaña (se comprueba otra vez).
  const optimizeFolder = (tabId) => (tabs.get(tabId) || {}).folder || null;
  ipcMain.handle('optimize:check', (_e, tabId) => checkProject(optimizeFolder(tabId), { gitBash }));
  ipcMain.handle('optimize:arm', async (_e, tabId) => {
    const project = await checkProject(optimizeFolder(tabId), { gitBash });
    if (!project.ok) return false;
    optimizer.arm(tabId, project);
    return true;
  });
  // Si conviene optimizar (optimize-hint.js) y «Ahora no».
  ipcMain.handle('optimize:hint', (_e, tabId) => optimizeHints.hint(tabId));
  ipcMain.handle('optimize:snooze', (_e, tabId) => optimizeHints.snooze(tabId));

  // Botón «Workflow» (workflow.js): el mapa del proyecto de la pestaña, aparte de su sesión.
  ipcMain.handle('workflow:open', (_e, tabId) => workflow.open(optimizeFolder(String(tabId)), String(tabId)));
  ipcMain.on('workflow:close', (_e, tabId) => workflow.close(optimizeFolder(String(tabId))));
  ipcMain.handle('workflow:redo', (_e, tabId) => workflow.redo(optimizeFolder(String(tabId))));
  // Pulsar una pieza del mapa: su archivo, seleccionado en el Explorador (no se abre con su
  // programa: en Windows, abrir un .js, .bat o .cmd lo ejecutaría). Solo dentro del proyecto.
  ipcMain.on('workflow:reveal', (_e, tabId, rel) => {
    const folder = optimizeFolder(String(tabId));
    if (!folder || typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) return;
    const root = path.resolve(folder);
    const full = path.resolve(root, rel.trim());
    if (full !== root && !full.startsWith(root + path.sep)) return;
    if (fs.existsSync(full)) shell.showItemInFolder(full);
    else if (fs.existsSync(path.dirname(full)) && path.dirname(full).startsWith(root)) shell.openPath(path.dirname(full)); // la carpeta, si el archivo ya no está
  });
  // Al entrar en un proyecto, el mapa se prepara solo. Si la sesión aún no ha arrancado, vale
  // la carpeta de la pestaña (una carpeta que exista).
  ipcMain.on('workflow:enter', (_e, tabId, cwd) => {
    let folder = optimizeFolder(String(tabId));
    if (!folder && typeof cwd === 'string' && path.isAbsolute(cwd)) {
      try { if (fs.statSync(cwd).isDirectory()) folder = cwd; } catch { /* no existe */ }
    }
    if (folder) workflow.enter(folder, String(tabId));
  });

  // Micrófono para dictar: la interfaz lo aplica a las teclas; aquí solo se recuerda.
  // (Cada sesión arranca con el dictado de Claude Code en modo «mantener»: graba mientras se
  // mantiene pulsada la barra espaciadora. Este botón decide si esas repeticiones le llegan;
  // apagado, una pulsación larga es un solo espacio y nunca se graba.)
  let voiceEnabled = store.get('voiceDictation', false) === true;
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
  const reviewInfo = () => ({ enabled: review.enabled, usable: codexState.advisorUsable(), model: review.MODEL, effort: review.EFFORT, sandbox: codexState.state.sandbox !== false, codexConfig: codex.configPath() });
  ipcMain.handle('review:get', () => reviewInfo());
  ipcMain.handle('review:set', (_e, on) => {
    review.enabled = Boolean(on) && codexState.advisorUsable();
    appLog(`revisión de Codex ${review.enabled ? 'activada' : 'desactivada'}`);
    return reviewInfo();
  });

  // Panel «Actividad»: activada o no (rueda de opciones: si no, Haiku no cuenta nada), la
  // columna a la vista u oculta (la pestaña lateral; oculta, sigue contando) y lo de cada pestaña.
  const activityState = () => ({ enabled: narrator.isEnabled(), open: store.get('activityOpen', true) !== false });
  ipcMain.handle('activity:get', (_e, tabId) => (typeof tabId === 'string' ? narrator.get(tabId) : activityState()));
  // Al cerrar la pestaña (no al dormirla: dormida conserva lo contado).
  ipcMain.on('activity:forget', (_e, tabId) => { if (typeof tabId === 'string') narrator.forget(tabId); });
  ipcMain.handle('activity:setEnabled', (_e, on) => {
    store.set('activityEnabled', narrator.setEnabled(on));
    return activityState();
  });
  ipcMain.handle('activity:setOpen', (_e, on) => {
    store.set('activityOpen', Boolean(on));
    return activityState();
  });

  // Modelo y esfuerzo como predeterminados de Claude Code (la casilla del panel de la barra inferior).
  ipcMain.handle('model:getDefault', () => defaultModel());
  ipcMain.handle('model:saveDefault', (_e, choice) => {
    const res = saveDefaultModel(choice || {});
    appLog(res.ok ? `modelo predeterminado de Claude Code: ${choice.model}${choice.effort ? `, esfuerzo ${choice.effort}` : ''}` : `no se ha guardado el modelo predeterminado: ${res.error}`);
    return res;
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

  const liveNotifications = new Set(); // sin esta referencia, el clic de una notificación se pierde
  ipcMain.on('notify', (_e, o) => {
    if (!o || !Notification.isSupported()) return;
    const notification = new Notification({ title: String(o.title || 'ClaudHome'), body: String(o.body || ''), silent: true });
    liveNotifications.add(notification);
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

module.exports = { registerIpc };
