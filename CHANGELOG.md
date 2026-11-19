# Cambios

Lo que trae cada versión de ClaudHome (antes, Claudes). Al pulsar «Actualizar»,
la app muestra las secciones de las versiones posteriores a la instalada. Cada
sección empieza con `## X.Y.Z — AAAA-MM-DD` y lleva un punto (`- `) por cambio.

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
