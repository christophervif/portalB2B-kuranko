// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Funciones comunes (compartidas)
//  Helpers que usan varios módulos. Antes estaban duplicados en el index.js;
//  aquí viven en un solo lugar para no repetirlos y mantenerlos consistentes.
// ═══════════════════════════════════════════════════════════════════════════

// Empresas del negocio (por company_id)
const EMPRESAS_BI = { 1: 'Diseños Corporativos SAC', 2: 'Christopher Villasante F.' };

// Formatea fecha + hora en zona horaria de Lima (ej: "1/7/2026, 8:13:22 a. m.")
// Se usa en el reporte de pagos, donde importa la hora del pago.
const fechaHoraLima = (d) => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '';

// Formatea solo la fecha en zona horaria de Lima (ej: "1/7/2026")
// vacio: qué devolver cuando no hay fecha (por defecto '', algunos reportes usan '—')
const fechaLima = (d, vacio = '') => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : vacio;

// Formatea una fecha PURA (sin hora) tal cual, SIN conversión de zona horaria.
// Se usa para fechas de emisión de comprobantes, que la base guarda como '2026-07-01'
// (solo fecha). Convertirlas con zona horaria las retrasaría un día. Devuelve d/m/aaaa.
const fechaPura = (d, vacio = '') => {
  if (!d) return vacio;
  // Tomar solo la parte de fecha (antes de cualquier hora) y armar d/m/aaaa
  const s = String(d).slice(0, 10); // '2026-07-01'
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return vacio;
  return `${Number(m[3])}/${Number(m[2])}/${m[1]}`; // 1/7/2026
};

// Genera un nombre de archivo con marca de tiempo (ej: "pagos-20260812-1835")
function nombreTrazable(base) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${base}-${stamp}`;
}

// Fragmento SQL para filtrar por rango de fechas (BETWEEN desde y hasta)
// campo: la columna de fecha (por defecto s.created_at)
// Solo acepta fechas AAAA-MM-DD: cualquier otro texto se descarta para que nunca
// llegue al SQL (evita inyección SQL desde la URL).
const FECHA_SQL = /^\d{4}-\d{2}-\d{2}$/;
const rango = (desde, hasta, campo = 's.created_at') =>
  FECHA_SQL.test(String(desde || '')) && FECHA_SQL.test(String(hasta || ''))
    ? `AND ${campo} BETWEEN '${desde}' AND '${hasta} 23:59:59'` : '';

// Inserta la cabecera informativa (título, fecha de exportación, filtros) en las
// primeras filas de una hoja Excel. Devuelve cuántas filas ocupó (para congelar).
function cabeceraExcel(ws, titulo, filtrosPairs, numCols) {
  const ahora = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const r1 = ws.addRow(['Kuranko — ' + titulo]);
  r1.font = { bold: true, size: 14, color: { argb: 'FF000726' } };
  ws.mergeCells(1, 1, 1, Math.min(numCols, 6));
  const r2 = ws.addRow(['Exportado: ' + ahora]);
  r2.font = { size: 9, color: { argb: 'FF5A5A5A' } };
  const filtrosTxt = filtrosPairs.filter(([k, v]) => v).map(([k, v]) => `${k}: ${v}`).join('   ·   ') || 'Sin filtros';
  const r3 = ws.addRow(['Filtros — ' + filtrosTxt]);
  r3.font = { size: 9, color: { argb: 'FF5A5A5A' } };
  ws.addRow([]); // fila en blanco separadora
  return 4;
}

// Fragmentos SQL para calcular ganancia/margen con costo FIFO.
// Los comparten Ventas-BI (rentabilidad) e Inventario (análisis de margen).
const GANANCIA_NORMAL = `
  CASE WHEN si.stock_batch_id IS NOT NULL
       THEN (si.total - si.quantity * sb.cost_price)
       ELSE 0 END`;
const ES_NORMAL = `si.stock_batch_id IS NOT NULL`;
const ES_PEDIDO = `(si.stock_batch_id IS NULL AND si.is_backorder = 1)`;
const ES_FALLA  = `(si.stock_batch_id IS NULL AND si.is_backorder = 0)`;

// Arma "Producto — extra" evitando repetir el nombre cuando la variación ya lo contiene.
// La comparten Inventario y Promociones.
function nombreProdVar(producto, variacion) {
  const p = (producto || '').trim();
  const v = (variacion || '').trim();
  if (!v || v === p) return p || '—';
  if (v.toLowerCase().startsWith(p.toLowerCase())) {
    const extra = v.slice(p.length).replace(/^[\s,—-]+/, '').trim();
    return extra ? p + ' — ' + extra : p;
  }
  if (p.toLowerCase().includes(v.toLowerCase())) return p;
  return p + ' — ' + v;
}

// ── Catálogo de SKUs del ERP (solo lectura) COMPARTIDO ─────────────────────
//  Antes Importaciones, Recepciones y Seguimiento hacían cada uno la MISMA
//  consulta con su propia caché (hasta 3 consultas al ERP y 3 copias en memoria).
//  Ahora hay una sola caché de 10 min. Si llegan varias peticiones a la vez
//  mientras se lee, todas esperan la MISMA consulta (no se dispara 3 veces).
//  Devuelve [[sku, name], ...] — hijos y simples (los padres 'variable' no).
let _catSku = null, _catSkuAt = 0, _catSkuProm = null, _catSkuMap = null;
const CAT_SKU_TTL = 10 * 60 * 1000;
async function catalogoSku(prodPool, fresh) {
  if (!fresh && _catSku && (Date.now() - _catSkuAt) < CAT_SKU_TTL) return _catSku;
  if (_catSkuProm) return _catSkuProm;
  _catSkuProm = prodPool.query(`
      SELECT TRIM(sku) AS sku, name FROM product_variations
       WHERE product_type <> 'variable' AND deleted_at IS NULL
         AND sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY sku`)
    .then(([rows]) => {
      _catSku = rows.map(r => [r.sku, r.name || '']);
      _catSkuAt = Date.now();
      _catSkuMap = null; // se rearma bajo demanda
      return _catSku;
    })
    .finally(() => { _catSkuProm = null; });
  return _catSkuProm;
}
// Mapa sku → nombre (para poner el nombre a un SKU sin otra consulta).
async function nombrePorSku(prodPool) {
  const cat = await catalogoSku(prodPool);
  if (!_catSkuMap) { _catSkuMap = new Map(); cat.forEach(([s, n]) => _catSkuMap.set(s, n)); }
  return _catSkuMap;
}
// Responde el catálogo con caché del navegador (5 min). ?fresh=1 fuerza leer el ERP.
function rutaCatalogo(prodPool, etiqueta) {
  return async (req, res) => {
    try {
      const cat = await catalogoSku(prodPool, !!req.query.fresh);
      if (!req.query.fresh) res.set('Cache-Control', 'private, max-age=300');
      res.json(cat);
    } catch (e) {
      console.error('[' + etiqueta + '] catalogo', e.message);
      res.status(500).json({ error: 'No se pudo leer el catálogo' });
    }
  };
}

module.exports = { EMPRESAS_BI, fechaHoraLima, fechaLima, fechaPura, nombreTrazable, rango, cabeceraExcel, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA, nombreProdVar, catalogoSku, nombrePorSku, rutaCatalogo };
