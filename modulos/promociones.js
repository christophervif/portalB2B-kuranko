// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Promociones recomendadas
//  Sugiere productos candidatos a promoción según distintos criterios
//  (stock estancado, sobre-stock, margen alto + venta lenta, lotes antiguos,
//  casi agotados con demanda). Incluye vista en pantalla y exportación a Excel.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel, nombreProdVar, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA } = require('./comunes');

module.exports = function registrarPromociones({ app, authAdmin, mInv, prodPool, VV }) {

  // Nombres legibles de cada criterio de promoción
  const PROMO_NOMBRES = {
    estancado: 'Stock estancado', sobrestock: 'Sobre-stock',
    margen_lento: 'Margen alto + venta lenta', lote_antiguo: 'Lotes antiguos',
    casi_agotado: 'Casi agotados con demanda'
  };


  async function obtenerPromoCandidatos(criterio, filtros) {
    filtros = filtros || {};
    {
      // Base: stock actual + costo por variación (lotes con existencia)
      const [stock] = await prodPool.query(`
        SELECT sb.product_variation_id,
          SUM(sb.quantity) AS stock,
          SUM(sb.quantity * sb.cost_price) AS capital,
          MIN(sb.entry_date) AS lote_mas_antiguo,
          MAX(sb.cost_price) AS costo_ref
        FROM stock_batches sb
        WHERE sb.quantity > 0
        GROUP BY sb.product_variation_id`);
      if (!stock.length) return { criterio, total: 0, capital_total: 0, items: [] };
      const ids = stock.map(r => r.product_variation_id);

      // Ventas de los últimos 12 meses por variación (unidades y última venta)
      const [ventas] = await prodPool.query(`
        SELECT si.product_variation_id,
          SUM(si.quantity) AS unidades_12m,
          MAX(s.created_at) AS ultima_venta,
          AVG(si.unit_price) AS precio_prom
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
          AND si.product_variation_id IN (?)
        GROUP BY si.product_variation_id`, [ids]);
      const vMap = {};
      ventas.forEach(v => vMap[v.product_variation_id] = v);

      // Nombres
      const [nombres] = await prodPool.query(`
        SELECT pv.id, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (?)`, [ids]);
      const nMap = {};
      nombres.forEach(n => nMap[n.id] = n);

      const hoy = Date.now();
      const dias = f => f ? Math.floor((hoy - new Date(f).getTime()) / 864e5) : null;

      let items = stock.map(r => {
        const v = vMap[r.product_variation_id] || {};
        const n = nMap[r.product_variation_id] || {};
        const stockN = Number(r.stock);
        const und12 = Number(v.unidades_12m || 0);
        const ritmoMes = und12 / 12; // unidades por mes
        const mesesParaAgotar = ritmoMes > 0 ? stockN / ritmoMes : null;
        const precio = v.precio_prom != null ? Number(v.precio_prom) : null;
        const costo = r.costo_ref != null ? Number(r.costo_ref) : null;
        const margenPct = (precio && costo && precio > 0) ? ((precio - costo) / precio * 100) : null;
        const marca = (n.producto || '').trim().split(/\s+/)[0] || '—';
        return {
          sku: n.sku || '—',
          marca,
          producto: nombreProdVar(n.producto, n.variacion),
          stock: stockN,
          capital: Number(r.capital || 0),
          dias_sin_venta: dias(v.ultima_venta),           // null = nunca vendió en 12m
          dias_lote_antiguo: dias(r.lote_mas_antiguo),
          unidades_12m: und12,
          meses_para_agotar: mesesParaAgotar != null ? Math.round(mesesParaAgotar * 10) / 10 : null,
          precio_prom: precio, costo: costo,
          margen_pct: margenPct != null ? Math.round(margenPct) : null
        };
      });

      // Aplicar el criterio elegido
      const F = {
        estancado: x => x.stock > 0 && (x.dias_sin_venta == null || x.dias_sin_venta >= 120),
        sobrestock: x => x.meses_para_agotar != null && x.meses_para_agotar >= 12,
        margen_lento: x => x.margen_pct != null && x.margen_pct >= 40 && (x.dias_sin_venta == null || x.dias_sin_venta >= 60),
        lote_antiguo: x => x.dias_lote_antiguo != null && x.dias_lote_antiguo >= 365,
        casi_agotado: x => x.stock > 0 && x.stock <= 3 && x.unidades_12m >= 6
      };
      const filtro = F[criterio] || F.estancado;
      items = items.filter(filtro);

      // Lista de marcas disponibles ANTES de los filtros extra (para el desplegable)
      const marcas = [...new Set(items.map(x => x.marca))].sort();

      // Filtros adicionales opcionales
      if (filtros.marca) items = items.filter(x => x.marca.toLowerCase() === filtros.marca.toLowerCase());
      if (filtros.margen_min) items = items.filter(x => x.margen_pct != null && x.margen_pct >= Number(filtros.margen_min));
      if (filtros.capital_min) items = items.filter(x => x.capital >= Number(filtros.capital_min));
      if (filtros.stock_min) items = items.filter(x => x.stock >= Number(filtros.stock_min));

      // Orden: por capital congelado desc (los que más plata tienen parada primero),
      // salvo casi_agotado que ordena por ritmo de venta
      if (criterio === 'casi_agotado') items.sort((a, b) => b.unidades_12m - a.unidades_12m);
      else items.sort((a, b) => b.capital - a.capital);

      return {
        criterio, total: items.length,
        capital_total: items.reduce((s, x) => s + x.capital, 0),
        marcas,
        items: items.slice(0, 300)
      };
    }
  }


  app.get('/api/promo-candidatos', authAdmin, mInv, async (req, res) => {
    try {
      res.json(await obtenerPromoCandidatos(req.query.criterio || 'estancado', req.query));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/promo-candidatos-excel', authAdmin, mInv, async (req, res) => {
    try {
      const criterio = req.query.criterio || 'estancado';
      const d = await obtenerPromoCandidatos(criterio, req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Promociones');
      const filasCab = cabeceraExcel(ws, 'Promociones recomendadas', [
        ['Criterio', PROMO_NOMBRES[criterio] || criterio],
        ['Marca', req.query.marca || ''],
        ['Margen mínimo', req.query.margen_min ? req.query.margen_min + '%' : ''],
        ['Candidatos', d.total],
        ['Capital involucrado', 'S/ ' + Number(d.capital_total).toFixed(2)]
      ], 11);
      const colDefs = [
        { header: 'SKU', width: 18 }, { header: 'Marca', width: 14 }, { header: 'Producto', width: 44 },
        { header: 'Stock', width: 9 }, { header: 'Capital (S/)', width: 13 },
        { header: 'Días sin venta', width: 13 }, { header: 'Días lote antiguo', width: 15 },
        { header: 'Unidades 12m', width: 13 }, { header: 'Meses p/ agotar', width: 14 },
        { header: 'Precio prom.', width: 12 }, { header: 'Margen %', width: 10 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      d.items.forEach(x => ws.addRow([
        x.sku, x.marca, x.producto, x.stock, x.capital,
        x.dias_sin_venta != null ? x.dias_sin_venta : 'nunca (12m)',
        x.dias_lote_antiguo, x.unidades_12m,
        x.meses_para_agotar != null ? x.meses_para_agotar : '—',
        x.precio_prom, x.margen_pct
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      [5, 10].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('promociones');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });


};
