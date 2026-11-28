// ── Ideas para el proyecto (SuperPowers) ─────────────────────────
// La parte proactiva de SuperPowers: de vez en cuando, un modelo aparte (Sonnet, en un proceso
// sin herramientas y sin la sesión del usuario) mira el proyecto y propone UNA mejora visual o
// funcional, y solo se enseña si de verdad merece la pena: ganancia alta, mucha confianza en que
// el problema existe, poco esfuerzo y sin riesgo alto. Si Codex puede asesorar, da su visto
// bueno; si no coincide, la idea no se enseña.
//
// Cuándo: tras 5 turnos con cambios en pestañas con SuperPowers del proyecto, como mucho una vez
// al día, nunca con una idea esperando respuesta y después de contestar al Stop (no frena nada).
// La tarjeta sale encima de la terminal sin quitarle el foco (ui/ideas.js), con tres respuestas:
//   - «Pruébalo en una rama aparte»: se le pide a Claude que la pruebe en una copia de trabajo
//     de git con su propia rama (idea/<nombre>), sin tocar la rama actual;
//   - «Más tarde»: vuelve a salir dentro de un día;
//   - «No me interesa»: no vuelve, y no se propone nada parecido. Con varios rechazos seguidos
//     se pide más ganancia para enseñar la siguiente.
// Lo que se envía (el resumen del proyecto que prepara workflow-digest.js, con lo que tenga
// pinta de clave tapado) queda en el «Log».
const path = require('path');
const crypto = require('crypto');
const { resultText, jsonIn, command, createRunner } = require('./haiku');
const { maskSecrets } = require('./secrets');

const EVERY = 5; // turnos con cambios entre ideas
const GAP = 24 * 3600 * 1000; // como mucho una al día por proyecto
const SNOOZE = 24 * 3600 * 1000; // «Más tarde»
const KEEP = 30; // rechazadas y probadas que se recuerdan
const TIMEOUT = 4 * 60 * 1000;
const SYSTEM = 'Eres un asesor prudente de producto y de código. Propones como mucho una mejora para un proyecto, y solo si de verdad merece la pena para quien lo usa. Respondes solo con JSON válido, sin texto alrededor.';

const clip = (text, max) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
};
const keyOf = (folder) => path.resolve(folder).toLowerCase();
// Palabras con contenido, sin tildes (para comparar ideas).
const words = (text) => new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4));
function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / Math.min(x.size, y.size) >= 0.6;
}
// El nombre de la rama: sin tildes ni s\u00edmbolos y, si es largo, cortado por una palabra entera.
function slugOf(title) {
  const slug = String(title || 'idea').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug.length > 40 ? slug.slice(0, 41).replace(/-[^-]*$/, '') || slug.slice(0, 40) : slug) || 'idea';
}

function prompt({ name, text, requests = [], rejected = [], tried = [] }) {
  return [
    `Proyecto «${name}».`,
    requests.length ? `Lo último que ha pedido el usuario a Claude en él:\n${requests.map((r) => `- ${clip(r, 200)}`).join('\n')}` : '',
    rejected.length ? `Ideas que el usuario ya ha rechazado (no propongas nada parecido):\n${rejected.map((r) => `- ${r}`).join('\n')}` : '',
    tried.length ? `Ideas que ya ha probado (no las repitas):\n${tried.map((r) => `- ${r}`).join('\n')}` : '',
    'Lo que hay en el proyecto (árbol, manifiestos y extractos; puede estar recortado; lo que parecía una clave va tapado):',
    text || '(vacío)',
    'Busca UNA mejora visual o funcional que de verdad merezca la pena y que notaría quien usa el proyecto: algo que se ve mal o no se puede usar (por ejemplo en el móvil), un fallo probable, algo lento o confuso, o una función que falta y encaja claramente con lo que hace. NO cuentan la limpieza o el orden del código, el estilo, renombrar, la documentación, las dependencias ni las refactorizaciones. Si no ves ninguna clara, responde {"idea": null}: es lo normal.',
    'Puntúa con honestidad de 1 a 5: «ganancia» (cuánto lo notaría el usuario), «confianza» (lo seguro que estás de que el problema existe, viéndolo en lo que tienes) y «esfuerzo» (1: un cambio pequeño en un archivo; 5: mucho trabajo).',
    'Responde solo con {"idea": null} o con {"idea": {"titulo": "el problema dicho para el usuario, 60 caracteres como mucho", "tipo": "visual" o "funcional", "por_que": "45 palabras como mucho, sin tecnicismos: qué pasa ahora y qué gana", "que_hacer": "120 palabras como mucho: instrucciones concretas para un programador", "ganancia": n, "confianza": n, "esfuerzo": n, "riesgo": "bajo", "medio" o "alto", "archivos": ["rutas del proyecto que habría que tocar"], "pagina": "si es visual, la ruta de un .html del proyecto o la dirección de localhost donde se ve; si no, null", "ancho": 390, 1024 o 1440 (dónde se nota más)}}. Todo en español.',
  ].filter(Boolean).join('\n\n');
}

// La idea de la respuesta, ya limpia, o null.
function parseIdea(text) {
  const answer = jsonIn(text);
  const raw = answer && answer.idea;
  if (!raw || typeof raw !== 'object') return null;
  // Una puntuación de 1 a 5, o 0 si falta o no es un número (y entonces la idea no vale).
  const n = (v) => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(x) ? Math.min(5, Math.max(1, Math.round(x))) : 0;
  };
  const idea = {
    title: clip(raw.titulo, 70),
    kind: raw.tipo === 'visual' ? 'visual' : raw.tipo === 'funcional' ? 'funcional' : '',
    why: clip(raw.por_que, 360),
    todo: clip(raw.que_hacer, 1000),
    gain: n(raw.ganancia),
    confidence: n(raw.confianza),
    effort: n(raw.esfuerzo),
    risk: ['bajo', 'medio', 'alto'].includes(raw.riesgo) ? raw.riesgo : 'medio',
    files: Array.isArray(raw.archivos) ? raw.archivos.filter((f) => typeof f === 'string' && f.trim()).map((f) => clip(f, 160)).slice(0, 6) : [],
    page: typeof raw.pagina === 'string' && raw.pagina.trim() ? clip(raw.pagina, 300) : null,
    width: [390, 1024, 1440].includes(Number(raw.ancho)) ? Number(raw.ancho) : 390,
  };
  return idea.title && idea.kind && idea.why && idea.todo && idea.gain && idea.confidence && idea.effort ? idea : null;
}

// ¿Merece la pena enseñarla? Con 3 o más rechazos en el último mes, se pide la ganancia máxima.
function worthIt(idea, history = {}, at = Date.now()) {
  if (!idea) return { ok: false, why: 'sin idea' };
  const rejected = history.rejected || [];
  const recent = rejected.filter((r) => at - (r.at || 0) < 30 * 24 * 3600 * 1000).length;
  const minGain = recent >= 3 ? 5 : 4;
  if (idea.gain < minGain) return { ok: false, why: `ganancia ${idea.gain} (hace falta ${minGain})` };
  if (idea.confidence < 4) return { ok: false, why: `confianza ${idea.confidence}` };
  if (idea.effort > 3) return { ok: false, why: `esfuerzo ${idea.effort}` };
  if (idea.risk === 'alto') return { ok: false, why: 'riesgo alto' };
  const seen = [...rejected, ...(history.tried || [])].find((r) => similar(r.title, idea.title));
  if (seen) return { ok: false, why: `parecida a «${seen.title}»` };
  return { ok: true, why: '' };
}

// Lo que se le pide a la sesión con «Pruébalo en una rama aparte».
function tryPrompt(card, folder) {
  const slug = slugOf(card.title);
  const copy = `${slugOf(path.basename(folder))}-idea-${slug}`; // sin espacios ni símbolos
  return [
    `Idea de ClaudHome (SuperPowers) que quiero probar: «${card.title}».`,
    `Por qué: ${card.why}`,
    `Qué hacer: ${card.todo}${card.files.length ? ` (archivos: ${card.files.join(', ')})` : ''}`,
    `Pruébala sin tocar mi rama actual ni mis cambios: crea una copia de trabajo aparte con «git worktree add "../${copy}" -b idea/${slug}» (si el proyecto no usa git, dímelo y no hagas nada) y haz allí el cambio.`,
    card.kind === 'visual'
      ? `Después pasa las pruebas en la copia y captura con capturar_pantalla el antes (${card.page || 'la página donde se ve'}, en esta carpeta) y el después (en la copia), a ${card.width} px y a los anchos de siempre.`
      : 'Después pasa las pruebas en la copia y añade las que hagan falta para lo nuevo.',
    `Al terminar, enséñame el resultado y dime cómo quedármelo (git merge idea/${slug}) o descartarlo (borrar la copia y la rama). No cambies nada fuera de la copia.`,
  ].join('\n');
}

// findClaude(), env(), workDir(): para lanzar Sonnet aparte (como el Workflow) · material(folder):
// el resumen del proyecto (workflow-digest.js) · codexCheck(folder, idea, text, tabId): { agrees, why }
// o null si Codex no puede · capture(tabId, idea, folder): la captura de «ahora» o null ·
// record(entry): al «Log» · ask(prompt): solo para las pruebas.
function createIdeas({
  store, tabs, send, log = () => {}, findClaude, env = () => process.env, workDir, material,
  codexCheck = async () => null, capture = async () => null, record = () => {}, ask = null, now = () => Date.now(),
}) {
  const all = store.get('ideas', {}) || {};
  const running = new Set();
  const requests = new Map(); // proyecto → lo último pedido (en memoria)
  const save = () => store.set('ideas', all);
  const project = (folder) => {
    const key = keyOf(folder);
    if (!all[key]) all[key] = { count: 0, lastAt: 0, card: null, snoozeUntil: 0, rejected: [], tried: [] };
    return all[key];
  };
  const runner = createRunner({ env, workDir, timeout: TIMEOUT });
  const run = ask || (async (text) => {
    const exe = findClaude();
    if (!exe) return { error: 'no se encuentra claude' };
    const args = ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--setting-sources', '', '--system-prompt', SYSTEM, '--output-format', 'json'];
    const { code, stdout } = await runner.run(command(exe, args), text);
    const out = code === 0 ? resultText(stdout) : null;
    return out ? { text: out } : { error: code === null ? 'no ha terminado a tiempo' : 'no ha contestado' };
  });

  // Termina un turno con cambios en una pestaña con SuperPowers (la pasada final ya se ha hecho).
  function turnDone(tabId, request = '') {
    const tab = tabs.get(tabId);
    if (!tab || !tab.folder || !tab.superpowers) return false;
    const key = keyOf(tab.folder);
    const p = project(tab.folder);
    if (request) requests.set(key, [...(requests.get(key) || []), maskSecrets(clip(request, 400))].slice(-5));
    p.count += 1;
    save();
    const due = p.count >= EVERY && now() - (p.lastAt || 0) >= GAP && !p.card && claim(key, p);
    if (due) setImmediate(() => { think(tabId, tab.folder, key, p).catch((err) => log(`Ideas: ${err.message}`)); });
    return due;
  }

  // Se reserva el proyecto en el mismo instante en que se decide: así, varios turnos seguidos o
  // una respuesta inmediata no lanzan varias consultas.
  function claim(key, p) {
    if (running.has(key)) return false;
    running.add(key);
    p.lastAt = now();
    p.count = 0;
    save();
    return true;
  }

  // Pensar una idea ya (sin esperar a los turnos ni al día): para las pruebas.
  async function generate(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.folder) return null;
    const key = keyOf(tab.folder);
    const p = project(tab.folder);
    if (!claim(key, p)) return null;
    return think(tabId, tab.folder, key, p);
  }

  async function think(tabId, folder, key, p) {
    try {
      const shown = await material(folder);
      record({ tabId, kind: 'idea', target: folder, detail: `Sonnet · ideas para el proyecto · ${shown.used.length} archivos${shown.masked ? ` · ${shown.masked} valores con pinta de clave tapados` : ''}`, dest: 'Anthropic', external: true, size: shown.size });
      const text = prompt({
        name: path.basename(folder), text: shown.text, requests: requests.get(key) || [],
        rejected: p.rejected.map((r) => r.title), tried: p.tried.map((r) => r.title),
      });
      const started = now();
      const answer = await run(text);
      const idea = answer.text ? parseIdea(answer.text) : null;
      const seconds = Math.round((now() - started) / 1000);
      if (!idea) { log(`Ideas: ${answer.error ? `Sonnet ${answer.error}` : 'ninguna idea que merezca la pena'} para ${folder} (${seconds} s)`); return null; }
      const verdict = worthIt(idea, p, now());
      if (!verdict.ok) { log(`Ideas: se descarta «${idea.title}» (${verdict.why})`); return null; }
      const second = await codexCheck(folder, idea, shown.text, tabId).catch(() => null);
      if (second && second.agrees === false) { log(`Ideas: Codex no coincide con «${idea.title}»${second.why ? ` (${second.why})` : ''}; no se enseña`); return null; }
      const card = { id: crypto.randomBytes(4).toString('hex'), at: now(), ...idea, codex: second ? true : null, before: null };
      if (card.kind === 'visual' && card.page) card.before = await capture(tabId, card, folder).catch(() => null);
      p.card = card;
      save();
      log(`Ideas: «${card.title}» para ${folder} (ganancia ${card.gain}, confianza ${card.confidence}, esfuerzo ${card.effort}${card.codex ? ', Codex coincide' : ''})`);
      for (const [id, other] of tabs.map) if (other && other.folder && keyOf(other.folder) === key && other.superpowers) send('ideas:card', id, card);
      return card;
    } finally {
      running.delete(key);
    }
  }

  // La idea que espera respuesta en el proyecto de la pestaña (si no está aplazada), o null.
  function get(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.folder || !tab.superpowers) return null;
    const p = all[keyOf(tab.folder)];
    return p && p.card && now() >= (p.snoozeUntil || 0) ? p.card : null;
  }

  // La respuesta del usuario: 'try' (devuelve lo que se le pide a la sesión), 'later' o 'no'.
  function act(tabId, id, action) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.folder) return { ok: false };
    const p = all[keyOf(tab.folder)];
    if (!p || !p.card || p.card.id !== id) return { ok: false };
    const card = p.card;
    if (now() < (p.snoozeUntil || 0)) return { ok: false }; // aplazada: aún no se enseña
    const key = keyOf(tab.folder);
    const clear = () => { for (const [id, other] of tabs.map) if (other && other.folder && keyOf(other.folder) === key) send('ideas:clear', id, card.id); };
    if (action === 'later') { p.snoozeUntil = now() + SNOOZE; save(); clear(); return { ok: true }; }
    p.card = null;
    p.snoozeUntil = 0;
    if (action === 'no') p.rejected = [...p.rejected, { title: card.title, kind: card.kind, at: now() }].slice(-KEEP);
    if (action === 'try') p.tried = [...p.tried, { title: card.title, kind: card.kind, at: now() }].slice(-KEEP);
    save();
    clear();
    log(`Ideas: «${card.title}»: ${action === 'try' ? 'se prueba en una rama aparte' : 'no le interesa'}`);
    return action === 'try' ? { ok: true, prompt: tryPrompt(card, tab.folder) } : { ok: true };
  }

  return { turnDone, generate, get, act, stop: runner.stop };
}

module.exports = { createIdeas, prompt, parseIdea, worthIt, tryPrompt, similar, slugOf, EVERY, GAP };
