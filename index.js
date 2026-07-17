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
        JWT_SECRET, { expiresIn: '4h' });
      return res.json({ token, maestro: true, modulos: MODULOS_ADMIN });
    }
    // 2) Admin secundario (definido en variables de Railway) — sin tocar la base de datos
    const secundarios = leerAdminsSecundarios();
    const match = secundarios.find(a => a.usuario === usuario.trim() && a.password === password);
    if (match) {
      const token = jwt.sign(
        { rol: 'admin', usuario: match.usuario, maestro: false, modulos: match.modulos },
        JWT_SECRET, { expiresIn: '4h' });
      return res.json({ token, maestro: false, modulos: match.modulos });
    }
    return res.status(401).json({ error: 'Credenciales de administrador incorrectas' });
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
app.get('/admin/usuarios', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
  try {
    const [rows] = await portalPool.query(
      `SELECT id, username, customer_id, location_id, nombre_cliente, activo, created_at
       FROM portal_users ORDER BY nombre_cliente`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error al leer usuarios' }); }
});

// Crear o actualizar un usuario del portal (vincular cliente + consignación)
app.post('/admin/usuario', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
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
app.post('/admin/vincular', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
  const { portal_user_id, location_id } = req.body;
  if (!portal_user_id) return res.status(400).json({ error: 'Falta el usuario' });
  try {
    await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?',
      [location_id || null, portal_user_id]);
    res.json({ ok: true, mensaje: 'Vínculo actualizado' });
  } catch (e) { res.status(500).json({ error: 'Error al vincular' }); }
});

// Activar / desactivar acceso
app.post('/admin/activar', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
  const { portal_user_id, activo } = req.body;
  try {
    await portalPool.query('UPDATE portal_users SET activo=? WHERE id=?',
      [activo ? 1 : 0, portal_user_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

// Resetear contraseña de un cliente (vuelve a su RUC)
app.post('/admin/reset-password', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
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

// Ver el portal como un cliente (soporte): genera un token de cliente sin su contraseña.
// El admin ya está autenticado; el token queda marcado con via_admin para trazabilidad.
app.post('/admin/ver-como-cliente', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
  const { portal_user_id } = req.body;
  if (!portal_user_id) return res.status(400).json({ error: 'Falta el usuario' });
  try {
    const [rows] = await portalPool.query(
      'SELECT * FROM portal_users WHERE id = ? AND activo = 1 LIMIT 1', [portal_user_id]);
    if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado o inactivo' });
    const u = rows[0];
    const token = jwt.sign({
      rol: 'cliente', portal_user_id: u.id, customer_id: u.customer_id,
      location_id: u.location_id, nombre: u.nombre_cliente, ruc: u.username,
      via_admin: req.admin ? req.admin.usuario : true, expiresIn: '1h'
    }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, cliente: { nombre: u.nombre_cliente, ruc: u.username } });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// Crear todos los usuarios de golpe (clientes empresa con ventas)
app.post('/admin/crear-todos', authAdmin, requiereModulo('clientes_gestion'), async (req, res) => {
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

// ─── Reporte de sincronización: pendientes + alertas (Excel, 2 pestañas) ─────
// Lee del ERP en SOLO LECTURA. No modifica nada. Genera el Excel al momento.
// ─── Auditoría del catálogo (datos del ERP) — reutilizable para pantalla y Excel ──
async function calcularAuditoria() {
    // ── PESTAÑA 2: Pendientes (sin woocommerce_id) ─────────────────────────
    // Solo se muestran los que tienen stock > 0, O los que tienen un ingreso
    // pendiente por llegar (una venta en backorder con pending_stock_entry_id).
    const [pendientes] = await prodPool.query(
      `SELECT pv.sku, pv.product_type, pv.name AS nombre, pv.regular_price,
              COALESCE(SUM(ls.quantity),0) AS stock,
              EXISTS(
                SELECT 1 FROM sale_items si
                WHERE si.product_variation_id = pv.id
                  AND si.pending_stock_entry_id IS NOT NULL
              ) AS ingreso_pendiente
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.woocommerce_id IS NULL
         AND pv.product_type IN ('variation','simple')
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.sku, pv.product_type, pv.name, pv.regular_price
       HAVING stock > 0 OR ingreso_pendiente = 1
       ORDER BY pv.name, pv.sku`);

    // ── PESTAÑA 3: Alertas del sistema (todo del ERP) ──────────────────────
    // Traemos datos base de productos con stock, y datos para cada regla.
    const NOM_ESTADO = { draft: 'borrador', discontinued: 'descontinuado', active: 'activo' };

    // Consulta principal: variaciones con su stock, precios, estado, descripción del padre e imagen.
    const [base] = await prodPool.query(
      `SELECT pv.id AS variation_id, pv.woocommerce_id, pv.sku, pv.name AS nombre,
              pv.product_type, pv.status, pv.regular_price, pv.sale_price,
              p.description AS descripcion,
              COALESCE(SUM(ls.quantity),0) AS stock,
              (SELECT COUNT(*) FROM product_images pi
               WHERE (pi.product_id = p.id OR pi.product_variation_id = pv.id)
                 AND pi.deleted_at IS NULL) AS num_imagenes
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.product_type IN ('variation','simple')
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.woocommerce_id, pv.sku, pv.name, pv.product_type,
                pv.status, pv.regular_price, pv.sale_price, p.description, p.id`);

    // Costo FIFO (lote más antiguo con stock) por variación
    const [lotes] = await prodPool.query(
      `SELECT sb.product_variation_id, sb.cost_price, sb.entry_date
       FROM stock_batches sb
       WHERE sb.quantity > 0
       ORDER BY sb.product_variation_id, sb.entry_date ASC, sb.id ASC`);
    const costoFifo = {};
    for (const l of lotes) {
      if (!(l.product_variation_id in costoFifo)) {
        costoFifo[l.product_variation_id] = Number(l.cost_price);
      }
    }

    // SKU duplicados: contamos apariciones del mismo SKU
    const contadorSku = {};
    base.forEach(b => { const k = (b.sku || '').trim(); if (k) contadorSku[k] = (contadorSku[k] || 0) + 1; });

    // Padres 'variable' sin variaciones activas
    const [padresSinHijas] = await prodPool.query(
      `SELECT pv.id AS variation_id, pv.sku, pv.name AS nombre
       FROM product_variations pv
       WHERE pv.product_type = 'variable'
         AND pv.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM product_variations h
           JOIN products p ON p.id = h.product_id
           WHERE p.id = pv.product_id
             AND h.product_type = 'variation'
             AND h.status = 'active'
             AND h.deleted_at IS NULL
         )`);

    // Productos 'variable' (padres) que tienen stock — no deberían (el stock va en las variaciones)
    const [variableConStock] = await prodPool.query(
      `SELECT pv.sku, pv.name AS nombre, pv.woocommerce_id,
              COALESCE(SUM(ls.quantity),0) AS stock
       FROM product_variations pv
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.product_type = 'variable'
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.sku, pv.name, pv.woocommerce_id
       HAVING COALESCE(SUM(ls.quantity),0) > 0`);

    // Productos 'variable' (padres) con ventas asociadas — no deberían (se venden las variaciones)
    const [variableConVenta] = await prodPool.query(
      `SELECT pv.sku, pv.name AS nombre, pv.woocommerce_id,
              COUNT(si.id) AS num_ventas, COALESCE(SUM(si.quantity),0) AS unidades
       FROM product_variations pv
       JOIN sale_items si ON si.product_variation_id = pv.id
       WHERE pv.product_type = 'variable'
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.sku, pv.name, pv.woocommerce_id`);

    // Construir la lista de alertas del sistema
    const alertasSistema = [];
    const NIVEL_MARGEN = (precio, costo) => {
      if (costo <= 0) return null;
      if (precio <= costo) return 'Nivel 1 - Crítico (venta a pérdida)';
      if (precio < costo * 1.10) return 'Nivel 2 - Riesgo (margen < 10%)';
      if (precio < costo * 1.20) return 'Nivel 3 - Bajo (margen < 20%)';
      return null;
    };

    for (const b of base) {
      const stock = Number(b.stock) || 0;
      const activo = b.status === 'active';
      const sku = (b.sku || '').trim();
      const reg = b.regular_price === null ? null : Number(b.regular_price);
      const sale = b.sale_price === null ? null : Number(b.sale_price);

      // Reglas que requieren stock > 0
      if (stock > 0) {
        // Sin descripción
        if (!b.descripcion || String(b.descripcion).trim() === '') {
          alertasSistema.push({ tipo: 'Falta descripción', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `Tiene ${stock} en stock pero no tiene descripción` });
        }
        // Sin imagen
        if (!b.num_imagenes || b.num_imagenes === 0) {
          alertasSistema.push({ tipo: 'Falta imagen', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `Tiene ${stock} en stock pero no tiene imagen registrada` });
        }
        // Sin precio regular
        if (reg === null || reg === 0) {
          alertasSistema.push({ tipo: 'Falta precio', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `Tiene ${stock} en stock pero no tiene precio regular` });
        }
        // Descontinuado con stock
        if (b.status === 'discontinued') {
          alertasSistema.push({ tipo: 'Descontinuado con stock', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
            obs: `Tiene ${stock} en stock pero está en 'descontinuado'` });
        }
        // Margen contra costo FIFO (analiza oferta y regular; alerta si cualquiera cae)
        const costo = costoFifo[b.variation_id];
        if (costo === undefined || costo === null) {
          // costo no registrado — omitir SKU con MKP o PCK
          if (!/MKP|PCK/i.test(sku)) {
            alertasSistema.push({ tipo: 'Costo no registrado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero no tiene costo FIFO registrado` });
          }
        } else if (costo === 0) {
          if (!/MKP|PCK/i.test(sku)) {
            alertasSistema.push({ tipo: 'Costo no registrado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `Tiene ${stock} en stock pero su costo FIFO es 0.00 (no registrado)` });
          }
        } else {
          // Analizar precio de oferta si existe, e indicar; también el regular
          if (sale !== null && sale > 0) {
            const niv = NIVEL_MARGEN(sale, costo);
            if (niv) alertasSistema.push({ tipo: 'Margen bajo', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `${niv} — Precio oferta S/${sale.toFixed(2)} vs costo FIFO S/${costo.toFixed(2)}` });
          }
          if (reg !== null && reg > 0) {
            const niv = NIVEL_MARGEN(reg, costo);
            if (niv) alertasSistema.push({ tipo: 'Margen bajo', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
              obs: `${niv} — Precio regular S/${reg.toFixed(2)} vs costo FIFO S/${costo.toFixed(2)}` });
          }
        }
      }

      // Reglas que NO dependen de stock
      // Oferta >= regular
      if (sale !== null && sale > 0 && reg !== null && reg > 0 && sale >= reg) {
        alertasSistema.push({ tipo: 'Oferta mal puesta', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
          obs: `Precio de oferta S/${sale.toFixed(2)} es mayor o igual al regular S/${reg.toFixed(2)}` });
      }
      // SKU duplicado
      if (sku && contadorSku[sku] > 1) {
        alertasSistema.push({ tipo: 'SKU duplicado', sku, wc: b.woocommerce_id || '', nombre: b.nombre || '',
          obs: `El SKU "${sku}" aparece ${contadorSku[sku]} veces en el catálogo` });
      }
    }
    // Padres sin variaciones activas
    padresSinHijas.forEach(p => {
      alertasSistema.push({ tipo: 'Padre sin variaciones', sku: p.sku || '', wc: '', nombre: p.nombre || '',
        obs: `Producto variable sin ninguna variación activa (aparece vacío en la tienda)` });
    });
    // Variable con stock (el stock debería estar en las variaciones, no en el padre)
    variableConStock.forEach(p => {
      alertasSistema.push({ tipo: 'Variable con stock', sku: p.sku || '', wc: p.woocommerce_id || '', nombre: p.nombre || '',
        obs: `Producto tipo variable con ${p.stock} en stock (el stock debería estar en las variaciones, no en el padre)` });
    });
    // Variable con ventas (deberían venderse las variaciones, no el padre)
    variableConVenta.forEach(p => {
      alertasSistema.push({ tipo: 'Variable con venta', sku: p.sku || '', wc: p.woocommerce_id || '', nombre: p.nombre || '',
        obs: `Producto tipo variable con ${p.num_ventas} venta(s) asociada(s) (${p.unidades} unidades) — las ventas deberían ir en las variaciones` });
    });


    return { pendientes, alertas: alertasSistema };
}

// ════════════════════════════════════════════════════════════════════════════
// REPORTE 3.2 — LISTA DE PAGOS EN EL TIEMPO
// Cada fila es un pago: venta, empresa que gestiona la venta, empresa(s) del producto (por
// el lote FIFO), método, cuenta destino, comprobante, notas y cuadre de caja.
// ════════════════════════════════════════════════════════════════════════════

// Datos para poblar los filtros (métodos de pago y cuentas bancarias)
// ════════════════════════════════════════════════════════════════════════════
// REPORTE 3.1 — KARDEX VALORIZADO
// Movimientos de stock por producto, valorizados, en línea de tiempo, con código
// SUNAT real, saldo acumulado y totales por producto.
// ════════════════════════════════════════════════════════════════════════════

// Mapa de códigos SUNAT (catálogo Tipo de Operación) → nombre legible
const CODIGOS_SUNAT = {
  '01': 'Venta Nacional', '02': 'Compra Nacional', '03': 'Consignación Recibida',
  '04': 'Consignación Entregada', '05': 'Devolución Recibida', '06': 'Devolución Entregada',
  '07': 'Bonificación', '08': 'Premio', '09': 'Donación', '10': 'Salida a Producción',
  '11': 'Transferencia entre almacenes', '12': 'Retiro', '13': 'Mermas', '14': 'Desmedros',
  '15': 'Destrucción', '16': 'Saldo Inicial', '17': 'Exportación', '18': 'Importación',
  '19': 'Entrada de Producción'
};
const TIPO_MOV_NOM = {
  purchase: 'Entrada', sale: 'Venta', transfer: 'Transferencia',
  adjustment: 'Ajuste', return: 'Devolución'
};

// Nombre de archivo con trazabilidad: reporte-AAAAMMDD-HHMM
function nombreTrazable(base) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${base}-${stamp}`;
}

// Inserta una cabecera informativa en las primeras filas de una hoja Excel.
// Devuelve el número de filas usadas (para saber dónde empieza la tabla).
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

// Costo FIFO vigente de una variación (lote más antiguo con stock, de donde el
// sistema descuenta en salidas/ajustes). Es la regla real de descuento, no una estimación.
async function costoFifoVigente(prodPool, variationId) {
  const [[r]] = await prodPool.query(
    `SELECT cost_price FROM stock_batches
     WHERE product_variation_id = ? AND quantity > 0
     ORDER BY entry_date ASC, id ASC LIMIT 1`, [variationId]);
  return r ? Number(r.cost_price) : null;
}

// Costo del lote creado en una entrada específica (para valorizar entradas al costo real)
async function costoDeEntrada(prodPool, entryId, variationId) {
  const [[r]] = await prodPool.query(
    `SELECT cost_price FROM stock_batches
     WHERE stock_entry_id = ? AND product_variation_id = ?
     ORDER BY id ASC LIMIT 1`, [entryId, variationId]);
  return r ? Number(r.cost_price) : null;
}

async function obtenerKardex(prodPool, q) {
  const { desde, hasta, sku, producto } = q;
  const w = [];
  const p = [];
  if (desde && hasta) { w.push('sm.movement_date BETWEEN ? AND ?'); p.push(desde, hasta); }
  if (sku) { w.push('pv.sku LIKE ?'); p.push('%' + sku + '%'); }
  if (producto) { w.push('(p.name LIKE ? OR pv.name LIKE ?)'); p.push('%' + producto + '%', '%' + producto + '%'); }
  const whereSql = w.length ? 'WHERE ' + w.join(' AND ') : '';

  // Traer movimientos con producto, ubicación y usuario
  const [movs] = await prodPool.query(`
    SELECT sm.id, sm.type, sm.operation_type_code, sm.quantity, sm.movement_date,
      sm.reference_type, sm.reference_id, sm.notes, sm.location_from_id, sm.location_to_id,
      pv.id AS variation_id, pv.sku, pv.name AS variacion, p.name AS producto,
      lf.name AS ubic_from, lt.name AS ubic_to, u.name AS usuario
    FROM stock_movements sm
    JOIN product_variations pv ON pv.id = sm.product_variation_id
    JOIN products p ON p.id = pv.product_id
    LEFT JOIN locations lf ON lf.id = sm.location_from_id
    LEFT JOIN locations lt ON lt.id = sm.location_to_id
    LEFT JOIN users u ON u.id = sm.user_id
    ${whereSql}
    ORDER BY p.name, pv.name, pv.sku, sm.movement_date ASC, sm.id ASC`, p);

  if (!movs.length) return [];

  // Códigos de operación de entradas y transferencias (por reference_id)
  const entryIds = movs.filter(m => m.reference_type === 'App\\Models\\StockEntry').map(m => m.reference_id).filter(Boolean);
  const transferIds = movs.filter(m => m.reference_type === 'App\\Models\\StockTransfer').map(m => m.reference_id).filter(Boolean);
  const codEntradas = {}, codTransfer = {};
  if (entryIds.length) {
    const [rows] = await prodPool.query(
      `SELECT id, operation_type_code FROM stock_entries WHERE id IN (?)`, [[...new Set(entryIds)]]);
    rows.forEach(r => codEntradas[r.id] = r.operation_type_code);
  }
  if (transferIds.length) {
    const [rows] = await prodPool.query(
      `SELECT id, operation_type_code FROM stock_transfers WHERE id IN (?)`, [[...new Set(transferIds)]]);
    rows.forEach(r => codTransfer[r.id] = r.operation_type_code);
  }

  // Costo y precio de venta por (venta, variación) — para valorizar y margen
  const saleIds = movs.filter(m => m.reference_type === 'App\\Models\\Sale').map(m => m.reference_id).filter(Boolean);
  const ventaInfo = {}; // clave: `${saleId}_${variationId}`
  if (saleIds.length) {
    const [rows] = await prodPool.query(`
      SELECT si.sale_id, si.product_variation_id,
        SUM(si.quantity) AS qty, SUM(si.total) AS ingreso,
        SUM(CASE WHEN si.stock_batch_id IS NOT NULL THEN si.quantity * sb.cost_price ELSE 0 END) AS costo_total,
        MAX(CASE WHEN si.stock_batch_id IS NULL AND si.is_backorder = 1 THEN 1 ELSE 0 END) AS tiene_pedido,
        MAX(CASE WHEN si.stock_batch_id IS NULL THEN 1 ELSE 0 END) AS tiene_sin_lote
      FROM sale_items si
      LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
      WHERE si.sale_id IN (?)
      GROUP BY si.sale_id, si.product_variation_id`, [[...new Set(saleIds)]]);
    rows.forEach(r => {
      ventaInfo[`${r.sale_id}_${r.product_variation_id}`] = {
        precio_unit: r.qty > 0 ? Number(r.ingreso) / Number(r.qty) : 0,
        costo_unit: r.qty > 0 ? Number(r.costo_total) / Number(r.qty) : 0,
        tiene_pedido: !!r.tiene_pedido, tiene_sin_lote: !!r.tiene_sin_lote
      };
    });
  }

  // Cache de costo FIFO vigente para valorizar entradas/ajustes/transferencias
  const cacheFifo = {};
  const fifo = async (vid) => {
    if (!(vid in cacheFifo)) cacheFifo[vid] = await costoFifoVigente(prodPool, vid);
    return cacheFifo[vid];
  };

  // Construir filas con valorización, código SUNAT y alertas
  const filas = [];
  for (const m of movs) {
    // Código SUNAT según el tipo/origen
    let codigo = null;
    if (m.type === 'sale') codigo = '01';
    else if (m.type === 'adjustment') codigo = m.operation_type_code;
    else if (m.reference_type === 'App\\Models\\StockEntry') codigo = codEntradas[m.reference_id];
    else if (m.reference_type === 'App\\Models\\StockTransfer') codigo = codTransfer[m.reference_id];
    if (!codigo && m.operation_type_code) codigo = m.operation_type_code;

    // Valorización
    let costoUnit = null, precioUnit = null, margenUnit = null, alerta = '';
    if (m.type === 'sale') {
      const info = ventaInfo[`${m.reference_id}_${m.variation_id}`];
      if (info) {
        precioUnit = info.precio_unit;
        if (info.tiene_sin_lote && info.costo_unit === 0) {
          if (info.tiene_pedido) alerta = 'A pedido';
          else if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
          else alerta = 'Sin costo — revisar';
        } else {
          costoUnit = info.costo_unit;
          margenUnit = precioUnit - costoUnit;
        }
      }
    } else if (m.reference_type === 'App\\Models\\StockEntry') {
      // Entrada: costo del lote creado en esa entrada (costo real de compra)
      costoUnit = await costoDeEntrada(prodPool, m.reference_id, m.variation_id);
      if (costoUnit === null) costoUnit = await fifo(m.variation_id);
      if (costoUnit === null || costoUnit === 0) {
        if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
        else alerta = 'Sin costo — revisar';
      }
    } else {
      // Salidas no-venta, ajustes, transferencias: costo FIFO del lote más antiguo
      // con stock (de donde el sistema descuenta).
      costoUnit = await fifo(m.variation_id);
      if (costoUnit === null || costoUnit === 0) {
        if (/MKP|PCK/i.test(m.sku || '')) alerta = 'Sin costo (PCK/MKP, normal)';
        else alerta = 'Sin costo — revisar';
      }
    }

    const cant = Number(m.quantity);
    const valorMov = costoUnit != null ? costoUnit * cant : null;
    const ubicacion = m.type === 'purchase' || m.reference_type === 'App\\Models\\StockEntry'
      ? (m.ubic_to || m.ubic_from || '') : (m.ubic_from || m.ubic_to || '');

    filas.push({
      fecha: m.movement_date, producto: m.producto, variacion: m.variacion, sku: m.sku,
      variation_id: m.variation_id,
      tipo: TIPO_MOV_NOM[m.type] || m.type,
      codigo_sunat: codigo || '', codigo_nombre: codigo ? (CODIGOS_SUNAT[codigo] || '') : '',
      cantidad: cant,
      costo_unit: costoUnit, valor_mov: valorMov,
      precio_unit: precioUnit, margen_unit: margenUnit,
      ubicacion, usuario: m.usuario || '',
      documento: m.reference_type ? `${(m.reference_type.split('\\').pop())} #${m.reference_id}` : '',
      nota: m.notes || '', alerta
    });
  }

  // Saldo acumulado por producto (variación): cantidad y valor
  const saldoCant = {}, saldoVal = {};
  filas.forEach(f => {
    const k = f.variation_id;
    saldoCant[k] = (saldoCant[k] || 0) + f.cantidad;
    saldoVal[k] = (saldoVal[k] || 0) + (f.valor_mov || 0);
    f.saldo_cantidad = saldoCant[k];
    f.saldo_valor = saldoVal[k];
  });

  return filas;
}

// Filtros del kardex (no requiere lista fija; el filtro de producto es texto libre)
// Lista de productos/variaciones para el autocompletar del kardex
app.get('/admin/kardex/productos', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const [rows] = await prodPool.query(`
      SELECT pv.sku, pv.name AS variacion, p.name AS producto
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL AND pv.sku IS NOT NULL
      ORDER BY p.name, pv.name LIMIT 5000`);
    res.json({ productos: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/kardex', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const filas = await obtenerKardex(prodPool, req.query);
    res.json({ total: filas.length, filas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/kardex-excel', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const filas = await obtenerKardex(prodPool, req.query);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Kardex Valorizado');
    const soloFecha = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';

    // Cabecera informativa (título, fecha de exportación, filtros)
    const filasCab = cabeceraExcel(ws, 'Kardex Valorizado', [
      ['Desde', req.query.desde], ['Hasta', req.query.hasta],
      ['Producto', req.query.producto], ['SKU', req.query.sku],
      ['Movimientos', filas.length]
    ], 19);

    const colDefs = [
      { header: 'Fecha', width: 12 }, { header: 'Producto', width: 30 }, { header: 'Variación', width: 26 },
      { header: 'SKU', width: 18 }, { header: 'Tipo', width: 14 }, { header: 'Cód. SUNAT', width: 11 },
      { header: 'Operación', width: 24 }, { header: 'Cantidad', width: 10 }, { header: 'Costo unit.', width: 12 },
      { header: 'Valor mov.', width: 13 }, { header: 'Precio venta', width: 12 }, { header: 'Margen unit.', width: 12 },
      { header: 'Saldo cant.', width: 11 }, { header: 'Saldo valor', width: 13 }, { header: 'Ubicación', width: 18 },
      { header: 'Usuario', width: 18 }, { header: 'Documento', width: 18 }, { header: 'Nota', width: 40 },
      { header: 'Alerta', width: 22 }
    ];
    colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
    const headerRowNum = filasCab + 1;
    const hr = ws.addRow(colDefs.map(c => c.header));
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

    filas.forEach(f => {
      ws.addRow([
        soloFecha(f.fecha), f.producto, f.variacion, f.sku, f.tipo, f.codigo_sunat, f.codigo_nombre,
        f.cantidad, f.costo_unit != null ? f.costo_unit : '', f.valor_mov != null ? f.valor_mov : '',
        f.precio_unit != null ? f.precio_unit : '', f.margen_unit != null ? f.margen_unit : '',
        f.saldo_cantidad, f.saldo_valor, f.ubicacion, f.usuario, f.documento, f.nota, f.alerta
      ]);
    });
    ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
    ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: 19 } };
    [9, 10, 11, 12, 14].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

    // Totales por producto al final
    ws.addRow([]);
    const totProd = {};
    filas.forEach(f => {
      const k = f.producto + ' — ' + f.variacion;
      if (!totProd[k]) totProd[k] = { cant: 0, valor: 0 };
      totProd[k].cant += f.cantidad;
      totProd[k].valor += (f.valor_mov || 0);
    });
    const tRow = ws.addRow(['TOTALES POR PRODUCTO (saldo final)']); tRow.font = { bold: true };
    Object.entries(totProd).forEach(([k, v]) => {
      const r = ws.addRow(['', k]); r.getCell(8).value = v.cant; r.getCell(10).value = v.valor;
      r.getCell(10).numFmt = '#,##0.00';
    });

    const nombre = nombreTrazable('kardex');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar el kardex: ' + e.message }); }
});

app.get('/admin/reporte-pagos/filtros', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const [metodos] = await prodPool.query(
      `SELECT DISTINCT ci.id, ci.name FROM catalog_items ci
       JOIN sale_payments sp ON sp.payment_method_id = ci.id
       WHERE sp.voided_at IS NULL ORDER BY ci.name`);
    const [cuentas] = await prodPool.query(
      `SELECT ba.id, ba.account_number, banco.name AS banco
       FROM bank_accounts ba LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
       ORDER BY banco.name, ba.account_number`);
    res.json({
      metodos,
      cuentas: cuentas.map(c => ({ id: c.id, etiqueta: `${c.banco || 'Banco'} ${c.account_number}` })),
      empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id, nombre }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Función compartida: arma la lista de pagos según filtros
async function obtenerPagos(q) {
  const { desde, hasta, empresa, empresa_producto, cuenta, metodo } = q;
  const w = ['sp.voided_at IS NULL', 's.deleted_at IS NULL'];
  const p = [];
  if (desde && hasta) { w.push('DATE(sp.paid_at) BETWEEN ? AND ?'); p.push(desde, hasta); }
  if (empresa) { w.push('s.company_id = ?'); p.push(empresa); }
  if (cuenta) { w.push('sp.bank_account_id = ?'); p.push(cuenta); }
  if (metodo) { w.push('sp.payment_method_id = ?'); p.push(metodo); }

  const [pagos] = await prodPool.query(`
    SELECT sp.id, sp.paid_at, sp.amount, sp.notes AS nota_pago,
      s.id AS sale_id, s.code AS venta_codigo, s.company_id, s.observations AS obs_venta,
      s.created_at AS venta_fecha,
      CASE WHEN cli.is_company=1 THEN cli.business_name
           ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente_nombre,
      cli.document_number AS cliente_doc, cli.is_company AS cliente_es_empresa,
      mp.name AS metodo,
      ba.account_number, banco.name AS banco, ba.party_id AS cuenta_party_id,
      dueno.business_name AS empresa_cuenta,
      s.total AS venta_total,
      CASE WHEN cc.status='closed' THEN 'Cerrado' ELSE 'Sin cerrar' END AS cuadre
    FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id
    LEFT JOIN parties cli ON cli.id = s.customer_id
    LEFT JOIN catalog_items mp ON mp.id = sp.payment_method_id
    LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
    LEFT JOIN catalog_items banco ON banco.id = ba.bank_id
    LEFT JOIN parties dueno ON dueno.id = ba.party_id
    LEFT JOIN cash_closures cc ON cc.closure_date = DATE(sp.paid_at)
    WHERE ${w.join(' AND ')}
    ORDER BY sp.paid_at ASC`, p);

  if (!pagos.length) return [];

  const saleIds = [...new Set(pagos.map(x => x.sale_id))];

  // Empresa(s) del producto por venta: vía sale_items → stock_batches.company_id
  const [empresasProd] = await prodPool.query(`
    SELECT DISTINCT si.sale_id, sb.company_id
    FROM sale_items si JOIN stock_batches sb ON sb.id = si.stock_batch_id
    WHERE si.sale_id IN (?) AND si.stock_batch_id IS NOT NULL`, [saleIds]);
  const empProdPorVenta = {};
  empresasProd.forEach(r => {
    (empProdPorVenta[r.sale_id] = empProdPorVenta[r.sale_id] || new Set()).add(r.company_id);
  });

  // Comprobantes por venta
  const [vouchers] = await prodPool.query(`
    SELECT sale_id, type, serie, number FROM sale_vouchers WHERE sale_id IN (?)`, [saleIds]);
  const vouchPorVenta = {};
  vouchers.forEach(v => {
    const t = v.type === 'factura' ? 'Factura' : v.type === 'boleta' ? 'Boleta' : v.type;
    (vouchPorVenta[v.sale_id] = vouchPorVenta[v.sale_id] || []).push(`${t} ${v.serie}-${v.number}`);
  });

  // Total pagado HISTÓRICO de cada venta (todos sus pagos, sin filtro de fecha).
  // Con esto se calcula el saldo real que falta cobrar.
  const pagadoTotal = {};
  const [ph] = await prodPool.query(`
    SELECT sale_id, COALESCE(SUM(amount),0) AS pagado
    FROM sale_payments WHERE voided_at IS NULL AND sale_id IN (?)
    GROUP BY sale_id`, [saleIds]);
  ph.forEach(r => pagadoTotal[r.sale_id] = Number(r.pagado));

  // ¿Estas ventas tienen pagos FUERA del rango de fechas filtrado?
  // Sirve para avisar que el subtotal mostrado no es todo lo pagado de esa venta.
  const pagosFuera = {};
  if (desde && hasta) {
    const [fuera] = await prodPool.query(`
      SELECT sale_id, COUNT(*) AS n, COALESCE(SUM(amount),0) AS monto
      FROM sale_payments
      WHERE voided_at IS NULL AND sale_id IN (?)
        AND DATE(paid_at) NOT BETWEEN ? AND ?
      GROUP BY sale_id`, [saleIds, desde, hasta]);
    fuera.forEach(r => pagosFuera[r.sale_id] = { n: Number(r.n), monto: Number(r.monto) });
  }

  let lista = pagos.map(pg => {
    const empSet = empProdPorVenta[pg.sale_id];
    const empProd = empSet ? [...empSet].map(id => EMPRESAS_BI[id] || `Empresa ${id}`).join(', ') : '—';
    const fuera = pagosFuera[pg.sale_id];
    return {
      paid_at: pg.paid_at,
      cliente: pg.cliente_nombre && pg.cliente_nombre.trim() ? pg.cliente_nombre.trim() : '—',
      cliente_doc: pg.cliente_doc || '—',
      // El ERP no guarda el tipo de documento: se deduce por el largo (11 = RUC, 8 = DNI)
      cliente_doc_tipo: !pg.cliente_doc ? '—'
        : (String(pg.cliente_doc).length === 11 ? 'RUC'
          : String(pg.cliente_doc).length === 8 ? 'DNI' : 'Otro'),
      metodo: pg.metodo || 'Sin método',
      cuenta: pg.banco ? `${pg.banco} ${pg.account_number || ''}`.trim() : '—',
      empresa_cuenta: pg.empresa_cuenta || '—',
      venta: pg.venta_codigo,
      empresa_gestiona: pg.company_id != null ? (EMPRESAS_BI[pg.company_id] || `Empresa ${pg.company_id}`) : '(vacío)',
      empresa_producto: empProd,
      comprobante: (vouchPorVenta[pg.sale_id] || []).join(' · ') || '—',
      nota_pago: pg.nota_pago || '', obs_venta: pg.obs_venta || '',
      cuadre: pg.cuadre, monto: Number(pg.amount),
      venta_total: Number(pg.venta_total || 0),
      venta_pagado: pagadoTotal[pg.sale_id] || 0,
      venta_saldo: Math.max(0, Number(pg.venta_total || 0) - (pagadoTotal[pg.sale_id] || 0)),
      _sale_id: pg.sale_id,
      _pagos_fuera: fuera ? fuera.n : 0,
      _monto_fuera: fuera ? fuera.monto : 0,
      _empresas_prod_ids: empSet ? [...empSet] : []
    };
  });

  // Filtro por empresa del producto (se aplica en memoria porque puede haber varias)
  if (empresa_producto) {
    lista = lista.filter(x => x._empresas_prod_ids.includes(Number(empresa_producto)));
  }
  lista.forEach(x => delete x._empresas_prod_ids);

  // Agrupar por venta manteniendo el orden cronológico DENTRO de cada venta.
  // Las ventas se ordenan por la fecha de su primer pago (para que el reporte
  // siga una línea de tiempo natural).
  const primerPago = {};
  lista.forEach(x => {
    const t = new Date(x.paid_at).getTime();
    if (primerPago[x._sale_id] == null || t < primerPago[x._sale_id]) primerPago[x._sale_id] = t;
  });
  lista.sort((a, b) => {
    const d = primerPago[a._sale_id] - primerPago[b._sale_id];
    if (d !== 0) return d;
    if (a._sale_id !== b._sale_id) return a._sale_id - b._sale_id;
    return new Date(a.paid_at) - new Date(b.paid_at);
  });

  // Total de cada venta (suma de los pagos que cumplen los filtros)
  const totalVenta = {};
  lista.forEach(x => totalVenta[x._sale_id] = (totalVenta[x._sale_id] || 0) + x.monto);
  lista.forEach(x => x._total_venta = totalVenta[x._sale_id]);

  return lista;
}

app.get('/admin/reporte-pagos', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const lista = await obtenerPagos(req.query);
    res.json({ total: lista.length, suma: lista.reduce((s, x) => s + x.monto, 0), pagos: lista });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/reporte-pagos-excel', authAdmin, requiereModulo('reportes'), async (req, res) => {
  try {
    const lista = await obtenerPagos(req.query);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pagos');
    const fechaLima = (d) => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '';

    // Empresa(s) que gestiona(n): si filtró por una, esa; si no, las presentes en el resultado
    let empresaGestionaTxt;
    if (req.query.empresa) {
      empresaGestionaTxt = EMPRESAS_BI[req.query.empresa] || `Empresa ${req.query.empresa}`;
    } else {
      const setEmp = [...new Set(lista.map(x => x.empresa_gestiona))];
      empresaGestionaTxt = setEmp.length ? setEmp.join(', ') : 'Todas';
    }

    const colDefs = [
      { header: 'Fecha', width: 18 }, { header: 'Cliente', width: 32 },
      { header: 'Tipo doc.', width: 10 }, { header: 'DNI/RUC', width: 15 },
      { header: 'Método', width: 18 }, { header: 'Cuenta destino', width: 28 },
      { header: 'Empresa dueña de la cuenta', width: 28 }, { header: 'Venta', width: 15 },
      { header: 'Empresa que gestiona', width: 26 }, { header: 'Empresa(s) del producto', width: 28 },
      { header: 'Comprobante', width: 28 }, { header: 'Nota del pago', width: 34 },
      { header: 'Observación de venta', width: 34 }, { header: 'Cierre de caja', width: 14 },
      { header: 'Monto pagado', width: 14 },
      { header: 'Cobrado en el rango', width: 18 }, { header: 'Saldo por cobrar', width: 16 },
      { header: 'Pagos fuera del rango', width: 22 }
    ];

    // Cabecera informativa
    const filasCab = cabeceraExcel(ws, 'Reporte de pagos', [
      ['Empresa que gestiona', empresaGestionaTxt],
      ['Desde', req.query.desde], ['Hasta', req.query.hasta],
      ['Cuenta', req.query.cuenta ? 'filtrada' : ''], ['Método', req.query.metodo ? 'filtrado' : ''],
      ['Pagos', lista.length],
      ['IMPORTANTE', 'Todos los pagos listados son dinero YA RECIBIDO. "Cierre de caja" indica si el cierre administrativo del día se realizó, NO si el pago está pendiente.']
    ], 18);
    colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
    const headerRowNum = filasCab + 1;
    const hr = ws.addRow(colDefs.map(c => c.header));
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

    // Una fila por pago (plano, apto para filtrar y tablas dinámicas).
    // "Total venta" se repite en las filas de la misma venta a propósito.
    lista.forEach(x => {
      ws.addRow([
        fechaLima(x.paid_at), x.cliente, x.cliente_doc_tipo, x.cliente_doc, x.metodo, x.cuenta,
        x.empresa_cuenta, x.venta, x.empresa_gestiona, x.empresa_producto, x.comprobante,
        x.nota_pago, x.obs_venta, x.cuadre, x.monto, x._total_venta, x.venta_saldo,
        x._pagos_fuera > 0 ? `${x._pagos_fuera} pago(s): S/ ${x._monto_fuera.toFixed(2)}` : ''
      ]);
    });
    ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
    ws.autoFilter = { from: { row: headerRowNum, column: 1 }, to: { row: headerRowNum, column: 18 } };
    [15, 16, 17].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');

    // Totalizadores
    ws.addRow([]);
    const totEmpF = {}, totCta = {}, totMet = {}, totEmpC = {};
    lista.forEach(x => {
      totEmpF[x.empresa_gestiona] = (totEmpF[x.empresa_gestiona] || 0) + x.monto;
      totCta[x.cuenta] = (totCta[x.cuenta] || 0) + x.monto;
      totMet[x.metodo] = (totMet[x.metodo] || 0) + x.monto;
      totEmpC[x.empresa_cuenta] = (totEmpC[x.empresa_cuenta] || 0) + x.monto;
    });
    const bloque = (titulo, obj) => {
      const r = ws.addRow([titulo]); r.font = { bold: true };
      Object.entries(obj).forEach(([k, v]) => {
        const row = ws.addRow(['', k]); row.getCell(15).value = v; row.getCell(15).numFmt = '#,##0.00';
      });
    };
    bloque('TOTALES POR EMPRESA DUEÑA DE LA CUENTA', totEmpC);
    bloque('TOTALES POR EMPRESA QUE GESTIONA', totEmpF);
    bloque('TOTALES POR CUENTA', totCta);
    bloque('TOTALES POR MÉTODO', totMet);
    const g = ws.addRow(['TOTAL GENERAL']); g.font = { bold: true };
    g.getCell(15).value = lista.reduce((s, x) => s + x.monto, 0); g.getCell(15).numFmt = '#,##0.00';

    const nombre = nombreTrazable('pagos');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
});

app.get('/admin/reporte-sync', authAdmin, requiereModulo('sync'), async (req, res) => {
  try {
    // ── Última corrida del puente ──────────────────────────────────────────
    let ultimaCorrida = null;
    try {
      const [[c]] = await portalPool.query(
        `SELECT corrio_en, productos_actualizados, productos_error, modo
         FROM sync_corridas ORDER BY id DESC LIMIT 1`);
      if (c) ultimaCorrida = c;
    } catch (e) { /* la tabla puede no existir aún */ }

    // ── Detalle de la corrida: variaciones (todo lo que cambió) y aplicados ─
    let variaciones = [], aplicados = [];
    try {
      const [rows] = await portalPool.query(
        `SELECT variation_id, woocommerce_id, tipo, stock_antes, precio_antes,
                stock_despues, precio_despues, se_aplico
         FROM sync_detalle ORDER BY se_aplico DESC, woocommerce_id`);
      variaciones = rows;
      aplicados = rows.filter(r => r.se_aplico === 1);
    } catch (e) { /* sin detalle aún */ }

    // Enriquecer variaciones/aplicados con SKU y nombre del ERP
    const idsDet = [...new Set(variaciones.map(v => v.woocommerce_id).filter(Boolean))];
    const infoDet = {};
    if (idsDet.length) {
      const [info] = await prodPool.query(
        `SELECT pv.woocommerce_id, pv.sku, pv.name AS nombre, pv.product_type
         FROM product_variations pv WHERE pv.woocommerce_id IN (?)`, [idsDet]);
      info.forEach(i => { infoDet[i.woocommerce_id] = i; });
    }
    const armaFila = (v) => {
      const inf = infoDet[v.woocommerce_id] || {};
      return {
        sku: inf.sku || '', wc: v.woocommerce_id, tipo: inf.product_type || v.tipo,
        nombre: inf.nombre || '',
        stock_despues: v.stock_despues, precio_despues: v.precio_despues,
        stock_antes: v.stock_antes, precio_antes: v.precio_antes
      };
    };
    const filasVariaciones = variaciones.map(armaFila);
    const filasAplicados = aplicados.map(armaFila);

    // (Pendientes y Alertas del sistema se movieron a la Auditoría de catálogo)

    // ── PESTAÑA 4: Alertas de vinculación con WooCommerce ──────────────────
    let alertasSku = [];
    try {
      const [rows] = await portalPool.query(
        `SELECT woocommerce_id, sku_erp, sku_woo FROM sync_sku_alertas ORDER BY sku_erp`);
      alertasSku = rows.map(r => ({
        tipo: 'SKU no coincide', sku: r.sku_erp, wc: r.woocommerce_id, nombre: '',
        obs: `El SKU en la web es "${r.sku_woo}" pero en el ERP es "${r.sku_erp}" (no se actualizó)`
      }));
    } catch (e) { /* sin datos aún */ }

    // ── Generar Excel ──────────────────────────────────────────────────────
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const estiloHeader = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      row.alignment = { vertical: 'middle' };
    };
    let textoCorrida;
    if (ultimaCorrida) {
      const f = new Date(ultimaCorrida.corrio_en).toLocaleString('es-PE', { timeZone: 'America/Lima' });
      textoCorrida = `Última sincronización del puente: ${f}` +
        ` (${ultimaCorrida.productos_actualizados} actualizados, ${ultimaCorrida.productos_error} con error` +
        (ultimaCorrida.modo === 'simulacion' ? ', modo simulación' : '') + ')';
    } else {
      textoCorrida = 'Última sincronización del puente: aún no ha corrido.';
    }
    const textoReporte = `Reporte generado: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`;
    const ponerEncabezado = (ws, nCols) => {
      ws.insertRow(1, [textoCorrida]);
      ws.insertRow(2, [textoReporte]);
      ws.mergeCells(1, 1, 1, nCols);
      ws.mergeCells(2, 1, 2, nCols);
      ws.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
      ws.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    };
    const num = (v) => v === null || v === undefined ? '' : Number(v);

    // PESTAÑA 1: Variaciones (lo que cambió)
    const ws1 = wb.addWorksheet('Variaciones');
    ws1.columns = [
      { header: 'SKU', key: 'sku', width: 22 },
      { header: 'WooCommerce ID', key: 'wc', width: 15 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 42 },
      { header: 'Stock anterior', key: 'sa', width: 13 },
      { header: 'Stock aplicado', key: 'sd', width: 13 },
      { header: 'Precio anterior', key: 'pa', width: 14 },
      { header: 'Precio aplicado', key: 'pd', width: 14 }
    ];
    filasVariaciones.forEach(f => ws1.addRow({
      sku: f.sku, wc: f.wc, tipo: f.tipo, nombre: f.nombre,
      sa: num(f.stock_antes), sd: num(f.stock_despues),
      pa: num(f.precio_antes), pd: num(f.precio_despues)
    }));
    ponerEncabezado(ws1, 8);
    estiloHeader(ws1.getRow(3));
    ws1.views = [{ state: 'frozen', ySplit: 3 }];

    // PESTAÑA 4: Alertas de vinculación (WooCommerce)
    const ws4 = wb.addWorksheet('Alertas de vinculación');
    ws4.columns = [
      { header: 'Tipo de alerta', key: 'tipo', width: 18 },
      { header: 'SKU (ERP)', key: 'sku', width: 22 },
      { header: 'WooCommerce ID', key: 'wc', width: 15 },
      { header: 'Observación', key: 'obs', width: 60 }
    ];
    alertasSku.forEach(a => ws4.addRow({ tipo: a.tipo, sku: a.sku, wc: a.wc, obs: a.obs }));
    ponerEncabezado(ws4, 4);
    estiloHeader(ws4.getRow(3));
    ws4.views = [{ state: 'frozen', ySplit: 3 }];
    const uf4 = ws4.rowCount;
    ws4.autoFilter = { from: { row: 3, column: 1 }, to: { row: uf4 < 3 ? 3 : uf4, column: 4 } };

    // PESTAÑA 5: Actualizados en WooCommerce (los que sí se aplicaron)
    const ws5 = wb.addWorksheet('Actualizados en WooCommerce');
    ws5.columns = [
      { header: 'SKU', key: 'sku', width: 22 },
      { header: 'WooCommerce ID', key: 'wc', width: 15 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 42 },
      { header: 'Stock anterior', key: 'sa', width: 13 },
      { header: 'Stock aplicado', key: 'sd', width: 13 },
      { header: 'Precio anterior', key: 'pa', width: 14 },
      { header: 'Precio aplicado', key: 'pd', width: 14 }
    ];
    filasAplicados.forEach(f => ws5.addRow({
      sku: f.sku, wc: f.wc, tipo: f.tipo, nombre: f.nombre,
      sa: num(f.stock_antes), sd: num(f.stock_despues),
      pa: num(f.precio_antes), pd: num(f.precio_despues)
    }));
    ponerEncabezado(ws5, 8);
    estiloHeader(ws5.getRow(3));
    ws5.views = [{ state: 'frozen', ySplit: 3 }];

    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_sync_${fecha}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
});

// Asegura la tabla que guarda el último análisis de auditoría
async function asegurarTablaAuditoria() {
  await portalPool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_cache (
      id INT PRIMARY KEY DEFAULT 1,
      generado_en DATETIME,
      resultado LONGTEXT
    )
  `);
}

// ─── Auditoría de catálogo en pantalla (JSON) ────────────────────────────────
// force=1 → recalcula y guarda; sin force → devuelve el último guardado (si existe)
app.get('/admin/auditoria', authAdmin, requiereModulo('auditoria'), async (req, res) => {
  try {
    await asegurarTablaAuditoria();
    const forzar = req.query.force === '1';

    if (!forzar) {
      // Intentar devolver el último análisis guardado
      const [[row]] = await portalPool.query(
        'SELECT generado_en, resultado FROM auditoria_cache WHERE id = 1');
      if (row && row.resultado) {
        const data = JSON.parse(row.resultado);
        data.generado_en = row.generado_en;
        data.desde_cache = true;
        return res.json(data);
      }
      // No hay guardado aún → avisar que hay que analizar
      return res.json({ sin_analisis: true });
    }

    // Forzar: recalcular
    const { pendientes, alertas } = await calcularAuditoria();
    const conteo = {};
    alertas.forEach(a => { conteo[a.tipo] = (conteo[a.tipo] || 0) + 1; });
    const data = {
      generado_en: new Date(),
      total_pendientes: pendientes.length,
      total_alertas: alertas.length,
      conteo_por_tipo: conteo,
      pendientes: pendientes.map(p => ({
        sku: p.sku, tipo: p.product_type, nombre: p.nombre || '',
        precio: p.regular_price === null ? null : Number(p.regular_price), stock: p.stock,
        ingreso_pendiente: !!p.ingreso_pendiente
      })),
      alertas
    };
    // Guardar (sobrescribe el anterior)
    await portalPool.query(
      `INSERT INTO auditoria_cache (id, generado_en, resultado) VALUES (1, NOW(), ?)
       ON DUPLICATE KEY UPDATE generado_en = NOW(), resultado = VALUES(resultado)`,
      [JSON.stringify(data)]);
    data.desde_cache = false;
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Error al analizar el catálogo: ' + e.message }); }
});

// ─── Auditoría de catálogo en Excel (2 pestañas) ─────────────────────────────
// ── CHEQUEO: coherencia de empresa vendedora vs dueño de los productos ──
// Detecta: (1) ventas sin empresa vendedora, (2) ventas donde algún producto
// pertenece a otra empresa, (3) productos sin lote (sin dueño identificable).
// Solo LECTURA: no corrige nada en el ERP, solo lista para revisar.
async function obtenerChequeoEmpresas(q) {
  const { tipo } = q; // 'sin_empresa' | 'no_coincide' | 'sin_lote' | undefined (todos)
  const [rows] = await prodPool.query(`
    SELECT s.id, s.code, s.company_id AS empresa_venta, s.status, s.created_at, s.total,
      si.id AS item_id, si.is_backorder, si.pending_stock_entry_id,
      sb.company_id AS empresa_producto,
      pv.sku, p.name AS producto
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
    LEFT JOIN product_variations pv ON pv.id = si.product_variation_id
    LEFT JOIN products p ON p.id = pv.product_id
    WHERE s.deleted_at IS NULL AND s.status != 'cancelled'
    ORDER BY s.created_at DESC`);

  // Agrupar por venta
  const porVenta = {};
  rows.forEach(r => {
    if (!porVenta[r.id]) {
      porVenta[r.id] = {
        id: r.id, code: r.code, empresa_venta: r.empresa_venta,
        status: r.status, fecha: r.created_at, total: Number(r.total),
        items: [], problemas: new Set()
      };
    }
    const v = porVenta[r.id];
    const aPedido = !!(r.is_backorder || r.pending_stock_entry_id);
    v.items.push({
      sku: r.sku || '—', producto: r.producto || '—',
      empresa_producto: r.empresa_producto, a_pedido: aPedido
    });
    // Detectar problemas
    if (r.empresa_venta == null) v.problemas.add('sin_empresa');
    if (r.empresa_producto == null) v.problemas.add('sin_lote');
    else if (r.empresa_venta != null && Number(r.empresa_producto) !== Number(r.empresa_venta)) {
      v.problemas.add('no_coincide');
    }
  });

  let lista = Object.values(porVenta)
    .filter(v => v.problemas.size > 0)
    .map(v => ({
      ...v,
      problemas: [...v.problemas],
      empresas_producto: [...new Set(v.items.map(i => i.empresa_producto).filter(x => x != null))],
      num_items: v.items.length
    }));

  if (tipo) lista = lista.filter(v => v.problemas.includes(tipo));
  return lista;
}

app.get('/admin/chequeo-empresas', authAdmin, requiereModulo('auditoria'), async (req, res) => {
  try {
    const lista = await obtenerChequeoEmpresas(req.query);
    const conteo = { sin_empresa: 0, no_coincide: 0, sin_lote: 0 };
    lista.forEach(v => v.problemas.forEach(p => conteo[p] = (conteo[p] || 0) + 1));
    res.json({ total: lista.length, conteo, ventas: lista.slice(0, 500) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/chequeo-empresas-excel', authAdmin, requiereModulo('auditoria'), async (req, res) => {
  try {
    const lista = await obtenerChequeoEmpresas(req.query);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Chequeo empresas');
    const fechaLima = (d) => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';
    const NOMBRE_PROB = { sin_empresa: 'Sin empresa vendedora', no_coincide: 'Empresa no coincide', sin_lote: 'Producto sin lote' };

    const filasCab = cabeceraExcel(ws, 'Chequeo de empresa en ventas', [
      ['Filtro', req.query.tipo ? NOMBRE_PROB[req.query.tipo] : 'Todos'],
      ['Ventas con problema', lista.length]
    ], 8);
    const colDefs = [
      { header: 'Venta', width: 15 }, { header: 'Fecha', width: 12 }, { header: 'Estado', width: 15 },
      { header: 'Empresa vendedora', width: 26 }, { header: 'Empresa(s) del producto', width: 26 },
      { header: 'Problema(s)', width: 40 }, { header: 'Items', width: 8 }, { header: 'Total', width: 13 }
    ];
    colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
    const hr = ws.addRow(colDefs.map(c => c.header));
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };

    lista.forEach(v => ws.addRow([
      v.code, fechaLima(v.fecha), v.status,
      v.empresa_venta != null ? (EMPRESAS_BI[v.empresa_venta] || 'Empresa ' + v.empresa_venta) : '(vacío)',
      v.empresas_producto.length ? v.empresas_producto.map(e => EMPRESAS_BI[e] || 'Empresa ' + e).join(', ') : '(sin lote)',
      v.problemas.map(p => NOMBRE_PROB[p] || p).join(' · '),
      v.num_items, v.total
    ]));
    ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
    ws.getColumn(8).numFmt = '#,##0.00';

    const nombre = nombreTrazable('chequeo-empresas');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
});

app.get('/admin/auditoria-excel', authAdmin, requiereModulo('auditoria'), async (req, res) => {
  try {
    const { pendientes, alertas } = await calcularAuditoria();
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const estiloHeader = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      row.alignment = { vertical: 'middle' };
    };
    const textoGen = `Auditoría generada: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`;
    const ponerEncabezado = (ws, nCols) => {
      ws.insertRow(1, [textoGen]);
      ws.mergeCells(1, 1, 1, nCols);
      ws.getRow(1).font = { italic: true, color: { argb: 'FF555555' } };
    };

    // Pestaña Pendientes
    const ws1 = wb.addWorksheet('Pendientes');
    ws1.columns = [
      { header: 'SKU', key: 'sku', width: 22 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 45 },
      { header: 'Precio regular', key: 'precio', width: 15 },
      { header: 'Stock', key: 'stock', width: 10 },
      { header: 'Ingreso pendiente', key: 'ing', width: 16 }
    ];
    pendientes.forEach(p => ws1.addRow({
      sku: p.sku, tipo: p.product_type, nombre: p.nombre || '',
      precio: p.regular_price === null ? '' : Number(p.regular_price), stock: p.stock,
      ing: p.ingreso_pendiente ? 'Sí' : 'No'
    }));
    ponerEncabezado(ws1, 6);
    estiloHeader(ws1.getRow(2));
    ws1.views = [{ state: 'frozen', ySplit: 2 }];

    // Pestaña Alertas del sistema (con filtro)
    const ws2 = wb.addWorksheet('Alertas del sistema');
    ws2.columns = [
      { header: 'Tipo de alerta', key: 'tipo', width: 22 },
      { header: 'SKU', key: 'sku', width: 22 },
      { header: 'WooCommerce ID', key: 'wc', width: 15 },
      { header: 'Nombre', key: 'nombre', width: 38 },
      { header: 'Observación', key: 'obs', width: 55 }
    ];
    alertas.forEach(a => ws2.addRow({ tipo: a.tipo, sku: a.sku, wc: a.wc, nombre: a.nombre, obs: a.obs }));
    ponerEncabezado(ws2, 5);
    estiloHeader(ws2.getRow(2));
    ws2.views = [{ state: 'frozen', ySplit: 2 }];
    const uf = ws2.rowCount;
    ws2.autoFilter = { from: { row: 2, column: 1 }, to: { row: uf < 2 ? 2 : uf, column: 5 } };

    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="auditoria_catalogo_${fecha}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar la auditoría: ' + e.message }); }
});

// Solicitar una actualización completa (se aplicará en la corrida de las 2 AM)
app.post('/admin/solicitar-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
  try {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS sync_solicitudes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        solicitado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        atendida TINYINT(1) DEFAULT 0,
        atendida_en DATETIME NULL
      )`);
    // Si ya hay una pendiente, no duplicar
    const [[pend]] = await portalPool.query(
      `SELECT id, solicitado_en FROM sync_solicitudes WHERE atendida = 0 ORDER BY id ASC LIMIT 1`);
    if (pend) {
      return res.json({ ok: true, ya_existia: true,
        mensaje: 'Ya hay una solicitud pendiente. Se aplicará en la próxima sincronización de las 2 AM.' });
    }
    await portalPool.query('INSERT INTO sync_solicitudes () VALUES ()');
    res.json({ ok: true, ya_existia: false,
      mensaje: 'Solicitud registrada. Se aplicará en la próxima sincronización de las 2 AM (hora Perú).' });
  } catch (e) { res.status(500).json({ error: 'Error al registrar la solicitud: ' + e.message }); }
});

// Estado de la solicitud (para mostrar en el admin)
app.get('/admin/estado-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
  try {
    const [[pend]] = await portalPool.query(
      `SELECT solicitado_en FROM sync_solicitudes WHERE atendida = 0 ORDER BY id ASC LIMIT 1`);
    res.json({ pendiente: !!pend, solicitado_en: pend ? pend.solicitado_en : null });
  } catch (e) { res.json({ pendiente: false }); }
});

// Cancelar la solicitud de actualización completa pendiente (antes de que corra a las 2 AM)
app.post('/admin/cancelar-actualizacion', authAdmin, requiereModulo('sync'), async (req, res) => {
  try {
    const [r] = await portalPool.query(
      `UPDATE sync_solicitudes SET atendida = 1, atendida_en = NOW() WHERE atendida = 0`);
    res.json({ ok: true, canceladas: r.affectedRows || 0 });
  } catch (e) { res.status(500).json({ error: 'Error al cancelar: ' + e.message }); }
});

// ─── Ver accesos (SOLO admin maestro) — lectura de las variables de Railway ──
app.get('/admin/accesos', authAdmin, soloMaestro, async (req, res) => {
  const secundarios = leerAdminsSecundarios();
  res.json({
    modulos_disponibles: MODULOS_ADMIN,
    usuarios: secundarios.map(a => ({ username: a.usuario, modulos: a.modulos }))
  });
});

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
const EMPRESAS_BI = { 1: 'Diseños Corporativos SAC', 2: 'Christopher Villasante F.' };
const VV = "('paid','confirmed','pending_payment')";
const KOMMO_GANADO = 142, KOMMO_PERDIDO = 143;

const GANANCIA_NORMAL = `
  CASE WHEN si.stock_batch_id IS NOT NULL
       THEN (si.total - si.quantity * sb.cost_price)
       ELSE 0 END`;
const ES_NORMAL = `si.stock_batch_id IS NOT NULL`;
const ES_PEDIDO = `(si.stock_batch_id IS NULL AND si.is_backorder = 1)`;
const ES_FALLA  = `(si.stock_batch_id IS NULL AND si.is_backorder = 0)`;

const kommoFetch = (endpoint) => new Promise((resolve, reject) => {
  const req = https.request({
    hostname: process.env.KOMMO_DOMAIN, path: `/api/v4/${endpoint}`, family: 4,
    headers: { 'Authorization': `Bearer ${process.env.KOMMO_TOKEN}` }
  }, (r) => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { if (!d.trim()) return resolve({}); try { resolve(JSON.parse(d)); } catch(e){ reject(new Error('Kommo parse '+r.statusCode)); } });
  });
  req.on('error', reject); req.end();
});

// Registro de endpoints del dashboard (inyectado directamente)
(function(){

  const mResumen = requiereModulo('resumen');
  const mRent = requiereModulo('rentabilidad');
  const mInv = requiereModulo('inventario');
  const mRestock = requiereModulo('restock');
  const mClientes = requiereModulo('clientes_bi');
  const mCaja = requiereModulo('caja_bi');
  const mCrm = requiereModulo('crm');
  const rango = (desde, hasta, campo='s.created_at') =>
    desde && hasta ? `AND ${campo} BETWEEN '${desde}' AND '${hasta} 23:59:59'` : '';

  // ── RESUMEN / KPIs ──
  app.get('/api/kpis', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [[ventas]] = await prodPool.query(`
        SELECT COUNT(*) AS num_ventas, COALESCE(SUM(total),0) AS valor_ventas,
               COALESCE(AVG(total),0) AS ticket_promedio, COUNT(DISTINCT customer_id) AS clientes_unicos
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const [[recaudado]] = await prodPool.query(`
        SELECT COALESCE(SUM(sp.amount),0) AS dinero_recaudado
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE sp.voided_at IS NULL AND s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const [[canc]] = await prodPool.query(`
        SELECT COUNT(*) AS canceladas FROM sales s WHERE s.deleted_at IS NULL AND s.status='cancelled' ${f}`);
      const valorVentas = parseFloat(ventas.valor_ventas), recaud = parseFloat(recaudado.dinero_recaudado);
      res.json({ ...ventas, ...recaudado, ...canc, por_cobrar: Math.max(0, valorVentas - recaud) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kpis-empresas', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT s.company_id, COUNT(*) AS num_ventas, COALESCE(SUM(s.total),0) AS valor_ventas,
               COALESCE(AVG(s.total),0) AS ticket_promedio
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY s.company_id ORDER BY s.company_id`);
      res.json(rows.map(r => ({ ...r, empresa: EMPRESAS_BI[r.company_id] || `Empresa ${r.company_id}` })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/ventas-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND s.created_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND s.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(s.created_at) AS fecha, s.company_id, COUNT(*) AS cantidad, COALESCE(SUM(s.total),0) AS total
        FROM sales s WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY DATE(s.created_at), s.company_id ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ingresos realmente cobrados por día, separados por la empresa DUEÑA DE LA CUENTA
  // donde entró el pago (misma lógica que el cierre de caja). Si el pago no tiene
  // cuenta asignada, se cae al company_id de la venta.
  app.get('/api/ingresos-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(sp.paid_at) AS fecha,
          COALESCE(ba.party_id, s.company_id) AS company_id,
          COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp
        LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE sp.voided_at IS NULL ${f}
        GROUP BY DATE(sp.paid_at), COALESCE(ba.party_id, s.company_id)
        ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Margen de ganancia (FIFO) por día, separado por la empresa que gestiona la venta.
  // Usa la misma lógica GANANCIA_NORMAL de Rentabilidad: precio de venta menos costo
  // del lote. Los productos sin lote (a pedido/falla) aportan 0, igual que allá.
  app.get('/api/margen-por-dia', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND s.created_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND s.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT DATE(s.created_at) AS fecha, s.company_id,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS total
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN stock_batches sb ON sb.id = si.stock_batch_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY DATE(s.created_at), s.company_id
        ORDER BY fecha ASC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── RENTABILIDAD FIFO ──
  app.get('/api/rentabilidad', authAdmin, mRent, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [[r]] = await prodPool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.quantity * sb.cost_price ELSE 0 END),0) AS costo,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}`);
      const ing = parseFloat(r.ingreso_confiable), gan = parseFloat(r.ganancia);
      res.json({ ...r, margen_promedio: ing > 0 ? ((gan / ing) * 100).toFixed(1) : '0.0' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/top-productos', authAdmin, mRent, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.name AS variacion, pv.sku,
          SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY pv.id, p.name, pv.name, pv.sku ORDER BY ganancia DESC LIMIT 15`);
      res.json(rows.map(r => ({ ...r, estado: r.lineas_pedido > 0 ? 'a_pedido' : r.lineas_falla > 0 ? 'sin_costo' : 'normal' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/marcas', authAdmin, mRent, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT SUBSTRING_INDEX(p.name,' ',1) AS marca,
          COUNT(DISTINCT s.id) AS ventas, SUM(si.quantity) AS unidades, COALESCE(SUM(si.total),0) AS ingreso,
          COALESCE(SUM(${GANANCIA_NORMAL}),0) AS ganancia,
          COALESCE(SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END),0) AS ingreso_confiable,
          COALESCE(SUM(CASE WHEN ${ES_PEDIDO} THEN si.total ELSE 0 END),0) AS ingreso_pendiente,
          COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
          COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f}
        GROUP BY marca HAVING ingreso > 0 ORDER BY ganancia DESC`);
      res.json(rows.map(r => {
        const ingConf = parseFloat(r.ingreso_confiable), gan = parseFloat(r.ganancia);
        return { ...r, margen: ingConf > 0 ? ((gan/ingConf)*100).toFixed(1) : '0.0' };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── INVENTARIO ──
  // ── CANDIDATOS A PROMOCIÓN ──
  // Analiza stock y ventas para sugerir qué productos convendría promocionar.
  // Criterios: estancado | sobrestock | margen_lento | lote_antiguo | casi_agotado
  async function obtenerPromoCandidatos(criterio, filtros) {
    filtros = filtros || {};
    {
      // Base: stock actual + costo por variación (lotes con existencia)
      const [stock] = await prodPool.query(`
        SELECT sb.product_variation_id,
          SUM(sb.quantity) AS stock,
          SUM(sb.quantity * sb.cost_price) AS capital,
          MIN(sb.entry_date) AS lote_mas_antiguo,
          MAX(sb.cost_price) AS costo_ref
        FROM stock_batches sb
        WHERE sb.quantity > 0
        GROUP BY sb.product_variation_id`);
      if (!stock.length) return { criterio, total: 0, capital_total: 0, items: [] };
      const ids = stock.map(r => r.product_variation_id);

      // Ventas de los últimos 12 meses por variación (unidades y última venta)
      const [ventas] = await prodPool.query(`
        SELECT si.product_variation_id,
          SUM(si.quantity) AS unidades_12m,
          MAX(s.created_at) AS ultima_venta,
          AVG(si.unit_price) AS precio_prom
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
          AND si.product_variation_id IN (?)
        GROUP BY si.product_variation_id`, [ids]);
      const vMap = {};
      ventas.forEach(v => vMap[v.product_variation_id] = v);

      // Nombres
      const [nombres] = await prodPool.query(`
        SELECT pv.id, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (?)`, [ids]);
      const nMap = {};
      nombres.forEach(n => nMap[n.id] = n);

      const hoy = Date.now();
      const dias = f => f ? Math.floor((hoy - new Date(f).getTime()) / 864e5) : null;

      let items = stock.map(r => {
        const v = vMap[r.product_variation_id] || {};
        const n = nMap[r.product_variation_id] || {};
        const stockN = Number(r.stock);
        const und12 = Number(v.unidades_12m || 0);
        const ritmoMes = und12 / 12; // unidades por mes
        const mesesParaAgotar = ritmoMes > 0 ? stockN / ritmoMes : null;
        const precio = v.precio_prom != null ? Number(v.precio_prom) : null;
        const costo = r.costo_ref != null ? Number(r.costo_ref) : null;
        const margenPct = (precio && costo && precio > 0) ? ((precio - costo) / precio * 100) : null;
        const marca = (n.producto || '').trim().split(/\s+/)[0] || '—';
        return {
          sku: n.sku || '—',
          marca,
          producto: (n.producto || '') + (n.variacion && n.variacion !== n.producto ? ' — ' + n.variacion : ''),
          stock: stockN,
          capital: Number(r.capital || 0),
          dias_sin_venta: dias(v.ultima_venta),           // null = nunca vendió en 12m
          dias_lote_antiguo: dias(r.lote_mas_antiguo),
          unidades_12m: und12,
          meses_para_agotar: mesesParaAgotar != null ? Math.round(mesesParaAgotar * 10) / 10 : null,
          precio_prom: precio, costo: costo,
          margen_pct: margenPct != null ? Math.round(margenPct) : null
        };
      });

      // Aplicar el criterio elegido
      const F = {
        estancado: x => x.stock > 0 && (x.dias_sin_venta == null || x.dias_sin_venta >= 120),
        sobrestock: x => x.meses_para_agotar != null && x.meses_para_agotar >= 12,
        margen_lento: x => x.margen_pct != null && x.margen_pct >= 40 && (x.dias_sin_venta == null || x.dias_sin_venta >= 60),
        lote_antiguo: x => x.dias_lote_antiguo != null && x.dias_lote_antiguo >= 365,
        casi_agotado: x => x.stock > 0 && x.stock <= 3 && x.unidades_12m >= 6
      };
      const filtro = F[criterio] || F.estancado;
      items = items.filter(filtro);

      // Lista de marcas disponibles ANTES de los filtros extra (para el desplegable)
      const marcas = [...new Set(items.map(x => x.marca))].sort();

      // Filtros adicionales opcionales
      if (filtros.marca) items = items.filter(x => x.marca.toLowerCase() === filtros.marca.toLowerCase());
      if (filtros.margen_min) items = items.filter(x => x.margen_pct != null && x.margen_pct >= Number(filtros.margen_min));
      if (filtros.capital_min) items = items.filter(x => x.capital >= Number(filtros.capital_min));
      if (filtros.stock_min) items = items.filter(x => x.stock >= Number(filtros.stock_min));

      // Orden: por capital congelado desc (los que más plata tienen parada primero),
      // salvo casi_agotado que ordena por ritmo de venta
      if (criterio === 'casi_agotado') items.sort((a, b) => b.unidades_12m - a.unidades_12m);
      else items.sort((a, b) => b.capital - a.capital);

      return {
        criterio, total: items.length,
        capital_total: items.reduce((s, x) => s + x.capital, 0),
        marcas,
        items: items.slice(0, 300)
      };
    }
  }

  app.get('/api/promo-candidatos', authAdmin, mInv, async (req, res) => {
    try {
      res.json(await obtenerPromoCandidatos(req.query.criterio || 'estancado', req.query));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const PROMO_NOMBRES = {
    estancado: 'Stock estancado', sobrestock: 'Sobre-stock',
    margen_lento: 'Margen alto + venta lenta', lote_antiguo: 'Lotes antiguos',
    casi_agotado: 'Casi agotados con demanda'
  };
  app.get('/api/promo-candidatos-excel', authAdmin, mInv, async (req, res) => {
    try {
      const criterio = req.query.criterio || 'estancado';
      const d = await obtenerPromoCandidatos(criterio, req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Promociones');
      const filasCab = cabeceraExcel(ws, 'Promociones recomendadas', [
        ['Criterio', PROMO_NOMBRES[criterio] || criterio],
        ['Marca', req.query.marca || ''],
        ['Margen mínimo', req.query.margen_min ? req.query.margen_min + '%' : ''],
        ['Candidatos', d.total],
        ['Capital involucrado', 'S/ ' + Number(d.capital_total).toFixed(2)]
      ], 11);
      const colDefs = [
        { header: 'SKU', width: 18 }, { header: 'Marca', width: 14 }, { header: 'Producto', width: 44 },
        { header: 'Stock', width: 9 }, { header: 'Capital (S/)', width: 13 },
        { header: 'Días sin venta', width: 13 }, { header: 'Días lote antiguo', width: 15 },
        { header: 'Unidades 12m', width: 13 }, { header: 'Meses p/ agotar', width: 14 },
        { header: 'Precio prom.', width: 12 }, { header: 'Margen %', width: 10 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      d.items.forEach(x => ws.addRow([
        x.sku, x.marca, x.producto, x.stock, x.capital,
        x.dias_sin_venta != null ? x.dias_sin_venta : 'nunca (12m)',
        x.dias_lote_antiguo, x.unidades_12m,
        x.meses_para_agotar != null ? x.meses_para_agotar : '—',
        x.precio_prom, x.margen_pct
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      [5, 10].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('promociones');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });

  app.get('/api/inventario-resumen', authAdmin, mInv, async (req, res) => {
    try {
      const [[r]] = await prodPool.query(`
        SELECT COALESCE(SUM(ls.quantity),0) AS unidades_totales,
          COALESCE(SUM(ls.quantity - ls.reserved_quantity),0) AS disponibles,
          COALESCE(SUM(ls.reserved_quantity),0) AS reservadas,
          COUNT(DISTINCT ls.product_variation_id) AS skus_distintos
        FROM location_stocks ls WHERE ls.quantity > 0`);
      const [[val]] = await prodPool.query(`
        SELECT COALESCE(SUM(ls.quantity * sb.cost_price),0) AS valor_inventario
        FROM location_stocks ls
        LEFT JOIN stock_batches sb ON sb.id = (
          SELECT id FROM stock_batches WHERE product_variation_id = ls.product_variation_id ORDER BY id DESC LIMIT 1)
        WHERE ls.quantity > 0`);
      res.json({ ...r, ...val });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/stock-por-sucursal', authAdmin, mInv, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT l.id, l.name AS sucursal, l.type,
          COALESCE(SUM(ls.quantity),0) AS unidades,
          COALESCE(SUM(ls.quantity - ls.reserved_quantity),0) AS disponibles,
          COUNT(DISTINCT ls.product_variation_id) AS skus
        FROM locations l
        LEFT JOIN location_stocks ls ON ls.location_id = l.id AND ls.quantity > 0
        WHERE l.is_active = 1 GROUP BY l.id, l.name, l.type HAVING unidades > 0 ORDER BY unidades DESC`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── RESTOCK ──
  app.get('/api/restock', authAdmin, mRestock, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          COALESCE(stock.disponible,0) AS stock_disponible,
          COALESCE(vendido.unidades_90d,0) AS vendido_90d,
          COALESCE(gan.unidades_hist,0) AS unidades_hist,
          ROUND(COALESCE(vendido.unidades_90d,0)/90, 4) AS ventas_dia,
          ROUND(COALESCE(vendido.unidades_90d,0)/90*26, 1) AS punto_reorden,
          COALESCE(gan.ingreso_confiable,0) AS ingreso_confiable,
          COALESCE(gan.ganancia_hist,0) AS ganancia_hist,
          COALESCE(gan.lineas_pedido,0) AS lineas_pedido, COALESCE(gan.lineas_falla,0) AS lineas_falla,
          CASE WHEN COALESCE(gan.ingreso_confiable,0) > 0
            THEN ROUND(COALESCE(gan.ganancia_hist,0) / gan.ingreso_confiable * 100, 1) ELSE 0 END AS margen_pct,
          CASE WHEN COALESCE(gan.ganancia_hist,0) >= 1000 THEN 'Alto'
               WHEN COALESCE(gan.ganancia_hist,0) >= 300 THEN 'Medio' ELSE 'Bajo' END AS importancia
        FROM product_variations pv JOIN products p ON p.id = pv.product_id
        LEFT JOIN (SELECT product_variation_id, SUM(quantity - reserved_quantity) AS disponible
          FROM location_stocks GROUP BY product_variation_id) stock ON stock.product_variation_id = pv.id
        LEFT JOIN (SELECT si.product_variation_id, SUM(si.quantity) AS unidades_90d
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) AND s.deleted_at IS NULL AND s.status IN ${VV}
          GROUP BY si.product_variation_id) vendido ON vendido.product_variation_id = pv.id
        LEFT JOIN (SELECT si.product_variation_id, SUM(si.quantity) AS unidades_hist,
            SUM(CASE WHEN ${ES_NORMAL} THEN si.total ELSE 0 END) AS ingreso_confiable,
            SUM(${GANANCIA_NORMAL}) AS ganancia_hist,
            COUNT(CASE WHEN ${ES_PEDIDO} THEN 1 END) AS lineas_pedido,
            COUNT(CASE WHEN ${ES_FALLA} THEN 1 END) AS lineas_falla
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          LEFT JOIN stock_batches sb ON si.stock_batch_id = sb.id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          GROUP BY si.product_variation_id) gan ON gan.product_variation_id = pv.id
        WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
          AND COALESCE(vendido.unidades_90d,0) > 0
          AND COALESCE(stock.disponible,0) <= ROUND(COALESCE(vendido.unidades_90d,0)/90*26, 1)
        ORDER BY FIELD(importancia,'Alto','Medio','Bajo'), ganancia_hist DESC LIMIT 80`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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

  app.get('/api/retencion', authAdmin, mClientes, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT customer_id, COUNT(DISTINCT id) AS pedidos, MIN(created_at) AS primera, MAX(created_at) AS ultima
        FROM sales WHERE deleted_at IS NULL AND status IN ${VV} GROUP BY customer_id`);
      const total = rows.length, dias = r => (new Date(r.ultima) - new Date(r.primera)) / 86400000;
      const rec = rows.filter(r => r.pedidos >= 2);
      const r30 = rec.filter(r => dias(r) <= 30).length, r90 = rec.filter(r => dias(r) <= 90).length;
      res.json({
        total_clientes: total, recurrentes: rec.length, unicos: rows.filter(r => r.pedidos === 1).length,
        tasa_recurrencia: total > 0 ? ((rec.length/total)*100).toFixed(1) : '0.0',
        ret_30d: total > 0 ? ((r30/total)*100).toFixed(1) : '0.0',
        ret_90d: total > 0 ? ((r90/total)*100).toFixed(1) : '0.0'
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/clientes-riesgo', authAdmin, mClientes, async (req, res) => {
    const umbral = parseInt(req.query.dias) || 60;
    try {
      const [rows] = await prodPool.query(`
        SELECT p.id, p.kommo_id,
          CASE WHEN p.is_company=1 THEN p.business_name
               ELSE CONCAT(COALESCE(p.first_name,''),' ',COALESCE(p.last_name,'')) END AS cliente,
          COUNT(s.id) AS pedidos_hist, MAX(s.created_at) AS ultima_compra,
          DATEDIFF(NOW(), MAX(s.created_at)) AS dias_sin_comprar
        FROM parties p JOIN sales s ON s.customer_id = p.id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
        GROUP BY p.id, p.kommo_id, cliente
        HAVING pedidos_hist >= 2 AND dias_sin_comprar >= ? ORDER BY dias_sin_comprar DESC LIMIT 50`, [umbral]);
      res.json({ umbral_dias: umbral, total: rows.length, detalle: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── CLIENTES QUE DEBEN (cuentas por cobrar) ──
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

  app.get('/api/clientes-deudas', authAdmin, mClientes, async (req, res) => {
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

  app.get('/api/clientes-deudas-excel', authAdmin, mClientes, async (req, res) => {
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

  // Envío de correos de cobranza a deudores seleccionados (con CC a info@kuranko.pe)
  app.post('/api/clientes-deudas-cobrar', authAdmin, mClientes, async (req, res) => {
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

  // ── CONCILIACIÓN DE CAJA: pagos online desde Google Sheet ──
  // Lee un CSV publicado del Sheet, filtra por Fecha voucher y suma por empresa + canal.
  const SHEET_CSV_URL = process.env.SHEET_CONCILIACION_URL ||
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTKw8_uRi40xblPfuwYamFtsb_NsYx8BS9RdOfTENIu5BOSGPDAXu0RPOAjbAIN7_CXuOWQnNjW3aqn/pub?gid=0&single=true&output=csv';

  // Parser CSV simple que respeta comillas
  function parseCSV(texto) {
    const filas = [];
    let campo = '', fila = [], enComillas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (enComillas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') enComillas = false;
        else campo += c;
      } else {
        if (c === '"') enComillas = true;
        else if (c === ',') { fila.push(campo); campo = ''; }
        else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
        else if (c === '\r') { /* ignorar */ }
        else campo += c;
      }
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }

  // Normaliza una fecha del sheet (dd/mm/yy o dd/mm/yyyy) a YYYY-MM-DD
  function fechaSheetISO(str) {
    if (!str) return null;
    const s = str.trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let [, d, mes, a] = m;
    if (a.length === 2) a = '20' + a;
    return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  app.get('/api/conciliacion-sheet', authAdmin, mResumen, async (req, res) => {
    try {
      const { desde, hasta } = req.query;
      const r = await fetch(SHEET_CSV_URL);
      if (!r.ok) return res.status(502).json({ error: 'No se pudo leer el Google Sheet (código ' + r.status + ')' });
      const texto = await r.text();
      const filas = parseCSV(texto);
      if (!filas.length) return res.json({ filas: [], porEmpresaCanal: {}, total: 0 });

      // Detectar columnas por nombre de cabecera
      const cab = filas[0].map(x => (x || '').trim());
      const idx = (nombre) => cab.findIndex(c => c.toLowerCase() === nombre.toLowerCase());
      const iEmpresa = idx('Empresa');
      const iCanal = idx('Canal');
      const iFechaV = idx('Fecha voucher');
      const iTotal = idx('Total (S/)');
      if (iEmpresa < 0 || iCanal < 0 || iTotal < 0) {
        return res.status(500).json({ error: 'El Sheet no tiene las columnas esperadas (Empresa, Canal, Total (S/)).' });
      }

      const porEmpresaCanal = {};
      let total = 0;
      const detalle = [];
      for (let i = 1; i < filas.length; i++) {
        const f = filas[i];
        if (!f || f.length < 2) continue;
        const empresa = (f[iEmpresa] || '').trim();
        const canal = (f[iCanal] || '').trim();
        const fechaISO = fechaSheetISO(f[iFechaV] || '');
        const monto = parseFloat((f[iTotal] || '0').toString().replace(/[^\d.-]/g, '')) || 0;
        if (!empresa || !canal) continue;
        // Filtro por fecha voucher
        if (desde && (!fechaISO || fechaISO < desde)) continue;
        if (hasta && (!fechaISO || fechaISO > hasta)) continue;
        const clave = empresa + '|||' + canal;
        porEmpresaCanal[clave] = (porEmpresaCanal[clave] || 0) + monto;
        total += monto;
        detalle.push({ empresa, canal, fecha: fechaISO, monto });
      }
      res.json({ porEmpresaCanal, total, num: detalle.length, detalle });
    } catch (e) {
      res.status(500).json({ error: 'Error al leer el Sheet: ' + e.message });
    }
  });

  // Pagos del sistema agrupados por empresa + código de método (para conciliar con el Sheet)
  app.get('/api/conciliacion-sistema', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT COALESCE(ba.party_id, s.company_id) AS company_id,
          ci.code AS metodo_code, ci.name AS metodo_nombre,
          COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp
        LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
        LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE sp.voided_at IS NULL ${f}
        GROUP BY COALESCE(ba.party_id, s.company_id), ci.code, ci.name`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tipo-cliente', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query; const f = rango(desde, hasta);
    try {
      const [rows] = await prodPool.query(`
        SELECT p.is_company, COUNT(DISTINCT p.id) AS clientes, COUNT(s.id) AS ventas, COALESCE(SUM(s.total),0) AS total
        FROM sales s JOIN parties p ON p.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f} GROUP BY p.is_company`);
      res.json(rows.map(r => ({ ...r, tipo: r.is_company ? 'Empresa (B2B)' : 'Persona (B2C)' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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

  // ── KOMMO CRM ──
  app.get('/api/kommo/pipeline', authAdmin, mCrm, async (req, res) => {
    try {
      const [pl, ld] = await Promise.all([kommoFetch('leads/pipelines?limit=50'), kommoFetch('leads?limit=250')]);
      const pipes = pl._embedded?.pipelines || [], leads = ld._embedded?.leads || [];
      res.json(pipes.map(pipe => {
        const statuses = pipe._embedded?.statuses ? Object.values(pipe._embedded.statuses) : [];
        const pl2 = leads.filter(l => l.pipeline_id === pipe.id);
        const ganados = pl2.filter(l => l.status_id === KOMMO_GANADO);
        const perdidos = pl2.filter(l => l.status_id === KOMMO_PERDIDO);
        const activos = pl2.filter(l => l.status_id !== KOMMO_GANADO && l.status_id !== KOMMO_PERDIDO);
        return {
          nombre: pipe.name, total_leads: pl2.length, activos: activos.length,
          ganados: ganados.length, perdidos: perdidos.length,
          valor_activo: activos.reduce((s,l)=>s+(l.price||0),0),
          tasa_conversion: pl2.length > 0 ? ((ganados.length/pl2.length)*100).toFixed(1) : '0.0',
          etapas: statuses.filter(s => s.id!==KOMMO_GANADO && s.id!==KOMMO_PERDIDO)
            .map(s => ({ nombre: s.name, cantidad: pl2.filter(l=>l.status_id===s.id).length }))
        };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kommo/tareas', authAdmin, mCrm, async (req, res) => {
    try {
      const ahora = Math.floor(Date.now()/1000);
      const data = await kommoFetch('tasks?limit=250');
      const t = data._embedded?.tasks || [];
      const venc = t.filter(x => x.complete_till < ahora && !x.is_completed);
      const hoy = t.filter(x => { const d=new Date(x.complete_till*1000), n=new Date(); return d.toDateString()===n.toDateString() && !x.is_completed; });
      res.json({
        total_pendientes: t.filter(x=>!x.is_completed).length, vencidas: venc.length, hoy: hoy.length,
        proximas: t.filter(x => x.complete_till > ahora && !x.is_completed && !hoy.includes(x)).length,
        detalle_vencidas: venc.sort((a,b)=>a.complete_till-b.complete_till).slice(0,15)
          .map(x => ({ texto: x.text, vencio: new Date(x.complete_till*1000).toLocaleDateString('es-PE') }))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kommo/conversion', authAdmin, mCrm, async (req, res) => {
    try {
      const data = await kommoFetch('contacts?limit=250');
      const contactos = data._embedded?.contacts || [];
      const [[conv]] = await prodPool.query(`
        SELECT COUNT(DISTINCT p.kommo_id) AS con_venta FROM parties p
        JOIN sales s ON s.customer_id = p.id
        WHERE p.kommo_id IS NOT NULL AND s.deleted_at IS NULL AND s.status IN ${VV}`);
      const [[sinv]] = await prodPool.query(`
        SELECT COUNT(*) AS sin_venta FROM parties p WHERE p.kommo_id IS NOT NULL
        AND p.id NOT IN (SELECT DISTINCT customer_id FROM sales WHERE deleted_at IS NULL AND status IN ${VV})`);
      res.json({
        total_contactos: contactos.length, con_venta: conv.con_venta, sin_venta: sinv.sin_venta,
        tasa_conversion: contactos.length > 0 ? ((conv.con_venta/contactos.length)*100).toFixed(1) : '0.0'
      });
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
    await asegurarTablaAuditoria();
    console.log('Tablas del portal listas.');
  } catch (e) { console.error('No se pudieron preparar las tablas al arrancar:', e.message); }
});
