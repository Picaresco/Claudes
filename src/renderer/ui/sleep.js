// ── Sesiones dormidas ────────────────────────────────────────────
// Una sesión que lleva un rato esperando tu mensaje en una pestaña que no estás
// viendo se cierra para liberar memoria: Claude y sus servidores MCP ocupan en
// torno a 1 GB por sesión. La conversación queda guardada y se retoma sola al
// abrir la pestaña, como al arrancar ClaudHome. No se duerme si está trabajando,
// si te necesita o tiene algo que no has visto, ni si Claude dejó algo en marcha
// (una tarea en segundo plano, una vigilancia o una tarea programada).
import { api } from './dom.js';
import { startClaude } from './sessions.js';
import { views, visibleIds } from './state.js';
import { setStatus } from './status.js';

export let sleepAfterMs = 45 * 60 * 1000;
export const setSleepAfterMs = (value) => { sleepAfterMs = value; };

export function sleepIdleSessions() {
  const now = Date.now();
  const shown = visibleIds();
  for (const view of views.values()) {
    if (shown.includes(view.tab.id)) { view.lastActive = now; continue; }
    if (!view.started || view.closing || view.keepAwake || view.status !== 'idle') continue;
    if (now - (view.lastActive || now) >= sleepAfterMs) putToSleep(view);
  }
}

async function putToSleep(view) {
  const id = view.tab.id;
  api.log(`«${view.tab.name}» se duerme tras ${Math.round((Date.now() - view.lastActive) / 60000)} min sin actividad`);
  view.started = false;
  view.exited = false;
  view.goingToSleep = true; // si abres la pestaña mientras se cierra, arranca al terminar
  await api.ptyKill(id);
  view.goingToSleep = false;
  if (!views.has(id)) return;
  view.term.reset();
  view.mode = 'resume';
  if (visibleIds().includes(id) && view.opened) startClaude(view);
  else setStatus(view, 'sleeping');
}
