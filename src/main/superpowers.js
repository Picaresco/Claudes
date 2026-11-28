// ── SuperPowers ──────────────────────────────────────────────────
// Opción por pestaña (la enciende el usuario: gasta más y tarda más). Con ella, Claude:
//   - trabaja con esfuerzo alto, las habilidades del plugin src/plugins/superpowers y hasta dos
//     agentes en paralelo (eso se pone al arrancar la sesión: main.js, createPty);
//   - recibe al empezar cómo trabajar (note: aviso por UserPromptSubmit, como «Codex asesora»);
//   - no da por terminado un turno que ha cambiado algo sin la «pasada final» (willAsk/answer en
//     el Stop, antes que el recordatorio de pruebas y la revisión de Codex, que también hace);
//   - y al acabar, la pasada se resume con lo comprobado (summary), con pruebas de verdad, no con
//     lo que diga Claude.
// El turno lo marca turns.js: el informe de un agente no empieza uno nuevo.
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CAPTURE_TOOL = 'mcp__claudhome-codex__capturar_pantalla';
// Lo que se ve: si cambia, la pasada pide revisarlo con capturas.
const VISUAL = /\.(html?|css|scss|sass|less|vue|svelte|jsx|tsx|svg|astro|hbs|ejs|njk|liquid)$/i;
const NOTE_EVERY = 30; // mensajes: se le recuerda cómo trabajar (como «Codex asesora»)
const WRAPUP = 'Voy a cerrar esta sesión ahora.'; // el turno de cerrar la sesión no tiene pasada
const clip = (text, max) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const NOTE_ON = [
  'ClaudHome · SuperPowers (activado por el usuario en esta pestaña): trabaja a fondo y no des nada por terminado sin comprobarlo. El usuario ha aceptado gastar más tiempo y tokens a cambio de calidad.',
  '- Habilidades (plugin claudhome-superpowers): verification-before-completion antes de afirmar que algo funciona; systematic-debugging ante cualquier fallo (la causa antes que el arreglo); pruebas-primero para lógica nueva y para cada fallo que arregles (nunca borres código que funciona); revision-visual si cambias algo que se ve (herramienta capturar_pantalla a 390, 1024 y 1440 px).',
  '- Agentes: tú eres el único que edita. Si puedes seguir avanzando mientras tanto, delega en hasta dos agentes de solo lectura con un encargo concreto (p. ej. pasar la suite y resumir fallos, mirar las capturas, comprobar un módulo) y que te devuelvan pruebas, no opiniones. No delegues tareas pequeñas: explicarlas cuesta más que hacerlas.',
  '- Al terminar habrá una pasada final (te la pedirá ClaudHome): pruebas, lo pedido punto por punto y capturas si hay algo visual. Cierra diciendo qué has comprobado y qué queda pendiente. Si ves mejoras que de verdad merezcan la pena, propón como mucho tres, sin aplicarlas.',
].join('\n');
const NOTE_OFF = 'ClaudHome · SuperPowers desactivado por el usuario en esta pestaña: vuelve a trabajar como siempre (sin pasada final ni agentes extra).';

function createSuperpowers({ tabs, log = () => {}, now = () => Date.now() }) {
  const on = (tabId) => Boolean((tabs.get(tabId) || {}).superpowers);

  // Empieza un turno del usuario (no un informe de agente: main.js lo filtra con turns.js).
  function turnStarted(tabId, prompt, request) {
    const tab = tabs.ensure(tabId);
    const said = typeof request === 'string' && request ? request : String(prompt || '');
    tab.spRequest = clip(said, 1500);
    tab.spSkip = said.startsWith(WRAPUP.slice(0, 30));
    tab.spEdited = false;
    tab.spVisual = [];
    tab.spCaptures = 0;
    tab.superAsked = false;
    tab.spPass = null; // { at, visual, told } desde que se le pide la pasada
    tab.spTurnAt = now();
  }

  // Lo que hace Claude (también sus agentes): qué cambia y si captura la pantalla.
  function toolUsed(tabId, toolName, file = null) {
    const tab = tabs.get(tabId);
    if (!tab || !on(tabId)) return;
    if (toolName === CAPTURE_TOOL) { tab.spCaptures = (tab.spCaptures || 0) + 1; return; }
    if (!EDIT_TOOLS.has(toolName)) return;
    tab.spEdited = true;
    if (typeof file === 'string' && VISUAL.test(file)) {
      const name = path.basename(file);
      if (!(tab.spVisual || []).includes(name)) tab.spVisual = [...(tab.spVisual || []), name].slice(0, 12);
    }
  }

  // ¿Toca la pasada final en este Stop? Una vez por turno, si ha cambiado algo.
  function willAsk(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !on(tabId) || !tab.spEdited || tab.superAsked || tab.spSkip) return false;
    tab.superAsked = true;
    tab.spPass = { at: now(), visual: [...(tab.spVisual || [])], told: false };
    log(`SuperPowers: pasada final en ${tabId}`);
    return true;
  }

  // La respuesta al Stop: que no termine sin la pasada final.
  function answer(tabId) {
    const tab = tabs.get(tabId) || {};
    const visual = (tab.spPass && tab.spPass.visual) || [];
    const steps = [
      '1. Pasa la suite de pruebas completa del proyecto (si no tiene, una comprobación que se pueda repetir de lo que has cambiado) y añade las pruebas que falten para lo cambiado. Que la salida lo demuestre.',
      `2. Repasa punto por punto lo que pidió el usuario y comprueba cada punto: «${tab.spRequest || 'lo que pidió en este turno'}».`,
      visual.length
        ? `3. Has cambiado archivos que se ven (${visual.join(', ')}): revísalos con la herramienta capturar_pantalla a 390, 1024 y 1440 px (habilidad revision-visual), mira las imágenes y arregla solapes, textos cortados o contraste.`
        : '3. Si algo de lo cambiado se ve en pantalla, revísalo con capturar_pantalla (habilidad revision-visual).',
      '4. Si puedes, reparte la comprobación: un agente de solo lectura para las pruebas o las capturas mientras tú repasas lo pedido.',
      '5. Termina con un bloque «Pasada final» breve: lo comprobado (con su prueba: comando y resultado, capturas), lo que queda pendiente y, solo si merecen la pena de verdad, hasta tres mejoras propuestas (sin aplicarlas).',
    ];
    return { decision: 'block', reason: `ClaudHome · SuperPowers: antes de terminar, la pasada final.\n${steps.join('\n')}` };
  }

  // El resumen de la pasada para la interfaz, con lo que se ha visto (no con lo que diga Claude),
  // una sola vez por turno. tests: el veredicto de testcheck ('ok', 'failing', 'pending', 'none' o
  // 'unknown'); codex: si Codex va a revisar ahora.
  function summary(tabId, { tests = 'unknown', codex = false } = {}) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.spPass || tab.spPass.told) return null;
    tab.spPass.told = true;
    const visual = tab.spPass.visual || [];
    const captured = tab.spCaptures || 0; // en todo el turno: también las de antes de la pasada
    return {
      tests,
      captures: captured ? 'ok' : visual.length ? 'missing' : 'skip',
      captured,
      visual,
      codex: Boolean(codex),
      seconds: Math.max(0, Math.round((now() - tab.spPass.at) / 1000)),
    };
  }

  // El aviso a Claude: una vez por sesión, otra vez tras /clear, al resumirse la conversación o
  // cada 30 mensajes. Y si se apaga: encender o apagar reinicia la sesión retomando la misma
  // conversación, que ya lleva el aviso de «activado», así que se le dice que se ha apagado
  // (se recuerda qué conversaciones lo recibieron: spOnSessions).
  function note(tabId, event) {
    const tab = tabs.ensure(tabId);
    if (event && typeof event.prompt === 'string' && event.prompt.startsWith(WRAPUP.slice(0, 30))) return null;
    const sessionId = (event && event.sessionId) || null;
    const told = tab.spOnSessions || (tab.spOnSessions = []);
    tab.spPrompts = (tab.spPrompts || 0) + 1;
    const stale = tab.spTold === true && ((sessionId && tab.spSession && sessionId !== tab.spSession) || tab.spPrompts > NOTE_EVERY);
    if (on(tabId)) {
      if (tab.spTold === true && !stale) return null;
      tab.spTold = true;
      tab.spSession = sessionId || tab.spSession || null;
      tab.spPrompts = 0;
      if (sessionId && !told.includes(sessionId)) tab.spOnSessions = [...told, sessionId].slice(-20);
      log(`SuperPowers: se le dice a la sesión ${tabId} cómo trabajar`);
      return NOTE_ON;
    }
    const heard = tab.spTold === true || Boolean(sessionId && told.includes(sessionId));
    tab.spTold = false;
    if (!heard) return null;
    tab.spOnSessions = told.filter((id) => id !== sessionId);
    return NOTE_OFF;
  }
  const sessionStarted = (tabId) => { tabs.ensure(tabId).spTold = undefined; };
  const compacted = (tabId) => { const tab = tabs.get(tabId); if (tab && tab.spTold === true) tab.spTold = undefined; };

  return { on, turnStarted, toolUsed, willAsk, answer, summary, note, sessionStarted, compacted, CAPTURE_TOOL };
}

module.exports = { createSuperpowers, NOTE_ON, NOTE_OFF, VISUAL };
