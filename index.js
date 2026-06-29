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

// ─── Reporte de sincronización: pendientes + alertas (Excel, 2 pestañas) ─────
// Lee del ERP en SOLO LECTURA. No modifica nada. Genera el Excel al momento.
app.get('/admin/reporte-sync', authAdmin, async (req, res) => {
  try {
    // Última corrida del puente (desde la tabla de control en la base del portal)
    let ultimaCorrida = null;
    try {
      const [[c]] = await portalPool.query(
        `SELECT corrio_en, productos_actualizados, productos_error, modo
         FROM sync_corridas ORDER BY id DESC LIMIT 1`);
      if (c) ultimaCorrida = c;
    } catch (e) { /* la tabla puede no existir aún si el puente no ha corrido */ }

    // Valores actualizados en la última corrida (lo que el puente escribió en WooCommerce)
    let actualizados = [];
    if (ultimaCorrida) {
      try {
        const [rows] = await portalPool.query(
          `SELECT se.woocommerce_id, se.ultimo_stock, se.ultimo_precio, se.actualizado_en
           FROM sync_estado se
           WHERE se.actualizado_en >= ?
           ORDER BY se.actualizado_en DESC`, [ultimaCorrida.corrio_en]);
        actualizados = rows;
      } catch (e) { /* sin memoria aún */ }
    }
    // Enriquecer con SKU y nombre desde el ERP (si hay actualizados)
    let actInfo = [];
    if (actualizados.length) {
      const ids = actualizados.map(a => a.woocommerce_id).filter(Boolean);
      if (ids.length) {
        const [info] = await prodPool.query(
          `SELECT pv.woocommerce_id, pv.sku, pv.name AS nombre
           FROM product_variations pv
           WHERE pv.woocommerce_id IN (?)`, [ids]);
        const mapa = {};
        info.forEach(i => { mapa[i.woocommerce_id] = i; });
        actInfo = actualizados.map(a => ({
          wc: a.woocommerce_id,
          sku: mapa[a.woocommerce_id] ? mapa[a.woocommerce_id].sku : '',
          nombre: mapa[a.woocommerce_id] ? mapa[a.woocommerce_id].nombre : '',
          stock: a.ultimo_stock,
          precio: a.ultimo_precio,
          cuando: a.actualizado_en
        }));
      }
    }

    // PESTAÑA — Pendientes: productos SIN woocommerce_id (crear en WooCommerce)
    const [pendientes] = await prodPool.query(
      `SELECT pv.sku, pv.product_type, pv.name AS nombre,
              pv.regular_price,
              COALESCE(SUM(ls.quantity),0) AS stock
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.woocommerce_id IS NULL
         AND pv.product_type IN ('variation','simple')
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.sku, pv.product_type, pv.name, pv.regular_price
       ORDER BY pv.name, pv.sku`);

    // PESTAÑA — Alertas: productos publicados (active) con datos erróneos
    const [alertasRaw] = await prodPool.query(
      `SELECT pv.woocommerce_id, pv.sku, pv.name AS nombre,
              pv.regular_price,
              COALESCE(SUM(ls.quantity),0) AS stock
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.woocommerce_id IS NOT NULL
         AND pv.product_type IN ('variation','simple')
         AND pv.status = 'active'
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.woocommerce_id, pv.sku, pv.name, pv.regular_price
       HAVING COALESCE(SUM(ls.quantity),0) < 0
           OR pv.regular_price IS NULL
           OR pv.regular_price <= 0`);

    const alertas = alertasRaw.map(a => {
      const obs = [];
      if (a.stock < 0) obs.push(`Stock negativo (${a.stock})`);
      if (a.regular_price === null) obs.push('Sin precio regular');
      else if (Number(a.regular_price) === 0) obs.push('Precio en 0');
      else if (Number(a.regular_price) < 0) obs.push(`Precio negativo (${a.regular_price})`);
      return { ...a, observacion: obs.join(' · ') };
    });

    // PESTAÑA — Con stock pero NO activos (mercadería que no se vende en la web)
    const NOM_ESTADO = { draft: 'borrador', discontinued: 'descontinuado', active: 'activo' };
    const [stockNoActivo] = await prodPool.query(
      `SELECT pv.woocommerce_id, pv.sku, pv.name AS nombre, pv.status,
              COALESCE(SUM(ls.quantity),0) AS stock
       FROM product_variations pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN location_stocks ls ON ls.product_variation_id = pv.id
       WHERE pv.product_type IN ('variation','simple')
         AND pv.status <> 'active'
         AND pv.deleted_at IS NULL
       GROUP BY pv.id, pv.woocommerce_id, pv.sku, pv.name, pv.status
       HAVING COALESCE(SUM(ls.quantity),0) > 0
       ORDER BY stock DESC`);

    // Generar Excel con exceljs
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();

    const estiloHeader = (row) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      row.alignment = { vertical: 'middle' };
    };

    // Texto de la última corrida
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

    // Pestaña: Valores actualizados (lo que el puente escribió en la última corrida)
    const wsA = wb.addWorksheet('Actualizados última corrida');
    wsA.columns = [
      { header: 'SKU', key: 'sku', width: 24 },
      { header: 'WooCommerce ID', key: 'wc', width: 16 },
      { header: 'Nombre', key: 'nombre', width: 50 },
      { header: 'Stock aplicado', key: 'stock', width: 14 },
      { header: 'Precio aplicado', key: 'precio', width: 14 }
    ];
    actInfo.forEach(a => wsA.addRow({
      sku: a.sku, wc: a.wc, nombre: a.nombre || '',
      stock: a.stock, precio: a.precio === null ? '' : Number(a.precio)
    }));
    ponerEncabezado(wsA, 5);
    estiloHeader(wsA.getRow(3));
    wsA.views = [{ state: 'frozen', ySplit: 3 }];

    // Pestaña: Pendientes
    const ws1 = wb.addWorksheet('Pendientes');
    ws1.columns = [
      { header: 'SKU', key: 'sku', width: 24 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Nombre', key: 'nombre', width: 50 },
      { header: 'Precio regular', key: 'precio', width: 16 },
      { header: 'Stock', key: 'stock', width: 10 }
    ];
    pendientes.forEach(p => ws1.addRow({
      sku: p.sku, tipo: p.product_type, nombre: p.nombre || '',
      precio: p.regular_price === null ? '' : Number(p.regular_price), stock: p.stock
    }));
    ponerEncabezado(ws1, 5);
    estiloHeader(ws1.getRow(3));
    ws1.views = [{ state: 'frozen', ySplit: 3 }];

    // Pestaña: Alertas
    const ws2 = wb.addWorksheet('Alertas');
    ws2.columns = [
      { header: 'SKU', key: 'sku', width: 24 },
      { header: 'WooCommerce ID', key: 'wc', width: 16 },
      { header: 'Nombre', key: 'nombre', width: 50 },
      { header: 'Observación', key: 'obs', width: 34 }
    ];
    alertas.forEach(a => ws2.addRow({
      sku: a.sku, wc: a.woocommerce_id, nombre: a.nombre || '', obs: a.observacion
    }));
    ponerEncabezado(ws2, 4);
    estiloHeader(ws2.getRow(3));
    ws2.views = [{ state: 'frozen', ySplit: 3 }];

    // Pestaña: Con stock pero no activos
    const ws3 = wb.addWorksheet('Con stock no publicados');
    ws3.columns = [
      { header: 'SKU', key: 'sku', width: 24 },
      { header: 'WooCommerce ID', key: 'wc', width: 16 },
      { header: 'Nombre', key: 'nombre', width: 50 },
      { header: 'Stock', key: 'stock', width: 10 },
      { header: 'Observación', key: 'obs', width: 40 }
    ];
    stockNoActivo.forEach(p => {
      const est = NOM_ESTADO[p.status] || p.status;
      ws3.addRow({
        sku: p.sku, wc: p.woocommerce_id || '(sin ID)', nombre: p.nombre || '',
        stock: p.stock, obs: `Tiene ${p.stock} en stock pero está en '${est}' (no publicado)`
      });
    });
    ponerEncabezado(ws3, 5);
    estiloHeader(ws3.getRow(3));
    ws3.views = [{ state: 'frozen', ySplit: 3 }];

    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_sync_${fecha}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Error al generar el reporte: ' + e.message }); }
});

// ─── Reporte de venta de consignación (NO toca la BD, solo notifica) ─────────
app.post('/portal/reportar-venta', authCliente, async (req, res) => {
  const { items } = req.body; // [{producto, sku, cantidad}]
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'No hay items en el reporte' });

  const lineas = items.map(i => `• ${i.cantidad} x ${i.producto}${i.sku ? ' ('+i.sku+')' : ''}`).join('\n');
  const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });

  // Correo de empresa: si no está registrado, avisamos al equipo en el cuerpo
  const emailEmpresa = await correoEmpresa(req.cliente.customer_id);
  const lineaCorreo = emailEmpresa
    ? `Correo de empresa: ${emailEmpresa}\n`
    : `Correo de empresa: ⚠ NO REGISTRADO — falta registrar el correo de este cliente en el sistema.\n`;

  const cuerpo =
    `Reporte de venta de consignación\n\n` +
    `Cliente: ${req.cliente.nombre}\n` +
    `RUC/DNI: ${req.cliente.ruc || '-'}\n` +
    lineaCorreo +
    `Fecha: ${fecha}\n\n` +
    `Productos vendidos reportados:\n${lineas}\n\n` +
    `(El distribuidor reporta desde el portal. Registrar manualmente en el sistema.)`;

  // Enviar correo vía Resend si está configurado
  let correoOk = false;
  if (process.env.RESEND_API_KEY) {
    try {
      const payload = {
        from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
        to: (process.env.VENTAS_EMAIL || 'ventas@kuranko.pe').split(',').map(s => s.trim()),
        reply_to: 'ventas@kuranko.pe',
        subject: `Reporte de venta consignación — ${req.cliente.nombre}`,
        text: cuerpo
      };
      // Copia oculta al cliente solo si tiene correo registrado
      if (emailEmpresa) payload.bcc = emailEmpresa;

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!r.ok) console.error('Resend falló:', r.status, await r.text());
      correoOk = r.ok;
    } catch (e) { correoOk = false; }
  }
  res.json({ ok: true, correo_enviado: correoOk, copia_cliente: !!emailEmpresa, falta_correo: !emailEmpresa });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, servicio: 'portal-b2b' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Portal B2B en puerto ${PORT}`));
