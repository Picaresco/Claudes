// Contexto del proyecto de cada pestaña: una nota del usuario y una lista de
// documentos y carpetas que Claude tiene presentes en todas las sesiones.
//
// - Al arrancar una sesión, el resumen (nota + lista con rutas) se escribe en
//   <datos>\contexto\<pestaña>\instrucciones.md y se pasa a Claude con
//   --append-system-prompt-file. Claude no lee los documentos por adelantado:
//   los abre con Read cuando la tarea los necesita.
// - Para que pueda leerlos sin pedir permiso, cada documento o carpeta lleva su
//   regla Read(...) en los ajustes de la sesión (permissions.allow).
// - Los Word se pasan a texto (Claude no lee .docx) y se guardan junto al resumen.
// - También admite enlaces web: Claude los abre con WebFetch cuando le hacen falta,
//   con permiso por dominio (WebFetch(domain:…)). Al añadirlos se lee el título.
// - Si el contexto cambia con la sesión abierta, el hook UserPromptSubmit le da
//   a Claude el resumen nuevo con el siguiente mensaje (pendingUpdate).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;
const WORD = /\.docx$/i;
const TEXT = /\.(txt|md|markdown|csv|tsv|log|json|jsonl|xml|ya?ml|ini|cfg|conf|toml|env|js|mjs|cjs|ts|tsx|jsx|py|ps1|psm1|sh|bat|cmd|sql|html?|css|scss|less|c|h|cpp|hpp|cs|java|kt|go|rs|rb|php|vue|svelte)$/i;
const MAX_NOTE = 8000;
const MAX_ITEMS = 100;
const MAX_COUNT = 2000; // archivos que se cuentan como mucho en una carpeta

// ── Word (.docx) a texto ─────────────────────────────────────────────
// Un .docx es un zip; el texto está en word/document.xml.

function readZipEntry(buffer, wanted) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    // Algunos programas guardan las rutas internas con «\» en vez de «/».
    if (buffer.toString('utf8', p + 46, p + 46 + nameLength).replace(/\\/g, '/') === wanted) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function docxToText(file) {
  const xml = readZipEntry(fs.readFileSync(file), 'word/document.xml');
  if (!xml) throw new Error('no parece un documento de Word');
  return xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>') // una fila de tabla en una sola línea
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:(p|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/ \| \n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Utilidades ───────────────────────────────────────────────────────

function kindOf(file, isDir) {
  if (isDir) return 'carpeta';
  if (PDF.test(file)) return 'PDF';
  if (WORD.test(file)) return 'Word';
  if (IMAGE.test(file)) return 'imagen';
  if (TEXT.test(file)) return 'texto';
  return 'archivo';
}

// Regla de permiso de Claude Code para una ruta de Windows: las rutas se comparan
// en forma POSIX (C:\Docs\x.pdf → //c/Docs/x.pdf). Con comodines en el nombre no
// se puede expresar sin ambigüedad: entonces Claude preguntará al leerla.
function readRule(target, isDir) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(target);
  if (!m || /[*?[\]]/.test(target)) return null;
  const posix = `//${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/').replace(/\/+$/, '')}`;
  return `Read(${isDir ? `${posix}/**` : posix})`;
}

async function countFiles(dir) {
  let count = 0;
  const pending = [dir];
  while (pending.length && count < MAX_COUNT) {
    const current = pending.pop();
    let entries = [];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else count += 1;
    }
  }
  return count;
}

const safeName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);

const isLink = (item) => Boolean(item) && typeof item.url === 'string';

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Título de una página: og:title o <title>, sin entidades HTML.
function parseTitle(html) {
  const decode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = (og && og[1]) || (tag && tag[1]) || '';
  const title = decode(raw).replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 160) : null;
}

// Lo que se compara para saber si el contexto ha cambiado (el nombre de la pestaña no cuenta).
function signature(context) {
  const note = String((context && context.note) || '').trim();
  const items = ((context && context.items) || []).filter((i) => i && i.enabled !== false)
    .map((i) => (isLink(i) ? `${i.url} ${i.title || ''}` : i.path));
  return crypto.createHash('sha1').update(JSON.stringify({ note, items })).digest('hex');
}

function createContext({ app, net, log }) {
  const baseDir = () => path.join(app.getPath('userData'), 'contexto');
  const dirFor = (tabId) => path.join(baseDir(), String(tabId).replace(/[^\w-]/g, '_'));
  const sessions = new Map(); // pestaña → { delivered, current, text }

  // Datos de cada elemento para el panel: si existe, qué es, tamaño, archivos…
  async function describe(items) {
    const list = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
    return Promise.all(list.map(async (item) => {
      if (isLink(item)) {
        const host = hostOf(item.url);
        return { url: item.url, isLink: true, exists: Boolean(host), kind: 'web', host, name: item.title || host || item.url };
      }
      const target = item && typeof item.path === 'string' ? item.path : '';
      const info = { path: target, name: path.basename(target.replace(/[\\/]+$/, '')) || target, exists: false, isDir: false, kind: 'archivo', size: 0, files: 0 };
      try {
        const st = await fs.promises.stat(target);
        info.exists = true;
        info.isDir = st.isDirectory();
        info.size = st.size;
        info.kind = kindOf(target, info.isDir);
        if (info.isDir) info.files = await countFiles(target);
      } catch { /* no existe o no se puede leer */ }
      info.many = info.isDir && info.files >= MAX_COUNT;
      return info;
    }));
  }

  // Texto de un Word, guardado junto al resumen; se rehace si el Word es más nuevo.
  async function wordText(tabId, file) {
    const out = path.join(dirFor(tabId), `${safeName(path.basename(file))}.md`);
    try {
      const [src, dst] = await Promise.all([fs.promises.stat(file), fs.promises.stat(out).catch(() => null)]);
      if (!dst || dst.mtimeMs < src.mtimeMs) {
        const text = docxToText(file);
        await fs.promises.mkdir(dirFor(tabId), { recursive: true });
        await fs.promises.writeFile(out, `# Texto de ${file}\n\n(Extraído por ClaudHome del documento de Word.)\n\n${text}\n`, 'utf8');
      }
      return out;
    } catch (err) {
      log(`contexto: no se pudo pasar a texto ${file} (${err.message})`);
      return null;
    }
  }

  // Resumen que recibe Claude, reglas de lectura y firma del contexto.
  async function build(tabId, tabName, context) {
    const note = String((context && context.note) || '').trim().slice(0, MAX_NOTE);
    const enabled = ((context && context.items) || []).filter((i) => i && i.enabled !== false && (isLink(i) || typeof i.path === 'string'));
    const infos = (await describe(enabled)).filter((i) => i.exists);
    const allow = [];
    const lines = [];
    const links = [];
    let wordDir = false;
    for (const info of infos) {
      if (info.isLink) {
        const item = enabled.find((i) => isLink(i) && i.url === info.url);
        links.push(`- ${info.url}${item && item.title ? ` — «${item.title}»` : ''}`);
        const rule = `WebFetch(domain:${info.host})`;
        if (!allow.includes(rule)) allow.push(rule);
        continue;
      }
      const rule = readRule(info.path, info.isDir);
      if (rule) allow.push(rule);
      if (info.isDir) {
        const count = info.many ? `más de ${MAX_COUNT} archivos` : `${info.files} archivo${info.files === 1 ? '' : 's'}`;
        lines.push(`- ${info.path}\\ — carpeta con ${count}`);
      } else if (info.kind === 'Word') {
        const text = await wordText(tabId, info.path);
        if (text) wordDir = true;
        lines.push(`- ${info.path} — documento de Word${text ? `; su texto está en ${text}` : ''}`);
      } else {
        lines.push(`- ${info.path} — ${info.kind}`);
      }
    }
    if (wordDir) { const rule = readRule(dirFor(tabId), true); if (rule) allow.push(rule); }
    if (!note && !lines.length && !links.length) return { text: '', allow, hash: signature(context) };
    const parts = [
      `# Contexto del proyecto «${tabName || 'sin nombre'}»`,
      'El usuario ha preparado este contexto en ClaudHome para esta pestaña. Tenlo presente durante toda la sesión.',
    ];
    if (note) parts.push(`## Nota del usuario\n${note}`);
    if (lines.length) {
      parts.push(`## Documentos de referencia\nNo hace falta leerlos de antemano: ábrelos con la herramienta Read cuando sean relevantes para lo que te pidan.\n${lines.join('\n')}`);
    }
    if (links.length) {
      parts.push(`## Enlaces de referencia\nPáginas web que el usuario considera útiles para este proyecto. No hace falta abrirlas de antemano: ábrelas con la herramienta WebFetch cuando sean relevantes.\n${links.join('\n')}`);
    }
    return { text: `${parts.join('\n\n')}\n`, allow, hash: signature(context) };
  }

  // Al arrancar una sesión: escribe el resumen y devuelve lo que hay que pasarle a Claude.
  async function prepare(tabId, tabName, context) {
    const built = await build(tabId, tabName, context);
    let promptFile = null;
    if (built.text) {
      await fs.promises.mkdir(dirFor(tabId), { recursive: true });
      promptFile = path.join(dirFor(tabId), 'instrucciones.md');
      await fs.promises.writeFile(promptFile, built.text, 'utf8');
    }
    sessions.set(tabId, { delivered: built.hash, current: built.hash, text: built.text });
    return { promptFile, allow: built.allow, text: built.text };
  }

  // El contexto ha cambiado (con o sin sesión abierta). Devuelve las reglas nuevas.
  async function update(tabId, tabName, context) {
    const built = await build(tabId, tabName, context);
    const state = sessions.get(tabId);
    if (state) {
      state.current = built.hash;
      state.text = built.text;
    }
    if (built.text) {
      await fs.promises.mkdir(dirFor(tabId), { recursive: true });
      await fs.promises.writeFile(path.join(dirFor(tabId), 'instrucciones.md'), built.text, 'utf8');
    }
    return { allow: built.allow, text: built.text };
  }

  // Para el hook UserPromptSubmit: si el contexto cambió desde que Claude lo
  // recibió, la respuesta que se lo cuenta (una sola vez).
  function pendingUpdate(tabId) {
    const state = sessions.get(tabId);
    if (!state || state.current === state.delivered) return null;
    state.delivered = state.current;
    log(`contexto: se le da a Claude el contexto actualizado de la pestaña ${tabId}`);
    const additionalContext = state.text
      ? `ClaudHome: el usuario ha cambiado el contexto del proyecto con la sesión abierta. Este es el contexto actualizado, que sustituye al que recibiste al empezar (si un documento nuevo no se puede leer, pide permiso al usuario):\n\n${state.text}`
      : 'ClaudHome: el usuario ha quitado el contexto del proyecto que recibiste al empezar. Ya no lo tengas en cuenta.';
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
  }

  // Descarga el principio de una página siguiendo las redirecciones a mano: así se
  // sabe dónde termina (net.fetch de Electron no informa de la dirección final).
  // Usa la red de Chromium, con el proxy del sistema.
  function download(url) {
    return new Promise((resolve) => {
      let finalUrl = url;
      let hops = 0;
      let done = false;
      const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const request = net.request({ url, redirect: 'manual' });
      const timer = setTimeout(() => { request.abort(); finish({ error: 'La página no responde.' }); }, 10000);
      request.on('redirect', (_status, _method, redirectUrl) => {
        hops += 1;
        if (hops > 8) { request.abort(); finish({ error: 'Demasiadas redirecciones.' }); return; }
        finalUrl = redirectUrl;
        request.followRedirect();
      });
      request.on('response', (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => { if (size < 400000) { chunks.push(chunk); size += chunk.length; } });
        response.on('end', () => {
          const type = [].concat(response.headers['content-type'] || '').join(';');
          finish({ status: response.statusCode, type, body: Buffer.concat(chunks).toString('utf8'), finalUrl });
        });
        response.on('error', (err) => finish({ error: `No se ha podido leer (${err.message}).` }));
      });
      request.on('error', (err) => finish({ error: `No se ha podido abrir (${err.message}).` }));
      request.end();
    });
  }

  // Al añadir un enlace: título de la página y si parece pedir iniciar sesión
  // (en ese caso Claude no podrá leerla). Lo pide este equipo, como lo haría Claude.
  async function linkInfo(url) {
    let target;
    try { target = new URL(String(url).trim()); } catch { return { ok: false, error: 'No es una dirección web válida.' }; }
    if (!/^https?:$/.test(target.protocol)) return { ok: false, error: 'Solo se admiten enlaces http:// o https://.' };
    const res = await download(target.href);
    if (res.error) return { ok: false, error: res.error };
    let title = null;
    if (/html/i.test(res.type)) title = parseTitle(res.body);
    else if (/pdf/i.test(res.type)) title = decodeURIComponent(new URL(res.finalUrl).pathname.split('/').pop() || '') || null;
    const where = (() => { try { const u = new URL(res.finalUrl); return `${u.hostname}${u.pathname}`; } catch { return ''; } })();
    const movedToLogin = res.finalUrl !== target.href && /(login|signin|sign-in|logon|auth|sso|adfs|oauth)/i.test(where);
    const login = res.status === 401 || res.status === 403 || movedToLogin;
    const ok = res.status >= 200 && res.status < 400 && !login;
    // Con login o con error, el título sería el de la pantalla de acceso o de error: no sirve.
    return { ok, status: res.status, title: ok ? title : null, finalUrl: res.finalUrl, login };
  }

  // Pestaña cerrada: se borra lo generado (se rehace si se reabre desde Recientes).
  function forget(tabId) {
    sessions.delete(tabId);
    fs.rm(dirFor(tabId), { recursive: true, force: true }, () => { /* en uso */ });
  }

  return { describe, build, prepare, update, pendingUpdate, linkInfo, forget };
}

module.exports = { createContext, docxToText, readRule, parseTitle };
