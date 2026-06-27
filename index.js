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
      location_id: u.location_id, nombre: u.nombre_cliente
    }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, cliente: { nombre: u.nombre_cliente, debe_cambiar: u.username === password } });
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
    res.json({ nombre: req.cliente.nombre, num_ventas: v.num_ventas,
      total_vendido: vendido, total_pagado: pagado, por_cobrar: Math.max(0, vendido - pagado) });
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

    res.json({ venta, items, vouchers });
  } catch (e) { res.status(500).json({ error: 'Error al consultar el detalle' }); }
});

// Consignación enriquecida: entregado / vendido / disponible
app.get('/portal/consignacion', authCliente, async (req, res) => {
  if (!req.cliente.location_id) return res.json([]);
  try {
    const [rows] = await prodPool.query(
      `SELECT p.name AS producto, pv.sku, pv.name AS variacion,
        ls.quantity AS disponible,
        ls.reserved_quantity AS reservado,
        pv.sale_price AS precio,
        COALESCE((
          SELECT SUM(sm.quantity) FROM stock_movements sm
          WHERE sm.product_variation_id=ls.product_variation_id
            AND sm.location_to_id=ls.location_id AND sm.type='transfer'
        ),0) AS entregado_hist
       FROM location_stocks ls
       JOIN product_variations pv ON pv.id=ls.product_variation_id
       JOIN products p ON p.id=pv.product_id
       WHERE ls.location_id=? AND ls.quantity>0
         AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
       ORDER BY p.name`, [req.cliente.location_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error al consultar consignación' }); }
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
app.post('/admin/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
  try {
    if (usuario.trim() !== ADMIN_USER || password !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Credenciales de administrador incorrectas' });
    const token = jwt.sign({ rol: 'admin', usuario: ADMIN_USER }, JWT_SECRET, { expiresIn: '4h' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ENDPOINTS ADMIN
// ════════════════════════════════════════════════════════════════════════════

// Lista de clientes empresa de producción (para elegir y vincular)
app.get('/admin/clientes-produccion', authAdmin, async (req, res) => {
  try {
    const [rows] = await prodPool.query(`
      SELECT p.id AS customer_id, p.business_name, p.document_number,
        EXISTS(SELECT 1 FROM sales s WHERE s.customer_id=p.id AND s.deleted_at IS NULL) AS tiene_ventas
      FROM parties p WHERE p.is_company=1
        AND p.business_name IS NOT NULL AND p.business_name != ''
      ORDER BY p.business_name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error al leer clientes' }); }
});

// Lista de consignaciones de producción (para vincular)
app.get('/admin/consignaciones', authAdmin, async (req, res) => {
  try {
    const [rows] = await prodPool.query(
      `SELECT id AS location_id, name FROM locations WHERE type='consignment' AND is_active=1 ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error al leer consignaciones' }); }
});

// Lista de usuarios del portal ya creados
app.get('/admin/usuarios', authAdmin, async (req, res) => {
  try {
    const [rows] = await portalPool.query(
      `SELECT id, username, customer_id, location_id, nombre_cliente, activo, created_at
       FROM portal_users ORDER BY nombre_cliente`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error al leer usuarios' }); }
});

// Crear o actualizar un usuario del portal (vincular cliente + consignación)
app.post('/admin/usuario', authAdmin, async (req, res) => {
  const { username, customer_id, location_id, nombre_cliente, password } = req.body;
  if (!username || !customer_id || !nombre_cliente)
    return res.status(400).json({ error: 'Faltan datos: usuario, cliente y nombre' });
  try {
    // password inicial = la enviada, o el propio username (RUC) si no se envía
    const passPlano = (password && password.trim()) ? password.trim() : username.trim();
    const hash = await bcrypt.hash(passPlano, 10);
    await portalPool.query(
      `INSERT INTO portal_users (username, password_hash, customer_id, location_id, nombre_cliente, activo)
       VALUES (?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE customer_id=VALUES(customer_id),
         location_id=VALUES(location_id), nombre_cliente=VALUES(nombre_cliente)`,
      [username.trim(), hash, customer_id, location_id || null, nombre_cliente.trim()]);
    res.json({ ok: true, mensaje: 'Usuario guardado', password_inicial: passPlano });
  } catch (e) { res.status(500).json({ error: 'Error al guardar: ' + e.message }); }
});

// Vincular solo la consignación de un usuario existente
app.post('/admin/vincular', authAdmin, async (req, res) => {
  const { portal_user_id, location_id } = req.body;
  if (!portal_user_id) return res.status(400).json({ error: 'Falta el usuario' });
  try {
    await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?',
      [location_id || null, portal_user_id]);
    res.json({ ok: true, mensaje: 'Vínculo actualizado' });
  } catch (e) { res.status(500).json({ error: 'Error al vincular' }); }
});

// Activar / desactivar acceso
app.post('/admin/activar', authAdmin, async (req, res) => {
  const { portal_user_id, activo } = req.body;
  try {
    await portalPool.query('UPDATE portal_users SET activo=? WHERE id=?',
      [activo ? 1 : 0, portal_user_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

// Resetear contraseña de un cliente (vuelve a su RUC)
app.post('/admin/reset-password', authAdmin, async (req, res) => {
  const { portal_user_id } = req.body;
  try {
    const [rows] = await portalPool.query('SELECT username FROM portal_users WHERE id=? LIMIT 1',
      [portal_user_id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const hash = await bcrypt.hash(rows[0].username, 10);
    await portalPool.query('UPDATE portal_users SET password_hash=? WHERE id=?', [hash, portal_user_id]);
    res.json({ ok: true, mensaje: 'Contraseña reiniciada al RUC', password: rows[0].username });
  } catch (e) { res.status(500).json({ error: 'Error al resetear' }); }
});

// Crear todos los usuarios de golpe (clientes empresa con ventas)
app.post('/admin/crear-todos', authAdmin, async (req, res) => {
  try {
    const [clientes] = await prodPool.query(`
      SELECT p.id AS customer_id, p.business_name, p.document_number
      FROM parties p WHERE p.is_company=1
        AND p.document_number IS NOT NULL AND p.document_number != ''
        AND EXISTS(SELECT 1 FROM sales s WHERE s.customer_id=p.id AND s.deleted_at IS NULL)`);
    let creados = 0, saltados = 0;
    for (const c of clientes) {
      const ruc = c.document_number.trim();
      const hash = await bcrypt.hash(ruc, 10);
      try {
        await portalPool.query(
          `INSERT INTO portal_users (username, password_hash, customer_id, location_id, nombre_cliente, activo)
           VALUES (?,?,?,NULL,?,1)`, [ruc, hash, c.customer_id, c.business_name]);
        creados++;
      } catch (e) { if (e.code === 'ER_DUP_ENTRY') saltados++; }
    }
    res.json({ ok: true, creados, saltados, total: clientes.length });
  } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
});

// ─── Reporte de venta de consignación (NO toca la BD, solo notifica) ─────────
app.post('/portal/reportar-venta', authCliente, async (req, res) => {
  const { items } = req.body; // [{producto, sku, cantidad}]
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'No hay items en el reporte' });

  const lineas = items.map(i => `• ${i.cantidad} x ${i.producto}${i.sku ? ' ('+i.sku+')' : ''}`).join('\n');
  const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const cuerpo =
    `Reporte de venta de consignación\n\n` +
    `Cliente: ${req.cliente.nombre}\n` +
    `Fecha: ${fecha}\n\n` +
    `Productos vendidos reportados:\n${lineas}\n\n` +
    `(El distribuidor reporta desde el portal. Registrar manualmente en el sistema.)`;

  // Enviar correo vía Resend si está configurado
  let correoOk = false;
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Portal Kuranko <onboarding@resend.dev>',
          to: process.env.VENTAS_EMAIL || 'ventas@kuranko.pe',
          subject: `Reporte de venta consignación — ${req.cliente.nombre}`,
          text: cuerpo
        })
      });
      correoOk = r.ok;
    } catch (e) { correoOk = false; }
  }
  res.json({ ok: true, correo_enviado: correoOk });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, servicio: 'portal-b2b' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Portal B2B en puerto ${PORT}`));
