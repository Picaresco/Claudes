// Interfaz de Claudes: pestañas, vista dividida, terminal extra, recientes y avisos.
(() => {
  'use strict';

  const api = window.api;
  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── Constantes ───────────────────────────────────────────────────

  const COLORS = [
    { key: '', name: 'Sin color', hex: '' },
    { key: 'blue', name: 'Azul', hex: '#6AA5F8' },
    { key: 'amber', name: 'Ámbar', hex: '#F2B866' },
    { key: 'pink', name: 'Rosa', hex: '#E88DBA' },
    { key: 'green', name: 'Verde', hex: '#7FD4A0' },
  ];
  const colorHex = (key) => (COLORS.find((c) => c.key === key) || COLORS[0]).hex;

  const BASE_FONT = 14;
  const MAX_RECENTS = 8;
  const SIDES = ['left', 'right'];

  const SVG = {
    // Estado de la sesión: verde = activa (girando si trabaja, parpadeando si ha
    // terminado sin que lo vieras), rojo parpadeando = te necesita, ámbar = se ha
    // detenido por un error, gris girando = arrancando, punteado = sin iniciar o cerrada.
    working: '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#3A414D" stroke-width="2"/><path d="M8 2a6 6 0 0 1 0 12" fill="none" stroke="#7FD4A0" stroke-width="2" stroke-linecap="round"/></svg>',
    starting: '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#3A414D" stroke-width="2"/><path d="M8 2a6 6 0 0 1 0 12" fill="none" stroke="#8B929D" stroke-width="2" stroke-linecap="round"/></svg>',
    attn: '<svg class="dot-attn" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#F26B6B" fill-opacity="0.28"/><circle cx="8" cy="8" r="4.2" fill="#F26B6B"/></svg>',
    done: '<svg class="dot-attn" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#7FD4A0" fill-opacity="0.28"/><circle cx="8" cy="8" r="4.2" fill="#7FD4A0"/></svg>',
    failed: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#F2B866" fill-opacity="0.22"/><circle cx="8" cy="8" r="4.2" fill="#F2B866"/></svg>',
    idle: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#7FD4A0" fill-opacity="0.18"/><circle cx="8" cy="8" r="4.2" fill="#7FD4A0"/></svg>',
    off: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="#8B929D" stroke-width="1.5" stroke-dasharray="2.4 2.4"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
    update: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11"/></svg>',
    terminal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3"/></svg>',
  };

  // El color de la pestaña la distingue; el punto, su estado. «tone» marca los estados
  // que piden que mires la pestaña (y con qué color se escribe su nombre en la cabecera).
  const STATUS = {
    asleep: { icon: 'off', label: 'Sin iniciar' },
    starting: { icon: 'starting', label: 'Iniciando' },
    idle: { icon: 'idle', label: 'Activa, esperando tu mensaje' },
    working: { icon: 'working', label: 'Trabajando' },
    needs: { icon: 'attn', label: 'Te necesita', tone: 'alert' },
    done: { icon: 'done', label: 'Ha terminado', tone: 'done' },
    failed: { icon: 'failed', label: 'Se ha detenido por un error', tone: 'warn' },
    closing: { icon: 'starting', label: 'Guardando su estado para cerrar' },
    exited: { icon: 'off', label: 'Sesión cerrada' },
    sleeping: { icon: 'off', label: 'Dormida para ahorrar memoria: se retoma al abrirla' },
  };

  // Lo que se le escribe a Claude cuando se cierra una sesión que está trabajando.
  const WRAPUP_PROMPT = 'Voy a cerrar esta sesión ahora. No continúes con la tarea: deja lo que estabas haciendo en un estado coherente y escribe un resumen breve de qué has hecho, qué queda pendiente y cuál es el siguiente paso, para retomarlo cuando vuelva a abrir esta sesión.';

  const THEME = {
    background: '#14171C',
    foreground: '#E7E9EC',
    cursor: '#E7E9EC',
    cursorAccent: '#14171C',
    selectionBackground: 'rgba(106, 165, 248, 0.35)',
    black: '#1B1F26', red: '#F47067', green: '#7FD4A0', yellow: '#F2B866',
    blue: '#6AA5F8', magenta: '#E88DBA', cyan: '#56C8D8', white: '#C9CED6',
    brightBlack: '#6E7681', brightRed: '#FF8A80', brightGreen: '#9BE3B8', brightYellow: '#F7CE8A',
    brightBlue: '#8DBBFA', brightMagenta: '#F0A9CE', brightCyan: '#7FDBE8', brightWhite: '#FFFFFF',
  };
  const THEME_EXTRA = { ...THEME, background: '#0C0E11', cursorAccent: '#0C0E11' };

  // ── Estado ───────────────────────────────────────────────────────

  // Lo que se guarda en disco. Cada pestaña: { id, name, cwd, color, shell,
  // sessionId, zoom, extraOpen, extraHeight }.
  const S = { tabs: [], activeId: null, split: null, focusSide: 'left', recents: [], lastShell: 'powershell' };

  const views = new Map(); // id de pestaña → vista (terminales y estado en vivo)
  const terms = new Map(); // id de proceso → terminal que muestra su salida
  let info = { shells: [], windowsBuild: 0, claudeFound: true };
  let mru = [];
  let winFocused = document.hasFocus();
  let renamingId = null;
  let draggingId = null;
  let tabsDirty = false;
  let lastBusy = -1;
  let saveTimer = null;
  let fitQueued = false;
  let toastTimer = null;
  let voiceOn = false; // micrófono para dictar (botón de la barra superior)

  const panes = {};
  const byId = (id) => S.tabs.find((t) => t.id === id) || null;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const fontSizeFor = (zoom) => Math.max(8, Math.round(BASE_FONT * (zoom || 1)));
  const visibleIds = () => (S.split ? [S.split.left, S.split.right] : S.activeId ? [S.activeId] : []);
  const isWatched = (view) => winFocused && visibleIds().includes(view.tab.id);
  const dialogOpen = () => $('#dlg-new').open || $('#dlg-update').open || $('#dlg-log').open;

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveState({
        tabs: S.tabs, activeId: S.activeId, split: S.split, focusSide: S.focusSide,
        recents: S.recents, lastShell: S.lastShell,
      });
    }, 200);
  }

  function touchMru(id) {
    mru = [id, ...mru.filter((x) => x !== id)];
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function toast(text, sticky = false) {
    const node = $('#toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
  }

  function applySwatch(node, colorKey) {
    const hex = colorHex(colorKey);
    node.classList.toggle('none', !hex);
    if (hex) node.style.setProperty('--c', hex);
    else node.style.removeProperty('--c');
  }

  function swatch(colorKey) {
    const node = el('span', 'swatch');
    node.setAttribute('aria-hidden', 'true');
    applySwatch(node, colorKey);
    return node;
  }

  // Arrastre genérico (divisor de la vista, alto de la terminal extra).
  function startDrag(event, cursor, onMove, onEnd) {
    event.preventDefault();
    document.body.classList.add('dragging');
    document.body.style.cursor = cursor;
    const move = (e) => onMove(e);
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      document.body.classList.remove('dragging');
      document.body.style.cursor = '';
      if (onEnd) onEnd();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }

  // ── Terminales ───────────────────────────────────────────────────

  function makeTerminal(zoom, theme) {
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: fontSizeFor(zoom),
      fontWeightBold: '600',
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      theme,
      windowsPty: info.windowsBuild ? { backend: 'conpty', buildNumber: info.windowsBuild } : undefined,
      linkHandler: { activate: (_event, uri) => { if (/^https?:\/\//i.test(uri)) api.openPath(uri); } },
    });
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => api.openPath(uri)));
    // Anchos de carácter modernos: los emojis (la marca verde U+2705, el candado
    // U+1F512…) ocupan 2 columnas y los compuestos (con tono de piel, ZWJ) cuentan
    // como uno, igual que los calculan Claude Code y Windows Terminal. Con la tabla
    // Unicode 6 que trae xterm por defecto ocupaban 1, y cada uno descuadraba una
    // columna lo que Claude Code redibuja (tablas torcidas, letras que saltaban al
    // final de la línea anterior).
    term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
    term.unicode.activeVersion = '15-graphemes';
    return term;
  }

  // Rutas listas para pegar en una terminal: entre comillas si llevan espacios.
  const quotePath = (file) => (/\s/.test(file) ? `"${file}"` : file);
  const joinPaths = (files) => `${files.map(quotePath).join(' ')} `;

  const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  // Pega lo que haya en el portapapeles: archivos copiados en el Explorador (sus
  // rutas), texto, o una imagen copiada (se guarda como archivo y se pega su ruta).
  // Claude Code adjunta por sí mismo las imágenes cuya ruta se pega. `view` solo
  // llega en la terminal de Claude: allí se apunta qué [Image #n] es cada imagen.
  async function paste(term, view) {
    let clip;
    try {
      clip = await api.clipboardRead();
    } catch {
      toast('No se ha podido leer el portapapeles.');
      return;
    }
    await pasteClip(term, view, clip);
  }

  async function pasteClip(term, view, clip) {
    const before = view ? imageLabelCounts(view.term) : null;
    let pasted = [];
    if (clip.files.length) {
      // De uno en uno, para que Claude Code reconozca cada imagen por separado. Al
      // convertir una imagen en [Image #n] se come el espacio de detrás: se repone.
      let afterImage = false;
      for (const file of clip.files) {
        term.paste(`${afterImage ? ' ' : ''}${joinPaths([file])}`);
        afterImage = IMAGE_FILE.test(file);
        await sleep(120);
      }
      pasted = clip.files;
    } else if (clip.text) {
      term.paste(clip.text);
      pasted = pathsInText(clip.text); // la ruta de una imagen pegada como texto también se convierte
    } else if (clip.imagePath) {
      term.paste(joinPaths([clip.imagePath]));
      pasted = [clip.imagePath];
    } else {
      toast('El portapapeles está vacío o contiene algo que no se puede pegar aquí.');
    }
    if (view) learnImageLabels(view, pasted, before);
  }

  // Rutas de un texto pegado que solo contiene rutas (una o varias, con o sin comillas).
  function pathsInText(text) {
    const paths = (text.trim().match(/"[^"]+"|\S+/g) || []).map((token) => token.replace(/^"|"$/g, ''));
    return paths.length && paths.every((p) => /^[A-Za-z]:[\\/]/.test(p)) ? paths : [];
  }

  function copySelection(term) {
    api.clipboardWrite(term.getSelection());
    term.clearSelection();
  }

  function wireKeys(term, ptyId, view, isClaude) {
    term.attachCustomKeyEventHandler((e) => {
      const key = (e.key || '').toLowerCase();
      const plainCtrl = e.ctrlKey && !e.altKey && !e.metaKey;
      if (isClaude && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        // Mayús+Intro = salto de línea sin enviar (equivale a Ctrl+J en Claude Code).
        if (e.type === 'keydown') { e.preventDefault(); api.ptyWrite(ptyId, '\n'); }
        return false;
      }
      // Con el micrófono apagado, mantener la barra espaciadora escribe un solo
      // espacio: sin sus repeticiones, Claude Code no detecta la pulsación larga
      // con la que empieza a dictar. Encendido, le llegan y Claude graba.
      if (isClaude && !voiceOn && e.repeat && e.key === ' ') { e.preventDefault(); return false; }
      if (e.type !== 'keydown') return true;
      if (plainCtrl && key === 'c' && term.hasSelection()) { e.preventDefault(); copySelection(term); return false; }
      if (plainCtrl && key === 'v') { e.preventDefault(); paste(term, isClaude ? view : null); return false; }
      return true;
    });
  }

  function wireHost(host, term, ptyId, view, isClaude) {
    // Botón derecho: copia si hay texto seleccionado; si no, pega.
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) copySelection(term);
      else paste(term, isClaude ? view : null);
    });
    // Soltar archivos sobre la terminal extra pega sus rutas. Sobre la de Claude se
    // elige entre pegarlos o añadirlos al contexto del proyecto (wireDropChoice).
    if (!isClaude) {
      host.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      host.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        const files = droppedPaths(e);
        if (!files.length) return;
        term.paste(joinPaths(files));
        term.focus();
      });
    }
    host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      setZoom(view, (view.tab.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false, capture: true });
    host.addEventListener('focusin', () => { view.lastFocus = isClaude ? 'claude' : 'extra'; });
  }

  // ── Vista previa de archivos ─────────────────────────────────────
  // Al pasar el ratón sobre la ruta de un archivo que existe, o sobre el
  // [Image #n] en que Claude Code convierte una imagen pegada, aparece una tarjeta
  // con su miniatura, la primera página o las primeras líneas. Ctrl+clic lo abre.

  const IMAGE_LABEL = /\[Image #(\d+)\]/g;
  const PATH_STOP = /[\s"<>|*?]/;
  const TRAILING = /[.,;:!?)\]}'»]+$/;

  // Cuántas veces aparece cada [Image #n] en la pantalla de la terminal.
  function imageLabelCounts(term) {
    const counts = new Map();
    const buffer = term.buffer.active;
    for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      for (const m of line.translateToString(true).matchAll(IMAGE_LABEL)) {
        const n = Number(m[1]);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
    }
    return counts;
  }

  // Claude Code numera las imágenes pegadas ([Image #1], [Image #2]…) sin repetir
  // número mientras dura la sesión: la etiqueta que aparece tras pegar es la de la
  // imagen pegada. Al reiniciar Claude se olvidan (la numeración puede volver a empezar).
  async function learnImageLabels(view, files, before) {
    const images = files.filter((file) => IMAGE_FILE.test(file));
    if (!images.length || !before) return;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(150);
      const now = imageLabelCounts(view.term);
      const fresh = [...now.keys()].filter((n) => now.get(n) > (before.get(n) || 0)).sort((a, b) => a - b);
      if (fresh.length >= images.length || attempt === 11) {
        const picked = fresh.slice(-images.length);
        const offset = images.length - picked.length;
        picked.forEach((n, i) => view.images.set(n, images[offset + i]));
        return;
      }
    }
  }

  // Texto de una fila (y empieza en 1) y la columna de cada uno de sus caracteres.
  function rowText(term, y) {
    const buffer = term.buffer.active;
    const line = buffer.getLine(y - 1);
    if (!line) return null;
    const cell = buffer.getNullCell();
    let text = '';
    const cols = [];
    for (let x = 0; x < line.length; x += 1) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // segunda mitad de un carácter ancho
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k += 1) { text += chars[k]; cols.push(x); }
    }
    const trimmed = text.replace(/\s+$/, '');
    return { y, text: trimmed, cols: cols.slice(0, trimmed.length) };
  }

  // Rutas absolutas de Windows en una fila, entre comillas o sueltas. A las
  // sueltas se les prueba a añadir las palabras siguientes, por si llevan espacios.
  // `open` = llega al final de la fila y puede seguir en la siguiente.
  function pathCandidates(text) {
    const found = [];
    const quoted = [];
    for (const m of text.matchAll(/"([A-Za-z]:[\\/][^"]*)("?)/g)) {
      const start = m.index + 1;
      quoted.push([m.index, m.index + m[0].length]);
      found.push({ start, quoted: true, open: !m[2], variants: [{ value: m[1], end: start + m[1].length }] });
    }
    for (const m of text.matchAll(/[A-Za-z]:[\\/]/g)) {
      const start = m.index;
      if (quoted.some(([a, b]) => start >= a && start < b)) continue;
      if (start > 0 && /[\w"\\/]/.test(text[start - 1])) continue;
      const variants = [];
      let from = start;
      let open = false;
      for (let words = 0; words < 5; words += 1) {
        let stop = from;
        while (stop < text.length && !PATH_STOP.test(text[stop])) stop += 1;
        const value = text.slice(start, stop).replace(/\s+$/, '').replace(TRAILING, '');
        if (value.length > 3 && !variants.some((v) => v.value === value)) variants.push({ value, end: start + value.length });
        if (stop >= text.length) { open = words === 0; break; }
        if (text[stop] !== ' ') break;
        from = stop + 1;
      }
      if (variants.length) found.push({ start, quoted: false, open, variants });
    }
    return found;
  }

  const rangeOf = (rowA, startIdx, rowB, endIdx) => ({
    start: { x: rowA.cols[startIdx] + 1, y: rowA.y },
    end: { x: rowB.cols[endIdx - 1] + 1, y: rowB.y },
  });

  // Una ruta cortada al final de `row` puede seguir al principio de `next`
  // (Claude Code parte las líneas largas). Se prueba a unirlas, con y sin espacio.
  function joinOptions(candidate, row, next) {
    const lead = /^[\s│>]*/.exec(next.text)[0].length;
    let to = lead;
    while (to < next.text.length && (candidate.quoted ? next.text[to] !== '"' : !PATH_STOP.test(next.text[to]))) to += 1;
    let piece = next.text.slice(lead, to);
    if (!candidate.quoted) {
      const trimmed = piece.replace(TRAILING, '');
      to -= piece.length - trimmed.length;
      piece = trimmed;
    }
    if (!piece) return [];
    const head = candidate.variants[candidate.variants.length - 1].value;
    return ['', ' '].map((glue) => ({ value: head + glue + piece, range: rangeOf(row, candidate.start, next, to) }));
  }

  const existsCache = new Map(); // ruta → { ok, at }

  async function existingFiles(list) {
    const now = Date.now();
    const unknown = [...new Set(list)].filter((p) => { const c = existsCache.get(p); return !c || now - c.at > 15000; });
    if (unknown.length) {
      const found = new Set(await api.existingFiles(unknown));
      if (existsCache.size > 2000) existsCache.clear();
      for (const p of unknown) existsCache.set(p, { ok: found.has(p), at: now });
    }
    return new Set(list.filter((p) => existsCache.get(p) && existsCache.get(p).ok));
  }

  function previewLink(range, file) {
    return {
      range,
      text: file,
      decorations: { pointerCursor: false, underline: true },
      activate: (event) => { if (event.ctrlKey) { hidePreview(); api.openPath(file); } },
      hover: (event) => showPreview(file, event),
      leave: () => hidePreview(),
    };
  }

  function registerPreviewLinks(term, view, isClaude) {
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const row = rowText(term, y);
        if (!row || !row.text) { callback(undefined); return; }
        const links = [];
        if (isClaude && view.images.size) {
          for (const m of row.text.matchAll(IMAGE_LABEL)) {
            const file = view.images.get(Number(m[1]));
            if (file) links.push(previewLink(rangeOf(row, m.index, row, m.index + m[0].length), file));
          }
        }
        // Cada grupo son las formas posibles de una misma ruta; se queda la más larga que exista.
        const groups = [];
        const next = rowText(term, y + 1);
        for (const c of pathCandidates(row.text)) {
          const options = c.variants.map((v) => ({ value: v.value, range: rangeOf(row, c.start, row, v.end) }));
          if (c.open && next && next.text) options.push(...joinOptions(c, row, next));
          groups.push(options);
        }
        const prev = rowText(term, y - 1);
        if (prev && prev.text) {
          for (const c of pathCandidates(prev.text)) {
            if (!c.open) continue;
            const options = joinOptions(c, prev, row);
            if (options.length) groups.push(options);
          }
        }
        if (!groups.length) { callback(links.length ? links : undefined); return; }
        existingFiles(groups.flat().map((o) => o.value)).then((found) => {
          for (const options of groups) {
            const hit = options.filter((o) => found.has(o.value)).pop();
            if (hit) links.push(previewLink(hit.range, hit.value));
          }
          callback(links.length ? links : undefined);
        }).catch(() => callback(links.length ? links : undefined));
      },
    });
    term.onScroll(() => hidePreview());
  }

  let previewToken = 0;
  let previewTimer = null;

  function showPreview(file, event) {
    clearTimeout(previewTimer);
    const token = ++previewToken;
    const at = { x: event.clientX, y: event.clientY };
    previewTimer = setTimeout(async () => {
      renderPreview({ name: baseName(file), loading: true }, at);
      let data = null;
      try { data = await api.preview(file); } catch { /* sin vista previa */ }
      if (token !== previewToken) return;
      if (data) renderPreview(data, at);
      else hidePreview();
    }, 150);
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    previewToken += 1;
    $('#preview').hidden = true;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toLocaleString('es-ES', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[i]}`;
  }

  function renderPreview(data, at) {
    const card = $('#preview');
    const body = el('div', 'pv-body');
    if (data.loading) body.append(el('div', 'pv-loading', 'Preparando la vista previa…'));
    else if (data.kind === 'text') body.append(el('pre', 'pv-text', data.text));
    else if (data.image) {
      const img = el('img', 'pv-img');
      img.alt = '';
      img.addEventListener('load', () => placePreview(card, at));
      img.src = data.image;
      body.append(img);
    }
    const meta = el('div', 'pv-meta');
    meta.append(el('strong', 'pv-name', data.name));
    if (!data.loading) {
      const facts = [data.ext || 'Archivo', formatSize(data.size)];
      if (data.width && data.height) facts.push(`${data.width} × ${data.height}`);
      if (data.pages) facts.push(data.pages === 1 ? '1 página' : `${data.pages} páginas`);
      meta.append(el('span', 'pv-info', facts.join(' · ')), el('span', 'pv-hint', 'Ctrl+clic para abrir'));
    }
    card.replaceChildren(body, meta);
    card.dataset.kind = data.loading ? 'loading' : data.kind;
    card.hidden = false;
    placePreview(card, at);
  }

  // Junto al puntero, sin salirse de la ventana.
  function placePreview(card, at) {
    const gap = 16;
    const box = card.getBoundingClientRect();
    let x = at.x + gap;
    let y = at.y + gap;
    if (x + box.width > window.innerWidth - 8) x = Math.max(8, at.x - gap - box.width);
    if (y + box.height > window.innerHeight - 8) y = Math.max(8, at.y - gap - box.height);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  // ── Contexto del proyecto ────────────────────────────────────────
  // Cada pestaña puede tener una nota y una lista de documentos y carpetas que
  // Claude tiene presentes en todas sus sesiones. Aquí se editan; el proceso
  // principal (src/main/context.js) se los da a Claude.

  const MAX_CONTEXT_ITEMS = 100;
  const emptyContext = () => ({ note: '', items: [] });

  function cleanContext(raw) {
    const ctx = emptyContext();
    if (!raw || typeof raw !== 'object') return ctx;
    ctx.note = typeof raw.note === 'string' ? raw.note.slice(0, 8000) : '';
    const seen = new Set();
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      if (!item) continue;
      if (typeof item.url === 'string') {
        // Enlace web: { url, title, warning, enabled }.
        const url = webUrl(item.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        ctx.items.push({
          url,
          title: typeof item.title === 'string' ? item.title.slice(0, 160) : null,
          warning: item.warning === 'login' || item.warning === 'error' ? item.warning : null,
          enabled: item.enabled !== false,
        });
      } else if (typeof item.path === 'string' && item.path && !seen.has(item.path.toLowerCase())) {
        seen.add(item.path.toLowerCase());
        ctx.items.push({ path: item.path, enabled: item.enabled !== false });
      }
      if (ctx.items.length >= MAX_CONTEXT_ITEMS) break;
    }
    return ctx;
  }

  // La dirección normalizada si es un enlace http(s); si no, null.
  function webUrl(text) {
    try {
      const url = new URL(String(text).trim());
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function ensureContext(tab) {
    if (!tab.context) tab.context = emptyContext();
    return tab.context;
  }

  // Lo que indica el número del botón «Contexto»: documentos activos y la nota.
  function contextCount(tab) {
    const ctx = tab.context || emptyContext();
    return ctx.items.filter((i) => i.enabled !== false).length + (ctx.note.trim() ? 1 : 0);
  }

  function hasFiles(e) {
    return Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
  }

  function droppedPaths(e) {
    return [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  }

  // Un enlace arrastrado desde el navegador.
  function hasLink(e) {
    return Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('text/uri-list');
  }

  function droppedLinks(e) {
    const list = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    const plain = (e.dataTransfer.getData('text/plain') || '').trim();
    return (list.length ? list : [plain]).map(webUrl).filter(Boolean);
  }

  const CTX_HOW = {
    carpeta: 'Claude puede leer todo lo que hay dentro',
    PDF: 'Claude lo lee cuando le hace falta',
    Word: 'Pasado a texto; Claude lo lee cuando le hace falta',
    imagen: 'Claude la mira cuando le hace falta',
    texto: 'Claude lo lee cuando le hace falta',
    archivo: 'Claude intentará abrirlo con sus herramientas',
    web: 'Claude la abre cuando le hace falta',
  };
  const CTX_KIND = { PDF: 'PDF', Word: 'Word', imagen: 'Imagen', texto: 'Texto' };
  const FOLDER_ICON = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5h4.2l1.3 1.6h7.5v6.9h-13z"/></svg>';
  const WEB_ICON = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c1.9 1.8 2.8 3.9 2.8 6.3S9.9 12.5 8 14.3M8 1.7C6.1 3.5 5.2 5.6 5.2 8s.9 4.5 2.8 6.3"/></svg>';
  const MISSING_ICON = '<svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.8M8 11.1v.1"/></svg>';

  function buildContextPanel(view) {
    const panel = el('aside', 'ctx');
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Contexto del proyecto');

    const head = el('div', 'ctx-head');
    const titles = el('div', 'ctx-titles');
    view.ctxTitle = el('h2', '', 'Contexto del proyecto');
    view.ctxSub = el('p', 'ctx-sub', `Claude lo tiene presente en cada sesión de «${view.tab.name}»`);
    titles.append(view.ctxTitle, view.ctxSub);
    const close = el('button', 'icon-btn ctx-close');
    close.innerHTML = SVG.close;
    close.title = 'Cerrar el panel';
    close.setAttribute('aria-label', 'Cerrar el panel de contexto');
    close.addEventListener('click', () => toggleContext(view, false));
    head.append(titles, close);

    const body = el('div', 'ctx-body');
    const noteLabel = el('label', 'ctx-label', 'Nota para Claude');
    view.ctxNote = el('textarea', 'ctx-note');
    view.ctxNote.id = `ctx-note-${view.tab.id}`;
    noteLabel.htmlFor = view.ctxNote.id;
    view.ctxNote.placeholder = 'De qué va el proyecto, normas, cómo quieres que responda…';
    view.ctxNote.maxLength = 8000;
    view.ctxNote.addEventListener('input', () => {
      ensureContext(view.tab).note = view.ctxNote.value;
      contextChanged(view, false);
    });
    view.ctxDocsLabel = el('div', 'ctx-label', 'Documentos y enlaces');
    view.ctxItems = el('div', 'ctx-items');
    const drop = el('div', 'ctx-drop');
    const row = el('div', 'ctx-drop-row');
    const addFiles = el('button', 'btn', 'Añadir archivos…');
    const addFolder = el('button', 'btn', 'Añadir carpeta…');
    const addLink = el('button', 'btn', 'Añadir enlace…');
    addFiles.addEventListener('click', async () => addToContext(view, await api.contextPick('files')));
    addFolder.addEventListener('click', async () => addToContext(view, await api.contextPick('folder')));
    row.append(addFiles, addFolder, addLink);
    // Campo para escribir o pegar la dirección de una página web.
    const linkForm = el('form', 'ctx-link-form');
    linkForm.hidden = true;
    linkForm.noValidate = true;
    const linkInput = el('input');
    linkInput.type = 'url';
    linkInput.placeholder = 'https://…';
    linkInput.spellcheck = false;
    linkInput.setAttribute('aria-label', 'Dirección de la página web');
    const linkOk = el('button', 'btn', 'Añadir');
    linkOk.type = 'submit';
    const linkCancel = el('button', 'btn', 'Cancelar');
    linkCancel.type = 'button';
    linkForm.append(linkInput, linkOk, linkCancel);
    const closeLinkForm = () => { linkForm.hidden = true; row.hidden = false; };
    addLink.addEventListener('click', () => {
      row.hidden = true;
      linkForm.hidden = false;
      linkInput.value = '';
      linkInput.focus();
    });
    linkCancel.addEventListener('click', closeLinkForm);
    linkInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeLinkForm(); } });
    linkForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (addLinks(view, linkInput.value.split(/\s+/).filter(Boolean))) closeLinkForm();
      else linkInput.focus();
    });
    drop.append(el('span', '', 'Arrastra aquí archivos, carpetas o enlaces'), row, linkForm);
    body.append(noteLabel, view.ctxNote, view.ctxDocsLabel, view.ctxItems, drop);

    // Vista alternativa: el texto exacto que recibe Claude.
    const sent = el('div', 'ctx-body');
    sent.hidden = true;
    view.ctxPrompt = el('pre', 'ctx-prompt');
    sent.append(el('div', 'ctx-label', 'Así se lo cuenta ClaudHome a Claude'), view.ctxPrompt);
    view.ctxSent = sent;

    const foot = el('div', 'ctx-foot');
    const toggleSent = el('button', 'ctx-link', 'Ver lo que recibe Claude →');
    toggleSent.addEventListener('click', () => {
      const showSent = sent.hidden;
      sent.hidden = !showSent;
      body.hidden = showSent;
      toggleSent.textContent = showSent ? '← Volver al contexto' : 'Ver lo que recibe Claude →';
      view.ctxTitle.textContent = showSent ? 'Lo que recibe Claude' : 'Contexto del proyecto';
      if (showSent) refreshContextPrompt(view);
    });
    foot.append(toggleSent, el('span', '', 'Se aplica al empezar la sesión. Si lo cambias con la sesión abierta, Claude se entera con tu siguiente mensaje.'));

    panel.append(head, body, sent, foot);

    // Soltar archivos, carpetas o enlaces (desde el navegador) sobre el panel los añade.
    panel.addEventListener('dragover', (e) => {
      if (!hasFiles(e) && !hasLink(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      panel.classList.add('drag');
    });
    panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag'); });
    panel.addEventListener('drop', (e) => {
      if (!hasFiles(e) && !hasLink(e)) return;
      e.preventDefault();
      e.stopPropagation();
      panel.classList.remove('drag');
      if (hasFiles(e)) addToContext(view, droppedPaths(e));
      else addLinks(view, droppedLinks(e));
    });
    return panel;
  }

  // Muestra u oculta el panel según la pestaña y, si se ve, lo rellena.
  function syncContextPanel(view) {
    view.ctxEl.hidden = !view.tab.contextOpen;
    if (!view.tab.contextOpen) return;
    if (document.activeElement !== view.ctxNote) view.ctxNote.value = ensureContext(view.tab).note;
    renderContextItems(view);
    if (!view.ctxSent.hidden) refreshContextPrompt(view);
  }

  function toggleContext(view = views.get(S.activeId), open) {
    if (!view) return;
    view.tab.contextOpen = open === undefined ? !view.tab.contextOpen : Boolean(open);
    syncContextPanel(view);
    renderToolbar();
    save();
    requestAnimationFrame(() => {
      fitView(view);
      if (!view.tab.contextOpen && view.tab.id === S.activeId) focusTerminal();
    });
  }

  async function refreshContextPrompt(view) {
    let text = '';
    try { text = await api.contextPrompt(view.tab.id, view.tab.name, ensureContext(view.tab)); } catch { /* sin vista */ }
    view.ctxPrompt.textContent = text || 'Esta pestaña no tiene contexto: Claude no recibe nada adicional.';
  }

  const contextTimers = new Map();

  // Algo ha cambiado: se guarda, se repinta y se avisa al proceso principal (que
  // se lo dará a Claude en su siguiente mensaje si la sesión está abierta).
  function contextChanged(view, listChanged = true) {
    save();
    renderToolbar();
    if (listChanged) renderContextItems(view);
    clearTimeout(contextTimers.get(view.tab.id));
    contextTimers.set(view.tab.id, setTimeout(() => {
      api.contextUpdate(view.tab.id, view.tab.name, ensureContext(view.tab)).catch(() => { /* se aplicará al reiniciar */ });
      if (!view.ctxSent.hidden) refreshContextPrompt(view);
    }, 400));
  }

  function addToContext(view, paths) {
    const list = (paths || []).filter((p) => typeof p === 'string' && p);
    if (!list.length) return;
    const ctx = ensureContext(view.tab);
    const have = new Set(ctx.items.filter((i) => i.path).map((i) => i.path.toLowerCase()));
    let added = 0;
    for (const p of list) {
      if (have.has(p.toLowerCase()) || ctx.items.length >= MAX_CONTEXT_ITEMS) continue;
      ctx.items.push({ path: p, enabled: true });
      have.add(p.toLowerCase());
      added += 1;
    }
    contextChanged(view);
    if (!view.tab.contextOpen) toggleContext(view, true);
    toast(added === 0 ? 'Eso ya estaba en el contexto del proyecto.'
      : added === 1 ? 'Añadido al contexto del proyecto.' : `${added} elementos añadidos al contexto del proyecto.`);
  }

  // Añade enlaces web. Devuelve false si alguno no era una dirección válida.
  function addLinks(view, texts) {
    const ctx = ensureContext(view.tab);
    const have = new Set(ctx.items.filter((i) => i.url).map((i) => i.url));
    const added = [];
    let invalid = 0;
    for (const text of texts || []) {
      const url = webUrl(text);
      if (!url) { invalid += 1; continue; }
      if (have.has(url) || ctx.items.length >= MAX_CONTEXT_ITEMS) continue;
      const item = { url, title: null, warning: null, enabled: true };
      ctx.items.push(item);
      have.add(url);
      added.push(item);
    }
    if (!added.length) {
      toast(invalid ? 'Eso no es una dirección web: tiene que empezar por http:// o https://.' : 'Ese enlace ya estaba en el contexto del proyecto.');
      return invalid === 0;
    }
    contextChanged(view);
    if (!view.tab.contextOpen) toggleContext(view, true);
    toast((added.length === 1 ? 'Enlace añadido al contexto del proyecto.' : `${added.length} enlaces añadidos al contexto del proyecto.`)
      + (invalid ? ` ${invalid === 1 ? 'Uno no era' : `${invalid} no eran`} una dirección web y no se ha añadido.` : ''));
    // Título de cada página y aviso si pide iniciar sesión (Claude no podría leerla).
    for (const item of added) {
      api.contextLink(item.url).then((info) => {
        if (!info) return;
        item.title = info.title || null;
        item.warning = info.login ? 'login' : info.ok ? null : 'error';
        contextChanged(view);
      }).catch(() => { /* sin título */ });
    }
    return invalid === 0;
  }

  async function renderContextItems(view) {
    const ctx = ensureContext(view.tab);
    const token = (view.ctxToken || 0) + 1;
    view.ctxToken = token;
    view.ctxDocsLabel.textContent = ctx.items.length ? `Documentos y enlaces · ${ctx.items.length}` : 'Documentos y enlaces';
    if (!ctx.items.length) {
      view.ctxItems.replaceChildren(el('p', 'ctx-empty', 'Todavía no hay nada. Añade PDF, Word, imágenes, textos, carpetas o enlaces web que ayuden a Claude a entender el proyecto.'));
      return;
    }
    let infos = [];
    try { infos = await api.contextDescribe(ctx.items); } catch { /* se pinta sin datos */ }
    if (token !== view.ctxToken) return; // ya hay un repintado más nuevo
    view.ctxItems.replaceChildren(...ctx.items.map((item, i) => contextCard(view, item, infos[i] || { path: item.path, name: item.path, exists: false })));
  }

  function contextCard(view, item, info) {
    const on = item.enabled !== false;
    const target = item.url || item.path; // dirección web o ruta del archivo
    const card = el('div', 'ctx-item');
    card.classList.toggle('off', !on);
    card.classList.toggle('missing', !info.exists);
    card.title = info.exists ? `${target}\n${item.url ? 'Doble clic para abrirla en el navegador' : 'Doble clic para abrirlo'}` : target;
    const thumb = el('div', 'ctx-thumb');
    const meta = el('span', 'ctx-meta');
    const how = el('span', 'ctx-how');
    const body = el('div', 'ctx-info');
    body.append(el('strong', '', info.name || target), meta, how);

    if (info.isLink) {
      thumb.innerHTML = WEB_ICON;
      thumb.dataset.kind = 'web';
      meta.textContent = `Web · ${info.host}`;
      const warning = item.warning === 'login' ? 'Parece que pide iniciar sesión: Claude no podrá leerla.'
        : item.warning === 'error' ? 'No se ha podido abrir desde aquí; puede que Claude tampoco.' : '';
      card.classList.toggle('missing', Boolean(warning));
      how.textContent = !on ? 'Desactivado: Claude no la recibe' : warning || CTX_HOW.web;
    } else if (!info.exists) {
      thumb.innerHTML = MISSING_ICON;
      thumb.dataset.kind = 'missing';
      meta.textContent = 'No encontrado';
      how.textContent = '¿Se ha movido o borrado? Claude no lo recibe.';
    } else if (info.isDir) {
      thumb.innerHTML = FOLDER_ICON;
      thumb.dataset.kind = 'dir';
      meta.textContent = `Carpeta · ${info.many ? 'más de 2000 archivos' : `${info.files} archivo${info.files === 1 ? '' : 's'}`}`;
      how.textContent = on ? CTX_HOW.carpeta : 'Desactivada: Claude no la recibe';
    } else {
      thumb.dataset.kind = 'file';
      const ext = (info.name.includes('.') ? info.name.split('.').pop() : '').toUpperCase();
      meta.textContent = `${CTX_KIND[info.kind] || ext || 'Archivo'} · ${formatSize(info.size)}`;
      how.textContent = on ? (CTX_HOW[info.kind] || CTX_HOW.archivo) : 'Desactivado: Claude no lo recibe';
      // Miniatura y datos de la vista previa (páginas de un PDF, tamaño de una imagen).
      api.preview(item.path).then((data) => {
        if (!data || !card.isConnected) return;
        if (data.kind === 'text') {
          thumb.dataset.kind = 'text';
          thumb.replaceChildren(...Array.from({ length: 6 }, () => el('i')));
        } else if (data.image) {
          const img = el('img');
          img.alt = '';
          img.src = data.image;
          thumb.dataset.kind = data.kind;
          thumb.replaceChildren(img);
        }
        const extra = [];
        if (data.pages) extra.push(data.pages === 1 ? '1 página' : `${data.pages} páginas`);
        if (data.width && data.height) extra.push(`${data.width} × ${data.height}`);
        if (extra.length) meta.textContent += ` · ${extra.join(' · ')}`;
      }).catch(() => { /* sin miniatura */ });
    }

    const side = el('div', 'ctx-side');
    const toggle = el('button', 'ctx-switch');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(on));
    toggle.setAttribute('aria-label', `${on ? 'Desactivar' : 'Activar'} ${info.name || target}`);
    toggle.title = on ? 'Activado: Claude lo recibe. Pulsa para desactivarlo sin quitarlo.' : 'Desactivado. Pulsa para activarlo.';
    toggle.addEventListener('click', () => { item.enabled = !on; contextChanged(view); });
    const remove = el('button', 'ctx-remove');
    remove.innerHTML = SVG.close;
    remove.title = 'Quitar del contexto';
    remove.setAttribute('aria-label', `Quitar ${info.name || target} del contexto`);
    remove.addEventListener('click', () => {
      const ctx = ensureContext(view.tab);
      ctx.items = ctx.items.filter((x) => x !== item);
      contextChanged(view);
    });
    side.append(toggle, remove);
    card.append(thumb, body, side);
    if (info.exists) card.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.openPath(target); });
    return card;
  }

  // Soltar archivos sobre la sesión de Claude: elegir entre pegarlos en el mensaje
  // (como siempre) o añadirlos al contexto del proyecto.
  function wireDropChoice(view, wrap) {
    const overlay = el('div', 'drop-choice');
    overlay.hidden = true;
    const zone = (title, text) => {
      const node = el('div', 'drop-zone');
      node.append(el('strong', '', title), el('span', '', text));
      return node;
    };
    const pasteZone = zone('Pegar en el mensaje', 'Como siempre: la ruta, la imagen o el enlace va en lo que estás escribiendo, solo para esta pregunta.');
    const ctxZone = zone('Añadir al contexto del proyecto', 'Se queda guardado en esta pestaña y Claude lo tendrá presente en todas las sesiones.');
    overlay.append(pasteZone, ctxZone);
    wrap.append(overlay);
    let hideTimer = null;
    wrap.addEventListener('dragover', (e) => {
      if (!hasFiles(e) && !hasLink(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      overlay.hidden = false;
      const target = e.target instanceof Element ? e.target.closest('.drop-zone') : null;
      pasteZone.classList.toggle('hot', target === pasteZone);
      ctxZone.classList.toggle('hot', target === ctxZone);
      // Mientras se arrastra llegan avisos sin parar; si dejan de llegar, el ratón ya no está aquí.
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { overlay.hidden = true; }, 250);
    });
    wrap.addEventListener('drop', (e) => {
      if (!hasFiles(e) && !hasLink(e)) return;
      e.preventDefault();
      clearTimeout(hideTimer);
      overlay.hidden = true;
      const target = e.target instanceof Element ? e.target.closest('.drop-zone') : null;
      if (!hasFiles(e)) {
        // Un enlace arrastrado desde el navegador.
        const links = droppedLinks(e);
        if (!links.length) return;
        if (target === ctxZone) { addLinks(view, links); return; }
        view.term.paste(`${links.join(' ')} `);
        view.term.focus();
        return;
      }
      const files = droppedPaths(e);
      if (!files.length) return;
      if (target === ctxZone) { addToContext(view, files); return; }
      const before = imageLabelCounts(view.term);
      view.term.paste(joinPaths(files));
      view.term.focus();
      learnImageLabels(view, files, before);
    });
  }

  function createView(tab, mode) {
    const view = {
      tab, mode, status: 'asleep', started: false, opened: false, exited: false,
      resumed: false, startedAt: 0, extra: null, lastFocus: 'claude',
      images: new Map(), // n de [Image #n] → imagen pegada, mientras dura la sesión de Claude
    };
    view.el = el('div', 'tabview');
    view.main = el('div', 'tabmain'); // Claude y, debajo, la terminal extra
    const wrap = el('div', 'term-wrap');
    view.host = el('div', 'term-host');
    wrap.append(view.host);
    view.term = makeTerminal(tab.zoom, THEME);
    view.fit = new FitAddon.FitAddon();
    view.term.loadAddon(view.fit);
    view.extraEl = buildExtraPanel(view);
    view.main.append(wrap, view.extraEl);
    view.ctxEl = buildContextPanel(view); // a la derecha: contexto del proyecto
    view.el.append(view.main, view.ctxEl);
    wireDropChoice(view, wrap);
    if (tab.contextOpen) syncContextPanel(view);

    terms.set(tab.id, view.term);
    view.term.onData((data) => {
      view.lastActive = Date.now();
      if (view.started) api.ptyWrite(tab.id, data);
      else if (view.exited && data === '\r') { view.term.reset(); startClaude(view); }
    });
    // Al contestar a una petición de permiso, la sesión vuelve a estar trabajando.
    view.term.onKey(({ domEvent }) => {
      if (view.status === 'needs' && /^(Enter|Escape|[0-9])$/.test(domEvent.key)) setStatus(view, 'working');
    });
    view.term.onResize(({ cols, rows }) => { if (view.started) api.ptyResize(tab.id, cols, rows); });
    wireKeys(view.term, tab.id, view, true);
    wireHost(view.host, view.term, tab.id, view, true);
    registerPreviewLinks(view.term, view, true);

    views.set(tab.id, view);
    return view;
  }

  function shellName(key) {
    const found = info.shells.find((s) => s.key === key);
    return found ? found.name : 'PowerShell';
  }

  function buildExtraPanel(view) {
    const panel = el('div', 'extra');
    panel.hidden = true;
    if (view.tab.extraHeight) panel.style.height = `${view.tab.extraHeight}px`;

    const grip = el('div', 'extra-grip');
    grip.addEventListener('mousedown', (e) => startDrag(e, 'row-resize', (ev) => {
      const box = view.el.getBoundingClientRect();
      const height = Math.round(clamp(box.bottom - ev.clientY, 120, Math.max(120, box.height - 140)));
      panel.style.height = `${height}px`;
      view.tab.extraHeight = height;
      queueFit();
    }, save));

    const head = el('div', 'extra-head');
    head.innerHTML = `${SVG.terminal}<strong>Terminal</strong>`;
    head.append(el('span', 'sub', `${shellName(view.tab.shell)} · misma carpeta que la sesión`));
    const hide = el('button', 'icon-btn');
    hide.setAttribute('aria-label', 'Ocultar la terminal');
    hide.title = 'Ocultar la terminal (Ctrl+ñ)';
    hide.innerHTML = SVG.close;
    hide.addEventListener('click', () => toggleExtra(view));
    head.append(hide);

    const wrap = el('div', 'term-wrap');
    view.extraHost = el('div', 'term-host');
    wrap.append(view.extraHost);
    panel.append(grip, head, wrap);
    return panel;
  }

  function ensureExtra(view) {
    if (view.extra) return view.extra;
    const ptyId = `${view.tab.id}:sh`;
    const term = makeTerminal(view.tab.zoom, THEME_EXTRA);
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const extra = { term, fit, ptyId, opened: false, started: false, exited: false };
    term.onData((data) => {
      if (extra.started) api.ptyWrite(ptyId, data);
      else if (extra.exited && data === '\r') { term.reset(); startShell(view); }
    });
    term.onResize(({ cols, rows }) => { if (extra.started) api.ptyResize(ptyId, cols, rows); });
    wireKeys(term, ptyId, view, false);
    wireHost(view.extraHost, term, ptyId, view, false);
    registerPreviewLinks(term, view, false);
    terms.set(ptyId, term);
    view.extra = extra;
    return extra;
  }

  async function startShell(view) {
    const extra = view.extra;
    extra.started = true;
    extra.exited = false;
    const res = await api.ptyCreate({
      id: extra.ptyId, kind: 'shell', shell: view.tab.shell, cwd: view.tab.cwd,
      cols: extra.term.cols, rows: extra.term.rows,
    });
    if (!views.has(view.tab.id)) { api.ptyKill(extra.ptyId); return; }
    if (!res.ok) {
      extra.started = false;
      extra.exited = true;
      extra.term.writeln(`\x1b[31m${res.error}\x1b[0m`);
      extra.term.writeln('\x1b[2mPulsa Intro para reintentar.\x1b[0m');
    }
  }

  async function startClaude(view) {
    const tab = view.tab;
    const mode = view.mode || 'resume';
    view.mode = 'resume';
    view.started = true;
    view.exited = false;
    view.startedAt = Date.now();
    view.images = new Map(); // otra sesión de Claude: su numeración de imágenes empieza de nuevo
    view.usage = null; // llenado de la conversación: llega con la línea de estado
    view.keepAwake = false; // pasa a true si Claude deja algo en marcha (no se duerme)
    setStatus(view, 'starting');
    // Una misma conversación no se abre en dos pestañas a la vez.
    const exclude = S.tabs.filter((t) => t.id !== tab.id && t.sessionId).map((t) => t.sessionId);
    const res = await api.ptyCreate({
      id: tab.id, kind: 'claude', name: tab.name, cwd: tab.cwd, sessionId: tab.sessionId, mode, exclude, context: tab.context,
      cols: view.term.cols, rows: view.term.rows,
    });
    if (!views.has(tab.id)) { api.ptyKill(tab.id); return; } // se cerró mientras arrancaba
    if (!res.ok) {
      view.started = false;
      view.exited = true;
      setStatus(view, 'exited');
      view.term.writeln(`\x1b[31m${res.error}\x1b[0m`);
      view.term.writeln('\x1b[2mPulsa Intro para reintentar.\x1b[0m');
      return;
    }
    view.resumed = Boolean(res.resumed);
    view.codex = Boolean(res.codex); // arrancó con la herramienta de imágenes de Codex
    tab.sessionId = res.sessionId;
    save();
    if (view.status === 'starting') setStatus(view, 'idle');
    renderToolbar();
  }

  // Reinicia Claude en la pestaña conservando su conversación (para que tome
  // ajustes que solo se aplican al arrancar, como la herramienta de Codex).
  async function restartSession(view) {
    const id = view.tab.id;
    view.started = false;
    view.exited = false;
    await api.ptyKill(id);
    if (!views.has(id)) return;
    view.term.reset();
    view.mode = 'resume';
    if (visibleIds().includes(id) && view.opened) startClaude(view);
    else setStatus(view, 'asleep');
  }

  // ── Sesiones dormidas ────────────────────────────────────────────
  // Una sesión que lleva un rato esperando tu mensaje en una pestaña que no estás
  // viendo se cierra para liberar memoria: Claude y sus servidores MCP ocupan en
  // torno a 1 GB por sesión. La conversación queda guardada y se retoma sola al
  // abrir la pestaña, como al arrancar ClaudHome. No se duerme si está trabajando,
  // si te necesita o tiene algo que no has visto, ni si Claude dejó algo en marcha
  // (una tarea en segundo plano, una vigilancia o una tarea programada).
  let sleepAfterMs = 45 * 60 * 1000;

  function sleepIdleSessions() {
    const now = Date.now();
    const shown = visibleIds();
    for (const view of views.values()) {
      if (shown.includes(view.tab.id)) { view.lastActive = now; continue; }
      if (!view.started || view.closing || view.keepAwake || view.status !== 'idle') continue;
      if (now - (view.lastActive || now) >= sleepAfterMs) putToSleep(view);
    }
  }

  async function putToSleep(view) {
    const id = view.tab.id;
    api.log(`«${view.tab.name}» se duerme tras ${Math.round((Date.now() - view.lastActive) / 60000)} min sin actividad`);
    view.started = false;
    view.exited = false;
    view.goingToSleep = true; // si abres la pestaña mientras se cierra, arranca al terminar
    await api.ptyKill(id);
    view.goingToSleep = false;
    if (!views.has(id)) return;
    view.term.reset();
    view.mode = 'resume';
    if (visibleIds().includes(id) && view.opened) startClaude(view);
    else setStatus(view, 'sleeping');
  }

  // ── Codex ────────────────────────────────────────────────────────

  let codexInfo = null;

  function renderCodex(info) {
    if (info) codexInfo = info;
    const chip = $('#codex-chip');
    if (!codexInfo) { chip.hidden = true; return; }
    let state = 'missing';
    let label;
    let title;
    if (!codexInfo.installed) {
      label = 'Codex no detectado';
      title = 'No encuentro Codex en este equipo. Si lo instalas e inicias sesión con tu suscripción de ChatGPT, Claude podrá pedirle imágenes. Pulsa para volver a comprobar.';
    } else if (!codexInfo.loggedIn) {
      label = 'Codex sin sesión';
      title = 'Codex está instalado pero sin sesión iniciada. Ejecuta «codex login» y pulsa aquí para volver a comprobar.';
    } else if (codexInfo.mode !== 'chatgpt') {
      label = 'Codex sin suscripción';
      title = 'Codex tiene sesión con una clave de API, no con una suscripción de ChatGPT. Las imágenes con Codex solo se activan con suscripción.';
    } else if (!codexInfo.enabled) {
      state = 'ready';
      label = 'Codex detectado';
      title = 'Suscripción de ChatGPT detectada en Codex. Pulsa para que Claude pueda pedirle imágenes a Codex.';
    } else if (codexInfo.busy > 0) {
      state = 'busy';
      label = 'Codex generando…';
      title = 'Codex está generando una imagen para una sesión.';
    } else {
      state = 'on';
      label = 'Imágenes con Codex';
      title = 'Activado: Claude puede pedir imágenes a Codex con tu suscripción. Pulsa para desactivarlo.';
    }
    chip.hidden = false;
    chip.dataset.state = state;
    chip.title = title;
    chip.setAttribute('aria-pressed', String(Boolean(codexInfo.active)));
    $('#codex-label').textContent = label;
    renderToolbar();
  }

  async function toggleCodex() {
    if (!codexInfo || !codexInfo.usable) {
      // No disponible: se vuelve a comprobar por si acaba de instalarse o de iniciar sesión.
      renderCodex(await api.codexStatus(true));
      toast($('#codex-chip').title);
      return;
    }
    renderCodex(await api.codexSetEnabled(!codexInfo.enabled));
    if (!codexInfo.enabled) {
      toast('Imágenes con Codex desactivadas.');
      return;
    }
    // La herramienta se entrega al arrancar Claude: las sesiones ya abiertas no la tienen.
    const idle = [...views.values()].filter((v) => v.started && !v.codex && !v.closing && ['idle', 'done', 'failed'].includes(v.status));
    const busy = [...views.values()].filter((v) => v.started && !v.codex && !idle.includes(v)).length;
    if (!idle.length) {
      toast(busy ? 'Imágenes con Codex activadas. Las sesiones que están trabajando lo tendrán cuando las reinicies.' : 'Imágenes con Codex activadas.');
      return;
    }
    const choice = await api.choose({
      message: 'Imágenes con Codex activadas',
      detail: `Las sesiones ya abiertas necesitan reiniciarse para recibir la herramienta. Hay ${idle.length === 1 ? 'una sesión en reposo' : `${idle.length} sesiones en reposo`}: se pueden reiniciar ahora y conservan su conversación.`
        + (busy ? ' Las que están trabajando no se tocan.' : ''),
      buttons: ['Reiniciar las que están en reposo', 'Más tarde'],
    });
    if (choice === 0) for (const view of idle) if (views.has(view.tab.id)) restartSession(view);
  }

  function syncExtra(view) {
    const open = Boolean(view.tab.extraOpen);
    view.extraEl.hidden = !open;
    if (!open) return;
    const extra = ensureExtra(view);
    if (!extra.opened) {
      extra.term.open(view.extraHost);
      extra.opened = true;
    }
  }

  function fitView(view) {
    if (!view.opened || !view.el.isConnected) return;
    if (view.host.clientWidth < 40 || view.host.clientHeight < 20) return;
    try { view.fit.fit(); } catch { /* aún sin medidas */ }
    const extra = view.extra;
    if (extra && extra.opened && !view.extraEl.hidden && view.extraHost.clientHeight > 20) {
      try { extra.fit.fit(); } catch { /* aún sin medidas */ }
      if (!extra.started && !extra.exited) startShell(view);
    }
  }

  // Prepara una vista que acaba de quedar a la vista: abre su terminal, la
  // ajusta al hueco y arranca Claude si todavía no estaba en marcha.
  function showView(view) {
    if (!view.opened) {
      view.term.open(view.host);
      view.opened = true;
    }
    syncExtra(view);
    fitView(view);
    if (!view.started && !view.exited && !view.goingToSleep) startClaude(view);
  }

  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      for (const id of visibleIds()) {
        const view = views.get(id);
        if (view) fitView(view);
      }
    });
  }

  function focusTerminal() {
    if (dialogOpen() || renamingId) return;
    const view = views.get(S.activeId);
    if (!view || !view.opened) return;
    const extra = view.extra;
    if (view.lastFocus === 'extra' && extra && extra.opened && view.tab.extraOpen) extra.term.focus();
    else view.term.focus();
  }

  function setZoom(view, zoom) {
    const next = clamp(Math.round(zoom * 10) / 10, 0.6, 2.4);
    if (next === (view.tab.zoom || 1)) return;
    view.tab.zoom = next;
    view.term.options.fontSize = fontSizeFor(next);
    if (view.extra) view.extra.term.options.fontSize = fontSizeFor(next);
    fitView(view);
    renderStatusbar();
    save();
  }

  function toggleExtra(view = views.get(S.activeId)) {
    if (!view) return;
    view.tab.extraOpen = !view.tab.extraOpen;
    view.lastFocus = view.tab.extraOpen ? 'extra' : 'claude';
    syncExtra(view);
    renderToolbar();
    save();
    requestAnimationFrame(() => {
      fitView(view);
      if (view.tab.id === S.activeId) focusTerminal();
    });
  }

  // ── Estado de las sesiones y avisos ──────────────────────────────

  function setStatus(view, status) {
    // Mientras guarda su estado para cerrar, la pestaña se queda en ese estado.
    if (view.closing && status !== 'closing') return;
    view.lastActive = Date.now();
    if (view.status === status) return;
    api.log(`estado de «${view.tab.name}»: ${view.status} → ${status}`);
    view.status = status;
    renderTabs();
    renderHeads();
    renderStatusbar();
  }

  // Cierre ordenado: interrumpe lo que Claude esté haciendo y le pide que deje
  // anotado su estado. La promesa se resuelve con:
  //   'saved'  → Claude ha terminado de escribir su resumen
  //   'forced' → el usuario no ha querido esperar
  //   'failed' → no se pudo enviar la petición o ha tardado demasiado
  function wrapUp(view) {
    if (view.closing) return view.closing.promise;
    if (!view.started) return Promise.resolve('failed');
    const closing = { sent: false, submitted: false, result: null, timers: [] };
    closing.promise = new Promise((resolve) => {
      closing.finish = (result) => {
        if (closing.result) return;
        closing.result = result;
        closing.timers.forEach(clearTimeout);
        resolve(result);
      };
    });
    view.closing = closing;
    setStatus(view, 'closing');
    const later = (ms, fn) => closing.timers.push(setTimeout(fn, ms));
    api.ptyWrite(view.tab.id, '\x1b'); // Esc interrumpe el turno en curso (o rechaza el permiso pendiente)
    later(1500, () => view.term.paste(WRAPUP_PROMPT));
    later(1900, () => { closing.sent = true; api.ptyWrite(view.tab.id, '\r'); });
    later(1900 + 15000, () => { if (!closing.submitted) closing.finish('failed'); });
    later(3 * 60 * 1000, () => closing.finish('failed'));
    return closing.promise;
  }

  // Deja que Claude salga por sí mismo, como al pulsar Ctrl+C hasta salir: la
  // primera pulsación vacía el cuadro si tenía texto, las siguientes cierran.
  // Quien llama termina después el proceso si en unos segundos no ha salido.
  async function gracefulExit(view) {
    if (!view.started) return;
    view.expectExit = true;
    let exited = false;
    const gone = new Promise((resolve) => { view.onExit = () => { exited = true; resolve(); }; });
    for (let press = 0; press < 4 && !exited; press += 1) {
      api.ptyWrite(view.tab.id, '\x03');
      await Promise.race([gone, sleep(600)]);
    }
    await Promise.race([gone, sleep(5000)]); // Claude tarda unos 3 s en cerrarse
    console.log(`[cierre] ${view.tab.name}: salida ${exited ? 'ordenada' : 'forzada'}`);
    api.log(`cierre ordenado de «${view.tab.name}»: salida ${exited ? 'por sí mismo' : 'forzada por la app'}`);
  }

  // ── Actualización ────────────────────────────────────────────────
  // El proceso principal comprueba GitHub; aquí solo se pinta el botón y se
  // avisa de cómo va.

  let updateInfo = null;

  function renderUpdate(info) {
    const prev = updateInfo;
    if (info) updateInfo = info;
    const u = updateInfo;
    if (!u) return;
    if (u.status === 'error' && u.error && !(prev && prev.status === 'error' && prev.error === u.error)) {
      toast(`No se pudo actualizar: ${u.error}`);
    }
    const button = $('#update-btn');
    button.hidden = !u.latest || !['available', 'working', 'ready', 'error'].includes(u.status);
    if (button.hidden) return;
    button.dataset.state = u.status;
    button.setAttribute('aria-disabled', String(u.status === 'working'));
    const icon = $('#update-icon');
    const label = $('#update-label');
    if (u.status === 'working') {
      icon.innerHTML = SVG.working;
      label.textContent = `${u.step}…`;
      button.title = `Generando ClaudHome ${u.latest} en segundo plano. Puedes seguir trabajando.`;
    } else if (u.status === 'ready') {
      icon.innerHTML = SVG.update;
      label.textContent = 'Reiniciar para actualizar';
      button.title = `ClaudHome ${u.latest} está lista. Pulsa para cerrar y volver a abrir ClaudHome con la versión nueva: tus pestañas se restauran.`;
    } else {
      icon.innerHTML = SVG.update;
      label.textContent = `Actualizar a v${u.latest}`;
      button.title = u.status === 'error'
        ? `El último intento ha fallado: ${u.error} Pulsa para reintentar.`
        : `Hay una versión nueva de ClaudHome en GitHub (tienes la ${u.current}). Pulsa para ver qué cambia y decidir si actualizar.`;
    }
  }

  // Un punto del historial de cambios: lo que va entre `comillas invertidas` se ve como código.
  function appendInline(node, text) {
    String(text).split('`').forEach((part, i) => {
      if (part) node.append(i % 2 ? el('code', '', part) : document.createTextNode(part));
    });
  }

  function fillChanges(changes) {
    const n = changes.versions.length;
    $('#upd-summary').textContent = `Tienes la versión ${changes.current}. `
      + (n > 1 ? `Hay ${n} versiones nuevas, hasta la ${changes.latest}. Esto es lo que cambia:` : `Esto es lo que trae la ${changes.latest}:`);
    const box = $('#upd-changes');
    if (!n) {
      box.replaceChildren(el('p', 'upd-empty', changes.error || 'No hay notas de cambios para estas versiones.'));
      return;
    }
    box.replaceChildren(...changes.versions.map((v) => {
      const section = el('section', 'upd-version');
      const head = el('h2', '', `v${v.version}`);
      if (v.date) head.append(el('span', 'upd-date', v.date));
      const list = el('ul');
      for (const item of v.items) {
        const li = el('li');
        appendInline(li, item);
        list.append(li);
      }
      if (!v.items.length) list.append(el('li', '', 'Sin notas.'));
      section.append(head, list);
      return section;
    }));
  }

  // Enseña los cambios de las versiones pendientes y espera la respuesta:
  // true con «Update»; false con «Cancel» o Esc (no se toca nada).
  function askToUpdate() {
    const dialog = $('#dlg-update');
    const ok = $('#upd-ok');
    const cancel = $('#upd-cancel');
    $('#upd-summary').textContent = `Tienes la versión ${updateInfo.current}; la última es la ${updateInfo.latest}.`;
    $('#upd-changes').replaceChildren(el('p', 'upd-empty', 'Cargando la lista de cambios…'));
    ok.disabled = true;
    dialog.showModal();
    cancel.focus();
    const fallback = { current: updateInfo.current, latest: updateInfo.latest, versions: [], error: 'No se ha podido descargar la lista de cambios.' };
    api.updateChanges().catch(() => fallback).then((changes) => {
      if (!dialog.open) return;
      fillChanges(changes || fallback);
      ok.disabled = false;
      ok.focus();
    });
    return new Promise((resolve) => {
      let done = false;
      const finish = (accepted) => {
        if (done) return;
        done = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onCancel);
        if (dialog.open) dialog.close();
        resolve(accepted);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('close', onCancel);
    });
  }

  async function clickUpdate() {
    if (!updateInfo || $('#dlg-update').open) return;
    if (updateInfo.status === 'ready') { api.updateRestart(); return; }
    if (updateInfo.status === 'working') return;
    const accepted = await askToUpdate();
    if (accepted) {
      renderUpdate(await api.updateStart());
      if (updateInfo.status === 'working') {
        toast(`Generando ClaudHome ${updateInfo.latest} en segundo plano. Puedes seguir trabajando; al terminar, ClaudHome se reiniciará para instalarla.`);
      }
    }
    focusTerminal();
  }

  // ── Micrófono para dictar ────────────────────────────────────────
  // El dictado lo hace Claude Code: mientras se mantiene pulsada la barra
  // espaciadora graba, y al soltarla escribe lo dictado en su cuadro. El botón
  // solo decide si la pulsación larga le llega (ver wireKeys).

  function renderVoice(state) {
    voiceOn = Boolean(state && state.enabled);
    const button = $('#mic-btn');
    button.hidden = false;
    button.setAttribute('aria-pressed', String(voiceOn));
    button.title = voiceOn
      ? 'Micrófono activado: mantén pulsada la barra espaciadora en la sesión para dictar; al soltarla deja de grabar. Pulsa para desactivarlo.'
      : 'Micrófono desactivado. Pulsa para activarlo y dictar manteniendo pulsada la barra espaciadora.';
  }

  async function toggleVoice() {
    renderVoice(await api.voiceSet(!voiceOn));
    toast(voiceOn
      ? 'Micrófono activado: mantén pulsada la barra espaciadora para dictar y suéltala para terminar.'
      : 'Micrófono desactivado: la barra espaciadora vuelve a escribir solo espacios.');
    focusTerminal();
  }

  // ── «Log»: lo que sale de este equipo ────────────────────────────
  // El proceso principal (netlog.js) apunta lo que ha visto Claude (se envía a
  // Anthropic) y lo que sale directamente hacia internet; aquí se muestra,
  // filtrado por pestaña, tipo o texto.

  const netlog = []; // entradas, de la más antigua a la más nueva
  const logFilter = { scope: 'tab', kind: '', text: '' };
  let logTimer = null;

  function netlogAdd(entry) {
    if (!entry || typeof entry.id !== 'number') return;
    const index = netlog.findIndex((e) => e.id === entry.id);
    if (index >= 0) netlog[index] = entry;
    else {
      netlog.push(entry);
      if (netlog.length > 3000) netlog.splice(0, netlog.length - 3000);
    }
    // Se repinta como mucho cuatro veces por segundo.
    if (logTimer) return;
    logTimer = setTimeout(() => {
      logTimer = null;
      renderToolbar();
      if ($('#dlg-log').open) renderLog();
    }, 250);
  }

  const logEntriesOf = (tabId) => netlog.filter((e) => e.tabId === tabId);
  const clock = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ¿Pasa el filtro de tipo? «Hacia internet» = sale directamente a internet;
  // «Archivos» incluye las búsquedas en archivos; «Webs y búsquedas», las de internet.
  function logKindMatches(entry, kind) {
    if (!kind) return true;
    if (kind === 'external') return entry.external;
    if (kind === 'archivo') return entry.kind === 'archivo' || entry.kind === 'grep';
    if (kind === 'web') return entry.kind === 'web' || entry.kind === 'busqueda';
    return entry.kind === kind;
  }

  const logSize = (bytes) => (!bytes ? '' : bytes < 1024 ? '< 1 KB' : `≈ ${formatSize(bytes)}`);

  function renderLog() {
    const tab = byId(S.activeId);
    const words = logFilter.text.trim().toLowerCase();
    const rows = netlog.filter((e) => (logFilter.scope === 'all' || (tab && e.tabId === tab.id))
      && logKindMatches(e, logFilter.kind)
      && (!words || `${e.tabName} ${e.what} ${e.target} ${e.detail} ${e.dest}`.toLowerCase().includes(words)));
    const shown = rows.slice(-1000).reverse(); // las más nuevas arriba
    $('#log-rows').replaceChildren(...shown.map((e) => {
      const tr = el('tr');
      tr.dataset.kind = e.kind;
      tr.classList.toggle('external', Boolean(e.external));
      const time = el('td', 'c-time', clock(e.time));
      if (e.count > 1) {
        time.append(el('span', 'log-times', ` ×${e.count}`));
        time.title = `${e.count} veces; la última a las ${clock(e.last)}`;
      }
      const kind = el('td', 'c-kind');
      kind.append(el('span', 'log-kind', e.what));
      const target = el('td', 'c-target', e.target);
      target.title = e.detail ? `${e.target}\n${e.detail}` : e.target;
      const dest = el('td', 'c-dest', e.dest);
      dest.title = e.external ? 'Sale directamente a internet y, además, Claude recibe el resultado' : 'Claude recibe el resultado y lo envía a Anthropic con la conversación';
      tr.append(time, el('td', 'c-tab', e.tabName), kind, target, dest, el('td', 'c-size', logSize(e.size)));
      return tr;
    }));
    const empty = $('#log-empty');
    empty.hidden = rows.length > 0;
    empty.textContent = netlog.length
      ? 'No hay nada que coincida con el filtro.'
      : 'Claude todavía no ha usado ninguna herramienta desde que se abrió ClaudHome.';
    const bytes = rows.reduce((sum, e) => sum + (e.size || 0), 0);
    $('#log-count').textContent = `${rows.length === 1 ? '1 entrada' : `${rows.length} entradas`}${bytes ? ` · ${logSize(bytes)} en total` : ''}`;
    $('#dlg-log-title').textContent = logFilter.scope === 'all' || !tab ? 'Lo que sale de este equipo' : `Lo que sale de este equipo · ${tab.name}`;
  }

  function openLog() {
    const dialog = $('#dlg-log');
    if (!byId(S.activeId)) logFilter.scope = 'all';
    for (const b of dialog.querySelectorAll('[data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === logFilter.scope));
    for (const b of dialog.querySelectorAll('[data-kind]')) b.setAttribute('aria-pressed', String(b.dataset.kind === logFilter.kind));
    $('#log-search').value = logFilter.text;
    renderLog();
    if (!dialog.open) dialog.showModal();
  }

  function wireLog() {
    const dialog = $('#dlg-log');
    $('#btn-log').addEventListener('click', openLog);
    $('#log-close').addEventListener('click', () => dialog.close());
    $('#log-file').addEventListener('click', () => api.netlogOpenFile());
    dialog.addEventListener('close', () => requestAnimationFrame(focusTerminal));
    dialog.addEventListener('click', (e) => {
      const scope = e.target.closest('[data-scope]');
      const kind = e.target.closest('[data-kind]');
      if (scope) {
        logFilter.scope = scope.dataset.scope;
        for (const b of dialog.querySelectorAll('[data-scope]')) b.setAttribute('aria-pressed', String(b === scope));
        renderLog();
      } else if (kind) {
        logFilter.kind = kind.dataset.kind;
        for (const b of dialog.querySelectorAll('[data-kind]')) b.setAttribute('aria-pressed', String(b === kind));
        renderLog();
      }
    });
    $('#log-search').addEventListener('input', (e) => { logFilter.text = e.target.value; renderLog(); });
    api.onNetlogEntry(netlogAdd);
    api.onNetlogUpdate(netlogAdd);
    api.netlogGet().then((list) => { for (const entry of list || []) netlogAdd(entry); }).catch(() => { /* sin registro */ });
  }

  // ── Arcoíris del nombre ──────────────────────────────────────────
  // Cada 3 minutos, o al pulsar sobre el nombre, un arcoíris suave lo recorre.
  // Con «reducir animaciones» activado en Windows no se muestra.

  const RAINBOW_EVERY = 3 * 60 * 1000;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function rainbow() {
    const name = $('#brand-name');
    if (reducedMotion.matches) return;
    name.classList.remove('rainbow');
    void name.offsetWidth; // vuelve a empezar si ya estaba pasando
    name.classList.add('rainbow');
  }

  function wireRainbow() {
    const name = $('#brand-name');
    name.addEventListener('click', rainbow);
    name.addEventListener('animationend', () => name.classList.remove('rainbow'));
    setInterval(rainbow, RAINBOW_EVERY);
  }

  // ── Registro de depuración ───────────────────────────────────────

  let debugInfo = null;

  function renderDebug(info) {
    if (info) debugInfo = info;
    const button = $('#sb-debug');
    if (!debugInfo) { button.hidden = true; return; }
    button.hidden = false;
    button.textContent = debugInfo.enabled ? 'Depuración: activada' : 'Depuración: desactivada';
    button.setAttribute('aria-pressed', String(debugInfo.enabled));
    button.title = debugInfo.enabled
      ? `Cada sesión de Claude guarda un registro detallado en ${debugInfo.dir} (se borran solos a la semana). Pulsa para desactivarlo. Los registros se abren con el botón derecho sobre una pestaña.`
      : 'Las sesiones no guardan registro de depuración. Pulsa para activarlo.';
  }

  async function toggleDebug() {
    if (!debugInfo) return;
    renderDebug(await api.debugSet(!debugInfo.enabled));
    toast(debugInfo.enabled
      ? 'Depuración activada: las sesiones que abras o reinicies a partir de ahora guardan su registro.'
      : 'Depuración desactivada. Las sesiones ya abiertas siguen registrando hasta que se reinicien.');
  }

  function needsYou(view, body) {
    if (view.closing) return;
    const was = view.status;
    setStatus(view, 'needs');
    if (was !== 'needs' && !isWatched(view)) {
      api.notify({ tabId: view.tab.id, title: `${view.tab.name} te necesita`, body });
    }
  }

  function finished(view, failed) {
    if (view.closing) return;
    const was = view.status;
    if (failed) {
      // Un error (fallo de la API, límite de uso…) queda en ámbar hasta tu siguiente
      // mensaje, aunque estés viendo la pestaña.
      setStatus(view, 'failed');
      if (was !== 'failed' && !isWatched(view)) {
        api.notify({ tabId: view.tab.id, title: `${view.tab.name} se ha detenido`, body: 'Claude no ha podido completar la respuesta por un error.' });
      }
      return;
    }
    if (isWatched(view)) { setStatus(view, 'idle'); return; }
    setStatus(view, 'done');
    if (was === 'done') return;
    api.notify({ tabId: view.tab.id, title: `${view.tab.name} ha terminado`, body: 'Claude ha terminado y espera tu siguiente mensaje.' });
  }

  // Lo que ya estás viendo deja de marcarse como pendiente.
  function acknowledge() {
    if (!winFocused) return;
    for (const id of visibleIds()) {
      const view = views.get(id);
      if (view && view.status === 'done') setStatus(view, 'idle');
    }
  }

  function onHook(tabId, ev) {
    const view = views.get(tabId);
    if (!view || !view.started || !ev) return;
    if (ev.background && !view.keepAwake) {
      view.keepAwake = true; // ha dejado algo en marcha: esta sesión no se duerme
      api.log(`«${view.tab.name}» deja ${ev.toolName} en marcha: no se dormirá`);
    }
    // /clear abre una conversación con otro identificador: la pestaña lo sigue.
    if (ev.sessionId && (ev.event === 'UserPromptSubmit' || ev.event === 'Stop') && ev.sessionId !== view.tab.sessionId) {
      view.tab.sessionId = ev.sessionId;
      save();
    }
    if (view.closing) {
      // Durante el cierre ordenado solo interesa saber si la petición ha entrado
      // y cuándo termina Claude de responderla.
      if (ev.event === 'UserPromptSubmit' && view.closing.sent) view.closing.submitted = true;
      else if ((ev.event === 'Stop' || ev.event === 'StopFailure') && view.closing.submitted) view.closing.finish('saved');
      return;
    }
    switch (ev.event) {
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        setStatus(view, 'working');
        break;
      case 'PermissionRequest':
        needsYou(view, ev.toolName ? `Claude pide permiso para usar ${ev.toolName}.` : 'Claude pide permiso para continuar.');
        break;
      case 'Notification':
        if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(ev.notificationType)) {
          needsYou(view, ev.notificationType === 'permission_prompt' ? 'Claude pide permiso para continuar.' : 'Claude necesita tu respuesta.');
        }
        break;
      case 'Stop':
        finished(view, false);
        break;
      case 'StopFailure':
        finished(view, true);
        break;
      default:
        break;
    }
  }

  function onPtyExit(id, code) {
    if (id.endsWith(':sh')) {
      const view = views.get(id.slice(0, -3));
      const extra = view && view.extra;
      if (!extra) return;
      extra.started = false;
      extra.exited = true;
      extra.term.write('\r\n\x1b[2m[La terminal se ha cerrado. Pulsa Intro para abrirla de nuevo.]\x1b[0m\r\n');
      return;
    }
    const view = views.get(id);
    if (!view) return;
    view.started = false;
    view.exited = true;
    if (view.onExit) { const notify = view.onExit; view.onExit = null; notify(); }
    if (view.closing) view.closing.finish('forced'); // ha salido antes de terminar: no hay nada que esperar
    if (view.expectExit) return; // salida pedida por la app al cerrar
    // Si falla nada más intentar retomar, esa conversación ya no existe.
    const failedResume = view.resumed && code !== 0 && Date.now() - view.startedAt < 8000;
    view.mode = failedResume ? 'new' : 'resume';
    setStatus(view, 'exited');
    const text = failedResume
      ? 'No se ha podido retomar la conversación. Pulsa Intro para empezar una nueva.'
      : 'La sesión de Claude se ha cerrado. Pulsa Intro para retomarla.';
    view.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
  }

  // ── Pintado ──────────────────────────────────────────────────────

  function tabElement(tab, shown) {
    const view = views.get(tab.id);
    const st = STATUS[view ? view.status : 'asleep'];
    const node = el('div', 'tab');
    node.dataset.id = tab.id;
    const hex = colorHex(tab.color);
    if (hex) node.style.setProperty('--c', hex);
    node.classList.toggle('shown', shown);
    node.classList.toggle('attn', Boolean(st.tone));

    const main = el('button', 'tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(tab.id === S.activeId));
    const usage = view && view.usage && view.usage.pct !== null ? view.usage : null;
    main.setAttribute('aria-label', `${tab.name}, ${st.label.toLowerCase()}${usage ? `, conversación al ${usage.pct} %` : ''}`);
    main.title = `${tab.name} · ${st.label}\n${tab.cwd}${usage ? `\n${usageText(usage)}` : ''}`;
    main.innerHTML = SVG[st.icon];
    // Los puntos de «te necesita» y «ha terminado» parpadean. La fase sale del reloj
    // para que no vuelva a empezar cada vez que se repintan las pestañas.
    const attnDot = main.querySelector('.dot-attn');
    if (attnDot) attnDot.style.animationDelay = `-${Date.now() % 1200}ms`;
    main.append(el('span', 'tab-name', tab.name));

    const close = el('button', 'tab-close');
    close.setAttribute('aria-label', `Cerrar la pestaña ${tab.name}`);
    close.title = 'Cerrar pestaña (Ctrl+Mayús+W)';
    close.innerHTML = SVG.close;

    node.append(main, close);
    // Barrita de llenado de la conversación, en la parte de abajo de la pestaña.
    if (usage) {
      const bar = el('span', 'tab-usage');
      bar.dataset.level = usageLevel(usage.pct);
      const fill = el('i');
      fill.style.width = `${clamp(usage.pct, 0, 100)}%`;
      bar.append(fill);
      node.append(bar);
    }
    return node;
  }

  // Cuánto ocupa la conversación: «bajo» hasta el 60 %, «medio» hasta el 85 %, «alto» después.
  const usageLevel = (pct) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low');
  const nf = new Intl.NumberFormat('es-ES');

  function usageText(usage) {
    const tokens = usage.used !== null ? ` (${nf.format(usage.used)} de ${nf.format(usage.size)} tokens)` : '';
    return `Conversación: ${usage.pct} % del contexto${tokens}`;
  }

  // ── Límites de uso del plan y tokens (barra inferior) ──
  // El límite semanal con su porcentaje, los tokens usados en la semana y cuándo se
  // renueva; si el plan tiene además límite de 5 horas, se añade su porcentaje. El
  // detalle, al pasar el ratón. Los tokens de la conversación van junto a su llenado.
  let limitsSnap = { plan: null, conversations: {} }; // de limits.js

  function tokensShort(n) {
    if (n < 1000) return `${n} tokens`;
    if (n < 1e6) return `${Math.round(n / 1000)} mil tokens`;
    return `${(n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: n < 1e7 ? 1 : 0 })} M tokens`;
  }

  const tokensBreakdown = (t) => `entrada ${nf.format(t.input)} · salida ${nf.format(t.output)} · caché escrita ${nf.format(t.cacheWrite)} · caché leída ${nf.format(t.cacheRead)}`;

  // «hoy a las 18:40», «mañana a las 01:10», «el lunes 24 a las 09:00»…
  function whenText(ms) {
    const d = new Date(ms);
    const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    const shifted = (days) => { const x = new Date(); x.setDate(x.getDate() + days); return day(x); };
    const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    if (day(d) === shifted(0)) return `hoy a las ${hm}`;
    if (day(d) === shifted(1)) return `mañana a las ${hm}`;
    if (day(d) === shifted(-1)) return `ayer a las ${hm}`;
    return `el ${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' })} a las ${hm}`;
  }

  function limitDetail(name, w) {
    const t = w.tokens;
    const head = w.expired
      ? `${name}: se renovó ${whenText(w.resetsAt)}. El porcentaje nuevo llega con tu próximo mensaje.`
      : `${name}: ${w.pct} % usado · se renueva ${whenText(w.resetsAt)}.`;
    return `${head}\n   Tokens usados ${w.expired ? 'desde la renovación' : 'en este periodo'}: ${nf.format(t.total)}${t.total ? ` (${tokensBreakdown(t)})` : ''}.`;
  }

  function renderPlanLimits() {
    const plan = limitsSnap.plan;
    const box = $('#sb-plan');
    const main = plan && (plan.seven_day || plan.five_hour);
    box.hidden = !main;
    if (!main) return;
    const label = plan.seven_day ? 'Semana' : 'Límite 5 h';
    const five = plan.seven_day && plan.five_hour && !plan.five_hour.expired ? plan.five_hour : null;
    const pct = main.expired ? 0 : main.pct;
    let level = usageLevel(pct);
    if (five && usageLevel(five.pct) === 'high') level = 'high';
    else if (five && usageLevel(five.pct) === 'mid' && level === 'low') level = 'mid';
    box.dataset.level = level;
    $('#sb-plan-fill').style.width = `${clamp(pct, 0, 100)}%`;
    $('#sb-plan-text').textContent = main.expired
      ? `${label}: renovada ${whenText(main.resetsAt)} · ${tokensShort(main.tokens.total)} desde entonces`
      : `${label} ${main.pct} % · ${tokensShort(main.tokens.total)} · se renueva ${whenText(main.resetsAt)}`
        + (five ? ` · 5 h ${five.pct} %` : '');
    const parts = [];
    if (plan.seven_day) parts.push(limitDetail('Límite semanal', plan.seven_day));
    if (plan.five_hour) parts.push(limitDetail('Límite de 5 horas', plan.five_hour));
    box.title = `${parts.join('\n')}\n\nEl porcentaje es el de tu cuenta: incluye lo usado en claude.ai y en otros equipos. `
      + 'Los tokens son los de Claude Code en este equipo. La «caché leída» es texto que Claude ya tenía y vuelve a leer: es mucho más barato que el resto.';
  }

  function renderTabs() {
    if (renamingId || draggingId) { tabsDirty = true; return; }
    tabsDirty = false;
    const shown = new Set(visibleIds());
    const strip = $('#tabs');
    strip.replaceChildren(...S.tabs.map((tab) => tabElement(tab, shown.has(tab.id))));
    const active = S.activeId && strip.querySelector(`.tab[data-id="${S.activeId}"]`);
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderToolbar() {
    const tab = byId(S.activeId);
    $('#toolbar').hidden = !tab;
    document.title = tab ? `${tab.name} · ClaudHome` : 'ClaudHome'; // lo que se ve en la barra de tareas
    if (!tab) return;
    applySwatch($('#tb-swatch'), tab.color);
    $('#tb-name').textContent = tab.name;
    $('#tb-path').textContent = tab.cwd;
    $('#tb-path').title = tab.cwd;
    $('#btn-terminal').setAttribute('aria-pressed', String(Boolean(tab.extraOpen)));
    $('#btn-context').setAttribute('aria-pressed', String(Boolean(tab.contextOpen)));
    const logCount = logEntriesOf(tab.id).length;
    $('#log-badge').hidden = logCount === 0;
    $('#log-badge').textContent = logCount > 999 ? '999+' : String(logCount);
    const ctxCount = contextCount(tab);
    $('#ctx-count').hidden = ctxCount === 0;
    $('#ctx-count').textContent = String(ctxCount);
    const ctxView = views.get(tab.id);
    if (ctxView && ctxView.ctxSub) ctxView.ctxSub.textContent = `Claude lo tiene presente en cada sesión de «${tab.name}»`;
    const activeView = views.get(tab.id);
    $('#tb-codex').hidden = !(activeView && activeView.codex && activeView.started && codexInfo && codexInfo.active);
    $('#btn-swap').hidden = !S.split;
    $('#btn-split-label').textContent = S.split ? 'Cerrar división' : 'Dividir';
    $('#split-line').style.display = S.split ? 'none' : '';
  }

  function renderHeads() {
    for (const side of SIDES) {
      const pane = panes[side];
      const view = S.split ? views.get(S.split[side]) : null;
      pane.el.classList.toggle('focused', Boolean(S.split) && S.focusSide === side);
      if (!view) { pane.head.replaceChildren(); continue; }
      const st = STATUS[view.status];
      const status = el('span', 'ph-status');
      if (st.tone) status.dataset.tone = st.tone;
      status.innerHTML = SVG[st.icon];
      status.append(st.label);
      pane.head.replaceChildren(
        swatch(view.tab.color),
        el('span', 'ph-name', view.tab.name),
        el('span', 'ph-path', view.tab.cwd),
        status,
      );
    }
  }

  function renderStatusbar() {
    let working = 0;
    let waiting = 0;
    let attn = 0;
    let done = 0;
    let failed = 0;
    let sleeping = 0;
    for (const view of views.values()) {
      if (view.status === 'working' || view.status === 'closing') working += 1;
      if (view.status === 'needs') { waiting += 1; attn += 1; }
      if (view.status === 'done') done += 1;
      if (view.status === 'failed') failed += 1;
      if (view.status === 'sleeping') sleeping += 1;
    }
    const n = S.tabs.length;
    $('#sb-count').textContent = n === 0 ? 'Sin sesiones abiertas' : n === 1 ? '1 sesión abierta' : `${n} sesiones abiertas`;

    const workingEl = $('#sb-working');
    workingEl.hidden = working === 0;
    workingEl.innerHTML = SVG.working;
    workingEl.append(`${working} trabajando`);

    const attnEl = $('#sb-attn');
    attnEl.hidden = attn === 0;
    attnEl.innerHTML = SVG.attn;
    attnEl.append(attn === 1 ? '1 te necesita' : `${attn} te necesitan`);

    const doneEl = $('#sb-done');
    doneEl.hidden = done === 0;
    doneEl.innerHTML = SVG.done;
    doneEl.append(done === 1 ? '1 ha terminado' : `${done} han terminado`);

    const failedEl = $('#sb-failed');
    failedEl.hidden = failed === 0;
    failedEl.innerHTML = SVG.failed;
    failedEl.append(failed === 1 ? '1 con error' : `${failed} con error`);

    const sleepingEl = $('#sb-sleeping');
    sleepingEl.hidden = sleeping === 0;
    sleepingEl.innerHTML = SVG.off;
    sleepingEl.append(sleeping === 1 ? '1 dormida' : `${sleeping} dormidas`);
    sleepingEl.title = `Sesiones que llevaban ${Math.round(sleepAfterMs / 60000)} min esperando sin que las miraras: se han cerrado para liberar memoria y se retoman solas al abrir su pestaña.`;

    const tab = byId(S.activeId);
    const zoom = $('#sb-zoom');
    zoom.hidden = !tab;
    if (tab) zoom.textContent = `${Math.round((tab.zoom || 1) * 100)} %`;

    renderPlanLimits();

    // Conversación de la pestaña activa: cuánto ocupa de su contexto y los tokens que lleva usados.
    const activeView = tab && views.get(tab.id);
    const usage = activeView && activeView.usage && activeView.usage.pct !== null ? activeView.usage : null;
    const spent = tab && limitsSnap.conversations[tab.id];
    const usageEl = $('#sb-usage');
    usageEl.hidden = !usage && !spent;
    if (usage || spent) {
      usageEl.dataset.level = usage ? usageLevel(usage.pct) : 'low';
      usageEl.querySelector('.sb-meter').hidden = !usage;
      $('#sb-usage-fill').style.width = `${usage ? clamp(usage.pct, 0, 100) : 0}%`;
      $('#sb-usage-text').textContent = `Conversación${usage ? ` ${usage.pct} %` : ''}${spent ? ` · ${tokensShort(spent.total)}` : ''}`;
      const lines = [];
      if (usage) lines.push(`${usageText(usage)}.`);
      if (spent) lines.push(`Tokens usados en esta conversación: ${nf.format(spent.total)} (${tokensBreakdown(spent)}). Incluye los de sus subagentes.`);
      if (usage) lines.push('Cuanto más llena, peor rinde Claude y más gasta: /compact la resume y sigue, /clear empieza de cero.');
      usageEl.title = lines.join('\n');
    }
    $('#sb-hint').textContent = S.split
      ? 'Ctrl+Alt+flechas cambia de lado · Ctrl+Tab cambia de pestaña'
      : 'Ctrl+Tab cambia de pestaña · Ctrl+1…9 va directa';

    // El proceso principal lo usa para avisar antes de cerrar con trabajo en curso.
    const busy = working + waiting;
    if (busy !== lastBusy) {
      lastBusy = busy;
      api.setSummary({ working: busy });
    }
  }

  function renderAll() {
    renderTabs();
    renderToolbar();
    renderHeads();
    renderStatusbar();
  }

  // Coloca cada vista en su lado y actualiza todo lo demás.
  function layout() {
    hidePreview();
    if (S.split && (!byId(S.split.left) || !byId(S.split.right) || S.split.left === S.split.right)) S.split = null;
    if (!byId(S.activeId)) S.activeId = S.tabs[0] ? S.tabs[0].id : null;
    if (S.split) S.activeId = S.split[S.focusSide];

    const workspace = $('#workspace');
    workspace.classList.toggle('split', Boolean(S.split));
    if (S.split) workspace.style.setProperty('--ratio', String(S.split.ratio || 0.5));
    $('#empty').hidden = S.tabs.length > 0;
    $('#divider').hidden = !S.split;

    const assigned = S.split ? { left: S.split.left, right: S.split.right } : { left: S.activeId, right: null };
    for (const side of SIDES) {
      const pane = panes[side];
      const view = assigned[side] ? views.get(assigned[side]) : null;
      pane.el.hidden = !view;
      if (!view) pane.body.replaceChildren();
      else if (view.el.parentNode !== pane.body) pane.body.replaceChildren(view.el);
    }

    renderAll();
    requestAnimationFrame(() => {
      for (const id of visibleIds()) {
        const view = views.get(id);
        if (view) showView(view);
      }
      acknowledge();
      focusTerminal();
    });
  }

  // ── Acciones sobre pestañas ──────────────────────────────────────

  function activate(id, side) {
    if (!byId(id)) return;
    if (S.split) {
      const target = side || S.focusSide;
      const other = target === 'left' ? 'right' : 'left';
      if (!side && S.split[other] === id) {
        S.focusSide = other; // ya está a la vista en el otro lado: solo cambia el foco
      } else {
        if (S.split[other] === id) S.split[other] = S.split[target];
        S.split[target] = id;
        S.focusSide = target;
      }
    }
    S.activeId = id;
    touchMru(id);
    layout();
    save();
  }

  function cycle(direction) {
    if (S.tabs.length < 2) return;
    const index = S.tabs.findIndex((t) => t.id === S.activeId);
    const next = S.tabs[(index + direction + S.tabs.length) % S.tabs.length];
    activate(next.id);
  }

  function addTab(fields, mode) {
    const tab = {
      id: newId(),
      name: fields.name,
      cwd: fields.cwd,
      color: fields.color || '',
      shell: fields.shell || 'powershell',
      sessionId: fields.sessionId || null,
      zoom: fields.zoom || 1,
      extraOpen: false,
      extraHeight: fields.extraHeight || 0,
      context: cleanContext(fields.context),
      contextOpen: false,
    };
    S.tabs.push(tab);
    createView(tab, mode);
    activate(tab.id);
    return tab;
  }

  function addRecent(tab) {
    const same = (r) => r.cwd.toLowerCase() === tab.cwd.toLowerCase() && r.name === tab.name;
    S.recents = [
      { name: tab.name, cwd: tab.cwd, color: tab.color, shell: tab.shell, sessionId: tab.sessionId, zoom: tab.zoom, extraHeight: tab.extraHeight, context: tab.context },
      ...S.recents.filter((r) => !same(r)),
    ].slice(0, MAX_RECENTS);
  }

  async function closeTab(id) {
    const tab = byId(id);
    const view = views.get(id);
    if (!tab || !view) return;
    if (view.closing) {
      // Segundo intento mientras guarda su estado: se ofrece no esperar.
      const now = await api.confirm({
        message: `«${tab.name}» está guardando su estado`,
        detail: 'Claude está dejando anotado por dónde iba. Puedes cerrar ya, sin esperar a que termine.',
        confirmLabel: 'Cerrar ya',
      });
      if (now && view.closing) view.closing.finish('forced');
      return;
    }
    if (view.status === 'working' || view.status === 'needs') {
      const choice = await api.choose({
        message: `Claude está trabajando en «${tab.name}»`,
        detail: '«Guardar estado y cerrar» pide a Claude que pare y deje anotado por dónde iba, para retomarlo al reabrir la sesión desde Recientes. '
          + '«Cerrar ya» interrumpe el trabajo en el punto en que esté; la conversación queda guardada igualmente.',
        buttons: ['Guardar estado y cerrar', 'Cerrar ya', 'Cancelar'],
      });
      if (choice === 2 || !views.has(id)) return;
      if (choice === 0) {
        const result = await wrapUp(view);
        if (result === 'saved' && views.has(id)) await gracefulExit(view);
        if (!views.has(id)) return;
      }
    }
    removeTab(id);
  }

  function removeTab(id) {
    const tab = byId(id);
    const view = views.get(id);
    if (!tab || !view) return;

    views.delete(id);
    terms.delete(id);
    terms.delete(`${id}:sh`);
    api.ptyKill(id);
    api.ptyKill(`${id}:sh`);
    view.el.remove();
    view.term.dispose();
    if (view.extra) view.extra.term.dispose();

    addRecent(tab);
    const index = S.tabs.indexOf(tab);
    S.tabs.splice(index, 1);
    mru = mru.filter((x) => x !== id);
    if (S.split && (S.split.left === id || S.split.right === id)) {
      S.activeId = S.split.left === id ? S.split.right : S.split.left;
      S.split = null;
    } else if (S.activeId === id) {
      const fallback = S.tabs[Math.min(index, S.tabs.length - 1)];
      S.activeId = mru.find((x) => byId(x)) || (fallback ? fallback.id : null);
    }
    layout();
    save();
  }

  async function newConversation(id = S.activeId) {
    const view = views.get(id);
    if (!view) return;
    const ok = await api.confirm({
      message: `¿Empezar una conversación nueva en «${view.tab.name}»?`,
      detail: 'La conversación actual queda guardada: puedes volver a ella con /resume dentro de Claude.',
      confirmLabel: 'Empezar nueva',
    });
    if (!ok || !views.has(id)) return;
    view.started = false;
    view.exited = false;
    await api.ptyKill(id);
    if (!views.has(id)) return;
    view.term.reset();
    view.mode = 'new';
    view.tab.sessionId = null;
    save();
    if (visibleIds().includes(id) && view.opened) startClaude(view);
    else setStatus(view, 'asleep');
  }

  function startRename(id) {
    const tab = byId(id);
    const node = tab && $(`#tabs .tab[data-id="${id}"]`);
    if (!node || renamingId) return;
    const input = el('input', 'tab-edit');
    input.type = 'text';
    input.value = tab.name;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Nombre de la pestaña');
    renamingId = id;
    $('.tab-main', node).replaceWith(input);
    input.style.margin = '0 0 0 10px';
    input.style.alignSelf = 'center';
    input.focus();
    input.select();

    let finishedEditing = false;
    const finish = (commit) => {
      if (finishedEditing) return;
      finishedEditing = true;
      const value = input.value.trim();
      if (commit && value) tab.name = value;
      renamingId = null;
      renderAll();
      save();
      focusTerminal();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function tabMenu(id) {
    const tab = byId(id);
    if (!tab) return;
    const action = await api.tabMenu({ id, color: tab.color || '', colors: COLORS.map(({ key, name }) => ({ key, name })) });
    if (!action || !byId(id)) return;
    if (action === 'log') api.openLog(id);
    else if (action === 'logs') api.openLog(null);
    else if (action === 'rename') startRename(id);
    else if (action === 'newconv') newConversation(id);
    else if (action === 'folder') api.openPath(tab.cwd);
    else if (action === 'close') closeTab(id);
    else if (action.startsWith('color:')) {
      tab.color = action.slice('color:'.length);
      renderAll();
      save();
    }
  }

  function moveTab(id, targetId, before) {
    const from = S.tabs.findIndex((t) => t.id === id);
    if (from < 0 || id === targetId) return;
    const [tab] = S.tabs.splice(from, 1);
    let to = S.tabs.findIndex((t) => t.id === targetId);
    if (to < 0) { S.tabs.splice(from, 0, tab); return; }
    if (!before) to += 1;
    S.tabs.splice(to, 0, tab);
    save();
  }

  // ── Vista dividida ───────────────────────────────────────────────

  function toggleSplit() {
    if (S.split) {
      S.activeId = S.split[S.focusSide];
      S.split = null;
    } else {
      if (S.tabs.length < 2) { toast('Abre otra sesión para poder ver dos a la vez.'); return; }
      const other = mru.find((x) => x !== S.activeId && byId(x)) || S.tabs.find((t) => t.id !== S.activeId).id;
      S.split = { left: S.activeId, right: other, ratio: 0.5 };
      S.focusSide = 'left';
    }
    layout();
    save();
  }

  function swapSides() {
    if (!S.split) return;
    [S.split.left, S.split.right] = [S.split.right, S.split.left];
    S.focusSide = S.focusSide === 'left' ? 'right' : 'left';
    layout();
    save();
  }

  function focusSide(side, focus = true) {
    if (!S.split || S.focusSide === side) return;
    S.focusSide = side;
    S.activeId = S.split[side];
    touchMru(S.activeId);
    renderAll();
    acknowledge();
    if (focus) focusTerminal();
    save();
  }

  // Soltar una pestaña sobre la zona de trabajo la coloca en ese lado.
  function dropOnWorkspace(id, clientX) {
    const box = $('#workspace').getBoundingClientRect();
    let side = clientX < box.left + box.width / 2 ? 'left' : 'right';
    if (S.split) {
      const edge = box.left + box.width * (S.split.ratio || 0.5);
      side = clientX < edge ? 'left' : 'right';
      activate(id, side);
      return;
    }
    // Sin división todavía: la pestaña soltada va a ese lado y al otro, la que
    // estaba a la vista (o la última usada, si se arrastra la propia pestaña activa).
    const fallback = S.tabs.find((t) => t.id !== id);
    const otherId = id === S.activeId ? (mru.find((x) => x !== id && byId(x)) || (fallback && fallback.id)) : S.activeId;
    if (!otherId) { activate(id); return; }
    S.split = side === 'left'
      ? { left: id, right: otherId, ratio: 0.5 }
      : { left: otherId, right: id, ratio: 0.5 };
    S.focusSide = side;
    touchMru(id);
    layout();
    save();
  }

  // ── Botón «+», recientes y diálogo de nueva sesión ───────────────

  function renderRecents() {
    const list = $('#recents');
    list.replaceChildren(...S.recents.map((recent, index) => {
      const row = el('div', 'recent');
      const open = el('button', 'recent-open');
      open.dataset.index = String(index);
      const text = el('span', 'recent-text');
      text.append(el('span', 'recent-name', recent.name), el('span', 'recent-path', recent.cwd));
      open.append(swatch(recent.color), text);
      const forget = el('button', 'recent-forget');
      forget.dataset.forget = String(index);
      forget.setAttribute('aria-label', `Quitar ${recent.name} de recientes`);
      forget.title = 'Quitar de recientes';
      forget.innerHTML = SVG.close;
      row.append(open, forget);
      return row;
    }));
    $('#recents-note').textContent = S.recents.length
      ? 'Se reabren con su nombre y continúan su conversación.'
      : 'Aquí aparecerán las sesiones que cierres.';
  }

  function openPlusMenu() {
    const menu = $('#plus-menu');
    renderRecents();
    menu.classList.remove('flip');
    menu.hidden = false;
    menu.classList.toggle('flip', menu.getBoundingClientRect().right > window.innerWidth - 8);
    $('#btn-plus').setAttribute('aria-expanded', 'true');
    $('#plus-new').focus();
  }

  function closePlusMenu() {
    const menu = $('#plus-menu');
    if (menu.hidden) return;
    menu.hidden = true;
    $('#btn-plus').setAttribute('aria-expanded', 'false');
  }

  function reopenRecent(index) {
    const recent = S.recents[index];
    if (!recent) return;
    S.recents.splice(index, 1);
    closePlusMenu();
    addTab(recent, 'resume');
  }

  const baseName = (folder) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
  const cleanFolder = (value) => value.trim().replace(/^"(.*)"$/, '$1').trim();
  let nameTouched = false;

  function openNewDialog() {
    closePlusMenu();
    const dialog = $('#dlg-new');
    if (dialog.open) return;
    $('#f-folder').value = '';
    $('#f-name').value = '';
    $('#f-error').hidden = true;
    nameTouched = false;
    $('#f-colors input[value=""]').checked = true;
    $('#form-new input[name="mode"][value="continue"]').checked = true;
    $('#f-shell').value = info.shells.some((s) => s.key === S.lastShell) ? S.lastShell : 'powershell';
    dialog.showModal();
    $('#f-folder').focus();
  }

  function suggestName() {
    if (nameTouched) return;
    const folder = cleanFolder($('#f-folder').value);
    $('#f-name').value = folder ? baseName(folder) : '';
  }

  async function submitNew(event) {
    event.preventDefault();
    const folder = cleanFolder($('#f-folder').value);
    const error = $('#f-error');
    const fail = (text) => {
      error.textContent = text;
      error.hidden = false;
      $('#f-folder').focus();
    };
    if (!folder) { fail('Elige la carpeta donde trabajará Claude.'); return; }
    if (!(await api.isDir(folder))) { fail('Esa carpeta no existe. Revisa la ruta o usa «Examinar…».'); return; }
    const form = $('#form-new');
    const fields = {
      cwd: folder.replace(/[\\/]+$/, '') || folder,
      name: $('#f-name').value.trim() || baseName(folder),
      color: form.querySelector('input[name="color"]:checked').value,
      shell: $('#f-shell').value,
    };
    if (/^[a-zA-Z]:$/.test(fields.cwd)) fields.cwd += '\\'; // raíz de una unidad
    const mode = form.querySelector('input[name="mode"]:checked').value;
    S.lastShell = fields.shell;
    $('#dlg-new').close();
    addTab(fields, mode);
  }

  // ── Eventos ──────────────────────────────────────────────────────

  function wireTabs() {
    const strip = $('#tabs');
    const tabOf = (event) => event.target.closest('.tab');

    strip.addEventListener('click', (e) => {
      const node = tabOf(e);
      if (!node) return;
      if (e.target.closest('.tab-close')) closeTab(node.dataset.id);
      // Con el ratón, la pestaña se activa al soltar el botón (ver más abajo);
      // aquí solo llega la activación por teclado (Intro o Espacio).
      else if (e.detail === 0 && e.target.closest('.tab-main')) activate(node.dataset.id);
    });
    strip.addEventListener('dblclick', (e) => {
      const node = tabOf(e);
      if (node && e.target.closest('.tab-main')) startRename(node.dataset.id);
    });
    strip.addEventListener('auxclick', (e) => {
      const node = tabOf(e);
      if (node && e.button === 1) { e.preventDefault(); closeTab(node.dataset.id); }
    });
    strip.addEventListener('contextmenu', (e) => {
      const node = tabOf(e);
      if (!node) return;
      e.preventDefault();
      tabMenu(node.dataset.id);
    });
    // La rueda del ratón desplaza la fila cuando no caben todas.
    strip.addEventListener('wheel', (e) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: true });

    // Arrastre con el ratón. Dentro de la fila reordena las pestañas; soltada sobre
    // la zona de trabajo, la pestaña se coloca en ese lado (dividiendo si hace falta).
    const workspace = $('#workspace');
    const hint = $('#drop-hint');
    let drag = null;

    const clearMarks = () => {
      strip.querySelectorAll('.drop-before, .drop-after, .dragged').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragged'));
      hint.hidden = true;
    };

    const onMove = (e) => {
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; // aún es un clic
        drag.active = true;
        draggingId = drag.id;
        document.body.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
      }
      clearMarks();
      drag.drop = null;
      const own = strip.querySelector(`.tab[data-id="${drag.id}"]`);
      if (own) own.classList.add('dragged');

      const area = workspace.getBoundingClientRect();
      if (e.clientY < area.top) {
        // Sobre la fila: se marca el hueco donde caería.
        const others = [...strip.querySelectorAll('.tab')].filter((n) => n.dataset.id !== drag.id);
        if (!others.length) return;
        let target = others[others.length - 1];
        let before = false;
        for (const node of others) {
          const box = node.getBoundingClientRect();
          if (e.clientX < box.left + box.width / 2) { target = node; before = true; break; }
        }
        target.classList.add(before ? 'drop-before' : 'drop-after');
        drag.drop = { kind: 'reorder', targetId: target.dataset.id, before };
      } else if (e.clientY < area.bottom && e.clientX >= area.left && e.clientX <= area.right && S.tabs.length > 1) {
        // Sobre la zona de trabajo: se sombrea el lado donde quedaría.
        const ratio = S.split ? (S.split.ratio || 0.5) : 0.5;
        const left = e.clientX < area.left + area.width * ratio;
        hint.style.left = left ? '0' : `${ratio * 100}%`;
        hint.style.width = `${(left ? ratio : 1 - ratio) * 100}%`;
        hint.hidden = false;
        drag.drop = { kind: 'pane', x: e.clientX };
      }
    };

    const onUp = (e) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      const done = drag;
      drag = null;
      if (!done) return;
      if (!done.active) {
        // No se ha movido: es un clic sobre la pestaña.
        if (e.target instanceof Element && e.target.closest('#tabs')) activate(done.id);
        return;
      }
      clearMarks();
      draggingId = null;
      document.body.classList.remove('dragging');
      document.body.style.cursor = '';
      if (done.drop && done.drop.kind === 'pane') { dropOnWorkspace(done.id, done.drop.x); return; }
      if (done.drop && done.drop.kind === 'reorder') moveTab(done.id, done.drop.targetId, done.drop.before);
      renderTabs();
    };

    strip.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || renamingId) return;
      const node = tabOf(e);
      if (!node || e.target.closest('.tab-close')) return;
      drag = { id: node.dataset.id, x: e.clientX, y: e.clientY, active: false, drop: null };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
  }

  function wireChrome() {
    for (const side of SIDES) {
      const node = $(`.pane[data-side="${side}"]`);
      panes[side] = { el: node, head: $('.pane-head', node), body: $('.pane-body', node) };
      // Al pulsar en el panel de contexto, el foco se queda allí (no salta a la terminal).
      node.addEventListener('mousedown', (e) => focusSide(side, !(e.target instanceof Element && e.target.closest('.ctx'))), true);
    }

    $('#btn-plus').addEventListener('click', () => ($('#plus-menu').hidden ? openPlusMenu() : closePlusMenu()));
    $('#plus-new').addEventListener('click', openNewDialog);
    $('#empty-new').addEventListener('click', openNewDialog);
    $('#recents').addEventListener('click', (e) => {
      const forget = e.target.closest('[data-forget]');
      const open = e.target.closest('[data-index]');
      if (forget) {
        S.recents.splice(Number(forget.dataset.forget), 1);
        renderRecents();
        save();
      } else if (open) reopenRecent(Number(open.dataset.index));
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.plus-wrap')) closePlusMenu();
    }, true);

    $('#btn-terminal').addEventListener('click', () => toggleExtra());
    $('#btn-context').addEventListener('click', () => toggleContext());
    $('#btn-split').addEventListener('click', toggleSplit);
    $('#btn-swap').addEventListener('click', swapSides);
    $('#btn-folder').addEventListener('click', () => { const tab = byId(S.activeId); if (tab) api.openPath(tab.cwd); });
    $('#tb-name').addEventListener('dblclick', () => startRename(S.activeId));
    $('#sb-zoom').addEventListener('click', () => { const view = views.get(S.activeId); if (view) setZoom(view, 1); focusTerminal(); });

    $('#divider').addEventListener('mousedown', (e) => {
      $('#divider').classList.add('dragging');
      startDrag(e, 'col-resize', (ev) => {
        if (!S.split) return;
        const box = $('#workspace').getBoundingClientRect();
        S.split.ratio = clamp((ev.clientX - box.left) / box.width, 0.2, 0.8);
        $('#workspace').style.setProperty('--ratio', String(S.split.ratio));
        queueFit();
      }, () => { $('#divider').classList.remove('dragging'); save(); });
    });

    $('#codex-chip').addEventListener('click', toggleCodex);
    $('#mic-btn').addEventListener('click', toggleVoice);
    $('#update-btn').addEventListener('click', clickUpdate);
    $('#sb-debug').addEventListener('click', toggleDebug);

    new ResizeObserver(queueFit).observe($('#workspace'));
    window.addEventListener('focus', () => {
      winFocused = true;
      acknowledge();
      api.codexStatus(false).then(renderCodex).catch(() => { /* se verá en la próxima comprobación */ });
    });
    window.addEventListener('blur', () => { winFocused = false; hidePreview(); });
    // Al escribir, la tarjeta de vista previa estorba (Ctrl solo no: sirve para abrir con Ctrl+clic).
    window.addEventListener('keydown', (e) => {
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) hidePreview();
    }, true);
  }

  function wireDialog() {
    const dialog = $('#dlg-new');
    $('#f-colors').replaceChildren(...COLORS.map((color) => {
      const chip = el('label', 'chip');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'color';
      radio.value = color.key;
      chip.append(radio);
      if (color.hex) chip.append(swatch(color.key));
      chip.append(color.name);
      return chip;
    }));
    $('#f-shell').replaceChildren(...info.shells.map((sh) => {
      const option = el('option', '', sh.name);
      option.value = sh.key;
      return option;
    }));

    $('#f-folder').addEventListener('input', () => { $('#f-error').hidden = true; suggestName(); });
    $('#f-name').addEventListener('input', () => { nameTouched = $('#f-name').value.trim() !== ''; });
    $('#f-browse').addEventListener('click', async () => {
      const picked = await api.pickFolder(cleanFolder($('#f-folder').value) || undefined);
      if (!picked) return;
      $('#f-folder').value = picked;
      $('#f-error').hidden = true;
      suggestName();
      $('#f-name').focus();
      $('#f-name').select();
    });
    $('#f-cancel').addEventListener('click', () => dialog.close());
    $('#form-new').addEventListener('submit', submitNew);
    dialog.addEventListener('close', () => requestAnimationFrame(focusTerminal));
  }

  function wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (dialogOpen()) return;
      if (e.key === 'Escape' && !$('#plus-menu').hidden) { closePlusMenu(); focusTerminal(); e.preventDefault(); e.stopPropagation(); return; }
      // En un campo de texto de la app (no en la terminal) las teclas son suyas.
      if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;

      const key = e.key;
      const lower = key.toLowerCase();
      const ctrl = e.ctrlKey && !e.metaKey;
      let handled = true;

      if (ctrl && !e.altKey && key === 'Tab') cycle(e.shiftKey ? -1 : 1);
      else if (ctrl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(key)) { const tab = S.tabs[Number(key) - 1]; if (tab) activate(tab.id); }
      else if (ctrl && e.shiftKey && !e.altKey && lower === 't') openNewDialog();
      else if (ctrl && e.shiftKey && !e.altKey && lower === 'w') { if (S.activeId) closeTab(S.activeId); }
      else if (ctrl && e.shiftKey && !e.altKey && lower === 'd') toggleSplit();
      else if (ctrl && !e.shiftKey && !e.altKey && (lower === 'ñ' || key === '`' || key === 'º')) toggleExtra();
      else if (ctrl && e.altKey && key === 'ArrowLeft') focusSide('left');
      else if (ctrl && e.altKey && key === 'ArrowRight') focusSide('right');
      else if (ctrl && !e.altKey && (key === '+' || key === '=' || e.code === 'NumpadAdd')) zoomActive(0.1);
      else if (ctrl && !e.altKey && !e.shiftKey && (key === '-' || e.code === 'NumpadSubtract')) zoomActive(-0.1);
      else if (ctrl && !e.altKey && !e.shiftKey && (key === '0' || e.code === 'Numpad0')) zoomActive(0);
      else if (key === 'F2' && !ctrl && !e.altKey) startRename(S.activeId);
      else handled = false;

      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function zoomActive(delta) {
    const view = views.get(S.activeId);
    if (view) setZoom(view, delta === 0 ? 1 : (view.tab.zoom || 1) + delta);
  }

  // ── Arranque ─────────────────────────────────────────────────────

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const validColor = (v) => (COLORS.some((c) => c.key === v) ? v : '');
    const validShell = (v) => (info.shells.some((s) => s.key === v) ? v : 'powershell');
    const seen = new Set();
    for (const raw of Array.isArray(saved.tabs) ? saved.tabs : []) {
      if (!raw || typeof raw.id !== 'string' || !raw.cwd || seen.has(raw.id)) continue;
      seen.add(raw.id);
      S.tabs.push({
        id: raw.id,
        name: text(raw.name, 60) || baseName(String(raw.cwd)),
        cwd: String(raw.cwd),
        color: validColor(raw.color),
        shell: validShell(raw.shell),
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
        zoom: clamp(Number(raw.zoom) || 1, 0.6, 2.4),
        extraOpen: Boolean(raw.extraOpen),
        extraHeight: Number(raw.extraHeight) || 0,
        context: cleanContext(raw.context),
        contextOpen: Boolean(raw.contextOpen),
      });
    }
    for (const raw of Array.isArray(saved.recents) ? saved.recents : []) {
      if (!raw || !raw.cwd || S.recents.length >= MAX_RECENTS) continue;
      S.recents.push({
        name: text(raw.name, 60) || baseName(String(raw.cwd)),
        cwd: String(raw.cwd),
        color: validColor(raw.color),
        shell: validShell(raw.shell),
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
        zoom: clamp(Number(raw.zoom) || 1, 0.6, 2.4),
        extraHeight: Number(raw.extraHeight) || 0,
        context: cleanContext(raw.context),
      });
    }
    S.activeId = typeof saved.activeId === 'string' ? saved.activeId : null;
    S.focusSide = saved.focusSide === 'right' ? 'right' : 'left';
    S.lastShell = validShell(saved.lastShell);
    if (saved.split && typeof saved.split === 'object') {
      S.split = { left: saved.split.left, right: saved.split.right, ratio: clamp(Number(saved.split.ratio) || 0.5, 0.2, 0.8) };
    }
  }

  async function init() {
    info = await api.info();
    $('#app-version').textContent = info.version ? `v${info.version}` : '';
    sleepAfterMs = (info.sleepMinutes || 45) * 60 * 1000;
    setInterval(sleepIdleSessions, Math.min(60 * 1000, Math.max(1000, sleepAfterMs / 4)));
    // Solo al ejecutar desde el código: pegar texto en la pestaña activa como si
    // viniera del portapapeles, para las pruebas automáticas (CLAUDES_TEST_JS).
    if (info.dev) {
      window.claudesTest = {
        pasteText: (text) => {
          const view = views.get(S.activeId);
          return view ? pasteClip(view.term, view, { files: [], text, imagePath: null }) : null;
        },
        addContext: (paths) => {
          const view = views.get(S.activeId);
          if (view) addToContext(view, paths);
        },
        addLinks: (urls) => {
          const view = views.get(S.activeId);
          return view ? addLinks(view, urls) : false;
        },
        // Pone una pestaña en un estado, para ver cómo se pinta.
        showStatus: (index, status) => {
          const tab = S.tabs[index];
          const view = tab && views.get(tab.id);
          if (view) setStatus(view, status);
          return Boolean(view);
        },
      };
    }
    restore(await api.loadState());

    // xterm mide la letra al abrirse: las fuentes tienen que estar cargadas antes.
    await Promise.all([
      document.fonts.load(`${BASE_FONT}px 'IBM Plex Mono'`),
      document.fonts.load(`600 ${BASE_FONT}px 'IBM Plex Mono'`),
      document.fonts.load("14px 'IBM Plex Sans'"),
    ]).catch(() => { /* se usarán las fuentes de reserva */ });

    wireChrome();
    wireRainbow();
    wireLog();
    wireTabs();
    wireDialog();
    wireKeyboard();

    api.onPtyData((id, data) => { const term = terms.get(id); if (term) term.write(data); });
    api.onPtyExit(onPtyExit);
    api.onHook(onHook);
    api.onUsage((tabId, usage) => {
      const view = views.get(tabId);
      if (!view) return;
      view.usage = usage;
      renderTabs();
      renderStatusbar();
    });
    let limitsArrived = false;
    const takeLimits = (snap) => {
      if (!snap || typeof snap !== 'object') return;
      limitsArrived = true;
      limitsSnap = { plan: snap.plan || null, conversations: snap.conversations || {} };
      renderStatusbar();
    };
    api.onLimits(takeLimits);
    api.limitsGet().then((snap) => { if (!limitsArrived) takeLimits(snap); }).catch(() => { /* sin límites */ });
    // «hoy a las 21:00» pasa a ser «ayer…» con el cambio de día.
    setInterval(renderPlanLimits, 60 * 1000);
    api.onNotifyClick((tabId) => { if (byId(tabId)) activate(tabId); });
    api.onCodexChanged(renderCodex);
    api.codexStatus(false).then(renderCodex).catch(() => { /* sin indicador hasta la próxima comprobación */ });
    api.debugGet().then(renderDebug).catch(() => { /* sin interruptor de depuración */ });
    api.voiceGet().then(renderVoice).catch(() => { /* sin botón de micrófono */ });
    api.onUpdateChanged(renderUpdate);
    api.updateGet().then((u) => {
      renderUpdate(u);
      // Resultado de la actualización instalada al cerrar la vez anterior.
      if (u && u.result) {
        toast(u.result.ok
          ? `ClaudHome se ha actualizado a la versión ${u.result.version}.`
          : `No se ha podido instalar ClaudHome ${u.result.version}. Los detalles están en la carpeta de registros.`);
      }
    }).catch(() => { /* sin botón de actualizar */ });
    // Los errores de la interfaz también quedan en el registro de la app.
    window.addEventListener('error', (e) => api.log(`ERROR: ${e.message} (${String(e.filename).split('/').pop()}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => api.log(`promesa rechazada: ${(e.reason && e.reason.stack) || e.reason}`));
    // Cierre de la app con «Guardar estado y cerrar»: cada sesión que trabaja deja
    // anotado su estado y, cuando todas han terminado, la app se cierra.
    api.onWrapUpAll(async () => {
      const busy = [...views.values()].filter((v) => v.started && (v.closing || v.status === 'working' || v.status === 'needs'));
      if (busy.length) toast(busy.length === 1 ? 'Claude está guardando su estado antes de cerrar…' : 'Las sesiones están guardando su estado antes de cerrar…', true);
      await Promise.all(busy.map(async (view) => {
        const result = await wrapUp(view);
        if (result === 'saved' && views.has(view.tab.id)) await gracefulExit(view);
      }));
      api.closeNow();
    });

    for (const tab of S.tabs) createView(tab, 'resume');
    if (S.activeId) touchMru(S.activeId);
    layout();

    if (!info.claudeFound) toast('No encuentro Claude Code en este equipo: instálalo o añádelo al PATH.');
  }

  init();
})();
