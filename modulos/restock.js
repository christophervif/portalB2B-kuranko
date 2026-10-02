// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Restock (qué reponer y cuánto)
//  Antes vivía dentro de modulos/inventario.js y admin.html; ahora es una
//  mini-app propia: backend aquí y frontend en public/restock.html (iframe).
//
//  Cálculo por variación (solo lectura sobre producción):
//    demanda/día     = unidades vendidas en la ventana (90 d por defecto) / días
//    punto reorden   = demanda/día × (lead time + buffer)
//    posición        = stock propio + en tránsito libre − backorders sin cubrir
//    reponer si      posición ≤ punto de reorden
//    sugerido pedir  = demanda/día × (lead + buffer + cobertura) − posición
//  · Stock propio: almacenes y tiendas. NO cuenta consignación (está en el
//    cliente) ni ubicaciones no vendibles (cuarentena, exhibición… mismas que
//    usa el cotizador: COTIZADOR_OTROS).
//  · En tránsito: envíos 'en_transito' del módulo Seguimiento (base del portal),
//    solo las unidades que NO están asignadas a backorders ("sobra").
//  · Backorders sin cubrir: seg_bo_items no comprados ni archivados, menos lo ya
//    cubierto por envíos. Si el módulo Seguimiento no existe, se omite (0).
//  Todo el cálculo es configurable desde la pantalla (lead, buffer, cobertura,
//  ventana) o con variables RESTOCK_LEAD / RESTOCK_BUFFER / RESTOCK_COBERTURA.
// ═══════════════════════════════════════════════════════════════════════════

const { nombreTrazable, cabeceraExcel, nombreProdVar, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA } = require('./comunes');

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const DEF = {
  lead: num(process.env.RESTOCK_LEAD, 21, 1, 365),
  buffer: num(process.env.RESTOCK_BUFFER, 5, 0, 180),
  cobertura: num(process.env.RESTOCK_COBERTURA, 30, 0, 365),
  ventana: 90
};
const VENTANAS = [30, 60, 90, 180, 365];

const OTROS = (process.env.COTIZADOR_OTROS || process.env.COTIZADOR_NO_VENDIBLES || 'CUARENTENA,EN EXHIBICION,EMBAJADOR')
  .split(',').map(x => x.trim()).filter(Boolean);
const normalizar = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const OTROS_SET = new Set(OTROS.map(normalizar));
// Igual que en seguimiento.js: para cruzar SKUs escritos a mano con los del ERP
const cleanSku = v => String(v == null ? '' : v).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const asJson = (v, fb) => { if (v == null) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } };
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;

function leerParametros(q) {
  q = q || {};
  const ventana = VENTANAS.includes(Number(q.ventana)) ? Number(q.ventana) : DEF.ventana;
  return {
    lead: num(q.lead, DEF.lead, 1, 365),
    buffer: num(q.buffer, DEF.buffer, 0, 180),
    cobertura: num(q.cobertura, DEF.cobertura, 0, 365),
    ventana,
    incluir_consig: q.incluir_consig === '1'
  };
}

// Importancia por ganancia histórica (mismos umbrales que antes)
const importancia = g => g >= 1000 ? 'Alto' : g >= 300 ? 'Medio' : 'Bajo';

// Cálculo puro (sin base de datos) — se exporta para pruebas.
//  f = { vid, und_ventana, stock_propio, consignacion, transito, bo_pendiente }
function calcularFila(f, p) {
  const demanda = (Number(f.und_ventana) || 0) / p.ventana;
  const stockBase = (Number(f.stock_propio) || 0) + (p.incluir_consig ? (Number(f.consignacion) || 0) : 0);
  const posicion = stockBase + (Number(f.transito) || 0) - (Number(f.bo_pendiente) || 0);
  const ciclo = p.lead + p.buffer;
  const puntoReorden = demanda * ciclo;
  const reponer = demanda > 0 && posicion <= puntoReorden;
  const sugerido = demanda > 0 ? Math.max(0, Math.ceil(demanda * (ciclo + p.cobertura) - posicion)) : 0;
  const diasCobertura = demanda > 0 ? Math.max(0, posicion) / demanda : null;
  // Urgencia: agotado hoy / no alcanza hasta que llegue un pedido hecho hoy / reponer ya
  let urgencia = 'Reponer';
  if (stockBase <= 0) urgencia = 'Agotado';
  else if (diasCobertura != null && diasCobertura < p.lead) urgencia = 'Crítico';
  return {
    reponer,
    stock_base: stockBase,
    posicion: r1(posicion),
    ventas_dia: Math.round(demanda * 10000) / 10000,
    punto_reorden: r1(puntoReorden),
    sugerido,
    dias_cobertura: diasCobertura == null ? null : r1(diasCobertura),
    urgencia
  };
}

const ORDEN_URG = { 'Agotado': 0, 'Crítico': 1, 'Reponer': 2 };
const ORDEN_IMP = { 'Alto': 0, 'Medio': 1, 'Bajo': 2 };

module.exports = function registrarRestock({ app, authAdmin, mRestock, prodPool, portalPool, VV }) {

  // ── Unidades en tránsito libres y backorders sin cubrir (módulo Seguimiento) ──
  async function leerSeguimiento() {
    const transito = {}, bo = {};
    let disponible = false;
    if (!portalPool) return { transito, bo, disponible };
    try {
      const [envs] = await portalPool.query(
        `SELECT items FROM seg_envios WHERE archivado = 0 AND estado = 'en_transito'`);
      envs.forEach(ev => (asJson(ev.items, []) || []).forEach(it => {
        const k = cleanSku(it.sku); if (!k) return;
        const q = Number(it.cantidad) || 0;
        // 'sobra' = unidades no asignadas a backorders (lo calcula seguimiento.js)
        const libre = it.sobra != null && Number.isFinite(Number(it.sobra)) ? Number(it.sobra) : q;
        if (libre > 0) transito[k] = (transito[k] || 0) + libre;
      }));
      const [bos] = await portalPool.query(
        `SELECT sku, cantidad, cubierto FROM seg_bo_items WHERE archivado = 0 AND comprado = 0`);
      bos.forEach(b => {
        const k = cleanSku(b.sku); if (!k) return;
        const falta = Math.max(0, (Number(b.cantidad) || 0) - (Number(b.cubierto) || 0));
        if (falta > 0) bo[k] = (bo[k] || 0) + falta;
      });
      disponible = true;
    } catch (e) { /* tablas de seguimiento aún no creadas: se ignora */ }
    return { transito, bo, disponible };
  }

  async function obtenerRestock(query) {
    const p = leerParametros(query);

    const [[catalogo], [stock], [ventas], seg] = await Promise.all([
      // Variaciones vendibles (activas, no "padre" de variables)
      prodPool.query(`
        SELECT pv.id AS vid, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv JOIN products p ON p.id = pv.product_id
        WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
          AND (pv.status IS NULL OR pv.status = 'active')
          AND COALESCE(pv.product_type,'') <> 'variable'`),
      // Stock por ubicación (se agrupa en propio / consignación / otros)
      prodPool.query(`
        SELECT ls.product_variation_id AS vid, l.name AS almacen, l.type AS tipo,
          GREATEST(ls.quantity - ls.reserved_quantity, 0) AS disp
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0`),
      // Demanda en la ventana
      prodPool.query(`
        SELECT si.product_variation_id AS vid, SUM(si.quantity) AS und,
          SUM(CASE WHEN ${ES_PEDIDO} THEN si.quantity ELSE 0 END) AS und_pedido,
          SUM(${GANANCIA_NORMAL}) AS ganancia,
          MAX(s.created_at) AS ultima_venta
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND s.deleted_at IS NULL AND s.status IN ${VV}
        GROUP BY si.product_variation_id`, [p.ventana]),
      leerSeguimiento()
    ]);

    const stMap = {};
    stock.forEach(s => {
      const e = stMap[s.vid] = stMap[s.vid] || { propio: 0, consignacion: 0, otros: 0 };
      const d = Number(s.disp) || 0;
      if (s.tipo === 'consignment') e.consignacion += d;
      else if (OTROS_SET.has(normalizar(s.almacen))) e.otros += d;
      else e.propio += d;
    });
    const vMap = {}; ventas.forEach(v => vMap[v.vid] = v);

    // 1) Filtrar candidatos con el cálculo puro (barato)
    const candidatos = [];
    catalogo.forEach(c => {
      const v = vMap[c.vid]; if (!v || !(Number(v.und) > 0)) return;
      const st = stMap[c.vid] || { propio: 0, consignacion: 0, otros: 0 };
      const k = cleanSku(c.sku);
      const f = {
        und_ventana: Number(v.und), stock_propio: st.propio, consignacion: st.consignacion,
        transito: k ? (seg.transito[k] || 0) : 0, bo_pendiente: k ? (seg.bo[k] || 0) : 0
      };
      const calc = calcularFila(f, p);
      if (!calc.reponer) return;
      candidatos.push({ c, v, st, f, calc });
    });

    // 2) Solo para los candidatos: ganancia histórica y costo (consultas acotadas)
    const ids = candidatos.map(x => x.c.vid);
    const gMap = {}, costoMap = {};
    if (ids.length) {
      const [[gan], [costos]] = await Promise.all([
        prodPool.query(`
          SELECT si.product_variation_id AS vid, SUM(si.quantity) AS unidades_hist,
            SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END) AS ingreso_confiable,
            SUM(${GANANCIA_NORMAL}) AS ganancia_hist,
            COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
            COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND si.product_variation_id IN (?)
          GROUP BY si.product_variation_id`, [ids]),
        // Último costo de compra conocido (lote más reciente) para estimar la inversión
        prodPool.query(`
          SELECT sb.product_variation_id AS vid, sb.cost_price
          FROM stock_batches sb
          JOIN (SELECT product_variation_id, MAX(id) AS mid FROM stock_batches
                WHERE product_variation_id IN (?) GROUP BY product_variation_id) u ON u.mid = sb.id`, [ids])
      ]);
      gan.forEach(g => gMap[g.vid] = g);
      costos.forEach(c => costoMap[c.vid] = Number(c.cost_price) || 0);
    }

    const items = candidatos.map(({ c, v, st, f, calc }) => {
      const g = gMap[c.vid] || {};
      const ganHist = Number(g.ganancia_hist) || 0;
      const ingreso = Number(g.ingreso_confiable) || 0;
      const costo = costoMap[c.vid] || 0;
      const undV = Number(v.und) || 0;
      return {
        sku: c.sku || '',
        producto: nombreProdVar(c.producto, c.variacion),
        marca: (c.producto || '').trim().split(/\s+/)[0] || '—',
        stock_propio: st.propio,
        consignacion: st.consignacion,
        no_vendible: st.otros,
        en_transito: f.transito,
        bo_pendiente: f.bo_pendiente,
        vendido_ventana: undV,
        pct_a_pedido: undV > 0 ? Math.round((Number(v.und_pedido) || 0) / undV * 100) : 0,
        ganancia_ventana: r2(Number(v.ganancia) || 0),
        ultima_venta: v.ultima_venta || null,
        unidades_hist: Number(g.unidades_hist) || 0,
        ganancia_hist: r2(ganHist),
        margen_pct: ingreso > 0 ? r1(ganHist / ingreso * 100) : null,
        lineas_pedido: Number(g.lineas_pedido) || 0,
        lineas_falla: Number(g.lineas_falla) || 0,
        importancia: importancia(ganHist),
        costo_ult: r2(costo),
        inversion: r2(costo * calc.sugerido),
        ...calc
      };
    }).sort((a, b) =>
      (ORDEN_URG[a.urgencia] - ORDEN_URG[b.urgencia]) ||
      (ORDEN_IMP[a.importancia] - ORDEN_IMP[b.importancia]) ||
      (b.ganancia_hist - a.ganancia_hist));

    const resumen = {
      total: items.length,
      agotados: items.filter(x => x.urgencia === 'Agotado').length,
      criticos: items.filter(x => x.urgencia === 'Crítico').length,
      unidades_sugeridas: items.reduce((s, x) => s + x.sugerido, 0),
      inversion: r2(items.reduce((s, x) => s + x.inversion, 0)),
      sin_costo: items.filter(x => x.sugerido > 0 && !x.costo_ult).length
    };
    const marcas = [...new Set(items.map(x => x.marca))].filter(m => m !== '—').sort();
    return { parametros: p, seguimiento: seg.disponible, resumen, marcas, items };
  }

  app.get('/api/restock', authAdmin, mRestock, async (req, res) => {
    try { res.json(await obtenerRestock(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/restock-excel', authAdmin, mRestock, async (req, res) => {
    try {
      const d = await obtenerRestock(req.query);
      const p = d.parametros;
      let items = d.items;
      // Mismos filtros de pantalla (opcionales)
      if (req.query.marca) items = items.filter(x => x.marca === req.query.marca);
      if (req.query.urgencia) items = items.filter(x => x.urgencia === req.query.urgencia);
      if (req.query.importancia) items = items.filter(x => x.importancia === req.query.importancia);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Restock');
      const cols = [
        ['Urgencia', 11], ['Importancia', 11], ['SKU', 18], ['Producto', 46], ['Marca', 14],
        ['Stock propio', 11], ['Consignación', 12], ['En tránsito', 11], ['Backorders pend.', 14],
        [`Vendido ${p.ventana}d`, 12], ['Venta/día', 10], ['Pto. reorden', 11], ['Días cobertura', 13],
        ['Sugerido pedir', 13], ['Último costo (S/)', 14], ['Inversión (S/)', 14],
        ['Margen %', 10], ['Ganancia hist. (S/)', 16], ['% a pedido', 10]
      ];
      const filasCab = cabeceraExcel(ws, 'Restock — productos a reponer', [
        ['Lead time', p.lead + ' d'], ['Buffer', p.buffer + ' d'], ['Cobertura', p.cobertura + ' d'],
        ['Ventana', p.ventana + ' d'], ['Consignación', p.incluir_consig ? 'incluida' : 'excluida'],
        ['Marca', req.query.marca], ['Urgencia', req.query.urgencia], ['Importancia', req.query.importancia]
      ], cols.length);
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      items.forEach(x => ws.addRow([
        x.urgencia, x.importancia, x.sku, x.producto, x.marca, x.stock_propio, x.consignacion,
        x.en_transito, x.bo_pendiente, x.vendido_ventana, x.ventas_dia, x.punto_reorden,
        x.dias_cobertura, x.sugerido, x.costo_ult, x.inversion, x.margen_pct, x.ganancia_hist, x.pct_a_pedido
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      ws.autoFilter = { from: { row: filasCab + 1, column: 1 }, to: { row: filasCab + 1, column: cols.length } };
      [15, 16, 18].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('restock');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });
};

module.exports._puros = { calcularFila, leerParametros, importancia, cleanSku };
