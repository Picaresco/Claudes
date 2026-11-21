// Interruptores de la barra superior: micrófono para dictar y «Resumido».
// ── Micrófono para dictar ────────────────────────────────────────
// El dictado lo hace Claude Code: mientras se mantiene pulsada la barra
// espaciadora graba, y al soltarla escribe lo dictado en su cuadro. El botón
// solo decide si la pulsación larga le llega (ver wireKeys).
import { api, $ } from './dom.js';
import { voiceOn, setVoiceOn, toast } from './state.js';
import { focusTerminal } from './views.js';

export function renderVoice(state) {
  setVoiceOn(Boolean(state && state.enabled));
  const button = $('#mic-btn');
  button.hidden = false;
  button.setAttribute('aria-pressed', String(voiceOn));
  button.title = voiceOn
    ? 'Micrófono activado: mantén pulsada la barra espaciadora en la sesión para dictar; al soltarla deja de grabar. Pulsa para desactivarlo.'
    : 'Micrófono desactivado. Pulsa para activarlo y dictar manteniendo pulsada la barra espaciadora.';
}

// ── Botón «Resumido» ─────────────────────────────────────────────
// Encendido: Claude responde corto y al grano. Apagado: explica sus decisiones y lo
// que va viendo del proyecto (bloques «★ Insight»). Vale para todas las pestañas
// desde el siguiente mensaje, sin reiniciar nada.

let briefOn = false;

export function renderBrief(state) {
  briefOn = Boolean(state && state.enabled);
  const button = $('#brief-btn');
  button.hidden = false;
  button.setAttribute('aria-checked', String(briefOn));
  button.title = briefOn
    ? 'Resumido: activado. Claude responde corto y al grano. Pulsa para que vuelva a explicar sus decisiones y lo que ve del proyecto.'
    : 'Resumido: desactivado. Claude explica sus decisiones y lo que va viendo del proyecto (bloques «★ Insight»). Pulsa para respuestas cortas y al grano.';
}

export async function toggleBrief() {
  renderBrief(await api.briefSet(!briefOn));
  toast(briefOn
    ? 'Respuestas resumidas: desde tu próximo mensaje, Claude irá al grano en todas las pestañas.'
    : 'Respuestas con explicaciones: desde tu próximo mensaje, Claude contará sus decisiones y lo que ve del proyecto.');
  focusTerminal();
}

export async function toggleVoice() {
  renderVoice(await api.voiceSet(!voiceOn));
  toast(voiceOn
    ? 'Micrófono activado: mantén pulsada la barra espaciadora para dictar y suéltala para terminar.'
    : 'Micrófono desactivado: la barra espaciadora vuelve a escribir solo espacios.');
  focusTerminal();
}
