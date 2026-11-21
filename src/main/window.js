// La ventana de la app: tamaño y posición recordados, aviso al cerrar con sesiones
// trabajando y las ayudas de desarrollo (consola de la interfaz y capturas).
const fs = require('fs');
const path = require('path');

const CLOSE_BUTTONS = ['Guardar estado y cerrar', 'Cerrar ya', 'Cancelar'];

// electron: { app, BrowserWindow, dialog, screen }; store: el guardado de la app;
// log(texto): registro de la app; dev: se ejecuta desde el código;
// onCloseCancelled(): el usuario ha elegido «Cancelar» al preguntarle si cerrar.
function createWindowManager({ electron, store, log, dev, onCloseCancelled }) {
  const { app, BrowserWindow, dialog, screen } = electron;
  let win = null;
  let busy = 0; // sesiones trabajando o esperándote: se pregunta antes de cerrar
  let closeApproved = false; // el usuario ya ha decidido cerrar aunque haya sesiones trabajando
  let closeDialogOpen = false;

  function initialBounds() {
    const saved = store.get('window', null);
    const fallback = { width: 1360, height: 860 };
    if (!saved || !(saved.width > 0) || !(saved.height > 0)) return fallback;
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => (
      saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80
      && saved.y >= a.y - 20 && saved.y < a.y + a.height - 80
    ));
    const size = { width: saved.width, height: saved.height };
    return onScreen ? { ...size, x: saved.x, y: saved.y } : size;
  }

  function show() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // Avisa a la interfaz por un canal.
  function send(channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }

  function create() {
    win = new BrowserWindow({
      ...initialBounds(),
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'ClaudHome',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
      backgroundColor: '#0C0E11',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0C0E11', symbolColor: '#A9AFB9', height: 50 },
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    if (store.get('window', {}).maximized) win.maximize();

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => (process.env.CLAUDES_SHOT ? win.showInactive() : win.show()));

    let boundsTimer = null;
    const rememberBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (!win || win.isDestroyed() || win.isMinimized()) return;
        store.set('window', { ...win.getNormalBounds(), maximized: win.isMaximized() });
      }, 400);
    };
    win.on('resize', rememberBounds);
    win.on('move', rememberBounds);
    win.on('focus', () => win.flashFrame(false));

    win.on('close', (event) => {
      if (closeApproved || busy === 0) { store.flush(); return; }
      // Hay sesiones trabajando: se pregunta antes de cerrar.
      event.preventDefault();
      if (closeDialogOpen) return;
      closeDialogOpen = true;
      const n = busy;
      const ask = (dev && process.env.CLAUDES_AUTO_CONFIRM)
        ? () => Promise.resolve({ response: 0 }) // solo para pruebas automáticas
        : (options) => dialog.showMessageBox(win, options);
      ask({
        type: 'question',
        message: n === 1 ? 'Claude está trabajando en una sesión' : `Claude está trabajando en ${n} sesiones`,
        detail: '«Guardar estado y cerrar» pide a Claude que pare y deje anotado por dónde iba, para retomarlo al volver. '
          + '«Cerrar ya» interrumpe el trabajo en el punto en que esté; la conversación queda guardada igualmente.',
        buttons: CLOSE_BUTTONS,
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }).then(({ response }) => {
        closeDialogOpen = false;
        if (response === 2) onCloseCancelled(); // ya no se cierra
        if (!win) return;
        if (response === 1) { closeApproved = true; win.close(); }
        else if (response === 0) send('app:wrapup'); // la interfaz avisa con app:closeNow al terminar
      });
    });
    win.on('closed', () => { win = null; });

    // La interfaz es un único documento local: ni ventanas nuevas ni navegación.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
    // Si la interfaz se cae o deja de responder, que quede constancia.
    win.webContents.on('render-process-gone', (_event, details) => log(`la interfaz se ha caído: ${details.reason} (código ${details.exitCode})`));
    win.on('unresponsive', () => log('la ventana ha dejado de responder'));
    win.on('responsive', () => log('la ventana vuelve a responder'));

    if (dev) devTools();
  }

  // Ayudas solo para desarrollo: mensajes de la interfaz en la consola y captura
  // de la ventana a un PNG (CLAUDES_SHOT) tras ejecutar un guion (CLAUDES_TEST_JS).
  function devTools() {
    win.webContents.on('console-message', (event, ...legacy) => {
      const message = event && event.message !== undefined ? event.message : legacy[1];
      const level = event && event.level !== undefined ? event.level : legacy[0];
      console.log(`[interfaz:${level}] ${message}`);
    });
    const shot = process.env.CLAUDES_SHOT;
    if (!shot) return;
    const delay = Number(process.env.CLAUDES_SHOT_DELAY) || 4000;
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.CLAUDES_TEST_JS) {
            const result = await win.webContents.executeJavaScript(fs.readFileSync(process.env.CLAUDES_TEST_JS, 'utf8'), true);
            if (result !== undefined) console.log('[guion]', JSON.stringify(result));
          }
          const image = await win.webContents.capturePage();
          fs.writeFileSync(shot, image.toPNG());
          console.log('[captura]', shot);
        } catch (err) {
          console.error('[captura] error:', err.message);
        }
        if (process.env.CLAUDES_SHOT_QUIT) { busy = 0; app.quit(); }
      }, delay);
    });
  }

  return {
    create,
    show,
    send,
    // Cierra por el camino normal: si hay sesiones trabajando, pregunta antes.
    close() { if (win) win.close(); },
    // Cierra sin preguntar: el usuario ya lo ha decidido.
    closeNow() { closeApproved = true; if (win) win.close(); },
    setBusy(n) { busy = Math.max(0, Number(n) || 0); },
    get win() { return win; },
  };
}

module.exports = { createWindowManager };
