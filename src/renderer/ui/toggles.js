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

// ── Interruptor «Codex asesora» ─────────────────────────────────────
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
    ? `Codex asesora: activado. Codex (${state.model}, razonamiento ${state.effort}) ayuda a Claude a decidir mejor, siempre en solo lectura: Claude le pide una segunda opinión ante decisiones importantes o problemas que no salen (o cuando tú se la pidas), Codex critica cada plan antes de que lo veas y revisa el código que cambie Claude al terminar cada turno (también tus cambios sin confirmar, en proyectos con git). Lo consultado se envía a OpenAI (si lleva claves, no se envía) y gasta de tu plan de ChatGPT. Pulsa para apagarlo: Claude dejará de consultar a Codex.`
    : 'Codex asesora: apagado. Claude no consulta nada a Codex ni se gasta de tu plan de ChatGPT. Pulsa para que Codex le dé segundas opiniones, critique sus planes y revise su código, siempre en solo lectura.';
}

export async function toggleReview() {
  const state = await api.reviewSet(!reviewOn);
  renderReview(state);
  toast(reviewOn
    ? 'Codex asesora a Claude en todas las pestañas: segundas opiniones, crítica de los planes y revisión del código (estas dos, desde el siguiente turno). Gasta de tu plan de ChatGPT.'
    : 'Codex ya no asesora a Claude: no se le consulta nada ni gasta de tu plan de ChatGPT.');
  focusTerminal();
}

export async function toggleVoice() {
  renderVoice(await api.voiceSet(!voiceOn));
  toast(voiceOn
    ? 'Micrófono activado: mantén pulsada la barra espaciadora para dictar y suéltala para terminar.'
    : 'Micrófono desactivado: la barra espaciadora vuelve a escribir solo espacios.');
  focusTerminal();
}
