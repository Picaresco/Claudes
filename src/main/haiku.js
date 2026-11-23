// Preguntas rápidas a Haiku a través de Claude Code (`claude -p --model haiku`), con el plan
// del usuario: sin herramientas, sin servidores MCP, sin su configuración (ni sus hooks) y sin
// guardar la sesión, en una carpeta vacía. Solo lee lo que se le da por la entrada estándar y
// contesta. Lo usan la segunda mirada de «Optimiza» (optimize-check.js) y el panel «Actividad»
// (narrator.js).
const fs = require('fs');
const { spawn } = require('child_process');

// Argumentos de Claude Code para una pregunta con su propio guion de sistema.
const haikuArgs = (system) => ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
  '--disable-slash-commands', '--setting-sources', '', '--system-prompt', system, '--output-format', 'json'];

// Cómo lanzar Claude Code: un .cmd (instalación con npm) va a través de cmd.exe.
function command(exe, args) {
  if (!/\.(cmd|bat)$/i.test(exe)) return { file: exe, args, verbatim: false };
  const q = (arg) => (arg === '' ? '""' : /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[exe, ...args].map(q).join(' ')}"`], verbatim: true };
}

// El texto de la respuesta (--output-format json), o null si es un error o no se entiende.
function resultText(stdout) {
  let result;
  try { result = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!result || result.is_error || typeof result.result !== 'string') return null;
  return result.result;
}

// El primer objeto JSON de un texto (Haiku a veces lo envuelve en ```json … ```), o null.
function jsonIn(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const value = JSON.parse(text.slice(a, b + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Corta un proceso y lo que haya lanzado: con una instalación por npm se lanza cmd.exe, y
// cortar solo cmd.exe dejaría a Claude Code en marcha.
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch { /* ya ha terminado */ } });
      return;
    } catch { /* sin taskkill: como en los demás sistemas */ }
  }
  try { child.kill(); } catch { /* ya ha terminado */ }
}

// env(): entorno sin las marcas de la sesión · workDir(): carpeta vacía donde se lanza ·
// timeout: ms hasta cortarlo. run(cmd, input) → { code, stdout } (code null si se cortó o no arrancó).
function createRunner({ env = () => process.env, workDir, timeout }) {
  const running = new Set();
  const run = ({ file, args, verbatim }, input) => new Promise((resolve) => {
    let child;
    try {
      const cwd = workDir();
      fs.mkdirSync(cwd, { recursive: true });
      child = spawn(file, args, { cwd, env: env(), windowsHide: true, windowsVerbatimArguments: verbatim });
    } catch { resolve({ code: null, stdout: '' }); return; }
    running.add(child);
    let stdout = '';
    let done = false;
    let grace = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      running.delete(child);
      resolve(result);
    };
    // Al pasar el tiempo, se corta todo lo que haya lanzado; si aun así no se cierra, se da por cortado.
    const timer = setTimeout(() => {
      killTree(child);
      grace = setTimeout(() => finish({ code: null, stdout: '' }), 3000);
    }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < 200000) stdout += d; });
    child.stderr.on('data', () => { /* sin uso */ });
    child.on('error', () => finish({ code: null, stdout: '' }));
    child.on('close', (code) => finish({ code, stdout }));
    child.stdin.on('error', () => { /* se cerró antes de tiempo */ });
    child.stdin.end(input);
  });
  // Al cerrar la app (o el panel «Actividad»), lo que esté en marcha se corta.
  const stop = () => { for (const child of running) killTree(child); running.clear(); };
  return { run, stop, busy: () => running.size };
}

module.exports = { haikuArgs, command, resultText, jsonIn, createRunner };
