// ── Estado ───────────────────────────────────────────────────────
import { colorHex, BASE_FONT } from './constants.js';
import { api, $, el } from './dom.js';

// Lo que se guarda en disco. Cada pestaña: { id, name, cwd, color, shell,
// sessionId, zoom, extraOpen, extraHeight }.
export const S = { tabs: [], activeId: null, split: null, focusSide: 'left', recents: [], lastShell: 'powershell' };

export const views = new Map(); // id de pestaña → vista (terminales y estado en vivo)
export const terms = new Map(); // id de proceso → terminal que muestra su salida
export let info = { shells: [], windowsBuild: 0, claudeFound: true };
export const setInfo = (value) => { info = value; };
export let mru = [];
export const setMru = (value) => { mru = value; };
export let winFocused = document.hasFocus();
export const setWinFocused = (value) => { winFocused = value; };
export let renamingId = null;
export const setRenamingId = (value) => { renamingId = value; };
export let draggingId = null;
export const setDraggingId = (value) => { draggingId = value; };
export let lastBusy = -1;
export const setLastBusy = (value) => { lastBusy = value; };
let saveTimer = null;
export let fitQueued = false;
export const setFitQueued = (value) => { fitQueued = value; };
let toastTimer = null;
export let voiceOn = false; // micrófono para dictar (botón de la barra superior)
export const setVoiceOn = (value) => { voiceOn = value; };

export const panes = {};
export const byId = (id) => S.tabs.find((t) => t.id === id) || null;
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export const fontSizeFor = (zoom) => Math.max(8, Math.round(BASE_FONT * (zoom || 1)));
export const visibleIds = () => (S.split ? [S.split.left, S.split.right] : S.activeId ? [S.activeId] : []);
export const isWatched = (view) => winFocused && visibleIds().includes(view.tab.id);
export const dialogOpen = () => $('#dlg-new').open || $('#dlg-update').open || $('#dlg-log').open;

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveState({
      tabs: S.tabs, activeId: S.activeId, split: S.split, focusSide: S.focusSide,
      recents: S.recents, lastShell: S.lastShell,
    });
  }, 200);
}

export function touchMru(id) {
  mru = [id, ...mru.filter((x) => x !== id)];
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function toast(text, sticky = false) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

export function applySwatch(node, colorKey) {
  const hex = colorHex(colorKey);
  node.classList.toggle('none', !hex);
  if (hex) node.style.setProperty('--c', hex);
  else node.style.removeProperty('--c');
}

export function swatch(colorKey) {
  const node = el('span', 'swatch');
  node.setAttribute('aria-hidden', 'true');
  applySwatch(node, colorKey);
  return node;
}

// Arrastre genérico (divisor de la vista, alto de la terminal extra).
export function startDrag(event, cursor, onMove, onEnd) {
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
