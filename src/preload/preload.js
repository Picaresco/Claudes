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
  openPath: (target) => ipcRenderer.send('shell:openPath', target),

  // Codex: detección de la suscripción e interruptor de «imágenes con Codex».
  codexStatus: (refresh) => ipcRenderer.invoke('codex:status', Boolean(refresh)),
  codexSetEnabled: (on) => ipcRenderer.invoke('codex:setEnabled', Boolean(on)),
  onCodexChanged: on('codex:changed'),

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
