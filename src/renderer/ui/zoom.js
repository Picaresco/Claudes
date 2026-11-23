// ── Tamaño del texto (barra inferior) ────────────────────────────
// Pulsar el «100 %» abre un panel pequeño con «−» y «+» (de 10 en 10 %) y «Volver al 100 %».
// Cada pestaña tiene su tamaño (views.js, setZoom). También valen Ctrl + y Ctrl −, y la rueda
// del ratón sobre el número.
import { $ } from './dom.js';
import { S, views } from './state.js';
import { setZoom, focusTerminal } from './views.js';

const MIN = 0.6;
const MAX = 2.4;

const activeView = () => views.get(S.activeId);
const current = () => { const view = activeView(); return view ? view.tab.zoom || 1 : 1; };

function paint() {
  const zoom = current();
  $('#zoom-value').textContent = `${Math.round(zoom * 100)} %`;
  $('#zoom-out').disabled = zoom <= MIN + 0.001;
  $('#zoom-in').disabled = zoom >= MAX - 0.001;
  $('#zoom-reset').disabled = Math.abs(zoom - 1) < 0.001;
}

function change(value) {
  const view = activeView();
  if (!view) return;
  setZoom(view, value);
  paint();
}
const step = (delta) => change(current() + delta);

function openMenu() {
  if (!activeView()) return;
  paint();
  $('#zoom-menu').hidden = false;
  $('#sb-zoom').setAttribute('aria-expanded', 'true');
  $('#zoom-in').focus();
}

export function closeZoomMenu() {
  if ($('#zoom-menu').hidden) return false;
  $('#zoom-menu').hidden = true;
  $('#sb-zoom').setAttribute('aria-expanded', 'false');
  return true;
}

export function wireZoom() {
  $('#sb-zoom').addEventListener('click', () => { if (!closeZoomMenu()) openMenu(); else focusTerminal(); });
  $('#zoom-out').addEventListener('click', () => step(-0.1));
  $('#zoom-in').addEventListener('click', () => step(0.1));
  $('#zoom-reset').addEventListener('click', () => change(1));
  // La rueda del ratón sobre el número también lo cambia.
  $('#sb-zoom').addEventListener('wheel', (e) => {
    e.preventDefault();
    step(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  // Se cierra al pulsar fuera o con Esc (y la terminal recupera el foco).
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.zoom-wrap')) closeZoomMenu(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeZoomMenu()) { focusTerminal(); e.preventDefault(); e.stopPropagation(); }
  }, true);
}
