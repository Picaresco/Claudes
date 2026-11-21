// ── Estado de las sesiones y avisos ──────────────────────────────
import { WRAPUP_PROMPT } from './constants.js';
import { api, $ } from './dom.js';
import { renderTabs, renderHeads, renderStatusbar } from './render.js';
import { sleep } from './state.js';

export function setStatus(view, status) {
  // Mientras guarda su estado para cerrar, la pestaña se queda en ese estado.
  if (view.closing && status !== 'closing') return;
  view.lastActive = Date.now();
  if (view.status === status) return;
  api.log(`estado de «${view.tab.name}»: ${view.status} → ${status}`);
  view.status = status;
  renderTabs();
  renderHeads();
  renderStatusbar();
}

// Cierre ordenado: interrumpe lo que Claude esté haciendo y le pide que deje
// anotado su estado. La promesa se resuelve con:
//   'saved'  → Claude ha terminado de escribir su resumen
//   'forced' → el usuario no ha querido esperar
//   'failed' → no se pudo enviar la petición o ha tardado demasiado
export function wrapUp(view) {
  if (view.closing) return view.closing.promise;
  if (!view.started) return Promise.resolve('failed');
  const closing = { sent: false, submitted: false, result: null, timers: [] };
  closing.promise = new Promise((resolve) => {
    closing.finish = (result) => {
      if (closing.result) return;
      closing.result = result;
      closing.timers.forEach(clearTimeout);
      resolve(result);
    };
  });
  view.closing = closing;
  setStatus(view, 'closing');
  const later = (ms, fn) => closing.timers.push(setTimeout(fn, ms));
  api.ptyWrite(view.tab.id, '\x1b'); // Esc interrumpe el turno en curso (o rechaza el permiso pendiente)
  later(1500, () => view.term.paste(WRAPUP_PROMPT));
  later(1900, () => { closing.sent = true; api.ptyWrite(view.tab.id, '\r'); });
  later(1900 + 15000, () => { if (!closing.submitted) closing.finish('failed'); });
  later(3 * 60 * 1000, () => closing.finish('failed'));
  return closing.promise;
}

// Deja que Claude salga por sí mismo, como al pulsar Ctrl+C hasta salir: la
// primera pulsación vacía el cuadro si tenía texto, las siguientes cierran.
// Quien llama termina después el proceso si en unos segundos no ha salido.
export async function gracefulExit(view) {
  if (!view.started) return;
  view.expectExit = true;
  let exited = false;
  const gone = new Promise((resolve) => { view.onExit = () => { exited = true; resolve(); }; });
  for (let press = 0; press < 4 && !exited; press += 1) {
    api.ptyWrite(view.tab.id, '\x03');
    await Promise.race([gone, sleep(600)]);
  }
  await Promise.race([gone, sleep(5000)]); // Claude tarda unos 3 s en cerrarse
  console.log(`[cierre] ${view.tab.name}: salida ${exited ? 'ordenada' : 'forzada'}`);
  api.log(`cierre ordenado de «${view.tab.name}»: salida ${exited ? 'por sí mismo' : 'forzada por la app'}`);
}
