// Codex CLI: detecta si está instalado y con sesión de ChatGPT, y le pide imágenes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const GENERATE_TIMEOUT = 5 * 60 * 1000;

let codexPath; // undefined = sin buscar todavía; null = no encontrado

function findCodex() {
  if (codexPath !== undefined) return codexPath;
  let found = [];
  try {
    const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
    found = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
  } catch { /* no está en el PATH */ }
  codexPath = found.find((c) => /\.exe$/i.test(c)) || found.find((c) => /\.(cmd|bat)$/i.test(c)) || null;
  return codexPath;
}

// Un .cmd (instalación por npm) solo se puede lanzar a través del intérprete;
// los argumentos que se le pasan aquí nunca llevan texto del usuario.
const viaShell = (exe) => /\.(cmd|bat)$/i.test(exe);

function run(exe, args, timeout) {
  return new Promise((resolve) => {
    execFile(exe, args, { encoding: 'utf8', windowsHide: true, timeout, shell: viaShell(exe) }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: `${stdout || ''}\n${stderr || ''}` });
    });
  });
}

// Estado de Codex en este equipo:
//   mode 'chatgpt' → sesión iniciada con una suscripción de ChatGPT
//   mode 'apikey'  → sesión con clave de API (se factura aparte, no es la suscripción)
async function detect() {
  codexPath = undefined; // puede haberse instalado o desinstalado desde la última vez
  const exe = findCodex();
  if (!exe) return { installed: false, loggedIn: false, mode: null };
  const status = await run(exe, ['login', 'status'], 15000);
  const loggedIn = status.ok && /logged in/i.test(status.text) && !/not logged in/i.test(status.text);
  let mode = null;
  if (loggedIn) mode = /chatgpt/i.test(status.text) ? 'chatgpt' : 'apikey';
  return { installed: true, loggedIn, mode };
}

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// La imagen más reciente que Codex haya guardado desde `since`.
function newestGeneratedImage(since) {
  const root = path.join(codexHome(), 'generated_images');
  let best = null;
  const consider = (file) => {
    if (!IMAGE_FILE.test(file)) return;
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
    if (mtime >= since && (!best || mtime > best.mtime)) best = { file, mtime };
  };
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) { consider(full); continue; }
    let recent = false;
    try { recent = fs.statSync(full).mtimeMs >= since; } catch { /* carpeta borrada */ }
    if (!recent) continue; // hay miles de carpetas antiguas: solo se miran las tocadas ahora
    try { for (const name of fs.readdirSync(full)) consider(path.join(full, name)); } catch { /* sin acceso */ }
  }
  return best ? best.file : null;
}

function buildPrompt({ description, shape, transparent }) {
  const lines = [
    'Genera UNA sola imagen con tu herramienta de generación de imágenes y nada más.',
    '',
    'Descripción de la imagen:',
    description,
    '',
  ];
  if (shape) lines.push(`Proporción: ${shape}.`);
  if (transparent) lines.push('El fondo debe ser transparente.');
  lines.push(
    'No escribas código, no crees ni modifiques otros archivos y no pidas aclaraciones: si falta algún detalle, decídelo tú.',
    'Al terminar, responde únicamente con la ruta absoluta del archivo de imagen generado.',
  );
  return lines.join('\n');
}

// Elige un nombre libre para no pisar un archivo que ya exista.
function freePath(wanted) {
  if (!fs.existsSync(wanted)) return wanted;
  const { dir, name, ext } = path.parse(wanted);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return wanted;
}

function resolveOutput(cwd, file) {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  let target = typeof file === 'string' && file.trim() ? file.trim() : `imagen-codex-${stamp}.png`;
  if (!path.isAbsolute(target)) target = path.join(cwd, target);
  if (!/\.png$/i.test(target)) target += '.png';
  target = path.normalize(target);
  // Solo dentro de la carpeta de la sesión: lo que haya que mover fuera lo hará
  // Claude con sus propias herramientas y permisos.
  const relative = path.relative(cwd, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`La imagen solo se puede guardar dentro de la carpeta de la sesión (${cwd}).`);
  }
  return freePath(target);
}

// Pide una imagen a Codex y la copia a la carpeta de la sesión.
// Devuelve { path } o lanza un error con un mensaje explicable al usuario.
function generateImage({ description, shape, transparent, file, cwd, workDir }) {
  return new Promise((resolve, reject) => {
    const exe = findCodex();
    if (!exe) { reject(new Error('Codex no está instalado en este equipo.')); return; }
    if (typeof description !== 'string' || !description.trim()) { reject(new Error('Falta la descripción de la imagen.')); return; }
    let target;
    try {
      target = resolveOutput(cwd, file); // se comprueba antes de gastar una generación
    } catch (err) {
      reject(err);
      return;
    }

    fs.mkdirSync(workDir, { recursive: true });
    const started = Date.now() - 2000; // margen por la resolución del reloj del disco
    // La petición va por la entrada estándar («-»): así no hay límites ni comillas que escapar.
    // --ephemeral: no deja la petición en el historial de sesiones de Codex.
    // --sandbox read-only: Codex no puede cambiar nada del equipo; la imagen la guarda él en su carpeta.
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '-C', workDir, '-'];
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: viaShell(exe) });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ya había salido */ }
      finish(reject, new Error('Codex ha tardado más de 5 minutos y se ha cancelado la petición.'));
    }, GENERATE_TIMEOUT);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish(reject, new Error(`No se pudo ejecutar Codex: ${err.message}`)));
    child.on('close', (code) => {
      // Cada línea es un evento JSON; interesan el último mensaje de Codex y los errores.
      let lastMessage = '';
      let failure = '';
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') lastMessage = String(event.item.text || '');
        if (event.type === 'error' || event.type === 'turn.failed') failure = String(event.message || (event.error && event.error.message) || failure);
      }

      const named = lastMessage.trim().replace(/^["'`]+|["'`]+$/g, '');
      const source = IMAGE_FILE.test(named) && fs.existsSync(named) ? named : newestGeneratedImage(started);
      if (!source) {
        const reason = failure || lastMessage.trim() || stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `Codex terminó con el código ${code}.`;
        finish(reject, new Error(`Codex no ha generado ninguna imagen. ${reason}`.slice(0, 800)));
        return;
      }
      try {
        const final = freePath(target); // por si alguien creó ese archivo mientras tanto
        fs.mkdirSync(path.dirname(final), { recursive: true });
        fs.copyFileSync(source, final);
        finish(resolve, { path: final });
      } catch (err) {
        finish(reject, new Error(`La imagen se generó (${source}) pero no se pudo copiar a su destino: ${err.message}`));
      }
    });

    child.stdin.on('error', () => { /* Codex cerró la entrada antes de tiempo */ });
    child.stdin.end(buildPrompt({ description: description.trim(), shape, transparent }));
  });
}

// La herramienta tal como la ve Claude en sus sesiones.
const IMAGE_TOOL = {
  name: 'generar_imagen',
  description: 'Genera una imagen nueva (ilustración, icono, logotipo, foto, textura, sprite, maqueta de pantalla…) '
    + 'con la suscripción de Codex del usuario y la guarda como PNG dentro de la carpeta de la sesión. '
    + 'Suele tardar entre 20 y 90 segundos. Devuelve la ruta del archivo; ábrelo con Read si necesitas ver el resultado. '
    + 'Cada llamada consume una generación del plan de Codex del usuario: úsala cuando haga falta una imagen de verdad, no para probar.',
  inputSchema: {
    type: 'object',
    properties: {
      descripcion: {
        type: 'string',
        description: 'Qué debe mostrar la imagen: sujeto, estilo, colores, composición y cualquier texto que deba aparecer escrito.',
      },
      archivo: {
        type: 'string',
        description: 'Dónde guardarla, relativo a la carpeta de la sesión (por ejemplo "assets/portada.png"). Si se omite, se guarda como imagen-codex-<fecha>.png. No sobrescribe: si el archivo existe, se añade un número al nombre.',
      },
      formato: {
        type: 'string',
        enum: ['cuadrada', 'horizontal', 'vertical'],
        description: 'Proporción de la imagen.',
      },
      fondo_transparente: {
        type: 'boolean',
        description: 'true para pedir la imagen con fondo transparente.',
      },
    },
    required: ['descripcion'],
  },
};

module.exports = { detect, generateImage, IMAGE_TOOL };
