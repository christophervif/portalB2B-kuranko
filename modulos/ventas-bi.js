// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Ventas-BI (dashboard de ventas e ingresos)
//  KPIs, serie por día/semana/mes, rentabilidad, top productos y marcas.
//  Margen y ganancia se calculan SIN IGV (ver "BASE SIN IGV" más abajo).
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
// MARCA de un producto: todo lo que está antes del primer "-" del nombre
// ("Magura - MT7 Pro" → "Magura"). Si el nombre no tiene "-", la primera palabra.
const MARCA_SQL = `TRIM(CASE WHEN LOCATE('-', p.name) > 0 THEN SUBSTRING_INDEX(p.name, '-', 1) ELSE SUBSTRING_INDEX(TRIM(p.name), ' ', 1) END)`;
// Clave para comparar marcas entre el sistema y el Excel ("Oak Components" = "OakComponents")
const claveMarca = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const marcaValida = v => { const m = String(v == null ? '' : v).trim(); return m && m.length <= 80 ? m : null; };
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

  // ══ BASE SIN IGV (ajuste del maestro, en la base del PORTAL) ══
  // Precios de venta y costo de los lotes vienen con impuesto. Para el margen y la
  // utilidad se usan montos SIN IGV:
  //   · venta sin IGV = total ÷ 1.18 si la empresa cobra IGV (empresas_igv)
  //   · costo sin impuesto deducible, según "costo":
  //       'columna' → stock_batches.cost_price_without_refund (si el ERP la tiene y
  //                   está llena); si no, cost_price ÷ 1.18
  //       'dividir' → cost_price ÷ 1.18
  //       'igual'   → cost_price ya está sin impuesto deducible
  const CONFIG_DEF = { costo: 'columna', empresas_igv: Object.keys(EMPRESAS_BI).map(Number) };
  let _cfg = null, _cfgAt = 0, _colSinImp = null;
  async function tablaConfig() {
    await portalPool.query(`CREATE TABLE IF NOT EXISTS bi_config (
      clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(255) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  }
  async function leerConfig(forzar) {
    if (!forzar && _cfg && Date.now() - _cfgAt < 60 * 1000) return _cfg;
    const cfg = { ...CONFIG_DEF };
    try {
      await tablaConfig();
      const [rows] = await portalPool.query(`SELECT clave, valor FROM bi_config`);
      rows.forEach(r => {
        if (r.clave === 'costo' && ['columna', 'dividir', 'igual'].includes(r.valor)) cfg.costo = r.valor;
        if (r.clave === 'empresas_igv') cfg.empresas_igv = String(r.valor).split(',').map(Number).filter(n => EMPRESAS_BI[n]);
      });
    } catch (e) { /* sin base del portal: valores por defecto */ }
    if (_colSinImp === null) {
      try { const [c] = await prodPool.query(`SHOW COLUMNS FROM stock_batches LIKE 'cost_price_without_refund'`); _colSinImp = c.length > 0; }
      catch (e) { _colSinImp = false; }
    }
    cfg.columna_disponible = _colSinImp;
    _cfg = cfg; _cfgAt = Date.now();
    return cfg;
  }
  // Fragmentos SQL sin IGV (los valores salen de la config validada: solo números)
  function sqlNeto(cfg) {
    const ids = cfg.empresas_igv.filter(n => EMPRESAS_BI[n]).map(Number);
    const fv = ids.length ? `(CASE WHEN s.company_id IN (${ids.join(',')}) THEN 1.18 ELSE 1 END)` : '1';
    const cu = cfg.costo === 'igual' ? 'sb.cost_price'
      : cfg.costo === 'columna' && cfg.columna_disponible ? 'COALESCE(NULLIF(sb.cost_price_without_refund, 0), sb.cost_price / 1.18)'
      : '(sb.cost_price / 1.18)';
    return {
      FV: fv, COSTO_UNIT: cu,
      VENTA_CAB: `(s.total / ${fv})`,
      BASE: `CASE WHEN si.stock_batch_id IS NOT NULL THEN si.total / ${fv} ELSE 0 END`,
      COSTO: `CASE WHEN si.stock_batch_id IS NOT NULL THEN si.quantity * ${cu} ELSE 0 END`,
      GANANCIA: `CASE WHEN si.stock_batch_id IS NOT NULL THEN si.total / ${fv} - si.quantity * ${cu} ELSE 0 END`,
      fvEmp: cid => ids.includes(+cid) ? 1.18 : 1,
      fcHist: cfg.costo === 'igual' ? 1 : 1.18
    };
  }
  const soloMaestroCfg = (req, res, next) => (req.admin && req.admin.maestro) ? next()
    : res.status(403).json({ error: 'Solo el administrador maestro puede cambiar este ajuste' });
  app.get('/api/bi-config', authAdmin, async (req, res) => {
    try { res.json({ ...(await leerConfig(true)), maestro: !!(req.admin && req.admin.maestro),
      empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/bi-config', authAdmin, soloMaestroCfg, async (req, res) => {
    try {
      const b = req.body || {};
      await tablaConfig();
      if (b.costo !== undefined) {
        if (!['columna', 'dividir', 'igual'].includes(b.costo)) return res.status(400).json({ error: 'Opción de costo inválida' });
        await portalPool.query(`INSERT INTO bi_config (clave, valor) VALUES ('costo', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [b.costo]);
      }
      if (b.empresas_igv !== undefined) {
        const ids = (Array.isArray(b.empresas_igv) ? b.empresas_igv : []).map(Number).filter(n => EMPRESAS_BI[n]);
        await portalPool.query(`INSERT INTO bi_config (clave, valor) VALUES ('empresas_igv', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [ids.join(',')]);
      }
      res.json({ ok: true, config: await leerConfig(true) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Cobros que cuentan: no anulados y de ventas que no estén canceladas ni eliminadas
  // (un cobro sin venta asociada también cuenta).
  const COBRO_VALIDO = `sp.voided_at IS NULL AND (s.id IS NULL OR (s.deleted_at IS NULL AND s.status <> 'cancelled'))`;

  // ══ FILTRO POR MARCA ══
  // Sobre líneas de venta (si) o movimientos de stock (sm): agrega el JOIN al producto
  // y la condición. Sobre la cabecera de la venta se usa "bt": lo que la venta tiene
  // de esa marca (suma de sus líneas). Los cobros se reparten en proporción:
  // cobro × (líneas de la marca ÷ total de la venta).
  const fMarca = m => m ? `AND ${MARCA_SQL} = ${prodPool.escape(m)}` : '';
  const joinProd = (m, col = 'si.product_variation_id') => m
    ? `JOIN product_variations pvm ON pvm.id = ${col} JOIN products p ON p.id = pvm.product_id` : '';
  const ventasDeMarca = m => `(SELECT si.sale_id, SUM(si.total) AS t FROM sale_items si
      JOIN product_variations pvm ON pvm.id = si.product_variation_id JOIN products p ON p.id = pvm.product_id
      WHERE ${MARCA_SQL} = ${prodPool.escape(m)} GROUP BY si.sale_id)`;
  const PROP_MARCA = `LEAST(1, bt.t / NULLIF(s.total, 0))`;   // parte de la venta que es de la marca

  // Lista de marcas (para el filtro)
  app.get('/api/marcas-bi', authAdmin, mResumen, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT ${MARCA_SQL} AS marca, COUNT(*) AS productos FROM products p
        WHERE p.name IS NOT NULL AND TRIM(p.name) <> '' GROUP BY marca HAVING marca <> '' ORDER BY marca`);
      const lista = rows.map(r => ({ marca: r.marca, productos: +r.productos }));
      // Marcas que solo están en el Excel histórico
      const h = await leerHist().catch(() => null);
      if (h && h.lineas) {
        const ya = new Set(lista.map(m => claveMarca(m.marca))), extra = {};
        h.lineas.forEach(l => { if (l.marca && !ya.has(l.km)) extra[l.km] = extra[l.km] || l.marca; });
        Object.values(extra).forEach(m => lista.push({ marca: m, productos: 0, solo_excel: true }));
        lista.sort((a, b) => a.marca.localeCompare(b.marca));
      }
      res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
    // Detalle (si el JSON lo trae): cada línea de venta y de compra, con su marca
    const objs = t => t && Array.isArray(t.filas) ? t.filas.map(a => { const o = Object.fromEntries(t.columnas.map((c, i) => [c, a[i]])); o.km = claveMarca(o.marca); return o; }) : null;
    _hist = { origen: d.origen, generado: d.generado, desde: d.desde, hasta: d.hasta, corte, filas, actualizado: r.updated_at,
      lineas: objs(d.lineas), compras: objs(d.compras) };
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
        con_detalle: !!h.lineas, lineas: h.lineas ? h.lineas.length : 0, compras_det: h.compras ? h.compras.length : 0,
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
      // Detalle opcional: líneas de venta y de compra (para productos, marcas, métodos de pago…)
      const COLS_LIN = ['fecha', 'company_id', 'codigo', 'producto', 'marca', 'cantidad', 'venta', 'venta_neta', 'costo', 'costo_neto', 'pago', 'emp_cobro', 'b2b', 'cliente'];
      const COLS_COM = ['fecha', 'company_id', 'codigo', 'producto', 'marca', 'cantidad', 'costo'];
      const det = (t, cs, nums) => {
        if (!t) return undefined;
        if (!Array.isArray(t.columnas) || cs.some((c, i) => t.columnas[i] !== c) || !Array.isArray(t.filas)) throw Object.assign(new Error('El detalle del archivo no tiene el formato esperado'), { status: 400 });
        return { columnas: cs, filas: t.filas.filter(f => Array.isArray(f) && esFecha(f[0]) && [1, 2].includes(+f[1]))
          .map(f => cs.map((c, i) => nums.includes(c) ? (+f[i] || 0) : String(f[i] == null ? '' : f[i]).slice(0, 150))) };
      };
      limpio.lineas = det(d.lineas, COLS_LIN, ['company_id', 'cantidad', 'venta', 'venta_neta', 'costo', 'costo_neto', 'emp_cobro', 'b2b']);
      limpio.compras = det(d.compras, COLS_COM, ['company_id', 'cantidad', 'costo']);
      await tablaHist();
      // Corte por defecto: el día siguiente al último registro del Excel
      const corteDef = sumarDia(limpio.hasta, 1);
      await portalPool.query(`
        INSERT INTO bi_historico (id, data, corte) VALUES (1, ?, ?)
        ON DUPLICATE KEY UPDATE data = VALUES(data), corte = COALESCE(corte, VALUES(corte))`,
        [JSON.stringify(limpio), corteDef]);
      const h = await leerHist(true);
      res.json({ ok: true, desde: h.desde, hasta: h.hasta, corte: h.corte, filas: h.filas.length, lineas: h.lineas ? h.lineas.length : 0 });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
      res.json({ cargado: true, corte: h.corte, sugerido, con_detalle: !!h.lineas, excel_desde: h.desde, excel_hasta: h.hasta, primera_venta_sistema: primeraSis, filas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ── Detalle del Excel para las tablas (productos, marcas, métodos de pago, canal) ──
  // Devuelve las líneas de venta y compra del Excel dentro del rango, ANTES del corte,
  // con los filtros de empresa y marca. Sin detalle cargado → listas vacías.
  async function histDetalle({ desde, hasta, empresa, marca }) {
    const h = await leerHist().catch(() => null);
    const vacio = { lineas: [], compras: [], corte: h && h.corte, hay: !!(h && h.lineas) };
    if (!h || !h.corte || !h.lineas || !esFecha(desde) || !esFecha(hasta) || desde >= h.corte) return vacio;
    const emp = empresaId(empresa), km = marca ? claveMarca(marca) : null;
    const ok = x => x.fecha >= desde && x.fecha <= hasta && x.fecha < h.corte && (!emp || +x.company_id === emp) && (!km || x.km === km);
    return { lineas: h.lineas.filter(ok), compras: (h.compras || []).filter(ok), corte: h.corte, hay: true };
  }
  const nomProdHist = l => l.producto || l.codigo || '(sin nombre)';

  app.get('/api/empresas-bi', authAdmin, (req, res) =>
    res.json(Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre }))));

  app.get('/api/kpis', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const marca = marcaValida(req.query.marca);
    const BT = marca ? `JOIN ${ventasDeMarca(marca)} bt ON bt.sale_id = s.id` : '';
    const TOT = marca ? 'bt.t' : 's.total';
    try {
      // Con histórico: estos KPIs (por cobrar, clientes, canceladas) son solo del
      // sistema y arrancan en la fecha de corte, para no mezclar ventas migradas.
      const hist = await leerHist().catch(() => null);
      const corte = hist && hist.corte;
      const dSis = corte && esFecha(desde) && corte > desde ? corte : desde;
      const f = (dSis && hasta && dSis > hasta ? 'AND 1 = 0' : rango(dSis, hasta)) + ' ' + fEmp(empresa);
      const [[ventas]] = await prodPool.query(`
        SELECT COUNT(*) AS num_ventas, COALESCE(SUM(${TOT}),0) AS valor_ventas,
               COALESCE(AVG(${TOT}),0) AS ticket_promedio, COUNT(DISTINCT s.customer_id) AS clientes_unicos
        FROM sales s ${BT} WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      // Por cobrar = deuda de CADA venta (total − cobros vigentes, sin negativos), solo
      // ventas confirmadas o con pago pendiente: la misma regla de Cuentas por cobrar.
      // Antes se restaba todo en bloque y un sobrepago escondía la deuda de otra venta.
      const [[deuda]] = await prodPool.query(`
        SELECT COALESCE(SUM(GREATEST(s.total - COALESCE(p.pagado, 0), 0)${marca ? ' * ' + PROP_MARCA : ''}), 0) AS por_cobrar,
               COALESCE(SUM(CASE WHEN s.status = 'pending_payment' THEN ${TOT} ELSE 0 END), 0) AS pago_pendiente
        FROM sales s ${BT} LEFT JOIN (SELECT sale_id, SUM(amount) AS pagado FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id) p ON p.sale_id = s.id
        WHERE s.deleted_at IS NULL AND s.status IN ('confirmed','pending_payment') ${f}`);
      const [[canc]] = await prodPool.query(`
        SELECT COUNT(*) AS canceladas FROM sales s ${BT} WHERE s.deleted_at IS NULL AND s.status='cancelled' ${f}`);
      res.json({ ...ventas, ...canc, por_cobrar: Math.round(+deuda.por_cobrar * 100) / 100,
        pago_pendiente: +deuda.pago_pendiente, solo_sistema_desde: dSis !== desde ? dSis : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD FIFO ──
  app.get('/api/rentabilidad', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const marca = marcaValida(req.query.marca);
    const f = rango(desde, hasta) + ' ' + fEmp(empresa) + ' ' + fMarca(marca);
    try {
      const N = sqlNeto(await leerConfig());
      const [[r]] = await prodPool.query(`
        SELECT
          COALESCE(SUM(${N.BASE}),0) AS ingreso_neto,
          COALESCE(SUM(${N.COSTO}),0) AS costo_neto,
          COALESCE(SUM(${N.GANANCIA}),0) AS ganancia_neta,
          COALESCE(SUM(si.total),0) AS ingreso_total,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.quantity * sb.cost_price ELSE 0 END),0) AS costo,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id ${joinProd(marca)}
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      // Excel (antes del corte): una línea "tiene costo" si su costo es > 0
      const hd = await histDetalle({ desde, hasta, empresa, marca });
      hd.lineas.forEach(l => {
        const c = l.costo > 0;
        r.ingreso_total = +r.ingreso_total + l.venta;
        if (c) { r.ingreso_neto = +r.ingreso_neto + l.venta_neta; r.costo_neto = +r.costo_neto + l.costo_neto; r.ganancia_neta = +r.ganancia_neta + l.venta_neta - l.costo_neto;
          r.ingreso_confiable = +r.ingreso_confiable + l.venta; r.costo = +r.costo + l.costo; r.ganancia = +r.ganancia + l.venta - l.costo; }
      });
      r.incluye_excel = hd.lineas.length > 0;
      const ing = parseFloat(r.ingreso_confiable), tot = parseFloat(r.ingreso_total);
      const ingN = +r.ingreso_neto, ganN = +r.ganancia_neta;
      res.json({ ...r, margen_promedio: ingN > 0 ? ((ganN / ingN) * 100).toFixed(1) : null,
        // Qué parte de lo vendido tiene costo conocido (base del margen)
        cobertura: tot > 0 ? ((ing / tot) * 100).toFixed(1) : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/top-productos', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query;
    const f = rango(desde, hasta) + ' ' + fEmp(empresa) + ' ' + fMarca(marcaValida(req.query.marca));
    try {
      const N = sqlNeto(await leerConfig());
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.name AS variacion, pv.sku,
          SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${N.GANANCIA}),0) AS ganancia,
          COALESCE(SUM(${N.BASE}),0) AS ingreso_neto_conf,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY pv.id, p.name, pv.name, pv.sku ORDER BY ingreso DESC LIMIT 60`);
      const hd = await histDetalle({ desde, hasta, empresa, marca: marcaValida(req.query.marca) });
      const hp = {};
      hd.lineas.forEach(l => { const k = l.codigo || l.producto; const x = hp[k] = hp[k] || { producto: nomProdHist(l), variacion: '', sku: l.codigo, unidades: 0, ingreso: 0, ganancia: 0, ingreso_neto_conf: 0, ingreso_confiable: 0, lineas_pedido: 0, lineas_falla: 0, excel: true };
        x.unidades += l.cantidad; x.ingreso += l.venta; if (l.costo > 0) { x.ganancia += l.venta_neta - l.costo_neto; x.ingreso_neto_conf += l.venta_neta; x.ingreso_confiable += l.venta; } });
      rows.push(...Object.values(hp)); rows.sort((a, b) => +b.ingreso - +a.ingreso); rows.splice(60);
      res.json(rows.map(r => ({ ...r,
        margen: +r.ingreso_neto_conf > 0 ? Math.round(+r.ganancia / +r.ingreso_neto_conf * 1000) / 10 : null,
        cobertura: +r.ingreso > 0 ? Math.round(+r.ingreso_confiable / +r.ingreso * 100) : null,
        estado: r.lineas_pedido > 0 ? 'a_pedido' : r.lineas_falla > 0 ? 'sin_costo' : 'normal' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD POR MARCA ──
  // Por marca (texto antes del primer "-" del nombre del producto):
  //   ingreso        lo vendido, con IGV (todas las líneas)
  //   costo_lineas   costo de lo vendido tal como se compró (costo del lote, con
  //                  impuestos), solo de las líneas con lote
  //   ingreso_conf   lo vendido de esas mismas líneas (con IGV), para comparar
  //   ganancia       margen bruto SIN IGV = venta sin IGV − costo sin impuesto
  //                  deducible (FIFO, líneas con lote). NO es "vendido − comprado
  //                  en el período": es lo vendido menos lo que costaron ESAS unidades.
  //   comprado       mercadería de la marca ingresada en el período (entradas de
  //                  compra/importación al costo del lote, con impuestos)
  //   cobrado        cuánto de lo vendido ya se cobró: cobros vigentes de cada venta
  //                  (hasta su total) repartidos según el peso de la marca en la venta
  app.get('/api/marcas', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const marca = marcaValida(req.query.marca);
    const f = rango(desde, hasta) + ' ' + fEmp(empresa) + ' ' + fMarca(marca);
    try {
      const N = sqlNeto(await leerConfig());
      const [[rows], [compras]] = await Promise.all([
        prodPool.query(`
        SELECT ${MARCA_SQL} AS marca,
          COUNT(DISTINCT s.id) AS ventas, SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${N.GANANCIA}),0) AS ganancia,
          COALESCE(SUM(${N.BASE}),0) AS ingreso_neto_conf,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_conf,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.quantity * sb.cost_price ELSE 0 END),0) AS costo_lineas,
          COALESCE(SUM(si.total * LEAST(1, COALESCE(pg.pagado, 0) / NULLIF(s.total, 0))),0) AS cobrado,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        LEFT JOIN (SELECT sale_id, GREATEST(SUM(amount), 0) AS pagado FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id) pg ON pg.sale_id = s.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY marca HAVING ingreso > 0 ORDER BY ganancia DESC`),
        prodPool.query(`
        SELECT ${MARCA_SQL} AS marca, COALESCE(SUM(ABS(sm.quantity) * sb.cost_price),0) AS comprado
        FROM stock_movements sm
        JOIN stock_entries se ON se.id = sm.reference_id
        JOIN product_variations pv ON pv.id = sm.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON sb.id = (
          SELECT b.id FROM stock_batches b
          WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
          ORDER BY b.id LIMIT 1)
        WHERE sm.reference_type = ? AND se.operation_type_code IN (?)
          ${rango(desde, hasta, 'sm.movement_date')} ${fEmp(empresa, 'sb.company_id')} ${fMarca(marca)}
        GROUP BY marca`, [REF_ENTRADA, CODIGOS_COMPRA])
      ]);
      // Excel (antes del corte): ventas, costo y compras por marca. Lo cobrado en el Excel
      // se toma como 100 % (ventas cerradas; antes de 2023 no se anotaba la forma de pago).
      const hd = await histDetalle({ desde, hasta, empresa, marca });
      const porK = {}; rows.forEach(r => { porK[claveMarca(r.marca)] = r; });
      const ventasExcel = {};
      hd.lineas.forEach(l => {
        let r = porK[l.km];
        if (!r) r = porK[l.km] = { marca: l.marca, ventas: 0, unidades: 0, ingreso: 0, ganancia: 0, ingreso_neto_conf: 0, ingreso_conf: 0, costo_lineas: 0, cobrado: 0, ingreso_pendiente: 0, lineas_pedido: 0, lineas_falla: 0 };
        (ventasExcel[l.km] = ventasExcel[l.km] || new Set()).add(l.fecha + '|' + (l.cliente || '').toUpperCase());
        r.unidades = +r.unidades + l.cantidad; r.ingreso = +r.ingreso + l.venta; r.cobrado = +r.cobrado + l.venta;
        if (l.costo > 0) { r.ganancia = +r.ganancia + l.venta_neta - l.costo_neto; r.ingreso_neto_conf = +r.ingreso_neto_conf + l.venta_neta;
          r.ingreso_conf = +r.ingreso_conf + l.venta; r.costo_lineas = +r.costo_lineas + l.costo; }
        r.excel = true;
      });
      Object.entries(ventasExcel).forEach(([k, s]) => { porK[k].ventas = +porK[k].ventas + s.size; });
      rows.length = 0; rows.push(...Object.values(porK).filter(r => +r.ingreso > 0));
      const comp = {};
      compras.forEach(c => { const k = claveMarca(c.marca); comp[k] = (comp[k] || 0) + +c.comprado; });
      hd.compras.forEach(c => { comp[c.km] = (comp[c.km] || 0) + c.costo; });
      const r2 = n => Math.round((+n || 0) * 100) / 100;
      res.json(rows.sort((a, b) => +b.ganancia - +a.ganancia).map(r => {
        const ingN = +r.ingreso_neto_conf, gan = +r.ganancia, ing = +r.ingreso, cob = Math.min(+r.cobrado, ing);
        return { ...r, ingreso: r2(ing), ganancia: r2(gan), ingreso_conf: r2(r.ingreso_conf), costo_lineas: r2(r.costo_lineas),
          // Sin costo conocido no hay margen: null (se muestra "—", no "0 %")
          margen: ingN > 0 ? ((gan / ingN) * 100).toFixed(1) : null,
          cobertura: ing > 0 ? Math.round(+r.ingreso_conf / ing * 100) : null,
          comprado: r2(comp[claveMarca(r.marca)] || 0),
          cobrado: r2(cob), por_cobrar: r2(ing - cob),
          solvencia: ing > 0 ? Math.round(cob / ing * 1000) / 10 : null };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // B2B vs B2C con filtro de marca (sin marca, el panel usa /api/tipo-cliente)
  app.get('/api/tipo-cliente-bi', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const marca = marcaValida(req.query.marca);
    const f = (esFecha(desde) && esFecha(hasta) ? rango(desde, hasta) : '') + ' ' + fEmp(empresa);
    try {
      const [rows] = await prodPool.query(`
        SELECT pa.is_company, COUNT(DISTINCT pa.id) AS clientes, COUNT(s.id) AS ventas, COALESCE(SUM(${marca ? 'bt.t' : 's.total'}),0) AS total
        FROM sales s JOIN parties pa ON pa.id = s.customer_id ${marca ? `JOIN ${ventasDeMarca(marca)} bt ON bt.sale_id = s.id` : ''}
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f} GROUP BY pa.is_company`);
      // Excel: empresa = cliente con RUC (11 dígitos)
      const hd = await histDetalle({ desde, hasta, empresa, marca });
      [0, 1].forEach(b => {
        const ls = hd.lineas.filter(l => +l.b2b === b); if (!ls.length) return;
        let r = rows.find(x => +x.is_company === b); if (!r) rows.push(r = { is_company: b, clientes: 0, ventas: 0, total: 0 });
        r.total = +r.total + ls.reduce((a, l) => a + l.venta, 0);
        r.ventas = +r.ventas + new Set(ls.map(l => l.fecha + '|' + (l.cliente || '').toUpperCase())).size;
        r.clientes = +r.clientes + new Set(ls.map(l => (l.cliente || '').toUpperCase()).filter(Boolean)).size;
      });
      res.json(rows.map(r => ({ ...r, tipo: r.is_company ? 'Empresa (B2B)' : 'Persona (B2C)' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/metodos-pago-bi', authAdmin, mCaja, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const fe = fEmp(empresa, EMP_INGRESO);
    const marca = marcaValida(req.query.marca);
    const f = rango(desde, hasta, 'sp.paid_at') || `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT ci.name AS metodo, COUNT(*) AS cantidad, COALESCE(SUM(sp.amount${marca ? ' * ' + PROP_MARCA : ''}),0) AS total
        FROM sale_payments sp LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
        LEFT JOIN sales s ON s.id = sp.sale_id ${marca ? `JOIN ${ventasDeMarca(marca)} bt ON bt.sale_id = s.id` : ''}
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE ${COBRO_VALIDO} ${f} ${fe} GROUP BY sp.payment_method_id, ci.name ORDER BY total DESC`);
      // Excel: forma de pago de cada línea (cuenta); la empresa es la dueña de la cuenta
      if (esFecha(desde) && esFecha(hasta)) {
        const hd = await histDetalle({ desde, hasta, empresa: null, marca });
        const emp = empresaId(empresa), acc = {};
        hd.lineas.filter(l => l.pago && +l.emp_cobro && (!emp || +l.emp_cobro === emp)).forEach(l => {
          const k = l.pago + ' (Excel)'; const x = acc[k] = acc[k] || { metodo: k, cantidad: 0, total: 0, excel: true }; x.cantidad++; x.total += l.venta; });
        rows.push(...Object.values(acc)); rows.sort((a, b) => +b.total - +a.total);
      }
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
  async function serieAgrupada({ desde, hasta, empresa, agrupar, marca }) {
      marca = marcaValida(marca);
      const BT = marca ? `JOIN ${ventasDeMarca(marca)} bt ON bt.sale_id = s.id` : '';
      agrupar = ['dia', 'semana', 'mes'].includes(agrupar) ? agrupar : 'dia';
      if (!esFecha(desde) || !esFecha(hasta)) { const e = new Error('Rango de fechas inválido'); e.status = 400; throw e; }
      // Con histórico cargado: antes del corte manda el Excel, desde el corte el sistema
      const hist = await leerHist().catch(() => null);
      const corte = hist && hist.corte;
      const dSis = corte && corte > desde ? corte : desde;
      const entre = (campo) => dSis > hasta ? '1 = 0' : `${campo} BETWEEN '${dSis}' AND '${hasta} 23:59:59'`;
      const pV = periodoSQL('s.created_at', agrupar);
      const cfg = await leerConfig(), N = sqlNeto(cfg);
      const [[ventas], [ingresos], [margen], [compras], [otrasEntradas]] = await Promise.all([
        prodPool.query(`
          SELECT ${pV} AS periodo, s.company_id, COUNT(*) AS num_ventas, COALESCE(SUM(${marca ? 'bt.t' : 's.total'}),0) AS ventas,
            COALESCE(SUM(${marca ? `(bt.t / ${N.FV})` : N.VENTA_CAB}),0) AS ventas_netas
          FROM sales s ${BT} WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${entre('s.created_at')} ${fEmp(empresa)}
          GROUP BY periodo, s.company_id`),
        prodPool.query(`
          SELECT ${periodoSQL('sp.paid_at', agrupar)} AS periodo, ${EMP_INGRESO} AS company_id,
            COALESCE(SUM(sp.amount${marca ? ' * ' + PROP_MARCA : ''}),0) AS ingresos
          FROM sale_payments sp
          LEFT JOIN sales s ON s.id = sp.sale_id ${BT}
          LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
          WHERE ${COBRO_VALIDO} AND ${entre('sp.paid_at')} ${fEmp(empresa, EMP_INGRESO)}
          GROUP BY periodo, ${EMP_INGRESO}`),
        prodPool.query(`
          SELECT ${pV} AS periodo, s.company_id,
            COALESCE(SUM(${GANANCIA_NORMAL}),0) AS margen,
            COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS base_margen,
            COALESCE(SUM(si.total),0) AS ingreso_items,
            COALESCE(SUM(${N.GANANCIA}),0) AS margen_neto,
            COALESCE(SUM(${N.BASE}),0) AS base_neta
          FROM sale_items si JOIN sales s ON s.id = si.sale_id ${joinProd(marca)}
          LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${entre('s.created_at')} ${fEmp(empresa)} ${fMarca(marca)}
          GROUP BY periodo, s.company_id`),
        prodPool.query(`
          SELECT ${periodoSQL('sm.movement_date', agrupar)} AS periodo, sb.company_id,
            COALESCE(SUM(ABS(sm.quantity) * sb.cost_price),0) AS compras
          FROM stock_movements sm
          JOIN stock_entries se ON se.id = sm.reference_id ${joinProd(marca, 'sm.product_variation_id')}
          LEFT JOIN stock_batches sb ON sb.id = (
            SELECT b.id FROM stock_batches b
            WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
            ORDER BY b.id LIMIT 1)
          WHERE sm.reference_type = ? AND se.operation_type_code IN (?)
            AND ${entre('sm.movement_date')} ${fEmp(empresa, 'sb.company_id')} ${fMarca(marca)}
          GROUP BY periodo, sb.company_id`, [REF_ENTRADA, CODIGOS_COMPRA]),
        // Entradas que NO se cuentan como compra (para mostrarlas como nota y validar)
        prodPool.query(`
          SELECT COALESCE(se.operation_type_code,'(sin código)') AS codigo,
            COALESCE(SUM(ABS(sm.quantity) * sb.cost_price),0) AS total
          FROM stock_movements sm
          JOIN stock_entries se ON se.id = sm.reference_id ${joinProd(marca, 'sm.product_variation_id')}
          LEFT JOIN stock_batches sb ON sb.id = (
            SELECT b.id FROM stock_batches b
            WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
            ORDER BY b.id LIMIT 1)
          WHERE sm.reference_type = ? AND (se.operation_type_code IS NULL OR se.operation_type_code NOT IN (?))
            AND ${entre('sm.movement_date')} ${fEmp(empresa, 'sb.company_id')} ${fMarca(marca)}
          GROUP BY codigo HAVING total > 0 ORDER BY total DESC`, [REF_ENTRADA, CODIGOS_COMPRA]),
      ]);
      // Unir todo por (período, empresa). Empresa vacía → 0 ("sin empresa").
      const mapa = new Map();
      const fila = (periodo, cid) => {
        const k = periodo + '|' + (cid || 0);
        if (!mapa.has(k)) mapa.set(k, { periodo, company_id: cid || 0, ventas: 0, num_ventas: 0, ingresos: 0,
          margen: 0, base_margen: 0, ingreso_items: 0, compras: 0, ventas_netas: 0, margen_neto: 0, base_neta: 0 });
        return mapa.get(k);
      };
      ventas.forEach(r => { const f = fila(r.periodo, r.company_id); f.ventas += +r.ventas; f.num_ventas += +r.num_ventas; f.ventas_netas += +r.ventas_netas; });
      ingresos.forEach(r => { fila(r.periodo, r.company_id).ingresos += +r.ingresos; });
      margen.forEach(r => { const f = fila(r.periodo, r.company_id); f.margen += +r.margen; f.base_margen += +r.base_margen;
        f.ingreso_items += +r.ingreso_items; f.margen_neto += +r.margen_neto; f.base_neta += +r.base_neta; });
      compras.forEach(r => { fila(r.periodo, r.company_id).compras += +r.compras; });
      // Histórico del Excel (solo días anteriores al corte y dentro del rango)
      let usaExcel = false;
      // Con filtro de marca se usan las LÍNEAS del Excel (si el archivo trae detalle)
      if (marca && hist && hist.lineas && corte && desde < corte) {
        const emp = empresaId(empresa), km = claveMarca(marca), cuentas = {};
        hist.lineas.forEach(l => {
          if (l.km !== km || l.fecha < desde || l.fecha > hasta || l.fecha >= corte) return;
          if (!emp || +l.company_id === emp) {
            usaExcel = true;
            const f = fila(periodoJS(l.fecha, agrupar), +l.company_id);
            f.ventas += l.venta; f.ventas_netas += l.venta_neta; f.ingreso_items += l.venta;
            if (l.costo > 0) { f.base_margen += l.venta; f.margen += l.venta - l.costo; f.base_neta += l.venta_neta; f.margen_neto += l.venta_neta - l.costo_neto; }
            const kv = periodoJS(l.fecha, agrupar) + '|' + l.company_id; (cuentas[kv] = cuentas[kv] || new Set()).add(l.fecha + '|' + (l.cliente || '').toUpperCase());
          }
          if (+l.emp_cobro && (!emp || +l.emp_cobro === emp)) { usaExcel = true; fila(periodoJS(l.fecha, agrupar), +l.emp_cobro).ingresos += l.venta; }
        });
        Object.entries(cuentas).forEach(([k, st]) => { const [pe, c] = k.split('|'); fila(pe, +c).num_ventas += st.size; });
        (hist.compras || []).forEach(c => {
          if (c.km !== km || c.fecha < desde || c.fecha > hasta || c.fecha >= corte || (emp && +c.company_id !== emp)) return;
          usaExcel = true; fila(periodoJS(c.fecha, agrupar), +c.company_id).compras += c.costo;
        });
      }
      if (hist && corte && desde < corte && !marca) {
        const emp = empresaId(empresa);
        const CAMPOS = ['ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras'];
        hist.filas.forEach(h => {
          if (h.fecha < desde || h.fecha > hasta || h.fecha >= corte) return;
          if (emp && h.company_id !== emp) return;
          usaExcel = true;
          const f = fila(periodoJS(h.fecha, agrupar), h.company_id);
          CAMPOS.forEach(c => { f[c] += +h[c] || 0; });
          // El Excel no trae montos sin IGV: se derivan con la misma regla
          const fv = N.fvEmp(h.company_id), base = +h.base_margen || 0, costo = base - (+h.margen || 0);
          f.ventas_netas += (+h.ventas || 0) / fv; f.base_neta += base / fv; f.margen_neto += base / fv - costo / N.fcHist;
        });
      }
      const filas = [...mapa.values()].sort((a, b) => a.periodo.localeCompare(b.periodo) || a.company_id - b.company_id);
      return { agrupar, filas, codigos_compra: CODIGOS_COMPRA,
        config_igv: { costo: cfg.costo, empresas_igv: cfg.empresas_igv, columna_disponible: cfg.columna_disponible },
        historico: hist ? { corte, usado: usaExcel, desde: hist.desde, omitido_por_marca: !!(marca && corte && desde < corte && !hist.lineas) } : null,
        marca: marca || null,
        otras_entradas: otrasEntradas.map(r => ({ codigo: r.codigo, total: +r.total })) };
  }

  app.get('/api/bi-serie', authAdmin, mResumen, async (req, res) => {
    try {
      const { desde, hasta, empresa, agrupar, marca } = req.query;
      res.json(await serieAgrupada({ desde, hasta, empresa, agrupar, marca }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD POR CANAL (B2B vs B2C) ──
  app.get('/api/rentabilidad-canal', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query; const marca = marcaValida(req.query.marca);
    const f = rango(desde, hasta) + ' ' + fEmp(empresa) + ' ' + fMarca(marca);
    try {
      const N = sqlNeto(await leerConfig());
      const [rows] = await prodPool.query(`
        SELECT pa.is_company, COUNT(DISTINCT s.id) AS ventas,
          COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(${N.BASE}),0) AS ingreso_neto_conf,
          COALESCE(SUM(${N.GANANCIA}),0) AS ganancia
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN parties pa ON pa.id = s.customer_id ${joinProd(marca)}
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY pa.is_company ORDER BY pa.is_company DESC`);
      const hd = await histDetalle({ desde, hasta, empresa, marca });
      [1, 0].forEach(b => {
        const ls = hd.lineas.filter(l => +l.b2b === b); if (!ls.length) return;
        let r = rows.find(x => +x.is_company === b); if (!r) rows.push(r = { is_company: b, ventas: 0, ingreso: 0, ingreso_confiable: 0, ingreso_neto_conf: 0, ganancia: 0 });
        r.ventas = +r.ventas + new Set(ls.map(l => l.fecha + '|' + (l.cliente || '').toUpperCase())).size;
        ls.forEach(l => { r.ingreso = +r.ingreso + l.venta;
          if (l.costo > 0) { r.ingreso_confiable = +r.ingreso_confiable + l.venta; r.ingreso_neto_conf = +r.ingreso_neto_conf + l.venta_neta; r.ganancia = +r.ganancia + l.venta_neta - l.costo_neto; } });
      });
      rows.sort((a, b) => +b.is_company - +a.is_company);
      res.json(rows.map(r => {
        const conf = +r.ingreso_confiable, gan = +r.ganancia, ing = +r.ingreso, n = +r.ventas, confN = +r.ingreso_neto_conf;
        return { tipo: r.is_company ? 'Empresa (B2B)' : 'Persona (B2C)', ventas: n, ingreso: ing, ganancia: gan,
          ticket: n > 0 ? ing / n : 0,
          margen: confN > 0 ? ((gan / confN) * 100).toFixed(1) : null,
          cobertura: ing > 0 ? ((conf / ing) * 100).toFixed(1) : null };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PRODUCTOS CON MARGEN BAJO O NEGATIVO ──
  // Solo productos con costo conocido y al menos S/100 vendidos en el período,
  // para no llenar la lista con ventas sueltas. Ordenados del peor margen al mejor.
  app.get('/api/margen-bajo', authAdmin, mRent, async (req, res) => {
    const { desde, hasta, empresa } = req.query;
    const f = rango(desde, hasta) + ' ' + fEmp(empresa) + ' ' + fMarca(marcaValida(req.query.marca));
    try {
      const N = sqlNeto(await leerConfig());
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.name AS variacion, pv.sku,
          SUM(si.quantity) AS unidades,
          COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${N.BASE}),0) AS ingreso_neto,
          COALESCE(SUM(${N.COSTO}),0) AS costo,
          COALESCE(SUM(${N.GANANCIA}),0) AS ganancia
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND ${ES_NORMAL} ${f}
        GROUP BY pv.id, p.name, pv.name, pv.sku
        HAVING ingreso >= 100
        ORDER BY SUM(${N.GANANCIA}) / SUM(${N.BASE}) ASC LIMIT 15`);
      const hd = await histDetalle({ desde, hasta, empresa, marca: marcaValida(req.query.marca) });
      const hp = {};
      hd.lineas.filter(l => l.costo > 0).forEach(l => { const k = l.codigo || l.producto; const x = hp[k] = hp[k] || { producto: nomProdHist(l), variacion: '', sku: l.codigo, unidades: 0, ingreso: 0, ingreso_neto: 0, costo: 0, ganancia: 0, excel: true };
        x.unidades += l.cantidad; x.ingreso += l.venta; x.ingreso_neto += l.venta_neta; x.costo += l.costo_neto; x.ganancia += l.venta_neta - l.costo_neto; });
      rows.push(...Object.values(hp).filter(x => x.ingreso >= 100));
      rows.sort((a, b) => (+a.ganancia / (+a.ingreso_neto || 1)) - (+b.ganancia / (+b.ingreso_neto || 1))); rows.splice(15);
      res.json(rows.map(r => ({ ...r, margen: +r.ingreso_neto > 0 ? ((+r.ganancia / +r.ingreso_neto) * 100).toFixed(1) : '0.0' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

    return { serieAgrupada, leerConfig, sqlNeto };
};
