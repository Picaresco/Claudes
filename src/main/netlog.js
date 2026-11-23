// Registro de lo que sale de este equipo a través de Claude («Log»).
//
// - Lo que ha visto Claude: todo lo que una herramienta le devuelve (un archivo
//   leído, una búsqueda en archivos, la salida de un comando, la respuesta de un
//   servidor MCP…) viaja a Anthropic como parte de la conversación.
// - Lo que además sale directamente hacia internet: páginas web (WebFetch),
//   búsquedas (WebSearch), herramientas de servidores MCP remotos y comandos con red.
//
// Sale del hook PostToolUse: solo cuenta lo que se ha ejecutado de verdad, y el
// tamaño del aviso da una idea de cuánto recibió Claude. Los secretos de comandos y
// direcciones (tokens, contraseñas, cabeceras Authorization…) se tapan antes de
// mostrarlos o guardarlos. Las repeticiones del mismo elemento en pocos minutos se
// agrupan con un contador. Cada entrada queda también en <datos>\logs\salidas-<fecha>.log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayStamp, clock } = require('./applog');
// Servidor MCP propio de ClaudHome (Codex: imágenes y segunda opinión).
const OWN_MCP = 'claudhome-codex';

const MAX_ENTRIES = 3000;
const GROUP_MS = 5 * 60 * 1000;

const KIND_LABEL = {
  archivo: 'Archivo leído',
  grep: 'Búsqueda en archivos',
  comando: 'Comando',
  mcp: 'Herramienta MCP',
  web: 'Página web',
  busqueda: 'Búsqueda en internet',
  revision: 'Revisión de Codex',
  opinion: 'Segunda opinión de Codex',
  plan: 'Crítica de un plan (Codex)',
  imagen: 'Imagen con Codex',
};

// ── Direcciones locales o de internet ────────────────────────────────

function isPublic(ip) {
  const v = String(ip || '').toLowerCase();
  if (!v) return false;
  if (v.includes(':')) {
    if (v.startsWith('::ffff:')) return isPublic(v.slice(7));
    if (v === '::' || v === '::1' || /^fe[89ab]/.test(v) || /^f[cd]/.test(v)) return false;
    return true;
  }
  const [a, b] = v.split('.').map(Number);
  if ([0, 10, 127].includes(a) || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}

// ¿Un nombre o una dirección de fuera de la red local?
function isPublicHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || !h.includes('.')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPublic(h);
  return true;
}

// Comandos que salen a la red. Si solo mencionan direcciones locales, no cuentan.
const NETWORK_COMMAND = /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer|WebClient|git\s+(push|pull|fetch|clone|ls-remote|submodule)|npm\s+(i|install|ci|publish|update|view|outdated)|npx\s|pnpm\s+(add|install|i)|yarn\s+(add|install)|pip3?\s+(install|download)|uv\s+(pip|add|sync|tool)|winget|choco|scoop|ssh\s|scp\s|sftp\s|ftp\s|gh\s|az\s|aws\s|gcloud\s|docker\s+(pull|push|login))\b/i;

function commandTargets(command) {
  const hosts = [];
  for (const m of String(command).matchAll(/\bhttps?:\/\/([^\s/:'"]+)/gi)) hosts.push(m[1]);
  for (const m of String(command).matchAll(/@([\w.-]+\.[a-z][\w.-]*)/gi)) hosts.push(m[1]);
  for (const m of String(command).matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) hosts.push(m[1]);
  return hosts;
}

// Destinos de internet de un comando: null si no sale de la red local.
function externalTargets(command) {
  if (!NETWORK_COMMAND.test(command)) return null;
  const hosts = commandTargets(command);
  if (hosts.length && hosts.every((h) => !isPublicHost(h))) return null; // solo red local (p. ej. ssh a un switch)
  const outside = [...new Set(hosts.filter(isPublicHost))];
  return outside.length ? outside : ['internet'];
}

// ── Secretos ─────────────────────────────────────────────────────────

// Tapa tokens, contraseñas y credenciales en comandos y direcciones.
function redact(text) {
  return String(text || '')
    // Credenciales en una URL: https://usuario:clave@servidor
    .replace(/\b([a-z][\w+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, '$1****:****@')
    // Cabeceras Authorization y tokens Bearer/Basic
    .replace(/(authorization\s*[:=]\s*)(bearer|basic|token|digest)?\s*[^\s'"]+/gi, (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}****`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ****')
    // Parámetros de URL con secretos
    .replace(/([?&](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|password|passwd|sig|signature|code|auth)=)[^&\s'"]+/gi, '$1****')
    // clave=valor, clave: valor o -Clave valor en comandos
    .replace(/(\b|-{1,2})(password|passwd|pwd|pass|token|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|community)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s&'",;]+)/gi, '$1$2$3****')
    // usuario:clave en -u/--user (curl, wget…), sshpass -p clave, ConvertTo-SecureString "clave"
    .replace(/(\s(?:-u|--user|--proxy-user)\s+["']?)([^\s:"']+):([^\s"']+)/gi, '$1$2:****')
    .replace(/\b(sshpass\s+-p\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1****')
    .replace(/(ConvertTo-SecureString\s+(?:-String\s+)?)("[^"]*"|'[^']*')/gi, '$1"****"')
    // Claves con prefijos conocidos (Anthropic, OpenAI, GitHub, Slack, AWS)
    .replace(/\b(sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g, '****');
}

class NetLog {
  // send(canal, …) avisa a la interfaz; tabName(id) da el nombre de una pestaña;
  // cwdOf(id) su carpeta (para leer la configuración MCP del proyecto).
  constructor({ logsDir, send, tabName, cwdOf }) {
    this.logsDir = logsDir;
    this.send = send;
    this.tabName = tabName;
    this.cwdOf = cwdOf;
    this.list = [];
    this.nextId = 1;
    this.groups = new Map(); // clave → entrada reciente que se puede agrupar
    this.mcpCache = new Map(); // carpeta → { at, servers }
  }

  entries() {
    return this.list.slice();
  }

  // Lo que Claude recibió de una herramienta propia: se suma a su última salida a Codex.
  addSize(tabId, size) {
    if (!size) return;
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      const entry = this.list[i];
      if (entry.tabId !== tabId || !['opinion', 'imagen'].includes(entry.kind)) continue;
      if (Date.now() - entry.last > GROUP_MS * 3) return;
      entry.size += size;
      this.send('netlog:update', entry);
      return;
    }
  }

  record({ tabId, kind, target, detail = '', dest, external = false, size = 0 }) {
    const now = Date.now();
    const safeTarget = redact(target).slice(0, 600);
    const safeDetail = redact(detail).slice(0, 400);
    const key = `${tabId}|${kind}|${safeTarget}`;
    const recent = this.groups.get(key);
    if (recent && now - recent.last < GROUP_MS) {
      recent.count += 1;
      recent.last = now;
      recent.size += size;
      this.send('netlog:update', recent);
      return recent;
    }
    const entry = {
      id: this.nextId++,
      time: now,
      last: now,
      count: 1,
      tabId,
      tabName: this.tabName(tabId) || 'Pestaña',
      cwd: this.cwdOf(tabId) || null, // carpeta del proyecto: el «Log» filtra por ella
      kind,
      what: KIND_LABEL[kind] || kind,
      target: safeTarget,
      detail: safeDetail,
      dest,
      external,
      size,
    };
    this.groups.set(key, entry);
    this.list.push(entry);
    if (this.list.length > MAX_ENTRIES) this.list.splice(0, this.list.length - MAX_ENTRIES);
    this.writeFile(entry);
    this.send('netlog:entry', entry);
    return entry;
  }

  todayFile(date = new Date()) {
    return path.join(this.logsDir(), `salidas-${dayStamp(date)}.log`);
  }

  writeFile(entry) {
    try {
      const d = new Date(entry.time);
      fs.mkdirSync(this.logsDir(), { recursive: true });
      const size = !entry.size ? '' : entry.size < 1024 ? ' · < 1 KB' : ` · ≈ ${Math.round(entry.size / 1024)} KB`;
      fs.appendFileSync(this.todayFile(d), `${clock(d)} ${entry.tabName} · ${entry.what} · ${entry.target} → ${entry.dest}${size}${entry.detail ? ` · ${entry.detail}` : ''}\n`);
    } catch { /* sin archivo, se sigue */ }
  }

  // Servidores MCP de la configuración de Claude Code que son remotos: nombre → dominio.
  remoteMcp(cwd) {
    const cached = this.mcpCache.get(cwd || '');
    if (cached && Date.now() - cached.at < 30000) return cached.servers;
    const servers = new Map();
    const add = (list) => {
      for (const [name, s] of Object.entries(list || {})) {
        if (!s || typeof s.url !== 'string') continue;
        try { const host = new URL(s.url).hostname; if (isPublicHost(host)) servers.set(name, host); } catch { /* URL rara */ }
      }
    };
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'), 'utf8'));
      add(cfg.mcpServers);
      if (cwd && cfg.projects) {
        const wanted = path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
        for (const [key, project] of Object.entries(cfg.projects)) {
          if (key.replace(/\\/g, '/').toLowerCase() === wanted) add(project && project.mcpServers);
        }
      }
    } catch { /* sin configuración */ }
    if (cwd) {
      try { add(JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers); } catch { /* sin .mcp.json */ }
    }
    this.mcpCache.set(cwd || '', { at: Date.now(), servers });
    return servers;
  }

  // Una herramienta que Claude acaba de usar (hook PostToolUse).
  fromHook(tabId, ev) {
    if (!ev || ev.event !== 'PostToolUse' || !ev.toolName) return;
    const input = ev.toolInput || {};
    const tool = ev.toolName;
    const size = ev.size || 0;
    const base = { tabId, size };
    if (tool === 'Read' && input.file) {
      const part = input.pages ? `páginas ${input.pages}` : input.offset || input.limit ? `desde la línea ${input.offset || 1}` : '';
      this.record({ ...base, kind: 'archivo', target: input.file, detail: part, dest: 'Anthropic' });
    } else if (tool === 'Grep' && input.pattern) {
      this.record({ ...base, kind: 'grep', target: `«${input.pattern}»${input.path ? ` en ${input.path}` : ''}`, dest: 'Anthropic' });
    } else if ((tool === 'Bash' || tool === 'PowerShell') && input.command) {
      const outside = externalTargets(input.command);
      this.record({ ...base, kind: 'comando', target: input.command, detail: tool, dest: outside ? `${outside.join(', ')} y Anthropic` : 'Anthropic', external: Boolean(outside) });
    } else if (tool === 'WebFetch' && input.url) {
      let host = '';
      try { host = new URL(input.url).hostname; } catch { /* sin dominio */ }
      const outside = !host || isPublicHost(host);
      this.record({ ...base, kind: 'web', target: input.url, detail: input.prompt || '', dest: outside ? `${host || 'internet'} y Anthropic` : 'Anthropic', external: outside });
    } else if (tool === 'WebSearch' && input.query) {
      this.record({ ...base, kind: 'busqueda', target: input.query, detail: 'La búsqueda la hace Anthropic desde sus servidores', dest: 'Anthropic', external: true });
    } else if (tool.startsWith('mcp__')) {
      const [, server = '', name = ''] = /^mcp__(.+?)__(.+)$/.exec(tool) || [];
      if (!server) return;
      if (server === OWN_MCP) { this.addSize(tabId, size); return; } // el de ClaudHome ya anotó adónde va (OpenAI)
      const host = server.startsWith('claude_ai_') ? 'claude.ai' : this.remoteMcp(this.cwdOf(tabId)).get(server) || null;
      this.record({ ...base, kind: 'mcp', target: `${server} · ${name}`, detail: input.summary || '', dest: host ? `${host} y Anthropic` : 'Anthropic', external: Boolean(host) });
    }
  }
}

module.exports = { OWN_MCP, NetLog, redact, isPublic, isPublicHost, externalTargets };
