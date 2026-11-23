// ¿Conviene optimizar este proyecto? Un sistema mixto, para avisar solo cuando de verdad toca:
//
// 1. Señales gratuitas. Con lo que la app ve en los hooks: cada vez que Claude cambia un
//    archivo de código del proyecto (Edit, Write…) se apunta el cambio y cuántas líneas tiene.
//    Umbrales, desde la última optimización (o desde que la app sigue el proyecto):
//      - muchos cambios: EDITS cambios de código;
//      - un archivo grande: BIG líneas o más, si no lo era o ha crecido un 15 % desde entonces;
//      - hace tiempo: OLD_DAYS días con al menos OLD_EDITS cambios.
// 2. La segunda mirada de Haiku (optimize-check.js), solo cuando alguna señal pasa su umbral:
//    lee los archivos que más han cambiado y dice si de verdad conviene, y por qué. Una vez por
//    ronda (entre optimizaciones); si dice que no, no se le vuelve a preguntar hasta pasados
//    RECHECK_DAYS días y RECHECK_EDITS cambios más. Si no se le puede preguntar, valen las
//    señales y se vuelve a intentar al día siguiente.
//
// Solo con su visto bueno se recomienda: el botón «Optimiza» aparece y se avisa una vez. Nunca
// se lanza solo: lo pulsa el usuario. Al empezar una optimización se pone todo a cero (y lo
// que cambie Claude mientras optimiza no cuenta). «Ahora no» lo calla SNOOZE_DAYS días.
const fs = require('fs');
const path = require('path');
const { isCode, codeLines, norm } = require('./growth');

const EDITS = 150;
const BIG = 800;
const BIG_GROWTH = 1.15;
const OLD_DAYS = 30;
const OLD_EDITS = 40;
const SNOOZE_DAYS = 7;
const RECHECK_DAYS = 7;
const RECHECK_EDITS = 30;
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024; // archivos más grandes no se cuentan
const MAX_FILES = 300; // archivos que se recuerdan por proyecto
const MAX_PROJECTS = 60;
const STORE_KEY = 'optimizeHints';

const fresh = (now) => ({ since: now, last: null, edits: 0, files: {}, baseline: {}, changed: {}, ai: null, snoozed: 0, told: false, touched: now });
const nf = (n) => n.toLocaleString('es-ES');
const isBig = (rec, file, lines) => lines >= BIG && !(rec.baseline && rec.baseline[file] && lines < rec.baseline[file] * BIG_GROWTH);

// Las señales gratuitas que pasan su umbral, explicadas.
function signals(rec, now = Date.now()) {
  if (!rec) return [];
  const out = [];
  const from = rec.last ? 'desde la última optimización' : 'desde que ClaudHome sigue este proyecto';
  if (rec.edits >= EDITS) out.push(`${nf(rec.edits)} cambios de código ${from}`);
  const big = Object.entries(rec.files || {}).filter(([file, lines]) => isBig(rec, file, lines)).sort((a, b) => b[1] - a[1]);
  if (big.length) {
    const named = big.slice(0, 2).map(([file, lines]) => `${path.basename(file)} tiene ${nf(lines)} líneas`);
    const more = big.length - 2;
    out.push(more > 0 ? `${named.join(', ')} y ${more === 1 ? 'otro más es muy grande' : `${more} más son muy grandes`}` : named.join(' y '));
  }
  const days = Math.floor((now - (rec.last || rec.since)) / DAY);
  if (days >= OLD_DAYS && rec.edits >= OLD_EDITS && rec.edits < EDITS) out.push(`hace ${days} días ${rec.last ? 'de la última optimización' : 'que ClaudHome lo sigue'} y lleva ${nf(rec.edits)} cambios de código`);
  return out;
}

// Si conviene optimizar y por qué: { recommended, reasons, snoozed, signals, needsCheck }.
// reasons: lo que se le enseña al usuario (primero lo que dice Haiku).
function evaluate(rec, now = Date.now()) {
  const sig = signals(rec, now);
  const snoozed = Boolean(rec && rec.snoozed && now < rec.snoozed);
  const base = { recommended: false, reasons: [], snoozed, signals: sig, needsCheck: false };
  if (!sig.length) return base;
  const ai = rec.ai && rec.ai.at >= (rec.last || 0) ? rec.ai : null; // la de esta ronda
  if (!ai) return { ...base, needsCheck: !snoozed }; // aún no ha mirado Haiku
  if (ai.verdict === true) return { ...base, recommended: !snoozed, reasons: [ai.reason, ...sig].filter(Boolean) };
  if (ai.verdict === false) {
    const again = now - ai.at >= RECHECK_DAYS * DAY && rec.edits >= (ai.edits || 0) + RECHECK_EDITS;
    return { ...base, needsCheck: again && !snoozed };
  }
  // No se le pudo preguntar: valen las señales, y se vuelve a intentar al día siguiente.
  return { ...base, recommended: !snoozed, reasons: sig, needsCheck: !snoozed && now - ai.at >= DAY };
}

// store: store.js · tabs: tabs.js · send(canal, …): a la interfaz · check({ folder, files,
// signals, tabId }): la segunda mirada (optimize-check.js) → { recommend, reason } o { error }.
function createOptimizeHints({ store, tabs, send = () => {}, log = () => {}, now = () => Date.now(), check = null }) {
  const all = () => store.get(STORE_KEY, {}) || {};
  const keyOf = (tabId) => { const folder = (tabs.get(tabId) || {}).folder; return folder ? norm(folder) : null; };
  const label = (tabId) => (tabs.label ? tabs.label(tabId) : tabId);
  function save(key, rec) {
    const data = { ...all(), [key]: { ...rec, touched: now() } };
    const keys = Object.keys(data);
    if (keys.length > MAX_PROJECTS) {
      keys.sort((a, b) => (data[a].touched || 0) - (data[b].touched || 0)).slice(0, keys.length - MAX_PROJECTS).forEach((k) => { delete data[k]; });
    }
    store.set(STORE_KEY, data);
  }
  const record = (key) => ({ ...fresh(now()), ...(all()[key] || {}) });
  const forUi = ({ recommended, reasons, snoozed }) => ({ recommended, reasons, snoozed });

  // Lo que se le dice a la interfaz de un proyecto: a todas sus pestañas.
  function push(key, extra = {}) {
    const hint = { ...forUi(evaluate(all()[key], now())), ...extra };
    for (const [id, tab] of tabs.map) if (tab.folder && norm(tab.folder) === key) send('optimize:hint', id, hint);
    return hint;
  }
  // Para la interfaz, al arrancar una sesión o al pedirlo.
  function hint(tabId) {
    const key = keyOf(tabId);
    return forUi(key ? evaluate(all()[key], now()) : evaluate(null));
  }
  // Pasa a recomendado y se dice (una vez desde la última optimización).
  function tell(key, rec, result, tabId) {
    save(key, { ...rec, told: true });
    log(`Optimiza: se recomienda para ${label(tabId)} (${result.reasons.join('; ')})`);
    push(key, { first: true });
  }
  // Tras un cambio de estado: se avisa la primera vez; si no, se pone al día la interfaz.
  function settle(key, rec, before, tabId) {
    const after = evaluate(rec, now());
    if (after.recommended && !rec.told) tell(key, rec, after, tabId);
    else if (!before || after.recommended !== before.recommended || (after.recommended && after.reasons.join('|') !== before.reasons.join('|'))) push(key);
    maybeCheck(key, tabId, after);
  }

  // La segunda mirada de Haiku, si toca (una a la vez por proyecto, en segundo plano).
  const checking = new Map(); // proyecto → promesa
  function maybeCheck(key, tabId, result) {
    if (!check || !result.needsCheck || checking.has(key)) return;
    const folder = (tabs.get(tabId) || {}).folder;
    if (!folder) return;
    const rec = record(key);
    const round = rec.last;
    // Los archivos que más han cambiado en esta ronda; después, los grandes.
    const changed = Object.entries(rec.changed || {}).map(([name, edits]) => ({ name, edits, lines: (rec.files || {})[name] }));
    const big = Object.entries(rec.files || {}).filter(([name, lines]) => isBig(rec, name, lines) && !(name in (rec.changed || {}))).map(([name, lines]) => ({ name, edits: 0, lines }));
    const files = [...changed.sort((a, b) => b.edits - a.edits || (b.lines || 0) - (a.lines || 0)), ...big.sort((a, b) => b.lines - a.lines)];
    log(`Optimiza: las señales de ${label(tabId)} pasan el umbral (${result.signals.join('; ')}); se lo pregunta a Haiku`);
    const work = Promise.resolve()
      .then(() => check({ folder, files, signals: result.signals, tabId }))
      .catch((err) => ({ error: (err && err.message) || 'falló' }))
      .then((answer) => {
        const current = record(key);
        if (current.last !== round) return; // ha empezado otra optimización mientras tanto
        const ai = answer && !answer.error && typeof answer.recommend === 'boolean'
          ? { at: now(), verdict: answer.recommend, reason: answer.reason || '', edits: current.edits }
          : { at: now(), verdict: null, reason: '', edits: current.edits };
        const before = evaluate(current, now());
        const next = { ...current, ai };
        save(key, next);
        settle(key, next, before, tabId);
      })
      .finally(() => { checking.delete(key); });
    checking.set(key, work);
  }

  // Al abrir una sesión (o al pedirlo): si ya conviene y aún no se ha dicho, se avisa ahora; si
  // las señales pasan el umbral (por ejemplo, porque ha pasado un mes), se pregunta a Haiku.
  function refresh(tabId) {
    const key = keyOf(tabId);
    if (!key) return;
    const rec = all()[key];
    if (!rec) { push(key); return; }
    settle(key, rec, null, tabId);
  }

  // Claude ha cambiado un archivo (con éxito). base: carpeta de trabajo para una ruta relativa.
  async function edited(tabId, file, base = null) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.folder || typeof file !== 'string' || !isCode(file)) return;
    const key = norm(tab.folder);
    const full = path.resolve(base || tab.folder, file);
    const rel = path.relative(tab.folder, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // fuera del proyecto
    let lines = null;
    try {
      const st = await fs.promises.stat(full);
      if (st.isFile() && st.size <= MAX_BYTES) lines = codeLines(full, await fs.promises.readFile(full, 'utf8'));
    } catch { /* ya no existe o no se puede leer: cuenta el cambio, sin líneas */ }
    const before = evaluate(all()[key], now());
    const rec = record(key);
    const name = rel.split(path.sep).join('/');
    if (Number.isFinite(lines)) {
      rec.files = { ...rec.files, [name]: lines };
      const names = Object.keys(rec.files);
      if (names.length > MAX_FILES) delete rec.files[names[0]];
    }
    if (tab.optimizing) {
      // Lo que cambia la propia optimización no cuenta, y su resultado es el punto de partida.
      if (Number.isFinite(lines)) rec.baseline = { ...rec.baseline, [name]: lines };
    } else {
      rec.edits += 1;
      rec.changed = { ...rec.changed, [name]: ((rec.changed || {})[name] || 0) + 1 };
      const names = Object.keys(rec.changed);
      if (names.length > MAX_FILES) delete rec.changed[names[0]];
    }
    save(key, rec);
    settle(key, rec, before, tabId);
  }

  // Empieza un turno: lo que se cambie ya no es de una optimización (hasta que se confirme otra).
  function turnStarted(tabId) {
    const tab = tabs.get(tabId);
    if (tab) tab.optimizing = false;
  }

  // Empieza una optimización (se han dado las instrucciones): a cero, y lo que cambie Claude
  // en este turno no cuenta.
  function optimized(tabId) {
    const tab = tabs.get(tabId);
    const key = keyOf(tabId);
    if (!tab || !key) return;
    tab.optimizing = true;
    const rec = record(key);
    save(key, { ...rec, last: now(), edits: 0, baseline: { ...rec.files }, changed: {}, ai: null, snoozed: 0, told: false });
    push(key);
  }

  // «Ahora no»: no se recomienda en unos días.
  function snooze(tabId) {
    const key = keyOf(tabId);
    if (!key) return hint(tabId);
    save(key, { ...record(key), snoozed: now() + SNOOZE_DAYS * DAY });
    log(`Optimiza: ${label(tabId)} lo deja para más adelante (${SNOOZE_DAYS} días)`);
    return push(key);
  }

  // Para las pruebas: espera a que terminen las preguntas a Haiku en marcha.
  const settled = () => Promise.all([...checking.values()]);

  return { edited, turnStarted, optimized, snooze, hint, refresh, settled };
}

module.exports = { createOptimizeHints, evaluate, signals, EDITS, BIG, OLD_DAYS, OLD_EDITS, SNOOZE_DAYS, RECHECK_DAYS, RECHECK_EDITS };
