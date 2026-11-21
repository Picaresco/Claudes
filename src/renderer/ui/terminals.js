// ── Terminales ───────────────────────────────────────────────────
import { hasFiles, droppedPaths } from './context.js';
import { api, $ } from './dom.js';
import { imageLabelCounts, learnImageLabels } from './preview.js';
import { info, voiceOn, fontSizeFor, sleep, toast } from './state.js';
import { setZoom } from './views.js';

export function makeTerminal(zoom, theme) {
  const term = new Terminal({
    fontFamily: "'IBM Plex Mono', 'Cascadia Mono', Consolas, monospace",
    fontSize: fontSizeFor(zoom),
    fontWeightBold: '600',
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
    theme,
    windowsPty: info.windowsBuild ? { backend: 'conpty', buildNumber: info.windowsBuild } : undefined,
    linkHandler: { activate: (_event, uri) => { if (/^https?:\/\//i.test(uri)) api.openPath(uri); } },
  });
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => api.openPath(uri)));
  // Anchos de carácter modernos: los emojis (la marca verde U+2705, el candado
  // U+1F512…) ocupan 2 columnas y los compuestos (con tono de piel, ZWJ) cuentan
  // como uno, igual que los calculan Claude Code y Windows Terminal. Con la tabla
  // Unicode 6 que trae xterm por defecto ocupaban 1, y cada uno descuadraba una
  // columna lo que Claude Code redibuja (tablas torcidas, letras que saltaban al
  // final de la línea anterior).
  term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  term.unicode.activeVersion = '15-graphemes';
  return term;
}

// Rutas listas para pegar en una terminal: entre comillas si llevan espacios.
const quotePath = (file) => (/\s/.test(file) ? `"${file}"` : file);
export const joinPaths = (files) => `${files.map(quotePath).join(' ')} `;

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Pega lo que haya en el portapapeles: archivos copiados en el Explorador (sus
// rutas), texto, o una imagen copiada (se guarda como archivo y se pega su ruta).
// Claude Code adjunta por sí mismo las imágenes cuya ruta se pega. `view` solo
// llega en la terminal de Claude: allí se apunta qué [Image #n] es cada imagen.
async function paste(term, view) {
  let clip;
  try {
    clip = await api.clipboardRead();
  } catch {
    toast('No se ha podido leer el portapapeles.');
    return;
  }
  await pasteClip(term, view, clip);
}

export async function pasteClip(term, view, clip) {
  const before = view ? imageLabelCounts(view.term) : null;
  let pasted = [];
  if (clip.files.length) {
    // De uno en uno, para que Claude Code reconozca cada imagen por separado. Al
    // convertir una imagen en [Image #n] se come el espacio de detrás: se repone.
    let afterImage = false;
    for (const file of clip.files) {
      term.paste(`${afterImage ? ' ' : ''}${joinPaths([file])}`);
      afterImage = IMAGE_FILE.test(file);
      await sleep(120);
    }
    pasted = clip.files;
  } else if (clip.text) {
    term.paste(clip.text);
    pasted = pathsInText(clip.text); // la ruta de una imagen pegada como texto también se convierte
  } else if (clip.imagePath) {
    term.paste(joinPaths([clip.imagePath]));
    pasted = [clip.imagePath];
  } else {
    toast('El portapapeles está vacío o contiene algo que no se puede pegar aquí.');
  }
  if (view) learnImageLabels(view, pasted, before);
}

// Rutas de un texto pegado que solo contiene rutas (una o varias, con o sin comillas).
function pathsInText(text) {
  const paths = (text.trim().match(/"[^"]+"|\S+/g) || []).map((token) => token.replace(/^"|"$/g, ''));
  return paths.length && paths.every((p) => /^[A-Za-z]:[\\/]/.test(p)) ? paths : [];
}

function copySelection(term) {
  api.clipboardWrite(term.getSelection());
  term.clearSelection();
}

export function wireKeys(term, ptyId, view, isClaude) {
  term.attachCustomKeyEventHandler((e) => {
    const key = (e.key || '').toLowerCase();
    const plainCtrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (isClaude && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      // Mayús+Intro = salto de línea sin enviar (equivale a Ctrl+J en Claude Code).
      if (e.type === 'keydown') { e.preventDefault(); api.ptyWrite(ptyId, '\n'); }
      return false;
    }
    // Con el micrófono apagado, mantener la barra espaciadora escribe un solo
    // espacio: sin sus repeticiones, Claude Code no detecta la pulsación larga
    // con la que empieza a dictar. Encendido, le llegan y Claude graba.
    if (isClaude && !voiceOn && e.repeat && e.key === ' ') { e.preventDefault(); return false; }
    if (e.type !== 'keydown') return true;
    if (plainCtrl && key === 'c' && term.hasSelection()) { e.preventDefault(); copySelection(term); return false; }
    if (plainCtrl && key === 'v') { e.preventDefault(); paste(term, isClaude ? view : null); return false; }
    return true;
  });
}

export function wireHost(host, term, ptyId, view, isClaude) {
  // Botón derecho: copia si hay texto seleccionado; si no, pega.
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(term);
    else paste(term, isClaude ? view : null);
  });
  // Soltar archivos sobre la terminal extra pega sus rutas. Sobre la de Claude se
  // elige entre pegarlos o añadirlos al contexto del proyecto (wireDropChoice).
  if (!isClaude) {
    host.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    host.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = droppedPaths(e);
      if (!files.length) return;
      term.paste(joinPaths(files));
      term.focus();
    });
  }
  host.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    setZoom(view, (view.tab.zoom || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false, capture: true });
  host.addEventListener('focusin', () => { view.lastFocus = isClaude ? 'claude' : 'extra'; });
}
