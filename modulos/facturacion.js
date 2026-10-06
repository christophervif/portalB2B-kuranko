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
//    ERP_ESCRITURA_URL (opcional; antes ERP_FACTURACION_URL) → MySQL del ERP con un usuario que SOLO tenga
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
// Tipo de cambio de referencia SOLO para el tope de S/ 700 en boletas en dólares
// cuando la venta no trae tipo de cambio (Railway FE_TC_REFERENCIA).
const TC_REFERENCIA = Number(process.env.FE_TC_REFERENCIA) || 3.8;
// Moneda de la venta del ERP → 'USD' | 'PEN' (acepta código, nombre o símbolo)
function monedaDe(...vals) {
  const t = vals.filter(v => v != null && v !== '').map(v => String(v).trim()).join(' ');
  if (!t) return 'PEN';
  // tolera tildes dañadas por codificación ("DÃ³lares")
  return /\busd\b|d\S{0,3}lar|us\$|(^|\s)\$(\s|$)/i.test(t) ? 'USD' : 'PEN';
}
const SIMBOLO = { PEN: 'S/', USD: 'US$' };
const dinero = (n, mon) => `${SIMBOLO[mon] || 'S/'} ${Number(n || 0).toFixed(2)}`;
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
// Número con ceros como en el PDF (F001-000001). Para SUNAT 1 = 000001 = 00000001.
const DIGITOS_NUM = Math.min(8, Math.max(1, Number(process.env.FE_DIGITOS_NUMERO) || 6));
const numDoc = (serie, numero) => `${serie}-${String(numero).padStart(DIGITOS_NUM, '0')}`;
const normDoc = t => { const m = String(t || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z0-9]{4})-?0*(\d+)$/); return m ? `${m[1]}-${Number(m[2])}` : String(t || '').toUpperCase().trim(); };
// ¿El texto ya menciona este comprobante, escrito con o sin ceros? (F001-1, F001 - 000001…)
const mencionaDoc = (texto, serie, numero) => new RegExp(`${String(serie).replace(/[^A-Z0-9]/gi, '')}\\s*-\\s*0*${Number(numero)}(?!\\d)`, 'i').test(String(texto || ''));

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
      sale_item_id: it.sale_item_id != null && it.sale_item_id !== '' ? Number(it.sale_item_id) : null
    });
  });
  if (!items.length) errores.push('El comprobante no tiene ítems');

  const totalItems = r2(items.reduce((s, x) => s + x.total, 0));
  const igvItems = r2(items.reduce((s, x) => s + x.igv, 0));
  // Anticipos que este comprobante final descuenta (montos con IGV, en su moneda)
  const anticipos = (datos.anticipos || []).map(a => ({ tipo: a.tipo, serie: a.serie, numero: a.numero, monto: r2(a.monto) }));
  const totalAnt = r2(anticipos.reduce((s, a) => s + a.monto, 0));
  const igvAnt = conIgv ? r2(totalAnt - totalAnt / (1 + IGV_PCT / 100)) : 0;
  anticipos.forEach(a => { if (a.tipo !== tipo) errores.push(`El anticipo ${a.serie}-${a.numero} es ${a.tipo}: el comprobante final también debe ser ${a.tipo}`); });
  if (totalAnt > 0 && totalItems - totalAnt < -0.001) errores.push('Los anticipos superan el total del comprobante');
  const total = r2(Math.max(0, totalItems - totalAnt));
  const totalIgv = r2(Math.max(0, igvItems - igvAnt));
  const moneda = datos.moneda === 'USD' ? 'USD' : 'PEN';
  const tc = Number(datos.tipo_cambio) > 0 ? Number(datos.tipo_cambio) : TC_REFERENCIA;
  const totalSoles = moneda === 'USD' ? total * tc : total;

  // Reglas del cliente según el tipo
  const tipoBase = tipo === 'nc' ? (datos.nc && datos.nc.ref_tipo) : tipo;
  if (tipoBase === 'factura') {
    if (tipoDoc !== '6' || tipoDocCliente(doc) !== '6') errores.push(/^\d{8}$/.test(doc) ? 'La factura exige RUC y el número tiene 8 dígitos (es un DNI): emite boleta o pide el RUC' : 'La factura exige un RUC válido (11 dígitos)');
    if (!nombre) errores.push('Falta la razón social del cliente');
    if (!limpiar(cli.direccion)) avisos.push('El cliente no tiene dirección; la factura sale sin dirección');
    if (cli.sunat_estado && !/ACTIVO/i.test(cli.sunat_estado)) avisos.push(`SUNAT: el RUC figura ${cli.sunat_estado}. Revisa antes de facturar`);
    else if (cli.sunat_estado && /NO HALLADO|NO HABIDO/i.test(cli.sunat_estado)) avisos.push(`SUNAT: el RUC figura ${cli.sunat_estado}`);
  } else if (tipoBase === 'boleta') {
    if (tipoDoc === '6' && doc && doc !== '-' && tipoDocCliente(doc) !== '6')
      errores.push(/^\d{8}$/.test(doc) ? 'Elegiste RUC pero el número tiene 8 dígitos (parece un DNI): cambia el tipo de documento' : 'El RUC no es válido (11 dígitos, empieza con 10, 15, 16, 17 o 20)');
    if (['4', '7'].includes(tipoDoc) && !/^[A-Za-z0-9]{6,15}$/.test(doc)) errores.push('El carné de extranjería o pasaporte no es válido');
    if (!doc || doc === '-' || !tipoDoc || tipoDoc === '-') {
      if (totalSoles >= TOPE_BOLETA_SIN_DOC) errores.push(`Boletas desde S/ ${TOPE_BOLETA_SIN_DOC}${moneda === 'USD' ? ` (≈ US$ ${(TOPE_BOLETA_SIN_DOC / tc).toFixed(2)})` : ''} exigen DNI u otro documento del cliente`);
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
    moneda, tipo_cambio: Number(datos.tipo_cambio) > 0 ? Number(datos.tipo_cambio) : null,
    cliente: { tipo_doc: tipoDoc, doc, nombre, direccion: limpiar(cli.direccion), email },
    items: items.map(x => ({ ...x })), // incluye sale_item_id (los proveedores solo envían sus campos)
    totales: { gravada: conIgv ? r2(total - totalIgv) : 0, exonerada: afect === 'exonerado' ? total : 0,
      inafecta: afect === 'inafecto' || afect === 'nrus' ? total : 0, igv: totalIgv, total },
    credito: null, nc: null,
    anticipos, total_items: totalItems, es_anticipo: !!datos.es_anticipo,
    observaciones: limpiar(datos.observaciones, 500),
    enviar_email: !!(datos.enviar_email && email),
    formato_pdf: datos.formato_pdf || 'A4'
  };

  // Factura al crédito: SUNAT exige indicar las cuotas
  if (tipo === 'factura' && datos.credito && total > 0) {
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

  return { doc: docN, errores, avisos, total, total_igv: totalIgv, total_items: totalItems, total_anticipos: totalAnt, items_origen: items.map(x => ({ sale_item_id: x.sale_item_id, cantidad: x.cantidad, total: x.total })) };
}

// ─── Guía de remisión remitente ─────────────────────────────────────────────
// Motivos de traslado (catálogo 20 de SUNAT) que usa el portal
const MOTIVOS_GRE = { '01': 'Venta', '02': 'Compra', '04': 'Traslado entre establecimientos de la misma empresa', '05': 'Consignación', '06': 'Devolución', '13': 'Otros' };
const esUbigeo = u => /^\d{6}$/.test(String(u || ''));
// datos = { serie, numero, fecha, fecha_traslado, motivo, motivo_desc, modalidad: '01' público | '02' privado,
//   destinatario:{tipo_doc,doc,nombre,direccion,email}, partida:{ubigeo,direccion}, llegada:{ubigeo,direccion},
//   peso, bultos, transportista:{ruc,denominacion,mtc}, conductor:{tipo_doc,doc,nombres,apellidos,licencia},
//   vehiculo:{placa}, items:[{codigo,descripcion,cantidad,unidad}], relacionados:[{tipo,serie,numero,ruc_emisor}],
//   observaciones, enviar_email, formato_pdf }
function armarGuia(datos) {
  const errores = [], avisos = [];
  const fecha = esFecha(datos.fecha) ? datos.fecha : hoyLima();
  const fTras = esFecha(datos.fecha_traslado) ? datos.fecha_traslado : fecha;
  if (fecha > hoyLima()) errores.push('La fecha de emisión no puede ser futura');
  if (fTras < fecha) errores.push('El traslado no puede empezar antes de la emisión');
  const motivo = MOTIVOS_GRE[datos.motivo] ? datos.motivo : null;
  if (!motivo) errores.push('Elige el motivo del traslado');
  if (motivo === '13' && !limpiar(datos.motivo_desc)) errores.push('Describe el motivo del traslado');
  const modalidad = datos.modalidad === '02' ? '02' : datos.modalidad === '01' ? '01' : null;
  if (!modalidad) errores.push('Elige el tipo de transporte (agencia o propio)');

  const d = datos.destinatario || {};
  let tdoc = String(d.tipo_doc || tipoDocCliente(d.doc) || '').trim();
  const ddoc = String(d.doc || '').replace(/\s/g, '');
  if (!ddoc || tdoc === '-' || !tdoc) errores.push('La guía exige el documento del destinatario (RUC, DNI…)');
  else if (tdoc === '6' && tipoDocCliente(ddoc) !== '6') errores.push('El RUC del destinatario no es válido');
  else if (tdoc === '1' && !/^\d{8}$/.test(ddoc)) errores.push('El DNI del destinatario debe tener 8 dígitos');
  if (!limpiar(d.nombre)) errores.push('Falta el nombre del destinatario');

  const pt = datos.partida || {}, ll = datos.llegada || {};
  if (!esUbigeo(pt.ubigeo) || !limpiar(pt.direccion)) errores.push('Falta el punto de partida (dirección y ubigeo): configúralo en Configuración');
  if (!esUbigeo(ll.ubigeo)) errores.push('Elige el distrito (ubigeo) del punto de llegada');
  if (!limpiar(ll.direccion)) errores.push('Falta la dirección de llegada');

  const peso = Number(datos.peso), bultos = Math.round(Number(datos.bultos) || 0);
  if (!(peso > 0)) errores.push('Indica el peso bruto total (kg)');
  if (!(bultos >= 1)) errores.push('Indica el número de bultos');

  const t = datos.transportista || {}, c = datos.conductor || {}, v = datos.vehiculo || {};
  if (modalidad === '01') {
    if (tipoDocCliente(t.ruc) !== '6') errores.push('Elige la agencia de transporte (RUC válido)');
    if (!limpiar(t.denominacion)) errores.push('Falta la razón social de la agencia');
  } else if (modalidad === '02') {
    if (!/^[A-Z0-9-]{5,8}$/i.test(String(v.placa || '').replace(/\s/g, ''))) errores.push('Indica la placa del vehículo');
    if (!limpiar(c.doc) || !limpiar(c.nombres) || !limpiar(c.apellidos)) errores.push('Completa el conductor (documento, nombres y apellidos)');
    if (!limpiar(c.licencia)) errores.push('Falta la licencia de conducir del conductor');
  }

  const items = (datos.items || []).filter(it => Number(it.cantidad) > 0).map(it => ({
    codigo: limpiar(it.codigo, 30), descripcion: limpiar(it.descripcion, 250), cantidad: r10(Number(it.cantidad)), unidad: it.unidad || 'NIU' }));
  if (!items.length) errores.push('La guía no tiene productos');
  items.forEach((it, i) => { if (!it.descripcion) errores.push(`Producto ${i + 1}: falta la descripción`); });
  if (motivo === '01' && !(datos.relacionados || []).length) avisos.push('La guía de una venta suele llevar la factura o boleta relacionada');

  const doc = {
    tipo: 'guia', serie: datos.serie, numero: datos.numero, fecha, moneda: 'PEN',
    cliente: { tipo_doc: tdoc, doc: ddoc, nombre: limpiar(d.nombre, 200), direccion: limpiar(d.direccion), email: limpiar(d.email, 120) },
    guia: {
      motivo, motivo_desc: limpiar(datos.motivo_desc, 100), modalidad, fecha_traslado: fTras,
      partida: { ubigeo: String(pt.ubigeo || ''), direccion: limpiar(pt.direccion) },
      llegada: { ubigeo: String(ll.ubigeo || ''), direccion: limpiar(ll.direccion) },
      peso: Math.round(peso * 1000) / 1000, bultos,
      transportista: modalidad === '01' ? { ruc: String(t.ruc || '').trim(), denominacion: limpiar(t.denominacion, 200), mtc: limpiar(t.mtc, 20) } : null,
      conductor: modalidad === '02' ? { tipo_doc: c.tipo_doc || '1', doc: limpiar(c.doc, 15), nombres: limpiar(c.nombres, 100), apellidos: limpiar(c.apellidos, 100), licencia: limpiar(c.licencia, 20) } : null,
      vehiculo: modalidad === '02' ? { placa: String(v.placa || '').replace(/[\s-]/g, '').toUpperCase() } : null,
      relacionados: (datos.relacionados || []).map(r => ({ tipo: r.tipo, serie: r.serie, numero: r.numero, ruc_emisor: r.ruc_emisor || '' }))
    },
    items, totales: { total: 0, igv: 0 },
    observaciones: limpiar(datos.observaciones, 500),
    enviar_email: !!(datos.enviar_email && limpiar(d.email)), formato_pdf: datos.formato_pdf || 'A4'
  };
  if (datos.enviar_email && !limpiar(d.email)) avisos.push('El destinatario no tiene correo: no se le enviará la guía');
  return { doc, errores, avisos, total: 0, total_igv: 0, items_origen: [] };
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
    // monto_venta = importe en la moneda de la venta (si el comprobante salió en otra moneda)
    const monto = Number(c.monto_venta != null ? c.monto_venta : c.total) || 0;
    if (c.tipo === 'nc') { facturado -= monto; lista.push({ origen: 'portal', tipo: 'nc', serie: c.serie, numero: c.numero, total: -monto }); return; }
    const k = clave(c.serie, c.numero);
    if (vistos.has(k)) return; vistos.add(k);
    facturado += monto;
    lista.push({ origen: 'portal', tipo: c.tipo, serie: c.serie, numero: c.numero, total: monto, anticipo: !!c.es_anticipo });
  });
  const total = Number(venta.total) || 0;
  return { total: r2(total), facturado: r2(facturado), externo: r2(externo), pendiente: r2(Math.max(0, total - facturado)), comprobantes: lista };
}

// Ítems por defecto para el comprobante: lo que falta facturar de cada línea
// (según lo emitido desde el portal). Si la venta tiene comprobantes hechos fuera
// del portal (SOL), no se puede saber qué ítems cubren: se marcan sin seleccionar.
// sale_item_id 0 = línea de ENVÍO / otros cargos (diferencia entre el total de la venta
// y la suma de sus productos, p. ej. delivery_cost_quoted). Si la suma de productos supera
// el total (descuento global), los precios se prorratean para que cuadren con la venta.
const ID_ENVIO = 0;
function itemsPendientes(itemsERP, facturadoPorItem, hayExterno, totalVenta, envio) {
  const sumItems = r2((itemsERP || []).reduce((s, it) => s + (Number(it.total) || 0), 0));
  const tv = totalVenta == null ? sumItems : Number(totalVenta);
  const factor = tv > 0 && sumItems - tv > 0.009 ? tv / sumItems : 1; // descuento global
  const lineas = (itemsERP || []).map(it => {
    const q = Number(it.quantity) || 0, tot = Number(it.total) || 0;
    const ya = Number((facturadoPorItem || {})[it.id]) || 0;
    const resta = Math.max(0, r10(q - ya));
    return {
      sale_item_id: it.id,
      codigo: (it.sku || '').trim(),
      descripcion: nombreProdVar(it.producto, it.variacion),
      cantidad_venta: q,
      cantidad: resta,
      precio: r10((q > 0 ? tot / q : Number(it.unit_price) || 0) * factor),
      ya_facturado: ya,
      seleccionado: resta > 0 && !hayExterno
    };
  });
  const extra = r2(tv - sumItems);
  if (extra > 0.009) {
    const ya = Number((facturadoPorItem || {})[ID_ENVIO]) || 0;
    const resta = Math.max(0, r10(1 - ya));
    const esEnvio = envio != null && Math.abs(Number(envio) - extra) < 0.011;
    lineas.push({ sale_item_id: ID_ENVIO, codigo: 'ENVIO', unidad: 'ZZ', es_envio: true,
      descripcion: esEnvio || envio == null ? 'Servicio de envío / delivery' : 'Otros cargos de la venta',
      cantidad_venta: 1, cantidad: resta, precio: extra, ya_facturado: ya, seleccionado: resta > 0 && !hayExterno });
  }
  return lineas;
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
const AS_DOC = { factura: 'factura', boleta: 'boleta', nc: 'nota_credito', guia: 'guia_remision_remitente' };
// Guía de remisión remitente → /api/v3/dispatches
function apisunatGuiaJSON(doc) {
  const g = doc.guia;
  const j = {
    documento: 'guia_remision_remitente', serie: doc.serie, numero: String(doc.numero),
    fecha_de_emision: doc.fecha,
    motivo_de_traslado: g.motivo, modalidad_de_transporte: g.modalidad,
    destinatario_tipo_de_documento: doc.cliente.tipo_doc, destinatario_numero_de_documento: doc.cliente.doc,
    destinatario_denominacion: doc.cliente.nombre, destinatario_direccion: doc.cliente.direccion || g.llegada.direccion,
    punto_de_partida_ubigeo: g.partida.ubigeo, punto_de_partida_direccion: g.partida.direccion,
    punto_de_llegada_ubigeo: g.llegada.ubigeo, punto_de_llegada_direccion: g.llegada.direccion,
    peso_bruto_total: String(g.peso), peso_bruto_unidad_de_medida: 'KGM', numero_de_bultos: g.bultos,
    observaciones: doc.observaciones || '',
    items: doc.items.map(it => ({ ...(it.codigo ? { codigo_interno: it.codigo } : {}), descripcion: it.descripcion, unidad_de_medida: it.unidad || 'NIU', cantidad: it.cantidad }))
  };
  if (doc.fecha === hoyLima()) j.hora_de_emision = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Lima', hour12: false });
  if (g.motivo === '13' && g.motivo_desc) j.motivo_de_traslado_descripcion = g.motivo_desc;
  if (g.relacionados.length) j.documentos_relacionados = g.relacionados.map(r => ({ documento: r.tipo, serie: r.serie, numero: String(r.numero), ...(r.ruc_emisor ? { ruc_emisor: r.ruc_emisor } : {}) }));
  if (g.modalidad === '01') {
    j.fecha_entrega_a_transportista = g.fecha_traslado;
    j.transportista = { ruc: g.transportista.ruc, denominacion: g.transportista.denominacion, ...(g.transportista.mtc ? { numero_registro_MTC: g.transportista.mtc } : {}) };
  } else {
    j.fecha_inicio_de_traslado = g.fecha_traslado;
    j.conductores = [{ conductor: 'principal', tipo_de_documento: g.conductor.tipo_doc || '1', numero_de_documento: g.conductor.doc,
      nombres: g.conductor.nombres, apellidos: g.conductor.apellidos, numero_licencia_conducir: g.conductor.licencia }];
    j.vehiculos = [{ vehiculo: 'principal', numero_de_placa: g.vehiculo.placa }];
  }
  return j;
}
const AS_AFECT = { gravado: ['18', '10', 'IGV'], exonerado: ['0', '20', 'EXO'], inafecto: ['0', '30', 'INA'], nrus: ['0', '10', 'IGV'] };
const AS_ESTADO = { ACEPTADO: 'aceptado', OBSERVADO: 'aceptado', PENDIENTE: 'pendiente_sunat', RECHAZADO: 'rechazado', ANULADO: 'aceptado' };
function apisunatJSON(doc) {
  const [pct, cod, trib] = AS_AFECT[doc.afectacion] || AS_AFECT.gravado;
  const sinDoc = doc.cliente.tipo_doc === '-' || doc.cliente.doc === '-';
  const j = {
    documento: AS_DOC[doc.tipo], serie: doc.serie, numero: doc.numero,
    fecha_de_emision: doc.fecha,
    moneda: doc.moneda === 'USD' ? 'USD' : 'PEN',
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
  if (doc.anticipos && doc.anticipos.length)
    j.anticipos = doc.anticipos.map(a => ({ documento: a.tipo, serie: a.serie, numero: String(a.numero), monto: a.monto.toFixed(2) }));
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
    if (status === 401 || status === 403) return errorMarcado((/token/i.test(texto) ? 'Token de APISUNAT no válido: ' : 'APISUNAT no autoriza a esta empresa: ') + texto, { config: true });
    if (consulta && /no se encuentra|no existe|no registrad/i.test(msg)) return errorMarcado(texto, { noExiste: true, validacion: true });
    if (/ya (existe|fue|se encuentra|ha sido)|duplicad|registrado anteriormente/i.test(msg)) return errorMarcado(texto, { duplicado: true, validacion: true });
    return errorMarcado(texto, { validacion: true });
  };
  return {
    nombre: 'APISUNAT', envia_email: false,
    convertir: doc => doc.tipo === 'guia' ? apisunatGuiaJSON(doc) : apisunatJSON(doc),
    async emitir(doc) {
      const esGuia = doc.tipo === 'guia';
      const { status, d } = await postJSON(fetchImpl, base + (esGuia ? '/api/v3/dispatches' : '/api/v3/documents'), auth, esGuia ? apisunatGuiaJSON(doc) : apisunatJSON(doc), timeoutMs);
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
  if (doc.tipo === 'guia') throw errorMarcado('Con NubeFacT el portal no emite guías; emítela desde su panel', { validacion: true });
  if (doc.anticipos && doc.anticipos.length) throw errorMarcado('Con NubeFacT el portal aún no descuenta anticipos; emite este comprobante desde su panel', { validacion: true });
  const tIgv = NF_IGV[doc.afectacion] || 1;
  const j = {
    operacion: 'generar_comprobante', tipo_de_comprobante: NF_TIPO[doc.tipo], serie: doc.serie, numero: doc.numero,
    sunat_transaction: 1,
    cliente_tipo_de_documento: doc.cliente.tipo_doc, cliente_numero_de_documento: doc.cliente.doc,
    cliente_denominacion: doc.cliente.nombre, cliente_direccion: doc.cliente.direccion, cliente_email: doc.cliente.email || '',
    fecha_de_emision: aDDMMAAAA(doc.fecha), moneda: doc.moneda === 'USD' ? 2 : 1,
    tipo_de_cambio: doc.moneda === 'USD' ? (doc.tipo_cambio || '') : '', porcentaje_de_igv: IGV_PCT,
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
    emitir: async doc => enviar(nubefactJSON(doc), false),
    consultar: (tipo, serie, numero) => enviar({ operacion: 'consultar_comprobante', tipo_de_comprobante: NF_TIPO[tipo], serie, numero }, true)
  };
}

// ─── Módulo ─────────────────────────────────────────────────────────────────
module.exports = function ({ app, authAdmin, requiereModulo, prodPool, portalPool, erpWritePool, proveedorFactory, empresas = EMPRESAS_BI, grupos }) {
  const mFe = requiereModulo('facturacion');
  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next() : res.status(403).json({ error: 'Solo el administrador maestro puede cambiar la configuración' });
  const quien = req => (req.admin && req.admin.usuario) || 'admin';

  // Escritura en el ERP (opcional)
  const urlEscritura = process.env.ERP_ESCRITURA_URL || process.env.ERP_FACTURACION_URL;
  if (erpWritePool === undefined && urlEscritura)
    try { erpWritePool = mysql.createPool(urlEscritura + (urlEscritura.includes('?') ? '&' : '?') + 'connectionLimit=2'); }
    catch (e) { console.error('[facturacion] ERP_ESCRITURA_URL no válida:', e.message); erpWritePool = null; }

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
  // Correo al cliente con el comprobante: formato sobrio, como el de un emisor electrónico
  // (emisor con RUC, datos del documento, enlaces y nota de validez en SUNAT). PDF adjunto.
  async function enviarCorreo(comp) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, error: 'Falta RESEND_API_KEY para enviar correos' };
    if (!comp.cliente_email) return { ok: false, error: 'El cliente no tiene correo' };
    if (!comp.enlace_pdf) return { ok: false, error: 'El comprobante aún no tiene PDF' };
    const TIPO = { factura: 'FACTURA ELECTRÓNICA', boleta: 'BOLETA DE VENTA ELECTRÓNICA', nc: 'NOTA DE CRÉDITO ELECTRÓNICA', guia: 'GUÍA DE REMISIÓN ELECTRÓNICA REMITENTE' };
    const tipoTxt = TIPO[comp.tipo] || 'COMPROBANTE ELECTRÓNICO';
    const num = numDoc(comp.serie, comp.numero);
    let ruc = '';
    try { const cfgs = await leerConfig(); ruc = (cfgs[comp.company_id] || {}).ruc || ''; } catch (e) { /* sin config */ }
    if (!ruc) { const m = String(comp.enlace_pdf || '').match(/\b((?:10|15|17|20)\d{9})-\d{2}-/); if (m) ruc = m[1]; } // el enlace de APISUNAT trae el RUC
    const emp = String(empresas[comp.company_id] || 'Kuranko').replace(/\.+$/, '.');      // razón social (la del comprobante)
    const marca = (process.env.FE_NOMBRE_COMERCIAL || 'KURANKO').trim();                    // nombre comercial, igual para RUC 10 y 20
    const emisorLegal = `${emp}${ruc ? ' · RUC ' + ruc : ''}`;
    const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const f = isoFecha(comp.fecha_emision || hoyLima()).split('-'); const fecha = f.length === 3 ? `${f[2]}/${f[1]}/${f[0]}` : '';
    const docCli = comp.cliente_doc && comp.cliente_doc !== '-' ? `${comp.cliente_tipo_doc === '6' ? 'RUC' : comp.cliente_tipo_doc === '1' ? 'DNI' : 'Doc.'} ${comp.cliente_doc}` : '';
    const importe = comp.tipo === 'guia' ? '' : `${comp.tipo === 'nc' ? '-' : ''}${SIMBOLO[comp.moneda] || 'S/'} ${Number(comp.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fila = (k, v) => v ? `<tr><td style="padding:6px 0;color:#6b7280;width:150px">${k}</td><td style="padding:6px 0;color:#111827"><b>${esc(v)}</b></td></tr>` : '';
    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px">
  <tr><td style="padding:20px 28px;border-bottom:1px solid #e5e7eb">
    <div style="font-size:20px;font-weight:bold;letter-spacing:1px">${esc(marca)}</div>
    <div style="color:#6b7280;font-size:12px;margin-top:3px">Nombre comercial de ${esc(emisorLegal)}</div>
  </td></tr>
  <tr><td style="padding:24px 28px">
    <p style="margin:0 0 14px">Estimado(a) ${esc(comp.cliente_nombre || 'cliente')}:</p>
    <p style="margin:0 0 18px;line-height:1.5">Le informamos que se ha emitido el siguiente comprobante electrónico a su nombre:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin-bottom:20px">
      ${fila('Emisor', emisorLegal)}${fila('Tipo', tipoTxt)}${fila('Número', num)}${fila('Fecha de emisión', fecha)}${fila('Cliente', [comp.cliente_nombre, docCli].filter(Boolean).join(' · '))}${fila('Importe total', importe)}
    </table>
    <p style="margin:0 0 20px">
      <a href="${esc(comp.enlace_pdf)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">Descargar PDF</a>
      ${comp.enlace_xml ? `<a href="${esc(comp.enlace_xml)}" style="display:inline-block;margin-left:8px;color:#111827;text-decoration:underline;padding:10px 6px">Descargar XML</a>` : ''}
    </p>
    <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.5">El PDF también va adjunto a este correo. Puede verificar la validez del comprobante en
      <a href="https://e-consulta.sunat.gob.pe/ol-ti-itconsvalicpe/ConsValiCpe.htm" style="color:#6b7280">SUNAT – Consulta de validez del CPE</a>.</p>
  </td></tr>
  <tr><td style="padding:14px 28px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;line-height:1.5">
    Este es un mensaje automático enviado por ${esc(marca)} (nombre comercial de ${esc(emisorLegal)}). Por favor, no responda a este correo.
  </td></tr>
</table></td></tr></table></body></html>`;
    const texto = `${marca}\nNombre comercial de ${emisorLegal}\n\nEstimado(a) ${comp.cliente_nombre || 'cliente'}:\nSe ha emitido el siguiente comprobante electrónico a su nombre:\n\n`
      + `${tipoTxt} ${num}\nFecha de emisión: ${fecha}${docCli ? '\nCliente: ' + comp.cliente_nombre + ' · ' + docCli : ''}${importe ? '\nImporte total: ' + importe : ''}\n\n`
      + `PDF: ${comp.enlace_pdf}${comp.enlace_xml ? '\nXML: ' + comp.enlace_xml : ''}\n\nPuede verificar su validez en SUNAT: https://e-consulta.sunat.gob.pe/ol-ti-itconsvalicpe/ConsValiCpe.htm`;
    try {
      const r = await fetch(process.env.RESEND_URL || 'https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Remitente: el nombre de la empresa emisora con la dirección configurada (dominio verificado en Resend)
          from: `${marca.replace(/[<>"]/g, '')} <${((process.env.FE_EMAIL_DESDE || process.env.RESEND_FROM || '').match(/<([^>]+)>/) || [])[1] || (process.env.FE_EMAIL_DESDE || process.env.RESEND_FROM || '').trim() || 'noreply@kuranko.pe'}>`,
          to: [comp.cliente_email],
          subject: `${tipoTxt} ${num} - ${marca}${ruc ? ' (RUC ' + ruc + ')' : ''}`,
          html, text: texto,
          attachments: [{ filename: `${ruc ? ruc + '-' : ''}${num}.pdf`, path: comp.enlace_pdf }]
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
    // Guías de remisión: datos por empresa y catálogos de transporte
    for (const sql of [`ALTER TABLE fe_config ADD COLUMN ruc VARCHAR(11) NULL`,
                       `ALTER TABLE fe_config ADD COLUMN serie_guia VARCHAR(4) NULL`,
                       `ALTER TABLE fe_config ADD COLUMN partida_ubigeo CHAR(6) NULL`,
                       `ALTER TABLE fe_config ADD COLUMN partida_direccion VARCHAR(250) NULL`])
      try { await portalPool.query(sql); } catch (e) { /* ya existe */ }
    // Cada cambio que el portal hace en el ERP queda aquí, con el valor anterior, para poder deshacerlo
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_erp_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tabla VARCHAR(40) NOT NULL, registro_id BIGINT NOT NULL,
      accion VARCHAR(10) NOT NULL,           -- insert | update
      campo VARCHAR(40) NULL, antes TEXT NULL, despues TEXT NULL,
      comprobante_id INT NULL, usuario VARCHAR(100), creado DATETIME DEFAULT CURRENT_TIMESTAMP,
      deshecho_por VARCHAR(100) NULL, deshecho_en DATETIME NULL,
      INDEX idx_comp (comprobante_id))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_gre_transporte (
      id INT AUTO_INCREMENT PRIMARY KEY,
      clase VARCHAR(12) NOT NULL,            -- agencia | conductor | vehiculo
      doc VARCHAR(15) NULL,                  -- RUC de la agencia / DNI del conductor
      nombre VARCHAR(200) NULL,              -- razón social / nombres
      apellidos VARCHAR(100) NULL, licencia VARCHAR(20) NULL, mtc VARCHAR(20) NULL,
      placa VARCHAR(10) NULL, detalle VARCHAR(100) NULL,
      activo TINYINT NOT NULL DEFAULT 1, creado DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // Moneda del comprobante (agregada después: se crea si falta)
    for (const sql of [`ALTER TABLE fe_comprobantes ADD COLUMN moneda CHAR(3) NOT NULL DEFAULT 'PEN'`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN moneda_erp VARCHAR(40) NULL`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN tipo_cambio DECIMAL(10,4) NULL`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN monto_venta DECIMAL(12,2) NULL`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN es_anticipo TINYINT NOT NULL DEFAULT 0`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN aplicado_en INT NULL`,
                       `ALTER TABLE fe_comprobantes ADD COLUMN transfer_id BIGINT NULL`])
      try { await portalPool.query(sql); } catch (e) { /* ya existe */ }
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_comprobante_items (
      comprobante_id INT NOT NULL, sale_item_id BIGINT NOT NULL, cantidad DECIMAL(14,4) NOT NULL, total DECIMAL(12,2),
      INDEX idx_comp (comprobante_id), INDEX idx_item (sale_item_id))`);
    // Pagos de la venta que cubre cada comprobante de anticipo (el vendedor los elige)
    await portalPool.query(`CREATE TABLE IF NOT EXISTS fe_comprobante_pagos (
      comprobante_id INT NOT NULL, payment_id BIGINT NOT NULL, monto DECIMAL(12,2),
      INDEX idx_comp (comprobante_id), INDEX idx_pago (payment_id))`);
    // Series por defecto distintas por empresa (F001/B001, F002/B002…): así una
    // serie-número nunca se repite entre las dos empresas (el cruce con SUNAT y
    // sale_vouchers no distinguen empresa).
    for (const id of Object.keys(empresas)) {
      const n = String(Number(id)).padStart(2, '0').slice(-2);
      await portalPool.query(`INSERT IGNORE INTO fe_config (company_id, serie_factura, serie_boleta, serie_nc_factura, serie_nc_boleta) VALUES (?,?,?,?,?)`,
        [Number(id), 'F0' + n, 'B0' + n, 'FC' + n, 'BC' + n]);
      await portalPool.query(`UPDATE fe_config SET serie_guia = ? WHERE company_id = ? AND serie_guia IS NULL`, ['T0' + n, Number(id)]);
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

  // Columnas de moneda y tipo de cambio de `sales`: se descubren una vez.
  //  moneda: columna directa (currency, moneda…) o un *_id que apunta a una tabla
  //  de monedas (currencies) o al catálogo general (catalog_items).
  let colsSales = null;
  async function columnasSales() {
    if (colsSales) return colsSales;
    try {
      const [c] = await prodPool.query(`SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('sales','currencies','catalog_items')`);
      const de = t => c.filter(x => x.t === t).map(x => x.c);
      const sales = de('sales');
      const moneda = ['currency', 'currency_code', 'moneda', 'currency_id', 'moneda_id', 'coin_id', 'coin']
        .find(x => sales.includes(x)) || sales.find(x => /currenc|moneda/i.test(x) && !/rate|cambio/i.test(x)) || null;
      const tc = ['exchange_rate', 'tipo_cambio', 'tipo_de_cambio', 'currency_rate'].find(x => sales.includes(x))
        || sales.find(x => /exchange|tipo_?de?_?cambio/i.test(x)) || null;
      let join = null;
      if (moneda && /_id$/.test(moneda)) {
        const cur = de('currencies');
        if (cur.length) join = { tabla: 'currencies', cols: ['code', 'iso_code', 'name', 'symbol', 'abbreviation'].filter(x => cur.includes(x)) };
        else if (de('catalog_items').length) join = { tabla: 'catalog_items', cols: ['name', 'code', 'value', 'abbreviation'].filter(x => de('catalog_items').includes(x)) };
      }
      // Moneda de cada pago (sale_payments.currency_id → catalog_items)
      const [pc] = await prodPool.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sale_payments' AND COLUMN_NAME = 'currency_id'`);
      const pagoMoneda = pc[0].n > 0 && de('catalog_items').includes('name');
      const envio = ['delivery_cost_quoted', 'delivery_cost', 'shipping_cost'].find(x => sales.includes(x)) || null;
      colsSales = { moneda, tc, join, pagoMoneda, envio };
    } catch (e) { colsSales = { moneda: null, tc: null, join: null, pagoMoneda: false }; }
    return colsSales;
  }

  // Lee del ERP lo necesario para una o varias ventas.
  async function leerVentas(ids) {
    if (!ids.length) return [];
    const cp = await columnasParty();
    const cs = await columnasSales();
    const extra = ['direccion', 'telefono', 'email'].map(k => cp[k] ? `cli.\`${cp[k]}\` AS cli_${k}` : `NULL AS cli_${k}`).join(', ');
    let selMon = `NULL AS mon_raw, NULL AS tc_raw`, joinMon = '';
    if (cs.moneda) selMon = `s.\`${cs.moneda}\` AS mon_raw, ${cs.tc ? `s.\`${cs.tc}\`` : 'NULL'} AS tc_raw`;
    else if (cs.tc) selMon = `NULL AS mon_raw, s.\`${cs.tc}\` AS tc_raw`;
    if (cs.join && cs.join.cols.length) {
      joinMon = `LEFT JOIN \`${cs.join.tabla}\` mon ON mon.id = s.\`${cs.moneda}\``;
      selMon += ', ' + cs.join.cols.map((x, i) => `mon.\`${x}\` AS mon_${i}`).join(', ');
    }
    const ventas = await enBloques(`
      SELECT s.id, s.code, s.company_id, s.customer_id, s.total, s.status, s.created_at, ${cs.envio ? 's.`' + cs.envio + '`' : 'NULL'} AS envio_raw,
        cli.is_company, cli.business_name, cli.first_name, cli.last_name, cli.document_number, ${extra}, ${selMon}
      FROM sales s LEFT JOIN parties cli ON cli.id = s.customer_id ${joinMon}
      WHERE s.id IN (?) AND s.deleted_at IS NULL`, ids);
    const items = await enBloques(`
      SELECT si.id, si.sale_id, si.quantity, si.unit_price, si.total, p.name AS producto, pv.name AS variacion, pv.sku
      FROM sale_items si JOIN product_variations pv ON pv.id = si.product_variation_id JOIN products p ON p.id = pv.product_id
      WHERE si.sale_id IN (?) ORDER BY si.id`, ids);
    const pagos = await enBloques(cs.pagoMoneda
      ? `SELECT sp.sale_id, SUM(sp.amount) pagado, GROUP_CONCAT(DISTINCT COALESCE(ci.name, '') SEPARATOR '|') monedas
         FROM sale_payments sp LEFT JOIN catalog_items ci ON ci.id = sp.currency_id
         WHERE sp.sale_id IN (?) AND sp.voided_at IS NULL GROUP BY sp.sale_id`
      : `SELECT sale_id, SUM(amount) pagado, NULL monedas FROM sale_payments WHERE sale_id IN (?) AND voided_at IS NULL GROUP BY sale_id`, ids);
    // Detalle de cada pago (para elegir cuáles se facturan como anticipo)
    const listaPagos = await enBloques(`
      SELECT sp.id, sp.sale_id, sp.amount, sp.paid_at, met.name AS metodo, ${cs.pagoMoneda ? 'mon.name' : 'NULL'} AS moneda_txt
      FROM sale_payments sp
      LEFT JOIN catalog_items met ON met.id = sp.payment_method_id
      ${cs.pagoMoneda ? 'LEFT JOIN catalog_items mon ON mon.id = sp.currency_id' : ''}
      WHERE sp.sale_id IN (?) AND sp.voided_at IS NULL ORDER BY sp.paid_at, sp.id`, ids).catch(() => []);
    const vouchers = await enBloques(`SELECT sale_id, type, serie, number, emission_date, amount FROM sale_vouchers WHERE sale_id IN (?)`, ids);
    const [comps] = await portalPool.query(`SELECT id, sale_id, tipo, serie, numero, total, monto_venta, moneda, estado, es_anticipo, aplicado_en, anulado_por_nc
      FROM fe_comprobantes WHERE sale_id IN (?) AND tipo <> 'guia'`, [ids]);
    const compIds = comps.filter(c => !['error', 'enviando', 'rechazado'].includes(c.estado)).map(c => c.id);
    const [citems] = compIds.length ? await portalPool.query(`
      SELECT ci.sale_item_id, ci.cantidad, c.tipo FROM fe_comprobante_items ci JOIN fe_comprobantes c ON c.id = ci.comprobante_id
      WHERE ci.comprobante_id IN (?)`, [compIds]) : [[]];
    // Pagos ya cubiertos por un comprobante de anticipo vigente
    const [pagosFact] = compIds.length ? await portalPool.query(`
      SELECT cp.payment_id, c.serie, c.numero FROM fe_comprobante_pagos cp JOIN fe_comprobantes c ON c.id = cp.comprobante_id
      WHERE cp.comprobante_id IN (?) AND c.anulado_por_nc IS NULL`, [compIds]) : [[]];
    const compDePago = Object.fromEntries(pagosFact.map(x => [x.payment_id, `${x.serie}-${x.numero}`]));
    const porItem = {};
    citems.forEach(x => { porItem[x.sale_item_id] = (porItem[x.sale_item_id] || 0) + (x.tipo === 'nc' ? -1 : 1) * Number(x.cantidad); });

    const agrupar = (arr, k = 'sale_id') => arr.reduce((m, x) => ((m[x[k]] = m[x[k]] || []).push(x), m), {});
    const itV = agrupar(items), voV = agrupar(vouchers), coV = agrupar(comps);
    const pgV = Object.fromEntries(pagos.map(p => [p.sale_id, Number(p.pagado) || 0]));
    const monPagos = Object.fromEntries(pagos.map(p => [p.sale_id, String(p.monedas || '').split('|').filter(Boolean)]));
    return ventas.map(v => {
      const fac = calcularFacturado(v, voV[v.id], coV[v.id]);
      const nombre = v.is_company ? (v.business_name || '') : `${v.first_name || ''} ${v.last_name || ''}`;
      const textosMon = Object.keys(v).filter(k => /^mon_\d+$/.test(k)).map(k => v[k]);
      // Moneda: columna de la venta si existe; si no, la de los pagos (USD solo si TODOS son en dólares)
      const mp = monPagos[v.id] || [];
      const moneda = cs.moneda ? monedaDe(cs.join ? null : v.mon_raw, ...textosMon)
        : (mp.length && mp.every(x => monedaDe(x) === 'USD') ? 'USD' : 'PEN');
      // Anticipos emitidos desde el portal que aún no se descontaron en un comprobante final
      const anticipos = (coV[v.id] || []).filter(c => c.es_anticipo && ['aceptado', 'pendiente_sunat'].includes(c.estado) && !c.aplicado_en && !c.anulado_por_nc)
        .map(c => ({ id: c.id, tipo: c.tipo, serie: c.serie, numero: c.numero, monto: Number(c.total), moneda: c.moneda || 'PEN', monto_venta: Number(c.monto_venta != null ? c.monto_venta : c.total) }));
      const pagosVenta = listaPagos.filter(x => x.sale_id === v.id).map(x => ({ id: x.id, monto: r2(x.amount), fecha: x.paid_at, metodo: x.metodo || '',
        moneda: x.moneda_txt ? monedaDe(x.moneda_txt) : moneda, comprobante: compDePago[x.id] || null }));
      return {
        moneda, moneda_erp: v.mon_raw, monedas_pago: mp, anticipos, pagos: pagosVenta,
        pagado_sin_comprobante: r2(Math.max(0, (pgV[v.id] || 0) - fac.facturado)),
        tipo_cambio: Number(v.tc_raw) > 1 ? Number(v.tc_raw) : null,
        id: v.id, code: v.code, company_id: v.company_id, empresa: empresas[v.company_id] || ('Empresa ' + v.company_id),
        status: v.status, fecha: v.created_at, total: r2(v.total), pagado: r2(pgV[v.id] || 0),
        cliente: { tipo_doc: tipoDocCliente(v.document_number), doc: (v.document_number || '').trim(), nombre: limpiar(nombre, 200),
          direccion: limpiar(v.cli_direccion), email: limpiar(v.cli_email, 120), telefono: limpiar(v.cli_telefono, 40) },
        ...fac,
        items: itemsPendientes(itV[v.id], porItem, fac.externo > 0.009, v.total, v.envio_raw)
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
    if (comp.tipo === 'nc' || comp.tipo === 'guia' || !comp.sale_id) return { erp_estado: 'no_aplica', erp_error: null };
    try {
      const [[ya]] = await erpWritePool.query(`SELECT COUNT(*) n FROM sale_vouchers WHERE sale_id = ? AND UPPER(TRIM(serie)) = ? AND CAST(number AS UNSIGNED) = ?`,
        [comp.sale_id, comp.serie.toUpperCase(), comp.numero]);
      if (ya.n > 0) return { erp_estado: 'registrado', erp_error: null };
      // Mismas reglas que el botón "Comprobante" del sistema: venta confirmada / pendiente de pago / pagada
      // (también completada, por si se cerró antes) y monto que no pase el total de la venta.
      const [[sv]] = await erpWritePool.query(`SELECT s.status, s.total, (SELECT COALESCE(SUM(amount),0) FROM sale_vouchers v WHERE v.sale_id = s.id) registrado
        FROM sales s WHERE s.id = ?`, [comp.sale_id]);
      if (!sv) return { erp_estado: 'error', erp_error: 'La venta ya no existe en el sistema' };
      if (sv.status === 'draft') return { erp_estado: 'pendiente', erp_error: 'La venta sigue en borrador en el sistema: confírmala y luego usa "Registrar en sistema"' };
      if (sv.status === 'cancelled') return { erp_estado: 'error', erp_error: 'La venta está anulada en el sistema; no se registra el comprobante' };
      const montoV = Number(comp.monto_venta != null ? comp.monto_venta : comp.total);
      if (Number(sv.registrado) + montoV > Number(sv.total) + 0.05)
        return { erp_estado: 'error', erp_error: `Con este comprobante la venta tendría S/ ${(Number(sv.registrado) + montoV).toFixed(2)} en comprobantes y su total es S/ ${Number(sv.total).toFixed(2)}. Revisa los comprobantes ya anotados en el sistema.` };
      const cols = await columnasVoucher();
      const ahora = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const valores = { sale_id: comp.sale_id, type: comp.tipo, serie: comp.serie, number: String(comp.numero).padStart(DIGITOS_NUM, '0'),
        emission_date: comp.fecha_emision, amount: comp.monto_venta != null ? comp.monto_venta : comp.total, created_at: ahora, updated_at: ahora, company_id: comp.company_id };
      // Si sale_vouchers también guarda moneda, se copia el mismo valor que tiene la venta
      const cs = await columnasSales();
      if (cs.moneda && comp.moneda_erp != null) valores[cs.moneda] = comp.moneda_erp;
      const usar = cols.filter(c => c.c in valores);
      const faltan = cols.filter(c => !(c.c in valores) && c.n === 'NO' && c.d == null && !/auto_increment/i.test(c.e || '')).map(c => c.c);
      if (faltan.length) return { erp_estado: 'error', erp_error: 'sale_vouchers exige columnas que el portal no conoce: ' + faltan.join(', ') };
      const [ins] = await erpWritePool.query(`INSERT INTO sale_vouchers (${usar.map(c => '`' + c.c + '`').join(',')}) VALUES (?)`, [usar.map(c => valores[c.c])]);
      await logERP({ tabla: 'sale_vouchers', registro_id: ins.insertId, accion: 'insert', despues: `${comp.tipo} ${comp.serie}-${comp.numero} · venta ${comp.sale_id} · ${valores.amount}`, comprobante_id: comp.id, usuario });
      return { erp_estado: 'registrado', erp_error: null, erp_por: usuario };
    } catch (e) { return { erp_estado: 'error', erp_error: limpiar(e.message, 300) }; }
  }

  async function logERP(x) {
    try { await portalPool.query(`INSERT INTO fe_erp_log SET ?`, [{ ...x, antes: x.antes == null ? null : String(x.antes), despues: x.despues == null ? null : String(x.despues) }]); }
    catch (e) { console.error('[facturacion] log ERP', e.message); }
  }

  // Columnas opcionales de stock_transfers (empresa) y locations (dirección, tipo)
  let colsTransfer = null;
  async function columnasTransfer() {
    if (colsTransfer) return colsTransfer;
    try {
      const [c] = await prodPool.query(`SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('stock_transfers','locations')`);
      const de = t => c.filter(x => x.t === t).map(x => x.c);
      const st = de('stock_transfers'), lo = de('locations');
      colsTransfer = {
        empresa: ['company_id', 'empresa_id'].find(x => st.includes(x)) || null,
        notas: st.includes('notes') ? 'notes' : null,
        dirLoc: ['address', 'direccion', 'address_line', 'location_address'].find(x => lo.includes(x)) || null,
        tipoLoc: lo.includes('type') ? 'type' : null
      };
    } catch (e) { colsTransfer = { empresa: null, notas: 'notes', dirLoc: null, tipoLoc: 'type' }; }
    return colsTransfer;
  }

  // Al emitir una guía desde una transferencia: escribe el N° de documento (solo si está vacío)
  // y agrega a las notas la guía y el RUC/DNI del destinatario (sin borrar lo que ya había).
  async function escribirTransferencia(comp, usuario) {
    if (!comp.transfer_id) return { erp_estado: 'no_aplica', erp_error: null };
    if (!erpWritePool) return { erp_estado: 'pendiente', erp_error: null };
    const numero = numDoc(comp.serie, comp.numero);
    try {
      const ct = await columnasTransfer();
      const [[t]] = await erpWritePool.query(`SELECT id, reference_number, document_type_id${ct.notas ? ', `' + ct.notas + '` AS notas' : ''} FROM stock_transfers WHERE id = ?`, [comp.transfer_id]);
      if (!t) return { erp_estado: 'error', erp_error: 'La transferencia ya no existe en el sistema' };
      const actual = String(t.reference_number || '').trim();
      if (actual && normDoc(actual) !== normDoc(numero))
        return { erp_estado: 'error', erp_error: `La transferencia ya tiene el N° de documento "${actual}"; no se sobrescribe` };
      if (!actual) {
        await erpWritePool.query(`UPDATE stock_transfers SET reference_number = ? WHERE id = ? AND (reference_number IS NULL OR TRIM(reference_number) = '')`, [numero, comp.transfer_id]);
        await logERP({ tabla: 'stock_transfers', registro_id: comp.transfer_id, accion: 'update', campo: 'reference_number', antes: t.reference_number, despues: numero, comprobante_id: comp.id, usuario });
      }
      // "Tipo de Comprobante" de la transferencia = Guía de Remisión (código 09 del catálogo), solo si está vacío
      if (t.document_type_id == null) {
        const [[gr]] = await erpWritePool.query(`SELECT ci.id FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id
          WHERE c.code = 'tipo_comprobante' AND ci.code = '09' LIMIT 1`);
        if (gr) {
          const [u] = await erpWritePool.query(`UPDATE stock_transfers SET document_type_id = ? WHERE id = ? AND document_type_id IS NULL`, [gr.id, comp.transfer_id]);
          if (u.affectedRows) await logERP({ tabla: 'stock_transfers', registro_id: comp.transfer_id, accion: 'update', campo: 'document_type_id', antes: null, despues: gr.id, comprobante_id: comp.id, usuario });
        }
      }
      if (ct.notas) {
        const notas = String(t.notas || '');
        if (!mencionaDoc(notas, comp.serie, comp.numero)) {
          const doc = comp.cliente_doc ? `${comp.cliente_tipo_doc === '6' ? 'RUC' : comp.cliente_tipo_doc === '1' ? 'DNI' : 'Doc.'} ${comp.cliente_doc}` : '';
          const linea = [`Guía ${numero}`, doc, comp.cliente_nombre].filter(Boolean).join(' · ');
          const nuevas = (notas.trim() ? notas.trim() + '\n' : '') + linea;
          await erpWritePool.query(`UPDATE stock_transfers SET \`${ct.notas}\` = ? WHERE id = ?`, [nuevas, comp.transfer_id]);
          await logERP({ tabla: 'stock_transfers', registro_id: comp.transfer_id, accion: 'update', campo: ct.notas, antes: t.notas, despues: nuevas, comprobante_id: comp.id, usuario });
        }
      }
      return { erp_estado: 'registrado', erp_error: null, erp_por: usuario };
    } catch (e) { return { erp_estado: 'error', erp_error: limpiar(e.message, 300) }; }
  }
  // Registro en el ERP según el tipo de documento
  const registrarDoc = (comp, usuario) => comp.tipo === 'guia' ? escribirTransferencia(comp, usuario)
    : comp.tipo === 'nc' ? anotarNC(comp, usuario) : registrarEnERP(comp, usuario);

  // Nota de crédito por anulación (motivo 01) o devolución total (06): en el sistema la venta se anula
  // a mano (devuelve stock y anula pagos; eso NO lo hace el portal). Cuando la venta ya está anulada,
  // el portal agrega el N° de la NC al final del motivo y en "N° de Nota de Crédito / Guía" si falta.
  // Si aún no está anulada queda pendiente y se completa sola al anularla.
  const MOTIVOS_NC_ANULA = [1, 6];
  // Decisión del usuario (oct 2026): el sistema exige el N° de la NC al anular la venta, así que se
  // anota a mano en ese momento. El portal NO escribe nada para las notas de crédito.
  async function anotarNC() { return { erp_estado: 'no_aplica', erp_error: null }; }
  async function anotarNC_desactivado(comp, usuario) {
    if (!comp.sale_id) return { erp_estado: 'no_aplica', erp_error: null };
    if (!erpWritePool) return { erp_estado: 'pendiente', erp_error: null };
    const numero = numDoc(comp.serie, comp.numero);
    try {
      const [[s]] = await erpWritePool.query(`SELECT id, status, cancellation_reason, cancellation_document FROM sales WHERE id = ?`, [comp.sale_id]);
      if (!s) return { erp_estado: 'error', erp_error: 'La venta ya no existe en el sistema' };
      if (s.status !== 'cancelled') {
        if (!MOTIVOS_NC_ANULA.includes(Number(comp.nc_motivo))) return { erp_estado: 'no_aplica', erp_error: null };
        return { erp_estado: 'pendiente', erp_error: `Anula la venta en el sistema; al hacerlo el portal agrega "${numero}" al motivo. En "N° de Nota de Crédito" puedes poner ${numero}.` };
      }
      const motivo = String(s.cancellation_reason || '');
      if (!mencionaDoc(motivo, comp.serie, comp.numero)) {
        const nuevo = (motivo.trim() ? motivo.trim() + ' · ' : '') + `Nota de crédito ${numero}`;
        await erpWritePool.query(`UPDATE sales SET cancellation_reason = ? WHERE id = ? AND cancellation_reason <=> ?`, [nuevo, s.id, s.cancellation_reason]);
        await logERP({ tabla: 'sales', registro_id: s.id, accion: 'update', campo: 'cancellation_reason', antes: s.cancellation_reason, despues: nuevo, comprobante_id: comp.id, usuario });
      }
      const docu = String(s.cancellation_document || '').trim();
      if (!mencionaDoc(docu, comp.serie, comp.numero)) {
        const nuevo = docu ? `${docu} / ${numero}` : numero;
        if (nuevo.length <= 255) {
          await erpWritePool.query(`UPDATE sales SET cancellation_document = ? WHERE id = ? AND cancellation_document <=> ?`, [nuevo, s.id, s.cancellation_document]);
          await logERP({ tabla: 'sales', registro_id: s.id, accion: 'update', campo: 'cancellation_document', antes: s.cancellation_document, despues: nuevo, comprobante_id: comp.id, usuario });
        }
      }
      return { erp_estado: 'registrado', erp_error: null, erp_por: usuario };
    } catch (e) { return { erp_estado: 'error', erp_error: limpiar(e.message, 300) }; }
  }
  // Detecta lo que alguien ya anotó a mano en el sistema (con o sin ceros) y lo marca como registrado.
  // Es una sola consulta de lectura sobre los pendientes; no escribe nada en el sistema.
  async function detectarAnotados() {
    try {
      const [ps] = await portalPool.query(`SELECT id, tipo, serie, numero, sale_id, transfer_id FROM fe_comprobantes
        WHERE erp_estado IN ('pendiente','error') AND estado IN ('aceptado','pendiente_sunat')
          AND ((tipo IN ('factura','boleta') AND sale_id IS NOT NULL) OR (tipo = 'guia' AND transfer_id IS NOT NULL)) LIMIT 500`);
      if (!ps.length) return;
      const ventas = ps.filter(c => c.tipo !== 'guia'), guias = ps.filter(c => c.tipo === 'guia');
      const ya = [];
      if (ventas.length) {
        const [v] = await prodPool.query(`SELECT sale_id, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, [[...new Set(ventas.map(c => c.sale_id))]]);
        ventas.forEach(c => { if (v.some(x => x.sale_id === c.sale_id && normDoc(`${x.serie}-${x.number}`) === normDoc(numDoc(c.serie, c.numero)))) ya.push(c.id); });
      }
      if (guias.length) {
        const [t] = await prodPool.query(`SELECT id, reference_number, notes FROM stock_transfers WHERE id IN (?)`, [[...new Set(guias.map(c => c.transfer_id))]]);
        guias.forEach(c => { const x = t.find(y => y.id === c.transfer_id); if (x && (normDoc(x.reference_number) === normDoc(numDoc(c.serie, c.numero)))) ya.push(c.id); });
      }
      if (ya.length) await portalPool.query(`UPDATE fe_comprobantes SET erp_estado='registrado', erp_error=NULL, erp_por='ya estaba en el sistema', erp_en=NOW() WHERE id IN (?)`, [ya]);
    } catch (e) { console.error('[facturacion] detectar anotados', e.message); }
  }

  // Completa las NC que esperaban la anulación de la venta (al abrir las listas)
  async function sincronizarNC() {
    return; // desactivado: las NC se anotan a mano al anular la venta
    if (!erpWritePool) return;   // consulta pequeña: solo las NC que esperan la anulación
    try {
      const [ps] = await portalPool.query(`SELECT * FROM fe_comprobantes WHERE tipo = 'nc' AND erp_estado = 'pendiente' AND sale_id IS NOT NULL
        AND estado NOT IN ('rechazado','error','enviando','incierto') ORDER BY id DESC LIMIT 30`);
      for (const c of ps) {
        const erp = await anotarNC(c, 'automático');
        if (erp.erp_estado === 'registrado' || erp.erp_estado === 'error' || erp.erp_estado === 'no_aplica')
          await portalPool.query(`UPDATE fe_comprobantes SET erp_estado=?, erp_error=?, erp_por=?, erp_en=IF(?='registrado',NOW(),erp_en) WHERE id=?`,
            [erp.erp_estado, erp.erp_error, erp.erp_por || null, erp.erp_estado, c.id]);
      }
    } catch (e) { console.error('[facturacion] sync NC', e.message); }
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
        const armado = tipo === 'guia' ? armarGuia({ ...datos, serie, numero }) : armarComprobante({ ...datos, tipo, serie, numero }, cfg);
        if (armado.errores.length) { const e = new Error(armado.errores.join(' · ')); e.validacion = true; throw e; }
        const [ins] = await conn.query(`INSERT INTO fe_comprobantes
          (company_id, tipo, serie, numero, sale_id, sale_code, fecha_emision, cliente_tipo_doc, cliente_doc, cliente_nombre, cliente_email, cliente_telefono,
           total, total_igv, credito, estado, ref_id, ref_tipo, ref_serie, ref_numero, nc_motivo, payload, emitido_por, moneda, moneda_erp,
           tipo_cambio, monto_venta, es_anticipo)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'enviando',?,?,?,?,?,?,?,?,?,?,?,?)`,
          [companyId, tipo, serie, numero, venta ? venta.id : null, venta ? venta.code : null, datos.fecha || hoyLima(),
            armado.doc.cliente.tipo_doc, armado.doc.cliente.doc, armado.doc.cliente.nombre,
            armado.doc.cliente.email || null, limpiar(datos.cliente && datos.cliente.telefono, 40) || null,
            armado.total, armado.total_igv, datos.credito ? 1 : 0,
            refComp ? refComp.id : null, refComp ? refComp.tipo : null, refComp ? refComp.serie : null, refComp ? refComp.numero : null,
            datos.nc ? datos.nc.motivo : null, JSON.stringify(armado.doc), usuario, armado.doc.moneda,
            venta && venta.moneda_erp != null ? String(venta.moneda_erp).slice(0, 40) : (refComp ? refComp.moneda_erp : null),
            armado.doc.tipo_cambio, r2(armado.total * (datos.factor_venta || 1)), datos.es_anticipo ? 1 : 0]);
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
        if (itemsOrigen.some(x => x.sale_item_id != null))
          await conn.query(`INSERT INTO fe_comprobante_items (comprobante_id, sale_item_id, cantidad, total) VALUES ?`,
            [itemsOrigen.filter(x => x.sale_item_id != null).map(x => [compId, x.sale_item_id, x.cantidad, x.total])]);
        await conn.query(`UPDATE fe_comprobantes SET estado=?, sunat_desc=?, enlace=?, enlace_pdf=?, enlace_xml=?, enlace_cdr=?,
          email_enviado=?, respuesta=?, actualizado=NOW() WHERE id=?`,
          [est.estado, est.sunat_desc || null, est.enlace || null, est.enlace_pdf || null, est.enlace_xml || null, est.enlace_cdr || null,
            armado.doc.enviar_email && prov.envia_email ? 1 : 0, resp ? JSON.stringify(resp.raw).slice(0, 60000) : null, compId]);

        const comp = { id: compId, company_id: companyId, tipo, serie, numero, sale_id: venta ? venta.id : null, fecha_emision: datos.fecha || hoyLima(), total: armado.total,
          moneda: armado.doc.moneda, moneda_erp: venta ? venta.moneda_erp : null, monto_venta: r2(armado.total * (datos.factor_venta || 1)),
          nc_motivo: datos.nc ? Number(datos.nc.motivo) : null };
        if (est.estado !== 'rechazado' && (datos.pagos || []).length)
          await conn.query(`INSERT INTO fe_comprobante_pagos (comprobante_id, payment_id, monto) VALUES ?`, [datos.pagos.map(x => [compId, x.id, x.monto])]);
        // Los anticipos descontados quedan aplicados a este comprobante final
        if (est.estado !== 'rechazado' && (datos.anticipos || []).length)
          await conn.query(`UPDATE fe_comprobantes SET aplicado_en = ? WHERE id IN (?)`, [compId, datos.anticipos.map(a => a.id)]);
        // Correo al cliente (si el proveedor no lo manda solo)
        if (armado.doc.enviar_email && !prov.envia_email && est.enlace_pdf && est.estado !== 'rechazado') {
          const m = await enviarCorreo({ ...comp, ...est, cliente_email: armado.doc.cliente.email, cliente_nombre: armado.doc.cliente.nombre,
            cliente_doc: armado.doc.cliente.doc, cliente_tipo_doc: armado.doc.cliente.tipo_doc });
          if (m.ok) await conn.query(`UPDATE fe_comprobantes SET email_enviado=1 WHERE id=?`, [compId]);
          else armado.avisos.push('No se envió el correo: ' + m.error);
        }
        if (datos.transfer_id) {
          await conn.query(`UPDATE fe_comprobantes SET transfer_id = ? WHERE id = ?`, [datos.transfer_id, compId]);
          Object.assign(comp, { transfer_id: datos.transfer_id, cliente_doc: armado.doc.cliente.doc, cliente_tipo_doc: armado.doc.cliente.tipo_doc, cliente_nombre: armado.doc.cliente.nombre });
        }
        if (est.estado !== 'rechazado' && est.estado !== 'incierto') {
          const erp = await registrarDoc(comp, usuario);
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
    // Con anticipos que cubren todo, igual falta el comprobante final (que los descuenta)
    if (venta.pendiente <= 0.009 && !(venta.anticipos.length && !body.anticipo))
      throw Object.assign(new Error(`${venta.code} ya tiene comprobante por todo su importe`), { validacion: true });
    const cfg = cfgs[venta.company_id];
    if (!cfg || !cfg.activo) throw Object.assign(new Error(`${venta.empresa} no tiene activada la emisión de comprobantes (Facturación › Configuración)`), { validacion: true });
    const tipo = body.tipo || (!body.anticipo && venta.anticipos[0] && venta.anticipos[0].tipo) || sugerirTipo(body.cliente || venta.cliente, cfg);
    if (!['factura', 'boleta'].includes(tipo)) throw Object.assign(new Error('Tipo no válido'), { validacion: true });

    // Moneda del comprobante: la de la venta, o la que elija el vendedor (con tipo de cambio)
    const moneda = body.moneda === 'USD' || body.moneda === 'PEN' ? body.moneda : venta.moneda;
    const tc = Number(body.tipo_cambio) > 0 ? Number(body.tipo_cambio) : venta.tipo_cambio;
    if (moneda !== venta.moneda && !(tc > 1)) throw Object.assign(new Error('Indica el tipo de cambio para emitir en otra moneda'), { validacion: true });
    // factor: importe del comprobante × factor = importe en la moneda de la venta
    const factor = moneda === venta.moneda ? 1 : (venta.moneda === 'PEN' ? tc : 1 / tc);
    const deVenta = x => r2(x / factor); // de la moneda de la venta a la del comprobante
    const tol = 0.05 + (factor !== 1 ? 0.005 * venta.pendiente : 0);
    const err = m => Object.assign(new Error(m), { validacion: true });

    const cliente = { ...venta.cliente, ...(body.cliente || {}) };
    if (body.cliente && body.cliente.doc != null && !body.cliente.tipo_doc) cliente.tipo_doc = tipoDocCliente(body.cliente.doc);
    // El nombre (y la dirección fiscal del RUC) se toma de SUNAT si responde
    const docLimpio = String(cliente.doc || '').replace(/\D/g, '');
    if (tipoDocCliente(docLimpio)) {
      const sunat = await consultarSunat(docLimpio);
      if (sunat) {
        cliente.nombre = sunat.nombre;
        if (sunat.tipo_doc === '6' && sunat.direccion) cliente.direccion = sunat.direccion;
        cliente.sunat_estado = [sunat.estado, sunat.condicion].filter(Boolean).join(' / ');
      }
    }
    const base = { fecha: body.fecha || hoyLima(), cliente, enviar_email: body.enviar_email != null ? !!body.enviar_email : cfg.enviar_email,
      formato_pdf: cfg.formato_pdf, moneda, tipo_cambio: moneda === 'USD' || venta.moneda === 'USD' ? tc : null, factor_venta: factor };

    // ── Comprobante de ANTICIPO: un adelanto recibido antes de entregar ──
    if (body.anticipo) {
      if (!(venta.pagado > 0.009)) throw err('La venta no tiene pagos: el anticipo se emite por un adelanto recibido');
      if (venta.pagado + 0.009 >= venta.total) throw err('La venta está pagada completa: emite el comprobante de la venta, no un anticipo');
      let monto = r2(body.anticipo.monto);
      let pagosIds = [];
      if (Array.isArray(body.anticipo.pagos) && body.anticipo.pagos.length) {
        const elegidos = body.anticipo.pagos.map(id => venta.pagos.find(x => String(x.id) === String(id)));
        if (elegidos.some(x => !x)) throw err('Un pago no pertenece a la venta');
        const usado = elegidos.find(x => x.comprobante);
        if (usado) throw err(`El pago del ${String(usado.fecha).slice(0, 10)} ya está en el comprobante ${usado.comprobante}`);
        if (new Set(elegidos.map(x => x.moneda)).size > 1) throw err('Elige pagos de una sola moneda');
        if (elegidos[0].moneda !== moneda) throw err(`Los pagos elegidos están en ${elegidos[0].moneda === 'USD' ? 'dólares' : 'soles'}: el anticipo va en esa moneda`);
        monto = r2(elegidos.reduce((s, x) => s + x.monto, 0));
        pagosIds = elegidos.map(x => ({ id: x.id, monto: x.monto }));
      }
      if (!(monto > 0)) throw err('Indica el monto del anticipo');
      if (monto * factor > venta.pendiente + tol) throw err(`El anticipo (${dinero(monto, moneda)}) supera lo pendiente de facturar (${dinero(venta.pendiente, venta.moneda)})`);
      const resumen = venta.items.map(i => i.descripcion).slice(0, 3).join(', ') + (venta.items.length > 3 ? '…' : '');
      const datos = { ...base, es_anticipo: true, credito: null, pagos: pagosIds,
        items: [{ descripcion: limpiar(body.anticipo.descripcion) || `ANTICIPO - Venta ${venta.code}: ${resumen}`, cantidad: 1, precio: monto, unidad: 'ZZ' }],
        observaciones: body.observaciones || `Anticipo de la venta ${venta.code}` };
      return { venta, cfg, tipo, datos };
    }

    // Ítems: los enviados por el vendedor, o los pendientes por defecto (lote)
    const porId = Object.fromEntries(venta.items.map(i => [i.sale_item_id, i]));
    let items;
    if (Array.isArray(body.items)) {
      items = body.items.map(it => {
        const tieneId = it.sale_item_id != null && it.sale_item_id !== '';
        const o = tieneId ? porId[it.sale_item_id] : null;
        if (tieneId && !o) throw err('Un ítem no pertenece a la venta');
        if (o && Number(it.cantidad) > o.cantidad + 1e-9) throw err(`"${o.descripcion}": solo quedan ${o.cantidad} por facturar`);
        // El precio de lo vendido NO se cambia: se toma el de la venta (en la moneda del comprobante)
        const precio = o ? (factor === 1 ? o.precio : Math.round(o.precio / factor * 1e6) / 1e6) : it.precio;
        return { sale_item_id: o ? o.sale_item_id : null, codigo: it.codigo != null ? it.codigo : (o && o.codigo), descripcion: it.descripcion || (o && o.descripcion),
          cantidad: it.cantidad, precio, unidad: o && o.unidad };
      });
    } else {
      if (venta.externo > 0.009) throw err(`${venta.code} ya tiene comprobantes hechos fuera del portal: revísala y emite a mano`);
      items = venta.items.filter(i => i.cantidad > 0).map(i => ({ sale_item_id: i.sale_item_id, codigo: i.codigo, descripcion: i.descripcion, cantidad: i.cantidad,
        precio: factor === 1 ? i.precio : Math.round(i.precio / factor * 1e6) / 1e6, unidad: i.unidad }));
    }

    // Comprobante final: descuenta TODOS los anticipos pendientes de la venta
    const anticipos = venta.anticipos;
    if (anticipos.some(a => a.moneda !== moneda)) throw err(`Los anticipos de esta venta están en ${anticipos[0].moneda === 'USD' ? 'dólares' : 'soles'}: el comprobante final debe ir en la misma moneda`);
    const totalItems = r2(items.reduce((s, i) => s + r2(Number(i.precio) * Number(i.cantidad)), 0));
    const totalAnt = r2(anticipos.reduce((s, a) => s + a.monto, 0));
    const neto = r2(totalItems - totalAnt);
    if (neto * factor > venta.pendiente + tol)
      throw err(`${venta.code}: el comprobante (${dinero(neto, moneda)}${totalAnt ? ', ya descontados los anticipos' : ''}) supera lo pendiente de facturar (${dinero(venta.pendiente, venta.moneda)})`);

    let credito = null;
    if (tipo === 'factura' && neto > 0.009) {
      const saldo = deVenta(r2(venta.total - venta.pagado));
      if (body.credito === false) credito = null;
      else if (body.credito && typeof body.credito === 'object') credito = body.credito;
      else if (saldo > 0.009) credito = { fecha_pago: sumarDias(hoyLima(), 30), importe: Math.min(saldo, neto) };
    }
    const datos = { ...base, items, credito, anticipos, observaciones: body.observaciones || `Venta ${venta.code}` };
    return { venta, cfg, tipo, datos };
  }

  // ════════════════════════ ENDPOINTS ════════════════════════

  // Estado general: proveedor, empresas conectadas y si el ERP se actualiza solo
  app.get('/api/fe/estado', authAdmin, mFe, async (req, res) => {
    try {
      const cfgs = await leerConfig();
      await detectarAnotados();
      const [pend] = await portalPool.query(`SELECT company_id, erp_estado, COUNT(*) n FROM fe_comprobantes
        WHERE tipo NOT IN ('nc','guia') AND estado IN ('aceptado','pendiente_sunat') AND erp_estado IN ('pendiente','error') GROUP BY company_id, erp_estado`);
      const [inc] = await portalPool.query(`SELECT COUNT(*) n FROM fe_comprobantes WHERE estado IN ('incierto','pendiente_sunat')`);
      res.json({
        maestro: !!(req.admin && req.admin.maestro),
        erp_automatico: !!erpWritePool,
        por_anotar_erp: pend.reduce((s, x) => s + x.n, 0),
        por_verificar: inc[0].n,
        motivos_nc: MOTIVOS_NC, digitos: DIGITOS_NUM,
        proveedor: nombreProv(Number(Object.keys(empresas)[0])), en_pruebas: enPruebas,
        moneda_erp: await columnasSales().then(c => c.moneda ? 'sales.' + c.moneda + (c.join ? ' → ' + c.join.tabla : '') : null),
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
        .filter(v => q.todas === '1' || v.pendiente > 0.009 || v.anticipos.length)
        .filter(v => q.solo_pagadas !== '1' || v.pagado + 0.009 >= v.total)
        .map(v => ({ ...v, tipo_sugerido: (v.anticipos[0] && v.anticipos[0].tipo) || sugerirTipo(v.cliente, cfgs[v.company_id]), items: undefined,
          solo_boletas: !!(cfgs[v.company_id] && cfgs[v.company_id].solo_boletas),
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
      res.json({ ...v, tipo_sugerido: (v.anticipos[0] && v.anticipos[0].tipo) || sugerirTipo(v.cliente, cfgs[v.company_id]), cfg: cfgs[v.company_id] || null,
        hoy: hoyLima(), fecha_min: sumarDias(hoyLima(), -2), saldo_por_cobrar: saldo, credito_sugerido: saldo > 0.009 ? { fecha_pago: sumarDias(hoyLima(), 30), importe: saldo } : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Datos de un cliente por su RUC o DNI. El NOMBRE manda SUNAT (consulta APISUNAT), para no
  // confundir clientes; la ficha del ERP solo completa correo/teléfono o sirve si SUNAT no responde.
  const cacheSunat = new Map(); // num → { r, at }
  async function consultarSunat(num) {
    const tipo = tipoDocCliente(num);
    const c = cacheSunat.get(num);
    if (c && Date.now() - c.at < 12 * 3600e3) return c.r;
    const token = process.env.APISUNAT_TOKEN_1 || process.env.APISUNAT_TOKEN_2;
    if (!token || !tipo) return null;
    const url = tipo === '6'
      ? (process.env.APISUNAT_RUC_URL || 'https://dev.apisunat.pe/api/v1/business/ruc/') + num
      : (process.env.APISUNAT_DNI_URL || 'https://dev.apisunat.pe/api/v1/person/dni/') + num;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const d = await (await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal }).finally(() => clearTimeout(t))).json();
      const x = d && d.payload;
      const nombre = x && (x.razon_social || x.nombre_completo || [x.nombres, x.apellido_paterno, x.apellido_materno].filter(Boolean).join(' '));
      if (!nombre) return null;
      const r = { tipo_doc: tipo, doc: num, nombre: limpiar(nombre, 200), direccion: limpiar(x.direccion_fiscal || x.direccion || ''),
        estado: x.estado || null, condicion: x.condicion || null, fuente: 'SUNAT' };
      cacheSunat.set(num, { r, at: Date.now() });
      return r;
    } catch (e) { return null; }
  }
  async function fichaERP(num) {
    try {
      const cp = await columnasParty();
      const extra = ['direccion', 'email', 'telefono'].map(k => cp[k] ? `\`${cp[k]}\` AS ${k}` : `NULL AS ${k}`).join(', ');
      const [[p]] = await prodPool.query(`SELECT is_company, business_name, first_name, last_name, ${extra} FROM parties WHERE TRIM(document_number) = ? LIMIT 1`, [num]);
      return p ? { nombre: limpiar(p.is_company ? p.business_name : `${p.first_name || ''} ${p.last_name || ''}`, 200),
        direccion: limpiar(p.direccion), email: limpiar(p.email, 120), telefono: limpiar(p.telefono, 40) } : null;
    } catch (e) { return null; }
  }
  app.get('/api/fe/documento/:num', authAdmin, mFe, async (req, res) => {
    const num = String(req.params.num || '').replace(/\D/g, '');
    const tipo = tipoDocCliente(num);
    if (!tipo) return res.status(400).json({ error: 'Número no válido (8 dígitos DNI u 11 RUC)' });
    try {
      const [sunat, erp] = await Promise.all([consultarSunat(num), fichaERP(num)]);
      if (sunat) return res.json({ ...sunat, email: erp && erp.email || '', telefono: erp && erp.telefono || '', direccion: sunat.direccion || (erp && erp.direccion) || '' });
      if (erp) return res.json({ tipo_doc: tipo, doc: num, ...erp, fuente: 'sistema' });
      res.json({ tipo_doc: tipo, doc: num, nombre: '', fuente: null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Vista previa (no emite): totales, avisos y errores
  app.post('/api/fe/previsualizar', authAdmin, mFe, async (req, res) => {
    try {
      const cfgs = await leerConfig();
      const { cfg, tipo, datos } = await prepararDesdeVenta(req.body || {}, cfgs);
      const a = armarComprobante({ ...datos, tipo, serie: seriePara(cfg, tipo), numero: 0 }, cfg);
      res.json({ tipo, serie: seriePara(cfg, tipo), total: a.total, total_igv: a.total_igv, total_items: a.total_items, total_anticipos: a.total_anticipos,
        anticipos: a.doc.anticipos, moneda: a.doc.moneda, errores: a.errores, avisos: a.avisos, cliente: a.doc.cliente });
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
          const cli = it.cliente && it.cliente.doc ? { doc: String(it.cliente.doc).trim(), tipo_doc: it.cliente.tipo_doc || tipoDocCliente(it.cliente.doc), nombre: limpiar(it.cliente.nombre, 200) } : undefined;
          if (cli && !cli.nombre) throw Object.assign(new Error(`Falta el nombre o razón social para el documento ${cli.doc}`), { validacion: true });
          const { venta, cfg, tipo, datos } = await prepararDesdeVenta({ sale_id: it.sale_id, tipo: it.tipo, enviar_email: req.body.enviar_email, cliente: cli }, cfgs);
          const r = await emitirDocumento({ companyId: venta.company_id, tipo, serie: seriePara(cfg, tipo), datos, cfg, venta, usuario: quien(req) });
          resultados.push({ sale_id: it.sale_id, ok: true, comprobante: r });
        } catch (e) { resultados.push({ sale_id: it.sale_id, ok: false, error: e.message }); }
      }
      res.json({ resultados, ok: resultados.filter(r => r.ok).length, fallidos: resultados.filter(r => !r.ok).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Tipo de cambio del día (venta SBS, el que usa SUNAT) vía APISUNAT; si falla, el de referencia
  const cacheTC = {};
  app.get('/api/fe/tipo-cambio', authAdmin, mFe, async (req, res) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoyLima();
    if (cacheTC[fecha]) return res.json(cacheTC[fecha]);
    const token = process.env.APISUNAT_TOKEN_1 || process.env.APISUNAT_TOKEN_2;
    if (token) {
      try {
        const url = (process.env.APISUNAT_TC_URL || 'https://dev.apisunat.pe/api/v1/exchange-rate/sbs') + '?date=' + fecha;
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal }).finally(() => clearTimeout(t));
        const d = await r.json();
        const usd = d && d.payload && d.payload.USD;
        if (usd && Number(usd.sale) > 1) return res.json(cacheTC[fecha] = { fecha: usd.date || fecha, venta: Number(usd.sale), compra: Number(usd.purchase), fuente: 'SBS (APISUNAT)' });
      } catch (e) { /* se usa el de referencia */ }
    }
    res.json({ fecha, venta: TC_REFERENCIA, fuente: 'referencial (revísalo)' });
  });

  // ════════════════════ GUÍAS DE REMISIÓN ════════════════════
  // Catálogo de transporte: agencias (público), conductores y vehículos (propio)
  app.get('/api/fe/gre/transporte', authAdmin, mFe, async (req, res) => {
    try { await listo(); const [r] = await portalPool.query(`SELECT * FROM fe_gre_transporte WHERE activo = 1 ORDER BY clase, nombre, placa`); res.json({ transporte: r }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/fe/gre/transporte', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const b = req.body || {}, clase = b.clase;
      let v;
      if (clase === 'agencia') {
        if (tipoDocCliente(b.doc) !== '6') return res.status(400).json({ error: 'RUC de la agencia no válido' });
        if (!limpiar(b.nombre)) return res.status(400).json({ error: 'Falta la razón social' });
        v = { clase, doc: String(b.doc).trim(), nombre: limpiar(b.nombre, 200), mtc: limpiar(b.mtc, 20) || null };
      } else if (clase === 'conductor') {
        if (!limpiar(b.doc) || !limpiar(b.nombre) || !limpiar(b.apellidos) || !limpiar(b.licencia)) return res.status(400).json({ error: 'Completa DNI, nombres, apellidos y licencia' });
        v = { clase, doc: limpiar(b.doc, 15), nombre: limpiar(b.nombre, 100), apellidos: limpiar(b.apellidos, 100), licencia: limpiar(b.licencia, 20) };
      } else if (clase === 'vehiculo') {
        const placa = String(b.placa || '').replace(/[\s-]/g, '').toUpperCase();
        if (!/^[A-Z0-9]{5,8}$/.test(placa)) return res.status(400).json({ error: 'Placa no válida' });
        v = { clase, placa, detalle: limpiar(b.detalle, 100) || null };
      } else return res.status(400).json({ error: 'Tipo no válido' });
      const [r] = await portalPool.query(`INSERT INTO fe_gre_transporte SET ?`, [v]);
      res.json({ ok: true, id: r.insertId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/fe/gre/transporte/:id', authAdmin, mFe, async (req, res) => {
    try { await listo(); await portalPool.query(`UPDATE fe_gre_transporte SET activo = 0 WHERE id = ?`, [Number(req.params.id)]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Origen de la guía: un comprobante emitido o una venta. Devuelve empresa, destinatario,
  // productos y documentos relacionados (todo editable en la pantalla).
  async function origenGuia(q) {
    const err = m => Object.assign(new Error(m), { validacion: true });
    const cfgs = await leerConfig();
    let companyId, venta = null, items = [], relacionados = [], destinatario = null;
    if (q.comprobante_id) {
      const c = await leerComp(q.comprobante_id);
      if (!c) throw err('Comprobante no encontrado');
      if (!['factura', 'boleta'].includes(c.tipo)) throw err('La guía se emite desde una factura, una boleta o una venta');
      companyId = c.company_id;
      const p = JSON.parse(c.payload || '{}');
      destinatario = { ...(p.cliente || {}), telefono: c.cliente_telefono };
      relacionados = [{ tipo: c.tipo, serie: c.serie, numero: c.numero }];
      if (c.sale_id) { const [v] = await leerVentas([c.sale_id]); venta = v || null; }
      items = c.es_anticipo && venta
        ? venta.items.map(i => ({ codigo: i.codigo, descripcion: i.descripcion, cantidad: i.cantidad_venta }))
        : (p.items || []).map(i => ({ codigo: i.codigo, descripcion: i.descripcion, cantidad: i.cantidad }));
    } else if (q.transfer_id) {
      const t = await leerTransferencia(Number(q.transfer_id));
      if (!t) throw err('Transferencia no encontrada');
      companyId = t.company_id;
      const cfgT = cfgs[companyId] || {};
      const propio = { tipo_doc: '6', doc: cfgT.ruc || '', nombre: empresas[companyId] || '' };
      // Destinatario: el consignatario (entrega a consignación) o la propia empresa (devolución / entre almacenes)
      destinatario = t.destino.consignacion ? { ...t.destino.cliente } : propio;
      items = t.items;
      relacionados = [];
      if (!cfgT.activo) throw err(`${empresas[companyId] || 'La empresa'} no tiene activada la emisión de comprobantes`);
      return { companyId, cfg: cfgT, venta: null, items, relacionados, destinatario, transferencia: t, motivo: t.motivo,
        partida: t.origen.consignacion ? { ubigeo: '', direccion: t.origen.direccion || '' } : null,
        llegada: { ubigeo: '', direccion: t.destino.consignacion ? (t.destino.direccion || t.destino.cliente.direccion || '') : (t.destino.direccion || '') } };
    } else if (q.sale_id || q.codigo) {
      let id = Number(q.sale_id);
      if (!id && q.codigo) {
        const [[r]] = await prodPool.query(`SELECT id FROM sales WHERE code = ? AND deleted_at IS NULL`, [String(q.codigo).trim()]);
        if (!r) throw err('No existe la venta ' + q.codigo);
        id = r.id;
      }
      const [v] = await leerVentas([id]);
      if (!v) throw err('Venta no encontrada');
      venta = v; companyId = v.company_id; destinatario = v.cliente;
      items = v.items.map(i => ({ codigo: i.codigo, descripcion: i.descripcion, cantidad: i.cantidad_venta }));
      relacionados = v.comprobantes.filter(c => ['factura', 'boleta'].includes(c.tipo) || /factura|boleta/i.test(c.tipo || ''))
        .map(c => ({ tipo: /boleta/i.test(c.tipo) ? 'boleta' : 'factura', serie: c.serie, numero: c.numero }));
    } else throw err('Indica el comprobante o la venta');
    const cfg = cfgs[companyId];
    if (!cfg || !cfg.activo) throw err(`${empresas[companyId] || 'La empresa'} no tiene activada la emisión de comprobantes`);
    relacionados = relacionados.map(r => ({ ...r, ruc_emisor: cfg.ruc || '' }));
    return { companyId, cfg, venta, items, relacionados, destinatario: destinatario || {} };
  }

  // ── Transferencias de stock del ERP (consignación / entre almacenes) ──
  const TIPO_TRANSF = { '04': 'Consignación entregada', '03': 'Consignación devuelta', '11': 'Entre almacenes' };
  async function leerTransferencia(id) {
    const ct = await columnasTransfer();
    const [[t]] = await prodPool.query(`SELECT st.id, st.transfer_date, st.reference_number, st.operation_type_code, st.location_from_id, st.location_to_id
      ${ct.notas ? ', st.`' + ct.notas + '` AS notas' : ''}${ct.empresa ? ', st.`' + ct.empresa + '` AS company_id' : ''}
      FROM stock_transfers st WHERE st.id = ?`, [id]);
    if (!t) return null;
    const [locs] = await prodPool.query(`SELECT id, name${ct.tipoLoc ? ', `' + ct.tipoLoc + '` AS tipo' : ''}${ct.dirLoc ? ', `' + ct.dirLoc + '` AS direccion' : ''}
      FROM locations WHERE id IN (?)`, [[t.location_from_id, t.location_to_id]]);
    const loc = lid => { const l = locs.find(x => Number(x.id) === Number(lid)) || {}; return { id: lid, nombre: l.name || ('Almacén ' + lid), tipo: l.tipo || '', direccion: l.direccion || '', consignacion: l.tipo === 'consignment' }; };
    const origen = loc(t.location_from_id), destino = loc(t.location_to_id);
    // RUC del consignatario: el portal lo lee de las notas de la consignación (Gestión de clientes)
    let fact = {};
    const consig = [origen, destino].filter(x => x.consignacion).map(x => x.id);
    if (consig.length && grupos && grupos.facturacionDe) { try { fact = await grupos.facturacionDe(consig); } catch (e) { fact = {}; } }
    for (const l of [origen, destino]) {
      if (!l.consignacion) continue;
      const f = fact[l.id] || {};
      l.cliente = { tipo_doc: f.ruc ? tipoDocCliente(f.ruc) || '6' : '', doc: f.ruc || '', nombre: f.nombre || l.nombre, direccion: '', email: '' };
      if (f.customer_id) {
        const cp = await columnasParty();
        const sel = ['direccion', 'email'].filter(k => cp[k]).map(k => `\`${cp[k]}\` AS ${k}`).join(', ');
        if (sel) { const [[p]] = await prodPool.query(`SELECT ${sel} FROM parties WHERE id = ?`, [f.customer_id]); if (p) Object.assign(l.cliente, { direccion: limpiar(p.direccion), email: limpiar(p.email, 120) }); }
      }
    }
    const [items] = await prodPool.query(`SELECT sti.quantity, p.name AS producto, pv.name AS variacion, pv.sku
      FROM stock_transfer_items sti JOIN product_variations pv ON pv.id = sti.product_variation_id JOIN products p ON p.id = pv.product_id
      WHERE sti.stock_transfer_id = ? ORDER BY p.name`, [id]);
    const cfgs = await leerConfig();
    const activa = Object.values(cfgs).find(c => c.activo);
    // Motivo SUNAT (catálogo 20): entrega a consignación 05, devolución 06, entre almacenes propios 04
    const motivo = destino.consignacion ? '05' : origen.consignacion ? '06' : '04';
    return {
      id: t.id, fecha: t.transfer_date, referencia: t.reference_number || '', notas: t.notas || '',
      tipo: TIPO_TRANSF[t.operation_type_code] || (motivo === '04' ? 'Entre almacenes' : t.operation_type_code || ''),
      company_id: Number(t.company_id) || (activa ? activa.company_id : Number(Object.keys(empresas)[0])),
      origen, destino, motivo,
      items: items.map(i => ({ codigo: (i.sku || '').trim(), descripcion: nombreProdVar(i.producto, i.variacion), cantidad: Number(i.quantity) }))
    };
  }

  // Transferencias recientes sin N° de documento (candidatas a guía)
  app.get('/api/fe/guia/transferencias', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 60));
      const ct = await columnasTransfer();
      // Solo las que salen a / vuelven de una consignación necesitan guía. Los movimientos internos
      // (almacén principal ↔ tienda Kuranko, exhibición, cuarentena…) son el mismo local: no llevan guía.
      const tl = ct.tipoLoc;
      const filtroInternas = req.query.internas === '1' || !tl ? '' : `AND (lf.\`${tl}\` = 'consignment' OR lt.\`${tl}\` = 'consignment')`;
      const [rows] = await prodPool.query(`SELECT st.id, st.transfer_date AS fecha, st.reference_number AS referencia, st.operation_type_code AS codigo,
          lf.name AS origen, lt.name AS destino, ${tl ? `(lf.\`${tl}\` <> 'consignment' AND lt.\`${tl}\` <> 'consignment')` : '0'} AS interna,
          (SELECT COALESCE(SUM(sti.quantity),0) FROM stock_transfer_items sti WHERE sti.stock_transfer_id = st.id) AS unidades
        FROM stock_transfers st
        LEFT JOIN locations lf ON lf.id = st.location_from_id LEFT JOIN locations lt ON lt.id = st.location_to_id
        WHERE st.transfer_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${req.query.todas === '1' ? '' : "AND (st.reference_number IS NULL OR TRIM(st.reference_number) = '')"} ${filtroInternas}
        ORDER BY st.transfer_date DESC, st.id DESC LIMIT 300`, [dias]);
      const ids = rows.map(r => r.id);
      const [gs] = ids.length ? await portalPool.query(`SELECT transfer_id, serie, numero, estado FROM fe_comprobantes WHERE tipo='guia' AND transfer_id IN (?) AND estado NOT IN ('error','enviando','rechazado')`, [ids]) : [[]];
      const guia = Object.fromEntries(gs.map(g => [g.transfer_id, numDoc(g.serie, g.numero)]));
      res.json({ transferencias: rows.map(r => ({ ...r, interna: !!Number(r.interna), tipo: TIPO_TRANSF[r.codigo] || r.codigo, unidades: Number(r.unidades), guia: guia[r.id] || null })), escribe_erp: !!erpWritePool, columna_empresa: ct.empresa });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cambios hechos en el ERP (para revisar y deshacer)
  app.get('/api/fe/erp-log', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const [r] = await portalPool.query(`SELECT l.*, c.serie, c.numero, c.tipo FROM fe_erp_log l LEFT JOIN fe_comprobantes c ON c.id = l.comprobante_id
        ${req.query.comprobante_id ? 'WHERE l.comprobante_id = ' + Number(req.query.comprobante_id) : ''} ORDER BY l.id DESC LIMIT 300`);
      res.json({ cambios: r });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/fe/erp-log/:id/deshacer', authAdmin, mFe, soloMaestro, async (req, res) => {
    try {
      await listo();
      if (!erpWritePool) return res.status(400).json({ error: 'El portal no tiene acceso de escritura al sistema' });
      const [[l]] = await portalPool.query(`SELECT * FROM fe_erp_log WHERE id = ?`, [Number(req.params.id)]);
      if (!l) return res.status(404).json({ error: 'No existe' });
      if (l.deshecho_en) return res.status(400).json({ error: 'Ese cambio ya se deshizo' });
      if (l.tabla === 'sale_vouchers' && l.accion === 'insert') {
        const [r] = await erpWritePool.query(`DELETE FROM sale_vouchers WHERE id = ?`, [l.registro_id]);
        if (!r.affectedRows) return res.status(400).json({ error: 'El comprobante ya no estaba en el sistema' });
      } else if (l.tabla === 'stock_transfers' && l.accion === 'update' && /^(reference_number|notes|document_type_id)$/.test(l.campo)) {
        // Solo se restaura si nadie lo cambió después
        const [r] = await erpWritePool.query(`UPDATE stock_transfers SET \`${l.campo}\` = ? WHERE id = ? AND \`${l.campo}\` <=> ?`, [l.antes, l.registro_id, l.despues]);
        if (!r.affectedRows) return res.status(400).json({ error: 'El campo cambió después en el sistema; revísalo a mano' });
      } else if (l.tabla === 'sales' && l.accion === 'update' && /^(cancellation_reason|cancellation_document)$/.test(l.campo)) {
        const [r] = await erpWritePool.query(`UPDATE sales SET \`${l.campo}\` = ? WHERE id = ? AND \`${l.campo}\` <=> ?`, [l.antes, l.registro_id, l.despues]);
        if (!r.affectedRows) return res.status(400).json({ error: 'El campo cambió después en el sistema; revísalo a mano' });
      } else return res.status(400).json({ error: 'Este cambio no se puede deshacer automáticamente' });
      await portalPool.query(`UPDATE fe_erp_log SET deshecho_por = ?, deshecho_en = NOW() WHERE id = ?`, [quien(req), l.id]);
      if (l.comprobante_id) await portalPool.query(`UPDATE fe_comprobantes SET erp_estado = 'pendiente', erp_error = 'Deshecho por ${quien(req).replace(/'/g, '')}' WHERE id = ?`, [l.comprobante_id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo deshacer: ' + e.message }); }
  });

  // Datos de la guía a partir de lo que envía la pantalla
  function datosGuia(b, o) {
    return {
      fecha: b.fecha || hoyLima(), fecha_traslado: b.fecha_traslado || b.fecha || hoyLima(),
      motivo: b.motivo || o.motivo || '01', motivo_desc: b.motivo_desc, modalidad: b.modalidad,
      destinatario: { ...o.destinatario, ...(b.destinatario || {}) },
      partida: b.partida && b.partida.ubigeo ? b.partida : (o.partida || { ubigeo: o.cfg.partida_ubigeo, direccion: o.cfg.partida_direccion }),
      transfer_id: o.transferencia ? o.transferencia.id : null,
      llegada: b.llegada || {}, peso: b.peso, bultos: b.bultos,
      transportista: b.transportista, conductor: b.conductor, vehiculo: b.vehiculo,
      items: Array.isArray(b.items) ? b.items : o.items,
      relacionados: Array.isArray(b.relacionados) ? b.relacionados.map(r => ({ ...r, ruc_emisor: o.cfg.ruc || '' })) : o.relacionados,
      observaciones: b.observaciones || (o.venta ? `Venta ${o.venta.code}` : o.transferencia ? `Transferencia ${o.transferencia.origen.nombre} → ${o.transferencia.destino.nombre}` : ''),
      enviar_email: b.enviar_email != null ? !!b.enviar_email : o.cfg.enviar_email, formato_pdf: o.cfg.formato_pdf
    };
  }

  app.get('/api/fe/guia/borrador', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const o = await origenGuia(req.query);
      const [t] = await portalPool.query(`SELECT * FROM fe_gre_transporte WHERE activo = 1 ORDER BY clase, nombre, placa`);
      res.json({ company_id: o.companyId, empresa: empresas[o.companyId], serie: o.cfg.serie_guia, ruc_empresa: o.cfg.ruc,
        partida: o.partida || { ubigeo: o.cfg.partida_ubigeo, direccion: o.cfg.partida_direccion },
        venta: o.venta ? { id: o.venta.id, code: o.venta.code } : null,
        transferencia: o.transferencia ? { id: o.transferencia.id, fecha: o.transferencia.fecha, origen: o.transferencia.origen.nombre, destino: o.transferencia.destino.nombre, tipo: o.transferencia.tipo } : null,
        motivo: o.motivo || '01', escribe_erp: !!erpWritePool,
        destinatario: o.destinatario, llegada: o.llegada || { direccion: o.destinatario.direccion || '', ubigeo: '' },
        items: o.items, relacionados: o.relacionados, motivos: MOTIVOS_GRE, transporte: t,
        enviar_email: o.cfg.enviar_email, hoy: hoyLima() });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });
  app.post('/api/fe/guia/previsualizar', authAdmin, mFe, async (req, res) => {
    try {
      const o = await origenGuia(req.body || {});
      const a = armarGuia({ ...datosGuia(req.body || {}, o), serie: o.cfg.serie_guia, numero: 0 });
      if (!o.cfg.serie_guia) a.errores.push('Falta la serie de guías en Configuración');
      if (!o.cfg.ruc) a.avisos.push('Pon el RUC de la empresa en Configuración (va en los documentos relacionados)');
      res.json({ errores: a.errores, avisos: a.avisos });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });
  app.post('/api/fe/guia', authAdmin, mFe, async (req, res) => {
    try {
      const o = await origenGuia(req.body || {});
      if (!o.cfg.serie_guia) return res.status(400).json({ error: 'Falta la serie de guías en Configuración' });
      const datos = datosGuia(req.body || {}, o);
      datos.cliente = { telefono: (req.body.destinatario || {}).telefono || o.destinatario.telefono };
      const r = await emitirDocumento({ companyId: o.companyId, tipo: 'guia', serie: o.cfg.serie_guia, datos, cfg: o.cfg,
        venta: o.venta ? { id: o.venta.id, code: o.venta.code } : null, usuario: quien(req) });
      res.json({ ok: true, comprobante: r });
    } catch (e) { res.status(e.validacion ? 400 : 500).json({ error: e.message }); }
  });

  // Comprobantes emitidos desde el portal
  // Buscar ventas del sistema para emitirles la guía de remisión
  app.get('/api/fe/guia/ventas', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const dias = Math.min(730, Math.max(1, Number(req.query.dias) || 60));
      const cond = [`s.status IN ('confirmed','pending_payment','paid','completed')`, `s.deleted_at IS NULL`, `s.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`], params = [dias];
      if (req.query.empresa) { cond.push('s.company_id = ?'); params.push(Number(req.query.empresa)); }
      if (req.query.q) { const t = '%' + String(req.query.q).trim() + '%'; cond.push(`(s.code LIKE ? OR cli.business_name LIKE ? OR cli.first_name LIKE ? OR cli.last_name LIKE ? OR cli.document_number LIKE ?)`); params.push(t, t, t, t, t); }
      const [ventas] = await prodPool.query(`SELECT s.id, s.code, s.company_id, s.total, s.status, s.created_at,
          cli.business_name, cli.first_name, cli.last_name, cli.document_number,
          (SELECT GROUP_CONCAT(CONCAT(v.serie,'-',v.number) SEPARATOR ', ') FROM sale_vouchers v WHERE v.sale_id = s.id) comprobantes
        FROM sales s LEFT JOIN parties cli ON cli.id = s.customer_id WHERE ${cond.join(' AND ')} ORDER BY s.created_at DESC LIMIT 100`, params);
      const ids = ventas.map(v => v.id);
      const [gs] = ids.length ? await portalPool.query(`SELECT sale_id, serie, numero FROM fe_comprobantes WHERE tipo='guia' AND sale_id IN (?) AND estado IN ('aceptado','pendiente_sunat')`, [ids]) : [[]];
      res.json({ ventas: ventas.map(v => ({ id: v.id, code: v.code, empresa: empresas[v.company_id] || '', total: Number(v.total), estado: v.status,
        fecha: isoFecha(v.created_at), cliente: v.business_name || [v.first_name, v.last_name].filter(Boolean).join(' '), doc: v.document_number,
        comprobantes: v.comprobantes || '', guias: gs.filter(g => g.sale_id === v.id).map(g => numDoc(g.serie, g.numero)) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Buscador para emitir notas de crédito: facturas y boletas del portal, con el estado de su venta
  app.get('/api/fe/nc/buscar', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      const dias = Math.min(730, Math.max(1, Number(req.query.dias) || 90));
      const cond = [`c.tipo IN ('factura','boleta')`, `c.estado IN ('aceptado','pendiente_sunat')`, `c.fecha_emision >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`], params = [dias];
      if (req.query.empresa) { cond.push('c.company_id = ?'); params.push(Number(req.query.empresa)); }
      if (req.query.q) {
        const t = '%' + String(req.query.q).trim() + '%', n = normDoc(req.query.q);
        cond.push(`(c.sale_code LIKE ? OR c.cliente_nombre LIKE ? OR c.cliente_doc LIKE ? OR CONCAT(c.serie,'-',c.numero) = ?)`); params.push(t, t, t, n);
      }
      const [comps] = await portalPool.query(`SELECT c.id, c.company_id, c.tipo, c.serie, c.numero, c.sale_id, c.sale_code, c.fecha_emision, c.cliente_doc, c.cliente_nombre,
          c.total, c.moneda, c.es_anticipo, c.aplicado_en, c.anulado_por_nc
        FROM fe_comprobantes c WHERE ${cond.join(' AND ')} ORDER BY c.fecha_emision DESC, c.id DESC LIMIT 200`, params);
      if (!comps.length) return res.json({ comprobantes: [] });
      const [ncs] = await portalPool.query(`SELECT id, ref_id, serie, numero, total, nc_motivo FROM fe_comprobantes WHERE tipo='nc' AND ref_id IN (?) AND estado IN ('aceptado','pendiente_sunat')`, [comps.map(c => c.id)]);
      const ventaIds = [...new Set(comps.map(c => c.sale_id).filter(Boolean))];
      const [ventas] = ventaIds.length ? await prodPool.query(`SELECT id, status, cancellation_document FROM sales WHERE id IN (?)`, [ventaIds]) : [[]];
      res.json({ comprobantes: comps.map(c => {
        const v = ventas.find(x => x.id === c.sale_id);
        const notas = ncs.filter(n => n.ref_id === c.id).map(n => ({ id: n.id, numero_txt: numDoc(n.serie, n.numero), total: Number(n.total), motivo: n.nc_motivo,
          anotada: !!(v && v.cancellation_document && mencionaDoc(v.cancellation_document, n.serie, n.numero)) }));
        return { ...c, empresa: empresas[c.company_id] || '', numero_txt: numDoc(c.serie, c.numero), fecha_emision: isoFecha(c.fecha_emision), total: Number(c.total),
          venta_estado: v ? v.status : null, notas_credito: notas };
      }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ventas anuladas en el sistema y sus comprobantes, para emitirles la nota de crédito
  app.get('/api/fe/anuladas', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      await sincronizarNC();
      const dias = Math.min(730, Math.max(1, Number(req.query.dias) || 90));
      const cond = [`s.status = 'cancelled'`, `s.deleted_at IS NULL`, `COALESCE(s.cancelled_at, s.created_at) >= DATE_SUB(NOW(), INTERVAL ? DAY)`], params = [dias];
      if (req.query.empresa) { cond.push('s.company_id = ?'); params.push(Number(req.query.empresa)); }
      if (req.query.q) { const t = '%' + String(req.query.q).trim() + '%'; cond.push(`(s.code LIKE ? OR cli.business_name LIKE ? OR cli.first_name LIKE ? OR cli.last_name LIKE ? OR cli.document_number LIKE ?)`); params.push(t, t, t, t, t); }
      const [ventas] = await prodPool.query(`SELECT s.id, s.code, s.company_id, s.total, s.cancelled_at, s.created_at, s.cancellation_reason, s.cancellation_document,
          cli.business_name, cli.first_name, cli.last_name, cli.document_number
        FROM sales s LEFT JOIN parties cli ON cli.id = s.customer_id WHERE ${cond.join(' AND ')} ORDER BY COALESCE(s.cancelled_at, s.created_at) DESC LIMIT 300`, params);
      if (!ventas.length) return res.json({ ventas: [] });
      const ids = ventas.map(v => v.id);
      const [comps] = await portalPool.query(`SELECT id, tipo, serie, numero, sale_id, total, moneda, estado, ref_id, anulado_por_nc, erp_estado, erp_error, fecha_emision
        FROM fe_comprobantes WHERE sale_id IN (?) AND estado IN ('aceptado','pendiente_sunat') AND tipo IN ('factura','boleta','nc')`, [ids]);
      const [ext] = await prodPool.query(`SELECT sale_id, type, serie, number, amount FROM sale_vouchers WHERE sale_id IN (?)`, [ids]);
      res.json({ ventas: ventas.map(v => {
        const cp = comps.filter(c => c.sale_id === v.id && c.tipo !== 'nc').map(c => {
          const ncs = comps.filter(n => n.tipo === 'nc' && n.ref_id === c.id);
          return { ...c, numero_txt: numDoc(c.serie, c.numero), notas_credito: ncs.map(n => ({ id: n.id, numero_txt: numDoc(n.serie, n.numero), total: n.total, erp_estado: n.erp_estado, erp_error: n.erp_error })) };
        });
        // Comprobantes anotados en el sistema que NO salieron del portal (SOL, a mano)
        const externos = ext.filter(x => x.sale_id === v.id && !cp.some(c => normDoc(`${x.serie}-${x.number}`) === normDoc(numDoc(c.serie, c.numero))))
          .map(x => ({ tipo: x.type, numero_txt: `${x.serie}-${x.number}`, monto: Number(x.amount) }));
        const pendiente = cp.some(c => !c.anulado_por_nc);
        return { id: v.id, code: v.code, empresa: empresas[v.company_id] || '', company_id: v.company_id, total: Number(v.total),
          fecha: isoFecha(v.cancelled_at || v.created_at), motivo: v.cancellation_reason, documento: v.cancellation_document,
          cliente: v.business_name || [v.first_name, v.last_name].filter(Boolean).join(' '), doc: v.document_number,
          comprobantes: cp, externos, estado: cp.length ? (pendiente ? 'falta_nc' : 'con_nc') : (externos.length ? 'externo' : 'sin_comprobante') };
      }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/fe/emitidos', authAdmin, mFe, async (req, res) => {
    try {
      await listo();
      await detectarAnotados();
      await sincronizarNC();
      const q = req.query;
      const cond = ['1=1'], params = [];
      if (esFecha(q.desde)) { cond.push('fecha_emision >= ?'); params.push(q.desde); }
      if (esFecha(q.hasta)) { cond.push('fecha_emision <= ?'); params.push(q.hasta); }
      if (q.empresa) { cond.push('company_id = ?'); params.push(Number(q.empresa)); }
      if (q.tipo === 'fb') cond.push(`tipo IN ('factura','boleta')`);
      else if (q.tipo) { cond.push('tipo = ?'); params.push(q.tipo); }
      if (q.estado === 'credito') cond.push(`tipo IN ('factura','boleta') AND estado IN ('aceptado','pendiente_sunat') AND anulado_por_nc IS NULL AND sale_id IS NOT NULL`);
      else if (q.estado === 'erp') cond.push(`tipo NOT IN ('nc','guia') AND estado IN ('aceptado','pendiente_sunat') AND erp_estado IN ('pendiente','error')`);
      else if (q.estado === 'revisar') cond.push(`estado IN ('incierto','pendiente_sunat','rechazado')`);
      else if (q.estado) { cond.push('estado = ?'); params.push(q.estado); }
      if (q.q) { const t = '%' + String(q.q).trim() + '%'; cond.push(`(cliente_nombre LIKE ? OR cliente_doc LIKE ? OR sale_code LIKE ? OR CONCAT(serie,'-',numero) LIKE ?)`); params.push(t, t, t, t); }
      const [rows] = await portalPool.query(`SELECT id, company_id, tipo, serie, numero, sale_id, sale_code, fecha_emision, cliente_tipo_doc, cliente_doc, cliente_nombre, moneda, monto_venta, tipo_cambio, es_anticipo, aplicado_en, transfer_id,
        cliente_email, cliente_telefono, total, total_igv, credito, estado, sunat_desc, enlace, enlace_pdf, enlace_xml, enlace_cdr, ref_id, ref_tipo, ref_serie, ref_numero,
        nc_motivo, anulado_por_nc, erp_estado, erp_error, erp_por, email_enviado, emitido_por, creado
        FROM fe_comprobantes WHERE ${cond.join(' AND ')} AND estado <> 'enviando' ORDER BY creado DESC LIMIT 1000`, params);
      let lista = rows.map(r => ({ ...r, empresa: empresas[r.company_id] || '' }));
      // Saldo por cobrar de la venta y vencimiento (para comprobantes al crédito)
      const conVenta = lista.filter(r => ['factura', 'boleta'].includes(r.tipo) && r.sale_id && (r.credito || q.estado === 'credito'));
      if (conVenta.length) {
        const ventas = await leerVentas([...new Set(conVenta.map(r => r.sale_id))]);
        const porId = Object.fromEntries(ventas.map(v => [v.id, v]));
        const [pl] = await portalPool.query(`SELECT id, payload FROM fe_comprobantes WHERE id IN (?)`, [conVenta.map(r => r.id)]);
        const venc = Object.fromEntries(pl.map(x => { try { const d = JSON.parse(x.payload); return [x.id, d.credito ? d.credito.vencimiento : null]; } catch (e) { return [x.id, null]; } }));
        const hoy = hoyLima();
        lista = lista.map(r => {
          const v = r.sale_id && porId[r.sale_id];
          if (!v || !conVenta.some(c => c.id === r.id)) return r;
          const saldo = r2(Math.max(0, v.total - v.pagado));
          const vence = venc[r.id] || null;
          const dias = vence ? Math.round((new Date(vence + 'T12:00:00Z') - new Date(hoy + 'T12:00:00Z')) / 864e5) : null;
          return { ...r, saldo_venta: saldo, moneda_venta: v.moneda, vence, dias_para_vencer: dias };
        });
        if (q.estado === 'credito') lista = lista.filter(r => r.saldo_venta > 0.009);
      }
      res.json({ comprobantes: lista });
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
    if (est.estado !== 'rechazado' && ['pendiente', 'error'].includes(c.erp_estado) && c.tipo !== 'nc' && (c.tipo !== 'guia' || c.transfer_id)) {
      const erp = await registrarDoc({ ...c, fecha_emision: isoFecha(c.fecha_emision) }, quien(req));
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
      const erp = await registrarDoc({ ...c, fecha_emision: isoFecha(c.fecha_emision) }, quien(req));
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
        precio: Number(it.precio_unitario), total: Number(it.total), sale_item_id: it.sale_item_id !== undefined ? it.sale_item_id : ((vinc[i] && vinc[i].sale_item_id) || null) }));
      res.json({ id: c.id, tipo: c.tipo, serie: c.serie, numero: c.numero, total: Number(c.total), cliente_nombre: c.cliente_nombre, moneda: c.moneda || 'PEN',
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
      if (c.tipo === 'guia') return res.status(400).json({ error: 'La guía de remisión no lleva nota de crédito' });
      if (!['aceptado', 'pendiente_sunat'].includes(c.estado)) return res.status(400).json({ error: 'El comprobante no está aceptado por SUNAT' });
      if (c.anulado_por_nc) return res.status(400).json({ error: 'El comprobante ya fue anulado con una nota de crédito' });
      if (c.es_anticipo && c.aplicado_en) return res.status(400).json({ error: 'Este anticipo ya se descontó en el comprobante final: haz la nota de crédito sobre el comprobante final' });
      const cfgs = await leerConfig();
      const cfg = cfgs[c.company_id];
      const motivo = Number(req.body && req.body.motivo);
      if (!MOTIVOS_NC[motivo]) return res.status(400).json({ error: 'Elige el motivo' });
      const orig = JSON.parse(c.payload || '{}');
      if ((orig.anticipos || []).length && motivo !== 9)
        return res.status(400).json({ error: 'Este comprobante descontó anticipos: usa "Disminución en el valor" (motivo 9) por el monto a devolver' });
      const [vinc] = await portalPool.query(`SELECT sale_item_id, cantidad FROM fe_comprobante_items WHERE comprobante_id = ?`, [c.id]);
      const [ncPrev] = await portalPool.query(`SELECT COALESCE(SUM(total),0) t FROM fe_comprobantes WHERE ref_id = ? AND tipo='nc' AND estado NOT IN ('error','enviando')`, [c.id]);
      const disponible = r2(Number(c.total) - Number(ncPrev[0].t));
      const base = (orig.items || []).map((it, i) => ({ codigo: it.codigo, descripcion: it.descripcion, cantidad: Number(it.cantidad), precio: Number(it.precio_unitario), unidad: it.unidad,
        sale_item_id: it.sale_item_id !== undefined ? it.sale_item_id : (vinc[i] ? vinc[i].sale_item_id : null) }));
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
        observaciones: limpiar(req.body.observaciones) || MOTIVOS_NC[motivo], enviar_email: cfg.enviar_email, formato_pdf: cfg.formato_pdf,
        moneda: c.moneda || orig.moneda || 'PEN', tipo_cambio: orig.tipo_cambio || null,
        factor_venta: c.monto_venta != null && Number(c.total) > 0 ? Number(c.monto_venta) / Number(c.total) : 1 };
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
        formato_pdf: ['A4', 'A5', 'TICKET'].includes(b.formato_pdf) ? b.formato_pdf : 'A4',
      };
      // Datos de guías: solo se cambian si vienen en el pedido
      if (b.ruc !== undefined) vals.ruc = b.ruc ? String(b.ruc).trim() : null;
      if (b.serie_guia !== undefined) vals.serie_guia = b.serie_guia ? serie(b.serie_guia, 'T') : null;
      if (b.partida_ubigeo !== undefined) vals.partida_ubigeo = b.partida_ubigeo ? String(b.partida_ubigeo).trim().slice(0, 6) : null;
      if (b.partida_direccion !== undefined) vals.partida_direccion = limpiar(b.partida_direccion) || null;
      if (vals.ruc && tipoDocCliente(vals.ruc) !== '6') throw Object.assign(new Error('El RUC de la empresa no es válido'), { validacion: true });
      if (vals.partida_ubigeo && !esUbigeo(vals.partida_ubigeo)) throw Object.assign(new Error('El ubigeo del punto de partida debe tener 6 dígitos'), { validacion: true });
      const [otras] = await portalPool.query(`SELECT company_id, serie_factura, serie_boleta, serie_nc_factura, serie_nc_boleta, serie_guia FROM fe_config WHERE company_id <> ?`, [id]);
      const mias = [vals.serie_factura, vals.serie_boleta, vals.serie_nc_factura, vals.serie_nc_boleta, vals.serie_guia].filter(Boolean);
      const choque = otras.find(o => [o.serie_factura, o.serie_boleta, o.serie_nc_factura, o.serie_nc_boleta, o.serie_guia].some(x => x && mias.includes(x)));
      if (choque) return res.status(400).json({ error: `Usa series distintas a las de ${empresas[choque.company_id]}: el sistema y el cruce con SUNAT no distinguen empresa` });
      await portalPool.query(`UPDATE fe_config SET ?, actualizado_por=?, actualizado=NOW() WHERE company_id=?`, [vals, quien(req), id]);
      // Último número usado por serie (para continuar una serie ya usada en el panel del proveedor)
      for (const [s, v] of Object.entries(b.correlativos || {})) {
        if (!/^[FBT][A-Z0-9]{3}$/.test(s) || !(Number(v) >= 0)) continue;
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
