// ── Constantes ───────────────────────────────────────────────────

export const COLORS = [
  { key: '', name: 'Sin color', hex: '' },
  { key: 'blue', name: 'Azul', hex: '#6AA5F8' },
  { key: 'amber', name: 'Ámbar', hex: '#F2B866' },
  { key: 'pink', name: 'Rosa', hex: '#E88DBA' },
  { key: 'green', name: 'Verde', hex: '#7FD4A0' },
];
export const colorHex = (key) => (COLORS.find((c) => c.key === key) || COLORS[0]).hex;

export const BASE_FONT = 14;
export const MAX_RECENTS = 8;
export const SIDES = ['left', 'right'];

export const SVG = {
  // Estado de la sesión: verde = activa (girando si trabaja, parpadeando si ha
  // terminado sin que lo vieras), rojo parpadeando = te necesita, ámbar = se ha
  // detenido por un error, gris girando = arrancando, punteado = sin iniciar o cerrada.
  working: '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#3A414D" stroke-width="2"/><path d="M8 2a6 6 0 0 1 0 12" fill="none" stroke="#7FD4A0" stroke-width="2" stroke-linecap="round"/></svg>',
  starting: '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#3A414D" stroke-width="2"/><path d="M8 2a6 6 0 0 1 0 12" fill="none" stroke="#8B929D" stroke-width="2" stroke-linecap="round"/></svg>',
  attn: '<svg class="dot-attn" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#F26B6B" fill-opacity="0.28"/><circle cx="8" cy="8" r="4.2" fill="#F26B6B"/></svg>',
  done: '<svg class="dot-attn" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#7FD4A0" fill-opacity="0.28"/><circle cx="8" cy="8" r="4.2" fill="#7FD4A0"/></svg>',
  failed: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#F2B866" fill-opacity="0.22"/><circle cx="8" cy="8" r="4.2" fill="#F2B866"/></svg>',
  idle: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#7FD4A0" fill-opacity="0.18"/><circle cx="8" cy="8" r="4.2" fill="#7FD4A0"/></svg>',
  off: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="#8B929D" stroke-width="1.5" stroke-dasharray="2.4 2.4"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
  update: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11"/></svg>',
  terminal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3"/></svg>',
};

// El color de la pestaña la distingue; el punto, su estado. «tone» marca los estados
// que piden que mires la pestaña (y con qué color se escribe su nombre en la cabecera).
export const STATUS = {
  asleep: { icon: 'off', label: 'Sin iniciar' },
  starting: { icon: 'starting', label: 'Iniciando' },
  idle: { icon: 'idle', label: 'Activa, esperando tu mensaje' },
  working: { icon: 'working', label: 'Trabajando' },
  reviewing: { icon: 'working', label: 'Codex está revisando el código' },
  needs: { icon: 'attn', label: 'Te necesita', tone: 'alert' },
  done: { icon: 'done', label: 'Ha terminado', tone: 'done' },
  failed: { icon: 'failed', label: 'Se ha detenido por un error', tone: 'warn' },
  closing: { icon: 'starting', label: 'Guardando su estado para cerrar' },
  exited: { icon: 'off', label: 'Sesión cerrada' },
  sleeping: { icon: 'off', label: 'Dormida para ahorrar memoria: se retoma al abrirla' },
};

// Lo que se le escribe a Claude cuando se cierra una sesión que está trabajando.
export const WRAPUP_PROMPT = 'Voy a cerrar esta sesión ahora. No continúes con la tarea: deja lo que estabas haciendo en un estado coherente y escribe un resumen breve de qué has hecho, qué queda pendiente y cuál es el siguiente paso, para retomarlo cuando vuelva a abrir esta sesión.';

export const THEME = {
  background: '#14171C',
  foreground: '#E7E9EC',
  cursor: '#E7E9EC',
  cursorAccent: '#14171C',
  selectionBackground: 'rgba(106, 165, 248, 0.35)',
  black: '#1B1F26', red: '#F47067', green: '#7FD4A0', yellow: '#F2B866',
  blue: '#6AA5F8', magenta: '#E88DBA', cyan: '#56C8D8', white: '#C9CED6',
  brightBlack: '#6E7681', brightRed: '#FF8A80', brightGreen: '#9BE3B8', brightYellow: '#F7CE8A',
  brightBlue: '#8DBBFA', brightMagenta: '#F0A9CE', brightCyan: '#7FDBE8', brightWhite: '#FFFFFF',
};
export const THEME_EXTRA = { ...THEME, background: '#0C0E11', cursorAccent: '#0C0E11' };
