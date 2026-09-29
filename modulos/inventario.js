// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Inventario
//  Análisis de capital parado, resumen y stock por sucursal.
//  (Restock y exportador de inventario → modulos/restock.js)
//  Usa comunes.js para helpers y las constantes de ganancia (margen FIFO).
// ═══════════════════════════════════════════════════════════════════════════

const { nombreProdVar } = require('./comunes');

module.exports = function registrarInventario({ app, authAdmin, mInv, prodPool, VV }) {



  // El exportador de inventario y el Restock se movieron a modulos/restock.js


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




};
