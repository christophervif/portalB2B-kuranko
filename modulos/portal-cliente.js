// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Portal del cliente (B2B)
//  Todo lo que ve el cliente: login propio, saldo, ventas, pagos, stock,
//  consignación, transferencias, reportar venta, cambiar contraseña, métodos
//  de pago. Incluye también la gestión admin de métodos de pago.
//  Tiene su propio login (authCliente), separado del login admin.
// ═══════════════════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function registrarPortalCliente({
  app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET
}) {

  // Estados de venta válidos (pagada, confirmada, pendiente de pago)
  const VENTAS_VALIDAS = "('paid','confirmed','pending_payment')";

  // Login del cliente B2B (token propio, distinto del admin)
  function authCliente(req, res, next) {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    try {
      const p = jwt.verify(h.split(' ')[1], JWT_SECRET);
      if (p.rol !== 'cliente') return res.status(403).json({ error: 'Acceso no permitido' });
      req.cliente = p;
      next();
    } catch (e) { return res.status(401).json({ error: 'Sesión inválida o expirada' }); }
  }


  // Prepara la tabla de métodos de pago (se llama al arrancar)
  async function prepararTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS config_pago (
        id INT PRIMARY KEY DEFAULT 1,
        transferencia TEXT,
        yape_plin TEXT,
        tarjeta TEXT,
        actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

  }
  const asegurarTablaPago = prepararTablas;

  // Login del cliente B2B
  app.post('/portal/login', async (req, res) => {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
    try {
      const [rows] = await portalPool.query(
        'SELECT * FROM portal_users WHERE username = ? AND activo = 1 LIMIT 1', [usuario.trim()]);
      if (rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      const u = rows[0];
      if (!(await bcrypt.compare(password, u.password_hash)))
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      const token = jwt.sign({
        rol: 'cliente', portal_user_id: u.id, customer_id: u.customer_id,
        location_id: u.location_id, nombre: u.nombre_cliente, ruc: u.username
      }, JWT_SECRET, { expiresIn: '8h' });
      res.json({ token, cliente: { nombre: u.nombre_cliente, ruc: u.username, debe_cambiar: u.username === password } });
    } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
  });


  app.get('/portal/saldo', authCliente, async (req, res) => {
    try {
      const [[v]] = await prodPool.query(
        `SELECT COUNT(*) AS num_ventas, COALESCE(SUM(total),0) AS total_vendido
         FROM sales WHERE customer_id=? AND deleted_at IS NULL AND status IN ${VENTAS_VALIDAS}`,
        [req.cliente.customer_id]);
      const [[p]] = await prodPool.query(
        `SELECT COALESCE(SUM(sp.amount),0) AS total_pagado FROM sale_payments sp
         JOIN sales s ON s.id=sp.sale_id WHERE s.customer_id=? AND sp.voided_at IS NULL
         AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}`, [req.cliente.customer_id]);
      const vendido = parseFloat(v.total_vendido), pagado = parseFloat(p.total_pagado);
      const emailEmpresa = await correoEmpresa(req.cliente.customer_id);
      res.json({ nombre: req.cliente.nombre, ruc: req.cliente.ruc, num_ventas: v.num_ventas,
        total_vendido: vendido, total_pagado: pagado, por_cobrar: Math.max(0, vendido - pagado),
        email_empresa: emailEmpresa });
    } catch (e) { res.status(500).json({ error: 'Error al consultar saldo' }); }
  });


  app.get('/portal/ventas', authCliente, async (req, res) => {
    try {
      const [rows] = await prodPool.query(
        `SELECT s.code AS codigo, s.created_at AS fecha, s.status, s.total,
          COALESCE((SELECT SUM(amount) FROM sale_payments WHERE sale_id=s.id AND voided_at IS NULL),0) AS pagado
         FROM sales s WHERE s.customer_id=? AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}
         ORDER BY s.created_at DESC LIMIT 200`, [req.cliente.customer_id]);
      res.json(rows.map(r => ({ ...r, saldo: Math.max(0, parseFloat(r.total) - parseFloat(r.pagado)) })));
    } catch (e) { res.status(500).json({ error: 'Error al consultar ventas' }); }
  });


  app.get('/portal/pagos', authCliente, async (req, res) => {
    try {
      const [rows] = await prodPool.query(
        `SELECT sp.paid_at AS fecha, sp.amount AS monto, ci.name AS metodo, s.code AS venta_codigo
         FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
         LEFT JOIN catalog_items ci ON ci.id=sp.payment_method_id
         WHERE s.customer_id=? AND sp.voided_at IS NULL AND s.deleted_at IS NULL
         ORDER BY sp.paid_at DESC LIMIT 200`, [req.cliente.customer_id]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error al consultar pagos' }); }
  });


  app.get('/portal/stock', authCliente, async (req, res) => {
    if (!req.cliente.location_id) return res.json([]); // sin consignación asignada
    try {
      const [rows] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          ls.quantity AS cantidad, (ls.quantity - ls.reserved_quantity) AS disponible
         FROM location_stocks ls
         JOIN product_variations pv ON pv.id=ls.product_variation_id
         JOIN products p ON p.id=pv.product_id
         WHERE ls.location_id=? AND ls.quantity>0 AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.name`, [req.cliente.location_id]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error al consultar stock' }); }
  });


  app.get('/portal/venta/:codigo', authCliente, async (req, res) => {
    try {
      const [[venta]] = await prodPool.query(
        `SELECT id, code, total, status, created_at FROM sales
         WHERE code=? AND customer_id=? AND deleted_at IS NULL LIMIT 1`,
        [req.params.codigo, req.cliente.customer_id]);
      if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });

      const [items] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          si.quantity, si.unit_price, si.total
         FROM sale_items si
         JOIN product_variations pv ON pv.id=si.product_variation_id
         JOIN products p ON p.id=pv.product_id
         WHERE si.sale_id=?`, [venta.id]);

      const [vouchers] = await prodPool.query(
        `SELECT type, serie, number, emission_date, amount FROM sale_vouchers
         WHERE sale_id=? ORDER BY emission_date`, [venta.id]);

      const [pagos] = await prodPool.query(
        `SELECT sp.paid_at AS fecha, sp.amount AS monto, ci.name AS metodo
         FROM sale_payments sp
         LEFT JOIN catalog_items ci ON ci.id=sp.payment_method_id
         WHERE sp.sale_id=? AND sp.voided_at IS NULL
         ORDER BY sp.paid_at`, [venta.id]);

      res.json({ venta, items, vouchers, pagos });
    } catch (e) { res.status(500).json({ error: 'Error al consultar el detalle' }); }
  });


  app.get('/portal/consignacion', authCliente, async (req, res) => {
    if (!req.cliente.location_id) return res.json([]);
    const loc = req.cliente.location_id;
    try {
      const [rows] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          ls.product_variation_id AS pvid,
          ls.quantity AS disponible,
          ls.reserved_quantity AS reservado,
          pv.regular_price AS precio,
          COALESCE((
            SELECT SUM(sm.quantity) FROM stock_movements sm
            WHERE sm.product_variation_id=ls.product_variation_id
              AND sm.location_from_id=ls.location_id AND sm.type='sale'
          ),0) AS vendido_hist
         FROM location_stocks ls
         JOIN product_variations pv ON pv.id=ls.product_variation_id
         JOIN products p ON p.id=pv.product_id
         WHERE ls.location_id=? AND ls.quantity>0
           AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.name`, [loc]);

      // Una sola consulta: movimientos de los últimos 60 días en esta consignación,
      // resumidos por producto (última fecha de cada tipo). Liviano para Railway.
      const [movs] = await prodPool.query(
        `SELECT product_variation_id AS pvid,
          MAX(CASE WHEN type='transfer' AND location_to_id=? THEN movement_date END) AS ult_entrada,
          MAX(CASE WHEN type='transfer' AND location_from_id=? THEN movement_date END) AS ult_salida_transf,
          MAX(CASE WHEN type='sale' AND location_from_id=? THEN movement_date END) AS ult_venta
         FROM stock_movements
         WHERE movement_date >= DATE_SUB(NOW(), INTERVAL 60 DAY)
           AND (location_to_id=? OR location_from_id=?)
         GROUP BY product_variation_id`, [loc, loc, loc, loc, loc]);

      const movMap = {};
      movs.forEach(m => { movMap[m.pvid] = m; });
      res.json(rows.map(r => {
        const m = movMap[r.pvid] || {};
        return { ...r,
          ult_entrada: m.ult_entrada || null,
          ult_salida_transf: m.ult_salida_transf || null,
          ult_venta: m.ult_venta || null
        };
      }));
    } catch (e) { res.status(500).json({ error: 'Error al consultar consignación' }); }
  });


  app.get('/portal/transferencias', authCliente, async (req, res) => {
    if (!req.cliente.location_id) return res.json([]);
    const loc = req.cliente.location_id;
    try {
      const [rows] = await prodPool.query(
        `SELECT st.id, st.transfer_date AS fecha, st.reference_number AS guia,
          st.operation_type_code AS tipo, st.notes,
          CASE WHEN st.operation_type_code='04' THEN 'Entregada' ELSE 'Devuelta' END AS direccion,
          (SELECT COALESCE(SUM(sti.quantity),0) FROM stock_transfer_items sti WHERE sti.stock_transfer_id=st.id) AS total_unidades
         FROM stock_transfers st
         WHERE (st.operation_type_code='04' AND st.location_to_id=?)
            OR (st.operation_type_code='03' AND st.location_from_id=?)
         ORDER BY st.transfer_date DESC, st.id DESC`, [loc, loc]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error al consultar transferencias' }); }
  });


  app.get('/portal/transferencia/:id', authCliente, async (req, res) => {
    const loc = req.cliente.location_id;
    if (!loc) return res.status(403).json({ error: 'Sin consignación asignada' });
    try {
      // Verificar que la transferencia pertenece a la consignación del cliente
      const [[t]] = await prodPool.query(
        `SELECT id FROM stock_transfers
         WHERE id=? AND (
           (operation_type_code='04' AND location_to_id=?) OR
           (operation_type_code='03' AND location_from_id=?)
         ) LIMIT 1`, [req.params.id, loc, loc]);
      if (!t) return res.status(404).json({ error: 'Transferencia no encontrada' });

      const [items] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion, sti.quantity
         FROM stock_transfer_items sti
         JOIN product_variations pv ON pv.id=sti.product_variation_id
         JOIN products p ON p.id=pv.product_id
         WHERE sti.stock_transfer_id=?
         ORDER BY p.name`, [req.params.id]);
      res.json(items);
    } catch (e) { res.status(500).json({ error: 'Error al consultar el detalle' }); }
  });


  app.post('/portal/cambiar-password', authCliente, async (req, res) => {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva) return res.status(400).json({ error: 'Faltan datos' });
    if (password_nueva.length < 6) return res.status(400).json({ error: 'La nueva debe tener mínimo 6 caracteres' });
    try {
      const [rows] = await portalPool.query('SELECT password_hash FROM portal_users WHERE id=? LIMIT 1',
        [req.cliente.portal_user_id]);
      if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      if (!(await bcrypt.compare(password_actual, rows[0].password_hash)))
        return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
      await portalPool.query('UPDATE portal_users SET password_hash=? WHERE id=?',
        [await bcrypt.hash(password_nueva, 10), req.cliente.portal_user_id]);
      res.json({ ok: true, mensaje: 'Contraseña actualizada' });
    } catch (e) { res.status(500).json({ error: 'Error al cambiar contraseña' }); }
  });


  app.post('/portal/reportar-venta', authCliente, async (req, res) => {
    const { items } = req.body; // [{producto, sku, cantidad}]
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'No hay items en el reporte' });

    const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });

    // Correo de empresa: si no está registrado, avisamos al equipo
    const emailEmpresa = await correoEmpresa(req.cliente.customer_id);

    const esc = (t) => String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const filasHtml = items.map((i, n) => `
      <tr>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${n + 1}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;font-family:monospace;">${esc(i.sku) || '\u2014'}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;">${esc(i.producto)}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${esc(i.cantidad)}</td>
      </tr>`).join('');

    const avisoCorreo = emailEmpresa
      ? ''
      : `<p style="color:#b45309;background:#fef3c7;padding:10px 14px;border-radius:6px;">\u26a0 Este cliente no tiene correo registrado en el sistema. Falta registrarlo.</p>`;

    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px;">
      <h2 style="color:#000726;margin-bottom:4px;">Reporte de venta de consignaci\u00f3n</h2>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:2px 8px;color:#555;">Cliente:</td><td style="padding:2px 8px;"><b>${esc(req.cliente.nombre)}</b></td></tr>
        <tr><td style="padding:2px 8px;color:#555;">RUC/DNI:</td><td style="padding:2px 8px;">${esc(req.cliente.ruc || '-')}</td></tr>
        <tr><td style="padding:2px 8px;color:#555;">Correo de empresa:</td><td style="padding:2px 8px;">${emailEmpresa ? esc(emailEmpresa) : '\u26a0 No registrado'}</td></tr>
        <tr><td style="padding:2px 8px;color:#555;">Fecha:</td><td style="padding:2px 8px;">${esc(fecha)}</td></tr>
      </table>
      ${avisoCorreo}
      <p style="margin-bottom:6px;"><b>Productos vendidos reportados:</b></p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#000726;color:#fff;">
            <th style="padding:8px 12px;border:1px solid #000726;text-align:center;">N\u00b0</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:left;">SKU</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:left;">Producto</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:center;">Cantidad</th>
          </tr>
        </thead>
        <tbody>${filasHtml}</tbody>
      </table>
      <p style="color:#666;font-size:13px;margin-top:16px;">El distribuidor reporta desde el portal. Registrar manualmente en el sistema.</p>
    </div>`;

    const lineasTexto = items.map((i, n) => `${n + 1}. [${i.sku || '\u2014'}] ${i.producto} \u2014 Cantidad: ${i.cantidad}`).join('\n');
    const texto =
      `Reporte de venta de consignaci\u00f3n\n\n` +
      `Cliente: ${req.cliente.nombre}\nRUC/DNI: ${req.cliente.ruc || '-'}\n` +
      `Correo de empresa: ${emailEmpresa || '\u26a0 No registrado'}\nFecha: ${fecha}\n\n` +
      `Productos vendidos reportados:\n${lineasTexto}\n\n` +
      `(El distribuidor reporta desde el portal. Registrar manualmente en el sistema.)`;

    let correoOk = false;
    if (process.env.RESEND_API_KEY) {
      try {
        const cc = ['info@kuranko.pe'];
        if (emailEmpresa) cc.push(emailEmpresa);

        const payload = {
          from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
          to: (process.env.VENTAS_EMAIL || 'ventas@kuranko.pe').split(',').map(s => s.trim()),
          cc,
          reply_to: 'ventas@kuranko.pe',
          subject: `Reporte de venta consignaci\u00f3n \u2014 ${req.cliente.nombre}`,
          html,
          text: texto
        };

        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        if (!r.ok) console.error('Resend fall\u00f3:', r.status, await r.text());
        correoOk = r.ok;
      } catch (e) { correoOk = false; }
    }
    res.json({ ok: true, correo_enviado: correoOk, copia_cliente: !!emailEmpresa, falta_correo: !emailEmpresa });
  });


  app.get('/portal/metodos-pago', authCliente, async (req, res) => {
    try {
      await asegurarTablaPago();
      const [[cfg]] = await portalPool.query('SELECT transferencia, yape_plin, tarjeta FROM config_pago WHERE id=1');
      res.json(cfg || { transferencia: '', yape_plin: '', tarjeta: '' });
    } catch (e) { res.status(500).json({ error: 'Error al consultar métodos de pago' }); }
  });


  app.get('/admin/metodos-pago', authAdmin, requiereModulo('pagos'), async (req, res) => {
    try {
      await asegurarTablaPago();
      const [[cfg]] = await portalPool.query('SELECT transferencia, yape_plin, tarjeta FROM config_pago WHERE id=1');
      res.json(cfg || { transferencia: '', yape_plin: '', tarjeta: '' });
    } catch (e) { res.status(500).json({ error: 'Error al consultar configuración' }); }
  });


  app.post('/admin/metodos-pago', authAdmin, requiereModulo('pagos'), async (req, res) => {
    const { transferencia, yape_plin, tarjeta } = req.body;
    try {
      await asegurarTablaPago();
      await portalPool.query(
        `INSERT INTO config_pago (id, transferencia, yape_plin, tarjeta)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           transferencia = VALUES(transferencia),
           yape_plin = VALUES(yape_plin),
           tarjeta = VALUES(tarjeta)`,
        [transferencia || '', yape_plin || '', tarjeta || '']);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error al guardar: ' + e.message }); }
  });


  return { prepararTablas };
};
