// Codex como asesor de Claude, siempre en solo lectura: opina y critica; quien decide y
// cambia es Claude, y quien aprueba, el usuario.
//
// Todo depende del interruptor «Codex asesora», que viene apagado: lo enciende el usuario si
// quiere usar Codex. Apagado, no se le consulta nada ni se gasta del plan de ChatGPT.
// - Segunda opinión (herramienta «segunda_opinion»): Claude se la pide ante decisiones
//   importantes o problemas que no salen, en cualquier ámbito (código, seguridad, planes,
//   flujos de trabajo), o cuando el usuario se lo pide.
// - Crítica de cada plan antes de que el usuario lo vea (hook PreToolUse de ExitPlanMode).
// - Revisión del código al terminar un turno.
//
// Revisión del código:
//
// Con el interruptor encendido, cuando Claude termina un turno en el que ha editado código
// (Edit, Write, MultiEdit o NotebookEdit sobre un archivo de código), la app lo retiene en
// el hook Stop y le pide a Codex que revise los cambios sin confirmar del proyecto: el
// modelo más capaz de la cuenta de ChatGPT, con razonamiento xhigh, en solo lectura y sin
// guardar la sesión. Si encuentra algo, se lo devuelve a Claude (decision «block») para que
// lo evalúe, corrija lo que sea un fallo real y se lo cuente al usuario.
//
// - Una sola ronda por turno, y solo en los turnos empezados con el interruptor encendido.
// - Solo en repositorios git: codex review compara con lo confirmado. Se revisa el
//   repositorio de los archivos de código que ha editado Claude (si son de varios, ninguno).
//   Revisa todos sus cambios sin confirmar, también los del usuario: se avisa en el botón y
//   a Claude. Codex puede además abrir otros archivos del proyecto, como Claude.
// - No se revisa el turno con el que se cierra una sesión («Guardar estado y cerrar»).
// - Si el usuario interrumpe (Esc) o cierra la pestaña, la revisión se para.
// - Lo que revisa Codex sale hacia OpenAI: se apunta en el «Log». Si un archivo tocado en
//   lo que se le va a enviar lleva una clave (secrets.js), o no se ha podido comprobar, no
//   se revisa.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EDIT_TOOLS, isCode } = require('./growth');
const { localStamp } = require('./applog');
const { scanText, decodeText } = require('./secrets');

// ¿Lleva algo con pinta de clave? Con todos los patrones (también los de configuración: un
// YAML pegado en una pregunta), y un carácter nulo no puede esconder el resto del texto.
const hasSecret = (...texts) => scanText(texts.map((t) => String(t || '')).join('\n').replace(/\0/g, ''), '', { allPatterns: true }).length > 0;
const MAX_FILE = 2 * 1024 * 1024;

// De los archivos que Claude le señala a Codex, el primero que lleve claves o no se pueda
// comprobar: { file, why } o null. Los que no existen no cuentan (Codex no los verá).
async function checkFiles(cwd, files) {
  for (const file of files.slice(0, 30)) {
    const full = path.resolve(cwd, file);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) return { file, why: 'big' };
    let text;
    try { text = decodeText(await fs.promises.readFile(full)); } catch { return { file, why: 'unreadable' }; }
    if (text !== null && scanText(text, full).length) return { file, why: 'secret' };
  }
  return null;
}

const MODEL = 'gpt-6.2-astra'; // el más capaz de los que ofrece Codex con ChatGPT (noviembre de 2026)
const EFFORT = 'xhigh'; // el máximo; cada consulta usa el que necesita (abajo)

// Cuánto razona Codex en cada consulta: lo que haga falta. Más razonamiento es más fino, pero
// tarda más y gasta más del plan de ChatGPT del usuario.
// - Revisión del código: por lo que cambia. Seguridad, despliegue o datos → a fondo; mucho
//   código → a fondo; un cambio pequeño → medio; lo demás → alto.
// - Crítica de un plan: alto; un plan largo → a fondo.
// - Segunda opinión: la profundidad que pida Claude («rapida», «normal» o «a_fondo»); si no la
//   pide, a fondo para seguridad, planes y problemas atascados, y alto para lo demás.
const SENSITIVE = /(auth|login|passw|contrase|secur|segur|crypt|cifr|token|secret|session|sesion|permis|oauth|jwt|(^|[\\/])\.env|docker|deploy|despliegue|infra|nginx|firewall|migrat|\.sql$)/i;
function reviewEffort({ lines = 0, paths = [] } = {}) {
  if (paths.some((p) => SENSITIVE.test(p))) return 'xhigh';
  if (lines > 300) return 'xhigh';
  if (lines <= 20) return 'medium';
  return 'high';
}
const planEffort = (plan) => (String(plan || '').length > 2500 ? 'xhigh' : 'high');
const DEPTHS = { rapida: 'medium', normal: 'high', a_fondo: 'xhigh' };
const opinionEffort = (scope, depth) => DEPTHS[depth] || (['seguridad', 'plan', 'problema'].includes(scope) ? 'xhigh' : 'high');
const MAX_SUMMARY = 2000; // caracteres del resumen de Codex que se le pasan a Claude
const MAX_FINDINGS = 12000; // y de los hallazgos
const WRAPUP_START = 'Voy a cerrar esta sesión ahora.'; // principio de lo que se escribe al cerrar

// Cuándo pedir la segunda opinión, dicho a cada sesión con su primer mensaje (y otra vez al
// cambiar el interruptor). La descripción de la herramienta ya lo dice, pero con muchos
// servidores MCP Claude Code difiere las herramientas y Claude solo ve su nombre hasta que la
// busca: en la prueba real (0.24.4) no la pedía por su cuenta ante una decisión de arquitectura
// y seguridad.
const ADVISOR_ON = 'ClaudHome · Codex asesora (activado por el usuario): tienes a Codex como asesor con la herramienta mcp__claudhome-codex__segunda_opinion (si no la tienes cargada, búscala con ToolSearch: «segunda_opinion»). Pídele su opinión por tu cuenta, sin esperar a que te lo pidan, en estos casos: '
  + 'decisiones importantes de arquitectura o del enfoque de una tarea grande (ámbito «codigo» o «flujo»); '
  + 'cambios de seguridad, como contraseñas, autenticación, permisos, datos personales o claves (ámbito «seguridad»); '
  + 'cambios de infraestructura, como despliegues, bases de datos o redes; '
  + 'antes de ejecutar el plan de una tarea grande fuera del modo planificación (ámbito «plan»; en modo planificación no hace falta, ClaudHome ya se lo envía al presentarlo); '
  + 'y cuando lleves dos o tres intentos sin resolver un problema (ámbito «problema»). '
  + 'Elige la profundidad (campo «profundidad»): «rapida» para una duda concreta, «normal» para una decisión de código corriente y «a_fondo» para seguridad, arquitectura de algo grande o un problema que se resiste (si no la indicas, ClaudHome la elige por el ámbito). '
  + 'No la uses para cosas sencillas. Tarda entre medio minuto y unos minutos (más cuanto más a fondo): dile al usuario que la pides. Con su respuesta, compárala con tu análisis y dale una sola recomendación, diciendo en qué coincidís y en qué no.';
const ADVISOR_EVERY = 30; // mensajes tras los que se le vuelve a recordar en una conversación larga
const ADVISOR_OFF = 'ClaudHome · Codex asesora desactivado por el usuario: ya no pidas segundas opiniones a Codex (la herramienta mcp__claudhome-codex__segunda_opinion se negará). Si el usuario te la pide, dile que lo active en la rueda de opciones, «Codex asesora».';

// Lo que cuenta como código para revisar: lo del aviso de crecimiento y las páginas HTML.
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[… recortado]` : text);

// ¿Está la carpeta dentro de un repositorio git? Se mira en disco (una carpeta o archivo
// .git en ella o en alguna superior) en vez de lanzar git: en Windows, un programa lanzado
// con la carpeta del proyecto como directorio de trabajo se busca primero en ella, y un
// git.exe del propio proyecto se ejecutaría fuera de la zona protegida de Codex.
function repoRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const isGitRepo = (cwd) => repoRoot(cwd) !== null;
// Para comparar repositorios: en Windows, sin distinguir mayúsculas.
const sameRepo = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Una salida sin hallazgos que en realidad dice que no ha podido revisar.
// («could not find any issues» sí es un veredicto: no encontró nada).
const INCONCLUSIVE = /\b(?:could not|couldn't|cannot|can't|unable to|was not able to|wasn't able to|failed to)\b[^.\n]{0,80}\b(?:review|inspect|read|access|run|load|open|determine)\b|\bplease (?:provide|share|paste|send)\b|\bno (?:he|ha|hemos|han|se ha) podido\b|\bno (?:puedo|pude|es posible)\b|\b(?:proporciona|comparte|pega)(?:me)? el diff\b/i;

// Lo que dice la revisión: { state: 'found' | 'clean' | 'unclear', parsed, count, priorities }.
// Sin hallazgos legibles pero con marcas [Pn], se trata como hallazgos (se pasa el texto
// tal cual); sin texto, no hay veredicto.
function verdict(parsed, text) {
  if (parsed.findings.length) {
    return { state: 'found', count: parsed.findings.length, priorities: parsed.findings.map((f) => f.priority) };
  }
  const marks = [...String(text).matchAll(/\[P([0-3])\]/g)].map((m) => Number(m[1]));
  if (marks.length) return { state: 'found', count: marks.length, priorities: marks };
  const clear = String(text).trim() && !INCONCLUSIVE.test(String(text));
  return { state: clear ? 'clean' : 'unclear', count: 0, priorities: [] };
}

// Lo que se le dice a Claude cuando Codex encuentra algo.
function reasonFor(parsed, text, effort = EFFORT) {
  const findings = parsed.findings.length
    ? parsed.findings.map((f) => `- [P${f.priority}] ${f.title}${f.location ? ` — ${f.location}` : ''}${f.body ? `\n  ${f.body}` : ''}`).join('\n\n')
    : String(text).trim();
  const { count, priorities } = verdict(parsed, text);
  const detail = [0, 1, 2, 3].map((p) => priorities.filter((x) => x === p).length).map((n, p) => (n ? `${n} P${p}` : '')).filter(Boolean).join(', ');
  return [
    `ClaudHome · segundo revisor: Codex (${MODEL}, razonamiento ${effort}) ha revisado los cambios sin confirmar del proyecto y ha encontrado ${count} posibles problemas (${detail}; P0 es el más grave, P3 el más leve).`,
    parsed.findings.length && parsed.summary ? `Su resumen: ${clip(parsed.summary, MAX_SUMMARY)}` : '',
    'Hallazgos:',
    clip(findings, MAX_FINDINGS),
    'Evalúa cada uno con criterio propio: corrige los que sean fallos reales, empezando por los más graves; si alguno no aplica o no compensa, no lo cambies.',
    'Codex revisa todos los cambios sin confirmar del proyecto, no solo los tuyos: si un hallazgo trata de algo que no has cambiado tú en esta sesión, no lo toques y coméntaselo al usuario.',
    'Si corriges algo y el proyecto tiene pruebas, vuelve a pasarlas antes de terminar.',
    'Al terminar, cuéntale al usuario en pocas frases qué has corregido y qué has descartado y por qué. Codex no volverá a revisar en este turno.',
  ].filter(Boolean).join('\n\n');
}

// tabs: la tabla de pestañas; store: estado de la app (clave «codexReview»); usable():
// Codex está instalado y con sesión de ChatGPT; codex: { reviewChanges, parseReview };
// send(canal, …): avisa a la interfaz; log: registro de la app; logsDir(): carpeta de
// registros; detailedLogs(): si se guarda la salida completa de cada revisión (el
// interruptor de depuración); netlog(): el «Log» (o null si aún no existe);
// checkSecrets(cwd, signal): { ok, files, aborted, empty } de lo que se enviaría a Codex
// (secrets.js); checkLogin(): si Codex tiene ahora mismo la sesión de ChatGPT;
// onBusy(+1 | -1, tabId, qué, icono): Codex empieza o deja de trabajar para esa pestaña
// (indicador de la barra superior; icono: 'review', 'plan', 'opinion' o 'security');
// sandboxMissing(): a Codex le falta configurar su zona protegida de Windows;
// extraFor(tabId): esa pestaña tiene SuperPowers, que incluye la revisión final de Codex aunque
// «Codex asesora» esté apagado (solo la revisión del final: ni el plan ni la segunda opinión).
// Lo que se le dice a Claude cuando la revisión se hizo a la vez que su pasada final.
const EARLY_NOTE = 'Codex ha revisado tus cambios tal como estaban al pedirte la pasada final, mientras la hacías: si algo de lo que dice ya lo has corregido en la pasada, sáltatelo.';
const FOLLOW_SOON = 'Como en la pasada cambiaste código, Codex ya está revisando el cambio otra vez, con eso incluido, mientras corriges esto: lo que encuentre te llegará al terminar.';
const FOLLOW_NOTE = 'Segunda ronda: Codex ha vuelto a revisar el cambio con lo que hiciste en la pasada final. Lo que ya hayas corregido o decidido no cambiar (con motivo), sáltatelo.';
// El esfuerzo de la segunda ronda, como mucho «high»: es un repaso, que no haga esperar.
const LEVELS = ['low', 'medium', 'high', 'xhigh'];
const capEffort = (effort, cap) => (cap && LEVELS.indexOf(effort) > LEVELS.indexOf(cap) ? cap : effort);

function createReview({ tabs, store, usable, codex, send, log, logsDir, detailedLogs = () => true, netlog = () => null, checkSecrets = async () => ({ ok: true, files: [] }), checkLogin = async () => true, onBusy = () => {}, sandboxMissing = () => false, extraFor = () => false }) {
  let enabled = store.get('codexReview', false) === true; // apagado hasta que el usuario lo encienda
  // ¿Se revisa lo de esta pestaña al terminar? Con «Codex asesora» o con SuperPowers.
  const reviews = (tabId) => enabled || Boolean(extraFor(tabId));
  // Consultas a Codex en marcha: al apagar el interruptor se paran todas.
  const running = new Set();
  function linked(signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    running.add(controller);
    return { signal: controller.signal, done: () => { running.delete(controller); if (signal) signal.removeEventListener('abort', onAbort); } };
  }

  // Empieza un turno: todavía no ha editado nada ni se ha revisado. Se revisará solo si el
  // interruptor estaba encendido al empezar, y nunca el turno de cerrar la sesión.
  function turnStarted(tabId, prompt, request = null) {
    const tab = tabs.ensure(tabId);
    tab.request = typeof request === 'string' ? request : (typeof prompt === 'string' ? prompt : ''); // para criticar un plan
    tab.planReviewed = false;
    tab.turn = (tab.turn || 0) + 1;
    tab.edited = false;
    tab.reviewRepo = undefined; // repositorio de lo editado: undefined = aún nada, '' = sin git, null = varios
    tab.reviewed = false;
    tab.reviewPending = false;
    tab.reviewArmed = reviews(tabId);
    tab.reviewSkip = typeof prompt === 'string' && prompt.startsWith(WRAPUP_START.slice(0, 30));
    // Las de un turno ya pasado no siguen.
    if (tab.reviewEarly) { tab.reviewEarly.abort(); tab.reviewEarly = null; }
    if (tab.reviewFollow) { tab.reviewFollow.abort(); tab.reviewFollow = null; }
    tab.reviewEdits = 0;
  }

  // Claude ha usado una herramienta: ¿ha editado código, y de qué repositorio? Si no se
  // sabe qué archivo era, se cuenta como código de la carpeta de la pestaña. cwd: la
  // carpeta de trabajo de la sesión en ese momento (para las rutas relativas).
  function toolUsed(tabId, toolName, file = null, cwd = null) {
    if (!EDIT_TOOLS.has(toolName)) return;
    const tab = tabs.ensure(tabId);
    if (!reviews(tabId) || !tab.reviewArmed || tab.reviewed || tab.reviewSkip) return; // este turno no se revisa
    const known = typeof file === 'string' && file;
    if (known && !isCode(file)) return; // documentos, datos, notas…: no piden revisión
    const base = cwd || tab.folder;
    if (!base && !(known && path.isAbsolute(file))) return; // no se sabe dónde está
    const full = known ? path.resolve(base || '', file) : path.join(base, '.');
    const repo = repoRoot(known ? path.dirname(full) : full) || '';
    // Un archivo fuera del proyecto y de cualquier repositorio (los guiones o vistas previas que
    // Claude deja en su carpeta temporal) no cuenta: si no, la revisión creería que hay «varios
    // repositorios» y no se haría.
    if (!repo && known && tab.folder) {
      const rel = path.relative(tab.folder, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    }
    if (tab.reviewRepo === undefined) tab.reviewRepo = repo;
    else if (tab.reviewRepo === null || !sameRepo(tab.reviewRepo, repo)) tab.reviewRepo = null; // de varios sitios
    tab.edited = true;
    tab.reviewEdits = (tab.reviewEdits || 0) + 1;
  }

  // ¿Hay que revisar en este Stop? Se decide al recibir el aviso, antes de responder,
  // para que la interfaz no dé el turno por terminado mientras Codex revisa.
  function willReview(tabId, event) {
    const tab = tabs.get(tabId);
    // Tras otro aviso del Stop (stopHookActive), solo si ese aviso era de ClaudHome: el de las
    // pruebas o la pasada final de SuperPowers.
    const follow = Boolean(tab && tab.reviewFollow && tab.reviewFollow.turn === tab.turn && reviews(tabId));
    const go = follow || Boolean(reviews(tabId) && tab && tab.reviewArmed && tab.edited
      && !tab.reviewSkip && !tab.reviewed && (!(event && event.stopHookActive) || tab.testsAsked || tab.superAsked) && usable());
    if (tab) tab.reviewPending = go;
    return go;
  }

  // Con SuperPowers, la revisión empieza a la vez que la pasada final, no después: se lanza al
  // pedirle la pasada (primer Stop) y lo que encuentre se le da a Claude cuando la termine
  // (siguiente Stop). Así Claude no espera a Codex con las manos quietas. Devuelve si se lanza.
  function startEarly(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.reviewEarly || !reviews(tabId) || !tab.reviewArmed || !tab.edited || tab.reviewSkip || tab.reviewed || !usable()) return false;
    const cwd = tab.reviewRepo;
    if (!cwd) return false; // sin git o de varios repositorios: lo dirá onStop, como siempre
    tab.reviewEarly = launch(tabId, tab, cwd);
    log('revisión de Codex: empieza a la vez que la pasada final');
    return true;
  }

  // Una revisión en segundo plano: { turn, edits (las contadas al lanzarla), state (el último
  // que ha dado), promise, abort }.
  function launch(tabId, tab, cwd, cap = null) {
    const job = { turn: tab.turn, edits: tab.reviewEdits || 0, state: null };
    const post = (result) => { job.state = result.state; job.last = result; if (tab.turn === job.turn) send('review:result', tabId, result); };
    const own = new AbortController();
    const link = linked(own.signal);
    job.abort = () => own.abort();
    job.promise = reviewRun(tabId, tab, job.turn, post, cwd, link.signal, cap)
      .catch((err) => { log(`revisión de Codex: ha fallado (${(err && err.message) || err})`); post({ state: 'error', seconds: 0 }); return null; })
      .finally(() => link.done());
    return job;
  }

  // Si la revisión acabó antes de que Claude terminara (sin hallazgos, con claves, con un fallo…),
  // la interfaz ya lo supo; al pararse Claude la pestaña vuelve a «revisando», así que se le
  // repite cómo acabó para que no se quede ahí.
  function repost(tabId, tab, job) {
    if (job.last && job.last.state !== 'running' && tab.turn === job.turn) send('review:result', tabId, job.last);
  }

  // Segunda ronda: el cambio otra vez, con lo que Claude hizo en la pasada final.
  function startFollow(tabId, tab) {
    if (!reviews(tabId) || !usable() || !tab.reviewRepo) return null;
    log('revisión de Codex: segunda ronda, con lo que cambió en la pasada final');
    tab.reviewFollow = launch(tabId, tab, tab.reviewRepo, 'high');
    return tab.reviewFollow;
  }

  // Lo que encontró la revisión lanzada con la pasada; si se interrumpe el turno, se para.
  function awaitEarly(early, signal) {
    return new Promise((resolve) => {
      const onAbort = () => { early.abort(); resolve(null); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      early.promise.then((result) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
  }

  // Guarda la salida completa de una revisión (solo con la depuración activada).
  function saveDetails(cwd, result) {
    if (!detailedLogs()) return null;
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      const file = path.join(logsDir(), `revision-codex-${localStamp()}-${crypto.randomBytes(3).toString('hex')}.log`);
      fs.writeFileSync(file, `Carpeta: ${cwd}\nModelo: ${MODEL} (${result.effort || EFFORT})\nDuración: ${result.seconds} s · código ${result.code}${result.aborted ? ' · interrumpida' : ''}\n\n== Resultado ==\n${result.text}\n\n== Registro de Codex ==\n${result.log}\n`);
      return file;
    } catch { return null; } // sin registro, se sigue
  }

  // La revisión en sí. Devuelve la respuesta al hook Stop, o null si no hay nada que decir.
  async function onStop(tabId, event, signal) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.reviewPending) return null;
    tab.reviewPending = false;
    // La segunda ronda, lanzada al darle la primera: lo que encuentre, al terminar de corregir.
    const follow = tab.reviewFollow;
    if (follow && follow.turn === tab.turn) {
      tab.reviewFollow = null;
      const result = await awaitEarly(follow, signal);
      if (result && result.reason) return { ...result, reason: `${FOLLOW_NOTE}\n\n${result.reason}` };
      repost(tabId, tab, follow);
      return result;
    }
    tab.reviewed = true; // la primera ronda, una vez por turno
    tab.edited = false;
    // Ya empezó con la pasada final: se espera (si no ha acabado) y se le da lo que encontró.
    const early = tab.reviewEarly;
    if (early && early.turn === tab.turn) {
      tab.reviewEarly = null;
      const changed = (tab.reviewEdits || 0) > early.edits; // ¿la pasada cambió código?
      const result = await awaitEarly(early, signal);
      if (signal && signal.aborted) return null;
      if (result && result.reason) {
        // Mientras corrige esto, Codex mira el cambio otra vez con lo de la pasada.
        const again = changed && startFollow(tabId, tab);
        return { ...result, reason: `${EARLY_NOTE}${again ? ` ${FOLLOW_SOON}` : ''}\n\n${result.reason}` };
      }
      // Sin hallazgos, pero la pasada cambió código: lo último se revisa ahora (como antes).
      if (changed && early.state === 'clean') {
        const again = startFollow(tabId, tab);
        if (!again) return null;
        tab.reviewFollow = null;
        const second = await awaitEarly(again, signal);
        return second && second.reason ? { ...second, reason: `${FOLLOW_NOTE}\n\n${second.reason}` } : second;
      }
      repost(tabId, tab, early);
      return result;
    }
    // Lo que llegue cuando el usuario ya ha empezado otro turno no cambia su estado.
    const turn = tab.turn;
    const post = (result) => { if (tab.turn === turn) send('review:result', tabId, result); };
    // Se revisa el repositorio de lo que ha editado Claude, no la carpeta en la que acabe.
    const cwd = tab.reviewRepo;
    if (cwd === null) {
      log('revisión de Codex: Claude ha editado código de varios repositorios; no se revisa');
      post({ state: 'skipped', reason: 'Claude ha cambiado código de varios repositorios en este turno, y Codex revisa solo uno: esta vez no se revisa.' });
      return null;
    }
    if (!cwd) {
      log('revisión de Codex: lo editado no está en un repositorio git; no se revisa');
      post({ state: 'skipped', reason: 'Codex solo revisa proyectos con git: este no lo es.' });
      return null;
    }
    // Lo que se va a enviar no puede llevar claves (y tiene que poder comprobarse).
    const link = linked(signal);
    try {
      return await reviewRun(tabId, tab, turn, post, cwd, link.signal);
    } finally { link.done(); }
  }

  // La revisión, ya decidido el repositorio: comprobación de claves, cuenta y Codex.
  async function reviewRun(tabId, tab, turn, post, cwd, signal, cap = null) {
    const input = await checkSecrets(cwd, signal);
    if (input.aborted || (signal && signal.aborted)) {
      post({ state: 'aborted', seconds: 0 });
      return null;
    }
    if (tab.turn !== turn) return null; // el usuario ya ha seguido: no se lanza
    if (!reviews(tabId)) { // apagado mientras se comprobaba: no se envía nada
      post({ state: 'nothing' });
      return null;
    }
    if (input.ok && input.empty) {
      log('revisión de Codex: no quedan cambios sin confirmar; no se revisa');
      post({ state: 'nothing' });
      return null;
    }
    if (!input.ok || input.files.length) {
      log(`revisión de Codex: no se revisa porque ${input.ok ? `${input.files.length} archivo(s) llevan claves` : 'no se ha podido comprobar si lo que se enviaría lleva claves'}`);
      post({ state: 'secret', files: input.files.slice(0, 5), unchecked: !input.ok });
      return null;
    }
    if (signal && signal.aborted) {
      post({ state: 'aborted', seconds: 0 });
      return null;
    }
    if (!(await checkLogin())) {
      log('revisión de Codex: Codex no tiene ahora la sesión de ChatGPT; no se revisa');
      post({ state: 'skipped', reason: 'Codex no tiene ahora la sesión de tu cuenta de ChatGPT, y la revisión solo se hace con ella.' });
      return null;
    }
    if (signal && signal.aborted) {
      post({ state: 'aborted', seconds: 0 });
      return null;
    }
    if (tab.turn !== turn || !reviews(tabId)) return null;
    post({ state: 'running' });
    const effort = capEffort(reviewEffort(input), cap);
    log(`revisión de Codex: empieza en ${cwd} (${MODEL}, razonamiento ${effort}: ${input.lines || 0} líneas en ${(input.paths || []).length} archivos)`);
    // Se anota antes de enviar nada: si la app se cierra a mitad, la salida ya consta.
    const record = netlog();
    if (record) {
      record.record({ tabId, kind: 'revision', target: `Cambios sin confirmar de ${cwd}`, detail: `${MODEL} · ${effort}`, dest: 'OpenAI (Codex)', external: true });
    }
    onBusy(1, tabId, 'revisión del código', 'review');
    let result;
    try {
      result = await codex.reviewChanges({ cwd, model: MODEL, effort, signal });
    } finally { onBusy(-1, tabId, 'revisión del código', 'review'); }
    result.effort = effort;
    const file = saveDetails(cwd, result);
    if (!reviews(tabId)) { post({ state: 'aborted', seconds: result.seconds }); return null; } // apagado mientras revisaba
    if (tab.turn !== turn) { // el usuario ya ha seguido: lo encontrado no se le devuelve a Claude
      log(`revisión de Codex: terminada tras ${result.seconds} s, pero el turno ya había cambiado; no se usa`);
      return null;
    }
    if (result.aborted) {
      log(`revisión de Codex: interrumpida tras ${result.seconds} s`);
      post({ state: 'aborted', seconds: result.seconds });
      return null;
    }
    const parsed = codex.parseReview(result.text);
    const v = result.ok ? verdict(parsed, result.text) : { state: 'error' };
    if (result.blocked && v.state !== 'found') {
      log(`revisión de Codex: Codex no ha podido leer el proyecto (${readWhy()}) tras ${result.seconds} s`);
      post({ state: 'blocked', op: 'review', seconds: result.seconds });
      return null;
    }
    // Algún comando rechazado y otros bien es habitual (Codex prueba otra vía): solo al registro.
    if (result.partial) log('revisión de Codex: algunos comandos de Codex se rechazaron, pero pudo leer el proyecto por otra vía');
    const partial = v.state === 'found' && Boolean(result.blocked); // hallazgos sin haber podido leer el proyecto
    if (v.state === 'error' || v.state === 'unclear') {
      const why = v.state === 'error' ? `ha fallado (código ${result.code})` : 'no ha dado un veredicto claro';
      log(`revisión de Codex: ${why} tras ${result.seconds} s${file ? `; detalles en ${path.basename(file)}` : ''}`);
      post({ state: 'error', unclear: v.state === 'unclear', seconds: result.seconds, file });
      return null;
    }
    log(`revisión de Codex: ${v.count} hallazgos en ${result.seconds} s`);
    post({ state: v.state, count: v.count, priorities: v.priorities, seconds: result.seconds, file, partial });
    if (v.state !== 'found') return null;
    const reason = reasonFor(parsed, result.text, result.effort);
    return { decision: 'block', reason: partial ? `Aviso: Codex no ha podido leer parte del proyecto (${readWhy()}), así que su revisión puede estar incompleta.\n\n${reason}` : reason };
  }

  // Por qué no ha podido leer el proyecto, para Claude.
  const readWhy = () => (sandboxMissing() ? 'su zona protegida de Windows no está configurada' : 'se le ha denegado el acceso a los archivos');

  // Anota una salida hacia OpenAI antes de hacerla.
  function recordOut(tabId, kind, target, cwd, effort) {
    const record = netlog();
    if (record) record.record({ tabId, kind, target, detail: `${MODEL} · ${effort} · ${cwd}`, dest: 'OpenAI (Codex)', external: true });
  }

  // Claude presenta un plan (PreToolUse de ExitPlanMode). Con «Codex asesora», Codex lo
  // critica antes y se le devuelve a Claude («deny» con la crítica) para que lo ajuste y lo
  // vuelva a presentar: una vez por turno. Devuelve la respuesta al hook, o null.
  async function onPlan(tabId, event, signal) {
    const tab = tabs.get(tabId);
    const plan = event && typeof event.plan === 'string' ? event.plan.trim() : '';
    if (!tab || !tab.folder || !enabled || !tab.reviewArmed || tab.planReviewed || tab.reviewSkip || !usable()) return null;
    const turn = tab.turn;
    const post = (result) => { if (tab.turn === turn) send('review:result', tabId, result); };
    if (!plan) {
      // Demasiado grande para leerlo del aviso: se dice, en vez de dejarlo pasar sin más.
      if (event && event.planTooBig) {
        tab.planReviewed = true;
        log('crítica del plan: el plan es demasiado grande para enviárselo a Codex');
        post({ state: 'plan-error', reason: 'big' });
      }
      return null;
    }
    tab.planReviewed = true;
    // En la carpeta en la que trabaja Claude ahora (p. ej. otra copia del repositorio).
    const cwd = (event && event.cwd) || tab.cwd || tab.folder;
    if (hasSecret(tab.request, plan)) {
      log('crítica del plan: el plan o la petición llevan algo con pinta de clave; no se envía a Codex');
      post({ state: 'plan-secret' });
      return null;
    }
    if (!(await checkLogin()) || (signal && signal.aborted) || tab.turn !== turn || !enabled) return null;
    post({ state: 'plan-running' });
    const effort = planEffort(plan);
    log(`crítica del plan: empieza en ${cwd} (${MODEL}, razonamiento ${effort})`);
    recordOut(tabId, 'plan', 'Plan de Claude y la petición del usuario', cwd, effort);
    onBusy(1, tabId, 'crítica de un plan', 'plan');
    const link = linked(signal);
    let result;
    try {
      result = await codex.askCodex({ cwd, prompt: codex.planPrompt({ request: tab.request, plan }), model: MODEL, effort, signal: link.signal });
    } finally { onBusy(-1, tabId, 'crítica de un plan', 'plan'); link.done(); }
    if (!enabled) { post({ state: 'aborted', seconds: result.seconds }); return null; } // apagado mientras criticaba
    if (tab.turn !== turn) return null;
    if (result.aborted) { post({ state: 'aborted', seconds: result.seconds }); return null; }
    if (result.blocked) {
      log(`crítica del plan: Codex no ha podido leer el proyecto (${readWhy()}); el plan pasa sin crítica`);
      post({ state: 'blocked', op: 'plan', seconds: result.seconds });
      return null;
    }
    if (!result.ok) {
      log(`crítica del plan: Codex no ha respondido tras ${result.seconds} s${result.failure ? ` (${result.failure})` : ''}`);
      post({ state: 'plan-error', seconds: result.seconds });
      return null;
    }
    log(`crítica del plan: lista en ${result.seconds} s`);
    post({ state: 'plan-done', seconds: result.seconds });
    const reason = [
      `ClaudHome · segundo revisor: Codex (${MODEL}, razonamiento ${effort}) ha criticado tu plan antes de que el usuario lo vea. Todavía no se lo has presentado.`,
      `Su crítica:\n${result.text}`,
      'Revísalo con criterio propio: incorpora lo que lo mejore y descarta lo que no aplique a este proyecto.',
      'Después vuelve a presentarlo con ExitPlanMode, añadiendo al final una sección breve «Segunda opinión (Codex)» con en qué coincidís, qué has cambiado por su crítica y en qué discrepas y por qué.',
      'Codex no volverá a criticar el plan en este turno.',
    ].filter(Boolean).join('\n\n');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }

  // Herramienta «segunda_opinion»: Claude le plantea algo a Codex y recibe su análisis.
  // Lanza un error con un mensaje para Claude si no se puede.
  async function secondOpinion(tabId, args, signal) {
    if (!enabled) {
      throw new Error('El usuario tiene apagado el asesoramiento de Codex en ClaudHome (interruptor «Codex asesora»), así que no se le consulta nada. No vuelvas a intentarlo salvo que el usuario lo encienda; sigue con tu propio criterio.');
    }
    const tab = tabs.get(tabId);
    // En la carpeta del agente que la pide (la de su aviso PreToolUse), o la de la pestaña.
    const cwd = tab && (tab.opinionCwd || tab.cwd || tab.folder);
    if (!cwd) throw new Error('Esta sesión ya no está abierta en ClaudHome.');
    const question = args && typeof args.pregunta === 'string' ? args.pregunta.trim() : '';
    if (!question) throw new Error('Falta la pregunta para Codex (campo «pregunta»).');
    const files = args && Array.isArray(args.archivos) ? args.archivos.filter((f) => typeof f === 'string') : [];
    if (hasSecret(question, ...files)) {
      throw new Error('La pregunta o las rutas llevan lo que parece una clave o contraseña. Quítala (o pon solo el nombre de la variable) y vuelve a pedirla: las claves no se envían a Codex.');
    }
    if (!usable() || !(await checkLogin())) {
      throw new Error('Codex no tiene ahora la sesión de la cuenta de ChatGPT del usuario, y la segunda opinión solo se pide con ella.');
    }
    if ((signal && signal.aborted) || !enabled) throw new Error('La segunda opinión se ha cancelado.');
    // Los archivos que se le señalan a Codex, que los va a leer: sin claves.
    const blocked = await checkFiles(cwd, files);
    if (blocked) {
      throw new Error(blocked.why === 'secret'
        ? `${blocked.file} lleva lo que parece una clave o contraseña, así que no se le pide a Codex que lo lea. Quita ese archivo de «archivos» (o pasa la clave a un .env que git no suba) y vuelve a pedirla.`
        : `No se ha podido comprobar si ${blocked.file} lleva claves (${blocked.why === 'big' ? 'es demasiado grande' : 'no se puede leer'}). Quítalo de «archivos» y vuelve a pedirla.`);
    }
    const scope = codex.SCOPES[args.ambito] ? args.ambito : 'otro';
    const effort = opinionEffort(scope, args.profundidad);
    log(`segunda opinión: ${tabs.label ? tabs.label(tabId) : tabId} pregunta a Codex (${scope}, razonamiento ${effort}, ${question.length} caracteres)`);
    recordOut(tabId, 'opinion', `Segunda opinión (${codex.SCOPES[scope]})`, cwd, effort);
    send('review:result', tabId, { state: 'opinion-running' });
    // Una consulta de seguridad se distingue en el indicador (un escudo en vez del bocadillo).
    const job = scope === 'seguridad' ? ['segunda opinión de seguridad', 'security'] : ['segunda opinión', 'opinion'];
    onBusy(1, tabId, ...job);
    const link = linked(signal);
    let result;
    try {
      result = await codex.askCodex({ cwd, prompt: codex.opinionPrompt({ question, scope, files }), model: MODEL, effort, signal: link.signal });
    } finally { onBusy(-1, tabId, ...job); link.done(); }
    send('review:result', tabId, { state: 'opinion-done', ok: result.ok, seconds: result.seconds });
    if (!enabled) throw new Error('El usuario ha apagado el asesoramiento de Codex mientras respondía: no se usa su respuesta.');
    if (result.aborted) throw new Error('La segunda opinión se ha cancelado.');
    if (result.blocked) send('review:result', tabId, { state: 'blocked', op: 'opinion', seconds: result.seconds });
    if (!result.ok) {
      log(`segunda opinión: Codex no ha respondido tras ${result.seconds} s${result.blocked ? ` (no ha podido leer el proyecto: ${readWhy()})` : ''}${result.failure ? ` (${result.failure})` : ''}`);
      if (result.blocked) throw new Error(`Codex no ha podido leer el proyecto (${readWhy()}) y no ha dado su opinión. Díselo al usuario y sigue con tu propio criterio.`);
      throw new Error(`Codex no ha podido responder${result.failure ? `: ${result.failure}` : '.'}`);
    }
    log(`segunda opinión: lista en ${result.seconds} s${result.blocked ? ' (sin poder leer el proyecto)' : ''}`);
    return [
      result.blocked ? `Aviso: Codex no ha podido leer los archivos del proyecto (${readWhy()}), así que su opinión se basa solo en lo que le has contado. Tenlo en cuenta y díselo al usuario.` : '',
      `Segunda opinión de Codex (${MODEL}, razonamiento ${effort}, ${result.seconds} s):`,
      result.text,
      'Compárala con tu propio análisis y no la sigas a ciegas. Dale al usuario una sola recomendación y cuéntale en una o dos frases en qué coincidís y en qué no.',
    ].filter(Boolean).join('\n\n');
  }

  // Lo que la sesión tiene que saber de «Codex asesora» con este mensaje: cuándo pedir la
  // segunda opinión (una vez por sesión) o que se ha apagado; null si ya lo sabe.
  // Se vuelve a decir si la conversación ya no lo tiene: otra conversación (/clear, que cambia
  // su identificador), una conversación resumida (/compact o al llenarse: compacted) y, en una
  // conversación larga, cada ADVISOR_EVERY mensajes, para que no quede enterrado muy atrás.
  function advisorNote(tabId, prompt, sessionId = null) {
    const tab = tabs.ensure(tabId);
    if (typeof prompt === 'string' && prompt.startsWith(WRAPUP_START.slice(0, 30))) return null; // al cerrar, no
    const on = enabled && usable();
    tab.advisorPrompts = (tab.advisorPrompts || 0) + 1;
    const stale = tab.advisorTold === true && ((sessionId && tab.advisorSession && sessionId !== tab.advisorSession) || tab.advisorPrompts > ADVISOR_EVERY);
    if (on && (tab.advisorTold !== true || stale)) {
      const why = tab.advisorTold !== true ? 'cuándo pedir la segunda opinión' : 'otra vez cuándo pedir la segunda opinión';
      tab.advisorTold = true;
      tab.advisorSession = sessionId || tab.advisorSession || null;
      tab.advisorPrompts = 0;
      log(`«Codex asesora»: se le dice a la sesión ${tabId} ${why}`);
      return ADVISOR_ON;
    }
    if (!on && tab.advisorTold === true) {
      tab.advisorTold = false;
      return ADVISOR_OFF;
    }
    return null;
  }
  // Una sesión que arranca (nueva o retomada) no sabe nada todavía.
  const sessionStarted = (tabId) => { tabs.ensure(tabId).advisorTold = undefined; };
  // La conversación se ha resumido (PostCompact): el aviso puede haberse quedado fuera.
  const compacted = (tabId) => { const tab = tabs.get(tabId); if (tab && tab.advisorTold === true) tab.advisorTold = undefined; };

  return {
    advisorNote,
    sessionStarted,
    compacted,
    turnStarted,
    toolUsed,
    willReview,
    startEarly,
    onStop,
    onPlan,
    secondOpinion,
    get enabled() { return enabled; },
    set enabled(value) {
      enabled = Boolean(value);
      store.set('codexReview', enabled);
      if (!enabled) for (const controller of running) controller.abort(); // apagado: nada sigue
    },
    MODEL,
    EFFORT,
  };
}

module.exports = { createReview, EARLY_NOTE, FOLLOW_NOTE, FOLLOW_SOON, isGitRepo, repoRoot, reasonFor, verdict, reviewEffort, planEffort, opinionEffort, MODEL, EFFORT, WRAPUP_START, ADVISOR_ON, ADVISOR_OFF, ADVISOR_EVERY };
