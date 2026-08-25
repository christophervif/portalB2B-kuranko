// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Sincronización web + Auditoría de catálogo
//  Reporte de la corrida del puente WooCommerce, auditoría de catálogo,
//  chequeo de empresas, cola de SKUs manuales y solicitud de actualización.
//  Recibe del index.js las piezas compartidas y usa comunes.js para helpers.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel } = require('./comunes');

module.exports = function registrarSincronizacion({ app, authAdmin, requiereModulo, prodPool, portalPool }) {

  // Prepara la tabla de caché de auditoría (se llama al arrancar el servidor)
  async function prepararTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS auditoria_cache (
        id INT PRIMARY KEY DEFAULT 1,
        generado_en DATETIME,
        resultado LONGTEXT
      )
    `);
  }

  app.get('/admin/reporte-sync', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      // ── Última corrida del puente ──────────────────────────────────────────
      let ultimaCorrida = null;
      try {
        const [[c]] = await portalPool.query(
          `SELECT corrio_en, productos_actualizados, productos_error, modo
           FROM sync_corridas ORDER BY id DESC LIMIT 1`);
        if (c) ultimaCorrida = c;
      } catch (e) { /* la tabla puede no existir aún */ }

      // ── Detalle de la corrida: variaciones (todo lo que cambió) y aplicados ─
      let variaciones = [], aplicados = [];
      try {
        const [rows] = await portalPool.query(
          `SELECT variation_id, woocommerce_id, tipo, stock_antes, precio_antes,
                  stock_despues, precio_despues, oferta_antes, oferta_despues, se_aplico
           FROM sync_detalle ORDER BY se_aplico DESC, woocommerce_id`);
        variaciones = rows;
        aplicados = rows.filter(r => r.se_aplico === 1);
      } catch (e) { /* sin detalle aún */ }

      // Enriquecer variaciones/aplicados con SKU y nombre del ERP
      const idsDet = [...new Set(variaciones.map(v => v.woocommerce_id).filter(Boolean))];
      const infoDet = {};
      if (idsDet.length) {
        const [info] = await prodPool.query(
          `SELECT pv.woocommerce_id, pv.sku, pv.name AS nombre, pv.product_type
           FROM product_variations pv WHERE pv.woocommerce_id IN (?)`, [idsDet]);
        info.forEach(i => { infoDet[i.woocommerce_id] = i; });
      }
      const armaFila = (v) => {
        const inf = infoDet[v.woocommerce_id] || {};
        return {
          sku: inf.sku || '', wc: v.woocommerce_id, tipo: inf.product_type || v.tipo,
          nombre: inf.nombre || '',
          stock_despues: v.stock_despues, precio_despues: v.precio_despues,
          stock_antes: v.stock_antes, precio_antes: v.precio_antes,
          oferta_antes: v.oferta_antes, oferta_despues: v.oferta_despues
        };
      };
      const filasVariaciones = variaciones.map(armaFila);
      const filasAplicados = aplicados.map(armaFila);

      // (Pendientes y Alertas del sistema se movieron a la Auditoría de catálogo)

      // ── PESTAÑA 4: Alertas de vinculación con WooCommerce ──────────────────
      let alertasSku = [];
      try {
        const [rows] = await portalPool.query(
          `SELECT woocommerce_id, sku_erp, sku_woo FROM sync_sku_alertas ORDER BY sku_erp`);
        alertasSku = rows.map(r => ({
          tipo: 'SKU no coincide', sku: r.sku_erp, wc: r.woocommerce_id, nombre: '',
          obs: `El SKU en la web es "${r.sku_woo}" pero en el ERP es "${r.sku_erp}" (no se actualizó)`
        }));
      } catch (e) { /* sin datos aún */ }

      // ── Generar Excel ──────────────────────────────────────────────────────
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const estiloHeader = (row) => {
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        row.alignment = { vertical: 'middle' };
      };
      let textoCorrida;
      if (ultimaCorrida) {
        const f = new Date(ultimaCorrida.corrio_en).toLocaleString('es-PE', { timeZone: 'America/Lima' });
        textoCorrida = `Última sincronización del puente: ${f}` +
          ` (${ultimaCorrida.productos_actualizados} actualizados, ${ultimaCorrida.productos_error} con error` +
          (ultimaCorrida.modo === 'simulacion' ? ', modo simulación' : '') + ')';
      } else {
        textoCorrida = 'Última sincronización del puente: aún no ha corrido.';
      }
      const textoReporte = `Reporte generado: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`;
      const ponerEncabezado = (ws, nCols) => {
        ws.insertRow(1, [textoCorrida]);
        ws.insertRow(2, [textoReporte]);
        ws.mergeCells(1, 1, 1, nCols);
        ws.mergeCells(2, 1, 2, nCols);
        ws.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
        ws.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
      };
      const num = (v) => v === null || v === undefined ? '' : Number(v);

      // PESTAÑA 1: Variaciones (lo que cambió)
      const ws1 = wb.addWorksheet('Variaciones');
      ws1.columns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'WooCommerce ID', key: 'wc', width: 15 },
        { header: 'Tipo', key: 'tipo', width: 12 },
        { header: 'Nombre', key: 'nombre', width: 42 },
        { header: 'Stock anterior', key: 'sa', width: 13 },
        { header: 'Stock aplicado', key: 'sd', width: 13 },
        { header: 'Precio anterior', key: 'pa', width: 14 },
        { header: 'Precio aplicado', key: 'pd', width: 14 },
        { header: 'Oferta anterior', key: 'oa', width: 14 },
        { header: 'Oferta aplicada', key: 'od', width: 14 }
      ];
      filasVariaciones.forEach(f => ws1.addRow({
        sku: f.sku, wc: f.wc, tipo: f.tipo, nombre: f.nombre,
        sa: num(f.stock_antes), sd: num(f.stock_despues),
        pa: num(f.precio_antes), pd: num(f.precio_despues),
        oa: num(f.oferta_antes), od: num(f.oferta_despues)
      }));
      ponerEncabezado(ws1, 10);
      estiloHeader(ws1.getRow(3));
      ws1.views = [{ state: 'frozen', ySplit: 3 }];

      // PESTAÑA 4: Alertas de vinculación (WooCommerce)
      const ws4 = wb.addWorksheet('Alertas de vinculación');
      ws4.columns = [
        { header: 'Tipo de alerta', key: 'tipo', width: 18 },
        { header: 'SKU (ERP)', key: 'sku', width: 22 },
        { header: 'WooCommerce ID', key: 'wc', width: 15 },
        { header: 'Observación', key: 'obs', width: 60 }
      ];
      alertasSku.forEach(a => ws4.addRow({ tipo: a.tipo, sku: a.sku, wc: a.wc, obs: a.obs }));
      ponerEncabezado(ws4, 4);
      estiloHeader(ws4.getRow(3));
      ws4.views = [{ state: 'frozen', ySplit: 3 }];
      const uf4 = ws4.rowCount;
      ws4.autoFilter = { from: { row: 3, column: 1 }, to: { row: uf4 < 3 ? 3 : uf4, column: 4 } };

      // PESTAÑA 5: Actualizados en WooCommerce (los que sí se aplicaron)
      const ws5 = wb.addWorksheet('Actualizados en WooCommerce');
      ws5.columns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'WooCommerce ID', key: 'wc', width: 15 },
        { header: 'Tipo', key: 'tipo', width: 12 },
        { header: 'Nombre', key: 'nombre', width: 42 },
        { header: 'Stock anterior', key: 'sa', width: 13 },
        { header: 'Stock aplicado', key: 'sd', width: 13 },
        { header: 'Precio anterior', key: 'pa', width: 14 },
        { header: 'Precio aplicado', key: 'pd', width: 14 },
        { header: 'Oferta anterior', key: 'oa', width: 14 },
        { header: 'Oferta aplicada', key: 'od', width: 14 }
      ];
      filasAplicados.forEach(f => ws5.addRow({
        sku: f.sku, wc: f.wc, tipo: f.tipo, nombre: f.nombre,
        sa: num(f.stock_antes), sd: num(f.stock_despues),
        pa: num(f.precio_antes), pd: num(f.precio_despues),
        oa: num(f.oferta_antes), od: num(f.oferta_despues)
      }));
      ponerEncabezado(ws5, 10);
      estiloHeader(ws5.getRow(3));
      ws5.views = [{ state: 'frozen', ySplit: 3 }];

      const fecha = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="reporte_sync_${fecha}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
  });

  // Asegura la tabla que guarda el último análisis de auditoría
  async function asegurarTablaAuditoria() {
    await prepararTablas();
  }

  // Calcula la auditoría del catálogo (pendientes + alertas). Consulta pesada.
  async function calcularAuditoria() {
      // ── PESTAÑA 2: Pendientes (sin woocommerce_id) ─────────────────────────
      // Solo se muestran los que tienen stock > 0, O los que tienen un ingreso
      // pendiente por llegar (una venta en backorder con pending_stock_entry_id).
      const [pendientes] = await prodPool.query(
        `SELECT pv.sku, pv.product_type, pv.name AS nombre, pv.regular_price,
                COALESCE(SUM(ls.quantity),0) AS stock,
                EXISTS(
                  SELECT 1 FROM sale_items si
                  WHERE si.product_variation_id = pv.id
                    AND si.pending_stock_entry_id IS NOT NULL
                ) AS ingreso_pendiente
         FROM product_variations pv
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
         WHERE pv.woocommerce_id IS NULL
           AND pv.product_type IN ('variation','simple')
           AND pv.deleted_at IS NULL
         GROUP BY pv.id, pv.sku, pv.product_type, pv.name, pv.regular_price
         HAVING stock > 0 OR ingreso_pendiente = 1
         ORDER BY pv.name, pv.sku`);

      // ── PESTAÑA 3: Alertas del sistema (todo del ERP) ──────────────────────
      // Traemos datos base de productos con stock, y datos para cada regla.
      const NOM_ESTADO = { draft: 'borrador', discontinued: 'descontinuado', active: 'activo' };

      // Consulta principal: variaciones con su stock, precios, estado, descripción del padre e imagen.
      const [base] = await prodPool.query(
        `SELECT pv.id AS variation_id, pv.woocommerce_id, pv.sku, pv.name AS nombre,
                pv.product_type, pv.status, pv.regular_price, pv.sale_price,
                p.description AS descripcion,
                COALESCE(SUM(ls.quantity),0) AS stock,
                (SELECT COUNT(*) FROM product_images pi
                 WHERE (pi.product_id = p.id OR pi.product_variation_id = pv.id)
                   AND pi.deleted_at IS NULL) AS num_imagenes
         FROM product_variations pv
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
         WHERE pv.product_type IN ('variation','simple')
           AND pv.deleted_at IS NULL
         GROUP BY pv.id, pv.woocommerce_id, pv.sku, pv.name, pv.product_type,
                  pv.status, pv.regular_price, pv.sale_price, p.description, p.id`);

      // Costo FIFO (lote más antiguo con stock) por variación
      const [lotes] = await prodPool.query(
        `SELECT sb.product_variation_id, sb.cost_price, sb.entry_date
         FROM stock_batches sb
         WHERE sb.quantity > 0
         ORDER BY sb.product_variation_id, sb.entry_date ASC, sb.id ASC`);
      const costoFifo = {};
      for (const l of lotes) {
        if (!(l.product_variation_id in costoFifo)) {
          costoFifo[l.product_variation_id] = Number(l.cost_price);
        }
      }

      // SKU duplicados: contamos apariciones del mismo SKU
      const contadorSku = {};
      base.forEach(b => { const k = (b.sku || '').trim(); if (k) contadorSku[k] = (contadorSku[k] || 0) + 1; });

      // Padres 'variable' sin variaciones activas
      const [padresSinHijas] = await prodPool.query(
        `SELECT pv.id AS variation_id, pv.sku, pv.name AS nombre
         FROM product_variations pv
         WHERE pv.product_type = 'variable'
           AND pv.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM product_variations h
             JOIN products p ON p.id = h.product_id
             WHERE p.id = pv.product_id
               AND h.product_type = 'variation'
               AND h.status = 'active'
               AND h.deleted_at IS NULL
           )`);

      // Productos 'variable' (padres) que tienen stock — no deberían (el stock va en las variaciones)
      const [variableConStock] = await prodPool.query(
        `SELECT pv.sku, pv.name AS nombre, pv.woocommerce_id,
                COALESCE(SUM(ls.quantity),0) AS stock
         FROM product_variations pv
         LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
         WHERE pv.product_type = 'variable'
           AND pv.deleted_at IS NULL
         GROUP BY pv.id, pv.sku, pv.name, pv.woocommerce_id
         HAVING COALESCE(SUM(ls.quantity),0) > 0`);

      // Productos 'variable' (padres) con ventas asociadas — no deberían (se venden las variaciones)
      const [variableConVenta] = await prodPool.query(
        `SELECT pv.sku, pv.name AS nombre, pv.woocommerce_id,
                COUNT(si.id) AS num_ventas, COALESCE(SUM(si.quantity),0) AS unidades
         FROM product_variations pv
         JOIN sale_items si ON si.product_variation_id = pv.id
         WHERE pv.product_type = 'variable'
           AND pv.deleted_at IS NULL
         GROUP BY pv.id, pv.sku, pv.name, pv.woocommerce_id`);

      // Construir la lista de alertas del sistema
      const alertasSistema = [];
      const NIVEL_MARGEN = (precio, costo) => {
        if (costo <= 0) return null;
        if (precio <= costo) return 'Nivel 1 - Crítico (venta a pérdida)';
        if (precio < costo * 1.10) return 'Nivel 2 - Riesgo (margen < 10%)';
        if (precio < costo * 1.20) return 'Nivel 3 - Bajo (margen < 20%)';
        return null;
      };

      for (const b of base) {
        const stock = Number(b.stock) || 0;
        const activo = b.status === 'active';
        const sku = (b.sku || '').trim();
        const reg = b.regular_price === null ? null : Number(b.regular_price);
        const sale = b.sale_price === null ? null : Number(b.sale_price);

        // Reglas que requieren stock > 0
        if (stock > 0) {
          // Sin descripción
          if (!b.descripcion || String(b.descripcion).trim() === '') {
            alertasSistema.push({ tipo: 'Falta descripción', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero no tiene descripción` });
          }
          // Sin imagen
          if (!b.num_imagenes || b.num_imagenes === 0) {
            alertasSistema.push({ tipo: 'Falta imagen', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero no tiene imagen registrada` });
          }
          // Sin precio regular
          if (reg === null || reg === 0) {
            alertasSistema.push({ tipo: 'Falta precio', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero no tiene precio regular` });
          }
          // Descontinuado con stock
          if (b.status === 'discontinued') {
            alertasSistema.push({ tipo: 'Descontinuado con stock', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero está en 'descontinuado'` });
          }
          // Margen contra costo FIFO (analiza oferta y regular; alerta si cualquiera cae)
          const costo = costoFifo[b.variation_id];
          if (costo === undefined || costo === null) {
            // costo no registrado — omitir SKU con MKP o PCK
            if (!/MKP|PCK/i.test(sku)) {
              alertasSistema.push({ tipo: 'Costo no registrado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
                obs: `Tiene ${stock} en stock pero no tiene costo FIFO registrado` });
            }
          } else if (costo === 0) {
            if (!/MKP|PCK/i.test(sku)) {
              alertasSistema.push({ tipo: 'Costo no registrado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
                obs: `Tiene ${stock} en stock pero su costo FIFO es 0.00 (no registrado)` });
            }
          } else {
            // Analizar precio de oferta si existe, e indicar; también el regular
            if (sale !== null && sale > 0) {
              const niv = NIVEL_MARGEN(sale, costo);
              if (niv) alertasSistema.push({ tipo: 'Margen bajo', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
                obs: `${niv} — Precio oferta S/${sale.toFixed(2)} vs costo FIFO S/${costo.toFixed(2)}` });
            }
            if (reg !== null && reg > 0) {
              const niv = NIVEL_MARGEN(reg, costo);
              if (niv) alertasSistema.push({ tipo: 'Margen bajo', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
                obs: `${niv} — Precio regular S/${reg.toFixed(2)} vs costo FIFO S/${costo.toFixed(2)}` });
            }
          }
        }

        // Reglas que NO dependen de stock
        // Oferta >= regular
        if (sale !== null && sale > 0 && reg !== null && reg > 0 && sale >= reg) {
          alertasSistema.push({ tipo: 'Oferta mal puesta', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `Precio de oferta S/${sale.toFixed(2)} es mayor o igual al regular S/${reg.toFixed(2)}` });
        }
        // SKU duplicado
        if (sku && contadorSku[sku] > 1) {
          alertasSistema.push({ tipo: 'SKU duplicado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `El SKU "${sku}" aparece ${contadorSku[sku]} veces en el catálogo` });
        }
      }
      // Padres sin variaciones activas
      padresSinHijas.forEach(p => {
        alertasSistema.push({ tipo: 'Padre sin variaciones', sku: p.sku || '', wc: '', nombre: p.nombre || '',
          obs: `Producto variable sin ninguna variación activa (aparece vacío en la tienda)` });
      });
      // Variable con stock (el stock debería estar en las variaciones, no en el padre)
      variableConStock.forEach(p => {
        alertasSistema.push({ tipo: 'Variable con stock', sku: p.sku || '', wc: p.woocommerce_id || '', nombre: p.nombre || '',
          obs: `Producto tipo variable con ${p.stock} en stock (el stock debería estar en las variaciones, no en el padre)` });
      });
      // Variable con ventas (deberían venderse las variaciones, no el padre)
      variableConVenta.forEach(p => {
        alertasSistema.push({ tipo: 'Variable con venta', sku: p.sku || '', wc: p.woocommerce_id || '', nombre: p.nombre || '',
          obs: `Producto tipo variable con ${p.num_ventas} venta(s) asociada(s) (${p.unidades} unidades) — las ventas deberían ir en las variaciones` });
      });


      return { pendientes, alertas: alertasSistema };
  }


  // ─── Auditoría de catálogo en pantalla (JSON) ────────────────────────────────
  // force=1 → recalcula y guarda; sin force → devuelve el último guardado (si existe)
  app.get('/admin/auditoria', authAdmin, requiereModulo('auditoria'), async (req, res) => {
    try {
      await asegurarTablaAuditoria();
      const forzar = req.query.force === '1';

      if (!forzar) {
        // Intentar devolver el último análisis guardado
        const [[row]] = await portalPool.query(
          'SELECT generado_en, resultado FROM auditoria_cache WHERE id = 1');
        if (row && row.resultado) {
          const data = JSON.parse(row.resultado);
          data.generado_en = row.generado_en;
          data.desde_cache = true;
          return res.json(data);
        }
        // No hay guardado aún → avisar que hay que analizar
        return res.json({ sin_analisis: true });
      }

      // Forzar: recalcular
      const { pendientes, alertas } = await calcularAuditoria();
      const conteo = {};
      alertas.forEach(a => { conteo[a.tipo] = (conteo[a.tipo] || 0) + 1; });
      const data = {
        generado_en: new Date(),
        total_pendientes: pendientes.length,
        total_alertas: alertas.length,
        conteo_por_tipo: conteo,
        pendientes: pendientes.map(p => ({
          sku: p.sku, tipo: p.product_type, nombre: p.nombre || '',
          precio: p.regular_price === null ? null : Number(p.regular_price), stock: p.stock,
          ingreso_pendiente: !!p.ingreso_pendiente
        })),
        alertas
      };
      // Guardar (sobrescribe el anterior)
      await portalPool.query(
        `INSERT INTO auditoria_cache (id, generado_en, resultado) VALUES (1, NOW(), ?)
         ON DUPLICATE KEY UPDATE generado_en = NOW(), resultado = VALUES(resultado)`,
        [JSON.stringify(data)]);
      data.desde_cache = false;
      res.json(data);
    } catch (e) { res.status(500).json({ error: 'Error al analizar el catálogo: ' + e.message }); }
  });

  // ─── Auditoría de catálogo en Excel (2 pestañas) ─────────────────────────────
  // ── CHEQUEO: coherencia de empresa vendedora vs dueño de los productos ──
  // Detecta: (1) ventas sin empresa vendedora, (2) ventas donde algún producto
  // pertenece a otra empresa, (3) productos sin lote (sin dueño identificable).
  // Solo LECTURA: no corrige nada en el ERP, solo lista para revisar.
  async function obtenerChequeoEmpresas(q) {
    const { tipo } = q; // 'sin_empresa' | 'no_coincide' | 'sin_lote' | undefined (todos)
    const [rows] = await prodPool.query(`
      SELECT s.id, s.code, s.company_id AS empresa_venta, s.status, s.created_at, s.total,
        si.id AS item_id, si.is_backorder, si.pending_stock_entry_id,
        sb.company_id AS empresa_producto,
        pv.sku, p.name AS producto
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
      LEFT JOIN product_variations pv ON pv.id = si.product_variation_id
      LEFT JOIN products p ON p.id = pv.product_id
      WHERE s.deleted_at IS NULL AND s.status != 'cancelled'
      ORDER BY s.created_at DESC`);

    // Agrupar por venta
    const porVenta = {};
    rows.forEach(r => {
      if (!porVenta[r.id]) {
        porVenta[r.id] = {
          id: r.id, code: r.code, empresa_venta: r.empresa_venta,
          status: r.status, fecha: r.created_at, total: Number(r.total),
          items: [], problemas: new Set()
        };
      }
      const v = porVenta[r.id];
      const aPedido = !!(r.is_backorder || r.pending_stock_entry_id);
      v.items.push({
        sku: r.sku || '—', producto: r.producto || '—',
        empresa_producto: r.empresa_producto, a_pedido: aPedido
      });
      // Detectar problemas
      if (r.empresa_venta == null) v.problemas.add('sin_empresa');
      if (r.empresa_producto == null) v.problemas.add('sin_lote');
      else if (r.empresa_venta != null && Number(r.empresa_producto) !== Number(r.empresa_venta)) {
        v.problemas.add('no_coincide');
      }
    });

    let lista = Object.values(porVenta)
      .filter(v => v.problemas.size > 0)
      .map(v => ({
        ...v,
        problemas: [...v.problemas],
        empresas_producto: [...new Set(v.items.map(i => i.empresa_producto).filter(x => x != null))],
        num_items: v.items.length
      }));

    if (tipo) lista = lista.filter(v => v.problemas.includes(tipo));
    return lista;
  }

  app.get('/admin/chequeo-empresas', authAdmin, requiereModulo('auditoria'), async (req, res) => {
    try {
      const lista = await obtenerChequeoEmpresas(req.query);
      const conteo = { sin_empresa: 0, no_coincide: 0, sin_lote: 0 };
      lista.forEach(v => v.problemas.forEach(p => conteo[p] = (conteo[p] || 0) + 1));
      res.json({ total: lista.length, conteo, ventas: lista.slice(0, 500) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/chequeo-empresas-excel', authAdmin, requiereModulo('auditoria'), async (req, res) => {
    try {
      const lista = await obtenerChequeoEmpresas(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Chequeo empresas');
      const fechaLima = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';
      const NOMBRE_PROB = { sin_empresa: 'Sin empresa vendedora', no_coincide: 'Empresa no coincide', sin_lote: 'Producto sin lote' };

      const filasCab = cabeceraExcel(ws, 'Chequeo de empresa en ventas', [
        ['Filtro', req.query.tipo ? NOMBRE_PROB[req.query.tipo] : 'Todos'],
        ['Ventas con problema', lista.length]
      ], 8);
      const colDefs = [
        { header: 'Venta', width: 15 }, { header: 'Fecha', width: 12 }, { header: 'Estado', width: 15 },
        { header: 'Empresa vendedora', width: 26 }, { header: 'Empresa(s) del producto', width: 26 },
        { header: 'Problema(s)', width: 40 }, { header: 'Items', width: 8 }, { header: 'Total', width: 13 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

      lista.forEach(v => ws.addRow([
        v.code, fechaLima(v.fecha), v.status,
        v.empresa_venta != null ? (EMPRESAS_BI[v.empresa_venta] || 'Empresa ' + v.empresa_venta) : '(vacío)',
        v.empresas_producto.length ? v.empresas_producto.map(e => EMPRESAS_BI[e] || 'Empresa ' + e).join(', ') : '(sin lote)',
        v.problemas.map(p => NOMBRE_PROB[p] || p).join(' · '),
        v.num_items, v.total
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      ws.getColumn(8).numFmt = '#,##0.00';

      const nombre = nombreTrazable('chequeo-empresas');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });

  app.get('/admin/auditoria-excel', authAdmin, requiereModulo('auditoria'), async (req, res) => {
    try {
      const { pendientes, alertas } = await calcularAuditoria();
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const estiloHeader = (row) => {
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        row.alignment = { vertical: 'middle' };
      };
      const textoGen = `Auditoría generada: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`;
      const ponerEncabezado = (ws, nCols) => {
        ws.insertRow(1, [textoGen]);
        ws.mergeCells(1, 1, 1, nCols);
        ws.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
      };

      // Pestaña Pendientes
      const ws1 = wb.addWorksheet('Pendientes');
      ws1.columns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'Tipo', key: 'tipo', width: 12 },
        { header: 'Nombre', key: 'nombre', width: 45 },
        { header: 'Precio regular', key: 'precio', width: 15 },
        { header: 'Stock', key: 'stock', width: 10 },
        { header: 'Ingreso pendiente', key: 'ing', width: 16 }
      ];
      pendientes.forEach(p => ws1.addRow({
        sku: p.sku, tipo: p.product_type, nombre: p.nombre || '',
        precio: p.regular_price === null ? '' : Number(p.regular_price), stock: p.stock,
        ing: p.ingreso_pendiente ? 'Sí' : 'No'
      }));
      ponerEncabezado(ws1, 6);
      estiloHeader(ws1.getRow(2));
      ws1.views = [{ state: 'frozen', ySplit: 2 }];

      // Pestaña Alertas del sistema (con filtro)
      const ws2 = wb.addWorksheet('Alertas del sistema');
      ws2.columns = [
        { header: 'Tipo de alerta', key: 'tipo', width: 22 },
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'WooCommerce ID', key: 'wc', width: 15 },
        { header: 'Nombre', key: 'nombre', width: 38 },
        { header: 'Observación', key: 'obs', width: 55 }
      ];
      alertas.forEach(a => ws2.addRow({ tipo: a.tipo, sku: a.sku, wc: a.wc, nombre: a.nombre, obs: a.obs }));
      ponerEncabezado(ws2, 5);
      estiloHeader(ws2.getRow(2));
      ws2.views = [{ state: 'frozen', ySplit: 2 }];
      const uf = ws2.rowCount;
      ws2.autoFilter = { from: { row: 2, column: 1 }, to: { row: uf < 2 ? 2 : uf, column: 5 } };

      const fecha = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="auditoria_catalogo_${fecha}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar la auditoría: ' + e.message }); }
  });

  // Solicitar una actualización completa (se aplicará en la corrida de las 2 AM)
  app.post('/admin/solicitar-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS sync_solicitudes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          solicitado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
          atendida TINYINT(1) DEFAULT 0,
          atendida_en DATETIME NULL
        )`);
      // Si ya hay una pendiente, no duplicar
      const [[pend]] = await portalPool.query(
        `SELECT id, solicitado_en FROM sync_solicitudes WHERE atendida = 0 ORDER BY id ASC LIMIT 1`);
      if (pend) {
        return res.json({ ok: true, ya_existia: true,
          mensaje: 'Ya hay una solicitud pendiente. Se aplicará en la próxima sincronización de las 2 AM.' });
      }
      await portalPool.query('INSERT INTO sync_solicitudes () VALUES ()');
      res.json({ ok: true, ya_existia: false,
        mensaje: 'Solicitud registrada. Se aplicará en la próxima sincronización de las 2 AM (hora Perú).' });
    } catch (e) { res.status(500).json({ error: 'Error al registrar la solicitud: ' + e.message }); }
  });

  // Estado de la solicitud (para mostrar en el admin)
  app.get('/admin/estado-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      const [[pend]] = await portalPool.query(
        `SELECT solicitado_en FROM sync_solicitudes WHERE atendida = 0 ORDER BY id ASC LIMIT 1`);
      res.json({ pendiente: !!pend, solicitado_en: pend ? pend.solicitado_en : null });
    } catch (e) { res.json({ pendiente: false }); }
  });

  // Cancelar la solicitud de actualización completa pendiente (antes de que corra a las 2 AM)
  app.post('/admin/cancelar-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      const [r] = await portalPool.query(
        `UPDATE sync_solicitudes SET atendida = 1, atendida_en = NOW() WHERE atendida = 0`);
      res.json({ ok: true, canceladas: r.affectedRows || 0 });
    } catch (e) { res.status(500).json({ error: 'Error al cancelar: ' + e.message }); }
  });

  // ─── Cola de SKUs manuales (se fuerzan en la próxima corrida del puente) ──
  async function asegurarColaSku() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS sync_cola_sku (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sku VARCHAR(255) NOT NULL,
        actualizar_oferta TINYINT(1) DEFAULT 0,
        agregado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        atendido TINYINT(1) DEFAULT 0,
        atendido_en DATETIME NULL
      )`);
    try {
      await portalPool.query(`ALTER TABLE sync_cola_sku ADD COLUMN actualizar_oferta TINYINT(1) DEFAULT 0`);
    } catch (e) { /* la columna ya existe */ }
  }

  // Agregar SKUs a la cola. Acepta texto pegado desde Excel (uno por línea, comas, o espacios).
  app.post('/admin/sync-cola-sku', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      await asegurarColaSku();
      const texto = (req.body && req.body.skus) || '';
      const actualizarOferta = !!(req.body && req.body.actualizar_oferta);
      // Separar por saltos de línea, comas, tabs, punto y coma o espacios múltiples
      const skus = [...new Set(
        String(texto).split(/[\r\n,;\t]+/).map(s => s.trim()).filter(Boolean)
      )];
      if (!skus.length) return res.status(400).json({ error: 'No se recibieron SKUs.' });
      if (skus.length > 5000) return res.status(400).json({ error: 'Demasiados SKUs (máximo 5000 por vez).' });
      // Insertar solo los que no estén ya pendientes en la cola
      const [existentes] = await portalPool.query(
        `SELECT sku FROM sync_cola_sku WHERE atendido = 0`);
      const yaEnCola = new Set(existentes.map(r => (r.sku || '').trim().toLowerCase()));
      const nuevos = skus.filter(s => !yaEnCola.has(s.toLowerCase()));
      if (nuevos.length) {
        await portalPool.query(
          `INSERT INTO sync_cola_sku (sku, actualizar_oferta) VALUES ?`,
          [nuevos.map(s => [s, actualizarOferta ? 1 : 0])]);
      }
      res.json({
        ok: true, recibidos: skus.length, agregados: nuevos.length,
        ya_estaban: skus.length - nuevos.length, actualizar_oferta: actualizarOferta,
        mensaje: `${nuevos.length} SKU(s) en cola${actualizarOferta ? ' (con precio oferta)' : ''}. Se aplicarán en la próxima corrida (2 AM) o cuando ejecutes el puente en Railway.`
      });
    } catch (e) { res.status(500).json({ error: 'Error al encolar: ' + e.message }); }
  });

  // Ver qué hay en la cola pendiente
  app.get('/admin/sync-cola-sku', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      await asegurarColaSku();
      const [rows] = await portalPool.query(
        `SELECT sku, actualizar_oferta, agregado_en FROM sync_cola_sku WHERE atendido = 0 ORDER BY agregado_en DESC`);
      const conOferta = rows.filter(r => r.actualizar_oferta === 1).length;
      res.json({ total: rows.length, con_oferta: conOferta, skus: rows });
    } catch (e) { res.json({ total: 0, skus: [] }); }
  });

  // Vaciar la cola pendiente (por si te equivocaste al pegar)
  app.post('/admin/sync-cola-sku-vaciar', authAdmin, requiereModulo('sync'), async (req, res) => {
    try {
      const [r] = await portalPool.query(
        `UPDATE sync_cola_sku SET atendido = 1, atendido_en = NOW() WHERE atendido = 0`);
      res.json({ ok: true, vaciados: r.affectedRows || 0 });
    } catch (e) { res.status(500).json({ error: 'Error al vaciar: ' + e.message }); }
  });



  // Devuelve funciones que el index necesita al arrancar
  return { prepararTablas };
};
