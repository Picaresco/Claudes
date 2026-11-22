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

// ── Interruptor «Codex revisa» ─────────────────────────────────────
// Encendido: al terminar un turno en el que Claude ha cambiado código, Codex lo revisa y
// Claude corrige lo que encuentre. Solo se ve con Codex instalado y sesión de ChatGPT.

let reviewOn = false;

export function renderReview(state) {
  const button = $('#review-btn');
  if (!state || !state.usable) { button.hidden = true; reviewOn = false; return; }
  reviewOn = Boolean(state.enabled);
  button.hidden = false;
  button.setAttribute('aria-checked', String(reviewOn));
  button.title = reviewOn
    ? `Codex revisa: activado. Al terminar un turno en el que Claude ha cambiado código, Codex (${state.model}, razonamiento ${state.effort}) revisa todos los cambios sin confirmar del proyecto, también los tuyos, y Claude corrige lo que sea un fallo real. Lo revisado se envía a OpenAI (si lleva claves, no se envía) y gasta de tu plan de ChatGPT; como Claude, Codex puede abrir otros archivos del proyecto para entender los cambios. Añade entre medio minuto y unos minutos por turno. Solo en proyectos con git. Pulsa para desactivarlo.`
    : 'Codex revisa: desactivado. Pulsa para que Codex revise, como segundo revisor, los cambios sin confirmar del proyecto cuando Claude termine un turno en el que ha cambiado código. Lo revisado se envía a OpenAI.';
}

export async function toggleReview() {
  const state = await api.reviewSet(!reviewOn);
  renderReview(state);
  toast(reviewOn
    ? 'Desde el siguiente turno, en todas las pestañas, Codex revisará los cambios sin confirmar del proyecto (también los tuyos) cuando Claude cambie código. Se envían a OpenAI.'
    : 'Codex ya no revisa el código al terminar cada turno.');
  focusTerminal();
}

export async function toggleVoice() {
  renderVoice(await api.voiceSet(!voiceOn));
  toast(voiceOn
    ? 'Micrófono activado: mantén pulsada la barra espaciadora para dictar y suéltala para terminar.'
    : 'Micrófono desactivado: la barra espaciadora vuelve a escribir solo espacios.');
  focusTerminal();
}
