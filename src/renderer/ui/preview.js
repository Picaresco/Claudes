// ── Vista previa de archivos ─────────────────────────────────────
// Al pasar el ratón sobre la ruta de un archivo que existe, o sobre el
// [Image #n] en que Claude Code convierte una imagen pegada, aparece la imagen entera, la
// primera página o las primeras líneas, sin más datos. Ctrl+clic lo abre.
import { api, $, el } from './dom.js';
import { sleep } from './state.js';
import { IMAGE_FILE } from './terminals.js';

const IMAGE_LABEL = /\[Image #(\d+)\]/g;
const PATH_STOP = /[\s"<>|*?]/;
const TRAILING = /[.,;:!?)\]}'»]+$/;

// Cuántas veces aparece cada [Image #n] en la pantalla de la terminal.
export function imageLabelCounts(term) {
  const counts = new Map();
  const buffer = term.buffer.active;
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (const m of line.translateToString(true).matchAll(IMAGE_LABEL)) {
      const n = Number(m[1]);
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  return counts;
}

// Claude Code numera las imágenes pegadas ([Image #1], [Image #2]…) sin repetir
// número mientras dura la sesión: la etiqueta que aparece tras pegar es la de la
// imagen pegada. Al reiniciar Claude se olvidan (la numeración puede volver a empezar).
export async function learnImageLabels(view, files, before) {
  const images = files.filter((file) => IMAGE_FILE.test(file));
  if (!images.length || !before) return;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(150);
    const now = imageLabelCounts(view.term);
    const fresh = [...now.keys()].filter((n) => now.get(n) > (before.get(n) || 0)).sort((a, b) => a - b);
    if (fresh.length >= images.length || attempt === 11) {
      const picked = fresh.slice(-images.length);
      const offset = images.length - picked.length;
      picked.forEach((n, i) => view.images.set(n, images[offset + i]));
      return;
    }
  }
}

// Texto de una fila (y empieza en 1) y la columna de cada uno de sus caracteres.
function rowText(term, y) {
  const buffer = term.buffer.active;
  const line = buffer.getLine(y - 1);
  if (!line) return null;
  const cell = buffer.getNullCell();
  let text = '';
  const cols = [];
  for (let x = 0; x < line.length; x += 1) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue; // segunda mitad de un carácter ancho
    const chars = cell.getChars() || ' ';
    for (let k = 0; k < chars.length; k += 1) { text += chars[k]; cols.push(x); }
  }
  const trimmed = text.replace(/\s+$/, '');
  return { y, text: trimmed, cols: cols.slice(0, trimmed.length) };
}

// Rutas absolutas de Windows en una fila, entre comillas o sueltas. A las
// sueltas se les prueba a añadir las palabras siguientes, por si llevan espacios.
// `open` = llega al final de la fila y puede seguir en la siguiente.
function pathCandidates(text) {
  const found = [];
  const quoted = [];
  for (const m of text.matchAll(/"([A-Za-z]:[\\/][^"]*)("?)/g)) {
    const start = m.index + 1;
    quoted.push([m.index, m.index + m[0].length]);
    found.push({ start, quoted: true, open: !m[2], variants: [{ value: m[1], end: start + m[1].length }] });
  }
  for (const m of text.matchAll(/[A-Za-z]:[\\/]/g)) {
    const start = m.index;
    if (quoted.some(([a, b]) => start >= a && start < b)) continue;
    if (start > 0 && /[\w"\\/]/.test(text[start - 1])) continue;
    const variants = [];
    let from = start;
    let open = false;
    for (let words = 0; words < 5; words += 1) {
      let stop = from;
      while (stop < text.length && !PATH_STOP.test(text[stop])) stop += 1;
      const value = text.slice(start, stop).replace(/\s+$/, '').replace(TRAILING, '');
      if (value.length > 3 && !variants.some((v) => v.value === value)) variants.push({ value, end: start + value.length });
      if (stop >= text.length) { open = words === 0; break; }
      if (text[stop] !== ' ') break;
      from = stop + 1;
    }
    if (variants.length) found.push({ start, quoted: false, open, variants });
  }
  return found;
}

const rangeOf = (rowA, startIdx, rowB, endIdx) => ({
  start: { x: rowA.cols[startIdx] + 1, y: rowA.y },
  end: { x: rowB.cols[endIdx - 1] + 1, y: rowB.y },
});

// Una ruta cortada al final de `row` puede seguir al principio de `next`
// (Claude Code parte las líneas largas). Se prueba a unirlas, con y sin espacio.
function joinOptions(candidate, row, next) {
  const lead = /^[\s│>]*/.exec(next.text)[0].length;
  let to = lead;
  while (to < next.text.length && (candidate.quoted ? next.text[to] !== '"' : !PATH_STOP.test(next.text[to]))) to += 1;
  let piece = next.text.slice(lead, to);
  if (!candidate.quoted) {
    const trimmed = piece.replace(TRAILING, '');
    to -= piece.length - trimmed.length;
    piece = trimmed;
  }
  if (!piece) return [];
  const head = candidate.variants[candidate.variants.length - 1].value;
  return ['', ' '].map((glue) => ({ value: head + glue + piece, range: rangeOf(row, candidate.start, next, to) }));
}

const existsCache = new Map(); // ruta → { ok, at }

async function existingFiles(list) {
  const now = Date.now();
  const unknown = [...new Set(list)].filter((p) => { const c = existsCache.get(p); return !c || now - c.at > 15000; });
  if (unknown.length) {
    const found = new Set(await api.existingFiles(unknown));
    if (existsCache.size > 2000) existsCache.clear();
    for (const p of unknown) existsCache.set(p, { ok: found.has(p), at: now });
  }
  return new Set(list.filter((p) => existsCache.get(p) && existsCache.get(p).ok));
}

function previewLink(range, file) {
  return {
    range,
    text: file,
    decorations: { pointerCursor: false, underline: true },
    activate: (event) => { if (event.ctrlKey) { hidePreview(); api.openPath(file); } },
    hover: (event) => showPreview(file, event),
    leave: () => hidePreview(),
  };
}

export function registerPreviewLinks(term, view, isClaude) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const row = rowText(term, y);
      if (!row || !row.text) { callback(undefined); return; }
      const links = [];
      if (isClaude && view.images.size) {
        for (const m of row.text.matchAll(IMAGE_LABEL)) {
          const file = view.images.get(Number(m[1]));
          if (file) links.push(previewLink(rangeOf(row, m.index, row, m.index + m[0].length), file));
        }
      }
      // Cada grupo son las formas posibles de una misma ruta; se queda la más larga que exista.
      const groups = [];
      const next = rowText(term, y + 1);
      for (const c of pathCandidates(row.text)) {
        const options = c.variants.map((v) => ({ value: v.value, range: rangeOf(row, c.start, row, v.end) }));
        if (c.open && next && next.text) options.push(...joinOptions(c, row, next));
        groups.push(options);
      }
      const prev = rowText(term, y - 1);
      if (prev && prev.text) {
        for (const c of pathCandidates(prev.text)) {
          if (!c.open) continue;
          const options = joinOptions(c, prev, row);
          if (options.length) groups.push(options);
        }
      }
      if (!groups.length) { callback(links.length ? links : undefined); return; }
      existingFiles(groups.flat().map((o) => o.value)).then((found) => {
        for (const options of groups) {
          const hit = options.filter((o) => found.has(o.value)).pop();
          if (hit) links.push(previewLink(hit.range, hit.value));
        }
        callback(links.length ? links : undefined);
      }).catch(() => callback(links.length ? links : undefined));
    },
  });
  term.onScroll(() => hidePreview());
}

let previewToken = 0;
let previewTimer = null;

function showPreview(file, event) {
  clearTimeout(previewTimer);
  const token = ++previewToken;
  const at = { x: event.clientX, y: event.clientY };
  previewTimer = setTimeout(async () => {
    let data = null;
    try { data = await api.preview(file); } catch { /* sin vista previa */ }
    if (token !== previewToken) return;
    // Solo si hay algo que ver: un archivo sin vista previa (solo su icono) no enseña nada.
    if (data && (data.kind === 'text' || (data.image && data.kind !== 'icon'))) renderPreview(data, at);
    else hidePreview();
  }, 150);
}

// La misma vista previa, para otra parte de la interfaz (el «aquí» del panel «Actividad»).
export const previewAt = (file, event) => showPreview(file, event);

export function hidePreview() {
  clearTimeout(previewTimer);
  previewToken += 1;
  $('#preview').hidden = true;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[i]}`;
}

// Solo lo que se ve del archivo (la imagen, la página o el texto), sin nombre ni datos.
function renderPreview(data, at) {
  const card = $('#preview');
  const body = el('div', 'pv-body');
  if (data.kind === 'text') body.append(el('pre', 'pv-text', data.text));
  else {
    const img = el('img', 'pv-img');
    img.alt = data.name || '';
    img.addEventListener('load', () => placePreview(card, at));
    img.src = data.image;
    body.append(img);
  }
  card.replaceChildren(body);
  card.dataset.kind = data.kind;
  card.hidden = false;
  placePreview(card, at);
}

// Junto al puntero, sin salirse de la ventana.
function placePreview(card, at) {
  const gap = 16;
  const box = card.getBoundingClientRect();
  let x = at.x + gap;
  let y = at.y + gap;
  if (x + box.width > window.innerWidth - 8) x = Math.max(8, at.x - gap - box.width);
  if (y + box.height > window.innerHeight - 8) y = Math.max(8, at.y - gap - box.height);
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
}
