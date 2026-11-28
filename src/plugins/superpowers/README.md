# SuperPowers de ClaudHome

Plugin que ClaudHome carga solo en las pestañas con «SuperPowers» encendido (`--plugin-dir`).

## Qué trae

- `skills/verification-before-completion` y `skills/systematic-debugging`: copiados de
  [obra/superpowers](https://github.com/obra/superpowers) (commit `22f0b463e7a5`, 2026-11-03),
  © 2025 Jesse Vincent, con licencia MIT (ver `LICENSE`). Único cambio: en
  `systematic-debugging/SKILL.md`, las referencias `superpowers:…` apuntan a las de este plugin.
- `skills/pruebas-primero`: **adaptación** de `test-driven-development` del mismo repositorio.
  Conserva el ciclo rojo-verde-ordenar y la suite completa; quita la orden de borrar el código
  escrito antes de su prueba (nunca se borra código que funciona: se le añade la prueba y se
  comprueba que falla al romperlo) y se limita a lógica que se pueda probar. Su
  `writing-good-tests.md` va sin cambios.
- `skills/revision-visual`: propia de ClaudHome. Cómo revisar la interfaz con la herramienta
  `capturar_pantalla` antes de dar un cambio visual por terminado.

La pasada final, el esfuerzo alto, el límite de subagentes y las ideas para el proyecto los pone
ClaudHome (src/main/superpowers.js), no este plugin.
