// ── Codex ────────────────────────────────────────────────────────
import { api, $ } from './dom.js';
import { renderCodexLimits } from './limits.js';
import { renderToolbar } from './render.js';
import { restartSession } from './sessions.js';
import { toggleSettings } from './settings.js';
import { views, toast } from './state.js';

export let codexInfo = null;

export function renderCodex(info) {
  if (info) codexInfo = info;
  const chip = $('#codex-chip');
  if (!codexInfo) { chip.hidden = true; return; }
  let state = 'missing';
  let label;
  let title;
  if (!codexInfo.installed) {
    label = 'Codex no detectado en este equipo';
    title = 'No encuentro Codex en este equipo. Si lo instalas e inicias sesión con tu suscripción de ChatGPT, Claude podrá pedirle segundas opiniones, revisiones e imágenes. Pulsa para volver a comprobar.';
  } else if (!codexInfo.loggedIn) {
    label = 'Codex sin sesión';
    title = 'Codex está instalado pero sin sesión iniciada. Ejecuta «codex login» y pulsa aquí para volver a comprobar.';
  } else if (codexInfo.mode !== 'chatgpt') {
    label = 'Codex con clave de API: solo con tu cuenta de ChatGPT';
    title = 'Codex tiene sesión con una clave de API, no con una suscripción de ChatGPT. Las imágenes con Codex solo se activan con suscripción.';
  } else if (codexInfo.busy > 0) {
    state = 'busy';
    label = 'Codex trabajando…';
    title = 'Codex está trabajando para una sesión: una segunda opinión, la crítica de un plan o una imagen.';
  } else if (!codexInfo.enabled) {
    state = 'ready';
    label = 'Desactivadas';
    title = codexInfo.advisor === false
      ? 'Suscripción de ChatGPT detectada en Codex, pero esta versión de Codex es antigua para asesorar a Claude: actualízala (npm i -g @openai/codex). Pulsa para que Claude pueda pedirle imágenes.'
      : 'Suscripción de ChatGPT detectada en Codex. Enciende «Codex asesora» para que asesore a Claude; pulsa aquí para que también pueda pedirle imágenes.';
  } else {
    state = 'on';
    label = 'Activadas';
    title = 'Activado: Claude puede pedir imágenes a Codex con tu suscripción. Pulsa para desactivarlo.';
  }
  chip.hidden = false;
  chip.dataset.state = state;
  chip.title = title;
  chip.setAttribute('aria-pressed', String(Boolean(codexInfo.active)));
  $('#codex-label').textContent = label;
  renderCodexStatus();
  renderToolbar();
  renderCodexLimits(codexInfo); // detección y uso de Codex, en la barra inferior
}

// El indicador «Codex» de la barra superior, junto a la rueda: de un vistazo, si hay Codex
// en este equipo, si se le acaba el límite de uso y si está trabajando ahora mismo: en qué,
// para qué proyecto y cuánto lleva.
const LIMIT_WARN = 80; // % del límite de uso de Codex a partir del cual se avisa
// Un icono por cada cosa que hace: revisar el código, criticar un plan, dar una segunda
// opinión (un escudo si es de seguridad) o generar una imagen.
const JOB_ICONS = { review: '#codex-job-review', plan: '#codex-job-plan', opinion: '#codex-job-opinion', security: '#codex-job-security', draw: '#codex-job-draw' };
const iconOf = (job) => (JOB_ICONS[job.icon] ? job.icon : job.kind === 'draw' ? 'draw' : 'opinion');
const quoted = (name) => (name ? `«${name}»` : 'una sesión');
const listed = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items.join(''));
function renderCodexStatus() {
  const badge = $('#codex-status');
  const usable = Boolean(codexInfo.usable);
  const jobs = usable ? codexInfo.jobs || [] : [];
  const advising = jobs.filter((job) => job.kind === 'advise');
  const drawing = jobs.filter((job) => job.kind === 'draw');
  const limits = usable ? codexInfo.limits : null;
  const level = !limits ? '' : limits.reached ? 'reached' : limits.pct >= LIMIT_WARN ? 'high' : '';
  let text;
  if (!codexInfo.installed) text = 'Codex no está instalado en este equipo (o no lo encuentro). Con Codex y tu cuenta de ChatGPT, Claude puede pedirle segundas opiniones, revisiones e imágenes. Pulsa para volver a comprobar.';
  else if (!codexInfo.loggedIn) text = 'Codex está instalado, pero sin sesión iniciada: ejecuta «codex login». Pulsa para volver a comprobar.';
  else if (!usable) text = 'Codex está instalado, pero con una clave de API: ClaudHome solo lo usa con tu cuenta de ChatGPT. Pulsa para volver a comprobar.';
  else {
    const doing = [
      advising.length ? `asesorando a Claude en ${listed(advising.map((job) => `${quoted(job.tab)} (${job.what})`))}` : '',
      drawing.length ? `generando una imagen para ${listed(drawing.map((job) => quoted(job.tab)))}` : '',
    ].filter(Boolean).join(' y ');
    const week = limits && limits.windowMins === 10080 ? ' semanal' : ' de uso';
    const limit = level === 'reached' ? ' Ha agotado su límite de uso: hasta que se renueve no puede asesorar ni dibujar (la barra inferior dice cuándo).'
      : level === 'high' ? ` Ojo: lleva el ${Math.round(limits.pct)} % de su límite${week} (la barra inferior dice cuándo se renueva).` : '';
    text = `Codex detectado, con tu cuenta de ChatGPT.${doing ? ` Ahora mismo está ${doing}.` : ''}${limit} Pulsa para ver sus opciones.`;
  }
  badge.hidden = false;
  badge.dataset.state = !codexInfo.installed ? 'missing' : usable ? 'ready' : 'partial';
  badge.dataset.limit = level;
  badge.dataset.working = String(jobs.length > 0); // mientras trabaja, el punto y el nombre laten
  badge.title = text;
  badge.setAttribute('aria-label', text);
  const note = $('#codex-limit');
  note.hidden = !level;
  note.textContent = level === 'reached' ? 'agotado' : level ? `${Math.round(limits.pct)} %` : '';
  for (const [icon, id] of Object.entries(JOB_ICONS)) $(id).hidden = !jobs.some((job) => iconOf(job) === icon);
  tickCodexStatus();
}

// El tiempo que lleva cada cosa (la más antigua de cada icono), al segundo mientras trabaja.
let ticking = null;
function elapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function tickCodexStatus() {
  const jobs = codexInfo && codexInfo.usable ? codexInfo.jobs || [] : [];
  for (const [icon, id] of Object.entries(JOB_ICONS)) {
    const starts = jobs.filter((job) => iconOf(job) === icon).map((job) => job.startedAt);
    $(id).querySelector('.cx-time').textContent = starts.length ? elapsed(Date.now() - Math.min(...starts)) : '';
  }
  if (jobs.length && !ticking) ticking = setInterval(tickCodexStatus, 1000);
  else if (!jobs.length && ticking) { clearInterval(ticking); ticking = null; }
}
// Al pulsarlo: si Codex no se puede usar, se vuelve a comprobar (puede que acabe de
// instalarse o de iniciar sesión) y se dice cómo está; si se puede, se abren sus opciones.
export async function codexStatusClick() {
  if (codexInfo && codexInfo.usable) { toggleSettings(); return; }
  renderCodex(await api.codexStatus(true));
  if (codexInfo && codexInfo.usable) toast('Codex detectado, con tu cuenta de ChatGPT.');
  else toast($('#codex-status').title, 8000);
}

export async function toggleCodex() {
  if (!codexInfo || !codexInfo.usable) {
    // No disponible: se vuelve a comprobar por si acaba de instalarse o de iniciar sesión.
    renderCodex(await api.codexStatus(true));
    toast($('#codex-chip').title);
    return;
  }
  renderCodex(await api.codexSetEnabled(!codexInfo.enabled));
  if (!codexInfo.enabled) {
    toast('Imágenes con Codex desactivadas.');
    return;
  }
  // La herramienta se entrega al arrancar Claude: las sesiones ya abiertas no la tienen.
  const idle = [...views.values()].filter((v) => v.started && !v.codex && !v.closing && ['idle', 'done', 'failed'].includes(v.status));
  const busy = [...views.values()].filter((v) => v.started && !v.codex && !idle.includes(v)).length;
  if (!idle.length) {
    toast(busy ? 'Imágenes con Codex activadas. Las sesiones que están trabajando lo tendrán cuando las reinicies.' : 'Imágenes con Codex activadas.');
    return;
  }
  const choice = await api.choose({
    message: 'Imágenes con Codex activadas',
    detail: `Las sesiones ya abiertas necesitan reiniciarse para recibir la herramienta. Hay ${idle.length === 1 ? 'una sesión en reposo' : `${idle.length} sesiones en reposo`}: se pueden reiniciar ahora y conservan su conversación.`
      + (busy ? ' Las que están trabajando no se tocan.' : ''),
    buttons: ['Reiniciar las que están en reposo', 'Más tarde'],
  });
  if (choice === 0) for (const view of idle) if (views.has(view.tab.id)) restartSession(view);
}
