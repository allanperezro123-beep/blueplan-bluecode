'use strict';
/* --------------------------------------------------------------------------
   REGLAS DE LA OBRA — correcciones POSTERIORES a la llamada al modelo

   Todo lo de acá son cosas que en estos planos se cumplen SIEMPRE, sin
   excepción y sin depender de lo que se vea en la imagen. Por eso no van en el
   prompt: pedírselas al modelo es esperar que acierte el 100% de las veces
   sobre algo que se puede garantizar con diez líneas de código. Un prompt
   convence; una regla cumple.

   La división es esa: el modelo LEE (qué hay y dónde), y acá se hace cumplir
   lo que la instalación exige. Si alguna vez el modelo devuelve dos splitters,
   no hay que mejorar el prompt — hay que borrar uno.
   -------------------------------------------------------------------------- */
const { ICONS } = require('./catalog');
const { CW, CH } = require('./geometria');

const ICON_BY_KEY = Object.fromEntries(ICONS.map(i => [i.k, i]));
const acotar = (v, min, max) => Math.max(min, Math.min(max, v));

/* La ÚNICA toma que se usa en estos planos: círculo, línea horizontal y dos
   patas. El catálogo tiene seis variantes (regulada con su rayo, de piso,
   monofásica, trifásica…) y el modelo elige cualquiera según cómo le pareció
   el dibujo; el resultado es un plano con cuatro símbolos distintos para la
   misma cosa. Acá se unifican todas a esta. */
const TOMA_CANONICA = 'TOMA';
const TOMAS = new Set(['TOMA', 'TOMAREG', 'TOMA_GENERAL', 'TOMA_PISO',
                       'TOMA_MONOFASICO', 'TOMA_TRIFASICO']);

const TABLEROS = new Set(['TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE']);
const TIERRAS  = new Set(['SPT', 'TIERRA_RETIE', 'TIERRA_PROTECCION',
                          'TIERRA_AISLADA', 'MASA', 'CONDUCTOR_SPT']);

const RX_INSTALAR  = /\bA\s*INSTALAR\b|\bNUEVOS?\b|\bPROYECTADOS?\b|\bPROPUESTOS?\b/i;
const RX_EXISTENTE = /\bEXISTENTES?\b/i;
const calificadorDe = s =>
  RX_INSTALAR.test(s) ? 'A INSTALAR' : (RX_EXISTENTE.test(s) ? 'EXISTENTE' : '');

const claveDe = el => (el && (el.ref !== undefined ? el.ref : el.id));
const puntaDe = p => (p && (p.ref !== undefined ? p.ref : p.id));

/* ==========================================================================
   1. UN SOLO SPLITTER
   ========================================================================== */

/** Una sede tiene UNA caja terminal. Si el modelo vio dos —pasa cuando el
    dibujo la muestra con su sombra, o cuando hay una leyenda al lado— se queda
    la que tiene fibra conectada, que es la de verdad; si ninguna la tiene, la
    primera. Las otras se van con los cables que colgaban de ellas. */
function unSoloSplitter(els){
  const naps = els.filter(e => e.t === 'equip' && e.k === 'NAP');
  if (naps.length < 2) return els;

  const conFibra = new Set();
  for (const c of els){
    if (c.t !== 'cable' || c.k !== 'fibra') continue;
    for (const p of [c.a, c.b]) if (puntaDe(p) !== undefined) conFibra.add(puntaDe(p));
  }
  const elegido = naps.find(n => conFibra.has(claveDe(n))) || naps[0];
  const fuera = new Set(naps.filter(n => n !== elegido).map(claveDe));
  return els.filter(e => {
    if (e.t === 'equip') return !fuera.has(claveDe(e));
    if (e.t === 'cable') return !fuera.has(puntaDe(e.a)) && !fuera.has(puntaDe(e.b));
    return true;
  });
}

/* ==========================================================================
   2. UN CABLE ES UNA CONEXIÓN ENTRE DOS COSAS
   ========================================================================== */

/** Se van los cables que no tienen los DOS extremos enganchados a un elemento.
 *
 *  Un tramo con una punta al aire no es una conexión: es una raya. El modelo
 *  los devuelve cuando ve una línea que se pierde detrás de un símbolo o que
 *  sale del recorte de la captura, y en el plano quedan como cables que nacen
 *  de la nada. Encima el editor les escribe un metraje, así que además mienten.
 *
 *  La bajante del poste al nodo es la excepción legítima —termina en flecha,
 *  fuera del plano— pero esa la crea el EDITOR, no el intérprete, así que acá
 *  no hay nada que respetar. */
function soloCablesAnclados(els){
  const existe = new Set(els.filter(e => e.t === 'equip').map(claveDe));
  return els.filter(e => e.t !== 'cable' ||
    (existe.has(puntaDe(e.a)) && existe.has(puntaDe(e.b)) &&
     puntaDe(e.a) !== puntaDe(e.b)));
}

/* ==========================================================================
   3. UNA SOLA TOMA, Y SIN CABLES
   ========================================================================== */

/** Todas las variantes de toma pasan a ser la misma. */
function normalizarTomas(els){
  for (const e of els){
    if (e.t === 'equip' && TOMAS.has(e.k) && e.k !== TOMA_CANONICA) e.k = TOMA_CANONICA;
  }
  return els;
}

/** Las tomas no llevan cable dibujado. En estos planos la acometida a las
    salidas va por dentro del muro y no se representa: dibujarla llena el
    cuarto de líneas que no aportan nada y tapan lo que sí importa. */
function sinCablesEnTomas(els){
  const tomas = new Set(els.filter(e => e.t === 'equip' && TOMAS.has(e.k)).map(claveDe));
  if (!tomas.size) return els;
  return els.filter(e => e.t !== 'cable' ||
    (!tomas.has(puntaDe(e.a)) && !tomas.has(puntaDe(e.b))));
}

/* ==========================================================================
   4. LA TIERRA VA AL TABLERO, NUNCA AL RACK
   ========================================================================== */

/** Se van las bajantes de tierra que no terminan en un tablero.
 *
 *  La regla de la obra es tajante: lo que se aterriza es el TDG, y muy de vez
 *  en cuando el TDS. Nada más. LINKS —que es la auto-conexión del editor y
 *  sirve para soltar símbolos a mano— además le tira una bajante al RACK y a
 *  cada protección, y en el plano eso se ve como un #8 verde cruzando la hoja
 *  entera hasta la pica. */
function tierraSoloATablero(els){
  const clase = new Map(els.filter(e => e.t === 'equip').map(e => [claveDe(e), e.k]));
  return els.filter(e => {
    if (e.t !== 'cable' || e.k !== 'spt') return true;
    const ka = clase.get(puntaDe(e.a)), kb = clase.get(puntaDe(e.b));
    const tocaTierra = TIERRAS.has(ka) || TIERRAS.has(kb);
    if (!tocaTierra) return true;
    const otro = TIERRAS.has(ka) ? kb : ka;
    return TABLEROS.has(otro);
  });
}

/* ==========================================================================
   5. LAS ANTENAS SE MONTAN CONTRA EL MURO
   ========================================================================== */

/* Los dos íconos de AP están dibujados con la BASE abajo y las ondas saliendo
   hacia arriba. O sea que sin girar, un AP "apunta al norte". Eso está bien
   solo por casualidad, cuando toca el muro sur. */
const RUMBO = { n: 0, e: 90, s: 180, w: 270 };

/** Gira cada AP para que sus patas queden contra el muro y las ondas salgan
    hacia donde tienen que salir: el AP EXTERIOR irradia hacia AFUERA del
    edificio, el INTERIOR hacia adentro del cuarto. Un AP apuntando al techo no
    existe en una instalación. */
function orientarAPs(equipos){
  for (const el of equipos){
    if (el.k !== 'AP1' && el.k !== 'AP2') continue;
    const lado = el.__lado;
    if (!lado || RUMBO[lado] === undefined) continue;
    /* El exterior emite hacia afuera (la normal del muro); el interior, al
       revés — media vuelta. */
    el.rot = el.k === 'AP2' ? RUMBO[lado] : (RUMBO[lado] + 180) % 360;
  }
  return equipos;
}

/** Medio ancho/alto del símbolo EN PANTALLA, contando que girarlo 90° da vuelta
    su huella. Sin esto, un AP girado queda medio metido en la pared. */
function mitadHacia(el, ejeVertical){
  const i = ICON_BY_KEY[el.k] || { w: 34, h: 34 };
  const s = el.scale || 1;
  const cuartoDeVuelta = Math.round(((el.rot || 0) % 180) / 90) === 1;
  const w = cuartoDeVuelta ? i.h : i.w;
  const h = cuartoDeVuelta ? i.w : i.h;
  return (ejeVertical ? w : h) * s / 2;
}

/* ==========================================================================
   6. SIEMPRE HAY UNA PUERTA
   ========================================================================== */

/** Todo espacio cerrado se entra por algún lado. El modelo casi nunca la ve
    —en un croquis es un arco finito— pero en el plano tiene que estar: es lo
    que distingue un cuarto de un rectángulo.
    Se pone en el muro más despejado del cuarto más grande. */
function asegurarPuerta(els, cuartos, nuevaClave){
  if (!cuartos.length) return els;
  if (els.some(e => e.t === 'equip' && e.k === 'puerta')) return els;

  const room = cuartos.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const x1 = room.x - room.w/2, x2 = room.x + room.w/2;
  const y1 = room.y - room.h/2, y2 = room.y + room.h/2;
  const ocupados = els.filter(e => e.t === 'equip' && e.x !== undefined);

  /* Se prueban puntos sobre los cuatro muros y gana el más lejano a todo lo
     que ya hay: una puerta detrás del rack no se puede abrir. */
  const M = 40;
  const muros = [
    { lado:'s', p0:{ x:x1, y:y2 }, u:{ x:1, y:0 }, len: x2 - x1 },
    { lado:'n', p0:{ x:x1, y:y1 }, u:{ x:1, y:0 }, len: x2 - x1 },
    { lado:'w', p0:{ x:x1, y:y1 }, u:{ x:0, y:1 }, len: y2 - y1 },
    { lado:'e', p0:{ x:x2, y:y1 }, u:{ x:0, y:1 }, len: y2 - y1 }
  ];
  let mejor = null, mejorD = -1;
  for (const m of muros){
    const util = m.len - M * 2;
    if (util <= 0) continue;
    for (let i = 0; i <= 12; i++){
      const t = M + (util * i) / 12;
      const px = m.p0.x + m.u.x * t, py = m.p0.y + m.u.y * t;
      let cerca = Infinity;
      for (const o of ocupados) cerca = Math.min(cerca, Math.hypot(o.x - px, o.y - py));
      /* El muro sur tiene ventaja: es donde se dibuja la puerta en estos
         planos, y así no queda en la pared donde entra la acometida. */
      const puntaje = cerca + (m.lado === 's' ? 60 : 0);
      if (puntaje > mejorD){ mejorD = puntaje; mejor = { x: Math.round(px), y: Math.round(py), lado: m.lado }; }
    }
  }
  if (!mejor) return els;

  els.push({ t:'equip', k:'puerta', rot:0, ref: nuevaClave(),
             x: mejor.x, y: mejor.y, label:'', sub:'',
             __lado: mejor.lado, __eje: (mejor.lado === 'n' || mejor.lado === 's') ? 'h' : 'v',
             __room: room, __puertaAuto: true });
  return els;
}
/* ==========================================================================
   8. UN SOLO TABLERO GENERAL
   ========================================================================== */

/** Una sede tiene UN tablero general: el que cuelga de la acometida de la
    calle. Todo tablero extra que el modelo lea como TDG es, en la obra, el
    SECUNDARIO — y leerlo mal no es cosmético: el tramo TDG<->TDG no matchea
    ninguna regla de ETIQUETAS_AUTO, así que la acometida al secundario queda
    sin su 3X10.

    Se DEGRADA a TDS y se le deja su calificador. */
const DESDE_LA_CALLE = new Set(['MEDIDOR', 'POSTE']);

function unSoloTDG(els){
  const tdgs = els.filter(e => e.t === 'equip' && e.k === 'TDG');
  if (tdgs.length < 2) return els;

  const clase = new Map(els.filter(e => e.t === 'equip').map(e => [claveDe(e), e.k]));
  const alimentadoPorMedidor = new Set();
  const alimentadoPorPoste = new Set();
  const conFibra = new Set();
  for (const c of els){
    if (c.t !== 'cable') continue;
    if (c.k === 'fibra'){
      for (const p of [c.a, c.b]) if (p) conFibra.add(puntaDe(p));
    }
  }

  for (const c of els){
    if (c.t !== 'cable' || c.k !== 'acom') continue;
    const ra = puntaDe(c.a), rb = puntaDe(c.b);
    const ka = clase.get(ra), kb = clase.get(rb);
    if (ka === 'TDG' && kb === 'MEDIDOR') alimentadoPorMedidor.add(ra);
    if (kb === 'TDG' && ka === 'MEDIDOR') alimentadoPorMedidor.add(rb);
    if (ka === 'TDG' && kb === 'POSTE' && !conFibra.has(rb)) alimentadoPorPoste.add(ra);
    if (kb === 'TDG' && ka === 'POSTE' && !conFibra.has(ra)) alimentadoPorPoste.add(rb);
  }

  let elegido = null;
  if (alimentadoPorMedidor.size === 1){
    elegido = tdgs.find(t => alimentadoPorMedidor.has(claveDe(t)));
  } else {
    const conAcom = tdgs.filter(t => alimentadoPorMedidor.has(claveDe(t)) || alimentadoPorPoste.has(claveDe(t)));
    if (conAcom.length === 1) elegido = conAcom[0];
  }

  if (!elegido){
    elegido = tdgs.find(t => RX_EXISTENTE.test(String(t.label || ''))) || tdgs[0];
  }

  for (const t of tdgs){
    if (t === elegido) continue;
    t.k = 'TDS';
    const cal = calificadorDe(String(t.label || ''));
    t.label = cal ? `TDS ${cal}` : 'TDS';
  }
  return els;
}

/* ==========================================================================
   7. LAS COTAS VAN PEGADAS AL CUARTO QUE MIDEN
   ========================================================================== */

/* Aire entre el muro (o lo que cuelgue de él) y la línea de cota. */
const SEP_COTA = 46, BULTO = 46, MARGEN_HOJA = 18;

/* Hasta donde llega DE VERDAD un equipo hacia un lado, contando su rotulo.

   `BULTO` era un bulto: 46 unidades fijas medidas desde el CENTRO del icono.
   Alcanza para un simbolo chico y sin nombre, y falla en cuanto el rotulo es
   largo. Medido sobre un plano real: la cota vertical caia en x=1529 y el
   texto "SPT A INSTALAR" llegaba hasta x=1533 — la linea de cota partia el
   nombre al medio por cuatro unidades.

   Se replican las cuentas del editor (`bloqueEtiqueta`): el rotulo va
   CENTRADO en horizontal sobre el simbolo, y COLGANDO por debajo en vertical.
   Son estimaciones —el ancho real de una tipografia solo lo sabe el
   navegador—, pero son las mismas que ya usa el dibujo, asi que el error va
   para el mismo lado. */
const TEXTO_EQUIP = 13, INTERLINEA = 1.18;
const SALTO = String.fromCharCode(10), RETORNO = String.fromCharCode(13);
const rengloneS = txt => String(txt == null ? '' : txt).split(SALTO)
  .map(l => (l.endsWith(RETORNO) ? l.slice(0, -1) : l));
function bordeDe(e, eje){
  const ic = ICON_BY_KEY[e.k] || { w: 34, h: 34 };
  const esc = e.scale || 1;
  const anchoIc = ic.w * esc, altoIc = ic.h * esc;

  /* El simbolo. Igual que `aabbDe` en el editor: uno girado se mide por su
     diagonal en vez de rotar el rectangulo de verdad. Sobre-estima, y eso
     es justo lo que se quiere para dejar aire. */
  const diag = Math.hypot(anchoIc, altoIc);
  const medioIc = (e.rot ? diag : (eje === 'x' ? anchoIc : altoIc)) / 2;
  let borde = (eje === 'x' ? e.x : e.y) + medioIc;

  const ts = (isFinite(parseFloat(e.size)) && parseFloat(e.size) > 0)
    ? parseFloat(e.size) : TEXTO_EQUIP;
  const lineas = (e.label ? rengloneS(e.label) : []).concat(e.sub ? rengloneS(e.sub) : []);
  if (!lineas.length) return borde;
  const anchoTxt = Math.max(...lineas.map(l => l.length)) * ts * 0.62 + 10;
  const altoTxt  = lineas.length * ts * INTERLINEA + 6;

  /* Y el rotulo, con la MISMA cuenta que `bloqueEtiqueta`: cuelga a 18
     unidades por debajo del simbolo... en el sistema de coordenadas del
     simbolo. En uno girado un cuarto de vuelta eso lo manda al COSTADO, que
     es lo que hacia fallar la version anterior de esto: medido sobre el SPT
     girado 270 grados, el texto arrancaba 35 unidades mas a la derecha de lo
     que decia la cuenta sin rotar, y ahi se le venia la cota encima. */
  const rad = (e.rot || 0) * Math.PI / 180;
  const ly = altoIc / 2 + 18;
  const anclaX = e.x - ly * Math.sin(rad);
  const anclaY = e.y + ly * Math.cos(rad);
  /* El bloque de texto no rota con el simbolo: nace en el ancla, centrado en
     horizontal y creciendo hacia abajo. */
  const bordeTxt = eje === 'x' ? anclaX + anchoTxt / 2 : anclaY + altoTxt;
  return Math.max(borde, bordeTxt);
}
/* Con cuánta tolerancia se considera que una cota YA mide ese lado. */
const TOL_COTA = 0.18;

const solape1D = (a1, a2, b1, b2) => {
  const minA = Math.min(a1, a2), maxA = Math.max(a1, a2);
  const minB = Math.min(b1, b2), maxB = Math.max(b1, b2);
  return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
};

/** Se asegura de que el cuarto principal tenga sus dos cotas, ancho y alto, y
    que cada una vaya EXACTAMENTE de punta a punta del muro que mide.
 *
 *  Alineadas no es un detalle estético: una cota corrida respecto del muro se
 *  lee como si midiera otra cosa, y encima es de donde el editor deduce la
 *  escala de todo el plano. Si el modelo ya leyó una medida real que cubre ese
 *  lado, esa manda y no se agrega nada — solo se la endereza. */
function cotasAlineadas(els, cuartos, equipos){
  if (!cuartos.length) return els;
  const room = cuartos.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  const x1 = room.x - room.w/2, x2 = room.x + room.w/2;
  const y1 = room.y - room.h/2, y2 = room.y + room.h/2;

  const dims = els.filter(e => e.t === 'dim' && e.a && e.b);
  const cerca = (v, ref) => Math.abs(v - ref) <= ref * TOL_COTA;

  /* Candidatas que cubren el ancho (horizontal) o el alto (vertical).
     Se busca por largo aproximado O por solape longitudinal (>= 60% del lado),
     para no rechazar cotas leídas con leve desfase del modelo.
     Se prioriza una cota con medida real frente a '? m'. */
  const candsH = dims.filter(d => Math.abs(d.a.y - d.b.y) < 24 &&
    (cerca(Math.abs(d.b.x - d.a.x), room.w) || solape1D(d.a.x, d.b.x, x1, x2) >= room.w * 0.60))
    .sort((a, b) => {
      const realA = a.label && a.label !== SIN_MEDIDA ? 1 : 0;
      const realB = b.label && b.label !== SIN_MEDIDA ? 1 : 0;
      if (realA !== realB) return realB - realA;
      return solape1D(b.a.x, b.b.x, x1, x2) - solape1D(a.a.x, a.b.x, x1, x2);
    });

  const candsV = dims.filter(d => Math.abs(d.a.x - d.b.x) < 24 &&
    (cerca(Math.abs(d.b.y - d.a.y), room.h) || solape1D(d.a.y, d.b.y, y1, y2) >= room.h * 0.60))
    .sort((a, b) => {
      const realA = a.label && a.label !== SIN_MEDIDA ? 1 : 0;
      const realB = b.label && b.label !== SIN_MEDIDA ? 1 : 0;
      if (realA !== realB) return realB - realA;
      return solape1D(b.a.y, b.b.y, y1, y2) - solape1D(a.a.y, a.b.y, y1, y2);
    });

  const horizontal = candsH[0];
  const vertical   = candsV[0];

  /* Si encontramos una cota candidata, cualquier otra cota redundante en ese eje
     (especialmente '? m' huérfana) se limpia para no duplicar. */
  if (horizontal && candsH.length > 1){
    const sobrasH = new Set(candsH.slice(1).map(claveDe));
    els = els.filter(e => !sobrasH.has(claveDe(e)));
  }
  if (vertical && candsV.length > 1){
    const sobrasV = new Set(candsV.slice(1).map(claveDe));
    els = els.filter(e => !sobrasV.has(claveDe(e)));
  }

  /* Hasta dónde llega lo que cuelga de cada lado, para no cruzarle la cota. */
  const masAlla = (eje, limite, dentro) => {
    let m = limite;
    for (const e of (equipos || [])){
      if (!dentro(e)) continue;
      /* El borde ya incluye el rotulo; BULTO queda solo como aire. */
      const v = bordeDe(e, eje);
      if (v > limite) m = Math.max(m, v + BULTO);
    }
    return m;
  };
  const enX = e => e.x > x1 - 120 && e.x < x2 + 120;
  const enY = e => e.y > y1 - 120 && e.y < y2 + 120;
  const abajo   = Math.round(acotar(masAlla('y', y2, enX) + SEP_COTA, MARGEN_HOJA, CH - MARGEN_HOJA));
  const derecha = Math.round(acotar(masAlla('x', x2, enY) + SEP_COTA, MARGEN_HOJA, CW - MARGEN_HOJA));
  const cx = n => Math.round(acotar(n, MARGEN_HOJA, CW - MARGEN_HOJA));
  const cy = n => Math.round(acotar(n, MARGEN_HOJA, CH - MARGEN_HOJA));

  if (horizontal){
    /* Se la endereza contra el muro sin tocarle el número. */
    horizontal.a = { x: cx(x1), y: abajo };
    horizontal.b = { x: cx(x2), y: abajo };
  } else {
    els.push({ t:'dim', label: SIN_MEDIDA,
               a:{ x: cx(x1), y: abajo }, b:{ x: cx(x2), y: abajo } });
  }
  if (vertical){
    vertical.a = { x: derecha, y: cy(y1) };
    vertical.b = { x: derecha, y: cy(y2) };
    vertical.textRot = -90;
  } else {
    els.push({ t:'dim', label: SIN_MEDIDA, textRot: -90,
               a:{ x: derecha, y: cy(y1) }, b:{ x: derecha, y: cy(y2) } });
  }
  return els;
}

/* El número en blanco: la cota se dibuja, el metro lo pone quien fue a medir.
   Ver la nota larga en acomodar.js sobre por qué no se inventa la medida. */
const SIN_MEDIDA = '? m';


/* ==========================================================================
   9. CABLES QUE LA AUTO-CONEXIÓN INVENTA Y LA OBRA NO TIENE
   ========================================================================== */

/** Saca los tres cables que LINKS crea por su cuenta y que en estos planos no
 *  existen. No es que estén 'de más' estéticamente: cada uno afirma algo falso
 *  sobre la instalación.
 *
 *  · TABLERO ↔ POSTE cuando hay MEDIDOR: la acometida entra por el medidor.
 *    Un tablero colgado directo del poste dice que no hay medición.
 *  · TABLERO ↔ POSTE DE FIBRA: por ese poste baja la óptica, no la energía.
 *  · RACK ↔ TABLERO sin rótulo ni codos: es el que inventa la regla, no uno
 *    que alguien haya trazado. Si trae rótulo o quiebres, lo dibujó una
 *    persona y se respeta.
 *  · La segunda bajante al nodo: va una sola, por el poste que lleva fibra.
 *
 *  Tiene que correr DOS veces —antes y después de autoConectar— y ese es el
 *  punto. Corriéndolo solo antes se limpia lo que leyó el modelo y después la
 *  auto-conexión los vuelve a poner exactamente iguales. MEDIDO: el plano
 *  reordenado daba 100% de parecido y el recién interpretado 92%, y la
 *  diferencia eran estos mismos tres cables. */
function depurarCablesEspurios(els){
  const claseDe = id => { const e = els.find(g => claveDe(g) === id); return e ? e.k : null; };
  const conFibra = new Set();
  for (const c of els){
    if (c.t !== 'cable' || c.k !== 'fibra') continue;
    const ra = puntaDe(c.a), rb = puntaDe(c.b);
    if (ra !== undefined && rb !== undefined){ conFibra.add(ra); conFibra.add(rb); }
  }
  const hayMedidor = els.some(e => e.t === 'equip' && e.k === 'MEDIDOR');
  const postes = els.filter(e => e.t === 'equip' && e.k === 'POSTE');

  return els.filter(c => {
    if (c.t !== 'cable') return true;
    const ra = puntaDe(c.a), rb = puntaDe(c.b);
    const ka = claseDe(ra), kb = claseDe(rb);

    if (c.k === 'acom'){
      const idPoste = ka === 'POSTE' ? ra : (kb === 'POSTE' ? rb : null);
      if (idPoste != null && (TABLEROS.has(ka) || TABLEROS.has(kb))){
        if (hayMedidor || conFibra.has(idPoste)) return false;
      }
      const idRack = ka === 'RACK' ? ra : (kb === 'RACK' ? rb : null);
      if (idRack != null && (TABLEROS.has(ka) || TABLEROS.has(kb)) &&
          !c.label && (!c.w || !c.w.length)) return false;
    }

    /* Bajante al nodo: termina en punta libre. Solo la lleva el poste con
       fibra; el eléctrico no tiene por qué apuntar al nodo de la operadora. */
    if (c.k === 'fibra' && (ra === undefined || rb === undefined)){
      const idPoste = ra !== undefined ? ra : rb;
      if (idPoste != null && postes.length > 1 && !conFibra.has(idPoste)) return false;
    }
    return true;
  });
}

module.exports = {
  unSoloSplitter, soloCablesAnclados, unSoloTDG, normalizarTomas, sinCablesEnTomas,
  depurarCablesEspurios,
  tierraSoloATablero, orientarAPs, mitadHacia, asegurarPuerta, cotasAlineadas, bordeDe,
  TOMA_CANONICA, TOMAS, TABLEROS, TIERRAS, RUMBO, SIN_MEDIDA, claveDe, puntaDe,
  calificadorDe, RX_INSTALAR, RX_EXISTENTE
};
