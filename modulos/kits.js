// ═══════════════════════════════════════════════════════════════════════════
//  KITS — canibalización de kits (FASE 1, en el portal)
//
//  · RECETA del kit: qué piezas trae (cantidad por kit, si se vende, peso).
//    Se configura una vez y se reutiliza cada vez que se abre ese kit.
//  · REPARTO: costo y precio del kit repartidos entre las piezas que se venden
//    (igual por unidad o por valor). Se guarda el valor RECOMENDADO y el EDITADO.
//  · CUADRE: aperturas (kits abiertos) y bajas (piezas sobrantes) →
//    producidas − vendidas − bajas = piezas que deberían quedar en físico.
//  · SUGERENCIA del kit de origen de una pieza (SKU, nombre, marca, cantidad).
//
//  SOLO LECTURA sobre el sistema de Renzo (prodPool). Datos propios en
//  portalPool (tablas kit_*), con la misma forma que la propuesta para el
//  sistema (claves por SKU en vez de id de variación). /api/kits/export entrega
//  todo para importarlo en la fase 2. Ver claude/canibalizacion-kits-propuesta.md.
// ═══════════════════════════════════════════════════════════════════════════

// ── Utilidades puras ────────────────────────────────────────────────────────
const s = (v) => (v == null ? '' : String(v));
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const numOrNull = (v) => (v === '' || v == null || !isFinite(Number(v))) ? null : Number(v);
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const asJson = (v, fb) => { if (v == null) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } };
const skuKey = (v) => s(v).trim().toUpperCase();
const isISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(s(v));
const hoyISO = () => new Date().toISOString().slice(0, 10);
const fechaISO = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) { if (isNaN(v.getTime())) return null; return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; }
  const m = s(v).match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null;
};
// Minúsculas, sin tildes; deja letras, números y . , para leer cantidades.
const normalizar = (t) => s(t).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9.,]+/g, ' ').replace(/\s+/g, ' ').trim();

// ── Reparto del costo y del precio del kit entre sus piezas ─────────────────
//  componentes: [{ comp_sku, cant_por_kit, vendible, peso, precio_ref, costo_manual, precio_manual }]
//  · Peso por unidad: 0 si no se vende; el peso fijado a mano si lo hay; si no,
//    1 (método "unidad") o el precio de lista de la pieza (método "valor").
//  · Costo unitario recomendado = costo del kit × peso ÷ Σ(peso × cantidad).
//    El residuo del redondeo va a la línea de mayor peso → la suma cuadra exacta.
//  · Precio recomendado = precio del kit × la misma proporción × (1 + recargo %).
//  · El valor FINAL es el editado si existe; si no, el recomendado.
function repartir({ costoKit, precioKit, metodo = 'unidad', recargoPct = 0, componentes = [] }) {
  const avisos = [];
  const comps = (componentes || []).map(c => ({
    ...c,
    cant: Math.max(0, num(c.cant_por_kit != null ? c.cant_por_kit : c.cant)),
    vendible: !(c.vendible === false || c.vendible === 0 || c.vendible === '0'),
    peso: numOrNull(c.peso),
  }));
  let met = metodo === 'valor' ? 'valor' : 'unidad';
  if (met === 'valor' && comps.some(c => c.vendible && c.peso == null && !(num(c.precio_ref) > 0))) {
    met = 'unidad';
    avisos.push('Faltan precios de lista en algunas piezas: se repartió igual por unidad.');
  }
  comps.forEach(c => {
    c.peso_usado = !c.vendible ? 0 : (c.peso != null ? Math.max(0, c.peso) : (met === 'valor' ? num(c.precio_ref) : 1));
  });
  const W = comps.reduce((a, c) => a + c.peso_usado * c.cant, 0);
  const costo = numOrNull(costoKit), precio = numOrNull(precioKit);
  const tieneCosto = costo != null && costo > 0, tienePrecio = precio != null && precio > 0;
  if (comps.length && !W) avisos.push('Ninguna pieza se vende (o todas tienen peso 0): no hay entre quiénes repartir.');
  if (!tieneCosto) avisos.push('El kit no tiene costo en el sistema (sin lotes con costo): no se puede recomendar costo.');
  if (!tienePrecio) avisos.push('El kit no tiene precio de venta: no se puede recomendar precio.');
  const factor = 1 + num(recargoPct) / 100;
  comps.forEach(c => {
    c.costo_rec = (W && tieneCosto) ? r4(costo * c.peso_usado / W) : null;
    c.precio_rec = (W && tienePrecio && c.peso_usado > 0) ? r2(precio * c.peso_usado / W * factor) : null;
  });
  if (W && tieneCosto) {
    const asignado = comps.reduce((a, c) => a + (c.costo_rec || 0) * c.cant, 0);
    const resid = costo - asignado;
    if (Math.abs(resid) >= 0.00005) {
      const big = comps.filter(c => c.cant > 0 && c.peso_usado > 0)
        .sort((a, b) => b.peso_usado * b.cant - a.peso_usado * a.cant)[0];
      if (big) big.costo_rec = r4(big.costo_rec + resid / big.cant);
    }
  }
  comps.forEach(c => {
    c.editado_costo = numOrNull(c.costo_manual) != null;
    c.editado_precio = numOrNull(c.precio_manual) != null;
    c.costo_final = c.editado_costo ? r4(num(c.costo_manual)) : c.costo_rec;
    c.precio_final = c.editado_precio ? r2(num(c.precio_manual)) : c.precio_rec;
    c.avisos = [];
    if (c.vendible && c.costo_final != null && c.precio_final != null && c.precio_final < c.costo_final)
      c.avisos.push('Precio por debajo del costo');
  });
  const costoAsignado = r2(comps.reduce((a, c) => a + (c.costo_final || 0) * c.cant, 0));
  const diferencia = tieneCosto ? r2(costo - costoAsignado) : null;
  if (diferencia != null && Math.abs(diferencia) >= 0.01)
    avisos.push(diferencia > 0 ? `Faltan repartir S/ ${diferencia.toFixed(2)} del costo del kit.`
                               : `Se repartió S/ ${(-diferencia).toFixed(2)} de más sobre el costo del kit.`);
  return {
    metodo_usado: met, peso_total: r4(W),
    costo_kit: tieneCosto ? r4(costo) : null, precio_kit: tienePrecio ? r2(precio) : null,
    costo_asignado: costoAsignado, diferencia, avisos,
    componentes: comps.map(c => ({
      comp_sku: c.comp_sku, cant_por_kit: c.cant, vendible: c.vendible, peso: c.peso, peso_usado: r4(c.peso_usado),
      costo_rec: c.costo_rec, costo_final: c.costo_final, editado_costo: c.editado_costo,
      precio_rec: c.precio_rec, precio_final: c.precio_final, editado_precio: c.editado_precio, avisos: c.avisos,
    })),
  };
}

// ── Cantidades escritas en un nombre: "250 ml", "1 L", "(10 unid)", "x10" ───
function cantidadesEnNombre(nombre) {
  const t = normalizar(nombre), out = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|l|lt|litros?|g|gr|kg|unid|unidades|und|uds?|u|pcs|pzas?|piezas?)(?=\s|$)/g;
  let m;
  while ((m = re.exec(t))) {
    let v = parseFloat(m[1].replace(',', '.')), u = m[2];
    if (/^(l|lt|litros?)$/.test(u)) { v *= 1000; u = 'ml'; }
    else if (u === 'kg') { v *= 1000; u = 'g'; }
    else if (/^(g|gr)$/.test(u)) u = 'g';
    else if (u !== 'ml') u = 'unid';
    if (v > 0) out.push({ v, u });
  }
  const rx = /(?:^|\s)x\s?(\d+)(?=\s|$)/g;
  while ((m = rx.exec(t))) out.push({ v: +m[1], u: 'unid' });
  return out;
}

// ── Sugerencia del kit de origen de una pieza ───────────────────────────────
const STOP = new Set(['de', 'para', 'con', 'el', 'la', 'los', 'las', 'y', 'a', 'en', 'del', 'al', 'por', 'sin', 'x', 'o',
  'unid', 'und', 'unidad', 'unidades', 'uds', 'ud', 'u', 'pck', 'kit', 'set', 'juego', 'pack', 'caja', 'combo', 'piezas', 'pieza',
  'pzas', 'pza', 'pcs', 'ml', 'l', 'lt', 'litro', 'litros', 'g', 'gr', 'kg', 'mm', 'cm']);
const PALABRAS_KIT = /(^|\s)(kit|set|juego|pack|caja|combo)(\s|$)/;
const raiz = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w); // "pernos" ≈ "perno"
function tokensNombre(nombre) {
  return [...new Set(normalizar(nombre).split(' ')
    .map(w => w.replace(/^[.,]+|[.,]+$/g, ''))
    .filter(w => w && !STOP.has(w) && !/^\d+([.,]\d+)?$/.test(w))
    .map(raiz))];
}
function marca(nombre) { const w = normalizar(nombre).split(' ').find(x => /^[a-z][a-z0-9]*$/.test(x) && !STOP.has(x)); return w || ''; }
const esPck = (sku, nombre) => /PCK$/i.test(s(sku).trim()) || /(^|\s)pck(\s|$)/.test(normalizar(nombre));
// 1 = el SKU del candidato es prefijo del de la pieza (p. ej. kit F02K0645817 → pieza F02K0645817035PCK).
function skuSimilitud(compSku, candSku) {
  const a = skuKey(compSku).replace(/[^A-Z0-9]/g, '').replace(/PCK$/, '');
  const b = skuKey(candSku).replace(/[^A-Z0-9]/g, '');
  if (!a || !b || a === b) return 0;
  if (b.length >= 6 && a.startsWith(b)) return 1;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 11 ? 0.8 : (i >= 9 ? 0.5 : 0);
}
// catalogo: [{ sku, nombre }] (ya preparado con prepararCatalogo para no tokenizar en cada llamada)
function prepararCatalogo(filas) {
  return (filas || []).filter(k => k && k.sku).map(k => ({
    sku: s(k.sku).trim(), nombre: s(k.nombre), tok: tokensNombre(k.nombre), marca: marca(k.nombre),
    kitW: PALABRAS_KIT.test(normalizar(k.nombre)) ? 1 : 0, cants: cantidadesEnNombre(k.nombre), pck: esPck(k.sku, k.nombre),
  }));
}
function sugerirKits(comp, catalogoPrep, limite = 6) {
  const cTok = tokensNombre(comp && comp.nombre), cMarca = marca(comp && comp.nombre), cCants = cantidadesEnNombre(comp && comp.nombre);
  const cKey = skuKey(comp && comp.sku), res = [];
  for (const k of catalogoPrep || []) {
    if (k.pck || skuKey(k.sku) === cKey) continue;          // una pieza no es kit de otra pieza
    const skuS = skuSimilitud(comp.sku, k.sku);
    let inter = 0; for (const t of cTok) if (k.tok.includes(t)) inter++;
    const dice = (cTok.length + k.tok.length) ? (2 * inter) / (cTok.length + k.tok.length) : 0;
    if (skuS === 0 && dice < 0.3) continue;                  // descarte rápido
    const mismaMarca = !!(cMarca && k.marca && cMarca === k.marca);
    const otraMarca = !!(cMarca && k.marca && cMarca !== k.marca);
    let mayor = 0, ratio = null;
    for (const cq of cCants) for (const kq of k.cants) {
      if (kq.u === cq.u && cq.v > 0 && kq.v > cq.v) {
        mayor = 1; const rr = kq.v / cq.v;
        if (Math.abs(rr - Math.round(rr)) < 0.01 && (ratio == null || Math.round(rr) > ratio)) ratio = Math.round(rr);
      }
    }
    let sc = 0.65 * dice + 0.25 * skuS + 0.08 * k.kitW + 0.1 * mayor + (mismaMarca ? 0.05 : 0);
    if (skuS === 1) sc = Math.max(sc, 0.9 + 0.1 * dice);
    if (otraMarca) sc *= 0.6;
    sc = Math.min(1, sc);
    if (sc < 0.25) continue;
    const razones = [];
    if (skuS === 1) razones.push('el SKU de la pieza empieza con el de este producto');
    else if (skuS > 0) razones.push('SKU parecido');
    if (dice >= 0.5) razones.push('nombre parecido');
    if (mismaMarca) razones.push('misma marca');
    if (k.kitW) razones.push('dice kit/set/juego');
    if (mayor) razones.push('trae más cantidad' + (ratio ? ` (×${ratio})` : ''));
    res.push({ sku: k.sku, nombre: k.nombre, score: Math.round(sc * 100),
      confianza: sc >= 0.8 ? 'alta' : (sc >= 0.5 ? 'media' : 'baja'), razones, cantidad_sugerida: ratio });
  }
  return res.sort((a, b) => b.score - a.score).slice(0, limite);
}

// ── Cuadre físico de una receta ─────────────────────────────────────────────
//  producidas = kits abiertos × piezas por kit; deberían quedar = producidas − vendidas − bajas
function cuadre({ componentes = [], kitsAbiertos = 0, vendidasPorSku = {}, bajasPorSku = {}, stockPorSku = {} }) {
  return componentes.map(c => {
    const k = skuKey(c.comp_sku);
    const producidas = r4(num(kitsAbiertos) * num(c.cant_por_kit));
    const vendidas = num(vendidasPorSku[k]), bajas = num(bajasPorSku[k]);
    return { comp_sku: c.comp_sku, producidas, vendidas, bajas, deberian_quedar: r4(producidas - vendidas - bajas),
      stock_sistema: stockPorSku[k] != null ? num(stockPorSku[k]) : null };
  });
}

module.exports = function registrarKits({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mSeg = requiereModulo('seguimiento');               // mismo permiso que Seguimiento
  const esMaestro = (req) => !!(req.admin && req.admin.maestro);
  const soloMaestro = (req, res, next) => esMaestro(req) ? next()
    : res.status(403).json({ error: 'Solo el administrador puede modificar el contenido de los kits, costos y precios.' });
  const quienEs = (req) => (req.admin && (req.admin.usuario || (req.admin.maestro ? 'maestro' : ''))) || '';

  async function prepararTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS kit_recetas (
        id              VARCHAR(40) PRIMARY KEY,
        kit_sku         VARCHAR(120) NOT NULL,
        kit_nombre      VARCHAR(255) NOT NULL DEFAULT '',
        metodo          VARCHAR(10)  NOT NULL DEFAULT 'unidad',   -- unidad | valor
        recargo_pct     DECIMAL(6,2) NOT NULL DEFAULT 0,          -- recargo por venta suelta (precio sugerido)
        nota            TEXT,
        activo          TINYINT(1)   NOT NULL DEFAULT 1,
        erp_ref         VARCHAR(60)  NULL,                        -- fase 2: id de la receta en el sistema de Renzo
        actualizado_por VARCHAR(120) NOT NULL DEFAULT '',
        creado_en       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_kit_sku (kit_sku)
      )`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS kit_componentes (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        receta_id     VARCHAR(40)  NOT NULL,
        comp_sku      VARCHAR(120) NOT NULL,
        comp_nombre   VARCHAR(255) NOT NULL DEFAULT '',
        cant_por_kit  DECIMAL(10,3) NOT NULL DEFAULT 1,
        vendible      TINYINT(1)   NOT NULL DEFAULT 1,
        peso          DECIMAL(14,4) NULL,                         -- NULL = automático según el método
        costo_manual  DECIMAL(14,4) NULL,                         -- costo unitario editado (NULL = recomendado)
        precio_manual DECIMAL(14,2) NULL,                         -- precio de venta editado (NULL = recomendado)
        orden         INT NOT NULL DEFAULT 0,
        UNIQUE KEY uk_receta_comp (receta_id, comp_sku), INDEX (comp_sku)
      )`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS kit_movimientos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        receta_id   VARCHAR(40)  NOT NULL,
        tipo        VARCHAR(12)  NOT NULL,                        -- apertura | baja
        comp_sku    VARCHAR(120) NULL,                            -- solo en bajas
        cantidad    DECIMAL(10,3) NOT NULL,                       -- kits abiertos o piezas dadas de baja
        fecha       DATE NOT NULL,
        costo_unit  DECIMAL(14,4) NULL,                           -- foto: costo del kit (apertura) o de la pieza (baja)
        detalle     JSON NULL,                                    -- foto del reparto al abrir el kit
        nota        VARCHAR(500) NOT NULL DEFAULT '',
        creado_por  VARCHAR(120) NOT NULL DEFAULT '',
        creado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (receta_id), INDEX (comp_sku)
      )`);
  }
  let _tablasOk = null;
  const tablas = () => (_tablasOk = _tablasOk || prepararTablas().catch(e => { _tablasOk = null; throw e; }));

  // ── Lecturas del sistema de Renzo (SOLO LECTURA) ──────────────────────────
  //  Variaciones por SKU: nombre y precio de venta efectivo (oferta si hay, si no regular).
  async function variacionesPorSku(skus) {
    const lista = [...new Set((skus || []).map(x => s(x).trim()).filter(Boolean))];
    const out = {};
    if (!lista.length) return out;
    const [rows] = await prodPool.query(`
      SELECT pv.id, TRIM(pv.sku) AS sku, COALESCE(NULLIF(TRIM(pv.name),''), p.name) AS nombre,
             pv.regular_price, pv.sale_price
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
       WHERE pv.deleted_at IS NULL AND TRIM(pv.sku) IN (?)
       ORDER BY pv.id`, [lista]);
    rows.forEach(r => {
      const k = skuKey(r.sku); if (out[k]) return;            // SKU duplicado: se toma el primero
      const oferta = num(r.sale_price) > 0 ? num(r.sale_price) : null;
      out[k] = { vid: r.id, sku: r.sku, nombre: r.nombre || '', precio: oferta != null ? oferta : (num(r.regular_price) || null) };
    });
    return out;
  }
  //  Costo del kit: el lote vivo más antiguo con costo (el que se consumiría por FIFO);
  //  si ya no hay stock, el último costo conocido.
  async function costosPorVid(vids) {
    const out = {};
    if (!vids.length) return out;
    const [rows] = await prodPool.query(`
      SELECT product_variation_id AS vid, cost_price, quantity, entry_date, id
        FROM stock_batches WHERE product_variation_id IN (?) AND cost_price > 0
       ORDER BY entry_date ASC, id ASC`, [vids]);
    rows.forEach(r => {
      const o = out[r.vid] = out[r.vid] || { vivo: null, ultimo: null, ultimoId: -1 };
      if (o.vivo == null && num(r.quantity) > 0) o.vivo = { costo: num(r.cost_price), fecha: fechaISO(r.entry_date) };
      if (r.id > o.ultimoId) { o.ultimoId = r.id; o.ultimo = { costo: num(r.cost_price), fecha: fechaISO(r.entry_date) }; }
    });
    const res = {};
    Object.keys(out).forEach(v => {
      const o = out[v];
      res[v] = o.vivo ? { costo: o.vivo.costo, fuente: 'lote vivo (FIFO)', fecha: o.vivo.fecha }
                      : (o.ultimo ? { costo: o.ultimo.costo, fuente: 'último costo (sin stock)', fecha: o.ultimo.fecha } : null);
    });
    return res;
  }
  //  Piezas vendidas por SKU y día (ventas no anuladas), desde una fecha.
  async function ventasPorDia(vids, desde) {
    if (!vids.length || !isISO(desde)) return [];
    const [rows] = await prodPool.query(`
      SELECT si.product_variation_id AS vid, DATE(s.created_at) AS d, SUM(si.quantity) AS q
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.deleted_at IS NULL AND s.status <> 'cancelled'
         AND s.created_at >= ? AND si.product_variation_id IN (?)
       GROUP BY si.product_variation_id, DATE(s.created_at)`, [desde, vids]);
    return rows.map(r => ({ vid: r.vid, d: fechaISO(r.d), q: num(r.q) }));
  }
  async function stockPorVid(vids) {
    const out = {};
    if (!vids.length) return out;
    const [rows] = await prodPool.query(`
      SELECT product_variation_id AS vid, SUM(quantity) AS q FROM location_stocks
       WHERE product_variation_id IN (?) GROUP BY product_variation_id`, [vids]);
    rows.forEach(r => { out[r.vid] = num(r.q); });
    return out;
  }

  // ── Recetas con su reparto y su cuadre ────────────────────────────────────
  async function leerRecetas(filtroId) {
    const [rs] = await portalPool.query(`SELECT * FROM kit_recetas ${filtroId ? 'WHERE id = ?' : ''} ORDER BY kit_nombre, kit_sku`, filtroId ? [filtroId] : []);
    if (!rs.length) return [];
    const ids = rs.map(r => r.id);
    const [cs] = await portalPool.query(`SELECT * FROM kit_componentes WHERE receta_id IN (?) ORDER BY orden, id`, [ids]);
    const [ms] = await portalPool.query(`SELECT * FROM kit_movimientos WHERE receta_id IN (?) ORDER BY fecha, id`, [ids]);
    return rs.map(r => ({
      id: r.id, kit_sku: r.kit_sku, kit_nombre: r.kit_nombre, metodo: r.metodo || 'unidad', recargo_pct: num(r.recargo_pct),
      nota: r.nota || '', activo: r.activo ? 1 : 0, erp_ref: r.erp_ref || null, actualizado_por: r.actualizado_por || '',
      actualizado_en: r.actualizado_en || null,
      componentes: cs.filter(c => c.receta_id === r.id).map(c => ({
        comp_sku: c.comp_sku, comp_nombre: c.comp_nombre, cant_por_kit: num(c.cant_por_kit), vendible: !!c.vendible,
        peso: numOrNull(c.peso), costo_manual: numOrNull(c.costo_manual), precio_manual: numOrNull(c.precio_manual), orden: c.orden,
      })),
      movimientos: ms.filter(m => m.receta_id === r.id).map(m => ({
        id: m.id, tipo: m.tipo, comp_sku: m.comp_sku, cantidad: num(m.cantidad), fecha: fechaISO(m.fecha),
        costo_unit: numOrNull(m.costo_unit), nota: m.nota || '', creado_por: m.creado_por || '', detalle: asJson(m.detalle, null),
      })),
    }));
  }
  //  Completa recetas con datos del sistema: nombres, costo/precio del kit,
  //  precio de lista de cada pieza, reparto y (opcional) cuadre.
  async function enriquecer(recetas, { conCuadre = true } = {}) {
    if (!recetas.length) return recetas;
    const skus = [];
    recetas.forEach(r => { skus.push(r.kit_sku); r.componentes.forEach(c => skus.push(c.comp_sku)); });
    const vars = await variacionesPorSku(skus);
    const vid = (sku) => (vars[skuKey(sku)] || {}).vid;
    const kitVids = recetas.map(r => vid(r.kit_sku)).filter(Boolean);
    const compVids = [...new Set(recetas.flatMap(r => r.componentes.map(c => vid(c.comp_sku))).filter(Boolean))];
    const costos = await costosPorVid(kitVids);
    const kc = await kitsAlmacen().catch(e => { console.warn('[kits] almacén de kits:', e.message); return null; });
    let ventas = [], stock = {};
    if (conCuadre) {
      const desdes = recetas.map(r => (r.movimientos || []).filter(m => m.tipo === 'apertura').map(m => m.fecha).sort()[0]).filter(Boolean).sort();
      [ventas, stock] = await Promise.all([desdes.length ? ventasPorDia(compVids, desdes[0]) : [], stockPorVid(compVids)]);
    }
    return recetas.map(r => {
      const kv = vars[skuKey(r.kit_sku)] || null;
      const kcos = kv ? costos[kv.vid] : null;
      const comps = r.componentes.map(c => {
        const v = vars[skuKey(c.comp_sku)] || null;
        return { ...c, comp_nombre: c.comp_nombre || (v && v.nombre) || '', precio_ref: v ? v.precio : null, en_sistema: !!v };
      });
      const reparto = repartir({ costoKit: kcos ? kcos.costo : null, precioKit: kv ? kv.precio : null, metodo: r.metodo,
        recargoPct: r.recargo_pct, componentes: comps });
      const out = { ...r, componentes: comps, kit: { en_sistema: !!kv, nombre_sistema: kv ? kv.nombre : null,
        costo: kcos ? kcos.costo : null, costo_fuente: kcos ? kcos.fuente : null, costo_fecha: kcos ? kcos.fecha : null,
        precio: kv ? kv.precio : null,
        // kits que quedan hoy en el almacén de kits (Cuarentena), sin abrir
        stock_almacen: (kc && kc.encontrado) ? (kc.stockDe[skuKey(r.kit_sku)] || 0) : null,
        almacen: kc && kc.encontrado ? kc.ubicaciones.join(', ') : null }, reparto };
      if (conCuadre) {
        const aperturas = (r.movimientos || []).filter(m => m.tipo === 'apertura');
        const desde = aperturas.map(m => m.fecha).sort()[0] || null;
        const kitsAbiertos = aperturas.reduce((a, m) => a + m.cantidad, 0);
        const vendidasPorSku = {}, bajasPorSku = {}, stockPorSku = {};
        comps.forEach(c => {
          const v = vars[skuKey(c.comp_sku)]; const k = skuKey(c.comp_sku);
          if (!v) return;
          if (desde) vendidasPorSku[k] = ventas.filter(x => x.vid === v.vid && x.d && x.d >= desde).reduce((a, x) => a + x.q, 0);
          if (stock[v.vid] != null) stockPorSku[k] = stock[v.vid];
        });
        (r.movimientos || []).filter(m => m.tipo === 'baja').forEach(m => { const k = skuKey(m.comp_sku); bajasPorSku[k] = (bajasPorSku[k] || 0) + m.cantidad; });
        out.cuadre = { desde, kits_abiertos: kitsAbiertos,
          piezas: cuadre({ componentes: comps, kitsAbiertos, vendidasPorSku, bajasPorSku, stockPorSku }) };
      }
      return out;
    });
  }
  //  El supervisor no ve costos ni precios (igual que en Inventario y Auditoría).
  function sinCostos(r) {
    const c = { ...r };
    c.kit = c.kit ? { en_sistema: c.kit.en_sistema, nombre_sistema: c.kit.nombre_sistema, stock_almacen: c.kit.stock_almacen, almacen: c.kit.almacen } : null;
    c.componentes = (c.componentes || []).map(x => ({ comp_sku: x.comp_sku, comp_nombre: x.comp_nombre, cant_por_kit: x.cant_por_kit,
      vendible: x.vendible, orden: x.orden, en_sistema: x.en_sistema }));
    c.reparto = null;
    c.movimientos = (c.movimientos || []).map(m => ({ id: m.id, tipo: m.tipo, comp_sku: m.comp_sku, cantidad: m.cantidad, fecha: m.fecha, nota: m.nota, creado_por: m.creado_por }));
    return c;
  }
  const idReceta = (kitSku) => ('kit:' + skuKey(kitSku).replace(/[^A-Z0-9]/g, '')).slice(0, 40);

  // ── Almacén de los kits canibalizados (por defecto "Cuarentena") ──────────
  //  Los kits que se canibalizan se guardan ahí, así que las opciones de "kit de
  //  origen" salen SOLO de ese almacén. Se cambia sin tocar código con la variable
  //  de Railway KITS_UBICACION (nombres separados por coma; sin tildes ni mayúsculas).
  const UBIC_KITS = (process.env.KITS_UBICACION || 'CUARENTENA').split(',').map(x => normalizar(x)).filter(Boolean);
  let _ubic = null, _ubicAt = 0;
  async function ubicacionesKits() {
    if (_ubic && Date.now() - _ubicAt < 10 * 60 * 1000) return _ubic;
    const [rows] = await prodPool.query(`SELECT id, name FROM locations`);
    _ubic = rows.filter(r => { const n = normalizar(r.name); return UBIC_KITS.some(u => n === u || n.includes(u)); })
      .map(r => ({ id: r.id, nombre: r.name }));
    _ubicAt = Date.now();
    return _ubic;
  }
  //  Productos (no PCK) que ESTÁN o ESTUVIERON en ese almacén, con su stock de hoy
  //  ahí. "Estuvieron" cubre los kits ya abiertos (el retiro los dejó en 0).
  let _kc = null, _kcAt = 0;
  async function kitsAlmacen() {
    if (_kc && Date.now() - _kcAt < 5 * 60 * 1000) return _kc;
    const ubic = await ubicacionesKits();
    if (!ubic.length) { _kc = { encontrado: false, ubicaciones: [], items: [], prep: [], stockDe: {} }; _kcAt = Date.now(); return _kc; }
    const ids = ubic.map(u => u.id);
    const [[st], [mv]] = await Promise.all([
      prodPool.query(`SELECT product_variation_id AS vid, SUM(quantity) AS q FROM location_stocks
                       WHERE location_id IN (?) GROUP BY product_variation_id`, [ids]),
      prodPool.query(`SELECT DISTINCT product_variation_id AS vid FROM stock_movements
                       WHERE location_to_id IN (?) OR location_from_id IN (?)`, [ids, ids]),
    ]);
    const stockVid = {}; st.forEach(r => { stockVid[r.vid] = num(r.q); });
    const vids = [...new Set([...st.map(r => r.vid), ...mv.map(r => r.vid)].filter(v => v != null))];
    const filas = [];
    for (let i = 0; i < vids.length; i += 1000) {
      const [rows] = await prodPool.query(`
        SELECT pv.id AS vid, TRIM(pv.sku) AS sku, COALESCE(NULLIF(TRIM(pv.name),''), p.name) AS nombre
          FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
         WHERE pv.id IN (?) AND pv.deleted_at IS NULL AND pv.sku IS NOT NULL AND TRIM(pv.sku) <> ''`, [vids.slice(i, i + 1000)]);
      filas.push(...rows);
    }
    const items = filas.filter(r => !esPck(r.sku, r.nombre))
      .map(r => ({ sku: r.sku, nombre: r.nombre || '', stock: stockVid[r.vid] || 0 }))
      .sort((a, b) => ((b.stock > 0) - (a.stock > 0)) || a.nombre.localeCompare(b.nombre));
    const stockDe = {}; items.forEach(i => { stockDe[skuKey(i.sku)] = i.stock; });
    _kc = { encontrado: true, ubicaciones: ubic.map(u => u.nombre), items, prep: prepararCatalogo(items), stockDe };
    _kcAt = Date.now();
    return _kc;
  }

  // ── Catálogo para sugerencias (caché 10 min) ──────────────────────────────
  let _cat = null, _catAt = 0;
  async function catalogoPrep() {
    if (_cat && Date.now() - _catAt < 10 * 60 * 1000) return _cat;
    const [rows] = await prodPool.query(`
      SELECT TRIM(pv.sku) AS sku, COALESCE(NULLIF(TRIM(pv.name),''), p.name) AS nombre
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
       WHERE pv.deleted_at IS NULL AND COALESCE(pv.product_type,'') <> 'variable'
         AND pv.sku IS NOT NULL AND TRIM(pv.sku) <> ''`);
    _cat = prepararCatalogo(rows); _catAt = Date.now();
    return _cat;
  }

  // ══════════════════════════ ENDPOINTS ══════════════════════════
  // Recetas completas (con reparto y cuadre). El supervisor las ve sin costos.
  app.get('/api/kits/recetas', authAdmin, mSeg, async (req, res) => {
    try {
      await tablas();
      const rs = await enriquecer(await leerRecetas());
      res.json(esMaestro(req) ? rs : rs.map(sinCostos));
    } catch (e) { console.error('[kits] recetas', e.message); res.status(500).json({ error: 'No se pudieron leer los kits' }); }
  });

  // Mapa liviano pieza → kit (para mostrar el kit en el grupo de canibalizados).
  app.get('/api/kits/por-componente', authAdmin, mSeg, async (req, res) => {
    try {
      await tablas();
      const [rows] = await portalPool.query(`
        SELECT c.comp_sku, c.cant_por_kit, r.id AS receta_id, r.kit_sku, r.kit_nombre
          FROM kit_componentes c JOIN kit_recetas r ON r.id = c.receta_id
         WHERE r.activo = 1 ORDER BY r.actualizado_en DESC`);
      const out = {};
      rows.forEach(r => { const k = skuKey(r.comp_sku); if (!out[k]) out[k] = { receta_id: r.receta_id, kit_sku: r.kit_sku, kit_nombre: r.kit_nombre, cant_por_kit: num(r.cant_por_kit) }; });
      res.json(out);
    } catch (e) { console.error('[kits] por-componente', e.message); res.status(500).json({ error: 'No se pudo leer el mapa de kits' }); }
  });

  // Sugerencias del kit de origen de una pieza: SOLO entre los productos del
  // almacén de kits (Cuarentena). ?todo=1 busca en todo el catálogo (respaldo).
  // Si el almacén no existe en el sistema, usa todo el catálogo y lo avisa.
  app.get('/api/kits/sugerir', authAdmin, mSeg, async (req, res) => {
    try {
      const sku = s(req.query.sku).trim();
      if (!sku) return res.status(400).json({ error: 'Falta el SKU de la pieza' });
      let nombre = s(req.query.nombre).trim();
      if (!nombre) { const v = await variacionesPorSku([sku]); nombre = (v[skuKey(sku)] || {}).nombre || ''; }
      const kc = await kitsAlmacen();
      const soloAlmacen = kc.encontrado && req.query.todo !== '1';
      const cat = soloAlmacen ? kc.prep : await catalogoPrep();
      const candidatos = sugerirKits({ sku, nombre }, cat, 6)
        .map(c => ({ ...c, stock_almacen: kc.stockDe[skuKey(c.sku)] != null ? kc.stockDe[skuKey(c.sku)] : null }));
      res.json({ comp: { sku, nombre }, candidatos, fuente: soloAlmacen ? 'almacen' : 'catalogo',
        ubicaciones: kc.ubicaciones, almacen_encontrado: kc.encontrado });
    } catch (e) { console.error('[kits] sugerir', e.message); res.status(500).json({ error: 'No se pudieron calcular sugerencias' }); }
  });

  // Productos del almacén de kits (Cuarentena) con su stock y si ya están configurados.
  // Alimenta el buscador de kits y la lista "kits en Cuarentena sin configurar".
  app.get('/api/kits/almacen', authAdmin, mSeg, async (req, res) => {
    try {
      await tablas();
      const kc = await kitsAlmacen();
      const [rs] = await portalPool.query(`SELECT kit_sku FROM kit_recetas`);
      const conf = new Set(rs.map(r => skuKey(r.kit_sku)));
      res.json({ encontrado: kc.encontrado, ubicaciones: kc.ubicaciones,
        items: kc.items.map(i => ({ ...i, configurado: conf.has(skuKey(i.sku)) })) });
    } catch (e) { console.error('[kits] almacen', e.message); res.status(500).json({ error: 'No se pudo leer el almacén de kits' }); }
  });

  // Asigna una pieza a un kit (desde el grupo de canibalizados). Crea la receta si
  // no existe. Por defecto MUEVE la pieza (sale de cualquier otra receta).
  app.post('/api/kits/asignar', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      await tablas();
      const b = req.body || {};
      const compSku = s(b.comp_sku).trim(), kitSku = s(b.kit_sku).trim();
      if (!compSku || !kitSku) return res.status(400).json({ error: 'Faltan el SKU de la pieza o del kit' });
      if (skuKey(compSku) === skuKey(kitSku)) return res.status(400).json({ error: 'Una pieza no puede ser su propio kit' });
      const cant = num(b.cant_por_kit) > 0 ? num(b.cant_por_kit) : 1;
      let [r] = await portalPool.query(`SELECT id FROM kit_recetas WHERE kit_sku = ? LIMIT 1`, [kitSku]);
      let id = r.length ? r[0].id : idReceta(kitSku);
      if (!r.length) {
        await portalPool.query(`INSERT INTO kit_recetas (id, kit_sku, kit_nombre, actualizado_por) VALUES (?,?,?,?)`,
          [id, kitSku.slice(0, 120), s(b.kit_nombre).slice(0, 255), quienEs(req)]);
      }
      if (b.mover !== false) await portalPool.query(`DELETE FROM kit_componentes WHERE comp_sku = ? AND receta_id <> ?`, [compSku, id]);
      await portalPool.query(`
        INSERT INTO kit_componentes (receta_id, comp_sku, comp_nombre, cant_por_kit) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE cant_por_kit = VALUES(cant_por_kit), comp_nombre = VALUES(comp_nombre)`,
        [id, compSku.slice(0, 120), s(b.comp_nombre).slice(0, 255), cant]);
      await portalPool.query(`UPDATE kit_recetas SET actualizado_por = ? WHERE id = ?`, [quienEs(req), id]);
      res.json({ ok: true, receta_id: id, nueva: !r.length });
    } catch (e) { console.error('[kits] asignar', e.message); res.status(500).json({ error: 'No se pudo asignar el kit' }); }
  });

  // Normaliza una receta que manda el frontend.
  function recetaDeBody(b) {
    const kitSku = s(b.kit_sku).trim();
    const vistos = new Set();
    const comps = (Array.isArray(b.componentes) ? b.componentes : []).map((c, i) => ({
      comp_sku: s(c.comp_sku).trim().slice(0, 120), comp_nombre: s(c.comp_nombre).slice(0, 255),
      cant_por_kit: num(c.cant_por_kit) > 0 ? num(c.cant_por_kit) : 1,
      vendible: !(c.vendible === false || c.vendible === 0 || c.vendible === '0'),
      peso: numOrNull(c.peso), costo_manual: numOrNull(c.costo_manual), precio_manual: numOrNull(c.precio_manual), orden: i,
    })).filter(c => c.comp_sku && skuKey(c.comp_sku) !== skuKey(kitSku) && !vistos.has(skuKey(c.comp_sku)) && vistos.add(skuKey(c.comp_sku)));
    return {
      id: s(b.id).trim() || idReceta(kitSku), kit_sku: kitSku, kit_nombre: s(b.kit_nombre).slice(0, 255),
      metodo: b.metodo === 'valor' ? 'valor' : 'unidad', recargo_pct: Math.max(0, num(b.recargo_pct)),
      nota: s(b.nota).slice(0, 2000), activo: b.activo === 0 || b.activo === false ? 0 : 1, componentes: comps, movimientos: [],
    };
  }

  // Vista previa del reparto (sin guardar) para editar con números al instante.
  app.post('/api/kits/preview', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      const r = recetaDeBody(req.body || {});
      if (!r.kit_sku) return res.status(400).json({ error: 'Falta el SKU del kit' });
      const [out] = await enriquecer([r], { conCuadre: false });
      res.json({ kit: out.kit, reparto: out.reparto, componentes: out.componentes });
    } catch (e) { console.error('[kits] preview', e.message); res.status(500).json({ error: 'No se pudo calcular el reparto' }); }
  });

  // Guardar receta completa (crea o actualiza; reemplaza la lista de piezas).
  app.post('/api/kits/receta', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      await tablas();
      const r = recetaDeBody(req.body || {});
      if (!r.kit_sku) return res.status(400).json({ error: 'Falta el SKU del kit' });
      const [otro] = await portalPool.query(`SELECT id FROM kit_recetas WHERE kit_sku = ? AND id <> ? LIMIT 1`, [r.kit_sku, r.id]);
      if (otro.length) return res.status(409).json({ error: 'Ese kit ya está configurado' });
      await portalPool.query(`
        INSERT INTO kit_recetas (id, kit_sku, kit_nombre, metodo, recargo_pct, nota, activo, actualizado_por)
        VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE kit_sku = VALUES(kit_sku), kit_nombre = VALUES(kit_nombre), metodo = VALUES(metodo),
          recargo_pct = VALUES(recargo_pct), nota = VALUES(nota), activo = VALUES(activo), actualizado_por = VALUES(actualizado_por)`,
        [r.id, r.kit_sku.slice(0, 120), r.kit_nombre, r.metodo, r.recargo_pct, r.nota, r.activo, quienEs(req)]);
      await portalPool.query(`DELETE FROM kit_componentes WHERE receta_id = ?`, [r.id]);
      if (r.componentes.length) {
        await portalPool.query(`
          INSERT INTO kit_componentes (receta_id, comp_sku, comp_nombre, cant_por_kit, vendible, peso, costo_manual, precio_manual, orden)
          VALUES ?`, [r.componentes.map(c => [r.id, c.comp_sku, c.comp_nombre, c.cant_por_kit, c.vendible ? 1 : 0, c.peso, c.costo_manual, c.precio_manual, c.orden])]);
      }
      res.json({ ok: true, id: r.id });
    } catch (e) { console.error('[kits] receta', e.message); res.status(500).json({ error: 'No se pudo guardar el kit' }); }
  });

  // Eliminar receta: solo si no tiene aperturas ni bajas (si las tiene, desactivarla).
  app.delete('/api/kits/receta/:id', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      await tablas();
      const [m] = await portalPool.query(`SELECT COUNT(*) AS n FROM kit_movimientos WHERE receta_id = ?`, [req.params.id]);
      if (num(m[0].n) > 0) return res.status(409).json({ error: 'Este kit tiene aperturas o bajas registradas. Desactívalo en vez de eliminarlo.' });
      await portalPool.query(`DELETE FROM kit_componentes WHERE receta_id = ?`, [req.params.id]);
      await portalPool.query(`DELETE FROM kit_recetas WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { console.error('[kits] borrar receta', e.message); res.status(500).json({ error: 'No se pudo eliminar la configuración del kit' }); }
  });

  // Registrar apertura de kits o baja de piezas (maestro y almacén).
  //  Guarda una FOTO del costo y del reparto del momento (los cambios futuros de
  //  la receta no alteran lo ya registrado; es lo que se migra a la fase 2).
  app.post('/api/kits/movimiento', authAdmin, mSeg, async (req, res) => {
    try {
      await tablas();
      const b = req.body || {};
      const tipo = b.tipo === 'baja' ? 'baja' : (b.tipo === 'apertura' ? 'apertura' : '');
      if (!tipo) return res.status(400).json({ error: 'Tipo de movimiento no válido' });
      const fecha = isISO(b.fecha) ? b.fecha : hoyISO();
      if (fecha > hoyISO()) return res.status(400).json({ error: 'La fecha no puede ser futura' });
      if (!s(b.receta_id).trim()) return res.status(400).json({ error: 'Falta el kit' });
      const [rec] = await leerRecetas(s(b.receta_id).trim());
      if (!rec) return res.status(404).json({ error: 'Kit no encontrado' });
      const [en] = await enriquecer([rec], { conCuadre: false });
      const nota = s(b.nota).slice(0, 500), quien = quienEs(req);
      if (tipo === 'apertura') {
        const kits = num(b.cantidad);
        if (!(kits > 0)) return res.status(400).json({ error: 'Indica cuántos kits abriste' });
        if (!rec.componentes.length) return res.status(400).json({ error: 'El kit no tiene contenido: agrega sus piezas antes de registrar aperturas' });
        const detalle = { costo_kit: en.kit.costo, costo_fuente: en.kit.costo_fuente, precio_kit: en.kit.precio, metodo: en.reparto.metodo_usado,
          recargo_pct: rec.recargo_pct, piezas: en.reparto.componentes.map(c => ({ comp_sku: c.comp_sku, cant_por_kit: c.cant_por_kit,
            vendible: c.vendible, costo_unit: c.costo_final, precio_unit: c.precio_final })) };
        await portalPool.query(`INSERT INTO kit_movimientos (receta_id, tipo, cantidad, fecha, costo_unit, detalle, nota, creado_por) VALUES (?,?,?,?,?,?,?,?)`,
          [rec.id, 'apertura', kits, fecha, en.kit.costo, JSON.stringify(detalle), nota, quien]);
        return res.json({ ok: true });
      }
      // baja: una o varias piezas
      const items = Array.isArray(b.items) ? b.items : [{ comp_sku: b.comp_sku, cantidad: b.cantidad }];
      const costoDe = {}; en.reparto.componentes.forEach(c => { costoDe[skuKey(c.comp_sku)] = c.costo_final; });
      const validos = items.map(i => ({ sku: s(i.comp_sku).trim(), q: num(i.cantidad) }))
        .filter(i => i.sku && i.q > 0 && rec.componentes.some(c => skuKey(c.comp_sku) === skuKey(i.sku)));
      if (!validos.length) return res.status(400).json({ error: 'Indica qué piezas y cuántas das de baja' });
      await portalPool.query(`INSERT INTO kit_movimientos (receta_id, tipo, comp_sku, cantidad, fecha, costo_unit, nota, creado_por) VALUES ?`,
        [validos.map(i => [rec.id, 'baja', i.sku, i.q, fecha, costoDe[skuKey(i.sku)] != null ? costoDe[skuKey(i.sku)] : null, nota, quien])]);
      res.json({ ok: true, registradas: validos.length });
    } catch (e) { console.error('[kits] movimiento', e.message); res.status(500).json({ error: 'No se pudo registrar el movimiento' }); }
  });

  app.delete('/api/kits/movimiento/:id', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      await tablas();
      await portalPool.query(`DELETE FROM kit_movimientos WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { console.error('[kits] borrar movimiento', e.message); res.status(500).json({ error: 'No se pudo eliminar el movimiento' }); }
  });

  // Exportación para el sistema de Renzo (fase 2): recetas, piezas y movimientos
  // con sus fotos de costo. El SKU se mapea a la variación al importar.
  app.get('/api/kits/export', authAdmin, mSeg, soloMaestro, async (req, res) => {
    try {
      await tablas();
      const rs = await leerRecetas();
      res.setHeader('Content-Disposition', `attachment; filename="kits-contenido-${hoyISO()}.json"`);
      res.json({ formato: 'kuranko-kits', version: 1, generado: new Date().toISOString(),
        recetas: rs.map(r => ({ kit_sku: r.kit_sku, kit_nombre: r.kit_nombre, metodo: r.metodo, recargo_pct: r.recargo_pct, activo: r.activo, nota: r.nota,
          piezas: r.componentes.map(c => ({ comp_sku: c.comp_sku, comp_nombre: c.comp_nombre, cant_por_kit: c.cant_por_kit, vendible: c.vendible,
            peso: c.peso, costo_manual: c.costo_manual, precio_manual: c.precio_manual })),
          movimientos: r.movimientos.map(m => ({ tipo: m.tipo, fecha: m.fecha, cantidad: m.cantidad, comp_sku: m.comp_sku, costo_unit: m.costo_unit,
            detalle: m.detalle, nota: m.nota, creado_por: m.creado_por })) })) });
    } catch (e) { console.error('[kits] export', e.message); res.status(500).json({ error: 'No se pudo exportar' }); }
  });

  return { prepararTablas, _test: { repartir, sugerirKits, prepararCatalogo, cantidadesEnNombre, tokensNombre, skuSimilitud, cuadre } };
};

module.exports._test = { repartir, sugerirKits, prepararCatalogo, cantidadesEnNombre, tokensNombre, skuSimilitud, cuadre, marca, esPck };
