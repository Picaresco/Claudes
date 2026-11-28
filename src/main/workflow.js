// Botón «Workflow»: cómo funciona el proyecto de la pestaña, como un mapa con zoom. Es
// independiente de la sesión de Claude de la pestaña: no usa sus hooks ni su conversación.
//
// - Lo dibuja un modelo aparte a partir de lo que la app elige enviarle (workflow-digest.js):
//   Codex (con sesión de ChatGPT) si está, para no gastar del plan de Claude: razonamiento
//   medio el primer mapa y bajo al rehacerlo. Si no, Claude Code en modo no interactivo, en su
//   propio proceso y en una carpeta vacía, sin herramientas: Sonnet el primero, Haiku al rehacerlo.
// - El modelo solo devuelve JSON con un esquema fijo; aquí se comprueba (cantidades, longitudes,
//   referencias, cada regla y bucle con un archivo del material) y la interfaz lo dibuja.
// - Se guarda por proyecto (<datos>\workflow\<hash>.json). Al abrir, se enseña lo guardado;
//   con la ventana abierta, cada 5 minutos (contados desde que acaba la comprobación anterior)
//   se mira la huella del proyecto y solo si ha cambiado algo se rehace. Cerrada, no se rehace.
// - Lo que sale del equipo queda en el «Log».
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { maskSecrets } = require('./secrets');
const { command, resultText, jsonIn, createRunner } = require('./haiku');
const digest = require('./workflow-digest');

const SCHEMA = 2;
// Codex para el mapa: gpt-6.2-sol. En la prueba del 25-11-2026 (5 pasadas sobre ClaudHome) dio el
// mapa más completo: razonamiento medio para el primero (≈2 min, en segundo plano) y bajo para
// actualizar (≈1 min); gpt-6.2-astra fue igual de rápido pero se dejó la mitad de las reglas.
const CODEX_MODEL = 'gpt-6.2-sol';
const CHECK_EVERY = Number(process.env.CLAUDES_WORKFLOW_EVERY_MS) > 0 ? Number(process.env.CLAUDES_WORKFLOW_EVERY_MS) : 5 * 60 * 1000;
const ENTER_EVERY = process.env.CLAUDES_WORKFLOW_ENTER_MS !== undefined ? Number(process.env.CLAUDES_WORKFLOW_ENTER_MS) || 0 : 30 * 1000;
const TIMEOUT = 8 * 60 * 1000;
const TYPES = ['persona', 'interfaz', 'nucleo', 'proceso', 'datos', 'externo'];
// credencial (🔑): pide una sesión, un token o una clave; regla (✕): bloquea o prohíbe.
const KINDS = ['datos', 'bucle', 'credencial', 'regla'];
// El tipo de una flecha: el que diga el modelo, salvo que su texto diga otra cosa («🔑» o «✕»).
const kindOf = (a) => {
  const kind = KINDS.includes(a && a.tipo) ? a.tipo : 'datos';
  const text = String((a && a.texto) || '').trim();
  if (text.startsWith('🔑')) return 'credencial';
  if (text.startsWith('✕') && kind === 'credencial') return 'regla';
  return kind;
};
const LIMITS = { blocks: 9, external: 3, modules: 8, arrows: 12, inner: 24, innerPer: 6, rules: 1, lines: 3, marks: 3, stack: 8 };

const SYSTEM = 'Eres un arquitecto de software que explica proyectos a personas no expertas. Describes cómo funciona un proyecto como un mapa. Respondes solo con JSON válido, sin texto alrededor.';

// ── Comprobación de lo que devuelve el modelo ─────────────────────────

const clip = (value, max) => {
  const text = maskSecrets(String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim());
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
};
const ident = (value) => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const list = (value) => (Array.isArray(value) ? value : []);

// El mapa, limpio: { resumen, bloques, modulos, flechas, internas, reglas, stack } o null si no
// sirve. `sources`: rutas que se le enseñaron; una regla o un bucle sin una de ellas no entra.
// `prev`: el mapa del que se parte al actualizar; sus reglas y bucles (ya comprobados, sin
// «fuente») se conservan si el modelo los devuelve tal cual.
function validate(raw, sources = null, prev = null) {
  if (!raw || typeof raw !== 'object') return null;
  const known = sources ? new Set([...sources].map((s) => s.toLowerCase())) : null;
  // Lo ya comprobado, sin su signo delante: una regla que pasa de «✕» a «🔑» (guía 3) se conserva.
  const bare = (text) => clip(text, 36).replace(/^(✕|🔑|↻)\s*/u, '');
  const kept = new Set((prev && Array.isArray(prev.modulos) ? prev.modulos : []).flatMap((m) => [...list(m.reglas), ...list(m.bucles)]).map(bare));
  const keptBlock = new Set(list(prev && prev.reglas).map((r) => bare(r && r.texto)));
  const cited = (src) => {
    if (!known) return true;
    const s = String(src || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/:\d+.*$/, '').toLowerCase();
    return Boolean(s) && (known.has(s) || [...known].some((k) => k.endsWith(`/${s}`)));
  };
  const blocks = [];
  const ids = new Set();
  let external = 0;
  for (const b of list(raw.bloques)) {
    const id = ident(b && b.id);
    const type = TYPES.includes(b && b.tipo) ? b.tipo : 'nucleo';
    if (!id || ids.has(id)) continue;
    if (type === 'externo' ? external >= LIMITS.external : blocks.length - external >= LIMITS.blocks - LIMITS.external) continue;
    if (type === 'externo') external += 1;
    ids.add(id);
    blocks.push({ id, nombre: clip(b.nombre || id, 24), tipo: type, resumen: clip(b.resumen, 70) });
  }
  if (blocks.filter((b) => b.tipo !== 'externo').length < 2) return null;
  const modules = [];
  const modIds = new Set();
  const perBlock = {};
  for (const m of list(raw.modulos)) {
    const id = ident(m && m.id);
    const block = ident(m && m.bloque);
    if (!id || modIds.has(id) || !ids.has(block)) continue;
    if (blocks.find((b) => b.id === block).tipo === 'externo') continue;
    perBlock[block] = (perBlock[block] || 0) + 1;
    if (perBlock[block] > LIMITS.modules) continue;
    modIds.add(id);
    // { texto, fuente } del modelo, o el texto solo si viene de un mapa ya comprobado (sources null).
    const marks = (items) => list(items).filter((r) => r && (typeof r === 'string' ? !known || kept.has(bare(r)) : cited(r.fuente) || kept.has(bare(r.texto)))).slice(0, LIMITS.marks).map((r) => clip(typeof r === 'string' ? r : r.texto, 36)).filter(Boolean);
    modules.push({
      id, bloque: block, nombre: clip(m.nombre || id, 22), sub: clip(m.sub || list(m.archivos)[0] || '', 28),
      detalle: list(m.detalle).map((l) => clip(l, 40)).filter(Boolean).slice(0, LIMITS.lines),
      archivos: list(m.archivos).map((a) => clip(a, 80)).filter(Boolean).slice(0, 6),
      reglas: marks(m.reglas), bucles: marks(m.bucles),
    });
  }
  const arrows = [];
  const seen = new Set();
  for (const a of list(raw.flechas)) {
    const from = ident(a && a.de);
    const to = ident(a && a.a);
    const kind = kindOf(a);
    if (!ids.has(from) || !ids.has(to) || from === to || seen.has(`${from}>${to}>${kind}`)) continue;
    // La vuelta de una flecha que ya está: la misma, de doble sentido (menos ruido en el mapa).
    const back = arrows.find((x) => x.de === to && x.a === from && x.tipo === kind);
    if (back) { back.doble = true; continue; }
    if (arrows.length >= LIMITS.arrows) continue;
    seen.add(`${from}>${to}>${kind}`);
    arrows.push({ de: from, a: to, tipo: kind, texto: clip(a.texto, 24), doble: Boolean(a.doble) });
  }
  const inner = [];
  for (const a of list(raw.internas)) {
    const from = ident(a && a.de);
    const to = ident(a && a.a);
    const mf = modules.find((m) => m.id === from);
    const mt = modules.find((m) => m.id === to);
    if (!mf || !mt || from === to || mf.bloque !== mt.bloque || inner.length >= LIMITS.inner) continue;
    if (inner.filter((x) => modules.find((m) => m.id === x.de).bloque === mf.bloque).length >= LIMITS.innerPer) continue; // 6 por bloque
    inner.push({ de: from, a: to, tipo: kindOf(a) });
  }
  const rules = [];
  const rulesPer = {};
  for (const r of list(raw.reglas)) {
    const block = ident(r && r.bloque);
    // Con su archivo, o una del mapa anterior (ya comprobada) que el modelo devuelve tal cual.
    if (!ids.has(block) || !(cited(r.fuente) || keptBlock.has(bare(r.texto)))) continue;
    rulesPer[block] = (rulesPer[block] || 0) + 1;
    if (rulesPer[block] > LIMITS.rules) continue;
    const text = clip(r.texto, 36);
    if (text) rules.push({ bloque: block, texto: text });
  }
  // Un servicio de internet sin ninguna flecha quedaría suelto: fuera.
  const linked = (b) => b.tipo !== 'externo' || arrows.some((a) => a.de === b.id || a.a === b.id);
  // El stack tecnológico: con qué está hecho (lenguajes, marcos, bibliotecas clave, bases de datos).
  const stack = [];
  for (const s of list(raw.stack)) {
    const name = clip(s && s.nombre, 22);
    if (!name || stack.some((x) => x.nombre.toLowerCase() === name.toLowerCase()) || stack.length >= LIMITS.stack) continue;
    stack.push({ nombre: name, version: clip(s.version, 14), para: clip(s.para, 30) });
  }
  return { resumen: clip(raw.resumen, 160), bloques: blocks.filter(linked), modulos: modules, flechas: arrows, internas: inner, reglas: rules, stack };
}

// ── Lo que se le pide al modelo ───────────────────────────────────────

// La guía (src/workflow/SKILL.md): el método, la forma de escribir, cómo se presenta y el
// formato JSON, en un solo sitio. Los dos motores reciben exactamente ese texto, así que el
// mapa se hace y se presenta siempre igual. No es una skill de la sesión principal: esa no la
// carga, para no gastarle contexto ni distraerla.
// Cada mapa guarda el número de `version` de la guía con el que se hizo. Solo ese número
// cuenta: retocar el texto no toca los mapas hechos; subirlo los pone al día la próxima vez que
// se entra en cada proyecto, completándolos con el modelo rápido (no se rehacen desde cero).
const GUIDE_FILE = path.join(__dirname, '..', 'workflow', 'SKILL.md');
function loadGuide(file = GUIDE_FILE) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const head = m ? m[1] : '';
  const body = (m ? m[2] : text).trim();
  const field = (key) => (new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head) || [])[1] || '';
  return { name: field('name'), version: field('version'), number: Number(field('version')) || 1, body };
}
const GUIDE = loadGuide();

function fullPrompt({ name, text, partial }) {
  return [
    `Sigue esta guía de ClaudHome («${GUIDE.name}», versión ${GUIDE.version}):`, '', GUIDE.body, '', '---', '',
    `Dibuja el mapa de cómo funciona el proyecto «${name}». Abajo tienes su árbol de archivos, sus manifiestos y extractos de su código${partial ? ' (el proyecto es grande: es una parte)' : ''}.`,
    '', 'Material del proyecto:', '', text,
  ].join('\n');
}

// Actualizar un mapa: con lo que ha cambiado y, si se hizo con una guía anterior (`from`),
// completándolo para que cumpla la de ahora. Nunca desde cero.
function refreshPrompt({ name, text, map, changes, from = null }) {
  const touched = [...changes.modified, ...changes.added];
  return [
    `Sigue esta guía de ClaudHome («${GUIDE.name}», versión ${GUIDE.version}):`, '', GUIDE.body, '', '---', '',
    `Este es el mapa actual de cómo funciona el proyecto «${name}».${touched.length || changes.removed.length ? ` Desde que se hizo han cambiado estos archivos: ${touched.slice(0, 60).join(', ') || 'ninguno'}${changes.removed.length ? `; se han borrado: ${changes.removed.slice(0, 40).join(', ')}` : ''}.` : ''}`,
    ...(from ? [`Se hizo con la versión ${from} de la guía y ahora es la ${GUIDE.version}: complétalo para que cumpla la guía de arriba (por ejemplo, el stack tecnológico si falta, sacado de los manifiestos, o las reglas y flechas que solo piden una credencial, que ahora van con «🔑» y tipo «credencial» en vez de «✕»), sin rehacer lo demás.`] : []),
    'Actualiza el mapa con lo que muestran los archivos de abajo. Cambia solo lo necesario y conserva los mismos id; las reglas y bucles que no cambien, devuélvelos tal cual. Si lo esencial no cambia, devuelve el mismo mapa.',
    '', 'Mapa actual:', JSON.stringify(map), '', 'Archivos (extractos; los manifiestos siempre van):', '', text,
  ].join('\n');
}

// ── El proceso ────────────────────────────────────────────────────────

// codexState: lo que se sabe de Codex · codex: codex.js · model: el de Codex · findClaude,
// env, workDir: para Claude Code · dir: carpeta de los mapas · send(canal, …): a la interfaz ·
// netlog(): el «Log» · engine: forzar 'codex' o 'claude' (pruebas).
// planBusy(): el plan de Claude va justo (≥ 80 %): sin Codex, no se rehace solo, para no
// quitarle margen a la sesión de trabajo.
function createWorkflow({ codexState, codex, model = CODEX_MODEL, findClaude, env = () => process.env, workDir, dir, send = () => {}, log = () => {}, netlog = () => null, engine = null, planBusy = () => false }) {
  const runner = createRunner({ env, workDir, timeout: TIMEOUT });
  const projects = new Map(); // carpeta → estado
  let stopped = false; // la app se cierra: nada más se comprueba ni se programa

  const keyOf = (folder) => crypto.createHash('sha1').update(path.resolve(folder).toLowerCase()).digest('hex').slice(0, 16);
  const fileOf = (folder) => path.join(dir(), `${keyOf(folder)}.json`);

  function project(folder) {
    let p = projects.get(folder);
    if (p) return p;
    p = { folder, key: keyOf(folder), map: null, manifest: {}, at: 0, engine: null, partial: false, status: 'idle', error: '', open: 0, timer: null, controller: null, kind: null, startedAt: 0, checkedAt: 0, masked: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(fileOf(folder), 'utf8'));
      // Se vuelve a comprobar al cargarlo: si los límites han cambiado, se aplican.
      const map = saved && saved.schema === SCHEMA ? validate(saved.map) : null;
      if (map) Object.assign(p, { map, manifest: saved.manifest || {}, at: saved.at || 0, engine: saved.engine || null, partial: Boolean(saved.partial), status: 'ready',
        // La versión de la guía con la que se hizo (los mapas de la 0.27 no la guardan: la 1,
        // o la 2 si ya tienen stack).
        guideVersion: Number(saved.guideVersion) || (map.stack.length ? 2 : 1) });
    } catch { /* todavía sin mapa */ }
    projects.set(folder, p);
    return p;
  }

  function save(p) {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      const file = fileOf(p.folder);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, folder: p.folder, map: p.map, manifest: p.manifest, at: p.at, engine: p.engine, partial: p.partial, guideVersion: p.guideVersion }));
      fs.renameSync(tmp, file); // de una vez: un corte no deja un mapa a medias
    } catch (err) { log(`Workflow: no se ha podido guardar el mapa (${err.message})`); }
  }

  const snapshot = (p) => ({
    key: p.key, folder: p.folder, map: p.map, at: p.at, engine: p.engine, partial: p.partial, status: p.status, error: p.error,
    kind: p.kind, startedAt: p.startedAt, checkedAt: p.checkedAt, next: p.open && p.timer ? p.nextAt : 0, masked: p.masked,
    paused: Boolean(p.paused), pending: p.pending || 0, using: p.controller ? p.using || null : null, waiting: Boolean(p.waiting),
    oldGuide: Boolean(p.map && (p.guideVersion || 1) < GUIDE.number), // hecho con una guía anterior
  });
  const update = (p) => send('workflow:update', snapshot(p));

  // Qué motor toca ahora: { name, label, run(prompt, kind, signal) }.
  function choose() {
    const useCodex = engine ? engine === 'codex' : codexState.usable();
    if (useCodex) {
      return {
        name: 'codex',
        label: (kind) => `Codex (${model}, razonamiento ${kind === 'full' ? 'medio' : 'bajo'})`,
        dest: 'OpenAI (Codex)',
        async run(prompt, kind, signal) {
          if (!(await codex.chatgptLogin())) return { error: 'Codex no tiene la sesión de ChatGPT iniciada.' };
          const cwd = workDir();
          fs.mkdirSync(cwd, { recursive: true });
          const ask = (m) => codex.askCodex({ cwd, prompt: `${SYSTEM}\n\n${prompt}`, model: m, effort: kind === 'full' ? 'medium' : 'low', signal, timeout: TIMEOUT });
          let result = await ask(model);
          // Una cuenta sin ese modelo: otra vez con el que tenga Codex por defecto.
          if (!result.ok && !result.aborted && /model/i.test(`${result.failure || ''} ${result.log || ''}`)) {
            log(`Workflow: Codex no tiene ${model}; se usa su modelo por defecto`);
            result = await ask(null);
          }
          if (result.aborted) return { error: 'cancelado' };
          return result.ok ? { text: result.text } : { error: result.failure || 'Codex no ha contestado.' };
        },
      };
    }
    return {
      name: 'claude',
      label: (kind) => `Claude (${kind === 'full' ? 'Sonnet' : 'Haiku'}, en un proceso aparte)`,
      dest: 'Anthropic',
      async run(prompt, kind, signal) {
        const exe = findClaude();
        if (!exe) return { error: 'No se encuentra Claude Code.' };
        const args = ['-p', '--model', kind === 'full' ? 'sonnet' : 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
          '--disable-slash-commands', '--setting-sources', '', '--system-prompt', SYSTEM, '--output-format', 'json'];
        const stop = () => runner.stop();
        if (signal) signal.addEventListener('abort', stop, { once: true });
        const { code, stdout } = await runner.run(command(exe, args), prompt);
        if (signal) signal.removeEventListener('abort', stop);
        if (signal && signal.aborted) return { error: 'cancelado' };
        const text = code === 0 ? resultText(stdout) : null;
        return text ? { text } : { error: code === null ? 'Claude no ha terminado a tiempo.' : 'Claude no ha contestado.' };
      },
    };
  }

  // Hace el mapa (kind 'full': modelo de calidad) o lo actualiza (kind 'refresh': modelo rápido)
  // con lo que ha cambiado y, si `from`, completándolo para la guía de ahora.
  async function generate(p, kind, { manifest, changes = null, from = null } = {}) {
    if (p.controller || stopped) return;
    const controller = new AbortController();
    p.controller = controller;
    p.status = 'working';
    p.kind = kind;
    p.error = '';
    p.startedAt = Date.now();
    update(p);
    const name = path.basename(p.folder);
    try {
      const only = kind === 'refresh' ? new Set([...changes.added, ...changes.modified]) : null;
      const shown = await digest.material(p.folder, { kind, only });
      const sources = new Set(kind === 'refresh' ? [...shown.used, ...Object.keys(manifest)] : shown.used);
      const prompt = kind === 'full' ? fullPrompt({ name, text: shown.text, partial: shown.partial }) : refreshPrompt({ name, text: shown.text, map: p.map, changes, from });
      const motor = choose();
      const what = motor.label(kind);
      p.using = what;
      update(p);
      log(`Workflow: ${kind === 'full' ? 'dibuja' : 'rehace'} el mapa de ${p.folder} con ${what} (${shown.used.length} archivos, ${Math.round(shown.size / 1024)} KB${shown.masked ? `, ${shown.masked} valores tapados` : ''})`);
      const record = netlog();
      if (record) record.record({ tabId: p.tabId, kind: 'workflow', target: p.folder, detail: `${what} · ${shown.used.length} archivos${shown.masked ? ` · ${shown.masked} valores con pinta de clave tapados` : ''}`, dest: motor.dest, external: true, size: shown.size });
      const answer = await motor.run(prompt, kind, controller.signal);
      if (controller.signal.aborted || answer.error === 'cancelado') { p.status = p.map ? 'ready' : 'idle'; return; }
      const map = answer.text ? validate(jsonIn(answer.text), sources, kind === 'refresh' ? p.map : null) : null;
      if (!map) throw new Error(answer.error || 'La respuesta no tiene un mapa que se pueda dibujar.');
      p.map = map;
      p.manifest = manifest;
      p.at = Date.now();
      p.engine = what;
      if (kind === 'full' || from) p.guideVersion = GUIDE.number;
      if (kind === 'full') p.partial = shown.partial; // al actualizar solo se envía lo cambiado
      p.masked = shown.masked;
      p.pending = 0;
      p.status = 'ready';
      save(p);
      log(`Workflow: mapa listo (${map.bloques.length} bloques, ${map.modulos.length} módulos, ${Math.round((Date.now() - p.startedAt) / 1000)} s)`);
    } catch (err) {
      p.status = p.map ? 'ready' : 'error';
      p.error = String(err.message || err);
      log(`Workflow: no se ha podido ${kind === 'full' ? 'dibujar' : 'rehacer'} el mapa de ${p.folder} (${p.error})`);
    } finally {
      p.controller = null;
      p.checkedAt = Date.now();
      schedule(p);
      update(p);
    }
  }

  // De uno en uno: otro proyecto está comprobando o dibujando, y el siguiente que esperaba.
  const busyOther = (p) => [...projects.values()].some((q) => q !== p && (q.controller || q.checking));
  function kickNext() {
    const next = [...projects.values()].find((q) => q.waiting && !q.controller && !q.checking);
    if (next && !stopped) { next.waiting = false; setImmediate(() => check(next, { auto: next.waitingAuto })); }
  }

  // ¿Ha cambiado el proyecto desde el último mapa? Si sí, se rehace (o se hace, si no lo hay).
  // auto: lo pide la app al entrar en el proyecto, no el usuario con la ventana: sin Codex y con
  // el plan de Claude al 80 %, tampoco se hace el primer mapa (se hará al pulsar «Workflow»).
  async function check(p, { auto = false } = {}) {
    if (p.controller || p.checking || stopped) return;
    // Un mapa a la vez entre todos los proyectos: este espera su turno.
    if (busyOther(p)) {
      p.waiting = true;
      p.waitingAuto = auto && p.waitingAuto !== false;
      update(p);
      return;
    }
    p.checking = true; // el turno se reserva ya: la huella tarda y otro podría colarse
    p.waiting = false;
    p.waitingAuto = undefined;
    try {
      const { manifest } = await digest.fingerprint(p.folder, p.manifest);
      const changes = digest.diff(p.manifest, manifest);
      p.pending = p.map ? changes.count : 0;
      p.paused = false;
      const saving = choose().name === 'claude' && planBusy(); // sin Codex y con el plan justo
      // Hecho con una guía anterior (por número de versión): se completa, no se rehace.
      const from = p.map && (p.guideVersion || 1) < GUIDE.number ? (p.guideVersion || 1) : null;
      if (!p.map && !(auto && saving)) { await generate(p, 'full', { manifest }); return; }
      if (!p.map || ((changes.count || from) && saving)) {
        p.paused = true; // se hará cuando el plan tenga margen (o al pulsar «Workflow» o «Rehacer»)
        if (!p.map && p.status === 'working') p.status = 'idle';
      } else if (changes.count || from) { await generate(p, 'refresh', { manifest, changes, from }); return; }
      p.checkedAt = Date.now();
      schedule(p);
      update(p);
    } catch (err) {
      log(`Workflow: no se ha podido comprobar ${p.folder} (${err.message})`);
      p.checkedAt = Date.now();
      schedule(p);
      update(p);
    } finally {
      p.checking = false;
      kickNext();
    }
  }

  // El usuario entra en un proyecto (abre su pestaña o cambia a ella): el mapa se prepara en
  // segundo plano, para que al pulsar «Workflow» ya esté. Como mucho una vez cada 30 s por proyecto.
  function enter(folder, tabId = null) {
    if (!folder || stopped) return;
    const p = project(folder);
    if (tabId) p.tabId = tabId;
    if (p.controller || p.waiting || Date.now() - (p.enteredAt || 0) < ENTER_EVERY) return;
    p.enteredAt = Date.now();
    setImmediate(() => check(p, { auto: true }));
  }

  function schedule(p) {
    clearTimeout(p.timer);
    p.timer = null;
    if (!p.open || stopped) return;
    p.nextAt = Date.now() + CHECK_EVERY;
    p.timer = setTimeout(() => { p.timer = null; check(p); }, CHECK_EVERY);
  }

  // La ventana se abre para un proyecto: lo guardado al momento y, si hace falta, se rehace.
  function open(folder, tabId = null) {
    if (!folder) return null;
    const p = project(folder);
    p.open += 1;
    p.tabId = tabId; // para el «Log» (filtra por la pestaña y su carpeta)
    if (!p.controller) {
      if (!p.map) p.status = 'working';
      setImmediate(() => check(p));
    }
    return snapshot(p);
  }

  // Se cierra: no se revisa más cada 5 minutos. Lo que esté en marcha termina y se guarda.
  function close(folder) {
    const p = projects.get(folder);
    if (!p) return;
    p.open = Math.max(0, p.open - 1);
    if (p.open) return;
    clearTimeout(p.timer);
    p.timer = null;
  }

  // «Rehacer»: un mapa nuevo desde cero, aunque no haya cambios.
  async function redo(folder) {
    const p = project(folder);
    if (p.controller) return snapshot(p);
    const { manifest } = await digest.fingerprint(p.folder, p.manifest);
    generate(p, 'full', { manifest }).then(kickNext);
    return snapshot(p);
  }

  function stop() {
    stopped = true;
    for (const p of projects.values()) { clearTimeout(p.timer); if (p.controller) p.controller.abort(); }
    runner.stop();
  }

  return { open, close, enter, redo, stop, get: (folder) => (projects.get(folder) ? snapshot(projects.get(folder)) : null) };
}

module.exports = { createWorkflow, validate, fullPrompt, refreshPrompt, loadGuide, GUIDE, SCHEMA };
