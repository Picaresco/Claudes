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
];

const HEAD_LIMIT = 64 * 1024; // de cada aviso solo interesa el principio

// De la entrada de una herramienta, solo lo que necesita el registro («Log»,
// netlog.js): el archivo, la dirección, la búsqueda, el comando o un resumen del MCP.
function toolInputSummary(tool, input) {
  if (typeof tool !== 'string' || !input || typeof input !== 'object') return null;
  const text = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);
  if (tool === 'Read') return { file: text(input.file_path, 600), pages: text(input.pages, 40), offset: input.offset || null, limit: input.limit || null };
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
      try {
        const { status, json } = await this.mcp(tabId, body);
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
    const chunks = [];
    let kept = 0;
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (kept < HEAD_LIMIT) {
        chunks.push(chunk);
        kept += chunk.length;
      }
    });
    req.on('end', () => {
      if (this.blockPrompts && eventName === 'UserPromptSubmit') {
        // Modo de pruebas: el mensaje se rechaza antes de llegar al modelo.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'block', reason: 'ClaudHome en modo de pruebas: mensaje no enviado.' }));
      } else {
        let answer = null;
        try { answer = this.respond ? this.respond(tabId, eventName) : null; } catch { answer = null; }
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
      const head = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      if (total <= HEAD_LIMIT) {
        try { payload = JSON.parse(head); } catch { payload = {}; }
      } else {
        // Aviso grande (p. ej. la respuesta de leer un archivo): lo que interesa está al principio.
        for (const key of ['session_id', 'tool_name', 'tool_input', 'notification_type']) {
          const value = jsonField(head, key);
          if (value !== undefined) payload[key] = value;
        }
      }
      try {
        this.onEvent(tabId, {
          event: eventName,
          sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
          notificationType: typeof payload.notification_type === 'string' ? payload.notification_type : null,
          message: typeof payload.message === 'string' ? payload.message.slice(0, 300) : null,
          toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
          toolInput: toolInputSummary(payload.tool_name, payload.tool_input),
          // Tras ejecutar una herramienta, el tamaño del aviso ≈ lo que recibió Claude.
          size: eventName === 'PostToolUse' ? total : null,
          prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 80) : null,
        });
      } catch (err) {
        console.error('Aviso de hook no procesado:', err.message);
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
      hooks[event] = [{ hooks: [{ type: 'http', url, timeout: 5 }] }];
    }
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

module.exports = { HookServer };
