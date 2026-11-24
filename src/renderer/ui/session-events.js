// Lo que pasa en cada sesión: avisos de los hooks de Claude Code y salida del proceso.
import { api } from './dom.js';
import { views, winFocused, visibleIds, isWatched, save, toast } from './state.js';
import { applyPendingModel } from './model.js';
import { setStatus } from './status.js';
import { isSandboxMissing, sandboxFix } from './toggles.js';

function needsYou(view, body) {
  if (view.closing) return;
  const was = view.status;
  setStatus(view, 'needs');
  if (was !== 'needs' && !isWatched(view)) {
    api.notify({ tabId: view.tab.id, title: `${view.tab.name} te necesita`, body });
  }
}

// Devuelve el aviso de que las pruebas no pasan, si lo hay. Con `hold` no lo muestra: lo
// enseña quien llama, junto a lo suyo (un mensaje posterior lo taparía).
function finished(view, failed, hold = false) {
  if (view.closing) return '';
  // Un cambio de modelo o de esfuerzo que esperaba a que Claude terminase.
  setTimeout(() => applyPendingModel(view), 0);
  const was = view.status;
  if (failed) {
    // Un error (fallo de la API, límite de uso…) queda en ámbar hasta tu siguiente
    // mensaje, aunque estés viendo la pestaña.
    setStatus(view, 'failed');
    if (was !== 'failed' && !isWatched(view)) {
      api.notify({ tabId: view.tab.id, title: `${view.tab.name} se ha detenido`, body: 'Claude no ha podido completar la respuesta por un error.' });
    }
    return '';
  }
  // Si el turno acaba con las pruebas del proyecto sin pasar (testcheck.js), se dice:
  // «ha terminado» no quiere decir que funcionen.
  const failing = view.testsFailing;
  view.testsFailing = null;
  const warn = failing ? `Ojo: «${view.tab.name}» ha terminado, pero sus pruebas no pasan (${failing}). Lee lo que te cuenta Claude antes de darlo por bueno.` : '';
  if (warn && !hold) toast(warn, 12000);
  if (isWatched(view)) { setStatus(view, 'idle'); return warn; }
  setStatus(view, 'done');
  if (was === 'done') return warn;
  api.notify({
    tabId: view.tab.id,
    title: `${view.tab.name} ha terminado`,
    body: failing ? `Claude ha terminado, pero las pruebas del proyecto no pasan (${failing}).` : 'Claude ha terminado y espera tu siguiente mensaje.',
  });
  return warn;
}

// Lo que ya estás viendo deja de marcarse como pendiente.
export function acknowledge() {
  if (!winFocused) return;
  for (const id of visibleIds()) {
    const view = views.get(id);
    if (view && view.status === 'done') setStatus(view, 'idle');
  }
}

export function onHook(tabId, ev) {
  const view = views.get(tabId);
  if (!view || !view.started || !ev) return;
  if (ev.background && !view.keepAwake) {
    view.keepAwake = true; // ha dejado algo en marcha: esta sesión no se duerme
    api.log(`«${view.tab.name}» deja ${ev.toolName} en marcha: no se dormirá`);
  }
  // /clear abre una conversación con otro identificador: la pestaña lo sigue.
  if (ev.sessionId && (ev.event === 'UserPromptSubmit' || ev.event === 'Stop') && ev.sessionId !== view.tab.sessionId) {
    view.tab.sessionId = ev.sessionId;
    save();
  }
  if (view.closing) {
    // Durante el cierre ordenado solo interesa saber si la petición ha entrado
    // y cuándo termina Claude de responderla.
    if (ev.event === 'UserPromptSubmit' && view.closing.sent) view.closing.submitted = true;
    else if ((ev.event === 'Stop' || ev.event === 'StopFailure') && view.closing.submitted) view.closing.finish('saved');
    return;
  }
  switch (ev.event) {
    case 'PreToolUse':
      // Mientras Codex critica el plan, la pestaña lo sigue diciendo.
      if (ev.toolName === 'ExitPlanMode' && view.status === 'planreview') break;
      setStatus(view, 'working');
      break;
    case 'UserPromptSubmit':
      view.testsFailing = null;
      setStatus(view, 'working');
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      setStatus(view, 'working');
      break;
    case 'PermissionRequest':
      needsYou(view, ev.toolName ? `Claude pide permiso para usar ${ev.toolName}.` : 'Claude pide permiso para continuar.');
      break;
    case 'Notification':
      if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(ev.notificationType)) {
        needsYou(view, ev.notificationType === 'permission_prompt' ? 'Claude pide permiso para continuar.' : 'Claude necesita tu respuesta.');
      }
      break;
    case 'Stop':
      // Si se le retiene por las pruebas o Codex va a revisar lo que ha cambiado, el turno aún no ha terminado.
      view.testsFailing = ev.testsFailing || null; // se dice al terminar del todo (finished)
      if (ev.testsAsk) setStatus(view, 'working');
      else if (ev.reviewing) setStatus(view, 'reviewing');
      else finished(view, false);
      break;
    case 'StopFailure':
      finished(view, true);
      break;
    default:
      break;
  }
}

// Resultado de la revisión de Codex de una pestaña (review.js).
export function onReviewResult(tabId, r) {
  const view = views.get(tabId);
  if (!view || !r || view.closing) return;
  const name = `«${view.tab.name}»`;
  if (r.state === 'running') { setStatus(view, 'reviewing'); return; }
  if (r.state === 'found') {
    // Claude sigue trabajando con lo que ha encontrado Codex.
    view.testsFailing = null; // se volverá a mirar cuando se pare
    setStatus(view, 'working');
    toast(r.count === 1
      ? `Codex ha encontrado un posible problema en ${name} (${r.seconds} s). Claude lo está revisando.`
      : `Codex ha encontrado ${r.count} posibles problemas en ${name} (${r.seconds} s). Claude los está revisando.`);
    if (r.partial) setTimeout(() => toast(`Ojo: Codex no ha podido leer el proyecto de ${name}, así que su revisión puede estar incompleta.`, 8000), 4200);
    return;
  }
  // El plan y la segunda opinión: Claude sigue trabajando con lo que diga Codex.
  if (r.state === 'plan-running') { setStatus(view, 'planreview'); return; }
  if (r.state === 'opinion-running') { setStatus(view, 'consulting'); return; }
  if (r.state === 'opinion-done') { if (view.status === 'consulting') setStatus(view, 'working'); return; }
  if (r.state === 'plan-done') {
    setStatus(view, 'working');
    toast(`Codex ha revisado el plan de ${name} (${r.seconds} s). Claude lo está ajustando antes de enseñártelo.`);
    return;
  }
  if (r.state === 'plan-error') {
    if (view.status === 'planreview') setStatus(view, 'working');
    toast(r.reason === 'big'
      ? `El plan de ${name} es demasiado grande para enviárselo a Codex: Claude te lo presenta sin su crítica.`
      : `Codex no ha podido revisar el plan de ${name}: Claude te lo presenta sin su crítica.`);
    return;
  }
  if (r.state === 'blocked') {
    // Codex no ha podido leer el proyecto: se dice por qué y cómo arreglarlo.
    // Solo cambia el estado de la operación que ha fallado (una segunda opinión no termina una revisión).
    if (r.op === 'plan' && view.status === 'planreview') setStatus(view, 'working'); // Claude sigue: presenta el plan sin crítica
    const pending = r.op === 'review' && view.status === 'reviewing' ? finished(view, false, true) : ''; // el aviso de pruebas, si lo hay, va delante
    const why = isSandboxMissing()
      ? `su zona protegida de Windows no está configurada. ${sandboxFix()}`
      : 'se le ha denegado el acceso a los archivos. Revisa los permisos de la carpeta del proyecto.';
    toast(`${pending ? `${pending} ` : ''}Codex no ha podido leer el proyecto de ${name}: ${why}`, 15000);
    return;
  }
  if (r.state === 'plan-secret') {
    toast(`${name}: el plan lleva lo que parece una clave o contraseña, así que no se ha enviado a Codex.`);
    return;
  }
  // Si el turno acaba con las pruebas sin pasar, ese aviso va junto a lo que se diga de la
  // revisión: un mensaje detrás de otro lo taparía, y una revisión limpia no lo arregla.
  let warn = ['reviewing', 'planreview', 'consulting'].includes(view.status) ? finished(view, false, true) : '';
  const say = (text) => { toast(warn ? `${warn} ${text}` : text, warn ? 15000 : false); warn = ''; };
  if (r.state === 'secret') {
    const files = (r.files || []).join(', ');
    if (files) say(`${name}: Codex no ha revisado los cambios porque ${files} lleva una clave o contraseña, y no se envía a OpenAI. Pásala a un .env que git no suba.`);
    else say(`${name}: Codex no ha revisado los cambios porque no se ha podido comprobar que no lleven claves (son demasiado grandes o no se pueden leer).`);
    return;
  }
  if (r.state === 'clean') say(`Codex ha revisado el código de ${name} y no ha encontrado problemas (${r.seconds} s).`);
  else if (r.state === 'error') {
    const what = r.unclear ? `Codex no ha podido revisar los cambios de ${name}.` : `La revisión de Codex de ${name} ha fallado.`;
    say(`${what} ${r.file ? 'Los detalles están en la carpeta de registros.' : 'Activa la depuración para guardar los detalles la próxima vez.'}`);
  }
  else if (r.state === 'skipped' && !view.reviewSkipNoted) {
    view.reviewSkipNoted = true; // una vez por pestaña
    say(`${name}: ${r.reason}`);
  }
  if (warn) toast(warn, 12000);
}

export function onPtyExit(id, code) {
  if (id.endsWith(':sh')) {
    const view = views.get(id.slice(0, -3));
    const extra = view && view.extra;
    if (!extra) return;
    extra.started = false;
    extra.exited = true;
    extra.term.write('\r\n\x1b[2m[La terminal se ha cerrado. Pulsa Intro para abrirla de nuevo.]\x1b[0m\r\n');
    return;
  }
  const view = views.get(id);
  if (!view) return;
  view.started = false;
  view.exited = true;
  if (view.onExit) { const notify = view.onExit; view.onExit = null; notify(); }
  if (view.closing) view.closing.finish('forced'); // ha salido antes de terminar: no hay nada que esperar
  if (view.expectExit) return; // salida pedida por la app al cerrar
  // Si falla nada más intentar retomar, esa conversación ya no existe.
  const failedResume = view.resumed && code !== 0 && Date.now() - view.startedAt < 8000;
  view.mode = failedResume ? 'new' : 'resume';
  setStatus(view, 'exited');
  const text = failedResume
    ? 'No se ha podido retomar la conversación. Pulsa Intro para empezar una nueva.'
    : 'La sesión de Claude se ha cerrado. Pulsa Intro para retomarla.';
  view.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}
