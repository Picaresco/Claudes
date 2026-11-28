// ── Tarjeta del proyecto (botón derecho sobre una pestaña) ───────
// Sustituye al menú de antes: quién es (nombre, carpeta, estado, compartir la dirección en
// GitHub), cuánto lleva, el modelo y el esfuerzo, cuándo se compacta la conversación y las
// acciones de siempre (renombrar, color, nueva conversación, carpeta, cerrar).
// El modelo, el esfuerzo y el autocompactar se aplican juntos con «Aplicar» (un solo reinicio,
// ui/model.js). La tarjeta queda fijada a la pestaña pulsada aunque cambie la activa.
import { COLORS, MODELS, EFFORT_LEVELS, STATUS, colorHex } from './constants.js';
import { api, el } from './dom.js';
import { limitsSnap } from './limits.js';
import { applyTabChoices, followsDefault, compactOf, modelName, BUSY, DEFAULT_COMPACT } from './model.js';
import { renderAll } from './render.js';
import { views, byId, save, toast } from './state.js';
import { startRename, closeTab, newConversation } from './tabs.js';
import { focusTerminal } from './views.js';

const MIN = 30;
const MAX = 95;
const PRESETS = [50, 70, DEFAULT_COMPACT, MAX];
let card = null; // { id, node, choice }

const ico = (d, size = 15) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  share: '<circle cx="12" cy="3.5" r="1.8"/><circle cx="4" cy="8" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M5.6 7.1l4.8-2.6M5.6 8.9l4.8 2.6"/>',
  rename: '<path d="M11 2.5 13.5 5 6 12.5 2.8 13.2l.7-3.2z"/>',
  newconv: '<circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/>',
  folder: '<path d="M2 5h5l1.5-2H14v10H2z"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
};
const clampPct = (v) => Math.min(MAX, Math.max(MIN, Math.round(Number(v) || DEFAULT_COMPACT)));
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));

export function closeTabCard() {
  if (!card) return false;
  card.node.remove();
  card = null;
  return true;
}

// El modelo y el esfuerzo con los que está (o estará) la pestaña.
function current(tab, view) {
  const m = (view && view.model) || {};
  return { model: m.id || tab.model || null, effort: m.effort || tab.effort || null };
}

function paint() {
  if (!card) return;
  const { id, node, choice } = card;
  const tab = byId(id);
  const view = views.get(id);
  if (!tab || !view) { closeTabCard(); return; }
  const now = current(tab, view);
  // Modelo
  const list = [...MODELS];
  if (now.model && !list.some((m) => m.id === now.model)) list.push({ id: now.model, name: modelName(now.model) });
  node.querySelector('.tc-models').replaceChildren(...list.map((m) => {
    const b = el('button', 'tc-model');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(choice.model === m.id));
    b.title = m.desc || m.name;
    b.append(el('span', 'tc-model-name', m.name));
    if (now.model === m.id) b.append(el('span', 'tc-now', 'ahora'));
    b.addEventListener('click', () => { choice.model = m.id; paint(); });
    return b;
  }));
  node.querySelector('.tc-efforts').replaceChildren(...EFFORT_LEVELS.map((e) => {
    const b = el('button', 'mm-effort', e.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(choice.effort === e.level));
    b.title = `${e.label[0].toUpperCase()}${e.label.slice(1)}: ${e.desc}`;
    b.addEventListener('click', () => { choice.effort = e.level; paint(); });
    return b;
  }));
  // Autocompactar
  const usage = view.usage && view.usage.pct !== null ? view.usage : null;
  const pct = choice.compact;
  node.querySelector('.tc-ac-value').textContent = `${pct} %`;
  node.querySelector('.tc-used').style.width = `${usage ? Math.min(100, usage.pct) : 0}%`;
  node.querySelector('.tc-zone').style.left = `${pct}%`;
  const range = node.querySelector('.tc-range');
  if (Number(range.value) !== pct) range.value = String(pct);
  range.setAttribute('aria-valuetext', `${pct} %`);
  node.querySelector('.tc-legend-now').textContent = usage ? `Ahora al ${usage.pct} %` : 'Aún sin medir';
  node.querySelector('.tc-legend-at').textContent = `Se resume sola al ${pct} %`;
  for (const b of node.querySelectorAll('.tc-preset')) b.classList.toggle('on', Number(b.dataset.v) === pct);
  node.querySelector('.tc-reset').hidden = pct === DEFAULT_COMPACT;
  // ¿Hay algo que aplicar?
  const modelChanged = choice.model !== now.model || choice.effort !== now.effort || choice.saveDefault !== followsDefault(tab);
  const applied = view.started && !view.exited ? view.compactApplied : null;
  const compactChanged = pct !== compactOf(tab) || (applied !== null && applied !== pct);
  const bar = node.querySelector('.tc-apply');
  bar.hidden = !modelChanged && !compactChanged;
  const running = view.started && !view.exited;
  node.querySelector('.tc-apply-text').textContent = !running
    ? 'Se usará al abrir la pestaña.'
    : BUSY.includes(view.status) ? 'Se aplicará cuando Claude termine.' : 'Se reinicia y sigue con la misma conversación.';
  card.changed = { model: modelChanged, compact: compactChanged };
}

function build(id) {
  const tab = byId(id);
  const view = views.get(id);
  const st = STATUS[view ? view.status : 'asleep'] || STATUS.asleep;
  const hex = colorHex(tab.color) || '#8B929D';
  const node = el('div', 'tc');
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', `Proyecto «${tab.name}»`);
  node.style.setProperty('--c', hex);
  const usage = view && view.usage && view.usage.pct !== null ? view.usage : null;
  const spent = limitsSnap.conversations[id];
  node.innerHTML = `
    <div class="tc-head">
      <div class="tc-sw" aria-hidden="true"></div>
      <div class="tc-id"><div class="tc-name"></div><div class="tc-path"></div></div>
      <span class="tc-state"></span>
      <button class="tc-share" type="button" disabled aria-label="Copiar la dirección del proyecto en GitHub">${ico(ICON.share)}</button>
    </div>
    <div class="tc-stats">
      <div class="tc-stat"><small>Conversación</small><span class="tc-conv"></span></div>
      <div class="tc-stat"><small>Gastado en ella</small><span class="tc-spent"></span></div>
    </div>
    <div class="tc-sec tc-power" hidden></div>
    <div class="tc-sec">
      <h4>Modelo</h4>
      <div class="tc-models" role="radiogroup" aria-label="Modelo"></div>
      <h4>Esfuerzo</h4>
      <div class="mm-seg tc-efforts" role="radiogroup" aria-label="Esfuerzo"></div>
      <p class="tc-note tc-power-effort" hidden>Con SuperPowers trabaja como mínimo con esfuerzo alto, elijas el que elijas.</p>
      <label class="mm-check"><input class="tc-default" type="checkbox"> <span>Usar también en las sesiones nuevas (lo guarda como tu configuración de Claude Code)</span></label>
    </div>
    <div class="tc-sec">
      <div class="tc-ac-top"><h4>Autocompactar</h4><b class="tc-ac-value"></b></div>
      <div class="tc-track">
        <div class="tc-rail"><i class="tc-used"></i><i class="tc-zone"></i></div>
        <span class="tc-dflt" style="left:${DEFAULT_COMPACT}%" title="${DEFAULT_COMPACT} %, el de todos los proyectos"></span>
        <input class="tc-range" type="range" min="0" max="100" step="1" aria-label="Autocompactar al llegar a este porcentaje de la conversación">
      </div>
      <div class="tc-legend"><span class="tc-legend-now"></span><span class="tc-legend-at"></span></div>
      <div class="tc-presets">${PRESETS.map((v) => `<button type="button" class="tc-preset" data-v="${v}">${v} %${v === DEFAULT_COMPACT ? '<small> · siempre</small>' : ''}</button>`).join('')}</div>
      <p class="tc-note">Al llegar ahí, Claude resume la conversación y sigue. Más bajo gasta menos de tu límite semanal (cada mensaje lleva menos historia); más alto, recuerda más detalle. Solo esta pestaña.</p>
      <button class="tc-reset" type="button">Volver al ${DEFAULT_COMPACT} % (el de todos los proyectos)</button>
    </div>
    <div class="tc-apply" hidden><span class="tc-apply-text"></span><button class="btn btn-primary tc-apply-btn" type="button">Aplicar</button></div>
    <div class="tc-acts">
      <button class="tc-row" data-act="rename" type="button">${ico(ICON.rename)}Cambiar nombre<kbd>F2</kbd></button>
      <button class="tc-row" data-act="newconv" type="button">${ico(ICON.newconv)}Nueva conversación</button>
      <button class="tc-row" data-act="folder" type="button">${ico(ICON.folder)}Abrir la carpeta en el Explorador</button>
      <div class="tc-colors" role="radiogroup" aria-label="Color de la pestaña"><span>Color</span></div>
      <div class="tc-sep"></div>
      <button class="tc-row danger" data-act="close" type="button">${ico(ICON.close)}Cerrar la pestaña<kbd>Ctrl+Mayús+W</kbd></button>
    </div>`;
  node.querySelector('.tc-sw').textContent = (tab.name.trim()[0] || '?').toUpperCase();
  node.querySelector('.tc-name').textContent = tab.name;
  const where = node.querySelector('.tc-path');
  where.textContent = tab.cwd;
  where.title = tab.cwd;
  const state = node.querySelector('.tc-state');
  state.textContent = st.label.split(',')[0];
  state.title = st.label;
  if (st.tone) state.dataset.tone = st.tone;
  else if (view && ['working', 'reviewing', 'planreview', 'consulting'].includes(view.status)) state.dataset.tone = 'work';
  node.querySelector('.tc-conv').textContent = usage ? `${usage.pct} %${usage.used !== null && usage.used !== undefined ? ` · ${tokens(usage.used)}` : ''}` : '—';
  node.querySelector('.tc-spent').textContent = spent && spent.total ? `${tokens(spent.total)} tokens` : '—';
  const colors = node.querySelector('.tc-colors');
  for (const c of COLORS) {
    const b = el('button', 'tc-color');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String((tab.color || '') === c.key));
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    if (c.hex) b.style.background = c.hex;
    else b.classList.add('none');
    b.addEventListener('click', () => {
      tab.color = c.key;
      renderAll();
      save();
      node.style.setProperty('--c', c.hex || '#8B929D');
      for (const other of colors.querySelectorAll('.tc-color')) other.setAttribute('aria-checked', String(other === b));
    });
    colors.append(b);
  }
  return node;
}

// La sección «SuperPowers en este proyecto»: tareas con y sin, lo que tardan, lo que corrige la
// pasada final, las pruebas en verde y lo que encuentra Codex. Las comparaciones, solo con al
// menos 3 tareas de cada lado (con menos no dicen nada).
const pct = (a, b) => `${b ? Math.round((a / b) * 100) : 0}${String.fromCharCode(0xa0)}%`; // «63 %» sin partirse
const mins = (m) => (m < 1 ? `${Math.max(1, Math.round(m * 60))} s` : `${String(m).replace('.', ',')} min`);
function fillPower(box, s) {
  box.replaceChildren();
  const head = el('h4', 'tc-power-h');
  head.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z" fill="currentColor"/></svg>';
  head.append('SuperPowers en este proyecto');
  const sides = el('div', 'tc-power-sides');
  const side = (label, x, cls) => {
    const d = el('div', `tc-power-side ${cls}`);
    d.append(el('small', '', label), el('b', '', x.turns === 1 ? '1 tarea' : `${x.turns} tareas`), el('span', '', x.turns ? `${mins(x.minutes)} de media` : '—'));
    return d;
  };
  sides.append(side('Con SuperPowers', s.with, 'on'), side('Sin', s.without, 'off'));
  const lines = el('ul', 'tc-power-lines');
  const line = (text) => lines.append(el('li', '', text));
  line(`La pasada final corrigió algo en ${s.with.fixed} de ${s.with.turns} (${pct(s.with.fixed, s.with.turns)}).`);
  if (s.with.tested) {
    const both = s.without.tested >= 3 && s.with.tested >= 3;
    line(`Pruebas en verde al terminar: ${pct(s.with.green, s.with.tested)}${both ? ` con SuperPowers y ${pct(s.without.green, s.without.tested)} sin` : ''}.`);
  }
  if (s.codex) line(`Codex encontró ${s.codex === 1 ? 'un posible problema' : `${s.codex} posibles problemas`} al revisar.`);
  box.append(head, sides, lines, el('p', 'tc-note', 'Solo cuenta las tareas que cambian algo. Lo mide ClaudHome con lo que ve (pruebas, cambios, revisiones), no con lo que dice Claude.'));
  box.hidden = false;
}

function act(what) {
  const id = card && card.id;
  const tab = byId(id);
  if (!tab) return;
  closeTabCard();
  if (what === 'rename') startRename(id);
  else if (what === 'newconv') newConversation(id);
  else if (what === 'folder') api.openPath(tab.cwd);
  else if (what === 'close') closeTab(id);
}

// Abre la tarjeta de la pestaña `id` junto al punto (x, y) donde se pulsó.
export function openTabCard(id, x, y) {
  closeTabCard();
  const tab = byId(id);
  const view = views.get(id);
  if (!tab || !view) return;
  const now = current(tab, view);
  const choice = {
    model: now.model || MODELS[0].id,
    effort: now.effort || 'high',
    saveDefault: followsDefault(tab),
    compact: compactOf(tab),
  };
  const node = build(id);
  card = { id, node, choice, changed: { model: false, compact: false } };
  document.body.append(node);
  // Sitio: bajo el punto pulsado, sin salirse de la ventana (si no cabe, con su propio desplazamiento).
  const strip = document.querySelector(`#tabs .tab[data-id="${id}"]`);
  const top = strip ? strip.getBoundingClientRect().bottom + 4 : y + 8;
  node.style.top = `${Math.round(top)}px`;
  node.style.maxHeight = `${Math.round(window.innerHeight - top - 12)}px`;
  const width = node.offsetWidth;
  node.style.left = `${Math.round(Math.max(8, Math.min(x - 40, window.innerWidth - width - 8)))}px`;

  node.querySelector('.tc-default').checked = choice.saveDefault;
  node.querySelector('.tc-default').addEventListener('change', (e) => { choice.saveDefault = e.target.checked; paint(); });
  const range = node.querySelector('.tc-range');
  range.addEventListener('input', () => { choice.compact = clampPct(range.value); paint(); });
  for (const b of node.querySelectorAll('.tc-preset')) b.addEventListener('click', () => { choice.compact = Number(b.dataset.v); paint(); });
  node.querySelector('.tc-reset').addEventListener('click', () => { choice.compact = DEFAULT_COMPACT; paint(); });
  node.querySelector('.tc-apply-btn').addEventListener('click', () => {
    const picked = { ...choice };
    const changed = { ...card.changed };
    closeTabCard();
    applyTabChoices(id, picked, changed).catch((err) => api.log(`tarjeta: ${err.message}`));
  });
  for (const b of node.querySelectorAll('.tc-row[data-act]')) b.addEventListener('click', () => act(b.dataset.act));
  node.querySelector('.tc-power-effort').hidden = tab.superpowers !== true;
  // Lo que ha aportado SuperPowers en este proyecto (si se ha usado).
  api.powerStats(id).then((stats) => {
    if (!card || card.id !== id || !stats) return;
    fillPower(node.querySelector('.tc-power'), stats);
  }).catch(() => { /* sin datos */ });
  // La dirección en GitHub la sabe el proceso principal (git).
  const share = node.querySelector('.tc-share');
  share.title = 'Buscando la dirección del proyecto en GitHub…';
  api.tabRepo(id, tab.cwd).then((url) => {
    if (!card || card.id !== id) return;
    if (!url) { share.title = 'Este proyecto no está en GitHub (su carpeta no tiene un remoto de github.com).'; return; }
    share.disabled = false;
    share.title = `Copiar la dirección del proyecto en GitHub para compartirla:\n${url}`;
    share.onclick = () => { api.clipboardWrite(url); toast(`Dirección del proyecto copiada: ${url}`); };
  }).catch(() => { share.title = 'No se ha podido mirar si el proyecto está en GitHub.'; });
  paint();
  const selected = node.querySelector('.tc-models [aria-checked="true"]');
  if (selected) selected.focus();
}

export function wireTabCard() {
  document.addEventListener('mousedown', (e) => { if (card && !card.node.contains(e.target)) closeTabCard(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeTabCard()) { focusTerminal(); e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('resize', () => closeTabCard());
  // Si la pestaña se cierra o cambia mucho mientras está abierta, se repinta o se cierra sola.
  setInterval(() => { if (card && !byId(card.id)) closeTabCard(); }, 1000);
}
