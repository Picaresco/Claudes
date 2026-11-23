// ── Botón «Optimiza» ────────────────────────────────────────────
// Claude revisa todo el proyecto de la pestaña y lo mejora sin cambiar lo que hace, solo y
// en una rama aparte de git (src/main/optimize.js). Aquí: comprobar que se puede, pedir
// confirmación diciendo qué va a pasar y escribirle la petición a la sesión.
import { OPTIMIZE_PROMPT } from './constants.js';
import { api } from './dom.js';
import { S, views, toast } from './state.js';
import { focusTerminal } from './views.js';

export async function optimizeProject() {
  const view = views.get(S.activeId);
  if (!view || !view.started || view.closing) { toast('Abre primero la sesión de este proyecto.'); return; }
  if (!['idle', 'done', 'failed'].includes(view.status)) {
    toast(`Claude está trabajando en «${view.tab.name}»: espera a que termine para optimizarlo.`);
    return;
  }
  const project = await api.optimizeCheck(view.tab.id);
  if (!project || !project.ok) { toast((project && project.error) || 'No se ha podido comprobar el proyecto.', 10000); return; }
  const detail = [
    'Claude revisará todo el proyecto y lo mejorará sin cambiar lo que hace: limpieza, orden, eficiencia y coherencia visual.',
    'Trabaja solo y con red de seguridad: en una rama aparte de git (no toca tu rama ni sube nada), mide antes y después, pasa las pruebas tras cada cambio y deshace lo que falle. Al final pide una revisión independiente y te deja un informe y la rama para que decidas si la unes.',
    ...(project.git ? [] : ['Este proyecto no usa git: Claude lo activará primero (un historial solo en este equipo, no sube nada).']),
    ...(project.dirty ? ['Tus cambios sin confirmar se guardan tal cual como punto de partida en la rama nueva.'] : []),
    'Puede tardar bastante y gasta de tu plan. Claude te pedirá permiso para editar y ejecutar órdenes, salvo que hayas activado aceptar los cambios (Mayús+Tab).',
  ].join('\n\n');
  const choice = await api.choose({ message: `Optimizar «${view.tab.name}»`, detail, buttons: ['Optimizar', 'Cancelar'] });
  if (choice !== 0) return;
  if (!(await api.optimizeArm(view.tab.id))) { toast('No se ha podido preparar la optimización.'); return; }
  // Se vacía lo que hubiera a medio escribir y se envía la petición.
  api.ptyWrite(view.tab.id, String.fromCharCode(21));
  setTimeout(() => view.term.paste(OPTIMIZE_PROMPT), 150);
  setTimeout(() => api.ptyWrite(view.tab.id, '\r'), 550);
  focusTerminal();
}
