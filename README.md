# Claudes

Sesiones de Claude Code en pestañas: cada pestaña es un `claude` trabajando en su carpeta, con el nombre que tú le pongas.

Proyecto personal para Windows. No está afiliado a Anthropic ni a OpenAI.

## Requisitos

- Windows 10 u 11.
- [Claude Code](https://code.claude.com/docs) instalado y con sesión iniciada (`claude` en el PATH).
- Node.js 22.12 o posterior, para ejecutar desde el código o generar el ejecutable.
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
- **Cierre ordenado.** Al cerrar una pestaña (o la app) con Claude trabajando, avisa. «Guardar estado y cerrar» interrumpe la tarea, le pide a Claude que deje anotado por dónde iba y espera a que termine antes de cerrar; al reabrir la sesión, ese resumen es lo último de la conversación. «Cerrar ya» corta en el acto.
- **Imágenes con Codex.** El indicador de la barra superior muestra si Codex está instalado con una suscripción de ChatGPT. Al activarlo, las sesiones de Claude reciben la herramienta `generar_imagen`, que pide la imagen a Codex y la guarda en la carpeta de la sesión.
- **Estado de cada sesión.** Aro girando = trabajando, punto coral = te necesita o ha terminado sin que lo vieras, círculo hueco = en reposo. Si no estás mirando esa pestaña, salta además una notificación de Windows.
- **Vista dividida.** Botón «Dividir», o arrastra una pestaña hacia abajo y suéltala en el lado donde la quieras.
- **Terminal extra.** Una consola (PowerShell, cmd o Git Bash) en la misma carpeta, debajo de Claude.
- **Recientes.** Al cerrar una pestaña queda en el botón «+» para reabrirla con su conversación.
- **Restaurar.** Al arrancar vuelven las pestañas que tenías; cada sesión se inicia la primera vez que la abres.
- **Zoom por pestaña.**

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
| `Ctrl+C` con texto seleccionado / `Ctrl+V` | Copiar / pegar (clic derecho hace lo mismo) |
| `F12` | Herramientas de desarrollo |

Los atajos de la app usan `Ctrl+Mayús` para no pisar los de Claude Code (`Ctrl+T`, `Ctrl+R`, `Ctrl+O`…).

## Cómo funciona por dentro

- Electron + xterm.js + node-pty. Cada pestaña lanza `claude.exe` en una pseudoterminal.
- **Conversaciones.** Cada pestaña recuerda el identificador de su conversación y la retoma con `claude --resume <id>`. Si esa conversación ya no existe, empieza una nueva. La opción «Continuar la última conversación de esa carpeta» solo se aplica al crear la pestaña.
- **Estado.** Cada sesión arranca con `--settings <archivo>`, que añade hooks HTTP hacia un servidor local de la app (`src/main/hooks.js`). No se modifica tu configuración de Claude Code y tus hooks y mods siguen funcionando.
- **Cierre ordenado.** La app envía `Esc` (interrumpe el turno), escribe la petición de resumen y espera el hook `Stop`; después deja que Claude salga solo con `Ctrl+C`. Gasta un turno corto de Claude por sesión.
- **Codex.** `codex login status` dice si hay sesión de ChatGPT. La herramienta es un servidor MCP local (`src/main/mcp.js`) que se pasa a cada sesión con `--mcp-config`; al llamarla, la app ejecuta `codex exec` en modo solo lectura y copia la imagen resultante a la carpeta de la sesión. Cada imagen consume una generación del plan de Codex. Las sesiones abiertas antes de activar el indicador necesitan reiniciarse para recibir la herramienta (la app lo ofrece).
- **Imágenes pegadas.** Una imagen copiada se guarda en `%TEMP%\Claudes-pegado` y se pega su ruta; se borran solas a la semana.
- **Datos.** `%APPDATA%\Claudes\state.json` guarda pestañas, recientes, posición de la ventana y si las imágenes con Codex están activadas.

```
src/main/      proceso principal: ventana, terminales, hooks, portapapeles, Codex, guardado
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
