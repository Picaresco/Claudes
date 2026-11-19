// Puente entre la interfaz y el proceso principal. La interfaz no tiene acceso
// a Node: todo lo que toca el sistema pasa por estas funciones.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),

  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),

  ptyCreate: (options) => ipcRenderer.invoke('pty:create', options),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),

  onHook: on('hook'),
  onUsage: on('session:usage'), // (tabId, { size, used, pct }) cuánto ocupa la conversación
  onNotifyClick: on('notify:click'),
  notify: (options) => ipcRenderer.send('notify', options),
  setSummary: (summary) => ipcRenderer.send('status:summary', summary),

  isDir: (target) => ipcRenderer.invoke('fs:isDir', target),
  pickFolder: (startAt) => ipcRenderer.invoke('dialog:pickFolder', startAt),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  choose: (options) => ipcRenderer.invoke('dialog:choose', options),
  tabMenu: (options) => ipcRenderer.invoke('menu:tab', options),

  // Devuelve { files, text, imagePath }: lo que haya que pegar, por ese orden de preferencia.
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  // Vista previa: datos de un archivo (miniatura, primera página, primeras líneas…)
  // y, de una lista de rutas candidatas, las que existen.
  preview: (file) => ipcRenderer.invoke('preview:file', file),
  existingFiles: (list) => ipcRenderer.invoke('preview:existing', list),

  // Contexto del proyecto de una pestaña (nota y documentos que Claude tiene presentes).
  contextDescribe: (items) => ipcRenderer.invoke('context:describe', items),
  contextUpdate: (tabId, name, context) => ipcRenderer.invoke('context:update', tabId, name, context),
  contextPrompt: (tabId, name, context) => ipcRenderer.invoke('context:prompt', tabId, name, context),
  contextPick: (kind) => ipcRenderer.invoke('context:pick', kind),
  contextLink: (url) => ipcRenderer.invoke('context:link', url),

  // Registro de llamadas al exterior («Log»).
  netlogGet: () => ipcRenderer.invoke('netlog:get'),
  netlogOpenFile: () => ipcRenderer.send('netlog:openFile'),
  onNetlogEntry: on('netlog:entry'),
  onNetlogUpdate: on('netlog:update'),
  openPath: (target) => ipcRenderer.send('shell:openPath', target),

  // Codex: detección de la suscripción e interruptor de «imágenes con Codex».
  codexStatus: (refresh) => ipcRenderer.invoke('codex:status', Boolean(refresh)),
  codexSetEnabled: (on) => ipcRenderer.invoke('codex:setEnabled', Boolean(on)),
  onCodexChanged: on('codex:changed'),

  // Actualización desde GitHub: estado, generar la versión nueva y reiniciar para instalarla.
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateChanges: () => ipcRenderer.invoke('update:changes'),
  updateStart: () => ipcRenderer.invoke('update:start'),
  updateRestart: () => ipcRenderer.send('update:restart'),
  onUpdateChanged: on('update:changed'),

  // Micrófono para dictar con la barra espaciadora mantenida.
  voiceGet: () => ipcRenderer.invoke('voice:get'),
  voiceSet: (on) => ipcRenderer.invoke('voice:set', Boolean(on)),

  // Registro de depuración: interruptor, acceso a los archivos y anotaciones de la interfaz.
  debugGet: () => ipcRenderer.invoke('debug:get'),
  debugSet: (on) => ipcRenderer.invoke('debug:set', Boolean(on)),
  openLog: (tabId) => ipcRenderer.send('debug:open', tabId || null),
  log: (text) => ipcRenderer.send('log', String(text)),

  // Cierre de la app con sesiones trabajando.
  onWrapUpAll: on('app:wrapup'),
  closeNow: () => ipcRenderer.send('app:closeNow'),

  // Solo responde al ejecutar desde el código: ratón y teclado simulados para las pruebas.
  devInput: (event) => ipcRenderer.send('dev:input', event),
});
