// ── Botón «+», recientes y diálogo de nueva sesión ───────────────
import { SVG } from './constants.js';
import { api, $, el } from './dom.js';
import { S, info, swatch } from './state.js';
import { addTab } from './tabs.js';

export function renderRecents() {
  const list = $('#recents');
  list.replaceChildren(...S.recents.map((recent, index) => {
    const row = el('div', 'recent');
    const open = el('button', 'recent-open');
    open.dataset.index = String(index);
    const text = el('span', 'recent-text');
    text.append(el('span', 'recent-name', recent.name), el('span', 'recent-path', recent.cwd));
    open.append(swatch(recent.color), text);
    const forget = el('button', 'recent-forget');
    forget.dataset.forget = String(index);
    forget.setAttribute('aria-label', `Quitar ${recent.name} de recientes`);
    forget.title = 'Quitar de recientes';
    forget.innerHTML = SVG.close;
    row.append(open, forget);
    return row;
  }));
  $('#recents-note').textContent = S.recents.length
    ? 'Se reabren con su nombre y continúan su conversación.'
    : 'Aquí aparecerán las sesiones que cierres.';
}

export function openPlusMenu() {
  const menu = $('#plus-menu');
  renderRecents();
  menu.classList.remove('flip');
  menu.hidden = false;
  menu.classList.toggle('flip', menu.getBoundingClientRect().right > window.innerWidth - 8);
  $('#btn-plus').setAttribute('aria-expanded', 'true');
  $('#plus-new').focus();
}

export function closePlusMenu() {
  const menu = $('#plus-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('#btn-plus').setAttribute('aria-expanded', 'false');
}

export function reopenRecent(index) {
  const recent = S.recents[index];
  if (!recent) return;
  S.recents.splice(index, 1);
  closePlusMenu();
  addTab(recent, 'resume');
}

export const baseName = (folder) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
export const cleanFolder = (value) => value.trim().replace(/^"(.*)"$/, '$1').trim();
let nameTouched = false;
export const setNameTouched = (value) => { nameTouched = value; };

export function openNewDialog() {
  closePlusMenu();
  const dialog = $('#dlg-new');
  if (dialog.open) return;
  $('#f-folder').value = '';
  $('#f-name').value = '';
  $('#f-error').hidden = true;
  nameTouched = false;
  $('#f-colors input[value=""]').checked = true;
  $('#form-new input[name="mode"][value="continue"]').checked = true;
  $('#f-shell').value = info.shells.some((s) => s.key === S.lastShell) ? S.lastShell : 'powershell';
  dialog.showModal();
  $('#f-folder').focus();
}

export function suggestName() {
  if (nameTouched) return;
  const folder = cleanFolder($('#f-folder').value);
  $('#f-name').value = folder ? baseName(folder) : '';
}

export async function submitNew(event) {
  event.preventDefault();
  const folder = cleanFolder($('#f-folder').value);
  const error = $('#f-error');
  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
    $('#f-folder').focus();
  };
  if (!folder) { fail('Elige la carpeta donde trabajará Claude.'); return; }
  if (!(await api.isDir(folder))) { fail('Esa carpeta no existe. Revisa la ruta o usa «Examinar…».'); return; }
  const form = $('#form-new');
  const fields = {
    cwd: folder.replace(/[\\/]+$/, '') || folder,
    name: $('#f-name').value.trim() || baseName(folder),
    color: form.querySelector('input[name="color"]:checked').value,
    shell: $('#f-shell').value,
  };
  if (/^[a-zA-Z]:$/.test(fields.cwd)) fields.cwd += '\\'; // raíz de una unidad
  const mode = form.querySelector('input[name="mode"]:checked').value;
  S.lastShell = fields.shell;
  $('#dlg-new').close();
  addTab(fields, mode);
}
