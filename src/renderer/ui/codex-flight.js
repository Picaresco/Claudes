// ── Vuelo de datos hacia Codex ───────────────────────────────────
// Cuando una pestaña le pide algo a Codex (segunda opinión, crítica de un plan, revisión o una
// imagen), un paquete de caracteres sale del final del texto de la llamada en la terminal y vuela
// hasta el indicador «Codex» de la barra superior; al llegar, el indicador hace un destello. Cuando
// Codex termina, vuelve un paquete más pequeño al mismo sitio. Mientras trabaja, el indicador sigue
// como siempre (late y enseña su icono). El mapa del Workflow no pasa por aquí: no lo pide Claude.
// Sin vuelo si el sistema pide reducir el movimiento o la ventana no se ve.
import { $ } from './dom.js';
import { views, visibleIds } from './state.js';

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0101100111';
const pick = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
// Cinco fotogramas de «información» (5×3 caracteres) que se recorren en bucle.
const FRAMES = Array.from({ length: 5 }, () => Array.from({ length: 15 }, pick));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// La línea de la terminal desde la que sale cada cosa: la llamada a la herramienta, si se ve.
const CALL = { opinion: /segunda_opinion/, security: /segunda_opinion/, draw: /generar_imagen/ };
const RULE = /^\s*[─━]{8,}/; // las rayas del cuadro donde se escribe a Claude

const keyOf = (job) => `${job.kind}|${job.tabId}|${job.what}|${job.startedAt}`;
let known = null; // trabajos de la última vez: id → trabajo
const origins = new Map(); // id del trabajo → { tabId, pattern } (para volver al mismo sitio)

function center(node) {
  const r = node.getBoundingClientRect();
  return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

// Justo detrás del final del texto de la línea de la llamada (o, si no se ve, de la última línea
// de la conversación, encima del cuadro de escribir). null si la terminal no se ve.
function lineEnd(view, pattern) {
  const term = view && view.term;
  const screen = view && view.host && view.host.querySelector('.xterm-screen');
  if (!term || !screen) return null;
  const r = screen.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const buf = term.buffer.active;
  const textAt = (row) => { const line = buf.getLine(buf.viewportY + row); return line ? line.translateToString(true).replace(/\s+$/, '') : ''; };
  let row = -1;
  if (pattern) for (let i = term.rows - 1; i >= 0 && row < 0; i -= 1) if (pattern.test(textAt(i))) row = i;
  if (row < 0) {
    // Por encima de la raya de arriba del cuadro de escribir (la segunda, contando desde abajo).
    let rules = 0;
    let top = term.rows;
    for (let i = term.rows - 1; i >= 0 && top === term.rows; i -= 1) {
      if (!RULE.test(textAt(i))) continue;
      rules += 1;
      if (rules === 2) top = i;
    }
    for (let i = top - 1; i >= 0 && row < 0; i -= 1) if (textAt(i).trim()) row = i;
  }
  if (row < 0) return null;
  const cellW = r.width / term.cols;
  const cellH = r.height / term.rows;
  return { x: Math.min(r.right - 24, r.left + textAt(row).length * cellW + 24), y: r.top + (row + 0.5) * cellH };
}

// De dónde sale (o adónde vuelve) el paquete de una pestaña: su terminal si se ve; si no, su pestaña.
function originOf({ tabId, pattern }) {
  if (visibleIds().includes(tabId)) {
    const at = lineEnd(views.get(tabId), pattern);
    if (at) return at;
  }
  const tab = document.querySelector(`#tabs .tab[data-id="${CSS.escape(String(tabId))}"]`);
  return tab ? center(tab) : null;
}

// Vuela un paquete de `from` a `to` en arco, cambiando de fotograma cada 70 ms y dejando una estela
// de caracteres que caen.
function fly(from, to, { duration = 950, back = false } = {}) {
  return new Promise((resolve) => {
    const p = document.createElement('div');
    p.className = `cx-packet${back ? ' back' : ''}`;
    p.setAttribute('aria-hidden', 'true');
    const cells = Array.from({ length: back ? 10 : 15 }, () => p.appendChild(document.createElement('span')));
    p.style.transform = `translate(${from.x - 28}px, ${from.y - 20}px)`; // ya en su sitio desde el primer fotograma
    document.body.append(p);
    // Ida: sale hacia la derecha y entra en el indicador desde abajo. Vuelta: baja y va a la izquierda.
    const ctrl = back ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
    const t0 = performance.now();
    let lastDrop = 0;
    const step = (stamp) => {
      const now = Math.max(stamp, t0);
      const t = Math.min(1, (now - t0) / duration);
      const e = ease(t);
      const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * ctrl.x + e ** 2 * to.x;
      const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * ctrl.y + e ** 2 * to.y;
      const scale = back ? 0.7 + 0.3 * e : 1 - 0.45 * e;
      p.style.transform = `translate(${x - 28}px, ${y - 20}px) scale(${scale})`;
      p.style.opacity = t > 0.92 ? String((1 - t) / 0.08) : '1';
      const frame = FRAMES[Math.floor((now - t0) / 70) % FRAMES.length];
      cells.forEach((c, i) => { c.textContent = frame[i]; });
      if (now - lastDrop > 32 && t < 0.95) {
        lastDrop = now;
        const d = document.createElement('span');
        d.className = 'cx-drop';
        d.setAttribute('aria-hidden', 'true');
        d.textContent = pick();
        d.style.left = `${x - 20 + Math.random() * 30}px`;
        d.style.top = `${y - 10 + Math.random() * 14}px`;
        document.body.append(d);
        setTimeout(() => d.remove(), 800);
      }
      if (t < 1) requestAnimationFrame(step); else { p.remove(); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

function hit() {
  const badge = $('#codex-status');
  badge.classList.remove('cx-hit');
  badge.getBoundingClientRect(); // así el destello vuelve a empezar
  badge.classList.add('cx-hit');
  setTimeout(() => badge.classList.remove('cx-hit'), 700);
}

async function send(job) {
  const from = originOf(origins.get(keyOf(job)));
  const badge = $('#codex-status');
  const to = badge.hidden ? null : center(badge.querySelector('.cx-dot') || badge);
  if (!from || !to) return;
  await fly(from, to);
  hit();
}

function answer(id) {
  const where = origins.get(id);
  origins.delete(id);
  const badge = $('#codex-status');
  const from = badge.hidden ? null : center(badge.querySelector('.cx-dot') || badge);
  const to = where ? originOf(where) : null;
  if (from && to) fly(from, to, { duration: 650, back: true });
}

// Con cada cambio del estado de Codex: lo que empieza vuela hacia él y lo que acaba vuelve.
export function codexFlights(info) {
  const jobs = (info && info.usable && info.jobs) || [];
  const now = new Map(jobs.filter((job) => job.tabId).map((job) => [keyOf(job), job]));
  if (known === null) { known = now; return; } // al arrancar no vuela lo que ya estaba en marcha
  const quiet = reduced() || document.hidden;
  for (const [id, job] of now) {
    if (known.has(id)) continue;
    origins.set(id, { tabId: job.tabId, pattern: CALL[job.icon] || null });
    if (!quiet) send(job);
  }
  for (const id of known.keys()) {
    if (now.has(id)) continue;
    if (quiet) origins.delete(id); else answer(id);
  }
  known = now;
}
