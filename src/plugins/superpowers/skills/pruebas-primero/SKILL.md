---
name: pruebas-primero
description: Use when implementing new behavior or fixing a bug in code whose logic can be tested automatically - write a failing test first, watch it fail, make it pass, run the whole suite; never deletes working code. For purely visual changes use revision-visual instead.
---

# Pruebas primero (adaptada de test-driven-development, de obra/superpowers)

Adaptación de ClaudHome de la habilidad *test-driven-development* de
[obra/superpowers](https://github.com/obra/superpowers) (MIT, © 2025 Jesse Vincent; ver `LICENSE`
del plugin). Se conserva el método; se quita la obligación de borrar código y se acota a donde
encaja.

**Principio:** si no has visto fallar la prueba, no sabes si prueba lo correcto.

## Cuándo

- **Sí:** comportamiento nuevo con lógica (funciones, cálculos, validaciones, reglas, APIs) y
  **todo fallo que arregles** (la prueba que lo reproduce primero).
- **No hace falta:** cambios solo visuales (HTML, CSS, textos, colores): ahí manda
  `revision-visual`. Tampoco configuración, documentación o código generado.
- **Proyecto sin pruebas:** no montes un sistema de pruebas entero. Basta una comprobación
  mínima que se pueda repetir (un archivo de prueba con el ejecutor que ya traiga el lenguaje, p. ej.
  `node --test` o `python -m unittest`) para lo que cambias. Si ni eso tiene sentido, explica
  cómo lo has comprobado.

## El ciclo

1. **Rojo:** escribe una prueba pequeña que diga lo que debe pasar (un comportamiento, un
   nombre claro, código real, sin simulaciones salvo que no haya otra).
2. **Verla fallar:** ejecútala y comprueba que falla **por la razón esperada** (falta la
   función, el fallo existe), no por una errata.
3. **Verde:** el código justo para que pase. Nada de opciones «por si acaso».
4. **Suite completa:** pasa todas las pruebas del proyecto (`npm test`, `pytest`…), no solo la
   tuya. Si algo falla, aunque no lo hayas causado tú, dilo por su nombre.
5. **Ordenar:** con todo en verde, limpia (nombres, duplicados) sin cambiar el comportamiento.

## Si el código ya está escrito

**Nunca borres código que funciona para cumplir el método.** Añádele su prueba y demuestra que
la prueba sirve: rompe a propósito el código (o deshaz el arreglo) un momento, comprueba que
la prueba falla, y déjalo como estaba. Una prueba que nunca has visto fallar no demuestra nada.

## Señales de alarma

- Una prueba nueva que pasa a la primera: probablemente prueba lo que ya existía.
- «Ya lo he probado a mano»: no queda constancia ni se puede repetir.
- Probar la simulación en lugar del código real.
- Dar algo por terminado sin haber pasado la suite completa en este mismo turno.

Para escribir buenas pruebas (qué afirmar, cuándo simular), lee
[writing-good-tests.md](writing-good-tests.md), que se incluye sin cambios.
