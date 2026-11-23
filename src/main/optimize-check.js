// La segunda mirada antes de recomendar «Optimiza»: cuando las señales gratuitas de
// optimize-hint.js (muchos cambios, archivos grandes, tiempo) pasan su umbral, Haiku lee los
// archivos que más han cambiado y dice si de verdad conviene una limpieza, y por qué.
//
// Se lanza Claude Code en modo no interactivo (`claude -p --model haiku`) sin herramientas, sin
// servidores MCP, sin la configuración del usuario y sin guardar la sesión, en una carpeta
// vacía: solo lee lo que se le da (por la entrada estándar) y contesta con JSON. Gasta muy
// poco del plan del usuario y solo de vez en cuando (optimize-hint.js decide cuándo).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { scanText } = require('./secrets');

const MAX_FILES = 8; // archivos que se le enseñan
const MAX_FILE_CHARS = 12000; // de cada uno, como mucho (el principio)
const MAX_TOTAL = 60000; // en total
const TIMEOUT = 120 * 1000;
const MAX_REASON = 200; // caracteres del motivo que se enseña
const SYSTEM = 'Eres un revisor de código prudente. Decides si a un proyecto le conviene ahora una pasada de limpieza y optimización que no cambie su comportamiento. Respondes solo con JSON válido, sin texto alrededor.';

// Lo que se le enseña a Haiku: los archivos que más han cambiado, recortados. Los que llevan
// algo que parece una clave no se envían. files: [{ name, edits, lines }], ya ordenados.
function material(folder, files) {
  const parts = [];
  const used = [];
  const skipped = [];
  let total = 0;
  for (const file of files) {
    if (used.length >= MAX_FILES || total >= MAX_TOTAL) break;
    let text;
    try {
      const full = path.join(folder, file.name);
      if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; } // ya no existe
    if (text.includes('\0')) continue; // binario
    if (scanText(text, file.name).length) { skipped.push(file.name); continue; }
    const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL - total);
    const cut = text.length > room ? `${text.slice(0, room)}\n[… recortado: ${text.length - room} caracteres más]` : text;
    parts.push(`=== ${file.name} (${file.lines ?? '?'} líneas, ${file.edits} cambios recientes) ===\n${cut}`);
    used.push(file.name);
    total += cut.length;
  }
  return { text: parts.join('\n\n'), used, skipped, size: total };
}

function prompt({ signals, text }) {
  return [
    `ClaudHome ha detectado estas señales en el proyecto: ${signals.join('; ')}.`,
    '',
    'Estos son los archivos que más han cambiado últimamente (pueden estar recortados):',
    '',
    text || '(no se ha podido leer ninguno)',
    '',
    '¿Conviene ahora una limpieza y optimización que no cambie lo que hace? Recomiéndala solo si ves problemas claros que la justifiquen: código repetido, funciones o archivos demasiado largos o que hacen varias cosas, código sin uso, valores o estilos repetidos a mano. Si el código está razonablemente limpio, no la recomiendes aunque haya muchos cambios o muchas líneas.',
    '',
    'Responde solo con este JSON: {"recomendar": true o false, "motivo": "una sola frase en español, de 25 palabras como mucho, para el usuario y sin tecnicismos, que nombre el archivo y el problema principal"}',
  ].join('\n');
}

// Lo que contesta Claude Code (--output-format json): { recommend, reason } o null si no se entiende.
function verdict(stdout) {
  let result;
  try { result = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!result || result.is_error || typeof result.result !== 'string') return null;
  const text = result.result;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let answer;
  try { answer = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  if (!answer || typeof answer.recomendar !== 'boolean') return null;
  return { recommend: answer.recomendar, reason: shortReason(answer.motivo) };
}

// El motivo, para enseñarlo: una línea, la primera frase y, si aun así es larga, recortado
// por una palabra entera.
function shortReason(text) {
  let reason = String(text || '').replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const first = /^(.{20,}?[.!?])\s/.exec(reason);
  if (first) reason = first[1];
  if (reason.length > MAX_REASON) reason = `${reason.slice(0, MAX_REASON).replace(/[\s,;:]+\S*$/, '')}…`;
  return reason;
}

// Cómo lanzar Claude Code: un .cmd (instalación con npm) va a través de cmd.exe.
function command(exe, args) {
  if (!/\.(cmd|bat)$/i.test(exe)) return { file: exe, args, verbatim: false };
  const q = (arg) => (arg === '' ? '""' : /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[exe, ...args].map(q).join(' ')}"`], verbatim: true };
}
const ARGS = ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
  '--setting-sources', '', '--system-prompt', SYSTEM, '--output-format', 'json'];

// findClaude(): ruta de claude · env: entorno sin las marcas de la sesión · workDir(): carpeta
// vacía donde se lanza · args: los de Claude Code (las pruebas usan otros).
function createChecker({ findClaude, env = () => process.env, workDir, log = () => {}, timeout = TIMEOUT, run = null, args = ARGS }) {
  const running = new Set();
  // Lanza la orden con `input` por la entrada estándar: { code, stdout } (code null si se cortó).
  const spawnRun = ({ file, args, verbatim }, input) => new Promise((resolve) => {
    let child;
    try {
      const cwd = workDir();
      fs.mkdirSync(cwd, { recursive: true });
      child = spawn(file, args, { cwd, env: env(), windowsHide: true, windowsVerbatimArguments: verbatim });
    } catch { resolve({ code: null, stdout: '' }); return; }
    running.add(child);
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ya ha terminado */ } }, timeout);
    child.stdout.on('data', (d) => { if (stdout.length < 200000) stdout += d; });
    child.stderr.on('data', () => { /* sin uso */ });
    child.on('error', () => { clearTimeout(timer); running.delete(child); resolve({ code: null, stdout: '' }); });
    child.on('close', (code) => { clearTimeout(timer); running.delete(child); resolve({ code, stdout }); });
    child.stdin.on('error', () => { /* se cerró antes de tiempo */ });
    child.stdin.end(input);
  });
  const exec = run || spawnRun;

  // { recommend, reason, files } o { error } si no ha podido decidir.
  async function check({ folder, files, signals }) {
    const exe = findClaude();
    if (!exe) return { error: 'no se encuentra claude' };
    const shown = material(folder, files);
    if (!shown.used.length) return { error: shown.skipped.length ? 'los archivos llevan claves' : 'no hay archivos que leer' };
    const started = Date.now();
    const { code, stdout } = await exec(command(exe, args), prompt({ signals, text: shown.text }));
    const answer = code === 0 ? verdict(stdout) : null;
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!answer) {
      log(`Optimiza: Haiku no ha podido decidir (${code === null ? 'cortado o sin arrancar' : `salida ${code}`}, ${seconds} s)`);
      return { error: 'sin respuesta', files: shown.used, size: shown.size };
    }
    log(`Optimiza: Haiku ${answer.recommend ? 'lo recomienda' : 'no lo ve necesario'} (${shown.used.length} archivos, ${seconds} s)${answer.reason ? `: ${answer.reason}` : ''}`);
    return { ...answer, files: shown.used, size: shown.size };
  }
  // Al cerrar la app, lo que esté en marcha se corta.
  const stop = () => { for (const child of running) { try { child.kill(); } catch { /* ya ha terminado */ } } running.clear(); };
  return { check, stop };
}

module.exports = { createChecker, material, prompt, verdict, shortReason, command, ARGS };
