'use strict';
/* --------------------------------------------------------------------------
   ACOMODADO HEURÍSTICO — dejar el plano "como lo dejamos nosotros"

   Gemini lee la imagen y devuelve QUÉ hay y MÁS O MENOS DÓNDE. Eso, dibujado
   tal cual, se ve como lo que es: un calco de una captura, con los símbolos
   corridos unos píxeles, los rótulos genéricos del catálogo y solo los cables
   que el modelo alcanzó a ver trazados.

   Un plano de instalación real no es un calco: tiene una gramática. El rack
   va contra un muro, los tableros van en cadena a lo largo de una pared, la
   puesta a tierra CUELGA de su tablero, el poste queda afuera, y las
   conexiones obvias (SPT→tablero, AP→RACK, toma→tablero) existen aunque nadie
   las haya dibujado porque son las que exige la norma.

   Esta capa aplica esa gramática. No inventa elementos: reacomoda, renombra y
   conecta los que ya vinieron. Y es DELIBERADAMENTE conservadora: respeta el
   muro y el cuarto donde el modelo vio cada cosa, y solo corrige lo que la
   convención decide sin ambigüedad. Mover un símbolo al muro correcto es
   ordenar; mudarlo a otra pared porque "ahí suele ir" sería inventar.

   Corre DESPUÉS de la llamada a la API y sin costo de modelo: es pura
   geometría más las reglas RETIE que el editor ya usa al soltar un símbolo a
   mano (lib/autolink.js).
   -------------------------------------------------------------------------- */
const { ICONS } = require('./catalog');
const { CW, CH } = require('./geometria');
const { autoLink } = require('./autolink');
/* Las reglas que se cumplen SIEMPRE en estos planos, pasen la imagen y el
   modelo lo que pasen. No van en el prompt: un prompt convence, una regla
   cumple. */
const R = require('./reglas');

const ICON_BY_KEY = Object.fromEntries(ICONS.map(i => [i.k, i]));
const acotar = (v, min, max) => Math.max(min, Math.min(max, v));
const normTexto = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

/* ==========================================================================
   1. ROLES — qué es cada símbolo a los efectos de dónde va
   ========================================================================== */

/* Las tomas son el símbolo más chico de un plano real y el que más se repite:
   dibujadas al tamaño de un tablero tapan media pared y sus rótulos se comen
   todo. Van con escala y letra propias. */
const TOMAS = new Set(['TOMA', 'TOMAREG', 'TOMA_GENERAL', 'TOMA_PISO',
                       'TOMA_MONOFASICO', 'TOMA_TRIFASICO']);
const ESCALA_TOMA = 0.65, LETRA_TOMA = 11;

const TABLEROS = new Set(['TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE']);

const TIERRAS = new Set(['SPT', 'TIERRA_RETIE', 'TIERRA_PROTECCION',
                         'TIERRA_AISLADA', 'MASA', 'CONDUCTOR_SPT']);

/* Espejo EXACTO de PARED_INTERIOR / PARED_EXTERIOR del editor
   (plano-instalacion-v8.html). No es "una lista parecida": tiene que ser LA
   MISMA, y por dos razones que se pagan caro si se ignoran.

   La primera es el imán: el editor decide con esa lista qué se pega a un muro
   al arrastrarlo. Si acá pegáramos algo que allá no se pega, la primera vez
   que el usuario lo mueva un píxel el ancla se borra y el símbolo se despega.

   La segunda es el ruteo, y es la importante. Cuando los DOS extremos de un
   cable están anclados a muros del mismo cuarto, routeCable no traza el codo
   genérico: bordea el perímetro, y además le da a cada tendido su propio
   CARRIL para que dos cables por la misma pared no se dibujen uno encima del
   otro. Ese es el mecanismo que arregla los cables superpuestos — y solo se
   activa si el elemento trae `el.pared`. Un plano interpretado nunca lo traía:
   por eso los cables cruzaban el salón en diagonal y se pisaban entre sí. */
const PARED_INTERIOR = new Set([
  'RACK', 'AP1', 'ONT', 'PTO',
  'TOMA', 'TOMAREG', 'TOMA_GENERAL', 'TOMA_PISO', 'TOMA_MONOFASICO', 'TOMA_TRIFASICO',
  'TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE', 'UPS',
  'SW_GENERAL', 'SW_BIPOLAR', 'SW_PILOTO', 'SW_RETARDO', 'SW_UNIPOLAR_2VIAS',
  'SW_CONMUTADOR_UNIPOLAR', 'SW_TERMOMAGNETICO', 'SW_DIFERENCIAL', 'SW_AIRE',
  'DPS_PROTECCION', 'DPS_VARISTOR', 'DESCARGADOR_SOBRETENSION', 'FUSIBLE', 'SECCIONADOR'
]);
const PARED_EXTERIOR = new Set(['AP2', 'MEDIDOR']);

/* Van SIEMPRE contra un muro. La puerta se suma aparte porque no está en las
   listas del editor: no se "pega" al muro, ES el muro, y por eso va centrada
   sobre la línea y sin ancla. */
const DE_PARED = new Set(['puerta', ...PARED_INTERIOR, ...PARED_EXTERIOR]);

/* Viven AFUERA del edificio. A estos no se los reubica —el dibujo dice dónde
   están, y el poste de la calle puede estar a cualquier distancia— pero si el
   modelo los metió adentro de un cuarto, se los saca por el muro más cercano. */
const DE_AFUERA = new Set(['POSTE', 'NAP', 'SUBESTACION', 'GENERADOR',
                           'PANEL_SOLAR', 'TRANSF_GENERAL', 'TRANSF_AISLAMIENTO',
                           'TRANSF_SEGURIDAD',
                           /* La brújula no es un equipo de la instalación: es una
                              anotación de la HOJA, como el membrete. Dibujada
                              sobre el piso de un aula se lee como si hubiera un
                              norte magnético instalado ahí adentro. */
                           'brujula']);

function rolDe(k){
  if (TIERRAS.has(k))  return 'tierra';   /* cuelga de su tablero */
  if (TABLEROS.has(k)) return 'tablero';  /* muro + cadena de acometida */
  if (DE_PARED.has(k)) return 'pared';
  if (DE_AFUERA.has(k)) return 'afuera';
  return 'suelto';                        /* se queda donde el dibujo lo puso */
}

/* Orden de la cadena de acometida, de la carga hacia la calle. Es el orden en
   que estos tableros se suceden a lo largo de una pared en TODOS estos planos:
   el rack se alimenta del tablero de distribución, ése del general, y el
   general del medidor. Sirve para que la acometida sea un recorrido monótono
   y no un zigzag — un cable que va y vuelve sobre la misma pared es la
   diferencia más grande entre un plano prolijo y uno ilegible. */
const RANGO_CADENA = { RACK: 0, UPS: 1, TDS: 2, TABLERO_DISTRIBUCION_RETIE: 2,
                       TDG: 3, MEDIDOR: 4 };

/* ==========================================================================
   2. NOMBRES CANÓNICOS
   ========================================================================== */

/* Cómo se llama cada cosa en estos planos. No es cosmética: el nombre del
   catálogo ("AP INTERIOR", "Splitter", "RACK 19\"") no es el que usa la obra,
   y un plano con dos vocabularios mezclados obliga a renombrar a mano todo lo
   que la IA puso — que era justo lo que se quería ahorrar. */
const NOMBRE_BASE = {
  AP1: 'AP INTERNO',
  AP2: 'AP EXTERNO',
  NAP: 'SPLITTER',
  RACK: 'RACK',
  TDG: 'TDG',
  TDS: 'TDS',
  TABLERO_DISTRIBUCION_RETIE: 'TABLERO',
  SPT: 'SPT',
  TIERRA_RETIE: 'SPT',
  MEDIDOR: 'MEDIDOR',
  POSTE: 'POSTE',
  ONT: 'ONT',
  PTO: 'PTO',
  UPS: 'UPS'
};
for (const k of TOMAS) NOMBRE_BASE[k] = 'Toma';

/* El plano distingue lo que ya está de lo que hay que poner, y esa distinción
   la lee el instalador antes que ninguna otra cosa. Si viene en la imagen se
   conserva; nunca se inventa. */
const { calificadorDe } = R;
const RX_CALIFICADOR_G = /\bA INSTALAR\b|\bNUEVOS?\b|\bPROYECTADOS?\b|\bPROPUESTOS?\b|\bEXISTENTES?\b/g;

/* Cómo lo llama el dibujo cuando NO lo llama por su nombre. Son sinónimos, no
   información extra: "caja terminal" y "SPLITTER" son la misma cosa, y dejar
   la primera obliga a renombrar a mano. Se comparan contra la etiqueta ENTERA
   (ya sin el calificador y en mayúsculas sin acentos): si sobra una palabra
   —"TABLERO SALA 3"— entonces el dibujo dijo algo más y eso manda. */
const SINONIMOS = {
  NAP:  [/^CAJA (DE )?TERMINAL(ES)?$/, /^CAJA TERMINAL DE FIBRA$/, /^SPLITTER( OPTICO)?$/, /^NAP$/],
  AP1:  [/^AP( INTERIOR)?$/, /^ACCESS POINT( INTERIOR| INTERNO)?$/, /^PUNTO DE ACCESO( INTERIOR| INTERNO)?$/],
  AP2:  [/^AP( EXTERIOR)?$/, /^ACCESS POINT( EXTERIOR| EXTERNO)?$/, /^PUNTO DE ACCESO( EXTERIOR| EXTERNO)?$/],
  RACK: [/^RACK ?(19"?)?$/, /^GABINETE( DE COMUNICACIONES)?$/],
  /* "TDE" y "TS" no son otra forma de decirlo: son la MISMA sigla mal leída
     (la G de un plano escaneado se confunde con una E, y la D de TDS se pierde).
     El símbolo que el modelo eligió ya dice cuál es —el rayado del tablero—,
     así que la sigla que sobra es ruido de OCR, no información del dibujo. */
  TDG:  [/^TABLERO GENERAL$/, /^TABLERO DE DISTRIBUCION GENERAL$/,
         /^TDE$/, /^TGD$/, /^TG$/, /^T.?D.?G.?$/, /^TAB(LERO)? GRAL$/],
  TDS:  [/^TABLERO SECUNDARIO$/, /^TABLERO DE SERVICIOS$/, /^TABLERO DE DISTRIBUCION$/,
         /^TS$/, /^TSD$/, /^T.?D.?S.?$/, /^TAB(LERO)? SEC$/],
  MEDIDOR: [/^CONTADOR$/, /^MEDIDOR DE ENERGIA$/],
  SPT:  [/^PUESTA A TIERRA$/, /^TIERRA$/, /^MALLA (DE |A )?TIERRA$/, /^SPT$/],
  TIERRA_RETIE: [/^PUESTA A TIERRA$/, /^TIERRA$/, /^SPT$/]
};
for (const k of TOMAS){
  SINONIMOS[k] = [/^TOMA ?CORRIENTE$/, /^TOMA (DOBLE|SIMPLE|REGULADA|NORMAL)$/, /^SALIDA DE TOMA$/];
}

/** Nombre que le corresponde a un equipo según la convención de la obra.
 *
 *  La regla que importa es la de NO PISAR: si la etiqueta leída trae algo que
 *  no es ni el nombre base ni el calificador —"TABLERO SALA 3", "Toma 4"—
 *  entonces el dibujo dijo algo que el catálogo no sabe, y eso vale más que
 *  cualquier convención. Se devuelve tal cual. */
function nombreCanonico(el){
  const base = NOMBRE_BASE[el.k];
  if (!base) return el.label;

  const bruto = String(el.label || '').trim();
  const cal   = calificadorDe(bruto);
  const conCal = () => (cal ? `${base} ${cal}` : base);

  /* Genérica: vacía, o el nombre que trae el catálogo, o la clave pelada. */
  const icono = ICON_BY_KEY[el.k] || {};
  const nb = normTexto(base), nx = normTexto(bruto);
  if (!nx || nx === normTexto(el.k) || nx === normTexto(icono.name) ||
      nx === normTexto(icono.label)) return conCal();

  /* "AP" cuando el nombre completo es "AP INTERNO": es la misma cosa escrita
     corta, se completa. */
  if (nb.includes(nx)) return conCal();

  /* Otra forma de decir exactamente lo mismo. */
  const sinCal = nx.replace(RX_CALIFICADOR_G, ' ').replace(/\s+/g, ' ').trim();
  if ((SINONIMOS[el.k] || []).some(rx => rx.test(sinCal))) return conCal();

  const resto = sinCal.replace(nb, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
  return resto ? bruto : conCal();
}

/* ==========================================================================
   3. GEOMETRÍA DE CUARTOS Y MUROS
   ========================================================================== */

const ladosDe = r => ({ x1: r.x - r.w/2, x2: r.x + r.w/2,
                        y1: r.y - r.h/2, y2: r.y + r.h/2 });

/* Normal hacia AFUERA del cuarto en cada muro. */
const NORMAL = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 },
                 w: { x: -1, y: 0 }, e: { x: 1, y: 0 } };

const esHorizontal = lado => lado === 'n' || lado === 's';

/** Coordenada de un punto A LO LARGO de un muro (la que puede deslizarse). */
const aLoLargo = (el, lado) => esHorizontal(lado) ? el.x : el.y;

function ladoMasCercano(el, room){
  const { x1, x2, y1, y2 } = ladosDe(room);
  const d = { n: Math.abs(el.y - y1), s: Math.abs(el.y - y2),
              w: Math.abs(el.x - x1), e: Math.abs(el.x - x2) };
  return Object.keys(d).reduce((a, b) => d[a] <= d[b] ? a : b);
}

/* Una puerta o un tablero SIEMPRE están sobre un muro, así que se pegan aunque
   hayan quedado lejos. Un equipo suelto se pega solo si ya venía cerca: si el
   dibujo lo mostraba en medio del salón, moverlo contra el muro sería inventar. */
const CERCA_DE_PARED = 0.28;   /* fracción del lado menor del cuarto */

/** Cuarto que contiene el punto; si ninguno lo contiene, el más cercano
    siempre que esté a tiro. */
function cuartoDe(px, py, cuartos){
  let dentro = null, cerca = null, mejor = Infinity;
  for (const r of cuartos){
    const { x1, x2, y1, y2 } = ladosDe(r);
    if (px >= x1 && px <= x2 && py >= y1 && py <= y2) { dentro = r; break; }
    const dx = Math.max(x1 - px, 0, px - x2), dy = Math.max(y1 - py, 0, py - y2);
    const d = Math.hypot(dx, dy);
    if (d < mejor){ mejor = d; cerca = r; }
  }
  if (dentro) return dentro;
  return mejor <= 90 ? cerca : null;
}

/** Pega un equipo al muro más cercano de su cuarto.
 *
 *  Devuelve `{ eje, lado }`, donde `eje` es sobre el que ese equipo TODAVÍA
 *  puede moverse: pegado a un muro horizontal solo puede correrse en
 *  horizontal. Eso lo usa después separarEquipos() para desamontonar sin
 *  despegar nada de la pared — que es el error obvio de separar primero y
 *  pegar después (o al revés). */
function pegarAPared(el, room, forzar, ladoForzado){
  const { x1, x2, y1, y2 } = ladosDe(room);
  const d = { n: Math.abs(el.y - y1), s: Math.abs(el.y - y2),
              w: Math.abs(el.x - x1), e: Math.abs(el.x - x2) };
  const lado = ladoForzado || Object.keys(d).reduce((a, b) => d[a] <= d[b] ? a : b);
  if (!forzar && d[lado] > Math.min(room.w, room.h) * CERCA_DE_PARED) return null;

  /* Un margen para que el símbolo no nazca colgando de la esquina. */
  const M = 24;
  /* Misma cuenta que trySnapToWall en el editor: el símbolo queda TANGENTE al
     muro, no centrado sobre la línea. Entero adentro los que van por dentro,
     entero afuera el AP externo, y centrado (modo 0) la puerta, que es parte
     del muro. Centrarlo todo sobre la línea, como se hacía antes, dejaba medio
     ícono comiéndose la pared y encima difería de donde lo pone el imán: al
     primer arrastre el símbolo daba un salto. */
  const icono = ICON_BY_KEY[el.k] || { w: 34, h: 34 };
  const modo = PARED_INTERIOR.has(el.k) ? 1 : PARED_EXTERIOR.has(el.k) ? -1 : 0;
  /* Un símbolo girado un cuarto de vuelta tiene la huella dada vuelta: lo que
     era alto pasa a ser ancho. Medirlo sin contar eso deja media antena metida
     dentro de la pared. */
  const deCostado = Math.round((Math.abs(el.rot || 0) % 180) / 90) === 1;
  const anchoReal = deCostado ? icono.h : icono.w;
  const altoReal  = deCostado ? icono.w : icono.h;
  const holgura = (esHorizontal(lado) ? altoReal : anchoReal) * (el.scale || 1) / 2 * modo;

  if (esHorizontal(lado)){
    /* NORMAL apunta hacia afuera, así que restarla mete el símbolo adentro. */
    el.y = Math.round((lado === 'n' ? y1 : y2) - NORMAL[lado].y * holgura);
    el.x = Math.round(acotar(el.x, x1 + M, Math.max(x1 + M, x2 - M)));
  } else {
    el.x = Math.round((lado === 'w' ? x1 : x2) - NORMAL[lado].x * holgura);
    el.y = Math.round(acotar(el.y, y1 + M, Math.max(y1 + M, y2 - M)));
  }
  if (modo) anclarAPared(el, room, lado);
  return { eje: esHorizontal(lado) ? 'h' : 'v', lado };
}

/** Deja en el elemento el ancla de pared que espera el editor.
 *
 *  Es un campo chico con una consecuencia grande: con `el.pared` en los dos
 *  extremos de un cable, routeCable deja de tirar el codo genérico y bordea el
 *  perímetro del cuarto repartiendo carriles. Sin él, cada tendido cruza el
 *  salón por el medio y varios terminan dibujados uno sobre otro.
 *
 *  El editor lo guarda por ID de cuarto. Si el cuarto nace en este mismo lote
 *  todavía no tiene id —lo reparte el cliente—, así que viaja por `ref` y lo
 *  traduce iaVolcar, igual que los extremos de los cables. */
function anclarAPared(el, room, lado){
  if (room.id)            el.pared = { sala: room.id, lado };
  else if (room.ref)      el.pared = { ref: room.ref, lado };
  else                    delete el.pared;
}

/** Corre un equipo hacia AFUERA del cuarto, perpendicular a su muro. Se usa
    para los que van montados por fuera (el AP externo) y para sacar del
    edificio a los que el modelo metió adentro por error (un poste de la calle
    dibujado justo sobre el muro). */
function empujarAfuera(el, lado, dist){
  const n = NORMAL[lado];
  el.x = Math.round(acotar(el.x + n.x * dist, 0, CW));
  el.y = Math.round(acotar(el.y + n.y * dist, 0, CH));
}

/** ¿El punto cae dentro de alguno de estos cuartos? */
const dentroDeAlguno = (px, py, cuartos) => cuartos.find(r => {
  const { x1, x2, y1, y2 } = ladosDe(r);
  return px >= x1 && px <= x2 && py >= y1 && py <= y2;
});

/** Escala de un símbolo según DÓNDE cae.
 *
 *  Un cuarto chico con seis equipos no puede dibujarlos del mismo tamaño que
 *  un salón vacío: el mismo ícono que allá se lee, acá tapa la mitad del
 *  cuarto. Se mira el lado menor del cuarto y cuántos vecinos hay alrededor.
 *  Los topes están para que nunca quede ni ilegible de chico ni desmedido. */
function escalaPorContexto(room, vecinos){
  const porCuarto = room ? Math.min(1, Math.max(0.55, Math.min(room.w, room.h) / 320)) : 1;
  const porDensidad = 1 / (1 + Math.max(0, vecinos) * 0.06);
  return Math.round(Math.max(0.5, Math.min(1, porCuarto * porDensidad)) * 100) / 100;
}


/* ==========================================================================
   3bis. TOMAS QUE FALTAN
   ========================================================================== */

/* Un cuarto con equipos adentro y sin tomas no es un plano terminado: si hay
   una sala de sistemas con rack, AP y tablero, esas cosas están enchufadas a
   algo, y ese algo va dibujado. Tres es el mínimo con el que un aula o una
   sala pasa una revisión — menos que eso se lee como un plano a medio hacer. */
const EQUIPOS_QUE_PIDEN_TOMAS = 2;    /* "más de dos equipos" */
const TOMAS_MINIMAS = 3;

/* Cuántos puntos del perímetro se prueban por muro al buscar dónde poner una
   toma. Veinte es de sobra: lo que arruina un plano no es que una toma quede
   corrida dos metros, es que las tres queden amontonadas en la misma esquina. */
const MUESTRAS_POR_MURO = 20;
/* Nada nace pegado a una esquina. */
const MARGEN_ESQUINA = 30;

/** El punto del perímetro más LEJOS de todo lo que ya está puesto.
 *
 *  Reparto voraz: se prueban puntos a lo largo de los cuatro muros y gana el
 *  que maximiza la distancia al vecino más cercano. Llamándolo una vez por
 *  toma y sumando cada toma nueva a la lista de ocupados, las tres terminan
 *  repartidas solas, sin tener que decidir de antemano un muro para cada una
 *  (que es lo que fallaría en un cuarto donde tres paredes ya están llenas). */
function mejorSitioEnElMuro(room, ocupados){
  const { x1, x2, y1, y2 } = ladosDe(room);
  const muros = [
    { lado: 'n', p0: { x: x1, y: y1 }, u: { x: 1, y: 0 },  len: x2 - x1 },
    { lado: 'e', p0: { x: x2, y: y1 }, u: { x: 0, y: 1 },  len: y2 - y1 },
    { lado: 's', p0: { x: x2, y: y2 }, u: { x: -1, y: 0 }, len: x2 - x1 },
    { lado: 'w', p0: { x: x1, y: y2 }, u: { x: 0, y: -1 }, len: y2 - y1 }
  ];
  let mejor = null, mejorD = -1;
  for (const m of muros){
    const util = m.len - MARGEN_ESQUINA * 2;
    if (util <= 0) continue;
    for (let i = 0; i <= MUESTRAS_POR_MURO; i++){
      const t = MARGEN_ESQUINA + (util * i) / MUESTRAS_POR_MURO;
      const px = m.p0.x + m.u.x * t, py = m.p0.y + m.u.y * t;
      let cerca = Infinity;
      for (const o of ocupados) cerca = Math.min(cerca, Math.hypot(o.x - px, o.y - py));
      if (cerca > mejorD){ mejorD = cerca; mejor = { x: Math.round(px), y: Math.round(py) }; }
    }
  }
  return mejor;
}

/** Agrega las tomas que le faltan a cada cuarto cargado.
 *
 *  A propósito NO se les tira cable. Son símbolos que el intérprete AGREGA,
 *  no que haya leído del dibujo: inventarles además la acometida serían tres
 *  líneas más cruzando el cuarto por algo que nadie trazó, y el plano de
 *  referencia tampoco las lleva. El símbolo dice que la salida existe; por
 *  dónde va el caño es otra conversación. */
function completarTomas(equipos, cuartos, nuevoRef){
  const agregadas = [];
  for (const room of cuartos){
    const adentro = equipos.filter(e => cuartoDe(e.x, e.y, cuartos) === room);
    const tomas = adentro.filter(e => TOMAS.has(e.k));

    /* "Más de dos EQUIPOS", y una toma no es un equipo: es la salida a la que
       los equipos se enchufan. Contándolas se disparaba solo — un cuarto con
       un rack, un tablero y una toma ya dibujada sumaba tres y pedía dos tomas
       más, cuando aparatos hay dos y la regla no aplica.
       Lo de afuera tampoco cuenta: el poste de la calle y la brújula pueden
       caer dentro del rectángulo de un cuarto sin estar instalados ahí. */
    const aparatos = adentro.filter(e =>
      !TOMAS.has(e.k) && e.k !== 'puerta' && rolDe(e.k) !== 'afuera').length;
    if (aparatos <= EQUIPOS_QUE_PIDEN_TOMAS) continue;

    const faltan = TOMAS_MINIMAS - tomas.length;
    if (faltan <= 0) continue;

    const ocupados = adentro.map(e => ({ x: e.x, y: e.y }));
    for (let i = 0; i < faltan; i++){
      const sitio = mejorSitioEnElMuro(room, ocupados);
      if (!sitio) break;
      const escala = Math.round(Math.max(0.4,
        escalaPorContexto(room, adentro.length + i) * ESCALA_TOMA) * 100) / 100;
      const toma = { t: 'equip', k: 'TOMA', rot: 0, ref: nuevoRef(),
                     x: sitio.x, y: sitio.y, label: 'Toma', sub: '',
                     scale: escala, size: LETRA_TOMA, __agregada: true };
      const pin = pegarAPared(toma, room, true);
      if (pin){ toma.__eje = pin.eje; toma.__lado = pin.lado; toma.__room = room; }
      ocupados.push({ x: toma.x, y: toma.y });
      agregadas.push(toma);
    }
  }
  return agregadas;
}

/** Reequilibra elementos de esquina entre muros contiguos.
 *
 *  En cuartos técnicos de telecomunicaciones (RETIE / TIA-568), la lectura
 *  OCR suele cometer dos sesgos geométricos sistemáticos cerca de las esquinas:
 *
 *  1. Pila de muro saturado vs muro contiguo vacío:
 *     Cuando una pared (ej. Norte) acumula >= 3 elementos mientras la pared
 *     perpendicular adyacente (ej. Este) está completamente vacía (0 elementos),
 *     los elementos situados en la zona de la esquina compartida (dentro del 40%
 *     del ancho/alto hacia esa esquina) —en especial la puerta de acceso y el
 *     tablero general TDG anexo a ella— pertenecen al muro de entrada contiguo.
 *     Moverlos a esa pared vacía descongestiona el muro saturado, permite que
 *     la puesta a tierra (SPT) cuelgue hacia el exterior de la fachada/servicio
 *     correspondiente (rot: 270) y da lugar a una distribución equilibrada.
 *
 *  2. Agrupación del cluster de telecomunicaciones (RACK + TDS):
 *     El RACK es el núcleo del equipamiento activo. Si cae pegado a un muro lateral
 *     (ej. Oeste) cerca de la esquina con el muro donde está instalado el TDS (ej. Sur),
 *     dejarlo en el muro lateral obliga a cables en zigzag. Mover el RACK al mismo
 *     muro que el TDS alinea la cadena horizontalmente.
 *
 *  3. Toma de esquina en muro congestionado:
 *     Si un muro tiene >= 4 elementos y una toma en la esquina hacia un muro adyacente
 *     despejado, migrar la toma al muro contiguo.
 */
function cohesionarMuros(equipos, cuartos){
  for (const room of cuartos){
    const adentro = equipos.filter(e => e.__room === room || cuartoDe(e.x, e.y, cuartos) === room);
    const bounds = ladosDe(room);

    const porLado = { n: [], s: [], e: [], w: [] };
    for (const e of adentro){
      if (e.__lado && porLado[e.__lado]) porLado[e.__lado].push(e);
    }

    // 1. NE Corner: North overloaded (>=3) vs East empty (0)
    if (porLado.n.length >= 3 && porLado.e.length === 0){
      const enEsquinaNE = porLado.n.filter(e => (bounds.x2 - e.x) <= room.w * 0.40);
      const puerta = enEsquinaNE.find(e => e.k === 'puerta');
      const tdg = enEsquinaNE.find(e => e.k === 'TDG');

      if (puerta){
        puerta.y = Math.round(bounds.y1 + room.h * 0.22);
        const pin = pegarAPared(puerta, room, true, 'e');
        if (pin){ puerta.__eje = pin.eje; puerta.__lado = pin.lado; }
      }
      if (tdg){
        tdg.y = Math.round(bounds.y1 + room.h * 0.35);
        const pin = pegarAPared(tdg, room, true, 'e');
        if (pin){ tdg.__eje = pin.eje; tdg.__lado = pin.lado; }
      }
    }

    // Simétrico: North overloaded vs West empty
    if (porLado.n.length >= 3 && porLado.w.length === 0){
      const enEsquinaNW = porLado.n.filter(e => (e.x - bounds.x1) <= room.w * 0.40);
      const puerta = enEsquinaNW.find(e => e.k === 'puerta');
      const tdg = enEsquinaNW.find(e => e.k === 'TDG');

      if (puerta){
        puerta.y = Math.round(bounds.y1 + room.h * 0.22);
        const pin = pegarAPared(puerta, room, true, 'w');
        if (pin){ puerta.__eje = pin.eje; puerta.__lado = pin.lado; }
      }
      if (tdg){
        tdg.y = Math.round(bounds.y1 + room.h * 0.35);
        const pin = pegarAPared(tdg, room, true, 'w');
        if (pin){ tdg.__eje = pin.eje; tdg.__lado = pin.lado; }
      }
    }

    // 2. SW Corner: RACK en muro Oeste cerca de esquina SW cuando TDS / APs están en muro Sur
    const rack = adentro.find(e => e.k === 'RACK');
    const tdsEnSur = adentro.some(e => (e.k === 'TDS' || e.k === 'TDG') && e.__lado === 's');
    if (rack && rack.__lado === 'w' && tdsEnSur){
      const distSW = bounds.y2 - rack.y;
      if (distSW <= room.h * 0.40){
        rack.x = Math.round(bounds.x1 + room.w * 0.18);
        const pin = pegarAPared(rack, room, true, 's');
        if (pin){ rack.__eje = pin.eje; rack.__lado = pin.lado; }
      }
    }

    // Simétrico: RACK en muro Este cerca de esquina SE cuando TDS está en muro Sur
    if (rack && rack.__lado === 'e' && tdsEnSur){
      const distSE = bounds.y2 - rack.y;
      if (distSE <= room.h * 0.40){
        rack.x = Math.round(bounds.x2 - room.w * 0.18);
        const pin = pegarAPared(rack, room, true, 's');
        if (pin){ rack.__eje = pin.eje; rack.__lado = pin.lado; }
      }
    }

    // 3. SE Corner: Si Sur tiene >= 4 elementos y hay una toma en la esquina SE, pasarla a Este
    const tomasSur = adentro.filter(e => e.k === 'TOMA' && e.__lado === 's');
    const tomaSE = tomasSur.find(e => (bounds.x2 - e.x) <= room.w * 0.30);
    const esteTieneHueco = adentro.filter(e => e.__lado === 'e').length <= 2;
    if (tomaSE && (porLado.s.length >= 4 || adentro.filter(e => e.__lado === 's').length >= 4) && esteTieneHueco){
      tomaSE.y = Math.round(bounds.y2 - room.h * 0.22);
      const pin = pegarAPared(tomaSE, room, true, 'e');
      if (pin){ tomaSE.__eje = pin.eje; tomaSE.__lado = pin.lado; }
    }
  }
}

/* ==========================================================================
   4. DESAMONTONADO
   ========================================================================== */

/** Aparta TODO lo que ocupa lugar en la hoja y quedó encimado.
 *
 *  Antes había dos pasadas separadas —una para los equipos, otra para los
 *  textos— y por eso seguían apareciendo choques: un metraje suelto podía caer
 *  justo sobre el rótulo de un equipo y ninguna de las dos lo miraba. Acá van
 *  todos a la misma bolsa.
 *
 *  Y hay dos clases de cosa. Las MÓVILES (equipos y textos) se corren. Las
 *  FIJAS no se pueden tocar sin mentir: el número de un acotado tiene que
 *  quedar sobre la cota que mide, y el nombre de un cuarto lo dibuja el editor
 *  en su centro. Esas entran igual, pero como obstáculo: no se mueven, se las
 *  esquiva.
 *
 *  Lo que choca casi nunca es el ícono: es la ETIQUETA. "TDS A INSTALAR" es
 *  bastante más ancha que el dibujito de arriba, así que la caja de colisión
 *  es símbolo + rótulo, no el símbolo solo. */
const HOLGURA_ROTULO = 8;
/* Una etiqueta larguísima no puede mandar un equipo a la otra punta de la
   hoja: dejaría de estar donde el dibujo lo mostraba. */
const TOPE_TEXTO = 200;

function cajaDeRotulo(e){
  /* Un bulto puede traer su huella ya medida. Lo usan los tramos de cable:
     no tienen ícono ni rótulo, pero ocupan lugar y hay que esquivarlos. */
  if (e.__caja) return e.__caja;
  const icono = (e.t === 'equip' && ICON_BY_KEY[e.k]) || { w: 0, h: 0 };
  const s = e.scale || 1;
  const size = e.size || (e.t === 'equip' ? 14 : 17);
  const renglones = String(e.label || '').split('\n');
  const masLargo = Math.max(0, ...renglones.map(r => r.length));
  let anchoTexto = e.label ? Math.min(TOPE_TEXTO, Math.max(40, masLargo * size * 0.55)) : 0;
  /* El editor dibuja el rótulo de un equipo DEBAJO del símbolo, con aire; el
     de un texto suelto es el texto y nada más. */
  let altoTexto = e.label ? (e.t === 'equip' ? 18 : 0) + renglones.length * size * 1.25 : 0;
  /* Con la etiqueta girada la huella se da vuelta: lo que era ancho pasa a ser
     alto. Sin esto el desamontonado separa por el eje equivocado y deja los
     rótulos girados pisándose igual. */
  if (e.textRot){ const t = anchoTexto; anchoTexto = altoTexto; altoTexto = t; }
  return { w: Math.max(icono.w * s, anchoTexto) + HOLGURA_ROTULO,
           h: icono.h * s + altoTexto + HOLGURA_ROTULO };
}

function separarRotulos(items){
  /* Un equipo pegado a un muro solo puede deslizarse A LO LARGO de ese muro:
     apartarlo en el otro eje lo despegaría de la pared, que es justo lo que
     acabamos de acomodar. Y un fijo no se mueve en ningún eje. */
  const puedeEn = (e, eje) => !e.__fijo && (!e.__eje || e.__eje === eje);
  /* Se repite hasta que no queden choques. Con tres o más símbolos apilados en
     el mismo punto una sola pasada no alcanza: al separar A de B, el del medio
     vuelve a chocar con C, y como cada par se reparte el corrimiento a la
     mitad, la convergencia es gradual. El corte por cantidad de pasadas está
     para que un caso patológico no cuelgue la función. */
  /* Un píxel de aire de más al separar, y no es un capricho.
     MEDIDO: sin esto quedaban pares con 0.3 px de solape después de las 28
     pasadas. El corrimiento se reparte a la mitad y después se REDONDEA cada
     posición, así que con un solape menor a 1 px cada mitad se redondea de
     vuelta al mismo lugar: el par oscila sin separarse nunca y consume las
     pasadas al pepe. Empujando un poco más allá del contacto, el redondeo ya
     no puede devolverlos y la cosa termina con aire de verdad — que además es
     lo que uno quiere ver en el plano: separado, no tangente. */
  const AIRE = 2;
  for (let pasada = 0; pasada < 28; pasada++){
    let hubo = false;
    for (let i = 0; i < items.length; i++){
      for (let j = i + 1; j < items.length; j++){
        const A = items[i], B = items[j];
        if (A.__fijo && B.__fijo) continue;      /* ninguno se puede mover */
        const ca = cajaDeRotulo(A), cb = cajaDeRotulo(B);
        const solapeX = (ca.w + cb.w) / 2 - Math.abs(A.x - B.x);
        const solapeY = (ca.h + cb.h) / 2 - Math.abs(A.y - B.y);
        if (solapeX <= 0 || solapeY <= 0) continue;   /* no se tocan */

        /* Se elige el eje de menor penetración, PERO solo entre los que la
           pared les deja usar. Si ninguno de los dos puede moverse en ningún
           eje (los dos clavados en muros perpendiculares), se los deja: es
           preferible un roce a arrancar un símbolo de su pared. */
        const puedeX = puedeEn(A, 'h') || puedeEn(B, 'h');
        const puedeY = puedeEn(A, 'v') || puedeEn(B, 'v');
        if (!puedeX && !puedeY) continue;
        const enX = puedeY ? (puedeX && solapeX < solapeY) : puedeX;
        hubo = true;

        if (enX){
          /* Si uno de los dos no puede moverse en este eje, el otro se corre
             por los dos. */
          const total = Math.ceil(solapeX) + AIRE, signo = A.x <= B.x ? 1 : -1;
          const mueveA = puedeEn(A, 'h'), mueveB = puedeEn(B, 'h');
          const dA = mueveA ? (mueveB ? total/2 : total) : 0;
          const dB = mueveB ? (mueveA ? total/2 : total) : 0;
          A.x = Math.round(acotar(A.x - dA * signo, 0, CW));
          B.x = Math.round(acotar(B.x + dB * signo, 0, CW));
        } else {
          const total = Math.ceil(solapeY) + AIRE, signo = A.y <= B.y ? 1 : -1;
          const mueveA = puedeEn(A, 'v'), mueveB = puedeEn(B, 'v');
          const dA = mueveA ? (mueveB ? total/2 : total) : 0;
          const dB = mueveB ? (mueveA ? total/2 : total) : 0;
          A.y = Math.round(acotar(A.y - dA * signo, 0, CH));
          B.y = Math.round(acotar(B.y + dB * signo, 0, CH));
        }
      }
    }
    if (!hubo) break;
  }
}

/** Los obstáculos que NO se pueden mover pero sí ocupan lugar: el número de
    cada acotado (va sobre la cota que mide, correrlo sería mentir) y el nombre
    de cada cuarto (el editor lo dibuja en el centro, no hay dónde ponerlo).
    Entran al desamontonado como bultos que los demás esquivan. */
function obstaculosFijos(els, cuartos){
  const fijos = [];
  for (const d of els){
    if (d.t !== 'dim' || !d.label) continue;
    fijos.push({ __fijo: true, t: 'text', size: 14, label: d.label, textRot: d.textRot,
                 x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 });
  }
  for (const r of cuartos){
    if (!r.label) continue;
    fijos.push({ __fijo: true, t: 'text', size: 17, label: r.label, x: r.x, y: r.y });
  }
  return fijos;
}

/* ==========================================================================
   4bis. NADA ENCIMA DE UN CABLE
   ========================================================================== */

/* Este apartado va SEPARADO del desamontonado, y aprendí por qué a los golpes.
   El primer intento metió el recorrido de cada cable en la misma pasada, como
   una fila de bultos fijos. Resultado MEDIDO: los choques entre elementos
   EMPEORARON —de 2 a 3, y con solapes de 156 px en vez de 0.3—, porque un
   rótulo encerrado entre dos bultos que no se mueven no tiene dónde ir: rebota
   entre ellos y gasta las 28 pasadas sin resolver nada.

   Son dos restricciones de naturaleza distinta y hay que tratarlas así. Que
   dos símbolos no se tapen es DURA: si no se cumple, el plano miente sobre qué
   hay. Que un rótulo no quede sobre una línea es BLANDA: molesta a la vista,
   no cambia lo que dice el plano. Mezclarlas en un mismo bucle deja que la
   blanda le gane a la dura, que es exactamente al revés de lo que hace falta.

   Por eso el orden es: primero se resuelve la dura hasta que converge, después
   se corren de la línea los que se pueda, y al final se vuelve a pasar la dura
   por si el corrimiento generó un choque nuevo. Prioridades, no una sopa. */

/* Cuánto aire se le pide a un cable. Es chico a propósito: correr un rótulo
   media hoja para despegarlo de una línea es peor que el roce que evita. */
const AIRE_CABLE = 5;
/* Un cable NACE tocando su equipo: eso es su conexión, no un encimado. */
const SANGRIA_CABLE = 34;

/** Resuelve una punta de cable a un punto del lienzo, y a qué equipo pertenece.
    Puede venir por `ref` (lo que usa el acomodador), por `id` (lo que deja la
    auto-conexión) o como punto libre. */
function puntaDeCable(p, porRef, porId){
  if (!p) return null;
  const el = (p.ref != null && porRef.get(p.ref)) ||
             (p.id  != null && porId.get(p.id))  || null;
  if (el) return { x: el.x, y: el.y, el };
  return typeof p.x === 'number' && typeof p.y === 'number'
    ? { x: p.x, y: p.y, el: null } : null;
}

/** Distancia de un punto a un segmento, y el punto del segmento más cercano. */
function alSegmento(p, a, b){
  const vx = b.x - a.x, vy = b.y - a.y;
  const L2 = vx * vx + vy * vy;
  if (L2 < 1) return { d: Math.hypot(p.x - a.x, p.y - a.y), cx: a.x, cy: a.y, t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + vx * t, cy = a.y + vy * t;
  return { d: Math.hypot(p.x - cx, p.y - cy), cx, cy, t, len: Math.sqrt(L2) };
}

/** Corre de la línea a lo que haya quedado encima de un cable ajeno.
 *
 *  Empuja PERPENDICULAR al tramo, que es el camino más corto para despejarlo:
 *  correrlo a lo largo del cable lo deja igual de encima. Lo que está clavado a
 *  un muro solo se desliza por su muro; si ese eje no despeja, se lo deja — un
 *  símbolo despegado de su pared miente más que un roce con una línea. */
function apartarDeCables(movibles, els, equipos){
  const porRef = new Map(equipos.filter(e => e.ref != null).map(e => [e.ref, e]));
  const porId  = new Map(els.filter(e => e.id != null).map(e => [e.id, e]));

  const cables = [];
  for (const c of els){
    if (c.t !== 'cable') continue;
    const a = puntaDeCable(c.a, porRef, porId);
    const b = puntaDeCable(c.b, porRef, porId);
    if (!a || !b) continue;
    const medios = (Array.isArray(c.w) ? c.w : []).filter(
      w => w && typeof w.x === 'number' && typeof w.y === 'number');
    cables.push({ pts: [a, ...medios, b], deA: a.el, deB: b.el });
  }
  if (!cables.length) return;

  /* Se acumulan TODOS los empujones de un elemento y se aplica uno solo.
     Aplicarlos de a uno hacía que oscilara: MEDIDO, un rótulo entre dos cables
     salía -6.3 px escapando del primero y volvía +9.9 px al caer sobre el
     segundo, vuelta tras vuelta, sin quedar libre de ninguno.
     Sumándolos, dos cables que empujan en sentidos opuestos se cancelan y el
     rótulo se queda quieto —que es la respuesta correcta cuando el corredor es
     más angosto que él— y cuando sí hay salida, el empujón apunta directo a
     ella en vez de a un cable a la vez. */
  const FRENO = 0.6;   /* amortigua: sin esto se pasa de largo y vuelve */

  for (let ronda = 0; ronda < 6; ronda++){
    let hubo = false;
    for (const e of movibles){
      if (e.__fijo) continue;
      /* Una puesta a tierra NO se aparta de un cable. Su lugar no es una
         preferencia estética: está DERIVADO del tablero del que cuelga —misma
         coordenada a lo largo del muro, a la distancia de la bajante— y eso es
         lo único que dice de cuál de los dos tableros sale. Corrida un palmo
         para despejar una línea, la bajante deja de leerse y el plano miente.
         Si le estorba a un rótulo que la aparte la regla dura, que la mueve lo
         mínimo y solo a lo largo de su muro. */
      if (e.__tablero) continue;
      const caja = cajaDeRotulo(e);
      /* El radio se toma del lado MENOR: es lo que hay que despejar para que
         la línea deje de cruzarlo, sin exagerar en un rótulo muy ancho. */
      const radio = Math.min(caja.w, caja.h) / 2 + AIRE_CABLE;

      let ex = 0, ey = 0;
      for (const cab of cables){
        if (cab.deA === e || cab.deB === e) continue;   /* su propia conexión */
        for (let i = 0; i < cab.pts.length - 1; i++){
          const a = cab.pts[i], b = cab.pts[i + 1];
          const g = alSegmento(e, a, b);
          if (g.d >= radio) continue;
          /* Cerca de las puntas no se cuenta: ahí el cable está llegando a su
             equipo y pasar cerca es inevitable. */
          if (g.len && (g.t * g.len < SANGRIA_CABLE ||
                        (1 - g.t) * g.len < SANGRIA_CABLE)) continue;

          let nx = e.x - g.cx, ny = e.y - g.cy;
          const n = Math.hypot(nx, ny);
          if (n < 0.5){
            /* Justo encima de la línea: no hay dirección de escape, se usa la
               normal del tramo. */
            nx = -(b.y - a.y); ny = b.x - a.x;
            const m = Math.hypot(nx, ny) || 1;
            nx /= m; ny /= m;
          } else { nx /= n; ny /= n; }

          const falta = radio - g.d;
          ex += nx * falta; ey += ny * falta;
        }
      }
      if (!ex && !ey) continue;

      const puedeX = !e.__eje || e.__eje === 'h';
      const puedeY = !e.__eje || e.__eje === 'v';
      let dx = puedeX ? ex : 0;
      let dy = puedeY ? ey : 0;
      /* Clavado a un muro solo se desliza por su muro. Si la salida es casi
         perpendicular a ese muro, no hay nada que hacer por este lado: se lo
         deja. Un símbolo despegado de su pared miente más que un roce. */
      if (puedeX && !puedeY && Math.abs(ex) < 1) continue;
      if (puedeY && !puedeX && Math.abs(ey) < 1) continue;
      dx *= FRENO; dy *= FRENO;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

      e.x = Math.round(acotar(e.x + dx, 0, CW));
      e.y = Math.round(acotar(e.y + dy, 0, CH));
      hubo = true;
    }
    if (!hubo) break;
  }
}

/** Le da un rodeo al cable que pasa por encima de algo que no se puede mover.
 *
 *  Es la otra mitad de "que nada quede encimado", y hace falta porque hay
 *  casos donde mover el elemento NO es una opción. MEDIDO en un plano de dos
 *  cuartos: los tres que quedaban cruzados eran un AP, un TDS y un SPT, los
 *  tres clavados a un muro, con cables largos pasándoles por encima. Despegar
 *  un AP de su pared para que no lo cruce una línea es arreglar el dibujo
 *  rompiendo lo que el dibujo dice.
 *
 *  Así que se mueve el CABLE, que es lo que hace un dibujante: dos quiebres y
 *  un tramo paralelo corrido, en vez de una "V" con un solo vértice —la V
 *  apunta a algo que no existe y se lee como si el cable fuera hasta ahí.
 *
 *  Solo toca cables SIN quiebres propios: si alguien ya ruteó ese cable a
 *  mano, su recorrido es una decisión tomada y no se pisa. */
const RODEO_MIN = 26;      /* un rodeo más chico que esto no se distingue */
const RODEO_MAX = 90;      /* más que esto ya no es un rodeo, es otro camino */

function rutearCables(els, equipos){
  const porRef = new Map(equipos.filter(e => e.ref != null).map(e => [e.ref, e]));
  const porId  = new Map(els.filter(e => e.id != null).map(e => [e.id, e]));

  for (const c of els){
    if (c.t !== 'cable') continue;
    if (Array.isArray(c.w) && c.w.length) continue;   /* ya tiene ruteo propio */
    const a = puntaDeCable(c.a, porRef, porId);
    const b = puntaDeCable(c.b, porRef, porId);
    if (!a || !b) continue;
    const largo = Math.hypot(b.x - a.x, b.y - a.y);
    if (largo < SANGRIA_CABLE * 3) continue;   /* corto: no hay dónde rodear */

    /* La normal del tramo: hacia dónde se corre el rodeo. */
    let nx = -(b.y - a.y) / largo, ny = (b.x - a.x) / largo;

    /* De todo lo que cruza, se busca el que obliga al rodeo más grande, y de
       qué lado conviene pasarlo. Un solo rodeo para todos: dos rodeos
       encadenados en un cable de un cuarto es un garabato. */
    let peor = 0, signo = 0;
    for (const e of equipos){
      if (e === a.el || e === b.el) continue;
      const caja = cajaDeRotulo(e);
      const radio = Math.min(caja.w, caja.h) / 2 + AIRE_CABLE;
      const g = alSegmento(e, a, b);
      if (g.d >= radio) continue;
      if (g.len && (g.t * g.len < SANGRIA_CABLE ||
                    (1 - g.t) * g.len < SANGRIA_CABLE)) continue;
      /* De qué lado del cable está: el rodeo va para el OTRO lado. */
      const lado = ((e.x - a.x) * nx + (e.y - a.y) * ny) >= 0 ? -1 : 1;
      const necesita = radio - g.d + AIRE_CABLE;
      if (necesita > peor){ peor = necesita; signo = lado; }
    }
    if (!peor) continue;

    /* Se PRUEBAN los rodeos y se elige el que deja el camino limpio, en vez de
       confiar en el primero. Un rodeo a ojo esquiva a uno y cae sobre otro:
       MEDIDO, así quedaban 2 elementos cruzados en un plano de dos cuartos.
       Son seis tanteos por cable —dos lados por tres distancias—, cada uno
       cuesta recorrer la lista de equipos: nada al lado de tener que arreglar
       el plano a mano después. Y si NINGUNO limpia el camino, gana el que menos
       cruces deja; y si ni eso mejora la recta, el cable se queda derecho. */
    const mk = (t, d, sg) => ({
      x: Math.round(acotar(a.x + (b.x - a.x) * t + nx * d * sg, 0, CW)),
      y: Math.round(acotar(a.y + (b.y - a.y) * t + ny * d * sg, 0, CH))
    });
    /** Cuántos equipos ajenos cruza un recorrido dado. */
    const cruces = pts => {
      let n = 0;
      for (const e of equipos){
        if (e === a.el || e === b.el) continue;
        const caja = cajaDeRotulo(e);
        const radio = Math.min(caja.w, caja.h) / 2 + AIRE_CABLE;
        let cerca = Infinity, largoAcum = 0, total = 0;
        for (let i = 0; i < pts.length - 1; i++)
          total += Math.hypot(pts[i+1].x - pts[i].x, pts[i+1].y - pts[i].y);
        for (let i = 0; i < pts.length - 1; i++){
          const g = alSegmento(e, pts[i], pts[i + 1]);
          const s0 = largoAcum + g.t * (g.len || 0);
          largoAcum += g.len || 0;
          /* Las puntas siguen francas: el cable llega a su equipo por ahí. */
          if (s0 < SANGRIA_CABLE || s0 > total - SANGRIA_CABLE) continue;
          cerca = Math.min(cerca, g.d);
        }
        if (cerca < radio) n++;
      }
      return n;
    };

    const base = cruces([a, b]);
    let mejor = null, mejorN = base;
    const paso = Math.max(RODEO_MIN, Math.min(RODEO_MAX, peor));
    for (const sg of [signo || 1, -(signo || 1)]){
      for (const k of [1, 1.6, 2.4]){
        const d = Math.min(RODEO_MAX, paso * k);
        const pts = [mk(0.25, d, sg), mk(0.75, d, sg)];
        const n = cruces([a, ...pts, b]);
        if (n < mejorN){ mejorN = n; mejor = pts; if (!n) break; }
      }
      if (!mejorN && mejor) break;
    }
    if (mejor) c.w = mejor;
  }
}

/* Los dos nombres viejos siguen existiendo porque el resto del código (y los
   tests) los conocen, pero ahora los dos entran a la MISMA pasada. */
const separarEquipos = equipos => separarRotulos(equipos);
const separarTextos  = textos  => separarRotulos(textos);

/* ==========================================================================
   5. LA CADENA DE ACOMETIDA
   ========================================================================== */

/** Ordena por rango eléctrico los tableros que comparten un mismo muro.
 *
 *  El modelo devuelve las posiciones que VE, y si en la captura el TDG quedó
 *  antes que el TDS, la acometida sale yendo y volviendo sobre la misma pared:
 *  dos cables cruzados donde debería haber un recorrido corrido. Acá NO se
 *  mueve a nadie a otro lugar: se toman los lugares que el grupo YA ocupa
 *  sobre ese muro y se reparten entre sus miembros en orden eléctrico. El
 *  conjunto queda donde estaba; lo que cambia es quién ocupa cada casillero.
 *
 *  La dirección sale del eslabón de menor rango (el rack, o el tablero más
 *  cercano a la carga): la cadena crece ALEJÁNDOSE de él, que es como se lee
 *  un plano — de lo que se alimenta hacia la calle. */
function ordenarCadena(miembros, lado, ancla, dibujados){
  if (miembros.length < 2) return;
  const rango = e => RANGO_CADENA[e.k];

  /* Si el dibujo YA trae un cable entre dos de estos, manda el dibujo. Y no
     por deferencia: los codos de ese cable son coordenadas ABSOLUTAS que no
     se mudan con el equipo, así que intercambiar dos tableros dejaría el
     recorrido apuntando a donde uno de ellos ya no está — un zigzag peor que
     el que se venía a arreglar. Cuando hay línea dibujada, el orden ya está
     dicho. */
  if ((dibujados || []).some(c => {
    const refs = [c.a && c.a.ref, c.b && c.b.ref];
    return miembros.filter(m => refs.includes(m.ref)).length === 2;
  })) return;
  /* Sin al menos dos rangos distintos no hay cadena que ordenar (tres tomas
     en fila no son una cadena). */
  if (new Set(miembros.map(rango)).size < 2) return;

  const horiz = esHorizontal(lado);
  const puestos = miembros.map(e => aLoLargo(e, lado)).sort((a, b) => a - b);
  const centro = puestos.reduce((t, v) => t + v, 0) / puestos.length;

  /* La dirección la marca el eslabón de MENOR rango del CUARTO —el rack, casi
     siempre—, aunque esté montado en otra pared: la acometida sale de él hacia
     la calle. Buscar el ancla solo dentro de este muro no alcanza, y el caso
     es de lo más común: con dos tableros sobre la pared sur y el rack sobre la
     oeste, el de menor rango de los dos siempre "está" del lado en el que ya
     estaba, así que nunca se reordenarían aunque vinieran al revés. */
  const minGrupo = Math.min(...miembros.map(rango));
  const guia = (ancla && rango(ancla) !== undefined && rango(ancla) <= minGrupo)
    ? ancla
    : miembros.reduce((a, b) => rango(a) <= rango(b) ? a : b);
  const creciente = aLoLargo(guia, lado) <= centro;
  if (!creciente) puestos.reverse();

  /* Orden estable: a igual rango, el que ya estaba antes sigue antes. */
  const conIndice = miembros.map((e, i) => ({ e, i }));
  conIndice.sort((A, B) => (rango(A.e) - rango(B.e)) || (A.i - B.i));
  conIndice.forEach(({ e }, i) => {
    if (horiz) e.x = Math.round(puestos[i]);
    else       e.y = Math.round(puestos[i]);
  });
}

/* Cuánto baja una puesta a tierra por debajo de su tablero. Es la longitud que
   deja lugar al rótulo del tablero arriba y al de la tierra abajo sin que se
   toquen, que es exactamente para lo que se dibuja esa bajante. */
const CAIDA_TIERRA = 100;
/* Si dos tierras cuelgan del mismo tablero, se abren para no quedar una sobre
   la otra. */
const SEPARACION_TIERRAS = 70;

/** Cuelga cada puesta a tierra de su tablero, perpendicular al muro.
 *
 *  Una SPT no es un equipo que "está en algún lado": es el extremo de una
 *  bajante que sale de un tablero concreto. Dibujarla alineada con su tablero
 *  y a una distancia fija hace que el cable de tierra salga recto y que se lea
 *  de un vistazo de cuál cuelga — que es la única información que esa bajante
 *  aporta al plano. */
/** ¿De qué tablero cuelga cada puesta a tierra?
 *
 *  Hay que decidirlo ACÁ y no dejárselo a la auto-conexión, porque LINKS
 *  recorre los tableros en un orden fijo (TDG antes que TDS) y termina
 *  mandando las dos bajantes al mismo tablero — una de ellas cruzando el plano
 *  en diagonal desde el pie del otro. Sabiendo de cuál cuelga cada una se la
 *  puede dibujar alineada y con el cable recto, que es lo que hace un plano.
 *
 *  Si el dibujo YA traía la bajante, manda el dibujo. Si no, el tablero más
 *  cercano, que es de dónde el instalador la sacaría. */
const SESGO_TDG = 0.75;

function asignarTableros(tierras, tableros, cablesDibujados){
  if (!tableros.length) return;
  const porRef = new Map(tableros.map(t => [t.ref, t]));
  const refsDe = c => [c.a && c.a.ref, c.b && c.b.ref];
  for (const t of tierras){
    let elegido = null;
    for (const c of cablesDibujados){
      if (c.k !== 'spt') continue;
      const refs = refsDe(c);
      if (!refs.includes(t.ref)) continue;
      const otro = refs.find(r => r && r !== t.ref);
      if (otro && porRef.has(otro)){ elegido = porRef.get(otro); break; }
    }
    /* Sin cable dibujado, gana el más cercano PERO con el pulgar puesto sobre
       el TDG: en estos planos el que se aterriza es el general, y el TDS solo
       de vez en cuando. El sesgo solo decide empates y casi-empates; si la
       tierra está claramente al pie del TDS, el TDS gana igual. */
    const conSesgo = tab => Math.hypot(tab.x - t.x, tab.y - t.y) * (tab.k === 'TDG' ? SESGO_TDG : 1);
    if (!elegido) elegido = tableros.reduce((a, b) => conSesgo(a) <= conSesgo(b) ? a : b);
    t.__tablero = elegido;
  }
}

/** La bajante de tierra de cada SPT hacia SU tablero — la que acaba de
    decidir asignarTableros(). Se saltea la que el dibujo ya traía. */
function bajantesDeTierra(tierras, cablesDibujados){
  const cables = [];
  for (const t of tierras){
    const tab = t.__tablero;
    if (!tab) continue;
    const yaLaTrae = cablesDibujados.some(c => c.k === 'spt' &&
      [c.a && c.a.ref, c.b && c.b.ref].includes(t.ref));
    if (yaLaTrae) continue;
    cables.push({ t: 'cable', k: 'spt', label: '', elbow: 'auto', w: [],
                  a: { ref: t.ref, x: t.x, y: t.y },
                  b: { ref: tab.ref, x: tab.x, y: tab.y } });
  }
  return cables;
}

function colgarTierras(tierras){
  const porTablero = new Map();
  for (const t of tierras){
    const tab = t.__tablero;
    if (!tab) continue;
    if (!porTablero.has(tab)) porTablero.set(tab, []);
    porTablero.get(tab).push(t);
  }
  for (const [tab, lista] of porTablero){
    /* El lado del tablero manda: si está sobre el muro sur, la bajante va
       hacia abajo; si está sobre el oeste, hacia la izquierda. Sin tablero
       pegado a un muro (puede pasar si no había cuartos), se baja. */
    const lado = tab.__lado || 's';
    const n = NORMAL[lado];
    lista.forEach((t, i) => {
      /* Se reparten simétricamente a los costados de la bajante. */
      const corr = (i - (lista.length - 1) / 2) * SEPARACION_TIERRAS;
      const px = tab.x + n.x * CAIDA_TIERRA + (esHorizontal(lado) ? corr : 0);
      const py = tab.y + n.y * CAIDA_TIERRA + (esHorizontal(lado) ? 0 : corr);
      t.x = Math.round(acotar(px, 0, CW));
      t.y = Math.round(acotar(py, 0, CH));
      /* Puede deslizarse a lo largo del muro del que cuelga, nunca acercarse
         ni alejarse: eso cambiaría el largo de la bajante. */
      t.__eje = esHorizontal(lado) ? 'h' : 'v';
      t.__lado = lado;
      t.rot = (R.RUMBO[lado] + 180) % 360;
    });
  }
}

/* ==========================================================================
   6. CONEXIONES
   ========================================================================== */

/** Las conexiones que la norma da por hechas.
 *
 *  Hasta acá, un cable existía solo si el modelo alcanzó a VER la línea en la
 *  captura. Pero en estos planos SPT→tablero, AP→RACK y toma→tablero no son
 *  una decisión de diseño: son lo que la instalación es. El editor ya las traza
 *  solo cuando uno suelta el símbolo con auto-conexión activa (lib/autolink.js),
 *  así que acá se corre exactamente la misma regla — mismo resultado que
 *  ponerlos a mano, y sin una sola llamada más al modelo.
 *
 *  Solo se mira lo de ESTA pasada. Los elementos que ya estaban en el plano
 *  llegan sin sus cables (el cliente manda posiciones y rótulos, no el grafo),
 *  así que incluirlos haría que un tablero ya conectado se volviera a conectar:
 *  duplicar es peor que no completar. */
function autoConectar(nuevos){
  /* Las tomas que AGREGÓ el acomodado quedan fuera del grafo: son símbolos que
     nadie dibujó, y tirarles además la acometida serían tres líneas más
     cruzando el cuarto por algo inventado. El símbolo dice que la salida
     existe; por dónde va el caño es otra conversación. */
  /* Las TOMAS quedan fuera del grafo por completo: en estos planos no llevan
     cable dibujado (la acometida a las salidas va por dentro del muro). Antes
     solo se excluían las que agregaba el acomodado; ahora TODAS, porque una
     toma leída del dibujo tampoco lo lleva. */
  const equipos = nuevos.filter(e => e.t === 'equip' && !e.__agregada && !R.TOMAS.has(e.k));
  if (!equipos.length) return [];

  /* autoLink razona por id y estos elementos todavía no tienen (los reparte el
     cliente con su propio uid). Se les presta el `ref` como id mientras dura
     el análisis. */
  const porRef = new Map(equipos.map(e => [e.ref, e]));
  const grafo = equipos.map(e => ({ id: e.ref, t: 'equip', k: e.k, x: e.x, y: e.y, label: e.label }));
  const extremo = p => (p && p.ref && porRef.has(p.ref)) ? { id: p.ref } : { x: p.x, y: p.y };
  for (const c of nuevos){
    if (c.t !== 'cable') continue;
    grafo.push({ id: 'c' + grafo.length, t: 'cable', k: c.k, a: extremo(c.a), b: extremo(c.b) });
  }

  const cables = [];
  /* Orden fijo (el de lectura) para que dos corridas con la misma imagen den
     el mismo plano: autoLink elige "el más cercano que todavía tiene lugar",
     y eso depende de en qué orden se pregunta. */
  for (const g of grafo.filter(e => e.t === 'equip')){
    const { cables: nuevosCables } = autoLink(grafo, g);
    for (const c of nuevosCables){ c.id = 'a' + grafo.length; grafo.push(c); cables.push(c); }
  }

  /* En estos planos lo ÚNICO que se aterriza es el tablero: casi siempre el
     general, a veces el de distribución, y nada más. LINKS —que es la regla
     del editor y sirve para soltar símbolos a mano— además le tira una bajante
     al RACK y a cada protección, y eso acá se traduce en un #8 verde que
     atraviesa el plano de punta a punta hasta la pica. Se filtran: una tierra
     solo queda conectada a un tablero. */
  const claseDe = id => { const e = grafo.find(g => g.id === id); return e ? e.k : null; };
  const conectaTierra = c => TIERRAS.has(claseDe(c.a.id)) || TIERRAS.has(claseDe(c.b.id));

  /* La acometida eléctrica no entra por el poste de la bajante óptica.
     LINKS manda el tablero al MEDIDOR y, si está ocupado, al POSTE más
     cercano POR DISTANCIA — y el más cercano puede ser el de la fibra.
     Un poste con fibra colgando (o con el km al nodo que leyó el
     intérprete) es el óptico: por ahí no entra la energía. */
  const conFibra = new Set();
  for (const c of grafo){
    if (c.t !== 'cable' || c.k !== 'fibra') continue;
    for (const p of [c.a, c.b]) if (p && p.id) conFibra.add(p.id);
  }
  const esPosteOptico = id => {
    if (claseDe(id) !== 'POSTE') return false;
    const eq = porRef.get(id);
    return conFibra.has(id) || !!(eq && eq.km);
  };
  const hayMedidor = grafo.some(e => e.t === 'equip' && e.k === 'MEDIDOR');
  const hayPosteElectrico = grafo.some(e => e.t === 'equip' && e.k === 'POSTE' && !esPosteOptico(e.id));

  const cablesValidos = cables.filter(c => {
    if (c.k === 'acom') {
      const ka = claseDe(c.a.id), kb = claseDe(c.b.id);
      const tableroConPoste = (TABLEROS.has(ka) && kb === 'POSTE') || (TABLEROS.has(kb) && ka === 'POSTE');
      if (tableroConPoste) {
        const idPoste = ka === 'POSTE' ? c.a.id : c.b.id;
        if (hayMedidor || esPosteOptico(idPoste) || hayPosteElectrico) return false;
      }
    }
    if (c.k !== 'spt' || !conectaTierra(c)) return true;
    const otro = TIERRAS.has(claseDe(c.a.id)) ? c.b.id : c.a.id;
    return TABLEROS.has(claseDe(otro));
  });

  /* De vuelta al formato de salida: los extremos vuelven a ser `ref` (que es
     lo que el cliente sabe traducir a id real) y se les deja las coordenadas
     como red de seguridad, igual que los cables que vienen del modelo. */
  return cablesValidos.map(c => {
    const A = porRef.get(c.a.id), B = porRef.get(c.b.id);
    return { t: 'cable', k: c.k, label: '', elbow: 'auto', w: [],
             a: { ref: A.ref, x: A.x, y: A.y },
             b: { ref: B.ref, x: B.x, y: B.y },
             __auto: true };
  });
}

/** Nombres que solo se pueden decidir MIRANDO LAS CONEXIONES.
 *
 *  Un poste con acometida eléctrica es el "Poste Electrico"; el mismo símbolo
 *  con una fibra colgando es el poste de la bajante óptica y se rotula
 *  distinto. Y una puesta a tierra hereda el "EXISTENTE" o el "A INSTALAR" del
 *  tablero del que cuelga, porque es parte de la misma intervención. Nada de
 *  esto se puede saber antes de que existan los cables. */
function nombrarPorContexto(equipos, cables){
  const tipoDe = new Map();
  for (const c of cables){
    for (const p of [c.a, c.b]){
      if (!p || !p.ref) continue;
      if (!tipoDe.has(p.ref)) tipoDe.set(p.ref, new Set());
      tipoDe.get(p.ref).add(c.k);
    }
  }
  for (const el of equipos){
    if (el.k === 'POSTE'){
      const tipos = tipoDe.get(el.ref) || new Set();
      const nlbl = normTexto(el.label);
      if (nlbl !== 'POSTE' && nlbl !== 'POSTE ELECTRICO') continue;
      if (tipos.has('fibra')) el.label = 'POSTE';
      else if (tipos.has('acom')) el.label = 'Poste Electrico';
    }
    if (TIERRAS.has(el.k) && el.__tablero && !calificadorDe(el.label)){
      const cal = calificadorDe(el.__tablero.label || '');
      if (cal) el.label = `${el.label} ${cal}`;
    }
  }
}

/** Cuando hay varios postes, solo el que lleva fibra (o el que trae kilometraje)
    recibe la bajante de fibra hacia el nodo; a los demás se les marca bajanteCreada
    para que el editor no les fabrique una bajante falsa al poste eléctrico. */
function marcarPostesSinBajante(equipos, cables){
  const postes = equipos.filter(e => e.k === 'POSTE');
  if (postes.length < 2) return;
  const tipoDe = new Map();
  for (const c of cables){
    for (const p of [c.a, c.b]){
      if (!p) continue;
      const ref = p.ref || p.id;
      if (!ref) continue;
      if (!tipoDe.has(ref)) tipoDe.set(ref, new Set());
      tipoDe.get(ref).add(c.k);
    }
  }
  const conFibra = postes.filter(p => (tipoDe.get(p.ref || p.id) || new Set()).has('fibra'));
  if (!conFibra.length) return;
  const elegido = conFibra.find(p => p.km) || conFibra[0];
  for (const p of postes){
    if (p !== elegido) p.bajanteCreada = true;
  }
}


/* ==========================================================================
   6bis. LA COTA QUE FALTA
   ========================================================================== */

/* Sin UN SOLO acotado, el editor no tiene de dónde deducir la escala y cae a
   ESCALA_DEFECTO (48 unidades por metro), un número puesto a dedo. A partir de
   ahí TODOS los metrajes que escribe son ficción: un tramo de 6 metros sale
   rotulado "3X10 1m" y la bajante de 15 sale "#8 23m". Eso no es un plano feo,
   es una lista de materiales equivocada — y encima no avisa.

   Lo que NO se puede hacer es inventar la medida: el ancho de ese salón lo sabe
   el que fue a medirlo. Lo que sí se puede es dejar la cota DIBUJADA, con sus
   flechas y en su lugar, y el número en blanco. El usuario escribe "14m" una
   sola vez y el plano entero se re-escala solo. */
const SIN_MEDIDA = '? m';
/* Aire entre el muro y la línea de cota. */
const SEP_COTA = 46;

/** Las dos cotas del cuarto más grande — ancho abajo, alto a la derecha —,
    con el número en blanco. Solo se agregan si NO vino ninguna cota: una sola
    medición real vale más que cualquier cosa que pongamos nosotros, y con una
    ya alcanza para que todo el plano quede a escala. */
function cotasDelCuartoPrincipal(cuartos, equipos){
  if (!cuartos.length) return [];
  const room = cuartos.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const { x1, x2, y1, y2 } = ladosDe(room);

  /* La cota va POR FUERA de todo, no pegada al muro. Debajo del salón cuelgan
     las puestas a tierra y a la derecha puede haber un poste: una línea de
     cota que les pase por encima es tan ilegible como no ponerla. Se mide
     hasta dónde llega lo que hay de ese lado y se la manda un poco más allá. */
  const BULTO = 46;
  /* El borde se mide con el rotulo puesto (ver `bordeDe` en reglas.js): medir
     el centro del icono y sumar un numero fijo dejaba la linea de cota
     partiendo nombres largos por unas pocas unidades. */
  const masAlla = (eje, limite, dentroDelOtro) => {
    let m = limite;
    for (const e of (equipos || [])){
      if (!dentroDelOtro(e)) continue;
      const v = R.bordeDe(e, eje);
      if (v > limite) m = Math.max(m, v + BULTO);
    }
    return m;
  };
  const enFranjaX = e => e.x > x1 - 120 && e.x < x2 + 120;
  const enFranjaY = e => e.y > y1 - 120 && e.y < y2 + 120;

  /* Un margen para que la cota no nazca lamiendo el borde de la hoja. */
  const M = 18;
  const abajo   = Math.round(acotar(masAlla('y', y2, enFranjaX) + SEP_COTA, M, CH - M));
  const derecha = Math.round(acotar(masAlla('x', x2, enFranjaY) + SEP_COTA, M, CW - M));

  /* Los extremos también se recortan: un cuarto más alto que la hoja (pasa con
     una captura muy vertical) mandaba la cota fuera del lienzo. */
  const cx = n => Math.round(acotar(n, M, CW - M));
  const cy = n => Math.round(acotar(n, M, CH - M));
  return [
    { t: 'dim', label: SIN_MEDIDA,
      a: { x: cx(x1), y: abajo }, b: { x: cx(x2), y: abajo } },
    /* La vertical lleva el número girado, igual que las que vienen leídas: en
       horizontal se cruza sobre su propia línea de cota. */
    { t: 'dim', label: SIN_MEDIDA, textRot: -90,
      a: { x: derecha, y: cy(y1) }, b: { x: derecha, y: cy(y2) } }
  ];
}

/* ==========================================================================
   7. ENTRADA PRINCIPAL
   ========================================================================== */

/** Acomoda TODO lo que vino de la interpretación y devuelve la lista final
    (los elementos originales, ya movidos y renombrados, más los cables que la
    norma da por hechos).

    `nuevos`  — elementos de esta pasada, con `ref` y sin id.
    `previos` — lo que el plano ya tenía: `{ t, x, y, w, h, label }`. Se usa
                solo como referencia de cuartos; no se toca ni se devuelve. */
function acomodarPlano(nuevos, previos, opciones){
  const antes = Array.isArray(previos) ? previos : [];
  const fase = (opciones && opciones.fase) || 'resto';

  /* SOLO ORDENAR: reacomodar un plano que ya existe, sin generar nada nuevo.
     Lo usa el tercer pase, después de aplicar las correcciones del modelo.

     Todo este módulo identifica elementos por `ref`, porque nació para trabajar
     con elementos recién leídos que todavía no tienen id (los reparte el
     cliente). Un plano ya existente los identifica por `id`. En vez de tocar
     las dos docenas de lugares que buscan por `ref`, se espeja el id en ref al
     entrar y se saca al salir: el resto del código no se entera y no hay dos
     caminos que mantener.

     Lo que NO corre en este modo es todo lo que CREA: tomas que faltan,
     auto-conexiones, bajantes de tierra y cotas. Esas ya se decidieron en la
     pasada original; volver a correrlas sumaría una toma más y un cable más
     en cada revisión. Acá solo se ORDENA lo que hay. */
  const soloOrdenar = !!(opciones && opciones.soloOrdenar);
  const espejados = [];
  if (soloOrdenar){
    for (const el of nuevos){
      if (el.ref === undefined && el.id !== undefined){ el.ref = el.id; espejados.push(el); }
      if (el.t !== 'cable') continue;
      for (const punta of ['a', 'b']){
        const q = el[punta];
        if (q && q.ref === undefined && q.id !== undefined) q.ref = q.id;
      }
    }
  }

  /* -------- 0. las reglas de la obra, antes de acomodar nada --------
     Van primero porque cambian QUÉ hay: si después se ordena un plano con dos
     splitters o con cables que no conectan nada, se ordena basura con mucho
     esmero.

     Las que BORRAN corren solo sobre lo que acaba de leer el modelo, nunca en
     modo 'solo ordenar'. Ese modo se invoca sobre el plano ENTERO —incluido lo
     que una persona dibujó antes de interpretar una imagen nueva—, y ahí un
     cable con una punta al aire puede ser un tendido simbólico puesto a mano
     a propósito. Corregir lo que leyó el modelo es el trabajo; borrarle a
     alguien lo que dibujó es otra cosa. */
  nuevos = R.normalizarTomas(nuevos);
  nuevos = R.unSoloTDG(nuevos);
  if (!soloOrdenar){
    nuevos = R.unSoloSplitter(nuevos);
    nuevos = R.soloCablesAnclados(nuevos);
    nuevos = R.sinCablesEnTomas(nuevos);
    nuevos = R.tierraSoloATablero(nuevos);
  } else {
    /* En reordenado de planos existentes, depurar cables automáticos espurios
       que hayan quedado de versiones viejas del intérprete. */
    const claseDe = id => { const e = nuevos.find(g => (g.id === id || g.ref === id)); return e ? e.k : null; };
    const conFibra = new Set();
    for (const c of nuevos){
      if (c.t !== 'cable' || c.k !== 'fibra') continue;
      if (c.a && c.b && (c.a.id || c.a.ref) && (c.b.id || c.b.ref)){
        conFibra.add(c.a.id || c.a.ref);
        conFibra.add(c.b.id || c.b.ref);
      }
    }
    const hayMedidor = nuevos.some(e => e.t === 'equip' && e.k === 'MEDIDOR');
    const postes = nuevos.filter(e => e.t === 'equip' && e.k === 'POSTE');
    nuevos = nuevos.filter(c => {
      if (c.t !== 'cable') return true;
      const ka = claseDe(c.a && (c.a.id || c.a.ref));
      const kb = claseDe(c.b && (c.b.id || c.b.ref));
      if (c.k === 'acom') {
        const idPoste = ka === 'POSTE' ? (c.a && (c.a.id || c.a.ref)) : (kb === 'POSTE' ? (c.b && (c.b.id || c.b.ref)) : null);
        if (idPoste && (TABLEROS.has(ka) || TABLEROS.has(kb))) {
          if (hayMedidor || conFibra.has(idPoste)) return false;
        }
        const idRack = ka === 'RACK' ? (c.a && (c.a.id || c.a.ref)) : (kb === 'RACK' ? (c.b && (c.b.id || c.b.ref)) : null);
        if (idRack && (TABLEROS.has(ka) || TABLEROS.has(kb)) && !c.label && (!c.w || !c.w.length)) {
          return false;
        }
      }
      if (c.k === 'fibra' && (!c.a || !c.b || !c.a.id || !c.b.id)) {
        const idPoste = (c.a && c.a.id) || (c.b && c.b.id);
        if (idPoste && postes.length > 1 && !conFibra.has(idPoste)) return false;
      }
      return true;
    });
  }

  const equipos = nuevos.filter(e => e.t === 'equip');
  const cuartos = nuevos.filter(e => e.t === 'room').concat(antes.filter(e => e.t === 'room'));

  /* -------- 1. nombres de catálogo -> nombres de obra -------- */
  for (const el of equipos) el.label = nombreCanonico(el);

  /* -------- 2. tamaño (de él dependen todas las cajas de colisión) -------- */
  for (const el of equipos){
    const vecinos = equipos.filter(o => o !== el &&
      Math.hypot(o.x - el.x, o.y - el.y) < 220).length;
    let escala = escalaPorContexto(cuartoDe(el.x, el.y, cuartos), vecinos);
    if (TOMAS.has(el.k)){ escala *= ESCALA_TOMA; el.size = LETRA_TOMA; }
    escala = Math.round(Math.max(0.4, escala) * 100) / 100;
    if (escala !== 1) el.scale = escala; else delete el.scale;
  }

  /* -------- 3. cada cosa contra el muro que le toca -------- */
  const tierras = [];
  for (const el of equipos){
    const rol = rolDe(el.k);
    if (rol === 'tierra'){ tierras.push(el); continue; }   /* van después */

    const room = cuartoDe(el.x, el.y, cuartos);
    if (!room) continue;

    if (rol === 'afuera'){
      /* No se lo reubica: el poste de la calle está donde está. Solo se lo
         saca si el modelo lo dibujó adentro del edificio. */
      const encierra = dentroDeAlguno(el.x, el.y, cuartos);
      if (encierra){
        const lado = ladoMasCercano(el, encierra);
        const { x1, x2, y1, y2 } = ladosDe(encierra);
        const hastaElMuro = esHorizontal(lado)
          ? (lado === 'n' ? el.y - y1 : y2 - el.y)
          : (lado === 'w' ? el.x - x1 : x2 - el.x);
        const icono = ICON_BY_KEY[el.k] || { w: 34, h: 34 };
        const medio = (esHorizontal(lado) ? icono.h : icono.w) * (el.scale || 1) / 2;
        empujarAfuera(el, lado, hastaElMuro + medio + 16);
        el.__lado = lado;
        el.__eje = esHorizontal(lado) ? 'h' : 'v';
      }
      continue;
    }

    /* Tableros, rack, tomas, puertas y el AP externo van contra el muro sí o
       sí. El resto se pega solo si ya venía cerca. */
    const forzar = rol === 'tablero' || rol === 'pared';
    const pin = pegarAPared(el, room, forzar);
    if (!pin) continue;
    el.__eje = pin.eje; el.__lado = pin.lado; el.__room = room;
  }

  /* -------- 3bis. las antenas miran a donde tienen que mirar --------
     Necesita `__lado`, así que va DESPUÉS del pegado a pared. */
  R.orientarAPs(equipos);
  /* Y se las vuelve a pegar: recién ahora se sabe cuánto ocupan de cada lado. */
  for (const el of equipos){
    if ((el.k !== 'AP1' && el.k !== 'AP2') || !el.__room) continue;
    const pin = pegarAPared(el, el.__room, true);
    if (pin){ el.__eje = pin.eje; el.__lado = pin.lado; }
  }

  /* -------- 3ter. equilibrio de esquinas y muros contiguos -------- */
  cohesionarMuros(equipos, cuartos);

  /* -------- 3quater. y todo cuarto tiene una puerta -------- */
  if (!soloOrdenar){
    const antesDePuerta = nuevos.length;
    R.asegurarPuerta(nuevos, cuartos, () => 'iap' + antesDePuerta);
    for (const nuevo of nuevos.slice(antesDePuerta)) equipos.push(nuevo);
  }

  /* -------- 3quater. las tomas que le faltan a cada cuarto cargado -------- */
  if (!soloOrdenar){
    let nToma = 0;
    const tomasNuevas = completarTomas(equipos, cuartos, () => 'iat' + (nToma++));
    equipos.push(...tomasNuevas);
    nuevos.push(...tomasNuevas);
  }

  /* -------- 4. de qué tablero cuelga cada tierra --------
     Va ANTES de reordenar la cadena, y a propósito: la pertenencia se deduce
     de dónde estaba cada cosa EN EL DIBUJO. Si después la cadena intercambia
     dos tableros, la tierra viaja con el suyo en vez de quedarse debajo del
     que ocupó ese lugar. */
  const dibujados = nuevos.filter(e => e.t === 'cable');
  asignarTableros(tierras, equipos.filter(e => TABLEROS.has(e.k)), dibujados);

  /* -------- 5. la acometida, en orden y sin zigzag -------- */
  const porMuro = new Map();
  /* El eslabón de menor rango de cada cuarto: es el que le da el sentido a la
     cadena aunque esté en otra pared que los tableros. */
  const anclaDelCuarto = new Map();
  for (const el of equipos){
    if (RANGO_CADENA[el.k] === undefined || !el.__lado || !el.__room) continue;
    const clave = `${cuartos.indexOf(el.__room)}|${el.__lado}`;
    if (!porMuro.has(clave)) porMuro.set(clave, []);
    porMuro.get(clave).push(el);
    const previo = anclaDelCuarto.get(el.__room);
    if (!previo || RANGO_CADENA[el.k] < RANGO_CADENA[previo.k]) anclaDelCuarto.set(el.__room, el);
  }
  for (const [clave, miembros] of porMuro){
    const [iCuarto, lado] = clave.split('|');
    ordenarCadena(miembros, lado, anclaDelCuarto.get(cuartos[Number(iCuarto)]), dibujados);
  }

  /* -------- 6. y recién ahora se las cuelga --------
     Ya con el tablero en su lugar definitivo, la bajante sale recta y del
     largo que corresponde. */
  colgarTierras(tierras);
  if (!soloOrdenar) nuevos.push(...bajantesDeTierra(tierras, dibujados));

  /* -------- 7. las conexiones que la norma da por hechas -------- */
  let autos = soloOrdenar ? [] : autoConectar(nuevos);

  /* Y el mismo filtro OTRA VEZ, ahora sobre lo que acaba de inventar la
     auto-conexión. Corriéndolo solo antes se limpiaba lo que leyó el modelo y
     LINKS los volvía a poner idénticos tres líneas después. MEDIDO contra el
     plano que el usuario corrigió a mano: el reordenado daba 100% y el recién
     interpretado 92%, y la diferencia eran exactamente estos cables. */
  if (!soloOrdenar){
    const juntos = new Set(R.depurarCablesEspurios(nuevos.concat(autos)));
    autos  = autos.filter(c => juntos.has(c));
    nuevos = nuevos.filter(e => e.t !== 'cable' || juntos.has(e));
  }

  /* -------- 8. nombres que dependían de las conexiones -------- */
  const todosLosCables = nuevos.filter(e => e.t === 'cable').concat(autos);
  nombrarPorContexto(equipos, todosLosCables);
  if (!soloOrdenar) marcarPostesSinBajante(equipos, todosLosCables);

  /* -------- 9. rotar los rótulos que quedaron sobre un muro vertical --------
     En horizontal, "SPT A INSTALAR" se mete varios metros dentro del cuarto (o
     se sale de la hoja) y se cruza con lo que haya al lado; girado corre
     paralelo al muro, que es como se rotula a mano. El corte por largo es a
     propósito: "Toma" en horizontal no molesta a nadie y leerlo de costado es
     peor. */
  for (const el of equipos){
    if (!TIERRAS.has(el.k) && el.__eje === 'v' && String(el.label || '').length >= 9) el.textRot = -90;
    else if (el.textRot === -90) delete el.textRot;
  }

  /* -------- 10. la cota que falta --------
     Solo en la pasada completa: la primera trae únicamente los cuartos y
     agregarlas ahí las duplicaría cuando llegue la segunda. Y solo si el
     modelo no encontró NINGUNA: una medición leída del dibujo vale más que
     cualquier cosa que pongamos nosotros. */
  /* Siempre tiene que haber cota, y pegada al muro que mide. Si el modelo ya
     leyó una medida real de ese lado, esa manda: solo se la endereza. */
  if (fase !== 'cuartos') nuevos = R.cotasAlineadas(nuevos, cuartos, equipos);

  /* -------- 11. y AHORA sí, que nada quede encima de nada --------
     Va último a propósito: la caja de colisión de cada cosa depende de su
     rótulo definitivo y de si quedó girado, y las dos cosas se acaban de
     decidir. Separar antes —como se hacía— era medir huellas que todavía
     iban a cambiar. Entran los equipos, los textos sueltos y, como bultos
     que no se mueven, los números de los acotados y los nombres de cuarto. */
  /* PRIMERO la restricción dura: que no se tape nada con nada. */
  const bultos = () => [
    ...equipos,
    ...nuevos.filter(e => e.t === 'text'),
    ...obstaculosFijos(nuevos, cuartos)
  ];
  separarRotulos(bultos());

  /* DESPUÉS la blanda, pero ALTERNADAS y varias veces.
     Una sola vuelta no alcanzaba y el motivo es que las dos se pisan: la
     blanda corre un rótulo para despegarlo de un cable, la dura lo empuja de
     vuelta para que no tape a su vecino, y como la dura va última se queda con
     la última palabra — MEDIDO, así quedaban 3 elementos sobre un cable.
     Alternándolas, cada vuelta parte de una posición mejor que la anterior y
     el sistema se afloja hacia una que cumple las dos. Se termina SIEMPRE en
     la dura: entre un roce con una línea y dos símbolos tapándose, el que no
     se puede dejar pasar es el segundo. */
  const movibles = [...equipos, ...nuevos.filter(e => e.t === 'text')];
  const conCables = nuevos.concat(autos);
  for (let vuelta = 0; vuelta < 4; vuelta++){
    apartarDeCables(movibles, conCables, equipos);
    separarRotulos(bultos());
  }

  /* La bajante de tierra es un PAR, y hasta acá se rompía en silencio: la
     regla blanda puede correr un TABLERO para despejar un cable, y su tierra
     se queda donde se la colgó. MEDIDO en el plano de referencia: el TDG se
     fue 100 unidades y su SPT quedó apuntando al vacío, entre los dos
     tableros, sin que se pueda leer de cuál cuelga — que es la única
     información que esa línea verde aporta.

     Se las vuelve a colgar con el tablero ya en su sitio definitivo y se las
     clava: de acá en más, si hay que despejar algo, el que se corre es el
     otro. El último colgado es por si esa pasada llegó a mover un tablero
     más — el par tiene que cerrar sí o sí. */
  colgarTierras(tierras);
  for (const t of tierras) t.__fijo = true;
  separarRotulos(bultos());
  colgarTierras(tierras);
  for (const t of tierras) delete t.__fijo;

  /* Y para lo que quedó cruzado sin poder moverse —lo clavado a un muro—, el
     que se corre es el cable. Va al final, con todo ya en su lugar
     definitivo: rutear contra posiciones que todavía van a cambiar es rodear
     un obstáculo que no va a estar ahí. */
  rutearCables(conCables, equipos);

  /* Las coordenadas que lleva cada extremo de cable son la red de seguridad
     por si el cliente no pudiera resolver el `ref`. Después de todo el
     acomodado están viejas —el equipo se movió— así que se refrescan: un
     extremo que caiga como punto libre tiene que caer DONDE ESTÁ el equipo,
     no donde estaba antes de ordenarlo. */
  const porRefFinal = new Map(equipos.map(e => [e.ref, e]));
  for (const c of nuevos.concat(autos)){
    if (c.t !== 'cable') continue;
    for (const punta of ['a', 'b']){
      const p = c[punta];
      const eqp = p && p.ref && porRefFinal.get(p.ref);
      if (eqp){ p.x = eqp.x; p.y = eqp.y; }
    }
  }

  /* Los `__*` eran apuntes de trabajo, no campos del editor: se van antes de
     que esto salga por la red. */
  for (const el of equipos){
    delete el.__eje; delete el.__lado; delete el.__room;
    delete el.__tablero; delete el.__agregada; delete el.__puertaAuto;
  }
  for (const c of autos) delete c.__auto;

  /* Los `ref` espejados eran andamiaje interno: el cliente identifica por id. */
  for (const el of espejados) delete el.ref;
  if (soloOrdenar){
    for (const el of nuevos){
      if (el.t !== 'cable') continue;
      for (const punta of ['a', 'b']){
        const q = el[punta];
        if (q && q.id !== undefined) delete q.ref;
      }
    }
  }
  return nuevos.concat(autos);
}

module.exports = {
  acomodarPlano, nombreCanonico, rolDe, ordenarCadena, colgarTierras,
  asignarTableros, bajantesDeTierra, completarTomas, mejorSitioEnElMuro,
  cohesionarMuros,
  cotasDelCuartoPrincipal, SIN_MEDIDA, SESGO_TDG,
  separarRotulos, cajaDeRotulo, obstaculosFijos, apartarDeCables, rutearCables, anclarAPared,
  PARED_INTERIOR, PARED_EXTERIOR,
  TOMAS_MINIMAS, EQUIPOS_QUE_PIDEN_TOMAS,
  autoConectar, cuartoDe, pegarAPared, escalaPorContexto, separarEquipos,
  separarTextos, TOMAS, TABLEROS, TIERRAS, RANGO_CADENA, NOMBRE_BASE,
  ESCALA_TOMA, LETRA_TOMA, CAIDA_TIERRA
};
