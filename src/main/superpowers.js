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

// Al arrancar la sesión con SuperPowers: esfuerzo alto como mínimo (si el elegido para la
// pestaña, o el predeterminado de Claude Code, ya es mayor, ese).
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function powerEffort(chosen, fallback) {
  const have = LEVELS.includes(chosen) ? chosen : LEVELS.includes(fallback) ? fallback : null;
  return have && LEVELS.indexOf(have) >= LEVELS.indexOf('high') ? have : 'high';
}
// …y hasta dos agentes a la vez, que no lancen otros (Claude Code: de serie, 20 a la vez). Si el
// usuario ya tiene puestas las variables, mandan las suyas. env: process.env.
function powerEnv(env = process.env) {
  const out = {};
  if (env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS === undefined) out.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '2';
  if (env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH === undefined) out.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1';
  return out;
}

function createSuperpowers({ tabs, log = () => {}, now = () => Date.now() }) {
  const on = (tabId) => Boolean((tabs.get(tabId) || {}).superpowers);
  // Las conversaciones que recibieron el aviso de «activado». Aquí y no en la pestaña: al
  // reiniciar la sesión (encender o apagar), la app olvida lo de la pestaña, pero la conversación
  // que se retoma sigue llevando el aviso.
  const heardOn = new Set();

  // Empieza un turno del usuario (no un informe de agente: main.js lo filtra con turns.js).
  function turnStarted(tabId, prompt, request) {
    const tab = tabs.ensure(tabId);
    const said = typeof request === 'string' && request ? request : String(prompt || '');
    tab.spRequest = clip(said, 1500);
    tab.spSkip = said.startsWith(WRAPUP.slice(0, 30));
    tab.spEdited = false;
    tab.spVisual = [];
    tab.spCaptures = 0; // imágenes capturadas en el turno
    tab.spSeq = 0; // orden de lo que pasa: ¿hay capturas después del último cambio visual?
    tab.spVisualSeq = 0;
    tab.spCaptureSeq = 0;
    tab.superAsked = false;
    tab.spAfter = 0; // cambios después de pedirle la pasada final
    tab.spMeasured = false;
    tab.spPass = null; // { at, visual, told } desde que se le pide la pasada
    tab.spTurnAt = now();
  }

  // Lo que cambia Claude (también sus agentes). Que ha cambiado algo se apunta también sin
  // SuperPowers, para comparar (power-stats.js); y si cambia algo después de pedirle la pasada
  // final, es que la pasada ha corregido algo.
  function toolUsed(tabId, toolName, file = null) {
    const tab = tabs.get(tabId);
    if (!tab || !EDIT_TOOLS.has(toolName)) return;
    tab.spEdited = true;
    if (tab.superAsked) tab.spAfter = (tab.spAfter || 0) + 1;
    if (!on(tabId)) return;
    if (typeof file === 'string' && VISUAL.test(file)) {
      const name = path.basename(file);
      if (!(tab.spVisual || []).includes(name)) tab.spVisual = [...(tab.spVisual || []), name].slice(0, 12);
      tab.spSeq = (tab.spSeq || 0) + 1;
      tab.spVisualSeq = tab.spSeq;
    }
  }

  // Una captura que ha salido bien (main.js, al devolverla la herramienta): cuántas imágenes.
  function captured(tabId, images) {
    const tab = tabs.get(tabId);
    if (!tab || !(images > 0)) return;
    tab.spCaptures = (tab.spCaptures || 0) + images;
    tab.spSeq = (tab.spSeq || 0) + 1;
    tab.spCaptureSeq = tab.spSeq;
  }

  // ¿Toca la pasada final en este Stop? Una vez por turno, si ha cambiado algo.
  function willAsk(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !on(tabId) || !tab.spEdited || tab.superAsked || tab.spSkip) return false;
    tab.superAsked = true;
    tab.spPass = { at: now(), visual: [...(tab.spVisual || [])], told: false }; // lo visual hasta aquí, para pedírselo
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
    // Lo visual de todo el turno (también lo cambiado en la pasada), y bien solo si hay capturas
    // después del último cambio visual (una de antes no enseña cómo ha quedado).
    const visual = [...(tab.spVisual || [])];
    const images = tab.spCaptures || 0;
    const after = (tab.spCaptureSeq || 0) > (tab.spVisualSeq || 0);
    return {
      tests,
      captures: visual.length ? (after ? 'ok' : 'missing') : images ? 'ok' : 'skip',
      captured: images,
      visual,
      codex: Boolean(codex),
      seconds: Math.max(0, Math.round((now() - tab.spPass.at) / 1000)),
    };
  }

  // Termina una tarea que ha cambiado algo (una vez por turno): para medir lo que aporta
  // SuperPowers (power-stats.js). tests: el veredicto de testcheck.
  function turnEnded(tabId, tests = 'unknown') {
    const tab = tabs.get(tabId);
    if (!tab || !tab.spEdited || tab.spSkip || tab.spMeasured || !tab.spTurnAt) return null;
    tab.spMeasured = true;
    const powered = on(tabId);
    return {
      mode: powered ? 'with' : 'without',
      seconds: Math.max(0, Math.round((now() - tab.spTurnAt) / 1000)),
      fixed: powered && (tab.spAfter || 0) > 0,
      tests,
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
    tab.spPrompts = (tab.spPrompts || 0) + 1;
    const stale = tab.spTold === true && ((sessionId && tab.spSession && sessionId !== tab.spSession) || tab.spPrompts > NOTE_EVERY);
    if (on(tabId)) {
      if (tab.spTold === true && !stale) return null;
      tab.spTold = true;
      tab.spSession = sessionId || tab.spSession || null;
      tab.spPrompts = 0;
      if (sessionId) {
        heardOn.add(sessionId);
        if (heardOn.size > 200) heardOn.delete(heardOn.values().next().value);
      }
      log(`SuperPowers: se le dice a la sesión ${tabId} cómo trabajar`);
      return NOTE_ON;
    }
    const heard = tab.spTold === true || Boolean(sessionId && heardOn.has(sessionId));
    tab.spTold = false;
    if (!heard) return null;
    if (sessionId) heardOn.delete(sessionId);
    return NOTE_OFF;
  }
  const sessionStarted = (tabId) => { tabs.ensure(tabId).spTold = undefined; };
  const compacted = (tabId) => { const tab = tabs.get(tabId); if (tab && tab.spTold === true) tab.spTold = undefined; };

  return { on, turnStarted, toolUsed, captured, willAsk, answer, summary, turnEnded, note, sessionStarted, compacted, CAPTURE_TOOL };
}

module.exports = { createSuperpowers, powerEffort, powerEnv, NOTE_ON, NOTE_OFF, VISUAL };
