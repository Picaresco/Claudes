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
const { EDIT_TOOLS, CODE } = require('./growth');
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
const EFFORT = 'xhigh';
const MAX_SUMMARY = 2000; // caracteres del resumen de Codex que se le pasan a Claude
const MAX_FINDINGS = 12000; // y de los hallazgos
const WRAPUP_START = 'Voy a cerrar esta sesión ahora.'; // principio de lo que se escribe al cerrar

const two = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
// Lo que cuenta como código para revisar: lo del aviso de crecimiento y las páginas HTML.
const isCode = (file) => CODE.test(file) || /\.html?$/i.test(file);
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
function reasonFor(parsed, text) {
  const findings = parsed.findings.length
    ? parsed.findings.map((f) => `- [P${f.priority}] ${f.title}${f.location ? ` — ${f.location}` : ''}${f.body ? `\n  ${f.body}` : ''}`).join('\n\n')
    : String(text).trim();
  const { count, priorities } = verdict(parsed, text);
  const detail = [0, 1, 2, 3].map((p) => priorities.filter((x) => x === p).length).map((n, p) => (n ? `${n} P${p}` : '')).filter(Boolean).join(', ');
  return [
    `ClaudHome · segundo revisor: Codex (${MODEL}, razonamiento ${EFFORT}) ha revisado los cambios sin confirmar del proyecto y ha encontrado ${count} posibles problemas (${detail}; P0 es el más grave, P3 el más leve).`,
    parsed.findings.length && parsed.summary ? `Su resumen: ${clip(parsed.summary, MAX_SUMMARY)}` : '',
    'Hallazgos:',
    clip(findings, MAX_FINDINGS),
    'Evalúa cada uno con criterio propio: corrige los que sean fallos reales, empezando por los más graves; si alguno no aplica o no compensa, no lo cambies.',
    'Codex revisa todos los cambios sin confirmar del proyecto, no solo los tuyos: si un hallazgo trata de algo que no has cambiado tú en esta sesión, no lo toques y coméntaselo al usuario.',
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
// onBusy(+1 | -1): Codex empieza o deja de trabajar (indicador de la barra superior).
function createReview({ tabs, store, usable, codex, send, log, logsDir, detailedLogs = () => true, netlog = () => null, checkSecrets = async () => ({ ok: true, files: [] }), checkLogin = async () => true, onBusy = () => {} }) {
  let enabled = store.get('codexReview', false) === true; // apagado hasta que el usuario lo encienda
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
    tab.reviewArmed = enabled;
    tab.reviewSkip = typeof prompt === 'string' && prompt.startsWith(WRAPUP_START.slice(0, 30));
  }

  // Claude ha usado una herramienta: ¿ha editado código, y de qué repositorio? Si no se
  // sabe qué archivo era, se cuenta como código de la carpeta de la pestaña. cwd: la
  // carpeta de trabajo de la sesión en ese momento (para las rutas relativas).
  function toolUsed(tabId, toolName, file = null, cwd = null) {
    if (!EDIT_TOOLS.has(toolName)) return;
    const tab = tabs.ensure(tabId);
    if (!enabled || !tab.reviewArmed || tab.reviewed || tab.reviewSkip) return; // este turno no se revisa
    const known = typeof file === 'string' && file;
    if (known && !isCode(file)) return; // documentos, datos, notas…: no piden revisión
    const base = cwd || tab.folder;
    if (!base && !(known && path.isAbsolute(file))) return; // no se sabe dónde está
    const full = known ? path.resolve(base || '', file) : path.join(base, '.');
    const repo = repoRoot(known ? path.dirname(full) : full) || '';
    if (tab.reviewRepo === undefined) tab.reviewRepo = repo;
    else if (tab.reviewRepo === null || !sameRepo(tab.reviewRepo, repo)) tab.reviewRepo = null; // de varios sitios
    tab.edited = true;
  }

  // ¿Hay que revisar en este Stop? Se decide al recibir el aviso, antes de responder,
  // para que la interfaz no dé el turno por terminado mientras Codex revisa.
  function willReview(tabId, event) {
    const tab = tabs.get(tabId);
    const go = Boolean(enabled && tab && tab.reviewArmed && tab.edited
      && !tab.reviewSkip && !tab.reviewed && !(event && event.stopHookActive) && usable());
    if (tab) tab.reviewPending = go;
    return go;
  }

  // Guarda la salida completa de una revisión (solo con la depuración activada).
  function saveDetails(cwd, result) {
    if (!detailedLogs()) return null;
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      const file = path.join(logsDir(), `revision-codex-${stamp()}-${crypto.randomBytes(3).toString('hex')}.log`);
      fs.writeFileSync(file, `Carpeta: ${cwd}\nModelo: ${MODEL} (${EFFORT})\nDuración: ${result.seconds} s · código ${result.code}${result.aborted ? ' · interrumpida' : ''}\n\n== Resultado ==\n${result.text}\n\n== Registro de Codex ==\n${result.log}\n`);
      return file;
    } catch { return null; } // sin registro, se sigue
  }

  // La revisión en sí. Devuelve la respuesta al hook Stop, o null si no hay nada que decir.
  async function onStop(tabId, event, signal) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.reviewPending) return null;
    tab.reviewPending = false;
    tab.reviewed = true; // una sola ronda por turno
    tab.edited = false;
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
  async function reviewRun(tabId, tab, turn, post, cwd, signal) {
    const input = await checkSecrets(cwd, signal);
    if (input.aborted || (signal && signal.aborted)) {
      post({ state: 'aborted', seconds: 0 });
      return null;
    }
    if (tab.turn !== turn) return null; // el usuario ya ha seguido: no se lanza
    if (!enabled) { // apagado mientras se comprobaba: no se envía nada
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
    if (tab.turn !== turn || !enabled) return null;
    post({ state: 'running' });
    log(`revisión de Codex: empieza en ${cwd} (${MODEL}, ${EFFORT})`);
    // Se anota antes de enviar nada: si la app se cierra a mitad, la salida ya consta.
    const record = netlog();
    if (record) {
      record.record({ tabId, kind: 'revision', target: `Cambios sin confirmar de ${cwd}`, detail: `${MODEL} · ${EFFORT}`, dest: 'OpenAI (Codex)', external: true });
    }
    onBusy(1);
    let result;
    try {
      result = await codex.reviewChanges({ cwd, model: MODEL, effort: EFFORT, signal });
    } finally { onBusy(-1); }
    const file = saveDetails(cwd, result);
    if (!enabled) { post({ state: 'aborted', seconds: result.seconds }); return null; } // apagado mientras revisaba
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
    if (v.state === 'error' || v.state === 'unclear') {
      const why = v.state === 'error' ? `ha fallado (código ${result.code})` : 'no ha dado un veredicto claro';
      log(`revisión de Codex: ${why} tras ${result.seconds} s${file ? `; detalles en ${path.basename(file)}` : ''}`);
      post({ state: 'error', unclear: v.state === 'unclear', seconds: result.seconds, file });
      return null;
    }
    log(`revisión de Codex: ${v.count} hallazgos en ${result.seconds} s`);
    post({ state: v.state, count: v.count, priorities: v.priorities, seconds: result.seconds, file });
    if (v.state !== 'found') return null;
    return { decision: 'block', reason: reasonFor(parsed, result.text) };
  }

  // Anota una salida hacia OpenAI antes de hacerla.
  function recordOut(tabId, kind, target, cwd) {
    const record = netlog();
    if (record) record.record({ tabId, kind, target, detail: `${MODEL} · ${EFFORT} · ${cwd}`, dest: 'OpenAI (Codex)', external: true });
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
    log(`crítica del plan: empieza en ${cwd} (${MODEL}, ${EFFORT})`);
    recordOut(tabId, 'plan', 'Plan de Claude y la petición del usuario', cwd);
    onBusy(1);
    const link = linked(signal);
    let result;
    try {
      result = await codex.askCodex({ cwd, prompt: codex.planPrompt({ request: tab.request, plan }), model: MODEL, effort: EFFORT, signal: link.signal });
    } finally { onBusy(-1); link.done(); }
    if (!enabled) { post({ state: 'aborted', seconds: result.seconds }); return null; } // apagado mientras criticaba
    if (tab.turn !== turn) return null;
    if (result.aborted) { post({ state: 'aborted', seconds: result.seconds }); return null; }
    if (!result.ok) {
      log(`crítica del plan: Codex no ha respondido tras ${result.seconds} s${result.failure ? ` (${result.failure})` : ''}`);
      post({ state: 'plan-error', seconds: result.seconds });
      return null;
    }
    log(`crítica del plan: lista en ${result.seconds} s`);
    post({ state: 'plan-done', seconds: result.seconds });
    const reason = [
      `ClaudHome · segundo revisor: Codex (${MODEL}, razonamiento ${EFFORT}) ha criticado tu plan antes de que el usuario lo vea. Todavía no se lo has presentado.`,
      `Su crítica:\n${result.text}`,
      'Revísalo con criterio propio: incorpora lo que lo mejore y descarta lo que no aplique a este proyecto.',
      'Después vuelve a presentarlo con ExitPlanMode, añadiendo al final una sección breve «Segunda opinión (Codex)» con en qué coincidís, qué has cambiado por su crítica y en qué discrepas y por qué.',
      'Codex no volverá a criticar el plan en este turno.',
    ].join('\n\n');
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
    log(`segunda opinión: ${tabs.label ? tabs.label(tabId) : tabId} pregunta a Codex (${scope}, ${question.length} caracteres)`);
    recordOut(tabId, 'opinion', `Segunda opinión (${codex.SCOPES[scope]})`, cwd);
    send('review:result', tabId, { state: 'opinion-running' });
    onBusy(1);
    const link = linked(signal);
    let result;
    try {
      result = await codex.askCodex({ cwd, prompt: codex.opinionPrompt({ question, scope, files }), model: MODEL, effort: EFFORT, signal: link.signal });
    } finally { onBusy(-1); link.done(); }
    send('review:result', tabId, { state: 'opinion-done', ok: result.ok, seconds: result.seconds });
    if (!enabled) throw new Error('El usuario ha apagado el asesoramiento de Codex mientras respondía: no se usa su respuesta.');
    if (result.aborted) throw new Error('La segunda opinión se ha cancelado.');
    if (!result.ok) {
      log(`segunda opinión: Codex no ha respondido tras ${result.seconds} s${result.failure ? ` (${result.failure})` : ''}`);
      throw new Error(`Codex no ha podido responder${result.failure ? `: ${result.failure}` : '.'}`);
    }
    log(`segunda opinión: lista en ${result.seconds} s`);
    return [
      `Segunda opinión de Codex (${MODEL}, razonamiento ${EFFORT}, ${result.seconds} s):`,
      result.text,
      'Compárala con tu propio análisis y no la sigas a ciegas. Dale al usuario una sola recomendación y cuéntale en una o dos frases en qué coincidís y en qué no.',
    ].join('\n\n');
  }

  return {
    turnStarted,
    toolUsed,
    willReview,
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

module.exports = { createReview, isGitRepo, repoRoot, reasonFor, verdict, MODEL, EFFORT, WRAPUP_START };
