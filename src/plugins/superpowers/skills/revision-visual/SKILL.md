---
name: revision-visual
description: Use when a change touches anything the user sees (web pages, HTML, CSS, an app window, charts, emails) and before claiming it looks right - capture it at several widths with the capturar_pantalla tool and inspect the images for overlaps, cut text, contrast and broken layout
---

# Revisión visual con capturas

**Principio:** lo visual no se da por bueno sin haberlo visto. Una prueba que pasa no dice si un
texto se corta o si dos cosas se pisan.

## Cuándo

Siempre que hayas cambiado algo que se ve: HTML, CSS, componentes de interfaz, plantillas,
gráficos, correos, la ventana de una app. También al revisar una interfaz que te pidan mejorar.

## Cómo

1. **Captura** con la herramienta `capturar_pantalla` de ClaudHome (servidor MCP
   `claudhome-codex`): la página del proyecto (un archivo `.html` de la carpeta o una dirección
   `http://localhost:…` de su servidor de desarrollo) a tres anchos: **390** (móvil), **1024**
   (tableta) y **1440** (escritorio). Si la página necesita que su servidor esté en marcha,
   arráncalo antes.
2. **Mira cada imagen** con Read. Busca, en este orden:
   - cosas que se **pisan** (textos, botones, etiquetas, menús);
   - **textos cortados** o que se salen de su caja;
   - **scroll horizontal** o elementos que se salen de la pantalla;
   - **contraste** pobre (texto gris claro sobre fondo claro, etc.);
   - lo que **falta** o está **vacío** cuando debería tener contenido.
3. **Arregla** lo que encuentres y vuelve a capturar hasta que las tres salgan limpias.
4. **Cuéntalo** al terminar: a qué anchos lo has visto y qué has corregido. Sin capturas no
   digas que «se ve bien».

## Si no se puede capturar

Si el proyecto no tiene nada que se pueda abrir en un navegador (por ejemplo, una app de
escritorio sin vista web o una terminal), dilo y explica cómo lo has comprobado en su lugar.
