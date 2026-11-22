// ── Registro de depuración ───────────────────────────────────────
import { api, $ } from './dom.js';
import { toast } from './state.js';

let debugInfo = null;

export function renderDebug(info) {
  if (info) debugInfo = info;
  const button = $('#sb-debug');
  if (!debugInfo) { button.hidden = true; return; }
  button.hidden = false;
  button.setAttribute('aria-pressed', String(debugInfo.enabled));
  button.title = debugInfo.enabled
    ? `Cada sesión de Claude guarda un registro detallado en ${debugInfo.dir} (se borran solos a la semana). Pulsa para desactivarlo. Los registros se abren con el botón derecho sobre una pestaña.`
    : 'Las sesiones no guardan registro de depuración. Pulsa para activarlo.';
}

export async function toggleDebug() {
  if (!debugInfo) return;
  renderDebug(await api.debugSet(!debugInfo.enabled));
  toast(debugInfo.enabled
    ? 'Depuración activada: las sesiones que abras o reinicies a partir de ahora guardan su registro.'
    : 'Depuración desactivada. Las sesiones ya abiertas siguen registrando hasta que se reinicien.');
}
