// Consolas disponibles y entorno con el que se lanzan los procesos de las pestañas.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Variables que una sesión de Claude Code pone a sus procesos hijos. Si Claudes
// se lanza desde dentro de una, no deben heredarse a las sesiones de las pestañas.
const SESSION_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'AI_AGENT', 'ELECTRON_RUN_AS_NODE',
];

// Git Bash: donde lo deja su instalador o junto al git.exe del PATH (Git\cmd\git.exe → Git\bin\bash.exe).
const gitBash = [
  process.env.CLAUDE_CODE_GIT_BASH_PATH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ...String(process.env.PATH || '').split(';').filter((dir) => dir && fs.existsSync(path.join(dir, 'git.exe')))
    .map((dir) => path.join(dir, '..', 'bin', 'bash.exe')),
].find((p) => p && fs.existsSync(p)) || null;

// Las consolas que se pueden elegir para la terminal extra.
function shellList() {
  const list = [
    { key: 'powershell', name: 'PowerShell' },
    { key: 'cmd', name: 'Símbolo del sistema (cmd)' },
  ];
  if (gitBash) list.push({ key: 'gitbash', name: 'Git Bash' });
  return list;
}

function shellCommand(kind) {
  if (kind === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [], env: {} };
  if (kind === 'gitbash' && gitBash) return { file: gitBash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } };
  return { file: 'powershell.exe', args: ['-NoLogo'], env: {} };
}

// Entorno de un proceso de una pestaña: el de la app, sin las marcas de sesión.
function childEnv(extra) {
  const env = { ...process.env };
  for (const name of SESSION_MARKERS) delete env[name];
  return { ...env, COLORTERM: 'truecolor', TERM_PROGRAM: 'Claudes', ...extra };
}

// Un argumento entre comillas si cmd.exe lo necesita.
function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

module.exports = { gitBash, shellList, shellCommand, childEnv, quoteForCmd, SESSION_MARKERS };
