'use strict';
/* ==========================================================================
   SERVIDOR MCP REMOTO — "Plano Instalación"
   Expone el editor de planos como un conjunto de herramientas MCP para que
   cualquier IA compatible (Claude, u otra) pueda leer y dibujar un plano
   completo: crear una sala, agregar equipos/cuartos/cables/texto/cotas,
   editarlos o borrarlos, y llenar el membrete — sin tocar el navegador.

   Arquitectura: esta función habla con el MISMO documento de Firestore
   (colección "planos") que ya sincroniza en tiempo real con cualquier
   pestaña abierta en la app — el MCP es, ni más ni menos, OTRO colaborador
   más. No hace falta ningún cambio en plano-instalacion-v8.html: en cuanto
   esta función escribe, el listener que ya existe ahí redibuja solo.

   Autenticación: NINGUNA (a propósito, coherente con la decisión ya tomada
   de que la app es de acceso público por link/código de sala). El código de
   sala de 4 caracteres es la única barrera — igual que en la app.
   ========================================================================== */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
admin.initializeApp();

/* API key de Gemini para /interpretar. Nunca vive en el código ni en el HTML
   público: se guarda con `firebase functions:secrets:set GEMINI_API_KEY`. */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

const { createMcpExpressApp } = require('@modelcontextprotocol/express');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { z } = require('zod');

const { ICONS, CATS, CABLES } = require('./lib/catalog');
const { CW, CH, cajaDe, centroDe, seSuperponen, resolverPunto } = require('./lib/geometria');
const { autoLink } = require('./lib/autolink');
const {
  crearSala, leerSala, mutarSala, establecerMembrete, existeSala,
  SalaNoEncontrada, ElementoNoEncontrado
} = require('./lib/firestore');
const { interpretarImagen } = require('./lib/interpretar');
const { revisarPlano, ordenarPlano } = require('./lib/revisar');

const APP_URL = 'https://blueplan-bluecode.web.app';
const ICON_BY_KEY = Object.fromEntries(ICONS.map(i => [i.k, i]));
const ICON_KEYS = ICONS.map(i => i.k);
const CABLE_KEYS = Object.keys(CABLES);
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const zColor = (desc) => z.string().regex(COLOR_RE, 'Color hexadecimal inválido, ej. #1d4ed8').optional().describe(desc);
const zSala = () => z.string().length(4).describe('Código de 4 caracteres de la sala (ver crear_sala / leer_plano)');
const zPuntoLibre = () => z.object({ x: z.number(), y: z.number() });
const zPunto = (desc) => z.union([
  z.object({ id: z.string().describe('Id de un elemento ya existente (ancla el extremo a ese equipo/cuarto)') }),
  zPuntoLibre().describe('Punto libre en unidades del lienzo (aprox. 0..2200 horizontal, 0..1000 vertical)')
]).describe(desc);

/* Se manda como `instructions` en la respuesta de initialize — a diferencia
   de MCP.md (que un humano tiene que copiar a mano), esto lo recibe
   AUTOMÁTICAMENTE cualquier cliente MCP antes de que el modelo empiece a
   llamar herramientas. Versión condensada de los algoritmos de MCP.md,
   pensada para que un modelo chico/rápido no tenga que razonar de más. */
const SERVER_INSTRUCTIONS = `Editor colaborativo de planos de instalación BluePlan (RETIE / Cableado Estructurado) por BlueCode. Reglas para usar estas herramientas rápido y sin errores:

REGLA DE ORO: si vas a crear/editar/borrar/mover 2+ elementos, usá SIEMPRE la versión "_lote" (agregar_elementos_lote, editar_elementos_lote, eliminar_elementos_lote) o mover_elementos. Nunca loopees agregar_equipo/agregar_cable/editar_elemento/eliminar_elemento para lo mismo.

RECREAR DESDE IMAGEN: 1) crear_sala (si hace falta). 2) listar_simbolos e info_lienzo UNA sola vez cada una, al principio. 3) Identificá primero cuartos/espacios grandes. 4) Armá TODO (cuartos+equipos+cables+textos) en UNA llamada a agregar_elementos_lote, usando "ref" para conectar cables a equipos del mismo lote. 5) Para conexiones "obvias" RETIE (SPT→tablero, AP→RACK, toma→tablero) dejá auto_conectar en true y NO agregues ese cable a mano (se duplica); para conexiones no estándar, poné auto_conectar:false en ese equipo y agregá el cable vos. 6) Al terminar, llamá resumen_plano (no leer_plano) para chequear equipos sin conexión. 7) Corregí desalineados con alinear_elementos/distribuir_elementos/mover_elementos sobre el grupo entero, no de a uno.

DESDE TEXTO: igual, pero ubicá x,y directo en unidades del lienzo (2200x1000) sin pasar por convertir_posicion.

CORREGIR PLANO EXISTENTE: resumen_plano primero (más barato) → buscar_elementos si necesitás algo puntual (más rápido que leer_plano) → herramientas de lote si tocás 2+ → leer_plano solo si necesitás cada campo de cada elemento.

OTRAS OPERACIONES: duplicar_elementos (Ctrl+D) para copiar con desplazamiento; agrupar_elementos/desagrupar_elementos para que varios elementos se muevan juntos; editar_elemento(_lote) también acepta "orden_z" (frente/fondo, cruza cualquier tipo de elemento) y "tipo_cable" (cambia fibra/utp/spt/acom de una conexión ya trazada).

NUNCA: loopear llamadas individuales pudiendo usar lote · llamar listar_simbolos/info_lienzo más de una vez · agregar a mano un cable que ya salió por auto-conexión (revisá el campo "autoconexion" de la respuesta) · usar leer_plano para un chequeo rápido.`;

const urlSala = sala => `${APP_URL}/?p=${sala}`;
const ok = (resultado, texto) => ({ content: [{ type: 'text', text: texto || JSON.stringify(resultado) }], structuredContent: resultado });
function errTool(err) {
  if (err instanceof SalaNoEncontrada || err instanceof ElementoNoEncontrado) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  return { content: [{ type: 'text', text: `Error inesperado: ${err.message}` }], isError: true };
}

/** Busca un elemento por id dentro de `els`; lanza ElementoNoEncontrado con
    la lista de ids disponibles si no está, para que la IA pueda corregirse. */
function ubicar(els, id) {
  const idx = els.findIndex(e => e.id === id);
  if (idx < 0) {
    const disponibles = els.map(e => `${e.id}(${e.t})`).join(', ') || '(el plano está vacío)';
    const e = new ElementoNoEncontrado(id);
    e.message += ` Ids disponibles: ${disponibles}.`;
    throw e;
  }
  return idx;
}

/** Valida que un extremo {id:...} de cable exista entre los elementos ya
    puestos; los puntos libres {x,y} no necesitan validación. */
function validarExtremo(els, ref, campo) {
  if (ref && typeof ref === 'object' && 'id' in ref) ubicar(els, ref.id);
}

function buildServer() {
  const server = new McpServer({ name: 'plano-instalacion', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool('listar_simbolos', {
    description: 'Lista TODOS los símbolos de equipo válidos (agrupados por categoría RETIE/comunicaciones) y los 4 tipos de cable. Llamalo primero, antes de agregar_equipo o agregar_cable, para saber qué valores de "simbolo"/"tipo_cable" existen — son exactamente los mismos símbolos de la paleta de la app, no se puede inventar uno nuevo.',
    inputSchema: z.object({})
  }, async () => {
    const porCategoria = {};
    for (const i of ICONS) {
      (porCategoria[i.cat] ||= { categoria: CATS[i.cat] || i.cat, simbolos: [] })
        .simbolos.push({ simbolo: i.k, nombre: i.name, ancho: i.w, alto: i.h });
    }
    const cables = Object.entries(CABLES).map(([k, c]) => ({ tipo_cable: k, nombre: c.name }));
    return ok({ categorias: Object.values(porCategoria), cables });
  });

  server.registerTool('crear_sala', {
    description: 'Crea un plano nuevo y vacío con un código de sala de 4 caracteres. Devolvé siempre el código y el link al usuario — puede abrirlo en el navegador y ver en vivo cada cambio que hagas después, como si fueras otro colaborador más.',
    inputSchema: z.object({
      nombre_sede: z.string().optional().describe('Nombre de la sede educativa, si ya se conoce (se guarda en el membrete)')
    })
  }, async ({ nombre_sede }) => {
    const sala = await crearSala({ nombreSede: nombre_sede });
    return ok({ sala, url: urlSala(sala) }, `Sala creada: ${sala}\nVerla en vivo: ${urlSala(sala)}`);
  });

  server.registerTool('leer_plano', {
    description: 'Lee el estado completo de un plano: membrete y todos los elementos, con su posición, ROTACIÓN y una "caja" (ancho/alto real ya calculado, según símbolo y escala) — todo lo necesario para razonar sobre el layout sin adivinar tamaños. Usalo antes de agregar o editar algo, y al final para revisar el resultado.',
    inputSchema: z.object({ sala: zSala() })
  }, async ({ sala }) => {
    try {
      const estado = await leerSala(sala);
      const els = estado.els.map(el => {
        const caja = cajaDe(el, estado.els);
        const centro = centroDe(el, estado.els);
        return { ...el, ...(caja ? { caja: { ancho: Math.round(caja.ancho), alto: Math.round(caja.alto) } } : {}), ...(centro && el.x === undefined ? { centro } : {}) };
      });
      const salida = { ...estado, els };
      return ok(salida, `Sala ${estado.codigo} — ${estado.els.length} elemento(s). Ver en vivo: ${urlSala(estado.codigo)}\n\n${JSON.stringify(salida, null, 2)}`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('info_lienzo', {
    description: 'Devuelve el tamaño real del lienzo (en las mismas unidades que usan x/y en todas las demás herramientas): ancho y alto totales, y un margen de borde recomendado. Llamalo antes de convertir_posicion o de ubicar elementos "a ojo" a partir de una imagen, para saber la escala exacta con la que trabajar.',
    inputSchema: z.object({})
  }, async () => ok(
    { ancho: CW, alto: CH, margen_recomendado: 60 },
    `Lienzo: ${CW} x ${CH} unidades. Dejá ~60 unidades de margen contra los bordes.`
  ));

  server.registerTool('convertir_posicion', {
    description: 'Convierte una posición relativa (0 a 100, % del ancho/alto del lienzo — así se suele describir dónde está algo en una imagen: "más o menos al 20% desde la izquierda, 60% desde arriba") a coordenadas x,y reales del lienzo. Usalo para traducir lo que ves en una imagen de referencia a posiciones exactas, en vez de estimar x,y a mano.',
    inputSchema: z.object({
      x_pct: z.number().min(0).max(100).describe('Posición horizontal, 0 = borde izquierdo, 100 = borde derecho'),
      y_pct: z.number().min(0).max(100).describe('Posición vertical, 0 = borde superior, 100 = borde inferior')
    })
  }, async ({ x_pct, y_pct }) => {
    const x = Math.round((x_pct / 100) * CW), y = Math.round((y_pct / 100) * CH);
    return ok({ x, y }, `(${x_pct}%, ${y_pct}%) → x=${x}, y=${y}`);
  });

  server.registerTool('verificar_espacio', {
    description: 'Antes de agregar un símbolo o cuarto en una posición, revisa si ahí ya hay algo puesto (evita amontonar elementos al replicar un dibujo denso). Mandá "simbolo" para que calcule el tamaño solo, o "ancho"/"alto" a mano para un cuarto.',
    inputSchema: z.object({
      sala: zSala(),
      x: z.number(), y: z.number(),
      simbolo: z.enum(ICON_KEYS).optional().describe('Si es un equipo: su tamaño sale del catálogo'),
      ancho: z.number().positive().optional().describe('Ancho del candidato si no es un símbolo de catálogo (ej. un cuarto)'),
      alto: z.number().positive().optional().describe('Alto del candidato si no es un símbolo de catálogo')
    })
  }, async ({ sala, x, y, simbolo, ancho, alto }) => {
    try {
      const estado = await leerSala(sala);
      const w = ancho ?? (simbolo ? ICON_BY_KEY[simbolo].w : 40);
      const h = alto ?? (simbolo ? ICON_BY_KEY[simbolo].h : 40);
      const candidato = { cx: x, cy: y, w, h };
      const colisiones = [];
      for (const el of estado.els) {
        const centro = centroDe(el, estado.els);
        const caja = cajaDe(el, estado.els);
        if (!centro || !caja) continue;
        if (seSuperponen(candidato, { cx: centro.x, cy: centro.y, w: caja.ancho, h: caja.alto })) {
          colisiones.push({ id: el.id, tipo: el.t, etiqueta: el.label || el.k || '' });
        }
      }
      const libre = colisiones.length === 0;
      return ok({ libre, colisiones },
        libre ? `Libre en (${x},${y}).` : `Ocupado por: ${colisiones.map(c => `${c.id}(${c.etiqueta})`).join(', ')}`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('buscar_elementos', {
    description: 'Busca elementos del plano filtrando por cercanía a un punto y/o por tipo/símbolo, sin traer el JSON completo — mucho más rápido que leer_plano cuando el plano ya tiene muchos elementos y solo necesitás ver qué hay en una zona puntual o de un tipo/símbolo particular antes de agregar, editar o mover algo.',
    inputSchema: z.object({
      sala: zSala(),
      cerca_de: zPunto('Punto de referencia (o {id} de un elemento existente) — si se manda, ordena por distancia y aplica "radio"').optional(),
      radio: z.number().positive().optional().describe('Distancia máxima en unidades del lienzo desde "cerca_de" (default 300); se ignora si no se manda cerca_de'),
      tipo: z.enum(['equip', 'room', 'cable', 'text', 'dim']).optional().describe('Filtra solo por este tipo de elemento'),
      simbolo: z.enum(ICON_KEYS).optional().describe('Filtra solo equipos con este símbolo exacto'),
      limite: z.number().int().min(1).max(200).optional().describe('Máximo de resultados (default 30)')
    })
  }, async ({ sala, cerca_de, radio, tipo, simbolo, limite }) => {
    try {
      const estado = await leerSala(sala);
      const els = estado.els;
      const refPunto = cerca_de ? resolverPunto(els, cerca_de) : null;
      if (cerca_de && !refPunto) throw new Error('No se pudo resolver "cerca_de" — el id no existe en este plano.');
      const radioEf = radio || 300, max = limite || 30;
      let resultados = els
        .filter(e => (!tipo || e.t === tipo) && (!simbolo || e.k === simbolo))
        .map(e => {
          const centro = centroDe(e, els), caja = cajaDe(e, els);
          const distancia = (refPunto && centro) ? Math.round(Math.hypot(centro.x - refPunto.x, centro.y - refPunto.y)) : null;
          return {
            id: e.id, tipo: e.t, simbolo: e.k, etiqueta: e.label || '',
            ...(centro ? { x: Math.round(centro.x), y: Math.round(centro.y) } : {}),
            ...(caja ? { caja: { ancho: Math.round(caja.ancho), alto: Math.round(caja.alto) } } : {}),
            ...(distancia !== null ? { distancia } : {})
          };
        });
      if (refPunto) resultados = resultados.filter(r => r.distancia === undefined || r.distancia <= radioEf).sort((a, b) => a.distancia - b.distancia);
      resultados = resultados.slice(0, max);
      return ok({ resultados, total: resultados.length }, `${resultados.length} elemento(s) encontrado(s) en ${sala}.\n${JSON.stringify(resultados, null, 2)}`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('resumen_plano', {
    description: 'Resumen rápido y compacto del plano: cuántos elementos hay por tipo y por símbolo, la caja que envuelve todo lo puesto (tamaño real del dibujo) y qué equipos quedaron sin ninguna conexión — mucho más liviano que leer_plano para un chequeo rápido de avance mientras se recrea un dibujo grande, sin gastar tokens en el JSON completo.',
    inputSchema: z.object({ sala: zSala() })
  }, async ({ sala }) => {
    try {
      const estado = await leerSala(sala);
      const els = estado.els;
      const porTipo = {}, porSimbolo = {};
      const xs = [], ys = [];
      for (const e of els) {
        porTipo[e.t] = (porTipo[e.t] || 0) + 1;
        if (e.t === 'equip') porSimbolo[e.k] = (porSimbolo[e.k] || 0) + 1;
        const centro = centroDe(e, els), caja = cajaDe(e, els);
        if (!centro) continue;
        const w = caja ? caja.ancho : 0, h = caja ? caja.alto : 0;
        xs.push(centro.x - w / 2, centro.x + w / 2);
        ys.push(centro.y - h / 2, centro.y + h / 2);
      }
      const caja_total = xs.length
        ? { x1: Math.round(Math.min(...xs)), y1: Math.round(Math.min(...ys)), x2: Math.round(Math.max(...xs)), y2: Math.round(Math.max(...ys)) }
        : null;
      const equipos = els.filter(e => e.t === 'equip');
      const cables = els.filter(e => e.t === 'cable');
      const sinConexion = equipos
        .filter(eq => !cables.some(c => c.a?.id === eq.id || c.b?.id === eq.id))
        .map(eq => ({ id: eq.id, simbolo: eq.k, etiqueta: eq.label || '' }));
      const resultado = { total: els.length, por_tipo: porTipo, por_simbolo: porSimbolo, caja_total, sin_conexion: sinConexion };
      const texto = `Sala ${sala}: ${els.length} elemento(s). ` +
        (sinConexion.length ? `${sinConexion.length} equipo(s) sin conexión: ${sinConexion.map(s => s.id).join(', ')}.` : 'Todos los equipos tienen al menos una conexión.');
      return ok(resultado, texto);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('establecer_membrete', {
    description: 'Completa o corrige el encabezado del formato técnico BlueCode (cliente/responsable, código de sitio, norma/estándar, departamento/región, municipio/ciudad, proyecto/sede, formato, fecha, versión). Solo cambia los campos que mandes; el resto queda como estaba.',
    inputSchema: z.object({
      sala: zSala(),
      asignatario: z.string().optional().describe('Cliente o entidad responsable del proyecto'),
      codigo_asignatario: z.string().optional().describe('Ej. "SITE-001" — código interno de sitio o proyecto'),
      resolucion: z.string().optional().describe('Norma o referencia técnica aplicable, ej. "RETIE / TIA-568"'),
      departamento: z.string().optional(),
      municipio: z.string().optional(),
      centro: z.string().optional().describe('Zona o localidad'),
      sede: z.string().optional().describe('Nombre del proyecto o sede'),
      dane: z.string().optional(),
      formato: z.string().optional(),
      fecha: z.string().optional(),
      version: z.string().optional()
    })
  }, async ({ sala, codigo_asignatario, ...resto }) => {
    try {
      const campos = { ...resto };
      if (codigo_asignatario !== undefined) campos.codigo = codigo_asignatario;
      const header = await establecerMembrete(sala, campos);
      return ok({ sala, header }, `Membrete actualizado en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agregar_equipo', {
    description: 'Agrega un símbolo de equipo (RETIE, comunicaciones, etc.) al plano en la posición (x,y) indicada. Usá listar_simbolos primero para saber qué valores de "simbolo" son válidos. Por defecto intenta la misma auto-conexión que hace la app (SPT→TDG, AP→RACK, toma→tablero, etc.) — mandá auto_conectar:false para desactivarla en este elemento.',
    inputSchema: z.object({
      sala: zSala(),
      simbolo: z.enum(ICON_KEYS).describe('Clave exacta del símbolo, ver listar_simbolos'),
      x: z.number().describe('Posición horizontal, 0..2200 aprox.'),
      y: z.number().describe('Posición vertical, 0..1000 aprox.'),
      rot: z.number().optional().describe('Rotación en grados, múltiplos de 45 recomendado'),
      etiqueta: z.string().optional().describe('Texto bajo el símbolo; por defecto el nombre del símbolo'),
      detalle: z.string().optional().describe('Segunda línea de detalle/código, más chica'),
      color: zColor('Color del símbolo (repinta el dibujo vectorial, no la etiqueta)'),
      color_texto: zColor('Color de la etiqueta/detalle (independiente del color del símbolo)'),
      escala: z.number().min(0.3).max(5).optional().describe('Tamaño relativo del símbolo, 1 = normal, 2 = doble, 0.5 = mitad'),
      espejo: z.boolean().optional().describe('true = símbolo invertido horizontalmente (modo espejo); la etiqueta nunca se invierte'),
      auto_conectar: z.boolean().optional().describe('Default true: traza solo el cable "obvio" según las reglas RETIE si hay un destino/origen disponible')
    })
  }, async ({ sala, simbolo, x, y, rot, etiqueta, detalle, color, color_texto, escala, espejo, auto_conectar }) => {
    try {
      const info = ICON_BY_KEY[simbolo];
      const resultado = await mutarSala(sala, (els, seq) => {
        let s = seq;
        const el = {
          id: 's' + s++, t: 'equip', k: simbolo, x, y, rot: rot || 0,
          label: etiqueta ?? (info.name || info.label), sub: detalle || ''
        };
        if (color) el.color = color;
        if (color_texto) el.textColor = color_texto;
        if (escala) el.scale = escala;
        if (espejo) el.flip = true;
        const nuevos = [el];
        let autolink = null;
        if (auto_conectar !== false) {
          const { cables, resumen } = autoLink(els, el);
          for (const c of cables) { c.id = 's' + s++; nuevos.push(c); }
          if (resumen.length) autolink = resumen;
        }
        return { els: [...els, ...nuevos], seq: s, resultado: { ...el, autoconexion: autolink } };
      });
      const extra = resultado.autoconexion ? ` Auto-conexión: ${resultado.autoconexion.join(' · ')}.` : '';
      return ok(resultado, `Equipo "${resultado.label}" agregado (id ${resultado.id}) en ${sala}.${extra}`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agregar_cuarto', {
    description: 'Agrega un cuarto/espacio rectangular (paredes) al plano, centrado en (x,y).',
    inputSchema: z.object({
      sala: zSala(),
      x: z.number(), y: z.number(),
      ancho: z.number().positive().describe('Ancho del cuarto en unidades del lienzo'),
      alto: z.number().positive().describe('Alto del cuarto en unidades del lienzo'),
      nombre: z.string().optional().describe('Nombre del espacio, ej. "SALA DE SISTEMAS"'),
      area: z.string().optional().describe('Texto de área/detalle debajo del nombre'),
      rot: z.number().optional(),
      color: zColor('Color de los muros'),
      color_texto: zColor('Color del nombre del espacio')
    })
  }, async ({ sala, x, y, ancho, alto, nombre, area, rot, color, color_texto }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const el = { id: 's' + seq, t: 'room', x, y, w: ancho, h: alto, rot: rot || 0, label: nombre || 'NOMBRE DEL ESPACIO', area: area || '' };
        if (color) el.color = color;
        if (color_texto) el.textColor = color_texto;
        return { els: [...els, el], seq: seq + 1, resultado: el };
      });
      return ok(resultado, `Cuarto "${resultado.label}" agregado (id ${resultado.id}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agregar_cable', {
    description: 'Traza una conexión (fibra, UTP, SPT/tierra o acometida) entre dos puntos. Cada extremo puede ser el id de un equipo/cuarto ya puesto (el cable se ancla y se mueve solo si después movés ese equipo) o un punto libre {x,y}. El recorrido se calcula solo en ángulo recto salvo que mandes "quiebres" explícitos o "diagonal:true".',
    inputSchema: z.object({
      sala: zSala(),
      tipo_cable: z.enum(CABLE_KEYS).describe('fibra | utp | spt | acom'),
      desde: zPunto('Extremo inicial'),
      hasta: zPunto('Extremo final'),
      etiqueta: z.string().optional().describe('Ej. "15m UTP CAT6"'),
      quiebres: z.array(zPuntoLibre()).max(8).optional().describe('Puntos intermedios por los que debe pasar el cable, en orden'),
      diagonal: z.boolean().optional().describe('true = línea recta entre los puntos (o entre quiebres), sin forzar ángulo recto — pensado para tendidos reales en diagonal (ej. fibra aérea entre postes)'),
      flecha: z.boolean().optional().describe('Solo fibra: true = marca el sentido con una cabeza de flecha en el extremo final. Apagado por defecto.'),
      color: zColor('Color de la línea (por defecto, el color propio del tipo de cable)'),
      color_texto: zColor('Color de la etiqueta de metraje')
    })
  }, async ({ sala, tipo_cable, desde, hasta, etiqueta, quiebres, diagonal, flecha, color, color_texto }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        validarExtremo(els, desde); validarExtremo(els, hasta);
        const el = { id: 's' + seq, t: 'cable', k: tipo_cable, a: desde, b: hasta, label: etiqueta || '', elbow: 'auto', w: quiebres || [] };
        if (diagonal) el.diag = true;
        if (flecha) el.flecha = true;
        if (color) el.color = color;
        if (color_texto) el.textColor = color_texto;
        return { els: [...els, el], seq: seq + 1, resultado: el };
      });
      return ok(resultado, `Cable ${tipo_cable} agregado (id ${resultado.id}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agregar_texto', {
    description: 'Agrega una anotación de texto flotante en el plano.',
    inputSchema: z.object({
      sala: zSala(), x: z.number(), y: z.number(), texto: z.string(),
      tamano: z.number().min(8).max(60).optional(),
      color: zColor('Color del texto')
    })
  }, async ({ sala, x, y, texto, tamano, color }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const el = { id: 's' + seq, t: 'text', x, y, rot: 0, label: texto, size: tamano || 17 };
        if (color) el.color = color;
        return { els: [...els, el], seq: seq + 1, resultado: el };
      });
      return ok(resultado, `Texto agregado (id ${resultado.id}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agregar_acotado', {
    description: 'Agrega una línea de medida/acotado (siempre recta) entre dos puntos libres, con un texto como "25m UTP CAT6" o "FIBRA ACOMETIDA 30m".',
    inputSchema: z.object({
      sala: zSala(),
      desde: zPuntoLibre(), hasta: zPuntoLibre(),
      texto: z.string().describe('Ej. "25m UTP CAT6"')
    })
  }, async ({ sala, desde, hasta, texto }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const el = { id: 's' + seq, t: 'dim', a: desde, b: hasta, label: texto };
        return { els: [...els, el], seq: seq + 1, resultado: el };
      });
      return ok(resultado, `Acotado "${texto}" agregado (id ${resultado.id}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  /* Punto para un extremo de cable DENTRO de un lote: además de {id} o
     {x,y}, acepta {ref} — un alias elegido por quien llama para referirse a
     OTRO elemento de este mismo lote que todavía no tiene id real (se
     resuelve recién al procesar el lote, en orden). */
  const zPuntoLote = (desc) => z.union([
    z.object({ id: z.string() }).describe('Id de un elemento YA existente en el plano'),
    z.object({ ref: z.string() }).describe('Alias "ref" de otro elemento de este mismo lote'),
    zPuntoLibre()
  ]).describe(desc);

  const zItemEquipo = z.object({
    tipo: z.literal('equipo'), ref: z.string().optional().describe('Alias para referenciarlo desde un cable de este mismo lote'),
    simbolo: z.enum(ICON_KEYS), x: z.number(), y: z.number(), rot: z.number().optional(),
    etiqueta: z.string().optional(), detalle: z.string().optional(),
    color: zColor('Color del símbolo'), color_texto: zColor('Color de la etiqueta'),
    escala: z.number().min(0.3).max(5).optional(),
    espejo: z.boolean().optional().describe('true = símbolo invertido horizontalmente'),
    auto_conectar: z.boolean().optional().describe('Default true')
  });
  const zItemCuarto = z.object({
    tipo: z.literal('cuarto'), ref: z.string().optional(),
    x: z.number(), y: z.number(), ancho: z.number().positive(), alto: z.number().positive(),
    nombre: z.string().optional(), area: z.string().optional(), rot: z.number().optional(),
    color: zColor('Color de los muros'), color_texto: zColor('Color del nombre')
  });
  const zItemCable = z.object({
    tipo: z.literal('cable'), ref: z.string().optional(),
    tipo_cable: z.enum(CABLE_KEYS), desde: zPuntoLote('Extremo inicial'), hasta: zPuntoLote('Extremo final'),
    etiqueta: z.string().optional(), quiebres: z.array(zPuntoLibre()).max(8).optional(),
    diagonal: z.boolean().optional().describe('true = línea recta sin forzar ángulo recto'),
    flecha: z.boolean().optional().describe('Solo fibra: cabeza de flecha en el extremo final'),
    color: zColor('Color de la línea'), color_texto: zColor('Color de la etiqueta')
  });
  const zItemTexto = z.object({
    tipo: z.literal('texto'), ref: z.string().optional(),
    x: z.number(), y: z.number(), texto: z.string(), tamano: z.number().min(8).max(60).optional(),
    color: zColor('Color del texto')
  });
  const zItemAcotado = z.object({
    tipo: z.literal('acotado'), ref: z.string().optional(),
    desde: zPuntoLibre(), hasta: zPuntoLibre(), texto: z.string()
  });

  server.registerTool('agregar_elementos_lote', {
    description: 'Agrega VARIOS elementos de una sola vez (equipos, cuartos, cables, textos, cotas) en una única operación — mucho más rápido que llamar agregar_* una vez por elemento cuando estás recreando un plano entero. Los elementos se crean en el orden de la lista; un cable puede conectar a un elemento anterior de esta misma lista poniéndole "ref" a ese elemento y usando {"ref":"ese_alias"} en desde/hasta, sin tener que esperar a saber su id real.',
    inputSchema: z.object({
      sala: zSala(),
      elementos: z.array(z.discriminatedUnion('tipo', [zItemEquipo, zItemCuarto, zItemCable, zItemTexto, zItemAcotado]))
        .min(1).max(60).describe('Lista ordenada de elementos a crear')
    })
  }, async ({ sala, elementos }) => {
    try {
      const resultado = await mutarSala(sala, (elsIniciales, seqInicial) => {
        let s = seqInicial;
        let els = elsIniciales.slice();
        const refs = {};
        const creados = [];
        const resolverLote = (p) => {
          if (p.ref !== undefined) {
            if (!(p.ref in refs)) throw new Error(`"ref" desconocida: "${p.ref}" — debe ser el ref de un elemento anterior en esta misma lista`);
            return { id: refs[p.ref] };
          }
          return p; // {id:...} o {x,y}
        };
        for (const item of elementos) {
          if (item.tipo === 'equipo') {
            const info = ICON_BY_KEY[item.simbolo];
            const el = {
              id: 's' + s++, t: 'equip', k: item.simbolo, x: item.x, y: item.y, rot: item.rot || 0,
              label: item.etiqueta ?? (info.name || info.label), sub: item.detalle || ''
            };
            if (item.color) el.color = item.color;
            if (item.color_texto) el.textColor = item.color_texto;
            if (item.escala) el.scale = item.escala;
            if (item.espejo) el.flip = true;
            els.push(el); creados.push(el);
            if (item.ref) refs[item.ref] = el.id;
            if (item.auto_conectar !== false) {
              const { cables } = autoLink(els, el);
              for (const c of cables) { c.id = 's' + s++; els.push(c); creados.push(c); }
            }
          } else if (item.tipo === 'cuarto') {
            const el = { id: 's' + s++, t: 'room', x: item.x, y: item.y, w: item.ancho, h: item.alto, rot: item.rot || 0, label: item.nombre || 'NOMBRE DEL ESPACIO', area: item.area || '' };
            if (item.color) el.color = item.color;
            if (item.color_texto) el.textColor = item.color_texto;
            els.push(el); creados.push(el);
            if (item.ref) refs[item.ref] = el.id;
          } else if (item.tipo === 'cable') {
            const desde = resolverLote(item.desde), hasta = resolverLote(item.hasta);
            if ('id' in desde) validarExtremo(els, desde);
            if ('id' in hasta) validarExtremo(els, hasta);
            const el = { id: 's' + s++, t: 'cable', k: item.tipo_cable, a: desde, b: hasta, label: item.etiqueta || '', elbow: 'auto', w: item.quiebres || [] };
            if (item.diagonal) el.diag = true;
            if (item.flecha) el.flecha = true;
            if (item.color) el.color = item.color;
            if (item.color_texto) el.textColor = item.color_texto;
            els.push(el); creados.push(el);
            if (item.ref) refs[item.ref] = el.id;
          } else if (item.tipo === 'texto') {
            const el = { id: 's' + s++, t: 'text', x: item.x, y: item.y, rot: 0, label: item.texto, size: item.tamano || 17 };
            if (item.color) el.color = item.color;
            els.push(el); creados.push(el);
            if (item.ref) refs[item.ref] = el.id;
          } else if (item.tipo === 'acotado') {
            const el = { id: 's' + s++, t: 'dim', a: item.desde, b: item.hasta, label: item.texto };
            els.push(el); creados.push(el);
            if (item.ref) refs[item.ref] = el.id;
          }
        }
        return { els, seq: s, resultado: { creados, total: creados.length } };
      });
      return ok(resultado, `${resultado.total} elemento(s) agregado(s) en ${sala} (incluye cables de auto-conexión, si hubo).`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('alinear_elementos', {
    description: 'Alinea 2 o más elementos (por sus ids) a su borde izquierdo/derecho/superior/inferior común, o centra sus centros — igual que el menú de alinear de la app. Solo afecta a equipos/cuartos/textos (los cables/cotas no tienen una posición propia que alinear).',
    inputSchema: z.object({
      sala: zSala(),
      ids: z.array(z.string()).min(2),
      como: z.enum(['izquierda', 'derecha', 'centro_x', 'arriba', 'abajo', 'centro_y'])
    })
  }, async ({ sala, ids, como }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const objetivo = new Set(ids);
        const grupo = els.filter(e => objetivo.has(e.id) && typeof e.x === 'number');
        if (grupo.length < 2) throw new Error('Se necesitan 2 o más ids válidos de equipo/cuarto/texto.');
        const cajas = grupo.map(e => { const c = cajaDe(e, els) || { ancho: 0, alto: 0 }; return { x1: e.x - c.ancho / 2, x2: e.x + c.ancho / 2, y1: e.y - c.alto / 2, y2: e.y + c.alto / 2, w: c.ancho, h: c.alto }; });
        const L = Math.min(...cajas.map(c => c.x1)), R = Math.max(...cajas.map(c => c.x2));
        const T = Math.min(...cajas.map(c => c.y1)), B = Math.max(...cajas.map(c => c.y2));
        const nuevos = els.map(e => {
          const i = grupo.findIndex(g => g.id === e.id);
          if (i < 0) return e;
          const c = cajas[i], copia = { ...e };
          if (como === 'izquierda') copia.x = Math.round(L + c.w / 2);
          if (como === 'derecha') copia.x = Math.round(R - c.w / 2);
          if (como === 'centro_x') copia.x = Math.round((L + R) / 2);
          if (como === 'arriba') copia.y = Math.round(T + c.h / 2);
          if (como === 'abajo') copia.y = Math.round(B - c.h / 2);
          if (como === 'centro_y') copia.y = Math.round((T + B) / 2);
          return copia;
        });
        return { els: nuevos, seq, resultado: { alineados: grupo.length } };
      });
      return ok(resultado, `${resultado.alineados} elemento(s) alineado(s) (${como}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('distribuir_elementos', {
    description: 'Reparte 3 o más elementos (por sus ids) a distancia pareja entre el primero y el último, en horizontal o vertical — igual que el menú de distribuir de la app. Útil para ordenar una fila/columna de símbolos ya puestos, sin recalcular cada x/y a mano.',
    inputSchema: z.object({
      sala: zSala(),
      ids: z.array(z.string()).min(3),
      eje: z.enum(['horizontal', 'vertical'])
    })
  }, async ({ sala, ids, eje }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const objetivo = new Set(ids);
        const key = eje === 'horizontal' ? 'x' : 'y';
        const grupo = els.filter(e => objetivo.has(e.id) && typeof e.x === 'number').sort((a, b) => a[key] - b[key]);
        if (grupo.length < 3) throw new Error('Se necesitan 3 o más ids válidos de equipo/cuarto/texto.');
        const first = grupo[0][key], last = grupo[grupo.length - 1][key];
        const paso = (last - first) / (grupo.length - 1);
        const nuevaPos = new Map(grupo.map((e, i) => [e.id, Math.round(first + paso * i)]));
        const nuevos = els.map(e => nuevaPos.has(e.id) ? { ...e, [key]: nuevaPos.get(e.id) } : e);
        return { els: nuevos, seq, resultado: { distribuidos: grupo.length } };
      });
      return ok(resultado, `${resultado.distribuidos} elemento(s) distribuido(s) (${eje}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  /* Límite de desplazamiento de etiqueta, igual que LABEL_R en el cliente —
     si se manda más lejos, se recorta acá mismo (y si no, el cliente lo
     recortaría igual al redibujar), así que documentarlo evita una llamada
     que parece "no hacer nada". */
  const LABEL_R = 240;
  const zOffsetEtiqueta = () => z.object({
    dx: z.number(), dy: z.number()
  }).describe(`Desplazamiento del texto respecto de su sitio por defecto, en unidades del lienzo (radio máximo ${LABEL_R}; si se pasa, se recorta). En equipos/cuartos es relativo al elemento (gira con él); en cables es directo en el lienzo.`);
  const clampOffsetEtiqueta = ({ dx, dy }) => {
    const d = Math.hypot(dx, dy);
    if (!d || d <= LABEL_R) return { x: dx, y: dy };
    const k = LABEL_R / d;
    return { x: Math.round(dx * k), y: Math.round(dy * k) };
  };

  server.registerTool('editar_elemento', {
    description: 'Modifica campos de un elemento ya puesto (por su id, ver leer_plano). Solo cambia los campos que mandes.',
    inputSchema: z.object({
      sala: zSala(),
      id: z.string(),
      x: z.number().optional(), y: z.number().optional(), rot: z.number().optional(),
      etiqueta: z.string().optional().describe('Texto principal (label)'),
      detalle: z.string().optional().describe('Solo para equipos: la segunda línea (sub)'),
      color: zColor('Color del símbolo/línea/muros'),
      color_texto: zColor('Color de la etiqueta/texto'),
      escala: z.number().min(0.3).max(5).optional().describe('Solo para equipos'),
      espejo: z.boolean().optional().describe('Solo equipos/cuartos: true = invertido horizontalmente'),
      offset_etiqueta: zOffsetEtiqueta().optional(),
      diagonal: z.boolean().optional().describe('Solo para cables: true = línea recta sin forzar ángulo recto'),
      flecha: z.boolean().optional().describe('Solo para fibra: cabeza de flecha en el extremo final. Apagado por defecto.'),
      ancho: z.number().positive().optional().describe('Solo para cuartos'),
      alto: z.number().positive().optional().describe('Solo para cuartos'),
      tamano: z.number().min(8).max(60).optional().describe('Solo para anotaciones de texto'),
      tipo_cable: z.enum(CABLE_KEYS).optional().describe('Solo para cables: cambia el tipo de una conexión ya trazada (fibra/utp/spt/acom)'),
      orden_z: z.enum(['frente', 'fondo']).optional().describe('Trae el elemento al frente o lo manda al fondo, por encima/debajo de CUALQUIER otro elemento del plano sea cual sea su tipo — mismo mecanismo que "Traer al frente"/"Enviar al fondo" de la app')
    })
  }, async ({ sala, id, etiqueta, detalle, color, color_texto, escala, espejo, offset_etiqueta, diagonal, flecha, ancho, alto, tamano, tipo_cable, orden_z, ...pos }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const idx = ubicar(els, id);
        const el = { ...els[idx] };
        if (pos.x !== undefined) el.x = pos.x;
        if (pos.y !== undefined) el.y = pos.y;
        if (pos.rot !== undefined) el.rot = pos.rot;
        if (etiqueta !== undefined) el.label = etiqueta;
        if (detalle !== undefined) el.sub = detalle;
        if (color !== undefined) el.color = color;
        if (color_texto !== undefined) el.textColor = color_texto;
        if (escala !== undefined) el.scale = escala;
        if (espejo !== undefined) el.flip = espejo;
        if (offset_etiqueta !== undefined) el.lo = clampOffsetEtiqueta(offset_etiqueta);
        if (diagonal !== undefined) el.diag = diagonal;
        if (flecha !== undefined) el.flecha = flecha;
        if (ancho !== undefined) el.w = ancho;
        if (alto !== undefined) el.h = alto;
        if (tamano !== undefined) el.size = tamano;
        if (tipo_cable !== undefined) el.k = tipo_cable;
        if (orden_z !== undefined) el.zBand = orden_z === 'frente' ? 'front' : 'back';
        const nuevosEls = els.slice(); nuevosEls[idx] = el;
        return { els: nuevosEls, seq, resultado: el };
      });
      return ok(resultado, `Elemento ${id} actualizado en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('eliminar_elemento', {
    description: 'Borra un elemento del plano por su id.',
    inputSchema: z.object({ sala: zSala(), id: z.string() })
  }, async ({ sala, id }) => {
    try {
      await mutarSala(sala, (els, seq) => {
        const idx = ubicar(els, id);
        const nuevosEls = els.slice(); nuevosEls.splice(idx, 1);
        return { els: nuevosEls, seq, resultado: null };
      });
      return ok({ id }, `Elemento ${id} eliminado de ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  const zItemEditar = z.object({
    id: z.string(),
    x: z.number().optional(), y: z.number().optional(), rot: z.number().optional(),
    etiqueta: z.string().optional(), detalle: z.string().optional(),
    color: zColor('Color del símbolo/línea/muros'), color_texto: zColor('Color de la etiqueta/texto'),
    escala: z.number().min(0.3).max(5).optional().describe('Solo para equipos'),
    espejo: z.boolean().optional().describe('Solo equipos/cuartos'),
    offset_etiqueta: zOffsetEtiqueta().optional(),
    diagonal: z.boolean().optional().describe('Solo para cables'),
    flecha: z.boolean().optional().describe('Solo para fibra: cabeza de flecha en el extremo final'),
    ancho: z.number().positive().optional().describe('Solo para cuartos'),
    alto: z.number().positive().optional().describe('Solo para cuartos'),
    tamano: z.number().min(8).max(60).optional().describe('Solo para anotaciones de texto'),
    tipo_cable: z.enum(CABLE_KEYS).optional().describe('Solo para cables: cambia el tipo de una conexión ya trazada'),
    orden_z: z.enum(['frente', 'fondo']).optional().describe('Trae al frente o manda al fondo, por encima/debajo de CUALQUIER otro elemento sea cual sea su tipo')
  });

  server.registerTool('editar_elementos_lote', {
    description: 'Edita VARIOS elementos de una sola vez (cada uno con su propio id y solo los campos que quieras cambiarle) — para ajustes masivos rápidos (recolorear todo un grupo, corregir varias etiquetas, etc.) sin una llamada por elemento.',
    inputSchema: z.object({
      sala: zSala(),
      elementos: z.array(zItemEditar).min(1).max(100).describe('Lista de ediciones; cada una identifica su elemento por "id"')
    })
  }, async ({ sala, elementos }) => {
    try {
      const resultado = await mutarSala(sala, (elsIniciales, seq) => {
        const els = elsIniciales.slice();
        let editados = 0;
        for (const item of elementos) {
          const idx = ubicar(els, item.id);
          const el = { ...els[idx] };
          if (item.x !== undefined) el.x = item.x;
          if (item.y !== undefined) el.y = item.y;
          if (item.rot !== undefined) el.rot = item.rot;
          if (item.etiqueta !== undefined) el.label = item.etiqueta;
          if (item.detalle !== undefined) el.sub = item.detalle;
          if (item.color !== undefined) el.color = item.color;
          if (item.color_texto !== undefined) el.textColor = item.color_texto;
          if (item.escala !== undefined) el.scale = item.escala;
          if (item.espejo !== undefined) el.flip = item.espejo;
          if (item.offset_etiqueta !== undefined) el.lo = clampOffsetEtiqueta(item.offset_etiqueta);
          if (item.diagonal !== undefined) el.diag = item.diagonal;
          if (item.flecha !== undefined) el.flecha = item.flecha;
          if (item.ancho !== undefined) el.w = item.ancho;
          if (item.alto !== undefined) el.h = item.alto;
          if (item.tamano !== undefined) el.size = item.tamano;
          if (item.tipo_cable !== undefined) el.k = item.tipo_cable;
          if (item.orden_z !== undefined) el.zBand = item.orden_z === 'frente' ? 'front' : 'back';
          els[idx] = el;
          editados++;
        }
        return { els, seq, resultado: { editados } };
      });
      return ok(resultado, `${resultado.editados} elemento(s) editado(s) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('eliminar_elementos_lote', {
    description: 'Borra VARIOS elementos de una sola vez por sus ids — para limpiar en una sola operación en vez de llamar eliminar_elemento una vez por id.',
    inputSchema: z.object({
      sala: zSala(),
      ids: z.array(z.string()).min(1).max(200)
    })
  }, async ({ sala, ids }) => {
    try {
      const resultado = await mutarSala(sala, (elsIniciales, seq) => {
        const els = elsIniciales.slice();
        for (const id of ids) { els.splice(ubicar(els, id), 1); }
        return { els, seq, resultado: { eliminados: ids.length } };
      });
      return ok(resultado, `${resultado.eliminados} elemento(s) eliminado(s) de ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('duplicar_elementos', {
    description: 'Duplica uno o más elementos ya puestos (por sus ids) con un desplazamiento dx/dy en unidades del lienzo — mismo comportamiento que Ctrl+D en la app. Si dos elementos que se duplican JUNTOS estaban conectados por un cable/cota, la copia queda conectada entre sí; si un extremo apuntaba a algo que NO está en la lista, la copia de ese cable queda con ese extremo suelto (punto libre), sin quedar pegada al original.',
    inputSchema: z.object({
      sala: zSala(),
      ids: z.array(z.string()).min(1).max(100),
      dx: z.number().optional().describe('Desplazamiento horizontal de las copias, por defecto 20'),
      dy: z.number().optional().describe('Desplazamiento vertical de las copias, por defecto 20')
    })
  }, async ({ sala, ids, dx, dy }) => {
    try {
      const DX = dx ?? 20, DY = dy ?? 20;
      const resultado = await mutarSala(sala, (els, seq) => {
        let s = seq;
        const origenes = ids.map(id => els[ubicar(els, id)]);
        const mapId = {}, mapGid = {}, nuevos = [];
        for (const src of origenes) {
          const el = { ...src, id: 's' + s++ };
          mapId[src.id] = el.id;
          if (el.gid) {
            if (!mapGid[el.gid]) mapGid[el.gid] = 'g' + (s++);
            el.gid = mapGid[el.gid];
          }
          nuevos.push(el);
        }
        const buscarOriginal = id => els.find(e => e.id === id);
        for (const el of nuevos) {
          if (el.t === 'cable' || el.t === 'dim') {
            for (const extremo of ['a', 'b']) {
              const r = el[extremo];
              if (r.id) {
                if (mapId[r.id]) el[extremo] = { id: mapId[r.id] };
                else { const n = buscarOriginal(r.id); el[extremo] = n ? { x: n.x + DX, y: n.y + DY } : { x: DX, y: DY }; }
              } else el[extremo] = { x: r.x + DX, y: r.y + DY };
            }
          } else { el.x += DX; el.y += DY; }
        }
        return { els: [...els, ...nuevos], seq: s, resultado: { ids: nuevos.map(e => e.id) } };
      });
      return ok(resultado, `${resultado.ids.length} elemento(s) duplicado(s) en ${sala}: ${resultado.ids.join(', ')}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('agrupar_elementos', {
    description: 'Agrupa 2 o más elementos para que la app los mueva/rote juntos de ahí en adelante (mover_elementos y el arrastre manual respetan el grupo). No cambia su posición ni su z-order.',
    inputSchema: z.object({ sala: zSala(), ids: z.array(z.string()).min(2).max(200) })
  }, async ({ sala, ids }) => {
    try {
      const resultado = await mutarSala(sala, (elsIniciales, seq) => {
        const els = elsIniciales.slice();
        const idxs = ids.map(id => ubicar(els, id));
        const gid = 'g' + seq;
        idxs.forEach(i => { els[i] = { ...els[i], gid }; });
        return { els, seq: seq + 1, resultado: { gid, cantidad: idxs.length } };
      });
      return ok(resultado, `${resultado.cantidad} elemento(s) agrupados (${resultado.gid}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('desagrupar_elementos', {
    description: 'Deshace el/los grupo(s) de uno o más elementos indicados por id — quita el gid de TODOS los miembros de cada grupo encontrado, no solo de los ids que mandes (igual que en la app).',
    inputSchema: z.object({ sala: zSala(), ids: z.array(z.string()).min(1).max(200) })
  }, async ({ sala, ids }) => {
    try {
      const resultado = await mutarSala(sala, (els, seq) => {
        const objetivos = ids.map(id => els[ubicar(els, id)]);
        const gids = new Set(objetivos.map(e => e.gid).filter(Boolean));
        if (!gids.size) return { els, seq, resultado: { desagrupados: 0 } };
        let n = 0;
        const nuevosEls = els.map(e => {
          if (e.gid && gids.has(e.gid)) { n++; const { gid, ...resto } = e; return resto; }
          return e;
        });
        return { els: nuevosEls, seq, resultado: { desagrupados: n } };
      });
      return ok(resultado, resultado.desagrupados
        ? `${resultado.desagrupados} elemento(s) desagrupados en ${sala}.`
        : `Ninguno de esos elementos estaba agrupado en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('mover_elementos', {
    description: 'Desplaza VARIOS elementos juntos por un mismo delta (dx,dy), preservando su posición relativa entre sí — para correr un grupo/cluster entero de una sola vez (ej. "mové todo lo de la sala de sistemas 150 unidades a la derecha") sin recalcular cada x/y a mano. Solo mueve equipos/cuartos/textos; los cables anclados por id a esos elementos los siguen solos.',
    inputSchema: z.object({
      sala: zSala(),
      ids: z.array(z.string()).min(1).max(200),
      dx: z.number().describe('Desplazamiento horizontal en unidades del lienzo'),
      dy: z.number().describe('Desplazamiento vertical en unidades del lienzo')
    })
  }, async ({ sala, ids, dx, dy }) => {
    try {
      const resultado = await mutarSala(sala, (elsIniciales, seq) => {
        const objetivo = new Set(ids);
        let movidos = 0;
        const els = elsIniciales.map(e => {
          if (!objetivo.has(e.id) || typeof e.x !== 'number') return e;
          movidos++;
          return { ...e, x: e.x + dx, y: e.y + dy };
        });
        if (!movidos) throw new Error('Ningún id válido de equipo/cuarto/texto entre los mandados (los cables/cotas no se desplazan directamente).');
        return { els, seq, resultado: { movidos } };
      });
      return ok(resultado, `${resultado.movidos} elemento(s) desplazado(s) (dx=${dx}, dy=${dy}) en ${sala}.`);
    } catch (err) { return errTool(err); }
  });

  server.registerTool('limpiar_plano', {
    description: 'Borra TODOS los elementos del plano (el membrete queda intacto). Requiere confirmar=true a propósito, para no vaciar un plano por accidente.',
    inputSchema: z.object({ sala: zSala(), confirmar: z.literal(true) })
  }, async ({ sala }) => {
    try {
      await mutarSala(sala, (els, seq) => ({ els: [], seq, resultado: null }));
      return ok({ sala }, `Plano ${sala} limpiado — 0 elementos.`);
    } catch (err) { return errTool(err); }
  });

  return server;
}

const mcpHandler = createMcpHandler(buildServer);
/* La protección anti-DNS-rebinding valida el header Host contra esta lista.
   La petición puede llegar por cualquiera de las tres puertas: el dominio
   público limpio (rewrite de Hosting), el alias clásico de Cloud Functions,
   o el hostname real del servicio de Cloud Run que hay detrás de ambos —
   Hosting reenvía CON ese último Host, no con el dominio público, así que
   hace falta incluirlo explícitamente o toda petición vía /mcp da 403. */
const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: [
    'blueplan-bluecode.web.app',
    'us-central1-blueplan-bluecode.cloudfunctions.net',
    'localhost'
  ]
});
const nodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => { void nodeHandler(req, res, req.body); });
app.get('/', (_req, res) => res.status(200).send('MCP de "BluePlan — BlueCode" activo. Endpoint: POST /mcp'));

/* Este servidor no usa OAuth (a propósito: acceso público, sin login, igual
   que el resto de la app). Sin estas rutas, cualquiera de ellas cae en el
   rewrite catch-all de Hosting y devuelve la SPA completa con HTTP 200 — un
   cliente MCP que sondea "¿este servidor necesita OAuth?" antes de hablar
   con /mcp interpreta ese 200-con-HTML como una respuesta rara y falla el
   registro ("No se pudo registrar con el servicio de inicio de sesión").
   Un 404 limpio en estas rutas es la señal correcta y estándar de "esta
   sesión no requiere autorización, segui directo a /mcp". */
app.all(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
         '/.well-known/oauth-protected-resource/mcp', '/.well-known/openid-configuration', '/register'],
  (_req, res) => res.status(404).json({ error: 'not_found', error_description: 'Este servidor MCP no usa OAuth.' }));

exports.mcp = onRequest({ region: 'us-central1', cors: true }, app);

/* --------------------------------------------------------------------------
   INTÉRPRETE RÁPIDO DE IMÁGENES  (POST /interpretar)
   El editor manda una captura y recibe cuartos/equipos/textos ya ubicados.

   La API key de Gemini es un SECRETO de la función, no una constante del
   HTML: la página del editor es pública, así que cualquier key embebida ahí
   se la lleva quien abra el inspector. Se carga una sola vez con
   `firebase functions:secrets:set GEMINI_API_KEY`.

   PORTERO: hay que mandar el código de una sala que EXISTA. Cada llamada
   cuesta plata contra la API de Gemini, y sin ninguna barrera el endpoint
   quedaba abierto a que cualquiera que lo descubriera gastara la cuota. El
   código de sala de 4 caracteres es la misma barrera que ya usa todo el
   resto de la app — no es un login, pero hay que conocerlo, y eso alcanza
   para frenar el abuso al azar. `maxInstances` acota además el peor caso.
   -------------------------------------------------------------------------- */
const MAX_IMAGEN_B64 = 8 * 1024 * 1024;   /* ~6 MB de imagen real */
/* El plano rasterizado del tercer pase lo genera el propio editor y va a ~1100
   px de ancho: con 3 MB sobra de largo. Tiene su propio tope para que una
   captura gigante no pueda colarse por este campo. */
const MAX_PLANO_B64 = 3 * 1024 * 1024;
/* Un plano de verdad no llega a mil elementos; el tope está para que nadie
   mande un array interminable a reacomodar. */
const MAX_ELEMENTOS = 1200;

exports.interpretar = onRequest({
  region: 'us-central1', cors: true, secrets: [GEMINI_API_KEY],
  timeoutSeconds: 120, memory: '512MiB', maxInstances: 3
}, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usá POST.' });
  try {
    const { sala, imagen, mime, ancho, alto, fase, yaEnElPlano,
            imagenPlano, inventario, elementos } = req.body || {};

    /* El portero va ANTES de mirar la imagen: si el código no sirve, no tiene
       sentido gastar tiempo (ni memoria) en validar un base64 de 6 MB. */
    const codigo = String(sala || '').toUpperCase();
    if (!await existeSala(codigo))
      return res.status(403).json({ error: 'Necesitás estar en una sala válida para interpretar imágenes.' });

    /* ---------------- fase 'modelos': diagnóstico ----------------
       Devuelve los modelos que esta key puede usar de verdad y con cuál se
       quedaría cada fase. Existe porque la pregunta '¿por qué dejó de andar
       la interpretación?' se contestaba adivinando: los nombres de versión de
       Gemini se vencen sin aviso, y cuando eso pasa no hay forma de saberlo
       desde afuera. Un segundo de consulta vale más que una vuelta de
       despliegue a ciegas. */
    if (fase === 'modelos'){
      const { diagnosticoModelos } = require('./lib/interpretar');
      return res.status(200).json(await diagnosticoModelos(GEMINI_API_KEY.value()));
    }

    /* ---------------- fase 'ordenar': pura geometría ----------------
       Reacomoda un plano que ya existe y dice qué quedó chocando. No manda
       nada a ninguna API, así que no cuesta un centavo y se puede llamar las
       veces que haga falta. Sale ACÁ, antes de cualquier validación de
       imagen, justamente porque no hay imagen. */
    if (fase === 'ordenar'){
      if (!Array.isArray(elementos))
        return res.status(400).json({ error: 'Falta la lista de elementos a ordenar.' });
      if (elementos.length > MAX_ELEMENTOS)
        return res.status(413).json({ error: 'El plano tiene demasiados elementos para reacomodar.' });
      return res.status(200).json(ordenarPlano(elementos));
    }

    if (typeof imagen !== 'string' || !imagen)
      return res.status(400).json({ error: 'Falta la imagen (base64, sin el prefijo data:).' });
    if (imagen.length > MAX_IMAGEN_B64)
      return res.status(413).json({ error: 'La imagen es muy grande; probá con una captura más chica.' });
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(String(mime || '')))
      return res.status(400).json({ error: 'Formato no soportado (PNG, JPG, WEBP o GIF).' });

    /* ---------------- fase 'revision': el tercer pase ----------------
       Las dos imágenes juntas: la original y el plano ya dibujado. Devuelve
       CORRECCIONES, no elementos — ver lib/revisar.js para el porqué. */
    if (fase === 'revision'){
      if (typeof imagenPlano !== 'string' || !imagenPlano)
        return res.status(400).json({ error: 'Falta el plano rasterizado para comparar.' });
      if (imagenPlano.length > MAX_PLANO_B64)
        return res.status(413).json({ error: 'El plano rasterizado es demasiado grande.' });
      const inv = Array.isArray(inventario) ? inventario.slice(0, 300) : [];
      if (!inv.length)
        return res.status(400).json({ error: 'Falta el inventario del plano a revisar.' });
      const revision = await revisarPlano({
        apiKey: GEMINI_API_KEY.value(),
        imagenB64: imagen, mime: String(mime),
        imagenPlano, inventario: inv
      });
      return res.status(200).json(revision);
    }

    const salida = await interpretarImagen({
      apiKey: GEMINI_API_KEY.value(),
      imagenB64: imagen,
      mime: String(mime),
      imgW: Number(ancho) || 0,
      imgH: Number(alto)  || 0,
      /* 'cuartos' = primera pasada, chica y rápida, para que el usuario ya
         vea algo y pueda editar. Cualquier otro valor (o ninguno) hace la
         pasada completa, que es también el comportamiento de un cliente
         viejo que no mande el campo. */
      fase: fase === 'cuartos' ? 'cuartos' : 'resto',
      /* Lo que el plano ya tiene dibujado. La segunda pasada lo necesita para
         no repetir como texto suelto algo que ya está escrito (el nombre de
         un cuarto de la primera pasada, por ejemplo). Se acota para que un
         cliente no pueda mandar un plano gigante y hacer trabajar de más. */
      yaEnElPlano: Array.isArray(yaEnElPlano) ? yaEnElPlano.slice(0, 300) : []
    });
    return res.status(200).json(salida);
  } catch (err) {
    console.error('[interpretar] falló', err);
    return res.status(502).json({ error: err.message || 'No se pudo interpretar la imagen.' });
  }
});
