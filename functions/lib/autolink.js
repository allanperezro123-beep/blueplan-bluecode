'use strict';
/* --------------------------------------------------------------------------
   Réplica exacta de la auto-conexión del cliente (autoLink/tryLink/
   betterTarget/LINKS en plano-instalacion-v8.html), para que agregar un
   equipo por MCP se comporte igual que soltarlo en el lienzo con
   auto-conexión activa: SPT→TDG, toma→tablero, AP→RACK, etc. — sin esto,
   la IA tendría que enterarse de memoria de cada regla y trazar cada cable
   a mano, mucho más lento y con más lugar para el error.
   -------------------------------------------------------------------------- */
const LINKS = [
  { from: ['NAP'], to: ['POSTE'], k: 'fibra', out: 1, in: 4 },
  { from: ['PTO'], to: ['NAP'], k: 'fibra', out: 1, in: 8 },
  { from: ['ONT'], to: ['PTO', 'NAP'], k: 'fibra', out: 1, in: 1 },
  { from: ['RACK'], to: ['ONT'], k: 'utp', out: 1, in: 2 },
  { from: ['AP1', 'AP2'], to: ['RACK', 'ONT'], k: 'utp', out: 1, in: 12 },
  { from: ['PC', 'IMP'], to: ['RACK', 'ONT'], k: 'utp', out: 1, in: 12 },
  { from: ['SPT', 'TIERRA_RETIE', 'TIERRA_PROTECCION', 'TIERRA_AISLADA', 'MASA', 'CONDUCTOR_SPT'], to: ['TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE'], k: 'spt', out: 1, in: 4 },
  { from: ['RACK', 'SW_TERMOMAGNETICO', 'SW_DIFERENCIAL', 'DPS_PROTECCION', 'DPS_VARISTOR', 'DESCARGADOR_SOBRETENSION'], to: ['SPT', 'TIERRA_RETIE', 'TIERRA_PROTECCION'], k: 'spt', out: 1, in: 4 },
  { from: ['MEDIDOR'], to: ['POSTE'], k: 'acom', out: 1, in: 3 },
  { from: ['TDG', 'TABLERO_GENERAL_RETIE'], to: ['MEDIDOR', 'POSTE'], k: 'acom', out: 1, in: 1 },
  { from: ['TDS', 'TABLERO_DISTRIBUCION_RETIE'], to: ['TDG', 'TABLERO_GENERAL_RETIE'], k: 'acom', out: 1, in: 4 },
  { from: ['UPS'], to: ['TDS', 'TDG', 'TABLERO_DISTRIBUCION_RETIE'], k: 'acom', out: 1, in: 6 },
  { from: ['TOMA', 'TOMAREG', 'TOMA_GENERAL', 'TOMA_PISO', 'TOMA_MONOFASICO', 'TOMA_TRIFASICO'], to: ['UPS', 'TDS', 'TDG', 'TABLERO_DISTRIBUCION_RETIE'], k: 'acom', out: 1, in: 8 },
  { from: ['SW_GENERAL', 'SW_BIPOLAR', 'SW_PILOTO', 'SW_RETARDO', 'SW_UNIPOLAR_2VIAS', 'SW_CONMUTADOR_UNIPOLAR', 'SW_SECCIONADOR_AT', 'SW_TERMOMAGNETICO', 'SW_DIFERENCIAL', 'SW_AIRE'], to: ['TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE'], k: 'acom', out: 1, in: 10 },
  { from: ['DPS_PROTECCION', 'DPS_VARISTOR', 'DESCARGADOR_SOBRETENSION', 'FUSIBLE', 'SECCIONADOR'], to: ['TDG', 'TDS', 'TABLERO_DISTRIBUCION_RETIE'], k: 'acom', out: 1, in: 8 },
  { from: ['TRANSF_GENERAL', 'TRANSF_AISLAMIENTO', 'TRANSF_SEGURIDAD'], to: ['POSTE', 'TDG'], k: 'acom', out: 1, in: 4 },
  { from: ['RACK'], to: ['TOMAREG', 'UPS', 'TOMA', 'TOMA_GENERAL'], k: 'acom', out: 1, in: 3 }
];

const kindOf = (els, ref) => { const el = ref && els.find(e => e.id === ref.id); return el ? el.k : undefined; };
const connected = (els, a, b) => els.some(c => c.t === 'cable' && ((c.a.id === a && c.b.id === b) || (c.a.id === b && c.b.id === a)));
const linksBetween = (els, el, kinds, k) => els.filter(c => c.t === 'cable' && c.k === k &&
  ((c.a.id === el.id && kinds.includes(kindOf(els, c.b))) || (c.b.id === el.id && kinds.includes(kindOf(els, c.a)))));
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function betterTarget(els, from, rule, kind) {
  for (const k of rule.to) {
    if (k === kind) return false;
    if (els.some(o => o.t === 'equip' && o.k === k && !connected(els, from.id, o.id) &&
      linksBetween(els, o, rule.from, rule.k).length < rule.in)) return true;
  }
  return false;
}

/** A diferencia del cliente (que empuja a S.els directamente), acá se
    APILAN los cables nuevos en `hechos` y recién se agregan al final —
    así el propio autoLink de la siguiente regla los ve como "ya conectado"
    sin tener que ir tocando el array compartido a mitad de iteración. */
function tryLink(els, from, rule, hechos, nombreDe, only) {
  const todos = els.concat(hechos);
  if (linksBetween(todos, from, rule.to, rule.k).length >= rule.out) return;
  for (const kind of rule.to) {
    const cand = todos
      .filter(o => o.t === 'equip' && o.k === kind && o.id !== from.id &&
        !connected(todos, from.id, o.id) && linksBetween(todos, o, rule.from, rule.k).length < rule.in)
      .sort((a, b) => dist2(a, from) - dist2(b, from))[0];
    if (!cand) continue;
    if (only && cand.id !== only.id) return;
    const cable = { id: null, t: 'cable', k: rule.k, a: { id: from.id }, b: { id: cand.id }, label: '', elbow: 'auto', w: [] };
    hechos.push(cable);
    nombreDe.push(`${lblOf(from)} → ${lblOf(cand)}`);
    return;
  }
}

const lblOf = el => el.label || el.k;

/** Corre las mismas reglas de auto-conexión que la app al soltar un símbolo
    con auto-conexión activa. `els` = elementos YA existentes (puede incluir
    los agregados antes en el mismo lote); `el` = el equipo recién puesto.
    Devuelve la lista de cables nuevos (sin id todavía — lo asigna quien
    llama, igual que el resto de los elementos de un lote). */
function autoLink(els, el) {
  if (!el || el.t !== 'equip') return [];
  const hechos = [], nombres = [];
  for (const rule of LINKS) {
    if (rule.from.includes(el.k)) tryLink(els, el, rule, hechos, nombres);
    if (rule.to.includes(el.k)) {
      for (const o of els.filter(o => o.t === 'equip' && rule.from.includes(o.k) && o.id !== el.id)) {
        if (hechos.length >= 6) break;
        if (betterTarget(els.concat(hechos), o, rule, el.k)) continue;
        tryLink(els, o, rule, hechos, nombres, el);
      }
    }
    if (hechos.length >= 6) break;
  }
  return { cables: hechos, resumen: nombres };
}

module.exports = { autoLink, LINKS };
