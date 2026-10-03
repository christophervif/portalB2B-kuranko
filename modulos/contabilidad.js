// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Contabilidad
//  · Kardex valorizado (FIFO por lotes, con saldo inicial y formato
//    entradas / salidas / saldo, como el registro de inventario SUNAT 13.1).
//  · Reporte de pagos (con las hojas agrupadas de facturas y boletas).
//  Frontend propio: public/contabilidad.html (iframe dentro de admin.html).
//  Permiso: módulo 'reportes' (pestaña "Contabilidad").
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel, nombreProdVar } = require('./comunes');

// ─── Catálogos ──────────────────────────────────────────────────────────────
// Tabla 12 SUNAT (tipo de operación) → nombre legible.
// (Antes vivían en accesos.js y este módulo los usaba sin importarlos:
//  el kardex fallaba con "TIPO_MOV_NOM is not defined" en cuanto había un movimiento.)
const CODIGOS_SUNAT = {
  '01': 'Venta Nacional', '02': 'Compra Nacional', '03': 'Consignación Recibida',
  '04': 'Consignación Entregada', '05': 'Devolución Recibida', '06': 'Devolución Entregada',
  '07': 'Bonificación', '08': 'Premio', '09': 'Donación', '10': 'Salida a Producción',
  '11': 'Transferencia entre almacenes', '12': 'Retiro', '13': 'Mermas', '14': 'Desmedros',
  '15': 'Destrucción', '16': 'Saldo Inicial', '17': 'Exportación', '18': 'Importación',
  '19': 'Entrada de Producción'
};
const TIPO_MOV_NOM = {
  purchase: 'Entrada', sale: 'Venta', transfer: 'Transferencia',
  adjustment: 'Ajuste', return: 'Devolución'
};
const REF_ENTRADA = 'App\\Models\\StockEntry';
const REF_TRANSF = 'App\\Models\\StockTransfer';
const REF_VENTA = 'App\\Models\\Sale';
const LIMITE_FILAS_PANTALLA = 5000;   // el Excel siempre trae todo

// ─── Utilidades puras ───────────────────────────────────────────────────────
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;
const esPckMkp = sku => /MKP|PCK/i.test(sku || '');
const esFecha = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const p2 = n => String(n).padStart(2, '0');

// Hoy en Lima como 'AAAA-MM-DD'
function hoyLima() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); }

// Fecha de la base tal cual está guardada ('AAAA-MM-DD HH:MM'), SIN convertir zona horaria.
// mysql2 arma el Date con la hora local del servidor, así que los getters locales
// devuelven exactamente lo que dice la base. Así la fecha mostrada coincide con la del
// filtro (antes se convertía a Lima en el navegador y podía correrse 5 horas).
function literalFecha(d, conHora = true) {
  if (!d) return '';
  if (typeof d === 'string') return conHora ? d.slice(0, 16) : d.slice(0, 10);
  const s = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return conHora ? `${s} ${p2(d.getHours())}:${p2(d.getMinutes())}` : s;
}
// 'AAAA-MM-DD…' → 'd/m/aaaa' (y la hora si se pide)
function fechaTxt(lit, conHora = false) {
  if (!lit) return '';
  const m = String(lit).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return String(lit);
  const f = `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
  return conHora && m[4] ? `${f} ${m[4]}:${m[5]}` : f;
}

function rangoMesActual() {
  const h = hoyLima();
  const [a, m] = h.split('-').map(Number);
  return { desde: `${a}-${p2(m)}-01`, hasta: `${a}-${p2(m)}-${p2(new Date(a, m, 0).getDate())}` };
}

// ─── Dirección de un movimiento ─────────────────────────────────────────────
// No se confía en el signo de la cantidad (el ERP no es consistente entre tipos):
// la dirección sale de las ubicaciones. Solo si no hay pista se usa tipo/signo.
function direccionMov(m) {
  const f = m.from || null, t = m.to || null, q = Number(m.quantity) || 0;
  if (f && t && f !== t) return { dir: 'transfer', from: f, to: t };
  if (t && !f) return { dir: 'in', loc: t };
  if (f && !t) return { dir: 'out', loc: f };
  const loc = f || t || 0;
  if (m.type === 'sale') return { dir: 'out', loc };
  if (m.type === 'purchase') return { dir: 'in', loc };
  return { dir: q < 0 ? 'out' : 'in', loc };
}

// ─── Simulación FIFO del kardex (puro, testeable) ───────────────────────────
// movs: historia completa hasta 'hasta', ya ordenada por variación, fecha, id.
//   { id, vid, sku, type, quantity, fecha ('AAAA-MM-DD HH:MM'), ref_type, ref_id, from, to }
// ctx: { desde, ubicacion (id o null), costoEntrada(m) → número|null }
// Devuelve por variación: saldo inicial, entradas, salidas, saldo final y las filas
// del periodo con su costo FIFO. Los lotes viven por ubicación: una transferencia
// mueve las piezas con su costo; una salida consume los lotes más antiguos de esa
// ubicación (y si no alcanza, los de otras, con aviso).
function simularKardex(movs, ctx) {
  const desde = ctx.desde || '0000-00-00';
  const U = ctx.ubicacion ? Number(ctx.ubicacion) : null;
  const porVar = new Map();
  let seq = 0;

  let st = null, vidActual = null, acc = null;
  const nuevo = (vid, sku) => ({
    vid, sku, ini_q: 0, ini_v: 0, ent_q: 0, ent_v: 0, sal_q: 0, sal_v: 0,
    fin_q: 0, fin_v: 0, n_mov: 0, n_alertas: 0, filas: [], _enPeriodo: false
  });
  const loteDe = (loc) => {
    if (!st.locs.has(loc)) st.locs.set(loc, { lotes: [], deficit: 0 });
    return st.locs.get(loc);
  };
  const costoPromedio = () => {
    let q = 0, v = 0;
    st.locs.forEach(L => L.lotes.forEach(l => { q += l.q; v += l.q * l.c; }));
    return q > 0 ? v / q : null;
  };
  const meter = (loc, piezas) => {
    const L = loteDe(loc);
    piezas.forEach(p => {
      let q = p.q;
      if (L.deficit > 0) { const c = Math.min(L.deficit, q); L.deficit -= c; q -= c; }
      if (q > 1e-9) L.lotes.push({ q, c: p.c, s: p.s != null ? p.s : ++seq });
    });
  };
  // Saca q unidades de loc (FIFO). Si faltan, toma de otras ubicaciones (el lote más
  // antiguo del producto). Si aun así faltan → stock negativo a último costo.
  const sacar = (loc, q) => {
    const piezas = []; let deOtra = false, negativo = false;
    const consumir = (L, cuanto) => {
      while (cuanto > 1e-9 && L.lotes.length) {
        const l = L.lotes[0]; const c = Math.min(l.q, cuanto);
        piezas.push({ q: c, c: l.c, s: l.s }); l.q -= c; cuanto -= c;
        if (l.q <= 1e-9) L.lotes.shift();
      }
      return cuanto;
    };
    let falta = consumir(loteDe(loc), q);
    while (falta > 1e-9) {
      let mejor = null;
      st.locs.forEach((L, k) => { if (k !== loc && L.lotes.length && (!mejor || L.lotes[0].s < mejor.lotes[0].s)) mejor = L; });
      if (!mejor) break;
      deOtra = true;
      const tomar = Math.min(falta, mejor.lotes[0].q);
      falta = falta - tomar + consumir(mejor, tomar);
    }
    if (falta > 1e-9) {
      negativo = true;
      piezas.push({ q: falta, c: st.ultimoCosto != null ? st.ultimoCosto : 0, s: null });
      loteDe(loc).deficit += falta;
    }
    return { piezas, deOtra, negativo };
  };
  const valor = piezas => piezas.reduce((s, p) => s + p.q * p.c, 0);

  const cerrarVar = () => {
    if (!acc) return;
    if (!acc._enPeriodo) { acc.ini_q = acc._run_q; acc.ini_v = acc._run_v; }
    acc.fin_q = acc._run_q; acc.fin_v = acc._run_v;
    ['ini_q', 'ini_v', 'ent_q', 'ent_v', 'sal_q', 'sal_v', 'fin_q', 'fin_v'].forEach(k => acc[k] = r4(acc[k]));
    acc.fin_cu = acc.fin_q > 0 ? r4(acc.fin_v / acc.fin_q) : null;
    delete acc._run_q; delete acc._run_v; delete acc._enPeriodo;
    porVar.set(acc.vid, acc);
  };

  for (const m of movs) {
    if (m.vid !== vidActual) {
      cerrarVar();
      vidActual = m.vid; st = { locs: new Map(), ultimoCosto: null };
      acc = nuevo(m.vid, m.sku); acc._run_q = 0; acc._run_v = 0;
    }
    const enPeriodo = (m.fecha || '') >= desde;
    if (enPeriodo && !acc._enPeriodo) { acc._enPeriodo = true; acc.ini_q = acc._run_q; acc.ini_v = acc._run_v; }

    const d = direccionMov(m);
    const q = Math.abs(Number(m.quantity) || 0);
    const alertas = [];
    let ent = null, sal = null, transfQ = null, locMostrar = null;

    if (d.dir === 'in') {
      let c = null, estimado = false;
      if (m.ref_type === REF_ENTRADA && ctx.costoEntrada) c = ctx.costoEntrada(m);
      if (c == null && !(m.ref_type === REF_ENTRADA)) {
        c = costoPromedio(); if (c == null) c = st.ultimoCosto; estimado = c != null;
      }
      if (c == null || c === 0) {
        alertas.push(esPckMkp(m.sku) ? ['Sin costo (PCK/MKP, normal)', 'ok'] : ['Sin costo — revisar', 'err']);
        if (c == null) c = 0;
      } else if (estimado) alertas.push(['Costo estimado (sin lote propio)', 'info']);
      if ((m.ref_type === REF_ENTRADA || m.type === 'purchase') && c > 0) st.ultimoCosto = c;
      meter(d.loc, [{ q, c }]);
      if (!U || d.loc === U) ent = { q, v: q * c }; else ent = null;
      locMostrar = d.loc;
    } else if (d.dir === 'out') {
      const r = sacar(d.loc, q);
      if (r.negativo) alertas.push(esPckMkp(m.sku) ? ['Sin stock (PCK/MKP, normal)', 'ok'] : ['Stock negativo — revisar', 'warn']);
      else if (r.deOtra) alertas.push(['Costo tomado de otra ubicación', 'info']);
      const v = valor(r.piezas);
      if (q > 0 && v === 0 && !r.negativo) alertas.push(esPckMkp(m.sku) ? ['Sin costo (PCK/MKP, normal)', 'ok'] : ['Sin costo — revisar', 'err']);
      if (!U || d.loc === U) sal = { q, v };
      locMostrar = d.loc;
    } else { // transferencia
      const r = sacar(d.from, q);
      if (r.negativo) alertas.push(['Stock negativo en origen — revisar', 'warn']);
      meter(d.to, r.piezas.map(p => ({ q: p.q, c: p.c, s: p.s })));
      const v = valor(r.piezas);
      if (U) { if (d.from === U) sal = { q, v }; else if (d.to === U) ent = { q, v }; }
      else transfQ = q;
    }

    const relevante = !U || ent || sal;
    if (!relevante) continue;
    if (ent) { acc._run_q += ent.q; acc._run_v += ent.v; }
    if (sal) { acc._run_q -= sal.q; acc._run_v -= sal.v; }
    if (!enPeriodo) continue;

    if (ent) { acc.ent_q += ent.q; acc.ent_v += ent.v; }
    if (sal) { acc.sal_q += sal.q; acc.sal_v += sal.v; }
    acc.n_mov++;
    const peor = alertas.find(a => a[1] === 'err') || alertas.find(a => a[1] === 'warn') || alertas[0];
    if (alertas.some(a => a[1] === 'err' || a[1] === 'warn')) acc.n_alertas++;
    acc.filas.push({
      id: m.id, vid: m.vid, fecha: m.fecha, type: m.type,
      dir: ent ? 'in' : sal ? 'out' : 'transfer',
      ent_q: ent ? r4(ent.q) : null, ent_cu: ent && ent.q ? r4(ent.v / ent.q) : null, ent_v: ent ? r2(ent.v) : null,
      sal_q: sal ? r4(sal.q) : null, sal_cu: sal && sal.q ? r4(sal.v / sal.q) : null, sal_v: sal ? r2(sal.v) : null,
      transf_q: transfQ,
      saldo_q: r4(acc._run_q), saldo_v: r2(acc._run_v),
      saldo_cu: acc._run_q > 1e-9 ? r4(acc._run_v / acc._run_q) : null,
      loc: locMostrar, from: d.from || null, to: d.to || null,
      alerta: peor ? peor[0] : '', alerta_nivel: peor ? peor[1] : '',
      ref_type: m.ref_type, ref_id: m.ref_id
    });
  }
  cerrarVar();
  return porVar;
}

// Filtro de filas del periodo (operación y solo alertas). Puro.
function filtrarFilasKardex(filas, f) {
  return filas.filter(x => {
    if (f.solo_alertas && !(x.alerta_nivel === 'err' || x.alerta_nivel === 'warn')) return false;
    if (!f.operacion) return true;
    if (f.operacion.startsWith('dir:')) return x.dir === f.operacion.slice(4);
    if (f.operacion.startsWith('cod:')) return x.codigo === f.operacion.slice(4);
    return true;
  });
}

function leerFiltrosKardex(q) {
  const def = rangoMesActual();
  let desde = esFecha(q.desde) ? q.desde : def.desde;
  let hasta = esFecha(q.hasta) ? q.hasta : def.hasta;
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  // 'producto' y 'sku' se mantienen por compatibilidad; ahora hay un solo buscador 'texto'
  const texto = String(q.texto || q.producto || q.sku || '').trim().slice(0, 120);
  const ubicacion = /^\d+$/.test(String(q.ubicacion || '')) ? Number(q.ubicacion) : null;
  const operacion = /^(dir:(in|out|transfer)|cod:\d{2})$/.test(q.operacion || '') ? q.operacion : '';
  return { desde, hasta, texto, ubicacion, operacion, solo_alertas: q.solo_alertas === '1' };
}

// ─── Reporte de pagos: filtros en memoria (puro) ────────────────────────────
function filtrarPagos(lista, f) {
  const txt = (f.q || '').trim().toLowerCase();
  return lista.filter(x => {
    if (f.empresa_producto && !x._empresas_prod_ids.includes(Number(f.empresa_producto))) return false;
    if (f.tipo_comprobante === 'factura' && !(x.tipo_comprobante === 'factura' || x.tipo_comprobante === 'mixto')) return false;
    if (f.tipo_comprobante === 'boleta' && !(x.tipo_comprobante === 'boleta' || x.tipo_comprobante === 'mixto')) return false;
    if (f.tipo_comprobante === 'sin' && x.tipo_comprobante) return false;
    if (f.saldo === 'con_saldo' && !(x.venta_saldo > 0)) return false;
    if (f.saldo === 'pagada' && x.venta_saldo > 0) return false;
    if (txt) {
      const h = [x.cliente, x.cliente_doc, x.venta, x.comprobante, x.nota_pago, x.obs_venta].join(' ').toLowerCase();
      if (!h.includes(txt)) return false;
    }
    return true;
  });
}

// Agrupa por venta (orden por primer pago) y calcula el cobrado en el rango. Puro.
function ordenarYAgrupar(lista) {
  const primer = {};
  lista.forEach(x => { if (primer[x._sale_id] == null || x.fecha < primer[x._sale_id]) primer[x._sale_id] = x.fecha; });
  lista.sort((a, b) => (primer[a._sale_id] < primer[b._sale_id] ? -1 : primer[a._sale_id] > primer[b._sale_id] ? 1 : 0)
    || (a._sale_id - b._sale_id) || (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  const tot = {};
  lista.forEach(x => tot[x._sale_id] = (tot[x._sale_id] || 0) + x.monto);
  lista.forEach(x => x._total_venta = r2(tot[x._sale_id]));
  return lista;
}

function resumenPagos(lista) {
  const sum = (arr) => r2(arr.reduce((s, x) => s + x.monto, 0));
  const agrupar = (campo) => {
    const o = {}; lista.forEach(x => o[x[campo]] = (o[x[campo]] || 0) + x.monto);
    return Object.entries(o).map(([k, v]) => ({ k, v: r2(v) })).sort((a, b) => b.v - a.v);
  };
  return {
    pagos: lista.length,
    ventas: new Set(lista.map(x => x._sale_id)).size,
    suma: sum(lista),
    sin_comprobante: sum(lista.filter(x => !x.tipo_comprobante)),
    n_sin_comprobante: lista.filter(x => !x.tipo_comprobante).length,
    canceladas: sum(lista.filter(x => x.estado_venta === 'cancelled')),
    n_canceladas: lista.filter(x => x.estado_venta === 'cancelled').length,
    sin_cierre: sum(lista.filter(x => x.cuadre !== 'Cerrado')),
    por_metodo: agrupar('metodo'),
    por_empresa_cuenta: agrupar('empresa_cuenta'),
    por_cuenta: agrupar('cuenta')
  };
}

const ESTADO_VENTA = { paid: 'Pagada', confirmed: 'Confirmada', pending_payment: 'Pago pendiente', cancelled: 'Cancelada' };

// ─── Comprobantes SUNAT vs sistema (puro) ───────────────────────────────────
// Lee el texto del "Listado de CPE emitidos" de SUNAT (Facturas o Boletas, impreso
// a PDF) y devuelve { tipo, desde, hasta, periodo, filas }. El texto llega del
// navegador (pdf.js); el nombre del archivo no importa: el tipo se lee del título.
function arreglarTexto(s) {
  s = String(s || '').replace(/\u0000/g, '');
  // SUNAT a veces entrega UTF-8 leído como Latin-1 ("NUÃ‘EZ"): intentar repararlo
  if (/Ã|Â/.test(s)) {
    try { const r = Buffer.from(s, 'latin1').toString('utf8'); if (!r.includes('�')) return r; } catch (e) {}
  }
  // Lo que no se pudo reparar: "NUÃ EZ" casi siempre es Ñ (el segundo byte se pierde)
  return s.replace(/Ã\s(?=[A-ZÁÉÍÓÚ])/g, 'Ñ');
}
function parsearListadoCPE(texto) {
  const t = String(texto || '').replace(/\u0000/g, '').replace(/\s+/g, ' ');
  let tipo = null;
  if (/Boletas?\s+de\s+Venta/i.test(t)) tipo = 'boleta';
  else if (/Notas?\s+de\s+(Cr[eé]dito|D[eé]bito)/i.test(t)) tipo = 'nota';
  else if (/Facturas?\s+Electr/i.test(t) || /\bFacturas?\b/i.test(t)) tipo = 'factura';
  const per = t.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
  const desde = per ? `${per[3]}-${per[2]}-${per[1]}` : null;
  const hasta = per ? `${per[6]}-${per[5]}-${per[4]}` : null;

  const SERIE = /\b([A-Z][A-Z0-9]{3})\s*-\s*(\d{1,8})\s/g;
  const inicios = [];
  let m;
  while ((m = SERIE.exec(t))) inicios.push({ i: m.index, serie: m[1], numero: Number(m[2]), fin: SERIE.lastIndex });
  const filas = [];
  for (let k = 0; k < inicios.length; k++) {
    const a = inicios[k];
    const bloque = t.slice(a.fin, k + 1 < inicios.length ? inicios[k + 1].i : t.length);
    const r = bloque.match(/^\s*(?:([0-9A-Z]{1,15})?\s*-\s+)?(.*?)\s*(S\/|US\$|\$)\s?(-?[\d,]+\.\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})(.*)$/);
    if (!r) continue;                         // no es una fila (p. ej. el rango del encabezado)
    let cola = r[8] || '';
    const corte = cola.search(/https?:|\.::|\d{1,2}\/\d{1,2}\/\d{2},|Nro\. CPE/);
    if (corte >= 0) cola = cola.slice(0, corte);
    const rech = cola.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    filas.push({
      serie: a.serie, numero: a.numero,
      receptor_doc: r[1] || '', receptor_nombre: arreglarTexto((r[2] || '').trim()).slice(0, 250),
      moneda: r[3] === 'S/' ? 'PEN' : 'USD', importe: Number(r[4].replace(/,/g, '')),
      emision: `${r[7]}-${r[6]}-${r[5]}`,
      rechazo: rech ? `${rech[3]}-${rech[2]}-${rech[1]}` : null,
      anulado: /\b(S[IÍ]|ANULADO|X)\b/i.test(cola.replace(/\d{2}\/\d{2}\/\d{4}/g, ''))
    });
  }
  // Sin título claro: deducir por la serie (B… / EB… = boleta)
  if (!tipo && filas.length) tipo = /^(B|EB)/.test(filas[0].serie) ? 'boleta' : 'factura';
  const periodo = desde ? desde.slice(0, 7) : (filas[0] ? filas[0].emision.slice(0, 7) : null);
  return { tipo, desde, hasta, periodo, filas };
}

// Cruza las filas de SUNAT con los comprobantes del ERP. Puro.
// erp: [{ serie, number, type, amount, code, status, deleted_at }]
function cruzarCPE(filas, erp) {
  const mapa = new Map();
  erp.forEach(v => {
    const k = String(v.serie || '').trim().toUpperCase() + '|' + parseInt(String(v.number).replace(/\D/g, ''), 10);
    const prev = mapa.get(k);
    if (!prev || (prev.deleted_at && !v.deleted_at)) mapa.set(k, v);
  });
  return filas.map(f => {
    const v = mapa.get(f.serie.toUpperCase() + '|' + Number(f.numero));
    const enSistema = !!(v && !v.deleted_at);
    let estado = f.anulado ? 'anulado' : enSistema ? 'en_sistema' : f.marcado_en ? 'anotado' : 'pendiente';
    const out = { ...f, estado, erp_venta: v ? v.code : null, erp_importe: v && v.amount != null ? Number(v.amount) : null,
      erp_eliminada: !!(v && v.deleted_at), erp_cancelada: !!(v && v.status === 'cancelled') };
    out.dif_importe = enSistema && f.moneda === 'PEN' && out.erp_importe != null && Math.abs(out.erp_importe - f.importe) >= 0.01;
    return out;
  });
}

// Estado de cada mes: completo cuando se subieron los dos listados (facturas y
// boletas) y ningún comprobante queda pendiente (todos en el sistema, anotados o
// anulados). Puro. cargas: [{ periodo, tipo, n, subido_en }]
function estadoMeses(cruzadas, cargas) {
  const m = new Map();
  const mes = p => {
    if (!m.has(p)) m.set(p, { periodo: p, factura: null, boleta: null, total: 0, pendientes: 0, anotados: 0, en_sistema: 0, anulados: 0, monto_pendiente: 0 });
    return m.get(p);
  };
  cargas.forEach(c => { if (c.periodo) mes(c.periodo)[c.tipo] = { n: Number(c.n) || 0, subido_en: c.subido_en || null }; });
  cruzadas.forEach(x => {
    const o = mes(x.periodo);
    if (!o[x.tipo]) o[x.tipo] = { n: 0, subido_en: x.subido_en || null };
    o.total++;
    if (x.estado === 'pendiente') { o.pendientes++; if (x.moneda === 'PEN') o.monto_pendiente = r2(o.monto_pendiente + x.importe); }
    else if (x.estado === 'anotado') o.anotados++;
    else if (x.estado === 'en_sistema') o.en_sistema++;
    else if (x.estado === 'anulado') o.anulados++;
  });
  return [...m.values()].map(o => {
    const falta_subir = ['factura', 'boleta'].filter(t => !o[t]);
    return { ...o, falta_subir, completo: !falta_subir.length && o.pendientes === 0 };
  }).sort((a, b) => (a.periodo < b.periodo ? 1 : -1));
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = function registrarContabilidad({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mRep = requiereModulo('reportes');

  async function enBloques(sql, ids, extra = []) {
    const out = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const [rows] = await prodPool.query(sql, [ids.slice(i, i + 1000), ...extra]);
      out.push(...rows);
    }
    return out;
  }

  // ════════════════════════════ KARDEX ════════════════════════════

  async function obtenerKardex(q) {
    const f = leerFiltrosKardex(q);
    const vacio = { filtros: f, resumen: [], filas: [], totales: null, avisos: [] };

    // 1) Variaciones candidatas
    let vids = null;
    if (f.texto) {
      const like = '%' + f.texto + '%';
      const [rows] = await prodPool.query(`
        SELECT pv.id FROM product_variations pv JOIN products p ON p.id = pv.product_id
        WHERE p.name LIKE ? OR pv.name LIKE ? OR pv.sku LIKE ? LIMIT 5000`, [like, like, like]);
      vids = rows.map(r => r.id);
      if (!vids.length) return vacio;
    }
    if (f.ubicacion) {
      const sql = `SELECT DISTINCT product_variation_id AS id FROM stock_movements
        WHERE (location_from_id = ? OR location_to_id = ?) AND movement_date < DATE_ADD(?, INTERVAL 1 DAY)`;
      const rows = [];
      const lotes = vids || [null];
      for (let i = 0; i < lotes.length; i += 1000) {
        const extra = vids ? ' AND product_variation_id IN (?)' : '';
        const params = [f.ubicacion, f.ubicacion, f.hasta]; if (vids) params.push(vids.slice(i, i + 1000));
        const [r] = await prodPool.query(sql + extra, params);
        rows.push(...r);
        if (!vids) break;
      }
      vids = rows.map(r => r.id);
      if (!vids.length) return vacio;
    }

    // 2) Historia completa hasta 'hasta' (columnas mínimas) — necesaria para el saldo
    //    inicial y para saber de qué lote sale cada unidad.
    const colsMov = `SELECT sm.id, sm.product_variation_id AS vid, sm.type, sm.quantity, sm.movement_date,
        sm.reference_type AS ref_type, sm.reference_id AS ref_id, sm.location_from_id AS \`from\`,
        sm.location_to_id AS \`to\`, sm.operation_type_code, sm.notes, sm.user_id
      FROM stock_movements sm WHERE sm.movement_date < DATE_ADD(?, INTERVAL 1 DAY)`;
    let movs = [];
    if (vids) {
      for (let i = 0; i < vids.length; i += 1000) {
        const [r] = await prodPool.query(colsMov + ' AND sm.product_variation_id IN (?)', [f.hasta, vids.slice(i, i + 1000)]);
        movs.push(...r);
      }
    } else {
      [movs] = await prodPool.query(colsMov, [f.hasta]);
    }
    if (!movs.length) return vacio;
    movs.forEach(m => { m.fecha = literalFecha(m.movement_date); });
    movs.sort((a, b) => (a.vid - b.vid) || (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0) || (a.id - b.id));

    const todosVids = [...new Set(movs.map(m => m.vid))];
    const prodInfo = {};
    (await enBloques(`SELECT pv.id, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv JOIN products p ON p.id = pv.product_id WHERE pv.id IN (?)`, todosVids))
      .forEach(r => prodInfo[r.id] = r);
    movs.forEach(m => { m.sku = (prodInfo[m.vid] || {}).sku || ''; });

    // 3) Costo real de cada entrada (el lote que creó) — una sola consulta, no una por fila
    const entryIds = [...new Set(movs.filter(m => m.ref_type === REF_ENTRADA && m.ref_id).map(m => m.ref_id))];
    const costoLote = {};
    if (entryIds.length) {
      (await enBloques(`SELECT stock_entry_id, product_variation_id, cost_price FROM stock_batches
          WHERE stock_entry_id IN (?) ORDER BY id ASC`, entryIds))
        .forEach(r => { const k = r.stock_entry_id + '_' + r.product_variation_id; if (!(k in costoLote)) costoLote[k] = r.cost_price == null ? null : Number(r.cost_price); });
    }

    // 4) Simular
    const porVar = simularKardex(movs, {
      desde: f.desde, ubicacion: f.ubicacion,
      costoEntrada: m => { const k = m.ref_id + '_' + m.vid; return k in costoLote ? costoLote[k] : null; }
    });

    // 5) Enriquecer las filas del periodo
    let filas = [];
    porVar.forEach(v => filas.push(...v.filas));
    const movPorId = new Map(movs.map(m => [m.id, m]));
    const idsDe = (ref) => [...new Set(filas.filter(x => x.ref_type === ref && x.ref_id).map(x => x.ref_id))];
    const codEnt = {}, codTr = {}, ventaInfo = {}, ventaDoc = {}, ventaCod = {}, locNom = {}, usrNom = {};
    const entIds = idsDe(REF_ENTRADA), trIds = idsDe(REF_TRANSF), saleIds = idsDe(REF_VENTA);
    const userIds = [...new Set(filas.map(x => movPorId.get(x.id).user_id).filter(Boolean))];
    await Promise.all([
      entIds.length && enBloques(`SELECT id, operation_type_code FROM stock_entries WHERE id IN (?)`, entIds).then(r => r.forEach(x => codEnt[x.id] = x.operation_type_code)),
      trIds.length && enBloques(`SELECT id, operation_type_code FROM stock_transfers WHERE id IN (?)`, trIds).then(r => r.forEach(x => codTr[x.id] = x.operation_type_code)),
      saleIds.length && enBloques(`
        SELECT si.sale_id, si.product_variation_id, SUM(si.quantity) AS qty, SUM(si.total) AS ingreso,
          SUM(CASE WHEN si.stock_batch_id IS NOT NULL THEN si.quantity * sb.cost_price ELSE 0 END) AS costo_total,
          SUM(CASE WHEN si.stock_batch_id IS NOT NULL THEN si.quantity ELSE 0 END) AS qty_con_lote,
          MAX(CASE WHEN si.stock_batch_id IS NULL AND (si.is_backorder = 1 OR si.pending_stock_entry_id IS NOT NULL) THEN 1 ELSE 0 END) AS a_pedido
        FROM sale_items si LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE si.sale_id IN (?) GROUP BY si.sale_id, si.product_variation_id`, saleIds)
        .then(r => r.forEach(x => ventaInfo[x.sale_id + '_' + x.product_variation_id] = {
          precio: Number(x.qty) > 0 ? Number(x.ingreso) / Number(x.qty) : null,
          costo: Number(x.qty_con_lote) > 0 ? Number(x.costo_total) / Number(x.qty_con_lote) : null,
          a_pedido: !!Number(x.a_pedido)
        })),
      saleIds.length && enBloques(`SELECT sale_id, type, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, saleIds)
        .then(r => r.forEach(x => (ventaDoc[x.sale_id] = ventaDoc[x.sale_id] || []).push(x))),
      saleIds.length && enBloques(`SELECT id, code FROM sales WHERE id IN (?)`, saleIds).then(r => r.forEach(x => ventaCod[x.id] = x.code)),
      prodPool.query(`SELECT id, name FROM locations`).then(([r]) => r.forEach(x => locNom[x.id] = x.name)),
      userIds.length && enBloques(`SELECT id, name FROM users WHERE id IN (?)`, userIds).then(r => r.forEach(x => usrNom[x.id] = x.name))
    ]);

    filas.forEach(x => {
      const m = movPorId.get(x.id);
      let codigo = null;
      if (m.type === 'sale') codigo = '01';
      else if (m.type === 'adjustment') codigo = m.operation_type_code;
      else if (m.ref_type === REF_ENTRADA) codigo = codEnt[m.ref_id];
      else if (m.ref_type === REF_TRANSF) codigo = codTr[m.ref_id];
      if (!codigo && m.operation_type_code) codigo = m.operation_type_code;
      const pi = prodInfo[x.vid] || {};
      x.producto = nombreProdVar(pi.producto, pi.variacion);
      x.sku = pi.sku || '';
      x.tipo = TIPO_MOV_NOM[m.type] || m.type;
      x.codigo = codigo || '';
      x.operacion = codigo ? (CODIGOS_SUNAT[codigo] || '') : '';
      x.ubicacion = x.dir === 'transfer' || (x.from && x.to)
        ? `${locNom[x.from] || '—'} → ${locNom[x.to] || '—'}` : (locNom[x.loc] || '');
      x.usuario = usrNom[m.user_id] || '';
      x.nota = m.notes || '';
      // Documento: para ventas, el comprobante (serie-número); si no tiene, el código de venta
      if (m.ref_type === REF_VENTA) {
        const docs = ventaDoc[m.ref_id] || [];
        x.documento = docs.length
          ? docs.map(d => `${d.type === 'factura' ? 'Factura' : d.type === 'boleta' ? 'Boleta' : d.type} ${d.serie}-${d.number}`).join(' · ')
          : `Venta ${ventaCod[m.ref_id] || '#' + m.ref_id} (sin comprobante)`;
        const vi = ventaInfo[m.ref_id + '_' + x.vid];
        if (vi) {
          x.precio_unit = vi.precio != null ? r2(vi.precio) : null;
          x.costo_erp = vi.costo != null ? r4(vi.costo) : null;
          x.margen_unit = vi.precio != null && vi.costo != null ? r2(vi.precio - vi.costo) : null;
          if (vi.a_pedido && vi.costo == null && !x.alerta) { x.alerta = 'Venta a pedido (sin lote)'; x.alerta_nivel = 'info'; }
        }
      } else if (m.ref_type) {
        x.documento = `${m.ref_type.split('\\').pop().replace('StockEntry', 'Entrada').replace('StockTransfer', 'Transferencia')} #${m.ref_id}`;
      } else x.documento = '';
      delete x.ref_type; delete x.ref_id; delete x.from; delete x.to; delete x.loc;
    });
    filas.sort((a, b) => (a.producto < b.producto ? -1 : a.producto > b.producto ? 1 : 0) || (a.vid - b.vid)
      || (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0) || (a.id - b.id));

    // 6) Resumen por producto (incluye productos con saldo aunque no se movieran en el periodo)
    const resumen = [];
    porVar.forEach(v => {
      if (!v.n_mov && Math.abs(v.ini_q) < 1e-9 && Math.abs(v.fin_q) < 1e-9) return;
      const pi = prodInfo[v.vid] || {};
      const { filas: _f, ...rest } = v;
      resumen.push({ ...rest, producto: nombreProdVar(pi.producto, pi.variacion), sku: pi.sku || '' });
    });
    resumen.sort((a, b) => (a.producto < b.producto ? -1 : 1));

    // 7) Control: si el kardex llega hasta hoy, su saldo final debe igualar el stock actual
    const avisos = [];
    if (f.hasta >= hoyLima() && resumen.length) {
      const ids = resumen.map(r => r.vid);
      const stock = {};
      const sql = f.ubicacion
        ? `SELECT product_variation_id AS vid, SUM(quantity) AS q FROM location_stocks WHERE product_variation_id IN (?) AND location_id = ? GROUP BY product_variation_id`
        : `SELECT product_variation_id AS vid, SUM(quantity) AS q FROM location_stocks WHERE product_variation_id IN (?) GROUP BY product_variation_id`;
      (await enBloques(sql, ids, f.ubicacion ? [f.ubicacion] : [])).forEach(r => stock[r.vid] = Number(r.q) || 0);
      let noCuadran = 0;
      resumen.forEach(r => {
        r.stock_actual = stock[r.vid] || 0;
        r.cuadra = Math.abs(r.stock_actual - r.fin_q) < 0.001 || esPckMkp(r.sku);
        if (!r.cuadra) noCuadran++;
      });
      if (noCuadran) avisos.push(`${noCuadran} de ${resumen.length} productos no cuadran con el stock actual del ERP (columna "Stock ERP"). Puede ser un movimiento sin registrar o una ubicación mal cargada.`);
    }
    const nNeg = filas.filter(x => x.alerta_nivel === 'warn').length;
    const nSinCosto = filas.filter(x => x.alerta_nivel === 'err').length;
    if (nSinCosto) avisos.push(`${nSinCosto} movimientos sin costo: revisa el costo del lote en el ERP.`);
    if (nNeg) avisos.push(`${nNeg} salidas dejaron stock negativo (salió más de lo que había entrado): el costo de esas unidades es el último conocido.`);

    const totales = resumen.reduce((t, r) => {
      ['ini_q', 'ini_v', 'ent_q', 'ent_v', 'sal_q', 'sal_v', 'fin_q', 'fin_v'].forEach(k => t[k] += r[k]); return t;
    }, { ini_q: 0, ini_v: 0, ent_q: 0, ent_v: 0, sal_q: 0, sal_v: 0, fin_q: 0, fin_v: 0 });
    Object.keys(totales).forEach(k => totales[k] = r2(totales[k]));
    totales.productos = resumen.length;
    totales.movimientos = filas.length;

    filas = filtrarFilasKardex(filas, f);
    return { filtros: f, resumen, filas, totales, avisos };
  }

  // Opciones de filtros: ubicaciones y operaciones SUNAT
  app.get('/admin/kardex/opciones', authAdmin, mRep, async (req, res) => {
    try {
      const [locs] = await prodPool.query(`SELECT id, name, type FROM locations ORDER BY name`);
      res.json({
        ubicaciones: locs.map(l => ({ id: l.id, nombre: l.name, tipo: l.type })),
        operaciones: Object.entries(CODIGOS_SUNAT).map(([c, n]) => ({ codigo: c, nombre: n })),
        mes: rangoMesActual()
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lista para autocompletar el buscador de producto/SKU
  app.get('/admin/kardex/productos', authAdmin, mRep, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv JOIN products p ON p.id = pv.product_id
        WHERE pv.deleted_at IS NULL AND pv.sku IS NOT NULL
        ORDER BY p.name, pv.name LIMIT 5000`);
      res.json({ productos: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/kardex', authAdmin, mRep, async (req, res) => {
    try {
      const d = await obtenerKardex(req.query);
      const total = d.filas.length;
      res.json({ ...d, total, truncado: total > LIMITE_FILAS_PANTALLA, filas: d.filas.slice(0, LIMITE_FILAS_PANTALLA) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/kardex-excel', authAdmin, mRep, async (req, res) => {
    try {
      const d = await obtenerKardex(req.query);
      const f = d.filtros;
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const cab = [['Desde', fechaTxt(f.desde)], ['Hasta', fechaTxt(f.hasta)], ['Producto/SKU', f.texto],
        ['Ubicación', f.ubicacion ? (req.query.ubicacion_nombre || '#' + f.ubicacion) : 'Todas (global)'],
        ['Operación', f.operacion], ['Solo alertas', f.solo_alertas ? 'Sí' : ''], ['Método', 'FIFO por lotes']];
      const encabezado = (ws, cols, filaCab) => {
        cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        ws.views = [{ state: 'frozen', ySplit: filaCab + 1 }];
        ws.autoFilter = { from: { row: filaCab + 1, column: 1 }, to: { row: filaCab + 1, column: cols.length } };
      };

      // Hoja 1: Resumen por producto (inventario valorizado inicial / final)
      const ws1 = wb.addWorksheet('Resumen');
      const n1 = cabeceraExcel(ws1, 'Kardex valorizado — resumen por producto', cab, 13);
      const cols1 = [['Producto', 40], ['SKU', 18], ['Saldo inicial cant.', 12], ['Saldo inicial S/', 14], ['Entradas cant.', 12],
        ['Entradas S/', 14], ['Salidas cant.', 12], ['Salidas S/', 14], ['Saldo final cant.', 12], ['Saldo final S/', 14],
        ['Costo unit. final', 13], ['Stock ERP', 11], ['Alertas', 9]];
      encabezado(ws1, cols1, n1);
      d.resumen.forEach(r => ws1.addRow([r.producto, r.sku, r.ini_q, r.ini_v, r.ent_q, r.ent_v, r.sal_q, r.sal_v,
        r.fin_q, r.fin_v, r.fin_cu, r.stock_actual != null ? r.stock_actual : '', r.n_alertas || '']));
      if (d.totales) {
        const t = d.totales;
        const tr = ws1.addRow(['TOTAL', '', t.ini_q, t.ini_v, t.ent_q, t.ent_v, t.sal_q, t.sal_v, t.fin_q, t.fin_v]);
        tr.font = { bold: true };
      }
      [4, 6, 8, 10, 11].forEach(c => ws1.getColumn(c).numFmt = '#,##0.00');

      // Hoja 2: Detalle (formato 13.1: entradas / salidas / saldo), con fila de saldo inicial por producto
      const ws2 = wb.addWorksheet('Kardex');
      const n2 = cabeceraExcel(ws2, 'Kardex valorizado — detalle', cab, 21);
      const cols2 = [['Fecha', 16], ['Producto', 36], ['SKU', 16], ['Tipo', 13], ['Cód. SUNAT', 10], ['Operación', 22],
        ['Documento', 26], ['Ent. cant.', 9], ['Ent. c.u.', 11], ['Ent. total', 12], ['Sal. cant.', 9], ['Sal. c.u.', 11],
        ['Sal. total', 12], ['Saldo cant.', 10], ['Saldo c.u.', 11], ['Saldo total', 13], ['Precio venta', 11],
        ['Margen unit.', 11], ['Ubicación', 26], ['Usuario', 16], ['Alerta', 26], ['Nota', 36]];
      encabezado(ws2, cols2, n2);
      const resPorVid = new Map(d.resumen.map(r => [r.vid, r]));
      let vidPrev = null;
      d.filas.forEach(x => {
        if (x.vid !== vidPrev && !f.operacion && !f.solo_alertas) {
          const r = resPorVid.get(x.vid);
          if (r) {
            const fi = ws2.addRow([fechaTxt(f.desde), x.producto, x.sku, 'Saldo inicial', '', 'Saldo al inicio del periodo', '', '', '', '', '', '', '',
              r.ini_q, r.ini_q > 0 ? r4(r.ini_v / r.ini_q) : '', r.ini_v]);
            fi.font = { italic: true, color: { argb: 'FF555555' } };
          }
          vidPrev = x.vid;
        }
        const row = ws2.addRow([fechaTxt(x.fecha, true), x.producto, x.sku, x.tipo, x.codigo, x.operacion, x.documento,
          x.ent_q ?? '', x.ent_cu ?? '', x.ent_v ?? '', x.sal_q ?? '', x.sal_cu ?? '', x.sal_v ?? '',
          x.saldo_q, x.saldo_cu ?? '', x.saldo_v, x.precio_unit ?? '', x.margen_unit ?? '', x.ubicacion, x.usuario,
          x.alerta || (x.transf_q != null ? `Movimiento interno (${x.transf_q} und, no cambia el saldo)` : ''), x.nota]);
        if (x.alerta_nivel === 'err' || x.alerta_nivel === 'warn') row.getCell(21).font = { color: { argb: 'FFCC0000' }, bold: true };
      });
      [9, 10, 12, 13, 15, 16, 17, 18].forEach(c => ws2.getColumn(c).numFmt = '#,##0.00');

      const nombre = nombreTrazable('kardex');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el kardex: ' + e.message }); }
  });

  // ════════════════════════════ REPORTE DE PAGOS ════════════════════════════

  app.get('/admin/reporte-pagos/filtros', authAdmin, mRep, async (req, res) => {
    try {
      const [metodos] = await prodPool.query(
        `SELECT DISTINCT ci.id, ci.name FROM catalog_items ci
         JOIN sale_payments sp ON sp.payment_method_id = ci.id
         WHERE sp.voided_at IS NULL ORDER BY ci.name`);
      const [cuentas] = await prodPool.query(
        `SELECT ba.id, ba.account_number, banco.name AS banco, ba.party_id, dueno.business_name AS dueno
         FROM bank_accounts ba
         LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
         LEFT JOIN parties dueno ON dueno.id = ba.party_id
         ORDER BY dueno.business_name, banco.name, ba.account_number`);
      const duenos = new Map();
      cuentas.forEach(c => { if (c.party_id && !duenos.has(c.party_id)) duenos.set(c.party_id, c.dueno || `Titular ${c.party_id}`); });
      res.json({
        metodos,
        cuentas: cuentas.map(c => ({ id: c.id, etiqueta: `${c.banco || 'Banco'} ${c.account_number}`, dueno: c.dueno || '' })),
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id, nombre })),
        duenos_cuenta: [...duenos].map(([id, nombre]) => ({ id, nombre })),
        mes: rangoMesActual()
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function obtenerPagos(q) {
    const { desde, hasta, empresa, cuenta, metodo, empresa_cuenta, cuadre, estado_venta } = q;
    const w = ['sp.voided_at IS NULL', 's.deleted_at IS NULL'];
    const p = [];
    // Rango por fecha de pago. Sin DATE() sobre la columna para que use el índice.
    if (esFecha(desde)) { w.push('sp.paid_at >= ?'); p.push(desde); }
    if (esFecha(hasta)) { w.push('sp.paid_at < DATE_ADD(?, INTERVAL 1 DAY)'); p.push(hasta); }
    if (empresa) { w.push('s.company_id = ?'); p.push(empresa); }
    if (cuenta) { w.push('sp.bank_account_id = ?'); p.push(cuenta); }
    if (metodo) { w.push('sp.payment_method_id = ?'); p.push(metodo); }
    if (empresa_cuenta === 'sin') w.push('ba.party_id IS NULL');
    else if (empresa_cuenta) { w.push('ba.party_id = ?'); p.push(empresa_cuenta); }
    if (estado_venta === 'validas') w.push(`s.status <> 'cancelled'`);
    else if (estado_venta === 'canceladas') w.push(`s.status = 'cancelled'`);
    // Cierre de caja como subconsulta: con un JOIN, si hay más de un cierre el mismo día
    // el pago salía duplicado y el total se inflaba.
    const cierreSql = `(SELECT MAX(cc.status = 'closed') FROM cash_closures cc WHERE cc.closure_date = DATE(sp.paid_at))`;
    if (cuadre === 'cerrado') w.push(`${cierreSql} = 1`);
    else if (cuadre === 'abierto') w.push(`COALESCE(${cierreSql}, 0) = 0`);

    const [pagos] = await prodPool.query(`
      SELECT sp.id, sp.paid_at, sp.amount, sp.notes AS nota_pago,
        s.id AS sale_id, s.code AS venta_codigo, s.company_id, s.observations AS obs_venta, s.status AS estado_venta,
        CASE WHEN cli.is_company=1 THEN cli.business_name
             ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente_nombre,
        cli.document_number AS cliente_doc,
        mp.name AS metodo, ba.account_number, banco.name AS banco,
        dueno.business_name AS empresa_cuenta, s.total AS venta_total,
        ${cierreSql} AS cerrado
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      LEFT JOIN parties cli ON cli.id = s.customer_id
      LEFT JOIN catalog_items mp ON mp.id = sp.payment_method_id
      LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
      LEFT JOIN parties dueno ON dueno.id = ba.party_id
      WHERE ${w.join(' AND ')}
      ORDER BY sp.paid_at ASC, sp.id ASC`, p);
    if (!pagos.length) return [];

    const saleIds = [...new Set(pagos.map(x => x.sale_id))];
    const empProdPorVenta = {}, vouchPorVenta = {}, tipoCompPorVenta = {}, pagadoTotal = {}, pagosFuera = {};
    const tareas = [
      enBloques(`SELECT DISTINCT si.sale_id, sb.company_id FROM sale_items si
          JOIN stock_batches sb ON sb.id = si.stock_batch_id WHERE si.sale_id IN (?)`, saleIds)
        .then(r => r.forEach(x => (empProdPorVenta[x.sale_id] = empProdPorVenta[x.sale_id] || new Set()).add(x.company_id))),
      enBloques(`SELECT sale_id, type, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, saleIds)
        .then(r => r.forEach(v => {
          const t = v.type === 'factura' ? 'Factura' : v.type === 'boleta' ? 'Boleta' : v.type;
          (vouchPorVenta[v.sale_id] = vouchPorVenta[v.sale_id] || []).push(`${t} ${v.serie}-${v.number}`);
          const prev = tipoCompPorVenta[v.sale_id];
          tipoCompPorVenta[v.sale_id] = !prev ? v.type : (prev !== v.type ? 'mixto' : prev);
        })),
      // Todo lo pagado de cada venta (sin filtro de fecha) → saldo real por cobrar
      enBloques(`SELECT sale_id, COALESCE(SUM(amount),0) AS pagado FROM sale_payments
          WHERE voided_at IS NULL AND sale_id IN (?) GROUP BY sale_id`, saleIds)
        .then(r => r.forEach(x => pagadoTotal[x.sale_id] = Number(x.pagado)))
    ];
    if (esFecha(desde) || esFecha(hasta)) {
      const fueraSql = [esFecha(desde) ? 'paid_at < ?' : null, esFecha(hasta) ? 'paid_at >= DATE_ADD(?, INTERVAL 1 DAY)' : null].filter(Boolean).join(' OR ');
      const extra = [esFecha(desde) ? desde : null, esFecha(hasta) ? hasta : null].filter(Boolean);
      tareas.push(enBloques(`SELECT sale_id, COUNT(*) AS n, COALESCE(SUM(amount),0) AS monto FROM sale_payments
          WHERE voided_at IS NULL AND sale_id IN (?) AND (${fueraSql}) GROUP BY sale_id`, saleIds, extra)
        .then(r => r.forEach(x => pagosFuera[x.sale_id] = { n: Number(x.n), monto: Number(x.monto) })));
    }
    await Promise.all(tareas);

    let lista = pagos.map(pg => {
      const empSet = empProdPorVenta[pg.sale_id];
      const fuera = pagosFuera[pg.sale_id];
      const doc = pg.cliente_doc ? String(pg.cliente_doc) : '';
      const total = Number(pg.venta_total || 0), pagado = pagadoTotal[pg.sale_id] || 0;
      const saldo = r2(total - pagado);
      return {
        fecha: literalFecha(pg.paid_at),
        paid_at: literalFecha(pg.paid_at),          // compatibilidad
        cliente: pg.cliente_nombre && pg.cliente_nombre.trim() ? pg.cliente_nombre.trim() : '—',
        cliente_doc: doc || '—',
        // El ERP no guarda el tipo de documento: se deduce por el largo (11 = RUC, 8 = DNI)
        cliente_doc_tipo: !doc ? '—' : doc.length === 11 ? 'RUC' : doc.length === 8 ? 'DNI' : 'Otro',
        metodo: pg.metodo || 'Sin método',
        cuenta: pg.banco ? `${pg.banco} ${pg.account_number || ''}`.trim() : '—',
        empresa_cuenta: pg.empresa_cuenta || '—',
        venta: pg.venta_codigo,
        estado_venta: pg.estado_venta,
        estado_venta_txt: ESTADO_VENTA[pg.estado_venta] || pg.estado_venta || '',
        empresa_gestiona: pg.company_id != null ? (EMPRESAS_BI[pg.company_id] || `Empresa ${pg.company_id}`) : '(vacío)',
        empresa_producto: empSet ? [...empSet].map(id => EMPRESAS_BI[id] || `Empresa ${id}`).join(', ') : '—',
        comprobante: (vouchPorVenta[pg.sale_id] || []).join(' · ') || '—',
        tipo_comprobante: tipoCompPorVenta[pg.sale_id] || null,
        nota_pago: pg.nota_pago || '', obs_venta: pg.obs_venta || '',
        cuadre: Number(pg.cerrado) === 1 ? 'Cerrado' : 'Sin cerrar',
        monto: Number(pg.amount),
        venta_total: total, venta_pagado: r2(pagado),
        venta_saldo: saldo > 0.009 ? saldo : 0,
        venta_sobrepago: saldo < -0.009 ? -saldo : 0,
        _sale_id: pg.sale_id,
        _pagos_fuera: fuera ? fuera.n : 0,
        _monto_fuera: fuera ? r2(fuera.monto) : 0,
        _empresas_prod_ids: empSet ? [...empSet].map(Number) : []
      };
    });
    lista = filtrarPagos(lista, q);
    lista.forEach(x => delete x._empresas_prod_ids);
    return ordenarYAgrupar(lista);
  }

  app.get('/admin/reporte-pagos', authAdmin, mRep, async (req, res) => {
    try {
      const lista = await obtenerPagos(req.query);
      const resumen = resumenPagos(lista);
      res.json({ total: lista.length, suma: resumen.suma, resumen, pagos: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/reporte-pagos-excel', authAdmin, mRep, async (req, res) => {
    try {
      const q = req.query;
      const lista = await obtenerPagos(q);
      const resumen = resumenPagos(lista);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Pagos');

      const empresaGestionaTxt = q.empresa ? (EMPRESAS_BI[q.empresa] || `Empresa ${q.empresa}`)
        : ([...new Set(lista.map(x => x.empresa_gestiona))].join(', ') || 'Todas');
      const TXT = {
        tipo_comprobante: { factura: 'Solo facturas', boleta: 'Solo boletas', sin: 'Sin comprobante' },
        cuadre: { cerrado: 'Día cerrado', abierto: 'Día sin cerrar' },
        estado_venta: { validas: 'Sin canceladas', canceladas: 'Solo canceladas' },
        saldo: { con_saldo: 'Con saldo por cobrar', pagada: 'Pagadas' }
      };
      const cols = [['Fecha', 17], ['Cliente', 32], ['Tipo doc.', 9], ['DNI/RUC', 14], ['Método', 18], ['Cuenta destino', 26],
        ['Empresa dueña de la cuenta', 28], ['Venta', 14], ['Estado venta', 13], ['Empresa que gestiona', 26],
        ['Empresa(s) del producto', 26], ['Comprobante', 28], ['Nota del pago', 32], ['Observación de venta', 32],
        ['Cierre de caja', 13], ['Monto del pago', 14], ['Valor de la venta', 15], ['Cobrado en el rango', 16],
        ['Saldo por cobrar', 15], ['Pagos fuera del rango', 22]];
      const nCab = cabeceraExcel(ws, 'Reporte de pagos', [
        ['Empresa que gestiona', empresaGestionaTxt],
        ['Desde', fechaTxt(q.desde)], ['Hasta', fechaTxt(q.hasta)],
        ['Empresa dueña de la cuenta', q.empresa_cuenta_nombre || (q.empresa_cuenta ? 'filtrada' : '')],
        ['Cuenta', q.cuenta_nombre || (q.cuenta ? 'filtrada' : '')], ['Método', q.metodo_nombre || (q.metodo ? 'filtrado' : '')],
        ['Comprobante', (TXT.tipo_comprobante[q.tipo_comprobante] || '')], ['Cierre', TXT.cuadre[q.cuadre] || ''],
        ['Ventas', TXT.estado_venta[q.estado_venta] || ''], ['Saldo', TXT.saldo[q.saldo] || ''], ['Búsqueda', q.q || ''],
        ['Pagos', lista.length],
        ['IMPORTANTE', 'Todos los pagos listados son dinero YA RECIBIDO. "Cierre de caja" indica si el cierre administrativo del día se realizó, NO si el pago está pendiente.']
      ], cols.length);
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      lista.forEach(x => {
        const row = ws.addRow([fechaTxt(x.fecha, true), x.cliente, x.cliente_doc_tipo, x.cliente_doc, x.metodo, x.cuenta,
          x.empresa_cuenta, x.venta, x.estado_venta_txt, x.empresa_gestiona, x.empresa_producto, x.comprobante,
          x.nota_pago, x.obs_venta, x.cuadre, x.monto, x.venta_total, x._total_venta, x.venta_saldo,
          x._pagos_fuera > 0 ? `${x._pagos_fuera} pago(s): S/ ${x._monto_fuera.toFixed(2)}` : '']);
        if (x.estado_venta === 'cancelled') row.getCell(9).font = { color: { argb: 'FFCC0000' }, bold: true };
      });
      ws.views = [{ state: 'frozen', ySplit: nCab + 1 }];
      ws.autoFilter = { from: { row: nCab + 1, column: 1 }, to: { row: nCab + 1, column: cols.length } };
      [16, 17, 18, 19].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

      ws.addRow([]);
      const bloque = (titulo, arr) => {
        ws.addRow([titulo]).font = { bold: true };
        arr.forEach(({ k, v }) => { const r = ws.addRow(['', k]); r.getCell(16).value = v; r.getCell(16).numFmt = '#,##0.00'; });
      };
      bloque('TOTALES POR EMPRESA DUEÑA DE LA CUENTA', resumen.por_empresa_cuenta);
      bloque('TOTALES POR CUENTA', resumen.por_cuenta);
      bloque('TOTALES POR MÉTODO', resumen.por_metodo);
      const g = ws.addRow(['TOTAL GENERAL']); g.font = { bold: true };
      g.getCell(16).value = resumen.suma; g.getCell(16).numFmt = '#,##0.00';

      // ── Hojas por comprobante (por fecha de EMISIÓN, con todos los pagos de la venta) ──
      const armarHojaComprobante = async (tipoComp) => {
        const etiqueta = tipoComp === 'factura' ? 'Facturas' : 'Boletas';
        const ws2 = wb.addWorksheet('Por ' + etiqueta.toLowerCase());
        const cond = ['sv.type = ?', 's.deleted_at IS NULL']; const params = [tipoComp];
        if (esFecha(q.desde)) { cond.push('sv.emission_date >= ?'); params.push(q.desde); }
        if (esFecha(q.hasta)) { cond.push('sv.emission_date < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(q.hasta); }
        if (q.empresa) { cond.push('s.company_id = ?'); params.push(q.empresa); }
        const [comps] = await prodPool.query(`
          SELECT sv.sale_id, sv.serie, sv.number, sv.emission_date, sv.amount, s.code AS venta, s.status,
            CASE WHEN cli.is_company=1 THEN cli.business_name
                 ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente,
            cli.document_number AS cliente_doc
          FROM sale_vouchers sv JOIN sales s ON s.id = sv.sale_id
          LEFT JOIN parties cli ON cli.id = s.customer_id
          WHERE ${cond.join(' AND ')} ORDER BY sv.emission_date, sv.serie, sv.number`, params);

        const sids = [...new Set(comps.map(c => c.sale_id))];
        const pagosPorVenta = {};
        if (sids.length) {
          (await enBloques(`
            SELECT sp.sale_id, sp.amount, sp.paid_at, ci.name AS metodo, banco.name AS banco_nombre, ba.account_number
            FROM sale_payments sp
            LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
            LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
            LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
            WHERE sp.sale_id IN (?) AND sp.voided_at IS NULL ORDER BY sp.paid_at`, sids))
            .forEach(pg => (pagosPorVenta[pg.sale_id] = pagosPorVenta[pg.sale_id] || []).push({
              fecha: literalFecha(pg.paid_at), monto: Number(pg.amount), metodo: pg.metodo || '—',
              banco: pg.account_number ? `${pg.banco_nombre || ''} ${pg.account_number}`.trim() : '—'
            }));
        }
        const porVenta = {};
        comps.forEach(c => {
          const g = porVenta[c.sale_id] = porVenta[c.sale_id] || {
            venta: c.venta, estado: c.status, cliente: (c.cliente || '').trim() || '—', cliente_doc: c.cliente_doc || '—', comprobantes: new Map()
          };
          const k = `${c.serie}-${c.number}`;
          if (!g.comprobantes.has(k)) g.comprobantes.set(k, { importe: Number(c.amount || 0), fecha: literalFecha(c.emission_date, false) });
        });
        const grupos = Object.entries(porVenta).map(([sid, g]) => {
          const vals = [...g.comprobantes.values()];
          return { ...g, codigos: [...g.comprobantes.keys()], importe: vals.reduce((s, c) => s + c.importe, 0),
            fecha: vals.map(c => c.fecha).filter(Boolean).sort()[0] || '', pagos: pagosPorVenta[sid] || [] };
        }).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));

        ws2.mergeCells('A1:H1');
        ws2.getCell('A1').value = `${etiqueta} emitidas del ${fechaTxt(q.desde)} al ${fechaTxt(q.hasta)} (por fecha de emisión) y todos sus pagos`;
        ws2.getCell('A1').font = { bold: true, size: 13 };
        ws2.addRow([]);
        const h = ws2.addRow(['Comprobante(s)', 'Venta', 'Fecha emisión', 'Cliente / Método', 'RUC/DNI / Banco', 'Importe comprobante', 'Total pagado', 'Estado']);
        h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        if (!grupos.length) ws2.addRow([`(No se emitieron ${etiqueta.toLowerCase()} en este rango de fechas)`]);
        grupos.forEach(gr => {
          const pagado = gr.pagos.reduce((s, x) => s + x.monto, 0);
          const dif = r2(gr.importe - pagado);
          let estado = Math.abs(dif) < 0.01 ? 'Cuadra' : dif > 0 ? 'Falta cobrar S/ ' + dif.toFixed(2) : 'Pagado de más S/ ' + Math.abs(dif).toFixed(2);
          if (gr.estado === 'cancelled') estado = 'VENTA CANCELADA · ' + estado;
          const fila = ws2.addRow([gr.codigos.join(' + '), gr.venta, fechaTxt(gr.fecha), gr.cliente, gr.cliente_doc, r2(gr.importe), r2(pagado), estado]);
          fila.font = { bold: true };
          if (Math.abs(dif) >= 0.01 || gr.estado === 'cancelled') fila.getCell(8).font = { color: { argb: 'FFCC0000' }, bold: true };
          if (!gr.pagos.length) ws2.addRow(['', '', '   (sin pagos registrados)']).font = { color: { argb: 'FF999999' }, size: 10, italic: true };
          gr.pagos.forEach(pg => {
            ws2.addRow(['', '', '   ↳ ' + fechaTxt(pg.fecha), pg.metodo, pg.banco, '', pg.monto, '']).font = { color: { argb: 'FF666666' }, size: 10 };
          });
        });
        [6, 7].forEach(c => ws2.getColumn(c).numFmt = '#,##0.00');
        [24, 16, 22, 30, 26, 18, 15, 26].forEach((wd, i) => ws2.getColumn(i + 1).width = wd);
        ws2.views = [{ state: 'frozen', ySplit: h.number }];
      };
      const tc = q.tipo_comprobante;
      if (tc === 'factura') await armarHojaComprobante('factura');
      else if (tc === 'boleta') await armarHojaComprobante('boleta');
      else if (tc !== 'sin') { await armarHojaComprobante('factura'); await armarHojaComprobante('boleta'); }

      const nombre = nombreTrazable('pagos');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
  });

  // ════════════════════ COMPROBANTES SUNAT vs SISTEMA ════════════════════
  // Cada mes se suben los listados de SUNAT (facturas y boletas emitidas). Se guardan
  // en la base del portal y, cada vez que se abre la pantalla, se cruzan con los
  // comprobantes del ERP: lo que ya se registró en el sistema sale solo de la lista
  // de pendientes. Lo que se registró de otra forma se puede marcar "anotado" a mano.
  async function asegurarTablaCPE() {
    if (!portalPool) throw new Error('Falta la conexión a la base del portal');
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cont_cpe_sunat (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tipo VARCHAR(10) NOT NULL,
        serie VARCHAR(8) NOT NULL,
        numero INT NOT NULL,
        emision DATE,
        periodo CHAR(7),
        receptor_doc VARCHAR(20),
        receptor_nombre VARCHAR(255),
        moneda CHAR(3) DEFAULT 'PEN',
        importe DECIMAL(12,2),
        anulado TINYINT DEFAULT 0,
        rechazo DATE NULL,
        archivo VARCHAR(255),
        subido_por VARCHAR(100),
        subido_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        marcado_por VARCHAR(100) NULL,
        marcado_en DATETIME NULL,
        nota VARCHAR(255) NULL,
        UNIQUE KEY uq_cpe (tipo, serie, numero),
        INDEX idx_periodo (periodo)
      )`);
    // Qué listados se subieron (aunque vengan vacíos: un mes sin boletas también cuenta)
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cont_cpe_cargas (
        periodo CHAR(7) NOT NULL,
        tipo VARCHAR(10) NOT NULL,
        n INT DEFAULT 0,
        archivo VARCHAR(255),
        subido_por VARCHAR(100),
        subido_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (periodo, tipo)
      )`);
    // Meses completados: se registra la primera vez que el mes queda completo
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cont_cpe_meses (
        periodo CHAR(7) PRIMARY KEY,
        completado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        completado_por VARCHAR(100)
      )`);
  }
  let tablaCPE = null;
  const tablaListaCPE = () => (tablaCPE = tablaCPE || asegurarTablaCPE().catch(e => { tablaCPE = null; throw e; }));
  const quien = req => (req.admin && req.admin.usuario) || 'admin';
  const claveCPE = (serie, numero) => String(serie || '').trim().toUpperCase() + '|' + parseInt(String(numero).replace(/\D/g, ''), 10);

  // Subir un listado: el navegador extrae el texto del PDF (pdf.js) y lo manda aquí
  app.post('/admin/cpe-sunat/importar', authAdmin, mRep, async (req, res) => {
    try {
      await tablaListaCPE();
      const archivo = String(req.body.archivo || '').slice(0, 250);
      const r = parsearListadoCPE(req.body.texto);
      if (r.tipo === 'nota') return res.status(400).json({ error: `"${archivo}" es un listado de notas de crédito/débito; solo se cargan facturas y boletas.` });
      const esListado = /Emitid[oa]s\s+del\s+Periodo|Listado\s+de\s+CPE/i.test(String(req.body.texto || ''));
      if (!r.filas.length && !(esListado && r.periodo && (r.tipo === 'factura' || r.tipo === 'boleta')))
        return res.status(400).json({ error: `No se encontraron comprobantes en "${archivo}". ¿Es el "Listado de CPE" de SUNAT impreso en PDF?` });
      let nuevos = 0, actualizados = 0;
      for (const f of r.filas) {
        const [x] = await portalPool.query(`
          INSERT INTO cont_cpe_sunat (tipo, serie, numero, emision, periodo, receptor_doc, receptor_nombre, moneda, importe, anulado, rechazo, archivo, subido_por)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE emision=VALUES(emision), periodo=VALUES(periodo), receptor_doc=VALUES(receptor_doc),
            receptor_nombre=VALUES(receptor_nombre), moneda=VALUES(moneda), importe=VALUES(importe), anulado=VALUES(anulado),
            rechazo=VALUES(rechazo), archivo=VALUES(archivo), subido_por=VALUES(subido_por), subido_en=CURRENT_TIMESTAMP`,
          [r.tipo, f.serie, f.numero, f.emision, f.emision.slice(0, 7), f.receptor_doc, f.receptor_nombre, f.moneda, f.importe,
           f.anulado ? 1 : 0, f.rechazo, archivo, quien(req)]);
        if (x.affectedRows === 1) nuevos++; else actualizados++;
      }
      await portalPool.query(`
        INSERT INTO cont_cpe_cargas (periodo, tipo, n, archivo, subido_por) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE n=VALUES(n), archivo=VALUES(archivo), subido_por=VALUES(subido_por), subido_en=CURRENT_TIMESTAMP`,
        [r.periodo, r.tipo, r.filas.length, archivo, quien(req)]);
      res.json({ ok: true, archivo, tipo: r.tipo, periodo: r.periodo, desde: r.desde, hasta: r.hasta,
        total: r.filas.length, nuevos, actualizados, anulados: r.filas.filter(f => f.anulado).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Lista cruzada con el ERP (se recalcula en cada consulta: lo que ya se registró se actualiza solo)
  async function obtenerCPE(req) {
      await tablaListaCPE();
      const [cargasRows] = await portalPool.query(`SELECT periodo, tipo, n, archivo, subido_por, subido_en FROM cont_cpe_cargas`);
      const [rows] = await portalPool.query(`
        SELECT id, tipo, serie, numero, emision, periodo, receptor_doc, receptor_nombre, moneda, importe, anulado, rechazo,
          archivo, subido_por, subido_en, marcado_por, marcado_en, nota
        FROM cont_cpe_sunat ORDER BY tipo, serie, numero DESC`);
      const todas = rows.map(x => ({ ...x, numero: Number(x.numero), importe: Number(x.importe), anulado: !!x.anulado,
        emision: literalFecha(x.emision, false), rechazo: x.rechazo ? literalFecha(x.rechazo, false) : null,
        subido_en: literalFecha(x.subido_en), marcado_en: x.marcado_en ? literalFecha(x.marcado_en) : null }));

      // Comprobantes del ERP con esas series y números (el número puede venir con ceros a la izquierda)
      let erp = [];
      const series = [...new Set(todas.map(f => f.serie))];
      if (series.length) {
        erp = await enBloques(`
          SELECT sv.serie, sv.number, sv.type, sv.amount, s.code, s.status, s.deleted_at
          FROM sale_vouchers sv LEFT JOIN sales s ON s.id = sv.sale_id
          WHERE CAST(sv.number AS UNSIGNED) IN (?) AND sv.serie IN (?)`,
          [...new Set(todas.map(f => f.numero))], [series]);
      }
      const cruzadasTodas = cruzarCPE(todas, erp);

      // Estado de cada mes + registro de la fecha en que quedó completo
      const cargas = cargasRows.map(c => ({ ...c, subido_en: literalFecha(c.subido_en) }));
      const meses = estadoMeses(cruzadasTodas, cargas);
      const [regs] = await portalPool.query(`SELECT periodo, completado_en, completado_por FROM cont_cpe_meses`);
      const reg = new Map(regs.map(x => [x.periodo, x]));
      for (const m of meses) {
        const r0 = reg.get(m.periodo);
        if (m.completo && !r0) {
          await portalPool.query(`INSERT IGNORE INTO cont_cpe_meses (periodo, completado_por) VALUES (?, ?)`, [m.periodo, quien(req)]);
          const [[n0]] = await portalPool.query(`SELECT completado_en, completado_por FROM cont_cpe_meses WHERE periodo = ?`, [m.periodo]);
          m.completado_en = n0 ? literalFecha(n0.completado_en) : null; m.completado_por = n0 ? n0.completado_por : quien(req); m.recien_completado = true;
        } else if (!m.completo && r0) {
          // Dejó de estar completo (se subió un listado nuevo o se quitó una marca)
          await portalPool.query(`DELETE FROM cont_cpe_meses WHERE periodo = ?`, [m.periodo]);
        } else if (r0) { m.completado_en = literalFecha(r0.completado_en); m.completado_por = r0.completado_por; }
      }

      const periodo = /^\d{4}-\d{2}$/.test(req.query.periodo || '') ? req.query.periodo
        : (req.query.periodo === 'todos' ? null : (meses[0] ? meses[0].periodo : null));
      const cruzadas = periodo ? cruzadasTodas.filter(x => x.periodo === periodo) : cruzadasTodas;
      const filas = cruzadas;
      // Lista de cargas (compatibilidad con la pantalla): una por mes y tipo
      const periodos = [];
      meses.forEach(m => ['factura', 'boleta'].forEach(t => { if (m[t]) periodos.push({ periodo: m.periodo, tipo: t, n: m[t].n, subido_en: m[t].subido_en }); }));

      // Al revés: en el ERP con emisión en el periodo, pero que no aparecen en el listado de SUNAT
      // (solo para los tipos cuyo listado se subió). Suele ser un número mal tipeado.
      let soloSistema = [];
      if (periodo) {
        const tipos = [...new Set(filas.map(f => f.tipo))];
        if (tipos.length) {
          const enSunat = new Set(filas.map(f => claveCPE(f.serie, f.numero)));
          const [vs] = await prodPool.query(`
            SELECT sv.type, sv.serie, sv.number, sv.amount, sv.emission_date, s.code, s.status
            FROM sale_vouchers sv JOIN sales s ON s.id = sv.sale_id
            WHERE s.deleted_at IS NULL AND sv.type IN (?) AND sv.emission_date >= ? AND sv.emission_date < DATE_ADD(?, INTERVAL 1 MONTH)
            ORDER BY sv.serie, sv.number`, [tipos, `${periodo}-01`, `${periodo}-01`]);
          soloSistema = vs.filter(v => !enSunat.has(claveCPE(v.serie, v.number)))
            .map(v => ({ tipo: v.type, comprobante: `${v.serie}-${v.number}`, emision: literalFecha(v.emission_date, false),
              importe: Number(v.amount || 0), venta: v.code, cancelada: v.status === 'cancelled' }));
        }
      }
      const suma = arr => r2(arr.reduce((s, x) => s + (x.moneda === 'PEN' ? x.importe : 0), 0));
      const de = e => cruzadas.filter(x => x.estado === e);
      return {
        periodo, periodos, meses,
        resumen: {
          total: cruzadas.length, monto: suma(cruzadas.filter(x => !x.anulado)),
          en_sistema: de('en_sistema').length, pendientes: de('pendiente').length, monto_pendiente: suma(de('pendiente')),
          anotados: de('anotado').length, anulados: de('anulado').length,
          dif_importe: cruzadas.filter(x => x.dif_importe).length, solo_sistema: soloSistema.length
        },
        filas: cruzadas, solo_sistema: soloSistema
      };
  }

  app.get('/admin/cpe-sunat', authAdmin, mRep, async (req, res) => {
    try { res.json(await obtenerCPE(req)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Excel real (.xlsx) con columnas separadas, filtros y colores por estado.
  // Respeta los filtros de la pantalla: periodo, tipo, estado y búsqueda.
  app.get('/admin/cpe-sunat-excel', authAdmin, mRep, async (req, res) => {
    try {
      const d = await obtenerCPE(req);
      const { tipo, estado } = req.query;
      const q = String(req.query.q || '').trim().toLowerCase();
      const lista = d.filas.filter(x => {
        if (tipo && x.tipo !== tipo) return false;
        if (estado === 'dif') { if (!x.dif_importe) return false; } else if (estado && x.estado !== estado) return false;
        if (q && !`${x.serie}-${x.numero} ${x.receptor_doc} ${x.receptor_nombre} ${x.nota || ''} ${x.erp_venta || ''}`.toLowerCase().includes(q)) return false;
        return true;
      });
      const EST = { pendiente: 'Falta en el sistema', anotado: 'Anotado a mano', en_sistema: 'En el sistema', anulado: 'Anulado en SUNAT' };
      const COLOR = { pendiente: 'FFFDE2E2', anotado: 'FFEDEBFC', en_sistema: 'FFE6F6EC', anulado: 'FFEFEFEF' };
      const TIPO = { factura: 'Factura', boleta: 'Boleta' };
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Comprobantes');
      const mesTxt = p => { if (!p) return 'Todos los meses'; const [a, m] = p.split('-').map(Number);
        return ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'][m - 1] + ' ' + a; };
      const mes = d.periodo ? d.meses.find(m => m.periodo === d.periodo) : null;
      const nCab = cabeceraExcel(ws, 'Comprobantes SUNAT vs sistema', [
        ['Periodo', mesTxt(d.periodo)], ['Tipo', TIPO[tipo] ? TIPO[tipo] + 's' : ''],
        ['Estado', estado === 'dif' ? 'Con diferencia de importe' : (EST[estado] || '')], ['Búsqueda', q],
        ['Mes', mes ? (mes.completo ? 'COMPLETO' : mes.falta_subir.length ? 'falta subir ' + mes.falta_subir.join(' y ') : `faltan ${mes.pendientes}`) : ''],
        ['Comprobantes', lista.length]
      ], 15);
      const cols = [['Tipo', 9], ['Serie', 8], ['Número', 10], ['Comprobante', 14], ['Emisión', 12], ['RUC/DNI', 14], ['Cliente', 42],
        ['Moneda', 8], ['Importe SUNAT', 14], ['Estado', 20], ['Venta en el sistema', 18], ['Importe en el sistema', 18],
        ['Anotado por', 14], ['Anotado el', 17], ['Nota', 40]];
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      hr.alignment = { vertical: 'middle', wrapText: true };
      const fecha = lit => { const m = String(lit || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
        return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : null; };
      lista.forEach(x => {
        const row = ws.addRow([TIPO[x.tipo] || x.tipo, x.serie, x.numero, `${x.serie}-${x.numero}`, fecha(x.emision), x.receptor_doc,
          x.receptor_nombre, x.moneda, x.importe, EST[x.estado] || x.estado, x.erp_venta || '', x.erp_importe == null ? null : x.erp_importe,
          x.marcado_por || '', x.marcado_en ? fecha(x.marcado_en) : null, x.nota || '']);
        row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR[x.estado] || 'FFFFFFFF' } };
        if (x.dif_importe) row.getCell(12).font = { color: { argb: 'FFB45309' }, bold: true };
      });
      ws.getColumn(5).numFmt = 'dd/mm/yyyy';
      ws.getColumn(14).numFmt = 'dd/mm/yyyy hh:mm';
      [9, 12].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      ws.getColumn(6).numFmt = '@';
      ws.views = [{ state: 'frozen', ySplit: nCab + 1 }];
      ws.autoFilter = { from: { row: nCab + 1, column: 1 }, to: { row: nCab + 1 + lista.length, column: cols.length } };

      // Hoja 2: estado de los meses
      const ws2 = wb.addWorksheet('Meses');
      const c2 = [['Mes', 18], ['Facturas', 10], ['Boletas', 10], ['En el sistema', 14], ['Anotados a mano', 16], ['Anulados', 10],
        ['Faltan', 9], ['Monto que falta (S/)', 18], ['Estado', 26], ['Completo desde', 18]];
      c2.forEach((c, i) => ws2.getColumn(i + 1).width = c[1]);
      const h2 = ws2.addRow(c2.map(c => c[0]));
      h2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      h2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      d.meses.forEach(m => {
        const est = m.completo ? '✓ Completo' : m.falta_subir.length ? 'Falta subir ' + m.falta_subir.map(t => t + 's').join(' y ') : `Faltan ${m.pendientes} por anotar`;
        const r = ws2.addRow([mesTxt(m.periodo), m.factura ? m.factura.n : '—', m.boleta ? m.boleta.n : '—', m.en_sistema, m.anotados, m.anulados,
          m.pendientes, m.monto_pendiente, est, m.completado_en ? fecha(m.completado_en) : null]);
        r.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.completo ? 'FFE6F6EC' : m.falta_subir.length ? 'FFFDF5DB' : 'FFFDE2E2' } };
      });
      ws2.getColumn(8).numFmt = '#,##0.00';
      ws2.getColumn(10).numFmt = 'dd/mm/yyyy hh:mm';
      ws2.views = [{ state: 'frozen', ySplit: 1 }];
      ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + d.meses.length, column: c2.length } };

      const nombre = nombreTrazable('comprobantes-sunat' + (d.periodo ? '-' + d.periodo : ''));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el Excel: ' + e.message }); }
  });

  // Marcar / desmarcar como anotado (uno o varios)
  app.post('/admin/cpe-sunat/marcar', authAdmin, mRep, async (req, res) => {
    try {
      await tablaListaCPE();
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(n => n > 0).slice(0, 2000);
      if (!ids.length) return res.status(400).json({ error: 'No hay comprobantes seleccionados' });
      if (req.body.marcado) await portalPool.query(`UPDATE cont_cpe_sunat SET marcado_por = ?, marcado_en = NOW() WHERE id IN (?)`, [quien(req), ids]);
      else await portalPool.query(`UPDATE cont_cpe_sunat SET marcado_por = NULL, marcado_en = NULL WHERE id IN (?)`, [ids]);
      res.json({ ok: true, n: ids.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Guardar la nota de un comprobante (p. ej. "se registró como venta V-0123")
  app.post('/admin/cpe-sunat/nota', authAdmin, mRep, async (req, res) => {
    try {
      await tablaListaCPE();
      const id = Number(req.body.id);
      if (!id) return res.status(400).json({ error: 'Falta el comprobante' });
      await portalPool.query(`UPDATE cont_cpe_sunat SET nota = ? WHERE id = ?`, [String(req.body.nota || '').trim().slice(0, 250) || null, id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Borrar una carga (si se subió el archivo equivocado). Se pierden sus marcas y notas.
  app.post('/admin/cpe-sunat/borrar', authAdmin, mRep, async (req, res) => {
    try {
      await tablaListaCPE();
      const { periodo, tipo } = req.body;
      if (!/^\d{4}-\d{2}$/.test(periodo || '') || !['factura', 'boleta'].includes(tipo)) return res.status(400).json({ error: 'Periodo o tipo inválido' });
      const [x] = await portalPool.query(`DELETE FROM cont_cpe_sunat WHERE periodo = ? AND tipo = ?`, [periodo, tipo]);
      await portalPool.query(`DELETE FROM cont_cpe_cargas WHERE periodo = ? AND tipo = ?`, [periodo, tipo]);
      res.json({ ok: true, borrados: x.affectedRows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

module.exports._test = { direccionMov, simularKardex, filtrarFilasKardex, leerFiltrosKardex, filtrarPagos, ordenarYAgrupar, resumenPagos, literalFecha, fechaTxt, CODIGOS_SUNAT, parsearListadoCPE, cruzarCPE, arreglarTexto, estadoMeses };
