// ── Límites de uso del plan y tokens (barra inferior) ──
// El límite semanal con su porcentaje, los tokens usados en la semana y cuándo se
// renueva; si el plan tiene además límite de 5 horas, se añade su porcentaje. El
// detalle, al pasar el ratón. Los tokens de la conversación van junto a su llenado.
import { $ } from './dom.js';
import { usageLevel, nf } from './render.js';
import { clamp } from './state.js';

export let limitsSnap = { plan: null, conversations: {} }; // de limits.js
export const setLimitsSnap = (value) => { limitsSnap = value; };

export function tokensShort(n) {
  if (n < 1000) return `${n} tokens`;
  if (n < 1e6) return `${Math.round(n / 1000)} mil tokens`;
  return `${(n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: n < 1e7 ? 1 : 0 })} M tokens`;
}

export const tokensBreakdown = (t) => `entrada ${nf.format(t.input)} · salida ${nf.format(t.output)} · caché escrita ${nf.format(t.cacheWrite)} · caché leída ${nf.format(t.cacheRead)}`;

// «hoy a las 18:40», «mañana a las 01:10», «el lunes 24 a las 09:00»…
function whenText(ms) {
  const d = new Date(ms);
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const shifted = (days) => { const x = new Date(); x.setDate(x.getDate() + days); return day(x); };
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (day(d) === shifted(0)) return `hoy a las ${hm}`;
  if (day(d) === shifted(1)) return `mañana a las ${hm}`;
  if (day(d) === shifted(-1)) return `ayer a las ${hm}`;
  return `el ${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' })} a las ${hm}`;
}

function limitDetail(name, w) {
  const t = w.tokens;
  const head = w.expired
    ? `${name}: se renovó ${whenText(w.resetsAt)}. El porcentaje nuevo llega con tu próximo mensaje.`
    : `${name}: ${w.pct} % usado · se renueva ${whenText(w.resetsAt)}.`;
  return `${head}\n   Tokens usados ${w.expired ? 'desde la renovación' : 'en este periodo'}: ${nf.format(t.total)}${t.total ? ` (${tokensBreakdown(t)})` : ''}.`;
}

export function renderPlanLimits() {
  const plan = limitsSnap.plan;
  const box = $('#sb-plan');
  const main = plan && (plan.seven_day || plan.five_hour);
  box.hidden = !main;
  if (!main) return;
  const label = plan.seven_day ? 'Semana' : 'Límite 5 h';
  const five = plan.seven_day && plan.five_hour && !plan.five_hour.expired ? plan.five_hour : null;
  const pct = main.expired ? 0 : main.pct;
  let level = usageLevel(pct);
  if (five && usageLevel(five.pct) === 'high') level = 'high';
  else if (five && usageLevel(five.pct) === 'mid' && level === 'low') level = 'mid';
  box.dataset.level = level;
  $('#sb-plan-fill').style.width = `${clamp(pct, 0, 100)}%`;
  $('#sb-plan-text').textContent = main.expired
    ? `${label}: renovada ${whenText(main.resetsAt)} · ${tokensShort(main.tokens.total)} desde entonces`
    : `${label} ${main.pct} % · ${tokensShort(main.tokens.total)} · se renueva ${whenText(main.resetsAt)}`
      + (five ? ` · 5 h ${five.pct} %` : '');
  const parts = [];
  if (plan.seven_day) parts.push(limitDetail('Límite semanal', plan.seven_day));
  if (plan.five_hour) parts.push(limitDetail('Límite de 5 horas', plan.five_hour));
  box.title = `${parts.join('\n')}\n\nEl porcentaje es el de tu cuenta: incluye lo usado en claude.ai y en otros equipos. `
    + 'Los tokens son los de Claude Code en este equipo. La «caché leída» es texto que Claude ya tenía y vuelve a leer: es mucho más barato que el resto.';
}
