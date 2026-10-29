// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Promociones en el portal de clientes + links libres para vendedores
//  (las campañas y los precios viven en modulos/promociones-campanas.js)
//
//  Portal (cliente logueado, pestaña "Promociones" en public/index.html):
//    GET  /portal/promociones            → ofertas vigentes CON "precio taller oferta"
//    POST /portal/promociones/solicitud  → correo a ventas (+ copia a la tienda) y mensaje de WhatsApp
//  Link libre (sin login, public/oferta.html?t=TOKEN) para los vendedores de la tienda:
//    GET  /api/oferta/:token             → ofertas vigentes SIN "precio taller oferta" (solo PVP)
//    POST /api/oferta/:token/latido      → mantiene la sesión en línea (cada 25 s)
//  En vivo: portal (POST /portal/promociones/latido) y links cuentan cuántas personas están viendo
//    promociones a la vez (en memoria, sin base); se muestra a todos y, desglosado, en Portal y links.
//    POST /api/oferta/:token/salir       → libera la sesión al cerrar la página
//    POST /api/oferta/:token/solicitud   → igual que el portal, con el nombre del vendedor
//    Si hay más sesiones a la vez que el máximo de la tienda (3 por defecto), el link se BLOQUEA
//    y solo el maestro lo puede reactivar (o generar uno nuevo).
//  Admin (maestro o módulo 'inventario', pestaña "Portal y links" de public/promociones.html; horas de reserva solo maestro):
//    GET/POST /api/promo-links, PUT/DELETE /api/promo-links/:id, GET /api/promo-solicitudes
//
//  Reservas: cada solicitud RESERVA sus unidades del stock en oferta (nadie más las puede pedir).
//   La reserva se CONCRETA sola cuando en el ERP aparece una venta a alguno de los RUC/DNI de la
//   cuenta con ese SKU, hecha después de la solicitud (revisión cada 20 min en horario de atención:
//   lun–vie 10:30–20:30, sáb 9:30–16:00, hora Lima; fuera de ese horario no consulta el ERP). Si vence (48 h por
//   defecto, nunca después del fin de la campaña) sin venta, se libera. El maestro también puede
//   confirmarla o cancelarla a mano. Estados: pendiente → concretada | parcial | vencida | cancelada.
//  Tipo de cuenta (Gestión de clientes): tienda o mecánico. "precio taller oferta" usa el desc. a
//   tiendas de la marca; a los mecánicos, 5 puntos menos (el piso de la campaña no cambia).
//
//  Tablas (base del portal): promo_links, promo_solicitudes, promo_reservas
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const WHATSAPP = (process.env.PROMO_WHATSAPP || '51904286836').replace(/\D/g, '');
const MAX_DEF = Number(process.env.PROMO_LINK_MAX || 3);
const EN_LINEA_MS = 70e3;                    // una sesión sin latido por 70 s se da por cerrada
const DIF_MECANICO = Number(process.env.PROMO_DIF_MECANICO || 5);   // puntos menos de descuento que una tienda
const RESERVA_HORAS_DEF = Number(process.env.PROMO_RESERVA_HORAS || 48);
const REVISION_MIN = Number(process.env.PROMO_RESERVAS_MIN || 20);
// Horario de atención (hora Lima) en el que se buscan ventas para concretar reservas. 0 = domingo.
const HORARIO = { 1: ['10:30', '20:30'], 2: ['10:30', '20:30'], 3: ['10:30', '20:30'], 4: ['10:30', '20:30'], 5: ['10:30', '20:30'], 6: ['09:30', '16:00'] };
function enHorario(fecha = new Date()) {
  const l = new Date(fecha.getTime() - 5 * 3600e3);              // Lima = UTC−5 (sin horario de verano)
  const h = HORARIO[l.getUTCDay()]; if (!h) return false;
  const min = l.getUTCHours() * 60 + l.getUTCMinutes();
  const a = h.map(x => { const [hh, mm] = x.split(':').map(Number); return hh * 60 + mm; });
  return min >= a[0] && min <= a[1];
}
const r2 = n => Math.round(n * 100) / 100;

// Precio para la cuenta: PVP oferta × (1 − desc.) — tienda: desc. a tiendas; mecánico: 5 puntos menos.
// En liquidación (a costo) es el mismo PVP oferta para todos.
function tuPrecio(precio, liq, dt, tipo) {
  if (precio == null) return null;
  if (liq) return precio;
  const d = Math.max(0, (Number(dt) || 0) - (tipo === 'mecanico' ? DIF_MECANICO : 0));
  return r2(precio * (1 - d / 100));
}

// Empareja ventas del ERP con reservas pendientes (puro, se prueba).
//  reservas: [{id, vid, ids:[customer_id], creado_en, cantidad, vendidas}] (más antigua primero)
//  lineas:   [{id, vid, customer_id, cantidad, precio_unit, fecha, codigo}] ventas desde la reserva más antigua
//  usadas:   Set de ids de líneas ya asignadas a otra reserva
//  → [{id, nuevas:[{id, cantidad, precio_unit, codigo}], vendidas}]
function asignarVentas(reservas, lineas, usadas) {
  const out = [];
  const restante = new Map(lineas.map(l => [l.id, Number(l.cantidad) || 0]));
  usadas.forEach(id => restante.set(id, 0));
  reservas.forEach(r => {
    let falta = Number(r.cantidad) - (Number(r.vendidas) || 0); if (falta <= 0) return;
    const desde = new Date(r.creado_en).getTime() - 15 * 60e3;     // tolerancia: la venta se registra al toque
    const nuevas = [];
    lineas.filter(l => l.vid === r.vid && r.ids.map(Number).includes(Number(l.customer_id)) && new Date(l.fecha).getTime() >= desde)
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
      .forEach(l => {
        const q = Math.min(falta, restante.get(l.id) || 0); if (q <= 0) return;
        restante.set(l.id, (restante.get(l.id) || 0) - q); falta -= q;
        nuevas.push({ id: l.id, cantidad: q, precio_unit: Number(l.precio_unit), codigo: l.codigo });
      });
    if (nuevas.length) out.push({ id: r.id, nuevas, vendidas: Number(r.cantidad) - falta });
  });
  return out;
}
const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const S = n => n == null ? '—' : 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Sesiones en línea por link (en memoria): token → Map(sid → último latido)
function crearSesiones() {
  const m = new Map();
  const vivas = token => {
    const s = m.get(token); if (!s) return 0;
    const t = Date.now(); for (const [k, v] of s) if (t - v > EN_LINEA_MS) s.delete(k);
    return s.size;
  };
  return {
    vivas,
    // Registra/renueva una sesión. Devuelve { ok, enLinea, excede } (excede = esta sesión nueva pasa el máximo)
    latido(token, sid, max) {
      const n = vivas(token), s = m.get(token) || new Map();
      if (!s.has(sid) && n >= max) return { ok: false, enLinea: n, excede: true };
      s.set(sid, Date.now()); m.set(token, s);
      return { ok: true, enLinea: s.size, excede: false };
    },
    salir(token, sid) { const s = m.get(token); if (s) s.delete(sid); },
    limpiar(token) { m.delete(token); }
  };
}

// Quiénes están viendo promociones AHORA (portal + links), en memoria: sid → {origen, tienda, visto}.
// Cada página avisa cada 25 s; sin aviso por 70 s se da por cerrada. Guarda el máximo del día (hora Lima).
function crearEnVivo() {
  const m = new Map(); let max = { dia: '', n: 0, hora: null };
  const diaLima = t => new Date(t - 5 * 3600e3).toISOString().slice(0, 10);
  const limpiar = () => { const t = Date.now(); for (const [k, v] of m) if (t - v.visto > EN_LINEA_MS) m.delete(k); };
  return {
    ver(sid, origen, tienda) {
      if (!sid) return this.total();
      m.set(origen + ':' + sid, { origen, tienda, visto: Date.now() });
      return this.total();
    },
    salir(sid) { for (const k of [...m.keys()]) if (k.endsWith(':' + sid)) m.delete(k); },
    total() {
      limpiar(); const n = m.size, t = Date.now(), d = diaLima(t);
      if (max.dia !== d) max = { dia: d, n: 0, hora: null };
      if (n > max.n) max = { dia: d, n, hora: new Date(t).toISOString() };
      return n;
    },
    resumen() {
      const n = this.total(), porTienda = {};
      let portal = 0, link = 0;
      for (const v of m.values()) {
        if (v.origen === 'portal') portal++; else link++;
        const e = porTienda[v.tienda] = porTienda[v.tienda] || { portal: 0, link: 0 };
        e[v.origen === 'portal' ? 'portal' : 'link']++;
      }
      return { total: n, portal, link, por_tienda: porTienda, max_hoy: max.n, max_hora: max.hora };
    }
  };
}

// Arma el correo y el mensaje de WhatsApp de una solicitud (puro, se prueba)
//  items: [{sku, nombre, cantidad, precio, tu_precio}]; conTuPrecio: portal (true) o link (false)
function armarSolicitud({ tienda, ruc, vendedor, telefono, origen, items, conTuPrecio, fecha, numero, hasta, nota }) {
  const total = items.reduce((a, i) => a + i.cantidad * (conTuPrecio ? i.tu_precio : i.precio), 0);
  const quien = origen === 'link' ? `Vendedor: ${vendedor}${telefono ? ' · ' + telefono : ''} (link de la tienda)` : 'Desde el portal de la tienda';
  const filas = items.map((i, k) => `<tr>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${k + 1}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;font-family:monospace">${esc(i.sku)}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0">${esc(i.nombre)}${i.liquidacion ? ' <b style="color:#b45309">(liquidación)</b>' : ''}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${i.cantidad}</td>
      <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${S(i.precio)}</td>
      ${conTuPrecio ? `<td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right"><b>${S(i.tu_precio)}</b></td>` : ''}
    </tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:720px">
    <h2 style="color:#000726;margin-bottom:4px">Solicitud de promoción${numero ? ' N° ' + numero : ''}</h2>
    <p style="margin:6px 0"><b>${esc(tienda)}</b>${ruc ? ' · RUC ' + esc(ruc) : ''}<br>${esc(quien)}<br><span style="color:#666">${esc(fecha)}</span></p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:10px">
      <thead><tr style="background:#000726;color:#fff">
        <th style="padding:6px 10px">N°</th><th style="padding:6px 10px;text-align:left">SKU</th><th style="padding:6px 10px;text-align:left">Producto</th>
        <th style="padding:6px 10px">Cant.</th><th style="padding:6px 10px;text-align:right">PVP oferta</th>${conTuPrecio ? '<th style="padding:6px 10px;text-align:right">Precio taller oferta</th>' : ''}
      </tr></thead><tbody>${filas}</tbody></table>
    <p style="margin-top:10px"><b>Total ${conTuPrecio ? 'a precio taller' : 'a PVP oferta'}: ${S(total)}</b></p>
    ${nota ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px">Nota: ${esc(nota)}</p>` : ''}
    ${hasta ? `<p style="background:#eef2ff;padding:8px 12px;border-radius:6px"><b>Unidades reservadas hasta el ${esc(hasta)}.</b> Para concretarla, registra la venta en el sistema a ${esc(ruc ? 'RUC ' + ruc : 'la cuenta de la tienda')} con estos SKU antes de esa fecha; si no, la reserva se libera.</p>` : ''}
    <p style="color:#666;font-size:12px">Los precios de promoción valen mientras dure el stock en oferta.</p></div>`;
  const lineas = items.map((i, k) => `${k + 1}. [${i.sku}] ${i.nombre} × ${i.cantidad} — ${S(conTuPrecio ? i.tu_precio : i.precio)}${i.liquidacion ? ' (liquidación)' : ''}`);
  const texto = `*Solicitud de promoción${numero ? ' N° ' + numero : ''}*\n${tienda}${ruc ? ' · RUC ' + ruc : ''}\n${quien}\n\n${lineas.join('\n')}\n\nTotal ${conTuPrecio ? 'precio taller' : 'PVP oferta'}: ${S(total)}${nota ? `\nNota: ${nota}` : ''}${hasta ? `\nReservado hasta: ${hasta}` : ''}`;
  return { html, texto, total: Math.round(total * 100) / 100, whatsapp: `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}` };
}

module.exports = function registrarPromosPortal({ app, authAdmin, mInv, authCliente, prodPool, portalPool, ofertasVigentes, correoEmpresa, destinatariosReporte, grupos, VV }) {
  const sesiones = crearSesiones();
  const enVivo = crearEnVivo();
  const sidDe = req => { const x = String((req.body && req.body.sid) || req.query.sid || '').slice(0, 64); return /^[A-Za-z0-9_-]{8,64}$/.test(x) ? x : null; };
  const soloMaestro = (req, res, next) => (req.admin && req.admin.maestro) ? next() : res.status(403).json({ error: 'Solo el administrador maestro' });

  async function prepararTablas() {
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_links (
      id INT AUTO_INCREMENT PRIMARY KEY, portal_user_id INT NOT NULL, token VARCHAR(64) NOT NULL UNIQUE,
      max_sesiones INT NOT NULL DEFAULT ${MAX_DEF}, estado VARCHAR(12) NOT NULL DEFAULT 'activo',   -- activo|bloqueado|revocado
      bloqueado_en DATETIME NULL, motivo VARCHAR(200), creado_en DATETIME DEFAULT CURRENT_TIMESTAMP, ultimo_uso DATETIME NULL,
      INDEX (portal_user_id))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_solicitudes (
      id INT AUTO_INCREMENT PRIMARY KEY, origen VARCHAR(8), portal_user_id INT, link_id INT NULL, tienda VARCHAR(200),
      vendedor VARCHAR(120), telefono VARCHAR(40), items MEDIUMTEXT, total DECIMAL(12,2), correo_ok TINYINT DEFAULT 0,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX (creado_en))`);
    try { await portalPool.query('ALTER TABLE promo_solicitudes ADD COLUMN nota VARCHAR(1000) NULL'); } catch (e) { /* ya existe */ }
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_reservas (
      id INT AUTO_INCREMENT PRIMARY KEY, solicitud_id INT NOT NULL, portal_user_id INT, link_id INT NULL,
      ids_cliente VARCHAR(400), vid INT NOT NULL, sku VARCHAR(120), nombre VARCHAR(300),
      cantidad INT NOT NULL, precio DECIMAL(12,2), tu_precio DECIMAL(12,2),
      estado VARCHAR(12) NOT NULL DEFAULT 'pendiente',      -- pendiente|concretada|parcial|vencida|cancelada
      vendidas INT NOT NULL DEFAULT 0, lineas TEXT, precio_venta DECIMAL(12,2) NULL, ventas VARCHAR(300),
      vence_en DATETIME NOT NULL, creado_en DATETIME DEFAULT CURRENT_TIMESTAMP, cerrado_en DATETIME NULL, nota VARCHAR(300),
      INDEX (estado), INDEX (vid, estado), INDEX (solicitud_id), INDEX (portal_user_id))`);
    // Tipo de cuenta (tienda | mecanico): lo administra Gestión de clientes; aquí por si arranca antes
    await portalPool.query(`ALTER TABLE portal_users ADD COLUMN tipo_cuenta VARCHAR(10) NOT NULL DEFAULT 'tienda'`).catch(() => {});
    // Cada 20 min, solo en horario de atención (las vencidas dejan de reservar stock aunque no corra)
    const tic = () => { if (enHorario()) revisarReservas().catch(e => console.warn('[promos] reservas:', e.message)); };
    setInterval(tic, REVISION_MIN * 60e3);
    setTimeout(tic, 60e3);
  }

  // ── Límite de solicitudes (en memoria): 20 por hora por tienda/link ──
  const envios = new Map();
  const puedeEnviar = k => { const t = Date.now(), l = (envios.get(k) || []).filter(x => t - x < 3600e3); if (l.length >= 20) return false; l.push(t); envios.set(k, l); return true; };

  async function datosTienda(portalUserId) {
    let u;
    try { [[u]] = await portalPool.query(`SELECT id, username, nombre_cliente, customer_id, activo, tipo_cuenta FROM portal_users WHERE id=?`, [portalUserId]); }
    catch (e) { [[u]] = await portalPool.query(`SELECT id, username, nombre_cliente, customer_id, activo FROM portal_users WHERE id=?`, [portalUserId]); }
    if (!u) return null;
    let ids = u.customer_id != null ? [u.customer_id] : [], nombre = u.nombre_cliente, activo = !!u.activo;
    if (grupos && grupos.grupoDe) { try { const g = await grupos.grupoDe(u.id); if (g) { ids = g.ids.length ? g.ids : ids; nombre = g.nombre || nombre; activo = activo && g.activo !== false; } } catch (e) {} }
    return { id: u.id, ruc: u.username, nombre, ids, activo, tipo: u.tipo_cuenta === 'mecanico' ? 'mecanico' : 'tienda' };
  }

  async function horasReserva() {
    try { const [[r]] = await portalPool.query(`SELECT valor FROM promo_config WHERE clave='reserva_horas'`); const h = r && Number(r.valor); if (h > 0) return h; } catch (e) {}
    return RESERVA_HORAS_DEF;
  }
  // Unidades reservadas (pendientes) por SKU
  async function reservadas() {
    // (se compara la fecha en Node, igual que se guardó, para no depender de la zona horaria de la base)
    const [r] = await portalPool.query(`SELECT vid, cantidad, vendidas, vence_en FROM promo_reservas WHERE estado='pendiente'`);
    const ahora = Date.now(), m = {};
    r.forEach(x => { if (new Date(x.vence_en).getTime() > ahora) m[x.vid] = (m[x.vid] || 0) + Math.max(0, Number(x.cantidad) - Number(x.vendidas)); });
    return m;
  }
  // Ofertas para mostrar: descuenta lo reservado y calcula "tu precio" según el tipo de cuenta.
  //  tipo = null → link libre (sin precio de tienda)
  async function vista(tipo) {
    const [d, res] = await Promise.all([ofertasVigentes(), reservadas()]);
    const items = d.items.map(({ _dt, _fin, tu_precio, siguiente, ...x }) => {
      const stock = Math.max(0, x.stock_oferta - (res[x.vid] || 0));
      const o = { ...x, stock_oferta: stock, reservado: Math.min(x.stock_oferta, res[x.vid] || 0) };
      if (tipo) o.tu_precio = tuPrecio(x.precio, x.liquidacion, _dt, tipo);
      o.siguiente = !siguiente ? null : siguiente.sale ? { sale: true }
        : { precio: siguiente.precio, unidades: siguiente.unidades, liquidacion: siguiente.liquidacion, ...(tipo ? { tu_precio: tuPrecio(siguiente.precio, siguiente.liquidacion, _dt, tipo) } : {}) };
      return o;
    });
    return { items, generado: d.generado, fines: Object.fromEntries(d.items.map(x => [x.vid, x._fin])) };
  }

  // Una solicitud a la vez: validar stock disponible y reservar sin que otra se cruce
  let cola = Promise.resolve();
  const enCola = fn => { const p = cola.then(fn, fn); cola = p.catch(() => {}); return p; };

  async function reservar({ tienda, origen, vendedor, telefono, pedido, linkId }) {
    return enCola(async () => {
      const v = await vista(tienda.tipo);
      const por = new Map(v.items.map(i => [i.vid, i]));
      const ok = [], errores = [];
      (Array.isArray(pedido) ? pedido : []).forEach(p => {
        const o = por.get(Number(p.vid)), q = Math.floor(Number(p.cantidad));
        if (!(q > 0)) return;
        if (!o) { errores.push(`El SKU ${p.sku || p.vid} ya no está en oferta`); return; }
        if (q > o.stock_oferta) { errores.push(o.stock_oferta ? `${o.sku}: solo quedan ${o.stock_oferta} und disponibles en oferta` : `${o.sku}: el stock en oferta ya está reservado`); return; }
        ok.push({ vid: o.vid, sku: o.sku, nombre: o.nombre, cantidad: q, precio: o.precio, tu_precio: o.tu_precio, liquidacion: o.liquidacion });
      });
      if (errores.length) { const e = new Error(errores.join(' · ')); e.status = 409; throw e; }
      if (!ok.length) { const e = new Error('Elige al menos un producto'); e.status = 400; throw e; }
      const total = ok.reduce((a, i) => a + i.cantidad * (origen === 'portal' ? i.tu_precio : i.precio), 0);
      const [r] = await portalPool.query(`INSERT INTO promo_solicitudes (origen, portal_user_id, link_id, tienda, vendedor, telefono, items, total)
        VALUES (?,?,?,?,?,?,?,?)`, [origen, tienda.id, linkId || null, String(tienda.nombre || '').slice(0, 200), vendedor ? String(vendedor).slice(0, 120) : null,
        telefono ? String(telefono).slice(0, 40) : null, JSON.stringify(ok), r2(total)]);
      const horas = await horasReserva();
      const tope = Date.now() + horas * 3600e3;
      const venceDe = vid => new Date(Math.min(tope, v.fines[vid] ? new Date(v.fines[vid]).getTime() : tope));
      await portalPool.query(`INSERT INTO promo_reservas (solicitud_id, portal_user_id, link_id, ids_cliente, vid, sku, nombre, cantidad, precio, tu_precio, vence_en) VALUES ?`,
        [ok.map(i => [r.insertId, tienda.id, linkId || null, JSON.stringify(tienda.ids || []), i.vid, i.sku, String(i.nombre).slice(0, 300), i.cantidad, i.precio, i.tu_precio, venceDe(i.vid)])]);
      const hasta = new Date(Math.min(...ok.map(i => venceDe(i.vid).getTime())));
      return { numero: r.insertId, items: ok, hasta };
    });
  }

  async function enviarSolicitud({ tienda, origen, vendedor, telefono, pedido, linkId, nota }) {
    nota = String(nota || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const rv = await reservar({ tienda, origen, vendedor, telefono, pedido, linkId });
    if (nota) portalPool.query('UPDATE promo_solicitudes SET nota=? WHERE id=?', [nota, rv.numero]).catch(() => {});
    const conTuPrecio = origen === 'portal';
    const fecha = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
    const hasta = rv.hasta.toLocaleString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const s = armarSolicitud({ tienda: tienda.nombre, ruc: tienda.ruc, vendedor, telefono, origen, items: rv.items, conTuPrecio, fecha, numero: rv.numero, hasta, nota });
    let correoOk = false;
    if (process.env.RESEND_API_KEY) {
      try {
        const email = correoEmpresa ? await correoEmpresa(tienda.ids) : null;
        const { to, cc } = destinatariosReporte ? destinatariosReporte(email) : { to: [process.env.VENTAS_EMAIL || 'ventas@kuranko.pe'], cc: [] };
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>', to, cc, reply_to: 'ventas@kuranko.pe',
            subject: `Solicitud de promoción N° ${rv.numero} — ${tienda.nombre}${origen === 'link' ? ' (' + vendedor + ')' : ''}`, html: s.html, text: s.texto.replace(/\*/g, '') })
        });
        if (!r.ok) console.error('[promos] Resend falló:', r.status, await r.text());
        correoOk = r.ok;
      } catch (e) { console.error('[promos] correo:', e.message); }
      if (correoOk) portalPool.query(`UPDATE promo_solicitudes SET correo_ok=1 WHERE id=?`, [rv.numero]).catch(() => {});
    }
    return { ok: true, numero: rv.numero, reservado_hasta: rv.hasta, correo_enviado: correoOk, whatsapp: s.whatsapp, total: s.total };
  }

  // ── Revisión de reservas: concreta con ventas del ERP, vence las viejas, cancela si terminó la oferta ──
  let revisando = false;
  async function revisarReservas() {
    if (revisando) return; revisando = true;
    try {
      const [pend] = await portalPool.query(`SELECT * FROM promo_reservas WHERE estado='pendiente' ORDER BY creado_en, id`);
      if (!pend.length) return;
      const reservas = pend.map(r => ({ ...r, ids: (() => { try { return JSON.parse(r.ids_cliente || '[]'); } catch (e) { return []; } })() }));
      const ids = [...new Set(reservas.flatMap(r => r.ids))], vids = [...new Set(reservas.map(r => r.vid))];
      const desde = new Date(Math.min(...reservas.map(r => new Date(r.creado_en).getTime())) - 15 * 60e3);
      let lineas = [];
      if (ids.length) {
        [lineas] = await prodPool.query(`SELECT si.id, si.product_variation_id AS vid, s.customer_id, si.quantity AS cantidad,
            si.total / NULLIF(si.quantity, 0) AS precio_unit, s.created_at AS fecha, s.code AS codigo
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.deleted_at IS NULL AND s.status IN ${VV} AND s.customer_id IN (?) AND si.product_variation_id IN (?) AND s.created_at >= ?`,
          [ids, vids, desde]);
      }
      // líneas de venta ya usadas por otras reservas (no se cuentan dos veces)
      const [usadasR] = await portalPool.query(`SELECT lineas FROM promo_reservas WHERE lineas IS NOT NULL AND creado_en >= DATE_SUB(NOW(), INTERVAL 120 DAY)`);
      const usadas = new Set(); usadasR.forEach(u => { try { JSON.parse(u.lineas).forEach(l => usadas.add(l.id)); } catch (e) {} });
      const asign = new Map(asignarVentas(reservas, lineas, usadas).map(a => [a.id, a]));
      const vig = new Set((await ofertasVigentes(true)).items.map(i => i.vid));
      const ahora = Date.now();
      for (const r of reservas) {
        const a = asign.get(r.id);
        let previas = []; try { previas = JSON.parse(r.lineas || '[]'); } catch (e) {}
        const todas = a ? previas.concat(a.nuevas) : previas;
        const vendidas = a ? a.vendidas : Number(r.vendidas) || 0;
        const und = todas.reduce((s, l) => s + l.cantidad, 0);
        const pv = und ? r2(todas.reduce((s, l) => s + l.cantidad * l.precio_unit, 0) / und) : null;
        const codigos = [...new Set(todas.map(l => l.codigo).filter(Boolean))].join(', ').slice(0, 300) || null;
        let estado = 'pendiente', nota = r.nota;
        if (vendidas >= r.cantidad) estado = 'concretada';
        else if (new Date(r.vence_en).getTime() <= ahora) { estado = vendidas > 0 ? 'parcial' : 'vencida'; nota = vendidas > 0 ? `Se vendieron ${vendidas} de ${r.cantidad}` : 'Venció sin venta registrada'; }
        else if (!vig.has(r.vid)) { estado = vendidas > 0 ? 'parcial' : 'cancelada'; nota = 'La oferta terminó'; }
        if (pv != null && r.tu_precio != null && Math.abs(pv - Number(r.tu_precio)) > 0.5 && Math.abs(pv - Number(r.precio)) > 0.5)
          nota = `Vendido a ${S(pv)} (oferta: ${S(r.tu_precio)} tienda / ${S(r.precio)} PVP)`;
        if (!a && estado === 'pendiente') continue;
        await portalPool.query(`UPDATE promo_reservas SET estado=?, vendidas=?, lineas=?, precio_venta=?, ventas=?, nota=?,
            cerrado_en = IF(? <> 'pendiente', NOW(), NULL) WHERE id=? AND estado='pendiente'`,
          [estado, vendidas, todas.length ? JSON.stringify(todas) : null, pv, codigos, nota, estado, r.id]);
      }
    } finally { revisando = false; }
  }

  // Reservas de una cuenta (para que la tienda vea si su solicitud se concretó)
  async function misSolicitudes(where, args) {
    const [r] = await portalPool.query(`SELECT r.solicitud_id, r.sku, r.nombre, r.cantidad, r.vendidas, r.estado, r.vence_en, r.creado_en, r.ventas,
        s.vendedor, s.origen FROM promo_reservas r JOIN promo_solicitudes s ON s.id = r.solicitud_id
      WHERE ${where} AND r.creado_en >= DATE_SUB(NOW(), INTERVAL 60 DAY) ORDER BY r.solicitud_id DESC, r.id`, args);
    const m = new Map();
    r.forEach(x => {
      const g = m.get(x.solicitud_id) || { numero: x.solicitud_id, fecha: x.creado_en, vendedor: x.vendedor, origen: x.origen, items: [] };
      g.items.push({ sku: x.sku, nombre: x.nombre, cantidad: x.cantidad, vendidas: x.vendidas, estado: x.estado, vence_en: x.vence_en, ventas: x.ventas });
      m.set(x.solicitud_id, g);
    });
    return [...m.values()].slice(0, 30);
  }

  // ─────────── Portal (cliente logueado) ───────────
  async function tiendaDeReq(req) {
    const pid = req.cliente.portal_user_id;
    return (await datosTienda(pid)) || { id: pid, nombre: req.cliente.nombre, ruc: req.cliente.ruc, ids: req.cliente.ids, tipo: 'tienda', activo: true };
  }
  const fallo = (res, e, txt) => { if (e.status) return res.status(e.status).json({ error: e.message }); console.error('[promos]', txt, e.message); res.status(500).json({ error: txt }); };
  app.get('/portal/promociones', authCliente, async (req, res) => {
    try {
      const t = await tiendaDeReq(req), v = await vista(t.tipo);
      res.json({ items: v.items, generado: v.generado, whatsapp: WHATSAPP, modo: 'portal', tipo_cuenta: t.tipo,
        viendo: enVivo.ver(sidDe(req), 'portal', t.id) });
    } catch (e) { fallo(res, e, 'No se pudieron cargar las promociones'); }
  });
  // Latido del portal (pestaña Promociones abierta): mantiene el conteo en vivo
  app.post('/portal/promociones/latido', authCliente, (req, res) => {
    res.json({ viendo: enVivo.ver(sidDe(req), 'portal', req.cliente.portal_user_id) });
  });
  // Al cerrar la página (sendBeacon no manda el token: basta el id de sesión, que es aleatorio)
  app.post('/portal/promociones/salir', (req, res) => { const sid = sidDe(req); if (sid) enVivo.salir(sid); res.json({ ok: true }); });
  app.get('/portal/promociones/mis-solicitudes', authCliente, async (req, res) => {
    try { res.json({ solicitudes: await misSolicitudes('r.portal_user_id = ?', [req.cliente.portal_user_id]) }); }
    catch (e) { fallo(res, e, 'No se pudieron cargar tus solicitudes'); }
  });
  app.post('/portal/promociones/solicitud', authCliente, async (req, res) => {
    try {
      const pid = req.cliente.portal_user_id;
      if (!puedeEnviar('u' + pid)) return res.status(429).json({ error: 'Demasiadas solicitudes seguidas. Escríbenos por WhatsApp.' });
      res.json(await enviarSolicitud({ tienda: await tiendaDeReq(req), origen: 'portal', pedido: req.body && req.body.items, nota: req.body && req.body.nota }));
    } catch (e) { fallo(res, e, 'No se pudo enviar la solicitud'); }
  });

  // ─────────── Link libre (vendedores, sin login) ───────────
  async function linkDe(token) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
    const [[l]] = await portalPool.query(`SELECT * FROM promo_links WHERE token=?`, [token]);
    return l || null;
  }
  async function bloquear(l, motivo) {
    await portalPool.query(`UPDATE promo_links SET estado='bloqueado', bloqueado_en=NOW(), motivo=? WHERE id=?`, [motivo, l.id]);
    sesiones.limpiar(l.token);
    console.warn(`[promos] link ${l.id} bloqueado: ${motivo}`);
  }
  const MSG_BLOQ = 'Este link está bloqueado porque se abrió en demasiados equipos a la vez. Pide a la tienda que solicite uno nuevo.';
  // Comprueba el link y registra la sesión; responde el error si corresponde. Devuelve { l, tienda } o null.
  async function entrar(req, res) {
    const l = await linkDe(req.params.token);
    if (!l || l.estado === 'revocado') { res.status(404).json({ error: 'Este link no existe o ya no está activo. Pide uno nuevo a la tienda.' }); return null; }
    if (l.estado === 'bloqueado') { res.status(423).json({ error: MSG_BLOQ, bloqueado: true }); return null; }
    const tienda = await datosTienda(l.portal_user_id);
    if (!tienda || !tienda.activo) { res.status(404).json({ error: 'Este link ya no está activo.' }); return null; }
    const sid = String((req.body && req.body.sid) || req.query.sid || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) { res.status(400).json({ error: 'Sesión inválida, recarga la página' }); return null; }
    const r = sesiones.latido(l.token, sid, Number(l.max_sesiones) || MAX_DEF);
    if (r.excede) {
      await bloquear(l, `Se intentó abrir en ${r.enLinea + 1} equipos a la vez (máximo ${l.max_sesiones})`);
      res.status(423).json({ error: MSG_BLOQ, bloqueado: true });
      return null;
    }
    portalPool.query(`UPDATE promo_links SET ultimo_uso=NOW() WHERE id=?`, [l.id]).catch(() => {});
    return { l, tienda, enLinea: r.enLinea };
  }
  app.get('/api/oferta/:token', async (req, res) => {
    try {
      const e = await entrar(req, res); if (!e) return;
      const v = await vista(null);
      res.json({ items: v.items, generado: v.generado, tienda: e.tienda.nombre, whatsapp: WHATSAPP, modo: 'link', en_linea: e.enLinea, max: e.l.max_sesiones,
        viendo: enVivo.ver(sidDe(req), 'link', e.tienda.id) });
    } catch (err) { fallo(res, err, 'No se pudieron cargar las promociones'); }
  });
  app.get('/api/oferta/:token/mis-solicitudes', async (req, res) => {
    try { const e = await entrar(req, res); if (!e) return; res.json({ solicitudes: await misSolicitudes('r.link_id = ?', [e.l.id]) }); }
    catch (err) { fallo(res, err, 'No se pudieron cargar las solicitudes'); }
  });
  app.post('/api/oferta/:token/latido', async (req, res) => {
    try { const e = await entrar(req, res); if (e) res.json({ ok: true, en_linea: e.enLinea, viendo: enVivo.ver(sidDe(req), 'link', e.tienda.id) }); }
    catch (err) { res.status(500).json({ error: 'Error' }); }
  });
  app.post('/api/oferta/:token/salir', async (req, res) => {
    try { const l = await linkDe(req.params.token); const sid = String((req.body && req.body.sid) || req.query.sid || ''); if (l) sesiones.salir(l.token, sid); if (sid) enVivo.salir(sid); } catch (e) {}
    res.json({ ok: true });
  });
  app.post('/api/oferta/:token/solicitud', async (req, res) => {
    try {
      const e = await entrar(req, res); if (!e) return;
      const vendedor = String((req.body && req.body.vendedor) || '').trim(), tel = String((req.body && req.body.telefono) || '').trim();
      if (vendedor.length < 2) return res.status(400).json({ error: 'Escribe tu nombre' });
      if (!puedeEnviar('l' + e.l.id)) return res.status(429).json({ error: 'Demasiadas solicitudes seguidas. Escríbenos por WhatsApp.' });
      res.json(await enviarSolicitud({ tienda: e.tienda, origen: 'link', vendedor, telefono: tel, pedido: req.body.items, linkId: e.l.id, nota: req.body.nota }));
    } catch (err) { fallo(res, err, 'No se pudo enviar la solicitud'); }
  });

  // ─────────── Admin (maestro) ───────────
  const mw = [authAdmin, mInv || soloMaestro];                 // maestro o módulo 'inventario' (links, reservas)
  const soloM = [authAdmin, soloMaestro];
  app.get('/api/promo-links', ...mw, async (req, res) => {
    try {
      const [us] = await portalPool.query(`SELECT u.id, u.username, u.nombre_cliente, u.activo, u.tipo_cuenta,
          l.id AS link_id, l.token, l.max_sesiones, l.estado, l.bloqueado_en, l.motivo, l.ultimo_uso, l.creado_en
        FROM portal_users u LEFT JOIN promo_links l ON l.portal_user_id = u.id AND l.estado <> 'revocado'
        ORDER BY u.activo DESC, u.nombre_cliente`);
      const vivo = enVivo.resumen();
      res.json({ tiendas: us.map(u => ({ ...u, en_linea: u.token ? sesiones.vivas(u.token) : 0, viendo: vivo.por_tienda[u.id] || { portal: 0, link: 0 } })),
        max_def: MAX_DEF, en_vivo: { total: vivo.total, portal: vivo.portal, link: vivo.link, max_hoy: vivo.max_hoy, max_hora: vivo.max_hora } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Crear (o regenerar) el link de una tienda: el anterior deja de funcionar
  app.post('/api/promo-links', ...mw, async (req, res) => {
    try {
      const uid = Number(req.body && req.body.portal_user_id);
      const [[u]] = await portalPool.query(`SELECT id FROM portal_users WHERE id=?`, [uid]);
      if (!u) return res.status(404).json({ error: 'Tienda no encontrada' });
      const [[prev]] = await portalPool.query(`SELECT * FROM promo_links WHERE portal_user_id=? AND estado<>'revocado'`, [uid]);
      const max = Math.min(50, Math.max(1, Number(req.body.max_sesiones) || (prev && prev.max_sesiones) || MAX_DEF));
      if (prev) { await portalPool.query(`UPDATE promo_links SET estado='revocado', motivo='Regenerado' WHERE id=?`, [prev.id]); sesiones.limpiar(prev.token); }
      const token = crypto.randomBytes(18).toString('base64url');
      await portalPool.query(`INSERT INTO promo_links (portal_user_id, token, max_sesiones) VALUES (?,?,?)`, [uid, token, max]);
      res.json({ ok: true, token });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/promo-links/:id', ...mw, async (req, res) => {
    try {
      const [[l]] = await portalPool.query(`SELECT * FROM promo_links WHERE id=? AND estado<>'revocado'`, [Number(req.params.id)]);
      if (!l) return res.status(404).json({ error: 'Link no encontrado' });
      const b = req.body || {};
      if (b.max_sesiones != null) await portalPool.query(`UPDATE promo_links SET max_sesiones=? WHERE id=?`, [Math.min(50, Math.max(1, Number(b.max_sesiones) || MAX_DEF)), l.id]);
      if (b.estado === 'activo') { sesiones.limpiar(l.token); await portalPool.query(`UPDATE promo_links SET estado='activo', bloqueado_en=NULL, motivo=NULL WHERE id=?`, [l.id]); }
      if (b.estado === 'bloqueado') await bloquear(l, 'Bloqueado a mano');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/promo-links/:id', ...mw, async (req, res) => {
    try {
      const [[l]] = await portalPool.query(`SELECT * FROM promo_links WHERE id=?`, [Number(req.params.id)]);
      if (l) { await portalPool.query(`UPDATE promo_links SET estado='revocado', motivo='Eliminado' WHERE id=?`, [l.id]); sesiones.limpiar(l.token); }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Reservas (pendientes primero) + configuración de horas
  app.get('/api/promo-reservas', ...mw, async (req, res) => {
    try {
      const est = ['pendiente', 'concretada', 'parcial', 'vencida', 'cancelada'].includes(req.query.estado) ? req.query.estado : null;
      const [r] = await portalPool.query(`SELECT r.*, s.tienda, s.vendedor, s.origen FROM promo_reservas r JOIN promo_solicitudes s ON s.id = r.solicitud_id
        ${est ? 'WHERE r.estado = ?' : ''} ORDER BY FIELD(r.estado,'pendiente','parcial','concretada','vencida','cancelada'), r.id DESC LIMIT 300`, est ? [est] : []);
      res.json({ reservas: r.map(({ lineas, ids_cliente, ...x }) => x), horas: await horasReserva() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/promo-reservas/:id/:accion', ...mw, async (req, res) => {
    try {
      const acc = req.params.accion;
      if (!['confirmar', 'cancelar'].includes(acc)) return res.status(400).json({ error: 'Acción no válida' });
      const est = acc === 'confirmar' ? 'concretada' : 'cancelada';
      const [r] = await portalPool.query(`UPDATE promo_reservas SET estado=?, cerrado_en=NOW(), nota=? WHERE id=? AND estado='pendiente'`,
        [est, `${acc === 'confirmar' ? 'Confirmada' : 'Cancelada'} a mano por ${(req.admin && req.admin.usuario) || 'el maestro'}`, Number(req.params.id)]);
      if (!r.affectedRows) return res.status(409).json({ error: 'La reserva ya no está pendiente' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/promo-reservas-revisar', ...mw, async (req, res) => {
    try { await revisarReservas(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/promo-reserva-config', ...soloM, async (req, res) => {
    try {
      const h = Math.round(Number(req.body && req.body.horas));
      if (!(h >= 1 && h <= 720)) return res.status(400).json({ error: 'Horas entre 1 y 720' });
      await portalPool.query(`INSERT INTO promo_config (clave, valor) VALUES ('reserva_horas', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [String(h)]);
      res.json({ ok: true, horas: h });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/promo-solicitudes', ...mw, async (req, res) => {
    try {
      const [r] = await portalPool.query(`SELECT * FROM promo_solicitudes ORDER BY id DESC LIMIT 200`);
      res.json({ solicitudes: r.map(x => ({ ...x, items: (() => { try { return JSON.parse(x.items); } catch (e) { return []; } })() })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Ofertas vigentes con el "precio taller oferta" de una tienda (lo usa el Catálogo B2B para
  // marcar productos en promoción). Solo las que tienen stock en oferta libre (sin reservar).
  async function ofertasParaTienda(portalUserId) {
    const t = await datosTienda(portalUserId);
    if (!t || !t.activo) return new Map();
    const v = await vista(t.tipo);
    return new Map(v.items.filter(x => x.stock_oferta > 0).map(x => [Number(x.vid), { tu_precio: x.tu_precio, precio: x.precio, stock_oferta: x.stock_oferta, liquidacion: !!x.liquidacion }]));
  }

  return { prepararTablas, revisarReservas, ofertasParaTienda };
};

module.exports._test = { crearSesiones, crearEnVivo, armarSolicitud, tuPrecio, asignarVentas, enHorario };
