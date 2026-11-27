// ── Pintado ──────────────────────────────────────────────────────
import { renderActivity } from './activity.js';
import { enterProject } from './workflow.js';
import { codexInfo } from './codex.js';
import { colorHex, SIDES, SVG, STATUS, EFFORT_LEVELS } from './constants.js';
import { contextCount } from './context.js';
import { api, $, el } from './dom.js';
import { limitsSnap, tokensBreakdown, renderPlanLimits, setPieces } from './limits.js';

// El esfuerzo de razonamiento, en palabras de todos los días.
const EFFORTS = Object.fromEntries(EFFORT_LEVELS.map((e) => [e.level, e.label]));
import { logEntriesOf } from './log.js';
import { hidePreview } from './preview.js';
import { acknowledge } from './session-events.js';
import { sleepAfterMs } from './sleep.js';
import {
  S, views, renamingId, draggingId, lastBusy, setLastBusy, panes, byId, clamp, visibleIds,
  applySwatch, swatch, optimizeHints,
} from './state.js';
import { showView, focusTerminal } from './views.js';

function tabElement(tab, shown) {
  const view = views.get(tab.id);
  const st = STATUS[view ? view.status : 'asleep'];
  const node = el('div', 'tab');
  node.dataset.id = tab.id;
  const hex = colorHex(tab.color);
  if (hex) node.style.setProperty('--c', hex);
  node.classList.toggle('shown', shown);
  node.classList.toggle('attn', Boolean(st.tone));

  const main = el('button', 'tab-main');
  main.setAttribute('role', 'tab');
  main.setAttribute('aria-selected', String(tab.id === S.activeId));
  const usage = view && view.usage && view.usage.pct !== null ? view.usage : null;
  main.setAttribute('aria-label', `${tab.name}, ${st.label.toLowerCase()}${usage ? `, conversación al ${usage.pct} %` : ''}`);
  const spent = limitsSnap.conversations[tab.id];
  main.title = `${tab.name} · ${st.label}\n${tab.cwd}${usage ? `\n${usageText(usage)}` : ''}${spent ? `\nTokens usados en esta conversación: ${nf.format(spent.total)} (${tokensBreakdown(spent)}).` : ''}\nBotón derecho: sus opciones (cerrar, cambiar nombre, color…)`;
  main.innerHTML = SVG[st.icon];
  // Los puntos de «te necesita» y «ha terminado» parpadean. La fase sale del reloj
  // para que no vuelva a empezar cada vez que se repintan las pestañas.
  const attnDot = main.querySelector('.dot-attn');
  if (attnDot) attnDot.style.animationDelay = `-${Date.now() % 1200}ms`;
  main.append(el('span', 'tab-name', tab.name));
  // Sin × en la pestaña: se cierra desde sus opciones (botón derecho, ui/tabcard.js), con
  // Ctrl+Mayús+W o con el botón central del ratón.
  node.append(main);
  // Barrita de llenado de la conversación, en la parte de abajo de la pestaña.
  if (usage) {
    const bar = el('span', 'tab-usage');
    bar.dataset.level = usageLevel(usage.pct);
    const fill = el('i');
    fill.style.width = `${clamp(usage.pct, 0, 100)}%`;
    bar.append(fill);
    node.append(bar);
  }
  return node;
}

// Cuánto ocupa la conversación: «bajo» hasta el 60 %, «medio» hasta el 85 %, «alto» después.
export const usageLevel = (pct) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low');
export const nf = new Intl.NumberFormat('es-ES');

function usageText(usage) {
  const tokens = usage.used !== null ? ` (${nf.format(usage.used)} de ${nf.format(usage.size)} tokens)` : '';
  return `Conversación: ${usage.pct} % del contexto${tokens}`;
}

export function renderTabs() {
  if (renamingId || draggingId) return; // al terminar de renombrar o arrastrar se repintan
  const shown = new Set(visibleIds());
  const strip = $('#tabs');
  strip.replaceChildren(...S.tabs.map((tab) => tabElement(tab, shown.has(tab.id))));
  fitStrip();
  const active = S.activeId && strip.querySelector(`.tab[data-id="${S.activeId}"]`);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// La barra superior: las pestañas se estrechan hasta un mínimo; si aun así no caben (por
// ejemplo, al salir «Actualizar»), se compacta lo demás, paso a paso, hasta que quepan:
// 1) «Actualizar a vX» pasa a «Actualizar»; 2) sin el número de versión de la app; 3) pestañas
// más estrechas; 4) «Actualizar» y «Codex», solo con su icono o punto; 5) sin el nombre de la app. Si ni así, la fila de pestañas se desplaza.
const MAX_STRIP = 5;
let lastStrip = '';
export function fitStrip() {
  const strip = $('#strip');
  const tabs = $('#tabs');
  const signature = [strip.clientWidth, tabs.children.length, $('#update-btn').hidden, $('#update-btn').textContent, $('#codex-status').hidden, $('#codex-status').textContent].join('|');
  if (signature === lastStrip) return;
  lastStrip = signature;
  for (let level = 0; level <= MAX_STRIP; level += 1) {
    strip.dataset.compact = String(level);
    if (tabs.scrollWidth <= tabs.clientWidth + 1) break;
  }
}
window.addEventListener('resize', () => fitStrip());
// Lo que cambia de ancho sin que cambien las pestañas: el botón de actualizar y el indicador de Codex.
new ResizeObserver(() => fitStrip()).observe($('#update-btn'));
new ResizeObserver(() => fitStrip()).observe($('#codex-status'));

export function renderToolbar() {
  const tab = byId(S.activeId);
  $('#toolbar').hidden = !tab;
  document.title = tab ? `${tab.name} · ClaudHome` : 'ClaudHome'; // lo que se ve en la barra de tareas
  if (!tab) return;
  applySwatch($('#tb-swatch'), tab.color);
  $('#tb-name').textContent = tab.name;
  $('#tb-path').textContent = tab.cwd;
  $('#tb-path').title = tab.cwd;
  $('#btn-terminal').setAttribute('aria-pressed', String(Boolean(tab.extraOpen)));
  $('#btn-context').setAttribute('aria-pressed', String(Boolean(tab.contextOpen)));
  const logCount = logEntriesOf(tab).length;
  $('#log-badge').hidden = logCount === 0;
  $('#log-badge').textContent = logCount > 999 ? '999+' : String(logCount);
  const ctxCount = contextCount(tab);
  $('#ctx-count').hidden = ctxCount === 0;
  $('#ctx-count').textContent = String(ctxCount);
  const ctxView = views.get(tab.id);
  if (ctxView && ctxView.ctxSub) ctxView.ctxSub.textContent = `Claude lo tiene presente en cada sesión de «${tab.name}»`;
  const activeView = views.get(tab.id);
  $('#tb-codex').hidden = !(activeView && activeView.codex && activeView.started && codexInfo && codexInfo.active);
  // «Optimiza»: solo aparece cuando la app ve que conviene (optimize-hint.js).
  const hint = optimizeHints.get(tab.id);
  const recommended = Boolean(hint && hint.recommended);
  $('#btn-optimize').hidden = !recommended;
  $('#btn-optimize').dataset.recommended = String(recommended);
  $('#opt-badge').hidden = !recommended;
  $('#btn-optimize').title = (recommended ? `Recomendado: ${hint.reasons.join('; ')}.\n\n` : '')
    + 'Optimiza: Claude revisa todo el proyecto y lo mejora sin cambiar lo que hace (limpieza, orden, eficiencia), solo y en una rama aparte de git. Te pide confirmación antes de empezar.';
  $('#btn-swap').hidden = !S.split;
  $('#btn-split-label').textContent = S.split ? 'Cerrar división' : 'Dividir';
  $('#split-line').style.display = S.split ? 'none' : '';
}

export function renderHeads() {
  for (const side of SIDES) {
    const pane = panes[side];
    const view = S.split ? views.get(S.split[side]) : null;
    pane.el.classList.toggle('focused', Boolean(S.split) && S.focusSide === side);
    if (!view) { pane.head.replaceChildren(); continue; }
    const st = STATUS[view.status];
    const status = el('span', 'ph-status');
    if (st.tone) status.dataset.tone = st.tone;
    status.innerHTML = SVG[st.icon];
    status.append(st.label);
    pane.head.replaceChildren(
      swatch(view.tab.color),
      el('span', 'ph-name', view.tab.name),
      el('span', 'ph-path', view.tab.cwd),
      status,
    );
  }
}

// La barra inferior, en una sola línea: si no cabe todo, se compacta por pasos (estilos de
// #statusbar[data-compact]) hasta que cabe: 1 sin la pista de atajos · 2 con las fechas
// abreviadas · 3 (sin uso desde que los tokens solo están en el texto emergente) · 4 sin las fechas · 5 sin el recuento de sesiones ni las
// barritas, y en una línea pase lo que pase: si aun así no cabe, la parte izquierda se
// recorta (su texto entero queda en el texto emergente). Al haber sitio, vuelve a mostrarlo todo.
const ONE_LINE = 40; // px: más alto que esto es que ha saltado a otra línea
const MAX_COMPACT = 5;
let lastFit = '';
export function fitStatusbar() {
  const bar = $('#statusbar');
  // Solo se vuelve a medir si ha cambiado el ancho, el texto o lo que se ve.
  const shown = [...bar.querySelectorAll('.sb-item, .sb-usage, #sb-zoom')].map((node) => (node.hidden ? '0' : '1')).join('');
  const signature = `${bar.clientWidth}|${shown}|${bar.textContent}`;
  if (signature === lastFit) return;
  lastFit = signature;
  let level = 0;
  for (; level <= MAX_COMPACT; level += 1) {
    bar.dataset.compact = String(level);
    if (level === MAX_COMPACT || bar.offsetHeight <= ONE_LINE) break;
  }
  // En el último paso lo que no cabe se recorta: que se pueda leer entero al pasar el ratón.
  const left = bar.querySelector('.sb-left');
  left.title = level === MAX_COMPACT ? [...left.children].filter((node) => !node.hidden).map((node) => node.textContent.trim()).filter(Boolean).join(' · ') : '';
}
window.addEventListener('resize', () => fitStatusbar());

export function renderStatusbar() {
  let working = 0;
  let waiting = 0;
  let attn = 0;
  let done = 0;
  let failed = 0;
  let sleeping = 0;
  for (const view of views.values()) {
    if (['working', 'reviewing', 'planreview', 'consulting', 'closing'].includes(view.status)) working += 1;
    if (view.status === 'needs') { waiting += 1; attn += 1; }
    if (view.status === 'done') done += 1;
    if (view.status === 'failed') failed += 1;
    if (view.status === 'sleeping') sleeping += 1;
  }
  const n = S.tabs.length;
  $('#sb-count').textContent = n === 0 ? 'Sin sesiones abiertas' : n === 1 ? '1 sesión abierta' : `${n} sesiones abiertas`;

  const workingEl = $('#sb-working');
  workingEl.hidden = working === 0;
  workingEl.innerHTML = SVG.working;
  workingEl.append(`${working} trabajando`);

  const attnEl = $('#sb-attn');
  attnEl.hidden = attn === 0;
  attnEl.innerHTML = SVG.attn;
  attnEl.append(attn === 1 ? '1 te necesita' : `${attn} te necesitan`);

  const doneEl = $('#sb-done');
  doneEl.hidden = done === 0;
  doneEl.innerHTML = SVG.done;
  doneEl.append(done === 1 ? '1 ha terminado' : `${done} han terminado`);

  const failedEl = $('#sb-failed');
  failedEl.hidden = failed === 0;
  failedEl.innerHTML = SVG.failed;
  failedEl.append(failed === 1 ? '1 con error' : `${failed} con error`);

  const sleepingEl = $('#sb-sleeping');
  sleepingEl.hidden = sleeping === 0;
  sleepingEl.innerHTML = SVG.off;
  sleepingEl.append(sleeping === 1 ? '1 dormida' : `${sleeping} dormidas`);
  sleepingEl.title = `Sesiones que llevaban ${Math.round(sleepAfterMs / 60000)} min esperando sin que las miraras: se han cerrado para liberar memoria y se retoman solas al abrir su pestaña.`;

  const tab = byId(S.activeId);
  const zoom = $('#sb-zoom');
  zoom.hidden = !tab;
  if (tab) zoom.textContent = `${Math.round((tab.zoom || 1) * 100)} %`;

  renderPlanLimits();

  // El modelo y el esfuerzo de la pestaña activa: «Opus 5.5 · esfuerzo muy alto». Si no cabe,
  // el esfuerzo es lo primero que se quita (se ve al pasar el ratón).
  const modelEl = $('#sb-model');
  const model = tab && views.get(tab.id) && views.get(tab.id).model;
  modelEl.hidden = !model;
  if (model) {
    const effort = model.effort ? EFFORTS[model.effort] || model.effort : null;
    setPieces(modelEl, [{ text: model.name }, effort ? { kind: 'extra', text: ` · esfuerzo ${effort}` } : null, model.fast ? { kind: 'extra', text: ' · rápido' } : null]);
    modelEl.title = `Modelo de esta pestaña: ${model.name}${model.id ? ` (${model.id})` : ''}.${effort ? `\nEsfuerzo de razonamiento: ${effort}${effort !== model.effort ? ` (${model.effort})` : ''}.` : ''}${model.fast ? '\nModo rápido activado.' : ''}\nSe cambian con el botón derecho sobre la pestaña.`;
  }
  // La conversación de cada pestaña ya se ve en su barrita (y sus tokens, al pasar el ratón):
  // la barra inferior solo lleva el uso semanal de Claude y de Codex.
  $('#sb-hint').textContent = S.split
    ? 'Ctrl+Alt+flechas cambia de lado · Ctrl+Tab cambia de pestaña'
    : 'Ctrl+Tab cambia de pestaña · Ctrl+1…9 va directa';
  fitStatusbar();

  // El proceso principal lo usa para avisar antes de cerrar con trabajo en curso.
  const busy = working + waiting;
  if (busy !== lastBusy) {
    setLastBusy(busy);
    api.setSummary({ working: busy });
  }
}

export function renderAll() {
  renderTabs();
  renderToolbar();
  renderHeads();
  renderStatusbar();
  renderActivity();
}

// Coloca cada vista en su lado y actualiza todo lo demás.
export function layout() {
  hidePreview();
  if (S.split && (!byId(S.split.left) || !byId(S.split.right) || S.split.left === S.split.right)) S.split = null;
  if (!byId(S.activeId)) S.activeId = S.tabs[0] ? S.tabs[0].id : null;
  if (S.split) S.activeId = S.split[S.focusSide];

  const workspace = $('#workspace');
  workspace.classList.toggle('split', Boolean(S.split));
  if (S.split) workspace.style.setProperty('--ratio', String(S.split.ratio || 0.5));
  $('#empty').hidden = S.tabs.length > 0;
  $('#divider').hidden = !S.split;

  const assigned = S.split ? { left: S.split.left, right: S.split.right } : { left: S.activeId, right: null };
  for (const side of SIDES) {
    const pane = panes[side];
    const view = assigned[side] ? views.get(assigned[side]) : null;
    pane.el.hidden = !view;
    if (!view) pane.body.replaceChildren();
    else if (view.el.parentNode !== pane.body) pane.body.replaceChildren(view.el);
  }

  renderAll();
  enterProject(); // el mapa «Workflow» del proyecto, preparado en segundo plano
  requestAnimationFrame(() => {
    for (const id of visibleIds()) {
      const view = views.get(id);
      if (view) showView(view);
    }
    acknowledge();
    focusTerminal();
  });
}
