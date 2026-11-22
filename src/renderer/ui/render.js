// ── Pintado ──────────────────────────────────────────────────────
import { codexInfo } from './codex.js';
import { colorHex, SIDES, SVG, STATUS } from './constants.js';
import { contextCount } from './context.js';
import { api, $, el } from './dom.js';
import { limitsSnap, tokensShort, tokensBreakdown, renderPlanLimits } from './limits.js';
import { logEntriesOf } from './log.js';
import { hidePreview } from './preview.js';
import { acknowledge } from './session-events.js';
import { sleepAfterMs } from './sleep.js';
import {
  S, views, renamingId, draggingId, lastBusy, setLastBusy, panes, byId, clamp, visibleIds,
  applySwatch, swatch,
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
  main.title = `${tab.name} · ${st.label}\n${tab.cwd}${usage ? `\n${usageText(usage)}` : ''}`;
  main.innerHTML = SVG[st.icon];
  // Los puntos de «te necesita» y «ha terminado» parpadean. La fase sale del reloj
  // para que no vuelva a empezar cada vez que se repintan las pestañas.
  const attnDot = main.querySelector('.dot-attn');
  if (attnDot) attnDot.style.animationDelay = `-${Date.now() % 1200}ms`;
  main.append(el('span', 'tab-name', tab.name));

  const close = el('button', 'tab-close');
  close.setAttribute('aria-label', `Cerrar la pestaña ${tab.name}`);
  close.title = 'Cerrar pestaña (Ctrl+Mayús+W)';
  close.innerHTML = SVG.close;

  node.append(main, close);
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
  const active = S.activeId && strip.querySelector(`.tab[data-id="${S.activeId}"]`);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

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

  // Conversación de la pestaña activa: cuánto ocupa de su contexto y los tokens que lleva usados.
  const activeView = tab && views.get(tab.id);
  const usage = activeView && activeView.usage && activeView.usage.pct !== null ? activeView.usage : null;
  const spent = tab && limitsSnap.conversations[tab.id];
  const usageEl = $('#sb-usage');
  usageEl.hidden = !usage && !spent;
  if (usage || spent) {
    usageEl.dataset.level = usage ? usageLevel(usage.pct) : 'low';
    usageEl.querySelector('.sb-meter').hidden = !usage;
    $('#sb-usage-fill').style.width = `${usage ? clamp(usage.pct, 0, 100) : 0}%`;
    $('#sb-usage-text').textContent = `Conversación${usage ? ` ${usage.pct} %` : ''}${spent ? ` · ${tokensShort(spent.total)}` : ''}`;
    const lines = [];
    if (usage) lines.push(`${usageText(usage)}.`);
    if (spent) lines.push(`Tokens usados en esta conversación: ${nf.format(spent.total)} (${tokensBreakdown(spent)}). Incluye los de sus subagentes.`);
    if (usage) lines.push('Cuanto más llena, peor rinde Claude y más gasta: /compact la resume y sigue, /clear empieza de cero.');
    usageEl.title = lines.join('\n');
  }
  $('#sb-hint').textContent = S.split
    ? 'Ctrl+Alt+flechas cambia de lado · Ctrl+Tab cambia de pestaña'
    : 'Ctrl+Tab cambia de pestaña · Ctrl+1…9 va directa';

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
  requestAnimationFrame(() => {
    for (const id of visibleIds()) {
      const view = views.get(id);
      if (view) showView(view);
    }
    acknowledge();
    focusTerminal();
  });
}
