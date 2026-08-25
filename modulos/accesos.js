// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Accesos (gestión de usuarios y clientes)
//  Crear/activar/vincular usuarios del portal cliente, reset de contraseña,
//  ver-como-cliente, y lectura de accesos admin. Toca el login, por eso recibe
//  las piezas de autenticación desde el index.
// ═══════════════════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function registrarAccesos({
  app, authAdmin, requiereModulo, soloMaestro,
  prodPool, portalPool, JWT_SECRET, MODULOS_ADMIN, leerAdminsSecundarios
}) {

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

  // ── Módulo Contabilidad (kardex + reporte de pagos) en modulos/contabilidad.js ──
  // Se carga más abajo, donde VV ya está definido.

  // ── Módulo Sincronización + Auditoría en modulos/sincronizacion.js ──
  // Se carga más abajo junto a los otros módulos.

  // ─── Ver accesos (SOLO admin maestro) — lectura de las variables de Railway ──
  app.get('/admin/accesos', authAdmin, soloMaestro, async (req, res) => {
    const secundarios = leerAdminsSecundarios();
    res.json({
      modulos_disponibles: MODULOS_ADMIN,
      usuarios: secundarios.map(a => ({ username: a.usuario, modulos: a.modulos }))
    });
  });



};
