// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Cuentas por cobrar (deudas de clientes)  — permiso: cuentas_cobrar
//  Frontend: public/cuentas-por-cobrar.html (iframe en el panel).
//  (Antes vivía dentro de modulos/clientes-bi.js; se separó sin cambiar lógica.)
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel } = require('./comunes');

module.exports = function registrarCuentasCobrar({ app, authAdmin, mCxc, prodPool }) {

  // Calcula las cuentas por cobrar (deudas) de clientes
  async function obtenerDeudas(q) {
    const { empresa, a_pedido } = q; // a_pedido: 'todos' | 'solo' | 'ocultar'
    const w = ["s.deleted_at IS NULL", "s.status IN ('confirmed','pending_payment')"];
    const p = [];
    if (empresa) { w.push('s.company_id = ?'); p.push(empresa); }

    // Ventas con deuda (total - pagado > 0), marcando si son a pedido y contando items
    const [ventas] = await prodPool.query(`
      SELECT s.id, s.code, s.customer_id, s.company_id, s.total, s.created_at,
        COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.voided_at IS NULL),0) AS pagado,
        (SELECT COALESCE(SUM(si.quantity),0) FROM sale_items si WHERE si.sale_id = s.id) AS items,
        (SELECT MAX(CASE WHEN si2.pending_stock_entry_id IS NOT NULL OR si2.is_backorder = 1 THEN 1 ELSE 0 END)
         FROM sale_items si2 WHERE si2.sale_id = s.id) AS es_a_pedido
      FROM sales s
      WHERE ${w.join(' AND ')}
      HAVING (s.total - pagado) > 0`, p);

    if (!ventas.length) return [];

    const custIds = [...new Set(ventas.map(v => v.customer_id))];
    const saleIds = ventas.map(v => v.id);

    // Último pago (abono) de cada venta con deuda
    const [pagosPorVenta] = await prodPool.query(`
      SELECT sale_id, MAX(paid_at) AS ultimo_pago
      FROM sale_payments
      WHERE voided_at IS NULL AND sale_id IN (?)
      GROUP BY sale_id`, [saleIds]);
    const ultPagoVenta = {};
    pagosPorVenta.forEach(r => ultPagoVenta[Number(r.sale_id)] = r.ultimo_pago);

    // Productos (items) de cada venta con deuda.
    // Se filtran con la MISMA condición de las ventas con deuda (subconsulta),
    // en vez de un IN con miles de IDs que podía saturarse.
    const itemsWhere = w.map(x => x.replace(/\bs\./g, 'sv.')).join(' AND ');
    const [items] = await prodPool.query(`
      SELECT si.sale_id, si.quantity, si.unit_price, si.product_variation_id,
        pv.sku, pv.name AS variacion, p.name AS producto
      FROM sale_items si
      LEFT JOIN product_variations pv ON pv.id = si.product_variation_id
      LEFT JOIN products p ON p.id = pv.product_id
      WHERE si.sale_id IN (
        SELECT sv.id FROM sales sv
        WHERE ${itemsWhere}
          AND (sv.total - COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.sale_id = sv.id AND sp.voided_at IS NULL),0)) > 0
      )`, p);
    const itemsPorVenta = {};
    items.forEach(it => {
      const k = Number(it.sale_id);
      (itemsPorVenta[k] = itemsPorVenta[k] || []).push({
        producto: it.producto || (it.variacion ? '' : `(producto #${it.product_variation_id})`),
        variacion: it.variacion || '', sku: it.sku || '—',
        cantidad: Number(it.quantity), precio: Number(it.unit_price)
      });
    });

    // Datos de cliente
    const [clientes] = await prodPool.query(`
      SELECT id, is_company, business_name, first_name, last_name, document_number, email, phone
      FROM parties WHERE id IN (?)`, [custIds]);
    const cliMap = {};
    clientes.forEach(c => cliMap[c.id] = {
      nombre: c.is_company ? c.business_name : `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      ruc: c.document_number || '', email: c.email || '', phone: c.phone || ''
    });

    // Último pago registrado por cliente (sobre cualquier venta suya)
    const [ultPagos] = await prodPool.query(`
      SELECT s.customer_id, MAX(sp.paid_at) AS ultimo_pago
      FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
      WHERE sp.voided_at IS NULL AND s.customer_id IN (?)
      GROUP BY s.customer_id`, [custIds]);
    const ultPagoMap = {};
    ultPagos.forEach(r => ultPagoMap[r.customer_id] = r.ultimo_pago);

    // Comprobantes de esas ventas
    const [vouchers] = await prodPool.query(`
      SELECT sale_id, type, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, [saleIds]);
    const vouchPorVenta = {};
    vouchers.forEach(v => {
      const t = v.type === 'factura' ? 'Factura' : v.type === 'boleta' ? 'Boleta' : v.type;
      (vouchPorVenta[v.sale_id] = vouchPorVenta[v.sale_id] || []).push(`${t} ${v.serie}-${v.number}`);
    });

    // Agrupar por cliente. Clave: RUC/documento si existe (une duplicados con
    // mismo RUC pero nombre distinto); si no hay documento, por customer_id.
    const porCliente = {};
    ventas.forEach(v => {
      const deuda = Number(v.total) - Number(v.pagado);
      const esPedido = !!v.es_a_pedido;
      const info = cliMap[v.customer_id] || {};
      const clave = (info.ruc && info.ruc.trim()) ? 'doc:' + info.ruc.trim() : 'id:' + v.customer_id;
      if (!porCliente[clave]) {
        porCliente[clave] = {
          customer_id: v.customer_id,
          cliente: info.nombre || `Cliente ${v.customer_id}`,
          ruc: info.ruc || '',
          email: info.email || '',
          phone: info.phone || '',
          deuda_normal: 0, deuda_pedido: 0, items: 0, num_ventas: 0,
          venta_mas_antigua: null, ultimo_pago: ultPagoMap[v.customer_id] || null,
          comprobantes: new Set(), tiene_pedido: false, empresas: new Set(), ventas: [],
          customer_ids: new Set()
        };
      }
      const c = porCliente[clave];
      c.customer_ids.add(v.customer_id);
      // Si algún registro del grupo tiene email/teléfono, conservarlo
      if (!c.email && info.email) c.email = info.email;
      if (!c.phone && info.phone) c.phone = info.phone;
      // Último pago: el más reciente entre los customer_ids del grupo
      const up = ultPagoMap[v.customer_id];
      if (up && (!c.ultimo_pago || new Date(up) > new Date(c.ultimo_pago))) c.ultimo_pago = up;
      if (esPedido) { c.deuda_pedido += deuda; c.tiene_pedido = true; }
      else c.deuda_normal += deuda;
      c.items += Number(v.items);
      c.num_ventas += 1;
      if (!c.venta_mas_antigua || new Date(v.created_at) < new Date(c.venta_mas_antigua)) c.venta_mas_antigua = v.created_at;
      (vouchPorVenta[v.id] || []).forEach(x => c.comprobantes.add(x));
      c.empresas.add(EMPRESAS_BI[v.company_id] || `Empresa ${v.company_id}`);
      // Detalle de esta venta
      c.ventas.push({
        codigo: v.code, fecha: v.created_at, deuda: deuda,
        ultimo_pago_venta: ultPagoVenta[Number(v.id)] || null,
        comprobante: (vouchPorVenta[v.id] || []).join(' · ') || '—',
        a_pedido: esPedido,
        productos: itemsPorVenta[Number(v.id)] || []
      });
    });

    let lista = Object.values(porCliente).map(c => ({
      customer_id: c.customer_id,
      customer_ids: [...c.customer_ids],
      cliente: c.cliente, ruc: c.ruc, email: c.email, phone: c.phone,
      deuda_normal: c.deuda_normal, deuda_pedido: c.deuda_pedido,
      deuda_total: c.deuda_normal + c.deuda_pedido,
      items: c.items, num_ventas: c.num_ventas,
      venta_mas_antigua: c.venta_mas_antigua, ultimo_pago: c.ultimo_pago,
      comprobantes: [...c.comprobantes].join(' · ') || '—',
      comprobantes_lista: [...c.comprobantes],
      ventas: c.ventas.sort((a, b) => new Date(a.fecha) - new Date(b.fecha)),
      empresas: [...c.empresas].join(', '),
      tiene_pedido: c.tiene_pedido
    }));

    // Filtro a pedido
    if (a_pedido === 'solo') lista = lista.filter(x => x.tiene_pedido);
    else if (a_pedido === 'ocultar') lista = lista.filter(x => x.deuda_normal > 0).map(x => ({ ...x, deuda_pedido: 0, deuda_total: x.deuda_normal }));

    lista.sort((a, b) => b.deuda_total - a.deuda_total);
    return lista;
  }


  app.get('/api/clientes-deudas', authAdmin, mCxc, async (req, res) => {
    try {
      const lista = await obtenerDeudas(req.query);
      res.json({
        total: lista.length,
        suma_total: lista.reduce((s, x) => s + x.deuda_total, 0),
        suma_normal: lista.reduce((s, x) => s + x.deuda_normal, 0),
        suma_pedido: lista.reduce((s, x) => s + x.deuda_pedido, 0),
        clientes: lista
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/clientes-deudas-excel', authAdmin, mCxc, async (req, res) => {
    try {
      const lista = await obtenerDeudas(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Clientes que deben');
      const fechaLima = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—';

      const empTxt = req.query.empresa ? (EMPRESAS_BI[req.query.empresa] || `Empresa ${req.query.empresa}`) : 'Todas';
      const pedTxt = req.query.a_pedido === 'solo' ? 'Solo a pedido' : req.query.a_pedido === 'ocultar' ? 'Ocultando a pedido' : 'Todas';
      const filasCab = cabeceraExcel(ws, 'Clientes que deben', [
        ['Empresa', empTxt], ['Ventas a pedido', pedTxt], ['Clientes', lista.length]
      ], 8);

      const colDefs = [
        { header: 'Cliente', width: 32 }, { header: 'RUC/Doc', width: 16 },
        { header: 'Venta', width: 15 }, { header: 'Fecha', width: 12 },
        { header: 'Último abono', width: 13 },
        { header: 'Comprobante', width: 28 }, { header: 'Saldo', width: 14 },
        { header: 'A pedido', width: 10 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const headerRowNum = filasCab + 1;
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

      // Una fila por venta (desglosado)
      let sumaTotal = 0;
      lista.forEach(x => {
        (x.ventas || []).forEach(v => {
          ws.addRow([
            x.cliente, x.ruc, v.codigo, fechaLima(v.fecha),
            v.ultimo_pago_venta ? fechaLima(v.ultimo_pago_venta) : '—',
            v.comprobante || '—', v.deuda, v.a_pedido ? 'Sí' : ''
          ]);
          sumaTotal += v.deuda;
        });
      });
      ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
      ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: 8 } };
      ws.getColumn(7).numFmt = '#,##0.00';

      // Total
      ws.addRow([]);
      const t = ws.addRow(['TOTAL']); t.font = { bold: true };
      t.getCell(7).value = sumaTotal;
      t.getCell(7).numFmt = '#,##0.00';

      const nombre = nombreTrazable('clientes-deudas');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
  });


  app.post('/api/clientes-deudas-cobrar', authAdmin, mCxc, async (req, res) => {
    const { customer_ids } = req.body;
    if (!Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ error: 'No se seleccionaron clientes.' });
    }
    if (!process.env.RESEND_API_KEY) {
      return res.status(400).json({ error: 'El envío de correos no está configurado (falta RESEND_API_KEY).' });
    }
    try {
      // Obtener todas las deudas y filtrar los seleccionados que tengan email
      const todas = await obtenerDeudas({});
      const seleccionados = todas.filter(x =>
        x.email && (x.customer_ids || [x.customer_id]).some(id => customer_ids.includes(id)));
      if (!seleccionados.length) {
        return res.status(400).json({ error: 'Ninguno de los seleccionados tiene correo válido.' });
      }

      const fmtS = (n) => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2 });
      const resultados = [];
      for (const c of seleccionados) {
        const ventas = c.ventas || [];
        const fFecha = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—';
        const filasHtml = ventas.map(v =>
          `<tr>` +
          `<td style="padding:6px 10px;border:1px solid #ddd">${v.codigo}</td>` +
          `<td style="padding:6px 10px;border:1px solid #ddd">${fFecha(v.fecha)}</td>` +
          `<td style="padding:6px 10px;border:1px solid #ddd">${v.comprobante}${v.a_pedido ? ' <i>(a pedido)</i>' : ''}</td>` +
          `<td style="padding:6px 10px;border:1px solid #ddd;text-align:right">${fmtS(v.deuda)}</td>` +
          `</tr>`).join('');
        const tablaHtml =
          `<table style="border-collapse:collapse;font-size:13px;margin:8px 0">` +
          `<thead><tr style="background:#000726;color:#fff">` +
          `<th style="padding:6px 10px;border:1px solid #000726;text-align:left">Venta</th>` +
          `<th style="padding:6px 10px;border:1px solid #000726;text-align:left">Fecha</th>` +
          `<th style="padding:6px 10px;border:1px solid #000726;text-align:left">Comprobante</th>` +
          `<th style="padding:6px 10px;border:1px solid #000726;text-align:right">Saldo</th>` +
          `</tr></thead><tbody>${filasHtml}</tbody></table>`;
        const detalleTxt = ventas.map(v =>
          `  • ${v.codigo} (${fFecha(v.fecha)}) — ${v.comprobante}${v.a_pedido ? ' [a pedido]' : ''} — ${fmtS(v.deuda)}`
        ).join('\n') || '  —';

        const html =
          `<div style="font-family:Arial,sans-serif;color:#222;max-width:600px">` +
          `<h2 style="color:#000726">Recordatorio de pago pendiente</h2>` +
          `<p>Estimado(a) <b>${c.cliente}</b>,</p>` +
          `<p>Le escribimos de <b>Kuranko</b> para recordarle que, según nuestros registros, mantiene un saldo pendiente de pago por el monto de <b>${fmtS(c.deuda_total)}</b>, correspondiente a ${c.num_ventas} operación(es). El detalle es el siguiente:</p>` +
          tablaHtml +
          `<p>Le agradeceremos regularizar el pago a la brevedad. Si ya realizó el pago, por favor haga caso omiso de este mensaje o comuníquese con nosotros para actualizar su estado.</p>` +
          `<p>Para coordinar el pago o cualquier consulta, puede responder a este correo o escribir a ventas@kuranko.pe.</p>` +
          `<p>Atentamente,<br><b>Equipo Kuranko</b></p>` +
          `</div>`;
        const texto =
          `Recordatorio de pago pendiente\n\n` +
          `Estimado(a) ${c.cliente},\n\n` +
          `Le escribimos de Kuranko para recordarle que mantiene un saldo pendiente de pago por ${fmtS(c.deuda_total)}, correspondiente a ${c.num_ventas} operación(es). Detalle:\n\n${detalleTxt}\n\n` +
          `Le agradeceremos regularizar el pago a la brevedad. Si ya realizó el pago, haga caso omiso de este mensaje.\n\n` +
          `Para coordinar el pago escriba a ventas@kuranko.pe.\n\nAtentamente,\nEquipo Kuranko`;

        try {
          const payload = {
            from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
            to: [c.email],
            cc: ['info@kuranko.pe'],
            reply_to: 'ventas@kuranko.pe',
            subject: `Recordatorio de pago pendiente — ${c.cliente}`,
            html, text: texto
          };
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          resultados.push({ cliente: c.cliente, email: c.email, ok: r.ok });
        } catch (e) {
          resultados.push({ cliente: c.cliente, email: c.email, ok: false });
        }
      }
      const enviados = resultados.filter(r => r.ok).length;
      res.json({ enviados, total: resultados.length, resultados });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


};
