# ClaudHome

Sesiones de Claude Code en pestañas: cada pestaña es un `claude` trabajando en su carpeta, con el nombre que tú le pongas.

Proyecto personal para Windows. No está afiliado a Anthropic ni a OpenAI.

Antes se llamaba Claudes. Solo ha cambiado el nombre que se ve: el ejecutable (`Claudes.exe`), el repositorio y las carpetas de la app conservan el nombre anterior, para que las instalaciones existentes sigan funcionando y actualizándose.

## Requisitos

- Windows 10 u 11.
- [Claude Code](https://code.claude.com/docs) instalado y con sesión iniciada (`claude` en el PATH).
- Node.js 22.12 o posterior, para ejecutar desde el código, generar el ejecutable o actualizar desde la propia app.
- Opcional: Codex CLI con sesión de ChatGPT, para que Claude pueda pedirle imágenes.

## Instalación

```
git clone https://github.com/Picaresco/Claudes.git
cd Claudes
npm install
npm start
```

La primera vez, `npm start` descarga el binario de Electron. Para tener un ejecutable que abrir sin terminal, `npm run package` genera `dist\Claudes-win32-x64\Claudes.exe`.

## Qué hace

- **Pestañas con nombre y color.** Doble clic o `F2` para renombrar; clic derecho para cambiar el color; se reordenan arrastrándolas por la fila.
- **Pegar imágenes y documentos.** `Ctrl+V` o botón derecho pegan lo que haya en el portapapeles: texto, archivos copiados en el Explorador (se pegan sus rutas; Claude adjunta las imágenes como `[Image #1]`) o una imagen copiada, como una captura de pantalla. También se pueden soltar archivos sobre la terminal.
- **Contexto del proyecto.** Con el botón «Contexto» de cada pestaña se abre un panel con una nota para Claude y una lista de documentos (PDF, Word, imágenes, textos), carpetas y enlaces web que Claude tiene presentes en todas las sesiones de esa pestaña. Se añaden de tres formas: con los botones del panel («Añadir enlace…» para las páginas web), arrastrándolos al panel (también enlaces desde el navegador), o soltándolos sobre la sesión y eligiendo «Añadir al contexto del proyecto». Claude no los lee por adelantado: los abre cuando la tarea los necesita, sin pedir permiso. De cada enlace se muestra el título de la página. Si la página pide iniciar sesión, la tarjeta avisa de que Claude no podrá leerla; en ese caso, guárdala como PDF y añade el PDF. Cada documento se puede desactivar o quitar, y «Ver lo que recibe Claude» muestra el texto exacto que se le pasa. No se toca ningún archivo del proyecto.
- **Vista previa al pasar el ratón.** Sobre el `[Image #n]` de una imagen pegada, o sobre la ruta de cualquier archivo que exista (la que pegues tú o la que escriba Claude en su respuesta), aparece una tarjeta con la vista previa: la miniatura de una imagen, la primera página de un PDF, las primeras líneas de un archivo de texto o código, y para lo demás la miniatura de Windows o el icono de su tipo. Debajo salen el tipo, el tamaño, y las dimensiones o páginas. `Ctrl`+clic abre el archivo.
- **Cierre ordenado.** Al cerrar una pestaña (o la app) con Claude trabajando, avisa. «Guardar estado y cerrar» interrumpe la tarea, le pide a Claude que deje anotado por dónde iba y espera a que termine antes de cerrar; al reabrir la sesión, ese resumen es lo último de la conversación. «Cerrar ya» corta en el acto.
- **Registro de depuración.** Activado de serie; se apaga y enciende con el botón «Depuración» de la barra inferior. Los registros se abren con el botón derecho sobre una pestaña.
- **Actualizaciones desde GitHub.** Si en GitHub hay una versión mayor que la instalada, aparece el botón «Actualizar a vX.Y.Z» en la barra superior. Al pulsarlo se muestran los cambios de todas las versiones posteriores a la tuya, agrupados por versión. Con «Cancel» no se toca nada: actualizar no es obligatorio y el botón sigue ahí. Con «Update», ClaudHome descarga el código, genera el ejecutable nuevo y comprueba que haya un acceso directo en el escritorio (si falta, lo crea). Todo esto ocurre en segundo plano y puedes seguir trabajando. Al terminar, ClaudHome se reinicia para instalarla; si alguna sesión está trabajando, pregunta antes de cerrar. Al volver se abren tus pestañas y cada sesión retoma su conversación. La versión que ya tenías queda guardada como copia.
- **Dictado por voz.** El micrófono de la barra superior activa el dictado de Claude Code: amarillo oscuro = activado, gris oscuro = desactivado. Activado, mantén pulsada la barra espaciadora en una sesión para hablar; al soltarla deja de grabar y el texto queda en el cuadro de Claude para revisarlo y enviarlo con `Intro`. Desactivado, la barra espaciadora solo escribe espacios. Vale al momento para todas las pestañas. Necesita una sesión de Claude Code iniciada con cuenta de Claude.ai y permiso de micrófono para las aplicaciones de escritorio en Windows.
- **Imágenes con Codex.** El indicador de la barra superior muestra si Codex está instalado con una suscripción de ChatGPT. Al activarlo, las sesiones de Claude reciben la herramienta `generar_imagen`, que pide la imagen a Codex y la guarda en la carpeta de la sesión.
- **Estado de cada sesión.** El punto de cada pestaña lo indica:
  - aro verde girando: trabajando;
  - punto verde: activa, esperando tu mensaje;
  - punto rojo parpadeando: te necesita (pide permiso o una respuesta);
  - punto verde parpadeando: ha terminado sin que lo vieras;
  - punto ámbar: se ha detenido por un error (fallo de la API, límite de uso…), hasta tu siguiente mensaje;
  - aro gris girando: arrancando o guardando su estado para cerrar;
  - círculo punteado: sin iniciar, dormida o sesión cerrada.
  
  Si no estás mirando esa pestaña, salta además una notificación de Windows. La barra inferior cuenta cuántas sesiones hay en cada caso.
- **Sesiones dormidas.** Una sesión que lleva 45 minutos esperando tu mensaje en una pestaña que no estás viendo se duerme: se cierra para liberar memoria (cada sesión, con sus servidores MCP, ocupa en torno a 1 GB). La conversación queda guardada y se retoma sola al abrir la pestaña. Nunca se duerme una sesión que está trabajando, que te necesita, que ha terminado sin que lo vieras, que tiene un error o que ha dejado algo en marcha (una tarea en segundo plano, una vigilancia o una tarea programada).
- **Llenado de la conversación.** Una barrita al pie de cada pestaña muestra cuánto de su ventana de contexto ocupa la conversación: verde hasta el 60 %, ámbar hasta el 85 % y coral a partir de ahí. La barra inferior da el porcentaje de la pestaña activa. Cuanto más llena, peor rinde Claude y más gasta: `/compact` la resume y sigue, `/clear` empieza de cero.
- **Límite de uso y tokens.** La barra inferior muestra el límite semanal de tu plan de Claude: el porcentaje usado, los tokens usados en la semana y cuándo se renueva («Semana 61 % · 317 M tokens · se renueva hoy a las 21:00»). Si tu plan tiene además límite de 5 horas, se añade su porcentaje. Junto al llenado de la conversación de la pestaña activa van los tokens que lleva usados, incluidos los de sus subagentes («Conversación 42 % · 1,2 M tokens»). Al pasar el ratón se ve el desglose: entrada, salida, caché escrita y caché leída. El porcentaje del límite es el de tu cuenta, incluido lo usado en claude.ai o en otros equipos; los tokens son los de Claude Code en este equipo. Con una clave de API no hay límites del plan: solo aparecen los tokens de la conversación.
- **Claude explica lo que hace.** Cada sesión lleva el plugin [explanatory-output-style](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/explanatory-output-style) de Anthropic: mientras trabaja, Claude añade bloques «★ Insight» con el porqué de sus decisiones y lo que va viendo del proyecto. Gasta algo más de tokens. Necesita Git Bash; sin él, las sesiones arrancan sin el plugin.
- **Log.** El botón «Log» muestra lo que sale de este equipo a través de Claude. Todo lo que Claude ve se envía a Anthropic como parte de la conversación, así que el registro apunta los archivos que lee, las búsquedas en archivos, los comandos que ejecuta (su salida) y las herramientas MCP que usa, con el tamaño aproximado de lo que recibió. Además marca lo que sale directamente a internet: páginas web, búsquedas, MCP remotos y comandos con red (`curl`, `git push`, `npm`…). Se puede filtrar por pestaña, tipo y texto, y queda también en un archivo diario. Las contraseñas y los tokens de comandos y direcciones se tapan. Para auditar todo el tráfico de red del equipo, la fuente completa es el cortafuegos.
- **Vista dividida.** Botón «Dividir», o arrastra una pestaña hacia abajo y suéltala en el lado donde la quieras.
- **Terminal extra.** Una consola (PowerShell, cmd o Git Bash) en la misma carpeta, debajo de Claude.
- **Recientes.** Al cerrar una pestaña queda en el botón «+» para reabrirla con su conversación.
- **Restaurar.** Al arrancar vuelven las pestañas que tenías; cada sesión se inicia la primera vez que la abres.
- **Zoom por pestaña.**
- **Arcoíris en el nombre.** Cada 3 minutos, o al pulsar sobre «ClaudHome», un arcoíris suave recorre el nombre. Con «reducir animaciones» activado en Windows no aparece.

## Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl+Tab` / `Ctrl+Mayús+Tab` | Pestaña siguiente / anterior |
| `Ctrl+1` … `Ctrl+9` | Ir a esa pestaña |
| `Ctrl+Mayús+T` | Nueva sesión |
| `Ctrl+Mayús+W` | Cerrar pestaña |
| `Ctrl+Mayús+D` | Dividir / cerrar división |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Cambiar de lado en la vista dividida |
| `Ctrl+ñ` | Mostrar u ocultar la terminal extra |
| `Ctrl` `+` / `Ctrl` `-` / `Ctrl+0` | Zoom de la pestaña (también `Ctrl` + rueda) |
| `F2` | Renombrar la pestaña |
| `Mayús+Intro` | Salto de línea en el cuadro de Claude |
| Mantener `Espacio` | Dictar a Claude (con el micrófono activado); al soltar deja de grabar. `Esc` descarta lo dictado |
| `Ctrl+C` con texto seleccionado / `Ctrl+V` | Copiar / pegar (clic derecho hace lo mismo) |
| `Ctrl`+clic sobre una ruta o un `[Image #n]` | Abrir el archivo |
| `F12` | Herramientas de desarrollo |

Los atajos de la app usan `Ctrl+Mayús` para no pisar los de Claude Code (`Ctrl+T`, `Ctrl+R`, `Ctrl+O`…).

## Cómo funciona por dentro

- Electron + xterm.js + node-pty. Cada pestaña lanza `claude.exe` en una pseudoterminal.
- **Conversaciones.** Cada pestaña recuerda el identificador de su conversación y la retoma con `claude --resume <id>`. Si esa conversación ya no existe, empieza una nueva. La opción «Continuar la última conversación de esa carpeta» solo se aplica al crear la pestaña.
- **Estado.** Cada sesión arranca con `--settings <archivo>`, que añade hooks HTTP hacia un servidor local de la app (`src/main/hooks.js`). No se modifica tu configuración de Claude Code y tus hooks y mods siguen funcionando.
- **Dictado.** El mismo archivo de `--settings` activa el [dictado de Claude Code](https://code.claude.com/docs/en/voice-dictation) en modo «mantener» (`voice.enabled`, `voice.mode: "hold"`): la grabación y la transcripción las hace Claude Code. Claude Code reconoce la tecla mantenida por sus repeticiones, así que el botón del micrófono solo decide si las repeticiones de la barra espaciadora llegan a la sesión. Por eso se aplica al momento, sin reiniciar nada. Si tu configuración de Claude Code no fija `language`, ClaudHome añade `"language": "spanish"` para que el dictado sea en español; ese ajuste también hace que Claude responda en español. Si pones tu propio `language` en `~/.claude/settings.json`, se usa el tuyo.
- **Actualización.** Solo en el ejecutable instalado. Al arrancar y cada 6 horas, compara `version` de `package.json` en la rama `main` de GitHub con la instalada. Los cambios que enseña salen de las secciones de `CHANGELOG.md` en `main` posteriores a la versión instalada; al ejecutar desde el código se lee el `CHANGELOG.md` local. Para actualizar descarga el código de `main` en `%LOCALAPPDATA%\Claudes-update` y ejecuta `npm ci` y `scripts/package.mjs` con el Node.js del equipo. Después comprueba el acceso directo del escritorio. Windows no deja sustituir un programa abierto, así que al cerrarse ClaudHome lanza `src/main/install-update.js` con ese mismo `node.exe`. Ese instalador espera a que ClaudHome termine, renombra la carpeta del programa a `<carpeta>.anterior`, pone la nueva en su sitio y, si se eligió reiniciar, vuelve a abrir Claudes. Si algo falla, recupera la anterior. Cada actualización deja su registro en `logs\actualizacion-<fecha>.log`, y al volver a abrir ClaudHome un aviso dice si se instaló.
- **Cierre ordenado.** La app envía `Esc` (interrumpe el turno), escribe la petición de resumen y espera el hook `Stop`; después deja que Claude salga solo con `Ctrl+C`. Gasta un turno corto de Claude por sesión.
- **Codex.** `codex login status` dice si hay sesión de ChatGPT. La herramienta es un servidor MCP local (`src/main/mcp.js`) que se pasa a cada sesión con `--mcp-config`; al llamarla, la app ejecuta `codex exec` en modo solo lectura y copia la imagen resultante a la carpeta de la sesión. Cada imagen consume una generación del plan de Codex. Las sesiones abiertas antes de activar el indicador necesitan reiniciarse para recibir la herramienta (la app lo ofrece).
- **Registros.** Con la depuración activada, cada arranque de Claude lleva `--debug-file` y escribe en `%APPDATA%\Claudes\logs\<fecha>-<hora>-<pestaña>.log` (horas en UTC, formato de Claude Code). La app añade su propio `claudes-<fecha>.log` (hora local) con arranques, hooks recibidos, cambios de estado, notificaciones, peticiones a Codex y errores. Se borran a la semana o al pasar de 300 MB. El interruptor afecta a las sesiones que se abran o reinicien después de cambiarlo.
- **Imágenes pegadas.** Una imagen copiada se guarda en `%TEMP%\Claudes-pegado` y se pega su ruta; se borran solas a la semana.
- **Contexto del proyecto.** Se guarda con la pestaña en `state.json`; de los documentos solo se guarda su ruta, no se copian. Al arrancar la sesión, `src/main/context.js` escribe el resumen (la nota y la lista de documentos con su ruta) en `%APPDATA%\Claudes\contexto\<pestaña>\instrucciones.md`, y se pasa a Claude con `--append-system-prompt-file`. Los Word se pasan a texto en esa misma carpeta, porque Claude no lee `.docx`. Para que Claude lea los documentos sin preguntar, cada uno lleva una regla `Read(//c/…)` en los ajustes de la sesión, y cada dominio de los enlaces una `WebFetch(domain:…)`. El título y el aviso de inicio de sesión de un enlace se obtienen al añadirlo, con `net.request` de Electron (usa el proxy del sistema y sigue las redirecciones para ver dónde acaba la página). Si el contexto cambia con la sesión abierta, el hook `UserPromptSubmit` le da el resumen nuevo con el siguiente mensaje (`additionalContext`). No se usa `--add-dir`, porque Claude Code preguntaría al arrancar si confías en cada carpeta.
- **Llenado de la conversación.** Cada sesión lleva una línea de estado (`statusLine` en su `--settings`) que no muestra nada: solo reenvía con `curl` a la app lo que Claude Code le pasa (`context_window.used_percentage` y el tamaño de la ventana). Si tienes tu propia línea de estado en `~/.claude/settings.json`, se respeta y esa sesión se queda sin indicador.
- **Límite de uso y tokens.** La misma línea de estado trae `rate_limits.seven_day` y, en los planes que lo tienen, `rate_limits.five_hour` (`used_percentage` y `resets_at`), que Claude Code saca de las cabeceras de la última respuesta de la API. Son de la cuenta, así que vale lo que llegue de cualquier pestaña: dentro de un mismo periodo se queda el porcentaje más alto, y una renovación anterior a la conocida se descarta (una sesión parada puede repetir datos viejos). Se guarda en `state.json` para mostrarlo nada más abrir la app. Los tokens los cuenta `src/main/limits.js` en las conversaciones de `~/.claude/projects/**/*.jsonl`, sumando una sola vez cada respuesta (`message.id` + `requestId`). Las respuestas de los subagentes (`<conversación>\subagents\*.jsonl`) llevan el `sessionId` de su conversación y suman en ella. La conversación de cada pestaña es la del arranque y, tras un `/clear`, la que traen los hooks. Cada archivo se lee solo por donde iba la vez anterior; los de más de 8 días se saltan, salvo los de una pestaña abierta, y si uno saltado vuelve a crecer se lee entero. Recuenta como mucho cada 10 s tras una respuesta y cada minuto por su cuenta. Pasada la hora de renovación, cuenta desde entonces hasta que el siguiente mensaje traiga el porcentaje nuevo.
- **Plugins.** Los plugins que trae la app están en `src/plugins/`. Al arrancar se copian a `%APPDATA%\Claudes\plugins`, porque Claude Code no puede leerlos dentro de `app.asar`, y cada sesión los carga con `--plugin-dir`, sin instalar nada en tu Claude Code. El hook de `explanatory-output-style` es un script de bash que Claude Code ejecuta con Git Bash. Por eso solo se pasa si la app encuentra Git Bash (en su ruta de instalación o junto al `git.exe` del PATH) y si no lo tienes ya activado en tu `~/.claude/settings.json` (`enabledPlugins`).
- **Sesiones dormidas.** La interfaz revisa cada minuto las pestañas que no se ven. Si la sesión está en «Activa, esperando tu mensaje» y lleva 45 minutos sin cambios de estado ni teclas, se termina su proceso, igual que al reiniciarla, y la pestaña queda como «Dormida». Al mostrarla arranca con `--resume`, como al abrir la app. Los hooks marcan si Claude ha dejado algo en marcha: herramientas con `run_in_background` (comandos o agentes), `Monitor`, `CronCreate` o `ScheduleWakeup`. En ese caso, esa sesión no se duerme hasta que se reinicie.
- **Log.** `src/main/netlog.js` se alimenta del hook `PostToolUse`, es decir, de las herramientas que ya se han ejecutado: `Read`, `Grep`, `Bash`/`PowerShell`, `WebFetch`, `WebSearch` y las de los servidores MCP. El tamaño del aviso del hook da una idea de cuánto recibió Claude. De los avisos de más de 64 KB solo se lee el principio, y de ahí se sacan la herramienta y su entrada (`hooks.js`). Se considera que sale «hacia internet» lo siguiente:
  - las páginas y búsquedas web;
  - los MCP remotos (los conectores de claude.ai y los servidores con URL pública en `~/.claude.json` o `.mcp.json`);
  - los comandos con red cuyo destino no es la red local.
  
  Los secretos se tapan antes de mostrar o guardar nada. Las repeticiones del mismo elemento se agrupan durante 5 minutos. El archivo es `logs\salidas-<fecha>.log`.
- **Vista previa.** La terminal busca en cada línea rutas absolutas de Windows, con o sin comillas, incluidas las que Claude Code parte en dos líneas. Solo se marcan las que existen como archivo (`src/main/preview.js`). Claude Code numera las imágenes pegadas (`[Image #1]`, `[Image #2]`…) sin repetir número durante la sesión. Al pegar, la app mira qué etiqueta nueva aparece en pantalla y la asocia al archivo pegado; si Claude se reinicia, esa asociación se olvida. Las miniaturas de imágenes las da Windows (`nativeImage.createThumbnailFromPath`). La primera página de un PDF la dibuja el lector de PDF de Windows (`Windows.Data.Pdf`, en `src/main/pdf-page.ps1`), lanzado como comando codificado para no depender de la política de ejecución de scripts.
- **Datos.** `%APPDATA%\Claudes\state.json` guarda pestañas, recientes, posición de la ventana y si las imágenes con Codex y el micrófono para dictar están activados.

```
src/main/      proceso principal: ventana, terminales, hooks, portapapeles, Codex, guardado, actualización
src/preload/   puente entre la interfaz y el proceso principal
src/renderer/  interfaz: pestañas, vista dividida, diálogos
scripts/       icono y empaquetado
```

## Desarrollo

```
npm start          # abrir la app desde el código
npm run icon       # regenerar build/icon.ico
npm run package    # generar dist/Claudes-win32-x64
```

Para probar sin tocar tus pestañas reales, estas variables solo actúan al ejecutar desde el código:

| Variable | Efecto |
| --- | --- |
| `CLAUDES_USER_DATA` | Carpeta de datos alternativa (también funciona en el ejecutable) |
| `CLAUDES_SHOT` | Guarda una captura de la ventana en esa ruta (`CLAUDES_SHOT_DELAY` en ms, `CLAUDES_SHOT_QUIT=1` para cerrar después) |
| `CLAUDES_TEST_JS` | Ejecuta ese archivo en la interfaz antes de la captura |
| `CLAUDES_AUTO_CONFIRM` | Acepta solos los diálogos (elige siempre el primer botón) |
| `CLAUDES_BLOCK_PROMPTS` | Los mensajes se rechazan antes de llegar al modelo: permite probar sin gastar tokens |
| `CLAUDES_LOG_HOOKS` | Escribe en la consola los avisos de hooks y las peticiones MCP |
| `CLAUDES_UPDATE_FAKE_VERSION` | Finge que la versión instalada es esa, para que aparezca el botón «Actualizar» (también funciona en el ejecutable) |
| `CLAUDES_UPDATE_AUTO` | Actualiza sin preguntar en cuanto hay versión nueva, y reinicia al terminar (para pruebas con el ejecutable) |
| `CLAUDES_DESKTOP_DIR` | Carpeta donde se comprueba el acceso directo en vez del escritorio |
| `CLAUDES_SLEEP_MINUTES` | Minutos sin actividad tras los que se duerme una sesión que no se ve (45 si no se indica; admite decimales para probar) |

Con `CLAUDES_USER_DATA`, la actualización trabaja en `<datos>\actualizacion` en vez de en `%LOCALAPPDATA%\Claudes-update`.

## Publicar una versión

Las instalaciones de ClaudHome detectan una versión nueva cuando `version` de `package.json` en `main` es mayor que la suya. Antes de pulsar «Update» enseñan lo que trae cada versión según `CHANGELOG.md`. Para publicar una:

1. Añade arriba de `CHANGELOG.md` su sección: `## X.Y.Z — AAAA-MM-DD` y un punto (`- `) por cambio, escrito para quien usa la app.
2. Sube la versión y publícala:

```
npm version 0.6.0 --no-git-tag-version
git commit -am "ClaudHome 0.6.0: …"
git push origin main
```

Una versión anterior a la 0.2.0 no tiene actualizador: se actualiza a mano una vez (`npm run package` con ClaudHome cerrado).

## Licencia

[MIT](LICENSE).
