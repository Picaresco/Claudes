// ── Arcoíris del nombre ──────────────────────────────────────────
// Cada 3 minutos, o al pulsar sobre el nombre, un arcoíris suave lo recorre.
// Con «reducir animaciones» activado en Windows no se muestra.
import { $ } from './dom.js';

const RAINBOW_EVERY = 3 * 60 * 1000;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function rainbow() {
  const name = $('#brand-name');
  if (reducedMotion.matches) return;
  name.classList.remove('rainbow');
  void name.offsetWidth; // vuelve a empezar si ya estaba pasando
  name.classList.add('rainbow');
}

export function wireRainbow() {
  const name = $('#brand-name');
  name.addEventListener('click', rainbow);
  name.addEventListener('animationend', () => name.classList.remove('rainbow'));
  setInterval(rainbow, RAINBOW_EVERY);
}
