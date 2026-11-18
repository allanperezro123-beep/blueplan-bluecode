'use strict';
/* --------------------------------------------------------------------------
   INTÉRPRETE DE IMÁGENES → ELEMENTOS DEL PLANO
   Recibe una captura (o foto de un croquis) y devuelve cuartos, equipos y
   textos listos para empujar a `S.els` en el editor.

   Por qué vive acá y no en el navegador: la página del editor es PÚBLICA (se
   entra por link, sin login), así que una API key metida en el HTML se la
   lleva cualquiera que abra el inspector. Acá la key es un secreto de la
   Cloud Function y nunca sale del servidor: el navegador manda la imagen y
   recibe elementos, nada más.

   Coordenadas: se le piden a Gemini cajas [ymin, xmin, ymax, xmax]
   normalizadas 0..1000 sobre la imagen — es el formato en el que el modelo
   está calibrado para detección, bastante más preciso que pedirle
   directamente coordenadas del lienzo, que no conoce. La conversión a
   unidades del lienzo se hace acá, respetando la relación de aspecto de la
   imagen para que el plano no salga estirado.
   -------------------------------------------------------------------------- */
const { ICONS, CABLES } = require('./catalog');
const { CW, CH } = require('./geometria');
/* Todo lo que tiene que ver con DÓNDE va cada cosa vive en su propio módulo:
   acá se traduce la imagen, allá se acomoda el plano. */
const { acomodarPlano, nombreCanonico } = require('./acomodar');

const ICON_KEYS = ICONS.map(i => i.k);
const CABLE_KEYS = Object.keys(CABLES);

/* El nombre del modelo es el ÚNICO dato de todo esto que no se puede
   verificar sin la key, así que en vez de apostar a uno hay una cadena: se
   prueba el primero y, si Google contesta que no existe (o que esa key no lo
   tiene habilitado), se cae al siguiente. Si no anda ninguno, el error trae
   la lista de modelos que esa key SÍ puede usar — que es exactamente el dato
   que hace falta para corregirlo de una y no a ciegas.

   El orden es: lo que diga la variable de entorno, después lo que pidió el
   usuario, y de ahí para abajo los conocidos que seguro soportan visión y
   salida JSON con esquema. Cualquier Flash sirve: la tarea es de visión
   corta y lo que pesa es la latencia, no el razonamiento. */
/* Los alias `-latest` van PRIMERO en la lista de respaldo, y es una lección
   pagada: esta cadena tenía solo nombres de versión fijos y un día Google los
   sacó del catálogo. La interpretación empezó a fallar con 'ninguno de estos
   modelos existe para tu key' sin que nadie hubiera tocado una línea. Un alias
   no se vence: siempre apunta al flash vigente. Los nombres exactos siguen
   estando porque dan control fino sobre costo y calidad, pero ya no son lo
   único que sostiene el sistema. */
const MODELOS = [
  process.env.GEMINI_MODELO,
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-3.5-flash',
  'gemini-2.5-flash'
].filter(Boolean);

/* --------------------------------------------------- un modelo por FASE --
   Las dos pasadas no piden lo mismo ni de lejos. Encontrar los cuartos es
   detectar cuatro rectángulos grandes: eso lo hace bien hasta el modelo más
   barato. Ubicar equipos, seguir el recorrido de un cable y leer cotas ya es
   otra cosa. Usar el modelo caro para las dos es tirar plata en la mitad
   fácil del trabajo.

   El orden va de más barato a más capaz, y se elige el PRIMERO que la key
   tenga habilitado de verdad — no se adivina. */
/* Cada cadena va del modelo PEDIDO hacia abajo. Los nombres de más arriba
   pueden no existir todavía —o no estar habilitados en esta key— y eso no
   rompe nada: modelosDeFase() filtra contra los modelos que la key tiene de
   verdad antes de probar ninguno, así que un nombre que no existe se saltea
   solo. Por eso se puede pedir el modelo nuevo el día que sale sin esperar a
   confirmarlo, siempre que abajo quede una alternativa que sí exista. */
const PREFERENCIA = {
  /* Encontrar cuatro rectángulos grandes lo hace bien el modelo más barato. */
  cuartos:  ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest',
             'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'],
  /* Ubicar equipos, seguir un cable y leer cotas ya es otra cosa: acá se pide
     el flash más capaz que haya. */
  resto:    ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
             'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-flash-latest'],
  /* La revisión compara DOS imágenes y decide qué está mal: es la única fase
     que razona en vez de percibir, y la única donde un modelo mejor se nota.
     Va con el tope de la casa. */
  revision: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.8-flash-preview',
             'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
             'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-pro-latest']
};

/* Los modelos que la key puede usar, averiguados UNA vez y guardados mientras
   la instancia siga viva. Sin esto habría que ir probando a ciegas y comerse
   un 404 por cada nombre que no exista, que es latencia pura. */
let disponiblesCache = null;

/** Cadena de modelos a probar para una fase, ya filtrada por lo que la key
    tiene. Si la consulta falla, se cae a la lista estática de siempre: es
    preferible probar a ciegas que no interpretar nada. */
async function modelosDeFase(apiKey, fase){
  const forzado = process.env.GEMINI_MODELO;
  if (forzado) return [forzado];
  const pref = PREFERENCIA[fase] || PREFERENCIA.resto;
  if (disponiblesCache === null) disponiblesCache = await listarModelos(apiKey);
  if (!disponiblesCache.length) return MODELOS;
  const hay = new Set(disponiblesCache);
  const elegidos = pref.filter(m => hay.has(m));
  return elegidos.length ? elegidos : MODELOS;
}

/** ¿El error de Google es "ese modelo no existe / no lo tenés"? Solo en ese
    caso tiene sentido probar el siguiente de la lista: si la imagen es
    inválida o la key está mal, reintentar con otro modelo da el mismo error
    cuatro veces y encima tarda cuatro veces más. */
const esModeloInexistente = (status, texto) =>
  status === 404 || /not found|is not supported|does not exist|NOT_FOUND/i.test(texto || '');

/** ¿Conviene pasar al siguiente modelo de la cadena?
 *
 *  No alcanza con "no existe": un modelo barato puede existir y aun así
 *  rechazar el pedido porque no soporta salida JSON con esquema, o imágenes,
 *  o el presupuesto de pensamiento. Eso llega como 400 INVALID_ARGUMENT y hay
 *  que tomarlo como "este no sirve para esto", no como error final — para eso
 *  está la cadena.
 *
 *  Lo que NO se reintenta: la key mal (401/403) y la cuota agotada (429). Ahí
 *  el problema no es el modelo y probar cuatro más solo suma espera. */
const convieneOtroModelo = (status, texto) => {
  if (status === 401 || status === 403 || status === 429) return false;
  return esModeloInexistente(status, texto) || status === 400;
};

/** Modelos que esa key puede usar para generateContent. Se llama SOLO cuando
    ya falló toda la cadena, para que el mensaje de error sea accionable. */
async function listarModelos(apiKey){
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''));
  } catch { return []; }
}

/* Topes de sanidad. No están para ahorrar: están para que una respuesta rara
   del modelo no meta 4000 elementos en el plano de alguien. */
const MAX_CUARTOS = 40, MAX_EQUIPOS = 120, MAX_TEXTOS = 60;

/* Mismos mínimos que usa el editor al redimensionar un cuarto a mano. */
const MIN_W = 60, MIN_H = 50;

/* Aire alrededor del dibujo, en unidades de lienzo: deja lugar para las cotas
   y para que nada nazca pegado al borde de la hoja. */
const MARGEN = 60;

/** Catálogo en texto para el prompt: la clave sola no le dice nada al modelo,
    necesita el nombre humano al lado para elegir bien. */
function listaDeSimbolos(){
  return ICONS.map(i => `${i.k} = ${i.name}`).join('\n');
}

/* El trabajo se parte en DOS pasadas contra el modelo, y no por precisión sino
   por percepción de espera: los cuartos son lo que más ordena la pantalla y
   salen en una consulta chica y rápida (sin la lista de 70 símbolos encima),
   así que se piden primero, se dibujan, y el usuario ya puede empezar a
   editar mientras la segunda pasada busca equipos, cotas y cables. Antes eran
   diez segundos mirando un cartel de "Leyendo…" sin nada en pantalla. */
const COMUN = `Sos un lector de planos de instalación eléctrica y de redes (RETIE / cableado estructurado). Te paso UNA imagen —casi siempre una captura de pantalla o la foto de un croquis hecho a mano— y la convertís en elementos para un editor de planos.

CÓMO RECONOCER: guiate por la FORMA del símbolo y por su POSICIÓN en el dibujo, NO por el color. El color cambia de plano en plano (y en una foto o una fotocopia se pierde del todo); la forma no. Un rectángulo con rayado diagonal es un tablero aunque esté en gris, y dos cosas del mismo color pueden ser símbolos distintos.

REGLA DEL SITIO: una "caja terminal", "caja de terminales" o cualquier cajita de la que salen varias fibras es un SPLITTER — devolvela con la clave NAP. Es lo que es en estas instalaciones, aunque el dibujo la rotule de otra forma.

LO QUE EL EDITOR ESCRIBE SOLO — no lo devuelvas, lo estarías duplicando:
· El METRAJE DE CADA CABLE. En cuanto el cable existe, el editor le calcula y le escribe su rótulo con el calibre y los metros ("3X10 1m", "#8 6m", "UTP 3.5m", "FIBRA 12m"). Si ves uno de esos escrito en el dibujo, NO lo devuelvas: ni como acotado ni como texto. Devolvé el CABLE, que es el dato que falta; el número lo pone el editor.
· El cartel "EQUIPOS / TELCO / UPS" que acompaña a todo RACK.
· El nombre de un cuarto como texto suelto — va en el campo "nombre" del cuarto.
· La etiqueta de un equipo — va en el campo "etiqueta" de ese equipo.`;

const PROMPT_CUARTOS = `${COMUN}

En esta pasada devolvés ÚNICAMENTE los cuartos. Nada más.

COORDENADAS: para cada cuarto devolvé una caja [ymin, xmin, ymax, xmax] con enteros de 0 a 1000 normalizados sobre la imagen (el mismo formato que usás para detección de objetos).

CUARTOS — habitaciones, aulas, oficinas, depósitos, salas de sistemas, pasillos cerrados. La caja es el rectángulo de sus MUROS (la pared exterior, no el texto de adentro).
· Si hay varios cuartos pegados uno al lado del otro, devolvé CADA UNO con su caja propia y hacé que el borde que comparten tenga EXACTAMENTE el mismo valor en los dos (si el muro derecho de uno está en x=520, el izquierdo del otro también va en x=520). No devuelvas un rectángulo grande que los abarque a todos.
· Alineá lo que en el dibujo está alineado: si dos cuartos arrancan a la misma altura, devolvé el mismo ymin para los dos.
· Los cuartos NO se superponen entre sí. Si dudás entre dos cajas que se pisan, devolvé la que de verdad tiene muros.
· "nombre": el texto escrito dentro del cuarto, tal cual está (ej. "AULA 1", "SALA DE SISTEMAS"). Si no tiene nombre, dejá "".

Devolvé solo lo que REALMENTE se ve. Pocos cuartos correctos valen más que muchos inventados.`;

const PROMPT_RESTO = `${COMUN}

Los cuartos de este plano YA fueron leídos en una pasada anterior: NO los devuelvas. En esta pasada van los equipos, las medidas, los cables y los textos sueltos.

ORDEN VISUAL — el resultado se dibuja tal cual, así que tiene que quedar legible:
· Dos equipos NO pueden quedar uno encima del otro. Si en el dibujo están juntos, devolvé cajas separadas, no superpuestas.
· Un equipo va DENTRO del cuarto al que pertenece, no montado sobre un muro.
· Los cables no tienen que cruzar cuartos ni pasar por encima de los equipos si se puede evitar: para eso están los "quiebres" (ver abajo).

COORDENADAS: para cada elemento devolvé una caja [ymin, xmin, ymax, xmax] con valores enteros de 0 a 1000 normalizados sobre la imagen que te paso (el mismo formato que usás para detección de objetos).

EQUIPOS — cada símbolo reconocible: tableros, tomas, racks, APs, postes, medidores, puestas a tierra, etc. Elegí la clave MÁS PARECIDA de la lista de abajo. Si un símbolo no se parece a ninguna de esas claves, NO lo devuelvas.
· "etiqueta": el texto que acompaña al símbolo si lo hay; si no, dejá "".

ACOTADOS — las medidas de ESPACIO: el ancho o el largo de un cuarto, una distancia entre dos puntos, una cota dibujada entre dos flechas ("6.20 m", "12m", "3,5 mts"). Son lo más valioso de todo: con una sola el plano entero queda a escala.
· NO es un acotado el metraje de un cable ("3X10 1m", "#8 6m", "UTP 3.5m"): eso lo escribe el editor solo, ver arriba. Un acotado mide el SITIO; el rótulo de un cable mide el tendido.
· "texto": la medida tal cual está escrita, con su unidad (ej. "6.20 m").
· La caja es la EXTENSIÓN de lo que esa medida mide: de punta a punta de la cota o del tramo medido, no la cajita del texto. Si la medida es horizontal, la caja tiene que ser ancha y baja; si es vertical, alta y angosta.
· Una medida NUNCA va en "textos": va acá.

CABLES — el recorrido de la acometida eléctrica y de las canalizaciones que se vean dibujadas (líneas entre el poste/medidor y el tablero, del tablero a las tomas, del rack a los APs, la bajante de puesta a tierra).
· "tipo": acom = acometida y alimentación eléctrica · spt = puesta a tierra · fibra = fibra óptica · utp = red de datos.
· "desde" y "hasta": los dos extremos del tramo, cada uno como [y, x] de 0 a 1000.
· Si el tramo arranca o termina en un equipo que ya devolviste, poné el extremo JUSTO encima de ese equipo — se engancha solo.
· "quiebres": los codos del recorrido, en orden, cada uno como [y, x]. Poné los que hagan falta para que el cable siga el camino REAL —bordeando muros, por el pasillo, pegado al techo— en vez de cortar en diagonal por encima de todo. Un tendido prolijo es el que rodea, no el que atraviesa. Si el tramo es recto, dejá la lista vacía.
· Si no se ve ninguna línea dibujada, devolvé la lista vacía. No inventes conexiones que no estén.

TEXTOS — solo rótulos sueltos que no sean el nombre de un cuarto, ni la etiqueta de un equipo, ni una medida (esos tres van en su lista propia). Notas y aclaraciones, nada más. Si no hay, devolvé la lista vacía.

CLAVES DE EQUIPO VÁLIDAS (clave = qué representa):
${listaDeSimbolos()}`;

/** Esquema de salida. El `enum` de claves es lo que garantiza que el modelo no
    invente un símbolo que el editor no tiene — vale más que validarlo después,
    porque lo obliga a elegir dentro del catálogo real. */
function esquemaRespuesta(fase){
  const caja = {
    type: 'array',
    items: { type: 'integer' },
    minItems: 4, maxItems: 4,
    description: 'Caja [ymin, xmin, ymax, xmax] normalizada 0..1000 sobre la imagen'
  };
  const cuartos = {
    type: 'array',
    items: {
      type: 'object',
      properties: { nombre: { type: 'string' }, caja },
      required: ['nombre', 'caja']
    }
  };

  /* Primera pasada: SOLO cuartos. El esquema chico es parte de por qué sale
     rápido — el modelo no tiene que decidir nada más. */
  if (fase === 'cuartos'){
    return { type:'object', properties:{ cuartos }, required:['cuartos'] };
  }

  return {
    type: 'object',
    properties: {
      cuartos,
      equipos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            simbolo: { type: 'string', enum: ICON_KEYS },
            etiqueta: { type: 'string' },
            caja
          },
          required: ['simbolo', 'etiqueta', 'caja']
        }
      },
      acotados: {
        type: 'array',
        items: {
          type: 'object',
          properties: { texto: { type: 'string' }, caja },
          required: ['texto', 'caja']
        }
      },
      cables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: CABLE_KEYS },
            desde: { type:'array', items:{ type:'integer' }, minItems:2, maxItems:2,
                     description:'[y, x] normalizado 0..1000' },
            hasta: { type:'array', items:{ type:'integer' }, minItems:2, maxItems:2,
                     description:'[y, x] normalizado 0..1000' },
            quiebres: {
              type:'array', maxItems: 6,
              description:'Codos del recorrido, en orden, cada uno [y, x] normalizado 0..1000',
              items: { type:'array', items:{ type:'integer' }, minItems:2, maxItems:2 }
            }
          },
          required: ['tipo', 'desde', 'hasta']
        }
      },
      textos: {
        type: 'array',
        items: {
          type: 'object',
          properties: { texto: { type: 'string' }, caja },
          required: ['texto', 'caja']
        }
      }
    },
    required: ['cuartos', 'equipos', 'acotados', 'cables', 'textos']
  };
}

/** Llama a Gemini por REST. Sin SDK a propósito: Node 22 ya trae fetch, y una
    dependencia menos es un arranque en frío más corto — que es justo lo que se
    nota en una función que se usa de a ratos. */
function armarCuerpo({ partes, esquema, sinPensar, temperatura }){
  const generationConfig = {
    /* Temperatura baja: esto es lectura, no redacción. Queremos que repita
       lo que ve, no que complete con lo que "suele haber" en un plano. */
    temperature: typeof temperatura === 'number' ? temperatura : 0.1,
    responseMimeType: 'application/json',
    responseSchema: esquema
  };
  /* Apagar el "pensamiento" es el ajuste que MÁS baja la latencia acá: esto
     es percepción —leer cajas de una imagen— y no razonamiento, así que el
     presupuesto de pensamiento por defecto suma segundos sin mejorar el
     resultado. Si el modelo no conoce el campo se reintenta sin él, así que
     no hay riesgo de romper con un modelo viejo.

     La fase de REVISIÓN es la excepción y no pide esto: ahí no se trata de
     leer, sino de comparar dos dibujos y decidir qué está mal. Eso sí es
     razonamiento y el presupuesto de pensamiento se gana su costo. */
  if (sinPensar) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return JSON.stringify({
    contents: [{ role: 'user', parts: partes }],
    generationConfig
  });
}

/** Las partes del pedido para las dos fases de LECTURA: el prompt y la imagen. */
const partesDeLectura = (imagenB64, mime, fase) => [
  { text: fase === 'cuartos' ? PROMPT_CUARTOS : PROMPT_RESTO },
  { inline_data: { mime_type: mime, data: imagenB64 } }
];

/** ¿El modelo rechazó el pedido porque no conoce `thinkingConfig`? */
const noConoceElCampo = t => /thinking|Unknown name|Invalid JSON payload/i.test(t || '');

async function pedirAGemini({ apiKey, fase, partes, esquema, pensar, temperatura }){
  let ultimoTexto = '';
  const cadena = await modelosDeFase(apiKey, fase);
  for (const modelo of cadena){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

    /* Primero sin pensar (rápido); si ese modelo no acepta el campo, se
       repite el intento con la config de siempre. */
    let saltarModelo = false;
    /* Dos intentos por modelo, en el orden que le conviene a la fase. Las de
       LECTURA arrancan sin pensamiento (es percepción: el presupuesto solo
       agrega segundos) y si el modelo no conoce el campo se repite con la
       config de siempre. La de REVISIÓN al revés: arranca pensando, porque ahí
       sí hace falta, pero conserva el segundo intento — un modelo que rechace
       el pedido por el presupuesto de pensamiento tiene que poder contestar
       igual en vez de tirar abajo la cadena entera. */
    for (const sinPensar of (pensar ? [false, true] : [true, false])){
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: armarCuerpo({ partes, esquema, sinPensar, temperatura })
      });
      const texto = await res.text();

      if (!res.ok){
        ultimoTexto = texto;
        /* Solo se prueba el siguiente MODELO si el problema es el modelo.
           Cualquier otro error (key inválida, imagen ilegible, cuota) se
           corta acá: da igual con cuál, y reintentar multiplica la espera. */
        /* Primero se reintenta SIN thinkingConfig sobre el mismo modelo: si
           el problema era solo ese campo, se resuelve sin cambiar de modelo
           ni perder calidad. */
        if (sinPensar && (noConoceElCampo(texto) || res.status === 400)) continue;
        if (convieneOtroModelo(res.status, texto)){ saltarModelo = true; break; }
        throw new Error(`Gemini respondió ${res.status}: ${texto.slice(0, 300)}`);
      }

      let json;
      try { json = JSON.parse(texto); }
      catch { throw new Error('Gemini devolvió una respuesta que no es JSON.'); }

      const parte = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!parte) throw new Error('Gemini no devolvió contenido (¿la imagen se pudo leer?).');
      try { return { datos: JSON.parse(parte), modelo, sinPensar }; }
      catch { throw new Error('El JSON del modelo vino mal formado.'); }
    }
    if (saltarModelo) continue;
  }

  /* Se acabó la cadena: el mensaje lleva los modelos REALES de esta key para
     poder fijar el correcto sin adivinar otra vez. */
  /* El mensaje SIEMPRE lleva lo último que contestó Google, y esa es una
     lección de depuración: antes decía 'ninguno de estos modelos existe' y
     listaba los disponibles, lo cual es cierto solo cuando el problema es el
     nombre. Si la cadena se agota porque el PEDIDO está mal (un esquema que
     el modelo no acepta, una imagen de más), todos contestan 400 y el mensaje
     mandaba a buscar donde no era. Costó una vuelta de despliegue entera. */
  const disponibles = await listarModelos(apiKey);
  const hayNombre = disponibles.length && !cadena.some(m => disponibles.includes(m));
  throw new Error(
    (hayNombre
      ? `Ninguno de estos modelos existe para tu key (${cadena.join(', ')}). ` +
        /* SIN recortar, y esto no es un detalle. Antes cortaba en 25 y los
           modelos NUEVOS son justamente los del final de la lista: leyendo ese
           mensaje se concluía que gemini-3.7 y 3.8 no existían para esta key
           cuando sí existían. Un mensaje de error que miente es peor que no
           tenerlo, porque manda a arreglar lo que no estaba roto. */
        `Modelos que sí podés usar: ${disponibles.join(', ')}.`
      : `Los ${cadena.length} modelos de la cadena rechazaron el pedido (${cadena.join(', ')}).`) +
    ` Última respuesta de Google: ${String(ultimoTexto).slice(0, 400)}`
  );
}

/** Convierte las cajas normalizadas a unidades del lienzo.
    La imagen se encaja ENTERA dentro del lienzo respetando su relación de
    aspecto (como un `contain`), así un croquis vertical no sale achatado. */
function proyector(imgW, imgH){
  const dispW = CW - MARGEN*2, dispH = CH - MARGEN*2;
  const anchoImg = imgW > 0 ? imgW : 1, altoImg = imgH > 0 ? imgH : 1;
  const escala = Math.min(dispW / anchoImg, dispH / altoImg);
  const usadoW = anchoImg * escala, usadoH = altoImg * escala;
  const offX = (CW - usadoW) / 2, offY = (CH - usadoH) / 2;
  /* n va de 0..1000 sobre la imagen; primero a píxeles de la imagen y de ahí
     al lienzo con la misma escala en los dos ejes. */
  return {
    x: n => offX + (n / 1000) * anchoImg * escala,
    y: n => offY + (n / 1000) * altoImg * escala
  };
}

const acotar = (v, min, max) => Math.max(min, Math.min(max, v));
const cajaValida = c => Array.isArray(c) && c.length === 4 && c.every(n => typeof n === 'number' && isFinite(n));

const puntoValido = p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && isFinite(n));

/* ------------------------------------------------ textos que son un ECO --
   El editor DIBUJA SOLO varias cosas: el metraje de cada cable
   (refreshAutoLabels), el cartel "EQUIPOS/TELCO/UPS" de todo RACK, el nombre
   centrado de cada cuarto y la etiqueta de cada equipo. El modelo lee esos
   mismos textos en la imagen original y los devuelve como texto suelto, así
   que terminaban dibujados DOS veces, uno encima del otro — que es la causa
   principal de que una interpretación se vea ilegible. Acá se descartan.

   Se descarta el eco, no el dato: "DISTANCIA ESTIMADA A CALOTO NODO
   TENTATIVO 2.27 KM" no lo genera nadie y se conserva. */

/** Normaliza para comparar: sin acentos, sin dobles espacios, en mayúsculas. */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  /* La coma decimal y el punto son el mismo número: "2,27 KM" y "2.27 KM" son
     el mismo rótulo leído dos veces, y si no se unifican no se deduplican.
     Se sacan además los signos de puntuación sueltos por el mismo motivo. */
  .replace(/(\d),(\d)/g, '$1.$2')
  .replace(/[.,;:·]+$/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

/* Metraje de cable tal como lo escribe etiquetaAuto(): un calibre opcional
   ("3X6", "#8", "2X10"), un tipo opcional ("UTP", "FIBRA"), y el número con
   la "m" al final. Ojo con el ancla `m$`: "2.27 KM" NO entra, y no tiene que
   entrar — esa es una distancia al nodo, no un metraje que el editor rotule
   solo. */
const RX_METRAJE = /^(?:#?\d+(?:\s*[xX×]\s*\d+)?\s*)?(?:utp|fibra|spt|acom(?:etida)?|cat\s?\d|f\.?o\.?)?\s*\d+(?:[.,]\d+)?\s*m$/i;

/* Un rótulo de CABLE se distingue de la medida de un cuarto por el prefijo:
   lleva calibre ("3X10", "#8") o tipo ("UTP", "FIBRA"). "8m" a secas es el
   ancho de un cuarto y hay que conservarlo — es de donde sale la escala de
   TODO el plano. Por eso no alcanza con RX_METRAJE para filtrar acotados:
   ese also matchea "8m", y descartarlo dejaría el plano sin referencia. */
const RX_ROTULO_DE_CABLE =
  /^(?:#\d+|\d+\s*[xX×]\s*\d+|utp|fibra|spt|acom(?:etida)?|cat\s?\d|f\.?o\.?)\b/i;

/* La distancia al nodo NO es una nota suelta: el editor la escribe solo sobre
   la bajante de fibra de todo POSTE (ver textoNodoPoste), con un kilometraje
   por defecto que el instalador reemplaza. Si el modelo la lee del dibujo y la
   devolvemos como texto, queda escrita DOS veces — y encima la buena, la que
   trae el número real de esa sede, es la que queda suelta y sin cable.

   Así que se hace al revés: se le saca el kilometraje, se lo pega al poste, y
   el texto se descarta. El número real termina donde tiene que estar, sobre la
   línea que lo explica. */
const RX_DISTANCIA_NODO = /DISTANCIA\s+ESTIMADA\b[^]*?\bNODO\b[^]*?(\d+(?:[.,]\d+)?)\s*KM\b/i;

/* Las tres palabras del cartel del RACK, sueltas o juntas. */
const RX_CARTEL_RACK = /^(?:EQUIPOS|TELCO|UPS)(?:[\s\/]+(?:EQUIPOS|TELCO|UPS))*$/;

/** ¿Este texto ya lo dibuja el propio editor en otro lado? */
function esEcoDeAlgoQueYaSeDibuja(texto, px, py, elementos){
  const t = norm(texto);
  if (!t) return true;
  if (RX_CARTEL_RACK.test(t)) return true;
  /* El tope de largo evita descartar una nota que casualmente termine en
     "m"; un metraje real siempre es corto. */
  if (t.length <= 20 && RX_METRAJE.test(texto.trim())) return true;
  /* Repite la etiqueta de un elemento que ya está dibujado cerca (el nombre
     de un cuarto, el rótulo de un equipo). El radio es generoso porque el
     modelo ubica el texto donde lo VE, que no es exactamente donde el editor
     lo va a dibujar. */
  const RADIO = Math.round(CW * 0.12);
  for (const el of elementos){
    const suyo = norm(el.label);
    if (!suyo || suyo !== t) continue;
    if (el.t === 'room'){
      /* Para un cuarto alcanza con caer adentro: su nombre va al centro. */
      if (px >= el.x - el.w/2 && px <= el.x + el.w/2 &&
          py >= el.y - el.h/2 && py <= el.y + el.h/2) return true;
    } else if (Math.hypot(el.x - px, el.y - py) <= RADIO) return true;
  }
  return false;
}

/** Alinea los muros que el modelo dejó "casi" iguales.
 *
 *  El modelo mira una imagen y devuelve enteros de 0..1000, así que dos muros
 *  que en el dibujo son EL MISMO muro vuelven casi siempre con dos o tres
 *  unidades de diferencia. Proyectado al lienzo eso son varias unidades: la
 *  luz o el solapamiento que se ve entre dos cuartos que deberían compartir
 *  pared. Acá se agrupan los bordes parecidos y se los lleva a un valor
 *  común (el promedio del grupo), que es el mismo criterio que usa el imán
 *  del editor al arrastrar, pero aplicado de una a todo lo que llegó.
 *
 *  Se hace sobre los CUATRO bordes por separado (izquierdos con izquierdos,
 *  derechos con derechos, etc. — todos juntos en una sola lista por eje) para
 *  que también queden alineados los cuartos que arrancan a la misma altura
 *  sin estar pegados. */
function alinearCuartos(cuartos, tol){
  const ejes = [['x1','x2'], ['y1','y2']];
  for (const [aMin, aMax] of ejes){
    const valores = [];
    for (const c of cuartos){ valores.push(c[aMin], c[aMax]); }
    /* Agrupamiento simple por cercanía sobre la lista ordenada: alcanza
       porque los bordes que hay que unificar difieren en pocas unidades. */
    const orden = valores.slice().sort((a, b) => a - b);
    const grupos = [];
    for (const v of orden){
      const g = grupos[grupos.length - 1];
      if (g && v - g[g.length - 1] <= tol) g.push(v);
      else grupos.push([v]);
    }
    const comun = new Map();
    for (const g of grupos){
      const prom = Math.round(g.reduce((t, v) => t + v, 0) / g.length);
      for (const v of g) comun.set(v, prom);
    }
    for (const c of cuartos){
      c[aMin] = comun.get(c[aMin]);
      c[aMax] = comun.get(c[aMax]);
    }
  }
  /* Un borde puede haber quedado del lado equivocado si el cuarto era muy
     finito y su grupo se fusionó con el del vecino: se restaura el mínimo. */
  for (const c of cuartos){
    if (c.x2 - c.x1 < MIN_W) c.x2 = c.x1 + MIN_W;
    if (c.y2 - c.y1 < MIN_H) c.y2 = c.y1 + MIN_H;
  }
}

/** Saca de la etiqueta de un equipo lo que el editor ya le dibuja al lado.
 *
 *  Caso real: el modelo leyó el cartel del RACK y devolvió el equipo con la
 *  etiqueta "RACK EQUIPOS,TELCO,UPS". El editor, además, le pone su propio
 *  cartel "EQUIPOS/TELCO/UPS" — así que el mismo texto terminaba dos veces,
 *  uno pegado al otro. Se recorta la etiqueta y queda el nombre del equipo. */
function limpiarEtiqueta(etiqueta, simbolo){
  if (!etiqueta) return '';
  /* Solo se toca el RACK: es el único equipo al que el editor le agrega una
     anotación propia. En cualquier otro, la etiqueta leída es la buena. */
  if (simbolo !== 'RACK') return etiqueta;
  const limpio = etiqueta
    .replace(/[\s,\/·]*\b(EQUIPOS|TELCO|UPS)\b/gi, '')
    .replace(/[\s,\/·]+$/, '')
    .trim();
  return limpio || 'RACK';
}

/** Traduce la respuesta del modelo a elementos del editor.
 *
 *  Los ids NO se asignan acá: los pone el cliente con su propio `uid()`, que
 *  es quien lleva la cuenta de `S.seq` y el único que puede garantizar que no
 *  choquen con lo que el plano ya tiene. Para que un cable pueda quedar
 *  ANCLADO a un equipo pese a eso, los equipos salen con un `ref` temporal y
 *  los extremos del cable apuntan a ese `ref`; el cliente traduce ref→id
 *  cuando reparte los ids. */
function aElementos(respuesta, imgW, imgH, yaEnElPlano, fase){
  const P = proyector(imgW, imgH);
  const els = [];
  /* Lo que el plano YA tiene (los cuartos de la primera pasada, sobre todo).
     Sin esto la segunda pasada no sabe que "SALA DE SISTEMAS" ya está escrito
     y lo agrega otra vez como texto suelto, justo encima del nombre real. */
  const previos = Array.isArray(yaEnElPlano) ? yaEnElPlano : [];

  /* ---------------- cuartos (con los muros ya alineados) ---------------- */
  const cajas = [];
  for (const c of (respuesta.cuartos || []).slice(0, MAX_CUARTOS)){
    if (!cajaValida(c.caja)) continue;
    const [ymin, xmin, ymax, xmax] = c.caja;
    cajas.push({
      x1: Math.round(P.x(Math.min(xmin, xmax))), x2: Math.round(P.x(Math.max(xmin, xmax))),
      y1: Math.round(P.y(Math.min(ymin, ymax))), y2: Math.round(P.y(Math.max(ymin, ymax))),
      nombre: String(c.nombre || '').trim()
    });
  }
  /* Tolerancia en unidades de lienzo: ~1% del ancho de la hoja. Suficiente
     para juntar el error de lectura del modelo sin fusionar muros que en el
     dibujo son de verdad distintos. */
  alinearCuartos(cajas, Math.round(CW * 0.01));

  cajas.forEach((c, i) => {
    els.push({
      t: 'room', rot: 0,
      /* El cuarto también lleva `ref`: un equipo pegado a su muro necesita
         apuntarle, y hasta que el cliente reparta los ids esta es la única
         identidad que hay. Lo demás lo hace iaVolcar. */
      ref: 'cu' + i,
      x: Math.round(acotar((c.x1 + c.x2) / 2, 0, CW)),
      y: Math.round(acotar((c.y1 + c.y2) / 2, 0, CH)),
      w: Math.max(MIN_W, c.x2 - c.x1),
      h: Math.max(MIN_H, c.y2 - c.y1),
      label: c.nombre || 'NOMBRE DEL ESPACIO',
      area: ''
    });
  });

  /* ---------------- equipos (cada uno con su `ref`) ---------------- */
  const equipos = [];
  for (const e of (respuesta.equipos || []).slice(0, MAX_EQUIPOS)){
    if (!cajaValida(e.caja) || !ICON_KEYS.includes(e.simbolo)) continue;
    const [ymin, xmin, ymax, xmax] = e.caja;
    const info = ICONS.find(i => i.k === e.simbolo);
    const el = {
      t: 'equip', k: e.simbolo, rot: 0,
      ref: 'ia' + equipos.length,
      x: Math.round(acotar(P.x((Math.min(xmin, xmax) + Math.max(xmin, xmax)) / 2), 0, CW)),
      y: Math.round(acotar(P.y((Math.min(ymin, ymax) + Math.max(ymin, ymax)) / 2), 0, CH)),
      /* El catálogo distingue "no le puse nombre" de "NO LLEVA nombre": la
         puerta y la brújula tienen `label: ''` a propósito, porque dibujadas
         con un rótulo debajo ("Brújula (Norte)") quedan como si fueran un
         equipo instalado. Caer a `info.name` para esos dos era convertir el
         nombre del catálogo en un cartel del plano. */
      label: limpiarEtiqueta(String(e.etiqueta || '').trim(), e.simbolo) ||
             (info.label !== undefined ? info.label : info.name),
      sub: ''
    };
    /* El nombre de obra se pone acá, antes que nada, porque el filtro de
       "textos que son un eco" compara contra las etiquetas ya puestas: si el
       equipo todavía se llamara "AP INTERIOR" (el nombre del catálogo), el
       rótulo suelto "AP INTERNO" que el modelo leyó en la imagen no se
       reconocería como el mismo y quedaría dibujado dos veces. */
    el.label = nombreCanonico(el);
    equipos.push(el); els.push(el);
  }

  /* ---------------- acotados: la parte más valiosa ----------------
     Una medida leída del dibujo no es un texto suelto: es la referencia con
     la que TODO el plano deduce su escala (ver escalaPlano en el editor). Se
     devuelve como elemento `dim` de punta a punta, y la orientación sale de
     la forma de la caja: ancha y baja = medida horizontal; alta y angosta =
     vertical. */
  for (const a of (respuesta.acotados || []).slice(0, MAX_TEXTOS)){
    if (!cajaValida(a.caja)) continue;
    const texto = String(a.texto || '').trim();
    if (!texto) continue;
    /* El modelo insiste en devolver el rótulo de un cable como si fuera una
       cota: es una medida escrita, después de todo. Pero ese número lo
       escribe el editor solo en cuanto el cable existe, así que una cota ahí
       sería el mismo dato dos veces — y encima una cota falsa, porque mide el
       tendido y no el sitio, y arrastraría mal la escala del plano. */
    if (RX_ROTULO_DE_CABLE.test(texto)) continue;
    const [ymin, xmin, ymax, xmax] = a.caja;
    const x1 = P.x(Math.min(xmin, xmax)), x2 = P.x(Math.max(xmin, xmax));
    const y1 = P.y(Math.min(ymin, ymax)), y2 = P.y(Math.max(ymin, ymax));
    const horizontal = (x2 - x1) >= (y2 - y1);
    const A = horizontal ? { x:x1, y:(y1+y2)/2 } : { x:(x1+x2)/2, y:y1 };
    const B = horizontal ? { x:x2, y:(y1+y2)/2 } : { x:(x1+x2)/2, y:y2 };
    /* Una cota de menos de 20u no se puede ni ver ni usar para escalar. */
    if (Math.hypot(B.x - A.x, B.y - A.y) < 20) continue;
    const dim = {
      t: 'dim',
      a: { x: Math.round(acotar(A.x, 0, CW)), y: Math.round(acotar(A.y, 0, CH)) },
      b: { x: Math.round(acotar(B.x, 0, CW)), y: Math.round(acotar(B.y, 0, CH)) },
      label: texto
    };
    /* Una cota VERTICAL con el número en horizontal queda cruzada sobre su
       propia línea y encima invade el cuarto que está midiendo. Girada, el
       número corre a lo largo de la cota, que es como se acota a mano. Los
       cables ya hacen esto solos (rotEtiquetaCable); los acotados no tenían
       quien se los pusiera. `textRot` gira SOLO el texto, no la cota. */
    if (!horizontal) dim.textRot = -90;
    els.push(dim);
  }

  /* ---------------- cables (acometida y demás tendidos) ----------------
     Cada extremo se engancha al equipo más cercano si cae bien encima; si no,
     queda como punto libre. Anclarlo importa: un cable anclado sigue al
     equipo cuando después se lo mueve, uno suelto se queda donde estaba. */
  const RADIO_ANCLA = Math.round(CW * 0.025);
  const anclar = (px, py) => {
    let mejor = null, dist = RADIO_ANCLA;
    for (const q of equipos){
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < dist){ dist = d; mejor = q; }
    }
    /* Se manda el `ref` JUNTO con las coordenadas: si por lo que sea el
       cliente no pudiera resolverlo, el extremo queda igual donde va como
       punto libre en vez de irse al origen. */
    return mejor
      ? { ref: mejor.ref, x: Math.round(px), y: Math.round(py) }
      : { x: Math.round(px), y: Math.round(py) };
  };
  for (const c of (respuesta.cables || []).slice(0, MAX_EQUIPOS)){
    if (!puntoValido(c.desde) || !puntoValido(c.hasta) || !CABLE_KEYS.includes(c.tipo)) continue;
    const ax = acotar(P.x(c.desde[1]), 0, CW), ay = acotar(P.y(c.desde[0]), 0, CH);
    const bx = acotar(P.x(c.hasta[1]), 0, CW), by = acotar(P.y(c.hasta[0]), 0, CH);
    if (Math.hypot(bx - ax, by - ay) < 15) continue;   /* tramo degenerado */
    /* Los quiebres son los codos del recorrido. El editor los respeta en
       orden y rutea en ángulo recto entre ellos, así que son la diferencia
       entre un cable que bordea el muro y uno que cruza el plano en diagonal
       por encima de todo. Se topean en MAX_ARTICULACIONES (5), el mismo tope
       que tiene el editor cuando se agregan a mano. */
    const quiebres = (Array.isArray(c.quiebres) ? c.quiebres : [])
      .filter(puntoValido)
      .slice(0, 5)
      .map(q => ({ x: Math.round(acotar(P.x(q[1]), 0, CW)),
                   y: Math.round(acotar(P.y(q[0]), 0, CH)) }));
    els.push({ t:'cable', k:c.tipo, a:anclar(ax, ay), b:anclar(bx, by),
               label:'', elbow:'auto', w:quiebres });
  }

  /* ---------------- textos sueltos ----------------
     Si un rótulo cae DENTRO de un cuarto que quedó sin nombre, se usa como
     nombre de ese cuarto en vez de dejarlo flotando: el editor lo dibuja
     centrado y ya no puede quedar cruzado ni escaparse del muro, que es
     justo lo que pasaba cuando volvía como texto suelto. */
  /* Los cuartos de ESTA pasada y los que ya estaban en el plano cuentan por
     igual: si el texto cae dentro de cualquiera de los dos, es su nombre. */
  const cuartosEls = els.filter(e => e.t === 'room')
    .concat(previos.filter(e => e.t === 'room'));
  const conEtiqueta = els.concat(previos).filter(e => e.label && e.x !== undefined);
  const dentroDe = (px, py) => cuartosEls.find(r =>
    px >= r.x - r.w/2 && px <= r.x + r.w/2 && py >= r.y - r.h/2 && py <= r.y + r.h/2);

  const textos = [];
  const yaVisto = [];
  for (const t of (respuesta.textos || []).slice(0, MAX_TEXTOS)){
    if (!cajaValida(t.caja)) continue;
    const texto = String(t.texto || '').trim();
    if (!texto) continue;
    const [ymin, xmin, ymax, xmax] = t.caja;
    const px = acotar(P.x((Math.min(xmin, xmax) + Math.max(xmin, xmax)) / 2), 0, CW);
    const py = acotar(P.y((Math.min(ymin, ymax) + Math.max(ymin, ymax)) / 2), 0, CH);

    /* La distancia al nodo se convierte en un dato del POSTE (el editor la
       dibuja sobre su bajante) en vez de quedar como un rótulo suelto. */
    const km = texto.match(RX_DISTANCIA_NODO);
    if (km && equipos.some(e => e.k === 'POSTE')){
      const postesFibra = els.filter(e => e.t === 'cable' && e.k === 'fibra')
        .flatMap(c => [c.a && (c.a.ref || c.a.id), c.b && (c.b.ref || c.b.id)]).filter(Boolean);
      const candidatos = equipos.filter(e => e.k === 'POSTE' &&
        (postesFibra.length ? postesFibra.includes(e.ref || e.id) : true));
      const poste = (candidatos.length ? candidatos : equipos.filter(e => e.k === 'POSTE'))
        .reduce((a, b) => Math.hypot(a.x - px, a.y - py) <= Math.hypot(b.x - px, b.y - py) ? a : b);
      poste.km = km[1].replace(',', '.');
      continue;
    }

    /* Si cae en un cuarto sin nombre, ES el nombre: el editor lo dibuja
       centrado y ahí ya no puede escaparse del muro ni cruzarse con nada. */
    const room = dentroDe(px, py);
    if (room && room.label === 'NOMBRE DEL ESPACIO'){ room.label = texto; continue; }

    if (esEcoDeAlgoQueYaSeDibuja(texto, px, py, conEtiqueta)) continue;

    /* El mismo rótulo leído dos veces (pasa con los que el dibujo repite, o
       cuando el modelo lo ve en dos renglones) se queda una sola vez. */
    /* Una nota larga repetida es SIEMPRE la misma nota, esté donde esté (el
       dibujo la escribe dos veces, arriba y abajo). Las cortas sí pueden ser
       dos cosas distintas en dos lugares distintos, así que ahí se exige
       cercanía. */
    const clave = norm(texto);
    const radio = clave.length >= 25 ? Infinity : CW * 0.25;
    if (yaVisto.some(v => v.clave === clave && Math.hypot(v.x - px, v.y - py) < radio)) continue;
    yaVisto.push({ clave, x:px, y:py });

    textos.push({ t:'text', rot:0, x:Math.round(px), y:Math.round(py), label:texto, size:17 });
  }
  els.push(...textos);

  /* ---------------- y recién ahora, el acomodado ----------------
     Hasta acá esto es una TRADUCCIÓN: cajas normalizadas de la imagen a
     elementos del lienzo, cada cosa donde el modelo la vio. Lo que sigue es
     otra cosa — aplicarle al conjunto la gramática de un plano de instalación
     (el rack contra un muro, los tableros en cadena, la tierra colgando de su
     tablero, las conexiones que la norma da por hechas). Vive aparte, en
     lib/acomodar.js, justamente porque no depende de la imagen ni del modelo:
     se le puede dar de comer cualquier lista de elementos. */
  return acomodarPlano(els, previos, { fase });
}

/** Qué modelos tiene esta key y con cuál se queda cada fase. Es el dato que
    hace falta cuando la interpretación deja de andar de un día para el otro
    porque Google retiró un nombre de versión. */
async function diagnosticoModelos(apiKey){
  const disponibles = await listarModelos(apiKey);
  const hay = new Set(disponibles);
  const porFase = {};
  for (const fase of Object.keys(PREFERENCIA)){
    const pedidos = PREFERENCIA[fase];
    const elegidos = pedidos.filter(m => hay.has(m));
    porFase[fase] = {
      usaria: elegidos[0] || MODELOS.find(m => hay.has(m)) || '(ninguno)',
      cadena: elegidos,
      pedidosQueNoExisten: pedidos.filter(m => !hay.has(m))
    };
  }
  return { disponibles, porFase };
}

/** Punto de entrada: imagen en base64 → elementos del editor. */
async function interpretarImagen({ apiKey, imagenB64, mime, imgW, imgH, fase, yaEnElPlano }){
  const { datos, modelo, sinPensar } = await pedirAGemini({
    apiKey, fase,
    partes: partesDeLectura(imagenB64, mime, fase),
    esquema: esquemaRespuesta(fase)
  });
  const els = aElementos(datos, imgW, imgH, yaEnElPlano, fase);
  return {
    els,
    resumen: {
      cuartos:  els.filter(e => e.t === 'room').length,
      equipos:  els.filter(e => e.t === 'equip').length,
      acotados: els.filter(e => e.t === 'dim').length,
      cables:   els.filter(e => e.t === 'cable').length,
      textos:   els.filter(e => e.t === 'text').length
    },
    modelo, sinPensar
  };
}

module.exports = { interpretarImagen, aElementos, proyector, esquemaRespuesta,
                   diagnosticoModelos,
                   pedirAGemini, ICON_KEYS,
                   listarModelos, esModeloInexistente, MODELOS };
