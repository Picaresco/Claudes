// Cómo responde Claude en las sesiones de ClaudHome: los plugins que la app les da
// y el interruptor «Resumido».
//
// Plugins que trae ClaudHome
//   explanatory-output-style, de Anthropic: mientras trabaja, Claude explica con
//   bloques «★ Insight» las decisiones que toma y lo que va viendo del proyecto. Cada
//   sesión lo carga con --plugin-dir, sin instalar nada en Claude Code. Su hook es un
//   script de bash que Claude Code ejecuta con Git Bash: sin Git Bash no se carga,
//   porque cada sesión empezaría con un error.
//
//   «You should know», integrado en Claude Code y apagado de serie: un agente aparte
//   avisa con tarjetas («Heads up», «You should know») de lo que conviene saber.
//   ClaudHome lo enciende en sus sesiones salvo que el usuario lo haya decidido en su
//   configuración. Los enabledPlugins de --settings se suman a los del usuario.
//
// Respuestas resumidas o con explicaciones
//   El botón «Resumido» de la barra superior vale para todas las pestañas y al momento:
//   cada sesión recuerda qué estilo recibió y, si no coincide con el botón, se le dice
//   con el siguiente mensaje (hook UserPromptSubmit). Al arrancar, el modo explicativo
//   lo da el plugin; si no se puede cargar (sin Git Bash), lo da el hook con el mismo texto.
const fs = require('fs');
const path = require('path');

const EXPLAIN_PLUGIN = 'explanatory-output-style';
const BUNDLED_PLUGINS = [EXPLAIN_PLUGIN];
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const YOU_SHOULD_KNOW = 'cc-plugin-you-should-know@builtin';

const BRIEF_TEXT = [
  'ClaudHome · modo resumido: el usuario ha activado el botón «Resumido». A partir de este mensaje, tus respuestas deben ser cortas y al grano:',
  '- Como mucho unas 80 palabras: de 2 a 5 frases, o una lista de 3 o 4 puntos breves. Solo te puedes alargar si la tarea lo necesita de verdad (código, comandos o una lista que el usuario haya pedido).',
  '- No añadas bloques «★ Insight» ni explicaciones didácticas sobre el proyecto o tus decisiones, aunque instrucciones anteriores (el estilo «explanatory») lo pidan.',
  '- Sin introducciones, sin resumen final y sin ofrecer más ayuda al terminar.',
  '- Di lo esencial: qué has hecho o qué has encontrado, el resultado y, si hace falta, el siguiente paso. Nunca te calles errores, riesgos, cambios que no se pueden deshacer ni preguntas que necesiten su respuesta.',
  'Si el usuario pide expresamente más detalle, dáselo.',
].join('\n');

// Copia una carpeta. Desde el ejecutable, los plugins están dentro de app.asar, que
// Claude Code no puede leer, así que se copian a la carpeta de datos de la app.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

// srcDir: carpeta con los plugins que trae la app; dstDir: donde se copian para las
// sesiones; userSettings(): configuración de Claude Code del usuario; gitBash: ruta de
// Git Bash o null; tabs: la tabla de pestañas (se usa su campo style); log y label,
// para el registro de la app.
function createStyle({ srcDir, dstDir, userSettings, gitBash, tabs, log, label }) {
  let brief = false; // true: respuestas cortas y al grano
  let pluginDirs = []; // { name, dir } de los plugins listos para pasar a las sesiones
  let explainText = ''; // las instrucciones del plugin explicativo, leídas de su script

  // El texto que el plugin explicativo da a Claude, sacado de su session-start.sh.
  function readExplainText() {
    try {
      const script = fs.readFileSync(path.join(srcDir, EXPLAIN_PLUGIN, 'hooks-handlers', 'session-start.sh'), 'utf8');
      const json = /<<\s*'EOF'\s*\n([\s\S]*?)\nEOF/.exec(script);
      return JSON.parse(json[1]).hookSpecificOutput.additionalContext;
    } catch (err) {
      log(`plugin ${EXPLAIN_PLUGIN}: no se ha podido leer su texto (${err.message})`);
      return 'Explain your implementation choices and what you learn about the codebase as you work, in brief "★ Insight" blocks of 2-3 points before and after writing code.';
    }
  }

  // Al arrancar la app: deja los plugins listos. Devuelve sus nombres.
  function prepare() {
    pluginDirs = [];
    for (const name of BUNDLED_PLUGINS) {
      try {
        copyDir(path.join(srcDir, name), path.join(dstDir, name));
        pluginDirs.push({ name, dir: path.join(dstDir, name) });
      } catch (err) {
        log(`plugin ${name}: no se ha podido preparar (${err.message})`);
      }
    }
    explainText = readExplainText();
    return pluginDirs.map((p) => p.name);
  }

  // Plugins de ClaudHome para una sesión, salvo los que el usuario ya tenga activados
  // en su Claude Code (se cargarían dos veces). Con «Resumido», sin el explicativo.
  function sessionPlugins() {
    if (!gitBash) return [];
    const enabled = userSettings().enabledPlugins || {};
    return pluginDirs.filter((p) => enabled[`${p.name}@${OFFICIAL_MARKETPLACE}`] !== true && !(brief && p.name === EXPLAIN_PLUGIN));
  }

  // ¿Tiene el usuario el plugin explicativo instalado y activado en su Claude Code?
  const userExplains = () => (userSettings().enabledPlugins || {})[`${EXPLAIN_PLUGIN}@${OFFICIAL_MARKETPLACE}`] === true;

  // Ajustes de la sesión para los plugins integrados: «You should know» encendido,
  // salvo que el usuario lo haya activado o apagado él (`mine` es su configuración).
  function sessionSettings(mine) {
    return Object.prototype.hasOwnProperty.call(mine.enabledPlugins || {}, YOU_SHOULD_KNOW) ? {} : { enabledPlugins: { [YOU_SHOULD_KNOW]: true } };
  }

  // Una sesión arranca con esos plugins. Lo que sabe al arrancar: el plugin explicativo
  // da ese estilo; si no se carga, el estilo que toque se le dice con el primer mensaje.
  function started(tabId, plugins) {
    tabs.ensure(tabId).style = plugins.some((p) => p.name === EXPLAIN_PLUGIN) || userExplains() ? 'explain' : null;
  }

  // Lo que hay que decirle a una sesión con el siguiente mensaje, si su estilo no es el del botón.
  function update(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.style === undefined) return null; // no es una sesión de Claude de ClaudHome
    const want = brief ? 'brief' : 'explain';
    if (tab.style === want) return null;
    tab.style = want;
    log(`estilo de ${label(tabId)}: pasa a ${want === 'brief' ? 'resumido' : 'explicativo'} con este mensaje`);
    return want === 'brief'
      ? BRIEF_TEXT
      : `ClaudHome · modo explicativo: el usuario ha apagado el botón «Resumido». A partir de este mensaje sigue estas instrucciones, aunque antes te pidiera respuestas resumidas:\n\n${explainText}`;
  }

  return {
    prepare,
    sessionPlugins,
    sessionSettings,
    started,
    update,
    get brief() { return brief; },
    set brief(value) { brief = Boolean(value); },
  };
}

module.exports = { createStyle, EXPLAIN_PLUGIN, YOU_SHOULD_KNOW, BRIEF_TEXT };
