// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Facturación electrónica (emitir facturas y boletas desde las ventas)
//
//  El vendedor ELIGE qué facturar: ve las ventas del ERP que aún tienen saldo
//  sin comprobante, revisa cliente e ítems (puede editar descripción, cantidad y
//  precio, o quitar ítems) y emite. También puede seleccionar varias ventas y
//  emitirlas en lote con los datos por defecto.
//
//  Proveedor (Railway FE_PROVEEDOR): 'apisunat' (por defecto) o 'nubefact'. El
//  proveedor firma el XML, lo manda a SUNAT, guarda el CDR y genera el PDF. Cada
//  uno es un adaptador (proveedorApisunat / proveedorNubefact) sobre un mismo
//  comprobante neutro, así se cambia de proveedor sin tocar el resto.
//
//  Variables de Railway (el número es sales.company_id: 1 Diseños, 2 Christopher):
//    APISUNAT_TOKEN_1, APISUNAT_TOKEN_2     → token de cada RUC (app.apisunat.pe › Organizaciones)
//    APISUNAT_URL (opcional)                → https://sandbox.apisunat.pe para pruebas
//                                             (por defecto https://app.apisunat.pe)
//    Con NubeFacT: NUBEFACT_RUTA_n y NUBEFACT_TOKEN_n.
//    RESEND_API_KEY (ya existe) y FE_EMAIL_DESDE (opcional) → correo al cliente con
//      el PDF adjunto (APISUNAT no lo manda; NubeFacT sí).
//    ERP_FACTURACION_URL (opcional) → MySQL del ERP con un usuario que SOLO tenga
//      INSERT/SELECT sobre sale_vouchers. Con ella, cada comprobante aceptado se
//      registra solo en el ERP. Sin ella, queda en la lista "por anotar en ERP".
//
//  Correlativo: se lleva en la base del portal (fe_correlativos) y cada emisión
//  toma un candado por serie (GET_LOCK), así dos vendedores nunca usan el mismo
//  número ni quedan huecos por errores de validación.
//
//  Tablas del portal (se crean solas): fe_config, fe_correlativos,
//  fe_comprobantes, fe_comprobante_items.
// ═══════════════════════════════════════════════════════════════════════════

const mysql = require('mysql2/promise');
const { EMPRESAS_BI, nombreProdVar } = require('./comunes');

const IGV_PCT = 18;
const VENTAS_VALIDAS = ['paid', 'confirmed', 'pending_payment'];
const TOPE_BOLETA_SIN_DOC = 700; // SUNAT: boletas desde S/ 700 exigen documento del cliente
const TIPOS = ['factura', 'boleta', 'nc'];
// gravado = precio incluye IGV 18 %; nrus = Nuevo RUS (boletas sin IGV, operación 0113)
const AFECTACIONES = ['gravado', 'exonerado', 'inafecto', 'nrus'];
// Motivos de nota de crédito que maneja el módulo (catálogo 09 de SUNAT)
const MOTIVOS_NC = {
  1: 'Anulación de la operación',
  2: 'Anulación por error en el RUC',
  3: 'Corrección por error en la descripción',
  6: 'Devolución total',
  7: 'Devolución por ítem',
  9: 'Disminución en el valor'
};
const MOTIVOS_NC_TOTALES = [1, 2, 3, 6]; // copian el comprobante completo

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r10 = n => Math.round(Number(n) * 1e10) / 1e10;
const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // aaaa-mm-dd
const aDDMMAAAA = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const sumarDias = (iso, d) => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// Fecha DATE de MySQL → 'aaaa-mm-dd' sin correr un día por zona horaria
const isoFecha = d => d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d || '').slice(0, 10);
const limpiar = (s, max = 250) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

// ─── Funciones puras (se prueban sin base de datos) ─────────────────────────

// Tipo de documento SUNAT según el número: 11 dígitos = RUC (6), 8 = DNI (1).
function tipoDocCliente(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11 && /^(10|15|16|17|20)/.test(d)) return '6';
  if (d.length === 8) return '1';
  return '';
}

// Tipo sugerido: factura si el cliente tiene RUC y la empresa puede emitir facturas.
function sugerirTipo(cliente, cfg) {
  if (cfg && cfg.solo_boletas) return 'boleta';
  return tipoDocCliente(cliente && cliente.doc) === '6' ? 'factura' : 'boleta';
}

// Arma el comprobante en un formato NEUTRO (no depende del proveedor) y devuelve
// los errores que impiden emitir y los avisos que conviene revisar. Cada
// proveedor (APISUNAT, NubeFacT) lo traduce a su propio JSON.
//  datos = { tipo, serie, numero, fecha, cliente:{tipo_doc,doc,nombre,direccion,email},
//            items:[{codigo,descripcion,cantidad,precio}]  ← precio unitario final (con IGV si aplica)
//            credito:{fecha_pago, importe} | null, observaciones, enviar_email, formato_pdf,
//            nc:{ref_tipo, ref_serie, ref_numero, motivo} (solo notas de crédito) }
//  cfg = { afectacion: 'gravado'|'exonerado'|'inafecto'|'nrus', solo_boletas }
function armarComprobante(datos, cfg = {}) {
  const errores = [], avisos = [];
  const tipo = datos.tipo;
  const afect = AFECTACIONES.includes(cfg.afectacion) ? cfg.afectacion : 'gravado';
  const conIgv = afect === 'gravado';
  if (!TIPOS.includes(tipo)) errores.push('Tipo de comprobante no válido');
  if (tipo === 'factura' && (cfg.solo_boletas || afect === 'nrus')) errores.push('Esta empresa solo emite boletas');

  const cli = datos.cliente || {};
  let tipoDoc = String(cli.tipo_doc || tipoDocCliente(cli.doc) || '').trim();
  let doc = String(cli.doc || '').replace(/\s/g, '');
  let nombre = limpiar(cli.nombre, 200);

  const items = [];
  (datos.items || []).forEach((it, i) => {
    const cantidad = Number(it.cantidad), precio = Number(it.precio);
    const desc = limpiar(it.descripcion, 250);
    if (!desc) errores.push(`Ítem ${i + 1}: falta la descripción`);
    if (!(cantidad > 0)) errores.push(`Ítem ${i + 1}: la cantidad debe ser mayor que 0`);
    if (!(precio > 0)) errores.push(`Ítem ${i + 1}: el precio debe ser mayor que 0`);
    if (!(cantidad > 0 && precio > 0)) return;
    const total = r2(precio * cantidad);
    const subtotal = conIgv ? r2(total / (1 + IGV_PCT / 100)) : total;
    items.push({
      unidad: it.unidad || 'NIU',
      codigo: limpiar(it.codigo, 30),
      descripcion: desc,
      cantidad: r10(cantidad),
      // valor sin IGV con 6 decimales calculado desde el TOTAL de la línea, para que
      // el proveedor (que recalcula valor × cantidad × 1.18) llegue al mismo total
      valor_unitario: Math.round((conIgv ? total / (1 + IGV_PCT / 100) : total) / cantidad * 1e6) / 1e6,
      precio_unitario: r10(total / cantidad),
      subtotal, igv: r2(total - subtotal), total,
      sale_item_id: it.sale_item_id || null
    });
  });
  if (!items.length) errores.push('El comprobante no tiene ítems');

  const total = r2(items.reduce((s, x) => s + x.total, 0));
  const totalIgv = r2(items.reduce((s, x) => s + x.igv, 0));

  // Reglas del cliente según el tipo
  const tipoBase = tipo === 'nc' ? (datos.nc && datos.nc.ref_tipo) : tipo;
  if (tipoBase === 'factura') {
    if (tipoDoc !== '6' || tipoDocCliente(doc) !== '6') errores.push('La factura exige un RUC válido (11 dígitos)');
    if (!nombre) errores.push('Falta la razón social del cliente');
    if (!limpiar(cli.direccion)) avisos.push('El cliente no tiene dirección; la factura sale sin dirección');
  } else if (tipoBase === 'boleta') {
    if (!doc || doc === '-' || !tipoDoc || tipoDoc === '-') {
      if (total >= TOPE_BOLETA_SIN_DOC) errores.push(`Boletas desde S/ ${TOPE_BOLETA_SIN_DOC} exigen DNI u otro documento del cliente`);
      tipoDoc = '-'; doc = '-'; nombre = nombre || 'CLIENTES VARIOS';
    } else if (tipoDoc === '1' && !/^\d{8}$/.test(doc)) errores.push('El DNI debe tener 8 dígitos');
    if (!nombre) nombre = 'CLIENTES VARIOS';
  }

  const fecha = esFecha(datos.fecha) ? datos.fecha : hoyLima();
  if (fecha > hoyLima()) errores.push('La fecha de emisión no puede ser futura');
  else if (fecha < sumarDias(hoyLima(), -2)) errores.push('SUNAT solo acepta comprobantes con hasta 3 días de antigüedad');

  const email = limpiar(cli.email, 120);
  if (datos.enviar_email && !email) avisos.push('El cliente no tiene correo: no se le enviará el PDF');

  const docN = {
    tipo, serie: datos.serie, numero: datos.numero, fecha, afectacion: afect,
    cliente: { tipo_doc: tipoDoc, doc, nombre, direccion: limpiar(cli.direccion), email },
    items: items.map(({ sale_item_id, ...x }) => x),
    totales: { gravada: conIgv ? r2(total - totalIgv) : 0, exonerada: afect === 'exonerado' ? total : 0,
      inafecta: afect === 'inafecto' || afect === 'nrus' ? total : 0, igv: totalIgv, total },
    credito: null, nc: null,
    observaciones: limpiar(datos.observaciones, 500),
    enviar_email: !!(datos.enviar_email && email),
    formato_pdf: datos.formato_pdf || 'A4'
  };

  // Factura al crédito: SUNAT exige indicar las cuotas
  if (tipo === 'factura' && datos.credito) {
    const imp = r2(datos.credito.importe || total), fp = datos.credito.fecha_pago;
    if (!esFecha(fp) || fp <= fecha) errores.push('Venta al crédito: la fecha de pago debe ser posterior a la emisión');
    if (!(imp > 0) || imp > total + 0.001) errores.push('Venta al crédito: el importe pendiente debe estar entre 0 y el total');
    docN.credito = { cuotas: [{ importe: imp, fecha_pago: fp }], vencimiento: fp };
  }

  if (tipo === 'nc') {
    const nc = datos.nc || {};
    if (!MOTIVOS_NC[nc.motivo]) errores.push('Elige el motivo de la nota de crédito');
    if (!['factura', 'boleta'].includes(nc.ref_tipo) || !nc.ref_serie || !nc.ref_numero) errores.push('Falta el comprobante que se modifica');
    if (nc.total_ref != null && total > Number(nc.total_ref) + 0.001) errores.push('La nota de crédito no puede superar el comprobante original');
    docN.nc = { ref_tipo: nc.ref_tipo, ref_serie: nc.ref_serie, ref_numero: nc.ref_numero, motivo: Number(nc.motivo) || null, motivo_texto: MOTIVOS_NC[nc.motivo] || '' };
    if (!docN.observaciones) docN.observaciones = MOTIVOS_NC[nc.motivo] || '';
  }

  return { doc: docN, errores, avisos, total, total_igv: totalIgv, items_origen: items.map(x => ({ sale_item_id: x.sale_item_id, cantidad: x.cantidad, total: x.total })) };
}

// Cuánto de la venta ya tiene comprobante. Junta los comprobantes del ERP y los
// del portal que aún no se registraron en el ERP (sin contarlos dos veces) y
// descuenta las notas de crédito emitidas desde el portal.
function calcularFacturado(venta, vouchersERP, compsPortal) {
  const clave = (s, n) => String(s || '').trim().toUpperCase() + '|' + parseInt(String(n).replace(/\D/g, ''), 10);
  const vistos = new Set();
  let facturado = 0, externo = 0;
  const lista = [];
  (vouchersERP || []).forEach(v => {
    const k = clave(v.serie, v.number);
    if (vistos.has(k)) return; vistos.add(k);
    facturado += Number(v.amount) || 0;
    const delPortal = (compsPortal || []).some(c => c.tipo !== 'nc' && clave(c.serie, c.numero) === k);
    if (!delPortal) externo += Number(v.amount) || 0;
    lista.push({ origen: delPortal ? 'portal' : 'erp', tipo: v.type, serie: v.serie, numero: v.number, total: Number(v.amount) || 0 });
  });
  (compsPortal || []).forEach(c => {
    if (['error', 'enviando', 'rechazado'].includes(c.estado)) return;
    if (c.tipo === 'nc') { facturado -= Number(c.total) || 0; lista.push({ origen: 'portal', tipo: 'nc', serie: c.serie, numero: c.numero, total: -Number(c.total) }); return; }
    const k = clave(c.serie, c.numero);
    if (vistos.has(k)) return; vistos.add(k);
    facturado += Number(c.total) || 0;
    lista.push({ origen: 'portal', tipo: c.tipo, serie: c.serie, numero: c.numero, total: Number(c.total) || 0 });
  });
  const total = Number(venta.total) || 0;
  return { total: r2(total), facturado: r2(facturado), externo: r2(externo), pendiente: r2(Math.max(0, total - facturado)), comprobantes: lista };
}

// Ítems por defecto para el comprobante: lo que falta facturar de cada línea
// (según lo emitido desde el portal). Si la venta tiene comprobantes hechos fuera
// del portal (SOL), no se puede saber qué ítems cubren: se marcan sin seleccionar.
function itemsPendientes(itemsERP, facturadoPorItem, hayExterno) {
  return (itemsERP || []).map(it => {
    const q = Number(it.quantity) || 0, tot = Number(it.total) || 0;
    const ya = Number((facturadoPorItem || {})[it.id]) || 0;
    const resta = Math.max(0, r10(q - ya));
    return {
      sale_item_id: it.id,
      codigo: (it.sku || '').trim(),
      descripcion: nombreProdVar(it.producto, it.variacion),
      cantidad_venta: q,
      cantidad: resta,
      precio: q > 0 ? r10(tot / q) : Number(it.unit_price) || 0,
      ya_facturado: ya,
      seleccionado: resta > 0 && !hayExterno
    };
  });
}

// ─── Proveedores ────────────────────────────────────────────────────────────
// Todos exponen la misma interfaz:
//   emitir(doc) / consultar(tipo, serie, numero) → { estado, sunat_desc, enlace, enlace_pdf, enlace_xml, enlace_cdr, raw }
//   y lanzan errores marcados: e.validacion (rechazo de datos), e.duplicado (número ya
//   usado), e.noExiste (consulta sin resultado), e.red (sin respuesta: resultado incierto).
//   envia_email: si el proveedor manda el PDF al cliente (si no, lo manda el portal).
const errorMarcado = (msg, marcas) => Object.assign(new Error(msg), marcas);

async function postJSON(fetchImpl, url, headers, cuerpo, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) { /* no JSON */ }
    return { status: r.status, d };
  } catch (e) {
    throw errorMarcado('Sin respuesta del proveedor (' + (e.name === 'AbortError' ? 'tiempo agotado' : e.message) + ')', { red: true });
  } finally { clearTimeout(t); }
}

// APISUNAT (lucode.pe) — https://docs.apisunat.pe  · PSE con certificado incluido
//   url: https://app.apisunat.pe (producción) o https://sandbox.apisunat.pe (pruebas)
const AS_DOC = { factura: 'factura', boleta: 'boleta', nc: 'nota_credito' };
const AS_AFECT = { gravado: ['18', '10', 'IGV'], exonerado: ['0', '20', 'EXO'], inafecto: ['0', '30', 'INA'], nrus: ['0', '10', 'IGV'] };
const AS_ESTADO = { ACEPTADO: 'aceptado', OBSERVADO: 'aceptado', PENDIENTE: 'pendiente_sunat', RECHAZADO: 'rechazado', ANULADO: 'aceptado' };
function apisunatJSON(doc) {
  const [pct, cod, trib] = AS_AFECT[doc.afectacion] || AS_AFECT.gravado;
  const sinDoc = doc.cliente.tipo_doc === '-' || doc.cliente.doc === '-';
  const j = {
    documento: AS_DOC[doc.tipo], serie: doc.serie, numero: doc.numero,
    fecha_de_emision: doc.fecha,
    moneda: 'PEN',
    tipo_operacion: doc.afectacion === 'nrus' ? '0113' : '0101',
    cliente_tipo_de_documento: sinDoc ? '1' : doc.cliente.tipo_doc,
    cliente_numero_de_documento: sinDoc ? '99999999' : doc.cliente.doc,
    cliente_denominacion: sinDoc ? (doc.cliente.nombre && doc.cliente.nombre !== 'CLIENTES VARIOS' ? doc.cliente.nombre : 'CLIENTE VARIOS') : doc.cliente.nombre,
    cliente_direccion: doc.cliente.direccion || '-',
    items: doc.items.map(it => ({
      unidad_de_medida: it.unidad || 'NIU',
      ...(it.codigo ? { codigo_interno: it.codigo } : {}),
      descripcion: it.descripcion,
      cantidad: String(it.cantidad),
      valor_unitario: it.valor_unitario.toFixed(6),
      porcentaje_igv: pct, codigo_tipo_afectacion_igv: cod, nombre_tributo: trib
    })),
    total: doc.totales.total.toFixed(2)
  };
  if (doc.fecha === hoyLima()) j.hora_de_emision = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false });
  if (doc.observaciones) j.observacion = doc.observaciones;
  if (doc.credito) {
    j.fecha_de_vencimiento = doc.credito.vencimiento;
    j.cuotas = doc.credito.cuotas.map(c => ({ importe: Number(c.importe).toFixed(2), fecha_de_pago: c.fecha_pago }));
  }
  if (doc.nc) {
    j.nota_credito_codigo_tipo = String(doc.nc.motivo).padStart(2, '0');
    j.nota_credito_motivo = doc.nc.motivo_texto;
    j.documento_afectado = { documento: doc.nc.ref_tipo, serie: doc.nc.ref_serie, numero: Number(doc.nc.ref_numero) };
  }
  return j;
}
function proveedorApisunat({ url, token, fetchImpl = fetch, timeoutMs = 60000 }) {
  const base = String(url || 'https://app.apisunat.pe').replace(/\/+$/, '');
  const auth = { Authorization: 'Bearer ' + token };
  const normalizar = (d, formato) => {
    const p = (d && d.payload) || {};
    const pdf = p.pdf || {};
    const enlacePdf = formato === 'TICKET' ? (pdf.ticket || pdf.a4) : (pdf.a4 || pdf.ticket);
    return {
      estado: AS_ESTADO[String(p.estado || '').toUpperCase()] || 'pendiente_sunat',
      sunat_desc: limpiar(d && d.message, 500),
      enlace: (formato === 'TICKET' ? pdf.a4 : pdf.ticket) || null,
      enlace_pdf: enlacePdf || null, enlace_xml: p.xml || null, enlace_cdr: p.cdr || null, raw: d
    };
  };
  const fallo = (status, d, consulta) => {
    const msg = limpiar((d && d.message) || ('HTTP ' + status), 400);
    const detalle = d && d.payload && typeof d.payload === 'object' && !d.payload.estado
      ? Object.entries(d.payload).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join(' · ') : '';
    const texto = detalle ? `${msg} (${limpiar(detalle, 400)})` : msg;
    if (status >= 500 || status === 0) return errorMarcado(texto, { red: true });
    if (status === 401 || status === 403) return errorMarcado('Token de APISUNAT no válido: ' + texto, { config: true });
    if (consulta && /no se encuentra|no existe|no registrad/i.test(msg)) return errorMarcado(texto, { noExiste: true, validacion: true });
    if (/ya (existe|fue|se encuentra|ha sido)|duplicad|registrado anteriormente/i.test(msg)) return errorMarcado(texto, { duplicado: true, validacion: true });
    return errorMarcado(texto, { validacion: true });
  };
  return {
    nombre: 'APISUNAT', envia_email: false,
    convertir: apisunatJSON,
    async emitir(doc) {
      const { status, d } = await postJSON(fetchImpl, base + '/api/v3/documents', auth, apisunatJSON(doc), timeoutMs);
      // RECHAZADO puede venir con success:false pero con el payload del comprobante
      if (d && d.payload && d.payload.estado) return normalizar(d, doc.formato_pdf);
      if (status === 200 && d && d.success !== false) return normalizar(d, doc.formato_pdf);
      throw fallo(status, d, false);
    },
    async consultar(tipo, serie, numero, formato) {
      const { status, d } = await postJSON(fetchImpl, base + '/api/v3/status', auth, { documento: AS_DOC[tipo], serie, numero: Number(numero) }, timeoutMs);
      if (d && d.payload && d.payload.estado) return normalizar(d, formato);
      throw fallo(status, d, true);
    }
  };
}

// NubeFacT — https://www.nubefact.com/integracion · alternativa (S/ 70/mes por RUC)
const NF_TIPO = { factura: 1, boleta: 2, nc: 3 };
const NF_IGV = { gravado: 1, exonerado: 8, inafecto: 9, nrus: 9 };
function nubefactJSON(doc) {
  const tIgv = NF_IGV[doc.afectacion] || 1;
  const j = {
    operacion: 'generar_comprobante', tipo_de_comprobante: NF_TIPO[doc.tipo], serie: doc.serie, numero: doc.numero,
    sunat_transaction: 1,
    cliente_tipo_de_documento: doc.cliente.tipo_doc, cliente_numero_de_documento: doc.cliente.doc,
    cliente_denominacion: doc.cliente.nombre, cliente_direccion: doc.cliente.direccion, cliente_email: doc.cliente.email || '',
    fecha_de_emision: aDDMMAAAA(doc.fecha), moneda: 1, porcentaje_de_igv: IGV_PCT,
    total_gravada: doc.totales.gravada || '', total_exonerada: doc.totales.exonerada || '', total_inafecta: doc.totales.inafecta || '',
    total_igv: doc.totales.igv, total: doc.totales.total,
    observaciones: doc.observaciones || '',
    enviar_automaticamente_a_la_sunat: true, enviar_automaticamente_al_cliente: !!doc.enviar_email,
    formato_de_pdf: doc.formato_pdf || '',
    items: doc.items.map(it => ({ unidad_de_medida: it.unidad || 'NIU', codigo: it.codigo, descripcion: it.descripcion, cantidad: it.cantidad,
      valor_unitario: r10(it.subtotal / it.cantidad), precio_unitario: it.precio_unitario, descuento: '', subtotal: it.subtotal,
      tipo_de_igv: tIgv, igv: it.igv, total: it.total, anticipo_regularizacion: false }))
  };
  if (doc.credito) {
    j.condiciones_de_pago = 'CRÉDITO'; j.medio_de_pago = 'venta_al_credito';
    j.venta_al_credito = doc.credito.cuotas.map((c, i) => ({ cuota: i + 1, fecha_de_pago: aDDMMAAAA(c.fecha_pago), importe: c.importe }));
  }
  if (doc.nc) {
    j.documento_que_se_modifica_tipo = doc.nc.ref_tipo === 'factura' ? 1 : 2;
    j.documento_que_se_modifica_serie = doc.nc.ref_serie;
    j.documento_que_se_modifica_numero = doc.nc.ref_numero;
    j.tipo_de_nota_de_credito = doc.nc.motivo;
  }
  return j;
}
function proveedorNubefact({ ruta, token, fetchImpl = fetch, timeoutMs = 60000 }) {
  const auth = { Authorization: `Token token="${token}"` };
  const normalizar = d => {
    const rechazo = d.sunat_responsecode && Number(d.sunat_responsecode) >= 2000;
    return {
      estado: d.aceptada_por_sunat ? 'aceptado' : (rechazo ? 'rechazado' : 'pendiente_sunat'),
      sunat_desc: limpiar([d.sunat_description, d.sunat_note, d.sunat_soap_error].filter(Boolean).join(' · '), 500),
      enlace: d.enlace || null, enlace_pdf: d.enlace_del_pdf || null, enlace_xml: d.enlace_del_xml || null, enlace_cdr: d.enlace_del_cdr || null, raw: d
    };
  };
  const enviar = async (cuerpo, consulta) => {
    const { status, d } = await postJSON(fetchImpl, ruta, auth, cuerpo, timeoutMs);
    if (!d) throw errorMarcado('Respuesta no válida de NubeFacT (HTTP ' + status + ')', { red: status >= 500 });
    if (d.errors) {
      const codigo = Number(d.codigo) || null;
      throw errorMarcado(String(d.errors), { validacion: true, codigo, duplicado: codigo === 23, noExiste: consulta, config: codigo === 10 });
    }
    return normalizar(d);
  };
  return {
    nombre: 'NubeFacT', envia_email: true,
    convertir: nubefactJSON,
    emitir: doc => enviar(nubefactJSON(doc), false),
    consultar: (tipo, serie, numero) => enviar({ operacion: 'consultar_comprobante', tipo_de_comprobante: NF_TIPO[tipo], serie, numero }, true)
  };
}

// ─── Módulo ─────────────────────────────────────────────────────────────────
module.exports = function ({ app, authAdmin, requiereModulo, prodPool, portalPool, erpWritePool, proveedorFactory, empresas = EMPRESAS_BI }) {
  const mFe = requiereModulo('facturacion');
  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next() : res.status(403).json({ error: 'Solo el administrador maestro puede cambiar la configuración' });
  const quien = req => (req.admin && req.admin.usuario) || 'admin';

  // Escritura en el ERP (opcional)
  if (erpWritePool === undefined && process.env.ERP_FACTURACION_URL)
    erpWritePool = mysql.createPool(process.env.ERP_FACTURACION_URL + '?connectionLimit=2');

  // Proveedor: APISUNAT por defecto (FE_PROVEEDOR=nubefact para usar NubeFacT)
  const NOMBRE_PROV = String(process.env.FE_PROVEEDOR || 'apisunat').toLowerCase() === 'nubefact' ? 'nubefact' : 'apisunat';
  const credenciales = id => {
    if (NOMBRE_PROV === 'nubefact') {
      const ruta = process.env['NUBEFACT_RUTA_' + id], token = process.env['NUBEFACT_TOKEN_' + id];
      return ruta && token ? { ruta, token } : null;
    }
    const token = process.env['APISUNAT_TOKEN_' + id];
    return token ? { token, url: process.env.APISUNAT_URL || 'https://app.apisunat.pe' } : null;
  };
  const varsFaltan = id => NOMBRE_PROV === 'nubefact' ? `NUBEFACT_RUTA_${id} y NUBEFACT_TOKEN_${id}` : `APISUNAT_TOKEN_${id}`;
  const proveedor = proveedorFactory || (id => {
    const c = credenciales(id); if (!c) return null;
    return NOMBRE_PROV === 'nubefact' ? proveedorNubefact(c) : proveedorApisunat(c);
  });
  const enPruebas = NOMBRE_PROV === 'apisunat' && /sandbox/i.test(process.env.APISUNAT_URL || '');
  const nombreProv = id => { const p = proveedor(id); return (p && p.nombre) || (NOMBRE_PROV === 'nubefact' ? 'NubeFacT' : 'APISUNAT'); };

  // Envía el PDF al cliente con Resend (ya lo usa el portal) cuando el proveedor no lo hace.
  async function enviarCorreo(comp) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, error: 'Falta RESEND_API_KEY para enviar correos' };
    if (!comp.cliente_email) return { ok: false, error: 'El cliente no tiene correo' };
    if (!comp.enlace_pdf) return { ok: false, error: 'El comprobante aún no tiene PDF' };
    const nombreTipo = { factura: 'Factura', boleta: 'Boleta de venta', nc: 'Nota de crédito' }[comp.tipo];
    const num = `${comp.serie}-${comp.numero}`, emp = empresas[comp.company_id] || 'Kuranko';
    const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    try {
      const r = await fetch(process.env.RESEND_URL || 'https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.FE_EMAIL_DESDE || process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
          to: [comp.cliente_email],
          subject: `${nombreTipo} electrónica ${num} — ${emp}`,
          html: `<p>Hola ${esc(comp.cliente_nombre)},</p><p>Te enviamos tu <b>${esc(nombreTipo.toLowerCase())} electrónica ${num}</b> por <b>S/ ${Number(comp.total).toFixed(2)}</b>, emitida por ${esc(emp)}.</p>
            <p><a href="${esc(comp.enlace_pdf)}">Ver / descargar el PDF</a>${comp.enlace_xml ? ` · <a href="${esc(comp.enlace_xml)}">XML</a>` : ''}</p><p>Gracias por tu compra.</p>`,
          attachments: [{ filename: `${num}.pdf`, path: comp.enlace_pdf }]
        })
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return { ok: false, error: 'Resend: ' + (d.message || r.status) }; }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── Tablas ──
  async function crearTablas() {
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_config (
      company_id INT PRIMARY KEY,
      activo TINYINT DEFAULT 0,
      serie_factura VARCHAR(4) DEFAULT 'F001',
      serie_boleta VARCHAR(4) DEFAULT 'B001',
      serie_nc_factura VARCHAR(4) DEFAULT 'FC01',
      serie_nc_boleta VARCHAR(4) DEFAULT 'BC01',
      afectacion VARCHAR(10) DEFAULT 'gravado',
      solo_boletas TINYINT DEFAULT 0,
      enviar_email TINYINT DEFAULT 1,
      formato_pdf VARCHAR(6) DEFAULT 'A4',
      actualizado_por VARCHAR(100), actualizado DATETIME)`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_correlativos (
      company_id INT NOT NULL, serie VARCHAR(4) NOT NULL, ultimo INT NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, serie))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_comprobantes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL,
      tipo VARCHAR(8) NOT NULL,
      serie VARCHAR(4) NOT NULL,
      numero INT NOT NULL,
      sale_id BIGINT NULL, sale_code VARCHAR(40) NULL,
      fecha_emision DATE,
      cliente_tipo_doc VARCHAR(2), cliente_doc VARCHAR(20), cliente_nombre VARCHAR(200),
      cliente_email VARCHAR(120), cliente_telefono VARCHAR(40),
      total DECIMAL(12,2), total_igv DECIMAL(12,2),
      credito TINYINT DEFAULT 0,
      estado VARCHAR(16) NOT NULL,
      sunat_desc VARCHAR(500),
      error VARCHAR(500),
      enlace VARCHAR(300), enlace_pdf VARCHAR(300), enlace_xml VARCHAR(300), enlace_cdr VARCHAR(300),
      ref_id INT NULL, ref_tipo VARCHAR(8) NULL, ref_serie VARCHAR(4) NULL, ref_numero INT NULL,
      nc_motivo TINYINT NULL,
      anulado_por_nc INT NULL,
      erp_estado VARCHAR(12) DEFAULT 'pendiente',
      erp_error VARCHAR(300), erp_por VARCHAR(100), erp_en DATETIME,
      email_enviado TINYINT DEFAULT 0,
      payload MEDIUMTEXT, respuesta MEDIUMTEXT,
      emitido_por VARCHAR(100), creado DATETIME DEFAULT CURRENT_TIMESTAMP, actualizado DATETIME NULL,
      UNIQUE KEY uq_fe (company_id, serie, numero),
      INDEX idx_sale (sale_id), INDEX idx_fecha (fecha_emision), INDEX idx_estado (estado))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_comprobante_items (
      comprobante_id INT NOT NULL, sale_item_id BIGINT NOT NULL, cantidad DECIMAL(14,4) NOT NULL, total DECIMAL(12,2),
      INDEX idx_comp (comprobante_id), INDEX idx_item (sale_item_id))`);
    // Series por defecto distintas por empresa (F001/B001, F002/B002…): así una
    // serie-número nunca se repite entre las dos empresas (el cruce con SUNAT y
    // sale_vouchers no distinguen empresa).
    for (const id of Object.keys(empresas)) {
      const n = String(Number(id)).padStart(2, '0').slice(-2);
      await portalPool.query(`INSERT IGNORE INTO fe_config (company_id, serie_factura, serie_boleta, serie_nc_factura, serie_nc_boleta) VALUES (?,?,?,?,?)`,
        [Number(id), 'F0' + n, 'B0' + n, 'FC' + n, 'BC' + n]);
    }
  }
  let tablas = null;
  const listo = () => (tablas = tablas || crearTablas().catch(e => { tablas = null; throw e; }));

  async function leerConfig() {
    await listo();
    const [rows] = await portalPool.query(`SELECT * FROM fe_config`);
    const out = {};
    // Solo boletas = Nuevo RUS (se deriva del régimen; la columna queda por compatibilidad)
    rows.forEach(r => { out[r.company_id] = { ...r, solo_boletas: r.afectacion === 'nrus', enviar_email: !!r.enviar_email, activo: !!r.activo }; });
    return out;
  }
  const seriePara = (cfg, tipo, refTipo) =>
    tipo === 'factura' ? cfg.serie_factura : tipo === 'boleta' ? cfg.serie_boleta : (refTipo === 'factura' ? cfg.serie_nc_factura : cfg.serie_nc_boleta);

  async function enBloques(sql, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 1000) { const [rows] = await prodPool.query(sql, [ids.slice(i, i + 1000)]); out.push(...rows); }
    return out;
  }

  // Columnas opcionales de parties (dirección, teléfono): se descubren una vez.
  let colsParty = null;
  async function columnasParty() {
    if (colsParty) return colsParty;
    try {
      const [c] = await prodPool.query(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'parties'`);
      const set = new Set(c.map(x => x.c));
      colsParty = {
        direccion: ['address', 'fiscal_address', 'direccion', 'address_line'].find(x => set.has(x)) || null,
        telefono: ['phone', 'mobile', 'cellphone', 'telefono'].find(x => set.has(x)) || null,
        email: ['email', 'email_address'].find(x => set.has(x)) || null
      };
    } catch (e) { colsParty = { direccion: null, telefono: 'phone', email: 'email' }; }
    return colsParty;
  }

  // Lee del ERP lo necesario para una o varias ventas.
  async function leerVentas(ids) {
    if (!ids.length) return [];
    const cp = await columnasParty();
    const extra = ['direccion', 'telefono', 'email'].map(k => cp[k] ? `cli.\`${cp[k]}\` AS cli_${k}` : `NULL AS cli_${k}`).join(', ');
    const ventas = await enBloques(`
      SELECT s.id, s.code, s.company_id, s.customer_id, s.total, s.status, s.created_at,
        cli.is_company, cli.business_name, cli.first_name, cli.last_name, cli.document_number, ${extra}
      FROM sales s LEFT JOIN parties cli ON cli.id = s.customer_id
      WHERE s.id IN (?) AND s.deleted_at IS NULL`, ids);
    const items = await enBloques(`
      SELECT si.id, si.sale_id, si.quantity, si.unit_price, si.total, p.name AS producto, pv.name AS variacion, pv.sku
      FROM sale_items si JOIN product_variations pv ON pv.id = si.product_variation_id JOIN products p ON p.id = pv.product_id
      WHERE si.sale_id IN (?) ORDER BY si.id`, ids);
    const pagos = await enBloques(`SELECT sale_id, SUM(amount) pagado FROM sale_payments WHERE sale_id IN (?) AND voided_at IS NULL GROUP BY sale_id`, ids);
    const vouchers = await enBloques(`SELECT sale_id, type, serie, number, emission_date, amount FROM sale_vouchers WHERE sale_id IN (?)`, ids);
    const [comps] = await portalPool.query(`SELECT id, sale_id, tipo, serie, numero, total, estado FROM fe_comprobantes WHERE sale_id IN (?)`, [ids]);
    const compIds = comps.filter(c => !['error', 'enviando', 'rechazado'].includes(c.estado)).map(c => c.id);
    const [citems] = compIds.length ? await portalPool.query(`
      SELECT ci.sale_item_id, ci.cantidad, c.tipo FROM fe_comprobante_items ci JOIN fe_comprobantes c ON c.id = ci.comprobante_id
      WHERE ci.comprobante_id IN (?)`, [compIds]) : [[]];
    const porItem = {};
    citems.forEach(x => { porItem[x.sale_item_id] = (porItem[x.sale_item_id] || 0) + (x.tipo === 'nc' ? -1 : 1) * Number(x.cantidad); });

    const agrupar = (arr, k = 'sale_id') => arr.reduce((m, x) => ((m[x[k]] = m[x[k]] || []).push(x), m), {});
    const itV = agrupar(items), voV = agrupar(vouchers), coV = agrupar(comps);
    const pgV = Object.fromEntries(pagos.map(p => [p.sale_id, Number(p.pagado) || 0]));
    return ventas.map(v => {
      const fac = calcularFacturado(v, voV[v.id], coV[v.id]);
      const nombre = v.is_company ? (v.business_name || '') : `${v.first_name || ''} ${v.last_name || ''}`;
      return {
        id: v.id, code: v.code, company_id: v.company_id, empresa: empresas[v.company_id] || ('Empresa ' + v.company_id),
        status: v.status, fecha: v.created_at, total: r2(v.total), pagado: r2(pgV[v.id] || 0),
        cliente: { tipo_doc: tipoDocCliente(v.document_number), doc: (v.document_number || '').trim(), nombre: limpiar(nombre, 200),
          direccion: limpiar(v.cli_direccion), email: limpiar(v.cli_email, 120), telefono: limpiar(v.cli_telefono, 40) },
        ...fac,
        items: itemsPendientes(itV[v.id], porItem, fac.externo > 0.009)
      };
    });
  }

  // ── Registro en el ERP (sale_vouchers) ──
  let colsVoucher = null;
  async function columnasVoucher() {
    if (colsVoucher) return colsVoucher;
    const [c] = await erpWritePool.query(`SELECT COLUMN_NAME c, IS_NULLABLE n, COLUMN_DEFAULT d, EXTRA e FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_vouchers'`);
    return (colsVoucher = c);
  }
  async function registrarEnERP(comp, usuario) {
    if (!erpWritePool) return { erp_estado: 'pendiente', erp_error: null };
    if (comp.tipo === 'nc' || !comp.sale_id) return { erp_estado: 'no_aplica', erp_error: null };
    try {
      const [[ya]] = await erpWritePool.query(`SELECT COUNT(*) n FROM sale_vouchers WHERE sale_id = ? AND UPPER(TRIM(serie)) = ? AND CAST(number AS UNSIGNED) = ?`,
        [comp.sale_id, comp.serie.toUpperCase(), comp.numero]);
      if (ya.n > 0) return { erp_estado: 'registrado', erp_error: null };
      const cols = await columnasVoucher();
      const ahora = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const valores = { sale_id: comp.sale_id, type: comp.tipo, serie: comp.serie, number: comp.numero,
        emission_date: comp.fecha_emision, amount: comp.total, created_at: ahora, updated_at: ahora, company_id: comp.company_id };
      const usar = cols.filter(c => c.c in valores);
      const faltan = cols.filter(c => !(c.c in valores) && c.n === 'NO' && c.d == null && !/auto_increment/i.test(c.e || '')).map(c => c.c);
      if (faltan.length) return { erp_estado: 'error', erp_error: 'sale_vouchers exige columnas que el portal no conoce: ' + faltan.join(', ') };
      await erpWritePool.query(`INSERT INTO sale_vouchers (${usar.map(c => '`' + c.c + '`').join(',')}) VALUES (?)`, [usar.map(c => valores[c.c])]);
      return { erp_estado: 'registrado', erp_error: null, erp_por: usuario };
    } catch (e) { return { erp_estado: 'error', erp_error: limpiar(e.message, 300) }; }
  }

  // ── Emisión con correlativo bloqueado ──
  // Toma un candado por empresa+serie, usa el siguiente número y solo lo da por
  // consumido si el proveedor lo aceptó (o si el resultado quedó incierto por red).
  async function emitirDocumento({ companyId, tipo, serie, datos, cfg, venta, refComp, usuario, items_origen_override }) {
    const prov = proveedor(companyId);
    if (!prov) throw new Error(`Falta conectar ${nombreProv(companyId)} para ${empresas[companyId] || 'la empresa ' + companyId} (variable ${varsFaltan(companyId)})`);
    const conn = await portalPool.getConnection();
    const candado = `fe_${companyId}_${serie}`;
    try {
      const [[l]] = await conn.query(`SELECT GET_LOCK(?, 30) ok`, [candado]);
      if (!l || !l.ok) throw new Error('Otro usuario está emitiendo en esta serie; intenta de nuevo en unos segundos');
      await conn.query(`INSERT IGNORE INTO fe_correlativos (company_id, serie, ultimo) VALUES (?, ?, 0)`, [companyId, serie]);
      let [[c]] = await conn.query(`SELECT ultimo FROM fe_correlativos WHERE company_id = ? AND serie = ?`, [companyId, serie]);
      let numero = c.ultimo + 1;

      for (let intento = 0; intento < 5; intento++) {
        const armado = armarComprobante({ ...datos, tipo, serie, numero }, cfg);
        if (armado.errores.length) { const e = new Error(armado.errores.join(' · ')); e.validacion = true; throw e; }
        const [ins] = await conn.query(`INSERT INTO fe_comprobantes
          (company_id, tipo, serie, numero, sale_id, sale_code, fecha_emision, cliente_tipo_doc, cliente_doc, cliente_nombre, cliente_email, cliente_telefono,
           total, total_igv, credito, estado, ref_id, ref_tipo, ref_serie, ref_numero, nc_motivo, payload, emitido_por)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'enviando',?,?,?,?,?,?,?)`,
          [companyId, tipo, serie, numero, venta ? venta.id : null, venta ? venta.code : null, datos.fecha || hoyLima(),
            armado.doc.cliente.tipo_doc, armado.doc.cliente.doc, armado.doc.cliente.nombre,
            armado.doc.cliente.email || null, limpiar(datos.cliente && datos.cliente.telefono, 40) || null,
            armado.total, armado.total_igv, datos.credito ? 1 : 0,
            refComp ? refComp.id : null, refComp ? refComp.tipo : null, refComp ? refComp.serie : null, refComp ? refComp.numero : null,
            datos.nc ? datos.nc.motivo : null, JSON.stringify(armado.doc), usuario]);
        const compId = ins.insertId;
        const borrar = () => conn.query(`DELETE FROM fe_comprobantes WHERE id = ?`, [compId]);

        let resp = null, incierto = false, errProv = null;
        try { resp = await prov.emitir(armado.doc); }
        catch (e) {
          errProv = e;
          if (e.duplicado) {
            // El número ya existe en el proveedor. El portal nunca reusa un número que
            // pudo haber llegado (los inciertos lo consumen), así que lo usó otro
            // sistema (p. ej. el panel web del proveedor): se salta y se prueba el siguiente.
            await borrar();
            await conn.query(`UPDATE fe_correlativos SET ultimo = GREATEST(ultimo, ?) WHERE company_id = ? AND serie = ?`, [numero, companyId, serie]);
            numero++; continue;
          }
          if (e.red) {
            // Se cortó la red o venció el tiempo: ¿llegó o no? → consultar
            try { resp = await prov.consultar(tipo, serie, numero, armado.doc.formato_pdf); }
            catch (e2) { if (!e2.noExiste) incierto = true; } // no existe en el proveedor → no llegó
          }
        }

        if (!resp && !incierto) {
          await borrar();
          const err = new Error(prov.nombre + ': ' + (errProv ? errProv.message : 'sin respuesta'));
          err.validacion = !!(errProv && (errProv.validacion || errProv.config));
          throw err;
        }
        await conn.query(`UPDATE fe_correlativos SET ultimo = GREATEST(ultimo, ?) WHERE company_id = ? AND serie = ?`, [numero, companyId, serie]);

        const est = resp || { estado: 'incierto', sunat_desc: `Sin respuesta de ${prov.nombre}; usa "Consultar"` };
        const itemsOrigen = items_origen_override || armado.items_origen;
        if (itemsOrigen.some(x => x.sale_item_id))
          await conn.query(`INSERT INTO fe_comprobante_items (comprobante_id, sale_item_id, cantidad, total) VALUES ?`,
            [itemsOrigen.filter(x => x.sale_item_id).map(x => [compId, x.sale_item_id, x.cantidad, x.total])]);
        await conn.query(`UPDATE fe_comprobantes SET estado=?, sunat_desc=?, enlace=?, enlace_pdf=?, enlace_xml=?, enlace_cdr=?,
          email_enviado=?, respuesta=?, actualizado=NOW() WHERE id=?`,
          [est.estado, est.sunat_desc || null, est.enlace || null, est.enlace_pdf || null, est.enlace_xml || null, est.enlace_cdr || null,
            armado.doc.enviar_email && prov.envia_email ? 1 : 0, resp ? JSON.stringify(resp.raw).slice(0, 60000) : null, compId]);

        const comp = { id: compId, company_id: companyId, tipo, serie, numero, sale_id: venta ? venta.id : null, fecha_emision: datos.fecha || hoyLima(), total: armado.total };
        // Correo al cliente (si el proveedor no lo manda solo)
        if (armado.doc.enviar_email && !prov.envia_email && est.enlace_pdf && est.estado !== 'rechazado') {
          const m = await enviarCorreo({ ...comp, ...est, cliente_email: armado.doc.cliente.email, cliente_nombre: armado.doc.cliente.nombre });
          if (m.ok) await conn.query(`UPDATE fe_comprobantes SET email_enviado=1 WHERE id=?`, [compId]);
          else armado.avisos.push('No se envió el correo: ' + m.error);
        }
        if (est.estado !== 'rechazado' && est.estado !== 'incierto') {
          const erp = await registrarEnERP(comp, usuario);
          await conn.query(`UPDATE fe_comprobantes SET erp_estado=?, erp_error=?, erp_por=?, erp_en=IF(?='registrado',NOW(),NULL) WHERE id=?`,
            [erp.erp_estado, erp.erp_error, erp.erp_por || null, erp.erp_estado, compId]);
          comp.erp_estado = erp.erp_estado; comp.erp_error = erp.erp_error;
        }
        if (refComp && est.estado !== 'rechazado' && est.estado !== 'incierto' && datos.nc && MOTIVOS_NC_TOTALES.includes(Number(datos.nc.motivo)))
          await conn.query(`UPDATE fe_comprobantes SET anulado_por_nc = ? WHERE id = ?`, [compId, refComp.id]);
        const { raw, ...estSinRaw } = est;
        return { ...comp, ...estSinRaw, avisos: armado.avisos };
      }
      throw new Error('No se encontró un número libre en la serie ' + serie + '; revisa el correlativo en Configuración');
    } finally {
      try { await conn.query(`SELECT RELEASE_LOCK(?)`, [candado]); } catch (e) { /* nada */ }
      conn.release();
    }
  }

  // Valida una solicitud de emisión desde una venta y arma los datos.
  async function prepararDesdeVenta(body, cfgs) {
    const saleId = Number(body.sale_id);
    if (!saleId) throw Object.assign(new Error('Falta la venta'), { validacion: true });
    const [venta] = await leerVentas([saleId]);
    if (!venta) throw Object.assign(new Error('La venta no existe o fue eliminada'), { validacion: true });
    if (!VENTAS_VALIDAS.includes(venta.status)) throw Object.assign(new Error('La venta está ' + venta.status + '; no se puede facturar'), { validacion: true });
    if (venta.pendiente <= 0.009) throw Object.assign(new Error(`${venta.code} ya tiene comprobante por todo su importe`), { validacion: true });
    const cfg = cfgs[venta.company_id];
    if (!cfg || !cfg.activo) throw Object.assign(new Error(`${venta.empresa} no tiene activada la emisión de comprobantes (Facturación › Configuración)`), { validacion: true });
    const tipo = body.tipo || sugerirTipo(body.cliente || venta.cliente, cfg);
    if (!['factura', 'boleta'].includes(tipo)) throw Object.assign(new Error('Tipo no válido'), { validacion: true });

    // Ítems: los enviados por el vendedor, o los pendientes por defecto (lote)
    const porId = Object.fromEntries(venta.items.map(i => [i.sale_item_id, i]));
    let items;
    if (Array.isArray(body.items)) {
      items = body.items.map(it => {
        const o = it.sale_item_id ? porId[it.sale_item_id] : null;
        if (it.sale_item_id && !o) throw Object.assign(new Error('Un ítem no pertenece a la venta'), { validacion: true });
        if (o && Number(it.cantidad) > o.cantidad + 1e-9) throw Object.assign(new Error(`"${o.descripcion}": solo quedan ${o.cantidad} por facturar`), { validacion: true });
        return { sale_item_id: it.sale_item_id || null, codigo: it.codigo != null ? it.codigo : (o && o.codigo), descripcion: it.descripcion || (o && o.descripcion),
          cantidad: it.cantidad, precio: it.precio != null ? it.precio : (o && o.precio) };
      });
    } else {
      if (venta.externo > 0.009) throw Object.assign(new Error(`${venta.code} ya tiene comprobantes hechos fuera del portal: revísala y emite a mano`), { validacion: true });
      items = venta.items.filter(i => i.cantidad > 0).map(i => ({ sale_item_id: i.sale_item_id, codigo: i.codigo, descripcion: i.descripcion, cantidad: i.cantidad, precio: i.precio }));
    }
    const totalNuevo = r2(items.reduce((s, i) => s + r2(Number(i.precio) * Number(i.cantidad)), 0));
    if (totalNuevo > venta.pendiente + 0.05)
      throw Object.assign(new Error(`${venta.code}: el comprobante (S/ ${totalNuevo.toFixed(2)}) supera lo pendiente de facturar (S/ ${venta.pendiente.toFixed(2)})`), { validacion: true });

    const cliente = { ...venta.cliente, ...(body.cliente || {}) };
    if (body.cliente && body.cliente.doc != null && !body.cliente.tipo_doc) cliente.tipo_doc = tipoDocCliente(body.cliente.doc);
    let credito = null;
    if (tipo === 'factura') {
      const saldo = r2(venta.total - venta.pagado);
      if (body.credito === false) credito = null;
      else if (body.credito && typeof body.credito === 'object') credito = body.credito;
      else if (saldo > 0.009) credito = { fecha_pago: sumarDias(hoyLima(), 30), importe: Math.min(saldo, totalNuevo) };
    }
    const datos = { fecha: body.fecha || hoyLima(), cliente, items, credito, observaciones: body.observaciones || `Venta ${venta.code}`,
      enviar_email: body.enviar_email != null ? !!body.enviar_email : cfg.enviar_email, formato_pdf: cfg.formato_pdf };
    return { venta, cfg, tipo, datos };
  }

  // ════════════════════════ ENDPOINTS ════════════════════════

  // Estado general: proveedor, empresas conectadas y si el ERP se actualiza solo
  app.get('/api/fe/estado', authAdmin, mFe, async (req, res) => {
    try {
      const cfgs = await leerConfig();
      const [pend] = await portalPool.query(`SELECT company_id, erp_estado, COUNT(*) n FROM fe_comprobantes
        WHERE tipo <> 'nc' AND estado IN ('aceptado','pendiente_sunat') AND erp_estado IN ('pendiente','error') GROUP BY company_id, erp_estado`);
      const [inc] = await portalPool.query(`SELECT COUNT(*) n FROM fe_comprobantes WHERE estado IN ('incierto','pendiente_sunat')`);
      res.json({
        maestro: !!(req.admin && req.admin.maestro),
        erp_automatico: !!erpWritePool,
        por_anotar_erp: pend.reduce((s, x) => s + x.n, 0),
        por_verificar: inc[0].n,
        motivos_nc: MOTIVOS_NC,
        proveedor: nombreProv(Number(Object.keys(empresas)[0])), en_pruebas: enPruebas,
        correo: { lo_envia_proveedor: NOMBRE_PROV === 'nubefact', resend: !!process.env.RESEND_API_KEY },
        empresas: Object.keys(empresas).map(id => ({ id: Number(id), nombre: empresas[id], conectado: !!(proveedorFactory ? proveedor(Number(id)) : credenciales(id)),
          variables: varsFaltan(id), ...cfgs[id] }))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ventas con saldo sin comprobante
  app.get('/api/fe/por-facturar', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const q = req.query;
      const desde = esFecha(q.desde) ? q.desde : sumarDias(hoyLima(), -60);
      const hasta = esFecha(q.hasta) ? q.hasta : hoyLima();
      const cond = ['s.deleted_at IS NULL', `s.status IN (${VENTAS_VALIDAS.map(() => '?').join(',')})`, 's.created_at >= ?', 's.created_at < DATE_ADD(?, INTERVAL 1 DAY)'];
      const params = [...VENTAS_VALIDAS, desde, hasta];
      if (q.empresa) { cond.push('s.company_id = ?'); params.push(Number(q.empresa)); }
      if (q.q) {
        const t = '%' + String(q.q).trim() + '%';
        cond.push(`(s.code LIKE ? OR cli.document_number LIKE ? OR cli.business_name LIKE ? OR CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,'')) LIKE ?)`);
        params.push(t, t, t, t);
      }
      const [ids] = await prodPool.query(`SELECT s.id FROM sales s LEFT JOIN parties cli ON cli.id = s.customer_id
        WHERE ${cond.join(' AND ')} ORDER BY s.created_at DESC LIMIT 1500`, params);
      const ventas = await leerVentas(ids.map(x => x.id));
      const cfgs = await leerConfig();
      const lista = ventas
        .filter(v => q.todas === '1' || v.pendiente > 0.009)
        .filter(v => q.solo_pagadas !== '1' || v.pagado + 0.009 >= v.total)
        .map(v => ({ ...v, tipo_sugerido: sugerirTipo(v.cliente, cfgs[v.company_id]), items: undefined,
          n_items: v.items.length, parcial: v.facturado > 0.009 }))
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      res.json({ desde, hasta, ventas: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Detalle de una venta para armar el comprobante
  app.get('/api/fe/venta/:id', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const [v] = await leerVentas([Number(req.params.id)]);
      if (!v) return res.status(404).json({ error: 'Venta no encontrada' });
      const cfgs = await leerConfig();
      const saldo = r2(v.total - v.pagado);
      res.json({ ...v, tipo_sugerido: sugerirTipo(v.cliente, cfgs[v.company_id]), cfg: cfgs[v.company_id] || null,
        hoy: hoyLima(), fecha_min: sumarDias(hoyLima(), -2), saldo_por_cobrar: saldo, credito_sugerido: saldo > 0.009 ? { fecha_pago: sumarDias(hoyLima(), 30), importe: saldo } : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Vista previa (no emite): totales, avisos y errores
  app.post('/api/fe/previsualizar', authAdmin, mFe, async (req, res) => {
    try {
      const cfgs = await leerConfig();
      const { cfg, tipo, datos } = await prepararDesdeVenta(req.body || {}, cfgs);
      const a = armarComprobante({ ...datos, tipo, serie: seriePara(cfg, tipo), numero: 0 }, cfg);
      res.json({ tipo, serie: seriePara(cfg, tipo), total: a.total, total_igv: a.total_igv, errores: a.errores, avisos: a.avisos, cliente: a.doc.cliente });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  // Emitir un comprobante desde una venta
  app.post('/api/fe/emitir', authAdmin, mFe, async (req, res) => {
    try {
      const cfgs = await leerConfig();
      const { venta, cfg, tipo, datos } = await prepararDesdeVenta(req.body || {}, cfgs);
      const r = await emitirDocumento({ companyId: venta.company_id, tipo, serie: seriePara(cfg, tipo), datos, cfg, venta, usuario: quien(req) });
      res.json({ ok: true, comprobante: r });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  // Emitir en lote: [{sale_id, tipo?}] con los datos por defecto de cada venta
  app.post('/api/fe/emitir-lote', authAdmin, mFe, async (req, res) => {
    const lista = Array.isArray(req.body && req.body.ventas) ? req.body.ventas.slice(0, 100) : [];
    if (!lista.length) return res.status(400).json({ error: 'No elegiste ventas' });
    try {
      const cfgs = await leerConfig();
      const resultados = [];
      for (const it of lista) {
        try {
          const { venta, cfg, tipo, datos } = await prepararDesdeVenta({ sale_id: it.sale_id, tipo: it.tipo, enviar_email: req.body.enviar_email }, cfgs);
          const r = await emitirDocumento({ companyId: venta.company_id, tipo, serie: seriePara(cfg, tipo), datos, cfg, venta, usuario: quien(req) });
          resultados.push({ sale_id: it.sale_id, ok: true, comprobante: r });
        } catch (e) { resultados.push({ sale_id: it.sale_id, ok: false, error: e.message }); }
      }
      res.json({ resultados, ok: resultados.filter(r => r.ok).length, fallidos: resultados.filter(r => !r.ok).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Comprobantes emitidos desde el portal
  app.get('/api/fe/emitidos', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const q = req.query;
      const cond = ['1=1'], params = [];
      if (esFecha(q.desde)) { cond.push('fecha_emision >= ?'); params.push(q.desde); }
      if (esFecha(q.hasta)) { cond.push('fecha_emision <= ?'); params.push(q.hasta); }
      if (q.empresa) { cond.push('company_id = ?'); params.push(Number(q.empresa)); }
      if (q.tipo) { cond.push('tipo = ?'); params.push(q.tipo); }
      if (q.estado === 'erp') cond.push(`tipo <> 'nc' AND estado IN ('aceptado','pendiente_sunat') AND erp_estado IN ('pendiente','error')`);
      else if (q.estado === 'revisar') cond.push(`estado IN ('incierto','pendiente_sunat','rechazado')`);
      else if (q.estado) { cond.push('estado = ?'); params.push(q.estado); }
      if (q.q) { const t = '%' + String(q.q).trim() + '%'; cond.push(`(cliente_nombre LIKE ? OR cliente_doc LIKE ? OR sale_code LIKE ? OR CONCAT(serie,'-',numero) LIKE ?)`); params.push(t, t, t, t); }
      const [rows] = await portalPool.query(`SELECT id, company_id, tipo, serie, numero, sale_id, sale_code, fecha_emision, cliente_tipo_doc, cliente_doc, cliente_nombre,
        cliente_email, cliente_telefono, total, total_igv, credito, estado, sunat_desc, enlace, enlace_pdf, enlace_xml, enlace_cdr, ref_id, ref_tipo, ref_serie, ref_numero,
        nc_motivo, anulado_por_nc, erp_estado, erp_error, email_enviado, emitido_por, creado
        FROM fe_comprobantes WHERE ${cond.join(' AND ')} AND estado <> 'enviando' ORDER BY creado DESC LIMIT 1000`, params);
      res.json({ comprobantes: rows.map(r => ({ ...r, empresa: empresas[r.company_id] || '' })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function leerComp(id) {
    await listo();
    const [[c]] = await portalPool.query(`SELECT * FROM fe_comprobantes WHERE id = ?`, [Number(id)]);
    return c || null;
  }

  // Guarda el resultado de una consulta/reintento y, si quedó válido, lo registra en el ERP
  async function aplicarResultado(c, est, req, conRespuesta) {
    await portalPool.query(`UPDATE fe_comprobantes SET estado=?, sunat_desc=?, enlace=COALESCE(?,enlace), enlace_pdf=COALESCE(?,enlace_pdf),
      enlace_xml=COALESCE(?,enlace_xml), enlace_cdr=COALESCE(?,enlace_cdr), respuesta=COALESCE(?,respuesta), actualizado=NOW() WHERE id=?`,
      [est.estado, est.sunat_desc || null, est.enlace, est.enlace_pdf, est.enlace_xml, est.enlace_cdr,
        conRespuesta && est.raw ? JSON.stringify(est.raw).slice(0, 60000) : null, c.id]);
    if (est.estado !== 'rechazado' && ['pendiente', 'error'].includes(c.erp_estado) && c.tipo !== 'nc') {
      const erp = await registrarEnERP({ ...c, fecha_emision: isoFecha(c.fecha_emision) }, quien(req));
      await portalPool.query(`UPDATE fe_comprobantes SET erp_estado=?, erp_error=?, erp_en=IF(?='registrado',NOW(),erp_en) WHERE id=?`, [erp.erp_estado, erp.erp_error, erp.erp_estado, c.id]);
    }
    // El correo que no salió porque aún no había PDF
    const doc = JSON.parse(c.payload || '{}');
    if (est.estado !== 'rechazado' && est.enlace_pdf && doc.enviar_email && !c.email_enviado && !proveedor(c.company_id).envia_email) {
      const m = await enviarCorreo({ ...c, ...est });
      if (m.ok) await portalPool.query(`UPDATE fe_comprobantes SET email_enviado=1 WHERE id=?`, [c.id]);
    }
    const { raw, ...resto } = est;
    return resto;
  }

  // Consultar en el proveedor el estado (para "pendiente SUNAT" o "incierto")
  app.post('/api/fe/:id/consultar', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      const prov = proveedor(c.company_id);
      if (!prov) return res.status(400).json({ error: `Falta conectar ${nombreProv(c.company_id)} para esta empresa` });
      let est;
      try { est = await prov.consultar(c.tipo, c.serie, c.numero, JSON.parse(c.payload || '{}').formato_pdf); }
      catch (e) {
        if (c.estado === 'incierto' && e.noExiste) return res.json({ ok: true, estado: 'incierto', mensaje: `${prov.nombre} no tiene este comprobante: usa "Reintentar" para enviarlo con el mismo número` });
        throw e;
      }
      res.json({ ok: true, ...(await aplicarResultado(c, est, req, false)) });
    } catch (e) { res.status(500).json({ error: 'No se pudo consultar: ' + e.message }); }
  });

  // Reintentar un comprobante incierto con el MISMO número y los mismos datos
  app.post('/api/fe/:id/reintentar', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      if (c.estado !== 'incierto') return res.status(400).json({ error: 'Solo se reintentan comprobantes sin respuesta' });
      const prov = proveedor(c.company_id);
      if (!prov) return res.status(400).json({ error: `Falta conectar ${nombreProv(c.company_id)} para esta empresa` });
      const doc = JSON.parse(c.payload);
      let est;
      try { est = await prov.emitir(doc); }
      catch (e) { if (e.duplicado) est = await prov.consultar(c.tipo, c.serie, c.numero, doc.formato_pdf); else throw e; }
      res.json({ ok: true, ...(await aplicarResultado(c, est, req, true)) });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  // Reenviar el PDF al correo del cliente (puede corregirse el correo)
  app.post('/api/fe/:id/email', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      const email = limpiar(req.body && req.body.email, 120) || c.cliente_email;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return res.status(400).json({ error: 'Correo no válido' });
      const m = await enviarCorreo({ ...c, cliente_email: email });
      if (!m.ok) return res.status(400).json({ error: m.error });
      await portalPool.query(`UPDATE fe_comprobantes SET email_enviado=1, cliente_email=? WHERE id=?`, [email, c.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Registrar en el ERP: reintento automático, o marcar "anotado a mano"
  app.post('/api/fe/:id/erp', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      if (req.body && req.body.manual) {
        await portalPool.query(`UPDATE fe_comprobantes SET erp_estado='registrado', erp_error=NULL, erp_por=?, erp_en=NOW() WHERE id=?`, [quien(req) + ' (a mano)', c.id]);
        return res.json({ ok: true, erp_estado: 'registrado' });
      }
      const erp = await registrarEnERP({ ...c, fecha_emision: isoFecha(c.fecha_emision) }, quien(req));
      await portalPool.query(`UPDATE fe_comprobantes SET erp_estado=?, erp_error=?, erp_por=?, erp_en=IF(?='registrado',NOW(),erp_en) WHERE id=?`,
        [erp.erp_estado, erp.erp_error, erp.erp_por || null, erp.erp_estado, c.id]);
      res.json({ ok: erp.erp_estado === 'registrado', ...erp });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ítems de un comprobante (para armar la nota de crédito)
  app.get('/api/fe/:id/detalle', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      const p = JSON.parse(c.payload || '{}');
      const [vinc] = await portalPool.query(`SELECT sale_item_id FROM fe_comprobante_items WHERE comprobante_id = ?`, [c.id]);
      const [ncs] = await portalPool.query(`SELECT id, serie, numero, total, nc_motivo, estado FROM fe_comprobantes WHERE ref_id = ? AND tipo='nc' AND estado NOT IN ('error','enviando')`, [c.id]);
      const yaNC = r2(ncs.reduce((s, x) => s + Number(x.total), 0));
      const items = (p.items || []).map((it, i) => ({ codigo: it.codigo, descripcion: it.descripcion, cantidad: Number(it.cantidad),
        precio: Number(it.precio_unitario), total: Number(it.total), sale_item_id: (vinc[i] && vinc[i].sale_item_id) || null }));
      res.json({ id: c.id, tipo: c.tipo, serie: c.serie, numero: c.numero, total: Number(c.total), cliente_nombre: c.cliente_nombre,
        items, notas_credito: ncs, disponible_nc: r2(Number(c.total) - yaNC), anulado_por_nc: c.anulado_por_nc });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Nota de crédito sobre un comprobante emitido desde el portal
  //  body: { motivo, items?: [{indice, cantidad, precio?}], descripcion? (motivo 9), monto? (motivo 9) }
  app.post('/api/fe/:id/nota-credito', authAdmin, mFe, async (req, res) => {
    try {
      const c = await leerComp(req.params.id);
      if (!c) return res.status(404).json({ error: 'No existe' });
      if (c.tipo === 'nc') return res.status(400).json({ error: 'No se hace nota de crédito sobre otra nota' });
      if (!['aceptado', 'pendiente_sunat'].includes(c.estado)) return res.status(400).json({ error: 'El comprobante no está aceptado por SUNAT' });
      if (c.anulado_por_nc) return res.status(400).json({ error: 'El comprobante ya fue anulado con una nota de crédito' });
      const cfgs = await leerConfig();
      const cfg = cfgs[c.company_id];
      const motivo = Number(req.body && req.body.motivo);
      if (!MOTIVOS_NC[motivo]) return res.status(400).json({ error: 'Elige el motivo' });
      const orig = JSON.parse(c.payload || '{}');
      const [vinc] = await portalPool.query(`SELECT sale_item_id, cantidad FROM fe_comprobante_items WHERE comprobante_id = ?`, [c.id]);
      const [ncPrev] = await portalPool.query(`SELECT COALESCE(SUM(total),0) t FROM fe_comprobantes WHERE ref_id = ? AND tipo='nc' AND estado NOT IN ('error','enviando')`, [c.id]);
      const disponible = r2(Number(c.total) - Number(ncPrev[0].t));
      const base = (orig.items || []).map((it, i) => ({ codigo: it.codigo, descripcion: it.descripcion, cantidad: Number(it.cantidad), precio: Number(it.precio_unitario), sale_item_id: vinc[i] ? vinc[i].sale_item_id : null }));
      let items;
      if (MOTIVOS_NC_TOTALES.includes(motivo)) {
        if (Number(ncPrev[0].t) > 0) return res.status(400).json({ error: 'Ya hay notas de crédito parciales; usa "Devolución por ítem" o "Disminución en el valor"' });
        items = base;
      } else if (motivo === 7) {
        items = (req.body.items || []).map(x => {
          const o = base[Number(x.indice)];
          if (!o) throw Object.assign(new Error('Ítem no válido'), { validacion: true });
          if (Number(x.cantidad) > o.cantidad + 1e-9) throw Object.assign(new Error(`"${o.descripcion}": máximo ${o.cantidad}`), { validacion: true });
          return { ...o, cantidad: Number(x.cantidad) };
        }).filter(x => x.cantidad > 0);
      } else { // 9: disminución en el valor
        const monto = r2(req.body.monto);
        items = [{ codigo: '', descripcion: limpiar(req.body.descripcion) || 'Descuento posterior a la venta', cantidad: 1, precio: monto, sale_item_id: null }];
      }
      const cliente = { tipo_doc: c.cliente_tipo_doc, doc: c.cliente_doc, nombre: c.cliente_nombre, direccion: (orig.cliente || {}).direccion, email: c.cliente_email };
      const datos = { fecha: hoyLima(), cliente, items, nc: { ref_tipo: c.tipo, ref_serie: c.serie, ref_numero: c.numero, motivo, total_ref: disponible },
        observaciones: limpiar(req.body.observaciones) || MOTIVOS_NC[motivo], enviar_email: cfg.enviar_email, formato_pdf: cfg.formato_pdf };
      // Las devoluciones se vinculan a los ítems de la venta (vuelve a quedar pendiente lo devuelto)
      const vinculo = motivo !== 9;
      const r = await emitirDocumento({ companyId: c.company_id, tipo: 'nc', serie: seriePara(cfg, 'nc', c.tipo), datos, cfg,
        venta: c.sale_id ? { id: c.sale_id, code: c.sale_code } : null, refComp: c, usuario: quien(req),
        items_origen_override: vinculo ? items.map(x => ({ sale_item_id: x.sale_item_id, cantidad: x.cantidad, total: r2(x.cantidad * x.precio) })) : [] });
      res.json({ ok: true, comprobante: r });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  // Configuración por empresa (solo maestro)
  app.put('/api/fe/config/:empresa', authAdmin, mFe, soloMaestro, async (req, res) => {
    try {
      await listo();
      const id = Number(req.params.empresa);
      if (!empresas[id]) return res.status(404).json({ error: 'Empresa no válida' });
      const b = req.body || {};
      const serie = (s, letra) => { const v = String(s || '').toUpperCase().trim(); if (!new RegExp('^' + letra + '[A-Z0-9]{3}$').test(v)) throw Object.assign(new Error(`La serie "${v}" debe tener 4 caracteres y empezar con ${letra}`), { validacion: true }); return v; };
      const vals = {
        activo: b.activo ? 1 : 0,
        serie_factura: serie(b.serie_factura, 'F'), serie_boleta: serie(b.serie_boleta, 'B'),
        serie_nc_factura: serie(b.serie_nc_factura, 'F'), serie_nc_boleta: serie(b.serie_nc_boleta, 'B'),
        afectacion: AFECTACIONES.includes(b.afectacion) ? b.afectacion : 'gravado',
        solo_boletas: b.afectacion === 'nrus' ? 1 : 0, enviar_email: b.enviar_email ? 1 : 0,
        formato_pdf: ['A4', 'A5', 'TICKET'].includes(b.formato_pdf) ? b.formato_pdf : 'A4'
      };
      const [otras] = await portalPool.query(`SELECT company_id, serie_factura, serie_boleta, serie_nc_factura, serie_nc_boleta FROM fe_config WHERE company_id <> ?`, [id]);
      const mias = [vals.serie_factura, vals.serie_boleta, vals.serie_nc_factura, vals.serie_nc_boleta];
      const choque = otras.find(o => [o.serie_factura, o.serie_boleta, o.serie_nc_factura, o.serie_nc_boleta].some(x => mias.includes(x)));
      if (choque) return res.status(400).json({ error: `Usa series distintas a las de ${empresas[choque.company_id]}: el sistema y el cruce con SUNAT no distinguen empresa` });
      await portalPool.query(`UPDATE fe_config SET ?, actualizado_por=?, actualizado=NOW() WHERE company_id=?`, [vals, quien(req), id]);
      // Último número usado por serie (para continuar una serie ya usada en el panel del proveedor)
      for (const [s, v] of Object.entries(b.correlativos || {})) {
        if (!/^[FB][A-Z0-9]{3}$/.test(s) || !(Number(v) >= 0)) continue;
        await portalPool.query(`INSERT INTO fe_correlativos (company_id, serie, ultimo) VALUES (?,?,?) ON DUPLICATE KEY UPDATE ultimo=GREATEST(ultimo, VALUES(ultimo))`, [id, s, Number(v)]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  app.get('/api/fe/correlativos', authAdmin, mFe, async (req, res) => {
    try { await listo(); const [r] = await portalPool.query(`SELECT * FROM fe_correlativos ORDER BY company_id, serie`); res.json({ correlativos: r }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { _test: { armarComprobante, calcularFacturado, itemsPendientes, tipoDocCliente, sugerirTipo, proveedorNubefact, proveedorApisunat } };
};

module.exports._test = { armarComprobante, calcularFacturado, itemsPendientes, tipoDocCliente, sugerirTipo, proveedorNubefact, proveedorApisunat, apisunatJSON, nubefactJSON, MOTIVOS_NC };
