// ── SuperPowers con Codex: el gas verde y las brasas ─────────────
// Al encender SuperPowers en la pestaña activa con Codex listo (instalado, con la cuenta de
// ChatGPT y sin el límite de uso agotado), de las letras de «Codex» sale una estela de gas verde
// que baja en curva hasta el botón y lo envuelve unos segundos. Después se queda en brasas
// (chispas verdes que suben del borde) mientras siga encendido con Codex: SuperPowers al máximo,
// porque Codex revisa lo que hace Claude. Sin Codex, el botón se enciende con su luz de siempre.
// Con «reducir movimiento», ni estela ni gas: el botón queda con un brillo verde quieto.
// Lo que se ve está en styles.css (sp-trail, sp-gas, sp-embers y data-max / data-igniting).

const FLY_MS = 1000; // lo que tarda cada chispa de la estela en llegar
const GAS_AT = 850; // cuándo empieza el gas alrededor del botón
const GAS_MS = 3100; // y cuánto dura, antes de quedarse en brasas
// La estela: chispas pequeñas y bocanadas de gas, con su tamaño y cuándo salen (ms).
const TRAIL = [
  [10, 0], [7, 50], [34, 80, true], [12, 120], [6, 170], [42, 200, true],
  [9, 240], [13, 290], [30, 330, true], [7, 370], [10, 420], [46, 460, true],
];

let ready = false; // Codex listo para revisar (lo dice ui/codex.js)
let usable = false; // Codex con la cuenta de ChatGPT, aunque ahora tenga el límite agotado
let timers = [];
let nodes = [];

// ¿Puede Codex revisar ahora? Instalado, con la cuenta de ChatGPT y sin el límite agotado.
export function codexCanReview(info) {
  return Boolean(info && info.usable && !(info.limits && info.limits.reached));
}
export function setCodexReady(info) { ready = codexCanReview(info); usable = Boolean(info && info.usable); }
export const codexReady = () => ready;
export const codexUsable = () => usable;

// La curva de la estela: sale de «Codex» un poco hacia arriba y baja hasta el botón, sin
// salirse por arriba de la ventana (los puntos de control, como poco a 6 px del borde).
export function trailPath(from, to) {
  const dx = from.x - to.x;
  const r = (n) => Math.round(n * 10) / 10;
  const up = (y, by) => Math.max(6, y - by);
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x - 0.16 * dx)} ${r(up(from.y, 40))}, ${r(to.x + 0.4 * dx)} ${r(up(to.y, 80))}, ${r(to.x)} ${r(to.y)}`;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function center(node) {
  const r = node.getBoundingClientRect();
  return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

// Para lo que esté en marcha (al apagar o si la pestaña cambia a mitad).
export function stopIgnite() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  for (const n of nodes) n.remove();
  nodes = [];
  const button = document.querySelector('#btn-superpowers');
  if (button) delete button.dataset.igniting;
  const badge = document.querySelector('#codex-status');
  if (badge) badge.classList.remove('cx-ignite');
}

// La animación de encendido: «Codex» se enciende, la estela vuela al botón y el gas lo envuelve.
export function ignite() {
  stopIgnite();
  const button = document.querySelector('#btn-superpowers');
  const badge = document.querySelector('#codex-status');
  if (!ready || !button || !badge || badge.hidden || reduced() || document.hidden) return false;
  const from = center(badge.querySelector('.cx-name') || badge);
  const to = center(button);
  if (!from || !to) return false;
  badge.classList.add('cx-ignite');
  button.dataset.igniting = 'trail'; // sin brasas hasta que acabe el gas
  timers.push(setTimeout(() => badge.classList.remove('cx-ignite'), 1200));
  const path = `path('${trailPath(from, to)}')`;
  for (const [size, delay, puff] of TRAIL) {
    const spark = document.createElement('i');
    spark.className = puff ? 'sp-trail puff' : 'sp-trail';
    spark.setAttribute('aria-hidden', 'true');
    spark.style.width = `${size}px`;
    spark.style.height = `${size}px`;
    spark.style.offsetPath = path;
    document.body.append(spark);
    nodes.push(spark);
    const fly = spark.animate([
      { offsetDistance: '0%', opacity: 0, transform: 'scale(0.4)' },
      { opacity: 1, offset: 0.12 },
      { opacity: 0.9, offset: 0.8 },
      { offsetDistance: '100%', opacity: 0, transform: 'scale(1.5)' },
    ], { duration: FLY_MS, delay, easing: 'cubic-bezier(.5,0,.25,1)', fill: 'both' });
    fly.onfinish = () => spark.remove();
  }
  timers.push(setTimeout(() => {
    const at = center(button) || to;
    const gas = document.createElement('div');
    gas.className = 'sp-gas';
    gas.setAttribute('aria-hidden', 'true');
    gas.style.left = `${at.x}px`;
    gas.style.top = `${at.y}px`;
    gas.append(document.createElement('span'));
    for (let i = 0; i < 8; i += 1) gas.append(document.createElement('b'));
    gas.firstChild.className = 'swirl';
    document.body.append(gas);
    nodes.push(gas);
    button.dataset.igniting = 'gas'; // el borde se vuelve verde y gira mientras dura el gas
  }, GAS_AT));
  timers.push(setTimeout(() => stopIgnite(), GAS_AT + GAS_MS)); // y se queda en brasas
  return true;
}
