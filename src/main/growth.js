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
// - Solo cuenta el código: ni documentos, ni datos, ni estilos. De un cuaderno de
//   Jupyter cuentan las celdas de código.
// La misma escalera la usa scripts/sizes.mjs para el aviso de npm test de este proyecto.
const fs = require('fs');
const path = require('path');

const FIRST = 1000;
const GROWTH = 1.2;
const MAX_BYTES = 5 * 1024 * 1024; // un archivo mayor no es código escrito a mano
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|ps1|psm1|sh|bat|cmd|sql|c|h|cc|cpp|hpp|cs|java|kt|go|rs|rb|php|vue|svelte|swift|lua|pl|r|scala|dart|ipynb)$/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DEFAULT_BUDGET = 1500; // ms: el hook espera 2 s a la respuesta; con más, el aviso no llegaría

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

// Líneas de código de un cuaderno de Jupyter: las de sus celdas de código, no el JSON
// entero (que también lleva las salidas y el texto).
function notebookLines(text) {
  const cells = (JSON.parse(text).cells || []).filter((cell) => cell && cell.cell_type === 'code');
  return cells.reduce((sum, cell) => sum + countLines([].concat(cell.source || []).join('')), 0);
}

// Líneas de código de un archivo según su tipo.
const codeLines = (file, text) => (/\.ipynb$/i.test(file) ? notebookLines(text) : countLines(text));

class Growth {
  // store: el guardado de la app (clave «fileGrowth»); log(texto): registro de la app.
  constructor({ store, log }) {
    this.store = store;
    this.log = log || (() => {});
  }

  // Claude acaba de editar `file` en el proyecto de la carpeta `project`. Devuelve el aviso
  // que hay que darle, o null si no toca.
  // - base: carpeta con la que se resuelve una ruta relativa (la de trabajo de la sesión,
  //   que puede ser una subcarpeta del proyecto); si no se da, la del proyecto.
  // - budget: ms como mucho. Si contar las líneas tarda más, no se avisa ni se anota
  //   nada, porque el aviso ya no llegaría a Claude: lo intentará la próxima edición.
  // - defer: devuelve { notice, commit } y no anota nada hasta commit() (cuando el aviso
  //   de verdad llega a Claude).
  async edited(project, file, { base = null, budget = DEFAULT_BUDGET, defer = false } = {}) {
    if (!project || typeof file !== 'string' || !CODE.test(file)) return null;
    const deadline = Date.now() + budget;
    const full = path.resolve(base || project, file);
    let lines;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      lines = codeLines(full, await fs.promises.readFile(full, 'utf8'));
    } catch {
      return null; // ya no existe, no se puede leer o (un cuaderno) no es JSON válido
    }
    if (Date.now() > deadline) {
      this.log(`buenas prácticas: contar las líneas de ${full} ha tardado demasiado; se deja para la próxima edición`);
      return null;
    }
    return this.decide(norm(project), full, lines, defer);
  }

  // Con las líneas ya contadas: decide si avisar y lo anota.
  decide(project, full, lines, defer = false) {
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
    const commit = () => {
      const now = { ...this.store.get('fileGrowth', {}) };
      now[project] = { ...(now[project] || {}), [key]: lines };
      this.store.set('fileGrowth', now);
      this.log(`buenas prácticas: ${full} tiene ${lines} líneas${reviewed ? ` (antes, ${reviewed})` : ''}: se avisa a Claude`);
    };
    const notice = [
      `ClaudHome · buenas prácticas: el archivo ${full} tiene ya ${lines} líneas${reviewed ? ` (la última vez que se avisó tenía ${reviewed})` : ''}.`,
      'Cuando termines lo que estás haciendo, valora si conviene partirlo en piezas con una sola responsabilidad cada una, y díselo al usuario en una o dos frases, con tu recomendación (partirlo y cómo, o dejarlo así y por qué).',
      'No lo partas por tu cuenta: hazlo solo si el usuario te lo pide.',
      `No volverás a recibir este aviso sobre ese archivo hasta que llegue a ${nextStep(lines)} líneas.`,
    ].join(' ');
    if (defer) return { notice, commit };
    commit();
    return notice;
  }
}

module.exports = { Growth, nextStep, needsReview, countLines, codeLines, FIRST, GROWTH, EDIT_TOOLS, CODE };
