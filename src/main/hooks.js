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

class HookServer {
  constructor(dir, onEvent) {
    this.dir = dir;
    this.onEvent = onEvent;
    this.token = crypto.randomBytes(16).toString('hex');
    this.blockPrompts = false;
    this.mcp = null; // función (tabId, cuerpo) → { status, json }; la pone quien ofrezca herramientas
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

  handle(req, res) {
    const mcpMatch = /^\/mcp\/([a-f0-9]+)\/([\w-]+)$/.exec(req.url || '');
    if (mcpMatch && mcpMatch[1] === this.token && this.mcp) {
      this.handleMcp(req, res, mcpMatch[2]);
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
        res.end(JSON.stringify({ decision: 'block', reason: 'Claudes en modo de pruebas: mensaje no enviado.' }));
      } else {
        // Respuesta vacía: Claude Code la trata como «sin nada que decir».
        res.writeHead(200);
        res.end();
      }
      const head = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      if (total <= HEAD_LIMIT) {
        try { payload = JSON.parse(head); } catch { payload = {}; }
      } else {
        const id = /"session_id"\s*:\s*"([^"]+)"/.exec(head);
        if (id) payload.session_id = id[1];
      }
      try {
        this.onEvent(tabId, {
          event: eventName,
          sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
          notificationType: typeof payload.notification_type === 'string' ? payload.notification_type : null,
          message: typeof payload.message === 'string' ? payload.message.slice(0, 300) : null,
          toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
          prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 80) : null,
        });
      } catch (err) {
        console.error('Aviso de hook no procesado:', err.message);
      }
    });
    req.on('error', () => { /* conexión cortada: se ignora */ });
  }

  // Escribe el archivo de ajustes de una pestaña y devuelve su ruta.
  settingsFile(tabId) {
    const hooks = {};
    for (const event of EVENTS) {
      const url = `http://127.0.0.1:${this.port}/hook/${this.token}/${tabId}/${event}`;
      hooks[event] = [{ hooks: [{ type: 'http', url, timeout: 5 }] }];
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${tabId}.json`);
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
    return file;
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
