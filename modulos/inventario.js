// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Inventario — foto del stock HOY (no depende de fechas)
//  Backend aquí; frontend propio en public/inventario.html (iframe en el panel).
//  (Restock y exportador de inventario → modulos/restock.js)
//
//  Endpoints (permiso: inventario)
//    GET /api/inventario        → KPIs, salud del stock, antigüedad, ubicaciones,
//                                 marcas y detalle por variación
//    GET /api/inventario-excel  → lo mismo en Excel (Detalle / Ubicaciones / Marcas)
//
//  Filtros (query):
//    alcance   propio (def.) | todo | consignacion | no_vendible | loc:<id>
//    marca     marca (primera palabra del producto, igual que el resto del sistema)
//    categoria categoría principal del producto
//    umbral    días sin venta para considerar "estancado": 90 | 120 (def.) | 180 | 365
//
//  Reglas
//  · Unidades: location_stocks (por ubicación). Valor: costo promedio de los lotes
//    con existencia (stock_batches); si no hay lotes, el último costo conocido.
//  · "Propio" = almacenes y tiendas. NO incluye consignación (está en el cliente)
//    ni ubicaciones no vendibles (COTIZADOR_OTROS: cuarentena, exhibición…).
//  · Estado de cada variación (U = umbral):
//      activo     vendió en los últimos 90 días
//      lento      última venta hace 90…U días
//      estancado  sin venta hace U+ días (o nunca) Y su lote más antiguo tiene U+ días
//      nuevo      sin venta hace U+ días pero ingresó hace menos de U días
//    (Antes un producto recién llegado sin ventas salía como "estancado".)
//  · Sin márgenes ni precios de venta: esta pestaña la ve el supervisor.
// ═══════════════════════════════════════════════════════════════════════════

const { nombreProdVar, nombreTrazable, cabeceraExcel } = require('./comunes');

const OTROS = (process.env.COTIZADOR_OTROS || process.env.COTIZADOR_NO_VENDIBLES || 'CUARENTENA,EN EXHIBICION,EMBAJADOR')
  .split(',').map(x => x.trim()).filter(Boolean);
const normalizar = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const OTROS_SET = new Set(OTROS.map(normalizar));

const UMBRALES = [90, 120, 180, 365];
const DEF_UMBRAL = 120;
const ACTIVO_DIAS = 90;
const TRAMOS = [
  { k: '0-90', t: '0–90 días', max: 90 },
  { k: '91-180', t: '91–180 días', max: 180 },
  { k: '181-365', t: '6–12 meses', max: 365 },
  { k: '365+', t: 'Más de 1 año', max: Infinity }
];
const ESTADOS = ['activo', 'lento', 'nuevo', 'estancado'];

const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const DIA = 864e5;

function leerFiltros(q) {
  q = q || {};
  const a = String(q.alcance || 'propio');
  const alcance = /^(propio|todo|consignacion|no_vendible)$/.test(a) || /^loc:\d+$/.test(a) ? a : 'propio';
  const u = Number(q.umbral);
  return {
    alcance,
    marca: q.marca ? String(q.marca) : '',
    categoria: q.categoria ? String(q.categoria) : '',
    umbral: UMBRALES.includes(u) ? u : DEF_UMBRAL
  };
}

// propio | consignacion | no_vendible
function claseUbicacion(tipo, nombre) {
  if (tipo === 'consignment') return 'consignacion';
  if (OTROS_SET.has(normalizar(nombre))) return 'no_vendible';
  return 'propio';
}
function enAlcance(alcance, clase, locId) {
  if (alcance === 'todo') return true;
  if (alcance.startsWith('loc:')) return String(locId) === alcance.slice(4);
  return clase === alcance;
}

function estadoDe(diasSinVenta, edad, umbral) {
  if (diasSinVenta != null && diasSinVenta < ACTIVO_DIAS) return 'activo';
  const sinVentaLargo = diasSinVenta == null || diasSinVenta >= umbral;
  if (!sinVentaLargo) return 'lento';
  if (edad != null && edad < umbral) return 'nuevo';
  return 'estancado';
}

// Cálculo puro (sin base de datos) — exportado para pruebas.
//  d = { ubic:[{vid,loc_id,loc_nombre,loc_tipo,loc_activa,qty,reservado}],
//        lotes:[{vid,qty,costo,entrada}], ultCosto:[{vid,costo}],
//        ventas:[{vid,und_12m,und_90d,ultima_venta}],
//        catalogo:[{vid,sku,variacion,producto,pid,inactivo}],
//        cats:[{product_id,cat,parent_id,cat_padre}] }
function calcularInventario(d, f, hoy = Date.now()) {
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
  const catMap = {};
  d.cats.forEach(r => {
    const s = catMap[r.product_id] = catMap[r.product_id] || new Set();
    s.add(r.parent_id ? r.cat_padre : r.cat);
  });

  // Stock por variación y ubicación
  const porVar = {}, locsInfo = {};
  let qtyUbicTotal = 0;
  d.ubic.forEach(r => {
    const q = Number(r.qty) || 0; if (q <= 0) return;
    const clase = claseUbicacion(r.loc_tipo, r.loc_nombre);
    locsInfo[r.loc_id] = locsInfo[r.loc_id] || {
      id: r.loc_id, nombre: r.loc_nombre, tipo: r.loc_tipo, clase, activa: r.loc_activa == null ? true : !!Number(r.loc_activa)
    };
    qtyUbicTotal += q;
    (porVar[r.vid] = porVar[r.vid] || []).push({ loc: r.loc_id, clase, q, res: Math.min(q, Math.max(0, Number(r.reservado) || 0)) });
  });

  // Ficha de cada variación (antes de filtrar, para armar listas de marcas/categorías)
  const marcasSet = new Set(), catsSet = new Set();
  const fichas = Object.keys(porVar).map(vid => {
    const n = nMap[vid] || {};
    const marca = (n.producto || '').trim().split(/\s+/)[0] || '—';
    const cats = [...(catMap[n.pid] || [])].filter(Boolean).sort();
    if (marca !== '—') marcasSet.add(marca);
    cats.forEach(c => catsSet.add(c));
    return { vid, n, marca, cats };
  });

  const filtradas = fichas.filter(x =>
    (!f.marca || x.marca === f.marca) && (!f.categoria || x.cats.includes(f.categoria)));

  const tramos = {}; TRAMOS.forEach(t => tramos[t.k] = 0); tramos.sin_fecha = 0;
  const locAgg = {};
  const items = [];
  let sinCosto = 0;

  filtradas.forEach(({ vid, n, marca, cats }) => {
    const L = lotesMap[vid];
    const costo = L && L.qty > 0 ? L.capital / L.qty : (ultMap[vid] || 0);
    const filas = porVar[vid];
    // Tabla por ubicación: respeta marca/categoría, no el alcance (para poder comparar)
    filas.forEach(x => {
      const a = locAgg[x.loc] = locAgg[x.loc] || { unidades: 0, reservadas: 0, capital: 0, vids: new Set() };
      a.unidades += x.q; a.reservadas += x.res; a.capital += x.q * costo; a.vids.add(vid);
    });
    const dentro = filas.filter(x => enAlcance(f.alcance, x.clase, x.loc));
    const stock = dentro.reduce((s, x) => s + x.q, 0);
    if (stock <= 0) return;
    const reservadas = dentro.reduce((s, x) => s + x.res, 0);
    const capital = stock * costo;
    if (!(costo > 0)) sinCosto++;

    // Antigüedad: reparte el capital según la edad de cada lote
    if (L && L.qty > 0) {
      const factor = stock / L.qty;
      L.lotes.forEach(l => {
        const val = l.q * l.c * factor;
        if (l.edad == null) { tramos.sin_fecha += val; return; }
        tramos[TRAMOS.find(t => l.edad <= t.max).k] += val;
      });
    } else tramos.sin_fecha += capital;

    const v = vMap[vid] || {};
    const und12 = Number(v.und_12m) || 0;
    const dsv = dias(v.ultima_venta);
    const edad = L ? dias(L.entrada) : null;
    const ritmoMes = und12 / 12;
    items.push({
      sku: n.sku || '—',
      producto: nombreProdVar(n.producto, n.variacion) || ('Variación #' + vid),
      marca,
      categoria: cats.join(', '),
      inactivo: !!Number(n.inactivo || 0) || !nMap[vid],
      stock, disponibles: stock - reservadas, reservadas,
      costo: r2(costo),
      capital: r2(capital),
      und_90d: Number(v.und_90d) || 0,
      und_12m: und12,
      ultima_venta: v.ultima_venta || null,
      dias_sin_venta: dsv,
      edad_dias: edad,
      meses_para_agotar: ritmoMes > 0 ? r1(stock / ritmoMes) : null,
      estado: estadoDe(dsv, edad, f.umbral)
    });
  });

  items.sort((a, b) => b.capital - a.capital);

  // KPIs y salud
  const salud = {}; ESTADOS.forEach(e => salud[e] = { capital: 0, unidades: 0, skus: 0 });
  items.forEach(x => { const s = salud[x.estado]; s.capital += x.capital; s.unidades += x.stock; s.skus++; });
  ESTADOS.forEach(e => salud[e].capital = r2(salud[e].capital));
  const kpis = {
    unidades: items.reduce((s, x) => s + x.stock, 0),
    disponibles: items.reduce((s, x) => s + x.disponibles, 0),
    reservadas: items.reduce((s, x) => s + x.reservadas, 0),
    skus: items.length,
    capital: r2(items.reduce((s, x) => s + x.capital, 0)),
    sin_costo: sinCosto,
    sobrestock: items.filter(x => x.meses_para_agotar != null && x.meses_para_agotar >= 12).length
  };

  const ubicaciones = Object.keys(locAgg).map(id => {
    const a = locAgg[id], i = locsInfo[id];
    return {
      id: i.id, nombre: i.nombre, tipo: i.tipo, clase: i.clase, activa: i.activa,
      unidades: a.unidades, disponibles: a.unidades - a.reservadas, reservadas: a.reservadas,
      skus: a.vids.size, capital: r2(a.capital), en_alcance: enAlcance(f.alcance, i.clase, i.id)
    };
  }).sort((a, b) => b.capital - a.capital);

  // Marcas (dentro del alcance)
  const pm = {};
  items.forEach(x => {
    const m = pm[x.marca] = pm[x.marca] || { marca: x.marca, capital: 0, stock: 0, und_12m: 0, referencias: 0, estancados: 0, capital_estancado: 0 };
    m.capital += x.capital; m.stock += x.stock; m.und_12m += x.und_12m; m.referencias++;
    if (x.estado === 'estancado') { m.estancados++; m.capital_estancado += x.capital; }
  });
  const marcas = Object.values(pm).map(m => ({
    ...m, capital: r2(m.capital), capital_estancado: r2(m.capital_estancado),
    meses_para_agotar: m.und_12m > 0 ? r1(m.stock / (m.und_12m / 12)) : null
  })).sort((a, b) => b.capital - a.capital);

  // Calidad de datos: unidades por ubicación vs unidades en lotes (todo, sin filtros)
  const qtyLotesTotal = Object.values(lotesMap).reduce((s, l) => s + l.qty, 0);

  return {
    filtros: f,
    kpis, salud,
    antiguedad: [...TRAMOS.map(t => ({ k: t.k, t: t.t, capital: r2(tramos[t.k]) })),
      { k: 'sin_fecha', t: 'Sin fecha de ingreso', capital: r2(tramos.sin_fecha) }],
    ubicaciones, marcas, items,
    opciones: {
      marcas: [...marcasSet].sort(), categorias: [...catsSet].sort(), umbrales: UMBRALES,
      ubicaciones: Object.values(locsInfo).map(l => ({ id: l.id, nombre: l.nombre, clase: l.clase }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
    },
    calidad: { unidades_ubicaciones: qtyUbicTotal, unidades_lotes: qtyLotesTotal, diferencia: qtyUbicTotal - qtyLotesTotal },
    no_vendibles: OTROS
  };
}

module.exports = function registrarInventario({ app, authAdmin, mInv, prodPool, VV }) {

  async function leerBase() {
    const [[ubic], [lotes], [ultCosto], [ventas], [catalogo], [cats]] = await Promise.all([
      prodPool.query(`
        SELECT ls.product_variation_id AS vid, l.id AS loc_id, l.name AS loc_nombre, l.type AS loc_tipo,
          l.is_active AS loc_activa, ls.quantity AS qty, ls.reserved_quantity AS reservado
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0`),
      prodPool.query(`
        SELECT product_variation_id AS vid, quantity AS qty, cost_price AS costo, entry_date AS entrada
        FROM stock_batches WHERE quantity > 0`),
      // Último costo conocido (para variaciones con stock pero sin lotes vivos)
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
          (pv.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL
            OR (pv.status IS NOT NULL AND pv.status <> 'active')) AS inactivo
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (SELECT DISTINCT product_variation_id FROM location_stocks WHERE quantity > 0)`),
      prodPool.query(`
        SELECT ppc.product_id, c.name AS cat, c.parent_id, padre.name AS cat_padre
        FROM product_product_category ppc
        JOIN product_categories c ON c.id = ppc.product_category_id
        LEFT JOIN product_categories padre ON padre.id = c.parent_id`)
    ]);
    return { ubic, lotes, ultCosto, ventas, catalogo, cats };
  }

  async function obtener(query) {
    return calcularInventario(await leerBase(), leerFiltros(query));
  }

  app.get('/api/inventario', authAdmin, mInv, async (req, res) => {
    try { res.json(await obtener(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/inventario-excel', authAdmin, mInv, async (req, res) => {
    try {
      const d = await obtener(req.query);
      const f = d.filtros;
      let items = d.items;
      if (req.query.estado && ESTADOS.includes(req.query.estado)) items = items.filter(x => x.estado === req.query.estado);
      const nomAlcance = f.alcance.startsWith('loc:')
        ? ((d.opciones.ubicaciones.find(u => 'loc:' + u.id === f.alcance) || {}).nombre || f.alcance)
        : ({ propio: 'Stock propio', todo: 'Todas las ubicaciones', consignacion: 'Consignación', no_vendible: 'No vendibles' })[f.alcance];
      const filtrosCab = [['Alcance', nomAlcance], ['Marca', f.marca], ['Categoría', f.categoria],
        ['Estancado desde', f.umbral + ' días sin venta'], ['Estado', req.query.estado]];

      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const cab = (ws, titulo, cols) => {
        const n = cabeceraExcel(ws, titulo, filtrosCab, cols.length);
        cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        ws.views = [{ state: 'frozen', ySplit: n + 1 }];
        ws.autoFilter = { from: { row: n + 1, column: 1 }, to: { row: n + 1, column: cols.length } };
      };
      const NOM_EST = { activo: 'Activo', lento: 'Lento', nuevo: 'Nuevo', estancado: 'Estancado' };

      const ws = wb.addWorksheet('Detalle');
      cab(ws, 'Inventario — detalle', [['Estado', 11], ['SKU', 18], ['Producto', 46], ['Marca', 14], ['Categoría', 18],
        ['Stock', 9], ['Disponibles', 11], ['Reservadas', 11], ['Costo unit. (S/)', 13], ['Capital (S/)', 14],
        ['Vendido 90d', 11], ['Vendido 12m', 11], ['Días sin venta', 13], ['Edad lote más antiguo (d)', 15], ['Meses p/ agotar', 13]]);
      items.forEach(x => ws.addRow([NOM_EST[x.estado], x.sku, x.producto + (x.inactivo ? ' (inactivo)' : ''), x.marca, x.categoria,
        x.stock, x.disponibles, x.reservadas, x.costo, x.capital, x.und_90d, x.und_12m,
        x.dias_sin_venta == null ? 'nunca' : x.dias_sin_venta, x.edad_dias, x.meses_para_agotar]));
      [9, 10].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

      const wu = wb.addWorksheet('Ubicaciones');
      cab(wu, 'Inventario — por ubicación', [['Ubicación', 30], ['Tipo', 14], ['Cuenta como', 14], ['Unidades', 11],
        ['Disponibles', 11], ['Reservadas', 11], ['SKUs', 9], ['Capital (S/)', 14]]);
      const NOM_CL = { propio: 'Propio', consignacion: 'Consignación', no_vendible: 'No vendible' };
      const NOM_TIPO = { warehouse: 'Almacén', store: 'Tienda', consignment: 'Consignación' };
      d.ubicaciones.forEach(u => wu.addRow([u.nombre + (u.activa ? '' : ' (inactiva)'), NOM_TIPO[u.tipo] || u.tipo, NOM_CL[u.clase],
        u.unidades, u.disponibles, u.reservadas, u.skus, u.capital]));
      wu.getColumn(8).numFmt = '#,##0.00';

      const wm = wb.addWorksheet('Marcas');
      cab(wm, 'Inventario — por marca', [['Marca', 20], ['Referencias', 11], ['Stock', 9], ['Capital (S/)', 14],
        ['Vendido 12m', 11], ['Meses p/ agotar', 13], ['Ref. estancadas', 13], ['Capital estancado (S/)', 18]]);
      d.marcas.forEach(m => wm.addRow([m.marca, m.referencias, m.stock, m.capital, m.und_12m, m.meses_para_agotar,
        m.estancados, m.capital_estancado]));
      [4, 8].forEach(c => wm.getColumn(c).numFmt = '#,##0.00');

      const nombre = nombreTrazable('inventario');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });
};

module.exports._test = { calcularInventario, leerFiltros, estadoDe, claseUbicacion };
