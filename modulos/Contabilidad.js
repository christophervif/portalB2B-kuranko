// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Contabilidad
//  Kardex valorizado y reporte de pagos (con las hojas de facturas/boletas).
//  Recibe del index.js las piezas compartidas y las funciones de comunes.js.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, fechaHoraLima, fechaLima: fechaSolo, nombreTrazable, rango, cabeceraExcel } = require('./comunes');

module.exports = function registrarContabilidad({ app, authAdmin, requiereModulo, prodPool, VV }) {

  async function costoFifoVigente(prodPool, variationId) {
    const [[r]] = await prodPool.query(
      `SELECT cost_price FROM stock_batches
       WHERE product_variation_id = ? AND quantity > 0
       ORDER BY entry_date ASC, id ASC LIMIT 1`, [variationId]);
    return r ? Number(r.cost_price) : null;
  }

  // Costo del lote creado en una entrada específica (para valorizar entradas al costo real)
  async function costoDeEntrada(prodPool, entryId, variationId) {
    const [[r]] = await prodPool.query(
      `SELECT cost_price FROM stock_batches
       WHERE stock_entry_id = ? AND product_variation_id = ?
       ORDER BY id ASC LIMIT 1`, [entryId, variationId]);
    return r ? Number(r.cost_price) : null;
  }

  async function obtenerKardex(prodPool, q) {
    const { desde, hasta, sku, producto } = q;
    const w = [];
    const p = [];
    if (desde && hasta) { w.push('sm.movement_date BETWEEN ? AND ?'); p.push(desde, hasta); }
    if (sku) { w.push('pv.sku LIKE ?'); p.push('%' + sku + '%'); }
    if (producto) { w.push('(p.name LIKE ? OR pv.name LIKE ?)'); p.push('%' + producto + '%', '%' + producto + '%'); }
    const whereSql = w.length ? 'WHERE ' + w.join(' AND ') : '';

    // Traer movimientos con producto, ubicación y usuario
    const [movs] = await prodPool.query(`
      SELECT sm.id, sm.type, sm.operation_type_code, sm.quantity, sm.movement_date,
        sm.reference_type, sm.reference_id, sm.notes, sm.location_from_id, sm.location_to_id,
        pv.id AS variation_id, pv.sku, pv.name AS variacion, p.name AS producto,
        lf.name AS ubic_from, lt.name AS ubic_to, u.name AS usuario
      FROM stock_movements sm
      JOIN product_variations pv ON pv.id = sm.product_variation_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN locations lf ON lf.id = sm.location_from_id
      LEFT JOIN locations lt ON lt.id = sm.location_to_id
      LEFT JOIN users u ON u.id = sm.user_id
      ${whereSql}
      ORDER BY p.name, pv.name, pv.sku, sm.movement_date ASC, sm.id ASC`, p);

    if (!movs.length) return [];

    // Códigos de operación de entradas y transferencias (por reference_id)
    const entryIds = movs.filter(m => m.reference_type === 'App\\Models\\StockEntry').map(m => m.reference_id).filter(Boolean);
    const transferIds = movs.filter(m => m.reference_type === 'App\\Models\\StockTransfer').map(m => m.reference_id).filter(Boolean);
    const codEntradas = {}, codTransfer = {};
    if (entryIds.length) {
      const [rows] = await prodPool.query(
        `SELECT id, operation_type_code FROM stock_entries WHERE id IN (?)`, [[...new Set(entryIds)]]);
      rows.forEach(r => codEntradas[r.id] = r.operation_type_code);
    }
    if (transferIds.length) {
      const [rows] = await prodPool.query(
        `SELECT id, operation_type_code FROM stock_transfers WHERE id IN (?)`, [[...new Set(transferIds)]]);
      rows.forEach(r => codTransfer[r.id] = r.operation_type_code);
    }

    // Costo y precio de venta por (venta, variación) — para valorizar y margen
    const saleIds = movs.filter(m => m.reference_type === 'App\\Models\\Sale').map(m => m.reference_id).filter(Boolean);
    const ventaInfo = {}; // clave: `${saleId}_${variationId}`
    if (saleIds.length) {
      const [rows] = await prodPool.query(`
        SELECT si.sale_id, si.product_variation_id,
          SUM(si.quantity) AS qty, SUM(si.total) AS ingreso,
          SUM(CASE WHEN si.stock_batch_id IS NOT NULL THEN si.quantity * sb.cost_price ELSE 0 END) AS costo_total,
          MAX(CASE WHEN si.stock_batch_id IS NULL AND si.is_backorder = 1 THEN 1 ELSE 0 END) AS tiene_pedido,
          MAX(CASE WHEN si.stock_batch_id IS NULL THEN 1 ELSE 0 END) AS tiene_sin_lote
        FROM sale_items si
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE si.sale_id IN (?)
        GROUP BY si.sale_id, si.product_variation_id`, [[...new Set(saleIds)]]);
      rows.forEach(r => {
        ventaInfo[`${r.sale_id}_${r.product_variation_id}`] = {
          precio_unit: r.qty > 0 ? Number(r.ingreso) / Number(r.qty) : 0,
          costo_unit: r.qty > 0 ? Number(r.costo_total) / Number(r.qty) : 0,
          tiene_pedido: !!r.tiene_pedido, tiene_sin_lote: !!r.tiene_sin_lote
        };
      });
    }

    // Cache de costo FIFO vigente para valorizar entradas/ajustes/transferencias
    const cacheFifo = {};
    const fifo = async (vid) => {
      if (!(vid in cacheFifo)) cacheFifo[vid] = await costoFifoVigente(prodPool, vid);
      return cacheFifo[vid];
    };

    // Construir filas con valorización, código SUNAT y alertas
    const filas = [];
    for (const m of movs) {
      // Código SUNAT según el tipo/origen
      let codigo = null;
      if (m.type === 'sale') codigo = '01';
      else if (m.type === 'adjustment') codigo = m.operation_type_code;
      else if (m.reference_type === 'App\\Models\\StockEntry') codigo = codEntradas[m.reference_id];
      else if (m.reference_type === 'App\\Models\\StockTransfer') codigo = codTransfer[m.reference_id];
      if (!codigo && m.operation_type_code) codigo = m.operation_type_code;

      // Valorización
      let costoUnit = null, precioUnit = null, margenUnit = null, alerta = '';
      if (m.type === 'sale') {
        const info = ventaInfo[`${m.reference_id}_${m.variation_id}`];
        if (info) {
          precioUnit = info.precio_unit;
          if (info.tiene_sin_lote && info.costo_unit === 0) {
            if (info.tiene_pedido) alerta = 'A pedido';
            else if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
            else alerta = 'Sin costo — revisar';
          } else {
            costoUnit = info.costo_unit;
            margenUnit = precioUnit - costoUnit;
          }
        }
      } else if (m.reference_type === 'App\\Models\\StockEntry') {
        // Entrada: costo del lote creado en esa entrada (costo real de compra)
        costoUnit = await costoDeEntrada(prodPool, m.reference_id, m.variation_id);
        if (costoUnit === null) costoUnit = await fifo(m.variation_id);
        if (costoUnit === null || costoUnit === 0) {
          if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
          else alerta = 'Sin costo — revisar';
        }
      } else {
        // Salidas no-venta, ajustes, transferencias: costo FIFO del lote más antiguo
        // con stock (de donde el sistema descuenta).
        costoUnit = await fifo(m.variation_id);
        if (costoUnit === null || costoUnit === 0) {
          if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
          else alerta = 'Sin costo — revisar';
        }
      }

      const cant = Number(m.quantity);
      const valorMov = costoUnit != null ? costoUnit * cant : null;
      const ubicacion = m.type === 'purchase' || m.reference_type === 'App\\Models\\StockEntry'
        ? (m.ubic_to || m.ubic_from || '') : (m.ubic_from || m.ubic_to || '');

      filas.push({
        fecha: m.movement_date, producto: m.producto, variacion: m.variacion, sku: m.sku,
        variation_id: m.variation_id,
        tipo: TIPO_MOV_NOM[m.type] || m.type,
        codigo_sunat: codigo || '', codigo_nombre: codigo ? (CODIGOS_SUNAT[codigo] || '') : '',
        cantidad: cant,
        costo_unit: costoUnit, valor_mov: valorMov,
        precio_unit: precioUnit, margen_unit: margenUnit,
        ubicacion, usuario: m.usuario || '',
        documento: m.reference_type ? `${(m.reference_type.split('\\').pop())} #${m.reference_id}` : '',
        nota: m.notes || '', alerta
      });
    }

    // Saldo acumulado por producto (variación): cantidad y valor
    const saldoCant = {}, saldoVal = {};
    filas.forEach(f => {
      const k = f.variation_id;
      saldoCant[k] = (saldoCant[k] || 0) + f.cantidad;
      saldoVal[k] = (saldoVal[k] || 0) + (f.valor_mov || 0);
      f.saldo_cantidad = saldoCant[k];
      f.saldo_valor = saldoVal[k];
    });

    return filas;
  }

  // Filtros del kardex (no requiere lista fija; el filtro de producto es texto libre)


  app.get('/admin/kardex/productos', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv JOIN products p ON p.id = pv.product_id
        WHERE pv.deleted_at IS NULL AND pv.sku IS NOT NULL
        ORDER BY p.name, pv.name LIMIT 5000`);
      res.json({ productos: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/kardex', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const filas = await obtenerKardex(prodPool, req.query);
      res.json({ total: filas.length, filas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/kardex-excel', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const filas = await obtenerKardex(prodPool, req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Kardex Valorizado');
      const soloFecha = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';

      // Cabecera informativa (título, fecha de exportación, filtros)
      const filasCab = cabeceraExcel(ws, 'Kardex Valorizado', [
        ['Desde', req.query.desde], ['Hasta', req.query.hasta],
        ['Producto', req.query.producto], ['SKU', req.query.sku],
        ['Movimientos', filas.length]
      ], 19);

      const colDefs = [
        { header: 'Fecha', width: 12 }, { header: 'Producto', width: 30 }, { header: 'Variación', width: 26 },
        { header: 'SKU', width: 18 }, { header: 'Tipo', width: 14 }, { header: 'Cód. SUNAT', width: 11 },
        { header: 'Operación', width: 24 }, { header: 'Cantidad', width: 10 }, { header: 'Costo unit.', width: 12 },
        { header: 'Valor mov.', width: 13 }, { header: 'Precio venta', width: 12 }, { header: 'Margen unit.', width: 12 },
        { header: 'Saldo cant.', width: 11 }, { header: 'Saldo valor', width: 13 }, { header: 'Ubicación', width: 18 },
        { header: 'Usuario', width: 18 }, { header: 'Documento', width: 18 }, { header: 'Nota', width: 40 },
        { header: 'Alerta', width: 22 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const headerRowNum = filasCab + 1;
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

      filas.forEach(f => {
        ws.addRow([
          soloFecha(f.fecha), f.producto, f.variacion, f.sku, f.tipo, f.codigo_sunat, f.codigo_nombre,
          f.cantidad, f.costo_unit != null ? f.costo_unit : '', f.valor_mov != null ? f.valor_mov : '',
          f.precio_unit != null ? f.precio_unit : '', f.margen_unit != null ? f.margen_unit : '',
          f.saldo_cantidad, f.saldo_valor, f.ubicacion, f.usuario, f.documento, f.nota, f.alerta
        ]);
      });
      ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
      ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: 19 } };
      [9, 10, 11, 12, 14].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

      // Totales por producto al final
      ws.addRow([]);
      const totProd = {};
      filas.forEach(f => {
        const k = f.producto + ' — ' + f.variacion;
        if (!totProd[k]) totProd[k] = { cant: 0, valor: 0 };
        totProd[k].cant += f.cantidad;
        totProd[k].valor += (f.valor_mov || 0);
      });
      const tRow = ws.addRow(['TOTALES POR PRODUCTO (saldo final)']); tRow.font = { bold: true };
      Object.entries(totProd).forEach(([k, v]) => {
        const r = ws.addRow(['', k]); r.getCell(8).value = v.cant; r.getCell(10).value = v.valor;
        r.getCell(10).numFmt = '#,##0.00';
      });

      const nombre = nombreTrazable('kardex');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el kardex: ' + e.message }); }
  });


  app.get('/admin/reporte-pagos/filtros', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const [metodos] = await prodPool.query(
        `SELECT DISTINCT ci.id, ci.name FROM catalog_items ci
         JOIN sale_payments sp ON sp.payment_method_id = ci.id
         WHERE sp.voided_at IS NULL ORDER BY ci.name`);
      const [cuentas] = await prodPool.query(
        `SELECT ba.id, ba.account_number, banco.name AS banco
         FROM bank_accounts ba LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
         ORDER BY banco.name, ba.account_number`);
      res.json({
        metodos,
        cuentas: cuentas.map(c => ({ id: c.id, etiqueta: `${c.banco || 'Banco'} ${c.account_number}` })),
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id, nombre }))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Función compartida: arma la lista de pagos según filtros
  async function obtenerPagos(q) {
    const { desde, hasta, empresa, empresa_producto, cuenta, metodo, tipo_comprobante } = q;
    const w = ['sp.voided_at IS NULL', 's.deleted_at IS NULL'];
    const p = [];
    if (desde && hasta) { w.push('DATE(sp.paid_at) BETWEEN ? AND ?'); p.push(desde, hasta); }
    if (empresa) { w.push('s.company_id = ?'); p.push(empresa); }
    if (cuenta) { w.push('sp.bank_account_id = ?'); p.push(cuenta); }
    if (metodo) { w.push('sp.payment_method_id = ?'); p.push(metodo); }

    const [pagos] = await prodPool.query(`
      SELECT sp.id, sp.paid_at, sp.amount, sp.notes AS nota_pago,
        s.id AS sale_id, s.code AS venta_codigo, s.company_id, s.observations AS obs_venta,
        s.created_at AS venta_fecha,
        CASE WHEN cli.is_company=1 THEN cli.business_name
             ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente_nombre,
        cli.document_number AS cliente_doc, cli.is_company AS cliente_es_empresa,
        mp.name AS metodo,
        ba.account_number, banco.name AS banco, ba.party_id AS cuenta_party_id,
        dueno.business_name AS empresa_cuenta,
        s.total AS venta_total,
        CASE WHEN cc.status='closed' THEN 'Cerrado' ELSE 'Sin cerrar' END AS cuadre
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      LEFT JOIN parties cli ON cli.id = s.customer_id
      LEFT JOIN catalog_items mp ON mp.id = sp.payment_method_id
      LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
      LEFT JOIN parties dueno ON dueno.id = ba.party_id
      LEFT JOIN cash_closures cc ON cc.closure_date = DATE(sp.paid_at)
      WHERE ${w.join(' AND ')}
      ORDER BY sp.paid_at ASC`, p);

    if (!pagos.length) return [];

    const saleIds = [...new Set(pagos.map(x => x.sale_id))];

    // Empresa(s) del producto por venta: vía sale_items → stock_batches.company_id
    const [empresasProd] = await prodPool.query(`
      SELECT DISTINCT si.sale_id, sb.company_id
      FROM sale_items si JOIN stock_batches sb ON sb.id = si.stock_batch_id
      WHERE si.sale_id IN (?) AND si.stock_batch_id IS NOT NULL`, [saleIds]);
    const empProdPorVenta = {};
    empresasProd.forEach(r => {
      (empProdPorVenta[r.sale_id] = empProdPorVenta[r.sale_id] || new Set()).add(r.company_id);
    });

    // Comprobantes por venta
    const [vouchers] = await prodPool.query(`
      SELECT sale_id, type, serie, number, emission_date, amount FROM sale_vouchers WHERE sale_id IN (?)`, [saleIds]);
    const vouchPorVenta = {};
    const tipoCompPorVenta = {};   // 'factura' | 'boleta' | 'mixto' por venta
    const compDetallePorVenta = {}; // detalle de comprobantes por venta (para la hoja agrupada)
    vouchers.forEach(v => {
      const t = v.type === 'factura' ? 'Factura' : v.type === 'boleta' ? 'Boleta' : v.type;
      (vouchPorVenta[v.sale_id] = vouchPorVenta[v.sale_id] || []).push(`${t} ${v.serie}-${v.number}`);
      (compDetallePorVenta[v.sale_id] = compDetallePorVenta[v.sale_id] || []).push({
        tipo: v.type, codigo: `${v.serie}-${v.number}`,
        fecha: v.emission_date, importe: Number(v.amount || 0),
        sale_id: v.sale_id
      });
      // Marcar el tipo de la venta: si tiene facturas y boletas, 'mixto'
      const prev = tipoCompPorVenta[v.sale_id];
      if (!prev) tipoCompPorVenta[v.sale_id] = v.type;
      else if (prev !== v.type) tipoCompPorVenta[v.sale_id] = 'mixto';
    });

    // Total pagado HISTÓRICO de cada venta (todos sus pagos, sin filtro de fecha).
    // Con esto se calcula el saldo real que falta cobrar.
    const pagadoTotal = {};
    const [ph] = await prodPool.query(`
      SELECT sale_id, COALESCE(SUM(amount),0) AS pagado
      FROM sale_payments WHERE voided_at IS NULL AND sale_id IN (?)
      GROUP BY sale_id`, [saleIds]);
    ph.forEach(r => pagadoTotal[r.sale_id] = Number(r.pagado));

    // ¿Estas ventas tienen pagos FUERA del rango de fechas filtrado?
    // Sirve para avisar que el subtotal mostrado no es todo lo pagado de esa venta.
    const pagosFuera = {};
    if (desde && hasta) {
      const [fuera] = await prodPool.query(`
        SELECT sale_id, COUNT(*) AS n, COALESCE(SUM(amount),0) AS monto
        FROM sale_payments
        WHERE voided_at IS NULL AND sale_id IN (?)
          AND DATE(paid_at) NOT BETWEEN ? AND ?
        GROUP BY sale_id`, [saleIds, desde, hasta]);
      fuera.forEach(r => pagosFuera[r.sale_id] = { n: Number(r.n), monto: Number(r.monto) });
    }

    let lista = pagos.map(pg => {
      const empSet = empProdPorVenta[pg.sale_id];
      const empProd = empSet ? [...empSet].map(id => EMPRESAS_BI[id] || `Empresa ${id}`).join(', ') : '—';
      const fuera = pagosFuera[pg.sale_id];
      return {
        paid_at: pg.paid_at,
        cliente: pg.cliente_nombre && pg.cliente_nombre.trim() ? pg.cliente_nombre.trim() : '—',
        cliente_doc: pg.cliente_doc || '—',
        // El ERP no guarda el tipo de documento: se deduce por el largo (11 = RUC, 8 = DNI)
        cliente_doc_tipo: !pg.cliente_doc ? '—'
          : (String(pg.cliente_doc).length === 11 ? 'RUC'
            : String(pg.cliente_doc).length === 8 ? 'DNI' : 'Otro'),
        metodo: pg.metodo || 'Sin método',
        cuenta: pg.banco ? `${pg.banco} ${pg.account_number || ''}`.trim() : '—',
        empresa_cuenta: pg.empresa_cuenta || '—',
        venta: pg.venta_codigo,
        empresa_gestiona: pg.company_id != null ? (EMPRESAS_BI[pg.company_id] || `Empresa ${pg.company_id}`) : '(vacío)',
        empresa_producto: empProd,
        comprobante: (vouchPorVenta[pg.sale_id] || []).join(' · ') || '—',
        tipo_comprobante: tipoCompPorVenta[pg.sale_id] || null,
        _comp_detalle: compDetallePorVenta[pg.sale_id] || [],
        nota_pago: pg.nota_pago || '', obs_venta: pg.obs_venta || '',
        cuadre: pg.cuadre, monto: Number(pg.amount),
        venta_total: Number(pg.venta_total || 0),
        venta_pagado: pagadoTotal[pg.sale_id] || 0,
        venta_saldo: Math.max(0, Number(pg.venta_total || 0) - (pagadoTotal[pg.sale_id] || 0)),
        _sale_id: pg.sale_id,
        _pagos_fuera: fuera ? fuera.n : 0,
        _monto_fuera: fuera ? fuera.monto : 0,
        _empresas_prod_ids: empSet ? [...empSet] : []
      };
    });

    // Filtro por empresa del producto (se aplica en memoria porque puede haber varias)
    if (empresa_producto) {
      lista = lista.filter(x => x._empresas_prod_ids.includes(Number(empresa_producto)));
    }
    lista.forEach(x => delete x._empresas_prod_ids);

    // Filtro por tipo de comprobante (factura / boleta). 'mixto' cuenta para ambos.
    if (tipo_comprobante === 'factura') {
      lista = lista.filter(x => x.tipo_comprobante === 'factura' || x.tipo_comprobante === 'mixto');
    } else if (tipo_comprobante === 'boleta') {
      lista = lista.filter(x => x.tipo_comprobante === 'boleta' || x.tipo_comprobante === 'mixto');
    }

    // Agrupar por venta manteniendo el orden cronológico DENTRO de cada venta.
    // Las ventas se ordenan por la fecha de su primer pago (para que el reporte
    // siga una línea de tiempo natural).
    const primerPago = {};
    lista.forEach(x => {
      const t = new Date(x.paid_at).getTime();
      if (primerPago[x._sale_id] == null || t < primerPago[x._sale_id]) primerPago[x._sale_id] = t;
    });
    lista.sort((a, b) => {
      const d = primerPago[a._sale_id] - primerPago[b._sale_id];
      if (d !== 0) return d;
      if (a._sale_id !== b._sale_id) return a._sale_id - b._sale_id;
      return new Date(a.paid_at) - new Date(b.paid_at);
    });

    // Total de cada venta (suma de los pagos que cumplen los filtros)
    const totalVenta = {};
    lista.forEach(x => totalVenta[x._sale_id] = (totalVenta[x._sale_id] || 0) + x.monto);
    lista.forEach(x => x._total_venta = totalVenta[x._sale_id]);

    return lista;
  }

  app.get('/admin/reporte-pagos', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const lista = await obtenerPagos(req.query);
      res.json({ total: lista.length, suma: lista.reduce((s, x) => s + x.monto, 0), pagos: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/reporte-pagos-excel', authAdmin, requiereModulo('reportes'), async (req, res) => {
    try {
      const lista = await obtenerPagos(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Pagos');
      const fechaLima = fechaHoraLima; // fecha + hora (viene de comunes)

      // Empresa(s) que gestiona(n): si filtró por una, esa; si no, las presentes en el resultado
      let empresaGestionaTxt;
      if (req.query.empresa) {
        empresaGestionaTxt = EMPRESAS_BI[req.query.empresa] || `Empresa ${req.query.empresa}`;
      } else {
        const setEmp = [...new Set(lista.map(x => x.empresa_gestiona))];
        empresaGestionaTxt = setEmp.length ? setEmp.join(', ') : 'Todas';
      }

      const colDefs = [
        { header: 'Fecha', width: 18 }, { header: 'Cliente', width: 32 },
        { header: 'Tipo doc.', width: 10 }, { header: 'DNI/RUC', width: 15 },
        { header: 'Método', width: 18 }, { header: 'Cuenta destino', width: 28 },
        { header: 'Empresa dueña de la cuenta', width: 28 }, { header: 'Venta', width: 15 },
        { header: 'Empresa que gestiona', width: 26 }, { header: 'Empresa(s) del producto', width: 28 },
        { header: 'Comprobante', width: 28 }, { header: 'Nota del pago', width: 34 },
        { header: 'Observación de venta', width: 34 }, { header: 'Cierre de caja', width: 14 },
        { header: 'Monto del pago', width: 15 }, { header: 'Valor de la venta', width: 16 },
        { header: 'Pagado en el rango', width: 17 }, { header: 'Saldo por cobrar', width: 16 },
        { header: 'Pagos fuera del rango', width: 22 }
      ];

      // Cabecera informativa
      const filasCab = cabeceraExcel(ws, 'Reporte de pagos', [
        ['Empresa que gestiona', empresaGestionaTxt],
        ['Desde', req.query.desde], ['Hasta', req.query.hasta],
        ['Cuenta', req.query.cuenta ? 'filtrada' : ''], ['Método', req.query.metodo ? 'filtrado' : ''],
        ['Pagos', lista.length],
        ['IMPORTANTE', 'Todos los pagos listados son dinero YA RECIBIDO. "Cierre de caja" indica si el cierre administrativo del día se realizó, NO si el pago está pendiente.'],
        ['Columnas', 'Monto del pago = esa transacción · Valor de la venta = lo que cuesta la venta · Pagado en el rango = suma de pagos del filtro · Saldo por cobrar = lo que falta (sobre todos los pagos históricos)']
      ], 19);
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const headerRowNum = filasCab + 1;
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

      // Una fila por pago (plano, apto para filtrar y tablas dinámicas).
      // Los datos de la venta (valor, pagado, saldo) se repiten en sus filas a propósito.
      lista.forEach(x => {
        ws.addRow([
          fechaLima(x.paid_at), x.cliente, x.cliente_doc_tipo, x.cliente_doc, x.metodo, x.cuenta,
          x.empresa_cuenta, x.venta, x.empresa_gestiona, x.empresa_producto, x.comprobante,
          x.nota_pago, x.obs_venta, x.cuadre, x.monto, x.venta_total, x._total_venta, x.venta_saldo,
          x._pagos_fuera > 0 ? `${x._pagos_fuera} pago(s): S/ ${x._monto_fuera.toFixed(2)}` : ''
        ]);
      });
      ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
      ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: 19 } };
      [15, 16, 17, 18].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

      // Totalizadores
      ws.addRow([]);
      const totEmpF = {}, totCta = {}, totMet = {}, totEmpC = {};
      lista.forEach(x => {
        totEmpF[x.empresa_gestiona] = (totEmpF[x.empresa_gestiona] || 0) + x.monto;
        totCta[x.cuenta] = (totCta[x.cuenta] || 0) + x.monto;
        totMet[x.metodo] = (totMet[x.metodo] || 0) + x.monto;
        totEmpC[x.empresa_cuenta] = (totEmpC[x.empresa_cuenta] || 0) + x.monto;
      });
      const bloque = (titulo, obj) => {
        const r = ws.addRow([titulo]); r.font = { bold: true };
        Object.entries(obj).forEach(([k, v]) => {
          const row = ws.addRow(['', k]); row.getCell(15).value = v; row.getCell(15).numFmt = '#,##0.00';
        });
      };
      bloque('TOTALES POR EMPRESA DUEÑA DE LA CUENTA', totEmpC);
      bloque('TOTALES POR EMPRESA QUE GESTIONA', totEmpF);
      bloque('TOTALES POR CUENTA', totCta);
      bloque('TOTALES POR MÉTODO', totMet);
      const g = ws.addRow(['TOTAL GENERAL']); g.font = { bold: true };
      g.getCell(15).value = lista.reduce((s, x) => s + x.monto, 0); g.getCell(15).numFmt = '#,##0.00';

      // ── Hojas agrupadas por comprobante ──
      // Función que arma una hoja para un tipo ('factura' o 'boleta')
      // Hoja agrupada por comprobante. Filtra por fecha de EMISIÓN del comprobante
      // (para cuadrar con la lista del contador), y muestra TODOS los pagos de cada venta,
      // sin importar el mes en que se pagaron.
      const armarHojaComprobante = async (tipoComp) => {
        const etiqueta = tipoComp === 'factura' ? 'Facturas' : 'Boletas';
        const ws2 = wb.addWorksheet('Por ' + etiqueta.toLowerCase());

        // 1) Comprobantes de este tipo emitidos dentro del rango de fechas
        const desde = req.query.desde, hasta = req.query.hasta;
        const cond = [`sv.type = ?`]; const params = [tipoComp];
        if (desde) { cond.push('sv.emission_date >= ?'); params.push(desde); }
        if (hasta) { cond.push('sv.emission_date <= ?'); params.push(hasta); }
        // Filtro opcional por empresa que gestiona (mismo criterio que el reporte)
        if (req.query.empresa) { cond.push('s.company_id = ?'); params.push(req.query.empresa); }
        const [comps] = await prodPool.query(`
          SELECT sv.sale_id, sv.type, sv.serie, sv.number, sv.emission_date, sv.amount,
            s.code AS venta, s.total AS total_venta,
            CASE WHEN cli.is_company=1 THEN cli.business_name
                 ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente,
            cli.document_number AS cliente_doc
          FROM sale_vouchers sv
          JOIN sales s ON s.id = sv.sale_id
          LEFT JOIN parties cli ON cli.id = s.customer_id
          WHERE ${cond.join(' AND ')} AND s.deleted_at IS NULL
          ORDER BY sv.emission_date, sv.number`, params);

        // 2) Todos los pagos válidos de esas ventas (de cualquier fecha)
        const saleIdsComp = [...new Set(comps.map(c => c.sale_id))];
        const pagosPorVenta = {};
        if (saleIdsComp.length) {
          const [pgs] = await prodPool.query(`
            SELECT sp.sale_id, sp.amount, sp.paid_at, ci.name AS metodo,
              banco.name AS banco_nombre, ba.account_number
            FROM sale_payments sp
            LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
            LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
            LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
            WHERE sp.sale_id IN (?) AND sp.voided_at IS NULL
            ORDER BY sp.paid_at`, [saleIdsComp]);
          pgs.forEach(p => {
            const banco = p.account_number
              ? `${p.banco_nombre || ''} ${p.account_number}`.trim() : '—';
            (pagosPorVenta[p.sale_id] = pagosPorVenta[p.sale_id] || []).push({
              fecha: p.paid_at, monto: Number(p.amount), metodo: p.metodo || '—', banco
            });
          });
        }

        // 3) Agrupar por venta: juntar sus comprobantes de este tipo y sus pagos
        const porVenta = {};
        comps.forEach(c => {
          const g = porVenta[c.sale_id] = porVenta[c.sale_id] || {
            venta: c.venta, cliente: (c.cliente || '').trim() || '—', cliente_doc: c.cliente_doc || '—',
            comprobantes: new Map(), total_venta: Number(c.total_venta || 0)
          };
          if (!g.comprobantes.has(`${c.serie}-${c.number}`)) {
            g.comprobantes.set(`${c.serie}-${c.number}`, { importe: Number(c.amount || 0), fecha: c.emission_date });
          }
        });

        const grupos = Object.entries(porVenta).map(([sid, g]) => {
          const codigos = [...g.comprobantes.keys()];
          const importe = [...g.comprobantes.values()].reduce((s, c) => s + c.importe, 0);
          const fechaMin = [...g.comprobantes.values()].map(c => c.fecha).filter(Boolean).sort()[0] || null;
          const pagos = pagosPorVenta[sid] || [];
          return { ...g, codigos, importe_comp: importe, fecha_emision: fechaMin, pagos };
        }).sort((a, b) => new Date(a.fecha_emision || 0) - new Date(b.fecha_emision || 0));

        // 4) Escribir la hoja
        ws2.mergeCells('A1:H1');
        ws2.getCell('A1').value = `${etiqueta} emitidas del ${desde || ''} al ${hasta || ''} (filtrado por fecha de emisión) y todos sus pagos`;
        ws2.getCell('A1').font = { bold: true, size: 13 };
        ws2.addRow([]);
        const hr = ws2.addRow(['Comprobante(s)', 'Venta', 'Fecha emisión', 'Cliente / Método', 'RUC/DNI / Banco',
          'Importe comprobante', 'Total pagado', 'Estado']);
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        const headerRow2 = hr.number;

        if (!grupos.length) {
          ws2.addRow([`(No se emitieron ${etiqueta.toLowerCase()} en este rango de fechas)`]);
        }
        grupos.forEach(gr => {
          const totalPagado = gr.pagos.reduce((s, x) => s + Number(x.monto), 0);
          const dif = Math.round((Number(gr.importe_comp) - totalPagado) * 100) / 100;
          const estado = Math.abs(dif) < 0.01 ? 'Cuadra'
            : (dif > 0 ? 'Falta cobrar S/ ' + dif.toFixed(2) : 'Pagado de más S/ ' + Math.abs(dif).toFixed(2));
          const fila = ws2.addRow([
            gr.codigos.join(' + '), gr.venta,
            gr.fecha_emision ? fechaLima(gr.fecha_emision).split(',')[0] : '',
            gr.cliente, gr.cliente_doc,
            Number(gr.importe_comp), totalPagado, estado
          ]);
          fila.font = { bold: true };
          if (Math.abs(dif) >= 0.01) fila.getCell(8).font = { color: { argb: 'FFCC0000' }, bold: true };
          // Sub-filas: TODOS los pagos de la venta (de cualquier mes)
          if (!gr.pagos.length) {
            const sub = ws2.addRow(['', '', '   (sin pagos registrados)', '', '', '', '', '']);
            sub.font = { color: { argb: 'FF999999' }, size: 10, italic: true };
          }
          gr.pagos.forEach(pg => {
            const sub = ws2.addRow(['', '', '   ↳ ' + fechaLima(pg.fecha).split(',')[0],
              pg.metodo, pg.banco || '—', '', Number(pg.monto), '']);
            sub.font = { color: { argb: 'FF666666' }, size: 10 };
          });
        });
        [6, 7].forEach(c => ws2.getColumn(c).numFmt = '#,##0.00');
        [24, 16, 22, 30, 26, 18, 15, 22].forEach((w, i) => ws2.getColumn(i + 1).width = w);
        ws2.views = [{ state: 'frozen', ySplit: headerRow2 }];
      };

      const tcomp = req.query.tipo_comprobante;
      if (tcomp === 'factura') {
        await armarHojaComprobante('factura');
      } else if (tcomp === 'boleta') {
        await armarHojaComprobante('boleta');
      } else {
        // "Facturas y boletas": incluir las dos hojas agrupadas
        await armarHojaComprobante('factura');
        await armarHojaComprobante('boleta');
      }

      const nombre = nombreTrazable('pagos');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
  });



};
