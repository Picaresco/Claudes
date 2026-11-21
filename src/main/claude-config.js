// Lo que la app lee de Claude Code: la configuración del usuario y los datos que
// Claude Code pasa a la línea de estado.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configuración de Claude Code del usuario (~/.claude/settings.json), o {}.
function userSettings() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8').replace(/^﻿/, '')) || {};
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

module.exports = { userSettings, usageFrom };
