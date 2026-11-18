'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const CARPETA = path.join(RAIZ, 'planos como quedan');

const leer = f => JSON.parse(fs.readFileSync(path.join(CARPETA, f), 'utf8')).els || [];

const conexiones = els => {
  const porId = Object.fromEntries(els.map(e => [e.id || e.ref, e]));
  const clase = p => {
    const id = p && (p.id || p.ref);
    return (id && porId[id]) ? porId[id].k : 'LIBRE';
  };
  return els.filter(e => e.t === 'cable')
    .map(c => c.k + ':' + [clase(c.a), clase(c.b)].sort().join('-'))
    .sort();
};

const cuenta = arr => {
  const m = {};
  for (const x of arr) m[x] = (m[x] || 0) + 1;
  return m;
};

function comunes(a, b){
  const ca = cuenta(a), cb = cuenta(b);
  let n = 0;
  for (const k of Object.keys(ca)) n += Math.min(ca[k], cb[k] || 0);
  return n;
}

function diferencias(a, b){
  const ca = cuenta(a), cb = cuenta(b), fuera = [];
  for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])){
    const d = (cb[k] || 0) - (ca[k] || 0);
    if (d > 0) fuera.push('SOBRA  ' + d + '× ' + k);
    if (d < 0) fuera.push('FALTA  ' + (-d) + '× ' + k);
  }
  return fuera.sort();
}

function comparar(objetivo, candidato, titulo){
  const eqO = objetivo.filter(e => e.t === 'equip').map(e => e.k);
  const eqC = candidato.filter(e => e.t === 'equip').map(e => e.k);
  const cxO = conexiones(objetivo), cxC = conexiones(candidato);
  const dimO = objetivo.filter(e => e.t === 'dim');
  const dimC = candidato.filter(e => e.t === 'dim');

  const pEquipos = comunes(eqO, eqC) / Math.max(1, Math.max(eqO.length, eqC.length));
  const pCables  = comunes(cxO, cxC) / Math.max(1, Math.max(cxO.length, cxC.length));
  const pCotas   = Math.min(dimO.length, dimC.length) / Math.max(1, Math.max(dimO.length, dimC.length));
  const total    = (pEquipos * 0.35 + pCables * 0.5 + pCotas * 0.15);

  console.log('════ ' + titulo + ' ════');
  console.log('  equipos  ' + (pEquipos * 100).toFixed(0).padStart(3) + '%   (' + eqC.length + ' vs ' + eqO.length + ' del objetivo)');
  for (const d of diferencias(eqO, eqC)) console.log('           ' + d);
  console.log('  cables   ' + (pCables * 100).toFixed(0).padStart(3) + '%   (' + cxC.length + ' vs ' + cxO.length + ')');
  for (const d of diferencias(cxO, cxC)) console.log('           ' + d);
  console.log('  cotas    ' + (pCotas * 100).toFixed(0).padStart(3) + '%   (' + dimC.length + ' vs ' + dimO.length + ')  ' +
    JSON.stringify(dimC.map(d => d.label)));
  console.log('  ──────────────────────────');
  console.log('  PARECIDO ' + (total * 100).toFixed(0).padStart(3) + '%');
  console.log();
  return { total, pEquipos, pCables, pCotas };
}

const objetivo = leer('PLANO HECHO POR MI.json');
const tal_cual = leer('PLANO INTERPRETADO.json');

comparar(objetivo, tal_cual, 'TAL COMO QUEDÓ (hoy, ya guardado)');

const { ordenarPlano } = require('./lib/revisar.js');
const reordenado = ordenarPlano(JSON.parse(JSON.stringify(tal_cual))).els;
comparar(objetivo, reordenado, 'DESPUÉS DE PASARLO POR LA HEURÍSTICA DE HOY');
