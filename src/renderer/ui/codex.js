// ── Codex ────────────────────────────────────────────────────────
import { api, $ } from './dom.js';
import { renderCodexLimits } from './limits.js';
import { renderToolbar } from './render.js';
import { restartSession } from './sessions.js';
import { views, toast } from './state.js';

export let codexInfo = null;

export function renderCodex(info) {
  if (info) codexInfo = info;
  const chip = $('#codex-chip');
  if (!codexInfo) { chip.hidden = true; return; }
  let state = 'missing';
  let label;
  let title;
  if (!codexInfo.installed) {
    label = 'Codex no detectado en este equipo';
    title = 'No encuentro Codex en este equipo. Si lo instalas e inicias sesión con tu suscripción de ChatGPT, Claude podrá pedirle segundas opiniones, revisiones e imágenes. Pulsa para volver a comprobar.';
  } else if (!codexInfo.loggedIn) {
    label = 'Codex sin sesión';
    title = 'Codex está instalado pero sin sesión iniciada. Ejecuta «codex login» y pulsa aquí para volver a comprobar.';
  } else if (codexInfo.mode !== 'chatgpt') {
    label = 'Codex con clave de API: solo con tu cuenta de ChatGPT';
    title = 'Codex tiene sesión con una clave de API, no con una suscripción de ChatGPT. Las imágenes con Codex solo se activan con suscripción.';
  } else if (codexInfo.busy > 0) {
    state = 'busy';
    label = 'Codex trabajando…';
    title = 'Codex está trabajando para una sesión: una segunda opinión, la crítica de un plan o una imagen.';
  } else if (!codexInfo.enabled) {
    state = 'ready';
    label = 'Desactivadas';
    title = codexInfo.advisor === false
      ? 'Suscripción de ChatGPT detectada en Codex, pero esta versión de Codex es antigua para asesorar a Claude: actualízala (npm i -g @openai/codex). Pulsa para que Claude pueda pedirle imágenes.'
      : 'Suscripción de ChatGPT detectada en Codex. Enciende «Codex asesora» para que asesore a Claude; pulsa aquí para que también pueda pedirle imágenes.';
  } else {
    state = 'on';
    label = 'Activadas';
    title = 'Activado: Claude puede pedir imágenes a Codex con tu suscripción. Pulsa para desactivarlo.';
  }
  chip.hidden = false;
  chip.dataset.state = state;
  chip.title = title;
  chip.setAttribute('aria-pressed', String(Boolean(codexInfo.active)));
  $('#codex-label').textContent = label;
  // La rueda de opciones avisa con un punto mientras Codex trabaja.
  $('#btn-settings').dataset.busy = String(state === 'busy');
  renderToolbar();
  renderCodexLimits(codexInfo); // detección y uso de Codex, en la barra inferior
}

export async function toggleCodex() {
  if (!codexInfo || !codexInfo.usable) {
    // No disponible: se vuelve a comprobar por si acaba de instalarse o de iniciar sesión.
    renderCodex(await api.codexStatus(true));
    toast($('#codex-chip').title);
    return;
  }
  renderCodex(await api.codexSetEnabled(!codexInfo.enabled));
  if (!codexInfo.enabled) {
    toast('Imágenes con Codex desactivadas.');
    return;
  }
  // La herramienta se entrega al arrancar Claude: las sesiones ya abiertas no la tienen.
  const idle = [...views.values()].filter((v) => v.started && !v.codex && !v.closing && ['idle', 'done', 'failed'].includes(v.status));
  const busy = [...views.values()].filter((v) => v.started && !v.codex && !idle.includes(v)).length;
  if (!idle.length) {
    toast(busy ? 'Imágenes con Codex activadas. Las sesiones que están trabajando lo tendrán cuando las reinicies.' : 'Imágenes con Codex activadas.');
    return;
  }
  const choice = await api.choose({
    message: 'Imágenes con Codex activadas',
    detail: `Las sesiones ya abiertas necesitan reiniciarse para recibir la herramienta. Hay ${idle.length === 1 ? 'una sesión en reposo' : `${idle.length} sesiones en reposo`}: se pueden reiniciar ahora y conservan su conversación.`
      + (busy ? ' Las que están trabajando no se tocan.' : ''),
    buttons: ['Reiniciar las que están en reposo', 'Más tarde'],
  });
  if (choice === 0) for (const view of idle) if (views.has(view.tab.id)) restartSession(view);
}
