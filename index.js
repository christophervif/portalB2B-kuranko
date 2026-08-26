// ============================================================================
// PORTAL B2B KURANKO — Backend (clientes + panel de administración)
// Todo en la nube. Cada cliente ve SOLO sus datos. Admin protegido por login.
// ============================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
// Funciones compartidas (antes duplicadas en este archivo)
const { EMPRESAS_BI, fechaHoraLima, fechaLima, nombreTrazable, rango, cabeceraExcel } = require('./modulos/comunes');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Conexiones (usan URLs públicas completas de Railway) ────────────────────
// PROD_URL    = MYSQL_PUBLIC_URL de la base de producción (se fuerza readonly por usuario)
// PORTAL_URL  = MYSQL_PUBLIC_URL de la base del portal
const prodPool = mysql.createPool(process.env.PROD_URL + '?connectionLimit=5');
const portalPool = mysql.createPool(process.env.PORTAL_URL + '?connectionLimit=5');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // contraseña admin (variable Railway, encriptada)
const VENTAS_VALIDAS = "('paid','confirmed','pending_payment')";

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// Devuelve el correo de empresa registrado en el ERP, o null si no tiene.
// Lee de producción en SOLO LECTURA. Si la columna en tu ERP no es
// `parties.email`, cámbiala únicamente aquí (ej: email_address).
async function correoEmpresa(customerId) {
  try {
    const [[p]] = await prodPool.query(
      'SELECT email FROM parties WHERE id=? LIMIT 1', [customerId]);
    return (p && p.email && p.email.trim()) ? p.email.trim() : null;
  } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════════

// Cliente B2B: el customer_id/location_id viven en el token firmado (no manipulable)
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

// Admin: token con rol admin
function authAdmin(req, res, next) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const p = jwt.verify(h.split(' ')[1], JWT_SECRET);
    if (p.rol !== 'admin') return res.status(403).json({ error: 'Acceso solo para administrador' });
    req.admin = p;
    next();
  } catch (e) { return res.status(401).json({ error: 'Sesión inválida o expirada' }); }
}

// Exige que el admin tenga acceso a un módulo concreto (el maestro siempre pasa)
function requiereModulo(modulo) {
  return function (req, res, next) {
    const a = req.admin || {};
    if (a.maestro) return next();
    const mods = Array.isArray(a.modulos) ? a.modulos : [];
    if (!mods.includes(modulo))
      return res.status(403).json({ error: 'No tienes acceso a este módulo' });
    next();
  };
}

// Exige ser admin maestro (para la gestión de accesos)
function soloMaestro(req, res, next) {
  if (!req.admin || !req.admin.maestro)
    return res.status(403).json({ error: 'Solo el administrador maestro puede gestionar accesos' });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// LOGIN CLIENTE
// ════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════
// ENDPOINTS CLIENTE (solo sus datos)
// ════════════════════════════════════════════════════════════════════════════
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

// Detalle de una venta: productos + boletas/facturas (validando que sea del cliente)
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

// Consignación enriquecida: disponible + precio regular + vendido histórico + indicadores recientes
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

// Pestaña Transferencias: entregadas (04) y devueltas (03) con detalle de items
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

// Detalle de items de una transferencia (validando que sea de la consignación del cliente)
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

// ════════════════════════════════════════════════════════════════════════════
// LOGIN ADMIN
// ════════════════════════════════════════════════════════════════════════════
// Lista de módulos (pestañas) del admin. Debe coincidir con las pestañas del HTML.
const MODULOS_ADMIN = ['clientes_gestion', 'sync', 'auditoria', 'resumen', 'rentabilidad', 'inventario', 'restock', 'clientes_bi', 'caja_bi', 'crm', 'reportes', 'pagos'];

// Usuarios admin secundarios definidos en variables de entorno (Railway).
// Formato por usuario (numeradas del 2 en adelante):
//   ADMIN2_USER, ADMIN2_PASSWORD, ADMIN2_MODULOS (módulos separados por coma)
// Ejemplo: ADMIN2_MODULOS = usuarios,vincular,crear
function leerAdminsSecundarios() {
  const lista = [];
  for (let i = 2; i <= 10; i++) {
    const u = process.env[`ADMIN${i}_USER`];
    const p = process.env[`ADMIN${i}_PASSWORD`];
    if (!u || !p) continue;
    const mods = (process.env[`ADMIN${i}_MODULOS`] || '')
      .split(',').map(s => s.trim()).filter(m => MODULOS_ADMIN.includes(m));
    lista.push({ usuario: u.trim(), password: p, modulos: mods });
  }
  return lista;
}

app.post('/admin/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
  try {
    // 1) Admin maestro (acceso total + gestión de accesos)
    if (usuario.trim() === ADMIN_USER && password === ADMIN_PASSWORD) {
      const token = jwt.sign(
        { rol: 'admin', usuario: ADMIN_USER, maestro: true, modulos: MODULOS_ADMIN },
        JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, maestro: true, modulos: MODULOS_ADMIN });
    }
    // 2) Admin secundario (definido en variables de Railway) — sin tocar la base de datos
    const secundarios = leerAdminsSecundarios();
    const match = secundarios.find(a => a.usuario === usuario.trim() && a.password === password);
    if (match) {
      const token = jwt.sign(
        { rol: 'admin', usuario: match.usuario, maestro: false, modulos: match.modulos },
        JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, maestro: false, modulos: match.modulos });
    }
    return res.status(401).json({ error: 'Credenciales de administrador incorrectas' });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ENDPOINTS ADMIN
// ════════════════════════════════════════════════════════════════════════════

// Lista de clientes empresa de producción (para elegir y vincular)
// ── Módulo Accesos (gestión de usuarios) en modulos/accesos.js ──
// Se carga más abajo, tras definir las piezas de login.

// ─── Reporte de venta de consignación (NO toca la BD, solo notifica) ─────────
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

// ─── Métodos de pago (el admin los edita, el cliente los ve) ─────────────────
// Se guardan en la base del portal (no toca el ERP). Una sola fila de config.
async function asegurarTablaPago() {
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

// Cliente: leer métodos de pago (solo lectura)
app.get('/portal/metodos-pago', authCliente, async (req, res) => {
  try {
    await asegurarTablaPago();
    const [[cfg]] = await portalPool.query('SELECT transferencia, yape_plin, tarjeta FROM config_pago WHERE id=1');
    res.json(cfg || { transferencia: '', yape_plin: '', tarjeta: '' });
  } catch (e) { res.status(500).json({ error: 'Error al consultar métodos de pago' }); }
});

// Admin: leer métodos de pago (para el formulario de edición)
app.get('/admin/metodos-pago', authAdmin, requiereModulo('pagos'), async (req, res) => {
  try {
    await asegurarTablaPago();
    const [[cfg]] = await portalPool.query('SELECT transferencia, yape_plin, tarjeta FROM config_pago WHERE id=1');
    res.json(cfg || { transferencia: '', yape_plin: '', tarjeta: '' });
  } catch (e) { res.status(500).json({ error: 'Error al consultar configuración' }); }
});

// Admin: guardar métodos de pago
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


// ============================================================================
const https = require('https');
const VV = "('paid','confirmed','pending_payment')";

// Arma "Producto — extra" evitando repetir el nombre cuando la variación ya lo contiene.
// Ej: producto "Crafty Carbon RR 2026" + variación "Crafty Carbon RR 2026, Admiral Blue, M/L"
//     → "Crafty Carbon RR 2026 — Admiral Blue, M/L"

// Referencia a módulos que exponen funciones de arranque (se asigna dentro de la IIFE)
let modSync = null;

// Registro de endpoints del dashboard (inyectado directamente)
(function(){

  const mResumen = requiereModulo('resumen');
  const mRent = requiereModulo('rentabilidad');
  const mInv = requiereModulo('inventario');
  const mRestock = requiereModulo('restock');

  // ── EXPORTADOR DE INVENTARIO (Restock) ──
  // Catálogo con stock, ventas, margen y rotación. Filtros: marca, categoría,
  // subcategoría, solo con stock, solo con ventas, rango de margen.

  // Llena los desplegables del exportador (marcas, categorías, subcategorías)
  // sin cargar el catálogo completo. Se llama al abrir la pestaña.



  const mClientes = requiereModulo('clientes_bi');

  // ── CRÉDITOS A FAVOR DEL CLIENTE (saldo a favor / anticipos) ──
  // Se guardan en la base del PORTAL (no en el ERP de Renzo). Cada crédito nace
  // de una venta cancelada que recibió pago (ese pago quedó a favor del cliente).

  // Buscar ventas canceladas que recibieron pago (candidatas a generar crédito)

  // Registrar un crédito a partir de una venta cancelada

  // Listar créditos registrados (con su saldo disponible)

  // Anular un crédito (solo el maestro, deja rastro de quién y cuándo)

  const mCaja = requiereModulo('caja_bi');
  const mCrm = requiereModulo('crm');

  // ── Módulo CRM Kommo (separado en modulos/crm-kommo.js) ──
  require('./modulos/crm-kommo')({ app, authAdmin, mCrm, prodPool, VV });

  // ── Módulo Ventas-BI (KPIs, rentabilidad, top productos) ──
  require('./modulos/ventas-bi')({ app, authAdmin, mResumen, mRent, prodPool, VV });

  // ── Módulo Inventario (capital parado, restock, promociones) ──
  require('./modulos/inventario')({ app, authAdmin, mInv, mRestock, prodPool, VV });

  // ── Módulo Clientes-BI (créditos, deudas, conciliación) ──
  require('./modulos/clientes-bi')({ app, authAdmin, mClientes, mResumen, prodPool, portalPool, VV });

  // ── Módulo Conciliación de pagos online ──
  require('./modulos/conciliacion')({ app, authAdmin, mResumen, prodPool, VV });

  // ── Módulo Accesos (gestión de usuarios) ──
  require('./modulos/accesos')({
    app, authAdmin, requiereModulo, soloMaestro,
    prodPool, portalPool, JWT_SECRET, MODULOS_ADMIN, leerAdminsSecundarios
  });

  // ── Módulo Contabilidad (kardex + reporte de pagos) ──
  require('./modulos/contabilidad')({ app, authAdmin, requiereModulo, prodPool, VV });

  // ── Módulo Sincronización + Auditoría ──
  modSync = require('./modulos/sincronizacion')({ app, authAdmin, requiereModulo, prodPool, portalPool });
  const rango = (desde, hasta, campo='s.created_at') =>
    desde && hasta ? `AND ${campo} BETWEEN '${desde}' AND '${hasta} 23:59:59'` : '';

  // ── RESUMEN / KPIs ──

  // ── INVENTARIO ──
  // ── CANDIDATOS A PROMOCIÓN ──
  // Analiza stock y ventas para sugerir qué productos convendría promocionar.
  // Criterios: estancado | sobrestock | margen_lento | lote_antiguo | casi_agotado


  const PROMO_NOMBRES = {
    estancado: 'Stock estancado', sobrestock: 'Sobre-stock',
    margen_lento: 'Margen alto + venta lenta', lote_antiguo: 'Lotes antiguos',
    casi_agotado: 'Casi agotados con demanda'
  };

  // ── ANÁLISIS DE CAPITAL INMOVILIZADO (Inventario) ──
  // Solo stock, capital y rotación. NO incluye márgenes ni ganancias:
  // esta pestaña la ve el supervisor y esos datos son de Rentabilidad.



  // ── RESTOCK ──

  // ── CLIENTES ──
  app.get('/api/top-clientes', authAdmin, mClientes, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.id, p.is_company,
          CASE WHEN p.is_company=1 THEN p.business_name
               ELSE CONCAT(COALESCE(p.first_name,''),' ',COALESCE(p.last_name,'')) END AS cliente,
          p.document_number, COUNT(s.id) AS pedidos, COALESCE(SUM(s.total),0) AS total_comprado
        FROM sales s JOIN parties p ON p.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY p.id, cliente, p.document_number, p.is_company ORDER BY total_comprado DESC LIMIT 15`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });



  // ── CLIENTES QUE DEBEN (cuentas por cobrar) ──



  // Envío de correos de cobranza a deudores seleccionados (con CC a info@kuranko.pe)



  // Pagos del sistema agrupados por empresa + código de método (para conciliar con el Sheet)


  // ── PAGOS Y CAJA ──
  app.get('/api/metodos-pago-bi', authAdmin, mCaja, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT ci.name AS metodo, COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
        WHERE sp.voided_at IS NULL ${f} GROUP BY sp.payment_method_id, ci.name ORDER BY total DESC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cierres-caja', authAdmin, mCaja, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `WHERE closure_date BETWEEN '${desde}' AND '${hasta}'`
      : `WHERE closure_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT id, closure_date, status, total_general, totals, notes
        FROM cash_closures ${f} ORDER BY closure_date DESC LIMIT 30`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

})();

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, servicio: 'portal-b2b' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Portal B2B en puerto ${PORT}`);
  // Preparar tablas una vez al arrancar (evita que el primer login pague la espera)
  try {
    await asegurarTablaPago();
    if (modSync && modSync.prepararTablas) await modSync.prepararTablas();
    console.log('Tablas del portal listas.');
  } catch (e) { console.error('No se pudieron preparar las tablas al arrancar:', e.message); }
});
