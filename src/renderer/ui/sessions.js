// La vista de cada pestaña y sus procesos: la sesión de Claude y la terminal extra.
import { SVG, THEME, THEME_EXTRA } from './constants.js';
import { buildContextPanel, syncContextPanel, wireDropChoice } from './context.js';
import { api, $, el } from './dom.js';
import { registerPreviewLinks } from './preview.js';
import { renderToolbar } from './render.js';
import { S, views, terms, info, clamp, visibleIds, save, startDrag } from './state.js';
import { setStatus } from './status.js';
import { makeTerminal, wireKeys, wireHost } from './terminals.js';
import { queueFit, toggleExtra } from './views.js';

export function createView(tab, mode) {
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

export function ensureExtra(view) {
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

export async function startShell(view) {
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

export async function startClaude(view) {
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
export async function restartSession(view) {
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
