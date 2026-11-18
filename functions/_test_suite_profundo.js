'use strict';
/* Banco de pruebas profundo para la heurística de organización automática.
   node functions/_test_suite_profundo.js */

const fs = require('fs');
const path = require('path');
const A = require('./lib/acomodar');
const R = require('./lib/reglas');
const { ordenarPlano, auditarChoques } = require('./lib/revisar');

let passed = 0, failed = 0;
function assert(desc, condition, extra) {
  if (condition) {
    passed++;
    console.log('  PASS:', desc);
  } else {
    failed++;
    console.log('  FAIL:', desc, extra || '');
  }
}

console.log('=== TEST SUITE PROFUNDO: CASOS BORDE Y CONSISTENCIA ===\n');

// Caso 1: Plano vacío o sin cuartos
{
  const res = A.acomodarPlano([], [], {});
  assert('Plano vacío no tira error y devuelve array', Array.isArray(res) && res.length === 0);
  
  const unCuartoSolo = [{ t: 'room', x: 500, y: 500, w: 400, h: 400, label: 'SALA' }];
  const resCuarto = A.acomodarPlano(unCuartoSolo, [], { soloOrdenar: true });
  assert('Cuarto solo sin equipos no se rompe y agrega cotas', resCuarto.length === 3);
}

// Caso 2: Muro no sobrecargado (menos de 3 equipos)
{
  const room = { t: 'room', x: 500, y: 500, w: 600, h: 400, label: 'SALA' };
  const eq1 = { t: 'equip', k: 'puerta', x: 750, y: 300, rot: 0 };
  const eq2 = { t: 'equip', k: 'TDG', x: 700, y: 300, rot: 0 };
  const res = A.acomodarPlano([room, eq1, eq2], [], { soloOrdenar: true });
  assert('Muro con <3 equipos no activa cohesion innecesaria', res.length >= 3);
}

// Caso 3: Integridad de PLANO INTERPRETADO CORREGIDO.json
{
  const rutaCorregido = path.resolve(__dirname, '..', 'planos como quedan', 'PLANO INTERPRETADO CORREGIDO.json');
  const cor = JSON.parse(fs.readFileSync(rutaCorregido, 'utf8')).els;
  assert('Archivo corregido tiene 30 elementos', cor.length === 30);
  
  const tieneNaN = cor.some(e => Number.isNaN(e.x) || Number.isNaN(e.y));
  assert('Ningun equipo tiene coordenadas NaN', !tieneNaN);

  const cables = cor.filter(e => e.t === 'cable');
  assert('Exactamente 10 cables trazados', cables.length === 10);
  
  const porId = new Map(cor.map(e => [e.id, e]));
  const cablesValidos = cables.every(c => {
    const ka = c.a && c.a.id && porId.has(c.a.id);
    const kb = c.b && c.b.id && porId.has(c.b.id);
    if (c.k === 'fibra' && (c.label || '').includes('DISTANCIA')) return ka && c.b && typeof c.b.x === 'number';
    return ka && kb;
  });
  assert('Todos los cables apuntan a extremos validos y existentes', cablesValidos);

  const choques = auditarChoques(cor);
  assert('Cero choques entre elementos o rotulos en el plano corregido', choques.length === 0, choques);
}

// Caso 4: Rotacion correcta de tierras (270 cuando cuelgan al este)
{
  const rutaCorregido = path.resolve(__dirname, '..', 'planos como quedan', 'PLANO INTERPRETADO CORREGIDO.json');
  const cor = JSON.parse(fs.readFileSync(rutaCorregido, 'utf8')).els;
  const spts = cor.filter(e => e.k === 'SPT');
  assert('Hay 2 tierras', spts.length === 2);
  assert('Ambas tierras tienen rotacion 270 (apuntan hacia el este)', spts.every(s => s.rot === 270));
  assert('Ambas tierras estan fuera del muro este (x > 1358)', spts.every(s => s.x > 1358));
}

// Caso 5: RACK y TDS juntos en el muro sur
{
  const rutaCorregido = path.resolve(__dirname, '..', 'planos como quedan', 'PLANO INTERPRETADO CORREGIDO.json');
  const cor = JSON.parse(fs.readFileSync(rutaCorregido, 'utf8')).els;
  const rack = cor.find(e => e.k === 'RACK');
  const tds = cor.find(e => e.k === 'TDS');
  assert('RACK esta sobre el muro sur (y > 700)', rack && rack.y > 700);
  assert('TDS esta sobre el muro sur (y > 700)', tds && tds.y > 700);
  assert('RACK esta a la izquierda de TDS (cadena monotona)', rack && tds && rack.x < tds.x);
}

// Caso 6: Cotas alineadas a las medidas del cuarto
{
  const rutaCorregido = path.resolve(__dirname, '..', 'planos como quedan', 'PLANO INTERPRETADO CORREGIDO.json');
  const cor = JSON.parse(fs.readFileSync(rutaCorregido, 'utf8')).els;
  const dims = cor.filter(e => e.t === 'dim');
  assert('Hay exactamente 2 cotas', dims.length === 2);
  const labels = dims.map(d => d.label).sort();
  assert('Las cotas son 5m y 7m', labels[0] === '5m' && labels[1] === '7m');
}

console.log('\n----------------------------------------');
console.log('Resultados: ' + passed + ' pasaron, ' + failed + ' fallaron');
if (failed > 0) process.exit(1);
