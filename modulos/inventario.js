// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Inventario
//  Análisis de capital parado, resumen, stock por sucursal, restock,
//  exportador de inventario y candidatos a promoción.
//  Usa comunes.js para helpers y las constantes de ganancia (margen FIFO).
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel, nombreProdVar, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA } = require('./comunes');

module.exports = function registrarInventario({ app, authAdmin, mInv, mRestock, prodPool, VV }) {



  async function obtenerInventarioExport(f) {
    f = f || {};
    // Stock y costo promedio ponderado por variación
    const [stock] = await prodPool.query(`
      SELECT sb.product_variation_id,
        SUM(sb.quantity) AS stock,
        SUM(sb.quantity * sb.cost_price) AS capital,
        MIN(sb.entry_date) AS lote_mas_antiguo
      FROM stock_batches sb WHERE sb.quantity > 0
      GROUP BY sb.product_variation_id`);
    const stockMap = {};
    stock.forEach(r => stockMap[r.product_variation_id] = {
      stock: Number(r.stock), capital: Number(r.capital),
      costo_prom: Number(r.stock) > 0 ? Number(r.capital) / Number(r.stock) : 0,
      lote_mas_antiguo: r.lote_mas_antiguo
    });

    // Ventas: 90 días, histórico total y última venta
    const [ventas] = await prodPool.query(`
      SELECT si.product_variation_id,
        SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN si.quantity ELSE 0 END) AS und_90d,
        SUM(si.quantity) AS und_hist,
        SUM(si.total) AS venta_hist,
        MAX(s.created_at) AS ultima_venta
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.deleted_at IS NULL AND s.status IN ${VV}
      GROUP BY si.product_variation_id`);
    const vMap = {};
    ventas.forEach(v => vMap[v.product_variation_id] = v);

    // Categoría y subcategoría (por jerarquía parent_id) del producto
    const [cats] = await prodPool.query(`
      SELECT ppc.product_id, c.name AS cat, c.parent_id, padre.name AS cat_padre
      FROM product_product_category ppc
      JOIN product_categories c ON c.id = ppc.product_category_id
      LEFT JOIN product_categories padre ON padre.id = c.parent_id`);
    // Para cada producto: si la categoría tiene padre, es subcategoría; el padre es la categoría
    const catMap = {};
    cats.forEach(r => {
      const m = catMap[r.product_id] = catMap[r.product_id] || { categoria: new Set(), subcategoria: new Set() };
      if (r.parent_id) { m.categoria.add(r.cat_padre); m.subcategoria.add(r.cat); }
      else m.categoria.add(r.cat);
    });

    // Catálogo base (variaciones activas)
    const [prods] = await prodPool.query(`
      SELECT pv.id AS vid, pv.sku, pv.name AS variacion,
        pv.regular_price, pv.sale_price,
        p.id AS pid, p.name AS producto
      FROM product_variations pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
        AND pv.status = 'active'`);

    const hoy = Date.now();
    const dias = d => d ? Math.floor((hoy - new Date(d).getTime()) / 864e5) : null;

    let items = prods.map(p => {
      const st = stockMap[p.vid] || { stock: 0, capital: 0, costo_prom: 0, lote_mas_antiguo: null };
      const v = vMap[p.vid] || {};
      const c = catMap[p.pid] || {};
      const precio = p.sale_price != null && Number(p.sale_price) > 0 ? Number(p.sale_price) : Number(p.regular_price || 0);
      const costo = st.costo_prom;
      const margenPct = precio > 0 ? Math.round((precio - costo) / precio * 1000) / 10 : null;
      const und90 = Number(v.und_90d || 0);
      const ritmoMes = und90 / 3; // 90 días = 3 meses
      return {
        sku: p.sku,
        producto: nombreProdVar(p.producto, p.variacion),
        marca: (p.producto || '').trim().split(/\s+/)[0] || '—',
        categoria: c.categoria ? [...c.categoria].join(', ') : '—',
        subcategoria: c.subcategoria ? [...c.subcategoria].join(', ') : '—',
        stock: st.stock,
        costo_prom: Math.round(costo * 100) / 100,
        capital: Math.round(st.capital * 100) / 100,
        precio_venta: precio,
        margen_pct: margenPct,
        ganancia_unit: Math.round((precio - costo) * 100) / 100,
        und_90d: und90,
        und_hist: Number(v.und_hist || 0),
        venta_hist: Math.round(Number(v.venta_hist || 0) * 100) / 100,
        ultima_venta: v.ultima_venta || null,
        dias_sin_venta: dias(v.ultima_venta),
        meses_para_agotar: ritmoMes > 0 ? Math.round((st.stock / ritmoMes) * 10) / 10 : null
      };
    });

    // Filtros
    if (f.marca) items = items.filter(x => x.marca.toLowerCase() === f.marca.toLowerCase());
    if (f.categoria) items = items.filter(x =>
      x.categoria.split(', ').some(c => c.toLowerCase() === f.categoria.toLowerCase()));
    if (f.subcategoria) items = items.filter(x =>
      x.subcategoria.split(', ').some(c => c.toLowerCase() === f.subcategoria.toLowerCase()));
    if (f.solo_stock === '1') items = items.filter(x => x.stock > 0);
    if (f.solo_ventas === '1') items = items.filter(x => x.und_hist > 0);
    if (f.margen_min) items = items.filter(x => x.margen_pct != null && x.margen_pct >= Number(f.margen_min));
    if (f.margen_max) items = items.filter(x => x.margen_pct != null && x.margen_pct <= Number(f.margen_max));

    items.sort((a, b) => b.capital - a.capital);

    // Listas para los desplegables (marcas, categorías, subcategorías presentes)
    const marcas = [...new Set(items.map(x => x.marca))].filter(m => m !== '—').sort();
    return { total: items.length, items, marcas };
  }


  app.get('/api/inventario-export-filtros', authAdmin, mRestock, async (req, res) => {
    try {
      const [prods] = await prodPool.query(`
        SELECT DISTINCT TRIM(SUBSTRING_INDEX(TRIM(p.name), ' ', 1)) AS marca
        FROM products p
        WHERE p.deleted_at IS NULL AND p.name IS NOT NULL AND p.name != ''
        ORDER BY marca`);
      const [cats] = await prodPool.query(`
        SELECT id, name, parent_id FROM product_categories
        WHERE is_active = 1 ORDER BY name`);
      res.json({
        marcas: prods.map(r => r.marca).filter(Boolean),
        categorias: cats.filter(c => c.parent_id == null).map(c => c.name),
        subcategorias: cats.filter(c => c.parent_id != null).map(c => c.name)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/inventario-export', authAdmin, mRestock, async (req, res) => {
    try { res.json(await obtenerInventarioExport(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/inventario-export-excel', authAdmin, mRestock, async (req, res) => {
    try {
      const d = await obtenerInventarioExport(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Inventario');
      const fechaLima = x => x ? new Date(x).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';
      const filasCab = cabeceraExcel(ws, 'Inventario con ventas y margen', [
        ['Marca', req.query.marca || 'Todas'],
        ['Categoría', req.query.categoria || 'Todas'],
        ['Productos', d.total]
      ], 16);
      const colDefs = [
        { header: 'SKU', width: 18 }, { header: 'Producto', width: 46 }, { header: 'Marca', width: 14 },
        { header: 'Categoría', width: 18 }, { header: 'Subcategoría', width: 18 },
        { header: 'Stock', width: 9 }, { header: 'Costo prom. (S/)', width: 14 },
        { header: 'Capital (S/)', width: 13 }, { header: 'Precio venta (S/)', width: 14 },
        { header: 'Margen %', width: 10 }, { header: 'Ganancia unit. (S/)', width: 15 },
        { header: 'Vendidas 90d', width: 12 }, { header: 'Vendidas histórico', width: 15 },
        { header: 'Venta histórica (S/)', width: 17 }, { header: 'Última venta', width: 13 },
        { header: 'Días sin venta', width: 13 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      d.items.forEach(x => ws.addRow([
        x.sku, x.producto, x.marca, x.categoria, x.subcategoria, x.stock, x.costo_prom,
        x.capital, x.precio_venta, x.margen_pct, x.ganancia_unit, x.und_90d, x.und_hist,
        x.venta_hist, fechaLima(x.ultima_venta), x.dias_sin_venta != null ? x.dias_sin_venta : 'nunca'
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      ws.autoFilter = { from: { row: filasCab + 1, column: 1 }, to: { row: filasCab + 1, column: 16 } };
      [7, 8, 9, 11, 14].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('inventario');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });






  app.get('/api/inventario-analisis', authAdmin, mInv, async (req, res) => {
    try {
      const [stock] = await prodPool.query(`
        SELECT sb.product_variation_id,
          SUM(sb.quantity) AS stock,
          SUM(sb.quantity * sb.cost_price) AS capital,
          MIN(sb.entry_date) AS lote_mas_antiguo
        FROM stock_batches sb
        WHERE sb.quantity > 0
        GROUP BY sb.product_variation_id`);
      if (!stock.length) return res.json({ productos: [], marcas: [] });
      const ids = stock.map(r => r.product_variation_id);

      const [ventas] = await prodPool.query(`
        SELECT si.product_variation_id,
          SUM(si.quantity) AS unidades_12m, MAX(s.created_at) AS ultima_venta
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
          AND si.product_variation_id IN (?)
        GROUP BY si.product_variation_id`, [ids]);
      const vMap = {}; ventas.forEach(v => vMap[v.product_variation_id] = v);

      const [nombres] = await prodPool.query(`
        SELECT pv.id, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (?)`, [ids]);
      const nMap = {}; nombres.forEach(n => nMap[n.id] = n);

      const hoy = Date.now();
      const dias = f => f ? Math.floor((hoy - new Date(f).getTime()) / 864e5) : null;

      const items = stock.map(r => {
        const v = vMap[r.product_variation_id] || {};
        const n = nMap[r.product_variation_id] || {};
        const und12 = Number(v.unidades_12m || 0);
        const stockN = Number(r.stock);
        const ritmoMes = und12 / 12;
        return {
          sku: n.sku || '—',
          marca: (n.producto || '').trim().split(/\s+/)[0] || '—',
          producto: nombreProdVar(n.producto, n.variacion),
          stock: stockN,
          capital: Number(r.capital || 0),
          unidades_12m: und12,
          dias_sin_venta: dias(v.ultima_venta),
          meses_para_agotar: ritmoMes > 0 ? Math.round((stockN / ritmoMes) * 10) / 10 : null
        };
      });

      // 1) Los 15 productos con más capital parado que no rotan
      const estancados = items
        .filter(x => x.dias_sin_venta == null || x.dias_sin_venta >= 120)
        .sort((a, b) => b.capital - a.capital)
        .slice(0, 15);

      // 2) Las 15 marcas con más dinero en stock que peor rotan
      const porMarca = {};
      items.forEach(x => {
        const m = porMarca[x.marca] = porMarca[x.marca] ||
          { marca: x.marca, capital: 0, stock: 0, unidades_12m: 0, referencias: 0, sin_venta: 0 };
        m.capital += x.capital; m.stock += x.stock;
        m.unidades_12m += x.unidades_12m; m.referencias++;
        if (x.dias_sin_venta == null || x.dias_sin_venta >= 120) m.sin_venta++;
      });
      const marcas = Object.values(porMarca).map(m => {
        const ritmoMes = m.unidades_12m / 12;
        return { ...m, meses_para_agotar: ritmoMes > 0 ? Math.round((m.stock / ritmoMes) * 10) / 10 : null };
      })
        // "peor vendidas": tardan 12+ meses en agotarse, o directamente no venden
        .filter(m => m.meses_para_agotar == null || m.meses_para_agotar >= 12)
        .sort((a, b) => b.capital - a.capital)
        .slice(0, 15);

      res.json({
        productos: estancados, marcas,
        capital_estancado: estancados.reduce((s, x) => s + x.capital, 0),
        capital_marcas: marcas.reduce((s, x) => s + x.capital, 0)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/inventario-resumen', authAdmin, mInv, async (req, res) => {
    try {
      const [[r]] = await prodPool.query(`
        SELECT COALESCE(SUM(ls.quantity),0) AS unidades_totales,
          COALESCE(SUM(ls.quantity - ls.reserved_quantity),0) AS disponibles,
          COALESCE(SUM(ls.reserved_quantity),0) AS reservadas,
          COUNT(DISTINCT ls.product_variation_id) AS skus_distintos
        FROM location_stocks ls WHERE ls.quantity > 0`);
      const [[val]] = await prodPool.query(`
        SELECT COALESCE(SUM(ls.quantity * sb.cost_price),0) AS valor_inventario
        FROM location_stocks ls
        LEFT JOIN stock_batches sb ON sb.id = (
          SELECT id FROM stock_batches WHERE product_variation_id = ls.product_variation_id ORDER BY id DESC LIMIT 1)
        WHERE ls.quantity > 0`);
      res.json({ ...r, ...val });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/stock-por-sucursal', authAdmin, mInv, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT l.id, l.name AS sucursal, l.type,
          COALESCE(SUM(ls.quantity),0) AS unidades,
          COALESCE(SUM(ls.quantity - ls.reserved_quantity),0) AS disponibles,
          COUNT(DISTINCT ls.product_variation_id) AS skus
        FROM locations l
        LEFT JOIN location_stocks ls ON ls.location_id = l.id AND ls.quantity > 0
        WHERE l.is_active = 1 GROUP BY l.id, l.name, l.type HAVING unidades > 0 ORDER BY unidades DESC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/restock', authAdmin, mRestock, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          COALESCE(stock.disponible,0) AS stock_disponible,
          COALESCE(vendido.unidades_90d,0) AS vendido_90d,
          COALESCE(gan.unidades_hist,0) AS unidades_hist,
          ROUND(COALESCE(vendido.unidades_90d,0)/90, 4) AS ventas_dia,
          ROUND(COALESCE(vendido.unidades_90d,0)/90*26, 1) AS punto_reorden,
          COALESCE(gan.ingreso_confiable,0) AS ingreso_confiable,
          COALESCE(gan.ganancia_hist,0) AS ganancia_hist,
          COALESCE(gan.lineas_pedido,0) AS lineas_pedido, COALESCE(gan.lineas_falla,0) AS lineas_falla,
          CASE WHEN COALESCE(gan.ingreso_confiable,0) > 0
            THEN ROUND(COALESCE(gan.ganancia_hist,0) / gan.ingreso_confiable * 100, 1) ELSE 0 END AS margen_pct,
          CASE WHEN COALESCE(gan.ganancia_hist,0) >= 1000 THEN 'Alto'
               WHEN COALESCE(gan.ganancia_hist,0) >= 300 THEN 'Medio' ELSE 'Bajo' END AS importancia
        FROM product_variations pv JOIN products p ON p.id = pv.product_id
        LEFT JOIN (SELECT product_variation_id, SUM(quantity - reserved_quantity) AS disponible
          FROM location_stocks GROUP BY product_variation_id) stock ON stock.product_variation_id = pv.id
        LEFT JOIN (SELECT si.product_variation_id, SUM(si.quantity) AS unidades_90d
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) AND s.deleted_at IS NULL AND s.status IN ${VV}
          GROUP BY si.product_variation_id) vendido ON vendido.product_variation_id = pv.id
        LEFT JOIN (SELECT si.product_variation_id, SUM(si.quantity) AS unidades_hist,
            SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END) AS ingreso_confiable,
            SUM(${GANANCIA_NORMAL}) AS ganancia_hist,
            COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
            COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          GROUP BY si.product_variation_id) gan ON gan.product_variation_id = pv.id
        WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
          AND COALESCE(vendido.unidades_90d,0) > 0
          AND COALESCE(stock.disponible,0) <= ROUND(COALESCE(vendido.unidades_90d,0)/90*26, 1)
        ORDER BY FIELD(importancia,'Alto','Medio','Bajo'), ganancia_hist DESC LIMIT 80`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


};
