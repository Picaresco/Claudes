// ── Lo que aporta SuperPowers en cada proyecto ───────────────────
// Para que el usuario vea si le compensa: de las tareas que cambian algo, cuántas se han hecho
// con SuperPowers y cuántas sin, cuánto han tardado, en cuántas la pasada final ha corregido algo
// (Claude ha vuelto a editar tras pedírsela), cuántas han terminado con las pruebas en verde y
// cuántos posibles problemas ha encontrado Codex al revisar. Todo con lo que ve ClaudHome (no con
// lo que diga Claude) y sin tokens: con agentes en paralelo no se pueden repartir bien.
// Se guarda en state.json («powerStats»), por carpeta.
const path = require('path');

const MAX_SECONDS = 4 * 3600; // una tarea que se queda abierta no infla la media
const blank = () => ({ turns: 0, seconds: 0, fixed: 0, tested: 0, green: 0 });

function createPowerStats({ store, now = () => Date.now() }) {
  const all = store.get('powerStats', {}) || {};
  const save = () => store.set('powerStats', all);
  const keyOf = (folder) => path.resolve(folder).toLowerCase();
  const project = (folder) => {
    const key = keyOf(folder);
    if (!all[key]) all[key] = { with: blank(), without: blank(), codex: 0, since: now() };
    return all[key];
  };

  // Una tarea terminada (superpowers.js, turnEnded): { mode: 'with'|'without', seconds, fixed, tests }.
  function record(folder, rec) {
    if (!folder || !rec || !['with', 'without'].includes(rec.mode)) return;
    const s = project(folder)[rec.mode];
    s.turns += 1;
    s.seconds += Math.min(MAX_SECONDS, Math.max(0, Math.round(Number(rec.seconds) || 0)));
    if (rec.fixed) s.fixed += 1;
    if (['ok', 'failing', 'pending'].includes(rec.tests)) s.tested += 1;
    if (rec.tests === 'ok') s.green += 1;
    save();
  }

  // Codex ha encontrado posibles problemas al revisar una tarea con SuperPowers.
  function codexFound(folder, count) {
    if (!folder || !(count > 0)) return;
    project(folder).codex += Math.round(count);
    save();
  }

  // Para la tarjeta del proyecto, o null si aún no hay nada con SuperPowers.
  function get(folder) {
    const p = folder ? all[keyOf(folder)] : null;
    if (!p || !p.with.turns) return null;
    const side = (s) => ({
      turns: s.turns,
      minutes: s.turns ? Math.round(s.seconds / s.turns / 6) / 10 : 0,
      fixed: s.fixed,
      tested: s.tested,
      green: s.green,
    });
    return { with: side(p.with), without: side(p.without), codex: p.codex, since: p.since };
  }

  return { record, codexFound, get };
}

module.exports = { createPowerStats };
