// ── «Log»: lo que sale de este equipo ────────────────────────────
// El proceso principal (netlog.js) apunta lo que ha visto Claude (se envía a
// Anthropic) y lo que sale directamente hacia internet; aquí se muestra,
// filtrado por pestaña, tipo o texto.
import { api, $, el } from './dom.js';
import { formatSize } from './preview.js';
import { renderToolbar } from './render.js';
import { S, byId } from './state.js';
import { focusTerminal } from './views.js';

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

// Del mismo proyecto: de la misma carpeta, aunque se abriera en otra pestaña.
// Las entradas sin carpeta se reconocen por su pestaña.
const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
const ofProject = (e, tab) => (e.cwd ? samePath(e.cwd, tab.cwd) : e.tabId === tab.id);
export const logEntriesOf = (tab) => netlog.filter((e) => ofProject(e, tab));
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
  const rows = netlog.filter((e) => (logFilter.scope === 'all' || (tab && ofProject(e, tab)))
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
  // Siempre empieza en el proyecto de la pestaña activa; «Todos» dura mientras está abierto.
  logFilter.scope = byId(S.activeId) ? 'tab' : 'all';
  for (const b of dialog.querySelectorAll('[data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === logFilter.scope));
  for (const b of dialog.querySelectorAll('[data-kind]')) b.setAttribute('aria-pressed', String(b.dataset.kind === logFilter.kind));
  $('#log-search').value = logFilter.text;
  renderLog();
  if (!dialog.open) dialog.showModal();
}

export function wireLog() {
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
