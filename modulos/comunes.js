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
const rango = (desde, hasta, campo = 's.created_at') =>
  desde && hasta ? `AND ${campo} BETWEEN '${desde}' AND '${hasta} 23:59:59'` : '';

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

module.exports = { EMPRESAS_BI, fechaHoraLima, fechaLima, fechaPura, nombreTrazable, rango, cabeceraExcel, GANANCIA_NORMAL, ES_NORMAL, ES_PEDIDO, ES_FALLA };
