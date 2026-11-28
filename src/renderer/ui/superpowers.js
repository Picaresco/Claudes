// ── SuperPowers por pestaña ──────────────────────────────────────
// El botón «SuperPowers» de la barra de la sesión. Apagado, al pulsarlo explica qué hace y lo
// que cuesta, con «Activar»; encendido, su borde lleva los colores de SuperPowers (gira mientras
// Claude trabaja) y la pestaña, un rayo. Encender o apagar reinicia la sesión de esa pestaña y
// sigue con la misma conversación (si Claude está trabajando, al terminar): esfuerzo alto, sus
// habilidades y el límite de agentes se ponen al arrancar (src/main/main.js, createPty). Lo
// demás (la pasada final, el aviso de cómo trabajar) lo hace src/main/superpowers.js.
import { $, api } from './dom.js';
import { BUSY } from './model.js';
import { renderTabs, renderToolbar } from './render.js';
import { forgetIdea } from './ideas.js';
import { restartSession } from './sessions.js';
import { S, views, byId, save, toast } from './state.js';

// Trabajando de verdad (el borde gira): no al esperar al usuario ni al arrancar.
const WORKING = new Set(['working', 'reviewing', 'planreview', 'consulting']);
export const BOLT = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z" fill="currentColor"/></svg>';

// El botón de la pestaña activa: encendido o no, y si gira.
export function renderPowerButton() {
  const button = $('#btn-superpowers');
  const tab = byId(S.activeId);
  if (!button || !tab) return;
  const on = tab.superpowers === true;
  const view = views.get(tab.id);
  button.dataset.on = String(on);
  button.dataset.working = String(Boolean(on && view && WORKING.has(view.status)));
  button.setAttribute('aria-expanded', String(!$('#sp-pop').hidden));
  button.title = on
    ? 'SuperPowers activado en esta pestaña: Claude trabaja más a fondo y no da nada por terminado sin comprobarlo. Pulsa para ver qué hace o desactivarlo.'
    : 'SuperPowers: Claude trabaja más a fondo y lo comprueba todo antes de terminar (gasta más y tarda más). Pulsa para ver qué hace.';
}

// La ventanita, debajo del botón (sin salirse de la ventana).
function place() {
  const pop = $('#sp-pop');
  const at = $('#btn-superpowers').getBoundingClientRect();
  const width = pop.offsetWidth;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${at.bottom + 10}px`;
  pop.style.setProperty('--sp-arrow', `${Math.max(16, Math.min(width - 28, at.left + at.width / 2 - left - 6))}px`);
}

function fill(tab) {
  const on = tab.superpowers === true;
  $('#sp-pop').dataset.on = String(on);
  $('#sp-pop-state').textContent = on ? `Activado en «${tab.name}».` : `En «${tab.name}», solo si lo activas.`;
  const go = $('#sp-pop-go');
  go.textContent = on ? 'Desactivar' : 'Activar';
  go.dataset.on = String(on);
}

export function openPowerPop() {
  const tab = byId(S.activeId);
  if (!tab) return;
  fill(tab);
  const pop = $('#sp-pop');
  pop.hidden = false;
  place();
  renderPowerButton();
  $('#sp-pop-go').focus();
}

export function closePowerPop({ focus = false } = {}) {
  const pop = $('#sp-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  renderPowerButton();
  if (focus) $('#btn-superpowers').focus();
}

// Enciende o apaga SuperPowers en una pestaña: se aplica al reiniciar su sesión (la misma conversación).
export function setSuperpowers(tabId, on) {
  const tab = byId(tabId);
  if (!tab || (tab.superpowers === true) === on) return;
  tab.superpowers = on;
  save();
  api.log(`SuperPowers ${on ? 'activado' : 'desactivado'} en «${tab.name}»`);
  if (!on) forgetIdea(tabId);
  renderTabs();
  renderToolbar();
  const what = on ? 'SuperPowers activado' : 'SuperPowers desactivado';
  const view = views.get(tabId);
  if (!view || !view.started || view.exited) { toast(`«${tab.name}»: ${what}. Se aplica al abrir la sesión.`); return; }
  if (BUSY.includes(view.status)) {
    view.pendingModel = true; // el mismo reinicio que el modelo de la pestaña (ui/model.js)
    toast(`«${tab.name}»: ${what}. Se aplica cuando Claude termine lo que está haciendo, y sigue con la misma conversación.`);
    return;
  }
  toast(`«${tab.name}»: ${what}. La sesión se reinicia y sigue con la misma conversación.`);
  view.pendingModel = false;
  restartSession(view);
}

export function wireSuperpowers() {
  const button = $('#btn-superpowers');
  const pop = $('#sp-pop');
  button.addEventListener('click', () => (pop.hidden ? openPowerPop() : closePowerPop()));
  $('#sp-pop-go').addEventListener('click', () => {
    const tab = byId(S.activeId);
    closePowerPop({ focus: true });
    if (tab) setSuperpowers(tab.id, tab.superpowers !== true);
  });
  $('#sp-pop-close').addEventListener('click', () => closePowerPop({ focus: true }));
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePowerPop({ focus: true }); }
  });
  // Fuera de la ventanita, se cierra; la ventana cambia de tamaño, se recoloca.
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) closePowerPop();
  });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
}
