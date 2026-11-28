// ── «Workflow»: cómo funciona el proyecto, en un mapa con zoom ─────
// El mapa lo dibuja un modelo aparte (src/main/workflow.js), sin tocar la sesión de Claude de
// la pestaña; aquí se enseña con tres niveles de detalle según lo cerca que se mire:
//   1. vista general: los bloques y cómo se conectan;
//   2. módulos: las piezas de cada bloque;
//   3. detalle: qué hace cada pieza, lo que pide una credencial (🔑), lo que bloquea o prohíbe (✕)
//      y lo que se repite solo (↻).
// Rueda o pellizco para acercar, arrastrar para moverse, pulsar un bloque o una pieza para
// entrar, doble clic o «Ver todo» para volver. Con la ventana abierta, el mapa se revisa
// cada 5 minutos y solo se rehace si el proyecto ha cambiado.
import { api, $, el } from './dom.js';
import { S, byId } from './state.js';
import { focusTerminal } from './views.js';
import { layoutMap, wrap } from './workflow-layout.js';

// credencial: pide una sesión, un token o una clave (no es un aviso); regla: bloquea o prohíbe.
const COL = { datos: '#6AA5F8', bucle: '#F2B866', credencial: '#5FC8D6', regla: '#F26B6B' };
const KEY = '🔑';
const isKey = (text) => String(text).trim().startsWith(KEY);
const unmark = (text) => String(text).trim().replace(/^(✕|🔑|↻)\s*/u, '');
// La llave, dibujada (el emoji saldría en color y de otro tamaño que el texto).
const KEY_SYMBOL = '<symbol id="wf-key" viewBox="0 0 16 16"><circle cx="5" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.2 8h6.3M12 8v2.6M14.2 8v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>';
const BLOCK = { persona: ['#A9AFB9', 'rgba(169,175,185,.05)'], interfaz: ['#6AA5F8', 'rgba(106,165,248,.07)'], nucleo: ['#7FD4A0', 'rgba(127,212,160,.06)'], proceso: ['#F2B866', 'rgba(242,184,102,.06)'], datos: ['#A9AFB9', 'rgba(169,175,185,.05)'] };
// Cinco niveles de zoom: + y − van de uno en uno, y la rueda y el pellizco no salen de ellos.
// Cada nivel enseña lo que se lee a ese tamaño (LOD_OF: 1 bloques, 2 piezas, 3 detalle).
const NAMES = ['Vista general', 'Bloques', 'Piezas', 'Detalle', 'Detalle ampliado'];
const LOD_OF = [1, 2, 2, 3, 3];
const MIN_PX = [0, 0.85, 1.35, 2.1, 3.2]; // píxeles por unidad del lienzo, como mínimo, en cada nivel
let steps = [1, 1.6, 2.6, 4.1, 6.6]; // los de este mapa en esta ventana (computeSteps)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let current = null; // { tabId, key, snap, drawnAt }
let L = null; // lo que sale de layoutMap
let vb = { x: 0, y: 0, w: 1, h: 1 };
let base = vb;
let anim = 0;
let ticker = 0;
let chips = [];

const svg = () => $('#wf-map');
const stage = () => $('#wf-stage');

// ── Dibujo ─────────────────────────────────────────────────────────────

// Etiqueta de una flecha: en dos renglones si es larga, para que quepa en el hueco entre bloques.
// Las de credencial llevan la llave dibujada delante, en vez del «🔑» escrito.
function chip(kind, text, [x, y], extra = '') {
  const key = kind === 'credencial';
  const shown = key ? unmark(text) : text;
  const lines = [...shown].length > 15 ? wrap(shown, 15, 2) : [shown];
  const icon = key ? 18 : 0;
  const w = Math.max(40, Math.max(...lines.map((l) => [...l].length)) * 8.4 + 24 + icon);
  const h = lines.length * 18 + 10;
  const rows = lines.map((l, i) => `<text x="${x + icon / 2}" y="${y + 1 + (i - (lines.length - 1) / 2) * 18}">${esc(l)}</text>`).join('');
  const mark = key ? `<use href="#wf-key" class="wf-keyi" x="${x - w / 2 + 10}" y="${y - 7}" width="14" height="14"/>` : '';
  return `<g class="wf-chip k-${kind}" data-x="${x}" data-y="${y}" data-h="${h}"${extra}><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${Math.min(14, h / 2)}"/>${mark}${rows}</g>`;
}

// Cada texto, dentro de su caja: se mide ya dibujado (la letra de ancho fijo y las mayúsculas no
// se pueden estimar por número de letras) y, si no cabe, se corta por una palabra o una letra con «…».
function fitTexts() {
  for (const t of svg().querySelectorAll('text[data-w]')) {
    const max = Number(t.dataset.w);
    const full = t.textContent;
    if (!max || t.getComputedTextLength() <= max) continue;
    let lo = 0;
    let hi = full.length;
    while (lo < hi) { // la mayor cantidad de letras que cabe con «…»
      const mid = Math.ceil((lo + hi) / 2);
      t.textContent = `${full.slice(0, mid).trimEnd()}…`;
      if (t.getComputedTextLength() <= max) lo = mid; else hi = mid - 1;
    }
    t.textContent = `${full.slice(0, lo).replace(/[\s·,;:]+$/, '')}…`;
    if (!t.querySelector('title')) { const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tip.textContent = full; t.append(tip); }
  }
}

function draw(map) {
  L = layoutMap(map);
  focused = null;
  const marker = (k) => `<marker id="wf-a-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" fill="${COL[k]}"/></marker>`;
  const defs = `<defs>${KEY_SYMBOL}${Object.keys(COL).map(marker).join('')}</defs>`;
  const band = L.band ? `<line class="wf-edge" x1="0" y1="${L.band - 10}" x2="${L.W}" y2="${L.band - 10}"/><text class="wf-band" x="20" y="${L.band - 22}">internet</text><text class="wf-band" x="20" y="${L.band + 10}">tu equipo</text>` : '';
  const blocks = L.blocks.map((b) => {
    const [stroke, fill] = BLOCK[b.tipo] || BLOCK.nucleo;
    // El resumen, grande: es lo que se lee en la vista general (las piezas aparecen al acercarse).
    // Título y resumen, al tamaño que quepa en el bloque (un bloque estrecho, letra más pequeña).
    const tfs = Math.max(18, Math.min(34, Math.floor((b.w - 36) / (Math.max(1, [...b.nombre].length) * 0.58))));
    const sfs = b.w < 300 ? 24 : 28;
    const lh = sfs * 1.35;
    const lines = wrap(b.resumen, Math.max(10, Math.floor((b.w - 36) / (sfs * 0.53))), Math.max(1, Math.min(4, Math.floor((b.h - 84) / lh))));
    const mid = b.y + 70 + (b.h - 70) / 2;
    const sum = lines.map((l, i) => `<text class="wf-sum" data-w="${b.w - 28}" x="${b.x + b.w / 2}" y="${mid + 10 + (i - (lines.length - 1) / 2) * lh}" text-anchor="middle" style="font-size:${sfs}px">${esc(l)}</text>`).join('');
    const zoom = b.n ? ` data-zoom="${b.x} ${b.y} ${b.w} ${b.h}"` : '';
    return `<g class="wf-blk${b.n ? ' wf-zoomable' : ''}" data-id="${esc(b.id)}" data-name="${esc(b.nombre)}"${zoom}><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="16" fill="${fill}" stroke="${stroke}" stroke-opacity=".6"/><text class="wf-bt" data-w="${b.w - 36}" x="${b.x + 18}" y="${b.y + 46}" style="fill:${stroke === '#A9AFB9' ? '#E7E9EC' : stroke};font-size:${tfs}px">${esc(b.nombre)}</text>${b.n ? `<g class="wf-lod1">${sum}</g>` : sum}</g>`; // sin piezas, el resumen se queda a la vista
  }).join('');
  const ext = L.ext.map((e) => `<g class="wf-blk wf-ext" data-id="${esc(e.id)}"><rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="12"/><text class="wf-et" data-w="${e.w - 30}" x="${e.x + 16}" y="${e.y + 42}">${esc(e.nombre)}</text><text class="wf-es" data-w="${e.w - 30}" x="${e.x + 16}" y="${e.y + 76}">${esc(e.resumen)}</text></g>`).join('');
  // Cada flecha sabe qué une (data-de, data-a): al pasar el ratón se iluminan las de lo señalado.
  const arrow = (a, cls = '') => {
    const m = `url(#wf-a-${a.kind})`;
    const ends = `marker-end="${m}"${a.bi ? ` marker-start="${m}"` : ''}`;
    const flow = a.kind === 'regla' || a.kind === 'credencial' ? '' : `<path class="wf-flow" d="${a.d}"/>`;
    return `<g class="wf-ar k-${a.kind}${cls}" data-de="${esc(a.de)}" data-a="${esc(a.a)}"${a.bloque ? ` data-b="${esc(a.bloque)}"` : ''}><path class="wf-base" d="${a.d}" ${ends}/>${flow}</g>`;
  };
  const arrows = L.arrows.map((a) => arrow(a)).join('') + L.inner.map((a) => arrow({ ...a, bi: false }, ' wf-in wf-lod2')).join('');
  const cards = L.cards.map((c) => {
    // Hasta 4 renglones si abajo van los archivos; 5 si no.
    const rules = c.reglas.map((r) => (isKey(r) ? `${KEY} ${unmark(r)}` : `✕ ${unmark(r)}`));
    const lines = [...c.detalle, ...rules, ...c.bucles.map((r) => `↻ ${unmark(r)}`)].slice(0, c.archivos.length ? 4 : 5);
    // data-w: el ancho que tiene cada texto; lo que no quepa se corta con «…» al dibujarlo (fitTexts).
    const inner = c.w - 28;
    const text = lines.map((l, i) => {
      const y = c.y + 62 + i * 11;
      if (l.startsWith(KEY)) return `<use href="#wf-key" class="wf-keyi" x="${c.x + 13}" y="${y - 7.5}" width="9" height="9"/><text class="wf-cd k" data-w="${inner - 12}" x="${c.x + 25}" y="${y}">${esc(unmark(l))}</text>`;
      return `<text class="wf-cd${l.startsWith('✕') ? ' r' : l.startsWith('↻') ? ' l' : ''}" data-w="${inner}" x="${c.x + 14}" y="${y}">${esc(l)}</text>`;
    }).join('');
    const files = c.archivos.length ? `<text class="wf-cf" data-w="${inner}" x="${c.x + 14}" y="${c.y + c.h - 9}">${esc(c.archivos.slice(0, 3).join(' · '))}</text>` : '';
    // Un punto por clase: rojo si bloquea algo, turquesa si pide credencial, ámbar si se repite.
    const keys = c.reglas.filter(isKey).length;
    const dots = [c.reglas.length > keys && COL.regla, keys && COL.credencial, c.bucles.length && COL.bucle].filter(Boolean);
    const marks = dots.map((fill, i) => `<circle cx="${c.x + c.w - 14 - i * 14}" cy="${c.y + 16}" r="5" fill="${fill}"/>`).join('');
    // Al entrar en el bloque, cada pieza sale de su centro y se separa hasta su sitio, una tras otra.
    const blk = L.blocks.find((b) => b.id === c.bloque);
    const dx = ((blk.x + blk.w / 2) - (c.x + c.w / 2)) * 0.7;
    const dy = ((blk.y + blk.h / 2) - (c.y + c.h / 2)) * 0.7;
    // De cerca, pulsarla muestra su archivo principal en el Explorador.
    const tip = c.archivos.length ? `${c.nombre}: de lejos, pulsa para acercarte; de cerca, para ver ${c.archivos[0]} en el Explorador` : c.nombre;
    return `<g class="wf-card wf-lod2" style="--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;--d:${c.i * 45}ms" data-zoom="${c.x} ${c.y} ${c.w} ${c.h}" data-id="${esc(c.id)}" data-name="${esc(c.nombre)}" data-b="${esc(c.bloque)}" data-file="${esc(c.archivos[0] || '')}"><title>${esc(tip)}</title><rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10"/>${marks}<text class="wf-ct" data-w="${inner - (dots.length ? 20 + dots.length * 14 : 0)}" x="${c.x + 14}" y="${c.y + 27}">${esc(c.nombre)}</text><text class="wf-cs" data-w="${inner}" x="${c.x + 14}" y="${c.y + 44}">${esc(c.sub)}</text><g class="wf-lod3">${text}${files}</g></g>`;
  }).join('');
  // Las reglas de cada bloque, al pie, aparecen al acercarse; en la vista general, las de las flechas.
  const labels = L.arrows.filter((a) => a.text).map((a) => chip(a.kind, a.text, a.at, ` data-de="${esc(a.de)}" data-a="${esc(a.a)}"`)).join('')
    + L.pills.map((p) => {
      const kind = isKey(p.text) ? 'credencial' : 'regla';
      const text = kind === 'regla' ? `✕ ${unmark(p.text)}` : p.text;
      return chip(kind, text, p.at, ` data-pill="1" data-b="${esc(p.bloque)}"`).replace('class="wf-chip', 'class="wf-lod2 wf-chip');
    }).join('');
  svg().innerHTML = defs + band + blocks + ext + arrows + cards + labels;
  fitTexts();
  chips = [...svg().querySelectorAll('.wf-chip')].map((g) => ({ g, x: Number(g.dataset.x), y: Number(g.dataset.y), w: Number(g.querySelector('rect').getAttribute('width')), h: Number(g.dataset.h) }));
  base = fitBox();
  computeSteps();
  vb = { ...base };
  apply();
}

// ── Zoom y desplazamiento ──────────────────────────────────────────────

function fitBox() {
  const r = stage().getBoundingClientRect();
  const ar = r.width / Math.max(1, r.height);
  const W = L ? L.W : 1600;
  const H = L ? L.H : 900;
  const pad = 1.18; // margen para la ayuda, el estado y las migas, que van encima del mapa
  if (ar > W / H) { const h = H * pad; const w = h * ar; return { x: (W - w) / 2, y: (H - h) / 2, w, h }; }
  const w = W * pad;
  const h = w / ar;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// El zoom de cada nivel: el primero, el mapa entero; cada uno, 1,6 veces el anterior y, como
// poco, lo que hace falta para leer lo que enseña.
function computeSteps() {
  const r = stage().getBoundingClientRect();
  steps = [r.width / base.w];
  for (let i = 1; i < NAMES.length; i += 1) steps.push(Math.max(steps[i - 1] * 1.6, MIN_PX[i]));
}
// El nivel más cercano a un zoom.
const levelOf = (px) => steps.reduce((best, s, i) => (Math.abs(Math.log(px / s)) < Math.abs(Math.log(px / steps[best])) ? i : best), 0);

function apply() {
  const s = svg();
  s.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const r = stage().getBoundingClientRect();
  const px = r.width / vb.w; // píxeles por unidad del lienzo
  const level = levelOf(px);
  const lod = LOD_OF[level];
  if (s.dataset.lod !== String(lod)) s.dataset.lod = String(lod);
  const lvl = $('#wf-lvl');
  lvl.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i <= level));
  lvl.querySelector('span').textContent = NAMES[level];
  $('#wf-out').disabled = px <= steps[0] * 1.03;
  $('#wf-in').disabled = px >= steps[steps.length - 1] / 1.03;
  // Las etiquetas de las flechas guardan su tamaño en pantalla (al acercarse no tapan nada)
  // y, si dos se montan, la de abajo baja lo justo.
  const cs = Math.max(0.35, Math.min(2.2, 0.8 / Math.max(0.01, px)));
  const placed = [];
  for (const c of [...chips].sort((a, b) => a.y - b.y)) {
    const w = c.w * cs;
    const h = (c.h + 2) * cs;
    let y = c.y;
    for (const p of placed) if (Math.abs(p.x - c.x) < (p.w + w) / 2 && Math.abs(p.y - y) < (p.h + h) / 2) y = p.y + (p.h + h) / 2;
    placed.push({ x: c.x, y, w, h });
    c.g.setAttribute('transform', `translate(${c.x} ${y}) scale(${cs}) translate(${-c.x} ${-c.y})`);
  }
  // Dónde se está: el bloque y la pieza del centro de la vista.
  if (!L) return;
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const inside = (b, m = 0) => cx >= b.x - m && cx <= b.x + b.w + m && cy >= b.y - m && cy <= b.y + b.h + m;
  const blk = lod > 1 ? L.blocks.find((b) => inside(b)) : null;
  const card = lod > 2 && blk ? L.cards.find((c) => c.bloque === blk.id && inside(c, 8)) : null;
  $('#wf-crumb').innerHTML = `<b>${esc(byId(current && current.tabId)?.name || 'Proyecto')}</b>${blk ? ` › ${esc(blk.nombre)}` : ''}${card ? ` › ${esc(card.nombre)}` : ''}`;
}

function setView(v) {
  const r = stage().getBoundingClientRect();
  const ar = r.width / Math.max(1, r.height);
  // Entre el primer nivel (el mapa entero) y el último.
  const w = Math.min(r.width / steps[0], Math.max(r.width / steps[steps.length - 1], v.w));
  const h = w / ar;
  const cx = v.x + v.w / 2;
  const cy = v.y + v.h / 2;
  const W = L ? L.W : base.w;
  const H = L ? L.H : base.h;
  vb = { x: Math.min(W - w * 0.25, Math.max(-w * 0.75, cx - w / 2)), y: Math.min(H - h * 0.25, Math.max(-h * 0.75, cy - h / 2)), w, h };
  apply();
}

function animateTo(target, ms = 420) {
  cancelAnimationFrame(anim);
  const from = { ...vb };
  const t0 = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = (now) => {
    const p = reduce ? 1 : Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - p) ** 3;
    setView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
    if (p < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

function toCanvas(clientX, clientY) {
  const r = svg().getBoundingClientRect();
  return { x: vb.x + ((clientX - r.left) / r.width) * vb.w, y: vb.y + ((clientY - r.top) / r.height) * vb.h };
}
function zoomAt(f, p) { setView({ x: p.x - (p.x - vb.x) / f, y: p.y - (p.y - vb.y) / f, w: vb.w / f, h: vb.h / f }); }

// Ir a un nivel, centrado en un punto del lienzo.
function zoomToLevel(i, c, ms = 300) {
  const r = stage().getBoundingClientRect();
  const w = r.width / steps[i];
  const h = w / (r.width / Math.max(1, r.height));
  animateTo({ x: c.x - w / 2, y: c.y - h / 2, w, h }, ms);
}
// Entrar en un bloque (nivel «Bloques», se ven sus piezas) o en una pieza (nivel «Detalle»).
const zoomToBox = ([x, y, w, h], card) => zoomToLevel(card ? 3 : 1, { x: x + w / 2, y: y + h / 2 }, 420);
const fit = () => { base = fitBox(); computeSteps(); animateTo(base); };
const center = () => ({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 });
// + y −: al nivel siguiente o al anterior (desde un zoom intermedio, al más cercano en ese sentido).
function zoomStep(dir) {
  const px = stage().getBoundingClientRect().width / vb.w;
  let i = -1;
  if (dir > 0) i = steps.findIndex((s) => s > px * 1.03);
  else steps.forEach((s, k) => { if (s < px / 1.03) i = k; });
  if (i >= 0) zoomToLevel(i, center());
}

// Al pasar el ratón por un bloque (o, de cerca, por una pieza) se iluminan sus conexiones y lo
// que une, y lo demás se atenúa: así se sigue el flujo de esa parte.
let focused = null;
function setFocus(el) {
  const s = svg();
  const key = el ? `${el.classList.contains('wf-card') ? 'c' : 'b'}|${el.dataset.id}` : null;
  if (key === focused) return;
  focused = key;
  for (const on of s.querySelectorAll('.on')) on.classList.remove('on');
  s.classList.toggle('wf-focus', Boolean(el));
  if (!el) return;
  const id = el.dataset.id;
  const card = el.classList.contains('wf-card');
  el.classList.add('on');
  const near = new Set();
  const sel = card ? '.wf-ar.wf-in' : '.wf-ar:not(.wf-in), .wf-chip[data-de]';
  for (const g of s.querySelectorAll(sel)) {
    if (g.dataset.de !== id && g.dataset.a !== id) continue;
    g.classList.add('on');
    near.add(g.dataset.de === id ? g.dataset.a : g.dataset.de);
  }
  if (card) {
    const blk = s.querySelector(`.wf-blk[data-id="${CSS.escape(el.dataset.b)}"]`);
    if (blk) blk.classList.add('on');
    for (const c of s.querySelectorAll('.wf-card')) if (near.has(c.dataset.id)) c.classList.add('on');
  } else {
    for (const b of s.querySelectorAll('.wf-blk')) if (near.has(b.dataset.id)) b.classList.add('on');
    for (const p of s.querySelectorAll(`.wf-chip[data-b="${CSS.escape(id)}"]`)) p.classList.add('on');
  }
}

function wirePointer() {
  const s = svg();
  const pts = new Map();
  let moved = 0;
  let pinch = 0;
  s.addEventListener('pointerover', (e) => {
    if (pts.size) return; // arrastrando
    const lod = Number(s.dataset.lod);
    const target = (lod > 1 && e.target.closest('.wf-card')) || e.target.closest('.wf-blk');
    setFocus(target || null);
  });
  s.addEventListener('pointerleave', () => setFocus(null));
  s.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAnimationFrame(anim);
    zoomAt(Math.exp(-e.deltaY * 0.0015), toCanvas(e.clientX, e.clientY));
  }, { passive: false });
  s.addEventListener('pointerdown', (e) => {
    try { s.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    cancelAnimationFrame(anim);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    s.classList.add('drag');
  });
  s.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, cur);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(d / pinch, toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2));
      pinch = d;
      moved += 10;
      return;
    }
    const r = s.getBoundingClientRect();
    moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
    setView({ ...vb, x: vb.x - ((cur.x - prev.x) / r.width) * vb.w, y: vb.y - ((cur.y - prev.y) / r.height) * vb.h });
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (!pts.size) s.classList.remove('drag'); };
  s.addEventListener('pointerup', (e) => {
    up(e);
    if (moved > 6) return;
    const lod = Number(s.dataset.lod);
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const target = hit && (lod === 1 ? hit.closest('.wf-zoomable') : hit.closest('.wf-card') || hit.closest('.wf-zoomable'));
    // De cerca (detalle), una pieza enseña su archivo en el Explorador; si no, se acerca.
    if (target && lod === 3 && target.classList.contains('wf-card') && target.dataset.file && current) {
      api.workflowReveal(current.tabId, target.dataset.file);
      return;
    }
    if (target && target.dataset.zoom) zoomToBox(target.dataset.zoom.split(' ').map(Number), target.classList.contains('wf-card'));
  });
  s.addEventListener('pointercancel', up);
  s.addEventListener('dblclick', fit);
}

// ── Estado ─────────────────────────────────────────────────────────────

function renderStatus() {
  const snap = current && current.snap;
  if (!snap) return;
  const now = Date.now();
  const working = snap.status === 'working';
  const empty = $('#wf-empty');
  empty.hidden = Boolean(snap.map);
  if (!snap.map) {
    const failed = snap.status === 'error';
    $('#wf-empty').classList.toggle('failed', failed);
    $('#wf-empty-title').textContent = failed ? 'No se ha podido dibujar el mapa' : 'Dibujando el mapa del proyecto…';
    $('#wf-empty-text').textContent = failed
      ? snap.error
      : snap.waiting
        ? 'En cola: se está terminando el mapa de otro proyecto (se hacen de uno en uno). Puedes cerrar esta ventana y seguir trabajando.'
        : `${snap.using ? `Lo hace ${snap.using}` : 'Preparando lo que se le enseña al modelo'}${snap.status === 'working' && snap.startedAt ? ` · ${mmss(now - snap.startedAt)}` : ''}. Suele tardar entre uno y tres minutos. Puedes cerrar esta ventana y seguir trabajando: el mapa estará listo al volver, y tu sesión de Claude no se entera.`;
    $('#wf-retry').hidden = !failed;
  }
  const parts = [];
  if (snap.map && working) parts.push(`Actualizando con ${snap.using || 'el modelo'}… ${mmss(now - snap.startedAt)}`);
  else if (snap.map) {
    parts.push(`Hecho por ${snap.engine || 'el modelo'} a las ${hhmm(snap.at)}`);
    if (snap.error) parts.push(`no se ha podido actualizar: ${snap.error}`);
    if (snap.paused) parts.push(`${snap.pending} archivos cambiados sin aplicar: tu plan de Claude va por encima del 80 %`);
    else if (snap.next) parts.push(`busca cambios en ${mmss(snap.next - now)}`);
  }
  if (snap.map && snap.partial) parts.push('proyecto grande: hecho con la parte principal del código');
  if (snap.map && snap.oldGuide && !working) parts.push('hecho con una guía anterior: se completa solo al entrar en el proyecto');
  $('#wf-status').textContent = parts.join(' · ');
  $('#wf-status').hidden = !parts.length;
  $('#wf-redo').disabled = working;
}

// El stack tecnológico, tras su botón (cerrado de entrada: el mapa usa toda la ventana):
// nombre, versión y para qué se usa.
function showStack(open) {
  $('#wf-stack').hidden = !open;
  $('#wf-stack-btn').setAttribute('aria-expanded', String(open));
}
function renderStack(stack) {
  const button = $('#wf-stack-btn');
  button.hidden = !stack.length;
  button.querySelector('span').textContent = 'Stack Tecnológico';
  button.title = `Con qué está hecho el proyecto: ${stack.length} ${stack.length === 1 ? 'pieza' : 'piezas'}`;
  showStack(false);
  $('#wf-stack-list').replaceChildren(...stack.map((s) => {
    const li = el('li');
    li.append(el('b', '', s.nombre), el('span', 'v', s.version || ''), el('span', 'p', s.para || ''));
    li.title = [s.nombre, s.version, s.para].filter(Boolean).join(' · ');
    return li;
  }));
}

function show(snap) {
  if (!current) return;
  current.key = snap.key;
  current.snap = snap;
  const tab = byId(current.tabId);
  $('#wf-proj').textContent = tab ? `· ${tab.name}` : '';
  $('#wf-sum').textContent = snap.map ? snap.map.resumen : 'Cómo funciona este proyecto, en un mapa. Lo dibuja un modelo aparte, sin tocar tu sesión de Claude.';
  if (snap.map && current.drawnAt !== snap.at) {
    current.drawnAt = snap.at;
    draw(snap.map);
    renderStack(snap.map.stack || []);
  }
  renderStatus();
}

// Al entrar en un proyecto (la pestaña activa cambia, también al arrancar), el mapa se
// prepara en segundo plano: así, al pulsar «Workflow», ya está. Lo llama layout().
let entered = null;
export function enterProject() {
  const tab = byId(S.activeId);
  if (!tab || tab.id === entered) return;
  entered = tab.id;
  api.workflowEnter(tab.id, tab.cwd);
}

async function openWorkflow() {
  const tab = byId(S.activeId);
  if (!tab) return;
  const dialog = $('#dlg-workflow');
  current = { tabId: tab.id, key: null, snap: null, drawnAt: null };
  L = null;
  svg().innerHTML = '';
  $('#wf-crumb').textContent = '';
  showStack(false);
  $('#wf-stack-btn').hidden = true;
  if (!dialog.open) dialog.showModal();
  let snap = null;
  try { snap = await api.workflowOpen(tab.id); } catch { /* sin respuesta */ }
  if (!snap) snap = { key: null, map: null, status: 'error', error: 'Esta pestaña no tiene una carpeta de proyecto.' };
  if (!current || current.tabId !== tab.id) return; // se ha cerrado mientras tanto
  // Un aviso del mismo proyecto puede llegar antes que la respuesta: vale el más reciente.
  const early = current.early;
  show(early && early.key === snap.key ? early : snap);
  clearInterval(ticker);
  ticker = setInterval(renderStatus, 1000);
}

export function wireWorkflow() {
  const dialog = $('#dlg-workflow');
  $('#btn-workflow').addEventListener('click', openWorkflow);
  $('#wf-close').addEventListener('click', () => dialog.close());
  $('#wf-fit').addEventListener('click', fit);
  $('#wf-in').addEventListener('click', () => zoomStep(1));
  $('#wf-out').addEventListener('click', () => zoomStep(-1));
  const redo = async () => {
    if (!current) return;
    try { show(await api.workflowRedo(current.tabId)); } catch { /* llegará con la siguiente actualización */ }
  };
  $('#wf-redo').addEventListener('click', redo);
  $('#wf-retry').addEventListener('click', redo);
  // El recuadro del stack: se abre y se cierra con su botón, al pulsar fuera o con Esc (que
  // entonces no cierra la ventana).
  $('#wf-stack-btn').addEventListener('click', () => showStack($('#wf-stack').hidden));
  dialog.addEventListener('pointerdown', (e) => {
    if (!$('#wf-stack').hidden && !e.target.closest('#wf-stack, #wf-stack-btn')) showStack(false);
  });
  dialog.addEventListener('cancel', (e) => {
    if ($('#wf-stack').hidden) return;
    e.preventDefault();
    showStack(false);
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.target.closest('button')) return;
    if (e.key === '+' || e.key === '=') zoomStep(1);
    else if (e.key === '-') zoomStep(-1);
    else if (e.key === '0') fit();
  });
  dialog.addEventListener('close', () => {
    clearInterval(ticker);
    cancelAnimationFrame(anim);
    if (current) api.workflowClose(current.tabId);
    current = null;
    requestAnimationFrame(focusTerminal);
  });
  new ResizeObserver(() => {
    if (!current || !L) return;
    const k = base.w / vb.w;
    const c = center();
    base = fitBox();
    computeSteps();
    const w = base.w / k;
    const r = stage().getBoundingClientRect();
    const h = w / (r.width / Math.max(1, r.height));
    vb = { x: c.x - w / 2, y: c.y - h / 2, w, h };
    apply();
  }).observe(stage());
  wirePointer();
  api.onWorkflow((snap) => {
    if (!current || !snap) return;
    if (current.key === null) current.early = snap; // todavía sin la respuesta de workflowOpen
    else if (snap.key === current.key) show(snap);
  });
}
