# Cambios

Lo que trae cada versión de ClaudHome (antes, Claudes). Al pulsar «Actualizar»,
la app muestra las secciones de las versiones posteriores a la instalada. Cada
sección empieza con `## X.Y.Z — AAAA-MM-DD` y lleva un punto (`- `) por cambio.

## 0.12.1 — 2026-11-21
- Arreglado: al descargar una actualización, la app iba acumulando avisos internos sin limpiar. La descarga terminaba bien, pero gastaba memoria de más mientras duraba.

## 0.12.0 — 2026-11-21
- Actualizar es mucho más rápido y ya no necesita Node.js: en vez de generar el programa en tu equipo, ClaudHome descarga la versión ya preparada (unos 160 MB), comprueba que ha llegado entera y la instala al reiniciarse. El botón muestra el avance de la descarga.
- Esta actualización es la última que se genera en tu equipo: a partir de la siguiente se nota el cambio.
- Para instalar ClaudHome en otro equipo basta con descargar el zip de la página de versiones de GitHub, descomprimirlo y abrir `Claudes.exe`.

## 0.11.0 — 2026-11-21
- Nuevo interruptor «Resumido» en la barra superior. Encendido, Claude responde corto y al grano. Apagado, como hasta ahora, explica sus decisiones y lo que va viendo del proyecto. Vale para todas las pestañas desde tu siguiente mensaje, sin reiniciar nada.
- Las sesiones llevan encendido «You should know», que viene con Claude Code: un agente aparte te avisa con una tarjeta cuando pasa algo que conviene saber y se te podría escapar.

## 0.10.0 — 2026-11-20
- Nueva animación al abrir ClaudHome: la carpeta del icono se dibuja con un trazo de luz y se abre, de dentro salen volando tus pestañas hasta su sitio y la carpeta y el nombre se encogen hasta la cabecera. Dura 2,5 segundos y no retrasa nada. Un clic o una tecla la saltan, y con «reducir animaciones» de Windows no aparece.
- El «Log» muestra al abrirlo solo lo del proyecto de la pestaña activa, aunque lo abrieras antes en otra pestaña. «Todos» enseña el de todos los proyectos, y la próxima vez vuelve a empezar por el proyecto.

## 0.9.0 — 2026-11-20
- Claude explica lo que hace: las sesiones llevan el plugin explanatory-output-style de Anthropic, y mientras trabaja Claude añade bloques «★ Insight» con el porqué de sus decisiones y lo que va viendo del proyecto. Gasta algo más de tokens. Necesita Git Bash, que se instala con Git para Windows.
- La barra inferior muestra el límite semanal de tu plan de Claude: el porcentaje usado, los tokens usados en la semana y cuándo se renueva. Si tu plan tiene también límite de 5 horas, se añade su porcentaje.
- Junto al llenado de la conversación aparecen los tokens que lleva usados, incluidos los de sus subagentes. Al pasar el ratón se ve el desglose de los tokens.

## 0.8.0 — 2026-11-20
- Las sesiones que llevan 45 minutos esperando tu mensaje en una pestaña que no estás viendo se duermen para liberar memoria: cada una ocupa en torno a 1 GB con sus servidores MCP. La conversación queda guardada y se retoma sola al abrir la pestaña.
- Nunca se duerme una sesión que está trabajando, que te necesita, que ha terminado sin que lo vieras, que tiene un error o que ha dejado algo en marcha (una tarea en segundo plano o programada). La barra inferior cuenta las sesiones dormidas.

## 0.7.0 — 2026-11-19
- Enlaces web en el contexto del proyecto: botón «Añadir enlace…» en el panel, o arrastra el enlace desde el navegador al panel o a la sesión. Cada enlace muestra el título de la página y Claude lo abre cuando le hace falta, sin pedir permiso.
- Si una página pide iniciar sesión, la tarjeta lo avisa: Claude no podrá leerla, así que conviene guardarla como PDF y añadir el PDF.
- Llenado de la conversación: una barrita en cada pestaña (verde, ámbar o coral) y el porcentaje en la barra inferior indican cuánto ocupa la conversación de su ventana de contexto, para saber cuándo usar `/compact` o `/clear`.
- El punto de cada pestaña dice más. Verde girando: está trabajando. Verde fijo: está activa, esperando tu mensaje. Verde parpadeando: ha terminado sin que lo vieras. Rojo parpadeando: te necesita. Ámbar: se ha detenido por un error. Gris girando: está arrancando o cerrándose. Punteado: no está iniciada.
- La pestaña ya no parpadea: el aviso lo da el punto. La barra inferior cuenta las sesiones que te necesitan, las que han terminado y las que tienen un error.
- Nuevo botón «Log»: muestra lo que sale de este equipo a través de Claude. Por un lado, lo que ha visto (archivos leídos, salidas de comandos, respuestas de los MCP), que se envía a Anthropic con la conversación. Por otro, lo que sale directamente a internet (páginas web, búsquedas, MCP remotos, comandos con red). Incluye el tamaño aproximado, filtros por pestaña, tipo y texto, y un archivo diario. Las contraseñas y los tokens se tapan.

## 0.6.1 — 2026-11-19
- Arreglado: cuando Claude escribía emojis (marcas de verificación, candados…), las tablas salían torcidas y algunas líneas perdían su primera letra, que aparecía al final de la línea anterior. La terminal cuenta ahora el ancho de los emojis igual que Claude Code y Windows Terminal.

## 0.6.0 — 2026-11-19
- Contexto del proyecto: el botón «Contexto» de cada pestaña abre un panel con una nota para Claude y los documentos (PDF, Word, imágenes, textos) y carpetas que debe tener presentes en todas las sesiones. Claude los lee cuando le hacen falta, sin pedir permiso.
- Al soltar archivos sobre la sesión puedes elegir entre pegarlos en el mensaje, como siempre, o añadirlos al contexto del proyecto.
- «Ver lo que recibe Claude» muestra exactamente lo que se le pasa. Si cambias el contexto con la sesión abierta, Claude se entera con tu siguiente mensaje.
- Se quita el botón «Nueva conversación»: `/clear` hace lo mismo, y la opción sigue en el menú del botón derecho de la pestaña.

## 0.5.0 — 2026-11-19
- La app pasa a llamarse ClaudHome: así aparece en la ventana, en la barra de tareas, en los avisos y en GitHub.
- Solo cambia el nombre que se ve. El ejecutable, las carpetas, tus pestañas y tus ajustes siguen igual.
- Cada 3 minutos, o al pulsar sobre el nombre, un arcoíris suave lo recorre.

## 0.4.0 — 2026-11-18
- Al pulsar «Actualizar» se muestran los cambios de todas las versiones posteriores a la tuya, agrupados por versión. «Update» la instala y «Cancel» lo deja como está: actualizar no es obligatorio.
- Tras pulsar «Update», la app genera la versión nueva en segundo plano y se reinicia solo al terminar. Si alguna sesión está trabajando, pregunta antes de cerrar.

## 0.3.0 — 2026-11-18
- Vista previa al pasar el ratón sobre una imagen pegada (`[Image #n]`) o sobre la ruta de un archivo: miniatura de las imágenes, primera página de los PDF, primeras líneas de los archivos de texto y, para lo demás, la miniatura de Windows o el icono.
- `Ctrl`+clic sobre la ruta o la imagen abre el archivo.
- Reconoce rutas con espacios y las que Claude parte en dos líneas, tanto las que pegas como las que escribe Claude.

## 0.2.0 — 2026-11-18
- Botón «Actualizar» cuando hay una versión nueva en GitHub: la descarga, genera el ejecutable, comprueba el acceso directo del escritorio y la instala al reiniciar.
- Dictado por voz: botón de micrófono en la barra superior. Activado, mantén pulsada la barra espaciadora para hablar.
- La versión de la app aparece junto al nombre «Claudes».

## 0.1.0 — 2026-11-10
- Primera versión: sesiones de Claude Code en pestañas con nombre y color, vista dividida, terminal extra, recientes, pegado de imágenes y archivos, cierre ordenado, imágenes con Codex y registro de depuración.
