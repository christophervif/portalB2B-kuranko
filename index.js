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
function nombreProdVar(producto, variacion) {
  const p = (producto || '').trim();
  const v = (variacion || '').trim();
  if (!v || v === p) return p || '—';
  // Si la variación empieza igual que el producto, mostrar solo lo que añade
  if (v.toLowerCase().startsWith(p.toLowerCase())) {
    const extra = v.slice(p.length).replace(/^[\s,—-]+/, '').trim();
    return extra ? p + ' — ' + extra : p;
  }
  // Si el producto ya contiene a la variación, con el producto basta
  if (p.toLowerCase().includes(v.toLowerCase())) return p;
  return p + ' — ' + v;
}

const GANANCIA_NORMAL = `
  CASE WHEN si.stock_batch_id IS NOT NULL
       THEN (si.total - si.quantity * sb.cost_price)
       ELSE 0 END`;
const ES_NORMAL = `si.stock_batch_id IS NOT NULL`;
const ES_PEDIDO = `(si.stock_batch_id IS NULL AND si.is_backorder = 1)`;
const ES_FALLA  = `(si.stock_batch_id IS NULL AND si.is_backorder = 0)`;

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
  async function obtenerInventarioExport(f) {
    f = f || {};
    // Stock y costo promedio ponderado por variación
    const [stock] = await prodPool.query(`
      SELECT sb.product_variation_id,
        SUM(sb.quantity) AS stock,
        SUM(sb.quantity * sb.cost_price) AS capital,
        MIN(sb.entry_date) AS lote_mas_antiguo
      FROM stock_batches sb WHERE sb.quantity > 0
      GROUP BY sb.product_variation_id`);
    const stockMap = {};
    stock.forEach(r => stockMap[r.product_variation_id] = {
      stock: Number(r.stock), capital: Number(r.capital),
      costo_prom: Number(r.stock) > 0 ? Number(r.capital) / Number(r.stock) : 0,
      lote_mas_antiguo: r.lote_mas_antiguo
    });

    // Ventas: 90 días, histórico total y última venta
    const [ventas] = await prodPool.query(`
      SELECT si.product_variation_id,
        SUM(CASE WHEN s.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN si.quantity ELSE 0 END) AS und_90d,
        SUM(si.quantity) AS und_hist,
        SUM(si.total) AS venta_hist,
        MAX(s.created_at) AS ultima_venta
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.deleted_at IS NULL AND s.status IN ${VV}
      GROUP BY si.product_variation_id`);
    const vMap = {};
    ventas.forEach(v => vMap[v.product_variation_id] = v);

    // Categoría y subcategoría (por jerarquía parent_id) del producto
    const [cats] = await prodPool.query(`
      SELECT ppc.product_id, c.name AS cat, c.parent_id, padre.name AS cat_padre
      FROM product_product_category ppc
      JOIN product_categories c ON c.id = ppc.product_category_id
      LEFT JOIN product_categories padre ON padre.id = c.parent_id`);
    // Para cada producto: si la categoría tiene padre, es subcategoría; el padre es la categoría
    const catMap = {};
    cats.forEach(r => {
      const m = catMap[r.product_id] = catMap[r.product_id] || { categoria: new Set(), subcategoria: new Set() };
      if (r.parent_id) { m.categoria.add(r.cat_padre); m.subcategoria.add(r.cat); }
      else m.categoria.add(r.cat);
    });

    // Catálogo base (variaciones activas)
    const [prods] = await prodPool.query(`
      SELECT pv.id AS vid, pv.sku, pv.name AS variacion,
        pv.regular_price, pv.sale_price,
        p.id AS pid, p.name AS producto
      FROM product_variations pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
        AND pv.status = 'active'`);

    const hoy = Date.now();
    const dias = d => d ? Math.floor((hoy - new Date(d).getTime()) / 864e5) : null;

    let items = prods.map(p => {
      const st = stockMap[p.vid] || { stock: 0, capital: 0, costo_prom: 0, lote_mas_antiguo: null };
      const v = vMap[p.vid] || {};
      const c = catMap[p.pid] || {};
      const precio = p.sale_price != null && Number(p.sale_price) > 0 ? Number(p.sale_price) : Number(p.regular_price || 0);
      const costo = st.costo_prom;
      const margenPct = precio > 0 ? Math.round((precio - costo) / precio * 1000) / 10 : null;
      const und90 = Number(v.und_90d || 0);
      const ritmoMes = und90 / 3; // 90 días = 3 meses
      return {
        sku: p.sku,
        producto: nombreProdVar(p.producto, p.variacion),
        marca: (p.producto || '').trim().split(/\s+/)[0] || '—',
        categoria: c.categoria ? [...c.categoria].join(', ') : '—',
        subcategoria: c.subcategoria ? [...c.subcategoria].join(', ') : '—',
        stock: st.stock,
        costo_prom: Math.round(costo * 100) / 100,
        capital: Math.round(st.capital * 100) / 100,
        precio_venta: precio,
        margen_pct: margenPct,
        ganancia_unit: Math.round((precio - costo) * 100) / 100,
        und_90d: und90,
        und_hist: Number(v.und_hist || 0),
        venta_hist: Math.round(Number(v.venta_hist || 0) * 100) / 100,
        ultima_venta: v.ultima_venta || null,
        dias_sin_venta: dias(v.ultima_venta),
        meses_para_agotar: ritmoMes > 0 ? Math.round((st.stock / ritmoMes) * 10) / 10 : null
      };
    });

    // Filtros
    if (f.marca) items = items.filter(x => x.marca.toLowerCase() === f.marca.toLowerCase());
    if (f.categoria) items = items.filter(x =>
      x.categoria.split(', ').some(c => c.toLowerCase() === f.categoria.toLowerCase()));
    if (f.subcategoria) items = items.filter(x =>
      x.subcategoria.split(', ').some(c => c.toLowerCase() === f.subcategoria.toLowerCase()));
    if (f.solo_stock === '1') items = items.filter(x => x.stock > 0);
    if (f.solo_ventas === '1') items = items.filter(x => x.und_hist > 0);
    if (f.margen_min) items = items.filter(x => x.margen_pct != null && x.margen_pct >= Number(f.margen_min));
    if (f.margen_max) items = items.filter(x => x.margen_pct != null && x.margen_pct <= Number(f.margen_max));

    items.sort((a, b) => b.capital - a.capital);

    // Listas para los desplegables (marcas, categorías, subcategorías presentes)
    const marcas = [...new Set(items.map(x => x.marca))].filter(m => m !== '—').sort();
    return { total: items.length, items, marcas };
  }

  // Llena los desplegables del exportador (marcas, categorías, subcategorías)
  // sin cargar el catálogo completo. Se llama al abrir la pestaña.
  app.get('/api/inventario-export-filtros', authAdmin, mRestock, async (req, res) => {
    try {
      const [prods] = await prodPool.query(`
        SELECT DISTINCT TRIM(SUBSTRING_INDEX(TRIM(p.name), ' ', 1)) AS marca
        FROM products p
        WHERE p.deleted_at IS NULL AND p.name IS NOT NULL AND p.name != ''
        ORDER BY marca`);
      const [cats] = await prodPool.query(`
        SELECT id, name, parent_id FROM product_categories
        WHERE is_active = 1 ORDER BY name`);
      res.json({
        marcas: prods.map(r => r.marca).filter(Boolean),
        categorias: cats.filter(c => c.parent_id == null).map(c => c.name),
        subcategorias: cats.filter(c => c.parent_id != null).map(c => c.name)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/inventario-export', authAdmin, mRestock, async (req, res) => {
    try { res.json(await obtenerInventarioExport(req.query)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/inventario-export-excel', authAdmin, mRestock, async (req, res) => {
    try {
      const d = await obtenerInventarioExport(req.query);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Inventario');
      const fechaLima = x => x ? new Date(x).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '';
      const filasCab = cabeceraExcel(ws, 'Inventario con ventas y margen', [
        ['Marca', req.query.marca || 'Todas'],
        ['Categoría', req.query.categoria || 'Todas'],
        ['Productos', d.total]
      ], 16);
      const colDefs = [
        { header: 'SKU', width: 18 }, { header: 'Producto', width: 46 }, { header: 'Marca', width: 14 },
        { header: 'Categoría', width: 18 }, { header: 'Subcategoría', width: 18 },
        { header: 'Stock', width: 9 }, { header: 'Costo prom. (S/)', width: 14 },
        { header: 'Capital (S/)', width: 13 }, { header: 'Precio venta (S/)', width: 14 },
        { header: 'Margen %', width: 10 }, { header: 'Ganancia unit. (S/)', width: 15 },
        { header: 'Vendidas 90d', width: 12 }, { header: 'Vendidas histórico', width: 15 },
        { header: 'Venta histórica (S/)', width: 17 }, { header: 'Última venta', width: 13 },
        { header: 'Días sin venta', width: 13 }
      ];
      colDefs.forEach((c, i) => ws.getColumn(i + 1).width = c.width);
      const hr = ws.addRow(colDefs.map(c => c.header));
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      d.items.forEach(x => ws.addRow([
        x.sku, x.producto, x.marca, x.categoria, x.subcategoria, x.stock, x.costo_prom,
        x.capital, x.precio_venta, x.margen_pct, x.ganancia_unit, x.und_90d, x.und_hist,
        x.venta_hist, fechaLima(x.ultima_venta), x.dias_sin_venta != null ? x.dias_sin_venta : 'nunca'
      ]));
      ws.views = [{ state: 'frozen', ySplit: filasCab + 1 }];
      ws.autoFilter = { from: { row: filasCab + 1, column: 1 }, to: { row: filasCab + 1, column: 16 } };
      [7, 8, 9, 11, 14].forEach(c => ws.getColumn(c).numFmt = '#,##0.00');
      const nombre = nombreTrazable('inventario');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar: ' + e.message }); }
  });

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

  // ── Módulo Clientes-BI (créditos, deudas, conciliación) ──
  require('./modulos/clientes-bi')({ app, authAdmin, mClientes, mResumen, prodPool, portalPool, VV });

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
          producto: nombreProdVar(n.producto, n.variacion),
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

  // ── ANÁLISIS DE CAPITAL INMOVILIZADO (Inventario) ──
  // Solo stock, capital y rotación. NO incluye márgenes ni ganancias:
  // esta pestaña la ve el supervisor y esos datos son de Rentabilidad.
  app.get('/api/inventario-analisis', authAdmin, mInv, async (req, res) => {
    try {
      const [stock] = await prodPool.query(`
        SELECT sb.product_variation_id,
          SUM(sb.quantity) AS stock,
          SUM(sb.quantity * sb.cost_price) AS capital,
          MIN(sb.entry_date) AS lote_mas_antiguo
        FROM stock_batches sb
        WHERE sb.quantity > 0
        GROUP BY sb.product_variation_id`);
      if (!stock.length) return res.json({ productos: [], marcas: [] });
      const ids = stock.map(r => r.product_variation_id);

      const [ventas] = await prodPool.query(`
        SELECT si.product_variation_id,
          SUM(si.quantity) AS unidades_12m, MAX(s.created_at) AS ultima_venta
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV}
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
          AND si.product_variation_id IN (?)
        GROUP BY si.product_variation_id`, [ids]);
      const vMap = {}; ventas.forEach(v => vMap[v.product_variation_id] = v);

      const [nombres] = await prodPool.query(`
        SELECT pv.id, pv.sku, pv.name AS variacion, p.name AS producto
        FROM product_variations pv LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.id IN (?)`, [ids]);
      const nMap = {}; nombres.forEach(n => nMap[n.id] = n);

      const hoy = Date.now();
      const dias = f => f ? Math.floor((hoy - new Date(f).getTime()) / 864e5) : null;

      const items = stock.map(r => {
        const v = vMap[r.product_variation_id] || {};
        const n = nMap[r.product_variation_id] || {};
        const und12 = Number(v.unidades_12m || 0);
        const stockN = Number(r.stock);
        const ritmoMes = und12 / 12;
        return {
          sku: n.sku || '—',
          marca: (n.producto || '').trim().split(/\s+/)[0] || '—',
          producto: nombreProdVar(n.producto, n.variacion),
          stock: stockN,
          capital: Number(r.capital || 0),
          unidades_12m: und12,
          dias_sin_venta: dias(v.ultima_venta),
          meses_para_agotar: ritmoMes > 0 ? Math.round((stockN / ritmoMes) * 10) / 10 : null
        };
      });

      // 1) Los 15 productos con más capital parado que no rotan
      const estancados = items
        .filter(x => x.dias_sin_venta == null || x.dias_sin_venta >= 120)
        .sort((a, b) => b.capital - a.capital)
        .slice(0, 15);

      // 2) Las 15 marcas con más dinero en stock que peor rotan
      const porMarca = {};
      items.forEach(x => {
        const m = porMarca[x.marca] = porMarca[x.marca] ||
          { marca: x.marca, capital: 0, stock: 0, unidades_12m: 0, referencias: 0, sin_venta: 0 };
        m.capital += x.capital; m.stock += x.stock;
        m.unidades_12m += x.unidades_12m; m.referencias++;
        if (x.dias_sin_venta == null || x.dias_sin_venta >= 120) m.sin_venta++;
      });
      const marcas = Object.values(porMarca).map(m => {
        const ritmoMes = m.unidades_12m / 12;
        return { ...m, meses_para_agotar: ritmoMes > 0 ? Math.round((m.stock / ritmoMes) * 10) / 10 : null };
      })
        // "peor vendidas": tardan 12+ meses en agotarse, o directamente no venden
        .filter(m => m.meses_para_agotar == null || m.meses_para_agotar >= 12)
        .sort((a, b) => b.capital - a.capital)
        .slice(0, 15);

      res.json({
        productos: estancados, marcas,
        capital_estancado: estancados.reduce((s, x) => s + x.capital, 0),
        capital_marcas: marcas.reduce((s, x) => s + x.capital, 0)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
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



  // ── CLIENTES QUE DEBEN (cuentas por cobrar) ──



  // Envío de correos de cobranza a deudores seleccionados (con CC a info@kuranko.pe)

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
