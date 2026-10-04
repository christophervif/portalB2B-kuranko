// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Ventas-BI (dashboard de ventas e ingresos)
//  KPIs, ventas/ingresos/margen por día, rentabilidad, top productos y marcas.
//  Recibe del index.js las piezas compartidas y usa comunes.js para helpers.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, rango, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA } = require('./comunes');

// ── Filtros compartidos del panel "Ventas e ingresos" ──
// empresa: '' (todas) o un company_id conocido. Se valida contra EMPRESAS_BI para
// no interpolar nada que venga del navegador sin control.
const empresaId = (v) => { const n = parseInt(v, 10); return EMPRESAS_BI[n] ? n : null; };
const fEmp = (v, campo = 's.company_id') => { const id = empresaId(v); return id ? `AND ${campo} = ${id}` : ''; };
// Empresa a la que pertenece un ingreso: la dueña de la cuenta donde entró el pago
// (misma regla que el cierre de caja); si el pago no tiene cuenta, la de la venta.
const EMP_INGRESO = 'COALESCE(ba.party_id, s.company_id)';
const esFecha = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// Expresión SQL del período según agrupación (día, semana que empieza el lunes, mes)
const periodoSQL = (campo, agrupar) =>
  agrupar === 'mes' ? `DATE_FORMAT(${campo}, '%Y-%m')`
  : agrupar === 'semana' ? `DATE_FORMAT(DATE_SUB(DATE(${campo}), INTERVAL WEEKDAY(${campo}) DAY), '%Y-%m-%d')`
  : `DATE_FORMAT(${campo}, '%Y-%m-%d')`;
// Códigos SUNAT (tabla 12) de las entradas que cuentan como COMPRA:
// 02 = compra nacional, 18 = entrada por importación. Saldos iniciales (16),
// devoluciones, transferencias, etc. NO son compras y se reportan aparte.
const CODIGOS_COMPRA = ['02', '18'];
const REF_ENTRADA = 'App\\Models\\StockEntry';

// Período (misma regla que periodoSQL) para una fecha 'YYYY-MM-DD' en JS,
// usado al agrupar las filas del histórico del Excel.
function periodoJS(f, agrupar) {
  if (agrupar === 'mes') return f.slice(0, 7);
  if (agrupar === 'semana') {
    const d = new Date(f + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10);
  }
  return f;
}
const sumarDia = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

module.exports = function registrarVentasBI({ app, authAdmin, mResumen, mRent, mCaja, prodPool, portalPool, VV }) {

  // ══ HISTÓRICO DEL EXCEL (antes de que existiera el sistema) ══
  // Se guarda en la base del PORTAL (no en el ERP ni en el repositorio): una sola
  // fila con el JSON que genera scripts/excel-a-historico.py y la fecha de corte.
  // Antes del corte, el panel usa el Excel; desde el corte, el sistema. Así las
  // ventas antiguas que se migraron al sistema no se cuentan dos veces.
  let _hist = null, _histAt = 0; const HIST_TTL = 10 * 60 * 1000;
  async function tablaHist() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS bi_historico (
        id TINYINT UNSIGNED PRIMARY KEY,
        data MEDIUMTEXT NOT NULL,
        corte DATE NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  }
  async function leerHist(forzar) {
    if (!portalPool) return null;
    if (!forzar && _hist !== null && Date.now() - _histAt < HIST_TTL) return _hist;
    await tablaHist();
    const [[r]] = await portalPool.query(`SELECT data, corte, updated_at FROM bi_historico WHERE id = 1`);
    if (!r) { _hist = false; _histAt = Date.now(); return _hist; }
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const corte = r.corte ? (r.corte instanceof Date ? r.corte.toISOString().slice(0, 10) : String(r.corte).slice(0, 10)) : null;
    const cols = d.columnas;
    const filas = d.filas.map(a => Object.fromEntries(cols.map((c, i) => [c, a[i]])));
    _hist = { origen: d.origen, generado: d.generado, desde: d.desde, hasta: d.hasta, corte, filas, actualizado: r.updated_at };
    _histAt = Date.now();
    return _hist;
  }
  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next()
    : res.status(403).json({ error: 'Solo el administrador maestro puede cambiar el histórico' });

  app.get('/api/historico', authAdmin, mResumen, async (req, res) => {
    try {
      const h = await leerHist(true);
      if (!h) return res.json({ cargado: false });
      res.json({ cargado: true, origen: h.origen, generado: h.generado, desde: h.desde, hasta: h.hasta,
        corte: h.corte, dias: new Set(h.filas.map(f => f.fecha)).size, actualizado: h.actualizado });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sube (o reemplaza) el histórico. Cuerpo = JSON de scripts/excel-a-historico.py
  app.post('/api/historico', authAdmin, soloMaestro, async (req, res) => {
    try {
      const d = req.body || {};
      const cols = ['fecha', 'company_id', 'ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras'];
      if (!Array.isArray(d.columnas) || cols.some((c, i) => d.columnas[i] !== c) || !Array.isArray(d.filas) || !d.filas.length)
        return res.status(400).json({ error: 'El archivo no tiene el formato esperado (genéralo con scripts/excel-a-historico.py)' });
      const malas = d.filas.filter(f => !Array.isArray(f) || !esFecha(f[0]) || ![0, 1, 2].includes(+f[1]) || f.slice(2).some(v => !isFinite(+v)));
      if (malas.length) return res.status(400).json({ error: `${malas.length} filas inválidas en el archivo` });
      const limpio = { origen: String(d.origen || '').slice(0, 120), generado: String(d.generado || '').slice(0, 40),
        desde: d.filas[0][0], hasta: d.filas[d.filas.length - 1][0], columnas: cols,
        filas: d.filas.map(f => [f[0], +f[1], ...f.slice(2).map(Number)]) };
      await tablaHist();
      // Corte por defecto: el día siguiente al último registro del Excel
      const corteDef = sumarDia(limpio.hasta, 1);
      await portalPool.query(`
        INSERT INTO bi_historico (id, data, corte) VALUES (1, ?, ?)
        ON DUPLICATE KEY UPDATE data = VALUES(data), corte = COALESCE(corte, VALUES(corte))`,
        [JSON.stringify(limpio), corteDef]);
      const h = await leerHist(true);
      res.json({ ok: true, desde: h.desde, hasta: h.hasta, corte: h.corte, filas: h.filas.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/historico/corte', authAdmin, soloMaestro, async (req, res) => {
    try {
      const { corte } = req.body || {};
      if (!esFecha(corte)) return res.status(400).json({ error: 'Fecha de corte inválida' });
      await tablaHist();
      const [r] = await portalPool.query(`UPDATE bi_historico SET corte = ? WHERE id = 1`, [corte]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Primero carga el histórico' });
      await leerHist(true);
      res.json({ ok: true, corte });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/historico', authAdmin, soloMaestro, async (req, res) => {
    try { await tablaHist(); await portalPool.query(`DELETE FROM bi_historico WHERE id = 1`); _hist = false; _histAt = Date.now(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Comparación mes a mes Excel vs sistema (sin aplicar el corte) para decidir
  // desde cuándo manda el sistema. Sugiere el corte: el primer mes a partir del
  // cual el sistema ya registra al menos el 90% de lo que dice el Excel en todos
  // los meses siguientes; si no hay, el día después del último registro del Excel.
  app.get('/api/historico/comparacion', authAdmin, mResumen, async (req, res) => {
    try {
      const h = await leerHist(true);
      if (!h) return res.json({ cargado: false });
      const [sis] = await prodPool.query(`
        SELECT DATE_FORMAT(s.created_at, '%Y-%m') AS mes, COUNT(*) AS num_ventas, COALESCE(SUM(s.total),0) AS ventas,
          MIN(DATE_FORMAT(s.created_at, '%Y-%m-%d')) AS primera
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          AND s.created_at < DATE_ADD(?, INTERVAL 2 MONTH)
        GROUP BY mes ORDER BY mes`, [h.hasta]);
      const exc = {};
      h.filas.forEach(f => { const m = f.fecha.slice(0, 7); const e = exc[m] = exc[m] || { ventas: 0, num_ventas: 0 };
        e.ventas += f.ventas; e.num_ventas += f.num_ventas; });
      const sisM = Object.fromEntries(sis.map(r => [r.mes, { ventas: +r.ventas, num_ventas: +r.num_ventas, primera: r.primera }]));
      const meses = [...new Set([...Object.keys(sisM), ...Object.keys(exc).filter(m => sisM[m] || m >= h.hasta.slice(0, 7))])].sort();
      // Solo meses donde hay algo del sistema o el tramo final del Excel
      const filas = meses.map(m => ({ mes: m, excel: exc[m] || { ventas: 0, num_ventas: 0 }, sistema: sisM[m] || { ventas: 0, num_ventas: 0 } }));
      let sugerido = sumarDia(h.hasta, 1);
      for (let i = 0; i < filas.length; i++) {
        const resto = filas.slice(i);
        const ok = resto.every(f => f.excel.ventas <= 0 || f.sistema.ventas >= 0.9 * f.excel.ventas);
        if (ok && filas[i].sistema.ventas > 0) { sugerido = filas[i].mes + '-01'; break; }
      }
      if (sugerido > sumarDia(h.hasta, 1)) sugerido = sumarDia(h.hasta, 1);
      const primeraSis = sis.length ? sis[0].primera : null;
      res.json({ cargado: true, corte: h.corte, sugerido, excel_desde: h.desde, excel_hasta: h.hasta, primera_venta_sistema: primeraSis, filas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/empresas-bi', authAdmin, (req, res) =>
    res.json(Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre }))));

  app.get('/api/kpis', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta, empresa } = req.query;
    try {
      // Con histórico: estos KPIs (por cobrar, clientes, canceladas) son solo del
      // sistema y arrancan en la fecha de corte, para no mezclar ventas migradas.
      const hist = await leerHist().catch(() => null);
      const corte = hist && hist.corte;
      const dSis = corte && esFecha(desde) && corte > desde ? corte : desde;
      const f = (dSis && hasta && dSis > hasta ? 'AND 1 = 0' : rango(dSis, hasta)) + ' ' + fEmp(empresa);
      const [[ventas]] = await prodPool.query(`
        SELECT COUNT(*) AS num_ventas, COALESCE(SUM(total),0) AS valor_ventas,
               COALESCE(AVG(total),0) AS ticket_promedio, COUNT(DISTINCT customer_id) AS clientes_unicos
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const [[recaudado]] = await prodPool.query(`
        SELECT COALESCE(SUM(sp.amount),0) AS dinero_recaudado
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE sp.voided_at IS NULL AND s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const [[canc]] = await prodPool.query(`
        SELECT COUNT(*) AS canceladas FROM sales s WHERE s.deleted_at IS NULL AND s.status='cancelled' ${f}`);
      const valorVentas = parseFloat(ventas.valor_ventas), recaud = parseFloat(recaudado.dinero_recaudado);
      res.json({ ...ventas, ...recaudado, ...canc, por_cobrar: Math.max(0, valorVentas - recaud),
        solo_sistema_desde: dSis !== desde ? dSis : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kpis-empresas', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT s.company_id, COUNT(*) AS num_ventas, COALESCE(SUM(s.total),0) AS valor_ventas,
               COALESCE(AVG(s.total),0) AS ticket_promedio
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY s.company_id ORDER BY s.company_id`);
      res.json(rows.map(r => ({ ...r, empresa: EMPRESAS_BI[r.company_id] || `Empresa ${r.company_id}` })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ventas-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND s.created_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND s.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(s.created_at) AS fecha, s.company_id, COUNT(*) AS cantidad, COALESCE(SUM(s.total),0) AS total
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY DATE(s.created_at), s.company_id ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ingresos realmente cobrados por día, separados por la empresa DUEÑA DE LA CUENTA
  // donde entró el pago (misma lógica que el cierre de caja). Si el pago no tiene
  // cuenta asignada, se cae al company_id de la venta.
  app.get('/api/ingresos-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(sp.paid_at) AS fecha,
          COALESCE(ba.party_id, s.company_id) AS company_id,
          COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp
        LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE sp.voided_at IS NULL ${f}
        GROUP BY DATE(sp.paid_at), COALESCE(ba.party_id, s.company_id)
        ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Margen de ganancia (FIFO) por día, separado por la empresa que gestiona la venta.
  // Usa la misma lógica GANANCIA_NORMAL de Rentabilidad: precio de venta menos costo
  // del lote. Los productos sin lote (a pedido/falla) aportan 0, igual que allá.
  app.get('/api/margen-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND s.created_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND s.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(s.created_at) AS fecha, s.company_id,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS total
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY DATE(s.created_at), s.company_id
        ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD FIFO ──
  app.get('/api/rentabilidad', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const f = rango(desde, hasta) + ' ' + fEmp(empresa);
    try {
      const [[r]] = await prodPool.query(`
        SELECT
          COALESCE(SUM(si.total),0) AS ingreso_total,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.quantity * sb.cost_price ELSE 0 END),0) AS costo,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const ing = parseFloat(r.ingreso_confiable), gan = parseFloat(r.ganancia), tot = parseFloat(r.ingreso_total);
      res.json({ ...r, margen_promedio: ing > 0 ? ((gan / ing) * 100).toFixed(1) : '0.0',
        // Qué parte de lo vendido tiene costo conocido (base del margen)
        cobertura: tot > 0 ? ((ing / tot) * 100).toFixed(1) : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/top-productos', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const f = rango(desde, hasta) + ' ' + fEmp(empresa);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.name AS variacion, pv.sku,
          SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY pv.id, p.name, pv.name, pv.sku ORDER BY ganancia DESC LIMIT 15`);
      res.json(rows.map(r => ({ ...r, estado: r.lineas_pedido > 0 ? 'a_pedido' : r.lineas_falla > 0 ? 'sin_costo' : 'normal' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/marcas', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const f = rango(desde, hasta) + ' ' + fEmp(empresa);
    try {
      const [rows] = await prodPool.query(`
        SELECT SUBSTRING_INDEX(p.name,' ',1) AS marca,
          COUNT(DISTINCT s.id) AS ventas, SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY marca HAVING ingreso > 0 ORDER BY ganancia DESC`);
      res.json(rows.map(r => {
        const ingConf = parseFloat(r.ingreso_confiable), gan = parseFloat(r.ganancia);
        return { ...r, margen: ingConf > 0 ? ((gan/ingConf)*100).toFixed(1) : '0.0' };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/metodos-pago-bi', authAdmin, mCaja, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const fe = fEmp(empresa, EMP_INGRESO);
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT ci.name AS metodo, COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
        LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE sp.voided_at IS NULL ${f} ${fe} GROUP BY sp.payment_method_id, ci.name ORDER BY total DESC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── SERIE AGRUPADA (día / semana / mes) POR EMPRESA ──
  // Alimenta el gráfico y la tabla "Mes a mes". Devuelve una fila por
  // (período, empresa) con: ventas, n° de ventas, ingresos, margen FIFO, base de
  // margen (ingreso con costo conocido), ingreso de líneas y compras.
  //  · ventas / n° / margen → por la empresa que gestiona la venta (fecha de venta)
  //  · ingresos            → por la empresa dueña de la cuenta (fecha de pago)
  //  · compras             → entradas de stock tipo compra/importación, valorizadas
  //                          al costo del lote, por la empresa dueña del lote.
  // La lógica vive en serieAgrupada() para que Rendimiento la reutilice
  // (mismos números en las dos pestañas, una sola fuente).
  async function serieAgrupada({ desde, hasta, empresa, agrupar }) {
      agrupar = ['dia', 'semana', 'mes'].includes(agrupar) ? agrupar : 'dia';
      if (!esFecha(desde) || !esFecha(hasta)) { const e = new Error('Rango de fechas inválido'); e.status = 400; throw e; }
      // Con histórico cargado: antes del corte manda el Excel, desde el corte el sistema
      const hist = await leerHist().catch(() => null);
      const corte = hist && hist.corte;
      const dSis = corte && corte > desde ? corte : desde;
      const entre = (campo) => dSis > hasta ? '1 = 0' : `${campo} BETWEEN '${dSis}' AND '${hasta} 23:59:59'`;
      const pV = periodoSQL('s.created_at', agrupar);
      const [[ventas], [ingresos], [margen], [compras], [otrasEntradas]] = await Promise.all([
        prodPool.query(`
          SELECT ${pV} AS periodo, s.company_id, COUNT(*) AS num_ventas, COALESCE(SUM(s.total),0) AS ventas
          FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${entre('s.created_at')} ${fEmp(empresa)}
          GROUP BY periodo, s.company_id`),
        prodPool.query(`
          SELECT ${periodoSQL('sp.paid_at', agrupar)} AS periodo, ${EMP_INGRESO} AS company_id,
            COALESCE(SUM(sp.amount),0) AS ingresos
          FROM sale_payments sp
          LEFT JOIN sales s ON s.id = sp.sale_id
          LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
          WHERE sp.voided_at IS NULL AND ${entre('sp.paid_at')} ${fEmp(empresa, EMP_INGRESO)}
          GROUP BY periodo, ${EMP_INGRESO}`),
        prodPool.query(`
          SELECT ${pV} AS periodo, s.company_id,
            COALESCE(SUM(${GANANCIA_NORMAL}),0) AS margen,
            COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS base_margen,
            COALESCE(SUM(si.total),0) AS ingreso_items
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${entre('s.created_at')} ${fEmp(empresa)}
          GROUP BY periodo, s.company_id`),
        prodPool.query(`
          SELECT ${periodoSQL('sm.movement_date', agrupar)} AS periodo, sb.company_id,
            COALESCE(SUM(ABS(sm.quantity) * sb.cost_price),0) AS compras
          FROM stock_movements sm
          JOIN stock_entries se ON se.id = sm.reference_id
          LEFT JOIN stock_batches sb ON sb.id = (
            SELECT b.id FROM stock_batches b
            WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
            ORDER BY b.id LIMIT 1)
          WHERE sm.reference_type = ? AND se.operation_type_code IN (?)
            AND ${entre('sm.movement_date')} ${fEmp(empresa, 'sb.company_id')}
          GROUP BY periodo, sb.company_id`, [REF_ENTRADA, CODIGOS_COMPRA]),
        // Entradas que NO se cuentan como compra (para mostrarlas como nota y validar)
        prodPool.query(`
          SELECT COALESCE(se.operation_type_code,'(sin código)') AS codigo,
            COALESCE(SUM(ABS(sm.quantity) * sb.cost_price),0) AS total
          FROM stock_movements sm
          JOIN stock_entries se ON se.id = sm.reference_id
          LEFT JOIN stock_batches sb ON sb.id = (
            SELECT b.id FROM stock_batches b
            WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
            ORDER BY b.id LIMIT 1)
          WHERE sm.reference_type = ? AND (se.operation_type_code IS NULL OR se.operation_type_code NOT IN (?))
            AND ${entre('sm.movement_date')} ${fEmp(empresa, 'sb.company_id')}
          GROUP BY codigo HAVING total > 0 ORDER BY total DESC`, [REF_ENTRADA, CODIGOS_COMPRA]),
      ]);
      // Unir todo por (período, empresa). Empresa vacía → 0 ("sin empresa").
      const mapa = new Map();
      const fila = (periodo, cid) => {
        const k = periodo + '|' + (cid || 0);
        if (!mapa.has(k)) mapa.set(k, { periodo, company_id: cid || 0, ventas: 0, num_ventas: 0, ingresos: 0,
          margen: 0, base_margen: 0, ingreso_items: 0, compras: 0 });
        return mapa.get(k);
      };
      ventas.forEach(r => { const f = fila(r.periodo, r.company_id); f.ventas += +r.ventas; f.num_ventas += +r.num_ventas; });
      ingresos.forEach(r => { fila(r.periodo, r.company_id).ingresos += +r.ingresos; });
      margen.forEach(r => { const f = fila(r.periodo, r.company_id); f.margen += +r.margen; f.base_margen += +r.base_margen; f.ingreso_items += +r.ingreso_items; });
      compras.forEach(r => { fila(r.periodo, r.company_id).compras += +r.compras; });
      // Histórico del Excel (solo días anteriores al corte y dentro del rango)
      let usaExcel = false;
      if (hist && corte && desde < corte) {
        const emp = empresaId(empresa);
        const CAMPOS = ['ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras'];
        hist.filas.forEach(h => {
          if (h.fecha < desde || h.fecha > hasta || h.fecha >= corte) return;
          if (emp && h.company_id !== emp) return;
          usaExcel = true;
          const f = fila(periodoJS(h.fecha, agrupar), h.company_id);
          CAMPOS.forEach(c => { f[c] += +h[c] || 0; });
        });
      }
      const filas = [...mapa.values()].sort((a, b) => a.periodo.localeCompare(b.periodo) || a.company_id - b.company_id);
      return { agrupar, filas, codigos_compra: CODIGOS_COMPRA,
        historico: hist ? { corte, usado: usaExcel, desde: hist.desde } : null,
        otras_entradas: otrasEntradas.map(r => ({ codigo: r.codigo, total: +r.total })) };
  }

  app.get('/api/bi-serie', authAdmin, mResumen, async (req, res) => {
    try {
      const { desde, hasta, empresa, agrupar } = req.query;
      res.json(await serieAgrupada({ desde, hasta, empresa, agrupar }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD POR CANAL (B2B vs B2C) ──
  app.get('/api/rentabilidad-canal', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const f = rango(desde, hasta) + ' ' + fEmp(empresa);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.is_company, COUNT(DISTINCT s.id) AS ventas,
          COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN parties p ON p.id = s.customer_id
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY p.is_company ORDER BY p.is_company DESC`);
      res.json(rows.map(r => {
        const conf = +r.ingreso_confiable, gan = +r.ganancia, ing = +r.ingreso, n = +r.ventas;
        return { tipo: r.is_company ? 'Empresa (B2B)' : 'Persona (B2C)', ventas: n, ingreso: ing, ganancia: gan,
          ticket: n > 0 ? ing / n : 0,
          margen: conf > 0 ? ((gan / conf) * 100).toFixed(1) : null,
          cobertura: ing > 0 ? ((conf / ing) * 100).toFixed(1) : null };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PRODUCTOS CON MARGEN BAJO O NEGATIVO ──
  // Solo productos con costo conocido y al menos S/100 vendidos en el período,
  // para no llenar la lista con ventas sueltas. Ordenados del peor margen al mejor.
  app.get('/api/margen-bajo', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const f = rango(desde, hasta) + ' ' + fEmp(empresa);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.name AS variacion, pv.sku,
          SUM(si.quantity) AS unidades,
          COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(si.quantity * sb.cost_price),0) AS costo,
          COALESCE(SUM(si.total - si.quantity * sb.cost_price),0) AS ganancia
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${ES_NORMAL} ${f}
        GROUP BY pv.id, p.name, pv.name, pv.sku
        HAVING ingreso >= 100
        ORDER BY SUM(si.total - si.quantity * sb.cost_price) / SUM(si.total) ASC LIMIT 15`);
      res.json(rows.map(r => ({ ...r, margen: +r.ingreso > 0 ? ((+r.ganancia / +r.ingreso) * 100).toFixed(1) : '0.0' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { serieAgrupada };
};
