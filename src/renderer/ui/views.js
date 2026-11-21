// Ajuste de las vistas a su hueco: tamaño de las terminales, foco, zoom y terminal extra.
import { renderToolbar, renderStatusbar } from './render.js';
import { ensureExtra, startShell, startClaude } from './sessions.js';
import { S, views, renamingId, fitQueued, setFitQueued, clamp, fontSizeFor, visibleIds, dialogOpen, save } from './state.js';

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

export function fitView(view) {
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
export function showView(view) {
  if (!view.opened) {
    view.term.open(view.host);
    view.opened = true;
  }
  syncExtra(view);
  fitView(view);
  if (!view.started && !view.exited && !view.goingToSleep) startClaude(view);
}

export function queueFit() {
  if (fitQueued) return;
  setFitQueued(true);
  requestAnimationFrame(() => {
    setFitQueued(false);
    for (const id of visibleIds()) {
      const view = views.get(id);
      if (view) fitView(view);
    }
  });
}

export function focusTerminal() {
  if (dialogOpen() || renamingId) return;
  const view = views.get(S.activeId);
  if (!view || !view.opened) return;
  const extra = view.extra;
  if (view.lastFocus === 'extra' && extra && extra.opened && view.tab.extraOpen) extra.term.focus();
  else view.term.focus();
}

export function setZoom(view, zoom) {
  const next = clamp(Math.round(zoom * 10) / 10, 0.6, 2.4);
  if (next === (view.tab.zoom || 1)) return;
  view.tab.zoom = next;
  view.term.options.fontSize = fontSizeFor(next);
  if (view.extra) view.extra.term.options.fontSize = fontSizeFor(next);
  fitView(view);
  renderStatusbar();
  save();
}

export function toggleExtra(view = views.get(S.activeId)) {
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
