// ── Contexto del proyecto ────────────────────────────────────────
// Cada pestaña puede tener una nota y una lista de documentos y carpetas que
// Claude tiene presentes en todas sus sesiones. Aquí se editan; el proceso
// principal (src/main/context.js) se los da a Claude.
import { SVG } from './constants.js';
import { api, el } from './dom.js';
import { imageLabelCounts, learnImageLabels, formatSize } from './preview.js';
import { renderToolbar } from './render.js';
import { S, views, save, toast } from './state.js';
import { joinPaths } from './terminals.js';
import { fitView, focusTerminal } from './views.js';

const MAX_CONTEXT_ITEMS = 100;
const emptyContext = () => ({ note: '', items: [] });

export function cleanContext(raw) {
  const ctx = emptyContext();
  if (!raw || typeof raw !== 'object') return ctx;
  ctx.note = typeof raw.note === 'string' ? raw.note.slice(0, 8000) : '';
  const seen = new Set();
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item) continue;
    if (typeof item.url === 'string') {
      // Enlace web: { url, title, warning, enabled }.
      const url = webUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      ctx.items.push({
        url,
        title: typeof item.title === 'string' ? item.title.slice(0, 160) : null,
        warning: item.warning === 'login' || item.warning === 'error' ? item.warning : null,
        enabled: item.enabled !== false,
      });
    } else if (typeof item.path === 'string' && item.path && !seen.has(item.path.toLowerCase())) {
      seen.add(item.path.toLowerCase());
      ctx.items.push({ path: item.path, enabled: item.enabled !== false });
    }
    if (ctx.items.length >= MAX_CONTEXT_ITEMS) break;
  }
  return ctx;
}

// La dirección normalizada si es un enlace http(s); si no, null.
function webUrl(text) {
  try {
    const url = new URL(String(text).trim());
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function ensureContext(tab) {
  if (!tab.context) tab.context = emptyContext();
  return tab.context;
}

// Lo que indica el número del botón «Contexto»: documentos activos y la nota.
export function contextCount(tab) {
  const ctx = tab.context || emptyContext();
  return ctx.items.filter((i) => i.enabled !== false).length + (ctx.note.trim() ? 1 : 0);
}

export function hasFiles(e) {
  return Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
}

export function droppedPaths(e) {
  return [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
}

// Un enlace arrastrado desde el navegador.
function hasLink(e) {
  return Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('text/uri-list');
}

function droppedLinks(e) {
  const list = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const plain = (e.dataTransfer.getData('text/plain') || '').trim();
  return (list.length ? list : [plain]).map(webUrl).filter(Boolean);
}

const CTX_HOW = {
  carpeta: 'Claude puede leer todo lo que hay dentro',
  PDF: 'Claude lo lee cuando le hace falta',
  Word: 'Pasado a texto; Claude lo lee cuando le hace falta',
  imagen: 'Claude la mira cuando le hace falta',
  texto: 'Claude lo lee cuando le hace falta',
  archivo: 'Claude intentará abrirlo con sus herramientas',
  web: 'Claude la abre cuando le hace falta',
};
const CTX_KIND = { PDF: 'PDF', Word: 'Word', imagen: 'Imagen', texto: 'Texto' };
const FOLDER_ICON = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5h4.2l1.3 1.6h7.5v6.9h-13z"/></svg>';
const WEB_ICON = '<svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c1.9 1.8 2.8 3.9 2.8 6.3S9.9 12.5 8 14.3M8 1.7C6.1 3.5 5.2 5.6 5.2 8s.9 4.5 2.8 6.3"/></svg>';
const MISSING_ICON = '<svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.8M8 11.1v.1"/></svg>';

export function buildContextPanel(view) {
  const panel = el('aside', 'ctx');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Contexto del proyecto');

  const head = el('div', 'ctx-head');
  const titles = el('div', 'ctx-titles');
  view.ctxTitle = el('h2', '', 'Contexto del proyecto');
  view.ctxSub = el('p', 'ctx-sub', `Claude lo tiene presente en cada sesión de «${view.tab.name}»`);
  titles.append(view.ctxTitle, view.ctxSub);
  const close = el('button', 'icon-btn ctx-close');
  close.innerHTML = SVG.close;
  close.title = 'Cerrar el panel';
  close.setAttribute('aria-label', 'Cerrar el panel de contexto');
  close.addEventListener('click', () => toggleContext(view, false));
  head.append(titles, close);

  const body = el('div', 'ctx-body');
  const noteLabel = el('label', 'ctx-label', 'Nota para Claude');
  view.ctxNote = el('textarea', 'ctx-note');
  view.ctxNote.id = `ctx-note-${view.tab.id}`;
  noteLabel.htmlFor = view.ctxNote.id;
  view.ctxNote.placeholder = 'De qué va el proyecto, normas, cómo quieres que responda…';
  view.ctxNote.maxLength = 8000;
  view.ctxNote.addEventListener('input', () => {
    ensureContext(view.tab).note = view.ctxNote.value;
    contextChanged(view, false);
  });
  view.ctxDocsLabel = el('div', 'ctx-label', 'Documentos y enlaces');
  view.ctxItems = el('div', 'ctx-items');
  const drop = el('div', 'ctx-drop');
  const row = el('div', 'ctx-drop-row');
  const addFiles = el('button', 'btn', 'Añadir archivos…');
  const addFolder = el('button', 'btn', 'Añadir carpeta…');
  const addLink = el('button', 'btn', 'Añadir enlace…');
  addFiles.addEventListener('click', async () => addToContext(view, await api.contextPick('files')));
  addFolder.addEventListener('click', async () => addToContext(view, await api.contextPick('folder')));
  row.append(addFiles, addFolder, addLink);
  // Campo para escribir o pegar la dirección de una página web.
  const linkForm = el('form', 'ctx-link-form');
  linkForm.hidden = true;
  linkForm.noValidate = true;
  const linkInput = el('input');
  linkInput.type = 'url';
  linkInput.placeholder = 'https://…';
  linkInput.spellcheck = false;
  linkInput.setAttribute('aria-label', 'Dirección de la página web');
  const linkOk = el('button', 'btn', 'Añadir');
  linkOk.type = 'submit';
  const linkCancel = el('button', 'btn', 'Cancelar');
  linkCancel.type = 'button';
  linkForm.append(linkInput, linkOk, linkCancel);
  const closeLinkForm = () => { linkForm.hidden = true; row.hidden = false; };
  addLink.addEventListener('click', () => {
    row.hidden = true;
    linkForm.hidden = false;
    linkInput.value = '';
    linkInput.focus();
  });
  linkCancel.addEventListener('click', closeLinkForm);
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeLinkForm(); } });
  linkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addLinks(view, linkInput.value.split(/\s+/).filter(Boolean))) closeLinkForm();
    else linkInput.focus();
  });
  drop.append(el('span', '', 'Arrastra aquí archivos, carpetas o enlaces'), row, linkForm);
  body.append(noteLabel, view.ctxNote, view.ctxDocsLabel, view.ctxItems, drop);

  // Vista alternativa: el texto exacto que recibe Claude.
  const sent = el('div', 'ctx-body');
  sent.hidden = true;
  view.ctxPrompt = el('pre', 'ctx-prompt');
  sent.append(el('div', 'ctx-label', 'Así se lo cuenta ClaudHome a Claude'), view.ctxPrompt);
  view.ctxSent = sent;

  const foot = el('div', 'ctx-foot');
  const toggleSent = el('button', 'ctx-link', 'Ver lo que recibe Claude →');
  toggleSent.addEventListener('click', () => {
    const showSent = sent.hidden;
    sent.hidden = !showSent;
    body.hidden = showSent;
    toggleSent.textContent = showSent ? '← Volver al contexto' : 'Ver lo que recibe Claude →';
    view.ctxTitle.textContent = showSent ? 'Lo que recibe Claude' : 'Contexto del proyecto';
    if (showSent) refreshContextPrompt(view);
  });
  foot.append(toggleSent, el('span', '', 'Se aplica al empezar la sesión. Si lo cambias con la sesión abierta, Claude se entera con tu siguiente mensaje.'));

  panel.append(head, body, sent, foot);

  // Soltar archivos, carpetas o enlaces (desde el navegador) sobre el panel los añade.
  panel.addEventListener('dragover', (e) => {
    if (!hasFiles(e) && !hasLink(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    panel.classList.add('drag');
  });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag'); });
  panel.addEventListener('drop', (e) => {
    if (!hasFiles(e) && !hasLink(e)) return;
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove('drag');
    if (hasFiles(e)) addToContext(view, droppedPaths(e));
    else addLinks(view, droppedLinks(e));
  });
  return panel;
}

// Muestra u oculta el panel según la pestaña y, si se ve, lo rellena.
export function syncContextPanel(view) {
  view.ctxEl.hidden = !view.tab.contextOpen;
  if (!view.tab.contextOpen) return;
  if (document.activeElement !== view.ctxNote) view.ctxNote.value = ensureContext(view.tab).note;
  renderContextItems(view);
  if (!view.ctxSent.hidden) refreshContextPrompt(view);
}

export function toggleContext(view = views.get(S.activeId), open) {
  if (!view) return;
  view.tab.contextOpen = open === undefined ? !view.tab.contextOpen : Boolean(open);
  syncContextPanel(view);
  renderToolbar();
  save();
  requestAnimationFrame(() => {
    fitView(view);
    if (!view.tab.contextOpen && view.tab.id === S.activeId) focusTerminal();
  });
}

async function refreshContextPrompt(view) {
  let text = '';
  try { text = await api.contextPrompt(view.tab.id, view.tab.name, ensureContext(view.tab)); } catch { /* sin vista */ }
  view.ctxPrompt.textContent = text || 'Esta pestaña no tiene contexto: Claude no recibe nada adicional.';
}

const contextTimers = new Map();

// Algo ha cambiado: se guarda, se repinta y se avisa al proceso principal (que
// se lo dará a Claude en su siguiente mensaje si la sesión está abierta).
function contextChanged(view, listChanged = true) {
  save();
  renderToolbar();
  if (listChanged) renderContextItems(view);
  clearTimeout(contextTimers.get(view.tab.id));
  contextTimers.set(view.tab.id, setTimeout(() => {
    api.contextUpdate(view.tab.id, view.tab.name, ensureContext(view.tab)).catch(() => { /* se aplicará al reiniciar */ });
    if (!view.ctxSent.hidden) refreshContextPrompt(view);
  }, 400));
}

export function addToContext(view, paths) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return;
  const ctx = ensureContext(view.tab);
  const have = new Set(ctx.items.filter((i) => i.path).map((i) => i.path.toLowerCase()));
  let added = 0;
  for (const p of list) {
    if (have.has(p.toLowerCase()) || ctx.items.length >= MAX_CONTEXT_ITEMS) continue;
    ctx.items.push({ path: p, enabled: true });
    have.add(p.toLowerCase());
    added += 1;
  }
  contextChanged(view);
  if (!view.tab.contextOpen) toggleContext(view, true);
  toast(added === 0 ? 'Eso ya estaba en el contexto del proyecto.'
    : added === 1 ? 'Añadido al contexto del proyecto.' : `${added} elementos añadidos al contexto del proyecto.`);
}

// Añade enlaces web. Devuelve false si alguno no era una dirección válida.
export function addLinks(view, texts) {
  const ctx = ensureContext(view.tab);
  const have = new Set(ctx.items.filter((i) => i.url).map((i) => i.url));
  const added = [];
  let invalid = 0;
  for (const text of texts || []) {
    const url = webUrl(text);
    if (!url) { invalid += 1; continue; }
    if (have.has(url) || ctx.items.length >= MAX_CONTEXT_ITEMS) continue;
    const item = { url, title: null, warning: null, enabled: true };
    ctx.items.push(item);
    have.add(url);
    added.push(item);
  }
  if (!added.length) {
    toast(invalid ? 'Eso no es una dirección web: tiene que empezar por http:// o https://.' : 'Ese enlace ya estaba en el contexto del proyecto.');
    return invalid === 0;
  }
  contextChanged(view);
  if (!view.tab.contextOpen) toggleContext(view, true);
  toast((added.length === 1 ? 'Enlace añadido al contexto del proyecto.' : `${added.length} enlaces añadidos al contexto del proyecto.`)
    + (invalid ? ` ${invalid === 1 ? 'Uno no era' : `${invalid} no eran`} una dirección web y no se ha añadido.` : ''));
  // Título de cada página y aviso si pide iniciar sesión (Claude no podría leerla).
  for (const item of added) {
    api.contextLink(item.url).then((info) => {
      if (!info) return;
      item.title = info.title || null;
      item.warning = info.login ? 'login' : info.ok ? null : 'error';
      contextChanged(view);
    }).catch(() => { /* sin título */ });
  }
  return invalid === 0;
}

async function renderContextItems(view) {
  const ctx = ensureContext(view.tab);
  const token = (view.ctxToken || 0) + 1;
  view.ctxToken = token;
  view.ctxDocsLabel.textContent = ctx.items.length ? `Documentos y enlaces · ${ctx.items.length}` : 'Documentos y enlaces';
  if (!ctx.items.length) {
    view.ctxItems.replaceChildren(el('p', 'ctx-empty', 'Todavía no hay nada. Añade PDF, Word, imágenes, textos, carpetas o enlaces web que ayuden a Claude a entender el proyecto.'));
    return;
  }
  let infos = [];
  try { infos = await api.contextDescribe(ctx.items); } catch { /* se pinta sin datos */ }
  if (token !== view.ctxToken) return; // ya hay un repintado más nuevo
  view.ctxItems.replaceChildren(...ctx.items.map((item, i) => contextCard(view, item, infos[i] || { path: item.path, name: item.path, exists: false })));
}

function contextCard(view, item, info) {
  const on = item.enabled !== false;
  const target = item.url || item.path; // dirección web o ruta del archivo
  const card = el('div', 'ctx-item');
  card.classList.toggle('off', !on);
  card.classList.toggle('missing', !info.exists);
  card.title = info.exists ? `${target}\n${item.url ? 'Doble clic para abrirla en el navegador' : 'Doble clic para abrirlo'}` : target;
  const thumb = el('div', 'ctx-thumb');
  const meta = el('span', 'ctx-meta');
  const how = el('span', 'ctx-how');
  const body = el('div', 'ctx-info');
  body.append(el('strong', '', info.name || target), meta, how);

  if (info.isLink) {
    thumb.innerHTML = WEB_ICON;
    thumb.dataset.kind = 'web';
    meta.textContent = `Web · ${info.host}`;
    const warning = item.warning === 'login' ? 'Parece que pide iniciar sesión: Claude no podrá leerla.'
      : item.warning === 'error' ? 'No se ha podido abrir desde aquí; puede que Claude tampoco.' : '';
    card.classList.toggle('missing', Boolean(warning));
    how.textContent = !on ? 'Desactivado: Claude no la recibe' : warning || CTX_HOW.web;
  } else if (!info.exists) {
    thumb.innerHTML = MISSING_ICON;
    thumb.dataset.kind = 'missing';
    meta.textContent = 'No encontrado';
    how.textContent = '¿Se ha movido o borrado? Claude no lo recibe.';
  } else if (info.isDir) {
    thumb.innerHTML = FOLDER_ICON;
    thumb.dataset.kind = 'dir';
    meta.textContent = `Carpeta · ${info.many ? 'más de 2000 archivos' : `${info.files} archivo${info.files === 1 ? '' : 's'}`}`;
    how.textContent = on ? CTX_HOW.carpeta : 'Desactivada: Claude no la recibe';
  } else {
    thumb.dataset.kind = 'file';
    const ext = (info.name.includes('.') ? info.name.split('.').pop() : '').toUpperCase();
    meta.textContent = `${CTX_KIND[info.kind] || ext || 'Archivo'} · ${formatSize(info.size)}`;
    how.textContent = on ? (CTX_HOW[info.kind] || CTX_HOW.archivo) : 'Desactivado: Claude no lo recibe';
    // Miniatura y datos de la vista previa (páginas de un PDF, tamaño de una imagen).
    api.preview(item.path).then((data) => {
      if (!data || !card.isConnected) return;
      if (data.kind === 'text') {
        thumb.dataset.kind = 'text';
        thumb.replaceChildren(...Array.from({ length: 6 }, () => el('i')));
      } else if (data.image) {
        const img = el('img');
        img.alt = '';
        img.src = data.image;
        thumb.dataset.kind = data.kind;
        thumb.replaceChildren(img);
      }
      const extra = [];
      if (data.pages) extra.push(data.pages === 1 ? '1 página' : `${data.pages} páginas`);
      if (data.width && data.height) extra.push(`${data.width} × ${data.height}`);
      if (extra.length) meta.textContent += ` · ${extra.join(' · ')}`;
    }).catch(() => { /* sin miniatura */ });
  }

  const side = el('div', 'ctx-side');
  const toggle = el('button', 'ctx-switch');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.setAttribute('aria-label', `${on ? 'Desactivar' : 'Activar'} ${info.name || target}`);
  toggle.title = on ? 'Activado: Claude lo recibe. Pulsa para desactivarlo sin quitarlo.' : 'Desactivado. Pulsa para activarlo.';
  toggle.addEventListener('click', () => { item.enabled = !on; contextChanged(view); });
  const remove = el('button', 'ctx-remove');
  remove.innerHTML = SVG.close;
  remove.title = 'Quitar del contexto';
  remove.setAttribute('aria-label', `Quitar ${info.name || target} del contexto`);
  remove.addEventListener('click', () => {
    const ctx = ensureContext(view.tab);
    ctx.items = ctx.items.filter((x) => x !== item);
    contextChanged(view);
  });
  side.append(toggle, remove);
  card.append(thumb, body, side);
  if (info.exists) card.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.openPath(target); });
  return card;
}

// Soltar archivos sobre la sesión de Claude: elegir entre pegarlos en el mensaje
// (como siempre) o añadirlos al contexto del proyecto.
export function wireDropChoice(view, wrap) {
  const overlay = el('div', 'drop-choice');
  overlay.hidden = true;
  const zone = (title, text) => {
    const node = el('div', 'drop-zone');
    node.append(el('strong', '', title), el('span', '', text));
    return node;
  };
  const pasteZone = zone('Pegar en el mensaje', 'Como siempre: la ruta, la imagen o el enlace va en lo que estás escribiendo, solo para esta pregunta.');
  const ctxZone = zone('Añadir al contexto del proyecto', 'Se queda guardado en esta pestaña y Claude lo tendrá presente en todas las sesiones.');
  overlay.append(pasteZone, ctxZone);
  wrap.append(overlay);
  let hideTimer = null;
  wrap.addEventListener('dragover', (e) => {
    if (!hasFiles(e) && !hasLink(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    overlay.hidden = false;
    const target = e.target instanceof Element ? e.target.closest('.drop-zone') : null;
    pasteZone.classList.toggle('hot', target === pasteZone);
    ctxZone.classList.toggle('hot', target === ctxZone);
    // Mientras se arrastra llegan avisos sin parar; si dejan de llegar, el ratón ya no está aquí.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { overlay.hidden = true; }, 250);
  });
  wrap.addEventListener('drop', (e) => {
    if (!hasFiles(e) && !hasLink(e)) return;
    e.preventDefault();
    clearTimeout(hideTimer);
    overlay.hidden = true;
    const target = e.target instanceof Element ? e.target.closest('.drop-zone') : null;
    if (!hasFiles(e)) {
      // Un enlace arrastrado desde el navegador.
      const links = droppedLinks(e);
      if (!links.length) return;
      if (target === ctxZone) { addLinks(view, links); return; }
      view.term.paste(`${links.join(' ')} `);
      view.term.focus();
      return;
    }
    const files = droppedPaths(e);
    if (!files.length) return;
    if (target === ctxZone) { addToContext(view, files); return; }
    const before = imageLabelCounts(view.term);
    view.term.paste(joinPaths(files));
    view.term.focus();
    learnImageLabels(view, files, before);
  });
}
