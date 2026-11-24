// Lo que la app lee de Claude Code: la configuración del usuario y los datos que
// Claude Code pasa a la línea de estado.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configuración de Claude Code del usuario (~/.claude/settings.json), o {}.
function userSettings() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return {}; // sin archivo o ilegible
  }
}

// Cuánto ocupa la conversación, a partir de lo que Claude Code da a la línea de estado.
function usageFrom(data) {
  const window = data && data.context_window;
  if (!window || !(window.context_window_size > 0)) return null;
  const current = window.current_usage;
  const used = current
    ? (current.input_tokens || 0) + (current.cache_creation_input_tokens || 0) + (current.cache_read_input_tokens || 0)
    : null;
  let pct = typeof window.used_percentage === 'number' ? window.used_percentage : null;
  if (pct === null && used !== null) pct = (used / window.context_window_size) * 100;
  return { size: window.context_window_size, used, pct: pct === null ? null : Math.round(pct) };
}

// El modelo y el esfuerzo de la sesión, de lo mismo que Claude Code le pasa a su línea de
// estado: { id, name, effort, fast } o null. (Comprobado con Claude Code 2.1.331: model.id,
// model.display_name, effort.level y fast_mode.)
function modelFrom(data) {
  const model = data && data.model;
  if (!model || typeof model !== 'object') return null;
  const name = typeof model.display_name === 'string' && model.display_name ? model.display_name : typeof model.id === 'string' ? model.id : null;
  if (!name) return null;
  const effort = data.effort && typeof data.effort.level === 'string' ? data.effort.level : null;
  return { id: typeof model.id === 'string' ? model.id : null, name: name.slice(0, 60), effort: effort ? effort.slice(0, 20) : null, fast: data.fast_mode === true };
}

// Guarda el modelo y el esfuerzo como predeterminados de Claude Code para las sesiones nuevas,
// igual que /model y /effort: «model» (el alias si lo hay) y modelSettings.<id>.effortLevel.
// Si la configuración no se puede leer, no se toca. → { ok } o { ok: false, error }.
const ALIASES = { 'claude-opus-5-5': 'opus', 'claude-sonnet-5-5': 'sonnet', 'claude-haiku-5-5': 'haiku' };
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
function saveDefaultModel({ model, effort } = {}) {
  if (typeof model !== 'string' || !/^[\w.[\]-]{2,60}$/.test(model)) return { ok: false, error: 'modelo no válido' };
  if (effort !== null && effort !== undefined && !EFFORT_VALUES.includes(effort)) return { ok: false, error: 'esfuerzo no válido' };
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(configDir, 'settings.json');
  let settings = {};
  try {
    if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return { ok: false, error: 'tu configuración de Claude Code (settings.json) no se puede leer, así que no se toca' };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, error: 'tu configuración de Claude Code no tiene el formato esperado' };
  settings.model = ALIASES[model] || model;
  if (effort) {
    settings.modelSettings = settings.modelSettings && typeof settings.modelSettings === 'object' ? settings.modelSettings : {};
    settings.modelSettings[model] = { ...(settings.modelSettings[model] || {}), effortLevel: effort };
  }
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

// El modelo y el esfuerzo predeterminados de Claude Code (los de settings.json): { model, effort },
// con el modelo como id si su alias es conocido; null en lo que no haya.
function defaultModel() {
  const settings = userSettings();
  const raw = typeof settings.model === 'string' ? settings.model : null;
  const id = raw ? Object.keys(ALIASES).find((key) => ALIASES[key] === raw) || raw : null;
  const per = id && settings.modelSettings && settings.modelSettings[id];
  return { model: id, effort: per && typeof per.effortLevel === 'string' ? per.effortLevel : null };
}

module.exports = { userSettings, usageFrom, modelFrom, saveDefaultModel, defaultModel };
