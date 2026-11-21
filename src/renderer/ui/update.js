// ── Actualización ────────────────────────────────────────────────
// El proceso principal comprueba GitHub; aquí solo se pinta el botón y se
// avisa de cómo va.
import { SVG } from './constants.js';
import { api, $, el } from './dom.js';
import { toast } from './state.js';
import { focusTerminal } from './views.js';

let updateInfo = null;

export function renderUpdate(info) {
  const prev = updateInfo;
  if (info) updateInfo = info;
  const u = updateInfo;
  if (!u) return;
  if (u.status === 'error' && u.error && !(prev && prev.status === 'error' && prev.error === u.error)) {
    toast(`No se pudo actualizar: ${u.error}`);
  }
  const button = $('#update-btn');
  button.hidden = !u.latest || !['available', 'working', 'ready', 'error'].includes(u.status);
  if (button.hidden) return;
  button.dataset.state = u.status;
  button.setAttribute('aria-disabled', String(u.status === 'working'));
  const icon = $('#update-icon');
  const label = $('#update-label');
  if (u.status === 'working') {
    icon.innerHTML = SVG.working;
    label.textContent = `${u.step}…`;
    button.title = `Descargando ClaudHome ${u.latest} en segundo plano. Puedes seguir trabajando.`;
  } else if (u.status === 'ready') {
    icon.innerHTML = SVG.update;
    label.textContent = 'Reiniciar para actualizar';
    button.title = `ClaudHome ${u.latest} está lista. Pulsa para cerrar y volver a abrir ClaudHome con la versión nueva: tus pestañas se restauran.`;
  } else {
    icon.innerHTML = SVG.update;
    label.textContent = `Actualizar a v${u.latest}`;
    button.title = u.status === 'error'
      ? `El último intento ha fallado: ${u.error} Pulsa para reintentar.`
      : `Hay una versión nueva de ClaudHome en GitHub (tienes la ${u.current}). Pulsa para ver qué cambia y decidir si actualizar.`;
  }
}

// Un punto del historial de cambios: lo que va entre `comillas invertidas` se ve como código.
function appendInline(node, text) {
  String(text).split('`').forEach((part, i) => {
    if (part) node.append(i % 2 ? el('code', '', part) : document.createTextNode(part));
  });
}

function fillChanges(changes) {
  const n = changes.versions.length;
  $('#upd-summary').textContent = `Tienes la versión ${changes.current}. `
    + (n > 1 ? `Hay ${n} versiones nuevas, hasta la ${changes.latest}. Esto es lo que cambia:` : `Esto es lo que trae la ${changes.latest}:`);
  const box = $('#upd-changes');
  if (!n) {
    box.replaceChildren(el('p', 'upd-empty', changes.error || 'No hay notas de cambios para estas versiones.'));
    return;
  }
  box.replaceChildren(...changes.versions.map((v) => {
    const section = el('section', 'upd-version');
    const head = el('h2', '', `v${v.version}`);
    if (v.date) head.append(el('span', 'upd-date', v.date));
    const list = el('ul');
    for (const item of v.items) {
      const li = el('li');
      appendInline(li, item);
      list.append(li);
    }
    if (!v.items.length) list.append(el('li', '', 'Sin notas.'));
    section.append(head, list);
    return section;
  }));
}

// Enseña los cambios de las versiones pendientes y espera la respuesta:
// true con «Update»; false con «Cancel» o Esc (no se toca nada).
function askToUpdate() {
  const dialog = $('#dlg-update');
  const ok = $('#upd-ok');
  const cancel = $('#upd-cancel');
  $('#upd-summary').textContent = `Tienes la versión ${updateInfo.current}; la última es la ${updateInfo.latest}.`;
  $('#upd-changes').replaceChildren(el('p', 'upd-empty', 'Cargando la lista de cambios…'));
  ok.disabled = true;
  dialog.showModal();
  cancel.focus();
  const fallback = { current: updateInfo.current, latest: updateInfo.latest, versions: [], error: 'No se ha podido descargar la lista de cambios.' };
  api.updateChanges().catch(() => fallback).then((changes) => {
    if (!dialog.open) return;
    fillChanges(changes || fallback);
    ok.disabled = false;
    ok.focus();
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = (accepted) => {
      if (done) return;
      done = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onCancel);
      if (dialog.open) dialog.close();
      resolve(accepted);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onCancel);
  });
}

export async function clickUpdate() {
  if (!updateInfo || $('#dlg-update').open) return;
  if (updateInfo.status === 'ready') { api.updateRestart(); return; }
  if (updateInfo.status === 'working') return;
  const accepted = await askToUpdate();
  if (accepted) {
    renderUpdate(await api.updateStart());
    if (updateInfo.status === 'working') {
      toast(`Descargando ClaudHome ${updateInfo.latest} en segundo plano. Puedes seguir trabajando; al terminar, ClaudHome se reiniciará para instalarla.`);
    }
  }
  focusTerminal();
}
