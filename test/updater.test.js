const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseChangelog } = require('../src/main/updater');

test('compareVersions compara número a número', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1); // como texto sería al revés
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.1-beta', '1.2.0'), 1);
  assert.equal(compareVersions('', '0.0.1'), -1);
});

test('parseChangelog lee las secciones y sus puntos', () => {
  const text = [
    '# Cambios', '', 'Texto de introducción.', '',
    '## 0.10.0 — 2026-11-20',
    '- Primer cambio.',
    '- Segundo cambio,',
    '  que sigue en otra línea.',
    '',
    '## 0.9.0 — 2026-11-19',
    '- Otro cambio.',
    '## Notas',
    '- Esto no es de ninguna versión.',
  ].join('\n');
  assert.deepEqual(parseChangelog(text), [
    { version: '0.10.0', date: '2026-11-20', items: ['Primer cambio.', 'Segundo cambio, que sigue en otra línea.'] },
    { version: '0.9.0', date: '2026-11-19', items: ['Otro cambio.'] },
  ]);
  assert.deepEqual(parseChangelog(''), []);
});

test('el CHANGELOG del proyecto se puede leer entero', () => {
  const fs = require('fs');
  const path = require('path');
  const versions = parseChangelog(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
  assert.ok(versions.length >= 10);
  for (const v of versions) assert.ok(v.items.length > 0, `la versión ${v.version} no tiene cambios`);
  const { version } = require('../package.json');
  assert.equal(versions[0].version, version, 'la primera sección tiene que ser la de la versión de package.json');
});
