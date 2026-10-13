// ============================================================================
// PORTAL B2B KURANKO — Backend (clientes + panel de administración)
// Todo en la nube. Cada cliente ve SOLO sus datos. Admin protegido por login.
// Las rutas viven en modulos/*.js; este archivo solo arma la app y los registra.
// ============================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
// Railway pone un proxy delante: así req.ip es la IP real del cliente (y no el
// primer valor de X-Forwarded-For, que lo puede escribir cualquiera).
// Si se agrega Cloudflare delante de Railway, cambiar a 2 (o TRUST_PROXY=2).
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.disable('x-powered-by');

// Compresión gzip: reduce MUCHO el egress de Railway (las páginas pesan cientos
// de KB). Si el paquete no está instalado, sigue funcionando sin comprimir.
try { const compression = require('compression'); app.use(compression()); }
catch (e) { console.warn('[perf] compression no disponible (npm i compression):', e.message); }

// ─── Cabeceras de seguridad (sin dependencias) ───────────────────────────────
const esBikes = req => /^bikes\./i.test(req.hostname || '');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  // El panel no debe poder incrustarse en sitios ajenos (clickjacking). La tienda
  // pública sí puede incrustarse (por si kuranko.pe la muestra en un iframe).
  const publicoBikes = /^\/($|index\.html$|bikes\.html$|bici\/|en\/?$|bikes\/proforma\/|bikes-assets\/|api\/bikes\/(?!admin\/))/;
  if (!(esBikes(req) && publicoBikes.test(req.path))) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(cors({ origin: '*' }));
// Límite amplio: el módulo de Importaciones reenvía PDFs (base64) a la IA.
app.use(express.json({ limit: '25mb' }));

// ─── Filtros de fecha: solo AAAA-MM-DD o AAAA-MM ─────────────────────────────
// Varios reportes arman el SQL con estas fechas; si llega otra cosa se corta
// aquí (protección contra inyección SQL para todos los módulos a la vez).
const FECHA_O_MES = /^\d{4}-\d{2}(-\d{2})?$/;
app.use('/api', (req, res, next) => {
  for (const k of ['desde', 'hasta']) {
    const v = req.query[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !FECHA_O_MES.test(v))
      return res.status(400).json({ error: `Fecha «${k}» inválida (usa AAAA-MM-DD)` });
  }
  next();
});

// ─── No mostrar errores internos de MySQL al navegador ───────────────────────
// Muchos endpoints responden { error: e.message }. Si el mensaje es de la base
// de datos o de la red, se registra en el log y el cliente ve un texto genérico.
const ERROR_INTERNO = /\bER_[A-Z_]+|SQL syntax|sqlMessage|Unknown column|Unknown table|doesn't exist|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|PROTOCOL_|Access denied for user|Too many connections|Deadlock/i;
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 500 && body && typeof body.error === 'string' && ERROR_INTERNO.test(body.error)) {
      console.error(`[500] ${req.method} ${req.originalUrl}: ${body.error}`);
      body = { ...body, error: 'Error interno del servidor. Intenta de nuevo en un momento.' };
    }
    return json(body);
  };
  next();
});

// bikes.kuranko.pe → tienda pública de bicis a pedido (public/bikes.html).
// El resto de rutas (/api, /admin.html…) funciona igual en ese dominio.
app.use((req, res, next) => {
  if (esBikes(req) && (req.path === '/' || req.path === '/index.html'))
    return res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'bikes.html'));
  next();
});
// Estáticos: el HTML SIEMPRE revalida (no-cache + etag) para no servir versiones
// viejas tras un deploy; los demás recursos sí se cachean 1h. Lo que va en
// /vendor no cambia nunca de nombre de versión: 30 días.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else if (/[\\/]vendor[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=2592000');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

// ─── Conexiones (usan URLs públicas completas de Railway) ────────────────────
// PROD_URL    = MYSQL_PUBLIC_URL de la base de producción (se fuerza readonly por usuario)
// PORTAL_URL  = MYSQL_PUBLIC_URL de la base del portal
const prodPool = mysql.createPool(process.env.PROD_URL + '?connectionLimit=5');
const portalPool = mysql.createPool(process.env.PORTAL_URL + '?connectionLimit=5');
// Cuenta del portal con permisos de ESCRITURA limitados en la base del sistema (ERP).
// Es una sola cuenta para todos los módulos; se le van dando permisos tabla por tabla (ver railway-cuenta-portal-erp.sql).
const ERP_ESCRITURA_URL = process.env.ERP_ESCRITURA_URL || process.env.ERP_FACTURACION_URL; // el 2.º nombre es el antiguo
// Se lee la URL a mano (la clave puede tener símbolos como % # @ /) y, si algo falla, el portal sigue
// funcionando igual, solo que sin escribir en el sistema.
function poolDesdeUrl(url, limite) {
  try {
    const m = String(url).trim().match(/^mysql:\/\/([^:@\/]+):(.*)@([^@:\/]+)(?::(\d+))?\/([^?\/]+)/);
    if (!m) throw new Error('formato esperado mysql://usuario:clave@host:puerto/base');
    let clave = m[2]; try { clave = decodeURIComponent(clave); } catch (e) { /* clave con % literal */ }
    return mysql.createPool({ user: m[1], password: clave, host: m[3], port: Number(m[4] || 3306), database: m[5], connectionLimit: limite });
  } catch (e) { console.error('[ERP_ESCRITURA_URL] no se pudo usar:', e.message); return null; }
}
const erpWritePool = ERP_ESCRITURA_URL ? poolDesdeUrl(ERP_ESCRITURA_URL, 3) : null;

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // contraseña admin (variable Railway, encriptada)
// Duración de la sesión del panel. Se puede acortar con la variable ADMIN_SESION (ej. 12h, 3d).
const ADMIN_SESION = process.env.ADMIN_SESION || '7d';
// Estados de venta que cuentan como venta válida (se pasa a los módulos)
const VV = "('paid','confirmed','pending_payment')";

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN ADMIN
// ════════════════════════════════════════════════════════════════════════════
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

// Lista de módulos (pestañas) del admin. Debe coincidir con las pestañas del HTML.
const MODULOS_ADMIN = ['clientes_gestion', 'sync', 'auditoria', 'resumen', 'rentabilidad', 'inventario', 'restock', 'clientes_bi', 'caja_bi', 'crm', 'reportes', 'pagos', 'importaciones', 'recepciones', 'seguimiento', 'conciliacion', 'cuentas_cobrar', 'saldo_favor', 'cotizador', 'precio_importado', 'asistencia', 'facturacion', 'bikes', 'gastos', 'rendimiento'];

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

// Comparación de textos en tiempo constante (no revela cuántas letras coinciden)
function igualesSeguro(a, b) {
  const x = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const y = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(x, y) && b != null && b !== '';
}

// Límite de intentos de login por IP: 8 fallidos cada 15 minutos
const fallosLogin = new Map();
const VENTANA_LOGIN = 15 * 60 * 1000, MAX_FALLOS_LOGIN = 8;
function loginBloqueado(ip) {
  const ahora = Date.now(), l = (fallosLogin.get(ip) || []).filter(t => ahora - t < VENTANA_LOGIN);
  fallosLogin.set(ip, l);
  return l.length >= MAX_FALLOS_LOGIN;
}
function registrarFallo(ip) {
  if (fallosLogin.size > 5000) fallosLogin.clear();
  fallosLogin.set(ip, [...(fallosLogin.get(ip) || []), Date.now()]);
}

app.post('/admin/login', async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
  const ip = req.ip || '';
  if (loginBloqueado(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' });
  try {
    const u = String(usuario).trim(), p = String(password);
    // 1) Admin maestro (acceso total + gestión de accesos)
    if (ADMIN_USER && igualesSeguro(u, ADMIN_USER) & igualesSeguro(p, ADMIN_PASSWORD)) {
      fallosLogin.delete(ip);
      const token = jwt.sign(
        { rol: 'admin', usuario: ADMIN_USER, maestro: true, modulos: MODULOS_ADMIN },
        JWT_SECRET, { expiresIn: ADMIN_SESION });
      return res.json({ token, maestro: true, modulos: MODULOS_ADMIN });
    }
    // 2) Admin secundario (definido en variables de Railway) — sin tocar la base de datos
    const match = leerAdminsSecundarios().find(a => igualesSeguro(u, a.usuario) & igualesSeguro(p, a.password));
    if (match) {
      fallosLogin.delete(ip);
      const token = jwt.sign(
        { rol: 'admin', usuario: match.usuario, maestro: false, modulos: match.modulos },
        JWT_SECRET, { expiresIn: ADMIN_SESION });
      return res.json({ token, maestro: false, modulos: match.modulos });
    }
    registrarFallo(ip);
    return res.status(401).json({ error: 'Credenciales de administrador incorrectas' });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MÓDULOS
// ════════════════════════════════════════════════════════════════════════════
// Referencia a módulos que exponen funciones de arranque
let modSync = null;
let modAuditoria = null;
let modPortal = null;
let modImportacion = null;
let modRecepciones = null;
let modSeguimiento = null;
let modAsistencia = null;
let modGestion = null;
let modBikes = null;

(function () {
  const mResumen = requiereModulo('resumen');
  const mRent = requiereModulo('rentabilidad');
  const mInv = requiereModulo('inventario');
  const mRestock = requiereModulo('restock');
  const mClientes = requiereModulo('clientes_bi');
  const mCxc = requiereModulo('cuentas_cobrar');   // Cuentas por cobrar (deudas), módulo aislado
  const mSaldo = requiereModulo('saldo_favor');    // Saldo a favor (créditos), módulo aislado
  const mConc = requiereModulo('conciliacion');    // Conciliación de pagos online, módulo aislado
  const mCaja = requiereModulo('caja_bi');
  const mCrm = requiereModulo('crm');

  // ── Módulo CRM Kommo (separado en modulos/crm-kommo.js) ──
  require('./modulos/crm-kommo')({ app, authAdmin, mCrm, prodPool, VV });

  // ── Módulo Gestión de clientes del portal (accesos, consignaciones, RUC agrupados) ──
  //    Frontend propio en public/clientes-gestion.html (iframe dentro del panel).
  //    Expone los "grupos de RUC" que usan el portal del cliente y Clientes BI.
  modGestion = require('./modulos/clientes-gestion')({ app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET });

  // ── Módulo Portal del cliente (B2B) ──
  modPortal = require('./modulos/portal-cliente')({ app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET, grupos: modGestion });

  // ── Módulo Ventas-BI (KPIs, rentabilidad, top productos) ──
  const modVentasBI = require('./modulos/ventas-bi')({ app, authAdmin, mResumen, mRent, mCaja, prodPool, portalPool, VV });

  // ── "Ventas y compras": Compras y gastos (public/gastos.html, permiso 'gastos') y
  //    Rendimiento (public/rendimiento.html, permiso 'rendimiento'). Rendimiento no
  //    guarda datos: cruza ventas-bi con gastos.
  const modGastos = require('./modulos/gastos')({ app, authAdmin, requiereModulo, prodPool, portalPool });
  require('./modulos/rendimiento')({ app, authAdmin, requiereModulo,
    serieAgrupada: modVentasBI.serieAgrupada, gastosMensuales: modGastos.gastosMensuales });

  // ── Módulo Inventario (foto del stock: salud, antigüedad, ubicaciones, capital parado) ──
  require('./modulos/inventario')({ app, authAdmin, mInv, prodPool, VV });

  // ── Módulo Restock (qué reponer y cuánto) ──
  require('./modulos/restock')({ app, authAdmin, mRestock, prodPool, portalPool, VV });

  // ── Módulo Promociones recomendadas (candidatos a descuento/liquidación) ──
  require('./modulos/promociones')({ app, authAdmin, mInv, prodPool, VV });

  // ── Módulo Clientes BI (retención, estados, top, riesgo) ──
  require('./modulos/clientes-bi')({ app, authAdmin, mClientes, mResumen, prodPool, VV, grupos: modGestion });

  // ── Módulo Cuentas por cobrar (deudas) — public/cuentas-por-cobrar.html ──
  //    (portalPool: lee el saldo a favor y guarda los recordatorios de cobranza)
  require('./modulos/cuentas-cobrar')({ app, authAdmin, mCxc, prodPool, portalPool });

  // ── Módulo Créditos (saldo a favor del cliente y de la empresa) — public/creditos.html ──
  require('./modulos/creditos')({ app, authAdmin, mSaldo, prodPool, portalPool });

  // ── Módulo Conciliación de pagos online (módulo aislado: conciliacion) ──
  require('./modulos/conciliacion')({ app, authAdmin, mConc, prodPool, VV });

  // ── Módulo Accesos (gestión de usuarios) ──
  require('./modulos/accesos')({
    app, authAdmin, requiereModulo, soloMaestro,
    prodPool, portalPool, JWT_SECRET, MODULOS_ADMIN, leerAdminsSecundarios
  });

  // ── Módulo Contabilidad (kardex + reporte de pagos + comprobantes SUNAT vs sistema) ──
  require('./modulos/contabilidad')({ app, authAdmin, requiereModulo, prodPool, portalPool, VV });

  // ── Módulo Facturación electrónica (emitir facturas/boletas/NC vía NubeFacT) ──
  //    Variables: NUBEFACT_RUTA_<empresa>, NUBEFACT_TOKEN_<empresa>, ERP_ESCRITURA_URL (opcional, cuenta portal_erp).
  require('./modulos/facturacion')({ app, authAdmin, requiereModulo, prodPool, portalPool, erpWritePool, grupos: modGestion });

  // ── Módulo Importaciones (costeo / landed cost) ──
  modImportacion = require('./modulos/importacion')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Recepción de mercadería (paso intermedio compra: almacén valida) ──
  modRecepciones = require('./modulos/recepciones')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Seguimiento (trackings de envíos + gestión de backorders) ──
  modSeguimiento = require('./modulos/seguimiento')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Cotizador rápido (vendedores: buscador + precio mínimo FIFO) ──
  const modCotizador = require('./modulos/cotizador')({ app, authAdmin, requiereModulo, prodPool });

  // Precio importado: calculadora de pedidos especiales a tiendas online (reemplaza la hoja de Google)
  require('./modulos/precio-importado')({ app, authAdmin, requiereModulo, prodPool, VV, catalogo: modCotizador.catalogo,
    buscarInternet: modCotizador._test && modCotizador._test.buscarInternet });

  // ── Módulo Asistencia (entrada/salida del personal) — public/asistencia.html ──
  modAsistencia = require('./modulos/asistencia')({ app, authAdmin, requiereModulo, prodPool, portalPool, leerAdminsSecundarios });

  // ── Módulo Bikes a pedido (bikes.kuranko.pe) — public/bikes.html (tienda) + public/bikes-admin.html (panel) ──
  modBikes = require('./modulos/bikes')({ app, authAdmin, requiereModulo, portalPool });

  // ── Módulo Sincronización web ──
  modSync = require('./modulos/sincronizacion')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── Módulo Auditoría de catálogo + chequeo de empresa en ventas ──
  modAuditoria = require('./modulos/auditoria')({ app, authAdmin, requiereModulo, prodPool, portalPool });

  // ── PAGOS Y CAJA: cierres de caja (fechas como parámetros, nunca pegadas en el SQL) ──
  app.get('/api/cierres-caja', authAdmin, mCaja, async (req, res) => {
    const { desde, hasta } = req.query;
    const conRango = /^\d{4}-\d{2}-\d{2}$/.test(desde || '') && /^\d{4}-\d{2}-\d{2}$/.test(hasta || '');
    const f = conRango ? 'WHERE closure_date BETWEEN ? AND ?' : 'WHERE closure_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    try {
      const [rows] = await prodPool.query(`
        SELECT id, closure_date, status, total_general, totals, notes
        FROM cash_closures ${f} ORDER BY closure_date DESC LIMIT 30`, conRango ? [desde, hasta] : []);
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
    if (modGestion && modGestion.prepararTablas) await modGestion.prepararTablas();
    if (modPortal && modPortal.prepararTablas) await modPortal.prepararTablas();
    if (modAuditoria && modAuditoria.prepararTablas) await modAuditoria.prepararTablas();
    if (modImportacion && modImportacion.prepararTablas) await modImportacion.prepararTablas();
    if (modRecepciones && modRecepciones.prepararTablas) await modRecepciones.prepararTablas();
    if (modSeguimiento && modSeguimiento.prepararTablas) await modSeguimiento.prepararTablas();
    if (modAsistencia && modAsistencia.prepararTablas) await modAsistencia.prepararTablas();
    if (modBikes && modBikes.prepararTablas) await modBikes.prepararTablas();
    console.log('Tablas del portal listas.');
  } catch (e) { console.error('No se pudieron preparar las tablas al arrancar:', e.message); }
});
