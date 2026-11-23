// ── Panel «Actividad» ────────────────────────────────────────────
// A la derecha: lo que va haciendo Claude en la pestaña activa, contado como lo contaría un
// compañero (src/main/narrator.js). Cada paso sale al momento en gris; a los pocos segundos,
// Haiku lo cuenta con sus palabras. Abajo, lo que está haciendo ahora mismo y desde cuándo.
// La rueda de opciones la activa o desactiva (desactivada, Haiku no cuenta nada y no hay
// pestaña); la pestaña lateral solo muestra u oculta la columna (oculta, sigue contando).
import { api, $, el } from './dom.js';
import { previewAt, hidePreview } from './preview.js';
import { focusAfterToggle } from './settings.js';
import { S, byId, applySwatch, toast } from './state.js';

// Un icono por tipo de paso (trazos de 16×16).
const ICONS = {
  user: '<circle cx="8" cy="5" r="2.6"/><path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/>',
  think: '<path d="M4 8h.01M8 8h.01M12 8h.01" stroke-width="2.4"/>',
  read: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  write: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M8 7.5v4.5M5.8 9.8h4.4"/>',
  edit: '<path d="M11 2.5 13.5 5 6 12.5 2.8 13.2l.7-3.2z"/>',
  command: '<path d="M2.5 4.5 6 8l-3.5 3.5M8 12h5.5"/>',
  tests: '<path d="M6 1.5h4M6.8 1.5v4.2L2.8 13a1 1 0 0 0 .9 1.5h8.6a1 1 0 0 0 .9-1.5L9.2 5.7V1.5"/><path d="M4.6 10h6.8"/>',
  web: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6"/>',
  agent: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>',
  plan: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  ask: '<path d="M2.5 3h11v7.5H8l-3 2.5v-2.5H2.5z"/><path d="M8 8.4h.01"/><path d="M6.6 5.4a1.4 1.4 0 1 1 1.4 1.6"/>',
  wait: '<path d="M4.5 2h7M4.5 14h7M5.2 2c0 3.6 5.6 3.8 5.6 6s-5.6 2.4-5.6 6M10.8 2c0 3.6-5.6 3.8-5.6 6s5.6 2.4 5.6 6"/>',
  codex: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6z"/>',
  tool: '<path d="M10.4 2a3.1 3.1 0 0 0-2.7 4.3L2.4 11.6l2 2 5.3-5.3A3.1 3.1 0 0 0 14 5.6l-1.9 1.9-1.9-.4-.4-1.9z"/>',
  fail: '<circle cx="8" cy="8" r="6"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/>',
  say: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  done: '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/>',
  error: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.6h.01"/>',
  link: '<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
};
const icon = (kind) => {
  const span = el('span', 'act-ico');
  span.innerHTML = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.say}</svg>`;
  return span;
};

const data = new Map(); // id de pestaña → { entries, now }
const seen = new Set(); // líneas ya pintadas (las nuevas entran con una animación)
let enabled = false; // activada en la rueda de opciones
let open = false; // la columna, a la vista
let shownTab = null;
let painted = []; // lo pintado, una clave por línea (id, si es gris, tipo y texto)

const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
function since(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// La miniatura de lo que enseña Claude (una imagen o la primera página de un PDF), debajo de
// su línea. Pulsarla lo abre; al pasar el ratón, se ve en grande. Se pide una vez por archivo.
const thumbs = new Map(); // ruta → promesa de la imagen (data URL) o null
function thumbnail(target) {
  if (!thumbs.has(target)) {
    if (thumbs.size > 200) thumbs.clear();
    thumbs.set(target, api.preview(target)
      .then((data) => (data && data.image && (data.kind === 'image' || data.kind === 'page') ? data.image : null))
      .catch(() => null));
  }
  return thumbs.get(target);
}
function addThumb(li, target) {
  const box = el('button', 'act-thumb');
  box.type = 'button';
  box.hidden = true;
  box.title = `Abrir ${target}`;
  box.addEventListener('click', () => { hidePreview(); api.openPath(target); });
  box.addEventListener('mouseenter', (e) => previewAt(target, e));
  box.addEventListener('mouseleave', () => hidePreview());
  li.append(box);
  thumbnail(target).then((image) => {
    if (!image) return;
    const img = el('img');
    img.alt = '';
    img.src = image;
    box.replaceChildren(img);
    box.hidden = false;
  });
}

function item(entry) {
  const li = el('li', 'act-item');
  li.dataset.kind = entry.kind;
  li.dataset.src = entry.src;
  if (entry.pending) li.dataset.pending = 'true';
  if (!seen.has(entry.id)) { li.classList.add('fresh'); seen.add(entry.id); }
  li.title = `${hhmm(entry.at)} · ${entry.text}`; // entera, aunque no quepa en dos renglones
  li.append(icon(entry.kind));
  const text = el('p', 'act-text', entry.src === 'user' ? `«${entry.text}»` : entry.text);
  // «Pincha aquí para ver…»: «aquí» abre la imagen, el PDF, la página o la web.
  if (entry.link && entry.link.target && entry.text.includes('aquí')) {
    const at = entry.text.indexOf('aquí');
    const here = el('button', 'act-link', 'aquí');
    here.type = 'button';
    here.title = entry.link.target;
    here.addEventListener('click', () => { hidePreview(); api.openPath(entry.link.target); });
    // Al pasar el ratón, la vista previa grande (la de las rutas de la terminal); las webs, no.
    if (!/^https?:\/\//i.test(entry.link.target)) {
      here.addEventListener('mouseenter', (e) => previewAt(entry.link.target, e));
      here.addEventListener('mouseleave', () => hidePreview());
    }
    text.replaceChildren(entry.text.slice(0, at), here, entry.text.slice(at + 4));
  }
  if (entry.src === 'user') li.append(el('span', 'act-who', 'Tú'));
  li.append(text);
  if (entry.src !== 'local') li.append(el('time', 'act-time', hhmm(entry.at)));
  if (entry.link && entry.link.target && !/^https?:\/\//i.test(entry.link.target)) addThumb(li, entry.link.target);
  return li;
}

function renderNow(snap) {
  const now = snap && snap.now;
  $('#act-now').hidden = !now;
  if (!now) return;
  $('#act-now').dataset.kind = now.kind;
  $('#act-now-text').textContent = now.text;
  $('#act-now-time').textContent = since(now.since);
}

export function renderActivity() {
  const tab = byId(S.activeId);
  const panel = $('#activity');
  // El interruptor de la rueda de opciones.
  const button = $('#activity-btn');
  button.hidden = false;
  button.setAttribute('aria-checked', String(enabled));
  button.title = enabled
    ? 'Actividad: activada. Haiku cuenta lo que hace Claude, aunque ocultes la columna con su pestaña lateral (gasta muy poco de tu plan). Pulsa para desactivarla.'
    : 'Actividad: desactivada. Pulsa para que Haiku te cuente en una pestaña lateral lo que va haciendo Claude.';
  // La pestaña lateral: muestra u oculta la columna; oculta, el punto dice si Claude está trabajando.
  const toggle = $('#act-toggle');
  toggle.hidden = !tab || !enabled;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Ocultar la columna (Haiku sigue contando; se desactiva en la rueda de opciones)' : 'Mostrar la actividad: lo que va haciendo Claude, contado en palabras sencillas';
  const busy = Boolean(tab && (data.get(tab.id) || {}).now);
  $('#act-toggle-dot').hidden = open || !busy;
  panel.hidden = !enabled || !open || !tab;
  if (panel.hidden) return;
  applySwatch($('#act-swatch'), tab.color);
  $('#act-tab').textContent = tab.name;
  const snap = data.get(tab.id) || { entries: [], now: null };
  renderNow(snap);
  // La lista solo cambia por el final (líneas nuevas, grises que Haiku sustituye): se dejan
  // tal cual las que no cambian (no se pierde lo seleccionado ni se vuelven a anunciar) y se
  // rehacen desde la primera distinta. Al cambiar de pestaña, entera.
  const list = $('#act-list');
  const keys = snap.entries.map((e) => `${e.id}|${e.pending ? 1 : 0}|${e.kind}|${e.text}`);
  const sameTab = shownTab === tab.id && list.children.length === painted.length;
  let from = 0;
  if (sameTab) while (from < keys.length && from < painted.length && keys[from] === painted[from]) from += 1;
  if (sameTab && from === keys.length && from === painted.length) return; // nada nuevo
  // Si estaba abajo del todo, sigue abajo; si se ha subido a leer, no se le mueve.
  const atEnd = !sameTab || list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
  if (!sameTab) {
    // Al cambiar de pestaña, lo que ya había no entra con animación.
    if (seen.size > 5000) seen.clear();
    for (const entry of snap.entries) seen.add(entry.id);
    from = 0;
  }
  while (list.children.length > from) list.lastElementChild.remove();
  list.append(...snap.entries.slice(from).map(item));
  painted = keys;
  shownTab = tab.id;
  $('#act-empty').hidden = snap.entries.length > 0;
  if (atEnd) list.scrollTop = list.scrollHeight;
}

export function setActivity(tabId, snap) {
  if (!snap || typeof snap !== 'object') return;
  data.set(tabId, snap);
  if (tabId === S.activeId) renderActivity(); // cerrado, por el punto de la pestaña lateral
}

// Se olvida lo de una pestaña cerrada (aquí y en el proceso principal).
export function forgetActivity(tabId) {
  data.delete(tabId);
  api.activityForget(tabId);
}

const take = (r) => { if (r && typeof r === 'object') { enabled = Boolean(r.enabled); open = Boolean(r.open); } };

// La pestaña lateral: la columna, a la vista u oculta (Haiku sigue contando).
export async function toggleActivity(force) {
  const want = typeof force === 'boolean' ? force : !open;
  try { take(await api.activitySetOpen(want)); } catch { open = want; }
  renderActivity();
}

// La rueda de opciones: activar o desactivar la actividad.
async function switchActivity() {
  try { take(await api.activitySetEnabled(!enabled)); } catch { return; }
  if (enabled && S.activeId) {
    // Lo que haya pasado mientras estaba desactivada (con sus palabras fijas).
    try { setActivity(S.activeId, await api.activityGet(S.activeId)); } catch { /* llegará con el próximo paso */ }
  }
  renderActivity();
  toast(enabled
    ? 'Actividad activada: Haiku te cuenta lo que hace Claude. La pestaña lateral muestra u oculta la columna.'
    : 'Actividad desactivada: Haiku deja de contar y no gasta nada.');
  focusAfterToggle($('#activity-btn'));
}

export function wireActivity() {
  $('#act-toggle').addEventListener('click', () => { toggleActivity(); });
  $('#activity-btn').addEventListener('click', () => { switchActivity(); });
  api.onActivity(setActivity);
  api.activityGet().then((r) => { take(r); renderActivity(); }).catch(() => { /* sin actividad */ });
  // El «desde hace…» de la línea de ahora.
  setInterval(() => {
    if (!enabled || !open || !S.activeId) return;
    const snap = data.get(S.activeId);
    if (snap && snap.now) $('#act-now-time').textContent = since(snap.now.since);
  }, 1000);
}
