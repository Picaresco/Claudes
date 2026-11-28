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
import { restartSession, wantGit, gitNotice } from './sessions.js';
import { codexReady, codexUsable, ignite, stopIgnite } from './sp-ignite.js';
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
  // Al máximo: con Codex listo para revisar lo que hace Claude (el botón lleva brasas verdes). Sin
  // git en la carpeta, Codex no revisa: no está al máximo (gitRepo null = aún no se sabe).
  const noGit = Boolean(view && view.gitRepo === false);
  const max = on && codexReady() && !noGit;
  button.dataset.on = String(on);
  button.dataset.max = String(max);
  if (!on) stopIgnite();
  button.dataset.working = String(Boolean(on && view && WORKING.has(view.status)));
  button.setAttribute('aria-expanded', String(!$('#sp-pop').hidden));
  if (!$('#sp-pop').hidden) fillGit(tab); // con la ventanita abierta, «Crear git aquí» sigue al estado de Claude
  button.title = max
    ? 'SuperPowers al máximo en esta pestaña, con Codex: Claude trabaja más a fondo, no da nada por terminado sin comprobarlo y Codex revisa lo que hace. Pulsa para ver qué hace o desactivarlo.'
    : on
      ? `SuperPowers activado en esta pestaña: Claude trabaja más a fondo y no da nada por terminado sin comprobarlo.${codexUsable() && noGit ? ' Codex no revisa aquí porque la carpeta no tiene git: pulsa para crearlo.' : ' Pulsa para ver qué hace o desactivarlo.'}`
      : 'SuperPowers: Claude trabaja más a fondo y lo comprueba todo antes de terminar (gasta más y tarda más). Pulsa para ver qué hace.';
}

// La ventanita, debajo del botón (sin salirse de la ventana). Si no cabe por abajo (una ventana
// baja), la lista de lo que hace se recoge y se desplaza: el aviso y los botones, siempre a la vista.
function place() {
  const pop = $('#sp-pop');
  const list = pop.querySelector('.sp-pop-list');
  list.style.maxHeight = '';
  const at = $('#btn-superpowers').getBoundingClientRect();
  const width = pop.offsetWidth;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${at.bottom + 10}px`;
  pop.style.setProperty('--sp-arrow', `${Math.max(16, Math.min(width - 28, at.left + at.width / 2 - left - 6))}px`);
  const over = pop.getBoundingClientRect().bottom - (window.innerHeight - 8);
  if (over > 0) list.style.maxHeight = `${Math.max(72, list.offsetHeight - over)}px`;
}

// «Crear git aquí»: con SuperPowers y Codex, en una sesión abierta cuya carpeta no tiene git (p. ej.
// una pestaña que se abrió ya encendida: el git solo se crea solo al encenderlo con el botón).
let gitBusy = false;
function fillGit(tab) {
  const view = views.get(tab.id);
  const show = tab.superpowers === true && codexUsable() && Boolean(view && view.started && !view.exited && view.gitRepo === false);
  $('#sp-pop-git').hidden = !show;
  if (!show) return;
  const working = BUSY.includes(view.status);
  $('#sp-pop-git-why').textContent = [
    working ? 'Se podrá cuando Claude termine: si no, la foto se llevaría sus cambios a medias.' : '',
    view.gitReason ? `La última vez no se creó: ${view.gitReason}.` : '',
  ].filter(Boolean).join(' ');
  const go = $('#sp-pop-git-go');
  go.disabled = gitBusy || working;
  go.textContent = gitBusy ? 'Creando…' : 'Crear git aquí';
  go.title = working ? 'Cuando Claude termine: si no, la foto de partida se llevaría sus cambios a medias y Codex no los vería.' : '';
  if (!$('#sp-pop').hidden) place(); // el aviso puede cambiar de alto
}

async function createGitHere() {
  const tab = byId(S.activeId);
  const view = tab && views.get(tab.id);
  if (!view || gitBusy || BUSY.includes(view.status)) return;
  gitBusy = true;
  fillGit(tab);
  let res;
  try { res = await api.powerGit(tab.id); } catch { res = { state: 'failed', reason: 'no se ha podido preguntar a la app' }; }
  gitBusy = false;
  if (!res) res = { state: 'failed', reason: 'sin respuesta' };
  view.gitRepo = res.repo === true;
  view.gitReason = view.gitRepo ? '' : res.reason || '';
  gitNotice(tab, res);
  renderToolbar();
  if (view.gitRepo && byId(S.activeId) === tab) {
    closePowerPop({ focus: true });
    ignite(); // ya al máximo: el gas verde de Codex y, después, las brasas
  } else if (!$('#sp-pop').hidden) fillGit(tab);
}

function fill(tab) {
  fillGit(tab);
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
  // Con Codex (aunque ahora tenga el límite agotado): git local si la carpeta no tiene, al reiniciar.
  wantGit(tabId, on && codexUsable());
  renderTabs();
  renderToolbar();
  // Con Codex, de sus letras sale el gas verde que enciende el botón (ui/sp-ignite.js).
  if (on && tabId === S.activeId) ignite();
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
  $('#sp-pop-git-go').addEventListener('click', createGitHere);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePowerPop({ focus: true }); }
  });
  // Fuera de la ventanita, se cierra; la ventana cambia de tamaño, se recoloca.
  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) closePowerPop();
  });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
}
