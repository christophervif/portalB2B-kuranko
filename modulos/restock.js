// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Restock — qué pedir y cuánto (versión simple, nov 2026)
//  Frontend: public/restock.html (iframe dentro de admin.html).
//
//  Idea: "quiero tener stock para N meses de venta" (por defecto 2).
//    venta/mes  = unidades vendidas en los últimos 90 días ÷ días × 30
//                 (si el producto llegó hace menos de 90 días, se mide desde que llegó, mín. 30 d)
//    disponible = stock propio + en camino libre − clientes esperando (backorders sin comprar)
//    pedir      = venta/mes × meses − disponible   (redondeado hacia arriba; solo si > 0)
//
//  Igual que el Cotizador (sin modificarlo):
//    · Stock propio = almacenes y tiendas. NO cuenta consignación (está en el cliente) ni
//      ubicaciones no vendibles (cuarentena, exhibición, embajador: COTIZADOR_OTROS).
//    · Antigüedad = fecha de ingreso del lote más antiguo con stock en ubicaciones propias
//      (los lotes en consignación se omiten).
//    · Marca = primer tramo del nombre ("Magura - Freno - …" → "Magura").
//    · Bicicleta = misma clasificación por categorías que el Cotizador (tipoProducto).
//    · En camino = envíos de Seguimiento no recibidos + recepciones pendientes (sin duplicar).
//
//  Vistas: "General" (todo menos bicicletas y marcas aparte), "Bicicletas" y una por cada
//  marca que se compra aparte. La lista de marcas aparte se edita en la misma pantalla y se
//  guarda en la base del PORTAL (tabla restock_config, se crea sola).
// ═══════════════════════════════════════════════════════════════════════════

const { nombreTrazable, cabeceraExcel } = require('./comunes');
// Solo LECTURA de funciones puras del Cotizador (clasificación y normalización). No se modifica.
const COT = require('./cotizador')._puros;

const VENTANA = 90;              // días de venta que se miran
const MIN_DIAS_NUEVO = 30;       // un producto nuevo se mide al menos sobre 30 días
const CACHE_MS = 5 * 60 * 1000;  // los datos se recalculan como máximo cada 5 min (botón Actualizar fuerza)
const MARCAS_APARTE_BASE = ['Magura', 'Fidlock', 'Zerode', 'Kavenz', '77designz'];

const OTROS = (process.env.COTIZADOR_OTROS || process.env.COTIZADOR_NO_VENDIBLES || 'CUARENTENA,EN EXHIBICION,EMBAJADOR')
  .split(',').map(x => x.trim()).filter(Boolean);
const normalizar = COT.normalizar;
const compacto = COT.compacto;           // sin espacios ni signos: "77 Designz" = "77designz"
const OTROS_SET = new Set(OTROS.map(normalizar));
const marcaDe = (producto, nombre) => String(producto || nombre || '').split(' - ')[0].trim();
const json = v => { if (v == null) return []; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return []; } };
const dia = v => v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null;
const diasDesde = d => d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 864e5)) : null;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;

// ── Cálculo puro (sin base de datos) — exportado para pruebas ──
//  f = { und90, dias_desde_ingreso, stock, camino, esperando }
function calcular(f, meses) {
  const und = Number(f.und90) || 0;
  let dias = VENTANA;
  if (f.dias_desde_ingreso != null && f.dias_desde_ingreso < VENTANA) dias = Math.max(MIN_DIAS_NUEVO, f.dias_desde_ingreso);
  const ventaMes = und > 0 ? und / dias * 30 : 0;
  const disponible = (Number(f.stock) || 0) + (Number(f.camino) || 0) - (Number(f.esperando) || 0);
  const pedir = ventaMes > 0 ? Math.max(0, Math.ceil(ventaMes * meses - disponible - 1e-9)) : 0;
  const alcanza = ventaMes > 0 ? Math.max(0, disponible) / ventaMes : null;   // meses
  const estado = (Number(f.stock) || 0) <= 0 ? 'sin_stock' : (alcanza != null && alcanza < 1 ? 'bajo' : 'reponer');
  return { venta_mes: r1(ventaMes), dias_medidos: dias, disponible, pedir, alcanza: alcanza == null ? null : r1(alcanza), estado };
}

// Vista a la que pertenece un producto
function vistaDe(marca, esBici, aparteSet) {
  const k = compacto(marca);
  if (k && aparteSet.has(k)) return 'marca:' + k;
  if (esBici) return 'bicicletas';
  return 'general';
}

module.exports = function registrarRestock({ app, authAdmin, mRestock, prodPool, portalPool, VV }) {
  VV = VV || "('paid','confirmed','pending_payment')";

  // ══════════ Configuración (marcas que se compran aparte) ══════════
  let _tablaLista = null;
  function tablaConfig() {
    if (!portalPool) return Promise.resolve(false);
    if (!_tablaLista) _tablaLista = portalPool.query(`
      CREATE TABLE IF NOT EXISTS restock_config (
        id INT PRIMARY KEY,
        datos JSON NOT NULL,
        actualizado_por VARCHAR(120) NOT NULL DEFAULT '',
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`).then(() => true).catch(e => { console.warn('[restock] sin tabla de configuración:', e.message); _tablaLista = null; return false; });
    return _tablaLista;
  }
  async function leerConfig() {
    const base = { marcas_aparte: MARCAS_APARTE_BASE.slice(), bicis_aparte: true };
    try {
      if (!(await tablaConfig())) return base;
      const [[r]] = await portalPool.query('SELECT datos FROM restock_config WHERE id = 1');
      if (!r) return base;
      const d = json(r.datos);
      return {
        marcas_aparte: Array.isArray(d.marcas_aparte) ? d.marcas_aparte.map(String) : base.marcas_aparte,
        bicis_aparte: d.bicis_aparte !== false
      };
    } catch (e) { return base; }
  }

  // ══════════ Datos (caché 5 min) ══════════
  let _datos = null, _datosAt = 0, _cargando = null;

  async function columnaLocLote() {
    try {
      const [c] = await prodPool.query('SHOW COLUMNS FROM stock_batches');
      const n = c.map(x => x.Field);
      return ['location_id', 'warehouse_id', 'current_location_id'].find(x => n.includes(x)) || '';
    } catch (e) { return ''; }
  }

  // Mercadería en camino (misma regla que el Cotizador): SKU compacto → { cant, para_clientes, eta }
  async function enCamino() {
    const mapa = new Map();
    const agregar = (sku, cant, paraClientes, eta) => {
      const k = compacto(sku); if (!k || !(cant > 0)) return;
      const e = mapa.get(k) || { cant: 0, para_clientes: 0, eta: null };
      e.cant += cant; e.para_clientes += paraClientes || 0;
      if (eta && (!e.eta || eta < e.eta)) e.eta = eta;
      mapa.set(k, e);
    };
    if (!portalPool) return { mapa, ok: false };
    let ok = true;
    const facturasEnCamino = new Set();
    try {
      const [envs] = await portalPool.query(`SELECT n_factura, eta, fecha_estimada, items
        FROM seg_envios WHERE archivado = 0 AND estado <> 'recibido' AND fase <> 'recibido'`)
        .catch(() => portalPool.query(`SELECT n_factura, NULL AS eta, fecha_estimada, items
          FROM seg_envios WHERE archivado = 0 AND estado <> 'recibido'`));
      envs.forEach(e => {
        if (e.n_factura) facturasEnCamino.add(normalizar(e.n_factura));
        const eta = dia(e.eta) || dia(e.fecha_estimada);
        json(e.items).forEach(it => {
          const q = Number(it.cantidad) || 0;
          agregar(it.sku, q, it.es_backorder ? q : 0, eta);
        });
      });
    } catch (e) { ok = false; }
    try {
      const [recs] = await portalPool.query(`SELECT n_factura, items FROM imp_recepciones
        WHERE estado IN ('pendiente','borrador') AND COALESCE(archivada,0) = 0`)
        .catch(() => portalPool.query(`SELECT n_factura, items FROM imp_recepciones WHERE estado IN ('pendiente','borrador')`));
      recs.forEach(r => {
        if (r.n_factura && facturasEnCamino.has(normalizar(r.n_factura))) return;
        json(r.items).forEach(it => {
          const cant = it.cant_recibida != null ? Number(it.cant_recibida) : Number(it.cantidad) || 0;
          agregar(it.sku_confirmado || it.sku_sugerido, cant, 0, null);
        });
      });
    } catch (e) { /* sin recepciones: no pasa nada */ }
    return { mapa, ok };
  }

  // Clientes esperando: backorders gestionados en Seguimiento aún sin comprar (cantidad − cubierto)
  async function esperando() {
    const m = new Map();
    if (!portalPool) return m;
    try {
      const [bos] = await portalPool.query(
        `SELECT sku, cantidad, cubierto FROM seg_bo_items WHERE archivado = 0 AND comprado = 0`);
      bos.forEach(b => {
        const k = compacto(b.sku); if (!k) return;
        const falta = Math.max(0, (Number(b.cantidad) || 0) - (Number(b.cubierto) || 0));
        if (falta > 0) m.set(k, (m.get(k) || 0) + falta);
      });
    } catch (e) { /* sin seguimiento */ }
    return m;
  }

  async function cargarDatos(forzar) {
    if (!forzar && _datos && Date.now() - _datosAt < CACHE_MS) return _datos;
    if (_cargando) return _cargando;
    _cargando = (async () => {
      const cLoc = await columnaLocLote();
      const [[prods], [stock], [cats], [ventas], [lotes], [ultCosto], camino, esp] = await Promise.all([
        // Solo productos activos (borrador y descontinuado no se reponen)
        prodPool.query(`
          SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.name AS variacion, pv.product_id AS pid, p.name AS producto
          FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
          WHERE pv.deleted_at IS NULL AND (p.id IS NULL OR p.deleted_at IS NULL)
            AND COALESCE(pv.product_type,'') <> 'variable'
            AND (pv.status IS NULL OR pv.status = 'active')`),
        prodPool.query(`
          SELECT ls.product_variation_id AS vid, l.name AS almacen, l.type AS tipo,
            GREATEST(ls.quantity - ls.reserved_quantity, 0) AS disp
          FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
          WHERE ls.quantity > 0`),
        prodPool.query(`
          SELECT ppc.product_id AS pid, c.name AS cat, padre.name AS padre
          FROM product_product_category ppc
          JOIN product_categories c ON c.id = ppc.product_category_id
          LEFT JOIN product_categories padre ON padre.id = c.parent_id`).catch(() => [[]]),
        prodPool.query(`
          SELECT si.product_variation_id AS vid,
            SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL ${VENTANA} DAY) THEN si.quantity ELSE 0 END) AS und90,
            COUNT(DISTINCT CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL ${VENTANA} DAY) THEN s.id END) AS ventas90,
            MAX(s.created_at) AS ultima_venta
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          GROUP BY si.product_variation_id`),
        // Lotes en ubicaciones propias (se omiten los de consignación, como en el Cotizador):
        //  · antigüedad = lote más antiguo CON stock · primer ingreso = lote más antiguo de todos
        prodPool.query(cLoc ? `
          SELECT b.product_variation_id AS vid,
            MIN(CASE WHEN b.quantity > 0 THEN b.entry_date END) AS antiguo,
            MIN(b.entry_date) AS primer_ingreso
          FROM stock_batches b LEFT JOIN locations l ON l.id = b.\`${cLoc}\`
          WHERE COALESCE(l.type,'') <> 'consignment'
          GROUP BY b.product_variation_id` : `
          SELECT product_variation_id AS vid,
            MIN(CASE WHEN quantity > 0 THEN entry_date END) AS antiguo,
            MIN(entry_date) AS primer_ingreso
          FROM stock_batches GROUP BY product_variation_id`),
        // Costo de la última compra (para estimar cuánto cuesta el pedido)
        prodPool.query(`
          SELECT b.product_variation_id AS vid, b.cost_price AS costo
          FROM stock_batches b
          JOIN (SELECT product_variation_id, MAX(id) AS mid FROM stock_batches WHERE cost_price > 0
                GROUP BY product_variation_id) u ON u.mid = b.id`),
        enCamino(),
        esperando()
      ]);

      // Imágenes (opcional: si falla, no hay miniatura)
      const imgVar = {}, imgProd = {};
      try {
        const [imgs] = await prodPool.query(`
          SELECT product_id, product_variation_id, path FROM product_images
          WHERE deleted_at IS NULL AND path IS NOT NULL AND path <> ''
          ORDER BY is_primary DESC, sort_order ASC, id ASC`);
        imgs.forEach(im => {
          if (im.product_variation_id != null) { if (!imgVar[im.product_variation_id]) imgVar[im.product_variation_id] = im.path; }
          else if (im.product_id != null && !imgProd[im.product_id]) imgProd[im.product_id] = im.path;
        });
      } catch (e) { /* sin imágenes */ }

      const stMap = {};
      stock.forEach(s => {
        const e = stMap[s.vid] = stMap[s.vid] || { propio: 0, consignacion: 0, otros: 0 };
        const d = Number(s.disp) || 0;
        if (s.tipo === 'consignment') e.consignacion += d;
        else if (OTROS_SET.has(normalizar(s.almacen))) e.otros += d;
        else e.propio += d;
      });
      const catMap = {};
      cats.forEach(r => { (catMap[r.pid] = catMap[r.pid] || []).push([r.padre, r.cat].filter(Boolean).join(' ')); });
      const vMap = {}; ventas.forEach(v => vMap[v.vid] = v);
      const lMap = {}; lotes.forEach(l => lMap[l.vid] = l);
      const cMap = {}; ultCosto.forEach(c => cMap[c.vid] = Number(c.costo) || 0);

      const items = [];
      prods.forEach(p => {
        const v = vMap[p.vid];
        if (!v || !(Number(v.und90) > 0)) return;          // sin venta en 90 días: no se repone
        const nombre = (p.variacion || '').trim() || (p.producto || '').trim() || '—';
        const st = stMap[p.vid] || { propio: 0, consignacion: 0, otros: 0 };
        const l = lMap[p.vid] || {};
        const k = compacto(p.sku);
        const cam = (k && camino.mapa.get(k)) || { cant: 0, para_clientes: 0, eta: null };
        const categorias = (catMap[p.pid] || []).join(' | ');
        items.push({
          vid: p.vid, sku: p.sku || '', nombre,
          marca: marcaDe(p.producto, nombre) || '—',
          bici: COT.tipoProducto(categorias, p.producto || nombre) === 'bicicleta',
          imagen: imgVar[p.vid] || imgProd[p.pid] || null,
          stock: st.propio, consignacion: st.consignacion, no_vendible: st.otros,
          camino: Math.max(0, cam.cant - cam.para_clientes), camino_clientes: cam.para_clientes, eta: cam.eta,
          esperando: (k && esp.get(k)) || 0,
          und90: Number(v.und90) || 0, ventas90: Number(v.ventas90) || 0,
          ultima_venta: dia(v.ultima_venta),
          lote_antiguo: dia(l.antiguo), primer_ingreso: dia(l.primer_ingreso),
          costo: cMap[p.vid] || 0
        });
      });
      _datos = { items, camino_ok: camino.ok, hora: new Date().toISOString() };
      _datosAt = Date.now();
      return _datos;
    })();
    try { return await _cargando; } finally { _cargando = null; }
  }

  // Arma la respuesta: calcula, filtra por vista y resume cada vista
  async function obtener(q) {
    const meses = Math.min(12, Math.max(0.5, Number(q.meses) || 2));
    const [d, cfg] = await Promise.all([cargarDatos(q.forzar === '1'), leerConfig()]);
    const aparte = cfg.marcas_aparte.map(m => ({ nombre: m, k: compacto(m) })).filter(m => m.k);
    const aparteSet = new Set(aparte.map(m => m.k));

    const todos = d.items.map(x => {
      const c = calcular({
        und90: x.und90, dias_desde_ingreso: diasDesde(x.primer_ingreso),
        stock: x.stock, camino: x.camino, esperando: x.esperando
      }, meses);
      return {
        ...x, ...c,
        vista: vistaDe(x.marca, cfg.bicis_aparte && x.bici, aparteSet),
        antiguedad_dias: diasDesde(x.lote_antiguo),
        dias_sin_venta: diasDesde(x.ultima_venta),
        inversion: r2(c.pedir * x.costo)
      };
    }).filter(x => x.pedir > 0);

    // Vistas con su conteo (para el selector)
    const cuenta = v => todos.filter(x => x.vista === v).length;
    const vistas = [{ id: 'general', nombre: 'General', n: cuenta('general') }];
    if (cfg.bicis_aparte) vistas.push({ id: 'bicicletas', nombre: 'Bicicletas', n: cuenta('bicicletas') });
    aparte.forEach(m => vistas.push({ id: 'marca:' + m.k, nombre: m.nombre, n: cuenta('marca:' + m.k) }));

    const vista = vistas.some(v => v.id === q.vista) ? q.vista : 'general';
    const ORD = { sin_stock: 0, bajo: 1, reponer: 2 };
    const items = todos.filter(x => x.vista === vista)
      .sort((a, b) => (ORD[a.estado] - ORD[b.estado]) || (b.venta_mes - a.venta_mes));

    return {
      meses, ventana: VENTANA, vista, vistas, config: cfg,
      camino_ok: d.camino_ok, actualizado: d.hora,
      marcas: [...new Set(d.items.map(x => x.marca))].filter(m => m && m !== '—').sort((a, b) => a.localeCompare(b, 'es')),
      items
    };
  }

  app.get('/api/restock', authAdmin, mRestock, async (req, res) => {
    try { res.json(await obtener(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Guardar la configuración de vistas (marcas aparte, bicicletas aparte)
  app.post('/api/restock/config', authAdmin, mRestock, async (req, res) => {
    try {
      if (!(await tablaConfig())) return res.status(500).json({ error: 'No hay base del portal para guardar.' });
      const b = req.body || {};
      const vistos = new Set();
      const marcas = (Array.isArray(b.marcas_aparte) ? b.marcas_aparte : [])
        .map(m => String(m || '').trim().slice(0, 60)).filter(m => {
          const k = compacto(m); if (!k || vistos.has(k)) return false; vistos.add(k); return true;
        }).slice(0, 40);
      const datos = { marcas_aparte: marcas, bicis_aparte: b.bicis_aparte !== false };
      const quien = String((req.admin && req.admin.usuario) || '').slice(0, 120);
      await portalPool.query(
        `INSERT INTO restock_config (id, datos, actualizado_por) VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE datos = VALUES(datos), actualizado_por = VALUES(actualizado_por)`,
        [JSON.stringify(datos), quien]);
      res.json({ ok: true, config: datos });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Excel del pedido: recibe las filas tal como están en pantalla (con las cantidades editadas)
  app.post('/api/restock/excel', authAdmin, mRestock, async (req, res) => {
    try {
      const b = req.body || {};
      const filas = (Array.isArray(b.filas) ? b.filas : []).slice(0, 5000);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Pedido');
      const cols = [['SKU', 18], ['Producto', 50], ['Marca', 14], ['Stock', 9], ['En camino', 10],
        ['Venta/mes', 10], ['Alcanza (meses)', 14], ['Antigüedad (días)', 15], ['Pedir', 9], ['Costo unit. (S/)', 14], ['Total (S/)', 14]];
      const filasCab = cabeceraExcel(ws, 'Restock — pedido ' + String(b.vista || ''), [
        ['Stock para', (Number(b.meses) || 2) + ' meses'], ['Venta medida', VENTANA + ' días']
      ], cols.length);
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      const n = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);
      filas.forEach(x => {
        const pedir = n(x.pedir) || 0, costo = n(x.costo);
        ws.addRow([String(x.sku || ''), String(x.nombre || ''), String(x.marca || ''), n(x.stock), n(x.camino),
          n(x.venta_mes), n(x.alcanza), n(x.antiguedad_dias), pedir, costo || null, costo ? r2(costo * pedir) : null]);
      });
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      ws.autoFilter = { from: { row: filasCab + 1, column: 1 }, to: { row: filasCab + 1, column: cols.length } };
      [10, 11].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('restock');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });
};

module.exports._puros = { calcular, vistaDe, marcaDe, VENTANA, MARCAS_APARTE_BASE };
