'use strict';
/* --------------------------------------------------------------------------
   TERCER PASE — COMPARAR EL RESULTADO CONTRA EL DIBUJO ORIGINAL

   Las dos primeras pasadas LEEN la imagen: una saca los cuartos, la otra los
   equipos, cables y cotas. Ninguna de las dos ve nunca el resultado. Y ese es
   el límite: el modelo entrega lo que cree haber visto, el acomodado lo ordena
   lo mejor que puede con reglas, y nadie mira el plano terminado para decir
   "esto no se parece al dibujo" o "ese rótulo quedó encima de aquél".

   Acá se hace justamente eso. Se le pasan al modelo DOS imágenes:

     IMAGEN A — la captura original, que es la verdad.
     IMAGEN B — el plano ya dibujado, rasterizado por el propio editor.

   Y se le pide una lista corta de correcciones, no un plano nuevo. Esa es la
   decisión de diseño que sostiene todo lo demás: una tercera pasada que
   devolviera elementos podría deshacer el trabajo bueno de las dos primeras.
   Devolviendo solo correcciones —mové esto, renombrá aquello, falta esto,
   sobra lo otro— lo peor que puede pasar es que corrija de menos.

   Las coordenadas van SIEMPRE en 0..1000 sobre la IMAGEN B, no sobre la A. Es
   lo que permite que el cliente las traduzca a unidades del lienzo sin
   adivinar: él mismo generó B y sabe exactamente con qué recuadro la armó.
   -------------------------------------------------------------------------- */
const { ICONS } = require('./catalog');
const { pedirAGemini } = require('./interpretar');
const { acomodarPlano, cajaDeRotulo } = require('./acomodar');

const ICON_KEYS = ICONS.map(i => i.k);

/* Topes de sanidad: una revisión sensata corrige unas pocas cosas. Si el
   modelo devuelve cuarenta "sobrantes" es que entendió mal el trabajo, y en
   ese caso vale más aplicar poco que romper el plano. */
/* Topes de sanidad, NO de prudencia. Se subieron cuando la revisión pasó a ser
   exhaustiva: un plano cargado al que le falta medio tendido puede necesitar
   cuarenta correcciones legítimas, y recortarlas en doce dejaba el trabajo a
   medias. Siguen existiendo para que una respuesta descarrilada no meta
   doscientos elementos en el plano de alguien. Borrar es lo único que se
   mantiene corto: es la única acción que destruye. */
const MAX_FALTANTES = 40, MAX_SOBRANTES = 25, MAX_MOVER = 60, MAX_RENOMBRAR = 50;

const PROMPT_REVISION = `Sos el revisor final de un plano de instalación eléctrica y de redes (RETIE / cableado estructurado), y sos EXIGENTE. Te paso DOS imágenes del MISMO plano:

IMAGEN A — el dibujo original. Es la VERDAD: todo lo que hay que representar está ahí.
IMAGEN B — cómo quedó el plano después de interpretarlo. Es lo que hay que llevar a ser igual a A.

TU CRITERIO: que B termine conteniendo TODO lo que muestra A. No te conformás con que se parezca. Lo que falta, falta, aunque sea un solo símbolo en un rincón. Una revisión que devuelve las listas vacías sobre un plano al que le faltan cosas es una revisión fallida.

Lo que NO hacés es inventar: solo devolvés lo que PODÉS VER en A. Ser exigente es comparar hasta el último símbolo, no completar con lo que suele haber en un plano.

TODAS las coordenadas que devuelvas van en 0..1000 sobre la IMAGEN B (la del plano dibujado), nunca sobre la A.

CÓMO REVISAR — hacelo en este orden, y no saltees ninguno:

PASO 1. BARRIDO DE A. Recorré la IMAGEN A entera de forma sistemática: cuarto por cuarto, y dentro de cada cuarto muro por muro (norte, este, sur, oeste), y después todo lo que esté por fuera del edificio. Anotá mentalmente CADA símbolo que ves y CADA texto que está escrito.

PASO 2. CONTÁ. Por cada tipo de símbolo, contá cuántos hay en A y cuántos hay en B. Tableros, tomas, tierras, APs, postes, racks, medidores, puertas. Si en A hay tres tomas y en B hay dos, falta una: eso va en \"faltantes\" aunque no estés seguro de cuál de las tres es. Los números tienen que dar.

PASO 3. FALTANTES — es lo más importante de tu trabajo. Todo lo que está en A y no está en B. Para cada uno: la clave del catálogo (lista al final), el rótulo tal como está escrito en A, y la caja donde tiene que ir en B — en la MISMA posición relativa que ocupa en A (mismo muro, mismo cuarto, mismo lado).

PASO 4. RÓTULOS. Comparalos LETRA POR LETRA. Si en A dice \"TDG EXISTENTE\" y en B dice \"TDE Existente\", \"TDG\" o cualquier otra cosa, va en \"renombrar\" con el texto exacto de A. Una sigla mal leída cambia el material que se compra.

PASO 5. POSICIONES Y SOBREPOSICIONES. Todo lo que en B esté encimado con otra cosa, tapando un rótulo, cruzado sobre una línea, amontonado en un rincón, o en un lugar que no se corresponde con A. Va en \"mover\", con la caja donde SÍ debería estar: en el hueco libre más cercano, sin cambiar de muro ni de cuarto.

PASO 6. SOBRANTES. Lo que está en B y no está en A: un símbolo inventado, o el mismo leído dos veces. Va con el id del inventario.

LO QUE EL EDITOR PONE SOLO — NO son sobrantes, NO los pidas ni los toques:
· El metraje de cada cable (\"3X10 6m\", \"#8 15m\", \"UTP 5m\", \"FIBRA 28m\"). Lo calcula y lo escribe el editor.
· El cartel \"EQUIPOS / TELCO / UPS\" que acompaña a todo RACK.
· Las TOMAS DE MÁS: el editor completa hasta tres por cuarto cargado. Si en B hay más tomas que en A, eso NO es un sobrante. Al revés sí importa: si en A hay más que en B, faltan.
· Las cotas que dicen \"? m\": las deja en blanco el editor para que las complete una persona.
· La línea de fibra que sale de un poste hacia afuera del plano con la distancia al nodo.
· El nombre de cada cuarto escrito en su centro.

REGLAS MECÁNICAS (romperlas hace que tu corrección se descarte):
· Los ids de \"sobrantes\", \"mover\" y \"renombrar\" salen del inventario de abajo. Uno inventado se tira.
· El símbolo de un \"faltante\" tiene que ser una clave EXACTA de la lista del final.
· No cambies nada de muro ni de cuarto: si en B está sobre el muro sur, la corrección va sobre el muro sur.
· Las cajas van en 0..1000 sobre la IMAGEN B.

INVENTARIO DE LA IMAGEN B (id · símbolo · rótulo · caja [ymin,xmin,ymax,xmax] en 0..1000):
`;

/** Las claves válidas, al final del prompt: el modelo tiene que elegir de acá
    para los faltantes. El esquema además lo obliga, pero decírselo mejora la
    elección — sin la lista tiende a pedir el símbolo que le suena. */
const LISTA_SIMBOLOS = ICONS.map(i => `${i.k} = ${i.name}`).join('\n');

/** El esquema cerrado de la respuesta. Que `simbolo` sea un enum del catálogo
    real es lo que impide que la revisión meta un símbolo que el editor no
    tiene — vale más que validarlo después. */
function esquemaRevision(){
  const caja = {
    type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4,
    description: 'Caja [ymin, xmin, ymax, xmax] en 0..1000 sobre la IMAGEN B'
  };
  /* El esquema se mantiene DELIBERADAMENTE simple, con la misma forma que el
     de las fases de lectura, que es la que se sabe que los modelos aceptan:
     arrays sin tope, objetos con `properties` + `required`, y un solo `enum`
     —el del catálogo— que es el único que de verdad hace falta para que no se
     inventen símbolos. Los topes de cantidad y los valores válidos de `motivo`
     se aplican después, en sanear(): validar del lado de casa no cuesta nada y
     no arriesga que un modelo rechace el pedido entero con un 400 genérico.
     Eso último no es teoría: el esquema anterior, con topes y enums de más,
     lo rechazaron los cinco modelos de la cadena. */
  return {
    type: 'object',
    properties: {
      mover: {
        type: 'array',
        items: { type: 'object', required: ['id', 'caja', 'motivo'],
                 properties: { id: { type: 'string' }, caja,
                               motivo: { type: 'string' } } }
      },
      faltantes: {
        type: 'array',
        items: { type: 'object', required: ['simbolo', 'etiqueta', 'caja'],
                 properties: { simbolo: { type: 'string', enum: ICON_KEYS },
                               etiqueta: { type: 'string' }, caja } }
      },
      sobrantes: {
        type: 'array',
        items: { type: 'object', required: ['id', 'motivo'],
                 properties: { id: { type: 'string' }, motivo: { type: 'string' } } }
      },
      renombrar: {
        type: 'array',
        items: { type: 'object', required: ['id', 'etiqueta'],
                 properties: { id: { type: 'string' }, etiqueta: { type: 'string' } } }
      }
    },
    required: ['mover', 'faltantes', 'sobrantes', 'renombrar']
  };
}

const cajaValida = c => Array.isArray(c) && c.length === 4 &&
  c.every(n => typeof n === 'number' && isFinite(n));

/** Recorta la respuesta a lo que se puede aplicar sin riesgo: ids que existen
    de verdad, cajas bien formadas, símbolos del catálogo. Todo lo demás se
    tira en silencio — es preferible aplicar de menos que aplicar basura. */
function sanear(datos, inventario){
  const ids = new Set((inventario || []).map(e => String(e.id)));
  const d = datos || {};
  const lista = v => Array.isArray(v) ? v : [];
  return {
    mover: lista(d.mover)
      .filter(m => m && ids.has(String(m.id)) && cajaValida(m.caja))
      .slice(0, MAX_MOVER)
      .map(m => ({ id: String(m.id), caja: m.caja, motivo: m.motivo || 'fuera_de_lugar' })),
    faltantes: lista(d.faltantes)
      .filter(f => f && ICON_KEYS.includes(f.simbolo) && cajaValida(f.caja))
      .slice(0, MAX_FALTANTES)
      .map(f => ({ simbolo: f.simbolo, etiqueta: String(f.etiqueta || '').trim(), caja: f.caja })),
    sobrantes: lista(d.sobrantes)
      .filter(x => x && ids.has(String(x.id)))
      .slice(0, MAX_SOBRANTES)
      .map(x => ({ id: String(x.id), motivo: x.motivo || 'no_esta_en_el_dibujo' })),
    renombrar: lista(d.renombrar)
      .filter(r => r && ids.has(String(r.id)) && String(r.etiqueta || '').trim())
      .slice(0, MAX_RENOMBRAR)
      .map(r => ({ id: String(r.id), etiqueta: String(r.etiqueta).trim() }))
  };
}

/** El inventario, en texto, para que el modelo pueda nombrar lo que ve. */
const inventarioEnTexto = inv => (inv || [])
  .map(e => `${e.id} · ${e.k || e.t} · ${JSON.stringify(e.label || '')} · [${(e.caja || []).join(',')}]`)
  .join('\n');

/** Compara el plano dibujado contra el original y devuelve correcciones.
 *
 *  Va con `pensar: true` a propósito, que es lo contrario de las dos fases de
 *  lectura. Ahí se trataba de percibir —leer cajas de una imagen— y el
 *  presupuesto de pensamiento solo sumaba segundos. Acá hay que comparar dos
 *  dibujos y decidir qué está mal: eso es razonamiento, y se lo gana. */
async function revisarPlano({ apiKey, imagenB64, mime, imagenPlano, inventario }){
  const partes = [
    { text: PROMPT_REVISION + inventarioEnTexto(inventario) +
            '\n\nCLAVES DE SÍMBOLO VÁLIDAS (clave = qué representa):\n' + LISTA_SIMBOLOS },
    { text: 'IMAGEN A — el dibujo original:' },
    { inline_data: { mime_type: mime, data: imagenB64 } },
    { text: 'IMAGEN B — el plano ya dibujado, que es el que hay que corregir:' },
    { inline_data: { mime_type: 'image/png', data: imagenPlano } }
  ];
  const { datos, modelo } = await pedirAGemini({
    apiKey, fase: 'revision', partes, esquema: esquemaRevision(), pensar: true,
    /* Sin variedad: dos revisiones de la misma imagen tienen que decir lo
       mismo. Esto es una auditoría, no una redacción. */
    temperatura: 0
  });
  return { correcciones: sanear(datos, inventario), modelo };
}

/* ==========================================================================
   AUDITORÍA DE SUPERPOSICIONES — sin modelo, sin costo
   ========================================================================== */

/** Qué quedó encimado después de acomodar. No corrige: informa.
 *
 *  Sirve para dos cosas. Una, poder decirle al usuario "quedaron tres rótulos
 *  pisándose" en vez de que lo descubra mirando. La otra, más importante: es
 *  la única forma de saber si el acomodado está funcionando. Un número que se
 *  puede medir antes y después de cada cambio vale más que mirar capturas. */
function auditarChoques(els){
  const bultos = (els || []).filter(e =>
    (e.t === 'equip' || e.t === 'text') && e.x !== undefined);
  const choques = [];
  for (let i = 0; i < bultos.length; i++){
    for (let j = i + 1; j < bultos.length; j++){
      const A = bultos[i], B = bultos[j];
      const ca = cajaDeRotulo(A), cb = cajaDeRotulo(B);
      /* Se descuenta la holgura de cortesía que agrega cajaDeRotulo: acá
         interesa el solape REAL, el que se ve. */
      const sx = (ca.w + cb.w) / 2 - 8 - Math.abs(A.x - B.x);
      const sy = (ca.h + cb.h) / 2 - 8 - Math.abs(A.y - B.y);
      if (sx > 0 && sy > 0)
        choques.push({ a: A.id || A.ref, b: B.id || B.ref,
                       etiquetas: [A.label, B.label],
                       solape: Math.round(Math.min(sx, sy)) });
    }
  }
  return choques.sort((x, y) => y.solape - x.solape);
}

/** Reacomoda un plano existente y dice qué quedó chocando. Sin llamadas a
    ninguna API: es pura geometría, así que se puede correr todas las veces
    que haga falta y no cuesta nada. */
function ordenarPlano(elementos){
  const els = Array.isArray(elementos) ? elementos : [];
  const antes = auditarChoques(els);
  const ordenados = acomodarPlano(els, [], { soloOrdenar: true });
  return { els: ordenados, choques: auditarChoques(ordenados), choquesAntes: antes.length };
}

module.exports = { revisarPlano, ordenarPlano, auditarChoques,
                   esquemaRevision, sanear, PROMPT_REVISION };
