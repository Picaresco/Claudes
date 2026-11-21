// ── Vista dividida ───────────────────────────────────────────────
import { $ } from './dom.js';
import { renderAll, layout } from './render.js';
import { acknowledge } from './session-events.js';
import { S, mru, byId, save, touchMru, toast } from './state.js';
import { activate } from './tabs.js';
import { focusTerminal } from './views.js';

export function toggleSplit() {
  if (S.split) {
    S.activeId = S.split[S.focusSide];
    S.split = null;
  } else {
    if (S.tabs.length < 2) { toast('Abre otra sesión para poder ver dos a la vez.'); return; }
    const other = mru.find((x) => x !== S.activeId && byId(x)) || S.tabs.find((t) => t.id !== S.activeId).id;
    S.split = { left: S.activeId, right: other, ratio: 0.5 };
    S.focusSide = 'left';
  }
  layout();
  save();
}

export function swapSides() {
  if (!S.split) return;
  [S.split.left, S.split.right] = [S.split.right, S.split.left];
  S.focusSide = S.focusSide === 'left' ? 'right' : 'left';
  layout();
  save();
}

export function focusSide(side, focus = true) {
  if (!S.split || S.focusSide === side) return;
  S.focusSide = side;
  S.activeId = S.split[side];
  touchMru(S.activeId);
  renderAll();
  acknowledge();
  if (focus) focusTerminal();
  save();
}

// Soltar una pestaña sobre la zona de trabajo la coloca en ese lado.
export function dropOnWorkspace(id, clientX) {
  const box = $('#workspace').getBoundingClientRect();
  let side = clientX < box.left + box.width / 2 ? 'left' : 'right';
  if (S.split) {
    const edge = box.left + box.width * (S.split.ratio || 0.5);
    side = clientX < edge ? 'left' : 'right';
    activate(id, side);
    return;
  }
  // Sin división todavía: la pestaña soltada va a ese lado y al otro, la que
  // estaba a la vista (o la última usada, si se arrastra la propia pestaña activa).
  const fallback = S.tabs.find((t) => t.id !== id);
  const otherId = id === S.activeId ? (mru.find((x) => x !== id && byId(x)) || (fallback && fallback.id)) : S.activeId;
  if (!otherId) { activate(id); return; }
  S.split = side === 'left'
    ? { left: id, right: otherId, ratio: 0.5 }
    : { left: otherId, right: id, ratio: 0.5 };
  S.focusSide = side;
  touchMru(id);
  layout();
  save();
}
