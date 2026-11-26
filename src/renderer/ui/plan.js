// ── Plan de la tarea, al pie del panel «Actividad» ───────────────
// Los pasos que Claude apunta en su lista de tareas (src/main/plan.js), con su estado:
// Terminado, Trabajando o Pendiente. Ocupa el cuarto de abajo de la columna; el paso en curso
// siempre a la vista. Con todo terminado se pliega a su cabecera (pulsándola se despliega).
import { api, $, el } from './dom.js';

const plans = new Map(); // id de pestaña → { steps, done, total } o null
const asked = new Set(); // pestañas cuyo plan ya se ha pedido al proceso principal
const folded = new Map(); // id de pestaña → plegado a mano (si no, plegado solo al terminar)
let shown = null; // la pestaña cuyo plan se ve
let onChange = () => {};

const LABEL = { done: 'Terminado', work: 'Trabajando', todo: 'Pendiente' };
const CHECK = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/></svg>';
const finished = (plan) => Boolean(plan && plan.total && plan.done === plan.total);

function step(s, n) {
  const li = el('li', 'plan-step');
  li.dataset.s = s.status;
  const dot = el('span', 'plan-dot');
  if (s.status === 'done') dot.innerHTML = CHECK;
  const text = el('span', 'plan-text', s.text);
  text.title = s.text;
  li.append(el('span', 'plan-n', String(n + 1)), dot, text, el('span', 'plan-st', LABEL[s.status] || LABEL.todo));
  return li;
}

// Pinta el plan de la pestaña (o lo esconde si no tiene).
export function renderPlan(tabId) {
  const box = $('#act-plan');
  if (tabId && !plans.has(tabId) && !asked.has(tabId)) {
    asked.add(tabId);
    api.planGet(tabId).then((plan) => {
      if (plans.has(tabId)) return; // ya llegó uno más nuevo
      plans.set(tabId, plan || null);
      if (tabId === shown) renderPlan(tabId);
    }).catch(() => { /* llegará con el próximo cambio */ });
  }
  const plan = tabId ? plans.get(tabId) : null;
  const changedTab = shown !== tabId;
  shown = tabId;
  box.hidden = !plan;
  if (!plan) return;
  const done = finished(plan);
  const fold = folded.has(tabId) ? folded.get(tabId) : done;
  box.classList.toggle('folded', fold);
  box.classList.toggle('finished', done);
  $('#plan-head').setAttribute('aria-expanded', String(!fold));
  $('#plan-head').title = fold ? 'Ver los pasos del plan' : 'Plegar el plan';
  $('#plan-count').textContent = done ? `Terminado · ${plan.total} de ${plan.total}` : `${plan.done} de ${plan.total} terminados`;
  $('#plan-fill').style.width = `${Math.round((plan.done / plan.total) * 100)}%`;
  const list = $('#plan-list');
  list.replaceChildren(...plan.steps.map(step));
  // El paso en curso, a la vista (sin mover nada más que la lista del plan).
  const work = list.querySelector('[data-s="work"]') || (changedTab ? null : list.querySelector('[data-s="todo"]'));
  if (work && !fold) {
    const top = work.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + work.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2 + work.offsetHeight / 2);
    }
  }
}

export function setPlan(tabId, plan) {
  const before = plans.get(tabId);
  plans.set(tabId, plan && Array.isArray(plan.steps) && plan.steps.length ? plan : null);
  // Al empezar o terminar un plan, vuelve a lo de siempre: desplegado mientras se trabaja,
  // plegado al terminar.
  if (finished(before) !== finished(plans.get(tabId)) || !before) folded.delete(tabId);
  onChange(tabId);
}

export function forgetPlan(tabId) {
  plans.delete(tabId);
  asked.delete(tabId);
  folded.delete(tabId);
}

// changed(tabId): repintar si es la pestaña que se ve (activity.js).
export function wirePlan(changed) {
  onChange = changed;
  api.onPlan(setPlan);
  $('#plan-head').addEventListener('click', () => {
    if (!shown || !plans.get(shown)) return;
    const now = $('#act-plan').classList.contains('folded');
    folded.set(shown, !now);
    renderPlan(shown);
  });
}
