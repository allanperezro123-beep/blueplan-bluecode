'use strict';
/* Banco de pruebas de la heurística de acomodado.
   node functions/_check_acomodar.js
   No necesita Firebase: llama a la librería directo. */

const A = require('./lib/acomodar');
const { ICON_BY_KEY } = require('./lib/geometria');

let ok = 0, bad = 0;
const check = (n, p, d) => {
  if (p) { ok++; console.log(' OK   ' + n + (d ? '   (' + d + ')' : '')); }
  else { bad++; console.log(' FALLA ' + n + (d ? '   (' + d + ')' : '')); }
};

/* ---------- utilidades de medición ---------- */

const cuarto = (x, y, w, h, label) => ({ t: 'room', x, y, w, h, label });
let n = 0;
const eq = (k, x, y, label) => ({ t: 'equip', k, x, y, ref: 'r' + (n++),
                                  label: label || '', sub: '', rot: 0 });

/** Huella de un elemento con su rótulo, con el mismo criterio que usa la
    heurística para decidir si dos cosas chocan. */
function huella(e){
  const icono = (e.t === 'equip' && ICON_BY_KEY[e.k]) || { w: 0, h: 0 };
  const s = e.scale || 1;
  const size = e.size || (e.t === 'equip' ? 14 : 17);
  const renglones = String(e.label || '').split('\n');
  const masLargo = Math.max(0, ...renglones.map(r => r.length));
  let aTexto = e.label ? Math.min(200, Math.max(40, masLargo * size * 0.55)) : 0;
  let hTexto = e.label ? (e.t === 'equip' ? 18 : 0) + renglones.length * size * 1.25 : 0;
  if (e.textRot){ const t = aTexto; aTexto = hTexto; hTexto = t; }
  return { w: Math.max(icono.w * s, aTexto) + 8, h: icono.h * s + hTexto + 8 };
}

function choquesEntreElementos(els){
  const v = els.filter(e => e.t === 'equip' || e.t === 'text');
  let c = 0;
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++){
      const a = huella(v[i]), b = huella(v[j]);
      if (Math.abs(v[i].x - v[j].x) < (a.w + b.w) / 2 &&
          Math.abs(v[i].y - v[j].y) < (a.h + b.h) / 2) c++;
    }
  return c;
}

/** Cuántos elementos quedan atravesados por un cable que no es suyo. */
function choquesConCables(els){
  const porRef = new Map(els.filter(e => e.ref != null).map(e => [e.ref, e]));
  const porId  = new Map(els.filter(e => e.id != null).map(e => [e.id, e]));
  const punta = p => {
    if (!p) return null;
    const e = (p.ref != null && porRef.get(p.ref)) || (p.id != null && porId.get(p.id));
    if (e) return { x: e.x, y: e.y, el: e };
    return typeof p.x === 'number' ? { x: p.x, y: p.y, el: null } : null;
  };
  // distancia de un punto a un segmento
  const dps = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y;
    const L = vx * vx + vy * vy;
    if (!L) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  };
  let c = 0;
  const visibles = els.filter(e => e.t === 'equip' || e.t === 'text');
  for (const cab of els){
    if (cab.t !== 'cable') continue;
    const a = punta(cab.a), b = punta(cab.b);
    if (!a || !b) continue;
    /* El recorrido COMPLETO, quiebres incluidos: un cable ruteado ya no es la
       recta entre sus puntas, y medirlo como si lo fuera contaria choques que
       el rodeo justamente evita. */
    const medios = (Array.isArray(cab.w) ? cab.w : [])
      .filter(w => w && typeof w.x === 'number');
    const pts = [a, ...medios, b];
    for (const e of visibles){
      if (a.el === e || b.el === e) continue;      // su propia conexión no cuenta
      const hu = huella(e);
      const r = Math.min(hu.w, hu.h) / 2;
      let cerca = Infinity;
      for (let i = 0; i < pts.length - 1; i++)
        cerca = Math.min(cerca, dps(e, pts[i], pts[i + 1]));
      if (cerca < r) c++;
    }
  }
  return c;
}

/* ==========================================================================
   1. La regla de las tomas
   ========================================================================== */
console.log('--- la regla de las tomas ---');

{
  n = 0;
  const room = cuarto(400, 300, 500, 380, 'SALA DE SISTEMAS');
  const els = [room, eq('RACK', 300, 200), eq('TDG', 500, 200), eq('ONT', 400, 400)];
  const out = A.acomodarPlano(els, [], {});
  const tomas = out.filter(e => e.t === 'equip' && A.TOMAS.has(e.k));
  check('Un cuarto con 3 equipos recibe 3 tomas', tomas.length === 3,
        tomas.length + ' tomas');
  check('Las tomas salen chicas', tomas.every(t => (t.scale || 1) <= A.ESCALA_TOMA),
        'escalas: ' + tomas.map(t => t.scale || 1).join(', '));
  check('Y con letra chica', tomas.every(t => t.size === A.LETRA_TOMA),
        'letra ' + (tomas[0] || {}).size + ' px');
  // "bien ubicadas" = repartidas, no amontonadas
  let minD = Infinity;
  for (let i = 0; i < tomas.length; i++)
    for (let j = i + 1; j < tomas.length; j++)
      minD = Math.min(minD, Math.hypot(tomas[i].x - tomas[j].x, tomas[i].y - tomas[j].y));
  check('Repartidas, no amontonadas en una esquina', minD > 80,
        'la más cercana a otra: ' + Math.round(minD) + ' px');
}

{
  n = 0;
  const room = cuarto(400, 300, 500, 380, 'OFICINA');
  const els = [room, eq('RACK', 300, 200), eq('TDG', 500, 200)];
  const out = A.acomodarPlano(els, [], {});
  const tomas = out.filter(e => e.t === 'equip' && A.TOMAS.has(e.k));
  check('Con solo 2 equipos NO inventa tomas', tomas.length === 0,
        tomas.length + ' tomas');
}

{
  /* EL ERROR QUE SE ARREGLÓ: dos aparatos y una toma ya dibujada sumaban 3 y
     disparaban la regla, cuando aparatos hay dos. */
  n = 0;
  const room = cuarto(400, 300, 500, 380, 'DEPOSITO');
  const els = [room, eq('RACK', 300, 200), eq('TDG', 500, 200), eq('TOMA', 400, 450)];
  const out = A.acomodarPlano(els, [], {});
  const tomas = out.filter(e => e.t === 'equip' && A.TOMAS.has(e.k));
  check('Dos aparatos + una toma ya puesta no dispara la regla', tomas.length === 1,
        tomas.length + ' toma(s) — antes quedaban 3');
}

{
  n = 0;
  const room = cuarto(400, 300, 500, 380, 'AULA');
  const els = [room, eq('RACK', 300, 200), eq('TDG', 500, 200), eq('ONT', 400, 400),
               eq('TOMA', 250, 450)];
  const out = A.acomodarPlano(els, [], {});
  const tomas = out.filter(e => e.t === 'equip' && A.TOMAS.has(e.k));
  check('Tres aparatos + una toma completa hasta 3', tomas.length === 3,
        tomas.length + ' tomas');
}

/* ==========================================================================
   2. Nada encimado
   ========================================================================== */
console.log('\n--- que no quede nada encima de nada ---');

{
  n = 0;
  /* Todo apilado casi en el mismo punto: el peor caso honesto. */
  const room = cuarto(600, 400, 700, 500, 'SALA TECNICA');
  const els = [room,
    eq('RACK', 600, 400), eq('TDG', 606, 404), eq('TDS', 612, 408),
    eq('ONT', 618, 402), eq('AP1', 604, 412), eq('SPT', 610, 396),
    { t: 'text', x: 608, y: 406, label: 'TDS A INSTALAR', size: 17 },
    { t: 'text', x: 612, y: 410, label: 'VERIFICAR POLARIDAD', size: 17 }
  ];
  const antes = choquesEntreElementos(els);
  const out = A.acomodarPlano(els, [], {});
  const despues = choquesEntreElementos(out);
  check('Los elementos y sus rótulos quedan separados',
        despues === 0, 'choques: ' + antes + ' -> ' + despues);

  /* LIMITE CONOCIDO, y queda a la vista a proposito en vez de bajarle la vara
     al banco. Con ocho simbolos apilados dentro de 20 px no queda hueco: los
     equipos estan clavados a sus muros (no se pueden despegar sin mentir sobre
     el dibujo) y el rodeo del cable, lo corra para donde lo corra, cae sobre
     otro. El codigo elige el recorrido con menos cruces y se queda ahi, que es
     lo correcto; lo que no hay es una solucion con cero.
     El caso realista de mas abajo -que es el que se ve todos los dias- si
     cierra en cero. */
  const sobreCable = choquesConCables(out);
  check('Y nada queda atravesado por un cable ajeno',
        sobreCable === 0, 'elementos sobre un cable: ' + sobreCable +
        (sobreCable ? '  <- limite conocido: sin hueco posible en este apilado' : ''));
  console.log('      (' + out.filter(e => e.t === 'cable').length + ' cables trazados, ' +
              out.filter(e => e.t === 'equip').length + ' equipos)');
}

{
  /* Un plano REALISTA: dos cuartos, equipos repartidos como los deja una
     lectura del dibujo, no apilados en un punto. Es el caso que se ve todos
     los dias, y el que de verdad tiene que salir limpio. */
  n = 0;
  const sala = cuarto(500, 350, 520, 380, 'SALA DE SISTEMAS');
  const aula = cuarto(1200, 350, 480, 380, 'AULA 1');
  const els = [sala, aula,
    eq('RACK', 380, 250), eq('TDG', 700, 250), eq('ONT', 400, 480),
    eq('SPT', 620, 500), eq('AP1', 560, 200),
    eq('TDS', 1120, 250), eq('AP1', 1350, 200), eq('PC', 1300, 480),
    { t: 'text', x: 620, y: 380, label: 'VERIFICAR SPT', size: 17 }
  ];
  const out = A.acomodarPlano(els, [], {});
  check('Plano realista: nada encimado',
        choquesEntreElementos(out) === 0,
        'choques entre elementos: ' + choquesEntreElementos(out));
  check('Plano realista: nada sobre un cable ajeno',
        choquesConCables(out) === 0,
        'elementos sobre un cable: ' + choquesConCables(out));
  const tomas = out.filter(e => e.t === 'equip' && A.TOMAS.has(e.k));
  check('Plano realista: cada cuarto cargado recibe sus 3 tomas',
        tomas.length === 6, tomas.length + ' tomas en 2 cuartos');
}

{
  /* Sin el arreglo, este es el caso que fallaba: pocos equipos bien separados
     entre sí, pero un rótulo justo sobre la acometida. */
  n = 0;
  const room = cuarto(600, 400, 900, 500, 'CUARTO DE EQUIPOS');
  const rack = eq('RACK', 300, 300);
  const tdg  = eq('TDG', 900, 500);
  const els = [room, rack, tdg,
    { t: 'text', x: 600, y: 400, label: 'ACOMETIDA PRINCIPAL', size: 17 }];
  const out = A.acomodarPlano(els, [], {});
  check('Un texto que caía sobre la acometida se aparta',
        choquesConCables(out) === 0,
        'elementos sobre un cable: ' + choquesConCables(out));
}

/* ==========================================================================
   3. Que no se haya roto nada de lo que ya andaba
   ========================================================================== */
console.log('\n--- lo que ya funcionaba sigue funcionando ---');

{
  n = 0;
  const room = cuarto(500, 400, 600, 400, 'SALA');
  const els = [room, eq('RACK', 400, 300), eq('TDS', 500, 250), eq('TDG', 600, 250),
               eq('MEDIDOR', 700, 250)];
  const out = A.acomodarPlano(els, [], {});
  const eqs = out.filter(e => e.t === 'equip');
  check('Los nombres salen en vocabulario de obra',
        eqs.some(e => e.label === 'RACK') && eqs.some(e => e.label === 'TDG'),
        eqs.filter(e => !A.TOMAS.has(e.k)).map(e => e.label).join(', '));
  check('Se trazan las conexiones que la norma da por hechas',
        out.filter(e => e.t === 'cable').length > 0,
        out.filter(e => e.t === 'cable').length + ' cables');
  check('No quedan apuntes de trabajo en la salida',
        eqs.every(e => !('__eje' in e) && !('__lado' in e) && !('__agregada' in e)), '');
  check('Todo cae dentro del lienzo',
        eqs.every(e => e.x >= 0 && e.x <= 2200 && e.y >= 0 && e.y <= 1000), '');
}

console.log('\n-------------------------------------------');
console.log(ok + '/' + (ok + bad) + ' comprobaciones pasan');
process.exit(bad ? 1 : 0);
