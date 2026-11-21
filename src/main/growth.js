// Buena práctica para cualquier proyecto: avisar cuando un archivo de código crece mucho.
//
// Cuando Claude edita un archivo que llega a 1 000 líneas, y otra vez cada vez que crece
// un 20 % más (1 200, 1 440, 1 728…), la app se lo dice en ese mismo momento para que
// valore si conviene partirlo y se lo comente al usuario. Es un aviso, no un freno: las
// líneas son solo un indicio, y Claude no parte nada sin que se lo pidan.
//
// - El aviso viaja en la respuesta al hook PostToolUse de la herramienta que edita.
// - De cada proyecto (la carpeta de la pestaña) se recuerda con cuántas líneas se avisó
//   de cada archivo, para no repetirlo hasta el siguiente escalón. Se guarda con el
//   estado de la app, no en el proyecto.
// - Solo cuenta el código: ni documentos, ni datos, ni estilos.
// La misma escalera la usa scripts/sizes.mjs para el aviso de npm test de este proyecto.
const fs = require('fs');
const path = require('path');

const FIRST = 1000;
const GROWTH = 1.2;
const MAX_BYTES = 5 * 1024 * 1024; // un archivo mayor no es código escrito a mano
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|ps1|psm1|sh|bat|cmd|sql|c|h|cc|cpp|hpp|cs|java|kt|go|rs|rb|php|vue|svelte|swift|lua|pl|r|scala|dart)$/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// El escalón que le toca a un archivo del que ya se avisó con `reviewed` líneas (0 = nunca):
// el primero de 1 000, 1 200, 1 440… que queda por encima.
function nextStep(reviewed = 0) {
  let step = FIRST;
  while (step <= reviewed) step = Math.round(step * GROWTH);
  return step;
}

const needsReview = (lines, reviewed = 0) => lines >= nextStep(reviewed);
const countLines = (text) => (text ? text.replace(/\n$/, '').split('\n').length : 0);
const norm = (p) => path.resolve(p).split(path.sep).join('/').toLowerCase();

class Growth {
  // store: el guardado de la app (clave «fileGrowth»); log(texto): registro de la app.
  constructor({ store, log }) {
    this.store = store;
    this.log = log || (() => {});
  }

  // Claude acaba de editar `file` en el proyecto de la carpeta `cwd`. Devuelve el aviso
  // que hay que darle, o null si no toca.
  async edited(cwd, file) {
    if (!cwd || typeof file !== 'string' || !CODE.test(file)) return null;
    const full = path.resolve(cwd, file);
    let lines;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      lines = countLines(await fs.promises.readFile(full, 'utf8'));
    } catch {
      return null; // ya no existe o no se puede leer
    }
    const project = norm(cwd);
    const key = norm(full).startsWith(`${project}/`) ? norm(full).slice(project.length + 1) : norm(full);
    const all = { ...this.store.get('fileGrowth', {}) };
    const mine = { ...(all[project] || {}) };
    const reviewed = mine[key] || 0;
    if (lines < FIRST) {
      // Se ha quedado pequeño (se partió): si vuelve a crecer, se avisará de nuevo.
      if (reviewed) { delete mine[key]; all[project] = mine; this.store.set('fileGrowth', all); }
      return null;
    }
    if (!needsReview(lines, reviewed)) return null;
    mine[key] = lines;
    all[project] = mine;
    this.store.set('fileGrowth', all);
    this.log(`buenas prácticas: ${full} tiene ${lines} líneas${reviewed ? ` (antes, ${reviewed})` : ''}: se avisa a Claude`);
    return [
      `ClaudHome · buenas prácticas: el archivo ${full} tiene ya ${lines} líneas${reviewed ? ` (la última vez que se avisó tenía ${reviewed})` : ''}.`,
      'Cuando termines lo que estás haciendo, valora si conviene partirlo en piezas con una sola responsabilidad cada una, y díselo al usuario en una o dos frases, con tu recomendación (partirlo y cómo, o dejarlo así y por qué).',
      'No lo partas por tu cuenta: hazlo solo si el usuario te lo pide.',
      `No volverás a recibir este aviso sobre ese archivo hasta que llegue a ${nextStep(lines)} líneas.`,
    ].join(' ');
  }
}

module.exports = { Growth, nextStep, needsReview, countLines, FIRST, GROWTH, EDIT_TOOLS };
