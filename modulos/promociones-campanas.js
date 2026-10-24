// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Campañas de oferta (precio de oferta temporal en el ERP)
//  Parte de Promociones; frontend en public/promociones.html (pestañas
//  "Crear campaña", "Campañas" y "Descuento a tiendas").
//
//  Flujo
//   1. Se elige una MARCA, fechas de inicio/fin y (opcional) un % de descuento.
//      El sistema propone un precio de oferta por SKU (o lo propone la IA).
//   2. Se quitan los SKUs que no entran y se puede "desbloquear a costo" alguno.
//   3. Al iniciar: se guarda la oferta que tenía cada SKU (vacía o con valor) y se
//      escribe la nueva en product_variations.sale_price (el puente la lleva a la web).
//   4. Mientras dura: cada 10 min se recalcula el piso con los 2 lotes más antiguos
//      vivos (al agotarse un lote el precio se ajusta suave, sin saltos bruscos).
//   5. Al terminar (fecha fin, o "Terminar ahora"): se devuelve la oferta original.
//      Si alguien cambió la oferta a mano mientras tanto, NO se pisa: queda marcado.
//
//  Descuento (tramos por antigüedad del lote MÁS antiguo, editables en pantalla)
//   6 m → 10 %  ·  12 m → 15 %  ·  18 m → 20 %  ·  24 m → mínimo según desc. a tiendas
//   30 m → se SUGIERE a costo (el maestro lo confirma con un clic)
//   "Se vende bien" (vendió hace < 60 d y se agota en < 6 meses) → baja un tramo; en el primero, no entra.
//   La IA (opcional) revisa SKU por SKU: puede bajar o sacar, y subir solo hasta el tope del tramo.
//   Al agotarse el lote más antiguo el tramo se recalcula con el siguiente (el % solo baja).
//   EXCEPCIÓN: un precio puesto A MANO se mantiene en todos los lotes; solo sube si el nuevo piso lo supera.
//
//  Precio
//   costo       = costo del lote CON IGV ÷ 0.9 (FACTOR_COSTO: cubre gastos)
//   costo base  = promedio ponderado (por unidades) de ese costo en los 2 lotes
//                 más antiguos con existencia
//   piso        = costo base ÷ (1 − desc. a tiendas de la marca)     ← peor caso
//                 Ej. Magura 20 %: piso × 0.8 = costo → la tienda que compra con
//                 su 20 % sobre la oferta no queda por debajo del costo.
//   a costo     = piso = el costo MÁS CARO de esos 2 lotes (ninguna unidad bajo su costo)
//   oferta      = máx(precio de lista × (1 − desc. %), piso), redondeado hacia
//                 arriba al múltiplo de S/ 5
//   No entra si la oferta no queda por debajo del precio de lista, si no hay costo,
//   o si ya tiene una oferta igual o menor (no se sube un precio).
//
//  Permisos
//   · Maestro: todo (crear, aplicar, terminar campañas; reglas; descuentos a tiendas; bajar precios).
//   · Usuarios con el módulo 'inventario' (la pestaña Promociones): ven las campañas, quitan SKUs y
//     SUBEN precios de oferta (nada que baje el margen). Costos y piso solo si además tienen 'rentabilidad'.
//  Escritura en el ERP: cuenta ERP_ESCRITURA_URL con
//    GRANT SELECT, UPDATE (sale_price) ON <base>.product_variations TO '<cuenta>'@'%';
//  (si además tiene UPDATE(updated_at), se marca la fecha de cambio).
//
//  Tablas (base del portal): promo_campanas, promo_items, promo_desc_marca, promo_log
// ═══════════════════════════════════════════════════════════════════════════

const { nombreTrazable, cabeceraExcel, nombreProdVar } = require('./comunes');
const { claseUbicacion, normalizar } = require('./inventario').comun;
// Stock para armar la campaña: TODO (almacenes, tiendas y consignación) menos estas ubicaciones.
// (El portal y las solicitudes siguen usando solo stock propio: lo de consignación está en otra tienda.)
const EXCLUIR_CAMPANA = new Set((process.env.PROMO_EXCLUIR || 'CUARENTENA,EMBAJADOR').split(',').map(normalizar).filter(Boolean));

const PASO = Number(process.env.PROMO_REDONDEO || 5);         // redondeo hacia arriba (S/)
const CADA_MIN = Number(process.env.PROMO_REVISAR_MIN || 10);  // revisión automática
const NUNCA = 9999;                                            // días sin venta si nunca vendió
const TOPE_SEGURIDAD = 60;
// Costo para fijar precios = costo del lote CON IGV ÷ 0.9 (cubre gastos; pedido del usuario, oct 2026).
// El capital invertido se sigue mostrando con el costo real del lote.
const FACTOR_COSTO = 1 / 0.9;                                     // % máx. de descuento sobre el PVP sin confirmación expresa (fijo)
const TZ_LIMA = -5;                                            // Perú no tiene horario de verano
const DIA = 864e5;
const r2 = n => Math.round(n * 100) / 100;

// ─────────────────────────── cálculo puro (con pruebas) ───────────────────────────
const arriba = (x, paso = PASO) => Math.ceil(Math.round(x * 100) / 100 / paso - 1e-9) * paso;

// lotes: [{id, qty, costo, entrada}] con existencia. Devuelve el costo base (promedio
// ponderado de los 2 lotes más antiguos), el más caro de esos 2 (para "a costo") y el lote de referencia.
function costoBase(lotes) {
  const ord = (lotes || []).filter(l => Number(l.qty) > 0 && Number(l.costo) > 0)
    .sort((a, b) => (new Date(a.entrada || 0) - new Date(b.entrada || 0)) || (a.id - b.id));
  const dos = ord.slice(0, 2);
  const und = dos.reduce((s, l) => s + Number(l.qty), 0);
  if (!und) return null;
  return {
    costo: r2(dos.reduce((s, l) => s + Number(l.qty) * Number(l.costo), 0) / und),
    costo_max: r2(Math.max(...dos.map(l => Number(l.costo)))),
    unidades: und, lotes: dos.map(l => l.id), lote_ref: ord[0].id, entrada: ord[0].entrada || null
  };
}

// ── Lotes con costo simbólico (garantía, auspicio… que se ingresan como compra a ~1 dólar) ──
//  En el ERP no se marca el tipo de ingreso de una garantía: solo se nota por el COSTO, que es
//  simbólico. Un descuento grande del proveedor (ej. Magura) NO es atípico. Un lote es atípico si:
//   · cuesta menos del 10 % del costo normal del SKU (mediana de todos sus lotes), o
//   · cuesta menos del 5 % del precio de lista, o S/ 5 o menos (≈ 1 dólar).
//  Al lote atípico se le usa el costo normal (mediana). Si no hay un costo normal creíble para
//  corregirlo, el SKU queda "dudoso" y no entra en campañas hasta revisarlo en el ERP.
const ATIPICO_FACTOR = Number(process.env.PROMO_ATIPICO || 0.10);
const ATIPICO_LISTA = Number(process.env.PROMO_ATIPICO_LISTA || 0.05);
const COSTO_MIN = Number(process.env.PROMO_COSTO_MIN || 5);
const mediana = a => { const o = a.filter(x => x > 0).sort((x, y) => x - y); if (!o.length) return null; const m = o.length >> 1; return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
// historial: [{costo}] todos los lotes del SKU (también los ya vacíos); vivos: [{id, qty, costo, entrada}]
function depurarLotes(vivos, historial, lista) {
  lista = Number(lista) || 0;
  const simbolico = c => c <= COSTO_MIN || (lista > 0 && c < lista * ATIPICO_LISTA);
  // costo normal = mediana de los lotes que no son simbólicos
  const ref = mediana((historial || []).map(l => Number(l.costo)).filter(c => c > 0 && !simbolico(c)));
  const alertas = []; let dudoso = false;
  const fmt = n => 'S/ ' + Number(n).toFixed(2);
  const lotes = (vivos || []).map(l => {
    const c = Number(l.costo) || 0;
    const bajo = ref != null && c < ref * ATIPICO_FACTOR;
    if (!bajo && !simbolico(c)) return l;
    const fecha = l.entrada ? new Date(l.entrada).toISOString().slice(0, 10) : '—';
    if (ref != null) {
      alertas.push(`Lote del ${fecha} a ${fmt(c)}: costo simbólico (¿garantía o auspicio?). Se usó el costo normal ${fmt(ref)}.`);
      return { ...l, costo: Math.round(ref * 100) / 100, costo_original: c, atipico: true };
    }
    dudoso = true;
    alertas.push(`Lote del ${fecha} a ${fmt(c)}: costo simbólico y no hay otro lote con costo normal para corregirlo. Revisa el costo en el sistema.`);
    return { ...l, atipico: true };
  });
  return { lotes, alertas, dudoso, ref: ref != null ? Math.round(ref * 100) / 100 : null };
}

// it: {lista, costo_base, costo_max, oferta_actual}; o: {desc_pct, desc_tienda, a_costo}
//  piso normal  = costo base ÷ (1 − desc. a tiendas)
//  piso a costo = el costo MÁS CARO de los 2 lotes más antiguos (ninguna unidad se vende bajo su costo)
function precioPromo(it, o) {
  const lista = Number(it.lista) || 0, costo = Number(it.costo_base) || 0;
  const res = { piso: null, desc_max: null, precio: null, desc_real: null, motivo: null };
  if (!(lista > 0)) { res.motivo = 'sin_precio'; return res; }
  if (!(costo > 0)) { res.motivo = 'sin_costo'; return res; }
  const dt = Math.min(90, Math.max(0, Number(o.desc_tienda) || 0));
  const piso = o.a_costo ? arriba(Math.max(costo, Number(it.costo_max) || 0)) : arriba(costo / (1 - dt / 100));
  res.piso = piso;
  res.desc_max = Math.max(0, Math.floor((1 - piso / lista) * 1000) / 10);
  if (piso >= lista) { res.motivo = 'sin_margen'; return res; }
  const d = Math.min(95, Math.max(0, Number(o.desc_pct) || 0));
  if (!(d > 0)) { res.motivo = 'sin_descuento'; return res; }
  // d ≥ desc. máx. = "al piso" (evita que el redondeo del % lo deje un paso arriba)
  let precio = d >= res.desc_max - 0.05 ? piso : Math.max(arriba(lista * (1 - d / 100)), piso);
  if (precio >= lista) precio = null;                 // el redondeo se comió el descuento
  if (precio == null) { res.motivo = 'sin_descuento'; return res; }
  const actual = Number(it.oferta_actual) || 0;
  if (actual > 0 && actual <= precio) { res.motivo = 'ya_tiene_oferta'; }
  res.precio = precio;
  res.desc_real = Math.round((1 - precio / lista) * 1000) / 10;
  return res;
}

// Precio puesto A MANO (en Crear campaña o en Campañas): se respeta aunque cambie el lote; solo sube si el
// nuevo piso queda por encima. Devuelve null si con esos lotes ya no hay margen para descuento.
function precioFijo(lista, cb, descTienda, aCosto, manual) {
  lista = Number(lista) || 0;
  const p = precioPromo({ lista, costo_base: cb.costo, costo_max: cb.costo_max }, { desc_pct: 95, desc_tienda: descTienda, a_costo: aCosto });
  if (p.piso == null || p.piso >= lista) return null;
  const precio = Math.max(arriba(Number(manual) || 0), p.piso);
  if (precio >= lista) return null;
  return { precio, piso: p.piso, desc_real: Math.round((1 - precio / lista) * 1000) / 10 };
}

// ── Reglas por antigüedad del lote más antiguo (las definieron los vendedores) ──
//  tipo pct   → ese % sobre el precio de lista
//  tipo piso  → lo más bajo que permite el descuento a tiendas de la marca
//  tipo costo → se SUGIERE a costo; queda en "piso" hasta que el maestro lo confirma
const REGLAS_DEF = {
  tramos: [{ meses: 6, tipo: 'pct', valor: 10 }, { meses: 12, tipo: 'pct', valor: 15 }, { meses: 18, tipo: 'pct', valor: 20 },
    { meses: 24, tipo: 'piso' }, { meses: 30, tipo: 'costo' }],
  // "Se vende bien": vendió hace menos de `dias` Y a ese ritmo se agota en menos de `meses_agotar`
  //  → baja un tramo (y si ya está en el primero, no entra)
  vende_bien: { dias: 60, meses_agotar: 6 }
};
const MES = 30.4375;
function leerReglas(r) {
  r = r || {};
  const tramos = (Array.isArray(r.tramos) && r.tramos.length ? r.tramos : REGLAS_DEF.tramos)
    .map(t => ({ meses: Math.max(0, Number(t.meses) || 0), tipo: ['pct', 'piso', 'costo'].includes(t.tipo) ? t.tipo : 'pct',
      valor: t.tipo === 'pct' || !t.tipo ? Math.min(95, Math.max(0, Number(t.valor) || 0)) : null }))
    .sort((a, b) => a.meses - b.meses);
  const vb = r.vende_bien || REGLAS_DEF.vende_bien;
  return { tramos, vende_bien: { dias: Math.max(0, Number(vb.dias) || 0), meses_agotar: Math.max(0, Number(vb.meses_agotar) || 0) } };
}
const nomTramo = t => !t ? '' : t.tipo === 'pct' ? `${t.valor} %` : t.tipo === 'piso' ? 'mínimo tiendas' : 'a costo';
// x: {edad_dias, dias_sin_venta, meses_para_agotar}. sinVentas=true ignora la regla "se vende bien" (reajustes)
function tramoDe(x, reglas, sinVentas) {
  const T = reglas.tramos;
  const meses = x.edad_dias == null ? null : x.edad_dias / MES;
  let base = -1; if (meses != null) T.forEach((t, k) => { if (meses >= t.meses) base = k; });
  const vb = reglas.vende_bien;
  const vende = !sinVentas && vb.dias > 0 && x.dias_sin_venta != null && x.dias_sin_venta < vb.dias
    && x.meses_para_agotar != null && x.meses_para_agotar < vb.meses_agotar;
  const i = vende && base >= 0 ? base - 1 : base;
  const r = { base, idx: i, vende_bien: vende, meses: meses == null ? null : Math.floor(meses) };
  if (i < 0) {
    r.motivo = base < 0 ? 'muy_nuevo' : 'vende_bien';
    r.etiqueta = base < 0 ? `Lote de ${r.meses ?? '—'} m: no entra` : `${T[base].meses}+ m · vende bien: no entra`;
    return r;
  }
  const t = T[i];
  r.tipo = t.tipo; r.desc = t.tipo === 'pct' ? t.valor : 95;    // 95 = lo topa el piso
  r.sugiere_costo = t.tipo === 'costo';
  r.etiqueta = `${T[base].meses}+ m · ${nomTramo(t)}${vende ? ` (↓ de ${nomTramo(T[base])}: vende bien)` : ''}`;
  return r;
}

// Fecha 'AAAA-MM-DD' de Lima → Date UTC (inicio 00:00 o fin 23:59:59 en Lima)
function fechaLima(s, fin) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], fin ? 23 : 0, fin ? 59 : 0, fin ? 59 : 0) - TZ_LIMA * 3600e3;
  return new Date(t);
}

const MOTIVO_TXT = {
  sin_precio: 'Sin precio de lista', sin_costo: 'Sin costo de lote', sin_margen: 'El piso ya es ≥ precio de lista',
  sin_descuento: 'Sin descuento', ya_tiene_oferta: 'Ya tiene una oferta igual o menor'
};

// ─────────────────────────────── módulo ───────────────────────────────
module.exports = function registrarCampanas({ app, authAdmin, mInv, prodPool, portalPool, erpWritePool, VV, ia }) {

  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next()
    : res.status(403).json({ error: 'Solo el administrador maestro puede manejar campañas de oferta' });
  const marcaDe = nombre => (String(nombre || '').trim().split(/\s+/)[0] || '').toUpperCase();

  let listo = false;
  async function prepararTablas() {
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_campanas (
      id INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(120), marca VARCHAR(60) NOT NULL,
      inicio DATETIME NOT NULL, fin DATETIME NOT NULL,
      estado VARCHAR(15) NOT NULL DEFAULT 'programada',   -- programada|activa|terminada|cancelada
      desc_tienda DECIMAL(5,2) DEFAULT 0, redondeo INT DEFAULT 5, origen VARCHAR(10),
      creado_por VARCHAR(80), creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      aplicada_en DATETIME NULL, terminada_en DATETIME NULL, nota VARCHAR(400),
      INDEX (estado))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_items (
      id INT AUTO_INCREMENT PRIMARY KEY, campana_id INT NOT NULL, vid INT NOT NULL,
      sku VARCHAR(120), nombre VARCHAR(300), lista DECIMAL(12,2),
      desc_pct DECIMAL(5,2), a_costo TINYINT DEFAULT 0, razon VARCHAR(300),
      costo_base DECIMAL(12,2), costo_max DECIMAL(12,2), piso DECIMAL(12,2), precio DECIMAL(12,2),
      tramo VARCHAR(80), lote_ref INT NULL,
      oferta_original DECIMAL(12,2) NULL, oferta_original_guardada TINYINT DEFAULT 0,
      estado VARCHAR(15) NOT NULL DEFAULT 'pendiente',     -- pendiente|activo|restaurado|omitido|conflicto
      nota VARCHAR(300), aplicado_en DATETIME NULL, restaurado_en DATETIME NULL,
      INDEX (campana_id), INDEX (vid, estado))`);
    // Columnas agregadas después de la 1.ª versión (si la tabla ya existía)
    for (const c of ['costo_max DECIMAL(12,2)', 'tramo VARCHAR(80)', 'lote_ref INT NULL', 'extremo_ok TINYINT DEFAULT 0',
      'cambios_lote INT DEFAULT 0', 'alerta_costo VARCHAR(400)', 'precio_manual DECIMAL(12,2) NULL'])
      await portalPool.query(`ALTER TABLE promo_items ADD COLUMN ${c}`).catch(() => {});
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_desc_marca (
      marca VARCHAR(60) PRIMARY KEY, pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      actualizado DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_config (
      clave VARCHAR(40) PRIMARY KEY, valor TEXT,
      actualizado DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_log (
      id INT AUTO_INCREMENT PRIMARY KEY, campana_id INT, vid INT, accion VARCHAR(20),
      antes DECIMAL(12,2) NULL, despues DECIMAL(12,2) NULL, nota VARCHAR(300),
      en DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX (campana_id))`);
    listo = true;
    if (!erpWritePool) console.warn('[promociones] Sin ERP_ESCRITURA_URL: las campañas se guardan pero no cambian precios.');
    setInterval(() => revisar().catch(e => console.warn('[promociones] revisión:', e.message)), CADA_MIN * 60e3);
    setTimeout(() => revisar().catch(e => console.warn('[promociones] revisión:', e.message)), 20e3);
  }

  async function descTiendas() {
    const [r] = await portalPool.query(`SELECT marca, pct FROM promo_desc_marca`);
    const m = {}; r.forEach(x => m[x.marca] = Number(x.pct) || 0); return m;
  }
  async function reglas() {
    const [[r]] = await portalPool.query(`SELECT valor FROM promo_config WHERE clave='reglas'`);
    let v = null; try { v = r ? JSON.parse(r.valor) : null; } catch (e) {}
    return leerReglas(v);
  }

  // Lotes vivos de cada SKU con el costo depurado (ver depurarLotes). listaPor: {vid: precio de lista}
  async function lotesDe(ids, listaPor) {
    const out = {}; if (!ids.length) return out;
    const [filas] = await prodPool.query(`SELECT id, product_variation_id AS vid, quantity AS qty, cost_price AS costo,
        entry_date AS entrada FROM stock_batches WHERE product_variation_id IN (?)`, [ids]);
    const hist = {}, vivos = {};
    filas.forEach(l => { (hist[l.vid] = hist[l.vid] || []).push(l); if (Number(l.qty) > 0) (vivos[l.vid] = vivos[l.vid] || []).push(l); });
    ids.forEach(vid => {
      const d = depurarLotes(vivos[vid] || [], hist[vid] || [], Number((listaPor || {})[vid]) || 0);
      // lotes para precio: costo ÷ 0.9; crudos: costo real (capital)
      d.lotes = d.lotes.map(l => ({ ...l, costo: Math.round(Number(l.costo) * FACTOR_COSTO * 100) / 100 }));
      d.crudos = vivos[vid] || [];
      out[vid] = d;
    });
    return out;
  }

  // ── Datos de una marca: SKUs activos con stock propio, lotes, ventas ──
  async function datosMarca(marca) {
    const M = marcaDe(marca); if (!M) return [];
    const [cat] = await prodPool.query(`
      SELECT pv.id AS vid, pv.sku, pv.name AS variacion, p.name AS producto,
        pv.regular_price, pv.sale_price
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
        AND (pv.status IS NULL OR pv.status = 'active')
        AND (p.name LIKE ? OR p.name = ?)`, [M + ' %', M]);
    const lista = cat.filter(c => marcaDe(c.producto) === M);
    if (!lista.length) return [];
    const ids = lista.map(c => c.vid);
    const listaPor = {}; lista.forEach(c => listaPor[c.vid] = Number(c.regular_price) || 0);
    const [[ubic], lotesD, [ventas], [mensual]] = await Promise.all([
      prodPool.query(`
        SELECT ls.product_variation_id AS vid, l.name AS loc_nombre, l.type AS loc_tipo,
          ls.quantity AS qty, ls.reserved_quantity AS reservado
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0 AND ls.product_variation_id IN (?)`, [ids]),
      lotesDe(ids, listaPor),
      prodPool.query(`
        SELECT si.product_variation_id AS vid,
          SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH) THEN si.quantity ELSE 0 END) AS und_12m,
          MAX(s.created_at) AS ultima_venta
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND si.product_variation_id IN (?)
        GROUP BY si.product_variation_id`, [ids]),
      // Ventas por mes (12 meses) para que la IA vea estacionalidad
      prodPool.query(`
        SELECT si.product_variation_id AS vid, DATE_FORMAT(s.created_at, '%Y-%m') AS mes, SUM(si.quantity) AS und
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND si.product_variation_id IN (?)
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
        GROUP BY si.product_variation_id, mes`, [ids])
    ]);
    const st = {}, vt = {}, mt = {};
    ubic.forEach(u => {
      if (EXCLUIR_CAMPANA.has(normalizar(u.loc_nombre))) return;          // cuarentena, embajador
      const e = st[u.vid] = st[u.vid] || { q: 0, res: 0, consig: 0 };
      const q = Number(u.qty) || 0; e.q += q; e.res += Math.min(q, Math.max(0, Number(u.reservado) || 0));
      if (u.loc_tipo === 'consignment') e.consig += q;
    });
    ventas.forEach(v => vt[v.vid] = v);
    mensual.forEach(m => (mt[m.vid] = mt[m.vid] || {})[m.mes] = Number(m.und) || 0);
    const hoy = Date.now(), dias = f => f ? Math.max(0, Math.floor((hoy - new Date(f).getTime()) / DIA)) : null;
    const meses12 = [...Array(12)].map((_, k) => { const d = new Date(hoy); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11 + k); return d.toISOString().slice(0, 7); });
    return lista.map(c => {
      const s = st[c.vid] || { q: 0, res: 0, consig: 0 };
      const D = lotesD[c.vid] || { lotes: [], crudos: [], alertas: [] };
      const L = D.crudos;   // capital con el costo real registrado
      const und = L.reduce((a, l) => a + Number(l.qty), 0), cap = L.reduce((a, l) => a + Number(l.qty) * Number(l.costo), 0);
      const cb = costoBase(D.lotes);
      const v = vt[c.vid] || {};
      const dsv = dias(v.ultima_venta);
      const und12 = Number(v.und_12m) || 0;
      return {
        vid: c.vid, sku: c.sku || '', nombre: nombreProdVar(c.producto, c.variacion), marca: marcaDe(c.producto),
        lista: Number(c.regular_price) || 0, oferta_actual: c.sale_price != null && Number(c.sale_price) > 0 ? Number(c.sale_price) : null,
        stock: s.q, disponibles: s.q - s.res, stock_consig: s.consig,
        capital: r2(s.q * (und ? cap / und : 0)),
        costo_base: cb ? cb.costo : null, costo_max: cb ? cb.costo_max : null, und_lotes_base: cb ? cb.unidades : 0,
        lote_ref: cb ? cb.lote_ref : null,
        alerta_costo: D.alertas.join(' '), costo_dudoso: !!D.dudoso,
        edad_dias: cb ? dias(cb.entrada) : null,
        dias_sin_venta: dsv == null ? NUNCA : dsv, und_12m: und12,
        ventas_mes: meses12.map(m => (mt[c.vid] || {})[m] || 0),
        meses_para_agotar: und12 > 0 ? Math.round(s.q / (und12 / 12) * 10) / 10 : null
      };
    }).filter(x => x.disponibles > 0);
  }

  // ── IA: revisa SKU por SKU el % de su tramo. Puede bajarlo o sacarlo (0), y subirlo solo hasta el tope del tramo ──
  async function revisarIA(marca, items) {
    if (!ia || !ia.llamarGemini) return { ok: false, error: 'IA no disponible' };
    const out = {};
    for (let i = 0; i < items.length; i += 100) {
      const lote = items.slice(i, i + 100).map(x => ({ id: x.vid, nombre: x.nombre.slice(0, 80), precio_lista: x.lista,
        desc_tramo_pct: x.desc_regla, desc_max_pct: x.tope_ia, tramo: x.tramo, meses_lote_mas_antiguo: x.tramo_info.meses,
        dias_sin_venta: x.dias_sin_venta, ventas_12_meses_por_mes: x.ventas_mes, stock: x.stock, capital_soles: x.capital,
        meses_para_agotar: x.meses_para_agotar }));
      const prompt = `Eres el gerente comercial de una tienda de bicicletas y componentes en Perú (precios en soles, con IGV; vendemos al público, a tiendas y a talleres).
Campaña de precio de oferta temporal para liquidar stock antiguo de la marca ${marca}. Cada producto ya trae el % de su tramo (desc_tramo_pct, según la antigüedad del lote más antiguo).
Revisa producto por producto y devuelve el % final:
- Puedes BAJARLO o poner 0 (no incluir) si no hace falta: se vende de forma constante, se vende por temporada y viene su temporada, o rota bien en tiendas/talleres.
- Puedes SUBIRLO solo hasta desc_max_pct, nunca más.
- 9999 días sin venta = nunca se vendió. ventas_12_meses_por_mes va del mes más antiguo al actual.
- Usa múltiplos de 5. Si no cambias nada, devuelve el mismo desc_tramo_pct.
Responde SOLO JSON: [{"id": 123, "desc_pct": 15, "razon": "frase corta en español (por qué lo cambias o lo mantienes)"}]
Productos: ${JSON.stringify(lote)}`;
      const txt = await ia.llamarGemini(prompt, 0.2, 60000);
      if (!txt) return { ok: false, error: (ia.ultimoError && ia.ultimoError()) || 'La IA no respondió' };
      let arr; try { arr = JSON.parse(String(txt).replace(/^```(json)?|```$/g, '').trim()); } catch (e) { return { ok: false, error: 'La IA respondió en un formato no válido' }; }
      (Array.isArray(arr) ? arr : []).forEach(r => { if (r && r.id != null) out[r.id] = { desc: Number(r.desc_pct) || 0, razon: String(r.razon || '').slice(0, 250) }; });
    }
    return { ok: true, porId: out };
  }

  // Arma la propuesta (lo usa la vista previa y también el guardado, que recalcula todo)
  //  Orden: % manual del SKU  >  % general (reemplaza el % de los tramos)  >  tramo por antigüedad (+ revisión IA)
  //  La regla "se vende bien" siempre se aplica salvo % manual.
  async function armarPropuesta(b) {
    const marca = marcaDe(b.marca); if (!marca) throw new Error('Elige una marca');
    const [dtMap, R] = await Promise.all([descTiendas(), reglas()]);
    const descTienda = b.desc_tienda != null && b.desc_tienda !== '' ? Number(b.desc_tienda) : (dtMap[marca] || 0);
    const f = b.filtros || {};
    let items = await datosMarca(marca);
    items = items.filter(x =>
      (!f.edad_min || (x.edad_dias || 0) >= Number(f.edad_min)) &&
      (!f.dsv_min || x.dias_sin_venta >= Number(f.dsv_min)) &&
      (!f.capital_min || x.capital >= Number(f.capital_min)) &&
      (!f.lista_min || x.lista >= Number(f.lista_min)) &&
      (!f.lista_max || x.lista <= Number(f.lista_max)));
    const aCosto = new Set((b.a_costo || []).map(Number));
    const extremoOk = new Set((b.extremo_ok || []).map(Number));   // confirmados por encima del tope de seguridad
    const manual = b.desc_manual || {};               // {vid: %}
    const general = b.desc_pct != null && b.desc_pct !== '' ? Number(b.desc_pct) : null;

    items.forEach(x => {
      x.a_costo = aCosto.has(x.vid);
      const t = x.tramo_info = tramoDe(x, R);
      x.tramo = t.etiqueta; x.sugiere_costo = !!t.sugiere_costo; x.vende_bien = t.vende_bien;
      const lim = precioPromo(x, { desc_pct: 95, desc_tienda: descTienda, a_costo: x.a_costo });
      x.desc_max = lim.desc_max;
      x.desc_regla = t.idx < 0 ? 0 : general != null ? general : Math.min(t.desc, x.desc_max ?? 0);
      x.tope_ia = t.idx < 0 ? 0 : general != null ? general : t.tipo === 'pct' ? Math.min(t.desc, x.desc_max ?? 0) : (x.desc_max ?? 0);
    });

    let origen = general != null ? 'general' : 'tramos', avisoIA = null, porIA = {};
    if (b.usar_ia) {
      const r = await revisarIA(marca, items.filter(x => x.desc_regla > 0));
      if (r.ok) { origen = 'ia'; porIA = r.porId; } else avisoIA = 'IA: ' + r.error + ' — se usaron solo los tramos por antigüedad.';
    }
    items.forEach(x => {
      const t = x.tramo_info;
      let d, razon;
      x.ia_cambio = false;
      if (manual[x.vid] != null && manual[x.vid] !== '') { d = Number(manual[x.vid]); razon = (b.razones && b.razones[x.vid]) || 'Manual'; }
      else if (t.idx < 0) {
        d = 0;
        razon = t.motivo === 'muy_nuevo' ? `No entra: el lote más antiguo tiene ${t.meses ?? '—'} meses (menos que el primer tramo)`
          : `No entra: se vende bien (vendió hace ${x.dias_sin_venta} d y se agota en ${x.meses_para_agotar} meses)`;
      } else {
        d = x.desc_regla;
        razon = general != null ? `Descuento general ${general} %` : `Tramo ${t.etiqueta}`;
        if (porIA[x.vid]) {
          const s = Math.min(Math.max(0, porIA[x.vid].desc), x.tope_ia);
          if (Math.abs(s - d) >= 0.5) { x.ia_cambio = true; razon = `IA: ${s > d ? '+' : ''}${Math.round((s - d) * 10) / 10} % · ${porIA[x.vid].razon}`; }
          else razon += ` · IA: ${porIA[x.vid].razon}`;
          d = s;
        }
      }
      if (x.desc_max != null) d = Math.min(Math.max(0, d), x.desc_max);   // nunca más allá del piso
      x.desc_pct = d; x.razon = razon;
      Object.assign(x, precioPromo(x, { desc_pct: d, desc_tienda: descTienda, a_costo: x.a_costo }));
      x.motivo_txt = x.motivo && x.motivo !== 'sin_descuento' ? MOTIVO_TXT[x.motivo] : '';
      x.entra = x.precio != null && x.motivo !== 'ya_tiene_oferta';
      x.extremo_ok = extremoOk.has(x.vid);
      if (x.costo_dudoso) { x.entra = false; x.motivo_txt = '⚠ Costo dudoso: ' + x.alerta_costo; }
      else if (x.precio != null && x.desc_real > TOPE_SEGURIDAD && !x.extremo_ok) {
        x.entra = false; x.requiere_confirmar = true;
        x.motivo_txt = `⚠ −${x.desc_real} % supera el tope de seguridad (${TOPE_SEGURIDAD} %): confírmalo si es correcto`;
      }
      delete x.tramo_info; delete x.ventas_mes;
    });
    // SKUs que ya están en otra campaña activa o programada
    const [ocup] = await portalPool.query(`SELECT i.vid, c.id, c.nombre FROM promo_items i JOIN promo_campanas c ON c.id = i.campana_id
      WHERE c.estado IN ('programada','activa') AND i.estado IN ('pendiente','activo')`);
    const oc = {}; ocup.forEach(o => oc[o.vid] = o);
    items.forEach(x => { if (oc[x.vid]) { x.en_campana = oc[x.vid].id; x.entra = false; x.motivo_txt = `Ya está en la campaña #${oc[x.vid].id}`; } });
    items.sort((a, b2) => (b2.entra - a.entra) || b2.capital - a.capital);
    return { marca, desc_tienda: descTienda, redondeo: PASO, tope_seguridad: TOPE_SEGURIDAD, origen, aviso_ia: avisoIA, reglas: R, items };
  }

  // ── Escritura en el ERP (compare-and-set: solo cambia si la oferta sigue como esperamos) ──
  async function leerOferta(vid) {
    const [[r]] = await (erpWritePool || prodPool).query(`SELECT sale_price FROM product_variations WHERE id = ?`, [vid]);
    return r ? r.sale_price : undefined;
  }
  const igual = (a, b) => (a == null || b == null) ? a == null && b == null : Math.abs(Number(a) - Number(b)) < 0.005;
  let conUpdatedAt = true;
  async function escribirOferta(vid, nuevo, esperado) {
    if (!erpWritePool) throw new Error('Falta ERP_ESCRITURA_URL (no se puede escribir en el sistema)');
    const sql = s => `UPDATE product_variations SET sale_price = ?${s ? ', updated_at = NOW()' : ''} WHERE id = ? AND (sale_price <=> ?)`;
    let r;
    try { [r] = await erpWritePool.query(sql(conUpdatedAt), [nuevo, vid, esperado]); }
    catch (e) {
      if (conUpdatedAt && /updated_at|column/i.test(e.message)) { conUpdatedAt = false; [r] = await erpWritePool.query(sql(false), [nuevo, vid, esperado]); }
      else throw e;
    }
    cacheOfertas = null;                                 // el portal y los links verán el cambio al momento
    if (r.affectedRows > 0) return true;
    return igual(await leerOferta(vid), nuevo);         // ya tenía ese valor
  }
  const log = (cid, vid, accion, antes, despues, nota) => portalPool.query(
    `INSERT INTO promo_log (campana_id, vid, accion, antes, despues, nota) VALUES (?,?,?,?,?,?)`,
    [cid, vid, accion, antes, despues, nota || null]).catch(() => {});

  // Inicia una campaña: guarda la oferta original y escribe la nueva
  async function aplicarCampana(c) {
    const [items] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id = ? AND estado = 'pendiente'`, [c.id]);
    const lp = {}; items.forEach(i => lp[i.vid] = Number(i.lista));
    const LD = await lotesDe(items.map(i => i.vid), lp);
    let ok = 0, omit = 0;
    for (const it of items) {
      try {
        const actual = await leerOferta(it.vid);
        if (actual === undefined) { await marcar(it, 'omitido', 'El SKU ya no existe en el sistema'); omit++; continue; }
        const D = LD[it.vid] || { lotes: [] };
        if (D.dudoso) { await marcar(it, 'omitido', 'Costo dudoso: ' + D.alertas.join(' ')); omit++; continue; }
        const cb = costoBase(D.lotes);
        const p = precioPromo({ lista: it.lista, costo_base: cb ? cb.costo : it.costo_base, costo_max: cb ? cb.costo_max : it.costo_max, oferta_actual: actual },
          { desc_pct: it.desc_pct, desc_tienda: c.desc_tienda, a_costo: !!it.a_costo });
        if (it.precio_manual != null && cb) {                    // precio puesto a mano: se respeta (solo sube al piso)
          const f = precioFijo(it.lista, cb, c.desc_tienda, !!it.a_costo, it.precio_manual);
          if (!f) { p.precio = null; p.motivo = 'sin_margen'; }
          else { p.precio = f.precio; p.piso = f.piso; p.desc_real = f.desc_real; if (actual != null && Number(actual) > 0 && Number(actual) <= f.precio) p.motivo = 'ya_tiene_oferta'; }
        }
        if (p.precio == null || p.motivo === 'ya_tiene_oferta') { await marcar(it, 'omitido', MOTIVO_TXT[p.motivo] || 'Sin descuento posible'); omit++; continue; }
        if (p.desc_real > TOPE_SEGURIDAD && !Number(it.extremo_ok)) { await marcar(it, 'omitido', `−${p.desc_real} % supera el tope de seguridad (${TOPE_SEGURIDAD} %) sin confirmación`); omit++; continue; }
        if (await escribirOferta(it.vid, p.precio, actual)) {
          await portalPool.query(`UPDATE promo_items SET estado='activo', oferta_original=?, oferta_original_guardada=1, precio=?, piso=?,
            costo_base=?, costo_max=?, lote_ref=?, aplicado_en=NOW(), nota=NULL WHERE id=?`,
            [actual, p.precio, p.piso, cb ? cb.costo : it.costo_base, cb ? cb.costo_max : it.costo_max, cb ? cb.lote_ref : null, it.id]);
          await log(c.id, it.vid, 'aplicar', actual, p.precio); ok++;
        } else { await marcar(it, 'conflicto', 'La oferta cambió mientras se aplicaba; no se tocó'); omit++; }
      } catch (e) { await marcar(it, 'pendiente', 'Error: ' + e.message.slice(0, 200)); }
    }
    await portalPool.query(`UPDATE promo_campanas SET estado='activa', aplicada_en=COALESCE(aplicada_en, NOW()) WHERE id=?`, [c.id]);
    return { aplicados: ok, omitidos: omit };
  }
  const marcar = (it, estado, nota) => portalPool.query(`UPDATE promo_items SET estado=?, nota=? WHERE id=?`, [estado, nota, it.id]);

  // Devuelve la oferta original de los ítems activos
  async function terminarCampana(c, estadoFinal = 'terminada') {
    const [items] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id = ? AND estado IN ('activo','pendiente')`, [c.id]);
    let ok = 0, conf = 0, pendientesError = 0;
    for (const it of items) {
      if (it.estado === 'pendiente') { await marcar(it, 'omitido', 'La campaña terminó antes de aplicarse'); continue; }
      try {
        const original = it.oferta_original_guardada ? it.oferta_original : null;
        if (await escribirOferta(it.vid, original, it.precio)) {
          await portalPool.query(`UPDATE promo_items SET estado='restaurado', restaurado_en=NOW(), nota=NULL WHERE id=?`, [it.id]);
          await log(c.id, it.vid, 'restaurar', it.precio, original); ok++;
        } else {
          const actual = await leerOferta(it.vid);
          await marcar(it, 'conflicto', `Alguien cambió la oferta a ${actual == null ? 'vacío' : 'S/ ' + actual} durante la campaña; no se tocó (original: ${original == null ? 'vacío' : 'S/ ' + original})`);
          await log(c.id, it.vid, 'conflicto', it.precio, actual); conf++;
        }
      } catch (e) { pendientesError++; await portalPool.query(`UPDATE promo_items SET nota=? WHERE id=?`, ['Error al restaurar: ' + e.message.slice(0, 200), it.id]); }
    }
    // Si algún SKU no se pudo restaurar por error de conexión, la campaña sigue activa y se reintenta
    if (!pendientesError) await portalPool.query(`UPDATE promo_campanas SET estado=?, terminada_en=NOW() WHERE id=?`, [estadoFinal, c.id]);
    return { restaurados: ok, conflictos: conf, con_error: pendientesError };
  }

  // Ajuste durante la campaña:
  //  · el piso sigue a los 2 lotes más antiguos vivos (promedio; "a costo" = el más caro de los 2)
  //  · si se agotó el lote más antiguo, el tramo se recalcula con la edad del nuevo lote más antiguo:
  //    el % solo puede BAJAR (lo nuevo necesita menos descuento); si ya no llega al primer tramo, sale.
  //    Que un lote cumpla un mes más NO cambia el tramo a mitad de campaña.
  async function reajustar(c) {
    const [items] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id = ? AND estado = 'activo'`, [c.id]);
    if (!items.length) return 0;
    const R = await reglas();
    const lst = {}; items.forEach(i => lst[i.vid] = Number(i.lista));
    const LD = await lotesDe(items.map(i => i.vid), lst);
    const original = it => it.oferta_original_guardada ? it.oferta_original : null;
    const devolver = async (it, nota, cb) => {
      if (await escribirOferta(it.vid, original(it), it.precio)) {
        await portalPool.query(`UPDATE promo_items SET estado='restaurado', restaurado_en=NOW(), costo_base=?, lote_ref=?, nota=? WHERE id=?`,
          [cb.costo, cb.lote_ref, nota, it.id]);
        await log(c.id, it.vid, 'restaurar', it.precio, original(it), nota);
      }
    };
    let n = 0;
    for (const it of items) {
      const D = LD[it.vid] || { lotes: [] };
      const cb = costoBase(D.lotes); if (!cb) continue;            // sin stock: queda hasta el fin
      if (D.dudoso) { await devolver(it, 'Sale: ' + D.alertas.join(' '), cb); continue; }
      let desc = Number(it.desc_pct), aCosto = !!it.a_costo, tramo = it.tramo, nota = null;
      const cambioLote = it.lote_ref != null && Number(it.lote_ref) !== cb.lote_ref;
      const manual = it.precio_manual != null;
      if (manual) {
        // Precio puesto a mano: se mantiene en todos los lotes; solo sube si el nuevo piso lo supera
        const mismo = Math.abs(cb.costo - Number(it.costo_base)) < 0.005 && Math.abs(cb.costo_max - Number(it.costo_max || cb.costo_max)) < 0.005;
        if (!cambioLote && mismo) { if (it.lote_ref == null) await portalPool.query(`UPDATE promo_items SET lote_ref=?, costo_max=? WHERE id=?`, [cb.lote_ref, cb.costo_max, it.id]); continue; }
        const f = precioFijo(it.lista, cb, c.desc_tienda, aCosto, it.precio_manual);
        if (!f) { await devolver(it, 'Sale antes: con el costo de los lotes que quedan ya no hay margen para tu precio', cb); continue; }
        const guardarM = () => portalPool.query(`UPDATE promo_items SET precio=?, piso=?, costo_base=?, costo_max=?, lote_ref=?, desc_pct=?, cambios_lote = cambios_lote + ? WHERE id=?`,
          [f.precio, f.piso, cb.costo, cb.costo_max, cb.lote_ref, f.desc_real, cambioLote ? 1 : 0, it.id]);
        if (Math.abs(f.precio - Number(it.precio)) < 0.005) { await guardarM(); continue; }
        if (await escribirOferta(it.vid, f.precio, it.precio)) {
          await guardarM();
          await log(c.id, it.vid, 'reajustar', it.precio, f.precio, `Precio manual S/ ${Number(it.precio_manual)}: sube al nuevo piso S/ ${f.piso}`); n++;
        } else {
          const actual = await leerOferta(it.vid);
          await marcar(it, 'conflicto', `Alguien cambió la oferta a ${actual == null ? 'vacío' : 'S/ ' + actual}; se deja de seguir este SKU`);
        }
        continue;
      }
      if (cambioLote) {
        const edad = cb.entrada ? Math.floor((Date.now() - new Date(cb.entrada).getTime()) / DIA) : null;
        const t = tramoDe({ edad_dias: edad }, R, true);
        if (t.idx < 0) { await devolver(it, `Sale: se acabó el lote antiguo y el que sigue tiene ${t.meses ?? '—'} meses`, cb); continue; }
        if (aCosto && t.tipo !== 'costo') aCosto = false;
        desc = Math.min(desc, t.tipo === 'pct' ? t.desc : 95);
        tramo = t.etiqueta; nota = `Cambio de lote → ${t.etiqueta}`;
      }
      const mismoCosto = Math.abs(cb.costo - Number(it.costo_base)) < 0.005 && Math.abs(cb.costo_max - Number(it.costo_max || cb.costo_max)) < 0.005;
      if (!cambioLote && mismoCosto) {
        if (it.lote_ref == null) await portalPool.query(`UPDATE promo_items SET lote_ref=?, costo_max=? WHERE id=?`, [cb.lote_ref, cb.costo_max, it.id]);
        continue;
      }
      const p = precioPromo({ lista: it.lista, costo_base: cb.costo, costo_max: cb.costo_max }, { desc_pct: desc, desc_tienda: c.desc_tienda, a_costo: aCosto });
      if (p.precio == null) { await devolver(it, 'Sale antes: con el costo de los lotes que quedan ya no hay margen para descuento', cb); continue; }
      if (p.desc_real > TOPE_SEGURIDAD && !Number(it.extremo_ok)) { await devolver(it, `Sale: el nuevo precio (−${p.desc_real} %) superaría el tope de seguridad (${TOPE_SEGURIDAD} %)`, cb); continue; }
      const guardar = () => portalPool.query(`UPDATE promo_items SET precio=?, piso=?, costo_base=?, costo_max=?, lote_ref=?, desc_pct=?, a_costo=?, tramo=?,
          cambios_lote = cambios_lote + ? WHERE id=?`,
        [p.precio, p.piso, cb.costo, cb.costo_max, cb.lote_ref, desc, aCosto ? 1 : 0, tramo, cambioLote ? 1 : 0, it.id]);
      if (Math.abs(p.precio - Number(it.precio)) < 0.005) { await guardar(); continue; }
      if (await escribirOferta(it.vid, p.precio, it.precio)) {
        await guardar();
        await log(c.id, it.vid, 'reajustar', it.precio, p.precio, nota || `Costo base ${it.costo_base} → ${cb.costo} (cambio de lote)`); n++;
      } else {
        const actual = await leerOferta(it.vid);
        await marcar(it, 'conflicto', `Alguien cambió la oferta a ${actual == null ? 'vacío' : 'S/ ' + actual}; se deja de seguir este SKU`);
      }
    }
    return n;
  }

  let revisando = false;
  async function revisar() {
    if (!listo || revisando || !erpWritePool) return;
    revisando = true;
    try {
      const [cs] = await portalPool.query(`SELECT * FROM promo_campanas WHERE estado IN ('programada','activa')`);
      const ahora = Date.now();
      for (const c of cs) {
        if (new Date(c.fin).getTime() <= ahora) await terminarCampana(c);
        else if (c.estado === 'programada' && new Date(c.inicio).getTime() <= ahora) await aplicarCampana(c);
        else if (c.estado === 'activa') { await aplicarPendientes(c); await reajustar(c); }
      }
    } finally { revisando = false; }
  }
  // Reintenta los ítems que quedaron pendientes por un error de conexión
  async function aplicarPendientes(c) {
    const [[n]] = await portalPool.query(`SELECT COUNT(*) n FROM promo_items WHERE campana_id=? AND estado='pendiente'`, [c.id]);
    if (n.n) await aplicarCampana(c);
  }

  // ─────────────── Ofertas vigentes (para el portal de clientes y los links libres) ───────────────
  //  Por SKU activo en una campaña activa:
  //   precio (PVP oferta), tu_precio (tienda: PVP oferta × (1 − desc. a tiendas); en liquidación = PVP oferta),
  //   stock_oferta = unidades del lote más antiguo (limitado al stock propio disponible),
  //   siguiente = precio y unidades del siguiente lote si sigue en oferta (o "sale"),
  //   ciudades = stock propio disponible por ciudad.
  let colCiudad;
  async function columnaCiudad() {
    if (colCiudad !== undefined) return colCiudad;
    try {
      const [c] = await prodPool.query(`SHOW COLUMNS FROM locations`);
      const n = c.map(x => x.Field);
      colCiudad = ['city', 'ciudad', 'province', 'provincia', 'district', 'distrito', 'state', 'departamento'].find(x => n.includes(x)) || null;
    } catch (e) { colCiudad = null; }
    return colCiudad;
  }
  let cacheOfertas = null;
  async function ofertasVigentes(forzar) {
    if (!forzar && cacheOfertas && Date.now() - cacheOfertas.t < 60e3) return cacheOfertas.d;
    const [its] = await portalPool.query(`SELECT i.*, c.marca, c.fin, c.nombre AS campana, c.desc_tienda
      FROM promo_items i JOIN promo_campanas c ON c.id = i.campana_id
      WHERE c.estado = 'activa' AND i.estado = 'activo'`);
    const out = { items: [], generado: new Date().toISOString() };
    if (!its.length) { cacheOfertas = { t: Date.now(), d: out }; return out; }
    const ids = [...new Set(its.map(i => i.vid))];
    const lp = {}; its.forEach(i => lp[i.vid] = Number(i.lista));
    const cc = await columnaCiudad();
    const [LD, [ubic], [prods], R] = await Promise.all([
      lotesDe(ids, lp),
      prodPool.query(`SELECT ls.product_variation_id AS vid, l.name AS loc_nombre, l.type AS loc_tipo,
          ${cc ? `l.\`${cc}\`` : 'NULL'} AS ciudad, ls.quantity AS qty, ls.reserved_quantity AS reservado
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0 AND ls.product_variation_id IN (?)`, [ids]),
      prodPool.query(`SELECT id AS vid, product_id AS pid FROM product_variations WHERE id IN (?)`, [ids]),
      reglas()
    ]);
    const pidDe = {}; prods.forEach(p => pidDe[p.vid] = p.pid);
    const img = {};
    try {
      const pids = [...new Set(prods.map(p => p.pid))];
      const [ims] = await prodPool.query(`SELECT product_id, product_variation_id, path FROM product_images
        WHERE deleted_at IS NULL AND path IS NOT NULL AND path <> '' AND (product_variation_id IN (?) OR product_id IN (?))
        ORDER BY is_primary DESC, sort_order ASC, id ASC`, [ids, pids.length ? pids : [0]]);
      const iv = {}, ip = {};
      ims.forEach(m => { if (m.product_variation_id != null) { if (!iv[m.product_variation_id]) iv[m.product_variation_id] = m.path; } else if (!ip[m.product_id]) ip[m.product_id] = m.path; });
      ids.forEach(v => img[v] = iv[v] || ip[pidDe[v]] || null);
    } catch (e) { /* sin imágenes */ }
    const disp = {}, ciud = {};
    ubic.forEach(u => {
      if (claseUbicacion(u.loc_tipo, u.loc_nombre) !== 'propio') return;
      const d = Math.max(0, (Number(u.qty) || 0) - Math.max(0, Number(u.reservado) || 0)); if (!d) return;
      disp[u.vid] = (disp[u.vid] || 0) + d;
      const c = String(u.ciudad || '').trim() || String(u.loc_nombre || '').trim() || '—';
      const m = ciud[u.vid] = ciud[u.vid] || {}; m[c] = (m[c] || 0) + d;
    });
    const tienda = (precio, liq, dt) => precio == null ? null : liq ? precio : r2(precio * (1 - (Number(dt) || 0) / 100));
    const ahora = Date.now();
    its.forEach(it => {
      const D = LD[it.vid] || { lotes: [] };
      const ord = D.lotes.slice().sort((a, b) => (new Date(a.entrada || 0) - new Date(b.entrada || 0)) || (a.id - b.id));
      const total = disp[it.vid] || 0;
      if (!ord.length || !total) return;
      const precio = Number(it.precio), liq = !!Number(it.a_costo);
      const stockOferta = Math.min(Number(ord[0].qty) || 0, total);
      let siguiente = null;
      const resto = ord.slice(1);
      if (resto.length && total > stockOferta) {
        const cbN = costoBase(resto);
        const edad = resto[0].entrada ? Math.floor((ahora - new Date(resto[0].entrada).getTime()) / DIA) : null;
        const t = tramoDe({ edad_dias: edad }, R, true);
        if (t.idx < 0 || !cbN) siguiente = { sale: true };
        else {
          const aC = liq && t.tipo === 'costo';
          const dN = Math.min(Number(it.desc_pct), t.tipo === 'pct' ? t.desc : 95);
          const pN = precioPromo({ lista: it.lista, costo_base: cbN.costo, costo_max: cbN.costo_max }, { desc_pct: dN, desc_tienda: it.desc_tienda, a_costo: aC });
          if (pN.precio == null || (pN.desc_real > TOPE_SEGURIDAD && !Number(it.extremo_ok))) siguiente = { sale: true };
          else siguiente = { precio: pN.precio, tu_precio: tienda(pN.precio, aC, it.desc_tienda), unidades: Math.min(Number(resto[0].qty) || 0, total - stockOferta), liquidacion: aC };
        }
      }
      out.items.push({
        vid: it.vid, sku: it.sku, nombre: it.nombre, marca: it.marca, campana: it.campana, hasta: it.fin, imagen: img[it.vid] || null,
        pvp: Number(it.lista), precio, tu_precio: tienda(precio, liq, it.desc_tienda), desc_pct: Math.round((1 - precio / Number(it.lista)) * 1000) / 10,
        stock_oferta: stockOferta, stock_total: total,
        ciudades: Object.entries(ciud[it.vid] || {}).map(([c, n]) => ({ ciudad: c, unidades: n })).sort((a, b) => b.unidades - a.unidades),
        liquidacion: liq, cambios_lote: Number(it.cambios_lote) || 0, siguiente,
        _dt: Number(it.desc_tienda) || 0, _fin: it.fin    // internos: los usa el portal (precio por tipo de cuenta, vencimiento de reservas)
      });
    });
    out.items.sort((a, b) => (a.cambios_lote - b.cambios_lote) || a.marca.localeCompare(b.marca) || a.nombre.localeCompare(b.nombre));
    cacheOfertas = { t: Date.now(), d: out };
    return out;
  }

  // ─────────────────────────── endpoints ───────────────────────────
  const mw = [authAdmin, soloMaestro];                       // solo maestro
  const ver = [authAdmin, mInv || soloMaestro];              // maestro o módulo 'inventario'
  const esMaestro = req => !!(req.admin && req.admin.maestro);
  const veCostos = req => esMaestro(req) || (Array.isArray(req.admin && req.admin.modulos) && req.admin.modulos.includes('rentabilidad'));
  const sinCostos = it => { const { costo_base, costo_max, piso, alerta_costo, ...x } = it; return x; };
  const err = (res, e) => res.status(e.status || 500).json({ error: e.message });

  app.get('/api/promo-config', ...ver, async (req, res) => {
    try {
      const [m] = await prodPool.query(`SELECT DISTINCT UPPER(SUBSTRING_INDEX(TRIM(p.name), ' ', 1)) AS marca
        FROM products p WHERE p.deleted_at IS NULL ORDER BY marca`);
      res.json({ marcas: m.map(x => x.marca).filter(Boolean), desc_tiendas: await descTiendas(), reglas: await reglas(), reglas_def: REGLAS_DEF, redondeo: PASO,
        escritura: !!erpWritePool, ia: !!(ia && process.env.GEMINI_API_KEY), nunca: NUNCA,
        rol: esMaestro(req) ? 'maestro' : 'editor', ve_costos: veCostos(req) });
    } catch (e) { err(res, e); }
  });

  app.put('/api/promo-desc-marca', ...mw, async (req, res) => {
    try {
      const marca = marcaDe(req.body.marca), pct = Number(req.body.pct);
      if (!marca || !(pct >= 0 && pct < 90)) return res.status(400).json({ error: 'Marca y % (0 a 89) requeridos' });
      await portalPool.query(`INSERT INTO promo_desc_marca (marca, pct) VALUES (?,?) ON DUPLICATE KEY UPDATE pct=VALUES(pct)`, [marca, pct]);
      res.json({ ok: true, desc_tiendas: await descTiendas() });
    } catch (e) { err(res, e); }
  });
  app.put('/api/promo-reglas', ...mw, async (req, res) => {
    try {
      const b = req.body || {};
      if (!Array.isArray(b.tramos) || !b.tramos.length) return res.status(400).json({ error: 'Define al menos un tramo' });
      const R = leerReglas(b);
      const ms = R.tramos.map(t => t.meses);
      if (new Set(ms).size !== ms.length) return res.status(400).json({ error: 'Hay dos tramos con los mismos meses' });
      await portalPool.query(`INSERT INTO promo_config (clave, valor) VALUES ('reglas', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [JSON.stringify(R)]);
      res.json({ ok: true, reglas: R });
    } catch (e) { err(res, e); }
  });
  app.delete('/api/promo-desc-marca/:marca', ...mw, async (req, res) => {
    try { await portalPool.query(`DELETE FROM promo_desc_marca WHERE marca=?`, [marcaDe(req.params.marca)]); res.json({ ok: true, desc_tiendas: await descTiendas() }); }
    catch (e) { err(res, e); }
  });

  app.post('/api/promo-propuesta', ...mw, async (req, res) => {
    try { res.json(await armarPropuesta(req.body || {})); } catch (e) { err(res, e); }
  });

  // Excel simple: SKU · NOMBRE · PRECIO PVP · PRECIO PVP OFERTA (+ hoja de detalle)
  async function excelPrecios(res, titulo, marca, filas, extraCab) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Precios');
    ws.columns = [{ header: 'SKU', key: 'sku', width: 20 }, { header: 'NOMBRE', key: 'nombre', width: 58 },
      { header: 'PRECIO PVP', key: 'lista', width: 14 }, { header: 'PRECIO PVP OFERTA', key: 'precio', width: 19 }];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
    filas.forEach(x => ws.addRow({ sku: x.sku, nombre: x.nombre, lista: Number(x.lista), precio: Number(x.precio) }));
    ['C', 'D'].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const wd = wb.addWorksheet('Detalle');
    const n = cabeceraExcel(wd, titulo, [['Marca', marca], ...extraCab], 11);
    const cols = [['SKU', 18], ['Nombre', 46], ['Precio lista', 12], ['Oferta antes', 12], ['Precio oferta', 13], ['Desc. %', 9],
      ['Tramo', 26], ['Piso (S/)', 11], ['Costo base 2 lotes (S/)', 16], ['Días en almacén', 13], ['Meses sin venta', 12], ['Capital (S/)', 13], ['A costo', 8], ['Razón', 40], ['Estado', 12]];
    cols.forEach((c, i) => wd.getColumn(i + 1).width = c[1]);
    const hr = wd.addRow(cols.map(c => c[0])); hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
    filas.forEach(x => wd.addRow([x.sku, x.nombre, Number(x.lista), x.oferta_actual ?? x.oferta_original ?? null, Number(x.precio),
      x.desc_real ?? (x.lista ? Math.round((1 - x.precio / x.lista) * 1000) / 10 : null), x.tramo || '', x.piso != null ? Number(x.piso) : null,
      x.costo_base != null ? Number(x.costo_base) : null, x.edad_dias ?? null, x.dias_sin_venta == null ? null : x.dias_sin_venta >= NUNCA ? 'nunca' : Math.round(x.dias_sin_venta / 30.4375 * 10) / 10, x.capital ?? null,
      x.a_costo ? 'Sí' : '', x.razon || '', x.estado || '']));
    [3, 4, 5, 8, 9, 12].forEach(c => wd.getColumn(c).numFmt = '#,##0.00');
    wd.views = [{ state: 'frozen', ySplit: n + 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('oferta-' + marca.toLowerCase())}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }

  // Excel de la propuesta (antes de guardar): recalcula en el servidor con las mismas elecciones
  app.post('/api/promo-propuesta-excel', ...mw, async (req, res) => {
    try {
      const b = req.body || {}, p = await armarPropuesta(b);
      const quitar = new Set((b.excluir || []).map(Number));
      const filas = p.items.filter(x => x.entra && !quitar.has(x.vid));
      await excelPrecios(res, 'Propuesta de oferta', p.marca, filas, [['Descuento a tiendas', p.desc_tienda + '%'], ['Redondeo', 'S/ ' + p.redondeo]]);
    } catch (e) { err(res, e); }
  });

  // Crear campaña (recalcula todo en el servidor; no confía en los precios del navegador)
  app.post('/api/promo-campanas', ...mw, async (req, res) => {
    try {
      const b = req.body || {};
      const ini = fechaLima(b.inicio, false), fin = fechaLima(b.fin, true);
      if (!ini || !fin) return res.status(400).json({ error: 'Fechas de inicio y fin requeridas (AAAA-MM-DD)' });
      if (fin <= ini || fin.getTime() <= Date.now()) return res.status(400).json({ error: 'La fecha de fin debe ser posterior al inicio y a hoy' });
      const p = await armarPropuesta({ ...b, usar_ia: false });   // los % ya vienen elegidos (de la IA o a mano) en desc_manual
      const quitar = new Set((b.excluir || []).map(Number));
      const filas = p.items.filter(x => x.entra && !quitar.has(x.vid));
      if (!filas.length) return res.status(400).json({ error: 'No hay SKUs para la campaña' });
      const razones = b.razones || {};
      const [r] = await portalPool.query(`INSERT INTO promo_campanas (nombre, marca, inicio, fin, desc_tienda, redondeo, origen, creado_por, nota)
        VALUES (?,?,?,?,?,?,?,?,?)`, [String(b.nombre || `Oferta ${p.marca}`).slice(0, 120), p.marca, ini, fin, p.desc_tienda, PASO,
        String(b.origen || p.origen).slice(0, 10), (req.admin && req.admin.usuario) || '', String(b.nota || '').slice(0, 400) || null]);
      const cid = r.insertId;
      // desc_pct = 95 significa "al piso" (así, si cambia el costo, sigue pegado al piso nuevo)
      await portalPool.query(`INSERT INTO promo_items (campana_id, vid, sku, nombre, lista, desc_pct, a_costo, razon, costo_base, costo_max, piso, precio, tramo, lote_ref, extremo_ok, alerta_costo, precio_manual) VALUES ?`,
        [filas.map(x => [cid, x.vid, x.sku, x.nombre.slice(0, 300), x.lista, x.desc_max != null && x.desc_pct >= x.desc_max - 0.05 ? 95 : x.desc_pct,
          x.a_costo ? 1 : 0, String(razones[x.vid] || x.razon || '').slice(0, 300), x.costo_base, x.costo_max, x.piso, x.precio,
          String(x.tramo || '').slice(0, 80), x.lote_ref, x.extremo_ok ? 1 : 0, String(x.alerta_costo || '').slice(0, 400) || null,
          /^Manual/.test(String(razones[x.vid] || '')) && !x.a_costo ? x.precio : null])]);
      let aplicado = null;
      if (ini.getTime() <= Date.now() && erpWritePool) {
        const [[c]] = await portalPool.query(`SELECT * FROM promo_campanas WHERE id=?`, [cid]);
        aplicado = await aplicarCampana(c);
      }
      res.json({ ok: true, id: cid, items: filas.length, aplicado, escritura: !!erpWritePool });
    } catch (e) { err(res, e); }
  });

  app.get('/api/promo-campanas', ...ver, async (req, res) => {
    try {
      const [cs] = await portalPool.query(`SELECT c.*,
          SUM(i.estado='activo') activos, SUM(i.estado='pendiente') pendientes, SUM(i.estado='restaurado') restaurados,
          SUM(i.estado='conflicto') conflictos, SUM(i.estado='omitido') omitidos, COUNT(i.id) items
        FROM promo_campanas c LEFT JOIN promo_items i ON i.campana_id = c.id
        GROUP BY c.id ORDER BY FIELD(c.estado,'activa','programada','terminada','cancelada'), c.inicio DESC LIMIT 200`);
      res.json({ campanas: cs, escritura: !!erpWritePool });
    } catch (e) { err(res, e); }
  });

  async function campana(id) {
    const [[c]] = await portalPool.query(`SELECT * FROM promo_campanas WHERE id=?`, [Number(id)]);
    if (!c) { const e = new Error('Campaña no encontrada'); e.status = 404; throw e; }
    return c;
  }
  app.get('/api/promo-campanas/:id', ...ver, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      const [items] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id=? ORDER BY estado, nombre`, [c.id]);
      const [lg] = await portalPool.query(`SELECT * FROM promo_log WHERE campana_id=? ORDER BY id DESC LIMIT 300`, [c.id]);
      res.json({ campana: c, items: veCostos(req) ? items : items.map(sinCostos), log: lg, rol: esMaestro(req) ? 'maestro' : 'editor' });
    } catch (e) { err(res, e); }
  });
  app.get('/api/promo-campanas/:id/excel', ...ver, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      const [items] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id=? AND estado IN ('pendiente','activo','restaurado') ORDER BY nombre`, [c.id]);
      const f = d => new Date(new Date(d).getTime() + TZ_LIMA * 3600e3).toISOString().slice(0, 10);
      await excelPrecios(res, c.nombre, c.marca, veCostos(req) ? items : items.map(sinCostos), [['Del', f(c.inicio)], ['Al', f(c.fin)], ['Estado', c.estado], ['Descuento a tiendas', Number(c.desc_tienda) + '%']]);
    } catch (e) { err(res, e); }
  });
  // Quitar un SKU de una campaña (si ya estaba aplicado, se devuelve su oferta)
  app.post('/api/promo-campanas/:id/quitar/:vid', ...ver, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      const [[it]] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id=? AND vid=?`, [c.id, Number(req.params.vid)]);
      if (!it) return res.status(404).json({ error: 'SKU no está en la campaña' });
      if (it.estado === 'activo') {
        const orig = it.oferta_original_guardada ? it.oferta_original : null;
        if (!(await escribirOferta(it.vid, orig, it.precio))) return res.status(409).json({ error: 'La oferta de ese SKU fue cambiada por otra persona; no se tocó' });
        await log(c.id, it.vid, 'quitar', it.precio, orig, 'Por ' + ((req.admin && req.admin.usuario) || '—'));
      }
      await marcar(it, it.estado === 'activo' ? 'restaurado' : 'omitido', 'Quitado a mano por ' + ((req.admin && req.admin.usuario) || '—'));
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
  // Cambiar el precio de oferta de un SKU de la campaña.
  //  Usuarios con 'inventario': solo SUBIRLO (menos descuento = más margen). Maestro: también bajarlo,
  //  sin pasar el piso y respetando el tope de seguridad. Se redondea hacia arriba a S/ 5.
  app.post('/api/promo-campanas/:id/precio/:vid', ...ver, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      if (!['programada', 'activa'].includes(c.estado)) return res.status(400).json({ error: 'La campaña ya terminó' });
      const [[it]] = await portalPool.query(`SELECT * FROM promo_items WHERE campana_id=? AND vid=? AND estado IN ('activo','pendiente')`, [c.id, Number(req.params.vid)]);
      if (!it) return res.status(404).json({ error: 'Ese SKU no está activo en la campaña' });
      const lista = Number(it.lista), actual = Number(it.precio);
      const nuevo = arriba(Number(req.body && req.body.precio) || 0);
      if (!(nuevo > 0)) return res.status(400).json({ error: 'Escribe un precio válido' });
      if (nuevo >= lista) return res.status(400).json({ error: `Con S/ ${nuevo} ya no hay descuento (lista S/ ${lista}). Para sacarlo de la oferta usa "Quitar".` });
      if (Math.abs(nuevo - actual) < 0.005) return res.json({ ok: true, precio: nuevo, sin_cambio: true });
      if (nuevo < actual) {
        if (!esMaestro(req)) return res.status(403).json({ error: 'Solo el administrador puede bajar un precio de oferta. Puedes subirlo o quitar el SKU.' });
        if (it.piso != null && nuevo < Number(it.piso)) return res.status(400).json({ error: `No puede bajar del piso S/ ${Number(it.piso)} (costo ÷ desc. a tiendas)` });
        const d = (1 - nuevo / lista) * 100;
        if (d > TOPE_SEGURIDAD && !Number(it.extremo_ok) && !(req.body && req.body.confirmar_tope))
          return res.status(409).json({ error: `−${Math.round(d * 10) / 10} % supera el tope de seguridad (${TOPE_SEGURIDAD} %). Confírmalo.`, requiere_confirmar: true });
      }
      const desc = Math.round((1 - nuevo / lista) * 10000) / 100;
      if (it.estado === 'activo') {
        if (!(await escribirOferta(it.vid, nuevo, it.precio))) return res.status(409).json({ error: 'La oferta de ese SKU fue cambiada por otra persona; no se tocó' });
      }
      await portalPool.query(`UPDATE promo_items SET precio=?, precio_manual=?, desc_pct=?, extremo_ok = GREATEST(extremo_ok, ?) WHERE id=?`,
        [nuevo, nuevo, desc, req.body && req.body.confirmar_tope ? 1 : 0, it.id]);
      await log(c.id, it.vid, nuevo > actual ? 'subir' : 'bajar', actual, nuevo, 'Por ' + ((req.admin && req.admin.usuario) || '—'));
      cacheOfertas = null;
      res.json({ ok: true, precio: nuevo });
    } catch (e) { err(res, e); }
  });
  app.post('/api/promo-campanas/:id/aplicar', ...mw, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      if (!['programada', 'activa'].includes(c.estado)) return res.status(400).json({ error: 'La campaña ya terminó' });
      if (!erpWritePool) return res.status(400).json({ error: 'Falta ERP_ESCRITURA_URL para escribir en el sistema' });
      await portalPool.query(`UPDATE promo_campanas SET inicio = LEAST(inicio, NOW()) WHERE id=?`, [c.id]);
      res.json(await aplicarCampana(c));
    } catch (e) { err(res, e); }
  });
  app.post('/api/promo-campanas/:id/terminar', ...mw, async (req, res) => {
    try {
      const c = await campana(req.params.id);
      if (c.estado === 'programada') {
        await portalPool.query(`UPDATE promo_items SET estado='omitido', nota='Campaña cancelada' WHERE campana_id=? AND estado='pendiente'`, [c.id]);
        await portalPool.query(`UPDATE promo_campanas SET estado='cancelada', terminada_en=NOW() WHERE id=?`, [c.id]);
        return res.json({ ok: true, cancelada: true });
      }
      if (c.estado !== 'activa') return res.status(400).json({ error: 'La campaña no está activa' });
      if (!erpWritePool) return res.status(400).json({ error: 'Falta ERP_ESCRITURA_URL para escribir en el sistema' });
      res.json(await terminarCampana(c));
    } catch (e) { err(res, e); }
  });

  return { prepararTablas, revisar, ofertasVigentes, limpiarCache: () => { cacheOfertas = null; } };
};

module.exports._test = { FACTOR_COSTO, arriba, costoBase, precioFijo, depurarLotes, precioPromo, tramoDe, leerReglas, REGLAS_DEF, fechaLima, NUNCA };
