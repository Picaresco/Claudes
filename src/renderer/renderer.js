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
    working: '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#3A414D" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#E7E9EC" stroke-width="2" stroke-linecap="round"/></svg>',
    attn: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#FF8A65" fill-opacity="0.3"/><circle cx="8" cy="8" r="4" fill="#FF8A65"/></svg>',
    idle: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="#8B929D" stroke-width="1.5"/></svg>',
    off: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="#8B929D" stroke-width="1.5" stroke-dasharray="2.4 2.4"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
    terminal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3"/></svg>',
  };

  // El color distingue la pestaña; la forma del icono, su estado.
  const STATUS = {
    asleep: { icon: 'off', label: 'Sin iniciar' },
    starting: { icon: 'idle', label: 'Iniciando' },
    idle: { icon: 'idle', label: 'En reposo' },
    working: { icon: 'working', label: 'Trabajando' },
    needs: { icon: 'attn', label: 'Te necesita' },
    done: { icon: 'attn', label: 'Ha terminado' },
    closing: { icon: 'working', label: 'Guardando su estado para cerrar' },
    exited: { icon: 'off', label: 'Sesión cerrada' },
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

  const panes = {};
  const byId = (id) => S.tabs.find((t) => t.id === id) || null;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const fontSizeFor = (zoom) => Math.max(8, Math.round(BASE_FONT * (zoom || 1)));
  const visibleIds = () => (S.split ? [S.split.left, S.split.right] : S.activeId ? [S.activeId] : []);
  const isWatched = (view) => winFocused && visibleIds().includes(view.tab.id);
  const dialogOpen = () => $('#dlg-new').open;

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
    return term;
  }

  // Rutas listas para pegar en una terminal: entre comillas si llevan espacios.
  const quotePath = (file) => (/\s/.test(file) ? `"${file}"` : file);
  const joinPaths = (files) => `${files.map(quotePath).join(' ')} `;

  // Pega lo que haya en el portapapeles: archivos copiados en el Explorador (sus
  // rutas), texto, o una imagen copiada (se guarda como archivo y se pega su ruta).
  // Claude Code adjunta por sí mismo las imágenes cuya ruta se pega.
  async function paste(term) {
    let clip;
    try {
      clip = await api.clipboardRead();
    } catch {
      toast('No se ha podido leer el portapapeles.');
      return;
    }
    if (clip.files.length) {
      // De uno en uno, para que Claude Code reconozca cada imagen por separado. Al
      // convertir una imagen en [Image #n] se come el espacio de detrás: se repone.
      let afterImage = false;
      for (const file of clip.files) {
        term.paste(`${afterImage ? ' ' : ''}${joinPaths([file])}`);
        afterImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(file);
        await sleep(120);
      }
    } else if (clip.text) term.paste(clip.text);
    else if (clip.imagePath) term.paste(joinPaths([clip.imagePath]));
    else toast('El portapapeles está vacío o contiene algo que no se puede pegar aquí.');
  }

  function copySelection(term) {
    api.clipboardWrite(term.getSelection());
    term.clearSelection();
  }

  function wireKeys(term, ptyId, isClaude) {
    term.attachCustomKeyEventHandler((e) => {
      const key = (e.key || '').toLowerCase();
      const plainCtrl = e.ctrlKey && !e.altKey && !e.metaKey;
      if (isClaude && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        // Mayús+Intro = salto de línea sin enviar (equivale a Ctrl+J en Claude Code).
        if (e.type === 'keydown') { e.preventDefault(); api.ptyWrite(ptyId, '\n'); }
        return false;
      }
      if (e.type !== 'keydown') return true;
      if (plainCtrl && key === 'c' && term.hasSelection()) { e.preventDefault(); copySelection(term); return false; }
      if (plainCtrl && key === 'v') { e.preventDefault(); paste(term); return false; }
      return true;
    });
  }

  function wireHost(host, term, ptyId, view, isClaude) {
    // Botón derecho: copia si hay texto seleccionado; si no, pega.
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) copySelection(term);
      else paste(term);
    });
    // Soltar archivos sobre la terminal pega sus rutas.
    host.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    host.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
      if (files.length) { term.paste(joinPaths(files)); term.focus(); }
    });
    host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      setZoom(view, (view.tab.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false, capture: true });
    host.addEventListener('focusin', () => { view.lastFocus = isClaude ? 'claude' : 'extra'; });
  }

  function createView(tab, mode) {
    const view = {
      tab, mode, status: 'asleep', started: false, opened: false, exited: false,
      resumed: false, startedAt: 0, extra: null, lastFocus: 'claude',
    };
    view.el = el('div', 'tabview');
    const wrap = el('div', 'term-wrap');
    view.host = el('div', 'term-host');
    wrap.append(view.host);
    view.term = makeTerminal(tab.zoom, THEME);
    view.fit = new FitAddon.FitAddon();
    view.term.loadAddon(view.fit);
    view.extraEl = buildExtraPanel(view);
    view.el.append(wrap, view.extraEl);

    terms.set(tab.id, view.term);
    view.term.onData((data) => {
      if (view.started) api.ptyWrite(tab.id, data);
      else if (view.exited && data === '\r') { view.term.reset(); startClaude(view); }
    });
    // Al contestar a una petición de permiso, la sesión vuelve a estar trabajando.
    view.term.onKey(({ domEvent }) => {
      if (view.status === 'needs' && /^(Enter|Escape|[0-9])$/.test(domEvent.key)) setStatus(view, 'working');
    });
    view.term.onResize(({ cols, rows }) => { if (view.started) api.ptyResize(tab.id, cols, rows); });
    wireKeys(view.term, tab.id, true);
    wireHost(view.host, view.term, tab.id, view, true);

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
    wireKeys(term, ptyId, false);
    wireHost(view.extraHost, term, ptyId, view, false);
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
    setStatus(view, 'starting');
    // Una misma conversación no se abre en dos pestañas a la vez.
    const exclude = S.tabs.filter((t) => t.id !== tab.id && t.sessionId).map((t) => t.sessionId);
    const res = await api.ptyCreate({
      id: tab.id, kind: 'claude', cwd: tab.cwd, sessionId: tab.sessionId, mode, exclude,
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
    const idle = [...views.values()].filter((v) => v.started && !v.codex && !v.closing && (v.status === 'idle' || v.status === 'done'));
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
    if (!view.started && !view.exited) startClaude(view);
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
    if (view.status === status) return;
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
    if (isWatched(view)) { setStatus(view, 'idle'); return; }
    const was = view.status;
    setStatus(view, 'done');
    if (was === 'done') return;
    api.notify({
      tabId: view.tab.id,
      title: failed ? `${view.tab.name} se ha detenido` : `${view.tab.name} ha terminado`,
      body: failed ? 'Claude no ha podido completar la respuesta.' : 'Claude ha terminado y espera tu siguiente mensaje.',
    });
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
    node.classList.toggle('attn', st.icon === 'attn');

    const main = el('button', 'tab-main');
    main.setAttribute('role', 'tab');
    main.setAttribute('aria-selected', String(tab.id === S.activeId));
    main.setAttribute('aria-label', `${tab.name}, ${st.label.toLowerCase()}`);
    main.title = `${tab.name} · ${st.label}\n${tab.cwd}`;
    main.innerHTML = SVG[st.icon];
    main.append(el('span', 'tab-name', tab.name));

    const close = el('button', 'tab-close');
    close.setAttribute('aria-label', `Cerrar la pestaña ${tab.name}`);
    close.title = 'Cerrar pestaña (Ctrl+Mayús+W)';
    close.innerHTML = SVG.close;

    node.append(main, close);
    return node;
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
    document.title = tab ? `${tab.name} · Claudes` : 'Claudes'; // lo que se ve en la barra de tareas
    if (!tab) return;
    applySwatch($('#tb-swatch'), tab.color);
    $('#tb-name').textContent = tab.name;
    $('#tb-path').textContent = tab.cwd;
    $('#tb-path').title = tab.cwd;
    $('#btn-terminal').setAttribute('aria-pressed', String(Boolean(tab.extraOpen)));
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
      const status = el('span', `ph-status${st.icon === 'attn' ? ' attn' : ''}`);
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
    for (const view of views.values()) {
      if (view.status === 'working' || view.status === 'closing') working += 1;
      if (view.status === 'needs') waiting += 1;
      if (view.status === 'needs' || view.status === 'done') attn += 1;
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

    const tab = byId(S.activeId);
    const zoom = $('#sb-zoom');
    zoom.hidden = !tab;
    if (tab) zoom.textContent = `${Math.round((tab.zoom || 1) * 100)} %`;
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
    };
    S.tabs.push(tab);
    createView(tab, mode);
    activate(tab.id);
    return tab;
  }

  function addRecent(tab) {
    const same = (r) => r.cwd.toLowerCase() === tab.cwd.toLowerCase() && r.name === tab.name;
    S.recents = [
      { name: tab.name, cwd: tab.cwd, color: tab.color, shell: tab.shell, sessionId: tab.sessionId, zoom: tab.zoom, extraHeight: tab.extraHeight },
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
    const action = await api.tabMenu({ color: tab.color || '', colors: COLORS.map(({ key, name }) => ({ key, name })) });
    if (!action || !byId(id)) return;
    if (action === 'rename') startRename(id);
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

  function focusSide(side) {
    if (!S.split || S.focusSide === side) return;
    S.focusSide = side;
    S.activeId = S.split[side];
    touchMru(S.activeId);
    renderAll();
    acknowledge();
    focusTerminal();
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
      node.addEventListener('mousedown', () => focusSide(side), true);
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
    $('#btn-split').addEventListener('click', toggleSplit);
    $('#btn-swap').addEventListener('click', swapSides);
    $('#btn-newconv').addEventListener('click', () => newConversation());
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

    new ResizeObserver(queueFit).observe($('#workspace'));
    window.addEventListener('focus', () => {
      winFocused = true;
      acknowledge();
      api.codexStatus(false).then(renderCodex).catch(() => { /* se verá en la próxima comprobación */ });
    });
    window.addEventListener('blur', () => { winFocused = false; });
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
      if (e.target instanceof HTMLElement && e.target.matches('input, select')) return;

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
    restore(await api.loadState());

    // xterm mide la letra al abrirse: las fuentes tienen que estar cargadas antes.
    await Promise.all([
      document.fonts.load(`${BASE_FONT}px 'IBM Plex Mono'`),
      document.fonts.load(`600 ${BASE_FONT}px 'IBM Plex Mono'`),
      document.fonts.load("14px 'IBM Plex Sans'"),
    ]).catch(() => { /* se usarán las fuentes de reserva */ });

    wireChrome();
    wireTabs();
    wireDialog();
    wireKeyboard();

    api.onPtyData((id, data) => { const term = terms.get(id); if (term) term.write(data); });
    api.onPtyExit(onPtyExit);
    api.onHook(onHook);
    api.onNotifyClick((tabId) => { if (byId(tabId)) activate(tabId); });
    api.onCodexChanged(renderCodex);
    api.codexStatus(false).then(renderCodex).catch(() => { /* sin indicador hasta la próxima comprobación */ });
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
