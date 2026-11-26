// ── Tarjeta del proyecto (botón derecho sobre una pestaña) ─────────
// Lo que necesita del proceso principal: cuándo se compacta la conversación y la dirección del
// proyecto en GitHub (para compartirla).
const { execFile } = require('child_process');

// Autocompactar: al llegar la conversación a este porcentaje del contexto, Claude Code la resume
// sola y sigue. 85 % de serie en todos los proyectos; cada pestaña puede tener el suyo.
const DEFAULT_COMPACT = 85;
const MIN_COMPACT = 30;
const MAX_COMPACT = 95;
// Claude Code cuenta el porcentaje de CLAUDE_AUTOCOMPACT_PCT_OVERRIDE sobre la ventana menos lo
// que reserva para la respuesta (980 000 de 1 000 000 en las sesiones probadas). Se corrige para
// que el porcentaje sea el que enseña la pestaña (sobre la ventana entera).
const OUTPUT_RESERVE = 20000;
const DEFAULT_WINDOW = 1000000;

const compactTarget = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= MIN_COMPACT && n <= MAX_COMPACT ? n : DEFAULT_COMPACT;
};

// El valor de la variable para que compacte al `target` % de una ventana de `size` tokens.
// Nunca pasa de 100 (con ventanas pequeñas, Claude Code compacta un poco antes de lo pedido).
function compactEnv(target, size) {
  const window = Number.isFinite(size) && size >= 100000 ? size : DEFAULT_WINDOW;
  const value = Math.min(100, (compactTarget(target) * window) / (window - OUTPUT_RESERVE));
  return String(Math.round(value * 10) / 10);
}

// La dirección pública en GitHub de un remoto de git, construida de nuevo: solo
// https://github.com/propietario/repositorio, sin usuario, clave, .git ni nada más. Admite
// https://…, ssh://git@github.com/… y git@github.com:propietario/repositorio.git.
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
function githubUrl(remote) {
  if (typeof remote !== 'string') return null;
  const text = remote.trim();
  let host;
  let rest;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text); // git@github.com:dueño/repo.git
  if (scp && !/^[a-z+]+:\/\//i.test(text)) {
    [, host, rest] = scp;
  } else {
    let url;
    try { url = new URL(text); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    host = url.hostname;
    rest = url.pathname;
  }
  if (!host || host.toLowerCase() !== 'github.com') return null;
  const parts = rest.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return null;
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

// La dirección en GitHub del proyecto de una carpeta: la del remoto «origin» si es de GitHub;
// si no, la del primero que lo sea. Sin git, sin remoto o sin GitHub: null. No registra nada
// de lo que devuelve git (una dirección puede llevar una clave dentro).
function repoUrl(folder, { run = execFile } = {}) {
  return new Promise((resolve) => {
    if (typeof folder !== 'string' || !folder) { resolve(null); return; }
    run('git', ['-C', folder, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || typeof stdout !== 'string') { resolve(null); return; }
      const remotes = stdout.split(/\r?\n/).map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim())).filter(Boolean)
        .map(([, name, url]) => ({ name, url: githubUrl(url) })).filter((r) => r.url);
      const origin = remotes.find((r) => r.name === 'origin');
      resolve((origin || remotes[0] || {}).url || null);
    });
  });
}

module.exports = { DEFAULT_COMPACT, MIN_COMPACT, MAX_COMPACT, compactTarget, compactEnv, githubUrl, repoUrl };
