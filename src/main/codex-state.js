// Lo que la app sabe de Codex en este equipo y lo que está haciendo ahora mismo:
//   - si está instalado, con qué sesión y si es lo bastante reciente para asesorar;
//   - si Claude puede pedirle imágenes (interruptor «Imágenes con Codex»);
//   - cuánto lleva gastado del plan de ChatGPT (barra inferior): al detectarlo, cada 10
//     minutos y poco después de cada trabajo. Leerlo no gasta nada;
//   - cada trabajo en curso, con su pestaña y desde cuándo (indicador de la barra superior);
//   - y genera las imágenes que pide Claude con la herramienta «generar_imagen».
// Cada cambio se avisa a la interfaz por «codex:changed».
const LIMITS_EVERY = 10 * 60 * 1000;
const LIMITS_AFTER_JOB = 4000;

// codex: el módulo codex.js · tabs: tabs.js · send(canal, …): a la interfaz · persist(on):
// guarda el interruptor de imágenes · workDir(): carpeta temporal de las imágenes ·
// netlog(): el «Log», si ya existe.
function createCodexState({ codex, tabs, send = () => {}, log = () => {}, persist = () => {}, workDir = () => null, netlog = () => null }) {
  // jobs: [{ kind: 'advise' | 'draw', tabId, what, icon, startedAt }] (icon: con qué se pinta
  // en la barra superior: 'review', 'plan', 'opinion', 'security' o 'draw').
  let state = { installed: false, loggedIn: false, mode: null, enabled: false, jobs: [], checkedAt: 0 };
  const label = (tabId) => (tabs.label ? tabs.label(tabId) : tabId);

  // Solo se usa con sesión de ChatGPT: es la suscripción lo que se quiere aprovechar.
  const usable = () => Boolean(state.installed && state.loggedIn && state.mode === 'chatgpt');
  // El asesor (segunda opinión, planes y revisión) necesita además una versión reciente de Codex.
  const advisorUsable = () => usable() && state.advisor !== false;

  function info() {
    const { installed, loggedIn, mode, enabled, advisor, limits } = state;
    // Para la interfaz: qué hace, para qué proyecto y desde cuándo.
    // tabId: de qué pestaña sale la petición (el vuelo de datos hacia Codex, ui/codex-flight.js).
    const jobs = state.jobs.map((job) => ({ kind: job.kind, what: job.what, icon: job.icon, tabId: job.tabId, tab: (tabs.get(job.tabId) || {}).name || null, startedAt: job.startedAt }));
    return {
      installed, loggedIn, mode, enabled, jobs, busy: jobs.length,
      advising: jobs.filter((job) => job.kind === 'advise').length, drawing: jobs.filter((job) => job.kind === 'draw').length,
      advisor: advisor !== false, usable: usable(), active: enabled && usable(), limits: limits || null,
    };
  }
  const changed = () => send('codex:changed', info());

  // Codex empieza (+1) o termina (-1) un trabajo para una pestaña.
  function job(delta, kind, tabId, what, icon) {
    if (delta > 0) { state.jobs.push({ kind, tabId, what, icon, startedAt: Date.now() }); return; }
    const at = state.jobs.findIndex((item) => item.kind === kind && item.tabId === tabId && item.what === what);
    if (at >= 0) state.jobs.splice(at, 1);
  }

  async function refresh() {
    const found = await codex.detect();
    state = { ...state, ...found, checkedAt: Date.now() };
    // El dato de uso es de una cuenta: sin sesión, o si la sesión ha cambiado, no vale.
    if (!usable() || (state.limits && state.limits.authStamp !== codex.authStamp())) state.limits = null;
    changed();
    refreshLimits();
    return info();
  }
  // Como mucho una comprobación por minuto, salvo que se pida expresamente.
  const status = (force) => (force || Date.now() - state.checkedAt > 60000 ? refresh() : info());

  // Uso del plan de ChatGPT en Codex.
  let limitsBusy = false;
  let limitsAgain = false; // otra lectura pedida mientras había una en curso
  let limitsTimer = null;
  async function refreshLimits() {
    if (!usable()) return;
    if (limitsBusy) { limitsAgain = true; return; }
    limitsBusy = true;
    try {
      const limits = await codex.readLimits();
      if (limits) state.limits = { ...limits, checkedAt: Date.now(), stale: false, authStamp: codex.authStamp() };
      else if (state.limits) state.limits = { ...state.limits, stale: true }; // se muestra con su hora
      changed();
    } finally {
      limitsBusy = false;
      if (limitsAgain) { limitsAgain = false; refreshLimits(); }
    }
  }
  function limitsSoon() {
    clearTimeout(limitsTimer);
    limitsTimer = setTimeout(refreshLimits, LIMITS_AFTER_JOB);
  }

  // Cada 10 minutos, también la sesión (por si se inicia o se cierra desde un terminal).
  let every = null;
  function start() {
    if (!every) every = setInterval(() => { refresh().catch(() => { /* se intentará la próxima vez */ }); }, LIMITS_EVERY);
  }
  function stop() {
    clearInterval(every);
    clearTimeout(limitsTimer);
    every = null;
  }

  // El interruptor de imágenes: solo se enciende si Codex se puede usar.
  async function setEnabled(on) {
    await refresh();
    state.enabled = Boolean(on) && usable();
    persist(state.enabled);
    changed();
    return info();
  }
  // Al arrancar, lo que se guardó (aún sin comprobar Codex).
  const restore = ({ enabled }) => { state.enabled = enabled === true; };

  // Codex asesora (review.js): el indicador lo enseña y, al terminar, se vuelve a leer el uso.
  function adviseBusy(delta, tabId, what, icon) {
    job(delta, 'advise', tabId, what, icon);
    changed();
    if (delta < 0) limitsSoon(); // lo gastado se ve al momento en la barra inferior
  }

  // Lo que ocurre cuando Claude llama a la herramienta «generar_imagen».
  async function drawImage(tabId, args) {
    const cwd = (tabs.get(tabId) || {}).folder;
    if (!cwd) throw new Error('Esta sesión ya no está abierta en ClaudHome.');
    if (!state.enabled) throw new Error('Las imágenes con Codex están desactivadas en ClaudHome (indicador «Codex» de la barra superior).');
    const size = String(args.descripcion || '').length;
    job(1, 'draw', tabId, 'imagen', 'draw');
    changed();
    const startedAt = Date.now();
    log(`Codex: ${label(tabId)} pide una imagen (${size} caracteres de descripción)`);
    const record = netlog();
    if (record) record.record({ tabId, kind: 'imagen', target: 'Descripción de una imagen', detail: `${size} caracteres`, dest: 'OpenAI (Codex)', external: true });
    try {
      const result = await codex.generateImage({
        description: args.descripcion,
        shape: ['cuadrada', 'horizontal', 'vertical'].includes(args.formato) ? args.formato : null,
        transparent: args.fondo_transparente === true,
        file: args.archivo,
        cwd,
        workDir: workDir(),
      });
      log(`Codex: imagen lista en ${Math.round((Date.now() - startedAt) / 1000)} s → ${result.path}`);
      return `Imagen generada con Codex y guardada en: ${result.path}`;
    } catch (err) {
      log(`Codex: fallo tras ${Math.round((Date.now() - startedAt) / 1000)} s: ${err && err.message}`);
      throw err;
    } finally {
      job(-1, 'draw', tabId, 'imagen', 'draw');
      limitsSoon();
      changed();
    }
  }

  // Las herramientas del MCP de la app: la segunda opinión siempre que Codex pueda asesorar
  // (se niega por su cuenta si no hay sesión de ChatGPT o el asesor está apagado); las
  // imágenes, si están activadas.
  const tools = () => [
    ...(state.installed && state.advisor !== false ? [codex.OPINION_TOOL] : []),
    ...(state.enabled && usable() ? [codex.IMAGE_TOOL] : []),
  ];

  return {
    get state() { return state; },
    usable, advisorUsable, info, refresh, status, refreshLimits, limitsSoon, start, stop,
    setEnabled, restore, adviseBusy, drawImage, tools,
  };
}

module.exports = { createCodexState };
