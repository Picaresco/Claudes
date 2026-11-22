// Aviso de claves y contraseñas escritas en los archivos (src/main/secrets.js).
// Las claves de prueba se montan al ejecutar, para que este archivo no contenga ninguna
// (si no, el propio aviso saltaría al editarlo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Secrets, scanText, isEnvFile, findGit, splitDiff, reviewInput, decodeText } = require('../src/main/secrets');
const { tempDir } = require('./helpers');

const rnd = (n, set = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tV1wX0yZ') => Array.from({ length: n }, (_, i) => set[(i * 7 + 3) % set.length]).join('');
const KEYS = {
  anthropic: `${'sk-'}ant-api03-${rnd(40)}`,
  openai: `${'sk-'}proj-${rnd(40)}`,
  github: `${'ghp'}_${rnd(36)}`,
  aws: `${'AK'}IA${rnd(16, 'ABCDEFGHJK23456789')}`,
};
const PASSWORD = `${'Hosp'}ital2024!`;

test('reconoce los formatos habituales de claves y contraseñas', () => {
  const cases = [
    [`const k = "${KEYS.anthropic}";`, 'a.js', /Anthropic/],
    [`OPENAI_API_KEY=${KEYS.openai}`, '.env', /OpenAI/],
    [`token: ${KEYS.github}`, 'a.js', /GitHub/],
    [`aws_access_key_id = ${KEYS.aws}`, 'a.py', /AWS/],
    [`${'-----BEGIN '}RSA PRIVATE KEY-----\n${rnd(64)}\n${rnd(64, 'QwErTy12345')}`, 'id_rsa', /clave privada/],
    [`const password = "Pa$$w0rd${rnd(4)}";`, 'a.js', /escrita en el código/], // un $ de verdad no es una plantilla
    [`const url = "postgres://admin:${PASSWORD.slice(0, -1)}@10.0.0.5/db";`, 'a.js', /dirección de conexión/],
    [`const password = "${PASSWORD}";`, 'a.js', /escrita en el código/],
    [`{ "db_password": "${PASSWORD}" }`, 'a.json', /escrita en el código/],
    [`$env:API_KEY=${rnd(12)}`, 'a.ps1', /escrita en el código/],
    [`db:\n  password: ${rnd(10)}`, 'config.yml', /configuración/],
  ];
  for (const [text, file, kind] of cases) {
    const found = scanText(text, file);
    assert.equal(found.length, 1, text);
    assert.match(found[0].kind, kind);
    assert.equal(typeof found[0].fp, 'string');
    assert.ok(!JSON.stringify(found).includes(text.slice(-8)), 'nunca devuelve el valor');
  }
  assert.equal(scanText(`uno\ndos\nconst password = "${PASSWORD}";`, 'a.js')[0].line, 3);
  // Dos claves privadas distintas tienen huellas distintas (no la de la cabecera).
  const pem = (body) => `${'-----BEGIN '}PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  assert.notEqual(scanText(pem(rnd(64)), 'k')[0].fp, scanText(pem(rnd(64, 'QwErTy12345')), 'k')[0].fp);
  assert.deepEqual(scanText(`${'-----BEGIN '}RSA PRIVATE KEY-----\nMIIE...`, 'k'), []); // un ejemplo sin clave
});

test('una línea enorme no deja la app colgada', () => {
  for (const text of ['a'.repeat(2 * 1024 * 1024), 'a.b-c_'.repeat(300000), `password${'_'.repeat(1024 * 1024)}`, 'var a=1,b="x";'.repeat(140000)]) {
    const start = Date.now();
    scanText(text, 'a.js');
    assert.ok(Date.now() - start < 1500, `${Date.now() - start} ms`);
  }
});

test('no confunde ejemplos, variables ni código con claves', () => {
  for (const text of [
    'OPENAI_API_KEY=YOUR_API_KEY',
    'const password = process.env.DB_PASSWORD;',
    'DB_PASSWORD=${DB_PASSWORD}',
    'tokenType: "Bearer"',
    'password_label: "Introduce tu contraseña"',
    'class="sk-navigation-menu-item-active"',
    'token = response.json()',
    'api_key = settings.API_KEY',
    `const k = "${'sk-'}ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx";`,
    'TOKEN_TTL=3600',
    'apiKey: config.apiKey,',
    'const password = "ejemplo123";',
    'mongodb://user:<password>@host/db',
    'const password = "${DB_PASSWORD}";',
    'DB_PASSWORD=%DB_PASSWORD%',
    `db:\n  password: ${rnd(10)}`, // YAML, pero en un .js: no es configuración
  ]) {
    assert.deepEqual(scanText(text, 'a.js'), [], text);
  }
  assert.deepEqual(scanText(`\0${KEYS.openai}`, 'a.bin'), []); // binario
  assert.equal(isEnvFile('C:/p/.env'), true);
  assert.equal(isEnvFile('C:/p/.env.production'), true);
  assert.equal(isEnvFile('C:/p/.env.example'), false);
  assert.equal(isEnvFile('C:/p/env.js'), false);
});

function makeSecrets(t) {
  const saved = {};
  const logs = [];
  const secrets = new Secrets({ store: { get: (k, f) => (k in saved ? saved[k] : f), set: (k, v) => { saved[k] = v; } }, log: (text) => logs.push(text) });
  const cwd = tempDir(t);
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text); };
  return { secrets, cwd, write, saved, logs };
}

test('avisa a Claude una vez por clave y archivo, sin repetir la clave', async (t) => {
  const { secrets, cwd, write, saved } = makeSecrets(t);
  write('src/config.js', `module.exports = {\n  key: "${KEYS.anthropic}",\n};\n`);
  const notice = await secrets.edited(cwd, 'src/config.js');
  assert.match(notice, /buenas prácticas/);
  assert.match(notice, /una clave de Anthropic \(línea 2\)/);
  assert.match(notice, /\.env que git no suba/);
  assert.match(notice, /aunque te la haya dado él/);
  assert.match(notice, /no escribas nunca la clave/);
  assert.ok(!notice.includes(KEYS.anthropic));
  assert.ok(!JSON.stringify(saved).includes(KEYS.anthropic)); // tampoco se guarda
  assert.equal(await secrets.edited(cwd, 'src/config.js'), null); // la misma clave: ya avisado
  // Una clave nueva en el mismo archivo sí se avisa.
  write('src/config.js', `module.exports = {\n  key: "${KEYS.anthropic}",\n  gh: "${KEYS.github}",\n};\n`);
  assert.match(await secrets.edited(cwd, path.join(cwd, 'src', 'config.js')), /un token de GitHub \(línea 3\)/);
  // Ruta relativa a la carpeta de trabajo de la sesión.
  write('src/otro.js', `const password = "${PASSWORD}";\n`);
  assert.match(await secrets.edited(cwd, 'otro.js', { base: path.join(cwd, 'src') }), /otro\.js/);
});

test('sin claves, en carpetas de dependencias o si tarda demasiado, no avisa', async (t) => {
  const { secrets, cwd, write, saved, logs } = makeSecrets(t);
  write('a.js', 'const x = 1;\n');
  assert.equal(await secrets.edited(cwd, 'a.js'), null);
  assert.equal(await secrets.edited(cwd, 'no-existe.js'), null);
  write('node_modules/lib/index.js', `const k = "${KEYS.openai}";\n`);
  assert.equal(await secrets.edited(cwd, 'node_modules/lib/index.js'), null);
  write('b.js', `const k = "${KEYS.openai}";\n`);
  assert.equal(await secrets.edited(cwd, 'b.js', { budget: -1 }), null);
  assert.equal(saved.secretWarnings, undefined); // nada anotado: la próxima edición lo intentará
  assert.match(logs.join('\n'), /ha tardado demasiado/);
  assert.match(await secrets.edited(cwd, 'b.js'), /OpenAI/);
});

// Un repositorio git (sin confirmar nada: basta para .gitignore).
function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
}

test('de un .env solo avisa si git lo subiría', { skip: !findGit() && 'sin git en este equipo' }, async (t) => {
  const { secrets, cwd, write } = makeSecrets(t);
  write('.env', `DB_PASSWORD=${PASSWORD.slice(0, -1)}\n`);
  assert.equal(await secrets.edited(cwd, '.env'), null); // fuera de un repositorio, no hay nada que subir
  gitInit(cwd);
  const notice = await secrets.edited(cwd, '.env');
  assert.match(notice, /git no lo deja fuera/);
  assert.match(notice, /\.gitignore/);
  assert.equal(await secrets.edited(cwd, '.env'), null); // una vez
  write('.gitignore', '.env\n');
  write('.env.local', `API_KEY=${KEYS.openai}\n`);
  write('.gitignore', '.env\n.env.local\n');
  assert.equal(await secrets.edited(cwd, '.env.local'), null); // git lo deja fuera: es su sitio
});

test('splitDiff separa un diff por archivos, sin las marcas de línea', () => {
  const diff = ['diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js', '@@ -1 +1 @@', '-const x = 1;', '+const x = 2;', ' contexto',
    'diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+DB_PASSWORD=Kx9mP2vLq'].join('\n');
  assert.deepEqual(splitDiff(diff), [['a.js', 'const x = 1;\nconst x = 2;\ncontexto'], ['.env', 'DB_PASSWORD=Kx9mP2vLq']]);
});

function gitCommitAll(dir) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
}

test('antes de enviar a Codex se comprueba exactamente lo que vería', { skip: !findGit() && 'sin git en este equipo' }, async (t) => {
  const { cwd, write } = makeSecrets(t);
  gitInit(cwd);
  write('.gitignore', '.env\n');
  write('src/app.js', 'const x = 1;\n');
  write('src/old.js', `const k = "${KEYS.github}";\n`);
  gitCommitAll(cwd);
  assert.deepEqual(await reviewInput(cwd), { ok: true, files: [], empty: true }); // sin cambios: nada que revisar
  write('.env', `API_KEY=${KEYS.openai}\n`); // git lo deja fuera: no se envía
  write('src/app.js', 'const x = 2;\n');
  assert.deepEqual(await reviewInput(path.join(cwd, 'src')), { ok: true, files: [] }); // también desde una subcarpeta
  write('notas/config.yml', `db:\n  password: ${rnd(10)}\n`); // nuevo, de alguien que no es Claude
  write('src/old.js', 'const k = process.env.GH;\n'); // la clave se quita, pero el diff la lleva (línea borrada)
  const r = await reviewInput(cwd);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.split(path.sep).join('/')).sort(), ['notas/config.yml', 'src/old.js']);
  // Un archivo nuevo de texto enorme no se puede comprobar: no se envía.
  write('datos.txt', 'x'.repeat(3 * 1024 * 1024));
  assert.equal((await reviewInput(cwd)).ok, false);
  // Fuera de un repositorio, tampoco.
  assert.equal((await reviewInput(tempDir(t))).ok, false);
});

test('lee los .env de Windows (CRLF), con comentarios al final y en UTF-16', async (t) => {
  assert.equal(scanText(`DB_PASSWORD=${PASSWORD.slice(0, -1)}\r\nOTRA=1\r\n`, '.env').length, 1);
  assert.equal(scanText(`DB_PASSWORD=${PASSWORD.slice(0, -1)}   # la de producción\n`, '.env').length, 1);
  assert.equal(scanText(`db:\r\n  password: ${rnd(10)}  # la de siempre\r\n`, 'config.yml').length, 1);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`$env:API_KEY=${rnd(12)}\r\n`, 'utf16le')]);
  assert.match(decodeText(utf16), /API_KEY/);
  assert.match(decodeText(Buffer.from(`API_KEY=${rnd(12)}`, 'utf16le')), /API_KEY/); // sin marca
  assert.equal(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2, 0, 0])), null); // binario
  const { secrets, cwd } = makeSecrets(t);
  fs.writeFileSync(path.join(cwd, 'conectar.ps1'), utf16); // lo que escribe PowerShell 5 con «>»
  assert.match(await secrets.edited(cwd, 'conectar.ps1'), /escrita en el código/);
});

test('con defer, el aviso no se da por dado hasta que se entrega', async (t) => {
  const { secrets, cwd, write, saved } = makeSecrets(t);
  write('a.js', `const k = "${KEYS.openai}";\n`);
  const first = await secrets.edited(cwd, 'a.js', { defer: true });
  assert.match(first.notice, /OpenAI/);
  assert.equal(saved.secretWarnings, undefined);
  assert.match((await secrets.edited(cwd, 'a.js', { defer: true })).notice, /OpenAI/); // no entregado: se repite
  first.commit();
  assert.equal(await secrets.edited(cwd, 'a.js', { defer: true }), null);
});

// Un repositorio con estos archivos ya confirmados.
function committedRepo(t, files) {
  const { cwd, write } = makeSecrets(t);
  gitInit(cwd);
  for (const [name, text] of Object.entries(files)) write(name, text);
  gitCommitAll(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  return { cwd, write, git };
}
const names = (r) => r.files.map((f) => f.split(path.sep).join('/')).sort();

test('la comprobación previa no se deja engañar', { skip: !findGit() && 'sin git en este equipo' }, async (t) => {
  // Una clave preparada y luego quitada de la copia de trabajo sigue en lo preparado.
  const a = committedRepo(t, { 'a.js': 'const x = 1;\n' });
  a.write('a.js', `const k = "${KEYS.openai}";\n`);
  a.git('add', 'a.js');
  a.write('a.js', 'const x = 2;\n');
  assert.deepEqual(names(await reviewInput(a.cwd)), ['a.js']);
  // Una clave privada que se borra: el diff la lleva entera, cabecera incluida.
  const key = `${'-----BEGIN '}PRIVATE KEY-----\n${rnd(64)}\n${rnd(64, 'QwErTy12345')}\n-----END PRIVATE KEY-----\n`;
  const b = committedRepo(t, { id_rsa: key, 'a.js': 'const x = 1;\n' });
  fs.rmSync(path.join(b.cwd, 'id_rsa'));
  assert.deepEqual(names(await reviewInput(b.cwd)), ['id_rsa']);
  // Con un formato de diff distinto configurado en el repositorio, se entiende igual.
  const c = committedRepo(t, { 'a.js': 'const x = 1;\n' });
  c.git('config', 'diff.noprefix', 'true');
  c.write('a.js', `const k = "${KEYS.github}";\n`);
  assert.deepEqual(names(await reviewInput(c.cwd)), ['a.js']);
  // Un archivo nuevo en UTF-16 se lee.
  fs.writeFileSync(path.join(c.cwd, 'c.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`$env:API_KEY=${rnd(12)}\r\n`, 'utf16le')]));
  assert.deepEqual(names(await reviewInput(c.cwd)), ['a.js', 'c.ps1']);
  // Cancelada, no se da por comprobada.
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await reviewInput(c.cwd, controller.signal), { ok: false, files: [], aborted: true });
});

test('una palabra como «secret» o «test» dentro de una contraseña de verdad no la esconde', () => {
  for (const value of [`Mi${'Secret'}2024!`, `test-Db-${rnd(6)}`, `Password${rnd(5)}#`]) {
    assert.equal(scanText(`const password = "${value}";`, 'a.js').length, 1, value);
  }
  for (const value of ['your-token-here', 'tu_contraseña', 'db_password', 'API_KEY', 'my_secret_here']) {
    assert.deepEqual(scanText(`const password = "${value}";`, 'a.js'), [], value);
  }
});

test('splitDiff guarda la línea de contexto de cada trozo y marca los binarios', () => {
  const diff = ['diff --git a/db.py b/db.py', '--- a/db.py', '+++ b/db.py', '@@ -10,3 +10,3 @@ def connect(password="Kx9mP2vLq#1"):', '-    x = 1', '+    x = 2',
    'diff --git a/c.ps1 b/c.ps1', 'index 1..2 100644', 'Binary files a/c.ps1 and b/c.ps1 differ'].join('\n');
  assert.deepEqual(splitDiff(diff), [['db.py', 'def connect(password="Kx9mP2vLq#1"):\n    x = 1\n    x = 2'], ['c.ps1', '', true]]);
});

test('la comprobación previa lee también lo que git ve como binario y el contexto de los trozos', { skip: !findGit() && 'sin git en este equipo' }, async (t) => {
  // Un script UTF-16 ya confirmado que cambia: git lo ve como binario.
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const a = committedRepo(t, { 'c.ps1': 'x' });
  fs.writeFileSync(path.join(a.cwd, 'c.ps1'), utf16('Write-Host hola\r\n'));
  a.git('add', 'c.ps1');
  a.git('-c', 'user.name=P', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'utf16');
  fs.writeFileSync(path.join(a.cwd, 'c.ps1'), utf16(`$env:API_KEY=${rnd(12)}\r\n`));
  assert.deepEqual(names(await reviewInput(a.cwd)), ['c.ps1']);
  a.git('add', 'c.ps1'); // preparado: se lee del índice
  assert.deepEqual(names(await reviewInput(a.cwd)), ['c.ps1']);
  // Una contraseña que solo aparece en la cabecera del trozo (la función que contiene el cambio).
  const body = Array.from({ length: 12 }, (_, i) => `    paso${i} = ${i}`).join('\n');
  const b = committedRepo(t, { 'db.py': `def connect(host, password="${PASSWORD}"):\n${body}\n` });
  b.write('db.py', `def connect(host, password="${PASSWORD}"):\n${body.replace('paso10 = 10', 'paso10 = 11')}\n`);
  assert.deepEqual(names(await reviewInput(b.cwd)), ['db.py']);
});
