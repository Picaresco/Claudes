// ── Límites de uso del plan y tokens (barra inferior) ──
// En la barra, solo los porcentajes (y cuándo se renueva); los tokens, al pasar el ratón.
// El límite semanal con su porcentaje, los tokens usados en la semana y cuándo se
// renueva; si el plan tiene además límite de 5 horas, se añade su porcentaje. El
// detalle, al pasar el ratón. Los tokens de la conversación van junto a su llenado.
import { $ } from './dom.js';
import { usageLevel, nf, fitStatusbar } from './render.js';
import { clamp } from './state.js';

export let limitsSnap = { plan: null, conversations: {} }; // de limits.js
export const setLimitsSnap = (value) => { limitsSnap = value; };


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

// «hoy 18:40», «mañana 01:10», «vie 27 21:00»: lo mismo, abreviado.
function whenShort(ms) {
  const d = new Date(ms);
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const shifted = (days) => { const x = new Date(); x.setDate(x.getDate() + days); return day(x); };
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (day(d) === shifted(0)) return `hoy ${hm}`;
  if (day(d) === shifted(1)) return `mañana ${hm}`;
  if (day(d) === shifted(-1)) return `ayer ${hm}`;
  return `${d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '')} ${d.getDate()} ${hm}`;
}

// El texto de un medidor de la barra inferior, por piezas. Lo que no lleva `kind` se ve
// siempre; si la barra no cabe en una línea (fitStatusbar, en render.js), se va compactando:
//   long / short   la misma información con su forma larga y su forma abreviada
//   extra          lo que se quita después (p. ej. los tokens)
// El detalle completo queda siempre en el texto emergente.
export function setPieces(node, pieces) {
  node.replaceChildren(...pieces.filter((p) => p && p.text).map((p) => {
    const span = document.createElement('span');
    span.textContent = p.text;
    if (p.kind) span.className = `sb-${p.kind}`;
    return span;
  }));
}
// Una fecha con sus dos formas: «{antes}el viernes 27 a las 21:00» y «{corto}vie 27 21:00».
// bare: sin el artículo («viernes 27 a las 21:00»), cuando va sola.
const whenPieces = (ms, long, short, bare = false) => [{ kind: 'long', text: `${long}${bare ? whenText(ms).replace(/^el /, '') : whenText(ms)}` }, { kind: 'short', text: `${short}${whenShort(ms)}` }];

function limitDetail(name, w) {
  const t = w.tokens;
  const head = w.expired
    ? `${name}: se renovó ${whenText(w.resetsAt)}. El porcentaje nuevo llega con tu próximo mensaje.`
    : `${name}: ${w.pct} % usado · se renueva ${whenText(w.resetsAt)}.`;
  return `${head}\n   Tokens usados ${w.expired ? 'desde la renovación' : 'en este periodo'}: ${nf.format(t.total)}${t.total ? ` (${tokensBreakdown(t)})` : ''}.`;
}

// Codex en este equipo y lo que lleva gastado su plan de ChatGPT (codexInfo de la app).
export function renderCodexLimits(info) {
  try { drawCodexLimits(info); } finally { fitStatusbar(); }
}

function drawCodexLimits(info) {
  const box = $('#sb-codex');
  if (!info) { box.hidden = true; return; }
  box.hidden = false;
  const meter = box.querySelector('.sb-meter');
  const l = info.usable ? info.limits : null;
  meter.hidden = !l;
  box.dataset.level = l ? (l.reached ? 'high' : usageLevel(l.pct)) : 'low';
  if (!info.installed) {
    $('#sb-codex-text').textContent = 'no detectado';
    box.title = 'Codex no está instalado en este equipo. Si lo instalas e inicias sesión con tu cuenta de ChatGPT, Claude podrá usarlo como asesor y para generar imágenes.';
    return;
  }
  if (!info.usable) {
    $('#sb-codex-text').textContent = info.loggedIn ? 'con clave de API' : 'sin sesión';
    box.title = info.loggedIn
      ? 'Codex está instalado, pero con una clave de API: ClaudHome solo lo usa con tu cuenta de ChatGPT.'
      : 'Codex está instalado, pero sin sesión. Ejecuta «codex login» con tu cuenta de ChatGPT y pulsa el indicador de Codex de arriba.';
    return;
  }
  if (!l) {
    $('#sb-codex-text').textContent = 'detectado';
    box.title = 'Codex está instalado con tu cuenta de ChatGPT. Su uso aparecerá aquí en cuanto se pueda leer.';
    return;
  }
  const windowLabel = (mins) => (mins === 10080 ? 'semana' : !mins ? 'límite' : mins % 60 ? `${mins} min` : `${mins / 60} h`);
  const label = windowLabel(l.windowMins);
  const hm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  $('#sb-codex-fill').style.width = `${clamp(l.pct, 0, 100)}%`;
  // Agotado: hasta cuándo, el de la ventana agotada (si se sabe), y el porcentaje semanal aparte.
  const reached = l.reachedWindow;
  // «Codex [barra] 11 % jue 26 11:51»; si su límite no es semanal, con su ventana («5 h 40 %»).
  const high = l.reached || usageLevel(l.pct) === 'high';
  const pieces = l.reached
    ? [{ kind: 'pct', text: '⚠ límite alcanzado' }, ...(reached && reached.resetsAt ? whenPieces(reached.resetsAt, ' hasta ', ' hasta ') : []), { kind: 'extra', text: ` · ${label} ${l.pct} %` }]
    : [{ kind: 'pct', text: `${high ? '⚠ ' : ''}${l.windowMins === 10080 ? '' : `${label} `}${l.pct} %` }, ...(l.resetsAt ? whenPieces(l.resetsAt, ' · ', ' ', true) : [])];
  // Si la última lectura falló, el dato que se ve es el anterior: con su hora.
  if (l.stale && l.checkedAt) pieces.push({ text: ` · dato de las ${hm(l.checkedAt)}` });
  setPieces($('#sb-codex-text'), pieces);
  const other = l.other ? `\nOtro límite: ${l.other.pct} %${l.other.resetsAt ? `, se renueva ${whenText(l.other.resetsAt)}` : ''}.` : '';
  box.title = `Codex con tu cuenta de ChatGPT${l.plan ? ` (plan ${l.plan})` : ''}: ${l.pct} % del límite ${l.windowMins === 10080 ? 'semanal' : 'de uso'}${l.resetsAt ? `, se renueva ${whenText(l.resetsAt)}` : ''}.${other}\n\n`
    + 'Incluye todo lo que uses de Codex con esa cuenta, también fuera de ClaudHome. Se actualiza cada 10 minutos y tras cada consulta a Codex.';
}

// También se llama cada minuto por su cuenta (cambia «hoy» por «mañana»…): el texto puede
// ensancharse o encogerse, así que la barra se vuelve a ajustar.
export function renderPlanLimits() {
  try { drawPlanLimits(); } finally { fitStatusbar(); }
}
function drawPlanLimits() {
  const plan = limitsSnap.plan;
  const box = $('#sb-plan');
  const main = plan && (plan.seven_day || plan.five_hour);
  box.hidden = !main;
  if (!main) return;
  const five = plan.seven_day && plan.five_hour && !plan.five_hour.expired ? plan.five_hour : null;
  const pct = main.expired ? 0 : main.pct;
  let level = usageLevel(pct);
  if (five && usageLevel(five.pct) === 'high') level = 'high';
  else if (five && usageLevel(five.pct) === 'mid' && level === 'low') level = 'mid';
  box.dataset.level = level;
  $('#sb-plan-fill').style.width = `${clamp(pct, 0, 100)}%`;
  // «Claude [barra] 50 % vie 27 21:00» (cerca del límite, «⚠ 88 %» en rojo). Sin límite semanal, el de 5 horas.
  setPieces($('#sb-plan-text'), main.expired
    ? [{ kind: 'pct', text: 'renovada' }, ...whenPieces(main.resetsAt, ' ', ' ')]
    : [{ kind: 'pct', text: `${level === 'high' ? '⚠ ' : ''}${plan.seven_day ? '' : '5 h '}${main.pct} %` }, five ? { text: ` · 5 h ${five.pct} %` } : null, ...whenPieces(main.resetsAt, ' · ', ' ', true)]);
  const parts = [];
  if (plan.seven_day) parts.push(limitDetail('Límite semanal', plan.seven_day));
  if (plan.five_hour) parts.push(limitDetail('Límite de 5 horas', plan.five_hour));
  box.title = `${parts.join('\n')}\n\nEl porcentaje es el de tu cuenta: incluye lo usado en claude.ai y en otros equipos. `
    + 'Los tokens son los de Claude Code en este equipo. La «caché leída» es texto que Claude ya tenía y vuelve a leer: es mucho más barato que el resto.';
}
