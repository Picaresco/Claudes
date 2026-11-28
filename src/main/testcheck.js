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
//   ese proyecto después del cambio. Qué es una orden de pruebas y cómo ha ido lo decide
//   testcommands.js.
// - Unas pruebas lanzadas en segundo plano cuentan como pasadas: Claude Code avisa a Claude
//   cuando terminan (la app no ve ese aviso), y si luego corrige algo, se le vuelve a pedir.
// - Como el aviso de archivos que crecen, no ve lo que Claude cambia con comandos.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EDIT_TOOLS, isCode } = require('./growth');
const { splitCommands, testRuns, testInvocation, isTestCommand, outcome, nativeDir, baseName } = require('./testcommands');

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
const key = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
// ¿Está `child` dentro de la carpeta `parent`? (`orEqual`: o es ella misma.)
function isInside(child, parent, orEqual = false) {
  const c = key(child);
  let p = key(parent);
  if (c === p) return orEqual;
  if (!p.endsWith(path.sep)) p += path.sep;
  return c.startsWith(p);
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
  // Cómo han quedado las pruebas de este turno (la pasada final de SuperPowers lo enseña con lo
  // visto, no con lo que diga Claude): 'ok' (pasadas después del último cambio), 'failing',
  // 'pending' (cambios sin pruebas después), 'none' (no se han pasado ni hacía falta) o 'unknown'.
  function verdict(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.testsLog) return 'unknown';
    const now = status(tab);
    if (now.unsure) return 'unknown';
    if (now.bad.length) return 'failing';
    if (now.run.length) return 'pending';
    return tab.testsLog.some((item) => item.kind === 'test') ? 'ok' : 'none';
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

  return { turnStarted, toolStarting, toolUsed, willAsk, answer, failing, verdict, settled };
}

module.exports = { createTestReminder, detectTests, findTestRoot, isTestCommand, testInvocation, testRuns, outcome, splitCommands, nativeDir };
