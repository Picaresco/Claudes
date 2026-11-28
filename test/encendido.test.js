// SuperPowers con Codex (src/renderer/ui/sp-ignite.js): cuándo va al máximo, la curva de la
// estela desde «Codex» hasta el botón y que las brasas y el gas del HTML casen con los estilos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..', 'src', 'renderer');
const load = () => import(pathToFileURL(path.join(root, 'ui', 'sp-ignite.js')).href);

test('va al máximo solo con Codex instalado, con su cuenta y sin el límite agotado', async () => {
  const { codexCanReview, setCodexReady, codexReady, codexUsable } = await load();
  assert.equal(codexCanReview(null), false);
  assert.equal(codexCanReview({ usable: false }), false);
  assert.equal(codexCanReview({ usable: true }), true);
  assert.equal(codexCanReview({ usable: true, limits: { reached: false } }), true);
  assert.equal(codexCanReview({ usable: true, limits: { reached: true } }), false);
  setCodexReady({ usable: true });
  assert.equal(codexReady(), true);
  setCodexReady({ usable: true, limits: { reached: true } });
  assert.equal(codexReady(), false); // sin brasas con el límite agotado…
  assert.equal(codexUsable(), true); // …pero el git local sí se crea: el límite se renueva
});

test('la estela sale de «Codex», sube un poco y baja en curva hasta el botón', async () => {
  const { trailPath } = await load();
  const d = trailPath({ x: 1058, y: 25 }, { x: 762, y: 76 });
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  assert.match(d, /^M .* C .*, .*, .*$/);
  assert.deepEqual(nums.slice(0, 2), [1058, 25]); // empieza en las letras de Codex
  assert.deepEqual(nums.slice(-2), [762, 76]); // y acaba en el centro del botón
  assert.ok(nums[3] < 25 && nums[5] < 76); // los puntos de control van por encima: la curva sube antes de bajar
  assert.ok(nums.every(Number.isFinite));
  assert.ok(nums[3] >= 6 && nums[5] >= 6); // sin salirse por arriba de la ventana (Codex va en la barra de arriba)
});

test('sin Codex listo o sin el botón en pantalla no se anima nada', async (t) => {
  const { ignite, setCodexReady } = await load();
  globalThis.document = { querySelector: () => null, hidden: false };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  setCodexReady({ usable: false });
  assert.equal(ignite(), false);
  setCodexReady({ usable: true });
  assert.equal(ignite(), false); // listo, pero no hay botón ni indicador
});

test('las brasas y el gas del HTML casan con los estilos', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'ui', 'sp-ignite.js'), 'utf8');
  const embers = html.match(/<span class="sp-embers"[^>]*>(.*?)<\/span>/);
  assert.ok(embers, 'las brasas van dentro del botón de SuperPowers');
  const count = (embers[1].match(/<i><\/i>/g) || []).length;
  const styled = [...css.matchAll(/\.sp-embers i:nth-child\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(styled, Array.from({ length: count }, (_, i) => i + 1)); // cada brasa tiene su sitio
  const puffs = Number(js.match(/i < (\d+); i \+= 1\) gas\.append/)[1]);
  const gas = [...css.matchAll(/\.sp-gas b:nth-of-type\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(gas, Array.from({ length: puffs }, (_, i) => i + 1)); // y cada bocanada de gas
  assert.match(css, /prefers-reduced-motion[\s\S]*\.sp-embers, \.sp-trail, \.sp-gas \{ display: none; \}/);
});
