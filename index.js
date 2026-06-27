// ============================================================================
// PORTAL B2B KURANKO — Backend aislado para clientes
// Solo lectura. Cada cliente ve ÚNICAMENTE sus propios datos.
// Aislamiento forzado: el customer_id sale del token, NUNCA del request.
// ============================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Base de PRODUCCIÓN (solo lectura, usuario readonly) ─────────────────────
const prodPool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: process.env.MYSQLPORT,
  user: process.env.MYSQL_READONLY_USER,
  password: process.env.MYSQL_READONLY_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
});

// ─── Base del PORTAL (usuarios del portal, separada) ─────────────────────────
const portalPool = mysql.createPool({
  host: process.env.PORTAL_DB_HOST,
  port: process.env.PORTAL_DB_PORT,
  user: process.env.PORTAL_DB_USER,
  password: process.env.PORTAL_DB_PASSWORD,
  database: process.env.PORTAL_DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

const JWT_SECRET = process.env.JWT_SECRET;
const VENTAS_VALIDAS = "('paid','confirmed','pending_payment')";

// ─── Middleware: validar token y extraer el cliente ──────────────────────────
// CLAVE DE SEGURIDAD: el customer_id y location_id vienen del token firmado,
// nunca de parámetros que el cliente pueda manipular.
function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.cliente = {
      portal_user_id: payload.portal_user_id,
      customer_id: payload.customer_id,
      location_id: payload.location_id,
      nombre: payload.nombre
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
app.post('/portal/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
  }
  try {
    const [rows] = await portalPool.query(
      'SELECT * FROM portal_users WHERE username = ? AND activo = 1 LIMIT 1',
      [usuario.trim()]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = jwt.sign({
      portal_user_id: user.id,
      customer_id: user.customer_id,
      location_id: user.location_id,
      nombre: user.nombre_cliente
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      cliente: { nombre: user.nombre_cliente }
    });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─── STOCK del cliente (en su location de consignación) ──────────────────────
app.get('/portal/stock', auth, async (req, res) => {
  try {
    const [rows] = await prodPool.query(`
      SELECT p.name AS producto, pv.sku, pv.name AS variacion,
        ls.quantity AS cantidad,
        (ls.quantity - ls.reserved_quantity) AS disponible
      FROM location_stocks ls
      JOIN product_variations pv ON pv.id = ls.product_variation_id
      JOIN products p ON p.id = pv.product_id
      WHERE ls.location_id = ? AND ls.quantity > 0
        AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.name`,
      [req.cliente.location_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al consultar stock' });
  }
});

// ─── VENTAS del cliente ──────────────────────────────────────────────────────
app.get('/portal/ventas', auth, async (req, res) => {
  try {
    const [rows] = await prodPool.query(`
      SELECT s.code AS codigo, s.created_at AS fecha, s.status,
        s.total,
        COALESCE((SELECT SUM(amount) FROM sale_payments
                  WHERE sale_id = s.id AND voided_at IS NULL), 0) AS pagado
      FROM sales s
      WHERE s.customer_id = ? AND s.deleted_at IS NULL
        AND s.status IN ${VENTAS_VALIDAS}
      ORDER BY s.created_at DESC
      LIMIT 200`,
      [req.cliente.customer_id]
    );
    res.json(rows.map(r => ({
      ...r,
      saldo: Math.max(0, parseFloat(r.total) - parseFloat(r.pagado))
    })));
  } catch (e) {
    res.status(500).json({ error: 'Error al consultar ventas' });
  }
});

// ─── PAGOS realizados por el cliente ─────────────────────────────────────────
app.get('/portal/pagos', auth, async (req, res) => {
  try {
    const [rows] = await prodPool.query(`
      SELECT sp.paid_at AS fecha, sp.amount AS monto,
        ci.name AS metodo, s.code AS venta_codigo
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
      WHERE s.customer_id = ? AND sp.voided_at IS NULL
        AND s.deleted_at IS NULL
      ORDER BY sp.paid_at DESC
      LIMIT 200`,
      [req.cliente.customer_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al consultar pagos' });
  }
});

// ─── SALDO / resumen del cliente ─────────────────────────────────────────────
app.get('/portal/saldo', auth, async (req, res) => {
  try {
    const [[v]] = await prodPool.query(`
      SELECT
        COUNT(*) AS num_ventas,
        COALESCE(SUM(total),0) AS total_vendido
      FROM sales
      WHERE customer_id = ? AND deleted_at IS NULL
        AND status IN ${VENTAS_VALIDAS}`,
      [req.cliente.customer_id]
    );
    const [[p]] = await prodPool.query(`
      SELECT COALESCE(SUM(sp.amount),0) AS total_pagado
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      WHERE s.customer_id = ? AND sp.voided_at IS NULL
        AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}`,
      [req.cliente.customer_id]
    );
    const vendido = parseFloat(v.total_vendido);
    const pagado = parseFloat(p.total_pagado);
    res.json({
      nombre: req.cliente.nombre,
      num_ventas: v.num_ventas,
      total_vendido: vendido,
      total_pagado: pagado,
      por_cobrar: Math.max(0, vendido - pagado)
    });
  } catch (e) {
    res.status(500).json({ error: 'Error al consultar saldo' });
  }
});

// ─── Info del cliente logueado ───────────────────────────────────────────────
app.get('/portal/yo', auth, (req, res) => {
  res.json({ nombre: req.cliente.nombre });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, servicio: 'portal-b2b' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Portal B2B en puerto ${PORT}`));
