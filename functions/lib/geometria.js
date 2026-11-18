'use strict';
/* --------------------------------------------------------------------------
   Geometría del lienzo, replicada del cliente (bboxOf/elBounds en
   plano-instalacion-v8.html) para que la IA pueda razonar sobre posiciones
   y colisiones SIN tener que abrir la app — mismas unidades, mismos
   criterios de tamaño por tipo de elemento.
   -------------------------------------------------------------------------- */
const { ICONS } = require('./catalog');
const ICON_BY_KEY = Object.fromEntries(ICONS.map(i => [i.k, i]));

const CW = 2200, CH = 1000; // lienzo lógico de la app (ver const CW/CH en el cliente)

/** Resuelve un extremo de cable/cota: si ancla a un id, la posición de ese
    elemento; si no, el punto libre tal cual. */
function resolverPunto(els, ref) {
  if (ref && typeof ref === 'object' && 'id' in ref) {
    const el = els.find(e => e.id === ref.id);
    return el ? { x: el.x, y: el.y } : null;
  }
  return ref && typeof ref.x === 'number' ? { x: ref.x, y: ref.y } : null;
}

/** Caja delimitadora (centrada en x,y) de un elemento ya puesto — mismo
    criterio que bboxOf() del cliente. Cables/cotas no tienen una caja fija
    (son una línea), así que se devuelve el recuadro que envuelve su
    recorrido en su lugar; sirve como aproximación para chequear colisiones. */
function cajaDe(el, els) {
  if (el.t === 'room') return { ancho: el.w, alto: el.h };
  if (el.t === 'equip') {
    const icon = ICON_BY_KEY[el.k];
    const escala = (typeof el.scale === 'number' && el.scale > 0) ? el.scale : 1;
    return icon ? { ancho: icon.w * escala, alto: icon.h * escala } : { ancho: 34, alto: 34 };
  }
  if (el.t === 'text') return { ancho: (el.label || '').length * 6 + 10, alto: 18 };
  if (el.t === 'cable' || el.t === 'dim') {
    const a = resolverPunto(els, el.a), b = resolverPunto(els, el.b);
    const pts = [a, b, ...(el.w || [])].filter(Boolean);
    if (!pts.length) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { ancho: Math.max(1, Math.max(...xs) - Math.min(...xs)), alto: Math.max(1, Math.max(...ys) - Math.min(...ys)),
             centro: { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 } };
  }
  return null;
}

/** Centro real de un elemento (para cables/cotas usa el centro de su caja,
    ya que ellos no tienen x,y propio). */
function centroDe(el, els) {
  if (typeof el.x === 'number' && typeof el.y === 'number') return { x: el.x, y: el.y };
  const caja = cajaDe(el, els);
  return (caja && caja.centro) ? caja.centro : null;
}

/** ¿Se superponen dos cajas (AABB) centradas en cx,cy con ancho/alto w,h? */
function seSuperponen(a, b) {
  return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2;
}

module.exports = { CW, CH, resolverPunto, cajaDe, centroDe, seSuperponen, ICON_BY_KEY };
