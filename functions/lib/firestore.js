'use strict';
/* --------------------------------------------------------------------------
   Acceso a Firestore para el servidor MCP. Usa el Admin SDK (credenciales
   propias de la Cloud Function, no la config pública del cliente) y por lo
   tanto NO pasa por las reglas de seguridad — igual que cualquier backend de
   confianza. Cada escritura se identifica como "mcp" en el mismo campo `by`
   que ya usan las pestañas del navegador para no reaplicarse su propio eco;
   el servidor MCP nunca vuelve a leer sus propias escrituras, así que ese
   campo solo importa para que los colaboradores humanos vean quién editó
   ("Plano actualizado por IA (MCP)"), reusando el toast que ya existe.
   -------------------------------------------------------------------------- */
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const COLLECTION = 'planos';
const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sin 0/O/1/I/L: mismo alfabeto que la app
const ROOM_CODE_LEN = 4;
const ROOM_CREATE_RETRIES = 5;

function db() { return getFirestore(); }
function roomRef(codigo) { return db().collection(COLLECTION).doc(String(codigo).toUpperCase()); }

function genCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  return s;
}

class SalaNoEncontrada extends Error {
  constructor(codigo) { super(`No existe una sala con el código "${codigo}". Creala primero con crear_sala.`); this.codigo = codigo; }
}
class ElementoNoEncontrado extends Error {
  constructor(id) { super(`No hay ningún elemento con id "${id}" en el plano.`); this.id = id; }
}

const DEFAULT_HEADER = {
  asignatario: 'BlueCode', codigo: '', resolucion: '',
  departamento: '', municipio: '', centro: '', sede: '', dane: '',
  formato: 'BC-PL-001', fecha: '', version: '1.0'
};

/** Crea una sala nueva con un código único (mismo esquema que la app: 4
    caracteres, reintenta si por casualidad ya existe uno igual). */
async function crearSala({ nombreSede } = {}) {
  for (let i = 0; i < ROOM_CREATE_RETRIES; i++) {
    const codigo = genCode();
    const ref = roomRef(codigo);
    try {
      await db().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) throw new Error('COLLISION');
        const header = { ...DEFAULT_HEADER };
        if (nombreSede) header.sede = nombreSede;
        tx.set(ref, {
          by: 'mcp', byName: 'IA (MCP)', updatedAt: FieldValue.serverTimestamp(),
          header, els: [], seq: 1
        });
      });
      return codigo;
    } catch (err) {
      if (err.message === 'COLLISION') continue;
      throw err;
    }
  }
  throw new Error('No se pudo generar un código de sala único tras varios intentos.');
}

/** ¿Existe esta sala? Solo el sí/no, sin traerse el plano entero.
    El `fieldMask` vacío es el punto: un `.get()` normal descarga TODO el
    documento —`els` incluido, que en un plano cargado son cientos de KB— y
    acá lo único que se necesita es saber si el código es real. Se usa como
    portero de /interpretar, así que corre antes de CADA interpretación: que
    no arrastre el plano entero es la diferencia entre agregar unos ms y
    agregar medio segundo. */
async function existeSala(codigo){
  if (typeof codigo !== 'string' || codigo.length !== ROOM_CODE_LEN) return false;
  const [snap] = await db().getAll(roomRef(codigo), { fieldMask: [] });
  return snap.exists;
}

/** Lee el estado completo de una sala. Lanza SalaNoEncontrada si no existe. */
async function leerSala(codigo) {
  const snap = await roomRef(codigo).get();
  if (!snap.exists) throw new SalaNoEncontrada(codigo);
  const data = snap.data();
  return { codigo: String(codigo).toUpperCase(), header: data.header || {}, els: Array.isArray(data.els) ? data.els : [], seq: data.seq || 1 };
}

/** Aplica una función de mutación sobre `els`/`seq` dentro de una transacción,
    para que dos llamadas concurrentes (o un humano editando a la vez) no se
    pisen — la misma garantía que ya tiene cualquier escritura de Firestore,
    llevada al array completo en vez de a campos sueltos. `mutar(els, seq)`
    debe devolver `{ els, seq, resultado }`; lo que devuelva en `resultado`
    vuelve tal cual como retorno de esta función. */
async function mutarSala(codigo, mutar) {
  const ref = roomRef(codigo);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new SalaNoEncontrada(codigo);
    const data = snap.data();
    const els = Array.isArray(data.els) ? data.els : [];
    const seq = data.seq || 1;
    const { els: nuevosEls, seq: nuevoSeq, resultado } = mutar(els, seq);
    tx.update(ref, {
      by: 'mcp', byName: 'IA (MCP)', updatedAt: FieldValue.serverTimestamp(),
      els: nuevosEls, seq: nuevoSeq
    });
    return resultado;
  });
}

async function establecerMembrete(codigo, campos) {
  const ref = roomRef(codigo);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new SalaNoEncontrada(codigo);
    const header = { ...(snap.data().header || {}), ...campos };
    tx.update(ref, { by: 'mcp', byName: 'IA (MCP)', updatedAt: FieldValue.serverTimestamp(), header });
    return header;
  });
}

module.exports = { crearSala, leerSala, mutarSala, establecerMembrete, existeSala, SalaNoEncontrada, ElementoNoEncontrado, roomRef, genCode };
