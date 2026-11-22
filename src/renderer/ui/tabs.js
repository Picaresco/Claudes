// ── Acciones sobre pestañas ──────────────────────────────────────
import { COLORS, MAX_RECENTS, MAX_TABS } from './constants.js';
import { cleanContext } from './context.js';
import { api, $, el } from './dom.js';
import { renderAll, layout } from './render.js';
import { createView, startClaude } from './sessions.js';
import { S, views, terms, mru, setMru, renamingId, setRenamingId, byId, visibleIds, newId, save, touchMru } from './state.js';
import { setStatus, wrapUp, gracefulExit } from './status.js';
import { focusTerminal } from './views.js';

export function activate(id, side) {
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

export function cycle(direction) {
  if (S.tabs.length < 2) return;
  const index = S.tabs.findIndex((t) => t.id === S.activeId);
  const next = S.tabs[(index + direction + S.tabs.length) % S.tabs.length];
  activate(next.id);
}

// ¿Cabe otro proyecto? Si ya hay MAX_TABS abiertos, lo avisa y devuelve false.
export function roomForTab() {
  if (S.tabs.length < MAX_TABS) return true;
  api.choose({
    message: `Ya tienes ${S.tabs.length} proyectos abiertos`,
    detail: `El máximo es ${MAX_TABS}, para no saturar la barra superior. Cierra alguno (con la × de su pestaña) y vuelve a intentarlo: queda en «Recientes» con su conversación, y lo puedes reabrir cuando quieras.`,
    buttons: ['Entendido'],
  }).catch(() => { /* sin diálogo */ });
  return false;
}

export function addTab(fields, mode) {
  if (!roomForTab()) return null;
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

export async function closeTab(id) {
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
  if (['working', 'reviewing', 'planreview', 'consulting', 'needs'].includes(view.status)) {
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
  setMru(mru.filter((x) => x !== id));
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

export function startRename(id) {
  const tab = byId(id);
  const node = tab && $(`#tabs .tab[data-id="${id}"]`);
  if (!node || renamingId) return;
  const input = el('input', 'tab-edit');
  input.type = 'text';
  input.value = tab.name;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Nombre de la pestaña');
  setRenamingId(id);
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
    setRenamingId(null);
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

export async function tabMenu(id) {
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

export function moveTab(id, targetId, before) {
  const from = S.tabs.findIndex((t) => t.id === id);
  if (from < 0 || id === targetId) return;
  const [tab] = S.tabs.splice(from, 1);
  let to = S.tabs.findIndex((t) => t.id === targetId);
  if (to < 0) { S.tabs.splice(from, 0, tab); return; }
  if (!before) to += 1;
  S.tabs.splice(to, 0, tab);
  save();
}
