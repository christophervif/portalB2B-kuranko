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
  app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET, grupos
}) {

  // Estados de venta válidos (pagada, confirmada, pendiente de pago)
  const VENTAS_VALIDAS = "('paid','confirmed','pending_payment')";

  // Correo de la empresa/cliente (destinatario del reporte de venta).
  // ids: customer_id del acceso (el principal primero y luego sus RUC adicionales).
  async function correoEmpresa(ids) {
    const lista = (Array.isArray(ids) ? ids : [ids]).filter(x => x != null);
    if (!lista.length) return null;
    try {
      const [rows] = await prodPool.query('SELECT id, email FROM parties WHERE id IN (?)', [lista]);
      for (const id of lista) {
        const p = rows.find(r => Number(r.id) === Number(id));
        if (p && p.email && p.email.trim() && /@/.test(p.email)) return p.email.trim();
      }
      return null;
    } catch (e) { return null; }
  }

  // RUC y nombre de cada customer_id del cliente (para dividir ventas y pagos por RUC)
  async function rucsDe(ids) {
    const m = {};
    if (!ids || !ids.length) return m;
    const [rows] = await prodPool.query(
      'SELECT id, is_company, business_name, first_name, last_name, document_number FROM parties WHERE id IN (?)', [ids]);
    rows.forEach(p => {
      const bn = (p.business_name || '').trim(), pn = `${p.first_name || ''} ${p.last_name || ''}`.trim();
      m[p.id] = { ruc: (p.document_number || '').trim(), nombre: (p.is_company ? (bn || pn) : (pn || bn)).replace(/\s+/g, ' ') };
    });
    return m;
  }

  // Destinatarios del reporte de venta de consignación:
  //   Para: el cliente (su correo del ERP). Si no tiene, Para: ventas.
  //   CC:   ventas (VENTAS_EMAIL) + info@kuranko.pe, sin repetir nadie.
  // Antes iba Para: VENTAS_EMAIL y CC: info + cliente; como VENTAS_EMAIL en
  // Railway incluye info@, info salía dos veces y el cliente quedaba en copia.
  function destinatariosReporte(emailCliente) {
    const internos = [...(process.env.VENTAS_EMAIL || 'ventas@kuranko.pe').split(','), 'info@kuranko.pe']
      .map(x => x.trim()).filter(x => /@/.test(x));
    const vistos = new Set();
    const unicos = arr => arr.filter(x => { const k = x.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; });
    const to = emailCliente ? unicos([emailCliente]) : unicos(internos.slice(0, 1));
    const cc = unicos(internos);
    return { to, cc };
  }

  // Login del cliente B2B (token propio, distinto del admin).
  // Además del token, consulta el estado actual del acceso (caché de 1 min en
  // modulos/clientes-gestion.js): si lo desactivaron, se corta al momento (antes
  // el token seguía valiendo hasta 8 h), y la consignación y los RUC agrupados
  // salen siempre de la base, sin obligar al cliente a volver a entrar.
  async function authCliente(req, res, next) {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    let p;
    try { p = jwt.verify(h.split(' ')[1], JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Sesión inválida o expirada' }); }
    if (p.rol !== 'cliente') return res.status(403).json({ error: 'Acceso no permitido' });
    req.cliente = { ...p, ids: p.customer_id != null ? [p.customer_id] : [], locs: p.location_id ? [Number(p.location_id)] : [] };
    if (grupos && grupos.grupoDe && p.portal_user_id) {
      try {
        const g = await grupos.grupoDe(p.portal_user_id);
        if (!g || !g.activo) return res.status(401).json({ error: 'Tu acceso fue desactivado. Escríbenos si es un error.' });
        req.cliente.customer_id = g.customer_id;
        req.cliente.location_id = g.location_id;
        req.cliente.locs = g.locs || (g.location_id ? [g.location_id] : []);
        req.cliente.ids = g.ids.length ? g.ids : req.cliente.ids;
        if (g.nombre) req.cliente.nombre = g.nombre;
        if (g.ruc) req.cliente.ruc = g.ruc;
      } catch (e) { console.error('[portal] grupo', e.message); /* sigue con los datos del token */ }
    }
    next();
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
      let u = rows[0];
      // Empresas con varios RUC: también puede entrar con un RUC adicional
      if (!u && grupos && grupos.usuarioPorRucAdicional) {
        try { u = await grupos.usuarioPorRucAdicional(usuario); } catch (e) { u = null; }
      }
      if (!u) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      if (!(await bcrypt.compare(password, u.password_hash)))
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      portalPool.query('UPDATE portal_users SET ultimo_login=NOW() WHERE id=?', [u.id]).catch(() => {});
      const token = jwt.sign({
        rol: 'cliente', portal_user_id: u.id, customer_id: u.customer_id,
        location_id: u.location_id, nombre: u.nombre_cliente, ruc: u.username
      }, JWT_SECRET, { expiresIn: '8h' });
      res.json({ token, cliente: { nombre: u.nombre_cliente, ruc: u.username, debe_cambiar: u.username === password || usuario.trim() === password } });
    } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
  });


  app.get('/portal/saldo', authCliente, async (req, res) => {
    try {
      const [[v]] = await prodPool.query(
        `SELECT COUNT(*) AS num_ventas, COALESCE(SUM(total),0) AS total_vendido
         FROM sales WHERE customer_id IN (?) AND deleted_at IS NULL AND status IN ${VENTAS_VALIDAS}`,
        [req.cliente.ids]);
      const [[p]] = await prodPool.query(
        `SELECT COALESCE(SUM(sp.amount),0) AS total_pagado FROM sale_payments sp
         JOIN sales s ON s.id=sp.sale_id WHERE s.customer_id IN (?) AND sp.voided_at IS NULL
         AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}`, [req.cliente.ids]);
      const vendido = parseFloat(v.total_vendido), pagado = parseFloat(p.total_pagado);
      const emailEmpresa = await correoEmpresa(req.cliente.ids);
      // Empresas con varios RUC: el mismo resumen dividido por RUC/DNI
      let porRuc = [];
      if (req.cliente.ids.length > 1) {
        const [vs] = await prodPool.query(
          `SELECT customer_id, COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM sales
           WHERE customer_id IN (?) AND deleted_at IS NULL AND status IN ${VENTAS_VALIDAS} GROUP BY customer_id`, [req.cliente.ids]);
        const [ps] = await prodPool.query(
          `SELECT s.customer_id, COALESCE(SUM(sp.amount),0) AS t FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
           WHERE s.customer_id IN (?) AND sp.voided_at IS NULL AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}
           GROUP BY s.customer_id`, [req.cliente.ids]);
        const info = await rucsDe(req.cliente.ids);
        porRuc = req.cliente.ids.map(id => {
          const a = vs.find(x => Number(x.customer_id) === Number(id)) || {};
          const b = ps.find(x => Number(x.customer_id) === Number(id)) || {};
          const tv = parseFloat(a.t || 0), tp = parseFloat(b.t || 0);
          return { customer_id: Number(id), ruc: (info[id] || {}).ruc || '', nombre: (info[id] || {}).nombre || '',
            num_ventas: Number(a.n || 0), total_vendido: tv, total_pagado: tp, por_cobrar: Math.max(0, tv - tp) };
        });
      }
      res.json({ nombre: req.cliente.nombre, ruc: req.cliente.ruc, num_ventas: v.num_ventas,
        total_vendido: vendido, total_pagado: pagado, por_cobrar: Math.max(0, vendido - pagado),
        email_empresa: emailEmpresa, por_ruc: porRuc });
    } catch (e) { res.status(500).json({ error: 'Error al consultar saldo' }); }
  });


  app.get('/portal/ventas', authCliente, async (req, res) => {
    try {
      const [rows] = await prodPool.query(
        `SELECT s.code AS codigo, s.created_at AS fecha, s.status, s.total, s.customer_id,
          COALESCE((SELECT SUM(amount) FROM sale_payments WHERE sale_id=s.id AND voided_at IS NULL),0) AS pagado
         FROM sales s WHERE s.customer_id IN (?) AND s.deleted_at IS NULL AND s.status IN ${VENTAS_VALIDAS}
         ORDER BY s.created_at DESC LIMIT 200`, [req.cliente.ids]);
      const info = await rucsDe(req.cliente.ids);
      res.json(rows.map(r => ({ ...r, ruc: (info[r.customer_id] || {}).ruc || '', razon_social: (info[r.customer_id] || {}).nombre || '',
        saldo: Math.max(0, parseFloat(r.total) - parseFloat(r.pagado)) })));
    } catch (e) { res.status(500).json({ error: 'Error al consultar ventas' }); }
  });


  app.get('/portal/pagos', authCliente, async (req, res) => {
    try {
      const [rows] = await prodPool.query(
        `SELECT sp.paid_at AS fecha, sp.amount AS monto, ci.name AS metodo, s.code AS venta_codigo, s.customer_id
         FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id
         LEFT JOIN catalog_items ci ON ci.id=sp.payment_method_id
         WHERE s.customer_id IN (?) AND sp.voided_at IS NULL AND s.deleted_at IS NULL
         ORDER BY sp.paid_at DESC LIMIT 200`, [req.cliente.ids]);
      const info = await rucsDe(req.cliente.ids);
      res.json(rows.map(r => ({ ...r, ruc: (info[r.customer_id] || {}).ruc || '', razon_social: (info[r.customer_id] || {}).nombre || '' })));
    } catch (e) { res.status(500).json({ error: 'Error al consultar pagos' }); }
  });


  app.get('/portal/stock', authCliente, async (req, res) => {
    if (!req.cliente.locs.length) return res.json([]); // sin consignación asignada
    try {
      const [rows] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion, ls.location_id,
          ls.quantity AS cantidad, (ls.quantity - ls.reserved_quantity) AS disponible
         FROM location_stocks ls
         JOIN product_variations pv ON pv.id=ls.product_variation_id
         JOIN products p ON p.id=pv.product_id
         WHERE ls.location_id IN (?) AND ls.quantity>0 AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.name`, [req.cliente.locs]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Error al consultar stock' }); }
  });


  app.get('/portal/venta/:codigo', authCliente, async (req, res) => {
    try {
      const [[venta]] = await prodPool.query(
        `SELECT id, code, total, status, created_at FROM sales
         WHERE code=? AND customer_id IN (?) AND deleted_at IS NULL LIMIT 1`,
        [req.params.codigo, req.cliente.ids]);
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


  // Nombre y RUC de facturación de cada consignación del cliente.
  // El RUC sale de las notas de la consignación en el ERP (ver clientes-gestion.js).
  async function infoConsignaciones(locs) {
    const out = {};
    if (!locs.length) return out;
    const [rows] = await prodPool.query('SELECT id, name FROM locations WHERE id IN (?)', [locs]);
    let fact = {};
    try { if (grupos && grupos.facturacionDe) fact = await grupos.facturacionDe(locs); } catch (e) { fact = {}; }
    locs.forEach(id => {
      const r = rows.find(x => Number(x.id) === Number(id));
      const f = fact[id] || { estado: 'sin_campo' };
      out[id] = { location_id: Number(id), consignacion: r ? r.name : '', factura_estado: f.estado,
        factura_ruc: f.estado === 'ok' ? f.ruc : null, factura_nombre: f.estado === 'ok' ? (f.nombre || null) : null };
    });
    return out;
  }

  app.get('/portal/consignacion', authCliente, async (req, res) => {
    const locs = req.cliente.locs;
    if (!locs.length) return res.json([]);
    try {
      const [rows] = await prodPool.query(
        `SELECT p.name AS producto, pv.sku, pv.name AS variacion,
          ls.product_variation_id AS pvid, ls.location_id,
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
         WHERE ls.location_id IN (?) AND ls.quantity>0
           AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.name`, [locs]);

      // Movimientos de los últimos 60 días en sus consignaciones, resumidos por
      // producto y consignación (última fecha de cada tipo). Liviano para Railway.
      const [entradas] = await prodPool.query(
        `SELECT product_variation_id AS pvid, location_to_id AS loc, MAX(movement_date) AS ult_entrada
         FROM stock_movements
         WHERE movement_date >= DATE_SUB(NOW(), INTERVAL 60 DAY) AND type='transfer' AND location_to_id IN (?)
         GROUP BY product_variation_id, location_to_id`, [locs]);
      const [salidas] = await prodPool.query(
        `SELECT product_variation_id AS pvid, location_from_id AS loc,
          MAX(CASE WHEN type='transfer' THEN movement_date END) AS ult_salida_transf,
          MAX(CASE WHEN type='sale' THEN movement_date END) AS ult_venta
         FROM stock_movements
         WHERE movement_date >= DATE_SUB(NOW(), INTERVAL 60 DAY) AND type IN ('transfer','sale') AND location_from_id IN (?)
         GROUP BY product_variation_id, location_from_id`, [locs]);
      const movMap = {};
      const k = (pvid, loc) => pvid + '|' + loc;
      entradas.forEach(m => { (movMap[k(m.pvid, m.loc)] = movMap[k(m.pvid, m.loc)] || {}).ult_entrada = m.ult_entrada; });
      salidas.forEach(m => { Object.assign(movMap[k(m.pvid, m.loc)] = movMap[k(m.pvid, m.loc)] || {}, { ult_salida_transf: m.ult_salida_transf, ult_venta: m.ult_venta }); });
      const info = await infoConsignaciones(locs);
      res.json(rows.map(r => {
        const m = movMap[k(r.pvid, r.location_id)] || {};
        return { ...r, ...(info[r.location_id] || {}),
          ult_entrada: m.ult_entrada || null,
          ult_salida_transf: m.ult_salida_transf || null,
          ult_venta: m.ult_venta || null
        };
      }));
    } catch (e) { console.error('[portal] consignacion', e.message); res.status(500).json({ error: 'Error al consultar consignación' }); }
  });

  // Consignaciones del cliente con su RUC de facturación (para mostrarlo en el portal)
  app.get('/portal/mis-consignaciones', authCliente, async (req, res) => {
    try { res.json(Object.values(await infoConsignaciones(req.cliente.locs))); }
    catch (e) { res.status(500).json({ error: 'Error al consultar consignaciones' }); }
  });


  app.get('/portal/transferencias', authCliente, async (req, res) => {
    const loc = req.cliente.locs;
    if (!loc.length) return res.json([]);
    try {
      const [rows] = await prodPool.query(
        `SELECT st.id, st.transfer_date AS fecha, st.reference_number AS guia,
          st.operation_type_code AS tipo, st.notes,
          CASE WHEN st.operation_type_code='04' THEN st.location_to_id ELSE st.location_from_id END AS location_id,
          CASE WHEN st.operation_type_code='04' THEN 'Entregada' ELSE 'Devuelta' END AS direccion,
          (SELECT COALESCE(SUM(sti.quantity),0) FROM stock_transfer_items sti WHERE sti.stock_transfer_id=st.id) AS total_unidades
         FROM stock_transfers st
         WHERE (st.operation_type_code='04' AND st.location_to_id IN (?))
            OR (st.operation_type_code='03' AND st.location_from_id IN (?))
         ORDER BY st.transfer_date DESC, st.id DESC`, [loc, loc]);
      const info = await infoConsignaciones(loc);
      res.json(rows.map(r => ({ ...r, ...(info[r.location_id] || {}) })));
    } catch (e) { res.status(500).json({ error: 'Error al consultar transferencias' }); }
  });


  app.get('/portal/transferencia/:id', authCliente, async (req, res) => {
    const loc = req.cliente.locs;
    if (!loc.length) return res.status(403).json({ error: 'Sin consignación asignada' });
    try {
      // Verificar que la transferencia pertenece a la consignación del cliente
      const [[t]] = await prodPool.query(
        `SELECT id FROM stock_transfers
         WHERE id=? AND (
           (operation_type_code='04' AND location_to_id IN (?)) OR
           (operation_type_code='03' AND location_from_id IN (?))
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
      portalPool.query('UPDATE portal_users SET clave_inicial=0 WHERE id=?', [req.cliente.portal_user_id]).catch(() => {});
      res.json({ ok: true, mensaje: 'Contraseña actualizada' });
    } catch (e) { res.status(500).json({ error: 'Error al cambiar contraseña' }); }
  });


  app.post('/portal/reportar-venta', authCliente, async (req, res) => {
    const { items } = req.body; // [{producto, sku, cantidad, location_id}]
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'No hay items en el reporte' });

    // Cada producto se reporta desde la consignación donde está; el RUC al que se
    // factura sale de esa consignación (notas en el ERP). El cliente no lo elige.
    const locs = req.cliente.locs || [];
    for (const i of items) {
      if (i.location_id == null || i.location_id === '') i.location_id = locs.length === 1 ? locs[0] : null;
      else if (!locs.includes(Number(i.location_id))) return res.status(400).json({ error: 'Producto de una consignación que no es tuya' });
      else i.location_id = Number(i.location_id);
    }
    let info = {};
    try { info = await infoConsignaciones(locs); } catch (e) { info = {}; }
    const grupos_ = [];
    items.forEach(i => {
      let g = grupos_.find(x => x.location_id === i.location_id);
      if (!g) {
        const inf = info[i.location_id] || {};
        g = { location_id: i.location_id, consignacion: inf.consignacion || '', estado: inf.factura_estado || 'sin_ruc',
          ruc: inf.factura_ruc || null, nombre: inf.factura_nombre || null, items: [] };
        grupos_.push(g);
      }
      g.items.push(i);
    });

    const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });

    // Correo de empresa: si no está registrado, avisamos al equipo
    const emailEmpresa = await correoEmpresa(req.cliente.ids);

    const esc = (t) => String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const facturaTxt = g => g.ruc
      ? `Facturar a: ${g.nombre ? g.nombre + ' — ' : ''}RUC ${g.ruc}`
      : (g.estado === 'mixto'
        ? '⚠ RUC por definir: esta consignación tiene stock de varios RUC. Verificar con la guía de remisión.'
        : '⚠ RUC por definir: la consignación no tiene RUC en notas. Verificar con la guía de remisión.');

    let n = 0;
    const filasHtml = grupos_.map(g => `
      <tr><td colspan="4" style="padding:8px 12px;border:1px solid #e0e0e0;background:${g.ruc ? '#eef2ff' : '#fef3c7'};">
        ${g.consignacion ? `<span style="color:#555;">Consignación:</span> <b>${esc(g.consignacion)}</b><br>` : ''}
        <b style="color:${g.ruc ? '#000726' : '#b45309'};">${esc(facturaTxt(g))}</b></td></tr>` +
      g.items.map(i => `
      <tr>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${++n}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;font-family:monospace;">${esc(i.sku) || '—'}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;">${esc(i.producto)}</td>
        <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">${esc(i.cantidad)}</td>
      </tr>`).join('')).join('');

    const avisoCorreo = emailEmpresa
      ? ''
      : `<p style="color:#b45309;background:#fef3c7;padding:10px 14px;border-radius:6px;">⚠ Este cliente no tiene correo registrado en el sistema. Falta registrarlo.</p>`;

    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px;">
      <h2 style="color:#000726;margin-bottom:4px;">Reporte de venta de consignación</h2>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:2px 8px;color:#555;">Cliente:</td><td style="padding:2px 8px;"><b>${esc(req.cliente.nombre)}</b></td></tr>
        <tr><td style="padding:2px 8px;color:#555;">Usuario del portal:</td><td style="padding:2px 8px;">${esc(req.cliente.ruc || '-')}</td></tr>
        <tr><td style="padding:2px 8px;color:#555;">Correo de empresa:</td><td style="padding:2px 8px;">${emailEmpresa ? esc(emailEmpresa) : '⚠ No registrado'}</td></tr>
        <tr><td style="padding:2px 8px;color:#555;">Fecha:</td><td style="padding:2px 8px;">${esc(fecha)}</td></tr>
      </table>
      ${avisoCorreo}
      <p style="margin-bottom:6px;"><b>Productos vendidos reportados:</b></p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#000726;color:#fff;">
            <th style="padding:8px 12px;border:1px solid #000726;text-align:center;">N°</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:left;">SKU</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:left;">Producto</th>
            <th style="padding:8px 12px;border:1px solid #000726;text-align:center;">Cantidad</th>
          </tr>
        </thead>
        <tbody>${filasHtml}</tbody>
      </table>
      <p style="color:#666;font-size:13px;margin-top:16px;">Reporte enviado por el distribuidor desde el Portal Kuranko. El equipo de ventas lo registrará en el sistema; si algo no coincide, responde a este correo.</p>
    </div>`;

    n = 0;
    const lineasTexto = grupos_.map(g =>
      `${g.consignacion ? 'Consignación: ' + g.consignacion + '\n' : ''}${facturaTxt(g)}\n` +
      g.items.map(i => `${++n}. [${i.sku || '—'}] ${i.producto} — Cantidad: ${i.cantidad}`).join('\n')).join('\n\n');
    const texto =
      `Reporte de venta de consignación\n\n` +
      `Cliente: ${req.cliente.nombre}\nUsuario del portal: ${req.cliente.ruc || '-'}\n` +
      `Correo de empresa: ${emailEmpresa || '⚠ No registrado'}\nFecha: ${fecha}\n\n` +
      `Productos vendidos reportados:\n${lineasTexto}\n\n` +
      `(Reporte enviado por el distribuidor desde el Portal Kuranko. El equipo de ventas lo registrará en el sistema; si algo no coincide, responde a este correo.)`;

    let correoOk = false;
    if (process.env.RESEND_API_KEY) {
      try {
        const { to, cc } = destinatariosReporte(emailEmpresa);
        const payload = {
          from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>',
          to,
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
    res.json({ ok: true, correo_enviado: correoOk, copia_cliente: !!emailEmpresa, falta_correo: !emailEmpresa,
      facturacion: grupos_.map(g => ({ consignacion: g.consignacion, ruc: g.ruc, nombre: g.nombre, estado: g.estado, texto: facturaTxt(g),
        items: g.items.map(i => ({ producto: i.producto, sku: i.sku, cantidad: i.cantidad })) })) });
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


  return { prepararTablas, _test: { destinatariosReporte } };
};
