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
  onModel: on('session:model'), // (tabId, { id, name, effort, fast }) el modelo y el esfuerzo de la sesión
  modelSaveDefault: (choice) => ipcRenderer.invoke('model:saveDefault', choice), // { model, effort } → configuración de Claude Code
  modelGetDefault: () => ipcRenderer.invoke('model:getDefault'), // { model, effort } de la configuración de Claude Code
  // Límites de uso del plan: { five_hour, seven_day }, cada uno { pct, resetsAt, expired, tokens }.
  limitsGet: () => ipcRenderer.invoke('limits:get'),
  onLimits: on('limits:update'),
  onNotifyClick: on('notify:click'),
  notify: (options) => ipcRenderer.send('notify', options),
  setSummary: (summary) => ipcRenderer.send('status:summary', summary),

  isDir: (target) => ipcRenderer.invoke('fs:isDir', target),
  pickFolder: (startAt) => ipcRenderer.invoke('dialog:pickFolder', startAt),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  choose: (options) => ipcRenderer.invoke('dialog:choose', options),
  // Tarjeta del proyecto (botón derecho sobre una pestaña): la dirección del proyecto en GitHub (o null).
  tabRepo: (tabId, cwd) => ipcRenderer.invoke('tab:repo', String(tabId), String(cwd || '')),

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
  optimizeCheck: (tabId) => ipcRenderer.invoke('optimize:check', String(tabId)),
  optimizeArm: (tabId) => ipcRenderer.invoke('optimize:arm', String(tabId)),
  optimizeHint: (tabId) => ipcRenderer.invoke('optimize:hint', String(tabId)),
  optimizeSnooze: (tabId) => ipcRenderer.invoke('optimize:snooze', String(tabId)),
  onOptimizeHint: on('optimize:hint'), // (tabId, { recommended, reasons, snoozed, first })
  // SuperPowers: ideas para el proyecto (src/main/ideas.js).
  ideasGet: (tabId) => ipcRenderer.invoke('ideas:get', String(tabId)),
  ideasAct: (tabId, id, action) => ipcRenderer.invoke('ideas:act', String(tabId), String(id), String(action)),
  onIdea: on('ideas:card'), // (tabId, card)
  onIdeaClear: on('ideas:clear'), // (tabId, id): respondida o aplazada
  powerStats: (tabId) => ipcRenderer.invoke('superpowers:stats', String(tabId)), // o null
  powerGit: (tabId) => ipcRenderer.invoke('superpowers:git', String(tabId)), // { state, reason, excluded, repo }
  onCodexChanged: on('codex:changed'),

  // Botón «Workflow»: el mapa del proyecto de una pestaña (lo dibuja un modelo aparte).
  workflowOpen: (tabId) => ipcRenderer.invoke('workflow:open', String(tabId)),
  workflowClose: (tabId) => ipcRenderer.send('workflow:close', String(tabId)),
  workflowRedo: (tabId) => ipcRenderer.invoke('workflow:redo', String(tabId)),
  workflowReveal: (tabId, rel) => ipcRenderer.send('workflow:reveal', String(tabId), String(rel || '')), // un archivo del proyecto, en el Explorador
  workflowEnter: (tabId, cwd) => ipcRenderer.send('workflow:enter', String(tabId), String(cwd || '')), // se entra en un proyecto
  onWorkflow: on('workflow:update'), // ({ key, folder, map, status, at, engine, error, next… })

  // Panel «Actividad»: lo que va haciendo Claude en cada pestaña, contado por Haiku.
  activityGet: (tabId) => ipcRenderer.invoke('activity:get', tabId === undefined ? undefined : String(tabId)),
  activitySetEnabled: (on) => ipcRenderer.invoke('activity:setEnabled', Boolean(on)), // rueda de opciones
  activitySetOpen: (on) => ipcRenderer.invoke('activity:setOpen', Boolean(on)), // la columna, a la vista u oculta
  activityForget: (tabId) => ipcRenderer.send('activity:forget', String(tabId)),
  onActivity: on('activity:update'), // (tabId, { entries, now, enabled })
  // El plan de cada pestaña, al pie del panel: { steps: [{ id, text, status }], done, total } o null.
  planGet: (tabId) => ipcRenderer.invoke('plan:get', String(tabId)),
  onPlan: on('plan:update'), // (tabId, plan)

  // Actualización desde GitHub: estado, generar la versión nueva y reiniciar para instalarla.
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateChanges: () => ipcRenderer.invoke('update:changes'),
  updateStart: () => ipcRenderer.invoke('update:start'),
  updateRestart: () => ipcRenderer.send('update:restart'),
  onUpdateChanged: on('update:changed'),

  // Botón «Resumido»: respuestas cortas o con explicaciones, en todas las pestañas.
  briefGet: () => ipcRenderer.invoke('brief:get'),
  briefSet: (on) => ipcRenderer.invoke('brief:set', Boolean(on)),

  // Interruptor «Codex asesora»: segunda opinión, crítica de planes y revisión del código.
  reviewGet: () => ipcRenderer.invoke('review:get'),
  reviewSet: (on) => ipcRenderer.invoke('review:set', Boolean(on)),
  onReviewResult: on('review:result'), // (tabId, { state, count, priorities, seconds, file, reason })

  // Micrófono para dictar con la barra espaciadora mantenida.
  voiceGet: () => ipcRenderer.invoke('voice:get'),
  voiceSet: (on) => ipcRenderer.invoke('voice:set', Boolean(on)),

  // Registro de depuración: interruptor y anotaciones de la interfaz.
  debugGet: () => ipcRenderer.invoke('debug:get'),
  debugSet: (on) => ipcRenderer.invoke('debug:set', Boolean(on)),
  log: (text) => ipcRenderer.send('log', String(text)),

  // Cierre de la app con sesiones trabajando.
  onWrapUpAll: on('app:wrapup'),
  closeNow: () => ipcRenderer.send('app:closeNow'),

  // Solo responde al ejecutar desde el código: ratón y teclado simulados para las pruebas.
  devInput: (event) => ipcRenderer.send('dev:input', event),
});
