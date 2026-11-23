// Botón «Optimiza»: Claude revisa todo el proyecto y lo mejora sin cambiar lo que hace
// (limpieza, orden, eficiencia y coherencia visual), de forma autónoma y con red de
// seguridad: en una rama aparte de git, midiendo antes y después, con las pruebas tras
// cada cambio y una revisión independiente al final. El usuario solo confirma al empezar
// y, al terminar, decide si une la rama.
//
// La interfaz escribe en la sesión una petición corta (OPTIMIZE_START…) y la app añade las
// instrucciones completas con el hook UserPromptSubmit: así el usuario ve una línea y Claude
// recibe el método entero. Solo si se ha confirmado con el botón hace poco (arm → consume).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localStamp } = require('./applog');

// Principio de la petición que escribe la interfaz (OPTIMIZE_PROMPT en ui/constants.js).
const OPTIMIZE_START = 'Optimiza este proyecto';
const ARM_MS = 2 * 60 * 1000; // la confirmación vale para la siguiente petición de esa pestaña, si llega a tiempo
const GIT_MS = 8000;

// git, aunque no esté en el PATH de la app (la instalación de Git for Windows lo deja junto a
// su bash).
function gitExe(gitBash) {
  if (gitBash) {
    const near = path.join(path.dirname(path.dirname(gitBash)), 'cmd', 'git.exe');
    if (fs.existsSync(near)) return near;
  }
  return 'git';
}
function runGit(exe, args, cwd) {
  return new Promise((resolve) => {
    execFile(exe, args, { cwd, timeout: GIT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || ''), missing: Boolean(err && err.code === 'ENOENT') });
    });
  });
}

// Cómo está el proyecto antes de empezar: { ok, git, dirty, branch } o { ok: false, error }.
async function checkProject(folder, { gitBash = null } = {}) {
  let isDir = false;
  try { isDir = Boolean(folder) && fs.statSync(folder).isDirectory(); } catch { /* no existe */ }
  if (!isDir) return { ok: false, error: 'La carpeta de este proyecto ya no existe.' };
  const exe = gitExe(gitBash);
  const inside = await runGit(exe, ['rev-parse', '--is-inside-work-tree'], folder);
  if (inside.missing) {
    return { ok: false, error: 'Optimiza necesita git para trabajar en una rama aparte y que puedas deshacerlo todo. Instala Git for Windows (git-scm.com) y vuelve a pulsarlo.' };
  }
  if (!inside.ok || inside.out.trim() !== 'true') return { ok: true, git: false, dirty: false, branch: null };
  const [status, head] = await Promise.all([
    runGit(exe, ['status', '--porcelain'], folder),
    runGit(exe, ['rev-parse', '--abbrev-ref', 'HEAD'], folder),
  ]);
  const branch = head.ok ? head.out.trim() : '';
  return { ok: true, git: true, dirty: status.ok ? status.out.trim() !== '' : true, branch: branch && branch !== 'HEAD' ? branch : null };
}

// Las instrucciones para Claude. git/dirty/branch: cómo estaba el proyecto al confirmar.
function instructions({ git = true, dirty = false, branch = null, stamp = localStamp() } = {}) {
  const name = `optimiza-${stamp}`;
  const from = branch ? `la rama «${branch}»` : 'la rama en la que estás';
  const start = !git
    ? [
      '- Este proyecto no usa git. Antes de nada, actívalo: `git init`, un `.gitignore` razonable si no lo hay (sin dependencias, compilados, registros ni archivos con claves como `.env`) y un commit con el estado actual, «Estado antes de optimizar».',
      `- Después crea la rama \`${name}\` y trabaja en ella.`,
    ]
    : [
      `- Crea la rama \`${name}\` desde ${from} y trabaja solo en ella. No toques la rama original, no hagas push ni publiques nada.`,
      ...(dirty ? ['- Hay cambios sin confirmar del usuario: llévalos a la rama nueva y guárdalos tal cual en un primer commit, «Punto de partida: cambios sin confirmar». No los modifiques.'] : []),
    ];
  return [
    'ClaudHome · botón «Optimiza»: el usuario te pide que revises todo este proyecto y lo mejores sin cambiar lo que hace (limpieza, orden, eficiencia y coherencia visual). Trabaja de forma autónoma: no le preguntes nada hasta el informe final, salvo un permiso. Sigue este método:',
    '',
    '0. Red de seguridad',
    ...start,
    '- Mide y apunta el punto de partida: pruebas que pasan, lint, build, tamaño del paquete o de la descarga, tiempo de arranque si aplica y líneas por archivo.',
    '- Si lo que vas a tocar no tiene pruebas, escríbelas antes para fijar cómo funciona hoy. Sin red de seguridad, no se toca.',
    '',
    '1. Mide y elige',
    '- Busca código y estilos sin uso, funciones repetidas, archivos grandes o que hacen varias cosas, dependencias sin usar, lentitudes, tamaño del paquete e incoherencias visuales (colores y tamaños escritos a mano).',
    '- Elige lo de más impacto y menos riesgo. Si hay mucho, prioriza y deja el resto anotado en el informe.',
    '',
    '2. Pasos pequeños',
    '- Un commit por mejora. Tras cada uno: pruebas, lint y build. Si algo falla y no lo arreglas a la primera, deshaz ese paso y sigue con otro.',
    '- Prohibido: cambiar el comportamiento o la interfaz pública, añadir dependencias, borrar datos o configuración, tocar claves, ejecutar nada contra sistemas reales (producción, red, dispositivos).',
    '',
    '3. Demuestra la mejora',
    '- Repite las mediciones del paso 0: solo se queda lo que mejora algo sin empeorar nada.',
    '- Si es una aplicación, ejecuta la versión anterior y la nueva y compara lo que hacen.',
    '- Pide una revisión independiente del diff completo: con la herramienta `segunda_opinion` (Codex, ámbito código) si la tienes y responde; si no, con un subagente revisor. Corrige lo que sea un fallo real.',
    '',
    '4. Informe para el usuario (en lenguaje sencillo)',
    '- Una tabla antes/después con las mediciones, qué has cambiado, qué has descartado y por qué, y los riesgos que queden.',
    `- Deja el proyecto en la rama \`${name}\` y explícale cómo probarla, cómo unirla y cómo volver atrás (\`git switch ${branch || '<rama anterior>'}\`). No la unas tú.`,
  ].join('\n');
}

// Lo confirmado con el botón, por pestaña: se usa con la siguiente petición «Optimiza…».
function createOptimizer({ tabs, log = () => {}, now = () => Date.now() }) {
  function arm(tabId, project) {
    tabs.ensure(tabId).optimize = { at: now(), project };
  }
  // Las instrucciones para añadir a esta petición, o null.
  function consume(tabId, prompt) {
    const tab = tabs.get(tabId);
    const armed = tab && tab.optimize;
    if (!armed || typeof prompt !== 'string' || !prompt.startsWith(OPTIMIZE_START)) return null;
    tab.optimize = null;
    if (now() - armed.at > ARM_MS) return null;
    const { git, dirty, branch } = armed.project || {};
    log(`Optimiza: ${tabs.label ? tabs.label(tabId) : tabId} empieza (git: ${git ? 'sí' : 'no, se activa'}${dirty ? ', con cambios sin confirmar' : ''})`);
    return instructions({ git, dirty, branch });
  }
  return { arm, consume };
}

module.exports = { OPTIMIZE_START, checkProject, instructions, createOptimizer };
