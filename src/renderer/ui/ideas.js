// ── Ideas para el proyecto (SuperPowers) ─────────────────────────
// La tarjeta de una idea que de verdad merece la pena (src/main/ideas.js), encima de la terminal
// de la pestaña: la terminal se encoge para que nada quede tapado y no se le quita el foco. Solo
// sale con Claude parado (si está trabajando, espera a que termine). Tres respuestas:
// «Pruébalo en una rama aparte» (se le pide a Claude, como «Optimiza»), «Más tarde» (un día) y
// «No me interesa» (no vuelve y no se propone nada parecido).
import { api, el } from './dom.js';
import { BUSY } from './model.js';
import { views, toast } from './state.js';
import { queueFit, focusTerminal } from './views.js';

const cards = new Map(); // pestaña → idea esperando respuesta
const SPARK = '<svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16"><path d="M8 1.5c.4 2.9 1.7 4.2 4.6 4.6-2.9.4-4.2 1.7-4.6 4.6-.4-2.9-1.7-4.2-4.6-4.6C6.3 5.7 7.6 4.4 8 1.5zM12.6 10.3c.2 1.3.8 1.9 2.1 2.1-1.3.2-1.9.8-2.1 2.1-.2-1.3-.8-1.9-2.1-2.1 1.3-.2 1.9-.8 2.1-2.1z" fill="currentColor"/></svg>';
const level = (n) => (n <= 2 ? 'bajo' : n === 3 ? 'medio' : 'alto');

function remove(view) {
  if (!view || !view.ideaEl) return;
  view.ideaEl.remove();
  view.ideaEl = null;
  queueFit();
}

function build(view, card) {
  const box = el('section', 'idea-card');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', `Idea para el proyecto: ${card.title}`);
  const head = el('div', 'idea-head');
  const spark = el('span', 'idea-spark');
  spark.innerHTML = SPARK;
  const titles = el('div', 'idea-titles');
  titles.append(el('div', 'idea-kicker', 'Idea para el proyecto · SuperPowers'), el('div', 'idea-title', card.title));
  const tags = el('div', 'idea-tags');
  tags.append(el('span', 'idea-tag idea-gain', card.gain >= 5 ? 'Ganancia muy alta' : 'Ganancia alta'));
  tags.append(el('span', `idea-tag idea-kind-${card.kind}`, card.kind === 'visual' ? 'Visual' : 'Funcional'));
  const close = el('button', 'idea-x');
  close.type = 'button';
  close.title = 'Más tarde (vuelve a salir mañana)';
  close.setAttribute('aria-label', 'Más tarde');
  close.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
  tags.append(close);
  head.append(spark, titles, tags);

  const body = el('div', 'idea-body');
  const left = el('div', 'idea-left');
  left.append(el('p', 'idea-why', card.why));
  const facts = el('div', 'idea-facts');
  const fact = (label, value) => { const s = el('span'); s.append(`${label}: `, el('b', '', value)); return s; };
  facts.append(fact('Esfuerzo', `${level(card.effort)}${card.files.length ? ` (${card.files.length === 1 ? '1 archivo' : `${card.files.length} archivos`})` : ''}`));
  facts.append(fact('Riesgo', card.risk));
  if (card.codex) facts.append(el('span', 'idea-codex', '✓ Codex coincide'));
  left.append(facts);
  const acts = el('div', 'idea-acts');
  const go = el('button', 'idea-go');
  go.type = 'button';
  go.innerHTML = SPARK.replace('width="17" height="17"', 'width="14" height="14"');
  go.append('Pruébalo en una rama aparte');
  const later = el('button', 'idea-ghost', 'Más tarde');
  later.type = 'button';
  const no = el('button', 'idea-ghost', 'No me interesa');
  no.type = 'button';
  acts.append(go, later, no, el('small', 'idea-note', 'No cambia nada de tu rama: se prueba en una copia aparte y decides tú.'));
  left.append(acts);
  body.append(left);

  // La captura de cómo se ve ahora (ideas visuales): la de la propuesta la hace Claude al probarla.
  if (card.before && card.before.file) {
    const shot = el('button', 'idea-shot');
    shot.type = 'button';
    shot.title = `Abrir ${card.before.file}`;
    shot.hidden = true;
    shot.append(el('small', '', `Ahora · ${card.before.width} px`));
    shot.addEventListener('click', () => api.openPath(card.before.file));
    body.append(shot);
    body.classList.add('with-shot');
    api.preview(card.before.file).then((data) => {
      if (!data || !data.image) { body.classList.remove('with-shot'); return; }
      const img = el('img');
      img.alt = '';
      img.src = data.image;
      shot.append(img);
      shot.hidden = false;
      queueFit();
    }).catch(() => body.classList.remove('with-shot'));
  }
  box.append(head, body);

  const answer = async (action) => {
    const res = await api.ideasAct(view.tab.id, card.id, action).catch(() => null);
    cards.delete(view.tab.id);
    remove(view);
    if (!res || !res.ok) return;
    if (action === 'later') toast('De acuerdo: te la vuelve a enseñar mañana.');
    if (action === 'no') toast('Entendido: no volverá a salir ni nada parecido.');
    if (action === 'try' && res.prompt) {
      // Como «Optimiza»: se vacía lo que hubiera a medio escribir y se le pide a Claude.
      api.ptyWrite(view.tab.id, String.fromCharCode(21));
      setTimeout(() => view.term.paste(res.prompt), 150);
      setTimeout(() => api.ptyWrite(view.tab.id, '\r'), 550);
      focusTerminal();
    }
  };
  go.addEventListener('click', () => {
    if (BUSY.includes(view.status)) { toast('Claude está trabajando: pruébala cuando termine.'); return; }
    if (!view.started || view.exited) { toast('Abre antes la sesión de Claude de esta pestaña.'); return; }
    answer('try');
  });
  later.addEventListener('click', () => answer('later'));
  close.addEventListener('click', () => answer('later'));
  no.addEventListener('click', () => answer('no'));
  return box;
}

// Enseña la idea de la pestaña si Claude está parado (si no, al terminar: showPendingIdea).
function render(view) {
  const card = cards.get(view.tab.id);
  if (!card) { remove(view); return; }
  if (view.ideaEl && view.ideaEl.dataset.id === card.id) return;
  if (BUSY.includes(view.status)) return;
  remove(view);
  view.ideaEl = build(view, card);
  view.ideaEl.dataset.id = card.id;
  view.main.prepend(view.ideaEl);
  queueFit();
}

export function setIdea(tabId, card) {
  if (!card || typeof card !== 'object' || !card.id) return;
  cards.set(tabId, card);
  const view = views.get(tabId);
  if (view) render(view);
}

// Al terminar un turno (session-events.js) o al abrir la pestaña: la que estuviera esperando.
export function showPendingIdea(view) {
  if (view && cards.has(view.tab.id)) render(view);
}

// Al abrir una pestaña con SuperPowers: si su proyecto tiene una idea esperando.
export async function loadIdea(tabId) {
  try { setIdea(tabId, await api.ideasGet(tabId)); } catch { /* sin idea */ }
}

// SuperPowers apagado en la pestaña: su idea deja de enseñarse ahí.
export function forgetIdea(tabId) {
  cards.delete(tabId);
  remove(views.get(tabId));
}

export function wireIdeas() {
  api.onIdea((tabId, card) => setIdea(tabId, card));
}
