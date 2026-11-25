// ── Rueda de opciones ────────────────────────────────────────────
// Un panel con todo lo que se enciende o se apaga (respuestas, Codex, micrófono y
// depuración) y el «Log», para dejar sitio en las barras de arriba. Pulsar una opción no
// lo cierra (el «Log» sí, porque se abre); se cierra al pulsar fuera, con Esc o con la rueda.
import { $ } from './dom.js';
import { focusTerminal } from './views.js';

// Tras cambiar una opción: con la rueda abierta, el foco sigue en ella (Tab pasa a la
// siguiente); si no, vuelve al terminal.
export function focusAfterToggle(button) {
  if (!$('#settings-menu').hidden && button) button.focus();
  else focusTerminal();
}

function openSettings() {
  const menu = $('#settings-menu');
  menu.hidden = false;
  $('#btn-settings').setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('.opt-row:not([hidden])');
  if (first) first.focus();
}

export function closeSettings() {
  const menu = $('#settings-menu');
  if (menu.hidden) return false;
  menu.hidden = true;
  $('#btn-settings').setAttribute('aria-expanded', 'false');
  return true;
}

export const toggleSettings = () => ($('#settings-menu').hidden ? openSettings() : closeSettings());
