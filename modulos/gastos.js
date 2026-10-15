// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Compras y gastos (egresos que no son mercadería)
//
//  Qué se anota aquí: todo el dinero que sale y NO es mercadería: planilla,
//  alquiler, servicios, fletes, comisiones, publicidad, impuestos, retiros…
//  La mercadería NO se anota: ya está en el ERP (entradas 02/18) e Importaciones;
//  anotarla aquí la contaría dos veces.
//
//  Cada gasto guarda:
//    · fecha de pago, monto y moneda (USD con tipo de cambio → monto en soles)
//    · CUENTA de donde salió el dinero: las cuentas bancarias del ERP (solo
//      lectura) o cuentas propias del módulo (efectivo, tarjetas…)
//    · EMPRESA del gasto (1 Diseños Corporativos, 2 Christopher/Kuranko). Por
//      defecto la dueña de la cuenta; si una empresa pagó un gasto de la otra,
//      queda registrado y el resumen muestra cuánto se deben entre empresas.
//    · categoría, proveedor (RUC opcional), descripción, comprobante (opcional)
//    · "fijo": gasto que se repite cada mes. Los gastos fijos se definen una vez
//      (tabla gas_fijos: qué es, empresa, categoría, monto estimado, día de pago)
//      y cada mes aparecen como PENDIENTES. Al pagarlos se registra el gasto real
//      eligiendo la cuenta de donde salió el dinero, la fecha y el monto real
//      (gas_gastos.fijo_id apunta a su gasto fijo).
//      Frecuencia en meses: 1 mensual, 2 bimestral, 3 trimestral, 6 semestral,
//      12 anual. "desde_mes" es el primer mes en que toca pagarlo; vuelve a tocar
//      cada <frecuencia> meses (un anual de marzo aparece cada marzo).
//    · cpe_id: reservado para vincularlo con el comprobante de SUNAT cuando se
//      importen los comprobantes recibidos desde Contabilidad (2.ª etapa).
//
//  Categorías: "en_resultado" indica si cuenta como gasto en el estado de
//  resultados. Retiros de socios o pagos de préstamos son salidas de dinero
//  (flujo de caja) pero no gasto.
//
//  Datos en la base del PORTAL (tablas gas_*). El ERP solo se lee.
//  Permiso: módulo 'gastos' (la planilla es información sensible).
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel } = require('./comunes');

const esFecha = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z'));
const esMes = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const recortar = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const empresaValida = v => EMPRESAS_BI[parseInt(v, 10)] ? parseInt(v, 10) : null;
const r2 = n => Math.round((+n || 0) * 100) / 100;
const ultimoDia = mes => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };

const CATEGORIAS_INICIALES = [
  // [nombre, en_resultado, fijo_sugerido]
  ['Planilla y sueldos', 1, 1],
  ['Honorarios (recibos por honorarios)', 1, 0],
  ['Alquiler', 1, 1],
  ['Servicios (luz, agua, internet, teléfono)', 1, 1],
  ['Fletes y envíos', 1, 0],
  ['Comisiones bancarias y pasarelas', 1, 0],
  ['Marketing y publicidad', 1, 0],
  ['Software y suscripciones', 1, 1],
  ['Contabilidad y legal', 1, 1],
  ['Impuestos y tributos', 1, 0],
  ['Útiles, oficina e insumos', 1, 0],
  ['Mantenimiento y reparaciones', 1, 0],
  ['Movilidad y viáticos', 1, 0],
  ['Otros gastos', 1, 0],
  ['Retiro de socios', 0, 0],
  ['Pago de préstamos', 0, 0],
];
const FRECUENCIAS = [1, 2, 3, 6, 12];
const difMeses = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const sumarMeses = (mes, n) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 7); };
// ¿Le toca pagarse a este gasto fijo en el mes dado?
const tocaEnMes = (f, mes) => { const d = difMeses(f.desde_mes, mes); return d >= 0 && d % (+f.frecuencia || 1) === 0; };
// Compras de MERCADERÍA (solo lectura, del ERP): entradas de stock con código
// SUNAT 02 (compra) o 18 (importación), valorizadas al costo del lote. Mismo
// criterio que la métrica "Compras" de Ventas e ingresos (modulos/ventas-bi.js).
const CODIGOS_COMPRA = ['02', '18'];
// Estados de venta válidos (mismo criterio que index.js: VV)
const VV_SQL = "('paid','confirmed','pending_payment')";
const REF_ENTRADA = 'App\\Models\\StockEntry';
// Fecha de hoy en Lima (UTC-5, sin horario de verano)
const hoyLima = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const finDeMes = mes => mes + '-' + String(ultimoDia(mes)).padStart(2, '0');
// Tarjeta de crédito: una compra del día <= corte entra al estado de cuenta de ese
// mes; después del corte, al del mes siguiente. El estado se paga a fin del mes
// del corte + pago_meses (0 = ese mismo fin de mes, 1 = fin del mes siguiente).
// Ej. corte 11, pago_meses 0: compra 05/10 → 31/10; compra 13/10 → 30/11.
function fechaPagoTarjeta(fecha, corte, pagoMeses) {
  const mes = fecha.slice(0, 7), d = +fecha.slice(8, 10);
  const mesCierre = d <= (+corte || 31) ? mes : sumarMeses(mes, 1);
  return finDeMes(sumarMeses(mesCierre, +pagoMeses || 0));
}
// Medio de pago por defecto de la mercadería cuando no se marcó: Christopher
// (empresa 2) compra con su tarjeta principal; Diseños compra al contado.
const MERC_TARJETA_POR_DEFECTO = { 2: true };
const TIPOS_COMPROBANTE = ['factura', 'boleta', 'recibo_honorarios', 'ticket', 'recibo', 'ninguno'];

module.exports = function registrarGastos({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mGas = requiereModulo('gastos');
  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next()
    : res.status(403).json({ error: 'Solo el administrador maestro puede cambiar categorías y cuentas' });
  const usuarioDe = req => (req.admin && req.admin.usuario) || 'admin';

  // ── Tablas (se crean la primera vez) ──────────────────────────────────────
  let _listo = null;
  function prepararTablas() {
    if (_listo) return _listo;
    _listo = (async () => {
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_categorias (
          id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          nombre VARCHAR(80) NOT NULL,
          en_resultado TINYINT(1) NOT NULL DEFAULT 1,
          fijo_sugerido TINYINT(1) NOT NULL DEFAULT 0,
          activo TINYINT(1) NOT NULL DEFAULT 1,
          orden SMALLINT NOT NULL DEFAULT 0,
          UNIQUE KEY (nombre)
        )`);
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_cuentas (
          id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          nombre VARCHAR(80) NOT NULL,
          company_id TINYINT UNSIGNED NOT NULL,
          tipo VARCHAR(20) NOT NULL DEFAULT 'efectivo',
          activo TINYINT(1) NOT NULL DEFAULT 1,
          UNIQUE KEY (nombre)
        )`);
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_gastos (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          fecha DATE NOT NULL,
          company_id TINYINT UNSIGNED NOT NULL,
          cuenta_ref VARCHAR(20) NOT NULL,
          cuenta_nombre VARCHAR(120) NOT NULL DEFAULT '',
          cuenta_company_id TINYINT UNSIGNED NULL,
          categoria_id SMALLINT UNSIGNED NOT NULL,
          proveedor VARCHAR(120) NOT NULL DEFAULT '',
          ruc VARCHAR(11) NOT NULL DEFAULT '',
          descripcion VARCHAR(255) NOT NULL DEFAULT '',
          moneda CHAR(3) NOT NULL DEFAULT 'PEN',
          monto DECIMAL(12,2) NOT NULL,
          tipo_cambio DECIMAL(8,4) NULL,
          monto_pen DECIMAL(12,2) NOT NULL,
          comp_tipo VARCHAR(20) NOT NULL DEFAULT 'ninguno',
          comp_numero VARCHAR(30) NOT NULL DEFAULT '',
          fijo TINYINT(1) NOT NULL DEFAULT 0,
          cpe_id INT UNSIGNED NULL,
          creado_por VARCHAR(60) NOT NULL DEFAULT '',
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          actualizado_por VARCHAR(60) NULL,
          actualizado_en TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
          borrado_en DATETIME NULL,
          borrado_por VARCHAR(60) NULL,
          INDEX (fecha), INDEX (company_id, fecha), INDEX (categoria_id), INDEX (cuenta_ref)
        )`);
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_fijos (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          nombre VARCHAR(120) NOT NULL,
          company_id TINYINT UNSIGNED NOT NULL,
          categoria_id SMALLINT UNSIGNED NOT NULL,
          proveedor VARCHAR(120) NOT NULL DEFAULT '',
          ruc VARCHAR(11) NOT NULL DEFAULT '',
          moneda CHAR(3) NOT NULL DEFAULT 'PEN',
          monto DECIMAL(12,2) NOT NULL,
          dia TINYINT UNSIGNED NOT NULL DEFAULT 1,
          frecuencia TINYINT UNSIGNED NOT NULL DEFAULT 1,
          cuenta_ref VARCHAR(20) NULL,
          desde_mes CHAR(7) NOT NULL,
          activo TINYINT(1) NOT NULL DEFAULT 1,
          creado_por VARCHAR(60) NOT NULL DEFAULT '',
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      // Tarjetas de crédito = cuentas propias tipo 'tarjeta' con límite, corte y pago
      for (const col of ['limite DECIMAL(12,2) NULL', 'corte_dia TINYINT UNSIGNED NULL', 'pago_meses TINYINT UNSIGNED NULL']) {
        try { await portalPool.query(`ALTER TABLE gas_cuentas ADD COLUMN ${col}`); }
        catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
      }
      // Saldos anotados por cuenta y fecha (foto del dinero disponible)
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_saldos (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          fecha DATE NOT NULL,
          cuenta_ref VARCHAR(20) NOT NULL,
          company_id TINYINT UNSIGNED NULL,
          monto DECIMAL(14,2) NOT NULL,
          creado_por VARCHAR(60) NOT NULL DEFAULT '',
          creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY (fecha, cuenta_ref)
        )`);
      // Para tarjetas: monto = deuda total anotada; por_pagar = lo que vence en el
      // próximo pago (estado de cuenta) y fecha_pago = cuándo vence
      for (const col of ['por_pagar DECIMAL(14,2) NULL', 'fecha_pago DATE NULL']) {
        try { await portalPool.query(`ALTER TABLE gas_saldos ADD COLUMN ${col}`); }
        catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
      }
      // Con qué se pagó cada entrada de mercadería del ERP (contado o tarjeta)
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS gas_entrada_pago (
          stock_entry_id INT UNSIGNED PRIMARY KEY,
          metodo VARCHAR(10) NOT NULL DEFAULT 'contado',
          cuenta_ref VARCHAR(20) NULL,
          actualizado_por VARCHAR(60) NOT NULL DEFAULT '',
          actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
      // Columna nueva en gas_gastos (instalaciones anteriores no la tienen)
      try { await portalPool.query(`ALTER TABLE gas_gastos ADD COLUMN fijo_id INT UNSIGNED NULL AFTER fijo, ADD INDEX (fijo_id)`); }
      catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
      const [[{ n }]] = await portalPool.query(`SELECT COUNT(*) AS n FROM gas_categorias`);
      if (!n) {
        await portalPool.query(`INSERT INTO gas_categorias (nombre, en_resultado, fijo_sugerido, orden) VALUES ?`,
          [CATEGORIAS_INICIALES.map((c, i) => [c[0], c[1], c[2], i + 1])]);
      }
      const [[{ c }]] = await portalPool.query(`SELECT COUNT(*) AS c FROM gas_cuentas`);
      if (!c) {
        await portalPool.query(`INSERT INTO gas_cuentas (nombre, company_id, tipo) VALUES ?`,
          [Object.entries(EMPRESAS_BI).map(([id, nom]) => [`Efectivo ${nom.split(' ')[0]}`, +id, 'efectivo'])]);
      }
    })().catch(e => { _listo = null; throw e; });
    return _listo;
  }

  // ── Cuentas: ERP (bancos) + propias (efectivo, tarjetas…) ─────────────────
  // cuenta_ref: 'ba:<id ERP>' o 'gc:<id gas_cuentas>'
  async function listarCuentas(incluirInactivas) {
    await prepararTablas();
    let erp = [];
    try {
      const [rows] = await prodPool.query(`
        SELECT ba.id, ba.account_number, banco.name AS banco, ba.party_id
        FROM bank_accounts ba
        LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
        ORDER BY ba.party_id, banco.name, ba.account_number`);
      erp = rows.map(r => ({
        ref: 'ba:' + r.id, tipo: 'banco', origen: 'erp',
        nombre: `${r.banco || 'Banco'} ${r.account_number || ''}`.trim(),
        company_id: EMPRESAS_BI[r.party_id] ? +r.party_id : null, activo: 1
      }));
    } catch (e) { /* si el ERP no responde, al menos las cuentas propias */ }
    const [propias] = await portalPool.query(
      `SELECT id, nombre, company_id, tipo, activo, limite, corte_dia, pago_meses FROM gas_cuentas ${incluirInactivas ? '' : 'WHERE activo = 1'} ORDER BY company_id, nombre`);
    return [...erp, ...propias.map(r => ({ ref: 'gc:' + r.id, id: r.id, tipo: r.tipo, origen: 'portal',
      nombre: r.nombre, company_id: +r.company_id, activo: +r.activo,
      ...(r.tipo === 'tarjeta' ? { limite: r.limite == null ? null : +r.limite, corte_dia: r.corte_dia == null ? 11 : +r.corte_dia,
        pago_meses: r.pago_meses == null ? 0 : +r.pago_meses } : {}) }))];
  }

  app.get('/api/gastos/opciones', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const [cats] = await portalPool.query(`SELECT id, nombre, en_resultado, fijo_sugerido, activo FROM gas_categorias ORDER BY activo DESC, orden, nombre`);
      res.json({
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })),
        cuentas: await listarCuentas(true),
        categorias: cats,
        tipos_comprobante: TIPOS_COMPROBANTE,
        maestro: !!(req.admin && req.admin.maestro)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Validación común para crear/editar ────────────────────────────────────
  async function validarGasto(b) {
    const err = m => { const e = new Error(m); e.status = 400; throw e; };
    if (!esFecha(b.fecha)) err('Fecha inválida');
    const company_id = empresaValida(b.company_id); if (!company_id) err('Elige la empresa del gasto');
    const cuentas = await listarCuentas(true);
    const cuenta = cuentas.find(c => c.ref === b.cuenta_ref); if (!cuenta) err('Elige la cuenta de donde salió el dinero');
    const [[cat]] = await portalPool.query(`SELECT id FROM gas_categorias WHERE id = ?`, [parseInt(b.categoria_id, 10) || 0]);
    if (!cat) err('Elige una categoría');
    const moneda = b.moneda === 'USD' ? 'USD' : 'PEN';
    const monto = r2(b.monto); if (!(monto > 0)) err('El monto debe ser mayor a 0');
    let tipo_cambio = null, monto_pen = monto;
    if (moneda === 'USD') {
      tipo_cambio = Math.round((+b.tipo_cambio || 0) * 10000) / 10000;
      if (!(tipo_cambio > 0 && tipo_cambio < 20)) err('Pon el tipo de cambio del día del pago');
      monto_pen = r2(monto * tipo_cambio);
    }
    const ruc = recortar(b.ruc, 11).replace(/\D/g, '');
    if (ruc && ruc.length !== 11 && ruc.length !== 8) err('El RUC debe tener 11 dígitos (o DNI de 8)');
    const comp_tipo = TIPOS_COMPROBANTE.includes(b.comp_tipo) ? b.comp_tipo : 'ninguno';
    let fijo_id = null;
    if (b.fijo_id) {
      const [[f]] = await portalPool.query(`SELECT id FROM gas_fijos WHERE id = ?`, [parseInt(b.fijo_id, 10) || 0]);
      if (!f) err('El gasto fijo no existe');
      fijo_id = f.id;
    }
    return {
      fecha: b.fecha, company_id, cuenta_ref: cuenta.ref, cuenta_nombre: cuenta.nombre,
      cuenta_company_id: cuenta.company_id, categoria_id: cat.id,
      proveedor: recortar(b.proveedor, 120), ruc, descripcion: recortar(b.descripcion, 255),
      moneda, monto, tipo_cambio, monto_pen, comp_tipo,
      comp_numero: comp_tipo === 'ninguno' ? '' : recortar(b.comp_numero, 30).toUpperCase(),
      fijo: fijo_id || b.fijo ? 1 : 0, fijo_id
    };
  }

  // ── Consulta con filtros (lista + Excel + resumen) ────────────────────────
  function filtros(q) {
    const w = ['g.borrado_en IS NULL'], p = [];
    let desde = q.desde, hasta = q.hasta;
    if (esMes(q.mes)) { desde = q.mes + '-01'; hasta = q.mes + '-' + ultimoDia(q.mes); }
    if (esFecha(desde)) { w.push('g.fecha >= ?'); p.push(desde); }
    if (esFecha(hasta)) { w.push('g.fecha <= ?'); p.push(hasta); }
    const emp = empresaValida(q.empresa); if (emp) { w.push('g.company_id = ?'); p.push(emp); }
    if (q.cuenta) { w.push('g.cuenta_ref = ?'); p.push(String(q.cuenta).slice(0, 20)); }
    if (q.categoria) { w.push('g.categoria_id = ?'); p.push(parseInt(q.categoria, 10) || 0); }
    if (q.fijo === '1') w.push('g.fijo = 1');
    if (q.entre === '1') w.push('g.cuenta_company_id IS NOT NULL AND g.cuenta_company_id <> g.company_id');
    if (q.q) {
      const t = '%' + recortar(q.q, 60) + '%';
      w.push('(g.proveedor LIKE ? OR g.descripcion LIKE ? OR g.ruc LIKE ? OR g.comp_numero LIKE ?)'); p.push(t, t, t, t);
    }
    return { where: w.join(' AND '), params: p, desde: esFecha(desde) ? desde : null, hasta: esFecha(hasta) ? hasta : null, empresa: emp };
  }
  const SELECT_GASTO = `
    SELECT g.id, DATE_FORMAT(g.fecha, '%Y-%m-%d') AS fecha, g.company_id, g.cuenta_ref, g.cuenta_nombre, g.cuenta_company_id,
      g.categoria_id, c.nombre AS categoria, c.en_resultado, g.proveedor, g.ruc, g.descripcion, g.moneda, g.monto,
      g.tipo_cambio, g.monto_pen, g.comp_tipo, g.comp_numero, g.fijo, g.fijo_id, g.cpe_id,
      g.creado_por, g.creado_en, g.actualizado_por, g.actualizado_en
    FROM gas_gastos g LEFT JOIN gas_categorias c ON c.id = g.categoria_id`;

  async function obtenerGastos(q) {
    await prepararTablas();
    const f = filtros(q);
    const [rows] = await portalPool.query(`${SELECT_GASTO} WHERE ${f.where} ORDER BY g.fecha DESC, g.id DESC LIMIT 5000`, f.params);
    return { f, gastos: rows.map(r => ({ ...r, monto: +r.monto, monto_pen: +r.monto_pen, tipo_cambio: r.tipo_cambio == null ? null : +r.tipo_cambio,
      en_resultado: r.en_resultado == null ? 1 : +r.en_resultado, fijo: +r.fijo })) };
  }

  function resumir(gastos) {
    const tot = { total: 0, en_resultado: 0, no_resultado: 0, fijos: 0, n: gastos.length };
    const porEmpresa = {}, porCategoria = {}, porCuenta = {};
    const entre = {}; // "pagadora>beneficiaria" → monto
    gastos.forEach(g => {
      const m = g.monto_pen;
      tot.total += m;
      if (g.en_resultado) tot.en_resultado += m; else tot.no_resultado += m;
      if (g.fijo) tot.fijos += m;
      porEmpresa[g.company_id] = (porEmpresa[g.company_id] || 0) + m;
      const kc = g.categoria_id; const c = porCategoria[kc] = porCategoria[kc] || { categoria_id: kc, categoria: g.categoria || '(sin categoría)', en_resultado: g.en_resultado, total: 0, n: 0, por_empresa: {} };
      c.total += m; c.n++; c.por_empresa[g.company_id] = (c.por_empresa[g.company_id] || 0) + m;
      const cu = porCuenta[g.cuenta_ref] = porCuenta[g.cuenta_ref] || { cuenta_ref: g.cuenta_ref, cuenta: g.cuenta_nombre, company_id: g.cuenta_company_id, total: 0, n: 0 };
      cu.total += m; cu.n++;
      if (g.cuenta_company_id && g.cuenta_company_id !== g.company_id) {
        const k = g.cuenta_company_id + '>' + g.company_id; entre[k] = (entre[k] || 0) + m;
      }
    });
    Object.keys(tot).forEach(k => { if (k !== 'n') tot[k] = r2(tot[k]); });
    return {
      totales: tot,
      por_empresa: Object.entries(porEmpresa).map(([id, total]) => ({ company_id: +id, total: r2(total) })),
      por_categoria: Object.values(porCategoria).map(c => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
      por_cuenta: Object.values(porCuenta).map(c => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
      // Gastos de una empresa pagados con la cuenta de la otra: la beneficiaria le debe a la pagadora
      entre_empresas: Object.entries(entre).map(([k, total]) => { const [paga, de] = k.split('>').map(Number); return { pagadora: paga, beneficiaria: de, total: r2(total) }; })
    };
  }

  app.get('/api/gastos', authAdmin, mGas, async (req, res) => {
    try {
      const { f, gastos } = await obtenerGastos(req.query);
      res.json({ desde: f.desde, hasta: f.hasta, gastos, resumen: resumir(gastos) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Totales por mes y empresa (para la tabla de 12 meses y, luego, "Resultado")
  // ── Compras de mercadería (entradas de stock del ERP, solo lectura) ─────────
  // Las columnas opcionales de stock_entries (proveedor, ref. de importación)
  // se detectan una vez: si no existen, la consulta funciona igual sin ellas.
  let _colsEntradas = null;
  async function colsEntradas() {
    if (_colsEntradas) return _colsEntradas;
    try { const [c] = await prodPool.query(`SHOW COLUMNS FROM stock_entries`); _colsEntradas = new Set(c.map(x => x.Field)); }
    catch (e) { _colsEntradas = new Set(); }
    return _colsEntradas;
  }
  const LOTE_DE_ENTRADA = `LEFT JOIN stock_batches sb ON sb.id = (
      SELECT b.id FROM stock_batches b
      WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
      ORDER BY b.id LIMIT 1)`;

  app.get('/api/gastos/mercaderia', authAdmin, mGas, async (req, res) => {
    try {
      const f = filtros(req.query);
      if (!f.desde || !f.hasta) return res.status(400).json({ error: 'Elige el mes o el rango de fechas' });
      const cols = await colsEntradas();
      const colProv = ['supplier_id', 'provider_id', 'party_id'].find(c => cols.has(c));
      const selImp = cols.has('importacion_ref') ? 'se.importacion_ref' : `''`;
      const selProv = colProv ? `COALESCE(NULLIF(TRIM(pr.business_name),''), TRIM(CONCAT(COALESCE(pr.first_name,''),' ',COALESCE(pr.last_name,''))))` : `''`;
      const joinProv = colProv ? `LEFT JOIN parties pr ON pr.id = se.${colProv}` : '';
      const extraGroup = (cols.has('importacion_ref') ? ', se.importacion_ref' : '') + (colProv ? ', pr.id, pr.business_name, pr.first_name, pr.last_name' : '');
      const fe = f.empresa ? `AND sb.company_id = ${f.empresa}` : '';
      const p = [REF_ENTRADA, f.desde, f.hasta + ' 23:59:59'];
      const [entradas] = await prodPool.query(`
        SELECT se.id, DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha, se.operation_type_code AS codigo,
          COALESCE(se.reference_number, '') AS documento, ${selImp} AS importacion, ${selProv} AS proveedor,
          sb.company_id, COUNT(DISTINCT sm.product_variation_id) AS productos,
          SUM(ABS(sm.quantity)) AS unidades, COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS total,
          SUM(CASE WHEN sb.cost_price IS NULL OR sb.cost_price = 0 THEN 1 ELSE 0 END) AS sin_costo
        FROM stock_movements sm
        JOIN stock_entries se ON se.id = sm.reference_id
        ${LOTE_DE_ENTRADA}
        ${joinProv}
        WHERE sm.reference_type = ? AND sm.movement_date BETWEEN ? AND ?
          AND se.operation_type_code IN (?) ${fe}
        GROUP BY se.id, se.operation_type_code, se.reference_number, sb.company_id${extraGroup}
        ORDER BY fecha DESC, se.id DESC`, [...p, CODIGOS_COMPRA]);
      // Otras entradas del período que NO son compra (saldo inicial, devoluciones…)
      const [otras] = await prodPool.query(`
        SELECT COALESCE(se.operation_type_code, '(sin código)') AS codigo, COUNT(DISTINCT se.id) AS n,
          COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS total
        FROM stock_movements sm
        JOIN stock_entries se ON se.id = sm.reference_id
        ${LOTE_DE_ENTRADA}
        WHERE sm.reference_type = ? AND sm.movement_date BETWEEN ? AND ?
          AND (se.operation_type_code IS NULL OR se.operation_type_code NOT IN (?)) ${fe}
        GROUP BY codigo ORDER BY total DESC`, [...p, CODIGOS_COMPRA]);
      const cuentas = await listarCuentas(true);
      const met = await metodosEntradas(entradas.map(e => e.id));
      const lista = entradas.map(e => {
        const cid = e.company_id == null ? null : +e.company_id;
        const pago = resolverPago(met[e.id], cid, cuentas, e.fecha);
        return { ...e, company_id: cid, productos: +e.productos, unidades: +e.unidades, total: r2(e.total), sin_costo: +e.sin_costo, pago };
      });
      const porEmp = {};
      lista.forEach(e => { const k = e.company_id || 0; porEmp[k] = r2((porEmp[k] || 0) + e.total); });
      res.json({ desde: f.desde, hasta: f.hasta, entradas: lista, total: r2(lista.reduce((a, e) => a + e.total, 0)),
        por_empresa: porEmp, codigos_compra: CODIGOS_COMPRA,
        tarjetas: cuentas.filter(c => c.tipo === 'tarjeta' && c.activo).map(c => ({ ref: c.ref, nombre: c.nombre, company_id: c.company_id })),
        otras: otras.map(o => ({ codigo: o.codigo, n: +o.n, total: r2(o.total) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Detalle de una entrada: productos, cantidad y costo
  app.get('/api/gastos/mercaderia/:id', authAdmin, mGas, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT pv.sku, p.name AS producto, pv.name AS variacion, SUM(ABS(sm.quantity)) AS cantidad,
          MAX(sb.cost_price) AS costo_unit, COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS subtotal
        FROM stock_movements sm
        JOIN stock_entries se ON se.id = sm.reference_id
        JOIN product_variations pv ON pv.id = sm.product_variation_id
        JOIN products p ON p.id = pv.product_id
        ${LOTE_DE_ENTRADA}
        WHERE sm.reference_type = ? AND se.id = ?
        GROUP BY pv.id, pv.sku, p.name, pv.name ORDER BY subtotal DESC`, [REF_ENTRADA, parseInt(req.params.id, 10) || 0]);
      res.json(rows.map(r => ({ ...r, cantidad: +r.cantidad, costo_unit: r.costo_unit == null ? null : +r.costo_unit, subtotal: r2(r.subtotal) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Medio de pago de la mercadería y tarjetas de crédito ───────────────────
  async function metodosEntradas(ids) {
    await prepararTablas();
    if (!ids.length) return {};
    const [rows] = await portalPool.query(`SELECT stock_entry_id, metodo, cuenta_ref FROM gas_entrada_pago WHERE stock_entry_id IN (?)`, [ids]);
    return Object.fromEntries(rows.map(r => [r.stock_entry_id, r]));
  }
  const tarjetasDe = (cuentas, cid) => cuentas.filter(c => c.tipo === 'tarjeta' && c.activo && (!cid || c.company_id === cid));
  const tarjetaPrincipal = (cuentas, cid) => tarjetasDe(cuentas, cid).sort((a, b) => (b.limite || 0) - (a.limite || 0))[0] || null;
  // Devuelve {metodo, cuenta_ref, tarjeta, fecha_pago, por_defecto}
  function resolverPago(marcado, cid, cuentas, fecha) {
    let metodo, ref, porDefecto = false;
    if (marcado) { metodo = marcado.metodo; ref = marcado.cuenta_ref; }
    else {
      porDefecto = true;
      const t = MERC_TARJETA_POR_DEFECTO[cid] ? tarjetaPrincipal(cuentas, cid) : null;
      metodo = t ? 'tarjeta' : 'contado'; ref = t ? t.ref : null;
    }
    const t = metodo === 'tarjeta' ? cuentas.find(c => c.ref === ref && c.tipo === 'tarjeta') : null;
    if (metodo === 'tarjeta' && !t) metodo = 'contado';
    return { metodo, cuenta_ref: t ? t.ref : null, tarjeta: t ? t.nombre : null, por_defecto: porDefecto,
      fecha_pago: t ? fechaPagoTarjeta(fecha, t.corte_dia, t.pago_meses) : fecha };
  }

  app.post('/api/gastos/mercaderia/:id/pago', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const id = parseInt(req.params.id, 10) || 0;
      const b = req.body || {};
      if (b.metodo === 'auto') { await portalPool.query(`DELETE FROM gas_entrada_pago WHERE stock_entry_id = ?`, [id]); return res.json({ ok: true }); }
      const metodo = b.metodo === 'tarjeta' ? 'tarjeta' : 'contado';
      let cuenta_ref = null;
      if (metodo === 'tarjeta') {
        const t = (await listarCuentas(true)).find(c => c.ref === b.cuenta_ref && c.tipo === 'tarjeta');
        if (!t) return res.status(400).json({ error: 'Elige la tarjeta' });
        cuenta_ref = t.ref;
      }
      await portalPool.query(`INSERT INTO gas_entrada_pago (stock_entry_id, metodo, cuenta_ref, actualizado_por) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE metodo = VALUES(metodo), cuenta_ref = VALUES(cuenta_ref), actualizado_por = VALUES(actualizado_por)`,
        [id, metodo, cuenta_ref, usuarioDe(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Entradas de mercadería (todas las empresas) con su medio y fecha de pago
  async function mercaderiaConPago({ desde, hasta }) {
    const [rows] = await prodPool.query(`
      SELECT se.id, DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha, sb.company_id,
        COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS total
      FROM stock_movements sm
      JOIN stock_entries se ON se.id = sm.reference_id
      ${LOTE_DE_ENTRADA}
      WHERE sm.reference_type = ? AND sm.movement_date BETWEEN ? AND ? AND se.operation_type_code IN (?)
      GROUP BY se.id, sb.company_id`, [REF_ENTRADA, desde, hasta + ' 23:59:59', CODIGOS_COMPRA]);
    const cuentas = await listarCuentas(true);
    const met = await metodosEntradas([...new Set(rows.map(r => r.id))]);
    return rows.map(r => { const cid = r.company_id == null ? null : +r.company_id;
      return { id: r.id, fecha: r.fecha, company_id: cid, total: r2(r.total), ...resolverPago(met[r.id], cid, cuentas, r.fecha) }; });
  }
  // Gastos pagados con tarjeta (cuenta propia tipo tarjeta) con su fecha de pago real
  async function gastosConTarjeta({ desde, hasta }) {
    const tarjetas = (await listarCuentas(true)).filter(c => c.tipo === 'tarjeta');
    if (!tarjetas.length) return [];
    const [rows] = await portalPool.query(`
      SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, company_id, cuenta_ref, cuenta_company_id, monto_pen
      FROM gas_gastos WHERE borrado_en IS NULL AND fecha BETWEEN ? AND ? AND cuenta_ref IN (?)`,
      [desde, hasta, tarjetas.map(t => t.ref)]);
    return rows.map(r => { const t = tarjetas.find(x => x.ref === r.cuenta_ref);
      return { ...r, monto_pen: +r.monto_pen, fecha_pago: fechaPagoTarjeta(r.fecha, t.corte_dia, t.pago_meses), tarjeta: t.nombre }; });
  }

  // ── Saldos de las cuentas (foto del dinero disponible en una fecha) ─────────
  app.get('/api/gastos/saldos', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const cuentas = await listarCuentas(false);
      const [ult] = await portalPool.query(`
        SELECT s.cuenta_ref, DATE_FORMAT(s.fecha, '%Y-%m-%d') AS fecha, s.monto, s.por_pagar, DATE_FORMAT(s.fecha_pago, '%Y-%m-%d') AS fecha_pago FROM gas_saldos s
        JOIN (SELECT cuenta_ref, MAX(fecha) AS f FROM gas_saldos GROUP BY cuenta_ref) m ON m.cuenta_ref = s.cuenta_ref AND m.f = s.fecha`);
      const [hist] = await portalPool.query(`
        SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, company_id, SUM(monto) AS total, COUNT(*) AS cuentas
        FROM gas_saldos WHERE fecha_pago IS NULL AND por_pagar IS NULL GROUP BY fecha, company_id ORDER BY fecha DESC LIMIT 40`);
      const u = Object.fromEntries(ult.map(r => [r.cuenta_ref, { fecha: r.fecha, monto: +r.monto,
        por_pagar: r.por_pagar == null ? null : +r.por_pagar, fecha_pago: r.fecha_pago }]));
      res.json({ cuentas: cuentas.map(c => ({ ...c, ultimo: u[c.ref] || null })),
        historial: hist.map(h => ({ ...h, total: r2(h.total) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/gastos/saldos', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const { fecha, saldos } = req.body || {};
      if (!esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida' });
      if (fecha > hoyLima()) return res.status(400).json({ error: 'La fecha no puede ser futura' });
      const cuentas = await listarCuentas(true);
      let n = 0;
      for (const x of Array.isArray(saldos) ? saldos : []) {
        const c = cuentas.find(k => k.ref === x.cuenta_ref);
        if (!c || x.monto === '' || x.monto == null || !isFinite(+x.monto)) continue;
        let porPagar = null, fechaPago = null;
        if (c.tipo === 'tarjeta') {
          // Deuda de la tarjeta: cuánto vence en el próximo pago y cuándo
          const deuda = r2(Math.abs(+x.monto));
          porPagar = x.por_pagar === '' || x.por_pagar == null ? deuda : r2(Math.abs(+x.por_pagar));
          if (porPagar > deuda) return res.status(400).json({ error: `${c.nombre}: el próximo pago no puede ser mayor que la deuda total` });
          fechaPago = esFecha(x.fecha_pago) ? x.fecha_pago : finDeMes(fecha.slice(0, 7));
          if (fechaPago < fecha) return res.status(400).json({ error: `${c.nombre}: la fecha del próximo pago no puede ser anterior a la fecha del saldo` });
          x.monto = deuda;
        }
        await portalPool.query(`INSERT INTO gas_saldos (fecha, cuenta_ref, company_id, monto, por_pagar, fecha_pago, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE monto = VALUES(monto), por_pagar = VALUES(por_pagar), fecha_pago = VALUES(fecha_pago),
            company_id = VALUES(company_id), creado_por = VALUES(creado_por)`,
          [fecha, c.ref, c.company_id, r2(x.monto), porPagar, fechaPago, usuarioDe(req)]);
        n++;
      }
      if (!n) return res.status(400).json({ error: 'Pon el saldo de al menos una cuenta' });
      res.json({ ok: true, guardados: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cargos de tarjeta de una empresa (mercadería + gastos con tarjeta).
  // Si se anotó la deuda de una tarjeta, esa deuda reemplaza a todo lo cargado
  // hasta esa fecha: vence "por_pagar" en "fecha_pago" y el resto en el pago
  // siguiente; solo se suman los cargos posteriores a la fecha del saldo.
  function cargosDeTarjetas(cid, cuentas, ult, merc, gasT) {
    const tarjetas = tarjetasDe(cuentas, cid);
    const tRefs = new Set(tarjetas.map(t => t.ref));
    const deudaTarjeta = {};
    ult.filter(u => tRefs.has(u.cuenta_ref)).forEach(u => { deudaTarjeta[u.cuenta_ref] = u; });
    const despuesDeDeuda = c => !deudaTarjeta[c.ref] || c.fecha > deudaTarjeta[c.ref].fecha;
    const cargos = [
      ...merc.filter(m => m.metodo === 'tarjeta' && tRefs.has(m.cuenta_ref)).map(m => ({ fecha: m.fecha, fecha_pago: m.fecha_pago, monto: m.total, ref: m.cuenta_ref, tipo: 'mercadería' })),
      ...gasT.filter(g => tRefs.has(g.cuenta_ref)).map(g => ({ fecha: g.fecha, fecha_pago: g.fecha_pago, monto: g.monto_pen, ref: g.cuenta_ref, tipo: 'gasto' }))
    ].filter(despuesDeDeuda);
    Object.values(deudaTarjeta).forEach(u => {
      const deuda = +u.monto, prox = u.por_pagar == null ? deuda : +u.por_pagar;
      const fp = u.fecha_pago || finDeMes(u.fecha.slice(0, 7));
      if (prox > 0) cargos.push({ fecha: u.fecha, fecha_pago: fp, monto: r2(prox), ref: u.cuenta_ref, tipo: 'deuda anotada' });
      if (deuda - prox > 0) cargos.push({ fecha: u.fecha, fecha_pago: finDeMes(sumarMeses(fp.slice(0, 7), 1)), monto: r2(deuda - prox), ref: u.cuenta_ref, tipo: 'deuda anotada' });
    });
    return { tarjetas, tRefs, deudaTarjeta, cargos };
  }
  async function ultimosSaldos(hoy) {
    const [ult] = await portalPool.query(`
      SELECT s.cuenta_ref, DATE_FORMAT(s.fecha, '%Y-%m-%d') AS fecha, s.monto, s.por_pagar, DATE_FORMAT(s.fecha_pago, '%Y-%m-%d') AS fecha_pago FROM gas_saldos s
      JOIN (SELECT cuenta_ref, MAX(fecha) AS f FROM gas_saldos WHERE fecha <= ? GROUP BY cuenta_ref) m ON m.cuenta_ref = s.cuenta_ref AND m.f = s.fecha`, [hoy]);
    return ult;
  }

  // ── El mes en curso, día a día (para Rendimiento) ────────────────────────────
  // Ingresos (cobros) acumulados vs egresos acumulados en CAJA, y la proyección al
  // cierre del mes:
  //   ingreso proyectado = cobrado hasta hoy + promedio diario de los últimos 90
  //                        días × días que faltan
  //   egresos proyectados = salido hasta hoy + gastos fijos pendientes (en su día
  //                        de vencimiento) + pagos de tarjeta que vencen este mes
  //   te queda para comprar = ingreso proyectado − egresos proyectados
  // Egresos = gastos pagados (no los cargados a tarjeta) + mercadería al contado +
  // pagos de tarjeta (mercadería, gastos y deuda anotada) en su fecha de pago.
  async function mesEnCurso({ empresa }) {
    await prepararTablas();
    const hoy = hoyLima(), mes = hoy.slice(0, 7), fin = finDeMes(mes), ini = mes + '-01';
    const emps = empresaValida(empresa) ? [empresaValida(empresa)] : Object.keys(EMPRESAS_BI).map(Number);
    const enEmp = cid => emps.includes(+cid);
    const cuentas = await listarCuentas(true);
    const ult = await ultimosSaldos(hoy);
    const desdeCargos = sumarMeses(mes, -3) + '-01';
    const minFoto = ult.reduce((a, r) => r.fecha < a ? r.fecha : a, desdeCargos);
    const [merc, gasT] = await Promise.all([mercaderiaConPago({ desde: minFoto, hasta: fin }), gastosConTarjeta({ desde: minFoto, hasta: fin })]);
    const [[tc]] = await portalPool.query(`SELECT tipo_cambio FROM gas_gastos WHERE borrado_en IS NULL AND moneda = 'USD' AND tipo_cambio > 0 ORDER BY fecha DESC, id DESC LIMIT 1`);
    const tcUsd = tc ? +tc.tipo_cambio : null;
    const fijosMes = await fijosDelMes({ mes, emp: null });
    const listaEmp = emps.join(',');

    // Cobros por día del mes y promedio diario de los últimos 90 días
    const [cobDia] = await prodPool.query(`
      SELECT DATE_FORMAT(sp.paid_at, '%Y-%m-%d') AS dia, COALESCE(SUM(sp.amount), 0) AS t
      FROM sale_payments sp LEFT JOIN sales s ON s.id = sp.sale_id LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      WHERE sp.voided_at IS NULL AND sp.paid_at >= ? AND sp.paid_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND COALESCE(ba.party_id, s.company_id) IN (${listaEmp})
      GROUP BY dia`, [ini, hoy]);
    const [[prom]] = await prodPool.query(`
      SELECT COALESCE(SUM(sp.amount), 0) AS t FROM sale_payments sp
      LEFT JOIN sales s ON s.id = sp.sale_id LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      WHERE sp.voided_at IS NULL AND sp.paid_at >= DATE_SUB(?, INTERVAL 90 DAY) AND sp.paid_at < ?
        AND COALESCE(ba.party_id, s.company_id) IN (${listaEmp})`, [ini, ini]);
    const [[mesPas]] = await prodPool.query(`
      SELECT COALESCE(SUM(sp.amount), 0) AS t FROM sale_payments sp
      LEFT JOIN sales s ON s.id = sp.sale_id LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      WHERE sp.voided_at IS NULL AND sp.paid_at >= ? AND sp.paid_at < ?
        AND COALESCE(ba.party_id, s.company_id) IN (${listaEmp})`, [sumarMeses(mes, -1) + '-01', ini]);
    // Promedio diario: últimos 90 días antes de este mes (más estable que el ritmo de pocos días)
    const promDia = +prom.t / 90;

    // Egresos del mes por día
    const tarjetaRefs = new Set(cuentas.filter(c => c.tipo === 'tarjeta').map(c => c.ref));
    const [gas] = await portalPool.query(`
      SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS dia, cuenta_ref, SUM(monto_pen) AS t FROM gas_gastos
      WHERE borrado_en IS NULL AND fecha BETWEEN ? AND ? AND company_id IN (${listaEmp})
      GROUP BY dia, cuenta_ref`, [ini, fin]);
    const egr = {};   // dia → {gastos, mercaderia, tarjeta}
    const add = (dia, k, v) => { const e = egr[dia] = egr[dia] || { gastos: 0, mercaderia: 0, tarjeta: 0 }; e[k] += v; };
    gas.filter(g => !tarjetaRefs.has(g.cuenta_ref) && g.dia <= hoy).forEach(g => add(g.dia, 'gastos', +g.t));
    merc.filter(m => enEmp(m.company_id) && m.metodo === 'contado' && m.fecha >= ini && m.fecha <= hoy).forEach(m => add(m.fecha, 'mercaderia', m.total));
    const pendientes = [];   // egresos que faltan este mes
    for (const cid of emps) {
      const { cargos } = cargosDeTarjetas(cid, cuentas, ult, merc, gasT);
      cargos.filter(c => c.fecha_pago >= ini && c.fecha_pago <= fin).forEach(c => {
        if (c.fecha_pago <= hoy) add(c.fecha_pago, 'tarjeta', c.monto);
        else pendientes.push({ dia: c.fecha_pago, concepto: 'Pago de tarjeta', monto: c.monto });
      });
    }
    fijosMes.fijos.filter(f => enEmp(f.company_id) && f.activo && !f.pagado && !tarjetaRefs.has(f.cuenta_ref)).forEach(f => {
      const monto = f.moneda === 'USD' ? (tcUsd ? f.monto * tcUsd : 0) : f.monto;
      pendientes.push({ dia: f.vence < hoy ? hoy : f.vence, concepto: f.nombre, monto, vencido: f.vence < hoy });
    });

    // Series acumuladas por día
    const dias = [];
    for (let d = 1; d <= ultimoDia(mes); d++) dias.push(`${mes}-${String(d).padStart(2, '0')}`);
    const cobMap = Object.fromEntries(cobDia.map(r => [r.dia, +r.t]));
    let accI = 0, accE = 0, accIp = null, accEp = null;
    const serie = dias.map(dia => {
      const real = dia <= hoy;
      if (real) {
        accI += cobMap[dia] || 0;
        const e = egr[dia]; accE += e ? e.gastos + e.mercaderia + e.tarjeta : 0;
      }
      if (dia >= hoy) {
        if (accIp == null) { accIp = accI; accEp = accE; }
        else accIp += promDia;
        accEp += pendientes.filter(p => p.dia === dia).reduce((a, p) => a + p.monto, 0);
      }
      return { dia, ingresos: real ? r2(accI) : null, egresos: real ? r2(accE) : null,
        ingresos_proy: dia >= hoy ? r2(accIp) : null, egresos_proy: dia >= hoy ? r2(accEp) : null };
    });
    const ultimo = serie[serie.length - 1];
    const totEgr = Object.values(egr).reduce((a, e) => ({ gastos: a.gastos + e.gastos, mercaderia: a.mercaderia + e.mercaderia, tarjeta: a.tarjeta + e.tarjeta }), { gastos: 0, mercaderia: 0, tarjeta: 0 });
    return {
      hoy, mes, fin, dias_mes: dias.length, dia_hoy: +hoy.slice(8, 10), prom_dia: r2(promDia), mes_pasado: r2(mesPas.t),
      ingresos_hoy: r2(accI), egresos_hoy: r2(accE),
      egresos_detalle: { gastos: r2(totEgr.gastos), mercaderia: r2(totEgr.mercaderia), tarjeta: r2(totEgr.tarjeta) },
      ingresos_cierre: ultimo.ingresos_proy, egresos_cierre: ultimo.egresos_proy,
      queda_para_comprar: r2(ultimo.ingresos_proy - ultimo.egresos_proy),
      pendientes: pendientes.sort((a, b) => a.dia.localeCompare(b.dia)).map(p => ({ ...p, monto: r2(p.monto) })),
      serie
    };
  }

  // ── ¿Cuánto puedo comprar hoy? ──────────────────────────────────────────────
  // Por empresa:
  //   Saldo estimado hoy = saldos anotados (última foto de cada cuenta)
  //       + cobros que entraron a esas cuentas desde la foto (ERP)
  //       − gastos pagados desde esas cuentas desde la foto
  //       − mercadería al contado desde la foto (de la empresa)
  //       − pagos de tarjeta que vencieron desde la foto
  //   Comprometido hasta fin de mes = gastos fijos pendientes + tarjeta que vence este fin de mes
  //   Puedes comprar hoy (contado) = saldo estimado − comprometido
  //   Escenario "si cobras lo pendiente" = + ventas por cobrar (últimos 120 días)
  //   Tarjeta: línea disponible, pagos próximos y cuánto podrías cargar hoy para
  //   poder pagarlo en su fecha (saldo proyectado a esa fecha).
  app.get('/api/gastos/capacidad', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const hoy = hoyLima(), mes = hoy.slice(0, 7), fin = finDeMes(mes);
      const emps = empresaValida(req.query.empresa) ? [empresaValida(req.query.empresa)] : Object.keys(EMPRESAS_BI).map(Number);
      const cuentas = await listarCuentas(true);
      const ult = await ultimosSaldos(hoy);
      // Ventana amplia para cargos de tarjeta todavía no pagados (hasta 3 meses atrás)
      const desdeCargos = sumarMeses(mes, -3) + '-01';
      const minFoto = ult.reduce((a, r) => r.fecha < a ? r.fecha : a, desdeCargos);
      const [merc, gasT] = await Promise.all([mercaderiaConPago({ desde: minFoto, hasta: finDeMes(sumarMeses(mes, 1)) }),
        gastosConTarjeta({ desde: minFoto, hasta: finDeMes(sumarMeses(mes, 1)) })]);
      const [[tc]] = await portalPool.query(`SELECT tipo_cambio FROM gas_gastos WHERE borrado_en IS NULL AND moneda = 'USD' AND tipo_cambio > 0 ORDER BY fecha DESC, id DESC LIMIT 1`);
      const tcUsd = tc ? +tc.tipo_cambio : null;
      const [fijosMes, fijosSig] = await Promise.all([fijosDelMes({ mes, emp: null }), fijosDelMes({ mes: sumarMeses(mes, 1), emp: null })]);
      const enSoles = f => f.moneda === 'USD' ? (tcUsd ? f.monto * tcUsd : 0) : f.monto;

      const out = [];
      for (const cid of emps) {
        const ctas = cuentas.filter(c => c.company_id === cid && c.tipo !== 'tarjeta');
        const fotos = ctas.map(c => ({ c, f: ult.find(u => u.cuenta_ref === c.ref) })).filter(x => x.f);
        const { tarjetas, tRefs, deudaTarjeta, cargos } = cargosDeTarjetas(cid, cuentas, ult, merc, gasT);
        const fijosPend = fijosMes.fijos.filter(f => f.company_id === cid && f.activo && !f.pagado && !tRefs.has(f.cuenta_ref));
        const fijosPendTot = r2(fijosPend.reduce((a, f) => a + enSoles(f), 0));
        const fijosSigTot = r2(fijosSig.fijos.filter(f => f.company_id === cid && f.activo && !tRefs.has(f.cuenta_ref)).reduce((a, f) => a + enSoles(f), 0));
        const tarjetaEsteMes = r2(cargos.filter(c => c.fecha_pago >= hoy && c.fecha_pago <= fin).reduce((a, c) => a + c.monto, 0));

        // Ventas por cobrar (últimos 120 días) e ingreso promedio diario (últimos 90)
        const [[pc]] = await prodPool.query(`
          SELECT COALESCE(SUM(GREATEST(s.total - COALESCE(p.pagado, 0), 0)), 0) AS por_cobrar
          FROM sales s LEFT JOIN (SELECT sale_id, SUM(amount) AS pagado FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id) p ON p.sale_id = s.id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV_SQL} AND s.company_id = ? AND s.created_at >= DATE_SUB(?, INTERVAL 120 DAY)`, [cid, hoy]);
        const [[ip]] = await prodPool.query(`
          SELECT COALESCE(SUM(sp.amount), 0) AS cobrado FROM sale_payments sp
          LEFT JOIN sales s ON s.id = sp.sale_id LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
          WHERE sp.voided_at IS NULL AND COALESCE(ba.party_id, s.company_id) = ? AND sp.paid_at >= DATE_SUB(?, INTERVAL 90 DAY) AND sp.paid_at < ?`, [cid, hoy, hoy]);
        const porCobrar = r2(pc.por_cobrar), ingresoDia = r2(+ip.cobrado / 90);

        const r = { company_id: cid, empresa: EMPRESAS_BI[cid], hoy, fin_mes: fin, necesita_saldo: !fotos.length,
          cuentas_sin_saldo: ctas.filter(c => !fotos.find(x => x.c.ref === c.ref)).map(c => c.nombre),
          comprometido: { fijos: fijosPend.map(f => ({ nombre: f.nombre, vence: f.vence, monto: r2(enSoles(f)), usd: f.moneda === 'USD' })),
            fijos_total: fijosPendTot, tarjeta: tarjetaEsteMes, total: r2(fijosPendTot + tarjetaEsteMes) },
          por_cobrar: porCobrar, ingreso_dia: ingresoDia, fijos_usd_sin_tc: !tcUsd && fijosMes.fijos.some(f => f.moneda === 'USD') };

        if (fotos.length) {
          // Movimientos desde la foto de CADA cuenta
          let base = 0, cobros = 0, gastos = 0;
          for (const { c, f } of fotos) {
            base += +f.monto;
            if (c.origen === 'erp') {
              const [[x]] = await prodPool.query(`SELECT COALESCE(SUM(amount), 0) AS t FROM sale_payments
                WHERE voided_at IS NULL AND bank_account_id = ? AND paid_at >= DATE_ADD(?, INTERVAL 1 DAY) AND paid_at < DATE_ADD(?, INTERVAL 1 DAY)`,
                [c.ref.slice(3), f.fecha, hoy]);
              cobros += +x.t;
            }
            const [[g]] = await portalPool.query(`SELECT COALESCE(SUM(monto_pen), 0) AS t FROM gas_gastos
              WHERE borrado_en IS NULL AND cuenta_ref = ? AND fecha > ? AND fecha <= ?`, [c.ref, f.fecha, hoy]);
            gastos += +g.t;
          }
          // Mercadería al contado y pagos de tarjeta desde la foto más antigua de la empresa
          const desdeFoto = fotos.reduce((a, x) => x.f.fecha < a ? x.f.fecha : a, '9999');
          const mercContado = merc.filter(m => m.company_id === cid && m.metodo === 'contado' && m.fecha > desdeFoto && m.fecha <= hoy).reduce((a, m) => a + m.total, 0);
          const pagosTarjeta = cargos.filter(c => c.fecha_pago > desdeFoto && c.fecha_pago < hoy).reduce((a, c) => a + c.monto, 0);
          const estimado = base + cobros - gastos - mercContado - pagosTarjeta;
          r.saldo = { fecha_foto: desdeFoto, base: r2(base), cobros: r2(cobros), gastos: r2(gastos), merc_contado: r2(mercContado),
            pagos_tarjeta: r2(pagosTarjeta), estimado: r2(estimado),
            cuentas: fotos.map(({ c, f }) => ({ nombre: c.nombre, fecha: f.fecha, monto: +f.monto })) };
          r.puede_hoy = r2(estimado - r.comprometido.total);
          r.puede_con_cobros = r2(r.puede_hoy + porCobrar);
        }

        // Tarjetas: línea usada (cargos aún no pagados), próximos pagos y cuánto cargar hoy
        r.tarjetas = tarjetas.map(t => {
          const cs = cargos.filter(c => c.ref === t.ref);
          const usado = r2(cs.filter(c => c.fecha <= hoy && c.fecha_pago >= hoy).reduce((a, c) => a + c.monto, 0));
          const pagos = {};
          cs.filter(c => c.fecha_pago >= hoy).forEach(c => { pagos[c.fecha_pago] = r2((pagos[c.fecha_pago] || 0) + c.monto); });
          const pagoHoy = fechaPagoTarjeta(hoy, t.corte_dia, t.pago_meses);
          const du = deudaTarjeta[t.ref];
          const x = { ref: t.ref, nombre: t.nombre, limite: t.limite, corte_dia: t.corte_dia, pago_meses: t.pago_meses,
            deuda_anotada: du ? { fecha: du.fecha, monto: +du.monto, por_pagar: du.por_pagar == null ? +du.monto : +du.por_pagar, fecha_pago: du.fecha_pago } : null,
            usado, disponible: t.limite == null ? null : r2(t.limite - usado),
            proximos_pagos: Object.entries(pagos).sort().map(([fecha, monto]) => ({ fecha, monto })),
            compra_hoy_se_paga: pagoHoy };
          // Saldo proyectado a la fecha en que se pagaría una compra de hoy
          if (r.saldo) {
            const mesPago = pagoHoy.slice(0, 7);
            const fijosHasta = mesPago > mes ? fijosSigTot * Math.max(0, difMeses(mes, mesPago)) : 0;
            const tarjetaHasta = cargos.filter(c => c.fecha_pago >= hoy && c.fecha_pago <= pagoHoy).reduce((a, c) => a + c.monto, 0);
            const proy = r.saldo.estimado - fijosPendTot - fijosHasta - tarjetaHasta;
            const dias = Math.max(0, Math.round((new Date(pagoHoy) - new Date(hoy)) / 864e5));
            x.proyeccion = { fecha: pagoHoy, sin_ventas: r2(proy), con_ventas: r2(proy + porCobrar + ingresoDia * dias), dias,
              fijos_hasta: r2(fijosHasta), tarjeta_hasta: r2(tarjetaHasta) };
            const tope = v => r2(Math.max(0, x.disponible == null ? v : Math.min(v, x.disponible)));
            x.puedes_cargar = { sin_ventas: tope(proy), con_ventas: tope(x.proyeccion.con_ventas) };
          }
          return x;
        });
        out.push(r);
      }
      res.json({ hoy, empresas: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/gastos/mensual', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const hasta = esMes(req.query.hasta) ? req.query.hasta : new Date().toISOString().slice(0, 7);
      const [a, m] = hasta.split('-').map(Number);
      const ini = new Date(Date.UTC(a, m - 12, 1)).toISOString().slice(0, 10);
      const fin = hasta + '-' + ultimoDia(hasta);
      const emp = empresaValida(req.query.empresa);
      const [rows] = await portalPool.query(`
        SELECT DATE_FORMAT(g.fecha, '%Y-%m') AS mes, g.company_id, COALESCE(c.en_resultado, 1) AS en_resultado,
          SUM(g.monto_pen) AS total, SUM(CASE WHEN g.fijo = 1 THEN g.monto_pen ELSE 0 END) AS fijos
        FROM gas_gastos g LEFT JOIN gas_categorias c ON c.id = g.categoria_id
        WHERE g.borrado_en IS NULL AND g.fecha BETWEEN ? AND ? ${emp ? 'AND g.company_id = ' + emp : ''}
        GROUP BY mes, g.company_id, COALESCE(c.en_resultado, 1) ORDER BY mes`, [ini, fin]);
      res.json({ desde: ini.slice(0, 7), hasta, filas: rows.map(r => ({ ...r, total: r2(r.total), fijos: r2(r.fijos), en_resultado: +r.en_resultado })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/gastos', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const b = req.body || {};
      const g = await validarGasto(b);
      // "Repetir cada mes": crea el gasto fijo a partir de este pago y los enlaza
      if (b.crear_fijo && !g.fijo_id) {
        const [rf] = await portalPool.query(`INSERT INTO gas_fijos SET ?`, [{
          nombre: g.descripcion || g.proveedor || 'Gasto fijo', company_id: g.company_id, categoria_id: g.categoria_id,
          proveedor: g.proveedor, ruc: g.ruc, moneda: g.moneda, monto: g.monto, dia: +g.fecha.slice(8, 10),
          frecuencia: FRECUENCIAS.includes(+b.frecuencia) ? +b.frecuencia : 1,
          cuenta_ref: g.cuenta_ref, desde_mes: g.fecha.slice(0, 7), creado_por: usuarioDe(req) }]);
        g.fijo_id = rf.insertId; g.fijo = 1;
      }
      const [r] = await portalPool.query(`INSERT INTO gas_gastos SET ?`, [{ ...g, creado_por: usuarioDe(req) }]);
      res.json({ ok: true, id: r.insertId, fijo_id: g.fijo_id });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.put('/api/gastos/:id', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const id = parseInt(req.params.id, 10) || 0;
      const g = await validarGasto(req.body || {});
      const [r] = await portalPool.query(`UPDATE gas_gastos SET ?, actualizado_por = ? WHERE id = ? AND borrado_en IS NULL`, [g, usuarioDe(req), id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'El gasto no existe o fue eliminado' });
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Borrado lógico: queda quién y cuándo lo eliminó
  app.delete('/api/gastos/:id', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const [r] = await portalPool.query(`UPDATE gas_gastos SET borrado_en = NOW(), borrado_por = ? WHERE id = ? AND borrado_en IS NULL`,
        [usuarioDe(req), parseInt(req.params.id, 10) || 0]);
      if (!r.affectedRows) return res.status(404).json({ error: 'El gasto no existe o ya fue eliminado' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Gastos fijos ──────────────────────────────────────────────────────────
  // Lista de gastos fijos con su estado en el mes: pendiente o pagado (con la
  // cuenta, fecha y monto reales del pago).
  async function fijosDelMes({ mes, emp, todos }) {
      await prepararTablas();
      const [fijos] = await portalPool.query(`
        SELECT f.*, c.nombre AS categoria FROM gas_fijos f LEFT JOIN gas_categorias c ON c.id = f.categoria_id
        WHERE ${todos ? '1=1' : 'f.activo = 1 AND f.desde_mes <= ?'} ${emp ? 'AND f.company_id = ' + emp : ''}
        ORDER BY f.activo DESC, f.dia, f.nombre`, todos ? [] : [mes]);
      // Los no mensuales (anual, semestral…) se pueden pagar hasta 2 meses antes
      // de su mes: el pago adelantado también los marca como pagados.
      const [pagos] = await portalPool.query(`
        SELECT id, fijo_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, monto_pen, cuenta_nombre, cuenta_company_id, company_id
        FROM gas_gastos WHERE borrado_en IS NULL AND fijo_id IS NOT NULL AND fecha BETWEEN ? AND ?`,
        [sumarMeses(mes, -2) + '-01', mes + '-' + ultimoDia(mes)]);
      const dmax = ultimoDia(mes);
      const lista = fijos.filter(f => todos || tocaEnMes(f, mes)).map(f => {
        const frec = +f.frecuencia || 1;
        const desdeVentana = frec === 1 ? mes : sumarMeses(mes, -Math.min(2, frec - 1));
        const ps = pagos.filter(p => p.fijo_id === f.id && p.fecha.slice(0, 7) >= desdeVentana).map(p => ({ ...p, monto_pen: +p.monto_pen }));
        return { id: f.id, nombre: f.nombre, company_id: f.company_id, categoria_id: f.categoria_id, categoria: f.categoria,
          proveedor: f.proveedor, ruc: f.ruc, moneda: f.moneda, monto: +f.monto, dia: f.dia, frecuencia: frec, cuenta_ref: f.cuenta_ref,
          proximo: todos ? (() => { let m = f.desde_mes; while (difMeses(m, mes) > 0) m = sumarMeses(m, frec); return m; })() : mes,
          desde_mes: f.desde_mes, activo: +f.activo,
          vence: `${mes}-${String(Math.min(f.dia, dmax)).padStart(2, '0')}`,
          pagos: ps, pagado: ps.length > 0, pagado_monto: r2(ps.reduce((a, p) => a + p.monto_pen, 0)) };
      });
      const activos = lista.filter(f => f.activo);
      return { mes, fijos: lista, resumen: {
        n: activos.length, pagados: activos.filter(f => f.pagado).length,
        pagado: r2(activos.reduce((a, f) => a + f.pagado_monto, 0)),
        // Pendiente estimado en soles (los fijos en dólares se cuentan aparte)
        pendiente: r2(activos.filter(f => !f.pagado && f.moneda === 'PEN').reduce((a, f) => a + f.monto, 0)),
        pendiente_usd: r2(activos.filter(f => !f.pagado && f.moneda === 'USD').reduce((a, f) => a + f.monto, 0))
      } };
  }
  app.get('/api/gastos/fijos', authAdmin, mGas, async (req, res) => {
    try {
      const mes = esMes(req.query.mes) ? req.query.mes : hoyLima().slice(0, 7);
      res.json(await fijosDelMes({ mes, emp: empresaValida(req.query.empresa), todos: req.query.todos === '1' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Crear o editar un gasto fijo (cualquiera con el permiso 'gastos')
  app.post('/api/gastos/fijos', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const b = req.body || {};
      const nombre = recortar(b.nombre, 120); if (!nombre) return res.status(400).json({ error: 'Pon un nombre (ej. Alquiler tienda)' });
      const company_id = empresaValida(b.company_id); if (!company_id) return res.status(400).json({ error: 'Elige la empresa' });
      const [[cat]] = await portalPool.query(`SELECT id FROM gas_categorias WHERE id = ?`, [parseInt(b.categoria_id, 10) || 0]);
      if (!cat) return res.status(400).json({ error: 'Elige una categoría' });
      const monto = r2(b.monto); if (!(monto > 0)) return res.status(400).json({ error: 'Pon el monto estimado' });
      const dia = Math.min(31, Math.max(1, parseInt(b.dia, 10) || 1));
      const frecuencia = FRECUENCIAS.includes(+b.frecuencia) ? +b.frecuencia : 1;
      let cuenta_ref = null;
      if (b.cuenta_ref) {
        const c = (await listarCuentas(true)).find(x => x.ref === b.cuenta_ref);
        if (!c) return res.status(400).json({ error: 'La cuenta no existe' });
        cuenta_ref = c.ref;
      }
      const vals = { nombre, company_id, categoria_id: cat.id, proveedor: recortar(b.proveedor, 120),
        ruc: recortar(b.ruc, 11).replace(/\D/g, ''), moneda: b.moneda === 'USD' ? 'USD' : 'PEN', monto, dia, frecuencia, cuenta_ref,
        desde_mes: esMes(b.desde_mes) ? b.desde_mes : new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 7),
        activo: b.activo === 0 || b.activo === false ? 0 : 1 };
      if (b.id) {
        const [r] = await portalPool.query(`UPDATE gas_fijos SET ? WHERE id = ?`, [vals, parseInt(b.id, 10) || 0]);
        if (!r.affectedRows) return res.status(404).json({ error: 'El gasto fijo no existe' });
        res.json({ ok: true, id: +b.id });
      } else {
        const [r] = await portalPool.query(`INSERT INTO gas_fijos SET ?`, [{ ...vals, creado_por: usuarioDe(req) }]);
        res.json({ ok: true, id: r.insertId });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Categorías y cuentas propias (solo maestro) ───────────────────────────
  app.post('/api/gastos/categorias', authAdmin, mGas, soloMaestro, async (req, res) => {
    try {
      await prepararTablas();
      const b = req.body || {};
      const nombre = recortar(b.nombre, 80); if (!nombre) return res.status(400).json({ error: 'Pon un nombre' });
      const vals = { nombre, en_resultado: b.en_resultado ? 1 : 0, fijo_sugerido: b.fijo_sugerido ? 1 : 0, activo: b.activo === 0 || b.activo === false ? 0 : 1 };
      if (b.id) await portalPool.query(`UPDATE gas_categorias SET ? WHERE id = ?`, [vals, parseInt(b.id, 10) || 0]);
      else {
        const [[{ o }]] = await portalPool.query(`SELECT COALESCE(MAX(orden),0)+1 AS o FROM gas_categorias`);
        await portalPool.query(`INSERT INTO gas_categorias SET ?`, [{ ...vals, orden: o }]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(e.code === 'ER_DUP_ENTRY' ? 400 : 500).json({ error: e.code === 'ER_DUP_ENTRY' ? 'Ya existe una categoría con ese nombre' : e.message }); }
  });

  app.post('/api/gastos/cuentas', authAdmin, mGas, soloMaestro, async (req, res) => {
    try {
      await prepararTablas();
      const b = req.body || {};
      const nombre = recortar(b.nombre, 80); if (!nombre) return res.status(400).json({ error: 'Pon un nombre' });
      const company_id = empresaValida(b.company_id); if (!company_id) return res.status(400).json({ error: 'Elige la empresa dueña de la cuenta' });
      const tipo = ['efectivo', 'tarjeta', 'banco', 'otro'].includes(b.tipo) ? b.tipo : 'otro';
      const vals = { nombre, company_id, tipo, activo: b.activo === 0 || b.activo === false ? 0 : 1 };
      if (tipo === 'tarjeta') {
        vals.limite = b.limite === '' || b.limite == null ? null : r2(b.limite);
        vals.corte_dia = Math.min(31, Math.max(1, parseInt(b.corte_dia, 10) || 11));
        vals.pago_meses = +b.pago_meses === 1 ? 1 : 0;
      }
      if (b.id) await portalPool.query(`UPDATE gas_cuentas SET ? WHERE id = ?`, [vals, parseInt(b.id, 10) || 0]);
      else await portalPool.query(`INSERT INTO gas_cuentas SET ?`, [vals]);
      res.json({ ok: true });
    } catch (e) { res.status(e.code === 'ER_DUP_ENTRY' ? 400 : 500).json({ error: e.code === 'ER_DUP_ENTRY' ? 'Ya existe una cuenta con ese nombre' : e.message }); }
  });

  // ── Excel ─────────────────────────────────────────────────────────────────
  app.get('/api/gastos-excel', authAdmin, mGas, async (req, res) => {
    try {
      const { f, gastos } = await obtenerGastos(req.query);
      const emp = id => EMPRESAS_BI[id] || (id ? 'Empresa ' + id : '');
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Gastos');
      const cab = [['Desde', f.desde || ''], ['Hasta', f.hasta || ''], ['Empresa', f.empresa ? emp(f.empresa) : 'Todas']];
      const n = cabeceraExcel(ws, 'Compras y gastos', cab, 16);
      const cols = [['Fecha', 11], ['Empresa', 24], ['Cuenta de salida', 26], ['Dueña de la cuenta', 24], ['Categoría', 30],
        ['Proveedor', 28], ['RUC', 13], ['Descripción', 36], ['Moneda', 8], ['Monto', 12], ['T. cambio', 9], ['Monto S/', 13],
        ['Comprobante', 14], ['N° comprobante', 16], ['Fijo', 6], ['En resultado', 11], ['Registrado por', 16]];
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      ws.views = [{ state: 'frozen', ySplit: n + 1 }];
      ws.autoFilter = { from: { row: n + 1, column: 1 }, to: { row: n + 1, column: cols.length } };
      gastos.slice().reverse().forEach(g => {
        const row = ws.addRow([new Date(g.fecha + 'T00:00:00Z'), emp(g.company_id), g.cuenta_nombre, emp(g.cuenta_company_id), g.categoria,
          g.proveedor, g.ruc, g.descripcion, g.moneda, g.monto, g.tipo_cambio || '', g.monto_pen,
          g.comp_tipo === 'ninguno' ? '' : g.comp_tipo, g.comp_numero, g.fijo ? 'Sí' : '', g.en_resultado ? 'Sí' : 'No', g.creado_por]);
        if (g.cuenta_company_id && g.cuenta_company_id !== g.company_id) row.getCell(4).font = { color: { argb: 'FFB45309' }, bold: true };
      });
      ws.getColumn(1).numFmt = 'dd/mm/yyyy';
      [10, 12].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const tr = ws.addRow(['', '', '', '', '', '', '', 'TOTAL', '', '', '', { formula: `SUM(L${n + 2}:L${n + 1 + gastos.length})`, result: r2(gastos.reduce((a, g) => a + g.monto_pen, 0)) }]);
      tr.font = { bold: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('gastos')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el Excel: ' + e.message }); }
  });

  // Para Rendimiento: gastos por mes, empresa y categoría, y lo pagado entre empresas
  async function gastosMensuales({ desde, hasta, empresa }) {
    await prepararTablas();
    const emp = empresaValida(empresa);
    const p = [desde, hasta];
    const fe = emp ? 'AND g.company_id = ' + emp : '';
    const [porCat] = await portalPool.query(`
      SELECT DATE_FORMAT(g.fecha, '%Y-%m') AS mes, g.company_id, g.categoria_id, c.nombre AS categoria,
        COALESCE(c.en_resultado, 1) AS en_resultado,
        SUM(g.monto_pen) AS total, SUM(CASE WHEN g.fijo = 1 THEN g.monto_pen ELSE 0 END) AS fijos,
        SUM(CASE WHEN g.fijo_id IS NOT NULL THEN g.monto_pen ELSE 0 END) AS fijos_plantilla
      FROM gas_gastos g LEFT JOIN gas_categorias c ON c.id = g.categoria_id
      WHERE g.borrado_en IS NULL AND g.fecha BETWEEN ? AND ? ${fe}
      GROUP BY mes, g.company_id, g.categoria_id, c.nombre, COALESCE(c.en_resultado, 1)`, p);
    const [entre] = await portalPool.query(`
      SELECT DATE_FORMAT(g.fecha, '%Y-%m') AS mes, g.cuenta_company_id AS pagadora, g.company_id AS beneficiaria, SUM(g.monto_pen) AS total
      FROM gas_gastos g
      WHERE g.borrado_en IS NULL AND g.fecha BETWEEN ? AND ? AND g.cuenta_company_id IS NOT NULL
        AND g.cuenta_company_id <> g.company_id ${fe}
      GROUP BY mes, g.cuenta_company_id, g.company_id`, p);
    const [[primero]] = await portalPool.query(`SELECT DATE_FORMAT(MIN(fecha), '%Y-%m') AS mes FROM gas_gastos WHERE borrado_en IS NULL`);
    // Gastos fijos activos llevados a su costo MENSUAL (un anual de S/ 1,200 =
    // S/ 100 al mes), para el punto de equilibrio. Los de dólares se convierten
    // con el último tipo de cambio usado en un gasto.
    const [fijos] = await portalPool.query(`
      SELECT f.company_id, f.moneda, f.monto, f.frecuencia FROM gas_fijos f
      LEFT JOIN gas_categorias c ON c.id = f.categoria_id
      WHERE f.activo = 1 AND COALESCE(c.en_resultado, 1) = 1 ${fe.replace('g.company_id', 'f.company_id')}`);
    const [[tc]] = await portalPool.query(`SELECT tipo_cambio FROM gas_gastos WHERE borrado_en IS NULL AND moneda = 'USD' AND tipo_cambio > 0 ORDER BY fecha DESC, id DESC LIMIT 1`);
    const tcUsd = tc ? +tc.tipo_cambio : null;
    const fijosMes = {};
    let sinTc = false;
    fijos.forEach(f => {
      let m = +f.monto / (+f.frecuencia || 1);
      if (f.moneda === 'USD') { if (!tcUsd) { sinTc = true; return; } m *= tcUsd; }
      fijosMes[f.company_id] = (fijosMes[f.company_id] || 0) + m;
    });
    return {
      por_categoria: porCat.map(r => ({ ...r, total: r2(r.total), fijos: r2(r.fijos), fijos_plantilla: r2(r.fijos_plantilla), en_resultado: +r.en_resultado })),
      entre: entre.map(r => ({ ...r, total: r2(r.total) })),
      primer_mes: primero && primero.mes,
      fijos_mensuales: Object.fromEntries(Object.entries(fijosMes).map(([k, v]) => [k, r2(v)])),
      fijos_definidos: fijos.length, fijos_usd_sin_tc: sinTc,
      caja: await cajaMensual({ desde, hasta, emp })
    };
  }

  // Ajustes de CAJA por mes y empresa para el flujo de Rendimiento:
  //   merc_caja      mercadería en el mes en que sale el dinero (contado = fecha de
  //                  compra; tarjeta = fecha de pago de la tarjeta)
  //   gastos_tarjeta gastos cargados a tarjeta en el mes (se restan: aún no sale dinero)
  //   pagos_tarjeta  esos gastos en el mes en que se paga la tarjeta
  async function cajaMensual({ desde, hasta, emp }) {
    const desdeAmplio = sumarMeses(desde.slice(0, 7), -3) + '-01';
    let merc = [], gasT = [];
    try { [merc, gasT] = await Promise.all([mercaderiaConPago({ desde: desdeAmplio, hasta }), gastosConTarjeta({ desde: desdeAmplio, hasta })]); }
    catch (e) { return null; }   // si el ERP no responde, Rendimiento usa la fecha de compra
    const acc = {};
    const fila = (mes, cid) => { const k = mes + '|' + cid; return acc[k] = acc[k] || { mes, company_id: cid, merc_caja: 0, gastos_tarjeta: 0, pagos_tarjeta: 0 }; };
    const dentro = f => f >= desde && f <= hasta;
    merc.forEach(m => { if ((!emp || m.company_id === emp) && dentro(m.fecha_pago)) fila(m.fecha_pago.slice(0, 7), m.company_id || 0).merc_caja += m.total; });
    gasT.forEach(g => {
      if (emp && g.company_id !== emp) return;
      if (dentro(g.fecha)) fila(g.fecha.slice(0, 7), g.company_id).gastos_tarjeta += g.monto_pen;
      if (dentro(g.fecha_pago)) fila(g.fecha_pago.slice(0, 7), g.company_id).pagos_tarjeta += g.monto_pen;
    });
    return Object.values(acc).map(x => ({ ...x, merc_caja: r2(x.merc_caja), gastos_tarjeta: r2(x.gastos_tarjeta), pagos_tarjeta: r2(x.pagos_tarjeta) }));
  }

  // Rendimiento recibe solo gastosMensuales desde index.js; se le cuelga mesEnCurso
  // para no tener que tocar index.js (archivo compartido por todos los módulos).
  gastosMensuales.mesEnCurso = mesEnCurso;
  return { prepararTablas, gastosMensuales, _test: { resumir, filtros } };
};
