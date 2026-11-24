// ── Modelo y esfuerzo de una pestaña (barra inferior) ────────────
// Pulsar «Opus 5.5 · esfuerzo muy alto» abre un panel para elegir el modelo y el esfuerzo.
// Sin la casilla, solo cambia esta pestaña: ClaudHome reinicia su sesión con --model y
// --effort y retoma la misma conversación (y lo recuerda para las próximas veces). Con la
// casilla, además se guarda como predeterminado de Claude Code para las sesiones nuevas
// (~/.claude/settings.json, como hace /model), y la pestaña sigue ese predeterminado.
// Si Claude está trabajando, se aplica cuando termine.
import { MODELS, EFFORT_LEVELS } from './constants.js';
import { api, $, el } from './dom.js';
import { restartSession } from './sessions.js';
import { S, views, byId, save, toast } from './state.js';
import { focusTerminal } from './views.js';

const BUSY = ['working', 'reviewing', 'planreview', 'consulting', 'needs', 'starting'];
let choice = null; // { model, effort } mientras el panel está abierto

const activeView = () => views.get(S.activeId);

function paint() {
  const view = activeView();
  if (!view || !choice) return;
  const current = view.model || {};
  $('#model-tab').textContent = `Para la pestaña «${view.tab.name}»`;
  const list = MODELS.slice();
  // El de la sesión, aunque no esté en la lista (otro modelo o una versión anterior).
  if (current.id && !list.some((m) => m.id === current.id)) list.push({ id: current.id, name: current.name || current.id, desc: 'El que usa ahora esta sesión' });
  $('#model-list').replaceChildren(...list.map((m) => {
    const row = el('button', 'mm-opt');
    row.type = 'button';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(choice.model === m.id));
    row.append(el('span', 'mm-radio'));
    const label = el('span', 'mm-label');
    label.append(el('span', 'mm-name', m.name), el('span', 'mm-desc', m.desc));
    row.append(label);
    row.append(current.id === m.id ? el('span', 'mm-now', 'ahora') : el('span'));
    row.addEventListener('click', () => { choice.model = m.id; paint(); });
    return row;
  }));
  $('#model-efforts').replaceChildren(...EFFORT_LEVELS.map((e) => {
    const b = el('button', 'mm-effort', e.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(choice.effort === e.level));
    b.addEventListener('click', () => { choice.effort = e.level; paint(); });
    return b;
  }));
  const effort = EFFORT_LEVELS.find((e) => e.level === choice.effort);
  $('#model-hint').textContent = effort ? `${effort.label[0].toUpperCase()}${effort.label.slice(1)}: ${effort.desc}` : '';
  const same = choice.model === current.id && choice.effort === current.effort && !$('#model-default').checked;
  $('#model-apply').disabled = same;
}

function openMenu() {
  const view = activeView();
  if (!view) return;
  const current = view.model || {};
  choice = { model: current.id || MODELS[0].id, effort: current.effort || 'high' };
  $('#model-default').checked = false;
  $('#model-menu').hidden = false;
  $('#sb-model').setAttribute('aria-expanded', 'true');
  paint();
  const selected = $('#model-list [aria-checked="true"]');
  if (selected) selected.focus();
}

export function closeModelMenu() {
  if ($('#model-menu').hidden) return false;
  $('#model-menu').hidden = true;
  $('#sb-model').setAttribute('aria-expanded', 'false');
  choice = null;
  return true;
}

// Reinicia la sesión de la pestaña con lo elegido (retoma su conversación).
function restartWith(view) {
  view.pendingModel = false;
  restartSession(view);
}

// Al terminar el turno (session-events.js): si había un cambio esperando, se aplica ahora.
export function applyPendingModel(view) {
  if (view && view.pendingModel && views.has(view.tab.id)) restartWith(view);
}

async function apply() {
  const view = activeView();
  if (!view || !choice) return;
  const tab = byId(view.tab.id);
  const picked = { ...choice };
  const saveDefault = $('#model-default').checked;
  closeModelMenu();
  const name = (MODELS.find((m) => m.id === picked.model) || { name: picked.model }).name;
  const effort = (EFFORT_LEVELS.find((e) => e.level === picked.effort) || { label: picked.effort }).label;
  if (saveDefault) {
    const res = await api.modelSaveDefault(picked);
    if (!res || !res.ok) { toast(`No se ha podido guardar como predeterminado: ${(res && res.error) || 'error desconocido'}.`); return; }
    // La pestaña sigue el predeterminado (ya es lo elegido).
    tab.model = null;
    tab.effort = null;
  } else {
    tab.model = picked.model;
    tab.effort = picked.effort;
  }
  save();
  const what = `${name} con esfuerzo ${effort}`;
  if (!view.started || view.exited) { toast(`«${tab.name}» usará ${what} al abrirse.`); return; }
  if (BUSY.includes(view.status)) {
    view.pendingModel = true;
    toast(`«${tab.name}» pasará a ${what} cuando Claude termine lo que está haciendo.`);
    return;
  }
  toast(`«${tab.name}» pasa a ${what}: se reinicia y sigue con la misma conversación.${saveDefault ? ' También queda como predeterminado para las sesiones nuevas.' : ''}`);
  restartWith(view);
}

export function wireModel() {
  $('#sb-model').addEventListener('click', () => { if (!closeModelMenu()) openMenu(); else focusTerminal(); });
  $('#model-cancel').addEventListener('click', () => { closeModelMenu(); focusTerminal(); });
  $('#model-apply').addEventListener('click', () => { apply().catch((err) => api.log(`modelo: ${err.message}`)); });
  $('#model-default').addEventListener('change', paint);
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.model-wrap')) closeModelMenu(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeModelMenu()) { focusTerminal(); e.preventDefault(); e.stopPropagation(); }
  }, true);
}
