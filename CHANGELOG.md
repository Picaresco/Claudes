# Cambios

Lo que trae cada versión de ClaudHome (antes, Claudes). Al pulsar «Actualizar»,
la app muestra las secciones de las versiones posteriores a la instalada. Cada
sección empieza con `## X.Y.Z — AAAA-MM-DD` y lleva un punto (`- `) por cambio.

## 0.17.1 — 2026-11-22
- Si Codex no puede leer el proyecto (en Windows, cuando le falta configurar su zona protegida), ClaudHome te avisa y te dice cómo arreglarlo, en vez de dar por buena una revisión o una crítica que no ha podido mirar el código. A Claude también se le dice que esa segunda opinión no ha visto el código.
- La rueda de opciones avisa bajo «Codex asesora» si a Codex le falta esa configuración, y también al encenderlo.
- Fuera del modo planificación, cuando Claude prepara un plan para una tarea grande, le pide a Codex una segunda opinión antes de empezar. La crítica automática sigue siendo la de los planes que Claude presenta en modo planificación (Mayús+Tab).

## 0.17.0 — 2026-11-22
- La barra inferior muestra si hay Codex en este equipo y, con tu cuenta de ChatGPT, cuánto llevas gastado de su límite semanal y cuándo se renueva, junto al de Claude. Se actualiza al abrir la app, cada 10 minutos y justo después de cada consulta a Codex, sin gastar nada.
- Si Codex no está instalado, no tiene sesión o usa una clave de API, la barra inferior también lo dice.
- Nueva rueda de opciones en la barra superior: dentro están todos los interruptores (Resumido, Codex asesora, imágenes con Codex, micrófono y depuración), cada uno con una línea que explica para qué sirve. Así la barra superior queda para tus proyectos. Mientras Codex trabaja, la rueda lleva un punto verde.
- Como mucho 6 proyectos abiertos a la vez, para no saturar la barra superior. Si intentas abrir otro, ClaudHome te avisa de que cierres alguno: queda en «Recientes» con su conversación.

## 0.16.0 — 2026-11-22
- Codex pasa a ser el asesor de Claude. Si tienes Codex con tu cuenta de ChatGPT, Claude puede pedirle una segunda opinión cuando se enfrenta a una decisión importante o a un problema que no sale, en cualquier ámbito: código, seguridad, planes o flujos de trabajo. También puedes pedírsela tú: «pide una segunda opinión a Codex». Claude compara las dos opiniones y te da una sola recomendación, diciéndote en qué coinciden y en qué no.
- El interruptor «Codex revisa» pasa a llamarse «Codex asesora» y lo controla todo: segunda opinión, crítica de planes y revisión del código. Viene apagado: enciéndelo si quieres que Claude use Codex. Apagado, Claude no le consulta nada a Codex ni se gasta de tu plan; las imágenes siguen con su propio indicador.
- Con «Codex asesora» encendido, Codex también critica cada plan de Claude antes de que lo veas. Claude lo ajusta y te lo presenta con una sección «Segunda opinión (Codex)». Mientras tanto, la pestaña muestra «Codex está revisando el plan».
- Codex siempre trabaja en solo lectura y aislado (sin tu configuración de Codex ni sus servidores MCP, sin control del ordenador ni navegador): lee el proyecto para opinar, pero nunca cambia nada. Quien decide y actúa es Claude, y quien aprueba, tú. Lo que se le pregunta sale hacia OpenAI y queda en el «Log»; si lleva una clave, no se envía.
- El indicador de Codex de la barra superior muestra «Codex trabajando…» mientras da una opinión, critica un plan o genera una imagen.
- Arreglado: con Codex instalado con npm, una carpeta con espacios en su ruta, o en una unidad de red, podía hacer fallar la generación de imágenes.
- Si tu versión de Codex es demasiado antigua para asesorar a Claude, el indicador de Codex te pide actualizarla.
- Al apagar «Codex asesora» se para al momento lo que Codex estuviera haciendo para Claude.

## 0.15.1 — 2026-11-22
- «Codex revisa» comprueba justo antes de cada revisión que Codex tiene la sesión de tu cuenta de ChatGPT, sin riesgo de cerrarte la sesión de Codex si algún día usas una clave de API. Usa siempre el modelo que anuncia, aunque tu configuración de Codex diga otro.
- Si Claude ya ha confirmado sus cambios, o apagas el interruptor mientras se prepara la revisión, Codex no se lanza.
- «No he encontrado problemas» ya no se toma por un fallo de la revisión, y una respuesta que pide el código ya no se toma por «sin problemas».
- El aviso de claves detecta contraseñas que contienen palabras como «secret» o «test», y lo que se envía a Codex se comprueba también en los scripts de PowerShell en UTF-16 y en la línea de la función que git muestra junto a cada cambio.
- Con «Codex revisa» apagado, la app ya no hace ningún trabajo extra al editar.

## 0.15.0 — 2026-11-22
- Nueva buena práctica en todos tus proyectos: si Claude escribe en un archivo una clave o una contraseña (de Anthropic, OpenAI, GitHub, AWS, Google, una clave privada, una contraseña en el código o en una dirección de conexión…), en ese momento se le pide que la pase a un archivo `.env` que git no suba y que te lo cuente. Una clave que llega a GitHub hay que darla por robada, aunque se borre después.
- También avisa si un `.env` con claves no está en `.gitignore`. La app nunca guarda ni muestra la clave, y no confunde con claves los valores de ejemplo ni las variables de entorno.
- Nuevo interruptor «Codex revisa» en la barra superior, si tienes Codex con tu cuenta de ChatGPT. Encendido, cuando Claude termina un turno en el que ha cambiado código, Codex (su modelo más capaz, razonando a fondo) revisa esos cambios como segundo revisor. Si encuentra algo, Claude lo evalúa, corrige lo que sea un fallo real y te cuenta qué ha cambiado y qué ha descartado.
- Codex revisa todos los cambios sin confirmar del proyecto, también los tuyos; si encuentra algo en lo que Claude no ha tocado, Claude te lo comenta en vez de cambiarlo.
- La revisión añade entre medio minuto y unos minutos por turno y gasta de tu plan de ChatGPT, nunca una clave de API. Mientras dura, la pestaña muestra «Codex está revisando el código». Solo revisa una vez por turno, en los turnos empezados con el interruptor encendido, solo en proyectos con git y nunca al cerrar una sesión. Si pulsas Esc o cierras la pestaña, se para.
- Lo que revisa Codex sale hacia OpenAI: queda anotado en el «Log» antes de enviarse. Antes de cada revisión se comprueba exactamente lo que se va a enviar; si lleva una clave, o no se puede comprobar, no se revisa y te avisa. Como Claude, Codex puede abrir otros archivos del proyecto para entender los cambios. Codex no guarda la sesión, y el resultado completo de cada revisión queda en la carpeta de registros solo con la depuración activada.
- El aviso de archivos que crecen es más fiable: cuenta también los cuadernos de Jupyter (solo sus celdas de código), entiende las rutas relativas a la carpeta donde trabaja Claude y encuentra el archivo aunque Claude escriba uno enorme.
- Arreglado: un aviso de Claude que tardaba en responderse podía retrasar el siguiente, como el de «te necesita».

## 0.14.0 — 2026-11-21
- Nueva buena práctica en todos tus proyectos: cuando Claude edita un archivo de código que llega a 1 000 líneas, y otra vez cada vez que crece un 20 % más, te comenta al terminar si conviene partirlo en piezas más pequeñas. Solo avisa: no parte nada sin que se lo pidas.
- El aviso no salta con documentos, datos ni estilos, ni cuando Claude cambia el archivo con un comando de la terminal.

## 0.13.0 — 2026-11-21
- El recuento de tokens trabaja menos: tras cada respuesta mira solo las conversaciones de tus pestañas, y deja el repaso de todas las demás para una vez por minuto.
- Reorganización interna del código, sin cambios a la vista: la app es la misma, pero está dividida en piezas más pequeñas y pasa más comprobaciones automáticas antes de publicarse.
- Arreglado: al cerrar una pestaña quedaba guardado en memoria un dato suyo sin limpiar.

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
