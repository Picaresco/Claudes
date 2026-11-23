// Interfaz de Claudes: pestañas, vista dividida, terminal extra, recientes y avisos.
// Este archivo es la entrada: restaura el estado guardado y conecta los módulos de ui/.
import { renderCodex, codexInfo } from './ui/codex.js';
import { setOptimizeHint } from './ui/optimize.js';
import { COLORS, BASE_FONT, MAX_RECENTS } from './ui/constants.js';
import { cleanContext, addToContext, addLinks } from './ui/context.js';
import { renderDebug } from './ui/debug.js';
import { api, $ } from './ui/dom.js';
import { wireTabs, wireChrome, wireDialog, wireKeyboard } from './ui/events.js';
import { setLimitsSnap, renderPlanLimits } from './ui/limits.js';
import { wireLog } from './ui/log.js';
import { baseName } from './ui/newtab.js';
import { wireRainbow } from './ui/rainbow.js';
import { renderTabs, renderStatusbar, layout } from './ui/render.js';
import { onHook, onPtyExit, onReviewResult } from './ui/session-events.js';
import { createView } from './ui/sessions.js';
import { sleepAfterMs, setSleepAfterMs, sleepIdleSessions } from './ui/sleep.js';
import { S, views, terms, info, setInfo, byId, clamp, touchMru, toast } from './ui/state.js';
import { setStatus, wrapUp, gracefulExit } from './ui/status.js';
import { activate } from './ui/tabs.js';
import { pasteClip } from './ui/terminals.js';
import { renderVoice, renderBrief, renderReview } from './ui/toggles.js';
import { renderUpdate } from './ui/update.js';

// ── Arranque ─────────────────────────────────────────────────────

function restore(saved) {
  if (!saved || typeof saved !== 'object') return;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const validColor = (v) => (COLORS.some((c) => c.key === v) ? v : '');
  const validShell = (v) => (info.shells.some((s) => s.key === v) ? v : 'powershell');
  const seen = new Set();
  for (const raw of Array.isArray(saved.tabs) ? saved.tabs : []) {
    if (!raw || typeof raw.id !== 'string' || !raw.cwd || seen.has(raw.id)) continue;
    seen.add(raw.id);
    S.tabs.push({
      id: raw.id,
      name: text(raw.name, 60) || baseName(String(raw.cwd)),
      cwd: String(raw.cwd),
      color: validColor(raw.color),
      shell: validShell(raw.shell),
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      zoom: clamp(Number(raw.zoom) || 1, 0.6, 2.4),
      extraOpen: Boolean(raw.extraOpen),
      extraHeight: Number(raw.extraHeight) || 0,
      context: cleanContext(raw.context),
      contextOpen: Boolean(raw.contextOpen),
    });
  }
  for (const raw of Array.isArray(saved.recents) ? saved.recents : []) {
    if (!raw || !raw.cwd || S.recents.length >= MAX_RECENTS) continue;
    S.recents.push({
      name: text(raw.name, 60) || baseName(String(raw.cwd)),
      cwd: String(raw.cwd),
      color: validColor(raw.color),
      shell: validShell(raw.shell),
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      zoom: clamp(Number(raw.zoom) || 1, 0.6, 2.4),
      extraHeight: Number(raw.extraHeight) || 0,
      context: cleanContext(raw.context),
    });
  }
  S.activeId = typeof saved.activeId === 'string' ? saved.activeId : null;
  S.focusSide = saved.focusSide === 'right' ? 'right' : 'left';
  S.lastShell = validShell(saved.lastShell);
  if (saved.split && typeof saved.split === 'object') {
    S.split = { left: saved.split.left, right: saved.split.right, ratio: clamp(Number(saved.split.ratio) || 0.5, 0.2, 0.8) };
  }
}

async function init() {
  setInfo(await api.info());
  // Animación de arranque: corre por encima mientras la app se prepara debajo (no se espera).
  if (info.splash === false) window.ClaudHomeSplash.remove($('#splash'));
  else window.ClaudHomeSplash.play({ root: $('#splash'), freezeAt: info.splashAt }).catch(() => window.ClaudHomeSplash.remove($('#splash')));
  $('#app-version').textContent = info.version ? `v${info.version}` : '';
  setSleepAfterMs((info.sleepMinutes || 45) * 60 * 1000);
  setInterval(sleepIdleSessions, Math.min(60 * 1000, Math.max(1000, sleepAfterMs / 4)));
  // Solo al ejecutar desde el código: pegar texto en la pestaña activa como si
  // viniera del portapapeles, para las pruebas automáticas (CLAUDES_TEST_JS).
  if (info.dev) {
    window.claudesTest = {
      pasteText: (text) => {
        const view = views.get(S.activeId);
        return view ? pasteClip(view.term, view, { files: [], text, imagePath: null }) : null;
      },
      addContext: (paths) => {
        const view = views.get(S.activeId);
        if (view) addToContext(view, paths);
      },
      addLinks: (urls) => {
        const view = views.get(S.activeId);
        return view ? addLinks(view, urls) : false;
      },
      // Pone el indicador de Codex como si su estado fuera otro (los campos que se den).
      showCodex: (fields) => renderCodex({ ...(codexInfo || {}), ...fields }),
      // Pone una pestaña en un estado, para ver cómo se pinta.
      showStatus: (index, status) => {
        const tab = S.tabs[index];
        const view = tab && views.get(tab.id);
        if (view) setStatus(view, status);
        return Boolean(view);
      },
      // Mide cómo rinde la terminal de la pestaña activa: vuelca `megas` MB de salida
      // con colores y devuelve lo que tarda en procesarla y cómo se ha ido pintando.
      benchTerminal: (megas = 4) => new Promise((resolve) => {
        const view = views.get(S.activeId);
        if (!view) { resolve(null); return; }
        const line = `\x1b[32m${'abcdefghij'.repeat(6)}\x1b[0m \x1b[1;34m${'0123456789'.repeat(3)}\x1b[0m normal\r\n`;
        const chunk = line.repeat(Math.ceil(65536 / line.length));
        const chunks = Math.ceil((megas * 1024 * 1024) / chunk.length);
        let frames = 0;
        let worst = 0;
        let last = performance.now();
        let running = true;
        const tick = (now) => { frames += 1; worst = Math.max(worst, now - last); last = now; if (running) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        const start = performance.now();
        for (let i = 0; i < chunks; i += 1) {
          view.term.write(chunk, i === chunks - 1 ? () => {
            const ms = performance.now() - start;
            running = false;
            const mb = (chunks * chunk.length) / 1024 / 1024;
            resolve({ megas: Math.round(mb * 10) / 10, ms: Math.round(ms), mbPorSegundo: Math.round((mb / ms) * 10000) / 10, fotogramas: frames, fotogramasPorSegundo: Math.round(frames / (ms / 1000)), peorParonMs: Math.round(worst) });
          } : undefined);
        }
      }),
    };
  }
  restore(await api.loadState());

  // xterm mide la letra al abrirse: las fuentes tienen que estar cargadas antes.
  await Promise.all([
    document.fonts.load(`${BASE_FONT}px 'IBM Plex Mono'`),
    document.fonts.load(`600 ${BASE_FONT}px 'IBM Plex Mono'`),
    document.fonts.load("14px 'IBM Plex Sans'"),
  ]).catch(() => { /* se usarán las fuentes de reserva */ });

  wireChrome();
  wireRainbow();
  wireLog();
  wireTabs();
  wireDialog();
  wireKeyboard();

  api.onPtyData((id, data) => { const term = terms.get(id); if (term) term.write(data); });
  api.onPtyExit(onPtyExit);
  api.onHook(onHook);
  api.onUsage((tabId, usage) => {
    const view = views.get(tabId);
    if (!view) return;
    view.usage = usage;
    renderTabs();
    renderStatusbar();
  });
  let limitsArrived = false;
  const takeLimits = (snap) => {
    if (!snap || typeof snap !== 'object') return;
    limitsArrived = true;
    setLimitsSnap({ plan: snap.plan || null, conversations: snap.conversations || {} });
    renderStatusbar();
  };
  api.onLimits(takeLimits);
  api.limitsGet().then((snap) => { if (!limitsArrived) takeLimits(snap); }).catch(() => { /* sin límites */ });
  // «hoy a las 21:00» pasa a ser «ayer…» con el cambio de día.
  setInterval(renderPlanLimits, 60 * 1000);
  api.onNotifyClick((tabId) => { if (byId(tabId)) activate(tabId); });
  api.onOptimizeHint(setOptimizeHint);
  api.onCodexChanged((codexState) => {
    renderCodex(codexState);
    api.reviewGet().then(renderReview).catch(() => { /* sin botón «Codex asesora» */ });
  });
  api.codexStatus(false).then(renderCodex).catch(() => { /* sin indicador hasta la próxima comprobación */ });
  api.debugGet().then(renderDebug).catch(() => { /* sin interruptor de depuración */ });
  api.voiceGet().then(renderVoice).catch(() => { /* sin botón de micrófono */ });
  api.briefGet().then(renderBrief).catch(() => { /* sin botón «Resumido» */ });
  api.reviewGet().then(renderReview).catch(() => { /* sin botón «Codex asesora» */ });
  api.onReviewResult(onReviewResult);
  api.onUpdateChanged(renderUpdate);
  api.updateGet().then((u) => {
    renderUpdate(u);
    // Resultado de la actualización instalada al cerrar la vez anterior.
    if (u && u.result) {
      toast(u.result.ok
        ? `ClaudHome se ha actualizado a la versión ${u.result.version}.`
        : `No se ha podido instalar ClaudHome ${u.result.version}. Los detalles están en la carpeta de registros.`);
    }
  }).catch(() => { /* sin botón de actualizar */ });
  // Los errores de la interfaz también quedan en el registro de la app.
  window.addEventListener('error', (e) => api.log(`ERROR: ${e.message} (${String(e.filename).split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => api.log(`promesa rechazada: ${(e.reason && e.reason.stack) || e.reason}`));
  // Cierre de la app con «Guardar estado y cerrar»: cada sesión que trabaja deja
  // anotado su estado y, cuando todas han terminado, la app se cierra.
  api.onWrapUpAll(async () => {
    const busy = [...views.values()].filter((v) => v.started && (v.closing || ['working', 'reviewing', 'planreview', 'consulting', 'needs'].includes(v.status)));
    if (busy.length) toast(busy.length === 1 ? 'Claude está guardando su estado antes de cerrar…' : 'Las sesiones están guardando su estado antes de cerrar…', true);
    await Promise.all(busy.map(async (view) => {
      const result = await wrapUp(view);
      if (result === 'saved' && views.has(view.tab.id)) await gracefulExit(view);
    }));
    api.closeNow();
  });

  for (const tab of S.tabs) createView(tab, 'resume');
  if (S.activeId) touchMru(S.activeId);
  layout();

  if (!info.claudeFound) toast('No encuentro Claude Code en este equipo: instálalo o añádelo al PATH.');
}

init();
