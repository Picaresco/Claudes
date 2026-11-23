// ¿Pasa pruebas una línea de órdenes de Bash o PowerShell, en qué carpeta y cómo han ido?
// Lo usa «pruebas antes de terminar» (testcheck.js). Es puro: no lee el disco.
//
// - Se trocea la línea respetando comillas, escapes, comentarios, «here-documents» y
//   bloques de PowerShell, y de cada orden se miran el ejecutable y sus argumentos:
//   «pip install pytest», un commit que diga «npm test» o «pytest --collect-only» no
//   cuentan. Tampoco lo que puede no haberse ejecutado («lint || npm test»).
// - Si han pasado o han fallado se sabe por cómo termina la orden (Claude Code lo dice) y,
//   cuando eso no lo aclara («npm test | tail», «npm test; git status»), por el resumen
//   que escriben las herramientas de pruebas («1 failed»). Ante la duda, no se da por
//   fallado.
const os = require('os');
const path = require('path');

const baseName = (file) => String(file || '').split(/[\\/]/).pop();
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

module.exports = { splitCommands, testRuns, testInvocation, isTestCommand, outcome, nativeDir, baseName };
