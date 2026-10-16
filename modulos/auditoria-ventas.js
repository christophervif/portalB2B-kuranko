// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de ventas y compras
//
//  Busca incongruencias en los datos del ERP (solo lectura) y en los gastos del
//  portal: ventas a pérdida, líneas sin lote, cobros que no cuadran con la
//  venta, ventas eliminadas o canceladas con cobros o stock, ingresos de
//  mercadería duplicados o con costo atípico, gastos repetidos…
//
//  Cada hallazgo tiene una CLAVE estable ("v_perdida:linea:123") y una HUELLA
//  con sus montos. Al revisarlo se guarda la clave + la huella en la base del
//  PORTAL (tabla aud_vc_revisiones) y deja de mostrarse como pendiente. Si
//  después los montos cambian (otra huella), vuelve a salir como "cambió desde
//  la revisión". Reabrir borra la marca. Todo queda en aud_vc_historial.
//
//  Permiso: módulo 'auditoria_vc'. Pantalla: public/auditoria-ventas.html
//  (sub-pestaña "Auditoría" de Ventas y compras).
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreProdVar } = require('./comunes');

const REF_VENTA = 'App\\Models\\Sale';
const REF_ENTRADA = 'App\\Models\\StockEntry';
const CODIGOS_COMPRA = ['02', '18'];   // compra nacional e importación (igual que Ventas-BI y Gastos)
const DIAS_PEDIDO = 60;                // a pedido sin llegar después de estos días
const UMBRAL_COSTO = 0.5;              // costo de lote ±50 % frente al lote anterior
const MAX_FILAS = 500;                 // por revisión
const COD_TXT = { '02': 'Compra', '18': 'Importación' };

const r2 = n => Math.round((+n || 0) * 100) / 100;
const s2 = n => r2(n).toFixed(2);
const soles = n => 'S/ ' + r2(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaTxt = f => f ? String(f).slice(0, 10).split('-').reverse().join('/') : '';
const recortar = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
// Fecha-hora de Lima (UTC-5, sin horario de verano) a partir de segundos Unix
const limaTxt = ts => ts == null ? '' : new Date(+ts * 1000 - 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const CLAVE_OK = /^[a-z_]+:[A-Za-z0-9:._-]{1,90}$/;

// Fragmentos SQL comunes
const PROD = `JOIN product_variations pv ON pv.id = si.product_variation_id
  JOIN products p ON p.id = pv.product_id`;
const CLIENTE = `COALESCE(NULLIF(TRIM(pa.business_name),''), TRIM(CONCAT(COALESCE(pa.first_name,''),' ',COALESCE(pa.last_name,''))))`;
const PAGOS = `(SELECT sale_id, SUM(amount) AS pagado, COUNT(*) AS n FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id)`;
const LOTE_DE_ENTRADA = `LEFT JOIN stock_batches sb ON sb.id = (
    SELECT b.id FROM stock_batches b
    WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id
    ORDER BY b.id LIMIT 1)`;

// ── Las revisiones ──────────────────────────────────────────────────────────
// Cada una: id, grupo, título, qué significa y cómo se corrige, qué es el monto,
// y cargar(ctx) → filas crudas; item(fila) → { clave, ref, fecha, empresa,
// texto, detalle, monto, huella }.
function revisiones(VV) {
  const vivas = `s.deleted_at IS NULL AND s.status IN ${VV}`;
  const prod = r => nombreProdVar(r.producto, r.variacion);
  return [
    // ─────────────── VENTAS ───────────────
    {
      id: 'v_perdida', grupo: 'Ventas', titulo: 'Vendidas por debajo del costo',
      ayuda: 'Líneas cuyo precio de venta es menor que el costo del lote asignado. Puede ser un descuento hecho a propósito, o un lote con el costo mal cargado (por ejemplo en dólares o con otro IGV): en ese caso corrige el costo del lote.',
      monto: 'Pérdida',
      sql: `SELECT si.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          p.name AS producto, pv.name AS variacion, pv.sku, si.quantity AS cant, si.total,
          sb.cost_price AS costo_unit, sb.id AS lote
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN stock_batches sb ON sb.id = si.stock_batch_id ${PROD}
        WHERE ${vivas} AND si.total < si.quantity * sb.cost_price - 0.005
        ORDER BY (si.quantity * sb.cost_price - si.total) DESC LIMIT ${MAX_FILAS}`,
      item: r => {
        const costo = +r.cant * +r.costo_unit, perdida = costo - +r.total;
        const pct = +r.total > 0 ? (+r.total - costo) / +r.total * 100 : null;
        return { clave: 'linea:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
          detalle: `${+r.cant} u. vendidas en ${soles(r.total)} · costo ${soles(costo)} (lote ${r.lote}, ${soles(r.costo_unit)} c/u)` +
            (pct != null ? ` · margen ${pct.toFixed(1)} %` : ''),
          monto: r2(perdida), huella: `${s2(r.total)}|${s2(r.costo_unit)}|${+r.cant}|${r.lote}` };
      }
    },
    {
      id: 'v_sin_lote', grupo: 'Ventas', titulo: 'Líneas sin lote ni marca "a pedido"',
      ayuda: 'No tienen lote asignado y no están marcadas como pedido: no toman costo (quedan fuera del margen) y quizá no descontaron stock. Asigna el lote que corresponde; si no descontaron stock y el producto ya no está, haz además un ajuste de salida.',
      monto: 'Vendido',
      sql: `SELECT si.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          p.name AS producto, pv.name AS variacion, pv.sku, si.quantity AS cant, si.total,
          (SELECT GROUP_CONCAT(CONCAT(b.id, ' (', DATE_FORMAT(b.entry_date, '%d/%m/%y'), ', queda ', b.quantity, ')')
             ORDER BY b.entry_date SEPARATOR ' · ')
           FROM stock_batches b WHERE b.product_variation_id = si.product_variation_id) AS lotes
        FROM sale_items si JOIN sales s ON s.id = si.sale_id ${PROD}
        WHERE ${vivas} AND si.stock_batch_id IS NULL AND si.is_backorder = 0
        ORDER BY s.created_at DESC LIMIT ${MAX_FILAS}`,
      item: r => {
        const lotes = String(r.lotes || '').split(' · ').filter(Boolean);
        return { clave: 'linea:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
          detalle: `${+r.cant} u. · línea ${r.id} · ` + (lotes.length
            ? 'lotes del producto: ' + lotes.slice(0, 4).join(' · ') + (lotes.length > 4 ? ` y ${lotes.length - 4} más` : '')
            : 'el producto no tiene lotes'),
          monto: r2(r.total), huella: `${s2(r.total)}|${+r.cant}` };
      }
    },
    {
      id: 'v_pedido_antiguo', grupo: 'Ventas', titulo: `A pedido hace más de ${DIAS_PEDIDO} días`,
      ayuda: 'Líneas marcadas "a pedido" que siguen sin lote. Si "llegó" tiene fecha, el producto ya ingresó y solo falta asignarle el lote (su costo y ganancia siguen pendientes). Si no, el pedido está atrasado.',
      monto: 'Vendido',
      sql: `SELECT si.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          p.name AS producto, pv.name AS variacion, pv.sku, si.quantity AS cant, si.total,
          DATEDIFF(NOW(), s.created_at) AS dias,
          (SELECT DATE_FORMAT(MIN(b.entry_date), '%Y-%m-%d') FROM stock_batches b
           WHERE b.product_variation_id = si.product_variation_id AND b.entry_date >= DATE(s.created_at)) AS llego
        FROM sale_items si JOIN sales s ON s.id = si.sale_id ${PROD}
        WHERE ${vivas} AND si.stock_batch_id IS NULL AND si.is_backorder = 1
          AND s.created_at < NOW() - INTERVAL ${DIAS_PEDIDO} DAY
        ORDER BY s.created_at LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'linea:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
        detalle: `${+r.cant} u. · ${r.dias} días · ` + (r.llego ? `ya ingresó stock el ${fechaTxt(r.llego)}: falta asignar el lote` : 'aún no ingresa stock de este producto'),
        monto: r2(r.total), huella: `${s2(r.total)}|${r.llego || ''}` })
    },
    {
      id: 'v_lote_otro', grupo: 'Ventas', titulo: 'Línea con lote de otro producto',
      ayuda: 'El lote asignado pertenece a otro producto: el costo y el stock se descontaron del producto equivocado.',
      monto: 'Vendido',
      sql: `SELECT si.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          p.name AS producto, pv.name AS variacion, pv.sku, si.quantity AS cant, si.total,
          sb.id AS lote, pv2.sku AS sku_lote
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN stock_batches sb ON sb.id = si.stock_batch_id
        JOIN product_variations pv2 ON pv2.id = sb.product_variation_id ${PROD}
        WHERE ${vivas} AND sb.product_variation_id <> si.product_variation_id
        ORDER BY s.created_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'linea:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
        detalle: `${+r.cant} u. · lote ${r.lote} es del SKU ${r.sku_lote}`,
        monto: r2(r.total), huella: `${r.lote}|${s2(r.total)}` })
    },

    // ─────────────── COBROS ───────────────
    {
      id: 'c_pagada_saldo', grupo: 'Cobros', titulo: 'Ventas "pagadas" a las que les falta cobro',
      ayuda: 'Están en estado pagada pero sus cobros vigentes suman menos que el total. Cuentas por cobrar no las muestra porque ignora las pagadas. Registra el cobro que falta, o corrige el total si hubo un descuento.',
      monto: 'Falta',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha, s.total,
          COALESCE(p.pagado, 0) AS pagado, ${CLIENTE} AS cliente
        FROM sales s LEFT JOIN ${PAGOS} p ON p.sale_id = s.id
        LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status = 'paid' AND s.total - COALESCE(p.pagado, 0) > 0.01
        ORDER BY s.total - COALESCE(p.pagado, 0) DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: r.cliente || '(sin cliente)',
        detalle: `total ${soles(r.total)} · cobrado ${soles(r.pagado)}`,
        monto: r2(+r.total - +r.pagado), huella: `${s2(r.total)}|${s2(r.pagado)}` })
    },
    {
      id: 'c_de_mas', grupo: 'Cobros', titulo: 'Ventas cobradas de más',
      ayuda: 'Los cobros vigentes suman más que el total de la venta. O falta anular un cobro duplicado, o el exceso es saldo a favor del cliente.',
      monto: 'Exceso',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha, s.total,
          p.pagado, p.n, ${CLIENTE} AS cliente
        FROM sales s JOIN ${PAGOS} p ON p.sale_id = s.id
        LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE ${vivas} AND p.pagado - s.total > 0.01
        ORDER BY p.pagado - s.total DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: r.cliente || '(sin cliente)',
        detalle: `total ${soles(r.total)} · cobrado ${soles(r.pagado)} en ${r.n} cobro${+r.n === 1 ? '' : 's'}`,
        monto: r2(+r.pagado - +r.total), huella: `${s2(r.total)}|${s2(r.pagado)}` })
    },
    {
      id: 'c_cancelada_cobro', grupo: 'Cobros', titulo: 'Ventas canceladas con cobros vigentes',
      ayuda: 'La venta está cancelada pero sus cobros no se anularon: siguen sumando en Ingresos, Métodos de pago y el flujo de caja. Anula los cobros, o pásalos a saldo a favor si el cliente dejó el dinero.',
      monto: 'Cobros',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha, s.total,
          p.pagado, p.n, ${CLIENTE} AS cliente
        FROM sales s JOIN ${PAGOS} p ON p.sale_id = s.id
        LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status = 'cancelled'
        ORDER BY s.created_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: r.cliente || '(sin cliente)',
        detalle: `${r.n} cobro${+r.n === 1 ? '' : 's'} sin anular · venta de ${soles(r.total)}`,
        monto: r2(r.pagado), huella: `${s2(r.pagado)}|${r.n}` })
    },
    {
      id: 'c_eliminada_cobro', grupo: 'Cobros', titulo: 'Ventas eliminadas con cobros vigentes',
      ayuda: 'La venta se eliminó (no se ve en el ERP) pero sus cobros siguen vigentes. Para corregirla hay que restaurarla (quitar la marca de eliminada), anular los cobros y cancelarla desde el ERP.',
      monto: 'Cobros',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          DATE_FORMAT(s.deleted_at, '%Y-%m-%d') AS borrada, s.total, p.pagado, p.n, ${CLIENTE} AS cliente
        FROM sales s JOIN ${PAGOS} p ON p.sale_id = s.id
        LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE s.deleted_at IS NOT NULL
        ORDER BY s.deleted_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: r.cliente || '(sin cliente)',
        detalle: `eliminada el ${fechaTxt(r.borrada)} · ${r.n} cobro${+r.n === 1 ? '' : 's'} sin anular`,
        monto: r2(r.pagado), huella: `${s2(r.pagado)}|${r.n}` })
    },
    {
      id: 'c_futuro', grupo: 'Cobros', titulo: 'Cobros con fecha futura',
      ayuda: 'Cobros fechados después de hoy: probablemente un error al escribir la fecha. Inflan los ingresos de un mes que aún no llega.',
      monto: 'Cobro',
      sql: `SELECT sp.id, s.code, s.company_id, DATE_FORMAT(sp.paid_at, '%Y-%m-%d') AS fecha, sp.amount, ${CLIENTE} AS cliente
        FROM sale_payments sp LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE sp.voided_at IS NULL AND sp.paid_at > NOW() + INTERVAL 1 DAY
        ORDER BY sp.paid_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'pago:' + r.id, ref: r.code || '(sin venta)', fecha: r.fecha, empresa: r.company_id, texto: r.cliente || '—',
        detalle: `cobro ${r.id} fechado el ${fechaTxt(r.fecha)}`, monto: r2(r.amount), huella: `${s2(r.amount)}|${r.fecha}` })
    },

    // ─────────────── STOCK ───────────────
    {
      id: 's_eliminada_stock', grupo: 'Stock', titulo: 'Ventas eliminadas con stock descontado',
      ayuda: 'Ventas eliminadas que tenían lotes asignados. Eliminar no devuelve el stock: si los productos siguen en la tienda, el sistema muestra de menos. Revisa el físico y, si corresponde, haz un ajuste de entrada (o restaura y cancela la venta).',
      monto: 'Vendido',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha,
          DATE_FORMAT(s.deleted_at, '%Y-%m-%d') AS borrada, COUNT(*) AS lineas, SUM(si.quantity) AS unidades, SUM(si.total) AS total
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.deleted_at IS NOT NULL AND si.stock_batch_id IS NOT NULL
        GROUP BY s.id, s.code, s.company_id, s.created_at, s.deleted_at
        ORDER BY s.deleted_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id, texto: `${+r.unidades} u. en ${r.lineas} línea${+r.lineas === 1 ? '' : 's'}`,
        detalle: `eliminada el ${fechaTxt(r.borrada)}`, monto: r2(r.total), huella: `${+r.unidades}|${s2(r.total)}` })
    },
    {
      id: 's_lote_negativo', grupo: 'Stock', titulo: 'Lotes con existencia negativa',
      ayuda: 'Se vendió más de lo que entró en ese lote. Suele ser una venta asignada al lote equivocado o un ingreso registrado con menos unidades.',
      monto: 'Unidades', unidad: 'u',
      sql: `SELECT sb.id, sb.company_id, DATE_FORMAT(sb.entry_date, '%Y-%m-%d') AS fecha, sb.quantity,
          p.name AS producto, pv.name AS variacion, pv.sku
        FROM stock_batches sb JOIN product_variations pv ON pv.id = sb.product_variation_id
        JOIN products p ON p.id = pv.product_id
        WHERE sb.quantity < 0 ORDER BY sb.quantity LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'lote:' + r.id, ref: 'Lote ' + r.id, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
        detalle: `queda ${+r.quantity} en el lote`, monto: +r.quantity, huella: String(+r.quantity) })
    },
    {
      id: 's_mov_huerfano', grupo: 'Stock', titulo: 'Salidas de stock de ventas que ya no existen',
      ayuda: 'Movimientos de salida que apuntan a una venta borrada de la base (no aparece ni como eliminada). Suelen ser restos de la migración: si el stock de esos productos cuadra con la tienda, basta con marcarlo como revisado.',
      monto: 'Unidades', unidad: 'u',
      sql: `SELECT sm.reference_id AS venta_id, COUNT(*) AS movimientos, SUM(ABS(sm.quantity)) AS unidades,
          GROUP_CONCAT(DISTINCT pv.sku ORDER BY pv.sku SEPARATOR ', ') AS skus,
          DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha
        FROM stock_movements sm
        LEFT JOIN sales s ON s.id = sm.reference_id
        LEFT JOIN product_variations pv ON pv.id = sm.product_variation_id
        WHERE sm.reference_type = ? AND s.id IS NULL
        GROUP BY sm.reference_id ORDER BY sm.reference_id LIMIT ${MAX_FILAS}`,
      params: [REF_VENTA],
      item: r => ({ clave: 'venta-inexistente:' + r.venta_id, ref: 'Venta id ' + r.venta_id, fecha: r.fecha, empresa: null,
        texto: r.skus || '—', detalle: `${r.movimientos} movimiento${+r.movimientos === 1 ? '' : 's'}` + (r.fecha ? '' : ' sin fecha (migración)'),
        monto: +r.unidades, huella: `${r.movimientos}|${+r.unidades}` })
    },
    {
      id: 'd_sin_empresa_cliente', grupo: 'Ventas', titulo: 'Ventas sin empresa o sin cliente',
      ayuda: 'Ventas sin una empresa válida (Diseños o Christopher) o sin cliente: se pierden al filtrar por empresa y en B2B/B2C.',
      monto: 'Total',
      sql: `SELECT s.id, s.code, s.company_id, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS fecha, s.total,
          pa.id AS cliente_id
        FROM sales s LEFT JOIN parties pa ON pa.id = s.customer_id
        WHERE ${vivas} AND (s.company_id IS NULL OR s.company_id NOT IN (${Object.keys(EMPRESAS_BI).join(',')}) OR pa.id IS NULL)
        ORDER BY s.created_at DESC LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'venta:' + r.id, ref: r.code, fecha: r.fecha, empresa: r.company_id,
        texto: [!EMPRESAS_BI[r.company_id] ? 'sin empresa válida' : '', !r.cliente_id ? 'sin cliente' : ''].filter(Boolean).join(' · '),
        detalle: '', monto: r2(r.total), huella: `${r.company_id || ''}|${r.cliente_id || ''}` })
    },

    // ─────────────── COMPRAS (mercadería) ───────────────
    {
      id: 'm_doc_duplicado', grupo: 'Compras', titulo: 'Ingresos con el mismo documento',
      ayuda: 'Dos o más ingresos de compra o importación con el mismo N° de factura o guía. Puede ser una recepción en partes (correcto) o la misma factura ingresada dos veces (duplica stock y compras).',
      monto: 'Costo',
      sql: `SELECT se.id, UPPER(TRIM(se.reference_number)) AS doc, se.operation_type_code AS codigo,
          DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha, MAX(sb.company_id) AS company_id,
          COUNT(DISTINCT sm.product_variation_id) AS productos, COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS total
        FROM stock_entries se
        JOIN (SELECT UPPER(TRIM(reference_number)) AS d FROM stock_entries
              WHERE operation_type_code IN (?) AND TRIM(COALESCE(reference_number, '')) <> ''
              GROUP BY d HAVING COUNT(*) > 1) dup ON dup.d = UPPER(TRIM(se.reference_number))
        LEFT JOIN stock_movements sm ON sm.reference_id = se.id AND sm.reference_type = ?
        ${LOTE_DE_ENTRADA}
        WHERE se.operation_type_code IN (?)
        GROUP BY se.id, se.reference_number, se.operation_type_code
        ORDER BY doc, se.id LIMIT ${MAX_FILAS}`,
      params: [CODIGOS_COMPRA, REF_ENTRADA, CODIGOS_COMPRA],
      despues: items => {   // "también en el ingreso #…"
        const porDoc = {};
        items.forEach(i => { (porDoc[i._doc] = porDoc[i._doc] || []).push(i._id); });
        items.forEach(i => { const otros = porDoc[i._doc].filter(x => x !== i._id);
          i.detalle += otros.length ? ` · también en el ingreso ${otros.map(x => '#' + x).join(', ')}` : ''; });
      },
      item: r => ({ clave: 'ingreso:' + r.id, ref: 'Ingreso #' + r.id, fecha: r.fecha, empresa: r.company_id,
        texto: 'Documento ' + r.doc, detalle: `${COD_TXT[r.codigo] || r.codigo} · ${r.productos} producto${+r.productos === 1 ? '' : 's'}`,
        monto: r2(r.total), huella: s2(r.total), _doc: r.doc, _id: r.id })
    },
    {
      id: 'm_sin_documento', grupo: 'Compras', titulo: 'Ingresos de compra sin documento',
      ayuda: 'Ingresos de compra o importación sin N° de factura o guía: no se pueden cruzar con la factura del proveedor ni con Importaciones.',
      monto: 'Costo',
      sql: `SELECT se.id, se.operation_type_code AS codigo, DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha,
          MAX(sb.company_id) AS company_id, COUNT(DISTINCT sm.product_variation_id) AS productos,
          COALESCE(SUM(ABS(sm.quantity) * sb.cost_price), 0) AS total
        FROM stock_entries se
        LEFT JOIN stock_movements sm ON sm.reference_id = se.id AND sm.reference_type = ?
        ${LOTE_DE_ENTRADA}
        WHERE se.operation_type_code IN (?) AND TRIM(COALESCE(se.reference_number, '')) = ''
        GROUP BY se.id, se.operation_type_code
        ORDER BY se.id DESC LIMIT ${MAX_FILAS}`,
      params: [REF_ENTRADA, CODIGOS_COMPRA],
      item: r => ({ clave: 'ingreso:' + r.id, ref: 'Ingreso #' + r.id, fecha: r.fecha, empresa: r.company_id,
        texto: COD_TXT[r.codigo] || r.codigo, detalle: `${r.productos} producto${+r.productos === 1 ? '' : 's'}`,
        monto: r2(r.total), huella: s2(r.total) })
    },
    {
      id: 'm_sin_lote', grupo: 'Compras', titulo: 'Productos ingresados sin lote',
      ayuda: 'El ingreso registró unidades de un producto pero no creó su lote: no tienen costo, no cuentan en Compras y el FIFO no puede usarlas.',
      monto: 'Unidades', unidad: 'u',
      sql: `SELECT se.id, pv.id AS pv_id, pv.sku, p.name AS producto, pv.name AS variacion, se.operation_type_code AS codigo,
          DATE_FORMAT(MIN(sm.movement_date), '%Y-%m-%d') AS fecha, SUM(ABS(sm.quantity)) AS unidades
        FROM stock_movements sm
        JOIN stock_entries se ON se.id = sm.reference_id
        JOIN product_variations pv ON pv.id = sm.product_variation_id
        JOIN products p ON p.id = pv.product_id
        WHERE sm.reference_type = ? AND se.operation_type_code IN (?)
          AND NOT EXISTS (SELECT 1 FROM stock_batches b WHERE b.stock_entry_id = se.id AND b.product_variation_id = sm.product_variation_id)
        GROUP BY se.id, pv.id, pv.sku, p.name, pv.name, se.operation_type_code
        ORDER BY se.id DESC LIMIT ${MAX_FILAS}`,
      params: [REF_ENTRADA, CODIGOS_COMPRA],
      item: r => ({ clave: `ingreso:${r.id}:${r.pv_id}`, ref: 'Ingreso #' + r.id, fecha: r.fecha, empresa: null, texto: prod(r), sku: r.sku,
        detalle: COD_TXT[r.codigo] || r.codigo, monto: +r.unidades, huella: String(+r.unidades) })
    },
    {
      id: 'm_costo_atipico', grupo: 'Compras', titulo: `Costo de lote ${Math.round(UMBRAL_COSTO * 100)} % distinto al anterior`,
      ayuda: 'El costo unitario del lote se aleja mucho del lote anterior del mismo producto. Puede ser un cambio real de precio, o un error de carga (costo en dólares, sin IGV, por caja en vez de por unidad). Un costo mal cargado produce ventas "a pérdida" falsas o márgenes inflados.',
      monto: 'Variación', unidad: '%',
      sql: `SELECT x.id, x.company_id, DATE_FORMAT(x.entry_date, '%Y-%m-%d') AS fecha, x.cost_price, x.quantity,
          pb.id AS prev_id, pb.cost_price AS prev_costo, DATE_FORMAT(pb.entry_date, '%Y-%m-%d') AS prev_fecha,
          p.name AS producto, pv.name AS variacion, pv.sku
        FROM (SELECT sb.id, sb.product_variation_id, sb.cost_price, sb.entry_date, sb.company_id, sb.quantity,
                (SELECT b2.id FROM stock_batches b2
                 WHERE b2.product_variation_id = sb.product_variation_id AND b2.id <> sb.id AND b2.cost_price > 0
                   AND (b2.entry_date < sb.entry_date OR (b2.entry_date = sb.entry_date AND b2.id < sb.id))
                 ORDER BY b2.entry_date DESC, b2.id DESC LIMIT 1) AS prev_id
              FROM stock_batches sb WHERE sb.cost_price > 0) x
        JOIN stock_batches pb ON pb.id = x.prev_id
        JOIN product_variations pv ON pv.id = x.product_variation_id
        JOIN products p ON p.id = pv.product_id
        WHERE x.cost_price > pb.cost_price * ${1 + UMBRAL_COSTO} OR x.cost_price < pb.cost_price / ${1 + UMBRAL_COSTO}
        ORDER BY x.entry_date DESC LIMIT ${MAX_FILAS}`,
      item: r => {
        const v = (+r.cost_price - +r.prev_costo) / +r.prev_costo * 100;
        return { clave: 'lote:' + r.id, ref: 'Lote ' + r.id, fecha: r.fecha, empresa: r.company_id, texto: prod(r), sku: r.sku,
          detalle: `${soles(r.cost_price)} c/u vs ${soles(r.prev_costo)} del lote ${r.prev_id} (${fechaTxt(r.prev_fecha)}) · ${+r.quantity} u. en el lote`,
          monto: Math.round(v * 10) / 10, huella: `${s2(r.cost_price)}|${s2(r.prev_costo)}` };
      }
    },

    // ─────────────── GASTOS (portal) ───────────────
    {
      id: 'g_duplicado', grupo: 'Gastos', titulo: 'Gastos posiblemente duplicados',
      ayuda: 'Gastos con la misma fecha, empresa, categoría, proveedor y monto. Si es el mismo pago anotado dos veces, elimina uno en Compras y gastos.',
      monto: 'Monto', portal: true,
      sql: `SELECT g.id, DATE_FORMAT(g.fecha, '%Y-%m-%d') AS fecha, g.company_id, g.monto_pen, g.proveedor, g.descripcion,
          g.cuenta_nombre, c.nombre AS categoria
        FROM gas_gastos g
        JOIN (SELECT fecha, company_id, categoria_id, monto_pen, LOWER(TRIM(proveedor)) AS pr
              FROM gas_gastos WHERE borrado_en IS NULL
              GROUP BY fecha, company_id, categoria_id, monto_pen, pr HAVING COUNT(*) > 1) d
          ON d.fecha = g.fecha AND d.company_id = g.company_id AND d.categoria_id = g.categoria_id
         AND d.monto_pen = g.monto_pen AND d.pr = LOWER(TRIM(g.proveedor))
        LEFT JOIN gas_categorias c ON c.id = g.categoria_id
        WHERE g.borrado_en IS NULL
        ORDER BY g.fecha DESC, g.id LIMIT ${MAX_FILAS}`,
      item: r => ({ clave: 'gasto:' + r.id, ref: 'Gasto #' + r.id, fecha: r.fecha, empresa: r.company_id,
        texto: [r.categoria, r.proveedor].filter(Boolean).join(' · ') || '—',
        detalle: [r.descripcion, r.cuenta_nombre ? 'pagado con ' + r.cuenta_nombre : ''].filter(Boolean).join(' · '),
        monto: r2(r.monto_pen), huella: s2(r.monto_pen) })
    },
  ];
}

module.exports = function registrarAuditoriaVentas({ app, authAdmin, requiereModulo, prodPool, portalPool, VV }) {
  const mAud = requiereModulo('auditoria_vc');
  const REVISIONES = revisiones(VV);
  const usuarioDe = req => (req.admin && req.admin.usuario) || 'admin';

  let _listo = null;
  function prepararTablas() {
    if (_listo) return _listo;
    _listo = (async () => {
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS aud_vc_revisiones (
          clave VARCHAR(120) NOT NULL PRIMARY KEY,
          revision VARCHAR(40) NOT NULL,
          huella VARCHAR(255) NOT NULL DEFAULT '',
          resumen VARCHAR(400) NOT NULL DEFAULT '',
          nota VARCHAR(300) NOT NULL DEFAULT '',
          usuario VARCHAR(60) NOT NULL DEFAULT '',
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS aud_vc_historial (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          clave VARCHAR(120) NOT NULL,
          accion VARCHAR(12) NOT NULL,
          huella VARCHAR(255) NOT NULL DEFAULT '',
          resumen VARCHAR(400) NOT NULL DEFAULT '',
          nota VARCHAR(300) NOT NULL DEFAULT '',
          usuario VARCHAR(60) NOT NULL DEFAULT '',
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX (clave)
        )`);
    })().catch(e => { _listo = null; throw e; });
    return _listo;
  }

  // Corre una revisión; un error en una no tumba las demás.
  async function correr(rv) {
    try {
      const pool = rv.portal ? portalPool : prodPool;
      const [filas] = await pool.query(rv.sql, rv.params || []);
      const items = filas.map(f => { const it = rv.item(f); it.clave = rv.id + ':' + it.clave; it.empresa = it.empresa == null ? null : +it.empresa; return it; });
      if (rv.despues) rv.despues(items);
      items.forEach(i => { delete i._doc; delete i._id; });
      return { items, truncado: filas.length >= MAX_FILAS };
    } catch (e) {
      // Tabla de gastos aún no creada (nadie abrió Compras y gastos): sin hallazgos
      if (rv.portal && e.code === 'ER_NO_SUCH_TABLE') return { items: [], truncado: false };
      return { items: [], truncado: false, error: e.message };
    }
  }

  // Une los hallazgos con las marcas guardadas
  function combinar(rv, res, marcas) {
    const items = res.items.map(it => {
      const m = marcas.get(it.clave);
      let estado = 'pendiente', revision = null;
      if (m) {
        revision = { usuario: m.usuario, fecha: m.fecha, nota: m.nota, resumen: m.resumen };
        estado = m.huella === it.huella ? 'revisado' : 'cambio';
      }
      return { ...it, estado, revision };
    });
    const pend = items.filter(i => i.estado !== 'revisado');
    return { id: rv.id, grupo: rv.grupo, titulo: rv.titulo, ayuda: rv.ayuda, monto: rv.monto, unidad: rv.unidad || 'S/',
      items, pendientes: pend.length, revisados: items.length - pend.length,
      monto_pendiente: rv.unidad ? null : r2(pend.reduce((a, i) => a + (+i.monto || 0), 0)),
      truncado: res.truncado, error: res.error || null };
  }

  app.get('/api/auditoria-vc', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const [[resultados], [marcasRows]] = await Promise.all([
        Promise.all(REVISIONES.map(correr)).then(r => [r]),
        portalPool.query(`SELECT clave, huella, resumen, nota, usuario, UNIX_TIMESTAMP(fecha) AS ts FROM aud_vc_revisiones`)
      ]);
      const marcas = new Map(marcasRows.map(m => [m.clave, { ...m, fecha: limaTxt(m.ts) }]));
      res.json({
        generado: new Date().toISOString(),
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })),
        revisiones: REVISIONES.map((rv, i) => combinar(rv, resultados[i], marcas))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Marcar como revisados. Cuerpo: { items: [{clave, huella, resumen}], nota }
  app.post('/api/auditoria-vc/revisar', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const b = req.body || {};
      const nota = recortar(b.nota, 300), usuario = usuarioDe(req);
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 1000)
        .filter(x => x && CLAVE_OK.test(String(x.clave || '')) && REVISIONES.some(rv => String(x.clave).startsWith(rv.id + ':')));
      if (!items.length) return res.status(400).json({ error: 'No hay hallazgos válidos para marcar' });
      for (const x of items) {
        const clave = String(x.clave), huella = recortar(x.huella, 255), resumen = recortar(x.resumen, 400);
        const revision = clave.split(':')[0];
        await portalPool.query(`INSERT INTO aud_vc_revisiones (clave, revision, huella, resumen, nota, usuario) VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE huella = VALUES(huella), resumen = VALUES(resumen), nota = VALUES(nota), usuario = VALUES(usuario), fecha = CURRENT_TIMESTAMP`,
          [clave, revision, huella, resumen, nota, usuario]);
        await portalPool.query(`INSERT INTO aud_vc_historial (clave, accion, huella, resumen, nota, usuario) VALUES (?, 'revisado', ?, ?, ?, ?)`,
          [clave, huella, resumen, nota, usuario]);
      }
      res.json({ ok: true, marcados: items.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reabrir (vuelve a pendiente). Cuerpo: { claves: [...] }
  app.post('/api/auditoria-vc/reabrir', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const claves = (Array.isArray((req.body || {}).claves) ? req.body.claves : []).map(String).filter(c => CLAVE_OK.test(c)).slice(0, 1000);
      if (!claves.length) return res.status(400).json({ error: 'Nada que reabrir' });
      const usuario = usuarioDe(req);
      for (const c of claves) {
        const [r] = await portalPool.query(`DELETE FROM aud_vc_revisiones WHERE clave = ?`, [c]);
        if (r.affectedRows) await portalPool.query(`INSERT INTO aud_vc_historial (clave, accion, usuario) VALUES (?, 'reabierto', ?)`, [c, usuario]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Historial de un hallazgo (quién lo marcó o reabrió y cuándo)
  app.get('/api/auditoria-vc/historial', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const clave = String(req.query.clave || '');
      if (!CLAVE_OK.test(clave)) return res.status(400).json({ error: 'Clave inválida' });
      const [rows] = await portalPool.query(`SELECT accion, nota, resumen, usuario, UNIX_TIMESTAMP(fecha) AS ts
        FROM aud_vc_historial WHERE clave = ? ORDER BY id DESC LIMIT 50`, [clave]);
      res.json(rows.map(({ ts, ...r }) => ({ ...r, fecha: limaTxt(ts) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { _test: { REVISIONES, combinar, correr } };
};

module.exports._test = { revisiones, CLAVE_OK };
