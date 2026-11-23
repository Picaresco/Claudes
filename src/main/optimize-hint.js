// ¿Conviene optimizar este proyecto? La app lo calcula sola, sin gastar nada, con lo que ve
// en los hooks: cada vez que Claude cambia un archivo de código del proyecto (Edit, Write…)
// se apunta el cambio y cuántas líneas tiene el archivo. Cuando pasa un umbral, el botón
// «Optimiza» se marca como recomendado y lo dice una vez; nunca se lanza solo: lo pulsa el
// usuario, cuando quiere. Umbrales, desde la última optimización (o desde que la app sigue
// el proyecto):
//   - muchos cambios: EDITS cambios de código;
//   - un archivo grande: BIG líneas o más, si no lo era o ha crecido un 15 % desde entonces;
//   - hace tiempo: OLD_DAYS días con al menos OLD_EDITS cambios.
// Al empezar una optimización se pone a cero (y lo que cambie Claude mientras optimiza no
// cuenta). «Ahora no» deja de recomendarlo SNOOZE_DAYS días.
const fs = require('fs');
const path = require('path');
const { isCode, codeLines, norm } = require('./growth');

const EDITS = 150;
const BIG = 800;
const BIG_GROWTH = 1.15;
const OLD_DAYS = 30;
const OLD_EDITS = 40;
const SNOOZE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024; // archivos más grandes no se cuentan
const MAX_FILES = 300; // archivos que se recuerdan por proyecto
const MAX_PROJECTS = 60;
const STORE_KEY = 'optimizeHints';

const fresh = (now) => ({ since: now, last: null, edits: 0, files: {}, baseline: {}, snoozed: 0, told: false, touched: now });
const nf = (n) => n.toLocaleString('es-ES');

// Si conviene optimizar y por qué: { recommended, reasons, snoozed }.
function evaluate(rec, now = Date.now()) {
  if (!rec) return { recommended: false, reasons: [], snoozed: false };
  const reasons = [];
  const from = rec.last ? 'desde la última optimización' : 'desde que ClaudHome sigue este proyecto';
  if (rec.edits >= EDITS) reasons.push(`${nf(rec.edits)} cambios de código ${from}`);
  const big = Object.entries(rec.files || {})
    .filter(([file, lines]) => lines >= BIG && !(rec.baseline && rec.baseline[file] && lines < rec.baseline[file] * BIG_GROWTH))
    .sort((a, b) => b[1] - a[1]);
  if (big.length) {
    const named = big.slice(0, 2).map(([file, lines]) => `${path.basename(file)} tiene ${nf(lines)} líneas`);
    const more = big.length - 2;
    reasons.push(more > 0 ? `${named.join(', ')} y ${more === 1 ? 'otro más es muy grande' : `${more} más son muy grandes`}` : named.join(' y '));
  }
  const days = Math.floor((now - (rec.last || rec.since)) / DAY);
  if (days >= OLD_DAYS && rec.edits >= OLD_EDITS && rec.edits < EDITS) reasons.push(`hace ${days} días ${rec.last ? 'de la última optimización' : 'que ClaudHome lo sigue'} y lleva ${nf(rec.edits)} cambios de código`);
  const snoozed = Boolean(rec.snoozed && now < rec.snoozed);
  return { recommended: reasons.length > 0 && !snoozed, reasons, snoozed };
}

// store: store.js · tabs: tabs.js · send(canal, …): a la interfaz.
function createOptimizeHints({ store, tabs, send = () => {}, log = () => {}, now = () => Date.now() }) {
  const all = () => store.get(STORE_KEY, {}) || {};
  const keyOf = (tabId) => { const folder = (tabs.get(tabId) || {}).folder; return folder ? norm(folder) : null; };
  function save(key, rec) {
    const data = { ...all(), [key]: { ...rec, touched: now() } };
    const keys = Object.keys(data);
    if (keys.length > MAX_PROJECTS) {
      keys.sort((a, b) => (data[a].touched || 0) - (data[b].touched || 0)).slice(0, keys.length - MAX_PROJECTS).forEach((k) => { delete data[k]; });
    }
    store.set(STORE_KEY, data);
  }
  const record = (key) => all()[key] || fresh(now());

  // Lo que se le dice a la interfaz de un proyecto: a todas sus pestañas.
  function push(key, extra = {}) {
    const hint = { ...evaluate(all()[key], now()), ...extra };
    for (const [id, tab] of tabs.map) if (tab.folder && norm(tab.folder) === key) send('optimize:hint', id, hint);
    return hint;
  }
  // Para la interfaz, al arrancar una sesión o al pedirlo.
  function hint(tabId) {
    const key = keyOf(tabId);
    return key ? evaluate(all()[key], now()) : { recommended: false, reasons: [], snoozed: false };
  }
  // Al abrir una sesión (o al pedirlo): si ya conviene y aún no se ha dicho (por ejemplo, porque
  // ha pasado un mes desde la última optimización), se avisa ahora.
  function refresh(tabId) {
    const key = keyOf(tabId);
    if (!key) return;
    const rec = all()[key];
    const now_ = evaluate(rec, now());
    if (now_.recommended && rec && !rec.told) { tell(key, rec, now_, tabId); return; }
    push(key);
  }
  // Pasa a recomendado y se dice (una vez desde la última optimización).
  function tell(key, rec, result, tabId) {
    save(key, { ...rec, told: true });
    log(`Optimiza: se recomienda para ${tabs.label ? tabs.label(tabId) : tabId} (${result.reasons.join('; ')})`);
    push(key, { first: true });
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
    }
    save(key, rec);
    const after = evaluate(rec, now());
    // La primera vez que pasa a recomendado (desde la última optimización), se avisa; si ya lo
    // era, solo se pone al día el motivo.
    if (after.recommended && !rec.told) tell(key, rec, after, tabId);
    else if (after.recommended !== before.recommended || (after.recommended && after.reasons.join('|') !== before.reasons.join('|'))) push(key);
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
    save(key, { ...rec, last: now(), edits: 0, baseline: { ...rec.files }, snoozed: 0, told: false });
    push(key);
  }

  // «Ahora no»: no se recomienda en unos días.
  function snooze(tabId) {
    const key = keyOf(tabId);
    if (!key) return hint(tabId);
    save(key, { ...record(key), snoozed: now() + SNOOZE_DAYS * DAY });
    log(`Optimiza: ${tabs.label ? tabs.label(tabId) : tabId} lo deja para más adelante (${SNOOZE_DAYS} días)`);
    return push(key);
  }

  return { edited, turnStarted, optimized, snooze, hint, refresh };
}

module.exports = { createOptimizeHints, evaluate, EDITS, BIG, OLD_DAYS, OLD_EDITS, SNOOZE_DAYS };
