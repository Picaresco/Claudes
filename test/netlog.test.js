const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { NetLog, redact, isPublic, isPublicHost, externalTargets } = require('../src/main/netlog');
const { tempDir } = require('./helpers');

test('redact tapa contraseñas, tokens y credenciales', () => {
  // Claves inventadas, montadas a trozos para que nadie las tome por reales.
  const anthropicKey = `sk-ant-${'abc123'.repeat(5)}`;
  const githubKey = `ghp_${'ab12'.repeat(9)}`;
  const cases = [
    ['curl https://ana:secreto@servidor.com/x', 'secreto'],
    ['curl -H "Authorization: Bearer abcdef1234567890" https://api.x.com', 'abcdef1234567890'],
    ['https://x.com/a?token=abc123&b=1', 'abc123'],
    ['mysql --password=hunter2 -u root', 'hunter2'],
    ['curl -u admin:clave123 https://x.com', 'clave123'],
    ['sshpass -p miclave ssh host', 'miclave'],
    [`export CLAVE_API=${anthropicKey}`, anthropicKey],
    [`gh api -H "X-Token: ${githubKey}" /user`, githubKey],
  ];
  for (const [text, secret] of cases) {
    const out = redact(text);
    assert.ok(!out.includes(secret), `sigue viéndose «${secret}» en: ${out}`);
    assert.ok(out.includes('****'), `no se ha tapado nada en: ${out}`);
  }
});

test('redact no toca lo que no es secreto', () => {
  assert.equal(redact('git status'), 'git status');
  assert.equal(redact('https://example.com/docs?page=2'), 'https://example.com/docs?page=2');
});

test('isPublic e isPublicHost distinguen la red local de internet', () => {
  for (const ip of ['10.0.0.57', '192.168.1.1', '172.16.5.4', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1']) {
    assert.equal(isPublic(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) assert.equal(isPublic(ip), true, ip);
  for (const host of ['localhost', 'nas', 'equipo.local', 'srv.lan', '10.0.0.5']) assert.equal(isPublicHost(host), false, host);
  for (const host of ['github.com', 'api.anthropic.com', '1.1.1.1']) assert.equal(isPublicHost(host), true, host);
});

test('externalTargets: solo los comandos que salen a internet', () => {
  assert.equal(externalTargets('ls -la'), null);
  assert.equal(externalTargets('ssh admin@10.0.0.57 show version'), null); // red local
  assert.deepEqual(externalTargets('curl https://api.github.com/repos'), ['api.github.com']);
  assert.deepEqual(externalTargets('git push origin main'), ['internet']); // sale, sin destino a la vista
  assert.deepEqual(externalTargets('npm install express'), ['internet']);
});

function makeLog(t, extra = {}) {
  const dir = tempDir(t);
  const sent = [];
  const log = new NetLog({
    logsDir: () => dir,
    send: (channel, entry) => sent.push({ channel, entry }),
    tabName: (id) => (id === 't1' ? 'Proyecto' : null),
    cwdOf: (id) => (id === 't1' ? 'C:\\Proyectos\\web' : null),
    ...extra,
  });
  return { log, sent, dir };
}

test('NetLog apunta la herramienta con la carpeta del proyecto y agrupa las repeticiones', (t) => {
  const { log, sent, dir } = makeLog(t);
  const ev = { event: 'PostToolUse', toolName: 'Read', toolInput: { file: 'C:\\Proyectos\\web\\a.txt' }, size: 2048 };
  log.fromHook('t1', ev);
  log.fromHook('t1', ev);
  const list = log.entries();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].size, 4096);
  assert.equal(list[0].cwd, 'C:\\Proyectos\\web');
  assert.equal(list[0].tabName, 'Proyecto');
  assert.equal(list[0].external, false);
  assert.deepEqual(sent.map((s) => s.channel), ['netlog:entry', 'netlog:update']);
  assert.match(fs.readFileSync(log.todayFile(), 'utf8'), /Proyecto · Archivo leído · C:\\Proyectos\\web\\a\.txt → Anthropic/);
  assert.ok(fs.readdirSync(dir).length === 1);
});

test('NetLog no retiene en memoria las entradas que ya han salido de la lista', (t) => {
  const { log } = makeLog(t);
  log.writeFile = () => {}; // sin escribir 5 000 líneas en disco
  for (let i = 0; i < 5000; i += 1) log.record({ tabId: 't1', kind: 'web', target: `https://ejemplo${i}.com/`, dest: 'Internet', external: true });
  assert.equal(log.entries().length, 3000);
  assert.equal(log.groups.size, 3000); // antes se quedaban las 5 000
  // Una repetición reciente se sigue agrupando.
  log.record({ tabId: 't1', kind: 'web', target: 'https://ejemplo4999.com/', dest: 'Internet', external: true });
  assert.equal(log.entries().length, 3000);
  assert.equal(log.entries().at(-1).count, 2);
});

test('NetLog marca lo que sale a internet y tapa los secretos', (t) => {
  const { log } = makeLog(t);
  log.fromHook('t1', { event: 'PostToolUse', toolName: 'Bash', toolInput: { command: 'curl -u ana:clave https://api.github.com/x' } });
  log.fromHook('t1', { event: 'PostToolUse', toolName: 'WebFetch', toolInput: { url: 'https://example.com/a?token=abc' } });
  log.fromHook('t1', { event: 'PostToolUse', toolName: 'mcp__claude_ai_Gmail__buscar', toolInput: { summary: '{}' } });
  log.fromHook('t1', { event: 'PreToolUse', toolName: 'Read', toolInput: { file: 'x' } }); // no cuenta: aún no se ha ejecutado
  const [cmd, web, mcp] = log.entries();
  assert.equal(log.entries().length, 3);
  assert.equal(cmd.external, true);
  assert.ok(!cmd.target.includes('clave'));
  assert.equal(web.external, true);
  assert.ok(!web.target.includes('abc'));
  assert.equal(mcp.dest, 'claude.ai y Anthropic');
});

test('la respuesta de las herramientas propias se suma a su salida a Codex, sin otra entrada', (t) => {
  const { log } = makeLog(t);
  log.record({ tabId: 't1', kind: 'opinion', target: 'Segunda opinión (código)', dest: 'OpenAI (Codex)', external: true });
  log.fromHook('t1', { event: 'PostToolUse', toolName: 'mcp__claudhome-codex__segunda_opinion', toolInput: { summary: '{}' }, size: 5000 });
  const entries = log.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, 5000);
});
