// Buena práctica para cualquier proyecto: pasar las pruebas antes de dar por terminado un
// cambio de código, y no darlo por terminado en silencio si fallan.
//
// Cuando Claude termina un turno en el que ha cambiado código (Edit, Write, MultiEdit o
// NotebookEdit sobre un archivo de código, con éxito), la app lo retiene en el hook Stop
// (decision «block») en dos casos, cada uno una vez por turno y nunca en el de cerrar la
// sesión:
//   1. El proyecto de ese archivo tiene pruebas y la app no ha visto que las pase después
//      de su último cambio: se le pide que las pase.
//   2. La última vez que las pasó terminaron con error: se le pide que lo corrija o que le
//      cuente al usuario con claridad qué falla. Si aun así el turno acaba con las pruebas
//      sin pasar, se avisa al usuario en la interfaz (failing()).
//
// - Cada cambio se asocia al proyecto de pruebas de su archivo: la carpeta más cercana hacia
//   arriba con pruebas, sin salir del proyecto (la carpeta de la pestaña o la que tiene
//   .git). En un monorepo, probar el frontend no da por probado el backend.
// - Se busca en segundo plano al editar, sin bloquear la app, con límite de tiempo y de
//   tamaño. Ante la duda (no se ha resuelto a tiempo, un disco de red lento), no se pide.
// - «Ha pasado las pruebas» = ha ejecutado con Bash o PowerShell una orden de pruebas en
//   ese proyecto después del cambio. Se trocea la línea respetando comillas y se miran el
//   ejecutable y sus argumentos: «pip install pytest», un commit que diga «npm test» o
//   «pytest --collect-only» no cuentan. Tampoco lo que puede no haberse ejecutado
//   («lint || npm test»).
// - Si han pasado o han fallado se sabe por cómo termina la orden (Claude Code lo dice) y,
//   cuando eso no lo aclara («npm test | tail», «npm test; git status»), por el resumen
//   que escriben las herramientas de pruebas («1 failed»). Ante la duda, no se da por
//   fallado.
// - Unas pruebas lanzadas en segundo plano cuentan como pasadas: Claude Code avisa a Claude
//   cuando terminan (la app no ve ese aviso), y si luego corrige algo, se le vuelve a pedir.
// - Como el aviso de archivos que crecen, no ve lo que Claude cambia con comandos.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EDIT_TOOLS, CODE } = require('./growth');

const fsp = fs.promises;
const WRAPUP_START = 'Voy a cerrar esta sesión ahora.'; // principio de lo que se escribe al cerrar
const MAX_FILE = 256 * 1024; // manifiestos más grandes no se leen
const FIND_DEADLINE = 3000; // ms para encontrar el proyecto de pruebas de un archivo
const FOUND_MS = 5 * 60 * 1000; // lo que dura en caché un proyecto con pruebas
const NONE_MS = 60 * 1000; // y uno sin ellas (pueden añadirse)
const SLOW_MS = 2 * 60 * 1000; // sin buscar en un disco que no ha respondido a tiempo
const MAX_UP = 12; // carpetas hacia arriba dentro del proyecto
const MAX_UP_OUTSIDE = 4; // y fuera de la carpeta de la pestaña
const MAX_LISTED = 25; // proyectos que se nombran en un recordatorio
const MAX_LOG = 400; // cambios y pruebas que se recuerdan de un turno
const BOM = String.fromCharCode(0xfeff);
const isCode = (file) => CODE.test(file) || /\.html?$/i.test(file);
const key = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
const baseName = (file) => String(file || '').split(/[\\/]/).pop();
// ¿Está `child` dentro de la carpeta `parent`? (`orEqual`: o es ella misma.)
function isInside(child, parent, orEqual = false) {
  const c = key(child);
  let p = key(parent);
  if (c === p) return orEqual;
  if (!p.endsWith(path.sep)) p += path.sep;
  return c.startsWith(p);
}

// ── ¿Es una orden de pruebas? ──────────────────────────────────────

// Trocea una línea en órdenes: [{ text, op, background }]. `op` es lo que une cada orden a
// la anterior ('' la primera; ';' también para el salto de línea; '&&', '||' o '|') y
// `background`, si acaba en «&» (Bash). No parte lo que va entre comillas (con sus escapes:
// \" en Bash, `" en PowerShell) ni el texto de un «here-document» (<<EOF … EOF) o de un
// bloque de PowerShell (@' … '@): el mensaje de un commit no es una orden.
// shell: 'bash', 'powershell' o 'cmd'.
function splitCommands(command, shell = 'bash') {
  const out = [];
  const esc = shell === 'powershell' ? '`' : shell === 'bash' ? '\\' : null;
  let current = '';
  let quote = null;
  let op = ''; // lo que une la orden en curso a la anterior
  const cut = (next, background = false) => {
    // Sin nada escrito no hay orden: tras «&&» puede venir un salto de línea, y sigue siendo «&&».
    if (current.trim()) { out.push({ text: current.trim(), op, background }); op = next; }
    current = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    // Bloques de texto: se saltan enteros, estén o no entre comillas.
    if (ch === '<' && next === '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(command.slice(i, i + 80));
      if (m) {
        const end = new RegExp(`\\n[ \\t]*${m[2]}[ \\t]*(?=\\r?\\n|$)`).exec(command.slice(i));
        if (end) { i += end.index + end[0].length - 1; current += ' '; continue; }
      }
    }
    if (!quote && ch === '@' && (next === "'" || next === '"') && /\r?\n/.test(command.slice(i + 2, i + 4))) {
      const close = command.indexOf(`\n${next}@`, i + 2);
      if (close >= 0) { i = close + 2; current += ' x '; continue; }
    }
    // Un carácter escapado no abre ni cierra comillas ni separa órdenes; al final de la
    // línea, la continúa. (Entre comillas simples no hay escapes.)
    if (esc && ch === esc && next !== undefined && quote !== "'") {
      if (next === '\n' || (next === '\r' && command[i + 2] === '\n')) { current += ' '; i += next === '\r' ? 2 : 1; } else { current += ch + next; i += 1; }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    // Un comentario («orden # luego: npm test») llega hasta el final de la línea.
    if (ch === '#' && shell !== 'cmd' && (i === 0 || /\s/.test(command[i - 1]))) {
      const end = command.indexOf('\n', i);
      i = (end < 0 ? command.length : end) - 1;
      continue;
    }
    if (ch === '\n' || ch === ';') { cut(';'); continue; }
    if (ch === '&' && next === '&') { cut('&&'); i += 1; continue; }
    if (ch === '|' && next === '|') { cut('||'); i += 1; continue; }
    if (ch === '|') { cut('|'); if (next === '&') i += 1; continue; }
    // Un «&» suelto: en Bash deja la orden en segundo plano; en cmd, separa. (En PowerShell
    // es el operador de llamada; «2>&1» y «&>archivo» son redirecciones.)
    if (ch === '&' && shell !== 'powershell' && command[i - 1] !== '>' && command[i - 1] !== '<' && next !== '>') {
      cut(';', shell === 'bash');
      continue;
    }
    current += ch;
  }
  cut(';');
  return out;
}

// Las palabras de una orden: sin comillas, y sin los paréntesis o llaves de un subproceso.
const RAW = /"(?:[\\`][\s\S]|[^"\\`])*"|'[^']*'|\S+/g;
const isQuoted = (token) => /^["']/.test(token);
const rawTokens = (segment) => segment.match(RAW) || [];
const unwrap = (token) => (isQuoted(token) ? token.replace(/^["']|["']$/g, '') : token.replace(/^[({]+/, '').replace(/[)}]+$/, ''));
const tokens = (segment) => rawTokens(segment).map(unwrap).filter(Boolean);
const exeName = (token) => baseName(token).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');

const RUNNERS = new Set(['jest', 'vitest', 'mocha', 'ava', 'tap', 'jasmine']);
const isRunner = (words) => {
  if (!words.length) return false;
  const exe = exeName(words[0]);
  return RUNNERS.has(exe) || (exe === 'playwright' && words[1] === 'test') || (exe === 'cypress' && words[1] === 'run');
};
const isTestScript = (name) => /^test(:|$)/.test(name || '');
const DIR_FLAGS = new Set(['--prefix', '-C', '--cwd', '--dir']); // cambian la carpeta de la orden
const VALUE_FLAGS = new Set([...DIR_FLAGS, '-w', '--workspace', '--filter', '-F', '-n', '--name', '-p', '--project', '--python', '--with', '-t', '--target', '--targets', '-e', '--scope', '--projects']);
const PNPM_VALUE_FLAGS = new Set([...VALUE_FLAGS].filter((flag) => flag !== '-w')); // en pnpm, -w no lleva valor
const WRAPPERS = new Set(['sudo', 'doas', 'time', 'nice', 'nohup', 'winpty', 'command', 'exec', 'env', 'call', 'cross-env', 'xvfb-run', 'stdbuf', 'unbuffer']);
const RUN_WRAPPERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'dotenv', 'conda', 'micromamba', 'pixi', 'bundle']);
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh']);
const MONOREPO = new Set(['turbo', 'nx', 'lerna']); // lanzan las pruebas de los paquetes de un monorepo

// Lo que hace que una orden de pruebas no ejecute ninguna: ayuda, versión, listados…
const NO_RUN = new Set(['--help', '--version', '--collect-only', '--co', '--list-tests', '--listtests', '--list', '--dry-run', '--no-run', '--showconfig',
  '--show-only', '--fixtures', '--markers', '--setup-plan', '--setup-only', '--clearcache', '--init', '--listenvs', '--listenvs-all', '--just-print', '--recon', '-?', '/?']);
const NO_RUN_BY_EXE = {
  pytest: ['-h', '-V'], 'py.test': ['-h', '-V'], jest: ['-h'], vitest: ['-h'], mocha: ['-h'], phpunit: ['-h'], rspec: ['-h'], ctest: ['-N'], make: ['-n'],
  tox: ['-l', '-a'], nox: ['-l'], go: ['-list', '-c'], dotnet: ['-t', '-h'], gradle: ['-m'], gradlew: ['-m'],
};
function noRun(exe, args) {
  const own = NO_RUN_BY_EXE[exe] || [];
  return args.some((arg) => { const name = arg.split('=')[0]; return NO_RUN.has(name.toLowerCase()) || own.includes(name); });
}

// Argumentos sin opciones: { pos, dir, flags, values, first }. `first` es dónde empieza el
// primero; `values(…opciones)`, los valores dados a esas opciones. Lo que va tras «--» es
// para el programa, no cuenta.
function positionals(args, valueFlags = VALUE_FLAGS) {
  const pos = [];
  const flags = new Set();
  const given = [];
  let dir = '';
  let first = args.length;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const flag = eq > 0 ? a.slice(0, eq) : a;
      flags.add(flag);
      const value = eq > 0 ? a.slice(eq + 1) : valueFlags.has(flag) ? (args[i + 1] || '') : null;
      if (value !== null) given.push([flag, value]);
      if (DIR_FLAGS.has(flag)) dir = value || '';
      if (eq < 0 && valueFlags.has(flag)) i += 1;
      continue;
    }
    if (!pos.length) first = i;
    pos.push(a);
  }
  const values = (...names) => given.filter(([flag, value]) => names.includes(flag) && value).flatMap(([, value]) => value.split(','));
  return { pos, dir, flags, values, first };
}

// Para nombrar una orden de pruebas en los avisos: el ejecutable y, como mucho, dos palabras
// sencillas («npm test», «npm run test:unit»). Nunca sus argumentos ni las variables que
// lleve delante: pueden ser claves, y el aviso va al registro y a una notificación.
// (Tampoco cualquier palabra suelta: en «npm test --token abc», «abc» es el valor de una opción.)
const SAFE_WORD = /^(?:test(?::[\w:.-]{1,24})?|t|tst|run|run-script|exec|x|dlx|verify|install|package|deploy|integration-test|check|build|spec|nextest|clean|affected|run-many|manage\.py|artisan)$/;
const labelOf = (exe, words) => [exe, ...words.filter((word) => SAFE_WORD.test(word)).slice(0, 2)].join(' ');

// Si las palabras son una orden que pasa pruebas: { dir, scope, select, label } con la
// carpeta que fija la propia orden ('' si no fija ninguna) y lo que prueba —'exact', el
// proyecto de esa carpeta; 'under', paquetes de dentro (un «workspace»): todos, o los que
// nombra `select`; 'tree', las dos cosas—. Si lanza otra línea de órdenes (bash -c "…"),
// { nested: [pruebas de esa línea] }. Si no, null.
function testSegment(words, shell = 'bash', depth = 0) {
  if (!words.length || depth > 3) return null;
  const exe = exeName(words[0]);
  const args = words.slice(1);
  const { pos, dir, flags, values, first } = positionals(args, exe === 'pnpm' ? PNPM_VALUE_FLAGS : VALUE_FLAGS);
  const dry = noRun(exe, args);
  const yes = (ok, scope = 'exact', select = null) => (ok && !dry ? { dir, scope, select, label: labelOf(exe, pos) } : null);
  const again = (rest) => testSegment(rest, shell, depth + 1);
  // Lo que encuentra otra orden a la que esta llama, con la carpeta y el alcance de esta.
  const through = (rest, scope = 'exact', select = null) => {
    const found = again(rest);
    if (!found || found.nested) return found;
    const outer = found.scope === 'exact';
    return { ...found, dir: found.dir || dir, scope: outer ? scope : found.scope, select: outer ? select : found.select, label: `${exe} ${found.label}` };
  };
  // Lo que solo envuelve a otra orden.
  if (WRAPPERS.has(exe)) {
    let rest = args;
    while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(rest[0]))) rest = rest.slice(1);
    return again(rest);
  }
  if (exe === 'timeout') { // timeout [opciones] 60 orden…
    let rest = args;
    while (rest.length && (rest[0].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(rest[0]))) rest = rest.slice(1);
    return again(rest);
  }
  if (exe === 'dotenv' && args.includes('--')) return again(args.slice(args.indexOf('--') + 1));
  if (RUN_WRAPPERS.has(exe) && ['run', 'exec'].includes(pos[0])) {
    // Lo que va detrás de «run», sin las opciones del envoltorio pero con las de la orden.
    let rest = args.slice(args.indexOf(pos[0]) + 1);
    while (rest.length && rest[0].startsWith('-')) rest = rest.slice(VALUE_FLAGS.has(rest[0]) ? 2 : 1);
    return exe === 'hatch' && isTestScript(rest[0]) ? yes(true) : again(rest);
  }
  if (SHELLS.has(exe)) {
    const at = args.findIndex((a) => /^(-c|-lc|-ic|-command|\/c|\/k)$/i.test(a));
    if (at < 0) return null;
    const inner = exe === 'cmd' ? 'cmd' : exe === 'powershell' || exe === 'pwsh' ? 'powershell' : 'bash';
    const nested = testRuns(args.slice(at + 1).join(' '), { shell: inner, depth: depth + 1 });
    return nested.length ? { nested } : null;
  }
  if (isRunner(words)) return yes(!(exe === 'vitest' && ['list', 'init'].includes(pos[0])));
  switch (exe) {
    case 'npm': {
      const all = flags.has('--workspaces') || flags.has('-ws');
      const named = values('-w', '--workspace');
      const scope = !all && !named.length ? 'exact' : flags.has('--include-workspace-root') || flags.has('-iwr') ? 'tree' : 'under';
      const select = all || !named.length ? null : named;
      if (pos[0] === 'exec' || pos[0] === 'x') return through(args.includes('--') ? args.slice(args.indexOf('--') + 1) : args.slice(first + 1), scope, select);
      return yes(pos[0] === 'test' || pos[0] === 't' || pos[0] === 'tst' || (['run', 'run-script'].includes(pos[0]) && isTestScript(pos[1])), scope, select);
    }
    case 'pnpm': case 'yarn': case 'bun': {
      const named = values('--filter', '-F');
      let scope = flags.has('-r') || flags.has('--recursive') || named.length ? 'under' : 'exact';
      let select = named.length ? named : null;
      let rest = pos;
      if (rest[0] === 'workspace') { scope = 'under'; select = [rest[1] || '']; rest = rest.slice(2); } // yarn workspace <paquete> test
      if (rest[0] === 'workspaces') { scope = 'under'; select = null; rest = rest.slice(rest[1] === 'foreach' ? 2 : 1); } // yarn workspaces foreach run test
      if (['exec', 'dlx', 'x'].includes(rest[0])) return through(args.slice(args.indexOf(rest[0]) + 1), scope, select);
      if (rest[0] === 'run') rest = rest.slice(1);
      if (isTestScript(rest[0]) || isRunner(rest)) return yes(true, scope, select);
      return rest.length && MONOREPO.has(exeName(rest[0])) ? through(args.slice(args.indexOf(rest[0])), scope, select) : null; // yarn turbo run test
    }
    case 'npx': case 'bunx': case 'pnpx': return through(args.slice(first));
    case 'turbo': {
      const named = values('--filter', '-F');
      return yes(isTestScript(pos[0]) || (pos[0] === 'run' && pos.slice(1).some(isTestScript)), named.length ? 'under' : 'tree', named.length ? named : null);
    }
    case 'nx': {
      const targets = args.flatMap((a, i) => (/^(-t|--targets?)$/.test(a) ? [args[i + 1] || ''] : /^--targets?=/.test(a) ? [a.slice(a.indexOf('=') + 1)] : [])).join(',').split(',');
      // nx test web · nx run web:test · nx run-many -t test --projects=web,api
      const named = isTestScript(pos[0]) && pos[1] ? [pos[1]] : pos[0] === 'run' ? [(pos[1] || '').split(':')[0]] : values('--projects', '-p');
      return yes(isTestScript(pos[0]) || pos[0] === 'affected:test' || (pos[0] === 'run' && /:test(:|$)/.test(pos[1] || ''))
        || (['run-many', 'affected'].includes(pos[0]) && targets.some(isTestScript)), named.length ? 'under' : 'tree', named.length ? named : null);
    }
    case 'lerna': {
      const named = values('--scope');
      return yes(pos[0] === 'test' || (pos[0] === 'run' && isTestScript(pos[1])), 'under', named.length ? named : null);
    }
    case 'node':
      return yes(args.includes('--test') || args.some((a, i) => a === '--run' && isTestScript(args[i + 1]))
        || args.some((a) => /(^|[\\/])(jest|vitest|mocha)(\.[cm]?js)?$/i.test(a)));
    case 'pytest': case 'py.test': case 'tox': case 'nox': case 'ctest': case 'phpunit': case 'rspec': return yes(true);
    case 'invoke-pester': { // sin -CI termina «bien» aunque fallen pruebas: lo dice su resumen
      const found = yes(true);
      return found && { ...found, weakExit: true };
    }
    case 'go': case 'deno': case 'dotnet': case 'swift': case 'mix': case 'flutter': case 'dart': case 'rails': case 'composer': case 'hatch':
      return yes(pos[0] === 'test');
    case 'rake': return yes(pos[0] === 'test' || pos[0] === 'spec');
    case 'php': return yes(/(^|[\\/])artisan$/.test(pos[0] || '') && pos[1] === 'test');
    case 'cargo': return yes(['test', 't', 'nextest'].includes(pos[0]));
    case 'mvn': case 'mvnw':
      if (args.some((a) => /^-D(skipTests|maven\.test\.skip)(=true)?$/i.test(a))) return null;
      return yes(pos.some((a) => ['test', 'verify', 'install', 'package', 'deploy', 'integration-test'].includes(a)));
    case 'gradle': case 'gradlew':
      if (args.some((a, i) => a === '-x' && /(^|:)test$/.test(args[i + 1] || ''))) return null;
      return yes(pos.some((a) => /^(?::?[\w-]+:)*(?:test|check|build)$/.test(a)));
    case 'make': return yes(pos.some((a) => a === 'test' || a === 'check'));
    default:
      if (/^python(\d+(\.\d+)?)?$/.test(exe) || exe === 'py') {
        const m = args.indexOf('-m');
        if (m >= 0) {
          const found = yes(['pytest', 'unittest', 'tox', 'nox'].includes(args[m + 1]) && !noRun(args[m + 1], args));
          return found && { ...found, label: `${exe} -m ${args[m + 1]}` };
        }
        return yes(/(^|[\\/])manage\.py$/.test(pos[0] || '') && pos[1] === 'test'); // Django
      }
      return null;
  }
}

// En Windows, Git Bash escribe las rutas de disco como /c/proyecto (o /mnt/c, /cygdrive/c).
function nativeDir(dir, shell, platform = process.platform) {
  if (platform !== 'win32' || shell !== 'bash' || !dir) return dir;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(dir);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').split('/').join('\\')}` : dir;
}
// «~» y las variables de la carpeta personal, al principio de una ruta.
const expandHome = (dir) => dir.replace(/^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i, () => os.homedir());

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'push-location', 'sl']);
const KEYWORDS = new Set(['do', 'then', 'else', 'if', 'elif', 'while', 'until', '!']); // «for …; do npm test; done»
const CLOSERS = new Set(['done', 'fi', 'esac']);
const BRANCHES = new Set(['then', 'else', 'elif', 'do']); // lo que va detrás puede no ejecutarse
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr']); // terminan con error si no encuentran nada
// Órdenes de PowerShell que no cambian el código de salida (el de la última orden nativa).
const PS_BUILTIN = new Set(['echo', 'select', 'sort', 'where', 'foreach', 'tee', 'measure', 'ft', 'fl', 'cd', 'sl', 'pwd', 'ls', 'dir', 'cat', 'type', 'gc', 'popd', 'pushd', 'chdir', '%', '?']);
const isCmdlet = (words) => !words.length || /^\$/.test(words[0]) || /^[a-z]+-[a-z]+$/i.test(words[0]) || PS_BUILTIN.has(words[0].toLowerCase());

// Lo que el código de salida de la línea dice de la orden `i`:
//   cond  'always' se ejecuta siempre · 'and' si lo anterior va bien («a && pruebas») ·
//         'or' solo si lo anterior falla («a || pruebas») · 'maybe' va en una rama o un
//         bucle («if …; then pruebas; fi»): puede no ejecutarse
//   exit  'own' el código de la línea es el suyo · 'and' lo es si la línea va bien («pruebas
//         && b») · 'pipe' va por una tubería al final («pruebas | tail»: un fallo de la
//         línea es suyo, un éxito no dice nada) · 'hidden' no dice nada de ella
function exitInfo(segs, i, shell) {
  let start = i;
  while (start > 0 && segs[start].op !== ';') start -= 1;
  let end = i;
  while (end + 1 < segs.length && segs[end + 1].op !== ';') end += 1;
  const before = segs.slice(start + 1, i + 1).map((s) => s.op);
  const after = segs.slice(i + 1, end + 1).map((s) => s.op);
  const cond = before.includes('||') ? 'or' : before.includes('&&') ? 'and' : 'always';
  const piped = after[0] === '|';
  const tail = after.includes('||') ? 'or' : after.includes('&&') ? 'and' : 'end';
  let last = i; // la última orden de su tubería: es la que lleva el «&»
  while (last + 1 < segs.length && segs[last + 1].op === '|') last += 1;
  // Lo que solo cierra un bucle o una condición («done», «fi») no cambia el código de salida.
  let lastReal = segs.length - 1;
  while (lastReal > i && (!segs[lastReal].words.length || CLOSERS.has(segs[lastReal].words.join(' ')))) lastReal -= 1;
  let exit;
  if (shell === 'powershell') {
    // PowerShell da el código de la última orden nativa, vaya o no por una tubería.
    exit = tail === 'or' || segs.slice(i + 1).some((s) => !isCmdlet(s.words)) ? 'hidden' : tail === 'and' ? 'and' : 'own';
  } else if (end < lastReal) exit = 'hidden'; // después van otras órdenes
  else if (piped) exit = tail === 'end' && !SEARCHERS.has(exeName(segs[last].words[0] || '')) ? 'pipe' : 'hidden';
  else exit = tail === 'end' ? 'own' : tail === 'and' ? 'and' : 'hidden';
  return { cond, exit, background: segs[last].background };
}
// Lo mismo para unas pruebas que van dentro de otra línea (bash -c "…").
function mergeExit(outer, inner) {
  const conds = [outer.cond, inner.cond];
  const cond = ['or', 'maybe', 'and'].find((c) => conds.includes(c)) || 'always';
  let exit = 'hidden';
  if (outer.exit === 'own') exit = inner.exit;
  else if (outer.exit === 'and' && (inner.exit === 'own' || inner.exit === 'and')) exit = 'and';
  else if (outer.exit === 'pipe' && (inner.exit === 'own' || inner.exit === 'pipe')) exit = 'pipe';
  return { cond, exit, background: outer.background || inner.background };
}

// Las pruebas que pasa una línea de órdenes: [{ dir, scope, select, cond, exit, background,
// text }]. `dir` es la carpeta (relativa a la de trabajo, o absoluta; '' si es la de
// trabajo); `text`, cómo nombrarlas en un aviso (sin argumentos).
function testRuns(command, { shell = 'bash', depth = 0 } = {}) {
  if (typeof command !== 'string' || !command.trim() || depth > 3) return [];
  const segs = splitCommands(command, shell).map((seg) => ({ ...seg, raw: rawTokens(seg.text), words: tokens(seg.text) }));
  const runs = [];
  let cd = '';
  let before = ''; // la carpeta anterior, para «cd -»
  const scopes = []; // la carpeta al abrir cada subproceso «( … )»
  const pushed = []; // y al hacer cada pushd
  segs.forEach((seg, i) => {
    const head = seg.raw[0] || '';
    const foot = seg.raw[seg.raw.length - 1] || '';
    const opens = isQuoted(head) ? 0 : (/^\(+/.exec(head) || [''])[0].length;
    const closes = isQuoted(foot) ? 0 : (/\)+$/.exec(foot) || [''])[0].length;
    for (let n = 0; n < opens; n += 1) scopes.push(cd);
    let words = seg.words;
    // Lo que va delante de la orden: «& npm.cmd …», VAR=x, y las palabras de un bucle o una condición.
    let branch = false;
    while (words.length && (words[0] === '&' || /^\$?[A-Za-z_][\w:]*=/.test(words[0]) || KEYWORDS.has(words[0]))) {
      if (BRANCHES.has(words[0])) branch = true;
      words = words.slice(1);
    }
    const exe = words.length ? exeName(words[0]) : '';
    if (CD.has(exe)) {
      if (exe === 'pushd' || exe === 'push-location') pushed.push(cd);
      let to = words.slice(1).find((w) => !w.startsWith('-') && !/^\/[a-z]$/i.test(w)) || ''; // sin opciones ni el «/d» de cmd
      if (words[1] === '-') [cd, before] = [before, cd];
      else if (to) {
        to = nativeDir(expandHome(to), shell);
        before = cd;
        cd = path.isAbsolute(to) ? to : path.join(cd, to);
      }
    } else if (exe === 'popd' || exe === 'pop-location') {
      if (pushed.length) cd = pushed.pop();
    } else if (exe) {
      const found = testSegment(words, shell, depth);
      if (found) {
        const info = exitInfo(segs, i, shell);
        if (branch && info.cond !== 'or') info.cond = 'maybe';
        if (found.weakExit && info.exit === 'own') info.exit = 'pipe'; // un fallo es suyo; un éxito no dice nada
        const place = (dir) => { const d = nativeDir(expandHome(dir || ''), shell); return d && !path.isAbsolute(d) ? path.join(cd, d) : (d || cd); };
        if (found.nested) for (const run of found.nested) runs.push({ ...run, ...mergeExit(info, run), dir: place(run.dir) });
        else runs.push({ ...info, dir: place(found.dir), scope: found.scope, select: found.select || null, text: found.label });
      }
    }
    // Al cerrar un subproceso, la carpeta vuelve a ser la de antes.
    for (let n = 0; n < closes && scopes.length; n += 1) cd = scopes.pop();
  });
  return runs;
}
// La carpeta en la que una línea pasa pruebas (la primera, si pasa varias), o null.
const testInvocation = (command, options) => { const runs = testRuns(command, options); return runs.length ? runs[0].dir : null; };
const isTestCommand = (command, options) => testRuns(command, options).length > 0;

// El resumen con el que las herramientas de pruebas dicen que algo ha fallado. Y, por si
// de la salida solo queda el final («| tail -12»), el detalle de una comprobación fallida.
const FAIL_OUTPUT = [
  /\bAssertionError\b/, /^\s*code: 'ERR_(?:ASSERTION|TEST_FAILURE)'/m, /^\s+at .*\(node:internal\/test_runner\//m, /^\s*(?:operator: '\w+'|generatedMessage: (?:true|false)|diff: 'simple'),?\s*$/m,
  /^\s*(?:ℹ|#) fail [1-9]\d*\s*$/m, /^✖ failing tests:/m, /^\s*✖ .+\(\d+(?:\.\d+)?ms\)\s*$/m, /^\s*not ok \d+(?!.*#\s*(?:TODO|SKIP))/im, // node --test, TAP
  /^\s*Tests?(?: Suites| Files)?:?\s+(?:.*\D)?[1-9]\d* failed\b/m, // jest, vitest
  /^\s*[1-9]\d* failing\b/m, // mocha
  /^(?:=+ )?(?:.*, )?[1-9]\d* (?:failed|errors?)\b.* in [\d.]+s/m, // pytest
  /^FAILED \((?:failures|errors)=\d+/m, // unittest
  /^(?:--- FAIL:|FAIL\s|FAIL$)/m, // go test (y los archivos de jest)
  /^test result: FAILED\./m, /^error: test failed/m, /^error: could not compile/m, // cargo
  /^(?:Failed!|Con error!)\s+-\s/m, /^Build FAILED\./m, // dotnet
  /^\[ERROR\] Tests run:.*(?:Failures|Errors): [1-9]/m, /^\[INFO\] BUILD FAILURE/m, /^BUILD FAILED\b/m, // Maven, Gradle
  /^(?:FAILURES|ERRORS)!\s*$/m, // PHPUnit
  /^\d+ examples?, [1-9]\d* failures?\b/m, // RSpec
  /^Tests Passed: \d+, Failed: [1-9]/m, // Pester
  /^make(?:\[\d+\])?: \*\*\* /m, // make
  /^npm (?:ERR!|error) (?:Test failed|Lifecycle script .?test\S*.? failed)/m, // npm
];

// Cómo han ido unas pruebas, por cómo ha terminado su línea: 'passed', 'failed', 'launched'
// (en segundo plano: aún no se sabe) o null si no se puede decir ni que se hayan ejecutado.
// failed: la línea terminó con error; output: el final de lo que escribió.
// partial: no se tiene lo que escribió (el aviso era demasiado grande).
function outcome(run, { failed = false, output = '', interrupted = false, background = false, partial = false } = {}) {
  if (interrupted) return null;
  if (background || run.background) return failed ? null : 'launched'; // si falla al lanzarlas, no se han lanzado
  if (run.cond === 'or') return failed && run.exit === 'own' ? 'failed' : null; // «a || pruebas»: si a va bien, no se ejecutan
  const bad = () => !partial && FAIL_OUTPUT.some((re) => re.test(output || ''));
  const clear = failed ? run.exit === 'own' || run.exit === 'pipe' : run.exit === 'own' || run.exit === 'and'; // ¿lo dice el código de salida?
  // En una rama o un bucle solo se sabe que se han ejecutado si la línea falla por ellas o se ve su resumen.
  if (run.cond === 'maybe') return (failed && clear) || bad() ? 'failed' : null;
  if (clear) return failed ? 'failed' : 'passed';
  if (bad()) return 'failed';
  if (partial) return null; // sin su salida no se puede decir
  return failed && run.exit !== 'hidden' ? null : 'passed'; // «pruebas && b» que falla: no se sabe cuál de las dos
}

// ── ¿Tiene pruebas esta carpeta? ───────────────────────────────────
// ctl: { until, expired } — el plazo de quien busca. Agotado, no se lee nada más.
function live(ctl) {
  if (!ctl) return true;
  if (!ctl.expired && Date.now() > ctl.until) ctl.expired = true;
  return !ctl.expired;
}
async function readSmall(file, ctl) {
  if (!live(ctl)) return null;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_FILE || !live(ctl)) return null;
    const text = await fsp.readFile(file, 'utf8');
    return text.startsWith(BOM) ? text.slice(1) : text;
  } catch { return null; }
}
const exists = async (file, ctl) => { if (!live(ctl)) return false; try { await fsp.access(file); return true; } catch { return false; } };
const list = async (dir, ctl) => { if (!live(ctl)) return []; try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } };
const win = process.platform === 'win32';
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'bin', 'obj']);

// ¿Hay en la carpeta (hasta `depth` niveles, mirando como mucho `budget` entradas) algún
// archivo cuyo nombre cumpla `match`?
async function hasFile(dir, match, depth, ctl, budget = { left: 400 }) {
  const entries = await list(dir, ctl);
  const dirs = [];
  for (const entry of entries) {
    if ((budget.left -= 1) < 0) return false;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase())) dirs.push(entry.name); } else if (match.test(entry.name)) return true;
  }
  if (depth <= 0) return false;
  for (const name of dirs) if (await hasFile(path.join(dir, name), match, depth - 1, ctl, budget)) return true;
  return false;
}

const PY_TEST = /^test_.*\.py$|_test\.py$/;
const PESTER = /\.Tests\.ps1$/i;

// El comando de pruebas de una carpeta: { command, why, dir } o null.
async function detectTests(dir, ctl) {
  if (typeof dir !== 'string' || !dir) return null;
  const at = (name) => path.join(dir, name);
  const found = (command, why) => ({ command, why, dir });
  const top = await list(dir, ctl);
  if (!top.length) return null;
  const names = new Map(top.map((e) => [e.name.toLowerCase(), e.name])); // sin distinguir mayúsculas
  const has = (name) => names.has(name.toLowerCase());
  const files = top.filter((e) => !e.isDirectory()).map((e) => e.name);
  if (has('package.json')) {
    try {
      const pkg = JSON.parse((await readSmall(at(names.get('package.json')), ctl)) || '{}') || {};
      const test = (pkg.scripts || {}).test;
      // El que pone npm por defecto («no test specified») no es una prueba.
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
        // Con el gestor de paquetes que declare el proyecto, o el de su archivo de bloqueo.
        const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0].trim().toLowerCase() : '';
        const manager = ['yarn', 'pnpm', 'bun'].includes(declared) ? declared
          : has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
        return found(manager === 'bun' ? 'bun run test' : `${manager} test`, 'package.json');
      }
    } catch { /* package.json dañado: se sigue buscando */ }
  }
  const small = async (name) => (has(name) ? (await readSmall(at(names.get(name.toLowerCase())), ctl)) || '' : '');
  const [pyproject, setupCfg, tox] = await Promise.all([small('pyproject.toml'), small('setup.cfg'), small('tox.ini')]);
  if (has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(pyproject) || /\[tool:pytest\]/.test(setupCfg) || /^\[pytest\]/m.test(tox)) {
    return found('pytest', 'configuración de pytest');
  }
  if (has('tox.ini')) return found('tox', 'tox.ini');
  if (files.some((f) => PY_TEST.test(f))) return found('pytest', 'pruebas de Python');
  // Carpetas de pruebas (tests, test, Tests…), también con subcarpetas (tests/unit/…).
  const testDirs = top.filter((e) => e.isDirectory() && /^tests?$/i.test(e.name)).map((e) => e.name);
  for (const sub of testDirs) if (await hasFile(at(sub), PY_TEST, 2, ctl)) return found('pytest', `pruebas de Python en ${sub}/`);
  // Go: solo si hay algún archivo de pruebas (un go.mod solo no dice que las haya).
  if (has('go.mod') && (files.some((f) => /_test\.go$/.test(f)) || await hasFile(dir, /_test\.go$/, 3, ctl))) return found('go test ./...', 'go.mod');
  if (has('Cargo.toml')) return found('cargo test', 'Cargo.toml');
  // .NET, Maven y Gradle: solo si hay pruebas de verdad (un proyecto de pruebas o src/test).
  // (App.Tests, App.UnitTests, tests/…: «Tests» con mayúscula o como palabra aparte.)
  const dotnetTests = (e) => (e.isDirectory() || /\.csproj$/i.test(e.name)) && /(?:^|[._-])tests?(\.csproj)?$|Tests?(\.csproj)?$/.test(e.name);
  if (files.some((f) => /\.(sln|csproj)$/i.test(f)) && top.some(dotnetTests)) {
    return found('dotnet test', 'proyecto de pruebas de .NET');
  }
  const javaTests = (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) && await exists(at(path.join('src', 'test')), ctl);
  if (has('pom.xml') && javaTests) {
    const wrapper = win && has('mvnw.cmd') ? '.\\mvnw.cmd' : has('mvnw') ? './mvnw' : 'mvn';
    return found(`${wrapper} test`, 'pom.xml');
  }
  if ((has('build.gradle') || has('build.gradle.kts')) && javaTests) {
    const wrapper = win && has('gradlew.bat') ? '.\\gradlew.bat' : has('gradlew') ? './gradlew' : 'gradle';
    return found(`${wrapper} test`, 'Gradle');
  }
  const makefile = await small('Makefile');
  if (/^(?:test|check)\s*:/m.test(makefile)) return found(/^test\s*:/m.test(makefile) ? 'make test' : 'make check', 'Makefile');
  if (has('phpunit.xml') || has('phpunit.xml.dist')) return found('vendor/bin/phpunit', 'phpunit.xml');
  // PowerShell: las pruebas de Pester pueden ir en tests/ o junto a los scripts.
  if (files.some((f) => PESTER.test(f))) return found('Invoke-Pester', 'pruebas de PowerShell (Pester)');
  for (const sub of testDirs) if (await hasFile(at(sub), PESTER, 2, ctl)) return found('Invoke-Pester', 'pruebas de PowerShell (Pester)');
  if (files.some((f) => /\.ps[md]?1$/i.test(f)) && await hasFile(dir, PESTER, 2, ctl)) return found('Invoke-Pester', 'pruebas de PowerShell (Pester)');
  return null;
}

// ── El proyecto de pruebas de un archivo ───────────────────────────
// La carpeta del archivo o la más cercana hacia arriba con pruebas, sin salir del proyecto:
// no se pasa de `stopDir` (la carpeta de la pestaña), de la que tiene .git ni de `maxUp`
// niveles, y la carpeta personal o la raíz del disco no cuentan como proyecto. Con caché
// (que se vacía al tocar un manifiesto o una prueba) y con plazo.
const cache = new Map(); // carpeta → { until, promise }
const slow = new Map(); // disco o recurso de red → hasta cuándo no se busca en él
const TEST_DIR = /^(tests?|__tests__|specs?)$/i;
function cachedDetect(dir, ctl) {
  const k = key(dir);
  const hit = cache.get(k);
  if (hit && Date.now() < hit.until) return hit.promise;
  const entry = { until: Date.now() + NONE_MS, promise: null };
  entry.promise = detectTests(dir, ctl).then((found) => {
    if (found) entry.until = Date.now() + FOUND_MS;
    else if (ctl && ctl.expired && cache.get(k) === entry) cache.delete(k); // a medias: no vale como «no tiene»
    return found;
  }, () => null);
  cache.set(k, entry);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return entry.promise;
}
// Lo que se sabía de la carpeta de un archivo y de las de encima deja de valer.
function forget(file) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 5; i += 1) {
    cache.delete(key(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
// Archivos que cambian si un proyecto tiene pruebas o cuáles son.
const AFFECTS_TESTS = /^(package\.json|pyproject\.toml|setup\.cfg|pytest\.ini|conftest\.py|tox\.ini|go\.mod|cargo\.toml|pom\.xml|build\.gradle(\.kts)?|makefile|phpunit\.xml(\.dist)?)$|\.(sln|csproj)$|^test_.*\.py$|_test\.(py|go)$|\.tests\.ps1$/i;

async function findTestRoot(startDir, stopDir, { maxUp = MAX_UP, home = os.homedir(), deadline = FIND_DEADLINE } = {}) {
  const start = path.resolve(startDir);
  const volume = key(path.parse(start).root);
  if ((slow.get(volume) || 0) > Date.now()) return null; // ese disco no respondió hace poco
  const stop = stopDir ? key(stopDir) : null;
  const ctl = { until: Date.now() + deadline, expired: false };
  const search = (async () => {
    // 1. Las carpetas del archivo hacia arriba, hasta el límite de su proyecto.
    const chain = [];
    for (let dir = start, i = 0; i <= maxUp; i += 1) {
      const parent = path.dirname(dir);
      const atStop = stop !== null && key(dir) === stop;
      // La carpeta personal y la raíz del disco no son «el proyecto» de un archivo suelto.
      if (!atStop && (parent === dir || key(dir) === key(home))) break;
      chain.push(dir);
      if (atStop || parent === dir || await exists(path.join(dir, '.git'), ctl)) break;
      if (!live(ctl)) return null;
      dir = parent;
    }
    // 2. Dentro de una carpeta de pruebas (tests/, test/unit/…), el proyecto es el que la
    //    contiene: no se toma tests/ como un proyecto aparte. La última de la cadena es el
    //    límite (la carpeta de la pestaña o un repositorio), se llame como se llame.
    let from = 0;
    for (let i = 0; i < chain.length - 1; i += 1) if (TEST_DIR.test(path.basename(chain[i]))) from = i + 1;
    for (let i = from; i < chain.length; i += 1) {
      if (!live(ctl)) return null;
      const found = await cachedDetect(chain[i], ctl);
      if (found) return found;
    }
    return null;
  })();
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, deadline, undefined); });
  try {
    const result = await Promise.race([search, late]);
    if (result === undefined || ctl.expired) { // plazo agotado: lo que quede a medias ya no lee más
      ctl.expired = true;
      slow.set(volume, Date.now() + SLOW_MS);
      return null;
    }
    return result;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ¿Nombra alguno de los selectores de un «workspace» («web», «packages/web», «@acme/web»,
// «./web…») al proyecto de esa carpeta? Se compara con su ruta dentro de `baseDir` y con el
// nombre de su carpeta. Si no se reconoce, no: unas pruebas de «web» no dan por probado «api».
function selects(select, projectDir, baseDir) {
  const rel = path.relative(key(baseDir), key(projectDir)).split(path.sep).join('/').toLowerCase();
  return select.some((raw) => {
    const name = String(raw).toLowerCase().split('\\').join('/').replace(/^[.{^]+\/?/, '').replace(/[.}^]+$/, '').replace(/\/+$/, '');
    if (!name || name.startsWith('!')) return false;
    return rel === name || rel.endsWith(`/${name}`) || rel.split('/').pop() === name.split('/').pop();
  });
}

// Para los mensajes: sin saltos de línea ni comillas inversas, y sin pasarse de largo.
const plain = (text, max = 200) => String(text).replace(/[`\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createTestReminder({ tabs, log = () => {}, home = os.homedir() }) {
  const name = (tabId) => (tabs.label ? tabs.label(tabId) : tabId);

  // Empieza un turno: sin cambios pendientes de probar.
  function turnStarted(tabId, prompt) {
    const tab = tabs.ensure(tabId);
    tab.testsLog = []; // en orden: { seq, kind: 'edit', file, dir, root } o { seq, kind: 'test', result, scope, dir, covers, command, root }
    tab.testsSeq = 0;
    tab.testsWork = []; // búsquedas en marcha
    tab.testsLaunch = new Map(); // orden de Bash o PowerShell en marcha → por dónde iba el turno al lanzarla
    tab.testsEdited = false; // ¿ha cambiado código en este turno?
    tab.testsAsked = false; // ¿se le ha retenido ya en este turno? (lo mira la revisión de Codex)
    tab.testsReminded = false; // …para pedirle que las pase
    tab.testsFailTold = false; // …porque han fallado
    tab.testsAnswer = null;
    tab.testsSkip = typeof prompt === 'string' && prompt.startsWith(WRAPUP_START.slice(0, 30));
  }
  function ready(tab) {
    if (!tab.testsLog) { tab.testsLog = []; tab.testsSeq = 0; tab.testsWork = []; }
    if (!tab.testsLaunch) tab.testsLaunch = new Map();
  }

  // Busca en segundo plano el proyecto de pruebas de una anotación (root: undefined mientras).
  function look(tab, item) {
    const turn = (item.look = (item.look || 0) + 1); // si se vuelve a buscar, la búsqueda anterior ya no vale
    item.root = undefined;
    const inside = Boolean(tab.folder) && isInside(item.dir, tab.folder, true);
    const options = { home, maxUp: inside ? MAX_UP : MAX_UP_OUTSIDE };
    const work = findTestRoot(item.dir, inside ? tab.folder : null, options)
      .then((found) => { if (item.look === turn) item.root = found; }, () => { if (item.look === turn) item.root = null; });
    tab.testsWork.push(work);
    work.then(() => { tab.testsWork = (tab.testsWork || []).filter((w) => w !== work); });
  }

  // Apunta un cambio o unas pruebas.
  function note(tab, entry) {
    ready(tab);
    const item = { ...entry, seq: (tab.testsSeq += 1), root: null };
    tab.testsLog.push(item);
    if (tab.testsLog.length > MAX_LOG) compact(tab);
    if (item.kind === 'edit' || item.scope !== 'under') look(tab, item); // «under» prueba lo de dentro: no hay proyecto propio que buscar
  }
  // Si el turno apunta demasiado, se quita lo que ya no cambia nada: de cada carpeta basta su
  // último cambio, y de cada orden de pruebas, su último resultado. (Solo si aun así no cabe
  // se pierde lo más antiguo.)
  function compact(tab) {
    const seen = new Set();
    const kept = [];
    for (let i = tab.testsLog.length - 1; i >= 0; i -= 1) {
      const item = tab.testsLog[i];
      const id = item.kind === 'edit' ? `e:${key(item.dir)}` : `t:${item.scope}:${key(item.dir)}:${(item.select || []).join(',')}`;
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(item);
    }
    tab.testsLog = kept.reverse().slice(-MAX_LOG);
  }

  // Antes de una orden de Bash o PowerShell: por dónde va el turno. Unas pruebas solo dan
  // por probado lo que se había cambiado al lanzarlas, no lo que se cambie mientras corren.
  function toolStarting(tabId, toolName, toolUseId) {
    if ((toolName !== 'Bash' && toolName !== 'PowerShell') || typeof toolUseId !== 'string' || !toolUseId) return;
    const tab = tabs.ensure(tabId);
    ready(tab);
    tab.testsLaunch.set(toolUseId, tab.testsSeq);
    if (tab.testsLaunch.size > 100) tab.testsLaunch.delete(tab.testsLaunch.keys().next().value);
  }

  // Tras cada herramienta. cwd: la carpeta de trabajo de ese momento; failed: si la
  // herramienta ha fallado (una edición que falla no cambia nada; una orden de pruebas que
  // falla, sí dice algo); background: si se ha dejado en segundo plano; shell: de una orden,
  // { command (entera), output (el final de lo que ha escrito), interrupted }.
  function toolUsed(tabId, toolName, input, { cwd = null, failed = false, background = false, shell = null, toolUseId = null } = {}) {
    const tab = tabs.ensure(tabId);
    ready(tab);
    const launched = toolUseId ? tab.testsLaunch.get(toolUseId) : undefined;
    if (toolUseId) tab.testsLaunch.delete(toolUseId);
    const base = cwd || tab.folder;
    if (!base || !input) return;
    if (EDIT_TOOLS.has(toolName)) {
      const file = input.file;
      if (failed || typeof file !== 'string' || !file) return;
      const full = path.resolve(base, file);
      if (AFFECTS_TESTS.test(baseName(full))) {
        // Puede haber cambiado qué pruebas hay: se olvida lo sabido y se vuelve a mirar lo ya apuntado.
        forget(full);
        for (const item of tab.testsLog) if (item.kind === 'edit' || item.scope !== 'under') look(tab, item);
      }
      if (isCode(file)) { // documentos y datos no cuentan
        tab.testsEdited = true;
        note(tab, { kind: 'edit', file: full, dir: path.dirname(full) });
      }
    } else if (toolName === 'Bash' || toolName === 'PowerShell') {
      const command = shell && typeof shell.command === 'string' && shell.command ? shell.command : input.command;
      const covers = launched === undefined ? tab.testsSeq : launched;
      for (const run of testRuns(command, { shell: toolName === 'PowerShell' ? 'powershell' : 'bash' })) {
        const result = outcome(run, {
          failed, background, output: shell ? shell.output : '', interrupted: Boolean(shell && shell.interrupted), partial: Boolean(shell && shell.partial),
        });
        if (result) note(tab, { kind: 'test', result, scope: run.scope, select: run.select, dir: path.resolve(base, run.dir || '.'), covers, command: run.text });
      }
    }
  }

  // Cómo está el turno: { unsure, run, bad }. run: proyectos con cambios y sin pruebas
  // pasadas después; bad: aquellos cuyas últimas pruebas han fallado; unsure: aún no se
  // sabe qué proyecto han probado unas pruebas (no se puede decidir).
  function status(tab) {
    const state = new Map(); // proyecto → { root, file, editSeq, needsRun, failing, judged, command }
    const get = (k, root) => {
      if (!state.has(k)) state.set(k, { root, file: null, editSeq: 0, needsRun: false, failing: false, judged: -1, command: '' });
      return state.get(k);
    };
    let unsure = false;
    for (const item of tab.testsLog || []) {
      if (item.kind === 'edit') {
        if (!item.root) continue; // sin proyecto de pruebas, o aún buscándolo
        Object.assign(get(key(item.root.dir), item.root), { root: item.root, file: item.file, editSeq: item.seq, needsRun: true });
        continue;
      }
      if (item.root === undefined) { unsure = true; continue; }
      const failed = item.result === 'failed';
      // Lo que prueban: su proyecto y, si es de un «workspace» o en esa carpeta no hay
      // proyecto de pruebas propio, los que haya dentro de ella (todos, o los que nombre).
      const under = item.scope === 'under';
      const ownDir = item.root ? item.root.dir : item.dir;
      const own = under ? `under:${key(item.dir)}:${(item.select || []).join(',')}` : key(ownDir);
      const targets = new Set(state.has(own) || (failed && !under) ? [own] : []);
      if (item.scope !== 'exact' || !item.root) {
        for (const k of state.keys()) {
          if (!k.startsWith('under:') && isInside(k, item.dir) && (!item.select || selects(item.select, k, item.dir))) targets.add(k);
        }
      }
      if (!under) {
        // Las de un proyecto también resuelven el fallo apuntado a un «workspace» que lo incluye.
        for (const [k, s] of state) {
          if (s.under && isInside(ownDir, s.under.dir) && (!s.under.select || selects(s.under.select, ownDir, s.under.dir))) targets.add(k);
        }
      } else if (failed && !targets.size) {
        // Unas de «workspace» que fallan sin que se sepa de qué proyecto son: se apuntan aparte.
        get(own, null).under = { dir: item.dir, select: item.select };
        targets.add(own);
      }
      for (const k of targets) {
        const s = get(k, item.scope === 'under' ? null : item.root);
        if (s.editSeq <= item.covers) s.needsRun = false; // lo cambiado hasta lanzarlas está probado
        // El resultado de unas pruebas lanzadas antes que las del último veredicto no lo cambia.
        if (item.covers >= s.judged) {
          s.judged = item.covers;
          s.failing = failed;
          if (failed) s.command = item.command;
        }
      }
    }
    const all = [...state.values()];
    return { unsure, run: all.filter((s) => s.needsRun && s.root), bad: all.filter((s) => s.failing) };
  }
  // Las órdenes de pruebas que han fallado, para nombrarlas.
  const failedCommands = (bad) => [...new Set(bad.map((s) => plain(s.command, 80)).filter(Boolean))].slice(0, 3).join(', ');

  // ¿Hay que retenerlo en este Stop? Se decide al llegar el aviso, sin esperar.
  function willAsk(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.testsSkip) return false;
    const now = status(tab);
    if (now.unsure) return false;
    if (now.run.length && !tab.testsReminded) {
      tab.testsReminded = true;
      tab.testsAnswer = { kind: 'run', list: now.run };
    } else if (now.bad.length && tab.testsEdited && !tab.testsFailTold) {
      tab.testsFailTold = true;
      tab.testsAnswer = { kind: 'failing', list: now.bad };
    } else return false;
    tab.testsAsked = true;
    return true;
  }

  // Si el turno se para con las pruebas sin pasar (y ya se le dijo a Claude), con qué
  // orden: para avisar al usuario. Si no, null.
  function failing(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.testsSkip || !tab.testsEdited) return null;
    const now = status(tab);
    if (now.unsure || !now.bad.length) return null;
    const commands = failedCommands(now.bad);
    log(`buenas prácticas: ${name(tabId)} se para con las pruebas sin pasar (${commands})`);
    return commands;
  }

  // La respuesta al hook Stop (si willAsk dijo que sí), o null.
  function answer(tabId) {
    const tab = tabs.get(tabId);
    const todo = tab && tab.testsAnswer;
    if (!todo || !todo.list.length) return null;
    tab.testsAnswer = null;
    if (todo.kind === 'failing') {
      const commands = failedCommands(todo.list);
      log(`buenas prácticas: ${name(tabId)} iba a terminar con las pruebas fallando (${commands}): se le avisa`);
      return {
        decision: 'block',
        reason: [
          `ClaudHome · buenas prácticas: la última vez que has pasado las pruebas en este turno (\`${commands}\`) han terminado con error, y vas a dar el trabajo por terminado.`,
          'Si fallan por tus cambios, corrígelos y vuelve a pasarlas hasta que pasen. Si fallan por algo que ya fallaba, que no es tuyo o que no puedes resolver, no lo arregles por tu cuenta: dile al usuario con claridad qué pruebas fallan y por qué.',
          'Si en realidad han pasado (la app solo ve cómo termina la orden y el resumen que escribe), dilo en una frase y termina.',
          'Este aviso no se repetirá en este turno.',
        ].join(' '),
      };
    }
    const where = (r) => {
      const rel = tab.folder ? path.relative(tab.folder, r.dir) : r.dir;
      if (!rel) return '';
      return ` en ${plain(rel.startsWith('..') || path.isAbsolute(rel) ? r.dir : rel)}`;
    };
    const runs = todo.list.slice(0, MAX_LISTED).map((p) => `\`${p.root.command}\`${where(p.root)}, por ${p.root.why}`);
    if (todo.list.length > MAX_LISTED) runs.push(`y ${todo.list.length - MAX_LISTED} proyectos más con pruebas, que también tienes que pasar`);
    log(`buenas prácticas: ${name(tabId)} cambió código sin pasar las pruebas (${todo.list.slice(0, MAX_LISTED).map((p) => p.root.command).join(', ')}): se le recuerda`);
    const edited = todo.list[0].file ? ` (por ejemplo, ${plain(baseName(todo.list[0].file))})` : '';
    const before = todo.list.some((p) => p.failing) ? ' (la última vez que las pasaste terminaron con error)' : '';
    return {
      decision: 'block',
      reason: [
        `ClaudHome · buenas prácticas: en este turno has cambiado código${edited} y el proyecto tiene pruebas (${runs.join('; ')}), pero la app no ha visto que las pases después de tu último cambio${before}. Pásalas ahora.`,
        'Si fallan por tus cambios, corrígelos y vuelve a pasarlas. Si fallan por algo que ya fallaba o que no es tuyo, no lo arregles por tu cuenta: cuéntaselo al usuario.',
        'Si ya las has pasado después de ese cambio de una forma que la app no ve (dentro de un contenedor, con un guion propio, desde otra carpeta) o si tu cambio no puede afectar a nada de lo que prueban (por ejemplo, solo comentarios o textos), dilo en una frase y termina sin pasarlas.',
        'Este recordatorio no se repetirá en este turno.',
      ].join(' '),
    };
  }

  // Para las pruebas: espera a que terminen las búsquedas en marcha.
  const settled = (tabId) => Promise.all(((tabs.get(tabId) || {}).testsWork || []).slice());

  return { turnStarted, toolStarting, toolUsed, willAsk, answer, failing, settled };
}

module.exports = { createTestReminder, detectTests, findTestRoot, isTestCommand, testInvocation, testRuns, outcome, splitCommands, nativeDir };
