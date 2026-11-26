// ── Modelo, esfuerzo y autocompactar de una pestaña ──────────────
// Se eligen en la tarjeta del proyecto (botón derecho sobre la pestaña, ui/tabcard.js); la barra
// inferior solo enseña el modelo y el esfuerzo de la pestaña activa.
// Sin la casilla, el modelo y el esfuerzo solo cambian esa pestaña: ClaudHome reinicia su sesión
// con --model y --effort y retoma la misma conversación (y lo recuerda para las próximas veces).
// Con la casilla, además se guardan como predeterminados de Claude Code para las sesiones nuevas
// (~/.claude/settings.json, como hace /model), y la pestaña sigue ese predeterminado.
// El autocompactar (85 % de serie) también se aplica al arrancar Claude: va en el mismo reinicio.
// Si Claude está trabajando, se aplica cuando termine.
import { MODELS, EFFORT_LEVELS } from './constants.js';
import { api } from './dom.js';
import { restartSession } from './sessions.js';
import { views, byId, save, toast } from './state.js';

export const BUSY = ['working', 'reviewing', 'planreview', 'consulting', 'needs', 'starting'];
export const DEFAULT_COMPACT = 85; // el de todos los proyectos (src/main/project-card.js)

export const modelName = (id) => (MODELS.find((m) => m.id === id) || { name: id }).name;
export const effortName = (level) => (EFFORT_LEVELS.find((e) => e.level === level) || { label: level }).label;
// ¿La pestaña sigue el predeterminado que se guardó desde la tarjeta? (la casilla, marcada)
export const followsDefault = (tab) => Boolean(tab && tab.modelDefault && !tab.model && !tab.effort);
export const compactOf = (tab) => (tab && Number.isFinite(tab.compact) ? tab.compact : DEFAULT_COMPACT);

// Reinicia la sesión de la pestaña con lo elegido (retoma su conversación).
function restartWith(view) {
  view.pendingModel = false;
  restartSession(view);
}

// Al terminar el turno (session-events.js): si había un cambio esperando, se aplica ahora.
export function applyPendingModel(view) {
  if (view && view.pendingModel && views.has(view.tab.id)) restartWith(view);
}

// Aplica a la pestaña lo elegido en su tarjeta. `picked`: { model, effort, saveDefault, compact };
// `changed`: { model, compact } (qué ha cambiado de verdad). Un solo reinicio para todo.
export async function applyTabChoices(tabId, picked, changed) {
  const tab = byId(tabId);
  const view = views.get(tabId);
  if (!tab || !view) return;
  const what = [];
  if (changed.model) {
    if (picked.saveDefault) {
      const res = await api.modelSaveDefault({ model: picked.model, effort: picked.effort });
      if (!res || !res.ok) { toast(`No se ha podido guardar como predeterminado: ${(res && res.error) || 'error desconocido'}.`); return; }
      // La pestaña sigue el predeterminado (ya es lo elegido), y la casilla se queda marcada.
      tab.model = null;
      tab.effort = null;
      tab.modelDefault = true;
    } else {
      tab.model = picked.model;
      tab.effort = picked.effort;
      tab.modelDefault = false;
    }
    what.push(`${modelName(picked.model)} con esfuerzo ${effortName(picked.effort)}`);
  }
  if (changed.compact) {
    tab.compact = picked.compact === DEFAULT_COMPACT ? null : picked.compact;
    what.push(`autocompactar al ${picked.compact} %`);
  }
  save();
  if (!what.length) return;
  const text = what.join(' y ');
  if (!view.started || view.exited) { toast(`«${tab.name}» usará ${text} al abrirse.`); return; }
  if (BUSY.includes(view.status)) {
    view.pendingModel = true;
    toast(`«${tab.name}» pasará a ${text} cuando Claude termine lo que está haciendo.`);
    return;
  }
  toast(`«${tab.name}» pasa a ${text}: se reinicia y sigue con la misma conversación.${changed.model && picked.saveDefault ? ' El modelo también queda como predeterminado para las sesiones nuevas.' : ''}`);
  restartWith(view);
}
