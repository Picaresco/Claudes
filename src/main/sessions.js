// Localiza Claude Code y decide con qué conversación arranca cada pestaña.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

let claudePath; // undefined = sin buscar todavía; null = no encontrado

function findClaude() {
  if (claudePath !== undefined) return claudePath;
  const candidates = [];
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch { /* no está en el PATH */ }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  const existing = candidates.filter((c) => fs.existsSync(c));
  claudePath = existing.find((c) => /\.exe$/i.test(c)) || existing.find((c) => /\.(cmd|bat)$/i.test(c)) || null;
  return claudePath;
}

function projectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

// Claude Code guarda cada conversación en
// ~/.claude/projects/<carpeta con los caracteres no alfanuméricos cambiados por «-»>/<id>.jsonl
function projectDir(cwd) {
  const wanted = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let names;
  try { names = fs.readdirSync(projectsRoot()); } catch { return null; }
  const match = names.find((n) => n.toLowerCase() === wanted);
  return match ? path.join(projectsRoot(), match) : null;
}

function transcriptExists(cwd, sessionId) {
  const dir = projectDir(cwd);
  return Boolean(dir && sessionId && fs.existsSync(path.join(dir, `${sessionId}.jsonl`)));
}

function latestSession(cwd, inUse) {
  const dir = projectDir(cwd);
  if (!dir) return null;
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!UUID_FILE.test(name)) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (inUse.has(id)) continue;
    let mtime;
    try { mtime = fs.statSync(path.join(dir, name)).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best ? best.id : null;
}

// mode:
//   'resume'   → la conversación propia de la pestaña; si ya no existe, una nueva.
//   'continue' → la más reciente de la carpeta que no esté abierta en otra pestaña.
//   'new'      → una conversación nueva.
function plan({ cwd, sessionId, mode, exclude }) {
  const inUse = new Set(exclude || []);
  if (mode === 'resume' && sessionId && !inUse.has(sessionId) && transcriptExists(cwd, sessionId)) {
    return { args: ['--resume', sessionId], sessionId, resumed: true };
  }
  if (mode === 'continue') {
    const latest = latestSession(cwd, inUse);
    if (latest) return { args: ['--resume', latest], sessionId: latest, resumed: true };
  }
  const id = crypto.randomUUID();
  return { args: ['--session-id', id], sessionId: id, resumed: false };
}

module.exports = { findClaude, plan };
