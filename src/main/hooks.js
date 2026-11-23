// Claude Code avisa a la app de lo que pasa en cada sesión mediante hooks HTTP:
// cada pestaña arranca `claude --settings <archivo>` y ese archivo apunta los
// hooks a este servidor local. Los hooks del usuario y de sus mods no se tocan.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

// SessionStart no admite hooks HTTP, así que el identificador de la
// conversación se toma de los demás eventos, que también lo llevan.
const EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  // Cuándo empieza y acaba cada agente (panel «Actividad», narrator.js).
  'SubagentStart',
  'SubagentStop',
  // La conversación se resume (/compact o al llenarse): hay que volver a decirle lo que
  // ClaudHome le dijo una vez (cuándo pedir a Codex la segunda opinión, review.js).
  'PreCompact',
  'PostCompact',
];

const HEAD_LIMIT = 64 * 1024; // de cada aviso solo interesa el principio
const PLAN_HEAD_LIMIT = 1024 * 1024; // salvo del plan que presenta Claude (PlanReview), que se lee entero
const PLAN_MAX = 60000; // caracteres de un plan que se le pasan a Codex; uno mayor no se critica
const RESPOND_LIMIT = 2000; // ms que se espera como mucho a quien decide la respuesta (el hook caduca a los 5 s)
// El hook Stop puede esperar a la revisión de Codex (review.js): Claude Code espera hasta
// STOP_TIMEOUT y la app, un poco menos, para contestar siempre antes de que caduque.
// Lo mismo vale para la crítica del plan (PlanReview: un PreToolUse solo de ExitPlanMode).
const STOP_TIMEOUT = 900; // s
const STOP_RESPOND_LIMIT = (STOP_TIMEOUT - 30) * 1000;
const LONG_EVENTS = new Set(['Stop', 'PlanReview']);
const EDIT_TOOL_NAMES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Solape entre trozos al buscar la ruta del archivo editado: rutas de hasta 32 767
// caracteres, aunque cada uno llegue escrito como \uXXXX (6 bytes).
const PATH_OVERLAP = 6 * 32768 + 64;

// De la entrada de una herramienta, solo lo que necesita el registro («Log»,
// netlog.js): el archivo, la dirección, la búsqueda, el comando o un resumen del MCP.
function toolInputSummary(tool, input) {
  if (typeof tool !== 'string' || !input || typeof input !== 'object') return null;
  const text = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);
  if (tool === 'Read') return { file: text(input.file_path, 600), pages: text(input.pages, 40), offset: input.offset || null, limit: input.limit || null };
  // De lo que edita Claude solo interesa qué archivo es (aviso de archivos que crecen,
  // growth.js). La ruta va entera: se usa para leer el archivo, no solo para mostrarla.
  if (EDIT_TOOL_NAMES.includes(tool)) return { file: text(input.file_path || input.notebook_path, 32768) };
  if (tool === 'Grep') return { pattern: text(input.pattern, 200), path: text(input.path, 600) };
  if (tool === 'WebFetch') return { url: text(input.url, 1000), prompt: text(input.prompt, 200) };
  if (tool === 'WebSearch') return { query: text(input.query, 300) };
  if (tool === 'Bash' || tool === 'PowerShell') return { command: text(input.command, 1000) };
  if (tool.startsWith('mcp__')) {
    let summary = '';
    try { summary = JSON.stringify(input); } catch { /* sin resumen */ }
    return { summary: summary.slice(0, 200) };
  }
  return null;
}

// Lo que necesita el panel «Actividad» (narrator.js) de la entrada de una herramienta: el
// archivo, el patrón, la dirección, el comando y la descripción que le pone Claude, el agente
// y su tarea, la lista de tareas… Recortado.
function narrInput(tool, input) {
  if (typeof tool !== 'string' || !input || typeof input !== 'object') return {};
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  switch (tool) {
    case 'Read': return { file: s(input.file_path, 2000) };
    // De un cambio, el principio de lo que había y de lo que queda (para decir qué cambia).
    case 'Edit': return { file: s(input.file_path, 2000), old: s(input.old_string, 300), new: s(input.new_string, 300) };
    case 'MultiEdit': return { file: s(input.file_path, 2000), edits: Array.isArray(input.edits) ? input.edits.length : 0 };
    case 'Write': return { file: s(input.file_path, 2000), lines: typeof input.content === 'string' ? input.content.split('\n').length : 0 };
    case 'NotebookEdit': return { file: s(input.notebook_path, 2000) };
    case 'Glob': return { pattern: s(input.pattern, 200), path: s(input.path, 2000) };
    case 'Grep': return { pattern: s(input.pattern, 200), path: s(input.path, 2000) };
    case 'WebFetch': return { url: s(input.url, 500) };
    case 'WebSearch': return { query: s(input.query, 200) };
    case 'Bash': case 'PowerShell': return { command: s(input.command, 600), description: s(input.description, 200) };
    case 'Agent': case 'Task': return { agent: s(input.subagent_type, 80), task: s(input.description, 200), background: input.run_in_background === true };
    case 'TodoWrite': return { todos: Array.isArray(input.todos) ? input.todos.slice(0, 12).map((t) => ({ content: s(t && (t.content || t.activeForm), 120), status: s(t && t.status, 20) })) : [] };
    case 'TaskCreate': return { subject: s(input.subject || input.description, 150) };
    case 'TaskUpdate': return { status: s(input.status, 20), subject: s(input.subject, 150) };
    case 'Skill': return { skill: s(input.skill || input.command || input.name, 80) };
    case 'AskUserQuestion': return { question: s(Array.isArray(input.questions) && input.questions[0] ? input.questions[0].question : input.question, 200) };
    default: break;
  }
  if (!tool.startsWith('mcp__')) return {};
  let summary = '';
  try { summary = JSON.stringify(input).slice(0, 200); } catch { /* sin resumen */ }
  return { summary };
}

// Del aviso entero, lo del panel «Actividad»: el paso, de qué agente es (si no es Claude), el
// registro de la conversación, la última respuesta (al pararse) y el error (si ha fallado).
// No sale del proceso principal: main.js lo quita antes de pasar el aviso a la interfaz.
function narration(eventName, payload) {
  const s = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return {
    input: narrInput(payload.tool_name, payload.tool_input),
    agentId: s(payload.agent_id, 100),
    agentType: s(payload.agent_type, 100),
    transcript: s(payload.transcript_path, 4000),
    last: s(payload.last_assistant_message, 2000),
    error: eventName === 'PostToolUseFailure' ? s(payload.error, 400) : null,
    interrupted: payload.is_interrupt === true,
  };
}

// De una orden de Bash o PowerShell ya ejecutada, lo que necesita «pruebas antes de
// terminar» (testcheck.js): la orden entera (al registro solo va el principio), el final de
// lo que ha escrito y si se interrumpió. No sale del proceso principal: main.js lo quita
// antes de pasar el aviso a la interfaz y al registro. `partial`: el aviso era tan grande
// que no se tiene lo que escribió.
const SHELL_COMMAND_MAX = 20000;
const SHELL_OUTPUT_MAX = 8000;
const SHELL_BODY_LIMIT = 1024 * 1024; // de un aviso con el resultado de una orden se lee hasta 1 MB
function shellResult(eventName, payload, partial = false) {
  if (eventName !== 'PostToolUse' && eventName !== 'PostToolUseFailure') return null;
  if (payload.tool_name !== 'Bash' && payload.tool_name !== 'PowerShell') return null;
  const input = payload.tool_input;
  const response = payload.tool_response && typeof payload.tool_response === 'object' ? payload.tool_response : {};
  // Si falla, Claude Code manda el texto en `error` («Exit code 1» y lo escrito); si no, en `tool_response`.
  const parts = eventName === 'PostToolUseFailure' ? [payload.error] : [response.stdout, response.stderr];
  return {
    command: input && typeof input === 'object' && typeof input.command === 'string' ? input.command.slice(0, SHELL_COMMAND_MAX) : '',
    output: parts.filter((part) => typeof part === 'string' && part).join('\n').slice(-SHELL_OUTPUT_MAX),
    interrupted: payload.is_interrupt === true || response.interrupted === true,
    partial,
  };
}

// ¿La herramienta deja algo en marcha más allá de la respuesta (una tarea en segundo
// plano, una vigilancia, una tarea programada)? Entonces la sesión no se debe dormir.
const LONG_LIVED_TOOLS = new Set(['Monitor', 'CronCreate', 'ScheduleWakeup']);
function leavesRunning(tool, input) {
  if (typeof tool !== 'string') return false;
  if (LONG_LIVED_TOOLS.has(tool)) return true;
  return Boolean(input && typeof input === 'object' && input.run_in_background);
}

// Valor de una clave de un JSON que puede venir cortado (de los avisos grandes solo
// se lee el principio): busca «"clave":» y lee el valor si está entero.
function jsonField(text, key) {
  const at = text.indexOf(`"${key}":`);
  if (at < 0) return undefined;
  let i = at + key.length + 3;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const start = i;
  if (text[i] === '"') {
    for (i += 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '"') break;
    }
  } else if (text[i] === '{' || text[i] === '[') {
    let depth = 0;
    let inString = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if ((ch === '}' || ch === ']') && --depth === 0) break;
    }
  } else {
    return undefined;
  }
  if (i >= text.length) return undefined; // cortado: no está entero
  try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
}

class HookServer {
  constructor(dir, onEvent) {
    this.dir = dir;
    this.onEvent = onEvent;
    this.token = crypto.randomBytes(16).toString('hex');
    this.blockPrompts = false;
    this.mcp = null; // función (tabId, cuerpo) → { status, json }; la pone quien ofrezca herramientas
    this.respond = null; // función (tabId, evento) → objeto con el que contestar al hook, o null
    this.onStatus = null; // función (tabId, datos) con lo que Claude Code pasa a su línea de estado
    this.port = 0;
    this.server = null;
  }

  start() {
    // Los archivos de una ejecución anterior apuntan a un puerto que ya no existe.
    fs.rmSync(this.dir, { recursive: true, force: true });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  // Peticiones MCP de una sesión (herramientas que Claudes ofrece a Claude).
  handleMcp(req, res, tabId) {
    if (req.method !== 'POST') {
      // Sin canal de eventos del servidor: solo se atienden peticiones.
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
    });
    req.on('error', () => { /* conexión cortada */ });
    req.on('end', async () => {
      const reply = (status, json) => {
        if (res.writableEnded) return;
        if (json === undefined) { res.writeHead(status); res.end(); return; }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      // Si Claude Code deja de esperar (Esc), la herramienta se entera y puede parar.
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        const { status, json } = await this.mcp(tabId, body, controller.signal);
        reply(status, json);
      } catch (err) {
        reply(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String((err && err.message) || err) } });
      }
    });
  }

  // Datos de la línea de estado de una sesión (uso del contexto, modelo…), que la
  // línea de estado que pone Claudes envía con curl. No se muestra nada en ella.
  handleStatus(req, res, tabId) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 256 * 1024) chunks.push(chunk);
    });
    req.on('error', () => { /* conexión cortada */ });
    req.on('end', () => {
      res.writeHead(200);
      res.end();
      try {
        if (this.onStatus) this.onStatus(tabId, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch { /* datos que no se entienden: se ignoran */ }
    });
  }

  handle(req, res) {
    const mcpMatch = /^\/mcp\/([a-f0-9]+)\/([\w-]+)$/.exec(req.url || '');
    if (mcpMatch && mcpMatch[1] === this.token && this.mcp) {
      this.handleMcp(req, res, mcpMatch[2]);
      return;
    }
    const statusMatch = /^\/status\/([a-f0-9]+)\/([\w-]+)$/.exec(req.url || '');
    if (statusMatch && statusMatch[1] === this.token && req.method === 'POST') {
      this.handleStatus(req, res, statusMatch[2]);
      return;
    }
    const match = /^\/hook\/([a-f0-9]+)\/([\w-]+)\/(\w+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !match || match[1] !== this.token) {
      res.writeHead(404);
      res.end();
      return;
    }
    const [, , tabId, eventName] = match;
    const headLimit = eventName === 'PlanReview' ? PLAN_HEAD_LIMIT : HEAD_LIMIT;
    const chunks = [];
    let kept = 0;
    let total = 0;
    // De un aviso grande solo se guarda el principio, pero la ruta del archivo editado se
    // busca en todo él: si Claude escribe un archivo enorme, la entrada llega cortada y la
    // ruta puede ir antes o después del contenido. Se miran los trozos según llegan, con un
    // solape para no partir la ruta entre dos trozos.
    let editPath;
    let tail = '';
    // Salvo el resultado de una orden de Bash o PowerShell, que interesa entero (testcheck.js
    // mira cómo han ido las pruebas): si el aviso pasa del principio y es de una de ellas, se
    // sigue guardando hasta SHELL_BODY_LIMIT.
    const shellEvent = eventName === 'PostToolUse' || eventName === 'PostToolUseFailure';
    let keepAll = null; // null: aún no se sabe de qué herramienta es
    req.on('data', (chunk) => {
      total += chunk.length;
      if (kept < headLimit || (keepAll && kept < SHELL_BODY_LIMIT)) {
        chunks.push(chunk);
        kept += chunk.length;
      }
      if (shellEvent && keepAll === null && kept >= headLimit) {
        const tool = jsonField(Buffer.concat(chunks).toString('utf8'), 'tool_name');
        keepAll = tool === 'Bash' || tool === 'PowerShell';
      }
      if (editPath === undefined) {
        const text = tail + chunk.toString('latin1');
        const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
        if (m) {
          try { editPath = JSON.parse(Buffer.from(`"${m[1]}"`, 'latin1').toString('utf8')); } catch { editPath = null; }
        } else {
          tail = text.slice(-PATH_OVERLAP);
        }
      }
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const head = (body.length > headLimit && total > headLimit ? body.subarray(0, headLimit) : body).toString('utf8');
      let payload = {};
      let partial = false; // de una orden: ¿falta lo que escribió?
      if (total <= headLimit) {
        try { payload = JSON.parse(head); } catch { payload = {}; }
      } else if (keepAll && kept === total) {
        // El resultado de una orden, entero aunque sea grande.
        try { payload = JSON.parse(body.toString('utf8')); } catch { payload = {}; }
      } else {
        partial = keepAll === true; // una orden con una salida descomunal: no se tiene
        // Aviso grande (p. ej. la respuesta de leer un archivo): lo que interesa está al
        // principio. Claude Code manda primero los campos comunes (session_id, cwd…).
        for (const key of ['session_id', 'transcript_path', 'cwd', 'agent_id', 'agent_type', 'tool_name', 'tool_input', 'notification_type', 'tool_use_id']) {
          const value = jsonField(head, key);
          if (value !== undefined) payload[key] = value;
        }
        // Al escribir un archivo grande, la entrada llega cortada: basta con su ruta.
        // Solo en las herramientas de edición: en otras, un «file_path» puede venir de la
        // respuesta de la herramienta, no de lo que recibió.
        if (payload.tool_input === undefined && typeof editPath === 'string' && EDIT_TOOL_NAMES.includes(payload.tool_name)) {
          payload.tool_input = { file_path: editPath };
        }
      }
      // Un cuerpo que no es un objeto (null, una lista…) se trata como vacío.
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
      const rawPlan = eventName === 'PlanReview' && payload.tool_input && typeof payload.tool_input.plan === 'string' ? payload.tool_input.plan : null;
      const event = {
        event: eventName,
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
        notificationType: typeof payload.notification_type === 'string' ? payload.notification_type : null,
        message: typeof payload.message === 'string' ? payload.message.slice(0, 300) : null,
        toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
        toolInput: toolInputSummary(payload.tool_name, payload.tool_input),
        background: leavesRunning(payload.tool_name, payload.tool_input),
        // Para emparejar el antes y el después de una misma llamada.
        toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id.slice(0, 200) : null,
        // De una orden ya ejecutada: entera, con su salida (solo para el proceso principal).
        shell: shellResult(eventName, payload, partial),
        // Para el panel «Actividad» (solo para el proceso principal).
        narr: narration(eventName, payload),
        // Tras ejecutar una herramienta, el tamaño del aviso ≈ lo que recibió Claude.
        size: eventName === 'PostToolUse' ? total : null,
        prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 80) : null,
        // El mensaje entero (hasta 4 000 caracteres), para la crítica de un plan.
        request: eventName === 'UserPromptSubmit' && typeof payload.prompt === 'string' ? payload.prompt.slice(0, 4000) : null,
        // El plan que presenta Claude (solo en PlanReview).
        // Si no cabe entero, no se manda a medias: se marca como demasiado grande.
        plan: rawPlan !== null && rawPlan.length <= PLAN_MAX ? rawPlan : null,
        planTooBig: eventName === 'PlanReview' && (total > headLimit || (rawPlan !== null && rawPlan.length > PLAN_MAX)),
        // Carpeta de trabajo de la sesión (puede ser una subcarpeta del proyecto).
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        // En Stop: Claude ya sigue por una respuesta anterior a este mismo hook.
        stopHookActive: payload.stop_hook_active === true,
      };
      // Primero se avisa a la app, en el orden en que llegan los avisos: si se esperara a
      // la respuesta, uno lento (p. ej. tras una edición) podría pisar a otro posterior,
      // como el de «te necesita».
      try {
        if (eventName !== 'PlanReview') this.onEvent(tabId, event); // ese ya llega como PreToolUse
      } catch (err) {
        console.error('Aviso de hook no procesado:', err.message);
      }
      if (this.blockPrompts && eventName === 'UserPromptSubmit') {
        // Modo de pruebas: el mensaje se rechaza antes de llegar al modelo.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'block', reason: 'ClaudHome en modo de pruebas: mensaje no enviado.' }));
      } else {
        // Quien responde puede tardar un poco (p. ej. contar las líneas de un archivo; en
        // Stop, una revisión de Codex), pero nunca tanto como para que el hook caduque. Si
        // Claude Code deja de esperar (Esc, pestaña cerrada), se avisa con `signal`.
        // Si se agota la espera, también se avisa (y se contesta vacío): lo que llegue
        // después ya no llegaría a Claude.
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        let answer;
        let limit = null;
        let timedOut = false;
        try {
          answer = await Promise.race([
            Promise.resolve(this.respond ? this.respond(tabId, eventName, event, controller.signal) : null),
            new Promise((resolve) => {
              limit = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, LONG_EVENTS.has(eventName) ? STOP_RESPOND_LIMIT : RESPOND_LIMIT);
            }),
            // Si Claude Code deja de esperar, se deja de esperar también aquí.
            new Promise((resolve) => { controller.signal.addEventListener('abort', () => resolve(null), { once: true }); }),
          ]);
        } catch { answer = null; }
        clearTimeout(limit);
        if (timedOut) answer = null;
        if ((controller.signal.aborted && !timedOut) || res.writableEnded) return; // ya no hay a quién contestar
        if (answer) {
          // Por ejemplo, contexto adicional para Claude junto con el mensaje del usuario.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(answer));
        } else {
          // Respuesta vacía: Claude Code la trata como «sin nada que decir».
          res.writeHead(200);
          res.end();
        }
      }
    });
    req.on('error', () => { /* conexión cortada: se ignora */ });
  }

  // Escribe el archivo de ajustes de una pestaña y devuelve su ruta. `extra`
  // añade otros ajustes de Claude Code para esa sesión (por ejemplo, el dictado).
  settingsFile(tabId, extra = {}) {
    const hooks = {};
    for (const event of EVENTS) {
      const url = `http://127.0.0.1:${this.port}/hook/${this.token}/${tabId}/${event}`;
      hooks[event] = [{ hooks: [{ type: 'http', url, timeout: event === 'Stop' ? STOP_TIMEOUT : 5 }] }];
    }
    // Al presentar un plan, Codex lo critica antes (review.js): este aviso va aparte, con
    // su propia espera larga, y no se le pasa a la interfaz (ya llega el PreToolUse normal).
    const planUrl = `http://127.0.0.1:${this.port}/hook/${this.token}/${tabId}/PlanReview`;
    hooks.PreToolUse.push({ matcher: 'ExitPlanMode', hooks: [{ type: 'http', url: planUrl, timeout: STOP_TIMEOUT }] });
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${tabId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...extra, hooks }, null, 2));
    return file;
  }

  // Comando de la línea de estado de una pestaña: reenvía a la app lo que Claude Code
  // le pasa (curl viene con Windows y con Git Bash) y no escribe nada en pantalla.
  statusLineCommand(tabId) {
    return `curl -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${this.port}/status/${this.token}/${tabId}`;
  }

  // Archivo --mcp-config de una pestaña: apunta su sesión al servidor MCP de la app.
  mcpFile(tabId, serverName) {
    const url = `http://127.0.0.1:${this.port}/mcp/${this.token}/${tabId}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${tabId}.mcp.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [serverName]: { type: 'http', url } } }, null, 2));
    return file;
  }

  forget(tabId) {
    for (const name of [`${tabId}.json`, `${tabId}.mcp.json`]) {
      try { fs.unlinkSync(path.join(this.dir, name)); } catch { /* ya no estaba */ }
    }
  }
}

module.exports = { HookServer, jsonField, toolInputSummary, shellResult, narrInput, narration };
