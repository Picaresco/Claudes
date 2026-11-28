// ── Capturas de pantalla para la revisión visual (SuperPowers) ───
// Herramienta «capturar_pantalla» del MCP de la app, solo en las pestañas con SuperPowers: abre
// una página del proyecto en una ventana invisible a varios anchos y le devuelve a Claude las
// imágenes (y las guarda en <datos de la app>/capturas/<pestaña>), para que vea cómo queda lo
// que ha cambiado: solapes, textos cortados, desbordes, contraste.
// Carga archivos de la carpeta del proyecto (su ruta real, sin salirse por un enlace), lo que sirve
// un servidor en este equipo (localhost) y, de CDN públicos conocidos, solo estilos, fuentes,
// guiones e imágenes (descargas por https). Todo lo demás que pida la página (otras webs, también
// por una redirección) se bloquea y se le avisa: así la herramienta no sirve para sacar nada a
// internet ni para traer páginas de fuera. Cada captura,
// en una sesión del navegador aparte, en memoria y sin permisos ni descargas.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const DEFAULT_WIDTHS = [390, 1024, 1440];
const MIN_WIDTH = 320;
const MAX_WIDTH = 1920;
const HEIGHT = 900; // alto de la «pantalla»
const MAX_SCREENS = 3; // página completa: hasta tres pantallas de alto
const LOAD_MS = 20000; // lo que puede tardar en cargar cada anchura
const SHOT_MS = 45000; // y cada anchura entera: si la página se cuelga, se cierra y se sigue
const MEASURE_MS = 5000; // medir la página
const PAGE_FILE = /\.(html?|xhtml|svg)$/i;
const KEEP_MS = 2 * 24 * 3600 * 1000; // las capturas se borran a los dos días

const CAPTURE_TOOL = {
  name: 'capturar_pantalla',
  description: 'Captura cómo se ve una página del proyecto a varios anchos (por defecto 390, 1024 y 1440 px: móvil, tableta y escritorio) '
    + 'y te devuelve las imágenes para que las revises: solapes, textos cortados, desbordes, contraste, cosas que faltan. '
    + 'Sirve para un archivo .html o .svg de la carpeta del proyecto o para lo que sirva un servidor de desarrollo en este equipo (localhost); '
    + 'si la app necesita servidor, arráncalo antes en segundo plano y captura su página real (no hagas copias estáticas). '
    + 'Los estilos, fuentes y guiones de CDN públicos conocidos (jsDelivr, unpkg, cdnjs, Google Fonts, Bootstrap…) se cargan; lo demás de internet no, y se te avisa. '
    + 'Las capturas también quedan guardadas como PNG (te da las rutas).',
  inputSchema: {
    type: 'object',
    properties: {
      objetivo: {
        type: 'string',
        description: 'Qué capturar: la ruta de un .html/.htm/.svg de la carpeta del proyecto (relativa a ella o absoluta), p. ej. "index.html" o "docs/demo.html", o una dirección de este equipo, p. ej. "http://localhost:5173/citas".',
      },
      anchos: {
        type: 'array',
        items: { type: 'integer', minimum: MIN_WIDTH, maximum: MAX_WIDTH },
        maxItems: 3,
        description: 'Anchos en píxeles, como mucho 3. Por defecto 390, 1024 y 1440.',
      },
      pagina_completa: {
        type: 'boolean',
        description: 'true para capturar también lo que queda por debajo (hasta tres pantallas de alto). Por defecto, solo lo que se ve sin desplazar.',
      },
      esperar_ms: {
        type: 'integer',
        minimum: 0,
        maximum: 5000,
        description: 'Espera extra tras cargar, para animaciones o datos que llegan después. Por defecto 400.',
      },
    },
    required: ['objetivo'],
  },
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (host) => LOOPBACK.has(host) || host.endsWith('.localhost');

// La ruta real (sin enlaces ni nombres cortos de Windows, como ALBERT~1). Si no existe, la de
// su carpeta más cercana que sí exista, con el resto detrás.
function real(file) {
  let dir = path.resolve(file);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(dir), ...rest); } catch { /* sube un nivel */ }
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(file);
    rest.unshift(path.basename(dir));
    dir = up;
  }
}
const within = (file, root) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// ¿Está dentro de alguna de las carpetas? Primero sin tocar el disco (una ruta de fuera, también
// de red como \\servidor\carpeta, no se llega a abrir) y después con la ruta real (que un enlace
// de dentro no lleve fuera).
function inside(file, roots) {
  const full = path.resolve(file);
  const bases = roots.flatMap((root) => [path.resolve(root), real(root)]);
  if (!bases.some((base) => within(full, base))) return false;
  const target = real(full);
  return roots.some((root) => within(target, real(root)));
}

// ¿Se deja cargar esta dirección? Archivos de las carpetas, este equipo y datos en línea.
function allowRequest(url, roots) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  switch (parsed.protocol) {
    case 'data:':
    case 'blob:':
    case 'about:':
      return true;
    case 'file:': {
      let file;
      try { file = fileURLToPath(parsed); } catch { return false; }
      return inside(file, roots);
    }
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:':
      return isLoopback(parsed.hostname);
    default:
      return false;
  }
}

// CDN públicos conocidos: de ellos sí se cargan estilos, fuentes, guiones e imágenes (solo
// descargas por https), para que la captura se parezca a lo que verá el usuario. Nada más.
const CDN_HOSTS = new Set([
  'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com',
  'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com', 'netdna.bootstrapcdn.com',
  'code.jquery.com', 'cdn.tailwindcss.com', 'use.fontawesome.com', 'kit.fontawesome.com',
  'ka-f.fontawesome.com', 'cdn.datatables.net', 'cdn.plot.ly', 'esm.sh', 'cdn.skypack.dev',
  'rsms.me', 'fonts.bunny.net', 'use.typekit.net', 'p.typekit.net', 'cdn.socket.io',
]);
const CDN_TYPES = new Set(['stylesheet', 'font', 'script', 'image']);
function allowCdn(details) {
  if (!details || details.method !== 'GET' || !CDN_TYPES.has(details.resourceType)) return false;
  let parsed;
  try { parsed = new URL(details.url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
    && CDN_HOSTS.has(parsed.hostname.toLowerCase());
}

// Qué se va a capturar: { url, label }. Lanza un error con un mensaje para Claude si no se puede.
// roots: las carpetas del proyecto (y sus copias de trabajo de git); base: desde dónde se leen las
// rutas relativas (la carpeta en la que trabaja la sesión, si es una de ellas).
function resolveTarget(objetivo, roots, base = roots[0]) {
  const said = typeof objetivo === 'string' ? objetivo.trim() : '';
  if (!said) throw new Error('Falta «objetivo»: la ruta de un .html del proyecto o una dirección de localhost.');
  if (!roots.length) throw new Error('Esta sesión ya no está abierta en ClaudHome.');
  let text = said;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(text)) text = `http://${text}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^file:/i.test(text)) {
    let url;
    try { url = new URL(text); } catch { throw new Error(`«${said}» no es una dirección válida.`); }
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname)) {
      throw new Error('Solo se capturan páginas de este equipo (http://localhost…) o archivos de la carpeta del proyecto, no webs de internet.');
    }
    return { url: url.href, label: url.href };
  }
  let file = text;
  if (/^file:/i.test(text)) {
    try { file = fileURLToPath(text); } catch { throw new Error(`«${said}» no es una ruta de archivo válida.`); }
  }
  file = path.resolve(base || roots[0], file);
  const outside = 'Ese archivo está fuera de la carpeta del proyecto: solo se capturan páginas del proyecto.';
  if (!PAGE_FILE.test(file)) throw new Error('Solo se capturan páginas .html, .htm o .svg (para una app con servidor, usa su dirección de localhost).');
  if (!inside(file, roots)) throw new Error(outside); // antes de abrir nada (inside no toca lo de fuera)
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* no existe */ }
  if (!stat || !stat.isFile()) throw new Error(`No encuentro el archivo ${file}.`);
  return { url: pathToFileURL(real(file)).href, label: path.relative(base || roots[0], file) || path.basename(file) };
}

// Los anchos pedidos: enteros entre 320 y 1920, sin repetir, como mucho 3.
function widthsFrom(anchos) {
  if (!Array.isArray(anchos) || !anchos.length) return [...DEFAULT_WIDTHS];
  const out = [];
  for (const raw of anchos) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) continue;
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
    if (!out.includes(width)) out.push(width);
    if (out.length === 3) break;
  }
  return out.length ? out : [...DEFAULT_WIDTHS];
}

const waitMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new Error('Se ha cancelado la captura.')); return; }
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Se ha cancelado la captura.')); }, { once: true });
});
const two = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const hostOf = (url) => { try { const u = new URL(url); return u.host || u.protocol; } catch { return 'otra dirección'; } };

// El texto para Claude que acompaña a las imágenes.
function report({ target, shots, blocked, full, cdn = [] }) {
  const widths = shots.map((s) => s.width);
  const lines = [
    `Capturas de «${target.label}» a ${widths.join(', ')} px (${full ? 'página completa, hasta tres pantallas de alto' : 'lo que se ve sin desplazar'}), en ese orden. Guardadas en:`,
    ...shots.map((s) => `- ${s.file}`),
  ];
  const warn = [];
  for (const s of shots) {
    if (s.overflow > 0) warn.push(`a ${s.width} px la página es más ancha que la pantalla (desborde horizontal de ${s.overflow} px)`);
  }
  if (blocked.length) warn.push(`se ha bloqueado lo que pedía a internet (${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '…' : ''}): con conexión puede verse algo distinto`);
  const errors = [...new Set(shots.flatMap((s) => s.errors))].slice(0, 5);
  if (errors.length) warn.push(`errores en la consola de la página: ${errors.map((e) => `«${e}»`).join('; ')}`);
  if (warn.length) lines.push('', `Avisos: ${warn.join('; ')}.`);
  if (cdn.length) lines.push('', `Se han cargado estilos, fuentes o guiones de CDN públicos (${cdn.slice(0, 5).join(', ')}${cdn.length > 5 ? '…' : ''}), como en la página real.`);
  lines.push('', 'Míralas con atención (solapes, textos cortados o que se salen, desbordes, contraste, lo que falta), arregla lo que veas y vuelve a capturar para comprobarlo.');
  return lines.join('\n');
}

// electron: { BrowserWindow, session }; dir(): la carpeta de las capturas.
function createCapture({ electron, dir, log = () => {} }) {
  let chain = Promise.resolve(); // una captura cada vez (cada una abre ventanas invisibles)

  function prune() {
    const base = dir();
    const now = Date.now();
    let folders;
    try { folders = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
    for (const folder of folders) {
      const sub = path.join(base, folder.name);
      for (const name of fs.readdirSync(sub)) {
        const file = path.join(sub, name);
        try { if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.unlinkSync(file); } catch { /* en uso: la próxima vez */ }
      }
    }
  }

  // Una orden del protocolo de DevTools, con un límite de tiempo.
  const cdp = (dbg, method, params, ms = 15000) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method}: sin respuesta`)), ms); });
    return Promise.race([dbg.sendCommand(method, params), timeout]).finally(() => clearTimeout(timer));
  };

  // Una anchura. El tamaño de la página lo fija el protocolo de DevTools (como las herramientas de
  // pruebas de navegador): una ventana no puede ser más grande que la pantalla del equipo, así que
  // con ella sola una captura de 1440 px saldría más estrecha y estirada. Por debajo de 600 px, como
  // un móvil (con su etiqueta viewport). La imagen sale a escala 1, al píxel pedido.
  async function shoot(ses, target, roots, width, { full, extra, signal, holder }) {
    const win = new electron.BrowserWindow({
      // Fuera de pantalla: sin ventana a la vista, pero dibujando (una ventana oculta normal no
      // dibuja y la captura se quedaría esperando).
      show: false, width: Math.min(width, 1280), height: 800,
      webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    holder.win = win; // para cerrarla desde fuera si se pasa de tiempo o se cancela
    const errors = [];
    const contents = win.webContents;
    const dbg = contents.debugger;
    try {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event, url) => { if (!allowRequest(url, roots)) event.preventDefault(); });
      contents.on('console-message', (event) => {
        const level = event && (event.level === 'error' || event.level === 3);
        if (level && errors.length < 5) errors.push(String(event.message || '').slice(0, 160));
      });
      // Primero una página en blanco: el protocolo no responde hasta que hay una cargada.
      await contents.loadURL('about:blank');
      dbg.attach('1.3');
      await cdp(dbg, 'Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: width < 600 });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LOAD_MS); });
      try {
        await Promise.race([contents.loadURL(target.url), timeout]);
      } catch (err) {
        const why = String((err && err.message) || err);
        if (why === 'timeout') throw new Error(`«${target.label}» no ha terminado de cargar en ${LOAD_MS / 1000} s.`, { cause: err });
        if (/ERR_BLOCKED_BY_CLIENT/.test(why)) throw new Error(`«${target.label}» lleva a una dirección de fuera de este equipo, y eso no se carga.`, { cause: err });
        if (/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_UNSAFE_PORT/.test(why)) {
          throw new Error(`No responde nada en ${target.label}: arranca antes el servidor (en segundo plano) y vuelve a intentarlo.`, { cause: err });
        }
        if (!/ERR_ABORTED/.test(why)) throw new Error(`No se ha podido abrir «${target.label}»: ${why.slice(0, 200)}`, { cause: err });
      } finally { clearTimeout(timer); }
      await waitMs(extra, signal);
      const fallback = { h: HEIGHT, w: width };
      const measure = await Promise.race([
        contents.executeJavaScript(
          '({ h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) })',
          true,
        ).catch(() => fallback),
        new Promise((resolve) => { setTimeout(resolve, MEASURE_MS, fallback); }),
      ]);
      const height = full ? Math.min(HEIGHT * MAX_SCREENS, Math.max(HEIGHT, Math.ceil(measure.h))) : HEIGHT;
      const shot = await cdp(dbg, 'Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: height > HEIGHT, clip: { x: 0, y: 0, width, height, scale: 1 },
      }).catch((err) => { throw new Error(`«${target.label}» no responde a ${width} px (la página parece colgada) y no se ha podido capturar.`, { cause: err }); });
      const png = Buffer.from(shot.data, 'base64');
      // Desborde: lo que mide el contenido más allá del ancho pedido (en modo móvil, el ancho
      // interno de la ventana crece con el contenido y no sirve para medirlo).
      return { width, height, png, overflow: Math.max(0, Math.round(measure.w - width)), errors };
    } finally {
      try { if (dbg.isAttached()) dbg.detach(); } catch { /* ya cerrada */ }
      if (!win.isDestroyed()) win.destroy();
    }
  }

  // Una anchura con su plazo: si la página se cuelga o se cancela, se cierra su ventana y se
  // sigue (las demás capturas no se quedan esperando detrás).
  function shootWithin(ses, target, roots, width, opts) {
    const holder = {};
    const close = () => { if (holder.win && !holder.win.isDestroyed()) holder.win.destroy(); };
    return new Promise((resolve, reject) => {
      const fail = (err) => { clearTimeout(timer); close(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`«${target.label}» no ha respondido a tiempo (${SHOT_MS / 1000} s): la captura se ha cancelado.`)), SHOT_MS);
      const onAbort = () => fail(new Error('Se ha cancelado la captura.'));
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      shoot(ses, target, roots, width, { ...opts, holder }).then(
        (shot) => { clearTimeout(timer); resolve(shot); },
        (err) => fail(err),
      ).finally(() => { if (opts.signal) opts.signal.removeEventListener('abort', onAbort); });
    });
  }

  // La captura de una pestaña. roots: las carpetas del proyecto y sus copias de trabajo de git;
  // base: desde dónde se leen las rutas relativas. Devuelve el resultado de la herramienta (el
  // texto y las imágenes) y, para ClaudHome, las rutas y cuántas imágenes son.
  async function take(tabId, args, { roots, base = null, signal } = {}) {
    const target = resolveTarget(args && args.objetivo, roots || [], base || (roots || [])[0]);
    const widths = widthsFrom(args && args.anchos);
    const full = Boolean(args && args.pagina_completa === true);
    const extra = Math.min(5000, Math.max(0, Math.round(Number(args && args.esperar_ms)) || 400));
    const run = async () => {
      prune();
      const outDir = tabDir(dir(), tabId);
      fs.mkdirSync(outDir, { recursive: true });
      const ses = electron.session.fromPartition(`capturas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); // en memoria
      const blocked = new Set();
      const cdn = new Set();
      ses.webRequest.onBeforeRequest((details, callback) => {
        let ok = allowRequest(details.url, roots);
        if (!ok && allowCdn(details)) { ok = true; cdn.add(hostOf(details.url)); }
        if (!ok) blocked.add(hostOf(details.url));
        callback({ cancel: !ok });
      });
      ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
      ses.on('will-download', (event) => event.preventDefault());
      const when = stamp();
      const shots = [];
      try {
        for (const width of widths) {
          if (signal && signal.aborted) throw new Error('Se ha cancelado la captura.');
          const shot = await shootWithin(ses, target, roots, width, { full, extra, signal });
          shot.file = path.join(outDir, `${when}-${width}.png`);
          fs.writeFileSync(shot.file, shot.png);
          shots.push(shot);
        }
      } finally {
        ses.webRequest.onBeforeRequest(null);
        ses.clearStorageData().catch(() => {});
      }
      log(`capturas de pantalla: ${target.label} a ${widths.join(', ')} px${cdn.size ? ` (CDN: ${[...cdn].slice(0, 5).join(', ')})` : ''}${blocked.size ? ` (bloqueado: ${[...blocked].slice(0, 5).join(', ')})` : ''}`);
      return {
        content: [
          { type: 'text', text: report({ target, shots, blocked: [...blocked], full, cdn: [...cdn] }) },
          ...shots.map((s) => ({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' })),
        ],
        files: shots.map((s) => s.file),
        images: shots.length,
        cdn: [...cdn],
      };
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return { take, prune };
}

// La carpeta de las capturas de una pestaña (cada pestaña solo puede volver a leer las suyas).
const tabDir = (base, tabId) => path.join(base, String(tabId).replace(/[^\w-]/g, '_'));

// Las copias de trabajo de git del proyecto (git worktree): las ideas de SuperPowers se prueban
// en una, junto a la carpeta del proyecto, y sus páginas también se pueden capturar. git: su ruta.
function worktreeRoots(folder, git) {
  if (!folder || !git) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(git, ['worktree', 'list', '--porcelain'], { cwd: folder, timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(String(stdout).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9).trim())).slice(0, 20));
    });
  });
}

module.exports = { worktreeRoots, tabDir, inside, createCapture, CAPTURE_TOOL, resolveTarget, allowRequest, allowCdn, CDN_HOSTS, widthsFrom, report, DEFAULT_WIDTHS };
