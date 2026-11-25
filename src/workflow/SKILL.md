---
name: workflow-de-proyecto
description: Cómo hace ClaudHome el mapa «Workflow» de un proyecto (bloques, piezas, flechas, bucles y reglas) y en qué formato lo devuelve. La recibe el modelo aparte que dibuja el mapa (Codex o Claude en su propio proceso); la sesión principal de Claude no la carga.
version: 2
# Sube «version» solo si el cambio debe llegar a los mapas ya hechos: se completan al entrar en
# cada proyecto (Codex bajo o Haiku). Retocar el texto sin subirla no toca los mapas hechos.
---

# El mapa «Workflow» de un proyecto

## Para quién es

Para una persona que no conoce el proyecto (o no es programadora) y pulsa «Workflow» para entender cómo funciona: de dónde entran los datos, qué piezas hay, qué se lanza aparte, cómo se hablan, qué se repite solo y qué está prohibido o condicionado. Tiene que entenderlo de un vistazo y poder acercarse para ver más.

## Cómo lo presenta ClaudHome

Tú solo devuelves los datos; la app lo dibuja siempre igual. Saber cómo se dibuja te ayuda a elegir bien:

- **Cinco niveles de zoom** (vista general, bloques, piezas, detalle y detalle ampliado; + y − van de uno en uno). De lejos se ven los bloques con su resumen, sus flechas y las etiquetas de las flechas. Al acercarse aparecen las piezas (módulos) de cada bloque y la regla del bloque. Más cerca, el detalle de cada pieza: sus frases, sus reglas (✕), sus bucles (↻) y sus archivos.
- **Al entrar en un bloque** sus piezas salen del centro y se separan hasta su sitio, en una o dos columnas con un pasillo entre ellas; luego aparecen las flechas internas, cada una por su propio carril del pasillo y a su propia altura. Por eso, en «internas» pon solo las conexiones que ayudan a entender el bloque: 6 como mucho por bloque.
- **Columnas por tipo, de izquierda a derecha:** persona → interfaz → núcleo → proceso → datos, con dos bloques como mucho por columna. Los servicios de internet (tipo externo) van en una banda arriba, sobre el bloque con el que hablan.
- **Flechas entre bloques lejanos:** van por debajo de los bloques, cada una por su carril y con los tramos verticales separados y encajados, sin cruzarse. Cuantas menos, más claro: une bloques lejanos solo si es una conexión principal.
- **Al pasar el ratón** por un bloque (o, de cerca, por una pieza) se iluminan sus conexiones y lo que une, y lo demás se atenúa. **De cerca, pulsar una pieza** enseña en el Explorador el primero de sus «archivos»: pon primero el archivo principal, con su ruta relativa real.
- **Colores:** azul para los datos, ámbar para lo que se repite solo (↻), rojo discontinuo para las reglas que niegan o condicionan (✕).
- **El stack tecnológico** se abre con su botón «Stack Tecnológico», violeta y en la esquina del mapa, en un recuadro aparte: con qué está hecho el proyecto.
- **Lo que no cabe se corta.** Respeta las longitudes de cada campo. El título y el resumen de cada bloque se ajustan a su tamaño: un nombre corto se lee mejor.

## Método

1. Lee el árbol y los manifiestos para saber qué es: una web, una API, una app de escritorio, unos scripts, contenedores…
2. Busca la entrada: quién o qué pone el sistema en marcha (una persona, un temporizador, otro sistema, un webhook).
3. Agrupa en 3 a 6 bloques del propio equipo, más hasta 3 servicios de internet. Un bloque es lo que un usuario reconocería como una parte («la web», «el servidor», «la base de datos»), no una carpeta.
4. Dentro de cada bloque, de 1 a 8 piezas: las que hacen algo que se pueda explicar en una frase. El archivo principal va en «sub».
5. Las flechas: solo las principales, 12 como mucho y una por pareja de bloques («doble» si va y vuelve). Primero el camino principal de los datos.
6. Lo que se repite solo: temporizadores, tareas programadas, sondeos, reintentos. Con su frecuencia si se ve («↻ cada 5 min»).
7. Lo que niega o condiciona la comunicación: autenticación, permisos, tokens, validaciones, listas de acceso, cortafuegos, modos de solo lectura. Empieza por «✕».
8. Cada regla y cada bucle, con la ruta del archivo donde se ve en «fuente». Si no lo has visto en el material, no lo pongas.
9. El stack tecnológico: de 3 a 8 piezas, de la más importante a la menos: lenguaje y plataforma, marco principal, bibliotecas que definen el proyecto, base de datos, contenedores. Con la versión si sale en los manifiestos (la principal, «45», no «^45.2.3») y para qué se usa en dos o tres palabras. Nada de herramientas de desarrollo menores (linters, formateadores) salvo que sean lo único que hay.

## Cómo escribir

- Español sencillo, para alguien que no programa. Verbos concretos: «envía pedidos», «guarda las fotos», «avisa si falla».
- Nombres que la persona reconozca, no nombres internos: «Servidor de pedidos» mejor que «OrderController».
- Nombra solo lo que aparece en el material. No inventes piezas, servicios ni conexiones.
- Nunca escribas claves, contraseñas, tokens, direcciones internas ni valores de configuración: el material ya los trae tapados.
- No ejecutes comandos ni leas archivos: todo lo que necesitas está en el mensaje.

## Formato

Responde solo con JSON válido, sin texto alrededor:

```
{
  "resumen": "qué hace el proyecto, en una frase de 160 caracteres como mucho",
  "bloques": [{ "id": "corto-sin-espacios", "nombre": "24 caracteres", "tipo": "persona | interfaz | nucleo | proceso | datos | externo", "resumen": "70 caracteres" }],
  "modulos": [{ "id": "corto", "bloque": "id del bloque", "nombre": "22 caracteres", "sub": "archivo o pieza principal", "detalle": ["hasta 3 frases de 40 caracteres"], "archivos": ["rutas relativas"], "reglas": [{ "texto": "36 caracteres", "fuente": "ruta" }], "bucles": [{ "texto": "36 caracteres", "fuente": "ruta" }] }],
  "flechas": [{ "de": "id de bloque", "a": "id de bloque", "tipo": "datos | bucle | regla", "texto": "24 caracteres", "doble": false }],
  "internas": [{ "de": "id de módulo", "a": "id de módulo del mismo bloque", "tipo": "datos | bucle | regla" }],
  "reglas": [{ "bloque": "id", "texto": "36 caracteres", "fuente": "ruta" }],
  "stack": [{ "nombre": "22 caracteres", "version": "14 caracteres o vacío", "para": "30 caracteres" }]
}
```

- tipo **persona**: quien lo usa · **interfaz**: lo que se ve · **nucleo**: la lógica principal · **proceso**: programas, contenedores o servicios que se lanzan aparte · **datos**: archivos y bases de datos · **externo**: servicios de internet.
- Los servicios externos no llevan módulos.
- «reglas» de bloque: como mucho una por bloque, la más importante para entender quién puede hablar con quién.
- Si no hay reglas o bucles, listas vacías.

## Ejemplo

Una tienda web con su API, una base de datos y una pasarela de pago (resumido):

```
{
  "resumen": "Tienda web: el cliente elige productos, paga con tarjeta y la API guarda los pedidos.",
  "bloques": [
    { "id": "cliente", "nombre": "Cliente", "tipo": "persona", "resumen": "Elige productos y paga" },
    { "id": "web", "nombre": "Web de la tienda", "tipo": "interfaz", "resumen": "Catálogo, carrito y pago" },
    { "id": "api", "nombre": "Servidor de pedidos", "tipo": "nucleo", "resumen": "Recibe, valida y guarda los pedidos" },
    { "id": "bd", "nombre": "Base de datos", "tipo": "datos", "resumen": "Productos, clientes y pedidos" },
    { "id": "pago", "nombre": "Pasarela de pago", "tipo": "externo", "resumen": "Cobra con tarjeta" }
  ],
  "modulos": [
    { "id": "carrito", "bloque": "web", "nombre": "Carrito", "sub": "web/carrito.js", "detalle": ["Suma productos y calcula el total"], "archivos": ["web/carrito.js"], "reglas": [], "bucles": [] },
    { "id": "pedidos", "bloque": "api", "nombre": "Pedidos", "sub": "api/pedidos.py", "detalle": ["Comprueba el stock y guarda el pedido"], "archivos": ["api/pedidos.py"], "reglas": [{ "texto": "Solo clientes con sesión", "fuente": "api/pedidos.py" }], "bucles": [] },
    { "id": "limpieza", "bloque": "api", "nombre": "Limpieza", "sub": "api/tareas.py", "detalle": ["Borra carritos abandonados"], "archivos": ["api/tareas.py"], "reglas": [], "bucles": [{ "texto": "↻ cada noche a las 3:00", "fuente": "api/tareas.py" }] }
  ],
  "flechas": [
    { "de": "cliente", "a": "web", "tipo": "datos", "texto": "elige y paga", "doble": false },
    { "de": "web", "a": "api", "tipo": "datos", "texto": "envía el pedido", "doble": true },
    { "de": "api", "a": "bd", "tipo": "datos", "texto": "lee y guarda", "doble": true },
    { "de": "api", "a": "pago", "tipo": "regla", "texto": "✕ cobra con token", "doble": false }
  ],
  "internas": [{ "de": "limpieza", "a": "pedidos", "tipo": "bucle" }],
  "reglas": [{ "bloque": "api", "texto": "✕ Solo responde a la web", "fuente": "api/servidor.py" }],
  "stack": [
    { "nombre": "Python", "version": "3.12", "para": "el servidor" },
    { "nombre": "FastAPI", "version": "0.115", "para": "la API de pedidos" },
    { "nombre": "PostgreSQL", "version": "16", "para": "guardar los datos" },
    { "nombre": "Vue", "version": "3", "para": "la web de la tienda" },
    { "nombre": "Docker Compose", "version": "", "para": "arrancarlo todo junto" }
  ]
}
```
