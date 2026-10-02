// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de catálogo (+ chequeo de empresa en ventas)
//  Backend aquí; frontend propio en public/auditoria.html (iframe en el panel).
//  Antes vivía dentro de modulos/sincronizacion.js y admin.html.
//
//  Endpoints (permiso: auditoria)
//    GET /admin/auditoria            → último análisis guardado (sin recalcular)
//    GET /admin/auditoria?force=1    → recalcula, guarda y devuelve
//    GET /admin/auditoria-excel      → Excel del análisis GUARDADO (lo mismo que se ve en
//                                      pantalla), con los filtros de la pantalla
//    GET /admin/chequeo-empresas[-excel]  ?tipo=…&dias=90|365|0
//
//  Reglas (todo del ERP, SOLO LECTURA)
//  · "Stock" = stock propio (almacenes y tiendas): sin consignación (está en el cliente)
//    ni ubicaciones no vendibles (COTIZADOR_OTROS). Es lo que realmente se puede vender
//    en la web. El stock en consignación se muestra aparte.
//  · Pendientes en la web: variación/simple sin woocommerce_id con stock propio > 0 o
//    con un backorder ABIERTO (venta viva, ítem a pedido aún sin lote).
//  · Margen sobre el precio que paga el cliente (oferta si está vigente, si no regular)
//    contra el costo FIFO (lote más antiguo con existencia). Ambos incluyen IGV.
//      < 0 % → crítico (venta a pérdida) · < 10 % → importante · < 20 % → info
//  · Costos y márgenes solo los ve el admin maestro (al resto se le ocultan los montos).
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel } = require('./comunes');
const { claseUbicacion } = require('./inventario').comun;

const DIA = 864e5;
const MARGEN_CRITICO = 0, MARGEN_RIESGO = 10, MARGEN_BAJO = 20; // % sobre precio
const DIAS_VENTA_VARIABLE = 365; // ventas al padre 'variable' que se reportan

// Catálogo de reglas: código → tipo (texto), severidad y grupo
const REGLAS = {
  sku_duplicado:    { tipo: 'SKU duplicado',            sev: 'critico',    grupo: 'Web y sincronización' },
  wc_duplicado:     { tipo: 'WooCommerce ID duplicado', sev: 'critico',    grupo: 'Web y sincronización' },
  sin_sku:          { tipo: 'Sin SKU',                  sev: 'critico',    grupo: 'Web y sincronización' },
  padre_vacio:      { tipo: 'Padre sin variaciones',    sev: 'importante', grupo: 'Web y sincronización' },
  falta_precio:     { tipo: 'Falta precio',             sev: 'critico',    grupo: 'Datos del producto' },
  falta_imagen:     { tipo: 'Falta imagen',             sev: 'importante', grupo: 'Datos del producto' },
  falta_desc:       { tipo: 'Falta descripción',        sev: 'importante', grupo: 'Datos del producto' },
  sin_categoria:    { tipo: 'Sin categoría',            sev: 'importante', grupo: 'Datos del producto' },
  borrador_stock:   { tipo: 'Borrador con stock',       sev: 'importante', grupo: 'Datos del producto' },
  descont_stock:    { tipo: 'Descontinuado con stock',  sev: 'importante', grupo: 'Datos del producto' },
  oferta_mal:       { tipo: 'Oferta mal puesta',        sev: 'critico',    grupo: 'Precios y márgenes' },
  margen_perdida:   { tipo: 'Venta a pérdida',          sev: 'critico',    grupo: 'Precios y márgenes' },
  margen_riesgo:    { tipo: 'Margen < 10%',             sev: 'importante', grupo: 'Precios y márgenes' },
  margen_bajo:      { tipo: 'Margen < 20%',             sev: 'info',       grupo: 'Precios y márgenes' },
  sin_costo:        { tipo: 'Costo no registrado',      sev: 'importante', grupo: 'Precios y márgenes' },
  stock_negativo:   { tipo: 'Stock negativo',           sev: 'critico',    grupo: 'Stock y estructura' },
  variable_stock:   { tipo: 'Variable con stock',       sev: 'importante', grupo: 'Stock y estructura' },
  variable_venta:   { tipo: 'Variable con venta',       sev: 'info',       grupo: 'Stock y estructura' }
};
const ORDEN_SEV = { critico: 0, importante: 1, info: 2 };
const NOM_ESTADO = { draft: 'borrador', discontinued: 'descontinuado', active: 'activo' };

const r2 = n => Math.round(n * 100) / 100;
const num = x => (x === null || x === undefined || x === '') ? null : Number(x);
const soles = n => 'S/' + Number(n).toFixed(2);
// Descripción "vacía" también si solo tiene etiquetas HTML o espacios (<p></p>, &nbsp;)
const textoVacio = t => !String(t || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
const esMkpPck = (...txt) => txt.some(t => /MKP|PCK/i.test(String(t || '')));
const marcaDe = producto => (String(producto || '').trim().split(/\s+/)[0] || '—');

// ─── Cálculo puro (sin base de datos) — exportado para pruebas ──────────────
//  d = { vars:[{id,product_id,sku,nombre,producto,product_type,status,regular_price,sale_price,
//               woocommerce_id,descripcion}],
//        stock:[{vid,loc_tipo,loc_nombre,qty}],          // suma por variación y ubicación
//        lotes:[{vid,costo,entrada,id}],                 // lotes con existencia
//        imgs:{prod:[product_id…], vari:[variation_id…]},
//        cats:[product_id…],
//        backorders:[{vid,unidades}],                     // abiertos
//        ventasVariable:[{vid,num_ventas,unidades,ultima}] }
function calcularAuditoria(d) {
  const stockDe = {};   // vid → { propio, consig, otros, negativo }
  d.stock.forEach(s => {
    const q = Number(s.qty) || 0;
    const e = stockDe[s.vid] = stockDe[s.vid] || { propio: 0, consig: 0, otros: 0, negativo: [] };
    // Un negativo se reporta aparte y no resta del stock de las otras ubicaciones
    if (q < 0) { e.negativo.push(`${s.loc_nombre || 'ubicación'}: ${q}`); return; }
    const c = claseUbicacion(s.loc_tipo, s.loc_nombre);
    if (c === 'propio') e.propio += q; else if (c === 'consignacion') e.consig += q; else e.otros += q;
  });
  // Costo FIFO = lote más antiguo con existencia
  const fifo = {};
  [...d.lotes].sort((a, b) => (new Date(a.entrada) - new Date(b.entrada)) || (a.id - b.id))
    .forEach(l => { if (!(l.vid in fifo)) fifo[l.vid] = Number(l.costo) || 0; });
  const imgProd = new Set(d.imgs.prod.map(String)), imgVar = new Set(d.imgs.vari.map(String));
  const conCat = new Set(d.cats.map(String));
  const bo = {}; d.backorders.forEach(b => bo[b.vid] = Number(b.unidades) || 0);

  // Duplicados: SKU sin distinguir mayúsculas/espacios, en TODO el catálogo
  // (WooCommerce exige SKU único entre productos y variaciones). WC ID entre filas.
  const cuentaSku = {}, cuentaWc = {};
  d.vars.forEach(v => {
    const k = String(v.sku || '').trim().toUpperCase();
    if (k) cuentaSku[k] = (cuentaSku[k] || 0) + 1;
    if (v.woocommerce_id) cuentaWc[v.woocommerce_id] = (cuentaWc[v.woocommerce_id] || 0) + 1;
  });

  // Hijas activas por producto (para "padre sin variaciones")
  const hijasActivas = {};
  d.vars.forEach(v => { if (v.product_type === 'variation' && v.status === 'active') hijasActivas[v.product_id] = (hijasActivas[v.product_id] || 0) + 1; });

  const alertas = [], pendientes = [];
  const ficha = v => {
    const st = stockDe[v.id] || { propio: 0, consig: 0, otros: 0, negativo: [] };
    return {
      vid: v.id, sku: String(v.sku || '').trim(), wc: v.woocommerce_id || '',
      nombre: v.nombre || v.producto || '', marca: marcaDe(v.producto || v.nombre),
      estado: NOM_ESTADO[v.status] || v.status || '', tipo_prod: v.product_type,
      stock: st.propio, consig: st.consig
    };
  };
  const push = (cod, f, obs, obsCosto) => alertas.push({ cod, ...REGLAS[cod], ...f, obs, obs_costo: obsCosto || null });

  for (const v of d.vars) {
    const f = ficha(v);
    const st = stockDe[v.id] || { propio: 0, consig: 0, otros: 0, negativo: [] };
    const skuK = f.sku.toUpperCase();
    const vendible = v.product_type === 'variation' || v.product_type === 'simple';

    // ── Reglas para todo el catálogo ──
    if (skuK && cuentaSku[skuK] > 1) push('sku_duplicado', f, `El SKU "${f.sku}" aparece ${cuentaSku[skuK]} veces en el catálogo (sin distinguir mayúsculas)`);
    if (v.woocommerce_id && cuentaWc[v.woocommerce_id] > 1) push('wc_duplicado', f, `El WooCommerce ID ${v.woocommerce_id} está en ${cuentaWc[v.woocommerce_id]} productos: la sincronización pisa uno con otro`);
    if (st.negativo.length) push('stock_negativo', f, `Stock negativo en ${st.negativo.join(', ')}`);

    if (v.product_type === 'variable') {
      const tot = st.propio + st.consig + st.otros;
      if (tot > 0) push('variable_stock', f, `Producto variable (padre) con ${tot} en stock: el stock debe estar en sus variaciones`);
      if (v.woocommerce_id && !hijasActivas[v.product_id]) push('padre_vacio', f, 'Está en la web pero no tiene ninguna variación activa (sale vacío en la tienda)');
      continue;
    }
    if (!vendible) continue;

    if (!f.sku && (st.propio > 0 || v.woocommerce_id)) push('sin_sku', f, 'Sin SKU: el puente con la web empareja por SKU');

    const reg = num(v.regular_price), sale = num(v.sale_price);
    if (sale > 0 && reg > 0 && sale >= reg) push('oferta_mal', f, `Precio de oferta ${soles(sale)} es mayor o igual al regular ${soles(reg)}`);

    // ── Pendiente en la web ──
    if (!v.woocommerce_id && (st.propio > 0 || bo[v.id] > 0)) {
      const falta = [];
      if (!f.sku) falta.push('SKU');
      else if (cuentaSku[skuK] > 1) falta.push('SKU único (está duplicado)');
      if (!(reg > 0)) falta.push('precio');
      if (!imgVar.has(String(v.id)) && !imgProd.has(String(v.product_id))) falta.push('imagen');
      if (textoVacio(v.descripcion)) falta.push('descripción');
      if (!conCat.has(String(v.product_id))) falta.push('categoría');
      if (v.status !== 'active') falta.push('estado ' + (NOM_ESTADO[v.status] || v.status));
      pendientes.push({ ...f, precio: reg, backorder: bo[v.id] || 0,
        motivo: st.propio > 0 ? 'stock' : 'backorder', mkp: esMkpPck(v.sku, v.nombre, v.producto), falta });
    }

    if (!(st.propio > 0)) continue;
    // ── Reglas con stock propio ──
    const s = st.propio;
    if (!(reg > 0)) push('falta_precio', f, `Tiene ${s} en stock pero no tiene precio regular`);
    if (!imgVar.has(String(v.id)) && !imgProd.has(String(v.product_id))) push('falta_imagen', f, `Tiene ${s} en stock pero no tiene imagen`);
    if (textoVacio(v.descripcion)) push('falta_desc', f, `Tiene ${s} en stock pero el producto no tiene descripción`);
    if (!conCat.has(String(v.product_id))) push('sin_categoria', f, `Tiene ${s} en stock pero el producto no tiene categoría`);
    if (v.status === 'draft') push('borrador_stock', f, `Tiene ${s} en stock pero está en borrador (no se vende en la web)`);
    if (v.status === 'discontinued') push('descont_stock', f, `Tiene ${s} en stock pero está descontinuado`);

    if (esMkpPck(v.sku, v.nombre, v.producto)) continue; // marketplace / packs: sin costo propio
    const costo = fifo[v.id];
    if (!(costo > 0)) {
      push('sin_costo', f, costo === 0 ? `Tiene ${s} en stock pero su costo FIFO es 0.00` : `Tiene ${s} en stock pero no tiene lote con costo (stock sin lote)`);
      continue;
    }
    // Precio que paga hoy el cliente: oferta si es válida, si no el regular. Una alerta por SKU.
    const ofertaOk = sale > 0 && (!(reg > 0) || sale < reg);
    const precio = ofertaOk ? sale : reg;
    if (!(precio > 0)) continue;
    const margen = (precio - costo) / precio * 100;
    const cod = margen < MARGEN_CRITICO ? 'margen_perdida' : margen < MARGEN_RIESGO ? 'margen_riesgo' : margen < MARGEN_BAJO ? 'margen_bajo' : null;
    if (cod) {
      const cual = ofertaOk ? 'oferta' : 'regular';
      push(cod, { ...f, margen: r2(margen) },
        `Precio ${cual} por debajo del margen mínimo — revisar precio`,
        `Precio ${cual} ${soles(precio)} vs costo FIFO ${soles(costo)} → margen ${margen.toFixed(1)}%`);
    }
  }

  // Ventas hechas al padre 'variable' (último año)
  const porId = {}; d.vars.forEach(v => porId[v.id] = v);
  d.ventasVariable.forEach(x => {
    const v = porId[x.vid]; if (!v) return;
    const ult = x.ultima ? new Date(x.ultima).toISOString().slice(0, 10) : '';
    push('variable_venta', ficha(v), `${x.num_ventas} venta(s) (${x.unidades} und.) al producto padre en el último año, la última el ${ult}: deberían ir a la variación`);
  });

  alertas.sort((a, b) => ORDEN_SEV[a.sev] - ORDEN_SEV[b.sev] || a.tipo.localeCompare(b.tipo) || a.sku.localeCompare(b.sku));
  pendientes.sort((a, b) => (a.falta.length - b.falta.length) || b.stock - a.stock || a.nombre.localeCompare(b.nombre));
  return { alertas, pendientes };
}

// Resumen (conteos) a partir del resultado
function resumir(alertas, pendientes) {
  const por_tipo = {}, por_sev = { critico: 0, importante: 0, info: 0 }, skus = new Set();
  alertas.forEach(a => { por_tipo[a.tipo] = (por_tipo[a.tipo] || 0) + 1; por_sev[a.sev]++; skus.add(a.vid); });
  return {
    total_alertas: alertas.length, total_pendientes: pendientes.length,
    skus_con_alerta: skus.size, por_sev, conteo_por_tipo: por_tipo,
    pendientes_listos: pendientes.filter(p => !p.falta.length).length
  };
}

// Oculta costos y márgenes (para quien no es maestro)
function paraUsuario(data, verCostos) {
  return {
    ...data,
    ver_costos: !!verCostos,
    alertas: data.alertas.map(({ obs_costo, margen, ...a }) =>
      verCostos ? { ...a, margen, obs: obs_costo || a.obs } : a)
  };
}

// Filtros de la pantalla (también para el Excel)
function filtrarAlertas(lista, q) {
  q = q || {};
  const t = String(q.q || '').toLowerCase().trim();
  return lista.filter(a =>
    (!q.sev || a.sev === q.sev) && (!q.tipo || a.tipo === q.tipo) && (!q.marca || a.marca === q.marca) &&
    (!q.estado || a.estado === q.estado) &&
    (!q.web || (q.web === 'si' ? !!a.wc : !a.wc)) &&
    (!t || [a.sku, a.nombre, a.obs].some(x => String(x || '').toLowerCase().includes(t))));
}

// ─── Chequeo de empresa en ventas (puro) ────────────────────────────────────
// Un ítem a pedido (backorder sin lote) NO es "sin lote": es normal que no tenga.
function agruparChequeo(rows, tipo) {
  const porVenta = {};
  rows.forEach(r => {
    const v = porVenta[r.id] = porVenta[r.id] || {
      id: r.id, code: r.code, empresa_venta: r.empresa_venta, status: r.status,
      fecha: r.created_at, total: Number(r.total), items: [], problemas: new Set()
    };
    const aPedido = r.stock_batch_id == null && !!(Number(r.is_backorder) || r.pending_stock_entry_id);
    v.items.push({ sku: r.sku || '—', empresa_producto: r.empresa_producto, a_pedido: aPedido });
    if (r.empresa_venta == null) v.problemas.add('sin_empresa');
    if (r.empresa_producto == null) { if (!aPedido) v.problemas.add('sin_lote'); }
    else if (r.empresa_venta != null && Number(r.empresa_producto) !== Number(r.empresa_venta)) v.problemas.add('no_coincide');
  });
  let lista = Object.values(porVenta).filter(v => v.problemas.size).map(v => ({
    id: v.id, code: v.code, empresa_venta: v.empresa_venta, status: v.status, fecha: v.fecha, total: v.total,
    problemas: [...v.problemas],
    empresas_producto: [...new Set(v.items.map(i => i.empresa_producto).filter(x => x != null))],
    num_items: v.items.length
  }));
  if (tipo) lista = lista.filter(v => v.problemas.includes(tipo));
  return lista;
}

module.exports = function registrarAuditoria({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mAud = requiereModulo('auditoria');
  const esMaestro = req => !!(req.admin && req.admin.maestro);

  async function prepararTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS auditoria_cache (
        id INT PRIMARY KEY DEFAULT 1,
        generado_en DATETIME,
        resultado LONGTEXT
      )`);
  }

  // Lee del ERP todo lo necesario (consultas agrupadas, sin subconsultas por fila)
  async function leerDatos() {
    const q = sql => prodPool.query(sql).then(r => r[0]);
    const [vars, stock, lotes, imgs, cats, backorders, ventasVariable] = await Promise.all([
      q(`SELECT pv.id, pv.product_id, TRIM(pv.sku) AS sku, pv.name AS nombre, p.name AS producto,
                pv.product_type, pv.status, pv.regular_price, pv.sale_price, pv.woocommerce_id,
                p.description AS descripcion
           FROM product_variations pv JOIN products p ON p.id = pv.product_id
          WHERE pv.deleted_at IS NULL`),
      q(`SELECT ls.product_variation_id AS vid, l.type AS loc_tipo, l.name AS loc_nombre, SUM(ls.quantity) AS qty
           FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
          WHERE ls.quantity <> 0
          GROUP BY ls.product_variation_id, l.id, l.type, l.name`),
      q(`SELECT id, product_variation_id AS vid, cost_price AS costo, entry_date AS entrada
           FROM stock_batches WHERE quantity > 0`),
      q(`SELECT DISTINCT product_id, product_variation_id FROM product_images WHERE deleted_at IS NULL`),
      q(`SELECT DISTINCT product_id FROM product_product_category`),
      q(`SELECT si.product_variation_id AS vid, SUM(si.quantity) AS unidades
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.stock_batch_id IS NULL
            AND (si.is_backorder = 1 OR si.pending_stock_entry_id IS NOT NULL)
            AND s.deleted_at IS NULL AND s.status <> 'cancelled'
          GROUP BY si.product_variation_id`),
      q(`SELECT pv.id AS vid, COUNT(DISTINCT s.id) AS num_ventas, SUM(si.quantity) AS unidades, MAX(s.created_at) AS ultima
           FROM product_variations pv
           JOIN sale_items si ON si.product_variation_id = pv.id
           JOIN sales s ON s.id = si.sale_id
          WHERE pv.product_type = 'variable' AND pv.deleted_at IS NULL
            AND s.deleted_at IS NULL AND s.status <> 'cancelled'
            AND s.created_at >= DATE_SUB(NOW(), INTERVAL ${DIAS_VENTA_VARIABLE} DAY)
          GROUP BY pv.id`)
    ]);
    return {
      vars, stock, lotes, cats: cats.map(c => c.product_id), backorders, ventasVariable,
      imgs: {
        prod: imgs.filter(i => i.product_variation_id == null && i.product_id != null).map(i => i.product_id),
        vari: imgs.filter(i => i.product_variation_id != null).map(i => i.product_variation_id)
      }
    };
  }

  async function leerGuardado() {
    const [[row]] = await portalPool.query('SELECT generado_en, resultado FROM auditoria_cache WHERE id = 1');
    if (!row || !row.resultado) return null;
    const data = JSON.parse(row.resultado);
    // Análisis guardado con la versión anterior (sin severidades) → pedir re-análisis
    if (!data.version || data.version < 2) return null;
    data.generado_en = row.generado_en;
    return data;
  }

  app.get('/admin/auditoria', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      if (req.query.force !== '1') {
        const g = await leerGuardado();
        if (!g) return res.json({ sin_analisis: true });
        return res.json({ ...paraUsuario(g, esMaestro(req)), desde_cache: true });
      }
      const t0 = Date.now();
      const { alertas, pendientes } = calcularAuditoria(await leerDatos());
      const data = { version: 2, generado_en: new Date(), ...resumir(alertas, pendientes), alertas, pendientes,
        reglas: REGLAS, segundos: Math.round((Date.now() - t0) / 100) / 10 };
      await portalPool.query(
        `INSERT INTO auditoria_cache (id, generado_en, resultado) VALUES (1, NOW(), ?)
         ON DUPLICATE KEY UPDATE generado_en = NOW(), resultado = VALUES(resultado)`, [JSON.stringify(data)]);
      res.json({ ...paraUsuario(data, esMaestro(req)), desde_cache: false });
    } catch (e) { res.status(500).json({ error: 'Error al analizar el catálogo: ' + e.message }); }
  });

  // Excel del análisis guardado (lo mismo que se ve en pantalla) con los filtros aplicados
  app.get('/admin/auditoria-excel', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const g = await leerGuardado();
      if (!g) return res.status(400).json({ error: 'Primero pulsa "Analizar catálogo".' });
      const data = paraUsuario(g, esMaestro(req));
      const alertas = filtrarAlertas(data.alertas, req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const SEV = { critico: 'Crítico', importante: 'Importante', info: 'Info' };
      const gen = new Date(g.generado_en).toLocaleString('es-PE', { timeZone: 'America/Lima' });
      const cabecera = (ws, titulo, cols, filtros) => {
        const n = cabeceraExcel(ws, titulo, [['Análisis del', gen], ...filtros], cols.length);
        cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        ws.views = [{ state: 'frozen', ySplit: n + 1 }];
        return n + 1;
      };

      const ws1 = wb.addWorksheet('Alertas');
      const c1 = [['Severidad', 12], ['Grupo', 22], ['Tipo de alerta', 24], ['SKU', 22], ['WooCommerce ID', 14],
        ['Marca', 14], ['Nombre', 42], ['Estado', 13], ['Stock propio', 11], ['Observación', 60]];
      const h1 = cabecera(ws1, 'Auditoría de catálogo — Alertas', c1, [
        ['Severidad', SEV[req.query.sev]], ['Tipo', req.query.tipo], ['Marca', req.query.marca],
        ['Estado', req.query.estado], ['En la web', req.query.web], ['Búsqueda', req.query.q], ['Alertas', alertas.length]]);
      alertas.forEach(a => ws1.addRow([SEV[a.sev], a.grupo, a.tipo, a.sku, a.wc, a.marca, a.nombre, a.estado, a.stock, a.obs]));
      ws1.autoFilter = { from: { row: h1, column: 1 }, to: { row: Math.max(h1, ws1.rowCount), column: c1.length } };

      const ws2 = wb.addWorksheet('Pendientes en la web');
      const c2 = [['SKU', 22], ['Tipo', 10], ['Marca', 14], ['Nombre', 45], ['Estado', 13], ['Precio regular', 14],
        ['Stock propio', 12], ['En consignación', 14], ['Backorder abierto', 15], ['Marketplace/pack', 15], ['Le falta', 34]];
      const h2 = cabecera(ws2, 'Auditoría de catálogo — Pendientes en la web', c2, [['Pendientes', data.pendientes.length]]);
      data.pendientes.forEach(p => ws2.addRow([p.sku, p.tipo_prod, p.marca, p.nombre, p.estado, p.precio,
        p.stock, p.consig, p.backorder, p.mkp ? 'Sí' : '', p.falta.length ? p.falta.join(', ') : 'Listo para crear']));
      ws2.getColumn(6).numFmt = '#,##0.00';
      ws2.autoFilter = { from: { row: h2, column: 1 }, to: { row: Math.max(h2, ws2.rowCount), column: c2.length } };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('auditoria-catalogo')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar la auditoría: ' + e.message }); }
  });

  // ── Chequeo de empresa vendedora vs dueño del producto (solo lectura) ──
  async function obtenerChequeo(q) {
    const dias = [0, 90, 365].includes(Number(q.dias)) ? Number(q.dias) : 90;
    const [rows] = await prodPool.query(`
      SELECT s.id, s.code, s.company_id AS empresa_venta, s.status, s.created_at, s.total,
             si.stock_batch_id, si.is_backorder, si.pending_stock_entry_id,
             sb.company_id AS empresa_producto, pv.sku
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        LEFT JOIN product_variations pv ON pv.id = si.product_variation_id
       WHERE s.deleted_at IS NULL AND s.status <> 'cancelled'
         ${dias ? `AND s.created_at >= DATE_SUB(NOW(), INTERVAL ${dias} DAY)` : ''}
       ORDER BY s.created_at DESC`);
    return { dias, lista: agruparChequeo(rows, q.tipo) };
  }

  app.get('/admin/chequeo-empresas', authAdmin, mAud, async (req, res) => {
    try {
      const { dias, lista } = await obtenerChequeo(req.query);
      const conteo = { sin_empresa: 0, no_coincide: 0, sin_lote: 0 };
      lista.forEach(v => v.problemas.forEach(p => conteo[p]++));
      res.json({ total: lista.length, dias, conteo, empresas: EMPRESAS_BI, ventas: lista.slice(0, 500) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/admin/chequeo-empresas-excel', authAdmin, mAud, async (req, res) => {
    try {
      const { dias, lista } = await obtenerChequeo(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Chequeo empresas');
      const fechaLima = d => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';
      const NOMBRE_PROB = { sin_empresa: 'Sin empresa vendedora', no_coincide: 'Empresa no coincide', sin_lote: 'Producto sin lote' };
      const n = cabeceraExcel(ws, 'Chequeo de empresa en ventas', [
        ['Problema', req.query.tipo ? NOMBRE_PROB[req.query.tipo] : 'Todos'],
        ['Periodo', dias ? `Últimos ${dias} días` : 'Todo el historial'],
        ['Ventas con problema', lista.length]], 8);
      const cols = [['Venta', 15], ['Fecha', 12], ['Estado', 15], ['Empresa vendedora', 26], ['Empresa(s) del producto', 26],
        ['Problema(s)', 40], ['Items', 8], ['Total', 13]];
      cols.forEach((c, i) => ws.getColumn(i + 1).width = c[1]);
      const hr = ws.addRow(cols.map(c => c[0]));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      const emp = e => EMPRESAS_BI[e] || 'Empresa ' + e;
      lista.forEach(v => ws.addRow([v.code, fechaLima(v.fecha), v.status,
        v.empresa_venta != null ? emp(v.empresa_venta) : '(vacío)',
        v.empresas_producto.length ? v.empresas_producto.map(emp).join(', ') : '(sin lote)',
        v.problemas.map(p => NOMBRE_PROB[p] || p).join(' · '), v.num_items, v.total]));
      ws.views = [{ state: 'frozen', ySplit: n + 1 }];
      ws.getColumn(8).numFmt = '#,##0.00';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('chequeo-empresas')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });

  return { prepararTablas };
};

module.exports._test = { calcularAuditoria, resumir, paraUsuario, filtrarAlertas, agruparChequeo, REGLAS };
