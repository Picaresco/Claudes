// ── Eventos ──────────────────────────────────────────────────────
import { renderCodex, toggleCodex, codexStatusClick } from './codex.js';
import { COLORS, SIDES } from './constants.js';
import { toggleContext } from './context.js';
import { toggleDebug } from './debug.js';
import { api, $, el } from './dom.js';
import {
  renderRecents, openPlusMenu, closePlusMenu, reopenRecent, cleanFolder, setNameTouched, openNewDialog,
  suggestName, submitNew,
} from './newtab.js';
import { optimizeProject } from './optimize.js';
import { hidePreview } from './preview.js';
import { renderTabs } from './render.js';
import { acknowledge } from './session-events.js';
import { toggleSplit, swapSides, focusSide, dropOnWorkspace } from './split.js';
import {
  S, views, info, setWinFocused, renamingId, setDraggingId, panes, byId, clamp, dialogOpen, save, swatch,
  startDrag,
} from './state.js';
import { activate, cycle, closeTab, startRename, tabMenu, moveTab } from './tabs.js';
import { closeSettings, toggleSettings } from './settings.js';
import { toggleBrief, toggleReview, toggleVoice } from './toggles.js';
import { clickUpdate } from './update.js';
import { queueFit, focusTerminal, setZoom, toggleExtra } from './views.js';

export function wireTabs() {
  const strip = $('#tabs');
  const tabOf = (event) => event.target.closest('.tab');

  strip.addEventListener('click', (e) => {
    const node = tabOf(e);
    if (!node) return;
    if (e.target.closest('.tab-close')) closeTab(node.dataset.id);
    // Con el ratón, la pestaña se activa al soltar el botón (ver más abajo);
    // aquí solo llega la activación por teclado (Intro o Espacio).
    else if (e.detail === 0 && e.target.closest('.tab-main')) activate(node.dataset.id);
  });
  strip.addEventListener('dblclick', (e) => {
    const node = tabOf(e);
    if (node && e.target.closest('.tab-main')) startRename(node.dataset.id);
  });
  strip.addEventListener('auxclick', (e) => {
    const node = tabOf(e);
    if (node && e.button === 1) { e.preventDefault(); closeTab(node.dataset.id); }
  });
  strip.addEventListener('contextmenu', (e) => {
    const node = tabOf(e);
    if (!node) return;
    e.preventDefault();
    tabMenu(node.dataset.id);
  });
  // La rueda del ratón desplaza la fila cuando no caben todas.
  strip.addEventListener('wheel', (e) => {
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += e.deltaY || e.deltaX;
  }, { passive: true });

  // Arrastre con el ratón. Dentro de la fila reordena las pestañas; soltada sobre
  // la zona de trabajo, la pestaña se coloca en ese lado (dividiendo si hace falta).
  const workspace = $('#workspace');
  const hint = $('#drop-hint');
  let drag = null;

  const clearMarks = () => {
    strip.querySelectorAll('.drop-before, .drop-after, .dragged').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragged'));
    hint.hidden = true;
  };

  const onMove = (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; // aún es un clic
      drag.active = true;
      setDraggingId(drag.id);
      document.body.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
    }
    clearMarks();
    drag.drop = null;
    const own = strip.querySelector(`.tab[data-id="${drag.id}"]`);
    if (own) own.classList.add('dragged');

    const area = workspace.getBoundingClientRect();
    if (e.clientY < area.top) {
      // Sobre la fila: se marca el hueco donde caería.
      const others = [...strip.querySelectorAll('.tab')].filter((n) => n.dataset.id !== drag.id);
      if (!others.length) return;
      let target = others[others.length - 1];
      let before = false;
      for (const node of others) {
        const box = node.getBoundingClientRect();
        if (e.clientX < box.left + box.width / 2) { target = node; before = true; break; }
      }
      target.classList.add(before ? 'drop-before' : 'drop-after');
      drag.drop = { kind: 'reorder', targetId: target.dataset.id, before };
    } else if (e.clientY < area.bottom && e.clientX >= area.left && e.clientX <= area.right && S.tabs.length > 1) {
      // Sobre la zona de trabajo: se sombrea el lado donde quedaría.
      const ratio = S.split ? (S.split.ratio || 0.5) : 0.5;
      const left = e.clientX < area.left + area.width * ratio;
      hint.style.left = left ? '0' : `${ratio * 100}%`;
      hint.style.width = `${(left ? ratio : 1 - ratio) * 100}%`;
      hint.hidden = false;
      drag.drop = { kind: 'pane', x: e.clientX };
    }
  };

  const onUp = (e) => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    const done = drag;
    drag = null;
    if (!done) return;
    if (!done.active) {
      // No se ha movido: es un clic sobre la pestaña.
      if (e.target instanceof Element && e.target.closest('#tabs')) activate(done.id);
      return;
    }
    clearMarks();
    setDraggingId(null);
    document.body.classList.remove('dragging');
    document.body.style.cursor = '';
    if (done.drop && done.drop.kind === 'pane') { dropOnWorkspace(done.id, done.drop.x); return; }
    if (done.drop && done.drop.kind === 'reorder') moveTab(done.id, done.drop.targetId, done.drop.before);
    renderTabs();
  };

  strip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || renamingId) return;
    const node = tabOf(e);
    if (!node || e.target.closest('.tab-close')) return;
    drag = { id: node.dataset.id, x: e.clientX, y: e.clientY, active: false, drop: null };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

export function wireChrome() {
  for (const side of SIDES) {
    const node = $(`.pane[data-side="${side}"]`);
    panes[side] = { el: node, head: $('.pane-head', node), body: $('.pane-body', node) };
    // Al pulsar en el panel de contexto, el foco se queda allí (no salta a la terminal).
    node.addEventListener('mousedown', (e) => focusSide(side, !(e.target instanceof Element && e.target.closest('.ctx'))), true);
  }

  $('#btn-plus').addEventListener('click', () => ($('#plus-menu').hidden ? openPlusMenu() : closePlusMenu()));
  $('#btn-settings').addEventListener('click', toggleSettings);
  $('#plus-new').addEventListener('click', openNewDialog);
  $('#empty-new').addEventListener('click', openNewDialog);
  $('#recents').addEventListener('click', (e) => {
    const forget = e.target.closest('[data-forget]');
    const open = e.target.closest('[data-index]');
    if (forget) {
      S.recents.splice(Number(forget.dataset.forget), 1);
      renderRecents();
      save();
    } else if (open) reopenRecent(Number(open.dataset.index));
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.plus-wrap')) closePlusMenu();
    if (!e.target.closest('.gear-wrap')) closeSettings();
  }, true);

  $('#btn-terminal').addEventListener('click', () => toggleExtra());
  $('#btn-context').addEventListener('click', () => toggleContext());
  $('#btn-optimize').addEventListener('click', () => { optimizeProject().catch((err) => api.log(`Optimiza: ${err.message}`)); });
  $('#btn-split').addEventListener('click', toggleSplit);
  $('#btn-swap').addEventListener('click', swapSides);
  $('#btn-folder').addEventListener('click', () => { const tab = byId(S.activeId); if (tab) api.openPath(tab.cwd); });
  $('#tb-name').addEventListener('dblclick', () => startRename(S.activeId));

  $('#divider').addEventListener('mousedown', (e) => {
    $('#divider').classList.add('dragging');
    startDrag(e, 'col-resize', (ev) => {
      if (!S.split) return;
      const box = $('#workspace').getBoundingClientRect();
      S.split.ratio = clamp((ev.clientX - box.left) / box.width, 0.2, 0.8);
      $('#workspace').style.setProperty('--ratio', String(S.split.ratio));
      queueFit();
    }, () => { $('#divider').classList.remove('dragging'); save(); });
  });

  $('#codex-chip').addEventListener('click', toggleCodex);
  $('#codex-status').addEventListener('click', codexStatusClick);
  $('#mic-btn').addEventListener('click', toggleVoice);
  $('#brief-btn').addEventListener('click', toggleBrief);
  $('#review-btn').addEventListener('click', toggleReview);
  $('#update-btn').addEventListener('click', clickUpdate);
  $('#sb-debug').addEventListener('click', toggleDebug);

  new ResizeObserver(queueFit).observe($('#workspace'));
  window.addEventListener('focus', () => {
    setWinFocused(true);
    acknowledge();
    api.codexStatus(false).then(renderCodex).catch(() => { /* se verá en la próxima comprobación */ });
  });
  window.addEventListener('blur', () => { setWinFocused(false); hidePreview(); });
  // Al escribir, la tarjeta de vista previa estorba (Ctrl solo no: sirve para abrir con Ctrl+clic).
  window.addEventListener('keydown', (e) => {
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) hidePreview();
  }, true);
}

export function wireDialog() {
  const dialog = $('#dlg-new');
  $('#f-colors').replaceChildren(...COLORS.map((color) => {
    const chip = el('label', 'chip');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'color';
    radio.value = color.key;
    chip.append(radio);
    if (color.hex) chip.append(swatch(color.key));
    chip.append(color.name);
    return chip;
  }));
  $('#f-shell').replaceChildren(...info.shells.map((sh) => {
    const option = el('option', '', sh.name);
    option.value = sh.key;
    return option;
  }));

  $('#f-folder').addEventListener('input', () => { $('#f-error').hidden = true; suggestName(); });
  $('#f-name').addEventListener('input', () => { setNameTouched($('#f-name').value.trim() !== ''); });
  $('#f-browse').addEventListener('click', async () => {
    const picked = await api.pickFolder(cleanFolder($('#f-folder').value) || undefined);
    if (!picked) return;
    $('#f-folder').value = picked;
    $('#f-error').hidden = true;
    suggestName();
    $('#f-name').focus();
    $('#f-name').select();
  });
  $('#f-cancel').addEventListener('click', () => dialog.close());
  $('#form-new').addEventListener('submit', submitNew);
  dialog.addEventListener('close', () => requestAnimationFrame(focusTerminal));
}

export function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (dialogOpen()) return;
    if (e.key === 'Escape' && !$('#plus-menu').hidden) { closePlusMenu(); focusTerminal(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape' && closeSettings()) { $('#btn-settings').focus(); e.preventDefault(); e.stopPropagation(); return; }
    // En un campo de texto de la app (no en la terminal) las teclas son suyas.
    if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;

    const key = e.key;
    const lower = key.toLowerCase();
    const ctrl = e.ctrlKey && !e.metaKey;
    let handled = true;

    if (ctrl && !e.altKey && key === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if (ctrl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(key)) { const tab = S.tabs[Number(key) - 1]; if (tab) activate(tab.id); }
    else if (ctrl && e.shiftKey && !e.altKey && lower === 't') openNewDialog();
    else if (ctrl && e.shiftKey && !e.altKey && lower === 'w') { if (S.activeId) closeTab(S.activeId); }
    else if (ctrl && e.shiftKey && !e.altKey && lower === 'd') toggleSplit();
    else if (ctrl && !e.shiftKey && !e.altKey && (lower === 'ñ' || key === '`' || key === 'º')) toggleExtra();
    else if (ctrl && e.altKey && key === 'ArrowLeft') focusSide('left');
    else if (ctrl && e.altKey && key === 'ArrowRight') focusSide('right');
    else if (ctrl && !e.altKey && (key === '+' || key === '=' || e.code === 'NumpadAdd')) zoomActive(0.1);
    else if (ctrl && !e.altKey && !e.shiftKey && (key === '-' || e.code === 'NumpadSubtract')) zoomActive(-0.1);
    else if (ctrl && !e.altKey && !e.shiftKey && (key === '0' || e.code === 'Numpad0')) zoomActive(0);
    else if (key === 'F2' && !ctrl && !e.altKey) startRename(S.activeId);
    else handled = false;

    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

function zoomActive(delta) {
  const view = views.get(S.activeId);
  if (view) setZoom(view, delta === 0 ? 1 : (view.tab.zoom || 1) + delta);
}
