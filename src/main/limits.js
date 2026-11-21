// Límites de uso del plan de Claude (el semanal y, si lo hay, el de 5 horas), tokens
// gastados en cada periodo y tokens de la conversación de cada pestaña, para la
// barra inferior.
//
// - El porcentaje usado y cuándo se renueva cada límite los da Claude Code a la línea
//   de estado (rate_limits.seven_day y rate_limits.five_hour) tras cada respuesta. Son
//   de la cuenta: incluyen lo usado en claude.ai o en otros equipos. Con una clave de
//   API no hay límites del plan y no llegan.
// - Los tokens se cuentan en las conversaciones que Claude Code guarda en este equipo
//   (~/.claude/projects/**/*.jsonl), dentro o fuera de ClaudHome. Cada respuesta del
//   modelo se apunta en varias líneas con el mismo uso, así que se cuenta una vez. Las
//   respuestas de los subagentes llevan el identificador de su conversación y suman en ella.
// - Los archivos se leen solo por donde iban la vez anterior: lo nuevo desde entonces.
// - Tras cada respuesta se miran solo las conversaciones de las pestañas abiertas; la
//   carpeta entera (lo de fuera de ClaudHome, las conversaciones nuevas) se recorre cada minuto.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOUR = 60 * 60 * 1000;
const WINDOWS = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };
const KEEP = 8 * 24 * HOUR; // respuestas que se guardan una a una (algo más de una semana)
const CHUNK = 4 * 1024 * 1024;
const SAME_WINDOW = 10 * 60 * 1000; // dos renovaciones tan cercanas son el mismo periodo
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// Conversación a la que pertenece un archivo: <id>.jsonl o <id>\subagents\agent-….jsonl.
function sessionOfFile(file) {
  const dir = path.dirname(file);
  if (path.basename(dir) === 'subagents') return path.basename(path.dirname(dir));
  return path.basename(file, '.jsonl');
}

const emptyTotals = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });

// Instante de renovación en milisegundos: Claude Code lo da en segundos desde 1970.
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isNaN(t) ? null : t; }
  return null;
}

// De lo que recibe la línea de estado, los límites del plan (o null si no los trae).
function limitsFromStatus(data) {
  const raw = data && data.rate_limits;
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of Object.keys(WINDOWS)) {
    const w = raw[key];
    const resetsAt = w && toMs(w.resets_at);
    if (!resetsAt || typeof w.used_percentage !== 'number') continue;
    out[key] = { pct: Math.max(0, Math.min(100, w.used_percentage)), resetsAt };
  }
  return Object.keys(out).length ? out : null;
}

// Archivos .jsonl de las conversaciones (incluidas las de los subagentes).
async function listTranscripts(dir, depth = 0, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (depth < 3) await listTranscripts(full, depth + 1, out); }
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

class Limits {
  // openSessions: función que devuelve un Map pestaña → conversación de las pestañas abiertas.
  constructor({ store, send, log, openSessions }) {
    this.store = store;
    this.send = send;
    this.log = log;
    this.openSessions = openSessions || (() => new Map());
    this.plan = store.get('planLimits', null); // { five_hour: { pct, resetsAt }, seven_day: {…} }
    this.files = new Map(); // archivo → bytes ya leídos
    this.skipped = new Set(); // archivos antiguos que no se han leído
    this.sessionFiles = new Map(); // conversación → sus archivos (el suyo y los de sus subagentes)
    this.answers = new Map(); // id de la respuesta → { t, session, input, output, cacheWrite, cacheRead }
    this.sessions = new Map(); // conversación → tokens de todas sus respuestas
    this.lastSent = '';
    this.running = null;
    this.fullPending = false;
    this.lastRun = 0;
    this.timer = null;
    this.ticker = null;
  }

  start() {
    // Cada minuto, el recorrido completo: lo gastado fuera de ClaudHome, las
    // conversaciones nuevas y el paso de la hora de renovación.
    this.ticker = setInterval(() => this.refresh({ full: true }), 60 * 1000);
    this.refresh({ full: true });
  }

  stop() {
    clearInterval(this.ticker);
    clearTimeout(this.timer);
  }

  // Datos de la línea de estado de cualquier pestaña: los límites son de la cuenta.
  fromStatus(data) {
    const fresh = limitsFromStatus(data);
    if (!fresh) return;
    const merged = { ...(this.plan || {}) };
    let changed = false;
    for (const [key, w] of Object.entries(fresh)) {
      const old = merged[key];
      // Una sesión parada puede repetir datos de un periodo ya pasado: manda el más reciente
      // y, dentro del mismo periodo, el porcentaje más alto (el uso solo sube).
      const same = old && Math.abs(old.resetsAt - w.resetsAt) < SAME_WINDOW;
      let next = old;
      if (!old || (!same && w.resetsAt > old.resetsAt)) next = w;
      else if (same && w.pct > old.pct) next = { pct: w.pct, resetsAt: old.resetsAt };
      if (next !== old) { merged[key] = next; changed = true; }
    }
    if (!changed) return;
    this.plan = merged;
    this.store.set('planLimits', merged);
    this.publish();
  }

  // Tras una respuesta llegan muchos avisos seguidos: se recuenta como mucho cada 10 s,
  // y solo las conversaciones de las pestañas abiertas.
  refreshSoon() {
    if (this.timer) return;
    const wait = Math.max(0, 10 * 1000 - (Date.now() - this.lastRun));
    this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, wait);
  }

  // full: recorre toda la carpeta de conversaciones; si no, solo las de las pestañas abiertas.
  refresh({ full = false } = {}) {
    if (this.running) {
      if (full) this.fullPending = true; // el completo se hace al acabar el que está en marcha
      return this.running;
    }
    this.running = this.scan(full)
      .catch((err) => this.log(`límites de uso: no se han podido contar los tokens (${err.message})`))
      .then(() => this.publish())
      .finally(() => {
        this.running = null;
        this.lastRun = Date.now();
        if (this.fullPending) { this.fullPending = false; this.refresh({ full: true }); }
      });
    return this.running;
  }

  // Archivos de las conversaciones abiertas en una pestaña: los que ya se conocen y los
  // subagentes nuevos de cada una. Devuelve null si alguna todavía no se ha visto (una
  // conversación recién creada): entonces hay que recorrerlo todo para encontrarla.
  async openFiles(open) {
    const files = new Set();
    for (const session of open) {
      const known = this.sessionFiles.get(session);
      if (!known) return null;
      for (const file of known) {
        files.add(file);
        if (path.basename(file) === `${session}.jsonl`) {
          for (const sub of await listTranscripts(path.join(path.dirname(file), session), 2)) files.add(sub);
        }
      }
    }
    return [...files];
  }

  // Lee lo que se ha añadido a las conversaciones desde la vez anterior. Los archivos
  // antiguos se saltan, salvo los de las conversaciones abiertas en una pestaña; si uno
  // saltado vuelve a crecer (se ha retomado), se lee entero.
  async scan(full) {
    const since = Date.now() - KEEP;
    const open = new Set([...this.openSessions().values()].filter(Boolean));
    const files = (!full && await this.openFiles(open)) || await listTranscripts(projectsDir());
    for (const file of files) {
      let st;
      try { st = await fs.promises.stat(file); } catch { continue; }
      const session = sessionOfFile(file);
      if (!this.sessionFiles.has(session)) this.sessionFiles.set(session, new Set());
      this.sessionFiles.get(session).add(file);
      const known = this.files.has(file);
      let offset = this.files.get(file) || 0;
      if (this.skipped.has(file) && (st.size !== offset || open.has(session))) {
        this.skipped.delete(file);
        offset = 0;
      }
      if (st.size < offset) offset = 0; // archivo reescrito: se lee de nuevo
      if (known && st.size === offset) continue;
      if (!known && st.mtimeMs < since && !open.has(session)) {
        this.files.set(file, st.size);
        this.skipped.add(file);
        continue;
      }
      this.files.set(file, await this.readFrom(file, offset, st.size));
    }
    for (const [key, answer] of this.answers) if (answer.t < since) this.answers.delete(key);
  }

  // Devuelve hasta dónde se ha leído: el final de la última línea completa.
  async readFrom(file, start, end) {
    let handle;
    try { handle = await fs.promises.open(file, 'r'); } catch { return start; }
    let pos = start;
    let carry = Buffer.alloc(0);
    try {
      while (pos < end) {
        const buffer = Buffer.alloc(Math.min(CHUNK, end - pos));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        const cut = data.lastIndexOf(0x0a);
        if (cut < 0) { carry = data; continue; }
        for (const line of data.subarray(0, cut).toString('utf8').split('\n')) this.take(line, sessionOfFile(file));
        carry = data.subarray(cut + 1);
      }
    } finally {
      await handle.close();
    }
    return pos - carry.length; // una línea a medio escribir se leerá la próxima vez
  }

  take(line, fileSession) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    const message = entry && entry.type === 'assistant' && entry.message;
    const u = message && message.usage;
    const t = Date.parse(entry.timestamp);
    if (!u || Number.isNaN(t) || message.model === '<synthetic>') return;
    const key = message.id ? `${message.id}:${entry.requestId || ''}` : entry.uuid;
    if (!key) return;
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const session = typeof entry.sessionId === 'string' ? entry.sessionId : fileSession;
    const next = {
      t,
      session,
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      cacheRead: n(u.cache_read_input_tokens),
    };
    const old = this.answers.get(key);
    if (old) {
      // Las líneas de una misma respuesta repiten el uso; la última puede traer más salida.
      for (const f of FIELDS) next[f] = Math.max(next[f], old[f]);
      next.t = Math.min(t, old.t);
      next.session = old.session;
    }
    this.answers.set(key, next);
    // Tokens de la conversación: lo que aporta esta línea respecto a lo ya contado.
    if (!this.sessions.has(next.session)) this.sessions.set(next.session, emptyTotals());
    const totals = this.sessions.get(next.session);
    for (const f of FIELDS) {
      const delta = next[f] - (old ? old[f] : 0);
      totals[f] += delta;
      totals.total += delta;
    }
  }

  tokensBetween(from, to) {
    const sum = emptyTotals();
    for (const a of this.answers.values()) {
      if (a.t < from || a.t >= to) continue;
      for (const f of FIELDS) { sum[f] += a[f]; sum.total += a[f]; }
    }
    return sum;
  }

  // Lo que muestra la barra inferior. Pasada la hora de renovación, el periodo nuevo
  // empieza con el siguiente mensaje: hasta que llegue su porcentaje, solo hay tokens.
  snapshot() {
    const now = Date.now();
    let plan = null;
    if (this.plan) {
      plan = {};
      for (const [key, length] of Object.entries(WINDOWS)) {
        const w = this.plan[key];
        if (!w) continue;
        const expired = now >= w.resetsAt;
        plan[key] = {
          pct: expired ? null : Math.round(w.pct),
          resetsAt: w.resetsAt,
          expired,
          tokens: expired ? this.tokensBetween(w.resetsAt, now + HOUR) : this.tokensBetween(w.resetsAt - length, w.resetsAt),
        };
      }
      if (!Object.keys(plan).length) plan = null;
    }
    const conversations = {};
    for (const [tabId, session] of this.openSessions()) {
      const totals = session && this.sessions.get(session);
      if (totals) conversations[tabId] = { ...totals };
    }
    return { plan, conversations };
  }

  publish() {
    const snap = this.snapshot();
    const text = JSON.stringify(snap);
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.send('limits:update', snap);
  }
}

module.exports = { Limits, limitsFromStatus };
