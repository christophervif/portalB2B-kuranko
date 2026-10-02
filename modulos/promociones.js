// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Promociones recomendadas
//  Backend aquí; frontend propio en public/promociones.html (iframe en el panel).
//
//  Endpoints (permiso: inventario)
//    GET /api/promo-candidatos        → candidatos con sus motivos + conteos por motivo
//    GET /api/promo-candidatos-excel  → lo mismo en Excel (respeta los filtros de pantalla)
//
//  Filtros (query):
//    alcance     propio (def.) | todo   (todo = suma consignación y no vendibles)
//    umbral      días sin venta para "estancado": 90 | 120 (def.) | 180 | 365
//    meses       meses de stock para "sobre-stock": 6 | 12 (def.) | 18 | 24
//    — solo Excel (en pantalla se filtra en el navegador, sin volver a consultar):
//    motivo, marca, categoria, capital_min, margen_min, buscar
//
//  Motivos (un producto puede tener varios):
//    estancado       sin venta hace U+ días (o nunca) y su lote más antiguo tiene U+ días
//                    (un producto recién llegado sin ventas NO es estancado)
//    sobrestock      sí vende, pero a ese ritmo tarda M+ meses en agotarse
//    lote_antiguo    tiene lotes con 1+ año en almacén
//    descontinuado   variación/producto inactivo o borrado en el ERP pero con stock
//    modelo_anterior el nombre trae un año de modelo anterior al actual (ej. "2025")
//    tallas_sueltas  quedan pocas unidades de pocas tallas/colores: el producto tiene
//                    3+ variaciones activas y solo ≤40% siguen con stock
//    margen_lento    margen ≥40% sobre el precio de lista, sin venta hace 60+ días y
//                    con 60+ días en almacén (recién llegados no cuentan)
//                    (solo para quien ve márgenes)
//
//  Reglas
//  · Stock: location_stocks, igual que Inventario. Por defecto solo stock propio
//    (sin consignación ni ubicaciones no vendibles). Se descuentan las unidades
//    reservadas: lo reservado ya está comprometido, no se promociona.
//  · Costo: promedio de lotes con existencia (si no hay, el último costo conocido).
//  · Márgenes, precios y descuento sugerido SOLO para el maestro o quien tenga el
//    módulo 'rentabilidad' (Inventario/Promociones también lo ve el supervisor).
//    Precio de referencia = precio vigente de lista (oferta si hay, si no regular).
// ═══════════════════════════════════════════════════════════════════════════

const { nombreTrazable, cabeceraExcel, nombreProdVar } = require('./comunes');
const { claseUbicacion } = require('./inventario').comun;
const { anioModelo } = require('./cotizador')._puros;

const UMBRALES = [90, 120, 180, 365];
const DEF_UMBRAL = 120;
const MESES = [6, 12, 18, 24];
const DEF_MESES = 12;
const LOTE_ANTIGUO = 365;
const MARGEN_ALTO = 40;
const LENTO_DIAS = 60;
const TALLAS_MIN_VARIACIONES = 3;
const TALLAS_MAX_PCT_CON_STOCK = 0.4;
const TALLAS_MAX_UNIDADES = 3;

const MOTIVOS = {
  estancado: 'Estancado',
  sobrestock: 'Sobre-stock',
  lote_antiguo: 'Lote +1 año',
  descontinuado: 'Descontinuado',
  modelo_anterior: 'Modelo anterior',
  tallas_sueltas: 'Tallas/colores sueltos',
  margen_lento: 'Margen alto + lento'
};

const DIA = 864e5;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;

function leerFiltros(q) {
  q = q || {};
  const u = Number(q.umbral), m = Number(q.meses);
  return {
    alcance: q.alcance === 'todo' ? 'todo' : 'propio',
    umbral: UMBRALES.includes(u) ? u : DEF_UMBRAL,
    meses: MESES.includes(m) ? m : DEF_MESES
  };
}

// Puede ver márgenes y precios: maestro o con módulo 'rentabilidad'
function veMargenes(admin) {
  const a = admin || {};
  return !!a.maestro || (Array.isArray(a.modulos) && a.modulos.includes('rentabilidad'));
}

// Descuento sugerido (punto de partida, no regla): según la gravedad del motivo,
// sin bajar del costo + 5 puntos de margen.
function descuentoSugerido(x) {
  if (x.margen_pct == null) return null;
  const m = x.motivos;
  let base = 10;
  if (m.includes('estancado') || m.includes('modelo_anterior') || m.includes('lote_antiguo')) base = 20;
  if (m.includes('descontinuado') || (m.includes('estancado') && (x.dias_sin_venta == null || x.dias_sin_venta >= 365))
    || (x.edad_dias != null && x.edad_dias >= 540)) base = 30;
  return Math.max(0, Math.min(base, Math.floor(x.margen_pct - 5)));
}

// Cálculo puro (sin base de datos) — exportado para pruebas.
//  d = { ubic:[{vid,loc_id,loc_nombre,loc_tipo,qty,reservado}], lotes:[{vid,qty,costo,entrada}],
//        ultCosto:[{vid,costo}], ventas:[{vid,und_12m,und_90d,ultima_venta}],
//        catalogo:[{vid,sku,variacion,producto,pid,inactivo,regular_price,sale_price}],
//        cats:[{product_id,cat,parent_id,cat_padre}], hermanas:[{pid,activas}] }
//  opts = { conMargen, hoy }
function calcularPromos(d, f, opts = {}) {
  const hoy = opts.hoy || Date.now();
  const conMargen = !!opts.conMargen;
  const anioActual = Number(new Date(hoy).toLocaleString('en-US', { timeZone: 'America/Lima', year: 'numeric' }));
  const dias = x => x ? Math.max(0, Math.floor((hoy - new Date(x).getTime()) / DIA)) : null;

  const lotesMap = {};
  d.lotes.forEach(l => {
    const e = lotesMap[l.vid] = lotesMap[l.vid] || { qty: 0, capital: 0, entrada: null, lotes: [] };
    const q = Number(l.qty) || 0, c = Number(l.costo) || 0;
    e.qty += q; e.capital += q * c; e.lotes.push({ q, c, edad: dias(l.entrada) });
    if (l.entrada && (!e.entrada || new Date(l.entrada) < new Date(e.entrada))) e.entrada = l.entrada;
  });
  const ultMap = {}; d.ultCosto.forEach(r => ultMap[r.vid] = Number(r.costo) || 0);
  const vMap = {}; d.ventas.forEach(v => vMap[v.vid] = v);
  const nMap = {}; d.catalogo.forEach(n => nMap[n.vid] = n);
  const hermMap = {}; (d.hermanas || []).forEach(h => hermMap[h.pid] = Number(h.activas) || 0);
  const catMap = {};
  d.cats.forEach(r => {
    const s = catMap[r.product_id] = catMap[r.product_id] || new Set();
    s.add(r.parent_id ? r.cat_padre : r.cat);
  });

  // Stock por variación dentro del alcance
  const porVar = {};
  d.ubic.forEach(r => {
    const q = Number(r.qty) || 0; if (q <= 0) return;
    const clase = claseUbicacion(r.loc_tipo, r.loc_nombre);
    if (f.alcance === 'propio' && clase !== 'propio') return;
    const e = porVar[r.vid] = porVar[r.vid] || { q: 0, res: 0 };
    e.q += q; e.res += Math.min(q, Math.max(0, Number(r.reservado) || 0));
  });

  // Cuántas variaciones de cada producto siguen con stock (para "tallas sueltas")
  const conStockPorProd = {};
  Object.keys(porVar).forEach(vid => {
    const n = nMap[vid]; if (!n || !n.pid || Number(n.inactivo)) return;
    conStockPorProd[n.pid] = (conStockPorProd[n.pid] || 0) + 1;
  });

  const marcasSet = new Set(), catsSet = new Set();
  const conteo = {};
  Object.keys(MOTIVOS).filter(k => conMargen || k !== 'margen_lento').forEach(k => conteo[k] = { skus: 0, capital: 0 });
  const items = [];

  Object.keys(porVar).forEach(vid => {
    const st = porVar[vid];
    const disponibles = st.q - st.res;
    if (disponibles <= 0) return;                         // todo reservado: nada que promocionar
    const n = nMap[vid] || {};
    const L = lotesMap[vid];
    const costo = L && L.qty > 0 ? L.capital / L.qty : (ultMap[vid] || 0);
    const v = vMap[vid] || {};
    const und12 = Number(v.und_12m) || 0;
    const dsv = dias(v.ultima_venta);
    const edad = L ? dias(L.entrada) : null;
    const ritmoMes = und12 / 12;
    const meses = ritmoMes > 0 ? st.q / ritmoMes : null;
    const inactivo = !!Number(n.inactivo || 0) || !nMap[vid];
    const nombre = nombreProdVar(n.producto, n.variacion) || ('Variación #' + vid);
    const anio = anioModelo((n.variacion || '') + ' ' + (n.producto || ''));
    const activas = hermMap[n.pid] || 0, conStock = conStockPorProd[n.pid] || 0;

    // Capital en lotes de 1+ año (escalado a las unidades del alcance)
    let capAntiguo = 0;
    if (L && L.qty > 0) {
      const factor = Math.min(1, st.q / L.qty);
      L.lotes.forEach(l => { if (l.edad != null && l.edad >= LOTE_ANTIGUO) capAntiguo += l.q * l.c * factor; });
    }

    const precioLista = n.sale_price != null && Number(n.sale_price) > 0 ? Number(n.sale_price) : Number(n.regular_price || 0);
    const margen = precioLista > 0 && costo > 0 ? (precioLista - costo) / precioLista * 100 : null;

    const motivos = [];
    const estancado = (dsv == null || dsv >= f.umbral) && (edad == null || edad >= f.umbral);
    if (estancado) motivos.push('estancado');
    if (!estancado && meses != null && meses >= f.meses) motivos.push('sobrestock');
    if (edad != null && edad >= LOTE_ANTIGUO) motivos.push('lote_antiguo');
    if (inactivo) motivos.push('descontinuado');
    if (anio && anio < anioActual) motivos.push('modelo_anterior');
    if (!inactivo && activas >= TALLAS_MIN_VARIACIONES && conStock / activas <= TALLAS_MAX_PCT_CON_STOCK
      && st.q <= TALLAS_MAX_UNIDADES) motivos.push('tallas_sueltas');
    if (conMargen && margen != null && margen >= MARGEN_ALTO && (dsv == null || dsv >= LENTO_DIAS)
      && (edad == null || edad >= LENTO_DIAS)) motivos.push('margen_lento');
    if (!motivos.length) return;

    const marca = (n.producto || '').trim().split(/\s+/)[0] || '—';
    const cats = [...(catMap[n.pid] || [])].filter(Boolean).sort();
    if (marca !== '—') marcasSet.add(marca);
    cats.forEach(c => catsSet.add(c));
    const capital = st.q * costo;
    motivos.forEach(k => { conteo[k].skus++; conteo[k].capital += capital; });

    const it = {
      vid: Number(vid), sku: n.sku || '—', producto: nombre, marca, categoria: cats.join(', '),
      stock: st.q, disponibles, reservadas: st.res,
      costo: r2(costo), capital: r2(capital), capital_antiguo: r2(capAntiguo),
      und_90d: Number(v.und_90d) || 0, und_12m: und12,
      ultima_venta: v.ultima_venta || null, dias_sin_venta: dsv, edad_dias: edad,
      meses_para_agotar: meses != null ? r1(meses) : null,
      anio_modelo: anio, variaciones: activas ? { con_stock: conStock, activas } : null,
      inactivo, motivos
    };
    if (conMargen) {
      it.precio = precioLista > 0 ? r2(precioLista) : null;
      it.en_oferta = n.sale_price != null && Number(n.sale_price) > 0;
      it.margen_pct = margen != null ? r1(margen) : null;
      it.desc_max_pct = margen != null ? Math.max(0, Math.floor(margen)) : null; // bajar más = vender bajo costo
      it.desc_sug_pct = descuentoSugerido(it);
      it.precio_sug = it.desc_sug_pct != null && precioLista > 0 ? r2(precioLista * (1 - it.desc_sug_pct / 100)) : null;
    }
    items.push(it);
  });

  items.sort((a, b) => b.capital - a.capital);
  Object.values(conteo).forEach(c => c.capital = r2(c.capital));

  return {
    filtros: f,
    con_margen: conMargen,
    total: items.length,
    capital_total: r2(items.reduce((s, x) => s + x.capital, 0)),
    conteo,
    motivos: Object.entries(MOTIVOS).filter(([k]) => conMargen || k !== 'margen_lento').map(([k, t]) => ({ k, t })),
    opciones: { marcas: [...marcasSet].sort(), categorias: [...catsSet].sort(), umbrales: UMBRALES, meses: MESES },
    items
  };
}

// Filtros de pantalla (los aplica el Excel; en el navegador se hacen sin recargar)
function filtrarItems(items, q) {
  q = q || {};
  const txt = String(q.buscar || '').toLowerCase().trim();
  return items.filter(x =>
    (!q.motivo || x.motivos.includes(q.motivo)) &&
    (!q.marca || x.marca === q.marca) &&
    (!q.categoria || x.categoria.split(', ').includes(q.categoria)) &&
    (!q.capital_min || x.capital >= Number(q.capital_min)) &&
    (!q.margen_min || (x.margen_pct != null && x.margen_pct >= Number(q.margen_min))) &&
    (!txt || (x.sku + ' ' + x.producto).toLowerCase().includes(txt)));
}

module.exports = function registrarPromociones({ app, authAdmin, mInv, prodPool, VV }) {

  async function leerBase() {
    const [[ubic], [lotes], [ultCosto], [ventas], [catalogo], [cats], [hermanas]] = await Promise.all([
      prodPool.query(`
        SELECT ls.product_variation_id AS vid, l.id AS loc_id, l.name AS loc_nombre, l.type AS loc_tipo,
          ls.quantity AS qty, ls.reserved_quantity AS reservado
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0`),
      prodPool.query(`
        SELECT product_variation_id AS vid, quantity AS qty, cost_price AS costo, entry_date AS entrada
        FROM stock_batches WHERE quantity > 0`),
      prodPool.query(`
        SELECT sb.product_variation_id AS vid, sb.cost_price AS costo
        FROM stock_batches sb
        JOIN (SELECT product_variation_id, MAX(id) AS mid FROM stock_batches GROUP BY product_variation_id) u
          ON u.mid = sb.id`),
      prodPool.query(`
        SELECT si.product_variation_id AS vid,
          SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH) THEN si.quantity ELSE 0 END) AS und_12m,
          SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN si.quantity ELSE 0 END) AS und_90d,
          MAX(s.created_at) AS ultima_venta
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
        GROUP BY si.product_variation_id`),
      prodPool.query(`
        SELECT pv.id AS vid, pv.sku, pv.name AS variacion, p.id AS pid, p.name AS producto,
          pv.regular_price, pv.sale_price,
          (pv.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL
            OR (pv.status IS NOT NULL AND pv.status <> 'active')) AS inactivo
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (SELECT DISTINCT product_variation_id FROM location_stocks WHERE quantity > 0)`),
      prodPool.query(`
        SELECT ppc.product_id, c.name AS cat, c.parent_id, padre.name AS cat_padre
        FROM product_product_category ppc
        JOIN product_categories c ON c.id = ppc.product_category_id
        LEFT JOIN product_categories padre ON padre.id = c.parent_id`),
      // Variaciones activas por producto (para detectar tallas/colores sueltos)
      prodPool.query(`
        SELECT pv.product_id AS pid, COUNT(*) AS activas
        FROM product_variations pv
        WHERE pv.deleted_at IS NULL AND (pv.status IS NULL OR pv.status = 'active')
        GROUP BY pv.product_id`)
    ]);
    return { ubic, lotes, ultCosto, ventas, catalogo, cats, hermanas };
  }

  async function obtener(req) {
    return calcularPromos(await leerBase(), leerFiltros(req.query), { conMargen: veMargenes(req.admin) });
  }

  app.get('/api/promo-candidatos', authAdmin, mInv, async (req, res) => {
    try { res.json(await obtener(req)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/promo-candidatos-excel', authAdmin, mInv, async (req, res) => {
    try {
      const d = await obtener(req);
      const q = req.query, f = d.filtros, cm = d.con_margen;
      const items = filtrarItems(d.items, cm ? q : { ...q, margen_min: '' });
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Promociones');
      const cols = [['Motivos', 30], ['SKU', 18], ['Producto', 46], ['Marca', 14], ['Categoría', 18],
        ['Stock', 8], ['Disponibles', 11], ['Costo unit. (S/)', 13], ['Capital (S/)', 13], ['Capital lotes +1 año (S/)', 16],
        ['Vendido 90d', 11], ['Vendido 12m', 11], ['Días sin venta', 12], ['Edad lote (d)', 11], ['Meses p/ agotar', 12],
        ['Año modelo', 10], ['Variaciones con stock', 14]];
      if (cm) cols.push(['Precio lista (S/)', 13], ['Margen %', 9], ['Desc. máx. %', 11], ['Desc. sugerido %', 13], ['Precio sugerido (S/)', 15]);
      const n = cabeceraExcel(ws, 'Promociones recomendadas', [
        ['Stock', f.alcance === 'todo' ? 'Todas las ubicaciones' : 'Propio (sin consignación ni no vendibles)'],
        ['Estancado desde', f.umbral + ' días sin venta'], ['Sobre-stock desde', f.meses + ' meses'],
        ['Motivo', MOTIVOS[q.motivo] || ''], ['Marca', q.marca || ''], ['Categoría', q.categoria || ''],
        ['Capital mín.', q.capital_min ? 'S/ ' + q.capital_min : ''], ['Margen mín.', cm && q.margen_min ? q.margen_min + '%' : ''],
        ['Búsqueda', q.buscar || ''], ['Candidatos', items.length]
      ], cols.length);
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      items.forEach(x => {
        const fila = [x.motivos.map(k => MOTIVOS[k]).join(', '), x.sku, x.producto, x.marca, x.categoria,
          x.stock, x.disponibles, x.costo, x.capital, x.capital_antiguo, x.und_90d, x.und_12m,
          x.dias_sin_venta == null ? 'nunca' : x.dias_sin_venta, x.edad_dias, x.meses_para_agotar,
          x.anio_modelo, x.variaciones ? `${x.variaciones.con_stock} de ${x.variaciones.activas}` : ''];
        if (cm) fila.push(x.precio, x.margen_pct, x.desc_max_pct, x.desc_sug_pct, x.precio_sug);
        ws.addRow(fila);
      });
      [8, 9, 10].concat(cm ? [18, 22] : []).forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      ws.views = [{ state: 'frozen', ySplit: n + 1 }];
      ws.autoFilter = { from: { row: n + 1, column: 1 }, to: { row: n + 1, column: cols.length } };
      const nombre = nombreTrazable('promociones');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });
};

module.exports._test = { calcularPromos, filtrarItems, leerFiltros, veMargenes, descuentoSugerido, MOTIVOS };
