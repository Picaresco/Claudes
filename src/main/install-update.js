// Instalador de una actualización de Claudes. No forma parte de la app: Claudes
// lo copia a la carpeta de trabajo de la actualización y, al cerrarse, lo lanza
// con el node.exe del sistema (el mismo que ha generado el ejecutable).
//
//   node instalar.js <pid> <carpeta nueva> <carpeta del programa> <exe> <registro> <reabrir 0|1> [espera en s]
//
// La espera por defecto (2 minutos) basta cuando lo lanza Claudes al cerrarse;
// para dejarlo preparado a mano, a la espera de que se cierre, se le da más.
//
// Espera a que termine el proceso de Claudes, aparta la carpeta del programa
// como «<carpeta>.anterior», pone la nueva en su sitio y, si se pidió, vuelve a
// abrir Claudes. Si algo falla, deja (o recupera) la versión que había.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [pidArg, source, target, exe, logFile, relaunch, waitArg] = process.argv.slice(2);
const pid = Number(pidArg);
const waitSeconds = Number(waitArg) > 0 ? Number(waitArg) : 120;

const two = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function note(text) {
  try { fs.appendFileSync(logFile, `[${clock()}] instalador: ${text}\n`); } catch { /* sin registro */ }
}

function alive(id) {
  try { process.kill(id, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Claudes se reabre a través del Explorador, como con un doble clic: así arranca
// con el entorno normal del usuario y fuera de cualquier job de quien lanzó este
// instalador. Con una carpeta de datos de prueba se abre directamente para que
// conserve CLAUDES_USER_DATA y no choque con el Claudes de verdad.
function open(dir) {
  if (relaunch !== '1') return;
  try {
    const app = path.join(dir, exe);
    const child = process.env.CLAUDES_USER_DATA
      ? spawn(app, [], { cwd: dir, detached: true, stdio: 'ignore' })
      : spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [app], { cwd: dir, detached: true, stdio: 'ignore' });
    child.on('error', (err) => note(`no se pudo abrir Claudes: ${err.message}`));
    child.unref();
    note('Claudes se vuelve a abrir');
  } catch (err) {
    note(`no se pudo abrir Claudes: ${err.message}`);
  }
}

// Algunos archivos pueden seguir ocupados unos segundos tras el cierre
// (antivirus, consolas de las terminales): se reintenta durante medio minuto.
async function renameWithRetry(from, to) {
  let last = null;
  for (let i = 0; i < 60; i += 1) {
    try { fs.renameSync(from, to); return; } catch (err) { last = err; await sleep(500); }
  }
  throw last;
}

async function main() {
  if (!pid || !source || !target || !exe || !logFile) { note('parámetros incompletos'); return; }
  note(`esperando a que Claudes se cierre (proceso ${pid})`);
  const deadline = Date.now() + waitSeconds * 1000;
  while (alive(pid) && Date.now() < deadline) await sleep(500);
  if (alive(pid)) { note('Claudes sigue abierto: no se instala'); return; }
  if (!fs.existsSync(path.join(source, exe))) { note(`no está la versión nueva en ${source}`); open(target); return; }

  let backup = `${target}.anterior`;
  if (fs.existsSync(backup)) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* en uso */ } }
  if (fs.existsSync(backup)) backup = `${target}.anterior-${Date.now()}`;

  try {
    await renameWithRetry(target, backup);
  } catch (err) {
    note(`no se pudo apartar la versión instalada (${err.code || err.message}): se deja como estaba`);
    open(target);
    return;
  }

  try {
    try {
      fs.renameSync(source, target);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(source, target, { recursive: true }); // otra unidad: se copia
    }
    note(`versión nueva instalada en ${target} (la anterior queda en ${backup})`);
  } catch (err) {
    note(`fallo al colocar la versión nueva (${err.code || err.message}): se recupera la anterior`);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* no había nada */ }
    try { fs.renameSync(backup, target); } catch (e) { note(`no se pudo recuperar la anterior: ${e.message}`); }
  }
  open(target);
}

main().catch((err) => note(`error inesperado: ${(err && err.stack) || err}`));
