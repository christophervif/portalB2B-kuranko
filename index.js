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
// Límite amplio: el módulo de Importaciones reenvía PDFs (base64) a la IA.
app.use(express.json({ limit: '25mb' }));
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

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════════

// Cliente B2B: el customer_id/location_id viven en el token firmado (no manipulable)

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

// ════════════════════════════════════════════════════════════════════════════
// ENDPOINTS CLIENTE (solo sus datos)
// ════════════════════════════════════════════════════════════════════════════




// Detalle de una venta: productos + boletas/facturas (validando que sea del cliente)

// Consignación enriquecida: disponible + precio regular + vendido histórico + indicadores recientes

// Pestaña Transferencias: entregadas (04) y devueltas (03) con detalle de items

// Detalle de items de una transferencia (validando que sea de la consignación del cliente)


// ════════════════════════════════════════════════════════════════════════════
// LOGIN ADMIN
// ════════════════════════════════════════════════════════════════════════════
// Lista de módulos (pestañas) del admin. Debe coincidir con las pestañas del HTML.
const MODULOS_ADMIN = ['clientes_gestion', 'sync', 'auditoria', 'resumen', 'rentabilidad', 'inventario', 'restock', 'clientes_bi', 'caja_bi', 'crm', 'reportes', 'pagos', 'importaciones', 'recepciones'];

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

// ─── Métodos de pago (el admin los edita, el cliente los ve) ─────────────────
// Se guardan en la base del portal (no toca el ERP). Una sola fila de config.

// Cliente: leer métodos de pago (solo lectura)

// Admin: leer métodos de pago (para el formulario de edición)

// Admin: guardar métodos de pago


// ============================================================================
const https = require('https');
const VV = "('paid','confirmed','pending_payment')";

// Arma "Producto — extra" evitando repetir el nombre cuando la variación ya lo contiene.
// Ej: producto "Crafty Carbon RR 2026" + variación "Crafty Carbon RR 2026, Admiral Blue, M/L"
//     → "Crafty Carbon RR 2026 — Admiral Blue, M/L"

// Referencia a módulos que exponen funciones de arranque (se asigna dentro de la IIFE)
let modSync = null;
let modPortal = null;
let modImportacion = null;
let modRecepciones = null;

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

  // ── Módulo Portal del cliente (B2B) ──
  modPortal = require('./modulos/portal-cliente')({ app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET });

  // ── Módulo Ventas-BI (KPIs, rentabilidad, top productos) ──
  require('./modulos/ventas-bi')({ app, authAdmin, mResumen, mRent, mCaja, prodPool, VV });

  // ── Módulo Inventario (capital parado, restock, promociones) ──
  require('./modulos/inventario')({ app, authAdmin, mInv, mRestock, prodPool, VV });

  // ── Módulo Promociones recomendadas ──
  require('./modulos/promociones')({ app, authAdmin, mInv, prodPool, VV });

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

  // ── Módulo Importaciones (costeo / landed cost) ──
  // Catálogo desde producción (Renzo, solo lectura); tasas/importaciones/memoria
  // en la base del portal; IA (Gemini) con la clave protegida en el servidor.
  modImportacion = require('./modulos/importacion')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Recepción de mercadería (paso intermedio compra: almacén valida) ──
  modRecepciones = require('./modulos/recepciones')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Sincronización + Auditoría ──
  modSync = require('./modulos/sincronizacion')({ app, authAdmin, requiereModulo, prodPool, portalPool });
  const rango = (desde, hasta, campo='s.created_at') =>
    desde && hasta ? `AND ${campo} BETWEEN '${desde}' AND '${hasta} 23:59:59'` : '';

  // ── RESUMEN / KPIs ──

  // ── INVENTARIO ──
  // ── CANDIDATOS A PROMOCIÓN ──
  // Analiza stock y ventas para sugerir qué productos convendría promocionar.
  // Criterios: estancado | sobrestock | margen_lento | lote_antiguo | casi_agotado


  // ── ANÁLISIS DE CAPITAL INMOVILIZADO (Inventario) ──
  // Solo stock, capital y rotación. NO incluye márgenes ni ganancias:
  // esta pestaña la ve el supervisor y esos datos son de Rentabilidad.



  // ── RESTOCK ──

  // ── CLIENTES ──



  // ── CLIENTES QUE DEBEN (cuentas por cobrar) ──



  // Envío de correos de cobranza a deudores seleccionados (con CC a info@kuranko.pe)



  // Pagos del sistema agrupados por empresa + código de método (para conciliar con el Sheet)


  // ── PAGOS Y CAJA ──

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
    if (modPortal && modPortal.prepararTablas) await modPortal.prepararTablas();
    if (modSync && modSync.prepararTablas) await modSync.prepararTablas();
    if (modImportacion && modImportacion.prepararTablas) await modImportacion.prepararTablas();
    if (modRecepciones && modRecepciones.prepararTablas) await modRecepciones.prepararTablas();
    console.log('Tablas del portal listas.');
  } catch (e) { console.error('No se pudieron preparar las tablas al arrancar:', e.message); }
});
