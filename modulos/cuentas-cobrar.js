// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Cuentas por cobrar (clientes que deben)
//  Backend aquí; frontend propio en public/cuentas-por-cobrar.html (iframe en el panel).
//  Antes vivía dentro de modulos/clientes-bi.js.
//
//  Endpoints (permiso: cuentas_cobrar)
//    GET  /api/cxc               → resumen, antigüedad y lista de clientes con saldo
//    GET  /api/cxc-excel         → lo mismo en Excel (Clientes / Ventas)
//    POST /api/cxc-cobrar        → envía recordatorio por correo a los seleccionados
//    POST /api/cxc-recordatorio  → registra un recordatorio hecho por WhatsApp
//
//  Filtros (query, también en el body de /api/cxc-cobrar):
//    empresa     company_id (1 | 2) o vacío = todas
//    a_pedido    exigible (def.) | todos | solo
//    antiguedad  '' | 0-30 | 31-60 | 61-90 | 90+   (días desde la venta)
//    tipo        '' | empresa | persona
//    contacto    '' | correo | whatsapp | sin
//    min         saldo mínimo por cliente (S/), def. 0
//    q           texto: nombre, RUC/DNI o código de venta
//    fresco=1    ignora la caché de 60 s
//
//  Reglas
//  · Deuda de una venta = total − pagos no anulados. Solo ventas 'confirmed' y
//    'pending_payment' (las 'paid' y 'cancelled' no se cobran). Se ignoran
//    residuos menores a S/ 0.01 (redondeo).
//  · "A pedido" se calcula por LÍNEA, no por venta: es pedido la línea sin lote
//    asignado (stock_batch_id NULL) marcada como backorder o con ingreso pendiente.
//    Cuando el producto llega y se le asigna lote, deja de ser pedido y su saldo
//    pasa a exigible. (Antes una línea ya entregada seguía contando como "a pedido"
//    y su deuda quedaba oculta con el filtro por defecto.)
//  · En una venta mixta, el saldo se reparte: primero cubre lo pendiente de
//    llegar (deuda a pedido = mín(saldo, total de líneas pendientes)), el resto
//    es exigible.
//  · Clientes con el mismo RUC/DNI se agrupan (duplicados en el ERP).
//  · Saldo a favor: créditos activos del módulo Saldo a favor (base del portal),
//    para no cobrarle a alguien a quien también le debemos.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel, fechaLima, nombreProdVar } = require('./comunes');

const TOL = 0.01;                 // residuo mínimo que cuenta como deuda
const CACHE_MS = 60 * 1000;       // caché de los datos crudos
const DIA = 86400000;
const TRAMOS = [
  { id: '0-30', nombre: '0–30 días', min: 0, max: 30 },
  { id: '31-60', nombre: '31–60 días', min: 31, max: 60 },
  { id: '61-90', nombre: '61–90 días', min: 61, max: 90 },
  { id: '90+', nombre: 'Más de 90 días', min: 91, max: Infinity }
];
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const normalizar = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const escHtml = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tramoDe(dias) {
  return (TRAMOS.find(t => dias >= t.min && dias <= t.max) || TRAMOS[0]).id;
}

// Valida y normaliza los filtros que llegan del navegador
function leerFiltros(q = {}) {
  const emp = parseInt(q.empresa, 10);
  const aPed = ['exigible', 'todos', 'solo'].includes(q.a_pedido) ? q.a_pedido
    : (q.a_pedido === 'ocultar' ? 'exigible' : 'exigible');   // 'ocultar' = nombre antiguo
  const min = Math.max(0, Number(q.min) || 0);
  return {
    empresa: EMPRESAS_BI[emp] ? emp : null,
    a_pedido: aPed,
    antiguedad: TRAMOS.some(t => t.id === q.antiguedad) ? q.antiguedad : '',
    tipo: ['empresa', 'persona'].includes(q.tipo) ? q.tipo : '',
    contacto: ['correo', 'whatsapp', 'sin'].includes(q.contacto) ? q.contacto : '',
    min,
    q: String(q.q || '').trim().slice(0, 80)
  };
}

function textoFiltros(f) {
  const t = [];
  t.push(['Empresa', f.empresa ? EMPRESAS_BI[f.empresa] : 'Todas']);
  t.push(['Deuda', f.a_pedido === 'exigible' ? 'Exigible (sin a pedido)' : f.a_pedido === 'solo' ? 'Solo a pedido' : 'Todo']);
  if (f.antiguedad) t.push(['Antigüedad', TRAMOS.find(x => x.id === f.antiguedad).nombre]);
  if (f.tipo) t.push(['Tipo', f.tipo === 'empresa' ? 'Empresas (B2B)' : 'Personas (B2C)']);
  if (f.contacto) t.push(['Contacto', { correo: 'Con correo', whatsapp: 'Con teléfono', sin: 'Sin contacto' }[f.contacto]]);
  if (f.min) t.push(['Saldo mínimo', 'S/ ' + f.min]);
  if (f.q) t.push(['Búsqueda', f.q]);
  return t;
}

// ── Cálculo puro (sin base de datos): recibe los datos crudos y los filtros ──
//  raw = { ventas, items, clientes, ultPagos, vouchers, creditos, recordatorios }
function calcularCartera(raw, f, hoy = new Date()) {
  const hoyMs = new Date(hoy).getTime();

  const cliMap = {};
  (raw.clientes || []).forEach(c => {
    cliMap[Number(c.id)] = {
      nombre: (c.is_company ? c.business_name : `${c.first_name || ''} ${c.last_name || ''}`).trim(),
      ruc: String(c.document_number || '').trim(), email: String(c.email || '').trim(),
      phone: String(c.phone || '').trim(), empresa: !!c.is_company
    };
  });
  const ultPagoCli = {};
  (raw.ultPagos || []).forEach(r => { ultPagoCli[Number(r.customer_id)] = r.ultimo_pago; });

  const vouch = {};
  (raw.vouchers || []).forEach(v => {
    const t = v.type === 'factura' ? 'Factura' : v.type === 'boleta' ? 'Boleta' : (v.type || 'Comp.');
    (vouch[Number(v.sale_id)] = vouch[Number(v.sale_id)] || []).push(`${t} ${v.serie}-${v.number}`);
  });

  // Líneas por venta + total pendiente de llegar
  const itemsVenta = {}, pendVenta = {};
  (raw.items || []).forEach(it => {
    const k = Number(it.sale_id);
    const totalLinea = it.total != null ? Number(it.total) : Number(it.quantity) * Number(it.unit_price);
    const pedido = it.stock_batch_id == null && (Number(it.is_backorder) === 1 || it.pending_stock_entry_id != null);
    if (pedido) pendVenta[k] = (pendVenta[k] || 0) + totalLinea;
    (itemsVenta[k] = itemsVenta[k] || []).push({
      producto: nombreProdVar(it.producto, it.variacion) || `(producto #${it.product_variation_id})`,
      sku: it.sku || '—', cantidad: Number(it.quantity), precio: Number(it.unit_price),
      total: r2(totalLinea), a_pedido: pedido
    });
  });

  const resumen = { exigible: 0, pedido: 0 };
  const grupos = {};
  (raw.ventas || []).forEach(v => {
    const id = Number(v.id);
    const deuda = r2(Number(v.total) - Number(v.pagado || 0));
    if (deuda < TOL) return;
    const deudaPedido = r2(Math.min(deuda, pendVenta[id] || 0));
    const exigible = r2(deuda - deudaPedido);
    const dias = Math.max(0, Math.floor((hoyMs - new Date(v.created_at).getTime()) / DIA));
    const tramo = tramoDe(dias);
    if (f.antiguedad && tramo !== f.antiguedad) return;

    resumen.exigible += exigible;
    resumen.pedido += deudaPedido;

    const saldo = f.a_pedido === 'exigible' ? exigible : f.a_pedido === 'solo' ? deudaPedido : deuda;
    if (saldo < TOL) return;

    const info = cliMap[Number(v.customer_id)] || { nombre: '', ruc: '', email: '', phone: '', empresa: false };
    const clave = info.ruc ? 'doc:' + info.ruc : 'id:' + v.customer_id;
    let g = grupos[clave];
    if (!g) {
      g = grupos[clave] = {
        clave, customer_id: Number(v.customer_id), customer_ids: new Set(),
        cliente: info.nombre || `Cliente ${v.customer_id}`, ruc: info.ruc,
        email: info.email, phone: info.phone, es_empresa: info.empresa,
        saldo: 0, exigible: 0, pedido: 0, tramos: {}, num_ventas: 0, dias_max: 0,
        venta_mas_antigua: null, ultimo_pago: null, empresas: new Set(), ventas: []
      };
    }
    g.customer_ids.add(Number(v.customer_id));
    if (!g.email && info.email) g.email = info.email;
    if (!g.phone && info.phone) g.phone = info.phone;
    const up = ultPagoCli[Number(v.customer_id)];
    [up, v.ultimo_pago].forEach(x => {
      if (x && (!g.ultimo_pago || new Date(x) > new Date(g.ultimo_pago))) g.ultimo_pago = x;
    });
    g.saldo += saldo;
    g.exigible += f.a_pedido === 'solo' ? 0 : exigible;
    g.pedido += f.a_pedido === 'exigible' ? 0 : deudaPedido;
    g.tramos[tramo] = (g.tramos[tramo] || 0) + saldo;
    g.num_ventas += 1;
    if (dias > g.dias_max) g.dias_max = dias;
    if (!g.venta_mas_antigua || new Date(v.created_at) < new Date(g.venta_mas_antigua)) g.venta_mas_antigua = v.created_at;
    g.empresas.add(EMPRESAS_BI[v.company_id] || `Empresa ${v.company_id}`);
    g.ventas.push({
      id, codigo: v.code, fecha: v.created_at, dias, tramo,
      empresa: EMPRESAS_BI[v.company_id] || `Empresa ${v.company_id}`,
      total: r2(v.total), pagado: r2(v.pagado), deuda, exigible, deuda_pedido: deudaPedido, saldo: r2(saldo),
      a_pedido: deudaPedido >= TOL,
      ultimo_pago_venta: v.ultimo_pago || null,
      comprobante: (vouch[id] || []).join(' · ') || '—',
      productos: itemsVenta[id] || []
    });
  });

  // Saldo a favor (créditos activos) y último recordatorio
  const creditos = (raw.creditos || []).map(c => ({
    id: c.id, customer_id: c.customer_id != null ? Number(c.customer_id) : null,
    doc: String(c.cliente_doc || '').trim(), saldo: r2(Number(c.monto) - Number(c.usado))
  })).filter(c => c.saldo >= TOL);
  const recMap = {};
  (raw.recordatorios || []).forEach(r => { recMap[r.clave] = r; });

  const qn = normalizar(f.q);
  let lista = Object.values(grupos).map(g => {
    const ids = [...g.customer_ids];
    const credito = r2(creditos.filter(c => (c.customer_id != null && ids.includes(c.customer_id)) || (g.ruc && c.doc === g.ruc))
      .reduce((s, c) => s + c.saldo, 0));
    const rec = recMap[g.clave] || null;
    const tramos = {};
    TRAMOS.forEach(t => { tramos[t.id] = r2(g.tramos[t.id] || 0); });
    return {
      clave: g.clave, customer_id: g.customer_id, customer_ids: ids,
      cliente: g.cliente, ruc: g.ruc, email: g.email, phone: g.phone, es_empresa: g.es_empresa,
      saldo: r2(g.saldo), exigible: r2(g.exigible), pedido: r2(g.pedido), tramos,
      // compatibilidad con la versión anterior
      deuda_total: r2(g.saldo), deuda_normal: r2(g.exigible), deuda_pedido: r2(g.pedido),
      num_ventas: g.num_ventas, dias_max: g.dias_max, tramo: tramoDe(g.dias_max),
      venta_mas_antigua: g.venta_mas_antigua, ultimo_pago: g.ultimo_pago,
      dias_sin_pago: g.ultimo_pago ? Math.max(0, Math.floor((hoyMs - new Date(g.ultimo_pago).getTime()) / DIA)) : null,
      credito_favor: credito,
      ultimo_recordatorio: rec ? { fecha: rec.enviado_en, canal: rec.canal, por: rec.enviado_por } : null,
      empresas: [...g.empresas].join(', '),
      ventas: g.ventas.sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
    };
  });

  if (f.tipo) lista = lista.filter(x => (f.tipo === 'empresa') === x.es_empresa);
  if (f.contacto === 'correo') lista = lista.filter(x => x.email);
  else if (f.contacto === 'whatsapp') lista = lista.filter(x => x.phone);
  else if (f.contacto === 'sin') lista = lista.filter(x => !x.email && !x.phone);
  if (f.min) lista = lista.filter(x => x.saldo >= f.min);
  if (qn) lista = lista.filter(x => normalizar(x.cliente).includes(qn) || normalizar(x.ruc).includes(qn)
    || x.ventas.some(v => normalizar(v.codigo).includes(qn)));

  lista.sort((a, b) => b.saldo - a.saldo);

  const total = r2(lista.reduce((s, x) => s + x.saldo, 0));
  const tramos = TRAMOS.map(t => {
    const monto = r2(lista.reduce((s, x) => s + x.tramos[t.id], 0));
    return { id: t.id, nombre: t.nombre, monto, pct: total ? Math.round(monto / total * 1000) / 10 : 0,
      clientes: lista.filter(x => x.tramos[t.id] >= TOL).length };
  });
  return {
    filtros: f,
    resumen: {
      total, clientes: lista.length,
      ventas: lista.reduce((s, x) => s + x.num_ventas, 0),
      // exigible / a pedido de TODA la cartera (con empresa y antigüedad), para dar contexto
      exigible_cartera: r2(resumen.exigible), pedido_cartera: r2(resumen.pedido),
      mas_90: tramos[3].monto, pct_mas_90: tramos[3].pct,
      sin_contacto: lista.filter(x => !x.email && !x.phone).length,
      con_credito: lista.filter(x => x.credito_favor >= TOL).length,
      credito_favor: r2(lista.reduce((s, x) => s + x.credito_favor, 0)),
      dias_promedio: total ? Math.round(lista.reduce((s, x) => s + x.ventas.reduce((a, v) => a + v.saldo * v.dias, 0), 0) / total) : 0
    },
    tramos,
    clientes: lista,
    // compatibilidad
    total: lista.length, suma_total: total
  };
}

module.exports = function registrarCuentasCobrar({ app, authAdmin, mCxc, prodPool, portalPool }) {

  async function asegurarTablaRecordatorios() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cxc_recordatorios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        clave VARCHAR(80) NOT NULL,
        customer_id BIGINT,
        cliente VARCHAR(255),
        canal VARCHAR(20) NOT NULL,
        monto DECIMAL(12,2),
        enviado_por VARCHAR(100),
        enviado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_clave (clave)
      )`);
  }
  let tablaLista = null;
  const tablaRecordatorios = () => (tablaLista = tablaLista || asegurarTablaRecordatorios().catch(e => { tablaLista = null; throw e; }));

  // IN (?) en bloques para no armar consultas gigantes
  async function enBloques(sql, ids, extra = []) {
    const out = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const [rows] = await prodPool.query(sql, [ids.slice(i, i + 1000), ...extra]);
      out.push(...rows);
    }
    return out;
  }

  const cache = new Map(); // empresa → { t, raw }
  async function datosCrudos(empresa, fresco) {
    const k = String(empresa || 'todas');
    const c = cache.get(k);
    if (!fresco && c && Date.now() - c.t < CACHE_MS) return c.raw;

    const w = ["s.deleted_at IS NULL", "s.status IN ('confirmed','pending_payment')"];
    const p = [];
    if (empresa) { w.push('s.company_id = ?'); p.push(empresa); }
    const [ventas] = await prodPool.query(`
      SELECT s.id, s.code, s.customer_id, s.company_id, s.total, s.created_at,
             COALESCE(pg.pagado, 0) AS pagado, pg.ultimo_pago
        FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(amount) AS pagado, MAX(paid_at) AS ultimo_pago
                     FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id) pg ON pg.sale_id = s.id
       WHERE ${w.join(' AND ')}
         AND (s.total - COALESCE(pg.pagado, 0)) >= ${TOL}`, p);

    const raw = { ventas, items: [], clientes: [], ultPagos: [], vouchers: [], creditos: [], recordatorios: [] };
    if (ventas.length) {
      const saleIds = ventas.map(v => v.id);
      const custIds = [...new Set(ventas.map(v => v.customer_id))];
      [raw.items, raw.clientes, raw.ultPagos, raw.vouchers] = await Promise.all([
        enBloques(`
          SELECT si.sale_id, si.quantity, si.unit_price, si.total, si.stock_batch_id,
                 si.is_backorder, si.pending_stock_entry_id, si.product_variation_id,
                 pv.sku, pv.name AS variacion, p.name AS producto
            FROM sale_items si
            LEFT JOIN product_variations pv ON pv.id = si.product_variation_id
            LEFT JOIN products p ON p.id = pv.product_id
           WHERE si.sale_id IN (?)`, saleIds),
        enBloques(`SELECT id, is_company, business_name, first_name, last_name, document_number, email, phone
                     FROM parties WHERE id IN (?)`, custIds),
        enBloques(`SELECT s.customer_id, MAX(sp.paid_at) AS ultimo_pago
                     FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
                    WHERE sp.voided_at IS NULL AND s.customer_id IN (?)
                    GROUP BY s.customer_id`, custIds),
        enBloques(`SELECT sale_id, type, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, saleIds)
      ]);
      // Base del portal: créditos a favor y recordatorios (si fallan, se sigue sin ellos)
      try {
        const [cr] = await portalPool.query(
          `SELECT id, customer_id, cliente_doc, monto, usado FROM creditos_cliente
            WHERE (anulado IS NULL OR anulado = 0) AND monto - usado > 0`);
        raw.creditos = cr;
      } catch (e) { /* tabla aún no creada */ }
    }
    cache.set(k, { t: Date.now(), raw });
    return raw;
  }

  async function leerRecordatorios() {
    try {
      await tablaRecordatorios();
      const [rows] = await portalPool.query(`
        SELECT r.clave, r.canal, r.enviado_en, r.enviado_por FROM cxc_recordatorios r
        JOIN (SELECT MAX(id) AS id FROM cxc_recordatorios GROUP BY clave) u ON u.id = r.id`);
      return rows;
    } catch (e) { return []; }
  }

  async function obtenerCartera(q) {
    const f = leerFiltros(q);
    const raw = await datosCrudos(f.empresa, q.fresco === '1' || q.fresco === true);
    const recordatorios = await leerRecordatorios();
    return calcularCartera({ ...raw, recordatorios }, f);
  }

  async function registrarRecordatorio(c, canal, usuario) {
    try {
      await tablaRecordatorios();
      await portalPool.query(
        `INSERT INTO cxc_recordatorios (clave, customer_id, cliente, canal, monto, enviado_por) VALUES (?,?,?,?,?,?)`,
        [c.clave, c.customer_id, String(c.cliente || '').slice(0, 255), canal, c.saldo, usuario || 'admin']);
    } catch (e) { console.warn('[cxc] no se pudo registrar el recordatorio:', e.message); }
  }

  app.get('/api/cxc', authAdmin, mCxc, async (req, res) => {
    try { res.json(await obtenerCartera(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cxc-excel', authAdmin, mCxc, async (req, res) => {
    try {
      const d = await obtenerCartera(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const cab = textoFiltros(d.filtros).concat([['Clientes', d.resumen.clientes], ['Total', 'S/ ' + d.resumen.total.toFixed(2)]]);
      const head = (ws, cols) => {
        cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        return hr.number;
      };

      // Hoja 1: un renglón por cliente, con antigüedad
      const wc = wb.addWorksheet('Clientes');
      cabeceraExcel(wc, 'Cuentas por cobrar — por cliente', cab, 13);
      const colsC = [['Cliente', 32], ['RUC/Doc', 14], ['Tipo', 9], ['Correo', 26], ['Teléfono', 14],
        ['Saldo', 13], ['0–30', 12], ['31–60', 12], ['61–90', 12], ['+90', 12],
        ['Días (venta más antigua)', 12], ['Último pago', 12], ['Saldo a favor', 12], ['Ventas', 8], ['Último recordatorio', 18]];
      const hc = head(wc, colsC);
      d.clientes.forEach(x => wc.addRow([x.cliente, x.ruc, x.es_empresa ? 'Empresa' : 'Persona', x.email, x.phone,
        x.saldo, x.tramos['0-30'], x.tramos['31-60'], x.tramos['61-90'], x.tramos['90+'],
        x.dias_max, x.ultimo_pago ? fechaLima(x.ultimo_pago) : '—', x.credito_favor || '',
        x.num_ventas, x.ultimo_recordatorio ? `${fechaLima(x.ultimo_recordatorio.fecha)} (${x.ultimo_recordatorio.canal})` : '—']));
      const tc = wc.addRow(['TOTAL', '', '', '', '', d.resumen.total, ...d.tramos.map(t => t.monto)]);
      tc.font = { bold: true };
      [6, 7, 8, 9, 10, 13].forEach(c => wc.getColumn(c).numFmt = '#,##0.00');
      wc.views = [{ state: 'frozen', ySplit: hc }];
      wc.autoFilter = { from: { row: hc, column: 1 }, to: { row: hc, column: colsC.length } };

      // Hoja 2: una fila por venta
      const wv = wb.addWorksheet('Ventas');
      cabeceraExcel(wv, 'Cuentas por cobrar — por venta', cab, 12);
      const colsV = [['Cliente', 32], ['RUC/Doc', 14], ['Venta', 14], ['Fecha', 11], ['Días', 7], ['Empresa', 22],
        ['Comprobante', 26], ['Total venta', 12], ['Pagado', 12], ['Saldo', 12], ['De eso, a pedido', 12], ['Último abono', 12]];
      const hv = head(wv, colsV);
      d.clientes.forEach(x => x.ventas.forEach(v => wv.addRow([x.cliente, x.ruc, v.codigo, fechaLima(v.fecha), v.dias,
        v.empresa, v.comprobante, v.total, v.pagado, v.saldo, v.deuda_pedido || '',
        v.ultimo_pago_venta ? fechaLima(v.ultimo_pago_venta) : '—'])));
      const tv = wv.addRow(['TOTAL', '', '', '', '', '', '', '', '', d.resumen.total]);
      tv.font = { bold: true };
      [8, 9, 10, 11].forEach(c => wv.getColumn(c).numFmt = '#,##0.00');
      wv.views = [{ state: 'frozen', ySplit: hv }];
      wv.autoFilter = { from: { row: hv, column: 1 }, to: { row: hv, column: colsV.length } };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('cuentas-por-cobrar')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
  });

  // Envío de recordatorios por correo (CC info@kuranko.pe). Respeta los filtros
  // de la pantalla: el correo muestra el mismo saldo que se ve en la tabla.
  app.post('/api/cxc-cobrar', authAdmin, mCxc, async (req, res) => {
    const claves = Array.isArray(req.body.claves) ? req.body.claves.map(String) : [];
    if (!claves.length) return res.status(400).json({ error: 'No se seleccionaron clientes.' });
    if (claves.length > 100) return res.status(400).json({ error: 'Máximo 100 clientes por envío.' });
    if (!process.env.RESEND_API_KEY)
      return res.status(400).json({ error: 'El envío de correos no está configurado (falta RESEND_API_KEY).' });
    try {
      const filtros = { ...(req.body.filtros || {}) };
      delete filtros.q; delete filtros.contacto; delete filtros.min; // la selección manda
      const d = await obtenerCartera(filtros);
      const sel = d.clientes.filter(x => claves.includes(x.clave));
      const conCorreo = sel.filter(x => /\S+@\S+\.\S+/.test(x.email));
      if (!conCorreo.length) return res.status(400).json({ error: 'Ninguno de los seleccionados tiene correo válido.' });

      const fmtS = n => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const td = 'padding:6px 10px;border:1px solid #ddd';
      const resultados = [];
      for (const c of conCorreo) {
        const filas = c.ventas.map(v => `<tr><td style="${td}">${escHtml(v.codigo)}</td><td style="${td}">${fechaLima(v.fecha, '—')}</td>` +
          `<td style="${td}">${escHtml(v.comprobante)}${v.a_pedido ? ' <i>(incluye producto a pedido)</i>' : ''}</td>` +
          `<td style="${td};text-align:right">${fmtS(v.saldo)}</td></tr>`).join('');
        const th = 'padding:6px 10px;border:1px solid #000726;text-align:left';
        const html = `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">` +
          `<h2 style="color:#000726">Recordatorio de pago pendiente</h2>` +
          `<p>Estimado(a) <b>${escHtml(c.cliente)}</b>,</p>` +
          `<p>Le escribimos de <b>Kuranko</b> para recordarle que, según nuestros registros, mantiene un saldo pendiente de <b>${fmtS(c.saldo)}</b>, correspondiente a ${c.num_ventas} operación(es):</p>` +
          `<table style="border-collapse:collapse;font-size:13px;margin:8px 0"><thead><tr style="background:#000726;color:#fff">` +
          `<th style="${th}">Venta</th><th style="${th}">Fecha</th><th style="${th}">Comprobante</th><th style="${th};text-align:right">Saldo</th>` +
          `</tr></thead><tbody>${filas}</tbody></table>` +
          `<p>Le agradeceremos regularizar el pago a la brevedad. Si ya realizó el pago, por favor haga caso omiso de este mensaje o comuníquese con nosotros para actualizar su estado.</p>` +
          `<p>Para coordinar el pago o cualquier consulta, puede responder a este correo o escribir a ventas@kuranko.pe.</p>` +
          `<p>Atentamente,<br><b>Equipo Kuranko</b></p></div>`;
        const texto = `Recordatorio de pago pendiente\n\nEstimado(a) ${c.cliente},\n\n` +
          `Le escribimos de Kuranko para recordarle que mantiene un saldo pendiente de ${fmtS(c.saldo)}, correspondiente a ${c.num_ventas} operación(es):\n\n` +
          c.ventas.map(v => `  • ${v.codigo} (${fechaLima(v.fecha, '—')}) — ${v.comprobante} — ${fmtS(v.saldo)}`).join('\n') +
          `\n\nLe agradeceremos regularizar el pago a la brevedad. Si ya realizó el pago, haga caso omiso de este mensaje.\n\n` +
          `Para coordinar el pago escriba a ventas@kuranko.pe.\n\nAtentamente,\nEquipo Kuranko`;
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
              to: [c.email], cc: ['info@kuranko.pe'], reply_to: 'ventas@kuranko.pe',
              subject: `Recordatorio de pago pendiente — ${c.cliente}`, html, text: texto
            })
          });
          if (r.ok) await registrarRecordatorio(c, 'correo', req.admin && req.admin.usuario);
          resultados.push({ cliente: c.cliente, email: c.email, ok: r.ok });
        } catch (e) { resultados.push({ cliente: c.cliente, email: c.email, ok: false }); }
      }
      const sinCorreo = sel.filter(x => !conCorreo.includes(x)).map(x => x.cliente);
      res.json({ enviados: resultados.filter(r => r.ok).length, total: resultados.length, resultados, sin_correo: sinCorreo });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // El WhatsApp se abre en el navegador; aquí solo se deja constancia.
  app.post('/api/cxc-recordatorio', authAdmin, mCxc, async (req, res) => {
    const { clave, customer_id, cliente, monto } = req.body || {};
    if (!clave) return res.status(400).json({ error: 'Falta el cliente.' });
    await registrarRecordatorio({ clave: String(clave).slice(0, 80), customer_id, cliente, saldo: Number(monto) || 0 },
      'whatsapp', req.admin && req.admin.usuario);
    res.json({ ok: true });
  });
};

module.exports._test = { calcularCartera, leerFiltros, tramoDe, TRAMOS };
