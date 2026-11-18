# MCP de "BluePlan" (BlueCode) — cómo conectar una IA

Servidor MCP remoto, sin autenticación (acceso público por link, igual que la app).

**Endpoint**: `https://blueplan-bluecode.web.app/mcp` (reemplazar por el dominio de tu despliegue Firebase)

## Conectar Claude Desktop / Claude Code

Agregar en `claude_desktop_config.json` (o el `.mcp.json` de un proyecto):

```json
{
  "mcpServers": {
    "blueplan": { "url": "https://blueplan-bluecode.web.app/mcp" }
  }
}
```

Cualquier otro cliente MCP compatible con transporte HTTP remoto se conecta igual, solo con esa URL.

## Conectar Gemini (gemini.google.com)

gemini.google.com → **Configuración y ayuda** → **Apps conectadas** → "Custom apps for Spark" → **Agregar una app personalizada** → pegar la misma URL.

Restricción de Google (no del servidor): por ahora solo está habilitado para cuentas personales, interfaz en inglés, cuenta ubicada en EE.UU., y con "Actividad" activada.

## Para una IA sin soporte MCP nativo

El endpoint habla JSON-RPC 2.0 estándar sobre HTTP POST. Sirve con `initialize` → `tools/list` → `tools/call` como cualquier servidor MCP; cualquier IA que pueda hacer una petición HTTP puede usarlo sin un cliente MCP formal.

## Herramientas disponibles

| Herramienta | Qué hace |
|---|---|
| `listar_simbolos` | Catálogo completo de símbolos válidos (RETIE, comunicaciones) y tipos de cable — llamar primero |
| `crear_sala` | Crea un plano nuevo, devuelve código de 4 caracteres + link |
| `leer_plano` | Lee membrete + todos los elementos, con posición **y caja (ancho/alto real)** de cada uno |
| `info_lienzo` | Dimensiones reales del lienzo (2200×1000) — para calcular escala antes de ubicar cosas |
| `convertir_posicion` | Traduce una posición relativa (%, ej. "20% desde la izquierda") a x,y reales |
| `verificar_espacio` | Chequea si una posición ya está ocupada antes de poner algo ahí (evita amontonar) |
| `buscar_elementos` | Busca elementos por cercanía a un punto y/o por tipo/símbolo, sin traer el plano completo — para revisar rápido una zona puntual |
| `resumen_plano` | Resumen liviano: cuántos elementos hay por tipo/símbolo, caja total del dibujo, y qué equipos quedaron sin conexión |
| `establecer_membrete` | Completa asignatario, código, resolución, ubicación, sede, etc. |
| `agregar_equipo` | Coloca un símbolo (RACK, AP, TDG, SPT, PANEL_SOLAR, etc.) en x,y — auto-conecta el cable "obvio" (SPT→TDG, AP→RACK, etc.) salvo que pidas lo contrario; admite `espejo:true` para invertirlo horizontalmente |
| `agregar_cuarto` | Coloca un cuarto/espacio rectangular |
| `agregar_cable` | Traza fibra/UTP/SPT/acometida entre dos puntos o dos elementos existentes; admite `diagonal:true` (línea recta, sin forzar ángulo recto) y, solo en fibra, `flecha:true` (cabeza de flecha en el extremo final — apagada por defecto) |
| `agregar_texto` | Anotación de texto flotante |
| `agregar_acotado` | Línea de medida recta con texto (ej. "25m UTP CAT6") |
| `agregar_elementos_lote` | Crea VARIOS elementos de una sola vez (mucho más rápido al recrear un plano entero); los cables pueden referenciar elementos anteriores del mismo lote por un alias `ref` |
| `alinear_elementos` | Alinea 2+ elementos a un borde/centro común |
| `distribuir_elementos` | Reparte 3+ elementos a distancia pareja |
| `editar_elemento` | Cambia posición, color, etiqueta, tamaño de un elemento por su id; también `espejo`, `offset_etiqueta:{dx,dy}` (mover el texto, radio máx. 240), `diagonal` y `flecha` (para cables) |
| `eliminar_elemento` | Borra un elemento por id |
| `editar_elementos_lote` | Edita VARIOS elementos de una sola vez, cada uno con su propio id y campos |
| `eliminar_elementos_lote` | Borra VARIOS elementos de una sola vez por sus ids |
| `mover_elementos` | Desplaza un grupo entero de ids por un mismo delta (dx,dy), preservando su posición relativa |
| `limpiar_plano` | Vacía todos los elementos (requiere `confirmar:true`) |

## Cómo pedirle a una IA que recree una imagen

1. Mandarle la imagen del plano/diagrama de red.
2. Pedirle: *"Usá el MCP de plano-instalación: creá una sala, llamá listar_simbolos para ver qué símbolos hay, y recreá este diagrama con agregar_equipo/agregar_cuarto/agregar_cable según lo que veas en la imagen."*
3. La IA arma el plano llamando a las herramientas; el link que le pidas (`crear_sala`) lo podés abrir en el navegador y ver los cambios en vivo, como si la IA fuera otro colaborador más escribiendo en tiempo real.

## Metodología para la IA — algoritmos recomendados

Esta sección está escrita PARA LA IA que va a usar las herramientas, no para el humano. Son pasos fijos, pensados para que cualquier modelo — incluso uno chico y rápido — los pueda seguir sin tener que razonar de más ni gastar llamadas de sobra. Elegí el algoritmo según lo que te pidan y seguilo en orden.

### Regla de oro: agrupá, no repitas

Si vas a crear, editar, borrar o mover 2 o más elementos, usá SIEMPRE la versión de lote (`agregar_elementos_lote`, `editar_elementos_lote`, `eliminar_elementos_lote`, `mover_elementos`). Nunca llames la versión individual (`agregar_equipo`, `agregar_cable`, `editar_elemento`, `eliminar_elemento`) en un loop para lo mismo — cada llamada de más es tiempo y riesgo de dejar el plano a medias si algo falla en el medio.

### Algoritmo 1 — Recrear un plano a partir de una imagen

1. `crear_sala` si no tenés una sala ya (guardá el código, no lo vuelvas a pedir).
2. `listar_simbolos` — UNA sola vez, al principio de todo. No la llames de nuevo entre elementos.
3. `info_lienzo` — UNA sola vez, para saber el tamaño real del lienzo (2200×1000) y el margen.
4. Mirá la imagen e identificá primero los cuartos/espacios grandes (son el "marco" del resto). Si tenés la posición como % de la imagen en vez de coordenadas, convertila con `convertir_posicion`.
5. Armá TODO en UNA sola llamada a `agregar_elementos_lote`: primero los cuartos, después los equipos (con `ref` para poder engancharles cables del mismo lote), después cables/textos/acotados.
6. Por cada equipo: si la conexión que ves en la imagen es la "obvia" del RETIE (SPT→tablero, AP→RACK, toma→tablero, etc.), dejá `auto_conectar` en su valor por defecto (`true`) y NO agregues ese cable a mano — se duplicaría. Si la conexión es distinta a la regla automática, poné `auto_conectar:false` en ese equipo puntual y agregá el cable vos mismo, dentro del mismo lote.
7. Terminado el lote, llamá `resumen_plano` (no `leer_plano`) para chequear rápido: ¿la cantidad por tipo tiene sentido?, ¿quedó algún equipo en `sin_conexion` que en la imagen sí tenía cable? Si hay, agregá el/los cable(s) que faltan.
8. Si algo quedó desalineado, corregilo en una sola pasada con `alinear_elementos` / `distribuir_elementos` / `mover_elementos` sobre el grupo — nunca elemento por elemento con `editar_elemento`.
9. Recién al final, si necesitás confirmar cada campo de cada elemento (por ejemplo antes de un export), llamá `leer_plano` una vez.

### Algoritmo 2 — Construir desde una descripción en texto (sin imagen)

Igual que el Algoritmo 1, pero sin el paso de convertir porcentajes: ubicá los elementos directamente en unidades del lienzo a partir de frases relativas ("al fondo" → y alto, "a la izquierda" → x bajo, "en el centro" → x≈1100, y≈500). Si una medida es ambigua, preguntá una sola vez con una posición tentativa en vez de ir corrigiendo de a poco con llamadas sueltas.

### Algoritmo 3 — Corregir o revisar un plano ya existente

1. `resumen_plano` primero — siempre, es la llamada más barata para entender qué hay.
2. Si buscás algo puntual ("el RACK", "lo que está cerca de tal punto"), usá `buscar_elementos` en vez de `leer_plano` — no trae el JSON completo.
3. Si vas a tocar 2+ elementos, usá las herramientas de lote / `mover_elementos` en una sola pasada.
4. Usá `leer_plano` solo cuando de verdad necesites cada campo de cada elemento.

### Antipatrones — nunca hagas esto

- ❌ Llamar `agregar_equipo`, `editar_elemento` o `eliminar_elemento` en loop para varios elementos → usá la versión de lote.
- ❌ Llamar `listar_simbolos` o `info_lienzo` más de una vez en la misma sesión.
- ❌ Agregar a mano un cable que ya salió por auto-conexión (revisá el campo `autoconexion` de la respuesta de `agregar_equipo`/`agregar_elementos_lote` antes de agregar otro).
- ❌ Usar `leer_plano` para un chequeo rápido cuando `resumen_plano` o `buscar_elementos` alcanzan.
- ❌ Corregir de a un elemento cuando el cambio aplica a todo un grupo.

## Etiquetas de cable automáticas

Si creás un cable **sin** `etiqueta`, la app le pone sola el rótulo normalizado y lo mantiene al día cuando movés los equipos. No hace falta que lo calcules:

| Tramo | Rótulo | Calibre |
|---|---|---|
| TDG ↔ TDS | `3X10 12m` | 10 |
| TDG ↔ CONTADOR (`MEDIDOR`) | `3X6 12m` | 6 |
| TDS ↔ RACK | `3X12 12m` | 12 |
| RACK ↔ AP interior/exterior | `UTP 12m` | — |
| Cualquier cable de puesta a tierra (`k:'spt'`) | `#8 12m` | #8 fijo, no varía por tramo |

- El **primer número** son los conductores: `3` (fase + neutro + tierra) si el plano tiene alguna puesta a tierra, `2` si no. Se corrige solo al agregar el SPT después.
- El **último número** es el metraje, deducido de la escala del plano (bajo 10 m se muestra con un decimal). Se recalcula solo: pongas el acotado antes o después de los equipos, y cada vez que lo modifiques.
- Si mandás `etiqueta` explícita, manda la tuya y la app no la vuelve a tocar.

### De dónde sale la escala

La escala sale de los **acotados** (`agregar_acotado`): uno rotulado `"10m"` le enseña a la app cuántas unidades de lienzo vale un metro. Sin ningún acotado se usa un valor de reserva y el metraje es solo una estimación — **poné al menos un acotado real**.

Cuando hay varios acotados, la app se queda con el **consenso**: agrupa los que coinciden entre sí (±25 %) y usa el grupo más numeroso; si hay empate, gana el de mayor longitud dibujada. Esto importa porque no todo acotado sirve como referencia de escala: uno que rotula un **tramo de cable** (`"25m UTP CAT6"`) mide 25 m de cable serpenteando, no la distancia recta dibujada, y como referencia daría una escala falsa. Para que la escala salga bien, **acotá distancias rectas reales del sitio** (el ancho de un aula, la separación entre dos puntos) y dejá los rótulos de cable para anotar, no para medir.

## Cartel automático junto al RACK

Todo `RACK` (19") trae solo, al lado, un cartel de texto fijo "EQUIPOS / TELCO / UPS" — se crea y ubica automáticamente sin cruzarse con ningún otro símbolo, cuarto, cable o etiqueta. No hace falta (ni conviene) crearlo a mano con `agregar_texto`: se generaría un duplicado.

## Bajante de fibra automática del POSTE

Todo `POSTE` trae sola una fibra que sale del plano rumbo al nodo de la operadora, con cabeza de flecha y rotulada `DISTANCIA ESTIMADA A <MUNICIPIO> NODO TENTATIVO 2.27 KM`. El municipio se toma del membrete (`establecer_membrete`) y se actualiza solo si lo cambiás.

El **nodo está a kilómetros, fuera del dibujo**: esa línea es simbólica y su distancia NO se puede deducir de la escala del plano, así que el `2.27` es un valor por defecto para reemplazar. Si conocés la distancia real, mandá la `etiqueta` completa con tu número (o editala en la app) y queda fija. No la crees a mano con `agregar_cable`: se duplicaría.

## Categoría HSEQ — evacuación y emergencias

`listar_simbolos` incluye una novena categoría con símbolos para planos de evacuación/emergencias, con los colores normativos reales (rojo = equipo contra incendio, verde = condición segura/evacuación):

| Símbolo | Qué es |
|---|---|
| `EXTINTOR` | Extintor |
| `BOTIQUIN` | Botiquín de primeros auxilios |
| `PUNTO_ENCUENTRO` | Punto de encuentro |
| `RUTA_EVACUACION` | Ruta de evacuación / salida — es una flecha; usá `espejo`/rotación para que apunte en la dirección real de cada tramo |
| `ALARMA_INCENDIO` | Alarma / pulsador de incendio |
| `CAMILLA` | Camilla |
| `PELIGRO_ELECTRICO` | Peligro / riesgo eléctrico (triángulo de advertencia) |
| `TELEFONO_EMERGENCIA` | Teléfono de emergencia |

Se colocan igual que cualquier otro equipo, con `agregar_equipo`/`agregar_elementos_lote` (`RUTA_EVACUACION` no tiene conexión automática — no forma parte de ninguna regla RETIE, va suelta indicando dirección).

## Texto de varias líneas

Cualquier campo de texto (`etiqueta`, `texto`, nombre de un cuarto, acotado) acepta saltos de línea con `\n` y se dibuja en varios renglones. Los elementos también admiten `tamano` para el cuerpo del texto; desde la app se pueden además alinear (izquierda/centro/derecha) y rotar el texto aparte del símbolo.

## Costo y seguridad

- Sin login: cualquiera con el código de sala (o que llame `crear_sala`) puede leer/escribir esa sala — mismo modelo que ya elegiste para la app.
- Costo esperado con uso normal (decenas de llamadas por día): **$0/mes**, dentro de las capas gratuitas de Cloud Functions y Firestore. Alerta de presupuesto manual recomendada: Cloud Console → Facturación → Presupuestos y alertas.
- Las 5 herramientas nuevas (`buscar_elementos`, `resumen_plano`, `editar_elementos_lote`, `eliminar_elementos_lote`, `mover_elementos`) no cambian el perfil de costo: son lecturas/escrituras de Firestore igual de livianas que el resto, sin dependencias nuevas ni más memoria/tiempo de ejecución por llamada. Agregar herramientas no cuesta nada en sí mismo — lo que cuesta es cuántas veces se invocan y cuánto CPU/memoria usa cada una, y estas están en la misma categoría barata que ya tenían las otras 18.
- Cada escritura queda identificada como `"IA (MCP)"` en el campo de autor — los colaboradores humanos ven el toast "Plano actualizado por IA (MCP)" en tiempo real.
