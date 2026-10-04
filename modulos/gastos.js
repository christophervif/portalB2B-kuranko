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
      `SELECT id, nombre, company_id, tipo, activo FROM gas_cuentas ${incluirInactivas ? '' : 'WHERE activo = 1'} ORDER BY company_id, nombre`);
    return [...erp, ...propias.map(r => ({ ref: 'gc:' + r.id, id: r.id, tipo: r.tipo, origen: 'portal',
      nombre: r.nombre, company_id: +r.company_id, activo: +r.activo }))];
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
  app.get('/api/gastos/fijos', authAdmin, mGas, async (req, res) => {
    try {
      await prepararTablas();
      const mes = esMes(req.query.mes) ? req.query.mes : new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 7);
      const emp = empresaValida(req.query.empresa);
      const todos = req.query.todos === '1';
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
      res.json({ mes, fijos: lista, resumen: {
        n: activos.length, pagados: activos.filter(f => f.pagado).length,
        pagado: r2(activos.reduce((a, f) => a + f.pagado_monto, 0)),
        // Pendiente estimado en soles (los fijos en dólares se cuentan aparte)
        pendiente: r2(activos.filter(f => !f.pagado && f.moneda === 'PEN').reduce((a, f) => a + f.monto, 0)),
        pendiente_usd: r2(activos.filter(f => !f.pagado && f.moneda === 'USD').reduce((a, f) => a + f.monto, 0))
      } });
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
      fijos_definidos: fijos.length, fijos_usd_sin_tc: sinTc
    };
  }

  return { prepararTablas, gastosMensuales, _test: { resumir, filtros } };
};
