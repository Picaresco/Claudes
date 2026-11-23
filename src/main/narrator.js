// Panel «Actividad»: lo que va haciendo Claude en cada pestaña, contado como lo contaría un
// compañero («Voy a mirar cómo se calcula el IVA», «Me ha fallado la prueba; pruebo otra
// forma», «Listo: …»).
//
// De los avisos de Claude Code (hooks.js) salen los pasos: cada herramienta que usa (leer,
// cambiar o crear un archivo, buscar, ejecutar un comando, mirar una web, llamar a un agente…),
// lo que falla, los agentes que terminan y el final del turno. Del registro de la conversación
// (transcript_path) sale lo que Claude escribe entre un paso y otro. Cada paso aparece al
// momento con unas palabras fijas, en gris, y la línea «ahora» dice lo que está haciendo en
// ese instante. Cada pocos segundos, Haiku (haiku.js) junta los pasos nuevos y los cuenta en
// una a tres frases sencillas, que sustituyen a las grises.
//
// Solo se le pregunta a Haiku con el panel abierto: cerrado, no gasta nada y los pasos se
// quedan con sus palabras fijas. Si Haiku falla varias veces seguidas, se descansa un rato.
const fs = require('fs');
const path = require('path');
const { redact } = require('./netlog');
const { maskSecrets } = require('./secrets');
const { isTestCommand } = require('./testcommands');
const { haikuArgs, command, resultText, jsonIn, createRunner } = require('./haiku');

const MAX_ENTRIES = 150; // líneas que se guardan de cada pestaña
const GATHER = 1800; // ms desde el primer paso nuevo hasta preguntar, para juntar los que vienen seguidos
const MIN_GAP = 3000; // ms como mínimo entre dos preguntas de la misma pestaña
const MAX_STEPS = 40; // pasos por pregunta (si hay más, se cuentan los últimos)
const MAX_ASKS = 3; // preguntas a la vez entre todas las pestañas
const TIMEOUT = 40 * 1000;
const MAX_LINE = 160; // caracteres de cada línea (el panel enseña dos renglones; el resto, al pasar el ratón)
const FAILS_TO_PAUSE = 3; // fallos seguidos tras los que se deja de preguntar un rato
const PAUSE = 5 * 60 * 1000;
const TRANSCRIPT_MAX = 2 * 1024 * 1024; // lo que se lee como mucho del registro de una vez
const MERGE_MS = 20000; // pasos iguales seguidos (leer, buscar) se juntan en una línea
const MERGEABLE = new Set(['read', 'search']);
const WAITING = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

const SYSTEM = 'Eres un compañero que cuenta en voz alta, a alguien que no es programador, lo que está haciendo Claude (un asistente que programa) en su proyecto. Hablas como si fueras Claude, en primera persona, en español de España, con frases cortas, naturales y sin jerga. Respondes solo con JSON válido, sin texto alrededor.';
const ARGS = haikuArgs(SYSTEM);
// El tipo de cada línea que cuenta Haiku → el icono del panel.
const TYPES = {
  plan: 'plan', leer: 'read', buscar: 'search', crear: 'write', cambiar: 'edit', comando: 'command',
  pruebas: 'tests', web: 'web', agente: 'agent', fallo: 'fail', listo: 'done', otro: 'say',
};

// ── Textos ───────────────────────────────────────────────────────

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();
// Lo que escribe Claude (o Haiku), sin las marcas de Markdown: código entre acentos graves,
// negritas, títulos y citas. Lo demás se queda (test_activity.js, C#, 2 * 3).
const plain = (text) => oneLine(String(text || '')
  .replace(/```\w*/g, ' ')
  .replace(/`([^`\n]*)`/g, '$1')
  .replace(/\*\*([^*\n]+)\*\*/g, '$1')
  .replace(/__([^_\n]+)__/g, '$1')
  .replace(/^[ \t]{0,3}(?:#{1,6}|>)[ \t]+/gm, ''));
// Recortado por una palabra entera.
function clip(text, max) {
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max).replace(/[\s,;:]+\S*$/, '')}…` : line;
}
// La primera frase (si no es demasiado corta), recortada.
function firstSentence(text, max = 160) {
  const line = plain(text);
  const m = /^(.{20,}?[.!?:])\s/.exec(line);
  return clip(m ? m[1] : line, max);
}
const lowerFirst = (text) => (text ? text[0].toLowerCase() + text.slice(1) : text);
const norm = (text) => plain(text).toLowerCase();
// Un patrón de búsqueda que se puede enseñar tal cual (palabras, no una expresión regular).
const simple = (pattern) => typeof pattern === 'string' && /^[\p{L}\p{N} _.,:'"-]{1,40}$/u.test(pattern);

// ¿Dos frases cuentan lo mismo? Haiku a veces repite con otras palabras lo que ya contó: si
// comparten la mayoría de sus palabras con significado, sí.
const FILLER = new Set(['para', 'pero', 'como', 'esta', 'este', 'esto', 'estoy', 'porque', 'donde', 'cuando', 'ahora', 'luego', 'sobre', 'entre', 'desde', 'hasta', 'tambien', 'todo', 'toda', 'todos', 'cada', 'otra', 'otro', 'solo', 'mismo', 'misma', 'primero', 'despues', 'antes', 'voy', 'vamos']);
const bare = (text) => norm(text).normalize('NFD').replace(/\p{M}/gu, '');
const words = (text) => new Set(bare(text).split(/[^a-z0-9%]+/).filter((w) => w.length > 3 && !FILLER.has(w)));
// Lo que cambia el sentido de una frase aunque las palabras sean casi las mismas.
const OUTCOMES = [/\b(no|ni|nunca|sin|tampoco)\b/, /\b(fall\w*|error\w*|rot[oa]s?)\b/, /\b(pasan?|funciona\w*|arreglad[oa]s?|bien|correct[oa]s?)\b/];
function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  if (OUTCOMES.some((re) => re.test(bare(a)) !== re.test(bare(b)))) return false; // «pasan» y «no pasan» no son lo mismo
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
// Lo que cuenta Haiku, sin lo repetido y con una línea como mucho por cada paso nuevo (el
// «Listo» y los fallos, siempre).
function fresh(lines, recent, max) {
  const kept = [];
  for (const line of lines) {
    if (line.kind !== 'done' && line.kind !== 'fail' && [...recent, ...kept.map((l) => l.text)].some((r) => similar(r, line.text))) continue;
    kept.push(line);
  }
  const done = kept.filter((l) => l.kind === 'done').slice(-1);
  return [...kept.filter((l) => l.kind !== 'done').slice(0, Math.max(1, max - done.length)), ...done];
}

// Cómo se nombra un archivo: relativo al proyecto si está dentro; si no, solo su nombre.
function shortName(file, folder, cwd) {
  if (typeof file !== 'string' || !file) return 'un archivo';
  const full = path.resolve(cwd || folder || '.', file);
  if (folder) {
    const rel = path.relative(folder, full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const parts = rel.split(/[\\/]+/);
      return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
    }
    if (!rel) return path.basename(full);
  }
  return path.basename(full);
}

// Lo que hace un comando, en palabras de todos los días (la descripción de Claude suele venir
// en inglés). Si no se reconoce, el principio del comando.
const PROGRAMS = [
  [/^git$/, (args) => {
    // La suborden, aunque antes vaya algo como «-C carpeta».
    const sub = args.find((a) => /^(status|diff|log|show|blame|commit|push|pull|fetch|clone|checkout|switch|branch|merge|rebase|worktree|add|restore|reset|stash|rm|mv)$/.test(a)) || '';
    if (/^(status|diff|log|show|blame)$/.test(sub)) return 'Mirando los cambios en git';
    if (sub === 'commit') return 'Guardando los cambios en git';
    if (sub === 'push') return 'Subiendo los cambios';
    if (/^(pull|fetch|clone)$/.test(sub)) return 'Bajando cambios de git';
    if (/^(checkout|switch|branch|merge|rebase|worktree)$/.test(sub)) return 'Trabajando con las ramas de git';
    if (/^(add|restore|reset|stash|rm|mv)$/.test(sub)) return 'Preparando cambios en git';
    return 'Usando git';
  }],
  [/^(npm|pnpm|yarn|bun)$/, (args) => (/^(i|install|ci|add)$/.test(args[0] || '') ? 'Instalando dependencias' : args[0] === 'run' && args[1] ? `Ejecutando «${args[1]}»` : null)],
  [/^(pip|pip3|uv|poetry)$/, (args) => (/^(install|add|sync)$/.test(args[0] || '') ? 'Instalando dependencias' : null)],
  [/^(ls|dir|tree|get-childitem|gci)$/, () => 'Mirando qué archivos hay'],
  [/^(cat|type|head|tail|get-content|gc|more|less)$/, () => 'Mirando un archivo'],
  [/^(grep|rg|findstr|select-string|sls|find)$/, () => 'Buscando en los archivos'],
  [/^(mkdir|md|new-item|ni)$/, () => 'Creando una carpeta o un archivo'],
  [/^(rm|del|rmdir|rd|remove-item|ri)$/, () => 'Borrando archivos'],
  [/^(cp|copy|copy-item|mv|move|move-item|ren|rename-item)$/, () => 'Copiando o moviendo archivos'],
  [/^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)$/, () => 'Descargando de internet'],
  [/^(node|deno|bun)$/, () => 'Ejecutando un programa de JavaScript'],
  [/^(python|python3|py)$/, () => 'Ejecutando un programa de Python'],
  [/^(gh)$/, () => 'Usando GitHub'],
  [/^(docker|docker-compose|podman)$/, () => 'Usando Docker'],
  [/^(tsc|eslint|prettier|ruff|black|flake8|mypy)$/, () => 'Revisando el código'],
  [/^(make|cmake|msbuild|dotnet|cargo|go|mvn|gradle)$/, (args) => (args[0] === 'build' ? 'Compilando el proyecto' : null)],
];
function commandLabel(cmd, shell) {
  const text = String(cmd || '').trim();
  if (!text) return 'Ejecutando un comando';
  try { if (isTestCommand(text, { shell })) return 'Pasando las pruebas'; } catch { /* no se reconoce */ }
  // Sin los «cd carpeta &&» del principio ni las variables de entorno.
  const rest = text.replace(/^(?:(?:cd|pushd|set-location|sl)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/i, '').replace(/^(?:\w+=\S*\s+)+/, '');
  // El programa puede ir entre comillas (una ruta con espacios) y, en PowerShell, tras «&».
  const head = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(rest);
  const program = (head ? head[1] || head[2] || head[3] : '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const args = rest.slice(head ? head[0].length : 0).split(/\s+/).filter((w) => w && !/^-/.test(w)).map((w) => w.toLowerCase());
  for (const [re, label] of PROGRAMS) {
    if (re.test(program)) {
      const said = label(args);
      if (said) return said;
    }
  }
  return `Ejecutando «${clip(redact(rest), 50)}»`;
}

// Un paso a partir de una herramienta: { kind, show (al momento), info (para Haiku), wait
// (mientras dura), verb + item (para juntar pasos iguales) }, o null si no merece contarse.
function describe(tool, input, { folder = null, cwd = null, exists = fs.existsSync } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const name = (file) => shortName(file, folder, cwd);
  const step = (kind, show, info, extra = {}) => ({ kind, show, info: info || show, ...extra });
  switch (tool) {
    case 'Read': return step('read', `Leyendo ${name(i.file)}`, `Lee el archivo ${name(i.file)}`, { verb: 'Leyendo', item: name(i.file) });
    case 'Write': {
      let there = false;
      try { there = Boolean(i.file) && exists(path.resolve(cwd || folder || '.', i.file)); } catch { /* no se sabe */ }
      const size = i.lines > 1 ? ` (${i.lines} líneas)` : '';
      return there
        ? step('edit', `Reescribiendo ${name(i.file)}`, `Reescribe entero el archivo ${name(i.file)}${size}`)
        : step('write', `Creando ${name(i.file)}`, `Crea el archivo nuevo ${name(i.file)}${size}`);
    }
    case 'Edit': {
      // Qué cambia, en corto y sin claves: así Haiku puede decir «cambio el IVA del 12 al 21 %».
      const was = clip(redact(i.old || ''), 120);
      const is = clip(redact(i.new || ''), 120);
      const what = was && is ? `: cambia «${was}» por «${is}»` : is ? `: añade «${is}»` : was ? `: quita «${was}»` : '';
      return step('edit', `Cambiando ${name(i.file)}`, `Cambia el archivo ${name(i.file)}${what}`);
    }
    case 'MultiEdit':
    case 'NotebookEdit': return step('edit', `Cambiando ${name(i.file)}`, `Cambia ${i.edits > 1 ? `${i.edits} partes` : 'una parte'} del archivo ${name(i.file)}`);
    case 'Glob': {
      const pattern = oneLine(i.pattern);
      const short = pattern && pattern.length <= 30 ? pattern : null;
      return step('search', short ? `Buscando archivos (${short})` : 'Buscando archivos', `Busca archivos con el patrón «${clip(pattern, 80)}»`, { verb: 'Buscando archivos', item: short });
    }
    case 'Grep': {
      const what = simple(i.pattern) ? `«${oneLine(i.pattern)}»` : 'en el código';
      return step('search', `Buscando ${what}`, `Busca ${simple(i.pattern) ? 'el texto' : 'con la expresión'} «${clip(i.pattern, 80)}» en ${i.path ? name(i.path) : 'el proyecto'}`, { verb: 'Buscando', item: what });
    }
    case 'WebFetch': {
      let host = 'una web';
      try { host = new URL(i.url).hostname.replace(/^www\./, ''); } catch { /* sin dirección */ }
      return step('web', `Leyendo la web ${host}`, `Lee la página web ${clip(redact(i.url || ''), 150)}`);
    }
    case 'WebSearch': return step('web', `Buscando en internet «${clip(i.query, 60)}»`, `Busca en internet «${clip(i.query, 150)}»`);
    case 'Bash':
    case 'PowerShell': {
      const label = commandLabel(i.command, tool === 'PowerShell' ? 'powershell' : 'bash');
      const said = i.description ? ` (su descripción: «${clip(i.description, 150)}»)` : '';
      return step('command', label, `Ejecuta un comando${said}: ${clip(redact(i.command || ''), 200)}`, { kind: label === 'Pasando las pruebas' ? 'tests' : 'command' });
    }
    case 'Agent':
    case 'Task': {
      const who = i.agent ? ` «${clip(i.agent, 40)}»` : '';
      const task = clip(i.task, 80);
      return step('agent', `Llamando a un agente${who}${task ? `: ${task}` : ''}`,
        `Lanza un agente${who} con la tarea «${task || 'sin descripción'}»${i.background ? ', en segundo plano' : ''}`,
        { wait: `Esperando al agente${task ? ` «${task}»` : who}` });
    }
    case 'TodoWrite': {
      const said = { pending: 'pendiente', in_progress: 'en curso', completed: 'hecha' };
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const list = todos.map((t) => `${clip(t.content, 100)} (${said[t.status] || t.status || '¿?'})`).join('; ');
      return step('plan', 'Organizando sus tareas', `Apunta su lista de tareas: ${list || 'vacía'}`);
    }
    case 'TaskCreate': return step('plan', `Apuntando una tarea: ${clip(i.subject, 60)}`, `Se apunta la tarea «${clip(i.subject, 120)}»`);
    case 'TaskUpdate': return step('plan', 'Actualizando sus tareas', `Marca una tarea como «${i.status || 'cambiada'}»${i.subject ? `: ${clip(i.subject, 100)}` : ''}`);
    case 'EnterPlanMode': return step('plan', 'Preparando un plan', 'Se pone a preparar un plan antes de cambiar nada');
    case 'ExitPlanMode': return step('plan', 'Presentándote un plan', 'Presenta su plan al usuario para que lo apruebe');
    case 'AskUserQuestion': return step('ask', `Preguntándote: ${clip(i.question, 80) || 'una duda'}`, `Le pregunta al usuario: «${clip(i.question, 150)}»`);
    case 'Skill': return step('tool', `Usando la habilidad «${clip(i.skill, 40)}»`);
    case 'ToolSearch':
    case 'TaskList':
    case 'TaskGet':
    case 'SubagentHandback': return null; // preparativos y trámites sin interés
    case 'Monitor': return step('command', 'Vigilando un proceso en marcha');
    case 'ScheduleWakeup':
    case 'CronCreate': return step('wait', 'Programando una espera');
    default: break;
  }
  if (typeof tool === 'string' && tool.startsWith('mcp__')) {
    const [, server = '', what = ''] = /^mcp__(.+?)__(.+)$/.exec(tool) || [];
    if (what === 'segunda_opinion') return step('codex', 'Pidiendo una segunda opinión a Codex', 'Pide una segunda opinión a Codex (otro asistente)');
    if (what === 'generar_imagen') return step('codex', 'Pidiendo una imagen a Codex', 'Pide a Codex que dibuje una imagen');
    return step('tool', `Usando «${what.replace(/_/g, ' ')}» de ${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}`,
      `Usa la herramienta «${what}» del servicio ${server}${i.summary ? ` con ${clip(redact(i.summary), 150)}` : ''}`);
  }
  return typeof tool === 'string' && tool ? step('tool', `Usando ${tool}`) : null;
}

// ── Registro de la conversación ──────────────────────────────────

// Lo nuevo del registro (JSONL) desde `offset`: [{ type: 'text', text } | { type: 'tool', id }]
// de los mensajes de Claude (no de sus agentes), y hasta dónde se ha leído (solo líneas enteras).
function readTranscript(file, offset) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { items: [], offset }; }
  let from = size < offset ? 0 : offset; // se ha rehecho: desde el principio
  if (size === from) return { items: [], offset: from };
  const skipFirst = size - from > TRANSCRIPT_MAX;
  if (skipFirst) from = size - TRANSCRIPT_MAX;
  const buf = Buffer.alloc(size - from);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, from);
  } catch { return { items: [], offset }; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { items: [], offset: from };
  const lines = buf.subarray(0, end + 1).toString('utf8').split('\n');
  if (skipFirst) lines.shift();
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'assistant' || entry.isSidechain || !entry.message || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) items.push({ type: 'text', text: block.text.slice(0, 3000) });
      else if (block && block.type === 'tool_use' && typeof block.id === 'string') items.push({ type: 'tool', id: block.id });
    }
  }
  return { items, offset: from + end + 1 };
}

// ── Haiku ────────────────────────────────────────────────────────

function buildPrompt({ request, recent, steps, final }) {
  const late = steps.filter((s) => s.late).slice(-4);
  const fresh = steps.filter((s) => !s.late);
  const shown = fresh.slice(-MAX_STEPS);
  const before = fresh.length - shown.length;
  return [
    request ? `Lo que ha pedido el usuario: «${request}»` : 'No se sabe qué ha pedido el usuario.',
    '',
    recent.length ? `Lo último que ya le has contado:\n${recent.map((r) => `- ${r}`).join('\n')}` : 'Aún no le has contado nada de esta tarea.',
    '',
    late.length ? `Esto lo escribió Claude antes de pasos que ya le has contado (no lo cuentes otra vez; úsalo solo si aclara algo nuevo):\n${late.map((s) => `- «${clip(plain(s.text), 300)}»`).join('\n')}\n` : '',
    `Lo que ha pasado desde entonces, en orden${before ? ` (antes hubo ${before} pasos más)` : ''}:`,
    ...shown.map((s, n) => `${n + 1}. ${s.agent ? `[un agente «${s.agent}» que trabaja para Claude] ` : ''}${s.info}`),
    '',
    'Cuéntaselo en una línea por cada idea distinta (1 a 3; si los pasos son parecidos, basta una). Cada línea es una sola frase corta, de 12 palabras como mucho (tiene que caber en dos renglones de un panel estrecho), como un compañero que va contando lo que hace: lo que vas a hacer y para qué, lo que has encontrado, si algo ha fallado y qué vas a probar en su lugar. Nombra los archivos y las webs por su nombre corto, sin rutas. Sin jerga: di «las pruebas» y no «npm test», y no expliques comandos. No inventes nada que no esté en los pasos ni repitas lo que ya le has contado, aunque sea con otras palabras.',
    final ? 'Con esto la tarea ha terminado: cuenta el resultado en una sola línea que empiece por «Listo:» (o por «No he podido…» si no lo ha conseguido). Añade otra antes solo si Claude avisa expresamente de un problema o de algo que ha quedado pendiente.' : '',
    'Responde solo con este JSON: {"lineas": [{"tipo": "…", "texto": "…"}]}. «tipo» es uno de: plan, leer, buscar, crear, cambiar, comando, pruebas, web, agente, fallo, listo, otro.',
  ].filter((line, n, all) => line || all[n - 1]).join('\n');
}

// Lo que contesta Claude Code: [{ kind, text }] o null si no se entiende.
function parseLines(stdout) {
  const answer = jsonIn(resultText(stdout));
  if (!answer || !Array.isArray(answer.lineas)) return null;
  return answer.lineas.slice(0, 4).map((line) => {
    const text = typeof line === 'string' ? line : line && typeof line === 'object' ? line.texto : null;
    if (typeof text !== 'string' || !plain(text)) return null;
    const kind = line && typeof line === 'object' && TYPES[String(line.tipo || '').toLowerCase()];
    return { kind: kind || (/^listo\b/i.test(plain(text)) ? 'done' : 'say'), text: clip(redact(plain(text)), MAX_LINE) };
  }).filter(Boolean);
}

// ── El narrador ──────────────────────────────────────────────────

// tabs: lo que se sabe de cada pestaña (su carpeta) · send(canal, …): a la interfaz ·
// findClaude(), env(), workDir(): cómo lanzar Haiku (haiku.js) · open: si el panel está abierto ·
// run(cmd, entrada): sustituye al lanzamiento real (pruebas) · gather, gap: esperas (ms).
function createNarrator({
  tabs, send, log = () => {}, findClaude, env, workDir, open = true, now = Date.now, run = null, gather = GATHER, gap = MIN_GAP,
}) {
  const runner = createRunner({ env, workDir, timeout: TIMEOUT });
  const exec = run || runner.run;
  const states = new Map();
  const queued = new Set();
  let isOpen = Boolean(open);
  let asking = 0;
  let fails = 0;
  let pausedUntil = 0;
  let epoch = 0; // cambia al cerrar el panel: lo que contestara Haiku después ya no vale

  const haikuOn = () => isOpen && now() >= pausedUntil;
  const state = (tabId) => {
    if (!states.has(tabId)) {
      states.set(tabId, {
        entries: [], seq: 0, now: null, pending: [], firstAt: 0, asking: false, lastAsk: 0, timer: null, hurry: false,
        transcript: { file: null, offset: 0 }, tools: new Map(), lastWait: 0,
        turn: 0, turns: new Map(), // cada tarea (cada mensaje del usuario): su petición y lo ya contado de ella
        reviewing: null, // la respuesta final, mientras Codex revisa antes de dar la tarea por terminada
        agents: new Map(), // agentes trabajando ahora: id → tipo
        known: new Map(), // agentes que se han visto empezar (los de otros, como el de un plugin, no se cuentan)
        seenTools: new Set(), // herramientas que ya tienen su paso (para saber si un texto llega tarde)
        finals: [], // las últimas respuestas finales (llegan con Stop; en el registro, a veces más tarde)
        agentDoneAt: 0, // cuándo terminó el último agente (su informe llega después como mensaje)
      });
    }
    return states.get(tabId);
  };

  const snapshot = (st) => ({
    entries: st.entries.slice(-MAX_ENTRIES).map(({ id, at, kind, text, src, pending }) => ({ id, at, kind, text, src, pending })),
    now: st.now,
    open: isOpen,
  });
  // A la interfaz, una vez por vuelta aunque cambien varias cosas seguidas.
  function changed(tabId) {
    if (queued.has(tabId)) return;
    queued.add(tabId);
    setImmediate(() => {
      queued.delete(tabId);
      const st = states.get(tabId);
      if (st) send('activity:update', tabId, snapshot(st));
    });
  }

  // La línea «ahora» solo mientras Claude trabaja en un turno (un agente en segundo plano que
  // acaba después no la vuelve a encender).
  function setNow(st, kind, text) {
    if (!text) { st.now = null; return; }
    if (!st.busy) return;
    if (st.now && st.now.text === text) return; // sigue igual: se conserva desde cuándo
    st.now = { kind, text, since: now() };
  }
  // Sin herramienta en marcha, piensa (y quizá tiene agentes trabajando en paralelo).
  function idleNow(st) {
    const running = [...st.tools.values()].pop();
    if (running) setNow(st, running.d.kind, withAgent(running.agent, running.d.wait || running.d.show));
    else if (st.agents.size) setNow(st, 'think', `Pensando… (${st.agents.size === 1 ? `el agente «${[...st.agents.values()][0]}» trabaja` : `${st.agents.size} agentes trabajan`} en paralelo)`);
    else setNow(st, 'think', 'Pensando…');
  }
  const remember = (map, key, value, max = 300) => {
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value);
  };
  const withAgent = (agent, text) => (agent ? `Agente «${agent}»: ${lowerFirst(text)}` : text);

  function trim(st) {
    while (st.entries.length > MAX_ENTRIES) {
      const old = st.entries.findIndex((e) => !e.pending);
      if (old < 0) break;
      st.entries.splice(old, 1);
    }
  }

  // Un paso nuevo: su línea gris al momento y, con el panel abierto, a la cola de Haiku.
  // `late`: un texto de Claude que llega cuando lo que le sigue ya se ha contado: solo le
  // sirve a Haiku de contexto, sin línea propia.
  function addStep(tabId, st, d, { before = null } = {}) {
    const step = { ...d, id: ++st.seq, at: now(), turn: st.turn };
    const narrate = haikuOn();
    if (step.toolUseId) { st.seenTools.add(step.toolUseId); if (st.seenTools.size > 500) st.seenTools.delete(st.seenTools.values().next().value); }
    if (step.late && !narrate) return step;
    if (narrate) {
      const at = before === null ? -1 : st.pending.indexOf(before);
      if (at >= 0) st.pending.splice(at, 0, step); else st.pending.push(step);
    }
    if (step.late) return step;
    const text = withAgent(step.agent, step.show);
    const last = st.entries[st.entries.length - 1];
    if (before === null && last && last.src === 'local' && !last.sealed && last.pending === narrate && MERGEABLE.has(step.kind)
      && last.kind === step.kind && last.verb === step.verb && last.agent === step.agent && step.item && step.at - last.at < MERGE_MS) {
      if (!last.items.includes(step.item)) last.items.push(step.item);
      last.steps.push(step.id);
      const more = last.items.length - 3;
      last.text = withAgent(step.agent, `${step.verb} ${last.items.slice(0, 3).join(', ')}${more > 0 ? ` y ${more} más` : ''}`);
    } else {
      const entry = {
        id: `p${tabId.slice(0, 8)}-${step.id}`, at: step.at, kind: step.kind, text, src: 'local', pending: narrate,
        steps: [step.id], verb: step.verb, items: step.item ? [step.item] : [], agent: step.agent,
      };
      const at = before === null ? -1 : st.entries.findIndex((e) => e.steps.includes(before.id));
      if (at >= 0) st.entries.splice(at, 0, entry); else st.entries.push(entry);
    }
    trim(st);
    if (narrate) {
      if (!st.firstAt) st.firstAt = step.at;
      schedule(tabId, st);
    }
    return step;
  }

  function schedule(tabId, st) {
    if (!st.pending.length || st.asking) return;
    const wait = st.hurry ? st.lastAsk + 800 - now() : Math.max(st.firstAt + gather, st.lastAsk + gap) - now();
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { ask(tabId).catch((err) => log(`Actividad: ${err.message}`)); }, Math.max(0, wait));
  }

  // Lo que Claude ha escrito desde el último aviso. Al empezar un turno solo se avanza (lo
  // anterior ya se contó). Cada texto va delante de la herramienta que lo sigue, si aún no se ha contado.
  function pullTranscript(tabId, st, file, { skip = false } = {}) {
    if (!file) return;
    if (st.transcript.file !== file) {
      // Primera vez (o conversación nueva): desde el final, salvo que el archivo esté recién creado.
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* aún no existe */ }
      st.transcript = { file, offset: skip ? size : size < 4096 ? 0 : size };
      if (skip || size >= 4096) return;
    }
    const { items, offset } = readTranscript(file, st.transcript.offset);
    st.transcript.offset = offset;
    if (skip) return;
    let held = [];
    for (const item of items) {
      // Una respuesta final que ya llegó con Stop no se cuenta otra vez.
      if (item.type === 'text' && st.finals.some((f) => f.includes(norm(item.text).slice(0, 200)))) continue;
      if (item.type === 'text') { held.push(item.text); continue; }
      if (!held.length) continue;
      const tool = st.pending.find((s) => s.toolUseId === item.id);
      const late = !tool && st.seenTools.has(item.id);
      for (const text of held) addStep(tabId, st, { ...sayStep(text), late }, { before: tool || null });
      held = [];
    }
    for (const text of held) addStep(tabId, st, sayStep(text));
  }
  const sayStep = (text) => ({ kind: 'say', show: firstSentence(text), info: `Claude escribe: «${clip(plain(text), 600)}»`, text });

  // El final del turno ya llega entero con Stop: si también estaba en el registro (entero o
  // en trozos), se quita.
  function dropSaid(st, last) {
    if (!last) return;
    const whole = norm(last);
    const gone = new Set(st.pending.filter((s) => s.kind === 'say' && norm(s.text).length >= 8 && whole.includes(norm(s.text).slice(0, 200))).map((s) => s.id));
    if (!gone.size) return;
    st.pending = st.pending.filter((s) => !gone.has(s.id));
    st.entries = st.entries.filter((e) => !(e.pending && e.steps.every((id) => gone.has(id))));
  }

  async function ask(tabId) {
    const st = states.get(tabId);
    if (!st || st.asking || !st.pending.length) return;
    if (!haikuOn()) { settle(st); changed(tabId); return; }
    if (asking >= MAX_ASKS) { st.timer = setTimeout(() => { ask(tabId).catch(() => {}); }, 700); return; }
    const tab = tabs.get(tabId) || {};
    // Una pregunta, una tarea: los pasos de la anterior no se mezclan con los de la siguiente.
    const turn = st.pending[0].turn;
    let cut = st.pending.findIndex((s) => s.turn !== turn);
    if (cut < 0) cut = st.pending.length;
    const batch = st.pending.splice(0, cut);
    st.firstAt = st.pending.length ? st.pending[0].at : 0;
    if (batch.every((s) => s.late)) { schedule(tabId, st); return; } // solo contexto de lo ya contado
    const ids = new Set(batch.map((s) => s.id));
    for (const e of st.entries) if (e.pending && e.steps.some((id) => ids.has(id))) e.sealed = true;
    const final = batch.some((s) => s.kind === 'done' || s.kind === 'error');
    const ctx = st.turns.get(turn) || { request: '', recent: [] };
    st.hurry = false;
    st.asking = true;
    st.lastAsk = now();
    asking += 1;
    const mine = epoch;
    const started = Date.now();
    let lines = null;
    try {
      const exe = findClaude();
      if (exe) {
        // Lo que parezca una clave, tapado (aunque ya lo tenga la conversación de Claude).
        const question = maskSecrets(buildPrompt({ request: ctx.request, recent: ctx.recent, steps: batch, final }));
        const { code, stdout } = await exec(command(exe, ARGS), question);
        lines = code === 0 ? parseLines(stdout) : null;
        if (lines) lines = fresh(lines, ctx.recent, batch.filter((s) => !s.late).length);
      }
    } catch { lines = null; }
    asking -= 1;
    st.asking = false;
    if (states.get(tabId) !== st) return; // la pestaña se ha cerrado
    if (mine !== epoch) { schedule(tabId, st); return; } // se ha cerrado el panel mientras tanto: no vale
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (lines === null) {
      fails += 1;
      log(`Actividad de «${tab.name || tabId}»: Haiku no ha contestado (${seconds} s); se quedan los pasos tal cual`);
      if (fails >= FAILS_TO_PAUSE) {
        pausedUntil = now() + PAUSE;
        fails = 0;
        log(`Actividad: Haiku ha fallado ${FAILS_TO_PAUSE} veces seguidas; se le deja descansar ${PAUSE / 60000} min`);
      }
    } else {
      fails = 0;
      log(`Actividad de «${tab.name || tabId}»: ${batch.length} pasos → ${lines.length} líneas (${seconds} s)`);
    }
    apply(st, ids, lines);
    if (lines && lines.length) ctx.recent = [...ctx.recent, ...lines.map((l) => l.text)].slice(-5);
    changed(tabId);
    schedule(tabId, st);
  }

  // Las líneas de Haiku ocupan el sitio de las grises que cuentan (si no tiene nada nuevo que
  // contar, las grises se van sin más); si no ha contestado, se quedan las grises.
  function apply(st, ids, lines) {
    const mine = (e) => e.steps.some((id) => ids.has(id));
    if (!lines) {
      for (const e of st.entries) if (mine(e)) e.pending = false;
      return;
    }
    const first = st.entries.findIndex(mine);
    const kept = st.entries.filter((e) => !mine(e));
    // En el sitio de la primera línea gris que cuentan (o al final, si no tenían ninguna).
    const pos = first < 0 ? kept.length : st.entries.slice(0, first).filter((e) => !mine(e)).length;
    const at = now();
    const fresh = lines.map((l, n) => ({ id: `h${at}-${st.seq}-${n}`, at, kind: l.kind, text: l.text, src: 'haiku', pending: false, steps: [], items: [] }));
    st.entries = [...kept.slice(0, pos), ...fresh, ...kept.slice(pos)];
    trim(st);
  }

  // Sin Haiku: lo que esperaba se queda con sus palabras fijas.
  function settle(st) {
    clearTimeout(st.timer);
    st.pending = [];
    st.firstAt = 0;
    for (const e of st.entries) e.pending = false;
  }

  // Un aviso de Claude Code (el mismo objeto que hooks.js da a main.js, con `narr`).
  function event(tabId, ev) {
    if (!ev || typeof ev.event !== 'string') return;
    const st = state(tabId);
    const n = ev.narr || {};
    const tab = tabs.get(tabId) || {};
    const ctx = { folder: tab.folder || null, cwd: ev.cwd || tab.folder || null };
    const agent = n.agentId ? (n.agentType || 'agente') : null;
    if (n.transcript && !agent) pullTranscript(tabId, st, n.transcript, { skip: ev.event === 'UserPromptSubmit' });
    switch (ev.event) {
      case 'UserPromptSubmit': {
        const said = ev.request || ev.prompt || '';
        // No lo ha escrito el usuario: el informe de un agente que trabajaba en segundo plano o el
        // aviso de una tarea que ha terminado, que Claude Code le pasa a Claude como un mensaje.
        const system = /^\s*<(agent-message|task-notification)[\s>]/i.exec(said);
        if (system) {
          const body = clip(plain(said.replace(/<[^>]*>/g, ' ').replace(/\[[^\]]*\]/g, ' ')), 600);
          const agentReport = /agent/i.test(system[1]);
          // El informe de un agente que acaba de terminar ya se contó con su final (SubagentStop).
          if (!(agentReport && now() - st.agentDoneAt < 20000)) addStep(tabId, st, agentReport
            ? { kind: 'agent', show: 'Le llega el informe de un agente', info: `Le llega el informe final de un agente que trabajaba en segundo plano: «${body}»` }
            : { kind: 'tool', show: 'Le llega un aviso', info: `Le llega un aviso automático (no del usuario): «${body}»` });
          st.busy = true;
          setNow(st, 'think', 'Pensando…');
          break;
        }
        if (st.pending.length && !st.asking) { clearTimeout(st.timer); ask(tabId).catch(() => {}); } // lo que quedara, con su petición
        st.turn += 1;
        st.turns.set(st.turn, { request: clip(said, 300), recent: [] });
        for (const old of st.turns.keys()) if (old < st.turn - 2) st.turns.delete(old);
        st.reviewing = null;
        st.tools.clear();
        st.agents.clear();
        if (oneLine(said)) {
          st.entries.push({ id: `u${tabId.slice(0, 8)}-${++st.seq}`, at: now(), kind: 'user', text: clip(said, 160), src: 'user', pending: false, steps: [], items: [] });
          trim(st);
        }
        st.busy = true;
        setNow(st, 'think', 'Pensando…');
        break;
      }
      case 'PreToolUse': {
        const d = describe(ev.toolName, n.input, ctx);
        if (!d) break;
        if (ev.toolUseId) st.tools.set(ev.toolUseId, { d, agent, tool: ev.toolName });
        if (agent) remember(st.known, n.agentId, agent);
        else st.busy = true; // Claude trabaja (también si la app se abrió a mitad de un turno)
        setNow(st, d.kind, withAgent(agent, d.show));
        addStep(tabId, st, { ...d, agent, toolUseId: ev.toolUseId || null });
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        // Sin identificador (aviso grande y cortado): la más antigua de esa herramienta.
        let key = ev.toolUseId && st.tools.has(ev.toolUseId) ? ev.toolUseId : null;
        if (!key) for (const [k, v] of st.tools) if (v.tool === ev.toolName && v.agent === agent) { key = k; break; }
        const running = key ? st.tools.get(key) : null;
        if (key) st.tools.delete(key);
        if (ev.event === 'PostToolUseFailure') {
          const d = running ? running.d : describe(ev.toolName, n.input, ctx);
          if (d) {
            const why = n.interrupted ? 'lo ha parado el usuario' : clip(redact(n.error || ''), 300) || 'sin detalle';
            addStep(tabId, st, { kind: 'fail', show: `No ha salido: ${lowerFirst(d.show)}`, info: `FALLA el paso «${d.info}»: ${why}`, agent });
          }
        }
        idleNow(st);
        break;
      }
      case 'SubagentStart':
        if (n.agentId) { st.agents.set(n.agentId, n.agentType || 'agente'); remember(st.known, n.agentId, n.agentType || 'agente'); }
        idleNow(st);
        break;
      case 'SubagentStop': {
        // Solo los agentes que se han visto trabajar, y una vez (otros, como el que vigila
        // por el plugin «You should know», también avisan al acabar).
        const type = st.known.get(n.agentId);
        st.agents.delete(n.agentId);
        if (type) {
          st.known.delete(n.agentId);
          st.agentDoneAt = now();
          addStep(tabId, st, { kind: 'agent', show: `El agente «${type}» ha terminado`, info: `El agente «${type}» termina${n.last ? ` y le cuenta a Claude: «${clip(plain(n.last), 500)}»` : ''}`, agent: null });
        }
        idleNow(st);
        break;
      }
      case 'PermissionRequest':
      case 'Notification': {
        if (ev.event === 'Notification' && !WAITING.has(ev.notificationType)) break;
        const permission = ev.event === 'PermissionRequest' || ev.notificationType === 'permission_prompt';
        setNow(st, 'wait', permission ? 'Esperando tu permiso' : 'Esperando tu respuesta');
        if (now() - st.lastWait > 5000) {
          addStep(tabId, st, { kind: 'wait', show: permission ? 'Te pide permiso para seguir' : 'Espera tu respuesta', info: permission ? `Se para a pedir permiso al usuario${ev.toolName ? ` para usar ${ev.toolName}` : ''}` : 'Se para a esperar una respuesta del usuario', agent });
        }
        st.lastWait = now();
        break;
      }
      case 'Stop': {
        if (ev.testsAsk) {
          addStep(tabId, st, { kind: 'tests', show: 'ClaudHome le pide repasar las pruebas antes de terminar', info: 'ClaudHome no le deja terminar todavía: le pide que pase las pruebas (o que arregle las que fallan) antes de acabar' });
          setNow(st, 'think', 'Pensando…');
          break;
        }
        if (ev.reviewing) {
          // Si Codex no encuentra nada (o no puede revisar), esta parada es la final: se guarda
          // la respuesta hasta saberlo (review()).
          st.reviewing = { last: n.last || null };
          addStep(tabId, st, { kind: 'codex', show: 'Codex revisa los cambios', info: 'Antes de dar la tarea por terminada, Codex (otro asistente) revisa los cambios' });
          setNow(st, 'codex', 'Codex revisa los cambios');
          break;
        }
        finish(tabId, st, n.last);
        break;
      }
      case 'StopFailure':
        addStep(tabId, st, { kind: 'error', show: 'Se ha detenido por un error', info: 'Se detiene por un error del servicio de Anthropic' });
        st.tools.clear();
        st.busy = false;
        setNow(st, null, null);
        st.hurry = true;
        schedule(tabId, st);
        break;
      default:
        break;
    }
    changed(tabId);
  }

  // Fin de la tarea: el «Ha terminado», con la respuesta final para que Haiku la resuma.
  function finish(tabId, st, last) {
    st.reviewing = null;
    dropSaid(st, last);
    if (last) st.finals = [...st.finals, norm(last)].slice(-3);
    addStep(tabId, st, { kind: 'done', show: 'Ha terminado', info: last ? `Termina la tarea y le responde al usuario: «${clip(plain(last), 900)}»` : 'Termina la tarea' });
    st.tools.clear(); // los agentes en segundo plano pueden seguir: avisarán al acabar
    st.busy = false;
    setNow(st, null, null);
    st.hurry = true;
    schedule(tabId, st);
  }

  // Resultado de la revisión de Codex (review.js, el mismo que recibe la interfaz). Si ha
  // encontrado algo, Claude sigue con ello; si no, la tarea termina con la parada que esperaba.
  function review(tabId, result) {
    const st = states.get(tabId);
    if (!st || !st.reviewing || !result || typeof result.state !== 'string') return;
    if (['running', 'plan-running', 'plan-done', 'plan-error', 'plan-secret', 'opinion-running', 'opinion-done'].includes(result.state)) return;
    if (result.state === 'blocked' && result.op !== 'review') return;
    if (result.state === 'found') {
      st.reviewing = null;
      const count = Number(result.count) || 0;
      addStep(tabId, st, { kind: 'codex', show: `Codex ha encontrado ${count === 1 ? 'un posible problema' : `${count} posibles problemas`}`, info: `Codex encuentra ${count === 1 ? 'un posible problema' : `${count} posibles problemas`} en los cambios y Claude se pone a revisarlos` });
      setNow(st, 'think', 'Pensando…');
    } else {
      finish(tabId, st, st.reviewing.last);
    }
    changed(tabId);
  }

  // El proceso de Claude ha terminado (se ha cerrado o ha fallado) sin avisar de que paraba:
  // ya no está haciendo nada. Lo contado se queda.
  function exited(tabId) {
    const st = states.get(tabId);
    if (!st || !st.busy) return;
    st.busy = false;
    st.reviewing = null;
    st.tools.clear();
    st.agents.clear();
    setNow(st, null, null);
    changed(tabId);
  }

  // Panel abierto o cerrado: cerrado no se pregunta a Haiku, y lo que estuviera preguntando se corta.
  function setOpen(on) {
    isOpen = Boolean(on);
    if (!isOpen) {
      epoch += 1;
      runner.stop();
      for (const [tabId, st] of states) { settle(st); changed(tabId); }
    }
    log(`Actividad: panel ${isOpen ? 'abierto (Haiku cuenta lo que pasa)' : 'cerrado (sin Haiku)'}`);
    return isOpen;
  }
  const get = (tabId) => snapshot(state(tabId));
  function forget(tabId) {
    const st = states.get(tabId);
    if (st) clearTimeout(st.timer);
    states.delete(tabId);
  }
  function stop() {
    for (const st of states.values()) clearTimeout(st.timer);
    runner.stop();
  }
  return { event, review, exited, setOpen, isOpen: () => isOpen, get, forget, stop };
}

module.exports = { createNarrator, describe, commandLabel, shortName, readTranscript, buildPrompt, parseLines, firstSentence, similar, fresh, ARGS };
